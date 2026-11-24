/**
 * CollectPure captures (`holdr-retail-capture/collectpure@1`) as typed records for the metals ledger. Pure: a caller
 * reads the files and hands their parsed JSON in; nothing here touches a file system, network or clock.
 *
 * Two readers return one shape, CollectPureSellOrder, so a later converter can compare them field by field:
 * readCollectPureCapture reads the pull's consolidated `collectpure.json`, and readCollectPureRawSellOrder reads one raw
 * `sell-order-<id>.json` the way the capture's own normalizer maps it. A raw sell order doesn't state what only the
 * list pages or the capture's own readings give: those fields are null on its record, and collectPureRawComparable
 * nulls them on either record.
 *
 * Nothing here interprets a value: product names are kept as stated, money as integer cents. The capture's own line
 * readings (metal, weightOztPerUnit, weightParsedFrom) are never read, nor are free text (inspection notes, the page's
 * payout method lines and price-lock text), payout confirmation numbers, or the payout and payment methods' records.
 * An issue names a JSON path and the rule broken, never a value (captureRead.ts).
 */

import {
  CAPTURE_MAX_COUNT,
  CAPTURE_MAX_ENTRIES,
  CAPTURE_MAX_RECORDS,
  CAPTURE_MONEY_TEXT_RULE,
  CaptureReader,
  displayedCents,
  isAbsent,
  readCapture,
  type CaptureIssue,
  type CaptureJson,
  type Rec,
} from './captureRead.js';

export const COLLECTPURE_CAPTURE_SCHEMA = 'holdr-retail-capture/collectpure@1' as const;
export const COLLECTPURE_TIMELINE_STATUSES = [
  'pending_confirmation',
  'ready_for_shipment',
  'in_transit',
  'items_received',
  'check_in_progress',
  'check_in_complete',
  'order_complete',
] as const;
export type CollectPureTimelineStatus = (typeof COLLECTPURE_TIMELINE_STATUSES)[number];
/** A sell order's status key: a step of its timeline, or cancelled. */
export const COLLECTPURE_STATUS_KEYS = [...COLLECTPURE_TIMELINE_STATUSES, 'cancelled'] as const;
export type CollectPureStatusKey = (typeof COLLECTPURE_STATUS_KEYS)[number];
export const COLLECTPURE_PREMIUM_CALCULATION_TYPES = ['troy_ounce', 'unit'] as const;
export type CollectPurePremiumCalculationType = (typeof COLLECTPURE_PREMIUM_CALCULATION_TYPES)[number];
export const COLLECTPURE_LINE_STATUSES = ['Item Complete', 'Item Pending'] as const;
export type CollectPureLineStatus = (typeof COLLECTPURE_LINE_STATUSES)[number];
/**
 * The pages the pull reads, by their fixed paths (no ids: the detail page's `<id>` is a literal placeholder). A page is
 * identified by its path, never by its place in the list.
 */
export const COLLECTPURE_PAGE_PATHS = [
  '/dashboard/sell-orders',
  '/order/sell/<id>',
  '/dashboard/payouts',
  '/dashboard/payments',
  '/dashboard/buy-orders',
  '/dashboard/inventory',
  '/dashboard/vault',
  '/dashboard/developers',
  '/dashboard/listings',
  '/dashboard/offers',
] as const;
export type CollectPurePagePath = (typeof COLLECTPURE_PAGE_PATHS)[number];

const SELL_ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SELL_ORDER_ID_RULE = 'must be 1 to 64 letters, digits, hyphens or underscores';
const CHECK_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_QUANTITY = 1_000_000;

export interface CollectPureStatsCounts {
  total: number;
  active: number;
  completed: number;
  cancelled: number;
}

/** One page the pull read: which page it is and its counts only. */
export interface CollectPurePageCounts {
  /** The page's fixed path; null when it states none or one outside COLLECTPURE_PAGE_PATHS. */
  path: CollectPurePagePath | null;
  rowsSeen: number | null;
  statedTotal: number | null;
  statsCounts: CollectPureStatsCounts | null;
  detailPagesCaptured: number | null;
  of: number | null;
  /** How many pages of the list the pull read (the payouts list). */
  pages: number | null;
}

export interface CollectPureProvenance {
  /** When the pull ran, as a canonical UTC instant. */
  capturedAt: string;
  /**
   * How many sell orders' details a snapshot reused from its account's earlier capture. Null for a base capture, which
   * states no such count.
   */
  detailsReusedFromOct24Capture: number | null;
  pages: CollectPurePageCounts[];
  /** The pull's own checks by name, as the integers it states. */
  checks: Record<string, number>;
}

export interface CollectPureStatus {
  key: CollectPureStatusKey;
  label: string | null;
  pageBadge: string | null;
  detailStatus: string | null;
}

export interface CollectPureTimelineEntry {
  status: CollectPureTimelineStatus;
  at: string | null;
  /** Consolidated only, as are pageLabel and pageDate: the capture's New York date for `at`. Null from a raw sell order. */
  dateNY: string | null;
  pageLabel: string | null;
  pageDate: string | null;
}

/** An inspection field as stated: the schema doesn't type it. */
export type CollectPureInspectionValue = boolean | number | string | null;

export interface CollectPureInspection {
  receivedForInspection: CollectPureInspectionValue;
  passedInspection: CollectPureInspectionValue;
  buyerPaid: CollectPureInspectionValue;
}

export interface CollectPureLine {
  /** CollectPure's own line id, as text. */
  lineItemId: string;
  sku: string | null;
  /** The product's name as stated, never interpreted. */
  name: string | null;
  program: string | null;
  premiumCalculationType: CollectPurePremiumCalculationType | null;
  qty: number;
  unitPriceMinor: number;
  /** Consolidated only: the capture's unit price × qty, which CollectPure never states. Null from a raw sell order. */
  lineTotalMinor: number | null;
  /** True exactly when lineTotalMinor is set: that total is derived, not stated. */
  lineTotalDerived: boolean;
  /** The spot premium exactly as CollectPure states it. */
  spotPremiumRaw: string | number | null;
  spotPremiumDollarMinor: number | null;
  status: CollectPureLineStatus | null;
  inspection: CollectPureInspection | null;
}

