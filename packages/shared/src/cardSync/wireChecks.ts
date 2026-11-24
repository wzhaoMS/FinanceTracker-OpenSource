/**
 * Field and cross-field checks shared by the v2 payload and the projected
 * batch validators. Internal: both validators run these on the detached
 * snapshot from `snapshotStrictJson`, never on caller objects.
 */
import { isCardExternalIdHash } from '../cardDedupe.js';
import { CARD_IMPORT_KINDS, CARD_IMPORT_MAX_AMOUNT_MINOR, CARD_IMPORT_MAX_TOTAL_MINOR, isCardImportDate } from '../cardImport.js';
import type { CardImportStatement } from '../cardImport.js';
import type { CardTransactionKind } from '../types.js';
import { cardAmountSignAllowed } from './amounts.js';
import type { JsonObject, JsonValue } from './canonical.js';
import { isCardSyncId, type CardSyncIdKind } from './ids.js';
import { CardSyncIssueList, cardSyncIndexPath } from './issues.js';
import {
  CARD_SYNC_COMPLETENESS,
  CARD_SYNC_DATE_BASES,
  CARD_SYNC_IDENTITY_NAMESPACES,
  CARD_SYNC_ORIGINAL_CURRENCY_EXPONENTS,
  CARD_SYNC_TERMINATIONS,
  cardSyncCompletenessAllowed,
  isCardSyncEnum,
  type CardSyncCompleteness,
  type CardSyncDateBasis,
  type CardSyncIdentityNamespace,
  type CardSyncSourceSpec,
  type CardSyncTermination,
} from './registry.js';
import { checkExactKeys, isJsonObject } from './strictJson.js';
import { CARD_SYNC_TEXT_LIMITS, cardSyncTextIssue } from './text.js';

/** Marks a field that is missing (already reported) or invalid (reported here). */
export const BAD: unique symbol = Symbol('bad');
export type Checked<T> = T | typeof BAD;

export const ROW_STATUSES = ['pending', 'posted'] as const;
export type RowStatus = (typeof ROW_STATUSES)[number];

export const MAX_SECONDARY_IDS = 3;
export const MAX_PAGE_COUNT = 100;
export const STATEMENT_KEYS = ['chargesMinor', 'creditsMinor', 'netMinor', 'previousBalanceMinor', 'newBalanceMinor'] as const;
export const DATE_RANGE_KEYS = ['start', 'end', 'dateBasis'] as const;
export const SECONDARY_ID_KEYS = ['namespace', 'idHash'] as const;

const TIMESTAMP = /^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})\.[0-9]{3}Z$/;

/** `YYYY-MM-DDTHH:MM:SS.sssZ` (the form `Date.prototype.toISOString` writes) on a valid 1970–2099 date, no leap seconds. */
export function isCardSyncTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = TIMESTAMP.exec(value);
  if (!match || !isCardImportDate(match[1])) return false;
  return Number(match[2]) <= 23 && Number(match[3]) <= 59 && Number(match[4]) <= 59;
}

