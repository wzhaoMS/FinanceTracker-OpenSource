import type { PriceBar } from './historyTypes.js';

/**
 * CoinGecko daily market chart for crypto symbols.
 *
 *   GET https://api.coingecko.com/api/v3/coins/{id}/market_chart
 *       ?vs_currency=usd&days={N}&interval=daily
 *
 * Returns `prices: [[ms, price], …]`. We only have day-close (their `daily`
 * interval emits one row per UTC day); OHLV not available without a paid plan.
 */

const SYMBOL_TO_ID: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  ADA: 'cardano',
  DOGE: 'dogecoin',
  XRP: 'ripple',
  USDT: 'tether',
  USDC: 'usd-coin',
  BNB: 'binancecoin',
  AVAX: 'avalanche-2',
  MATIC: 'matic-network',
  DOT: 'polkadot',
};

function toId(symbol: string): string | null {
  const m = symbol.toUpperCase().match(/^([A-Z]{2,6})-USD$/);
  if (!m) return null;
  return SYMBOL_TO_ID[m[1]] ?? null;
}

export interface CoinGeckoHistoryResponse {
  prices?: Array<[number, number]>;
}

export function parseCoinGeckoHistory(
  json: CoinGeckoHistoryResponse,
  symbol: string,
): PriceBar[] {
  const rows = json.prices ?? [];
  const bars: PriceBar[] = [];
  for (const [ms, price] of rows) {
    if (!Number.isFinite(ms) || !Number.isFinite(price)) continue;
    bars.push({
      symbol: symbol.toUpperCase(),
      t: new Date(ms).toISOString().slice(0, 10),
      close: price,
      source: 'coingecko',
    });
  }
  // Already chronological from CoinGecko, but assert.
  bars.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return bars;
}

/**
 * Fetch CoinGecko daily history. `days` ≤ 90 returns 5-min granularity by
 * default; with `interval=daily` we get one bar per UTC day. Returns empty
 * for non-crypto or unrecognized symbols.
 */
export async function fetchCoinGeckoHistory(
  symbol: string,
  days: number,
): Promise<PriceBar[]> {
  const id = toId(symbol);
  if (!id) return [];
  const url =
    `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart` +
    `?vs_currency=usd&days=${Math.max(1, Math.min(days, 365 * 5))}&interval=daily`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return [];
    const json = (await res.json()) as CoinGeckoHistoryResponse;
    return parseCoinGeckoHistory(json, symbol);
  } catch {
    return [];
  }
}
