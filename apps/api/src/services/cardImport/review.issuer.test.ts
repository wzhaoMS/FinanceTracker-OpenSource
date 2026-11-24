import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CardSyncScenario } from '../../testing/cardSyncScenario.js';
import { classify } from '../cardLedger/classify.js';
import { CardLedgerWriter } from '../cardLedger/writer.js';
import { fileReviewWork, type FileReviewInput } from './review.js';

// E2d-D22: the pass of a v1 import (fileReviewWork) holds and asks nothing for an account of an issuer whose file sets
// `ck_set_issuer` refuses, on every path, including those no ledger reaches today (a removed row's hit, which only a
// merge leaves). The classifier is the only source of review work, so the pass must never consult it for such an
// account; on a Chase account the same rows consult it on every path, so the gate is what keeps it out.

vi.mock('../cardLedger/classify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cardLedger/classify.js')>();
  return { ...actual, classify: vi.fn(actual.classify) };
});

let w: CardSyncScenario;
beforeEach(() => {
  w = new CardSyncScenario();
  vi.mocked(classify).mockClear();
});
afterEach(() => w.close());

const values = { transactionDate: '2026-10-01', postedDate: '2026-10-02', status: 'posted' as const, amountMinor: 1250,
  originalAmountMinor: null, originalCurrency: null, kind: 'purchase', description: 'FOURTH COFFEE', merchant: null, issuerCategory: null };
type Hit = NonNullable<FileReviewInput['hit']>;
const hit = (patch: Partial<Hit> = {}): Hit => ({ identityId: 'card-ident-synthetic', identityStatus: 'active',
  transactionId: 'card-txn-synthetic', status: 'posted', dismissedAt: null, revision: 1, removedReason: null, removedFromStatus: null,
  ...patch });
const row = (index: number, outcome: FileReviewInput['outcome'], patch: Partial<FileReviewInput> = {}): FileReviewInput => ({
  index, key: `xid1:${'a'.repeat(63)}${index}`, byReference: true, values, hit: null, repeated: false, exempt: false, outcome, ...patch });
/** One row of every kind the pass knows: a new row and a promotion at an amount a synced row has, a second key with other values, an
 *  active key with new content (E-Q7), a detached key, a merged (removed) row's key, a dismissed row's key and an open question. */
const ROWS = [
  row(0, 'insert'),
  row(1, 'promote', { hit: hit({ transactionId: 'card-txn-pending', status: 'pending' }) }),
  row(2, 'promote', { hit: hit({ transactionId: 'card-txn-pending', status: 'pending', identityId: 'card-ident-alias' }),
    values: { ...values, description: 'OTHER VALUES' } }),
  row(3, 'duplicate', { hit: hit() }),
  row(4, 'duplicate', { hit: hit({ identityStatus: 'detached', transactionId: 'card-txn-detached' }) }),
  row(5, 'duplicate', { hit: hit({ transactionId: 'card-txn-merged', status: 'removed', removedReason: 'settled-into',
    removedFromStatus: 'pending' }) }),
  row(6, 'duplicate', { hit: hit({ transactionId: 'card-txn-dismissed', status: 'removed', removedReason: 'dismissed',
    removedFromStatus: 'pending', dismissedAt: '2026-10-03T00:00:00.000Z' }) }),
  row(7, 'question'),
];

/** The pass over ROWS on an account of `issuer`, with a synced posted row at the rows' amount on the same day where it can have one. */
function pass(issuer: 'discover' | 'chase') {
  let accountId: string;
  if (issuer === 'chase') {
    w.enable('chase');
    const binding = w.binding();
    w.ingest(w.device([binding.bindingId]), binding, [{ scope: w.scopes(binding).known[0], id: 'synced-coffee', date: '2026-10-01',
      amount: 1250, description: 'FOURTH COFFEE' }]);
    accountId = binding.cardAccountRef;
  } else {
    accountId = w.account('discover');
  }
  const legacyScopeId = new CardLedgerWriter(w.db, new Date().toISOString()).legacyScopeOf(accountId);
  vi.mocked(classify).mockClear();
  return w.db.transaction(() => fileReviewWork(w.db, new Date().toISOString(), {
    account: { id: accountId, issuer, currency: 'USD' }, legacyScopeId, rows: ROWS }))();
}

describe('fileReviewWork on another issuer\'s account (E2d-D22)', () => {
  it('never consults the classifier on any path, and keeps each row\'s Phase 4 outcome', () => {
    const work = pass('discover');
    expect(vi.mocked(classify)).not.toHaveBeenCalled();
    expect(work).toEqual({ held: [], heldOpen: [], review: [], inserted: [0], promoted: [ROWS[1]], remembered: [] });
  });

  it('consults it on every path that can hold or ask for a Chase account with a synced row (the control)', () => {
    pass('chase');
    // The new row, the promotion, the second key, the E-Q7 key, the detached key and the merged row's key; not the
    // dismissed row's (Phase 4's duplicate, A19) nor the open question.
    expect(vi.mocked(classify).mock.calls.map(([observation]) => observation.ordinal)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
