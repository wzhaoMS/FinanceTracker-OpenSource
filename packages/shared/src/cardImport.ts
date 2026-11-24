/**
 * The redacted card-import payload (`holdr.card-import`, version 1): the only
 * shape Holdr's `/card-imports` API accepts. Raw issuer exports never reach
 * Holdr; a producer (today the offline CLI in `cardImportTool/`, later perhaps
 * a browser extension) turns them into this payload with
 * `buildCardImportPayload`, and the API re-checks everything with
 * `findCardImportSensitivePaths` and `validateCardImportPayload`.
 *
 * Nothing here assumes a file: `source` is an open slug, rows may be pending
 * or posted, and `coverage` says which dates the payload speaks for.
 *
 * Every function is pure and deterministic (no clock, locale, randomness or
 * platform APIs), so two computers turn the same export into byte-identical
 * payloads. Error messages and issue paths name fields, never values.
 */
import { assignCardDedupeKeys, cardExternalIdHash, isCardExternalIdHash, isCardFingerprint } from './cardDedupe.js';
import { containsCardData, findCardNumberPaths, isCardSecretField, redactCardNumbers } from './cardNumbers.js';
import { containsCardSecret } from './cardSecrets.js';
import { containsLongDigitRun, LONG_DIGIT_RUN, normalizeCardText } from './cardText.js';
import type { CardOwner, CardTransactionKind } from './types.js';

export const CARD_IMPORT_FORMAT = 'holdr.card-import';
export const CARD_IMPORT_VERSION = 1;
/** Rows plus rejected rows per payload; matches the repository's per-import limit. */
export const CARD_IMPORT_MAX_ROWS = 10_000;
/** Largest single amount, in minor units (99,999,999.99 for a two-decimal currency). */
export const CARD_IMPORT_MAX_AMOUNT_MINOR = 9_999_999_999;
/** Totals and statement figures stay below 10^11, which card-number path scans treat as identifiers. */
export const CARD_IMPORT_MAX_TOTAL_MINOR = 99_999_999_999;
export const CARD_IMPORT_MAX_CARDS = 20;
export const CARD_IMPORT_TEXT_LIMITS = { description: 500, merchant: 200, issuerCategory: 100 } as const;
export const CARD_IMPORT_KINDS: readonly CardTransactionKind[] = [
  'purchase', 'refund', 'payment', 'fee', 'interest', 'adjustment', 'other',
];
/** Stored when an export row has no usable description. */
export const CARD_IMPORT_NO_DESCRIPTION = '(no description)';

export type CardImportRowStatus = 'pending' | 'posted';

export interface CardImportPayloadRow {
  /** YYYY-MM-DD, the issuer's transaction (or only) date. */
  transactionDate: string;
  postedDate: string | null;
  status: CardImportRowStatus;
  /** Integer minor units: positive = money spent, negative = refund, payment or credit. */
  amountMinor: number;
  kind: CardTransactionKind;
  /** Redacted by `sanitizeCardText`. */
  description: string;
  merchant: string | null;
  issuerCategory: string | null;
  /** `cardExternalIdHash` of an allowlisted issuer reference. Exactly one of the two keys is set. */
  externalIdHash: string | null;
  /** `cardTransactionFingerprint` for rows without a reference, as assigned by `assignCardDedupeKeys`. */
  fingerprint: string | null;
}

export interface CardImportKindTotal {
  count: number;
  amountMinor: number;
}

export interface CardImportSummary {
  count: number;
  /** Sum of positive amounts (purchases, fees, interest, positive adjustments). */
  chargesMinor: number;
  /** Sum of negative amounts (payments, refunds, credits); zero or negative. */
  creditsMinor: number;
  netMinor: number;
  byKind: Record<CardTransactionKind, CardImportKindTotal>;
}

export interface CardImportTotals {
  posted: CardImportSummary;
  pending: CardImportSummary;
}

/** Figures copied from the issuer's statement, checked against the posted rows. Balances are owed-positive. */
export interface CardImportStatement {
  chargesMinor: number | null;
  creditsMinor: number | null;
  netMinor: number | null;
  previousBalanceMinor: number | null;
  newBalanceMinor: number | null;
}

export interface CardImportCoverage {
  /** Inclusive YYYY-MM-DD bounds on each row's posted date (transaction date when there is none). */
  start: string;
  end: string;
}

export interface CardImportPayload {
  format: typeof CARD_IMPORT_FORMAT;
  version: typeof CARD_IMPORT_VERSION;
  /** Open slug for the producer and export format, e.g. `amex-csv`, `ofx`. */
  source: string;
  parserVersion: string;
  /** Lowercase issuer slug; must match the target card account. */
  issuer: string;
  currency: string;
  /** Hint only: whose card(s) the rows came from, mapped by the producer; never a name. */
  owner: CardOwner | null;
  /** Hint only: sorted last-4 digits of the cards seen in the export. */
  cards: string[];
  coverage: CardImportCoverage;
  /** Rows the producer dropped as invalid; counted, never sent. */
  rejectedCount: number;
  statement: CardImportStatement | null;
  totals: CardImportTotals;
  rows: CardImportPayloadRow[];
}

export interface CardImportIssue {
  /** JSONPath-like location such as `$.rows[3].amountMinor`. */
  path: string;
  message: string;
}

export class CardImportError extends Error {
  readonly issues: CardImportIssue[];
  constructor(message: string, issues: CardImportIssue[] = []) {
    super(message);
    this.name = 'CardImportError';
    this.issues = issues;
  }
}

