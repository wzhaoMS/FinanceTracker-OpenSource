import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NASDAQ_CHART_SOURCE, type IntradayBar } from '../providers/intradayBars.js';
import { checkIntradayLine, getPortfolioHistory } from './portfolioHistory.js';
import { createManualPriceRepo } from './manualPrices.js';
import { SqliteStateRepo } from './sqliteStateRepo.js';
import { createHistoryRepo } from './symbolHistory.js';

// Synthetic household: two stocks, an expired short put (like an assigned contract awaiting its
// closing record) and a mutual fund. No real symbols or values.
const PUT = 'SYNB261016P00100000';
const OLD = '2026-10-01T00:00:00.000Z';
const MINUTE = 60_000;

let dir: string;
let state: SqliteStateRepo;
const db = () => state.internalGetDb();

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-intraday-'));
  state = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
});

afterEach(async () => {
  state.close();
  await rm(dir, { recursive: true, force: true });
});

interface Holding { symbol: string; quantity: number; option?: boolean }
const HOLDINGS: Record<string, Holding[]> = {
  a1: [{ symbol: 'SYNA', quantity: 10 }],
  a2: [{ symbol: 'SYNB', quantity: 5 }],
  a3: [{ symbol: 'SYNA', quantity: 20 }, { symbol: PUT, quantity: -1, option: true }],
  a4: [{ symbol: 'SYNFX', quantity: 100 }],
};
const CASH: Record<string, number> = { a1: 1_000, a2: 500, a3: 2_000, a4: 300 };
const CASH_TOTAL = Object.values(CASH).reduce((sum, cash) => sum + cash, 0);
const NO_PUT: Record<string, Holding[]> = { ...HOLDINGS, a3: [HOLDINGS.a3[0]] };
const PUT_MARK = 3.5;
const NAV = 20;

function household(options: { withPut?: boolean } = {}) {
  const withPut = options.withPut ?? true;
  for (const [id, holdings] of Object.entries(HOLDINGS)) {
    state.createAccount({ id, name: id.toUpperCase(), cashBalance: CASH[id], currency: 'USD' });
    holdings.forEach((holding, index) => {
      if (holding.option && !withPut) return;
      state.createTransaction({
        id: `${id}-${index}`, accountId: id, symbol: holding.symbol, date: '2026-09-01',
        quantity: holding.quantity, pricePerUnit: holding.option ? 2 : 10, currency: 'USD',
        ...(holding.option ? { instrumentType: 'option' as const, contractMultiplier: 100, positionEffect: 'open' as const } : {}),
      });
    });
  }
  createHistoryRepo(state).upsertBars(['2026-10-15', '2026-10-30', '2026-11-24'].map((t) => ({ symbol: 'SYNFX', t, close: NAV, source: 'nasdaq' as const })));
  settle(OLD);
}

/** Every ledger, cash and history change happened at `at`. */
function settle(at: string) {
  db().prepare('UPDATE accounts SET updated_at = ?').run(at);
  db().prepare('UPDATE transactions SET created_at = ?, updated_at = ?').run(at, at);
  db().prepare('DELETE FROM account_history_invalidations').run();
}

/** Synthetic prices: SYNA drifts up a cent a minute, SYNB swings, both from 4:00 AM ET on the day. */
function price(symbol: string, at: number, dayStart: number): number {
  const minutes = (at - dayStart) / MINUTE;
  if (symbol === 'SYNA') return 100 + minutes * 0.01;
  if (symbol === 'SYNB') return 50 + Math.sin(minutes / 30);
  throw new Error(symbol);
}

/** The value of the given holdings and cash at `at`, as the snapshot job and the line count it. */
function worth(holdings: Record<string, Holding[]>, cash: Record<string, number>, at: number, dayStart: number, ids = Object.keys(holdings)) {
  let value = 0;
  for (const id of ids) {
    value += cash[id];
    for (const holding of holdings[id]) {
      if (holding.symbol === 'SYNFX') value += holding.quantity * NAV;
      else if (holding.option) value += holding.quantity * 100 * PUT_MARK;
      else value += holding.quantity * price(holding.symbol, at, dayStart);
    }
  }
  return value;
}

