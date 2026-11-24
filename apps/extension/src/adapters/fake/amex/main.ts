/**
 * Fake American Express, MAIN passive (test build only). The activity page's
 * own script POSTs to a cross-origin wrapper (`functions.amex.e3.test`); the
 * observer reads a copy of those responses and projects them here, in the
 * page. Account tokens and cardholder names stay in this world: rows are
 * grouped under page-local `hld_` refs and accounts under `cnd_` refs. The
 * activity feed has no stable ids, so rows are capture fingerprints.
 */
import {
  cardAmountFromIssuerSigned,
  parseJsonNumberToMinor,
  type CardTransactionKind,
  type ProjectedAccountCandidate,
  type ProjectedTransaction,
} from '@finance-tracker/shared';
import { SHAPE_CHANGED, type MainAdapter, type MainProjection, type ObserveContract } from '../../../main/observer.js';
import { assembleBatch, coverageEntry, isShapeDrift, productHint, projectRow, type RowInput } from '../../../projection/project.js';
import type { StreamContext } from '../../../projection/stream.js';
import { bool, hasExactKeys, isRecord, list, num, str, strOrNull } from '../../read.js';
import { FAKE_AMEX } from '../descriptors.js';

const WRAPPER_ORIGIN = 'http://functions.amex.e3.test';

function requestBodyMatches(body: unknown): boolean {
  if (!isRecord(body) || !hasExactKeys(body, ['accountToken', 'locale', 'limit', 'offset', 'view'])) return false;
  const limit = num(body, 'limit');
  const offset = num(body, 'offset');
  return typeof str(body, 'accountToken', 64) === 'string'
    && str(body, 'locale', 8) === 'en-US'
    && str(body, 'view', 16) === 'RECENT'
    && limit !== undefined && Number.isInteger(limit) && limit >= 1 && limit <= 100
    && offset !== undefined && Number.isInteger(offset) && offset >= 0 && offset <= 10_000;
}

export const FAKE_AMEX_CONTRACTS: readonly ObserveContract[] = Object.freeze([
  {
    contract: 'amex.recent.observe',
    method: 'POST',
    origin: WRAPPER_ORIGIN,
    path: /^\/ReadAccountActivity\.web\.v1$/,
    template: '/ReadAccountActivity.web.v1',
    queryKeys: [],
    requestBody: requestBodyMatches,
    maxResponseBytes: 2 * 1024 * 1024,
  },
]);

const KINDS: Readonly<Record<string, CardTransactionKind>> = Object.freeze({ CHARGE: 'purchase', CREDIT: 'refund', PAYMENT: 'payment', FEE: 'fee' });
const STATUSES: Readonly<Record<string, 'pending' | 'posted'>> = Object.freeze({ pending: 'pending', posted: 'posted' });

