import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CardSyncScenario, SCENARIO_OWNER, type ScenarioDevice, type ScenarioRow } from '../../testing/cardSyncScenario.js';
import { makeScratchDir, removeScratchDir } from '../../testing/scratchDir.js';
import { SqliteStateRepo } from '../sqliteStateRepo.js';
import type { CardSourceBindingView, CardSyncPlanView } from '../sqliteStateRepo.js';
import { cardSyncPlanDigest } from '@finance-tracker/shared';

import { storedPlanBody } from '../cardLedger/planBody.js';
import { cardSyncRefusalCode } from './refusals.js';

// E1b design §5.5 (review queue), §5.6 and §4.6–§4.10.3 (plans and commit),
// §6's C1, C4, C6, C10, C11, C19, C20 and tests O1–O9, D26–D28 of §7.

let w: CardSyncScenario;
let binding: CardSourceBindingView;
let device: ScenarioDevice;
let known: string[];

beforeEach(() => {
  w = new CardSyncScenario();
  w.enable('chase');
  binding = w.binding();
  device = w.device([binding.bindingId]);
  ({ known } = w.scopes(binding));
});

afterEach(() => {
  w.close();
});

const owner = { kind: 'session' as const, actorRef: SCENARIO_OWNER };
const asDevice = (d: ScenarioDevice) => ({ kind: 'device' as const, deviceId: d.deviceId });
const count = (sql: string, ...params: unknown[]) => w.db.prepare(sql).pluck().get(...params) as number;
const ledgerRevision = () => count(`SELECT ledger_revision FROM card_accounts WHERE id = ?`, binding.cardAccountRef);
const setRow = (id: string) => w.db.prepare('SELECT * FROM card_sync_observation_sets WHERE id = ?').get(id) as Record<string, unknown>;
function refused(code: string, write: () => unknown): void {
  let error: unknown;
  try {
    write();
  } catch (caught) {
    error = caught;
  }
  expect(cardSyncRefusalCode(error), String(error)).toBe(code);
}

const coffee = (): ScenarioRow => ({ scope: known[0], date: '2026-10-01', amount: 1250, description: 'FOURTH COFFEE',
  merchant: 'Fourth Coffee', id: 'sor-1' });
const market = (): ScenarioRow => ({ scope: known[0], date: '2026-10-02', amount: 4999, description: 'CONTOSO MARKET', id: 'sor-2',
  secondary: [['chase-api:derived:v1', 'derived-2']] });
const parking = (): ScenarioRow => ({ scope: known[1], date: '2026-10-03', status: 'pending', amount: 800,
  description: 'NORTHWIND PARKING', id: 'sor-3' });

function ownerPlan(setId: string): CardSyncPlanView {
  const set = setRow(setId);
  const plan = w.repo.prepareCardSyncPlan({ principal: owner, setId, expectedVersion: set.version as number,
    expectedGeneration: w.generation() });
  expect(plan.status).toBe('executable');
  return plan as CardSyncPlanView;
}
function commit(plan: CardSyncPlanView, principal: Parameters<typeof w.repo.commitCardSyncPlan>[0]['principal'] = owner) {
  return w.repo.commitCardSyncPlan({ principal, previewId: plan.previewId, payloadDigest: plan.payloadDigest, planDigest: plan.planDigest,
    expectedGeneration: w.generation() });
}
function decide(setId: string, decisions: Array<{ itemId: string; action: string; transactionId?: string | null; cardScopeId?: string | null }>) {
  return w.repo.recordCardReviewDecisions({
    setId, expectedVersion: setRow(setId).version as number, actorRef: SCENARIO_OWNER,
    decisions: decisions.map((d) => ({ itemId: d.itemId, action: d.action as never, transactionId: d.transactionId ?? null,
      cardScopeId: d.cardScopeId ?? null })),
  });
}
const firstPage = (setId: string) => w.repo.getCardSyncObservationSetPage({ setId, after: null, limit: 100 })!;

