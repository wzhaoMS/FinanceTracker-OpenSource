import type { Server } from 'node:net';
import { hostname } from 'node:os';
import type { Database as DB } from 'better-sqlite3';

import type { SqliteStateRepo } from './sqliteStateRepo.js';
import type { Account, Transaction } from '@finance-tracker/shared';
import { aggregatePositions, heldSymbolsAcrossAccounts, parseOccSymbol, positionMarketValue } from '@finance-tracker/shared';
import { getQuotes } from '../providers/quoteProvider.js';
import { resolveQuotes } from './quoteResolver.js';
import { errorTypeAndCode } from './dbErrors.js';
import { marketDate } from './symbolHistory.js';

/**
 * Phase B.1 — portfolio snapshot infrastructure.
 *
 * What:   Every N seconds (when SNAPSHOTS_ENABLED=1), capture each account's
 *         market value + cost basis + cash, plus a single intraday bar per
 *         held symbol. Both go into SQLite so 1D charts have data points.
 *
 * Single-writer: a `snapshot_lease` row guards against multiple schedulers
 *         (e.g. tsx-watch hot reloads, two API processes on the same host).
 *         A starting writer can take a stale lease. The API holds it as the
 *         endpoint it listens on (`listenerLeaseHolder`), so a restarted API
 *         takes up a lease its old process never released at its first tick.
 *         A tick writes only inside one transaction with the check that the
 *         lease is still the one it took, so a tick that waited out its lease
 *         never writes beside the next holder.
 *
 * Idempotent: account_snapshots has UNIQUE(account_id, taken_at) and
 *         symbol_price_bars has the (symbol, range_kind, t, source) PK,
 *         so retries with the same `taken_at` no-op.
 *
 * Quote economy: collects all in-scope symbols once per tick, calls
 *         getQuotes() exactly once, then values all accounts from that
 *         single payload.
 */

export interface SnapshotConfig {
  /** Interval between ticks in ms. Defaults to 5 minutes. */
  intervalMs?: number;
  /** How long the lease is good for. Defaults to interval * 2 + 60s. */
  leaseTtlMs?: number;
  /** Delay before the first tick. Defaults to 30s so a crash loop can't pile rows. */
  startDelayMs?: number;
  /** Optional clock injection for tests. */
  now?: () => Date;
  /**
   * Predicate that decides whether a given clock instant should produce a
   * snapshot. Defaults to `isWithinSnapshotWindow` (US weekdays, 04:00–20:00
   * America/New_York — covers pre-market through after-hours, matching
   * Robinhood's "1D"). Override in tests or to force always-on.
   */
  shouldRun?: (now: Date) => boolean;
  /**
   * The lease holder identity. The API passes `listenerLeaseHolder()` of the
   * server it listens on, which stays the same across restarts. Without it,
   * the holder is `${pid}@${hostname}`, unique to this process. Tests pass a
   * unique value per job so two in-process jobs don't accidentally share a lease.
   */
  holder?: string;
}

/** Why a tick produced no rows. Useful for log lines and test assertions. */
export type SkipReason =
  | 'market-closed' | 'in-flight' | 'lease-held' | 'no-accounts' | 'missing-quotes' | 'stopped' | 'lease-lost';

export interface TickResult {
  /** True iff the tick held the lease and executed the value-and-write phase. */
  acquired: boolean;
  snapshotsWritten: number;
  barsWritten: number;
  /** Present when nothing was written; identifies why. */
  skipReason?: SkipReason;
  /** Accounts left out of this tick, each holding something without a live quote. */
  skippedAccounts?: number;
  /** The held symbols behind them (missing, or only a persisted fallback), and how many are options or crypto. */
  unquoted?: { total: number; options: number; crypto: number };
  /** Option positions past their expiry date, held at their last observed mark until their closing record arrives. */
  expiredOptions?: number;
}

export interface SnapshotJob {
  /** Run a single tick, regardless of timer state. */
  runOnce(): Promise<TickResult>;
  /** Stop for good: release the lease once, and write nothing more, not even from a tick already in flight. */
  stop(): void;
}

