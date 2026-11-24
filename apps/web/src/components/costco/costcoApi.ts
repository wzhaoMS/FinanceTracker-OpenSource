import { ITEM_TAXONOMY_BP_SCALE, ITEM_TAXONOMY_V2_VIEW, type ItemTaxonomyV2NodeId } from '@finance-tracker/shared';
import {
  RETAIL_API_CARD_TENDER_KINDS,
  RETAIL_API_CARRIERS,
  RETAIL_API_CATEGORY_LINE_KINDS,
  RETAIL_API_CATEGORY_SOURCES,
  RETAIL_API_CHANNELS,
  RETAIL_API_CONFLICTS,
  RETAIL_API_COVERAGE_CHANNELS,
  RETAIL_API_FORMATS,
  RETAIL_API_FULFILMENTS,
  RETAIL_API_KEYS,
  RETAIL_API_LINE_EVENT_KINDS,
  RETAIL_API_LINE_KINDS,
  RETAIL_API_METAL_FORMS,
  RETAIL_API_METAL_GUARD_EVIDENCE,
  RETAIL_API_METAL_PACKS,
  RETAIL_API_METALS,
  RETAIL_API_NETWORKS,
  RETAIL_API_ONLINE_STATUSES,
  RETAIL_API_PAGE,
  RETAIL_API_QUARANTINE_REASONS,
  RETAIL_API_RECEIPT_STATES,
  RETAIL_API_REF_PATTERNS,
  RETAIL_API_SEARCH,
  RETAIL_API_SIGNS,
  RETAIL_API_STORED_VALUE_KINDS,
  RETAIL_API_TENDER_KINDS,
  RETAIL_API_VERSIONS,
  RETAIL_API_WEIGHT_UNITS,
  type RetailApiCapture,
  type RetailApiCaptureRange,
  type RetailApiChannel,
  type RetailApiConflict,
  type RetailApiFuel,
  type RetailApiLine,
  type RetailApiLineCategory,
  type RetailApiLineCategorySuggestion,
  type RetailApiLineEvent,
  type RetailApiLineEvents,
  type RetailApiLineMetal,
  type RetailApiLineMetalUncertain,
  type RetailApiMatchingLine,
  type RetailApiOnlineStatus,
  type RetailApiQuarantineReason,
  type RetailApiReceipt,
  type RetailApiReceiptCounts,
  type RetailApiReceiptDetail,
  type RetailApiReceiptRow,
  type RetailApiReceipts,
  type RetailApiReceiptState,
  type RetailApiRowTenders,
  type RetailApiShipment,
  type RetailApiSummary,
  type RetailApiSummaryMembership,
  type RetailApiTaxLegend,
  type RetailApiTender,
  type RetailApiTotals,
} from '@finance-tracker/shared/retail-api';

import { api } from '../../services/api';
import { OWNERS } from '../spending/spendingFormat';

/**
 * Read-only calls for Everyday's Costco receipts page: the owner-session `GET /retail/costco/*` read API
 * (`@finance-tracker/shared/retail-api`; the summary and the list at version 1, the receipt detail at version 2, as
 * `RETAIL_API_VERSIONS` pins them), through the page's own origin like every API call (services/api.ts). Nothing here
 * writes.
 *
 * Every answer is checked whole before it is shown, against its version's closed key lists (`RETAIL_API_KEYS`): a body
 * with a key outside its list or one missing, another format, version or state, a value outside a closed vocabulary, a
 * ref of another shape, a category that isn't a node of the shared item tree (v2) with its own card category, money
 * that isn't whole cents or a date that isn't YYYY-MM-DD is refused, never shown in part. A refusal's message names
 * what was being read, never a value from the body.
 */

/** An answer this page can't read at its version. Its `what` is this file's own words, never anything the body said. */
export class CostcoAnswerError extends Error {
  constructor(readonly what: string) {
    super(`Holdr couldn't read the Costco receipts answer (${what}).`);
    this.name = 'CostcoAnswerError';
  }
}

