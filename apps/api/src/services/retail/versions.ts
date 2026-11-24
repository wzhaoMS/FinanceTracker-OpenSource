import { CARD_TEXT_FORBIDDEN_RANGES } from '@finance-tracker/shared';
import {
  RETAIL_CARD_TENDER_KINDS,
  RETAIL_CARRIERS,
  RETAIL_CHANNELS,
  RETAIL_CONVERT_POLICY_VERSION,
  RETAIL_FULFILMENTS,
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
  RETAIL_METAL_FORMS,
  RETAIL_METAL_GUARD,
  RETAIL_METAL_GUARD_EVIDENCE,
  RETAIL_METAL_PACK_RULE,
  RETAIL_METAL_PACKS,
  RETAIL_METAL_TITLE_RULE,
  RETAIL_METALS,
  RETAIL_NETWORKS,
  RETAIL_ONLINE_STATUSES,
  RETAIL_SIGNS,
  RETAIL_STORED_VALUE_KINDS,
  RETAIL_TENDER_KINDS,
  RETAIL_TITLE_MAX,
  RETAIL_WEIGHT_UNITS,
  type RetailImportLine,
  type RetailImportPayload,
  type RetailImportReceipt,
  type RetailImportTender,
  type RetailShipment,
} from '@finance-tracker/shared/retail-import-payload';

import { digest } from '../amazon/policy.js';
import { retailLetters } from './common.js';
import {
  RETAIL_LINE_EVENT_KINDS,
  RETAIL_OUTCOMES,
  RETAIL_QUARANTINE_REASONS,
  RETAIL_REVIEW_DECISIONS,
  RETAIL_TEXT_SPACING_RANGES,
  type RetailImportOutcome,
  type RetailQuarantineReason,
} from './schema.js';

/**
 * A receipt's versions (plan v5 §5.2, §5.3): what one payload receipt states, as three digests and its money, and how a
 * sighting compares with the receipt's canonical version. Pure: no database. The storage check (§4.1) is here too: the
 * schema's CHECKs, clause by clause, on a validated payload, so that nothing the preflight accepts is refused by the
 * database after the backup.
 */

/** The rule labels a version was read under (its provenance, §5.2). */
export interface RetailVersionLabels {
  policyVersion: number;
  titleRule: string;
  metalGuard: string;
  packRule: string;
}

/** The one policy this build reads (the shared validator's: format 3, policy 5) and its rules' labels. */
export const RETAIL_BUILD_LABELS: Readonly<RetailVersionLabels> = Object.freeze({
  policyVersion: RETAIL_CONVERT_POLICY_VERSION,
  titleRule: RETAIL_METAL_TITLE_RULE,
  metalGuard: RETAIL_METAL_GUARD,
  packRule: RETAIL_METAL_PACK_RULE,
});

const SOURCE_TAG = 'holdr.retail-version-source';
const MEANING_TAG = 'holdr.retail-version-meaning';
const PROVENANCE_TAG = 'holdr.retail-version-provenance';
const SHIPMENT_TAG = 'holdr.retail-shipment-observation';
const TENDER_TAG = 'holdr.retail-tender-observation';
/** A receipt's totals, in the one order the digests and the money comparison read them. */
export const RETAIL_TOTAL_KEYS = ['subtotalMinor', 'taxMinor', 'instantSavingsMinor', 'discountMinor', 'shippingMinor', 'feesMinor',
  'storedValueMinor', 'totalMinor'] as const;

/**
 * This build's import policy, as a GO pins it (plan §8.4): the payload it reads, the labels it records, the digests it
 * computes, and its closed outcomes, reasons and decisions. Any change to how a payload is read is another digest.
 */
export const RETAIL_POLICY_DIGEST = digest({
  format: 'holdr.retail-policy', version: 1,
  payload: { format: RETAIL_IMPORT_FORMAT, version: RETAIL_IMPORT_VERSION, policyVersion: RETAIL_CONVERT_POLICY_VERSION },
  labels: RETAIL_BUILD_LABELS,
  digests: { source: SOURCE_TAG, meaning: MEANING_TAG, provenance: PROVENANCE_TAG, shipment: SHIPMENT_TAG, tender: TENDER_TAG, version: 1 },
  outcomes: RETAIL_OUTCOMES, reasons: RETAIL_QUARANTINE_REASONS, decisions: RETAIL_REVIEW_DECISIONS,
});

