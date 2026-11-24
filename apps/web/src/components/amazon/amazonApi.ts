import {
  AMAZON_SPENDING_WINDOWS,
  CARD_CATEGORY_EVIDENCE_CLASSES,
  type AmazonSpendingWindow,
  type CardCategoryEvidenceClass,
  type CardCategoryPartSource,
} from '@finance-tracker/shared';

import { api } from '../../services/api';
import { AMAZON_ORDER_REF } from '../../modes/route';
import {
  AMAZON_FRESH_CARD_SOURCES,
  freshPartFits,
  freshProductsFit,
  readFreshMeasure,
  readFreshPart,
  type AmazonFreshCardSource,
  type AmazonFreshMeasure,
  type AmazonFreshPart,
} from './amazonFreshItems';

export { AMAZON_SPENDING_WINDOWS, type AmazonSpendingWindow };

/**
 * Read-only calls for the Amazon area of Everyday: the owner-session `/amazon/*` read API, through the page's own
 * origin like every API call (services/api.ts). Nothing here writes.
 *
 * Amazon order activity is its own measure: order totals are not card charges, and nothing here is ever added to
 * Spending's figures. Every answer is checked before it is shown. A malformed required field fails the whole
 * answer. Each newer, optional list (matches, refunds, items, tenders) is taken whole or not at all: a list that
 * fails a check counts as "not reported", never as an empty list, so the view never claims "none" from a gap.
 */

export type AmazonBeneficiary = 'alex' | 'casey' | 'joint' | 'unknown';
export const AMAZON_BENEFICIARIES: readonly AmazonBeneficiary[] = ['alex', 'casey', 'joint', 'unknown'];

/** How a card charge was tied to the order: Spending's own classes, so its words (amazonEvidenceText) fit. */
export type AmazonEvidenceClass = CardCategoryEvidenceClass;
export type AmazonHeldReason = 'binding-held' | 'evidence-held' | 'no-candidate' | 'ambiguous' | 'multiple-orders';
/** Who chose an item's category: Spending's own part sources, so its words (amazonPartLabel) fit. */
export type AmazonCategorySource = CardCategoryPartSource;
/**
 * Who gave a spending item its category: an order item's owner or agent, or for an Amazon Fresh line, its item category
 * (the card category its item-taxonomy node corresponds to), or Groceries' as a default while it isn't classified.
 */
export type AmazonSpendingCategorySource = AmazonCategorySource | AmazonFreshCardSource;
export type AmazonTenderCoverage = 'single-card-proven' | 'multi-tender' | 'unknown';
export type AmazonRefundStatus = 'issued' | 'pending' | 'unknown';
export type AmazonRefundDestination = 'card' | 'balance' | 'points' | 'unknown';
export type AmazonMethodKind = 'card' | 'balance' | 'points' | 'unknown';
export type AmazonCardNetwork = 'visa' | 'mastercard' | 'amex' | 'discover' | 'unknown';
export type AmazonSummaryLineKind = 'items-subtotal' | 'shipping' | 'tax' | 'tip' | 'gift-card' | 'promotion' | 'rewards' | 'grand-total';
export type AmazonCoverageFamily = 'orders' | 'payments' | 'details' | 'refunds';

export interface AmazonMoney { currency: string; amountMinor: number }

/**
 * An order's reconciliation with the card ledger. A held match carries its fixed reason and how many card rows
 * were candidates, and nothing about them: candidates are never shown as linked facts.
 */
export type AmazonMatch =
  | { state: 'linked'; evidenceClass: AmazonEvidenceClass; cardTransactionId: string; cardAccountId: string }
  | { state: 'held'; evidenceClass: AmazonEvidenceClass; reason: AmazonHeldReason; candidateCount: number };

export interface AmazonRefund {
  ref: string;
  status: AmazonRefundStatus;
  date: string | null;
  /** Reported only for refunds the Amazon ledger shows as refunded; null otherwise. */
  amount: AmazonMoney | null;
  /** Where the money went, from explicit evidence only. */
  destination: AmazonRefundDestination;
}

export interface AmazonItem {
  ref: string;
  /** The full product name as observed, model included; null when the API hid it or it is missing. */
  title: string | null;
  asin: string | null;
  quantity: number | null;
  /** On an order's own page only; `undefined` in list rows. */
  unitPrice?: AmazonMoney | null;
  /** null: uncategorized; `undefined`: this API does not report categories. */
  category?: string | null;
  /** Who chose the category; null with a category means the API did not say. */
  categorySource: AmazonCategorySource | null;
  /** The agent's confidence (0–1), for agent categories only. */
  confidence: number | null;
  /** Only when Holdr's owner-only cache holds the item's product thumbnail (amazonItemImageHref). */
  image?: true;
}

