/**
 * The Costco receipts read API: the read-only "Costco receipts" page's routes (`GET /retail/costco/*`), shared by the API
 * (routes/retail.ts over services/retailRead/receipts.ts) and the web page (components/costco). The summary and the list
 * are v1; the receipt detail is v2, whose lines carry their category (`RETAIL_API_VERSIONS`).
 *
 * Receipt detail only. Each purchase is already in Spending as its card charge, so nothing here adds to any total, and
 * no answer carries a sum across receipts: a receipt's own stated totals, and its own tenders split into what a card
 * paid and what else paid, are the only money. The summary carries counts, never an amount.
 *
 * Built for PR 5 to extend, never replace: each route keeps its format name, and PR 5 adds the fields that need PR 3's
 * links or PR 4's bindings (`RETAIL_API_DEFERRED` names them) as new versions. The detail's `lines[].category` (PR 5 v3
 * §3.4's, brought forward by Costco M1) is its v2. Every v1 key keeps its name and meaning. Each body's key list is closed
 * and pinned here (`RETAIL_API_KEYS`); a reader refuses any other key and any other version.
 *
 * Without the retail tables (installed only by the Root-GO'd `holdr-retail install`) every route answers 200
 * `{ format, version, state: 'absent' }` (the format's own version), before any lookup. Tables of another shape, or a stored reserved value (plan
 * v5 §5.7), answer a fixed 409 with a closed `reason` (`RETAIL_API_CONFLICTS`), never an empty success. Every refusal
 * this API owns is one entry of `RETAIL_API_REFUSALS` (PR 5 v3 §3.7), in the same order on every route.
 *
 * Types, closed lists and literal pins only: no value, no I/O.
 */

import type { ItemTaxonomyV2NodeId } from './itemTaxonomy.js';
import type { CardOwner } from './types.js';

/** Each route's body format. PR 5's version 2 keeps these names. */
export const RETAIL_API_FORMATS = Object.freeze({
  summary: 'holdr.retail-costco-summary',
  receipts: 'holdr.retail-costco-receipts',
  receipt: 'holdr.retail-costco-receipt',
} as const);
export type RetailApiFormat = (typeof RETAIL_API_FORMATS)[keyof typeof RETAIL_API_FORMATS];

/**
 * Each format's version. The summary and the list are v1. The receipt detail is v2: v1's keys, each with its name and
 * meaning, and each line's `category` (Costco M1). A reader refuses any other version, absent bodies included.
 */
export const RETAIL_API_VERSIONS = Object.freeze({ summary: 1, receipts: 1, receipt: 2 } as const);
type RetailApiRoute = keyof typeof RETAIL_API_FORMATS;
/** A format's version, as `RETAIL_API_VERSIONS` pins it. */
export type RetailApiVersionOf<F extends RetailApiFormat> = {
  [R in RetailApiRoute]: (typeof RETAIL_API_FORMATS)[R] extends F ? (typeof RETAIL_API_VERSIONS)[R] : never;
}[RetailApiRoute];

/** `absent`: the retail tables aren't installed (nothing imported yet). `present`: they are, in exactly this build's shape. */
export const RETAIL_API_STATES = ['absent', 'present'] as const;
export type RetailApiState = (typeof RETAIL_API_STATES)[number];

/**
 * Why a read is refused with a 409, in the body's `reason` (PR 5 v3 §3.7's closed list). Nothing is read past the refusal.
 * - `schema-conflict`: the schema state `conflict`: `retail_…` objects that aren't exactly this build's (the operator's
 *   `retail-conflict`).
 * - `retail-reserved-value`: the integrity stop: a stored value reserved for the progression rule (PR 2's STOP, the
 *   same code).
 */
export const RETAIL_API_CONFLICTS = ['schema-conflict', 'retail-reserved-value'] as const;
export type RetailApiConflict = (typeof RETAIL_API_CONFLICTS)[number];

