import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseHyperliquidOracles,
  fetchHyperliquidOracles,
  _clearHyperliquidCache,
  HL_ALLOWLIST,
} from './hyperliquid.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.join(__dirname, '__fixtures__', 'hyperliquid-xyz.json'), 'utf8'),
);

describe('parseHyperliquidOracles', () => {
  it('parses the fixture for allowlisted symbols', () => {
    const rows = parseHyperliquidOracles(fixture, ['NVDA', 'NBIS', 'TSLA']);
    const bySym = new Map(rows.map((r) => [r.symbol, r]));
    expect(bySym.has('NVDA')).toBe(true);
    expect(bySym.get('NVDA')!.oraclePx).toBeGreaterThan(0);
    // string→number coercion worked
    expect(typeof bySym.get('NVDA')!.oraclePx).toBe('number');
    expect(typeof bySym.get('NVDA')!.dayNtlVlm).toBe('number');
  });

  it('NEVER maps index/sector/meme tickers (collision guard)', () => {
    // SP500 and QQQ must never resolve, even though xyz lists SP500.
    const rows = parseHyperliquidOracles(fixture, ['SP500', 'QQQ', 'GOLD', 'VIX', 'SMH']);
    expect(rows).toHaveLength(0);
  });

  it('only returns requested AND allowlisted symbols', () => {
    const rows = parseHyperliquidOracles(fixture, ['NVDA', 'CEG', 'VST']);
    expect(rows.map((r) => r.symbol).sort()).toEqual(['NVDA']);
  });

  it('returns [] for garbage / wrong-shape input (defensive)', () => {
    expect(parseHyperliquidOracles(null, ['NVDA'])).toEqual([]);
    expect(parseHyperliquidOracles({}, ['NVDA'])).toEqual([]);
    expect(parseHyperliquidOracles([{}], ['NVDA'])).toEqual([]);
    expect(parseHyperliquidOracles([{ universe: 'x' }, []], ['NVDA'])).toEqual([]);
    expect(parseHyperliquidOracles('nope', ['NVDA'])).toEqual([]);
  });

  it('skips rows with non-positive / non-numeric oracle', () => {
    const bad = [
      { universe: [{ name: 'xyz:NVDA' }, { name: 'xyz:TSLA' }] },
      [{ oraclePx: '0' }, { oraclePx: 'abc' }],
    ];
    expect(parseHyperliquidOracles(bad, ['NVDA', 'TSLA'])).toEqual([]);
  });

  it('allowlist contains no index/sector tickers', () => {
    for (const k of Object.keys(HL_ALLOWLIST)) {
      expect(['SP500', 'QQQ', 'SMH', 'XLE', 'VIX', 'GOLD']).not.toContain(k);
    }
  });
});

describe('fetchHyperliquidOracles', () => {
  beforeEach(() => _clearHyperliquidCache());

  it('returns [] when no requested symbol is allowlisted (no fetch)', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return { ok: true, json: async () => fixture } as Response;
    }) as unknown as typeof fetch;
    const rows = await fetchHyperliquidOracles(['CEG', 'VST'], { fetchImpl });
    expect(rows).toEqual([]);
    expect(called).toBe(false);
  });

  it('fetches the full allowlist once and serves filtered from cache', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return { ok: true, json: async () => fixture } as Response;
    }) as unknown as typeof fetch;
    const now = () => 1_000_000;

    const a = await fetchHyperliquidOracles(['NVDA'], { fetchImpl, now });
    const b = await fetchHyperliquidOracles(['TSLA'], { fetchImpl, now });
    expect(a.map((r) => r.symbol)).toEqual(['NVDA']);
    expect(b.map((r) => r.symbol)).toEqual(['TSLA']);
    expect(calls).toBe(1); // second call served from cache
  });

  it('returns [] on fetch failure (graceful)', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const rows = await fetchHyperliquidOracles(['NVDA'], { fetchImpl });
    expect(rows).toEqual([]);
  });

  it('returns [] on non-ok response', async () => {
    const fetchImpl = (async () => ({ ok: false } as Response)) as unknown as typeof fetch;
    const rows = await fetchHyperliquidOracles(['NVDA'], { fetchImpl });
    expect(rows).toEqual([]);
  });
});
