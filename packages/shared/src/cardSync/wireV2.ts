/**
 * `holdr.card-import` version 2: the only payload Holdr's browser extension
 * may send (plan §4.3). It keeps v1's root and row fields and adds the
 * binding, capture, mode and per-scope coverage evidence, per-row card scope
 * and source identity, and original foreign amounts. Contract version 1 pins
 * the exact field set and registries (`registry.ts`).
 *
 * `validateCardSyncPayloadV2` is strict and refuse-only:
 * 1. `snapshotStrictJson` reads the input once (plain JSON only, no
 *    accessors, prototype or forbidden keys, card data or secrets anywhere in
 *    keys or values, within depth, count and 2 MiB canonical byte limits);
 * 2. the snapshot must have exactly the v2 keys and types, registered enums,
 *    the id grammar, canonical redacted text and v1's bounds;
 * 3. derived values must match what the rows imply: fingerprints, totals,
 *    observed coverage, identity (scope, namespace, digest) and sign rules;
 *    and each row's text read together, and with the card hints, must not
 *    show card data or a secret (`cardSyncCombinedTextIssue`).
 * It never throws, truncates or rewrites; issues are `{ code, path }` only.
 * On success the payload is a fresh object equal to the input, with
 * `byteLength`, the UTF-8 size of its canonical JSON (`canonicalJson`).
 */
import { assignCardDedupeKeys, isCardFingerprint } from '../cardDedupe.js';
import {
  CARD_IMPORT_FORMAT,
  CARD_IMPORT_KINDS,
  CARD_IMPORT_MAX_CARDS,
  CARD_IMPORT_MAX_TOTAL_MINOR,
  summarizeCardImportRows,
  type CardImportPayloadRow,
  type CardImportStatement,
  type CardImportSummary,
  type CardImportTotals,
} from '../cardImport.js';
import type { CardOwner } from '../types.js';
import type { JsonObject, JsonValue } from './canonical.js';
import { CardHintSet, cardSyncCombinedTextIssue } from './crossField.js';
import { CardSyncIssueList, cardSyncIndexPath, type CardSyncIssue } from './issues.js';
import {
  CARD_SYNC_CURRENCIES,
  CARD_SYNC_MODES,
  CARD_SYNC_SOURCE_SPECS,
  CARD_SYNC_SOURCES,
  isSupportedCardSyncContractVersion,
  type CardSyncCompleteness,
  type CardSyncCurrency,
  type CardSyncDateBasis,
  type CardSyncIdentityNamespace,
  type CardSyncIssuer,
  type CardSyncMode,
  type CardSyncSource,
  type CardSyncTermination,
  CARD_SYNC_ISSUERS,
} from './registry.js';
import { isJsonObject, snapshotStrictJson, type StrictJsonLimits } from './strictJson.js';
import {
  BAD,
  checkCoverageAgainstRows,
  checkCoverageCore,
  checkRepeatedIds,
  checkRowCore,
  checkStatement,
  DATE_RANGE_KEYS,
  field,
  Fields,
  MAX_PAGE_COUNT,
  MAX_SECONDARY_IDS,
  observedHull,
  SECONDARY_ID_KEYS,
  STATEMENT_KEYS,
  type CoverageCore,
  type RowCore,
} from './wireChecks.js';

export const CARD_SYNC_V2_VERSION = 2;
/** Rows plus rejected rows per payload; v1 allows 10,000. */
export const CARD_SYNC_V2_MAX_ROWS = 2_000;
/** UTF-8 bytes of the canonical JSON; v1 allows 10 MiB. */
export const CARD_SYNC_V2_MAX_BYTES = 2 * 1024 * 1024;
/** Coverage entries: one per card scope and status. */
export const CARD_SYNC_V2_MAX_COVERAGE = 40;
export const CARD_SYNC_MAX_SECONDARY_IDS = MAX_SECONDARY_IDS;
export const CARD_SYNC_MAX_PAGE_COUNT = MAX_PAGE_COUNT;
export const CARD_SYNC_MAX_BINDING_VERSION = 2_147_483_647;

export type CardSyncRowStatus = 'pending' | 'posted';

export interface CardSyncDateRange {
  /** Inclusive YYYY-MM-DD issuer calendar days. */
  start: string;
  end: string;
  dateBasis: CardSyncDateBasis;
}

