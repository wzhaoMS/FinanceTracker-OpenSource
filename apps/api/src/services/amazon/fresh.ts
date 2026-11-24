import type { Database } from 'better-sqlite3';
import {
  AMAZON_ITEM_TAXONOMY_VERSION,
  AMAZON_TAXONOMY_GROCERIES,
  AMAZON_TAXONOMY_NEEDS_REVIEW,
  amazonSpendingWindowRange,
  amazonTaxonomyTop,
  type AmazonSpendingWindow,
  type AmazonTaxonomyNodeId,
} from '@finance-tracker/shared';
import {
  freshListsCaptured,
  readFreshOrders,
  type FreshLineRead,
  type FreshLineRecord,
  type FreshLineStatus,
  type FreshOrderRead,
} from './freshAdapter.js';
import { productKey, publicTitle } from './products.js';
import { orderChannels, type PurchaseChannel } from './orderChannels.js';
import { attributeOrderRefunds, type OrderRefundAttribution, type RefundBasis } from './refundAttribution.js';
import { composeOrderRefunds, type OrderRefundComposition } from './refundEventNetting.js';
import { readRefundEvidence, type OrderRefundEvidenceRead } from './refundEvidence.js';
import {
  AMAZON_TAXONOMY_DIGEST,
  classifiableProductKey,
  hasAmazonTaxonomySchema,
  readTaxonomyAssignments,
  resolveTaxonomy,
  type ResolvedTaxonomy,
  type TaxonomyAssignment,
} from './taxonomy.js';
import { currency as isCurrency, minor, refuse } from './policy.js';
// Keyless holds (Root, after STEP 9): an owner line decision files its line, by the line's stable identity.
import { freshLineIdentities, lineAssignment, lineTaxonomyLookup, type LineTaxonomyDecision } from './lineTaxonomy.js';
import type { ItemObservation, Money, OrderObservation } from './types.js';

/**
 * Amazon Fresh (GET /amazon/fresh): what the household's Fresh orders' lines cost over a window, by Amazon's order
 * date, broken down by grocery subcategory (pork in Meat & Seafood, eggs in Dairy & Eggs, chips in Snacks & Sweets),
 * with refunds taken off. Amazon's own measure, like Amazon spending: never card spending, never added to it.
 *
 * A Fresh order is one whose Fresh Item List was imported (freshAdapter.ts): each counts once, with its active list.
 // STEP 9 integration (B6)
 * While its displayed decision is a charge-free proof (#158), it counts with none of that list's lines and shows the
 * proof (`chargeFree`).
 * Without the Fresh import's tables none was, and the view says so (`captured: false`) instead of failing. A line
 * costs what its list shows it at (`linePrice`): a weighed line's price is its weight's, never recomputed. A line marked
 * missing wasn't delivered and costs nothing; a line without a price is counted apart. Where a line counts is the item
 * taxonomy's resolution of its product (taxonomy.ts, exactly as an ordinary item's): each Groceries subcategory,
 * Groceries itself ("other groceries"), every other top level as a whole (Household Supplies, …), and Needs review for
 * what isn't classified, or until no classification was ever imported. Refunds are Amazon spending's (#153): the same
 * evidence and rules (refundAttribution.ts, with order-details and Returns-page refund statements composed by
 * refundEventNetting.ts), each order's counted once, tied to lines only when the evidence proves
 * which, the rest taken off the total, never more than the order's lines still cost. Nothing is defaulted, derived or
 * guessed, and every amount is per currency, never converted. Reads only: nothing here writes or creates anything.
 */
export const AMAZON_FRESH_MEASURE = 'amazon-fresh-item-prices-not-card-spending';
/** At most this many products and orders are listed, largest products and newest orders first; totals count them all. */
export const MAX_FRESH_PRODUCTS = 1000;
export const MAX_FRESH_ORDERS = 500;
/** Each listed product's purchases, latest first; its `lines` still counts them all. */
export const MAX_FRESH_PURCHASES = 50;

/**
 * Where a line counts: Groceries' subcategories one by one (and Groceries itself: other groceries), every other top
 * level as a whole (Household Supplies, …), and Needs review.
 */