/**
 * The snapshot lease holder of an API process: the TCP endpoint it listens on, on this host,
 * e.g. `api:127.0.0.1:4000@<host>`. It has no process id, so an API restarted on the same
 * endpoint is the same holder, and its first tick takes up the lease even when the old
 * process's release never landed. Two live processes never share it: only one can listen
 * on an address and port, the API starts its scheduler only once it listens and stops it
 * before it closes its listeners, and an API on another endpoint is another holder that
 * contends for the lease. A server that is not listening, such as a duplicate start whose
 * bind failed, gets no holder.
 */
export function listenerLeaseHolder(server: Server, host: string = hostname()): string {
  const address = server.address();
  if (!server.listening || address === null || typeof address === 'string') {
    throw new Error('a snapshot lease holder needs a listening TCP server');
  }
  const ip = address.address.includes(':') ? `[${address.address}]` : address.address;
  return `api:${ip}:${address.port}@${host}`;
}

/**
 * Default snapshot window: US Eastern weekdays 04:00–19:59 inclusive.
 * Covers pre-market (04:00 ET), regular hours (09:30–16:00 ET) and
 * after-hours (16:00–20:00 ET). DST-aware via `Intl.DateTimeFormat`.
 */
export function isWithinSnapshotWindow(d: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  const hourStr = parts.find((p) => p.type === 'hour')?.value ?? '0';
  // `hour: '2-digit'` with `hour12: false` returns '00'..'23' on V8, but
  // some ICU builds emit '24' for midnight; normalise.
  const hour = parseInt(hourStr, 10) % 24;
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return hour >= 4 && hour < 20;
}

interface SnapshotRow {
  id: string;
  accountId: string;
  takenAt: string;
  marketValue: number;
  costBasis: number;
  cashBalance: number;
}

type IntradayBarRow = { symbol: string; t: string; close: number; source: string };

/**
 * Round a Date to the nearest 5-minute mark in UTC and emit ISO 8601.
 * That keeps `taken_at` values aligned across accounts in the same tick
 * and makes chart binning cleaner.
 */
function roundToInterval(d: Date, intervalMs: number): string {
  const rounded = Math.round(d.getTime() / intervalMs) * intervalMs;
  return new Date(rounded).toISOString();
}

export interface SnapshotRepo {
  /**
   * Try to acquire the singleton snapshot lease.
   * Returns true on success; false if another writer holds a non-stale lease.
   * A lease held as `<pid>@<this host>` (how the API held it before
   * `listenerLeaseHolder`) by a process that has exited counts as stale.
   */
  acquireLease(holder: string, ttlMs: number, now: Date): boolean;
  /**
   * Whether `holder` still holds the lease it acquired at `acquiredAt`, and
   * the lease runs more than `marginMs` past `now`. A tick reads this in the
   * same IMMEDIATE transaction as its writes.
   */
  holdsLease(holder: string, acquiredAt: Date, now: Date, marginMs: number): boolean;
  releaseLease(holder: string): void;

  insertAccountSnapshots(rows: SnapshotRow[]): { inserted: number };
  insertIntradayBars(bars: IntradayBarRow[]): { inserted: number };
}

