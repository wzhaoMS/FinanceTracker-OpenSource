/**
 * The metals import payload, `holdr.metals-import` v1 (design v8 §5.1): one source account's precious-metal orders
 * (lots and sales), the card funding of its other orders (competitors), and its held records, as an offline converter
 * (`holdr-metals-convert`) writes them for a Root-GO'd import. Owner-only: it holds dates, amounts, titles and typed
 * last 4s, never a name, an address or a native order, line or account number (keys are one-way letter hex).
 *
 * Trust boundary. Facts read from a raw capture are pinned raw-derived observations, admitted under the rules the
 * payload names: `pack` (every source), `purity`, `massBasis` and `design` (Walmart and CollectPure; null for Costco),
 * and the title guard's `metalUncertain` flag (Walmart and CollectPure; Costco from retail policy 5). The validator
 * checks them by value, never by re-reading a stored title, which may be cut, with two exceptions, each one-directional
 * so that a cut can only over-refuse: a stored title that visibly shows a pack marker can't be `single`, and a line
 * stored unflagged can't have a stored title that the pinned title guard reads as metal-uncertain. So it proves each is
 * a LEGAL observation, never that the raw capture was read completely: evidence beyond the 240-character stored title,
 * or a row the converter omitted, is invisible to it. That stays the trusted converter's obligation, shown by its
 * census counts and its "0 silent omissions". The validator recomputes everything else whose inputs the payload holds:
 * fine content and the content fingerprint, every allocation and money identity, evidence admission, every competitor's
 * basis, cap and interval, and coverage completeness. A derived value that disagrees refuses the file.
 *
 * Pure: no file system, network or clock.
 */

import { containsCardData } from '../cardNumbers.js';
import { cardImportTextProblem } from '../cardImport.js';
import { sha256, toLetterHex } from '../cardDedupe.js';
import { retailMetalPack } from '../retailImportTool/metalPackRule.js';
import { retailMetalTitleGuard } from '../retailImportTool/metalTitleRule.js';
import { metalsAdmission, metalsSettlementInterval } from './admission.js';
import { metalsAllocation, metalsSkeletonProblem } from './allocation.js';
import { metalsContentFingerprint, metalsFineContent, metalsFineContentWire, type MetalsContentEvidence } from './contentRule.js';
import {
  METAL_FORMS,
  METAL_MASS_UNITS,
  METAL_PACKS,
  METALS,
  METALS_BUY_EVENT_KINDS,
  METALS_CAPTURE_SCHEMAS,
  METALS_CHANNELS,
  METALS_COIN_DESIGNS,
  METALS_COMPONENT_KINDS,
  METALS_CONVERT_POLICY_VERSION,
  METALS_CONVERTER,
  METALS_DATE_BASES,
  METALS_EVENT_KINDS,
  METALS_GUARD_EVIDENCE,
  METALS_HOLD_REASONS,
  METALS_IMPORT_FORMAT,
  METALS_IMPORT_VERSION,
  METALS_INSPECTIONS,
  METALS_MASS_BASES,
  METALS_NETWORKS,
  METALS_PAYOUT_STATUSES,
  METALS_PREMIUM_BASES,
  METALS_RULES,
  METALS_SELL_EVENT_KINDS,
  METALS_SELL_STATUSES,
  METALS_SIDES,
  METALS_SKELETON_KINDS,
  METALS_SOURCES,
  METALS_TAX_FLAGS,
  METALS_TENDER_KINDS,
  METALS_CARD_TENDER_KINDS,
  METALS_TITLE_GUARD,
  type Metal,
  type MetalForm,
  type MetalPack,
  type MetalsAdmissionFacts,
  type MetalsAllocatedShare,
  type MetalsCardEvidence,
  type MetalsChannel,
  type MetalsCoinDesign,
  type MetalsCompetitorBasis,
  type MetalsCoverageKind,
  type MetalsEvent,
  type MetalsFineContent,
  type MetalsHoldReason,
  type MetalsInspection,
  type MetalsLineMetalUncertain,
  type MetalsMassBasis,
  type MetalsOrderComponent,
  type MetalsPayoutStatus,
  type MetalsPremiumBasis,
  type MetalsPurity,
  type MetalsRules,
  type MetalsSellStatus,
  type MetalsSide,
  type MetalsSkeletonLine,
  type MetalsSource,
  type MetalsStatedMass,
  type MetalsTender,
} from './model.js';
import { parseRational } from './rational.js';
import { METALS_PURITY_FORMS } from './observations.js';

export const METALS_TITLE_MAX = 240;
export const METALS_MAX_ORDERS = 20_000;
export const METALS_MAX_LINES = 500;
export const METALS_MAX_EVENTS = 50;
export const METALS_MAX_METHODS = 10;
export const METALS_MAX_PAYOUTS = 20;
export const METALS_MAX_COMPONENTS = 10;
export const METALS_MAX_REFUNDS = 20;
/** No single amount in a payload is larger than this many minor units (a hundred million dollars). */
export const METALS_MAX_MINOR = 10_000_000_000;
/** A Walmart marketplace seller's business name is kept only within this length (ROOT's Q6 ruling). */
export const METALS_SELLER_NAME_MAX = 60;
/**
 * A product ref is `<source>:<catalog id>`, and the catalog id holds 1 to this many characters of `[A-Za-z0-9_-]`
 * (ROOT, contract follow-up 1: real catalog ids run past 40). It never holds a run of 13 or more digits.
 */
export const METALS_PRODUCT_REF_MAX = 80;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MetalsSaleDetail {
  /** The dealer's program name, as short guarded text. */
  program: string | null;
  /** The dealer's stated spot premium as written, with its basis. */
  premium: { text: string; basis: MetalsPremiumBasis } | null;
  inspection: MetalsInspection | null;
}

/** A metal line: a lot (a buy) or a disposition (a sale). */
export interface MetalsLine {
  key: string;
  /** The skeleton line it is. */
  ordinal: number;
  title: string | null;
  /** `<source>:<catalog id>`, a public product id, or null. */
  productRef: string | null;
  metal: Metal | null;
  /**
   * The title guard's flag on a line whose title reads as no metal but names one with bullion evidence (retail format
   * 3's shape), or null. A flagged line is held `bullion-unconfirmed`, and its order carries no card evidence; the read
   * side's "held for metals" predicate is what quarantines the order until the owner decides.
   */
  metalUncertain: MetalsLineMetalUncertain | null;
  form: MetalForm | null;
  statedMass: MetalsStatedMass | null;
  pack: MetalPack;
  purity: MetalsPurity | null;
  massBasis: MetalsMassBasis | null;
  design: MetalsCoinDesign | null;
  contentFingerprint: string;
  fine: MetalsFineContent;
  quantity: number;
  unitPriceMinor: number | null;
  amountMinor: number;
  directMinor: number;
  allocated: MetalsAllocatedShare[];
  /** A buy line's cost (null on a sale). */
  costMinor: number | null;
  /** A sale line's net proceeds (null on a buy). */
  netMinor: number | null;
  /** False when an unattributed order component could have reached the line (`cost-unattributed`). */
  complete: boolean;
  events: MetalsEvent[];
  /** Walmart: the marketplace seller's guarded business name, or `seller-<hash8>`; null elsewhere. */
  seller: string | null;
  sale: MetalsSaleDetail | null;
}