export interface CollectPureListProduct {
  sku: string | null;
  name: string | null;
  variant: string | null;
  qty: number;
  priceMinor: number;
}

export interface CollectPureOptionalFee {
  title: string | null;
  feeMinor: number;
}

export interface CollectPureAmounts {
  subtotalMinor: number;
  shippingMinor: number | null;
  processingFeeMinor: number | null;
  salesTaxMinor: number | null;
  totalMinor: number;
  currency: 'USD';
  optionalFees: CollectPureOptionalFee[];
  /** How many promotions applied. */
  appliedPromotions: number;
  /** As stated: the schema doesn't type it. */
  instantPayoutAdvance: CaptureJson;
}

/** One line of the page's payout breakdown: its label as shown, its amount in cents. */
export interface CollectPureBreakdownEntry {
  label: string;
  amountMinor: number;
}

export interface CollectPurePayoutTransaction {
  /** SENSITIVE: CollectPure's own payout id. Key material only: never log, show, store or put it in a message. */
  payoutKeyMaterial: string;
  amountMinor: number;
  method: string | null;
  status: string | null;
  /** Consolidated only, as are payoutDate and payoutDateRaw: null from a raw sell order. */
  initiatedAt: string | null;
  payoutDate: string | null;
  payoutDateRaw: string | null;
}

export interface CollectPurePayoutDetail {
  method: string | null;
  /** The payout account's last four digits. */
  destinationLast4: string | null;
  transactions: CollectPurePayoutTransaction[];
  /** Consolidated only: the capture's total paid. Null from a raw sell order. */
  totalPaidMinor: number | null;
}

export interface CollectPureShipment {
  carrier: string | null;
  status: string | null;
  delivered: boolean | null;
  labelCreatedAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  deliveredDateLocal: string | null;
  /** As stated: the schema doesn't fix its form. */
  estDeliveryDate: string | null;
}

export type CollectPureSellOrderSource = 'consolidated' | 'raw-sell-order';

export interface CollectPureSellOrder {
  source: CollectPureSellOrderSource;
  /**
   * SENSITIVE: CollectPure's own sell-order id, exactly as stated. Key material only, which a later step hashes: never
   * log, show, store or put it in a message.
   */
  idKeyMaterial: string;
  /** Consolidated only, as are the fields to status (the list pages' and the capture's): null from a raw sell order. */
  placedAt: string | null;
  placedDateNY: string | null;
  /** As stated: the schema doesn't fix its form. */
  shipByDate: string | null;
  completeAt: string | null;
  createdAt: string | null;
  status: CollectPureStatus | null;
  timeline: CollectPureTimelineEntry[];
  lines: CollectPureLine[];
  /** Consolidated only: the list page's products. Null from a raw sell order. */
  listProducts: CollectPureListProduct[] | null;
  amounts: CollectPureAmounts;
  pageBreakdown: CollectPureBreakdownEntry[];
  payout: CollectPurePayoutDetail;
  /** Consolidated only, as are priceLockStatedOnPage and combinedSellOrderKeyMaterial: null from a raw sell order. */
  shipments: CollectPureShipment[] | null;
  priceLockStatedOnPage: boolean | null;
  /** SENSITIVE: the ids of the sell orders combined with this one. Key material only. */
  combinedSellOrderKeyMaterial: string[] | null;
  detailCaptured: boolean;
  /** When the sell order's raw file was captured, as a canonical UTC instant. */
  detailCapturedAt: string | null;
}

export interface CollectPurePayout {
  /** SENSITIVE: CollectPure's own payout id. Key material only. */
  payoutKeyMaterial: string;
  /** SENSITIVE: the paid sell order's id. Key material only. */
  sellOrderKeyMaterial: string;
  amountMinor: number;
  method: string | null;
  status: string | null;
  payoutDate: string | null;
  payoutDateRaw: string | null;
  initiatedAt: string | null;
}

export interface CollectPureCapture {
  schema: typeof COLLECTPURE_CAPTURE_SCHEMA;
  provenance: CollectPureProvenance;
  sellOrders: CollectPureSellOrder[];
  payouts: CollectPurePayout[];
  buyOrders: { statedTotal: number; rows: number; statsCounts: CollectPureStatsCounts | null };
  inventory: { statedTotal: number | null; rows: number | null; totalCount: number | null; listedCount: number | null; unlistedCount: number | null };
  /** The vault's state and how many holdings it lists; the holdings themselves aren't read. */
  vault: { enabled: boolean; state: string | null; holdingsCount: number };
}

export type CollectPureCaptureRead = { ok: true; capture: CollectPureCapture } | { ok: false; issues: CaptureIssue[] };
/**
 * Which capture a consolidated file belongs to: the account folder's own (base) capture, or a snapshot nested in it.
 * Only a snapshot's provenance names its folder (`snapshotFolder`) and how many details it reused
 * (`detailsReusedFromOct24Capture`); a base capture states neither.
 */
export type CollectPureCaptureForm = 'base' | 'snapshot';
/**
 * What a raw sell order states of itself beside the consolidated shape, where it states it (collectPureRawComparable
 * leaves both out): its own id, and its status in the page's words.
 */
export interface CollectPureRawStated {
  /** SENSITIVE: `order.id` as text (real captures state a number; the consolidated file, text). Key material only. */
  idKeyMaterial: string | null;
  /**
   * `order.status` verbatim: the status in the page's words ("Order Complete"), never the status key. The consolidated
   * record keeps the same words as `status.detailStatus`.
   */
  status: string | null;
}
export type CollectPureRawSellOrderRead =
  | { ok: true; sellOrder: CollectPureSellOrder; stated: CollectPureRawStated }
  | { ok: false; issues: CaptureIssue[] };
/** A sell order as both files state it: every field a raw sell order doesn't state is null (collectPureRawComparable). */
export type CollectPureComparableSellOrder = Omit<CollectPureSellOrder, 'source'>;

