/**
 * The redacted checking-import payload (`holdr.checking-import`, version 1): what Holdr keeps of a checking account's
 * activity, from any bank. Producers (the offline converter in `checkingImportTool/`, with one format adapter per bank
 * export) turn raw exports into this payload; the operator's Root-GO'd import (apps/api `holdr-checking import`)
 * re-checks all of it with `validateCheckingImportPayload` before it writes anything.
 *
 * Checking rows are never spending. They live in their own tables, apart from card spending, brokerage cash, holdings
 * and returns, and are read only as the source a card payment may have come from.
 *
 * A segment is what one export file says: the whole days it speaks for completely (`coverage`), every posted row dated
 * in them (oldest first, in the bank's posting order within a day), and the end-of-day balances it states (`anchors`;
 * a statement's opening balance is the balance at the end of the day before its period). A day is either fully known
 * or not imported, so two segments covering the same day must agree on it (the same multiset of amounts): a QFX, a CSV
 * and a statement of the same days are one record, never three. Rows are keyed by content (`checkingRowKey`: posted
 * date, amount, occurrence), never by description or bank reference, which differ between formats.
 *
 * Every function is pure and deterministic. Issues name fields and paths, never values.
 */
import { sha256, toLetterHex, isCardExternalIdHash } from './cardDedupe.js';
import { cardImportTextProblem, isCardImportDate } from './cardImport.js';

export const CHECKING_IMPORT_FORMAT = 'holdr.checking-import';
export const CHECKING_IMPORT_VERSION = 1;
export const CHECKING_ACCOUNT_TYPES = ['checking'] as const;
export type CheckingAccountType = (typeof CHECKING_ACCOUNT_TYPES)[number];
/**
 * End-of-day balances a segment states: a statement's `opening` (dated the day before its period) and `closing`
 * balance, a `daily` ending balance, or the bank's `ledger` balance (OFX LEDGERBAL, at the end of its last complete day).
 */
export const CHECKING_ANCHOR_KINDS = ['opening', 'closing', 'daily', 'ledger'] as const;
export type CheckingAnchorKind = (typeof CHECKING_ANCHOR_KINDS)[number];

export const CHECKING_IMPORT_LIMITS = Object.freeze({
  /** Rows across all segments of one payload (four years of a busy account is a few thousand). */
  rows: 50_000,
  segments: 400,
  /** Every end-of-day balance a file states can anchor: a statement's daily balances, a CSV's running balance. */
  anchorsPerSegment: 5_000,
  description: 500,
  label: 60,
  /** Largest single amount, in minor units (99,999,999.99 for a two-decimal currency). */
  amountMinor: 9_999_999_999,
  /** Largest balance either side of zero, in minor units. */
  balanceMinor: 99_999_999_999,
});
/** Stored when a row has no usable description. */
export const CHECKING_IMPORT_NO_DESCRIPTION = '(no description)';
/** A row's bank type is one of OFX's transaction types (TRNTYPE), or null; adapters map their bank's own types to these. */
export const CHECKING_BANK_TYPES = ['CREDIT', 'DEBIT', 'INT', 'DIV', 'FEE', 'SRVCHG', 'DEP', 'ATM', 'POS', 'XFER', 'CHECK', 'PAYMENT',
  'CASH', 'DIRECTDEP', 'DIRECTDEBIT', 'REPEATPMT', 'HOLD', 'OTHER'] as const;
/** Content keys are versioned; any change to their canonical form needs a new version. */
export const CHECKING_KEY_VERSION = 1;

export interface CheckingImportAccount {
  /** Lowercase bank slug, e.g. `wellsfargo`, `fifththird`. */
  institution: string;
  type: CheckingAccountType;
  /** The account number's last four digits; nothing more of it is ever kept. */
  last4: string;
  /** A display name with no digits, e.g. `Wells Fargo Everyday Checking`. */
  label: string;
  currency: string;
}

export interface CheckingImportCoverage {
  /** Inclusive YYYY-MM-DD bounds of the whole days the segment speaks for completely. */
  start: string;
  end: string;
}

export interface CheckingImportAnchor {
  /** The balance at the end of this day (YYYY-MM-DD), after every row posted on it. */
  date: string;
  /** Integer minor units; negative when overdrawn. */
  balanceMinor: number;
  kind: CheckingAnchorKind;
}

