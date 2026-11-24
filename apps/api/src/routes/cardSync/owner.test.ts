import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CARD_SYNC_CURSOR_MAX_LENGTH, CardSyncCursorCodec } from './cursor.js';
import { CardSyncOwnerWorld, OWNER_ORIGIN, OWNER_SERVICE_TOKEN } from '../../testing/cardSyncOwnerWorld.js';
import { SCENARIO_OWNER, type ScenarioDevice, type ScenarioRow } from '../../testing/cardSyncScenario.js';
import type { CardSourceBindingView } from '../../services/sqliteStateRepo.js';

// E2a: the card sync owner routes (E1b design §10 items 4, 10, 11, 14, 17–21, 24; §5.11), through the real app.

let w: CardSyncOwnerWorld;
let binding: CardSourceBindingView;
let device: ScenarioDevice;
let known: string[];
let unknown: string;

beforeEach(async () => {
  w = await CardSyncOwnerWorld.create();
  w.enable('chase');
  binding = w.binding();
  device = w.device([binding.bindingId]);
  ({ known, unknown } = w.scopes(binding));
});

afterEach(() => {
  w.close();
});

const coffee = (): ScenarioRow => ({ scope: known[0], date: '2026-10-01', amount: 1250, description: 'FOURTH COFFEE',
  merchant: 'Fourth Coffee', id: 'sor-1' });
const market = (): ScenarioRow => ({ scope: known[0], date: '2026-10-02', amount: 4999, description: 'CONTOSO MARKET', id: 'sor-2' });
const capture = (): ScenarioRow => ({ scope: known[0], date: '2026-10-02', amount: 1250, description: 'FOURTH COFFEE #2',
  merchant: 'Fourth Coffee' });
const rows = (n: number, from = 0): ScenarioRow[] => Array.from({ length: n }, (_, i) => ({
  scope: known[i % 2], date: `2026-09-${String(1 + ((from + i) % 28)).padStart(2, '0')}`, amount: 100 + from + i,
  description: `SYNTHETIC SHOP ${from + i}`, id: `sor-bulk-${from + i}`,
}));

const OWNER = '/card-sync/owner';
const setPath = (setId: string, action = '') => `${OWNER}/observation-sets/${setId}${action}`;

/** A set whose one row needs the owner (no-stable-id with the committed coffee as its candidate); the set and the item. */
async function setWithReview() {
  w.ingest(device, binding, [coffee()]);
  const { receipt } = w.accept(device, binding, [capture()]);
  const detail = await w.get(setPath(receipt.observationSetId));
  expect(detail.status).toBe(200);
  return { setId: receipt.observationSetId, detail: detail.body, item: detail.body.items[0] };
}