/**
 * The query names each route takes (PR 5 v3 §3.3); any other name, or a name given twice, is a 400 `query-invalid`.
 * - `membership`: one ref matching `rtl-mbr-` and 32 letters a–p, else a 400. A well-formed ref no membership has is a
 *   404 `membership-not-found` (after the state gate, before any filter or page). It keeps the receipts with an
 *   observation of that membership.
 * - `channel`: a comma list over `warehouse`, `gas` and `online`, parsed by Spending's comma lists (`list`,
 *   routes/cardTransactions.ts): items trimmed, repeats once, an empty or unknown item a 400. `channel=warehouse,gas` is
 *   the warehouse with its gas station. Its order never changes the list's order.
 * - `offset`, `limit`: `RETAIL_API_PAGE`.
 * - `q`: a search of the receipts' item lines, checked as Spending's `q` (`text`, routes/cardTransactions.ts): trimmed,
 *   empty is no search, at most `RETAIL_API_SEARCH.maxLength` characters, no control character. A receipt matches when a
 *   line of its canonical version does: the line's shown title or second description, or its item number, contains `q`
 *   (any case), or `q` reads as an amount (`12.34`, `$12.34`, `$12`) equal to the line's amount or unit price, either
 *   sign. Each matching row lists its matching lines (`matchingLines`, in the receipt's order); without a search it's
 *   null. A title the API doesn't show (`shownItemTitle`) is never searched.
 * - `category`: one node id of the shared item tree, v2 (`ITEM_TAXONOMY_V2_VIEW`), `needs-review` and `precious-metals`
 *   included; any other value is a 400 `category-unknown`. It keeps the receipts with at least one canonical line of a
 *   kind that carries a category (`RETAIL_API_CATEGORY_LINE_KINDS`) whose category's node is that node, or, for a top
 *   level, one of its subcategories. It combines with the other filters, and `total` counts after all of them.
 */
export const RETAIL_API_QUERY = Object.freeze({
  summary: [] as readonly string[],
  receipts: ['membership', 'channel', 'offset', 'limit', 'q', 'category'] as readonly string[],
  receipt: [] as readonly string[],
} as const);

/** The search's bound: Spending's own for `q` (`TEXT_LIMITS.q`). */
export const RETAIL_API_SEARCH = Object.freeze({ maxLength: 100 } as const);

/**
 * The receipts list's page bounds: `offset` 0 to `maxOffset` (default 0), `limit` 1 to `maxLimit` (default
 * `defaultLimit`), each as plain decimal digits. Anything else is a 400 (`invalid pagination`).
 */
export const RETAIL_API_PAGE = Object.freeze({ defaultLimit: 50, maxLimit: 100, maxOffset: 1_000_000 } as const);

/**
 * Every refusal this API owns (PR 5 v3 §3.7, §2.2, §11): its status, its closed `reason` and its fixed messages, the one
 * source the router answers from. The body is `{ error, reason }` (`RETAIL_API_KEYS.refusal`). No message quotes a value:
 * each is fixed, or names only an allowed query name (`queryParams`' own two 400s, which keep their messages). Inherited
 * refusals keep their own shapes: sign-in's 401, the owner guard's 403 `{ error, code: 'principal-not-allowed' }`, card
 * data's 422 `{ error, paths }`, and the mount's 404 (other `/retail` paths) and 500.
 *
 * The order is the same on every route: 403, 422, 400, 404 for a malformed ref; then, in the read transaction, 409, a 200
 * `absent`, 404 for an unknown receipt or membership, then 200.
 */
