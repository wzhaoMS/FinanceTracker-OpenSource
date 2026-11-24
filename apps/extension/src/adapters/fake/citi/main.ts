/**
 * Fake Citi, MAIN passive over XHR (test build only). The page's own XHRs
 * load the card tiles and, on "Load more", further pages of activity whose
 * continuation flag is the string "true" or "false" (compared as strings,
 * never by truthiness). A "show cached" button reveals rows without any
 * request; the observer then sees nothing new and claims nothing more.
 * Account ids (in the request path) and cardholder names stay in the page.
 */
import {
  cardAmountFromIssuerSigned,
  parseDecimalToMinor,
  type CardTransactionKind,
  type ProjectedAccountCandidate,
  type ProjectedTransaction,
} from '@finance-tracker/shared';
import { SHAPE_CHANGED, type MainAdapter, type MainProjection, type ObserveContract } from '../../../main/observer.js';
import { assembleBatch, coverageEntry, dayFromUsDate, isShapeDrift, last4FromMask, productHint, projectRow, type RowInput } from '../../../projection/project.js';
import type { StreamContext } from '../../../projection/stream.js';
import { hasExactKeys, isRecord, list, str, strOrNull } from '../../read.js';
import { FAKE_CITI } from '../descriptors.js';

const ORIGIN = FAKE_CITI.pageOrigin;
const TRANSACTIONS_PATH = /^\/gcg-fake\/v1\/accounts\/([A-Za-z0-9-]{1,40})\/transactions\/retrieve$/;

function bodyMatches(body: unknown): boolean {
  if (!isRecord(body) || !hasExactKeys(body, ['nextTableIndex', 'moreTransactionsFlag', 'isRedesignPage'])) return false;
  const index = body.nextTableIndex;
  const more = body.moreTransactionsFlag;
  return body.isRedesignPage === true
    && (index === null || (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index <= 1_000))
    && (more === null || more === 'true');
}

export const FAKE_CITI_CONTRACTS: readonly ObserveContract[] = Object.freeze([
  {
    contract: 'citi.accounts.tiles.observe',
    method: 'GET',
    origin: ORIGIN,
    path: /^\/gcg-fake\/v1\/dashboard\/tiles$/,
    template: '/gcg-fake/v1/dashboard/tiles',
    queryKeys: [],
    requestBody: 'none',
    maxResponseBytes: 512 * 1024,
  },
  {
    contract: 'citi.transactions.observe',
    method: 'POST',
    origin: ORIGIN,
    path: TRANSACTIONS_PATH,
    template: '/gcg-fake/v1/accounts/:opaque/transactions/retrieve',
    queryKeys: [],
    requestBody: bodyMatches,
    maxResponseBytes: 2 * 1024 * 1024,
  },
]);

const KINDS: Readonly<Record<string, CardTransactionKind>> = Object.freeze({ PURCHASE: 'purchase', CREDIT: 'refund', PAYMENT: 'payment', FEE: 'fee', INTEREST: 'interest' });

