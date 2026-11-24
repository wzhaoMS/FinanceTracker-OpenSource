import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCardImportPayload, type CardImportDraftRow, type CardImportPayload } from '@finance-tracker/shared';

import { CardSyncScenario, SCENARIO_OWNER, type ScenarioDevice, type ScenarioRow } from '../../testing/cardSyncScenario.js';
import type { CardImportCommitResult, CardImportDecisions, CardSourceBindingView, CardSyncPlanView } from '../sqliteStateRepo.js';
import { indexesOf } from './plan.js';

// E2d: E1b design §4.10.4's classifier-driven v1 import, in the repository. A v1 row that meets what the browser
// extension wrote is held for review (or opens a review item) in the batch's file set, inside the import's own
// transaction; every other row keeps Phase 4's outcome. The reviewer's F5 repro (slice 2 review r1) and its variants
// produce a review set, never a second row and never a refusal; the owner then decides it like any review set.

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
const count = (sql: string, ...params: unknown[]) => w.db.prepare(sql).pluck().get(...params) as number;
const spent = () => count("SELECT coalesce(sum(amount_minor), 0) FROM card_transactions WHERE status = 'posted'");
const rowsOf = () => count('SELECT count(*) FROM card_transactions');
const fileSets = () => w.db.prepare("SELECT * FROM card_sync_observation_sets WHERE origin = 'file' ORDER BY rowid").all() as Array<
  Record<string, unknown> & { id: string }>;
const setVersion = (setId: string) => count('SELECT version FROM card_sync_observation_sets WHERE id = ?', setId);
const items = (setId: string) => w.repo.getCardSyncObservationSetPage({ setId, after: null, limit: 100 })!.items;

/** The synced purchase: 12.50 at Fourth Coffee on Oct 1, committed through the extension. */
function synced(row: Partial<ScenarioRow> = {}): string {
  w.ingest(device, binding, [{ scope: known[0], date: '2026-10-01', amount: 1250, description: 'FOURTH COFFEE', merchant: 'Fourth Coffee',
    id: 'sor-1', ...row }]);
  return w.db.prepare('SELECT id FROM card_transactions WHERE first_sync_run_id IS NOT NULL ORDER BY rowid DESC').pluck().get() as string;
}

const draft = (over: Partial<CardImportDraftRow> = {}): CardImportDraftRow => ({ transactionDate: '2026-10-02', postedDate: '2026-10-02',
  amountMinor: 1250, kind: 'purchase', description: 'FOURTH COFFEE STORE', externalId: 'csv-ref-1', ...over });
const csv = (rows: CardImportDraftRow[], coverage?: { start: string; end: string }): CardImportPayload => buildCardImportPayload({
  source: 'chase-csv', parserVersion: 'holdr-card-import@1.0.0', issuer: 'chase', currency: 'USD', rows, ...(coverage ? { coverage } : {}),
}).payload;

/** The lists a route would compute and show for this payload now. */
function shownFor(payload: CardImportPayload) {
  const { plan } = w.repo.previewCardImport({ cardAccountId: binding.cardAccountRef, payload });
  return { possibleDuplicateRows: indexesOf(plan, 'possible-duplicate'), pendingMatchRows: indexesOf(plan, 'pending-match'),
    dismissedMatchRows: indexesOf(plan, 'dismissed-match'), stalePendingIds: plan.stale.map((row) => row.id) };
}
function commit(payload: CardImportPayload, decisions: CardImportDecisions = {}): CardImportCommitResult {
  return w.repo.commitCardImport({ cardAccountId: binding.cardAccountRef, payload, decisions, shown: shownFor(payload),
    actorRef: SCENARIO_OWNER });
}
function imported(result: CardImportCommitResult) {
  if (result.status !== 'imported') throw new Error(`expected an import, got ${result.status}`);
  return result;
}

/** The owner decides the set's items and commits its plan, as the owner routes do. */
function decideAndCommit(setId: string, decisions: Array<{ itemId: string; action: string; transactionId?: string | null }>) {
  w.repo.refreshCardReviewItems({ setId });
  w.repo.recordCardReviewDecisions({ setId, expectedVersion: setVersion(setId), actorRef: SCENARIO_OWNER,
    decisions: decisions.map((d) => ({ itemId: d.itemId, action: d.action as never, transactionId: d.transactionId ?? null, cardScopeId: null })) });
  const plan = w.repo.prepareCardSyncPlan({ principal: owner, setId, expectedVersion: setVersion(setId) }) as CardSyncPlanView;
  expect(plan).toMatchObject({ status: 'executable', payloadDigest: null });
  return w.repo.commitCardSyncPlan({ principal: owner, previewId: plan.previewId, payloadDigest: null, planDigest: plan.planDigest });
}

