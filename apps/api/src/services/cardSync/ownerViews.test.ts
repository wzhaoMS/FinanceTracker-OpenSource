import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CardSyncScenario, SCENARIO_OWNER, type ScenarioDevice, type ScenarioRow } from '../../testing/cardSyncScenario.js';
import type { CardSourceBindingView } from '../sqliteStateRepo.js';
import { cardSyncRefusalCode } from './refusals.js';

// The owner read contract (E1b design §5.5–§5.7.1; slice 2 review r1, finding 7): the owner API's shapes, built inside the
// repository transaction that reads or writes, with observation and candidate values in review items and pinned
// before/after values in plan effects.

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

const owner = SCENARIO_OWNER;
const coffee = (): ScenarioRow => ({ scope: known[0], date: '2026-10-01', amount: 1250, description: 'FOURTH COFFEE',
  merchant: 'Fourth Coffee', id: 'sor-1' });
const capture = (): ScenarioRow => ({ scope: known[0], date: '2026-10-02', amount: 1250, description: 'FOURTH COFFEE #2',
  merchant: 'Fourth Coffee' });
const rows = (n: number): ScenarioRow[] => Array.from({ length: n }, (_, i) => ({ scope: known[i % 2],
  date: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}`, amount: 100 + i, description: `SYNTHETIC SHOP ${i}`, id: `sor-bulk-${i}` }));
const values = (row: ScenarioRow, status: 'pending' | 'posted' = 'posted') => ({ status, transactionDate: row.date,
  postedDate: status === 'pending' ? null : (row.posted ?? row.date), amountMinor: row.amount, kind: 'purchase', description: row.description,
  merchant: row.merchant ?? null, cardScopeId: row.scope });
const version = (setId: string) => w.db.prepare('SELECT version FROM card_sync_observation_sets WHERE id = ?').pluck().get(setId) as number;
const page = (setId: string) => w.repo.getCardSyncOwnerSet({ setId, after: null, actorRef: owner })!;
const prepare = (setId: string) => w.repo.prepareCardSyncOwnerPlan({ setId, expectedVersion: version(setId), sourceReviewed: false,
  actorRef: owner, expectedGeneration: w.generation() });
const commit = (plan: { previewId: string; payloadDigest: string | null; planDigest: string }) => w.repo.commitCardSyncOwnerPlan({
  previewId: plan.previewId, payloadDigest: plan.payloadDigest, planDigest: plan.planDigest, actorRef: owner,
  expectedGeneration: w.generation() });
const decide = (setId: string, decisions: Array<{ itemId: string; action: string; transactionId?: string | null }>) =>
  w.repo.recordCardSyncOwnerDecisions({ setId, expectedVersion: version(setId), actorRef: owner,
    decisions: decisions.map((d) => ({ itemId: d.itemId, action: d.action as never, transactionId: d.transactionId ?? null,
      cardScopeId: null })) });

describe('review items carry their observation and their candidates\' values (§5.5)', () => {
  it('shows a set as SetDetail, refreshing it first when its review mark is behind', () => {
    w.ingest(device, binding, [coffee()]);
    const coffeeId = w.db.prepare('SELECT id FROM card_transactions').pluck().get() as string;
    const setId = w.accept(device, binding, [capture()]).receipt.observationSetId;
    const { detail, next } = page(setId);
    expect(next).toBeNull();
    expect(detail).toMatchObject({ observationSetId: setId, sourceKind: 'extension', cardAccountRef: binding.cardAccountRef,
      state: 'needs-review', reviewCount: 1, categories: [{ category: 'no-stable-id', count: 1 }], plan: null, currency: 'USD',
      rejectedCount: 0, itemCount: 1, coverage: [expect.objectContaining({ cardScopeId: known[0], status: 'posted' })] });
    expect(detail.items[0]).toEqual({
      itemId: expect.stringMatching(/^rvw_/), category: 'no-stable-id', rowIndex: 0, reason: 'no-stable-id',
      observation: { rowIndex: 0, transactionDate: '2026-10-02', postedDate: '2026-10-02', status: 'posted', amountMinor: 1250,
        kind: 'purchase', description: 'FOURTH COFFEE #2', merchant: 'Fourth Coffee', issuerCategory: null, cardScopeId: known[0],
        identity: 'capture', originalAmountMinor: null, originalCurrency: null },
      candidates: [{ transactionId: coffeeId, cardScopeId: known[0], scopeKind: 'known', sourceKind: 'extension', status: 'posted',
        transactionDate: '2026-10-01', postedDate: '2026-10-01', amountMinor: 1250, kind: 'purchase', description: 'FOURTH COFFEE',
        merchant: 'Fourth Coffee', userCategory: null, notes: null, matchedOn: ['amount', 'merchant'], blockedReason: null }],
      difference: null, allowedActions: ['same-transaction', 'insert-new', 'reject-row'], decision: null, committed: null,
    });
    // The ledger moves (another set commits): the first page refreshes before it is read, in one transaction.
    const before = version(setId);
    w.ingest(device, binding, [{ ...coffee(), id: 'sor-9', amount: 999, description: 'ELSEWHERE' }]);
    expect(page(setId).detail.version).toBe(before);
    expect(w.db.prepare('SELECT review_ledger_revision FROM card_sync_observation_sets WHERE id = ?').pluck().get(setId))
      .toBe(w.db.prepare('SELECT ledger_revision FROM card_accounts WHERE id = ?').pluck().get(binding.cardAccountRef));
  });

  it('pages items under the first page\'s pins and refuses a page whose pins moved', () => {
    w.ingest(device, binding, rows(120));
    const setId = w.accept(device, binding, rows(120).map((row) => ({ ...row, id: undefined, description: `${row.description} X` })))
      .receipt.observationSetId;
    const first = page(setId);
    expect(first.detail.items).toHaveLength(100);
    const second = w.repo.getCardSyncOwnerSet({ setId, after: first.next, actorRef: owner })!;
    expect(second.detail.items.map((item) => item.rowIndex)).toEqual(Array.from({ length: 20 }, (_, i) => 100 + i));
    decide(setId, [{ itemId: first.detail.items[0].itemId, action: 'insert-new' }]);
    let error: unknown;
    try {
      w.repo.getCardSyncOwnerSet({ setId, after: first.next, actorRef: owner });
    } catch (caught) {
      error = caught;
    }
    expect(cardSyncRefusalCode(error)).toBe('page-stale');
  });
});

describe('plan effects carry before and after values pinned to the plan (§5.6, Revision 7 finding 4)', () => {
  it('shows alias and insert effects, commits, and replays the commit result unchanged', () => {
    w.ingest(device, binding, [coffee()]);
    const coffeeId = w.db.prepare('SELECT id FROM card_transactions').pluck().get() as string;
    const market: ScenarioRow = { scope: known[0], date: '2026-10-02', amount: 4999, description: 'CONTOSO MARKET', id: 'sor-2' };
    const setId = w.accept(device, binding, [{ ...coffee(), secondary: [['chase-api:derived:v1', 'derived-1']] }, market])
      .receipt.observationSetId;
    const { plan, nextAfterOrdinal } = prepare(setId);
    expect(nextAfterOrdinal).toBeNull();
    expect(plan).toMatchObject({ planKind: 'set', effectCount: 2, counts: expect.objectContaining({ insert: 1, aliased: 1 }) });
    expect(plan.effects).toEqual([
      { itemId: null, rowIndex: 0, effect: 'alias', transactionId: coffeeId, before: values(coffee()), after: values(coffee()) },
      { itemId: null, rowIndex: 1, effect: 'insert', transactionId: null, before: null, after: values(market) },
    ]);
    expect(page(setId).detail.plan).toMatchObject({ previewId: plan.previewId, state: 'valid' });
    const result = commit(plan);
    expect(result).toEqual({ status: 'committed', previewId: plan.previewId, observationSetId: setId, committedAt: w.now(),
      counts: plan.counts });
    w.tick(30);
    w.ingest(device, binding, [{ ...coffee(), id: 'sor-7', amount: 7 }]);
    expect(commit(plan)).toEqual(result);
  });

  it('keeps every page of a plan on the values it was prepared from while the ledger moves', () => {
    w.ingest(device, binding, rows(620));
    const setId = w.accept(device, binding, rows(620).map((row, i) => ({ ...row, secondary: [['chase-api:derived:v1', `d-${i}`]] })))
      .receipt.observationSetId;
    const { plan, nextAfterOrdinal } = prepare(setId);
    expect([plan.effects.length, nextAfterOrdinal]).toEqual([500, 499]);
    const target = w.db.prepare("SELECT id, card_scope_id FROM card_transactions WHERE description = 'SYNTHETIC SHOP 550'").get() as
      { id: string; card_scope_id: string };
    w.tick(1);
    w.repo.attributeCardTransaction({ id: target.id, cardScopeId: known.find((scope) => scope !== target.card_scope_id)!,
      expectedRevision: 1, actorRef: owner });
    const rest = w.repo.getCardSyncOwnerPlanEffects({ previewId: plan.previewId, afterOrdinal: nextAfterOrdinal!, actorRef: owner })!;
    expect(rest.page).toMatchObject({ previewId: plan.previewId, planDigest: plan.planDigest, state: 'valid' });
    expect(rest.page.effects).toHaveLength(120);
    expect(rest.page.effects.find((effect) => effect.transactionId === target.id)).toMatchObject({ effect: 'alias', rowIndex: 550,
      before: { cardScopeId: target.card_scope_id }, after: { cardScopeId: target.card_scope_id } });
    // Another principal sees no plan.
    expect(w.repo.getCardSyncOwnerPlanEffects({ previewId: plan.previewId, afterOrdinal: -1, actorRef: `usr_${'b'.repeat(32)}` })).toBeNull();
  });

  it('shows an adjustment\'s revert with the values the reversed change replaced', () => {
    const parking: ScenarioRow = { scope: known[1], date: '2026-10-03', status: 'pending', amount: 800, description: 'NORTHWIND PARKING',
      id: 'sor-3' };
    w.ingest(device, binding, [parking]);
    const rowId = w.db.prepare('SELECT id FROM card_transactions').pluck().get() as string;
    const posted: ScenarioRow = { ...parking, status: 'posted', posted: '2026-10-05' };
    const setId = w.accept(device, binding, [posted]).receipt.observationSetId;
    const [item] = page(setId).detail.items;
    decide(setId, [{ itemId: item.itemId, action: 'same-transaction', transactionId: rowId }]);
    commit(prepare(setId).plan);
    w.tick(60);
    decide(setId, [{ itemId: item.itemId, action: 'reject-row' }]);
    const { plan } = prepare(setId);
    expect(plan).toMatchObject({ planKind: 'adjustment', effectCount: 2 });
    expect(plan.effects).toEqual([
      { itemId: item.itemId, rowIndex: 0, effect: 'revert', transactionId: rowId, before: values(posted), after: values(parking, 'pending') },
      { itemId: item.itemId, rowIndex: 0, effect: 'reject', transactionId: null, before: null, after: null },
    ]);
  });
});

describe('runs and a charge\'s sources as the owner API shows them (§5.4, §5.7.1)', () => {
  it('answers RunDetail with each row\'s result and the exact sent bytes', () => {
    const setId = w.ingest(device, binding, [coffee()]);
    const runId = w.db.prepare('SELECT run_id FROM card_sync_observation_sets WHERE id = ?').pluck().get(setId) as string;
    const id = w.db.prepare('SELECT id FROM card_transactions').pluck().get() as string;
    expect(w.repo.getCardSyncOwnerRun(runId)).toMatchObject({ runId, deviceLabel: 'Laptop Chrome', issuer: 'chase', source: 'chase-api',
      acceptance: 'committed', ledger: 'committed', receiptAvailable: true, contentRetained: true,
      counts: expect.objectContaining({ insert: 1 }), results: [{ rowIndex: 0, result: 'inserted', transactionId: id }] });
    const sent = w.repo.getCardSyncOwnerRunPayload(runId)!;
    expect(sent.canonicalJson).toBe(w.db.prepare('SELECT canonical_json FROM card_sync_payload_receipts').pluck().get());
    expect(w.repo.listCardSyncOwnerRuns({ bindingId: binding.bindingId, after: null }).runs.map((run) => run.runId)).toEqual([runId]);
  });

  it('shows an alias that left a row with no revision, naming the row it joined', () => {
    w.ingest(device, binding, [{ ...coffee(), secondary: [['chase-api:derived:v1', 'derived-1']] }]);
    w.ingest(device, binding, [{ scope: known[0], date: '2026-10-02', amount: 4999, description: 'CONTOSO MARKET', id: 'sor-2' }]);
    const [coffeeId, marketId] = w.db.prepare('SELECT id FROM card_transactions ORDER BY transaction_date').pluck().all() as string[];
    const sources = w.repo.getCardSyncOwnerSources({ transactionId: coffeeId, continue: null })!;
    expect(sources.sources.identities.map((i) => [i.status, i.createdBy, i.namespaceKind, i.scopeKind])).toEqual([
      ['active', 'session', 'stable', 'known'], ['active', 'session', 'stable', 'known']]);
    const alias = sources.sources.identities[1].identityId;
    w.tick(1);
    const moved = w.repo.repointCardSyncOwnerIdentity({ identityId: alias, fromTransactionId: coffeeId, toTransactionId: marketId,
      expectedRevision: 1, expectedToRevision: 1, actorRef: owner });
    expect(moved.sources.transaction.transactionId).toBe(coffeeId);
    expect(moved.sources.events[0]).toMatchObject({ eventType: 'identity-repointed', revision: null, relatedTransactionId: marketId,
      identityId: alias, actor: 'owner', via: 'session', reason: 'maintenance' });
    expect(w.repo.getCardSyncOwnerSources({ transactionId: marketId, continue: null })!.sources.events[0]).toMatchObject({
      eventType: 'identity-repointed', revision: 1, relatedTransactionId: coffeeId });
  });
});

describe('a first page answers from one snapshot (review r2, finding 3)', () => {
  it('reads a fresh first page in the transaction that found it fresh, and refreshes and reads a stale one in one write', () => {
    const setId = w.accept(device, binding, [coffee()]).receipt.observationSetId;
    // Which transactions each answer used.
    const transactions: string[] = [];
    const repo = w.repo as unknown as Record<'syncRead' | 'syncWrite', (work: unknown) => unknown>;
    for (const [method, kind] of [['syncRead', 'read'], ['syncWrite', 'write']] as const) {
      const original = repo[method].bind(w.repo);
      repo[method] = (work) => {
        transactions.push(kind);
        return original(work);
      };
    }
    expect(page(setId).detail).toMatchObject({ state: 'accepted-uncommitted', itemCount: 0, reviewCount: 0, version: 1 });
    expect(transactions).toEqual(['read']);
    // Another set commits the same issuer id with other text first: the ledger moves past this set's review mark, and
    // its refresh finds a posted correction to ask about.
    w.ingest(device, binding, [{ ...coffee(), description: 'FOURTH COFFEE ROASTERS' }]);
    transactions.length = 0;
    expect(page(setId).detail).toMatchObject({ state: 'needs-review', itemCount: 1, reviewCount: 1, version: 2 });
    expect(transactions).toEqual(['read', 'write']);
    transactions.length = 0;
    expect(page(setId).detail).toMatchObject({ state: 'needs-review', itemCount: 1, version: 2 });
    expect(transactions).toEqual(['read']);
  });
});
