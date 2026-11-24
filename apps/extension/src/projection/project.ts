/**
 * Page-side projection: the only way an adapter turns issuer data into a
 * `projected-bank-batch/v1`. Runs in the page (MAIN or ISOLATED) before
 * anything leaves it, on new objects only:
 *
 * - each row's text through `prepareCardSyncRowText` with the stream's card
 *   hints (every candidate last four and row `cardLast4` seen): the complete
 *   text is redacted first, card secrets refused, nothing raw-truncated, and
 *   runs that would rebuild a card number together are redacted (contract 7a);
 * - amounts already signed by the adapter with the contract's helpers, then
 *   checked against the kind's sign rule;
 * - issuer ids through `cardExternalIdHash`, never account tokens or numbers;
 * - an identity (candidate, namespace, digest) that repeats within the batch
 *   turns every row carrying it into a capture-namespace fingerprint row, so
 *   every row is kept (contract section 15);
 * - coverage claims at most what its termination allows;
 * - the finished batch must pass `validateProjectedBankBatch`, or nothing is
 *   posted (the caller sends a fixed status code instead).
 *
 * A row the contract would refuse is dropped and counted in `rejectedCount`;
 * the reason stays a fixed code and is never paired with a value.
 */
import {
  CARD_IMPORT_MAX_AMOUNT_MINOR,
  CARD_IMPORT_NO_DESCRIPTION,
  CARD_SYNC_CONTRACT_VERSION,
  CARD_SYNC_READ_CONTRACTS,
  CARD_SYNC_SOURCE_SPECS,
  CARD_SYNC_TEXT_LIMITS,
  CardHintSet,
  PROJECTED_BANK_BATCH_TYPE,
  cardAmountSignAllowed,
  cardExternalIdHash,
  cardSyncCombinedTextIssue,
  cardSyncCurrencyExponent,
  cardSyncObservedRange,
  isCardImportDate,
  prepareCardSyncRowText,
  prepareCardSyncText,
  validateProjectedBankBatch,
  type CardSyncDateRange,
  type CardSyncIdentityNamespace,
  type CardSyncReadContractId,
  type CardSyncTermination,
  type CardTransactionKind,
  type ProjectedAccountCandidate,
  type ProjectedBankBatchValidation,
  type ProjectedCoverageEntry,
  type ProjectedTransaction,
} from '@finance-tracker/shared';
import { completenessFor } from './completeness.js';

export type RowRefusal = 'text' | 'amount' | 'sign' | 'date' | 'id' | 'original';

export interface RawIssuerId {
  namespace: CardSyncIdentityNamespace;
  /** The issuer's transaction id, already proven by the adapter contract not to be an account token, card or account number. */
  raw: string;
}

export interface RowInput {
  accountRef: string;
  holderRef: string | null;
  cardLast4: string | null;
  transactionDate: string;
  postedDate: string | null;
  status: 'pending' | 'posted';
  /** Holdr's signed minor units, from `parseDecimalToMinor` / `parseJsonNumberToMinor` and one sign helper. */
  amountMinor: number;
  kind: CardTransactionKind;
  description: string | null;
  merchant: string | null;
  issuerCategory: string | null;
  primaryId: RawIssuerId | null;
  secondaryIds: readonly RawIssuerId[];
  original: { amountMinor: number; currency: string } | null;
}

export type RowProjection = { ok: true; row: ProjectedTransaction } | { ok: false; reason: RowRefusal };

/**
 * Refusals that mean the issuer's form changed (plan §4: "类型/符号变化 … 使此契约暂停"): a
 * sign, date or id no longer as the contract describes. They pause the contract instead of
 * rejecting one row. Text that cannot be made safe and out-of-range amounts are row rejections.
 */
export function isShapeDrift(reason: RowRefusal): boolean {
  return reason === 'sign' || reason === 'date' || reason === 'id';
}

const RAW_ID = /^[\x21-\x7e]{1,128}$/;
const LAST4 = /^[0-9]{4}$/;

/** A row's `cardLast4` as projected: exactly four digits, or null. */
export function rowLast4(value: string | null): string | null {
  return value !== null && LAST4.test(value) ? value : null;
}

/**
 * One issuer row to a projected transaction, or a fixed refusal reason.
 * `hints` are the stream's card hints (`StreamContext.hints()`), noted before
 * the rows of a response are projected.
 */
