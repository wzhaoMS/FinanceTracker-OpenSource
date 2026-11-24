/**
 * The retail import payload, `holdr.retail-import` v3. It holds one membership's receipts and online orders, as the
 * offline converter (`holdr-retail-convert`) writes them for the Root-GO'd `holdr-retail import`. Version 2 added the
 * Shop Card facts (an online order's `totals.storedValueMinor` and a line's `storedValue` flag), a held record's `date`
 * and a metal line's `pack`. Version 3 adds a line's `metalUncertain` flag (metal guard v1).
 *
 * It is owner-only: it holds values (dates, amounts, item names, card last fours), redacted. It never holds a capture's
 * names, addresses, membership number, tracking numbers, register or transaction numbers, or native receipt, order and
 * line numbers; those are one-way hashes in letter hex, which has no digits. Pure: no file system or network.
 *
 * `validateRetailImportPayload` checks every field by type and value, and independently re-checks each receipt's money
 * identities, so an importer never trusts the converter that wrote the file.
 */

import { containsCardData } from '../cardNumbers.js';
import { cardImportTextProblem } from '../cardImport.js';
import { sha256, toLetterHex } from '../cardDedupe.js';
import {
  RETAIL_METAL_FORMS,
  RETAIL_METAL_GUARD,
  RETAIL_METAL_GUARD_EVIDENCE,
  RETAIL_METAL_TITLE_RULE,
  RETAIL_METALS,
  RETAIL_WEIGHT_UNITS,
  type RetailMetal,
  type RetailMetalEvidence,
  type RetailMetalGuard,
  type RetailMetalGuardEvidence,
} from './metalTitleRule.js';
import { RETAIL_METAL_PACKS, type RetailMetalPack } from './metalPackRule.js';

/**
 * The closed vocabularies and rule labels a payload's metal facts are written in, part of its contract. The importer reads
 * the contract through this module's own package export (`@finance-tracker/shared/retail-import-payload`), never through
 * the tool's index, so that no API module reaches the converter.
 */
export {
  RETAIL_METAL_FORMS,
  RETAIL_METAL_GUARD,
  RETAIL_METAL_GUARD_EVIDENCE,
  RETAIL_METAL_TITLE_RULE,
  RETAIL_METALS,
  RETAIL_WEIGHT_UNITS,
  type RetailMetal,
  type RetailMetalEvidence,
  type RetailMetalForm,
  type RetailMetalGuard,
  type RetailMetalGuardEvidence,
  type RetailMetalTitleRule,
  type RetailWeightUnit,
} from './metalTitleRule.js';
export { RETAIL_METAL_PACK_RULE, RETAIL_METAL_PACKS, type RetailMetalPack, type RetailMetalPackRule } from './metalPackRule.js';

export const RETAIL_IMPORT_FORMAT = 'holdr.retail-import' as const;
export const RETAIL_IMPORT_VERSION = 3 as const;
/**
 * The version of the rules that turn a capture into a payload's facts: the checks and holds, redaction, coupon and fee
 * resolution, and the metal title rule. Any change that can change a payload's facts is a new version, so an importer
 * can tell a changed capture from changed rules. The converter's own version (`converterVersion`) names the program.
 * - Version 1 was the provisional dry run's; no payload was written under it.
 * - Version 2 (title rule v1, converter 1.1.0) wrote only the dry run's payloads, and none was imported.
 * - Version 3 (title rule v2, converter 1.2.0) reads a year right before an exact weight as a word.
 * - Version 4 (title rule v2, pack rule metals-pack-v1, converter 1.3.0, format v2) converts online wallet Shop Card
 *   payments, flags Shop Card purchase lines by an exact catalog allowlist, keeps a held record's date when both capture
 *   files agree on it, and gives each metal line its pack.
 * - Version 5 (title rule v3, metal guard v1, pack rule metals-pack-v2, converter 1.4.0, format v3) reads a bar sold in
 *   an assay card as metal, and flags every line that names a metal with bullion evidence but reads as no metal
 *   (`metalUncertain`, Root's fail-closed guard): such a line is never silently no metal.
 */
export const RETAIL_CONVERT_POLICY_VERSION = 5 as const;
export const RETAIL_MERCHANTS = ['costco'] as const;
export type RetailMerchant = (typeof RETAIL_MERCHANTS)[number];
export const COSTCO_CAPTURE_SCHEMA = 'holdr-retail-capture/costco@1' as const;

export const RETAIL_CHANNELS = ['warehouse', 'gas', 'online'] as const;
export type RetailChannel = (typeof RETAIL_CHANNELS)[number];
export const RETAIL_SIGNS = ['sale', 'refund'] as const;
export type RetailSign = (typeof RETAIL_SIGNS)[number];
export const RETAIL_ONLINE_STATUSES = ['shipped', 'delivered', 'cancelled', 'returned', 'other'] as const;
export type RetailOnlineStatus = (typeof RETAIL_ONLINE_STATUSES)[number];
export const RETAIL_LINE_KINDS = ['item', 'fee', 'coupon', 'fuel'] as const;
export type RetailLineKind = (typeof RETAIL_LINE_KINDS)[number];
export const RETAIL_TENDER_KINDS = ['card', 'card-refund', 'debit', 'cash', 'shop-card', 'reward-certificate', 'coupon'] as const;
export type RetailTenderKind = (typeof RETAIL_TENDER_KINDS)[number];
/** Tenders that may link to a card row: a card's last four is kept only on these. */
export const RETAIL_CARD_TENDER_KINDS: readonly RetailTenderKind[] = ['card', 'card-refund'];
export const RETAIL_NETWORKS = ['visa', 'mastercard', 'unknown'] as const;
export type RetailNetwork = (typeof RETAIL_NETWORKS)[number];
/** How an online line reaches the owner. Only `email` and `delivery-setup` can prove an order ships nothing. */
export const RETAIL_FULFILMENTS = ['parcel', 'email', 'delivery-setup', 'unknown'] as const;
export type RetailFulfilment = (typeof RETAIL_FULFILMENTS)[number];
export const RETAIL_CARRIERS = ['ups', 'fedex', 'usps', 'other'] as const;
export type RetailCarrier = (typeof RETAIL_CARRIERS)[number];
/**
 * What a line's `storedValue` FACT flag may say: the line buys stored value of this kind. `costco-shop-card` is set only
 * by an exact catalog allowlist (the converter's), never guessed, and only on an online order's or a warehouse receipt's
 * line, never a fuel receipt's. It decides no category: an importer's map does.
 */
