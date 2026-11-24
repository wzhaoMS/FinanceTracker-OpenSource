import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCardImportPayload, CARD_SYNC_ISSUERS, CARD_SYNC_SOURCES, type CardImportDraftRow } from '@finance-tracker/shared';

import { CardLedgerWriter } from '../services/cardLedger/writer.js';
import { LEGACY_NAMESPACE } from '../services/cardLedger/migrateV15.js';
import { fileReviewIssuer } from '../services/cardImport/review.js';
import { CardSyncOwnerWorld } from '../testing/cardSyncOwnerWorld.js';
import type { CardImportPayload } from '@finance-tracker/shared';

// E2d-D22 (D14-REPORT §7 Q1): a v1 import on a card of an issuer the browser extension doesn't sync (Discover here) stored
// its review work in a file set, which `card_sync_observation_sets.issuer` (`ck_set_issuer`) refuses, so the whole import
// failed with a 500. Such an account now keeps Phase 4's outcome for every row (v14's counts and warnings), and creates
// no file set; the same rows on a Chase card still open their items. Every path that asks or holds is covered, by HTTP and
// through the repository, with the preview equal to the commit; holds are shown impossible there (no sync provenance).

let w: CardSyncOwnerWorld;
beforeEach(async () => {
  w = await CardSyncOwnerWorld.create();
});
afterEach(() => w.close());

interface Card { id: string; issuer: string }
const card = (issuer: string): Card => ({ issuer,
  id: w.repo.createCardAccount({ issuer, owner: 'alex', last4: '5656', currency: 'USD' }).id });
const COVERAGE = { start: '2026-10-01', end: '2026-10-31' };
const payloadOf = (account: Card, rows: CardImportDraftRow[], extra: Record<string, unknown> = {}): CardImportPayload =>
  buildCardImportPayload({ source: `${account.issuer}-csv`, parserVersion: 'issuers@1.0.0', issuer: account.issuer, currency: 'USD',
    coverage: COVERAGE, rows, ...extra }).payload;
const v1 = (op: 'preview' | 'commit', account: Card, rows: CardImportDraftRow[], query = '') =>
  w.post(`/card-imports/${op}?cardAccountId=${account.id}${query}`, payloadOf(account, rows));
const fuel = (patch: Partial<CardImportDraftRow> = {}): CardImportDraftRow => ({ externalId: 'R-1', transactionDate: '2026-10-10',
  postedDate: '2026-10-12', amountMinor: 3200, kind: 'purchase', description: 'FABRIKAM FUEL', ...patch });
const pendingOf = (row: CardImportDraftRow): CardImportDraftRow => ({ ...row, status: 'pending', postedDate: null });

/** What a v1 import stores for an account: its rows, its batches and their counts, and any review work. */
function stored(account: Card) {
  const db = w.db;
  const one = (sql: string) => db.prepare(sql).pluck().get(account.id) as number;
  return {
    rows: db.prepare(`SELECT id, status, amount_minor, description, revision FROM card_transactions WHERE card_account_id = ?
      ORDER BY rowid`).all(account.id),
    batches: db.prepare(`SELECT row_count, new_count, duplicate_count, rejected_count FROM card_import_batches WHERE card_account_id = ?
      ORDER BY rowid`).raw().all(account.id),
    coverage: one('SELECT count(*) FROM card_coverage_windows WHERE card_account_id = ?'),
    sets: one('SELECT count(*) FROM card_sync_observation_sets WHERE card_account_id = ?'),
    observations: one('SELECT count(*) FROM card_source_observations WHERE card_account_id = ?'),
    items: one('SELECT count(*) FROM card_reconciliation_suggestions WHERE card_account_id = ?'),
  };
}
/** The parts of an answer the preview and the commit share (lists and counts of what the import does or asks). */
const decided = (body: Record<string, unknown>) => ({ newCount: body.newCount, duplicateCount: body.duplicateCount,
  conflictCount: body.conflictCount, pendingPostedCount: body.pendingPostedCount, heldCount: body.heldCount, heldRows: body.heldRows,
  reviewCount: body.reviewCount, reviewRows: body.reviewRows,
  warnings: (body.warnings as Array<{ code: string }>).map((warning) => warning.code).sort() });

