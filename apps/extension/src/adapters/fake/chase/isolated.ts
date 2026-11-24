/**
 * Fake Chase, ISOLATED read (test build only). Exercises the isolated-read
 * path end to end: a one-time discovery read after the activity page is
 * ready, then, when the user asks, a bounded, paged, date-windowed read of
 * one account through `bankRead`, with the account id kept in a page-local
 * handle. The site and its JSON are invented; the projected batches use the
 * registered `chase.bootstrap` / `chase.activity` contracts.
 */
import {
  cardAmountFromDirection,
  parseDecimalToMinor,
  type CardSyncTermination,
  type CardTransactionKind,
  type ProjectedAccountCandidate,
  type ProjectedTransaction,
} from '@finance-tracker/shared';
import type { CollectorCode } from '../../../contracts/messages.js';
import { createPageContext, type BankReadContract, type PageContext } from '../../../isolated/bankRead.js';
import { codeFor, terminationFor } from '../../../isolated/terminations.js';
import type { IsolatedAdapter, ReadOutcome } from '../../../isolated/types.js';
import { assembleBatch, coverageEntry, isShapeDrift, last4FromMask, productHint, projectRow, type RowInput } from '../../../projection/project.js';
import { bool, isRecord, list, str, strOrNull } from '../../read.js';
import { FAKE_CHASE } from '../descriptors.js';

const ORIGIN = FAKE_CHASE.pageOrigin;

export const FAKE_CHASE_READS: readonly BankReadContract[] = Object.freeze([
  {
    operationId: 'fake-chase.bootstrap',
    contract: 'chase.bootstrap',
    method: 'POST',
    origin: ORIGIN,
    path: [{ literal: 'fake-api' }, { literal: 'accounts' }, { literal: 'list' }],
    query: [],
    body: { kind: 'form-empty' },
    headers: [],
  },
  {
    operationId: 'fake-chase.activity',
    contract: 'chase.activity',
    method: 'GET',
    origin: ORIGIN,
    path: [{ literal: 'fake-api' }, { literal: 'accounts' }, { handle: 'accountId' }, { literal: 'activity' }],
    query: [
      ['start', { kind: 'date', required: true }],
      ['end', { kind: 'date', required: true }],
      ['count', { kind: 'const', value: '50' }],
      ['cursor', { kind: 'cursor', maxLength: 128 }],
    ],
    body: { kind: 'none' },
    headers: [],
  },
] satisfies BankReadContract[]);

const KINDS: Readonly<Record<string, CardTransactionKind>> = Object.freeze({
  PURCHASE: 'purchase',
  RETURN: 'refund',
  PAYMENT: 'payment',
  FEE: 'fee',
  INTEREST: 'interest',
});
const STATUSES: Readonly<Record<string, 'pending' | 'posted'>> = Object.freeze({ PENDING: 'pending', POSTED: 'posted' });
const DIRECTIONS: Readonly<Record<string, 'debit' | 'credit'>> = Object.freeze({ D: 'debit', C: 'credit' });

/** Page-local: candidate ref → handle holding the issuer account id. Never leaves this world. */
const handles = new Map<string, PageContext>();
const candidates = new Map<string, ProjectedAccountCandidate>();

type RowRead = { ok: true; input: RowInput } | { ok: false };

