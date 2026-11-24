import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import net, { type AddressInfo } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';

import { SqliteStateRepo } from './sqliteStateRepo.js';
import {
  createSnapshotJob,
  createSnapshotRepo,
  describeSkip,
  describeTickNote,
  isWithinSnapshotWindow,
  listenerLeaseHolder,
  startSnapshotScheduler,
  type SnapshotConfig,
  type SnapshotJob,
  type SnapshotRepo,
  type TickResult,
} from './snapshotJob.js';
import type { Quote } from '@finance-tracker/shared';

let dir: string;
let state: SqliteStateRepo;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-snap-'));
  state = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
  // Seed two accounts and one transaction each.
  state.createAccount({ id: 'a1', name: 'A1', cashBalance: 100, currency: 'USD' });
  state.createAccount({ id: 'a2', name: 'A2', cashBalance: 50, currency: 'USD' });
  state.createTransaction({
    id: 't1', accountId: 'a1', symbol: 'AAPL', date: '2026-05-05',
    quantity: 10, pricePerUnit: 150, currency: 'USD',
  });
  state.createTransaction({
    id: 't2', accountId: 'a2', symbol: 'AAPL', date: '2026-05-05',
    quantity: 5,  pricePerUnit: 200, currency: 'USD',
  });
});

afterEach(async () => {
  state.close();
  await rm(dir, { recursive: true, force: true });
});

const fakeQuote = (symbol: string, price: number): Quote => ({
  symbol, price, currency: 'USD', asOf: Date.now(), source: 'nasdaq',
});

const fakeFetcher = (price = 200): typeof import('../providers/quoteProvider.js').getQuotes =>
  async (syms) => syms.map((s) => fakeQuote(s, price));

/** Wrap createSnapshotJob with `shouldRun: always true` so tests don't depend on wall-clock. */
const makeJob = (cfg: SnapshotConfig = {}, fetchQuotes = fakeFetcher()) =>
  createSnapshotJob({ state, fetchQuotes }, { shouldRun: () => true, ...cfg });

/** Before the July 2026 contracts below expire. */
const BEFORE_EXPIRY = new Date('2026-07-10T15:00:00.000Z');
const snapshotAccounts = () => state.internalGetDb()
  .prepare('SELECT account_id FROM account_snapshots ORDER BY account_id').pluck().all();

describe('snapshotJob — lease', () => {
  it('first writer acquires the singleton lease', () => {
    const repo = createSnapshotRepo(state);
    const now = new Date('2026-05-06T12:00:00Z');
    expect(repo.acquireLease('writer-A', 60_000, now)).toBe(true);
  });

  it('second concurrent writer is rejected when lease is fresh', () => {
    const repo = createSnapshotRepo(state);
    const now = new Date('2026-05-06T12:00:00Z');
    repo.acquireLease('writer-A', 60_000, now);
    expect(repo.acquireLease('writer-B', 60_000, now)).toBe(false);
  });

  it('a later writer can take a stale (expired) lease', () => {
    const repo = createSnapshotRepo(state);
    const t0 = new Date('2026-05-06T12:00:00Z');
    repo.acquireLease('writer-A', 1, t0);
    const t1 = new Date(t0.getTime() + 5_000);
    expect(repo.acquireLease('writer-B', 60_000, t1)).toBe(true);
  });

  it('the same holder can re-acquire (extends lease)', () => {
    const repo = createSnapshotRepo(state);
    const now = new Date('2026-05-06T12:00:00Z');
    repo.acquireLease('writer-A', 60_000, now);
    expect(repo.acquireLease('writer-A', 60_000, now)).toBe(true);
  });

  describe("an API's holder (listenerLeaseHolder)", () => {
    const listen = (server: net.Server, port = 0) => new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port }, () => { server.off('error', reject); resolve(); });
    });
    const close = (server: net.Server) => new Promise<void>((resolve) => server.close(() => resolve()));

    it('is the endpoint it listens on: the same after a restart, another on another endpoint, none for a duplicate that could not bind', async () => {
      const first = net.createServer();
      await listen(first);
      const { port } = first.address() as AddressInfo;
      const holder = listenerLeaseHolder(first, 'host-a');
      expect(holder).toBe(`api:127.0.0.1:${port}@host-a`);
      expect(holder).not.toContain(String(process.pid));
      expect(listenerLeaseHolder(first, 'host-b')).not.toBe(holder);

      // A duplicate start: its bind fails while the first listens, so it never gets the holder.
      const duplicate = net.createServer();
      await expect(listen(duplicate, port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(() => listenerLeaseHolder(duplicate, 'host-a')).toThrow('a snapshot lease holder needs a listening TCP server');

      const other = net.createServer();
      await listen(other);
      expect(listenerLeaseHolder(other, 'host-a')).not.toBe(holder);
      await close(other);

      // A restart: the endpoint bound again once the first closed is the same holder.
      await close(first);
      expect(() => listenerLeaseHolder(first, 'host-a')).toThrow('a snapshot lease holder needs a listening TCP server');
      const restarted = net.createServer();
      await listen(restarted, port);
      expect(listenerLeaseHolder(restarted, 'host-a')).toBe(holder);
      await close(restarted);
    });

    it('brackets an IPv6 address', () => {
      const server = { listening: true, address: () => ({ address: '::1', family: 'IPv6', port: 4000 }) } as unknown as net.Server;
      expect(listenerLeaseHolder(server, 'host-a')).toBe('api:[::1]:4000@host-a');
    });
  });

  describe('a lease held as <pid>@<host>, as the API held it before', () => {
    const API = 'api:127.0.0.1:4000@host-a';
    const t = new Date('2026-05-06T12:00:00Z');
    const later = new Date(t.getTime() + 60_000);

    it('is taken at once when that process has exited on this host', () => {
      const repo = createSnapshotRepo(state, { processExists: (pid) => pid !== 4242 });
      expect(repo.acquireLease(`4242@${hostname()}`, 660_000, t)).toBe(true);
      expect(repo.acquireLease(API, 660_000, later)).toBe(true);
    });

    it('is kept while that process may still run, and when it names another host', () => {
      const clear = () => state.internalGetDb().prepare('DELETE FROM snapshot_lease').run();
      const running = createSnapshotRepo(state, { processExists: () => true });
      expect(running.acquireLease(`4242@${hostname()}`, 660_000, t)).toBe(true);
      expect(running.acquireLease(API, 660_000, later)).toBe(false);
      clear();
      const exited = createSnapshotRepo(state, { processExists: () => false });
      expect(exited.acquireLease('4242@another-host', 660_000, t)).toBe(true);
      expect(exited.acquireLease(API, 660_000, later)).toBe(false);
      clear();
      // The real check: this test's own process is running.
      const real = createSnapshotRepo(state);
      expect(real.acquireLease(`${process.pid}@${hostname()}`, 660_000, t)).toBe(true);
      expect(real.acquireLease(API, 660_000, later)).toBe(false);
    });
  });
});