const CARD_SLUG = /^[a-z][a-z0-9-]{0,31}$/;
const PARSER_VERSION = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/;
const CURRENCY = /^[A-Z]{3}$/;
const LAST4 = /^[0-9]{4}$/;
const OWNERS: ReadonlySet<string> = new Set<CardOwner>(['alex', 'casey', 'joint']);
const KINDS: ReadonlySet<string> = new Set(CARD_IMPORT_KINDS);
const STATUSES: ReadonlySet<string> = new Set<CardImportRowStatus>(['pending', 'posted']);
const MIN_DATE = '1970-01-01';
const MAX_DATE = '2099-12-31';
const MAX_ISSUES = 20;
/**
 * Largest raw text value (UTF-16 units) accepted for redaction, far above any
 * real description. Longer input is refused, never cut: cutting unredacted
 * text can leave a card number's prefix that no check recognizes.
 */
export const CARD_IMPORT_MAX_RAW_TEXT = 65_536;
const RAW_TEXT_TOO_LONG = `is longer than ${CARD_IMPORT_MAX_RAW_TEXT} characters before redaction; refused, never truncated`;

const PAYLOAD_KEYS = [
  'format', 'version', 'source', 'parserVersion', 'issuer', 'currency', 'owner', 'cards', 'coverage',
  'rejectedCount', 'statement', 'totals', 'rows',
] as const;
const ROW_KEYS = [
  'transactionDate', 'postedDate', 'status', 'amountMinor', 'kind', 'description', 'merchant', 'issuerCategory',
  'externalIdHash', 'fingerprint',
] as const;
const COVERAGE_KEYS = ['start', 'end'] as const;
const STATEMENT_KEYS = ['chargesMinor', 'creditsMinor', 'netMinor', 'previousBalanceMinor', 'newBalanceMinor'] as const;
const SUMMARY_KEYS = ['count', 'chargesMinor', 'creditsMinor', 'netMinor', 'byKind'] as const;
const KIND_TOTAL_KEYS = ['count', 'amountMinor'] as const;
const KNOWN_KEYS: ReadonlySet<string> = new Set<string>([
  ...PAYLOAD_KEYS, ...ROW_KEYS, ...COVERAGE_KEYS, ...STATEMENT_KEYS, ...SUMMARY_KEYS, ...KIND_TOTAL_KEYS,
  ...CARD_IMPORT_KINDS, 'posted', 'pending',
]);

// ---------------------------------------------------------------------------
// Free text
// ---------------------------------------------------------------------------

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const CONTROL_ALL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const LONE_SURROGATE_ALL = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const SPACING = /[^\S ]| {2}/;
// Spreadsheet formula triggers; a leading apostrophe keeps a later CSV export inert.
const FORMULA_START = /^[=+\-@]/;
const LONG_RUN_ALL = new RegExp(`\\p{Nd}{${LONG_DIGIT_RUN},}`, 'gu');

/**
 * `normalizeCardText` (NFKC, invisible characters removed, ASCII digits) is
 * the form the repository stores and its guards check, so payload text is
 * stored unchanged and fingerprints canonicalize it the same way on both
 * sides. Control characters become spaces, then whitespace runs collapse.
 */
