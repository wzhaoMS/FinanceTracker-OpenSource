import type { Database } from 'better-sqlite3';
import { AMAZON_TAXONOMY_GROCERIES, AMAZON_TAXONOMY_NEEDS_REVIEW, amazonTaxonomyNode } from '@finance-tracker/shared';
import {
  countFreshOrder,
  freshLineCategory,
  freshLineUnits,
  freshWeightTotal,
  pricedLine,
  type FreshLineCategory,
  type FreshOrderCount,
} from './fresh.js';
import { readFreshOrders, type FreshLineRead, type FreshLineRecord, type FreshOrderRead } from './freshAdapter.js';
import type { LineTaxonomyDecision } from './lineTaxonomy.js';
import { refuse } from './policy.js';
import type { OrderRefundEvidenceRead } from './refundEvidence.js';
import type { ResolvedTaxonomy, TaxonomyAssignment } from './taxonomy.js';

/**
 * Amazon Fresh lines in the Amazon item views: GET /amazon/spending (by card category, spending.ts) and GET
 * /amazon/spending/taxonomy (by item category, taxonomySpending.ts). One category truth with the Fresh tab (GET
 * /amazon/fresh, fresh.ts): every line, price, category and refund here is fresh.ts's own (countFreshOrder,
 * freshLineCategory), never recomputed.
 *
 * A Fresh order is one with an active Item List (freshAdapter.ts). It counts by that list only, never also by an order
 * item it might have, so no order counts twice. Each delivered, priced line costs what its list shows it at; a line
 * marked missing wasn't delivered and costs nothing; a stored line that can't be read is counted apart, never guessed.
 * Refunds are the Fresh tab's: the same evidence and rules, tied to lines only when the evidence proves which, the rest
 * taken off the order's lines' total, never more than they still cost. Fresh lines are never order items (amazon_items)
 * and are never stored as card spending: they count in these read-only views and on the Fresh tab, and the Amazon Fresh
 * split policy (freshSplit.ts) splits a linked card charge of a Fresh order over its proven list's lines by the same
 * card categories (freshCardCategory), in the resolver, read-only.
 * Reads only: without the Fresh import's tables there is no Fresh order, and nothing here creates or writes anything.
 */

/** What a Fresh line's Item List showed of it beside its price: delivered as listed, or as a substitute. */
export interface FreshLineShown {
  status: 'listed' | 'substituted';
  quantity: FreshLineRecord['quantity'];
  weight: FreshLineRecord['weight'];
  unitPrice: FreshLineRecord['unitPrice'];
}
/** One delivered, priced Fresh line, exactly as the Fresh tab counts it. */
export interface FreshCountedLine {
  ref: string;
  title: string;
  asin: string | null;
  currency: string;
  /** Its list's price, and what the refunds tied to it took off (at most that). */
  amountMinor: bigint;
  refundMinor: bigint;
  /** Its price as order-item units (freshLineUnits): quantity × unitPriceMinor is the list's price. */
  quantity: number;
  unitPriceMinor: number;
  /** Where the item taxonomy files its product (the Fresh tab's own). */
  category: FreshLineCategory;
  shown: FreshLineShown;
}
export interface FreshCountedOrder extends FreshOrderCount {
  read: FreshOrderRead;
  /** Its delivered, priced lines, by position. */
  lines: FreshCountedLine[];
  /** Readable lines delivered without a price (the Item List contract admits none), and lines marked missing. */
  noPrice: number;
  missing: number;
}
/** A Fresh product's lines together, as the Fresh tab shows a product: the quantities they show, their weights exactly. */
export interface FreshMeasure {
  quantity: number | null;
  weight: { value: string; unit: 'lb'; estimated: boolean } | null;
}
/**
 * The `fresh` part of an Amazon item view, present only when its window holds a Fresh order: those orders, their lines,
 * and per currency what of the view's totals their lines are. Each figure is GET /amazon/fresh's for the same window.
 */
export interface AmazonFreshPart {
  orders: number;
  /** Priced lines count in the view's figures; lines not delivered and stored lines that can't be read never do. */
  lines: { priced: number; missing: number; unreadable: number };
  totals: Array<{ currency: string; lineMinor: number; refundMinor: number; lineRefundMinor: number; unattributedRefundMinor: number;
    netLineMinor: number }>;
}

/** The window's Fresh orders (Amazon's order dates, inclusive) by order ref; none without the Fresh tables. */
export function readFreshWindow(db: Database, from: string, to: string): ReadonlyMap<string, FreshOrderRead> {
  return new Map(readFreshOrders(db, { from, to }).map((read) => [read.ref, read]));
}

/**
 * One Fresh order's lines as the Fresh tab counts them (countFreshOrder), with its proof and its counted refund. `decision`
 * is a line's owner line decision (keyless holds, lineTaxonomy.ts freshLineDecisions), which files it as the Fresh tab
 * files it: its item category, and so its card category (freshCardCategory), in both Amazon item views.
 */
