import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SqliteStateRepo } from './sqliteStateRepo.js';
import {
  createHistoryRepo,
  getSymbolHistory,
  rangeBounds,
  type HistoryRepo,
} from './symbolHistory.js';
import type { PriceBar } from '../providers/historyTypes.js';

let dir: string;
let state: SqliteStateRepo;
let repo: HistoryRepo;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-symhist-'));
  state = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
  repo = createHistoryRepo(state);
});

afterEach(async () => {
  state.close();
  await rm(dir, { recursive: true, force: true });
});

const bars = (sym: string, dates: string[]): PriceBar[] =>
  dates.map((t, i) => ({ symbol: sym, t, close: 100 + i, source: 'nasdaq' }));

describe('createHistoryRepo', () => {
  it('round-trips a batch of bars and reads back chronologically', () => {
    repo.upsertBars(bars('AAPL', ['2026-05-06', '2026-05-05', '2026-05-04']));
    const out = repo.readBars('AAPL', '2026-05-01', '2026-05-31');
    expect(out.map((b) => b.t)).toEqual(['2026-05-04', '2026-05-05', '2026-05-06']);
  });

  it('upsert is idempotent on (symbol, range_kind, t, source)', () => {
    repo.upsertBars(bars('AAPL', ['2026-05-06']));
    repo.upsertBars(bars('AAPL', ['2026-05-06']));
    expect(repo.readBars('AAPL', '2026-05-06', '2026-05-06').length).toBe(1);
  });

  it('different sources for the same date coexist', () => {
    repo.upsertBars([
      { symbol: 'BTC-USD', t: '2026-05-06', close: 81000, source: 'coingecko' },
      { symbol: 'BTC-USD', t: '2026-05-06', close: 81100, source: 'nasdaq' },
    ]);
    const out = repo.readBars('BTC-USD', '2026-05-06', '2026-05-06');
    expect(out.length).toBe(2);
  });

  it('symbol lookup is case-normalized to upper-case', () => {
    repo.upsertBars(bars('AAPL', ['2026-05-06']));
    expect(repo.readBars('aapl', '2026-05-06', '2026-05-06').length).toBe(1);
  });
});

describe('rangeBounds', () => {
  it('1D stays on one New York market date after midnight UTC', () => {
    expect(rangeBounds('1D', new Date('2026-07-11T01:38:00Z'))).toEqual({
      from: '2026-07-10', to: '2026-07-10', daysSpan: 0,
    });
  });

  it('1M uses the previous calendar month boundary', () => {
    const now = new Date('2026-05-06T12:00:00Z');
    const r = rangeBounds('1M', now);
    expect(r.to).toBe('2026-05-06');
    expect(r.from).toBe('2026-04-06');
  });

  it('does not roll into tomorrow after midnight UTC while New York is on the prior day', () => {
    const now = new Date('2026-07-11T01:02:00Z');
    const r = rangeBounds('1M', now);
    expect(r).toEqual({ from: '2026-06-10', to: '2026-07-10', daysSpan: 30 });
    expect(rangeBounds('1W', now)).toEqual({ from: '2026-07-03', to: '2026-07-10', daysSpan: 7 });
  });

  it('clamps calendar months at month-end and respects EST across a UTC year boundary', () => {
    expect(rangeBounds('1M', new Date('2026-04-01T01:00:00Z'))).toEqual({
      from: '2026-02-28', to: '2026-03-31', daysSpan: 31,
    });
    expect(rangeBounds('YTD', new Date('2027-01-01T02:00:00Z'))).toEqual({
      from: '2026-01-01', to: '2026-12-31', daysSpan: 364,
    });
  });

  it('YTD always starts on Jan 1 of current year', () => {
    const now = new Date('2026-05-06T12:00:00Z');
    const r = rangeBounds('YTD', now);
    expect(r.from).toBe('2026-01-01');
  });
});

