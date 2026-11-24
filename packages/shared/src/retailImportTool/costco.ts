/**
 * Costco captures (`holdr-retail-capture/costco@1`) to `holdr.retail-import` v3 payloads: the reader behind
 * `holdr-retail-convert`. Pure: the CLI reads the files, checks each one against the owner's private manifest and hands
 * their parsed JSON in. Nothing here touches a file system, network or clock.
 *
 * A membership folder's capture is the pull's consolidated `costco.json` (each order's and receipt's header, payments
 * and tenders) and the raw responses it was built from (each warehouse receipt's item lines, each online order's
 * details). Every record is checked against its own money identities and against the other file before anything of it
 * is kept. A record that doesn't hold is held, naming the check, never a value; nothing is guessed or defaulted.
 *
 * The pull's own `isPreciousMetal` is never used as evidence: metal evidence is Holdr's RETAIL_METAL_TITLE_RULE on the
 * raw title (metalTitleRule.ts), and a metal line's pack is the pack rule's reading of the same raw title
 * (metalPackRule.ts), both before any sanitizing. The report counts where the pull's flag and the rule differ, and
 * nothing else of the pull's flag.
 */

import { containsCardData } from '../cardNumbers.js';
import { cardImportTextProblem, sanitizeCardText } from '../cardImport.js';
import { RETAIL_METAL_PACK_REASONS, RETAIL_METAL_PACKS, retailMetalPackAssessment, type RetailMetalPack, type RetailMetalPackReason } from './metalPackRule.js';
import {
  RETAIL_METAL_GUARD,
  RETAIL_METAL_GUARD_CLAUSES,
  retailMetalTitleEvidence,
  retailMetalTitleGuard,
  type RetailMetalForm,
  type RetailMetalGuardClause,
} from './metalTitleRule.js';
import {
  COSTCO_CAPTURE_SCHEMA,
  isRetailDate,
  RETAIL_CHANNELS,
  RETAIL_CONVERT_POLICY_VERSION,
  RETAIL_HOLD_CHECK_NAMES,
  RETAIL_HOLD_CHECKS,
  RETAIL_HOLD_REASONS,
  RETAIL_IMPORT_FORMAT,
  RETAIL_IMPORT_VERSION,
  RETAIL_LINE_KINDS,
  RETAIL_MAX_LINES,
  RETAIL_MAX_MINOR,
  RETAIL_MAX_RECEIPTS,
  RETAIL_MAX_TENDERS,
  RETAIL_ONLINE_STATUSES,
  RETAIL_SIGNS,
  RETAIL_TENDER_KINDS,
  RETAIL_TITLE_MAX,
  retailLineKey,
  retailNaturalKey,
  serializeRetailImportPayload,
  validateRetailImportPayload,
  type RetailCarrier,
  type RetailChannel,
  type RetailCoverageRange,
  type RetailFulfilment,
  type RetailHeldRecord,
  type RetailHoldCheck,
  type RetailHoldReason,
  type RetailImportLine,
  type RetailImportPayload,
  type RetailImportReceipt,
  type RetailImportTender,
  type RetailLineEvents,
  type RetailLineKind,
  type RetailLineMetal,
  type RetailLineMetalUncertain,
  type RetailNetwork,
  type RetailOnlineStatus,
  type RetailShipment,
  type RetailSign,
  type RetailTenderKind,
  type RetailUnitEvent,
} from './payload.js';

export const RETAIL_CONVERTER_VERSION = '1.4.0';
export const RETAIL_CONVERTER = `holdr-retail-convert ${RETAIL_CONVERTER_VERSION}`;

/** Why a whole folder is refused: nothing of it is converted. */
export const RETAIL_CONVERT_REFUSALS = [
  'schema-unsupported',
  'capture-unreadable',
  'folder-mismatch',
  'currency-unsupported',
  'too-many-records',
  'converter-invalid',
] as const;
export type RetailConvertRefusal = (typeof RETAIL_CONVERT_REFUSALS)[number];

/** A refusal of the whole folder. Its message names the check and a structural path at most, never a value. */
export class RetailConvertError extends Error {
  constructor(readonly code: RetailConvertRefusal, readonly at?: string) {
    super(at ? `${code} at ${at}` : code);
    this.name = 'RetailConvertError';
  }
}

export interface CostcoCaptureInput {
  /** The membership folder's name, `costco` or `costco-N`. */
  folder: string;
  /** The parsed consolidated `costco.json`. */
  consolidated: unknown;
  /** SHA-256 of the consolidated file's bytes, in letter hex. */
  consolidatedDigest: string;
  /** Each parsed `raw/receipts/receipt-*.json`. */
  rawReceipts: readonly unknown[];
  /** Each parsed `raw/detail-*.json`. */
  rawDetails: readonly unknown[];
  /** How many files were read and verified against the manifest. */
  files: number;
}

type Counts<K extends string> = Record<K, number>;
const zeroes = <K extends string>(keys: readonly K[]): Counts<K> => Object.fromEntries(keys.map((key) => [key, 0])) as Counts<K>;

/** What a conversion found: counts, closed codes, dates and the folder's name only, never a value of a record. */
export interface CostcoConvertReport {
  converter: string;
  policyVersion: number;
  merchant: 'costco';
  folder: string;
  schema: string;
  membershipIdentity: 'stated' | 'none';
  files: number;
  receipts: {
    read: number;
    accepted: number;
    held: number;
    /** Held records that keep a date, both capture files agreeing on it. */
    heldWithDate: number;
    byChannel: Counts<RetailChannel>;
    bySign: Counts<RetailSign>;
    heldByReason: Counts<RetailHoldReason>;
    /** Every check the converter runs, with how many records it held: the identities checked, by name. */
    heldByCheck: Counts<RetailHoldCheck>;
  };
  /** Online orders: `live` when the card or the wallet Shop Card paid something, `zeroTotal` when nothing was charged. */
  online: { orders: number; live: number; zeroTotal: number; withCoupons: number; byStatus: Counts<RetailOnlineStatus> };
  lines: { byKind: Counts<RetailLineKind>; titlesHeld: number; itemNumbersHeld: number; withoutMoney: number };
  coupons: { resolved: number; unresolved: number };
  tenders: { byKind: Counts<RetailTenderKind> };
  metal: {
    lines: number; withWeight: number; byForm: Counts<RetailMetalForm | 'none'>; byPack: Counts<RetailMetalPack>;
    /** Why the pack rule read each metal line as it did: its closed reason codes. */
    byPackReason: Counts<RetailMetalPackReason>;
    pullFlagOnly: number; ruleOnly: number;
    /**
     * Metal guard v1 over every line with a title (Root's definition, per source): the lines whose title names a metal as
     * a whole word, as metal, flagged metal-uncertain (by clause, and how many on adjacency alone) or with no bullion
     * evidence (no flag: kept visible as drift). Silent omissions, a line naming a metal with evidence that is neither
     * metal nor flagged, are always 0.
     */
    guard: {
      metalWordLines: number; metal: number; uncertain: number; byClause: Counts<RetailMetalGuardClause>; adjacencyOnly: number;
      withoutEvidence: number; silentOmissions: number;
    };
  };
  duplicates: { identical: number };
  rawUnlisted: { receipts: number; details: number };
  coverage: {
    online: Array<{ from: string; to: string; complete: boolean | null }>;
    warehouse: Array<{ from: string; to: string; complete: boolean | null }>;
  };
  dates: { first: string | null; last: string | null };
}

export interface CostcoConvertResult {
  payload: RetailImportPayload;
  /** The payload's canonical text (serializeRetailImportPayload), byte-identical for the same capture. */
  json: string;
  report: CostcoConvertReport;
}

// ---------------------------------------------------------------------------
// Reading values
// ---------------------------------------------------------------------------

/** A value of the wrong shape: the record it belongs to is held `unreadable` (`record-shape`). */
class Unreadable extends Error {
  constructor(readonly at: string) {
    super('unreadable');
  }
}

/** A record that doesn't hold: it is held by the check it failed, under that check's reason. */
class Hold extends Error {
  readonly reason: RetailHoldReason;
  constructor(readonly check: RetailHoldCheck) {
    super(check);
    this.reason = RETAIL_HOLD_CHECKS[check];
  }
}

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);

function rec(value: unknown, at: string): Rec {
  if (!isRecord(value)) throw new Unreadable(at);
  return value;
}

function arr(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) throw new Unreadable(at);
  return value;
}

function str(value: unknown, at: string): string {
  if (typeof value !== 'string') throw new Unreadable(at);
  return value;
}

function optStr(value: unknown, at: string): string | null {
  return value === null || value === undefined ? null : str(value, at);
}

function int(value: unknown, at: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Unreadable(at);
  return value;
}

function bool(value: unknown, at: string): boolean {
  if (typeof value !== 'boolean') throw new Unreadable(at);
  return value;
}

/** A yes/no field as the capture states it: a boolean, or absent or null for not stated. Anything else can't be read. */
function flag(value: unknown, at: string): boolean | null {
  return value === null || value === undefined ? null : bool(value, at);
}

