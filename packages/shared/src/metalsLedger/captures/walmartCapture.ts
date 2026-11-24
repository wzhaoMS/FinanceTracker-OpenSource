/**
 * Walmart captures (`holdr-retail-capture/walmart@1`) as typed records for the metals ledger. Pure: a caller reads the
 * files and hands their parsed JSON in; nothing here touches a file system, network or clock.
 *
 * Two readers return one shape, WalmartOrder, so a later converter can compare them field by field: readWalmartCapture
 * reads the pull's consolidated `walmart.json`, and readWalmartRawDetail reads one raw `detail-<orderId>.json` the way
 * the capture's own normalizer maps it. A raw detail doesn't state what only the order list or the capture's own
 * readings give: those fields are null on its record, and walmartRawComparable nulls them on either record.
 *
 * Nothing here interprets a value: product and seller names are kept as stated, money as integer cents. The capture's
 * own item readings (isPreciousMetal, metal, weightOztPerUnit, weightParsedFrom) and its hasPreciousMetal flag are never
 * read. Free text (descriptions, messages, titles), tracking, store names and the display order number are dropped.
 * An issue names a JSON path and the rule broken, never a value (captureRead.ts).
 */

import {
  CAPTURE_MAX_ENTRIES,
  CAPTURE_MAX_RECORDS,
  CAPTURE_MONEY_TEXT_RULE,
  CaptureReader,
  displayedCents,
  dollarCents,
  isAbsent,
  isRecord,
  readCapture,
  type CaptureIssue,
  type Rec,
} from './captureRead.js';

export const WALMART_CAPTURE_SCHEMA = 'holdr-retail-capture/walmart@1' as const;
export const WALMART_FULFILLMENT_TYPES = ['FC_DELIVERY', 'SC_PICKUP', 'SC_DELIVERY'] as const;
export type WalmartFulfillmentType = (typeof WALMART_FULFILLMENT_TYPES)[number];
export const WALMART_DETAILED_GROUP_TYPES = ['DELIVERY', 'PICKUP_CURBSIDE', 'DFS'] as const;
export type WalmartDetailedGroupType = (typeof WALMART_DETAILED_GROUP_TYPES)[number];
export const WALMART_GROUP_STATUSES = ['DELIVERED', 'CANCELED', 'PICKED_UP'] as const;
export type WalmartGroupStatus = (typeof WALMART_GROUP_STATUSES)[number];
export const WALMART_PAYMENT_TYPES = ['CREDITCARD', 'GIFTCARD', 'CLOSEDLOOP', 'PAYPAL'] as const;
export type WalmartPaymentType = (typeof WALMART_PAYMENT_TYPES)[number];
export const WALMART_CARD_TYPES = ['AMEX', 'VISA', 'MASTERCARD', 'DISCOVER', 'OTHER', 'WMCREDIT', 'PAYPAL'] as const;
export type WalmartCardType = (typeof WALMART_CARD_TYPES)[number];

const ORDER_ID = /^[0-9]{1,40}$/;
const ORDER_ID_RULE = 'must be 1 to 40 digits';
const LAST4_IN_DESCRIPTION = /Ending in\s*(\d{4})\b/i;
const MAX_QUANTITY = 1_000_000;
const MONEY_TEXT_RULE = CAPTURE_MONEY_TEXT_RULE;
const ONE_CHARGE_RULE = "must have at most one entry: the method's total for the order";

export interface WalmartProvenance {
  /** When the pull ran, as a canonical UTC instant. */
  capturedAt: string;
  /** The order list, as the pull paged it. */
  list: { pages: number; pageSize: number; rowsSeen: number; statedTotal: number | null; lastPageHasNext: boolean | null };
  /** How many order details the pull captured, of how many. */
  details: { captured: number; of: number };
}

export interface WalmartSeller {
  id: string | null;
  /** As stated, never interpreted. */
  name: string | null;
  isPro: boolean | null;
  shownAsMarketplaceSeller: boolean | null;
  shippedByWalmart: boolean | null;
}

export interface WalmartStatus {
  type: WalmartGroupStatus | null;
  /**
   * A stated status type outside WALMART_GROUP_STATUSES, as stated (then `type` is null); null when the type is in the
   * list or not stated. It is a lifecycle the closed list can't read, not a malformed record.
   */
  unlistedType: string | null;
  /** The status message as the page shows it: its parts joined, trimmed. */
  text: string | null;
  /** Consolidated only: the capture's own date for the message, its year inferred. Null from a raw detail. */
  eventDate: string | null;
}