/** Whether a process with this id exists on this host. Signal 0 checks without signalling; EPERM means it exists. */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function createSnapshotRepo(
  state: SqliteStateRepo,
  options: { processExists?: (pid: number) => boolean } = {},
): SnapshotRepo {
  const db: DB = state.internalGetDb();
  const exists = options.processExists ?? processExists;
  // A `<pid>@<host>` lease of a process on this host that has exited: no one
  // can still write under it. A process that may still run keeps its lease.
  const exitedProcessHolder = (holder: string): boolean => {
    const match = /^(\d+)@(.+)$/.exec(holder);
    if (!match || match[2] !== hostname()) return false;
    const pid = Number(match[1]);
    return Number.isSafeInteger(pid) && pid > 0 && !exists(pid);
  };
  const insertSnapshot = db.prepare(
    `INSERT OR IGNORE INTO account_snapshots
       (id, account_id, taken_at, market_value, cost_basis, cash_balance)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertBar = db.prepare(
    `INSERT OR IGNORE INTO symbol_price_bars
       (symbol, range_kind, t, close, source)
     VALUES (?, 'intraday', ?, ?, ?)`,
  );
  return {
    acquireLease(holder, ttlMs, now) {
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
      const acquiredAt = now.toISOString();
      // Try to insert (id=1 singleton). If a row exists, take it ONLY if it is
      // this holder's, has expired, or names an exited process on this host.
      // Both happen in one transaction.
      const tx = db.transaction(() => {
        const existing = db
          .prepare('SELECT holder, expires_at FROM snapshot_lease WHERE id = 1')
          .get() as { holder: string; expires_at: string } | undefined;
        if (!existing) {
          db.prepare(
            'INSERT INTO snapshot_lease (id, holder, acquired_at, expires_at) VALUES (1, ?, ?, ?)',
          ).run(holder, acquiredAt, expiresAt);
          return true;
        }
        if (existing.holder === holder || Date.parse(existing.expires_at) <= now.getTime()
          || exitedProcessHolder(existing.holder)) {
          db.prepare(
            'UPDATE snapshot_lease SET holder = ?, acquired_at = ?, expires_at = ? WHERE id = 1',
          ).run(holder, acquiredAt, expiresAt);
          return true;
        }
        return false;
      });
      return tx() as boolean;
    },
    holdsLease(holder, acquiredAt, now, marginMs) {
      const lease = db
        .prepare('SELECT holder, acquired_at, expires_at FROM snapshot_lease WHERE id = 1')
        .get() as { holder: string; acquired_at: string; expires_at: string } | undefined;
      return lease !== undefined && lease.holder === holder && lease.acquired_at === acquiredAt.toISOString()
        && Date.parse(lease.expires_at) > now.getTime() + marginMs;
    },
    releaseLease(holder) {
      db.prepare('DELETE FROM snapshot_lease WHERE id = 1 AND holder = ?').run(holder);
    },
    insertAccountSnapshots(rows) {
      const tx = db.transaction((batch: SnapshotRow[]) => {
        let inserted = 0;
        for (const r of batch) {
          const info = insertSnapshot.run(
            r.id, r.accountId, r.takenAt, r.marketValue, r.costBasis, r.cashBalance,
          );
          if (info.changes > 0) inserted++;
        }
        return inserted;
      });
      return { inserted: tx(rows) as number };
    },
    insertIntradayBars(bars) {
      const tx = db.transaction((batch: typeof bars) => {
        let inserted = 0;
        for (const b of batch) {
          const info = insertBar.run(b.symbol, b.t, b.close, b.source);
          if (info.changes > 0) inserted++;
        }
        return inserted;
      });
      return { inserted: tx(bars) as number };
    },
  };
}

/**
 * Snapshot scheduler. Reads accounts + transactions from SqliteStateRepo,
 * batches a single getQuotes() call, values each account, writes rows.
 *
 * The job is injectable: tests provide a fake `getQuotes` to avoid network.
 */
export interface SnapshotDeps {
  state: SqliteStateRepo;
  repo?: SnapshotRepo;
  /** Override quote provider for tests. */
  fetchQuotes?: typeof getQuotes;
}

export function createSnapshotJob(deps: SnapshotDeps, cfg: SnapshotConfig = {}): SnapshotJob {
  const interval = cfg.intervalMs ?? 5 * 60 * 1000;
  const leaseTtl = cfg.leaseTtlMs ?? interval * 2 + 60_000;
  const now = cfg.now ?? (() => new Date());
  const shouldRun = cfg.shouldRun ?? isWithinSnapshotWindow;
  const repo = deps.repo ?? createSnapshotRepo(deps.state);
  const fetcher = deps.fetchQuotes ?? getQuotes;
  // The API passes its listener's holder, the same after a restart, so the
  // restarted API re-acquires its own lease at once (the same-holder path takes
  // it without waiting for the TTL), even if the old process never released it.
  // Other callers get this process's own id. Tests pass cfg.holder per job so
  // multiple jobs in one process don't alias.
  const holder = cfg.holder ?? `${process.pid}@${hostname()}`;
  const db: DB = deps.state.internalGetDb();
  let inFlight = false;
  // Set by stop(). From then on the job writes nothing, so a successor holding
  // the same lease never writes alongside a tick that was still in flight here.
  let stopped = false;
  const stoppedResult = (): TickResult => ({ acquired: false, snapshotsWritten: 0, barsWritten: 0, skipReason: 'stopped' });
  // A tick writes only while the lease it took is still its own and runs more
  // than a minute (the interval, when shorter) past the moment it writes. The
  // check and the inserts are one IMMEDIATE transaction: once it begins, no
  // other process can take the lease until the rows are in. A tick whose quote
  // wait outlasted its lease writes nothing, even if no one took the lease; the
  // next tick acquires it as usual.
  const writeMarginMs = Math.min(60_000, interval);
  const writeHeld = db.transaction((acquiredAt: Date, rows: SnapshotRow[], bars: IntradayBarRow[]) => {
    if (!repo.holdsLease(holder, acquiredAt, now(), writeMarginMs)) return null;
    return {
      snapshotsWritten: repo.insertAccountSnapshots(rows).inserted,
      barsWritten: repo.insertIntradayBars(bars).inserted,
    };
  });

  async function tick(): Promise<TickResult> {
    if (stopped) return stoppedResult();
    if (inFlight) {
      return { acquired: false, snapshotsWritten: 0, barsWritten: 0, skipReason: 'in-flight' };
    }
    inFlight = true;
    try {
      const t = now();
      // Cheapest gate first: skip overnight/weekends entirely. Avoids
      // unnecessary provider load and storage during dead market hours.
      if (!shouldRun(t)) {
        return { acquired: false, snapshotsWritten: 0, barsWritten: 0, skipReason: 'market-closed' };
      }
      if (!repo.acquireLease(holder, leaseTtl, t)) {
        return { acquired: false, snapshotsWritten: 0, barsWritten: 0, skipReason: 'lease-held' };
      }
      const accounts = db
        .prepare('SELECT id, name, type, cash_balance, currency FROM accounts ORDER BY sort_order')
        .all() as Array<{ id: string; name: string; type: string | null; cash_balance: number; currency: string }>;
      if (accounts.length === 0) {
        return { acquired: true, snapshotsWritten: 0, barsWritten: 0, skipReason: 'no-accounts' };
      }

      const txs = db
        .prepare(
            `SELECT id, account_id, symbol, date, quantity, price_per_unit, fees, currency,
              instrument_type, contract_multiplier, position_effect, notes, source_fingerprint
             FROM transactions`,
        )
        .all() as Array<{
          id: string; account_id: string; symbol: string; date: string;
          quantity: number; price_per_unit: number; fees: number | null; currency: string;
          instrument_type: string | null; contract_multiplier: number | null; position_effect: string | null;
          notes: string | null; source_fingerprint: string | null;
        }>;

      const txObjs: Transaction[] = txs.map((x) => ({
        id: x.id, accountId: x.account_id, symbol: x.symbol, date: x.date,
        quantity: x.quantity, pricePerUnit: x.price_per_unit,
        ...(x.instrument_type === 'option'
          ? {
              instrumentType: 'option' as const,
              contractMultiplier: x.contract_multiplier ?? undefined,
              positionEffect: x.position_effect === 'open' || x.position_effect === 'close'
                ? x.position_effect
                : undefined,
            }
          : {}),
        fees: x.fees ?? undefined, currency: x.currency,
        // A position snapshot ("pos:" or a legacy "imported" row) gives way to the activity for the
        // same holding, as everywhere else that counts positions. Without these, the job counted both:
        // a holding the activity closed stayed held here, and its quote could stop every tick.
        ...(x.source_fingerprint ? { sourceFingerprint: x.source_fingerprint } : {}),
        ...(x.notes ? { notes: x.notes } : {}),
      }));
      const positionsByAccount = new Map(
        accounts.map((account) => [
          account.id,
          aggregatePositions(txObjs.filter((transaction) => transaction.accountId === account.id)),
        ]),
      );

      // One getQuotes() call for current positive positions only. Closed and
      // orphan-sell symbols must not degrade the quote set or snapshot value.
      // Snapshots value off `price` only, so skip the indicative overlay.
      // An option past its expiry date can no longer be quoted, so it is not
      // requested: until its closing record (expiry, exercise or assignment)
      // arrives, it keeps the last mark observed for it.
      const today = marketDate(t);
      const expired = (symbol: string) => (parseOccSymbol(symbol)?.expirationDate ?? today) < today;
      const held = heldSymbolsAcrossAccounts(txObjs);
      const symbols = held.filter((symbol) => !expired(symbol));
      const resolution = symbols.length === 0
        ? { quotes: [], fallbackSymbols: [], missingSymbols: [] }
        : await resolveQuotes(deps.state, symbols, { indicative: false }, fetcher, t);
      // The only wait in a tick: stopped meanwhile, it writes nothing. Everything below is synchronous.
      if (stopped) return stoppedResult();
      // Only a live quote is an observation. A stored mark (the resolver's
      // fallback) is fine for the live view, and so is a provider's quote from
      // before the latest session (a failover to an old close, or the last
      // known quote kept in memory), but recorded as a snapshot or a new bar
      // either would pass an old price off as observed now.
      const notLive = new Set([
        ...resolution.missingSymbols,
        ...resolution.fallbackSymbols,
        ...resolution.quotes.filter((quote) => quote.freshness === 'stale').map((quote) => quote.symbol),
      ]);
      const liveQuotes = resolution.quotes.filter((quote) => !notLive.has(quote.symbol));
      const priceBySymbol = new Map(liveQuotes.map((quote) => [quote.symbol, quote.price]));
      const lastMark = db.prepare(
        `SELECT close FROM symbol_price_bars
          WHERE symbol = ? AND range_kind = 'intraday' AND t <= ?
          ORDER BY t DESC, CASE source WHEN 'cboe' THEN 0 WHEN 'nasdaq' THEN 1 ELSE 2 END
          LIMIT 1`,
      ).pluck();
      for (const symbol of held.filter(expired)) {
        const mark = lastMark.get(symbol, t.toISOString());
        if (typeof mark === 'number' && Number.isFinite(mark) && mark >= 0) priceBySymbol.set(symbol, mark);
      }

      // Snapshot every account at the same `taken_at`. An account holding
      // anything without a price is left out of this tick, never valued
      // without it; the other accounts are still recorded.
      const takenAt = roundToInterval(t, interval);
      const accountObjs: Account[] = accounts.map((a) => ({
        id: a.id, name: a.name, type: a.type ?? undefined,
        cashBalance: a.cash_balance, currency: a.currency,
      }));

      const snapshots: SnapshotRow[] = [];
      const unpricedSymbols = new Set<string>();
      let skippedAccounts = 0;
      let expiredOptions = 0;
      for (const a of accountObjs) {
        const positions = positionsByAccount.get(a.id) ?? [];
        const unpriced = positions.filter((p) => !priceBySymbol.has(p.symbol));
        if (unpriced.length > 0) {
          skippedAccounts += 1;
          for (const p of unpriced) unpricedSymbols.add(p.symbol);
          continue;
        }
        let marketValue = a.cashBalance;
        let costBasis = a.cashBalance;
        for (const p of positions) {
          if (expired(p.symbol)) expiredOptions += 1;
          marketValue += positionMarketValue(p, { price: priceBySymbol.get(p.symbol)! });
          costBasis += p.costBasis;
        }
        snapshots.push({
          id: `snap-${a.id}-${takenAt}`,
          accountId: a.id, takenAt,
          marketValue, costBasis, cashBalance: a.cashBalance,
        });
      }
      const unpriced = [...unpricedSymbols];
      const unquoted = {
        total: unpriced.length,
        options: unpriced.filter((symbol) => parseOccSymbol(symbol) != null).length,
        crypto: unpriced.filter((symbol) => /^[A-Z]{2,6}-USD$/i.test(symbol)).length,
      };
      if (snapshots.length === 0) {
        return { acquired: true, snapshotsWritten: 0, barsWritten: 0, skipReason: 'missing-quotes', skippedAccounts, unquoted };
      }

      const intradayBars = liveQuotes.map((q) => ({
        symbol: q.symbol,
        // Same alignment as snapshots so portfolio + symbol charts share x-axis.
        t: takenAt,
        close: q.price,
        source: q.source ?? 'unknown',
      }));
      const written = writeHeld.immediate(t, snapshots, intradayBars);
      if (!written) return { acquired: false, snapshotsWritten: 0, barsWritten: 0, skipReason: 'lease-lost' };

      return {
        acquired: true, ...written,
        ...(skippedAccounts > 0 ? { skippedAccounts, unquoted } : {}),
        ...(expiredOptions > 0 ? { expiredOptions } : {}),
      };
    } finally {
      inFlight = false;
    }
  }

  return {
    runOnce: tick,
    stop() {
      // Once: a later call could delete the lease of a successor with the same holder.
      if (stopped) return;
      stopped = true;
      try {
        repo.releaseLease(holder);
      } catch {
        // best-effort: an API restarted on the same endpoint takes the lease up anyway
      }
    },
  };
}

/** Held symbols without a live quote, in words safe for the log: counts and kinds, never a symbol or a value. */
function describeUnquoted(unquoted: TickResult['unquoted']): string {
  if (!unquoted) return 'something without a live quote';
  const kinds = [
    unquoted.options > 0 ? `${unquoted.options} option${unquoted.options === 1 ? '' : 's'}` : '',
    unquoted.crypto > 0 ? `${unquoted.crypto} crypto` : '',
  ].filter(Boolean);
  return `${unquoted.total} held symbol${unquoted.total === 1 ? '' : 's'} without a live quote`
    + `${kinds.length > 0 ? `, of which ${kinds.join(' and ')}` : ''}`;
}

/** Why a tick wrote nothing, safe for the log: a reason and counts. */
export function describeSkip(result: TickResult): string {
  const reason = result.skipReason ?? 'nothing new to write';
  return reason === 'missing-quotes' ? `missing-quotes (no account could be recorded: ${describeUnquoted(result.unquoted)})` : reason;
}

/** What a tick that wrote left out or held at an older mark, safe for the log; null when nothing. */
export function describeTickNote(result: TickResult): string | null {
  const notes = [
    result.skippedAccounts
      ? `left out ${result.skippedAccounts} account${result.skippedAccounts === 1 ? '' : 's'} holding ${describeUnquoted(result.unquoted)}`
      : '',
    result.expiredOptions
      ? `${result.expiredOptions} option position${result.expiredOptions === 1 ? '' : 's'} past expiry held at the last observed mark until the closing record arrives`
      : '',
  ].filter(Boolean);
  return notes.length > 0 ? notes.join('; ') : null;
}

/**
 * Start the scheduler with an initial delay and a recurring timer.
 * Intentionally not a method on SnapshotJob so tests can construct the job
 * without ever scheduling it.
 */
export function startSnapshotScheduler(job: SnapshotJob, cfg: SnapshotConfig = {}): { stop: () => void } {
  const intervalMs = cfg.intervalMs ?? 5 * 60 * 1000;
  const startDelayMs = cfg.startDelayMs ?? 30_000;
  let timer: ReturnType<typeof setInterval> | null = null;
  // What was last logged. Writes are logged every tick; a skip, or a note on
  // what a write left out, only when it starts or changes, so a stall shows
  // in the log once and nights and weekends stay one line each.
  let lastSkip: string | null = null;
  let lastNote: string | null = null;

  const runAndLog = () =>
    job
      .runOnce()
      .then((r) => {
        if (r.acquired && (r.snapshotsWritten > 0 || r.barsWritten > 0)) {
          lastSkip = null;
          console.log(
            `[snapshots] tick ok: snapshots=${r.snapshotsWritten} bars=${r.barsWritten}`,
          );
          const note = describeTickNote(r);
          if (note !== lastNote) {
            if (note !== null || lastNote !== null) {
              console.log(`[snapshots] tick note: ${note ?? 'every account recorded at live prices again'}`);
            }
            lastNote = note;
          }
          return;
        }
        const skip = describeSkip(r);
        if (skip !== lastSkip) {
          lastSkip = skip;
          lastNote = null;
          console.log(`[snapshots] tick skipped: ${skip}`);
        }
      })
      // Type and code only: a failed tick is often SQLite's, whose message and stack can quote the database.
      .catch((err) => {
        lastSkip = null;
        lastNote = null;
        console.warn(`[snapshots] tick failed: ${errorTypeAndCode(err)}`);
      });

  const startTimer = setTimeout(() => {
    void runAndLog();
    timer = setInterval(() => {
      void runAndLog();
    }, intervalMs);
  }, startDelayMs);
  return {
    stop() {
      clearTimeout(startTimer);
      if (timer) clearInterval(timer);
      job.stop();
    },
  };
}
