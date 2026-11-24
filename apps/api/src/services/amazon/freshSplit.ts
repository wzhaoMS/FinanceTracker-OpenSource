import type { Database } from 'better-sqlite3';
import { digest, minor } from './policy.js';
import { largestRemainder } from './allocation.js';
import { readFreshOrders } from './freshAdapter.js';
import { countFreshLines, freshCardCategory, type FreshCardCategorySource } from './freshItems.js';
import { freshLineDecisions, freshLineIdentities, lineTaxonomyLookup } from './lineTaxonomy.js';
import { readTaxonomyAssignments } from './taxonomy.js';
import { orderTip, tipsDescriptor } from './tipSplit.js';
import type { Contribution, LedgerRow, MatchSubject, Resolution } from './types.js';

/**
 * Amazon Fresh split policy (Root's GO 2026-11-22; Alex: a Fresh charge counts as itemized, split by its Item List lines).
 * A Fresh order has no order items, so a card charge linked to it was filed whole (`item-identity-unproven`). It is now
 * split over its active Item List's lines when that list is the Fresh tab's own proven, reconciled list:
 * - only a linked, posted purchase whose resolution is whole for `item-identity-unproven`, linked through exactly one
 *   order: the order's total (`order-total`), a tipped order's order part (`order-total-split`, the total minus the tip),
 *   or an Amazon payments-ledger `Charged` row (`payment-ledger-complete`). An order with order items that reconcile is
 *   allocated by them as before; nothing here applies to it.
 * - the list: complete and reconciled exactly as the Fresh tab proves it (countFreshOrder: every row read, any stated
 *   count matched, every stored line readable, every delivered line priced, and the delivered lines adding up to the
 *   order's own item subtotal), with 1 to 199 delivered, priced lines, all in the charge's currency.
 * - the tip is never a line's cost: a tips-descriptor charge, or a ledger charge of exactly the order's tip, stays whole,
 *   and so does an order-total link of a tipped order (its total would hold the tip). A tipped order's order part is the
 *   charge less its tip already.
 * - the charge goes to the delivered, priced lines by their list price (largest remainder, ties by each line's stable
 *   Fresh line identity), every part `policy-allocated`: tax, fees and discounts shared by price, as Amazon's payments
 *   ledger allocates a charge. A line marked missing costs nothing.
 * - each part's category is the Fresh tab's (freshCardCategory: the owner's line decision, else the owner's, else an
 *   agent's item category, as its card category; Groceries' as the visible default while nothing classifies it), when it
 *   is one of the household's categories; else that part stays in the rest of the charge, under the card's own category.
 * Refund credits keep mirroring their order's charges as before: a Fresh split never feeds them.
 */
export const FRESH_SPLIT_POLICY = Object.freeze({
  name: 'amazon-fresh-split', version: 1,
  applies: 'linked posted purchase, whole for item-identity-unproven, of one order: order-total, order-total-split order part, ledger Charged',
  list: 'countFreshOrder complete and reconciled; 1-199 delivered priced lines; the charge currency',
  tip: 'never a line cost: a tips descriptor or a ledger charge equal to the tip stays whole; a tipped order-total link stays whole',
  allocation: 'largest remainder of the charge by list price over delivered priced lines; ties by Fresh line identity; policy-allocated',
  category: 'freshCardCategory when a household category, else the residual under the card category',
});
export const FRESH_SPLIT_POLICY_DIGEST = digest(FRESH_SPLIT_POLICY);

/** One delivered, priced line as the split weighs and files it. */
export interface FreshSplitLine {
  ref: string;
  /** Its stable Fresh line identity: the tie key. */
  tie: string;
  /** Its list price, in minor units. */
  weight: number;
  category: string;
  categorySource: FreshCardCategorySource;
  title: string;
  asin: string | null;
  quantity: number | null;
}
/** A Fresh order whose active list the split may use: proven complete and reconciled, its lines in one currency. */
export interface FreshSplitOrder {
  ref: string;
  currency: string;
  /** The order's positive driver tip (0: none). */
  tip: number;
  lines: FreshSplitLine[];
}