export interface AmazonPaymentMethod { kind: AmazonMethodKind; network: AmazonCardNetwork; last4: string | null }
export interface AmazonSummaryLine { kind: AmazonSummaryLineKind; money: AmazonMoney }

/** Where an order was bought when it wasn't on Amazon itself: a Whole Foods Market store's receipt. A closed value. */
export type AmazonPurchaseChannel = 'whole-foods-in-store';

/** Only the value this view knows: null, absent or anything else is an ordinary Amazon order's, so it reads as not set. */
export function readPurchaseChannel(raw: unknown): AmazonPurchaseChannel | undefined {
  return raw === 'whole-foods-in-store' ? raw : undefined;
}

export interface AmazonOrder {
  ref: string;
  /** The Amazon order date (YYYY-MM-DD), not a card posting date. */
  date: string;
  total: AmazonMoney | null;
  /** Explicitly assigned, else unknown; never the card's owner. */
  beneficiary: AmazonBeneficiary;
  tenderCoverage: AmazonTenderCoverage;
  /** How many item observations the order has. */
  itemCount: number;
  /** Set only for a receipt from a Whole Foods store; absent for an ordinary Amazon order. */
  purchaseChannel?: AmazonPurchaseChannel;
  /** `undefined` throughout: not reported by this API (or not in this answer), never "none". */
  items?: AmazonItem[];
  matches?: AmazonMatch[];
  refunds?: AmazonRefund[];
  summary?: AmazonSummaryLine[];
  paymentMethods?: AmazonPaymentMethod[];
}

export interface AmazonOrderPage { total: number; orders: AmazonOrder[] }

export interface AmazonCoverage { status: string; reason: string; pages: number; records: number; rejected: number }

export interface AmazonSummary {
  orders: number;
  paymentObservations: number;
  refundObservations: number;
  issuedRefundObservations: number;
  linked: number;
  held: number;
  unknownBeneficiary: number;
  /**
   * Card charges Spending files under their Amazon items, and those items' parts (never the rest of a charge):
   * reported together or not at all, so an API that does not count them never reads as "0".
   */
  itemized?: { rows: number; parts: number };
  captures: number;
  /** The most recently imported capture's coverage, per family. */
  latestCoverage: Partial<Record<AmazonCoverageFamily, AmazonCoverage>> | null;
  version: string | null;
}

/** The summary's own label for what it counts, checked so another measure is never shown under this one's name. */
export const AMAZON_MEASURE = 'amazon-order-observations-not-card-spending';
/** The API's default page; it allows up to 100. */
export const AMAZON_PAGE_SIZE = 50;

/**
 * What a window's orders' items cost (GET /amazon/spending): Amazon's own measure, by Amazon's order date, never card
 * spending and never added to it. An item costs its unit price times its quantity; amounts are per currency.
 */
export const AMAZON_SPENDING_MEASURE = 'amazon-order-item-prices-not-card-spending';

export interface AmazonSpendingTotals {
  currency: string;
  /** Amazon's order totals, with tax and shipping, of the orders that have one (`orders.withTotal`). */
  orderTotalMinor: number;
  /** Of them, the orders whose item list is proven complete. */
  itemsCompleteOrderTotalMinor: number;
  /** Every priced item: unit price times quantity, before refunds. */
  itemMinor: number;
  /** Of them, the items with a category. */
  categorizedMinor: number;
  /**
   * Only when the API reports refunds (`AmazonSpending.refunds`): the refund money counted for the window's orders
   * (tax and shipping included); the item prices refunds took off the items they are tied to; refunds tied to no item,
   * taken off the total only; and what the items cost after refunds (itemMinor − itemRefundMinor −
   * unattributedRefundMinor).
   */
  refundMinor?: number;
  itemRefundMinor?: number;
  unattributedRefundMinor?: number;
  netItemMinor?: number;
}

export interface AmazonSpendingCategory {
  currency: string;
  /** null: the items with no category. */
  category: string | null;
  /** Before refunds. */
  amountMinor: number;
  /** Item lines (an item ordered twice is two). */
  lines: number;
  /** How many things, all of them, whether or not the list carries every one. */
  products: number;
  orders: number;
  /** Only when the API reports refunds: what refunds tied to its items took off, what is left, and how many lines. */
  refundMinor?: number;
  netMinor?: number;
  refundedLines?: number;
}

