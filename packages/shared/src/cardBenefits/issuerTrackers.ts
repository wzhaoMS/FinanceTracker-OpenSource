import { containsCardData } from '../cardNumbers.js';
import { containsCardSecret } from '../cardSecrets.js';
import { normalizeCardText } from '../cardText.js';
import { isBenefitDate } from './dates.js';
import type { BenefitIssuer } from './types.js';

/**
 * Issuer-reported benefit trackers (contract v1, agreed with the extension's
 * capture work): what an issuer's own benefits page says about one benefit
 * of one card for one period. Holdr stores the latest observation per card,
 * tracker and period; when present it overrides the figure Holdr derives
 * from transactions, and the page says which source a figure came from.
 *
 * The capture's receiver resolves the card through the confirmed card-sync
 * binding, so no source identifier reaches storage. Unknown is null, never
 * zero. A tracker maps to a catalog benefit only through the catalog's
 * explicit `issuerTrackerIds`, never by its name.
 */
export const ISSUER_TRACKER_CONTRACT_VERSION = 1;

/** An issuer figure observed longer ago than this is shown as stale. */
export const ISSUER_TRACKER_STALE_DAYS = 7;

/** At most this many trackers per card in one call. */
export const MAX_ISSUER_TRACKERS_PER_CALL = 200;

/** Larger than any benefit, in cents or as a count. */
export const MAX_ISSUER_TRACKER_AMOUNT = 99_999_999;

export const ISSUER_TRACKER_ISSUERS: readonly BenefitIssuer[] = ['amex', 'chase', 'citi'];
export const ISSUER_TRACKER_ENROLLMENTS = ['enrolled', 'not-enrolled', 'not-required', 'unknown'] as const;
export type IssuerTrackerEnrollment = (typeof ISSUER_TRACKER_ENROLLMENTS)[number];

export interface IssuerBenefitTrackerSnapshot {
  issuer: BenefitIssuer;
  /** The issuer's own id for the tracker. */
  issuerBenefitId: string;
  /** The issuer's display name, as safe text. */
  name: string;
  /** Inclusive. */
  periodStart: string;
  /** Inclusive, on or after periodStart. */
  periodEnd: string;
  unit: 'money' | 'count';
  /** ISO 4217 for money; null for counts. */
  currency: string | null;
  /** Minor units for money, plain integers for counts; null when the issuer does not say. */
  usedMinor: number | null;
  totalMinor: number | null;
  resetDate: string | null;
  enrollment: IssuerTrackerEnrollment;
  /** ISO-8601 UTC timestamp of the observation. */
  observedAt: string;
}

/** A stored observation. */
export interface IssuerBenefitTrackerRecord extends IssuerBenefitTrackerSnapshot {
  cardAccountId: string;
  recordedAt: string;
}

export type IssuerTrackerIssueCode =
  | 'not-a-list' | 'too-many' | 'not-an-object' | 'missing' | 'unexpected-key' | 'type' | 'format' | 'range' | 'card-data'
  | 'future' | 'duplicate';

/** A refusal names a path and a code, never a value. */
export interface IssuerTrackerIssue {
  path: string;
  code: IssuerTrackerIssueCode;
}

const KEYS = [
  'issuer', 'issuerBenefitId', 'name', 'periodStart', 'periodEnd', 'unit', 'currency', 'usedMinor', 'totalMinor', 'resetDate',
  'enrollment', 'observedAt',
] as const;
const KEY_SET = new Set<string>(KEYS);

/** Issuer-native ids. No run of five digits, so nothing account-like is ever kept as an id. */
const ISSUER_BENEFIT_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const DIGIT_RUN = /[0-9]{5}/;
/** Fewer than any card number has (13 or more), however they are grouped. */
export const MAX_TEXT_DIGITS = 12;
const digitCount = (text: string) => (text.match(/[0-9]/g) ?? []).length;
const CURRENCY = /^[A-Z]{3}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const CONTROL = /\p{Cc}/u;
/** A future observation is refused; this much clock skew is tolerated. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

/** Safe display text: canonical card text, single spaces, few digits and no run of them, no card data or secret. */
export function isSafeIssuerTrackerName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1 && value.length <= 80
    && value === normalizeCardText(value)
    && value === value.replace(/\s+/g, ' ').trim()
    && !CONTROL.test(value)
    && !DIGIT_RUN.test(value)
    && digitCount(value) <= MAX_TEXT_DIGITS
    && !containsCardData(value)
    && !containsCardSecret(value);
}