export type FreshCategoryGroup = 'groceries' | 'other' | 'needs-review';
export interface FreshLineCategory {
  /** The breakdown row it counts in: a Groceries subcategory, `groceries` itself, another top level, or Needs review. */
  category: AmazonTaxonomyNodeId;
  group: FreshCategoryGroup;
  /** Where the taxonomy files its product: `category`, or below it for another top level; Needs review if unclassified. */
  node: AmazonTaxonomyNodeId;
  /** Who filed it there (the owner's choice always wins); null in Needs review for want of a usable assignment. */
  source: ResolvedTaxonomy['source'];
  confidence: number | null;
  /** An agent's assignment that counts, below the taxonomy's confident threshold: shown as suggested. */
  suggested: boolean;
  /** In Needs review: an agent's node that wasn't confident enough to count, else null. */
  suggestion: ResolvedTaxonomy['suggestion'];
}
export interface AmazonFreshTotals {
  currency: string;
  /** Amazon's order totals: delivery, tips, tax and promotions included. */
  orderTotalMinor: number;
  /** Every priced, delivered line's price, before refunds. */
  lineMinor: number;
  /** Of them, the lines filed under Groceries. */
  groceryMinor: number;
  /** Of them, the lines classified (not in Needs review), and of those, the ones only suggested. */
  categorizedMinor: number;
  suggestedMinor: number;
  /** lineMinor − categorizedMinor: the lines in Needs review. */
  needsReviewMinor: number;
  /** The refund money counted for these orders, tax and delivery included, each order's once (#153's rules). */
  refundMinor: number;
  /** Line prices refunds took off the lines they are tied to. */
  lineRefundMinor: number;
  /** Refunds tied to no line: off the total only, never more than the order's lines still cost. */
  unattributedRefundMinor: number;
  /** What the lines cost after refunds: lineMinor − lineRefundMinor − unattributedRefundMinor. */
  netLineMinor: number;
}
export interface AmazonFreshCategory {
  currency: string;
  category: AmazonTaxonomyNodeId;
  group: FreshCategoryGroup;
  /** Before refunds; what refunds tied to its lines took off; what they cost after them. */
  amountMinor: number;
  refundMinor: number;
  netMinor: number;
  lines: number;
  /** Of them, the lines a refund is tied to. */
  refundedLines: number;
  products: number;
  orders: number;
}
/** One priced line of a product, as its order's list showed it. */
export interface AmazonFreshPurchase {
  /** The line's opaque ref. */
  ref: string;
  orderRef: string;
  orderDate: string;
  /** `listed`, or `substituted` (delivered in place of another item). A missing line costs nothing and isn't listed. */
  status: Exclude<FreshLineStatus, 'missing'>;
  quantity: number | null;
  weight: FreshLineRecord['weight'];
  unitPrice: FreshLineRecord['unitPrice'];
  /** The line's price, as its list showed it, before refunds. */
  amountMinor: number;
  /** Taken off it by the refunds tied to it, at most its price. */
  refundMinor: number;
}
/** One thing bought on Fresh: its priced lines in one currency, by product (the same ASIN and title). */
export interface AmazonFreshProduct extends FreshLineCategory {
  /** Its latest line's ref. */
  ref: string;
  currency: string;
  /** Its latest public title; `[redacted]` when the card-data guard hid every one. */
  title: string;
  asin: string | null;
  amountMinor: number;
  refundMinor: number;
  netMinor: number;
  lines: number;
  orders: number;
  /** The sum of the quantities its lines show; null when none shows one. */
  quantity: number | null;
  /** The sum of the weights its lines show, exactly, in pounds; `estimated` when any of them is an estimate. */
  weight: { value: string; unit: 'lb'; estimated: boolean } | null;
  /** The latest line's own unit price, as its list showed it. */
  lastUnitPrice: FreshLineRecord['unitPrice'];
  lastOrderDate: string;
  lastOrderRef: string;
  /** Latest first, at most MAX_FRESH_PURCHASES. */
  purchases: AmazonFreshPurchase[];
}
/** An order's counted refund: how much, the rule that tied it, and what it took off the order's lines. */
export interface FreshOrderRefund {
  currency: string;
  refundMinor: number;
  basis: RefundBasis;
  /** Taken off the lines it is tied to. */
  lineRefundMinor: number;
  /** Tied to no line: taken off the order's lines' total, at most what they still cost. */
  unattributedMinor: number;
}
/**
 * STEP 9 integration B6 (#158 x #157/#169): the order's displayed charge-free proof. An answer has it only while that is
 * the order's displayed decision; its retained list then counts nothing.
 */