describe('mounting and principals', () => {
  it('answers the service token 403 credential-not-allowed on every owner route, reads included (Q44)', async () => {
    const setId = w.accept(device, binding, [coffee()]).receipt.observationSetId;
    const paths: Array<['get' | 'post', string]> = [
      ['get', `${OWNER}/observation-sets?view=open`], ['get', setPath(setId)], ['post', setPath(setId, '/decisions')],
      ['post', setPath(setId, '/plan')], ['post', setPath(setId, '/discard')], ['get', `${OWNER}/plans/prv_${'a'.repeat(32)}/effects`],
      ['post', `${OWNER}/plans/prv_${'a'.repeat(32)}/commit`], ['get', `${OWNER}/runs`], ['get', `${OWNER}/runs/run_${'a'.repeat(32)}`],
      ['get', `${OWNER}/runs/run_${'a'.repeat(32)}/payload`], ['get', `${OWNER}/transactions/card-txn-${'a'.repeat(32)}/sources`],
      ['post', `${OWNER}/identities/card-ident-${'a'.repeat(32)}/detach`], ['post', `${OWNER}/identities/card-ident-${'a'.repeat(32)}/repoint`],
      ['post', `${OWNER}/transactions/card-txn-${'a'.repeat(32)}/revert`], ['post', `${OWNER}/transactions/card-txn-${'a'.repeat(32)}/unmerge`],
      ['get', `${OWNER}/no-such-route`],
    ];
    for (const [method, path] of paths) {
      const res = await w.asService(method, path, { expectedVersion: 1 });
      expect([path, res.status, res.body]).toEqual([path, 403, { error: 'credential-not-allowed' }]);
    }
    expect(w.setVersion(setId)).toBe(1);
  });

  it('mounts no device route and answers unknown card sync paths 404, never with a CORS header', async () => {
    for (const path of ['/card-sync', '/card-sync/devices/runs', '/CARD-SYNC/devices/runs', '/card-sync/ownerish',
      '/card-sync/pairing/redeem', `${OWNER}/state`, `${OWNER}/nothing`]) {
      const res = await (await w.http()).get(path).set('Cookie', w.cookie).set('Origin', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop');
      expect([path, res.status, res.body]).toEqual([path, 404, { error: 'not-found' }]);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
    for (const path of ['/card-sync', '/card-sync/devices/runs', '/card-sync/ownerish', `${OWNER}/nothing`]) {
      const res = await (await w.http()).post(path).set('Cookie', w.cookie).set('Origin', OWNER_ORIGIN).set('X-Holdr-Request', '1')
        .set('Content-Type', 'application/json').send('{');
      expect([path, res.status, res.body]).toEqual([path, 404, { error: 'not-found' }]);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
    const res = await (await w.http()).options(`${OWNER}/observation-sets`).set('Cookie', w.cookie).set('Origin', OWNER_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('refuses an extension set\'s plan while no authorization gate is wired (E2a default): 503 authorization-blocked', async () => {
    const blocked = await CardSyncOwnerWorld.create({ gate: 'not-wired' });
    try {
      blocked.enable('chase');
      const b = blocked.binding();
      const d = blocked.device([b.bindingId]);
      const setId = blocked.accept(d, b, [{ scope: blocked.scopes(b).known[0], date: '2026-10-01', amount: 1250, description: 'SHOP',
        id: 'x-1' }]).receipt.observationSetId;
      const res = await blocked.post(`${OWNER}/observation-sets/${setId}/plan`, { expectedVersion: 1, sourceReviewed: false });
      expect([res.status, res.body]).toEqual([503, { error: 'authorization-blocked' }]);
      // Reading and discarding are not source-authorization changes: still allowed.
      expect((await blocked.get(`${OWNER}/observation-sets/${setId}`)).status).toBe(200);
      const discarded = await blocked.post(`${OWNER}/observation-sets/${setId}/discard`, { expectedVersion: 1, reason: 'not-mine' });
      expect(discarded.body).toMatchObject({ state: 'rejected', closeReason: 'discarded' });
      // Neither a blocked gate nor a pause stops the ledger repairs (§10 item 14).
      blocked.ingest(d, b, [{ scope: blocked.scopes(b).known[0], date: '2026-10-01', amount: 1250, description: 'SHOP', id: 'x-2',
        secondary: [['chase-api:derived:v1', 'derived-x']] }]);
      blocked.repo.pauseCardSync({ actorRef: SCENARIO_OWNER, ...blocked.step() });
      const rowId = blocked.db.prepare('SELECT id FROM card_transactions').pluck().get() as string;
      const alias = (await blocked.get(`${OWNER}/transactions/${rowId}/sources`)).body.identities[1].identityId as string;
      expect((await blocked.reverify()).status).toBe(200);
      const detached = await blocked.post(`${OWNER}/identities/${alias}/detach`, { transactionId: rowId, expectedRevision: 1 });
      expect(detached.status).toBe(200);
    } finally {
      blocked.close();
    }
  });
});

describe('sets, items and decisions (§5.5, §10 items 4, 17, 20)', () => {
  it('lists open sets as SetSummary and shows a set\'s items with their observation and candidates', async () => {
    const { setId, detail, item } = await setWithReview();
    const list = await w.get(`${OWNER}/observation-sets?view=open`);
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ observationSets: [expect.objectContaining({ observationSetId: setId })], nextCursor: null });
    expect(list.body.observationSets[0]).toEqual({
      observationSetId: setId, sourceKind: 'extension', runId: expect.stringMatching(/^run_/), bindingId: binding.bindingId,
      deviceId: device.deviceId, importBatchId: null, cardAccountRef: binding.cardAccountRef, version: 1, state: 'needs-review',
      acceptedAt: w.now(), expiresAt: expect.any(String), rowCount: 1, byteCount: expect.any(Number), reviewCount: 1,
      categories: [{ category: 'no-stable-id', count: 1 }], plan: null, committedAt: null, closedAt: null, closeReason: null,
    });
    const coffeeRow = w.db.prepare('SELECT id, card_scope_id FROM card_transactions').get() as { id: string; card_scope_id: string };
    expect(detail).toMatchObject({ currency: 'USD', payloadDigest: expect.stringMatching(/^pd1:/), receiptExpiresAt: expect.any(String),
      rejectedCount: 0, itemCount: 1, nextItemsCursor: null, coverage: [expect.objectContaining({ cardScopeId: known[0], status: 'posted' })] });
    expect(item).toEqual({
      itemId: expect.stringMatching(/^rvw_/), category: 'no-stable-id', rowIndex: 0, reason: 'no-stable-id',
      observation: { rowIndex: 0, transactionDate: '2026-10-02', postedDate: '2026-10-02', status: 'posted', amountMinor: 1250,
        kind: 'purchase', description: 'FOURTH COFFEE #2', merchant: 'Fourth Coffee', issuerCategory: null, cardScopeId: known[0],
        identity: 'capture', originalAmountMinor: null, originalCurrency: null },
      candidates: [{ transactionId: coffeeRow.id, cardScopeId: coffeeRow.card_scope_id, scopeKind: 'known', sourceKind: 'extension',
        status: 'posted', transactionDate: '2026-10-01', postedDate: '2026-10-01', amountMinor: 1250, kind: 'purchase',
        description: 'FOURTH COFFEE', merchant: 'Fourth Coffee', userCategory: null, notes: null, matchedOn: ['amount', 'merchant'],
        blockedReason: null }],
      difference: null, allowedActions: ['same-transaction', 'insert-new', 'reject-row'], decision: null, committed: null,
    });
    expect((await w.get(`${OWNER}/observation-sets?view=closed`)).body.observationSets.map((s: { state: string }) => s.state))
      .toEqual(['committed']);
  });

  it('records a decision batch on the version the owner saw, and answers a stale one 409 with the current version', async () => {
    const { setId, item } = await setWithReview();
    const decision = { itemId: item.itemId, action: 'same-transaction', transactionId: item.candidates[0].transactionId, cardScopeId: null };
    const saved = await w.post(setPath(setId, '/decisions'), { expectedVersion: 1, decisions: [decision] });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ version: 2, reviewCount: 0, items: [{ decision: { ...decision, decidedAt: w.now() } }] });
    const stale = await w.post(setPath(setId, '/decisions'), { expectedVersion: 1, decisions: [decision] });
    expect([stale.status, stale.body]).toEqual([409, { error: 'version-conflict', currentVersion: 2 }]);
    const wrong = await w.post(setPath(setId, '/decisions'), { expectedVersion: 2, decisions: [{ ...decision, action: 'accept-correction',
      transactionId: null }] });
    expect([wrong.status, wrong.body]).toEqual([409, { error: 'action-not-allowed' }]);
    expect(w.setVersion(setId)).toBe(2);
  });

  it('refreshes a set before rendering it, and answers review-stale with the refreshed version (§10 item 4)', async () => {
    const { setId, item } = await setWithReview();
    // Another set's commit moves the account's ledger: the review mark is behind now.
    w.ingest(device, binding, [market()]);
    const decision = { itemId: item.itemId, action: 'insert-new', transactionId: null, cardScopeId: null };
    const stale = await w.post(setPath(setId, '/decisions'), { expectedVersion: 1, decisions: [decision] });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ error: 'version-conflict', currentVersion: w.setVersion(setId) });
    const read = await w.get(setPath(setId));
    expect(read.body.version).toBe(w.setVersion(setId));
    const saved = await w.post(setPath(setId, '/decisions'), { expectedVersion: read.body.version, decisions: [decision] });
    expect(saved.status).toBe(200);
  });

  it('pages a set\'s items with cursors bound to the set, the kind and the pins (R7, test 202)', async () => {
    w.ingest(device, binding, rows(120));
    // The same 120 purchases captured without ids: each a no-stable-id item with its committed twin as candidate.
    const setId = w.accept(device, binding, rows(120).map((row) => ({ ...row, id: undefined, description: `${row.description} X` })))
      .receipt.observationSetId;
    const first = await w.get(setPath(setId));
    expect(first.body).toMatchObject({ itemCount: 120, nextItemsCursor: expect.stringMatching(/^[a-p]{1,64}$/) });
    expect(first.body.items).toHaveLength(100);
    const cursor = first.body.nextItemsCursor as string;
    expect(cursor.length).toBeLessThanOrEqual(CARD_SYNC_CURSOR_MAX_LENGTH);
    const second = await w.get(`${setPath(setId)}?itemsCursor=${cursor}`);
    expect(second.body).toMatchObject({ version: first.body.version, nextItemsCursor: null });
    expect(second.body.items.map((i: { rowIndex: number }) => i.rowIndex)).toEqual(Array.from({ length: 20 }, (_, i) => 100 + i));
    const seen = new Set([...first.body.items, ...second.body.items].map((i: { itemId: string }) => i.itemId));
    expect(seen.size).toBe(120);

    // Refused cursors: 422 invalid-request naming the parameter, before any read.
    const other = w.accept(device, binding, [capture()]).receipt.observationSetId;
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('a') ? 'b' : 'a'}`;
    for (const [path, param] of [
      [`${setPath(other)}?itemsCursor=${cursor}`, 'itemsCursor'], [`${setPath(setId)}?itemsCursor=${tampered}`, 'itemsCursor'],
      [`${setPath(setId)}?itemsCursor=abc`, 'itemsCursor'], [`${setPath(setId)}?itemsCursor=${cursor.toUpperCase()}`, 'itemsCursor'],
      [`${OWNER}/observation-sets?view=open&cursor=${cursor}`, 'cursor'],
    ] as const) {
      const res = await w.get(path);
      expect([path, res.status, res.body]).toEqual([path, 422, { error: 'invalid-request', issues: [{ code: 'invalid-format', path: `$.${param}` }] }]);
    }
    // A moved pin: the walk is refused 409 with the set's version, and starts over.
    const item = first.body.items[0];
    await w.post(setPath(setId, '/decisions'), { expectedVersion: first.body.version, decisions: [{ itemId: item.itemId,
      action: 'insert-new', transactionId: null, cardScopeId: null }] });
    const moved = await w.get(`${setPath(setId)}?itemsCursor=${cursor}`);
    expect([moved.status, moved.body]).toEqual([409, { error: 'version-conflict', currentVersion: first.body.version + 1 }]);
  });

  it('pages the set list newest first with a cursor bound to its view', async () => {
    const second = w.device([binding.bindingId]);
    const ids: string[] = [];
    for (let i = 0; i < 51; i += 1) {
      ids.push(w.accept(i < 40 ? device : second, binding, [{ ...capture(), description: `CAPTURE ${i}` }]).receipt.observationSetId);
      w.tick(1);
    }
    const first = await w.get(`${OWNER}/observation-sets?view=open`);
    expect(first.body.observationSets).toHaveLength(50);
    expect(first.body.observationSets[0].observationSetId).toBe(ids[50]);
    const next = await w.get(`${OWNER}/observation-sets?view=open&cursor=${first.body.nextCursor}`);
    expect(next.body).toEqual({ observationSets: [expect.objectContaining({ observationSetId: ids[0] })], nextCursor: null });
    const crossed = await w.get(`${OWNER}/observation-sets?view=closed&cursor=${first.body.nextCursor}`);
    expect([crossed.status, crossed.body.issues]).toEqual([422, [{ code: 'invalid-format', path: '$.cursor' }]]);
  });

  it('presents a set past its deadline as expired, offering no action, before retention runs (Q46)', async () => {
    const { setId } = await setWithReview();
    w.tick(31 * 86_400);
    w.cookie = await w.signIn();
    const read = await w.get(setPath(setId));
    expect(read.body).toMatchObject({ state: 'expired-unreviewed', reviewCount: 0, closeReason: null, items: [{ allowedActions: [] }] });
    expect((await w.get(`${OWNER}/observation-sets?view=open`)).body.observationSets).toEqual([]);
    const late = await w.post(setPath(setId, '/plan'), { expectedVersion: read.body.version, sourceReviewed: false });
    expect([late.status, late.body]).toEqual([410, { error: 'observation-expired' }]);
  });

  it('discards an open set on the version the owner saw', async () => {
    const { setId } = await setWithReview();
    const stale = await w.post(setPath(setId, '/discard'), { expectedVersion: 7, reason: 'not-mine' });
    expect([stale.status, stale.body]).toEqual([409, { error: 'version-conflict', currentVersion: 1 }]);
    const res = await w.post(setPath(setId, '/discard'), { expectedVersion: 1, reason: 'not-mine' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ observationSetId: setId, state: 'rejected', closeReason: 'discarded', closedAt: w.now(),
      reviewCount: 0, categories: [] });
  });
});

describe('plans, effects and commit (§5.6, §10 items 10, 17, 21)', () => {
  it('prepares a plan with its effects\' values, and commits it once with the digests the owner saw', async () => {
    w.ingest(device, binding, [coffee()]);
    const coffeeRow = w.db.prepare('SELECT id FROM card_transactions').pluck().get() as string;
    // The same purchase again with a secondary id (an alias effect), plus a new one (an insert).
    const setId = w.accept(device, binding, [{ ...coffee(), secondary: [['chase-api:derived:v1', 'derived-1']] }, market()])
      .receipt.observationSetId;
    const prepared = await w.post(setPath(setId, '/plan'), { expectedVersion: 1, sourceReviewed: false });
    expect(prepared.status).toBe(200);
    const plan = prepared.body;
    const values = (row: ScenarioRow) => ({ status: 'posted', transactionDate: row.date, postedDate: row.date, amountMinor: row.amount,
      kind: 'purchase', description: row.description, merchant: row.merchant ?? null, cardScopeId: row.scope });
    expect(plan).toMatchObject({ observationSetId: setId, setVersion: 1, planKind: 'set', effectCount: 2, nextEffectsCursor: null,
      counts: expect.objectContaining({ insert: 1, aliased: 1, unchanged: 0 }), observationExpiresAt: expect.any(String) });
    expect(plan.effects).toEqual([
      { itemId: null, rowIndex: 0, effect: 'alias', transactionId: coffeeRow, before: values(coffee()), after: values(coffee()) },
      { itemId: null, rowIndex: 1, effect: 'insert', transactionId: null, before: null, after: values(market()) },
    ]);
    expect((await w.get(setPath(setId))).body.plan).toEqual({ previewId: plan.previewId, createdAt: plan.createdAt,
      expiresAt: plan.expiresAt, state: 'valid' });

    const wrong = await w.post(`${OWNER}/plans/${plan.previewId}/commit`, { payloadDigest: plan.payloadDigest,
      planDigest: `pl1:${'a'.repeat(64)}` });
    expect([wrong.status, wrong.body]).toEqual([409, { error: 'plan-mismatch' }]);
    const body = { payloadDigest: plan.payloadDigest, planDigest: plan.planDigest };
    const committed = await w.post(`${OWNER}/plans/${plan.previewId}/commit`, body);
    expect(committed.status).toBe(200);
    expect(committed.body).toEqual({ status: 'committed', previewId: plan.previewId, observationSetId: setId, committedAt: w.now(),
      counts: plan.counts });
    w.tick(5);
    // C6: a lost ACK is answered with the first commit's result.
    expect((await w.post(`${OWNER}/plans/${plan.previewId}/commit`, body)).body).toEqual(committed.body);
    expect((await w.get(setPath(setId))).body).toMatchObject({ state: 'committed', committedAt: committed.body.committedAt,
      plan: { previewId: plan.previewId, state: 'committed' } });
  });

  it('pages a plan of more than 500 effects and echoes its digest and state; expired plans are 410 (§5.6)', async () => {
    const setId = w.accept(device, binding, rows(620)).receipt.observationSetId;
    const prepared = (await w.post(setPath(setId, '/plan'), { expectedVersion: 1, sourceReviewed: false })).body;
    expect(prepared).toMatchObject({ effectCount: 620, nextEffectsCursor: expect.stringMatching(/^[a-p]+$/) });
    expect(prepared.effects).toHaveLength(500);
    const page = await w.get(`${OWNER}/plans/${prepared.previewId}/effects?cursor=${prepared.nextEffectsCursor}`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ previewId: prepared.previewId, planDigest: prepared.planDigest, state: 'valid', nextCursor: null });
    expect(page.body.effects.map((e: { rowIndex: number }) => e.rowIndex)).toEqual(Array.from({ length: 120 }, (_, i) => 500 + i));
    expect(page.body.effects[0]).toEqual({ itemId: null, rowIndex: 500, effect: 'insert', transactionId: null, before: null,
      after: expect.objectContaining({ description: 'SYNTHETIC SHOP 500', amountMinor: 600 }) });
    // A cursor of another plan, or of another kind, is refused before any read.
    const items = await w.get(`${OWNER}/plans/prv_${'b'.repeat(32)}/effects?cursor=${prepared.nextEffectsCursor}`);
    expect([items.status, items.body.issues]).toEqual([422, [{ code: 'invalid-format', path: '$.cursor' }]]);
    // A newer plan supersedes this one: its pages say so (X42).
    await w.post(setPath(setId, '/plan'), { expectedVersion: 1, sourceReviewed: false });
    expect((await w.get(`${OWNER}/plans/${prepared.previewId}/effects?cursor=${prepared.nextEffectsCursor}`)).body.state).toBe('superseded');
    const superseded = await w.post(`${OWNER}/plans/${prepared.previewId}/commit`, { payloadDigest: prepared.payloadDigest,
      planDigest: prepared.planDigest });
    expect([superseded.status, superseded.body]).toEqual([409, { error: 'preview-stale' }]);
    const latest = (await w.post(setPath(setId, '/plan'), { expectedVersion: 1, sourceReviewed: false })).body;
    w.tick(601);
    const expired = await w.get(`${OWNER}/plans/${latest.previewId}/effects?cursor=${latest.nextEffectsCursor}`);
    expect([expired.status, expired.body]).toEqual([410, { error: 'plan-expired' }]);
    const late = await w.post(`${OWNER}/plans/${latest.previewId}/commit`, { payloadDigest: latest.payloadDigest,
      planDigest: latest.planDigest });
    expect([late.status, late.body]).toEqual([410, { error: 'plan-expired' }]);
  });

  it('answers 410 for a committed or superseded plan\'s effects at its deadline, and its state before (review r1, finding 8)', async () => {
    // The reviewer's repro: a plan superseded by another, that one committed, both read at the deadline.
    const setId = w.accept(device, binding, [{ ...market(), id: 'expired-effect-ref' }]).receipt.observationSetId;
    const prepare = async () => (await w.post(setPath(setId, '/plan'), { expectedVersion: 1, sourceReviewed: false })).body;
    const superseded = await prepare();
    const committed = await prepare();
    expect((await w.post(`${OWNER}/plans/${committed.previewId}/commit`, { planDigest: committed.planDigest,
      payloadDigest: committed.payloadDigest })).status).toBe(200);
    const effects = (plan: { previewId: string }) => w.get(`${OWNER}/plans/${plan.previewId}/effects`);
    w.tick(599);
    expect([(await effects(superseded)).body.state, (await effects(committed)).body.state]).toEqual(['superseded', 'committed']);
    w.tick(1);
    for (const plan of [superseded, committed]) {
      const res = await effects(plan);
      expect([res.status, res.body]).toEqual([410, { error: 'plan-expired' }]);
    }
    // The commit's stored result is another contract: its replay still answers 200.
    const replay = await w.post(`${OWNER}/plans/${committed.previewId}/commit`, { planDigest: committed.planDigest,
      payloadDigest: committed.payloadDigest });
    expect(replay.status).toBe(200);
  });

  it('refuses a query string on an owner POST before anything is read or written (D11)', async () => {
    const setId = w.accept(device, binding, [market()]).receipt.observationSetId;
    const before = w.db.prepare('SELECT version FROM card_sync_observation_sets WHERE id = ?').pluck().get(setId);
    for (const query of ['?expectedVersion=1', '?x=1', '?a[b]=c']) {
      const res = await w.post(`${setPath(setId, '/plan')}${query}`, { expectedVersion: 1, sourceReviewed: false });
      expect([res.status, res.body]).toEqual([422, { error: 'invalid-request', issues: [{ code: 'unknown-key', path: '$.<key>' }] }]);
    }
    expect(w.db.prepare('SELECT count(*) FROM card_sync_commit_plans').pluck().get()).toBe(0);
    expect(w.db.prepare('SELECT version FROM card_sync_observation_sets WHERE id = ?').pluck().get(setId)).toBe(before);
    expect((await w.post(setPath(setId, '/plan'), { expectedVersion: 1, sourceReviewed: false })).status).toBe(200);
  });

  it('shows a decided link as one match, and a plan that needs a decision is refused decisions-incomplete', async () => {
    const { setId, item } = await setWithReview();
    const incomplete = await w.post(setPath(setId, '/plan'), { expectedVersion: 1, sourceReviewed: false });
    expect([incomplete.status, incomplete.body]).toEqual([409, { error: 'decisions-incomplete' }]);
    await w.post(setPath(setId, '/decisions'), { expectedVersion: 1, decisions: [{ itemId: item.itemId, action: 'same-transaction',
      transactionId: item.candidates[0].transactionId, cardScopeId: null }] });
    const plan = (await w.post(setPath(setId, '/plan'), { expectedVersion: 2, sourceReviewed: false })).body;
    const candidate = item.candidates[0];
    const values = { status: candidate.status, transactionDate: candidate.transactionDate, postedDate: candidate.postedDate,
      amountMinor: candidate.amountMinor, kind: candidate.kind, description: candidate.description, merchant: candidate.merchant,
      cardScopeId: candidate.cardScopeId };
    expect(plan.effects).toEqual([{ itemId: item.itemId, rowIndex: 0, effect: 'match', transactionId: candidate.transactionId,
      before: values, after: values }]);
    // Another principal's plan is not found (§4.10.1).
    const notMine = await w.post(`${OWNER}/plans/prv_${'c'.repeat(32)}/commit`, { payloadDigest: plan.payloadDigest, planDigest: plan.planDigest });
    expect([notMine.status, notMine.body]).toEqual([404, { error: 'not-found' }]);
  });
});

describe('effect values: a function of the stored plan and the pinned revisions (§5.6, Revision 7 finding 4)', () => {
  const parking = (): ScenarioRow => ({ scope: known[1], date: '2026-10-03', status: 'pending', amount: 800,
    description: 'NORTHWIND PARKING', id: 'sor-3' });

  it('shows an adjustment as the reversal of the committed change, then the new decision (revert, reject)', async () => {
    w.ingest(device, binding, [parking()]);
    const rowId = w.db.prepare('SELECT id FROM card_transactions').pluck().get() as string;
    const setId = w.accept(device, binding, [{ ...parking(), status: 'posted', posted: '2026-10-05' }]).receipt.observationSetId;
    const item = (await w.get(setPath(setId))).body.items[0];
    expect(item.reason).toBe('pending-posted');
    await w.post(setPath(setId, '/decisions'), { expectedVersion: 1, decisions: [{ itemId: item.itemId, action: 'same-transaction',
      transactionId: rowId, cardScopeId: null }] });
    const plan = (await w.post(setPath(setId, '/plan'), { expectedVersion: 2, sourceReviewed: false })).body;
    const pending = { status: 'pending', transactionDate: '2026-10-03', postedDate: null, amountMinor: 800, kind: 'purchase',
      description: 'NORTHWIND PARKING', merchant: null, cardScopeId: known[1] };
    const posted = { ...pending, status: 'posted', postedDate: '2026-10-05' };
    expect(plan.effects).toEqual([{ itemId: item.itemId, rowIndex: 0, effect: 'promote', transactionId: rowId, before: pending, after: posted }]);
    await w.post(`${OWNER}/plans/${plan.previewId}/commit`, { payloadDigest: plan.payloadDigest, planDigest: plan.planDigest });
    w.tick(60);
    // The owner changes the committed decision: an adjustment plan (§4.9.2).
    const committed = (await w.get(setPath(setId))).body;
    expect(committed.items[0].allowedActions).toContain('reject-row');
    await w.post(setPath(setId, '/decisions'), { expectedVersion: committed.version, decisions: [{ itemId: item.itemId,
      action: 'reject-row', transactionId: null, cardScopeId: null }] });
    const adjustment = (await w.post(setPath(setId, '/plan'), { expectedVersion: committed.version + 1, sourceReviewed: false })).body;
    expect(adjustment).toMatchObject({ planKind: 'adjustment', effectCount: 2 });
    expect(adjustment.effects).toEqual([
      { itemId: item.itemId, rowIndex: 0, effect: 'revert', transactionId: rowId, before: posted, after: pending },
      { itemId: item.itemId, rowIndex: 0, effect: 'reject', transactionId: null, before: null, after: null },
    ]);
    const done = await w.post(`${OWNER}/plans/${adjustment.previewId}/commit`, { payloadDigest: adjustment.payloadDigest,
      planDigest: adjustment.planDigest });
    expect(done.status).toBe(200);
    expect(w.db.prepare('SELECT status, posted_date FROM card_transactions WHERE id = ?').get(rowId)).toEqual({ status: 'pending',
      posted_date: null });
  });

  it('shows an unmatched link and its new row (unmatch, insert)', async () => {
    const { setId, item } = await setWithReview();
    const coffeeId = item.candidates[0].transactionId as string;
    await w.post(setPath(setId, '/decisions'), { expectedVersion: 1, decisions: [{ itemId: item.itemId, action: 'same-transaction',
      transactionId: coffeeId, cardScopeId: null }] });
    const plan = (await w.post(setPath(setId, '/plan'), { expectedVersion: 2, sourceReviewed: false })).body;
    await w.post(`${OWNER}/plans/${plan.previewId}/commit`, { payloadDigest: plan.payloadDigest, planDigest: plan.planDigest });
    const version = w.setVersion(setId);
    await w.post(setPath(setId, '/decisions'), { expectedVersion: version, decisions: [{ itemId: item.itemId, action: 'insert-new',
      transactionId: null, cardScopeId: null }] });
    const adjustment = (await w.post(setPath(setId, '/plan'), { expectedVersion: version + 1, sourceReviewed: false })).body;
    const coffeeValues = { status: 'posted', transactionDate: '2026-10-01', postedDate: '2026-10-01', amountMinor: 1250, kind: 'purchase',
      description: 'FOURTH COFFEE', merchant: 'Fourth Coffee', cardScopeId: known[0] };
    expect(adjustment.effects).toEqual([
      { itemId: item.itemId, rowIndex: 0, effect: 'unmatch', transactionId: coffeeId, before: coffeeValues, after: coffeeValues },
      { itemId: item.itemId, rowIndex: 0, effect: 'insert', transactionId: null, before: null,
        after: { ...coffeeValues, transactionDate: '2026-10-02', postedDate: '2026-10-02', description: 'FOURTH COFFEE #2' } },
    ]);
  });

  it('keeps every page of a plan on the values it was prepared from, whatever the ledger does meanwhile', async () => {
    w.ingest(device, binding, rows(620));
    const setId = w.accept(device, binding, rows(620).map((row, i) => ({ ...row, secondary: [['chase-api:derived:v1', `derived-${i}`]] })))
      .receipt.observationSetId;
    const plan = (await w.post(setPath(setId, '/plan'), { expectedVersion: 1, sourceReviewed: false })).body;
    expect(plan).toMatchObject({ effectCount: 620, counts: expect.objectContaining({ aliased: 620 }) });
    const target = w.db.prepare("SELECT id, card_scope_id FROM card_transactions WHERE description = 'SYNTHETIC SHOP 550'").get() as
      { id: string; card_scope_id: string };
    // The owner moves row 550 to the other card after the plan was prepared (its revision moves to 2).
    w.tick(1);
    w.repo.attributeCardTransaction({ id: target.id, cardScopeId: known.find((scope) => scope !== target.card_scope_id)!,
      expectedRevision: 1, actorRef: w.owner });
    const page = (await w.get(`${OWNER}/plans/${plan.previewId}/effects?cursor=${plan.nextEffectsCursor}`)).body;
    const effect = page.effects.find((e: { transactionId: string }) => e.transactionId === target.id);
    expect(effect).toMatchObject({ effect: 'alias', rowIndex: 550, before: { cardScopeId: target.card_scope_id },
      after: { cardScopeId: target.card_scope_id } });
    // The plan itself is stale now: its commit is refused, nothing written.
    const stale = await w.post(`${OWNER}/plans/${plan.previewId}/commit`, { payloadDigest: plan.payloadDigest, planDigest: plan.planDigest });
    expect([stale.status, stale.body]).toEqual([409, { error: 'preview-stale' }]);
  });
});

describe('live keyset pages of a transaction\'s lists (§5.7.1, §10 items 20, 24)', () => {
  it('pages the history newest first and the merged rows, each list continuing from its own cursor', async () => {
    // One card: rows of two known cards are never merged.
    w.ingest(device, binding, rows(103).map((row) => ({ ...row, scope: known[0] })));
    const ids = w.db.prepare("SELECT id FROM card_transactions ORDER BY description").pluck().all() as string[];
    const [survivor, ...others] = ids;
    for (const loser of others.slice(0, 101)) {
      w.tick(1);
      const survivorRevision = w.db.prepare('SELECT revision FROM card_transactions WHERE id = ?').pluck().get(survivor) as number;
      w.repo.mergeCardTransactions({ survivorId: survivor, loserId: loser, reason: 'superseded', expectedRevisions: [survivorRevision, 1],
        categoryFrom: 'survivor', notesFrom: 'survivor', actorRef: w.owner });
    }
    const first = (await w.get(`${OWNER}/transactions/${survivor}/sources`)).body;
    expect(first.mergedRows).toHaveLength(100);
    expect(first.events).toHaveLength(100);
    expect(first.nextMergedRowsCursor).toMatch(/^[a-p]+$/);
    expect(first.nextEventsCursor).toMatch(/^[a-p]+$/);
    const merged = (await w.get(`${OWNER}/transactions/${survivor}/sources?mergedRowsCursor=${first.nextMergedRowsCursor}`)).body;
    expect(merged.mergedRows).toHaveLength(1);
    expect(merged.nextMergedRowsCursor).toBeNull();
    expect(new Set([...first.mergedRows, ...merged.mergedRows].map((row: { transactionId: string }) => row.transactionId)).size).toBe(101);
    const events = (await w.get(`${OWNER}/transactions/${survivor}/sources?eventsCursor=${first.nextEventsCursor}`)).body;
    const all = [...first.events, ...events.events];
    expect(new Set(all.map((event: { eventId: string }) => event.eventId)).size).toBe(all.length);
    expect(all.at(-1).eventType).toBe('created');
    // Only one list continues per request; a cursor of another list or row is refused.
    const two = await w.get(`${OWNER}/transactions/${survivor}/sources?eventsCursor=${first.nextEventsCursor}&mergedRowsCursor=${first.nextMergedRowsCursor}`);
    expect(two.body).toEqual({ error: 'invalid-request', issues: [{ code: 'inconsistent', path: '$.eventsCursor' },
      { code: 'inconsistent', path: '$.mergedRowsCursor' }] });
    const crossed = await w.get(`${OWNER}/transactions/${survivor}/sources?identitiesCursor=${first.nextEventsCursor}`);
    expect(crossed.body).toEqual({ error: 'invalid-request', issues: [{ code: 'invalid-format', path: '$.identitiesCursor' }] });
    const elsewhere = await w.get(`${OWNER}/transactions/${others[101]}/sources?eventsCursor=${first.nextEventsCursor}`);
    expect(elsewhere.status).toBe(422);
  });

  it('continues the alias list after a position this server encoded', async () => {
    w.ingest(device, binding, [{ ...coffee(), secondary: [['chase-api:derived:v1', 'derived-1']] }]);
    const rowId = w.db.prepare('SELECT id FROM card_transactions').pluck().get() as string;
    const first = (await w.get(`${OWNER}/transactions/${rowId}/sources`)).body;
    expect(first.identities).toHaveLength(2);
    const codec = new CardSyncCursorCodec(OWNER_SERVICE_TOKEN);
    const after = first.identities[0];
    const cursor = codec.encode('identities', rowId, { createdAt: after.createdAt, identityId: after.identityId });
    const rest = (await w.get(`${OWNER}/transactions/${rowId}/sources?identitiesCursor=${cursor}`)).body;
    expect(rest.identities.map((i: { identityId: string }) => i.identityId)).toEqual([first.identities[1].identityId]);
    expect(rest.nextIdentitiesCursor).toBeNull();
  });
});

describe('runs and the sent payload (§5.4, §10 items 10, 25)', () => {
  it('lists runs with RunSummary, shows a run\'s results, and returns the exact sent bytes', async () => {
    const { receipt, payload, runId } = w.accept(device, binding, [coffee(), capture()]);
    const list = await w.get(`${OWNER}/runs?bindingId=${binding.bindingId}`);
    expect(list.body).toEqual({ runs: [expect.objectContaining({ runId, deviceLabel: 'Laptop Chrome', issuer: 'chase', source: 'chase-api',
      acceptance: 'needs-review', ledger: 'none', observationSetId: receipt.observationSetId, rowCount: 2, runState: 'accepted',
      errorCode: null, abortReason: null, trigger: 'manual' })], nextCursor: null });
    const run = await w.get(`${OWNER}/runs/${runId}`);
    expect(run.body).toMatchObject({ runId, receiptAvailable: true, contentRetained: true, rejectedCount: 0, counts: null,
      results: [{ rowIndex: 0, result: 'waiting', transactionId: null }, { rowIndex: 1, result: 'needs-review', transactionId: null }] });
    const sent = await w.get(`${OWNER}/runs/${runId}/payload`);
    expect(sent.status).toBe(200);
    const stored = w.db.prepare('SELECT canonical_json FROM card_sync_payload_receipts').pluck().get() as string;
    expect(sent.text).toBe(`{"runId":"${runId}","observationSetId":"${receipt.observationSetId}","payloadDigest":"${receipt.payloadDigest}",`
      + `"acceptedAt":"${w.now()}","receiptExpiresAt":"${run.body.receiptExpiresAt}","payload":${stored}}`);
    expect(sent.body.payload).toEqual(JSON.parse(JSON.stringify(payload)));
    // Discarding gives the receipt up: the payload route answers receipt-expired.
    await w.post(setPath(receipt.observationSetId, '/discard'), { expectedVersion: 1, reason: 'bad-data' });
    const gone = await w.get(`${OWNER}/runs/${runId}/payload`);
    expect([gone.status, gone.body]).toEqual([410, { error: 'receipt-expired' }]);
    expect((await w.get(`${OWNER}/runs/${runId}`)).body).toMatchObject({ acceptance: 'rejected', contentRetained: false, results: [],
      receiptAvailable: false });
    expect((await w.get(`${OWNER}/runs/run_${'d'.repeat(32)}`)).status).toBe(404);
    const filtered = await w.get(`${OWNER}/runs?bindingId=bnd_${'e'.repeat(32)}`);
    expect(filtered.body).toEqual({ runs: [], nextCursor: null });
  });

  it('keeps answering the sent bytes for a set its device\'s revocation quarantined (§10 item 25)', async () => {
    const { receipt, runId } = w.accept(device, binding, [coffee()]);
    w.repo.revokeCardSyncDevice({ deviceId: device.deviceId, reason: 'owner', actor: { kind: 'session', actorRef: w.owner }, ...w.step() });
    expect((await w.get(setPath(receipt.observationSetId))).body.state).toBe('blocked-review');
    const sent = await w.get(`${OWNER}/runs/${runId}/payload`);
    expect(sent.status).toBe(200);
    expect(sent.body.payloadDigest).toBe(receipt.payloadDigest);
  });

  it('answers a committed run with its plan\'s counts and each row\'s outcome', async () => {
    const setId = w.ingest(device, binding, [coffee(), market()]);
    const runId = w.db.prepare('SELECT run_id FROM card_sync_observation_sets WHERE id = ?').pluck().get(setId) as string;
    const ids = w.db.prepare('SELECT id FROM card_transactions ORDER BY transaction_date').pluck().all() as string[];
    const run = await w.get(`${OWNER}/runs/${runId}`);
    expect(run.body).toMatchObject({ acceptance: 'committed', ledger: 'committed', committedAt: w.now(),
      counts: expect.objectContaining({ insert: 2 }),
      results: [{ rowIndex: 0, result: 'inserted', transactionId: ids[0] }, { rowIndex: 1, result: 'inserted', transactionId: ids[1] }] });
  });
});

describe('ledger sources and repairs (§5.7.1, §10 items 11, 14, 18, 24)', () => {
  /** A committed row with two aliases (a primary id and a secondary one), its id. */
  function aliasedRow(): string {
    w.ingest(device, binding, [{ ...coffee(), secondary: [['chase-api:derived:v1', 'derived-1']] }]);
    return w.db.prepare('SELECT id FROM card_transactions').pluck().get() as string;
  }
  const sources = (id: string) => `${OWNER}/transactions/${id}/sources`;

  it('shows a row\'s aliases and history, and detaches an alias only after a recent password re-check', async () => {
    const rowId = aliasedRow();
    const read = await w.get(sources(rowId));
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      transaction: { transactionId: rowId, cardAccountRef: binding.cardAccountRef, revision: 1, removedReason: null, mergedIntoId: null },
      identities: [expect.objectContaining({ status: 'active', createdBy: 'session', namespaceKind: 'stable', scopeKind: 'known' }),
        expect.objectContaining({ status: 'active' })],
      nextIdentitiesCursor: null, mergedRows: [], nextMergedRowsCursor: null, revertibleEventId: null, nextEventsCursor: null,
    });
    expect(read.body.events.map((e: { eventType: string; actor: string; via: string }) => [e.eventType, e.actor, e.via]).sort())
      .toEqual([['created', 'owner', 'extension'], ['identity-linked', 'owner', 'extension']]);
    const identityId = read.body.identities[1].identityId as string;
    const detach = (body: unknown) => w.post(`${OWNER}/identities/${identityId}/detach`, body);
    w.tick(1);

    const unconfirmed = await detach({ transactionId: rowId, expectedRevision: 1 });
    expect([unconfirmed.status, unconfirmed.body]).toEqual([403, { error: 'recent-auth-required' }]);
    const wrongPassword = await w.reverify('not the password');
    expect([wrongPassword.status, wrongPassword.body]).toEqual([403, { error: 'unauthorized' }]);
    const confirmed = await w.reverify();
    expect(confirmed.body).toEqual({ verifiedUntil: new Date(w.clock + 5 * 60_000).toISOString() });

    const stale = await detach({ transactionId: rowId, expectedRevision: 2 });
    expect([stale.status, stale.body]).toEqual([409, { error: 'transaction-revision-stale' }]);
    const done = await detach({ transactionId: rowId, expectedRevision: 1 });
    expect(done.status).toBe(200);
    expect(done.body.identities.find((i: { identityId: string }) => i.identityId === identityId).status).toBe('detached');
    expect(done.body.events[0]).toMatchObject({ eventType: 'identity-detached', reason: 'maintenance', actor: 'owner', via: 'session',
      revision: 1, identityId });
    // The last active alias stays (identity-last-active → action-not-allowed); an inactive one is not detached twice.
    const last = await w.post(`${OWNER}/identities/${read.body.identities[0].identityId}/detach`, { transactionId: rowId, expectedRevision: 1 });
    expect([last.status, last.body]).toEqual([409, { error: 'action-not-allowed' }]);
    const twice = await detach({ transactionId: rowId, expectedRevision: 1 });
    expect([twice.status, twice.body]).toEqual([409, { error: 'action-not-allowed' }]);
    expect(w.db.prepare("SELECT count(*) FROM card_sync_audit_events WHERE event_type = 'ledger-maintenance'").pluck().get()).toBe(1);

    // Five minutes later the confirmation has lapsed.
    w.tick(5 * 60);
    const lapsed = await w.post(`${OWNER}/transactions/${rowId}/revert`, { eventId: `card-event-${'a'.repeat(32)}`, expectedRevision: 1 });
    expect([lapsed.status, lapsed.body]).toEqual([403, { error: 'recent-auth-required' }]);
  });

  it('re-points an alias to another row and answers the row it left; reverts and unmerges by the owner\'s revisions', async () => {
    const rowId = aliasedRow();
    w.ingest(device, binding, [market()]);
    const marketId = w.db.prepare("SELECT id FROM card_transactions WHERE description = 'CONTOSO MARKET'").pluck().get() as string;
    await w.reverify();
    const identityId = (await w.get(sources(rowId))).body.identities[1].identityId as string;
    w.tick(1);
    const moved = await w.post(`${OWNER}/identities/${identityId}/repoint`, { fromTransactionId: rowId, toTransactionId: marketId,
      expectedRevision: 1, expectedToRevision: 1 });
    expect(moved.status).toBe(200);
    expect(moved.body.transaction.transactionId).toBe(rowId);
    expect(moved.body.identities.map((i: { identityId: string }) => i.identityId)).not.toContain(identityId);
    // The alias that left shows in this row's history with no revision, naming the row it joined (X32).
    expect(moved.body.events[0]).toMatchObject({ eventType: 'identity-repointed', revision: null, relatedTransactionId: marketId,
      identityId });
    const there = await w.get(sources(marketId));
    expect(there.body.events[0]).toMatchObject({ eventType: 'identity-repointed', revision: 1, relatedTransactionId: rowId });

    // An owner's attribution is the row's revertible change; revert takes exactly that event.
    w.tick(1);
    const attributed = w.repo.attributeCardTransaction({ id: marketId, cardScopeId: known[1], expectedRevision: 1, actorRef: w.owner });
    const after = await w.get(sources(marketId));
    expect(after.body).toMatchObject({ transaction: { revision: attributed.revision }, revertibleEventId: expect.stringMatching(/^card-event-/) });
    const revert = (eventId: string, expectedRevision: number) => w.post(`${OWNER}/transactions/${marketId}/revert`, { eventId, expectedRevision });
    const other = await revert(after.body.events.find((e: { eventType: string }) => e.eventType === 'created').eventId, attributed.revision);
    expect([other.status, other.body]).toEqual([409, { error: 'action-not-allowed' }]);
    w.tick(1);
    const reverted = await revert(after.body.revertibleEventId, attributed.revision);
    expect(reverted.status).toBe(200);
    expect(reverted.body.transaction).toMatchObject({ revision: attributed.revision + 1, values: { cardScopeId: known[0] } });
    expect(reverted.body.events[0]).toMatchObject({ eventType: 'reversed', reason: 'maintenance', reversesEventId: after.body.revertibleEventId });

    const notMerged = await w.post(`${OWNER}/transactions/${rowId}/unmerge`, { expectedRevision: 1, expectedSurvivorRevision: 1 });
    expect([notMerged.status, notMerged.body]).toEqual([409, { error: 'merge-not-allowed' }]);
    const missing = await w.get(sources(`card-txn-${'f'.repeat(32)}`));
    expect([missing.status, missing.body]).toEqual([404, { error: 'transaction-not-found' }]);
  });

  it('unmerges a merged row, listing it among the survivor\'s merged rows until then', async () => {
    w.ingest(device, binding, [coffee(), { ...coffee(), id: 'sor-dup', description: 'FOURTH COFFEE DUP' }]);
    const [keep, lose] = w.db.prepare('SELECT id FROM card_transactions ORDER BY description').pluck().all() as string[];
    w.repo.mergeCardTransactions({ survivorId: keep, loserId: lose, reason: 'superseded', expectedRevisions: [1, 1],
      categoryFrom: 'survivor', notesFrom: 'survivor', actorRef: w.owner });
    const survivor = await w.get(sources(keep));
    expect(survivor.body.mergedRows).toEqual([expect.objectContaining({ transactionId: lose, mergedIntoId: keep, removedReason: 'superseded',
      values: expect.objectContaining({ status: 'removed' }) })]);
    await w.reverify();
    const loser = survivor.body.mergedRows[0];
    const res = await w.post(`${OWNER}/transactions/${lose}/unmerge`, { expectedRevision: loser.revision,
      expectedSurvivorRevision: survivor.body.transaction.revision });
    expect(res.status).toBe(200);
    expect(res.body.transaction).toMatchObject({ transactionId: lose, removedReason: null, mergedIntoId: null, values: { status: 'posted' } });
    expect((await w.get(sources(keep))).body.mergedRows).toEqual([]);
  });
});

describe('/auth/reverify (§10 item 11)', () => {
  it('answers 403 for a wrong password, throttles guessing, and ends with sign-out', async () => {
    const malformed = await w.post('/auth/reverify', { password: 'x', surplus: true });
    expect([malformed.status, malformed.body]).toEqual([400, { error: 'bad-request' }]);
    const service = await w.asService('post', '/auth/reverify', { password: 'x' });
    expect([service.status, service.body]).toEqual([403, { error: 'credential-not-allowed' }]);
    const anonymous = await (await w.http()).post('/auth/reverify').set('Origin', OWNER_ORIGIN).set('X-Holdr-Request', '1')
      .send({ password: 'x' });
    expect(anonymous.status).toBe(401);
    for (let i = 0; i < 5; i += 1) expect((await w.reverify(`guess ${i}`)).status).toBe(403);
    const throttled = await w.reverify();
    expect(throttled.status).toBe(429);
    expect(throttled.body).toEqual({ error: 'rate-limited', retryAfterSeconds: expect.any(Number) });
    expect(w.logs.join('\n')).not.toMatch(/guess/);
    w.tick(60);
    expect((await w.reverify()).status).toBe(200);
    await w.post('/auth/logout', {});
    w.cookie = await w.signIn();
    const signedAgain = await w.post(`${OWNER}/transactions/card-txn-${'a'.repeat(32)}/unmerge`, { expectedRevision: 1,
      expectedSurvivorRevision: 1 });
    expect([signedAgain.status, signedAgain.body]).toEqual([403, { error: 'recent-auth-required' }]);
  });
});

describe('strict bodies and value-free answers (§5.11)', () => {
  it('refuses unknown, missing and ill-typed keys, card data, other media types and oversized bodies, quoting nothing', async () => {
    const setId = w.accept(device, binding, [coffee()]).receipt.observationSetId;
    const plan = (body: unknown) => w.post(setPath(setId, '/plan'), body);
    expect((await plan({ expectedVersion: 1, sourceReviewed: false, surplus: 1 })).body)
      .toEqual({ error: 'invalid-request', issues: [{ code: 'unknown-key', path: '$.<key>' }] });
    expect((await plan({ expectedVersion: 1 })).body).toEqual({ error: 'invalid-request', issues: [{ code: 'missing-key', path: '$.sourceReviewed' }] });
    expect((await plan({ expectedVersion: '1', sourceReviewed: false })).body)
      .toEqual({ error: 'invalid-request', issues: [{ code: 'wrong-type', path: '$.expectedVersion' }] });
    expect((await plan({ expectedVersion: 0, sourceReviewed: false })).body)
      .toEqual({ error: 'invalid-request', issues: [{ code: 'out-of-range', path: '$.expectedVersion' }] });
    const canary = ['4111', '1111', '1111', '1111'].join('');
    const card = await w.post(setPath(setId, '/discard'), { expectedVersion: 1, reason: canary });
    expect(card.status).toBe(422);
    expect(card.body).toEqual({ error: 'invalid-request', issues: [{ code: 'card-data', path: '$.reason' }] });
    expect(JSON.stringify(card.body) + w.logs.join('\n')).not.toContain(canary);
    const text = await (await w.http()).post(setPath(setId, '/plan')).set('Cookie', w.cookie).set('Origin', OWNER_ORIGIN)
      .set('X-Holdr-Request', '1').set('Content-Type', 'text/plain').send('{}');
    expect([text.status, text.body]).toEqual([415, { error: 'unsupported-media-type' }]);
    const big = await w.post(setPath(setId, '/plan'), { expectedVersion: 1, sourceReviewed: false, pad: 'x'.repeat(70_000) });
    expect([big.status, big.body]).toEqual([413, { error: 'too-large' }]);
    const broken = await (await w.http()).post(setPath(setId, '/plan')).set('Cookie', w.cookie).set('Origin', OWNER_ORIGIN)
      .set('X-Holdr-Request', '1').set('Content-Type', 'application/json').send('{"expectedVersion": 1,');
    expect([broken.status, broken.body]).toEqual([400, { error: 'bad-request' }]);
    const query = await w.get(`${OWNER}/observation-sets?view=open&limit=5`);
    expect([query.status, query.body]).toEqual([422, { error: 'invalid-request', issues: [{ code: 'unknown-key', path: '$.<key>' }] }]);
    const twice = await w.get(`${OWNER}/observation-sets?view=open&view=closed`);
    expect(twice.body).toEqual({ error: 'invalid-request', issues: [{ code: 'wrong-type', path: '$.view' }] });
    expect((await w.get(`${OWNER}/observation-sets/obs_NOT-AN-ID`)).status).toBe(404);
    expect(w.setVersion(setId)).toBe(1);
  });
});
