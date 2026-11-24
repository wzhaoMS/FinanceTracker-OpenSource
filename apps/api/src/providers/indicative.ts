import type { IndicativeQuote, IndicativeConfidence } from '@finance-tracker/shared';

import { type DailyCloseStats, getDailyCloseStats } from './dailyCloses.js';
import {
  type HlOracleRow,
  HL_ALLOWLIST,
  HL_SOURCE,
  fetchHyperliquidOracles,
} from './hyperliquid.js';
import {
  BTC_ETF_SYMBOLS,
  BTC_PROXY_SOURCE,
  type BtcProxyResult,
  fetchBtcProxy,
} from './btcProxy.js';

/**
 * Indicative (overnight/weekend) price orchestrator.
 *
 * Combines raw venue data (Hyperliquid perp oracle, BTC-proxy) with
 * session-invariant baseline closes to produce clearly-labeled, non-official
 * `IndicativeQuote`s. ALL policy lives here so it's auditable in one place:
 *
 *   - Baseline = most-recent dated daily close (NOT a live prev-close field).
 *   - Sanity band: reject if |indicative/close − 1| exceeds `SANITY_BAND`
 *     (catches wrong-mapping, mini-contracts, splits, USDC depeg).
 *   - Dislocation flag is VOLATILITY-SCALED: |premium| > max(K·σ, ABS_FLOOR).
 *     Grounded in measured data — a fixed % is provably wrong across this book
 *     (gaps sit at 0.2–1.0σ but 0.7%→6.3% absolute).
 *   - Liveness/liquidity from `dayNtlVlm` (HL gives no timestamp): below
 *     `LIVENESS_FLOOR` we suppress entirely (treat as frozen/dead market).
 *   - HL prices are USDC-denominated → tagged.
 */

// --- Policy constants (all grounded in 2026-06-14 measurements) -------------

/** Reject indicatives more than this far from the official close. */
export const SANITY_BAND = 0.30;
/** Dislocation threshold = max(K·σ, ABS_FLOOR). */
export const DISLOCATION_K = 2;
/** Absolute floor so low-σ symbols don't flag on normal 1–2% drift. */
export const DISLOCATION_ABS_FLOOR = 0.04;
/** Below this 24h notional (USDC) → 'thin' confidence. PLTR/COIN sit here. */
export const THIN_VOLUME_USD = 2_500_000;
/** Below this 24h notional → suppress (venue effectively dead/frozen). */
export const LIVENESS_FLOOR_USD = 250_000;

/**
 * Pure: classify confidence and build the premium given an oracle price,
 * baseline close, σ, and venue volume. Exposed for tests.
 * Returns null when the sanity band rejects the datum.
 */
export function buildIndicativeFields(
  price: number,
  baselineClose: number,
  dailySigma: number,
  dayNtlVlm: number,
): { premiumPct: number; confidence: IndicativeConfidence } | null {
  if (!(baselineClose > 0) || !(price > 0)) return null;
  const premiumPct = (price - baselineClose) / baselineClose;

  // Sanity band: a gap this large means wrong mapping / split / depeg.
  if (Math.abs(premiumPct) > SANITY_BAND) return null;

  const threshold = Math.max(DISLOCATION_K * dailySigma, DISLOCATION_ABS_FLOOR);
  let confidence: IndicativeConfidence;
  if (Math.abs(premiumPct) > threshold) {
    confidence = 'dislocated';
  } else if (dayNtlVlm < THIN_VOLUME_USD) {
    confidence = 'thin';
  } else {
    confidence = 'ok';
  }
  return { premiumPct, confidence };
}

/**
 * Pure: build a full HL `IndicativeQuote` from a raw oracle row + baseline
 * stats. Returns null if suppressed (dead venue or sanity-band reject).
 */
export function buildHlIndicative(
  row: HlOracleRow,
  stats: DailyCloseStats | null,
  asOf: number,
): IndicativeQuote | null {
  if (!stats) return null; // no trustworthy baseline → no indicative
  if (row.dayNtlVlm < LIVENESS_FLOOR_USD) return null; // frozen/dead market

  const fields = buildIndicativeFields(
    row.oraclePx,
    stats.lastClose,
    stats.dailySigma,
    row.dayNtlVlm,
  );
  if (!fields) return null;

  const notes: string[] = ['USDC-priced'];
  if (fields.confidence === 'thin') notes.push('thin venue volume');
  if (fields.confidence === 'dislocated') notes.push('large vs last close — likely venue froth');

  return {
    price: row.oraclePx,
    source: HL_SOURCE,
    asOf,
    baselineClose: stats.lastClose,
    premiumPct: fields.premiumPct,
    confidence: fields.confidence,
    usdcDenominated: true,
    note: notes.join('; '),
  };
}

