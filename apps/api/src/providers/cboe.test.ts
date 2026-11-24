import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchCboeQuotes, parseCboeQuotes, type CboeChainResponse } from './cboe.js';

const target = 'NBIS260731P00165000';

describe('CBOE delayed option quotes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('uses the verified non-crossed midpoint and exposes the raw market', () => {
    const quotes = parseCboeQuotes({
      timestamp: '2026-07-10 18:51:26',
      data: { options: [{
        option: target,
        bid: 5.70,
        ask: 6.40,
        last_trade_price: 6.05,
        prev_day_close: 7.175,
      }] },
    }, [target]);
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({
      symbol: target,
      price: 6.05,
      bid: 5.70,
      ask: 6.40,
      last: 6.05,
      pricingMethod: 'mid',
      source: 'cboe',
      freshness: 'delayed',
      baselinePrice: 7.175,
    });
    expect(quotes[0].dayChange).toBeCloseTo(-1.125);
    expect(new Date(quotes[0].asOf).toISOString()).toBe('2026-07-10T18:51:26.000Z');
  });

  it('falls back to last for a crossed market and omits an unpriceable contract', () => {
    const response: CboeChainResponse = { data: { options: [
      { option: target, bid: 7, ask: 6, last_trade_price: 6.25, last_trade_time: '2026-07-09T20:00:00Z' },
      { option: 'NBIS260731P00170000', bid: 0, ask: 0, last_trade_price: 0 },
    ] } };
    expect(parseCboeQuotes(response, [target, 'NBIS260731P00170000'])).toEqual([
      expect.objectContaining({ symbol: target, price: 6.25, pricingMethod: 'last', asOf: Date.parse('2026-07-09T20:00:00Z') }),
    ]);
  });

  it.each([undefined, '', 'N/A', '2999-01-01T00:00:00Z'])(
    'does not date an unknown or future chain as fresh: %s', (timestamp) => {
      expect(parseCboeQuotes({ timestamp, data: { options: [{ option: target, bid: 5, ask: 6 }] } }, [target])).toEqual([]);
    },
  );

  it('accepts an explicit UTC chain time and rejects an undated last trade', () => {
    const response = { timestamp: '2026-07-10T18:51:26Z', data: { options: [{ option: target, bid: 5, ask: 6 }] } };
    expect(parseCboeQuotes(response, [target])[0].asOf).toBe(Date.parse(response.timestamp));
    expect(parseCboeQuotes({ timestamp: response.timestamp, data: { options: [{ option: target, last_trade_price: 6 }] } }, [target])).toEqual([]);
  });

  it.each([
    ['2026-03-02T15:59:59', '2026-03-02T20:59:59Z'],
    ['2026-09-30T15:59:59', '2026-09-30T19:59:59Z'],
  ])('interprets unzoned last trades in Eastern time: %s', (last_trade_time, expected) => {
    const quotes = parseCboeQuotes({ data: { options: [{ option: target, last_trade_price: 6, last_trade_time }] } }, [target]);
    expect(quotes[0].asOf).toBe(Date.parse(expected));
  });

  it('uses the current midpoint for a valid zero-bid market', () => {
    const quotes = parseCboeQuotes({ timestamp: '2026-07-10 18:51:26', data: { options: [{
      option: target, bid: 0, ask: 0.05, last_trade_price: 0.5, last_trade_time: '2026-07-01T12:00:00',
    }] } }, [target]);
    expect(quotes[0]).toMatchObject({ price: 0.025, pricingMethod: 'mid' });
  });

  it('groups multiple contracts for one underlying into one chain request', async () => {
    const requestedUrls: string[] = [];
    const fakeFetch = async (input: string | URL | Request) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify({
        timestamp: '2026-07-10 18:51:26',
        data: { options: [
          { option: target, bid: 5.7, ask: 6.4, last_trade_price: 6.05 },
          { option: 'NBIS260731P00170000', bid: 6.8, ask: 7.3, last_trade_price: 7.15 },
        ] },
      }), { status: 200 });
    };
    const quotes = await fetchCboeQuotes(
      [target, 'NBIS260731P00170000'],
      fakeFetch as typeof fetch,
    );
    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toMatch(/\/NBIS\.json$/);
    expect(quotes).toHaveLength(2);
  });

  it.each(['connection', 'body'])('bounds a stalled chain %s', async (stage) => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), milliseconds);
      return controller.signal;
    });
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const pending = new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
      if (stage === 'connection') return pending;
      const response = new Response('{}');
      response.json = () => pending;
      return response;
    });
    const request = fetchCboeQuotes([target], fetchImpl);
    expect(fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(request).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});