const noAmounts = (): CollectPureAmounts => ({
  subtotalMinor: 0, shippingMinor: null, processingFeeMinor: null, salesTaxMinor: null, totalMinor: 0, currency: 'USD',
  optionalFees: [], appliedPromotions: 0, instantPayoutAdvance: null,
});
const noPayout = (): CollectPurePayoutDetail => ({ method: null, destinationLast4: null, transactions: [], totalPaidMinor: null });
const noProvenance = (): CollectPureProvenance => ({ capturedAt: '', detailsReusedFromOct24Capture: 0, pages: [], checks: {} });

const sellOrderId = (r: CaptureReader, value: unknown, path: string) => r.idOfForm(value, path, SELL_ORDER_ID, SELL_ORDER_ID_RULE);

// ---------------------------------------------------------------------------
// The consolidated file
// ---------------------------------------------------------------------------

/** The consolidated file's money as cents: the API's `{ cents, currency, raw, rawUnit: 'cents' }` or the page's `{ cents, currency, raw }`. */
function money(r: CaptureReader, value: unknown, path: string): number {
  return r.guard(0, () => {
    const amount = r.object(value, path);
    r.usd(amount.currency, `${path}.currency`);
    r.textOrNumber(amount.raw, `${path}.raw`);
    if (!isAbsent(amount.rawUnit)) r.exact(amount.rawUnit, `${path}.rawUnit`, 'cents', 'must be cents');
    return r.minor(amount.cents, `${path}.cents`);
  });
}

const optMoney = (r: CaptureReader, value: unknown, path: string): number | null => (isAbsent(value) ? null : money(r, value, path));

function statsCountsOf(r: CaptureReader, value: unknown, at: string): CollectPureStatsCounts | null {
  const counts = r.optObject(value, at);
  if (counts === null) return null;
  return {
    total: r.count(counts.total, `${at}.total`),
    active: r.count(counts.active, `${at}.active`),
    completed: r.count(counts.completed, `${at}.completed`),
    cancelled: r.count(counts.cancelled, `${at}.cancelled`),
  };
}

function listedTimelineEntry(r: CaptureReader, entry: unknown, at: string): CollectPureTimelineEntry {
  const row = r.object(entry, at);
  return {
    status: r.oneOf(row.status, `${at}.status`, COLLECTPURE_TIMELINE_STATUSES),
    at: r.optStamp(row.at, `${at}.at`),
    dateNY: r.optDate(row.dateNY, `${at}.dateNY`),
    pageLabel: r.optString(row.pageLabel, `${at}.pageLabel`),
    pageDate: r.optString(row.pageDate, `${at}.pageDate`),
  };
}

function listedLine(r: CaptureReader, entry: unknown, at: string): CollectPureLine {
  const line = r.object(entry, at);
  const lineItemId = r.id(line.lineItemId, `${at}.lineItemId`);
  const sku = r.optId(line.sku, `${at}.sku`);
  const name = r.optString(line.name, `${at}.name`);
  const program = r.optString(line.program, `${at}.program`);
  const premiumCalculationType = r.optOneOf(line.premiumCalculationType, `${at}.premiumCalculationType`, COLLECTPURE_PREMIUM_CALCULATION_TYPES);
  const qty = r.integer(line.qty, `${at}.qty`, 0, MAX_QUANTITY);
  const unitPriceMinor = money(r, line.unitPrice, `${at}.unitPrice`);
  const lineTotalMinor = money(r, line.lineTotal, `${at}.lineTotal`);
  const spotPremiumRaw = r.optTextOrNumber(line.spotPremiumRaw, `${at}.spotPremiumRaw`);
  const spotPremiumDollarMinor = optMoney(r, line.spotPremiumDollar, `${at}.spotPremiumDollar`);
  const status = r.optOneOf(line.status, `${at}.status`, COLLECTPURE_LINE_STATUSES);
  // The inspection notes are free text: never read.
  const inspection = r.guard<CollectPureInspection | null>(null, () => {
    const stated = r.optObject(line.inspection, `${at}.inspection`);
    if (stated === null) return null;
    return {
      receivedForInspection: r.scalar(stated.receivedForInspection, `${at}.inspection.receivedForInspection`),
      passedInspection: r.scalar(stated.passedInspection, `${at}.inspection.passedInspection`),
      buyerPaid: r.scalar(stated.buyerPaid, `${at}.inspection.buyerPaid`),
    };
  });
  return {
    lineItemId, sku, name, program, premiumCalculationType, qty, unitPriceMinor, lineTotalMinor, lineTotalDerived: true,
    spotPremiumRaw, spotPremiumDollarMinor, status, inspection,
  };
}

function listedProduct(r: CaptureReader, entry: unknown, at: string): CollectPureListProduct {
  const row = r.object(entry, at);
  return {
    sku: r.optId(row.sku, `${at}.sku`),
    name: r.optString(row.name, `${at}.name`),
    variant: r.optString(row.variant, `${at}.variant`),
    qty: r.integer(row.qty, `${at}.qty`, 0, MAX_QUANTITY),
    priceMinor: money(r, row.price, `${at}.price`),
  };
}

function listedAmounts(r: CaptureReader, value: unknown, at: string): CollectPureAmounts {
  const amounts = r.object(value, at);
  return {
    subtotalMinor: money(r, amounts.subtotal, `${at}.subtotal`),
    shippingMinor: optMoney(r, amounts.shipping, `${at}.shipping`),
    processingFeeMinor: optMoney(r, amounts.processingFee, `${at}.processingFee`),
    salesTaxMinor: optMoney(r, amounts.salesTax, `${at}.salesTax`),
    totalMinor: money(r, amounts.total, `${at}.total`),
    currency: r.usd(amounts.currency, `${at}.currency`),
    optionalFees: r.guard<CollectPureOptionalFee[]>([], () => r.list(amounts.optionalFees, `${at}.optionalFees`, CAPTURE_MAX_ENTRIES, (entry, p) => {
      const fee = r.object(entry, p);
      return { title: r.optString(fee.title, `${p}.title`), feeMinor: money(r, fee.fee, `${p}.fee`) };
    })),
    appliedPromotions: r.count(amounts.appliedPromotions, `${at}.appliedPromotions`),
    instantPayoutAdvance: r.json(amounts.instantPayoutAdvance, `${at}.instantPayoutAdvance`),
  };
}