export const RETAIL_API_REFUSALS = Object.freeze({
  'query-invalid': Object.freeze({
    status: 400,
    messages: Object.freeze([
      'unexpected query parameter',
      ...RETAIL_API_QUERY.receipts.map((name) => `${name} must be given once`),
      'invalid membership',
      'channel must be a comma-separated list of warehouse, gas, online',
      'invalid pagination',
      `q must be at most ${RETAIL_API_SEARCH.maxLength} characters`,
      'q must not contain control characters',
    ]),
  }),
  'category-unknown': Object.freeze({ status: 400, messages: Object.freeze(['unknown category']) }),
  'receipt-not-found': Object.freeze({ status: 404, messages: Object.freeze(['retail receipt not found']) }),
  'membership-not-found': Object.freeze({ status: 404, messages: Object.freeze(['retail membership not found']) }),
  'schema-conflict': Object.freeze({
    status: 409, messages: Object.freeze(['the retail tables on this Holdr have another shape; nothing was read']),
  }),
  'retail-reserved-value': Object.freeze({
    status: 409, messages: Object.freeze(['the retail tables on this Holdr hold a value reserved for a later rule; nothing was read']),
  }),
} as const);
export type RetailApiRefusalReason = keyof typeof RETAIL_API_REFUSALS;

/** A receipt's channel: a warehouse receipt, a gas station receipt or an online order. */
export const RETAIL_API_CHANNELS = ['warehouse', 'gas', 'online'] as const;
export type RetailApiChannel = (typeof RETAIL_API_CHANNELS)[number];

/** The channels a capture states coverage for (gas receipts come with the warehouse's). */
export const RETAIL_API_COVERAGE_CHANNELS = ['online', 'warehouse'] as const;
export type RetailApiCoverageChannel = (typeof RETAIL_API_COVERAGE_CHANNELS)[number];

/** A receipt's state: active, or quarantined (under the owner's review; shown, never hidden). */
export const RETAIL_API_RECEIPT_STATES = ['active', 'quarantined'] as const;
export type RetailApiReceiptState = (typeof RETAIL_API_RECEIPT_STATES)[number];

/** Why a receipt is quarantined: its first reason, from the importer's closed list (plan v5 §5.3). */
export const RETAIL_API_QUARANTINE_REASONS = [
  'duplicate-across-memberships', 'receipt-changed', 'policy-reread-changed', 'receipt-held-later',
] as const;
export type RetailApiQuarantineReason = (typeof RETAIL_API_QUARANTINE_REASONS)[number];

