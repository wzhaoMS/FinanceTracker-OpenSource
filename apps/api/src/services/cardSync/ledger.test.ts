import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CardSyncScenario, SCENARIO_OWNER, type ScenarioDevice, type ScenarioRow } from '../../testing/cardSyncScenario.js';
import type { CardSourceBindingView } from '../sqliteStateRepo.js';
import { cardSyncRefusalCode } from './refusals.js';

// E1b design §5.7 (ledger operations), §5.7.1 (permanent maintenance),
// §4.9.3 (unmerge order), W5, W13, W17, W19 and tests K14, K15, O14–O18 of §7.

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

const count = (sql: string, ...params: unknown[]) => w.db.prepare(sql).pluck().get(...params) as number;
const ledgerRevision = () => count('SELECT ledger_revision FROM card_accounts WHERE id = ?', binding.cardAccountRef);
const idOf = (amount: number) => w.db.prepare('SELECT id FROM card_transactions WHERE amount_minor = ?').pluck().get(amount) as string;
const row = (id: string) => w.repo.getCardTransactionSources({ transactionId: id, continue: null,
  limits: { events: 100, identities: 500, merged: 100 } })!;
function refused(code: string, write: () => unknown): void {
  let error: unknown;
  try {
    write();
  } catch (caught) {
    error = caught;
  }
  expect(cardSyncRefusalCode(error), String(error)).toBe(code);
}
const auditCodes = () => w.db.prepare(`SELECT code FROM card_sync_audit_events WHERE event_type = 'ledger-maintenance' ORDER BY rowid`)
  .pluck().all();

const coffee = (): ScenarioRow => ({ scope: known[0], date: '2026-10-01', amount: 1250, description: 'FOURTH COFFEE', id: 'sor-1',
  secondary: [['chase-api:derived:v1', 'derived-1']] });
const parking = (): ScenarioRow => ({ scope: known[0], date: '2026-10-03', status: 'pending', amount: 800,
  description: 'NORTHWIND PARKING', id: 'sor-3' });
const market = (): ScenarioRow => ({ scope: known[1], date: '2026-10-02', amount: 4999, description: 'CONTOSO MARKET', id: 'sor-2' });

describe('removing, restoring and attributing a row (§5.7)', () => {
  it('dismisses a pending row, restores it reversibly, and reverts the restore exactly (W17)', () => {
    w.ingest(device, binding, [parking()]);
    const id = idOf(800);
    refused('transaction-revision-stale', () => w.repo.removeCardTransaction({ id, reason: 'dismissed', expectedRevision: 2,
      actorRef: SCENARIO_OWNER }));
    const before = ledgerRevision();
    w.tick(1);
    const removed = w.repo.removeCardTransaction({ id, reason: 'dismissed', expectedRevision: 1, actorRef: SCENARIO_OWNER });
    expect(removed).toMatchObject({ status: 'removed', removedReason: 'dismissed', removedFromStatus: 'pending', revision: 2,
      reversalSnapshotRevision: null });
    expect(ledgerRevision()).toBe(before + 1);
    refused('removal-not-allowed', () => w.repo.removeCardTransaction({ id, reason: 'cancelled', expectedRevision: 2,
      actorRef: SCENARIO_OWNER }));
    w.tick(1);
    const restored = w.repo.restoreCardTransaction({ id, expectedRevision: 2, actorRef: SCENARIO_OWNER });
    expect(restored).toMatchObject({ status: 'pending', revision: 3, reversalSnapshotRevision: 2, removedReason: null });
    const sources = row(id);
    expect(sources.events.map((e) => e.type)).toEqual(['restored', 'removed', 'created']);
    expect(sources.revertibleEventId).toBe(sources.events[0].eventId);
    const reverted = w.repo.revertCardTransactionChange({ transactionId: id, eventId: sources.revertibleEventId!, expectedRevision: 3,
      actorRef: SCENARIO_OWNER });
    expect(reverted).toMatchObject({ status: 'removed', removedReason: 'dismissed', revision: 4, reversalSnapshotRevision: null });
    expect(row(id).revertibleEventId).toBeNull();
    refused('change-not-reversible', () => w.repo.revertCardTransactionChange({ transactionId: id, eventId: sources.events[0].eventId,
      expectedRevision: 4, actorRef: SCENARIO_OWNER }));
    expect(auditCodes()).toEqual(['revert']);
  });

  it('attributes a row to another scope of its account, reversibly, and refuses a scope elsewhere', () => {
    const { receipt } = w.accept(device, binding, [{ ...market(), scope: unknown }]);
    const [item] = w.repo.getCardSyncObservationSetPage({ setId: receipt.observationSetId, after: null, limit: 10 })!.items;
    expect(item.reason).toBe('unknown-scope');
    w.repo.recordCardReviewDecisions({ setId: receipt.observationSetId, expectedVersion: 1, actorRef: SCENARIO_OWNER,
      decisions: [{ itemId: item.itemId, action: 'insert-new', transactionId: null, cardScopeId: null }] });
    const plan = w.repo.prepareCardSyncPlan({ principal: { kind: 'session', actorRef: SCENARIO_OWNER }, setId: receipt.observationSetId,
      expectedVersion: 2, expectedGeneration: w.generation() });
    if (plan.status !== 'executable') throw new Error('expected a plan');
    w.repo.commitCardSyncPlan({ principal: { kind: 'session', actorRef: SCENARIO_OWNER }, previewId: plan.previewId,
      payloadDigest: plan.payloadDigest, planDigest: plan.planDigest, expectedGeneration: w.generation() });
    const id = idOf(4999);
    refused('scope-invalid', () => w.repo.attributeCardTransaction({ id, cardScopeId: unknown, expectedRevision: 1,
      actorRef: SCENARIO_OWNER }));
    const elsewhere = w.scopes(w.binding()).known[0];
    refused('scope-invalid', () => w.repo.attributeCardTransaction({ id, cardScopeId: elsewhere, expectedRevision: 1,
      actorRef: SCENARIO_OWNER }));
    const attributed = w.repo.attributeCardTransaction({ id, cardScopeId: known[1], expectedRevision: 1, actorRef: SCENARIO_OWNER });
    expect(attributed).toMatchObject({ cardScopeId: known[1], revision: 2, reversalSnapshotRevision: 1 });
    const event = row(id).revertibleEventId!;
    expect(w.repo.revertCardTransactionChange({ transactionId: id, eventId: event, expectedRevision: 2, actorRef: SCENARIO_OWNER }))
      .toMatchObject({ cardScopeId: unknown, revision: 3, reversalSnapshotRevision: null });
  });
});

