import type { IndicativeSource } from '@finance-tracker/shared';

/**
 * BTC-proxy indicative provider for Bitcoin-ETF holdings (e.g. FBTC).
 *
 * A Bitcoin ETF only trades during US market hours, but its underlying — spot
 * BTC — trades 24/7. So while the US market is closed we can reprice the ETF
 * off BTC's move since the ETF's last official close:
 *
 *     indicative = lastClose * (btcNow / btcAtLastClose)
 *
 * The ETF's per-share BTC ratio cancels out, so we don't need to know it and
 * there's no expense-ratio drift to model — we only need BTC's percentage move
 * since the ETF closed. Verified 2026-06-14: BTC sample landed within 1 minute
 * of the 16:00 ET close, and the reconstructed FBTC tracked BTC's +3.03% move
 * exactly (implied ratio 0.0008705, matching the stable trailing cluster).
 *
 * This is the highest-confidence indicative we have, because it tracks a real
 * 24/7 asset rather than a synthetic perp on a thin venue.
 */

export const BTC_PROXY_SOURCE: IndicativeSource = 'btc-proxy';

/** Held Bitcoin-ETF tickers we can reprice off spot BTC. */
export const BTC_ETF_SYMBOLS: ReadonlySet<string> = new Set(['FBTC', 'IBIT', 'GBTC', 'BITB', 'ARKB']);

const CG_BASE = 'https://api.coingecko.com/api/v3';

export interface BtcProxyInput {
  /** ETF ticker (e.g. "FBTC"). */
  symbol: string;
  /** ETF's most recent official daily close (USD). */
  lastClose: number;
  /** Epoch ms of that close (US equity close = 16:00 ET on the close date). */
  lastCloseMs: number;
}

export interface BtcProxyResult {
  symbol: string;
  /** Reconstructed indicative price (USD). */
  price: number;
  /** Spot BTC now (USD). */
  btcNow: number;
  /** Spot BTC at the ETF's last close (USD). */
  btcAtClose: number;
  /** BTC fractional move since the ETF close. */
  btcMove: number;
  /** Epoch ms the indicative was computed. */
  asOf: number;
}

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Pure: pick the BTC price nearest `targetMs` from a CoinGecko `market_chart`
 * `prices` array (`[ms, price][]`). Returns null if none within `toleranceMs`.
 * Exposed for tests.
 */
export function nearestBtcPrice(
  prices: Array<[number, number]>,
  targetMs: number,
  toleranceMs = 3 * 60 * 60 * 1000, // 3h — hourly data, generous for holiday gaps
): { price: number; sampleMs: number } | null {
  let best: { price: number; sampleMs: number } | null = null;
  let bestDiff = Infinity;
  for (const row of prices) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const ms = toFiniteNumber(row[0]);
    const px = toFiniteNumber(row[1]);
    if (ms == null || px == null || px <= 0) continue;
    const diff = Math.abs(ms - targetMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = { price: px, sampleMs: ms };
    }
  }
  if (!best || bestDiff > toleranceMs) return null;
  return best;
}

/**
 * Pure: compute the proxy result from inputs + BTC data. Exposed for tests.
 * Returns null if any input is unusable (no guessing).
 */
export function computeBtcProxy(
  input: BtcProxyInput,
  btcNow: number,
  btcAtClose: number,
  asOf: number,
): BtcProxyResult | null {
  if (!(input.lastClose > 0) || !(btcNow > 0) || !(btcAtClose > 0)) return null;
  const btcMove = btcNow / btcAtClose - 1;
  const price = input.lastClose * (btcNow / btcAtClose);
  if (!Number.isFinite(price) || price <= 0) return null;
  return { symbol: input.symbol.toUpperCase(), price, btcNow, btcAtClose, btcMove, asOf };
}

/**
 * Fetch spot BTC now + at the ETF's last close, and reconstruct the ETF's
 * indicative price. Returns null on any soft failure. `fetchImpl`/`now`
 * injectable for tests.
 */
export async function fetchBtcProxy(
  input: BtcProxyInput,
  opts: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<BtcProxyResult | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const nowMs = (opts.now ?? Date.now)();
  const signal = AbortSignal.timeout(5_000);
  try {
    // BTC now.
    const curRes = await doFetch(`${CG_BASE}/simple/price?ids=bitcoin&vs_currencies=usd`, { signal });
    if (!curRes.ok) return null;
    const curJson = (await curRes.json()) as { bitcoin?: { usd?: unknown } };
    const btcNow = toFiniteNumber(curJson.bitcoin?.usd);
    if (btcNow == null) return null;

    // BTC history (hourly via days<=90). 3 days back covers a weekend close.
    const histRes = await doFetch(
      `${CG_BASE}/coins/bitcoin/market_chart?vs_currency=usd&days=3`,
      { signal },
    );
    if (!histRes.ok) return null;
    const histJson = (await histRes.json()) as { prices?: Array<[number, number]> };
    const prices = Array.isArray(histJson.prices) ? histJson.prices : [];
    const near = nearestBtcPrice(prices, input.lastCloseMs);
    if (!near) return null;

    return computeBtcProxy(input, btcNow, near.price, nowMs);
  } catch {
    return null;
  }
}
