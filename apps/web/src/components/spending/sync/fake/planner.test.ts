import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DecisionAction, ReviewCategory, ReviewReason } from '../ownerApi';
import { cardTransactionIdFor, ownerIdFor, syncIdFor, type CandidateRec, type ItemRec, type RowRec, type SetRec } from './model';
import { applyCommit, computePlan } from './planner';

/**
 * The fake planner against E1b §4.6 (what a decision does to its target, by the statuses on both sides), §4.8 (the
 * counts) and §4.9.2 (reversing exactly what a committed decision did). Sets are built from file rows, so every
 * status pair can be set up directly.
 */
const SCOPE = syncIdFor('cardScope', 'planner/scope');
const OTHER_SCOPE = syncIdFor('cardScope', 'planner/other-scope');

function row(status: 'pending' | 'posted', extra: Partial<RowRec> = {}): RowRec {
  return {
    transactionDate: '2026-10-10', postedDate: status === 'posted' ? '2026-10-11' : null, status, amountMinor: 4_500, kind: 'purchase',
    description: 'CONTOSO MARKET 0042', merchant: 'Contoso Market', issuerCategory: null, cardScopeId: SCOPE, identity: 'stable',
    originalAmountMinor: null, originalCurrency: null, ...extra,
  };
}

function candidate(status: CandidateRec['status'], extra: Partial<CandidateRec> = {}): CandidateRec {
  return {
    transactionId: cardTransactionIdFor(`planner/${status}`), cardScopeId: OTHER_SCOPE, scopeKind: 'known', sourceKind: 'file', status,
    transactionDate: '2026-10-09', postedDate: status === 'posted' ? '2026-10-09' : null, amountMinor: 4_000, kind: 'purchase',
    description: 'CONTOSO MKT', merchant: null, userCategory: 'Groceries', notes: null, matchedOn: ['date', 'amount'], blockedReason: null, ...extra,
  };
}

function item(category: ReviewCategory, reason: ReviewReason, target: CandidateRec, allowed: DecisionAction[]): ItemRec {
  return {
    itemId: ownerIdFor('reviewItem', `planner/${category}/${reason}/${target.status}`), category, reason, rowIndex: 0, candidates: [target],
    difference: null, allowedActions: allowed, decision: null, committed: null, insertedTransactionId: null,
  };
}

function setOf(observed: RowRec, entry: ItemRec, state: SetRec['state'] = 'needs-review'): SetRec {
  return {
    observationSetId: syncIdFor('observationSet', `planner/${entry.itemId}`), origin: 'file', runId: null, bindingId: null, deviceId: null,
    importBatchId: null, cardAccountRef: 'card-acct-aaaabbbbccccddddeeeeffffgggghhhh', version: 1, state, acceptedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER,
    payload: null, fileRows: [observed], payloadDigest: null, rowCount: 1, byteCount: 0, rejectedCount: 0, receiptExpiresAt: null,
    items: [entry], autoRows: new Map(), plans: [], committedAt: null, closedAt: null, closeReason: null, discardReason: null, results: [],
  };
}

const decide = (entry: ItemRec, action: DecisionAction, target: CandidateRec | null = null) => {
  entry.decision = { action, transactionId: target?.transactionId ?? null, cardScopeId: null, at: 1 };
};
const commitWith = (entry: ItemRec, action: DecisionAction, target: CandidateRec | null = null) => {
  entry.committed = { action, transactionId: target?.transactionId ?? null, cardScopeId: null, at: 1 };
};
const kinds = (set: SetRec) => computePlan(set).effects.map((effect) => effect.effect);

