import { dayChangeDisplayBasis } from '@finance-tracker/shared';
import type { QuoteChangeBasis, QuoteFreshness, QuoteSession } from '@finance-tracker/shared';

/** What a day change is measured over, in words. */
export interface DayChangeNote {
  /** In full: what a holding writes under its change, and what a screen reader hears in the ticker. */
  text: string;
  /** As the ticker draws it where space is tight ("24h"); the same as `text` when that is already short. */
  short: string;
}

/**
 * What a shown day change is measured over, in words, when it is not the regular session against the prior close; null
 * for the brokerage default, and for a change the holdings don't show (no basis, stale, or measured from the open; see
 * `dayChangeDisplayBasis`). An explicit basis (24h, provider) wins over the session (pre-market, after hours). For
 * 'previousClose' during extended hours the number is the extended-hours move (Nasdaq's baseline switches at the
 * close); the words say so. One rule for the holdings and the ticker.
 */
export function dayChangeNote(quote: {
  changeBasis?: QuoteChangeBasis;
  freshness?: QuoteFreshness;
  session?: QuoteSession;
}): DayChangeNote | null {
  const basis = dayChangeDisplayBasis(quote);
  if (basis === '24h') return { text: '24-hour change', short: '24h' };
  if (basis === 'provider') return { text: 'approximate', short: 'approximate' };
  if (basis !== 'previousClose') return null;
  if (quote.session === 'pre-market') return { text: 'pre-market', short: 'pre-market' };
  if (quote.session === 'after-hours') return { text: 'after hours', short: 'after hours' };
  return null;
}
