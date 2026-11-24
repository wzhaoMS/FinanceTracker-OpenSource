import { parseOccSymbol, type Quote } from '@finance-tracker/shared';
import { parseProviderTime } from './providerTime.js';

export interface CboeOptionRow {
  option?: string;
  bid?: number;
  ask?: number;
  last_trade_price?: number;
  last_trade_time?: string | null;
  prev_day_close?: number;
}

export interface CboeChainResponse {
  timestamp?: string;
  data?: { options?: CboeOptionRow[] };
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function parseCboeQuotes(
  response: CboeChainResponse,
  requestedSymbols: readonly string[],
): Quote[] {
  const requested = new Set(requestedSymbols.map((symbol) => symbol.toUpperCase()));
  const chainTime = parseProviderTime(response.timestamp, 'UTC');
  const quotes: Quote[] = [];
  for (const row of response.data?.options ?? []) {
    const symbol = row.option?.toUpperCase();
    if (!symbol || !requested.has(symbol) || !parseOccSymbol(symbol)) continue;
    const hasMid = typeof row.bid === 'number' && Number.isFinite(row.bid) && row.bid >= 0 && positive(row.ask) && row.ask >= row.bid;
    const hasLast = positive(row.last_trade_price);
    if (!hasMid && !hasLast) continue;
    const asOf = hasMid ? chainTime : parseProviderTime(row.last_trade_time, 'America/New_York');
    if (asOf == null) continue;
    const rawPrice = hasMid ? (row.bid! + row.ask!) / 2 : row.last_trade_price!;
    const price = Math.round(rawPrice * 10_000) / 10_000;
    if (price <= 0) continue;
    const baselinePrice = positive(row.prev_day_close) ? row.prev_day_close : undefined;
    const dayChange = baselinePrice != null ? price - baselinePrice : undefined;
    quotes.push({
      symbol,
      price,
      currency: 'USD',
      asOf,
      source: 'cboe',
      freshness: 'delayed',
      bid: positive(row.bid) ? row.bid : undefined,
      ask: positive(row.ask) ? row.ask : undefined,
      last: hasLast ? row.last_trade_price : undefined,
      pricingMethod: hasMid ? 'mid' : 'last',
      ...(baselinePrice != null && dayChange != null
        ? {
            changeBasis: 'previousClose' as const,
            baselinePrice,
            dayChange,
            dayChangePercent: (dayChange / baselinePrice) * 100,
          }
        : {}),
    });
  }
  return requestedSymbols.flatMap((symbol) => {
    const quote = quotes.find((candidate) => candidate.symbol === symbol.toUpperCase());
    return quote ? [quote] : [];
  });
}

export async function fetchCboeQuotes(
  symbols: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Quote[]> {
  const contracts = symbols.map((symbol) => parseOccSymbol(symbol));
  if (contracts.some((contract) => contract == null)) {
    throw new Error('CBOE option provider received a non-OCC symbol');
  }
  const byUnderlying = new Map<string, string[]>();
  for (const contract of contracts) {
    const rows = byUnderlying.get(contract!.underlyingSymbol) ?? [];
    rows.push(contract!.symbol);
    byUnderlying.set(contract!.underlyingSymbol, rows);
  }
  const results = await Promise.allSettled(
    Array.from(byUnderlying, async ([underlying, requested]) => {
      const response = await fetchImpl(
        `https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(underlying)}.json`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5_000) },
      );
      if (!response.ok) return [];
      return parseCboeQuotes(await response.json() as CboeChainResponse, requested);
    }),
  );
  return results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
}