import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCardImportPayload, type CardImportDraftRow } from '@finance-tracker/shared';

import { CardSyncOwnerWorld } from '../testing/cardSyncOwnerWorld.js';
import type { ScenarioRow } from '../testing/cardSyncScenario.js';
import type { CardSourceBindingView } from '../services/sqliteStateRepo.js';

// E2d review r1 (GPT-6 Astra 6b74c682): the reviewer's counterexamples, through the real app (v1 routes and owner
// routes), as regressions. Findings 1 (the preview digest binds the import), 2 (a promotion a synced posted row may
// already be waits for the owner), 3 (E-Q7 for file-only rows; E2d-D1 rejected), 4 (a detached key comes back to the
// owner), 6 (two keys of one pending row), 7 (file positions) and 9 (a commit reports what it did).

let w: CardSyncOwnerWorld;
let binding: CardSourceBindingView;
let device: ReturnType<CardSyncOwnerWorld['device']>;
let scope: string;
const root = '/card-sync/owner';
const sets = `${root}/observation-sets`;

beforeEach(async () => {
  w = await CardSyncOwnerWorld.create();
  w.enable();
  binding = w.binding();
  device = w.device([binding.bindingId]);
  scope = w.scopes(binding).known[0];
});
afterEach(() => w.close());

function draft(patch: Partial<CardImportDraftRow> = {}): CardImportDraftRow {
  return { externalId: 'csv-probe-a', transactionDate: '2026-10-02', postedDate: '2026-10-02', amountMinor: 1250, kind: 'purchase',
    description: 'SYNTHETIC FILE COFFEE', ...patch };
}
const payload = (rows: CardImportDraftRow[]) => buildCardImportPayload({ source: 'chase-csv', parserVersion: 'review@1.0.0', issuer: 'chase',
  currency: 'USD', coverage: { start: '2026-09-01', end: '2026-10-31' }, rows }).payload;
const v1 = (op: 'preview' | 'commit', rows: CardImportDraftRow[], query = '', account = binding.cardAccountRef) =>
  w.post(`/card-imports/${op}?cardAccountId=${account}${query}`, payload(rows));
const allRows = () => w.db.prepare('SELECT id, status, amount_minor, description, revision FROM card_transactions ORDER BY rowid').all() as
  Array<{ id: string; status: string; amount_minor: number; description: string; revision: number }>;
const posted = () => allRows().filter((row) => row.status === 'posted');
const openItems = () => w.db.prepare("SELECT count(*) FROM card_reconciliation_suggestions WHERE status = 'open'").pluck().get();
const lastFileSet = () => w.db.prepare("SELECT id FROM card_sync_observation_sets WHERE origin = 'file' ORDER BY rowid DESC LIMIT 1")
  .pluck().get() as string;
function synced(patch: Partial<ScenarioRow> = {}): string {
  w.ingest(device, binding, [{ scope, id: 'browser-probe-a', date: '2026-10-01', amount: 1250, description: 'SYNTHETIC BROWSER COFFEE',
    ...patch }]);
  return allRows().at(-1)!.id;
}
/** The owner decides a set's first item through the owner routes and commits the plan; refusals come back as they are. */
async function decide(setId: string, action: string, transactionId: string | null = null, cardScopeId: string | null = null) {
  const detail = await w.get(`${sets}/${setId}`);
  expect(detail.status, JSON.stringify(detail.body)).toBe(200);
  const item = detail.body.items[0];
  const recorded = await w.post(`${sets}/${setId}/decisions`, { expectedVersion: detail.body.version,
    decisions: [{ itemId: item.itemId, action, transactionId, cardScopeId }] });
  if (recorded.status !== 200) return { detail: detail.body, recorded };
  const plan = await w.post(`${sets}/${setId}/plan`, { expectedVersion: recorded.body.version, sourceReviewed: false });
  expect(plan.status, JSON.stringify(plan.body)).toBe(200);
  const result = await w.post(`${root}/plans/${plan.body.previewId}/commit`, { planDigest: plan.body.planDigest,
    payloadDigest: plan.body.payloadDigest });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return { detail: detail.body, recorded, plan: plan.body, result: result.body };
}
const fileIdentity = (rowId: string) => w.db.prepare(`SELECT id FROM card_source_identities WHERE canonical_transaction_id = ?
  AND namespace_kind = 'legacy-file'`).pluck().get(rowId) as string;