/** Whether a stored-value bucket names one: only absent, null and the empty string mean none. */
const namesStoredValue = (value: unknown) => !(value === null || value === undefined || value === '');

/** A number of dollars with at most two decimals, as integer cents. */
function cents(value: unknown, at: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Unreadable(at);
  const scaled = value * 100;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-6 || Math.abs(rounded) > RETAIL_MAX_MINOR) throw new Unreadable(at);
  return rounded === 0 ? 0 : rounded;
}

/** The consolidated file's money, `{ cents, currency, raw }`: USD, and its cents and raw dollars agreeing. */
function money(value: unknown, at: string): number {
  const record = rec(value, at);
  if (record.currency !== 'USD') throw new Hold('money-currency');
  const amount = int(record.cents, `${at}.cents`);
  if (cents(record.raw, `${at}.raw`) !== amount) throw new Hold('money-raw');
  return amount;
}

const STAMP = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

/** A local date and time as Costco gives it: the date is the first ten characters, the time what follows, no zone. */
function stamp(value: unknown, at: string): { date: string; time: string | null } {
  const match = STAMP.exec(str(value, at));
  if (!match || !isRetailDate(match[1])) throw new Unreadable(at);
  const time = match[2] ?? null;
  if (time !== null && !TIME.test(time)) throw new Unreadable(at);
  return { date: match[1], time };
}

function optDay(value: unknown, at: string): string | null {
  return value === null || value === undefined || value === '' ? null : stamp(value, at).date;
}

/** Text as Holdr stores it, or null when it is empty or the card-data guard holds it. */
function storedText(value: string | null): { text: string | null; held: boolean } {
  if (value === null || value.trim() === '') return { text: null, held: false };
  const clean = sanitizeCardText(value, RETAIL_TITLE_MAX);
  if (clean === null) return { text: null, held: false };
  return cardImportTextProblem(clean, RETAIL_TITLE_MAX) === null ? { text: clean, held: false } : { text: null, held: true };
}

/** An item number as Holdr stores it, or null when it has another form or could be read as card data. */
function storedItemNumber(value: string | null): { number: string | null; held: boolean } {
  if (value === null) return { number: null, held: false };
  const trimmed = value.trim();
  if (!/^[0-9]{1,12}$/.test(trimmed)) return { number: null, held: trimmed !== '' };
  return containsCardData(trimmed) ? { number: null, held: true } : { number: trimmed, held: false };
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

const ONLINE_STATUS: ReadonlyMap<string, RetailOnlineStatus> = new Map([
  ['SHIPPED', 'shipped'], ['DELIVERED', 'delivered'], ['CANCELLED', 'cancelled'], ['CANCELED', 'cancelled'], ['RETURNED', 'returned'],
]);

const norm = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();

/** How an online line reaches the owner, from its ship method's words. Anything else is `unknown`. */
function fulfilmentOf(method: string | null): RetailFulfilment {
  if (method === null) return 'unknown';
  const words = norm(method);
  if (words === 'DELIVERY VIA EMAIL') return 'email';
  if (words === 'DELIVERY AND SET UP' || words === 'DELIVERY AND SETUP' || words.startsWith('WHITE GLOVE')) return 'delivery-setup';
  if (/^(?:STANDARD|EXPRESS|GROUND|TWO[- ]DAY|2[- ]DAY|NEXT[- ]DAY|PRIORITY)\b/.test(words)) return 'parcel';
  return 'unknown';
}

function carrierOf(name: string | null): RetailCarrier | null {
  if (name === null || name.trim() === '') return null;
  const words = norm(name);
  if (/\bUPS\b/.test(words)) return 'ups';
  if (/\bFED ?EX\b/.test(words)) return 'fedex';
  if (/\bUSPS\b|\bPOSTAL\b/.test(words)) return 'usps';
  return 'other';
}

interface TenderSpec {
  kind: RetailTenderKind;
  network: RetailNetwork;
}

/** A warehouse tender by its printed name (and, at the pump, its type code). Anything else is held, never guessed. */
function warehouseTenderSpec(name: string, code: string | null): TenderSpec | null {
  const words = norm(name);
  if (words === 'VISA' || words === 'COSTCO VISA') return { kind: 'card', network: 'visa' };
  if (words === 'VI ACCT #' && code === 'CreditDebit') return { kind: 'card', network: 'visa' };
  if (words === 'RTC WHSE PUR') return { kind: 'card-refund', network: 'unknown' };
  if (words === 'DEBIT CARD') return { kind: 'debit', network: 'unknown' };
  if (words === 'CASH') return { kind: 'cash', network: 'unknown' };
  if (words === 'SHOP CARD') return { kind: 'shop-card', network: 'unknown' };
  if (/^[0-9]{1,2}% REBATE$/.test(words) || words === 'CITI REBATE') return { kind: 'reward-certificate', network: 'unknown' };
  return null;
}

/** An online payment row's type. Anything else is held. */
function onlinePaymentSpec(type: string): TenderSpec | null {
  const words = norm(type);
  if (words === 'VISA') return { kind: 'card', network: 'visa' };
  if (words === 'MASTER CARD' || words === 'MASTERCARD') return { kind: 'card', network: 'mastercard' };
  if (words === 'COUPON') return { kind: 'coupon', network: 'unknown' };
  if (words === 'WALLET SHOP CARD') return { kind: 'shop-card', network: 'unknown' };
  return null;
}

/**
 * A wallet Shop Card payment's stored-value bucket, the one value known (design: Shop Card v1). The captures spell it
 * `ShopCard`; it is read as a payment type is (`norm`), so in any case, and both files must spell it the same.
 */
const SHOP_CARD_BUCKET = 'SHOPCARD';
const isShopCardBucket = (value: unknown) => typeof value === 'string' && norm(value) === SHOP_CARD_BUCKET;
/** A field that is there and states nothing: the empty string or null, never a missing key (design v1's one shape). */
const statedEmpty = (record: Rec, key: string) => Object.prototype.hasOwnProperty.call(record, key) && (record[key] === null || record[key] === '');

/**
 * The Costco Shop Card products, exactly as Costco's catalog lists them: public catalog identifiers (item number and
 * exact title, as written), read out of the captures for this list only and reviewed (Root's ruling, 11/08). A line buys a
 * Shop Card, `storedValue: 'costco-shop-card'`, only when its channel, item number and exact title are one of these: an
 * online order's or a warehouse receipt's, never a fuel receipt's.
 */
export const COSTCO_SHOP_CARD_PURCHASES: ReadonlyArray<{ channel: 'online' | 'warehouse'; itemNumber: string; title: string; title2: string | null }> = [
  { channel: 'online', itemNumber: '1695798', title: 'Costco Shop Card, Digital, $100 Shop Card', title2: null },
  { channel: 'online', itemNumber: '1695808', title: 'COSTCO DIGITAL SHOP CARD', title2: null },
  { channel: 'warehouse', itemNumber: '155', title: 'SHOP CARD', title2: null },
];
/**
 * Whether a title names a Shop Card, read loosely so that no spelling slips through as goods: NFKC, upper case, and every
 * character that is not a letter or a digit dropped (spaces, punctuation, marks and invisible characters alike), then
 * SHOPCARD anywhere. It also catches a title that only holds those letters ("WORKSHOP CARDIGAN"): such a line is held,
 * never guessed, since the catalog list alone says what a Shop Card is.
 */
const namesAShopCard = (text: string) => text.normalize('NFKC').toUpperCase().replace(/[^\p{L}\p{N}]+/gu, '').includes(SHOP_CARD_BUCKET);

/**
 * A line's metal facts from its raw title (a warehouse line's two description lines joined), before any sanitizing.
 * When the rule reads the line (`assessed`: an item line with its first description) and finds metal: its evidence and,
 * on the same raw text, the pack rule's reading, whose reason only the report counts. Otherwise metal guard v1's
 * reading: a flag when the title names a metal as a whole word and shows bullion evidence (`assessed` false: a fee or
 * fuel line, never metal, or an item line with only its second description, which the rule never read). A flag changes
 * nothing else: the record is kept as it is. Holding the line is the metals ledger's, from the metals contract's
 * follow-up 1 (after this policy).
 */
function lineMetalFacts(raw: string, facts: LineFacts, assessed: boolean): { metal: RetailLineMetal | null; metalUncertain: RetailLineMetalUncertain | null } {
  const evidence = assessed ? retailMetalTitleEvidence(raw) : null;
  if (evidence !== null) {
    const { pack, reason } = retailMetalPackAssessment(raw);
    facts.packReasons[reason] += 1;
    facts.guard.metalWordLines += 1;
    facts.guard.metal += 1;
    return { metal: { ...evidence, pack }, metalUncertain: null };
  }
  const reading = retailMetalTitleGuard(raw, { assessed });
  if (!reading.metalWord) return { metal: null, metalUncertain: null };
  facts.guard.metalWordLines += 1;
  if (reading.uncertain && reading.clause !== null) {
    facts.guard.uncertain += 1;
    facts.guard.byClause[reading.clause] += 1;
    if (reading.clause.endsWith('/adjacency')) facts.guard.adjacencyOnly += 1;
    return { metal: null, metalUncertain: { guard: RETAIL_METAL_GUARD, evidence: reading.evidence, metal: reading.metal } };
  }
  if (reading.evidence.length === 0) facts.guard.withoutEvidence += 1;
  else facts.guard.silentOmissions += 1;
  return { metal: null, metalUncertain: null };
}
const NO_METAL = { metal: null, metalUncertain: null } as const;

/**
 * Whether a line buys a Costco Shop Card: `listed` by the catalog list, `unlisted` (it names one), or `no`. A fuel
 * receipt's line is never listed, so one that names a Shop Card is held.
 */
function shopCardPurchase(channel: RetailChannel, itemNumber: string | null, title: string, title2: string | null): 'listed' | 'unlisted' | 'no' {
  const listed = COSTCO_SHOP_CARD_PURCHASES.some((entry) => entry.channel === channel && entry.itemNumber === (itemNumber ?? '').trim()
    && entry.title === title.trim() && entry.title2 === (title2 === null || title2.trim() === '' ? null : title2.trim()));
  if (listed) return 'listed';
  return namesAShopCard(`${title} ${title2 ?? ''}`) ? 'unlisted' : 'no';
}

// ---------------------------------------------------------------------------
// The report, as records are read
// ---------------------------------------------------------------------------

function emptyReport(folder: string, files: number, identity: 'stated' | 'none'): CostcoConvertReport {
  return {
    converter: RETAIL_CONVERTER,
    policyVersion: RETAIL_CONVERT_POLICY_VERSION,
    merchant: 'costco',
    folder,
    schema: COSTCO_CAPTURE_SCHEMA,
    membershipIdentity: identity,
    files,
    receipts: {
      read: 0, accepted: 0, held: 0, heldWithDate: 0, byChannel: zeroes(RETAIL_CHANNELS), bySign: zeroes(RETAIL_SIGNS),
      heldByReason: zeroes(RETAIL_HOLD_REASONS), heldByCheck: zeroes(RETAIL_HOLD_CHECK_NAMES),
    },
    online: { orders: 0, live: 0, zeroTotal: 0, withCoupons: 0, byStatus: zeroes(RETAIL_ONLINE_STATUSES) },
    lines: { byKind: zeroes(RETAIL_LINE_KINDS), titlesHeld: 0, itemNumbersHeld: 0, withoutMoney: 0 },
    coupons: { resolved: 0, unresolved: 0 },
    tenders: { byKind: zeroes(RETAIL_TENDER_KINDS) },
    metal: {
      lines: 0, withWeight: 0, byForm: zeroes(['bar', 'coin', 'round', 'ingot', 'bullion', 'none'] as const), byPack: zeroes(RETAIL_METAL_PACKS),
      byPackReason: zeroes(RETAIL_METAL_PACK_REASONS), pullFlagOnly: 0, ruleOnly: 0, guard: noGuardCounts(),
    },
    duplicates: { identical: 0 },
    rawUnlisted: { receipts: 0, details: 0 },
    coverage: { online: [], warehouse: [] },
    dates: { first: null, last: null },
  };
}

/** What one record's conversion found, counted only if the record is kept. */
interface LineFacts {
  titlesHeld: number;
  itemNumbersHeld: number;
  withoutMoney: number;
  couponsResolved: number;
  couponsUnresolved: number;
  pullFlagOnly: number;
  ruleOnly: number;
  /** The pack rule's reason for each metal line (a line without money is dropped before any metal is read). */
  packReasons: Counts<RetailMetalPackReason>;
  /** Metal guard v1, over the record's lines with a title. */
  guard: CostcoConvertReport['metal']['guard'];
}
const noGuardCounts = (): CostcoConvertReport['metal']['guard'] => ({
  metalWordLines: 0, metal: 0, uncertain: 0, byClause: zeroes(RETAIL_METAL_GUARD_CLAUSES), adjacencyOnly: 0, withoutEvidence: 0, silentOmissions: 0,
});
const noFacts = (): LineFacts => ({
  titlesHeld: 0, itemNumbersHeld: 0, withoutMoney: 0, couponsResolved: 0, couponsUnresolved: 0, pullFlagOnly: 0, ruleOnly: 0,
  packReasons: zeroes(RETAIL_METAL_PACK_REASONS), guard: noGuardCounts(),
});

interface Converted {
  receipt: RetailImportReceipt;
  facts: LineFacts;
}

// ---------------------------------------------------------------------------
// Warehouse and gas receipts
// ---------------------------------------------------------------------------

/** The one receipt a raw receipt response holds. */
function rawReceiptOf(raw: unknown, at: string): Rec {
  const receipts = arr(rec(rec(rec(rec(raw, at).response, `${at}.response`).data, `${at}.response.data`).receiptsWithCounts,
    `${at}.response.data.receiptsWithCounts`).receipts, `${at}.receipts`);
  if (receipts.length !== 1) throw new Unreadable(`${at}.receipts`);
  return rec(receipts[0], `${at}.receipts[0]`);
}

/** A raw receipt response's receipt type, or null when it can't be read. */
function rawReceiptTypeOf(raw: unknown): string | null {
  try {
    const type = rawReceiptOf(raw, 'raw').receiptType;
    return typeof type === 'string' ? type : null;
  } catch (error) {
    if (error instanceof Unreadable) return null;
    throw error;
  }
}

function channelOf(receiptType: string, documentType: string): RetailChannel {
  if (receiptType === 'In-Warehouse' && documentType === 'WarehouseReceiptDetail') return 'warehouse';
  if (receiptType === 'Gas Station' && documentType === 'FuelReceipts') return 'gas';
  throw new Hold('receipt-type');
}

function gallons(value: unknown, at: string): string | null {
  return statedDecimal(value, at, 10_000);
}

/**
 * A non-negative decimal below `limit`, exactly as the receipt states it, as text ("12.345", "3.459"): never rounded.
 * More than four decimals can't be kept exactly, so the value is unreadable.
 */
function statedDecimal(value: unknown, at: string, limit: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= limit) throw new Unreadable(at);
  const scaled = value * 10_000;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) throw new Unreadable(at);
  return value.toFixed(4).replace(/\.?0+$/, '');
}