function tidy(text: string): string {
  return normalizeCardText(text.replace(LONE_SURROGATE_ALL, '\ufffd'))
    .replace(CONTROL_ALL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Text in the form card import redacts and stores it from (before any
 * redaction): `normalizeCardText`, unpaired surrogates replaced, control
 * characters as spaces, single spaces, trimmed.
 */
export function normalizeCardImportText(text: string): string {
  return tidy(text);
}

function collapseLongDigitRuns(text: string): string {
  return text.replace(LONG_RUN_ALL, (run) => `***${run.slice(-4)}`);
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let end = maxLength;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end).trimEnd();
}

function neutralizeFormula(text: string, maxLength: number): string {
  return FORMULA_START.test(text) ? truncate(`'${text}`, maxLength) : text;
}

const CARD_SECRET_PROBLEM = 'must not contain a card security code, PIN or expiry date';

/** Why a text value may not be stored, or null when it is acceptable. Never mentions the value. */
export function cardImportTextProblem(text: string, maxLength: number): string | null {
  if (typeof text !== 'string') return 'must be a string';
  if (text.length === 0) return 'must not be empty';
  if (text.length > maxLength) return `must be at most ${maxLength} characters`;
  if (CONTROL.test(text) || LONE_SURROGATE.test(text)) return 'must not contain control or unpaired characters';
  if (text !== text.trim() || SPACING.test(text)) return 'must use single spaces and no surrounding whitespace';
  if (normalizeCardText(text) !== text) {
    return 'must be stored card text (NFKC, no invisible characters, ASCII digits; see normalizeCardText)';
  }
  if (FORMULA_START.test(text)) return 'must not start with =, +, - or @';
  if (containsCardData(text) || containsLongDigitRun(text)) {
    return `must not contain a card number or ${LONG_DIGIT_RUN} or more consecutive digits`;
  }
  if (containsCardSecret(text)) return CARD_SECRET_PROBLEM;
  return null;
}

function cleanOnce(text: string, maxLength: number): string {
  const redacted = redactCardNumbers(tidy(text));
  return neutralizeFormula(truncate(tidy(collapseLongDigitRuns(redacted)), maxLength), maxLength);
}

/**
 * Free text as Holdr stores it: `normalizeCardText` form (NFKC, invisible
 * characters removed, ASCII digits), control characters and unpaired
 * surrogates replaced, single spaces, card numbers and masked identifiers
 * that reveal more than the last four digits replaced by `***1234` (the
 * shared recognizer in cardNumbers), every run of 13 or more digits collapsed
 * to `***` + its last four, a leading formula character neutralized with `'`,
 * and at most `maxLength` UTF-16 units. Returns null for empty text.
 *
 * The complete input is normalized and redacted before anything is cut: the
 * length limit applies only to redacted text, which is then scanned again.
 * Input longer than CARD_IMPORT_MAX_RAW_TEXT throws instead of being cut.
 *
 * Redaction is the only transformation here: callers must still check
 * `cardImportTextProblem` (and `containsCardSecret`), because card secrets
 * are refused rather than redacted, and anything detection still flags must
 * be refused too. `buildCardImportPayload` does both.
 */
export function sanitizeCardText(raw: string, maxLength: number): string | null {
  if (typeof raw !== 'string') throw new Error('card text must be a string');
  if (!Number.isSafeInteger(maxLength) || maxLength < 8) throw new Error('card text maxLength must be at least 8');
  if (raw.length > CARD_IMPORT_MAX_RAW_TEXT) throw new CardImportError(`card text ${RAW_TEXT_TOO_LONG}`);
  let text = raw;
  // Each pass redacts the whole text, then cuts it to maxLength; normalization, whitespace changes
  // and the cut can regroup digits, so repeat until nothing changes.
  for (let pass = 0; pass < 6; pass += 1) {
    const next = cleanOnce(text, maxLength);
    if (next === text) break;
    text = next;
  }
  return text === '' ? null : text;
}

// ---------------------------------------------------------------------------
// Totals and reconciliation
// ---------------------------------------------------------------------------

function emptySummary(): CardImportSummary {
  const byKind = {} as Record<CardTransactionKind, CardImportKindTotal>;
  for (const kind of CARD_IMPORT_KINDS) byKind[kind] = { count: 0, amountMinor: 0 };
  return { count: 0, chargesMinor: 0, creditsMinor: 0, netMinor: 0, byKind };
}

/** Totals of posted and pending rows. Statements only ever show posted rows. */
export function summarizeCardImportRows(
  rows: ReadonlyArray<Pick<CardImportPayloadRow, 'status' | 'amountMinor' | 'kind'>>,
): CardImportTotals {
  const totals: CardImportTotals = { posted: emptySummary(), pending: emptySummary() };
  for (const row of rows) {
    const summary = row.status === 'pending' ? totals.pending : totals.posted;
    summary.count += 1;
    if (row.amountMinor > 0) summary.chargesMinor += row.amountMinor;
    if (row.amountMinor < 0) summary.creditsMinor += row.amountMinor;
    summary.netMinor += row.amountMinor;
    summary.byKind[row.kind].count += 1;
    summary.byKind[row.kind].amountMinor += row.amountMinor;
  }
  // A zero sum of negatives is written as 0, never -0.
  for (const summary of [totals.posted, totals.pending]) summary.creditsMinor += 0;
  return totals;
}

export type CardReconciliationStatus = 'unchecked' | 'match' | 'mismatch';

export interface CardReconciliationCheck {
  check: 'charges' | 'credits' | 'net' | 'balance';
  expectedMinor: number;
  /** For `balance`: previous balance + net of the posted rows. */
  actualMinor: number;
  differenceMinor: number;
  ok: boolean;
}

export interface CardImportReconciliation {
  status: CardReconciliationStatus;
  checks: CardReconciliationCheck[];
}

/** Compares statement figures with the posted rows. With no figures the status is `unchecked`. */
export function reconcileCardImport(
  posted: CardImportSummary,
  statement: CardImportStatement | null,
): CardImportReconciliation {
  const checks: CardReconciliationCheck[] = [];
  const add = (check: CardReconciliationCheck['check'], expectedMinor: number, actualMinor: number) => {
    checks.push({ check, expectedMinor, actualMinor, differenceMinor: actualMinor - expectedMinor, ok: actualMinor === expectedMinor });
  };
  if (statement) {
    if (statement.chargesMinor !== null) add('charges', statement.chargesMinor, posted.chargesMinor);
    if (statement.creditsMinor !== null) add('credits', statement.creditsMinor, posted.creditsMinor);
    if (statement.netMinor !== null) add('net', statement.netMinor, posted.netMinor);
    if (statement.previousBalanceMinor !== null && statement.newBalanceMinor !== null) {
      add('balance', statement.newBalanceMinor, statement.previousBalanceMinor + posted.netMinor);
    }
  }
  const status: CardReconciliationStatus = checks.length === 0
    ? 'unchecked'
    : checks.every((check) => check.ok) ? 'match' : 'mismatch';
  return { status, checks };
}

// ---------------------------------------------------------------------------
// Card-data scan (runs before validation, so it must accept any JSON value)
// ---------------------------------------------------------------------------

const SCAN_LIMITS = { paths: 50, depth: 32, nodes: 50_000 };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function safeKey(key: string, known: ReadonlySet<string>): string {
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) && known.has(key) ? key : '<key>';
}

function secretEntry(key: string, child: unknown): boolean {
  if (typeof child !== 'string' && typeof child !== 'number') return false;
  if (isCardSecretField(key) && String(child).trim() !== '') return true;
  return containsCardSecret(`${key}: ${String(child)}`);
}

/**
 * What card-number detection alone does not report: 13+ digit runs, and card
 * secrets (security code, PIN, expiry) in strings, keys, or a key and its
 * value together, as in {"cvv": "NNN"} (NNN = the digits).
 */
function textPaths(value: unknown, known: ReadonlySet<string>): string[] {
  const paths: string[] = [];
  let nodes = 0;
  let exceeded = false;
  const seen = new Set<object>();
  const visit = (node: unknown, at: string, depth: number): void => {
    if (exceeded || paths.length >= SCAN_LIMITS.paths) return;
    nodes += 1;
    if (nodes > SCAN_LIMITS.nodes || depth > SCAN_LIMITS.depth) {
      exceeded = true;
      return;
    }
    if (typeof node === 'string') {
      if (containsLongDigitRun(node) || containsCardSecret(node)) paths.push(at);
    } else if (node && typeof node === 'object') {
      if (seen.has(node)) {
        exceeded = true;
        return;
      }
      seen.add(node);
      if (Array.isArray(node)) {
        for (let index = 0; index < node.length && !exceeded; index += 1) visit(node[index], `${at}[${index}]`, depth + 1);
        return;
      }
      for (const [key, child] of Object.entries(node)) {
        if (exceeded || paths.length >= SCAN_LIMITS.paths) return;
        if (containsLongDigitRun(key) || containsCardSecret(key)) paths.push(`${at}.<key>`);
        else if (secretEntry(key, child)) paths.push(`${at}.${safeKey(key, known)}`);
        visit(child, `${at}.${safeKey(key, known)}`, depth + 1);
      }
    }
  };
  visit(value, '$', 0);
  if (exceeded) paths.push('$<limit>');
  return paths;
}

