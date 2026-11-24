import { currentMarketSession, type Quote } from '@finance-tracker/shared';

import { getQuotes } from '../providers/quoteProvider.js';
import type { SqliteStateRepo } from './sqliteStateRepo.js';

export interface QuoteResolution {
  quotes: Quote[];
  fallbackSymbols: string[];
  missingSymbols: string[];
}

type QuoteFetcher = typeof getQuotes;
const MAX_PERSISTED_QUOTE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Resolve current quotes without turning an API restart or short provider
 * outage into a zero/blank portfolio. Provider results always win. Missing
 * symbols fall back to the newest persisted intraday mark and are explicitly
 * labeled stale so callers cannot mistake them for a live print.
 */
export async function resolveQuotes(
  state: SqliteStateRepo,
  symbols: string[],
  opts: { indicative?: boolean } = {},
  fetcher: QuoteFetcher = getQuotes,
  now: Date = new Date(),
): Promise<QuoteResolution> {
  let fetched: Quote[] = [];
  try {
    fetched = await fetcher(symbols, opts);
  } catch (error) {
    console.warn('[quotes] live resolution failed; using persisted marks:', (error as Error).message);
  }

  const fetchedBySymbol = new Map(fetched.map((quote) => [quote.symbol, quote]));
  const unresolved = symbols.filter((symbol) => !fetchedBySymbol.has(symbol));
  const persistedBySymbol = new Map<string, Quote>();
  if (unresolved.length > 0) {
    const placeholders = unresolved.map(() => '?').join(',');
    const rows = state.internalGetDb().prepare(
      `SELECT symbol, t, close
         FROM (
           SELECT symbol, t, close,
                  ROW_NUMBER() OVER (
                    PARTITION BY symbol
                    ORDER BY t DESC,
                      CASE source WHEN 'cboe' THEN 0 WHEN 'nasdaq' THEN 1 ELSE 2 END
                  ) AS rank
             FROM symbol_price_bars
            WHERE range_kind = 'intraday'
              AND symbol IN (${placeholders})
              AND t <= ?
         )
        WHERE rank = 1`,
    ).all(...unresolved, now.toISOString()) as Array<{ symbol: string; t: string; close: number }>;
    const session = currentMarketSession().session;
    for (const row of rows) {
      if (persistedBySymbol.has(row.symbol) || !Number.isFinite(row.close) || row.close <= 0) continue;
      const asOf = Date.parse(row.t);
      if (!Number.isFinite(asOf) || now.getTime() - asOf > MAX_PERSISTED_QUOTE_AGE_MS) continue;
      persistedBySymbol.set(row.symbol, {
        symbol: row.symbol,
        price: row.close,
        currency: 'USD',
        asOf,
        source: 'cache',
        freshness: 'stale',
        session,
      });
    }
  }

  const quotes = symbols.flatMap((symbol) => {
    const quote = fetchedBySymbol.get(symbol) ?? persistedBySymbol.get(symbol);
    return quote ? [quote] : [];
  });
  const fallbackSymbols = symbols.filter((symbol) => persistedBySymbol.has(symbol));
  const missingSymbols = symbols.filter((symbol) => (
    !fetchedBySymbol.has(symbol) && !persistedBySymbol.has(symbol)
  ));
  return { quotes, fallbackSymbols, missingSymbols };
}