export function countFreshLines(read: FreshOrderRead, evidence: OrderRefundEvidenceRead | undefined,
  assignments: ReadonlyMap<string, TaxonomyAssignment>,
  decision?: (line: FreshLineRead) => LineTaxonomyDecision | undefined): FreshCountedOrder {
  const count = countFreshOrder(read, evidence);
  const lines: FreshCountedLine[] = [];
  let noPrice = 0, missing = 0;
  for (const line of read.lines) {
    if (line.status === 'missing') { missing++; continue; }
    if (!pricedLine(line)) { noPrice++; continue; }
    const { quantity, unitPriceMinor } = freshLineUnits(line);
    lines.push({ ref: line.ref, title: line.title, asin: line.asin, currency: line.linePrice.currency,
      amountMinor: BigInt(line.linePrice.amountMinor), refundMinor: count.byLine.get(line.lineOrdinal) ?? 0n, quantity, unitPriceMinor,
      category: freshLineCategory(line, assignments, decision?.(line)),
      shown: { status: line.status as FreshLineShown['status'], quantity: line.quantity, weight: line.weight, unitPrice: line.unitPrice } });
  }
  return { ...count, read, lines, noPrice, missing };
}

/** A Fresh line's taxonomy resolution, as an ordinary item's (taxonomy.ts resolveTaxonomy) reads. */
export const freshResolved = ({ node, source, confidence, suggested, suggestion }: FreshLineCategory): ResolvedTaxonomy =>
  ({ node, source, confidence, suggested, suggestion });

/** Who gave a Fresh line its card category: its item category's, or the default while it has none. */
export type FreshCardCategorySource = 'item-taxonomy' | 'fresh-default';
/** Groceries' card category: what a Fresh line nobody classified counts under, said as a default. */
export const FRESH_DEFAULT_CARD_CATEGORY = amazonTaxonomyNode(AMAZON_TAXONOMY_GROCERIES)!.cardCategory;
/**
 * A Fresh line's card category (Root's rule): the card category its item-taxonomy node corresponds to, where the owner's
 * assignment always wins over an agent's (taxonomy.ts resolveTaxonomy) and an owner's decision for the line itself
 * (keyless holds) over both; else, not classified (Needs review), Groceries', as a visible default. A title the
 * card-data guard holds is never classified by a product's assignment, so it shows the default unless the owner decided
 * the line itself. An item override (amazon_item_overrides) names an order item only (its table references
 * amazon_items), so none applies to a Fresh line.
 */
export function freshCardCategory(line: Pick<FreshCountedLine, 'category'>): { category: string; categorySource: FreshCardCategorySource } {
  return line.category.node === AMAZON_TAXONOMY_NEEDS_REVIEW
    ? { category: FRESH_DEFAULT_CARD_CATEGORY, categorySource: 'fresh-default' }
    : { category: amazonTaxonomyNode(line.category.node)!.cardCategory, categorySource: 'item-taxonomy' };
}

/** A product's Fresh lines, added as they come: the quantities they show, and their weights. */
export interface FreshMeasureSums { quantity: number | null; weights: string[]; estimated: boolean }
export const freshMeasureSums = (): FreshMeasureSums => ({ quantity: null, weights: [], estimated: false });
export function addFreshMeasure(sums: FreshMeasureSums, shown: FreshLineShown): void {
  if (shown.quantity !== null) sums.quantity = (sums.quantity ?? 0) + shown.quantity;
  if (shown.weight !== null) {
    sums.weights.push(shown.weight.value);
    sums.estimated ||= shown.weight.basis === 'estimated';
  }
}
export const freshMeasure = (sums: FreshMeasureSums): FreshMeasure => ({ quantity: sums.quantity,
  weight: sums.weights.length ? { value: freshWeightTotal(sums.weights), unit: 'lb', estimated: sums.estimated } : null });

const safe = (value: bigint): number => (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= 0n ? Number(value) : refuse());
/** The `fresh` part of a view, added order by order; undefined when the window held no Fresh order. */
export function freshPart() {
  let orders = 0, priced = 0, missing = 0, unreadable = 0;
  const totals = new Map<string, { lines: bigint; refund: bigint; lineRefund: bigint; unattributed: bigint }>();
  const totalsIn = (currency: string) => {
    const entry = totals.get(currency) ?? { lines: 0n, refund: 0n, lineRefund: 0n, unattributed: 0n };
    totals.set(currency, entry);
    return entry;
  };
  return {
    add(order: FreshCountedOrder): void {
      orders++;
      priced += order.lines.length;
      missing += order.missing;
      unreadable += order.read.unreadable;
      for (const line of order.lines) {
        const sums = totalsIn(line.currency);
        sums.lines += line.amountMinor;
        sums.lineRefund += line.refundMinor;
      }
      if (order.refund) {
        const sums = totalsIn(order.refund.currency);
        sums.refund += BigInt(order.refund.refundMinor);
        sums.unattributed += BigInt(order.refund.unattributedMinor);
      }
    },
    view(): AmazonFreshPart | undefined {
      if (orders === 0) return undefined;
      return { orders, lines: { priced, missing, unreadable },
        totals: [...totals].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([currency, sums]) => ({ currency,
          lineMinor: safe(sums.lines), refundMinor: safe(sums.refund), lineRefundMinor: safe(sums.lineRefund),
          unattributedRefundMinor: safe(sums.unattributed), netLineMinor: safe(sums.lines - sums.lineRefund - sums.unattributed) })) };
    },
  };
}