/** A request this page won't send: a filter, page or receipt ref outside the API's own bounds. */
export class CostcoRequestError extends Error {
  constructor(readonly what: string) {
    super(`Holdr won't ask for Costco receipts with that ${what}.`);
    this.name = 'CostcoRequestError';
  }
}

export interface CostcoReceiptsQuery {
  membership?: string;
  channel?: RetailApiChannel;
  offset?: number;
  limit?: number;
  /** A search of the receipts' item lines: sent trimmed; empty is no search. */
  q?: string;
  /** One node of the shared item tree, v2: the receipts with a line in it (or, for a top level, in a subcategory). */
  category?: ItemTaxonomyV2NodeId;
}

type Json = Record<string, unknown>;

/** The bounds the retail tables hold (the API's retail schema), so nothing larger is ever shown. */
const MAX_MINOR = 10_000_000_000;
const MAX_LINES = 500;
const MAX_TENDERS = 10;
const MAX_TAX_LEGENDS = 20;
const MAX_SHIPMENTS = 20;
const MAX_EVENTS = 1000;
const MAX_MEMBERSHIPS = 1000;
const MAX_RANGES = 10_000;
const MAX_QUANTITY = 100_000;
const TITLE_MAX = 240;
const LABEL_MAX = 60;
const LEGEND_MAX = 40;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
const ITEM_NUMBER = /^\d{1,12}$/;
const TAX_FLAG = /^[A-Z0-9]$/;
const LAST4 = /^\d{4}$/;
/** Gallons and price per gallon, as stated: digits, at most one point (`3.459`, never rounded). */
const DECIMAL = /^\d[\d.]{0,15}$/;
/** A stated weight's number, qualifier kept: `1`, `0.5`, `1/10`. */
const WEIGHT = /^\d[\d./ ]{0,15}$/;
/** A rule's or guard's version label (`title-rule-v3`, `metal-guard-v1`). */
const SLUG = /^[a-z][a-z0-9-]{0,47}$/;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function refuse(what: string): never {
  throw new CostcoAnswerError(what);
}

/** An object with exactly its version's keys: no other key, none missing. */
function exact(raw: unknown, keys: readonly string[], what: string): Json {
  if (!isRecord(raw)) refuse(what);
  const own = Object.keys(raw);
  if (own.length !== keys.length || !keys.every((key) => Object.hasOwn(raw, key))) refuse(what);
  return raw;
}

function oneOf<T extends string>(values: readonly T[], value: unknown, what: string): T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) refuse(what);
  return value as T;
}

function nullable<T>(value: unknown, read: (value: unknown) => T): T | null {
  return value === null ? null : read(value);
}

/** Whole cents, either sign, within what the tables hold. */
function money(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Math.abs(value) > MAX_MINOR) refuse(what);
  return value;
}

function count(value: unknown, what: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) refuse(what);
  return value;
}

function flag(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') refuse(what);
  return value;
}

/** A calendar date, YYYY-MM-DD, that exists. */
function day(value: unknown, what: string): string {
  if (typeof value !== 'string' || !DAY.test(value)) refuse(what);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) refuse(what);
  return value;
}

function matching(value: unknown, pattern: RegExp, what: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) refuse(what);
  return value;
}

/** Shown text: 1 to `max` characters, trimmed, no control character. */
function text(value: unknown, max: number, what: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value !== value.trim()) refuse(what);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) refuse(what);
  }
  return value;
}

function list<T>(value: unknown, max: number, read: (entry: unknown) => T, what: string): T[] {
  if (!Array.isArray(value) || value.length > max) refuse(what);
  return value.map((entry) => read(entry));
}

function distinct(values: readonly string[], what: string): void {
  if (new Set(values).size !== values.length) refuse(what);
}

/** A route of the read API: its format (`RETAIL_API_FORMATS`) and its version (`RETAIL_API_VERSIONS`) share its name. */
type Route = keyof typeof RETAIL_API_FORMATS;

/**
 * A route's body: its own format and its format's own version first (`RETAIL_API_VERSIONS`, absent bodies too), then
 * its state. `absent` is exactly the three keys; `present` is exactly the route's own list. Returns null when absent.
 */
