/**
 * `projected-bank-batch/v1`: what a page-side collector hands on before any
 * binding exists (plan §4.1): MAIN → ISOLATED for passive observation, and
 * inside the isolated collector for isolated reads and the rendered DOM.
 *
 * It carries the fixed issuer and read contract, a page-generated stream
 * handle, redacted account candidates, normalized transactions and coverage
 * evidence per account. It has no card scope, binding or capture (those are
 * assigned after the user confirms the mapping in the isolated world or the
 * worker), and no URL, header, cookie, selector, token, name or raw state:
 * every key is fixed and every other key is refused. Transactions are already
 * redacted and hashed exactly as in v2 (`prepareCardSyncText`,
 * `cardExternalIdHash`); a row without a stable id has `externalIdHash: null`
 * and gets its fingerprint only when the v2 payload is built.
 *
 * It is a separate type from the v2 payload; nothing is shared by widening.
 */
import { CARD_IMPORT_MAX_TOTAL_MINOR, summarizeCardImportRows } from '../cardImport.js';
import type { JsonObject } from './canonical.js';
import { CardHintSet, cardSyncCombinedTextIssue } from './crossField.js';
import { isCardSyncId } from './ids.js';
import { CardSyncIssueList, cardSyncIndexPath, type CardSyncIssue } from './issues.js';
import {
  CARD_SYNC_CURRENCIES,
  CARD_SYNC_ISSUERS,
  CARD_SYNC_READ_CONTRACT_IDS,
  CARD_SYNC_READ_CONTRACTS,
  CARD_SYNC_SOURCE_SPECS,
  isSupportedCardSyncContractVersion,
  type CardSyncCurrency,
  type CardSyncIssuer,
  type CardSyncReadContractId,
} from './registry.js';
import { isJsonObject, snapshotStrictJson, type StrictJsonLimits } from './strictJson.js';
import { CARD_SYNC_TEXT_LIMITS } from './text.js';
import {
  BAD,
  checkCoverageAgainstRows,
  checkCoverageCore,
  checkRepeatedIds,
  checkRowCore,
  DATE_RANGE_KEYS,
  field,
  Fields,
  SECONDARY_ID_KEYS,
  type CoverageCore,
  type RowCore,
} from './wireChecks.js';
import type { CardSyncDateRange, CardSyncRowStatus, CardSyncSecondaryId } from './wireV2.js';
import type { CardSyncCompleteness, CardSyncIdentityNamespace, CardSyncTermination } from './registry.js';
import type { CardTransactionKind } from '../types.js';

export const PROJECTED_BANK_BATCH_TYPE = 'projected-bank-batch/v1';
export const PROJECTED_BATCH_MAX_ACCOUNTS = 20;
export const PROJECTED_BATCH_MAX_HOLDER_GROUPS = 20;
/** Distinct per-row `cardLast4` values in one batch. */
export const PROJECTED_BATCH_MAX_CARD_HINTS = 20;
export const PROJECTED_BATCH_MAX_TRANSACTIONS = 2_000;
export const PROJECTED_BATCH_MAX_COVERAGE = 40;
export const PROJECTED_BATCH_MAX_SEQUENCE = 9_999;
export const PROJECTED_BATCH_MAX_BYTES = 2 * 1024 * 1024;

export interface ProjectedAccountCandidate {
  /** Page-generated `cnd_…` reference, unique within the batch. */
  ref: string;
  /** The last four digits the issuer displays for the account, when it does. */
  last4: string | null;
  /** Redacted product text such as a card name; never the issuer's combined name-and-number string. */
  productHint: string | null;
}

export interface ProjectedTransaction {
  /** The candidate the row belongs to. */
  accountRef: string;
  /** Page-generated `hld_…` group for rows that share an issuer cardholder field; the field itself never leaves the page. */
  holderRef: string | null;
  /** The card's last four digits when the issuer gives them per row. */
  cardLast4: string | null;
  transactionDate: string;
  postedDate: string | null;
  status: CardSyncRowStatus;
  amountMinor: number;
  kind: CardTransactionKind;
  description: string;
  merchant: string | null;
  issuerCategory: string | null;
  externalIdHash: string | null;
  identityNamespace: CardSyncIdentityNamespace;
  secondaryIds: CardSyncSecondaryId[];
  originalAmountMinor: number | null;
  originalCurrency: string | null;
}

export interface ProjectedCoverageEntry {
  accountRef: string;
  status: CardSyncRowStatus;
  requested: CardSyncDateRange | null;
  observed: CardSyncDateRange | null;
  completeness: CardSyncCompleteness;
  pageCount: number;
  termination: CardSyncTermination;
}