describe('snapshotJob — runOnce', () => {
  it('values each account from a single fetchQuotes call and writes one snapshot per account', async () => {
    let calls = 0;
    const fakeFetch: typeof import('../providers/quoteProvider.js').getQuotes = async (syms) => {
      calls++;
      return syms.map((s) => fakeQuote(s, 200));
    };
    const job = makeJob({}, fakeFetch);
    const r = await job.runOnce();
    expect(r.acquired).toBe(true);
    expect(calls).toBe(1);                     // one batched call, not one per account
    expect(r.snapshotsWritten).toBe(2);
    expect(r.barsWritten).toBe(1);             // single AAPL bar
    job.stop();

    // Verify row contents directly. Use the public DB accessor instead of a
    // structural cast so this stays valid if `db` is renamed.
    const db = state.internalGetDb();
    const rows = db
      .prepare('SELECT id, account_id, taken_at, market_value, cost_basis, cash_balance FROM account_snapshots ORDER BY account_id')
      .all() as Array<{ id: string; account_id: string; taken_at: string; market_value: number; cost_basis: number; cash_balance: number }>;
    for (const row of rows) expect(row.id).toBe(`snap-${row.account_id}-${row.taken_at}`);
    expect(rows[0].account_id).toBe('a1');
    // a1: 10 AAPL × $200 + $100 cash = $2,100. Cost basis 10*$150 + $100 = $1,600.
    expect(rows[0].market_value).toBe(2100);
    expect(rows[0].cost_basis).toBe(1600);
    expect(rows[0].cash_balance).toBe(100);
    // a2: 5 × $200 + $50 = $1,050. Cost basis 5*$200 + $50 = $1,050.
    expect(rows[1].market_value).toBe(1050);
    expect(rows[1].cost_basis).toBe(1050);
  });

  it('requests quotes only for current positive positions', async () => {
    state.createTransaction({
      id: 'gone-buy', accountId: 'a1', symbol: 'GONE', date: '2026-01-01',
      quantity: 2, pricePerUnit: 10, currency: 'USD',
    });
    state.createTransaction({
      id: 'gone-sell', accountId: 'a1', symbol: 'GONE', date: '2026-02-01',
      quantity: -2, pricePerUnit: 12, currency: 'USD',
    });
    let requested: string[] = [];
    const fetchQuotes: typeof import('../providers/quoteProvider.js').getQuotes = async (symbols) => {
      requested = symbols;
      return symbols.map((symbol) => fakeQuote(symbol, 200));
    };

    const job = makeJob({}, fetchQuotes);
    await job.runOnce();
    job.stop();

    expect(requested).toEqual(['AAPL']);
  });

  it('counts a holding once, from its activity, when a position snapshot of it also exists', async () => {
    // A position pull ("pos:") and a legacy "imported" row, each since replaced by activity for the same holding.
    state.createTransaction({
      id: 'pos-sold', accountId: 'a1', symbol: 'SOLD', date: '2026-01-01',
      quantity: 4, pricePerUnit: 10, currency: 'USD', sourceFingerprint: 'pos:SOLD',
    });
    state.createTransaction({
      id: 'legacy-held', accountId: 'a1', symbol: 'HELD', date: '2026-01-01',
      quantity: 3, pricePerUnit: 10, currency: 'USD', notes: 'imported from a position pull',
    });
    const activity = (id: string, symbol: string, quantity: number, key: number) => state.createTransaction({
      id, accountId: 'a1', symbol, date: '2026-02-01', quantity, pricePerUnit: 10, currency: 'USD',
      sourceFingerprint: key.toString(16).padStart(64, '0'),
    });
    activity('sold-buy', 'SOLD', 4, 1);
    activity('sold-sell', 'SOLD', -4, 2);
    activity('held-buy', 'HELD', 3, 3);
    let requested: string[] = [];
    // SOLD has no live quote any more: counted as held, it would stop every tick.
    const job = makeJob({}, async (symbols) => {
      requested = symbols;
      return symbols.filter((symbol) => symbol !== 'SOLD').map((symbol) => fakeQuote(symbol, 200));
    });

    const result = await job.runOnce();
    job.stop();

    expect(requested).toEqual(['AAPL', 'HELD']);
    expect(result).toMatchObject({ acquired: true, snapshotsWritten: 2 });
    // Cash 100 + 10 AAPL and 3 HELD at 200: the legacy row gives way to the activity, so not 6 HELD.
    expect(state.internalGetDb().prepare('SELECT market_value FROM account_snapshots WHERE account_id = ?').pluck().get('a1'))
      .toBe(100 + 2_000 + 600);
  });

  it('includes a short option liability and signed basis in observed snapshots', async () => {
    const optionSymbol = 'NBIS260731P00165000';
    state.createTransaction({
      id: 'sto-4', accountId: 'a1', symbol: optionSymbol, date: '2026-07-10',
      quantity: -4, pricePerUnit: 6.10, fees: 2.72, currency: 'USD',
      instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open',
    });
    state.createTransaction({
      id: 'sto-1', accountId: 'a1', symbol: optionSymbol, date: '2026-07-10',
      quantity: -1, pricePerUnit: 8.45, fees: 0.68, currency: 'USD',
      instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open',
    });
    const fetchQuotes: typeof import('../providers/quoteProvider.js').getQuotes = async (symbols) =>
      symbols.map((symbol) => fakeQuote(symbol, symbol === optionSymbol ? 6.05 : 200));

    const job = makeJob({ now: () => BEFORE_EXPIRY }, fetchQuotes);
    await job.runOnce();
    job.stop();

    const row = state.internalGetDb()
      .prepare('SELECT market_value, cost_basis FROM account_snapshots WHERE account_id = ?')
      .get('a1') as { market_value: number; cost_basis: number };
    expect(row.market_value).toBe(-925);
    expect(row.cost_basis).toBeCloseTo(-1681.60);
  });

  it('leaves out only the account holding a liability without a quote, and records the others', async () => {
    const optionSymbol = 'NBIS260731P00165000';
    state.createTransaction({
      id: 'sto', accountId: 'a1', symbol: optionSymbol, date: '2026-07-10',
      quantity: -1, pricePerUnit: 6, currency: 'USD',
      instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open',
    });
    const fetchQuotes: typeof import('../providers/quoteProvider.js').getQuotes = async () => [fakeQuote('AAPL', 200)];
    const job = makeJob({ now: () => BEFORE_EXPIRY }, fetchQuotes);
    const result = await job.runOnce();
    job.stop();
    expect(result).toEqual({
      acquired: true, snapshotsWritten: 1, barsWritten: 1, skippedAccounts: 1, unquoted: { total: 1, options: 1, crypto: 0 },
    });
    expect(describeTickNote(result)).toBe('left out 1 account holding 1 held symbol without a live quote, of which 1 option');
    expect(snapshotAccounts()).toEqual(['a2']);
  });

  it('never records a persisted stale fallback as an observation', async () => {
    const optionSymbol = 'NBIS260731P00165000';
    state.createTransaction({
      id: 'sto', accountId: 'a1', symbol: optionSymbol, date: '2026-07-10',
      quantity: -1, pricePerUnit: 6, currency: 'USD',
      instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open',
    });
    state.internalGetDb().prepare(
      `INSERT INTO symbol_price_bars (symbol, range_kind, t, close, source)
       VALUES (?, 'intraday', ?, ?, ?)`,
    ).run(optionSymbol, '2026-05-06T11:55:00.000Z', 5.5, 'cboe');
    const fetchQuotes: typeof import('../providers/quoteProvider.js').getQuotes = async () => [fakeQuote('AAPL', 200)];
    const job = makeJob({ now: () => new Date('2026-05-06T12:00:00.000Z') }, fetchQuotes);
    const result = await job.runOnce();
    job.stop();

    expect(result).toMatchObject({ snapshotsWritten: 1, skippedAccounts: 1 });
    expect(snapshotAccounts()).toEqual(['a2']);
    // Only the live quote becomes a bar: the stale mark is not written again as if observed now.
    expect(state.internalGetDb().prepare("SELECT symbol FROM symbol_price_bars WHERE t = '2026-05-06T12:00:00.000Z'").pluck().all())
      .toEqual(['AAPL']);
  });

  it('never records a provider quote from before the latest session, even when another account is left out', async () => {
    // a1 also holds a November option the provider can only quote at an old mark; a2 holds UNPRICED, with no quote at all.
    const november = 'NBIS261120C00100000';
    state.createTransaction({
      id: 'call', accountId: 'a1', symbol: november, date: '2026-10-01',
      quantity: 1, pricePerUnit: 5, currency: 'USD',
      instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open',
    });
    state.createTransaction({
      id: 'unpriced', accountId: 'a2', symbol: 'UNPRICED', date: '2026-10-01',
      quantity: 1, pricePerUnit: 10, currency: 'USD',
    });
    const job = makeJob({ now: () => new Date('2026-10-19T15:00:00.000Z') }, async (symbols) => symbols
      .filter((symbol) => symbol !== 'UNPRICED')
      .map((symbol) => (symbol === november ? { ...fakeQuote(symbol, 7.5), freshness: 'stale' as const } : fakeQuote(symbol, 200))));
    const result = await job.runOnce();
    job.stop();

    expect(result).toEqual({
      acquired: true, snapshotsWritten: 0, barsWritten: 0, skipReason: 'missing-quotes',
      skippedAccounts: 2, unquoted: { total: 2, options: 1, crypto: 0 },
    });
    expect(snapshotAccounts()).toEqual([]);
    expect(state.internalGetDb().prepare('SELECT COUNT(*) FROM symbol_price_bars').pluck().get()).toBe(0);
  });

  it('leaves out only the account holding a long equity without a quote', async () => {
    state.createTransaction({
      id: 'unpriced-long', accountId: 'a1', symbol: 'UNPRICED', date: '2026-07-10',
      quantity: 1, pricePerUnit: 10, currency: 'USD',
    });
    const fetchQuotes: typeof import('../providers/quoteProvider.js').getQuotes = async () => [fakeQuote('AAPL', 200)];
    const job = makeJob({}, fetchQuotes);
    const result = await job.runOnce();
    job.stop();
    expect(result).toMatchObject({ snapshotsWritten: 1, skippedAccounts: 1, unquoted: { total: 1, options: 0, crypto: 0 } });
    expect(describeTickNote(result)).toBe('left out 1 account holding 1 held symbol without a live quote');
    expect(snapshotAccounts()).toEqual(['a2']);
  });

  it('writes nothing, and says why, when every account holds something without a quote', async () => {
    for (const accountId of ['a1', 'a2']) {
      state.createTransaction({
        id: `unpriced-${accountId}`, accountId, symbol: 'UNPRICED', date: '2026-07-10',
        quantity: 1, pricePerUnit: 10, currency: 'USD',
      });
    }
    const job = makeJob({}, async () => [fakeQuote('AAPL', 200)]);
    const result = await job.runOnce();
    job.stop();
    expect(result).toEqual({
      acquired: true, snapshotsWritten: 0, barsWritten: 0, skipReason: 'missing-quotes',
      skippedAccounts: 2, unquoted: { total: 1, options: 0, crypto: 0 },
    });
    expect(describeSkip(result)).toBe('missing-quotes (no account could be recorded: 1 held symbol without a live quote)');
    expect(snapshotAccounts()).toEqual([]);
  });

  describe('an option past its expiry date', () => {
    // A call that expired on Friday 2026-10-16 with no closing record yet; its last mark that evening.
    const EXPIRED = 'NBIS261016C00100000';
    const MONDAY = new Date('2026-10-19T14:00:00.000Z');
    const holdExpiredCall = (withMark = true) => {
      state.createTransaction({
        id: 'call', accountId: 'a1', symbol: EXPIRED, date: '2026-09-01',
        quantity: 1, pricePerUnit: 5, currency: 'USD',
        instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open',
      });
      if (withMark) {
        state.internalGetDb().prepare(
          `INSERT INTO symbol_price_bars (symbol, range_kind, t, close, source) VALUES (?, 'intraday', ?, ?, 'cboe')`,
        ).run(EXPIRED, '2026-10-16T23:55:00.000Z', 7.5);
      }
    };
    const recordRequests = (requested: string[][]) => async (symbols: string[]) => {
      requested.push(symbols);
      return symbols.filter((symbol) => symbol === 'AAPL').map((symbol) => fakeQuote(symbol, 200));
    };

    it.each([
      ['the Monday after it expired', MONDAY],
      ['after the week a persisted fallback lasts', new Date('2026-10-27T14:00:00.000Z')],
    ])('is not requested and keeps its last observed mark %s, so the tick still records every account', async (_when, now) => {
      holdExpiredCall();
      const requested: string[][] = [];
      const job = makeJob({ now: () => now }, recordRequests(requested));
      const result = await job.runOnce();
      job.stop();

      expect(requested).toEqual([['AAPL']]);
      expect(result).toEqual({ acquired: true, snapshotsWritten: 2, barsWritten: 1, expiredOptions: 1 });
      expect(describeTickNote(result)).toBe('1 option position past expiry held at the last observed mark until the closing record arrives');
      // Cash 100, 10 AAPL at 200, and the call at its last mark: 1 contract × 100 × 7.50.
      expect(state.internalGetDb().prepare('SELECT market_value FROM account_snapshots WHERE account_id = ?').pluck().get('a1'))
        .toBe(100 + 2_000 + 750);
      expect(state.internalGetDb().prepare('SELECT COUNT(*) FROM symbol_price_bars WHERE symbol = ?').pluck().get(EXPIRED)).toBe(1);
    });

    it('leaves its account out when no mark was ever observed for it', async () => {
      holdExpiredCall(false);
      const job = makeJob({ now: () => MONDAY }, recordRequests([]));
      const result = await job.runOnce();
      job.stop();
      expect(result).toMatchObject({ snapshotsWritten: 1, skippedAccounts: 1, unquoted: { total: 1, options: 1, crypto: 0 } });
      expect(snapshotAccounts()).toEqual(['a2']);
    });

    it('still needs a live quote on the day it expires', async () => {
      holdExpiredCall();
      const requested: string[][] = [];
      const job = makeJob({ now: () => new Date('2026-10-16T18:00:00.000Z') }, recordRequests(requested));
      const result = await job.runOnce();
      job.stop();
      expect(requested).toEqual([['AAPL', EXPIRED]]);
      expect(result).toMatchObject({ snapshotsWritten: 1, skippedAccounts: 1 });
    });
  });

  it('is idempotent — two ticks at the same instant insert one snapshot per account', async () => {
    const t = new Date('2026-05-06T12:00:00Z');
    const job = makeJob({ now: () => t });
    const a = await job.runOnce();
    const b = await job.runOnce();
    expect(a.snapshotsWritten).toBe(2);
    expect(b.snapshotsWritten).toBe(0);        // dedup
    expect(b.barsWritten).toBe(0);             // dedup
    job.stop();
  });

  it('skips overlapping ticks (in-flight guard)', async () => {
    let starts = 0;
    let resolveFetch: (q: Quote[]) => void = () => {};
    const fakeFetch: typeof import('../providers/quoteProvider.js').getQuotes = async (syms) => {
      starts++;
      return new Promise<Quote[]>((resolve) => {
        resolveFetch = () => resolve(syms.map((s) => fakeQuote(s, 200)));
      });
    };
    const job = makeJob({}, fakeFetch);
    const first = job.runOnce();
    const second = await job.runOnce();
    expect(second.acquired).toBe(false);       // in-flight; bailed out
    expect(second.skipReason).toBe('in-flight');
    expect(starts).toBe(1);
    resolveFetch([] as unknown as Quote[]);
    await first;
    job.stop();
  });

  it('skips when the snapshot window is closed (default = US weekdays 04:00–20:00 ET)', async () => {
    // No shouldRun override — uses the default isWithinSnapshotWindow.
    const sat = new Date('2026-05-09T12:00:00Z');  // Saturday
    let calls = 0;
    const fakeFetch: typeof import('../providers/quoteProvider.js').getQuotes = async (syms) => {
      calls++;
      return syms.map((s) => fakeQuote(s, 200));
    };
    const job = createSnapshotJob({ state, fetchQuotes: fakeFetch }, { now: () => sat });
    const r = await job.runOnce();
    expect(r.acquired).toBe(false);
    expect(r.skipReason).toBe('market-closed');
    expect(calls).toBe(0);                     // gate is BEFORE provider call
    job.stop();
  });

  it('two jobs with distinct holder ids contend for the lease (one wins, one bails)', async () => {
    const t = new Date('2026-05-06T12:00:00Z');
    const a = makeJob({ holder: 'A', now: () => t });
    const b = makeJob({ holder: 'B', now: () => t });
    const ra = await a.runOnce();
    const rb = await b.runOnce();
    expect(ra.acquired).toBe(true);
    expect(rb.acquired).toBe(false);
    expect(rb.skipReason).toBe('lease-held');
    a.stop();
    b.stop();
  });

  describe('across an API restart', () => {
    const API = 'api:127.0.0.1:4000@host-a';
    const leaseHolder = () => state.internalGetDb().prepare('SELECT holder FROM snapshot_lease WHERE id = 1').pluck().get();

    it('the restarted API takes up a lease its old process never released, at its first tick', async () => {
      const t0 = new Date('2026-05-06T14:46:43Z');
      const old = makeJob({ holder: API, now: () => t0 });
      expect(await old.runOnce()).toMatchObject({ acquired: true, snapshotsWritten: 2 });
      // The old process ends without stop() (killed, or its release failed): its lease stays fresh until the TTL.
      const t1 = new Date(t0.getTime() + 60_000);
      const pidHolder = makeJob({ holder: `${process.pid}@host-a`, now: () => t1 });
      expect(await pidHolder.runOnce()).toMatchObject({ acquired: false, skipReason: 'lease-held' });
      const restarted = makeJob({ holder: API, now: () => t1 });
      expect(await restarted.runOnce()).toMatchObject({ acquired: true, snapshotsWritten: 2 });
      expect(snapshotAccounts()).toEqual(['a1', 'a1', 'a2', 'a2']);
      expect(leaseHolder()).toBe(API);
      pidHolder.stop();
      restarted.stop();
    });

    it('a stopped job writes nothing more, not even from a tick already in flight', async () => {
      let fetching: () => void = () => {};
      const fetched = new Promise<void>((resolve) => { fetching = resolve; });
      let deliver: () => void = () => {};
      const slowFetch: typeof import('../providers/quoteProvider.js').getQuotes = (syms) => new Promise<Quote[]>((resolve) => {
        deliver = () => resolve(syms.map((s) => fakeQuote(s, 200)));
        fetching();
      });
      const job = makeJob({ holder: API, now: () => new Date('2026-05-06T12:00:00Z') }, slowFetch);
      const inFlight = job.runOnce();
      await fetched;
      // Shutdown stops the job while its quotes are on their way.
      job.stop();
      deliver();
      expect(await inFlight).toEqual({ acquired: false, snapshotsWritten: 0, barsWritten: 0, skipReason: 'stopped' });
      expect(await job.runOnce()).toEqual({ acquired: false, snapshotsWritten: 0, barsWritten: 0, skipReason: 'stopped' });
      expect(snapshotAccounts()).toEqual([]);
      expect(state.internalGetDb().prepare("SELECT COUNT(*) FROM symbol_price_bars WHERE range_kind = 'intraday'").pluck().get()).toBe(0);
      expect(leaseHolder()).toBeUndefined();
    });

    it('stops once: stopping the old job again leaves the lease its successor took', async () => {
      const t = new Date('2026-05-06T12:00:00Z');
      const old = makeJob({ holder: API, now: () => t });
      expect((await old.runOnce()).acquired).toBe(true);
      old.stop();
      expect(leaseHolder()).toBeUndefined();
      const successor = makeJob({ holder: API, now: () => t });
      expect((await successor.runOnce()).acquired).toBe(true);
      old.stop();
      expect(leaseHolder()).toBe(API);
      successor.stop();
      expect(leaseHolder()).toBeUndefined();
    });

    it('the first restart onto this holder takes up the old API\'s <pid>@<host> lease once that process has exited', async () => {
      const t0 = new Date('2026-05-06T14:46:43Z');
      createSnapshotRepo(state).acquireLease(`4242@${hostname()}`, 660_000, t0);
      const repo = createSnapshotRepo(state, { processExists: (pid) => pid !== 4242 });
      const restarted = createSnapshotJob({ state, repo, fetchQuotes: fakeFetcher() },
        { holder: API, now: () => new Date(t0.getTime() + 60_000), shouldRun: () => true });
      expect(await restarted.runOnce()).toMatchObject({ acquired: true, snapshotsWritten: 2 });
      expect(leaseHolder()).toBe(API);
      restarted.stop();
    });
  });

  describe('a tick writes only while the lease it took is still its own', () => {
    const A = 'api:127.0.0.1:4000@host-a';
    const B = 'api:127.0.0.1:4001@host-a';
    const t0 = new Date('2026-05-06T14:00:00Z');
    const TTL = 660_000; // the default: two 5-minute intervals and a minute
    const leaseHolder = () => state.internalGetDb().prepare('SELECT holder FROM snapshot_lease WHERE id = 1').pluck().get();
    const recorded = () => ({
      snapshots: state.internalGetDb().prepare('SELECT DISTINCT taken_at FROM account_snapshots ORDER BY taken_at').pluck().all(),
      bars: state.internalGetDb().prepare("SELECT DISTINCT t FROM symbol_price_bars WHERE range_kind = 'intraday' ORDER BY t").pluck().all(),
    });
    const lost: TickResult = { acquired: false, snapshotsWritten: 0, barsWritten: 0, skipReason: 'lease-lost' };

    /** A quote fetch that waits until `deliver()`; `fetching` settles once a tick is waiting on it. */
    function waitingFetch() {
      let started!: () => void;
      const fetching = new Promise<void>((resolve) => { started = resolve; });
      let deliver!: () => void;
      const delivered = new Promise<void>((resolve) => { deliver = resolve; });
      const fetchQuotes: typeof import('../providers/quoteProvider.js').getQuotes = async (syms) => {
        started();
        await delivered;
        return syms.map((s) => fakeQuote(s, 200));
      };
      return { fetchQuotes, fetching, deliver };
    }

    it('another API took the lease while it waited for quotes: it writes nothing beside the new holder', async () => {
      const other = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
      const quotes = waitingFetch();
      const a = makeJob({ holder: A, now: () => t0 }, quotes.fetchQuotes);
      try {
        const pending = a.runOnce();
        await quotes.fetching;
        // A is suspended past its TTL; B, another live API on its own connection, takes the expired lease and records.
        const b = createSnapshotJob({ state: other, fetchQuotes: fakeFetcher(300) },
          { holder: B, now: () => new Date(t0.getTime() + TTL + 1), shouldRun: () => true });
        expect(await b.runOnce()).toMatchObject({ acquired: true, snapshotsWritten: 2, barsWritten: 1 });
        quotes.deliver();
        expect(await pending).toEqual(lost);
        expect(recorded()).toEqual({ snapshots: ['2026-05-06T14:10:00.000Z'], bars: ['2026-05-06T14:10:00.000Z'] });
        expect(leaseHolder()).toBe(B);
        b.stop();
      } finally {
        a.stop();
        other.close();
      }
    });

    it('its own lease ran out while it waited for quotes: it writes nothing, and the next tick acquires and records', async () => {
      let clock = t0;
      const quotes = waitingFetch();
      const a = makeJob({ holder: A, now: () => clock }, quotes.fetchQuotes);
      const pending = a.runOnce();
      await quotes.fetching;
      clock = new Date(t0.getTime() + TTL + 1);
      quotes.deliver();
      expect(await pending).toEqual(lost);
      expect(recorded()).toEqual({ snapshots: [], bars: [] });
      expect(await a.runOnce()).toMatchObject({ acquired: true, snapshotsWritten: 2, barsWritten: 1 });
      expect(recorded()).toEqual({ snapshots: ['2026-05-06T14:10:00.000Z'], bars: ['2026-05-06T14:10:00.000Z'] });
      a.stop();
    });

    it('it needs more than a minute of its lease left when it writes', async () => {
      for (const [left, result] of [[60_000, lost], [60_001, { acquired: true, snapshotsWritten: 2 }]] as const) {
        state.internalGetDb().exec('DELETE FROM account_snapshots; DELETE FROM symbol_price_bars; DELETE FROM snapshot_lease');
        const quotes = waitingFetch();
        const a = makeJob({ holder: A, now: () => t0 }, quotes.fetchQuotes);
        const pending = a.runOnce();
        await quotes.fetching;
        state.internalGetDb().prepare('UPDATE snapshot_lease SET expires_at = ? WHERE id = 1').run(new Date(t0.getTime() + left).toISOString());
        quotes.deliver();
        expect(await pending, `${left} ms left`).toMatchObject(result);
        a.stop();
      }
    });

    it('no other connection can take the lease between the check and the writes', async () => {
      const rival = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
      rival.internalGetDb().pragma('busy_timeout = 0');
      const base = createSnapshotRepo(state);
      const during: Array<{ inTransaction: boolean; rival: string }> = [];
      const repo: SnapshotRepo = {
        ...base,
        insertAccountSnapshots: (rows) => {
          const inserted = base.insertAccountSnapshots(rows);
          let rivalOutcome = 'took the lease';
          try {
            rival.internalGetDb().prepare("UPDATE snapshot_lease SET holder = 'rival' WHERE id = 1").run();
          } catch (error) {
            rivalOutcome = (error as { code?: string }).code ?? 'failed';
          }
          during.push({ inTransaction: state.internalGetDb().inTransaction, rival: rivalOutcome });
          return inserted;
        },
      };
      const job = createSnapshotJob({ state, repo, fetchQuotes: fakeFetcher() }, { holder: A, now: () => t0, shouldRun: () => true });
      try {
        expect(await job.runOnce()).toMatchObject({ acquired: true, snapshotsWritten: 2, barsWritten: 1 });
        expect(during).toEqual([{ inTransaction: true, rival: 'SQLITE_BUSY' }]);
        expect(leaseHolder()).toBe(A);
      } finally {
        job.stop();
        rival.close();
      }
    });
  });
});