function warehouseLines(items: readonly unknown[], at: string, facts: LineFacts, channel: RetailChannel): RetailImportLine[] {
  const lines: RetailImportLine[] = [];
  const couponRefs = new Map<number, string>();
  items.forEach((entry, index) => {
    const path = `${at}.itemArray[${index}]`;
    const item = rec(entry, path);
    // A line that carries no money at all is informational: the receipt's sums are checked without it.
    if ((item.amount === null || item.amount === undefined) && (item.unit === null || item.unit === undefined)) {
      facts.withoutMoney += 1;
      return;
    }
    const description = optStr(item.itemDescription01, `${path}.itemDescription01`);
    const second = optStr(item.itemDescription02, `${path}.itemDescription02`);
    const fuelUnit = optStr(item.fuelUomCode, `${path}.fuelUomCode`);
    const coupon = description !== null && description.trim().startsWith('/');
    const kind: RetailLineKind = fuelUnit !== null && fuelUnit.trim() !== '' ? 'fuel' : coupon ? 'coupon' : 'item';
    const number = storedItemNumber(optStr(item.itemNumber, `${path}.itemNumber`));
    if (number.held) facts.itemNumbersHeld += 1;
    const ordinal = lines.length;
    let title: string | null = null;
    let title2: string | null = null;
    if (kind === 'coupon') {
      const ref = /^\/\s*([0-9]{1,12})\b/.exec(description!.trim());
      if (ref) couponRefs.set(ordinal, ref[1]);
    } else {
      const first = storedText(description);
      const next = storedText(second);
      if (first.held) facts.titlesHeld += 1;
      if (next.held) facts.titlesHeld += 1;
      title = first.text;
      title2 = next.text;
    }
    const department = item.itemDepartmentNumber === null || item.itemDepartmentNumber === undefined
      ? null : int(item.itemDepartmentNumber, `${path}.itemDepartmentNumber`);
    const taxFlag = typeof item.taxFlag === 'string' && /^[A-Z0-9]$/.test(item.taxFlag.trim().toUpperCase())
      ? item.taxFlag.trim().toUpperCase() : null;
    // The rule reads an item line with its first description, as before. Metal guard v1 reads every line with any
    // description but a coupon: a fuel line, and an item line with only its second description, too, as not assessed.
    const raw = [description ?? '', second ?? ''].join(' ').trim();
    const { metal, metalUncertain } = kind !== 'coupon' && raw !== ''
      ? lineMetalFacts(raw, facts, kind === 'item' && description !== null) : NO_METAL;
    // A Shop Card purchase is a FACT from the exact catalog list of this receipt's own channel; a title naming a Shop
    // Card that isn't listed is held, and so is a listed one the rule reads as metal. (No listed title names a metal, so
    // the guard never flags one; the validator refuses a flag beside the Shop Card fact.)
    const shopCard = kind === 'item' && description !== null ? shopCardPurchase(channel, optStr(item.itemNumber, `${path}.itemNumber`), description, second) : 'no';
    if (shopCard === 'unlisted' || (shopCard === 'listed' && metal !== null)) throw new Hold('shop-card-purchase-unlisted');
    const statedUnitPrice = item.itemUnitPriceAmount === null || item.itemUnitPriceAmount === undefined;
    lines.push({
      ordinal,
      lineKey: null,
      kind,
      itemNumber: number.number,
      title,
      title2,
      department: department !== null && department >= 0 && department <= 9999 ? department : null,
      quantity: item.unit === null || item.unit === undefined ? null : int(item.unit, `${path}.unit`),
      // A fuel line's price per gallon has tenths of a cent: it is kept as stated text, never rounded to cents.
      unitPriceMinor: kind === 'fuel' || statedUnitPrice ? null : cents(item.itemUnitPriceAmount, `${path}.itemUnitPriceAmount`),
      amountMinor: cents(item.amount, `${path}.amount`),
      shippingMinor: null,
      taxFlag,
      couponTarget: null,
      feeParent: null,
      fulfilment: null,
      metal,
      metalUncertain,
      storedValue: shopCard === 'listed' ? 'costco-shop-card' : null,
      fuelGallons: kind === 'fuel' ? gallons(item.fuelUnitQuantity, `${path}.fuelUnitQuantity`) : null,
      fuelUnitPrice: kind === 'fuel' ? statedDecimal(item.itemUnitPriceAmount, `${path}.itemUnitPriceAmount`, 1_000) : null,
      events: null,
      shipments: [],
    });
  });
  // A coupon discounts the one line of its item number whose amount has the other sign; otherwise it stays receipt-level.
  for (const [ordinal, ref] of couponRefs) {
    const coupon = lines[ordinal];
    const targets = lines.filter((line) => line.kind !== 'coupon' && line.itemNumber === ref
      && Math.sign(line.amountMinor) === -Math.sign(coupon.amountMinor) && line.amountMinor !== 0);
    if (targets.length === 1) {
      coupon.couponTarget = targets[0].ordinal;
      facts.couponsResolved += 1;
    } else facts.couponsUnresolved += 1;
  }
  for (const line of lines) if (line.kind === 'coupon' && !couponRefs.has(line.ordinal)) facts.couponsUnresolved += 1;
  return lines;
}

