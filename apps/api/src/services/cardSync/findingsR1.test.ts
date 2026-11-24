import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCardImportPayload, cardExternalIdHash, serializeCardImportPayload } from '@finance-tracker/shared';

import { exceptCardSpendingPaths, mountCardSpendingRoutes } from '../../routes/cardSpending.js';
import { listenLoopback } from '../../testing/loopback.js';

import { CardSyncScenario, SCENARIO_OWNER, type ScenarioDevice, type ScenarioRow } from '../../testing/cardSyncScenario.js';
import type { CardSourceBindingView, CardSyncPlanView } from '../sqliteStateRepo.js';
import { cardSyncRefusalCode } from './refusals.js';

// Slice 2 review, round 1 (GPT-6 Astra 22de0050 at 745fd2c): one block per finding, each with the reviewer's repro.

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
const asDevice = (d: ScenarioDevice) => ({ kind: 'device' as const, deviceId: d.deviceId });
const count = (sql: string, ...params: unknown[]) => w.db.prepare(sql).pluck().get(...params) as number;
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
const capture = (): ScenarioRow => ({ scope: known[0], date: '2026-10-02', amount: 1250, description: 'FOURTH COFFEE #2',
  merchant: 'Fourth Coffee' });

const devicePrepare = (setId: string) => w.repo.prepareCardSyncPlan({ principal: asDevice(device), setId,
  expectedGeneration: w.generation() });
function ownerPlan(setId: string): CardSyncPlanView {
  const plan = w.repo.prepareCardSyncPlan({ principal: owner, setId, expectedVersion: setRow(setId).version as number,
    expectedGeneration: w.generation() });
  expect(plan.status).toBe('executable');
  return plan as CardSyncPlanView;
}
const commit = (plan: CardSyncPlanView) => w.repo.commitCardSyncPlan({ principal: owner, previewId: plan.previewId,
  payloadDigest: plan.payloadDigest, planDigest: plan.planDigest, expectedGeneration: w.generation() });
function decide(setId: string, decisions: Array<{ itemId: string; action: string; transactionId?: string | null; cardScopeId?: string | null }>) {
  return w.repo.recordCardReviewDecisions({
    setId, expectedVersion: setRow(setId).version as number, actorRef: SCENARIO_OWNER,
    decisions: decisions.map((d) => ({ itemId: d.itemId, action: d.action as never, transactionId: d.transactionId ?? null,
      cardScopeId: d.cardScopeId ?? null })),
  });
}
const firstPage = (setId: string) => w.repo.getCardSyncObservationSetPage({ setId, after: null, limit: 100 })!;

describe('finding 1: a device prepare hands a set that needs a person to the owner, before any plan body', () => {
  it('answers owner-review for a capture-identified row and for a row of the unknown scope, storing nothing', () => {
    for (const row of [capture(), { ...coffee(), scope: unknown, id: 'sor-unknown' }]) {
      const { receipt } = w.accept(device, binding, [row]);
      expect(receipt.reviewCount).toBe(1);
      const plans = count('SELECT count(*) FROM card_sync_commit_plans');
      expect(devicePrepare(receipt.observationSetId)).toEqual({ status: 'owner-review', observationSetId: receipt.observationSetId,
        reviewCount: 1, counts: expect.objectContaining({ insert: 0 }) });
      expect(count('SELECT count(*) FROM card_sync_commit_plans')).toBe(plans);
    }
  });

  it('keeps the inline refresh that found review work, and hands that set to the owner', () => {
    const { receipt } = w.accept(device, binding, [coffee()]);
    expect(receipt.reviewCount).toBe(0);
    // Another capture of the same purchase, committed first with another amount: the first set's row is a correction now.
    w.ingest(device, binding, [{ ...coffee(), amount: 1300 }]);
    expect(devicePrepare(receipt.observationSetId)).toMatchObject({ status: 'owner-review', reviewCount: 1 });
    expect(setRow(receipt.observationSetId)).toMatchObject({ version: 2, state: 'needs-review' });
    expect(firstPage(receipt.observationSetId).items).toEqual([expect.objectContaining({ reason: 'posted-correction', status: 'open' })]);
  });
});