/** A tagged digest of facts, in letter hex as the tables store it. */
const letterDigest = (tag: string, facts: unknown): string => retailLetters(digest({ tag, version: 1, facts }));

/** A line's identity within its receipt (plan §4.3): online by its line key, warehouse and gas by its ordinal. */
export const retailLineIdentity = (line: { lineKey: string | null; ordinal: number }): string =>
  (line.lineKey !== null ? `key:${line.lineKey}` : `ordinal:${line.ordinal}`);

/** One shipment observation's identity (plan §4.3): its four facts, never its position. */
export const retailShipmentObservation = (shipment: RetailShipment): string =>
  letterDigest(SHIPMENT_TAG, [shipment.shippedDate, shipment.deliveredDate, shipment.estimatedArrivalDate, shipment.carrier]);

/** One tender observation's identity (plan §4.3): its kind, network, last four and signed amount, never its position. */
export const retailTenderObservation = (tender: Pick<RetailImportTender, 'kind' | 'network' | 'last4' | 'amountMinor'>): string =>
  letterDigest(TENDER_TAG, [tender.kind, tender.network, tender.last4, tender.amountMinor]);

/**
 * Each item's occurrence among identical ones before it (1, 2, …): with its observation digest, the identity of a
 * shipment within its line or a tender within its receipt, so identical observations keep their multiplicity.
 */
export function retailOccurrences(observations: readonly string[]): number[] {
  const seen = new Map<string, number>();
  return observations.map((observation) => {
    const occurrence = (seen.get(observation) ?? 0) + 1;
    seen.set(observation, occurrence);
    return occurrence;
  });
}

/** A line's money, compared by its identity. */
export interface RetailLineMoney {
  amountMinor: number;
  unitPriceMinor: number | null;
  shippingMinor: number | null;
}

/**
 * A version's money, compared directly (plan §5.2, Root's limit): currency and sign; the eight totals, null apart from a
 * stated zero; each line's amount, unit price and shipping by line identity; and its tenders as a multiset of
 * observations (kind, network, last four, signed amount), so a tender's amount is compared by its identity.
 */
export interface RetailMoney {
  currency: string;
  sign: string;
  totals: ReadonlyArray<number | null>;
  lines: ReadonlyMap<string, RetailLineMoney>;
  tenders: ReadonlyMap<string, number>;
}

/** A tender's identity in a money comparison: the observation's facts, in plain form (never stored or printed). */
export const retailTenderMoneyKey = (tender: { kind: string; network: string; last4: string | null; amountMinor: number }): string =>
  JSON.stringify([tender.kind, tender.network, tender.last4, tender.amountMinor]);

export function retailMoneyOf(receipt: RetailImportReceipt): RetailMoney {
  const tenders = new Map<string, number>();
  for (const tender of receipt.tenders) tenders.set(retailTenderMoneyKey(tender), (tenders.get(retailTenderMoneyKey(tender)) ?? 0) + 1);
  return {
    currency: receipt.currency,
    sign: receipt.sign,
    totals: RETAIL_TOTAL_KEYS.map((key) => receipt.totals[key]),
    lines: new Map(receipt.lines.map((line) => [retailLineIdentity(line),
      { amountMinor: line.amountMinor, unitPriceMinor: line.unitPriceMinor, shippingMinor: line.shippingMinor }])),
    tenders,
  };
}

/** Whether two versions' money differs anywhere (plan §5.2): a line or tender in one and not the other is a difference. */
export function retailMoneyDiffers(a: RetailMoney, b: RetailMoney): boolean {
  if (a.currency !== b.currency || a.sign !== b.sign) return true;
  if (a.totals.length !== b.totals.length || a.totals.some((value, index) => value !== b.totals[index])) return true;
  if (a.lines.size !== b.lines.size) return true;
  for (const [identity, line] of a.lines) {
    const other = b.lines.get(identity);
    if (other === undefined || other.amountMinor !== line.amountMinor || other.unitPriceMinor !== line.unitPriceMinor
      || other.shippingMinor !== line.shippingMinor) return true;
  }
  if (a.tenders.size !== b.tenders.size) return true;
  for (const [identity, count] of a.tenders) if (b.tenders.get(identity) !== count) return true;
  return false;
}

