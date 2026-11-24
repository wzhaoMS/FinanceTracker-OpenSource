import { formatMinor } from '../spending/spendingFormat';
import { plural } from './amazonFormat';
import type { AmazonFreshPart } from './amazonFreshItems';

/** Display words for Amazon Fresh lines in the two Amazon item views: only what the API reported. */

/** Beside a Fresh product: where its lines come from (its orders' Item Lists, not order items). */
export const FRESH_ITEM_LABEL = 'Amazon Fresh';

/**
 * What of a view's figures Amazon Fresh orders are, line by line: they count by their Fresh item lists here (the Amazon
 * Fresh tab shows each list), what those lines cost, and what was left out. `cardCharges`: for spending by card category,
 * that Spending doesn't yet split a Fresh order's card charge by its Fresh item list.
 */
export function freshPartLines(part: AmazonFreshPart | undefined, currency: string, cardCharges = false): string[] {
  if (!part) return [];
  const total = part.totals.find((entry) => entry.currency === currency);
  const cost = total ? `, ${formatMinor(total.lineMinor, currency)}`
    + (total.netLineMinor < total.lineMinor ? ` (${formatMinor(total.netLineMinor, currency)} after refunds)` : '') : '';
  const one = part.orders === 1;
  const lines = [`Amazon Fresh: ${plural(part.orders, 'order')} ${one ? 'counts' : 'count'} by ${one ? 'its' : 'their'} Fresh item `
    + `${one ? 'list' : 'lists'} here: ${plural(part.lines.priced, 'item')}${cost}`];
  const left = [
    part.lines.missing > 0 ? `${plural(part.lines.missing, 'item')} not delivered, never charged` : null,
    part.lines.unreadable > 0 ? `${plural(part.lines.unreadable, 'stored line')} that couldn't be read` : null,
  ].filter((entry): entry is string => entry !== null);
  if (left.length > 0) lines.push(`Not counted from Fresh item lists: ${left.join(' · ')}`);
  if (cardCharges) lines.push('Splitting a Fresh order\'s card charge by its Fresh item list in Spending isn\'t done yet');
  return lines;
}