describe('finding 2: a known observation joins an unresolved row only with its attribution (§4.4 row 5, S10)', () => {
  const toy = (scope: string, id: string, description: string): ScenarioRow => ({ scope, date: '2026-10-05', amount: 2000, description, id });
  /** A committed row on the unknown scope (the owner inserted an unknown-scope observation); its id. */
  function unresolvedRow(): string {
    const { receipt } = w.accept(device, binding, [toy(unknown, 'u-1', 'TAILSPIN TOYS')]);
    decide(receipt.observationSetId, [{ itemId: firstPage(receipt.observationSetId).items[0].itemId, action: 'insert-new' }]);
    commit(ownerPlan(receipt.observationSetId));
    return w.db.prepare('SELECT id FROM card_transactions').pluck().get() as string;
  }
  const twoKnownCardsOnOneRow = () => count(`SELECT count(*) FROM (SELECT i.canonical_transaction_id FROM card_source_identities i
    JOIN card_scopes s ON s.id = i.source_scope_id WHERE s.kind = 'known' AND i.status = 'active'
    GROUP BY i.canonical_transaction_id HAVING count(DISTINCT i.source_scope_id) > 1)`);

  it('offers and takes attribute-and-link, never a plain link, and then blocks the other card', () => {
    const rowId = unresolvedRow();
    const a = w.accept(device, binding, [toy(known[0], 'a-1', 'TAILSPIN TOYS #2')]).receipt.observationSetId;
    const [itemA] = firstPage(a).items;
    expect(itemA).toMatchObject({ reason: 'cross-source-similar', allowedActions: ['attribute-and-link', 'insert-new', 'reject-row'],
      candidates: [expect.objectContaining({ transactionId: rowId, blockedReason: null })] });
    refused('action-not-allowed', () => decide(a, [{ itemId: itemA.itemId, action: 'same-transaction', transactionId: rowId }]));
    decide(a, [{ itemId: itemA.itemId, action: 'attribute-and-link', transactionId: rowId }]);
    commit(ownerPlan(a));
    expect(w.db.prepare('SELECT card_scope_id FROM card_transactions WHERE id = ?').pluck().get(rowId)).toBe(known[0]);

    const b = w.accept(device, binding, [toy(known[1], 'b-1', 'TAILSPIN TOYS #3')]).receipt.observationSetId;
    const [itemB] = firstPage(b).items;
    expect(itemB.candidates).toEqual([expect.objectContaining({ transactionId: rowId, blockedReason: 'different-known-cards' })]);
    expect(itemB.allowedActions).not.toContain('same-transaction');
    refused('action-not-allowed', () => decide(b, [{ itemId: itemB.itemId, action: 'same-transaction', transactionId: rowId }]));
    expect(twoKnownCardsOnOneRow()).toBe(0);
  });

  it('refuses a plain link onto an unresolved row at plan time too, whatever draft was stored', () => {
    const rowId = unresolvedRow();
    // A row of the same card from a capture: plainly linkable, so the item offers same-transaction (onto it, not onto R).
    const k = w.accept(device, binding, [{ ...toy(known[0], 'unused', 'TAILSPIN TOYS K'), id: undefined }]).receipt.observationSetId;
    decide(k, [{ itemId: firstPage(k).items[0].itemId, action: 'insert-new' }]);
    commit(ownerPlan(k));
    const a = w.accept(device, binding, [toy(known[0], 'a-1', 'TAILSPIN TOYS #2')]).receipt.observationSetId;
    const [itemA] = firstPage(a).items;
    expect(itemA.allowedActions).toEqual(['same-transaction', 'attribute-and-link', 'insert-new', 'reject-row']);
    refused('action-not-allowed', () => decide(a, [{ itemId: itemA.itemId, action: 'same-transaction', transactionId: rowId }]));
    // The draft an older build could have stored: the plan still refuses it.
    w.db.prepare(`UPDATE card_reconciliation_suggestions SET status = 'decided', draft_action = 'same-transaction',
      draft_transaction_id = ?, drafted_by_ref = ?, drafted_at = ? WHERE id = ?`).run(rowId, SCENARIO_OWNER, w.now(), itemA.itemId);
    refused('action-not-allowed', () => w.repo.prepareCardSyncPlan({ principal: owner, setId: a,
      expectedVersion: setRow(a).version as number, expectedGeneration: w.generation() }));
    expect(twoKnownCardsOnOneRow()).toBe(0);
  });

  it('still links unresolved to unresolved, and a capture of a known card offers no link onto an unresolved row', () => {
    const rowId = unresolvedRow();
    // A capture on the unknown scope (two stable ids of one scope and namespace are distinct rows, so it is a capture).
    const u = w.accept(device, binding, [{ ...toy(unknown, 'unused', 'TAILSPIN TOYS #2'), id: undefined }]).receipt.observationSetId;
    const [itemU] = firstPage(u).items;
    expect(itemU.allowedActions).toContain('same-transaction');
    decide(u, [{ itemId: itemU.itemId, action: 'same-transaction', transactionId: rowId }]);
    commit(ownerPlan(u));
    const c = w.accept(device, binding, [{ ...toy(known[0], 'unused', 'TAILSPIN TOYS #4'), id: undefined }]).receipt.observationSetId;
    const [itemC] = firstPage(c).items;
    expect(itemC).toMatchObject({ reason: 'no-stable-id', allowedActions: ['insert-new', 'reject-row'] });
    refused('action-not-allowed', () => decide(c, [{ itemId: itemC.itemId, action: 'same-transaction', transactionId: rowId }]));
  });
});