export interface CheckingImportRow {
  /** YYYY-MM-DD, the bank's posting date. */
  postedDate: string;
  /** Integer minor units in the bank's sign: positive = money in, negative = money out. */
  amountMinor: number;
  /** Redacted by `sanitizeCardText` (card numbers and 13+ digit runs kept as `***` + last four). */
  description: string;
  /** A paper check's number, digits only. */
  checkNumber: string | null;
  /** The bank's own transaction type (OFX TRNTYPE), upper case; a hint, never trusted for the sign. */
  bankType: string | null;
  /** `cardExternalIdHash` of the bank's reference (OFX FITID); an attribute only, never a key. */
  externalIdHash: string | null;
}

export interface CheckingImportSegment {
  /** Open slug for the producer's format adapter, e.g. `ofx`, `wf-csv`, `wf-statement`. */
  source: string;
  coverage: CheckingImportCoverage;
  anchors: CheckingImportAnchor[];
  rows: CheckingImportRow[];
}

export interface CheckingImportPayload {
  format: typeof CHECKING_IMPORT_FORMAT;
  version: typeof CHECKING_IMPORT_VERSION;
  parserVersion: string;
  account: CheckingImportAccount;
  /** Sorted by coverage start, then end, then source. */
  segments: CheckingImportSegment[];
}

export interface CheckingImportIssue {
  /** JSONPath-like location such as `$.segments[2].rows[3].amountMinor`. */
  path: string;
  message: string;
}

export type CheckingImportValidation =
  | { ok: true; payload: CheckingImportPayload; issues: [] }
  | { ok: false; payload: null; issues: CheckingImportIssue[] };

/** Bank and source slugs are letters and hyphens only, so no digit of an account number can ride in one. */
const SLUG = /^[a-z][a-z-]{0,31}$/;
const PARSER_VERSION = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/;
const CURRENCY = /^[A-Z]{3}$/;
const LAST4 = /^[0-9]{4}$/;
const CHECK_NUMBER = /^[0-9]{1,10}$/;
const MAX_ISSUES = 20;
const PAYLOAD_KEYS = ['format', 'version', 'parserVersion', 'account', 'segments'];
const ACCOUNT_KEYS = ['institution', 'type', 'last4', 'label', 'currency'];
const SEGMENT_KEYS = ['source', 'coverage', 'anchors', 'rows'];
const COVERAGE_KEYS = ['start', 'end'];
const ANCHOR_KEYS = ['date', 'balanceMinor', 'kind'];
const ROW_KEYS = ['postedDate', 'amountMinor', 'description', 'checkNumber', 'bankType', 'externalIdHash'];

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** True for a valid YYYY-MM-DD date from 1970 to 2099 (the card import range). */
export function isCheckingDate(value: unknown): value is string {
  return isCardImportDate(value);
}

/** `date` moved by `days` calendar days (UTC, so never shifted by a time zone). */
export function addCheckingDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Every date from `start` to `end`, inclusive (empty when `start` is after `end`). */
export function checkingDatesBetween(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let date = start; date <= end; date = addCheckingDays(date, 1)) dates.push(date);
  return dates;
}