describe('the fake planner follows E1b §4.6 by the statuses on both sides', () => {
  test('a posted row linked to a pending charge promotes it: the bank\'s values, posted, the owner\'s scope and edits kept', () => {
    const target = candidate('pending');
    const entry = item('pending-link', 'pending-may-have-posted', target, ['same-transaction', 'insert-new', 'reject-row']);
    decide(entry, 'same-transaction', target);
    const plan = computePlan(setOf(row('posted'), entry));
    assert.deepEqual(plan.effects.map((effect) => effect.effect), ['promote']);
    const [promote] = plan.effects;
    assert.deepEqual(
      [promote.before?.status, promote.after?.status, promote.after?.amountMinor, promote.after?.merchant, promote.after?.cardScopeId],
      ['pending', 'posted', 4_500, 'Contoso Market', OTHER_SCOPE],
    );
    assert.deepEqual([plan.counts.matched, plan.counts.promoted, plan.counts.update], [1, 1, 1]);
  });

  test('a pending row linked to a charge already posted changes nothing: posted is never downgraded', () => {
    const target = candidate('posted');
    const entry = item('pending-link', 'pending-may-have-posted', target, ['same-transaction', 'insert-new', 'reject-row']);
    decide(entry, 'same-transaction', target);
    const plan = computePlan(setOf(row('pending'), entry));
    assert.deepEqual(plan.effects.map((effect) => effect.effect), ['match']);
    assert.deepEqual(plan.effects[0].after, plan.effects[0].before);
    assert.equal(plan.effects[0].after?.status, 'posted');
    assert.deepEqual([plan.counts.matched, plan.counts.promoted, plan.counts.update], [1, 0, 0]);
  });

  test('a posted row that hits a charge removed from pending restores it as posted', () => {
    const target = candidate('removed');
    const entry = item('pending-link', 'removed-hit', target, ['same-transaction', 'reject-row']);
    decide(entry, 'same-transaction', target);
    const [effect] = computePlan(setOf(row('posted'), entry)).effects;
    assert.deepEqual([effect.effect, effect.before?.status, effect.after?.status], ['promote', 'removed', 'posted']);
  });

  test('an identity hit on a pending row is a plain promote, counted as promoted and updated, not matched', () => {
    const target = candidate('pending');
    const entry = item('pending-link', 'pending-posted', target, ['same-transaction', 'reject-row']);
    decide(entry, 'same-transaction', target);
    const set = setOf(row('posted'), entry);
    const plan = computePlan(set);
    assert.deepEqual([plan.effects[0].effect, plan.counts.matched, plan.counts.promoted, plan.counts.update], ['promote', 0, 1, 1]);
    applyCommit(set, plan.effects, 2);
    assert.deepEqual(set.results, [{ rowIndex: 0, result: 'updated', transactionId: target.transactionId }]);
  });

  test('accepting a correction takes the bank\'s values and keeps the status, or restores a removed row', () => {
    const posted = candidate('posted');
    const correction = item('posted-correction', 'posted-correction', posted, ['accept-correction', 'keep-current']);
    // The stored identity names the row a correction is about: the decision names none (E1b ck_rvw_draft_shape).
    decide(correction, 'accept-correction');
    const [corrected] = computePlan(setOf(row('posted', { amountMinor: 4_900, merchant: 'Contoso Market East' }), correction)).effects;
    assert.deepEqual([corrected.effect, corrected.transactionId, corrected.after?.status, corrected.after?.amountMinor, corrected.after?.merchant],
      ['correct', posted.transactionId, 'posted', 4_900, 'Contoso Market East']);
    const removed = candidate('removed');
    const restore = item('posted-correction', 'removed-hit', removed, ['accept-correction', 'keep-current']);
    decide(restore, 'accept-correction');
    const plan = computePlan(setOf(row('pending'), restore));
    assert.deepEqual([plan.effects[0].before?.status, plan.effects[0].after?.status, plan.counts.corrected, plan.counts.update], ['removed', 'pending', 1, 1]);
  });

  test('a compound match commits as matched, onto the target', () => {
    const target = candidate('pending');
    const entry = item('pending-link', 'pending-may-have-posted', target, ['same-transaction', 'insert-new', 'reject-row']);
    decide(entry, 'same-transaction', target);
    const set = setOf(row('posted'), entry);
    applyCommit(set, computePlan(set).effects, 2);
    assert.deepEqual(set.results, [{ rowIndex: 0, result: 'matched', transactionId: target.transactionId }]);
  });
});