/** A version's three digests (§5.2), in letter hex. */
export interface RetailVersionDigests {
  sourceDigest: string;
  meaningDigest: string;
  provenanceDigest: string;
}

/** What a sighting is compared by: its digests, its policy and its money. */
export interface RetailVersionComparable extends RetailVersionDigests {
  policyVersion: number;
  money: RetailMoney;
}

const lineSource = (line: RetailImportLine) => [
  line.ordinal, line.lineKey, line.kind, line.itemNumber, line.title, line.title2, line.department, line.quantity, line.unitPriceMinor,
  line.amountMinor, line.shippingMinor, line.taxFlag, line.couponTarget, line.feeParent, line.fulfilment, line.fuelGallons, line.fuelUnitPrice,
  line.events === null ? null : RETAIL_LINE_EVENT_KINDS.map((kind) => line.events![kind].map((event) => [event.quantity, event.date])),
  line.shipments.map((shipment) => [shipment.shippedDate, shipment.deliveredDate, shipment.estimatedArrivalDate, shipment.carrier]),
];

/** A line's meaningful derived facts (§5.2): its metal, its guard's flag and its stored-value kind, without rule labels. */
const lineMeaning = (line: RetailImportLine) => [
  retailLineIdentity(line),
  line.metal === null ? null : [line.metal.metal, line.metal.form,
    line.metal.statedWeight === null ? null : [line.metal.statedWeight.value, line.metal.statedWeight.unit], line.metal.pack],
  line.metalUncertain === null ? null : [line.metalUncertain.evidence, line.metalUncertain.metal],
  line.storedValue,
];

/**
 * One payload receipt as a version (§5.2): `sourceDigest` over every fact Costco states (the receipt's date, time, sign,
 * status, currency, totals and legends; each line's stated fields, events and shipments; each tender); `meaningDigest`
 * over the meaningful derived facts; `provenanceDigest` over the policy and its rule labels. The converter's own version
 * is the import's, never the version's.
 */
export function retailVersionOf(receipt: RetailImportReceipt, labels: RetailVersionLabels): RetailVersionComparable {
  return {
    sourceDigest: letterDigest(SOURCE_TAG, {
      date: receipt.date, localTime: receipt.localTime, sign: receipt.sign, status: receipt.status, currency: receipt.currency,
      totals: RETAIL_TOTAL_KEYS.map((key) => receipt.totals[key]),
      taxLegends: receipt.taxLegends.map((legend) => [legend.legend, legend.amountMinor]),
      lines: receipt.lines.map(lineSource),
      tenders: receipt.tenders.map((tender) => [tender.ordinal, tender.kind, tender.network, tender.last4, tender.amountMinor]),
    }),
    meaningDigest: letterDigest(MEANING_TAG, receipt.lines.map(lineMeaning)),
    provenanceDigest: letterDigest(PROVENANCE_TAG, [labels.policyVersion, labels.titleRule, labels.metalGuard, labels.packRule]),
    policyVersion: labels.policyVersion,
    money: retailMoneyOf(receipt),
  };
}

/** A receipt as a sighting meets it: its state and canonical version, or null when no receipt has its key. */
export interface RetailSightingReceipt {
  state: 'active' | 'quarantined';
  canonical: RetailVersionComparable;
}

/** One payload receipt against the stored receipt of its key (plan §5.3). */
export interface RetailSighting {
  receipt: RetailSightingReceipt | null;
  incoming: RetailVersionComparable;
  /** Whether the importing membership has an observation of this receipt already. */
  seenByMembership: boolean;
}

/**
 * The decision for one sighting. The outcome is a label, counted; what is written follows `reason` (an event that
 * quarantines, or a cause on a receipt already quarantined) and `moves` (a labels-only refresh moves the canonical).
 */
