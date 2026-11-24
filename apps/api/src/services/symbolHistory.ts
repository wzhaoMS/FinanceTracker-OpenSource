import type { Database as DB } from 'better-sqlite3';

import type { SqliteStateRepo } from './sqliteStateRepo.js';
import type { PriceBar } from '../providers/historyTypes.js';
import { fetchNasdaqHistory } from '../providers/nasdaqHistory.js';
import { fetchCoinGeckoHistory } from '../providers/coingeckoHistory.js';

/**
 * Range definitions used by `/symbols/:symbol/history`.
 *
 * `1D` is special: it requires intraday data, which only Phase B.1's
 * snapshot job will produce. Until snapshots exist, the route returns an
 * explicit unsupported state with `reason` so the UI can render a clear
 * "1D coming after snapshots" message instead of a fake daily-bar chart.
 */
export type RangeKey = '1D' | '1W' | '1M' | '3M' | 'YTD' | '1Y' | '5Y' | 'ALL';

export const RANGE_DAYS: Record<RangeKey, number> = {
  '1D': 1,
  '1W': 7,
  '1M': 31,
  '3M': 93,
  YTD: 0, // computed at request time
  '1Y': 365,
  '5Y': 365 * 5,
  ALL: 365 * 20,
};

/** Ranges backed by daily bars — the only ones C.1 can serve right now. */
export const DAILY_RANGES = ['1W', '1M', '3M', 'YTD', '1Y', '5Y', 'ALL'] as const;

/**
 * Conservative symbol validation before any provider call. Allows stock
 * tickers, ETFs, and `XXX-USD` crypto pairs. Rejects path-traversal-y input
 * before we send it outbound.
 */
export const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,11}$/;

function isCrypto(symbol: string): boolean {
  return /^[A-Z]{2,6}-USD$/i.test(symbol);
}

const MARKET_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function marketDate(now: Date): string {
  const parts = MARKET_DATE_FORMATTER.formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) throw new Error('Unable to format market date');
  return `${year}-${month}-${day}`;
}

function calendarDaysBack(date: string, days: number): string {
  return ymd(new Date(new Date(`${date}T12:00:00Z`).getTime() - days * 86400_000));
}

