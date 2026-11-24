import { classifyFreshness, currentMarketSession, type Quote } from '@finance-tracker/shared';

/**
 * Quotes read back from the browser cache: well-formed entries only, with freshness and market
 * session recomputed for now (a cached quote is never live).
 */
export function normalizeCachedQuotes(raw: unknown): Quote[] {
  if (!Array.isArray(raw)) return [];
  const session = currentMarketSession().session;
  return raw
    .filter((quote): quote is Quote => (
      quote != null
      && typeof quote === 'object'
      && typeof (quote as Quote).symbol === 'string'
      && Number.isFinite((quote as Quote).price)
      && Number.isFinite((quote as Quote).asOf)
    ))
    .map((quote) => ({
      ...quote,
      freshness: quote.source === 'cache'
        ? 'stale'
        : quote.source === 'cboe'
          ? 'delayed'
          : classifyFreshness(quote.asOf),
      session,
      indicative: undefined,
    }));
}

export function mergeQuotesByRecency(current: Quote[], incoming: Quote[], symbols: string[]): Quote[] {
  const currentBySymbol = new Map(current.map((quote) => [quote.symbol, quote]));
  const incomingBySymbol = new Map(incoming.map((quote) => [quote.symbol, quote]));
  const session = currentMarketSession().session;
  return symbols.flatMap((symbol) => {
    const prior = currentBySymbol.get(symbol);
    const candidate = incomingBySymbol.get(symbol);
    const selected = !prior
      ? candidate
      : !candidate
        ? prior
        : candidate.asOf >= prior.asOf ? candidate : prior;
    return selected
      ? [{
          ...selected,
          freshness: selected.source === 'cache'
            ? 'stale'
            : selected.source === 'cboe'
              ? 'delayed'
              : classifyFreshness(selected.asOf),
          session,
        }]
      : [];
  });
}
