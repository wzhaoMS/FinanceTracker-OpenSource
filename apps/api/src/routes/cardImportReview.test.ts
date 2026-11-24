import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCardImportPayload, serializeCardImportPayload, type CardImportDraftRow } from '@finance-tracker/shared';

import { CardSyncScenario, SCENARIO_OWNER, type ScenarioDevice, type ScenarioRow } from '../testing/cardSyncScenario.js';
import { listenLoopback } from '../testing/loopback.js';
import type { CardSourceBindingView } from '../services/sqliteStateRepo.js';
import { exceptCardSpendingPaths, mountCardSpendingRoutes } from './cardSpending.js';

// E2d, the v1 route (E1b design §10 item 7, §4.10.4): the route previews for the complete lists its decisions answer,
// the repository decides inside its transaction, and the answers keep Phase 4's contract: the same 409 bodies (with
// the rows the transaction found), 200 for nothing new, 201 with heldCount and reviewCount. Held rows are worded as
// held for review, never as skipped or rejected.

let w: CardSyncScenario;
let binding: CardSourceBindingView;
let device: ScenarioDevice;
let known: string[];
let app: express.Express;
let logs: string[];

beforeEach(() => {
  w = new CardSyncScenario();
  w.enable('chase');
  binding = w.binding();
  device = w.device([binding.bindingId]);
  ({ known } = w.scopes(binding));
  logs = [];
  app = express();
  app.use(exceptCardSpendingPaths(express.json({ limit: '2mb' })));
  mountCardSpendingRoutes(app, { repo: w.repo, requireAuth: (_req, _res, next) => next(), log: (line) => logs.push(line) });
});

afterEach(() => {
  vi.restoreAllMocks();
  w.close();
});

const count = (sql: string, ...params: unknown[]) => w.db.prepare(sql).pluck().get(...params) as number;
/** A purchase the extension synced and the owner committed: by default 12.50 at Fourth Coffee on Oct 1; its row's id. */
function synced(row: Partial<ScenarioRow> = {}): string {
  w.ingest(device, binding, [{ scope: known[0], date: '2026-10-01', amount: 1250, description: 'FOURTH COFFEE', merchant: 'Fourth Coffee',
    id: 'sor-1', ...row }]);
  return w.db.prepare('SELECT id FROM card_transactions WHERE first_sync_run_id IS NOT NULL ORDER BY rowid DESC').pluck().get() as string;
}
/** The owner decides a file set's only item and commits its plan, as the owner routes do (refreshed first). */
function decideAndCommit(setId: string, action: string, transactionId: string | null = null) {
  const owner = { kind: 'session' as const, actorRef: SCENARIO_OWNER };
  const version = () => count('SELECT version FROM card_sync_observation_sets WHERE id = ?', setId);
  w.repo.refreshCardReviewItems({ setId });
  const [item] = w.repo.getCardSyncObservationSetPage({ setId, after: null, limit: 10 })!.items;
  w.repo.recordCardReviewDecisions({ setId, expectedVersion: version(), actorRef: SCENARIO_OWNER,
    decisions: [{ itemId: item.itemId, action: action as never, transactionId, cardScopeId: null }] });
  const plan = w.repo.prepareCardSyncPlan({ principal: owner, setId, expectedVersion: version() });
  if (plan.status !== 'executable') throw new Error(`expected an executable plan, got ${plan.status}`);
  w.repo.commitCardSyncPlan({ principal: owner, previewId: plan.previewId, payloadDigest: null, planDigest: plan.planDigest });
}
const draft = (over: Partial<CardImportDraftRow> = {}): CardImportDraftRow => ({ transactionDate: '2026-10-02', postedDate: '2026-10-02',
  amountMinor: 1250, kind: 'purchase', description: 'FOURTH COFFEE STORE', externalId: 'csv-ref-1', ...over });
const body = (rows: CardImportDraftRow[], coverage = { start: '2026-09-01', end: '2026-10-31' }) => serializeCardImportPayload(
  buildCardImportPayload({ source: 'chase-csv', parserVersion: 'holdr-card-import@1.0.0', issuer: 'chase', currency: 'USD', rows, coverage }).payload);