describe('getSymbolHistory — cache-first behavior', () => {
  it('returns cached bars when latest cached t is fresh (no provider call)', async () => {
    // Latest cached date is the most recent weekday on/before "now",
    // so the recency check passes and we never hit the network.
    const dates = Array.from({ length: 25 }, (_, i) =>
      new Date(Date.UTC(2026, 4, 6) - i * 86_400_000).toISOString().slice(0, 10),
    ).sort();
    repo.upsertBars(bars('AAPL', dates));
    const fetcher = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetcher as unknown as typeof fetch;
    try {
      const r = await getSymbolHistory(repo, 'AAPL', '1M', new Date('2026-05-06T12:00:00Z'));
      expect(r.supported).toBe(true);
      expect(r.bars.length).toBe(25);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refetches when cache is large but latest cached t is stale (reviewer 5 #4)', async () => {
    // Plenty of bars (would have passed the old count-based heuristic),
    // but the most recent one is from a week ago — must still refetch.
    const dates: string[] = [];
    for (let i = 7; i < 35; i++) {
      dates.push(new Date(Date.UTC(2026, 4, 6) - i * 86_400_000).toISOString().slice(0, 10));
    }
    repo.upsertBars(bars('AAPL', dates));
    const originalFetch = globalThis.fetch;
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: { tradesTable: { rows: [] } } }), { status: 200 }));
    globalThis.fetch = fetcher as unknown as typeof fetch;
    try {
      await getSymbolHistory(repo, 'AAPL', '1M', new Date('2026-05-06T12:00:00Z'));
      expect(fetcher).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refetches once when a fresh cache does not reach back to the requested start', async () => {
    // A 1Y request leaves one fresh year cached; a later 5Y request must ask
    // the provider for the older bars, but only once per repo and symbol.
    const now = new Date('2026-05-06T12:00:00Z');
    const dates = Array.from({ length: 365 }, (_, i) =>
      new Date(Date.UTC(2026, 4, 6) - i * 86_400_000).toISOString().slice(0, 10),
    ).sort();
    repo.upsertBars(bars('AAPL', dates));
    const originalFetch = globalThis.fetch;
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: { tradesTable: { rows: [] } } }), { status: 200 }));
    globalThis.fetch = fetcher as unknown as typeof fetch;
    try {
      const fiveYear = await getSymbolHistory(repo, 'AAPL', '5Y', now);
      expect(fiveYear.bars).toHaveLength(365);
      expect(fetcher).toHaveBeenCalled();
      const calls = fetcher.mock.calls.length;
      await getSymbolHistory(repo, 'AAPL', '5Y', now);
      await getSymbolHistory(repo, 'AAPL', '1Y', now);
      expect(fetcher.mock.calls.length).toBe(calls);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refreshes a stale but complete cache with a short recent window, at most once per throttle window', async () => {
    const now = new Date('2026-05-06T12:00:00Z');
    const dates = Array.from({ length: 40 }, (_, i) =>
      new Date(Date.UTC(2026, 4, 1) - i * 86_400_000).toISOString().slice(0, 10),
    ).sort();
    repo.upsertBars(bars('AAPL', dates));
    const originalFetch = globalThis.fetch;
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: { tradesTable: { rows: [] } } }), { status: 200 }));
    globalThis.fetch = fetcher as unknown as typeof fetch;
    try {
      await getSymbolHistory(repo, 'AAPL', '1M', now);
      expect(String(fetcher.mock.calls[0][0])).toContain('fromdate=2026-04-24');
      const calls = fetcher.mock.calls.length;
      await getSymbolHistory(repo, 'AAPL', '1W', now);
      expect(fetcher.mock.calls.length).toBe(calls);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('1D returns supported=false with an explicit reason', async () => {
    const r = await getSymbolHistory(repo, 'AAPL', '1D');
    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(/intraday/i);
    expect(r.bars).toEqual([]);
  });

  it('serves a stale, short cache as it is from a stored-only repo (HOLDR_MARKET_DATA=stored), asking no provider', async () => {
    const stored = createHistoryRepo(state, { storedOnly: true });
    expect(stored.storedOnly).toBe(true);
    stored.upsertBars(bars('AAPL', ['2026-03-02', '2026-03-03']));
    const originalFetch = globalThis.fetch;
    const fetcher = vi.fn();
    globalThis.fetch = fetcher as unknown as typeof fetch;
    try {
      const r = await getSymbolHistory(stored, 'AAPL', '1Y', new Date('2026-05-06T12:00:00Z'));
      expect(r.bars.map((bar) => bar.t)).toEqual(['2026-03-02', '2026-03-03']);
      expect((await getSymbolHistory(stored, 'NOPE', '1M', new Date('2026-05-06T12:00:00Z'))).supported).toBe(false);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects an invalid symbol before any provider call', async () => {
    const originalFetch = globalThis.fetch;
    const fetcher = vi.fn();
    globalThis.fetch = fetcher as unknown as typeof fetch;
    try {
      const r = await getSymbolHistory(repo, 'abc:def..xyz', '1M');
      expect(r.supported).toBe(false);
      expect(r.reason).toBe('invalid symbol');
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('deduplicates bars by date with source precedence (nasdaq > coingecko)', async () => {
    repo.upsertBars([
      { symbol: 'AAPL', t: '2026-05-06', close: 100, source: 'coingecko' },
      { symbol: 'AAPL', t: '2026-05-06', close: 200, source: 'nasdaq' },
    ]);
    const r = await getSymbolHistory(repo, 'AAPL', '1W', new Date('2026-05-06T12:00:00Z'));
    expect(r.bars.length).toBe(1);
    expect(r.bars[0].source).toBe('nasdaq');
    expect(r.bars[0].close).toBe(200);
  });

  it('returns supported=false with a reason when cache is empty AND provider returns nothing', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: { tradesTable: { rows: [] } } }), { status: 200 })) as unknown as typeof fetch;
    try {
      const r = await getSymbolHistory(repo, 'NOPE', '1W');
      expect(r.supported).toBe(false);
      expect(r.reason).toMatch(/no provider/i);
      expect(r.bars).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
