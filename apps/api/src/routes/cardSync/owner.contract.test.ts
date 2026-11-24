import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCardImportPayload, cardExternalIdHash, type CardImportDraftRow } from '@finance-tracker/shared';

import { CardSyncOwnerWorld, OWNER_ORIGIN, OWNER_PASSWORD } from '../../testing/cardSyncOwnerWorld.js';
import type { ScenarioDevice, ScenarioRow } from '../../testing/cardSyncScenario.js';
import type { CardSourceBindingView } from '../../services/sqliteStateRepo.js';

/**
 * E2a's contract with the Spending tab (the E8-M owner API, #12/#21):
 * the web client itself (apps/web/.../sync/ownerClient.ts, which parses
 * every answer with its exact-key strict schemas and checks that pages hold
 * together) drives the real API. Any answer it would refuse fails here. The
 * client is loaded at run time so the API's typecheck never compiles the web
 * workspace (another module system).
 */

const WEB_SYNC = fileURLToPath(new URL('../../../../web/src/components/spending/sync/', import.meta.url));

interface TransportResult { kind: 'json'; status: number; body: unknown }
type OwnerClient = Record<string, (...args: never[]) => Promise<Record<string, unknown>>>;
interface ClientModule {
  createOwnerClient(transport: { request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> }, mode?: string): OwnerClient;
  isOwnerApiError(error: unknown, code?: string): boolean;
  isRefusedCursor(error: unknown, path: string): boolean;
}

let web: ClientModule;
let w: CardSyncOwnerWorld;
let client: OwnerClient;
let binding: CardSourceBindingView;
let device: ScenarioDevice;
let known: string[];

beforeEach(async () => {
  web = await import(/* @vite-ignore */ path.join(WEB_SYNC, 'ownerClient.ts')) as ClientModule;
  w = await CardSyncOwnerWorld.create();
  w.enable('chase');
  binding = w.binding();
  device = w.device([binding.bindingId]);
  ({ known } = w.scopes(binding));
  client = web.createOwnerClient({
    async request(method, target, body) {
      const http = await w.http();
      const res = method === 'GET'
        ? await http.get(target).set('Cookie', w.cookie)
        : await http.post(target).set('Cookie', w.cookie).set('Origin', OWNER_ORIGIN).set('X-Holdr-Request', '1').send(body as object);
      if (!String(res.headers['content-type'] ?? '').startsWith('application/json')) return { kind: 'other', status: res.status };
      return { kind: 'json', status: res.status, body: JSON.parse(res.text) } satisfies TransportResult;
    },
  }, 'live');
});

afterEach(() => {
  w.close();
});

const call = <T = Record<string, unknown>>(name: string, ...args: unknown[]) => (client[name] as (...a: unknown[]) => Promise<T>)(...args);
async function refusal(name: string, ...args: unknown[]): Promise<unknown> {
  try {
    await call(name, ...args);
  } catch (error) {
    return error;
  }
  throw new Error(`${name} was not refused`);
}

const coffee = (): ScenarioRow => ({ scope: known[0], date: '2026-10-01', amount: 1250, description: 'FOURTH COFFEE',
  merchant: 'Fourth Coffee', id: 'sor-1', secondary: [['chase-api:derived:v1', 'derived-1']] });