function listedTransaction(r: CaptureReader, entry: unknown, at: string): CollectPurePayoutTransaction {
  const row = r.object(entry, at);
  // The confirmation number is sensitive: never read.
  return {
    payoutKeyMaterial: r.id(row.payoutId, `${at}.payoutId`),
    amountMinor: money(r, row.amount, `${at}.amount`),
    method: r.optString(row.method, `${at}.method`),
    status: r.optString(row.status, `${at}.status`),
    initiatedAt: r.optStamp(row.initiatedAt, `${at}.initiatedAt`),
    payoutDate: r.optDate(row.payoutDate, `${at}.payoutDate`),
    payoutDateRaw: r.optString(row.payoutDateRaw, `${at}.payoutDateRaw`),
  };
}

function listedPayoutDetail(r: CaptureReader, value: unknown, at: string): CollectPurePayoutDetail {
  const payout = r.object(value, at);
  // The page's payout method lines name the account: never read.
  return {
    method: r.optString(payout.method, `${at}.method`),
    destinationLast4: r.optLast4(payout.destinationLast4, `${at}.destinationLast4`),
    transactions: r.guard<CollectPurePayoutTransaction[]>([], () =>
      r.list(payout.transactions, `${at}.transactions`, CAPTURE_MAX_ENTRIES, (entry, p) => listedTransaction(r, entry, p))),
    totalPaidMinor: money(r, payout.totalPaid, `${at}.totalPaid`),
  };
}

function listedShipment(r: CaptureReader, entry: unknown, at: string): CollectPureShipment {
  const row = r.object(entry, at);
  return {
    carrier: r.optString(row.carrier, `${at}.carrier`),
    status: r.optString(row.status, `${at}.status`),
    delivered: r.optBoolean(row.delivered, `${at}.delivered`),
    labelCreatedAt: r.optStamp(row.labelCreatedAt, `${at}.labelCreatedAt`),
    shippedAt: r.optStamp(row.shippedAt, `${at}.shippedAt`),
    deliveredAt: r.optStamp(row.deliveredAt, `${at}.deliveredAt`),
    deliveredDateLocal: r.optDate(row.deliveredDateLocal, `${at}.deliveredDateLocal`),
    estDeliveryDate: r.optString(row.estDeliveryDate, `${at}.estDeliveryDate`),
  };
}

function listedSellOrder(r: CaptureReader, entry: unknown, at: string, seen: Set<string>): CollectPureSellOrder {
  const order = r.object(entry, at);
  const idKeyMaterial = sellOrderId(r, order.id, `${at}.id`);
  if (idKeyMaterial !== '') {
    if (seen.has(idKeyMaterial)) r.fail(`${at}.id`, "repeats an earlier sell order's id");
    seen.add(idKeyMaterial);
  }
  // The purchase-order label is another native number, and orderDate the page's M/D/YYYY text: checked, never kept.
  r.optString(order.purchaseOrderLabel, `${at}.purchaseOrderLabel`);
  const placedAt = r.optStamp(order.placedAt, `${at}.placedAt`);
  const placedDateNY = r.optDate(order.placedDateNY, `${at}.placedDateNY`);
  r.optString(order.orderDate, `${at}.orderDate`);
  const shipByDate = r.optString(order.shipByDate, `${at}.shipByDate`);
  const completeAt = r.optStamp(order.completeAt, `${at}.completeAt`);
  const createdAt = r.optStamp(order.createdAt, `${at}.createdAt`);
  const status = r.guard<CollectPureStatus | null>(null, () => {
    const stated = r.object(order.status, `${at}.status`);
    return {
      key: r.oneOf(stated.key, `${at}.status.key`, COLLECTPURE_STATUS_KEYS),
      label: r.optString(stated.label, `${at}.status.label`),
      pageBadge: r.optString(stated.pageBadge, `${at}.status.pageBadge`),
      detailStatus: r.optString(stated.detailStatus, `${at}.status.detailStatus`),
    };
  });
  const timeline = r.guard<CollectPureTimelineEntry[]>([], () =>
    r.list(order.timeline, `${at}.timeline`, CAPTURE_MAX_ENTRIES, (row, p) => listedTimelineEntry(r, row, p)));
  const lines = r.guard<CollectPureLine[]>([], () => r.list(order.lines, `${at}.lines`, CAPTURE_MAX_ENTRIES, (row, p) => listedLine(r, row, p)));
  const listProducts = r.guard<CollectPureListProduct[]>([], () =>
    r.list(order.listProducts, `${at}.listProducts`, CAPTURE_MAX_ENTRIES, (row, p) => listedProduct(r, row, p)));
  const amounts = r.guard(noAmounts(), () => listedAmounts(r, order.amounts, `${at}.amounts`));
  const pageBreakdown = r.guard<CollectPureBreakdownEntry[]>([], () =>
    r.list(order.pageBreakdown, `${at}.pageBreakdown`, CAPTURE_MAX_ENTRIES, (row, p) => {
      const line = r.object(row, p);
      return { label: r.string(line.label, `${p}.label`), amountMinor: money(r, line.amount, `${p}.amount`) };
    }));
  const payout = r.guard(noPayout(), () => listedPayoutDetail(r, order.payout, `${at}.payout`));
  const shipments = r.guard<CollectPureShipment[]>([], () =>
    r.list(order.shipments, `${at}.shipments`, CAPTURE_MAX_ENTRIES, (row, p) => listedShipment(r, row, p)));
  // The price lock's page text is free text: never read.
  const priceLockStatedOnPage = r.guard<boolean | null>(null, () =>
    r.boolean(r.object(order.priceLock, `${at}.priceLock`).statedOnPage, `${at}.priceLock.statedOnPage`));
  const combinedSellOrderKeyMaterial = r.guard<string[]>([], () =>
    r.list(order.combinedSellOrderIds, `${at}.combinedSellOrderIds`, CAPTURE_MAX_ENTRIES, (value, p) => sellOrderId(r, value, p)));
  const detailCaptured = r.boolean(order.detailCaptured, `${at}.detailCaptured`);
  const detailCapturedAt = r.optStamp(order.detailCapturedAt, `${at}.detailCapturedAt`);
  return {
    source: 'consolidated', idKeyMaterial, placedAt, placedDateNY, shipByDate, completeAt, createdAt, status, timeline, lines,
    listProducts, amounts, pageBreakdown, payout, shipments, priceLockStatedOnPage, combinedSellOrderKeyMaterial, detailCaptured,
    detailCapturedAt,
  };
}

