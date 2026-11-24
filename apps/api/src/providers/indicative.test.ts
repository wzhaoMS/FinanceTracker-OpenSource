import { describe, it, expect } from 'vitest';

import {
  buildIndicativeFields,
  buildHlIndicative,
  buildBtcProxyIndicative,
  etCloseMs,
  computeIndicatives,
  SANITY_BAND,
  DISLOCATION_ABS_FLOOR,
  THIN_VOLUME_USD,
  LIVENESS_FLOOR_USD,
} from './indicative.js';
import type { HlOracleRow } from './hyperliquid.js';
import type { DailyCloseStats } from './dailyCloses.js';
import type { BtcProxyResult } from './btcProxy.js';

const statsFor = (lastClose: number, sigma: number): DailyCloseStats => ({
  symbol: 'X',
  lastClose,
  lastCloseDate: '2026-06-12',
  dailySigma: sigma,
  sampleSize: 30,
});

describe('buildIndicativeFields — policy', () => {
  it('computes signed premium vs baseline', () => {
    const r = buildIndicativeFields(110, 100, 0.02, 10_000_000)!;
    expect(r.premiumPct).toBeCloseTo(0.1, 6);
  });

  it('rejects beyond the sanity band (wrong mapping / split / depeg)', () => {
    // 40% gap > 30% band
    expect(buildIndicativeFields(140, 100, 0.02, 10_000_000)).toBeNull();
    expect(buildIndicativeFields(50, 100, 0.02, 10_000_000)).toBeNull();
  });

  it('volatility-scaled dislocation: high-σ name tolerates a big gap', () => {
    // NBIS-like: 6.3% gap, σ=7% → threshold max(2*7,4)=14% → NOT dislocated
    const r = buildIndicativeFields(106.3, 100, 0.07, 10_000_000)!;
    expect(r.confidence).not.toBe('dislocated');
  });

  it('volatility-scaled dislocation: low-σ name flags a smaller gap', () => {
    // 8% gap, σ=1.5% → threshold max(3%,4%)=4% → 8% > 4% → dislocated
    const r = buildIndicativeFields(108, 100, 0.015, 10_000_000)!;
    expect(r.confidence).toBe('dislocated');
  });

  it('absolute floor protects low-σ names from normal 1–2% drift', () => {
    // 3% gap, σ=0.5% → threshold max(1%,4%)=4% → 3% < 4% → not dislocated
    const r = buildIndicativeFields(103, 100, 0.005, 10_000_000)!;
    expect(r.confidence).not.toBe('dislocated');
    expect(DISLOCATION_ABS_FLOOR).toBe(0.04);
  });

  it('thin when venue volume below threshold (and not dislocated)', () => {
    const r = buildIndicativeFields(101, 100, 0.05, THIN_VOLUME_USD - 1)!;
    expect(r.confidence).toBe('thin');
  });

  it('ok when liquid and within band', () => {
    const r = buildIndicativeFields(101, 100, 0.05, THIN_VOLUME_USD + 1)!;
    expect(r.confidence).toBe('ok');
  });

  it('dislocation outranks thin', () => {
    // big gap AND thin volume → dislocated label wins
    const r = buildIndicativeFields(110, 100, 0.01, 1_000)!;
    expect(r.confidence).toBe('dislocated');
  });
});

describe('buildHlIndicative', () => {
  const row = (over: Partial<HlOracleRow> = {}): HlOracleRow => ({
    symbol: 'NVDA',
    oraclePx: 105,
    premium: 0.001,
    dayNtlVlm: 10_000_000,
    ...over,
  });

  it('suppresses when no baseline stats', () => {
    expect(buildHlIndicative(row(), null, 1)).toBeNull();
  });

  it('suppresses a dead/frozen venue (volume below liveness floor)', () => {
    expect(buildHlIndicative(row({ dayNtlVlm: LIVENESS_FLOOR_USD - 1 }), statsFor(100, 0.02), 1)).toBeNull();
  });

  it('suppresses sanity-band violations', () => {
    expect(buildHlIndicative(row({ oraclePx: 200 }), statsFor(100, 0.02), 1)).toBeNull();
  });

  it('produces a USDC-tagged indicative on the happy path', () => {
    const ind = buildHlIndicative(row(), statsFor(100, 0.02), 42)!;
    expect(ind.source).toBe('hyperliquid-perp');
    expect(ind.usdcDenominated).toBe(true);
    expect(ind.baselineClose).toBe(100);
    expect(ind.asOf).toBe(42);
    expect(ind.note).toContain('USDC');
    expect(ind.premiumPct).toBeCloseTo(0.05, 6);
  });
});