const post = async (route: 'preview' | 'commit', json: string, query = '') => request(await listenLoopback(app))
  .post(`/card-imports/${route}?cardAccountId=${binding.cardAccountRef}${query}`).set('Content-Type', 'application/json').send(json);

describe('held rows over HTTP', () => {
  it('previews the reviewer\'s row as held for review, commits it as held (201), and answers the same file 200 nothing new', async () => {
    synced();
    const json = body([draft()]);
    const preview = await post('preview', json);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ newCount: 0, duplicateCount: 0, heldCount: 1, heldRows: [0], reviewCount: 1, reviewRows: [],
      previewDigest: expect.stringMatching(/^ipv1:[a-p]{64}$/) });
    const held = preview.body.warnings.find((warning: { code: string }) => warning.code === 'held-for-review');
    expect(held.message).toMatch(/held for review, not imported/);
    expect(held.message).not.toMatch(/skip|reject/i);

    const commit = await post('commit', json);
    expect(commit.status).toBe(201);
    expect(commit.body).toMatchObject({ imported: true, newCount: 0, duplicateCount: 0, heldCount: 1, reviewCount: 1,
      batch: { newCount: 0, rejectedCount: 1 } });
    expect(logs.at(-1)).toMatch(/: 0 new, 0 duplicate, 0 rejected, 1 held for review, 1 review items, 0 pending posted$/);
    expect(count('SELECT count(*) FROM card_transactions')).toBe(1);

    const again = await post('commit', json);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ imported: false, batch: null, newCount: 0, heldCount: 0 });
  });

  it('commits an echoed previewDigest while nothing changed, and answers 409 once the ledger moved (E2d review r1, finding 1)', async () => {
    synced();
    const json = body([draft()]);
    const first = (await post('preview', json)).body.previewDigest as string;
    // Any change to the ledger since the preview makes its digest stale, even one that leaves this file's rows alone.
    const other = body([draft({ amountMinor: 990, externalId: 'csv-ref-2', description: 'NORTHWIND' })]);
    const before = (await post('preview', other)).body.previewDigest as string;
    synced({ id: 'sor-2', amount: 4200, description: 'NORTHWIND TRADERS', merchant: null });
    const stale = await post('commit', other, `&previewDigest=${before}`);
    expect([stale.status, stale.body.error]).toEqual([409, 'the card ledger changed since this preview; preview the import again']);
    expect(stale.body.previewDigest).toMatch(/^ipv1:[a-p]{64}$/);
    expect(stale.body.previewDigest).not.toBe(before);
    expect(count("SELECT count(*) FROM card_sync_observation_sets WHERE origin = 'file'")).toBe(0);
    expect((await post('commit', json, `&previewDigest=${first}`)).status).toBe(409);
    const fresh = (await post('preview', json)).body.previewDigest as string;
    expect((await post('commit', json, `&previewDigest=${fresh}`)).status).toBe(201);
    expect((await post('commit', json, '&previewDigest=pd1:abc')).body).toEqual({ error: 'previewDigest is invalid' });
  });
});

