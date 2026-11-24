import {
  AMAZON_ITEM_TAXONOMY_VERSION,
  amazonTaxonomyNode,
  isAmazonTaxonomyNode,
  type AmazonTaxonomyNodeId,
  type AmazonTaxonomySource,
} from '@finance-tracker/shared';

import { api } from '../../services/api';
import { AMAZON_ORDER_REF } from '../../modes/route';
import { AMAZON_SPENDING_MEASURE, AmazonAnswerError, type AmazonCategorySource, type AmazonSpendingWindow } from './amazonApi';
import {
  freshMeasureFits,
  freshPartFits,
  freshProductsFit,
  readFreshLineShown,
  readFreshMeasure,
  readFreshPart,
  type AmazonFreshLineShown,
  type AmazonFreshMeasure,
  type AmazonFreshPart,
} from './amazonFreshItems';

/**
 * What a window's Amazon items were (GET /amazon/spending/taxonomy): the same item prices as GET /amazon/spending,
 * Amazon's own measure by order date, never card spending, filed by what each item is (the shared Amazon item
 * taxonomy) instead of by card category. An Amazon Fresh order counts by its Item List's lines, as the Fresh tab counts
 * it (`fresh`). Read-only, and checked whole before anything is shown: a malformed field, a node the taxonomy doesn't
 * have, or totals that don't add up refuse the answer, so a figure never reads as more than the API said.
 */