describe('a v1 row near a synced one (F5\'s repro and its variants)', () => {
  it('holds the reviewer\'s row: no second row, a file set whose item names the synced row, counted as rejected and held', () => {
    const row = synced();
    const result = imported(commit(csv([draft()])));
    expect(result).toMatchObject({ heldCount: 1, reviewCount: 1, batch: { newCount: 0, duplicateCount: 0, rejectedCount: 1 } });
    expect(result.preview.heldRows).toEqual([0]);
    expect([rowsOf(), spent()]).toEqual([1, 1250]);
    const [set] = fileSets();
    expect(set).toMatchObject({ import_batch_id: result.batch.id, file_chunk: 0, state: 'needs-review', row_count: 1, open_count: 1,
      source: 'chase-csv', receipt_state: 'none' });
    const [item] = items(set.id);
    expect(item).toMatchObject({ reason: 'cross-source-similar', category: 'cross-source-similar', status: 'open',
      allowedActions: ['same-transaction', 'insert-new', 'reject-row'],
      candidates: [expect.objectContaining({ transactionId: row, rule: 'near-content:v1', blockedReason: null })] });
  });

  it('holds across statuses, both ways, and two rows near one synced row each get their own item', () => {
    synced();
    synced({ id: 'sor-p', status: 'pending', date: '2026-10-10', posted: null, amount: 3300, description: 'NORTHWIND HOLD' });
    const result = imported(commit(csv([
      draft({ status: 'pending', postedDate: null, transactionDate: '2026-09-30', externalId: 'p-1', description: 'FOURTH COFFEE PENDING' }),
      draft({ amountMinor: 3300, transactionDate: '2026-10-12', postedDate: '2026-10-13', externalId: 'n-1', description: 'NORTHWIND' }),
      draft({ externalId: 'twin-a', transactionDate: '2026-10-01', postedDate: '2026-10-01', description: 'FOURTH COFFEE A' }),
      draft({ externalId: 'twin-b', transactionDate: '2026-10-03', postedDate: '2026-10-03', description: 'FOURTH COFFEE B' }),
    ])));
    expect(result).toMatchObject({ heldCount: 4, batch: { newCount: 0, rejectedCount: 4 } });
    expect(items(fileSets()[0].id).map((item) => item.reason)).toEqual(Array(4).fill('cross-source-similar'));
    expect(rowsOf()).toBe(2);
  });

  it('imports as Phase 4 does what no synced row is near: another amount, another week, a removed synced row', () => {
    const row = synced();
    expect(imported(commit(csv([draft({ amountMinor: 1251, externalId: 'a' }), draft({ transactionDate: '2026-10-09',
      postedDate: '2026-10-09', externalId: 'b' })])))).toMatchObject({ heldCount: 0, reviewCount: 0, batch: { newCount: 2 } });
    w.repo.removeCardTransaction({ id: row, reason: 'mistaken-import', expectedRevision: 1, actorRef: SCENARIO_OWNER });
    expect(imported(commit(csv([draft()]))).batch.newCount).toBe(1);
    expect(fileSets()).toHaveLength(0);
  });

  it('asks the possible-duplicate question for an exact twin of a synced row (S9), and never holds a row imported on that answer', () => {
    synced();
    const twin = csv([draft({ transactionDate: '2026-10-01', postedDate: '2026-10-01', description: 'FOURTH COFFEE' })]);
    expect(commit(twin)).toMatchObject({ status: 'decision-required', kind: 'possible-duplicates' });
    expect(imported(commit(twin, { possibleDuplicates: 'import' }))).toMatchObject({ heldCount: 0, batch: { newCount: 1 } });
    expect(rowsOf()).toBe(2);
  });
});

describe('replays and the owner\'s decisions', () => {
  it('asks once: a replay while the item is open adds nothing; after insert-new the row is a v1 row like any other', () => {
    synced();
    const payload = csv([draft()]);
    imported(commit(payload));
    // The same file again: the row is under review already, so nothing is new (its coverage is recorded).
    expect(commit(payload)).toMatchObject({ status: 'nothing-new', preview: { heldRows: [], heldOpenRows: [0] } });
    expect(fileSets()).toHaveLength(1);
    const [set] = fileSets();
    const [item] = items(set.id);
    decideAndCommit(set.id, [{ itemId: item.itemId, action: 'insert-new' }]);
    const inserted = w.db.prepare('SELECT * FROM card_transactions WHERE first_sync_run_id IS NULL').get() as Record<string, unknown>;
    expect(inserted).toMatchObject({ status: 'posted', amount_minor: 1250, source: 'chase-csv', import_batch_id: set.import_batch_id,
      card_scope_id: count("SELECT id FROM card_scopes WHERE kind = 'legacy'") as unknown });
    expect(count("SELECT count(*) FROM card_source_identities WHERE canonical_transaction_id = ? AND namespace_kind = 'legacy-file'",
      inserted.id)).toBe(1);
    expect(spent()).toBe(2500);
    expect(commit(payload)).toMatchObject({ status: 'nothing-new' });
  });

  it('links the row to the synced one on same-transaction: one purchase, both sources, and a replay is a duplicate', () => {
    const row = synced();
    const payload = csv([draft()]);
    imported(commit(payload));
    const [set] = fileSets();
    decideAndCommit(set.id, [{ itemId: items(set.id)[0].itemId, action: 'same-transaction', transactionId: row }]);
    expect([rowsOf(), spent()]).toEqual([1, 1250]);
    expect(count("SELECT count(*) FROM card_source_identities WHERE canonical_transaction_id = ? AND status = 'active'", row)).toBe(2);
    expect(commit(payload)).toMatchObject({ status: 'nothing-new', preview: { plan: { rows: ['duplicate'] } } });
  });

  it('holds the row again after reject-row: rejected content is asked about again (A14)', () => {
    synced();
    const payload = csv([draft()]);
    imported(commit(payload));
    const [set] = fileSets();
    decideAndCommit(set.id, [{ itemId: items(set.id)[0].itemId, action: 'reject-row' }]);
    expect(rowsOf()).toBe(1);
    expect(imported(commit(payload))).toMatchObject({ heldCount: 1, reviewCount: 1 });
    expect(fileSets()).toHaveLength(2);
  });
});