describe('finding 3: E-Q7 for every stored key, file-only rows included (E2d-D1 rejected; A16)', () => {
  it.each([
    { label: 'new text', change: { description: 'SYNTHETIC CORRECTED FILE TEXT' }, conflictCount: 0 },
    { label: 'new text and amount', change: { description: 'SYNTHETIC CORRECTED FILE TEXT', amountMinor: 1777 }, conflictCount: 1 },
  ])('asks once about a covered file-only row with $label: 201 with one item, then 200, the ledger untouched', async ({ change, conflictCount }) => {
    expect((await v1('commit', [draft()])).status).toBe(201);
    const changed = [draft(change)];
    const preview = (await v1('preview', changed)).body;
    expect(preview).toMatchObject({ reviewCount: 1, reviewRows: [0], conflictCount, heldCount: 0 });
    expect(preview.warnings.map((warning: { code: string }) => warning.code)).toContain('sync-review');
    const first = await v1('commit', changed);
    expect([first.status, first.body.imported, first.body.reviewCount, first.body.duplicateCount, openItems()]).toEqual([201, true, 1, 1, 1]);
    expect(first.body.batch).toMatchObject({ newCount: 0, duplicateCount: 1, rejectedCount: 0 });
    const again = await v1('commit', changed);
    expect([again.status, again.body.reviewCount, openItems()]).toEqual([200, 0, 1]);
    expect(allRows()).toEqual([expect.objectContaining({ amount_minor: 1250, description: 'SYNTHETIC FILE COFFEE' })]);
    // The item is the design's posted-correction: accepting it writes the file's values; the replay then asks nothing.
    const item = (await w.get(`${sets}/${lastFileSet()}`)).body.items[0];
    expect(item).toMatchObject({ reason: 'posted-correction', allowedActions: ['accept-correction', 'keep-current'], rowIndex: 0 });
    await decide(lastFileSet(), 'accept-correction');
    expect(allRows()).toEqual([expect.objectContaining({ amount_minor: change.amountMinor ?? 1250, description: change.description })]);
    expect((await v1('commit', changed)).status).toBe(200);
  });

  it('keeps a pending file row of a posted row, a dismissed row and a repeated key Phase 4\'s duplicates (no item)', async () => {
    expect((await v1('commit', [draft(), draft({ externalId: 'csv-hold', status: 'pending', postedDate: null, amountMinor: 700,
      description: 'SYNTHETIC HOLD' })])).status).toBe(201);
    const hold = allRows()[1].id;
    expect((await w.patch(`/card-transactions/${hold}`, { status: 'removed' })).status).toBe(200);
    const rows = [draft({ status: 'pending', postedDate: null, description: 'SYNTHETIC FILE COFFEE PENDING' }),
      draft({ externalId: 'csv-hold', status: 'pending', postedDate: null, amountMinor: 700, description: 'SYNTHETIC HOLD NEW TEXT' })];
    const result = await v1('commit', rows);
    expect([result.status, result.body.reviewCount, openItems()]).toEqual([200, 0, 0]);
  });
});

describe('finding 1: previewDigest binds the account, the payload and the ledger it was read from', () => {
  it('refuses an echoed digest after the pending row its promotion targets was re-pointed (the reviewer\'s repro)', async () => {
    const first = synced({ status: 'pending', posted: null });
    const second = synced({ id: 'browser-probe-b', status: 'pending', posted: null, amount: 5000, description: 'SYNTHETIC OTHER HOLD' });
    expect((await v1('commit', [draft({ status: 'pending', postedDate: null })])).body.heldCount).toBe(1);
    await decide(lastFileSet(), 'same-transaction', first);
    const posting = [draft({ amountMinor: 1500, description: 'SYNTHETIC POSTED COFFEE' }),
      draft({ externalId: 'csv-still-open', status: 'pending', postedDate: null, amountMinor: 7777, description: 'SYNTHETIC UNRELATED' })];
    const before = (await v1('preview', posting)).body;
    expect(before.pendingPostedCount).toBe(1);
    expect((await w.reverify()).status).toBe(200);
    const [from, to] = allRows();
    expect((await w.post(`${root}/identities/${fileIdentity(first)}/repoint`, { fromTransactionId: first, toTransactionId: second,
      expectedRevision: from.revision, expectedToRevision: to.revision })).status).toBe(200);
    const result = await v1('commit', posting, `&previewDigest=${before.previewDigest}`);
    expect([result.status, result.body.error]).toEqual([409, 'the card ledger changed since this preview; preview the import again']);
    expect(allRows().filter((row) => row.status === 'posted')).toHaveLength(0);
  });

  it('refuses another account\'s or another payload\'s digest, and commits one that still matches', async () => {
    const digest = (await v1('preview', [draft()])).body.previewDigest as string;
    const other = w.account();
    const changed = [draft({ externalId: 'csv-unseen-b', amountMinor: 9550, description: 'SYNTHETIC DIFFERENT PURCHASE' })];
    expect((await v1('commit', changed, `&previewDigest=${digest}`, other)).status).toBe(409);
    expect((await v1('commit', changed, `&previewDigest=${digest}`)).status).toBe(409);
    expect((await v1('commit', [draft()], `&previewDigest=${digest}`, other)).status).toBe(409);
    expect(allRows()).toHaveLength(0);
    expect((await v1('commit', [draft()], `&previewDigest=${digest}`)).status).toBe(201);
  });
});