export const RETAIL_STORED_VALUE_KINDS = ['costco-shop-card'] as const;
export type RetailStoredValueKind = (typeof RETAIL_STORED_VALUE_KINDS)[number];

/**
 * A metal line's facts: the title rule's evidence (`rule` names its version) and its pack, read by the pack rule
 * (`metalPackRule.ts`; policy 4 names its version) on the same raw title, before any sanitizing. The ledger takes both
 * as written: a stored title may be cut or redacted, so neither is ever re-derived from it.
 */
export type RetailLineMetal = RetailMetalEvidence & { pack: RetailMetalPack };

/**
 * A line metal guard v1 flags (`metalTitleRule.ts`): it names a metal as a whole word and shows bullion evidence, but
 * reads as no metal. The flag has a metals-only effect (Root's ruling, 11/09): the receipt stays as it is. Holding the
 * line is the metals ledger's, from the metals contract's follow-up 1 (after this policy), until a reviewed rule version
 * or the owner's per-product decision releases it. `evidence` lists what fired, in the guard's closed order; `metal` is
 * the one metal the title's metal words name (null for several), so that a decision never names it. Read on the raw
 * title, like `pack`: checked by value only.
 */
export interface RetailLineMetalUncertain {
  guard: RetailMetalGuard;
  evidence: RetailMetalGuardEvidence[];
  metal: RetailMetal | null;
}

/**
 * Why a capture's record is held instead of imported. A held record keeps only its channel, its natural key and its
 * date when both capture files agree on it (`RetailHeldRecord`).
 */
export const RETAIL_HOLD_REASONS = [
  'unreadable',
  'raw-missing',
  'capture-disagreement',
  'duplicate-in-capture',
  'receipt-type-unknown',
  'currency-unsupported',
  'zero-total',
  'identity-failed',
  'tender-unknown',
  'tender-unproven',
  'payment-mismatch',
  'fee-parent-missing',
  'stored-value-unlisted',
] as const;
export type RetailHoldReason = (typeof RETAIL_HOLD_REASONS)[number];

/**
 * The check that held a record, each under exactly one reason. A hold names its check, never a value. The list is
 * closed: a new check is a new policy version.
 */
export const RETAIL_HOLD_CHECKS = {
  /** A field of the wrong shape. */
  'record-shape': 'unreadable',
  /** The record's barcode or order number can't be read; it is held without a key. */
  'record-key': 'unreadable',
  /** No lines with money, or more than RETAIL_MAX_LINES. */
  'line-count': 'unreadable',
  /** Online line ids missing, repeated or not numeric. */
  'line-ids': 'unreadable',
  /** An online line with a negative quantity, unit price, amount or shipping charge. */
  'line-negative': 'unreadable',
  'raw-missing': 'raw-missing',
  /** Two different raw responses for one record. */
  'raw-repeats': 'capture-disagreement',
  /** A raw response that no record of the consolidated file lists: held by its own key. */
  'raw-unlisted': 'capture-disagreement',
  /** A consolidated amount whose cents and dollars disagree. */
  'money-raw': 'capture-disagreement',
  'record-number': 'capture-disagreement',
  /** The receipt or document type, or the transaction type (sale or refund), differs between the two files. */
  'record-type': 'capture-disagreement',
  'record-date': 'capture-disagreement',
  'record-status': 'capture-disagreement',
  /** A total differs between the two files, the Shop Card amounts applied to an online order included. */
  'record-totals': 'capture-disagreement',
  /** A line's identity (id, item number, description, fee flag, ship method) or money differs between the two files. */
  'record-lines': 'capture-disagreement',
  /** A tender or payment (type, type code, amount, last four, gift-of-membership flag, stored-value bucket) differs. */
  'record-tenders': 'capture-disagreement',
  /** A line's stated returned quantity isn't the sum of its return events. */
  'returned-quantity': 'capture-disagreement',
  'duplicate': 'duplicate-in-capture',
  'receipt-type': 'receipt-type-unknown',
  'money-currency': 'currency-unsupported',
  'warehouse-country': 'currency-unsupported',
  'foreign-tax': 'currency-unsupported',
  'zero-total': 'zero-total',
  /** Warehouse: the lines against the subtotal. */
  'lines-subtotal': 'identity-failed',
  /** Warehouse: subtotal + tax against the total. */
  'subtotal-tax-total': 'identity-failed',
  /** Warehouse: the tenders against the total. */
  'tenders-total': 'identity-failed',
  /** Online: merchandise + shipping + tax − discount + fees − the wallet Shop Card applied, against the total. */
  'order-total': 'identity-failed',
  /** Online: the lines against the merchandise total. */
  'lines-merchandise': 'identity-failed',
  /** Online: the lines' shipping against the order's. */
  'lines-shipping': 'identity-failed',
  /** Online, on an order that charged something: a line's amount against its quantity × unit price. */
  'line-quantity-price': 'identity-failed',
  'tender-name': 'tender-unknown',
  'payment-type': 'tender-unknown',
  'gift-of-membership-payment': 'tender-unknown',
  'stored-value-payment': 'tender-unknown',
  /**
   * Online: a wallet Shop Card payment of another shape than the one known: its stored-value bucket isn't ShopCard
   * (`SHOPCARD` once normalized) in both files, its last four isn't there and empty in both files, its gift-of-membership
   * flag isn't false in both files, or it has no amount.
   */
  'shop-card-row': 'tender-unknown',
  'tender-count': 'tender-unproven',
  'tender-zero': 'tender-unproven',
  /**
   * A tender whose sign isn't the total's. The one exception is change: on a sale with no card or card-refund tender,
   * a cash tender may be negative (cash given back, as when a reward certificate exceeds the bill).
   */
  'tender-sign': 'tender-unproven',
  'tender-last4': 'tender-unproven',
  /** Online: a physical Shop Card amount applied. None has been seen, so its shape is unknown. */
  'shop-card-physical': 'tender-unproven',
  /** Online: a negative wallet Shop Card payment on an order that charged something (a refund to the Shop Card). */
  'shop-card-live-refund': 'tender-unproven',
  'gift-of-membership-applied': 'tender-unproven',
  /** Online: not exactly one card payment, or one that isn't the total. */
  'card-payment': 'payment-mismatch',
  'coupon-amount': 'payment-mismatch',
  'coupons-discount': 'payment-mismatch',
  /** Online, on an order that charged something: the wallet Shop Card payments against the wallet amount applied. */
  'shop-card-sum': 'payment-mismatch',
  /** Online, on an order that charged nothing: Shop Card payments that don't cancel exactly, or no cancel events. */
  'shop-card-cancel': 'payment-mismatch',
  'fee-parent': 'fee-parent-missing',
  /** A line whose title names a Shop Card but that the exact catalog allowlist doesn't list. */
  'shop-card-purchase-unlisted': 'stored-value-unlisted',
} as const satisfies Record<string, RetailHoldReason>;
export type RetailHoldCheck = keyof typeof RETAIL_HOLD_CHECKS;
export const RETAIL_HOLD_CHECK_NAMES = Object.keys(RETAIL_HOLD_CHECKS) as RetailHoldCheck[];