export type FreshChargeFree = NonNullable<OrderObservation['chargeFree']>;
export interface AmazonFreshOrderSummary {
  ref: string;
  date: string;
  total: Money | null;
  /** Its active list's readable lines; of them, priced (delivered), missing and substituted. */
  lines: number;
  priced: number;
  missing: number;
  substituted: number;
  /** Stored lines that can't be read. */
  unreadable: number;
  /** Rows Amazon's page showed that the capture couldn't read (never stored); null when the list can't be read. */
  unreadRows: number | null;
  /** Its priced lines' prices, when they share one currency; else null. */
  lineTotal: Money | null;
  /** The list's own proof holds: every row read and stored, any stated count matched, every delivered line priced. */
  complete: boolean;
  /** Complete, and its delivered lines add up to the order's own item subtotal. */
  reconciled: boolean;
  refund: FreshOrderRefund | null;
  // STEP 9 integration (B6)
  /** Only while the order's displayed decision is a charge-free proof (#158): then it has no line. */
  chargeFree?: FreshChargeFree;
  /** Only when the list is not an Amazon Fresh delivery (orderChannels.ts): a Whole Foods in-store receipt. */
  purchaseChannel?: PurchaseChannel;
}
export interface AmazonFreshView {
  measure: typeof AMAZON_FRESH_MEASURE;
  window: { key: AmazonSpendingWindow; from: string; to: string };
  /** Whether any Fresh Item List was ever imported (the Fresh import's tables exist). */
  captured: boolean;
  /** `assignments`: whether any taxonomy classification was ever imported; until then every line is in Needs review. */
  taxonomy: { version: typeof AMAZON_ITEM_TAXONOMY_VERSION; digest: string; assignments: 'present' | 'absent' };
  /** `refunded`: with a counted refund; `unreadable`: its list record can't be read; `noLines`: no readable line. */
  orders: { count: number; withTotal: number; complete: number; reconciled: number; refunded: number; unreadable: number; noLines: number };
  /** Readable lines (`count` = priced + noPrice + missing) and, apart, the stored lines that can't be read. */
  lines: {
    count: number; priced: number; noPrice: number; missing: number; substituted: number; estimated: number;
    categorized: number; suggested: number; needsReview: number; refunded: number; unreadable: number;
  };
  totals: AmazonFreshTotals[];
  categories: AmazonFreshCategory[];
  /** Largest net first, at most MAX_FRESH_PRODUCTS. */
  products: AmazonFreshProduct[];
  /** Newest first, at most MAX_FRESH_ORDERS. */
  orderList: AmazonFreshOrderSummary[];
}
export interface AmazonFreshLineView extends FreshLineRecord, FreshLineCategory {
  ref: string;
  /** The refund tied to this line, at most its price. */
  refundMinor: number;
}
export interface AmazonFreshOrderView {
  ref: string;
  date: string;
  total: Money | null;
  refund: FreshOrderRefund | null;
  /** The list's own counts (null when its record can't be read) and proof, recomputed here. */
  list: { statedCount: number | null; rows: number | null; unreadRows: number | null; lines: number; unreadable: number;
    complete: boolean; reconciled: boolean };
  /** Every readable line, by position, as the list showed it. */
  lines: AmazonFreshLineView[];
  // STEP 9 integration (B6)
  /** Only while the order's displayed decision is a charge-free proof (#158): then it has no line. */
  chargeFree?: FreshChargeFree;
  /** Only when the list is not an Amazon Fresh delivery (orderChannels.ts): a Whole Foods in-store receipt. */
  purchaseChannel?: PurchaseChannel;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const safe = (value: bigint): number => (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
  ? Number(value) : refuse());
const isMoney = (money: Money | null | undefined): money is Money => !!money && isCurrency(money.currency)
  && minor(money.amountMinor) && money.amountMinor >= 0;
const orderTotal = (order: OrderObservation): Money | null => (isMoney(order.total) ? order.total : null);
/** STEP 9 integration B6 (#158 x #157/#169): the order's displayed charge-free proof, only when there is one. */
const proofState = ({ chargeFree }: OrderObservation): { chargeFree?: FreshChargeFree } => (chargeFree
  ? { chargeFree: { status: chargeFree.status, shipments: chargeFree.shipments } } : {});
/** The order's purchase channel, only when it has one (absent: an Amazon Fresh delivery). */
const channelOf = (channels: ReadonlyMap<string, PurchaseChannel>, ref: string): { purchaseChannel?: PurchaseChannel } => {
  const channel = channels.get(ref);
  return channel ? { purchaseChannel: channel } : {};
};
const GROUP_ORDER: readonly FreshCategoryGroup[] = ['groceries', 'other', 'needs-review'];

/** Exact decimal pounds as millionths, so weights add without float error. */
const MICRO = 1000000n;
function micro(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, '0'));
}
function decimal(value: bigint): string {
  const whole = value / MICRO, fraction = (value % MICRO).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}