describe('finding 2: a promotion that a synced posted row may already be waits for the owner', () => {
  it('holds an amount-changed pending CSV row\'s posted version near a browser\'s posted row (the reviewer\'s repro)', async () => {
    expect((await v1('commit', [draft({ status: 'pending', postedDate: null })])).body.newCount).toBe(1);
    const pending = allRows()[0].id;
    const browser = synced({ amount: 1500, description: 'SYNTHETIC COFFEE WITH TIP' });
    const final = [draft({ amountMinor: 1500, description: 'SYNTHETIC COFFEE WITH TIP' })];
    const preview = (await v1('preview', final)).body;
    expect(preview).toMatchObject({ pendingPostedCount: 0, heldCount: 1, heldRows: [0] });
    const result = await v1('commit', final);
    expect(result.body).toMatchObject({ imported: true, pendingPostedCount: 0, heldCount: 1, reviewCount: 1, heldRows: [0],
      batch: { newCount: 0, duplicateCount: 0, rejectedCount: 1 } });
    expect(posted()).toEqual([expect.objectContaining({ id: browser })]);
    const item = (await w.get(`${sets}/${lastFileSet()}`)).body.items[0];
    expect(item).toMatchObject({ reason: 'cross-source-similar', allowedActions: ['same-transaction', 'reject-row'] });
    expect(item.candidates.map((candidate: { transactionId: string }) => candidate.transactionId)).toEqual([pending, browser]);
    // The browser's row cannot take the file's key (it belongs to the pending row): refused, nothing written.
    const refused = await decide(lastFileSet(), 'same-transaction', browser);
    expect([refused.recorded.status, refused.recorded.body]).toEqual([409, { error: 'action-not-allowed' }]);
    // The owner says it is the pending row's posted version, another purchase than the browser's: it posts.
    await decide(lastFileSet(), 'same-transaction', pending);
    expect(posted().map((row) => row.id).sort()).toEqual([browser, pending].sort());
  });

  it('leaves the pending row as it is when the owner rejects the file row, and posts by reference with nothing near', async () => {
    expect((await v1('commit', [draft({ status: 'pending', postedDate: null })])).status).toBe(201);
    synced({ amount: 1500, description: 'SYNTHETIC COFFEE WITH TIP' });
    await v1('commit', [draft({ amountMinor: 1500, description: 'SYNTHETIC COFFEE WITH TIP' })]);
    await decide(lastFileSet(), 'reject-row');
    expect(allRows()[0]).toMatchObject({ status: 'pending', amount_minor: 1250 });
    // Another pending row with no synced posted row near its final values posts by itself, as in Phase 4.
    expect((await v1('commit', [draft({ externalId: 'csv-quiet', status: 'pending', postedDate: null, amountMinor: 333,
      description: 'SYNTHETIC QUIET' })])).status).toBe(201);
    const quiet = await v1('commit', [draft({ externalId: 'csv-quiet', amountMinor: 333, description: 'SYNTHETIC QUIET' })]);
    expect(quiet.body).toMatchObject({ pendingPostedCount: 1, heldCount: 0 });
  });
});

describe('finding 4: a detached key comes back to the owner as detached-identity, not as a duplicate', () => {
  it('opens an item for the replay after the owner detached the file\'s key, and re-activates it on the owner\'s word', async () => {
    const target = synced();
    expect((await v1('commit', [draft()])).body.heldCount).toBe(1);
    await decide(lastFileSet(), 'same-transaction', target);
    expect((await w.reverify()).status).toBe(200);
    expect((await w.post(`${root}/identities/${fileIdentity(target)}/detach`, { transactionId: target,
      expectedRevision: allRows()[0].revision })).status).toBe(200);
    const result = await v1('commit', [draft()]);
    expect([result.status, result.body.reviewCount, result.body.duplicateCount, result.body.reviewRows, openItems()])
      .toEqual([201, 1, 1, [0], 1]);
    const item = (await w.get(`${sets}/${lastFileSet()}`)).body.items[0];
    expect(item).toMatchObject({ reason: 'detached-identity', candidates: [expect.objectContaining({ transactionId: target })] });
    expect((await v1('commit', [draft()])).status).toBe(200);
    // The owner says it is that row after all: the same tuple is re-activated, no second key and no second row.
    await decide(lastFileSet(), 'same-transaction', target);
    expect(w.db.prepare("SELECT status FROM card_source_identities WHERE namespace_kind = 'legacy-file'").pluck().all()).toEqual(['active']);
    expect(allRows()).toHaveLength(1);
  });
});