describe('mixed-source duplicates with new content (§4.11 E-Q7, for rows the extension also wrote)', () => {
  it('opens one posted-correction item, leaves the row as it is, and asks only once', () => {
    const row = synced();
    imported(commit(csv([draft()])));
    const [first] = fileSets();
    decideAndCommit(first.id, [{ itemId: items(first.id)[0].itemId, action: 'same-transaction', transactionId: row }]);
    // The issuer's file regenerated with new text for the same reference.
    const regenerated = csv([draft({ description: 'FOURTH COFFEE STORE #12' })]);
    const result = imported(commit(regenerated));
    expect(result).toMatchObject({ heldCount: 0, reviewCount: 1, batch: { newCount: 0, duplicateCount: 1, rejectedCount: 0 } });
    expect(result.preview.reviewRows).toEqual([0]);
    expect(w.db.prepare('SELECT description FROM card_transactions WHERE id = ?').pluck().get(row)).toBe('FOURTH COFFEE');
    const second = fileSets()[1];
    expect(items(second.id)).toEqual([expect.objectContaining({ reason: 'posted-correction',
      allowedActions: ['accept-correction', 'keep-current'], candidates: [expect.objectContaining({ transactionId: row })] })]);
    expect(commit(regenerated)).toMatchObject({ status: 'nothing-new' });
    decideAndCommit(second.id, [{ itemId: items(second.id)[0].itemId, action: 'accept-correction' }]);
    expect(w.db.prepare('SELECT description FROM card_transactions WHERE id = ?').pluck().get(row)).toBe('FOURTH COFFEE STORE #12');
    expect(commit(regenerated)).toMatchObject({ status: 'nothing-new' });
  });

  it('asks about a file-only row with new content as well: a duplicate with one item (§4.11 E-Q7; E2d-D1 rejected)', () => {
    imported(commit(csv([draft({ externalId: 'file-only' })])));
    const changed = csv([draft({ externalId: 'file-only', description: 'NEW TEXT' })], { start: '2026-09-01', end: '2026-10-31' });
    const result = imported(commit(changed));
    expect(result).toMatchObject({ reviewCount: 1, heldCount: 0, batch: { newCount: 0, duplicateCount: 1, rejectedCount: 0 } });
    expect(result.applied.reviewRows).toEqual([0]);
    const [set] = fileSets();
    expect(items(set.id)).toEqual([expect.objectContaining({ reason: 'posted-correction' })]);
    expect(commit(changed)).toMatchObject({ status: 'nothing-new' });
    expect(fileSets()).toHaveLength(1);
  });
});

describe('file sets over time and size', () => {
  it('expires a due set\'s open row when a later import needs its key, and stores the new one (R11)', () => {
    synced();
    const payload = csv([draft()]);
    imported(commit(payload));
    const [old] = fileSets();
    w.tick(31 * 86_400);
    // Past its deadline, before retention reached it: the import expires the row it needs, the set moves.
    const again = imported(commit(payload));
    expect(again).toMatchObject({ heldCount: 1, reviewCount: 1 });
    expect(w.db.prepare("SELECT state FROM card_source_observations WHERE observation_set_id = ?").pluck().get(old.id)).toBe('expired');
    expect(setVersion(old.id)).toBe(2);
    expect(fileSets()).toHaveLength(2);
  });

  it('chunks review rows into sets of 2,000 (file_chunk 0 and 1)', () => {
    synced();
    const rows = Array.from({ length: 2001 }, (_, i) => draft({ externalId: `bulk-${i}`, description: `FOURTH COFFEE ${i}` }));
    const result = imported(commit(csv(rows)));
    expect(result).toMatchObject({ heldCount: 2001, reviewCount: 2001, batch: { newCount: 0, rejectedCount: 2001 } });
    expect(fileSets().map((set) => [set.file_chunk, set.row_count])).toEqual([[0, 2000], [1, 1]]);
  }, 60_000);
});