function listedPayout(r: CaptureReader, entry: unknown, at: string): CollectPurePayout {
  const row = r.object(entry, at);
  // The confirmation number is sensitive: never read.
  return {
    payoutKeyMaterial: r.id(row.payoutId, `${at}.payoutId`),
    sellOrderKeyMaterial: sellOrderId(r, row.sellOrderId, `${at}.sellOrderId`),
    amountMinor: money(r, row.amount, `${at}.amount`),
    method: r.optString(row.method, `${at}.method`),
    status: r.optString(row.status, `${at}.status`),
    payoutDate: r.optDate(row.payoutDate, `${at}.payoutDate`),
    payoutDateRaw: r.optString(row.payoutDateRaw, `${at}.payoutDateRaw`),
    initiatedAt: r.optStamp(row.initiatedAt, `${at}.initiatedAt`),
  };
}

function checksOf(r: CaptureReader, value: unknown, at: string): Record<string, number> {
  const checks = r.object(value, at);
  const out: Record<string, number> = {};
  for (const [name, count] of Object.entries(checks)) {
    // A check's name is the capture's own text: an issue names only the checks' fixed path, never the name.
    if (!CHECK_NAME.test(name)) r.fail(at, 'has a check name that is not a plain identifier');
    else out[name] = r.integer(count, at, -CAPTURE_MAX_COUNT, CAPTURE_MAX_COUNT);
  }
  return out;
}

function provenanceOf(r: CaptureReader, value: unknown, form: CollectPureCaptureForm): CollectPureProvenance {
  const at = '$.provenance';
  const provenance = r.object(value, at);
  r.exact(provenance.source, `${at}.source`, 'collectpure.com', 'must be collectpure.com');
  // A snapshot must state its two own keys; a base capture states neither, though either, if it is there, must read.
  const stated = (key: 'snapshotFolder' | 'detailsReusedFromOct24Capture') => form === 'snapshot' || provenance[key] !== undefined;
  if (stated('snapshotFolder')) r.string(provenance.snapshotFolder, `${at}.snapshotFolder`);
  const detailsReusedFromOct24Capture = stated('detailsReusedFromOct24Capture')
    ? r.count(provenance.detailsReusedFromOct24Capture, `${at}.detailsReusedFromOct24Capture`)
    : null;
  r.string(provenance.capturedBy, `${at}.capturedBy`);
  const capturedAt = r.stamp(provenance.capturedAt, `${at}.capturedAt`);
  r.usd(provenance.currency, `${at}.currency`);
  r.string(provenance.dateNote, `${at}.dateNote`);
  const pages = r.guard<CollectPurePageCounts[]>([], () => r.list(provenance.pages, `${at}.pages`, CAPTURE_MAX_ENTRIES, (entry, p) => {
    const page = r.object(entry, p);
    // `how` is free text that may hold digits, and the selector a query: neither is read.
    const path = r.optString(page.path, `${p}.path`);
    return {
      path: (COLLECTPURE_PAGE_PATHS as readonly string[]).includes(path ?? '') ? path as CollectPurePagePath : null,
      rowsSeen: r.optCount(page.rowsSeen, `${p}.rowsSeen`),
      statedTotal: r.optCount(page.statedTotal, `${p}.statedTotal`),
      statsCounts: r.guard(null, () => statsCountsOf(r, page.statsCounts, `${p}.statsCounts`)),
      detailPagesCaptured: r.optCount(page.detailPagesCaptured, `${p}.detailPagesCaptured`),
      of: r.optCount(page.of, `${p}.of`),
      pages: r.optCount(page.pages, `${p}.pages`),
    };
  }));
  const checks = r.guard<Record<string, number>>({}, () => checksOf(r, provenance.checks, `${at}.checks`));
  return { capturedAt, detailsReusedFromOct24Capture, pages, checks };
}

/**
 * Reads the pull's consolidated `collectpure.json`: its typed records, or every issue found (at most CAPTURE_MAX_ISSUES).
 * `form` says whose file it is, the account's base capture or a snapshot (CollectPureCaptureForm).
 */