function enumValue<T>(table: Readonly<Record<string, T>>, key: string | undefined): T | undefined {
  return key !== undefined && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

const known = new Map<string, ProjectedAccountCandidate>();

/** The response no longer matches the contract (a field missing, a type changed, an unknown enum): the issuer's contract pauses. */
function refused(): MainProjection {
  return SHAPE_CHANGED;
}

function tiles(json: unknown, stream: StreamContext): MainProjection {
  if (!isRecord(json)) return refused();
  const accounts = list(json, 'creditCardAccounts', 20);
  if (!accounts) return refused();
  known.clear();
  const seen: Array<{ ref: string; last4: string | null; name: string | null }> = [];
  for (const account of accounts) {
    if (!isRecord(account)) return refused();
    const accountId = str(account, 'accountId', 40);
    if (!accountId) return refused();
    seen.push({ ref: stream.candidateRef(accountId), last4: last4FromMask(str(account, 'displayNumber', 16) ?? null), name: str(account, 'name', 200) ?? null });
  }
  stream.noteHints(seen.map((account) => account.last4));
  for (const account of seen) known.set(account.ref, { ref: account.ref, last4: account.last4, productHint: productHint(account.name, stream.hints()) });
  return assembleBatch({
    contract: 'citi.accounts.tiles.observe',
    streamHandle: stream.streamHandle,
    sequence: stream.nextSequence(),
    observedAt: stream.observedAt(),
    accounts: [...known.values()],
    transactions: [],
    coverage: [],
    rejectedCount: 0,
  });
}

function transactions(json: unknown, accountId: string, pageIndex: number | null, stream: StreamContext): MainProjection | null {
  if (!isRecord(json)) return refused();
  const pending = list(json, 'pendingTransactions', 1_000);
  const posted = list(json, 'postedTransactions', 1_000);
  const flag = str(json, 'moreTransactionsFlag', 8);
  if (!pending || !posted || (flag !== 'true' && flag !== 'false')) return refused();
  const accountRef = stream.candidateRef(accountId);
  const page = `${accountRef} ${pageIndex ?? 'first'}`;
  const candidate = known.get(accountRef) ?? { ref: accountRef, last4: null, productHint: null };
  const inputs: RowInput[] = [];
  let rejected = 0;
  for (const [status, items] of [['pending', pending], ['posted', posted]] as const) {
    for (const raw of items) {
      if (!isRecord(raw)) return refused();
      const kind = enumValue(KINDS, str(raw, 'transactionType', 16));
      const amountText = str(raw, 'amount', 32);
      const transactionDate = dayFromUsDate(str(raw, 'purchaseDate', 10) ?? '');
      const postedText = strOrNull(raw, 'postedDate', 10);
      const member = str(raw, 'cardMemberName', 200);
      const id = str(raw, 'transactionId', 64);
      if (!kind || amountText === undefined || transactionDate === null || postedText === undefined || member === undefined) return refused();
      const minor = parseDecimalToMinor(amountText, 2);
      const signed = minor.ok ? cardAmountFromIssuerSigned(minor.minor, 'debit-positive') : minor;
      const postedDate = status === 'posted' && postedText !== null ? dayFromUsDate(postedText) : null;
      // An amount the contract cannot read is a changed form, not one bad row.
      if (!signed.ok) return refused();
      inputs.push({
        accountRef,
        holderRef: stream.holderRef(member),
        cardLast4: null,
        transactionDate,
        postedDate,
        status,
        amountMinor: signed.minor,
        kind,
        description: str(raw, 'description') ?? null,
        merchant: null,
        issuerCategory: null,
        primaryId: id ? { namespace: 'citi-api:transaction:v1', raw: id } : null,
        secondaryIds: [],
        original: null,
      });
    }
  }
  stream.noteHints([candidate.last4]);
  const hints = stream.hints();
  const rows: ProjectedTransaction[] = [];
  for (const input of inputs) {
    const projected = projectRow(input, 'citi.transactions.observe', hints);
    if (projected.ok) rows.push(projected.row);
    else if (isShapeDrift(projected.reason)) return refused();
    else rejected += 1;
  }
  // Every response is checked for a changed form first; a page already sent is then not sent again.
  if (stream.pageSeen(page)) return null;
  const termination = flag === 'true' ? 'more-available' : 'end-marker';
  const coverage = (['posted', 'pending'] as const).map((status) =>
    coverageEntry(rows, { accountRef, status, requested: null, pageCount: 1, termination, rejectedCount: rejected }),
  );
  const result = assembleBatch({
    contract: 'citi.transactions.observe',
    streamHandle: stream.streamHandle,
    sequence: stream.nextSequence(),
    observedAt: stream.observedAt(),
    accounts: [candidate],
    transactions: rows,
    coverage,
    rejectedCount: rejected,
  });
  if (result.ok) stream.notePage(page);
  return result;
}

export const FAKE_CITI_MAIN: MainAdapter = {
  adapterId: FAKE_CITI.id,
  issuer: FAKE_CITI.issuer,
  contracts: FAKE_CITI_CONTRACTS,
  project(observed, stream) {
    if (observed.contract.contract === 'citi.accounts.tiles.observe') return tiles(observed.json, stream);
    if (observed.contract.contract !== 'citi.transactions.observe' || !isRecord(observed.requestBody)) return null;
    const match = TRANSACTIONS_PATH.exec(observed.requestUrl.pathname);
    const index = observed.requestBody.nextTableIndex;
    return match ? transactions(observed.json, match[1], typeof index === 'number' ? index : null, stream) : null;
  },
};

export const FAKE_CITI_SHAPE: MainAdapter = { adapterId: FAKE_CITI.id, issuer: FAKE_CITI.issuer, contracts: FAKE_CITI_CONTRACTS, shapeContracts: FAKE_CITI.shapeContracts, project: () => null };
