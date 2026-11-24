import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Quote } from '@finance-tracker/shared';

import { preferNewerQuote } from './quoteProvider.js';
import { fetchCnbcQuotes } from './cnbc.js';
import { fetchStooqQuotes } from './stooq.js';
import { fetchCoinGeckoQuotes } from './coingecko.js';
import { fetchNasdaqHistory } from './nasdaqHistory.js';
import { fetchCoinGeckoHistory } from './coingeckoHistory.js';

const quote = (symbol: string, asOf: number, source: Quote['source']): Quote => ({
  symbol,
  price: asOf / 100,
  currency: 'USD',
  asOf,
  source,
});

describe('preferNewerQuote', () => {
  it('does not let an older fallback overwrite a newer cached quote', () => {
    const cached = quote('NBIS', 200, 'nasdaq');
    const fallback = quote('NBIS', 100, 'cnbc');
    expect(preferNewerQuote(cached, fallback)).toBe(cached);
  });

  it('serves last known quote when every provider misses', () => {
    const cached = quote('NBIS', 200, 'nasdaq');
    expect(preferNewerQuote(cached, undefined)).toBe(cached);
  });

  it('accepts a candidate that is at least as recent', () => {
    const cached = quote('NBIS', 100, 'cnbc');
    const current = quote('NBIS', 200, 'nasdaq');
    expect(preferNewerQuote(cached, current)).toBe(current);
  });

  it('accepts CBOE as a typed quote source', () => {
    expect(quote('NBIS260731P00165000', 200, 'cboe').source).toBe('cboe');
  });
});