export interface MetalsPayout {
  key: string;
  method: 'ach';
  destinationLast4: string | null;
  amountMinor: number;
  initiatedDate: string | null;
  payoutDate: string | null;
  status: MetalsPayoutStatus;
}

export interface MetalsOrder {
  key: string;
  side: MetalsSide;
  channel: MetalsChannel;
  /** A buy's order date, or a sale's agreed day (its trade moment's New York date). */
  date: string;
  /** A sale's trade moment, a UTC instant; null on a buy. */
  tradeMoment: string | null;
  completedDate: string | null;
  currency: 'USD';
  /** A sale's lifecycle; null on a buy, whose lifecycle is its lines' events. */
  status: MetalsSellStatus | null;
  skeleton: MetalsSkeletonLine[];
  components: MetalsOrderComponent[];
  /** A buy's funding facts (its tenders are `admission.methods`); null on a sale. */
  admission: MetalsAdmissionFacts | null;
  evidence: MetalsCardEvidence[];
  /** Refunds the source shows, negative; shown, never linked. */
  refunds: Array<{ amountMinor: number; date: string | null }>;
  payouts: MetalsPayout[];
  unattributedMinor: number;
  fullPriceMinor: number;
  lines: MetalsLine[];
}

/** The card funding of a captured order that is not in `orders` (it has no metal line). */
export interface MetalsCompetitor {
  orderKey: string;
  channel: MetalsChannel;
  date: string;
  interval: { from: string; to: string };
  admission: MetalsAdmissionFacts;
  basis: MetalsCompetitorBasis;
  capMinor: number | null;
}

export interface MetalsHeldRecord {
  /** The held order's or receipt's key; null only when the record's own number can't be read. */
  key: string | null;
  channel: MetalsChannel;
  date: string | null;
  reason: MetalsHoldReason;
  /** The check that held it, a closed code; never a value. */
  check: string;
}

export interface MetalsCoverage {
  kind: MetalsCoverageKind;
  from: string;
  to: string;
  stated: number | null;
  seen: number;
  /** stated is known and equals seen. */
  complete: boolean;
}

export interface MetalsCaptureInput {
  schema: string;
  /** SHA-256 of the consolidated capture file, in letter hex. */
  captureDigest: string;
  capturedAt: string;
  files: number;
}

/**
 * The retail payloads the Costco adapter reads: each format (the retail payload's `version`) with the one retail policy
 * that writes it. The list holds only format 3, written by retail policy 5 (title rule v3, the title guard and pack v2),
 * whose lines may carry the guard's flag. An earlier format's lines were read under title rule v2 and pack v1, which a
 * payload naming these rules can't carry, so its whole input is refused. Storage generates its checks from these lists.
 */
export const METALS_RETAIL_INPUTS = [{ format: 3, policy: 5 }] as const;
export type MetalsRetailFormat = (typeof METALS_RETAIL_INPUTS)[number]['format'];
export type MetalsRetailPolicy = (typeof METALS_RETAIL_INPUTS)[number]['policy'];
export const METALS_RETAIL_FORMATS: readonly MetalsRetailFormat[] = METALS_RETAIL_INPUTS.map((input) => input.format);
export const METALS_RETAIL_POLICIES: readonly MetalsRetailPolicy[] = METALS_RETAIL_INPUTS.map((input) => input.policy);

export interface MetalsRetailInput {
  /** SHA-256 of the retail payload file the Costco adapter read, in letter hex. */
  retailPayloadSha256: string;
  /** The retail payload's format (its `version`), with the retail policy that writes it (METALS_RETAIL_INPUTS). */
  retailFormat: MetalsRetailFormat;
  retailPolicyVersion: MetalsRetailPolicy;
}

export interface MetalsImportPayload {
  format: typeof METALS_IMPORT_FORMAT;
  version: typeof METALS_IMPORT_VERSION;
  source: MetalsSource;
  account: { folder: string; identityLast4: string | null };
  converterVersion: string;
  policyVersion: typeof METALS_CONVERT_POLICY_VERSION;
  rules: MetalsRules;
  input: MetalsCaptureInput | MetalsRetailInput;
  coverage: MetalsCoverage[];
  orders: MetalsOrder[];
  competitors: MetalsCompetitor[];
  held: MetalsHeldRecord[];
}

// ---------------------------------------------------------------------------
// Keys and serialization
// ---------------------------------------------------------------------------

const KEY_TAG = 'holdr.metals-natural-key';
const encoder = new TextEncoder();
const digestOf = (parts: readonly string[]) => toLetterHex(sha256(encoder.encode([KEY_TAG, ...parts].join('\u0000'))));

/** The record kinds a source's keys name; Costco's order, receipt and online line keys are the retail payload's own. */
export const METALS_KEY_KINDS = {
  costco: ['order', 'receipt', 'line', 'wline'],
  walmart: ['order', 'line'],
  collectpure: ['sell', 'sline', 'payout'],
} as const;

/**
 * A one-way, source-scoped key from native ids (never stored themselves): `walmart-order-…`, `collectpure-sline-…`, or
 * a Costco warehouse line's `costco-wline-…` from its receipt key and ordinal.
 */
export function metalsNaturalKey<S extends MetalsSource>(source: S, kind: (typeof METALS_KEY_KINDS)[S][number], parts: readonly string[]): string {
  return `${source}-${kind}-${digestOf([source, kind, ...parts])}`;
}

/** SHA-256 of bytes, in letter hex (no digits). */
export function metalsDigest(bytes: Uint8Array): string {
  return toLetterHex(sha256(bytes));
}

const NEW_YORK_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

