import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CNBC_CHART_SOURCE, CNBC_WEEK_CHART_SOURCE, NASDAQ_CHART_SOURCE, type IntradayBar } from '../providers/intradayBars.js';
import { checkIntradayLine, getPortfolioHistory } from './portfolioHistory.js';
import { SqliteStateRepo } from './sqliteStateRepo.js';
import { createHistoryRepo } from './symbolHistory.js';

// A synthetic week on New York daylight time: Monday 2026-10-12 to Friday 2026-10-16, seen on Friday
// at 2:01 PM ET. No real symbols or values.
const NOW = new Date('2026-10-16T18:01:00.000Z');
const DAYS = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'];
const MONDAY = Date.parse('2026-10-12T08:00:00.000Z');
const OLD = '2026-10-01T00:00:00.000Z';
const MINUTE = 60_000;
const PUT = 'SYNB261120P00050000';

let dir: string;
let state: SqliteStateRepo;
const db = () => state.internalGetDb();

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-intraday-week-'));
  state = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
  // Prices come only from the stubs below; anything else, such as the snapshot view's backtest, gets no network.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('the tests do not reach the network'); }));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  state.close();
  await rm(dir, { recursive: true, force: true });
});

/** Synthetic prices across the week: SYNA drifts up, SYNB swings below 50, SYNC creeps up. */
function price(symbol: string, at: number): number {
  const minutes = (at - MONDAY) / MINUTE;
  if (symbol === 'SYNA') return 100 + minutes * 0.001;
  if (symbol === 'SYNB') return 40 + Math.sin(minutes / 60);
  if (symbol === 'SYNC') return 30 + minutes * 0.0005;
  throw new Error(symbol);
}
const A = (at: number) => price('SYNA', at);
const B = (at: number) => price('SYNB', at);

const CASH = { a1: 1_000, a2: 5_000 };
const CASH_TOTAL = CASH.a1 + CASH.a2;

function trade(id: string, accountId: string, symbol: string, date: string, quantity: number, pricePerUnit: number, extra: Record<string, unknown> = {}) {
  state.createTransaction({ id, accountId, symbol, date, quantity, pricePerUnit, currency: 'USD', ...extra });
}

/** Two accounts holding 10 SYNA and 5 SYNB since September. */
function household() {
  state.createAccount({ id: 'a1', name: 'A1', cashBalance: CASH.a1, currency: 'USD' });
  state.createAccount({ id: 'a2', name: 'A2', cashBalance: CASH.a2, currency: 'USD' });
  trade('a1-0', 'a1', 'SYNA', '2026-09-01', 10, 50);
  trade('a2-0', 'a2', 'SYNB', '2026-09-01', 5, 30);
  settle();
}

/** Every ledger, cash and history change happened on 10/1. */
function settle() {
  db().prepare('UPDATE accounts SET updated_at = ?').run(OLD);
  db().prepare('UPDATE transactions SET created_at = ?, updated_at = ?').run(OLD, OLD);
  db().prepare('DELETE FROM account_history_invalidations').run();
}

const every = (from: string, to: string, stepMinutes: number) => {
  const out: string[] = [];
  for (let at = Date.parse(from); at <= Date.parse(to); at += stepMinutes * MINUTE) out.push(new Date(at).toISOString());
  return out;
};
const nextDay = (day: string) => new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
/** 4:00 AM to 8:00 PM ET of a day (UTC on daylight time). */
const session = (day: string, step: number) => every(`${day}T08:00:00.000Z`, `${nextDay(day)}T00:00:00.000Z`, step);

/** CNBC's five-day chart: 5-minute bars of the week's sessions. */
function weekChart(symbols = ['SYNA', 'SYNB']) {
  return vi.fn(async (symbol: string): Promise<IntradayBar[]> => (symbols.includes(symbol)
    ? DAYS.flatMap((day) => session(day, 5)).map((t) => ({ symbol, t, close: price(symbol, Date.parse(t)), source: CNBC_WEEK_CHART_SOURCE }))
    : []));
}