function warehouseTender(entry: unknown, at: string, ordinal: number): RetailImportTender {
  const tender = rec(entry, at);
  const spec = warehouseTenderSpec(optStr(tender.tenderTypeName, `${at}.tenderTypeName`) ?? '', optStr(tender.tenderTypeCode, `${at}.tenderTypeCode`));
  if (spec === null) throw new Hold('tender-name');
  const amountMinor = cents(tender.amountTender, `${at}.amountTender`);
  if (amountMinor === 0) throw new Hold('tender-zero');
  let last4: string | null = null;
  if (spec.kind === 'card' || spec.kind === 'card-refund') {
    const shown = optStr(tender.displayAccountNumberLast4, `${at}.displayAccountNumberLast4`);
    if (shown === null || !/^[0-9]{4}$/.test(shown)) throw new Hold('tender-last4');
    last4 = shown;
  }
  return { ordinal, kind: spec.kind, network: spec.network, last4, amountMinor };
}

function warehouseReceipt(consolidated: Rec, raw: Rec, at: string): Converted {
  const facts = noFacts();
  const receipt = rawReceiptOf(raw, at);
  const channel = channelOf(str(receipt.receiptType, `${at}.receiptType`), str(receipt.documentType, `${at}.documentType`));
  if (consolidated.receiptType !== receipt.receiptType || consolidated.documentType !== receipt.documentType
    || (consolidated.transactionType ?? null) !== (receipt.transactionType ?? null)) {
    throw new Hold('record-type');
  }
  const country = optStr(receipt.warehouseCountry, `${at}.warehouseCountry`);
  if (country !== null && country.trim().toUpperCase() !== 'US') throw new Hold('warehouse-country');
  const totalMinor = cents(receipt.total, `${at}.total`);
  const subtotalMinor = cents(receipt.subTotal, `${at}.subTotal`);
  const taxMinor = cents(receipt.taxes, `${at}.taxes`);
  const instantSavingsMinor = receipt.instantSavings === null || receipt.instantSavings === undefined
    ? null : cents(receipt.instantSavings, `${at}.instantSavings`);
  const when = stamp(receipt.transactionDateTime, `${at}.transactionDateTime`);
  if (stamp(receipt.transactionDate, `${at}.transactionDate`).date !== when.date) throw new Hold('record-date');
  if (str(consolidated.date, 'date') !== when.date) throw new Hold('record-date');
  if (money(consolidated.total, 'total') !== totalMinor || money(consolidated.subTotal, 'subTotal') !== subtotalMinor
    || money(consolidated.taxes, 'taxes') !== taxMinor
    || (instantSavingsMinor !== null && money(consolidated.instantSavings, 'instantSavings') !== instantSavingsMinor)
    || (instantSavingsMinor === null && consolidated.instantSavings !== undefined && consolidated.instantSavings !== null
      && money(consolidated.instantSavings, 'instantSavings') !== 0)) {
    throw new Hold('record-totals');
  }
  const items = arr(receipt.itemArray, `${at}.itemArray`);
  if (consolidated.itemLines !== items.length) throw new Hold('record-lines');
  if (items.length === 0 || items.length > RETAIL_MAX_LINES) throw new Hold('line-count');
  if (totalMinor === 0) throw new Hold('zero-total');
  const sign: RetailSign = totalMinor > 0 ? 'sale' : 'refund';
  const lines = warehouseLines(items, at, facts, channel);
  if (lines.length === 0) throw new Hold('line-count');
  const rawTenders = arr(receipt.tenderArray, `${at}.tenderArray`);
  if (rawTenders.length === 0 || rawTenders.length > RETAIL_MAX_TENDERS) throw new Hold('tender-count');
  const tenders = rawTenders.map((entry, index) => warehouseTender(entry, `${at}.tenderArray[${index}]`, index));
  const listed = arr(consolidated.tenders, 'tenders');
  if (listed.length !== rawTenders.length) throw new Hold('record-tenders');
  listed.forEach((entry, index) => {
    const shown = rec(entry, `tenders[${index}]`);
    const rawTender = rec(rawTenders[index], `${at}.tenderArray[${index}]`);
    if (money(shown.amount, `tenders[${index}].amount`) !== tenders[index].amountMinor
      || (shown.last4 ?? null) !== (rawTender.displayAccountNumberLast4 ?? null)
      || (shown.typeName ?? null) !== (rawTender.tenderTypeName ?? null)
      || (shown.typeCode ?? null) !== (rawTender.tenderTypeCode ?? null)) {
      throw new Hold('record-tenders');
    }
  });
  if (sum(lines.map((line) => line.amountMinor)) !== subtotalMinor) throw new Hold('lines-subtotal');
  if (subtotalMinor + taxMinor !== totalMinor) throw new Hold('subtotal-tax-total');
  if (sum(tenders.map((tender) => tender.amountMinor)) !== totalMinor) throw new Hold('tenders-total');
  // Every tender carries the total's sign, except change: cash given back on a sale that no card or card refund paid.
  const changeAllowed = totalMinor > 0 && !tenders.some((tender) => tender.kind === 'card' || tender.kind === 'card-refund');
  if (tenders.some((tender) => Math.sign(tender.amountMinor) !== Math.sign(totalMinor) && !(changeAllowed && tender.kind === 'cash'))) {
    throw new Hold('tender-sign');
  }
  const taxLegends = taxLegendsOf(receipt.subTaxes, `${at}.subTaxes`);
  return {
    receipt: {
      channel,
      naturalKey: '',
      date: when.date,
      localTime: when.time,
      sign,
      status: null,
      currency: 'USD',
      totals: { subtotalMinor, taxMinor, instantSavingsMinor, discountMinor: null, shippingMinor: null, feesMinor: null, storedValueMinor: null, totalMinor },
      taxLegends,
      lines,
      tenders,
    },
    facts,
  };
}

/** The receipt's tax by legend (A, C, …), as printed. */
function taxLegendsOf(value: unknown, at: string): Array<{ legend: string; amountMinor: number }> {
  if (value === null || value === undefined) return [];
  const taxes = rec(value, at);
  const legends: Array<{ legend: string; amountMinor: number }> = [];
  for (const letter of ['a', 'b', 'c', 'd', 'u']) {
    const legend = taxes[`${letter}TaxLegend`];
    const amount = taxes[`${letter}TaxAmount`];
    if (legend === null || legend === undefined || amount === null || amount === undefined) continue;
    const name = str(legend, `${at}.${letter}TaxLegend`).trim().toUpperCase();
    if (!/^[A-Z]$/.test(name)) continue;
    legends.push({ legend: name, amountMinor: cents(amount, `${at}.${letter}TaxAmount`) });
  }
  return legends;
}