export interface WalmartItem {
  /** Walmart's own line id, as text. */
  lineId: string | null;
  /** The product's name as stated, never interpreted. */
  name: string | null;
  usItemId: string | null;
  offerId: string | null;
  qty: number | null;
  /** The whole line's price in cents, as the page shows it. */
  linePriceMinor: number | null;
  /** Consolidated only: the capture's linePrice ÷ qty, which Walmart never states. Null from a raw detail. */
  unitPriceMinor: number | null;
  /** True exactly when unitPriceMinor is set: that unit price is derived, not stated. */
  unitPriceDerived: boolean;
}

export interface WalmartGroup {
  groupId: string | null;
  fulfillmentType: WalmartFulfillmentType | null;
  detailedGroupType: WalmartDetailedGroupType | null;
  status: WalmartStatus;
  deliveryDate: string | null;
  readyForPickupDate: string | null;
  seller: WalmartSeller | null;
  items: WalmartItem[];
}

export interface WalmartLabeledAmount {
  label: string | null;
  amountMinor: number;
}

export interface WalmartAmounts {
  subTotalMinor: number | null;
  taxMinor: number | null;
  grandTotalMinor: number | null;
  grandTotalWithTipsMinor: number | null;
  driverTipMinor: number | null;
  fees: WalmartLabeledAmount[];
  discounts: WalmartLabeledAmount[];
  /** Never positive: a refund is negative cents. */
  refunds: WalmartLabeledAmount[];
  donations: WalmartLabeledAmount[];
}

export interface WalmartPayment {
  paymentType: WalmartPaymentType;
  cardType: WalmartCardType | null;
  /** A card's last four digits, kept for CREDITCARD only: null for every other method. */
  last4: string | null;
  /** The method's one charged total for the order, in cents; null when none is shown. */
  chargedMinor: number | null;
}

export interface WalmartRefundPayment {
  paymentType: WalmartPaymentType;
  cardType: WalmartCardType | null;
  /** A card's last four digits, kept for CREDITCARD only. */
  last4: string | null;
  amountsMinor: number[];
}

export interface WalmartOrderFlags {
  cancelled: boolean;
  partlyCancelled: boolean;
  refunded: boolean;
  returned: boolean;
}

export type WalmartOrderSource = 'consolidated' | 'raw-detail';

export interface WalmartOrder {
  source: WalmartOrderSource;
  /**
   * SENSITIVE: Walmart's own order number, exactly as stated. Key material only, which a later step hashes: never log,
   * show, store or put it in a message.
   */
  orderKeyMaterial: string;
  orderDate: string | null;
  /** Walmart's own date and time text for the order, as stated. */
  orderDateRaw: string | null;
  /** Consolidated only, as are timezone to statusTypes (the order list's and the capture's): null from a raw detail. */
  orderAt: string | null;
  timezone: string | null;
  type: string | null;
  isInStore: boolean | null;
  itemCount: number | null;
  statusTypes: string[] | null;
  groups: WalmartGroup[];
  amounts: WalmartAmounts;
  payments: WalmartPayment[];
  /** Consolidated only, as are chargeHistoryEntries and flags: null from a raw detail. */
  refundPayments: WalmartRefundPayment[] | null;
  chargeHistoryEntries: number | null;
  flags: WalmartOrderFlags | null;
  detailCaptured: boolean;
  /** When the order's raw detail was captured, as a canonical UTC instant. */
  detailCapturedAt: string | null;
}

export interface WalmartCapture {
  schema: typeof WALMART_CAPTURE_SCHEMA;
  provenance: WalmartProvenance;
  orders: WalmartOrder[];
}

export type WalmartCaptureRead = { ok: true; capture: WalmartCapture } | { ok: false; issues: CaptureIssue[] };
export type WalmartRawDetailRead = { ok: true; order: WalmartOrder } | { ok: false; issues: CaptureIssue[] };
/** An order as both files state it: every field a raw detail doesn't state is null (walmartRawComparable). */
export type WalmartComparableOrder = Omit<WalmartOrder, 'source'>;

const noStatus = (): WalmartStatus => ({ type: null, unlistedType: null, text: null, eventDate: null });
const noAmounts = (): WalmartAmounts => ({
  subTotalMinor: null, taxMinor: null, grandTotalMinor: null, grandTotalWithTipsMinor: null, driverTipMinor: null,
  fees: [], discounts: [], refunds: [], donations: [],
});
const noFlags = (): WalmartOrderFlags => ({ cancelled: false, partlyCancelled: false, refunded: false, returned: false });
const noProvenance = (): WalmartProvenance => ({
  capturedAt: '', list: { pages: 0, pageSize: 0, rowsSeen: 0, statedTotal: null, lastPageHasNext: null }, details: { captured: 0, of: 0 },
});