describe('a first sync with nothing ambiguous (§4.4, §4.10.3)', () => {
  it('hands the device\'s preview to the owner, whose plan inserts every row with its identities, contents and events', () => {
    const { receipt, runId } = w.accept(device, binding, [coffee(), market(), parking()]);
    expect(receipt).toMatchObject({ state: 'accepted-uncommitted', reviewCount: 0 });
    const before = count('SELECT count(*) FROM card_sync_commit_plans');
    const preview = w.repo.prepareCardSyncPlan({ principal: asDevice(device), setId: receipt.observationSetId,
      expectedGeneration: w.generation() });
    // Every admission is closed (Q5): a new row waits for the owner, whose plan needs no decision.
    expect(preview).toEqual({ status: 'owner-review', observationSetId: receipt.observationSetId, reviewCount: 0,
      counts: expect.objectContaining({ insert: 3 }) });
    expect('previewId' in preview).toBe(false);
    expect(count('SELECT count(*) FROM card_sync_commit_plans')).toBe(before);

    const plan = ownerPlan(receipt.observationSetId);
    expect(plan).toMatchObject({ planKind: 'set', setVersion: 1, payloadDigest: receipt.payloadDigest, effectCount: 3,
      counts: { insert: 3, update: 0, unchanged: 0, aliased: 0, matched: 0, attributed: 0, promoted: 0, corrected: 0, rejected: 0,
        unmatched: 0, superseded: 0 } });
    const result = commit(plan);
    expect(result).toMatchObject({ status: 'committed', replayed: false, setVersion: 2, committedAt: w.now(), counts: plan.counts });
    expect(ledgerRevision()).toBe(1);
    expect(w.db.prepare(`SELECT status, amount_minor, card_scope_id, first_sync_run_id, revision, source FROM card_transactions
      ORDER BY transaction_date`).all()).toEqual([
      { status: 'posted', amount_minor: 1250, card_scope_id: known[0], first_sync_run_id: runId, revision: 1, source: 'chase-api' },
      { status: 'posted', amount_minor: 4999, card_scope_id: known[0], first_sync_run_id: runId, revision: 1, source: 'chase-api' },
      { status: 'pending', amount_minor: 800, card_scope_id: known[1], first_sync_run_id: runId, revision: 1, source: 'chase-api' },
    ]);
    expect(count("SELECT count(*) FROM card_source_identities WHERE created_origin = 'session' AND status = 'active'")).toBe(4);
    expect(count("SELECT count(*) FROM card_identity_contents WHERE resolution = 'inserted'")).toBe(4);
    expect(w.db.prepare(`SELECT event_type, reason, origin, actor_kind, count(*) AS n FROM card_transaction_events
      GROUP BY event_type, reason, origin, actor_kind ORDER BY event_type`).all()).toEqual([
      { event_type: 'created', reason: 'insert', origin: 'extension', actor_kind: 'session', n: 3 },
      { event_type: 'identity-linked', reason: 'alias', origin: 'extension', actor_kind: 'session', n: 1 },
    ]);
    expect(setRow(receipt.observationSetId)).toMatchObject({ state: 'committed', version: 2, open_count: 0, inserted_count: 3,
      close_reason: 'committed', closed_by_ref: SCENARIO_OWNER });
    expect(count("SELECT count(*) FROM card_source_observations WHERE state = 'resolved' AND outcome = 'inserted' AND provenance = 1"))
      .toBe(3);
    expect(count("SELECT count(*) FROM card_coverage_windows WHERE ledger_state = 'committed'")).toBe(2);
    expect(count("SELECT count(*) FROM card_sync_commit_plans WHERE status = 'consumed'")).toBe(1);

    // C6: a lost commit ACK replays the stored result; other digests are a mismatch; another principal never sees the plan.
    expect(commit(plan)).toEqual({ ...result, replayed: true });
    refused('plan-mismatch', () => w.repo.commitCardSyncPlan({ principal: owner, previewId: plan.previewId,
      payloadDigest: plan.payloadDigest, planDigest: `pl1:${'a'.repeat(64)}`, expectedGeneration: w.generation() }));
    refused('plan-not-found', () => commit(plan, asDevice(device)));
  });

  it('lets a device commit a replay of what the ledger already holds, by itself (C1, D26)', () => {
    const first = w.accept(device, binding, [coffee(), market()]).receipt;
    commit(ownerPlan(first.observationSetId));
    const revision = ledgerRevision();
    const other = w.device([binding.bindingId]);
    const second = w.accept(other, binding, [coffee(), market()]).receipt;
    expect(second).toMatchObject({ state: 'accepted-uncommitted', reviewCount: 0 });
    const preview = w.repo.prepareCardSyncPlan({ principal: asDevice(other), setId: second.observationSetId,
      expectedGeneration: w.generation() }) as CardSyncPlanView;
    expect(preview).toMatchObject({ status: 'executable', counts: expect.objectContaining({ unchanged: 2, insert: 0 }), effectCount: 0 });
    const result = commit(preview, asDevice(other));
    expect(result).toMatchObject({ replayed: false });
    expect(ledgerRevision()).toBe(revision);
    expect(count('SELECT count(*) FROM card_transactions')).toBe(2);
    expect(setRow(second.observationSetId)).toMatchObject({ state: 'committed', unchanged_count: 2, closed_by_ref: null });
    expect(count('SELECT count(*) FROM card_source_identities WHERE last_seen_run_id = ?', second.runId)).toBe(3);
    // The device commits only its own auto-eligible plan.
    refused('plan-not-found', () => commit(preview, asDevice(device)));
  });
});