export interface CardSyncCoverageEntry {
  cardScopeId: string;
  status: CardSyncRowStatus;
  /** The window the read asked for (or the user's view showed), or null when none was set. */
  requested: CardSyncDateRange | null;
  /** On a transaction or posted basis, exactly the dates of this scope's rows with this status; null without rows. */
  observed: CardSyncDateRange | null;
  completeness: CardSyncCompleteness;
  pageCount: number;
  termination: CardSyncTermination;
}

export interface CardSyncSecondaryId {
  namespace: CardSyncIdentityNamespace;
  /** `cardExternalIdHash` of the issuer id in that namespace. */
  idHash: string;
}

export interface CardSyncRowV2 extends CardImportPayloadRow {
  /** The confirmed card scope this observation came from (possibly the binding's "holder unknown" scope). */
  cardScopeId: string;
  /** Namespace of `externalIdHash`, or the source's capture namespace for fingerprint rows. */
  identityNamespace: CardSyncIdentityNamespace;
  /** Other stable ids of the same row, each in its own namespace; empty for fingerprint rows. */
  secondaryIds: CardSyncSecondaryId[];
  /** Foreign amount in its own minor units, same sign as `amountMinor`; null together with `originalCurrency`. */
  originalAmountMinor: number | null;
  originalCurrency: string | null;
}

export interface CardSyncPayloadV2 {
  format: typeof CARD_IMPORT_FORMAT;
  version: typeof CARD_SYNC_V2_VERSION;
  contractVersion: number;
  source: CardSyncSource;
  parserVersion: string;
  issuer: CardSyncIssuer;
  currency: CardSyncCurrency;
  owner: CardOwner | null;
  cards: string[];
  bindingId: string;
  bindingVersion: number;
  captureId: string;
  observedAt: string;
  mode: CardSyncMode;
  coverage: CardSyncCoverageEntry[];
  rejectedCount: number;
  statement: CardImportStatement | null;
  totals: CardImportTotals;
  rows: CardSyncRowV2[];
}

export type CardSyncV2Validation =
  | { ok: true; payload: CardSyncPayloadV2; byteLength: number }
  | { ok: false; issues: CardSyncIssue[] };

export const CARD_SYNC_V2_KEYS = [
  'format', 'version', 'contractVersion', 'source', 'parserVersion', 'issuer', 'currency', 'owner', 'cards',
  'bindingId', 'bindingVersion', 'captureId', 'observedAt', 'mode', 'coverage', 'rejectedCount', 'statement',
  'totals', 'rows',
] as const;
export const CARD_SYNC_V2_ROW_KEYS = [
  'transactionDate', 'postedDate', 'status', 'amountMinor', 'kind', 'description', 'merchant', 'issuerCategory',
  'externalIdHash', 'fingerprint', 'cardScopeId', 'identityNamespace', 'secondaryIds', 'originalAmountMinor',
  'originalCurrency',
] as const;
export const CARD_SYNC_V2_COVERAGE_KEYS = [
  'cardScopeId', 'status', 'requested', 'observed', 'completeness', 'pageCount', 'termination',
] as const;
const TOTALS_KEYS = ['posted', 'pending'] as const;
const SUMMARY_KEYS = ['count', 'chargesMinor', 'creditsMinor', 'netMinor', 'byKind'] as const;
const KIND_TOTAL_KEYS = ['count', 'amountMinor'] as const;

/** Every key the v2 schema has; paths name these and show any other key as `<key>`. */
export const CARD_SYNC_V2_KNOWN_KEYS: ReadonlySet<string> = new Set<string>([
  ...CARD_SYNC_V2_KEYS, ...CARD_SYNC_V2_ROW_KEYS, ...CARD_SYNC_V2_COVERAGE_KEYS, ...DATE_RANGE_KEYS,
  ...SECONDARY_ID_KEYS, ...STATEMENT_KEYS, ...TOTALS_KEYS, ...SUMMARY_KEYS, ...KIND_TOTAL_KEYS, ...CARD_IMPORT_KINDS,
]);

/** Strict JSON limits for a v2 payload: its real shape needs depth 4, 19 keys per object and 2,000 items per array. */
export const CARD_SYNC_V2_LIMITS: Readonly<StrictJsonLimits> = Object.freeze({
  maxDepth: 6,
  maxKeysPerObject: 32,
  maxArrayLength: CARD_SYNC_V2_MAX_ROWS,
  maxNodes: 60_000,
  maxStringLength: 1_024,
  maxKeyLength: 64,
  maxBytes: CARD_SYNC_V2_MAX_BYTES,
});

