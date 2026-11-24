import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createPortfolioRouter } from './portfolio.js';
import type { PriceBar } from '../providers/historyTypes.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { createHistoryRepo } from '../services/symbolHistory.js';
import { listenLoopback } from '../testing/loopback.js';

let dir: string;
let state: SqliteStateRepo;
let app: express.Express;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-10T16:00:00Z'));
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network disabled in tests')));
  dir = await mkdtemp(path.join(tmpdir(), 'ft-portfolio-route-'));
  state = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
  state.createAccount({ id: 'a1', name: 'A1', cashBalance: 100, currency: 'USD' });
  app = express();
  app.use('/portfolio', createPortfolioRouter({
    state,
    history: createHistoryRepo(state),
    fetchQuotes: async (symbols: string[]) => symbols.map((symbol) => ({
      symbol,
      price: 110,
      currency: 'USD',
      asOf: Date.now(),
      source: 'nasdaq' as const,
    })),
  }));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  state.close();
  await rm(dir, { recursive: true, force: true });
});

describe('GET /portfolio/performance', () => {
  it('reports performance as unsupported without a ledger', async () => {
    const response = await request(await listenLoopback(app)).get('/portfolio/performance?accounts=a1').expect(200);
    expect(response.body).toEqual({
      supported: false,
      reason: 'Performance needs recorded transactions or broker cash history.',
    });
  });

  it('returns trailing periods and calendar years for the requested accounts', async () => {
    state.createTransaction({
      id: 'buy', accountId: 'a1', symbol: 'AAPL', date: '2025-06-02',
      quantity: 10, pricePerUnit: 100, currency: 'USD',
    });
    const bars: PriceBar[] = [];
    for (let day = new Date('2025-05-01T00:00:00Z'); day <= new Date('2026-07-10T00:00:00Z'); day.setUTCDate(day.getUTCDate() + 1)) {
      if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
      const t = day.toISOString().slice(0, 10);
      bars.push({ symbol: 'AAPL', t, close: t < '2026-01-01' ? 100 : 110, source: 'nasdaq' });
    }
    createHistoryRepo(state).upsertBars(bars);

    const response = await request(await listenLoopback(app)).get('/portfolio/performance?accounts=a1').expect(200);

    expect(response.body).toMatchObject({ supported: true, inception: '2025-06-02', asOf: '2026-07-10', completeFrom: null });
    const periods = response.body.periods as Array<{ key: string; from: string; timeWeighted: number }>;
    expect(periods.map((period) => period.key)).toEqual(['YTD', '1Y', 'INCEPTION']);
    expect(periods[0].from).toBe('2025-12-31');
    expect(periods[0].timeWeighted).toBeCloseTo(100 / 1_100, 8);
    expect((response.body.years as Array<{ year: number }>).map((year) => year.year)).toEqual([2025, 2026]);
  });
});