function present(raw: unknown, route: Route, keys: readonly string[]): Json | null {
  if (!isRecord(raw) || raw.format !== RETAIL_API_FORMATS[route]) refuse('format');
  if (raw.version !== RETAIL_API_VERSIONS[route]) refuse('version');
  if (raw.state === 'absent') {
    exact(raw, RETAIL_API_KEYS.absent, 'answer');
    return null;
  }
  if (raw.state !== 'present') refuse('state');
  return exact(raw, keys, 'answer');
}

function receiptCounts(raw: unknown, what: string): RetailApiReceiptCounts {
  const body = exact(raw, RETAIL_API_CHANNELS, what);
  const counts = {} as RetailApiReceiptCounts;
  for (const channel of RETAIL_API_CHANNELS) {
    const entry = exact(body[channel], RETAIL_API_KEYS.channelCounts, what);
    counts[channel] = { active: count(entry.active, what), quarantined: count(entry.quarantined, what) };
  }
  return counts;
}

function captureRange(raw: unknown): RetailApiCaptureRange {
  const body = exact(raw, RETAIL_API_KEYS.captureRange, 'capture range');
  const range = {
    channel: oneOf(RETAIL_API_COVERAGE_CHANNELS, body.channel, 'capture range'),
    from: day(body.from, 'capture range'),
    to: day(body.to, 'capture range'),
  };
  if (range.from > range.to) refuse('capture range');
  return range;
}

function capture(raw: unknown): RetailApiCapture {
  const body = exact(raw, RETAIL_API_KEYS.capture, 'capture');
  return {
    ranges: list(body.ranges, MAX_RANGES, captureRange, 'capture ranges'),
    capturedThrough: nullable(body.capturedThrough, (value) => day(value, 'captured through')),
  };
}

function membership(raw: unknown): RetailApiSummaryMembership {
  const body = exact(raw, RETAIL_API_KEYS.summaryMembership, 'membership');
  return {
    membershipRef: matching(body.membershipRef, RETAIL_API_REF_PATTERNS.membership, 'membership ref'),
    label: text(body.label, LABEL_MAX, 'membership label'),
    owner: oneOf(OWNERS, body.owner, 'membership owner'),
    receipts: receiptCounts(body.receipts, 'membership counts'),
    capture: capture(body.capture),
  };
}

/** `GET /retail/costco/summary`: counts only. */
export function parseCostcoSummary(raw: unknown): RetailApiSummary {
  const format = RETAIL_API_FORMATS.summary;
  const version = RETAIL_API_VERSIONS.summary;
  const body = present(raw, 'summary', RETAIL_API_KEYS.summary);
  if (body === null) return { format, version, state: 'absent' };
  const memberships = list(body.memberships, MAX_MEMBERSHIPS, membership, 'memberships');
  distinct(memberships.map((entry) => entry.membershipRef), 'memberships');
  const quarantine = exact(body.quarantine, RETAIL_API_QUARANTINE_REASONS, 'quarantine counts');
  return {
    format,
    version,
    state: 'present',
    memberships,
    receipts: receiptCounts(body.receipts, 'receipt counts'),
    quarantine: Object.fromEntries(RETAIL_API_QUARANTINE_REASONS.map((reason) => [reason, count(quarantine[reason], 'quarantine counts')])) as
      Record<RetailApiQuarantineReason, number>,
    held: count(body.held, 'held'),
  };
}

/** An online order's status; a warehouse or gas receipt has none. */
function onlineStatus(value: unknown, channel: RetailApiChannel, what: string): RetailApiOnlineStatus | null {
  if (value === null) return null;
  if (channel !== 'online') refuse(what);
  return oneOf(RETAIL_API_ONLINE_STATUSES, value, what);
}

/** A quarantined receipt's first reason; an active one has none. */
function quarantineReason(value: unknown, state: RetailApiReceiptState, what: string): RetailApiQuarantineReason | null {
  if (state === 'active') {
    if (value !== null) refuse(what);
    return null;
  }
  return oneOf(RETAIL_API_QUARANTINE_REASONS, value, what);
}

