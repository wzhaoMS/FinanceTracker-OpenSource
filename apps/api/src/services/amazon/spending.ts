import type { Database } from 'better-sqlite3';
import { amazonSpendingWindowRange, type AmazonSpendingWindow } from '@finance-tracker/shared';
import { hasAmazonSchema } from './schema.js';
import { createAmazonCategoryResolver, effectiveCategories } from './resolver.js';
import { classifyItem, hasAgentCategories, type AgentCategory, type ItemView } from './readModel.js';
import { itemBlockReconciles } from './allocation.js';
import { productKey, publicTitle } from './products.js';
import { cachedImages, hasCachedImage } from './images.js';
import { currency as isCurrency, minor, refuse } from './policy.js';
import {
  REFUND_ATTRIBUTION_POLICY, REFUND_EXCLUSION_REASONS, UNATTRIBUTED_REASONS, attributeOrderRefunds,
  type RefundBasis, type RefundExclusionReason, type RefundSource, type UnattributedReason,
} from './refundAttribution.js';
import {
  REFUND_EVENT_CONFLICT_REASONS, REFUND_EVENT_HOLD_REASONS, REFUND_EVENT_NETTING_POLICY, composeOrderRefunds,
  type RefundEventConflictReason, type RefundEventHoldReason,
} from './refundEventNetting.js';
import { readRefundEvidence } from './refundEvidence.js';
import {
  addFreshMeasure,
  countFreshLines,
  freshCardCategory,
  freshMeasure,
  freshMeasureSums,
  freshPart,
  readFreshWindow,
  type AmazonFreshPart,
  type FreshCardCategorySource,
  type FreshLineShown,
  type FreshMeasure,
  type FreshMeasureSums,
} from './freshItems.js';
import { readTaxonomyAssignments } from './taxonomy.js';
// Keyless holds (Root, STEP 10): a Fresh line's card category is its item category's, so its owner line decision files it.
import { freshLineDecisions, lineTaxonomyLookup } from './lineTaxonomy.js';
import type { ItemObservation, OrderObservation } from './types.js';

/**
 * What the household's Amazon orders' items cost over a window (GET /amazon/spending): Amazon's own measure, by
 * Amazon's order date, never card spending and never added to it. An item costs its observed unit price times its
 * observed quantity. Each order counts once, with the lines its latest capture kept, as the order's own page shows
 * them; its category is the one that page shows (the owner's, else the agent's from its title, else none).
 *
 * An Amazon Fresh order (one with an active Item List) counts by that list only, exactly as GET /amazon/fresh counts it
 * (freshItems.ts over fresh.ts), never by an order item too, so no order counts twice: each delivered line costs what
 * its list shows it at, with the Fresh tab's refunds, under the card category its item-taxonomy node corresponds to (the
 * owner's assignment winning over an agent's; Groceries', said as a default, while it isn't classified). `fresh` says
 * what of the figures those lines are. Card matches and itemized card charges are the resolver's, unchanged: Fresh lines
 * are never card spending, never allocated, never order items.
 *
 * Refunds come off, by the same order date: a refund counts in the window of its order, so each window's net is what
 * its orders cost after the refunds Amazon shows for them so far (a later refund lowers an earlier window), and gross
 * and net always cover the same orders. Amazon's own records are the evidence (an order's Refund Total and the
 * payments ledger's refunds, each counted once, the larger when both: refundAttribution.ts; and the refunds its
 * order-details pages and Returns page say were issued, per item the largest, never added to the same money from
 * another record: refundEventNetting.ts); no card credit is needed, and none ever adds to them. A refund tied to items
 * takes their prices off them and their category; one that can't be tied to items comes off the total only, at most
 * what its order's items still cost.
 *
 * Nothing is guessed, and nothing left out is hidden: a line without a price or a quantity (the producer never
 * defaults one) costs nothing here and is counted apart; an order counts as fully itemized only when the domain's
 * own proof says its item list is complete and adds up to Amazon's item subtotal (a capture may keep only some of an
 * order's lines); an order without lines counts in order totals only; refund evidence that contradicts itself or its
 * order is left out and counted. Every amount is per currency, never converted.
 */