describe('review decisions and their plans (§4.5–§4.6, §5.5)', () => {
  it('links a capture row to the posted row it names, recording the link (no-stable-id, same-transaction)', () => {
    commit(ownerPlan(w.accept(device, binding, [coffee()]).receipt.observationSetId));
    const stored = count("SELECT count(*) FROM card_transactions");
    const target = w.db.prepare('SELECT id FROM card_transactions').pluck().get() as string;
    const { receipt } = w.accept(device, binding, [{ scope: known[0], date: '2026-10-02', amount: 1250, description: 'FOURTH COFFEE #2',
      merchant: 'Fourth Coffee' }]);
    expect(receipt).toMatchObject({ state: 'needs-review', reviewCount: 1 });
    const page = firstPage(receipt.observationSetId);
    expect(page.items).toEqual([expect.objectContaining({
      reason: 'no-stable-id', category: 'no-stable-id', allowedActions: ['same-transaction', 'insert-new', 'reject-row'],
      candidates: [{ rank: 1, transactionId: target, rule: 'near-content:v1', matchedOn: 6, blockedReason: null }], status: 'open',
    })]);
    refused('decisions-incomplete', () => ownerPlan(receipt.observationSetId));
    refused('action-not-allowed', () => decide(receipt.observationSetId, [{ itemId: page.items[0].itemId, action: 'accept-correction' }]));
    const decided = decide(receipt.observationSetId, [{ itemId: page.items[0].itemId, action: 'same-transaction', transactionId: target }]);
    expect(decided.version).toBe(2);
    expect(decided.items[0]).toMatchObject({ status: 'decided', draft: { action: 'same-transaction', transactionId: target } });
    const plan = ownerPlan(receipt.observationSetId);
    expect(plan.counts).toMatchObject({ matched: 1, insert: 0 });
    commit(plan);
    expect(count('SELECT count(*) FROM card_transactions')).toBe(stored);
    expect(count("SELECT count(*) FROM card_source_identities WHERE canonical_transaction_id = ? AND namespace_kind = 'capture'", target))
      .toBe(1);
    expect(count("SELECT count(*) FROM card_identity_contents WHERE resolution = 'linked'")).toBe(1);
    expect(count("SELECT count(*) FROM card_transaction_events WHERE event_type = 'identity-linked' AND reason = 'same-transaction'"))
      .toBe(1);
    expect(firstPage(receipt.observationSetId).items[0]).toMatchObject({ status: 'committed',
      committed: { action: 'same-transaction', transactionId: target, revision: 1 } });
    expect(setRow(receipt.observationSetId)).toMatchObject({ state: 'committed', matched_count: 1 });
  });

  it('corrects a posted row on the owner\'s word, reversibly, and promotes a pending row the same way', () => {
    commit(ownerPlan(w.accept(device, binding, [coffee(), parking()]).receipt.observationSetId));
    const { receipt } = w.accept(device, binding, [
      { ...coffee(), description: 'FOURTH COFFEE ROASTERS' },
      { ...parking(), status: 'posted', posted: '2026-10-05' },
    ]);
    const items = firstPage(receipt.observationSetId).items;
    expect(items.map((item) => [item.reason, item.allowedActions])).toEqual([
      ['posted-correction', ['accept-correction', 'keep-current']],
      ['pending-posted', ['same-transaction', 'reject-row']],
    ]);
    decide(receipt.observationSetId, [
      { itemId: items[0].itemId, action: 'accept-correction' },
      { itemId: items[1].itemId, action: 'same-transaction', transactionId: items[1].candidates[0].transactionId },
    ]);
    const plan = ownerPlan(receipt.observationSetId);
    expect(plan.counts).toMatchObject({ corrected: 1, promoted: 1, update: 2 });
    commit(plan);
    expect(w.db.prepare(`SELECT description, status, revision, reversal_snapshot_revision AS marker FROM card_transactions
      ORDER BY transaction_date`).all()).toEqual([
      { description: 'FOURTH COFFEE ROASTERS', status: 'posted', revision: 2, marker: 1 },
      { description: 'NORTHWIND PARKING', status: 'posted', revision: 2, marker: 1 },
    ]);
    expect(w.db.prepare(`SELECT event_type, reason FROM card_transaction_events WHERE transaction_revision = 2 ORDER BY event_type`).all())
      .toEqual([{ event_type: 'corrected', reason: 'posted-correction' }, { event_type: 'promoted', reason: 'same-transaction' }]);
    expect(count('SELECT count(*) FROM card_transaction_versions')).toBe(2);
    // The corrected content is known now: the same capture again changes nothing and asks nothing.
    const again = w.accept(device, binding, [{ ...coffee(), description: 'FOURTH COFFEE ROASTERS' }]).receipt;
    expect(again).toMatchObject({ state: 'accepted-uncommitted', reviewCount: 0 });
  });

  it('acknowledges a statement that disagrees as part of the plan (statement-mismatch)', () => {
    const { receipt } = w.accept(device, binding, [coffee()], {
      statement: { chargesMinor: 1300, creditsMinor: null, netMinor: null, previousBalanceMinor: null, newBalanceMinor: null },
    });
    const [item] = firstPage(receipt.observationSetId).items;
    expect(item).toMatchObject({ itemKey: -1, reason: 'statement-mismatch', allowedActions: ['accept-difference'],
      difference: { field: 'charges', expectedMinor: 1300, actualMinor: 1250 } });
    refused('decisions-incomplete', () => ownerPlan(receipt.observationSetId));
    decide(receipt.observationSetId, [{ itemId: item.itemId, action: 'accept-difference' }]);
    const plan = ownerPlan(receipt.observationSetId);
    expect(plan.effects.map((effect) => effect.op)).toEqual(['insert', 'accept-difference']);
    commit(plan);
    expect(firstPage(receipt.observationSetId).items[0]).toMatchObject({ status: 'committed', committed: { action: 'accept-difference' } });
  });

  it('refuses two decisions on one row, and a batch on a stale version (C19)', () => {
    commit(ownerPlan(w.accept(device, binding, [coffee()]).receipt.observationSetId));
    const target = w.db.prepare('SELECT id FROM card_transactions').pluck().get() as string;
    const { receipt } = w.accept(device, binding, [
      { scope: known[0], date: '2026-10-02', amount: 1250, description: 'FOURTH COFFEE A' },
      { scope: known[0], date: '2026-09-30', amount: 1250, description: 'FOURTH COFFEE B' },
    ]);
    const items = firstPage(receipt.observationSetId).items;
    refused('decision-conflict', () => decide(receipt.observationSetId, items.map((item) => ({ itemId: item.itemId,
      action: 'same-transaction', transactionId: target }))));
    const version = setRow(receipt.observationSetId).version as number;
    decide(receipt.observationSetId, [{ itemId: items[0].itemId, action: 'same-transaction', transactionId: target }]);
    refused('version-conflict', () => w.repo.recordCardReviewDecisions({ setId: receipt.observationSetId, expectedVersion: version,
      actorRef: SCENARIO_OWNER, decisions: [{ itemId: items[1].itemId, action: 'insert-new', transactionId: null, cardScopeId: null }] }));
    refused('decision-conflict', () => decide(receipt.observationSetId, [{ itemId: items[1].itemId, action: 'same-transaction',
      transactionId: target }]));
  });
});