function membershipRefs(value: unknown, what: string): string[] {
  const refs = list(value, MAX_MEMBERSHIPS, (entry) => matching(entry, RETAIL_API_REF_PATTERNS.membership, what), what);
  distinct(refs, what);
  return refs;
}

function usd(value: unknown, what: string): 'USD' {
  if (value !== 'USD') refuse(what);
  return value;
}

function rowTenders(raw: unknown): RetailApiRowTenders {
  const body = exact(raw, RETAIL_API_KEYS.rowTenders, 'receipt tenders');
  const kinds = list(body.kinds, RETAIL_API_TENDER_KINDS.length, (value) => oneOf(RETAIL_API_TENDER_KINDS, value, 'tender kinds'), 'tender kinds');
  distinct(kinds, 'tender kinds');
  return {
    // Each kind once, in the contract's order.
    kinds: RETAIL_API_TENDER_KINDS.filter((kind) => kinds.includes(kind)),
    cardSpendingMinor: money(body.cardSpendingMinor, 'receipt tenders'),
    otherMinor: money(body.otherMinor, 'receipt tenders'),
  };
}

/** One line a search matched. */
function matchingLine(raw: unknown): RetailApiMatchingLine {
  const what = 'matching line';
  const body = exact(raw, RETAIL_API_KEYS.matchingLine, what);
  return {
    lineRef: matching(body.lineRef, RETAIL_API_REF_PATTERNS.line, what),
    kind: oneOf(RETAIL_API_LINE_KINDS, body.kind, what),
    itemNumber: nullable(body.itemNumber, (value) => matching(value, ITEM_NUMBER, what)),
    title: nullable(body.title, (value) => text(value, TITLE_MAX, what)),
    title2: nullable(body.title2, (value) => text(value, TITLE_MAX, what)),
    quantity: nullable(body.quantity, (value) => count(value, what, -MAX_QUANTITY, MAX_QUANTITY)),
    amountMinor: money(body.amountMinor, what),
  };
}

/** A row's matching lines: null without a search; with one, at least one line, each once. */
function matchingLines(value: unknown): RetailApiMatchingLine[] | null {
  if (value === null) return null;
  const lines = list(value, MAX_LINES, matchingLine, 'matching lines');
  if (lines.length === 0) refuse('matching lines');
  distinct(lines.map((line) => line.lineRef), 'matching lines');
  return lines;
}

function receiptRow(raw: unknown): RetailApiReceiptRow {
  const what = 'receipt row';
  const body = exact(raw, RETAIL_API_KEYS.receiptRow, what);
  const channel = oneOf(RETAIL_API_CHANNELS, body.channel, what);
  const state = oneOf(RETAIL_API_RECEIPT_STATES, body.state, what);
  return {
    receiptRef: matching(body.receiptRef, RETAIL_API_REF_PATTERNS.receipt, 'receipt ref'),
    channel,
    sign: oneOf(RETAIL_API_SIGNS, body.sign, what),
    status: onlineStatus(body.status, channel, what),
    date: day(body.date, what),
    currency: usd(body.currency, what),
    totalMinor: money(body.totalMinor, what),
    itemLines: count(body.itemLines, what, 0, MAX_LINES),
    memberships: membershipRefs(body.memberships, what),
    state,
    quarantineReason: quarantineReason(body.quarantineReason, state, what),
    tenders: rowTenders(body.tenders),
    matchingLines: matchingLines(body.matchingLines),
  };
}