const PARSER_VERSION = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/;
const LAST4 = /^[0-9]{4}$/;
const OWNERS = ['alex', 'casey', 'joint'] as const;

function fail(issues: CardSyncIssueList): CardSyncV2Validation {
  if (issues.size === 0) issues.add('unreadable', '$');
  return { ok: false, issues: issues.list };
}

function checkCards(fields: Fields, root: JsonObject): string[] | typeof BAD {
  const list = fields.array(root, 'cards', '$', CARD_IMPORT_MAX_CARDS);
  if (list === BAD) return BAD;
  const before = fields.issues.size;
  list.forEach((card, index) => {
    const at = cardSyncIndexPath('$.cards', index);
    if (typeof card !== 'string') fields.bad('wrong-type', at);
    else if (!LAST4.test(card)) fields.bad('invalid-format', at);
    else if (index > 0 && typeof list[index - 1] === 'string' && (list[index - 1] as string) >= card) {
      fields.bad(list[index - 1] === card ? 'duplicate' : 'unsorted', at);
    }
  });
  return fields.issues.size === before ? (list as string[]) : BAD;
}

interface CoverageEntryV2 extends CoverageCore {
  cardScopeId: string;
}

function checkCoverage(fields: Fields, root: JsonObject): CoverageEntryV2[] | typeof BAD {
  const list = fields.array(root, 'coverage', '$', CARD_SYNC_V2_MAX_COVERAGE);
  if (list === BAD) return BAD;
  const before = fields.issues.size;
  const entries: CoverageEntryV2[] = [];
  list.forEach((value, index) => {
    if (fields.issues.full) return;
    const at = cardSyncIndexPath('$.coverage', index);
    const entryBefore = fields.issues.size;
    const entry = fields.object(value, at, CARD_SYNC_V2_COVERAGE_KEYS);
    if (!entry) return;
    const cardScopeId = fields.id(entry, 'cardScopeId', at, 'cardScope');
    const core = checkCoverageCore(fields, entry, at);
    if (core && cardScopeId !== BAD && fields.issues.size === entryBefore) entries.push({ cardScopeId, ...core });
  });
  return fields.issues.size === before ? entries : BAD;
}

interface RowV2Checked extends RowCore {
  fingerprint: string | null;
  cardScopeId: string;
}

function checkRow(fields: Fields, value: JsonValue, at: string, context: Parameters<typeof checkRowCore>[3]): RowV2Checked | null {
  const before = fields.issues.size;
  const row = fields.object(value, at, CARD_SYNC_V2_ROW_KEYS);
  if (!row) return null;
  const core = checkRowCore(fields, row, at, context);
  const fingerprint = fields.nullableMatching(row, 'fingerprint', at, isCardFingerprint);
  const cardScopeId = fields.id(row, 'cardScopeId', at, 'cardScope');
  if (core && fingerprint !== BAD && (core.externalIdHash === null) === (fingerprint === null)) fields.bad('identity-conflict', at);
  if (!core || fingerprint === BAD || cardScopeId === BAD || fields.issues.size !== before) return null;
  return { ...core, fingerprint, cardScopeId };
}

function checkTotals(fields: Fields, value: JsonValue | typeof BAD, expected: CardImportTotals): void {
  if (value === BAD) return;
  const totals = fields.object(value, '$.totals', TOTALS_KEYS);
  if (!totals) return;
  for (const status of TOTALS_KEYS) {
    const path = `$.totals.${status}`;
    const summaryValue = field(totals, status);
    if (summaryValue === BAD) continue;
    const summary = fields.object(summaryValue, path, SUMMARY_KEYS);
    if (!summary) continue;
    const want: CardImportSummary = expected[status];
    for (const key of ['count', 'chargesMinor', 'creditsMinor', 'netMinor'] as const) {
      const actual = field(summary, key);
      if (actual === BAD) continue;
      if (typeof actual !== 'number') fields.bad('wrong-type', `${path}.${key}`);
      else if (actual !== want[key]) fields.bad('totals-mismatch', `${path}.${key}`);
    }
    const byKindValue = field(summary, 'byKind');
    if (byKindValue === BAD) continue;
    const byKind = fields.object(byKindValue, `${path}.byKind`, CARD_IMPORT_KINDS);
    if (!byKind) continue;
    for (const kind of CARD_IMPORT_KINDS) {
      const kindPath = `${path}.byKind.${kind}`;
      const kindValue = field(byKind, kind);
      if (kindValue === BAD) continue;
      const total = fields.object(kindValue, kindPath, KIND_TOTAL_KEYS);
      if (!total) continue;
      for (const key of KIND_TOTAL_KEYS) {
        const actual = field(total, key);
        if (actual === BAD) continue;
        if (typeof actual !== 'number') fields.bad('wrong-type', `${kindPath}.${key}`);
        else if (actual !== want.byKind[kind][key]) fields.bad('totals-mismatch', `${kindPath}.${key}`);
      }
    }
  }
}