/** Pure: build a BTC-proxy `IndicativeQuote`. Returns null if rejected. */
export function buildBtcProxyIndicative(
  proxy: BtcProxyResult,
  stats: DailyCloseStats | null,
  asOf: number,
): IndicativeQuote | null {
  if (!stats) return null;
  const fields = buildIndicativeFields(
    proxy.price,
    stats.lastClose,
    stats.dailySigma,
    // BTC is always deeply liquid; volume gate N/A → pass a large sentinel.
    Number.MAX_SAFE_INTEGER,
  );
  if (!fields) return null;
  return {
    price: proxy.price,
    source: BTC_PROXY_SOURCE,
    asOf,
    baselineClose: stats.lastClose,
    premiumPct: fields.premiumPct,
    confidence: fields.confidence,
    usdcDenominated: false,
    note: `BTC ${(proxy.btcMove * 100 >= 0 ? '+' : '')}${(proxy.btcMove * 100).toFixed(2)}% since close`,
  };
}

/**
 * Convert an ISO date (YYYY-MM-DD) + 16:00 America/New_York (US equity close)
 * to epoch ms, DST-safe. Tries UTC-4 (EDT) and UTC-5 (EST) candidates and
 * keeps whichever formats back to 16:00 ET. Hour precision is enough (the BTC
 * sampler tolerates 3h).
 */
export function etCloseMs(isoDate: string): number | null {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  for (const offset of [4, 5]) {
    const cand = Date.UTC(y, mo - 1, d, 16 + offset, 0, 0);
    const et = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      hour12: false,
    }).formatToParts(new Date(cand));
    const hr = parseInt(et.find((p) => p.type === 'hour')?.value ?? '-1', 10) % 24;
    if (hr === 16) return cand;
  }
  // Fallback: EDT assumption. One-hour error is within BTC sampler tolerance.
  return Date.UTC(y, mo - 1, d, 20, 0, 0);
}

/**
 * Compute indicatives for the requested symbols. Returns a Map keyed by
 * uppercase ticker. Symbols with no coverage / soft failures are simply
 * absent (never a wrong value). `deps` injectable for tests.
 */
export async function computeIndicatives(
  symbols: string[],
  now: Date = new Date(),
  deps: {
    fetchHl?: typeof fetchHyperliquidOracles;
    fetchBtc?: typeof fetchBtcProxy;
    getStats?: typeof getDailyCloseStats;
  } = {},
): Promise<Map<string, IndicativeQuote>> {
  const fetchHl = deps.fetchHl ?? fetchHyperliquidOracles;
  const fetchBtc = deps.fetchBtc ?? fetchBtcProxy;
  const getStats = deps.getStats ?? getDailyCloseStats;
  const asOf = now.getTime();

  const upper = symbols.map((s) => s.toUpperCase());
  const hlSymbols = upper.filter((s) => HL_ALLOWLIST[s]);
  const btcSymbols = upper.filter((s) => BTC_ETF_SYMBOLS.has(s));

  const out = new Map<string, IndicativeQuote>();

  // --- Hyperliquid path ----------------------------------------------------
  if (hlSymbols.length > 0) {
    const rows = await fetchHl(hlSymbols);
    await Promise.all(
      rows.map(async (row) => {
        const stats = await getStats(row.symbol, now);
        const ind = buildHlIndicative(row, stats, asOf);
        if (ind) out.set(row.symbol, ind);
      }),
    );
  }

  // --- BTC-proxy path ------------------------------------------------------
  await Promise.all(
    btcSymbols.map(async (sym) => {
      const stats = await getStats(sym, now);
      if (!stats) return;
      const closeMs = etCloseMs(stats.lastCloseDate);
      if (closeMs == null) return;
      const proxy = await fetchBtc({ symbol: sym, lastClose: stats.lastClose, lastCloseMs: closeMs });
      if (!proxy) return;
      const ind = buildBtcProxyIndicative(proxy, stats, asOf);
      if (ind) out.set(sym, ind);
    }),
  );

  return out;
}