/** `GET /retail/costco/receipts`: one page of receipts, each its own facts only. */
export function parseCostcoReceipts(raw: unknown): RetailApiReceipts {
  const format = RETAIL_API_FORMATS.receipts;
  const version = RETAIL_API_VERSIONS.receipts;
  const body = present(raw, 'receipts', RETAIL_API_KEYS.receipts);
  if (body === null) return { format, version, state: 'absent' };
  const total = count(body.total, 'page');
  const offset = count(body.offset, 'page', 0, RETAIL_API_PAGE.maxOffset);
  const limit = count(body.limit, 'page', 1, RETAIL_API_PAGE.maxLimit);
  const receipts = list(body.receipts, limit, receiptRow, 'receipts');
  distinct(receipts.map((row) => row.receiptRef), 'receipts');
  // A page never holds more receipts than are left after its offset.
  if (receipts.length > Math.max(0, total - offset)) refuse('page');
  return { format, version, state: 'present', total, offset, limit, receipts };
}

function totals(raw: unknown): RetailApiTotals {
  const what = 'totals';
  const body = exact(raw, RETAIL_API_KEYS.totals, what);
  const stated = (value: unknown) => nullable(value, (amount) => money(amount, what));
  return {
    subtotalMinor: stated(body.subtotalMinor),
    taxMinor: stated(body.taxMinor),
    instantSavingsMinor: stated(body.instantSavingsMinor),
    discountMinor: stated(body.discountMinor),
    shippingMinor: stated(body.shippingMinor),
    feesMinor: stated(body.feesMinor),
    storedValueMinor: stated(body.storedValueMinor),
    totalMinor: money(body.totalMinor, what),
  };
}

function taxLegend(raw: unknown): RetailApiTaxLegend {
  const body = exact(raw, RETAIL_API_KEYS.taxLegend, 'tax legend');
  return {
    legend: nullable(body.legend, (value) => text(value, LEGEND_MAX, 'tax legend')),
    amountMinor: money(body.amountMinor, 'tax legend'),
  };
}

function fuel(raw: unknown): RetailApiFuel {
  const body = exact(raw, RETAIL_API_KEYS.fuel, 'fuel');
  const decimal = (value: unknown) => {
    const stated = matching(value, DECIMAL, 'fuel');
    if (stated.indexOf('.') !== stated.lastIndexOf('.')) refuse('fuel');
    return stated;
  };
  return { gallons: nullable(body.gallons, decimal), unitPrice: nullable(body.unitPrice, decimal) };
}

function lineMetal(raw: unknown): RetailApiLineMetal {
  const what = 'metal';
  const body = exact(raw, RETAIL_API_KEYS.metal, what);
  return {
    metal: nullable(body.metal, (value) => oneOf(RETAIL_API_METALS, value, what)),
    form: nullable(body.form, (value) => oneOf(RETAIL_API_METAL_FORMS, value, what)),
    statedWeight: nullable(body.statedWeight, (value) => {
      const weight = exact(value, RETAIL_API_KEYS.statedWeight, what);
      return { value: matching(weight.value, WEIGHT, what), unit: oneOf(RETAIL_API_WEIGHT_UNITS, weight.unit, what) };
    }),
    pack: oneOf(RETAIL_API_METAL_PACKS, body.pack, what),
    rule: matching(body.rule, SLUG, what),
  };
}

function lineMetalUncertain(raw: unknown): RetailApiLineMetalUncertain {
  const what = 'uncertain metal';
  const body = exact(raw, RETAIL_API_KEYS.metalUncertain, what);
  const evidence = list(body.evidence, RETAIL_API_METAL_GUARD_EVIDENCE.length,
    (value) => oneOf(RETAIL_API_METAL_GUARD_EVIDENCE, value, what), what);
  distinct(evidence, what);
  return {
    guard: matching(body.guard, SLUG, what),
    evidence,
    metal: nullable(body.metal, (value) => oneOf(RETAIL_API_METALS, value, what)),
  };
}

function lineEvent(raw: unknown): RetailApiLineEvent {
  const body = exact(raw, RETAIL_API_KEYS.event, 'line event');
  return { quantity: count(body.quantity, 'line event', 1, MAX_QUANTITY), date: day(body.date, 'line event') };
}

function lineEvents(raw: unknown): RetailApiLineEvents {
  const body = exact(raw, RETAIL_API_KEYS.events, 'line events');
  const events = {} as RetailApiLineEvents;
  for (const kind of RETAIL_API_LINE_EVENT_KINDS) events[kind] = list(body[kind], MAX_EVENTS, lineEvent, 'line events');
  return events;
}

