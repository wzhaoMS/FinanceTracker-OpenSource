import type { Database } from 'better-sqlite3';
import {
  AMAZON_ITEM_TAXONOMY_VERSION,
  AMAZON_TAXONOMY_NEEDS_REVIEW,
  AMAZON_TAXONOMY_NODES,
  amazonSpendingWindowRange,
  amazonTaxonomyNode,
  type AmazonSpendingWindow,
  type AmazonTaxonomyNodeId,
} from '@finance-tracker/shared';
import { hasAmazonSchema } from './schema.js';
import { effectiveCategories } from './resolver.js';
import { classifyItem, hasAgentCategories, type AgentCategory, type ItemView } from './readModel.js';
import { productKey, publicTitle } from './products.js';
import { cachedImages, hasCachedImage } from './images.js';
import { currency as isCurrency, minor, refuse } from './policy.js';
import { AMAZON_SPENDING_MEASURE } from './spending.js';
import { attributeOrderRefunds } from './refundAttribution.js';
import { composeOrderRefunds } from './refundEventNetting.js';
import { readRefundEvidence } from './refundEvidence.js';
import {
  addFreshMeasure,
  countFreshLines,
  freshMeasure,
  freshMeasureSums,
  freshPart,
  freshResolved,
  readFreshWindow,
  type AmazonFreshPart,
  type FreshLineShown,
  type FreshMeasure,
  type FreshMeasureSums,
} from './freshItems.js';
import {
  AMAZON_TAXONOMY_DIGEST,
  classifiableProductKey,
  hasAmazonTaxonomySchema,
  readTaxonomyAssignments,
  resolveTaxonomy,
  type ResolvedTaxonomy,
} from './taxonomy.js';
// Keyless holds (Root, after STEP 9): an owner line decision files its line, by the line's stable identity.
import { freshLineDecisions, lineAssignment, lineTaxonomyLookup, orderLineIdentities } from './lineTaxonomy.js';
import type { ItemObservation, OrderObservation } from './types.js';

/**
 * What the household's Amazon items were, and what they cost over a window (GET /amazon/spending/taxonomy), by the
 * item taxonomy: each top level, each subcategory, and each item with its purchases. The same measure as
 * GET /amazon/spending (spending.ts) over the same lines: Amazon's own, by Amazon's order date, never card spending and
 * never added to it. An order counts once, by exactly one list of lines:
 *
 * - An Amazon Fresh order (one with an active Item List) by that list only, exactly as GET /amazon/fresh counts it
 *   (freshItems.ts over fresh.ts): each delivered line costs what its list shows it at, filed where the taxonomy files its
 *   product, with the Fresh tab's refunds. Never also by an order item, so no order counts twice. `fresh` says what of
 *   the figures its lines are, and what it left out (lines not delivered, stored lines that can't be read).
 * - Any other order by its items: an item costing its observed unit price times its observed quantity. Refunds come off
 *   as in spending.ts, by the same evidence and rules (refundAttribution.ts, with order-details and Returns-page refund
 *   statements composed by refundEventNetting.ts): a refund tied to items takes their price off them and their node;
 *   one tied to no item comes off the total only, at most what its order's items still cost.
 *
 * Only where lines are filed differs from spending.ts: by what they are (taxonomy.ts), not by card category, which each
 * ordinary item still shows. Nothing is guessed. A line without a usable assignment (none, an agent's below
 * AMAZON_TAXONOMY_MIN_AGENT_CONFIDENCE, or a title the card-data guard hides) is filed under Needs review, with what it
 * is and any agent's suggestion. An owner's decision for the line itself (keyless holds, Root, after STEP 9:
 * lineTaxonomy.ts), by its stable line identity, files that line wherever it is and whatever its title, an order item
 * or a Fresh line (as the Fresh tab files it). A line without a price or a quantity costs nothing and is counted apart.
 * Every amount is per currency, never converted.
 */