/** Weights as their lists showed them (decimal pounds), added exactly, as a product's weight is here. */
export const freshWeightTotal = (values: readonly string[]): string => decimal(values.reduce((sum, value) => sum + micro(value), 0n));

/**
 * Where a line counts: the taxonomy's resolution of its product's assignment, exactly as an ordinary item's. A title the
 * card-data guard holds is never classified, even by a stored assignment. An owner's decision for the line itself
 * (`decision`, by its stable line identity: keyless holds, Root, after STEP 9) always wins, whatever its title.
 */
export function freshLineCategory(line: Pick<FreshLineRecord, 'title' | 'asin'>,
  assignments: ReadonlyMap<string, TaxonomyAssignment>, decision?: LineTaxonomyDecision): FreshLineCategory {
  const key = classifiableProductKey({ itemId: line.asin, title: line.title });
  const resolved = resolveTaxonomy(decision ? lineAssignment(decision) : key === null ? undefined : assignments.get(key));
  const top = amazonTaxonomyTop(resolved.node);
  const group: FreshCategoryGroup = resolved.node === AMAZON_TAXONOMY_NEEDS_REVIEW ? 'needs-review'
    : top === AMAZON_TAXONOMY_GROCERIES ? 'groceries' : 'other';
  return { category: group === 'other' ? top : resolved.node, group, node: resolved.node, source: resolved.source,
    confidence: resolved.confidence, suggested: resolved.suggested, suggestion: resolved.suggestion };
}

/** A Fresh order's lines that cost money: delivered (not missing) and priced. */
export const pricedLine = <T extends FreshLineRecord>(line: T): line is T & { linePrice: Money } => line.status !== 'missing'
  && line.linePrice !== null;
/**
 * A priced line as units of an order item, for its refunds and wherever an order item's shape carries it: sold by the
 * each, its quantity at its exact share of the price, when it shows no weight and its price divides exactly; any other
 * line (a weighed one) one unit at its own price. Units times unit price is always the line's price.
 */
export function freshLineUnits(line: FreshLineRecord & { linePrice: Money }): { quantity: number; unitPriceMinor: number } {
  const each = line.weight === null && line.quantity !== null && line.quantity > 1 && line.linePrice.amountMinor % line.quantity === 0;
  return each ? { quantity: line.quantity!, unitPriceMinor: line.linePrice.amountMinor / line.quantity! }
    : { quantity: 1, unitPriceMinor: line.linePrice.amountMinor };
}
/**
 * The list's own proof (every page row read, any stated count matched, every stored line readable, every delivered line
 * priced), and whether its delivered lines add up to the order's own item subtotal: recomputed here, never trusted.
 */
function proof(read: FreshOrderRead): { complete: boolean; reconciled: boolean } {
  const delivered = read.lines.filter((line) => line.status !== 'missing');
  const complete = read.list !== null && read.list.proof.complete && read.unreadable === 0
    && read.lines.length === read.list.lines && delivered.every(pricedLine);
  if (!complete) return { complete, reconciled: false };
  const subtotals = (read.order.summary ?? []).filter((entry) => entry.kind === 'items-subtotal');
  const subtotal = subtotals.length === 1 && isMoney(subtotals[0].money) ? subtotals[0].money : null;
  const sum = delivered.reduce((n, line) => n + BigInt(line.linePrice!.amountMinor), 0n);
  const reconciled = subtotal !== null && delivered.length > 0
    && delivered.every((line) => line.linePrice!.currency === subtotal.currency) && sum === BigInt(subtotal.amountMinor);
  return { complete, reconciled };
}

/**
 * An order's refunds by Amazon spending's own rules (attributeOrderRefunds over its refund evidence, with its page
 * refund statements composed by refundEventNetting.ts), with the Fresh list's priced lines as the order's items: a line
 * sold by the each by its quantity when its price divides exactly, any other line (a weighed one) one unit at its own
 * price. Units are tied to a line only when the evidence proves which, and only a list that reconciles proves its lines
 * are the order's items. A whole-order refund (the order's grand total) takes every priced line in its currency at its
 * price: a Fresh list may hold up to 200 lines, more than the 100 item ordinals the shared rule names. Only one that
 * page statements composed below what the lines cost keeps its own per-line cents. A missing line is never priced, so
 * never refunded. A line's refund never exceeds its price.
 */
