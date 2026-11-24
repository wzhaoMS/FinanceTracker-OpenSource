import { afterEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyFreshness } from '@finance-tracker/shared';

import {
  fetchNasdaqQuotes,
  parseNasdaqQuote,
  parseDollarString,
  parsePercentString,
  parseNasdaqTime,
  type NasdaqResponse,
} from './nasdaq.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, '__fixtures__');

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIX, name), 'utf8')) as T;
}

describe('Nasdaq parsers — string normalization', () => {
  it('parseDollarString handles $ and commas and unicode minus', () => {
    expect(parseDollarString('$1,234.56')).toBe(1234.56);
    expect(parseDollarString('+0.15')).toBe(0.15);
    expect(parseDollarString('\u22122.45')).toBe(-2.45); // U+2212 minus
    expect(parseDollarString('-3.50')).toBe(-3.5);
  });

  it('parseDollarString returns null for missing/UNCH/N/A', () => {
    expect(parseDollarString(undefined)).toBeNull();
    expect(parseDollarString(null as unknown as string)).toBeNull();
    expect(parseDollarString('')).toBeNull();
    expect(parseDollarString('N/A')).toBeNull();
    expect(parseDollarString('--')).toBeNull();
    expect(parseDollarString('UNCH')).toBeNull();
  });

  it('parsePercentString strips % and handles signs', () => {
    expect(parsePercentString('+0.05%')).toBe(0.05);
    expect(parsePercentString('-1.20%')).toBe(-1.2);
    expect(parsePercentString('\u22120.5%')).toBe(-0.5);
    expect(parsePercentString('UNCH')).toBeNull();
    expect(parsePercentString(undefined)).toBeNull();
  });

  it('parseNasdaqTime parses both intraday and EOD timestamps', () => {
    const intraday = parseNasdaqTime('May 6, 2026 11:27 AM ET');
    expect(typeof intraday).toBe('number');
    // 11:27 ET in May = 15:27 UTC (EDT, -4)
    expect(new Date(intraday!).toISOString()).toBe('2026-05-06T15:27:00.000Z');

    const eod = parseNasdaqTime('May 5, 2026');
    expect(new Date(eod!).toISOString()).toBe('2026-05-05T20:00:00.000Z');
  });

  it.each([
    ['Mar 2, 2026 11:27 AM ET', '2026-03-02T16:27:00.000Z'],
    ['Mar 9, 2026 11:27 AM ET', '2026-03-09T15:27:00.000Z'],
    ['Oct 30, 2026 11:27 AM ET', '2026-10-30T15:27:00.000Z'],
    ['Nov 2, 2026 11:27 AM ET', '2026-11-02T16:27:00.000Z'],
  ])('uses the actual Eastern offset for intraday quote %s', (timestamp, expected) => {
    expect(new Date(parseNasdaqTime(timestamp, new Date('2026-12-01T22:00:00Z'))!).toISOString()).toBe(expected);
  });

  it.each([
    ['Sep 30, 2026', '2026-09-30T20:00:00.000Z'],
    ['Jan 30, 2026 ET', '2026-01-30T21:00:00.000Z'],
    ['Mar 2, 2026', '2026-03-02T21:00:00.000Z'],
    ['Nov 2, 2026', '2026-11-02T21:00:00.000Z'],
    ['Sep 30, 2026ET', '2026-09-30T20:00:00.000Z'],
  ])('uses the regular-session close for date-only quote %s', (timestamp, expected) => {
    expect(new Date(parseNasdaqTime(timestamp, new Date('2026-12-01T22:00:00Z'))!).toISOString()).toBe(expected);
  });

  it.each([undefined, '', 'N/A', '--', 'not a date', 'Sep 30, 2026 25:99 AM ET', 'Feb 31, 2026', 'Feb 31, 2026 11:27 AM ET'])(
    'rejects an unknown or invalid source time: %s', (timestamp) => {
      expect(parseNasdaqTime(timestamp, new Date('2026-09-30T18:00:00Z'))).toBeNull();
    },
  );

  it.each(['2026-10-01T12:00:00Z', '2026-10-01T14:00:00Z'])(
    'does not manufacture a future close at %s', (now) => {
      expect(parseNasdaqTime('Oct 1, 2026', new Date(now))).toBeNull();
      expect(parseNasdaqTime('Oct 1, 2026 4:00 PM ET', new Date(now))).toBeNull();
      expect(parseNasdaqTime('2026-10-01T20:00:00Z', new Date(now))).toBeNull();
    },
  );

  it('labels the latest date-only close EOD but not live or fresh next session', () => {
    const asOf = parseNasdaqTime('Sep 30, 2026', new Date('2026-10-01T02:30:00Z'))!;
    expect(classifyFreshness(asOf, new Date('2026-10-01T02:30:00.000Z'))).toBe('eod');
    expect(classifyFreshness(asOf, new Date('2026-10-01T14:30:00.000Z'))).toBe('stale');
    expect(classifyFreshness(asOf, new Date('2026-09-30T14:30:00.000Z'))).toBe('stale');
  });
});

