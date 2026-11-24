import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SqliteStateRepo } from './sqliteStateRepo.js';
import { createHistoryRepo, rangeBounds } from './symbolHistory.js';
import { downsampleReferencePoints, getPortfolioHistory, getPortfolioPerformance, moneyWeightedReturn } from './portfolioHistory.js';
import { FIDELITY_CASH_ADOPTED_REASON } from './historyCorrections.js';
import { createManualPriceRepo } from './manualPrices.js';
import type { PriceBar } from '../providers/historyTypes.js';

let dir: string;
let state: SqliteStateRepo;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-port-'));
  state = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
  state.createAccount({ id: 'a1', name: 'A1', cashBalance: 100, currency: 'USD' });
  state.createAccount({ id: 'a2', name: 'A2', cashBalance: 50, currency: 'USD' });
});

afterEach(async () => {
  state.close();
  await rm(dir, { recursive: true, force: true });
});

/** Insert a snapshot row directly via the underlying DB. */
function insertSnapshot(args: {
  accountId: string; takenAt: string; marketValue: number;
  costBasis: number; cashBalance: number;
}) {
  state.internalGetDb().prepare(
    `INSERT INTO account_snapshots
       (id, account_id, taken_at, market_value, cost_basis, cash_balance)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    `s-${args.accountId}-${args.takenAt}`,
    args.accountId, args.takenAt, args.marketValue, args.costBasis, args.cashBalance,
  );
}

/** Insert a synthetic daily price bar to back reconstruction tests. */
function seedDailyBar(symbol: string, t: string, close: number) {
  const repo = createHistoryRepo(state);
  const bar: PriceBar = { symbol, t, close, source: 'nasdaq' };
  repo.upsertBars([bar]);
}

describe('portfolioHistory — 1D from snapshots', () => {
  const now = new Date('2026-05-06T20:00:00Z');

  it('uses the latest New York session after UTC midnight and fills a complete extended-hours day', async () => {
    insertSnapshot({ accountId: 'a1', takenAt: '2026-07-09T23:55:00.000Z', marketValue: 900, costBasis: 800, cashBalance: 100 });
    // Every tick of Friday's extended session, 04:05–19:55 EDT, the last after UTC midnight.
    const ticks = Array.from({ length: 191 }, (_, index) => new Date(Date.parse('2026-07-10T08:05:00.000Z') + index * 5 * 60_000).toISOString());
    ticks.forEach((takenAt, index) => insertSnapshot({ accountId: 'a1', takenAt, marketValue: 1000 + index, costBasis: 800, cashBalance: 100 }));

    const result = await getPortfolioHistory(
      { state, history: createHistoryRepo(state) },
      '1D', ['a1'], new Date('2026-07-11T01:38:00Z'),
    );
    expect(result.points.map((point) => point.t)).toEqual(ticks);
    expect(result.coverage).toEqual({
      requestedFrom: '2026-07-10',
      requestedTo: '2026-07-10',
      actualFrom: '2026-07-10T08:05:00.000Z',
      actualTo: '2026-07-10T23:55:00.000Z',
      complete: true,
      percent: 100,
    });
  });

  it('keeps one EST extended-hours session together across two UTC dates', async () => {
    insertSnapshot({ accountId: 'a1', takenAt: '2026-12-15T00:55:00.000Z', marketValue: 900, costBasis: 800, cashBalance: 100 });
    // Every tick of Tuesday's extended session, 04:05–19:55 EST, the last hour after UTC midnight.
    const ticks = Array.from({ length: 191 }, (_, index) => new Date(Date.parse('2026-12-15T09:05:00.000Z') + index * 5 * 60_000).toISOString());
    ticks.forEach((takenAt, index) => insertSnapshot({ accountId: 'a1', takenAt, marketValue: 1000 + index, costBasis: 800, cashBalance: 100 }));

    const result = await getPortfolioHistory(
      { state, history: createHistoryRepo(state) },
      '1D', ['a1'], new Date('2026-12-16T02:00:00Z'),
    );
    expect(result.points.map((point) => point.t)).toEqual(ticks);
    expect(result.coverage).toMatchObject({
      requestedFrom: '2026-12-15',
      requestedTo: '2026-12-15',
      complete: true,
      percent: 100,
    });
  });

  it('falls back to the latest observed session on weekends within the requested account scope', async () => {
    insertSnapshot({ accountId: 'a1', takenAt: '2026-07-10T13:00:00.000Z', marketValue: 1000, costBasis: 800, cashBalance: 100 });
    insertSnapshot({ accountId: 'a1', takenAt: '2026-07-10T20:00:00.000Z', marketValue: 1050, costBasis: 800, cashBalance: 100 });
    insertSnapshot({ accountId: 'a2', takenAt: '2026-07-09T13:00:00.000Z', marketValue: 500, costBasis: 400, cashBalance: 50 });
    insertSnapshot({ accountId: 'a2', takenAt: '2026-07-09T20:00:00.000Z', marketValue: 550, costBasis: 400, cashBalance: 50 });

    const result = await getPortfolioHistory(
      { state, history: createHistoryRepo(state) },
      '1D', ['a2'], new Date('2026-07-12T18:00:00Z'),
    );
    expect(result.points.map((point) => point.t)).toEqual([
      '2026-07-09T13:00:00.000Z',
      '2026-07-09T20:00:00.000Z',
    ]);
    expect(result.coverage.requestedFrom).toBe('2026-07-09');
    expect(result.coverage.requestedTo).toBe('2026-07-09');
  });

  it('does not call a single intraday snapshot complete coverage', async () => {
    insertSnapshot({ accountId: 'a1', takenAt: '2026-07-10T17:55:00.000Z', marketValue: 1000, costBasis: 800, cashBalance: 100 });

    const result = await getPortfolioHistory(
      { state, history: createHistoryRepo(state) },
      '1D', ['a1'], new Date('2026-07-10T18:00:00Z'),
    );
    expect(result.points).toHaveLength(1);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.percent).toBeLessThan(2);
  });

  it('groups by taken_at and sums across accounts', async () => {
    insertSnapshot({ accountId: 'a1', takenAt: '2026-05-06T13:00:00Z', marketValue: 1000, costBasis: 800, cashBalance: 100 });
    insertSnapshot({ accountId: 'a2', takenAt: '2026-05-06T13:00:00Z', marketValue: 500,  costBasis: 400, cashBalance: 50  });
    insertSnapshot({ accountId: 'a1', takenAt: '2026-05-06T14:00:00Z', marketValue: 1100, costBasis: 800, cashBalance: 100 });
    insertSnapshot({ accountId: 'a2', takenAt: '2026-05-06T14:00:00Z', marketValue: 520,  costBasis: 400, cashBalance: 50  });

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state) },
      '1D', undefined, now,
    );
    expect(r.supported).toBe(true);
    expect(r.approximate).toBe(false);
    expect(r.source).toBe('snapshots');
    expect(r.points).toHaveLength(2);
    expect(r.points[0]).toMatchObject({ t: '2026-05-06T13:00:00Z', value: 1500, costBasis: 1200 });
    expect(r.points[1]).toMatchObject({ t: '2026-05-06T14:00:00Z', value: 1620, costBasis: 1200 });
    expect(r.summary.startValue).toBe(1500);
    expect(r.summary.endValue).toBe(1620);
    expect(r.summary.change).toBe(120);
    expect(r.summary.changePercent).toBeCloseTo(8, 5);
    expect(r.trackingSince).toBe('2026-05-06T13:00:00Z');
  });

  it('keeps captured snapshots but marks late-import intervals unreliable', async () => {
    insertSnapshot({ accountId: 'a1', takenAt: '2026-05-05T20:00:00Z', marketValue: 1000, costBasis: 800, cashBalance: 100 });
    insertSnapshot({ accountId: 'a2', takenAt: '2026-05-05T20:00:00Z', marketValue: 500, costBasis: 400, cashBalance: 50 });
    insertSnapshot({ accountId: 'a1', takenAt: '2026-05-06T13:00:00Z', marketValue: 1010, costBasis: 800, cashBalance: 100 });
    insertSnapshot({ accountId: 'a2', takenAt: '2026-05-06T13:00:00Z', marketValue: 510, costBasis: 400, cashBalance: 50 });
    insertSnapshot({ accountId: 'a1', takenAt: '2026-05-06T15:00:00Z', marketValue: 1020, costBasis: 800, cashBalance: 100 });
    insertSnapshot({ accountId: 'a2', takenAt: '2026-05-06T15:00:00Z', marketValue: 520, costBasis: 400, cashBalance: 50 });
    state.internalGetDb().prepare(
      `INSERT INTO account_history_invalidations
        (account_id, effective_date, detected_at, reason)
       VALUES (?, ?, ?, ?)`,
    ).run('a1', '2026-05-06', '2026-05-06T14:00:00Z', 'late import');

    const result = await getPortfolioHistory(
      { state, history: createHistoryRepo(state) },
      '1W', undefined, now,
    );

    expect(result.points).toEqual([
      { t: '2026-05-05T20:00:00Z', value: 1500, costBasis: 1200 },
      { t: '2026-05-06T13:00:00Z', value: 1520, costBasis: 1200, unreliable: true },
      { t: '2026-05-06T15:00:00Z', value: 1540, costBasis: 1200 },
    ]);
    expect(result.approximate).toBe(true);
    expect(result.reliability).toEqual({
      totalPoints: 3,
      unreliablePoints: 1,
      latestReliableFrom: '2026-05-06T15:00:00Z',
    });
    expect(result.summary).toEqual({
      startValue: 1540,
      endValue: 1540,
      change: 0,
      changePercent: 0,
    });
    expect(result.approximationReasons[0]).toMatch(/1 captured snapshot.*unverified context/);
  });

  it('does not apply another account invalidation to an account-scoped chart', async () => {
    insertSnapshot({ accountId: 'a1', takenAt: '2026-05-06T13:00:00Z', marketValue: 1000, costBasis: 800, cashBalance: 100 });
    insertSnapshot({ accountId: 'a2', takenAt: '2026-05-06T13:00:00Z', marketValue: 500, costBasis: 400, cashBalance: 50 });
    state.internalGetDb().prepare(
      `INSERT INTO account_history_invalidations
        (account_id, effective_date, detected_at, reason)
       VALUES (?, ?, ?, ?)`,
    ).run('a2', '2026-05-06', '2026-05-06T14:00:00Z', 'late import');

    const result = await getPortfolioHistory(
      { state, history: createHistoryRepo(state) },
      '1D', ['a1'], now,
    );

    expect(result.points).toEqual([
      { t: '2026-05-06T13:00:00Z', value: 1000, costBasis: 800 },
    ]);
    expect(result.approximate).toBe(false);
  });

  it('does not replace fully unreliable captured snapshots with a current-holdings backtest', async () => {
    insertSnapshot({ accountId: 'a1', takenAt: '2026-05-06T13:00:00Z', marketValue: 1000, costBasis: 800, cashBalance: 100 });
    state.internalGetDb().prepare(
      `INSERT INTO account_history_invalidations
        (account_id, effective_date, detected_at, reason)
       VALUES (?, ?, ?, ?)`,
    ).run('a1', '2026-05-06', '2026-05-06T14:00:00Z', 'late import');

    const result = await getPortfolioHistory(
      { state, history: createHistoryRepo(state) },
      '1W', ['a1'], now,
    );

    expect(result.source).toBe('snapshots');
    expect(result.valueMethod).toBe('observed_snapshot');
    expect(result.points).toEqual([
      { t: '2026-05-06T13:00:00Z', value: 1000, costBasis: 800, unreliable: true },
    ]);
    expect(result.approximate).toBe(true);
    expect(result.reliability).toEqual({
      totalPoints: 1,
      unreliablePoints: 1,
      latestReliableFrom: null,
    });
    expect(result.summary).toEqual({ startValue: 0, endValue: 0, change: 0, changePercent: 0 });
    expect(result.approximationReasons[0]).toMatch(/unverified context/);
  });

  it('filters by accountIds when provided', async () => {
    insertSnapshot({ accountId: 'a1', takenAt: '2026-05-06T13:00:00Z', marketValue: 1000, costBasis: 800, cashBalance: 100 });
    insertSnapshot({ accountId: 'a2', takenAt: '2026-05-06T13:00:00Z', marketValue: 500,  costBasis: 400, cashBalance: 50  });

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state) },
      '1D', ['a1'], now,
    );
    expect(r.points).toHaveLength(1);
    expect(r.points[0].value).toBe(1000);
  });

  it('returns empty points when there are no snapshots in range', async () => {
    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state) },
      '1D', undefined, now,
    );
    expect(r.supported).toBe(true);
    expect(r.points).toHaveLength(0);
    expect(r.source).toBe('none');
    expect(r.approximate).toBe(false);
    expect(r.trackingSince).toBeUndefined();
  });

  it('excludes snapshots older than 24 hours', async () => {
    insertSnapshot({ accountId: 'a1', takenAt: '2026-05-04T13:00:00Z', marketValue: 999, costBasis: 0, cashBalance: 0 });
    insertSnapshot({ accountId: 'a1', takenAt: '2026-05-06T13:00:00Z', marketValue: 1000, costBasis: 0, cashBalance: 0 });

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state) },
      '1D', undefined, now,
    );
    // Only the recent snapshot is in the 1D window. trackingSince still
    // points to the earliest row ever (the older one) so the UI can render
    // "tracking since May 4" if it wants.
    expect(r.points).toHaveLength(1);
    expect(r.points[0].value).toBe(1000);
    expect(r.trackingSince).toBe('2026-05-04T13:00:00Z');
  });

  it('filters isolated bad snapshot ticks', async () => {
    const values = [1000, 1010, 1020, 480, 1030, 1040, 1050, 1060, 1070];
    values.forEach((marketValue, i) => {
      insertSnapshot({
        accountId: 'a1',
        takenAt: `2026-05-06T13:${String(i * 5).padStart(2, '0')}:00Z`,
        marketValue,
        costBasis: 800,
        cashBalance: 100,
      });
    });

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state) },
      '1D', ['a1'], now,
    );
    expect(r.points.map((p) => p.value)).not.toContain(480);
    expect(r.points).toHaveLength(values.length - 1);
    expect(r.approximationReasons).toContain('filtered 1 isolated snapshot outlier');
  });

  it('trims a leading partial household tick from the 1D series', async () => {
    const normalValues = Array.from({ length: 24 }, (_, index) => 1_120_000 + index * 1_000);
    const values = [119_169.55, ...normalValues];
    const baseTime = Date.parse('2026-05-06T13:00:00Z');
    values.forEach((marketValue, index) => {
      insertSnapshot({
        accountId: 'a1',
        takenAt: new Date(baseTime + index * 5 * 60_000).toISOString(),
        marketValue,
        costBasis: index === 0 ? 119_169.55 : 974_860.65,
        cashBalance: 119_169.55,
      });
    });

    const result = await getPortfolioHistory(
      { state, history: createHistoryRepo(state) },
      '1D', ['a1'], now,
    );
    expect(result.points).toHaveLength(normalValues.length);
    expect(result.points[0].value).toBe(normalValues[0]);
    expect(result.points.map((point) => point.value)).not.toContain(119_169.55);
    expect(result.summary.change).toBe(23_000);
    expect(result.summary.changePercent).toBeCloseTo((23_000 / 1_120_000) * 100, 8);
    expect(result.approximationReasons).toContain('trimmed 1 leading partial snapshot');
  });

  it('removes an interior cash-only tick without discarding earlier valid 1D history', async () => {
    const normalBefore = Array.from({ length: 8 }, (_, index) => 1_120_000 + index * 1_000);
    const normalAfter = Array.from({ length: 16 }, (_, index) => 1_128_000 + index * 1_000);
    const values = [...normalBefore, 119_169.55, ...normalAfter];
    const baseTime = Date.parse('2026-05-06T13:00:00Z');
    values.forEach((marketValue, index) => {
      const partial = marketValue === 119_169.55;
      insertSnapshot({
        accountId: 'a1',
        takenAt: new Date(baseTime + index * 5 * 60_000).toISOString(),
        marketValue,
        costBasis: partial ? 119_169.55 : 974_860.65,
        cashBalance: 119_169.55,
      });
    });

    const result = await getPortfolioHistory(
      { state, history: createHistoryRepo(state) },
      '1D', ['a1'], now,
    );
    expect(result.points).toHaveLength(normalBefore.length + normalAfter.length);
    expect(result.points[0].value).toBe(normalBefore[0]);
    expect(result.points.map((point) => point.value)).not.toContain(119_169.55);
    expect(result.approximationReasons).toContain('filtered 1 isolated snapshot outlier');
    expect(result.approximationReasons.some((reason) => reason.includes('leading partial'))).toBe(false);
  });

  it('preserves a legitimate large deposit in the 1D series', async () => {
    const values = [
      { marketValue: 1_000_000, costBasis: 850_000, cashBalance: 100_000 },
      ...Array.from({ length: 24 }, (_, index) => ({
        marketValue: 1_500_000 + index * 1_000,
        costBasis: 1_350_000,
        cashBalance: 600_000,
      })),
    ];
    const baseTime = Date.parse('2026-05-06T13:00:00Z');
    values.forEach((point, index) => {
      insertSnapshot({
        accountId: 'a1',
        takenAt: new Date(baseTime + index * 5 * 60_000).toISOString(),
        ...point,
      });
    });

    const result = await getPortfolioHistory(
      { state, history: createHistoryRepo(state) },
      '1D', ['a1'], now,
    );
    expect(result.points[0].value).toBe(1_000_000);
    expect(result.approximationReasons.some((reason) => reason.includes('leading partial'))).toBe(false);
  });

  it('preserves a legitimate all-cash deposit in the 1D series', async () => {
    const values = [100_000, ...Array.from({ length: 24 }, (_, index) => 1_000_000 + index * 1_000)];
    const baseTime = Date.parse('2026-05-06T13:00:00Z');
    values.forEach((value, index) => {
      insertSnapshot({
        accountId: 'a1',
        takenAt: new Date(baseTime + index * 5 * 60_000).toISOString(),
        marketValue: value,
        costBasis: value,
        cashBalance: value,
      });
    });

    const result = await getPortfolioHistory(
      { state, history: createHistoryRepo(state) },
      '1D', ['a1'], now,
    );
    expect(result.points).toHaveLength(values.length);
    expect(result.points[0].value).toBe(100_000);
    expect(result.approximationReasons.some((reason) => reason.includes('leading partial'))).toBe(false);
  });

  it('trims leading partial snapshot era on recent multi-day ranges', async () => {
    const values = [
      650, 655, 652, 660,
      1100, 1110, 1115, 1120, 1122, 1125, 1130, 1132,
      1134, 1136, 1138, 1140, 1142, 1144, 1146, 1148,
      1150, 1152, 1154, 1156,
    ];
    const baseTime = Date.parse('2026-05-06T13:00:00Z');
    values.forEach((marketValue, i) => {
      insertSnapshot({
        accountId: 'a1',
        takenAt: new Date(baseTime + i * 5 * 60_000).toISOString(),
        marketValue,
        costBasis: 800,
        cashBalance: 100,
      });
    });

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state) },
      '1W', ['a1'], now,
    );
    expect(r.points[0].value).toBe(1100);
    expect(r.points.map((p) => p.value)).not.toContain(650);
    expect(r.approximationReasons).toContain('trimmed 4 leading partial snapshots');
  });

  it('collapses long stale flat snapshot runs on recent multi-day ranges', async () => {
    const values = [
      1000, 1005, 1010,
      1010, 1010, 1010, 1010, 1010, 1010, 1010, 1010, 1010, 1010, 1010, 1010,
      1020, 1025, 1030, 1035, 1040,
    ];
    const baseTime = Date.parse('2026-05-06T13:00:00Z');
    values.forEach((marketValue, i) => {
      insertSnapshot({
        accountId: 'a1',
        takenAt: new Date(baseTime + i * 5 * 60_000).toISOString(),
        marketValue,
        costBasis: 800,
        cashBalance: 100,
      });
    });

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state) },
      '1W', ['a1'], now,
    );
    expect(r.points.length).toBeLessThan(values.length);
    expect(r.approximationReasons.some((reason) => reason.includes('stale flat snapshot'))).toBe(true);
  });

  it('preserves the latest timestamp when a long flat run reaches the range tail', async () => {
    const baseTime = Date.parse('2026-05-06T13:00:00Z');
    Array.from({ length: 20 }, (_, index) => index < 3 ? 1000 + index * 5 : 1010)
      .forEach((marketValue, index) => {
        insertSnapshot({
          accountId: 'a1',
          takenAt: new Date(baseTime + index * 5 * 60_000).toISOString(),
          marketValue,
          costBasis: 800,
          cashBalance: 100,
        });
      });

    const result = await getPortfolioHistory(
      { state, history: createHistoryRepo(state) },
      '1W', ['a1'], now,
    );

    expect(result.points.at(-1)?.t).toBe(new Date(baseTime + 19 * 5 * 60_000).toISOString());
  });
});

describe('portfolioHistory — 1D with an import\'s own captures and gaps', () => {
  // Monday 2026-10-19 in New York (EDT, UTC−4): 9:30 AM is 13:30Z.
  const NINETEEN = Array.from({ length: 19 }, (_, index) => `a${index + 1}`);
  const IMPORTED = ['a1', 'a2', 'a3'];
  const deps = () => ({ state, history: createHistoryRepo(state) });
  const utc = (time: string) => `2026-10-19T${time}Z`;

  beforeEach(() => {
    for (const id of NINETEEN.slice(2)) state.createAccount({ id, name: id.toUpperCase(), cashBalance: 0, currency: 'USD' });
  });

  /** The snapshot job: every account at one moment. */
  function tick(takenAt: string, drift = 0) {
    for (const accountId of NINETEEN) {
      insertSnapshot({ accountId, takenAt, marketValue: 58_000 + drift, costBasis: 50_000, cashBalance: 1_000 });
    }
  }
  /** An import's own capture: only the accounts it read, at the capture time. */
  function importCapture(takenAt: string) {
    for (const accountId of IMPORTED) {
      insertSnapshot({ accountId, takenAt, marketValue: 57_000, costBasis: 50_000, cashBalance: 0 });
    }
  }
  const sessionTicks = (from: string, count: number) => Array.from(
    { length: count },
    (_, index) => new Date(Date.parse(from) + index * 5 * 60_000).toISOString(),
  );

  it('leaves out a capture of 3 of 19 accounts, in the middle of the session and as its last point', async () => {
    const ticks = sessionTicks(utc('13:30:00.000'), 24);
    ticks.forEach((takenAt, index) => tick(takenAt, index * 10));
    importCapture(utc('15:03:27.123'));
    importCapture(utc('15:26:41.000'));

    const result = await getPortfolioHistory(deps(), '1D', undefined, new Date(utc('15:27:00.000')));

    expect(result.points.map((point) => point.t)).toEqual(ticks);
    expect(Math.min(...result.points.map((point) => point.value))).toBe(19 * 58_000);
    expect(result.points.some((point) => point.gapBefore)).toBe(false);
    expect(result.summary.change).toBe(19 * 230);
    expect(result.approximationReasons).toContain('left out 2 snapshots that observed only some of the accounts');
  });

  it('shows a day like 10/19: ticks from 12:45 PM, two missed ticks as a gap, three imports left out', async () => {
    // Friday's ticks observed every account; on Monday, imports at 9:28:57 and 11:27:27 AM, ticks from
    // 12:45 PM with 1:30 and 1:35 PM missed while the API restarted, and a first-baseline capture at 1:58:58 PM.
    sessionTicks('2026-10-16T23:50:00.000Z', 2).forEach((takenAt) => tick(takenAt));
    importCapture(utc('13:28:57.000'));
    importCapture(utc('15:27:27.000'));
    const ticks = sessionTicks(utc('16:45:00.000'), 16)
      .filter((takenAt) => takenAt !== utc('17:30:00.000') && takenAt !== utc('17:35:00.000'));
    ticks.forEach((takenAt, index) => tick(takenAt, index * 7));
    importCapture(utc('17:58:58.000'));
    const now = new Date(utc('18:01:00.000'));

    const result = await getPortfolioHistory(deps(), '1D', undefined, now);

    expect(result.points.map((point) => point.t)).toEqual(ticks);
    expect(result.points.filter((point) => point.gapBefore).map((point) => point.t)).toEqual([utc('17:40:00.000')]);
    expect(result.summary).toMatchObject({ startValue: 19 * 58_000, change: 19 * 13 * 7 });
    expect(result.approximationReasons).toContain('left out 3 snapshots that observed only some of the accounts');

    // One missed tick is a sampling step, not a hole.
    tick(utc('17:35:00.000'), 50);
    const oneMissed = await getPortfolioHistory(deps(), '1D', undefined, now);
    expect(oneMissed.points.some((point) => point.gapBefore)).toBe(false);
  });

  it('keeps the capture in a chart of just the accounts it observed', async () => {
    const ticks = sessionTicks(utc('13:30:00.000'), 24);
    ticks.forEach((takenAt) => tick(takenAt));
    importCapture(utc('15:03:27.123'));

    const result = await getPortfolioHistory(deps(), '1D', IMPORTED, new Date(utc('15:27:00.000')));

    expect(result.points).toHaveLength(25);
    expect(result.points.find((point) => point.t === utc('15:03:27.123'))?.value).toBe(3 * 57_000);
    expect(result.approximationReasons.some((reason) => reason.includes('only some of the accounts'))).toBe(false);
  });

  it('shows the newest session in which every account was observed while today has only partial captures', async () => {
    // Friday's ticks; on Monday only an import's own captures, at 9:18 and 11:27 AM.
    sessionTicks('2026-10-16T13:30:00.000Z', 6).forEach((takenAt, index) => tick(takenAt, index));
    importCapture(utc('13:18:12.000'));
    importCapture(utc('15:27:05.000'));

    const result = await getPortfolioHistory(deps(), '1D', undefined, new Date(utc('15:28:00.000')));

    expect(result.coverage).toMatchObject({ requestedFrom: '2026-10-16', requestedTo: '2026-10-16' });
    expect(result.points).toHaveLength(6);
    expect(result.points.every((point) => point.t.startsWith('2026-10-16') && point.value >= 19 * 58_000)).toBe(true);
    expect(result.approximationReasons.some((reason) => reason.includes('only some of the accounts'))).toBe(false);
  });

  it('breaks the 1D line across a 9:28 → 11:22 gap and counts only the observed time', async () => {
    const before = [utc('13:18:00.000'), utc('13:23:00.000'), utc('13:28:00.000')];
    const after = [utc('15:22:00.000'), utc('15:27:00.000')];
    [...before, ...after].forEach((takenAt, index) => tick(takenAt, index * 100));

    const result = await getPortfolioHistory(deps(), '1D', undefined, new Date(utc('15:27:30.000')));

    expect(result.points.map((point) => point.t)).toEqual([...before, ...after]);
    expect(result.points.map((point) => Boolean(point.gapBefore))).toEqual([false, false, false, true, false]);
    // 9:18–9:33 and 11:22–11:27 of the 447 minutes since 4:00 AM, not 9:18 to 11:27.
    expect(result.coverage).toMatchObject({
      actualFrom: before[0], actualTo: after[1], complete: false, percent: 4.5,
    });
  });

  it('draws two lone observations as two points, not a line', async () => {
    tick(utc('13:28:00.000'));
    tick(utc('15:22:00.000'), -5_000);

    const result = await getPortfolioHistory(deps(), '1D', undefined, new Date(utc('15:27:00.000')));

    expect(result.points.map((point) => Boolean(point.gapBefore))).toEqual([false, true]);
    expect(result.coverage.percent).toBe(2.2);
  });

  it('does not call a session complete when its first and last points are on time but a gap lies between', async () => {
    tick(utc('08:00:00.000'));
    tick(utc('15:27:00.000'));

    const result = await getPortfolioHistory(deps(), '1D', undefined, new Date(utc('15:28:00.000')));

    // 4:00–4:05 and 11:27–11:28 of the 448 minutes since 4:00 AM.
    expect(result.coverage).toMatchObject({ complete: false, percent: 1.3 });
  });

  it('finds the previous session by its New York date when its last moments fall after UTC midnight (EST)', async () => {
    // Monday 2026-11-16, 7:30–7:55 PM EST, is 00:30–00:55 UTC on the 17th; on Tuesday only an import's capture.
    sessionTicks('2026-11-17T00:30:00.000Z', 6).forEach((takenAt) => tick(takenAt));
    importCapture('2026-11-17T14:18:00.000Z');

    const result = await getPortfolioHistory(deps(), '1D', undefined, new Date('2026-11-17T16:00:00.000Z'));

    expect(result.coverage).toMatchObject({ requestedFrom: '2026-11-16', requestedTo: '2026-11-16' });
    expect(result.points).toHaveLength(6);
  });
});

describe('portfolioHistory — a cash correction is a boundary for every chart', () => {
  const now = new Date('2026-10-19T12:15:00.000Z');
  const deps = () => ({ state, history: createHistoryRepo(state) });
  const correct = (reason: string) => state.internalGetDb().prepare(
    `INSERT INTO account_history_invalidations (account_id, effective_date, detected_at, reason)
     VALUES ('a1', '2026-10-19', '2026-10-19T12:00:00.000Z', ?)`,
  ).run(reason);

  beforeEach(() => {
    // Friday's ticks observe both accounts, with a1's old cash.
    for (const takenAt of ['2026-10-16T23:50:00.000Z', '2026-10-16T23:55:00.000Z']) {
      insertSnapshot({ accountId: 'a1', takenAt, marketValue: 1_000, costBasis: 900, cashBalance: 100 });
      insertSnapshot({ accountId: 'a2', takenAt, marketValue: 500, costBasis: 450, cashBalance: 50 });
    }
    // Monday's tick before the correction had no live quote for a2: a1's last observation, left out of the household.
    insertSnapshot({ accountId: 'a1', takenAt: '2026-10-19T11:55:00.000Z', marketValue: 1_000, costBasis: 900, cashBalance: 100 });
    // After the correction adopted 10 more cash for a1.
    for (const [takenAt, value] of [['2026-10-19T12:05:00.000Z', 1_010], ['2026-10-19T12:10:00.000Z', 1_010.5]] as const) {
      insertSnapshot({ accountId: 'a1', takenAt, marketValue: value, costBasis: 910, cashBalance: 110 });
      insertSnapshot({ accountId: 'a2', takenAt, marketValue: 500, costBasis: 450, cashBalance: 50 });
    }
  });

  it('starts where the chart last looked before it, when that is older than the account\'s own last observation', async () => {
    correct(FIDELITY_CASH_ADOPTED_REASON);

    const household = await getPortfolioHistory(deps(), '1W', undefined, now);
    expect(household.points.map((point) => [point.t, point.value, Boolean(point.unreliable)])).toEqual([
      ['2026-10-16T23:50:00.000Z', 1_500, true],
      ['2026-10-16T23:55:00.000Z', 1_500, true],
      ['2026-10-19T12:05:00.000Z', 1_510, false],
      ['2026-10-19T12:10:00.000Z', 1_510.5, false],
    ]);
    // Measured from the correction, not from Friday's figure with the old cash (that would be +10.50).
    expect(household.summary).toMatchObject({ startValue: 1_510, change: 0.5 });

    const account = await getPortfolioHistory(deps(), '1W', ['a1'], now);
    expect(account.points.map((point) => [point.t, Boolean(point.unreliable)])).toEqual([
      ['2026-10-16T23:50:00.000Z', false],
      ['2026-10-16T23:55:00.000Z', false],
      ['2026-10-19T11:55:00.000Z', true],
      ['2026-10-19T12:05:00.000Z', false],
      ['2026-10-19T12:10:00.000Z', false],
    ]);
    expect(account.summary).toMatchObject({ startValue: 1_010, change: 0.5 });

    // Monday's own 1D has nothing kept before the correction, so nothing to mark.
    const day = await getPortfolioHistory(deps(), '1D', undefined, now);
    expect(day.points.map((point) => [point.t, Boolean(point.unreliable)])).toEqual([
      ['2026-10-19T12:05:00.000Z', false],
      ['2026-10-19T12:10:00.000Z', false],
    ]);
  });

  it('leaves added activity at its own start, since the history before it was right', async () => {
    correct('late import');

    const household = await getPortfolioHistory(deps(), '1W', undefined, now);
    expect(household.points.some((point) => point.unreliable)).toBe(false);
    expect(household.summary).toMatchObject({ startValue: 1_500, change: 10.5 });
  });
});

describe('portfolioHistory — 1M observed resolution', () => {
  const now = new Date('2026-05-07T01:00:00Z');

  it('keeps only the last observed snapshot per New York market day', async () => {
    const snapshots = [
      ['2026-04-06T13:00:00.000Z', 1000],
      ['2026-04-06T20:00:00.000Z', 1010],
      ['2026-05-05T13:00:00.000Z', 1100],
      ['2026-05-05T20:00:00.000Z', 1110],
      ['2026-05-06T23:55:00.000Z', 1200],
      ['2026-05-07T00:30:00.000Z', 1210],
    ] as const;
    for (const [takenAt, marketValue] of snapshots) {
      insertSnapshot({
        accountId: 'a1',
        takenAt,
        marketValue,
        costBasis: 800,
        cashBalance: 100,
      });
    }

    const result = await getPortfolioHistory(
      { state, history: createHistoryRepo(state) },
      '1M', ['a1'], now,
    );
    expect(result.coverage.complete).toBe(true);
    expect(result.points.map((point) => [point.t, point.value])).toEqual([
      ['2026-04-06T20:00:00.000Z', 1010],
      ['2026-05-05T20:00:00.000Z', 1110],
      ['2026-05-07T00:30:00.000Z', 1210],
    ]);
  });

  it('compacts a dense month of intraday observations to one final value per market day', async () => {
    const firstDay = Date.parse('2026-06-10T13:00:00.000Z');
    for (let dayIndex = 0; dayIndex < 31; dayIndex++) {
      for (let pointIndex = 0; pointIndex < 12; pointIndex++) {
        insertSnapshot({
          accountId: 'a1',
          takenAt: new Date(firstDay + dayIndex * 86400_000 + pointIndex * 5 * 60_000).toISOString(),
          marketValue: 1_000_000 + dayIndex * 1_000 + pointIndex * 10,
          costBasis: 900_000,
          cashBalance: 100_000,
        });
      }
    }

    const result = await getPortfolioHistory(
      { state, history: createHistoryRepo(state) },
      '1M', ['a1'], new Date('2026-07-11T01:02:00Z'),
    );
    expect(result.points).toHaveLength(31);
    expect(result.points[0].value).toBe(1_000_110);
    expect(result.points.at(-1)?.value).toBe(1_030_110);
    expect(result.coverage).toMatchObject({ complete: true, percent: 100 });
  });

  it('reports complete coverage after UTC midnight while New York is still on the requested end day', async () => {
    insertSnapshot({
      accountId: 'a1', takenAt: '2026-06-10T01:00:00.000Z',
      marketValue: 900, costBasis: 800, cashBalance: 100,
    });
    insertSnapshot({
      accountId: 'a1', takenAt: '2026-06-10T13:00:00.000Z',
      marketValue: 1000, costBasis: 800, cashBalance: 100,
    });
    insertSnapshot({
      accountId: 'a1', takenAt: '2026-07-10T23:55:00.000Z',
      marketValue: 1100, costBasis: 800, cashBalance: 100,
    });

    const result = await getPortfolioHistory(
      { state, history: createHistoryRepo(state) },
      '1M', ['a1'], new Date('2026-07-11T01:02:00Z'),
    );
    expect(result.coverage).toEqual({
      requestedFrom: '2026-06-10',
      requestedTo: '2026-07-10',
      actualFrom: '2026-06-10T13:00:00.000Z',
      actualTo: '2026-07-10T23:55:00.000Z',
      complete: true,
      percent: 100,
    });
  });
});

describe('portfolioHistory — reconstruction (1W..1Y)', () => {
  const now = new Date('2026-05-06T20:00:00Z');

  /**
   * Stub quote provider for reconstruction tests. The service calls this to
   * replace the last point's daily-close with a live price; we route it to
   * the same close so tests stay deterministic and offline.
   */
  const fakeFetchQuotes = async (syms: string[]) =>
    syms.map((s) => {
      // Look up the latest seeded daily bar for this symbol.
      const row = state.internalGetDb()
        .prepare("SELECT close FROM symbol_price_bars WHERE symbol = ? AND range_kind = 'daily' ORDER BY t DESC LIMIT 1")
        .get(s) as { close: number } | undefined;
      return {
        symbol: s,
        price: row?.close ?? 0,
        currency: 'USD',
        asOf: Date.now(),
        source: 'nasdaq' as const,
      };
    });

  it('values each day from current holdings × historical close (cost basis from ledger)', async () => {
    // Account a1 buys 10 AAPL on May 1 @ $150. Today's holding = 10 AAPL.
    state.createTransaction({
      id: 't1', accountId: 'a1', symbol: 'AAPL', date: '2026-05-01',
      quantity: 10, pricePerUnit: 150, currency: 'USD',
    });
    // Daily bars for AAPL covering the 1W window. Price drifts from $145 → $160.
    seedDailyBar('AAPL', '2026-04-29', 145);
    seedDailyBar('AAPL', '2026-04-30', 148);
    seedDailyBar('AAPL', '2026-05-01', 150);
    seedDailyBar('AAPL', '2026-05-04', 152);
    seedDailyBar('AAPL', '2026-05-05', 155);
    seedDailyBar('AAPL', '2026-05-06', 160);

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state), fetchQuotes: fakeFetchQuotes },
      '1W', ['a1'], now,
    );
    expect(r.supported).toBe(true);
    expect(r.approximate).toBe(true);
    expect(r.source).toBe('reconstruction');
    expect(r.approximationReasons[0]).toMatch(/cash held at current balance/);
    expect(r.approximationReasons).toContain(
      "values use today's holdings at historical closes; intermediate buys and sells are not reflected",
    );
    expect(r.valueMethod).toBe('current_holdings_backtest');

    // Value series uses current holdings (10 AAPL) × historical close on EVERY day.
    const apr29 = r.points.find((p) => p.t === '2026-04-29');
    expect(apr29?.value).toBe(10 * 145 + 100);     // $1,550
    const apr30 = r.points.find((p) => p.t === '2026-04-30');
    expect(apr30?.value).toBe(10 * 148 + 100);     // $1,580
    const may1 = r.points.find((p) => p.t === '2026-05-01');
    expect(may1?.value).toBe(10 * 150 + 100);      // $1,600
    const may6 = r.points.find((p) => p.t === '2026-05-06');
    expect(may6?.value).toBe(10 * 160 + 100);      // $1,700

    // Cost basis still uses the ledger so it ramps in on the buy day.
    expect(apr29?.costBasis).toBe(100);            // pre-buy: cash only
    expect(apr30?.costBasis).toBe(100);            // pre-buy: cash only
    expect(may1?.costBasis).toBe(100 + 150 * 10);  // post-buy: cash + 10 × $150
    expect(may6?.costBasis).toBe(100 + 150 * 10);  // unchanged
  });

  it('always discloses current-holdings backtest semantics when snapshots are unavailable', async () => {
    state.createTransaction({
      id: 'old-tx', accountId: 'a1', symbol: 'AAPL', date: '2025-01-02',
      quantity: 2, pricePerUnit: 100, currency: 'USD',
    });
    seedDailyBar('AAPL', '2026-04-29', 140);
    seedDailyBar('AAPL', '2026-05-06', 160);

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state), fetchQuotes: fakeFetchQuotes },
      '1W', ['a1'], now,
    );

    expect(r.valueMethod).toBe('current_holdings_backtest');
    expect(r.approximationReasons).toContain(
      "values use today's holdings at historical closes; intermediate buys and sells are not reflected",
    );
  });

  it('discloses fully closed positions that are excluded from the current-holdings backtest', async () => {
    state.createTransaction({
      id: 'crdo-buy-1', accountId: 'a1', symbol: 'CRDO', date: '2026-04-30',
      quantity: 10, pricePerUnit: 200, currency: 'USD',
    });
    state.createTransaction({
      id: 'crdo-buy-2', accountId: 'a1', symbol: 'CRDO', date: '2026-05-01',
      quantity: 100, pricePerUnit: 210, currency: 'USD',
    });
    state.createTransaction({
      id: 'crdo-sell', accountId: 'a1', symbol: 'CRDO', date: '2026-05-04',
      quantity: -110, pricePerUnit: 235, currency: 'USD',
    });
    state.createTransaction({
      id: 'incomplete-buy', accountId: 'a1', symbol: 'INCOMPLETE', date: '2026-05-01',
      quantity: 1, pricePerUnit: 10, currency: 'USD',
    });
    state.createTransaction({
      id: 'incomplete-sell', accountId: 'a1', symbol: 'INCOMPLETE', date: '2026-05-04',
      quantity: -2, pricePerUnit: 12, currency: 'USD',
    });
    state.createTransaction({
      id: 'aapl-buy', accountId: 'a1', symbol: 'AAPL', date: '2026-04-30',
      quantity: 1, pricePerUnit: 100, currency: 'USD',
    });
    seedDailyBar('AAPL', '2026-04-29', 95);
    seedDailyBar('AAPL', '2026-05-06', 105);

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state), fetchQuotes: fakeFetchQuotes },
      '1W', ['a1'], now,
    );

    expect(r.valueMethod).toBe('current_holdings_backtest');
    expect(r.approximationReasons).toContain(
      'closed positions excluded from current-holdings backtest: CRDO',
    );
    expect(r.approximationReasons
      .filter((reason) => reason.startsWith('closed positions excluded'))
      .some((reason) => reason.includes('INCOMPLETE'))).toBe(false);
    expect(r.points.every((point) => point.value < 1_000)).toBe(true);
  });

  it('excludes open options from the current-holdings backtest with explicit disclosure', async () => {
    state.createTransaction({
      id: 'aapl-buy', accountId: 'a1', symbol: 'AAPL', date: '2026-04-30',
      quantity: 1, pricePerUnit: 100, currency: 'USD',
    });
    state.createTransaction({
      id: 'put-open', accountId: 'a1', symbol: 'NBIS260731P00165000', date: '2026-05-04',
      quantity: -1, pricePerUnit: 6, currency: 'USD',
      instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open',
    });
    seedDailyBar('AAPL', '2026-04-29', 95);
    seedDailyBar('AAPL', '2026-05-06', 105);

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state), fetchQuotes: fakeFetchQuotes },
      '1W', ['a1'], now,
    );
    expect(r.approximationReasons).toContain(
      "options excluded from current-holdings backtest: NBIS Jul 31 '26 $165 Put; current cash may already include option proceeds",
    );
    expect(r.approximationReasons.some((reason) => reason.includes('no price history available for NBIS260731'))).toBe(false);
    expect(r.points.find((point) => point.t === '2026-05-06')?.value).toBe(205);
  });

  it('carries forward last-known close across weekends', async () => {
    state.createTransaction({
      id: 't1', accountId: 'a1', symbol: 'AAPL', date: '2026-05-01',
      quantity: 1, pricePerUnit: 100, currency: 'USD',
    });
    seedDailyBar('AAPL', '2026-05-01', 100);   // Friday
    // No bar for Saturday/Sunday — the engine carries Friday's close.
    seedDailyBar('AAPL', '2026-05-04', 110);   // Monday

    // Pin `now` to Monday afternoon so latestWeekdayOnOrBefore matches our
    // latest seeded bar (2026-05-04) and getSymbolHistory's cache check is
    // satisfied without calling out to Nasdaq (which would replace our
    // seeded Friday value via replaceRecentBars).
    const monAfternoon = new Date('2026-05-04T20:00:00Z');
    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state), fetchQuotes: fakeFetchQuotes },
      '1W', ['a1'], monAfternoon,
    );
    // Saturday and Sunday are filtered (weekends not iterated). Friday and
    // the following Monday should both be present with correct closes.
    const fri = r.points.find((p) => p.t === '2026-05-01');
    const mon = r.points.find((p) => p.t === '2026-05-04');
    expect(fri?.value).toBe(100 + 100);        // 1 × 100 + cash
    expect(mon?.value).toBe(100 + 110);
  });

  it('flags missing-price symbols and drops them from value', async () => {
    state.createTransaction({
      id: 't1', accountId: 'a1', symbol: 'VANG500', date: '2026-05-01',
      quantity: 1, pricePerUnit: 100, currency: 'USD',
    });
    // No daily bars for VANG500. The mock symbolHistory provider chain
    // would normally try to fetch; we don't seed it, so getSymbolHistory
    // will attempt providers and (in the test environment without network)
    // either fail or return supported:false. Either way, the symbol drops
    // out of the value and a reason is recorded.
    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state), fetchQuotes: fakeFetchQuotes },
      '1W', ['a1'], now,
    );
    expect(r.supported).toBe(true);
    expect(r.approximate).toBe(true);
    // The reason set should mention VANG500 — either as "no price history"
    // or "fetch failed" depending on whether providers are reachable.
    expect(r.approximationReasons.some((s) => s.includes('VANG500'))).toBe(true);
    // Cash-only on every day for an unpriced position.
    expect(r.points.every((p) => p.value === 100)).toBe(true);
  });
});

describe('portfolioHistory — snapshot-first 1W selection', () => {
  const now = new Date('2026-07-10T16:00:00Z');

  it('keeps one observed snapshot instead of substituting a backtest', async () => {
    state.createTransaction({
      id: 't1', accountId: 'a1', symbol: 'AAPL', date: '2026-04-01',
      quantity: 1, pricePerUnit: 100, currency: 'USD',
    });
    insertSnapshot({
      accountId: 'a1', takenAt: '2026-07-08T20:00:00Z',
      marketValue: 1_000, costBasis: 800, cashBalance: 100,
    });
    seedDailyBar('AAPL', '2026-07-03', 90);

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state) },
      '1W', ['a1'], now,
    );

    expect(r.valueMethod).toBe('observed_snapshot');
    expect(r.source).toBe('snapshots');
    expect(r.points).toEqual([
      { t: '2026-07-08T20:00:00Z', value: 1_000, costBasis: 800 },
    ]);
    expect(r.coverage.complete).toBe(false);
  });

  it('returns only observed snapshots for a partially-covered 1W request', async () => {
    state.createTransaction({
      id: 't1', accountId: 'a1', symbol: 'AAPL', date: '2026-04-01',
      quantity: 1, pricePerUnit: 100, currency: 'USD',
    });
    insertSnapshot({
      accountId: 'a1', takenAt: '2026-07-08T20:00:00Z',
      marketValue: 1_000, costBasis: 800, cashBalance: 100,
    });
    insertSnapshot({
      accountId: 'a2', takenAt: '2026-07-08T20:00:00Z',
      marketValue: 500, costBasis: 400, cashBalance: 50,
    });
    insertSnapshot({
      accountId: 'a1', takenAt: '2026-07-09T20:00:00Z',
      marketValue: 1_020, costBasis: 800, cashBalance: 100,
    });
    insertSnapshot({
      accountId: 'a2', takenAt: '2026-07-09T20:00:00Z',
      marketValue: 510, costBasis: 400, cashBalance: 50,
    });

    seedDailyBar('AAPL', '2026-07-03', 90);
    seedDailyBar('AAPL', '2026-07-10', 110);
    const fakeFetchQuotes = async (symbols: string[]) => symbols.map((symbol) => ({
      symbol,
      price: 110,
      currency: 'USD',
      asOf: now.getTime(),
      source: 'nasdaq' as const,
    }));

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state), fetchQuotes: fakeFetchQuotes },
      '1W', undefined, now,
    );

    expect(r.source).toBe('snapshots');
    expect(r.valueMethod).toBe('observed_snapshot');
    expect(r.points).toEqual([
      { t: '2026-07-08T20:00:00Z', value: 1_500, costBasis: 1_200 },
      { t: '2026-07-09T20:00:00Z', value: 1_530, costBasis: 1_200 },
    ]);
    expect(r.from).toBe('2026-07-08');
    expect(r.coverage).toMatchObject({
      requestedFrom: '2026-07-03',
      requestedTo: '2026-07-10',
      actualFrom: '2026-07-08T20:00:00Z',
      actualTo: '2026-07-09T20:00:00Z',
      complete: false,
    });
    expect(r.referenceSeries).toMatchObject({
      valueMethod: 'current_holdings_backtest',
      label: 'Current holdings backtest',
    });
    expect(r.referenceSeries?.points[0].t).toBe('2026-07-03');
    expect(r.referenceSeries?.points.at(-1)?.t).toBe('2026-07-10');

    const scoped = await getPortfolioHistory(
      { state, history: createHistoryRepo(state), fetchQuotes: fakeFetchQuotes },
      '1W', ['a1'], now,
    );
    expect(scoped.valueMethod).toBe('observed_snapshot');
    expect(scoped.points).toEqual([
      { t: '2026-07-08T20:00:00Z', value: 1_000, costBasis: 800 },
      { t: '2026-07-09T20:00:00Z', value: 1_020, costBasis: 800 },
    ]);
    expect(scoped.referenceSeries?.valueMethod).toBe('current_holdings_backtest');
  });
});

describe('portfolioHistory — 1W session coverage', () => {
  function snapshotWeekdays(days: string[]) {
    days.forEach((day, index) => {
      insertSnapshot({ accountId: 'a1', takenAt: `${day}T13:00:00.000Z`, marketValue: 1_000 + index * 10, costBasis: 800, cashBalance: 100 });
      insertSnapshot({ accountId: 'a1', takenAt: `${day}T20:00:00.000Z`, marketValue: 1_005 + index * 10, costBasis: 800, cashBalance: 100 });
    });
  }
  const week = ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10'];
  const deps = () => ({ state, history: createHistoryRepo(state), fetchQuotes: async () => [] });

  it('treats a weekend week with every session observed as complete', async () => {
    snapshotWeekdays(week);

    const r = await getPortfolioHistory(deps(), '1W', ['a1'], new Date('2026-07-11T16:00:00Z'));

    expect(r.coverage).toMatchObject({ requestedFrom: '2026-07-04', requestedTo: '2026-07-11', complete: true, percent: 100 });
    expect(r.referenceSeries).toBeUndefined();
  });

  it("does not count the hours before today's session as missing", async () => {
    snapshotWeekdays(week);

    const beforeOpen = await getPortfolioHistory(deps(), '1W', ['a1'], new Date('2026-07-13T07:00:00Z'));
    expect(beforeOpen.coverage).toMatchObject({ requestedFrom: '2026-07-06', requestedTo: '2026-07-13', complete: true });

    // Once the session is under way, a day without snapshots is missing.
    const afterOpen = await getPortfolioHistory(deps(), '1W', ['a1'], new Date('2026-07-13T14:00:00Z'));
    expect(afterOpen.coverage.complete).toBe(false);
    expect(afterOpen.coverage.percent).toBe(83.3);
  });

  it('reports a missing first session as partial coverage', async () => {
    snapshotWeekdays(week.slice(1));

    const r = await getPortfolioHistory(deps(), '1W', ['a1'], new Date('2026-07-11T16:00:00Z'));

    expect(r.coverage).toMatchObject({ complete: false, percent: 80, actualFrom: '2026-07-07T13:00:00.000Z' });
  });

  it("starts expecting today's session at 04:05 New York time in summer and winter", async () => {
    snapshotWeekdays(week);
    const sunday = await getPortfolioHistory(deps(), '1W', ['a1'], new Date('2026-07-12T16:00:00Z'));
    expect(sunday.coverage.complete).toBe(true);
    // 04:04 / 04:05 EDT on Monday.
    expect((await getPortfolioHistory(deps(), '1W', ['a1'], new Date('2026-07-13T08:04:00Z'))).coverage.complete).toBe(true);
    expect((await getPortfolioHistory(deps(), '1W', ['a1'], new Date('2026-07-13T08:05:00Z'))).coverage.complete).toBe(false);

    snapshotWeekdays(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']);
    // 04:04 / 04:05 EST on Monday, after daylight saving time ends.
    expect((await getPortfolioHistory(deps(), '1W', ['a1'], new Date('2026-11-09T09:04:00Z'))).coverage.complete).toBe(true);
    expect((await getPortfolioHistory(deps(), '1W', ['a1'], new Date('2026-11-09T09:05:00Z'))).coverage.complete).toBe(false);
  });
});

describe('portfolioHistory — ledger replay (1M..ALL)', () => {
  const now = new Date('2026-07-10T16:00:00Z');
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Every test seeds complete bars; any provider call is a test failure.
    fetchMock = vi.fn().mockRejectedValue(new Error('network disabled in tests'));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function seedWeekdays(symbol: string, from: string, to: string, closeOn: (day: string) => number) {
    for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
      const day = d.toISOString().slice(0, 10);
      seedDailyBar(symbol, day, closeOn(day));
    }
  }

  const quotes = (prices: Record<string, number>) => async (symbols: string[]) => symbols.map((symbol) => ({
    symbol,
    price: prices[symbol] ?? 0,
    currency: 'USD',
    asOf: now.getTime(),
    source: 'nasdaq' as const,
  }));

  const valueAt = (points: Array<{ t: string; value: number }>, t: string) => (
    points.find((point) => point.t === t)?.value
  );

  it('replays buys and sells on their own dates instead of backtesting today\'s holdings', async () => {
    state.createTransaction({
      id: 'b1', accountId: 'a1', symbol: 'AAPL', date: '2026-06-01',
      quantity: 10, pricePerUnit: 100, currency: 'USD',
    });
    state.createTransaction({
      id: 's1', accountId: 'a1', symbol: 'AAPL', date: '2026-06-15',
      quantity: -4, pricePerUnit: 120, currency: 'USD',
    });
    state.createTransaction({
      id: 'b2', accountId: 'a1', symbol: 'MSFT', date: '2026-06-22',
      quantity: 5, pricePerUnit: 200, currency: 'USD',
    });
    insertSnapshot({
      accountId: 'a1', takenAt: '2026-07-01T20:00:00Z',
      marketValue: 99_999, costBasis: 1, cashBalance: 100,
    });
    seedWeekdays('AAPL', '2026-04-01', '2026-07-10', (day) => (day < '2026-06-15' ? 100 : 120));
    seedWeekdays('MSFT', '2026-04-01', '2026-07-10', () => 200);

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state), fetchQuotes: quotes({ AAPL: 125, MSFT: 210 }) },
      '1M', ['a1'], now,
    );

    expect(r.valueMethod).toBe('ledger_estimate');
    expect(r.source).toBe('reconstruction');
    expect(r.approximate).toBe(true);
    expect(r.referenceSeries).toBeUndefined();
    expect(r.points[0].t).toBe('2026-06-10');
    expect(valueAt(r.points, '2026-06-12')).toBe(10 * 100 + 100);
    expect(valueAt(r.points, '2026-06-15')).toBe(6 * 120 + 100);
    expect(valueAt(r.points, '2026-06-22')).toBe(6 * 120 + 5 * 200 + 100);
    // A captured snapshot never replaces the replayed value.
    expect(valueAt(r.points, '2026-07-01')).toBe(6 * 120 + 5 * 200 + 100);
    expect(r.points.at(-1)).toEqual({ t: '2026-07-10', value: 6 * 125 + 5 * 210 + 100, costBasis: expect.any(Number) });
    expect(r.coverage.complete).toBe(true);
    expect(r.approximationReasons).toContain('cash held at current balance (no broker cash history): A1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('values cash from broker end-of-day balances and holds the earliest one before history starts', async () => {
    state.createAccount({ id: 'c1', name: 'C1', cashBalance: 1_480, currency: 'USD', accountNumber: 'X-1234' });
    state.createTransaction({
      id: 'c1-buy', accountId: 'c1', symbol: 'AAPL', date: '2026-06-01',
      quantity: 10, pricePerUnit: 100, currency: 'USD',
    });
    state.createTransaction({
      id: 'c1-sell', accountId: 'c1', symbol: 'AAPL', date: '2026-06-15',
      quantity: -4, pricePerUnit: 120, currency: 'USD',
    });
    state.importCashHistory({
      accountId: 'c1', currency: 'USD', broker: 'fidelity', accountLast4: '1234',
      sourceHash: 'a'.repeat(64), method: 'test-eod-v1',
      rows: [
        { date: '2026-06-12', cashBalance: 1_000 },
        { date: '2026-06-15', cashBalance: 1_480 },
      ],
    });
    seedWeekdays('AAPL', '2026-04-01', '2026-07-10', (day) => (day < '2026-06-15' ? 100 : 120));

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state), fetchQuotes: quotes({ AAPL: 125 }) },
      '1M', ['c1'], now,
    );

    expect(valueAt(r.points, '2026-06-10')).toBe(10 * 100 + 1_000);
    expect(valueAt(r.points, '2026-06-12')).toBe(10 * 100 + 1_000);
    expect(valueAt(r.points, '2026-06-15')).toBe(6 * 120 + 1_480);
    expect(r.points.at(-1)?.value).toBe(6 * 125 + 1_480);
    expect(r.approximationReasons).toContain('cash uses broker end-of-day balances for 1 account');
    expect(r.approximationReasons).toContain(
      'cash before broker history held at the earliest known balance: C1 (before 2026-06-12)',
    );
  });

  it('keeps the household equal to the sum of its accounts on every date', async () => {
    state.createTransaction({
      id: 'a1-buy', accountId: 'a1', symbol: 'AAPL', date: '2026-06-01',
      quantity: 10, pricePerUnit: 100, currency: 'USD',
    });
    state.createTransaction({
      id: 'a2-buy', accountId: 'a2', symbol: 'MSFT', date: '2026-06-20',
      quantity: 3, pricePerUnit: 200, currency: 'USD',
    });
    seedWeekdays('AAPL', '2026-04-01', '2026-07-10', (day) => (day < '2026-06-15' ? 100 : 120));
    seedWeekdays('MSFT', '2026-04-01', '2026-07-10', (day) => (day < '2026-07-01' ? 200 : 190));
    const deps = { state, history: createHistoryRepo(state), fetchQuotes: quotes({ AAPL: 125, MSFT: 210 }) };

    const household = await getPortfolioHistory(deps, '1M', undefined, now);
    const one = await getPortfolioHistory(deps, '1M', ['a1'], now);
    const two = await getPortfolioHistory(deps, '1M', ['a2'], now);

    expect(household.points[0].t).toBe('2026-06-10');
    expect(two.points[0].t).toBe('2026-06-22');
    for (const point of household.points) {
      const expected = (valueAt(one.points, point.t) ?? 0) + (valueAt(two.points, point.t) ?? 0);
      expect(point.value).toBeCloseTo(expected, 2);
    }
    expect(household.points.at(-1)?.value).toBe(10 * 125 + 100 + 3 * 210 + 50);
    expect(household.approximationReasons).toContain(
      'accounts join on their first recorded activity (or when added): A2 (2026-06-20)',
    );
  });

  it('starts imported holdings on their own date and ignores snapshot rows superseded by activity', async () => {
    state.createTransaction({
      id: 'activity', accountId: 'a1', symbol: 'AAPL', date: '2026-06-01',
      quantity: 10, pricePerUnit: 100, currency: 'USD', sourceFingerprint: 'f'.repeat(64),
    });
    state.createTransaction({
      id: 'snapshot', accountId: 'a1', symbol: 'AAPL', date: '2026-06-25',
      quantity: 10, pricePerUnit: 100, currency: 'USD', sourceFingerprint: 'pos:AAPL',
    });
    state.createTransaction({
      id: 'seed', accountId: 'a2', symbol: 'MSFT', date: '2026-06-24',
      quantity: 2, pricePerUnit: 200, currency: 'USD', notes: 'imported from broker screenshot',
    });
    seedWeekdays('AAPL', '2026-04-01', '2026-07-10', () => 120);
    seedWeekdays('MSFT', '2026-04-01', '2026-07-10', () => 200);

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state), fetchQuotes: quotes({ AAPL: 120, MSFT: 200 }) },
      '1M', undefined, now,
    );

    expect(valueAt(r.points, '2026-06-23')).toBe(10 * 120 + 100);
    expect(valueAt(r.points, '2026-06-24')).toBe(10 * 120 + 100 + 2 * 200 + 50);
    expect(valueAt(r.points, '2026-06-26')).toBe(10 * 120 + 100 + 2 * 200 + 50);
    expect(r.approximationReasons).toContain(
      'holdings imported without trade history appear on their import date: A2 (2026-06-24)',
    );
  });

  it('values open options at intrinsic value on past dates and at the live mark on the last point', async () => {
    state.createTransaction({
      id: 'put-open', accountId: 'a1', symbol: 'NBIS260918P00100000', date: '2026-06-15',
      quantity: -1, pricePerUnit: 5, fees: 1, currency: 'USD',
      instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open',
    });
    seedWeekdays('NBIS', '2026-04-01', '2026-07-10', (day) => (day < '2026-06-17' ? 110 : 90));

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state), fetchQuotes: quotes({ NBIS260918P00100000: 12 }) },
      '1M', ['a1'], now,
    );

    expect(r.points[0].t).toBe('2026-06-15');
    expect(valueAt(r.points, '2026-06-15')).toBe(100);
    expect(valueAt(r.points, '2026-06-17')).toBe(100 - 100 * 10);
    expect(r.points.at(-1)?.value).toBe(100 - 100 * 12);
    expect(r.approximationReasons.some((reason) => (
      reason.startsWith('options valued at intrinsic value on past dates: NBIS')
    ))).toBe(true);
  });

  it('marks a holding at its trade price until the first daily close exists', async () => {
    state.createTransaction({
      id: 'ipo', accountId: 'a1', symbol: 'NEWCO', date: '2026-06-10',
      quantity: 4, pricePerUnit: 50, currency: 'USD',
    });
    seedWeekdays('NEWCO', '2026-06-15', '2026-07-10', () => 60);

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state), fetchQuotes: quotes({ NEWCO: 60 }) },
      '1M', ['a1'], now,
    );

    expect(valueAt(r.points, '2026-06-12')).toBe(4 * 50 + 100);
    expect(valueAt(r.points, '2026-06-15')).toBe(4 * 60 + 100);
    expect(r.approximationReasons).toContain('valued at the last trade price where no daily close exists: NEWCO');
  });

  it('returns identical values for the same dates across overlapping ranges', async () => {
    state.createTransaction({
      id: 'b1', accountId: 'a1', symbol: 'AAPL', date: '2026-03-02',
      quantity: 10, pricePerUnit: 100, currency: 'USD',
    });
    seedWeekdays('AAPL', '2026-01-01', '2026-07-10', (day) => 100 + Number(day.slice(8, 10)));
    const deps = { state, history: createHistoryRepo(state), fetchQuotes: quotes({ AAPL: 111 }) };

    const month = await getPortfolioHistory(deps, '1M', ['a1'], now);
    const quarter = await getPortfolioHistory(deps, '3M', ['a1'], now);
    for (const point of month.points.slice(0, -1)) {
      expect(valueAt(quarter.points, point.t)).toBe(point.value);
    }
  });

  it('never lets an account without ledger rows define the start of ALL', async () => {
    // Legacy rows can have no creation timestamp: such an account has no
    // evidence of when it began, so it contributes its cash on every day
    // without stretching ALL back to an arbitrary epoch.
    state.internalGetDb().prepare("UPDATE accounts SET created_at = '' WHERE id = 'a2'").run();
    state.createTransaction({
      id: 'b1', accountId: 'a1', symbol: 'AAPL', date: '2026-06-01',
      quantity: 1, pricePerUnit: 100, currency: 'USD',
    });
    seedWeekdays('AAPL', '2026-04-01', '2026-07-10', () => 100);
    const saturday = new Date('2026-07-11T16:00:00Z');

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state), fetchQuotes: quotes({ AAPL: 100 }) },
      'ALL', undefined, saturday,
    );

    expect(r.points[0].t).toBe('2026-06-01');
    expect(r.points.at(-1)?.t).toBe('2026-07-10');
    expect(valueAt(r.points, '2026-06-01')).toBe(100 + 100 + 50);
    expect(r.coverage.complete).toBe(true);
    expect(r.approximationReasons).toContain('cash held at current balance (no broker cash history): A1, A2');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('switches to the current balance at the first trade after the broker cash history, as approximate cash', async () => {
    state.createAccount({ id: 'c2', name: 'C2', cashBalance: 280, currency: 'USD', accountNumber: 'X-5678' });
    state.createTransaction({
      id: 'c2-buy', accountId: 'c2', symbol: 'AAPL', date: '2026-06-01',
      quantity: 10, pricePerUnit: 100, currency: 'USD',
    });
    state.importCashHistory({
      accountId: 'c2', currency: 'USD', broker: 'fidelity', accountLast4: '5678',
      sourceHash: 'b'.repeat(64), method: 'test-eod-v1',
      rows: [{ date: '2026-06-01', cashBalance: 1_000 }],
    });
    // A later sync records a buy the stored broker history does not cover.
    state.createTransaction({
      id: 'c2-buy-2', accountId: 'c2', symbol: 'AAPL', date: '2026-06-22',
      quantity: 6, pricePerUnit: 120, currency: 'USD',
    });
    seedWeekdays('AAPL', '2026-04-01', '2026-07-10', () => 120);

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state), fetchQuotes: quotes({ AAPL: 120 }) },
      '1M', ['c2'], now,
    );

    expect(valueAt(r.points, '2026-06-19')).toBe(10 * 120 + 1_000);
    // Never both the new shares and the cash that paid for them.
    expect(valueAt(r.points, '2026-06-22')).toBe(16 * 120 + 280);
    // The trade day is approximate context; the period change starts after it, never across the switch.
    expect(r.points.filter((point) => point.unreliable).map((point) => point.t)).toEqual(['2026-06-22']);
    expect(r.reliability).toEqual({ totalPoints: r.points.length, unreliablePoints: 1, latestReliableFrom: '2026-06-23' });
    expect(r.summary).toMatchObject({ startValue: 16 * 120 + 280, change: 0 });
    expect(r.approximationReasons).toContain(
      "cash around trades or sweeps the broker cash history doesn't cover yet is today's balance less later cash events, shown as approximate and never the start of a period change: C2 (2026-06-22 to 2026-06-22)",
    );
  });

  describe('cash after the broker history ends', () => {
    /** An account holding 10 SYNA at a flat 100 since 06-01, whose broker cash history ends that day at 1,000. */
    function brokerHistoryUntilJune1(id: string, cashBalance: number) {
      state.createAccount({ id, name: id.toUpperCase(), cashBalance, currency: 'USD', accountNumber: `X-${id}` });
      state.createTransaction({
        id: `${id}-buy`, accountId: id, symbol: 'SYNA', date: '2026-06-01',
        quantity: 10, pricePerUnit: 100, currency: 'USD',
      });
      state.importCashHistory({
        accountId: id, currency: 'USD', broker: 'fidelity', accountLast4: id.replace(/\D/g, '').padStart(4, '0'),
        sourceHash: Buffer.from(id).toString('hex').padEnd(64, 'f'), method: 'test-eod-v1',
        rows: [{ date: '2026-06-01', cashBalance: 1_000 }],
      });
      seedWeekdays('SYNA', '2026-04-01', '2026-07-10', () => 100);
    }
    const adopted = (accountId: string, detectedAt: string) => state.internalGetDb().prepare(
      `INSERT INTO account_history_invalidations (account_id, effective_date, detected_at, reason)
       VALUES (?, ?, ?, ?)`,
    ).run(accountId, detectedAt.slice(0, 10), detectedAt, FIDELITY_CASH_ADOPTED_REASON);
    const deps = () => ({ state, history: createHistoryRepo(state), fetchQuotes: quotes({ SYNA: 100 }) });
    const historyRows = () => state.internalGetDb().prepare('SELECT COUNT(*) FROM account_cash_history').pluck().get();

    it('follows the recorded cash events when they reach today\'s balance, and stores nothing', async () => {
      brokerHistoryUntilJune1('d1', 850);
      insertCashEvent('d1', '2026-06-15', 'dividend', 50);
      insertCashEvent('d1', '2026-06-24', 'tax', -200);
      const rowsBefore = historyRows();

      const r = await getPortfolioHistory(deps(), '1M', ['d1'], now);

      expect(valueAt(r.points, '2026-06-12')).toBe(1_000 + 1_000);
      expect(valueAt(r.points, '2026-06-15')).toBe(1_000 + 1_050);
      expect(valueAt(r.points, '2026-06-24')).toBe(1_000 + 850);
      expect(r.points.at(-1)?.value).toBe(1_000 + 850);
      expect(r.points.some((point) => point.unreliable || point.cashCorrection)).toBe(false);
      expect(r.approximationReasons).toContain(
        'cash after broker history ends follows the recorded cash events (derived when read; nothing is stored): D1 (after 2026-06-01)',
      );
      expect(historyRows()).toBe(rowsBefore);
    });

    it('steps to an adopted balance where it was adopted, as a correction that returns leave out', async () => {
      // The events reach 1,050, but the broker's balance adopted on 06-24 is 1,100.
      brokerHistoryUntilJune1('d2', 1_100);
      insertCashEvent('d2', '2026-06-15', 'dividend', 50);
      adopted('d2', '2026-06-24T15:00:00.000Z');

      const r = await getPortfolioHistory(deps(), '1M', ['d2'], now);

      expect(valueAt(r.points, '2026-06-23')).toBe(1_000 + 1_050);
      expect(valueAt(r.points, '2026-06-24')).toBe(1_000 + 1_100);
      expect(r.points.filter((point) => point.cashCorrection).map((point) => point.t)).toEqual(['2026-06-24']);
      expect(r.points.some((point) => point.unreliable)).toBe(false);
      // Never a return: the time-weighted line does not move on the step.
      expect(returnAt(r.returns, '2026-06-24')?.cumulative).toBe(returnAt(r.returns, '2026-06-23')?.cumulative);
      expect(r.approximationReasons).toContain(
        "cash steps to the broker's balance where the recorded cash events don't reach it, a correction rather than a market move, which returns leave out: D2 (2026-06-24)",
      );

      const household = await getPortfolioHistory(deps(), '1M', undefined, now);
      expect(household.points.filter((point) => point.cashCorrection).map((point) => point.t)).toEqual(['2026-06-24']);
    });

    it('shows a difference without an adoption record as a correction on the last day', async () => {
      brokerHistoryUntilJune1('d3', 1_100);
      insertCashEvent('d3', '2026-06-15', 'dividend', 50);

      const r = await getPortfolioHistory(deps(), '1M', ['d3'], now);

      expect(valueAt(r.points, '2026-07-09')).toBe(1_000 + 1_050);
      expect(r.points.at(-1)).toMatchObject({ t: '2026-07-10', value: 1_000 + 1_100, cashCorrection: true });
      expect(r.points.filter((point) => point.cashCorrection)).toHaveLength(1);
    });

    it('makes cash approximate from a sweep, whose direction the events cannot prove', async () => {
      brokerHistoryUntilJune1('d4', 700);
      insertCashEvent('d4', '2026-06-15', 'sweep', -300);

      const r = await getPortfolioHistory(deps(), '1M', ['d4'], now);

      expect(valueAt(r.points, '2026-06-12')).toBe(1_000 + 1_000);
      expect(r.points.filter((point) => point.unreliable).map((point) => point.t)).toEqual(['2026-06-15']);
      expect(r.reliability?.latestReliableFrom).toBe('2026-06-16');
      expect(r.summary).toMatchObject({ startValue: 1_000 + 700, change: 0 });
      expect(r.points.some((point) => point.cashCorrection)).toBe(false);
    });

    it("keeps the events' cash until the first trade even when the broker's balance was adopted earlier", async () => {
      // Adopted on 06-10, then a buy of 2 SYNA on 06-15 that the broker history doesn't cover.
      brokerHistoryUntilJune1('d6', 900);
      insertCashEvent('d6', '2026-06-05', 'dividend', 50);
      adopted('d6', '2026-06-10T15:00:00.000Z');
      state.createTransaction({
        id: 'd6-buy-2', accountId: 'd6', symbol: 'SYNA', date: '2026-06-15',
        quantity: 2, pricePerUnit: 100, currency: 'USD',
      });

      const r = await getPortfolioHistory(deps(), '1M', ['d6'], now);

      // Before the buy: the events' cash, not today's balance, which has already paid for it.
      expect(valueAt(r.points, '2026-06-12')).toBe(1_000 + 1_050);
      // From the buy, today's balance: approximate on the trade day only.
      expect(valueAt(r.points, '2026-06-15')).toBe(12 * 100 + 900);
      expect(r.points.filter((point) => point.unreliable).map((point) => point.t)).toEqual(['2026-06-15']);
      expect(r.points.some((point) => point.cashCorrection)).toBe(false);
    });

    it("keeps a switch to today's balance on the last day approximate, so no period change crosses it", async () => {
      brokerHistoryUntilJune1('d7', 800);
      // A buy dated today, which the broker history doesn't cover yet.
      state.createTransaction({
        id: 'd7-buy-2', accountId: 'd7', symbol: 'SYNA', date: '2026-07-10',
        quantity: 2, pricePerUnit: 100, currency: 'USD',
      });

      const r = await getPortfolioHistory(deps(), '1M', ['d7'], now);

      expect(r.points.at(-1)).toMatchObject({ t: '2026-07-10', value: 12 * 100 + 800, unreliable: true });
      expect(r.points.filter((point) => point.unreliable).map((point) => point.t)).toEqual(['2026-07-10']);
      expect(r.summary.endValue).toBe(1_000 + 1_000);
      expect(r.approximationReasons).toContain(
        "cash around trades or sweeps the broker cash history doesn't cover yet is today's balance less later cash events, shown as approximate and never the start of a period change: D7 (2026-07-10 to 2026-07-10)",
      );
    });

    it('flags the first point after trades dated on a day without a point of its own', async () => {
      brokerHistoryUntilJune1('d8', 800);
      // A buy dated Saturday 06-13: the switch to today's balance shows on Monday.
      state.createTransaction({
        id: 'd8-buy-2', accountId: 'd8', symbol: 'SYNA', date: '2026-06-13',
        quantity: 2, pricePerUnit: 100, currency: 'USD',
      });

      const r = await getPortfolioHistory(deps(), '1M', ['d8'], now);

      expect(valueAt(r.points, '2026-06-12')).toBe(1_000 + 1_000);
      expect(valueAt(r.points, '2026-06-15')).toBe(12 * 100 + 800);
      expect(r.points.filter((point) => point.unreliable).map((point) => point.t)).toEqual(['2026-06-15']);
      expect(r.reliability?.latestReliableFrom).toBe('2026-06-16');
    });

    it('marks every day from the first to the last trade after the history as approximate, and none after', async () => {
      // A buy and a later sell the broker history doesn't cover: today's 900 is right only after the sell.
      brokerHistoryUntilJune1('d5', 900);
      state.createTransaction({
        id: 'd5-buy-2', accountId: 'd5', symbol: 'SYNA', date: '2026-06-15',
        quantity: 2, pricePerUnit: 100, currency: 'USD',
      });
      state.createTransaction({
        id: 'd5-sell', accountId: 'd5', symbol: 'SYNA', date: '2026-06-24',
        quantity: -1, pricePerUnit: 100, currency: 'USD',
      });

      const r = await getPortfolioHistory(deps(), '1M', ['d5'], now);

      const approximate = r.points.filter((point) => point.unreliable).map((point) => point.t);
      expect(approximate[0]).toBe('2026-06-15');
      expect(approximate.at(-1)).toBe('2026-06-24');
      expect(approximate).toHaveLength(8);
      expect(valueAt(r.points, '2026-06-25')).toBe(11 * 100 + 900);
      expect(r.reliability?.latestReliableFrom).toBe('2026-06-25');
      expect(r.summary).toMatchObject({ startValue: 11 * 100 + 900, change: 0 });
    });

    it('keeps a switch dated before the range off its first point', async () => {
      // History ends 05-01, an uncovered buy on 05-15; the 1M range opens on 06-10 and the price moves on 06-11.
      state.createAccount({ id: 'd9', name: 'D9', cashBalance: 800, currency: 'USD', accountNumber: 'X-d9' });
      state.createTransaction({
        id: 'd9-buy', accountId: 'd9', symbol: 'SYNA', date: '2026-04-01',
        quantity: 10, pricePerUnit: 100, currency: 'USD',
      });
      state.importCashHistory({
        accountId: 'd9', currency: 'USD', broker: 'fidelity', accountLast4: '0009',
        sourceHash: 'd9'.padEnd(64, 'f'), method: 'test-eod-v1',
        rows: [{ date: '2026-05-01', cashBalance: 1_000 }],
      });
      state.createTransaction({
        id: 'd9-buy-2', accountId: 'd9', symbol: 'SYNA', date: '2026-05-15',
        quantity: 2, pricePerUnit: 100, currency: 'USD',
      });
      seedWeekdays('SYNA', '2026-04-01', '2026-07-10', (day) => (day >= '2026-06-11' ? 110 : 100));

      const r = await getPortfolioHistory(
        { state, history: createHistoryRepo(state), fetchQuotes: quotes({ SYNA: 110 }) },
        '1M', ['d9'], now,
      );

      expect(r.points[0]).toMatchObject({ t: '2026-06-10', value: 12 * 100 + 800 });
      expect(r.points.some((point) => point.unreliable)).toBe(false);
      expect(r.summary).toMatchObject({ startValue: 12 * 100 + 800, change: 12 * 10 });
      expect(r.approximationReasons.some((reason) => reason.startsWith('cash around trades or sweeps'))).toBe(false);
    });

    it('flags the live point when trades follow a cash row dated on the last point', async () => {
      // Rows through Friday 07-10, an uncovered buy on Saturday and a 100 fee without an event, read on Sunday.
      brokerHistoryUntilJune1('d10', 700);
      state.importCashHistory({
        accountId: 'd10', currency: 'USD', broker: 'fidelity', accountLast4: '0010',
        sourceHash: 'e'.repeat(64), method: 'test-eod-v1',
        rows: [{ date: '2026-07-10', cashBalance: 1_000 }],
      });
      state.createTransaction({
        id: 'd10-buy-2', accountId: 'd10', symbol: 'SYNA', date: '2026-07-11',
        quantity: 2, pricePerUnit: 100, currency: 'USD',
      });

      const r = await getPortfolioHistory(deps(), '1M', ['d10'], new Date('2026-07-12T16:00:00Z'));

      expect(valueAt(r.points, '2026-07-09')).toBe(1_000 + 1_000);
      expect(r.points.at(-1)).toMatchObject({ t: '2026-07-10', value: 12 * 100 + 700, unreliable: true });
      expect(r.points.filter((point) => point.unreliable).map((point) => point.t)).toEqual(['2026-07-10']);
      expect(r.summary).toMatchObject({ endValue: 1_000 + 1_000, change: 0 });
      expect(r.points.some((point) => point.cashCorrection)).toBe(false);
      expect(r.approximationReasons).toContain(
        "cash around trades or sweeps the broker cash history doesn't cover yet is today's balance less later cash events, shown as approximate and never the start of a period change: D10 (2026-07-11 to 2026-07-11)",
      );
    });

    describe('between a broker cash row and a later sync capture', () => {
      /** A row the Fidelity importer appends when a sync applies, as it writes it. */
      const captured = (accountId: string, date: string, cashBalance: number) => state.internalGetDb().prepare(
        `INSERT INTO account_cash_history
           (account_id, as_of_date, cash_balance, currency, broker, account_last4, source_hash, method)
         VALUES (?, ?, ?, 'USD', 'fidelity', '0000', ?, 'fidelity-capture')`,
      ).run(accountId, date, cashBalance, Buffer.from(`${accountId}${date}`).toString('hex').slice(0, 64).padEnd(64, '0'));

      it('follows the events across weeks to the capture, with the adoption as a labelled correction', async () => {
        // An imported row on 06-01; a dividend, a deposit and a tax payment, then the broker's balance adopted
        // on 06-17 (the events reach 1,220; the broker says 1,300); the first capture on 06-24.
        brokerHistoryUntilJune1('g1', 1_300);
        insertCashEvent('g1', '2026-06-11', 'dividend', 50);
        insertCashEvent('g1', '2026-06-12', 'deposit', 200);
        insertCashEvent('g1', '2026-06-15', 'tax', -30);
        adopted('g1', '2026-06-17T15:00:00.000Z');
        captured('g1', '2026-06-24', 1_300);
        const rowsBefore = historyRows();

        const r = await getPortfolioHistory(deps(), '1M', ['g1'], now);

        expect(valueAt(r.points, '2026-06-10')).toBe(1_000 + 1_000);
        expect(valueAt(r.points, '2026-06-11')).toBe(1_000 + 1_050);
        expect(valueAt(r.points, '2026-06-12')).toBe(1_000 + 1_250);
        expect(valueAt(r.points, '2026-06-16')).toBe(1_000 + 1_220);
        expect(valueAt(r.points, '2026-06-17')).toBe(1_000 + 1_300);
        expect(valueAt(r.points, '2026-06-23')).toBe(1_000 + 1_300);
        expect(valueAt(r.points, '2026-06-24')).toBe(1_000 + 1_300);
        expect(r.points.at(-1)?.value).toBe(1_000 + 1_300);
        expect(r.points.filter((point) => point.cashCorrection).map((point) => point.t)).toEqual(['2026-06-17']);
        expect(r.points.some((point) => point.unreliable)).toBe(false);
        expect(returnAt(r.returns, '2026-06-17')?.cumulative).toBe(returnAt(r.returns, '2026-06-16')?.cumulative);
        expect(r.approximationReasons).toEqual(expect.arrayContaining([
          'cash on business days between broker cash rows around a sync capture follows the recorded cash events (derived when read; nothing is stored): G1 (2026-06-01 to 2026-06-24)',
          "cash steps to the broker's balance where the recorded cash events don't reach it, a correction rather than a market move, which returns leave out: G1 (2026-06-17)",
          'cash after broker history ends follows the recorded cash events (derived when read; nothing is stored): G1 (after 2026-06-24)',
        ]));
        expect(historyRows()).toBe(rowsBefore);
      });

      it('shows a difference without an adoption record as a correction on the capture day', async () => {
        brokerHistoryUntilJune1('g2', 1_100);
        insertCashEvent('g2', '2026-06-15', 'dividend', 50);
        captured('g2', '2026-06-24', 1_100);

        const r = await getPortfolioHistory(deps(), '1M', ['g2'], now);

        expect(valueAt(r.points, '2026-06-12')).toBe(1_000 + 1_000);
        expect(valueAt(r.points, '2026-06-15')).toBe(1_000 + 1_050);
        expect(valueAt(r.points, '2026-06-23')).toBe(1_000 + 1_050);
        expect(r.points.filter((point) => point.cashCorrection).map((point) => point.t)).toEqual(['2026-06-24']);
        expect(valueAt(r.points, '2026-06-24')).toBe(1_000 + 1_100);
        expect(r.points.some((point) => point.unreliable)).toBe(false);
      });

      it('makes cash approximate from a trade in the gap until the capture, never a correction', async () => {
        // A buy on 06-12 that no event records; the capture on 06-19 has paid for it.
        brokerHistoryUntilJune1('g3', 800);
        state.createTransaction({
          id: 'g3-buy-2', accountId: 'g3', symbol: 'SYNA', date: '2026-06-12',
          quantity: 2, pricePerUnit: 100, currency: 'USD',
        });
        captured('g3', '2026-06-19', 800);

        const r = await getPortfolioHistory(deps(), '1M', ['g3'], now);

        expect(valueAt(r.points, '2026-06-11')).toBe(1_000 + 1_000);
        // Never both the new shares and the cash that paid for them.
        expect(valueAt(r.points, '2026-06-12')).toBe(12 * 100 + 800);
        expect(valueAt(r.points, '2026-06-18')).toBe(12 * 100 + 800);
        expect(r.points.filter((point) => point.unreliable).map((point) => point.t)).toEqual(['2026-06-12']);
        expect(r.points.some((point) => point.cashCorrection)).toBe(false);
        expect(r.approximationReasons).toContain(
          "cash around trades or sweeps between broker cash rows is the next row's balance less the cash events until it, shown as approximate and never the start of a period change: G3 (2026-06-12 to 2026-06-12)",
        );
      });

      it("treats a trade on the capture's own day as unseparated from an earlier adoption", async () => {
        // Adopted on 06-10 (+50 to Holdr's figure), then a buy on 06-17, the capture's day: 1,000 + 50 - 200.
        brokerHistoryUntilJune1('g4', 850);
        adopted('g4', '2026-06-10T15:00:00.000Z');
        state.createTransaction({
          id: 'g4-buy-2', accountId: 'g4', symbol: 'SYNA', date: '2026-06-17',
          quantity: 2, pricePerUnit: 100, currency: 'USD',
        });
        captured('g4', '2026-06-17', 850);

        const r = await getPortfolioHistory(deps(), '1M', ['g4'], now);

        // The events' cash until the capture: today's figure before the buy would backdate it.
        expect(valueAt(r.points, '2026-06-10')).toBe(1_000 + 1_000);
        expect(valueAt(r.points, '2026-06-16')).toBe(1_000 + 1_000);
        expect(valueAt(r.points, '2026-06-17')).toBe(12 * 100 + 850);
        expect(r.points.filter((point) => point.unreliable).map((point) => point.t)).toEqual(['2026-06-17']);
        expect(r.reliability?.latestReliableFrom).toBe('2026-06-18');
        expect(r.points.some((point) => point.cashCorrection)).toBe(false);
      });

      it('leaves gaps between imported rows, and rows without a business day between them, as before', async () => {
        // Imported rows on 06-01 and 06-17 that the events don't reconcile (a deposit of 200 against +300),
        // then captures on Thursday, Friday and Monday.
        brokerHistoryUntilJune1('g5', 1_350);
        state.importCashHistory({
          accountId: 'g5', currency: 'USD', broker: 'fidelity', accountLast4: '0005',
          sourceHash: 'a'.repeat(64), method: 'test-eod-v1',
          rows: [{ date: '2026-06-17', cashBalance: 1_300 }],
        });
        insertCashEvent('g5', '2026-06-17', 'deposit', 200);
        captured('g5', '2026-06-18', 1_300);
        captured('g5', '2026-06-19', 1_300);
        insertCashEvent('g5', '2026-06-22', 'dividend', 50);
        captured('g5', '2026-06-22', 1_350);

        const r = await getPortfolioHistory(deps(), '1M', ['g5'], now);

        expect(valueAt(r.points, '2026-06-16')).toBe(1_000 + 1_000);
        expect(valueAt(r.points, '2026-06-17')).toBe(1_000 + 1_300);
        expect(valueAt(r.points, '2026-06-19')).toBe(1_000 + 1_300);
        expect(valueAt(r.points, '2026-06-22')).toBe(1_000 + 1_350);
        expect(r.points.at(-1)?.value).toBe(1_000 + 1_350);
        expect(r.points.some((point) => point.cashCorrection || point.unreliable)).toBe(false);
        expect(r.approximationReasons.some((reason) => reason.startsWith('cash on business days between broker cash rows'))).toBe(false);
        expect(r.approximationReasons).toContain(
          'cash after broker history ends follows the recorded cash events (derived when read; nothing is stored): G5 (after 2026-06-22)',
        );
      });
    });

    describe("trades a later sync applied for a capture row's own day", () => {
      /** A row a sync wrote at its first capture of the day, applied at `importedAt`. */
      const capturedAt = (accountId: string, date: string, cashBalance: number, importedAt: string) => state.internalGetDb().prepare(
        `INSERT INTO account_cash_history
           (account_id, as_of_date, cash_balance, currency, broker, account_last4, source_hash, method, imported_at)
         VALUES (?, ?, ?, 'USD', 'fidelity', '0000', ?, 'fidelity-capture', ?)`,
      ).run(accountId, date, cashBalance, Buffer.from(`${accountId}${date}`).toString('hex').slice(0, 64).padEnd(64, '0'), importedAt);
      /** A trade a sync applied at `createdAt`. */
      const appliedAt = (createdAt: string, transaction: Parameters<typeof state.createTransaction>[0]) => {
        state.createTransaction(transaction);
        state.internalGetDb().prepare('UPDATE transactions SET created_at = ? WHERE id = ?').run(createdAt, transaction.id);
      };
      const shownFor = 'cash on days with trades a later sync applied is the next balance less the cash events between, which those trades account for (derived when read; nothing is stored): ';

      it("values a day's trades a later sync applied with that day's cash, not the capture before them", async () => {
        // Captured at the first sync on 06-15 (1,000), then a buy of 3 and a put sold to open, which the
        // 06-16 capture includes: 1,000 - 300 + 200 - 0.65.
        brokerHistoryUntilJune1('h1', 899.35);
        capturedAt('h1', '2026-06-15', 1_000, '2026-06-15T13:30:00.000Z');
        appliedAt('2026-06-15T18:00:00.000Z', {
          id: 'h1-buy-3', accountId: 'h1', symbol: 'SYNA', date: '2026-06-15',
          quantity: 3, pricePerUnit: 100, currency: 'USD',
        });
        appliedAt('2026-06-15T18:00:00.000Z', {
          id: 'h1-put', accountId: 'h1', symbol: 'SYNA260717P00090000', date: '2026-06-15',
          quantity: -1, pricePerUnit: 2, fees: 0.65, currency: 'USD',
          instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open',
        });
        capturedAt('h1', '2026-06-16', 899.35, '2026-06-16T13:30:00.000Z');

        const r = await getPortfolioHistory(deps(), '1M', ['h1'], now);

        expect(valueAt(r.points, '2026-06-12')).toBe(1_000 + 1_000);
        // Never both the new shares and the cash that paid for them: the put is worth nothing at 100.
        expect(valueAt(r.points, '2026-06-15')).toBe(13 * 100 + 899.35);
        expect(valueAt(r.points, '2026-06-16')).toBe(13 * 100 + 899.35);
        expect(r.points.at(-1)?.value).toBe(13 * 100 + 899.35);
        expect(r.points.some((point) => point.cashCorrection || point.unreliable)).toBe(false);
        expect(r.approximationReasons).toContain(`${shownFor}H1 (2026-06-15)`);
      });

      it('makes no correction of the next morning\'s live point for trades applied after the last capture', async () => {
        // The last capture, on Thursday, came before a buy that a later sync that day applied; Friday has no sync yet.
        brokerHistoryUntilJune1('h2', 800);
        capturedAt('h2', '2026-07-09', 1_000, '2026-07-09T13:30:00.000Z');
        appliedAt('2026-07-09T18:00:00.000Z', {
          id: 'h2-buy-2', accountId: 'h2', symbol: 'SYNA', date: '2026-07-09',
          quantity: 2, pricePerUnit: 100, currency: 'USD',
        });

        const r = await getPortfolioHistory(deps(), '1M', ['h2'], now);

        expect(valueAt(r.points, '2026-07-08')).toBe(1_000 + 1_000);
        expect(valueAt(r.points, '2026-07-09')).toBe(12 * 100 + 800);
        expect(r.points.at(-1)).toMatchObject({ t: '2026-07-10', value: 12 * 100 + 800 });
        expect(r.points.some((point) => point.cashCorrection || point.unreliable)).toBe(false);
        expect(r.approximationReasons).toContain(`${shownFor}H2 (2026-07-09)`);
      });

      it("keeps the capture's balance where the later balance shows the applied shares moved no cash", async () => {
        // Shares deposited after Thursday's capture: today's balance is still the captured 1,000.
        brokerHistoryUntilJune1('h3', 1_000);
        capturedAt('h3', '2026-07-09', 1_000, '2026-07-09T13:30:00.000Z');
        appliedAt('2026-07-09T18:00:00.000Z', {
          id: 'h3-deposit', accountId: 'h3', symbol: 'SYNA', date: '2026-07-09',
          quantity: 2, pricePerUnit: 100, currency: 'USD',
        });

        const r = await getPortfolioHistory(deps(), '1M', ['h3'], now);

        expect(valueAt(r.points, '2026-07-09')).toBe(12 * 100 + 1_000);
        expect(r.points.at(-1)?.value).toBe(12 * 100 + 1_000);
        expect(r.points.some((point) => point.cashCorrection || point.unreliable)).toBe(false);
        expect(r.approximationReasons.some((reason) => reason.startsWith(shownFor))).toBe(false);
      });

      it('confirms a purchase and a deposit applied together by the cash only the purchase moved', async () => {
        // After the 06-15 capture: a buy of 2 and a deposit of 2 more; the 06-16 capture shows the buy's 200 only.
        brokerHistoryUntilJune1('h6', 800);
        capturedAt('h6', '2026-06-15', 1_000, '2026-06-15T13:30:00.000Z');
        appliedAt('2026-06-15T18:00:00.000Z', {
          id: 'h6-buy-2', accountId: 'h6', symbol: 'SYNA', date: '2026-06-15',
          quantity: 2, pricePerUnit: 100, currency: 'USD',
        });
        appliedAt('2026-06-15T18:00:00.000Z', {
          id: 'h6-deposit', accountId: 'h6', symbol: 'SYNA', date: '2026-06-15',
          quantity: 2, pricePerUnit: 100, currency: 'USD',
        });
        capturedAt('h6', '2026-06-16', 800, '2026-06-16T13:30:00.000Z');

        const r = await getPortfolioHistory(deps(), '1M', ['h6'], now);

        expect(valueAt(r.points, '2026-06-12')).toBe(1_000 + 1_000);
        expect(valueAt(r.points, '2026-06-15')).toBe(14 * 100 + 800);
        expect(valueAt(r.points, '2026-06-16')).toBe(14 * 100 + 800);
        expect(r.points.some((point) => point.cashCorrection || point.unreliable)).toBe(false);
        expect(r.approximationReasons).toContain(`${shownFor}H6 (2026-06-15)`);
      });

      it('keeps the capture balance where nothing confirms the later trades, so a deposit never counts as a purchase', async () => {
        // A deposit of 2 after the 06-15 capture moved no cash; a buy of 2 on 06-17 did. Friday's capture: 790.
        state.createAccount({ id: 'h7', name: 'H7', cashBalance: 790, currency: 'USD', accountNumber: 'X-h7' });
        state.createTransaction({
          id: 'h7-buy', accountId: 'h7', symbol: 'SYNA', date: '2026-06-01',
          quantity: 10, pricePerUnit: 100, currency: 'USD',
        });
        state.importCashHistory({
          accountId: 'h7', currency: 'USD', broker: 'fidelity', accountLast4: '0007',
          sourceHash: Buffer.from('h7').toString('hex').padEnd(64, 'f'), method: 'test-eod-v1',
          rows: [{ date: '2026-06-01', cashBalance: 1_000 }],
        });
        seedWeekdays('SYNA', '2026-04-01', '2026-07-10', (day) => (day >= '2026-06-16' ? 105 : 100));
        capturedAt('h7', '2026-06-15', 1_000, '2026-06-15T13:30:00.000Z');
        appliedAt('2026-06-15T18:00:00.000Z', {
          id: 'h7-deposit', accountId: 'h7', symbol: 'SYNA', date: '2026-06-15',
          quantity: 2, pricePerUnit: 100, currency: 'USD',
        });
        appliedAt('2026-06-19T13:30:00.000Z', {
          id: 'h7-buy-2', accountId: 'h7', symbol: 'SYNA', date: '2026-06-17',
          quantity: 2, pricePerUnit: 105, currency: 'USD',
        });
        capturedAt('h7', '2026-06-19', 790, '2026-06-19T13:30:00.000Z');

        const r = await getPortfolioHistory(
          { state, history: createHistoryRepo(state), fetchQuotes: quotes({ SYNA: 105 }) },
          '1M', ['h7'], now,
        );

        expect(valueAt(r.points, '2026-06-15')).toBe(12 * 100 + 1_000);
        expect(valueAt(r.points, '2026-06-16')).toBe(12 * 105 + 1_000);
        expect(valueAt(r.points, '2026-06-18')).toBe(14 * 105 + 790);
        // The day after the deposit: its 60 gain over the 2,200 it started from.
        expect(returnAt(r.returns, '2026-06-16')?.cumulative).toBeCloseTo(60 / 2_200, 8);
        // As before: the capture day its later trades leave unconfirmed, and the buy the next capture doesn't cover.
        expect(r.points.filter((point) => point.unreliable).map((point) => point.t)).toEqual(['2026-06-15', '2026-06-17']);
        expect(r.points.some((point) => point.cashCorrection)).toBe(false);
        expect(r.approximationReasons).toContain(
          "cash on days with trades a later sync applied that nothing after them confirms stays at that day's sync capture, which those trades may have moved: H7 (2026-06-15)",
        );
        expect(r.approximationReasons.some((reason) => reason.startsWith(shownFor))).toBe(false);
      });

      it('keeps an unconfirmed capture day approximate, so it never starts a period change', async () => {
        // The 06-16 sync applies a buy made after the 06-15 capture and adopts the broker's balance: unconfirmed.
        brokerHistoryUntilJune1('h10', 800);
        capturedAt('h10', '2026-06-15', 1_000, '2026-06-15T13:30:00.000Z');
        appliedAt('2026-06-16T15:00:00.000Z', {
          id: 'h10-buy-2', accountId: 'h10', symbol: 'SYNA', date: '2026-06-15',
          quantity: 2, pricePerUnit: 100, currency: 'USD',
        });
        adopted('h10', '2026-06-16T15:00:00.000Z');
        capturedAt('h10', '2026-06-16', 800, '2026-06-16T15:00:00.000Z');

        // A month back from 07-15 starts on the capture day.
        const r = await getPortfolioHistory(deps(), '1M', ['h10'], new Date('2026-07-15T16:00:00Z'));

        expect(r.points[0]).toMatchObject({ t: '2026-06-15', value: 12 * 100 + 1_000, unreliable: true });
        expect(valueAt(r.points, '2026-06-16')).toBe(12 * 100 + 800);
        expect(r.reliability?.latestReliableFrom).toBe('2026-06-16');
        expect(r.summary).toMatchObject({ startValue: 12 * 100 + 800, change: 0 });
      });

      it("keeps a first capture's own balance on the days before it", async () => {
        // No imported history: the account's first cash row is a capture, followed the same day by a buy.
        state.createAccount({ id: 'h9', name: 'H9', cashBalance: 800, currency: 'USD', accountNumber: 'X-h9' });
        state.createTransaction({
          id: 'h9-buy', accountId: 'h9', symbol: 'SYNA', date: '2026-06-01',
          quantity: 10, pricePerUnit: 100, currency: 'USD',
        });
        seedWeekdays('SYNA', '2026-04-01', '2026-07-10', () => 100);
        capturedAt('h9', '2026-06-15', 1_000, '2026-06-15T13:30:00.000Z');
        appliedAt('2026-06-15T18:00:00.000Z', {
          id: 'h9-buy-2', accountId: 'h9', symbol: 'SYNA', date: '2026-06-15',
          quantity: 2, pricePerUnit: 100, currency: 'USD',
        });

        const r = await getPortfolioHistory(deps(), '1M', ['h9'], now);

        expect(valueAt(r.points, '2026-06-12')).toBe(10 * 100 + 1_000);
        expect(valueAt(r.points, '2026-06-15')).toBe(12 * 100 + 800);
        expect(r.points.at(-1)?.value).toBe(12 * 100 + 800);
        expect(r.summary).toMatchObject({ startValue: 2_000, endValue: 2_000, change: 0 });
        expect(r.points.some((point) => point.cashCorrection || point.unreliable)).toBe(false);
      });

      it('never changes an imported row, which is the balance after the whole day', async () => {
        brokerHistoryUntilJune1('h5', 800);
        state.importCashHistory({
          accountId: 'h5', currency: 'USD', broker: 'fidelity', accountLast4: '0005',
          sourceHash: 'c'.repeat(64), method: 'test-eod-v1',
          rows: [{ date: '2026-06-15', cashBalance: 800 }],
        });
        state.internalGetDb().prepare("UPDATE account_cash_history SET imported_at = '2026-06-15T13:30:00.000Z' WHERE account_id = 'h5'").run();
        appliedAt('2026-06-15T18:00:00.000Z', {
          id: 'h5-buy-2', accountId: 'h5', symbol: 'SYNA', date: '2026-06-15',
          quantity: 2, pricePerUnit: 100, currency: 'USD',
        });

        const r = await getPortfolioHistory(deps(), '1M', ['h5'], now);

        expect(valueAt(r.points, '2026-06-15')).toBe(12 * 100 + 800);
        expect(r.points.some((point) => point.cashCorrection || point.unreliable)).toBe(false);
        expect(r.approximationReasons.some((reason) => reason.startsWith(shownFor))).toBe(false);
      });
    });
  });

  it('includes an account whose history starts after the last business day in the live point', async () => {
    const saturday = new Date('2026-07-11T16:00:00Z');
    state.createTransaction({
      id: 'a1-buy', accountId: 'a1', symbol: 'AAPL', date: '2026-06-01',
      quantity: 1, pricePerUnit: 100, currency: 'USD',
    });
    state.createTransaction({
      id: 'a2-weekend', accountId: 'a2', symbol: 'AAPL', date: '2026-07-11',
      quantity: 2, pricePerUnit: 100, currency: 'USD',
    });
    seedWeekdays('AAPL', '2026-04-01', '2026-07-10', () => 100);

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state), fetchQuotes: quotes({ AAPL: 110 }) },
      '1M', undefined, saturday,
    );

    expect(valueAt(r.points, '2026-07-09')).toBe(100 + 100);
    expect(r.points.at(-1)).toMatchObject({ t: '2026-07-10', value: 110 + 100 + 2 * 110 + 50 });
  });

  it('holds an option that expired without a closing record at its expiry value', async () => {
    state.createTransaction({
      id: 'put-open', accountId: 'a1', symbol: 'NBIS260626P00100000', date: '2026-06-15',
      quantity: -1, pricePerUnit: 5, currency: 'USD',
      instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open',
    });
    seedWeekdays('NBIS', '2026-04-01', '2026-07-10', (day) => (day <= '2026-06-26' ? 90 : 80));

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state), fetchQuotes: quotes({}) },
      '1M', ['a1'], now,
    );

    expect(valueAt(r.points, '2026-06-26')).toBe(100 - 100 * 10);
    expect(valueAt(r.points, '2026-07-01')).toBe(100 - 100 * 10);
    expect(r.points.at(-1)?.value).toBe(100 - 100 * 10);
    expect(r.approximationReasons.some((reason) => (
      reason.startsWith('options past expiry without a closing record held at their expiry value: NBIS')
    ))).toBe(true);
  });

  it('starts at the first non-empty day', async () => {
    state.createAccount({ id: 'z1', name: 'Z1', cashBalance: 0, currency: 'USD', accountNumber: 'X-9999' });
    state.importCashHistory({
      accountId: 'z1', currency: 'USD', broker: 'fidelity', accountLast4: '9999',
      sourceHash: 'c'.repeat(64), method: 'test-eod-v1',
      rows: [{ date: '2026-06-01', cashBalance: 0 }],
    });
    state.createTransaction({
      id: 'z1-buy', accountId: 'z1', symbol: 'AAPL', date: '2026-06-17',
      quantity: 1, pricePerUnit: 120, currency: 'USD',
    });
    seedWeekdays('AAPL', '2026-04-01', '2026-07-10', () => 120);

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state), fetchQuotes: quotes({ AAPL: 120 }) },
      '1M', ['z1'], now,
    );

    expect(r.points[0]).toMatchObject({ t: '2026-06-17', value: 120, costBasis: 120 });
    expect(r.coverage.complete).toBe(false);
  });

  it('uses a manual price only until a newer daily close exists', async () => {
    const manualPrices = createManualPriceRepo(state);
    manualPrices.upsert({ symbol: 'AAPL', date: '2026-06-10', close: 50 });
    state.createTransaction({
      id: 'b1', accountId: 'a1', symbol: 'AAPL', date: '2026-06-01',
      quantity: 1, pricePerUnit: 100, currency: 'USD',
    });
    seedWeekdays('AAPL', '2026-04-01', '2026-07-10', () => 100);

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state), manualPrices, fetchQuotes: quotes({ AAPL: 100 }) },
      '1M', ['a1'], now,
    );

    expect(valueAt(r.points, '2026-06-10')).toBe(50 + 100);
    expect(valueAt(r.points, '2026-06-11')).toBe(100 + 100);
    expect(r.approximationReasons).toContain('manual price overrides applied for AAPL');
  });

  let cashEventCount = 0;
  function insertCashEvent(accountId: string, date: string, eventType: 'dividend' | 'deposit' | 'tax' | 'sweep', amount: number) {
    cashEventCount += 1;
    state.insertCashEvent({
      accountId, date, eventType, amount, currency: 'USD', broker: 'fidelity', accountLast4: '1234',
      description: `${eventType} ${date}`, sourceFingerprint: cashEventCount.toString(16).padStart(64, '0'),
    });
  }

  const returnAt = (returns: { points: Array<{ t: string; cumulative: number; gain: number }> } | undefined, t: string) => (
    returns?.points.find((point) => point.t === t)
  );

  it('returns a time-weighted return that counts price moves and dividends but not money moving in', async () => {
    state.createTransaction({
      id: 'buy', accountId: 'a1', symbol: 'AAPL', date: '2026-06-01',
      quantity: 10, pricePerUnit: 100, currency: 'USD',
    });
    // A transfer-in carries its old cost basis, never a trade price.
    state.createTransaction({
      id: 'acat', accountId: 'a1', symbol: 'AAPL', date: '2026-06-22',
      quantity: 10, pricePerUnit: 50, currency: 'USD',
    });
    insertCashEvent('a1', '2026-06-24', 'dividend', 20);
    insertCashEvent('a1', '2026-06-25', 'deposit', 500);
    insertCashEvent('a1', '2026-06-26', 'tax', -5);
    seedWeekdays('AAPL', '2026-04-01', '2026-07-10', (day) => (day < '2026-06-15' ? 100 : day < '2026-06-29' ? 110 : 121));

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state), fetchQuotes: quotes({ AAPL: 121 }) },
      '1M', ['a1'], now,
    );

    expect(r.returns?.method).toBe('time_weighted');
    expect(r.returns?.points.map((point) => point.t)).toEqual(r.points.map((point) => point.t));
    expect(returnAt(r.returns, '2026-06-12')?.cumulative).toBe(0);
    expect(returnAt(r.returns, '2026-06-15')?.cumulative).toBeCloseTo(100 / 1_100, 8);
    expect(returnAt(r.returns, '2026-06-22')?.cumulative).toBeCloseTo(100 / 1_100, 8);
    expect(r.returns?.summary.cumulative).toBeCloseTo((1 + 100 / 1_100) * (1 + 20 / 2_300) * (1 + 220 / 2_300) - 1, 8);
    expect(r.returns?.summary.gain).toBe(100 + 20 + 220);
    expect(r.returns?.summary.netFlows).toBe(r.points.at(-1)!.value - r.points[0].value - 340);
    expect(r.returns?.summary.annualized).toBeNull();
  });

  it('does not let an unsettled purchase shrink the starting value of a daily return', async () => {
    state.createAccount({ id: 'c3', name: 'C3', cashBalance: 100, currency: 'USD', accountNumber: 'X-4321' });
    state.createTransaction({
      id: 'c3-buy', accountId: 'c3', symbol: 'AAPL', date: '2026-06-11',
      quantity: 10, pricePerUnit: 100, currency: 'USD',
    });
    state.importCashHistory({
      accountId: 'c3', currency: 'USD', broker: 'fidelity', accountLast4: '4321',
      sourceHash: 'd'.repeat(64), method: 'test-eod-v1',
      rows: [
        { date: '2026-06-10', cashBalance: 100 },
        { date: '2026-06-11', cashBalance: -900 },
        { date: '2026-06-12', cashBalance: 100 },
      ],
    });
    seedWeekdays('AAPL', '2026-04-01', '2026-07-10', (day) => (day < '2026-06-12' ? 100 : 95));

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state), fetchQuotes: quotes({ AAPL: 95 }) },
      '1M', ['c3'], now,
    );

    expect(valueAt(r.points, '2026-06-11')).toBe(100);
    expect(returnAt(r.returns, '2026-06-11')?.cumulative).toBe(0);
    // -$50 on $1,000 of holdings, not on the $100 left after the unsettled buy.
    expect(returnAt(r.returns, '2026-06-12')?.cumulative).toBeCloseTo(-0.05, 8);
    expect(r.returns?.notes).toContain('negative cash from unsettled purchases is not subtracted from the starting value (1 day)');
  });

  it('counts an option premium when received and the closing cost when paid', async () => {
    state.createTransaction({
      id: 'aapl', accountId: 'a1', symbol: 'AAPL', date: '2026-06-01',
      quantity: 100, pricePerUnit: 100, currency: 'USD',
    });
    state.createTransaction({
      id: 'put-open', accountId: 'a1', symbol: 'NBIS260918P00100000', date: '2026-06-15',
      quantity: -1, pricePerUnit: 5, fees: 1, currency: 'USD',
      instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open',
    });
    state.createTransaction({
      id: 'put-close', accountId: 'a1', symbol: 'NBIS260918P00100000', date: '2026-06-24',
      quantity: 1, pricePerUnit: 12, fees: 1, currency: 'USD',
      instrumentType: 'option', contractMultiplier: 100, positionEffect: 'close',
    });
    seedWeekdays('AAPL', '2026-04-01', '2026-07-10', () => 100);
    seedWeekdays('NBIS', '2026-04-01', '2026-07-10', (day) => (day < '2026-06-17' ? 110 : 90));

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state), fetchQuotes: quotes({ AAPL: 100, NBIS: 90 }) },
      '1M', ['a1'], now,
    );

    expect(returnAt(r.returns, '2026-06-15')?.gain).toBe(499);
    expect(returnAt(r.returns, '2026-06-17')?.gain).toBe(499 - 1_000);
    // Realised: $500 premium - $1,200 to close - $2 fees.
    expect(r.returns?.summary.gain).toBe(-702);
  });

  it('annualizes the return only for spans of at least a year', async () => {
    state.createTransaction({
      id: 'old', accountId: 'a1', symbol: 'AAPL', date: '2024-07-01',
      quantity: 10, pricePerUnit: 100, currency: 'USD',
    });
    seedWeekdays('AAPL', '2024-06-03', '2026-07-10', (day) => (day < '2025-07-01' ? 100 : 121));
    const deps = { state, history: createHistoryRepo(state), fetchQuotes: quotes({ AAPL: 121 }) };

    const all = await getPortfolioHistory(deps, 'ALL', ['a1'], now);
    const spanDays = (Date.parse('2026-07-10') - Date.parse('2024-07-01')) / 86_400_000;
    expect(all.points[0].t).toBe('2024-07-01');
    expect(all.returns?.summary.cumulative).toBeCloseTo(210 / 1_100, 8);
    expect(all.returns?.summary.annualized).toBeCloseTo((1 + 210 / 1_100) ** (365.25 / spanDays) - 1, 6);
    // No money moved after the first day, so both measures agree.
    expect(all.returns?.summary.moneyWeighted).toBeCloseTo(210 / 1_100, 6);
    expect(all.returns?.summary.moneyWeightedAnnualized).toBeCloseTo((1 + 210 / 1_100) ** (365.25 / spanDays) - 1, 6);

    const ytd = await getPortfolioHistory(deps, 'YTD', ['a1'], now);
    expect(ytd.returns?.summary.cumulative).toBe(0);
    expect(ytd.returns?.summary.annualized).toBeNull();
    expect(ytd.returns?.summary.moneyWeighted).toBe(0);
    expect(ytd.returns?.summary.moneyWeightedAnnualized).toBeNull();
  });

  it('leaves out income an account received before it joins the household value', async () => {
    state.createTransaction({
      id: 'a1-buy', accountId: 'a1', symbol: 'AAPL', date: '2026-06-01',
      quantity: 10, pricePerUnit: 100, currency: 'USD',
    });
    state.createTransaction({
      id: 'a2-buy', accountId: 'a2', symbol: 'MSFT', date: '2026-06-20',
      quantity: 3, pricePerUnit: 200, currency: 'USD',
    });
    insertCashEvent('a2', '2026-06-15', 'dividend', 30);
    seedWeekdays('AAPL', '2026-04-01', '2026-07-10', () => 100);
    seedWeekdays('MSFT', '2026-04-01', '2026-07-10', () => 200);

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state), fetchQuotes: quotes({ AAPL: 100, MSFT: 200 }) },
      '1M', undefined, now,
    );

    expect(r.returns?.summary.cumulative).toBe(0);
    expect(r.returns?.summary.gain).toBe(0);
    expect(r.returns?.notes).toContain("1 income or option entry on or before their account's first recorded day left out");
  });

  it('marks an open option at its live quote on the final point for both value and return', async () => {
    state.createTransaction({
      id: 'aapl', accountId: 'a1', symbol: 'AAPL', date: '2026-06-01',
      quantity: 100, pricePerUnit: 100, currency: 'USD',
    });
    state.createTransaction({
      id: 'put-open', accountId: 'a1', symbol: 'NBIS260918P00100000', date: '2026-06-15',
      quantity: -1, pricePerUnit: 5, fees: 1, currency: 'USD',
      instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open',
    });
    seedWeekdays('AAPL', '2026-04-01', '2026-07-10', () => 100);
    seedWeekdays('NBIS', '2026-04-01', '2026-07-10', () => 110);

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state), fetchQuotes: quotes({ AAPL: 100, NBIS260918P00100000: 2.5 }) },
      '1M', ['a1'], now,
    );

    const n = r.points.length;
    // Out of the money all along: intrinsic value is zero until the live mark.
    expect(r.points[n - 2].value).toBe(100 * 100 + 100);
    expect(r.points[n - 1].value).toBe(100 * 100 + 100 - 250);
    expect(r.returns!.points[n - 1].gain - r.returns!.points[n - 2].gain).toBe(-250);
    expect(r.returns?.summary.gain).toBe(500 - 1 - 250);
  });

  it('values each day with one close when several providers stored that date', async () => {
    state.createTransaction({
      id: 'buy', accountId: 'a1', symbol: 'AAPL', date: '2026-06-01',
      quantity: 10, pricePerUnit: 100, currency: 'USD',
    });
    seedWeekdays('AAPL', '2026-04-01', '2026-07-10', () => 100);
    const history = createHistoryRepo(state);
    history.upsertBars([
      { symbol: 'AAPL', t: '2026-06-12', close: 300, source: 'stooq' },
      { symbol: 'AAPL', t: '2026-06-15', close: 300, source: 'stooq' },
    ]);

    const r = await getPortfolioHistory(
      { state, history, fetchQuotes: quotes({ AAPL: 100 }) },
      '1M', ['a1'], now,
    );

    // The Nasdaq close wins on both dates, as on the price charts.
    expect(valueAt(r.points, '2026-06-12')).toBe(10 * 100 + 100);
    expect(valueAt(r.points, '2026-06-15')).toBe(10 * 100 + 100);
    expect(r.returns?.summary.gain).toBe(0);
  });

  it('weighs money added by how long it was invested in the money-weighted return', async () => {
    state.createTransaction({
      id: 'first', accountId: 'a1', symbol: 'AAPL', date: '2026-06-01',
      quantity: 10, pricePerUnit: 100, currency: 'USD',
    });
    // Shares moved in exactly halfway through the range, just before the price rises.
    state.createTransaction({
      id: 'second', accountId: 'a1', symbol: 'AAPL', date: '2026-06-25',
      quantity: 10, pricePerUnit: 50, currency: 'USD',
    });
    seedWeekdays('AAPL', '2026-04-01', '2026-07-10', (day) => (day <= '2026-06-25' ? 100 : 120));

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state), fetchQuotes: quotes({ AAPL: 120 }) },
      '1M', ['a1'], now,
    );

    expect(r.points[0]).toMatchObject({ t: '2026-06-10', value: 1_100 });
    expect(r.points.at(-1)?.value).toBe(2_500);
    expect(r.returns?.summary.gain).toBe(400);
    expect(r.returns?.summary.netFlows).toBe(1_000);
    expect(r.returns?.summary.cumulative).toBeCloseTo(400 / 2_100, 8);
    // $1,100 at the start and $1,000 at the midpoint grow into $2,500:
    // 1,100·x² + 1,000·x = 2,500 where x = √(1 + rate).
    const x = (-1_000 + Math.sqrt(1_000 ** 2 + 4 * 1_100 * 2_500)) / (2 * 1_100);
    expect(r.returns?.summary.moneyWeighted).toBeCloseTo(x * x - 1, 6);
    expect(r.returns?.summary.moneyWeightedAnnualized).toBeNull();
  });

  it('reports trailing periods and calendar years with benchmarks and where records become complete', async () => {
    state.createAccount({ id: 'c5', name: 'C5', cashBalance: 500, currency: 'USD', accountNumber: 'X-5555' });
    state.createTransaction({
      id: 'c5-buy', accountId: 'c5', symbol: 'AAPL', date: '2024-03-01',
      quantity: 10, pricePerUnit: 100, currency: 'USD',
    });
    // Broker cash history begins later, with money already in the account.
    state.importCashHistory({
      accountId: 'c5', currency: 'USD', broker: 'fidelity', accountLast4: '5555',
      sourceHash: 'e'.repeat(64), method: 'test-eod-v1',
      rows: [{ date: '2024-10-01', cashBalance: 500 }],
    });
    const byYear = (day: string, values: [number, number, number]) => (
      day < '2025-01-01' ? values[0] : day < '2026-01-01' ? values[1] : values[2]
    );
    seedWeekdays('AAPL', '2024-02-01', '2026-07-10', (day) => byYear(day, [100, 110, 121]));
    seedWeekdays('QQQ', '2024-02-01', '2026-07-10', (day) => byYear(day, [200, 220, 242]));
    seedWeekdays('SPY', '2024-02-01', '2026-07-10', () => 400);

    const performance = await getPortfolioPerformance(
      { state, history: createHistoryRepo(state), fetchQuotes: quotes({ AAPL: 121 }) },
      ['c5'], now,
    );

    expect(performance).toMatchObject({
      supported: true, inception: '2024-03-01', asOf: '2026-07-10', completeFrom: '2024-10-01', benchmarks: ['QQQ', 'SPY'],
    });
    const period = (key: string) => performance!.periods.find((entry) => entry.key === key);
    expect(performance!.periods.map((entry) => entry.key)).toEqual(['YTD', '1Y', 'COMPLETE', 'INCEPTION']);
    expect(period('YTD')).toMatchObject({
      from: '2025-12-31', to: '2026-07-10', partial: false, startValue: 1_600, endValue: 1_710, gain: 110, netFlows: 0,
      timeWeightedAnnualized: null, moneyWeightedAnnualized: null,
    });
    expect(period('YTD')?.timeWeighted).toBeCloseTo(110 / 1_600, 8);
    expect(period('YTD')?.moneyWeighted).toBeCloseTo(110 / 1_600, 6);
    expect(period('YTD')?.benchmarks.QQQ?.return).toBeCloseTo(0.1, 8);
    expect(period('YTD')?.benchmarks.SPY).toEqual({ return: 0, annualized: null, from: '2025-12-31', to: '2026-07-10' });
    expect(period('1Y')).toMatchObject({ from: '2025-07-10', partial: false, startValue: 1_600 });
    expect(period('1Y')?.timeWeightedAnnualized).toBeCloseTo((1_710 / 1_600) ** (365.25 / 365) - 1, 6);
    expect(period('COMPLETE')).toMatchObject({ from: '2024-10-01', partial: false, startValue: 1_500 });
    expect(period('INCEPTION')).toMatchObject({ from: '2024-03-01', partial: true, gain: 210, netFlows: 0 });
    expect(period('INCEPTION')?.timeWeighted).toBeCloseTo(210 / 1_500, 8);
    expect(period('INCEPTION')?.moneyWeightedAnnualized).toBeCloseTo(period('INCEPTION')!.timeWeightedAnnualized!, 6);

    expect(performance!.years.map(({ year, ytd, partial, from, to }) => ({ year, ytd, partial, from, to }))).toEqual([
      { year: 2024, ytd: false, partial: true, from: '2024-03-01', to: '2024-12-31' },
      { year: 2025, ytd: false, partial: false, from: '2024-12-31', to: '2025-12-31' },
      { year: 2026, ytd: true, partial: false, from: '2025-12-31', to: '2026-07-10' },
    ]);
    expect(performance!.years[0].timeWeighted).toBe(0);
    expect(performance!.years[1].timeWeighted).toBeCloseTo(100 / 1_500, 8);
    expect(performance!.years[1].benchmarks.QQQ?.return).toBeCloseTo(0.1, 8);
    expect(performance!.notes).toContain('broker records are complete from 2024-10-01; periods and years that start earlier are marked partial');
  });

  it('treats an opening cash balance explained by a deposit as complete records', async () => {
    state.createAccount({ id: 'c6', name: 'C6', cashBalance: 1_000, currency: 'USD', accountNumber: 'X-1234' });
    state.importCashHistory({
      accountId: 'c6', currency: 'USD', broker: 'fidelity', accountLast4: '1234',
      sourceHash: 'f'.repeat(64), method: 'test-eod-v1',
      rows: [
        { date: '2026-06-01', cashBalance: 1_000 },
        { date: '2026-06-15', cashBalance: 1_000 },
      ],
    });
    insertCashEvent('c6', '2026-06-01', 'deposit', 1_000);

    const performance = await getPortfolioPerformance(
      { state, history: createHistoryRepo(state), fetchQuotes: quotes({}) },
      ['c6'], now,
    );

    expect(performance?.completeFrom).toBeNull();
    // YTD would start at the first point, so it is the inception period.
    expect(performance?.periods.map((entry) => entry.key)).toEqual(['INCEPTION']);
    expect(performance?.periods[0]).toMatchObject({
      from: '2026-06-01', partial: false, timeWeighted: 0, moneyWeighted: 0, gain: 0, netFlows: 0,
      benchmarks: { QQQ: null, SPY: null },
    });
    expect(performance?.years).toEqual([expect.objectContaining({ year: 2026, ytd: true, partial: true, from: '2026-06-01' })]);
    expect(performance?.notes.some((note) => note.startsWith('broker records are complete'))).toBe(false);
  });

  it('does not let money that left again explain money already in an account when its history opens', async () => {
    state.createTransaction({
      id: 'a1-buy', accountId: 'a1', symbol: 'AAPL', date: '2026-05-01',
      quantity: 10, pricePerUnit: 100, currency: 'USD',
    });
    seedWeekdays('AAPL', '2026-04-01', '2026-07-10', () => 100);
    state.createAccount({ id: 'c6', name: 'C6', cashBalance: 10_000, currency: 'USD', accountNumber: 'X-1234' });
    state.importCashHistory({
      accountId: 'c6', currency: 'USD', broker: 'fidelity', accountLast4: '1234',
      sourceHash: 'f'.repeat(64), method: 'test-eod-v1',
      rows: [
        { date: '2026-06-01', cashBalance: 10_000 },
        { date: '2026-06-15', cashBalance: 9_999 },
      ],
    });
    insertCashEvent('c6', '2026-05-20', 'deposit', 10_000);
    insertCashEvent('c6', '2026-05-25', 'tax', -10_000);
    insertCashEvent('c6', '2026-06-01', 'tax', -1);

    const performance = await getPortfolioPerformance(
      { state, history: createHistoryRepo(state), fetchQuotes: quotes({ AAPL: 100 }) },
      ['a1', 'c6'], now,
    );

    expect(performance).toMatchObject({ inception: '2026-05-01', completeFrom: '2026-06-01' });
    expect(performance?.periods.map((entry) => [entry.key, entry.from, entry.partial])).toEqual([
      ['COMPLETE', '2026-06-01', false],
      ['INCEPTION', '2026-05-01', true],
    ]);
  });

  it('has no performance report without a ledger', async () => {
    await expect(getPortfolioPerformance({ state, history: createHistoryRepo(state) }, ['a1'], now)).resolves.toBeNull();
  });
});

describe('moneyWeightedReturn', () => {
  // Money flows at thirds of a 90-day span, built from values and gains:
  // flow = -(value change - gain change), plus the start and end values.
  function series(flows: number[], end: number) {
    const days = ['2026-01-01', '2026-01-31', '2026-03-02', '2026-04-01'];
    let value = -flows[0];
    let gain = 0;
    const points = [{ t: days[0], value, costBasis: 0 }];
    const returnPoints = [{ t: days[0], cumulative: 0, gain: 0 }];
    for (let index = 1; index < days.length; index++) {
      const added = index < flows.length ? -flows[index] : 0;
      const next = index === days.length - 1 ? end : value + added;
      gain += next - value - added;
      value = next;
      points.push({ t: days[index], value, costBasis: 0 });
      returnPoints.push({ t: days[index], cumulative: 0, gain });
    }
    return { points, returnPoints };
  }

  it('solves a single deposit and growth', () => {
    const { points, returnPoints } = series([-100], 121);
    expect(moneyWeightedReturn(points, returnPoints, 0, 3)).toBeCloseTo(0.21, 8);
  });

  it('returns null when several rates fit the same money flows', () => {
    // -100, +330, -362, +132 fits 0%, 10% and 20% per third of the span.
    const spread = series([-100, 330, -362], 132);
    expect(moneyWeightedReturn(spread.points, spread.returnPoints, 0, 3)).toBeNull();
    // Two of the fitting rates (0% and 0.3%) sit too close for any scan to separate.
    const close = series([-100, 320.10, -340.22], 120.12);
    expect(moneyWeightedReturn(close.points, close.returnPoints, 0, 3)).toBeNull();
  });

  it('returns null when nothing was invested', () => {
    const { points, returnPoints } = series([0], 0);
    expect(moneyWeightedReturn(points, returnPoints, 0, 3)).toBeNull();
  });

  it('works in whole cents so same-day amounts cancel exactly', () => {
    // $100 in, $110 out halfway; on the last day $1 arrives and is the final
    // value. In floating point that day nets to -6.7e-16, a false extra flow.
    const days = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'];
    const values = [100, 100, 0.3, 0.3, 1];
    const gains = [0, 0, 10.3, 10.3, 10];
    const points = days.map((t, index) => ({ t, value: values[index], costBasis: 0 }));
    const returnPoints = days.map((t, index) => ({ t, cumulative: 0, gain: gains[index] }));
    expect(moneyWeightedReturn(points, returnPoints, 0, 4)).toBeCloseTo(0.21, 8);
  });
});

describe('portfolioHistory — long ranges', () => {
  const now = new Date('2026-05-06T20:00:00Z');

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network disabled in tests')));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const fakeFetchQuotes = async (syms: string[]) =>
    syms.map((s) => {
      const row = state.internalGetDb()
        .prepare("SELECT close FROM symbol_price_bars WHERE symbol = ? AND range_kind = 'daily' ORDER BY t DESC LIMIT 1")
        .get(s) as { close: number } | undefined;
      return {
        symbol: s,
        price: row?.close ?? 0,
        currency: 'USD',
        asOf: Date.now(),
        source: 'nasdaq' as const,
      };
    });

  function seedAapl() {
    for (let d = new Date('2026-04-01T00:00:00Z'); d <= new Date('2026-05-06T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
      if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) seedDailyBar('AAPL', d.toISOString().slice(0, 10), 150);
    }
  }

  it('5Y replays from the first recorded activity and reports partial coverage', async () => {
    const { from } = rangeBounds('5Y', now);
    state.createTransaction({
      id: 't1', accountId: 'a1', symbol: 'AAPL', date: '2026-05-01',
      quantity: 2, pricePerUnit: 100, currency: 'USD',
    });
    seedAapl();

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state), fetchQuotes: fakeFetchQuotes },
      '5Y', undefined, now,
    );
    expect(r.supported).toBe(true);
    expect(r.approximate).toBe(true);
    expect(r.source).toBe('reconstruction');
    expect(r.valueMethod).toBe('ledger_estimate');
    expect(r.points.map((point) => point.t)).toEqual(['2026-05-01', '2026-05-04', '2026-05-05', '2026-05-06']);
    expect(r.coverage).toMatchObject({ requestedFrom: from, complete: false });
  });

  it('ALL covers the documented history from the first recorded activity', async () => {
    state.createTransaction({
      id: 't1', accountId: 'a1', symbol: 'AAPL', date: '2026-05-01',
      quantity: 2, pricePerUnit: 100, currency: 'USD',
    });
    seedAapl();

    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state), fetchQuotes: fakeFetchQuotes },
      'ALL', undefined, now,
    );
    expect(r.valueMethod).toBe('ledger_estimate');
    expect(r.points[0].t).toBe('2026-05-01');
    expect(r.points.at(-1)?.t).toBe('2026-05-06');
    expect(r.coverage.complete).toBe(true);
  });
});

describe('downsampleReferencePoints', () => {
  it('preserves endpoints and a large visual peak while capping point count', () => {
    const points = Array.from({ length: 5_000 }, (_, index) => ({
      t: new Date(Date.UTC(2010, 0, 1 + index)).toISOString().slice(0, 10),
      value: index === 2_500 ? 10_000 : 1_000 + Math.sin(index / 40) * 100,
      costBasis: 900,
    }));
    const sampled = downsampleReferencePoints(points, 600);
    expect(sampled).toHaveLength(600);
    expect(sampled[0]).toEqual(points[0]);
    expect(sampled.at(-1)).toEqual(points.at(-1));
    expect(sampled.some((point) => point.value === 10_000)).toBe(true);
  });

  it('does not change a short reference series', () => {
    const points = [
      { t: '2026-01-01', value: 1, costBasis: 1 },
      { t: '2026-01-02', value: 2, costBasis: 1 },
    ];
    expect(downsampleReferencePoints(points, 600)).toEqual(points);
  });
});