/** The payload's closed vocabularies, as the read API shows them (pinned equal to the payload's own lists). */
export const RETAIL_API_SIGNS = ['sale', 'refund'] as const;
export type RetailApiSign = (typeof RETAIL_API_SIGNS)[number];
export const RETAIL_API_ONLINE_STATUSES = ['shipped', 'delivered', 'cancelled', 'returned', 'other'] as const;
export type RetailApiOnlineStatus = (typeof RETAIL_API_ONLINE_STATUSES)[number];
export const RETAIL_API_LINE_KINDS = ['item', 'fee', 'coupon', 'fuel'] as const;
export type RetailApiLineKind = (typeof RETAIL_API_LINE_KINDS)[number];
export const RETAIL_API_TENDER_KINDS = ['card', 'card-refund', 'debit', 'cash', 'shop-card', 'reward-certificate', 'coupon'] as const;
export type RetailApiTenderKind = (typeof RETAIL_API_TENDER_KINDS)[number];
/** The tenders that are a card charge (or its refund), already in Spending: `cardSpending`. Every other tender isn't. */
export const RETAIL_API_CARD_TENDER_KINDS = ['card', 'card-refund'] as const satisfies readonly RetailApiTenderKind[];
export const RETAIL_API_NETWORKS = ['visa', 'mastercard', 'unknown'] as const;
export type RetailApiNetwork = (typeof RETAIL_API_NETWORKS)[number];
export const RETAIL_API_FULFILMENTS = ['parcel', 'email', 'delivery-setup', 'unknown'] as const;
export type RetailApiFulfilment = (typeof RETAIL_API_FULFILMENTS)[number];
export const RETAIL_API_CARRIERS = ['ups', 'fedex', 'usps', 'other'] as const;
export type RetailApiCarrier = (typeof RETAIL_API_CARRIERS)[number];
export const RETAIL_API_STORED_VALUE_KINDS = ['costco-shop-card'] as const;
export type RetailApiStoredValueKind = (typeof RETAIL_API_STORED_VALUE_KINDS)[number];
export const RETAIL_API_METALS = ['XAU', 'XAG', 'XPT', 'XPD'] as const;
export type RetailApiMetal = (typeof RETAIL_API_METALS)[number];
export const RETAIL_API_METAL_FORMS = ['bar', 'coin', 'round', 'ingot', 'bullion'] as const;
export type RetailApiMetalForm = (typeof RETAIL_API_METAL_FORMS)[number];
export const RETAIL_API_WEIGHT_UNITS = ['ozt', 'oz', 'g', 'kg'] as const;
export type RetailApiWeightUnit = (typeof RETAIL_API_WEIGHT_UNITS)[number];
export const RETAIL_API_METAL_PACKS = ['single', 'multiple', 'unknown'] as const;
export type RetailApiMetalPack = (typeof RETAIL_API_METAL_PACKS)[number];
export const RETAIL_API_METAL_GUARD_EVIDENCE = [
  'bullion-word', 'design-after-metal', 'shape-with-weight', 'troy-or-metric-weight', 'purity', 'adjacency',
] as const;
export type RetailApiMetalGuardEvidence = (typeof RETAIL_API_METAL_GUARD_EVIDENCE)[number];
export const RETAIL_API_LINE_EVENT_KINDS = ['shipped', 'delivered', 'cancelled', 'returned'] as const;
export type RetailApiLineEventKind = (typeof RETAIL_API_LINE_EVENT_KINDS)[number];
/**
 * The line kinds that carry a category (the retail taxonomy's counted kinds, `RETAIL_TAXONOMY_LINE_KINDS`, pinned equal
 * by the API's tests). A coupon's category is null: it shows under its item.
 */
export const RETAIL_API_CATEGORY_LINE_KINDS = ['item', 'fee', 'fuel'] as const satisfies readonly RetailApiLineKind[];
/**
 * Where a line's category came from (the resolver's `RETAIL_LINE_TAXONOMY_SOURCES`, pinned equal by the API's tests): the
 * title rule (a resolution source only, never stored), or a stored row's source. Null when nothing resolved the line.
 */
export const RETAIL_API_CATEGORY_SOURCES = ['title-rule', 'owner', 'agent', 'department-review'] as const;
export type RetailApiCategorySource = (typeof RETAIL_API_CATEGORY_SOURCES)[number];

/** The memberships the page names: their owner is one of Holdr's card owners. */
export type RetailApiOwner = CardOwner;

/**
 * The refs a body carries, all opaque and random (letter hex, never derived from a natural key): `rtl-mbr-` a membership,
 * `rcp-` a receipt (the path's `:ref`), `rli-` a line, `shp-` a shipment.
 */
export const RETAIL_API_REF_PATTERNS = Object.freeze({
  membership: /^rtl-mbr-[a-p]{32}$/,
  receipt: /^rcp-[a-p]{32}$/,
  line: /^rli-[a-p]{32}$/,
  shipment: /^shp-[a-p]{32}$/,
} as const);

/**
 * The fields PR 5 adds as new versions of the same formats, by name: most need PR 3's links or PR 4's bindings snapshot.
 * The receipt detail's full `quarantine` object is PR 5's too (ROOT's A-384-1): the detail serves a receipt's `state` and
 * `quarantineReason` only. `lines[].category` came forward as the detail's v2 (Costco M1). No body carries any of these;
 * every v1 key keeps its meaning (D-384).
 */