export function readCollectPureCapture(json: unknown, form: CollectPureCaptureForm): CollectPureCaptureRead {
  const read = readCapture((r): CollectPureCapture => {
    const root = r.object(json, '$');
    if (root.schema !== COLLECTPURE_CAPTURE_SCHEMA) r.skip('$.schema', `must be ${COLLECTPURE_CAPTURE_SCHEMA}`);
    const provenance = r.guard(noProvenance(), () => provenanceOf(r, root.provenance, form));
    const seen = new Set<string>();
    const sellOrders = r.guard<CollectPureSellOrder[]>([], () =>
      r.list(root.sellOrders, '$.sellOrders', CAPTURE_MAX_RECORDS, (entry, at) => listedSellOrder(r, entry, at, seen)));
    const payouts = r.guard<CollectPurePayout[]>([], () => r.list(root.payouts, '$.payouts', CAPTURE_MAX_RECORDS, (entry, at) => listedPayout(r, entry, at)));
    // payoutMethod and paymentMethods name accounts, and listings, offers and developers aren't typed: none is read.
    const buyOrders = r.guard<CollectPureCapture['buyOrders']>({ statedTotal: 0, rows: 0, statsCounts: null }, () => {
      const stated = r.object(root.buyOrders, '$.buyOrders');
      return {
        statedTotal: r.count(stated.statedTotal, '$.buyOrders.statedTotal'),
        rows: r.count(stated.rows, '$.buyOrders.rows'),
        statsCounts: r.guard(null, () => statsCountsOf(r, stated.statsCounts, '$.buyOrders.statsCounts')),
      };
    });
    const inventory = r.guard<CollectPureCapture['inventory']>(
      { statedTotal: null, rows: null, totalCount: null, listedCount: null, unlistedCount: null },
      () => {
        const stated = r.object(root.inventory, '$.inventory');
        return {
          statedTotal: r.optCount(stated.statedTotal, '$.inventory.statedTotal'),
          rows: r.optCount(stated.rows, '$.inventory.rows'),
          totalCount: r.optCount(stated.totalCount, '$.inventory.totalCount'),
          listedCount: r.optCount(stated.listedCount, '$.inventory.listedCount'),
          unlistedCount: r.optCount(stated.unlistedCount, '$.inventory.unlistedCount'),
        };
      },
    );
    const vault = r.guard<CollectPureCapture['vault']>({ enabled: false, state: null, holdingsCount: 0 }, () => {
      const stated = r.object(root.vault, '$.vault');
      const enabled = r.boolean(stated.enabled, '$.vault.enabled');
      const state = r.optString(stated.state, '$.vault.state');
      const holdings = isAbsent(stated.holdings) ? [] : r.array(stated.holdings, '$.vault.holdings', CAPTURE_MAX_RECORDS);
      return { enabled, state, holdingsCount: holdings.length };
    });
    return { schema: COLLECTPURE_CAPTURE_SCHEMA, provenance, sellOrders, payouts, buyOrders, inventory, vault };
  });
  return read.ok ? { ok: true, capture: read.value } : read;
}

// ---------------------------------------------------------------------------
// Raw sell orders
// ---------------------------------------------------------------------------

function rawLine(r: CaptureReader, entry: unknown, at: string): CollectPureLine {
  const line = r.object(entry, at);
  const product = r.guard<Rec>({}, () => r.optObject(line.product, `${at}.product`) ?? {});
  const variant = r.guard<Rec>({}, () => r.optObject(line.variant, `${at}.variant`) ?? {});
  const lineItemId = r.id(line.id, `${at}.id`);
  const sku = r.optId(product.sku, `${at}.product.sku`);
  const name = r.optString(product.title, `${at}.product.title`);
  const program = r.optString(variant.title, `${at}.variant.title`);
  const premiumCalculationType = r.optOneOf(product.premiumCalculationType, `${at}.product.premiumCalculationType`, COLLECTPURE_PREMIUM_CALCULATION_TYPES);
  const qty = r.integer(line.quantity, `${at}.quantity`, 0, MAX_QUANTITY);
  const unitPriceMinor = r.roundedMinor(line.price, `${at}.price`);
  const spotPremiumRaw = r.optTextOrNumber(line.spotPremium, `${at}.spotPremium`);
  const spotPremiumDollarMinor = r.optMinor(line.spotPremiumDollar, `${at}.spotPremiumDollar`);
  const status = r.optOneOf(line.status, `${at}.status`, COLLECTPURE_LINE_STATUSES);
  // `recievedForInspection` is CollectPure's own spelling. The inspection notes are free text: never read.
  const inspection = r.guard<CollectPureInspection | null>(null, () => {
    const tracking = r.optObject(line.tracking, `${at}.tracking`);
    if (tracking === null) return null;
    return {
      receivedForInspection: r.scalar(tracking.recievedForInspection, `${at}.tracking.recievedForInspection`),
      passedInspection: r.scalar(tracking.passedInspection, `${at}.tracking.passedInspection`),
      buyerPaid: r.scalar(tracking.buyerPaid, `${at}.tracking.buyerPaid`),
    };
  });
  return {
    lineItemId, sku, name, program, premiumCalculationType, qty, unitPriceMinor, lineTotalMinor: null, lineTotalDerived: false,
    spotPremiumRaw, spotPremiumDollarMinor, status, inspection,
  };
}

function rawAmounts(r: CaptureReader, order: Rec, at: string): CollectPureAmounts {
  return {
    subtotalMinor: r.minor(order.subtotal, `${at}.subtotal`),
    shippingMinor: r.optMinor(order.shipping, `${at}.shipping`),
    processingFeeMinor: r.optMinor(order.processingFee, `${at}.processingFee`),
    salesTaxMinor: r.optMinor(order.salesTax, `${at}.salesTax`),
    totalMinor: r.minor(order.total, `${at}.total`),
    currency: r.usd(order.currency, `${at}.currency`),
    optionalFees: r.guard<CollectPureOptionalFee[]>([], () =>
      r.optList(order.selectedOptionals, `${at}.selectedOptionals`, CAPTURE_MAX_ENTRIES, (entry, p) => {
        const fee = r.object(entry, p);
        return { title: r.optString(fee.title, `${p}.title`), feeMinor: r.minor(fee.fee, `${p}.fee`) };
      })),
    appliedPromotions: isAbsent(order.appliedPromotions)
      ? 0
      : r.guard(0, () => r.array(order.appliedPromotions, `${at}.appliedPromotions`, CAPTURE_MAX_ENTRIES).length),
    instantPayoutAdvance: r.json(order.instantPayoutAdvance, `${at}.instantPayoutAdvance`),
  };
}