function calendarMonthsBack(date: string, months: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const targetMonth = new Date(Date.UTC(year, month - 1 - months, 1));
  const lastDay = new Date(Date.UTC(
    targetMonth.getUTCFullYear(),
    targetMonth.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  targetMonth.setUTCDate(Math.min(day, lastDay));
  return ymd(targetMonth);
}

/** Compute the (from, to) ISO date range for a given range key. */
export function rangeBounds(range: RangeKey, now: Date = new Date()): { from: string; to: string; daysSpan: number } {
  const to = marketDate(now);
  let from: string;
  if (range === '1D') {
    from = to;
  } else if (range === 'YTD') {
    from = `${to.slice(0, 4)}-01-01`;
  } else if (range === '1M') {
    from = calendarMonthsBack(to, 1);
  } else {
    from = calendarDaysBack(to, RANGE_DAYS[range]);
  }
  const daysSpan = Math.ceil((Date.parse(to) - Date.parse(from)) / 86400_000);
  return { from, to, daysSpan };
}

export interface HistoryRepo {
  /** Read cached bars for `symbol` between [from, to] (inclusive). */
  readBars(symbol: string, from: string, to: string): PriceBar[];
  /** Insert bars idempotently; (symbol, range_kind, t, source) is the PK.
   *  Existing rows are kept untouched — use `replaceRecentBars` to refresh
   *  recent bars when the provider may have revised them. */
  upsertBars(bars: PriceBar[]): void;
  /**
   * Insert bars with a rolling refresh window: bars dated on or after
   * `sinceDate` (YYYY-MM-DD) overwrite existing rows, bars before are
   * inserted only if missing. This catches provider revisions to recent
   * trading days (close-of-day adjustments, late prints) without
   * disturbing the long-term immutable history that the chart depends on.
   *
   * sinceDate defaults to 7 calendar days before today.
   */
  replaceRecentBars(bars: PriceBar[], sinceDate?: string): void;
  /** Most recent fetched_at across cached bars in [from, to]. Returns
   *  ISO 8601 epoch when known, else null (no rows). Drives the
   *  "Last refreshed: Xm ago" footnote on charts. */
  latestFetchedAt(symbol: string, from: string, to: string): string | null;
  /**
   * Stored market data only (HOLDR_MARKET_DATA=stored, the demo): `getSymbolHistory` serves what is stored and never
   * asks a provider for more.
   */
  readonly storedOnly?: boolean;
}

/** Thin SQLite repo for symbol_price_bars, sharing the SqliteStateRepo handle. */
export function createHistoryRepo(state: SqliteStateRepo, options: { storedOnly?: boolean } = {}): HistoryRepo {
  const db: DB = state.internalGetDb();
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO symbol_price_bars
       (symbol, range_kind, t, close, open, high, low, volume, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const replaceStmt = db.prepare(
    `INSERT INTO symbol_price_bars
       (symbol, range_kind, t, close, open, high, low, volume, source, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(symbol, range_kind, t, source) DO UPDATE SET
       close = excluded.close,
       open = excluded.open,
       high = excluded.high,
       low = excluded.low,
       volume = excluded.volume,
       fetched_at = excluded.fetched_at`,
  );
  const readStmt = db.prepare(
    `SELECT symbol, t, close, open, high, low, volume, source
       FROM symbol_price_bars
      WHERE symbol = ? AND range_kind = 'daily' AND t >= ? AND t <= ?
      ORDER BY t ASC`,
  );
  const latestFetchedStmt = db.prepare(
    `SELECT MAX(fetched_at) as latest
       FROM symbol_price_bars
      WHERE symbol = ? AND range_kind = 'daily' AND t >= ? AND t <= ?`,
  );
  return {
    ...(options.storedOnly ? { storedOnly: true } : {}),
    readBars(symbol, from, to) {
      const rows = readStmt.all(symbol.toUpperCase(), from, to) as Array<{
        symbol: string; t: string; close: number; open: number | null; high: number | null;
        low: number | null; volume: number | null; source: string;
      }>;
      return rows.map((r) => ({
        symbol: r.symbol,
        t: r.t,
        close: r.close,
        open: r.open ?? undefined,
        high: r.high ?? undefined,
        low: r.low ?? undefined,
        volume: r.volume ?? undefined,
        source: r.source as PriceBar['source'],
      }));
    },
    upsertBars(bars) {
      const tx = db.transaction((rows: PriceBar[]) => {
        for (const b of rows) {
          insertStmt.run(
            b.symbol,
            'daily',
            b.t,
            b.close,
            b.open ?? null,
            b.high ?? null,
            b.low ?? null,
            b.volume ?? null,
            b.source,
          );
        }
      });
      tx(bars);
    },
    replaceRecentBars(bars, sinceDate) {
      const cutoff = sinceDate ?? defaultRefreshCutoff();
      const tx = db.transaction((rows: PriceBar[]) => {
        for (const b of rows) {
          // Recent: REPLACE so corp-actions / late prints get applied.
          // Older: IGNORE so historical data stays stable.
          const stmt = b.t >= cutoff ? replaceStmt : insertStmt;
          stmt.run(
            b.symbol,
            'daily',
            b.t,
            b.close,
            b.open ?? null,
            b.high ?? null,
            b.low ?? null,
            b.volume ?? null,
            b.source,
          );
        }
      });
      tx(bars);
    },
    latestFetchedAt(symbol, from, to) {
      const row = latestFetchedStmt.get(symbol.toUpperCase(), from, to) as { latest: string | null };
      return row?.latest ?? null;
    },
  };
}

/** Default rolling refresh window: 7 calendar days before today (UTC). */
function defaultRefreshCutoff(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}

/**
 * Provider bookkeeping per history repo and symbol. `deep*` records the
 * deepest start asked for (and whether that request returned bars) so a
 * deeper range fetches older bars once; `lastAt` throttles refreshes when the
 * provider cannot advance the cache (holidays, delisted symbols, an outage
 * that returns nothing).
 */
interface ProviderAttempt { deepFrom: string; deepAt: number; deepGotBars: boolean; lastAt: number }
const providerAttempts = new WeakMap<HistoryRepo, Map<string, ProviderAttempt>>();
const providerFlights = new WeakMap<HistoryRepo, Map<string, Promise<void>>>();
const PROVIDER_RETRY_MS = 15 * 60 * 1000;

function isoDaysAfter(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return ymd(date);
}

function maxIsoDate(left: string, right: string): string {
  return left > right ? left : right;
}

export interface HistoryResult {
  symbol: string;
  range: RangeKey;
  from: string;
  to: string;
  bars: PriceBar[];
  /** True when at least one provider returned data; false on supported=false. */
  supported: boolean;
  /** Free-form reason when `supported === false`. */
  reason?: string;
  /** Which providers contributed (in case of mixed sources). */
  sources: string[];
  /** Most recent ISO 8601 `fetched_at` across the returned bars. Drives
   *  the "Last refreshed Xm ago" footnote on charts. Absent on
   *  unsupported responses (no rows). */
  lastRefreshedAt?: string;
}

/**
 * Find the most recent weekday on or before `d` (no holiday calendar; close
 * enough for a freshness heuristic). Returns ISO YYYY-MM-DD.
 */
function lastWeekdayOnOrBefore(d: Date): string {
  const x = new Date(d);
  while (x.getUTCDay() === 0 || x.getUTCDay() === 6) {
    x.setUTCDate(x.getUTCDate() - 1);
  }
  return ymd(x);
}

/**
 * Get a symbol's daily price history for the requested range.
 *
 * `1D` requires intraday data which Phase B.1 will produce; until then the
 * route returns `supported: false, reason: 'intraday data starts after snapshots'`.
 *
 * Daily-range strategy:
 *   1. Read cache for [from, to].
 *   2. Skip provider call ONLY if the latest cached bar covers up to the
 *      most recent weekday (≈ "we have today's close already"). Counting
 *      rows is misleading because a 6-month-old fully-populated cache
 *      would defeat freshness.
 *   3. Otherwise hit Nasdaq (stocks/ETFs/funds) or CoinGecko (crypto),
 *      persist any new bars, re-read.
 */
export async function getSymbolHistory(
  repo: HistoryRepo,
  symbol: string,
  range: RangeKey,
  now: Date = new Date(),
): Promise<HistoryResult> {
  const sym = symbol.toUpperCase();
  if (!SYMBOL_RE.test(sym)) {
    return {
      symbol: sym, range,
      from: ymd(now), to: ymd(now),
      bars: [], supported: false,
      reason: 'invalid symbol',
      sources: [],
    };
  }

  if (range === '1D') {
    // 1D needs intraday bars; daily history can't give that.
    return {
      symbol: sym, range,
      from: ymd(now), to: ymd(now),
      bars: [], supported: false,
      reason: 'intraday history is not available yet — coming once snapshots ship',
      sources: [],
    };
  }

  const { from, to, daysSpan } = rangeBounds(range, now);
  let cached = repo.readBars(sym, from, to);

  const expectedLatest = lastWeekdayOnOrBefore(new Date(`${to}T12:00:00Z`));
  const cachedLatest = cached.length > 0 ? cached[cached.length - 1].t : '';
  const cacheIsFresh = cachedLatest >= expectedLatest;
  // A fresh tail does not prove the cache reaches back to `from`: a shorter
  // range may have filled only the last year. Ask the provider once per
  // repo/symbol for an earlier start; listings younger than the range keep
  // their late first bar without refetching on every request.
  const attempts = providerAttempts.get(repo) ?? new Map<string, ProviderAttempt>();
  providerAttempts.set(repo, attempts);
  const attempt = attempts.get(sym);
  const nowMs = Date.now();
  const coversStart = cached.length > 0 && (
    cached[0].t <= isoDaysAfter(from, 7)
    || (attempt !== undefined && attempt.deepFrom <= from && attempt.deepGotBars)
  );
  // Coverage needs the full window unless an equally deep request was just
  // tried; a stale tail only needs the last week or so, at most once per
  // throttle window whatever range asked for it. A stored-only repo never asks.
  const fetchFrom = repo.storedOnly ? null : !coversStart
    ? (attempt !== undefined && attempt.deepFrom <= from && nowMs - attempt.deepAt < PROVIDER_RETRY_MS ? null : from)
    : !cacheIsFresh && (attempt === undefined || nowMs - attempt.lastAt >= PROVIDER_RETRY_MS)
      ? maxIsoDate(from, isoDaysAfter(cachedLatest, -7))
      : null;

  if (fetchFrom !== null) {
    const flights = providerFlights.get(repo) ?? new Map<string, Promise<void>>();
    providerFlights.set(repo, flights);
    const flightKey = `${sym}\u0000${fetchFrom}\u0000${to}`;
    let flight = flights.get(flightKey);
    if (!flight) {
      flight = (async () => {
        let gotBars = false;
        try {
          const fresh = isCrypto(sym)
            ? await fetchCoinGeckoHistory(sym, daysSpan)
            : await fetchNasdaqHistory(sym, fetchFrom, to);
          gotBars = fresh.length > 0;
          if (gotBars) {
            const inRange = fresh.filter((b) => b.t >= from && b.t <= to);
            // Refresh: recent bars (last 7 days) get REPLACEd in case the
            // provider revised them; older bars stay immutable so a 1Y/5Y
            // chart doesn't churn historical data on every cache miss.
            repo.replaceRecentBars(inRange);
          }
        } finally {
          const answeredAt = Date.now();
          const previous = attempts.get(sym);
          const deeper = !previous || fetchFrom <= previous.deepFrom;
          attempts.set(sym, {
            deepFrom: deeper ? fetchFrom : previous.deepFrom,
            deepAt: deeper ? answeredAt : previous.deepAt,
            deepGotBars: deeper ? gotBars : previous.deepGotBars,
            lastAt: answeredAt,
          });
        }
      })().finally(() => flights.delete(flightKey));
      flights.set(flightKey, flight);
    }
    await flight;
    cached = repo.readBars(sym, from, to);
  }

  // Deduplicate per `t`: the schema PK includes `source`, so multiple
  // providers can fill the same date. Pick a single bar per date with a
  // simple precedence (nasdaq > coingecko > stooq > others).
  const deduped = pickOneBarPerDate(cached);

  const sources = Array.from(new Set(deduped.map((b) => b.source)));
  if (deduped.length === 0) {
    return {
      symbol: sym, range, from, to,
      bars: [], supported: false,
      reason: 'no provider returned price history for this symbol',
      sources: [],
    };
  }
  // Most recent fetched_at across the deduped bars — surfaces in the
  // chart footnote so the user knows when this data was last refreshed.
  const lastRefreshedAt = repo.latestFetchedAt(sym, from, to);
  return {
    symbol: sym, range, from, to,
    bars: deduped, supported: true,
    sources,
    ...(lastRefreshedAt ? { lastRefreshedAt } : {}),
  };
}

const SOURCE_PRECEDENCE: Record<string, number> = {
  nasdaq: 0,
  cnbc: 1,
  coingecko: 2,
  stooq: 3,
};

/** Collapse multiple bars per date down to a single canonical bar. */
export function pickOneBarPerDate(bars: PriceBar[]): PriceBar[] {
  const byDate = new Map<string, PriceBar>();
  for (const b of bars) {
    const existing = byDate.get(b.t);
    if (!existing) {
      byDate.set(b.t, b);
      continue;
    }
    const candidatePrec = SOURCE_PRECEDENCE[b.source] ?? 99;
    const existingPrec = SOURCE_PRECEDENCE[existing.source] ?? 99;
    if (candidatePrec < existingPrec) byDate.set(b.t, b);
  }
  return Array.from(byDate.values()).sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
}