export const AMAZON_SPENDING_MEASURE = 'amazon-order-item-prices-not-card-spending';
/** At most this many items are listed, largest net first; every total and count still includes them all. */
export const MAX_SPENDING_PRODUCTS = 1000;
/**
 * Besides them, at most this many refunded items the first list leaves out, most refunded first, so refunded items
 * can be shown as refunded; `refunds.refundedProducts` says how many there are in all and whether any is left out.
 */
export const MAX_REFUNDED_PRODUCTS = 1000;

export interface AmazonSpendingTotals {
  currency: string;
  /** Amazon's order totals: tax, shipping, promotions and gift cards included. */
  orderTotalMinor: number;
  /** Of them, the orders whose item list is proven complete (`orders.itemsComplete`). */
  itemsCompleteOrderTotalMinor: number;
  /** Every priced line's unit price times quantity: what the items cost before refunds. */
  itemMinor: number;
  /** Of them, the lines with a category. */
  categorizedMinor: number;
  /** The refund money counted for the window's orders, tax and shipping included (each order's, counted once). */
  refundMinor: number;
  /** Item prices refunds took off the items they are tied to. */
  itemRefundMinor: number;
  /** Refunds tied to no item, taken off the total only: each at most what its order's items still cost. */
  unattributedRefundMinor: number;
  /** What the items cost after refunds: itemMinor − itemRefundMinor − unattributedRefundMinor. */
  netItemMinor: number;
}
export interface AmazonSpendingCategory {
  currency: string;
  /** null: no category. */
  category: string | null;
  /** Before refunds. */
  amountMinor: number;
  /** Taken off its items by the refunds tied to them. */
  refundMinor: number;
  /** amountMinor − refundMinor. */
  netMinor: number;
  lines: number;
  /** Of them, the lines a refund is tied to. */
  refundedLines: number;
  /** How many listed items (`products`) it holds, whether or not the list's cap shows them all. */
  products: number;
  orders: number;
}
/** One thing bought: its priced lines in one currency and category, grouped by ASIN, else by the exact title. */
export interface AmazonSpendingProduct {
  /** Its latest line's opaque ref (as an order lists it). */
  ref: string;
  currency: string;
  /** Its latest public title; `[redacted]` when the card-data guard hid every one. */
  title: string;
  asin: string | null;
  category: string | null;
  /** An order item's: the owner's override or the agent's classification. A Fresh product's: its item category's, or the default. */
  categorySource: ItemView['categorySource'] | FreshCardCategorySource;
  quantity: number;
  lines: number;
  orders: number;
  /** Before refunds. */
  amountMinor: number;
  /** Taken off it by the refunds tied to it. */
  refundMinor: number;
  /** amountMinor − refundMinor. */
  netMinor: number;
  /** Whole units refunded (a partial refund of an order's only line takes money off, not units). */
  refundedQuantity: number;
  lastOrderDate: string;
  lastOrderRef: string;
  /**
   * Present only when the owner-only cache holds a thumbnail for its latest line (the one `ref` names): by that line's
   * ASIN, else its captured image ID (`GET /amazon/items/:ref/image`).
   */
  image?: true;
  /**
   * Only on an Amazon Fresh product, whose lines are its orders' Item List lines, never order items (no thumbnail): the
   * quantities and weights those lines showed, as GET /amazon/fresh shows a product. `quantity` counts its lines as
   * order-item units, and its refunds are money, never units.
   */
  fresh?: FreshMeasure;
}
/** How the window's refunds were counted and tied to items. Every closed value is listed, zero counts included. */
export interface AmazonSpendingRefunds {
  policy: string;
  /** Orders with a counted refund, by how it is tied to items. */
  orders: Array<{ basis: RefundBasis; orders: number }>;
  /** Of them, orders with refund money tied to no item (`partly` and `unattributed`), by the rule that held. */
  unattributed: Array<{ reason: UnattributedReason; orders: number }>;
  /** Which evidence each order's counted amount is: its Refund Total, or its ledger refunds when they are more. */
  sources: Array<{ source: RefundSource; orders: number }>;
  /** Distinct ledger refunds of the window's orders, and the observations behind them (captures repeat them). */
  ledgerRefunds: number;
  ledgerObservations: number;
  /** Orders with a Refund Total observed, and how many observations of it (each order's counts once). */
  refundTotals: number;
  refundTotalObservations: number;
  /** Refund records left out, never counted. */
  excluded: Array<{ reason: RefundExclusionReason; count: number }>;
  /** Items with a refund: how many in all, how many `products` lists, and whether it leaves any out. */
  refundedProducts: { count: number; listed: number; truncated: boolean };
  /**
   * Only when the window's orders have refunds their order-details pages or the Returns page say were issued
   * (refundEventNetting.ts): those refunds (one per projection event and item identity), and the statements behind
   * them; the orders they are on; of those, the orders whose refund attribution they held whole, by why; and the
   * orders where they showed something that holds nothing but is surfaced, such as a refund's status stepping back
   * (every closed value listed, counts only).
   */
  pageEvents?: { policy: string; events: number; observations: number; orders: number;
    held: Array<{ reason: RefundEventHoldReason; orders: number }>;
    conflicts: Array<{ reason: RefundEventConflictReason; orders: number }> };
}
export interface AmazonSpendingView {
  measure: typeof AMAZON_SPENDING_MEASURE;
  window: { key: AmazonSpendingWindow; from: string; to: string };
  /** The live reconciliation snapshot the card match counts come from. */
  version?: string;
  orders: {
    count: number; withTotal: number;
    /**
     * Orders whose item list is proven complete: the capture's positive item proof, every line priced, and the
     * prices adding up to Amazon's item subtotal (`itemBlockReconciles`). Any other order may have more items.
     */
    itemsComplete: number;
    /** Orders whose latest capture kept no line (none observed, or a capture that keeps none). */
    noLines: number;
    /** Orders with a counted refund. */
    refunded: number;
    /**
     * By the order's card charge: `linked` when one of its card charges (a live posted purchase) is linked, `held` when
     * not and a match of it is held for review, else `unmatched`. A refund credit linked to the order is the refund's
     * link, not its charge's: alone, it never makes the order linked.
     */
    linked: number; held: number; unmatched: number;
  };
  /** Live posted card purchases linked to these orders, and how many of them Spending files under their items. */
  cardCharges: { linked: number; itemized: number };
  lines: { count: number; priced: number; noPrice: number; noQuantity: number; categorized: number };
  totals: AmazonSpendingTotals[];
  categories: AmazonSpendingCategory[];
  products: AmazonSpendingProduct[];
  refunds: AmazonSpendingRefunds;
  /** Only when the window holds an Amazon Fresh order: what of the figures above its Item Lists' lines are. */
  fresh?: AmazonFreshPart;
}

