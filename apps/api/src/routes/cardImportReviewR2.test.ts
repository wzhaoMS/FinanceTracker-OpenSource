import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCardImportPayload, type CardImportDraftRow } from '@finance-tracker/shared';

import { CardSyncOwnerWorld } from '../testing/cardSyncOwnerWorld.js';
import type { ScenarioRow } from '../testing/cardSyncScenario.js';
import type { CardSourceBindingView } from '../services/sqliteStateRepo.js';

// E2d review r2 (GPT-6 Astra 6b74c682 at 87c0608): the reviewer's counterexamples through the real app (v1 routes and
// owner routes), as regressions. Finding 1: a posted rival must be searched as such, so pending rows ranked above it
// never hide it. Finding 2 (D16 rejected): reviving a row dismissed while pending is no proof it is another purchase
// than a synced posted row; it is held for review like any other posting.

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

/** The reviewer's file row: a reference, posted at 1,500 on October 2. */
function draft(patch: Partial<CardImportDraftRow> = {}): CardImportDraftRow {
  return { externalId: 'r2-file-ref', transactionDate: '2026-10-02', postedDate: '2026-10-02', status: 'posted', amountMinor: 1500,
    kind: 'purchase', description: 'SYNTHETIC FINAL SALE', ...patch };
}
const pendingOf = (row: CardImportDraftRow): CardImportDraftRow => ({ ...row, status: 'pending', postedDate: null });
const payload = (rows: CardImportDraftRow[]) => buildCardImportPayload({ source: 'chase-csv', parserVersion: 'review-r2@1.0.0',
  issuer: 'chase', currency: 'USD', coverage: { start: '2026-09-01', end: '2026-10-31' }, rows }).payload;
const v1 = (op: 'preview' | 'commit', rows: CardImportDraftRow[], query = '') =>
  w.post(`/card-imports/${op}?cardAccountId=${binding.cardAccountRef}${query}`, payload(rows));
const allRows = () => w.db.prepare('SELECT id, status, removed_reason, amount_minor, description FROM card_transactions ORDER BY rowid')
  .all() as Array<{ id: string; status: string; removed_reason: string | null; amount_minor: number; description: string }>;
const posted = () => allRows().filter((row) => row.status === 'posted');
const lastFileSet = () => w.db.prepare("SELECT id FROM card_sync_observation_sets WHERE origin = 'file' ORDER BY rowid DESC LIMIT 1")
  .pluck().get() as string;
const browser = (rows: Array<Partial<ScenarioRow> & { id: string }>) => {
  w.ingest(device, binding, rows.map((row) => ({ scope, date: '2026-10-01', amount: 1500, description: 'SYNTHETIC POSTED BANK SPELLING',
    ...row })));
  return w.db.prepare('SELECT id FROM card_transactions ORDER BY rowid DESC LIMIT ?').pluck().all(rows.length).reverse() as string[];
};
/** The owner decides the set's first item through the owner routes and commits; a refusal comes back as it is. */
async function decide(setId: string, action: string, transactionId: string | null = null) {
  const detail = await w.get(`${sets}/${setId}`);
  expect(detail.status, JSON.stringify(detail.body)).toBe(200);
  const recorded = await w.post(`${sets}/${setId}/decisions`, { expectedVersion: detail.body.version,
    decisions: [{ itemId: detail.body.items[0].itemId, action, transactionId, cardScopeId: null }] });
  if (recorded.status !== 200) return { recorded };
  const plan = await w.post(`${sets}/${setId}/plan`, { expectedVersion: recorded.body.version, sourceReviewed: false });
  expect(plan.status, JSON.stringify(plan.body)).toBe(200);
  const result = await w.post(`${root}/plans/${plan.body.previewId}/commit`, { planDigest: plan.body.planDigest,
    payloadDigest: plan.body.payloadDigest });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return { recorded, result: result.body };
}
async function heldItem() {
  const item = (await w.get(`${sets}/${lastFileSet()}`)).body.items[0];
  return item as { reason: string; allowedActions: string[]; candidates: Array<{ transactionId: string; status: string }> };
}