export interface RetailSightingDecision {
  outcome: RetailImportOutcome;
  reason: RetailQuarantineReason | null;
  moves: boolean;
}

/**
 * §5.3's table, against the canonical version; the first row that applies decides. Q-V1 as Root ruled it, whatever the
 * policy rank (D-R3-1): only a labels-only re-reading changes nothing a reader uses (a newer policy refreshes the
 * canonical, an older one is an observation); any meaningful derived change keeps the canonical and holds the receipt.
 * A quarantined receipt is `quarantined`, and gets a cause exactly when the rows below would quarantine this version.
 * No row is the reserved `progression` (plan §5.7): its type excludes it.
 */
export function classifyRetailSighting(sighting: RetailSighting): RetailSightingDecision {
  const { receipt, incoming, seenByMembership } = sighting;
  if (receipt === null) return { outcome: 'new', reason: null, moves: false };
  const against = againstCanonical(incoming, receipt.canonical, seenByMembership);
  if (receipt.state === 'quarantined') return { outcome: 'quarantined', reason: against.reason, moves: false };
  return against;
}

function againstCanonical(incoming: RetailVersionComparable, canonical: RetailVersionComparable, seen: boolean): RetailSightingDecision {
  const source = incoming.sourceDigest !== canonical.sourceDigest || retailMoneyDiffers(incoming.money, canonical.money);
  const meaning = incoming.meaningDigest !== canonical.meaningDigest;
  const labels = incoming.provenanceDigest !== canonical.provenanceDigest;
  const policy = Math.sign(incoming.policyVersion - canonical.policyVersion);
  if (source && !seen) return { outcome: 'conflict', reason: 'duplicate-across-memberships', moves: false };
  if ((source && policy <= 0) || ((meaning || labels) && policy === 0)) return { outcome: 'changed', reason: 'receipt-changed', moves: false };
  if ((source && policy > 0) || meaning) return { outcome: 'policy-reread', reason: 'policy-reread-changed', moves: false };
  if (labels && policy > 0) return { outcome: 'provenance-refresh', reason: null, moves: true };
  if (labels) return { outcome: 'older-policy', reason: null, moves: false };
  return { outcome: seen ? 'unchanged' : 'shared', reason: null, moves: false };
}

// ---------------------------------------------------------------------------------------------------------------------
// The storage check (plan §4.1): every CHECK a payload value reaches, as the schema writes it (schema.ts), on a payload
// the validator accepted. Each refused value is named by its payload path only.
// ---------------------------------------------------------------------------------------------------------------------

const inRanges = (codePoint: number, ranges: ReadonlyArray<readonly [number, number]>) =>
  ranges.some(([start, end]) => codePoint >= start && codePoint <= end);

/**
 * The free-text CHECK (schema.ts `text`) in the preflight, clause by clause, or null when the text is storable: 1 to `max`
 * characters (SQLite counts code points); no NUL; no control or spacing character; single spaces, none at either end;
 * none of the card guard's forbidden characters; no formula start; no run of 13 or more digits.
 */
export function retailTextProblem(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return 'type';
  const codePoints = [...value].map((char) => char.codePointAt(0)!);
  if (codePoints.length < 1 || codePoints.length > max) return 'length';
  if (codePoints.includes(0)) return 'nul';
  if (codePoints.some((codePoint) => inRanges(codePoint, RETAIL_TEXT_SPACING_RANGES))) return 'spacing';
  if (value.includes('  ')) return 'double-space';
  if (value.startsWith(' ') || value.endsWith(' ')) return 'trim';
  if (codePoints.some((codePoint) => inRanges(codePoint, CARD_TEXT_FORBIDDEN_RANGES))) return 'forbidden';
  if (/^[=+@-]/.test(value)) return 'formula';
  if (/[0-9]{13}/.test(value)) return 'digits';
  return null;
}