/** Inclusive ranges merged where they overlap or touch, sorted. */
export function mergeCheckingRanges(ranges: ReadonlyArray<CheckingImportCoverage>): CheckingImportCoverage[] {
  const sorted = [...ranges].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
  const merged: CheckingImportCoverage[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= addCheckingDays(last.end, 1)) {
      if (range.end > last.end) last.end = range.end;
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged;
}

/** True when every day from `start` to `end` lies in one of the merged `ranges`. */
export function checkingRangesCover(ranges: ReadonlyArray<CheckingImportCoverage>, start: string, end: string): boolean {
  if (start > end) return true;
  return mergeCheckingRanges(ranges).some((range) => range.start <= start && range.end >= end);
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const KEY_TAG = 'holdr.checking-row';
const KEY = new RegExp(`^chkd${CHECKING_KEY_VERSION}:[a-p]{64}$`);
const encoder = new TextEncoder();

/**
 * The content key of a checking row: its posted date, its amount and `occurrence`, its 0-based position among the
 * rows of that day with that amount. Descriptions and bank references are left out, because a QFX, a CSV and a
 * statement word them differently; within one account, the day's amounts are what identify a row. Letter hex (a-p)
 * holds no digits. Keys are unique per account; the database scopes them by account.
 */
export function checkingRowKey(postedDate: string, amountMinor: number, occurrence: number): string {
  if (!isCheckingDate(postedDate)) throw new Error('checking key postedDate must be a valid YYYY-MM-DD date');
  if (!Number.isSafeInteger(amountMinor)) throw new Error('checking key amountMinor must be a safe integer');
  if (!Number.isSafeInteger(occurrence) || occurrence < 0) throw new Error('checking key occurrence must be a non-negative integer');
  // JSON.stringify writes -0 as 0, so a zero amount has one key.
  return `chkd${CHECKING_KEY_VERSION}:${toLetterHex(sha256(encoder.encode(JSON.stringify([KEY_TAG, CHECKING_KEY_VERSION, postedDate, amountMinor, occurrence]))))}`;
}

export function isCheckingRowKey(value: unknown): value is string {
  return typeof value === 'string' && KEY.test(value);
}

/** One key per row of one day, in order: each amount's occurrences are counted from 0. */
export function checkingDayKeys(rows: ReadonlyArray<Pick<CheckingImportRow, 'postedDate' | 'amountMinor'>>): string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const group = `${row.postedDate}|${row.amountMinor + 0}`;
    const occurrence = seen.get(group) ?? 0;
    seen.set(group, occurrence + 1);
    return checkingRowKey(row.postedDate, row.amountMinor, occurrence);
  });
}

/** The day's amounts as a sorted list: what two records of one day must agree on. */
export function checkingDayAmounts(rows: ReadonlyArray<Pick<CheckingImportRow, 'amountMinor'>>): number[] {
  return rows.map((row) => row.amountMinor + 0).sort((a, b) => a - b);
}

