import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SqliteStateRepo } from './sqliteStateRepo.js';
import { createManualPriceRepo } from './manualPrices.js';
import { createHistoryRepo } from './symbolHistory.js';
import { getPortfolioHistory } from './portfolioHistory.js';
import type { PriceBar } from '../providers/historyTypes.js';

let dir: string;
let state: SqliteStateRepo;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-manualprices-'));
  state = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
});

afterEach(async () => {
  state.close();
  await rm(dir, { recursive: true, force: true });
});

describe('createManualPriceRepo', () => {
  it('upserts and lists', () => {
    const repo = createManualPriceRepo(state);
    repo.upsert({ symbol: 'VANG500', date: '2026-05-01', close: 100 });
    repo.upsert({ symbol: 'VANG500', date: '2026-05-08', close: 105 });
    const list = repo.list('VANG500');
    expect(list).toHaveLength(2);
    expect(list[0].date).toBe('2026-05-01');
    expect(list[1].date).toBe('2026-05-08');
  });

  it('upsert replaces an existing (symbol,date) row', () => {
    const repo = createManualPriceRepo(state);
    repo.upsert({ symbol: 'VANG500', date: '2026-05-01', close: 100 });
    repo.upsert({ symbol: 'VANG500', date: '2026-05-01', close: 101.5, notes: 'corrected' });
    const list = repo.list('VANG500');
    expect(list).toHaveLength(1);
    expect(list[0].close).toBe(101.5);
    expect(list[0].notes).toBe('corrected');
  });

  it('normalizes symbol case to uppercase', () => {
    const repo = createManualPriceRepo(state);
    repo.upsert({ symbol: 'vang500', date: '2026-05-01', close: 100 });
    expect(repo.list('VANG500')).toHaveLength(1);
    expect(repo.list('vang500')).toHaveLength(1);
  });

  it('remove returns whether anything was deleted', () => {
    const repo = createManualPriceRepo(state);
    repo.upsert({ symbol: 'VANG500', date: '2026-05-01', close: 100 });
    expect(repo.remove('VANG500', '2026-05-01')).toBe(true);
    expect(repo.remove('VANG500', '2026-05-01')).toBe(false);
  });

  it('closeOnOrBefore forward-fills', () => {
    const repo = createManualPriceRepo(state);
    repo.upsert({ symbol: 'VANG500', date: '2026-05-01', close: 100 });
    repo.upsert({ symbol: 'VANG500', date: '2026-05-15', close: 110 });
    expect(repo.closeOnOrBefore('VANG500', '2026-04-30')).toBeNull();
    expect(repo.closeOnOrBefore('VANG500', '2026-05-01')).toBe(100);
    expect(repo.closeOnOrBefore('VANG500', '2026-05-07')).toBe(100);  // forward-fill
    expect(repo.closeOnOrBefore('VANG500', '2026-05-15')).toBe(110);
    expect(repo.closeOnOrBefore('VANG500', '2026-05-20')).toBe(110);  // forward-fill
  });
});

describe('portfolioHistory + manualPrices integration', () => {
  it('uses manual prices when no provider history exists', async () => {
    state.createAccount({ id: 'a1', name: 'A1', cashBalance: 100, currency: 'USD' });
    state.createTransaction({
      id: 't1', accountId: 'a1', symbol: 'VANG500', date: '2026-05-01',
      quantity: 10, pricePerUnit: 100, currency: 'USD',
    });
    const manualPrices = createManualPriceRepo(state);
    manualPrices.upsert({ symbol: 'VANG500', date: '2026-05-01', close: 100 });
    manualPrices.upsert({ symbol: 'VANG500', date: '2026-05-04', close: 110 });

    const fakeFetchQuotes = async (syms: string[]) =>
      syms.map((s) => ({
        symbol: s, price: 110, currency: 'USD', asOf: Date.now(),
        source: 'nasdaq' as const,
      }));

    // Pin `now` to 2026-05-04 so the symbolHistory cache check on
    // VANG500 is satisfied (no provider call) — we already know there's
    // no provider data anyway.
    const r = await getPortfolioHistory(
      { state, history: createHistoryRepo(state), manualPrices, fetchQuotes: fakeFetchQuotes },
      '1W', ['a1'], new Date('2026-05-04T20:00:00Z'),
    );
    expect(r.supported).toBe(true);
    // Manual entry on May 1 = $100 → 10 × 100 + $100 cash = $1,100.
    const may1 = r.points.find((p) => p.t === '2026-05-01');
    expect(may1?.value).toBe(1100);
    // Manual entry on May 4 = $110 → 10 × 110 + $100 cash = $1,200.
    const may4 = r.points.find((p) => p.t === '2026-05-04');
    expect(may4?.value).toBe(1200);

    // The "no price history" reason should NOT be present (manual rescue),
    // and a positive "manual price overrides applied for VANG500" reason
    // should be added.
    expect(r.approximationReasons.some((s) => s.includes('no price history available for VANG500'))).toBe(false);
    expect(r.approximationReasons.some((s) => s.includes('manual price overrides applied for VANG500'))).toBe(true);
  });

  it('manual prices take precedence over provider bars for the same date', async () => {
    state.createAccount({ id: 'a1', name: 'A1', cashBalance: 0, currency: 'USD' });
    state.createTransaction({
      id: 't1', accountId: 'a1', symbol: 'AAPL', date: '2026-05-01',
      quantity: 10, pricePerUnit: 150, currency: 'USD',
    });
    // Provider bar exists at $200.
    const history = createHistoryRepo(state);
    const bar: PriceBar = { symbol: 'AAPL', t: '2026-05-04', close: 200, source: 'nasdaq' };
    history.upsertBars([bar]);
    // Manual override on the same date sets it to $250.
    const manualPrices = createManualPriceRepo(state);
    manualPrices.upsert({ symbol: 'AAPL', date: '2026-05-04', close: 250 });

    const fakeFetchQuotes = async (syms: string[]) =>
      syms.map((s) => ({
        symbol: s, price: 250, currency: 'USD', asOf: Date.now(),
        source: 'nasdaq' as const,
      }));
    const r = await getPortfolioHistory(
      { state, history, manualPrices, fetchQuotes: fakeFetchQuotes },
      '1W', ['a1'], new Date('2026-05-04T20:00:00Z'),
    );
    // Expect $250 not $200.
    const may4 = r.points.find((p) => p.t === '2026-05-04');
    expect(may4?.value).toBe(10 * 250);
  });
});