function enumValue<T>(table: Readonly<Record<string, T>>, key: string | undefined): T | undefined {
  return key !== undefined && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** Amex shows five digits; only the last four leave the page. */
function lastFour(display: string | null | undefined): string | null {
  if (typeof display !== 'string') return null;
  const digits = display.replace(/[^0-9]/g, '');
  return digits.length === 4 || digits.length === 5 ? digits.slice(-4) : null;
}

const known = new Map<string, ProjectedAccountCandidate>();
/** Per stream, the candidate each account was first sent with: every later batch of the stream repeats it exactly (the merge refuses two versions of one candidate). */
const sent = new Map<string, ProjectedAccountCandidate>();
let sentStream: string | null = null;
/** The stream whose page card list was read into `known`. */
let knownStream: string | null = null;

/** The response no longer matches the contract (a field missing, a type changed, an unknown enum): the issuer's contract pauses. */
function refused(): MainProjection {
  return SHAPE_CHANGED;
}

function candidateOf(stream: StreamContext, fresh: ProjectedAccountCandidate): ProjectedAccountCandidate {
  if (sentStream !== stream.streamHandle) {
    sent.clear();
    sentStream = stream.streamHandle;
  }
  const earlier = sent.get(fresh.ref);
  if (earlier) return earlier;
  sent.set(fresh.ref, fresh);
  return fresh;
}

/**
 * The page's own card list (its state object, set before any request of its own), read into `known` once per stream:
 * an activity answer that arrives before DOMContentLoaded already carries the card's last four and product, the same
 * as every later batch. Null while the page has no state; `false` for a state the contract no longer describes.
 */
function readCards(stream: StreamContext): ProjectedAccountCandidate[] | null | false {
  const state: unknown = Reflect.get(globalThis, '__FAKE_AMEX_STATE__');
  if (!isRecord(state)) return null;
  const cards = list(state, 'cards', 20);
  if (!cards) return false;
  const seen: Array<{ ref: string; last4: string | null; product: string | null }> = [];
  for (const card of cards) {
    if (!isRecord(card)) return false;
    const token = str(card, 'token', 64);
    if (!token) return false;
    seen.push({ ref: stream.candidateRef(token), last4: lastFour(str(card, 'display', 16)), product: str(card, 'product', 200) ?? null });
  }
  stream.noteHints(seen.map((card) => card.last4));
  if (knownStream !== stream.streamHandle) {
    known.clear();
    knownStream = stream.streamHandle;
  }
  for (const card of seen) if (!known.has(card.ref)) known.set(card.ref, { ref: card.ref, last4: card.last4, productHint: productHint(card.product, stream.hints()) });
  return seen.map((card) => known.get(card.ref)!);
}

function project(json: unknown, token: string, offset: number, stream: StreamContext): MainProjection | null {
  if (!isRecord(json)) return refused();
  const transactions = list(json, 'transactions', 1_000);
  const hasMore = bool(json, 'hasMore');
  if (!transactions || hasMore === undefined) return refused();
  const accountRef = stream.candidateRef(token);
  const page = `${accountRef} ${offset}`;
  if (knownStream !== stream.streamHandle && readCards(stream) === false) return refused();
  const candidate = candidateOf(stream, (knownStream === stream.streamHandle ? known.get(accountRef) : undefined) ?? { ref: accountRef, last4: null, productHint: null });
  const inputs: RowInput[] = [];
  let rejected = 0;
  for (const raw of transactions) {
    if (!isRecord(raw)) return refused();
    const kind = enumValue(KINDS, str(raw, 'type', 16));
    const status = enumValue(STATUSES, str(raw, 'status', 16));
    const amount = num(raw, 'amount');
    const date = str(raw, 'displayDate', 10);
    const member = strOrNull(raw, 'memberName', 200);
    const ending = strOrNull(raw, 'cardEnding', 8);
    if (!kind || !status || amount === undefined || date === undefined || member === undefined || ending === undefined) return refused();
    const minor = parseJsonNumberToMinor(amount, 2);
    const signed = minor.ok ? cardAmountFromIssuerSigned(minor.minor, 'debit-positive') : minor;
    // An amount the contract cannot read is a changed form, not one bad row.
    if (!signed.ok) return refused();
    inputs.push({
      accountRef,
      holderRef: member ? stream.holderRef(member) : null,
      cardLast4: lastFour(ending),
      transactionDate: date,
      postedDate: null,
      status,
      amountMinor: signed.minor,
      kind,
      description: str(raw, 'description') ?? null,
      merchant: null,
      issuerCategory: str(raw, 'category', 200) ?? null,
      primaryId: null,
      secondaryIds: [],
      original: null,
    });
  }
  stream.noteHints([candidate.last4, ...inputs.map((input) => input.cardLast4)]);
  const hints = stream.hints();
  const rows: ProjectedTransaction[] = [];
  for (const input of inputs) {
    const projected = projectRow(input, 'amex.recent.observe', hints);
    if (projected.ok) rows.push(projected.row);
    else if (isShapeDrift(projected.reason)) return refused();
    else rejected += 1;
  }
  // Every response is checked for a changed form first; a page already sent (a refresh of this offset) is
  // then not sent again, since rows without ids must never be sent twice.
  if (stream.pageSeen(page)) return null;
  const termination = hasMore ? 'more-available' : 'end-marker';
  const coverage = (['posted', 'pending'] as const).map((status) =>
    coverageEntry(rows, { accountRef, status, requested: null, pageCount: 1, termination, rejectedCount: rejected }),
  );
  const result = assembleBatch({
    contract: 'amex.recent.observe',
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

export const FAKE_AMEX_MAIN: MainAdapter = {
  adapterId: FAKE_AMEX.id,
  issuer: FAKE_AMEX.issuer,
  contracts: FAKE_AMEX_CONTRACTS,
  project(observed, stream) {
    if (observed.contract.contract !== 'amex.recent.observe' || !isRecord(observed.requestBody)) return null;
    const token = str(observed.requestBody, 'accountToken', 64);
    const offset = num(observed.requestBody, 'offset');
    if (!token || offset === undefined) return null;
    return project(observed.json, token, offset, stream);
  },
  discoverFromPage(stream) {
    const cards = readCards(stream);
    if (cards === null) return null;
    if (cards === false) return refused();
    return assembleBatch({
      contract: 'amex.overview-state',
      streamHandle: stream.streamHandle,
      sequence: stream.nextSequence(),
      observedAt: stream.observedAt(),
      accounts: cards.map((card) => candidateOf(stream, card)),
      transactions: [],
      coverage: [],
      rejectedCount: 0,
    });
  },
};

export const FAKE_AMEX_SHAPE: MainAdapter = { adapterId: FAKE_AMEX.id, issuer: FAKE_AMEX.issuer, contracts: FAKE_AMEX_CONTRACTS, shapeContracts: FAKE_AMEX.shapeContracts, project: () => null };