function rawPayout(r: CaptureReader, order: Rec, at: string): CollectPurePayoutDetail {
  const details = r.guard<Rec | null>(null, () => r.optObject(order.payoutDetails, `${at}.payoutDetails`));
  const ach = details === null ? null : r.guard<Rec | null>(null, () => r.optObject(details.ach, `${at}.payoutDetails.ach`));
  return {
    method: details === null ? null : r.optString(details.method, `${at}.payoutDetails.method`),
    destinationLast4: ach === null ? null : r.optLast4(ach.last4, `${at}.payoutDetails.ach.last4`),
    transactions: r.guard<CollectPurePayoutTransaction[]>([], () =>
      r.optList(order.payoutTransactions, `${at}.payoutTransactions`, CAPTURE_MAX_ENTRIES, (entry, p) => {
        const row = r.object(entry, p);
        return {
          payoutKeyMaterial: r.id(row.id, `${p}.id`),
          amountMinor: r.minor(row.amount, `${p}.amount`),
          method: r.optString(row.method, `${p}.method`),
          status: r.optString(row.status, `${p}.status`),
          initiatedAt: null,
          payoutDate: null,
          payoutDateRaw: null,
        };
      })),
    totalPaidMinor: null,
  };
}

/** The page's payout breakdown, a flat list `[label, '$x', label, '$y', …]`, as pairs. */
function rawBreakdown(r: CaptureReader, page: Rec | null, at: string): CollectPureBreakdownEntry[] {
  if (page === null || isAbsent(page.breakdown)) return [];
  const flat = r.array(page.breakdown, `${at}.breakdown`, CAPTURE_MAX_ENTRIES * 2);
  if (flat.length % 2 !== 0) {
    r.fail(`${at}.breakdown`, 'must alternate labels and amounts: an even number of entries');
    return [];
  }
  const out: CollectPureBreakdownEntry[] = [];
  for (let index = 0; index < flat.length; index += 2) {
    const label = r.string(flat[index], `${at}.breakdown[${index}]`);
    const amount = flat[index + 1];
    const path = `${at}.breakdown[${index + 1}]`;
    let amountMinor = 0;
    if (typeof amount !== 'string') r.fail(path, 'must be a string');
    else {
      const cents = displayedCents(amount);
      if (cents === null) r.fail(path, CAPTURE_MONEY_TEXT_RULE);
      else amountMinor = cents;
    }
    out.push({ label, amountMinor });
  }
  return out;
}

function rawSellOrder(r: CaptureReader, order: Rec, page: Rec | null, idKeyMaterial: string, capturedAt: string): CollectPureSellOrder {
  const at = '$.order';
  const timeline = r.guard<CollectPureTimelineEntry[]>([], () =>
    r.optList(order.statusHistory, `${at}.statusHistory`, CAPTURE_MAX_ENTRIES, (entry, p) => {
      const step = r.object(entry, p);
      return {
        status: r.oneOf(step.status, `${p}.status`, COLLECTPURE_TIMELINE_STATUSES),
        at: r.optStamp(step.changed_at, `${p}.changed_at`),
        dateNY: null,
        pageLabel: null,
        pageDate: null,
      };
    }));
  const lines = r.guard<CollectPureLine[]>([], () => r.optList(order.lineItems, `${at}.lineItems`, CAPTURE_MAX_ENTRIES, (entry, p) => rawLine(r, entry, p)));
  const amounts = rawAmounts(r, order, at);
  const pageBreakdown = r.guard<CollectPureBreakdownEntry[]>([], () => rawBreakdown(r, page, '$.page'));
  const payout = rawPayout(r, order, at);
  return {
    source: 'raw-sell-order', idKeyMaterial,
    placedAt: null, placedDateNY: null, shipByDate: null, completeAt: null, createdAt: null, status: null,
    timeline, lines, listProducts: null, amounts, pageBreakdown, payout,
    shipments: null, priceLockStatedOnPage: null, combinedSellOrderKeyMaterial: null,
    detailCaptured: true, detailCapturedAt: capturedAt,
  };
}

/**
 * Reads one raw `sell-order-<id>.json` (`{ order, page, capturedAt }`) into the consolidated file's sell-order shape, the
 * way the capture's normalizer maps it, and what the file states of itself (`stated`: its own id and its status's
 * words, where it states them). `id` is the sell order's id (from the file's name or the consolidated record): it
 * becomes the record's key material, and an issue never shows it.
 */
export function readCollectPureRawSellOrder(json: unknown, id: string): CollectPureRawSellOrderRead {
  const read = readCapture((r): { sellOrder: CollectPureSellOrder; stated: CollectPureRawStated } => {
    const idKeyMaterial = sellOrderId(r, id, 'id');
    const root = r.object(json, '$');
    const capturedAt = r.stamp(root.capturedAt, '$.capturedAt');
    const page = r.guard<Rec | null>(null, () => r.optObject(root.page, '$.page'));
    const order = r.object(root.order, '$.order');
    const stated: CollectPureRawStated = {
      idKeyMaterial: isAbsent(order.id) ? null : sellOrderId(r, order.id, '$.order.id'),
      status: r.optString(order.status, '$.order.status'),
    };
    return { sellOrder: rawSellOrder(r, order, page, idKeyMaterial, capturedAt), stated };
  });
  return read.ok ? { ok: true, sellOrder: read.value.sellOrder, stated: read.value.stated } : read;
}

// ---------------------------------------------------------------------------
// Payout history pages and stats files
// ---------------------------------------------------------------------------

/** One payout on a payout-history page. Its confirmation number is never read. */
export interface CollectPurePayoutHistoryItem {
  /** SENSITIVE: CollectPure's own payout id. Key material only. */
  payoutKeyMaterial: string;
  /** SENSITIVE: the paid sell order's id. Key material only. */
  sellOrderKeyMaterial: string;
  /** Integer cents, as the API states them. */
  amountMinor: number;
  method: string | null;
  status: string | null;
  /** The payout's calendar date as stated: `YYYY-MM-DD`, no time and no zone. */
  payoutDate: string;
  /** When the payout was created, as a canonical UTC instant. */
  createdAt: string;
}

/** A payout-history page (`raw/payout-history-pNN.json`): its payouts, and whether its pager names a next page. */
export interface CollectPurePayoutHistoryPage {
  items: CollectPurePayoutHistoryItem[];
  /** False exactly when the page's `nextCursor` is null: the pager's end. The cursor itself is never kept. */
  hasNext: boolean;
}

