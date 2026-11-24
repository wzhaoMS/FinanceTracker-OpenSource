import { afterEach, describe, expect, it, vi } from 'vitest';

import { METAL_SPOT_MAX_RESPONSE_BYTES, METAL_SPOT_SYMBOLS, cnbcDailyBarsUrl, fetchMetalSpotDailyBars, metalsPricesEnabled, parseCnbcDailyBars } from './metalSpotBars.js';

// Synthetic payloads only: invented closes in CNBC's bar shape. No request is ever sent: fetch is a stub.

/** Midnight in New York (EST, before daylight time) of a day, as CNBC's `tradeTimeinMills` gives it. */
const nyMidnight = (date: string) => Date.parse(`${date}T05:00:00Z`);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CNBC daily spot bars', () => {
  it('asks for a fixed metal symbol and the date range, its end exclusive', () => {
    expect(cnbcDailyBarsUrl('XAU', '2030-01-02', '2030-01-31'))
      .toBe('https://ts-api.cnbc.com/harmony/app/bars/XAU=/1D/20300102000000/20300201000000/adjusted/EST5EDT.json');
    expect(METAL_SPOT_SYMBOLS).toEqual({ XAU: 'XAU=', XAG: 'XAG=', XPT: 'XPT=', XPD: 'XPD=' });
    expect(() => cnbcDailyBarsUrl('XAU', '2030-02-01', '2030-01-31')).toThrow(RangeError);
    expect(() => cnbcDailyBarsUrl('XAU', '2030-02-30', '2030-03-01')).toThrow(RangeError);
  });

  it('reads each bar\'s New York trading day and close as written, and drops what it can\'t read', () => {
    const bars = parseCnbcDailyBars({
      barData: {
        priceBars: [
          { close: '2001.2500', tradeTime: '20300102000000', tradeTimeinMills: nyMidnight('2030-01-02') },
          { close: 2003.5, tradeTime: '20300103000000', tradeTimeinMills: String(nyMidnight('2030-01-03')) },
          { close: '2004', tradeTime: '20300104000000' },
          { close: '2005', tradeTime: '20300107000000', tradeTimeinMills: nyMidnight('2030-01-08') },
          { close: 'N/A', tradeTime: '20300108000000', tradeTimeinMills: nyMidnight('2030-01-08') },
          { close: '-1', tradeTime: '20300109000000' },
          { close: '1e3', tradeTime: '20300110000000' },
          { close: '2006', tradeTime: '20300230000000' },
          null,
        ],
      },
    }, '2030-01-31');
    expect(bars).toEqual([
      { date: '2030-01-02', close: '2001.25' }, { date: '2030-01-03', close: '2003.5' }, { date: '2030-01-04', close: '2004' },
    ]);
    expect(parseCnbcDailyBars({}, '2030-01-31')).toBeNull();
    expect(parseCnbcDailyBars(null, '2030-01-31')).toBeNull();
    expect(parseCnbcDailyBars({ barData: { priceBars: [] } }, '2030-01-31')).toEqual([]);
  });

  it('drops a bar whose epoch can\'t be read, is before 1990 or is after the day after the request\'s end, and never throws', () => {
    const bar = (date: string, epoch: unknown) => ({ close: '2000', tradeTime: `${date.replace(/-/g, '')}000000`, tradeTimeinMills: epoch });
    const bars = parseCnbcDailyBars({
      barData: {
        priceBars: [
          bar('1989-12-31', nyMidnight('1989-12-31')),
          bar('1990-01-01', nyMidnight('1990-01-01')),
          bar('2030-01-10', String(nyMidnight('2030-01-10'))),
          bar('2030-01-11', nyMidnight('2030-01-11')),
          bar('2030-01-12', nyMidnight('2030-01-12')),
          // Past any date a Date can hold: without the bound it threw, and the whole answer was lost.
          bar('2030-01-09', 9e15),
          bar('2030-01-08', Number.MAX_VALUE),
          bar('2030-01-07', Number.NaN),
          bar('2030-01-04', 'soon'),
          bar('2030-01-03', ''),
          bar('2030-01-02', -1),
          bar('2030-01-01', null),
        ],
      },
    }, '2030-01-10');
    expect(bars).toEqual([
      { date: '1990-01-01', close: '2000' }, { date: '2030-01-10', close: '2000' }, { date: '2030-01-11', close: '2000' },
      { date: '2030-01-01', close: '2000' },
    ]);
    expect(() => parseCnbcDailyBars({ barData: { priceBars: [] } }, '2030-02-30')).toThrow(RangeError);
  });

  it('reads each epoch\'s New York day across both daylight-saving changes, never UTC\'s or one fixed offset\'s (GD-11)', () => {
    // 2030: daylight time from Sunday 03-10 at 07:00Z, standard time again from Sunday 11-03 at 06:00Z. New York's
    // midnight is 04:00Z in daylight time and 05:00Z in standard time: at 03:30Z it is still the day before either way,
    // at 04:30Z only in standard time.
    const instants: Array<[string, string, string]> = [
      // [epoch, its New York day (kept), a day it isn't (dropped): UTC's, or one fixed offset's]
      ['2030-03-08T03:30:00Z', '2030-03-07', '2030-03-08'],
      ['2030-03-08T04:30:00Z', '2030-03-07', '2030-03-08'],
      ['2030-03-11T04:00:00Z', '2030-03-11', '2030-03-10'],
      ['2030-03-12T03:30:00Z', '2030-03-11', '2030-03-12'],
      ['2030-03-12T04:30:00Z', '2030-03-12', '2030-03-11'],
      ['2030-11-01T03:30:00Z', '2030-10-31', '2030-11-01'],
      ['2030-11-01T04:30:00Z', '2030-11-01', '2030-10-31'],
      ['2030-11-04T05:00:00Z', '2030-11-04', '2030-11-03'],
      ['2030-11-05T03:30:00Z', '2030-11-04', '2030-11-05'],
      ['2030-11-05T04:30:00Z', '2030-11-04', '2030-11-05'],
    ];
    const bar = (date: string, epoch: string) => ({ close: '2000', tradeTime: `${date.replace(/-/g, '')}000000`, tradeTimeinMills: Date.parse(epoch) });
    const bars = parseCnbcDailyBars({ barData: { priceBars: instants.flatMap(([epoch, day, other]) => [bar(day, epoch), bar(other, epoch)]) } },
      '2030-11-30');
    expect(bars).toEqual(instants.map(([, day]) => ({ date: day, close: '2000' })));
  });
});

