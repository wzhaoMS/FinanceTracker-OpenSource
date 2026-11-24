import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CNBC_CHART_SOURCE, CNBC_WEEK_CHART_SOURCE, NASDAQ_CHART_SOURCE, fetchSessionIntradayBars, fetchWeekIntradayBars,
  newYorkWallClockToInstant, parseCnbcChart, parseNasdaqChart, withinWeekdaySessions,
} from './intradayBars.js';

// Nasdaq writes the New York wall-clock time as if it were UTC.
const wall = (iso: string) => Date.parse(`${iso}Z`);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('New York wall-clock times', () => {
  it.each([
    ['2026-10-19T04:00:00.000', '2026-10-19T08:00:00.000Z'],
    ['2026-10-19T09:30:00.000', '2026-10-19T13:30:00.000Z'],
    ['2026-11-02T04:00:00.000', '2026-11-02T09:00:00.000Z'],
    ['2026-11-02T16:00:00.000', '2026-11-02T21:00:00.000Z'],
    ['2026-03-06T09:30:00.000', '2026-03-06T14:30:00.000Z'],
    ['2026-03-09T09:30:00.000', '2026-03-09T13:30:00.000Z'],
  ])('reads %s New York time as %s', (time, instant) => {
    expect(new Date(newYorkWallClockToInstant(wall(time))!).toISOString()).toBe(instant);
  });

  it('has no instant for the hour the clock skips when daylight time starts', () => {
    expect(newYorkWallClockToInstant(wall('2026-03-08T02:30:00.000'))).toBeNull();
  });
});

describe('chart parsers', () => {
  it('reads Nasdaq points as New York times, on daylight and standard time, skipping bad ones', () => {
    const payload = {
      data: {
        chart: [
          { x: wall('2026-11-02T09:31:00.000'), y: 10.5 },
          { x: wall('2026-11-02T09:30:00.000'), y: '10.25' },
          { x: wall('2026-11-02T09:32:00.000'), y: 0 },
          { x: 'later', y: 11 },
          null,
        ],
      },
    };
    expect(parseNasdaqChart(payload, 'syna')).toEqual([
      { symbol: 'SYNA', t: '2026-11-02T14:30:00.000Z', close: 10.25, source: NASDAQ_CHART_SOURCE },
      { symbol: 'SYNA', t: '2026-11-02T14:31:00.000Z', close: 10.5, source: NASDAQ_CHART_SOURCE },
    ]);
    expect(parseNasdaqChart({ data: { chart: [{ x: wall('2026-10-19T09:30:00.000'), y: 1 }] } }, 'SYNA')[0].t)
      .toBe('2026-10-19T13:30:00.000Z');
    // A symbol Nasdaq does not know, or an asset class it does not chart.
    expect(parseNasdaqChart({ data: null, status: { rCode: 400 } }, 'SYNA')).toEqual([]);
  });

  it('reads CNBC bars at their real instants', () => {
    const payload = {
      barData: {
        priceBars: [
          { close: '10.2500', tradeTimeinMills: Date.parse('2026-10-19T13:30:00.000Z') },
          { close: 'N/A', tradeTimeinMills: Date.parse('2026-10-19T13:31:00.000Z') },
          { close: '10.3', tradeTimeinMills: String(Date.parse('2026-10-19T13:32:00.000Z')) },
        ],
      },
    };
    expect(parseCnbcChart(payload, 'SYNA')).toEqual([
      { symbol: 'SYNA', t: '2026-10-19T13:30:00.000Z', close: 10.25, source: CNBC_CHART_SOURCE },
      { symbol: 'SYNA', t: '2026-10-19T13:32:00.000Z', close: 10.3, source: CNBC_CHART_SOURCE },
    ]);
  });
});

describe('fetching', () => {
  it('asks Nasdaq for the symbol alone, and CNBC only when Nasdaq has nothing', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      const body = url.includes('nasdaq.com')
        ? { data: null, status: { rCode: 400 } }
        : { barData: { priceBars: [{ close: '5', tradeTimeinMills: Date.parse('2026-10-19T13:30:00.000Z') }] } };
      return new Response(JSON.stringify(body), { status: 200 });
    }));

    const bars = await fetchSessionIntradayBars('SYNA');

    expect(bars).toEqual([{ symbol: 'SYNA', t: '2026-10-19T13:30:00.000Z', close: 5, source: CNBC_CHART_SOURCE }]);
    expect(urls).toEqual([
      'https://api.nasdaq.com/api/quote/SYNA/chart?assetclass=stocks',
      'https://api.nasdaq.com/api/quote/SYNA/chart?assetclass=etf',
      'https://ts-api.cnbc.com/harmony/app/charts/1D.json?symbol=SYNA',
    ]);
  });

  it('sends nothing for what is not a public ticker', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchSessionIntradayBars('acct-1234 secret')).toEqual([]);
    expect(await fetchSessionIntradayBars('syna')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers empty when both providers fail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await fetchSessionIntradayBars('SYNA')).toEqual([]);
  });

  it("asks CNBC's five-day chart for the week, keeping only weekday session bars", async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      const bars = [
        '2026-10-16T08:00:00.000Z', // Friday 4:00 AM ET
        '2026-10-16T13:35:00.000Z', // Friday 9:35 AM
        '2026-10-17T00:00:00.000Z', // Friday 8:00 PM
        '2026-10-17T01:15:00.000Z', // Friday 9:15 PM: after the session
        '2026-10-17T16:40:00.000Z', // Saturday
        '2026-11-02T09:00:00.000Z', // Monday 4:00 AM EST
        '2026-11-02T08:55:00.000Z', // Monday 3:55 AM EST: before the session
      ].map((t, index) => ({ close: String(10 + index), tradeTimeinMills: Date.parse(t) }));
      return new Response(JSON.stringify({ barData: { priceBars: bars } }), { status: 200 });
    }));

    const bars = await fetchWeekIntradayBars('SYNA');

    expect(urls).toEqual(['https://ts-api.cnbc.com/harmony/app/charts/5D.json?symbol=SYNA']);
    expect(bars.map((bar) => [bar.t, bar.close, bar.source])).toEqual([
      ['2026-10-16T08:00:00.000Z', 10, CNBC_WEEK_CHART_SOURCE],
      ['2026-10-16T13:35:00.000Z', 11, CNBC_WEEK_CHART_SOURCE],
      ['2026-10-17T00:00:00.000Z', 12, CNBC_WEEK_CHART_SOURCE],
      ['2026-11-02T09:00:00.000Z', 15, CNBC_WEEK_CHART_SOURCE],
    ]);
  });

  it('sends nothing for the week for what is not a public ticker, and answers empty when CNBC fails', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('offline'); });
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchWeekIntradayBars('acct-1234 secret')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await fetchWeekIntradayBars('SYNA')).toEqual([]);
    expect(withinWeekdaySessions([])).toEqual([]);
  });
});