/**
 * Previews `rows`, commits them echoing the preview's digest, and checks that the commit decided what the preview showed;
 * the commit's answer.
 */
async function previewThenCommit(account: Card, rows: CardImportDraftRow[], query = '') {
  const preview = await v1('preview', account, rows);
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  const committed = await v1('commit', account, rows, `${query}&previewDigest=${preview.body.previewDigest}`);
  expect(committed.status, JSON.stringify(committed.body)).toBeLessThan(300);
  expect(decided(committed.body), 'the commit decides what its preview showed').toEqual(decided(preview.body));
  return committed;
}

/** A second v1 key on a row, as D14's merge or a re-point leaves one (the production writer, in one transaction). */
function secondKey(account: Card, rowId: string, reference: string): string {
  const keyed = buildCardImportPayload({ source: `${account.issuer}-csv`, parserVersion: 'issuers@1.0.0', issuer: account.issuer,
    currency: 'USD', rows: [fuel({ externalId: reference })] }).payload.rows[0].externalIdHash!;
  return w.db.transaction(() => {
    const writer = new CardLedgerWriter(w.db, new Date().toISOString());
    const batch = w.db.prepare('SELECT import_batch_id FROM card_transactions WHERE id = ?').pluck().get(rowId) as string;
    const id = writer.createIdentity({ cardAccountId: account.id, scopeId: writer.legacyScopeOf(account.id), scopeKind: 'legacy',
      namespace: LEGACY_NAMESPACE, namespaceKind: 'legacy-file', idHash: keyed, canonicalId: rowId, firstSeenStatus: 'pending',
      createdOrigin: 'file', importBatchId: batch, firstObservationId: null, lastSeenRunId: null });
    writer.finish();
    return id;
  })();
}