function freshRefunds(read: FreshOrderRead, reconciled: boolean, evidence: OrderRefundEvidenceRead | undefined):
  { composition: OrderRefundComposition; byLine: Map<number, bigint> } {
  const priced = read.lines.filter(pricedLine);
  const items: ItemObservation[] = priced.map((line, lineOrdinal) => {
    const { quantity, unitPriceMinor } = freshLineUnits(line);
    return { lineOrdinal, itemId: line.asin, title: line.title, quantity,
      unitPrice: { currency: line.linePrice.currency, amountMinor: unitPriceMinor } };
  });
  const order: OrderObservation = { ...read.order, items,
    itemProof: { complete: reconciled && items.length <= 100, unknownLine: false, conflict: false } };
  // STEP 9 integration (#166 × #169): page refund statements count here exactly as in spending.ts, mapped by ASIN or
  // exact title to the Fresh list's lines. Without an issued statement this is v1's own attribution, unchanged.
  const base = attributeOrderRefunds(order, evidence ?? { summaries: [], ledger: [] });
  const composition = composeOrderRefunds(order, base, evidence?.pageRefunds ?? []);
  const { attribution } = composition;
  const byLine = new Map<number, bigint>();
  const prices = priced.reduce((n, line) => (line.linePrice.currency === attribution.currency
    ? n + BigInt(line.linePrice.amountMinor) : n), 0n);
  // v1's own whole-order refund, or one paying back every line's price, takes every priced line at its price. One that
  // page statements composed below what the lines cost (after a promotion) keeps its exact cents per line, as
  // spending.ts takes them.
  if (attribution.basis === 'whole-order' && (attribution === base || BigInt(attribution.refundMinor) >= prices)) {
    for (const line of priced) {
      if (line.linePrice.currency === attribution.currency) byLine.set(line.lineOrdinal, BigInt(line.linePrice.amountMinor));
    }
    return { composition, byLine };
  }
  for (const tie of attribution.lines) {
    const item = items[tie.lineOrdinal], line = priced[tie.lineOrdinal];
    if (!item || !line || line.linePrice.currency !== attribution.currency) continue;
    let refunded = BigInt(Math.min(tie.units, item.quantity!)) * BigInt(item.unitPrice!.amountMinor) + BigInt(tie.moneyMinor);
    if (refunded > BigInt(line.linePrice.amountMinor)) refunded = BigInt(line.linePrice.amountMinor);
    byLine.set(line.lineOrdinal, refunded);
  }
  return { composition, byLine };
}
/**
 * The order's counted refund, if any: what refunds tied to its lines took off, and the rest, tied to no line, taken off
 * its lines' total in the refund's currency, never more than they still cost.
 */
function orderRefund(read: FreshOrderRead, attribution: OrderRefundAttribution, byLine: ReadonlyMap<number, bigint>): FreshOrderRefund | null {
  if (attribution.refundMinor <= 0 || attribution.currency === null || attribution.basis === null || attribution.source === null) return null;
  let lines = 0n, tied = 0n;
  for (const line of read.lines.filter(pricedLine)) {
    if (line.linePrice.currency !== attribution.currency) continue;
    lines += BigInt(line.linePrice.amountMinor);
    tied += byLine.get(line.lineOrdinal) ?? 0n;
  }
  const room = lines - tied, unattributed = BigInt(attribution.unattributedMinor);
  return { currency: attribution.currency, refundMinor: attribution.refundMinor, basis: attribution.basis,
    lineRefundMinor: safe(tied), unattributedMinor: safe(unattributed < room ? unattributed : room > 0n ? room : 0n) };
}

/**
 * One Fresh order as every reader counts it: the Fresh tab, its Item List, and both Amazon item views (freshItems.ts).
 * Its list's own proof, each priced line's refund (by line ordinal), and its counted refund, with the refund attribution
 * and page-statement composition behind them for a view that says how refunds were tied.
 */