describe('buildBtcProxyIndicative', () => {
  const proxy: BtcProxyResult = {
    symbol: 'FBTC',
    price: 57,
    btcNow: 65_000,
    btcAtClose: 63_000,
    btcMove: 65_000 / 63_000 - 1,
    asOf: 99,
  };
  it('builds a btc-proxy indicative (not USDC, high liquidity → never thin)', () => {
    const ind = buildBtcProxyIndicative(proxy, statsFor(55.35, 0.05), 99)!;
    expect(ind.source).toBe('btc-proxy');
    expect(ind.usdcDenominated).toBe(false);
    expect(ind.confidence).not.toBe('thin'); // BTC deeply liquid
    expect(ind.note).toContain('BTC');
  });
  it('suppresses without baseline', () => {
    expect(buildBtcProxyIndicative(proxy, null, 99)).toBeNull();
  });
});

describe('etCloseMs', () => {
  it('maps a summer (EDT) date to 16:00 ET = 20:00 UTC', () => {
    const ms = etCloseMs('2026-06-12')!;
    expect(new Date(ms).toISOString()).toBe('2026-06-12T20:00:00.000Z');
  });
  it('maps a winter (EST) date to 16:00 ET = 21:00 UTC', () => {
    const ms = etCloseMs('2026-01-15')!;
    expect(new Date(ms).toISOString()).toBe('2026-01-15T21:00:00.000Z');
  });
  it('returns null on malformed input', () => {
    expect(etCloseMs('nope')).toBeNull();
  });
});

describe('computeIndicatives — orchestration with injected deps', () => {
  it('combines HL + BTC paths and omits uncovered symbols', async () => {
    const fetchHl = async (syms: string[]) =>
      syms.includes('NVDA')
        ? [{ symbol: 'NVDA', oraclePx: 105, premium: 0.001, dayNtlVlm: 10_000_000 }]
        : [];
    const fetchBtc = async () => ({
      symbol: 'FBTC', price: 57, btcNow: 65000, btcAtClose: 63000, btcMove: 0.03, asOf: 1,
    });
    const getStats = async (sym: string) =>
      sym === 'NVDA' ? statsFor(100, 0.02) : sym === 'FBTC' ? statsFor(55.35, 0.05) : null;

    const out = await computeIndicatives(
      ['NVDA', 'FBTC', 'CEG', 'QQQ'],
      new Date('2026-06-14T20:00:00Z'),
      { fetchHl, fetchBtc, getStats },
    );
    expect([...out.keys()].sort()).toEqual(['FBTC', 'NVDA']);
    expect(out.get('NVDA')!.source).toBe('hyperliquid-perp');
    expect(out.get('FBTC')!.source).toBe('btc-proxy');
  });

  it('drops a symbol whose baseline is unavailable', async () => {
    const fetchHl = async () => [{ symbol: 'NVDA', oraclePx: 105, premium: 0, dayNtlVlm: 9e6 }];
    const getStats = async () => null;
    const out = await computeIndicatives(['NVDA'], new Date(), { fetchHl, getStats });
    expect(out.size).toBe(0);
  });

  it('exposes sane policy constants', () => {
    expect(SANITY_BAND).toBe(0.3);
    expect(LIVENESS_FLOOR_USD).toBeLessThan(THIN_VOLUME_USD);
  });
});
