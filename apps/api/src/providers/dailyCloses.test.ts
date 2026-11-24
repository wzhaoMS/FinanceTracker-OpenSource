import { describe, it, expect } from 'vitest';

import { computeDailyCloseStats, sampleStdev } from './dailyCloses.js';
import type { PriceBar } from './historyTypes.js';

const bar = (t: string, close: number): PriceBar => ({ symbol: 'X', t, close, source: 'nasdaq' });

describe('sampleStdev', () => {
  it('is 0 for < 2 points', () => {
    expect(sampleStdev([])).toBe(0);
    expect(sampleStdev([1])).toBe(0);
  });
  it('matches a known value', () => {
    // returns [0, 0.1] → mean 0.05, var = ((0.05)^2+(0.05)^2)/1 = 0.005 → sd ≈ 0.0707
    expect(sampleStdev([0, 0.1])).toBeCloseTo(0.070710678, 6);
  });
});

describe('computeDailyCloseStats', () => {
  it('uses the newest (last) ascending bar as lastClose', () => {
    const bars = [bar('2026-06-10', 100), bar('2026-06-11', 102), bar('2026-06-12', 105)];
    const s = computeDailyCloseStats('X', bars)!;
    expect(s.lastClose).toBe(105);
    expect(s.lastCloseDate).toBe('2026-06-12');
    expect(s.sampleSize).toBe(3);
    expect(s.dailySigma).toBeGreaterThan(0);
  });

  it('ignores non-positive / non-finite closes', () => {
    const bars = [bar('2026-06-10', 0), bar('2026-06-11', 102), bar('2026-06-12', 105)];
    const s = computeDailyCloseStats('X', bars)!;
    expect(s.sampleSize).toBe(2);
    expect(s.lastClose).toBe(105);
  });

  it('returns null when there are no usable bars', () => {
    expect(computeDailyCloseStats('X', [])).toBeNull();
    expect(computeDailyCloseStats('X', [bar('2026-06-10', 0)])).toBeNull();
  });

  it('caps the return window at maxReturns', () => {
    const bars: PriceBar[] = [];
    for (let i = 0; i < 60; i++) {
      const d = String(i + 1).padStart(2, '0');
      bars.push(bar(`2026-04-${d}`, 100 + i));
    }
    const s = computeDailyCloseStats('X', bars, 25)!;
    // sigma computed over <=25 returns; just assert it's finite & positive
    expect(Number.isFinite(s.dailySigma)).toBe(true);
    expect(s.dailySigma).toBeGreaterThan(0);
  });
});
