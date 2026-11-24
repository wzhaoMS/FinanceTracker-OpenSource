/** Page-side projection: text, signs, ids, coverage and batch assembly (contract §7a, §10a, §15). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CARD_SYNC_SOURCE_SPECS,
  CARD_SYNC_TERMINATIONS,
  cardSyncCompletenessAllowed,
} from '@finance-tracker/shared';
import { completenessFor } from '../../src/projection/completeness.js';
import { assembleBatch, coverageEntry, demoteRepeatedIds, productHint, projectRow, type RowInput } from '../../src/projection/project.js';
import { createStream } from '../../src/projection/stream.js';

const stream = createStream();
const ACCOUNT = stream.candidateRef('account-one');
const CAPTURE = CARD_SYNC_SOURCE_SPECS['chase-api'].captureNamespace;

function input(overrides: Partial<RowInput> = {}): RowInput {
  return {
    accountRef: ACCOUNT,
    holderRef: null,
    cardLast4: '3391',
    transactionDate: '2026-10-01',
    postedDate: '2026-10-02',
    status: 'posted',
    amountMinor: 1234,
    kind: 'purchase',
    description: 'SYNTHETIC COFFEE',
    merchant: 'Synthetic Coffee',
    issuerCategory: null,
    primaryId: { namespace: 'chase-api:sor:v1', raw: 'SYN-1' },
    secondaryIds: [],
    original: null,
    ...overrides,
  };
}

function row(overrides: Partial<RowInput> = {}, hints: string[] = []) {
  const projected = projectRow(input(overrides), 'chase.activity', hints);
  assert.ok(projected.ok, 'row refused');
  return projected.row;
}

test('projectRow redacts a card number, refuses a card secret, checks signs and drops a pending posted date', () => {
  assert.ok(!row({ description: 'STORE REF 4111 1111 1111 1111' }).description.includes('4111 1111'));
  assert.deepEqual(projectRow(input({ description: 'PAYMENT CVV 123' }), 'chase.activity', []), { ok: false, reason: 'text' });
  assert.deepEqual(projectRow(input({ kind: 'refund', amountMinor: 500 }), 'chase.activity', []), { ok: false, reason: 'sign' });
  assert.deepEqual(projectRow(input({ transactionDate: '2026-02-30' }), 'chase.activity', []), { ok: false, reason: 'date' });
  assert.equal(row({ status: 'pending' }).postedDate, null);
  assert.equal(row({ description: null }).description, '(no description)');
});

test('projectRow redacts runs that complete a card number with a stream hint (contract 7a)', () => {
  const description = 'ALPHA 4012 8888 8888 BRAVO';
  const hinted = row({ description }, ['1881']);
  assert.ok(!hinted.description.includes('4012 8888 8888'), hinted.description);
  assert.ok(hinted.description.includes('***'), hinted.description);
});

test('demoteRepeatedIds keys an identity by candidate, namespace and digest', () => {
  const other = stream.candidateRef('account-two');
  const rows = demoteRepeatedIds(
    [
      row({ primaryId: { namespace: 'chase-api:sor:v1', raw: 'SAME' } }),
      row({ amountMinor: 999, primaryId: { namespace: 'chase-api:sor:v1', raw: 'SAME' } }),
      row({ primaryId: { namespace: 'chase-api:derived:v1', raw: 'SAME' } }),
      row({ accountRef: other, primaryId: { namespace: 'chase-api:sor:v1', raw: 'SAME' } }),
      row({ primaryId: { namespace: 'chase-api:sor:v1', raw: 'OTHER' }, secondaryIds: [{ namespace: 'chase-api:derived:v1', raw: 'SAME' }] }),
    ],
    CAPTURE,
  );
  assert.deepEqual(rows.map((item) => item.externalIdHash === null), [true, true, true, false, true]);
  for (const demoted of rows.filter((item) => item.externalIdHash === null)) {
    assert.equal(demoted.identityNamespace, CAPTURE);
    assert.deepEqual(demoted.secondaryIds, []);
  }
});

test('coverage claims at most what its termination allows, never complete with rejected rows', () => {
  const rows = [row()];
  const window = { start: '2026-09-17', end: '2026-10-16' };
  const entry = (termination: (typeof CARD_SYNC_TERMINATIONS)[number], requested: typeof window | null, rejectedCount: number, status: 'posted' | 'pending' = 'posted') =>
    coverageEntry(rows, { accountRef: ACCOUNT, status, requested, pageCount: 2, termination, rejectedCount });
  assert.equal(entry('end-marker', window, 0).completeness, 'complete');
  assert.equal(entry('end-marker', window, 1).completeness, 'partial');
  assert.equal(entry('end-marker', null, 0).completeness, 'unknown');
  assert.equal(entry('snapshot', null, 1).completeness, 'unknown');
  assert.equal(entry('more-available', window, 0).completeness, 'partial');
  assert.deepEqual(entry('end-marker', window, 0).observed, { start: '2026-10-01', end: '2026-10-01', dateBasis: 'transaction' });
  assert.equal(entry('end-marker', window, 0, 'pending').observed, null);
  const notRead = entry('not-read', window, 0);
  assert.equal(notRead.pageCount, 0);
  assert.equal(notRead.observed, null);
  for (const termination of CARD_SYNC_TERMINATIONS) {
    for (const requested of [window, null]) {
      for (const rejected of [0, 3]) assert.ok(cardSyncCompletenessAllowed(completenessFor(termination, requested, rejected), termination, requested), `${termination} ${requested ? 'window' : 'none'} ${rejected}`);
    }
  }
});

test('assembleBatch validates the batch and leaves out a product hint that completes a card number', () => {
  const candidate = { ref: ACCOUNT, last4: '1881', productHint: 'CARD 4012 8888 8888' };
  const result = assembleBatch({ contract: 'chase.bootstrap', streamHandle: stream.streamHandle, sequence: 0, observedAt: '2026-10-16T12:00:00.000Z', accounts: [candidate], transactions: [], coverage: [], rejectedCount: 0 });
  assert.ok(result.ok);
  assert.equal(result.batch.accounts[0].productHint, null);
  assert.equal(productHint('CARD 4012 8888 8888', ['1881']), null);
  assert.equal(productHint('Sapphire Example', ['1881']), 'Sapphire Example');
  assert.equal(productHint('   ', []), null);
});

test('the stream keeps four-digit hints only, and a restart forgets them with the refs', () => {
  const local = createStream();
  const before = local.candidateRef('key');
  local.noteHints(['3391', null, '12345', 'abcd', '3391', '7720']);
  assert.deepEqual(local.hints(), ['3391', '7720']);
  local.restart();
  assert.deepEqual(local.hints(), []);
  assert.notEqual(local.candidateRef('key'), before);
  assert.equal(local.nextSequence(), 0);
});