function shipment(raw: unknown): RetailApiShipment {
  const what = 'shipment';
  const body = exact(raw, RETAIL_API_KEYS.shipment, what);
  const date = (value: unknown) => nullable(value, (stated) => day(stated, what));
  return {
    shipmentRef: matching(body.shipmentRef, RETAIL_API_REF_PATTERNS.shipment, what),
    shippedDate: date(body.shippedDate),
    deliveredDate: date(body.deliveredDate),
    estimatedArrivalDate: date(body.estimatedArrivalDate),
    carrier: nullable(body.carrier, (value) => oneOf(RETAIL_API_CARRIERS, value, what)),
  };
}

/** A node of the shared item tree, v2 (`needs-review` and `precious-metals` among them). */
function taxonomyNode(value: unknown, what: string): ItemTaxonomyV2NodeId {
  if (!ITEM_TAXONOMY_V2_VIEW.isNode(value)) refuse(what);
  return value;
}

/** A confidence in basis points: a whole number from 0 to `ITEM_TAXONOMY_BP_SCALE`. */
function basisPoints(value: unknown, what: string): number {
  return count(value, what, 0, ITEM_TAXONOMY_BP_SCALE);
}

function lineCategorySuggestion(raw: unknown): RetailApiLineCategorySuggestion {
  const what = 'category suggestion';
  const body = exact(raw, RETAIL_API_KEYS.lineCategorySuggestion, what);
  return { node: taxonomyNode(body.node, what), confidenceBp: basisPoints(body.confidenceBp, what) };
}

/** A line's category (the detail's v2): a node of the item tree, v2, with that node's own card category in the tree. */
function lineCategory(raw: unknown): RetailApiLineCategory {
  const what = 'line category';
  const body = exact(raw, RETAIL_API_KEYS.lineCategory, what);
  const node = taxonomyNode(body.node, what);
  const { cardCategory } = ITEM_TAXONOMY_V2_VIEW.node(node)!;
  if (body.cardCategory !== cardCategory) refuse(what);
  return {
    node,
    cardCategory,
    source: nullable(body.source, (value) => oneOf(RETAIL_API_CATEGORY_SOURCES, value, what)),
    confidenceBp: nullable(body.confidenceBp, (value) => basisPoints(value, what)),
    suggested: flag(body.suggested, what),
    suggestion: nullable(body.suggestion, lineCategorySuggestion),
    metalHold: flag(body.metalHold, what),
  };
}