function copyRange(range: CardSyncDateRange | null): CardSyncDateRange | null {
  return range === null ? null : { start: range.start, end: range.end, dateBasis: range.dateBasis };
}

/**
 * Strict, refuse-only validation of an untrusted v2 payload. See the module
 * comment; never throws.
 */
export function validateCardSyncPayloadV2(value: unknown): CardSyncV2Validation {
  const snapshot = snapshotStrictJson(value, { limits: CARD_SYNC_V2_LIMITS, knownKeys: CARD_SYNC_V2_KNOWN_KEYS });
  if (!snapshot.ok) return { ok: false, issues: snapshot.issues };
  const issues = new CardSyncIssueList();
  const fields = new Fields(issues);
  const root = snapshot.value;
  if (!isJsonObject(root)) {
    issues.add('wrong-type', '$');
    return fail(issues);
  }
  // Another format, version or contract is not worth checking field by field.
  const format = field(root, 'format');
  const version = field(root, 'version');
  const contractVersion = field(root, 'contractVersion');
  if (format === BAD) issues.add('missing-key', '$.format');
  else if (format !== CARD_IMPORT_FORMAT) issues.add('unsupported-format', '$.format');
  else if (version === BAD) issues.add('missing-key', '$.version');
  else if (version !== CARD_SYNC_V2_VERSION) issues.add('unsupported-version', '$.version');
  else if (contractVersion === BAD) issues.add('missing-key', '$.contractVersion');
  else if (!isSupportedCardSyncContractVersion(contractVersion)) issues.add('unsupported-contract', '$.contractVersion');
  if (issues.size > 0) return fail(issues);
  fields.object(root, '$', CARD_SYNC_V2_KEYS);

  const source = fields.enumValue(root, 'source', '$', CARD_SYNC_SOURCES);
  const spec = source === BAD ? null : CARD_SYNC_SOURCE_SPECS[source];
  const parserVersion = fields.matching(root, 'parserVersion', '$', (text) => PARSER_VERSION.test(text));
  const issuer = fields.enumValue(root, 'issuer', '$', CARD_SYNC_ISSUERS);
  if (spec && issuer !== BAD && issuer !== spec.issuer) fields.bad('source-mismatch', '$.issuer');
  const currency = fields.enumValue(root, 'currency', '$', CARD_SYNC_CURRENCIES);
  const owner = fields.nullableEnum(root, 'owner', '$', OWNERS);
  const cards = checkCards(fields, root);
  const bindingId = fields.id(root, 'bindingId', '$', 'binding');
  const bindingVersion = fields.integer(root, 'bindingVersion', '$', 1, CARD_SYNC_MAX_BINDING_VERSION);
  const captureId = fields.id(root, 'captureId', '$', 'capture');
  const observedAt = fields.timestamp(root, 'observedAt', '$');
  const mode = fields.enumValue(root, 'mode', '$', CARD_SYNC_MODES);
  if (spec && mode !== BAD && mode !== spec.mode) fields.bad('source-mismatch', '$.mode');
  const coverage = checkCoverage(fields, root);
  const rejectedCount = fields.integer(root, 'rejectedCount', '$', 0, CARD_SYNC_V2_MAX_ROWS);
  const statementValue = field(root, 'statement');
  const statement = statementValue === BAD ? BAD : checkStatement(fields, statementValue);

  const rawRows = fields.array(root, 'rows', '$', CARD_SYNC_V2_MAX_ROWS);
  const rows: RowV2Checked[] = [];
  let rowsOk = rawRows !== BAD;
  if (rawRows !== BAD) {
    if (rejectedCount !== BAD && rawRows.length + rejectedCount > CARD_SYNC_V2_MAX_ROWS) {
      fields.bad('too-many-items', '$.rows');
      rowsOk = false;
    } else {
      const context = { source: spec, currency: currency === BAD ? null : currency };
      for (let index = 0; index < rawRows.length && !issues.full; index += 1) {
        const row = checkRow(fields, rawRows[index], cardSyncIndexPath('$.rows', index), context);
        if (row) rows.push(row);
        else rowsOk = false;
      }
      if (issues.full) rowsOk = false;
    }
  }

  if (rowsOk && spec) {
    checkRepeatedIds(fields, rows, '$.rows', (row) => row.cardScopeId);
    // Text that only shows card data or a secret once fields, or text and a card hint, are put together.
    const hints = new CardHintSet(cards === BAD ? [] : cards);
    rows.forEach((row, index) => {
      const combined = cardSyncCombinedTextIssue([row.description, row.merchant, row.issuerCategory], hints);
      if (combined) fields.bad(combined, cardSyncIndexPath('$.rows', index));
    });
    try {
      const keys = assignCardDedupeKeys(rows);
      keys.forEach((key, index) => {
        if ('fingerprint' in key && key.fingerprint !== rows[index].fingerprint) {
          fields.bad('fingerprint-mismatch', `${cardSyncIndexPath('$.rows', index)}.fingerprint`);
        }
      });
    } catch {
      fields.bad('fingerprint-mismatch', '$.rows');
    }
    if (coverage !== BAD && rejectedCount !== BAD) {
      checkCoverageAgainstRows(
        fields, coverage, (entry) => entry.cardScopeId, '$.coverage', rows, (row) => row.cardScopeId, 'cardScopeId', '$.rows',
        rejectedCount, observedAt === BAD ? null : observedAt,
      );
    }
    const totals = summarizeCardImportRows(rows);
    for (const summary of [totals.posted, totals.pending]) {
      if (Math.max(summary.chargesMinor, -summary.creditsMinor) > CARD_IMPORT_MAX_TOTAL_MINOR) fields.bad('out-of-range', '$.rows');
    }
    checkTotals(fields, field(root, 'totals'), totals);

    if (issues.size === 0) {
      const payload: CardSyncPayloadV2 = {
        format: CARD_IMPORT_FORMAT,
        version: CARD_SYNC_V2_VERSION,
        contractVersion: contractVersion as number,
        source: source as CardSyncSource,
        parserVersion: parserVersion as string,
        issuer: issuer as CardSyncIssuer,
        currency: currency as CardSyncCurrency,
        owner: owner as CardOwner | null,
        cards: [...(cards as string[])],
        bindingId: bindingId as string,
        bindingVersion: bindingVersion as number,
        captureId: captureId as string,
        observedAt: observedAt as string,
        mode: mode as CardSyncMode,
        coverage: (coverage as CoverageEntryV2[]).map((entry) => ({
          cardScopeId: entry.cardScopeId,
          status: entry.status,
          requested: copyRange(entry.requested),
          observed: copyRange(entry.observed),
          completeness: entry.completeness,
          pageCount: entry.pageCount,
          termination: entry.termination,
        })),
        rejectedCount: rejectedCount as number,
        statement: statement === BAD || statement === null ? null : { ...statement },
        totals,
        rows: rows.map((row) => ({
          transactionDate: row.transactionDate,
          postedDate: row.postedDate,
          status: row.status,
          amountMinor: row.amountMinor,
          kind: row.kind,
          description: row.description,
          merchant: row.merchant,
          issuerCategory: row.issuerCategory,
          externalIdHash: row.externalIdHash,
          fingerprint: row.fingerprint,
          cardScopeId: row.cardScopeId,
          identityNamespace: row.identityNamespace,
          secondaryIds: row.secondaryIds.map((secondary) => ({ namespace: secondary.namespace, idHash: secondary.idHash })),
          originalAmountMinor: row.originalAmountMinor,
          originalCurrency: row.originalCurrency,
        })),
      };
      return { ok: true, payload, byteLength: snapshot.byteLength };
    }
  }
  return fail(issues);
}