/** A UTC instant's calendar date in New York, daylight time included: a sale's agreed day (design v8 §5.4). */
export function metalsNewYorkDate(instant: string): string {
  const parts = Object.fromEntries(NEW_YORK_DAY.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') {
    // A null-prototype object, so an own `__proto__` key stays data: assigning it into `{}` would call the prototype
    // setter and drop it from the canonical text and from every canonical comparison.
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = sorted((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** Canonical JSON text: keys sorted at every level, arrays in order, two-space indents, one final newline. */
export function serializeMetalsImportPayload(payload: MetalsImportPayload): string {
  return `${JSON.stringify(sorted(payload), null, 2)}\n`;
}

/**
 * Whether a Walmart marketplace seller's business name may be kept as written (ROOT's Q6 ruling): printable ASCII
 * within the length cap, passing the card-data guard, with no run of four or more digits, no seven digits in all, no
 * `@`, and no web address. Otherwise the converter keeps `seller-<hash8>`.
 */
export function metalsSellerNameProblem(name: string): string | null {
  if (!/^[\x20-\x7E]+$/.test(name) || name.trim() !== name || name.length > METALS_SELLER_NAME_MAX) return 'not short printable text';
  if (cardImportTextProblem(name, METALS_SELLER_NAME_MAX) !== null || containsCardData(name)) return 'card data';
  if (/\d{4}/.test(name) || (name.match(/\d/g) ?? []).length >= 7) return 'digits';
  if (name.includes('@')) return 'an @';
  if (/https?:|www\.|\.(?:com|net|org|co|io|us|biz|info|shop|store)\b/i.test(name)) return 'a web address';
  return null;
}

/** The seller key a converter keeps instead of a name that fails the guard: eight letter-hex characters. */
export function metalsSellerKey(name: string): string {
  return `seller-${digestOf(['seller', name]).slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface MetalsPayloadIssue {
  path: string;
  message: string;
}
export type MetalsPayloadValidation = { ok: true; payload: MetalsImportPayload } | { ok: false; issues: MetalsPayloadIssue[] };

class Invalid extends Error {
  constructor(readonly path: string, readonly reason: string) {
    super(reason);
  }
}

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);

function record(value: unknown, path: string, keys: readonly string[]): Rec {
  if (!isRecord(value)) throw new Invalid(path, 'must be an object');
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Invalid(path, 'has an unknown key');
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

function exact(value: unknown, path: string, expected: string | number | boolean | null): void {
  if (value !== expected) throw new Invalid(path, 'is not the expected value');
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

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Invalid(path, 'must be true or false');
  return value;
}

const minor = (value: unknown, path: string) => integer(value, path, -METALS_MAX_MINOR, METALS_MAX_MINOR);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function date(value: unknown, path: string): string {
  if (typeof value !== 'string' || !DATE.test(value)) throw new Invalid(path, 'must be a real YYYY-MM-DD date');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Invalid(path, 'must be a real YYYY-MM-DD date');
  return value;
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
function instant(value: unknown, path: string): string {
  const text = pattern(value, path, INSTANT);
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) throw new Invalid(path, 'must be a real UTC instant');
  date(text.slice(0, 10), path);
  // Canonical: "T24:00:00Z" or a rolled-over field names another day's instant, so it must not pass as this one.
  if (new Date(parsed).toISOString().slice(0, 19) !== text.slice(0, 19)) throw new Invalid(path, 'must be a real UTC instant');
  return text;
}

const LETTER_HEX = /^[a-p]{64}$/;
const keyPattern = (source: MetalsSource, kind: string) => new RegExp(`^${source}-${kind}-[a-p]{64}$`);
const WEIGHT_VALUE = /^(?:[1-9]\d{0,4}(?:\.\d{1,4})?|0\.\d{0,3}[1-9]|[1-9]\d{0,3}\/[1-9]\d{0,3}|(?:[1-9]\d{0,4} )?(?:1\/2|1\/4|3\/4|1\/10))$/;
const CHECK = /^[a-z][a-z0-9-]{0,47}$/;
const COMPONENT_ID = /^(?:tax|shipping|discount|platform-fee|insured-shipping|fee@\d{1,3}|coupon@\d{1,3})$/;
const SELLER_KEY = /^seller-[a-p]{8}$/;
const SHORT_TEXT = /^[\x20-\x7E]{1,60}$/;

/** Canonical equality: the two values serialize to the same canonical JSON. */
const same = (a: unknown, b: unknown) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

function guardedText(value: unknown, path: string): string {
  const text = pattern(value, path, SHORT_TEXT);
  if (containsCardData(text) || /\d{5}/.test(text) || text.includes('@') || cardImportTextProblem(text, 60) !== null) {
    throw new Invalid(path, 'must be short text with no card data, long digit runs or addresses');
  }
  return text;
}

function orderKind(source: MetalsSource, channel: MetalsChannel): string {
  if (source === 'collectpure') return 'sell';
  return source === 'costco' && channel === 'warehouse' ? 'receipt' : 'order';
}

function lineKind(source: MetalsSource, channel: MetalsChannel): string {
  if (source === 'collectpure') return 'sline';
  return source === 'costco' && channel === 'warehouse' ? 'wline' : 'line';
}

const sideOf = (source: MetalsSource): MetalsSide => (source === 'collectpure' ? 'sell' : 'buy');
const channelsOf = (source: MetalsSource): readonly MetalsChannel[] => (source === 'costco' ? METALS_CHANNELS : ['online']);
const coverageKindsOf = (source: MetalsSource): readonly MetalsCoverageKind[] =>
  source === 'costco' ? ['online', 'warehouse'] : source === 'walmart' ? ['online'] : ['sell-orders', 'payouts'];

function checkTender(value: unknown, path: string): MetalsTender {
  const tender = record(value, path, ['kind', 'network', 'last4', 'amountMinor']);
  const kind = oneOf(tender.kind, `${path}.kind`, METALS_TENDER_KINDS);
  const network = oneOf(tender.network, `${path}.network`, METALS_NETWORKS);
  if (METALS_CARD_TENDER_KINDS.includes(kind)) nullable(tender.last4, (v) => pattern(v, `${path}.last4`, /^[0-9]{4}$/));
  else {
    exact(tender.last4, `${path}.last4`, null);
    if (network !== 'unknown') throw new Invalid(`${path}.network`, 'must be unknown for a tender that is not a card');
  }
  // What a method paid is never negative; a card refund is always negative. Anything else contradicts the funding, and
  // the converter holds the order (a held record bars every amount).
  nullable(tender.amountMinor, (v) => (kind === 'card-refund'
    ? integer(v, `${path}.amountMinor`, -METALS_MAX_MINOR, -1)
    : integer(v, `${path}.amountMinor`, 0, METALS_MAX_MINOR)));
  return tender as unknown as MetalsTender;
}

function checkAdmission(value: unknown, path: string, channel: MetalsChannel): MetalsAdmissionFacts {
  const facts = record(value, path, ['fulfilment', 'methods', 'refunded', 'cancelled', 'partlyCancelled', 'grossTotalMinor']);
  if (channel === 'warehouse') exact(facts.fulfilment, `${path}.fulfilment`, 'in-store');
  else {
    const fulfilment = record(facts.fulfilment, `${path}.fulfilment`, ['shipments']);
    nullable(fulfilment.shipments, (v) => integer(v, `${path}.fulfilment.shipments`, 0, 1000));
  }
  list(facts.methods, `${path}.methods`, METALS_MAX_METHODS).forEach((method, index) => checkTender(method, `${path}.methods[${index}]`));
  for (const flag of ['refunded', 'cancelled', 'partlyCancelled'] as const) bool(facts[flag], `${path}.${flag}`);
  // A full price before refunds is never negative; a credit is no order's funding.
  nullable(facts.grossTotalMinor, (v) => integer(v, `${path}.grossTotalMinor`, 0, METALS_MAX_MINOR));
  return facts as unknown as MetalsAdmissionFacts;
}

function checkSkeleton(value: unknown, path: string): MetalsSkeletonLine[] {
  const skeleton = list(value, path, METALS_MAX_LINES).map((entry, index) => {
    const at = `${path}[${index}]`;
    const line = record(entry, at, ['ordinal', 'kind', 'amountMinor', 'shippingMinor', 'feeParent', 'couponTarget', 'taxFlag', 'metal']);
    exact(line.ordinal, `${at}.ordinal`, index);
    const kind = oneOf(line.kind, `${at}.kind`, METALS_SKELETON_KINDS);
    const amount = minor(line.amountMinor, `${at}.amountMinor`);
    // A metal item's own amount is a price paid or proceeds received: never negative (its coupons are lines of their own).
    if (kind === 'item' && line.metal === true && amount < 0) throw new Invalid(`${at}.amountMinor`, 'must not be negative on a metal item');
    nullable(line.shippingMinor, (v) => integer(v, `${at}.shippingMinor`, 0, METALS_MAX_MINOR));
    nullable(line.feeParent, (v) => integer(v, `${at}.feeParent`, 0, METALS_MAX_LINES - 1));
    nullable(line.couponTarget, (v) => integer(v, `${at}.couponTarget`, 0, METALS_MAX_LINES - 1));
    nullable(line.taxFlag, (v) => oneOf(v, `${at}.taxFlag`, METALS_TAX_FLAGS));
    bool(line.metal, `${at}.metal`);
    return line as unknown as MetalsSkeletonLine;
  });
  const problem = metalsSkeletonProblem(skeleton);
  if (problem !== null) throw new Invalid(path, problem);
  return skeleton;
}

const COMPONENT_SIGNS: Readonly<Record<string, 1 | -1>> = { tax: 1, shipping: 1, discount: -1, 'platform-fee': -1, 'insured-shipping': -1 };

function checkComponents(value: unknown, path: string, side: MetalsSide): MetalsOrderComponent[] {
  const allowed = side === 'buy' ? ['tax', 'shipping', 'discount'] as const : ['platform-fee', 'insured-shipping'] as const;
  const seen = new Set<string>();
  return list(value, path, METALS_MAX_COMPONENTS).map((entry, index) => {
    const at = `${path}[${index}]`;
    const component = record(entry, at, ['kind', 'amountMinor']);
    const kind = oneOf(component.kind, `${at}.kind`, METALS_COMPONENT_KINDS);
    if (!(allowed as readonly string[]).includes(kind)) throw new Invalid(`${at}.kind`, `is not a component of a ${side}`);
    if (seen.has(kind)) throw new Invalid(`${at}.kind`, 'is repeated');
    seen.add(kind);
    const amount = minor(component.amountMinor, `${at}.amountMinor`);
    if (amount * COMPONENT_SIGNS[kind] < 0) throw new Invalid(`${at}.amountMinor`, 'has the wrong sign for its kind');
    return component as unknown as MetalsOrderComponent;
  });
}

function checkPurity(value: unknown, path: string): MetalsPurity {
  const purity = record(value, path, ['text', 'value']);
  const text = typeof purity.text === 'string' ? purity.text : '';
  const expected = METALS_PURITY_FORMS.get(text);
  if (expected === undefined) throw new Invalid(`${path}.text`, 'is not a form of the purity grammar');
  if (purity.value !== expected) throw new Invalid(`${path}.value`, 'is not the exact value of its form');
  return purity as unknown as MetalsPurity;
}

function checkEvents(value: unknown, path: string, side: MetalsSide, quantity: number): MetalsEvent[] {
  const kinds = side === 'buy' ? METALS_BUY_EVENT_KINDS : METALS_SELL_EVENT_KINDS;
  const counts = new Map<string, number>();
  return list(value, path, METALS_MAX_EVENTS).map((entry, index) => {
    const at = `${path}[${index}]`;
    const event = record(entry, at, ['kind', 'date', 'dateBasis', 'quantity', 'occurrence']);
    const kind = oneOf(event.kind, `${at}.kind`, METALS_EVENT_KINDS);
    if (!kinds.includes(kind)) throw new Invalid(`${at}.kind`, `is not an event of a ${side}`);
    const when = nullable(event.date, (v) => date(v, `${at}.date`));
    if (when === null) exact(event.dateBasis, `${at}.dateBasis`, null);
    else oneOf(event.dateBasis, `${at}.dateBasis`, METALS_DATE_BASES);
    const units = integer(event.quantity, `${at}.quantity`, 1, quantity);
    const identity = `${kind}\u0000${when ?? ''}\u0000${units}`;
    const occurrence = (counts.get(identity) ?? 0) + 1;
    counts.set(identity, occurrence);
    exact(event.occurrence, `${at}.occurrence`, occurrence);
    return event as unknown as MetalsEvent;
  });
}

function checkLifecycle(events: readonly MetalsEvent[], path: string, quantity: number, channel: MetalsChannel, orderDate: string): void {
  const total = (kind: MetalsEvent['kind']) => events.filter((event) => event.kind === kind).reduce((sum, event) => sum + event.quantity, 0);
  if (channel === 'warehouse') {
    const expected = [{ kind: 'delivered', date: orderDate, dateBasis: 'in-store', quantity, occurrence: 1 }];
    if (!same(events, expected)) throw new Invalid(path, 'must be one in-store delivery of every unit on the receipt date');
    return;
  }
  if (events.some((event) => event.dateBasis === 'in-store')) throw new Invalid(path, 'has an in-store date on an online order');
  if (total('cancelled') + total('delivered') > quantity) throw new Invalid(path, 'cancels and delivers more units than were ordered');
  if (total('returned') > total('delivered')) throw new Invalid(path, 'returns more units than were delivered');
}

const LINE_KEYS = ['key', 'ordinal', 'title', 'productRef', 'metal', 'metalUncertain', 'form', 'statedMass', 'pack', 'purity',
  'massBasis', 'design', 'contentFingerprint', 'fine', 'quantity', 'unitPriceMinor', 'amountMinor', 'directMinor', 'allocated',
  'costMinor', 'netMinor', 'complete', 'events', 'seller', 'sale'] as const;

/** The title guard's flag, by value (retail format 3's checks): the pinned guard, its evidence in order, its metal. */
function checkMetalUncertain(value: unknown, path: string): MetalsLineMetalUncertain {
  const flag = record(value, path, ['guard', 'evidence', 'metal']);
  exact(flag.guard, `${path}.guard`, METALS_TITLE_GUARD);
  const evidence = list(flag.evidence, `${path}.evidence`, METALS_GUARD_EVIDENCE.length);
  if (evidence.length === 0) throw new Invalid(`${path}.evidence`, 'must not be empty');
  let last = -1;
  evidence.forEach((entry, index) => {
    const at = METALS_GUARD_EVIDENCE.indexOf(oneOf(entry, `${path}.evidence[${index}]`, METALS_GUARD_EVIDENCE));
    if (at <= last) throw new Invalid(`${path}.evidence[${index}]`, 'must follow the closed order, once each');
    last = at;
  });
  nullable(flag.metal, (v) => oneOf(v, `${path}.metal`, METALS));
  return flag as unknown as MetalsLineMetalUncertain;
}

function checkLine(value: unknown, path: string, source: MetalsSource, order: Rec): MetalsLine {
  const side = order.side as MetalsSide;
  const channel = order.channel as MetalsChannel;
  const line = record(value, path, LINE_KEYS);
  pattern(line.key, `${path}.key`, keyPattern(source, lineKind(source, channel)));
  integer(line.ordinal, `${path}.ordinal`, 0, METALS_MAX_LINES - 1);
  const title = nullable(line.title, (v) => {
    if (typeof v !== 'string' || cardImportTextProblem(v, METALS_TITLE_MAX) !== null) throw new Invalid(`${path}.title`, 'must be stored text with no card data');
    return v;
  });
  nullable(line.productRef, (v) => {
    const ref = pattern(v, `${path}.productRef`, new RegExp(`^${source}:[A-Za-z0-9_-]{1,${METALS_PRODUCT_REF_MAX}}$`));
    // A run of 13 or more digits could be a card number: refused here by its own rule, as G2's storage refuses it,
    // whatever the card-data guard reads. Never the short-text rule's five digits: catalog ids hold runs of five or six.
    if (/\d{13}/.test(ref)) throw new Invalid(`${path}.productRef`, 'must not hold a run of 13 or more digits');
    if (containsCardData(ref)) throw new Invalid(`${path}.productRef`, 'must not look like card data');
    return ref;
  });
  const metal = nullable(line.metal, (v) => oneOf(v, `${path}.metal`, METALS));
  const flag = nullable(line.metalUncertain, (v) => checkMetalUncertain(v, `${path}.metalUncertain`));
  if (flag !== null) {
    // As in retail format 3, a flag only marks a line whose title reads as no metal.
    if (metal !== null) throw new Invalid(`${path}.metalUncertain`, 'is only on a line whose title names no metal');
  }
  nullable(line.form, (v) => oneOf(v, `${path}.form`, METAL_FORMS));
  nullable(line.statedMass, (v) => {
    const mass = record(v, `${path}.statedMass`, ['value', 'unit']);
    const text = pattern(mass.value, `${path}.statedMass.value`, WEIGHT_VALUE);
    if (parseRational(text) === null) throw new Invalid(`${path}.statedMass.value`, 'is not an exact number');
    oneOf(mass.unit, `${path}.statedMass.unit`, METAL_MASS_UNITS);
    return mass;
  });
  const pack = oneOf(line.pack, `${path}.pack`, METAL_PACKS);
  if (pack === 'single' && title !== null && retailMetalPack(title) === 'multiple') {
    throw new Invalid(`${path}.pack`, 'is single, but the stored title shows a pack marker');
  }
  // One direction only (design 4c-3): a line stored unflagged whose STORED title the pinned title guard reads as
  // metal-uncertain is refused. The guard runs the pinned title rule on the stored title itself (assessed), so the
  // payload's own claim (its metal, its flag) is never an input. A cut title can only over-refuse here. A flagged line
  // whose stored title reads as metal is never refused: the cut may have dropped the word that refused its raw title.
  if (flag === null && title !== null && retailMetalTitleGuard(title, { assessed: true }).uncertain) {
    throw new Invalid(`${path}.metalUncertain`, 'is null, but the pinned title guard reads the stored title as metal-uncertain');
  }
  if (source === 'costco') {
    for (const key of ['purity', 'massBasis', 'design'] as const) exact(line[key], `${path}.${key}`, null);
  } else {
    nullable(line.purity, (v) => checkPurity(v, `${path}.purity`));
    oneOf(line.massBasis, `${path}.massBasis`, METALS_MASS_BASES);
    nullable(line.design, (v) => oneOf(v, `${path}.design`, METALS_COIN_DESIGNS));
  }
  pattern(line.contentFingerprint, `${path}.contentFingerprint`, LETTER_HEX);
  if (!isRecord(line.fine)) throw new Invalid(`${path}.fine`, 'must be an object');
  // By value, whatever the stored title reads: a flagged line is held bullion-unconfirmed until the owner decides. (A
  // legal flag only: whether the converter flagged every line it should have is beyond what the wire can show.)
  if (flag !== null && line.fine.hold !== 'bullion-unconfirmed') throw new Invalid(`${path}.fine`, 'must be held bullion-unconfirmed on a flagged line');
  const quantity = integer(line.quantity, `${path}.quantity`, 1, 100_000);
  const unitPrice = nullable(line.unitPriceMinor, (v) => integer(v, `${path}.unitPriceMinor`, 0, METALS_MAX_MINOR));
  const amount = minor(line.amountMinor, `${path}.amountMinor`);
  if (channel === 'online' && unitPrice !== null && unitPrice * quantity !== amount) {
    throw new Invalid(`${path}.unitPriceMinor`, 'times the quantity is not the amount');
  }
  minor(line.directMinor, `${path}.directMinor`);
  list(line.allocated, `${path}.allocated`, METALS_MAX_LINES + METALS_MAX_COMPONENTS).forEach((entry, index) => {
    const share = record(entry, `${path}.allocated[${index}]`, ['component', 'amountMinor']);
    pattern(share.component, `${path}.allocated[${index}].component`, COMPONENT_ID);
    if (minor(share.amountMinor, `${path}.allocated[${index}].amountMinor`) === 0) throw new Invalid(`${path}.allocated[${index}].amountMinor`, 'must not be zero');
  });
  if (side === 'buy') {
    minor(line.costMinor, `${path}.costMinor`);
    exact(line.netMinor, `${path}.netMinor`, null);
  } else {
    minor(line.netMinor, `${path}.netMinor`);
    exact(line.costMinor, `${path}.costMinor`, null);
  }
  bool(line.complete, `${path}.complete`);
  const events = checkEvents(line.events, `${path}.events`, side, quantity);
  if (side === 'buy') checkLifecycle(events, `${path}.events`, quantity, channel, order.date as string);
  if (source === 'walmart') {
    nullable(line.seller, (v) => {
      if (typeof v === 'string' && SELLER_KEY.test(v)) return v;
      if (typeof v !== 'string' || metalsSellerNameProblem(v) !== null) throw new Invalid(`${path}.seller`, 'must be a guarded name or a seller key');
      return v;
    });
  } else exact(line.seller, `${path}.seller`, null);
  if (side === 'sell') {
    const sale = record(line.sale, `${path}.sale`, ['program', 'premium', 'inspection']);
    nullable(sale.program, (v) => guardedText(v, `${path}.sale.program`));
    nullable(sale.premium, (v) => {
      const premium = record(v, `${path}.sale.premium`, ['text', 'basis']);
      guardedText(premium.text, `${path}.sale.premium.text`);
      return oneOf(premium.basis, `${path}.sale.premium.basis`, METALS_PREMIUM_BASES);
    });
    nullable(sale.inspection, (v) => oneOf(v, `${path}.sale.inspection`, METALS_INSPECTIONS));
  } else exact(line.sale, `${path}.sale`, null);
  return line as unknown as MetalsLine;
}

/** A stored line's content evidence, its raw flag included: what the content rule reads for it, everywhere. */
export function metalsLineEvidence(line: MetalsLine, source: MetalsSource): MetalsContentEvidence {
  return {
    source, metal: line.metal, form: line.form, statedMass: line.statedMass, pack: line.pack, purity: line.purity,
    massBasis: line.massBasis, design: line.design, metalUncertain: line.metalUncertain,
  };
}

/** Fine content and fingerprint, recomputed from the line's own evidence (no owner decision reaches a payload). */
function checkContent(line: MetalsLine, path: string, source: MetalsSource): void {
  const evidence = metalsLineEvidence(line, source);
  if (line.contentFingerprint !== metalsContentFingerprint(evidence)) throw new Invalid(`${path}.contentFingerprint`, 'does not match the line\'s evidence');
  if (!same(line.fine, metalsFineContentWire(metalsFineContent(evidence)))) throw new Invalid(`${path}.fine`, 'does not match the content rule');
}

/**
 * Dates against the order's own: nothing stated happens before the order's date (a buy's order date, a sale's agreed
 * day); a sale's `agreed` event is its agreed day and its `completed` event its completed date; and a payout is paid no
 * earlier than it was initiated.
 */
function checkTimeline(order: MetalsOrder, path: string): void {
  const early = (day: string | null) => day !== null && day < order.date;
  order.lines.forEach((line, index) => line.events.forEach((event, at) => {
    const where = `${path}.lines[${index}].events[${at}].date`;
    if (event.date === null) return;
    if (early(event.date)) throw new Invalid(where, 'is before the order\'s date');
    if (event.kind === 'agreed' && event.date !== order.date) throw new Invalid(where, 'must be the sale\'s agreed day');
    if (event.kind === 'completed' && event.date !== order.completedDate) throw new Invalid(where, 'must be the sale\'s completed date');
  }));
  if (early(order.completedDate)) throw new Invalid(`${path}.completedDate`, 'is before the order\'s date');
  order.refunds.forEach((refund, index) => {
    if (early(refund.date)) throw new Invalid(`${path}.refunds[${index}].date`, 'is before the order\'s date');
  });
  order.payouts.forEach((payout, index) => {
    const at = `${path}.payouts[${index}]`;
    if (early(payout.initiatedDate)) throw new Invalid(`${at}.initiatedDate`, 'is before the order\'s date');
    if (early(payout.payoutDate)) throw new Invalid(`${at}.payoutDate`, 'is before the order\'s date');
    if (payout.initiatedDate !== null && payout.payoutDate !== null && payout.payoutDate < payout.initiatedDate) {
      throw new Invalid(`${at}.payoutDate`, 'is before the payout was initiated');
    }
  });
}

/** Allocation, recomputed from the skeleton and components, against every line's money and the order's totals. */
function checkMoney(order: MetalsOrder, path: string): void {
  const allocation = metalsAllocation(order.skeleton, order.components);
  if (order.unattributedMinor !== allocation.unattributedMinor) throw new Invalid(`${path}.unattributedMinor`, 'does not match the allocation rule');
  if (order.fullPriceMinor !== allocation.fullPriceMinor) throw new Invalid(`${path}.fullPriceMinor`, 'is not the skeleton and components');
  const byOrdinal = new Map(allocation.lines.map((line) => [line.ordinal, line]));
  const seen = new Set<number>();
  order.lines.forEach((line, index) => {
    const at = `${path}.lines[${index}]`;
    const allocated = byOrdinal.get(line.ordinal);
    if (!allocated || !allocated.metal) throw new Invalid(`${at}.ordinal`, 'must name a metal item of the skeleton');
    if (seen.has(line.ordinal)) throw new Invalid(`${at}.ordinal`, 'is repeated');
    seen.add(line.ordinal);
    if (line.amountMinor !== order.skeleton[line.ordinal].amountMinor) throw new Invalid(`${at}.amountMinor`, 'is not its skeleton line\'s amount');
    if (line.directMinor !== allocated.directMinor) throw new Invalid(`${at}.directMinor`, 'does not match the allocation rule');
    if (!same(line.allocated, allocated.allocated)) throw new Invalid(`${at}.allocated`, 'does not match the allocation rule');
    const total = order.side === 'buy' ? line.costMinor : line.netMinor;
    if (total !== allocated.totalMinor) throw new Invalid(`${at}.${order.side === 'buy' ? 'costMinor' : 'netMinor'}`, 'does not match the allocation rule');
    if (line.complete !== allocated.complete) throw new Invalid(`${at}.complete`, 'does not match the allocation rule');
  });
  if (allocation.lines.some((line) => line.metal && !seen.has(line.ordinal))) throw new Invalid(`${path}.lines`, 'misses a metal item of the skeleton');
}

const ORDER_KEYS = ['key', 'side', 'channel', 'date', 'tradeMoment', 'completedDate', 'currency', 'status', 'skeleton', 'components',
  'admission', 'evidence', 'refunds', 'payouts', 'unattributedMinor', 'fullPriceMinor', 'lines'] as const;

function checkOrder(value: unknown, path: string, source: MetalsSource): MetalsOrder {
  const order = record(value, path, ORDER_KEYS);
  const side = oneOf(order.side, `${path}.side`, METALS_SIDES);
  if (side !== sideOf(source)) throw new Invalid(`${path}.side`, `must be ${sideOf(source)} for ${source}`);
  const channel = oneOf(order.channel, `${path}.channel`, channelsOf(source));
  pattern(order.key, `${path}.key`, keyPattern(source, orderKind(source, channel)));
  date(order.date, `${path}.date`);
  if (side === 'sell') {
    const moment = instant(order.tradeMoment, `${path}.tradeMoment`);
    if (order.date !== metalsNewYorkDate(moment)) throw new Invalid(`${path}.date`, 'must be the trade moment\'s New York date');
  } else exact(order.tradeMoment, `${path}.tradeMoment`, null);
  nullable(order.completedDate, (v) => date(v, `${path}.completedDate`));
  exact(order.currency, `${path}.currency`, 'USD');
  if (side === 'sell') oneOf(order.status, `${path}.status`, METALS_SELL_STATUSES);
  else exact(order.status, `${path}.status`, null);
  const skeleton = checkSkeleton(order.skeleton, `${path}.skeleton`);
  const components = checkComponents(order.components, `${path}.components`, side);
  minor(order.unattributedMinor, `${path}.unattributedMinor`);
  const fullPrice = minor(order.fullPriceMinor, `${path}.fullPriceMinor`);
  const evidence = list(order.evidence, `${path}.evidence`, METALS_MAX_METHODS);
  const refunds = list(order.refunds, `${path}.refunds`, side === 'buy' ? METALS_MAX_REFUNDS : 0);
  refunds.forEach((entry, index) => {
    const refund = record(entry, `${path}.refunds[${index}]`, ['amountMinor', 'date']);
    integer(refund.amountMinor, `${path}.refunds[${index}].amountMinor`, -METALS_MAX_MINOR, -1);
    nullable(refund.date, (v) => date(v, `${path}.refunds[${index}].date`));
  });
  const payouts = list(order.payouts, `${path}.payouts`, side === 'sell' ? METALS_MAX_PAYOUTS : 0);
  let admission: MetalsAdmissionFacts | null = null;
  if (side === 'buy') {
    admission = checkAdmission(order.admission, `${path}.admission`, channel);
    if (admission.grossTotalMinor !== fullPrice) throw new Invalid(`${path}.admission.grossTotalMinor`, 'must be the order\'s full price');
    if (refunds.length > 0 && !admission.refunded) throw new Invalid(`${path}.admission.refunded`, 'must be set on an order with refunds');
  } else {
    exact(order.admission, `${path}.admission`, null);
    if (evidence.length > 0) throw new Invalid(`${path}.evidence`, 'must be empty on a sale');
    let paid = 0;
    let allComplete = true;
    payouts.forEach((entry, index) => {
      const at = `${path}.payouts[${index}]`;
      const payout = record(entry, at, ['key', 'method', 'destinationLast4', 'amountMinor', 'initiatedDate', 'payoutDate', 'status']);
      pattern(payout.key, `${at}.key`, keyPattern('collectpure', 'payout'));
      exact(payout.method, `${at}.method`, 'ach');
      nullable(payout.destinationLast4, (v) => pattern(v, `${at}.destinationLast4`, /^[0-9]{4}$/));
      paid += integer(payout.amountMinor, `${at}.amountMinor`, 1, METALS_MAX_MINOR);
      nullable(payout.initiatedDate, (v) => date(v, `${at}.initiatedDate`));
      nullable(payout.payoutDate, (v) => date(v, `${at}.payoutDate`));
      allComplete &&= oneOf(payout.status, `${at}.status`, METALS_PAYOUT_STATUSES) === 'complete';
    });
    if (order.status === 'complete' && (payouts.length === 0 || !allComplete || paid !== fullPrice)) {
      throw new Invalid(`${path}.payouts`, 'must be complete and add up to the net proceeds on a complete sale');
    }
    // A cancelled sale paid nothing out; one with a payout is ambiguous, and the converter holds it.
    if (order.status === 'cancelled' && payouts.length > 0) throw new Invalid(`${path}.payouts`, 'must be empty on a cancelled sale');
    if (paid > fullPrice) throw new Invalid(`${path}.payouts`, 'pay out more than the net proceeds');
  }
  const lines = list(order.lines, `${path}.lines`, METALS_MAX_LINES).map((line, index) => checkLine(line, `${path}.lines[${index}]`, source, order));
  if (lines.length === 0) throw new Invalid(`${path}.lines`, 'must not be empty');
  if (admission !== null) {
    // An order with a line the title guard flagged has no card evidence, whatever its admission facts would admit: a
    // payload consistency check only. The read side's "held for metals" predicate is what keeps an undecided flagged
    // order out of card links (as anything but a held barrier).
    if (lines.some((line) => line.metalUncertain !== null)) {
      if (evidence.length > 0) throw new Invalid(`${path}.evidence`, 'must be empty on an order with a flagged line');
    } else {
      const admitted = metalsAdmission(source, channel, admission);
      if (!same(evidence, admitted?.evidence ?? [])) throw new Invalid(`${path}.evidence`, 'does not match the evidence class\'s admission');
    }
  }
  const checked = order as unknown as MetalsOrder;
  checked.skeleton = skeleton;
  checked.components = components;
  checked.lines = lines;
  checkMoney(checked, path);
  lines.forEach((line, index) => checkContent(line, `${path}.lines[${index}]`, source));
  checkTimeline(checked, path);
  return checked;
}

function checkCompetitor(value: unknown, path: string, source: MetalsSource): MetalsCompetitor {
  const competitor = record(value, path, ['orderKey', 'channel', 'date', 'interval', 'admission', 'basis', 'capMinor']);
  const channel = oneOf(competitor.channel, `${path}.channel`, channelsOf(source));
  pattern(competitor.orderKey, `${path}.orderKey`, keyPattern(source, orderKind(source, channel)));
  const when = date(competitor.date, `${path}.date`);
  if (!same(competitor.interval, metalsSettlementInterval(when, channel))) throw new Invalid(`${path}.interval`, 'is not the channel\'s settlement interval');
  const facts = checkAdmission(competitor.admission, `${path}.admission`, channel);
  const admitted = metalsAdmission(source, channel, facts);
  if (admitted === null) throw new Invalid(`${path}.admission`, 'has no card funding');
  if (competitor.basis !== admitted.basis) throw new Invalid(`${path}.basis`, 'does not match its admission facts');
  if (competitor.capMinor !== admitted.capMinor) throw new Invalid(`${path}.capMinor`, 'does not match its admission facts');
  return competitor as unknown as MetalsCompetitor;
}

function checkInput(value: unknown, source: MetalsSource): void {
  if (source === 'costco') {
    const input = record(value, '$.input', ['retailPayloadSha256', 'retailFormat', 'retailPolicyVersion']);
    pattern(input.retailPayloadSha256, '$.input.retailPayloadSha256', LETTER_HEX);
    const read = METALS_RETAIL_INPUTS.find((entry) => entry.format === input.retailFormat);
    if (read === undefined) throw new Invalid('$.input.retailFormat', 'is not a retail format this contract reads');
    exact(input.retailPolicyVersion, '$.input.retailPolicyVersion', read.policy);
    return;
  }
  const input = record(value, '$.input', ['schema', 'captureDigest', 'capturedAt', 'files']);
  exact(input.schema, '$.input.schema', METALS_CAPTURE_SCHEMAS[source]);
  pattern(input.captureDigest, '$.input.captureDigest', LETTER_HEX);
  instant(input.capturedAt, '$.input.capturedAt');
  integer(input.files, '$.input.files', 1, 100_000);
}

/**
 * Checks a parsed payload field by field, by type and value, and recomputes every derived fact from the facts it
 * holds. The first problem found is reported.
 */
export function validateMetalsImportPayload(value: unknown): MetalsPayloadValidation {
  try {
    const payload = record(value, '$', ['format', 'version', 'source', 'account', 'converterVersion', 'policyVersion', 'rules',
      'input', 'coverage', 'orders', 'competitors', 'held']);
    exact(payload.format, '$.format', METALS_IMPORT_FORMAT);
    exact(payload.version, '$.version', METALS_IMPORT_VERSION);
    const source = oneOf(payload.source, '$.source', METALS_SOURCES);
    const account = record(payload.account, '$.account', ['folder', 'identityLast4']);
    pattern(account.folder, '$.account.folder', new RegExp(`^${source}(?:-[1-9][0-9]{0,2})?$`));
    if (source === 'costco') nullable(account.identityLast4, (v) => pattern(v, '$.account.identityLast4', /^[0-9]{4}$/));
    else exact(account.identityLast4, '$.account.identityLast4', null);
    // The converters' one importable release (model.ts), exactly: a payload of any other release is re-converted first.
    exact(payload.converterVersion, '$.converterVersion', METALS_CONVERTER);
    exact(payload.policyVersion, '$.policyVersion', METALS_CONVERT_POLICY_VERSION);
    if (!same(payload.rules, METALS_RULES)) throw new Invalid('$.rules', 'must name exactly this validator\'s rule versions');
    checkInput(payload.input, source);
    list(payload.coverage, '$.coverage', 200).forEach((entry, index) => {
      const at = `$.coverage[${index}]`;
      const range = record(entry, at, ['kind', 'from', 'to', 'stated', 'seen', 'complete']);
      oneOf(range.kind, `${at}.kind`, coverageKindsOf(source));
      if (date(range.from, `${at}.from`) > date(range.to, `${at}.to`)) throw new Invalid(at, 'must not end before it starts');
      const stated = nullable(range.stated, (v) => integer(v, `${at}.stated`, 0, 1_000_000));
      const seen = integer(range.seen, `${at}.seen`, 0, 1_000_000);
      exact(range.complete, `${at}.complete`, stated !== null && stated === seen);
    });
    const keys = new Set<string>();
    const lineKeys = new Set<string>();
    const payoutKeys = new Set<string>();
    list(payload.orders, '$.orders', METALS_MAX_ORDERS).forEach((entry, index) => {
      const order = checkOrder(entry, `$.orders[${index}]`, source);
      if (keys.has(order.key)) throw new Invalid(`$.orders[${index}].key`, 'is repeated');
      keys.add(order.key);
      order.lines.forEach((line, lineIndex) => {
        if (lineKeys.has(line.key)) throw new Invalid(`$.orders[${index}].lines[${lineIndex}].key`, 'is repeated');
        lineKeys.add(line.key);
      });
      order.payouts.forEach((payout, payoutIndex) => {
        if (payoutKeys.has(payout.key)) throw new Invalid(`$.orders[${index}].payouts[${payoutIndex}].key`, 'is repeated');
        payoutKeys.add(payout.key);
      });
    });
    const competitors = list(payload.competitors, '$.competitors', source === 'collectpure' ? 0 : METALS_MAX_ORDERS);
    competitors.forEach((entry, index) => {
      const competitor = checkCompetitor(entry, `$.competitors[${index}]`, source);
      if (keys.has(competitor.orderKey)) throw new Invalid(`$.competitors[${index}].orderKey`, 'is repeated or also an order');
      keys.add(competitor.orderKey);
    });
    list(payload.held, '$.held', METALS_MAX_ORDERS).forEach((entry, index) => {
      const at = `$.held[${index}]`;
      const held = record(entry, at, ['key', 'channel', 'date', 'reason', 'check']);
      const channel = oneOf(held.channel, `${at}.channel`, channelsOf(source));
      nullable(held.key, (v) => {
        const key = pattern(v, `${at}.key`, keyPattern(source, orderKind(source, channel)));
        if (keys.has(key)) throw new Invalid(`${at}.key`, 'is repeated, or also an order or competitor');
        keys.add(key);
        return key;
      });
      nullable(held.date, (v) => date(v, `${at}.date`));
      oneOf(held.reason, `${at}.reason`, METALS_HOLD_REASONS);
      pattern(held.check, `${at}.check`, CHECK);
    });
    return { ok: true, payload: payload as unknown as MetalsImportPayload };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, issues: [{ path: error.path, message: error.reason }] };
    throw error;
  }
}