describe('decisions inside the transaction (§4.10.4, finding 11)', () => {
  it('asks again when a candidate appears between the route\'s preview and its transaction (A17), and imports on the answer', async () => {
    const json = body([draft({ externalId: 'new-1', description: 'CONTOSO MARKET' })]);
    const original = w.repo.commitCardImport.bind(w.repo);
    vi.spyOn(w.repo, 'commitCardImport').mockImplementationOnce((input) => {
      // Another import commits the same purchase under another reference meanwhile.
      w.repo.importCardTransactions({ cardAccountId: binding.cardAccountRef, source: 'chase-csv', parserVersion: 'holdr-card-import@1.0.0',
        actorRef: SCENARIO_OWNER, rows: [{ externalIdHash: null, transactionDate: '2026-10-02', postedDate: '2026-10-02', status: 'posted',
          currency: 'USD', amountMinor: 1250, kind: 'purchase', description: 'CONTOSO MARKET' }] });
      return original(input);
    });
    const raced = await post('commit', json);
    expect(raced.status).toBe(409);
    expect(raced.body).toEqual({ error: 'some new rows look like rows already stored; commit with possibleDuplicates=skip or possibleDuplicates=import',
      possibleDuplicateCount: 1, possibleDuplicateRows: [0] });
    expect(count('SELECT count(*) FROM card_import_batches')).toBe(1);
    const retried = await post('commit', json, '&possibleDuplicates=import');
    expect(retried.status).toBe(201);
    expect(retried.body).toMatchObject({ newCount: 1, skippedPossibleDuplicates: 0 });
  });

  it('answers complete lists past 100 possible duplicates (A20) and skips exactly them, counted as Phase 4 counts them (A18)', async () => {
    const stored = Array.from({ length: 120 }, (_, i) => draft({ externalId: `old-${i}`, amountMinor: 2000 + i, description: `SHOP ${i}` }));
    expect((await post('commit', body(stored))).status).toBe(201);
    const again = [...Array.from({ length: 120 }, (_, i) => draft({ externalId: `new-${i}`, amountMinor: 2000 + i, description: `SHOP ${i}` })),
      draft({ externalId: 'fresh', amountMinor: 99_999, description: 'ADVENTURE WORKS' })];
    const preview = (await post('preview', body(again))).body;
    expect(preview).toMatchObject({ possibleDuplicateCount: 120, heldCount: 0, reviewCount: 0 });
    expect(preview.possibleDuplicateRows).toHaveLength(100);
    const skipped = await post('commit', body(again), '&possibleDuplicates=skip');
    expect(skipped.status).toBe(201);
    expect(skipped.body).toMatchObject({ skippedPossibleDuplicates: 120, newCount: 1, duplicateCount: 0, heldCount: 0, reviewCount: 0,
      batch: { rowCount: 121, newCount: 1, duplicateCount: 0, rejectedCount: 120 } });
    expect(count('SELECT count(*) FROM card_transactions')).toBe(121);
  });

  it('answers a stale-pending list that changed meanwhile with 409 and its rows', async () => {
    const statement = body([draft({ externalId: 'p-ok', transactionDate: '2026-09-02', postedDate: '2026-09-03' })]);
    expect((await post('commit', body([draft({ externalId: 'hold-1', status: 'pending', postedDate: null, transactionDate: '2026-09-05',
      amountMinor: 700, description: 'HOLD ONE' })]))).status).toBe(201);
    const original = w.repo.commitCardImport.bind(w.repo);
    vi.spyOn(w.repo, 'commitCardImport').mockImplementationOnce((input) => {
      w.repo.importCardTransactions({ cardAccountId: binding.cardAccountRef, source: 'chase-csv', parserVersion: 'holdr-card-import@1.0.0',
        actorRef: SCENARIO_OWNER, rows: [{ externalIdHash: null, transactionDate: '2026-09-06', postedDate: null, status: 'pending',
          currency: 'USD', amountMinor: 800, kind: 'purchase', description: 'HOLD TWO' }] });
      return original(input);
    });
    const changed = await post('commit', statement, '&stalePending=dismiss');
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({ error: 'the stale pending rows changed since this preview; preview the import again',
      stalePendingCount: 2 });
    expect(count('SELECT count(*) FROM card_transactions WHERE dismissed_at IS NOT NULL')).toBe(0);
    const retried = await post('commit', statement, '&stalePending=dismiss');
    expect(retried.status).toBe(201);
    expect(retried.body).toMatchObject({ newCount: 1, stalePendingDismissedCount: 2 });
    expect(count('SELECT count(*) FROM card_transactions WHERE dismissed_at IS NOT NULL')).toBe(2);
  });
});

describe('a covered file whose only news is a mixed-source conflict (A16, E-Q7)', () => {
  it('stores a batch of zero new rows and one item (201), then answers the same request 200', async () => {
    const row = synced();
    await post('commit', body([draft()]));
    const setId = w.db.prepare("SELECT id FROM card_sync_observation_sets WHERE origin = 'file'").pluck().get() as string;
    decideAndCommit(setId, 'same-transaction', row);
    const regenerated = body([draft({ description: 'FOURTH COFFEE STORE #12' })]);
    const first = await post('commit', regenerated);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ imported: true, newCount: 0, duplicateCount: 1, reviewCount: 1, heldCount: 0, reviewRows: [0] });
    const second = await post('commit', regenerated);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ imported: false, reviewCount: 0 });
  });
});