describe('parseNasdaqQuote — captured fixtures', () => {
  it('AAPL stock: builds a Quote with previousClose-based day change', () => {
    const json = loadJson<NasdaqResponse>('nasdaq-aapl.json');
    const q = parseNasdaqQuote(json, 'AAPL');
    expect(q).not.toBeNull();
    expect(q!.symbol).toBe('AAPL');
    expect(q!.price).toBe(200);
    expect(q!.source).toBe('nasdaq');
    expect(q!.changeBasis).toBe('previousClose');
    // baseline = 200.00 - 2.00 = 198.00
    expect(q!.baselinePrice).toBeCloseTo(198, 5);
    expect(q!.dayChange).toBeCloseTo(2, 5);
    // provider says +1.01%, derived from 2/198 ≈ 1.0101%; both within 0.5pp → use provider's
    expect(q!.dayChangePercent).toBe(1.01);
  });

  it('QQQ ETF: same shape as stocks', () => {
    const json = loadJson<NasdaqResponse>('nasdaq-qqq.json');
    const q = parseNasdaqQuote(json, 'QQQ')!;
    expect(q.symbol).toBe('QQQ');
    expect(q.price).toBe(500);
    expect(q.changeBasis).toBe('previousClose');
    expect(q.dayChange).toBeCloseTo(5, 5);
    expect(q.dayChangePercent).toBe(1.01);
  });

  it('VFIAX mutual fund: EOD timestamp, day change still derived', () => {
    const json = loadJson<NasdaqResponse>('nasdaq-vfiax.json');
    const q = parseNasdaqQuote(json, 'VFIAX')!;
    expect(q.symbol).toBe('VFIAX');
    expect(q.price).toBe(400);
    expect(q.changeBasis).toBe('previousClose');
    expect(q.dayChange).toBeCloseTo(4, 5);
    expect(new Date(q.asOf).toISOString()).toBe('2026-03-03T21:00:00.000Z');
  });

  it('returns null for empty primaryData', () => {
    expect(parseNasdaqQuote({ data: { primaryData: null } }, 'X')).toBeNull();
    expect(parseNasdaqQuote({}, 'X')).toBeNull();
  });

  it('does not publish a quote with unknown time or a nonpositive price', () => {
    expect(parseNasdaqQuote({ data: { primaryData: { lastSalePrice: '$100.00' } } }, 'X')).toBeNull();
    for (const lastSalePrice of ['$0.00', '-1.00']) {
      expect(parseNasdaqQuote({ data: { primaryData: {
        lastSalePrice, lastTradeTimestamp: 'May 6, 2026 12:00 PM ET',
      } } }, 'X')).toBeNull();
    }
  });

  it('omits day-change fields when netChange is missing', () => {
    const json: NasdaqResponse = {
      data: {
        symbol: 'TEST',
        primaryData: {
          lastSalePrice: '$100.00',
          // no netChange / percentageChange
          lastTradeTimestamp: 'May 6, 2026 12:00 PM ET',
          isRealTime: true,
        },
      },
    };
    const q = parseNasdaqQuote(json, 'TEST')!;
    expect(q.price).toBe(100);
    expect(q.changeBasis).toBeUndefined();
    expect(q.baselinePrice).toBeUndefined();
    expect(q.dayChange).toBeUndefined();
  });
});

describe('fetchNasdaqQuotes deadlines', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function useControlledDeadline() {
    vi.useFakeTimers();
    return vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Quote request timed out', 'TimeoutError')), milliseconds);
      return controller.signal;
    });
  }

  it('stops a stalled connection without retrying every asset class', async () => {
    const deadline = useControlledDeadline();
    const fetchMock = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const request = fetchNasdaqQuotes(['AAPL']);
    expect(deadline).toHaveBeenCalledWith(5_000);
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(request).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shares the deadline across asset classes and response-body reads', async () => {
    const deadline = useControlledDeadline();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: null })))
      .mockImplementationOnce(async (_url, init) => ({
        ok: true,
        json: () => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }),
      } as Response));
    vi.stubGlobal('fetch', fetchMock);

    const request = fetchNasdaqQuotes(['QQQ']);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(fetchMock.mock.calls[1][1]?.signal);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(request).resolves.toEqual([]);
    expect(deadline).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('still resolves an ETF from the next asset class before the deadline', async () => {
    useControlledDeadline();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: null })))
      .mockResolvedValueOnce(new Response(JSON.stringify(loadJson<NasdaqResponse>('nasdaq-qqq.json'))));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchNasdaqQuotes(['QQQ'])).resolves.toEqual([
      expect.objectContaining({ symbol: 'QQQ', source: 'nasdaq', price: 500 }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