function checkRefund(r: CaptureReader, amountMinor: number, path: string): void {
  if (amountMinor > 0) r.fail(path, 'must not be positive: a refund is negative cents');
}

/**
 * A group's status type: one of WALMART_GROUP_STATUSES, or other text kept as stated (`unlistedType`), which a consumer
 * decides about; only a type that isn't text at all is an issue.
 */
function statusType(r: CaptureReader, value: unknown, path: string): Pick<WalmartStatus, 'type' | 'unlistedType'> {
  if (isAbsent(value)) return { type: null, unlistedType: null };
  const text = r.string(value, path);
  return (WALMART_GROUP_STATUSES as readonly string[]).includes(text)
    ? { type: text as WalmartGroupStatus, unlistedType: null }
    : { type: null, unlistedType: text };
}

// ---------------------------------------------------------------------------
// The consolidated file
// ---------------------------------------------------------------------------

/** The consolidated file's money, `{ cents, currency, raw, label? }`, as cents: null cents means the capture couldn't read it. */
function money(r: CaptureReader, value: unknown, path: string): number {
  return r.guard(0, () => {
    const amount = r.object(value, path);
    r.usd(amount.currency, `${path}.currency`);
    r.textOrNumber(amount.raw, `${path}.raw`);
    r.optString(amount.label, `${path}.label`);
    if (amount.cents === null) {
      r.fail(`${path}.cents`, 'is null: the capture could not read the amount');
      return 0;
    }
    return r.minor(amount.cents, `${path}.cents`);
  });
}

const optMoney = (r: CaptureReader, value: unknown, path: string): number | null => (isAbsent(value) ? null : money(r, value, path));

function moneyList(r: CaptureReader, value: unknown, path: string): number[] {
  return r.guard<number[]>([], () => r.list(value, path, CAPTURE_MAX_ENTRIES, (entry, at) => money(r, entry, at)));
}

function listedLabeled(r: CaptureReader, value: unknown, path: string, refunds: boolean): WalmartLabeledAmount[] {
  return r.guard<WalmartLabeledAmount[]>([], () => r.list(value, path, CAPTURE_MAX_ENTRIES, (entry, at) => {
    const row = r.object(entry, at);
    const label = r.optString(row.label, `${at}.label`);
    const amountMinor = money(r, row.amount, `${at}.amount`);
    if (refunds) checkRefund(r, amountMinor, `${at}.amount.cents`);
    return { label, amountMinor };
  }));
}

function listedAmounts(r: CaptureReader, value: unknown, at: string): WalmartAmounts {
  const amounts = r.object(value, at);
  return {
    subTotalMinor: optMoney(r, amounts.subTotal, `${at}.subTotal`),
    taxMinor: optMoney(r, amounts.tax, `${at}.tax`),
    grandTotalMinor: optMoney(r, amounts.grandTotal, `${at}.grandTotal`),
    grandTotalWithTipsMinor: optMoney(r, amounts.grandTotalWithTips, `${at}.grandTotalWithTips`),
    driverTipMinor: optMoney(r, amounts.driverTip, `${at}.driverTip`),
    fees: listedLabeled(r, amounts.fees, `${at}.fees`, false),
    discounts: listedLabeled(r, amounts.discounts, `${at}.discounts`, false),
    refunds: listedLabeled(r, amounts.refunds, `${at}.refunds`, true),
    donations: listedLabeled(r, amounts.donations, `${at}.donations`, false),
  };
}

/** A payment's method and card fields; its description and message are checked, never kept. */
function paymentMethod(r: CaptureReader, row: Rec, at: string): Omit<WalmartPayment, 'chargedMinor'> {
  const paymentType = r.oneOf(row.paymentType, `${at}.paymentType`, WALMART_PAYMENT_TYPES);
  const cardType = r.optOneOf(row.cardType, `${at}.cardType`, WALMART_CARD_TYPES);
  r.optString(row.description, `${at}.description`);
  const last4 = r.optLast4(row.last4, `${at}.last4`);
  r.optString(row.message, `${at}.message`);
  return { paymentType, cardType, last4: paymentType === 'CREDITCARD' ? last4 : null };
}

function listedPayment(r: CaptureReader, entry: unknown, at: string): WalmartPayment {
  const row = r.object(entry, at);
  const method = paymentMethod(r, row, at);
  const charged = moneyList(r, row.charged, `${at}.charged`);
  if (charged.length > 1) r.fail(`${at}.charged`, ONE_CHARGE_RULE);
  return { ...method, chargedMinor: charged[0] ?? null };
}

function listedRefundPayment(r: CaptureReader, entry: unknown, at: string): WalmartRefundPayment {
  const row = r.object(entry, at);
  return { ...paymentMethod(r, row, at), amountsMinor: moneyList(r, row.amounts, `${at}.amounts`) };
}