const bulk = (n: number, tag = ''): ScenarioRow[] => Array.from({ length: n }, (_, i) => ({
  scope: known[i % 2], date: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}`, amount: 300 + i, description: `SYNTHETIC SHOP ${i}${tag}`,
  ...(tag ? {} : { id: `sor-bulk-${i}` }),
}));

describe('the web owner client against the real API', () => {
  it('reads and decides a paged set, prepares and commits a paged plan, with every answer parsed strictly', async () => {
    w.ingest(device, binding, bulk(130));
    // The same purchases without ids: 130 review items, two pages.
    const reviewSet = w.accept(device, binding, bulk(130, ' X')).receipt.observationSetId;
    const page = await call('listObservationSets', 'open');
    expect(page).toMatchObject({ observationSets: [expect.objectContaining({ observationSetId: reviewSet, reviewCount: 130 })],
      nextCursor: null });
    const detail = await call<{ version: number; items: Array<{ itemId: string; candidates: Array<{ transactionId: string }> }> }>(
      'getObservationSet', reviewSet);
    expect(detail.items).toHaveLength(130);
    expect((await call('getSetSummary', reviewSet)).observationSetId).toBe(reviewSet);
    // Two batches of decisions, as the page sends them.
    let version = detail.version;
    for (const batch of [detail.items.slice(0, 100), detail.items.slice(100)]) {
      const saved = await call<{ version: number }>('recordDecisions', reviewSet, { expectedVersion: version, decisions: batch.map((item) => ({
        itemId: item.itemId, action: 'same-transaction', transactionId: item.candidates[0].transactionId, cardScopeId: null })) });
      version = saved.version;
    }
    const conflict = await refusal('recordDecisions', reviewSet, { expectedVersion: version - 1, decisions: [{ itemId: detail.items[0].itemId,
      action: 'insert-new', transactionId: null, cardScopeId: null }] });
    expect(web.isOwnerApiError(conflict, 'version-conflict')).toBe(true);
    expect((conflict as { extra: { currentVersion: number } }).extra.currentVersion).toBe(version);
    const plan = await call<{ previewId: string; payloadDigest: string; planDigest: string; effects: unknown[]; effectCount: number }>(
      'preparePlan', reviewSet, { expectedVersion: version, sourceReviewed: false });
    expect(plan.effects).toHaveLength(130);
    const mismatch = await refusal('commitPlan', plan.previewId, { payloadDigest: plan.payloadDigest, planDigest: `pl1:${'a'.repeat(64)}` });
    expect(web.isOwnerApiError(mismatch, 'plan-mismatch')).toBe(true);
    const committed = await call('commitPlan', plan.previewId, { payloadDigest: plan.payloadDigest, planDigest: plan.planDigest });
    expect(committed).toMatchObject({ status: 'committed', counts: expect.objectContaining({ matched: 130 }) });

    // A plan of more than one effects page: the client pages it and checks the digest on every page.
    const bigSet = w.accept(device, binding, bulk(620).map((row) => ({ ...row, id: `${row.id}-new`, description: `${row.description} NEW` })))
      .receipt.observationSetId;
    const big = await call<{ effects: unknown[]; effectCount: number }>('preparePlan', bigSet, { expectedVersion: 1, sourceReviewed: false });
    expect([big.effects.length, big.effectCount]).toEqual([620, 620]);
    const discarded = await call('discardObservationSet', bigSet, { expectedVersion: 1, reason: 'duplicate-of-file' });
    expect(discarded).toMatchObject({ state: 'rejected', closeReason: 'discarded' });
    expect((await call<{ observationSets: unknown[] }>('listObservationSets', 'closed')).observationSets).toHaveLength(3);
  });

  it('reads runs, a run\'s results and the exact sent object, which the client checks against its digest', async () => {
    const { runId } = w.accept(device, binding, [coffee()]);
    const runs = await call<{ runs: Array<{ runId: string }> }>('listRuns', { bindingId: binding.bindingId });
    expect(runs.runs.map((run) => run.runId)).toEqual([runId]);
    expect(await call('listRuns')).toEqual(runs);
    const run = await call('getRun', runId);
    expect(run).toMatchObject({ runId, receiptAvailable: true, results: [{ rowIndex: 0, result: 'waiting', transactionId: null }] });
    const sent = await call<{ payload: { rows: unknown[] } }>('getSentPayload', runId);
    expect(sent.payload.rows).toHaveLength(1);
  });

  it('shows a charge\'s sources and repairs them after confirming the password', async () => {
    w.ingest(device, binding, [coffee()]);
    w.ingest(device, binding, [{ scope: known[0], date: '2026-10-02', amount: 4999, description: 'CONTOSO MARKET', id: 'sor-2' }]);
    const [coffeeId, marketId] = w.db.prepare('SELECT id FROM card_transactions ORDER BY transaction_date').pluck().all() as string[];
    const sources = await call<{ identities: Array<{ identityId: string }>; transaction: { revision: number } }>(
      'getTransactionSources', coffeeId);
    expect(sources.identities).toHaveLength(2);
    const needsPassword = await refusal('detachIdentity', sources.identities[1].identityId, { transactionId: coffeeId, expectedRevision: 1 });
    expect(web.isOwnerApiError(needsPassword, 'recent-auth-required')).toBe(true);
    const wrong = await refusal('confirmPassword', 'not the password');
    expect(web.isOwnerApiError(wrong, 'unauthorized')).toBe(true);
    expect(await call('confirmPassword', OWNER_PASSWORD)).toEqual({ verifiedUntil: expect.any(String) });
    w.tick(1);
    const moved = await call<{ identities: unknown[]; events: Array<{ eventType: string; revision: number | null }> }>('repointIdentity',
      sources.identities[1].identityId, { fromTransactionId: coffeeId, expectedRevision: 1, toTransactionId: marketId, expectedToRevision: 1 });
    expect(moved.identities).toHaveLength(1);
    expect(moved.events[0]).toMatchObject({ eventType: 'identity-repointed', revision: null });
    const there = await call<{ identities: Array<{ identityId: string }> }>('getTransactionSources', marketId);
    w.tick(1);
    const detached = await call<{ identities: Array<{ status: string }> }>('detachIdentity', there.identities[1].identityId,
      { transactionId: marketId, expectedRevision: 1 });
    expect(detached.identities.map((identity) => identity.status).sort()).toEqual(['active', 'detached']);
    w.tick(1);
    w.repo.attributeCardTransaction({ id: marketId, cardScopeId: known[1], expectedRevision: 1, actorRef: w.owner });
    const attributed = await call<{ revertibleEventId: string; transaction: { revision: number } }>('getTransactionSources', marketId);
    w.tick(1);
    const reverted = await call<{ transaction: { values: { cardScopeId: string } } }>('revertChange', marketId,
      { eventId: attributed.revertibleEventId, expectedRevision: attributed.transaction.revision });
    expect(reverted.transaction.values.cardScopeId).toBe(known[0]);
    const notMerged = await refusal('unmergeTransaction', coffeeId, { expectedRevision: 1, expectedSurvivorRevision: 1 });
    expect(web.isOwnerApiError(notMerged, 'merge-not-allowed')).toBe(true);
  });

  it('offers undo only for a restore the owner decided: a service-token v1 restore parses, with nothing to undo', async () => {
    const restore = (reference: string, amount: number, actorRef: string | undefined) => {
      const row = { externalIdHash: cardExternalIdHash(reference), transactionDate: '2026-10-03', currency: 'USD', amountMinor: amount,
        kind: 'purchase' as const, description: `SYNTHETIC HOLD ${reference}` };
      w.repo.importCardTransactions({ cardAccountId: binding.cardAccountRef, source: 'chase-csv', parserVersion: 'holdr-card-import@1.0.0',
        rows: [{ ...row, status: 'pending', postedDate: null }], actorRef: w.owner });
      const id = w.db.prepare('SELECT id FROM card_transactions WHERE amount_minor = ?').pluck().get(amount) as string;
      w.repo.updateCardTransaction(id, { status: 'removed' }, { actorRef: w.owner });
      // The dismissed hold did post after all: the owner says so in the web import, or a script through the service token.
      w.repo.importCardTransactions({ cardAccountId: binding.cardAccountRef, source: 'chase-csv', parserVersion: 'holdr-card-import@1.0.0',
        rows: [{ ...row, status: 'posted', postedDate: '2026-10-05' }], promoteDismissedMatches: true, ...(actorRef ? { actorRef } : {}) });
      return id;
    };
    const scripted = restore('hold-script', 2100, undefined);
    const bySession = restore('hold-owner', 2200, w.owner);
    type Sources = { revertibleEventId: string | null; events: Array<{ eventId: string; eventType: string; actor: string }> };
    const fromScript = await call<Sources>('getTransactionSources', scripted);
    expect(fromScript.revertibleEventId).toBeNull();
    expect(fromScript.events.filter((event) => event.eventType === 'promoted').map((event) => event.actor)).toEqual(['file-import']);
    const fromOwner = await call<Sources>('getTransactionSources', bySession);
    expect(fromOwner.events.find((event) => event.eventId === fromOwner.revertibleEventId)).toMatchObject({ eventType: 'promoted',
      actor: 'owner' });
  });

  it('starts a walk over when the API refuses a cursor it no longer takes', async () => {
    const restarted = await refusal('getTransactionSources', `card-txn-${'a'.repeat(32)}`, { list: 'events', cursor: 'abcdef' });
    expect(web.isRefusedCursor(restarted, '$.eventsCursor')).toBe(true);
  });
});

/**
 * E2d review r1, finding 5 (E2a-Q3, Q14): a v1 file review set as §5.5/§5.6 specify it. The server's answers are pinned key
 * by key here, and the web client reads, decides and commits it like any set.
 */
describe('a v1 file review set (E2d) through the owner API', () => {
  const root = '/card-sync/owner';
  const SUMMARY_KEYS = ['acceptedAt', 'byteCount', 'cardAccountRef', 'categories', 'closeReason', 'closedAt', 'committedAt', 'deviceId',
    'bindingId', 'expiresAt', 'importBatchId', 'observationSetId', 'plan', 'reviewCount', 'rowCount', 'runId', 'sourceKind', 'state',
    'version'].sort();
  const DETAIL_KEYS = [...SUMMARY_KEYS, 'coverage', 'currency', 'itemCount', 'items', 'nextItemsCursor', 'payloadDigest', 'receiptExpiresAt',
    'rejectedCount'].sort();
  const ROW_KEYS = ['amountMinor', 'cardScopeId', 'description', 'identity', 'issuerCategory', 'kind', 'merchant', 'originalAmountMinor',
    'originalCurrency', 'postedDate', 'rowIndex', 'status', 'transactionDate'].sort();

  /**
   * A 2,001-row Chase file whose last row (index 2,000) is the purchase the browser extension already synced, with
   * another description and no reference: held for review, the only row of its file set (ordinal 0).
   */
  async function heldFileSet(): Promise<{ setId: string; batchId: string; legacyScope: string }> {
    w.ingest(device, binding, [{ scope: known[0], id: 'browser-held', date: '2026-10-01', amount: 1250, description: 'SYNTHETIC BROWSER COFFEE' }]);
    const rows: CardImportDraftRow[] = Array.from({ length: 2000 }, (_, i) => ({ externalId: `csv-bulk-${i}`, transactionDate: '2026-07-01',
      postedDate: '2026-07-02', amountMinor: 100_000 + i, kind: 'purchase' as const, description: `SYNTHETIC FILE ROW ${i}` }));
    rows.push({ transactionDate: '2026-10-02', postedDate: '2026-10-02', amountMinor: 1250, kind: 'purchase', description: 'SYNTHETIC FILE COFFEE' });
    const { payload } = buildCardImportPayload({ source: 'chase-csv', parserVersion: 'contract@1.0.0', issuer: 'chase', currency: 'USD',
      coverage: { start: '2026-07-01', end: '2026-10-31' }, rows });
    const imported = await w.post(`/card-imports/commit?cardAccountId=${binding.cardAccountRef}`, payload);
    expect([imported.status, imported.body.newCount, imported.body.heldCount, imported.body.heldRows], JSON.stringify(imported.body).slice(0, 400))
      .toEqual([201, 2000, 1, [2000]]);
    const setId = w.db.prepare("SELECT id FROM card_sync_observation_sets WHERE origin = 'file'").pluck().get() as string;
    const legacyScope = w.db.prepare("SELECT id FROM card_scopes WHERE card_account_id = ? AND kind = 'legacy'").pluck()
      .get(binding.cardAccountRef) as string;
    return { setId, batchId: imported.body.batch.id as string, legacyScope };
  }

  it('answers with the file set\'s own shapes: sourceKind file, its batch, no run, binding, device, payload digest or coverage, '
    + 'legacy-file rows at their file positions, in reads, plans and effects', async () => {
    const { setId, batchId, legacyScope } = await heldFileSet();
    const listed = await w.get(`${root}/observation-sets?view=open`);
    const summary = listed.body.observationSets.find((set: { observationSetId: string }) => set.observationSetId === setId);
    expect(Object.keys(summary).sort()).toEqual(SUMMARY_KEYS);
    expect(summary).toMatchObject({ sourceKind: 'file', importBatchId: batchId, runId: null, bindingId: null, deviceId: null,
      cardAccountRef: binding.cardAccountRef, rowCount: 1, reviewCount: 1, state: 'needs-review' });

    const detail = (await w.get(`${root}/observation-sets/${setId}`)).body;
    expect(Object.keys(detail).sort()).toEqual(DETAIL_KEYS);
    expect(detail).toMatchObject({ ...summary, version: expect.any(Number), payloadDigest: null, coverage: [], itemCount: 1,
      nextItemsCursor: null });
    const [item] = detail.items;
    expect(item).toMatchObject({ rowIndex: 2000, reason: 'cross-source-similar', decision: null, committed: null });
    expect(Object.keys(item.observation).sort()).toEqual(ROW_KEYS);
    expect(item.observation).toEqual({ rowIndex: 2000, transactionDate: '2026-10-02', postedDate: '2026-10-02', status: 'posted',
      amountMinor: 1250, kind: 'purchase', description: 'SYNTHETIC FILE COFFEE', merchant: null, issuerCategory: null,
      cardScopeId: legacyScope, identity: 'legacy-file', originalAmountMinor: null, originalCurrency: null });
    expect(item.candidates).toEqual([expect.objectContaining({ sourceKind: 'extension', amountMinor: 1250, description: 'SYNTHETIC BROWSER COFFEE' })]);

    const decided = await w.post(`${root}/observation-sets/${setId}/decisions`, { expectedVersion: detail.version,
      decisions: [{ itemId: item.itemId, action: 'insert-new', transactionId: null, cardScopeId: null }] });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    const plan = await w.post(`${root}/observation-sets/${setId}/plan`, { expectedVersion: decided.body.version, sourceReviewed: false });
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    expect(plan.body).toMatchObject({ payloadDigest: null, effectCount: 1, effects: [expect.objectContaining({ rowIndex: 2000 })] });
    const effects = await w.get(`${root}/plans/${plan.body.previewId}/effects`);
    expect(effects.body.effects).toEqual(plan.body.effects);
    const committed = await w.post(`${root}/plans/${plan.body.previewId}/commit`, { payloadDigest: null, planDigest: plan.body.planDigest });
    expect(committed.status, JSON.stringify(committed.body)).toBe(200);
    expect(committed.body).toMatchObject({ status: 'committed' });
  });

  it('the web client reads the file set as Holdr sends it (E2a-Q3, Q14: legacy-file rows at their file positions, no coverage), '
    + 'decides it, and commits its plan with no payload digest', async () => {
    const { setId } = await heldFileSet();
    const detail = await call<{ sourceKind: string; version: number; payloadDigest: null; coverage: unknown[]; runId: null;
      items: Array<{ itemId: string; rowIndex: number; observation: { identity: string; rowIndex: number } }> }>('getObservationSet', setId);
    expect([detail.sourceKind, detail.runId, detail.payloadDigest, detail.coverage]).toEqual(['file', null, null, []]);
    expect(detail.items.map((item) => [item.rowIndex, item.observation.identity, item.observation.rowIndex])).toEqual([[2000, 'legacy-file', 2000]]);
    const listed = await call<{ observationSets: Array<{ observationSetId: string; sourceKind: string }> }>('listObservationSets', 'open');
    expect(listed.observationSets.find((set) => set.observationSetId === setId)?.sourceKind).toBe('file');

    const decided = await call<{ version: number }>('recordDecisions', setId, { expectedVersion: detail.version,
      decisions: [{ itemId: detail.items[0].itemId, action: 'insert-new', transactionId: null, cardScopeId: null }] });
    const plan = await call<{ previewId: string; payloadDigest: null; planDigest: string; effects: Array<{ rowIndex: number }> }>(
      'preparePlan', setId, { expectedVersion: decided.version, sourceReviewed: false });
    expect([plan.payloadDigest, plan.effects.map((effect) => effect.rowIndex)]).toEqual([null, [2000]]);
    const committed = await call<{ status: string }>('commitPlan', plan.previewId, { payloadDigest: null, planDigest: plan.planDigest });
    expect(committed.status).toBe('committed');
    const closed = await call<{ observationSets: Array<{ observationSetId: string; closeReason: string | null }> }>('listObservationSets', 'closed');
    expect(closed.observationSets.find((set) => set.observationSetId === setId)?.closeReason).toBe('committed');
  });
});