// ---------------------------------------------------------------------------
// Producer helpers
// ---------------------------------------------------------------------------

export type CardSyncRowDraftV2 = Omit<CardSyncRowV2, 'fingerprint'>;

export interface CardSyncDraftV2 extends Omit<CardSyncPayloadV2, 'format' | 'version' | 'totals' | 'rows'> {
  /** Rows in capture order; each row's text must already come from `prepareCardSyncText`. */
  rows: readonly CardSyncRowDraftV2[];
}

/**
 * Producer side: adds what v2 derives from the rows (fingerprints for rows
 * without a stable id, via v1's `assignCardDedupeKeys`, and totals via
 * `summarizeCardImportRows`), then validates the whole payload. It rewrites
 * nothing else: text, ids, coverage and amounts must already be final.
 * Never throws.
 */
export function buildCardSyncPayloadV2(draft: CardSyncDraftV2): CardSyncV2Validation {
  try {
    return validateCardSyncPayloadV2(assembleCardSyncPayloadV2(draft));
  } catch {
    return { ok: false, issues: [{ code: 'unreadable', path: '$' }] };
  }
}

/** A draft with v2's derived fields added, unvalidated: a fingerprint or `totals` is null when the rows could not give one. */
export interface CardSyncAssembledPayloadV2 extends Omit<CardSyncPayloadV2, 'totals'> {
  totals: CardImportTotals | null;
}