function listedItem(r: CaptureReader, entry: unknown, at: string): WalmartItem {
  const item = r.object(entry, at);
  const lineId = r.optId(item.lineId, `${at}.lineId`);
  const name = r.optString(item.name, `${at}.name`);
  const usItemId = r.optId(item.usItemId, `${at}.usItemId`);
  const offerId = r.optId(item.offerId, `${at}.offerId`);
  const qty = r.optInteger(item.qty, `${at}.qty`, 0, MAX_QUANTITY);
  const linePriceMinor = optMoney(r, item.linePrice, `${at}.linePrice`);
  const unitPriceMinor = optMoney(r, item.unitPrice, `${at}.unitPrice`);
  return { lineId, name, usItemId, offerId, qty, linePriceMinor, unitPriceMinor, unitPriceDerived: unitPriceMinor !== null };
}

function listedGroup(r: CaptureReader, entry: unknown, at: string): WalmartGroup {
  const group = r.object(entry, at);
  const groupId = r.optId(group.groupId, `${at}.groupId`);
  const fulfillmentType = r.optOneOf(group.fulfillmentType, `${at}.fulfillmentType`, WALMART_FULFILLMENT_TYPES);
  const detailedGroupType = r.optOneOf(group.detailedGroupType, `${at}.detailedGroupType`, WALMART_DETAILED_GROUP_TYPES);
  const status = r.guard(noStatus(), () => {
    const stated = r.object(group.status, `${at}.status`);
    return {
      ...statusType(r, stated.type, `${at}.status.type`),
      text: r.optString(stated.text, `${at}.status.text`),
      eventDate: r.optDate(stated.eventDate, `${at}.status.eventDate`),
    };
  });
  const deliveryDate = r.optDate(group.deliveryDate, `${at}.deliveryDate`);
  const readyForPickupDate = r.optDate(group.readyForPickupDate, `${at}.readyForPickupDate`);
  const seller = r.guard<WalmartSeller | null>(null, () => {
    const stated = r.optObject(group.seller, `${at}.seller`);
    if (stated === null) return null;
    return {
      id: r.optId(stated.id, `${at}.seller.id`),
      name: r.optString(stated.name, `${at}.seller.name`),
      isPro: r.optBoolean(stated.isPro, `${at}.seller.isPro`),
      shownAsMarketplaceSeller: r.optBoolean(stated.shownAsMarketplaceSeller, `${at}.seller.shownAsMarketplaceSeller`),
      shippedByWalmart: r.optBoolean(stated.shippedByWalmart, `${at}.seller.shippedByWalmart`),
    };
  });
  // A store's name and a shipment's tracking are checked, never kept.
  r.guard(null, () => {
    const store = r.optObject(group.store, `${at}.store`);
    if (store !== null) r.string(store.name, `${at}.store.name`);
    const shipment = r.optObject(group.shipment, `${at}.shipment`);
    if (shipment !== null) {
      r.optString(shipment.trackingLast4, `${at}.shipment.trackingLast4`);
      r.optBoolean(shipment.isExternalTracking, `${at}.shipment.isExternalTracking`);
    }
    return null;
  });
  const items = r.guard<WalmartItem[]>([], () => r.list(group.items, `${at}.items`, CAPTURE_MAX_ENTRIES, (item, p) => listedItem(r, item, p)));
  return { groupId, fulfillmentType, detailedGroupType, status, deliveryDate, readyForPickupDate, seller, items };
}