export const MAX_TAXONOMY_PRODUCTS = 5000;
/** Each listed item's purchases, latest first; `lines` still counts them all. */
export const MAX_PRODUCT_PURCHASES = 50;

export interface AmazonTaxonomyPurchase {
  /** The line's opaque ref (as its order lists it). */
  ref: string;
  orderRef: string;
  orderDate: string;
  quantity: number;
  unitPriceMinor: number;
  /** unitPriceMinor × quantity, before refunds. */
  amountMinor: number;
  /** Taken off this line by the refunds tied to it (at most its amount), and the whole units refunded. */
  refundMinor: number;
  refundedQuantity: number;
  /** Its order has a counted refund, whether or not any of it is tied to this line. */
  orderRefunded: boolean;
  /**
   * Only on an Amazon Fresh line: what its order's Item List showed of it. Its price is the list's; `quantity` and
   * `unitPriceMinor` are that price as order-item units (freshLineUnits), and its refunds are money, never units.
   */
  fresh?: FreshLineShown;
}
/**
 * One thing bought: its priced lines in one currency, grouped by ASIN (else by the exact title) and by how they are
 * classified (node, who, confidence, suggested, suggestion), so every field below is true of every line it holds.
 */
export interface AmazonTaxonomyProduct {
  /** Its latest line's ref. */
  ref: string;
  currency: string;
  /** Its latest public title; `[redacted]` when the card-data guard hid every one. */
  title: string;
  asin: string | null;
  node: AmazonTaxonomyNodeId;
  source: ResolvedTaxonomy['source'];
  confidence: number | null;
  /** An agent's assignment below `AMAZON_TAXONOMY_SUGGESTED_BELOW`: assigned, and shown as suggested for the owner to confirm. */
  suggested: boolean;
  suggestion: ResolvedTaxonomy['suggestion'];
  /** The card category its latest line shows on its order's page (null: uncategorized). Unchanged by the taxonomy. */
  cardCategory: string | null;
  cardCategorySource: ItemView['categorySource'];
  quantity: number;
  /** Whole units refunded (a partial refund of an order's only line takes money off, not units). */
  refundedQuantity: number;
  lines: number;
  orders: number;
  /** Of its orders, those with a counted refund. */
  refundedOrders: number;
  /** Before refunds; what refunds tied to it took off; what it cost after them. */
  amountMinor: number;
  refundMinor: number;
  netMinor: number;
  lastOrderDate: string;
  lastOrderRef: string;
  /** Latest first, at most MAX_PRODUCT_PURCHASES. */
  purchases: AmazonTaxonomyPurchase[];
  /**
   * Present only when the owner-only cache holds a thumbnail for its latest line (the one `ref` names): by that line's
   * ASIN, else its captured image ID (`GET /amazon/items/:ref/image`).
   */
  image?: true;
  /**
   * Only on an Amazon Fresh product, whose lines are its orders' Item List lines, never order items (so it has no card
   * category and no thumbnail): the quantities and weights those lines showed, as GET /amazon/fresh shows a product.
   */
  fresh?: FreshMeasure;
}
/** A node's items in one currency: a top level's include its subcategories' and its own. */
export interface AmazonTaxonomyNodeTotal {
  currency: string;
  node: AmazonTaxonomyNodeId;
  /** Before refunds; what refunds tied to its items took off; what they cost after them. */
  amountMinor: number;
  refundMinor: number;
  netMinor: number;
  lines: number;
  /** Of them, the lines a refund is tied to. */
  refundedLines: number;
  products: number;
  orders: number;
  /** Of those orders, the ones with a counted refund. */
  refundedOrders: number;
}
export interface AmazonTaxonomyTotals {
  currency: string;
  /** Every priced line's price, before refunds, and its parts: assigned to a node (of it, only suggested), or not. */
  itemMinor: number;
  assignedMinor: number;
  suggestedMinor: number;
  needsReviewMinor: number;
  /** As spending.ts: refund money counted for the window's orders, tax and shipping included. */
  refundMinor: number;
  /** Item prices refunds took off the items they are tied to. */
  itemRefundMinor: number;
  /** Refunds tied to no item, off the total only: each at most what its order's items still cost. */
  unattributedRefundMinor: number;
  /** itemMinor − itemRefundMinor − unattributedRefundMinor. */
  netItemMinor: number;
}
export interface AmazonTaxonomySpendingView {
  measure: typeof AMAZON_SPENDING_MEASURE;
  window: { key: AmazonSpendingWindow; from: string; to: string };
  taxonomy: { version: typeof AMAZON_ITEM_TAXONOMY_VERSION; digest: string; assignments: 'present' | 'absent' };
  /** `refunded`: orders with a counted refund. */
  orders: { count: number; refunded: number };
  /** `suggested`: of the assigned lines, those only suggested (an agent's below AMAZON_TAXONOMY_SUGGESTED_BELOW). */
  lines: { count: number; priced: number; noPrice: number; noQuantity: number; assigned: number; suggested: number; needsReview: number };
  totals: AmazonTaxonomyTotals[];
  nodes: AmazonTaxonomyNodeTotal[];
  products: AmazonTaxonomyProduct[];
  /** Only when the window holds an Amazon Fresh order: what of the figures above its Item Lists' lines are. */
  fresh?: AmazonFreshPart;
}

