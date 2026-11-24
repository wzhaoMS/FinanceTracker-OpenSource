import type { PriceBar } from './historyTypes.js';
import { fetchNasdaqHistory } from './nasdaqHistory.js';

/**
 * Trailing daily-close statistics for a symbol, used by the *indicative*
 * (overnight/weekend) pricing path for two things:
 *
 *   1. `lastClose` — the most-recent dated daily-close bar. This is the
 *      session-invariant baseline the indicative premium is measured
 *      against. We deliberately do NOT use a live quote's `previous_day_closing`
 *      field: that was empirically shown to drift by a session (CNBC returned
 *      Thursday's close on a Sunday), whereas a dated daily bar always means
 *      exactly what its date says.
 *
 *   2. `dailySigma` — standard deviation of the last ~25 daily simple returns.
 *      The "is this indicative dislocated?" flag is volatility-scaled
 *      (k·sigma) rather than a fixed percentage, because a fixed threshold is
 *      provably wrong across this book: measured gaps sit at 0.2–1.0σ for
 *      every holding, but the *absolute* gap ranges 0.7%→6.3% (NBIS σ≈7%,
 *      AMZN σ≈1.7%). A flat 2% would cry wolf on NBIS/CRWV nightly while
 *      missing a genuine AMZN dislocation.
 */
export interface DailyCloseStats {
  symbol: string;
  lastClose: number;
  /** ISO YYYY-MM-DD of `lastClose`. */
  lastCloseDate: string;
  /** Sample stdev of daily simple returns over the window; 0 if < 2 returns. */
  dailySigma: number;
  /** How many daily bars went into the stats. */
  sampleSize: number;
}

interface CacheEntry {
  stats: DailyCloseStats | null;
  fetchedAt: number;
}

// Daily bars don't change intraday; cache aggressively. The indicative path
// only runs while markets are closed, so this is fetched at most a handful of
// times per symbol per day.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const cache = new Map<string, CacheEntry>();

/** Compute sample standard deviation of an array of numbers. */
export function sampleStdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const variance =
    xs.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/**
 * Pure: turn ascending daily bars into close stats. Exposed for tests.
 * `maxReturns` caps how many trailing daily returns feed the sigma.
 */
export function computeDailyCloseStats(
  symbol: string,
  bars: PriceBar[],
  maxReturns = 25,
): DailyCloseStats | null {
  const closes = bars
    .filter((b) => Number.isFinite(b.close) && b.close > 0)
    .map((b) => ({ t: b.t, close: b.close }));
  if (closes.length === 0) return null;

  // bars arrive ascending (oldest→newest); newest is the last element.
  const newest = closes[closes.length - 1];

  // Daily simple returns over the most recent `maxReturns` steps.
  const rets: number[] = [];
  for (let i = closes.length - 1; i > 0 && rets.length < maxReturns; i--) {
    const cur = closes[i].close;
    const prev = closes[i - 1].close;
    if (prev > 0) rets.push((cur - prev) / prev);
  }

  return {
    symbol: symbol.toUpperCase(),
    lastClose: newest.close,
    lastCloseDate: newest.t,
    dailySigma: sampleStdev(rets),
    sampleSize: closes.length,
  };
}

/** Format a Date as YYYY-MM-DD (UTC) for the Nasdaq history range. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Fetch (cached) trailing daily-close stats for a symbol. Returns null on a
 * soft miss (unrecognized symbol / no rows / provider down) so the caller
 * simply omits the indicative for that symbol rather than guessing.
 *
 * `now` is injectable for tests.
 */
export async function getDailyCloseStats(
  symbol: string,
  now: Date = new Date(),
): Promise<DailyCloseStats | null> {
  const key = symbol.toUpperCase();
  const hit = cache.get(key);
  if (hit && now.getTime() - hit.fetchedAt < CACHE_TTL_MS) {
    return hit.stats;
  }

  // ~50 calendar days back yields ~34 trading sessions, plenty for 25 returns.
  const from = new Date(now.getTime() - 50 * 24 * 60 * 60 * 1000);
  let stats: DailyCloseStats | null = null;
  try {
    const bars = await fetchNasdaqHistory(key, isoDate(from), isoDate(now));
    stats = computeDailyCloseStats(key, bars);
  } catch {
    stats = null;
  }
  cache.set(key, { stats, fetchedAt: now.getTime() });
  return stats;
}

/** Test/maintenance helper. */
export function _clearDailyCloseCache(): void {
  cache.clear();
}