const isInteger = (value: unknown, min: number, max: number): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const isMinor = (value: unknown) => isInteger(value, -RETAIL_MAX_MINOR, RETAIL_MAX_MINOR);
const isLetters = (value: unknown, length = 64) => typeof value === 'string' && value.length === length && /^[a-p]*$/.test(value);
const isKey = (value: unknown, prefix: string) => typeof value === 'string' && value.startsWith(prefix) && isLetters(value.slice(prefix.length));
const among = (value: unknown, values: readonly string[]) => typeof value === 'string' && values.includes(value);
const isSlug = (value: unknown, max: number) => typeof value === 'string' && value.length >= 1 && value.length <= max
  && /^[a-z][a-z0-9-]*$/.test(value) && !/[0-9]{13}/.test(value);
const isDecimal = (value: unknown, max: number) => typeof value === 'string' && value.length >= 1 && value.length <= max
  && /^[0-9][0-9.]*$/.test(value) && !/\..*\./.test(value);
/** SQLite's `date(x) IS x` on a 10-character text: a real calendar day, 0000-01-01 to 9999-12-31. */
export function isRetailDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/**
 * A payload's `capturedAt` as the imports table keeps it (§4.2): the same instant, written in 24 characters. Null when it
 * names no real instant exactly (a day or hour out of range would otherwise roll over to another time).
 */