function scanPaths(value: unknown, known: ReadonlySet<string>): string[] {
  const card = findCardNumberPaths(value).map((path) =>
    path.replace(/\.([A-Za-z_][A-Za-z0-9_]*)/g, (segment, key: string) => (known.has(key) ? segment : '.<key>')));
  return [...card, ...textPaths(value, known)];
}

/**
 * Paths (never values) of card data in an untrusted payload: card numbers or
 * revealing masks in any string, number or key (`findCardNumberPaths`), 13+
 * digit runs, and card security codes, PINs and expiry dates
 * (`containsCardSecret`) in strings, keys or key/value pairs. Rows are scanned one at
 * a time so a large payload stays within the per-scan limits; anything too
 * deep, cyclic or large is reported as `…<limit>` and must be rejected. Keys
 * that are not part of the payload schema (or `extraKeys`) are shown as `<key>`.
 */
export function findCardImportSensitivePaths(value: unknown, extraKeys?: Iterable<string>): string[] {
  const known = extraKeys ? new Set([...KNOWN_KEYS, ...extraKeys]) : KNOWN_KEYS;
  const found: string[] = [];
  const add = (prefix: string, paths: string[]) => {
    for (const path of paths) found.push(`${prefix}${path.slice(1)}`);
  };
  if (isPlainObject(value) && Array.isArray(value.rows)) {
    const rest: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'rows') Object.defineProperty(rest, key, { value: child, enumerable: true });
    }
    add('$', scanPaths(rest, known));
    const rows = value.rows as unknown[];
    for (let index = 0; index < rows.length && found.length < SCAN_LIMITS.paths; index += 1) {
      add(`$.rows[${index}]`, scanPaths(rows[index], known));
    }
  } else {
    add('$', scanPaths(value, known));
  }
  return [...new Set(found)].slice(0, SCAN_LIMITS.paths);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** YYYY-MM-DD between 1970 and 2099 that exists on the calendar. */
export function isCardImportDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  if (value < MIN_DATE || value > MAX_DATE) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= days;
}

/** The date a row counts under for coverage and statements: posted date, else transaction date. */
export function cardImportEffectiveDate(row: Pick<CardImportPayloadRow, 'transactionDate' | 'postedDate'>): string {
  return row.postedDate ?? row.transactionDate;
}

function isInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

class IssueList {
  readonly list: CardImportIssue[] = [];
  add(path: string, message: string): void {
    if (this.list.length < MAX_ISSUES) this.list.push({ path, message });
  }
  get full(): boolean {
    return this.list.length >= MAX_ISSUES;
  }
}

/** Checks an object has exactly `keys`; reports unexpected keys without naming them. */
function checkKeys(value: unknown, path: string, keys: readonly string[], issues: IssueList): value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    issues.add(path, 'must be an object');
    return false;
  }
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) issues.add(path, 'has an unexpected key');
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) issues.add(`${path}.${key}`, 'is required');
  }
  return true;
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function checkText(value: unknown, path: string, maxLength: number, nullable: boolean, issues: IssueList): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string') {
    issues.add(path, nullable ? 'must be a string or null' : 'must be a string');
    return null;
  }
  const problem = cardImportTextProblem(value, maxLength);
  if (problem) {
    issues.add(path, problem);
    return null;
  }
  return value;
}

function checkSummary(value: unknown, expected: CardImportSummary, path: string, issues: IssueList): void {
  if (!checkKeys(value, path, SUMMARY_KEYS, issues)) return;
  for (const key of ['count', 'chargesMinor', 'creditsMinor', 'netMinor'] as const) {
    if (own(value, key) !== expected[key]) issues.add(`${path}.${key}`, 'does not match the rows');
  }
  const byKind = own(value, 'byKind');
  if (!checkKeys(byKind, `${path}.byKind`, CARD_IMPORT_KINDS, issues)) return;
  for (const kind of CARD_IMPORT_KINDS) {
    const total = own(byKind, kind);
    if (!checkKeys(total, `${path}.byKind.${kind}`, KIND_TOTAL_KEYS, issues)) continue;
    for (const key of KIND_TOTAL_KEYS) {
      if (own(total, key) !== expected.byKind[kind][key]) issues.add(`${path}.byKind.${kind}.${key}`, 'does not match the rows');
    }
  }
}

function checkStatement(value: unknown, issues: IssueList): CardImportStatement | null {
  if (value === null) return null;
  if (!checkKeys(value, '$.statement', STATEMENT_KEYS, issues)) return null;
  const statement = {} as CardImportStatement;
  for (const key of STATEMENT_KEYS) {
    const figure = own(value, key);
    if (figure === null || figure === undefined) {
      statement[key] = null;
    } else if (!isInteger(figure, -CARD_IMPORT_MAX_TOTAL_MINOR, CARD_IMPORT_MAX_TOTAL_MINOR)) {
      issues.add(`$.statement.${key}`, `must be null or whole minor units of at most ${CARD_IMPORT_MAX_TOTAL_MINOR}`);
      statement[key] = null;
    } else {
      statement[key] = figure + 0;
    }
  }
  if (statement.chargesMinor !== null && statement.chargesMinor < 0) issues.add('$.statement.chargesMinor', 'must not be negative');
  if (statement.creditsMinor !== null && statement.creditsMinor > 0) issues.add('$.statement.creditsMinor', 'must not be positive');
  if ((statement.previousBalanceMinor === null) !== (statement.newBalanceMinor === null)) {
    issues.add('$.statement', 'previousBalanceMinor and newBalanceMinor must be given together');
  }
  if (STATEMENT_KEYS.every((key) => statement[key] === null)) issues.add('$.statement', 'must be null when it has no figures');
  return statement;
}