/** One snapshot job tick: each account's value from the holdings and cash it then had, and a bar per quote. */
function jobTick(t: string, dayStart: number, holdings = HOLDINGS, cash = CASH, options: { putMark?: boolean } = {}) {
  const at = Date.parse(t);
  const snapshot = db().prepare(
    `INSERT INTO account_snapshots (id, account_id, taken_at, market_value, cost_basis, cash_balance) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const bar = db().prepare(`INSERT OR IGNORE INTO symbol_price_bars (symbol, range_kind, t, close, source) VALUES (?, 'intraday', ?, ?, ?)`);
  for (const id of Object.keys(holdings)) {
    snapshot.run(`snap-${id}-${t}`, id, t, worth(holdings, cash, at, dayStart, [id]), cash[id], cash[id]);
  }
  bar.run('SYNA', t, price('SYNA', at, dayStart), 'nasdaq');
  bar.run('SYNB', t, price('SYNB', at, dayStart), 'nasdaq');
  bar.run('SYNFX', t, NAV, 'nasdaq');
  if (options.putMark) bar.run(PUT, t, PUT_MARK, 'cboe');
}

/** An import's own capture: only the accounts it read. */
function importCapture(t: string, ids: string[]) {
  for (const id of ids) {
    db().prepare(
      `INSERT INTO account_snapshots (id, account_id, taken_at, market_value, cost_basis, cash_balance) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(`imp-${id}-${t}`, id, t, 1, 1, 1);
  }
}

const every = (from: string, to: string, stepMinutes = 5) => {
  const out: string[] = [];
  for (let at = Date.parse(from); at <= Date.parse(to); at += stepMinutes * MINUTE) out.push(new Date(at).toISOString());
  return out;
};

/** A public chart's 1-minute bars of SYNA and SYNB between two instants. */
function chart(from: string, to: string, dayStart: number, skip: (symbol: string, at: number) => boolean = () => false) {
  return vi.fn(async (symbol: string): Promise<IntradayBar[]> => {
    if (symbol !== 'SYNA' && symbol !== 'SYNB') return [];
    return every(from, to, 1)
      .filter((t) => !skip(symbol, Date.parse(t)))
      .map((t) => ({ symbol, t, close: price(symbol, Date.parse(t), dayStart), source: NASDAQ_CHART_SOURCE }));
  });
}

const deps = (intradayBars?: ReturnType<typeof chart>) => ({ state, history: createHistoryRepo(state), ...(intradayBars ? { intradayBars } : {}) });

// Monday 2026-10-19, New York on daylight time: 4:00 AM ET is 08:00Z, 9:30 AM is 13:30Z.
const MONDAY = Date.parse('2026-10-19T08:00:00.000Z');
const FRIDAY = Date.parse('2026-10-16T08:00:00.000Z');

/** Monday as on 10/19: Friday evening ticks, imports at 9:28:57 and 11:27:27 AM, ticks from 12:45 PM missing 1:30 and 1:35, a first-baseline capture at 1:58:58. */
function october19(holdings = HOLDINGS, cash = CASH) {
  for (const t of ['2026-10-16T23:50:00.000Z', '2026-10-16T23:55:00.000Z']) jobTick(t, FRIDAY, holdings, cash, { putMark: true });
  importCapture('2026-10-19T13:28:57.000Z', ['a1', 'a2', 'a3']);
  importCapture('2026-10-19T15:27:27.000Z', ['a1', 'a2']);
  const ticks = every('2026-10-19T16:45:00.000Z', '2026-10-19T18:00:00.000Z')
    .filter((t) => t !== '2026-10-19T17:30:00.000Z' && t !== '2026-10-19T17:35:00.000Z');
  for (const t of ticks) jobTick(t, MONDAY, holdings, cash);
  importCapture('2026-10-19T17:58:58.000Z', ['a1', 'a2', 'a3']);
  return ticks;
}