export const RETAIL_API_DEFERRED = Object.freeze({
  receipts: ['match', 'assetHold'],
  receipt: ['match', 'assetHold', 'quarantine', 'subjects', 'returns', 'tenders[].subjects', 'tenders[].link'],
  summary: ['matches', 'returns', 'rows', 'assetHolds', 'taxonomy'],
  routes: ['GET /retail/costco/spending/taxonomy'],
} as const);

/**
 * Each body's closed key list, in the order the API writes them (PR 5 §11's discipline: literal pins, tested). A reader
 * refuses a body with any other key, a missing one, or another version.
 */
export const RETAIL_API_KEYS = Object.freeze({
  /** Every route's answer without the retail tables. */
  absent: ['format', 'version', 'state'],
  summary: ['format', 'version', 'state', 'memberships', 'receipts', 'quarantine', 'held'],
  summaryMembership: ['membershipRef', 'label', 'owner', 'receipts', 'capture'],
  /** One channel's receipts: `receipts` in the summary and in each membership, keyed by RETAIL_API_CHANNELS. */
  channelCounts: ['active', 'quarantined'],
  capture: ['ranges', 'capturedThrough'],
  captureRange: ['channel', 'from', 'to'],
  receipts: ['format', 'version', 'state', 'total', 'offset', 'limit', 'receipts'],
  receiptRow: [
    'receiptRef', 'channel', 'sign', 'status', 'date', 'currency', 'totalMinor', 'itemLines', 'memberships', 'state',
    'quarantineReason', 'tenders', 'matchingLines',
  ],
  rowTenders: ['kinds', 'cardSpendingMinor', 'otherMinor'],
  /** One line a search matched (`receiptRow.matchingLines`). */
  matchingLine: ['lineRef', 'kind', 'itemNumber', 'title', 'title2', 'quantity', 'amountMinor'],
  receipt: ['format', 'version', 'state', 'receipt'],
  receiptDetail: [
    'receiptRef', 'channel', 'state', 'quarantineReason', 'memberships', 'date', 'localTime', 'sign', 'status', 'currency',
    'totals', 'taxLegends', 'lines', 'tenders',
  ],
  totals: ['subtotalMinor', 'taxMinor', 'instantSavingsMinor', 'discountMinor', 'shippingMinor', 'feesMinor', 'storedValueMinor', 'totalMinor'],
  taxLegend: ['legend', 'amountMinor'],
  line: [
    'lineRef', 'kind', 'itemNumber', 'title', 'title2', 'quantity', 'unitPriceMinor', 'amountMinor', 'shippingMinor', 'taxFlag',
    'storedValue', 'fulfilment', 'fuel', 'couponFor', 'feeOf', 'metal', 'metalUncertain', 'events', 'shipments', 'category',
  ],
  /** A line's category (the detail's v2): the resolver's F for the line, with its node's card category. */
  lineCategory: ['node', 'cardCategory', 'source', 'confidenceBp', 'suggested', 'suggestion', 'metalHold'],
  lineCategorySuggestion: ['node', 'confidenceBp'],
  fuel: ['gallons', 'unitPrice'],
  metal: ['metal', 'form', 'statedWeight', 'pack', 'rule'],
  statedWeight: ['value', 'unit'],
  metalUncertain: ['guard', 'evidence', 'metal'],
  /** A line's events, keyed by RETAIL_API_LINE_EVENT_KINDS; each a list of `event`. */
  events: ['shipped', 'delivered', 'cancelled', 'returned'],
  event: ['quantity', 'date'],
  shipment: ['shipmentRef', 'shippedDate', 'deliveredDate', 'estimatedArrivalDate', 'carrier'],
  tender: ['kind', 'network', 'last4', 'amountMinor', 'cardSpending'],
  /** Every refusal this API owns (400, 404, 409): `RETAIL_API_REFUSALS`. */
  refusal: ['error', 'reason'],
} as const);
export type RetailApiKeyList = keyof typeof RETAIL_API_KEYS;

// ---------------------------------------------------------------------------------------------------------------------
// The bodies.
// ---------------------------------------------------------------------------------------------------------------------

