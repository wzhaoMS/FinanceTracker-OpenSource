import { describe, it, expect } from 'vitest';

import { parseExtendedPrint, applyExtendedHours, parseNasdaqQuote, type NasdaqResponse } from './nasdaq.js';
import type { Quote } from '@finance-tracker/shared';

describe('parseExtendedPrint — defensive', () => {
  it('parses a primaryData-shaped secondary block', () => {
    const r = parseExtendedPrint({
      lastSalePrice: '$210.50',
      lastTradeTimestamp: 'Jun 15, 2026 6:30 PM ET',
    })!;
    expect(r.price).toBe(210.5);
    expect(r.asOf).toBeGreaterThan(0);
  });

  it('returns null for null / wrong-shape / bad price (fail-safe)', () => {
    expect(parseExtendedPrint(null)).toBeNull();
    expect(parseExtendedPrint({})).toBeNull();
    expect(parseExtendedPrint({ lastSalePrice: 'N/A' })).toBeNull();
    expect(parseExtendedPrint({ lastSalePrice: 123 })).toBeNull(); // number, not string
    expect(parseExtendedPrint('nope')).toBeNull();
  });

  it('does not promote a price without a valid source timestamp', () => {
    expect(parseExtendedPrint({ lastSalePrice: '$210.50' })).toBeNull();
    expect(parseExtendedPrint({ lastSalePrice: '$210.50', lastTradeTimestamp: 'N/A' })).toBeNull();
  });
});

const baseQuote = (over: Partial<Quote> = {}): Quote => ({
  symbol: 'NVDA',
  price: 205,
  currency: 'USD',
  asOf: Date.parse('2026-06-12T20:00:00Z'), // regular close
  source: 'nasdaq',
  changeBasis: 'previousClose',
  baselinePrice: 200,
  dayChange: 5,
  dayChangePercent: 2.5,
  ...over,
});

describe('applyExtendedHours', () => {
  const fresher = Date.parse('2026-06-12T23:00:00Z'); // after-hours, later than close
  const secondary = { lastSalePrice: '$210.00', lastTradeTimestamp: 'Jun 12, 2026 7:00 PM ET' };

  it('is a no-op when disabled (default-off safety)', () => {
    const q = applyExtendedHours(baseQuote(), secondary, 205, false);
    expect(q.extendedPrice).toBeUndefined();
    expect(q.price).toBe(205);
  });

  it('promotes price + sets extended fields, preserving regular day-change', () => {
    const q = applyExtendedHours(
      baseQuote(),
      { lastSalePrice: '$210.00', lastTradeTimestamp: new Date(fresher).toISOString() },
      205,
      true,
    );
    expect(q.extendedPrice).toBe(210);
    expect(q.price).toBe(210); // promoted for valuation
    // regular day-change preserved (NOT re-derived from promoted price)
    expect(q.dayChange).toBe(5);
    expect(q.baselinePrice).toBe(200);
    expect(q.extendedChange).toBeCloseTo(5, 6); // 210 - 205 regular close
    expect(q.extendedChangePercent).toBeCloseTo((5 / 205) * 100, 6);
  });

  it('ignores an extended print that is NOT fresher than the close', () => {
    const stale = { lastSalePrice: '$210.00', lastTradeTimestamp: '2026-06-12T19:00:00Z' };
    const q = applyExtendedHours(baseQuote(), stale, 205, true);
    expect(q.extendedPrice).toBeUndefined();
    expect(q.price).toBe(205);
  });

  it('rejects prints outside the sanity band (mis-shape guard)', () => {
    const wild = { lastSalePrice: '$2100.00', lastTradeTimestamp: new Date(fresher).toISOString() };
    const q = applyExtendedHours(baseQuote(), wild, 205, true);
    expect(q.extendedPrice).toBeUndefined();
    expect(q.price).toBe(205);
  });
});

describe('parseNasdaqQuote — extended flag wiring', () => {
  const json: NasdaqResponse = {
    data: {
      symbol: 'NVDA',
      primaryData: {
        lastSalePrice: '$205.00',
        netChange: '+5.00',
        percentageChange: '+2.50%',
        lastTradeTimestamp: 'Jun 12, 2026 4:00 PM ET',
        isRealTime: false,
      },
      secondaryData: {
        lastSalePrice: '$210.00',
        lastTradeTimestamp: 'Jun 12, 2026 7:00 PM ET',
      },
      marketStatus: 'After Hours',
    },
  };

  it('ignores secondaryData when the flag is OFF (default)', () => {
    const q = parseNasdaqQuote(json, 'NVDA', false)!;
    expect(q.price).toBe(205);
    expect(q.extendedPrice).toBeUndefined();
  });

  it('uses secondaryData when the flag is ON', () => {
    const q = parseNasdaqQuote(json, 'NVDA', true)!;
    expect(q.extendedPrice).toBe(210);
    expect(q.price).toBe(210);
    // regular session day-change retained
    expect(q.dayChange).toBeCloseTo(5, 6);
  });
});