export function projectRow(input: RowInput, readContract: CardSyncReadContractId, hints: Iterable<string>): RowProjection {
  const spec = CARD_SYNC_READ_CONTRACTS[readContract];
  const source = spec.source ? CARD_SYNC_SOURCE_SPECS[spec.source] : null;
  if (!source) return { ok: false, reason: 'id' };
  if (!isCardImportDate(input.transactionDate)) return { ok: false, reason: 'date' };
  const postedDate = input.status === 'pending' ? null : input.postedDate;
  if (postedDate !== null && !isCardImportDate(postedDate)) return { ok: false, reason: 'date' };
  if (!Number.isSafeInteger(input.amountMinor) || Math.abs(input.amountMinor) > CARD_IMPORT_MAX_AMOUNT_MINOR) return { ok: false, reason: 'amount' };
  if (!cardAmountSignAllowed(input.kind, input.amountMinor)) return { ok: false, reason: 'sign' };

  const text = prepareCardSyncRowText({ description: input.description, merchant: input.merchant, issuerCategory: input.issuerCategory }, { hints });
  if (!text.ok) return { ok: false, reason: 'text' };

  let externalIdHash: string | null = null;
  let identityNamespace: CardSyncIdentityNamespace = source.captureNamespace;
  if (input.primaryId) {
    if (!RAW_ID.test(input.primaryId.raw) || !source.stableNamespaces.includes(input.primaryId.namespace)) return { ok: false, reason: 'id' };
    externalIdHash = cardExternalIdHash(input.primaryId.raw);
    identityNamespace = input.primaryId.namespace;
  }
  const secondaryIds: Array<{ namespace: CardSyncIdentityNamespace; idHash: string }> = [];
  if (externalIdHash !== null) {
    for (const secondary of input.secondaryIds) {
      if (!RAW_ID.test(secondary.raw) || !source.stableNamespaces.includes(secondary.namespace)) return { ok: false, reason: 'id' };
      if (secondary.namespace === identityNamespace || secondaryIds.some((item) => item.namespace === secondary.namespace)) continue;
      if (secondaryIds.length >= 3) continue;
      secondaryIds.push({ namespace: secondary.namespace, idHash: cardExternalIdHash(secondary.raw) });
    }
  }

  let originalAmountMinor: number | null = null;
  let originalCurrency: string | null = null;
  if (input.original) {
    const { amountMinor, currency } = input.original;
    const confirmed = cardSyncCurrencyExponent(currency) !== null && currency !== 'USD';
    const sameSign = Math.sign(amountMinor) === Math.sign(input.amountMinor);
    if (confirmed && sameSign && Number.isSafeInteger(amountMinor) && Math.abs(amountMinor) <= CARD_IMPORT_MAX_AMOUNT_MINOR) {
      originalAmountMinor = amountMinor;
      originalCurrency = currency;
    }
  }

  return {
    ok: true,
    row: {
      accountRef: input.accountRef,
      holderRef: input.holderRef,
      cardLast4: rowLast4(input.cardLast4),
      transactionDate: input.transactionDate,
      postedDate,
      status: input.status,
      amountMinor: input.amountMinor + 0,
      kind: input.kind,
      description: text.description || CARD_IMPORT_NO_DESCRIPTION,
      merchant: text.merchant || null,
      issuerCategory: text.issuerCategory || null,
      externalIdHash,
      identityNamespace,
      secondaryIds,
      originalAmountMinor,
      originalCurrency,
    },
  };
}

/**
 * Rows whose identity (candidate, namespace, digest), primary or secondary,
 * appears more than once in the batch become fingerprint rows of the source's
 * capture namespace (no id, no secondary ids), as the validator keys
 * identities. Nothing is dropped.
 */
export function demoteRepeatedIds(rows: readonly ProjectedTransaction[], captureNamespace: CardSyncIdentityNamespace): ProjectedTransaction[] {
  const identity = (row: ProjectedTransaction, namespace: string, hash: string) => `${row.accountRef}\u0000${namespace}\u0000${hash}`;
  const keysOf = (row: ProjectedTransaction): string[] => [
    ...(row.externalIdHash !== null ? [identity(row, row.identityNamespace, row.externalIdHash)] : []),
    ...row.secondaryIds.map((secondary) => identity(row, secondary.namespace, secondary.idHash)),
  ];
  const counts = new Map<string, number>();
  for (const row of rows) for (const key of keysOf(row)) counts.set(key, (counts.get(key) ?? 0) + 1);
  return rows.map((row) => {
    if (!keysOf(row).some((key) => (counts.get(key) ?? 0) > 1)) return row;
    return { ...row, externalIdHash: null, identityNamespace: captureNamespace, secondaryIds: [] };
  });
}

export interface CoverageInput {
  accountRef: string;
  status: 'pending' | 'posted';
  requested: { start: string; end: string } | null;
  pageCount: number;
  termination: CardSyncTermination;
  rejectedCount: number;
}