describe('staleness, refresh and plan lifetimes (§4.5, §5.5, §6)', () => {
  it('refuses a stale review until a refresh re-classifies the set, then plans against the ledger as it is (C11)', () => {
    const a = w.accept(device, binding, [coffee()]).receipt;
    const b = w.accept(device, binding, [{ ...coffee(), description: 'FOURTH COFFEE' }, market()]).receipt;
    expect(b).toMatchObject({ state: 'accepted-uncommitted', reviewCount: 0 });
    const stalePlan = ownerPlan(b.observationSetId);
    commit(ownerPlan(a.observationSetId));
    // B's plan inserted coffee too: the ledger moved, so its plan is stale and its review must be refreshed.
    refused('preview-stale', () => commit(stalePlan));
    refused('review-stale', () => ownerPlan(b.observationSetId));
    expect(w.repo.refreshCardReviewItems({ setId: b.observationSetId })).toEqual({ changed: false, version: 1, expired: false });
    const plan = ownerPlan(b.observationSetId);
    expect(plan.counts).toMatchObject({ unchanged: 1, insert: 1 });
    commit(plan);
    expect(count('SELECT count(*) FROM card_transactions')).toBe(2);
  });

  it('keeps a valid draft through a refresh that re-ranks its candidates, and stores the body it digests (§4.5, §4.8)', () => {
    commit(ownerPlan(w.accept(device, binding, [coffee()]).receipt.observationSetId));
    const older = w.db.prepare('SELECT id FROM card_transactions').pluck().get() as string;
    const { receipt } = w.accept(device, binding, [{ scope: known[0], date: '2026-10-02', amount: 1250, description: 'FOURTH COFFEE' }]);
    const [first] = firstPage(receipt.observationSetId).items;
    decide(receipt.observationSetId, [{ itemId: first.itemId, action: 'same-transaction', transactionId: older }]);
    // Another set brings a closer row: the ledger moves, the item is re-ranked, and its draft survives (still a candidate).
    commit(ownerPlan(w.accept(device, binding, [{ scope: known[0], date: '2026-10-02', amount: 1250, description: 'FOURTH COFFEE',
      id: 'sor-closer' }]).receipt.observationSetId));
    const closer = w.db.prepare('SELECT id FROM card_transactions WHERE id <> ?').pluck().get(older) as string;
    refused('review-stale', () => ownerPlan(receipt.observationSetId));
    expect(w.repo.refreshCardReviewItems({ setId: receipt.observationSetId })).toMatchObject({ changed: true, version: 3 });
    const [after] = firstPage(receipt.observationSetId).items;
    expect(after.candidates.map((c) => c.transactionId)).toEqual([closer, older]);
    expect(after).toMatchObject({ status: 'decided', draft: { action: 'same-transaction', transactionId: older } });
    const plan = ownerPlan(receipt.observationSetId);
    const row = w.db.prepare('SELECT * FROM card_sync_commit_plans WHERE id = ?').get(plan.previewId) as never;
    const actions = w.db.prepare('SELECT * FROM card_sync_plan_actions WHERE plan_id = ? ORDER BY ordinal').all(plan.previewId) as never[];
    expect(cardSyncPlanDigest(storedPlanBody(row, actions))).toBe(plan.planDigest);
    commit(plan);
    expect(firstPage(receipt.observationSetId).items[0].committed).toMatchObject({ action: 'same-transaction', transactionId: older });
  });

  it('cancels a prepared plan when decisions change, and expires it after 600 s (C20, C13)', () => {
    commit(ownerPlan(w.accept(device, binding, [coffee()]).receipt.observationSetId));
    const target = w.db.prepare('SELECT id FROM card_transactions').pluck().get() as string;
    const { receipt } = w.accept(device, binding, [{ scope: known[0], date: '2026-10-02', amount: 1250, description: 'FOURTH COFFEE' }]);
    const [item] = firstPage(receipt.observationSetId).items;
    decide(receipt.observationSetId, [{ itemId: item.itemId, action: 'insert-new' }]);
    const first = ownerPlan(receipt.observationSetId);
    decide(receipt.observationSetId, [{ itemId: item.itemId, action: 'same-transaction', transactionId: target }]);
    refused('plan-cancelled', () => commit(first));
    const second = ownerPlan(receipt.observationSetId);
    w.tick(601);
    refused('plan-expired', () => commit(second));
    const third = ownerPlan(receipt.observationSetId);
    commit(third);
    expect(count('SELECT count(*) FROM card_transactions')).toBe(1);
  });

  it('pages a set\'s items under one snapshot and refuses a page whose pins moved (§5.5, Revision 7)', () => {
    const { receipt } = w.accept(device, binding, Array.from({ length: 5 }, (_, i) => ({
      scope: known[0], date: `2026-10-0${i + 1}`, amount: 100 + i, description: `CAPTURE ROW ${i}`,
    })));
    const first = w.repo.getCardSyncObservationSetPage({ setId: receipt.observationSetId, after: null, limit: 2 })!;
    expect(first).toMatchObject({ version: 1, ledgerRevision: 0, pastDeadline: false, itemCount: 5 });
    expect(first.items.map((item) => item.itemKey)).toEqual([0, 1]);
    const second = w.repo.getCardSyncObservationSetPage({ setId: receipt.observationSetId, after: first.next, limit: 2 })!;
    expect(second.items.map((item) => item.itemKey)).toEqual([2, 3]);
    decide(receipt.observationSetId, [{ itemId: first.items[0].itemId, action: 'insert-new' }]);
    refused('page-stale', () => w.repo.getCardSyncObservationSetPage({ setId: receipt.observationSetId, after: second.next, limit: 2 }));
    w.tick(30 * 86_400);
    const late = w.repo.getCardSyncObservationSetPage({ setId: receipt.observationSetId, after: null, limit: 100 })!;
    expect(late).toMatchObject({ pastDeadline: true, set: { state: 'expired-unreviewed' } });
    expect(late.items.every((item) => item.status === 'expired' && item.allowedActions.length === 0)).toBe(true);
    refused('observation-expired', () => decide(receipt.observationSetId, [{ itemId: first.items[1].itemId, action: 'insert-new' }]));
  });

  it('discards an open set: content and receipt gone, tombstone kept, coverage rejected, idempotent (R3)', () => {
    const { receipt } = w.accept(device, binding, [{ scope: known[0], date: '2026-10-02', amount: 1250, description: 'CAPTURE' }, market()]);
    const summary = w.repo.discardCardSyncObservationSet({ setId: receipt.observationSetId, expectedVersion: 1, reason: 'not-mine',
      actorRef: SCENARIO_OWNER });
    expect(summary).toMatchObject({ state: 'rejected', discardReason: 'not-mine', receiptState: 'deleted',
      counts: expect.objectContaining({ open: 0, rejected: 2 }) });
    expect(count('SELECT count(*) FROM card_source_observations')).toBe(0);
    expect(count('SELECT count(*) FROM card_reconciliation_suggestions')).toBe(0);
    expect(count('SELECT count(*) FROM card_sync_payload_receipts')).toBe(0);
    expect(count("SELECT count(*) FROM card_coverage_windows WHERE ledger_state = 'rejected'")).toBe(1);
    expect(w.repo.discardCardSyncObservationSet({ setId: receipt.observationSetId, expectedVersion: 1, reason: 'not-mine',
      actorRef: SCENARIO_OWNER })).toEqual(summary);
    expect(w.repo.listCardSyncObservationSets({ view: 'closed', limit: 10 }).sets.map((s) => s.observationSetId))
      .toEqual([receipt.observationSetId]);
  });
});