interface LineRow { ref: string; order_ref: string; data_json: string }
type Price = { currency: string; amountMinor: bigint } | 'no-price' | 'no-quantity';

function linePrice(item: ItemObservation): Price {
  const price = item.unitPrice;
  if (!price || !isCurrency(price.currency) || !minor(price.amountMinor) || price.amountMinor < 0) return 'no-price';
  if (!Number.isSafeInteger(item.quantity) || (item.quantity as number) < 1) return 'no-quantity';
  return { currency: price.currency, amountMinor: BigInt(price.amountMinor) * BigInt(item.quantity as number) };
}
const safe = (value: bigint): number => (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
  ? Number(value) : refuse());
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Later first: by order date, then order ref, then line ref, so the latest line is the same on every read. */
const later = (a: { date: string; orderRef: string; ref: string }, b: { date: string; orderRef: string; ref: string }) =>
  order(b.date, a.date) || order(b.orderRef, a.orderRef) || order(b.ref, a.ref);
const BASES: readonly RefundBasis[] = ['whole-order', 'item-records', 'units', 'only-line', 'partly', 'unattributed'];
const SOURCES: readonly RefundSource[] = ['order-summary', 'ledger', 'item-records'];
const emptyRefunds = (): AmazonSpendingRefunds => ({
  policy: REFUND_ATTRIBUTION_POLICY.version,
  orders: BASES.map(basis => ({ basis, orders: 0 })),
  unattributed: UNATTRIBUTED_REASONS.map(reason => ({ reason, orders: 0 })),
  sources: SOURCES.map(source => ({ source, orders: 0 })),
  ledgerRefunds: 0, ledgerObservations: 0, refundTotals: 0, refundTotalObservations: 0,
  excluded: REFUND_EXCLUSION_REASONS.map(reason => ({ reason, count: 0 })),
  refundedProducts: { count: 0, listed: 0, truncated: false },
});