/** One thing bought over the window: its priced lines in one currency and category, across orders. */
export interface AmazonSpendingProduct {
  ref: string;
  currency: string;
  /** The full product name, model included; null when the API hid it. */
  title: string | null;
  asin: string | null;
  category: string | null;
  categorySource: AmazonSpendingCategorySource | null;
  quantity: number;
  lines: number;
  orders: number;
  /** Before refunds. */
  amountMinor: number;
  /** The latest order it was in, by Amazon's order date and the order's opaque ref. */
  lastOrderDate: string;
  lastOrderRef: string;
  /** Only when Holdr's owner-only cache holds its product thumbnail (amazonItemImageHref of `ref`). */
  image?: true;
  /** Only when the API reports refunds: what refunds tied to it took off, what is left, and whole units refunded. */
  refundMinor?: number;
  netMinor?: number;
  refundedQuantity?: number;
  /**
   * Only on an Amazon Fresh product, whose lines are its orders' Item List lines (no thumbnail): what they showed
   * together. Its `quantity` counts them as order-item units, and its refunds are money, never units.
   */
  fresh?: AmazonFreshMeasure;
}

/** How a refunded order's refund is tied to its items. */
export type AmazonRefundBasis = 'whole-order' | 'item-records' | 'units' | 'only-line' | 'partly' | 'unattributed';
export const AMAZON_REFUND_BASES: readonly AmazonRefundBasis[] = ['whole-order', 'item-records', 'units', 'only-line', 'partly', 'unattributed'];

/**
 * How a window's refunds were counted and tied to items (closed lists as counts by name; a name this page doesn't
 * know still counts). Amazon's own records are the evidence: an order's Refund Total and the payments ledger's
 * refunds, each counted once, and placed by the order's date.
 */
export interface AmazonSpendingRefunds {
  policy: string;
  /** Refunded orders by how their refund is tied to items. */
  orders: Record<string, number>;
  /** Orders with refund money tied to no item, by the rule that held. */
  unattributed: Record<string, number>;
  /** Which evidence each refunded order's amount is. */
  sources: Record<string, number>;
  ledgerRefunds: number;
  ledgerObservations: number;
  refundTotals: number;
  refundTotalObservations: number;
  /** Refund records left out, never counted, by why. */
  excluded: Record<string, number>;
  /** Items with a refund: how many in all, how many the answer lists, and whether it leaves any out. */
  refundedProducts: { count: number; listed: number; truncated: boolean };
}

/**
 * At most this many listed items are read; any beyond are left unread, never a reason to refuse the whole answer
 * (the API bounds its own list well below this; `AmazonSpending.productsTruncated` says when this cut applied).
 */
export const MAX_LISTED_PRODUCTS = 10_000;

export interface AmazonSpending {
  window: { key: AmazonSpendingWindow; from: string; to: string };
  orders: {
    count: number;
    /** Orders with a captured total. */
    withTotal: number;
    /**
     * Orders whose item list the capture proved complete, every item priced and adding up to Amazon's item subtotal.
     * Any other order with items may have more than were captured.
     */
    itemsComplete: number;
    /** Orders whose capture kept no item line. */
    noLines: number;
    /** Orders with a refund: counted and taken off when the API reports `refunds`, else only observed. */
    refunded: number;
    linked: number; held: number; unmatched: number;
  };
  /** Card charges linked to these orders, and how many of them Spending files under their items. */
  cardCharges: { linked: number; itemized: number };
  /** Item lines: priced, or left out for want of a price or a quantity; and the priced ones with a category. */
  lines: { count: number; priced: number; noPrice: number; noQuantity: number; categorized: number };
  totals: AmazonSpendingTotals[];
  /** Largest first, per currency. */
  categories: AmazonSpendingCategory[];
  /** Largest first; the API may list fewer than the categories count. */
  products: AmazonSpendingProduct[];
  /** The answer listed more items than this page reads (MAX_LISTED_PRODUCTS): the rest are unread, still counted. */
  productsTruncated?: true;
  /** Absent from an API that doesn't take refunds off: its figures are before refunds. */
  refunds?: AmazonSpendingRefunds;
  /**
   * Only when the window holds an Amazon Fresh order: what of the figures its Item Lists' lines are. Such an order counts
   * by its Item List only, as the Amazon Fresh tab counts it.
   */
  fresh?: AmazonFreshPart;
  version: string | null;
}