export interface ProjectedBankBatchV1 {
  type: typeof PROJECTED_BANK_BATCH_TYPE;
  contractVersion: number;
  issuer: CardSyncIssuer;
  contract: CardSyncReadContractId;
  /** Page-generated `stm_…` handle for one document's stream; a new document gets a new handle. */
  streamHandle: string;
  /** Message number within the stream, from 0, so repeats and stale messages can be dropped. */
  sequence: number;
  observedAt: string;
  currency: CardSyncCurrency;
  accounts: ProjectedAccountCandidate[];
  transactions: ProjectedTransaction[];
  coverage: ProjectedCoverageEntry[];
  rejectedCount: number;
}

export type ProjectedBankBatchValidation =
  | { ok: true; batch: ProjectedBankBatchV1; byteLength: number }
  | { ok: false; issues: CardSyncIssue[] };

export const PROJECTED_BATCH_KEYS = [
  'type', 'contractVersion', 'issuer', 'contract', 'streamHandle', 'sequence', 'observedAt', 'currency', 'accounts',
  'transactions', 'coverage', 'rejectedCount',
] as const;
export const PROJECTED_ACCOUNT_KEYS = ['ref', 'last4', 'productHint'] as const;
export const PROJECTED_TRANSACTION_KEYS = [
  'accountRef', 'holderRef', 'cardLast4', 'transactionDate', 'postedDate', 'status', 'amountMinor', 'kind',
  'description', 'merchant', 'issuerCategory', 'externalIdHash', 'identityNamespace', 'secondaryIds',
  'originalAmountMinor', 'originalCurrency',
] as const;
export const PROJECTED_COVERAGE_KEYS = [
  'accountRef', 'status', 'requested', 'observed', 'completeness', 'pageCount', 'termination',
] as const;

export const PROJECTED_BATCH_KNOWN_KEYS: ReadonlySet<string> = new Set<string>([
  ...PROJECTED_BATCH_KEYS, ...PROJECTED_ACCOUNT_KEYS, ...PROJECTED_TRANSACTION_KEYS, ...PROJECTED_COVERAGE_KEYS,
  ...DATE_RANGE_KEYS, ...SECONDARY_ID_KEYS,
]);

export const PROJECTED_BATCH_LIMITS: Readonly<StrictJsonLimits> = Object.freeze({
  maxDepth: 6,
  maxKeysPerObject: 32,
  maxArrayLength: PROJECTED_BATCH_MAX_TRANSACTIONS,
  maxNodes: 60_000,
  maxStringLength: 1_024,
  maxKeyLength: 64,
  maxBytes: PROJECTED_BATCH_MAX_BYTES,
});

const LAST4 = /^[0-9]{4}$/;

function fail(issues: CardSyncIssueList): ProjectedBankBatchValidation {
  if (issues.size === 0) issues.add('unreadable', '$');
  return { ok: false, issues: issues.list };
}

interface ProjectedRowChecked extends RowCore {
  accountRef: string;
  holderRef: string | null;
  cardLast4: string | null;
}

interface ProjectedCoverageChecked extends CoverageCore {
  accountRef: string;
}

function copyRange(range: CardSyncDateRange | null): CardSyncDateRange | null {
  return range === null ? null : { start: range.start, end: range.end, dateBasis: range.dateBasis };
}

/**
 * Strict, refuse-only validation of an untrusted projected batch: the same
 * strict JSON, text, amount, date, identity and coverage rules as v2, plus
 * declared account references and the read contract's issuer and kind.
 * Never throws.
 */