describe('finding 3: an adjustment never leaves a row that is not merged without an active identity (W13)', () => {
  /** The coffee row, a capture linked to it by a committed same-transaction, and the row's original identity. */
  function linkedCapture() {
    w.ingest(device, binding, [coffee()]);
    const rowId = w.db.prepare('SELECT id FROM card_transactions').pluck().get() as string;
    const original = w.db.prepare('SELECT id FROM card_source_identities WHERE canonical_transaction_id = ?').pluck().get(rowId) as string;
    const setId = w.accept(device, binding, [capture()]).receipt.observationSetId;
    const [item] = firstPage(setId).items;
    decide(setId, [{ itemId: item.itemId, action: 'same-transaction', transactionId: rowId }]);
    commit(ownerPlan(setId));
    return { rowId, original, setId, itemId: item.itemId as string };
  }
  const activeOn = (rowId: string) => count("SELECT count(*) FROM card_source_identities WHERE canonical_transaction_id = ? AND status = 'active'", rowId);
  const detach = (identityId: string, transactionId: string) => w.repo.detachCardSourceIdentity({ identityId, transactionId,
    expectedRevision: 1, actorRef: SCENARIO_OWNER });

  it('refuses the reviewer\'s sequence when the decision is changed: the link is the row\'s last active identity', () => {
    const { rowId, original, setId, itemId } = linkedCapture();
    expect(activeOn(rowId)).toBe(2);
    detach(original, rowId);
    expect(activeOn(rowId)).toBe(1);
    const before = setRow(setId).version;
    refused('adjustment-not-reversible', () => decide(setId, [{ itemId, action: 'reject-row' }]));
    refused('adjustment-not-reversible', () => decide(setId, [{ itemId, action: 'insert-new' }]));
    expect(setRow(setId).version).toBe(before);
    expect(activeOn(rowId)).toBe(1);
  });

  it('refuses at prepare when the identity was detached after the decision was recorded', () => {
    const { rowId, original, setId, itemId } = linkedCapture();
    decide(setId, [{ itemId, action: 'reject-row' }]);
    detach(original, rowId);
    refused('adjustment-not-reversible', () => w.repo.prepareCardSyncPlan({ principal: owner, setId,
      expectedVersion: setRow(setId).version as number, expectedGeneration: w.generation() }));
    expect(activeOn(rowId)).toBe(1);
  });

  it('still undoes a link that leaves the row its own identity', () => {
    const { rowId, setId, itemId } = linkedCapture();
    decide(setId, [{ itemId, action: 'reject-row' }]);
    const plan = ownerPlan(setId);
    expect(plan.effects.map((effect) => effect.op)).toEqual(['unmatch', 'reject']);
    commit(plan);
    expect(activeOn(rowId)).toBe(1);
  });
});