export class AmazonAnswerError extends Error {
  constructor(what: string) {
    super(`Holdr couldn't read the Amazon answer (${what}).`);
    this.name = 'AmazonAnswerError';
  }
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === 'string' && (values as readonly string[]).includes(value);

/** A required field: throws on anything else. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new AmazonAnswerError(what);
  return value;
}

function money(value: unknown): AmazonMoney | undefined {
  if (!isRecord(value) || typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency)
    || typeof value.amountMinor !== 'number' || !Number.isSafeInteger(value.amountMinor)) return undefined;
  return { currency: value.currency, amountMinor: value.amountMinor };
}

/** null stays null; anything malformed is `undefined`. */
function nullableMoney(value: unknown): AmazonMoney | null | undefined {
  return value === null ? null : money(value);
}

/** A whole list or nothing: one malformed entry and the list is not reported. */
function wholeList<T>(value: unknown, entry: (raw: unknown) => T | undefined, max: number): T[] | undefined {
  if (!Array.isArray(value) || value.length > max) return undefined;
  const parsed: T[] = [];
  for (const raw of value) {
    const item = entry(raw);
    if (item === undefined) return undefined;
    parsed.push(item);
  }
  return parsed;
}

const EVIDENCE: readonly AmazonEvidenceClass[] = CARD_CATEGORY_EVIDENCE_CLASSES;
const HELD: readonly AmazonHeldReason[] = ['binding-held', 'evidence-held', 'no-candidate', 'ambiguous', 'multiple-orders'];
const SOURCES: readonly AmazonCategorySource[] = ['item-override', 'agent-classification', 'reviewed-mapping'];
const TENDERS: readonly AmazonTenderCoverage[] = ['single-card-proven', 'multi-tender', 'unknown'];
const REFUND_STATUS: readonly AmazonRefundStatus[] = ['issued', 'pending', 'unknown'];
const DESTINATIONS: readonly AmazonRefundDestination[] = ['card', 'balance', 'points', 'unknown'];
const METHOD_KINDS: readonly AmazonMethodKind[] = ['card', 'balance', 'points', 'unknown'];
const NETWORKS: readonly AmazonCardNetwork[] = ['visa', 'mastercard', 'amex', 'discover', 'unknown'];
const LINE_KINDS: readonly AmazonSummaryLineKind[] = ['items-subtotal', 'shipping', 'tax', 'tip', 'gift-card', 'promotion', 'rewards', 'grand-total'];
const FAMILIES: readonly AmazonCoverageFamily[] = ['orders', 'payments', 'details', 'refunds'];

/** Only the fields a match may show are copied: nothing else a held match carries can reach the page. */
function match(raw: unknown): AmazonMatch | undefined {
  if (!isRecord(raw) || !oneOf(EVIDENCE, raw.evidenceClass)) return undefined;
  if (raw.state === 'linked') {
    if (!isText(raw.cardTransactionId, 200) || !isText(raw.cardAccountId, 200)) return undefined;
    return { state: 'linked', evidenceClass: raw.evidenceClass, cardTransactionId: raw.cardTransactionId, cardAccountId: raw.cardAccountId };
  }
  if (raw.state === 'held') {
    if (!oneOf(HELD, raw.reason) || !isCount(raw.candidateCount)) return undefined;
    return { state: 'held', evidenceClass: raw.evidenceClass, reason: raw.reason, candidateCount: raw.candidateCount };
  }
  return undefined;
}

function refund(raw: unknown): AmazonRefund | undefined {
  if (!isRecord(raw) || !isText(raw.ref, 200)) return undefined;
  const amount = raw.amount === undefined ? null : nullableMoney(raw.amount);
  if (amount === undefined || (raw.date !== undefined && raw.date !== null && !isDay(raw.date))) return undefined;
  return {
    ref: raw.ref,
    status: oneOf(REFUND_STATUS, raw.status) ? raw.status : 'unknown',
    date: isDay(raw.date) ? raw.date : null,
    amount,
    destination: oneOf(DESTINATIONS, raw.destination) ? raw.destination : 'unknown',
  };
}

/** The API hides a title that fails its card-data guard: as null, or as this placeholder. */
const HIDDEN_TITLE = '[redacted]';

function item(raw: unknown, withPrice: boolean): AmazonItem | undefined {
  if (!isRecord(raw) || !isText(raw.ref, 200)) return undefined;
  const quantity = raw.quantity === null || raw.quantity === undefined ? null : raw.quantity;
  if (quantity !== null && !isCount(quantity)) return undefined;
  const category = !('category' in raw) ? undefined : isText(raw.category, 100) ? raw.category : raw.category === null ? null : undefined;
  const source = typeof category === 'string' && oneOf(SOURCES, raw.categorySource) ? raw.categorySource : null;
  const confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) && raw.confidence >= 0 && raw.confidence <= 1
    ? raw.confidence : null;
  const parsed: AmazonItem = {
    ref: raw.ref,
    title: typeof raw.title === 'string' && raw.title.trim() !== '' && raw.title !== HIDDEN_TITLE ? raw.title : null,
    asin: typeof raw.asin === 'string' && /^[A-Z0-9]{10}$/.test(raw.asin) ? raw.asin : null,
    quantity,
    categorySource: source,
    confidence: source === 'agent-classification' ? confidence : null,
  };
  if (category !== undefined) parsed.category = category;
  if (raw.image === true) parsed.image = true;
  if (withPrice) {
    const price = raw.unitPrice === undefined ? null : nullableMoney(raw.unitPrice);
    if (price === undefined) return undefined;
    parsed.unitPrice = price;
  }
  return parsed;
}

