/**
 * The ISOLATED stream store and the v2 build (contract §10a): which batches
 * count per mode, merging with `mergeProjectedBatches`, identity conflicts,
 * stream rules, release after a capture, and the payload built from one
 * account candidate through `expandCoverageToScopes` and
 * `buildCardSyncPayloadV2`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateCardSyncPayloadV2, type CardSyncReadContractId, type CardSyncTermination, type ProjectedAccountCandidate, type ProjectedBankBatchV1, type ProjectedTransaction } from '@finance-tracker/shared';
import { fixtureId } from '@finance-tracker/shared/card-sync-fixtures';
import { FAKE_AMEX_CONTRACTS, FAKE_AMEX_MAIN } from '../../src/adapters/fake/amex/main.js';
import { FAKE_CITI_CONTRACTS, FAKE_CITI_MAIN } from '../../src/adapters/fake/citi/main.js';
import { FAKE_CHASE } from '../../src/adapters/fake/descriptors.js';
import { SHAPE_CHANGED } from '../../src/main/observer.js';
import { buildPayload } from '../../src/projection/buildPayload.js';
import { assembleBatch, coverageEntry, projectRow, type RowInput } from '../../src/projection/project.js';
import { createStream, type StreamContext } from '../../src/projection/stream.js';
import { StreamStore } from '../../src/projection/streamStore.js';

const OBSERVED_AT = '2026-10-16T12:00:00.000Z';
const WINDOW = { start: '2026-09-17', end: '2026-10-16' };

function project(fields: Partial<RowInput> & Pick<RowInput, 'accountRef'>, contract: CardSyncReadContractId): ProjectedTransaction {
  const projected = projectRow(
    {
      holderRef: null,
      cardLast4: null,
      transactionDate: '2026-10-01',
      postedDate: '2026-10-02',
      status: 'posted',
      amountMinor: 1000,
      kind: 'purchase',
      description: 'SYNTHETIC SHOP',
      merchant: null,
      issuerCategory: null,
      primaryId: null,
      secondaryIds: [],
      original: null,
      ...fields,
    },
    contract,
    [],
  );
  assert.ok(projected.ok);
  return projected.row;
}

function batch(
  contract: CardSyncReadContractId,
  stream: StreamContext,
  candidate: ProjectedAccountCandidate,
  rows: ProjectedTransaction[],
  options: { termination?: CardSyncTermination; pageCount?: number; rejected?: number; window?: typeof WINDOW | null } = {},
): ProjectedBankBatchV1 {
  const coverage = (['posted', 'pending'] as const).map((status) =>
    coverageEntry(rows, {
      accountRef: candidate.ref,
      status,
      requested: options.window ?? null,
      pageCount: options.pageCount ?? 1,
      termination: options.termination ?? 'end-marker',
      rejectedCount: options.rejected ?? 0,
    }),
  );
  const result = assembleBatch({
    contract,
    streamHandle: stream.streamHandle,
    sequence: stream.nextSequence(),
    observedAt: OBSERVED_AT,
    accounts: [candidate],
    transactions: rows,
    coverage,
    rejectedCount: options.rejected ?? 0,
  });
  assert.ok(result.ok, JSON.stringify(result.ok ? null : result.issues));
  return result.batch;
}

function discovery(contract: CardSyncReadContractId, stream: StreamContext, candidates: ProjectedAccountCandidate[]): ProjectedBankBatchV1 {
  const result = assembleBatch({ contract, streamHandle: stream.streamHandle, sequence: stream.nextSequence(), observedAt: OBSERVED_AT, accounts: candidates, transactions: [], coverage: [], rejectedCount: 0 });
  assert.ok(result.ok);
  return result.batch;
}

function citiSetup() {
  const stream = createStream();
  const candidate = { ref: stream.candidateRef('citi-account'), last4: '5004', productHint: 'Double Cash Example' };
  const holder = stream.holderRef('PRIMARY NAME');
  const row = (id: string, amountMinor: number, date: string) =>
    project({ accountRef: candidate.ref, holderRef: holder, transactionDate: date, postedDate: date, amountMinor, description: `SYNTHETIC ${id}`, primaryId: { namespace: 'citi-api:transaction:v1', raw: id } }, 'citi.transactions.observe');
  const store = new StreamStore('main-passive');
  assert.equal(store.accept(discovery('citi.accounts.tiles.observe', stream, [candidate]), false).ok, true);
  return { stream, candidate, row, store };
}

test('main-passive: every response counts; an identical row with a stable id is kept once; a changed id stops captures', () => {
  const { stream, candidate, row, store } = citiSetup();
  const first = [row('T1', 1000, '2026-10-01'), row('T2', 2000, '2026-10-02')];
  assert.deepEqual(store.accept(batch('citi.transactions.observe', stream, candidate, first, { termination: 'more-available' }), true), { ok: true, reset: false, added: 2 });
  store.accept(batch('citi.transactions.observe', stream, candidate, [row('T3', 3000, '2026-09-20')]), true);
  let [summary] = store.summaries();
  assert.deepEqual([summary.posted, summary.pageCount, summary.termination, summary.completeness], [3, 2, 'end-marker', 'unknown']);

  // The same rows again (another page that repeats them): kept once by identity; the page still counts.
  assert.equal(store.accept(batch('citi.transactions.observe', stream, candidate, [row('T2', 2000, '2026-10-02'), row('T4', 4000, '2026-09-19')]), true).ok, true);
  [summary] = store.summaries();
  assert.deepEqual([summary.posted, summary.pageCount], [4, 3]);

  const changed = store.accept(batch('citi.transactions.observe', stream, candidate, [row('T1', 1111, '2026-10-01')]), true);
  assert.equal(changed.ok, false);
  assert.equal(!changed.ok && changed.code, 'identity-conflict');
  assert.equal(store.conflicted, true);
  assert.equal(store.summaries()[0].posted, 4);
});

test('main-passive producer: two pages with an identical purchase and no ids are two rows; the same page fetched again is not sent twice', () => {
  const stream = createStream();
  const store = new StreamStore('main-passive');
  const observed = (offset: number, transactions: unknown[], hasMore: boolean) => ({
    contract: FAKE_AMEX_CONTRACTS[0],
    requestUrl: new URL('http://functions.amex.e3.test/ReadAccountActivity.web.v1'),
    requestBody: { accountToken: 'TOKEN-1', locale: 'en-US', limit: 1, offset, view: 'RECENT' },
    json: { transactions, hasMore },
  });
  const coffee = { displayDate: '2026-10-01', description: 'SYNTHETIC COFFEE', amount: 5, type: 'CHARGE', status: 'posted', memberName: null, cardEnding: '30003', category: 'Food' };
  const pages = [observed(0, [coffee], true), observed(1, [coffee], false)].map((item) => FAKE_AMEX_MAIN.project(item, stream));
  for (const page of pages) {
    assert.ok(page && page.ok);
    assert.equal(store.accept(page.batch, true).ok, true);
  }
  assert.equal(store.summaries()[0].posted, 2);
  assert.equal(FAKE_AMEX_MAIN.project(observed(0, [coffee], true), stream), null);
});

test('main-passive producer: a page already sent is still checked for a changed form when it comes again', () => {
  const stream = createStream();
  const amex = (offset: number, amount: number, type = 'CHARGE') => ({
    contract: FAKE_AMEX_CONTRACTS[0],
    requestUrl: new URL('http://functions.amex.e3.test/ReadAccountActivity.web.v1'),
    requestBody: { accountToken: 'TOKEN-2', locale: 'en-US', limit: 1, offset, view: 'RECENT' },
    json: { transactions: [{ displayDate: '2026-10-01', description: 'SYNTHETIC SHOP', amount, type, status: 'posted', memberName: null, cardEnding: '30003', category: 'Shop' }], hasMore: false },
  });
  const first = FAKE_AMEX_MAIN.project(amex(0, 5), stream);
  assert.ok(first && first.ok);
  assert.deepEqual(FAKE_AMEX_MAIN.project(amex(0, -5), stream), SHAPE_CHANGED);
  assert.deepEqual(FAKE_AMEX_MAIN.project(amex(0, 5, 'MYSTERY'), stream), SHAPE_CHANGED);
  assert.equal(FAKE_AMEX_MAIN.project(amex(0, 5), stream), null);

  const citi = (amount: string, type = 'PURCHASE') => ({
    contract: FAKE_CITI_CONTRACTS[1],
    requestUrl: new URL('http://citi.e3.test/gcg-fake/v1/accounts/ACCT-1/transactions/retrieve'),
    requestBody: { nextTableIndex: null, moreTransactionsFlag: null, isRedesignPage: true },
    json: {
      pendingTransactions: [],
      postedTransactions: [{ transactionType: type, amount, purchaseDate: '10/01/2026', postedDate: '10/02/2026', cardMemberName: 'PRIMARY', transactionId: 'T-1', description: 'SYNTHETIC SHOP' }],
      moreTransactionsFlag: 'false',
    },
  });
  const page = FAKE_CITI_MAIN.project(citi('5.00'), stream);
  assert.ok(page && page.ok);
  assert.deepEqual(FAKE_CITI_MAIN.project(citi('-5.00'), stream), SHAPE_CHANGED);
  assert.deepEqual(FAKE_CITI_MAIN.project(citi('5.00', 'MYSTERY'), stream), SHAPE_CHANGED);
  assert.equal(FAKE_CITI_MAIN.project(citi('5.00'), stream), null);
});

test('release: only the batches a frozen payload was built from stop counting; batches that arrived since stay', () => {
  const { stream, candidate, row, store } = citiSetup();
  store.accept(batch('citi.transactions.observe', stream, candidate, [row('T1', 1000, '2026-10-01')]), true);
  const watermark = store.arrivalCount;
  // A response arrives between the build and the worker's release.
  store.accept(batch('citi.transactions.observe', stream, candidate, [row('T2', 2000, '2026-10-02')]), true);
  store.release(candidate.ref, watermark);
  assert.equal(store.summaries()[0].posted, 1);
  store.release(candidate.ref);
  assert.equal(store.summaries()[0].posted, 0);
  assert.equal(store.mergedFor(candidate.ref), null);
  store.accept(batch('citi.transactions.observe', stream, candidate, [row('T3', 3000, '2026-10-03')]), true);
  assert.equal(store.summaries()[0].posted, 1);
});

test('isolated-read: a new read of an account supersedes its earlier read', () => {
  const stream = createStream();
  const candidate = { ref: stream.candidateRef('chase-account'), last4: '3391', productHint: null };
  const row = (id: string, status: 'pending' | 'posted') =>
    project({ accountRef: candidate.ref, cardLast4: '3391', status, postedDate: status === 'posted' ? '2026-10-02' : null, primaryId: { namespace: 'chase-api:sor:v1', raw: id } }, 'chase.activity');
  const store = new StreamStore('isolated-read');
  store.accept(discovery('chase.bootstrap', stream, [candidate]), false);
  store.accept(batch('chase.activity', stream, candidate, [row('A', 'pending')], { window: WINDOW, pageCount: 2 }), true);
  // The pending purchase posted; read again: the same id with other content is a newer read, not a conflict.
  assert.equal(store.accept(batch('chase.activity', stream, candidate, [row('A', 'posted'), row('B', 'posted')], { window: WINDOW }), true).ok, true);
  const [summary] = store.summaries();
  assert.deepEqual([summary.posted, summary.pending, summary.pageCount, summary.completeness], [2, 0, 1, 'complete']);
  assert.equal(store.conflicted, false);
});

test('stream rules: stale sequences drop; another stream must start at 0 and discards the old one, which stays retired', () => {
  const { stream, candidate, row, store } = citiSetup();
  const kept = batch('citi.transactions.observe', stream, candidate, [row('T1', 1000, '2026-10-01')]);
  assert.equal(store.accept(kept, true).ok, true);
  assert.deepEqual(store.accept({ ...kept, sequence: 0 }, true), { ok: false, code: 'stale-stream', issues: [] });

  const next = createStream();
  const late = batch('citi.transactions.observe', next, { ...candidate, ref: next.candidateRef('x') }, []);
  assert.deepEqual(store.accept({ ...late, sequence: 3 }, true), { ok: false, code: 'stale-stream', issues: [] });
  const fresh = discovery('citi.accounts.tiles.observe', next, [{ ref: next.candidateRef('x'), last4: null, productHint: null }]);
  assert.deepEqual(store.accept({ ...fresh, sequence: 0 }, false), { ok: true, reset: true, added: 0 });
  assert.equal(store.hasAccount(candidate.ref), false);
  assert.deepEqual(store.accept({ ...kept, sequence: 50 }, true), { ok: false, code: 'stale-stream', issues: [] });
});

test('release with no watermark: every batch so far stops counting; later batches start afresh', () => {
  const { stream, candidate, row, store } = citiSetup();
  store.accept(batch('citi.transactions.observe', stream, candidate, [row('T1', 1000, '2026-10-01')]), true);
  store.release(candidate.ref);
  assert.equal(store.summaries()[0].posted, 0);
  assert.equal(store.mergedFor(candidate.ref), null);
  store.accept(batch('citi.transactions.observe', stream, candidate, [row('T2', 2000, '2026-10-02')]), true);
  assert.equal(store.summaries()[0].posted, 1);
});

test('buildPayload: rows to confirmed scopes, coverage for every confirmed scope of the bound account (rows or not), owner null, sorted cards, valid v2', () => {
  const stream = createStream();
  const candidate = { ref: stream.candidateRef('chase-account'), last4: '3391', productHint: 'Sapphire Example' };
  const rows = [
    project({ accountRef: candidate.ref, cardLast4: '3391', primaryId: { namespace: 'chase-api:sor:v1', raw: 'A' } }, 'chase.activity'),
    project({ accountRef: candidate.ref, cardLast4: '3391', status: 'pending', postedDate: null, transactionDate: '2026-10-05', amountMinor: 875, primaryId: { namespace: 'chase-api:sor:v1', raw: 'B' } }, 'chase.activity'),
    project({ accountRef: candidate.ref, cardLast4: '7720', transactionDate: '2026-09-28', postedDate: '2026-09-29', primaryId: { namespace: 'chase-api:sor:v1', raw: 'C' } }, 'chase.activity'),
  ];
  const store = new StreamStore('isolated-read');
  store.accept(discovery('chase.bootstrap', stream, [candidate]), false);
  store.accept(batch('chase.activity', stream, candidate, rows, { window: WINDOW, pageCount: 2, rejected: 1 }), true);
  const primary = fixtureId('cardScope', 'primary');
  const authorized = fixtureId('cardScope', 'authorized');
  // Confirmed scopes of the bound account without any row: a holder-unknown scope and a card with no activity.
  const unknown = fixtureId('cardScope', 'unknown');
  const quiet = fixtureId('cardScope', 'quiet');
  const base = {
    store,
    accountRef: candidate.ref,
    captureId: fixtureId('capture', 'unit'),
    bindingId: fixtureId('binding', 'unit'),
    bindingVersion: 1,
    confirmedScopes: [primary, authorized, unknown, quiet],
    cards: ['7720', '3391', '4000'],
    issuer: FAKE_CHASE.issuer,
    source: FAKE_CHASE.source,
    mode: FAKE_CHASE.mode,
    parserVersion: FAKE_CHASE.parserVersion,
  };
  const result = buildPayload({
    ...base,
    scopes: [
      { holderRef: null, cardLast4: '3391', cardScopeId: primary },
      { holderRef: null, cardLast4: '7720', cardScopeId: authorized },
    ],
  });
  assert.ok(result.ok, JSON.stringify(!result.ok && result));
  const payload = result.payload;
  assert.ok(validateCardSyncPayloadV2(payload).ok);
  assert.equal(payload.owner, null);
  assert.deepEqual(payload.cards, ['3391', '4000', '7720']);
  assert.equal(payload.rejectedCount, 1);
  assert.equal(payload.observedAt, OBSERVED_AT);
  assert.deepEqual(payload.rows.map((item) => item.cardScopeId), [primary, primary, authorized]);
  // E1a §10a: one entry per status for every confirmed scope; a scope without rows was read and found empty.
  assert.equal(payload.coverage.length, 8);
  assert.deepEqual(new Set(payload.coverage.map((entry) => entry.cardScopeId)), new Set([primary, authorized, unknown, quiet]));
  for (const empty of [unknown, quiet]) {
    assert.ok(payload.coverage.filter((entry) => entry.cardScopeId === empty).every((entry) => entry.observed === null), empty);
  }
  const pendingAuthorized = payload.coverage.find((entry) => entry.cardScopeId === authorized && entry.status === 'pending');
  assert.equal(pendingAuthorized?.observed, null);
  assert.ok(payload.coverage.every((entry) => entry.completeness === 'partial' && entry.pageCount === 2 && entry.termination === 'end-marker'));

  assert.deepEqual(buildPayload({ ...base, scopes: [{ holderRef: null, cardLast4: '3391', cardScopeId: primary }] }), { ok: false, code: 'unmapped-rows', issues: [] });
  // A row group mapped to a scope that is not a confirmed scope of the bound account.
  const stray = fixtureId('cardScope', 'stray');
  assert.deepEqual(buildPayload({ ...base, scopes: [{ holderRef: null, cardLast4: '3391', cardScopeId: primary }, { holderRef: null, cardLast4: '7720', cardScopeId: stray }] }), { ok: false, code: 'unmapped-rows', issues: [] });
  assert.equal(buildPayload({ ...base, accountRef: stream.candidateRef('nobody'), scopes: [] }).ok, false);

  // A binding with more confirmed scopes than one payload can cover (two statuses each, at most 40 entries) is refused
  // by the v2 builder, naming the limit, never cut down to fewer scopes.
  const many = Array.from({ length: 21 }, (_, index) => fixtureId('cardScope', `many-${index}`));
  const tooMany = buildPayload({
    ...base,
    confirmedScopes: [primary, authorized, ...many.slice(2)],
    scopes: [
      { holderRef: null, cardLast4: '3391', cardScopeId: primary },
      { holderRef: null, cardLast4: '7720', cardScopeId: authorized },
    ],
  });
  assert.equal(tooMany.ok, false);
  assert.ok(!tooMany.ok && tooMany.code === 'payload-refused' && tooMany.issues.some((issue) => issue.path === '$.coverage' && issue.code === 'too-many-items'), JSON.stringify(tooMany));
});

test('buildPayload refuses an account that was never read, and every account after an identity conflict', () => {
  const { stream, candidate, row, store } = citiSetup();
  const base = {
    store,
    accountRef: candidate.ref,
    captureId: fixtureId('capture', 'unit'),
    bindingId: fixtureId('binding', 'unit'),
    bindingVersion: 1,
    scopes: [],
    confirmedScopes: [],
    cards: [],
    issuer: 'citi' as const,
    source: 'citi-api' as const,
    mode: 'main-passive' as const,
    parserVersion: 'holdr-ext-fake-citi@0.1.0',
  };
  assert.deepEqual(buildPayload(base), { ok: false, code: 'no-rows', issues: [] });
  store.accept(batch('citi.transactions.observe', stream, candidate, [row('T1', 1000, '2026-10-01')]), true);
  store.accept(batch('citi.transactions.observe', stream, candidate, [row('T1', 9999, '2026-10-01')]), true);
  assert.deepEqual(buildPayload(base), { ok: false, code: 'identity-conflict', issues: [] });
});
