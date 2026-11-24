import { afterEach, describe, it, expect, vi } from 'vitest';

import { nearestBtcPrice, computeBtcProxy, fetchBtcProxy } from './btcProxy.js';

describe('nearestBtcPrice', () => {
  const series: Array<[number, number]> = [
    [1000, 60000],
    [2000, 61000],
    [3000, 62000],
  ];
  it('picks the closest sample by time', () => {
    expect(nearestBtcPrice(series, 2100)!.price).toBe(61000);
    expect(nearestBtcPrice(series, 2900)!.price).toBe(62000);
  });
  it('returns null when nothing within tolerance', () => {
    expect(nearestBtcPrice(series, 999_999, 100)).toBeNull();
  });
  it('ignores malformed rows', () => {
    const bad = [[1000, 'x'], [2000, 61000], null] as unknown as Array<[number, number]>;
    expect(nearestBtcPrice(bad, 2000)!.price).toBe(61000);
  });
});

describe('computeBtcProxy', () => {
  it('reprices the ETF by BTC % move since close (ratio cancels)', () => {
    // FBTC closed 55.35 with BTC 63000; BTC now 65000 (+3.17%)
    const r = computeBtcProxy(
      { symbol: 'FBTC', lastClose: 55.35, lastCloseMs: 0 },
      65000,
      63000,
      123,
    )!;
    expect(r.price).toBeCloseTo(55.35 * (65000 / 63000), 6);
    expect(r.btcMove).toBeCloseTo(65000 / 63000 - 1, 6);
    expect(r.asOf).toBe(123);
  });
  it('returns null on bad inputs (no guessing)', () => {
    expect(computeBtcProxy({ symbol: 'FBTC', lastClose: 0, lastCloseMs: 0 }, 1, 1, 0)).toBeNull();
    expect(computeBtcProxy({ symbol: 'FBTC', lastClose: 55, lastCloseMs: 0 }, 0, 1, 0)).toBeNull();
    expect(computeBtcProxy({ symbol: 'FBTC', lastClose: 55, lastCloseMs: 0 }, 1, 0, 0)).toBeNull();
  });
});

describe('fetchBtcProxy — injected fetch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function mkFetch(now: number, atClose: number) {
    return (async (url: string) => {
      if (url.includes('simple/price')) {
        return { ok: true, json: async () => ({ bitcoin: { usd: now } }) } as Response;
      }
      // market_chart hourly: one sample near the close timestamp
      return {
        ok: true,
        json: async () => ({ prices: [[1_000_000, atClose]] }),
      } as Response;
    }) as unknown as typeof fetch;
  }

  it('reconstructs the indicative end-to-end', async () => {
    const r = await fetchBtcProxy(
      { symbol: 'FBTC', lastClose: 55.35, lastCloseMs: 1_000_000 },
      { fetchImpl: mkFetch(65000, 63000), now: () => 7 },
    );
    expect(r).not.toBeNull();
    expect(r!.price).toBeCloseTo(55.35 * (65000 / 63000), 6);
  });

  it('returns null if BTC-now fetch fails', async () => {
    const fetchImpl = (async () => ({ ok: false } as Response)) as unknown as typeof fetch;
    const r = await fetchBtcProxy({ symbol: 'FBTC', lastClose: 55, lastCloseMs: 0 }, { fetchImpl });
    expect(r).toBeNull();
  });

  it.each(['connection', 'body'])('shares one deadline through the history %s', async (stage) => {
    vi.useFakeTimers();
    const deadline = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), milliseconds);
      return controller.signal;
    });
    const fetchImpl = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise((resolve) => {
        setTimeout(() => resolve(new Response(JSON.stringify({ bitcoin: { usd: 65000 } }))), 4_000);
      }))
      .mockImplementationOnce(async (_url, init) => {
        const pending = new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
        if (stage === 'connection') return pending;
        const response = new Response('{}');
        response.json = () => pending;
        return response;
      });
    const request = fetchBtcProxy({ symbol: 'FBTC', lastClose: 55, lastCloseMs: 0 }, { fetchImpl });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1]?.signal).toBe(fetchImpl.mock.calls[1][1]?.signal);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(request).resolves.toBeNull();
    expect(deadline).toHaveBeenCalledTimes(1);
  });
});