describe('two connections on one database file (§6 C7, C10)', () => {
  it('executes a plan once whichever connection commits it, and the second answers the stored result', async () => {
    const dir = await makeScratchDir('card-sync-plans-');
    const file = `${dir}/two.db`;
    const a = new CardSyncScenario(file);
    let b: SqliteStateRepo | undefined;
    try {
      a.enable('chase');
      const bound = a.binding();
      const browser = a.device([bound.bindingId]);
      const scopes = a.scopes(bound);
      const { receipt } = a.accept(browser, bound, [{ scope: scopes.known[0], date: '2026-10-01', amount: 1250, description: 'COFFEE',
        id: 'sor-two' }]);
      const plan = a.repo.prepareCardSyncPlan({ principal: owner, setId: receipt.observationSetId, expectedVersion: 1,
        expectedGeneration: a.generation() }) as CardSyncPlanView;
      b = new SqliteStateRepo({ file, now: () => new Date(a.clock) });
      const input = { principal: owner, previewId: plan.previewId, payloadDigest: plan.payloadDigest, planDigest: plan.planDigest,
        expectedGeneration: a.generation() };
      const first = b.commitCardSyncPlan(input);
      const second = a.repo.commitCardSyncPlan(input);
      expect(first.replayed).toBe(false);
      expect(second).toEqual({ ...first, replayed: true });
      expect(a.db.prepare('SELECT count(*) FROM card_transactions').pluck().get()).toBe(1);
      // A newer plan for the same set cancels the older one: at most one executable plan per set.
      const { receipt: next } = a.accept(browser, bound, [{ scope: scopes.known[0], date: '2026-10-02', amount: 5, description: 'TEA',
        id: 'sor-three' }]);
      const older = a.repo.prepareCardSyncPlan({ principal: owner, setId: next.observationSetId, expectedVersion: 1,
        expectedGeneration: a.generation() }) as CardSyncPlanView;
      const newer = b.prepareCardSyncPlan({ principal: owner, setId: next.observationSetId, expectedVersion: 1,
        expectedGeneration: a.generation() }) as CardSyncPlanView;
      expect(a.db.prepare('SELECT status, cancel_reason FROM card_sync_commit_plans WHERE id = ?').get(older.previewId))
        .toEqual({ status: 'cancelled', cancel_reason: 'superseded' });
      refused('plan-cancelled', () => a.repo.commitCardSyncPlan({ ...input, previewId: older.previewId, planDigest: older.planDigest,
        payloadDigest: older.payloadDigest }));
      expect(a.repo.commitCardSyncPlan({ ...input, previewId: newer.previewId, planDigest: newer.planDigest,
        payloadDigest: newer.payloadDigest }).replayed).toBe(false);
    } finally {
      b?.close();
      a.close();
      await removeScratchDir(dir);
    }
  });
});
