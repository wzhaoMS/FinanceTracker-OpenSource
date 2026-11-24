import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createSymbolsRouter } from './symbols.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { createHistoryRepo, marketDate } from '../services/symbolHistory.js';
import { listenLoopback } from '../testing/loopback.js';

let dir: string;
let state: SqliteStateRepo;
let app: express.Express;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-symroute-'));
  state = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
  app = express();
  app.use(express.json());
  app.use('/symbols', createSymbolsRouter(createHistoryRepo(state)));
});

afterEach(async () => {
  state.close();
  await rm(dir, { recursive: true, force: true });
});

describe('GET /symbols/:symbol/history', () => {
  it('400 on unknown range', async () => {
    const res = await request(await listenLoopback(app)).get('/symbols/AAPL/history?range=BOGUS');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/range must be one of/);
  });

  it('1D returns 200 with supported=false and an explicit reason', async () => {
    const res = await request(await listenLoopback(app)).get('/symbols/AAPL/history?range=1D');
    expect(res.status).toBe(200);
    expect(res.body.supported).toBe(false);
    expect(res.body.reason).toMatch(/intraday/i);
    expect(res.body.points).toEqual([]);
  });

  it('rejects malformed symbol input before any provider call', async () => {
    const res = await request(await listenLoopback(app)).get('/symbols/abc%3Adef..xyz/history?range=1M');
    expect(res.status).toBe(200);
    expect(res.body.supported).toBe(false);
    expect(res.body.reason).toBe('invalid symbol');
    expect(res.body.points).toEqual([]);
  });

  it('returns cached bars when present (deduplicated by source)', async () => {
    // Pre-populate with overlapping (date,source) rows; expect dedupe.
    // Use dates that include "today"-ish so the cache-freshness check
    // doesn't trigger a live provider call. The route uses
    // `lastWeekdayOnOrBefore(now)` (UTC) for freshness; seeding "today's
    // close" satisfies it as long as the test ran during a weekday in
    // either ET or UTC. Use a wide range to make the dedup logic the
    // observable behavior, not the cache freshness.
    const repo = createHistoryRepo(state);
    repo.upsertBars([
      // Today-ish dates to keep cache fresh — we don't assert on these
      // values; only that dedupe + nasdaq-precedence works.
      { symbol: 'AAPL', t: ymdToday(), close: 100, source: 'coingecko' },
      { symbol: 'AAPL', t: ymdToday(), close: 200, source: 'nasdaq' },
      { symbol: 'AAPL', t: ymdYesterday(), close: 150, source: 'nasdaq' },
    ]);
    const res = await request(await listenLoopback(app)).get('/symbols/AAPL/history?range=1W');
    expect(res.status).toBe(200);
    expect(res.body.supported).toBe(true);
    const ts = res.body.points.map((p: { t: string }) => p.t);
    // No duplicate dates.
    expect(ts.length).toBe(new Set(ts).size);
    // Nasdaq wins precedence on the dup date.
    const today = res.body.points.find((p: { t: string }) => p.t === ymdToday());
    expect(today.close).toBe(200);
  });

  it('200 supported=true response shape includes summary + sources', async () => {
    // Seed two consecutive weekdays so summary computation is deterministic.
    // The latest date must be >= today (UTC weekday) to satisfy the cache
    // freshness check; otherwise getSymbolHistory will call out to Nasdaq.
    const t1 = ymdYesterday();
    const t2 = ymdToday();
    createHistoryRepo(state).upsertBars([
      { symbol: 'AAPL', t: t1, close: 100, source: 'nasdaq' },
      { symbol: 'AAPL', t: t2, close: 110, source: 'nasdaq' },
    ]);
    const res = await request(await listenLoopback(app)).get('/symbols/AAPL/history?range=1W');
    expect(res.body.supported).toBe(true);
    expect(res.body.summary).toEqual({
      first: 100,
      last: 110,
      change: 10,
      changePercent: 10,
    });
    expect(res.body.sources).toEqual(['nasdaq']);
  });
});

/** Latest weekday on or before today's New York market date. Must match
 *  the cache-freshness date in symbolHistory.ts so the test's
 *  seeded "latest" bar satisfies the cache-freshness check. */
function ymdToday(): string {
  const d = new Date(`${marketDate(new Date())}T12:00:00Z`);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
function ymdYesterday(): string {
  const d = new Date(`${ymdToday()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