describe('finding 1: a posted rival is searched as a posted row, never hidden behind higher-ranked pending rows', () => {
  it.each([4, 5, 6])('holds a posting whose synced posted rival ranks behind %i synced pending rows (the reviewer\'s repro)',
    async (pendingCount) => {
      expect((await v1('commit', [pendingOf(draft({ amountMinor: 1250 }))])).status).toBe(201);
      const pending = allRows()[0].id;
      // Pending rows with the file's own description rank above the posted row, whose description differs.
      const ids = browser([
        ...Array.from({ length: pendingCount }, (_, i) => ({ id: `r2-pending-${i}`, date: '2026-10-02', status: 'pending' as const,
          posted: null, description: 'SYNTHETIC FINAL SALE' })),
        { id: 'r2-posted-rival' },
      ]);
      const rival = ids.at(-1)!;
      const result = await v1('commit', [draft()]);
      expect([result.status, result.body.heldCount, result.body.heldRows, result.body.pendingPostedCount]).toEqual([201, 1, [0], 0]);
      expect(posted().map((row) => row.id)).toEqual([rival]);
      const item = await heldItem();
      expect(item.reason).toBe('cross-source-similar');
      expect(item.candidates.map((candidate) => candidate.transactionId)).toEqual([pending, rival]);
    });

  it('still posts the pending row when every synced row near it is pending', async () => {
    expect((await v1('commit', [pendingOf(draft({ amountMinor: 1250 }))])).status).toBe(201);
    browser(Array.from({ length: 6 }, (_, i) => ({ id: `r2-pending-only-${i}`, date: '2026-10-02', status: 'pending' as const, posted: null,
      description: 'SYNTHETIC FINAL SALE' })));
    const result = await v1('commit', [draft()]);
    expect([result.status, result.body.heldCount, result.body.pendingPostedCount, posted().length]).toEqual([201, 0, 1, 1]);
  });

  it('holds it on a pool the same file changed, which is searched row by row', async () => {
    // The file's first row posts another pending row of the same amount, far from the rival: the second row's search then
    // reads the amount's pool through the overlay (nearContentCandidatesByScan), which must narrow before ranking too.
    expect((await v1('commit', [pendingOf(draft({ externalId: 'r2-far', transactionDate: '2026-09-10', amountMinor: 1500 })),
      pendingOf(draft({ amountMinor: 1250 }))])).status).toBe(201);
    const ids = browser([
      ...Array.from({ length: 6 }, (_, i) => ({ id: `r2-pending-${i}`, date: '2026-10-02', status: 'pending' as const, posted: null,
        description: 'SYNTHETIC FINAL SALE' })),
      { id: 'r2-posted-rival' },
    ]);
    const result = await v1('commit', [draft({ externalId: 'r2-far', transactionDate: '2026-09-10', postedDate: '2026-09-11' }), draft()]);
    expect([result.status, result.body.pendingPostedCount, result.body.heldCount, result.body.heldRows]).toEqual([201, 1, 1, [1]]);
    expect(posted().map((row) => row.amount_minor)).toEqual([1500, 1500]);
    expect(posted().map((row) => row.id)).toContain(ids.at(-1));
    // Only posted rows are rivals: the pending rows near it are never offered as the purchase already posted.
    const pending = allRows()[1].id;
    expect((await heldItem()).candidates.map((candidate) => candidate.transactionId)).toEqual([pending, ids.at(-1)]);
  });
});