describe('isWithinSnapshotWindow', () => {
  // Use UTC times that map cleanly to US Eastern. May 6, 2026 is EDT (UTC-4).
  it('returns true at 09:30 ET on a weekday', () => {
    expect(isWithinSnapshotWindow(new Date('2026-05-06T13:30:00Z'))).toBe(true);
  });
  it('returns true at 04:00 ET (pre-market start)', () => {
    expect(isWithinSnapshotWindow(new Date('2026-05-06T08:00:00Z'))).toBe(true);
  });
  it('returns false at 20:00 ET (after-hours end)', () => {
    expect(isWithinSnapshotWindow(new Date('2026-05-07T00:00:00Z'))).toBe(false);
  });
  it('returns false at 03:30 ET (before pre-market)', () => {
    expect(isWithinSnapshotWindow(new Date('2026-05-06T07:30:00Z'))).toBe(false);
  });
  it('returns false on Saturday during equivalent ET hours', () => {
    expect(isWithinSnapshotWindow(new Date('2026-05-09T13:30:00Z'))).toBe(false);
  });
  it('returns false on Sunday', () => {
    expect(isWithinSnapshotWindow(new Date('2026-05-10T13:30:00Z'))).toBe(false);
  });
});

describe('startSnapshotScheduler', () => {
  it('does not tick before startDelayMs, then ticks on the interval', async () => {
    vi.useFakeTimers();
    try {
      let ticks = 0;
      const fakeJob: SnapshotJob = {
        runOnce: async () => {
          ticks++;
          return { acquired: true, snapshotsWritten: 0, barsWritten: 0 };
        },
        stop: () => {},
      };
      const sched = startSnapshotScheduler(fakeJob, { intervalMs: 1000, startDelayMs: 500 });
      expect(ticks).toBe(0);
      await vi.advanceTimersByTimeAsync(499);
      expect(ticks).toBe(0);
      await vi.advanceTimersByTimeAsync(1);    // crosses startDelayMs
      expect(ticks).toBe(1);
      await vi.advanceTimersByTimeAsync(1000); // first interval after startup
      expect(ticks).toBe(2);
      sched.stop();
      // After stop, advancing time produces no more ticks.
      await vi.advanceTimersByTimeAsync(5000);
      expect(ticks).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs a skip or a note when it starts and when it changes, never while it lasts', async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      const unquoted = { total: 2, options: 1, crypto: 0 };
      const skip = (skipReason: TickResult['skipReason'], extra: Partial<TickResult> = {}): TickResult => ({
        acquired: skipReason === 'missing-quotes', snapshotsWritten: 0, barsWritten: 0, skipReason, ...extra,
      });
      const partial: TickResult = { acquired: true, snapshotsWritten: 18, barsWritten: 12, skippedAccounts: 1, unquoted };
      const results: TickResult[] = [
        skip('market-closed'), skip('market-closed'),
        skip('missing-quotes', { skippedAccounts: 19, unquoted }), skip('missing-quotes', { skippedAccounts: 19, unquoted }),
        partial, partial,
        { acquired: true, snapshotsWritten: 19, barsWritten: 12 },
        skip('in-flight'), skip('in-flight'),
      ];
      let index = 0;
      const sched = startSnapshotScheduler(
        { runOnce: async () => results[Math.min(index++, results.length - 1)], stop: () => {} },
        { intervalMs: 1000, startDelayMs: 0 },
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(8000);
      sched.stop();
      expect(index).toBe(results.length);
      expect(lines).toEqual([
        '[snapshots] tick skipped: market-closed',
        '[snapshots] tick skipped: missing-quotes (no account could be recorded: 2 held symbols without a live quote, of which 1 option)',
        '[snapshots] tick ok: snapshots=18 bars=12',
        '[snapshots] tick note: left out 1 account holding 2 held symbols without a live quote, of which 1 option',
        '[snapshots] tick ok: snapshots=18 bars=12',
        '[snapshots] tick ok: snapshots=19 bars=12',
        '[snapshots] tick note: every account recorded at live prices again',
        '[snapshots] tick skipped: in-flight',
      ]);
    } finally {
      log.mockRestore();
      vi.useRealTimers();
    }
  });

  it('stops cleanly even if called before the initial delay elapses', async () => {
    vi.useFakeTimers();
    try {
      let ticks = 0;
      const fakeJob: SnapshotJob = {
        runOnce: async () => {
          ticks++;
          return { acquired: true, snapshotsWritten: 0, barsWritten: 0 };
        },
        stop: () => {},
      };
      const sched = startSnapshotScheduler(fakeJob, { intervalMs: 1000, startDelayMs: 500 });
      sched.stop();                            // before first tick
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ticks).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('a failed tick is logged by its type and code only', () => {
    // SQLite's messages can quote whatever the database holds: here a table named after a synthetic card number.
    const PAN = '4111111111111111';

    /** Starts `job` at once and resolves with what the scheduler warned on its first tick. */
    async function firstWarning(job: SnapshotJob): Promise<unknown[][]> {
      const warnings: unknown[][] = [];
      let warned!: () => void;
      const done = new Promise<void>((resolve) => { warned = resolve; });
      const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        warnings.push(args);
        warned();
      });
      const sched = startSnapshotScheduler(job, { intervalMs: 60_000, startDelayMs: 0 });
      try {
        await done;
      } finally {
        sched.stop();
        warn.mockRestore();
      }
      return warnings;
    }

    it('a database failure in the real job: SqliteError and its code, never the message or stack', async () => {
      state.internalGetDb().exec(`
        ALTER TABLE accounts RENAME TO accounts_kept;
        CREATE TABLE pan_${PAN} (x);
        CREATE VIEW accounts AS SELECT * FROM pan_${PAN};
        DROP TABLE pan_${PAN};
      `);
      const warnings = await firstWarning(makeJob({ holder: 'failing-tick' }));
      expect(warnings).toEqual([['[snapshots] tick failed: SqliteError SQLITE_ERROR']]);
      expect(inspect(warnings)).not.toContain(PAN);
    });

    it('any other failure: its type, without its message', async () => {
      const warnings = await firstWarning({
        runOnce: async () => {
          throw new Error(`quote completeness invariant failed for ${PAN}`);
        },
        stop: () => {},
      });
      expect(warnings).toEqual([['[snapshots] tick failed: Error']]);
    });
  });
});

describe('snapshotJob — indicative isolation (flaw E/G regression)', () => {
  it('values off price only; never reads quote.indicative', async () => {
    // A quote whose indicative price is wildly different from price. If the
    // snapshot ever read `indicative`, marketValue would jump.
    const fetchQuotes = (async (syms: string[]) =>
      syms.map((s) => ({
        symbol: s,
        price: 200,
        currency: 'USD',
        asOf: Date.now(),
        source: 'nasdaq' as const,
        indicative: {
          price: 999, // absurd — must never be used
          source: 'hyperliquid-perp' as const,
          asOf: Date.now(),
          baselineClose: 200,
          premiumPct: 3.995,
          confidence: 'dislocated' as const,
        },
      }))) as unknown as typeof import('../providers/quoteProvider.js').getQuotes;

    const job = makeJob({}, fetchQuotes);
    const result = await job.runOnce();
    expect(result.acquired).toBe(true);

    const db = state.internalGetDb();
    const rows = db
      .prepare('SELECT account_id, market_value FROM account_snapshots ORDER BY account_id')
      .all() as Array<{ account_id: string; market_value: number }>;
    // a1: cash 100 + 10*200 = 2100 (NOT 10*999). a2: cash 50 + 5*200 = 1050.
    const byAcct = new Map(rows.map((r) => [r.account_id, r.market_value]));
    expect(byAcct.get('a1')).toBe(2100);
    expect(byAcct.get('a2')).toBe(1050);

    // Intraday bar close must be the official price, not the indicative.
    const bars = db
      .prepare('SELECT symbol, close FROM symbol_price_bars WHERE range_kind = ?')
      .all('intraday') as Array<{ symbol: string; close: number }>;
    for (const b of bars) expect(b.close).toBe(200);
  });

  it('requests quotes with indicative disabled (no wasted overlay work)', async () => {
    let receivedOpts: unknown;
    const fetchQuotes = (async (syms: string[], opts?: unknown) => {
      receivedOpts = opts;
      return syms.map((s) => ({
        symbol: s, price: 200, currency: 'USD', asOf: Date.now(), source: 'nasdaq' as const,
      }));
    }) as unknown as typeof import('../providers/quoteProvider.js').getQuotes;

    const job = makeJob({}, fetchQuotes);
    await job.runOnce();
    expect(receivedOpts).toEqual({ indicative: false });
  });
});