describe('finding 6: two keys of one pending row post it once', () => {
  it('posts the pending row once for two aliases with the same values, imports the rest of the file, and remembers both', async () => {
    const target = synced({ status: 'pending', posted: null });
    for (const externalId of ['csv-alias-a', 'csv-alias-b']) {
      expect((await v1('commit', [draft({ externalId, status: 'pending', postedDate: null })])).body.heldCount).toBe(1);
      await decide(lastFileSet(), 'same-transaction', target);
    }
    const rows = [draft({ externalId: 'csv-alias-a' }), draft({ externalId: 'csv-alias-b' }),
      draft({ externalId: 'csv-new-unrelated', amountMinor: 9900, description: 'SYNTHETIC NEW PURCHASE' })];
    expect((await v1('preview', rows)).body).toMatchObject({ pendingPostedCount: 1, reviewCount: 0 });
    const result = await v1('commit', rows);
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ pendingPostedCount: 1, reviewCount: 0, batch: { newCount: 1, duplicateCount: 2 } });
    expect(posted().map((row) => row.amount_minor).sort()).toEqual([1250, 9900]);
    expect((await v1('commit', rows)).status).toBe(200);
  });

  it('asks about a second key of the row with other values, against the row as the first key leaves it', async () => {
    const target = synced({ status: 'pending', posted: null });
    for (const externalId of ['csv-alias-a', 'csv-alias-b']) {
      await v1('commit', [draft({ externalId, status: 'pending', postedDate: null })]);
      await decide(lastFileSet(), 'same-transaction', target);
    }
    const result = await v1('commit', [draft({ externalId: 'csv-alias-a' }), draft({ externalId: 'csv-alias-b', amountMinor: 1260,
      description: 'SYNTHETIC OTHER VALUES' })]);
    expect(result.body).toMatchObject({ pendingPostedCount: 1, reviewCount: 1, reviewRows: [1] });
    expect(allRows()).toEqual([expect.objectContaining({ id: target, status: 'posted', amount_minor: 1250 })]);
    const item = (await w.get(`${sets}/${lastFileSet()}`)).body.items[0];
    expect(item).toMatchObject({ reason: 'posted-correction', rowIndex: 1 });
  });
});

describe('finding 7: a file row keeps its position in the file, whatever the import leaves out', () => {
  it('shows the held row\'s position in its item, its observation and its effect, and stores it after a skipped row', async () => {
    synced();
    const result = await v1('commit', [draft({ externalId: 'file-unrelated', amountMinor: 8888, description: 'SYNTHETIC UNRELATED' }), draft()]);
    expect([result.status, result.body.heldRows]).toEqual([201, [1]]);
    const detail = (await w.get(`${sets}/${lastFileSet()}`)).body;
    expect([detail.items[0].rowIndex, detail.items[0].observation.rowIndex]).toEqual([1, 1]);
    const decided = await decide(lastFileSet(), 'insert-new');
    expect(decided.plan!.effects[0].rowIndex).toBe(1);

    const skipped = await v1('commit', [
      draft({ externalId: 'file-skipped', amountMinor: 8888, description: 'SYNTHETIC UNRELATED' }),
      draft({ externalId: 'file-held-row-one', transactionDate: '2026-10-03', postedDate: '2026-10-03' }),
    ], '&possibleDuplicates=skip');
    expect([skipped.status, skipped.body.heldRows, skipped.body.skippedPossibleDuplicates]).toEqual([201, [1], 1]);
    expect(w.db.prepare('SELECT ordinal, file_row_index FROM card_source_observations WHERE observation_set_id = ?').get(lastFileSet()))
      .toEqual({ ordinal: 0, file_row_index: 1 });
  });
});

describe('finding 9: a commit answers what it did once the owner\'s decisions applied', () => {
  it('reports a pendingMatches=import row that was held as held, not inserted, with its position and warning', async () => {
    const pending = draft({ externalId: undefined, status: 'pending', postedDate: null });
    expect((await v1('commit', [pending])).body.newCount).toBe(1);
    const browser = w.accept(device, binding, [{ scope, id: 'browser-distinct-purchase', date: '2026-10-01', amount: 1250,
      description: 'SYNTHETIC BROWSER DISTINCT' }]);
    await decide(browser.receipt.observationSetId, 'insert-new');
    const result = await v1('commit', [{ ...pending, status: 'posted', postedDate: '2026-10-02' }], '&pendingMatches=import');
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ newCount: 0, heldCount: 1, reviewCount: 1, pendingMatchesInsertedCount: 0, heldRows: [0],
      batch: { newCount: 0, rejectedCount: 1 } });
    expect(result.body.warnings.map((warning: { code: string }) => warning.code)).toContain('held-for-review');
    expect(allRows()).toHaveLength(2);
  });
});