export const RETAIL_TITLE_MAX = 240;
export const RETAIL_MAX_RECEIPTS = 20_000;
export const RETAIL_MAX_LINES = 500;
export const RETAIL_MAX_TENDERS = 10;
/** No single amount in a payload is larger than this many minor units (a hundred million dollars). */
export const RETAIL_MAX_MINOR = 10_000_000_000;

export interface RetailTotals {
  subtotalMinor: number | null;
  taxMinor: number | null;
  instantSavingsMinor: number | null;
  discountMinor: number | null;
  shippingMinor: number | null;
  feesMinor: number | null;
  /**
   * Online: the wallet Shop Card amount applied to the order, 0 when none. The order's `totalMinor` is what is left, the
   * card's part. Warehouse: null; a Shop Card there is a tender within the total.
   */
  storedValueMinor: number | null;
  totalMinor: number;
}

export interface RetailUnitEvent {
  quantity: number;
  date: string;
}

export interface RetailLineEvents {
  shipped: RetailUnitEvent[];
  delivered: RetailUnitEvent[];
  cancelled: RetailUnitEvent[];
  returned: RetailUnitEvent[];
}

export interface RetailShipment {
  shippedDate: string | null;
  /** Set only from an actual delivery, never from an estimate. */
  deliveredDate: string | null;
  estimatedArrivalDate: string | null;
  carrier: RetailCarrier | null;
}

export interface RetailImportLine {
  /** Position in the receipt, 0 first, contiguous. A warehouse line's identity. */
  ordinal: number;
  /** Online only: the native line id, as a one-way hash. */
  lineKey: string | null;
  kind: RetailLineKind;
  itemNumber: string | null;
  title: string | null;
  title2: string | null;
  department: number | null;
  quantity: number | null;
  /** Cents. Null on a fuel line, whose price per gallon is `fuelUnitPrice` (it has tenths of a cent). */
  unitPriceMinor: number | null;
  amountMinor: number;
  /** Online only: the line's own shipping charge. */
  shippingMinor: number | null;
  /** Warehouse only: `Y`, `N` or a tax code, as the receipt prints it. */
  taxFlag: string | null;
  /** A coupon line: the ordinal of the one line it discounts, or null for a receipt-level discount. */
  couponTarget: number | null;
  /** A fee line: the ordinal of its parent line. */
  feeParent: number | null;
  fulfilment: RetailFulfilment | null;
  metal: RetailLineMetal | null;
  /** Metal guard v1's flag: a line that names a metal with bullion evidence but is no metal. Null otherwise. */
  metalUncertain: RetailLineMetalUncertain | null;
  /** A FACT: the line buys stored value of this kind, by the converter's exact catalog allowlist. Null otherwise. */
  storedValue: RetailStoredValueKind | null;
  /** A fuel line: gallons as the receipt gives them. */
  fuelGallons: string | null;
  /** A fuel line: dollars per gallon exactly as the receipt states them (`3.459`), never rounded to cents. */
  fuelUnitPrice: string | null;
  events: RetailLineEvents | null;
  shipments: RetailShipment[];
}

export interface RetailImportTender {
  ordinal: number;
  kind: RetailTenderKind;
  network: RetailNetwork;
  last4: string | null;
  amountMinor: number;
}

export interface RetailImportReceipt {
  channel: RetailChannel;
  naturalKey: string;
  date: string;
  localTime: string | null;
  sign: RetailSign;
  status: RetailOnlineStatus | null;
  currency: 'USD';
  totals: RetailTotals;
  taxLegends: Array<{ legend: string; amountMinor: number }>;
  lines: RetailImportLine[];
  tenders: RetailImportTender[];
}