/**
 * The object `buildCardSyncPayloadV2` validates: the draft with v2's derived
 * fields (fingerprints via v1's `assignCardDedupeKeys`, totals via
 * `summarizeCardImportRows`) and nothing else rewritten. A valid payload
 * validates to an object equal to it, so its `cardSyncPayloadDigest` is the
 * built payload's. Throws only for a draft that is not a draft (a missing
 * `rows` or `secondaryIds` array, say).
 */
export function assembleCardSyncPayloadV2(draft: CardSyncDraftV2): CardSyncAssembledPayloadV2 {
  let keys: ReturnType<typeof assignCardDedupeKeys> | null = null;
  try {
    keys = assignCardDedupeKeys(draft.rows);
  } catch {
    keys = null;
  }
  const rows = draft.rows.map((row, index) => {
    const key = keys?.[index];
    return {
      transactionDate: row.transactionDate,
      postedDate: row.postedDate,
      status: row.status,
      amountMinor: row.amountMinor,
      kind: row.kind,
      description: row.description,
      merchant: row.merchant,
      issuerCategory: row.issuerCategory,
      externalIdHash: row.externalIdHash,
      fingerprint: key && 'fingerprint' in key ? key.fingerprint : null,
      cardScopeId: row.cardScopeId,
      identityNamespace: row.identityNamespace,
      secondaryIds: row.secondaryIds.map((secondary) => ({ namespace: secondary.namespace, idHash: secondary.idHash })),
      originalAmountMinor: row.originalAmountMinor,
      originalCurrency: row.originalCurrency,
    };
  });
  let totals: CardImportTotals | null = null;
  try {
    totals = summarizeCardImportRows(rows);
  } catch {
    totals = null;
  }
  return {
    format: CARD_IMPORT_FORMAT,
    version: CARD_SYNC_V2_VERSION,
    contractVersion: draft.contractVersion,
    source: draft.source,
    parserVersion: draft.parserVersion,
    issuer: draft.issuer,
    currency: draft.currency,
    owner: draft.owner,
    cards: draft.cards,
    bindingId: draft.bindingId,
    bindingVersion: draft.bindingVersion,
    captureId: draft.captureId,
    observedAt: draft.observedAt,
    mode: draft.mode,
    coverage: draft.coverage,
    rejectedCount: draft.rejectedCount,
    statement: draft.statement,
    totals,
    rows,
  };
}

/**
 * The `observed` range a coverage entry must carry for `rows` (one scope and
 * status) on a transaction or posted basis: the inclusive hull of their
 * dates, or null without rows. Undefined when a row has no posted date on a
 * posted basis: use the transaction basis then.
 */
export function cardSyncObservedRange(
  rows: ReadonlyArray<Pick<CardSyncRowV2, 'transactionDate' | 'postedDate'>>,
  basis: 'transaction' | 'posted',
): CardSyncDateRange | null | undefined {
  return observedHull(rows, basis);
}