function listedOrder(r: CaptureReader, entry: unknown, at: string, seen: Set<string>): WalmartOrder {
  const order = r.object(entry, at);
  const orderKeyMaterial = r.idOfForm(order.orderId, `${at}.orderId`, ORDER_ID, ORDER_ID_RULE);
  if (orderKeyMaterial !== '') {
    if (seen.has(orderKeyMaterial)) r.fail(`${at}.orderId`, "repeats an earlier order's id");
    seen.add(orderKeyMaterial);
  }
  // The display number repeats the order number, and the title is free text: both checked, never kept.
  r.optString(order.displayId, `${at}.displayId`);
  const orderDate = r.optDate(order.orderDate, `${at}.orderDate`);
  const orderDateRaw = r.optString(order.orderDateRaw, `${at}.orderDateRaw`);
  const orderAt = r.optStamp(order.orderAt, `${at}.orderAt`);
  const timezone = r.optString(order.timezone, `${at}.timezone`);
  const type = r.optString(order.type, `${at}.type`);
  r.optString(order.title, `${at}.title`);
  const isInStore = r.optBoolean(order.isInStore, `${at}.isInStore`);
  const itemCount = r.optCount(order.itemCount, `${at}.itemCount`);
  const statusTypes = r.guard<string[]>([], () => r.list(order.statusTypes, `${at}.statusTypes`, CAPTURE_MAX_ENTRIES, (value, p) => r.string(value, p)));
  const groups = r.guard<WalmartGroup[]>([], () => r.list(order.groups, `${at}.groups`, CAPTURE_MAX_ENTRIES, (group, p) => listedGroup(r, group, p)));
  const amounts = r.guard(noAmounts(), () => listedAmounts(r, order.amounts, `${at}.amounts`));
  const payments = r.guard<WalmartPayment[]>([], () => r.list(order.payments, `${at}.payments`, CAPTURE_MAX_ENTRIES, (row, p) => listedPayment(r, row, p)));
  const refundPayments = r.guard<WalmartRefundPayment[]>([], () =>
    r.list(order.refundPayments, `${at}.refundPayments`, CAPTURE_MAX_ENTRIES, (row, p) => listedRefundPayment(r, row, p)));
  const chargeHistoryEntries = r.guard<number | null>(null, () => {
    const history = r.optObject(order.chargeHistory, `${at}.chargeHistory`);
    if (history === null) return null;
    r.optString(history.title, `${at}.chargeHistory.title`);
    r.optString(history.message, `${at}.chargeHistory.message`);
    return r.count(history.entries, `${at}.chargeHistory.entries`);
  });
  const flags = r.guard(noFlags(), () => {
    const stated = r.object(order.flags, `${at}.flags`);
    return {
      cancelled: r.boolean(stated.cancelled, `${at}.flags.cancelled`),
      partlyCancelled: r.boolean(stated.partlyCancelled, `${at}.flags.partlyCancelled`),
      refunded: r.boolean(stated.refunded, `${at}.flags.refunded`),
      returned: r.boolean(stated.returned, `${at}.flags.returned`),
    };
  });
  const detailCaptured = r.boolean(order.detailCaptured, `${at}.detailCaptured`);
  const detailCapturedAt = r.optStamp(order.detailCapturedAt, `${at}.detailCapturedAt`);
  return {
    source: 'consolidated', orderKeyMaterial, orderDate, orderDateRaw, orderAt, timezone, type, isInStore, itemCount, statusTypes,
    groups, amounts, payments, refundPayments, chargeHistoryEntries, flags, detailCaptured, detailCapturedAt,
  };
}

function provenanceOf(r: CaptureReader, value: unknown): WalmartProvenance {
  const at = '$.provenance';
  const provenance = r.object(value, at);
  r.exact(provenance.source, `${at}.source`, 'walmart.com', 'must be walmart.com');
  r.string(provenance.capturedBy, `${at}.capturedBy`);
  const capturedAt = r.stamp(provenance.capturedAt, `${at}.capturedAt`);
  r.usd(provenance.currency, `${at}.currency`);
  r.string(provenance.dateNote, `${at}.dateNote`);
  const list = r.guard(noProvenance().list, () => {
    const stated = r.object(provenance.list, `${at}.list`);
    return {
      pages: r.count(stated.pages, `${at}.list.pages`),
      pageSize: r.count(stated.pageSize, `${at}.list.pageSize`),
      rowsSeen: r.count(stated.rowsSeen, `${at}.list.rowsSeen`),
      statedTotal: r.optCount(stated.statedTotal, `${at}.list.statedTotal`),
      lastPageHasNext: r.optBoolean(stated.lastPageHasNext, `${at}.list.lastPageHasNext`),
    };
  });
  const details = r.guard(noProvenance().details, () => {
    const stated = r.object(provenance.details, `${at}.details`);
    return { captured: r.count(stated.captured, `${at}.details.captured`), of: r.count(stated.of, `${at}.details.of`) };
  });
  r.string(provenance.sanitization, `${at}.sanitization`);
  r.count(provenance.rawFilesRescrubbed, `${at}.rawFilesRescrubbed`);
  return { capturedAt, list, details };
}

/** Reads the pull's consolidated `walmart.json`: its typed orders, or every issue found (at most CAPTURE_MAX_ISSUES). */
export function readWalmartCapture(json: unknown): WalmartCaptureRead {
  const read = readCapture((r): WalmartCapture => {
    const root = r.object(json, '$');
    if (root.schema !== WALMART_CAPTURE_SCHEMA) r.skip('$.schema', `must be ${WALMART_CAPTURE_SCHEMA}`);
    const provenance = r.guard(noProvenance(), () => provenanceOf(r, root.provenance));
    const seen = new Set<string>();
    const orders = r.list(root.orders, '$.orders', CAPTURE_MAX_RECORDS, (entry, at) => listedOrder(r, entry, at, seen));
    return { schema: WALMART_CAPTURE_SCHEMA, provenance, orders };
  });
  return read.ok ? { ok: true, capture: read.value } : read;
}