// ---------------------------------------------------------------------------
// Online orders
// ---------------------------------------------------------------------------

function rawDetailsOf(raw: unknown, at: string): Rec {
  return rec(rec(rec(rec(raw, at).response, `${at}.response`).data, `${at}.response.data`).getOrderDetails, `${at}.getOrderDetails`);
}

function unitEvents(value: unknown, at: string): RetailUnitEvent[] {
  if (value === null || value === undefined) return [];
  return arr(value, at).map((entry, index) => {
    const event = rec(entry, `${at}[${index}]`);
    const quantity = int(event.quantity, `${at}[${index}].quantity`);
    if (quantity < 1) throw new Unreadable(`${at}[${index}].quantity`);
    return { quantity, date: stamp(event.transactionDate, `${at}[${index}].transactionDate`).date };
  });
}

/** A count as the capture states it, `"2"` or `2`; null when it states none. */
function statedCount(value: unknown, at: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  const text = typeof value === 'number' ? String(value) : str(value, at).trim();
  if (!/^[0-9]{1,6}$/.test(text)) throw new Unreadable(at);
  return Number(text);
}

function shipmentsOf(value: unknown, at: string): RetailShipment[] {
  if (value === null || value === undefined) return [];
  return arr(value, at).map((entry, index) => {
    const shipment = rec(entry, `${at}[${index}]`);
    return {
      shippedDate: optDay(shipment.shippedDate, `${at}[${index}].shippedDate`),
      deliveredDate: optDay(shipment.deliveredDate, `${at}[${index}].deliveredDate`),
      estimatedArrivalDate: optDay(shipment.estimatedArrivalDate, `${at}[${index}].estimatedArrivalDate`),
      carrier: carrierOf(optStr(shipment.carrierName, `${at}[${index}].carrierName`)),
    };
  });
}

const optCents = (value: unknown, at: string) => (value === null || value === undefined ? 0 : cents(value, at));

function onlineOrder(consolidated: Rec, raw: Rec, orderNumber: string, at: string): Converted {
  const facts = noFacts();
  const details = rawDetailsOf(raw, at);
  if (str(details.orderNumber, `${at}.orderNumber`) !== orderNumber) throw new Hold('record-number');
  const placed = stamp(details.orderPlacedDate, `${at}.orderPlacedDate`);
  if (str(consolidated.orderDate, 'orderDate') !== placed.date) throw new Hold('record-date');
  const statusText = str(details.status, `${at}.status`);
  if (consolidated.status !== statusText) throw new Hold('record-status');
  const status = ONLINE_STATUS.get(norm(statusText)) ?? 'other';
  for (const index of [1, 2, 3, 4]) {
    if (optCents(details[`foreignTaxTotal${index}`], `${at}.foreignTaxTotal${index}`) !== 0) throw new Hold('foreign-tax');
  }
  // A physical Shop Card has never been seen, so its shape is unknown: held. A wallet Shop Card is read (design v1).
  if (optCents(details.shopCardAppliedAmount, `${at}.shopCardAppliedAmount`) !== 0) throw new Hold('shop-card-physical');
  const walletMinor = optCents(details.walletShopCardAppliedAmount, `${at}.walletShopCardAppliedAmount`);
  if (walletMinor < 0) throw new Hold('shop-card-sum');
  if (optCents(details.giftOfMembershipAppliedAmount, `${at}.giftOfMembershipAppliedAmount`) !== 0) {
    throw new Hold('gift-of-membership-applied');
  }
  // Both files must state the same Shop Card amounts: no physical one, and the same wallet one.
  if (money(consolidated.shopCardApplied, 'shopCardApplied') !== 0
    || money(consolidated.walletShopCardApplied, 'walletShopCardApplied') !== walletMinor) {
    throw new Hold('record-totals');
  }
  const subtotalMinor = cents(details.merchandiseTotal, `${at}.merchandiseTotal`);
  const shippingMinor = cents(details.shippingAndHandling, `${at}.shippingAndHandling`);
  const taxMinor = cents(details.uSTaxTotal1, `${at}.uSTaxTotal1`);
  const discountMinor = cents(details.discountAmount, `${at}.discountAmount`);
  const totalMinor = cents(details.orderTotal, `${at}.orderTotal`);
  const deliveryFee = optCents(details.retailDeliveryFee, `${at}.retailDeliveryFee`);
  const surcharge = optCents(details.nonMemberSurchargeAmount, `${at}.nonMemberSurchargeAmount`);
  const feesMinor = deliveryFee + surcharge + optCents(details.grocerySurcharge, `${at}.grocerySurcharge`)
    + optCents(details.frozenSurchargeFee, `${at}.frozenSurchargeFee`);
  if (money(consolidated.total, 'total') !== totalMinor || money(consolidated.merchandiseTotal, 'merchandiseTotal') !== subtotalMinor
    || money(consolidated.shippingAndHandling, 'shippingAndHandling') !== shippingMinor || money(consolidated.tax, 'tax') !== taxMinor
    || money(consolidated.discount, 'discount') !== discountMinor
    || money(consolidated.retailDeliveryFee, 'retailDeliveryFee') !== deliveryFee
    || money(consolidated.nonMemberSurcharge, 'nonMemberSurcharge') !== surcharge) {
    throw new Hold('record-totals');
  }
  const rawLines: Rec[] = [];
  arr(details.shipToAddress, `${at}.shipToAddress`).forEach((entry, index) => {
    const address = rec(entry, `${at}.shipToAddress[${index}]`);
    arr(address.orderLineItems, `${at}.shipToAddress[${index}].orderLineItems`)
      .forEach((line, at2) => rawLines.push(rec(line, `${at}.shipToAddress[${index}].orderLineItems[${at2}]`)));
  });
  if (rawLines.length === 0 || rawLines.length > RETAIL_MAX_LINES) throw new Hold('line-count');
  const listedLines = arr(consolidated.lines, 'lines').map((line, index) => rec(line, `lines[${index}]`));
  if (listedLines.length !== rawLines.length) throw new Hold('record-lines');
  const listedById = new Map<string, Rec>();
  for (const [index, line] of listedLines.entries()) {
    const id = str(line.lineItemId, `lines[${index}].lineItemId`);
    if (listedById.has(id)) throw new Hold('record-lines');
    listedById.set(id, line);
  }
  const ids = rawLines.map((line, index) => str(line.lineItemId, `${at}.lines[${index}].lineItemId`));
  if (new Set(ids).size !== ids.length || ids.some((id) => !/^[0-9]{1,20}$/.test(id))) throw new Hold('line-ids');
  const lines: RetailImportLine[] = rawLines.map((line, index) => {
    const path = `${at}.lines[${index}]`;
    const id = ids[index];
    const listed = listedById.get(id);
    if (!listed) throw new Hold('record-lines');
    const quantity = int(line.quantity, `${path}.quantity`);
    const unitPriceMinor = cents(line.price, `${path}.price`);
    const amountMinor = cents(line.merchandiseTotalAmount, `${path}.merchandiseTotalAmount`);
    const lineShipping = cents(line.shippingChargeAmount, `${path}.shippingChargeAmount`);
    if (int(listed.qty, `lines[${index}].qty`) !== quantity || money(listed.unitPrice, `lines[${index}].unitPrice`) !== unitPriceMinor
      || money(listed.merchandiseTotal, `lines[${index}].merchandiseTotal`) !== amountMinor
      || money(listed.shippingCharge, `lines[${index}].shippingCharge`) !== lineShipping) {
      throw new Hold('record-lines');
    }
    // The line's identity, as both files state it: item number, item id, description, fee flag and ship method.
    if ((listed.itemNumber ?? null) !== (line.itemNumber ?? null) || (listed.itemId ?? null) !== (line.itemId ?? null)
      || (listed.description ?? null) !== (line.itemDescription ?? null) || (listed.isFeeItem ?? null) !== (line.isFeeItem ?? null)
      || (listed.shipMethod ?? null) !== (line.orderedShipMethodDescription ?? null)) {
      throw new Hold('record-lines');
    }
    if (quantity < 0 || unitPriceMinor < 0 || amountMinor < 0 || lineShipping < 0) throw new Hold('line-negative');
    const fee = bool(line.isFeeItem, `${path}.isFeeItem`);
    const description = optStr(line.itemDescription, `${path}.itemDescription`);
    const titleText = storedText(description);
    if (titleText.held) facts.titlesHeld += 1;
    const number = storedItemNumber(optStr(line.itemNumber, `${path}.itemNumber`));
    if (number.held) facts.itemNumbersHeld += 1;
    // The rule reads an item line; metal guard v1 reads a fee line too (never metal).
    const { metal, metalUncertain } = description !== null ? lineMetalFacts(description, facts, !fee) : NO_METAL;
    // A Shop Card purchase is a FACT from the exact catalog list; a title naming a Shop Card that isn't listed is held, and
    // so is a listed one the rule reads as metal. (No listed title names a metal, so the guard never flags one.)
    const shopCard = !fee && description !== null ? shopCardPurchase('online', optStr(line.itemNumber, `${path}.itemNumber`), description, null) : 'no';
    if (shopCard === 'unlisted' || (shopCard === 'listed' && metal !== null)) throw new Hold('shop-card-purchase-unlisted');
    const pullFlag = listed.isPreciousMetal === true;
    if (pullFlag && metal === null) facts.pullFlagOnly += 1;
    if (!pullFlag && metal !== null) facts.ruleOnly += 1;
    const itemStatus = rec(line.itemStatus ?? {}, `${path}.itemStatus`);
    const events: RetailLineEvents = {
      shipped: unitEvents(itemStatus.shipped, `${path}.itemStatus.shipped`),
      delivered: unitEvents(itemStatus.delivered, `${path}.itemStatus.delivered`),
      cancelled: unitEvents(itemStatus.cancelled, `${path}.itemStatus.cancelled`),
      returned: unitEvents(itemStatus.returned, `${path}.itemStatus.returned`),
    };
    // Returned units are known from the return events alone, so both files' returned counts must be exactly theirs.
    const returnedUnits = sum(events.returned.map((event) => event.quantity));
    for (const stated of [statedCount(line.totalReturnedQuantity, `${path}.totalReturnedQuantity`),
      statedCount(listed.totalReturnedQuantity, `lines[${index}].totalReturnedQuantity`)]) {
      if (stated !== null && stated !== returnedUnits) throw new Hold('returned-quantity');
    }
    return {
      ordinal: index,
      lineKey: retailLineKey('costco', orderNumber, id),
      kind: fee ? 'fee' : 'item',
      itemNumber: number.number,
      title: titleText.text,
      title2: null,
      department: null,
      quantity,
      unitPriceMinor,
      amountMinor,
      shippingMinor: lineShipping,
      taxFlag: null,
      couponTarget: null,
      feeParent: null,
      fulfilment: fulfilmentOf(optStr(line.orderedShipMethodDescription, `${path}.orderedShipMethodDescription`)),
      metal,
      metalUncertain,
      storedValue: shopCard === 'listed' ? 'costco-shop-card' : null,
      fuelGallons: null,
      fuelUnitPrice: null,
      events,
      shipments: shipmentsOf(line.shipment, `${path}.shipment`),
    } satisfies RetailImportLine;
  });
  // A fee line hangs off exactly one parent line of the same order.
  rawLines.forEach((line, index) => {
    if (lines[index].kind !== 'fee') return;
    const parent = optStr(line.parentOrderLineItemId, `${at}.lines[${index}].parentOrderLineItemId`);
    const parents = lines.filter((candidate, at2) => parent !== null && ids[at2] === parent && candidate.kind !== 'fee');
    if (parents.length !== 1) throw new Hold('fee-parent');
    lines[index].feeParent = parents[0].ordinal;
  });
  // The order's total is what the card paid: merchandise, shipping, tax and fees, less the discount and the wallet Shop Card.
  if (subtotalMinor + shippingMinor + taxMinor - discountMinor + feesMinor - walletMinor !== totalMinor || totalMinor < 0) {
    throw new Hold('order-total');
  }
  if (sum(lines.map((line) => line.amountMinor)) !== subtotalMinor) throw new Hold('lines-merchandise');
  if (sum(lines.map((line) => line.shippingMinor ?? 0)) !== shippingMinor) throw new Hold('lines-shipping');
  // An order charged nothing only when neither a card nor a Shop Card paid anything: it was cancelled.
  const chargedNothing = totalMinor === 0 && walletMinor === 0;
  // On an order that charged something, every line is its quantity × unit price (design §3.4).
  if (!chargedNothing && lines.some((line) => line.quantity! * line.unitPriceMinor! !== line.amountMinor)) {
    throw new Hold('line-quantity-price');
  }
  const cancelled = lines.some((line) => (line.events?.cancelled.length ?? 0) > 0);
  const tenders = onlineTenders(consolidated, details, { totalMinor, discountMinor, walletMinor, cancelled }, at);
  return {
    receipt: {
      channel: 'online',
      naturalKey: '',
      date: placed.date,
      localTime: placed.time,
      sign: 'sale',
      status,
      currency: 'USD',
      totals: { subtotalMinor, taxMinor, instantSavingsMinor: null, discountMinor, shippingMinor, feesMinor, storedValueMinor: walletMinor, totalMinor },
      taxLegends: [],
      lines,
      tenders,
    },
    facts,
  };
}