function checkRow(value: unknown, at: string, issues: IssueList): CardImportPayloadRow | null {
  if (!checkKeys(value, at, ROW_KEYS, issues)) return null;
  const before = issues.list.length;
  const transactionDate = own(value, 'transactionDate');
  if (!isCardImportDate(transactionDate)) issues.add(`${at}.transactionDate`, 'must be a valid YYYY-MM-DD date');
  const postedDate = own(value, 'postedDate');
  if (postedDate !== null && !isCardImportDate(postedDate)) issues.add(`${at}.postedDate`, 'must be null or a valid YYYY-MM-DD date');
  const status = own(value, 'status');
  if (typeof status !== 'string' || !STATUSES.has(status)) issues.add(`${at}.status`, 'must be pending or posted');
  const amountMinor = own(value, 'amountMinor');
  if (!isInteger(amountMinor, -CARD_IMPORT_MAX_AMOUNT_MINOR, CARD_IMPORT_MAX_AMOUNT_MINOR)) {
    issues.add(`${at}.amountMinor`, `must be whole minor units of at most ${CARD_IMPORT_MAX_AMOUNT_MINOR}`);
  }
  const kind = own(value, 'kind');
  if (typeof kind !== 'string' || !KINDS.has(kind)) issues.add(`${at}.kind`, `must be one of ${CARD_IMPORT_KINDS.join(', ')}`);
  const description = checkText(own(value, 'description'), `${at}.description`, CARD_IMPORT_TEXT_LIMITS.description, false, issues);
  const merchant = checkText(own(value, 'merchant'), `${at}.merchant`, CARD_IMPORT_TEXT_LIMITS.merchant, true, issues);
  const issuerCategory = checkText(
    own(value, 'issuerCategory'), `${at}.issuerCategory`, CARD_IMPORT_TEXT_LIMITS.issuerCategory, true, issues,
  );
  const externalIdHash = own(value, 'externalIdHash');
  if (externalIdHash !== null && !isCardExternalIdHash(externalIdHash)) {
    issues.add(`${at}.externalIdHash`, 'must be null or a version 1 card external id hash');
  }
  const fingerprint = own(value, 'fingerprint');
  if (fingerprint !== null && !isCardFingerprint(fingerprint)) {
    issues.add(`${at}.fingerprint`, 'must be null or a version 1 card fingerprint');
  }
  if ((externalIdHash === null) === (fingerprint === null)) {
    issues.add(at, 'must have exactly one of externalIdHash and fingerprint');
  }
  if (issues.list.length !== before || issues.full) return null;
  return {
    transactionDate: transactionDate as string,
    postedDate: postedDate as string | null,
    status: status as CardImportRowStatus,
    amountMinor: (amountMinor as number) + 0,
    kind: kind as CardTransactionKind,
    description: description as string,
    merchant,
    issuerCategory,
    externalIdHash: externalIdHash as string | null,
    fingerprint: fingerprint as string | null,
  };
}

export type CardImportValidation =
  | { ok: true; payload: CardImportPayload }
  | { ok: false; issues: CardImportIssue[] };

/**
 * Strict check of an untrusted payload: exact keys, types, lengths, safe
 * text, row limits, dedupe keys recomputed with `assignCardDedupeKeys`,
 * coverage and totals recomputed from the rows. Run
 * `findCardImportSensitivePaths` first: issues name paths, never values, and
 * never repeat keys that are not part of the schema. On success the payload
 * is a fresh object with the canonical key order.
 */