export interface AmazonTaxonomyPurchase {
  ref: string;
  orderRef: string;
  orderDate: string;
  quantity: number;
  unitPriceMinor: number;
  /** Before refunds. */
  amountMinor: number;
  /** Taken off this line by the refunds tied to it, and the whole units refunded. */
  refundMinor: number;
  refundedQuantity: number;
  /** Its order has a counted refund, whether or not any of it is tied to this line. */
  orderRefunded: boolean;
  /** Only on an Amazon Fresh line: what its order's Item List showed of it (its refunds are money, never units). */
  fresh?: AmazonFreshLineShown;
}
export interface AmazonTaxonomyProduct {
  ref: string;
  currency: string;
  /** null: the card-data guard hid every title it had. */
  title: string | null;
  asin: string | null;
  node: AmazonTaxonomyNodeId;
  /** Who filed it there; null in Needs review for want of a usable assignment. */
  source: AmazonTaxonomySource | null;
  confidence: number | null;
  /** An agent's assignment that counts, below the confident threshold: shown as suggested. */
  suggested: boolean;
  /** In Needs review: the agent's node, below the minimum confidence. */
  suggestion: { node: AmazonTaxonomyNodeId; confidence: number } | null;
  /** The card category its order shows (null: uncategorized), and who chose it. */
  cardCategory: string | null;
  cardCategorySource: AmazonCategorySource | null;
  quantity: number;
  refundedQuantity: number;
  lines: number;
  orders: number;
  refundedOrders: number;
  /** Before refunds; taken off it by the refunds tied to it; after them. */
  amountMinor: number;
  refundMinor: number;
  netMinor: number;
  lastOrderDate: string;
  lastOrderRef: string;
  /** Latest first; the API may list fewer than `lines`. */
  purchases: AmazonTaxonomyPurchase[];
  image?: true;
  /** Only on an Amazon Fresh product (no card category, no thumbnail): what its lines' Item Lists showed together. */
  fresh?: AmazonFreshMeasure;
}
export interface AmazonTaxonomyNodeTotal {
  currency: string;
  node: AmazonTaxonomyNodeId;
  /** Before refunds; taken off its items by the refunds tied to them; after them. */
  amountMinor: number;
  refundMinor: number;
  netMinor: number;
  lines: number;
  refundedLines: number;
  products: number;
  orders: number;
  refundedOrders: number;
}
export interface AmazonTaxonomyTotals {
  currency: string;
  itemMinor: number;
  assignedMinor: number;
  suggestedMinor: number;
  needsReviewMinor: number;
  /** Refund money counted for the window's orders, tax and shipping included. */
  refundMinor: number;
  /** Item prices refunds took off the items they're tied to; refunds tied to no item, off the total only. */
  itemRefundMinor: number;
  unattributedRefundMinor: number;
  /** itemMinor − itemRefundMinor − unattributedRefundMinor. */
  netItemMinor: number;
}
export interface AmazonTaxonomySpending {
  window: { key: AmazonSpendingWindow; from: string; to: string };
  /** Whether any classification has been imported at all. */
  assignments: 'present' | 'absent';
  orders: { count: number; refunded: number };
  lines: { count: number; priced: number; noPrice: number; noQuantity: number; assigned: number; suggested: number; needsReview: number };
  totals: AmazonTaxonomyTotals[];
  nodes: AmazonTaxonomyNodeTotal[];
  /** Largest first; the API may list fewer than the nodes count. */
  products: AmazonTaxonomyProduct[];
  /** Only when the window holds an Amazon Fresh order: what of the figures its Item Lists' lines are. */
  fresh?: AmazonFreshPart;
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
const isCurrency = (value: unknown): value is string => typeof value === 'string' && /^[A-Z]{3}$/.test(value);
const isRef = (value: unknown): value is string => typeof value === 'string' && AMAZON_ORDER_REF.test(value);
const isConfidence = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const CARD_SOURCES: readonly AmazonCategorySource[] = ['item-override', 'agent-classification', 'reviewed-mapping'];
const HIDDEN_TITLE = '[redacted]';
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

function counts<K extends string>(raw: unknown, keys: readonly K[], what: string): Record<K, number> {
  if (!isRecord(raw)) throw new AmazonAnswerError(what);
  const parsed = {} as Record<K, number>;
  for (const key of keys) {
    if (!isCount(raw[key])) throw new AmazonAnswerError(what);
    parsed[key] = raw[key] as number;
  }
  return parsed;
}
function purchase(raw: unknown): AmazonTaxonomyPurchase {
  if (!isRecord(raw) || !isRef(raw.ref) || !isRef(raw.orderRef) || !isDay(raw.orderDate) || typeof raw.orderRefunded !== 'boolean') {
    throw new AmazonAnswerError('items');
  }
  const values = counts(raw, ['quantity', 'unitPriceMinor', 'amountMinor', 'refundMinor', 'refundedQuantity'], 'items');
  if (values.quantity < 1 || values.unitPriceMinor * values.quantity !== values.amountMinor || values.refundMinor > values.amountMinor
    || values.refundedQuantity > values.quantity || (values.refundMinor > 0 && !raw.orderRefunded)) throw new AmazonAnswerError('items');
  // A Fresh line says what its Item List showed; its refunds are money, never units.
  const fresh = raw.fresh === undefined ? undefined : readFreshLineShown(raw.fresh);
  if (raw.fresh !== undefined && (!fresh || values.refundedQuantity > 0)) throw new AmazonAnswerError('items');
  return { ref: raw.ref, orderRef: raw.orderRef, orderDate: raw.orderDate, ...values, orderRefunded: raw.orderRefunded,
    ...(fresh ? { fresh } : {}) };
}

/** A window's answer, checked whole; `requested` is the window asked for. */
export function parseAmazonTaxonomySpending(raw: unknown, requested: AmazonSpendingWindow): AmazonTaxonomySpending {
  if (!isRecord(raw) || raw.measure !== AMAZON_SPENDING_MEASURE) throw new AmazonAnswerError('measure');
  const window = raw.window;
  if (!isRecord(window) || window.key !== requested || !isDay(window.from) || !isDay(window.to) || window.from > window.to) {
    throw new AmazonAnswerError('window');
  }
  const taxonomy = raw.taxonomy;
  if (!isRecord(taxonomy) || taxonomy.version !== AMAZON_ITEM_TAXONOMY_VERSION
    || (taxonomy.assignments !== 'present' && taxonomy.assignments !== 'absent')) throw new AmazonAnswerError('taxonomy');
  const orders = counts(raw.orders, ['count', 'refunded'], 'orders');
  if (orders.refunded > orders.count) throw new AmazonAnswerError('orders');
  const lines = counts(raw.lines, ['count', 'priced', 'noPrice', 'noQuantity', 'assigned', 'suggested', 'needsReview'], 'lines');
  if (lines.priced + lines.noPrice + lines.noQuantity !== lines.count || lines.assigned + lines.needsReview !== lines.priced
    || lines.suggested > lines.assigned) throw new AmazonAnswerError('lines');

  if (!Array.isArray(raw.totals) || raw.totals.length > 50) throw new AmazonAnswerError('totals');
  const totals = raw.totals.map((entry): AmazonTaxonomyTotals => {
    if (!isRecord(entry) || !isCurrency(entry.currency)) throw new AmazonAnswerError('totals');
    const amounts = counts(entry, ['itemMinor', 'assignedMinor', 'suggestedMinor', 'needsReviewMinor', 'refundMinor', 'itemRefundMinor',
      'unattributedRefundMinor', 'netItemMinor'], 'totals');
    if (amounts.assignedMinor + amounts.needsReviewMinor !== amounts.itemMinor || amounts.suggestedMinor > amounts.assignedMinor
      || amounts.itemRefundMinor + amounts.unattributedRefundMinor > amounts.itemMinor
      || amounts.netItemMinor !== amounts.itemMinor - amounts.itemRefundMinor - amounts.unattributedRefundMinor) {
      throw new AmazonAnswerError('totals');
    }
    return { currency: entry.currency, ...amounts };
  });
  if (new Set(totals.map((entry) => entry.currency)).size !== totals.length) throw new AmazonAnswerError('totals');

  if (!Array.isArray(raw.nodes) || raw.nodes.length > 10_000) throw new AmazonAnswerError('nodes');
  const nodes = raw.nodes.map((entry): AmazonTaxonomyNodeTotal => {
    if (!isRecord(entry) || !isAmazonTaxonomyNode(entry.node) || !totals.some((total) => total.currency === entry.currency)) {
      throw new AmazonAnswerError('nodes');
    }
    const values = counts(entry, ['amountMinor', 'refundMinor', 'netMinor', 'lines', 'refundedLines', 'products', 'orders', 'refundedOrders'], 'nodes');
    if (values.lines < 1 || values.products < 1 || values.orders < 1 || values.products > values.lines || values.orders > values.lines
      || values.refundedOrders > values.orders || values.refundedLines > values.lines || values.refundMinor > values.amountMinor
      || values.netMinor !== values.amountMinor - values.refundMinor) throw new AmazonAnswerError('nodes');
    return { currency: entry.currency as string, node: entry.node, ...values };
  });
  const key = (currency: string, node: string) => JSON.stringify([currency, node]);
  const byNode = new Map(nodes.map((entry) => [key(entry.currency, entry.node), entry]));
  const tops = nodes.filter((entry) => amazonTaxonomyNode(entry.node)!.parent === null);
  if (byNode.size !== nodes.length
    // Each currency's top levels add up to its item prices and their refunds, and no top level holds less than its subcategories.
    || totals.some((total) => sum(tops.filter((entry) => entry.currency === total.currency).map((entry) => entry.amountMinor)) !== total.itemMinor
      || sum(tops.filter((entry) => entry.currency === total.currency).map((entry) => entry.refundMinor)) !== total.itemRefundMinor
      || (byNode.get(key(total.currency, 'needs-review'))?.amountMinor ?? 0) !== total.needsReviewMinor)
    || sum(tops.map((entry) => entry.lines)) !== lines.priced
    || nodes.some((entry) => {
      const parent = amazonTaxonomyNode(entry.node)!.parent;
      if (parent !== null) {
        const top = byNode.get(key(entry.currency, parent));
        return !top || top.amountMinor < entry.amountMinor || top.refundMinor < entry.refundMinor;
      }
      const children = nodes.filter((child) => child.currency === entry.currency && amazonTaxonomyNode(child.node)!.parent === entry.node);
      return sum(children.map((child) => child.amountMinor)) > entry.amountMinor || sum(children.map((child) => child.lines)) > entry.lines
        || sum(children.map((child) => child.refundMinor)) > entry.refundMinor;
    })) throw new AmazonAnswerError('nodes');

  if (!Array.isArray(raw.products) || raw.products.length > 10_000) throw new AmazonAnswerError('items');
  const refs = new Set<string>();
  const listed = new Map<string, { amountMinor: number; refundMinor: number }>();
  const products = raw.products.map((entry): AmazonTaxonomyProduct => {
    if (!isRecord(entry) || !isRef(entry.ref) || refs.has(entry.ref) || !isAmazonTaxonomyNode(entry.node) || !isCurrency(entry.currency)
      || !isDay(entry.lastOrderDate) || !isRef(entry.lastOrderRef) || typeof entry.suggested !== 'boolean'
      || (entry.source !== null && entry.source !== 'owner' && entry.source !== 'agent')
      || (entry.confidence !== null && !isConfidence(entry.confidence))
      || (entry.cardCategory !== null && (typeof entry.cardCategory !== 'string' || entry.cardCategory === '' || entry.cardCategory.length > 100))
      || !Array.isArray(entry.purchases) || entry.purchases.length < 1 || entry.purchases.length > 1000) throw new AmazonAnswerError('items');
    refs.add(entry.ref);
    const bucket = byNode.get(key(entry.currency, entry.node));
    const values = counts(entry, ['quantity', 'refundedQuantity', 'lines', 'orders', 'refundedOrders', 'amountMinor', 'refundMinor', 'netMinor'], 'items');
    const suggestion = entry.suggestion;
    if (suggestion !== null && (!isRecord(suggestion) || !isAmazonTaxonomyNode(suggestion.node) || !isConfidence(suggestion.confidence))) {
      throw new AmazonAnswerError('items');
    }
    const purchases = entry.purchases.map(purchase);
    // An Amazon Fresh product: its lines are its orders' Item List lines, never order items, so it has no card category and
    // no thumbnail, and every one of its purchases (and only its) says what its list showed.
    const fresh = entry.fresh === undefined ? undefined : readFreshMeasure(entry.fresh);
    if ((entry.fresh !== undefined && (!fresh || entry.cardCategory !== null || entry.cardCategorySource !== null || entry.image !== undefined
      || values.refundedQuantity > 0)) || purchases.some((p) => (p.fresh !== undefined) !== (fresh !== undefined))
      || (fresh && purchases.length === values.lines && !freshMeasureFits(fresh, purchases.map((p) => p.fresh!)))) {
      throw new AmazonAnswerError('items');
    }
    const shown = listed.get(key(entry.currency, entry.node)) ?? { amountMinor: 0, refundMinor: 0 };
    shown.amountMinor += values.amountMinor;
    shown.refundMinor += values.refundMinor;
    listed.set(key(entry.currency, entry.node), shown);
    const whole = purchases.length === values.lines;
    if (!bucket || shown.amountMinor > bucket.amountMinor || shown.refundMinor > bucket.refundMinor || values.lines < purchases.length
      || values.orders > values.lines || values.refundedOrders > values.orders || values.quantity < values.lines
      || values.refundedQuantity > values.quantity || values.refundMinor > values.amountMinor
      || values.netMinor !== values.amountMinor - values.refundMinor
      || (whole && (sum(purchases.map((p) => p.amountMinor)) !== values.amountMinor || sum(purchases.map((p) => p.refundMinor)) !== values.refundMinor))
      // Only Needs review holds items nobody filed; only an agent's filing can be suggested, and only an unfiled item
      // carries the agent's suggestion.
      || (entry.source === null && entry.node !== 'needs-review')
      || (entry.suggested && (entry.source !== 'agent' || entry.node === 'needs-review'))
      || (suggestion !== null && entry.source !== null)) throw new AmazonAnswerError('items');
    return {
      ref: entry.ref,
      currency: entry.currency,
      title: typeof entry.title === 'string' && entry.title.trim() !== '' && entry.title !== HIDDEN_TITLE ? entry.title : null,
      asin: typeof entry.asin === 'string' && /^[A-Z0-9]{10}$/.test(entry.asin) ? entry.asin : null,
      node: entry.node,
      source: entry.source as AmazonTaxonomySource | null,
      confidence: entry.confidence as number | null,
      suggested: entry.suggested,
      suggestion: suggestion === null ? null : { node: suggestion.node as AmazonTaxonomyNodeId, confidence: suggestion.confidence as number },
      cardCategory: entry.cardCategory as string | null,
      cardCategorySource: entry.cardCategory !== null && CARD_SOURCES.includes(entry.cardCategorySource as AmazonCategorySource)
        ? entry.cardCategorySource as AmazonCategorySource : null,
      ...values,
      lastOrderDate: entry.lastOrderDate,
      lastOrderRef: entry.lastOrderRef,
      purchases,
      ...(entry.image === true ? { image: true as const } : {}),
      ...(fresh ? { fresh } : {}),
    };
  });
  // Amazon Fresh orders' lines: said only when the window holds one, and never more than the window's own figures.
  const freshPart = raw.fresh === undefined ? undefined : readFreshPart(raw.fresh);
  if ((raw.fresh !== undefined && (!freshPart || !freshPartFits(freshPart, { orders: orders.count, priced: lines.priced, totals })))
    || !freshProductsFit(freshPart, products)) throw new AmazonAnswerError('fresh');
  return {
    window: { key: requested, from: window.from, to: window.to },
    assignments: taxonomy.assignments,
    orders, lines, totals, nodes, products,
    ...(freshPart ? { fresh: freshPart } : {}),
  };
}

/** The window ending `today` (the viewer's calendar date, YYYY-MM-DD). */
export function fetchAmazonTaxonomySpending(window: AmazonSpendingWindow, today: string): Promise<AmazonTaxonomySpending> {
  return api<unknown>(`/amazon/spending/taxonomy?${new URLSearchParams({ window, today })}`)
    .then((body) => parseAmazonTaxonomySpending(body, window));
}
