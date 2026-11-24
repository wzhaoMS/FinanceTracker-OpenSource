import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCoinGeckoQuotes, type CoinGeckoResponse } from './coingecko.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('parseCoinGeckoQuotes — math correctness', () => {
  it('computes 24h baseline as price / (1 + pct/100), NOT price * pct / 100', () => {
    // Simple synthetic case the wrong formula would get visibly wrong.
    const json: CoinGeckoResponse = {
      bitcoin: { usd: 100000, usd_24h_change: 25 /* +25% */, last_updated_at: 1_700_000_000 },
    };
    const [q] = parseCoinGeckoQuotes(json, [{ symbol: 'BTC-USD', id: 'bitcoin' }]);

    expect(q.price).toBe(100000);
    expect(q.changeBasis).toBe('24h');
    // CORRECT: prev = 100000 / 1.25 = 80000; dayChange = 100000 - 80000 = 20000
    expect(q.baselinePrice).toBeCloseTo(80000, 6);
    expect(q.dayChange).toBeCloseTo(20000, 6);
    expect(q.dayChangePercent).toBe(25);

    // Sanity: WRONG formula would give 100000 * 25 / 100 = 25000 (off by 5k).
    expect(q.dayChange).not.toBeCloseTo(25000, 0);
  });

  it('handles negative 24h change', () => {
    const json: CoinGeckoResponse = {
      ethereum: { usd: 2000, usd_24h_change: -20, last_updated_at: 1_700_000_000 },
    };
    const [q] = parseCoinGeckoQuotes(json, [{ symbol: 'ETH-USD', id: 'ethereum' }]);
    // prev = 2000 / 0.8 = 2500; change = -500
    expect(q.baselinePrice).toBeCloseTo(2500, 6);
    expect(q.dayChange).toBeCloseTo(-500, 6);
    expect(q.dayChangePercent).toBe(-20);
  });

  it('captured fixture round-trip', () => {
    const json = JSON.parse(
      readFileSync(
        path.join(__dirname, '__fixtures__', 'coingecko-btc-eth.json'),
        'utf8',
      ),
    ) as CoinGeckoResponse;
    const quotes = parseCoinGeckoQuotes(json, [
      { symbol: 'BTC-USD', id: 'bitcoin' },
      { symbol: 'ETH-USD', id: 'ethereum' },
    ]);
    expect(quotes).toHaveLength(2);
    const btc = quotes.find((q) => q.symbol === 'BTC-USD')!;
    expect(btc.price).toBeGreaterThan(0);
    expect(btc.changeBasis).toBe('24h');
    expect(btc.source).toBe('coingecko');
    // Math invariant: baseline * (1 + pct/100) ≈ price
    expect(btc.baselinePrice! * (1 + btc.dayChangePercent! / 100)).toBeCloseTo(btc.price, 6);
  });

  it('omits day-change fields when usd_24h_change is missing or NaN', () => {
    const json: CoinGeckoResponse = {
      bitcoin: { usd: 100000, last_updated_at: 1 },
    };
    const [q] = parseCoinGeckoQuotes(json, [{ symbol: 'BTC-USD', id: 'bitcoin' }]);
    expect(q.changeBasis).toBeUndefined();
    expect(q.dayChange).toBeUndefined();
  });

  it('skips coins absent from the response', () => {
    const json: CoinGeckoResponse = { bitcoin: { usd: 100000, last_updated_at: 1_700_000_000 } };
    const quotes = parseCoinGeckoQuotes(json, [
      { symbol: 'BTC-USD', id: 'bitcoin' },
      { symbol: 'ETH-USD', id: 'ethereum' },
    ]);
    expect(quotes.map((q) => q.symbol)).toEqual(['BTC-USD']);
  });

  it.each([
    { usd: 100000 },
    { usd: 0, last_updated_at: 1_700_000_000 },
    { usd: -1, last_updated_at: 1_700_000_000 },
    { usd: Infinity, last_updated_at: 1_700_000_000 },
    { usd: 100000, last_updated_at: NaN },
    { usd: 100000, last_updated_at: 32_472_000_000 },
  ])('rejects invalid prices or missing/future timestamps: %o', (bitcoin) => {
    expect(parseCoinGeckoQuotes({ bitcoin }, [{ symbol: 'BTC-USD', id: 'bitcoin' }])).toEqual([]);
  });
});
