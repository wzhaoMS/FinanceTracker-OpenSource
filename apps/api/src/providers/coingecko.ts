import type { Quote } from '@finance-tracker/shared';

/**
 * CoinGecko public API for crypto. No API key (free tier: ~30 req/min/IP).
 *
 *   GET https://api.coingecko.com/api/v3/simple/price?ids={ids}&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true
 *
 * CoinGecko uses **internal slug ids** (e.g. "bitcoin", "ethereum"), not
 * tickers. We map a small set of common symbols and let the rest fall
 * through to the next provider.
 *
 * The Holdr convention for crypto symbols is `XXX-USD`, e.g.
 * `BTC-USD`. This provider only matches that pattern; tickers like `FBTC`
 * (a Bitcoin *ETF*) are stocks and go through the stock providers.
 *
 * Day-change baseline is 24h-ago price, NOT prior regular-session close.
 * `changeBasis: '24h'` so the UI can tag the row.
 *
 * Math note (Reviewer 4 caught this):
 *   Given current price P and percent change pct (e.g. +1.23 for +1.23%),
 *   the price 24h ago is `prev = P / (1 + pct/100)`, NOT `P * pct / 100`
 *   (that would treat the percentage as a fraction OF the current price,
 *   which is only an approximation for tiny pct values).
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

export interface CoinGeckoPriceRow {
  usd?: number;
  usd_24h_change?: number;
  last_updated_at?: number;
}

export interface CoinGeckoResponse {
  [coinId: string]: CoinGeckoPriceRow;
}

/**
 * Pure parser. Given a CoinGecko response and a list of expected (symbol, id)
 * pairs, return the matching Quotes.
 */
export function parseCoinGeckoQuotes(
  json: CoinGeckoResponse,
  pairs: Array<{ symbol: string; id: string }>,
): Quote[] {
  const quotes: Quote[] = [];
  for (const { symbol, id } of pairs) {
    const row = json[id];
    if (!row || typeof row.usd !== 'number' || !Number.isFinite(row.usd) || row.usd <= 0) continue;
    if (typeof row.last_updated_at !== 'number') continue;
    const asOf = row.last_updated_at * 1000;
    if (!Number.isFinite(asOf) || asOf <= 0 || asOf > Date.now()) continue;
    const price = row.usd;

    let changeBasis: Quote['changeBasis'];
    let baselinePrice: number | undefined;
    let dayChange: number | undefined;
    let dayChangePercent: number | undefined;
    const pct = row.usd_24h_change;
    if (typeof pct === 'number' && Number.isFinite(pct)) {
      // CORRECT formula: prev = price / (1 + pct/100). NOT price * pct / 100.
      const prev = price / (1 + pct / 100);
      if (Number.isFinite(prev) && prev > 0) {
        changeBasis = '24h';
        baselinePrice = prev;
        dayChange = price - prev;
        dayChangePercent = pct;
      }
    }

    quotes.push({
      symbol,
      price,
      currency: 'USD',
      asOf,
      source: 'coingecko',
      ...(changeBasis !== undefined && {
        changeBasis,
        baselinePrice,
        dayChange,
        dayChangePercent,
      }),
    });
  }
  return quotes;
}

export async function fetchCoinGeckoQuotes(symbols: string[]): Promise<Quote[]> {
  const pairs: Array<{ symbol: string; id: string }> = [];
  for (const s of symbols) {
    const id = toId(s);
    if (id) pairs.push({ symbol: s.toUpperCase(), id });
  }
  if (pairs.length === 0) return [];

  const ids = pairs.map((p) => p.id).join(',');
  const url =
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}` +
    `&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) return [];
  const json = (await res.json()) as CoinGeckoResponse;
  return parseCoinGeckoQuotes(json, pairs);
}