export function validateProjectedBankBatch(value: unknown): ProjectedBankBatchValidation {
  const snapshot = snapshotStrictJson(value, { limits: PROJECTED_BATCH_LIMITS, knownKeys: PROJECTED_BATCH_KNOWN_KEYS });
  if (!snapshot.ok) return { ok: false, issues: snapshot.issues };
  const issues = new CardSyncIssueList();
  const fields = new Fields(issues);
  const root = snapshot.value;
  if (!isJsonObject(root)) {
    issues.add('wrong-type', '$');
    return fail(issues);
  }
  const type = field(root, 'type');
  const contractVersion = field(root, 'contractVersion');
  if (type === BAD) issues.add('missing-key', '$.type');
  else if (type !== PROJECTED_BANK_BATCH_TYPE) issues.add('unsupported-format', '$.type');
  else if (contractVersion === BAD) issues.add('missing-key', '$.contractVersion');
  else if (!isSupportedCardSyncContractVersion(contractVersion)) issues.add('unsupported-contract', '$.contractVersion');
  if (issues.size > 0) return fail(issues);
  fields.object(root, '$', PROJECTED_BATCH_KEYS);

  const issuer = fields.enumValue(root, 'issuer', '$', CARD_SYNC_ISSUERS);
  const contract = fields.enumValue(root, 'contract', '$', CARD_SYNC_READ_CONTRACT_IDS);
  const spec = contract === BAD ? null : CARD_SYNC_READ_CONTRACTS[contract];
  if (spec && issuer !== BAD && spec.issuer !== issuer) fields.bad('source-mismatch', '$.contract');
  const streamHandle = fields.id(root, 'streamHandle', '$', 'stream');
  const sequence = fields.integer(root, 'sequence', '$', 0, PROJECTED_BATCH_MAX_SEQUENCE);
  const observedAt = fields.timestamp(root, 'observedAt', '$');
  const currency = fields.enumValue(root, 'currency', '$', CARD_SYNC_CURRENCIES);
  const rejectedCount = fields.integer(root, 'rejectedCount', '$', 0, PROJECTED_BATCH_MAX_TRANSACTIONS);

  // Account candidates.
  const accountList = fields.array(root, 'accounts', '$', PROJECTED_BATCH_MAX_ACCOUNTS);
  const accounts: ProjectedAccountCandidate[] = [];
  const refs = new Set<string>();
  let accountsOk = accountList !== BAD;
  if (accountList !== BAD) {
    accountList.forEach((item, index) => {
      const at = cardSyncIndexPath('$.accounts', index);
      const before = issues.size;
      const account = fields.object(item, at, PROJECTED_ACCOUNT_KEYS);
      if (!account) {
        accountsOk = false;
        return;
      }
      const ref = fields.id(account, 'ref', at, 'accountCandidate');
      const last4 = fields.nullableMatching(account, 'last4', at, (text) => LAST4.test(text));
      const productHint = fields.text(account, 'productHint', at, CARD_SYNC_TEXT_LIMITS.productHint, true);
      if (ref !== BAD) {
        if (refs.has(ref)) fields.bad('duplicate', `${at}.ref`);
        refs.add(ref);
      }
      if (issues.size !== before || ref === BAD || last4 === BAD || productHint === BAD) {
        accountsOk = false;
        return;
      }
      accounts.push({ ref, last4, productHint });
    });
  }

  const reference = (object: JsonObject, at: string): string | typeof BAD => {
    const ref = fields.id(object, 'accountRef', at, 'accountCandidate');
    if (ref === BAD) return BAD;
    if (accountsOk && !refs.has(ref)) return fields.bad('unknown-reference', `${at}.accountRef`);
    return ref;
  };

  // Coverage evidence per account and status.
  const coverageList = fields.array(root, 'coverage', '$', PROJECTED_BATCH_MAX_COVERAGE);
  const coverage: ProjectedCoverageChecked[] = [];
  let coverageOk = coverageList !== BAD;
  if (coverageList !== BAD) {
    coverageList.forEach((item, index) => {
      const at = cardSyncIndexPath('$.coverage', index);
      const before = issues.size;
      const entry = fields.object(item, at, PROJECTED_COVERAGE_KEYS);
      if (!entry) {
        coverageOk = false;
        return;
      }
      const accountRef = reference(entry, at);
      const core = checkCoverageCore(fields, entry, at);
      if (!core || accountRef === BAD || issues.size !== before) {
        coverageOk = false;
        return;
      }
      coverage.push({ accountRef, ...core });
    });
  }

  // Transactions.
  const source = spec?.source ? CARD_SYNC_SOURCE_SPECS[spec.source] : null;
  const rowList = fields.array(root, 'transactions', '$', PROJECTED_BATCH_MAX_TRANSACTIONS);
  const rows: ProjectedRowChecked[] = [];
  let rowsOk = rowList !== BAD;
  if (rowList !== BAD) {
    if (rejectedCount !== BAD && rowList.length + rejectedCount > PROJECTED_BATCH_MAX_TRANSACTIONS) {
      fields.bad('too-many-items', '$.transactions');
      rowsOk = false;
    } else {
      const context = { source, currency: currency === BAD ? null : currency };
      for (let index = 0; index < rowList.length && !issues.full; index += 1) {
        const at = cardSyncIndexPath('$.transactions', index);
        const before = issues.size;
        const row = fields.object(rowList[index], at, PROJECTED_TRANSACTION_KEYS);
        if (!row) {
          rowsOk = false;
          continue;
        }
        const accountRef = reference(row, at);
        const holderRef = fields.nullableMatching(row, 'holderRef', at, (text) => isCardSyncId('holderGroup', text));
        const cardLast4 = fields.nullableMatching(row, 'cardLast4', at, (text) => LAST4.test(text));
        const core = checkRowCore(fields, row, at, context);
        if (!core || accountRef === BAD || holderRef === BAD || cardLast4 === BAD || issues.size !== before) {
          rowsOk = false;
          continue;
        }
        rows.push({ ...core, accountRef, holderRef, cardLast4 });
      }
      if (issues.full) rowsOk = false;
    }
  }

  if (spec && spec.produces === 'accounts') {
    // Discovery contracts carry account candidates only.
    if (rowList !== BAD && rowList.length > 0) fields.bad('inconsistent', '$.transactions');
    if (coverageList !== BAD && coverageList.length > 0) fields.bad('inconsistent', '$.coverage');
    if (rejectedCount !== BAD && rejectedCount > 0) fields.bad('inconsistent', '$.rejectedCount');
  } else if (rowsOk) {
    const holders = new Set(rows.map((row) => row.holderRef).filter((ref) => ref !== null));
    const cardHints = new Set(rows.map((row) => row.cardLast4).filter((last4): last4 is string => last4 !== null));
    if (holders.size > PROJECTED_BATCH_MAX_HOLDER_GROUPS || cardHints.size > PROJECTED_BATCH_MAX_CARD_HINTS) {
      fields.bad('too-many-items', '$.transactions');
    }
    checkRepeatedIds(fields, rows, '$.transactions', (row) => row.accountRef);
    // Text that only shows card data or a secret once fields, or text and any last four in the
    // batch, are put together.
    const hints = new CardHintSet([...accounts.map((account) => account.last4).filter((last4): last4 is string => last4 !== null), ...cardHints]);
    rows.forEach((row, index) => {
      const combined = cardSyncCombinedTextIssue([row.description, row.merchant, row.issuerCategory], hints);
      if (combined) fields.bad(combined, cardSyncIndexPath('$.transactions', index));
    });
    const totals = summarizeCardImportRows(rows);
    for (const summary of [totals.posted, totals.pending]) {
      if (Math.max(summary.chargesMinor, -summary.creditsMinor) > CARD_IMPORT_MAX_TOTAL_MINOR) fields.bad('out-of-range', '$.transactions');
    }
    if (coverageOk && rejectedCount !== BAD) {
      checkCoverageAgainstRows(
        fields, coverage, (entry) => entry.accountRef, '$.coverage', rows, (row) => row.accountRef, 'accountRef', '$.transactions',
        rejectedCount, observedAt === BAD ? null : observedAt,
      );
    }
  }

  if (accountsOk) {
    // A product hint next to any last four in the batch must not complete a card number.
    const hints = new CardHintSet([
      ...accounts.map((account) => account.last4).filter((last4): last4 is string => last4 !== null),
      ...(rowsOk ? rows.map((row) => row.cardLast4).filter((last4): last4 is string => last4 !== null) : []),
    ]);
    accounts.forEach((account, index) => {
      const combined = cardSyncCombinedTextIssue([account.productHint], hints);
      if (combined) fields.bad(combined, cardSyncIndexPath('$.accounts', index));
    });
  }

  if (issues.size === 0 && rowsOk && coverageOk && accountsOk && spec) {
    const batch: ProjectedBankBatchV1 = {
      type: PROJECTED_BANK_BATCH_TYPE,
      contractVersion: contractVersion as number,
      issuer: issuer as CardSyncIssuer,
      contract: contract as CardSyncReadContractId,
      streamHandle: streamHandle as string,
      sequence: sequence as number,
      observedAt: observedAt as string,
      currency: currency as CardSyncCurrency,
      accounts: accounts.map((account) => ({ ref: account.ref, last4: account.last4, productHint: account.productHint })),
      transactions: rows.map((row) => ({
        accountRef: row.accountRef,
        holderRef: row.holderRef,
        cardLast4: row.cardLast4,
        transactionDate: row.transactionDate,
        postedDate: row.postedDate,
        status: row.status,
        amountMinor: row.amountMinor,
        kind: row.kind,
        description: row.description,
        merchant: row.merchant,
        issuerCategory: row.issuerCategory,
        externalIdHash: row.externalIdHash,
        identityNamespace: row.identityNamespace,
        secondaryIds: row.secondaryIds.map((secondary) => ({ namespace: secondary.namespace, idHash: secondary.idHash })),
        originalAmountMinor: row.originalAmountMinor,
        originalCurrency: row.originalCurrency,
      })),
      coverage: coverage.map((entry) => ({
        accountRef: entry.accountRef,
        status: entry.status,
        requested: copyRange(entry.requested),
        observed: copyRange(entry.observed),
        completeness: entry.completeness,
        pageCount: entry.pageCount,
        termination: entry.termination,
      })),
      rejectedCount: rejectedCount as number,
    };
    return { ok: true, batch, byteLength: snapshot.byteLength };
  }
  return fail(issues);
}