export function validateCardImportPayload(value: unknown): CardImportValidation {
  const issues = new IssueList();
  if (!checkKeys(value, '$', PAYLOAD_KEYS, issues)) return { ok: false, issues: issues.list };
  // Another format or version is not worth checking field by field.
  const formatOk = own(value, 'format') === CARD_IMPORT_FORMAT;
  const versionOk = own(value, 'version') === CARD_IMPORT_VERSION;
  if (!formatOk) issues.add('$.format', `must be ${CARD_IMPORT_FORMAT}`);
  if (!versionOk) issues.add('$.version', `must be ${CARD_IMPORT_VERSION}`);
  if (!formatOk || !versionOk) return { ok: false, issues: issues.list };

  const source = own(value, 'source');
  if (typeof source !== 'string' || !CARD_SLUG.test(source)) issues.add('$.source', 'must be a lowercase slug of at most 32 characters');
  const parserVersion = own(value, 'parserVersion');
  if (typeof parserVersion !== 'string' || !PARSER_VERSION.test(parserVersion)) {
    issues.add('$.parserVersion', 'must be 1 to 64 letters, digits or ._@+-');
  }
  const issuer = own(value, 'issuer');
  if (typeof issuer !== 'string' || !CARD_SLUG.test(issuer)) issues.add('$.issuer', 'must be a lowercase slug of at most 32 characters');
  const currency = own(value, 'currency');
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) issues.add('$.currency', 'must be a three-letter uppercase code');
  const owner = own(value, 'owner');
  if (owner !== null && (typeof owner !== 'string' || !OWNERS.has(owner))) issues.add('$.owner', 'must be null, alex, casey or joint');

  const cards = own(value, 'cards');
  if (!Array.isArray(cards) || cards.length > CARD_IMPORT_MAX_CARDS) {
    issues.add('$.cards', `must be an array of at most ${CARD_IMPORT_MAX_CARDS} last-4 values`);
  } else {
    cards.forEach((card, index) => {
      if (typeof card !== 'string' || !LAST4.test(card)) issues.add(`$.cards[${index}]`, 'must be exactly four digits');
      else if (index > 0 && !(String(cards[index - 1]) < card)) issues.add(`$.cards[${index}]`, 'must be sorted and unique');
    });
  }

  const coverage = own(value, 'coverage');
  let coverageOk = false;
  if (checkKeys(coverage, '$.coverage', COVERAGE_KEYS, issues)) {
    const start = own(coverage, 'start');
    const end = own(coverage, 'end');
    if (!isCardImportDate(start)) issues.add('$.coverage.start', 'must be a valid YYYY-MM-DD date');
    if (!isCardImportDate(end)) issues.add('$.coverage.end', 'must be a valid YYYY-MM-DD date');
    if (isCardImportDate(start) && isCardImportDate(end)) {
      if (start > end) issues.add('$.coverage', 'start must not be after end');
      else coverageOk = true;
    }
  }

  const rejectedCount = own(value, 'rejectedCount');
  if (!isInteger(rejectedCount, 0, CARD_IMPORT_MAX_ROWS)) {
    issues.add('$.rejectedCount', `must be an integer from 0 to ${CARD_IMPORT_MAX_ROWS}`);
  }
  const statement = checkStatement(own(value, 'statement'), issues);

  const rawRows = own(value, 'rows');
  const rows: CardImportPayloadRow[] = [];
  let rowsOk = false;
  if (!Array.isArray(rawRows)) {
    issues.add('$.rows', 'must be an array');
  } else if (rawRows.length + (isInteger(rejectedCount, 0, CARD_IMPORT_MAX_ROWS) ? rejectedCount : 0) > CARD_IMPORT_MAX_ROWS) {
    issues.add('$.rows', `rows plus rejectedCount must be at most ${CARD_IMPORT_MAX_ROWS}`);
  } else {
    rowsOk = true;
    for (let index = 0; index < rawRows.length; index += 1) {
      const row = checkRow(rawRows[index], `$.rows[${index}]`, issues);
      if (row) rows.push(row);
      else rowsOk = false;
      if (issues.full) break;
    }
  }

  if (rowsOk) {
    const seen = new Map<string, number>();
    rows.forEach((row, index) => {
      if (row.externalIdHash === null) return;
      if (seen.has(row.externalIdHash)) issues.add(`$.rows[${index}].externalIdHash`, `repeats rows[${seen.get(row.externalIdHash)}]`);
      else seen.set(row.externalIdHash, index);
    });
    let keys: ReturnType<typeof assignCardDedupeKeys> = [];
    try {
      keys = assignCardDedupeKeys(rows);
    } catch {
      issues.add('$.rows', 'dedupe keys could not be computed');
    }
    keys.forEach((key, index) => {
      if ('fingerprint' in key && key.fingerprint !== rows[index].fingerprint) {
        issues.add(`$.rows[${index}].fingerprint`, 'does not match assignCardDedupeKeys for this row');
      }
    });
    if (coverageOk) {
      const { start, end } = coverage as unknown as CardImportCoverage;
      rows.forEach((row, index) => {
        const date = cardImportEffectiveDate(row);
        if (date < start || date > end) issues.add(`$.rows[${index}]`, 'falls outside coverage');
      });
    }
    const totals = summarizeCardImportRows(rows);
    for (const summary of [totals.posted, totals.pending]) {
      if (Math.max(summary.chargesMinor, -summary.creditsMinor) > CARD_IMPORT_MAX_TOTAL_MINOR) {
        issues.add('$.rows', `totals must stay below ${CARD_IMPORT_MAX_TOTAL_MINOR + 1} minor units`);
      }
    }
    const rawTotals = own(value, 'totals');
    if (checkKeys(rawTotals, '$.totals', ['posted', 'pending'], issues)) {
      checkSummary(own(rawTotals, 'posted'), totals.posted, '$.totals.posted', issues);
      checkSummary(own(rawTotals, 'pending'), totals.pending, '$.totals.pending', issues);
    }
    if (issues.list.length === 0) {
      return {
        ok: true,
        payload: {
          format: CARD_IMPORT_FORMAT,
          version: CARD_IMPORT_VERSION,
          source: source as string,
          parserVersion: parserVersion as string,
          issuer: issuer as string,
          currency: currency as string,
          owner: owner as CardOwner | null,
          cards: [...(cards as string[])],
          coverage: { start: (coverage as unknown as CardImportCoverage).start, end: (coverage as unknown as CardImportCoverage).end },
          rejectedCount: rejectedCount as number,
          statement,
          totals,
          rows,
        },
      };
    }
  }
  if (issues.list.length === 0) issues.add('$', 'is invalid');
  return { ok: false, issues: issues.list };
}

// ---------------------------------------------------------------------------
// Building a payload (producer side)
// ---------------------------------------------------------------------------

export interface CardImportDraftRow {
  transactionDate: string;
  postedDate?: string | null;
  /** Defaults to `posted`. */
  status?: CardImportRowStatus;
  /** Integer minor units in Holdr's sign: positive = money spent. */
  amountMinor: number;
  kind: CardTransactionKind;
  /** Raw issuer text; redacted here. */
  description: string;
  merchant?: string | null;
  issuerCategory?: string | null;
  /**
   * The issuer's stable reference from an allowlisted column (OFX FITID,
   * Amex Reference). Only its `cardExternalIdHash` is kept. Never pass a
   * card or account number here.
   */
  externalId?: string | null;
}