/** Any route, without the retail tables: nothing imported yet. */
export interface RetailApiAbsent<F extends RetailApiFormat = RetailApiFormat> {
  format: F;
  version: RetailApiVersionOf<F>;
  state: 'absent';
}

/** One channel's receipts, counted once each (a receipt two memberships share counts once in the summary's `receipts`). */
export interface RetailApiChannelCounts {
  active: number;
  quarantined: number;
}

export type RetailApiReceiptCounts = Record<RetailApiChannel, RetailApiChannelCounts>;

/** One coverage range a capture stated, merged with its channel's overlapping or adjacent ranges. */
export interface RetailApiCaptureRange {
  channel: RetailApiCoverageChannel;
  /** YYYY-MM-DD, inclusive. */
  from: string;
  to: string;
}

export interface RetailApiCapture {
  /** By channel (RETAIL_API_COVERAGE_CHANNELS order), then `from`. */
  ranges: RetailApiCaptureRange[];
  /**
   * The latest capture over the membership's imports (PR 5 v3 §3.2): the greatest `captured_at` of its imports, as its
   * first ten characters (YYYY-MM-DD, as `holdr-retail report` prints it). Never the newest import's: an older capture
   * can be imported later. Null: no import.
   */
  capturedThrough: string | null;
}

export interface RetailApiSummaryMembership {
  membershipRef: string;
  /** The owner's own label for the membership, from its declaration. */
  label: string;
  owner: RetailApiOwner;
  /** The receipts this membership's captures hold, by channel and state (a shared receipt counts in each membership). */
  receipts: RetailApiReceiptCounts;
  capture: RetailApiCapture;
}

/** `GET /retail/costco/summary`: counts only, no amount anywhere. */
export interface RetailApiSummaryPresent {
  format: typeof RETAIL_API_FORMATS.summary;
  version: typeof RETAIL_API_VERSIONS.summary;
  state: 'present';
  /** In registration order. */
  memberships: RetailApiSummaryMembership[];
  /** Every receipt once, by channel and state. */
  receipts: RetailApiReceiptCounts;
  /** Quarantined receipts by their first reason, every reason listed (RETAIL_API_QUARANTINE_REASONS order). */
  quarantine: Record<RetailApiQuarantineReason, number>;
  /**
   * Records the converter held instead of converting (not receipts): each distinct natural key once, and every record
   * whose key couldn't be read. Shown as a count only.
   */
  held: number;
}
export type RetailApiSummary = RetailApiSummaryPresent | RetailApiAbsent<typeof RETAIL_API_FORMATS.summary>;

/** How a receipt was paid, from its own tenders only (never across receipts). */
export interface RetailApiRowTenders {
  /** The tender kinds present, each once, in RETAIL_API_TENDER_KINDS order. */
  kinds: RetailApiTenderKind[];
  /** This receipt's card and card-refund tenders, added up: the part already in Spending as card charges. */
  cardSpendingMinor: number;
  /** This receipt's other tenders (debit, cash, Shop Card, certificate, coupon), added up. */
  otherMinor: number;
}

/** One receipt in the list: its canonical version's own facts. */
export interface RetailApiReceiptRow {
  receiptRef: string;
  channel: RetailApiChannel;
  sign: RetailApiSign;
  /** An online order's status; null on a warehouse or gas receipt. */
  status: RetailApiOnlineStatus | null;
  /** YYYY-MM-DD, as Costco gives it (no time zone). */
  date: string;
  currency: 'USD';
  /** The receipt's own stated total, in cents (negative on a refund). */
  totalMinor: number;
  /** How many of its lines are items (not fees, coupons or fuel). */
  itemLines: number;
  /** The memberships whose captures hold it, by ref, in the summary's registration order. */
  memberships: string[];
  state: RetailApiReceiptState;
  /** A quarantined receipt's first reason; null when active. */
  quarantineReason: RetailApiQuarantineReason | null;
  tenders: RetailApiRowTenders;
  /** With a search (`q`), the receipt's lines it matched, in the receipt's order (never empty); without one, null. */
  matchingLines: RetailApiMatchingLine[] | null;
}