function enumValue<T>(table: Readonly<Record<string, T>>, key: string | undefined): T | undefined {
  return key !== undefined && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/**
 * One issuer row to a projection input. `ok: false` means the row is not in
 * the contract's form: a missing required field, an unknown enum, or an
 * amount that is not a magnitude in the documented form (the sign comes from
 * `creditDebit`). That pauses the contract (plan §4).
 */
function readRow(raw: unknown, accountRef: string): RowRead {
  if (!isRecord(raw)) return { ok: false };
  const status = enumValue(STATUSES, str(raw, 'statusCode', 16));
  const kind = enumValue(KINDS, str(raw, 'typeCode', 16));
  const direction = enumValue(DIRECTIONS, str(raw, 'creditDebit', 1));
  const amountText = str(raw, 'amount', 32);
  const transactionDate = str(raw, 'transactionDate', 10);
  const postDate = strOrNull(raw, 'postDate', 10);
  if (!status || !kind || !direction || amountText === undefined || transactionDate === undefined || postDate === undefined) return { ok: false };
  const magnitude = parseDecimalToMinor(amountText, 2);
  if (!magnitude.ok || magnitude.minor < 0) return { ok: false };
  const signed = cardAmountFromDirection(magnitude.minor, direction);
  if (!signed.ok) return { ok: false };
  const sorId = str(raw, 'sorId', 128);
  const derivedId = str(raw, 'derivedId', 128);
  return {
    ok: true,
    input: {
      accountRef,
      holderRef: null,
      cardLast4: str(raw, 'cardLast4', 4) ?? null,
      transactionDate,
      postedDate: status === 'posted' ? postDate : null,
      status,
      amountMinor: signed.minor,
      kind,
      description: str(raw, 'description') ?? null,
      merchant: str(raw, 'merchantName') ?? null,
      issuerCategory: str(raw, 'category') ?? null,
      primaryId: sorId ? { namespace: 'chase-api:sor:v1', raw: sorId } : null,
      secondaryIds: derivedId ? [{ namespace: 'chase-api:derived:v1', raw: derivedId }] : [],
      original: null,
    },
  };
}

export const FAKE_CHASE_ISOLATED: IsolatedAdapter = {
  identity: {
    id: FAKE_CHASE.id,
    label: FAKE_CHASE.label,
    issuer: FAKE_CHASE.issuer,
    source: FAKE_CHASE.source,
    mode: FAKE_CHASE.mode,
    parserVersion: FAKE_CHASE.parserVersion,
    pageOrigin: FAKE_CHASE.pageOrigin,
    pagePaths: FAKE_CHASE.pagePaths,
    discoveryContract: FAKE_CHASE.discoveryContract,
    transactionsContract: FAKE_CHASE.transactionsContract,
    usesMainObserver: false,
  },
  readContracts: FAKE_CHASE_READS,
  pageState(doc) {
    if (doc.querySelector('form#login')) return 'auth-required';
    return doc.querySelector('#activity-root[data-ready="true"]') ? 'activity' : 'other';
  },
  async discover(io) {
    const result = await io.reader.bankRead('fake-chase.bootstrap', {}, null);
    if (!result.ok) return { ok: false, code: codeFor(result.error), retryAfterMs: result.retryAfterMs };
    const tiles = isRecord(result.json) ? list(result.json, 'tiles', 50) : undefined;
    if (!tiles) return { ok: false, code: 'shape-changed' };
    handles.clear();
    candidates.clear();
    const cards: Array<{ ref: string; last4: string | null; nickname: string | null }> = [];
    for (const tile of tiles) {
      if (!isRecord(tile)) return { ok: false, code: 'shape-changed' };
      const category = str(tile, 'category', 16);
      const accountId = str(tile, 'accountId', 64);
      if (!category || !accountId) return { ok: false, code: 'shape-changed' };
      // Only credit-card tiles; deposit accounts are never projected.
      if (category !== 'CARD') continue;
      const ref = io.stream.candidateRef(accountId);
      handles.set(ref, createPageContext({ accountId }));
      cards.push({ ref, last4: last4FromMask(str(tile, 'mask', 32) ?? null), nickname: str(tile, 'nickname', 200) ?? null });
    }
    io.stream.noteHints(cards.map((card) => card.last4));
    for (const card of cards) candidates.set(card.ref, { ref: card.ref, last4: card.last4, productHint: productHint(card.nickname, io.stream.hints()) });
    const batch = assembleBatch({
      contract: 'chase.bootstrap',
      streamHandle: io.stream.streamHandle,
      sequence: io.stream.nextSequence(),
      observedAt: io.stream.observedAt(),
      accounts: [...candidates.values()],
      transactions: [],
      coverage: [],
      rejectedCount: 0,
    });
    return batch.ok ? { ok: true, batch: batch.batch } : { ok: false, code: 'projection-refused' };
  },
  async readAccount(io, accountRef, window): Promise<ReadOutcome> {
    const handle = handles.get(accountRef);
    const candidate = candidates.get(accountRef);
    if (!handle || !candidate) return { ok: false, code: 'unknown-account' };
    const rows: ProjectedTransaction[] = [];
    let rejected = 0;
    let pages = 0;
    let cursor: string | null = null;
    let termination: CardSyncTermination = 'cap';
    let code: CollectorCode | null = null;
    let retryAfterMs: number | null = null;
    for (;;) {
      if (pages >= io.budget.maxPages) {
        termination = 'cap';
        code = 'read-cap';
        break;
      }
      const result = await io.reader.bankRead('fake-chase.activity', { start: window.start, end: window.end, cursor }, handle);
      if (!result.ok) {
        if (pages === 0) return { ok: false, code: codeFor(result.error), retryAfterMs: result.retryAfterMs };
        termination = terminationFor(result.error);
        code = codeFor(result.error);
        retryAfterMs = result.retryAfterMs;
        break;
      }
      const page = isRecord(result.json) ? result.json : null;
      const activities = page ? list(page, 'activities', 500) : undefined;
      const more = page ? bool(page, 'more') : undefined;
      const next = page ? strOrNull(page, 'cursor', 128) : undefined;
      // A response the contract does not describe pauses it; nothing from this read is kept.
      if (!page || !activities || more === undefined || next === undefined || (more && next === null)) return { ok: false, code: 'shape-changed' };
      pages += 1;
      const inputs: RowInput[] = [];
      for (const raw of activities) {
        const read = readRow(raw, accountRef);
        if (!read.ok) return { ok: false, code: 'shape-changed' };
        inputs.push(read.input);
      }
      // The page's last fours join the stream's card hints before its text is prepared.
      io.stream.noteHints(inputs.map((input) => input.cardLast4));
      const hints = io.stream.hints();
      for (const input of inputs) {
        const projected = projectRow(input, 'chase.activity', hints);
        if (projected.ok) rows.push(projected.row);
        else if (isShapeDrift(projected.reason)) return { ok: false, code: 'shape-changed' };
        else rejected += 1;
      }
      if (!more) {
        termination = 'end-marker';
        break;
      }
      if (activities.length === 0) {
        termination = 'empty-page';
        code = 'empty-page';
        break;
      }
      cursor = next;
    }
    const coverage = (['posted', 'pending'] as const).map((status) =>
      coverageEntry(rows, { accountRef, status, requested: window, pageCount: pages, termination, rejectedCount: rejected }),
    );
    const batch = assembleBatch({
      contract: 'chase.activity',
      streamHandle: io.stream.streamHandle,
      sequence: io.stream.nextSequence(),
      observedAt: io.stream.observedAt(),
      accounts: [candidate],
      transactions: rows,
      coverage,
      rejectedCount: rejected,
    });
    return batch.ok ? { ok: true, batch: batch.batch, code, retryAfterMs } : { ok: false, code: 'projection-refused' };
  },
};