/** Nasdaq's chart of today: 1-minute bars from 4:00 AM ET to now. */
function dayChart(symbols = ['SYNA', 'SYNB']) {
  return vi.fn(async (symbol: string): Promise<IntradayBar[]> => (symbols.includes(symbol)
    ? every('2026-10-16T08:00:00.000Z', NOW.toISOString(), 1).map((t) => ({ symbol, t, close: price(symbol, Date.parse(t)), source: NASDAQ_CHART_SOURCE }))
    : []));
}

function deps(intradayBars?: ReturnType<typeof dayChart>, intradayWeekBars?: ReturnType<typeof weekChart>) {
  return {
    state,
    history: createHistoryRepo(state),
    ...(intradayBars ? { intradayBars } : {}),
    ...(intradayWeekBars ? { intradayWeekBars } : {}),
  };
}

/** The week's points: every ten minutes from 4:00 AM to 8:00 PM ET, and today's up to 2:00 PM. */
const WEEK_TIMES = [
  ...DAYS.slice(0, 4).flatMap((day) => session(day, 10)),
  ...every('2026-10-16T08:00:00.000Z', '2026-10-16T18:00:00.000Z', 10),
];
const dayOf = (t: string) => {
  const at = Date.parse(t);
  return DAYS.find((day) => at >= Date.parse(`${day}T08:00:00.000Z`) && at <= Date.parse(`${nextDay(day)}T00:00:00.000Z`))!;
};

function cashEvent(id: string, accountId: string, date: string, type: string, amount: number) {
  db().prepare(
    `INSERT INTO account_cash_events (id, account_id, event_date, event_type, amount, currency, broker, account_last4, description, source_fingerprint)
     VALUES (?, ?, ?, ?, ?, 'USD', 'synthetic', '0000', 'synthetic', ?)`,
  ).run(id, accountId, date, type, amount, `fp-${id}`);
}