function line(raw: unknown, channel: RetailApiChannel): RetailApiLine {
  const what = 'line';
  const body = exact(raw, RETAIL_API_KEYS.line, what);
  const kind = oneOf(RETAIL_API_LINE_KINDS, body.kind, what);
  const lineRef = (value: unknown) => matching(value, RETAIL_API_REF_PATTERNS.line, what);
  const parsed: RetailApiLine = {
    lineRef: lineRef(body.lineRef),
    kind,
    itemNumber: nullable(body.itemNumber, (value) => matching(value, ITEM_NUMBER, what)),
    title: nullable(body.title, (value) => text(value, TITLE_MAX, what)),
    title2: nullable(body.title2, (value) => text(value, TITLE_MAX, what)),
    quantity: nullable(body.quantity, (value) => count(value, what, -MAX_QUANTITY, MAX_QUANTITY)),
    unitPriceMinor: nullable(body.unitPriceMinor, (value) => money(value, what)),
    amountMinor: money(body.amountMinor, what),
    shippingMinor: nullable(body.shippingMinor, (value) => money(value, what)),
    taxFlag: nullable(body.taxFlag, (value) => matching(value, TAX_FLAG, what)),
    storedValue: nullable(body.storedValue, (value) => oneOf(RETAIL_API_STORED_VALUE_KINDS, value, what)),
    fulfilment: nullable(body.fulfilment, (value) => oneOf(RETAIL_API_FULFILMENTS, value, what)),
    fuel: nullable(body.fuel, fuel),
    couponFor: nullable(body.couponFor, lineRef),
    feeOf: nullable(body.feeOf, lineRef),
    metal: nullable(body.metal, lineMetal),
    metalUncertain: nullable(body.metalUncertain, lineMetalUncertain),
    events: nullable(body.events, lineEvents),
    shipments: list(body.shipments, MAX_SHIPMENTS, shipment, 'shipments'),
    category: nullable(body.category, lineCategory),
  };
  // Each fact only where the contract puts it: fuel on a fuel line, a coupon's target on a coupon, a fee's parent on a
  // fee, metal evidence or the guard's flag (never both), events and shipments on an online order's lines, and a
  // category on exactly the kinds that carry one (an item, fee or fuel line; a coupon's shows under its item).
  const categorized = (RETAIL_API_CATEGORY_LINE_KINDS as readonly string[]).includes(kind);
  if ((parsed.fuel !== null && kind !== 'fuel') || (parsed.couponFor !== null && kind !== 'coupon')
    || (parsed.feeOf !== null && kind !== 'fee') || (parsed.metal !== null && parsed.metalUncertain !== null)
    || (channel !== 'online' && (parsed.events !== null || parsed.shipments.length > 0))
    || (parsed.category !== null) !== categorized) refuse(what);
  distinct(parsed.shipments.map((entry) => entry.shipmentRef), 'shipments');
  return parsed;
}

function tender(raw: unknown): RetailApiTender {
  const what = 'tender';
  const body = exact(raw, RETAIL_API_KEYS.tender, what);
  const kind = oneOf(RETAIL_API_TENDER_KINDS, body.kind, what);
  const card = (RETAIL_API_CARD_TENDER_KINDS as readonly string[]).includes(kind);
  const last4 = nullable(body.last4, (value) => matching(value, LAST4, what));
  // A card or card-refund tender is already in Spending (`cardSpending`); only a card's tender states a last four.
  if (body.cardSpending !== card || (!card && last4 !== null)) refuse(what);
  return {
    kind,
    network: oneOf(RETAIL_API_NETWORKS, body.network, what),
    last4,
    amountMinor: money(body.amountMinor, what),
    cardSpending: card,
  };
}

function receiptDetail(raw: unknown): RetailApiReceiptDetail {
  const what = 'receipt';
  const body = exact(raw, RETAIL_API_KEYS.receiptDetail, what);
  const channel = oneOf(RETAIL_API_CHANNELS, body.channel, what);
  const state = oneOf(RETAIL_API_RECEIPT_STATES, body.state, what);
  const lines = list(body.lines, MAX_LINES, (entry) => line(entry, channel), 'lines');
  distinct(lines.map((entry) => entry.lineRef), 'lines');
  return {
    receiptRef: matching(body.receiptRef, RETAIL_API_REF_PATTERNS.receipt, 'receipt ref'),
    channel,
    state,
    quarantineReason: quarantineReason(body.quarantineReason, state, what),
    memberships: membershipRefs(body.memberships, what),
    date: day(body.date, what),
    localTime: nullable(body.localTime, (value) => matching(value, LOCAL_TIME, what)),
    sign: oneOf(RETAIL_API_SIGNS, body.sign, what),
    status: onlineStatus(body.status, channel, what),
    currency: usd(body.currency, what),
    totals: totals(body.totals),
    taxLegends: list(body.taxLegends, MAX_TAX_LEGENDS, taxLegend, 'tax legends'),
    lines,
    tenders: list(body.tenders, MAX_TENDERS, tender, 'tenders'),
  };
}

/** `GET /retail/costco/receipts/:ref`: one receipt, as its canonical version states it, each line with its category (v2). */
export function parseCostcoReceipt(raw: unknown): RetailApiReceipt {
  const format = RETAIL_API_FORMATS.receipt;
  const version = RETAIL_API_VERSIONS.receipt;
  const body = present(raw, 'receipt', RETAIL_API_KEYS.receipt);
  if (body === null) return { format, version, state: 'absent' };
  return { format, version, state: 'present', receipt: receiptDetail(body.receipt) };
}