export interface FreshOrderCount {
  complete: boolean;
  reconciled: boolean;
  byLine: ReadonlyMap<number, bigint>;
  refund: FreshOrderRefund | null;
  composition: OrderRefundComposition;
}
export function countFreshOrder(read: FreshOrderRead, evidence: OrderRefundEvidenceRead | undefined): FreshOrderCount {
  const { complete, reconciled } = proof(read);
  const { composition, byLine } = freshRefunds(read, reconciled, evidence);
  return { complete, reconciled, byLine, refund: orderRefund(read, composition.attribution, byLine), composition };
}

const emptyView = (key: AmazonSpendingWindow, from: string, to: string): AmazonFreshView => ({
  measure: AMAZON_FRESH_MEASURE, window: { key, from, to }, captured: false,
  taxonomy: { version: AMAZON_ITEM_TAXONOMY_VERSION, digest: AMAZON_TAXONOMY_DIGEST, assignments: 'absent' },
  orders: { count: 0, withTotal: 0, complete: 0, reconciled: 0, refunded: 0, unreadable: 0, noLines: 0 },
  lines: { count: 0, priced: 0, noPrice: 0, missing: 0, substituted: 0, estimated: 0, categorized: 0, suggested: 0,
    needsReview: 0, refunded: 0, unreadable: 0 },
  totals: [], categories: [], products: [], orderList: [],
});

interface Seen { date: string; orderRef: string; ref: string }
/** Later first: by order date, then order ref, then line ref, so the latest line is the same on every read. */
const later = (a: Seen, b: Seen) => compare(b.date, a.date) || compare(b.orderRef, a.orderRef) || compare(b.ref, a.ref);