/** Every Fresh order the split may use, by order ref: read-only, and empty without the Fresh tables. */
export function readFreshSplitOrders(db: Database): Map<string, FreshSplitOrder> {
  const reads = readFreshOrders(db, 'all');
  const orders = new Map<string, FreshSplitOrder>();
  if (!reads.length) return orders;
  const assignments = readTaxonomyAssignments(db), decisions = lineTaxonomyLookup(db, 'fresh');
  for (const read of reads) {
    const counted = countFreshLines(read, undefined, assignments, freshLineDecisions(decisions, read.orderId, read.lines));
    if (!counted.complete || !counted.reconciled || counted.noPrice || !counted.lines.length || counted.lines.length > 199) continue;
    const currency = counted.lines[0].currency;
    if (counted.lines.some((line) => line.currency !== currency)) continue;
    const ordinals = new Map(read.lines.map((line) => [line.ref, line.lineOrdinal]));
    const identities = freshLineIdentities(read.orderId, read.lines);
    orders.set(read.ref, { ref: read.ref, currency, tip: orderTip(read.order), lines: counted.lines.map((line) => ({
      ref: line.ref, tie: identities.get(ordinals.get(line.ref)!)!, weight: Number(line.amountMinor), ...freshCardCategory(line),
      title: line.title, asin: line.asin, quantity: line.shown.quantity })) });
  }
  return orders;
}

/**
 * The split of a linked charge over its Fresh order's Item List lines (FRESH_SPLIT_POLICY), or null when the policy
 * doesn't apply and the charge's own resolution stands.
 */
export function freshSplit(row: LedgerRow, subject: MatchSubject, resolution: Resolution,
  orders: ReadonlyMap<string, FreshSplitOrder>, categories: ReadonlySet<string>): Extract<Resolution, { kind: 'split' }> | null {
  if (resolution.kind !== 'whole-row' || resolution.reason !== 'item-identity-unproven') return null;
  if (row.status !== 'posted' || row.kind !== 'purchase' || !minor(row.amountMinor) || row.amountMinor <= 0) return null;
  if (subject.money.amountMinor !== row.amountMinor || subject.money.currency !== row.currency
    || subject.orderRefs.length !== 1 || subject.allocations.length) return null;
  const single = subject.tenderProof === 'single-card-complete';
  const link = subject.provenance === 'order-total' && single && !subject.split ? 'order-total'
    : subject.provenance === 'order-total-split' && single && subject.split?.part === 'order' ? 'order-part'
      : subject.provenance === 'ledger-Charged' && subject.evidenceClass === 'payment-ledger-complete'
        && subject.status === 'completed' ? 'ledger' : null;
  const order = link && orders.get(subject.orderRefs[0]);
  if (!order || order.currency !== row.currency || tipsDescriptor(row.description)) return null;
  if (order.tip > 0 && (link === 'order-total' || (link === 'ledger' && row.amountMinor === order.tip))) return null;
  const weights = order.lines.filter((line) => line.weight > 0);
  if (!weights.length) return null;
  const shares = largestRemainder(row.amountMinor, weights.map(({ ref, weight, tie }) => ({ ref, weight, tie })));
  const contributions: Contribution[] = [];
  let categorized = 0;
  for (const line of weights) {
    const amountMinor = shares.get(line.ref)!;
    if (!amountMinor || !categories.has(line.category)) continue;
    categorized += amountMinor;
    contributions.push({ itemRef: line.ref, amountMinor, category: line.category, categorySource: line.categorySource,
      classification: 'policy-allocated' });
  }
  if (!contributions.length) return null;
  const residual = row.amountMinor - categorized;
  if (residual) contributions.push({ amountMinor: residual, category: null, categorySource: null, classification: 'residual' });
  return { kind: 'split', cardTransactionId: row.id, currency: row.currency, evidenceClass: subject.evidenceClass, contributions };
}