describe('finding 4: content the ledger learns moves the classification epoch, so other sets refresh', () => {
  const ledgerRevision = () => count('SELECT ledger_revision FROM card_accounts WHERE id = ?', binding.cardAccountRef);
  const roasters = (): ScenarioRow => ({ ...coffee(), description: 'FOURTH COFFEE ROASTERS' });

  it('a kept-current commit makes another set\'s obsolete correction stale, and its refresh resolves it', () => {
    w.ingest(device, binding, [coffee()]);
    const first = w.accept(device, binding, [roasters()]).receipt.observationSetId;
    const second = w.accept(device, binding, [roasters()]).receipt.observationSetId;
    decide(second, [{ itemId: firstPage(second).items[0].itemId, action: 'accept-correction' }]);
    decide(first, [{ itemId: firstPage(first).items[0].itemId, action: 'keep-current' }]);
    const revision = ledgerRevision();
    commit(ownerPlan(first));
    expect(ledgerRevision()).toBe(revision + 1);
    refused('review-stale', () => w.repo.prepareCardSyncPlan({ principal: owner, setId: second,
      expectedVersion: setRow(second).version as number, expectedGeneration: w.generation() }));
    expect(w.repo.refreshCardReviewItems({ setId: second })).toMatchObject({ changed: true });
    expect(firstPage(second).items).toEqual([]);
    const plan = ownerPlan(second);
    expect(plan.counts).toMatchObject({ unchanged: 1, corrected: 0 });
    commit(plan);
    expect(w.db.prepare('SELECT description FROM card_transactions').pluck().all()).toEqual(['FOURTH COFFEE']);
  });

  it('does not move it for a replay of content the ledger already knows', () => {
    w.ingest(device, binding, [coffee()]);
    const revision = ledgerRevision();
    const replay = w.accept(device, binding, [coffee()]).receipt.observationSetId;
    commit(ownerPlan(replay));
    expect(ledgerRevision()).toBe(revision);
  });
});

describe('finding 6: the review quotas charge unresolved content and kept receipts, never committed history (I24)', () => {
  const settingsVersion = () => w.repo.getCardSyncSettings().settingsVersion;
  const quotas = (values: Record<string, number>) => w.repo.updateCardSyncRetention({ expectedVersion: settingsVersion(),
    quotas: values, actorRef: SCENARIO_OWNER });

  it('accepts a new set after a committed one under a one-row account quota, and refuses a second open one', () => {
    quotas({ accountRows: 1 });
    w.ingest(device, binding, [coffee()]);
    const open = w.accept(device, binding, [{ ...coffee(), id: 'sor-2', description: 'CONTOSO MARKET', amount: 4999 }]).receipt;
    expect(open.observationSetId).toMatch(/^obs_/);
    refused('review-quota-exceeded', () => w.accept(device, binding, [{ ...coffee(), id: 'sor-3', amount: 777 }]));
    // Discarding the open set releases its share.
    w.repo.discardCardSyncObservationSet({ setId: open.observationSetId, expectedVersion: 1, reason: 'not-mine', actorRef: SCENARIO_OWNER });
    expect(w.accept(device, binding, [{ ...coffee(), id: 'sor-3', amount: 777 }]).receipt.observationSetId).toMatch(/^obs_/);
  });

  it('keeps charging a committed set\'s kept receipt to the byte budget until it is given up', () => {
    const first = w.ingest(device, binding, [coffee()]);
    const receiptBytes = count('SELECT byte_length FROM card_sync_payload_receipts WHERE observation_set_id = ?', first);
    // Room for one new set (its content and its receipt), not for that and the committed set's receipt too.
    quotas({ accountBytes: receiptBytes * 3 - 1 });
    refused('review-quota-exceeded', () => w.accept(device, binding, [{ ...coffee(), id: 'sor-2' }]));
    w.repo.deleteCardSyncReceipt({ setId: first, actorRef: SCENARIO_OWNER });
    expect(w.accept(device, binding, [{ ...coffee(), id: 'sor-2' }]).receipt.observationSetId).toMatch(/^obs_/);
  });
});