export function amazonFresh(db: Database, window: AmazonSpendingWindow, today: string): AmazonFreshView {
  const { from, to } = amazonSpendingWindowRange(window, today);
  const view = emptyView(window, from, to);
  view.taxonomy.assignments = hasAmazonTaxonomySchema(db) ? 'present' : 'absent';
  // Reads never migrate: with no Fresh list imported, the window is empty and says so.
  if (!freshListsCaptured(db)) return view;
  view.captured = true;
  return db.transaction(() => {
    // In the same read as the assignments themselves, so `absent` always means every line is in Needs review.
    view.taxonomy.assignments = hasAmazonTaxonomySchema(db) ? 'present' : 'absent';
    const reads = readFreshOrders(db, { from, to });
    const assignments = readTaxonomyAssignments(db);
    const lineDecisions = lineTaxonomyLookup(db, 'fresh');
    const evidence = readRefundEvidence(db, reads.map((read) => ({ ref: read.ref, orderId: read.orderId })));
    const channels = orderChannels(db);
    const totals = new Map<string, { order: bigint; lines: bigint; grocery: bigint; categorized: bigint; suggested: bigint;
      needsReview: bigint; refund: bigint; lineRefund: bigint; unattributed: bigint }>();
    const totalsIn = (code: string) => {
      const entry = totals.get(code) ?? { order: 0n, lines: 0n, grocery: 0n, categorized: 0n, suggested: 0n, needsReview: 0n,
        refund: 0n, lineRefund: 0n, unattributed: 0n };
      totals.set(code, entry);
      return entry;
    };
    const byCategory = new Map<string, { currency: string; category: AmazonTaxonomyNodeId; group: FreshCategoryGroup;
      amount: bigint; refund: bigint; lines: number; refundedLines: number; products: Set<string>; orders: Set<string> }>();
    const byProduct = new Map<string, { currency: string; asin: string | null; category: FreshLineCategory; amount: bigint;
      refund: bigint; orders: Set<string>; quantity: number | null; weight: bigint | null; estimated: boolean;
      purchases: Array<AmazonFreshPurchase & Seen>; latest: Seen & { unitPrice: FreshLineRecord['unitPrice'] };
      titled: (Seen & { title: string }) | null }>();

    for (const read of reads) {
      view.orders.count++;
      const total = orderTotal(read.order);
      if (total) {
        view.orders.withTotal++;
        totalsIn(total.currency).order += BigInt(total.amountMinor);
      }
      if (!read.list) view.orders.unreadable++;
      if (read.lines.length === 0) view.orders.noLines++;
      const { complete, reconciled, byLine, refund } = countFreshOrder(read, evidence.byOrder.get(read.orderId));
      if (complete) view.orders.complete++;
      if (reconciled) view.orders.reconciled++;
      view.lines.unreadable += read.unreadable;
      const summary: AmazonFreshOrderSummary = { ref: read.ref, date: read.order.date, total, lines: read.lines.length,
        priced: 0, missing: 0, substituted: 0, unreadable: read.unreadable, unreadRows: read.list?.proof.unreadRows ?? null,
        // STEP 9 integration (B6)
        lineTotal: null, complete, reconciled, refund, ...proofState(read.order), ...channelOf(channels, read.ref) };
      const orderSums = new Map<string, bigint>();
      const identities = lineDecisions.size ? freshLineIdentities(read.orderId, read.lines) : null;
      for (const line of read.lines) {
        view.lines.count++;
        if (line.status === 'substituted') { view.lines.substituted++; summary.substituted++; }
        if (line.status === 'missing') { view.lines.missing++; summary.missing++; continue; }
        if (!pricedLine(line)) { view.lines.noPrice++; continue; }
        view.lines.priced++;
        summary.priced++;
        const price = line.linePrice, amount = BigInt(price.amountMinor), refunded = byLine.get(line.lineOrdinal) ?? 0n;
        orderSums.set(price.currency, (orderSums.get(price.currency) ?? 0n) + amount);
        if (refunded > 0n) view.lines.refunded++;
        if (line.weight?.basis === 'estimated') view.lines.estimated++;
        const category = freshLineCategory(line, assignments, identities ? lineDecisions.get(identities.get(line.lineOrdinal)!, line.asin) : undefined);
        const sums = totalsIn(price.currency);
        sums.lines += amount;
        sums.lineRefund += refunded;
        if (category.group === 'groceries') sums.grocery += amount;
        if (category.group === 'needs-review') {
          sums.needsReview += amount;
          view.lines.needsReview++;
        } else {
          sums.categorized += amount;
          view.lines.categorized++;
          if (category.suggested) {
            sums.suggested += amount;
            view.lines.suggested++;
          }
        }
        const key = productKey({ asin: line.asin, title: line.title });
        // One product, as one classification: lines of a product group only when they resolve alike, which differs only
        // where the owner decided a line itself.
        const productId = JSON.stringify([price.currency, key, category.node, category.source, category.confidence,
          category.suggested, category.suggestion]);
        const categoryId = JSON.stringify([price.currency, category.category]);
        const bucket = byCategory.get(categoryId) ?? { currency: price.currency, category: category.category, group: category.group,
          amount: 0n, refund: 0n, lines: 0, refundedLines: 0, products: new Set<string>(), orders: new Set<string>() };
        bucket.amount += amount;
        bucket.refund += refunded;
        bucket.lines++;
        if (refunded > 0n) bucket.refundedLines++;
        bucket.products.add(productId);
        bucket.orders.add(read.ref);
        byCategory.set(categoryId, bucket);
        const seen: Seen = { date: read.order.date, orderRef: read.ref, ref: line.ref };
        const product = byProduct.get(productId) ?? { currency: price.currency, asin: line.asin, category, amount: 0n, refund: 0n,
          orders: new Set<string>(), quantity: null, weight: null, estimated: false, purchases: [],
          latest: { ...seen, unitPrice: line.unitPrice }, titled: null };
        product.amount += amount;
        product.refund += refunded;
        product.orders.add(read.ref);
        if (line.quantity !== null) product.quantity = (product.quantity ?? 0) + line.quantity;
        if (line.weight !== null) {
          product.weight = (product.weight ?? 0n) + micro(line.weight.value);
          product.estimated ||= line.weight.basis === 'estimated';
        }
        product.purchases.push({ ...seen, orderDate: read.order.date, status: line.status as AmazonFreshPurchase['status'],
          quantity: line.quantity, weight: line.weight, unitPrice: line.unitPrice, amountMinor: safe(amount), refundMinor: safe(refunded) });
        if (later(seen, product.latest) < 0) product.latest = { ...seen, unitPrice: line.unitPrice };
        // A title the guard hides never names the product, even when another of its lines could.
        if (publicTitle(line.title) === line.title && (!product.titled || later(seen, product.titled) < 0)) {
          product.titled = { ...seen, title: line.title };
        }
        byProduct.set(productId, product);
      }
      if (orderSums.size === 1) {
        const [[code, amount]] = [...orderSums];
        summary.lineTotal = { currency: code, amountMinor: safe(amount) };
      }
      if (summary.refund) {
        view.orders.refunded++;
        const sums = totalsIn(summary.refund.currency);
        sums.refund += BigInt(summary.refund.refundMinor);
        sums.unattributed += BigInt(summary.refund.unattributedMinor);
      }
      if (view.orderList.length < MAX_FRESH_ORDERS) view.orderList.push(summary);
    }

    view.totals = [...totals].sort(([a], [b]) => compare(a, b)).map(([code, sums]) => ({
      currency: code, orderTotalMinor: safe(sums.order), lineMinor: safe(sums.lines), groceryMinor: safe(sums.grocery),
      categorizedMinor: safe(sums.categorized), suggestedMinor: safe(sums.suggested), needsReviewMinor: safe(sums.needsReview),
      refundMinor: safe(sums.refund), lineRefundMinor: safe(sums.lineRefund), unattributedRefundMinor: safe(sums.unattributed),
      netLineMinor: safe(sums.lines - sums.lineRefund - sums.unattributed),
    }));
    view.categories = [...byCategory.values()].map((bucket) => ({
      currency: bucket.currency, category: bucket.category, group: bucket.group, amountMinor: safe(bucket.amount),
      refundMinor: safe(bucket.refund), netMinor: safe(bucket.amount - bucket.refund), lines: bucket.lines,
      refundedLines: bucket.refundedLines, products: bucket.products.size, orders: bucket.orders.size,
    })).sort((a, b) => compare(a.currency, b.currency) || GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group)
      || b.netMinor - a.netMinor || b.amountMinor - a.amountMinor || compare(a.category, b.category));
    view.products = [...byProduct.values()].map((product): AmazonFreshProduct => {
      const purchases = product.purchases.sort(later);
      return {
        ref: product.latest.ref, currency: product.currency, title: product.titled?.title ?? '[redacted]', asin: product.asin,
        ...product.category, amountMinor: safe(product.amount), refundMinor: safe(product.refund),
        netMinor: safe(product.amount - product.refund), lines: purchases.length, orders: product.orders.size,
        quantity: product.quantity,
        weight: product.weight === null ? null : { value: decimal(product.weight), unit: 'lb', estimated: product.estimated },
        lastUnitPrice: product.latest.unitPrice, lastOrderDate: product.latest.date, lastOrderRef: product.latest.orderRef,
        purchases: purchases.slice(0, MAX_FRESH_PURCHASES).map(({ ref, orderRef, orderDate, status, quantity, weight, unitPrice,
          amountMinor, refundMinor }) => ({ ref, orderRef, orderDate, status, quantity, weight, unitPrice, amountMinor, refundMinor })),
      };
    }).sort((a, b) => b.netMinor - a.netMinor || b.amountMinor - a.amountMinor || compare(b.lastOrderDate, a.lastOrderDate)
      || compare(a.ref, b.ref)).slice(0, MAX_FRESH_PRODUCTS);
    return view;
  })();
}