/**
 * An issuer-native id: its own grammar, no run of five digits, fewer digits
 * in all than any card number has (so no grouping can carry one), and
 * nothing the card data or secret detectors flag.
 */
export function isIssuerBenefitId(value: unknown): value is string {
  return typeof value === 'string' && ISSUER_BENEFIT_ID.test(value) && !DIGIT_RUN.test(value) && !looksLikeCardData(value);
}

/** Card data or a secret by the detectors, or more digits in all than an id or a name may have. */
function looksLikeCardData(text: string): boolean {
  return digitCount(normalizeCardText(text)) > MAX_TEXT_DIGITS || containsCardData(text) || containsCardSecret(text);
}

function isAmount(value: unknown): boolean {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_ISSUER_TRACKER_AMOUNT);
}

/**
 * Checks a list of snapshots, all or nothing: either every snapshot is
 * well-formed (then they are returned as typed), or the issues name the
 * paths and what is wrong with them.
 */
export function validateIssuerBenefitTrackerSnapshots(
  value: unknown,
  now: Date,
): { ok: true; snapshots: IssuerBenefitTrackerSnapshot[] } | { ok: false; issues: IssuerTrackerIssue[] } {
  const issues: IssuerTrackerIssue[] = [];
  if (!Array.isArray(value)) return { ok: false, issues: [{ path: '$', code: 'not-a-list' }] };
  if (value.length > MAX_ISSUER_TRACKERS_PER_CALL) return { ok: false, issues: [{ path: '$', code: 'too-many' }] };
  const seen = new Set<string>();
  value.forEach((entry: unknown, index) => {
    const at = `$[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      issues.push({ path: at, code: 'not-an-object' });
      return;
    }
    const record = entry as Record<string, unknown>;
    const issue = (key: string, code: IssuerTrackerIssueCode) => issues.push({ path: `${at}.${key}`, code });
    if (Object.keys(record).some((key) => !KEY_SET.has(key))) issues.push({ path: at, code: 'unexpected-key' });
    for (const key of KEYS) if (!(key in record)) issue(key, 'missing');
    if (!ISSUER_TRACKER_ISSUERS.includes(record.issuer as BenefitIssuer)) issue('issuer', 'format');
    if (typeof record.issuerBenefitId !== 'string') issue('issuerBenefitId', 'type');
    else if (looksLikeCardData(record.issuerBenefitId)) issue('issuerBenefitId', 'card-data');
    else if (!isIssuerBenefitId(record.issuerBenefitId)) issue('issuerBenefitId', 'format');
    if (typeof record.name !== 'string') issue('name', 'type');
    else if (looksLikeCardData(record.name) || DIGIT_RUN.test(normalizeCardText(record.name))) issue('name', 'card-data');
    else if (!isSafeIssuerTrackerName(record.name)) issue('name', 'format');
    for (const key of ['periodStart', 'periodEnd'] as const) if (!isBenefitDate(record[key])) issue(key, 'format');
    if (isBenefitDate(record.periodStart) && isBenefitDate(record.periodEnd) && record.periodEnd < record.periodStart) {
      issue('periodEnd', 'range');
    }
    if (record.unit !== 'money' && record.unit !== 'count') issue('unit', 'format');
    if (record.unit === 'money' && !(typeof record.currency === 'string' && CURRENCY.test(record.currency))) issue('currency', 'format');
    if (record.unit === 'count' && record.currency !== null) issue('currency', 'format');
    for (const key of ['usedMinor', 'totalMinor'] as const) if (!isAmount(record[key])) issue(key, 'range');
    if (record.resetDate !== null && !isBenefitDate(record.resetDate)) issue('resetDate', 'format');
    if (!ISSUER_TRACKER_ENROLLMENTS.includes(record.enrollment as IssuerTrackerEnrollment)) issue('enrollment', 'format');
    const observed = typeof record.observedAt === 'string' && TIMESTAMP.test(record.observedAt) ? Date.parse(record.observedAt) : Number.NaN;
    if (Number.isNaN(observed) || new Date(observed).toISOString().slice(0, 19) !== String(record.observedAt).slice(0, 19)) {
      issue('observedAt', 'format');
    } else if (observed > now.getTime() + FUTURE_TOLERANCE_MS) issue('observedAt', 'future');
    const key = JSON.stringify([record.issuerBenefitId, record.periodStart, record.periodEnd]);
    if (seen.has(key)) issues.push({ path: at, code: 'duplicate' });
    seen.add(key);
  });
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, snapshots: value as IssuerBenefitTrackerSnapshot[] };
}