describe('finding 5: a v1 row near a row with sync provenance is held for review (E2d), never added beside it nor refused', () => {
  /** The reviewer's CSV row: the synced purchase again with another reference, a slightly different text, a day later. */
  const csvRow = (amountMinor = 1250) => ({ externalIdHash: cardExternalIdHash('csv-ref-1'), transactionDate: '2026-10-02',
    postedDate: '2026-10-02', status: 'posted' as const, amountMinor, currency: 'USD', kind: 'purchase' as const,
    description: 'FOURTH COFFEE STORE', merchant: null, issuerCategory: null });
  const importRows = (rows: ReturnType<typeof csvRow>[]) => w.repo.importCardTransactions({ cardAccountId: binding.cardAccountRef,
    source: 'chase-csv', parserVersion: 'holdr-card-import@1.0.0', rows, actorRef: SCENARIO_OWNER });

  it('holds the reviewer\'s CSV row in the batch\'s file set, with the synced row as its candidate; nothing is counted twice', () => {
    w.ingest(device, binding, [coffee()]);
    const synced = w.db.prepare('SELECT id FROM card_transactions').pluck().get() as string;
    const batch = importRows([csvRow()]);
    expect(batch).toMatchObject({ newCount: 0, duplicateCount: 0, rejectedCount: 1 });
    expect(count('SELECT count(*) FROM card_transactions')).toBe(1);
    expect(count("SELECT coalesce(sum(amount_minor), 0) FROM card_transactions WHERE status = 'posted'")).toBe(1250);
    const set = w.db.prepare("SELECT * FROM card_sync_observation_sets WHERE origin = 'file'").get() as Record<string, unknown>;
    expect(set).toMatchObject({ import_batch_id: batch.id, file_chunk: 0, state: 'needs-review', row_count: 1, open_count: 1 });
    const [item] = firstPage(set.id as string).items;
    expect(item).toMatchObject({ reason: 'cross-source-similar', allowedActions: ['same-transaction', 'insert-new', 'reject-row'],
      candidates: [expect.objectContaining({ transactionId: synced, rule: 'near-content:v1' })] });
  });

  /** The import held its one row for review against `rowId`: nothing added, nothing refused, an item naming that row. */
  function heldAgainst(rowId: string, write: () => { id: string }): void {
    const before = count('SELECT count(*) FROM card_transactions');
    const batch = write();
    expect(batch).toMatchObject({ newCount: 0, duplicateCount: 0, rejectedCount: 1 });
    expect(count('SELECT count(*) FROM card_transactions')).toBe(before);
    const set = w.db.prepare("SELECT id FROM card_sync_observation_sets WHERE origin = 'file' AND import_batch_id = ?").pluck()
      .get(batch.id) as string;
    expect(firstPage(set).items).toEqual([expect.objectContaining({ reason: 'cross-source-similar',
      candidates: [expect.objectContaining({ transactionId: rowId, rule: 'near-content:v1' })] })]);
  }
  /** The purchase as an earlier file had it, before anything synced: the synced row's date, amount and text. */
  const fileCoffee = () => ({ ...csvRow(), externalIdHash: cardExternalIdHash('csv-ref-0'), transactionDate: '2026-10-01',
    postedDate: '2026-10-01', description: 'FOURTH COFFEE' });
  const revision = (id: string) => count('SELECT revision FROM card_transactions WHERE id = ?', id);

  it('holds near a file row a browser observation was attributed and linked to, though a file created it (r2 finding 2)', () => {
    // The reviewer's repro: a CSV row, a browser's observation of it attribute-and-linked to it, then the purchase
    // again in another CSV (a new reference and text, a day later).
    importRows([fileCoffee()]);
    const fileRow = w.db.prepare('SELECT id FROM card_transactions').pluck().get() as string;
    const setId = w.accept(device, binding, [coffee()]).receipt.observationSetId;
    const [item] = firstPage(setId).items;
    expect(item.allowedActions).toContain('attribute-and-link');
    decide(setId, [{ itemId: item.itemId, action: 'attribute-and-link', transactionId: fileRow }]);
    commit(ownerPlan(setId));
    expect(w.db.prepare('SELECT first_sync_run_id FROM card_transactions WHERE id = ?').pluck().get(fileRow)).toBeNull();
    expect(count('SELECT count(*) FROM card_transactions')).toBe(1);
    heldAgainst(fileRow, () => importRows([csvRow()]));
    // The set's refresh and plan classify it the same way: the owner links it to that row, and nothing is added.
    const held = w.db.prepare("SELECT id FROM card_sync_observation_sets WHERE origin = 'file'").pluck().get() as string;
    w.repo.refreshCardReviewItems({ setId: held });
    const [heldItem] = firstPage(held).items;
    expect(heldItem.candidates).toEqual([expect.objectContaining({ transactionId: fileRow })]);
    decide(held, [{ itemId: heldItem.itemId, action: 'same-transaction', transactionId: fileRow }]);
    commit(ownerPlan(held));
    expect(count('SELECT count(*) FROM card_transactions')).toBe(1);
    expect(importRows([csvRow()])).toMatchObject({ newCount: 0, duplicateCount: 1, rejectedCount: 0 });
  });

  it('holds near the survivor of a merge with a synced row, though a file created the survivor (r2 finding 2)', () => {
    importRows([fileCoffee()]);
    const fileRow = w.db.prepare('SELECT id FROM card_transactions').pluck().get() as string;
    const setId = w.accept(device, binding, [coffee()]).receipt.observationSetId;
    decide(setId, [{ itemId: firstPage(setId).items[0].itemId, action: 'insert-new' }]);
    commit(ownerPlan(setId));
    const synced = w.db.prepare('SELECT id FROM card_transactions WHERE first_sync_run_id IS NOT NULL').pluck().get() as string;
    // The owner merges the synced row into the file's: it is removed, and its browser identity moves to the survivor.
    w.repo.mergeCardTransactions({ survivorId: fileRow, loserId: synced, reason: 'superseded',
      expectedRevisions: [revision(fileRow), revision(synced)], categoryFrom: 'survivor', notesFrom: 'survivor', actorRef: SCENARIO_OWNER });
    expect(w.db.prepare('SELECT status FROM card_transactions WHERE id = ?').pluck().get(synced)).toBe('removed');
    heldAgainst(fileRow, () => importRows([csvRow()]));
  });

  it('imports as before when nothing synced is near, or the account syncs nothing', () => {
    w.ingest(device, binding, [coffee()]);
    expect(importRows([csvRow(990)])).toMatchObject({ newCount: 1 });
    // Not general duplicate protection: more than 10 days apart, the same amount imports as in Phase 4.
    expect(importRows([{ ...csvRow(), externalIdHash: cardExternalIdHash('csv-ref-far'), transactionDate: '2026-10-12',
      postedDate: '2026-10-12' }])).toMatchObject({ newCount: 1 });
    const other = w.account();
    expect(w.repo.importCardTransactions({ cardAccountId: other, source: 'chase-csv', parserVersion: 'holdr-card-import@1.0.0',
      rows: [csvRow()], actorRef: SCENARIO_OWNER })).toMatchObject({ newCount: 1 });
    expect(count("SELECT count(*) FROM card_sync_observation_sets WHERE origin = 'file'")).toBe(0);
  });

  it('commits the reviewer\'s file over HTTP with its row held, not refused', async () => {
    w.ingest(device, binding, [coffee()]);
    const server = express();
    server.use(exceptCardSpendingPaths(express.json({ limit: '2mb' })));
    mountCardSpendingRoutes(server, { repo: w.repo, requireAuth: (_req, _res, next) => next(), log: () => undefined });
    const { payload } = buildCardImportPayload({
      source: 'chase-csv', parserVersion: 'holdr-card-import@1.0.0', issuer: 'chase', currency: 'USD',
      rows: [{ transactionDate: '2026-10-02', postedDate: '2026-10-02', amountMinor: 1250, kind: 'purchase', description: 'FOURTH COFFEE STORE',
        externalId: 'csv-ref-1' }],
    });
    const res = await request(await listenLoopback(server)).post(`/card-imports/commit?cardAccountId=${binding.cardAccountRef}`)
      .set('Content-Type', 'application/json').send(serializeCardImportPayload(payload));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ imported: true, newCount: 0 });
    expect(count('SELECT count(*) FROM card_transactions')).toBe(1);
    expect(count("SELECT count(*) FROM card_sync_observation_sets WHERE origin = 'file'")).toBe(1);
  });
});