export function has(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** The field's value, or BAD when it is missing (checkExactKeys has reported it). */
export function field(object: JsonObject, key: string): Checked<JsonValue> {
  return has(object, key) ? object[key] : BAD;
}

export class Fields {
  constructor(readonly issues: CardSyncIssueList) {}

  integer(object: JsonObject, key: string, at: string, min: number, max: number): Checked<number> {
    const value = field(object, key);
    if (value === BAD) return BAD;
    if (typeof value !== 'number') return this.bad('wrong-type', `${at}.${key}`);
    if (!Number.isSafeInteger(value) || value < min || value > max) return this.bad('out-of-range', `${at}.${key}`);
    return value + 0;
  }

  nullableInteger(object: JsonObject, key: string, at: string, min: number, max: number): Checked<number | null> {
    if (has(object, key) && object[key] === null) return null;
    return this.integer(object, key, at, min, max);
  }

  enumValue<T extends string>(object: JsonObject, key: string, at: string, list: readonly T[]): Checked<T> {
    const value = field(object, key);
    if (value === BAD) return BAD;
    if (typeof value !== 'string') return this.bad('wrong-type', `${at}.${key}`);
    if (!isCardSyncEnum(list, value)) return this.bad('invalid-enum', `${at}.${key}`);
    return value;
  }

  nullableEnum<T extends string>(object: JsonObject, key: string, at: string, list: readonly T[]): Checked<T | null> {
    if (has(object, key) && object[key] === null) return null;
    return this.enumValue(object, key, at, list);
  }

  matching(object: JsonObject, key: string, at: string, test: (value: string) => boolean): Checked<string> {
    const value = field(object, key);
    if (value === BAD) return BAD;
    if (typeof value !== 'string') return this.bad('wrong-type', `${at}.${key}`);
    if (!test(value)) return this.bad('invalid-format', `${at}.${key}`);
    return value;
  }

  nullableMatching(object: JsonObject, key: string, at: string, test: (value: string) => boolean): Checked<string | null> {
    if (has(object, key) && object[key] === null) return null;
    return this.matching(object, key, at, test);
  }

  id(object: JsonObject, key: string, at: string, kind: CardSyncIdKind): Checked<string> {
    return this.matching(object, key, at, (value) => isCardSyncId(kind, value));
  }

  date(object: JsonObject, key: string, at: string): Checked<string> {
    const value = field(object, key);
    if (value === BAD) return BAD;
    if (typeof value !== 'string') return this.bad('wrong-type', `${at}.${key}`);
    if (!isCardImportDate(value)) return this.bad('invalid-date', `${at}.${key}`);
    return value;
  }

  nullableDate(object: JsonObject, key: string, at: string): Checked<string | null> {
    if (has(object, key) && object[key] === null) return null;
    return this.date(object, key, at);
  }

  timestamp(object: JsonObject, key: string, at: string): Checked<string> {
    const value = field(object, key);
    if (value === BAD) return BAD;
    if (typeof value !== 'string') return this.bad('wrong-type', `${at}.${key}`);
    if (!isCardSyncTimestamp(value)) return this.bad('invalid-timestamp', `${at}.${key}`);
    return value;
  }

  text(object: JsonObject, key: string, at: string, maxLength: number, nullable: boolean): Checked<string | null> {
    const value = field(object, key);
    if (value === BAD) return BAD;
    if (value === null && nullable) return null;
    // Every string of the snapshot has already been through the card detectors.
    const issue = cardSyncTextIssue(value, maxLength, { scanned: true });
    if (issue) return this.bad(issue, `${at}.${key}`);
    return value as string;
  }

  array(object: JsonObject, key: string, at: string, maxItems: number): Checked<JsonValue[]> {
    const value = field(object, key);
    if (value === BAD) return BAD;
    if (!Array.isArray(value)) return this.bad('wrong-type', `${at}.${key}`);
    if (value.length > maxItems) return this.bad('too-many-items', `${at}.${key}`);
    return value;
  }

  /** The value as an object after reporting its missing and unknown keys, or null (reported) when it is not one. */
  object(value: JsonValue, path: string, keys: readonly string[]): JsonObject | null {
    if (!isJsonObject(value)) {
      this.issues.add('wrong-type', path);
      return null;
    }
    checkExactKeys(value, path, keys, this.issues);
    return value;
  }

  bad(code: Parameters<CardSyncIssueList['add']>[0], path: string): typeof BAD {
    this.issues.add(code, path);
    return BAD;
  }
}

// ---------------------------------------------------------------------------
// Statement (v1 rules)
// ---------------------------------------------------------------------------

export function checkStatement(fields: Fields, value: JsonValue): Checked<CardImportStatement | null> {
  if (value === null) return null;
  const before = fields.issues.size;
  const object = fields.object(value, '$.statement', STATEMENT_KEYS);
  if (!object) return BAD;
  const statement = {} as CardImportStatement;
  let complete = true;
  for (const key of STATEMENT_KEYS) {
    const figure = fields.nullableInteger(object, key, '$.statement', -CARD_IMPORT_MAX_TOTAL_MINOR, CARD_IMPORT_MAX_TOTAL_MINOR);
    if (figure === BAD) complete = false;
    statement[key] = figure === BAD ? null : figure;
  }
  if (!complete || fields.issues.size !== before) return BAD;
  if (statement.chargesMinor !== null && statement.chargesMinor < 0) fields.bad('sign-mismatch', '$.statement.chargesMinor');
  if (statement.creditsMinor !== null && statement.creditsMinor > 0) fields.bad('sign-mismatch', '$.statement.creditsMinor');
  if ((statement.previousBalanceMinor === null) !== (statement.newBalanceMinor === null)) {
    fields.bad('inconsistent', statement.previousBalanceMinor === null ? '$.statement.previousBalanceMinor' : '$.statement.newBalanceMinor');
  }
  if (STATEMENT_KEYS.every((key) => statement[key] === null)) fields.bad('inconsistent', '$.statement');
  return fields.issues.size === before ? statement : BAD;
}

// ---------------------------------------------------------------------------
// Transaction rows: the fields v2 rows and projected transactions share
// ---------------------------------------------------------------------------

export interface SecondaryId {
  namespace: CardSyncIdentityNamespace;
  idHash: string;
}

export interface RowCore {
  transactionDate: string;
  postedDate: string | null;
  status: RowStatus;
  amountMinor: number;
  kind: CardTransactionKind;
  description: string;
  merchant: string | null;
  issuerCategory: string | null;
  externalIdHash: string | null;
  identityNamespace: CardSyncIdentityNamespace;
  secondaryIds: SecondaryId[];
  originalAmountMinor: number | null;
  originalCurrency: string | null;
}

export interface RowContext {
  /** Null when the payload's source is invalid; source-dependent checks are skipped then. */
  source: CardSyncSourceSpec | null;
  /** Null when the payload's currency is invalid. */
  currency: string | null;
}

function namespaceIssue(
  fields: Fields,
  namespace: CardSyncIdentityNamespace,
  source: CardSyncSourceSpec,
  stable: boolean,
  path: string,
): boolean {
  const allowed = stable ? source.stableNamespaces.includes(namespace) : source.captureNamespace === namespace;
  if (allowed) return false;
  const ofSource = source.captureNamespace === namespace || source.stableNamespaces.includes(namespace);
  // A namespace of this source but of the wrong kind breaks the identity rules; another source's is a mismatch.
  fields.bad(ofSource ? 'identity-conflict' : 'source-mismatch', path);
  return true;
}

function checkSecondaryIds(
  fields: Fields,
  row: JsonObject,
  at: string,
  primary: { hash: string | null; namespace: CardSyncIdentityNamespace | null },
  source: CardSyncSourceSpec | null,
): Checked<SecondaryId[]> {
  const list = fields.array(row, 'secondaryIds', at, MAX_SECONDARY_IDS);
  if (list === BAD) return BAD;
  const path = `${at}.secondaryIds`;
  if (primary.hash === null && list.length > 0) return fields.bad('identity-conflict', path);
  const before = fields.issues.size;
  const result: SecondaryId[] = [];
  const namespaces = new Set<string>();
  list.forEach((item, index) => {
    const itemPath = cardSyncIndexPath(path, index);
    const object = fields.object(item, itemPath, SECONDARY_ID_KEYS);
    if (!object) return;
    const namespace = fields.enumValue(object, 'namespace', itemPath, CARD_SYNC_IDENTITY_NAMESPACES);
    const idHash = fields.matching(object, 'idHash', itemPath, isCardExternalIdHash);
    if (namespace !== BAD) {
      if (source && namespaceIssue(fields, namespace, source, true, `${itemPath}.namespace`)) return;
      if (namespace === primary.namespace) {
        fields.bad('identity-conflict', `${itemPath}.namespace`);
        return;
      }
      if (namespaces.has(namespace)) {
        fields.bad('duplicate', `${itemPath}.namespace`);
        return;
      }
      namespaces.add(namespace);
    }
    // The same digest under another namespace is another identity (UNIQUE(account, source scope,
    // namespace, id hash)); repeats of a whole identity are judged across the payload.
    if (namespace !== BAD && idHash !== BAD) result.push({ namespace, idHash });
  });
  return fields.issues.size === before ? result : BAD;
}

/** Checks the shared row fields of `row` (whose key set the caller has checked). Null when any is invalid. */
export function checkRowCore(fields: Fields, row: JsonObject, at: string, context: RowContext): RowCore | null {
  const before = fields.issues.size;
  const transactionDate = fields.date(row, 'transactionDate', at);
  const postedDate = fields.nullableDate(row, 'postedDate', at);
  const status = fields.enumValue(row, 'status', at, ROW_STATUSES);
  const amountMinor = fields.integer(row, 'amountMinor', at, -CARD_IMPORT_MAX_AMOUNT_MINOR, CARD_IMPORT_MAX_AMOUNT_MINOR);
  const kind = fields.enumValue(row, 'kind', at, CARD_IMPORT_KINDS);
  const description = fields.text(row, 'description', at, CARD_SYNC_TEXT_LIMITS.description, false);
  const merchant = fields.text(row, 'merchant', at, CARD_SYNC_TEXT_LIMITS.merchant, true);
  const issuerCategory = fields.text(row, 'issuerCategory', at, CARD_SYNC_TEXT_LIMITS.issuerCategory, true);
  const externalIdHash = fields.nullableMatching(row, 'externalIdHash', at, isCardExternalIdHash);
  const identityNamespace = fields.enumValue(row, 'identityNamespace', at, CARD_SYNC_IDENTITY_NAMESPACES);
  const originalAmountMinor = fields.nullableInteger(
    row, 'originalAmountMinor', at, -CARD_IMPORT_MAX_AMOUNT_MINOR, CARD_IMPORT_MAX_AMOUNT_MINOR,
  );
  const originalCurrency = fields.nullableMatching(row, 'originalCurrency', at, (value) => /^[A-Z]{3}$/.test(value));

  if (status === 'pending' && postedDate !== BAD && postedDate !== null) fields.bad('inconsistent', `${at}.postedDate`);
  if (kind !== BAD && amountMinor !== BAD && !cardAmountSignAllowed(kind, amountMinor)) fields.bad('sign-mismatch', `${at}.amountMinor`);

  let namespaceOk = identityNamespace !== BAD;
  if (identityNamespace !== BAD && externalIdHash !== BAD && context.source) {
    namespaceOk = !namespaceIssue(fields, identityNamespace, context.source, externalIdHash !== null, `${at}.identityNamespace`);
  }
  const secondaryIds = externalIdHash === BAD || !namespaceOk
    ? BAD
    : checkSecondaryIds(fields, row, at, { hash: externalIdHash, namespace: identityNamespace as CardSyncIdentityNamespace }, context.source);

  if (originalAmountMinor !== BAD && originalCurrency !== BAD) {
    if ((originalAmountMinor === null) !== (originalCurrency === null)) {
      fields.bad('inconsistent', originalAmountMinor === null ? `${at}.originalAmountMinor` : `${at}.originalCurrency`);
    } else if (originalCurrency !== null) {
      if (!Object.prototype.hasOwnProperty.call(CARD_SYNC_ORIGINAL_CURRENCY_EXPONENTS, originalCurrency)) {
        fields.bad('invalid-enum', `${at}.originalCurrency`);
      } else if (context.currency !== null && originalCurrency === context.currency) {
        fields.bad('inconsistent', `${at}.originalCurrency`);
      }
      if (amountMinor !== BAD && Math.sign(originalAmountMinor as number) !== Math.sign(amountMinor)) {
        fields.bad('sign-mismatch', `${at}.originalAmountMinor`);
      }
    }
  }

  const values = [
    transactionDate, postedDate, status, amountMinor, kind, description, merchant, issuerCategory, externalIdHash,
    identityNamespace, secondaryIds, originalAmountMinor, originalCurrency,
  ];
  if (fields.issues.size !== before || values.includes(BAD)) return null;
  return {
    transactionDate: transactionDate as string,
    postedDate: postedDate as string | null,
    status: status as RowStatus,
    amountMinor: amountMinor as number,
    kind: kind as CardTransactionKind,
    description: description as string,
    merchant: merchant as string | null,
    issuerCategory: issuerCategory as string | null,
    externalIdHash: externalIdHash as string | null,
    identityNamespace: identityNamespace as CardSyncIdentityNamespace,
    secondaryIds: secondaryIds as SecondaryId[],
    originalAmountMinor: originalAmountMinor as number | null,
    originalCurrency: originalCurrency as string | null,
  };
}

/**
 * Every identity appears once per payload. An identity is the row's source
 * domain (its card scope in v2, its account candidate in a projected batch),
 * a namespace and a digest, as Holdr keys them (UNIQUE(account, source
 * scope, namespace, id hash)); primary and secondary ids are compared alike.
 * The same digest in another namespace or domain is another identity, since
 * `cardExternalIdHash` covers only the id text.
 */
export function checkRepeatedIds<R extends RowCore>(
  fields: Fields,
  rows: readonly R[],
  rowsPath: string,
  domainOf: (row: R) => string,
): void {
  const seen = new Set<string>();
  const identity = (row: R, namespace: string, hash: string) => `${domainOf(row)}\u0000${namespace}\u0000${hash}`;
  rows.forEach((row, index) => {
    const at = cardSyncIndexPath(rowsPath, index);
    if (row.externalIdHash !== null) {
      const key = identity(row, row.identityNamespace, row.externalIdHash);
      if (seen.has(key)) fields.bad('duplicate', `${at}.externalIdHash`);
      seen.add(key);
    }
    row.secondaryIds.forEach((secondary, position) => {
      const key = identity(row, secondary.namespace, secondary.idHash);
      if (seen.has(key)) fields.bad('duplicate', `${cardSyncIndexPath(`${at}.secondaryIds`, position)}.idHash`);
      seen.add(key);
    });
  });
}

// ---------------------------------------------------------------------------
// Coverage evidence
// ---------------------------------------------------------------------------

export interface DateRange {
  start: string;
  end: string;
  dateBasis: CardSyncDateBasis;
}

export interface CoverageCore {
  status: RowStatus;
  requested: DateRange | null;
  observed: DateRange | null;
  completeness: CardSyncCompleteness;
  pageCount: number;
  termination: CardSyncTermination;
}

function checkRange(fields: Fields, entry: JsonObject, key: 'requested' | 'observed', at: string): Checked<DateRange | null> {
  const value = field(entry, key);
  if (value === BAD) return BAD;
  if (value === null) return null;
  const path = `${at}.${key}`;
  const object = fields.object(value, path, DATE_RANGE_KEYS);
  if (!object) return BAD;
  const before = fields.issues.size;
  const start = fields.date(object, 'start', path);
  const end = fields.date(object, 'end', path);
  const dateBasis = fields.enumValue(object, 'dateBasis', path, CARD_SYNC_DATE_BASES);
  if (start !== BAD && end !== BAD && start > end) fields.bad('date-order', path);
  if (fields.issues.size !== before || start === BAD || end === BAD || dateBasis === BAD) return BAD;
  return { start, end, dateBasis };
}

/**
 * Checks one coverage entry's own fields and the rules between them; the
 * caller checks its key set and its scope or account field.
 * - `completeness` is at most what the termination allows
 *   (`cardSyncCompletenessCeiling`): `complete` only after `end-marker` with a
 *   `requested` window, `unknown` after `snapshot`, `not-read` or an end
 *   marker without a window, `partial` after any other stop.
 * - `not-read` exactly when `pageCount` is 0, and then `observed: null`.
 * - An observation-basis range is one day, on a pending entry.
 */
export function checkCoverageCore(fields: Fields, entry: JsonObject, at: string): CoverageCore | null {
  const before = fields.issues.size;
  const status = fields.enumValue(entry, 'status', at, ROW_STATUSES);
  const requested = checkRange(fields, entry, 'requested', at);
  const observed = checkRange(fields, entry, 'observed', at);
  const completeness = fields.enumValue(entry, 'completeness', at, CARD_SYNC_COMPLETENESS);
  const pageCount = fields.integer(entry, 'pageCount', at, 0, MAX_PAGE_COUNT);
  const termination = fields.enumValue(entry, 'termination', at, CARD_SYNC_TERMINATIONS);
  if (fields.issues.size !== before || [status, requested, observed, completeness, pageCount, termination].includes(BAD)) return null;
  const core = { status, requested, observed, completeness, pageCount, termination } as CoverageCore;
  // An observation-basis range is a snapshot: one day, and only for pending rows ("complete at that moment").
  for (const key of ['requested', 'observed'] as const) {
    const range = core[key];
    if (range?.dateBasis === 'observation' && (core.status !== 'pending' || range.start !== range.end)) fields.bad('inconsistent', `${at}.${key}`);
  }
  if (!cardSyncCompletenessAllowed(core.completeness, core.termination, core.requested)) fields.bad('inconsistent', `${at}.completeness`);
  if ((core.termination === 'not-read') !== (core.pageCount === 0)) fields.bad('inconsistent', `${at}.pageCount`);
  if (core.termination === 'not-read' && core.observed !== null) fields.bad('inconsistent', `${at}.observed`);
  return fields.issues.size === before ? core : null;
}

/** The inclusive hull of the rows' dates on `basis`, or null without rows; undefined when a row has no date on that basis. */
export function observedHull(
  rows: ReadonlyArray<Pick<RowCore, 'transactionDate' | 'postedDate'>>,
  basis: 'transaction' | 'posted',
): DateRange | null | undefined {
  let start: string | null = null;
  let end: string | null = null;
  for (const row of rows) {
    const date = basis === 'transaction' ? row.transactionDate : row.postedDate;
    if (date === null) return undefined;
    if (start === null || date < start) start = date;
    if (end === null || date > end) end = date;
  }
  return start === null || end === null ? null : { start, end, dateBasis: basis };
}

const DAY_MS = 86_400_000;

/** Within one day of the UTC calendar date of `observedAt`. */
function nearObservation(day: string, observedAt: string): boolean {
  return Math.abs(Date.parse(`${day}T00:00:00.000Z`) - Date.parse(`${observedAt.slice(0, 10)}T00:00:00.000Z`)) <= DAY_MS;
}

/**
 * Coverage against rows, for entries keyed by `keyOf(entry)` and rows by `keyOf(row)`:
 * one entry per key and status, an entry for every row, `observed` derived
 * from the entry's rows on every basis (null exactly when it has none; on a
 * transaction or posted basis the hull of their dates), observation-basis
 * days within one day of `observedAt`, and nothing `complete` when rows
 * were rejected.
 */
export function checkCoverageAgainstRows<E extends CoverageCore, R extends RowCore>(
  fields: Fields,
  entries: readonly E[],
  entryKey: (entry: E) => string,
  coveragePath: string,
  rows: readonly R[],
  rowKey: (row: R) => string,
  rowKeyField: string,
  rowsPath: string,
  rejectedCount: number,
  observedAt: string | null,
): void {
  const byKey = new Map<string, number>();
  entries.forEach((entry, index) => {
    const id = `${entryKey(entry)} ${entry.status}`;
    if (byKey.has(id)) fields.bad('duplicate', cardSyncIndexPath(coveragePath, index));
    else byKey.set(id, index);
  });
  const rowsByEntry = new Map<number, R[]>();
  rows.forEach((row, index) => {
    const entry = byKey.get(`${rowKey(row)} ${row.status}`);
    if (entry === undefined) {
      fields.bad('coverage-mismatch', `${cardSyncIndexPath(rowsPath, index)}.${rowKeyField}`);
      return;
    }
    const list = rowsByEntry.get(entry) ?? [];
    list.push(row);
    rowsByEntry.set(entry, list);
  });
  entries.forEach((entry, index) => {
    const at = cardSyncIndexPath(coveragePath, index);
    if (byKey.get(`${entryKey(entry)} ${entry.status}`) !== index) return;
    const matching = rowsByEntry.get(index) ?? [];
    const observed = entry.observed;
    if ((observed === null) !== (matching.length === 0)) {
      fields.bad('coverage-mismatch', `${at}.observed`);
    } else if (observed !== null && observed.dateBasis !== 'observation') {
      const hull = observedHull(matching, observed.dateBasis);
      if (!hull || hull.start !== observed.start || hull.end !== observed.end) fields.bad('coverage-mismatch', `${at}.observed`);
    }
    if (observedAt !== null) {
      for (const key of ['requested', 'observed'] as const) {
        const range = entry[key];
        if (range?.dateBasis === 'observation' && !nearObservation(range.start, observedAt)) fields.bad('inconsistent', `${at}.${key}`);
      }
    }
    if (rejectedCount > 0 && entry.completeness === 'complete') fields.bad('inconsistent', `${at}.completeness`);
  });
}