function paymentMethod(raw: unknown): AmazonPaymentMethod | undefined {
  if (!isRecord(raw) || !oneOf(METHOD_KINDS, raw.kind)) return undefined;
  const last4 = typeof raw.last4 === 'string' && /^\d{4}$/.test(raw.last4) ? raw.last4 : null;
  return { kind: raw.kind, network: oneOf(NETWORKS, raw.network) ? raw.network : 'unknown', last4 };
}

function summaryLine(raw: unknown): AmazonSummaryLine | undefined {
  if (!isRecord(raw) || !oneOf(LINE_KINDS, raw.kind)) return undefined;
  const amount = money(raw.money);
  return amount ? { kind: raw.kind, money: amount } : undefined;
}

/** An order as the list or its own page gives it. `full`: the page's answer, whose items carry their unit price. */
export function parseAmazonOrder(raw: unknown, full: boolean): AmazonOrder {
  if (!isRecord(raw)) throw new AmazonAnswerError('order');
  const ref = required(typeof raw.ref === 'string' && AMAZON_ORDER_REF.test(raw.ref) ? raw.ref : undefined, 'order ref');
  const date = required(isDay(raw.date) ? raw.date : undefined, 'order date');
  const total = required(nullableMoney(raw.total), 'order total');
  const order: AmazonOrder = {
    ref,
    date,
    total,
    // Beneficiary is never inferred: anything but an explicit person is unknown.
    beneficiary: oneOf(AMAZON_BENEFICIARIES, raw.beneficiary) ? raw.beneficiary : 'unknown',
    tenderCoverage: oneOf(TENDERS, raw.tenderCoverage) ? raw.tenderCoverage : 'unknown',
    itemCount: required(isCount(raw.itemObservations) ? raw.itemObservations : undefined, 'item count'),
  };
  const channel = readPurchaseChannel(raw.purchaseChannel);
  if (channel) order.purchaseChannel = channel;
  const items = wholeList(raw.items, (entry) => item(entry, full), 200);
  if (items) order.items = items;
  const matches = wholeList(raw.matches, match, 200);
  if (matches) order.matches = matches;
  const refunds = wholeList(raw.refunds, refund, 200);
  if (refunds) order.refunds = refunds;
  const summary = wholeList(raw.summary, summaryLine, 20);
  if (summary) order.summary = summary;
  const methods = wholeList(raw.paymentMethods, paymentMethod, 20);
  if (methods) order.paymentMethods = methods;
  return order;
}

export function parseAmazonOrderPage(raw: unknown): AmazonOrderPage {
  if (!isRecord(raw) || !isCount(raw.total) || !Array.isArray(raw.orders)) throw new AmazonAnswerError('orders');
  return { total: raw.total, orders: raw.orders.map((order) => parseAmazonOrder(order, false)) };
}

function coverage(raw: unknown): AmazonCoverage | undefined {
  if (!isRecord(raw) || !isText(raw.status, 40) || typeof raw.reason !== 'string'
    || !isCount(raw.pages) || !isCount(raw.records) || !isCount(raw.rejected)) return undefined;
  return { status: raw.status, reason: raw.reason, pages: raw.pages, records: raw.records, rejected: raw.rejected };
}

export function parseAmazonSummary(raw: unknown): AmazonSummary {
  if (!isRecord(raw) || raw.measure !== AMAZON_MEASURE) throw new AmazonAnswerError('measure');
  const count = (key: string) => required(isCount(raw[key]) ? raw[key] as number : undefined, key);
  const captures = Array.isArray(raw.coverage) ? raw.coverage : [];
  // The API lists captures newest first.
  const latest = isRecord(captures[0]) && isRecord(captures[0].coverage) ? captures[0].coverage : null;
  let latestCoverage: AmazonSummary['latestCoverage'] = null;
  if (latest) {
    latestCoverage = {};
    for (const family of FAMILIES) {
      const parsed = coverage(latest[family]);
      if (parsed) latestCoverage[family] = parsed;
    }
  }
  // Itemized charges and their item parts, newer than the rest: both, consistent (each charge has a part at least),
  // or neither.
  const itemizedRows = raw.itemizedRows;
  const itemParts = raw.itemParts;
  const itemized = isCount(itemizedRows) && isCount(itemParts) && itemParts >= itemizedRows
    ? { rows: itemizedRows, parts: itemParts } : undefined;
  return {
    orders: count('orders'),
    paymentObservations: count('paymentObservations'),
    refundObservations: count('refundObservations'),
    issuedRefundObservations: count('issuedRefundObservations'),
    linked: count('linked'),
    held: count('held'),
    unknownBeneficiary: count('unknownBeneficiary'),
    ...(itemized ? { itemized } : {}),
    captures: captures.length,
    latestCoverage,
    version: isText(raw.version, 200) ? raw.version : null,
  };
}

export function fetchAmazonSummary(): Promise<AmazonSummary> {
  return api<unknown>('/amazon/summary').then(parseAmazonSummary);
}