describe('1W computed from each day\'s holdings at market prices', () => {
  it('draws the last five sessions every ten minutes from 4:00 AM, asking each chart once per symbol', async () => {
    household();
    const week = weekChart();
    const day = dayChart();

    const r = await getPortfolioHistory(deps(day, week), '1W', undefined, NOW);

    expect(r).toMatchObject({ range: '1W', valueMethod: 'holdings_at_market', source: 'intraday_prices', from: '2026-10-12', to: '2026-10-16' });
    // Side by side on the x-axis: no session window, so nights and the weekend take no room.
    expect(r.window).toBeUndefined();
    expect(r.points.map((point) => point.t)).toEqual(WEEK_TIMES);
    for (const point of r.points) expect(point.value).toBeCloseTo(CASH_TOTAL + 10 * A(Date.parse(point.t)) + 5 * B(Date.parse(point.t)), 6);
    expect(r.points.some((point) => point.estimated || point.unreliable || point.gapBefore)).toBe(false);
    expect(r.approximationReasons[0]).toMatch(/^computed every 10 minutes over the last 5 sessions from each day's holdings/);
    expect(r.approximationReasons.some((reason) => /share transaction|synced from Fidelity|recorded deposit/.test(reason))).toBe(false);
    expect(r.returns?.points).toHaveLength(r.points.length);
    // The return series is in cents.
    expect(r.returns?.summary.netFlows).toBeCloseTo(0, 2);
    expect(r.returns?.summary.gain).toBeCloseTo(r.points.at(-1)!.value - r.points[0].value, 2);
    // Past sessions from the five-day chart, today from the 1-minute one: once per public symbol.
    expect(week.mock.calls.map(([symbol]) => symbol).sort()).toEqual(['SYNA', 'SYNB']);
    expect(day.mock.calls.map(([symbol]) => symbol).sort()).toEqual(['SYNA', 'SYNB']);
    await getPortfolioHistory(deps(day, week), '1W', undefined, new Date('2026-10-16T18:09:00.000Z'));
    expect(week).toHaveBeenCalledTimes(2);
    expect(day).toHaveBeenCalledTimes(2);
  });

  it('nets a share deposit like a purchase: no step on its day, the days before it higher by its value, and a note', async () => {
    household();
    // Thursday: 10 SYNC vest into a1 at the price of Thursday's open; no cash moves.
    const thursdayOpen = Date.parse('2026-10-15T08:00:00.000Z');
    trade('a1-vest', 'a1', 'SYNC', '2026-10-15', 10, price('SYNC', thursdayOpen));
    settle();

    const r = await getPortfolioHistory(deps(dayChart(['SYNA', 'SYNB', 'SYNC']), weekChart(['SYNA', 'SYNB', 'SYNC'])), '1W', undefined, NOW);

    for (const point of r.points) {
      const at = Date.parse(point.t);
      const before = dayOf(point.t) < '2026-10-15';
      // Before Thursday: no SYNC, and cash higher by what the vest is counted as costing.
      const expected = CASH_TOTAL + 10 * A(at) + 5 * B(at) + (before ? 10 * price('SYNC', thursdayOpen) : 10 * price('SYNC', at));
      expect(point.value).toBeCloseTo(expected, 6);
    }
    const index = r.points.findIndex((point) => point.t === '2026-10-15T08:00:00.000Z');
    const [lastWednesday, firstThursday] = [r.points[index - 1], r.points[index]];
    // Across the night only the prices move: no step for the vest.
    expect(firstThursday.value - lastWednesday.value).toBeCloseTo(
      10 * (A(thursdayOpen) - A(Date.parse(lastWednesday.t))) + 5 * (B(thursdayOpen) - B(Date.parse(lastWednesday.t))), 6,
    );
    expect(r.approximate).toBe(true);
    expect(r.approximationReasons).toContain(
      '1 share transaction this week is counted as bought or sold with cash at its recorded price: if one was a share deposit or transfer (RSU, ESPP or ACAT), it shows no step, and the days before it are off by its value',
    );
  });

  it('prices a holding sold mid-week on the days before the sale, without a step at it', async () => {
    household();
    // a1 sells all its SYNA at Wednesday's open; today it holds only the cash.
    const wednesdayOpen = Date.parse('2026-10-14T08:00:00.000Z');
    trade('a1-sell', 'a1', 'SYNA', '2026-10-14', -10, A(wednesdayOpen));
    db().prepare('UPDATE accounts SET cash_balance = ? WHERE id = ?').run(CASH.a1 + 10 * A(wednesdayOpen), 'a1');
    settle();
    const week = weekChart();

    const r = await getPortfolioHistory(deps(dayChart(), week), '1W', undefined, NOW);

    // SYNA is priced for Monday and Tuesday although nobody holds it today.
    expect(week.mock.calls.map(([symbol]) => symbol).sort()).toEqual(['SYNA', 'SYNB']);
    for (const point of r.points) {
      const at = Date.parse(point.t);
      const before = dayOf(point.t) < '2026-10-14';
      expect(point.value).toBeCloseTo(CASH_TOTAL + 5 * B(at) + 10 * (before ? A(at) : A(wednesdayOpen)), 6);
    }
    expect(r.points.some((point) => point.estimated)).toBe(false);
  });

  it('reports a total loss as -100%', async () => {
    // a3 holds one SYNA put struck at 100.5 and no cash: worth its intrinsic value until SYNA passes
    // the strike on Monday, then nothing. SYNA's own prices come from another account's ticks.
    state.createAccount({ id: 'a3', name: 'A3', cashBalance: 0, currency: 'USD' });
    trade('a3-put', 'a3', 'SYNA261120P00100500', '2026-09-01', 1, 1, { instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open' });
    settle();
    const bar = db().prepare(`INSERT INTO symbol_price_bars (symbol, range_kind, t, close, source) VALUES ('SYNA', 'intraday', ?, ?, 'nasdaq')`);
    for (const t of DAYS.flatMap((day) => session(day, 5))) if (Date.parse(t) <= NOW.getTime()) bar.run(t, A(Date.parse(t)));

    const r = await getPortfolioHistory(deps(), '1W', ['a3'], NOW);

    expect(r.valueMethod).toBe('holdings_at_market');
    expect(r.points[0].value).toBeCloseTo(50, 6);
    expect(r.points.at(-1)!.value).toBe(0);
    expect(r.returns!.summary).toMatchObject({ cumulative: -1, gain: -50, netFlows: 0 });
    expect(r.returns!.notes.some((note) => note.includes('no starting value'))).toBe(false);
  });

  it('spreads a Fidelity dividend that has no event over the whole week, and says so', async () => {
    household();
    // a1 is synced from Fidelity: its adopted cash already holds Wednesday's dividend of 25, which has no event row.
    db().exec(`CREATE TABLE IF NOT EXISTS fidelity_investing_sources (
      source_id TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, captured_at TEXT NOT NULL, capture_digest TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    db().prepare("INSERT INTO fidelity_investing_sources VALUES ('synthetic-source', 'a1', ?, 'synthetic', ?)").run(OLD, OLD);
    db().prepare('UPDATE accounts SET cash_balance = cash_balance + 25 WHERE id = ?').run('a1');
    settle();

    const r = await getPortfolioHistory(deps(dayChart(), weekChart()), '1W', undefined, NOW);

    for (const point of r.points) {
      expect(point.value).toBeCloseTo(CASH_TOTAL + 25 + 10 * A(Date.parse(point.t)) + 5 * B(Date.parse(point.t)), 6);
    }
    expect(r.approximate).toBe(true);
    expect(r.approximationReasons).toContain(
      "1 account synced from Fidelity: Fidelity's dividends and deposits are not recorded as cash events, so any this week is spread over the whole week instead of stepping on its day",
    );
  });

  it("steps at the open of a recorded deposit's day and keeps it out of the return, while a dividend is return", async () => {
    household();
    // a2's cash holds a dividend of 10 recorded on Tuesday and a deposit of 2,000 recorded on Thursday.
    db().prepare('UPDATE accounts SET cash_balance = cash_balance + 2010 WHERE id = ?').run('a2');
    cashEvent('div', 'a2', '2026-10-13', 'dividend', 10);
    cashEvent('dep', 'a2', '2026-10-15', 'deposit', 2_000);
    settle();

    const r = await getPortfolioHistory(deps(dayChart(), weekChart()), '1W', undefined, NOW);

    const cashOn = (day: string) => CASH_TOTAL + (day >= '2026-10-13' ? 10 : 0) + (day >= '2026-10-15' ? 2_000 : 0);
    for (const point of r.points) {
      expect(point.value).toBeCloseTo(cashOn(dayOf(point.t)) + 10 * A(Date.parse(point.t)) + 5 * B(Date.parse(point.t)), 6);
    }
    const thursday = r.points.findIndex((point) => point.t === '2026-10-15T08:00:00.000Z');
    const tuesday = r.points.findIndex((point) => point.t === '2026-10-13T08:00:00.000Z');
    const gainAt = (index: number) => r.returns!.points[index].gain - r.returns!.points[index - 1].gain;
    // The deposit steps the value but is no gain; the dividend is. Gains are in cents.
    expect(gainAt(thursday)).toBeCloseTo(r.points[thursday].value - r.points[thursday - 1].value - 2_000, 1);
    expect(gainAt(tuesday)).toBeCloseTo(r.points[tuesday].value - r.points[tuesday - 1].value, 1);
    expect(r.returns!.summary.netFlows).toBeCloseTo(2_000, 2);
    expect(r.returns!.summary.gain).toBeCloseTo(r.points.at(-1)!.value - r.points[0].value - 2_000, 2);
    expect(r.approximationReasons).toContain("1 recorded deposit, withdrawal or transfer steps the value at its day's open: money moved, not return");
  });

  it('never steps at a mid-week bridge or a cash adoption', async () => {
    household();
    // a2 sold 3 SYNB 50 puts in September. On Wednesday they are assigned: +300 SYNB at 50, the puts
    // close, and the cash pays. On Thursday a sync adopts the broker's cash, 700 more than Holdr's.
    trade('a2-put', 'a2', PUT, '2026-09-01', -3, 2, { instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open' });
    trade('bridge-shares', 'a2', 'SYNB', '2026-10-14', 300, 50);
    trade('bridge-put', 'a2', PUT, '2026-10-14', 3, 0, { instrumentType: 'option', contractMultiplier: 100, positionEffect: 'close' });
    db().prepare('UPDATE accounts SET cash_balance = ? WHERE id = ?').run(CASH.a2 - 15_000 + 700, 'a2');
    settle();
    const invalidation = db().prepare(
      `INSERT INTO account_history_invalidations (account_id, effective_date, detected_at, reason) VALUES ('a2', ?, ?, ?)`,
    );
    invalidation.run('2026-10-14', OLD, 'fidelity investing activity imported');
    invalidation.run('2026-10-15', OLD, 'fidelity investing cash adopted');

    const r = await getPortfolioHistory(deps(dayChart(), weekChart()), '1W', undefined, NOW);

    expect(r.valueMethod).toBe('holdings_at_market');
    // Before Wednesday the puts, at their intrinsic value, and the cash before the assignment; from
    // Wednesday the shares. SYNB stays below 50, so both come to the same value: one line all week.
    for (const point of r.points) {
      const at = Date.parse(point.t);
      expect(point.value).toBeCloseTo(CASH_TOTAL - 15_000 + 700 + 10 * A(at) + 305 * B(at), 6);
    }
    expect(r.points.some((point) => point.unreliable)).toBe(false);
    expect(r.returns!.summary.netFlows).toBeCloseTo(0, 2);
  });

  it("stands a first sync's holdings on every day of the week", async () => {
    household();
    // a3's first sync on Wednesday pulled 50 SYNA it already held: a position pull, not a purchase.
    state.createAccount({ id: 'a3', name: 'A3', cashBalance: 300, currency: 'USD' });
    trade('a3-pull', 'a3', 'SYNA', '2026-10-14', 50, 80, { sourceFingerprint: 'pos:SYNA' });
    settle();

    const r = await getPortfolioHistory(deps(dayChart(), weekChart()), '1W', undefined, NOW);

    for (const point of r.points) {
      expect(point.value).toBeCloseTo(CASH_TOTAL + 300 + 60 * A(Date.parse(point.t)) + 5 * B(Date.parse(point.t)), 6);
    }
    expect(r.approximationReasons.some((reason) => reason.includes('share transaction'))).toBe(false);
  });

  it("checks the week against the job's ticks of every session, and shows the recorded snapshots when many disagree", async () => {
    household();
    const ticks = DAYS.flatMap((day) => every(`${day}T13:30:00.000Z`, `${day}T17:50:00.000Z`, 10));
    const snapshot = db().prepare(
      `INSERT INTO account_snapshots (id, account_id, taken_at, market_value, cost_basis, cash_balance) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const bar = db().prepare(`INSERT INTO symbol_price_bars (symbol, range_kind, t, close, source) VALUES (?, 'intraday', ?, ?, 'nasdaq')`);
    for (const t of ticks) {
      const at = Date.parse(t);
      snapshot.run(`snap-a1-${t}`, 'a1', t, CASH.a1 + 10 * A(at), CASH.a1, CASH.a1);
      snapshot.run(`snap-a2-${t}`, 'a2', t, CASH.a2 + 5 * B(at), CASH.a2, CASH.a2);
      bar.run('SYNA', t, A(at));
      bar.run('SYNB', t, B(at));
    }

    const r = await getPortfolioHistory(deps(dayChart(), weekChart()), '1W', undefined, NOW);

    // The first tick stamped after the last change may have started before it.
    const compared = ticks.length - 1;
    expect(r.approximationReasons).toContain(
      `checked against ${compared} recorded snapshots taken since the latest change to these accounts: ${compared} within 0.1%, 0 within 0.5%, 0 over 0.5%`,
    );

    db().prepare('UPDATE account_snapshots SET market_value = market_value * 1.1 WHERE account_id = ? AND taken_at >= ?')
      .run('a1', '2026-10-13T00:00:00.000Z');
    expect((await getPortfolioHistory(deps(), '1W', undefined, NOW)).valueMethod).toBe('observed_snapshot');
    expect(await checkIntradayLine(deps(), NOW, '1W')).toMatchObject({
      range: '1W', firstSession: '2026-10-12', sessionDate: '2026-10-16', compared, passed: false,
    });
  });

  it('values only the accounts in scope, each day at its own holdings and cash', async () => {
    household();
    trade('a2-buy', 'a2', 'SYNB', '2026-10-14', 20, 41);
    db().prepare('UPDATE accounts SET cash_balance = ? WHERE id = ?').run(CASH.a2 - 820, 'a2');
    settle();

    const r = await getPortfolioHistory(deps(dayChart(), weekChart()), '1W', ['a2'], NOW);

    for (const point of r.points) {
      const at = Date.parse(point.t);
      const before = dayOf(point.t) < '2026-10-14';
      expect(point.value).toBeCloseTo(before ? CASH.a2 + 5 * B(at) : CASH.a2 - 820 + 25 * B(at), 6);
    }
    expect(r.approximationReasons).toContain(
      '1 share transaction this week is counted as bought or sold with cash at its recorded price: if one was a share deposit or transfer (RSU, ESPP or ACAT), it shows no step, and the days before it are off by its value',
    );
  });
});

describe('one source precedence, whichever range was asked first', () => {
  /** Nasdaq's 1-minute chart of today, missing every minute ending in 5 before 9:00 AM ET (thin pre-market trading). */
  const gappyDay = () => vi.fn(async (symbol: string): Promise<IntradayBar[]> => (['SYNA', 'SYNB'].includes(symbol)
    ? every('2026-10-16T08:00:00.000Z', NOW.toISOString(), 1)
      .filter((t) => !(Date.parse(t) < Date.parse('2026-10-16T13:00:00.000Z') && new Date(t).getUTCMinutes() % 10 === 5))
      .map((t) => ({ symbol, t, close: price(symbol, Date.parse(t)), source: NASDAQ_CHART_SOURCE }))
    : []));
  /** CNBC's five-day chart, a touch off Nasdaq's prices, as two providers are. */
  const offWeek = () => vi.fn(async (symbol: string): Promise<IntradayBar[]> => (['SYNA', 'SYNB'].includes(symbol)
    ? DAYS.flatMap((day) => session(day, 5))
      .map((t) => ({ symbol, t, close: price(symbol, Date.parse(t)) * 1.0005, source: CNBC_WEEK_CHART_SOURCE }))
    : []));

  it('gives 1D the same values before and after a 1W request, and 1W the same newest session as 1D', async () => {
    household();
    const day = gappyDay();
    const week = offWeek();

    const first = await getPortfolioHistory(deps(day, week), '1D', undefined, NOW);
    const oneWeek = await getPortfolioHistory(deps(day, week), '1W', undefined, NOW);
    const again = await getPortfolioHistory(deps(day, week), '1D', undefined, NOW);

    // 1W stored CNBC's five-minute bars of every day, today's included; 1D reads none of them.
    expect(week).toHaveBeenCalled();
    expect(again.points).toEqual(first.points);
    const skipped = first.points.find((point) => point.t === '2026-10-16T08:05:00.000Z')!;
    const previousMinute = Date.parse('2026-10-16T08:04:00.000Z');
    expect(skipped.value).toBeCloseTo(CASH_TOTAL + 10 * A(previousMinute) + 5 * B(previousMinute), 6);
    // 1W's newest session is 1D's at every shared point; its earlier sessions read the five-minute bars.
    const oneDayAt = new Map(first.points.map((point) => [point.t, point.value]));
    for (const point of oneWeek.points) {
      const at = Date.parse(point.t);
      if (dayOf(point.t) === '2026-10-16') expect(point.value).toBe(oneDayAt.get(point.t));
      else expect(point.value).toBeCloseTo(CASH_TOTAL + (10 * A(at) + 5 * B(at)) * 1.0005, 6);
    }
  });

  it("keeps 1W's earlier sessions on the five-minute bars when a past day also has 1-minute ones", async () => {
    household();
    const before = await getPortfolioHistory(deps(dayChart(), offWeek()), '1W', undefined, NOW);
    // As if 1D had been looked at on Wednesday: that day's 1-minute bars, a touch lower.
    const bar = db().prepare(`INSERT INTO symbol_price_bars (symbol, range_kind, t, close, source) VALUES (?, 'intraday', ?, ?, ?)`);
    for (const t of every('2026-10-14T08:00:00.000Z', '2026-10-15T00:00:00.000Z', 1)) {
      for (const symbol of ['SYNA', 'SYNB']) bar.run(symbol, t, price(symbol, Date.parse(t)) * 0.999, NASDAQ_CHART_SOURCE);
    }

    const after = await getPortfolioHistory(deps(dayChart(), offWeek()), '1W', undefined, NOW);

    expect(after.points).toEqual(before.points);
  });

  it("fetches an unquoted option's underlying for 1D too, so 1W's fetch of a sold holding never changes 1D", async () => {
    household();
    // a1 holds a SYNA 90 call that is never quoted, and sold its SYNA shares on Wednesday.
    trade('a1-call', 'a1', 'SYNA261120C00090000', '2026-09-01', 1, 5, { instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open' });
    trade('a1-sell', 'a1', 'SYNA', '2026-10-14', -10, 100);
    db().prepare('UPDATE accounts SET cash_balance = ? WHERE id = ?').run(CASH.a1 + 1_000, 'a1');
    settle();
    const day = dayChart();
    const week = weekChart();

    const first = await getPortfolioHistory(deps(day, week), '1D', undefined, NOW);
    await getPortfolioHistory(deps(day, week), '1W', undefined, NOW);
    const again = await getPortfolioHistory(deps(day, week), '1D', undefined, NOW);

    expect(again.points).toEqual(first.points);
    // The call at its intrinsic value from SYNA's 1-minute prices, which 1D fetched itself.
    const t = '2026-10-16T17:00:00.000Z';
    const at = Date.parse(t);
    expect(first.points.find((point) => point.t === t)!.value).toBeCloseTo(CASH_TOTAL + 1_000 + 100 * (A(at) - 90) + 5 * B(at), 6);
  });

  it("takes one instant's price by precedence, whatever order the rows were stored in", async () => {
    household();
    trade('a1-c', 'a1', 'SYNC', '2026-09-01', 10, 20);
    settle();
    // SYNC at 1:00 PM ET from four sources, stored least preferred first.
    const t = '2026-10-16T17:00:00.000Z';
    const insert = db().prepare(`INSERT INTO symbol_price_bars (symbol, range_kind, t, close, source) VALUES ('SYNC', 'intraday', ?, ?, ?)`);
    insert.run(t, 103, CNBC_WEEK_CHART_SOURCE);
    insert.run(t, 102, CNBC_CHART_SOURCE);
    insert.run(t, 101, NASDAQ_CHART_SOURCE);
    insert.run(t, 100, 'nasdaq');
    const syncValueAt = async () => {
      const r = await getPortfolioHistory(deps(dayChart(), weekChart()), '1D', undefined, NOW);
      return r.points.find((point) => point.t === t)!.value - (CASH_TOTAL + 10 * A(Date.parse(t)) + 5 * B(Date.parse(t)));
    };
    const drop = (source: string) => db().prepare("DELETE FROM symbol_price_bars WHERE symbol = 'SYNC' AND source = ?").run(source);

    // The job's quote, then Nasdaq's 1-minute bar, then CNBC's; 1D never reads the five-minute bar.
    expect(await syncValueAt()).toBeCloseTo(1_000, 6);
    drop('nasdaq');
    expect(await syncValueAt()).toBeCloseTo(1_010, 6);
    drop(NASDAQ_CHART_SOURCE);
    expect(await syncValueAt()).toBeCloseTo(1_020, 6);
    drop(CNBC_CHART_SOURCE);
    expect(await syncValueAt()).toBeCloseTo(10 * 20, 6);
  });
});