export type CollectPurePayoutHistoryPageRead = { ok: true; page: CollectPurePayoutHistoryPage } | { ok: false; issues: CaptureIssue[] };

/** A list's counts from its stats file (`raw/sell-stats.json`, `raw/buy-stats.json`); the value fields are never read. */
export type CollectPureOrderStatsRead = { ok: true; counts: CollectPureStatsCounts } | { ok: false; issues: CaptureIssue[] };

/** The inventory's counts from `raw/inventory-stats.json`; its value, spend and profit fields are never read. */
export interface CollectPureInventoryCounts {
  totalCount: number;
  listedCount: number;
  unlistedCount: number;
}
export type CollectPureInventoryStatsRead = { ok: true; counts: CollectPureInventoryCounts } | { ok: false; issues: CaptureIssue[] };

/**
 * The API response a raw page or stats file holds, `result.data.json`. A snapshot's copy also states when it was
 * captured, its HTTP status (which must be 200) and its source beside `result`; the base's may carry the pager's
 * `result.data.meta`. Nothing of those is kept.
 */
function apiBody(r: CaptureReader, json: unknown): Rec {
  const root = r.object(json, '$');
  if (!isAbsent(root.capturedAt)) r.stamp(root.capturedAt, '$.capturedAt');
  if (!isAbsent(root.status) && root.status !== 200) r.fail('$.status', 'must be 200');
  if (!isAbsent(root.source)) r.string(root.source, '$.source');
  const result = r.object(root.result, '$.result');
  const data = r.object(result.data, '$.result.data');
  return r.object(data.json, '$.result.data.json');
}

/** Reads one `raw/payout-history-pNN.json`: its payouts and whether another page follows, or every issue found. */
export function readCollectPurePayoutHistoryPage(json: unknown): CollectPurePayoutHistoryPageRead {
  const read = readCapture((r): CollectPurePayoutHistoryPage => {
    const body = apiBody(r, json);
    const at = '$.result.data.json';
    const items = r.guard<CollectPurePayoutHistoryItem[]>([], () => r.list(body.items, `${at}.items`, CAPTURE_MAX_ENTRIES, (entry, p) => {
      const row = r.object(entry, p);
      // The confirmation number is sensitive: never read.
      return {
        payoutKeyMaterial: r.id(row.id, `${p}.id`),
        sellOrderKeyMaterial: sellOrderId(r, row.orderId, `${p}.orderId`),
        amountMinor: r.minor(row.amount, `${p}.amount`),
        method: r.optString(row.method, `${p}.method`),
        status: r.optString(row.status, `${p}.status`),
        payoutDate: r.date(row.payoutDate, `${p}.payoutDate`),
        createdAt: r.stamp(row.createdAt, `${p}.createdAt`),
      };
    }));
    if (body.nextCursor === undefined) r.fail(`${at}.nextCursor`, 'is missing');
    else if (body.nextCursor !== null && typeof body.nextCursor !== 'number') r.fail(`${at}.nextCursor`, 'must be a number or null');
    return { items, hasNext: body.nextCursor !== null };
  });
  return read.ok ? { ok: true, page: read.value } : read;
}

/** Reads `raw/sell-stats.json` or `raw/buy-stats.json`: the list's counts, or every issue found. */
export function readCollectPureOrderStats(json: unknown): CollectPureOrderStatsRead {
  const read = readCapture((r): CollectPureStatsCounts => {
    const counts = statsCountsOf(r, apiBody(r, json), '$.result.data.json');
    return counts ?? r.skip('$.result.data.json', 'must be an object');
  });
  return read.ok ? { ok: true, counts: read.value } : read;
}

/** Reads `raw/inventory-stats.json`: the inventory's counts, or every issue found. */
export function readCollectPureInventoryStats(json: unknown): CollectPureInventoryStatsRead {
  const read = readCapture((r): CollectPureInventoryCounts => {
    const body = apiBody(r, json);
    const at = '$.result.data.json';
    return {
      totalCount: r.count(body.totalCount, `${at}.totalCount`),
      listedCount: r.count(body.listedCount, `${at}.listedCount`),
      unlistedCount: r.count(body.unlistedCount, `${at}.unlistedCount`),
    };
  });
  return read.ok ? { ok: true, counts: read.value } : read;
}

// ---------------------------------------------------------------------------
// Comparing the two
// ---------------------------------------------------------------------------

/**
 * A sell order with every field a raw sell order doesn't state set to null (and the line total's derived flag false),
 * without its source: two records of one sell order, from the consolidated file and from its raw file, should then be
 * equal. What the raw file states of itself beyond that shape (its own id and status words) is compared on its own.
 */
export function collectPureRawComparable(order: CollectPureSellOrder): CollectPureComparableSellOrder {
  return {
    idKeyMaterial: order.idKeyMaterial,
    placedAt: null,
    placedDateNY: null,
    shipByDate: null,
    completeAt: null,
    createdAt: null,
    status: null,
    timeline: order.timeline.map((entry) => ({ ...entry, dateNY: null, pageLabel: null, pageDate: null })),
    lines: order.lines.map((line) => ({
      ...line,
      lineTotalMinor: null,
      lineTotalDerived: false,
      inspection: line.inspection === null ? null : { ...line.inspection },
    })),
    listProducts: null,
    amounts: { ...order.amounts, optionalFees: order.amounts.optionalFees.map((fee) => ({ ...fee })) },
    pageBreakdown: order.pageBreakdown.map((entry) => ({ ...entry })),
    payout: {
      ...order.payout,
      transactions: order.payout.transactions.map((row) => ({ ...row, initiatedAt: null, payoutDate: null, payoutDateRaw: null })),
      totalPaidMinor: null,
    },
    shipments: null,
    priceLockStatedOnPage: null,
    combinedSellOrderKeyMaterial: null,
    detailCaptured: order.detailCaptured,
    detailCapturedAt: order.detailCapturedAt,
  };
}