describe('finding 9: a replayed commit answers exactly what the commit answered', () => {
  it('keeps the commit time and the set version the commit left after the ledger and the set move on', () => {
    w.ingest(device, binding, [coffee()]);
    const target = w.db.prepare('SELECT id FROM card_transactions').pluck().get() as string;
    const setId = w.accept(device, binding, [capture()]).receipt.observationSetId;
    const [item] = firstPage(setId).items;
    decide(setId, [{ itemId: item.itemId, action: 'same-transaction', transactionId: target }]);
    const plan = ownerPlan(setId);
    const committedAt = w.now();
    const result = commit(plan);
    expect(result).toEqual({ status: 'committed', previewId: plan.previewId, planKind: 'set', observationSetId: setId,
      planDigest: plan.planDigest, payloadDigest: plan.payloadDigest, counts: plan.counts, setVersion: 3, committedAt, replayed: false });
    // A minute later another set moves the ledger, and an adjustment draft moves this set.
    w.tick(60);
    w.ingest(device, binding, [{ scope: known[1], date: '2026-10-05', amount: 4200, description: 'NORTHWIND TRADERS', id: 'sor-2' }]);
    decide(setId, [{ itemId: item.itemId, action: 'reject-row' }]);
    expect(setRow(setId).version).toBe(4);
    expect(commit(plan)).toEqual({ ...result, replayed: true });
  });
});