export function amazonSpending(db: Database, window: AmazonSpendingWindow, today: string): AmazonSpendingView {
  const { from, to } = amazonSpendingWindowRange(window, today);
  const view: AmazonSpendingView = {
    measure: AMAZON_SPENDING_MEASURE, window: { key: window, from, to },
    orders: { count: 0, withTotal: 0, itemsComplete: 0, noLines: 0, refunded: 0, linked: 0, held: 0, unmatched: 0 },
    cardCharges: { linked: 0, itemized: 0 },
    lines: { count: 0, priced: 0, noPrice: 0, noQuantity: 0, categorized: 0 },
    totals: [], categories: [], products: [], refunds: emptyRefunds(),
  };
  // Reads never migrate: with nothing imported, the window is empty.
  if (!hasAmazonSchema(db)) return view;
  return db.transaction(() => {
    const snapshot = createAmazonCategoryResolver(db).snapshot();
    const orders = (db.prepare(`SELECT ref,data_json FROM amazon_orders
      WHERE json_extract(data_json,'$.date') BETWEEN ? AND ? ORDER BY ref`).all(from, to) as Array<{ ref: string; data_json: string }>)
      .map(row => ({ ref: row.ref, order: JSON.parse(row.data_json) as OrderObservation }));
    const linesByOrder = new Map<string, LineRow[]>();
    for (const line of db.prepare(`SELECT i.ref,i.order_ref,i.data_json FROM amazon_items i JOIN amazon_orders o ON o.ref=i.order_ref
      WHERE i.native_line_id LIKE o.latest_digest || ':%' AND json_extract(o.data_json,'$.date') BETWEEN ? AND ?
      ORDER BY i.order_ref,json_extract(i.data_json,'$.lineOrdinal'),i.ref`).all(from, to) as LineRow[]) {
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
    const evidence = readRefundEvidence(db, orders.map(o => ({ ref: o.ref, orderId: o.order.orderId })));

    const totals = new Map<string, { order: bigint; completeOrders: bigint; items: bigint; categorized: bigint;
      refund: bigint; itemRefund: bigint; unattributed: bigint }>();
    const totalsIn = (currency: string) => {
      const entry = totals.get(currency)
        ?? { order: 0n, completeOrders: 0n, items: 0n, categorized: 0n, refund: 0n, itemRefund: 0n, unattributed: 0n };
      totals.set(currency, entry);
      return entry;
    };
    const byCategory = new Map<string, { currency: string; category: string | null; amount: bigint; refund: bigint; lines: number;
      refundedLines: number; products: Set<string>; orders: Set<string> }>();
    interface Latest { date: string; orderRef: string; ref: string }
    const byProduct = new Map<string, { currency: string; asin: string | null; category: string | null;
      categorySource: AmazonSpendingProduct['categorySource']; amount: bigint; refund: bigint; quantity: number; refundedQuantity: number;
      lines: number; orders: Set<string>; latest: Latest; titled: (Latest & { title: string }) | null;
      /** Whether its latest line (the one `ref` names) has a cached thumbnail to serve. */
      image: boolean;
      /** An Amazon Fresh product's lines' quantities and weights; null for an order item's product. */
      fresh: FreshMeasureSums | null }>();
    const linkedCharges = new Set<string>(), itemizedCharges = new Set<string>();
    const refunds = view.refunds;
    const excludeRefunds = (reason: RefundExclusionReason, count: number) => {
      refunds.excluded.find(entry => entry.reason === reason)!.count += count;
    };
    for (const entry of evidence.excluded) excludeRefunds(entry.reason, entry.count);
    const pages = { events: 0, observations: 0, orders: 0, held: new Map<RefundEventHoldReason, number>(),
      conflicts: new Map<RefundEventConflictReason, number>() };
    // The window's Amazon Fresh orders, each counted by its active Item List only (none without the Fresh tables), and the
    // item taxonomy that files their lines (read only when there is one).
    const freshOrders = readFreshWindow(db, from, to), fresh = freshPart();
    const assignments = freshOrders.size ? readTaxonomyAssignments(db) : new Map();
    // Owner decisions for Fresh lines themselves (keyless holds): a decided line's item category, and so its card category
    // (#178's freshCardCategory), is the owner's, as on the Fresh tab. An order item keeps its card's category.
    const freshDecisions = freshOrders.size ? lineTaxonomyLookup(db, 'fresh') : null;

    /** One priced line, in its currency's totals, its category and its product: an order item and a Fresh line alike. */
    const file = (line: { orderRef: string; date: string; ref: string; currency: string; amount: bigint; refunded: bigint;
      quantity: number; refundedUnits: number; category: string | null; categorySource: AmazonSpendingProduct['categorySource'];
      identity: unknown; asin: string | null; title: string | null; image: boolean; fresh: FreshLineShown | null }) => {
      const sums = totalsIn(line.currency);
      sums.items += line.amount;
      sums.itemRefund += line.refunded;
      if (line.category !== null) {
        sums.categorized += line.amount;
        view.lines.categorized++;
      }
      const productId = JSON.stringify([line.currency, line.category, line.categorySource, line.identity]);
      const categoryId = JSON.stringify([line.currency, line.category]);
      const bucket = byCategory.get(categoryId) ?? { currency: line.currency, category: line.category, amount: 0n, refund: 0n, lines: 0,
        refundedLines: 0, products: new Set<string>(), orders: new Set<string>() };
      bucket.amount += line.amount;
      bucket.refund += line.refunded;
      bucket.lines++;
      if (line.refunded > 0n) bucket.refundedLines++;
      bucket.products.add(productId);
      bucket.orders.add(line.orderRef);
      byCategory.set(categoryId, bucket);
      const seen: Latest = { date: line.date, orderRef: line.orderRef, ref: line.ref };
      const product = byProduct.get(productId) ?? { currency: line.currency, asin: line.asin, category: line.category,
        categorySource: line.categorySource, amount: 0n, refund: 0n, quantity: 0, refundedQuantity: 0, lines: 0, orders: new Set<string>(),
        latest: seen, titled: null, image: line.image, fresh: line.fresh ? freshMeasureSums() : null };
      product.amount += line.amount;
      product.refund += line.refunded;
      product.quantity += line.quantity;
      product.refundedQuantity += line.refundedUnits;
      product.lines++;
      product.orders.add(line.orderRef);
      if (product.fresh && line.fresh) addFreshMeasure(product.fresh, line.fresh);
      if (later(seen, product.latest) < 0) {
        product.latest = seen;
        product.image = line.image;
      }
      // A title the guard hides never names the item, even when another line of the same ASIN can.
      if (line.title !== null && (!product.titled || later(seen, product.titled) < 0)) product.titled = { ...seen, title: line.title };
      byProduct.set(productId, product);
    };

    for (const { ref: orderRef, order: observed } of orders) {
      view.orders.count++;
      const total = observed.total && isCurrency(observed.total.currency) && minor(observed.total.amountMinor)
        && observed.total.amountMinor >= 0 ? observed.total : null;
      if (total) {
        view.orders.withTotal++;
        totalsIn(total.currency).order += BigInt(total.amountMinor);
      }
      const found = evidence.byOrder.get(observed.orderId) ?? { summaries: [], ledger: [], ledgerObservations: 0, pageRefunds: [] };
      // An Amazon Fresh order: by its Item List only, exactly as the Fresh tab counts it (its refunds' attribution and page
      // statements included), never by an order item too.
      const read = freshOrders.get(orderRef);
      const freshOrder = read ? countFreshLines(read, evidence.byOrder.get(observed.orderId), assignments,
        freshDecisions ? freshLineDecisions(freshDecisions, read.orderId, read.lines) : undefined) : null;
      const composed = freshOrder ? freshOrder.composition
        : composeOrderRefunds(observed, attributeOrderRefunds(observed, found), found.pageRefunds);
      const { attribution } = composed;
      if (composed.events) {
        pages.events += composed.events;
        pages.observations += composed.observations;
        pages.orders++;
        if (composed.held) pages.held.set(composed.held, (pages.held.get(composed.held) ?? 0) + 1);
        for (const reason of composed.conflicts) pages.conflicts.set(reason, (pages.conflicts.get(reason) ?? 0) + 1);
      }
      // What the order's items cost in the refund's currency, and what refunds tied to them took off.
      let orderItems = 0n, orderRefunded = 0n;
      if (freshOrder) {
        fresh.add(freshOrder);
        if (freshOrder.read.lines.length === 0) view.orders.noLines++;
        view.lines.count += freshOrder.lines.length + freshOrder.noPrice;
        view.lines.noPrice += freshOrder.noPrice;
        for (const line of freshOrder.lines) {
          view.lines.priced++;
          const key = productKey({ asin: line.asin, title: line.title });
          file({ orderRef, date: observed.date, ref: line.ref, currency: line.currency, amount: line.amountMinor, refunded: line.refundMinor,
            quantity: line.quantity, refundedUnits: 0, ...freshCardCategory(line),
            identity: line.asin ? ['fresh-asin', line.asin] : ['fresh-title', key], asin: line.asin,
            title: publicTitle(line.title) === line.title ? line.title : null, image: false, fresh: line.shown });
        }
        // The Item List's own proof: whole, every delivered line priced, adding up to the order's own item subtotal.
        if (freshOrder.reconciled) {
          view.orders.itemsComplete++;
          if (total) totalsIn(total.currency).completeOrders += BigInt(total.amountMinor);
        }
      } else {
        const tied = new Map(attribution.lines.map(line => [line.lineOrdinal, line]));
        const lines = linesByOrder.get(orderRef) ?? [];
        if (lines.length === 0) view.orders.noLines++;
        let everyLinePriced = true;
        for (const line of lines) {
          const item = JSON.parse(line.data_json) as ItemObservation;
          view.lines.count++;
          const price = linePrice(item);
          if (price === 'no-price' || price === 'no-quantity') {
            view.lines[price === 'no-price' ? 'noPrice' : 'noQuantity']++;
            everyLinePriced = false;
            continue;
          }
          view.lines.priced++;
          const tie = item.lineOrdinal === undefined ? undefined : tied.get(item.lineOrdinal);
          const refundedUnits = tie ? Math.min(tie.units, item.quantity as number) : 0;
          let refunded = tie ? BigInt(refundedUnits) * BigInt(item.unitPrice!.amountMinor) + BigInt(tie.moneyMinor) : 0n;
          if (refunded > price.amountMinor) refunded = price.amountMinor;
          if (price.currency === attribution.currency) {
            orderItems += price.amountMinor;
            orderRefunded += refunded;
          }
          const key = productKey({ asin: item.itemId, title: item.title });
          const { title, category, categorySource } = classifyItem(item, overrides.get(line.ref), agents.get(key), categories);
          file({ orderRef, date: observed.date, ref: line.ref, currency: price.currency, amount: price.amountMinor, refunded,
            quantity: item.quantity as number, refundedUnits, category, categorySource,
            identity: item.itemId ? ['asin', item.itemId] : ['title', key], asin: item.itemId, title: title === item.title ? title : null,
            image: hasCachedImage(images, item), fresh: null });
        }
        // Every line priced is not enough: a capture can keep only some of an order's lines. Only the domain's proof
        // that the list is whole and adds up to Amazon's item subtotal makes the order fully itemized.
        if (lines.length > 0 && everyLinePriced && lines.length === observed.items.length && itemBlockReconciles(observed)) {
          view.orders.itemsComplete++;
          if (total) totalsIn(total.currency).completeOrders += BigInt(total.amountMinor);
        }
      }
      const matches = snapshot.getOrderMatches(orderRef);
      // Linked to a card charge: a linked refund credit (a ledger refund, or a card credit tied to the order) is not one.
      const charges = matches.flatMap(match => (match.state === 'linked'
        && snapshot.linkedChargeItemization(match.cardTransactionId) !== null ? [match.cardTransactionId] : []));
      if (charges.length > 0) view.orders.linked++;
      else if (matches.some(match => match.state === 'held')) view.orders.held++;
      else view.orders.unmatched++;
      for (const charge of charges) {
        linkedCharges.add(charge);
        if (snapshot.linkedChargeItemization(charge) === 'itemized') itemizedCharges.add(charge);
      }

      refunds.ledgerRefunds += found.ledger.length;
      refunds.ledgerObservations += found.ledgerObservations;
      if (found.summaries.length) {
        refunds.refundTotals++;
        refunds.refundTotalObservations += found.summaries.length;
      }
      for (const entry of attribution.excluded) excludeRefunds(entry.reason, entry.count);
      if (attribution.refundMinor > 0 && attribution.currency !== null && attribution.basis && attribution.source) {
        view.orders.refunded++;
        const sums = totalsIn(attribution.currency);
        sums.refund += BigInt(attribution.refundMinor);
        // Not tied to an item: off the total, never more than the order's items (a Fresh order's lines: the Fresh tab's own
        // figure) still cost.
        const room = orderItems - orderRefunded, unattributed = BigInt(attribution.unattributedMinor);
        sums.unattributed += freshOrder ? BigInt(freshOrder.refund?.unattributedMinor ?? 0)
          : unattributed < room ? unattributed : room > 0n ? room : 0n;
        const { basis, source, unattributedReason } = attribution;
        refunds.orders.find(entry => entry.basis === basis)!.orders++;
        refunds.sources.find(entry => entry.source === source)!.orders++;
        if (unattributedReason) refunds.unattributed.find(entry => entry.reason === unattributedReason)!.orders++;
      }
    }

    view.version = snapshot.version;
    view.cardCharges = { linked: linkedCharges.size, itemized: itemizedCharges.size };
    view.totals = [...totals].sort(([a], [b]) => order(a, b)).map(([currency, sums]) => ({
      currency, orderTotalMinor: safe(sums.order), itemsCompleteOrderTotalMinor: safe(sums.completeOrders),
      itemMinor: safe(sums.items), categorizedMinor: safe(sums.categorized), refundMinor: safe(sums.refund),
      itemRefundMinor: safe(sums.itemRefund), unattributedRefundMinor: safe(sums.unattributed),
      netItemMinor: safe(sums.items - sums.itemRefund - sums.unattributed),
    }));
    // Largest net first: a category whose items came back sinks below what was kept.
    view.categories = [...byCategory.values()].map(bucket => ({
      currency: bucket.currency, category: bucket.category, amountMinor: safe(bucket.amount), refundMinor: safe(bucket.refund),
      netMinor: safe(bucket.amount - bucket.refund), lines: bucket.lines, refundedLines: bucket.refundedLines,
      products: bucket.products.size, orders: bucket.orders.size,
    })).sort((a, b) => order(a.currency, b.currency) || b.netMinor - a.netMinor || b.amountMinor - a.amountMinor
      || (a.category === null ? 1 : b.category === null ? -1 : order(a.category, b.category)));
    // Largest net first across currencies, so every currency's list is the top of its own ranking; refunded items it
    // leaves out are listed besides, most refunded first and bounded, however small their net.
    const ranked = [...byProduct.values()].map((product): AmazonSpendingProduct => ({
      ref: product.latest.ref, currency: product.currency, title: product.titled?.title ?? '[redacted]', asin: product.asin,
      category: product.category, categorySource: product.categorySource, quantity: product.quantity, lines: product.lines,
      orders: product.orders.size, amountMinor: safe(product.amount), refundMinor: safe(product.refund),
      netMinor: safe(product.amount - product.refund), refundedQuantity: product.refundedQuantity,
      lastOrderDate: product.latest.date, lastOrderRef: product.latest.orderRef,
      ...(product.fresh === null && product.image ? { image: true as const } : {}),
      ...(product.fresh ? { fresh: freshMeasure(product.fresh) } : {}),
    })).sort((a, b) => b.netMinor - a.netMinor || b.amountMinor - a.amountMinor || order(b.lastOrderDate, a.lastOrderDate)
      || order(a.ref, b.ref));
    const top = ranked.slice(0, MAX_SPENDING_PRODUCTS);
    const beyond = ranked.slice(MAX_SPENDING_PRODUCTS).filter(product => product.refundMinor > 0)
      .sort((a, b) => b.refundMinor - a.refundMinor || order(a.ref, b.ref));
    view.products = [...top, ...beyond.slice(0, MAX_REFUNDED_PRODUCTS)];
    const refunded = ranked.filter(product => product.refundMinor > 0).length;
    const listed = view.products.filter(product => product.refundMinor > 0).length;
    view.refunds.refundedProducts = { count: refunded, listed, truncated: listed < refunded };
    // Said only when there is something to say: a window without such events reads exactly as before them.
    if (pages.events > 0) {
      view.refunds.pageEvents = { policy: REFUND_EVENT_NETTING_POLICY.version, events: pages.events,
        observations: pages.observations, orders: pages.orders,
        held: REFUND_EVENT_HOLD_REASONS.map(reason => ({ reason, orders: pages.held.get(reason) ?? 0 })),
        conflicts: REFUND_EVENT_CONFLICT_REASONS.map(reason => ({ reason, orders: pages.conflicts.get(reason) ?? 0 })) };
    }
    // Said only when the window holds a Fresh order: a window without one reads exactly as before Fresh lines counted here.
    const part = fresh.view();
    if (part) view.fresh = part;
    return view;
  })();
}
