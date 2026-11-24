import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Metal } from '@finance-tracker/shared/metals-ledger';

import type { MetalSpotBar } from '../../providers/metalSpotBars.js';
import { SqliteStateRepo } from '../sqliteStateRepo.js';
import { createHistoryRepo } from '../symbolHistory.js';
import { METALS_REFRESH_INTERVAL_MS, MetalsPriceRefresher, addDays, createMetalsPriceStore, type MetalsPriceStore } from './prices.js';

// Synthetic only: invented closes on invented days, an in-memory database, and a fake provider (no network).

const TODAY = '2030-03-20';

let repo: SqliteStateRepo;
let store: MetalsPriceStore;

beforeEach(() => {
  repo = new SqliteStateRepo({ file: ':memory:' });
  store = createMetalsPriceStore(repo.internalGetDb());
});

afterEach(() => {
  repo.close();
});

const rows = () => repo.internalGetDb().prepare(`SELECT symbol, t, close, source FROM symbol_price_bars ORDER BY symbol, t, source`).all();

describe('metals price store: its own write rule', () => {
  it('stores final bars once and keeps them, counting a later fetch that differs; replaces provisional ones', () => {
    expect(store.record('XAU', [
      { date: '2030-03-01', close: '2000' }, { date: '2030-03-14', close: '2010' }, { date: TODAY, close: '2020' },
    ], TODAY)).toEqual({ inserted: 2, replaced: 0, unchanged: 0, finalDiffered: 0, conflicting: 0, incomplete: 1 });
    expect(store.record('XAU', [
      { date: '2030-03-01', close: '2001' }, { date: '2030-03-14', close: '2011' }, { date: '2030-03-13', close: '2009.5' },
    ], TODAY)).toEqual({ inserted: 1, replaced: 1, unchanged: 0, finalDiffered: 1, conflicting: 0, incomplete: 0 });
    expect(store.record('XAU', [{ date: '2030-03-01', close: '2000.00' }, { date: '2030-03-14', close: '2011' }], TODAY))
      .toEqual({ inserted: 0, replaced: 0, unchanged: 2, finalDiffered: 0, conflicting: 0, incomplete: 0 });
    expect(store.bars('XAU')).toEqual([
      { date: '2030-03-01', close: '2000' }, { date: '2030-03-13', close: '2009.5' }, { date: '2030-03-14', close: '2011' },
    ]);
    expect(store.span('XAU')).toEqual({ first: '2030-03-01', last: '2030-03-14' });
    expect(store.span('XAG')).toBeNull();
  });

  it('stores neither close of a date one fetch gives twice differently; identical twins count once', () => {
    expect(store.record('XAG', [
      { date: '2030-03-02', close: '25' }, { date: '2030-03-02', close: '25.5' }, { date: '2030-03-04', close: '25.1' }, { date: '2030-03-04', close: '25.10' },
    ], TODAY)).toMatchObject({ inserted: 1, conflicting: 1 });
    expect(store.bars('XAG')).toEqual([{ date: '2030-03-04', close: '25.1' }]);
  });

  it('writes only its own symbol and source: the shared history repo and /symbols never see it', () => {
    const history = createHistoryRepo(repo);
    history.upsertBars([{ symbol: 'AAPL', t: '2030-03-01', close: 101.5, source: 'nasdaq' }]);
    store.record('XAU', [{ date: '2030-03-01', close: '2000' }], TODAY);
    expect(rows()).toEqual([
      { symbol: 'AAPL', t: '2030-03-01', close: 101.5, source: 'nasdaq' },
      { symbol: 'holdr:metal:XAU', t: '2030-03-01', close: 2000, source: 'cnbc-spot-daily' },
    ]);
    expect(history.readBars('holdr:metal:XAU', '2030-01-01', '2030-12-31')).toEqual([]);
  });
});