describe('one request for a metal\'s daily bars', () => {
  const PAYLOAD = JSON.stringify({
    barData: {
      priceBars: [
        { close: '2000', tradeTime: '20291231000000', tradeTimeinMills: String(nyMidnight('2029-12-31')) },
        { close: '2001.5', tradeTime: '20300102000000', tradeTimeinMills: String(nyMidnight('2030-01-02')) },
        { close: '2002', tradeTime: '20300103000000', tradeTimeinMills: String(nyMidnight('2030-01-03')) },
      ],
    },
  });
  const KEPT = [{ date: '2030-01-02', close: '2001.5' }];
  const answer = (body: BodyInit | null, init: ResponseInit = {}) => new Response(body, { status: 200, ...init });
  const ask = () => fetchMetalSpotDailyBars('XAU', '2030-01-01', '2030-01-02');
  const stream = (chunks: number, size: number, onPull: () => void) => {
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        onPull();
        if (sent++ < chunks) controller.enqueue(new Uint8Array(size).fill(0x20));
        else controller.close();
      },
    });
  };

  it('asks the bars URL once, refusing redirects, and keeps the bars inside the range', async () => {
    const calls: Array<[string, RequestInit]> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return answer(PAYLOAD);
    }));
    expect(await ask()).toEqual(KEPT);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('https://ts-api.cnbc.com/harmony/app/bars/XAU=/1D/20300101000000/20300103000000/adjusted/EST5EDT.json');
    expect(calls[0][1]).toMatchObject({ redirect: 'error' });
    // A redirecting answer: fetch rejects when told to refuse it, and only following it would read the bars.
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      if (init.redirect === 'error') throw new TypeError('synthetic redirect refused');
      return answer(PAYLOAD);
    }));
    expect(await ask()).toBeNull();
  });

  it('reads at most 2 MB of an answer: past that, declared or not, there is no readable answer', async () => {
    const padded = (size: number) => PAYLOAD + ' '.repeat(size - PAYLOAD.length);
    vi.stubGlobal('fetch', vi.fn(async () => answer(padded(METAL_SPOT_MAX_RESPONSE_BYTES))));
    expect(await ask()).toEqual(KEPT);
    vi.stubGlobal('fetch', vi.fn(async () => answer(padded(METAL_SPOT_MAX_RESPONSE_BYTES + 1))));
    expect(await ask()).toBeNull();
    let pulls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => answer(stream(1, 16, () => { pulls++; }),
      { headers: { 'content-length': String(METAL_SPOT_MAX_RESPONSE_BYTES + 1) } })));
    expect(await ask()).toBeNull();
    expect(pulls).toBeLessThanOrEqual(1);
    pulls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => answer(stream(1_000_000, 16_384, () => { pulls++; }))));
    expect(await ask()).toBeNull();
    expect(pulls).toBeLessThan(METAL_SPOT_MAX_RESPONSE_BYTES / 16_384 + 4);
  });
});

describe('the price switch, HOLDR_METALS_PRICES (O93)', () => {
  it('turns fetching on for exactly 1, and for nothing else, unset included', () => {
    expect(metalsPricesEnabled({ HOLDR_METALS_PRICES: '1' })).toBe(true);
    expect(metalsPricesEnabled({})).toBe(false);
    for (const value of ['', '0', 'true', 'TRUE', 'yes', 'on', ' 1', '1 ', '01', '1.0']) {
      expect(metalsPricesEnabled({ HOLDR_METALS_PRICES: value }), JSON.stringify(value)).toBe(false);
    }
  });
});