/** One line a search matched, as the receipt states it (its titles through Spending's item-title guard). */
export interface RetailApiMatchingLine {
  lineRef: string;
  kind: RetailApiLineKind;
  itemNumber: string | null;
  title: string | null;
  title2: string | null;
  quantity: number | null;
  amountMinor: number;
}

/** `GET /retail/costco/receipts?membership=&channel=&offset=&limit=&q=&category=`: date descending, then receipt ref. */
export interface RetailApiReceiptsPresent {
  format: typeof RETAIL_API_FORMATS.receipts;
  version: typeof RETAIL_API_VERSIONS.receipts;
  state: 'present';
  /** How many receipts match the filters (a count of receipts, never an amount). */
  total: number;
  offset: number;
  limit: number;
  receipts: RetailApiReceiptRow[];
}
export type RetailApiReceipts = RetailApiReceiptsPresent | RetailApiAbsent<typeof RETAIL_API_FORMATS.receipts>;

export interface RetailApiTotals {
  subtotalMinor: number | null;
  taxMinor: number | null;
  instantSavingsMinor: number | null;
  discountMinor: number | null;
  shippingMinor: number | null;
  feesMinor: number | null;
  /** An online order's Shop Card amount (0 when none); null on a warehouse or gas receipt. */
  storedValueMinor: number | null;
  totalMinor: number;
}

export interface RetailApiTaxLegend {
  /** As the receipt prints it; null when it can't be shown (the same guard as an item title). */
  legend: string | null;
  amountMinor: number;
}

/** A fuel line's gallons and price per gallon, exactly as stated (text: the price has tenths of a cent). */
export interface RetailApiFuel {
  gallons: string | null;
  unitPrice: string | null;
}

/** A line's metal evidence (title rule, by product name) and its pack: a precious metal, not everyday spending. */
export interface RetailApiLineMetal {
  metal: RetailApiMetal | null;
  form: RetailApiMetalForm | null;
  statedWeight: { value: string; unit: RetailApiWeightUnit } | null;
  pack: RetailApiMetalPack;
  /** The title rule's version label that read it. */
  rule: string;
}

/** The metal guard's flag: the line names a metal with bullion evidence but reads as no metal. */
export interface RetailApiLineMetalUncertain {
  guard: string;
  evidence: RetailApiMetalGuardEvidence[];
  metal: RetailApiMetal | null;
}

export interface RetailApiLineEvent {
  quantity: number;
  date: string;
}

export type RetailApiLineEvents = Record<RetailApiLineEventKind, RetailApiLineEvent[]>;

export interface RetailApiShipment {
  shipmentRef: string;
  shippedDate: string | null;
  /** Only from an actual delivery, never an estimate. */
  deliveredDate: string | null;
  estimatedArrivalDate: string | null;
  carrier: RetailApiCarrier | null;
}

