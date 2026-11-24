import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CardSyncScenario, SCENARIO_OWNER, type ScenarioDevice, type ScenarioRow } from '../../testing/cardSyncScenario.js';
import type { CardSourceBindingView, CardSyncPlanView } from '../sqliteStateRepo.js';
import { cardSyncRefusalCode } from './refusals.js';

// E1b design §4.9.2 (changing a decision after commit), the reversal table,
// `adjustment-reversible`, W17 and tests O10–O13, C23 of §7.

let w: CardSyncScenario;
let binding: CardSourceBindingView;
let device: ScenarioDevice;
let known: string[];
let unknown: string;

beforeEach(() => {
  w = new CardSyncScenario();
  w.enable('chase');
  binding = w.binding();
  device = w.device([binding.bindingId]);
  ({ known, unknown } = w.scopes(binding));
});

afterEach(() => {
  w.close();
});

const owner = { kind: 'session' as const, actorRef: SCENARIO_OWNER };
const count = (sql: string, ...params: unknown[]) => w.db.prepare(sql).pluck().get(...params) as number;
const setRow = (id: string) => w.db.prepare('SELECT * FROM card_sync_observation_sets WHERE id = ?').get(id) as Record<string, number | string>;
const txn = (id: string) => w.db.prepare('SELECT status, revision, reversal_snapshot_revision AS marker, card_scope_id AS scope FROM card_transactions WHERE id = ?')
  .get(id) as { status: string; revision: number; marker: number | null; scope: string };
function refused(code: string, write: () => unknown): void {
  let error: unknown;
  try {
    write();
  } catch (caught) {
    error = caught;
  }
  expect(cardSyncRefusalCode(error), String(error)).toBe(code);
}
function decide(setId: string, itemId: string, action: string, transactionId: string | null = null, cardScopeId: string | null = null) {
  return w.repo.recordCardReviewDecisions({ setId, expectedVersion: setRow(setId).version as number, actorRef: SCENARIO_OWNER,
    decisions: [{ itemId, action: action as never, transactionId, cardScopeId }] });
}
function planAndCommit(setId: string): CardSyncPlanView {
  const plan = w.repo.prepareCardSyncPlan({ principal: owner, setId, expectedVersion: setRow(setId).version as number,
    expectedGeneration: w.generation() }) as CardSyncPlanView;
  expect(plan.status).toBe('executable');
  w.repo.commitCardSyncPlan({ principal: owner, previewId: plan.previewId, payloadDigest: plan.payloadDigest, planDigest: plan.planDigest,
    expectedGeneration: w.generation() });
  return plan;
}
const item = (setId: string) => w.repo.getCardSyncObservationSetPage({ setId, after: null, limit: 10 })!.items[0];
/** A committed set of one row reviewed with `action`; the set and its item. */
function committedWith(rows: ScenarioRow[], action: string, transactionId: string | null = null, cardScopeId: string | null = null) {
  const { receipt } = w.accept(device, binding, rows);
  decide(receipt.observationSetId, item(receipt.observationSetId).itemId, action, transactionId, cardScopeId);
  planAndCommit(receipt.observationSetId);
  return { setId: receipt.observationSetId, itemId: item(receipt.observationSetId).itemId };
}

const posted = (): ScenarioRow => ({ scope: known[0], date: '2026-10-01', amount: 1250, description: 'FOURTH COFFEE', id: 'sor-1' });
const pending = (): ScenarioRow => ({ scope: known[0], date: '2026-10-01', status: 'pending', amount: 1250, description: 'FOURTH COFFEE',
  id: 'sor-p' });
const captured = (status: 'pending' | 'posted' = 'posted'): ScenarioRow => ({ scope: known[0], date: '2026-10-02', status, amount: 1250,
  description: 'FOURTH COFFEE #2' });

describe('changing a link after commit (§4.9.2)', () => {
  it('unmatches a link that wrote nothing and rejects the row instead', () => {
    w.ingest(device, binding, [posted()]);
    const target = w.db.prepare('SELECT id FROM card_transactions').pluck().get() as string;
    const { setId, itemId } = committedWith([captured()], 'same-transaction', target);
    expect(setRow(setId)).toMatchObject({ matched_count: 1, rejected_count: 0, version: 3 });
    const page = decide(setId, itemId, 'reject-row');
    expect(page.items[0]).toMatchObject({ status: 'decided', committed: { action: 'same-transaction' }, draft: { action: 'reject-row' } });
    const plan = planAndCommit(setId);
    expect(plan.planKind).toBe('adjustment');
    expect(plan.effects.map((e) => e.op)).toEqual(['unmatch', 'reject']);
    expect(plan.counts).toMatchObject({ unmatched: 1, rejected: 1 });
    expect(count("SELECT count(*) FROM card_source_identities WHERE canonical_transaction_id = ? AND status = 'detached'", target)).toBe(1);
    expect(setRow(setId)).toMatchObject({ state: 'committed', matched_count: 0, rejected_count: 1 });
    expect(item(setId)).toMatchObject({ status: 'committed', committed: { action: 'reject-row', transactionId: null } });
    expect(count("SELECT count(*) FROM card_source_observations WHERE state = 'rejected' AND provenance = 1")).toBe(1);
  });

  it('reverts a compound promotion and its link, then inserts the observation as its own row', () => {
    w.ingest(device, binding, [pending()]);
    const target = w.db.prepare('SELECT id FROM card_transactions').pluck().get() as string;
    const { setId, itemId } = committedWith([captured('posted')], 'same-transaction', target);
    expect(txn(target)).toMatchObject({ status: 'posted', revision: 2, marker: 1 });
    decide(setId, itemId, 'insert-new');
    const plan = planAndCommit(setId);
    expect(plan.effects.map((e) => e.op)).toEqual(['revert', 'unmatch', 'insert']);
    expect(txn(target)).toMatchObject({ status: 'pending', revision: 3, marker: null });
    const created = w.db.prepare("SELECT id FROM card_transactions WHERE id <> ?").pluck().get(target) as string;
    expect(txn(created)).toMatchObject({ status: 'posted', revision: 1 });
    expect(count("SELECT count(*) FROM card_source_identities WHERE canonical_transaction_id = ? AND status = 'active'", created)).toBe(1);
    expect(setRow(setId)).toMatchObject({ matched_count: 0, inserted_count: 1 });
    expect(item(setId).committed).toMatchObject({ action: 'insert-new', transactionId: created, revision: 1 });
  });

  it('refuses a change once the linked row moved on, and keeps it reversible after a category edit (C23)', () => {
    w.ingest(device, binding, [pending()]);
    const target = w.db.prepare('SELECT id FROM card_transactions').pluck().get() as string;
    const { setId, itemId } = committedWith([captured('posted')], 'same-transaction', target);
    w.repo.updateCardTransaction(target, { userCategory: 'Coffee' }, { actorRef: SCENARIO_OWNER });
    decide(setId, itemId, 'reject-row');
    w.repo.removeCardTransaction({ id: target, reason: 'mistaken-import', expectedRevision: 3, actorRef: SCENARIO_OWNER });
    refused('adjustment-not-reversible', () => w.repo.prepareCardSyncPlan({ principal: owner, setId,
      expectedVersion: setRow(setId).version as number, expectedGeneration: w.generation() }));
    refused('adjustment-not-reversible', () => decide(setId, itemId, 'insert-new'));
  });
});