/** Named counts, every one a count, or the answer is refused. */
function counts<K extends string>(raw: unknown, keys: readonly K[], what: string): Record<K, number> {
  if (!isRecord(raw)) throw new AmazonAnswerError(what);
  const parsed = {} as Record<K, number>;
  for (const key of keys) {
    const value = raw[key];
    if (!isCount(value)) throw new AmazonAnswerError(what);
    parsed[key] = value;
  }
  return parsed;
}

const isCurrencyCode = (value: unknown): value is string => typeof value === 'string' && /^[A-Z]{3}$/.test(value);
/** A category's name, or null for no category; anything else is `undefined`. */
const spendingCategory = (value: unknown): string | null | undefined => (value === null ? null : isText(value, 100) ? value : undefined);
const categoryKey = (currency: string, category: string | null) => JSON.stringify([currency, category]);
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/** Counts by name, every one a count; a name this page doesn't know still counts. */
function namedCounts(raw: unknown, key: string, count: string, what: string): Record<string, number> {
  if (!Array.isArray(raw) || raw.length > 50) throw new AmazonAnswerError(what);
  const parsed: Record<string, number> = {};
  for (const entry of raw) {
    if (!isRecord(entry) || !isText(entry[key], 60) || Object.hasOwn(parsed, entry[key] as string) || !isCount(entry[count])) {
      throw new AmazonAnswerError(what);
    }
    parsed[entry[key] as string] = entry[count] as number;
  }
  return parsed;
}
const countTotal = (named: Record<string, number>) => sum(Object.values(named));

/** How the refunds were counted, checked against the orders they were counted for. */
function spendingRefunds(raw: unknown, refunded: number): AmazonSpendingRefunds {
  if (!isRecord(raw) || !isText(raw.policy, 100)) throw new AmazonAnswerError('refunds');
  const values = counts(raw, ['ledgerRefunds', 'ledgerObservations', 'refundTotals', 'refundTotalObservations'], 'refunds');
  const listing = counts(raw.refundedProducts, ['count', 'listed'], 'refunds');
  const truncated = isRecord(raw.refundedProducts) ? raw.refundedProducts.truncated : undefined;
  if (typeof truncated !== 'boolean' || listing.listed > listing.count || truncated !== listing.listed < listing.count) {
    throw new AmazonAnswerError('refunds');
  }
  const refunds: AmazonSpendingRefunds = {
    policy: raw.policy,
    orders: namedCounts(raw.orders, 'basis', 'orders', 'refunds'),
    unattributed: namedCounts(raw.unattributed, 'reason', 'orders', 'refunds'),
    sources: namedCounts(raw.sources, 'source', 'orders', 'refunds'),
    excluded: namedCounts(raw.excluded, 'reason', 'count', 'refunds'),
    ...values,
    refundedProducts: { ...listing, truncated },
  };
  // Each refunded order has one basis and one source; those with money tied to no item, one reason.
  if (countTotal(refunds.orders) !== refunded || countTotal(refunds.sources) !== refunded
    || countTotal(refunds.unattributed) !== (refunds.orders.partly ?? 0) + (refunds.orders.unattributed ?? 0)
    || values.ledgerRefunds > values.ledgerObservations || values.refundTotals > values.refundTotalObservations) {
    throw new AmazonAnswerError('refunds');
  }
  return refunds;
}

/**
 * A window's spending, checked whole. Totals that don't add up would mislead, so the answer is refused unless every
 * field reads, its counts agree (each order linked, held or unmatched; each line priced or left out for one reason),
 * each currency's categories add up to its item prices and their categorized part, and no listed item says more than
 * its category. With refunds reported, every net is its gross less its refunds, categories' refunds add up to what
 * refunds took off items, and no listed item's refund is more than its category's. An Amazon Fresh part never says
 * more than the window's own figures, and its listed products (no thumbnail, refunds as money only) never more than it.
 * An API that hid a title, or sent an unreadable ASIN or category source, reads as not saying it.
 */