// ---------------------------------------------------------------------------
// Raw details
// ---------------------------------------------------------------------------

function displayed(r: CaptureReader, text: string, path: string): number {
  const cents = displayedCents(text);
  if (cents === null) r.fail(path, MONEY_TEXT_RULE);
  return cents ?? 0;
}

function dollars(r: CaptureReader, value: number, path: string): number {
  const cents = dollarCents(value);
  if (cents === null) r.fail(path, 'must be a finite number of dollars within range');
  return cents ?? 0;
}

/**
 * A Walmart price value, `{ displayValue, value?, label? }`, or its display text alone, as cents: from the display text
 * ('$1,234.56', '-$1.00', 'Free'), else from the value in dollars.
 */
function rawMoney(r: CaptureReader, value: unknown, path: string): number {
  if (typeof value === 'string') return displayed(r, value, path);
  if (typeof value === 'number') return dollars(r, value, path);
  if (!isRecord(value)) {
    r.fail(path, value === undefined ? 'is missing' : 'must be a price value or money text');
    return 0;
  }
  const shown = value.displayValue;
  if (!isAbsent(shown) && typeof shown !== 'string') {
    r.fail(`${path}.displayValue`, 'must be a string');
    return 0;
  }
  const cents = typeof shown === 'string' ? displayedCents(shown) : null;
  if (cents !== null) return cents;
  if (typeof value.value === 'number') return dollars(r, value.value, `${path}.value`);
  if (typeof shown === 'string') r.fail(`${path}.displayValue`, MONEY_TEXT_RULE);
  else r.fail(path, 'must state its amount as money text or a number of dollars');
  return 0;
}

const optRawMoney = (r: CaptureReader, value: unknown, path: string): number | null => (isAbsent(value) ? null : rawMoney(r, value, path));

/** Fees, discounts, refunds or donations: a list of price values, or one alone. */
function rawLabeled(r: CaptureReader, value: unknown, path: string, refunds: boolean): WalmartLabeledAmount[] {
  if (isAbsent(value)) return [];
  if (!Array.isArray(value) && !isRecord(value)) {
    r.fail(path, 'must be a price value or a list of them');
    return [];
  }
  if (Array.isArray(value) && value.length > CAPTURE_MAX_ENTRIES) {
    r.fail(path, `must have at most ${CAPTURE_MAX_ENTRIES} entries`);
    return [];
  }
  const entries = Array.isArray(value) ? value : [value];
  const out: WalmartLabeledAmount[] = [];
  entries.forEach((entry, index) => {
    const at = Array.isArray(value) ? `${path}[${index}]` : path;
    if (!isRecord(entry)) {
      r.fail(at, 'must be an object');
      return;
    }
    const label = r.optString(entry.label, `${at}.label`);
    const amountMinor = rawMoney(r, entry, at);
    if (refunds) checkRefund(r, amountMinor, at);
    out.push({ label, amountMinor });
  });
  return out;
}

function rawAmounts(r: CaptureReader, value: unknown, at: string): WalmartAmounts {
  const prices = r.object(value, at);
  const grandTotal = isAbsent(prices.grandTotal) ? { value: prices.orderTotal, path: `${at}.orderTotal` } : { value: prices.grandTotal, path: `${at}.grandTotal` };
  return {
    subTotalMinor: optRawMoney(r, prices.subTotal, `${at}.subTotal`),
    taxMinor: optRawMoney(r, prices.taxTotal, `${at}.taxTotal`),
    grandTotalMinor: optRawMoney(r, grandTotal.value, grandTotal.path),
    grandTotalWithTipsMinor: optRawMoney(r, prices.grandTotalWithTips, `${at}.grandTotalWithTips`),
    driverTipMinor: optRawMoney(r, prices.driverTip, `${at}.driverTip`),
    fees: rawLabeled(r, prices.fees, `${at}.fees`, false),
    discounts: rawLabeled(r, prices.discounts, `${at}.discounts`, false),
    refunds: rawLabeled(r, prices.refund, `${at}.refund`, true),
    donations: rawLabeled(r, prices.donations, `${at}.donations`, false),
  };
}