describe('1D computed from holdings at market prices', () => {
  it('draws a day like 10/19 as one continuous session from 4:00 AM, equal to every recorded tick', async () => {
    household();
    const ticks = october19();
    const fetchBars = chart('2026-10-19T08:00:00.000Z', '2026-10-19T18:01:00.000Z', MONDAY);
    const now = new Date('2026-10-19T18:01:00.000Z');

    const r = await getPortfolioHistory(deps(fetchBars), '1D', undefined, now);

    expect(r).toMatchObject({ valueMethod: 'holdings_at_market', source: 'intraday_prices', from: '2026-10-19', approximate: false });
    expect(r.window).toEqual({ from: '2026-10-19T08:00:00.000Z', to: '2026-10-19T20:00:00.000Z' });
    expect(r.points.map((point) => point.t)).toEqual(every('2026-10-19T08:00:00.000Z', '2026-10-19T18:00:00.000Z'));
    expect(r.points.some((point) => point.gapBefore || point.estimated || point.unreliable)).toBe(false);
    for (const point of r.points) expect(point.value).toBeCloseTo(worth(HOLDINGS, CASH, Date.parse(point.t), MONDAY), 6);
    // The restart's holes are priced, and the imports' partial captures are no points of their own.
    expect(r.points.some((point) => point.t === '2026-10-19T17:30:00.000Z')).toBe(true);
    expect(r.points.some((point) => point.t.endsWith(':57.000Z') || point.t.endsWith(':27.000Z'))).toBe(false);
    expect(r.approximationReasons).toContain(
      `checked against ${ticks.length} recorded snapshots taken since the latest change to these accounts: ${ticks.length} within 0.1%, 0 within 0.5%, 0 over 0.5%`,
    );
    expect(r.approximationReasons).toContain('options at the last mark the snapshot job recorded, carried forward');
    expect(r.approximationReasons).toContain('mutual funds at their latest NAV');
    expect(r.summary.startValue).toBeCloseTo(r.points[0].value, 6);
    // Only public chart symbols are asked for; never the option or the fund, and once per five minutes.
    expect(fetchBars.mock.calls.map(([symbol]) => symbol).sort()).toEqual(['SYNA', 'SYNB']);
    await getPortfolioHistory(deps(fetchBars), '1D', undefined, new Date('2026-10-19T18:03:00.000Z'));
    expect(fetchBars).toHaveBeenCalledTimes(2);
  });

  it('never steps at a bridge and cash correction mid-session: the session is valued at the current holdings and cash', async () => {
    household();
    // Before 2:55 PM ET the job recorded the old holdings and cash.
    october19();
    for (const t of every('2026-10-19T18:05:00.000Z', '2026-10-19T18:50:00.000Z')) jobTick(t, MONDAY);
    // At 2:55 PM the bridge applies: +300 SYNB, the assigned put closes, the cash pays for the shares.
    const bridged = '2026-10-19T18:55:10.000Z';
    state.createTransaction({ id: 'bridge-shares', accountId: 'a3', symbol: 'SYNB', date: '2026-10-19', quantity: 300, pricePerUnit: 100, currency: 'USD' });
    state.createTransaction({
      id: 'bridge-put', accountId: 'a3', symbol: PUT, date: '2026-10-19', quantity: 1, pricePerUnit: 0, currency: 'USD',
      instrumentType: 'option', contractMultiplier: 100, positionEffect: 'close',
    });
    const cashAfter = { ...CASH, a3: CASH.a3 - 30_000 };
    db().prepare('UPDATE accounts SET cash_balance = ? WHERE id = ?').run(cashAfter.a3, 'a3');
    settle(OLD);
    db().prepare('UPDATE accounts SET updated_at = ? WHERE id = ?').run(bridged, 'a3');
    db().prepare('UPDATE transactions SET created_at = ?, updated_at = ? WHERE id LIKE ?').run(bridged, bridged, 'bridge-%');
    const invalidation = db().prepare(
      `INSERT INTO account_history_invalidations (account_id, effective_date, detected_at, reason) VALUES ('a3', '2026-10-19', ?, ?)`,
    );
    invalidation.run(bridged, 'fidelity investing cash adopted');
    invalidation.run(bridged, 'fidelity investing activity imported');
    const after = { ...HOLDINGS, a3: [{ symbol: 'SYNA', quantity: 20 }, { symbol: 'SYNB', quantity: 300 }] };
    const fresh = every('2026-10-19T19:00:00.000Z', '2026-10-19T19:30:00.000Z');
    for (const t of fresh) jobTick(t, MONDAY, after, cashAfter);
    const now = new Date('2026-10-19T19:31:00.000Z');

    const r = await getPortfolioHistory(deps(chart('2026-10-19T08:00:00.000Z', now.toISOString(), MONDAY)), '1D', undefined, now);

    expect(r.valueMethod).toBe('holdings_at_market');
    // Every point at today's holdings and cash: no step at 2:55, and the change is price movement alone.
    for (const point of r.points) expect(point.value).toBeCloseTo(worth(after, cashAfter, Date.parse(point.t), MONDAY), 6);
    expect(r.points.some((point) => point.unreliable)).toBe(false);
    expect(r.summary.change).toBeCloseTo(
      worth(after, cashAfter, Date.parse('2026-10-19T19:30:00.000Z'), MONDAY) - worth(after, cashAfter, MONDAY, MONDAY), 6,
    );
    // Only the ticks taken after the bridge check the line; the stale ones before it neither check nor replace it.
    // The first one stamped after it may have started before it (ticks are stamped at their nearest 5 minutes).
    expect(r.approximationReasons).toContain(
      `checked against ${fresh.length - 1} recorded snapshots taken since the latest change to these accounts: ${fresh.length - 1} within 0.1%, 0 within 0.5%, 0 over 0.5%`,
    );
    expect(r.approximationReasons).toContain('activity dated this session counts from its start: trade times are not recorded');
  });

  it('carries the last prices forward when no chart prices arrive, and marks the long carry estimated', async () => {
    household();
    const ticks = october19();
    const now = new Date('2026-10-19T18:01:00.000Z');

    const r = await getPortfolioHistory(deps(chart('2026-10-19T08:00:00.000Z', '2026-10-19T08:00:00.000Z', MONDAY, () => true)), '1D', undefined, now);

    // No prices before the first tick: the regular session from 9:30 AM, at Friday's last prices.
    expect(r.window).toEqual({ from: '2026-10-19T13:30:00.000Z', to: '2026-10-19T20:00:00.000Z' });
    expect(r.points.map((point) => point.t)).toEqual(every('2026-10-19T13:30:00.000Z', '2026-10-19T18:00:00.000Z'));
    const fridayClose = Date.parse('2026-10-16T23:55:00.000Z');
    expect(r.points[0].value).toBeCloseTo(worth(HOLDINGS, CASH, fridayClose, FRIDAY), 6);
    expect(r.points.filter((point) => point.estimated).map((point) => point.t)).toEqual(every('2026-10-19T13:30:00.000Z', '2026-10-19T16:40:00.000Z'));
    // The restart's two missed ticks carry the last tick's prices for 5 and 10 minutes: not estimated.
    expect(r.points.find((point) => point.t === '2026-10-19T17:35:00.000Z')).toMatchObject({
      value: expect.closeTo(worth(HOLDINGS, CASH, Date.parse('2026-10-19T17:25:00.000Z'), MONDAY), 6),
    });
    expect(r.points.find((point) => point.t === '2026-10-19T17:35:00.000Z')?.estimated).toBeUndefined();
    expect(r.approximationReasons).toContain('39 points estimated: holdings worth over 1% of the value had no price for more than 30 minutes');
    expect(r.approximationReasons.some((reason) => reason.startsWith(`checked against ${ticks.length} recorded snapshots`))).toBe(true);
  });

  it('keeps a halted symbol at its last price, estimated after 30 minutes, and never breaks the line', async () => {
    household({ withPut: false });
    const halted = (symbol: string, at: number) => symbol === 'SYNB' && at >= Date.parse('2026-10-19T14:30:00.000Z') && at < Date.parse('2026-10-19T16:00:00.000Z');
    const now = new Date('2026-10-19T16:31:00.000Z');

    const r = await getPortfolioHistory(deps(chart('2026-10-19T08:00:00.000Z', now.toISOString(), MONDAY, halted)), '1D', undefined, now);

    expect(r.points.map((point) => point.t)).toEqual(every('2026-10-19T08:00:00.000Z', '2026-10-19T16:30:00.000Z'));
    const lastTrade = Date.parse('2026-10-19T14:29:00.000Z');
    const during = r.points.find((point) => point.t === '2026-10-19T15:30:00.000Z')!;
    expect(during.value).toBeCloseTo(
      CASH_TOTAL + 30 * price('SYNA', Date.parse(during.t), MONDAY) + 5 * price('SYNB', lastTrade, MONDAY) + 100 * NAV, 6,
    );
    // Estimated once the halted price is over 30 minutes old (from 3:00 PM UTC), not after trading resumes.
    expect(r.points.filter((point) => point.estimated).map((point) => point.t)).toEqual(every('2026-10-19T15:00:00.000Z', '2026-10-19T15:55:00.000Z'));
  });

  it('places an EST session from 4:00 AM to 4:00 PM New York time', async () => {
    household({ withPut: false });
    const monday = Date.parse('2026-11-02T09:00:00.000Z');
    const now = new Date('2026-11-02T19:01:00.000Z');

    const r = await getPortfolioHistory(deps(chart('2026-11-02T09:00:00.000Z', now.toISOString(), monday)), '1D', undefined, now);

    expect(r.window).toEqual({ from: '2026-11-02T09:00:00.000Z', to: '2026-11-02T21:00:00.000Z' });
    expect(r.points[0]).toMatchObject({ t: '2026-11-02T09:00:00.000Z', value: expect.closeTo(worth(NO_PUT, CASH, monday, monday), 6) });
    expect(r.points.at(-1)?.t).toBe('2026-11-02T19:00:00.000Z');
  });

  it('shows Friday on a Saturday, asking once for the prices of the ticks Friday missed', async () => {
    household({ withPut: false });
    // Friday's job ran only in regular hours: the pre-market and after-hours ticks are missing.
    const ticks = every('2026-10-16T13:30:00.000Z', '2026-10-16T20:00:00.000Z');
    for (const t of ticks) jobTick(t, FRIDAY, NO_PUT);
    const fetchBars = chart('2026-10-16T08:00:00.000Z', '2026-10-17T00:00:00.000Z', FRIDAY);

    const r = await getPortfolioHistory(deps(fetchBars), '1D', undefined, new Date('2026-10-17T16:00:00.000Z'));

    expect(fetchBars.mock.calls.map(([symbol]) => symbol).sort()).toEqual(['SYNA', 'SYNB']);
    expect(r).toMatchObject({ from: '2026-10-16', window: { from: '2026-10-16T08:00:00.000Z', to: '2026-10-17T00:00:00.000Z' } });
    expect(r.points.map((point) => point.t)).toEqual(every('2026-10-16T08:00:00.000Z', '2026-10-17T00:00:00.000Z'));
    for (const point of r.points) expect(point.value).toBeCloseTo(worth(NO_PUT, CASH, Date.parse(point.t), FRIDAY), 6);
    expect(r.points.some((point) => point.estimated)).toBe(false);
    // The first tick stamped after the last change may have started before it.
    expect(r.approximationReasons).toContain(`checked against ${ticks.length - 1} recorded snapshots taken since the latest change to these accounts: ${ticks.length - 1} within 0.1%, 0 within 0.5%, 0 over 0.5%`);
    await getPortfolioHistory(deps(fetchBars), '1D', undefined, new Date('2026-10-18T16:00:00.000Z'));
    expect(fetchBars).toHaveBeenCalledTimes(2);
  });

  it('asks for no prices before the session, or on a weekend, when the last session has every tick', async () => {
    household({ withPut: false });
    for (const t of every('2026-10-16T08:05:00.000Z', '2026-10-17T00:00:00.000Z')) jobTick(t, FRIDAY, NO_PUT);
    const fetchBars = chart('2026-10-16T08:00:00.000Z', '2026-10-17T00:00:00.000Z', FRIDAY);

    const saturday = await getPortfolioHistory(deps(fetchBars), '1D', undefined, new Date('2026-10-17T16:00:00.000Z'));
    const mondayEarly = await getPortfolioHistory(deps(fetchBars), '1D', undefined, new Date('2026-10-19T07:00:00.000Z'));

    expect(fetchBars).not.toHaveBeenCalled();
    for (const r of [saturday, mondayEarly]) {
      expect(r).toMatchObject({ valueMethod: 'holdings_at_market', from: '2026-10-16', window: { from: '2026-10-16T08:05:00.000Z', to: '2026-10-17T00:00:00.000Z' } });
    }
  });

  it('shows the last session on a market holiday, from the prices the chart serves for it', async () => {
    household({ withPut: false });
    // Thanksgiving: the chart still serves Wednesday's session, with after-hours prices.
    const wednesday = Date.parse('2026-11-25T09:00:00.000Z');
    const fetchBars = chart('2026-11-25T09:00:00.000Z', '2026-11-26T01:00:00.000Z', wednesday);

    const r = await getPortfolioHistory(deps(fetchBars), '1D', undefined, new Date('2026-11-26T16:00:00.000Z'));

    expect(fetchBars).toHaveBeenCalled();
    expect(r).toMatchObject({ from: '2026-11-25', window: { from: '2026-11-25T09:00:00.000Z', to: '2026-11-26T01:00:00.000Z' } });
    expect(r.points.at(-1)?.t).toBe('2026-11-26T01:00:00.000Z');
    expect(r.approximationReasons).toContain('no recorded snapshot taken since the latest change to these accounts to check against');
  });

  it('shows a recorded snapshot that disagrees by over 0.5% at its recorded value, and the recorded snapshots when many do', async () => {
    household();
    const ticks = october19();
    const now = new Date('2026-10-19T18:01:00.000Z');
    const fetchBars = () => chart('2026-10-19T08:00:00.000Z', now.toISOString(), MONDAY);
    db().prepare('UPDATE account_snapshots SET market_value = market_value * 1.02 WHERE taken_at = ? AND account_id = ?')
      .run('2026-10-19T17:00:00.000Z', 'a3');

    const one = await getPortfolioHistory(deps(fetchBars()), '1D', undefined, now);

    const recorded = (db().prepare('SELECT SUM(market_value) FROM account_snapshots WHERE taken_at = ?').pluck().get('2026-10-19T17:00:00.000Z')) as number;
    expect(one.valueMethod).toBe('holdings_at_market');
    expect(one.points.find((point) => point.t === '2026-10-19T17:00:00.000Z')?.value).toBeCloseTo(recorded, 6);
    expect(one.approximationReasons).toContain(
      `checked against ${ticks.length} recorded snapshots taken since the latest change to these accounts: ${ticks.length - 1} within 0.1%, 0 within 0.5%, 1 over 0.5% (shown at the recorded value)`,
    );

    db().prepare('UPDATE account_snapshots SET market_value = market_value * 1.1 WHERE account_id = ? AND taken_at >= ?')
      .run('a1', '2026-10-19T16:45:00.000Z');
    const many = await getPortfolioHistory(deps(fetchBars()), '1D', undefined, now);
    expect(many.valueMethod).toBe('observed_snapshot');
    const check = await checkIntradayLine(deps(), now);
    expect(check).toMatchObject({ sessionDate: '2026-10-19', compared: ticks.length, passed: false });
  });

  it('values only the accounts in scope', async () => {
    household();
    october19();
    const now = new Date('2026-10-19T18:01:00.000Z');

    const r = await getPortfolioHistory(deps(chart('2026-10-19T08:00:00.000Z', now.toISOString(), MONDAY)), '1D', ['a1'], now);

    expect(r.valueMethod).toBe('holdings_at_market');
    for (const point of r.points) expect(point.value).toBeCloseTo(worth(HOLDINGS, CASH, Date.parse(point.t), MONDAY, ['a1']), 6);
  });

  it('checks the line only with ticks that started after the latest change, though stamped at their nearest 5 minutes', async () => {
    household({ withPut: false });
    for (const t of every('2026-10-19T16:45:00.000Z', '2026-10-19T18:50:00.000Z')) jobTick(t, MONDAY, NO_PUT);
    // A cash correction at 2:54 PM; the tick that started at 2:52:40 read the cash before it and is stamped 2:55.
    jobTick('2026-10-19T18:55:00.000Z', MONDAY, NO_PUT);
    const corrected = { ...CASH, a2: CASH.a2 + 5_000 };
    db().prepare('UPDATE accounts SET cash_balance = ?, updated_at = ? WHERE id = ?').run(corrected.a2, '2026-10-19T18:54:00.000Z', 'a2');
    const fresh = every('2026-10-19T19:00:00.000Z', '2026-10-19T19:45:00.000Z');
    for (const t of fresh) jobTick(t, MONDAY, NO_PUT, corrected);
    const now = new Date('2026-10-19T19:46:00.000Z');

    const r = await getPortfolioHistory(deps(chart('2026-10-19T08:00:00.000Z', now.toISOString(), MONDAY)), '1D', undefined, now);

    expect(r.valueMethod).toBe('holdings_at_market');
    // The corrected cash all session: the stale 2:55 tick neither checks nor replaces the line.
    for (const point of r.points) expect(point.value).toBeCloseTo(worth(NO_PUT, corrected, Date.parse(point.t), MONDAY), 6);
    expect(r.approximationReasons).toContain(
      `checked against ${fresh.length} recorded snapshots taken since the latest change to these accounts: ${fresh.length} within 0.1%, 0 within 0.5%, 0 over 0.5%`,
    );
  });

  it('checks the line only with ticks that observed every account, however new', async () => {
    household({ withPut: false });
    // An account the job has never recorded yet.
    state.createAccount({ id: 'a5', name: 'A5', cashBalance: 700, currency: 'USD' });
    state.createTransaction({ id: 'a5-0', accountId: 'a5', symbol: 'SYNB', date: '2026-10-19', quantity: 40, pricePerUnit: 10, currency: 'USD' });
    settle(OLD);
    for (const t of every('2026-10-19T16:45:00.000Z', '2026-10-19T18:00:00.000Z')) jobTick(t, MONDAY, NO_PUT);
    const now = new Date('2026-10-19T18:01:00.000Z');

    const r = await getPortfolioHistory(deps(chart('2026-10-19T08:00:00.000Z', now.toISOString(), MONDAY)), '1D', undefined, now);

    expect(r.valueMethod).toBe('holdings_at_market');
    const withNew = { ...NO_PUT, a5: [{ symbol: 'SYNB', quantity: 40 }] };
    for (const point of r.points) expect(point.value).toBeCloseTo(worth(withNew, { ...CASH, a5: 700 }, Date.parse(point.t), MONDAY), 6);
    expect(r.approximationReasons).toContain('no recorded snapshot taken since the latest change to these accounts to check against');
  });

  it('carries a price from before the look-back forward, never the trade price', async () => {
    household({ withPut: false });
    // SYNC was bought at 20 and last traded at 100 on 10/1; SYND has only an owner's price from September.
    state.createTransaction({ id: 'a1-c', accountId: 'a1', symbol: 'SYNC', date: '2026-09-01', quantity: 10, pricePerUnit: 20, currency: 'USD' });
    state.createTransaction({ id: 'a1-d', accountId: 'a1', symbol: 'SYND', date: '2026-09-01', quantity: 10, pricePerUnit: 30, currency: 'USD' });
    settle(OLD);
    db().prepare(`INSERT INTO symbol_price_bars (symbol, range_kind, t, close, source) VALUES ('SYNC', 'intraday', '2026-10-01T19:55:00.000Z', 100, 'nasdaq')`).run();
    const manualPrices = createManualPriceRepo(state);
    manualPrices.upsert({ symbol: 'SYND', date: '2026-09-20', close: 70 });
    const now = new Date('2026-10-19T18:01:00.000Z');

    const r = await getPortfolioHistory({ ...deps(chart('2026-10-19T08:00:00.000Z', now.toISOString(), MONDAY)), manualPrices }, '1D', undefined, now);

    expect(r.valueMethod).toBe('holdings_at_market');
    for (const point of r.points) {
      expect(point.value).toBeCloseTo(worth(NO_PUT, CASH, Date.parse(point.t), MONDAY) + 10 * 100 + 10 * 70, 6);
    }
    // Both prices are weeks old: estimated in regular hours.
    expect(r.points.find((point) => point.t === '2026-10-19T15:00:00.000Z')?.estimated).toBe(true);
  });

  it('prefers the recorded quote to a chart price at the same instant, before the look-back or before its first price', async () => {
    household({ withPut: false });
    for (const symbol of ['SYNC', 'SYND']) {
      state.createTransaction({ id: `a1-${symbol}`, accountId: 'a1', symbol, date: '2026-09-01', quantity: 10, pricePerUnit: 20, currency: 'USD' });
    }
    settle(OLD);
    const bar = db().prepare(`INSERT INTO symbol_price_bars (symbol, range_kind, t, close, source) VALUES (?, 'intraday', ?, ?, ?)`);
    // SYNC was last priced on 10/1, before the look-back; SYND is first priced at 1:00 PM today.
    for (const [symbol, t] of [['SYNC', '2026-10-01T19:55:00.000Z'], ['SYND', '2026-10-19T17:00:00.000Z']]) {
      bar.run(symbol, t, 100, 'nasdaq');
      bar.run(symbol, t, 105, NASDAQ_CHART_SOURCE);
    }
    const now = new Date('2026-10-19T18:01:00.000Z');

    const r = await getPortfolioHistory(deps(chart('2026-10-19T08:00:00.000Z', now.toISOString(), MONDAY)), '1D', undefined, now);

    expect(r.valueMethod).toBe('holdings_at_market');
    for (const point of r.points) {
      expect(point.value).toBeCloseTo(worth(NO_PUT, CASH, Date.parse(point.t), MONDAY) + 10 * 100 + 10 * 100, 6);
    }
  });

  it('fetches each symbol once and at most six at a time, however many requests ask together', async () => {
    const symbols = ['SYN1', 'SYN2', 'SYN3', 'SYN4', 'SYN5', 'SYN6', 'SYN7'];
    state.createAccount({ id: 'a1', name: 'A1', cashBalance: 0, currency: 'USD' });
    symbols.forEach((symbol, index) => state.createTransaction({
      id: `t${index}`, accountId: 'a1', symbol, date: '2026-09-01', quantity: 1, pricePerUnit: 10, currency: 'USD',
    }));
    settle(OLD);
    let running = 0;
    let most = 0;
    const fetchBars = vi.fn(async (symbol: string): Promise<IntradayBar[]> => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
      return every('2026-10-19T08:00:00.000Z', '2026-10-19T18:00:00.000Z', 1).map((t) => ({ symbol, t, close: 10, source: NASDAQ_CHART_SOURCE }));
    });
    const now = new Date('2026-10-19T18:01:00.000Z');

    const [all, one] = await Promise.all([
      getPortfolioHistory(deps(fetchBars), '1D', undefined, now),
      getPortfolioHistory(deps(fetchBars), '1D', ['a1'], now),
    ]);

    expect(fetchBars.mock.calls.map(([symbol]) => symbol).sort()).toEqual(symbols);
    expect(most).toBeLessThanOrEqual(6);
    // The second request waited for the first one's fetches, so both lines are priced.
    for (const r of [all, one]) expect(r).toMatchObject({ valueMethod: 'holdings_at_market', from: '2026-10-19' });
  });

  it('leaves a household without intraday prices, or without holdings, to the recorded snapshots', async () => {
    state.createAccount({ id: 'cash', name: 'Cash', cashBalance: 100, currency: 'USD' });
    db().prepare(`INSERT INTO account_snapshots (id, account_id, taken_at, market_value, cost_basis, cash_balance)
      VALUES ('s1', 'cash', '2026-10-19T17:00:00.000Z', 100, 100, 100), ('s2', 'cash', '2026-10-19T17:05:00.000Z', 100, 100, 100)`).run();
    const now = new Date('2026-10-19T17:06:00.000Z');
    expect((await getPortfolioHistory(deps(), '1D', undefined, now)).valueMethod).toBe('observed_snapshot');

    household();
    expect((await getPortfolioHistory(deps(), '1D', undefined, now)).valueMethod).toBe('observed_snapshot');
    expect(await checkIntradayLine(deps(), now)).toBeNull();
  });
});