export function parseAmazonSpending(raw: unknown, requested: AmazonSpendingWindow): AmazonSpending {
  if (!isRecord(raw) || raw.measure !== AMAZON_SPENDING_MEASURE) throw new AmazonAnswerError('measure');
  const window = raw.window;
  if (!isRecord(window) || window.key !== requested || !isDay(window.from) || !isDay(window.to) || window.from > window.to) {
    throw new AmazonAnswerError('window');
  }
  const orders = counts(raw.orders, ['count', 'withTotal', 'itemsComplete', 'noLines', 'refunded', 'linked', 'held', 'unmatched'], 'orders');
  if (orders.withTotal > orders.count || orders.itemsComplete + orders.noLines > orders.count || orders.refunded > orders.count
    || orders.linked + orders.held + orders.unmatched !== orders.count) throw new AmazonAnswerError('orders');
  const cardCharges = counts(raw.cardCharges, ['linked', 'itemized'], 'card charges');
  if (cardCharges.itemized > cardCharges.linked) throw new AmazonAnswerError('card charges');
  const lines = counts(raw.lines, ['count', 'priced', 'noPrice', 'noQuantity', 'categorized'], 'lines');
  if (lines.priced + lines.noPrice + lines.noQuantity !== lines.count || lines.categorized > lines.priced) throw new AmazonAnswerError('lines');
  // An API that takes refunds off says how; one that doesn't, says nothing of it, and its figures are before refunds.
  const refunds = raw.refunds === undefined ? undefined : spendingRefunds(raw.refunds, orders.refunded);

  if (!Array.isArray(raw.totals) || raw.totals.length > 50) throw new AmazonAnswerError('totals');
  const totals = raw.totals.map((entry): AmazonSpendingTotals => {
    if (!isRecord(entry) || !isCurrencyCode(entry.currency)) throw new AmazonAnswerError('totals');
    const amounts = counts(entry, ['orderTotalMinor', 'itemsCompleteOrderTotalMinor', 'itemMinor', 'categorizedMinor'], 'totals');
    if (amounts.itemsCompleteOrderTotalMinor > amounts.orderTotalMinor || amounts.categorizedMinor > amounts.itemMinor) {
      throw new AmazonAnswerError('totals');
    }
    if (!refunds) return { currency: entry.currency, ...amounts };
    const net = counts(entry, ['refundMinor', 'itemRefundMinor', 'unattributedRefundMinor', 'netItemMinor'], 'totals');
    if (net.netItemMinor !== amounts.itemMinor - net.itemRefundMinor - net.unattributedRefundMinor) throw new AmazonAnswerError('totals');
    return { currency: entry.currency, ...amounts, ...net };
  });
  if (new Set(totals.map((entry) => entry.currency)).size !== totals.length) throw new AmazonAnswerError('totals');

  if (!Array.isArray(raw.categories) || raw.categories.length > 10_000) throw new AmazonAnswerError('categories');
  const categories = raw.categories.map((entry): AmazonSpendingCategory => {
    const category = isRecord(entry) ? spendingCategory(entry.category) : undefined;
    if (!isRecord(entry) || category === undefined || !totals.some((total) => total.currency === entry.currency)) {
      throw new AmazonAnswerError('categories');
    }
    const values = counts(entry, ['amountMinor', 'lines', 'products', 'orders'], 'categories');
    if (values.products < 1 || values.orders < 1 || values.products > values.lines || values.orders > values.lines) {
      throw new AmazonAnswerError('categories');
    }
    if (!refunds) return { currency: entry.currency as string, category, ...values };
    const net = counts(entry, ['refundMinor', 'netMinor', 'refundedLines'], 'categories');
    if (net.netMinor !== values.amountMinor - net.refundMinor || net.refundedLines > values.lines) throw new AmazonAnswerError('categories');
    return { currency: entry.currency as string, category, ...values, ...net };
  });
  const byCategory = new Map(categories.map((entry) => [categoryKey(entry.currency, entry.category), entry]));
  const named = categories.filter((entry) => entry.category !== null);
  if (byCategory.size !== categories.length
    || totals.some((total) => sum(categories.filter((entry) => entry.currency === total.currency).map((entry) => entry.amountMinor)) !== total.itemMinor
      || sum(named.filter((entry) => entry.currency === total.currency).map((entry) => entry.amountMinor)) !== total.categorizedMinor)
    || sum(categories.map((entry) => entry.lines)) !== lines.priced || sum(named.map((entry) => entry.lines)) !== lines.categorized
    || (refunds && totals.some((total) => sum(categories.filter((entry) => entry.currency === total.currency)
      .map((entry) => entry.refundMinor ?? 0)) !== total.itemRefundMinor))) {
    throw new AmazonAnswerError('categories');
  }

  if (!Array.isArray(raw.products)) throw new AmazonAnswerError('items');
  // A list too long to read whole is read in part, never refused: the totals still count every item.
  const productsTruncated = raw.products.length > MAX_LISTED_PRODUCTS;
  const listed = new Map<string, { count: number; amountMinor: number; refundMinor: number }>();
  const refs = new Set<string>();
  const products = raw.products.slice(0, MAX_LISTED_PRODUCTS).map((entry): AmazonSpendingProduct => {
    if (!isRecord(entry) || !isText(entry.ref, 200) || refs.has(entry.ref) || !isDay(entry.lastOrderDate)
      || typeof entry.lastOrderRef !== 'string' || !AMAZON_ORDER_REF.test(entry.lastOrderRef)) throw new AmazonAnswerError('items');
    refs.add(entry.ref);
    const category = spendingCategory(entry.category);
    const key = category === undefined || typeof entry.currency !== 'string' ? null : categoryKey(entry.currency, category);
    const bucket = key === null ? undefined : byCategory.get(key);
    if (!bucket || key === null || category === undefined) throw new AmazonAnswerError('items');
    const values = counts(entry, ['quantity', 'lines', 'orders', 'amountMinor'], 'items');
    const net = refunds ? counts(entry, ['refundMinor', 'netMinor', 'refundedQuantity'], 'items') : undefined;
    const shown = listed.get(key) ?? { count: 0, amountMinor: 0, refundMinor: 0 };
    shown.count += 1;
    shown.amountMinor += values.amountMinor;
    shown.refundMinor += net?.refundMinor ?? 0;
    listed.set(key, shown);
    if (values.lines < 1 || values.orders > values.lines || values.orders < 1 || values.quantity < values.lines
      || shown.count > bucket.products || shown.amountMinor > bucket.amountMinor) throw new AmazonAnswerError('items');
    if (net && (net.netMinor !== values.amountMinor - net.refundMinor || net.refundedQuantity > values.quantity
      || shown.refundMinor > (bucket.refundMinor ?? 0))) throw new AmazonAnswerError('items');
    // An Amazon Fresh product: its lines are its orders' Item List lines, never order items, so it has no thumbnail and its
    // refunds are money, never units; its category is its item category's, or the default.
    const fresh = entry.fresh === undefined ? undefined : readFreshMeasure(entry.fresh);
    if (entry.fresh !== undefined && (!fresh || entry.image !== undefined || (net !== undefined && net.refundedQuantity > 0))) {
      throw new AmazonAnswerError('items');
    }
    const sources: readonly AmazonSpendingCategorySource[] = fresh ? AMAZON_FRESH_CARD_SOURCES : SOURCES;
    return {
      ref: entry.ref,
      currency: bucket.currency,
      title: typeof entry.title === 'string' && entry.title.trim() !== '' && entry.title !== HIDDEN_TITLE ? entry.title : null,
      asin: typeof entry.asin === 'string' && /^[A-Z0-9]{10}$/.test(entry.asin) ? entry.asin : null,
      category,
      categorySource: category !== null && oneOf(sources, entry.categorySource) ? entry.categorySource : null,
      ...values,
      lastOrderDate: entry.lastOrderDate,
      lastOrderRef: entry.lastOrderRef,
      ...(entry.image === true ? { image: true as const } : {}),
      ...net,
      ...(fresh ? { fresh } : {}),
    };
  });
  // Amazon Fresh orders' lines: said only when the window holds one, and never more than the window's own figures.
  const freshPart = raw.fresh === undefined ? undefined : readFreshPart(raw.fresh);
  if ((raw.fresh !== undefined && (!freshPart || !freshPartFits(freshPart, { orders: orders.count, priced: lines.priced, totals })))
    || !freshProductsFit(freshPart, products)) throw new AmazonAnswerError('fresh');
  return {
    window: { key: requested, from: window.from, to: window.to },
    orders, cardCharges, lines, totals, categories, products,
    ...(productsTruncated ? { productsTruncated: true as const } : {}),
    ...(refunds ? { refunds } : {}),
    ...(freshPart ? { fresh: freshPart } : {}),
    version: isText(raw.version, 200) ? raw.version : null,
  };
}

