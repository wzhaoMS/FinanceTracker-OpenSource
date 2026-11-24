import {
  AMAZON_ITEM_TAXONOMY_VERSION,
  AMAZON_TAXONOMY_GROCERIES,
  AMAZON_TAXONOMY_NEEDS_REVIEW,
  amazonTaxonomyNode,
  amazonTaxonomyTop,
  isAmazonTaxonomyNode,
  type AmazonTaxonomyNodeId,
  type AmazonTaxonomySource,
} from '@finance-tracker/shared';

import { api } from '../../services/api';
import { AMAZON_ORDER_REF } from '../../modes/route';
import {
  AMAZON_REFUND_BASES,
  AmazonAnswerError,
  readPurchaseChannel,
  type AmazonMoney,
  type AmazonPurchaseChannel,
  type AmazonRefundBasis,
  type AmazonSpendingWindow,
} from './amazonApi';

/**
 * Amazon Fresh (GET /amazon/fresh and GET /amazon/fresh/orders/:ref): the household's Fresh orders over a window, what
 * their lines cost by grocery subcategory and by product, and each order's Item List. Amazon's own measure by order
 * date, never card spending. Read-only, and checked whole before anything is shown: a malformed field, a node the item
 * taxonomy doesn't have, or figures that don't add up refuse the answer, so a figure never reads as more than the API
 * said.
 */
export const AMAZON_FRESH_MEASURE = 'amazon-fresh-item-prices-not-card-spending';