describe('changing an insert, a correction or a rejection after commit (§4.9.2)', () => {
  it('removes an inserted row as a mistaken import, or moves it to the scope the owner picks', () => {
    const { setId, itemId } = committedWith([{ ...captured(), description: 'TAILSPIN TOYS', amount: 777 }], 'insert-new');
    const created = w.db.prepare('SELECT id FROM card_transactions').pluck().get() as string;
    refused('action-not-allowed', () => decide(setId, itemId, 'same-transaction', created));
    decide(setId, itemId, 'reject-row');
    planAndCommit(setId);
    expect(w.db.prepare('SELECT status, removed_reason FROM card_transactions').get()).toEqual({ status: 'removed',
      removed_reason: 'mistaken-import' });
    expect(setRow(setId)).toMatchObject({ inserted_count: 0, rejected_count: 1 });

    const other = committedWith([{ scope: unknown, date: '2026-10-05', amount: 555, description: 'LITWARE', id: 'sor-u' }], 'insert-new');
    const row = w.db.prepare('SELECT id FROM card_transactions WHERE amount_minor = 555').pluck().get() as string;
    decide(other.setId, other.itemId, 'attribute', null, known[1]);
    const plan = planAndCommit(other.setId);
    expect(plan.effects.map((e) => e.op)).toEqual(['restore-attribution']);
    expect(txn(row)).toMatchObject({ scope: known[1], revision: 2, marker: 1 });
    expect(setRow(other.setId)).toMatchObject({ inserted_count: 0, attributed_count: 1 });
  });

  it('reverts an accepted correction to keep the row as it was, and corrects a row it kept', () => {
    w.ingest(device, binding, [posted()]);
    const target = w.db.prepare('SELECT id FROM card_transactions').pluck().get() as string;
    const corrected = committedWith([{ ...posted(), description: 'FOURTH COFFEE ROASTERS' }], 'accept-correction');
    expect(w.db.prepare('SELECT description FROM card_transactions').pluck().get()).toBe('FOURTH COFFEE ROASTERS');
    decide(corrected.setId, corrected.itemId, 'keep-current');
    const plan = planAndCommit(corrected.setId);
    expect(plan.effects.map((e) => e.op)).toEqual(['revert']);
    expect(w.db.prepare('SELECT description, revision, reversal_snapshot_revision FROM card_transactions').get())
      .toEqual({ description: 'FOURTH COFFEE', revision: 3, reversal_snapshot_revision: null });
    expect(setRow(corrected.setId)).toMatchObject({ updated_count: 0, unchanged_count: 1 });

    const kept = committedWith([{ ...posted(), description: 'FOURTH COFFEE CO' }], 'keep-current');
    decide(kept.setId, kept.itemId, 'accept-correction');
    planAndCommit(kept.setId);
    expect(w.db.prepare('SELECT description, revision, reversal_snapshot_revision FROM card_transactions WHERE id = ?').get(target))
      .toEqual({ description: 'FOURTH COFFEE CO', revision: 4, reversal_snapshot_revision: 3 });
  });

  it('turns a rejected row into a new one, and answers nothing-to-adjust and observation-expired', () => {
    const { setId, itemId } = committedWith([{ ...captured(), amount: 4242, description: 'ADVENTURE WORKS' }], 'reject-row');
    refused('nothing-to-adjust', () => w.repo.prepareCardSyncPlan({ principal: owner, setId,
      expectedVersion: setRow(setId).version as number, expectedGeneration: w.generation() }));
    decide(setId, itemId, 'insert-new');
    planAndCommit(setId);
    expect(count('SELECT count(*) FROM card_transactions WHERE amount_minor = 4242')).toBe(1);
    expect(setRow(setId)).toMatchObject({ rejected_count: 0, inserted_count: 1 });
    w.tick(30 * 86_400);
    refused('observation-expired', () => decide(setId, itemId, 'reject-row'));
  });
});