/** The window ending `today` (the viewer's calendar date, YYYY-MM-DD). */
export function fetchAmazonSpending(window: AmazonSpendingWindow, today: string): Promise<AmazonSpending> {
  return api<unknown>(`/amazon/spending?${new URLSearchParams({ window, today })}`).then((body) => parseAmazonSpending(body, window));
}

export function fetchAmazonOrders(options: { offset: number; limit?: number; beneficiary?: AmazonBeneficiary }): Promise<AmazonOrderPage> {
  const search = new URLSearchParams({ offset: String(options.offset), limit: String(options.limit ?? AMAZON_PAGE_SIZE) });
  if (options.beneficiary) search.set('beneficiary', options.beneficiary);
  return api<unknown>(`/amazon/orders?${search}`).then(parseAmazonOrderPage);
}

export function fetchAmazonOrder(ref: string): Promise<AmazonOrder> {
  return api<unknown>(`/amazon/orders/${encodeURIComponent(ref)}`).then((body) => {
    if (!isRecord(body)) throw new AmazonAnswerError('order');
    return parseAmazonOrder(body.order, true);
  });
}

/**
 * Where an item's cached product thumbnail is served: Holdr's own origin (the page's `img-src 'self'`), behind the
 * owner's session like every API read; never Amazon's. Null for anything but an opaque item ref.
 */
export function amazonItemImageHref(itemRef: string): string | null {
  return AMAZON_ORDER_REF.test(itemRef) ? `/amazon/items/${encodeURIComponent(itemRef)}/image` : null;
}