export interface CardImportDraft {
  source: string;
  parserVersion: string;
  issuer: string;
  currency: string;
  owner?: CardOwner | null;
  /** Last-4 values seen; sorted and deduplicated here. */
  cards?: readonly string[];
  /** Dates the export was requested for; widened to include every row. Defaults to the rows' dates. */
  coverage?: CardImportCoverage | null;
  rejectedCount?: number;
  statement?: Partial<CardImportStatement> | null;
  rows: readonly CardImportDraftRow[];
}

export interface CardImportBuildResult {
  payload: CardImportPayload;
  /** Rows whose reference repeats within the draft; they are keyed by fingerprint instead, so none is lost. */
  repeatedExternalIdRows: number[];
  /** Rows where redaction changed a description, merchant or category. */
  redactedRows: number[];
  /** True when rows fell outside the requested coverage and it was widened. */
  coverageWidened: boolean;
}

function draftText(raw: unknown, maxLength: number, path: string, issues: IssueList): { text: string | null; redacted: boolean } {
  if (raw === undefined || raw === null) return { text: null, redacted: false };
  if (typeof raw !== 'string') {
    issues.add(path, 'must be a string');
    return { text: null, redacted: false };
  }
  if (raw.length > CARD_IMPORT_MAX_RAW_TEXT) {
    issues.add(path, RAW_TEXT_TOO_LONG);
    return { text: null, redacted: false };
  }
  const text = sanitizeCardText(raw, maxLength);
  if (containsCardSecret(raw) || (text !== null && containsCardSecret(text))) {
    // Security codes, PINs and expiry dates are refused, never redacted: the export must change.
    issues.add(path, `${CARD_SECRET_PROBLEM}; remove it from the export`);
    return { text: null, redacted: false };
  }
  // Fail closed: whatever the shared detectors still flag after redaction is refused, not stored.
  const problem = text === null ? null : cardImportTextProblem(text, maxLength);
  if (problem) issues.add(path, `${problem} after redaction; remove it from the export`);
  // For the redacted-rows count: whether redaction changed the complete normalized text.
  const normalized = tidy(raw);
  return { text, redacted: collapseLongDigitRuns(redactCardNumbers(normalized)) !== normalized };
}

/**
 * Turns parsed export rows into a payload: redacts every text field, hashes
 * references, assigns dedupe keys, computes coverage and totals, then checks
 * the result with `validateCardImportPayload`. Throws `CardImportError` with
 * value-free issues.
 */