/**
 * An online order's tenders: its card payment (the order's total, when that isn't zero), its wallet Shop Card payments
 * (the wallet amount applied) and its coupons, the discount's own record (Shop Card design v1).
 * - A Shop Card payment is read only in the one shape known: type WALLET SHOP CARD; bucket ShopCard in both files, spelt
 *   the same (read as the type is, so `SHOPCARD` once normalized); the last four there and empty in both files (`''` or
 *   null, never missing; it is never a card ending, and nothing of it is kept); never a gift of membership (the flag
 *   false in both files, never missing); and an amount.
 * - An order that charged nothing (cancelled) has no tenders: its payment rows still show the original amounts, so they
 *   prove no charge. Its Shop Card payments must cancel exactly, and the order must show its cancellations.
 * - On an order that charged something, a Shop Card payment is never negative (a refund to the Shop Card inside a live
 *   order has never been seen) and they add up to the wallet amount applied.
 */
function onlineTenders(consolidated: Rec, details: Rec,
  order: { totalMinor: number; discountMinor: number; walletMinor: number; cancelled: boolean }, at: string): RetailImportTender[] {
  const { totalMinor, discountMinor, walletMinor } = order;
  const rows = arr(details.orderPayment, `${at}.orderPayment`);
  const listed = arr(consolidated.payments, 'payments');
  if (listed.length !== rows.length) throw new Hold('record-tenders');
  const read = rows.map((entry, index) => {
    const path = `${at}.orderPayment[${index}]`;
    const row = rec(entry, path);
    const spec = onlinePaymentSpec(str(row.paymentType, `${path}.paymentType`));
    if (spec === null) throw new Hold('payment-type');
    const shown = rec(listed[index], `payments[${index}]`);
    // Funding fields are read by type first: a flag that isn't a boolean, or a bucket that isn't empty, is never "none".
    const giftOfMembership = flag(row.isGOMPayment, `${path}.isGOMPayment`);
    const shownGiftStated = flag(shown.isGiftOfMembership, `payments[${index}].isGiftOfMembership`);
    const shownGift = shownGiftStated ?? false;
    const amountMinor = cents(row.totalCharged, `${path}.totalCharged`);
    if (spec.kind === 'shop-card') {
      if (!isShopCardBucket(row.storedValueBucket) || !isShopCardBucket(shown.storedValueBucket)
        || !statedEmpty(row, 'cardNumberLast4') || !statedEmpty(shown, 'last4') || giftOfMembership !== false || shownGiftStated !== false
        || amountMinor === 0) {
        throw new Hold('shop-card-row');
      }
    } else {
      if (giftOfMembership === true) throw new Hold('gift-of-membership-payment');
      if (namesStoredValue(row.storedValueBucket)) throw new Hold('stored-value-payment');
    }
    if (money(shown.charged, `payments[${index}].charged`) !== amountMinor || (shown.type ?? null) !== row.paymentType) {
      throw new Hold('record-tenders');
    }
    // Both files spell a Shop Card payment's bucket the same; any other payment's funding fields agree as R2 reads them.
    if (spec.kind === 'shop-card' && shown.storedValueBucket !== row.storedValueBucket) throw new Hold('record-tenders');
    if (spec.kind !== 'shop-card' && ((shown.last4 ?? null) !== (row.cardNumberLast4 ?? null)
      || shownGift !== (giftOfMembership ?? false) || namesStoredValue(shown.storedValueBucket))) {
      throw new Hold('record-tenders');
    }
    return { spec, amountMinor, last4: spec.kind === 'card' ? optStr(row.cardNumberLast4, `${path}.cardNumberLast4`) : null };
  });
  const shopCards = read.filter((row) => row.spec.kind === 'shop-card');
  const shopCardSum = sum(shopCards.map((row) => row.amountMinor));
  if (totalMinor === 0 && walletMinor === 0) {
    if (shopCards.length > 0 && (shopCardSum !== 0 || !order.cancelled)) throw new Hold('shop-card-cancel');
    return [];
  }
  if (shopCards.some((row) => row.amountMinor < 0)) throw new Hold('shop-card-live-refund');
  if (shopCardSum !== walletMinor) throw new Hold('shop-card-sum');
  const cards = read.filter((row) => row.spec.kind === 'card');
  const coupons = read.filter((row) => row.spec.kind === 'coupon');
  if (totalMinor > 0 ? cards.length !== 1 || cards[0].amountMinor !== totalMinor : cards.length !== 0) throw new Hold('card-payment');
  if (cards.some((card) => card.last4 === null || !/^[0-9]{4}$/.test(card.last4))) throw new Hold('tender-last4');
  if (coupons.some((coupon) => coupon.amountMinor <= 0)) throw new Hold('coupon-amount');
  if (coupons.length > 0 && sum(coupons.map((coupon) => coupon.amountMinor)) !== discountMinor) throw new Hold('coupons-discount');
  if (read.length > RETAIL_MAX_TENDERS) throw new Hold('tender-count');
  return [...cards, ...shopCards, ...coupons].map((row, ordinal) => ({
    ordinal,
    kind: row.spec.kind,
    network: row.spec.network,
    last4: row.spec.kind === 'card' ? row.last4 : null,
    amountMinor: row.amountMinor,
  }));
}