/** One Fresh order's active list, every readable line as it showed it, with its category and refund; null if not one. */
export function amazonFreshOrder(db: Database, orderRef: string): AmazonFreshOrderView | null {
  if (!freshListsCaptured(db)) return null;
  return db.transaction((): AmazonFreshOrderView | null => {
    const [read] = readFreshOrders(db, { orderRef });
    if (!read) return null;
    const assignments = readTaxonomyAssignments(db);
    const lineDecisions = lineTaxonomyLookup(db, 'fresh');
    const identities = lineDecisions.size ? freshLineIdentities(read.orderId, read.lines) : null;
    const evidence = readRefundEvidence(db, [{ ref: read.ref, orderId: read.orderId }]).byOrder.get(read.orderId);
    const { complete, reconciled, byLine, refund } = countFreshOrder(read, evidence);
    return {
      ref: read.ref, date: read.order.date, total: orderTotal(read.order), refund,
      list: { statedCount: read.list?.statedCount ?? null, rows: read.list?.rows ?? null, unreadRows: read.list?.proof.unreadRows ?? null,
        lines: read.lines.length, unreadable: read.unreadable, complete, reconciled },
      lines: read.lines.map(({ ref, ...line }: FreshLineRead): AmazonFreshLineView => ({ ...line, ref,
        title: publicTitle(line.title), replaces: line.replaces === null ? null : publicTitle(line.replaces),
        ...freshLineCategory(line, assignments, identities ? lineDecisions.get(identities.get(line.lineOrdinal)!, line.asin) : undefined),
        refundMinor: safe(byLine.get(line.lineOrdinal) ?? 0n) })),
      // STEP 9 integration (B6)
      ...proofState(read.order),
      ...channelOf(orderChannels(db), read.ref),
    };
  })();
}