/** spending.ts's rule: a priced line's unit price times its quantity, or why it has no cost here. */
function linePrice(item: ItemObservation): { currency: string; unitPriceMinor: number; amountMinor: bigint } | 'no-price' | 'no-quantity' {
  const price = item.unitPrice;
  if (!price || !isCurrency(price.currency) || !minor(price.amountMinor) || price.amountMinor < 0) return 'no-price';
  if (!Number.isSafeInteger(item.quantity) || (item.quantity as number) < 1) return 'no-quantity';
  return { currency: price.currency, unitPriceMinor: price.amountMinor, amountMinor: BigInt(price.amountMinor) * BigInt(item.quantity as number) };
}
const safe = (value: bigint): number => (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= 0n ? Number(value) : refuse());
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const RANK = new Map(AMAZON_TAXONOMY_NODES.map((node, index) => [node.id as string, index]));
interface Seen { date: string; orderRef: string; ref: string }
/** Later first: by order date, then order ref, then line ref. */
const later = (a: Seen, b: Seen) => order(b.date, a.date) || order(b.orderRef, a.orderRef) || order(b.ref, a.ref);

export function amazonTaxonomySpending(db: Database, window: AmazonSpendingWindow, today: string): AmazonTaxonomySpendingView {
  const { from, to } = amazonSpendingWindowRange(window, today);
  const view: AmazonTaxonomySpendingView = {
    measure: AMAZON_SPENDING_MEASURE, window: { key: window, from, to },
    taxonomy: { version: AMAZON_ITEM_TAXONOMY_VERSION, digest: AMAZON_TAXONOMY_DIGEST, assignments: 'absent' },
    orders: { count: 0, refunded: 0 },
    lines: { count: 0, priced: 0, noPrice: 0, noQuantity: 0, assigned: 0, suggested: 0, needsReview: 0 },
    totals: [], nodes: [], products: [],
  };
  // Reads never migrate: with nothing imported, the window is empty.
  if (!hasAmazonSchema(db)) return view;
  return db.transaction(() => {
    view.taxonomy.assignments = hasAmazonTaxonomySchema(db) ? 'present' : 'absent';
    const orders = (db.prepare(`SELECT ref,data_json FROM amazon_orders
      WHERE json_extract(data_json,'$.date') BETWEEN ? AND ? ORDER BY ref`).all(from, to) as Array<{ ref: string; data_json: string }>)
      .map(row => ({ ref: row.ref, order: JSON.parse(row.data_json) as OrderObservation }));
    const linesByOrder = new Map<string, Array<{ ref: string; data_json: string }>>();
    for (const line of db.prepare(`SELECT i.ref,i.order_ref,i.data_json FROM amazon_items i JOIN amazon_orders o ON o.ref=i.order_ref
      WHERE i.native_line_id LIKE o.latest_digest || ':%' AND json_extract(o.data_json,'$.date') BETWEEN ? AND ?
      ORDER BY i.order_ref,json_extract(i.data_json,'$.lineOrdinal'),i.ref`).all(from, to) as Array<{ ref: string; order_ref: string; data_json: string }>) {
      const list = linesByOrder.get(line.order_ref) ?? [];
      list.push(line);
      linesByOrder.set(line.order_ref, list);
    }
    const overrides = new Map((db.prepare('SELECT item_ref,category FROM amazon_item_overrides').all() as
      Array<{ item_ref: string; category: string }>).map(o => [o.item_ref, o.category]));
    const agents = new Map(hasAgentCategories(db) ? (db.prepare(`SELECT product_key,category,confidence FROM amazon_agent_categories
      WHERE source='agent' AND rationale='categorized from product title'`).all() as
      Array<{ product_key: string } & AgentCategory>).map(a => [a.product_key, { category: a.category, confidence: a.confidence }]) : []);
    const categories = new Set(effectiveCategories(db)), images = cachedImages(db);
    const assignments = readTaxonomyAssignments(db);
    const lineDecisions = lineTaxonomyLookup(db, 'ordinary'), freshDecisions = lineTaxonomyLookup(db, 'fresh');
    const evidence = readRefundEvidence(db, orders.map(o => ({ ref: o.ref, orderId: o.order.orderId })));

    const totals = new Map<string, { items: bigint; assigned: bigint; suggested: bigint; needsReview: bigint;
      refund: bigint; itemRefund: bigint; unattributed: bigint }>();
    const totalsIn = (currency: string) => {
      const entry = totals.get(currency)
        ?? { items: 0n, assigned: 0n, suggested: 0n, needsReview: 0n, refund: 0n, itemRefund: 0n, unattributed: 0n };
      totals.set(currency, entry);
      return entry;
    };
    const nodes = new Map<string, { currency: string; node: AmazonTaxonomyNodeId; amount: bigint; refund: bigint; lines: number;
      refundedLines: number; products: Set<string>; orders: Set<string>; refunded: Set<string> }>();
    const products = new Map<string, { currency: string; asin: string | null; resolved: ResolvedTaxonomy; amount: bigint;
      refund: bigint; quantity: number; refundedQuantity: number; orders: Set<string>; refunded: Set<string>;
      purchases: Array<AmazonTaxonomyPurchase & Seen>;
      latest: Seen & { cardCategory: string | null; cardCategorySource: ItemView['categorySource'] };
      titled: (Seen & { title: string }) | null;
      /** Whether its latest line (the one `ref` names) has a cached thumbnail to serve. */
      image: boolean;
      /** An Amazon Fresh product's lines' quantities and weights; null for an order item's product. */
      fresh: FreshMeasureSums | null }>();
    // The window's Amazon Fresh orders, each counted by its active Item List only (none without the Fresh tables).
    const freshOrders = readFreshWindow(db, from, to), fresh = freshPart();

    /**
     * One priced line, filed where the taxonomy files it: in its currency's totals, its node and the node's top level, and
     * its product. An order item and a Fresh line are filed alike, by these same rules.
     */
    const file = (line: { orderRef: string; date: string; ref: string; counted: boolean; currency: string; amount: bigint;
      refunded: bigint; quantity: number; unitPriceMinor: number; refundedUnits: number; resolved: ResolvedTaxonomy;
      identity: unknown; asin: string | null; title: string | null; image: boolean;
      card: { category: string | null; categorySource: ItemView['categorySource'] }; fresh: FreshLineShown | null }) => {
      const { resolved } = line;
      // Needs review is a node: what nothing usable assigns, and what an agent itself said needs review. It stays outside
      // the assigned and suggested counts, which are each a part of the classified items only.
      const needsReview = resolved.node === AMAZON_TAXONOMY_NEEDS_REVIEW;
      const sums = totalsIn(line.currency);
      sums.items += line.amount;
      sums.itemRefund += line.refunded;
      if (needsReview) { sums.needsReview += line.amount; view.lines.needsReview++; }
      else {
        sums.assigned += line.amount;
        view.lines.assigned++;
        if (resolved.suggested) { sums.suggested += line.amount; view.lines.suggested++; }
      }

      // One thing bought, as one classification: lines of an ASIN (else of the exact title) group only when they resolve
      // alike. Two titles of one ASIN assigned differently (0.95 and 0.70) stay two items, each with its own confidence
      // and Suggested state, so a suggested assignment is never shown under another title's surer one. A Fresh line's
      // product is never an order item's: its lines are its orders' Item List lines.
      const productId = JSON.stringify([line.currency, resolved.node, resolved.source, resolved.confidence, resolved.suggested,
        resolved.suggestion, line.identity]);
      const node = amazonTaxonomyNode(resolved.node)!;
      for (const id of node.parent === null ? [node.id] : [node.id, node.parent]) {
        const nodeId = JSON.stringify([line.currency, id]);
        const bucket = nodes.get(nodeId) ?? { currency: line.currency, node: id, amount: 0n, refund: 0n, lines: 0, refundedLines: 0,
          products: new Set<string>(), orders: new Set<string>(), refunded: new Set<string>() };
        bucket.amount += line.amount;
        bucket.refund += line.refunded;
        bucket.lines++;
        if (line.refunded > 0n) bucket.refundedLines++;
        bucket.products.add(productId);
        bucket.orders.add(line.orderRef);
        if (line.counted) bucket.refunded.add(line.orderRef);
        nodes.set(nodeId, bucket);
      }
      const seen: Seen = { date: line.date, orderRef: line.orderRef, ref: line.ref };
      const product = products.get(productId) ?? { currency: line.currency, asin: line.asin, resolved, amount: 0n, refund: 0n,
        quantity: 0, refundedQuantity: 0, orders: new Set<string>(), refunded: new Set<string>(), purchases: [],
        latest: { ...seen, cardCategory: line.card.category, cardCategorySource: line.card.categorySource }, titled: null,
        image: line.image, fresh: line.fresh ? freshMeasureSums() : null };
      product.amount += line.amount;
      product.refund += line.refunded;
      product.quantity += line.quantity;
      product.refundedQuantity += line.refundedUnits;
      product.orders.add(line.orderRef);
      if (line.counted) product.refunded.add(line.orderRef);
      product.purchases.push({ ...seen, orderDate: line.date, quantity: line.quantity, unitPriceMinor: line.unitPriceMinor,
        amountMinor: safe(line.amount), refundMinor: safe(line.refunded), refundedQuantity: line.refundedUnits, orderRefunded: line.counted,
        ...(line.fresh ? { fresh: line.fresh } : {}) });
      if (product.fresh && line.fresh) addFreshMeasure(product.fresh, line.fresh);
      if (later(seen, product.latest) < 0) {
        product.latest = { ...seen, cardCategory: line.card.category, cardCategorySource: line.card.categorySource };
        product.image = line.image;
      }
      if (line.title !== null && (!product.titled || later(seen, product.titled) < 0)) product.titled = { ...seen, title: line.title };
      products.set(productId, product);
    };

    for (const { ref: orderRef, order: observed } of orders) {
      view.orders.count++;
      const read = freshOrders.get(orderRef);
      if (read) {
        // An Amazon Fresh order: by its Item List only, exactly as the Fresh tab counts it, with the Fresh tab's refunds;
        // never by an order item too. An owner's decision for a line itself files it here as on the Fresh tab (keyless holds).
        const freshOrder = countFreshLines(read, evidence.byOrder.get(observed.orderId), assignments,
          freshLineDecisions(freshDecisions, read.orderId, read.lines));
        fresh.add(freshOrder);
        if (freshOrder.refund) view.orders.refunded++;
        view.lines.count += freshOrder.lines.length + freshOrder.noPrice;
        view.lines.noPrice += freshOrder.noPrice;
        for (const line of freshOrder.lines) {
          view.lines.priced++;
          const key = productKey({ asin: line.asin, title: line.title });
          file({ orderRef, date: observed.date, ref: line.ref, counted: freshOrder.refund !== null, currency: line.currency,
            amount: line.amountMinor, refunded: line.refundMinor, quantity: line.quantity, unitPriceMinor: line.unitPriceMinor,
            refundedUnits: 0, resolved: freshResolved(line.category),
            identity: line.asin ? ['fresh-asin', line.asin] : ['fresh-title', key], asin: line.asin,
            title: publicTitle(line.title) === line.title ? line.title : null, image: false, card: { category: null, categorySource: null },
            fresh: line.shown });
        }
        if (freshOrder.refund) {
          // Tied to no line: off the total, never more than the order's lines still cost (the Fresh tab's own figure).
          const sums = totalsIn(freshOrder.refund.currency);
          sums.refund += BigInt(freshOrder.refund.refundMinor);
          sums.unattributed += BigInt(freshOrder.refund.unattributedMinor);
        }
        continue;
      }
      const found = evidence.byOrder.get(observed.orderId) ?? { summaries: [], ledger: [], ledgerObservations: 0, pageRefunds: [] };
      // STEP 9 integration (#166 × #161): page refund statements count here exactly as in spending.ts, so a node's net
      // and the category view's never disagree. Without an issued statement this is v1's own attribution, unchanged.
      const { attribution } = composeOrderRefunds(observed, attributeOrderRefunds(observed, found), found.pageRefunds);
      const counted = attribution.refundMinor > 0 && attribution.currency !== null && attribution.basis !== null && attribution.source !== null;
      if (counted) view.orders.refunded++;
      const tied = new Map(attribution.lines.map(line => [line.lineOrdinal, line]));
      // What the order's items cost in the refund's currency, and what refunds tied to them took off.
      let orderItems = 0n, orderRefunded = 0n;
      const orderLines = linesByOrder.get(orderRef) ?? [];
      const identities = lineDecisions.size
        ? orderLineIdentities(observed.orderId, orderLines.map(line => JSON.parse(line.data_json) as ItemObservation)) : null;
      for (const line of orderLines) {
        const item = JSON.parse(line.data_json) as ItemObservation;
        view.lines.count++;
        const price = linePrice(item);
        if (price === 'no-price' || price === 'no-quantity') {
          view.lines[price === 'no-price' ? 'noPrice' : 'noQuantity']++;
          continue;
        }
        view.lines.priced++;
        // spending.ts's rule: a tied line loses its refunded units' price and any money tied to it, at most its price.
        const tie = item.lineOrdinal === undefined ? undefined : tied.get(item.lineOrdinal);
        const refundedUnits = tie ? Math.min(tie.units, item.quantity as number) : 0;
        let refunded = tie ? BigInt(refundedUnits) * BigInt(price.unitPriceMinor) + BigInt(tie.moneyMinor) : 0n;
        if (refunded > price.amountMinor) refunded = price.amountMinor;
        if (price.currency === attribution.currency) {
          orderItems += price.amountMinor;
          orderRefunded += refunded;
        }
        const key = productKey({ asin: item.itemId, title: item.title });
        const { title, category, categorySource } = classifyItem(item, overrides.get(line.ref), agents.get(key), categories);
        // A title the card-data guard hides is never classified, even by a stored assignment: only an owner's decision for
        // the line itself, by its stable identity, files it (keyless holds, Root, after STEP 9). That decision always wins.
        const classifiable = classifiableProductKey(item);
        const lineIdentity = identities && item.lineOrdinal !== undefined ? identities.get(item.lineOrdinal) : undefined;
        const decided = lineIdentity === undefined ? undefined : lineDecisions.get(lineIdentity, item.itemId);
        file({ orderRef, date: observed.date, ref: line.ref, counted, currency: price.currency, amount: price.amountMinor, refunded,
          quantity: item.quantity as number, unitPriceMinor: price.unitPriceMinor, refundedUnits,
          resolved: resolveTaxonomy(decided ? lineAssignment(decided) : classifiable === null ? undefined : assignments.get(classifiable)),
          identity: item.itemId ? ['asin', item.itemId] : ['title', key], asin: item.itemId, title: title === item.title ? title : null,
          image: hasCachedImage(images, item), card: { category, categorySource }, fresh: null });
      }
      if (counted) {
        const sums = totalsIn(attribution.currency!);
        sums.refund += BigInt(attribution.refundMinor);
        // Not tied to an item: off the total, never more than the order's items still cost.
        const room = orderItems - orderRefunded, unattributed = BigInt(attribution.unattributedMinor);
        sums.unattributed += unattributed < room ? unattributed : room > 0n ? room : 0n;
      }
    }

    view.totals = [...totals].sort(([a], [b]) => order(a, b)).map(([currency, sums]) => ({
      currency, itemMinor: safe(sums.items), assignedMinor: safe(sums.assigned), suggestedMinor: safe(sums.suggested),
      needsReviewMinor: safe(sums.needsReview), refundMinor: safe(sums.refund), itemRefundMinor: safe(sums.itemRefund),
      unattributedRefundMinor: safe(sums.unattributed), netItemMinor: safe(sums.items - sums.itemRefund - sums.unattributed),
    }));
    view.nodes = [...nodes.values()].map(bucket => ({
      currency: bucket.currency, node: bucket.node, amountMinor: safe(bucket.amount), refundMinor: safe(bucket.refund),
      netMinor: safe(bucket.amount - bucket.refund), lines: bucket.lines, refundedLines: bucket.refundedLines,
      products: bucket.products.size, orders: bucket.orders.size, refundedOrders: bucket.refunded.size,
    })).sort((a, b) => order(a.currency, b.currency) || b.netMinor - a.netMinor || b.amountMinor - a.amountMinor
      || RANK.get(a.node)! - RANK.get(b.node)!);
    view.products = [...products.values()].map((product): AmazonTaxonomyProduct => {
      const purchases = product.purchases.sort(later);
      return {
        ref: product.latest.ref, currency: product.currency, title: product.titled?.title ?? '[redacted]', asin: product.asin,
        node: product.resolved.node, source: product.resolved.source, confidence: product.resolved.confidence,
        suggested: product.resolved.suggested, suggestion: product.resolved.suggestion,
        cardCategory: product.latest.cardCategory, cardCategorySource: product.latest.cardCategorySource,
        quantity: product.quantity, refundedQuantity: product.refundedQuantity, lines: purchases.length, orders: product.orders.size,
        refundedOrders: product.refunded.size, amountMinor: safe(product.amount), refundMinor: safe(product.refund),
        netMinor: safe(product.amount - product.refund), lastOrderDate: product.latest.date, lastOrderRef: product.latest.orderRef,
        purchases: purchases.slice(0, MAX_PRODUCT_PURCHASES).map(({ ref, orderRef, orderDate, quantity, unitPriceMinor, amountMinor,
          refundMinor, refundedQuantity, orderRefunded, fresh: shown }) =>
          ({ ref, orderRef, orderDate, quantity, unitPriceMinor, amountMinor, refundMinor, refundedQuantity, orderRefunded,
            ...(shown ? { fresh: shown } : {}) })),
        ...(product.fresh === null && product.image ? { image: true as const } : {}),
        ...(product.fresh ? { fresh: freshMeasure(product.fresh) } : {}),
      };
    }).sort((a, b) => b.netMinor - a.netMinor || b.amountMinor - a.amountMinor || order(b.lastOrderDate, a.lastOrderDate) || order(a.ref, b.ref))
      .slice(0, MAX_TAXONOMY_PRODUCTS);
    // Said only when the window holds a Fresh order: a window without one reads exactly as before Fresh lines counted here.
    const part = fresh.view();
    if (part) view.fresh = part;
    return view;
  })();
}