export interface RetailCoverageRange {
  from: string;
  to: string;
  stated: number | null;
  seen: number;
}

export interface RetailHeldRecord {
  channel: RetailChannel;
  /** Null only when the record's own number can't be read (`record-key`). */
  naturalKey: string | null;
  reason: RetailHoldReason;
  check: RetailHoldCheck;
  /**
   * The record's own date, only when it reads in both capture files and they agree on it (online: the placed date;
   * warehouse and gas: the transaction date, both of the raw receipt's date fields included); otherwise null. It lets an
   * importer keep a held record in the window of the card charges it could explain, so that it can stop a link, never
   * make one or count. A held record keeps nothing else: no amount, card ending or line.
   */
  date: string | null;
}

/**
 * The checks whose held record can't have a date both files agree on: no key to find the raw response by, one file
 * only, or the two files' dates differ. The validator refuses a date on them.
 */
const HELD_WITHOUT_DATE: ReadonlySet<RetailHoldCheck> = new Set<RetailHoldCheck>(['record-key', 'raw-missing', 'raw-unlisted', 'record-date']);

export interface RetailImportPayload {
  format: typeof RETAIL_IMPORT_FORMAT;
  version: typeof RETAIL_IMPORT_VERSION;
  merchant: RetailMerchant;
  /** The program that wrote the payload, `holdr-retail-convert <semver>`. */
  converterVersion: string;
  policyVersion: typeof RETAIL_CONVERT_POLICY_VERSION;
  /**
   * `captureDigest` is the SHA-256 of the consolidated capture file's bytes in letter hex (each hex digit 0–f written as
   * a–p), as card and checking digests are, so no run of digits can read as a card number.
   */
  source: { schema: typeof COSTCO_CAPTURE_SCHEMA; captureDigest: string; capturedAt: string; files: number };
  membership: { folder: string; memberSinceYear: string | null; tier: string | null; membershipLast4: string | null };
  coverage: { online: RetailCoverageRange[]; warehouse: RetailCoverageRange[] };
  receipts: RetailImportReceipt[];
  held: RetailHeldRecord[];
}

// ---------------------------------------------------------------------------
// Natural keys
// ---------------------------------------------------------------------------

const KEY_TAG = 'holdr.retail-natural-key';
const encoder = new TextEncoder();
const digestOf = (parts: readonly string[]) => toLetterHex(sha256(encoder.encode([KEY_TAG, ...parts].join('\u0000'))));

/** A receipt's or order's natural key: its native barcode or order number, hashed one way. */
export function retailNaturalKey(merchant: RetailMerchant, kind: 'receipt' | 'order', nativeId: string): string {
  return `${merchant}-${kind}-${digestOf([merchant, kind, nativeId])}`;
}

/** An online line's key: its native order and line ids, hashed one way. */
export function retailLineKey(merchant: RetailMerchant, nativeOrderId: string, nativeLineId: string): string {
  return `${merchant}-line-${digestOf([merchant, 'line', nativeOrderId, nativeLineId])}`;
}