/** Where a line counts: a Groceries subcategory (or Groceries itself), another top level as a whole, or Needs review. */
export type FreshGroup = 'groceries' | 'other' | 'needs-review';
export type FreshStatus = 'listed' | 'substituted' | 'missing';
export interface FreshWeight { value: string; unit: 'lb'; basis: 'actual' | 'estimated' | 'unlabeled' }
export interface FreshUnitPrice { money: AmazonMoney; per: 'each' | 'lb' }
export interface FreshCategoryFields {
  /** The breakdown row it counts in. */
  category: AmazonTaxonomyNodeId;
  group: FreshGroup;
  /** Where the item taxonomy files it: the category, or below it for another top level. */
  node: AmazonTaxonomyNodeId;
  source: AmazonTaxonomySource | null;
  confidence: number | null;
  suggested: boolean;
  suggestion: { node: AmazonTaxonomyNodeId; confidence: number } | null;
}
export interface AmazonFreshTotals {
  currency: string;
  orderTotalMinor: number;
  lineMinor: number;
  groceryMinor: number;
  categorizedMinor: number;
  suggestedMinor: number;
  needsReviewMinor: number;
  refundMinor: number;
  lineRefundMinor: number;
  unattributedRefundMinor: number;
  netLineMinor: number;
}
export interface AmazonFreshCategory {
  currency: string;
  category: AmazonTaxonomyNodeId;
  group: FreshGroup;
  amountMinor: number;
  refundMinor: number;
  netMinor: number;
  lines: number;
  refundedLines: number;
  products: number;
  orders: number;
}
export interface AmazonFreshPurchase {
  ref: string;
  orderRef: string;
  orderDate: string;
  status: Exclude<FreshStatus, 'missing'>;
  quantity: number | null;
  weight: FreshWeight | null;
  unitPrice: FreshUnitPrice | null;
  amountMinor: number;
  refundMinor: number;
}
export interface AmazonFreshProduct extends FreshCategoryFields {
  ref: string;
  currency: string;
  /** null: the card-data guard hid every title it had. */
  title: string | null;
  asin: string | null;
  amountMinor: number;
  refundMinor: number;
  netMinor: number;
  lines: number;
  orders: number;
  quantity: number | null;
  weight: { value: string; unit: 'lb'; estimated: boolean } | null;
  lastUnitPrice: FreshUnitPrice | null;
  lastOrderDate: string;
  lastOrderRef: string;
  /** Latest first; the API may list fewer than `lines`. */
  purchases: AmazonFreshPurchase[];
}
export interface FreshOrderRefund {
  currency: string;
  refundMinor: number;
  basis: AmazonRefundBasis;
  lineRefundMinor: number;
  unattributedMinor: number;
}
export interface AmazonFreshOrderSummary {
  ref: string;
  date: string;
  total: AmazonMoney | null;
  lines: number;
  priced: number;
  missing: number;
  substituted: number;
  unreadable: number;
  unreadRows: number | null;
  lineTotal: AmazonMoney | null;
  complete: boolean;
  reconciled: boolean;
  refund: FreshOrderRefund | null;
  /** Set only for a receipt from a Whole Foods store, its items read like a Fresh list's; absent for an Amazon Fresh order. */
  purchaseChannel?: AmazonPurchaseChannel;
}
export interface AmazonFresh {
  window: { key: AmazonSpendingWindow; from: string; to: string };
  /** Whether any Fresh Item List was ever imported. */
  captured: boolean;
  /** Whether any item taxonomy classification was ever imported. */
  assignments: 'present' | 'absent';
  orders: { count: number; withTotal: number; complete: number; reconciled: number; refunded: number; unreadable: number; noLines: number };
  lines: {
    count: number; priced: number; noPrice: number; missing: number; substituted: number; estimated: number;
    categorized: number; suggested: number; needsReview: number; refunded: number; unreadable: number;
  };
  totals: AmazonFreshTotals[];
  categories: AmazonFreshCategory[];
  products: AmazonFreshProduct[];
  orderList: AmazonFreshOrderSummary[];
}
export interface AmazonFreshLine extends FreshCategoryFields {
  ref: string;
  lineOrdinal: number;
  /** null: the card-data guard hid it. */
  title: string | null;
  asin: string | null;
  status: FreshStatus;
  quantity: number | null;
  weight: FreshWeight | null;
  unitPrice: FreshUnitPrice | null;
  /** The line's price; null only for a missing line, whose listed price (when the list shows one) is never charged. */
  linePrice: AmazonMoney | null;
  /** A substitute's original item, when the page named it. */
  replaces: string | null;
  refundMinor: number;
}
export interface AmazonFreshOrder {
  ref: string;
  date: string;
  total: AmazonMoney | null;
  refund: FreshOrderRefund | null;
  list: { statedCount: number | null; rows: number | null; unreadRows: number | null; lines: number; unreadable: number;
    complete: boolean; reconciled: boolean };
  lines: AmazonFreshLine[];
  /** Set only for a receipt from a Whole Foods store; absent for an Amazon Fresh order. */
  purchaseChannel?: AmazonPurchaseChannel;
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
const isCurrency = (value: unknown): value is string => typeof value === 'string' && /^[A-Z]{3}$/.test(value);
const isRef = (value: unknown): value is string => typeof value === 'string' && AMAZON_ORDER_REF.test(value);
const isConfidence = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
/** A line's weight as an Item List shows it (freshSchema.ts `freshWeight`): positive, at most six digits either side. */
const isLineWeight = (value: unknown): value is string => typeof value === 'string'
  && /^(?:0|[1-9]\d{0,5})(?:\.\d{1,6})?$/.test(value) && /[1-9]/.test(value);
/** A product's weights added up: positive, exact to the millionth of a pound. */
const isWeightSum = (value: unknown): value is string => typeof value === 'string'
  && /^(?:0|[1-9]\d{0,14})(?:\.\d{1,6})?$/.test(value) && /[1-9]/.test(value);
/** Exact pounds as millionths, so weights add and compare without float error. */
function micro(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}
/** The Item List contract's bounds (freshSchema.ts): a line's price or unit price, its count, the stated count, a list's rows. */
const MAX_LINE_MINOR = 100_000_000;
const MAX_QUANTITY = 999;
const MAX_STATED_COUNT = 999;
const MAX_LIST_ROWS = 200;
const HIDDEN_TITLE = '[redacted]';
const GROUPS: readonly FreshGroup[] = ['groceries', 'other', 'needs-review'];
/** Refund bases that tie all of a refund to lines, leaving none of it over. */
const FULLY_TIED: ReadonlySet<AmazonRefundBasis> = new Set<AmazonRefundBasis>(['whole-order', 'item-records', 'units', 'only-line']);
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const key = (currency: string, category: string) => JSON.stringify([currency, category]);
/** Whether two parsed values (built here, so their keys are in one order) are the same. */
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Each entry after the first comes after the one before it. */
const ordered = <T>(list: readonly T[], before: (a: T, b: T) => boolean) => list.every((entry, n) => n === 0 || before(list[n - 1], entry));

function counts<K extends string>(raw: unknown, keys: readonly K[], what: string): Record<K, number> {
  if (!isRecord(raw)) throw new AmazonAnswerError(what);
  const parsed = {} as Record<K, number>;
  for (const name of keys) {
    if (!isCount(raw[name])) throw new AmazonAnswerError(what);
    parsed[name] = raw[name] as number;
  }
  return parsed;
}
function money(raw: unknown, what: string): AmazonMoney {
  if (!isRecord(raw) || !isCurrency(raw.currency) || !isCount(raw.amountMinor)) throw new AmazonAnswerError(what);
  return { currency: raw.currency, amountMinor: raw.amountMinor };
}
const nullableMoney = (raw: unknown, what: string): AmazonMoney | null => (raw === null ? null : money(raw, what));
/** A line's price or unit price: at most what the Item List contract admits. */
function lineMoney(raw: unknown, what: string): AmazonMoney {
  const parsed = money(raw, what);
  if (parsed.amountMinor > MAX_LINE_MINOR) throw new AmazonAnswerError(what);
  return parsed;
}
function unitPriceOf(raw: unknown, what: string): FreshUnitPrice | null {
  if (raw === null) return null;
  if (!isRecord(raw) || (raw.per !== 'each' && raw.per !== 'lb')) throw new AmazonAnswerError(what);
  return { money: lineMoney(raw.money, what), per: raw.per };
}
interface LineMeasure { quantity: number | null; weight: FreshWeight | null; unitPrice: FreshUnitPrice | null }
/**
 * What a line showed of its count, weight and unit price, as the Item List contract admits them (freshSchema.ts
 * `freshLineRecord`): a count of 1 to 999, a positive weight in pounds, and a per-pound price only beside a weight.
 */
function lineMeasure(raw: Json, what: string): LineMeasure {
  const { quantity, weight } = raw;
  if (quantity !== null && (!isCount(quantity) || quantity < 1 || quantity > MAX_QUANTITY)) throw new AmazonAnswerError(what);
  let shown: FreshWeight | null = null;
  if (weight !== null) {
    if (!isRecord(weight) || !isLineWeight(weight.value) || weight.unit !== 'lb'
      || (weight.basis !== 'actual' && weight.basis !== 'estimated' && weight.basis !== 'unlabeled')) throw new AmazonAnswerError(what);
    shown = { value: weight.value, unit: 'lb', basis: weight.basis };
  }
  const unitPrice = unitPriceOf(raw.unitPrice, what);
  if (unitPrice?.per === 'lb' && shown === null) throw new AmazonAnswerError(what);
  return { quantity: quantity as number | null, weight: shown, unitPrice };
}
const title = (raw: unknown): string | null => (typeof raw === 'string' && raw.trim() !== '' && raw !== HIDDEN_TITLE ? raw : null);

/**
 * Where a line counts, checked against the taxonomy: a Groceries line's category is its node, another top level's line
 * counts under that top level, and only Needs review holds what nobody filed; only an agent's filing can be suggested,
 * and only an unfiled line carries the agent's suggestion.
 */
function categoryFields(raw: Json, what: string): FreshCategoryFields {
  const { category, group, node, source, confidence, suggested, suggestion } = raw;
  if (!isAmazonTaxonomyNode(category) || !isAmazonTaxonomyNode(node) || !GROUPS.includes(group as FreshGroup)
    || (source !== null && source !== 'owner' && source !== 'agent') || (confidence !== null && !isConfidence(confidence))
    || typeof suggested !== 'boolean') throw new AmazonAnswerError(what);
  const top = amazonTaxonomyTop(node);
  const filed = group === 'needs-review' ? category === AMAZON_TAXONOMY_NEEDS_REVIEW && node === AMAZON_TAXONOMY_NEEDS_REVIEW
    : group === 'groceries' ? top === AMAZON_TAXONOMY_GROCERIES && category === node
      : top !== AMAZON_TAXONOMY_GROCERIES && top !== AMAZON_TAXONOMY_NEEDS_REVIEW && category === top;
  if (!filed || (source === null && group !== 'needs-review') || (suggested && (source !== 'agent' || group === 'needs-review'))) {
    throw new AmazonAnswerError(what);
  }
  if (suggestion !== null && (!isRecord(suggestion) || !isAmazonTaxonomyNode(suggestion.node) || !isConfidence(suggestion.confidence)
    || source !== null)) throw new AmazonAnswerError(what);
  return { category, group: group as FreshGroup, node, source: source as AmazonTaxonomySource | null, confidence: confidence as number | null,
    suggested, suggestion: suggestion === null ? null : { node: suggestion.node as AmazonTaxonomyNodeId, confidence: suggestion.confidence as number } };
}
/** An order's counted refund: a refund tied to no line takes nothing off one, and one tied whole to lines leaves nothing over. */
function refund(raw: unknown, what: string): FreshOrderRefund | null {
  if (raw === null) return null;
  if (!isRecord(raw) || !isCurrency(raw.currency) || !AMAZON_REFUND_BASES.includes(raw.basis as AmazonRefundBasis)) throw new AmazonAnswerError(what);
  const values = counts(raw, ['refundMinor', 'lineRefundMinor', 'unattributedMinor'], what);
  const basis = raw.basis as AmazonRefundBasis;
  if (values.refundMinor < 1 || (basis === 'unattributed' && values.lineRefundMinor > 0)
    || (FULLY_TIED.has(basis) && values.unattributedMinor > 0)) throw new AmazonAnswerError(what);
  return { currency: raw.currency, basis, ...values };
}
/**
 * Whether an order's refund fits what its delivered lines cost in the refund's currency (`refundable`, null when the
 * answer doesn't say): what comes off lines and what doesn't together never come to more, and a whole-order refund takes
 * every one of them in full.
 */
const refundFits = (paid: FreshOrderRefund, refundable: number | null) => refundable === null
  || (paid.lineRefundMinor + paid.unattributedMinor <= refundable && (paid.basis !== 'whole-order' || paid.lineRefundMinor === refundable));
function purchase(raw: unknown): AmazonFreshPurchase {
  if (!isRecord(raw) || !isRef(raw.ref) || !isRef(raw.orderRef) || !isDay(raw.orderDate)
    || (raw.status !== 'listed' && raw.status !== 'substituted')) throw new AmazonAnswerError('items');
  const values = counts(raw, ['amountMinor', 'refundMinor'], 'items');
  if (values.amountMinor > MAX_LINE_MINOR || values.refundMinor > values.amountMinor) throw new AmazonAnswerError('items');
  return { ref: raw.ref, orderRef: raw.orderRef, orderDate: raw.orderDate, status: raw.status, ...lineMeasure(raw, 'items'), ...values };
}
/** Purchases latest first: by order date, then order, then line, as the API lists them. */
const purchaseBefore = (a: AmazonFreshPurchase, b: AmazonFreshPurchase) => a.orderDate > b.orderDate
  || (a.orderDate === b.orderDate && (a.orderRef > b.orderRef || (a.orderRef === b.orderRef && a.ref > b.ref)));
/** Products largest after refunds first, then before refunds, then latest, then by ref. */
const productBefore = (a: AmazonFreshProduct, b: AmazonFreshProduct) => a.netMinor > b.netMinor
  || (a.netMinor === b.netMinor && (a.amountMinor > b.amountMinor || (a.amountMinor === b.amountMinor
    && (a.lastOrderDate > b.lastOrderDate || (a.lastOrderDate === b.lastOrderDate && a.ref < b.ref)))));
/** Orders newest first, then by ref. */
const orderBefore = (a: AmazonFreshOrderSummary, b: AmazonFreshOrderSummary) => a.date > b.date || (a.date === b.date && a.ref < b.ref);
interface Listed { products: number; lines: number; amountMinor: number; refundMinor: number; refundedLines: number; orders: Set<string> }
const noneListed = (): Listed => ({ products: 0, lines: 0, amountMinor: 0, refundMinor: 0, refundedLines: 0, orders: new Set<string>() });

/**
 * A window's answer, checked whole; `requested` is the window asked for. Every figure is checked against every other that
 * says the same thing: the totals against their categories, the categories against the items they list, each item
 * against its purchases, the window's counts and totals against its orders (exactly, when it lists every order; at least,
 * when it lists fewer), and its orders against their items' purchases. Anything that doesn't add up refuses the answer.
 */
export function parseAmazonFresh(raw: unknown, requested: AmazonSpendingWindow): AmazonFresh {
  if (!isRecord(raw) || raw.measure !== AMAZON_FRESH_MEASURE) throw new AmazonAnswerError('measure');
  const window = raw.window;
  if (!isRecord(window) || window.key !== requested || !isDay(window.from) || !isDay(window.to) || window.from > window.to) {
    throw new AmazonAnswerError('window');
  }
  const from = window.from, to = window.to;
  const inWindow = (date: string) => date >= from && date <= to;
  const taxonomy = raw.taxonomy;
  if (typeof raw.captured !== 'boolean' || !isRecord(taxonomy) || taxonomy.version !== AMAZON_ITEM_TAXONOMY_VERSION
    || (taxonomy.assignments !== 'present' && taxonomy.assignments !== 'absent')) throw new AmazonAnswerError('taxonomy');
  const assignments: 'present' | 'absent' = taxonomy.assignments;
  const orders = counts(raw.orders, ['count', 'withTotal', 'complete', 'reconciled', 'refunded', 'unreadable', 'noLines'], 'orders');
  if (orders.withTotal > orders.count || orders.complete > orders.count || orders.reconciled > orders.complete
    || orders.refunded > orders.count || orders.unreadable > orders.count || orders.noLines > orders.count
    || (!raw.captured && orders.count > 0)) throw new AmazonAnswerError('orders');
  const lines = counts(raw.lines, ['count', 'priced', 'noPrice', 'missing', 'substituted', 'estimated', 'categorized', 'suggested',
    'needsReview', 'refunded', 'unreadable'], 'lines');
  if (lines.priced + lines.noPrice + lines.missing !== lines.count || lines.substituted > lines.priced + lines.noPrice
    || lines.estimated > lines.priced || lines.categorized + lines.needsReview !== lines.priced || lines.suggested > lines.categorized
    || lines.refunded > lines.priced) throw new AmazonAnswerError('lines');

  if (!Array.isArray(raw.totals) || raw.totals.length > 50) throw new AmazonAnswerError('totals');
  const totals = raw.totals.map((entry): AmazonFreshTotals => {
    if (!isRecord(entry) || !isCurrency(entry.currency)) throw new AmazonAnswerError('totals');
    const amounts = counts(entry, ['orderTotalMinor', 'lineMinor', 'groceryMinor', 'categorizedMinor', 'suggestedMinor', 'needsReviewMinor',
      'refundMinor', 'lineRefundMinor', 'unattributedRefundMinor', 'netLineMinor'], 'totals');
    if (amounts.categorizedMinor + amounts.needsReviewMinor !== amounts.lineMinor || amounts.groceryMinor > amounts.categorizedMinor
      || amounts.suggestedMinor > amounts.categorizedMinor || amounts.lineRefundMinor + amounts.unattributedRefundMinor > amounts.lineMinor
      || amounts.netLineMinor !== amounts.lineMinor - amounts.lineRefundMinor - amounts.unattributedRefundMinor) {
      throw new AmazonAnswerError('totals');
    }
    return { currency: entry.currency, ...amounts };
  });
  if (new Set(totals.map((entry) => entry.currency)).size !== totals.length) throw new AmazonAnswerError('totals');

  if (!Array.isArray(raw.categories) || raw.categories.length > 10_000) throw new AmazonAnswerError('categories');
  const categories = raw.categories.map((entry): AmazonFreshCategory => {
    if (!isRecord(entry) || !totals.some((total) => total.currency === entry.currency) || !isAmazonTaxonomyNode(entry.category)
      || !GROUPS.includes(entry.group as FreshGroup)) throw new AmazonAnswerError('categories');
    const top = amazonTaxonomyTop(entry.category);
    const fits = entry.group === 'needs-review' ? entry.category === AMAZON_TAXONOMY_NEEDS_REVIEW
      : entry.group === 'groceries' ? top === AMAZON_TAXONOMY_GROCERIES
        : amazonTaxonomyNode(entry.category)?.parent === null && top !== AMAZON_TAXONOMY_GROCERIES && top !== AMAZON_TAXONOMY_NEEDS_REVIEW;
    const values = counts(entry, ['amountMinor', 'refundMinor', 'netMinor', 'lines', 'refundedLines', 'products', 'orders'], 'categories');
    if (!fits || values.lines < 1 || values.products < 1 || values.orders < 1 || values.products > values.lines
      || values.orders > values.lines || values.orders > orders.count || values.refundedLines > values.lines
      || values.refundMinor > values.amountMinor || values.netMinor !== values.amountMinor - values.refundMinor) {
      throw new AmazonAnswerError('categories');
    }
    return { currency: entry.currency as string, category: entry.category, group: entry.group as FreshGroup, ...values };
  });
  const byCategory = new Map(categories.map((entry) => [key(entry.currency, entry.category), entry]));
  const inCurrency = (currency: string, where: (entry: AmazonFreshCategory) => boolean = () => true) =>
    categories.filter((entry) => entry.currency === currency && where(entry));
  if (byCategory.size !== categories.length || sum(categories.map((entry) => entry.lines)) !== lines.priced
    || sum(categories.filter((entry) => entry.group === 'needs-review').map((entry) => entry.lines)) !== lines.needsReview
    || sum(categories.map((entry) => entry.refundedLines)) !== lines.refunded
    // Each currency's rows add up to its line prices, their refunds, its groceries and what needs review.
    || totals.some((total) => sum(inCurrency(total.currency).map((entry) => entry.amountMinor)) !== total.lineMinor
      || sum(inCurrency(total.currency).map((entry) => entry.refundMinor)) !== total.lineRefundMinor
      || sum(inCurrency(total.currency, (entry) => entry.group === 'groceries').map((entry) => entry.amountMinor)) !== total.groceryMinor
      || sum(inCurrency(total.currency, (entry) => entry.group === 'needs-review').map((entry) => entry.amountMinor)) !== total.needsReviewMinor)) {
    throw new AmazonAnswerError('categories');
  }

  if (!Array.isArray(raw.orderList) || raw.orderList.length > orders.count) throw new AmazonAnswerError('order list');
  const orderList = raw.orderList.map((entry): AmazonFreshOrderSummary => {
    if (!isRecord(entry) || !isRef(entry.ref) || !isDay(entry.date) || !inWindow(entry.date) || typeof entry.complete !== 'boolean'
      || typeof entry.reconciled !== 'boolean'
      || (entry.unreadRows !== null && (!isCount(entry.unreadRows) || entry.unreadRows > MAX_LIST_ROWS))) throw new AmazonAnswerError('order list');
    const values = counts(entry, ['lines', 'priced', 'missing', 'substituted', 'unreadable'], 'order list');
    const lineTotal = nullableMoney(entry.lineTotal, 'order list');
    const paid = refund(entry.refund, 'order list');
    // What its delivered lines cost in its refund's currency, when the answer says: none priced, or all in one currency.
    const refundable = paid === null ? null : values.priced === 0 ? 0
      : lineTotal === null ? null : lineTotal.currency === paid.currency ? lineTotal.amountMinor : 0;
    if (values.priced + values.missing > values.lines || values.substituted > values.priced
      || values.lines + values.unreadable > MAX_LIST_ROWS || (lineTotal !== null && values.priced === 0)
      // A complete list: every row read and stored, every delivered line priced; a reconciled one adds up in one currency.
      || (entry.complete && (entry.unreadRows !== 0 || values.unreadable > 0 || values.lines === 0
        || values.priced + values.missing !== values.lines))
      || (entry.reconciled && (!entry.complete || values.priced === 0 || lineTotal === null))
      || (paid !== null && !refundFits(paid, refundable))) throw new AmazonAnswerError('order list');
    const channel = readPurchaseChannel(entry.purchaseChannel);
    return { ref: entry.ref, date: entry.date, total: nullableMoney(entry.total, 'order list'), ...values,
      unreadRows: entry.unreadRows as number | null, lineTotal, complete: entry.complete, reconciled: entry.reconciled, refund: paid,
      ...(channel ? { purchaseChannel: channel } : {}) };
  });
  const byOrder = new Map(orderList.map((entry) => [entry.ref, entry]));
  if (byOrder.size !== orderList.length || !ordered(orderList, orderBefore)) throw new AmazonAnswerError('order list');
  // Every order listed: the window's counts and totals are exactly its orders'. Fewer listed (the newest): at most them.
  const everyOrder = orderList.length === orders.count;
  const fits = (listed: number, all: number, exact = everyOrder) => (exact ? listed === all : listed <= all);
  const listedOrders = (test: (entry: AmazonFreshOrderSummary) => boolean) => orderList.filter(test).length;
  const listedLines = (field: 'lines' | 'priced' | 'missing' | 'substituted' | 'unreadable') => sum(orderList.map((entry) => entry[field]));
  if (!fits(listedOrders((entry) => entry.total !== null), orders.withTotal) || !fits(listedOrders((entry) => entry.complete), orders.complete)
    || !fits(listedOrders((entry) => entry.reconciled), orders.reconciled)
    || !fits(listedOrders((entry) => entry.refund !== null), orders.refunded)
    || !fits(listedOrders((entry) => entry.unreadRows === null), orders.unreadable)
    || !fits(listedOrders((entry) => entry.lines === 0), orders.noLines)
    || !fits(listedLines('lines'), lines.count) || !fits(listedLines('priced'), lines.priced)
    || !fits(listedLines('missing'), lines.missing) || !fits(listedLines('substituted'), lines.substituted)
    || !fits(listedLines('unreadable'), lines.unreadable)) throw new AmazonAnswerError('order list');
  // Per currency: the orders' totals, their item prices (exactly, when each order with priced lines says its own) and refunds.
  const listedMoney = new Map<string, { order: number; line: number; refund: number; lineRefund: number; unattributed: number }>();
  const moneyIn = (currency: string) => {
    if (!totals.some((total) => total.currency === currency)) throw new AmazonAnswerError('order list');
    const entry = listedMoney.get(currency) ?? { order: 0, line: 0, refund: 0, lineRefund: 0, unattributed: 0 };
    listedMoney.set(currency, entry);
    return entry;
  };
  for (const entry of orderList) {
    if (entry.total) moneyIn(entry.total.currency).order += entry.total.amountMinor;
    if (entry.lineTotal) moneyIn(entry.lineTotal.currency).line += entry.lineTotal.amountMinor;
    if (entry.refund) {
      const paid = moneyIn(entry.refund.currency);
      paid.refund += entry.refund.refundMinor;
      paid.lineRefund += entry.refund.lineRefundMinor;
      paid.unattributed += entry.refund.unattributedMinor;
    }
  }
  const linesKnown = orderList.every((entry) => entry.priced === 0 || entry.lineTotal !== null);
  if (totals.some((total) => {
    const listed = listedMoney.get(total.currency) ?? { order: 0, line: 0, refund: 0, lineRefund: 0, unattributed: 0 };
    return !fits(listed.order, total.orderTotalMinor) || !fits(listed.line, total.lineMinor, everyOrder && linesKnown)
      || !fits(listed.refund, total.refundMinor) || !fits(listed.lineRefund, total.lineRefundMinor)
      || !fits(listed.unattributed, total.unattributedRefundMinor);
  })) throw new AmazonAnswerError('order list');

  if (!Array.isArray(raw.products) || raw.products.length > 10_000) throw new AmazonAnswerError('items');
  const refs = new Set<string>(), lineRefs = new Set<string>();
  const listed = new Map<string, Listed>();
  const products = raw.products.map((entry): AmazonFreshProduct => {
    if (!isRecord(entry) || !isRef(entry.ref) || refs.has(entry.ref) || !isCurrency(entry.currency) || !isDay(entry.lastOrderDate)
      || !isRef(entry.lastOrderRef) || !Array.isArray(entry.purchases) || entry.purchases.length < 1 || entry.purchases.length > 1000
      || (entry.asin !== null && (typeof entry.asin !== 'string' || !/^[A-Z0-9]{10}$/.test(entry.asin)))
      || (entry.quantity !== null && (!isCount(entry.quantity) || entry.quantity < 1))
      || (entry.weight !== null && (!isRecord(entry.weight) || !isWeightSum(entry.weight.value) || entry.weight.unit !== 'lb'
        || typeof entry.weight.estimated !== 'boolean'))) throw new AmazonAnswerError('items');
    refs.add(entry.ref);
    const fields = categoryFields(entry, 'items');
    const values = counts(entry, ['amountMinor', 'refundMinor', 'netMinor', 'lines', 'orders'], 'items');
    const purchases = entry.purchases.map(purchase);
    const latest = purchases[0];
    const lastUnitPrice = unitPriceOf(entry.lastUnitPrice, 'items');
    const quantity = entry.quantity as number | null;
    const weight = entry.weight === null ? null
      : { value: (entry.weight as Json).value as string, unit: 'lb' as const, estimated: (entry.weight as Json).estimated as boolean };
    // What its listed purchases add up to: each line's price, refund, count and exact weight.
    const amountMinor = sum(purchases.map((p) => p.amountMinor)), refundMinor = sum(purchases.map((p) => p.refundMinor));
    const counted = purchases.filter((p) => p.quantity !== null), weighed = purchases.filter((p) => p.weight !== null);
    const quantities = sum(counted.map((p) => p.quantity!)), pounds = weighed.reduce((n, p) => n + micro(p.weight!.value), 0n);
    const estimated = weighed.some((p) => p.weight!.basis === 'estimated');
    const orderRefs = new Set(purchases.map((p) => p.orderRef));
    if (values.lines < purchases.length || values.orders > values.lines || values.orders < 1 || values.orders > orders.count
      || values.refundMinor > values.amountMinor || values.netMinor !== values.amountMinor - values.refundMinor
      // Its newest purchase is the one it names; its purchases come newest first, each line once, from the window's orders.
      || entry.ref !== latest.ref || entry.lastOrderRef !== latest.orderRef || entry.lastOrderDate !== latest.orderDate
      || !same(lastUnitPrice, latest.unitPrice) || !ordered(purchases, purchaseBefore) || new Set(purchases.map((p) => p.ref)).size !== purchases.length
      || purchases.some((p) => lineRefs.has(p.ref) || !inWindow(p.orderDate) || (everyOrder && byOrder.get(p.orderRef)?.date !== p.orderDate))
      // Every purchase listed: its figures are exactly theirs. Fewer listed (the latest): at least theirs.
      || (purchases.length === values.lines
        ? values.amountMinor !== amountMinor || values.refundMinor !== refundMinor || values.orders !== orderRefs.size
          || quantity !== (counted.length > 0 ? quantities : null) || (weight === null) !== (weighed.length === 0)
          || (weight !== null && (micro(weight.value) !== pounds || weight.estimated !== estimated))
        : values.amountMinor < amountMinor || values.refundMinor < refundMinor || values.orders < orderRefs.size
          || (counted.length > 0 && (quantity === null || quantity < quantities))
          || (weighed.length > 0 && (weight === null || micro(weight.value) < pounds)) || (estimated && weight?.estimated !== true))) {
      throw new AmazonAnswerError('items');
    }
    for (const p of purchases) lineRefs.add(p.ref);
    const bucket = byCategory.get(key(entry.currency, fields.category));
    if (!bucket || bucket.group !== fields.group) throw new AmazonAnswerError('items');
    const shown = listed.get(key(entry.currency, fields.category)) ?? noneListed();
    shown.products++;
    shown.lines += values.lines;
    shown.amountMinor += values.amountMinor;
    shown.refundMinor += values.refundMinor;
    shown.refundedLines += purchases.filter((p) => p.refundMinor > 0).length;
    for (const p of purchases) shown.orders.add(p.orderRef);
    listed.set(key(entry.currency, fields.category), shown);
    return {
      ref: entry.ref, currency: entry.currency, title: title(entry.title), asin: entry.asin as string | null, ...fields, ...values,
      quantity, weight, lastUnitPrice, lastOrderDate: entry.lastOrderDate, lastOrderRef: entry.lastOrderRef, purchases,
    };
  });
  // Every item listed (each is in one category): a category is exactly its items, and what is only suggested is exactly
  // theirs. Fewer listed (the largest): at most them. Every purchase listed too: its refunded lines and orders as well.
  const everyProduct = products.length === sum(categories.map((entry) => entry.products));
  const everyPurchase = everyProduct && products.every((product) => product.purchases.length === product.lines);
  const suggested = products.filter((product) => product.suggested);
  const estimatedLines = sum(products.map((product) => product.purchases.filter((p) => p.weight?.basis === 'estimated').length));
  if (!ordered(products, productBefore) || categories.some((bucket) => {
    const shown = listed.get(key(bucket.currency, bucket.category)) ?? noneListed();
    return !fits(shown.products, bucket.products, everyProduct) || !fits(shown.lines, bucket.lines, everyProduct)
      || !fits(shown.amountMinor, bucket.amountMinor, everyProduct) || !fits(shown.refundMinor, bucket.refundMinor, everyProduct)
      || !fits(shown.refundedLines, bucket.refundedLines, everyPurchase) || !fits(shown.orders.size, bucket.orders, everyPurchase);
  }) || !fits(sum(suggested.map((product) => product.lines)), lines.suggested, everyProduct)
    || totals.some((total) => !fits(sum(suggested.filter((product) => product.currency === total.currency).map((product) => product.amountMinor)),
      total.suggestedMinor, everyProduct))
    || !fits(estimatedLines, lines.estimated, everyPurchase)) throw new AmazonAnswerError('items');
  // Every order and every purchase listed: each order's priced lines are exactly its purchases, in its own currency.
  if (everyOrder && everyPurchase) {
    const bought = new Map<string, { lines: number; amountMinor: number; refundMinor: number; currencies: Set<string> }>();
    for (const product of products) {
      for (const p of product.purchases) {
        const entry = bought.get(p.orderRef) ?? { lines: 0, amountMinor: 0, refundMinor: 0, currencies: new Set<string>() };
        entry.lines++;
        entry.amountMinor += p.amountMinor;
        entry.refundMinor += p.refundMinor;
        entry.currencies.add(product.currency);
        bought.set(p.orderRef, entry);
      }
    }
    if (orderList.some((order) => {
      const entry = bought.get(order.ref) ?? { lines: 0, amountMinor: 0, refundMinor: 0, currencies: new Set<string>() };
      return entry.lines !== order.priced || entry.refundMinor !== (order.refund?.lineRefundMinor ?? 0)
        || (order.lineTotal !== null && (entry.amountMinor !== order.lineTotal.amountMinor
          || [...entry.currencies].some((currency) => currency !== order.lineTotal!.currency)));
    })) throw new AmazonAnswerError('items');
  }
  // Nothing to count before any Fresh list, or in a window without Fresh orders; nothing classified before any classification.
  if (orders.count === 0 && (totals.length > 0 || categories.length > 0 || products.length > 0)) throw new AmazonAnswerError('orders');
  if (assignments === 'absent' && (categories.some((entry) => entry.group !== 'needs-review')
    || products.some((product) => product.source !== null || product.suggestion !== null))) throw new AmazonAnswerError('taxonomy');

  return { window: { key: requested, from, to }, captured: raw.captured, assignments, orders, lines, totals, categories, products, orderList };
}

/**
 * One order's Item List, checked whole: its proof against its lines (a complete list has every row read and stored, with
 * any count the page stated matched), each line listed once in position order, and its refund against its lines (what
 * comes off lines is exactly what its lines show coming off, in the refund's currency, never more than they cost).
 */
export function parseAmazonFreshOrder(raw: unknown): AmazonFreshOrder {
  const body = isRecord(raw) ? raw.order : undefined;
  if (!isRecord(body) || !isRef(body.ref) || !isDay(body.date) || !isRecord(body.list) || !Array.isArray(body.lines)
    || body.lines.length > MAX_LIST_ROWS) throw new AmazonAnswerError('order');
  const list = body.list;
  const listCounts = counts(list, ['lines', 'unreadable'], 'order');
  const { statedCount, rows, unreadRows, complete, reconciled } = list;
  // A list record that can't be read says nothing of its rows; one that can has at least one, its unread rows among them.
  const rowsShown = rows === null ? unreadRows === null && statedCount === null
    : isCount(rows) && rows >= 1 && rows <= MAX_LIST_ROWS && isCount(unreadRows) && unreadRows <= rows
      && (statedCount === null || (isCount(statedCount) && statedCount <= MAX_STATED_COUNT));
  if (!rowsShown || typeof complete !== 'boolean' || typeof reconciled !== 'boolean' || listCounts.lines !== body.lines.length
    || listCounts.lines + listCounts.unreadable > MAX_LIST_ROWS) throw new AmazonAnswerError('order');
  const paid = refund(body.refund, 'order');
  const refs = new Set<string>();
  let previous = -1;
  const lines = body.lines.map((entry): AmazonFreshLine => {
    if (!isRecord(entry) || !isRef(entry.ref) || refs.has(entry.ref) || !isCount(entry.lineOrdinal) || entry.lineOrdinal <= previous
      || entry.lineOrdinal >= MAX_LIST_ROWS || (entry.status !== 'listed' && entry.status !== 'substituted' && entry.status !== 'missing')
      || (entry.asin !== null && (typeof entry.asin !== 'string' || !/^[A-Z0-9]{10}$/.test(entry.asin)))
      || (entry.replaces !== null && (typeof entry.replaces !== 'string' || entry.status !== 'substituted'))
      || !isCount(entry.refundMinor)) throw new AmazonAnswerError('order');
    refs.add(entry.ref);
    previous = entry.lineOrdinal;
    // Only a missing line may lack a price; a missing line's listed price is never charged, so never refunded. A line's
    // refund is in the order's refund's currency, and never more than its price.
    const linePrice = entry.linePrice === null ? null : lineMoney(entry.linePrice, 'order');
    if ((linePrice === null && entry.status !== 'missing') || entry.refundMinor > (linePrice?.amountMinor ?? 0)
      || (entry.refundMinor > 0 && (entry.status === 'missing' || paid === null || linePrice!.currency !== paid.currency))) {
      throw new AmazonAnswerError('order');
    }
    return { ref: entry.ref, lineOrdinal: entry.lineOrdinal, title: title(entry.title), asin: entry.asin as string | null,
      status: entry.status, ...lineMeasure(entry, 'order'), linePrice, replaces: title(entry.replaces), refundMinor: entry.refundMinor,
      ...categoryFields(entry, 'order') };
  });
  const delivered = lines.filter((line) => line.status !== 'missing');
  const refundable = paid === null ? 0
    : sum(delivered.filter((line) => line.linePrice!.currency === paid.currency).map((line) => line.linePrice!.amountMinor));
  if (sum(lines.map((line) => line.refundMinor)) !== (paid?.lineRefundMinor ?? 0) || (paid !== null && !refundFits(paid, refundable))
    || (complete && (unreadRows !== 0 || listCounts.unreadable > 0 || lines.length === 0 || lines.length !== rows
      || (statedCount !== null && statedCount !== rows)))
    || (reconciled && (!complete || delivered.length === 0 || new Set(delivered.map((line) => line.linePrice!.currency)).size !== 1))) {
    throw new AmazonAnswerError('order');
  }
  const channel = readPurchaseChannel(body.purchaseChannel);
  return { ref: body.ref, date: body.date, total: nullableMoney(body.total, 'order'), refund: paid,
    list: { statedCount: statedCount as number | null, rows: rows as number | null, unreadRows: unreadRows as number | null,
      ...listCounts, complete, reconciled }, lines, ...(channel ? { purchaseChannel: channel } : {}) };
}

/** The window ending `today` (the viewer's calendar date, YYYY-MM-DD). */
export function fetchAmazonFresh(window: AmazonSpendingWindow, today: string): Promise<AmazonFresh> {
  return api<unknown>(`/amazon/fresh?${new URLSearchParams({ window, today })}`).then((body) => parseAmazonFresh(body, window));
}
/** One Fresh order's Item List, by its opaque order ref. */
export function fetchAmazonFreshOrder(ref: string): Promise<AmazonFreshOrder> {
  return api<unknown>(`/amazon/fresh/orders/${encodeURIComponent(ref)}`).then(parseAmazonFreshOrder);
}