describe('finding 2: reviving a dismissed row waits for the owner when a synced posted row may be that purchase (D16 rejected)', () => {
  /** A pending file row, dismissed; then the browser's posted version of it, under the browser's own id. */
  async function dismissedThenSynced(kind: 'reference' | 'fingerprint') {
    const base = draft({ amountMinor: 1250, ...(kind === 'fingerprint' ? { externalId: undefined } : {}) });
    expect((await v1('commit', [pendingOf(base)])).status).toBe(201);
    const pending = allRows()[0].id;
    expect((await w.patch(`/card-transactions/${pending}`, { status: 'removed' })).status).toBe(200);
    // A fingerprint names the row only while its date, amount and description stay; a reference may change amount.
    const amount = kind === 'fingerprint' ? 1250 : 1500;
    const [rival] = browser([{ id: 'r2-posted-after-dismissal', amount, description: 'SYNTHETIC POSTED BROWSER VERSION' }]);
    return { pending, rival, file: [{ ...base, amountMinor: amount }] };
  }

  it.each([
    ['reference', '&dismissedMatches=post'],
    ['fingerprint', '&pendingMatches=post'],
    ['fingerprint', '&pendingMatches=split'],
  ] as const)('holds a dismissed %s revived with %s next to the synced posted row (the reviewer\'s repro)', async (kind, query) => {
    const { pending, rival, file } = await dismissedThenSynced(kind);
    // The preview asks Phase 4's question (the revival is the owner's to answer); the answer then meets the synced row.
    const preview = (await v1('preview', file)).body;
    expect([preview.heldCount, preview.pendingPostedCount, preview.dismissedMatchCount + preview.pendingMatchCount]).toEqual([0, 0, 1]);
    const result = await v1('commit', file, query);
    expect([result.status, result.body.heldCount, result.body.heldRows, result.body.pendingPostedCount]).toEqual([201, 1, [0], 0]);
    expect(result.body.warnings.map((warning: { code: string }) => warning.code)).toContain('held-for-review');
    expect(posted().map((row) => row.id)).toEqual([rival]);
    expect(allRows()[0]).toMatchObject({ id: pending, status: 'removed', removed_reason: 'dismissed' });
    const item = await heldItem();
    expect(item).toMatchObject({ reason: 'cross-source-similar', allowedActions: ['same-transaction', 'reject-row'] });
    expect(item.candidates.map((candidate) => [candidate.transactionId, candidate.status])).toEqual([[pending, 'removed'], [rival, 'posted']]);
  });

  it('revives it on the owner\'s word with the synced row in view, never onto the synced row', async () => {
    const { pending, rival, file } = await dismissedThenSynced('reference');
    expect((await v1('commit', file, '&dismissedMatches=post')).body.heldCount).toBe(1);
    // The file's key belongs to the dismissed row: it cannot become the synced row's. Refused, nothing written.
    const refused = await decide(lastFileSet(), 'same-transaction', rival);
    expect([refused.recorded.status, refused.recorded.body]).toEqual([409, { error: 'action-not-allowed' }]);
    // The owner says it is another purchase than the synced one: the dismissed row is restored and posted.
    await decide(lastFileSet(), 'same-transaction', pending);
    expect(posted().map((row) => row.id).sort()).toEqual([pending, rival].sort());
    expect((await v1('commit', file, '&dismissedMatches=post')).status).toBe(200);
  });

  it('leaves it dismissed when the owner rejects the file row; a replay asks again (a rejection teaches nothing, §4.3), never posting',
    async () => {
    const { pending, rival, file } = await dismissedThenSynced('fingerprint');
    expect((await v1('commit', file, '&pendingMatches=post')).body.heldCount).toBe(1);
    await decide(lastFileSet(), 'reject-row');
    expect(allRows()[0]).toMatchObject({ id: pending, status: 'removed', removed_reason: 'dismissed' });
    expect(posted().map((row) => row.id)).toEqual([rival]);
    const replay = await v1('commit', file, '&pendingMatches=post');
    expect([replay.status, replay.body.heldCount, replay.body.pendingPostedCount]).toEqual([201, 1, 0]);
    expect(posted().map((row) => row.id)).toEqual([rival]);
    expect(allRows()[0]).toMatchObject({ id: pending, status: 'removed' });
  });

  it('revives as in Phase 4 when no synced posted row is near it (a file-only ledger)', async () => {
    const base = draft({ amountMinor: 1250 });
    expect((await v1('commit', [pendingOf(base)])).status).toBe(201);
    const pending = allRows()[0].id;
    expect((await w.patch(`/card-transactions/${pending}`, { status: 'removed' })).status).toBe(200);
    const result = await v1('commit', [{ ...base, amountMinor: 1500 }], '&dismissedMatches=post');
    expect([result.status, result.body.heldCount, result.body.pendingPostedCount]).toEqual([201, 0, 1]);
    expect(posted()).toEqual([expect.objectContaining({ id: pending, amount_minor: 1500 })]);
  });
});