/** A 409's closed reason, or null when the body isn't exactly `{ error, reason }` with a known reason. */
export function parseCostcoConflict(raw: unknown): RetailApiConflict | null {
  try {
    const body = exact(raw, RETAIL_API_KEYS.refusal, 'conflict');
    if (typeof body.error !== 'string') return null;
    return oneOf(RETAIL_API_CONFLICTS, body.reason, 'conflict');
  } catch {
    return null;
  }
}

/** The list's address: only the API's query names, each value checked, then encoded. */
export function costcoReceiptsPath(query: CostcoReceiptsQuery = {}): string {
  const params = new URLSearchParams();
  if (query.membership !== undefined) {
    if (!RETAIL_API_REF_PATTERNS.membership.test(query.membership)) throw new CostcoRequestError('membership');
    params.set('membership', query.membership);
  }
  if (query.channel !== undefined) {
    if (!(RETAIL_API_CHANNELS as readonly string[]).includes(query.channel)) throw new CostcoRequestError('channel');
    params.set('channel', query.channel);
  }
  const page = (value: number, min: number, max: number) => {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new CostcoRequestError('page');
    return String(value);
  };
  if (query.offset !== undefined) params.set('offset', page(query.offset, 0, RETAIL_API_PAGE.maxOffset));
  if (query.limit !== undefined) params.set('limit', page(query.limit, 1, RETAIL_API_PAGE.maxLimit));
  if (query.q !== undefined) {
    // The API's own check (Spending's `q`): trimmed, bounded, no control character; empty is no search.
    const search = query.q.trim();
    if (search.length > RETAIL_API_SEARCH.maxLength || /[\u0000-\u001f\u007f]/.test(search)) throw new CostcoRequestError('search');
    if (search !== '') params.set('q', search);
  }
  if (query.category !== undefined) {
    // One node of the shared item tree, v2; the API answers any other value with a 400 `category-unknown`.
    if (!ITEM_TAXONOMY_V2_VIEW.isNode(query.category)) throw new CostcoRequestError('category');
    params.set('category', query.category);
  }
  const search = params.toString();
  return search ? `/retail/costco/receipts?${search}` : '/retail/costco/receipts';
}

export async function fetchCostcoSummary(): Promise<RetailApiSummary> {
  return parseCostcoSummary(await api<unknown>('/retail/costco/summary'));
}

/** One page of receipts. An answer for another page, or with a receipt outside the filters asked for, is refused. */
export async function fetchCostcoReceipts(query: CostcoReceiptsQuery = {}): Promise<RetailApiReceipts> {
  const path = costcoReceiptsPath(query);
  const page = parseCostcoReceipts(await api<unknown>(path));
  if (page.state === 'absent') return page;
  if (page.offset !== (query.offset ?? 0) || page.limit !== (query.limit ?? RETAIL_API_PAGE.defaultLimit)) refuse('page');
  const membershipRef = query.membership;
  if ((query.channel !== undefined && page.receipts.some((row) => row.channel !== query.channel))
    || (membershipRef !== undefined && page.receipts.some((row) => !row.memberships.includes(membershipRef)))) refuse('receipts');
  // A search's rows each carry their matching lines; rows without a search carry none.
  const searching = query.q !== undefined && query.q.trim() !== '';
  if (page.receipts.some((row) => (row.matchingLines !== null) !== searching)) refuse('receipts');
  return page;
}

/** One receipt by its opaque ref; a ref of any other shape is never sent. */
export async function fetchCostcoReceipt(ref: string): Promise<RetailApiReceipt> {
  if (!RETAIL_API_REF_PATTERNS.receipt.test(ref)) throw new CostcoRequestError('receipt ref');
  const answer = parseCostcoReceipt(await api<unknown>(`/retail/costco/receipts/${ref}`));
  if (answer.state === 'present' && answer.receipt.receiptRef !== ref) refuse('receipt ref');
  return answer;
}