describe('finding 10: auto-sync eligibility rests on the committed set, not on its 7-day plan', () => {
  it('stays eligible after retention deletes the consumed plan, and only a manual run at the current version counts', () => {
    const eligible = () => w.repo.getCardSourceBinding(binding.bindingId)!.autoSync.eligible;
    // An auto run's commit is not the manual commitment §5.2 asks for; a discarded manual run is not a commitment at all.
    const auto = w.accept(device, binding, [coffee()], { trigger: 'auto' }).receipt.observationSetId;
    commit(ownerPlan(auto));
    const discarded = w.accept(device, binding, [{ ...coffee(), id: 'sor-3', amount: 990 }]).receipt.observationSetId;
    w.repo.discardCardSyncObservationSet({ setId: discarded, expectedVersion: 1, reason: 'not-mine', actorRef: SCENARIO_OWNER });
    expect(eligible()).toBe(false);
    const setId = w.ingest(device, binding, [{ scope: known[1], date: '2026-10-05', amount: 4200, description: 'NORTHWIND TRADERS',
      id: 'sor-2' }]);
    expect(eligible()).toBe(true);
    w.tick(8 * 86_400);
    for (let call = 0; call < 50 && !w.repo.runCardSyncRetention().done; call += 1);
    expect(count("SELECT count(*) FROM card_sync_commit_plans WHERE status = 'consumed'")).toBe(0);
    expect(setRow(setId)).toMatchObject({ state: 'committed', binding_version: binding.bindingVersion });
    expect(eligible()).toBe(true);
  });
});