// ---------------------------------------------------------------------------
// The folder
// ---------------------------------------------------------------------------

const FOLDER = /^costco(?:-[1-9][0-9]{0,2})?$/;
const CAPTURED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function membershipOf(provenance: Rec, folder: string): RetailImportPayload['membership'] & { identity: 'stated' | 'none' } {
  if (!FOLDER.test(folder)) throw new RetailConvertError('folder-mismatch');
  if (provenance.accountFolder !== undefined && provenance.accountFolder !== folder) throw new RetailConvertError('folder-mismatch');
  const account = provenance.account;
  if (account === undefined || account === null) {
    return { folder, memberSinceYear: null, tier: null, membershipLast4: null, identity: 'none' };
  }
  if (!isRecord(account)) throw new RetailConvertError('capture-unreadable', '$.provenance.account');
  if (account.folder !== undefined && account.folder !== folder) throw new RetailConvertError('folder-mismatch');
  const year = typeof account.memberSinceYear === 'string' && /^(?:19|20)\d{2}$/.test(account.memberSinceYear) ? account.memberSinceYear : null;
  const tier = typeof account.tier === 'string' && /^[A-Za-z][A-Za-z +]{0,39}$/.test(account.tier.trim()) ? account.tier.trim() : null;
  const last4 = typeof account.membershipLast4 === 'string' && /^[0-9]{4}$/.test(account.membershipLast4) ? account.membershipLast4 : null;
  return { folder, memberSinceYear: year, tier, membershipLast4: last4, identity: 'stated' };
}

function rangesOf(value: unknown, at: string, stated: (range: Rec, at: string) => number | null): RetailCoverageRange[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new RetailConvertError('capture-unreadable', at);
  return value.map((entry, index) => {
    const path = `${at}[${index}]`;
    if (!isRecord(entry) || !isRetailDate(entry.start) || !isRetailDate(entry.end) || entry.start > entry.end
      || typeof entry.rowsSeen !== 'number' || !Number.isSafeInteger(entry.rowsSeen) || entry.rowsSeen < 0) {
      throw new RetailConvertError('capture-unreadable', path);
    }
    return { from: entry.start, to: entry.end, stated: stated(entry, path), seen: entry.rowsSeen };
  });
}

const statedOnline = (range: Rec, at: string): number | null => {
  if (range.statedTotal === null || range.statedTotal === undefined) return null;
  if (typeof range.statedTotal !== 'number' || !Number.isSafeInteger(range.statedTotal) || range.statedTotal < 0) {
    throw new RetailConvertError('capture-unreadable', `${at}.statedTotal`);
  }
  return range.statedTotal;
};

const statedWarehouse = (range: Rec, at: string): number | null => {
  if (!isRecord(range.counts)) return null;
  const counts = Object.values(range.counts);
  if (counts.some((count) => typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)) {
    throw new RetailConvertError('capture-unreadable', `${at}.counts`);
  }
  return sum(counts as number[]);
};

/** A converted or held record, before duplicates are settled; `date` is its date when both files agree on it. */
type Outcome = { channel: RetailChannel; key: string | null; date: string | null }
  & ({ receipt: RetailImportReceipt; facts: LineFacts } | { hold: RetailHoldCheck });

function outcomeOf(channel: RetailChannel, key: string | null, date: string | null, convert: () => Converted): Outcome {
  try {
    const { receipt, facts } = convert();
    return { channel, key, date, receipt: { ...receipt, naturalKey: key! }, facts };
  } catch (error) {
    if (error instanceof Hold) return { channel, key, date, hold: error.check };
    if (error instanceof Unreadable) return { channel, key, date, hold: 'record-shape' };
    throw error;
  }
}

/**
 * A record's date as a held record keeps it (Root's ruling, 11/08): the consolidated file's date, only when it reads and
 * every raw response for the record reads the same date in each of its date fields; otherwise null. It never decides a
 * hold: a record whose dates disagree is held by its own check (`record-date`), as before.
 */
function agreedDate(listedDate: unknown, raws: readonly unknown[] | undefined, rawDates: (raw: unknown) => string[]): string | null {
  if (!isRetailDate(listedDate) || raws === undefined || raws.length === 0) return null;
  for (const raw of raws) {
    let dates: string[];
    try {
      dates = rawDates(raw);
    } catch (error) {
      if (error instanceof Unreadable) return null;
      throw error;
    }
    if (dates.some((date) => date !== listedDate)) return null;
  }
  return listedDate;
}

/** An online order's raw date: the placed date. */
const orderRawDates = (raw: unknown) => [stamp(rawDetailsOf(raw, 'raw').orderPlacedDate, 'raw.orderPlacedDate').date];
/** A warehouse or fuel receipt's raw dates: the transaction date, as both of its fields state it. */
const receiptRawDates = (raw: unknown) => {
  const receipt = rawReceiptOf(raw, 'raw');
  return [stamp(receipt.transactionDateTime, 'raw.transactionDateTime').date, stamp(receipt.transactionDate, 'raw.transactionDate').date];
};

/** Raw responses by their native id; a raw record whose id can't be read is counted, never matched. */
function indexRaw(records: readonly unknown[], idOf: (raw: unknown) => string): { byId: Map<string, unknown[]>; unreadable: number } {
  const byId = new Map<string, unknown[]>();
  let unreadable = 0;
  for (const raw of records) {
    let id: string;
    try {
      id = idOf(raw);
    } catch (error) {
      if (error instanceof Unreadable) {
        unreadable += 1;
        continue;
      }
      throw error;
    }
    byId.set(id, [...(byId.get(id) ?? []), raw]);
  }
  return { byId, unreadable };
}

/** The one raw record of an id: none is `raw-missing`; several that differ disagree (`raw-repeats`). */
function oneRaw(byId: Map<string, unknown[]>, id: string, used: Set<string>): Rec {
  const found = byId.get(id);
  if (!found || found.length === 0) throw new Hold('raw-missing');
  used.add(id);
  const first = JSON.stringify(found[0]);
  if (found.some((raw) => JSON.stringify(raw) !== first)) throw new Hold('raw-repeats');
  return rec(found[0], 'raw');
}

/**
 * Converts one membership folder's capture. A malformed folder is refused (RetailConvertError); a record that doesn't
 * hold is held with its reason; everything kept is checked once more by the payload validator before it is returned.
 */