/** SHA-256 of bytes, in letter hex (no digits). */
export function retailDigest(bytes: Uint8Array): string {
  return toLetterHex(sha256(bytes));
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = sorted((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** Canonical JSON text: keys sorted at every level, arrays in order, two-space indents, one final newline. */
export function serializeRetailImportPayload(payload: RetailImportPayload): string {
  return `${JSON.stringify(sorted(payload), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface RetailPayloadIssue {
  path: string;
  message: string;
}
export type RetailPayloadValidation = { ok: true; payload: RetailImportPayload } | { ok: false; issues: RetailPayloadIssue[] };

class Invalid extends Error {
  constructor(readonly path: string, readonly reason: string) {
    super(reason);
  }
}

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);

function record(value: unknown, path: string, keys: readonly string[]): Rec {
  if (!isRecord(value)) throw new Invalid(path, 'must be an object');
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length > 0) throw new Invalid(path, 'has an unknown key');
  for (const key of keys) if (!(key in value)) throw new Invalid(`${path}.${key}`, 'is missing');
  return value;
}

function list(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new Invalid(path, 'must be an array');
  if (value.length > max) throw new Invalid(path, `must have at most ${max} entries`);
  return value;
}

function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw new Invalid(path, 'is not an allowed value');
  return value as T;
}

function exact(value: unknown, path: string, expected: string | number): void {
  if (value !== expected) throw new Invalid(path, 'is not the expected value');
}

function mustBeNull(value: unknown, path: string): void {
  if (value !== null) throw new Invalid(path, 'must be null');
}

function pattern(value: unknown, path: string, re: RegExp): string {
  if (typeof value !== 'string' || !re.test(value)) throw new Invalid(path, 'has the wrong form');
  return value;
}

function nullable<T>(value: unknown, read: (value: unknown) => T): T | null {
  return value === null ? null : read(value);
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Invalid(path, `must be an integer from ${min} to ${max}`);
  }
  return value;
}

const minor = (value: unknown, path: string) => integer(value, path, -RETAIL_MAX_MINOR, RETAIL_MAX_MINOR);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export function isRetailDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function date(value: unknown, path: string): string {
  if (!isRetailDate(value)) throw new Invalid(path, 'must be a real YYYY-MM-DD date');
  return value;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
const CAPTURED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const LETTER_HEX = /^[a-p]{64}$/;
const RECEIPT_KEY = /^costco-receipt-[a-p]{64}$/;
const ORDER_KEY = /^costco-order-[a-p]{64}$/;
const LINE_KEY = /^costco-line-[a-p]{64}$/;
const FOLDER = /^costco(?:-[1-9][0-9]{0,2})?$/;
const TIER = /^[A-Za-z][A-Za-z +]{0,39}$/;
const WEIGHT_VALUE = /^(?:[1-9]\d{0,4}(?:\.\d{1,4})?|0\.\d{0,3}[1-9]|[1-9]\d{0,3}\/[1-9]\d{0,3}|(?:[1-9]\d{0,2} )?(?:1\/2|1\/4|3\/4|1\/10))$/;
const GALLONS = /^\d{1,4}(?:\.\d{1,4})?$/;
const FUEL_PRICE = /^\d{1,3}(?:\.\d{1,4})?$/;

function title(value: unknown, path: string): string {
  if (typeof value !== 'string' || cardImportTextProblem(value, RETAIL_TITLE_MAX) !== null) {
    throw new Invalid(path, 'must be stored text with no card data');
  }
  return value;
}

function itemNumber(value: unknown, path: string): string {
  const text = pattern(value, path, /^[0-9]{1,12}$/);
  if (containsCardData(text)) throw new Invalid(path, 'must not look like card data');
  return text;
}

function checkMetal(value: unknown, path: string): void {
  const metal = record(value, path, ['metal', 'form', 'statedWeight', 'rule', 'pack']);
  nullable(metal.metal, (v) => oneOf(v, `${path}.metal`, RETAIL_METALS));
  nullable(metal.form, (v) => oneOf(v, `${path}.form`, RETAIL_METAL_FORMS));
  exact(metal.rule, `${path}.rule`, RETAIL_METAL_TITLE_RULE);
  nullable(metal.statedWeight, (v) => {
    const weight = record(v, `${path}.statedWeight`, ['value', 'unit']);
    pattern(weight.value, `${path}.statedWeight.value`, WEIGHT_VALUE);
    oneOf(weight.unit, `${path}.statedWeight.unit`, RETAIL_WEIGHT_UNITS);
  });
  // Read on the raw title, which the payload doesn't keep (a stored title may be cut): checked by value only.
  oneOf(metal.pack, `${path}.pack`, RETAIL_METAL_PACKS);
}

function checkMetalUncertain(value: unknown, path: string): void {
  const flag = record(value, path, ['guard', 'evidence', 'metal']);
  exact(flag.guard, `${path}.guard`, RETAIL_METAL_GUARD);
  const evidence = list(flag.evidence, `${path}.evidence`, RETAIL_METAL_GUARD_EVIDENCE.length);
  if (evidence.length === 0) throw new Invalid(`${path}.evidence`, 'must not be empty');
  let last = -1;
  evidence.forEach((entry, index) => {
    const at = RETAIL_METAL_GUARD_EVIDENCE.indexOf(oneOf(entry, `${path}.evidence[${index}]`, RETAIL_METAL_GUARD_EVIDENCE));
    if (at <= last) throw new Invalid(`${path}.evidence[${index}]`, 'must follow the closed order, once each');
    last = at;
  });
  nullable(flag.metal, (v) => oneOf(v, `${path}.metal`, RETAIL_METALS));
}

function checkEvents(value: unknown, path: string): void {
  const events = record(value, path, ['shipped', 'delivered', 'cancelled', 'returned']);
  for (const kind of ['shipped', 'delivered', 'cancelled', 'returned'] as const) {
    list(events[kind], `${path}.${kind}`, 50).forEach((entry, index) => {
      const at = `${path}.${kind}[${index}]`;
      const event = record(entry, at, ['quantity', 'date']);
      integer(event.quantity, `${at}.quantity`, 1, 100_000);
      date(event.date, `${at}.date`);
    });
  }
}

function checkShipment(value: unknown, path: string): void {
  const shipment = record(value, path, ['shippedDate', 'deliveredDate', 'estimatedArrivalDate', 'carrier']);
  for (const key of ['shippedDate', 'deliveredDate', 'estimatedArrivalDate'] as const) {
    nullable(shipment[key], (v) => date(v, `${path}.${key}`));
  }
  nullable(shipment.carrier, (v) => oneOf(v, `${path}.carrier`, RETAIL_CARRIERS));
}

const LINE_KEYS = ['ordinal', 'lineKey', 'kind', 'itemNumber', 'title', 'title2', 'department', 'quantity', 'unitPriceMinor',
  'amountMinor', 'shippingMinor', 'taxFlag', 'couponTarget', 'feeParent', 'fulfilment', 'metal', 'metalUncertain', 'storedValue',
  'fuelGallons', 'fuelUnitPrice', 'events', 'shipments'] as const;

function checkLine(value: unknown, path: string, index: number, online: boolean): RetailImportLine {
  const line = record(value, path, LINE_KEYS);
  exact(line.ordinal, `${path}.ordinal`, index);
  const kind = oneOf(line.kind, `${path}.kind`, RETAIL_LINE_KINDS);
  if (online) {
    pattern(line.lineKey, `${path}.lineKey`, LINE_KEY);
    if (kind === 'coupon' || kind === 'fuel') throw new Invalid(`${path}.kind`, 'is not an online line kind');
    integer(line.shippingMinor, `${path}.shippingMinor`, 0, RETAIL_MAX_MINOR);
    // An online line is never negative: coupons are the order's tenders, and returns are events, not lines.
    integer(line.quantity, `${path}.quantity`, 0, 100_000);
    integer(line.unitPriceMinor, `${path}.unitPriceMinor`, 0, RETAIL_MAX_MINOR);
    integer(line.amountMinor, `${path}.amountMinor`, 0, RETAIL_MAX_MINOR);
    mustBeNull(line.taxFlag, `${path}.taxFlag`);
    oneOf(line.fulfilment, `${path}.fulfilment`, RETAIL_FULFILMENTS);
    checkEvents(line.events, `${path}.events`);
    list(line.shipments, `${path}.shipments`, 20).forEach((shipment, at) => checkShipment(shipment, `${path}.shipments[${at}]`));
  } else {
    for (const key of ['lineKey', 'shippingMinor', 'fulfilment', 'events'] as const) mustBeNull(line[key], `${path}.${key}`);
    if (kind === 'fee') throw new Invalid(`${path}.kind`, 'is not a warehouse line kind');
    nullable(line.taxFlag, (v) => pattern(v, `${path}.taxFlag`, /^[A-Z0-9]$/));
    if (list(line.shipments, `${path}.shipments`, 0).length !== 0) throw new Invalid(`${path}.shipments`, 'must be empty');
  }
  nullable(line.itemNumber, (v) => itemNumber(v, `${path}.itemNumber`));
  nullable(line.title, (v) => title(v, `${path}.title`));
  nullable(line.title2, (v) => title(v, `${path}.title2`));
  nullable(line.department, (v) => integer(v, `${path}.department`, 0, 9999));
  nullable(line.quantity, (v) => integer(v, `${path}.quantity`, -100_000, 100_000));
  nullable(line.unitPriceMinor, (v) => minor(v, `${path}.unitPriceMinor`));
  minor(line.amountMinor, `${path}.amountMinor`);
  nullable(line.metal, (v) => checkMetal(v, `${path}.metal`));
  // Only an item line is ever metal: the rule never reads a fee, fuel or coupon line (the converter's assessment gate).
  if (line.metal !== null && kind !== 'item') throw new Invalid(`${path}.metal`, 'is only on an item line');
  nullable(line.metalUncertain, (v) => checkMetalUncertain(v, `${path}.metalUncertain`));
  // Never beside metal or a Shop Card purchase, and never on a coupon line, which has no title to read. A stored title
  // may be held while the raw one was read, and a warehouse line may have only its second description, so a title is not
  // required.
  if (line.metalUncertain !== null && (line.metal !== null || line.storedValue !== null || kind === 'coupon')) {
    throw new Invalid(`${path}.metalUncertain`, 'is only on a line that is no metal, no coupon and buys no Shop Card');
  }
  nullable(line.storedValue, (v) => oneOf(v, `${path}.storedValue`, RETAIL_STORED_VALUE_KINDS));
  if (line.storedValue !== null && (kind !== 'item' || line.metal !== null)) {
    throw new Invalid(`${path}.storedValue`, 'is only on an item line that is no metal');
  }
  if (kind === 'fuel') {
    nullable(line.fuelGallons, (v) => pattern(v, `${path}.fuelGallons`, GALLONS));
    nullable(line.fuelUnitPrice, (v) => pattern(v, `${path}.fuelUnitPrice`, FUEL_PRICE));
    mustBeNull(line.unitPriceMinor, `${path}.unitPriceMinor`);
  } else {
    mustBeNull(line.fuelGallons, `${path}.fuelGallons`);
    mustBeNull(line.fuelUnitPrice, `${path}.fuelUnitPrice`);
  }
  if (kind !== 'coupon') mustBeNull(line.couponTarget, `${path}.couponTarget`);
  if (kind !== 'fee') mustBeNull(line.feeParent, `${path}.feeParent`);
  return line as unknown as RetailImportLine;
}

function checkTender(value: unknown, path: string, index: number): RetailImportTender {
  const tender = record(value, path, ['ordinal', 'kind', 'network', 'last4', 'amountMinor']);
  exact(tender.ordinal, `${path}.ordinal`, index);
  const kind = oneOf(tender.kind, `${path}.kind`, RETAIL_TENDER_KINDS);
  const network = oneOf(tender.network, `${path}.network`, RETAIL_NETWORKS);
  if (RETAIL_CARD_TENDER_KINDS.includes(kind)) pattern(tender.last4, `${path}.last4`, /^[0-9]{4}$/);
  else {
    mustBeNull(tender.last4, `${path}.last4`);
    if (network !== 'unknown') throw new Invalid(`${path}.network`, 'must be unknown for a tender that is not a card');
  }
  const amount = minor(tender.amountMinor, `${path}.amountMinor`);
  if (amount === 0) throw new Invalid(`${path}.amountMinor`, 'must not be zero');
  return tender as unknown as RetailImportTender;
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/** The money identities of one receipt, independently of how it was converted. */
function checkIdentities(receipt: RetailImportReceipt, path: string): void {
  const { totals, lines, tenders } = receipt;
  const fail = (what: string) => {
    throw new Invalid(`${path}.totals`, `does not add up: ${what}`);
  };
  if (receipt.channel === 'online') {
    const { subtotalMinor: sub, shippingMinor: ship, taxMinor: tax, discountMinor: discount, feesMinor: fees, storedValueMinor: stored } = totals;
    if (sub === null || ship === null || tax === null || discount === null || fees === null || stored === null) fail('an online total is missing');
    if (totals.instantSavingsMinor !== null) fail('instant savings on an online order');
    if (stored! < 0) fail('a negative Shop Card amount');
    if (sub! + ship! + tax! - discount! + fees! - stored! !== totals.totalMinor) {
      fail('merchandise, shipping, tax, discount, fees and the Shop Card against the total');
    }
    if (sum(lines.map((line) => line.amountMinor)) !== sub) fail('lines against merchandise');
    if (sum(lines.map((line) => line.shippingMinor ?? 0)) !== ship) fail('line shipping against shipping');
    if (totals.totalMinor < 0) fail('a negative online total');
    // An order charged nothing only when neither a card nor a Shop Card paid anything: it was cancelled.
    const chargedNothing = totals.totalMinor === 0 && stored === 0;
    if (!chargedNothing && lines.some((line) => line.quantity === null || line.unitPriceMinor === null
      || line.quantity * line.unitPriceMinor !== line.amountMinor)) {
      fail('a line against its quantity and unit price');
    }
    const cards = tenders.filter((tender) => tender.kind === 'card');
    const coupons = tenders.filter((tender) => tender.kind === 'coupon');
    const shopCards = tenders.filter((tender) => tender.kind === 'shop-card');
    if (cards.length + coupons.length + shopCards.length !== tenders.length) {
      fail('an online tender that is neither a card, a coupon nor a Shop Card');
    }
    if (chargedNothing) {
      if (tenders.length > 0) fail('tenders on an order that charged nothing');
    } else {
      if (totals.totalMinor > 0 ? cards.length !== 1 || cards[0].amountMinor !== totals.totalMinor : cards.length !== 0) {
        fail('the card payment against the total');
      }
      if (coupons.length > 0 && sum(coupons.map((coupon) => coupon.amountMinor)) !== discount) fail('coupons against the discount');
      if (coupons.some((coupon) => coupon.amountMinor < 0)) fail('a negative coupon');
      if (shopCards.some((tender) => tender.amountMinor <= 0)) fail('a Shop Card payment that is not positive on an order that charged something');
      if (sum(shopCards.map((tender) => tender.amountMinor)) !== stored) fail('the Shop Card payments against the Shop Card amount');
    }
    if (receipt.sign !== 'sale') fail('an online order that is not a sale');
    return;
  }
  const { subtotalMinor: sub, taxMinor: tax } = totals;
  if (sub === null || tax === null) fail('a warehouse total is missing');
  for (const key of ['discountMinor', 'shippingMinor', 'feesMinor', 'storedValueMinor'] as const) {
    if (totals[key] !== null) fail(`${key} on a warehouse receipt`);
  }
  if (sum(lines.map((line) => line.amountMinor)) !== sub) fail('lines against the subtotal');
  if (sub! + tax! !== totals.totalMinor) fail('subtotal and tax against the total');
  if (tenders.length === 0 || sum(tenders.map((tender) => tender.amountMinor)) !== totals.totalMinor) fail('tenders against the total');
  if (totals.totalMinor === 0) fail('a zero total');
  if ((receipt.sign === 'sale') !== (totals.totalMinor > 0)) fail('the sign against the total');
  // Change is the one tender of the other sign: cash given back on a sale that no card or card refund paid.
  const changeAllowed = totals.totalMinor > 0 && !tenders.some((tender) => RETAIL_CARD_TENDER_KINDS.includes(tender.kind));
  if (tenders.some((tender) => Math.sign(tender.amountMinor) !== Math.sign(totals.totalMinor) && !(changeAllowed && tender.kind === 'cash'))) {
    fail('a tender of the other sign');
  }
  if (tenders.some((tender) => tender.kind === 'coupon')) fail('a coupon tender on a warehouse receipt');
}

const RECEIPT_KEYS = ['channel', 'naturalKey', 'date', 'localTime', 'sign', 'status', 'currency', 'totals', 'taxLegends',
  'lines', 'tenders'] as const;
const TOTAL_KEYS = ['subtotalMinor', 'taxMinor', 'instantSavingsMinor', 'discountMinor', 'shippingMinor', 'feesMinor',
  'storedValueMinor', 'totalMinor'] as const;

function checkReceipt(value: unknown, path: string): RetailImportReceipt {
  const receipt = record(value, path, RECEIPT_KEYS);
  const channel = oneOf(receipt.channel, `${path}.channel`, RETAIL_CHANNELS);
  const online = channel === 'online';
  pattern(receipt.naturalKey, `${path}.naturalKey`, online ? ORDER_KEY : RECEIPT_KEY);
  date(receipt.date, `${path}.date`);
  nullable(receipt.localTime, (v) => pattern(v, `${path}.localTime`, TIME));
  oneOf(receipt.sign, `${path}.sign`, RETAIL_SIGNS);
  if (online) oneOf(receipt.status, `${path}.status`, RETAIL_ONLINE_STATUSES);
  else mustBeNull(receipt.status, `${path}.status`);
  exact(receipt.currency, `${path}.currency`, 'USD');
  const totals = record(receipt.totals, `${path}.totals`, TOTAL_KEYS);
  for (const key of TOTAL_KEYS) {
    if (key === 'totalMinor') minor(totals[key], `${path}.totals.${key}`);
    else nullable(totals[key], (v) => minor(v, `${path}.totals.${key}`));
  }
  const legends = list(receipt.taxLegends, `${path}.taxLegends`, online ? 0 : 8);
  legends.forEach((entry, index) => {
    const legend = record(entry, `${path}.taxLegends[${index}]`, ['legend', 'amountMinor']);
    pattern(legend.legend, `${path}.taxLegends[${index}].legend`, /^[A-Z]$/);
    minor(legend.amountMinor, `${path}.taxLegends[${index}].amountMinor`);
  });
  const lines = list(receipt.lines, `${path}.lines`, RETAIL_MAX_LINES).map((line, index) => checkLine(line, `${path}.lines[${index}]`, index, online));
  // A fuel receipt never buys stored value: the catalog list names only online and warehouse Shop Card products.
  if (channel === 'gas') {
    lines.forEach((line, index) => {
      if (line.storedValue !== null) throw new Invalid(`${path}.lines[${index}].storedValue`, 'is never on a fuel receipt');
    });
  }
  if (lines.length === 0) throw new Invalid(`${path}.lines`, 'must not be empty');
  const keys = new Set<string>();
  lines.forEach((line, index) => {
    if (line.lineKey !== null) {
      if (keys.has(line.lineKey)) throw new Invalid(`${path}.lines[${index}].lineKey`, 'is repeated');
      keys.add(line.lineKey);
    }
    if (line.couponTarget !== null) {
      const target = lines[line.couponTarget as number];
      if (!Number.isSafeInteger(line.couponTarget) || !target || target.kind === 'coupon' || line.couponTarget === index) {
        throw new Invalid(`${path}.lines[${index}].couponTarget`, 'must name another line that is not a coupon');
      }
    }
    if (line.kind === 'fee') {
      const parent = Number.isSafeInteger(line.feeParent) ? lines[line.feeParent as number] : undefined;
      if (!parent || parent.kind === 'fee') throw new Invalid(`${path}.lines[${index}].feeParent`, 'must name a line that is not a fee');
    }
  });
  const tenders = list(receipt.tenders, `${path}.tenders`, RETAIL_MAX_TENDERS).map((tender, index) => checkTender(tender, `${path}.tenders[${index}]`, index));
  const checked = receipt as unknown as RetailImportReceipt;
  checked.lines = lines;
  checked.tenders = tenders;
  checkIdentities(checked, path);
  return checked;
}

function checkRange(value: unknown, path: string): void {
  const range = record(value, path, ['from', 'to', 'stated', 'seen']);
  const from = date(range.from, `${path}.from`);
  const to = date(range.to, `${path}.to`);
  if (from > to) throw new Invalid(path, 'must not end before it starts');
  nullable(range.stated, (v) => integer(v, `${path}.stated`, 0, 1_000_000));
  integer(range.seen, `${path}.seen`, 0, 1_000_000);
}

/** Checks a parsed payload field by field, by type and value, with every receipt's money identities. */
export function validateRetailImportPayload(value: unknown): RetailPayloadValidation {
  try {
    const payload = record(value, '$', ['format', 'version', 'merchant', 'converterVersion', 'policyVersion', 'source', 'membership',
      'coverage', 'receipts', 'held']);
    exact(payload.format, '$.format', RETAIL_IMPORT_FORMAT);
    exact(payload.version, '$.version', RETAIL_IMPORT_VERSION);
    oneOf(payload.merchant, '$.merchant', RETAIL_MERCHANTS);
    pattern(payload.converterVersion, '$.converterVersion', /^holdr-retail-convert \d{1,3}\.\d{1,3}\.\d{1,3}$/);
    exact(payload.policyVersion, '$.policyVersion', RETAIL_CONVERT_POLICY_VERSION);
    const source = record(payload.source, '$.source', ['schema', 'captureDigest', 'capturedAt', 'files']);
    exact(source.schema, '$.source.schema', COSTCO_CAPTURE_SCHEMA);
    pattern(source.captureDigest, '$.source.captureDigest', LETTER_HEX);
    pattern(source.capturedAt, '$.source.capturedAt', CAPTURED_AT);
    integer(source.files, '$.source.files', 1, 100_000);
    const membership = record(payload.membership, '$.membership', ['folder', 'memberSinceYear', 'tier', 'membershipLast4']);
    pattern(membership.folder, '$.membership.folder', FOLDER);
    nullable(membership.memberSinceYear, (v) => pattern(v, '$.membership.memberSinceYear', /^(?:19|20)\d{2}$/));
    nullable(membership.tier, (v) => pattern(v, '$.membership.tier', TIER));
    nullable(membership.membershipLast4, (v) => pattern(v, '$.membership.membershipLast4', /^[0-9]{4}$/));
    const coverage = record(payload.coverage, '$.coverage', ['online', 'warehouse']);
    list(coverage.online, '$.coverage.online', 200).forEach((range, index) => checkRange(range, `$.coverage.online[${index}]`));
    list(coverage.warehouse, '$.coverage.warehouse', 200).forEach((range, index) => checkRange(range, `$.coverage.warehouse[${index}]`));
    const keys = new Set<string>();
    list(payload.receipts, '$.receipts', RETAIL_MAX_RECEIPTS).forEach((entry, index) => {
      const receipt = checkReceipt(entry, `$.receipts[${index}]`);
      if (keys.has(receipt.naturalKey)) throw new Invalid(`$.receipts[${index}].naturalKey`, 'is repeated');
      keys.add(receipt.naturalKey);
    });
    const heldKeys = new Set<string>();
    list(payload.held, '$.held', RETAIL_MAX_RECEIPTS).forEach((entry, index) => {
      const at = `$.held[${index}]`;
      const held = record(entry, at, ['channel', 'naturalKey', 'reason', 'check', 'date']);
      const channel = oneOf(held.channel, `${at}.channel`, RETAIL_CHANNELS);
      nullable(held.naturalKey, (v) => {
        const key = pattern(v, `${at}.naturalKey`, channel === 'online' ? ORDER_KEY : RECEIPT_KEY);
        if (keys.has(key)) throw new Invalid(`${at}.naturalKey`, 'is also imported');
        if (heldKeys.has(key)) throw new Invalid(`${at}.naturalKey`, 'is repeated');
        heldKeys.add(key);
        return key;
      });
      const reason = oneOf(held.reason, `${at}.reason`, RETAIL_HOLD_REASONS);
      const check = oneOf(held.check, `${at}.check`, RETAIL_HOLD_CHECK_NAMES);
      if (RETAIL_HOLD_CHECKS[check] !== reason) throw new Invalid(`${at}.check`, 'is not a check of its reason');
      if ((held.naturalKey === null) !== (check === 'record-key')) {
        throw new Invalid(`${at}.naturalKey`, 'must be null exactly when the record key could not be read');
      }
      nullable(held.date, (v) => date(v, `${at}.date`));
      if (held.date !== null && HELD_WITHOUT_DATE.has(check)) throw new Invalid(`${at}.date`, 'must be null: the two files could not agree on it');
    });
    return { ok: true, payload: payload as unknown as RetailImportPayload };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, issues: [{ path: error.path, message: error.reason }] };
    throw error;
  }
}