describe('merging and unmerging (§5.7, §4.9.3)', () => {
  it('merges a pending row into its posted version and unmerges it in order, at any age', () => {
    w.ingest(device, binding, [parking(), { scope: known[0], date: '2026-10-05', amount: 810, description: 'NORTHWIND PARKING',
      id: 'sor-posted' }]);
    const pending = idOf(800);
    const posted = idOf(810);
    w.repo.updateCardTransaction(pending, { userCategory: 'Parking', notes: 'office' }, { actorRef: SCENARIO_OWNER });
    const loserIdentities = count("SELECT count(*) FROM card_source_identities WHERE canonical_transaction_id = ? AND status = 'active'",
      pending);
    const survivor = w.repo.mergeCardTransactions({ survivorId: posted, loserId: pending, reason: 'settled-into',
      expectedRevisions: [1, 2], categoryFrom: 'loser', notesFrom: 'survivor', actorRef: SCENARIO_OWNER });
    expect(survivor).toMatchObject({ id: posted, userCategory: 'Parking', notes: null, revision: 2 });
    expect(w.repo.getCardTransactionSources({ transactionId: pending, continue: null,
      limits: { events: 10, identities: 10, merged: 10 } })!.transaction).toMatchObject({ status: 'removed', removedReason: 'settled-into',
      mergedIntoId: posted, revision: 3 });
    expect(count("SELECT count(*) FROM card_source_identities WHERE canonical_transaction_id = ? AND status = 'active'", pending)).toBe(0);
    expect(row(posted).mergedRows.map((m) => m.transactionId)).toEqual([pending]);
    expect(row(posted).events.filter((e) => e.type === 'identity-repointed')).toHaveLength(loserIdentities);
    // A replay of the pending row's capture now resolves to the survivor: known content, nothing to review.
    expect(w.accept(device, binding, [parking()]).receipt).toMatchObject({ reviewCount: 0 });

    w.tick(400 * 86_400);
    const back = w.repo.unmergeCardTransaction({ loserId: pending, expectedRevisions: [3, 2], actorRef: SCENARIO_OWNER });
    expect(back).toMatchObject({ status: 'pending', mergedIntoId: null, revision: 4 });
    expect(count("SELECT count(*) FROM card_source_identities WHERE canonical_transaction_id = ? AND status = 'active'", pending))
      .toBe(loserIdentities);
    expect(row(pending).events.filter((e) => e.revision === 4 && e.transactionId === pending).map((e) => e.type).sort())
      .toEqual([...Array<string>(loserIdentities).fill('identity-repointed'), 'restored', 'reversed']);
    expect(auditCodes()).toEqual(['unmerge']);
    refused('merge-not-allowed', () => w.repo.unmergeCardTransaction({ loserId: pending, expectedRevisions: [4, 2],
      actorRef: SCENARIO_OWNER }));
  });

  it('never merges rows of two different known cards, nor a posted row "settled into" another', () => {
    w.ingest(device, binding, [coffee(), market()]);
    refused('cross-card-link-refused', () => w.repo.mergeCardTransactions({ survivorId: idOf(1250), loserId: idOf(4999),
      reason: 'superseded', expectedRevisions: [1, 1], categoryFrom: 'survivor', notesFrom: 'survivor', actorRef: SCENARIO_OWNER }));
    refused('merge-not-allowed', () => w.repo.mergeCardTransactions({ survivorId: idOf(1250), loserId: idOf(1250),
      reason: 'superseded', expectedRevisions: [1, 1], categoryFrom: 'survivor', notesFrom: 'survivor', actorRef: SCENARIO_OWNER }));
  });
});