describe('finding 11: re-selecting the committed decision resets an adjustment draft', () => {
  const nothingToAdjust = (setId: string) => refused('nothing-to-adjust', () => w.repo.prepareCardSyncPlan({ principal: owner, setId,
    expectedVersion: setRow(setId).version as number, expectedGeneration: w.generation() }));

  it('takes accept-correction back after a keep-current draft (the reviewer\'s repro)', () => {
    w.ingest(device, binding, [coffee()]);
    const setId = w.accept(device, binding, [{ ...coffee(), description: 'FOURTH COFFEE ROASTERS' }]).receipt.observationSetId;
    const [item] = firstPage(setId).items;
    expect(item.reason).toBe('posted-correction');
    decide(setId, [{ itemId: item.itemId, action: 'accept-correction' }]);
    commit(ownerPlan(setId));
    expect(decide(setId, [{ itemId: item.itemId, action: 'keep-current' }]).items[0]).toMatchObject({ status: 'decided',
      committed: { action: 'accept-correction' }, draft: { action: 'keep-current' } });
    expect(decide(setId, [{ itemId: item.itemId, action: 'accept-correction' }]).items[0]).toMatchObject({ status: 'committed',
      committed: { action: 'accept-correction' }, draft: null });
    nothingToAdjust(setId);
  });

  it('takes an attribute-and-link back with its scope implicit or named, and nothing else', () => {
    const { receipt } = w.accept(device, binding, [{ scope: unknown, date: '2026-10-05', amount: 2000, description: 'TAILSPIN TOYS',
      id: 'u-1' }]);
    decide(receipt.observationSetId, [{ itemId: firstPage(receipt.observationSetId).items[0].itemId, action: 'insert-new' }]);
    commit(ownerPlan(receipt.observationSetId));
    const rowId = w.db.prepare('SELECT id FROM card_transactions').pluck().get() as string;
    const setId = w.accept(device, binding, [{ scope: known[0], date: '2026-10-05', amount: 2000, description: 'TAILSPIN TOYS #2',
      id: 'a-1' }]).receipt.observationSetId;
    const [item] = firstPage(setId).items;
    decide(setId, [{ itemId: item.itemId, action: 'attribute-and-link', transactionId: rowId }]);
    commit(ownerPlan(setId));
    expect(firstPage(setId).items[0].committed).toMatchObject({ action: 'attribute-and-link', transactionId: rowId, cardScopeId: known[0] });
    for (const cardScopeId of [null, known[0]]) {
      expect(decide(setId, [{ itemId: item.itemId, action: 'reject-row' }]).items[0]).toMatchObject({ status: 'decided',
        draft: { action: 'reject-row' } });
      expect(decide(setId, [{ itemId: item.itemId, action: 'attribute-and-link', transactionId: rowId, cardScopeId }]).items[0])
        .toMatchObject({ status: 'committed', draft: null });
      nothingToAdjust(setId);
    }
    // Another scope is another decision, and not one a known observation can make.
    refused('action-not-allowed', () => decide(setId, [{ itemId: item.itemId, action: 'attribute-and-link', transactionId: rowId,
      cardScopeId: known[1] }]));
    refused('action-not-allowed', () => decide(setId, [{ itemId: item.itemId, action: 'attribute-and-link', transactionId: rowId,
      cardScopeId: unknown }]));
  });
});

describe('ruling D36: a committed item advertises only the adjustments the supported subset makes', () => {
  it('drops insert → link and link → another link from the actions it offers, and offers nothing it refuses for its kind', () => {
    w.ingest(device, binding, [coffee()]);
    const target = w.db.prepare('SELECT id FROM card_transactions').pluck().get() as string;
    const inserted = w.accept(device, binding, [capture()]).receipt.observationSetId;
    const [item] = firstPage(inserted).items;
    expect(item.allowedActions).toEqual(['same-transaction', 'insert-new', 'reject-row']);
    decide(inserted, [{ itemId: item.itemId, action: 'insert-new' }]);
    commit(ownerPlan(inserted));
    expect(firstPage(inserted).items[0].allowedActions).toEqual(['insert-new', 'reject-row']);
    refused('action-not-allowed', () => decide(inserted, [{ itemId: item.itemId, action: 'same-transaction', transactionId: target }]));
    expect(decide(inserted, [{ itemId: item.itemId, action: 'reject-row' }]).items[0]).toMatchObject({ status: 'decided',
      allowedActions: ['insert-new', 'reject-row'], draft: { action: 'reject-row' } });

    const linked = w.accept(device, binding, [{ ...capture(), description: 'FOURTH COFFEE #3' }]).receipt.observationSetId;
    const [link] = firstPage(linked).items;
    decide(linked, [{ itemId: link.itemId, action: 'same-transaction', transactionId: target }]);
    commit(ownerPlan(linked));
    // Same-transaction stays listed for the committed link itself (selecting it drops a draft); another target is refused.
    expect(firstPage(linked).items[0].allowedActions).toEqual(['same-transaction', 'insert-new', 'reject-row']);
    const other = link.candidates.find((candidate) => candidate.transactionId !== target && candidate.blockedReason === null)!;
    expect(other).toBeDefined();
    refused('action-not-allowed', () => decide(linked, [{ itemId: link.itemId, action: 'same-transaction',
      transactionId: other.transactionId }]));
    for (const action of ['insert-new', 'reject-row']) {
      expect(decide(linked, [{ itemId: link.itemId, action }]).items[0]).toMatchObject({ status: 'decided', draft: { action } });
    }
  });
});