function rawPayment(r: CaptureReader, entry: unknown, at: string): WalmartPayment {
  const row = r.object(entry, at);
  const paymentType = r.oneOf(row.paymentType, `${at}.paymentType`, WALMART_PAYMENT_TYPES);
  const cardType = r.optOneOf(row.cardType, `${at}.cardType`, WALMART_CARD_TYPES);
  const description = r.optString(row.description, `${at}.description`);
  const ending = description === null ? null : LAST4_IN_DESCRIPTION.exec(description);
  const shown = row.displayValues;
  let charged: number[] = [];
  if (Array.isArray(shown) && shown.length > 1) r.fail(`${at}.displayValues`, ONE_CHARGE_RULE);
  else if (Array.isArray(shown)) charged = shown.map((value, index) => rawMoney(r, value, `${at}.displayValues[${index}]`));
  else if (!isAbsent(shown)) charged = [rawMoney(r, shown, `${at}.displayValues`)];
  return {
    paymentType,
    cardType,
    last4: paymentType === 'CREDITCARD' && ending !== null ? ending[1] : null,
    chargedMinor: charged[0] ?? null,
  };
}

/** The status message's parts, joined and trimmed: null when there are none, or they say nothing. */
function rawStatusText(r: CaptureReader, value: unknown, path: string): string | null {
  const message = r.optObject(value, path);
  if (message === null || isAbsent(message.parts)) return null;
  const parts = r.list(message.parts, `${path}.parts`, CAPTURE_MAX_ENTRIES, (part, at) => r.optString(r.object(part, at).text, `${at}.text`) ?? '');
  return parts.join('').trim() || null;
}

function rawItem(r: CaptureReader, entry: unknown, at: string): WalmartItem {
  const item = r.object(entry, at);
  const info = r.guard<Rec>({}, () => r.optObject(item.productInfo, `${at}.productInfo`) ?? {});
  // `productInfo.<key> ?? <key>`: the product's own field first, the item's after it.
  const stated = (key: string) => (isAbsent(info[key]) ? { value: item[key], path: `${at}.${key}` } : { value: info[key], path: `${at}.productInfo.${key}` });
  const name = stated('name');
  const usItemId = stated('usItemId');
  const offerId = stated('offerId');
  const linePriceMinor = r.guard<number | null>(null, () => {
    const price = r.optObject(item.priceInfo, `${at}.priceInfo`);
    return price === null ? null : optRawMoney(r, price.linePrice, `${at}.priceInfo.linePrice`);
  });
  return {
    lineId: r.optId(item.id, `${at}.id`),
    name: r.optString(name.value, name.path),
    usItemId: r.optId(usItemId.value, usItemId.path),
    offerId: r.optId(offerId.value, offerId.path),
    qty: r.optInteger(item.quantity, `${at}.quantity`, 0, MAX_QUANTITY),
    linePriceMinor,
    unitPriceMinor: null,
    unitPriceDerived: false,
  };
}

function rawGroup(r: CaptureReader, entry: unknown, at: string): WalmartGroup {
  const group = r.object(entry, at);
  const groupId = isAbsent(group.id) ? r.optId(group.groupId, `${at}.groupId`) : r.optId(group.id, `${at}.id`);
  const fulfillmentType = r.optOneOf(group.fulfillmentType, `${at}.fulfillmentType`, WALMART_FULFILLMENT_TYPES);
  const detailedGroupType = isAbsent(group.detailedGroupType)
    ? r.optOneOf(group.derivedFulfillmentType, `${at}.derivedFulfillmentType`, WALMART_DETAILED_GROUP_TYPES)
    : r.optOneOf(group.detailedGroupType, `${at}.detailedGroupType`, WALMART_DETAILED_GROUP_TYPES);
  // The capture's own date for the status message (its year inferred) is never a raw detail's: eventDate stays null.
  const status = r.guard(noStatus(), () => {
    const stated = r.optObject(group.status, `${at}.status`);
    if (stated === null) return noStatus();
    const type = statusType(r, stated.statusType, `${at}.status.statusType`);
    return { ...type, text: r.guard<string | null>(null, () => rawStatusText(r, stated.message, `${at}.status.message`)), eventDate: null };
  });
  const deliveryDate = r.datePrefix(group.deliveryDate, `${at}.deliveryDate`);
  // An empty rfpDate is how a pickup group with no ready-for-pickup date is written: it reads as absent, as null does.
  // Only this field is read that way; any other text that isn't a date is still refused.
  const readyForPickupDate = r.datePrefix(group.rfpDate === '' ? null : group.rfpDate, `${at}.rfpDate`);
  const seller = r.guard<WalmartSeller | null>(null, () => {
    const stated = r.optObject(group.seller, `${at}.seller`);
    if (stated === null) return null;
    return {
      id: r.optId(stated.id, `${at}.seller.id`),
      name: r.optString(stated.name, `${at}.seller.name`),
      isPro: r.optBoolean(stated.isPro, `${at}.seller.isPro`),
      shownAsMarketplaceSeller: r.optBoolean(group.showSeller, `${at}.showSeller`),
      shippedByWalmart: r.optBoolean(group.isShippedByWalmart, `${at}.isShippedByWalmart`),
    };
  });
  const items = r.guard<WalmartItem[]>([], () => r.optList(group.items, `${at}.items`, CAPTURE_MAX_ENTRIES, (item, p) => rawItem(r, item, p)));
  return { groupId, fulfillmentType, detailedGroupType, status, deliveryDate, readyForPickupDate, seller, items };
}

