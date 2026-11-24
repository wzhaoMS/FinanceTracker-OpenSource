import type { MatchResult, MatchSubject, Money, OrderObservation } from './types.js';
import { minor, opaque, SOURCE } from './policy.js';

/**
 * Amazon Fresh driver tips billed separately (TIP_SPLIT_POLICY, Root 2026-10-24 04:56/04:57/05:33/05:52/05:55/06:36Z).
 * Amazon charges a Fresh order's driver tip as its own card transaction (a "tips" descriptor, after delivery), and the
 * order itself as grand total minus tip. A tipped single-card-proven order therefore never has one charge equal to its
 * grand total. Next to its total subject it gets two split subjects in the same `unique-total-match` class:
 * - `order`: grand total − tip, considered only when nothing else explains the order's charge (no other subject of the
 *   order has a candidate, and no payments-ledger subject names it but the tip's own charge: a completed Charged row
 *   naming that order alone, of exactly its tip), and then matched by the unique-total rules (bound
 *   card, settlement window, posted purchase, degree one among every subject's candidates) on an Amazon-class descriptor
 *   that is NOT a tips descriptor. It alone decides whether the order is explained by a card charge;
 * - `tip`: the tip, with the order's date and card. Stored DEFERRED (Root 06:36Z): its amount, date and card are kept
 *   for a later tip policy, but the matcher never considers it (no candidate, no contest, no link). It never holds the
 *   order or any other link.
 * The order part files its card row whole (Root 05:33Z: a Fresh order's lines are itemized from its Item List), as a
 * Fresh order's total would; the Amazon Fresh split policy (freshSplit.ts) then splits it over that list when proven.
 */
/** Amazon-class card descriptor (substring), the class the Fresh order charges were measured in. */
const AMAZON_DESCRIPTOR = /amzn|amazon|prime\s*now/i;
const TIP_WORD = /\btips?\b/i;
export const amazonDescriptor = (description: string | null | undefined): boolean => AMAZON_DESCRIPTOR.test(description ?? '');
export const tipsDescriptor = (description: string | null | undefined): boolean =>
  amazonDescriptor(description) && TIP_WORD.test(description ?? '');
/** The order's positive driver tip in minor units (0: none). */
export function orderTip(order: OrderObservation): number {
  const tip = order.summary?.find(s => s.kind === 'tip');
  return tip && minor(tip.money.amountMinor) && tip.money.amountMinor > 0 ? tip.money.amountMinor : 0;
}
export const splitRef = (orderId: string, part: 'order' | 'tip'): string => opaque('order-total-split', [orderId, part]);
/**
 * The split subjects of the order its total subject was derived from: two for a single-card-proven order with a positive
 * tip below its total, none otherwise.
 */
export function tipSplitSubjects(order: OrderObservation, total: MatchSubject): MatchSubject[] {
  const tip = orderTip(order);
  if (total.provenance !== 'order-total' || total.tenderProof !== 'single-card-complete' || !order.total
    || tip <= 0 || tip >= order.total.amountMinor) return [];
  const money = (amountMinor: number): Money => ({ currency: order.total!.currency, amountMinor });
  const base: Omit<MatchSubject, 'ref' | 'money' | 'split'> = { source: SOURCE, evidenceClass: 'unique-total-match',
    nativeOccurrenceId: null, provenance: 'order-total-split', status: 'completed', date: total.date, method: total.method,
    orderRefs: total.orderRefs, tenderProof: 'single-card-complete', allocations: [], allocationComplete: false,
    allocationHoldReason: 'item-identity-unproven' };
  return [
    { ...base, ref: splitRef(order.orderId, 'order'), money: money(order.total.amountMinor - tip),
      split: { part: 'order', totalRef: total.ref } },
    { ...base, ref: splitRef(order.orderId, 'tip'), money: money(tip), split: { part: 'tip', totalRef: total.ref } },
  ];
}
/**
 * The split subjects to store for an order now: its current ones, and any earlier one it no longer has (its order is no
 * longer a proven tipped order) rewritten `unproven`, so it is held and never linked.
 */
export function storedSplitSubjects(order: OrderObservation, total: MatchSubject,
  stored: (ref: string) => MatchSubject | undefined): MatchSubject[] {
  const current = tipSplitSubjects(order, total);
  return (['order', 'tip'] as const).flatMap((part) => {
    const next = current.find(s => s.split!.part === part);
    if (next) return [next];
    const old = stored(splitRef(order.orderId, part));
    return old ? [{ ...old, provenance: 'unproven' as const }] : [];
  });
}
/**
 * A split part's result that says nothing of the order's own charge: held because other evidence explains it
 * (`superseded`), for its total's own reason, stale, or a deferred tip part. Order views and held counts leave it out, as
 * they leave out an alias; only a part matched on its own (linked, no candidate, ambiguous) shows with its order.
 */
export const inertSplitResult = (subject: MatchSubject | undefined, result: MatchResult): boolean =>
  !!subject?.split && result.state === 'held' && result.reason !== 'no-candidate' && result.reason !== 'ambiguous';