describe('the fake planner reverses exactly what a committed decision did (E1b §4.9.2)', () => {
  test('a link that changed nothing is only unlinked; a new row follows when asked for', () => {
    const target = candidate('posted');
    const entry = item('pending-link', 'pending-may-have-posted', target, ['same-transaction', 'insert-new', 'reject-row']);
    commitWith(entry, 'same-transaction', target);
    decide(entry, 'insert-new');
    assert.deepEqual(kinds(setOf(row('pending'), entry, 'committed')), ['unmatch', 'insert']);
  });

  test('a link that attributed and promoted is undone by one revert of the whole snapshot, card included: never four steps', () => {
    const target = candidate('pending', { scopeKind: 'legacy' });
    const entry = item('cross-source-similar', 'cross-source-similar', target, ['attribute-and-link', 'insert-new', 'reject-row']);
    entry.committed = { action: 'attribute-and-link', transactionId: target.transactionId, cardScopeId: SCOPE, at: 1 };
    decide(entry, 'insert-new');
    const plan = computePlan(setOf(row('posted'), entry, 'committed'));
    assert.deepEqual(plan.effects.map((effect) => effect.effect), ['revert', 'unmatch', 'insert']);
    const [revert] = plan.effects;
    assert.deepEqual([revert.before?.cardScopeId, revert.before?.status, revert.after?.cardScopeId, revert.after?.status], [SCOPE, 'posted', OTHER_SCOPE, 'pending']);
    assert.deepEqual([plan.counts.update, plan.counts.attributed, plan.counts.unmatched, plan.counts.insert], [1, 0, 1, 1]);
  });

  test('a link that only attributed is undone by one revert, card included, then unlinked; restore-attribution is only for a row the commit created (X30)', () => {
    const target = candidate('posted', { scopeKind: 'legacy' });
    const entry = item('cross-source-similar', 'cross-source-similar', target, ['attribute-and-link', 'insert-new', 'reject-row']);
    entry.committed = { action: 'attribute-and-link', transactionId: target.transactionId, cardScopeId: SCOPE, at: 1 };
    decide(entry, 'reject-row');
    const plan = computePlan(setOf(row('posted'), entry, 'committed'));
    assert.deepEqual(plan.effects.map((effect) => effect.effect), ['revert', 'unmatch']);
    assert.deepEqual([plan.effects[0].before?.cardScopeId, plan.effects[0].after?.cardScopeId], [SCOPE, OTHER_SCOPE]);
    assert.deepEqual([plan.counts.update, plan.counts.attributed, plan.counts.unmatched], [1, 0, 1]);
  });

  test('a link that promoted is reverted to the exact earlier values first, then unlinked', () => {
    const target = candidate('pending');
    const entry = item('pending-link', 'pending-may-have-posted', target, ['same-transaction', 'insert-new', 'reject-row']);
    commitWith(entry, 'same-transaction', target);
    decide(entry, 'reject-row');
    const plan = computePlan(setOf(row('posted'), entry, 'committed'));
    assert.deepEqual(plan.effects.map((effect) => effect.effect), ['revert', 'unmatch']);
    assert.deepEqual([plan.effects[0].before?.status, plan.effects[0].after?.status, plan.effects[0].after?.amountMinor], ['posted', 'pending', 4_000]);
    assert.deepEqual([plan.counts.update, plan.counts.unmatched, plan.counts.rejected], [1, 1, 0]);
  });

  test('a correction that restored a removed row is reverted to removed', () => {
    const removed = candidate('removed');
    const entry = item('posted-correction', 'removed-hit', removed, ['accept-correction', 'keep-current']);
    commitWith(entry, 'accept-correction');
    decide(entry, 'keep-current');
    const [revert] = computePlan(setOf(row('pending'), entry, 'committed')).effects;
    assert.deepEqual([revert.effect, revert.before?.status, revert.after?.status], ['revert', 'pending', 'removed']);
  });

  test('a new row later linked to a pending charge is superseded into it, and the charge is promoted without a second match', () => {
    const target = candidate('pending');
    const entry = item('pending-link', 'pending-may-have-posted', target, ['same-transaction', 'insert-new', 'reject-row']);
    commitWith(entry, 'insert-new');
    decide(entry, 'same-transaction', target);
    const plan = computePlan(setOf(row('posted'), entry, 'committed'));
    assert.deepEqual(plan.effects.map((effect) => effect.effect), ['supersede', 'promote']);
    assert.deepEqual([plan.counts.superseded, plan.counts.promoted, plan.counts.update, plan.counts.matched], [1, 1, 1, 0]);
  });
});