export function convertCostcoCapture(input: CostcoCaptureInput): CostcoConvertResult {
  if (!isRecord(input.consolidated)) throw new RetailConvertError('capture-unreadable', '$');
  const root = input.consolidated;
  if (root.schema !== COSTCO_CAPTURE_SCHEMA) throw new RetailConvertError('schema-unsupported');
  if (!isRecord(root.provenance)) throw new RetailConvertError('capture-unreadable', '$.provenance');
  const provenance = root.provenance;
  if (provenance.currency !== 'USD') throw new RetailConvertError('currency-unsupported');
  if (typeof provenance.capturedAt !== 'string' || !CAPTURED_AT.test(provenance.capturedAt)) {
    throw new RetailConvertError('capture-unreadable', '$.provenance.capturedAt');
  }
  if (!/^[a-p]{64}$/.test(input.consolidatedDigest)) throw new RetailConvertError('capture-unreadable', 'digest');
  const { identity, ...membership } = membershipOf(provenance, input.folder);
  const online = isRecord(provenance.online) ? provenance.online : {};
  const warehouse = isRecord(provenance.warehouse) ? provenance.warehouse : {};
  const coverage = {
    online: rangesOf(online.ranges, '$.provenance.online.ranges', statedOnline),
    warehouse: rangesOf(warehouse.ranges, '$.provenance.warehouse.ranges', statedWarehouse),
  };
  // Schema @1 requires both collections. An empty one is kept as stated; a missing or malformed one refuses the folder.
  if (!Array.isArray(root.onlineOrders)) throw new RetailConvertError('capture-unreadable', '$.onlineOrders');
  if (!Array.isArray(root.warehouseReceipts)) throw new RetailConvertError('capture-unreadable', '$.warehouseReceipts');
  const orders: unknown[] = root.onlineOrders;
  const receipts: unknown[] = root.warehouseReceipts;
  if (orders.length + receipts.length > RETAIL_MAX_RECEIPTS) throw new RetailConvertError('too-many-records');

  const report = emptyReport(input.folder, input.files, identity);
  const rawReceipts = indexRaw(input.rawReceipts, (raw) => str(rawReceiptOf(raw, 'raw').transactionBarcode, 'raw.transactionBarcode'));
  const rawDetails = indexRaw(input.rawDetails, (raw) => str(rawDetailsOf(raw, 'raw').orderNumber, 'raw.orderNumber'));
  const usedReceipts = new Set<string>();
  const usedDetails = new Set<string>();
  const outcomes: Outcome[] = [];

  receipts.forEach((entry, index) => {
    const listed = isRecord(entry) ? entry : null;
    const barcode = listed !== null && typeof listed.barcode === 'string' && /^[0-9]{10,30}$/.test(listed.barcode) ? listed.barcode : null;
    const channel: RetailChannel = listed?.receiptType === 'Gas Station' ? 'gas' : 'warehouse';
    if (listed === null || barcode === null) {
      outcomes.push({ channel, key: null, date: null, hold: 'record-key' });
      return;
    }
    const key = retailNaturalKey('costco', 'receipt', barcode);
    const date = agreedDate(listed.date, rawReceipts.byId.get(barcode), receiptRawDates);
    outcomes.push(outcomeOf(channel, key, date, () => {
      const converted = warehouseReceipt(listed, oneRaw(rawReceipts.byId, barcode, usedReceipts), `receipt[${index}]`);
      return converted;
    }));
  });
  orders.forEach((entry, index) => {
    const listed = isRecord(entry) ? entry : null;
    const number = listed !== null && typeof listed.orderNumber === 'string' && /^[0-9]{6,20}$/.test(listed.orderNumber) ? listed.orderNumber : null;
    if (listed === null || number === null) {
      outcomes.push({ channel: 'online', key: null, date: null, hold: 'record-key' });
      return;
    }
    const key = retailNaturalKey('costco', 'order', number);
    const date = agreedDate(listed.orderDate, rawDetails.byId.get(number), orderRawDates);
    outcomes.push(outcomeOf('online', key, date, () => onlineOrder(listed, oneRaw(rawDetails.byId, number, usedDetails), number, `order[${index}]`)));
  });

  // One record per natural key: identical repeats are one record; repeats that differ hold every one of them.
  const byKey = new Map<string, Outcome[]>();
  const kept: Array<{ receipt: RetailImportReceipt; facts: LineFacts }> = [];
  const heldOf = (channel: RetailChannel, naturalKey: string | null, check: RetailHoldCheck, date: string | null): RetailHeldRecord => ({
    channel, naturalKey, reason: RETAIL_HOLD_CHECKS[check], check, date,
  });
  const held = new Map<string, RetailHeldRecord>();
  const heldUnkeyed: RetailHeldRecord[] = [];
  for (const outcome of outcomes) {
    report.receipts.read += 1;
    if (outcome.key === null) {
      heldUnkeyed.push(heldOf(outcome.channel, null, 'record-key', null));
      continue;
    }
    byKey.set(outcome.key, [...(byKey.get(outcome.key) ?? []), outcome]);
  }
  for (const [key, group] of byKey) {
    const first = group[0];
    // Repeats keep a date only when every one of them has the same.
    const date = group.every((outcome) => outcome.date === first.date) ? first.date : null;
    if (group.length > 1) {
      const texts = group.map((outcome) => ('receipt' in outcome ? JSON.stringify(outcome.receipt) : `hold:${outcome.hold}`));
      if (texts.every((text) => text === texts[0])) report.duplicates.identical += group.length - 1;
      else {
        held.set(key, heldOf(first.channel, key, 'duplicate', date));
        continue;
      }
    }
    if ('receipt' in first) kept.push({ receipt: first.receipt, facts: first.facts });
    else held.set(key, heldOf(first.channel, key, first.hold, date));
  }
  report.rawUnlisted.receipts = [...rawReceipts.byId.keys()].filter((id) => !usedReceipts.has(id)).length + rawReceipts.unreadable;
  report.rawUnlisted.details = [...rawDetails.byId.keys()].filter((id) => !usedDetails.has(id)).length + rawDetails.unreadable;
  // A raw response no record lists is evidence the consolidated file left out: it is held, by its own key when readable.
  for (const [id, found] of rawReceipts.byId) {
    if (usedReceipts.has(id)) continue;
    report.receipts.read += 1;
    const key = retailNaturalKey('costco', 'receipt', id);
    held.set(key, heldOf(rawReceiptTypeOf(found[0]) === 'Gas Station' ? 'gas' : 'warehouse', key, 'raw-unlisted', null));
  }
  for (const id of rawDetails.byId.keys()) {
    if (usedDetails.has(id)) continue;
    report.receipts.read += 1;
    const key = retailNaturalKey('costco', 'order', id);
    held.set(key, heldOf('online', key, 'raw-unlisted', null));
  }
  for (const [count, channel] of [[rawReceipts.unreadable, 'warehouse'], [rawDetails.unreadable, 'online']] as const) {
    for (let index = 0; index < count; index += 1) {
      report.receipts.read += 1;
      heldUnkeyed.push(heldOf(channel, null, 'record-key', null));
    }
  }

  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  kept.sort((a, b) => order(a.receipt.date, b.receipt.date) || order(a.receipt.channel, b.receipt.channel)
    || order(a.receipt.naturalKey, b.receipt.naturalKey));
  const heldList = [...held.values(), ...heldUnkeyed]
    .sort((a, b) => order(a.channel, b.channel) || order(a.reason, b.reason) || order(a.check, b.check)
      || order(a.naturalKey ?? '', b.naturalKey ?? ''));

  for (const { receipt, facts } of kept) {
    report.receipts.accepted += 1;
    report.receipts.byChannel[receipt.channel] += 1;
    report.receipts.bySign[receipt.sign] += 1;
    if (receipt.channel === 'online') {
      report.online.orders += 1;
      report.online.byStatus[receipt.status!] += 1;
      // Live: the card or the wallet Shop Card paid something (design v1 §3: a Shop-Card-only order is no zero total).
      if (receipt.totals.totalMinor + (receipt.totals.storedValueMinor ?? 0) > 0) report.online.live += 1;
      else report.online.zeroTotal += 1;
      if (receipt.tenders.some((tender) => tender.kind === 'coupon')) report.online.withCoupons += 1;
    }
    for (const line of receipt.lines) {
      report.lines.byKind[line.kind] += 1;
      if (line.metal !== null) {
        report.metal.lines += 1;
        if (line.metal.statedWeight !== null) report.metal.withWeight += 1;
        report.metal.byForm[line.metal.form ?? 'none'] += 1;
        report.metal.byPack[line.metal.pack] += 1;
      }
    }
    for (const tender of receipt.tenders) report.tenders.byKind[tender.kind] += 1;
    report.lines.titlesHeld += facts.titlesHeld;
    report.lines.itemNumbersHeld += facts.itemNumbersHeld;
    report.lines.withoutMoney += facts.withoutMoney;
    report.coupons.resolved += facts.couponsResolved;
    report.coupons.unresolved += facts.couponsUnresolved;
    report.metal.pullFlagOnly += facts.pullFlagOnly;
    report.metal.ruleOnly += facts.ruleOnly;
    for (const reason of RETAIL_METAL_PACK_REASONS) report.metal.byPackReason[reason] += facts.packReasons[reason];
    const guard = report.metal.guard;
    for (const key of ['metalWordLines', 'metal', 'uncertain', 'adjacencyOnly', 'withoutEvidence', 'silentOmissions'] as const) guard[key] += facts.guard[key];
    for (const clause of RETAIL_METAL_GUARD_CLAUSES) guard.byClause[clause] += facts.guard.byClause[clause];
    if (report.dates.first === null || receipt.date < report.dates.first) report.dates.first = receipt.date;
    if (report.dates.last === null || receipt.date > report.dates.last) report.dates.last = receipt.date;
  }
  for (const entry of heldList) {
    report.receipts.held += 1;
    if (entry.date !== null) report.receipts.heldWithDate += 1;
    report.receipts.heldByReason[entry.reason] += 1;
    report.receipts.heldByCheck[entry.check] += 1;
  }
  report.coverage = {
    online: coverage.online.map((range) => ({ from: range.from, to: range.to, complete: range.stated === null ? null : range.seen >= range.stated })),
    warehouse: coverage.warehouse.map((range) => ({ from: range.from, to: range.to, complete: range.stated === null ? null : range.seen >= range.stated })),
  };

  const payload: RetailImportPayload = {
    format: RETAIL_IMPORT_FORMAT,
    version: RETAIL_IMPORT_VERSION,
    merchant: 'costco',
    converterVersion: RETAIL_CONVERTER,
    policyVersion: RETAIL_CONVERT_POLICY_VERSION,
    source: { schema: COSTCO_CAPTURE_SCHEMA, captureDigest: input.consolidatedDigest, capturedAt: provenance.capturedAt, files: input.files },
    membership,
    coverage,
    receipts: kept.map((entry) => entry.receipt),
    held: heldList,
  };
  const checked = validateRetailImportPayload(payload);
  if (!checked.ok) throw new RetailConvertError('converter-invalid', checked.issues[0]?.path);
  return { payload, json: serializeRetailImportPayload(payload), report };
}
