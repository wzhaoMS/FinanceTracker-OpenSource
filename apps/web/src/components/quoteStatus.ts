import type { Quote } from '@finance-tracker/shared';

/** The badge's variant: its class (`quote-<kind>`) and colour. */
export type QuoteBadgeKind = 'live' | 'delayed' | 'eod' | 'stale' | 'pre' | 'after' | 'synthetic';

export interface QuoteBadge {
  /** Null for "No quotes", which is muted and has no variant. */
  kind: QuoteBadgeKind | null;
  text: string;
  title: string;
}

/** The tooltip's line for `synthetic` quotes, the demo's stored prices (HOLDR_MARKET_DATA=stored). */
export const SYNTHETIC_QUOTES_NOTE = 'Synthetic prices: invented demo data, not market quotes. No prices are fetched.';

const SOURCE_LABELS = new Map<string, string>([
  ['nasdaq', 'Nasdaq'], ['cnbc', 'CNBC'], ['coingecko', 'CoinGecko'], ['stooq', 'Stooq'], ['cboe', 'CBOE'], ['synthetic', 'Synthetic'],
]);

// Worst freshness wins: `stale` over `delayed`, because it means "the market is open and the data is from before".
const FRESHNESS_ORDER: Record<string, number> = { live: 0, delayed: 1, eod: 2, stale: 3 };

/**
 * The header's status badge for the current quote set. Two pieces of information:
 *
 *   1. Which US session is active right now: Pre-market, Regular (shown as "Live" when fresh), After hours, or Closed.
 *      This comes from the `session` field on the quote (computed by the API at response time).
 *   2. How fresh the underlying data is. Stale-during-open or delayed data escalates the badge to a warning colour
 *      regardless of session.
 *
 * The demo's stored prices (`synthetic` quotes) are neither: the badge says "Synthetic", and its tooltip that the
 * prices are invented. Examples (the badge, then the tooltip's first line):
 *
 *   "Live"         "Live · 2m ago · Nasdaq"          regular session, recent data
 *   "Pre-market"   "Pre-market · 4m ago · Nasdaq"    04:00–09:30 ET, fresh
 *   "After hours"  "After hours · 1m ago · Nasdaq"   16:00–20:00 ET, fresh
 *   "Closed"       "Closed · 3h ago · Nasdaq"        overnight / weekend
 *   "Stale"        "Stale · 19h ago · Nasdaq"        regular hours but data is from the prior session
 *   "Synthetic"    "Synthetic · 3h ago"              the demo's invented prices
 *   "Partial 2"    "Partial · 2m ago · Nasdaq"       two held symbols are stale or missing
 *   "No quotes"    "No quotes"                       both providers failed
 */
export function quoteBadge(quotes: readonly Quote[], symbols: readonly string[], now: number = Date.now()): QuoteBadge {
  const quotedSymbols = new Set(quotes.map((quote) => quote.symbol));
  const missingSymbols = symbols.filter((symbol) => !quotedSymbols.has(symbol));
  if (quotes.length === 0) {
    const missing = missingSymbols.length > 0 ? `\nMissing: ${missingSymbols.join(', ')}` : '';
    return { kind: null, text: 'No quotes', title: `No quotes${missing}` };
  }

  // A stored synthetic price is never "stale" (nor "live"): how old it is says nothing about the market.
  const synthetic = quotes.every((quote) => quote.source === 'synthetic');
  const anySynthetic = quotes.some((quote) => quote.source === 'synthetic');
  const staleSymbols = quotes
    .filter((quote) => quote.freshness === 'stale' && quote.source !== 'synthetic')
    .map((quote) => quote.symbol);

  const healthyQuotes = quotes.filter((quote) => quote.freshness !== 'stale');
  const ageQuotes = healthyQuotes.length > 0 ? healthyQuotes : quotes;
  const oldest = ageQuotes.reduce((m, q) => Math.min(m, q.asOf), Infinity);
  const ageMin = Math.round((now - oldest) / 60_000);

  const worstFreshness = quotes
    .map((q) => q.freshness ?? 'live')
    .reduce((a, b) => ((FRESHNESS_ORDER[b] ?? -1) > (FRESHNESS_ORDER[a] ?? -1) ? b : a), 'live');

  // Session: the first quote's (they are all computed at the same response time, so they agree). Legacy quotes without
  // one: derived from freshness.
  const session = quotes[0]?.session
    ?? (worstFreshness === 'live' || worstFreshness === 'delayed' ? 'regular' : 'closed');

  // The primary label. Stale escalates to "Stale" (always a warning); otherwise the session names it. Regular session
  // with fresh data shows "Live", the brokerage convention users expect.
  let primaryLabel: string;
  let kind: QuoteBadgeKind;
  const partial = missingSymbols.length > 0 || (staleSymbols.length > 0 && staleSymbols.length < quotes.length);
  const issueCount = new Set([...missingSymbols, ...staleSymbols]).size;
  if (partial) {
    primaryLabel = 'Partial';
    kind = 'delayed';
  } else if (synthetic) {
    primaryLabel = 'Synthetic';
    kind = 'synthetic';
  } else if (worstFreshness === 'stale') {
    primaryLabel = 'Stale';
    kind = 'stale';
  } else if (session === 'pre-market') {
    primaryLabel = 'Pre-market';
    kind = 'pre';
  } else if (session === 'after-hours') {
    primaryLabel = 'After hours';
    kind = 'after';
  } else if (session === 'closed') {
    primaryLabel = 'Closed';
    kind = 'eod';
  } else if (worstFreshness === 'delayed') {
    primaryLabel = 'Delayed';
    kind = 'delayed';
  } else {
    primaryLabel = 'Live';
    kind = 'live';
  }

  const sources = new Set(quotes.map((q) => q.source ?? 'unknown'));
  const sourceLabel = sources.size > 1 ? 'Mixed' : SOURCE_LABELS.get([...sources][0]) ?? 'Cached';

  let when: string;
  if (ageMin < 1) when = 'just now';
  else if (ageMin < 60) when = `${ageMin}m ago`;
  else if (ageMin < 24 * 60) when = `${Math.round(ageMin / 60)}h ago`;
  else when = `${Math.round(ageMin / 60 / 24)}d ago`;

  return {
    kind,
    text: partial ? `${primaryLabel} ${issueCount}` : primaryLabel,
    title: [
      primaryLabel === sourceLabel ? `${primaryLabel} · ${when}` : `${primaryLabel} · ${when} · ${sourceLabel}`,
      anySynthetic ? SYNTHETIC_QUOTES_NOTE : `session=${session} · freshness=${worstFreshness}`,
      new Date(oldest).toLocaleString(),
      staleSymbols.length > 0 ? `Stale: ${staleSymbols.join(', ')}` : null,
      missingSymbols.length > 0 ? `Missing: ${missingSymbols.join(', ')}` : null,
    ].filter(Boolean).join('\n'),
  };
}