/**
 * One coverage entry for an account and status on the `transaction` basis:
 * `observed` is the rows' hull exactly as the validator recomputes it (null
 * without rows), and completeness is at most what the termination allows.
 */
export function coverageEntry(rows: readonly ProjectedTransaction[], input: CoverageInput): ProjectedCoverageEntry {
  const own = rows.filter((row) => row.accountRef === input.accountRef && row.status === input.status);
  const requested: CardSyncDateRange | null = input.requested ? { ...input.requested, dateBasis: 'transaction' } : null;
  const observed: CardSyncDateRange | null = input.termination === 'not-read' ? null : cardSyncObservedRange(own, 'transaction') ?? null;
  return {
    accountRef: input.accountRef,
    status: input.status,
    requested,
    observed,
    completeness: completenessFor(input.termination, requested, input.rejectedCount),
    pageCount: input.termination === 'not-read' ? 0 : Math.max(1, Math.min(100, input.pageCount)),
    termination: input.termination,
  };
}

export interface BatchInput {
  contract: CardSyncReadContractId;
  streamHandle: string;
  sequence: number;
  observedAt: string;
  accounts: readonly ProjectedAccountCandidate[];
  transactions: readonly ProjectedTransaction[];
  coverage: readonly ProjectedCoverageEntry[];
  rejectedCount: number;
}

/**
 * Builds and validates a projected batch; the caller may post only a batch
 * this accepts. A product hint that would complete a card number next to a
 * last four of this batch is left out (contract section 15).
 */
export function assembleBatch(input: BatchInput): ProjectedBankBatchValidation {
  const spec = CARD_SYNC_READ_CONTRACTS[input.contract];
  const source = spec.source ? CARD_SYNC_SOURCE_SPECS[spec.source] : null;
  const transactions = source ? demoteRepeatedIds(input.transactions, source.captureNamespace) : [...input.transactions];
  const hints = new CardHintSet([
    ...input.accounts.map((account) => account.last4).filter((last4): last4 is string => last4 !== null),
    ...transactions.map((row) => row.cardLast4).filter((last4): last4 is string => last4 !== null),
  ]);
  return validateProjectedBankBatch({
    type: PROJECTED_BANK_BATCH_TYPE,
    contractVersion: CARD_SYNC_CONTRACT_VERSION,
    issuer: spec.issuer,
    contract: input.contract,
    streamHandle: input.streamHandle,
    sequence: input.sequence,
    observedAt: input.observedAt,
    currency: 'USD',
    accounts: input.accounts.map((account) => ({
      ref: account.ref,
      last4: account.last4,
      productHint: account.productHint !== null && cardSyncCombinedTextIssue([account.productHint], hints) !== null ? null : account.productHint,
    })),
    transactions,
    coverage: [...input.coverage],
    rejectedCount: input.rejectedCount,
  });
}

/** A product hint for an account candidate: redacted canonical text up to 100 that completes no card number with `hints`, or null. */
export function productHint(raw: string | null, hints: Iterable<string>): string | null {
  if (raw === null) return null;
  const result = prepareCardSyncText(raw, CARD_SYNC_TEXT_LIMITS.productHint);
  if (!result.ok || result.text === '') return null;
  return cardSyncCombinedTextIssue([result.text], hints) === null ? result.text : null;
}

/** The last four digits of a displayed mask such as `…3391` or `XXXX3391`, or null; never the tail of an account id. */
export function last4FromMask(mask: string | null): string | null {
  if (typeof mask !== 'string') return null;
  const match = /^[^0-9]*([0-9]{4})$/.exec(mask.trim());
  return match ? match[1] : null;
}

/** `new Date(ms).toISOString()` within the contract's 1970–2099 window. */
export function isoTimestamp(ms: number): string {
  return new Date(Math.min(Math.max(ms, 0), Date.UTC(2099, 11, 31, 23, 59, 59, 999))).toISOString();
}

/** The issuer calendar day `YYYY-MM-DD` of a local `Date` (the browser's own time zone), without any UTC shift. */
export function localDay(date: Date): string {
  const pad = (value: number, size: number) => String(value).padStart(size, '0');
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

/** Strict `MM/DD/YYYY` to `YYYY-MM-DD` by string only (no Date, no time zone), or null. */
export function dayFromUsDate(text: string): string | null {
  const match = /^([0-9]{2})\/([0-9]{2})\/([0-9]{4})$/.exec(typeof text === 'string' ? text.trim() : '');
  if (!match) return null;
  const day = `${match[3]}-${match[1]}-${match[2]}`;
  return isCardImportDate(day) ? day : null;
}