export function buildCardImportPayload(draft: CardImportDraft): CardImportBuildResult {
  const issues = new IssueList();
  if (!draft || typeof draft !== 'object') throw new CardImportError('card import draft must be an object');
  if (typeof draft.source !== 'string' || !CARD_SLUG.test(draft.source)) issues.add('$.source', 'must be a lowercase slug');
  if (typeof draft.parserVersion !== 'string' || !PARSER_VERSION.test(draft.parserVersion)) issues.add('$.parserVersion', 'is invalid');
  if (typeof draft.issuer !== 'string' || !CARD_SLUG.test(draft.issuer)) issues.add('$.issuer', 'must be a lowercase slug');
  if (typeof draft.currency !== 'string' || !CURRENCY.test(draft.currency)) issues.add('$.currency', 'must be a three-letter uppercase code');
  const owner = draft.owner ?? null;
  if (owner !== null && !OWNERS.has(owner)) issues.add('$.owner', 'must be alex, casey or joint');
  const cards = [...new Set(draft.cards ?? [])].sort();
  if (cards.length > CARD_IMPORT_MAX_CARDS || cards.some((card) => !LAST4.test(card))) {
    issues.add('$.cards', `must be at most ${CARD_IMPORT_MAX_CARDS} values of exactly four digits`);
  }
  const rejectedCount = draft.rejectedCount ?? 0;
  if (!isInteger(rejectedCount, 0, CARD_IMPORT_MAX_ROWS)) issues.add('$.rejectedCount', 'is invalid');
  if (!Array.isArray(draft.rows)) throw new CardImportError('card import draft rows must be an array');
  if (draft.rows.length + (isInteger(rejectedCount, 0, CARD_IMPORT_MAX_ROWS) ? rejectedCount : 0) > CARD_IMPORT_MAX_ROWS) {
    throw new CardImportError(`a card import holds at most ${CARD_IMPORT_MAX_ROWS} rows; split the export`);
  }

  const redactedRows: number[] = [];
  const rows: Array<Omit<CardImportPayloadRow, 'fingerprint'>> = [];
  draft.rows.forEach((raw, index) => {
    const at = `$.rows[${index}]`;
    const before = issues.list.length;
    if (!isCardImportDate(raw.transactionDate)) issues.add(`${at}.transactionDate`, 'must be a valid YYYY-MM-DD date');
    const postedDate = raw.postedDate ?? null;
    if (postedDate !== null && !isCardImportDate(postedDate)) issues.add(`${at}.postedDate`, 'must be a valid YYYY-MM-DD date');
    const status = raw.status ?? 'posted';
    if (!STATUSES.has(status)) issues.add(`${at}.status`, 'must be pending or posted');
    if (!isInteger(raw.amountMinor, -CARD_IMPORT_MAX_AMOUNT_MINOR, CARD_IMPORT_MAX_AMOUNT_MINOR)) {
      issues.add(`${at}.amountMinor`, `must be whole minor units of at most ${CARD_IMPORT_MAX_AMOUNT_MINOR}`);
    }
    if (!KINDS.has(raw.kind)) issues.add(`${at}.kind`, 'is invalid');
    const description = draftText(raw.description, CARD_IMPORT_TEXT_LIMITS.description, `${at}.description`, issues);
    const merchant = draftText(raw.merchant, CARD_IMPORT_TEXT_LIMITS.merchant, `${at}.merchant`, issues);
    const issuerCategory = draftText(raw.issuerCategory, CARD_IMPORT_TEXT_LIMITS.issuerCategory, `${at}.issuerCategory`, issues);
    let externalIdHash: string | null = null;
    if (raw.externalId !== undefined && raw.externalId !== null) {
      if (typeof raw.externalId !== 'string') {
        issues.add(`${at}.externalId`, 'must be a string');
      } else if (raw.externalId.trim() !== '') {
        try {
          externalIdHash = cardExternalIdHash(raw.externalId);
        } catch (error) {
          issues.add(`${at}.externalId`, (error as Error).message.replace(/^card external id /, ''));
        }
      }
    }
    if (description.redacted || merchant.redacted || issuerCategory.redacted) redactedRows.push(index);
    if (issues.list.length !== before) return;
    rows.push({
      transactionDate: raw.transactionDate,
      postedDate,
      status,
      amountMinor: raw.amountMinor + 0,
      kind: raw.kind,
      description: description.text ?? CARD_IMPORT_NO_DESCRIPTION,
      merchant: merchant.text,
      issuerCategory: issuerCategory.text,
      externalIdHash,
    });
  });
  if (issues.list.length > 0) throw new CardImportError('card import draft is invalid', issues.list);

  // A reference that repeats within one export cannot tell its rows apart; keying them by
  // fingerprint keeps every row instead of silently dropping all but the first.
  const counts = new Map<string, number>();
  for (const row of rows) if (row.externalIdHash) counts.set(row.externalIdHash, (counts.get(row.externalIdHash) ?? 0) + 1);
  const repeatedExternalIdRows: number[] = [];
  rows.forEach((row, index) => {
    if (row.externalIdHash && counts.get(row.externalIdHash)! > 1) {
      row.externalIdHash = null;
      repeatedExternalIdRows.push(index);
    }
  });
  const keys = assignCardDedupeKeys(rows);
  const payloadRows: CardImportPayloadRow[] = rows.map((row, index) => {
    const key = keys[index];
    return {
      transactionDate: row.transactionDate,
      postedDate: row.postedDate,
      status: row.status,
      amountMinor: row.amountMinor,
      kind: row.kind,
      description: row.description,
      merchant: row.merchant,
      issuerCategory: row.issuerCategory,
      externalIdHash: 'externalIdHash' in key ? key.externalIdHash : null,
      fingerprint: 'fingerprint' in key ? key.fingerprint : null,
    };
  });

  const dates = payloadRows.map(cardImportEffectiveDate).sort();
  let coverage: CardImportCoverage;
  let coverageWidened = false;
  if (draft.coverage) {
    const { start, end } = draft.coverage;
    if (!isCardImportDate(start) || !isCardImportDate(end) || start > end) {
      throw new CardImportError('card import coverage must be two valid YYYY-MM-DD dates, start first');
    }
    coverage = { start, end };
    if (dates.length > 0 && (dates[0] < start || dates[dates.length - 1] > end)) {
      coverage = { start: dates[0] < start ? dates[0] : start, end: dates[dates.length - 1] > end ? dates[dates.length - 1] : end };
      coverageWidened = true;
    }
  } else if (dates.length > 0) {
    coverage = { start: dates[0], end: dates[dates.length - 1] };
  } else {
    throw new CardImportError('a card import without rows needs an explicit coverage date range');
  }

  let statement: CardImportStatement | null = null;
  if (draft.statement) {
    statement = {
      chargesMinor: draft.statement.chargesMinor ?? null,
      creditsMinor: draft.statement.creditsMinor ?? null,
      netMinor: draft.statement.netMinor ?? null,
      previousBalanceMinor: draft.statement.previousBalanceMinor ?? null,
      newBalanceMinor: draft.statement.newBalanceMinor ?? null,
    };
    if (STATEMENT_KEYS.every((key) => statement![key] === null)) statement = null;
  }

  const payload: CardImportPayload = {
    format: CARD_IMPORT_FORMAT,
    version: CARD_IMPORT_VERSION,
    source: draft.source,
    parserVersion: draft.parserVersion,
    issuer: draft.issuer,
    currency: draft.currency,
    owner,
    cards,
    coverage,
    rejectedCount,
    statement,
    totals: summarizeCardImportRows(payloadRows),
    rows: payloadRows,
  };
  const sensitive = findCardImportSensitivePaths(payload);
  if (sensitive.length > 0) {
    throw new CardImportError('card import payload still contains card data', sensitive.map((path) => ({ path, message: 'card data' })));
  }
  const checked = validateCardImportPayload(payload);
  if (!checked.ok) throw new CardImportError('card import payload is invalid', checked.issues);
  return { payload: checked.payload, repeatedExternalIdRows, redactedRows, coverageWidened };
}

/**
 * Canonical JSON text of a payload: two-space indentation with one row per
 * line, so files diff and review well. Byte-identical for equal payloads.
 */
export function serializeCardImportPayload(payload: CardImportPayload): string {
  const lines: string[] = ['{'];
  for (const key of PAYLOAD_KEYS) {
    if (key === 'rows') continue;
    if (key === 'totals') {
      lines.push('  "totals": {');
      lines.push(`    "posted": ${JSON.stringify(payload.totals.posted)},`);
      lines.push(`    "pending": ${JSON.stringify(payload.totals.pending)}`);
      lines.push('  },');
    } else {
      lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(payload[key])},`);
    }
  }
  if (payload.rows.length === 0) {
    lines.push('  "rows": []');
  } else {
    lines.push('  "rows": [');
    payload.rows.forEach((row, index) => {
      const ordered: Record<string, unknown> = {};
      for (const key of ROW_KEYS) ordered[key] = row[key];
      lines.push(`    ${JSON.stringify(ordered)}${index < payload.rows.length - 1 ? ',' : ''}`);
    });
    lines.push('  ]');
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}