/** One line, in the receipt's order. */
export interface RetailApiLine {
  lineRef: string;
  kind: RetailApiLineKind;
  itemNumber: string | null;
  /** Through Spending's item-title guard (`shownItemTitle`): null when it can't be shown. */
  title: string | null;
  /** A warehouse line's second description line, through the same guard. */
  title2: string | null;
  quantity: number | null;
  /** Null on a fuel line, whose price per gallon is `fuel.unitPrice`. */
  unitPriceMinor: number | null;
  amountMinor: number;
  /** Online only: the line's own shipping charge. */
  shippingMinor: number | null;
  /** Warehouse only: `Y`, `N` or a tax code, as printed. */
  taxFlag: string | null;
  storedValue: RetailApiStoredValueKind | null;
  /** Online only. */
  fulfilment: RetailApiFulfilment | null;
  /** A fuel line's facts; null on every other kind. */
  fuel: RetailApiFuel | null;
  /** A coupon: the line it discounts, by ref (null for a receipt-level discount and on every other kind). */
  couponFor: string | null;
  /** A fee: its parent line, by ref (null on every other kind). */
  feeOf: string | null;
  metal: RetailApiLineMetal | null;
  metalUncertain: RetailApiLineMetalUncertain | null;
  /** Online only (every kind listed, possibly empty); null on a warehouse or gas line. */
  events: RetailApiLineEvents | null;
  /** Online only; empty on a warehouse or gas line. */
  shipments: RetailApiShipment[];
  /** An item, fee or fuel line's category (`RETAIL_API_CATEGORY_LINE_KINDS`); null on a coupon line, shown under its item. */
  category: RetailApiLineCategory | null;
}

/**
 * A line's category: the retail taxonomy resolver's F for it (Costco 3/7 plan v5 §4.1: the title rule, then the product's
 * owner or agent, then the department's review, else Needs review), with its node's card category in the v2 tree.
 */
export interface RetailApiLineCategory {
  /** A node of the shared item tree, v2; `needs-review` when nothing resolved the line. */
  node: ItemTaxonomyV2NodeId;
  /** The node's card category in the v2 tree (an issuer category name, or the asset category). Spending never reads it. */
  cardCategory: string;
  source: RetailApiCategorySource | null;
  /** An agent's confidence in basis points (0 to 10,000); null for every other source. */
  confidenceBp: number | null;
  /** An agent's node at or above the tree's minimum but below its "suggested" bound (60% to 80%). */
  suggested: boolean;
  /** Needs review only: an agent's node below the minimum, kept as a suggestion. */
  suggestion: RetailApiLineCategorySuggestion | null;
  /** The line has precious-metal evidence (the title rule, or any stored row naming the asset node), whatever its node. */
  metalHold: boolean;
}

export interface RetailApiLineCategorySuggestion {
  node: ItemTaxonomyV2NodeId;
  confidenceBp: number;
}

export interface RetailApiTender {
  kind: RetailApiTenderKind;
  network: RetailApiNetwork;
  /** A card's last four, as the receipt states it; null on every tender that isn't a card's. */
  last4: string | null;
  /** Cents, with the receipt's sign. */
  amountMinor: number;
  /** A card or card-refund tender: already in Spending as its card charge. */
  cardSpending: boolean;
}

/** One receipt, as its canonical version states it. */
export interface RetailApiReceiptDetail {
  receiptRef: string;
  channel: RetailApiChannel;
  state: RetailApiReceiptState;
  quarantineReason: RetailApiQuarantineReason | null;
  memberships: string[];
  date: string;
  /** HH:MM or HH:MM:SS as Costco gives it, no time zone; null when not given (online orders). */
  localTime: string | null;
  sign: RetailApiSign;
  status: RetailApiOnlineStatus | null;
  currency: 'USD';
  totals: RetailApiTotals;
  taxLegends: RetailApiTaxLegend[];
  lines: RetailApiLine[];
  /** In the receipt's order. */
  tenders: RetailApiTender[];
}

/** `GET /retail/costco/receipts/:ref`. */
export interface RetailApiReceiptPresent {
  format: typeof RETAIL_API_FORMATS.receipt;
  version: typeof RETAIL_API_VERSIONS.receipt;
  state: 'present';
  receipt: RetailApiReceiptDetail;
}
export type RetailApiReceipt = RetailApiReceiptPresent | RetailApiAbsent<typeof RETAIL_API_FORMATS.receipt>;

/** A refusal's body (400 `query-invalid`, 404 `receipt-not-found` or `membership-not-found`, 409): a fixed message and its reason. */
export interface RetailApiRefusalBody {
  error: string;
  reason: RetailApiRefusalReason;
}