describe('E2d-D22: a card of another issuer than the extension\'s keeps Phase 4\'s outcome and creates no file set', () => {
  it('pins the gate to the schema: file sets exactly for the issuers `ck_set_issuer` (and the source registry) allow', () => {
    const issuersOf = (table: string, check: string) => {
      const sql = w.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").pluck().get(table) as string;
      return [...new RegExp(`${check} CHECK \\(issuer IN \\(([^)]*)\\)\\)`).exec(sql)![1].matchAll(/'([a-z]+)'/g)].map((match) => match[1]);
    };
    expect(issuersOf('card_sync_observation_sets', 'ck_set_issuer')).toEqual([...CARD_SYNC_ISSUERS]);
    expect(issuersOf('card_sync_sources', 'ck_src_issuer')).toEqual([...CARD_SYNC_ISSUERS]);
    expect(CARD_SYNC_ISSUERS.every(fileReviewIssuer)).toBe(true);
    expect(['discover', 'capitalone', 'usbank', 'apple', 'Chase', ''].some(fileReviewIssuer)).toBe(false);
  });

  it.each([
    { issuer: 'discover', status: 200, reviewCount: 0, sets: 0 },
    { issuer: 'chase', status: 201, reviewCount: 1, sets: 1 },
  ])('a posted reference re-imported with other text (E-Q7 posted-correction, the reported 500) on a $issuer card',
    async ({ issuer, status, reviewCount, sets }) => {
      const account = card(issuer);
      expect((await v1('commit', account, [fuel()])).status).toBe(201);
      const before = stored(account);
      const committed = await previewThenCommit(account, [fuel({ description: 'FABRIKAM FUEL 2' })]);
      expect([committed.status, committed.body.reviewCount, committed.body.duplicateCount, committed.body.conflictCount])
        .toEqual([status, reviewCount, 1, 0]);
      expect(stored(account)).toMatchObject({ rows: before.rows, sets, observations: sets, items: sets });
      if (issuer === 'discover') {
        // v14's answer: nothing new, the stored row as it was, no question.
        expect(committed.body).toMatchObject({ imported: false, batch: null, reviewRows: [], heldCount: 0 });
        expect(stored(account)).toEqual(before);
      }
    });

  it.each([
    { issuer: 'discover', status: 200, reviewCount: 0 },
    { issuer: 'chase', status: 201, reviewCount: 1 },
  ])('a reference conflict (another amount) on a $issuer card: Phase 4\'s conflict, and an item only where file sets exist',
    async ({ issuer, status, reviewCount }) => {
      const account = card(issuer);
      expect((await v1('commit', account, [fuel()])).status).toBe(201);
      const committed = await previewThenCommit(account, [fuel({ amountMinor: 3300 })]);
      expect([committed.status, committed.body.conflictCount, committed.body.reviewCount, committed.body.newCount])
        .toEqual([status, 1, reviewCount, 0]);
      expect(stored(account).rows).toEqual([expect.objectContaining({ amount_minor: 3200, description: 'FABRIKAM FUEL' })]);
    });

  it.each([
    { issuer: 'discover', status: 200, reviewCount: 0 },
    { issuer: 'chase', status: 201, reviewCount: 1 },
  ])('a pending reference re-imported pending with other text (E-Q7 pending-changed) on a $issuer card', async ({ issuer, status,
    reviewCount }) => {
    const account = card(issuer);
    expect((await v1('commit', account, [pendingOf(fuel())])).status).toBe(201);
    const committed = await previewThenCommit(account, [pendingOf(fuel({ description: 'FABRIKAM FUEL PENDING' }))]);
    expect([committed.status, committed.body.reviewCount, committed.body.duplicateCount]).toEqual([status, reviewCount, 1]);
    expect(stored(account).rows).toEqual([expect.objectContaining({ status: 'pending', description: 'FABRIKAM FUEL' })]);
  });

  it.each([
    { issuer: 'discover', status: 200, reviewCount: 0, reason: null },
    { issuer: 'chase', status: 201, reviewCount: 1, reason: 'detached-identity' },
  ])('a key the owner detached (D14 leaves a row two keys) on a $issuer card: v14\'s duplicate, or the owner\'s item',
    async ({ issuer, status, reviewCount, reason }) => {
      const account = card(issuer);
      expect((await v1('commit', account, [fuel()])).status).toBe(201);
      const [row] = stored(account).rows as Array<{ id: string; revision: number }>;
      secondKey(account, row.id, 'R-1-ALIAS');
      const first = w.db.prepare(`SELECT id FROM card_source_identities WHERE canonical_transaction_id = ? ORDER BY created_at, rowid
        LIMIT 1`).pluck().get(row.id) as string;
      w.repo.detachCardSourceIdentity({ identityId: first, transactionId: row.id, expectedRevision: row.revision, actorRef: w.owner });
      const committed = await previewThenCommit(account, [fuel()]);
      expect([committed.status, committed.body.reviewCount, committed.body.duplicateCount, committed.body.newCount])
        .toEqual([status, reviewCount, 1, 0]);
      const item = w.db.prepare('SELECT reason FROM card_reconciliation_suggestions WHERE card_account_id = ?').pluck().get(account.id);
      expect(item ?? null).toBe(reason);
      expect(stored(account).rows).toHaveLength(1);
    });

  it.each([
    { issuer: 'discover', reviewCount: 0, reviewRows: [] },
    { issuer: 'chase', reviewCount: 1, reviewRows: [1] },
  ])('two keys of one pending row with other values (finding 6) on a $issuer card: one promotion; the second key asks only where it can',
    async ({ issuer, reviewCount, reviewRows }) => {
      const account = card(issuer);
      expect((await v1('commit', account, [pendingOf(fuel())])).status).toBe(201);
      const [pending] = stored(account).rows as Array<{ id: string }>;
      secondKey(account, pending.id, 'R-1-ALIAS');
      const committed = await previewThenCommit(account, [fuel(), fuel({ externalId: 'R-1-ALIAS', description: 'FABRIKAM FUEL OTHER' })]);
      expect([committed.status, committed.body.pendingPostedCount, committed.body.reviewCount, committed.body.reviewRows])
        .toEqual([201, 1, reviewCount, reviewRows]);
      expect(stored(account).rows).toEqual([expect.objectContaining({ id: pending.id, status: 'posted', description: 'FABRIKAM FUEL' })]);
    });

  it('decides the same through the repository: previewCardImport\'s lists and digest are the commit\'s, and nothing is asked', () => {
    const account = card('discover');
    const shown = { possibleDuplicateRows: [], pendingMatchRows: [], dismissedMatchRows: [], stalePendingIds: [] };
    const commit = (payload: CardImportPayload, previewDigest?: string) => w.repo.commitCardImport({ cardAccountId: account.id, payload,
      decisions: {}, shown, actorRef: w.owner, ...(previewDigest ? { previewDigest } : {}) });
    expect(commit(payloadOf(account, [fuel(), pendingOf(fuel({ externalId: 'R-2', amountMinor: 900 }))])).status).toBe('imported');
    const changed = payloadOf(account, [fuel({ description: 'FABRIKAM FUEL 2' }),
      pendingOf(fuel({ externalId: 'R-2', amountMinor: 901 }))]);
    const preview = w.repo.previewCardImport({ cardAccountId: account.id, payload: changed });
    expect([preview.heldRows, preview.heldOpenRows, preview.reviewRows, preview.promotedRows]).toEqual([[], [], [], []]);
    const result = commit(changed, preview.previewDigest);
    expect(result).toMatchObject({ status: 'nothing-new', applied: { heldRows: [], heldOpenRows: [], reviewRows: [] } });
    expect(stored(account)).toMatchObject({ sets: 0, observations: 0, items: 0 });
  });

  it('can\'t hold a row there: no binding, so no browser scope, identity or synced row (sync provenance) can exist', async () => {
    const account = card('discover');
    w.enable('chase');
    for (const source of CARD_SYNC_SOURCES) {
      expect(() => w.binding({ accountId: account.id, source }), source).toThrowError(/card-account-mismatch/);
    }
    // A Phase 4 history on the card: imports with every decision kind, and the owner's edits.
    expect((await v1('commit', account, [fuel(), pendingOf(fuel({ externalId: 'R-2', amountMinor: 900 }))])).status).toBe(201);
    const pending = (stored(account).rows as Array<{ id: string; status: string }>).find((row) => row.status === 'pending')!;
    const patch = (body: unknown) => w.patch(`/card-transactions/${pending.id}`, body);
    expect((await patch({ userCategory: 'Fuel', notes: 'synthetic' })).status).toBe(200);
    expect((await patch({ status: 'removed' })).status).toBe(200);
    expect((await patch({ status: 'pending' })).status).toBe(200);
    expect((await w.post('/card-imports/commit?cardAccountId=' + account.id + '&dismissedMatches=post',
      payloadOf(account, [fuel({ externalId: 'R-2', amountMinor: 900 })]))).status).toBe(201);
    const counts = w.db.prepare(`SELECT
        (SELECT count(*) FROM card_source_bindings WHERE card_account_id = ?),
        (SELECT count(*) FROM card_scopes WHERE card_account_id = ? AND kind <> 'legacy'),
        (SELECT count(*) FROM card_source_identities WHERE card_account_id = ? AND (source_scope_kind <> 'legacy' OR status <> 'active')),
        (SELECT count(*) FROM card_transactions WHERE card_account_id = ? AND first_sync_run_id IS NOT NULL),
        (SELECT count(*) FROM card_sync_observation_sets WHERE card_account_id = ?),
        (SELECT count(*) FROM card_sync_commit_plans WHERE card_account_id = ?)`).raw().get(...Array(6).fill(account.id));
    expect(counts, 'bindings, browser scopes, browser or detached identities, synced rows, sets, plans').toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('can\'t give a Discover card a set, a run or a binding, even by hand: the schema refuses each, so no v1, v2 or device path can',
    async () => {
      // Real Chase rows of each kind: a binding, a device's run and its extension set, and a file set from an E-Q7 import.
      w.enable('chase');
      const binding = w.binding();
      w.ingest(w.device([binding.bindingId]), binding, [{ scope: w.scopes(binding).known[0], id: 'probe-synced', date: '2026-09-20',
        amount: 990, description: 'SYNTHETIC PROBE' }]);
      const chase: Card = { id: binding.cardAccountRef, issuer: 'chase' };
      expect((await v1('commit', chase, [fuel()])).status).toBe(201);
      expect((await v1('commit', chase, [fuel({ description: 'FABRIKAM FUEL 2' })])).body.reviewCount).toBe(1);
      const discover = card('discover');
      expect((await v1('commit', discover, [fuel()])).status).toBe(201);
      const discoverBatch = w.db.prepare('SELECT id FROM card_import_batches WHERE card_account_id = ?').pluck().get(discover.id);
      const other = (id: string) => `${id.slice(0, -1)}${id.endsWith('a') ? 'b' : 'a'}`;
      /** Inserting a copy of the Chase row `where` names, with `patch`: a row valid in every way but its account. */
      const copy = (table: string, where: string, patch: (row: Record<string, unknown>) => Record<string, unknown>) => () => {
        const row = w.db.prepare(`SELECT * FROM ${table} WHERE card_account_id = ? AND ${where} LIMIT 1`).get(chase.id) as Record<string, unknown>;
        const values = { ...row, ...patch(row) };
        const columns = Object.keys(values);
        w.db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
          .run(...columns.map((column) => values[column]));
      };
      const moved = (issuer: string) => (row: Record<string, unknown>) => ({ id: other(row.id as string), card_account_id: discover.id, issuer });
      // A file set (what E2d wrote): with the card's own issuer the CHECK refuses it (the reported 500), with a sync
      // issuer the FK to the account's (id, issuer, currency). An extension set of the card is refused the same way.
      const fileSet = (issuer: string) => copy('card_sync_observation_sets', "origin = 'file'",
        (row) => ({ ...moved(issuer)(row), import_batch_id: discoverBatch }));
      expect(fileSet('discover')).toThrowError(/CHECK constraint failed: ck_set_issuer/);
      expect(fileSet('chase')).toThrowError(/FOREIGN KEY constraint failed/);
      // A run needs a binding of its own account; a binding, a registered source of the account's issuer.
      expect(copy('card_sync_runs', '1 = 1', (row) => ({ id: other(row.id as string), card_account_id: discover.id,
        client_run_id: other(row.client_run_id as string) }))).toThrowError(/FOREIGN KEY constraint failed/);
      for (const issuer of ['discover', 'chase']) {
        expect(copy('card_source_bindings', '1 = 1', moved(issuer)), issuer).toThrowError(/FOREIGN KEY constraint failed/);
      }
      expect(w.db.prepare(`SELECT (SELECT count(*) FROM card_sync_observation_sets WHERE card_account_id = ?),
          (SELECT count(*) FROM card_sync_runs WHERE card_account_id = ?), (SELECT count(*) FROM card_source_bindings WHERE card_account_id = ?)`)
        .raw().get(discover.id, discover.id, discover.id)).toEqual([0, 0, 0]);
      // The constraints, as declared: every set (file or extension), run and binding is tied to its account's issuer.
      const fks = (table: string) => (w.db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ id: number; table: string;
        from: string; to: string }>).reduce((all, fk) => all.set(fk.id, [...(all.get(fk.id) ?? []), `${fk.table}.${fk.from}->${fk.to}`]),
      new Map<number, string[]>());
      const declared = (table: string) => [...fks(table).values()].map((columns) => columns.join(' '));
      expect(w.db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(declared('card_sync_observation_sets')).toContain(
        'card_accounts.card_account_id->id card_accounts.issuer->issuer card_accounts.currency->currency');
      expect(declared('card_source_bindings')).toEqual(expect.arrayContaining([
        'card_accounts.card_account_id->id card_accounts.issuer->issuer card_accounts.currency->currency',
        'card_sync_sources.source->source card_sync_sources.issuer->issuer']));
      expect(declared('card_sync_runs')).toContain('card_source_bindings.binding_id->id card_source_bindings.card_account_id->card_account_id');
    });

  it('writes nothing when a commit is refused (a 409), and nothing when storing review work fails (the old 500)', async () => {
    const discover = card('discover');
    expect((await v1('commit', discover, [fuel()])).status).toBe(201);
    const before = stored(discover);
    const mismatch = await w.post(`/card-imports/commit?cardAccountId=${discover.id}`,
      payloadOf(discover, [fuel({ description: 'FABRIKAM FUEL 2' }), fuel({ externalId: 'R-9', amountMinor: 1 })],
        { statement: { chargesMinor: 7 } }));
    expect(mismatch.status).toBe(409);
    expect(stored(discover)).toEqual(before);
    // On a Chase card, a file set the database refuses (as the CHECK refused Discover's) fails the whole import: no batch,
    // no new row, no coverage, no review work. Then, without the fault, the same commit stores it all.
    const chase = card('chase');
    expect((await v1('commit', chase, [fuel()])).status).toBe(201);
    const chaseBefore = stored(chase);
    const file = [fuel({ description: 'FABRIKAM FUEL 2' }), fuel({ externalId: 'R-3', amountMinor: 4100, description: 'NEW PURCHASE' })];
    w.db.exec(`CREATE TEMP TRIGGER zz_refuse_file_sets BEFORE INSERT ON main.card_sync_observation_sets WHEN NEW.origin = 'file'
      BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    try {
      const failed = await w.post(`/card-imports/commit?cardAccountId=${chase.id}`, payloadOf(chase, file));
      expect(failed.status).toBe(500);
      expect(stored(chase)).toEqual(chaseBefore);
    } finally {
      w.db.exec('DROP TRIGGER temp.zz_refuse_file_sets');
    }
    const retried = await w.post(`/card-imports/commit?cardAccountId=${chase.id}`, payloadOf(chase, file));
    expect([retried.status, retried.body.newCount, retried.body.reviewCount]).toEqual([201, 1, 1]);
  });

  it('keeps a Chase card\'s review and a Discover card\'s Phase 4 outcome apart in one ledger, and lists only the Chase set', async () => {
    w.enable('chase');
    const binding = w.binding();
    const chase: Card = { id: binding.cardAccountRef, issuer: 'chase' };
    const discover = card('discover');
    for (const account of [chase, discover]) expect((await v1('commit', account, [fuel()])).status).toBe(201);
    const answers = [];
    for (const account of [chase, discover]) answers.push((await v1('commit', account, [fuel({ description: 'FABRIKAM FUEL 2' })])).body);
    expect(answers.map((body) => [body.imported, body.reviewCount])).toEqual([[true, 1], [false, 0]]);
    const listed = await w.get('/card-sync/owner/observation-sets?view=open');
    expect(listed.body.observationSets.map((set: { cardAccountRef: string; sourceKind: string }) => [set.cardAccountRef, set.sourceKind]))
      .toEqual([[chase.id, 'file']]);
    expect(stored(discover)).toMatchObject({ sets: 0, observations: 0, items: 0 });
    // The Discover card's own edits reach no v15 table either.
    const row = (stored(discover).rows as Array<{ id: string }>)[0];
    const edited = await w.patch(`/card-transactions/${row.id}`, { userCategory: 'Fuel' });
    expect(edited.status).toBe(200);
    expect(stored(discover)).toMatchObject({ sets: 0, observations: 0, items: 0 });
  });
});