export function sameCheckingAmounts(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// ---------------------------------------------------------------------------
// Days and balances
// ---------------------------------------------------------------------------

export interface CheckingImportDay {
  date: string;
  /** The day's rows, from the first segment that covers it. */
  rows: CheckingImportRow[];
  /** Index of that segment. */
  segment: number;
}

export interface CheckingImportDays {
  /** Every covered day, in date order. */
  days: CheckingImportDay[];
  /** Days two segments cover with different amounts, in date order. */
  disagreements: string[];
}

/** Each covered day once: segments that cover the same day must agree on its amounts. */
export function checkingImportDays(segments: ReadonlyArray<CheckingImportSegment>): CheckingImportDays {
  const byDate = new Map<string, CheckingImportDay>();
  const disagreements = new Set<string>();
  segments.forEach((segment, index) => {
    const rowsByDate = new Map<string, CheckingImportRow[]>();
    for (const row of segment.rows) {
      const list = rowsByDate.get(row.postedDate);
      if (list) list.push(row);
      else rowsByDate.set(row.postedDate, [row]);
    }
    for (const date of checkingDatesBetween(segment.coverage.start, segment.coverage.end)) {
      const rows = rowsByDate.get(date) ?? [];
      const known = byDate.get(date);
      if (!known) byDate.set(date, { date, rows, segment: index });
      else if (!sameCheckingAmounts(checkingDayAmounts(known.rows), checkingDayAmounts(rows))) disagreements.add(date);
    }
  });
  const days = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  return { days, disagreements: [...disagreements].sort() };
}

export interface CheckingChainResult {
  /** Pairs of consecutive balances whose days between were all covered, and so were checked. */
  checked: number;
  /** Pairs with an uncovered day between them: nothing to check. */
  gaps: number;
  /** Dates of balances that do not follow from the one before them and the rows between (or that contradict another balance of the same day). */
  mismatches: string[];
}

/**
 * Whether stated end-of-day balances follow from each other: for each pair of consecutive balances, the earlier one
 * plus the net of every row posted after its day, up to and including the later one's day, must be the later one.
 * Pairs with an uncovered day between them are gaps (unknown, not wrong). `dayNet` gives a covered day's net in minor
 * units, or null for a day no record covers.
 */
export function checkCheckingBalanceChain(
  anchors: ReadonlyArray<Pick<CheckingImportAnchor, 'date' | 'balanceMinor'>>,
  dayNet: (date: string) => number | null,
): CheckingChainResult {
  const byDate = new Map<string, number>();
  const mismatches = new Set<string>();
  for (const anchor of anchors) {
    const known = byDate.get(anchor.date);
    if (known === undefined) byDate.set(anchor.date, anchor.balanceMinor);
    else if (known !== anchor.balanceMinor) mismatches.add(anchor.date);
  }
  const ordered = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  let checked = 0;
  let gaps = 0;
  for (let i = 1; i < ordered.length; i += 1) {
    const [fromDate, fromBalance] = ordered[i - 1];
    const [toDate, toBalance] = ordered[i];
    let balance = fromBalance;
    let covered = true;
    for (let date = addCheckingDays(fromDate, 1); date <= toDate; date = addCheckingDays(date, 1)) {
      const net = dayNet(date);
      if (net === null) {
        covered = false;
        break;
      }
      balance += net;
    }
    if (!covered) gaps += 1;
    else {
      checked += 1;
      if (balance !== toBalance) mismatches.add(toDate);
    }
  }
  return { checked, gaps, mismatches: [...mismatches].sort() };
}

/** Net of each covered day of a payload, after its segments were found to agree. */
export function checkingDayNets(days: ReadonlyArray<CheckingImportDay>): Map<string, number> {
  return new Map(days.map((day) => [day.date, day.rows.reduce((sum, row) => sum + row.amountMinor, 0)]));
}

export interface CheckingImportSummary {
  segments: number;
  /** Distinct rows: a day several segments cover counts once. */
  rows: number;
  /** Covered days, each counted once. */
  days: number;
  anchors: number;
  coverage: CheckingImportCoverage[];
  /** Per source, its segments and every row they hold. */
  bySource: Record<string, { segments: number; rows: number }>;
}

/** Counts and coverage only: no amount, balance or description. */
export function summarizeCheckingImport(payload: Pick<CheckingImportPayload, 'segments'>): CheckingImportSummary {
  // A Map, not an object: a source is any slug, `constructor` and `toString` included.
  const bySource = new Map<string, { segments: number; rows: number }>();
  for (const segment of payload.segments) {
    const entry = bySource.get(segment.source) ?? { segments: 0, rows: 0 };
    entry.segments += 1;
    entry.rows += segment.rows.length;
    bySource.set(segment.source, entry);
  }
  const { days } = checkingImportDays(payload.segments);
  return {
    segments: payload.segments.length,
    rows: days.reduce((sum, day) => sum + day.rows.length, 0),
    days: days.length,
    anchors: payload.segments.reduce((sum, segment) => sum + segment.anchors.length, 0),
    coverage: mergeCheckingRanges(payload.segments.map((segment) => segment.coverage)),
    bySource: Object.fromEntries(bySource),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

class IssueList {
  readonly list: CheckingImportIssue[] = [];
  add(path: string, message: string): void {
    if (this.list.length < MAX_ISSUES) this.list.push({ path, message });
  }
  get full(): boolean {
    return this.list.length >= MAX_ISSUES;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Checks an object has exactly `keys`; never names an unexpected key, which could be anything. */
function checkKeys(value: unknown, path: string, keys: readonly string[], issues: IssueList): value is Record<string, unknown> {
  if (!isRecord(value)) {
    issues.add(path, 'must be an object');
    return false;
  }
  const own = Object.keys(value);
  if (own.some((key) => !keys.includes(key))) issues.add(path, 'has an unexpected field');
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(value, key)) issues.add(`${path}.${key}`, 'is required');
  return true;
}

function isInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function checkText(value: unknown, path: string, maxLength: number, issues: IssueList): void {
  if (typeof value !== 'string') {
    issues.add(path, 'must be a string');
    return;
  }
  const problem = cardImportTextProblem(value, maxLength);
  if (problem) issues.add(path, problem);
}

function checkAccount(value: unknown, issues: IssueList): void {
  if (!checkKeys(value, '$.account', ACCOUNT_KEYS, issues)) return;
  if (typeof value.institution !== 'string' || !SLUG.test(value.institution)) issues.add('$.account.institution', 'must be a lowercase slug of letters and hyphens');
  if (value.type !== 'checking') issues.add('$.account.type', 'must be checking');
  if (typeof value.last4 !== 'string' || !LAST4.test(value.last4)) issues.add('$.account.last4', 'must be four digits');
  checkText(value.label, '$.account.label', CHECKING_IMPORT_LIMITS.label, issues);
  if (typeof value.label === 'string' && /\p{N}/u.test(value.label.normalize('NFKC'))) issues.add('$.account.label', 'must not contain digits');
  if (typeof value.currency !== 'string' || !CURRENCY.test(value.currency)) issues.add('$.account.currency', 'must be three capital letters');
}

function checkRow(value: unknown, path: string, coverage: CheckingImportCoverage | null, previousDate: string | null, issues: IssueList): string | null {
  if (!checkKeys(value, path, ROW_KEYS, issues)) return previousDate;
  const date = value.postedDate;
  if (!isCheckingDate(date)) issues.add(`${path}.postedDate`, 'must be a valid YYYY-MM-DD date');
  else {
    if (coverage && (date < coverage.start || date > coverage.end)) issues.add(`${path}.postedDate`, 'must lie within the segment coverage');
    if (previousDate !== null && date < previousDate) issues.add(`${path}.postedDate`, 'rows must be in posted-date order');
  }
  if (!isInteger(value.amountMinor, -CHECKING_IMPORT_LIMITS.amountMinor, CHECKING_IMPORT_LIMITS.amountMinor)) {
    issues.add(`${path}.amountMinor`, `must be a whole number of minor units within ±${CHECKING_IMPORT_LIMITS.amountMinor}`);
  }
  checkText(value.description, `${path}.description`, CHECKING_IMPORT_LIMITS.description, issues);
  if (value.checkNumber !== null && (typeof value.checkNumber !== 'string' || !CHECK_NUMBER.test(value.checkNumber))) {
    issues.add(`${path}.checkNumber`, 'must be null or 1 to 10 digits');
  }
  if (value.bankType !== null && (typeof value.bankType !== 'string' || !(CHECKING_BANK_TYPES as readonly string[]).includes(value.bankType))) {
    issues.add(`${path}.bankType`, 'must be null or one of the OFX transaction types');
  }
  if (value.externalIdHash !== null && !isCardExternalIdHash(value.externalIdHash)) {
    issues.add(`${path}.externalIdHash`, 'must be null or a reference hash');
  }
  return isCheckingDate(date) ? date : previousDate;
}

function checkSegment(value: unknown, path: string, issues: IssueList): number {
  if (!checkKeys(value, path, SEGMENT_KEYS, issues)) return 0;
  if (typeof value.source !== 'string' || !SLUG.test(value.source)) issues.add(`${path}.source`, 'must be a lowercase slug of letters and hyphens');
  let coverage: CheckingImportCoverage | null = null;
  if (checkKeys(value.coverage, `${path}.coverage`, COVERAGE_KEYS, issues)) {
    const { start, end } = value.coverage;
    if (!isCheckingDate(start)) issues.add(`${path}.coverage.start`, 'must be a valid YYYY-MM-DD date');
    if (!isCheckingDate(end)) issues.add(`${path}.coverage.end`, 'must be a valid YYYY-MM-DD date');
    if (isCheckingDate(start) && isCheckingDate(end)) {
      if (start > end) issues.add(`${path}.coverage`, 'start must not be after end');
      else coverage = { start, end };
    }
  }
  if (!Array.isArray(value.anchors)) issues.add(`${path}.anchors`, 'must be an array');
  else if (value.anchors.length > CHECKING_IMPORT_LIMITS.anchorsPerSegment) {
    issues.add(`${path}.anchors`, `must hold at most ${CHECKING_IMPORT_LIMITS.anchorsPerSegment} balances`);
  } else {
    const dates = new Set<string>();
    value.anchors.forEach((anchor, index) => {
      const at = `${path}.anchors[${index}]`;
      if (!checkKeys(anchor, at, ANCHOR_KEYS, issues)) return;
      if (!isCheckingDate(anchor.date)) issues.add(`${at}.date`, 'must be a valid YYYY-MM-DD date');
      else {
        if (coverage && (anchor.date < addCheckingDays(coverage.start, -1) || anchor.date > coverage.end)) {
          issues.add(`${at}.date`, 'must lie from the day before the coverage to its end');
        }
        if (dates.has(anchor.date)) issues.add(`${at}.date`, 'a segment states one balance per day');
        dates.add(anchor.date);
      }
      if (!isInteger(anchor.balanceMinor, -CHECKING_IMPORT_LIMITS.balanceMinor, CHECKING_IMPORT_LIMITS.balanceMinor)) {
        issues.add(`${at}.balanceMinor`, `must be a whole number of minor units within ±${CHECKING_IMPORT_LIMITS.balanceMinor}`);
      }
      if (typeof anchor.kind !== 'string' || !(CHECKING_ANCHOR_KINDS as readonly string[]).includes(anchor.kind)) {
        issues.add(`${at}.kind`, `must be one of ${CHECKING_ANCHOR_KINDS.join(', ')}`);
      }
    });
  }
  if (!Array.isArray(value.rows)) {
    issues.add(`${path}.rows`, 'must be an array');
    return 0;
  }
  let previous: string | null = null;
  for (let index = 0; index < value.rows.length && !issues.full; index += 1) {
    previous = checkRow(value.rows[index], `${path}.rows[${index}]`, coverage, previous, issues);
  }
  return value.rows.length;
}

function segmentOrder(a: CheckingImportSegment, b: CheckingImportSegment): number {
  const keyA = [a.coverage.start, a.coverage.end, a.source];
  const keyB = [b.coverage.start, b.coverage.end, b.source];
  for (let i = 0; i < keyA.length; i += 1) if (keyA[i] !== keyB[i]) return keyA[i] < keyB[i] ? -1 : 1;
  return 0;
}

/** Sorts segments into payload order (coverage start, end, source); stable, so equal ones keep their order. */
export function sortCheckingSegments<T extends CheckingImportSegment>(segments: readonly T[]): T[] {
  return [...segments].sort(segmentOrder);
}

/**
 * Checks a value is a complete `holdr.checking-import` v1 payload: exact fields, valid dates, whole minor units,
 * stored text that holds no card number, long digit run or card secret, rows inside their segment's coverage and in
 * date order, balances from the day before the coverage to its end, segments in payload order and agreeing on every
 * day they share. At most 20 issues; none quotes a value.
 */
export function validateCheckingImportPayload(value: unknown): CheckingImportValidation {
  const issues = new IssueList();
  if (!checkKeys(value, '$', PAYLOAD_KEYS, issues)) return { ok: false, payload: null, issues: issues.list };
  if (value.format !== CHECKING_IMPORT_FORMAT) issues.add('$.format', `must be ${CHECKING_IMPORT_FORMAT}`);
  if (value.version !== CHECKING_IMPORT_VERSION) issues.add('$.version', `must be ${CHECKING_IMPORT_VERSION}`);
  if (typeof value.parserVersion !== 'string' || !PARSER_VERSION.test(value.parserVersion)) {
    issues.add('$.parserVersion', 'must be a short version string');
  }
  checkAccount(value.account, issues);
  if (!Array.isArray(value.segments)) issues.add('$.segments', 'must be an array');
  else if (value.segments.length === 0) issues.add('$.segments', 'must hold at least one segment');
  else if (value.segments.length > CHECKING_IMPORT_LIMITS.segments) {
    issues.add('$.segments', `must hold at most ${CHECKING_IMPORT_LIMITS.segments} segments`);
  } else {
    let rows = 0;
    for (let index = 0; index < value.segments.length && !issues.full; index += 1) {
      rows += checkSegment(value.segments[index], `$.segments[${index}]`, issues);
      if (rows > CHECKING_IMPORT_LIMITS.rows) {
        issues.add('$.segments', `must hold at most ${CHECKING_IMPORT_LIMITS.rows} rows in all`);
        break;
      }
    }
  }
  if (issues.list.length > 0) return { ok: false, payload: null, issues: issues.list };
  const payload = value as unknown as CheckingImportPayload;
  for (let index = 1; index < payload.segments.length; index += 1) {
    if (segmentOrder(payload.segments[index - 1], payload.segments[index]) > 0) {
      issues.add(`$.segments[${index}]`, 'segments must be sorted by coverage start, end and source');
      break;
    }
  }
  if (checkingImportDays(payload.segments).disagreements.length > 0) {
    issues.add('$.segments', 'segments that cover the same day must agree on its amounts');
  }
  if (issues.list.length > 0) return { ok: false, payload: null, issues: issues.list };
  return { ok: true, payload, issues: [] };
}
