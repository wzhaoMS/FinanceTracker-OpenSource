import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseNasdaqHistorical,
  type NasdaqHistoricalResponse,
} from './nasdaqHistory.js';
import {
  parseCoinGeckoHistory,
  type CoinGeckoHistoryResponse,
} from './coingeckoHistory.js';
import { usDateToIso, parseDollar } from './historyTypes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fix = (name: string) => readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8');

describe('historyTypes helpers', () => {
  it('usDateToIso converts MM/DD/YYYY to ISO', () => {
    expect(usDateToIso('05/06/2026')).toBe('2026-05-06');
    expect(usDateToIso('5/6/2026')).toBe('2026-05-06');
    expect(usDateToIso('5-6-2026')).toBeNull();
    expect(usDateToIso(undefined)).toBeNull();
    expect(usDateToIso('not a date')).toBeNull();
  });

  it('parseDollar handles $, commas, unicode minus', () => {
    expect(parseDollar('$1,234.56')).toBe(1234.56);
    expect(parseDollar('\u2212 5.00')).toBe(-5);
    expect(parseDollar(undefined)).toBeNull();
    expect(parseDollar('N/A')).toBeNull();
  });
});

describe('parseNasdaqHistorical — synthetic fixture', () => {
  it('AAPL March 2 → March 6, 2026 fixture parses 5 daily bars in chronological order', () => {
    const json = JSON.parse(fix('nasdaq-aapl-historical.json')) as NasdaqHistoricalResponse;
    const bars = parseNasdaqHistorical(json, 'AAPL');
    expect(bars.length).toBe(5);
    // Newest-first input → ascending output
    expect(bars[0].t).toBe('2026-03-02');
    expect(bars[bars.length - 1].t).toBe('2026-03-06');
    const firstBar = bars[0];
    expect(firstBar.symbol).toBe('AAPL');
    expect(firstBar.source).toBe('nasdaq');
    expect(firstBar.close).toBe(200);
    expect(firstBar.open).toBe(199);
    expect(firstBar.high).toBe(201);
    expect(firstBar.low).toBe(198);
    expect(firstBar.volume).toBe(1_000_000);
  });

  it('drops rows missing a parsable date or close', () => {
    const json: NasdaqHistoricalResponse = {
      data: {
        symbol: 'X',
        tradesTable: {
          rows: [
            { date: '05/06/2026', close: '$10.00' },
            { date: 'broken', close: '$11.00' },
            { date: '05/07/2026', close: 'N/A' },
            { date: '05/08/2026', close: '$12.50', open: undefined },
          ],
        },
      },
    };
    const bars = parseNasdaqHistorical(json, 'X');
    expect(bars.map((b) => b.t)).toEqual(['2026-05-06', '2026-05-08']);
  });

  it('returns empty array when tradesTable is missing', () => {
    expect(parseNasdaqHistorical({ data: null }, 'X')).toEqual([]);
    expect(parseNasdaqHistorical({}, 'X')).toEqual([]);
  });
});

describe('parseCoinGeckoHistory — synthetic fixture', () => {
  it('BTC 30d fixture parses to chronological daily close-only bars', () => {
    const json = JSON.parse(fix('coingecko-btc-30d.json')) as CoinGeckoHistoryResponse;
    const bars = parseCoinGeckoHistory(json, 'BTC-USD');
    expect(bars.length).toBeGreaterThan(0);
    // chronological
    for (let i = 1; i < bars.length; i++) {
      expect(bars[i].t >= bars[i - 1].t).toBe(true);
    }
    const sample = bars[0];
    expect(sample.symbol).toBe('BTC-USD');
    expect(sample.source).toBe('coingecko');
    expect(typeof sample.close).toBe('number');
    expect(sample.open).toBeUndefined();
    expect(sample.high).toBeUndefined();
  });

  it('returns empty array when prices missing or NaN', () => {
    expect(parseCoinGeckoHistory({}, 'BTC-USD')).toEqual([]);
    expect(
      parseCoinGeckoHistory({ prices: [[NaN, 100], [123, NaN]] }, 'BTC-USD'),
    ).toEqual([]);
  });
});