describe('metals price refresher: when it asks, and what', () => {
  const calls: Array<{ metal: Metal; from: string; to: string }> = [];
  let now = new Date(`${TODAY}T16:00:00Z`);
  let answer: (from: string, to: string) => MetalSpotBar[] | null;
  const fetcher = async (metal: Metal, from: string, to: string) => {
    calls.push({ metal, from, to });
    return answer(from, to);
  };
  const weekdayBars = (from: string, to: string) => {
    const bars: MetalSpotBar[] = [];
    for (let day = from; day <= to; day = addDays(day, 1)) {
      const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
      if (weekday !== 0 && weekday !== 6) bars.push({ date: day, close: '2000' });
    }
    return bars;
  };
  const logs: string[] = [];
  const refresher = () => new MetalsPriceRefresher({ store, fetcher, now: () => now, log: (line) => logs.push(line) });

  beforeEach(() => {
    calls.length = 0;
    logs.length = 0;
    now = new Date(`${TODAY}T16:00:00Z`);
    answer = weekdayBars;
  });

  it('never asks without a fetcher (prices off)', async () => {
    const off = new MetalsPriceRefresher({ store, now: () => now, log: (line) => logs.push(line) });
    expect(off.fetching).toBe(false);
    await off.refresh('XAU', '2030-01-15');
    expect(rows()).toEqual([]);
  });

  it('values with stored closes but never asks on stored market data (HOLDR_MARKET_DATA=stored), fetcher or not', async () => {
    const stored = new MetalsPriceRefresher({ store, fetcher, storedOnly: true, now: () => now, log: (line) => logs.push(line) });
    expect(stored.fetching).toBe(true);
    await stored.refresh('XAU', '2030-01-15');
    expect(calls).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('asks once for the history from 1 January, then for the provisional window at most every 6 hours', async () => {
    const prices = refresher();
    // 21 days before 2030-01-15 is in 2029: the history starts on 1 January 2029.
    await prices.refresh('XAU', '2030-01-15');
    expect(calls).toEqual([{ metal: 'XAU', from: '2029-01-01', to: '2030-03-19' }]);
    await prices.refresh('XAU', '2030-01-15');
    expect(calls).toHaveLength(1);
    now = new Date(now.getTime() + 6 * 60 * 60 * 1000 + 1);
    await prices.refresh('XAU', '2030-01-15');
    expect(calls[1]).toEqual({ metal: 'XAU', from: '2030-03-13', to: '2030-03-19' });
    expect(calls).toHaveLength(2);
    expect(logs.every((line) => !/\d{4,}/.test(line.replace(/XAU/g, '')))).toBe(true);
  });

  it('starts every history request on 1 January, never on an order date, also when the earliest order moves to an earlier year', async () => {
    const prices = refresher();
    const orderDates = ['2030-02-14', '2030-01-05', '2029-11-20', '2028-03-09', '2028-01-21', '2028-01-22'];
    for (const date of orderDates) await prices.refresh('XAU', date);
    expect(calls).toEqual([
      { metal: 'XAU', from: '2030-01-01', to: '2030-03-19' },
      // 2030-01-05 less 21 days is in 2029; 2029-11-20 is then covered, so nothing is asked for it.
      { metal: 'XAU', from: '2029-01-01', to: '2029-12-31' },
      { metal: 'XAU', from: '2028-01-01', to: '2028-12-31' },
      // 2028-01-21 less 21 days is 2027-12-31; 2028-01-22 less 21 days is 1 January 2028, covered.
      { metal: 'XAU', from: '2027-01-01', to: '2028-01-02' },
    ]);
    for (const call of calls) {
      expect(call.from).toMatch(/^\d{4}-01-01$/);
      expect(orderDates).not.toContain(call.from);
    }
    expect(store.span('XAU')).toEqual({ first: '2027-01-01', last: '2030-03-19' });
  });

  it('asks the same for every earliest day whose margin falls in one year: only the year reaches the provider', async () => {
    const asked: Array<typeof calls> = [];
    for (const earliest of ['2029-01-22', '2029-08-15', '2030-01-21']) {
      const own = new SqliteStateRepo({ file: ':memory:' });
      try {
        calls.length = 0;
        await new MetalsPriceRefresher({ store: createMetalsPriceStore(own.internalGetDb()), fetcher, now: () => now, log: () => undefined })
          .refresh('XAU', earliest);
        asked.push([...calls]);
      } finally {
        own.close();
      }
    }
    expect(asked).toEqual(Array(3).fill([{ metal: 'XAU', from: '2029-01-01', to: '2030-03-19' }]));
  });

  it('shares one flight between concurrent asks, and retries a failed answer only after the interval', async () => {
    const prices = refresher();
    answer = () => null;
    await Promise.all([prices.refresh('XAU', '2030-03-01'), prices.refresh('XAU', '2030-03-01')]);
    expect(calls).toHaveLength(1);
    await prices.refresh('XAU', '2030-03-01');
    expect(calls).toHaveLength(1);
    now = new Date(now.getTime() + 6 * 60 * 60 * 1000 + 1);
    answer = weekdayBars;
    await prices.refresh('XAU', '2030-03-01');
    expect(calls).toHaveLength(2);
    expect(store.span('XAU')).toEqual({ first: '2030-01-01', last: '2030-03-19' });
  });

  it('asks again after the interval when the first answer leaves nothing stored (an empty series counts as no history)', async () => {
    const prices = refresher();
    answer = () => [];
    await prices.refresh('XAU', '2030-03-01');
    await prices.refresh('XAU', '2030-03-01');
    expect(calls).toEqual([{ metal: 'XAU', from: '2030-01-01', to: '2030-03-19' }]);
    now = new Date(now.getTime() + 6 * 60 * 60 * 1000 + 1);
    answer = weekdayBars;
    await prices.refresh('XAU', '2030-03-01');
    expect(calls).toEqual([{ metal: 'XAU', from: '2030-01-01', to: '2030-03-19' }, { metal: 'XAU', from: '2030-01-01', to: '2030-03-19' }]);
    expect(store.span('XAU')).toEqual({ first: '2030-01-01', last: '2030-03-19' });
  });

  it('counts a history attempt whose write fails, so it is asked again only after the interval, never at once', async () => {
    let failing = true;
    const failingWrites: MetalsPriceStore = {
      ...store,
      record: (metal, bars, today) => {
        if (failing) throw Object.assign(new Error('synthetic write failure'), { code: 'SQLITE_FULL' });
        return store.record(metal, bars, today);
      },
    };
    const prices = new MetalsPriceRefresher({ store: failingWrites, fetcher, now: () => now, log: (line) => logs.push(line) });
    const afterInterval = METALS_REFRESH_INTERVAL_MS + 1;
    // Early enough that both waits stay within the day in New York.
    now = new Date(`${TODAY}T10:00:00Z`);
    // The first answer, with nothing stored yet.
    await prices.refresh('XAU', '2030-03-01');
    await prices.refresh('XAU', '2030-03-01');
    expect(calls).toEqual([{ metal: 'XAU', from: '2030-01-01', to: '2030-03-19' }]);
    expect(logs).toEqual(['[metals] XAU closes not refreshed: Error SQLITE_FULL']);
    now = new Date(now.getTime() + afterInterval);
    failing = false;
    await prices.refresh('XAU', '2030-03-01');
    expect(calls).toHaveLength(2);
    expect(store.span('XAU')).toEqual({ first: '2030-01-01', last: '2030-03-19' });
    // Older history, once closes are stored.
    failing = true;
    await prices.refresh('XAU', '2029-06-01');
    await prices.refresh('XAU', '2029-06-01');
    expect(calls.slice(2)).toEqual([{ metal: 'XAU', from: '2029-01-01', to: '2029-12-31' }]);
    now = new Date(now.getTime() + afterInterval);
    failing = false;
    await prices.refresh('XAU', '2029-06-01');
    expect(calls.slice(3)).toEqual([{ metal: 'XAU', from: '2029-01-01', to: '2029-12-31' }, { metal: 'XAU', from: '2030-03-13', to: '2030-03-19' }]);
    expect(store.span('XAU')).toEqual({ first: '2029-01-01', last: '2030-03-19' });
  });
});