describe('quote provider deadlines and fallback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.doUnmock('./indicative.js');
    vi.resetModules();
  });

  function useControlledDeadlines() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T16:00:00.000Z'));
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Provider timed out', 'TimeoutError')), milliseconds);
      return controller.signal;
    });
  }

  it.each([
    ['CNBC', fetchCnbcQuotes, 'AAPL', false],
    ['Stooq', fetchStooqQuotes, 'AAPL', false],
    ['CoinGecko', fetchCoinGeckoQuotes, 'BTC-USD', true],
  ] as const)('bounds a stalled %s request', async (_name, provider, symbol, rejects) => {
    useControlledDeadlines();
    const fetchMock = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const request = provider([symbol]).then(
      (quotes) => ({ quotes, failed: false }),
      () => ({ quotes: [], failed: true }),
    );
    const signal = fetchMock.mock.calls[0][1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(signal?.aborted).toBe(true);
    expect(await request).toEqual({ quotes: [], failed: rejects });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns a CNBC quote after Nasdaq times out', async () => {
    useControlledDeadlines();
    const { getQuotes } = await import('./quoteProvider.js');
    const fetchMock = vi.fn<typeof fetch>((url, init) => {
      if (String(url).includes('api.nasdaq.com')) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
      }
      if (String(url).includes('quote.cnbc.com')) {
        return Promise.resolve(new Response(JSON.stringify({
          FormattedQuoteResult: {
            FormattedQuote: [{ symbol: 'MSFT', code: 0, last: '100.00', last_time: '2026-09-18T16:00:00.000Z' }],
          },
        })));
      }
      throw new Error('Unexpected provider request');
    });
    vi.stubGlobal('fetch', fetchMock);

    const request = getQuotes(['MSFT'], { indicative: false });
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(request).resolves.toEqual([
      expect.objectContaining({ symbol: 'MSFT', source: 'cnbc', price: 100, freshness: 'live' }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['nasdaq', 'coingecko'])('bounds a stalled %s history body', async (provider) => {
    useControlledDeadlines();
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const response = new Response('{}');
      response.json = () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
      return response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const request = provider === 'nasdaq'
      ? fetchNasdaqHistory('AAPL', '2026-01-01', '2026-09-18')
      : fetchCoinGeckoHistory('BTC-USD', 90);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(request).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retains the newer cached quote through timeout and total provider failure', async () => {
    useControlledDeadlines();
    const { getQuotes } = await import('./quoteProvider.js');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
      data: { symbol: 'AAPL', primaryData: { lastSalePrice: '$120.00', lastTradeTimestamp: 'Sep 18, 2026 11:59 AM ET' } },
    })));
    vi.stubGlobal('fetch', fetchMock);
    const original = await getQuotes(['AAPL'], { indicative: false });
    expect(original[0]).toMatchObject({ price: 120, source: 'nasdaq' });
    await vi.advanceTimersByTimeAsync(60_001);
    fetchMock.mockImplementation((url, init) => {
      if (String(url).includes('api.nasdaq.com')) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
      }
      return Promise.resolve(new Response(JSON.stringify({
        FormattedQuoteResult: { FormattedQuote: [{
          symbol: 'AAPL', code: 0, last: '100.00', last_time: '2026-09-17T20:00:00Z',
        }] },
      })));
    });
    const refreshed = getQuotes(['AAPL'], { indicative: false });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(refreshed).resolves.toEqual(original);
    await vi.advanceTimersByTimeAsync(60_001);
    fetchMock.mockRejectedValue(new Error('Provider unavailable'));
    await expect(getQuotes(['AAPL'], { indicative: false })).resolves.toEqual(original);
  });

  it.each(['', 'N/D', '25:99:00'])(
    'does not turn an invalid Stooq timestamp into a current quote: %s', async (time) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
        `Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL.US,2026-09-17,${time},100,101,99,100,1`,
      )));
      await expect(fetchStooqQuotes(['AAPL'])).resolves.toEqual([]);
    },
  );

  it('converts the captured Stooq Warsaw clock into an actual UTC trade time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-06T15:28:00Z'));
    const fixture = readFileSync(new URL('./__fixtures__/stooq-aapl.csv', import.meta.url), 'utf8');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(fixture)));
    await expect(fetchStooqQuotes(['AAPL'])).resolves.toEqual([
      expect.objectContaining({ price: 200.125, asOf: Date.parse('2026-03-03T16:30:00Z') }),
    ]);
  });

  it('does not suppress ETF indicatives just because a crypto quote is current', async () => {
    useControlledDeadlines();
    vi.setSystemTime(new Date('2026-09-19T16:00:00Z'));
    const computeIndicatives = vi.fn().mockResolvedValue(new Map());
    vi.doMock('./indicative.js', () => ({ computeIndicatives }));
    const { getQuotes } = await import('./quoteProvider.js');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url) => new Response(JSON.stringify(
      String(url).includes('coingecko')
        ? { bitcoin: { usd: 65000, last_updated_at: Date.now() / 1000 } }
        : { data: { symbol: 'FBTC', primaryData: { lastSalePrice: '$55.00', lastTradeTimestamp: 'Sep 18, 2026' } } },
    ))));
    await getQuotes(['FBTC', 'BTC-USD']);
    expect(computeIndicatives).toHaveBeenCalledWith(['FBTC'], new Date('2026-09-19T16:00:00Z'));
  });

  it('marks an old option chain stale and never marks delayed CBOE data live', async () => {
    useControlledDeadlines();
    const { getQuotes } = await import('./quoteProvider.js');
    const symbol = 'AAPL261016C00200000';
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
      timestamp: '2026-09-17 19:50:00', data: { options: [{ option: symbol, bid: 5, ask: 6 }] },
    })));
    vi.stubGlobal('fetch', fetchMock);
    expect((await getQuotes([symbol], { indicative: false }))[0].freshness).toBe('stale');
    await vi.advanceTimersByTimeAsync(60_001);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      timestamp: '2026-09-18T16:00:00Z', data: { options: [{ option: symbol, bid: 5, ask: 6 }] },
    })));
    expect((await getQuotes([symbol], { indicative: false }))[0].freshness).toBe('delayed');
  });
});