export function retailCapturedAt(capturedAt: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(capturedAt);
  if (match === null || !isRetailDay(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return null;
  const normalized = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${(match[5] ?? '').padEnd(3, '0')}Z`;
  const time = Date.parse(normalized);
  return Number.isNaN(time) || new Date(time).toISOString() !== normalized ? null : normalized;
}

const STORAGE_PROBLEMS_LISTED = 20;

/**
 * Every value of a validated payload that the tables would refuse, by payload path (at most 20), or none: the schema's
 * CHECKs on the import, its coverage and membership facts, each receipt's version, legends, lines, uncertain evidence,
 * events, shipments and tenders, and each held record. Run in the preflight after the validator and before any backup
 * (`retail-payload-unstorable`), so that no CHECK refuses a payload the preflight accepts (plan §2 rule 7).
 */
export function retailStorageProblems(payload: RetailImportPayload): string[] {
  const problems: string[] = [];
  const need = (ok: boolean, at: string) => {
    if (!ok && problems.length < STORAGE_PROBLEMS_LISTED) problems.push(at);
  };
  need(typeof payload.converterVersion === 'string' && payload.converterVersion.length >= 26 && payload.converterVersion.length <= 32
    && /^holdr-retail-convert [0-9][0-9.]*$/.test(payload.converterVersion)
    && /^[0-9].*\..*\./.test(payload.converterVersion.slice(21)), '$.converterVersion');
  need(isInteger(payload.version, 3, 999), '$.version');
  need(isInteger(payload.policyVersion, 5, 999), '$.policyVersion');
  need(typeof payload.source.schema === 'string' && payload.source.schema.length >= 1 && payload.source.schema.length <= 64
    && /^[a-z0-9@/.-]*$/.test(payload.source.schema) && !/[0-9]{13}/.test(payload.source.schema), '$.source.schema');
  need(isLetters(payload.source.captureDigest), '$.source.captureDigest');
  need(typeof payload.source.capturedAt === 'string' && retailCapturedAt(payload.source.capturedAt) !== null, '$.source.capturedAt');
  need(isInteger(payload.source.files, 0, 100_000), '$.source.files');
  need(payload.receipts.length <= RETAIL_MAX_RECEIPTS && payload.held.length <= RETAIL_MAX_RECEIPTS, '$.receipts');
  const membership = payload.membership;
  need(membership.memberSinceYear === null || /^(?:19|20)[0-9]{2}$/.test(membership.memberSinceYear), '$.membership.memberSinceYear');
  need(membership.membershipLast4 === null || /^[0-9]{4}$/.test(membership.membershipLast4), '$.membership.membershipLast4');
  need(membership.tier === null || /^[A-Za-z][A-Za-z +]{0,39}$/.test(membership.tier), '$.membership.tier');
  for (const channel of ['online', 'warehouse'] as const) {
    payload.coverage[channel].forEach((range, index) => {
      const at = `$.coverage.${channel}[${index}]`;
      need(index <= 999 && isRetailDay(range.from) && isRetailDay(range.to) && range.to >= range.from, at);
      need(range.stated === null || isInteger(range.stated, 0, 1_000_000), `${at}.stated`);
      need(isInteger(range.seen, 0, 1_000_000), `${at}.seen`);
    });
  }
  payload.receipts.forEach((receipt, index) => receiptProblems(receipt, `$.receipts[${index}]`, need));
  payload.held.forEach((held, index) => {
    const at = `$.held[${index}]`;
    need(among(held.channel, RETAIL_CHANNELS), `${at}.channel`);
    need(held.naturalKey === null || isKey(held.naturalKey, held.channel === 'online' ? 'costco-order-' : 'costco-receipt-'), `${at}.naturalKey`);
    need(among(held.reason, RETAIL_HOLD_REASONS) && among(held.check, RETAIL_HOLD_CHECK_NAMES)
      && RETAIL_HOLD_CHECKS[held.check] === held.reason && (held.naturalKey === null) === (held.check === 'record-key'), `${at}.check`);
    need(held.date === null || isRetailDay(held.date), `${at}.date`);
  });
  return problems;
}

function receiptProblems(receipt: RetailImportReceipt, at: string, need: (ok: boolean, at: string) => void): void {
  need(among(receipt.channel, RETAIL_CHANNELS), `${at}.channel`);
  need(isKey(receipt.naturalKey, receipt.channel === 'online' ? 'costco-order-' : 'costco-receipt-'), `${at}.naturalKey`);
  need(isRetailDay(receipt.date), `${at}.date`);
  need(receipt.localTime === null || (typeof receipt.localTime === 'string' && (receipt.localTime.length === 5 || receipt.localTime.length === 8)
    && /^[0-2][0-9]:[0-5][0-9]/.test(receipt.localTime)), `${at}.localTime`);
  need(among(receipt.sign, RETAIL_SIGNS), `${at}.sign`);
  need(receipt.status === null || among(receipt.status, RETAIL_ONLINE_STATUSES), `${at}.status`);
  need(receipt.currency === 'USD', `${at}.currency`);
  RETAIL_TOTAL_KEYS.forEach((key) => {
    const value = receipt.totals[key];
    need(key === 'totalMinor' ? isMinor(value) : value === null || isMinor(value), `${at}.totals.${key}`);
  });
  receipt.taxLegends.forEach((legend, index) => {
    need(index <= 19 && retailTextProblem(legend.legend, 40) === null, `${at}.taxLegends[${index}].legend`);
    need(isMinor(legend.amountMinor), `${at}.taxLegends[${index}].amountMinor`);
  });
  need(receipt.lines.length <= RETAIL_MAX_LINES && receipt.tenders.length <= RETAIL_MAX_TENDERS, at);
  receipt.lines.forEach((line, index) => lineProblems(line, `${at}.lines[${index}]`, need));
  receipt.tenders.forEach((tender, index) => {
    const path = `${at}.tenders[${index}]`;
    need(isInteger(tender.ordinal, 0, RETAIL_MAX_TENDERS - 1), `${path}.ordinal`);
    need(among(tender.kind, RETAIL_TENDER_KINDS) && among(tender.network, RETAIL_NETWORKS), `${path}.kind`);
    need((tender.last4 !== null) === RETAIL_CARD_TENDER_KINDS.includes(tender.kind)
      && (tender.last4 === null || /^[0-9]{4}$/.test(tender.last4)), `${path}.last4`);
    need(isMinor(tender.amountMinor), `${path}.amountMinor`);
  });
}

function lineProblems(line: RetailImportLine, at: string, need: (ok: boolean, at: string) => void): void {
  const ordinal = (value: unknown) => isInteger(value, 0, RETAIL_MAX_LINES - 1);
  need(ordinal(line.ordinal), `${at}.ordinal`);
  need(among(line.kind, RETAIL_LINE_KINDS), `${at}.kind`);
  need(line.lineKey === null || isKey(line.lineKey, 'costco-line-'), `${at}.lineKey`);
  need(line.itemNumber === null || /^[0-9]{1,12}$/.test(line.itemNumber), `${at}.itemNumber`);
  need(line.title === null || retailTextProblem(line.title, RETAIL_TITLE_MAX) === null, `${at}.title`);
  need(line.title2 === null || retailTextProblem(line.title2, RETAIL_TITLE_MAX) === null, `${at}.title2`);
  need(line.department === null || isInteger(line.department, 0, 9999), `${at}.department`);
  need(line.quantity === null || isInteger(line.quantity, -100_000, 100_000), `${at}.quantity`);
  need(line.unitPriceMinor === null || isMinor(line.unitPriceMinor), `${at}.unitPriceMinor`);
  need(isMinor(line.amountMinor), `${at}.amountMinor`);
  need(line.shippingMinor === null || isMinor(line.shippingMinor), `${at}.shippingMinor`);
  need(line.taxFlag === null || /^[A-Z0-9]$/.test(line.taxFlag), `${at}.taxFlag`);
  need(line.couponTarget === null || ordinal(line.couponTarget), `${at}.couponTarget`);
  need(line.feeParent === null || ordinal(line.feeParent), `${at}.feeParent`);
  need(line.fulfilment === null || among(line.fulfilment, RETAIL_FULFILMENTS), `${at}.fulfilment`);
  need(line.storedValue === null || among(line.storedValue, RETAIL_STORED_VALUE_KINDS), `${at}.storedValue`);
  need(line.fuelGallons === null || isDecimal(line.fuelGallons, 9), `${at}.fuelGallons`);
  need(line.fuelUnitPrice === null || isDecimal(line.fuelUnitPrice, 8), `${at}.fuelUnitPrice`);
  const metal = line.metal;
  if (metal !== null) {
    need(isSlug(metal.rule, 48) && among(metal.pack, RETAIL_METAL_PACKS), `${at}.metal.rule`);
    need((metal.metal === null || among(metal.metal, RETAIL_METALS)) && (metal.form === null || among(metal.form, RETAIL_METAL_FORMS)),
      `${at}.metal.metal`);
    need(metal.statedWeight === null || (typeof metal.statedWeight.value === 'string' && metal.statedWeight.value.length >= 1
      && metal.statedWeight.value.length <= 16 && /^[0-9][0-9./ ]*$/.test(metal.statedWeight.value)
      && among(metal.statedWeight.unit, RETAIL_WEIGHT_UNITS)), `${at}.metal.statedWeight`);
  }
  const uncertain = line.metalUncertain;
  if (uncertain !== null) {
    need(isSlug(uncertain.guard, 48) && metal === null, `${at}.metalUncertain.guard`);
    need(uncertain.metal === null || among(uncertain.metal, RETAIL_METALS), `${at}.metalUncertain.metal`);
    need(uncertain.evidence.length <= RETAIL_METAL_GUARD_EVIDENCE.length && new Set(uncertain.evidence).size === uncertain.evidence.length
      && uncertain.evidence.every((evidence) => among(evidence, RETAIL_METAL_GUARD_EVIDENCE)), `${at}.metalUncertain.evidence`);
  }
  if (line.events !== null) {
    for (const kind of RETAIL_LINE_EVENT_KINDS) {
      line.events[kind].forEach((event, index) => {
        need(index <= 999 && isInteger(event.quantity, 1, 100_000) && isRetailDay(event.date), `${at}.events.${kind}[${index}]`);
      });
    }
  }
  line.shipments.forEach((shipment, index) => {
    need(index <= 19 && [shipment.shippedDate, shipment.deliveredDate, shipment.estimatedArrivalDate]
      .every((date) => date === null || isRetailDay(date))
      && (shipment.carrier === null || among(shipment.carrier, RETAIL_CARRIERS)), `${at}.shipments[${index}]`);
  });
  need(line.shipments.length <= 20, `${at}.shipments`);
}

/** The digests' tags, pinned by the tests (a changed tag is a changed policy digest). */
export const RETAIL_VERSION_TAGS = Object.freeze({ SOURCE_TAG, MEANING_TAG, PROVENANCE_TAG, SHIPMENT_TAG, TENDER_TAG });