describe('aliases: detach and re-point (§5.7.1)', () => {
  it('detaches an alias so its next observation asks the owner, and refuses the last active identity', () => {
    w.ingest(device, binding, [coffee()]);
    const id = idOf(1250);
    const aliases = [...row(id).identities].sort((a, b) => (a.namespace === 'chase-api:sor:v1' ? -1 : 1) - (b.namespace === 'chase-api:sor:v1' ? -1 : 1));
    expect(aliases.map((a) => a.namespace)).toEqual(['chase-api:sor:v1', 'chase-api:derived:v1']);
    const revision = ledgerRevision();
    w.repo.detachCardSourceIdentity({ identityId: aliases[1].identityId, transactionId: id, expectedRevision: 1, actorRef: SCENARIO_OWNER });
    expect(ledgerRevision()).toBe(revision + 1);
    expect(Object.fromEntries(row(id).identities.map((a) => [a.namespace, a.status])))
      .toEqual({ 'chase-api:sor:v1': 'active', 'chase-api:derived:v1': 'detached' });
    refused('identity-not-active', () => w.repo.detachCardSourceIdentity({ identityId: aliases[1].identityId, transactionId: id,
      expectedRevision: 1, actorRef: SCENARIO_OWNER }));
    refused('identity-last-active', () => w.repo.detachCardSourceIdentity({ identityId: aliases[0].identityId, transactionId: id,
      expectedRevision: 1, actorRef: SCENARIO_OWNER }));
    // The detached tuple alone: a detached-identity review, never a silent replay.
    const { receipt } = w.accept(device, binding, [{ scope: known[0], date: '2026-10-01', amount: 1250, description: 'FOURTH COFFEE',
      id: 'derived-1-as-primary', secondary: [['chase-api:derived:v1', 'derived-1']] }]);
    expect(w.repo.getCardSyncObservationSetPage({ setId: receipt.observationSetId, after: null, limit: 10 })!.items[0])
      .toMatchObject({ reason: 'detached-identity' });
    expect(auditCodes()).toEqual(['detach']);
  });

  it('re-points an alias to another live row of the account, and keeps it off another known card', () => {
    w.ingest(device, binding, [coffee(), { scope: known[0], date: '2026-10-02', amount: 1260, description: 'FOURTH COFFEE', id: 'sor-x' },
      market()]);
    const from = idOf(1250);
    const to = idOf(1260);
    const alias = row(from).identities.find((a) => a.namespace === 'chase-api:derived:v1')!;
    refused('cross-card-link-refused', () => w.repo.repointCardSourceIdentity({ identityId: alias.identityId, fromTransactionId: from,
      toTransactionId: idOf(4999), expectedRevisions: [1, 1], actorRef: SCENARIO_OWNER }));
    refused('repoint-not-allowed', () => w.repo.repointCardSourceIdentity({ identityId: alias.identityId, fromTransactionId: from,
      toTransactionId: from, expectedRevisions: [1, 1], actorRef: SCENARIO_OWNER }));
    const moved = w.repo.repointCardSourceIdentity({ identityId: alias.identityId, fromTransactionId: from, toTransactionId: to,
      expectedRevisions: [1, 1], actorRef: SCENARIO_OWNER });
    expect(moved.to.revision).toBe(1);
    expect(row(to).identities.map((a) => a.identityId)).toContain(alias.identityId);
    // The move shows on the row it left too (the history's second arm).
    expect(row(from).events.map((e) => e.type)).toContain('identity-repointed');
    refused('transaction-revision-stale', () => w.repo.repointCardSourceIdentity({ identityId: alias.identityId, fromTransactionId: from,
      toTransactionId: to, expectedRevisions: [1, 1], actorRef: SCENARIO_OWNER }));
    expect(auditCodes()).toEqual(['repoint']);
  });
});

describe('reads (§5.7)', () => {
  it('pages a row\'s history newest first and lists pending rows nothing has shown again for 14 days', () => {
    w.ingest(device, binding, [parking()]);
    const id = idOf(800);
    for (let i = 0; i < 3; i += 1) {
      w.tick(1);
      w.repo.updateCardTransaction(id, { notes: `note ${i}` }, { actorRef: SCENARIO_OWNER });
    }
    const first = w.repo.getCardTransactionSources({ transactionId: id, continue: null, limits: { events: 2, identities: 1, merged: 1 } })!;
    expect(first.events.map((e) => e.type)).toEqual(['user-edited', 'user-edited']);
    const second = w.repo.getCardTransactionSources({ transactionId: id, continue: { events: first.nextEvents! },
      limits: { events: 2, identities: 1, merged: 1 } })!;
    expect(second.events.map((e) => e.type)).toEqual(['user-edited', 'created']);
    expect(second.nextEvents).toBeNull();
    expect(w.repo.listStalePendingCardTransactions()).toEqual([]);
    w.tick(14 * 86_400);
    expect(w.repo.listStalePendingCardTransactions().map((r) => r.id)).toEqual([id]);
  });
});