function rawOrder(r: CaptureReader, order: Rec, orderKeyMaterial: string, capturedAt: string): WalmartOrder {
  const at = '$.order';
  const orderDateRaw = r.optString(order.orderDate, `${at}.orderDate`);
  const orderDate = r.leadingDate(orderDateRaw, `${at}.orderDate`);
  // The groups list's key carries a version (`groups_2101`): the first key starting `groups` is it. That key is the
  // capture's own text, so an issue names the list `groups`, never by its key.
  const groupsKey = Object.keys(order).find((key) => key.startsWith('groups'));
  if (groupsKey === undefined) r.fail(at, 'has no groups list (a key starting with groups)');
  const groups = groupsKey === undefined
    ? []
    : r.guard<WalmartGroup[]>([], () => r.list(order[groupsKey], `${at}.groups`, CAPTURE_MAX_ENTRIES, (group, p) => rawGroup(r, group, p)));
  const amounts = r.guard(noAmounts(), () => rawAmounts(r, order.priceDetails, `${at}.priceDetails`));
  const payments = r.guard<WalmartPayment[]>([], () =>
    r.optList(order.paymentMethods, `${at}.paymentMethods`, CAPTURE_MAX_ENTRIES, (row, p) => rawPayment(r, row, p)));
  return {
    source: 'raw-detail', orderKeyMaterial, orderDate, orderDateRaw,
    orderAt: null, timezone: null, type: null, isInStore: null, itemCount: null, statusTypes: null,
    groups, amounts, payments,
    refundPayments: null, chargeHistoryEntries: null, flags: null,
    detailCaptured: true, detailCapturedAt: capturedAt,
  };
}

/**
 * Reads one raw `detail-<orderId>.json` (`{ order, capturedAt }`) into the consolidated file's order shape, the way the
 * capture's normalizer maps it. `orderId` is the order's number (from the file's name or the consolidated record): it
 * becomes the record's key material, and an issue never shows it.
 */
export function readWalmartRawDetail(json: unknown, orderId: string): WalmartRawDetailRead {
  const read = readCapture((r): WalmartOrder => {
    const orderKeyMaterial = r.idOfForm(orderId, 'orderId', ORDER_ID, ORDER_ID_RULE);
    const root = r.object(json, '$');
    const capturedAt = r.stamp(root.capturedAt, '$.capturedAt');
    return rawOrder(r, r.object(root.order, '$.order'), orderKeyMaterial, capturedAt);
  });
  return read.ok ? { ok: true, order: read.value } : read;
}

// ---------------------------------------------------------------------------
// Comparing the two
// ---------------------------------------------------------------------------

/**
 * An order with every field a raw detail doesn't state set to null (and the unit price's derived flag false), without
 * its source: two records of one order, from the consolidated file and from its raw detail, should then be equal.
 */
export function walmartRawComparable(order: WalmartOrder): WalmartComparableOrder {
  return {
    orderKeyMaterial: order.orderKeyMaterial,
    orderDate: order.orderDate,
    orderDateRaw: order.orderDateRaw,
    orderAt: null,
    timezone: null,
    type: null,
    isInStore: null,
    itemCount: null,
    statusTypes: null,
    groups: order.groups.map((group) => ({
      ...group,
      status: { ...group.status, eventDate: null },
      seller: group.seller === null ? null : { ...group.seller },
      items: group.items.map((item) => ({ ...item, unitPriceMinor: null, unitPriceDerived: false })),
    })),
    amounts: {
      ...order.amounts,
      fees: order.amounts.fees.map((row) => ({ ...row })),
      discounts: order.amounts.discounts.map((row) => ({ ...row })),
      refunds: order.amounts.refunds.map((row) => ({ ...row })),
      donations: order.amounts.donations.map((row) => ({ ...row })),
    },
    payments: order.payments.map((payment) => ({ ...payment })),
    refundPayments: null,
    chargeHistoryEntries: null,
    flags: null,
    detailCaptured: order.detailCaptured,
    detailCapturedAt: order.detailCapturedAt,
  };
}
