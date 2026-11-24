import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CARD_SYNC_IDENTITY_NAMESPACES, cardExternalIdHash, cardTransactionFingerprint } from '@finance-tracker/shared';
import { CARD_TEST_OWNER_REF, CARD_TEST_T0, cardFileRow, writeV14CardLedger } from '../../testing/cardSyncLedgerSeed.js';
import { makeScratchDir, removeScratchDir } from '../../testing/scratchDir.js';
import { rowContentDigest } from '../cardSyncDigests.js';
import { SqliteStateRepo, type CardImportInput } from '../sqliteStateRepo.js';
import { CARD_SYNC_ADMISSIONS, NO_ADMISSIONS } from './admissions.js';
import { LEGACY_NAMESPACE } from './migrateV15.js';

// The ledger writer's v1 entry points on schema v15 (E1b design §4.1,
// §4.10.4, §5.7; slice 1 keeps Phase 4's outcomes, PROGRESS D1–D7): what each
// import and owner change records besides the row itself.

const OWNER = { actorRef: CARD_TEST_OWNER_REF };
const REF = cardExternalIdHash('320252940000000201');

let repo: SqliteStateRepo;
let account: string;
let legacyScope: string;

beforeEach(() => {
  repo = new SqliteStateRepo({ file: ':memory:', now: () => new Date(CARD_TEST_T0) });
  account = repo.createCardAccount({ issuer: 'amex', owner: 'joint', last4: '0003', currency: 'USD' }).id;
  legacyScope = (repo.internalGetDb().prepare("SELECT id FROM card_scopes WHERE kind = 'legacy'").get() as { id: string }).id;
});

afterEach(() => {
  repo.close();
});

const db = () => repo.internalGetDb();
const all = <T = Record<string, unknown>>(sql: string, ...params: unknown[]) => db().prepare(sql).all(...params) as T[];
const one = <T = Record<string, unknown>>(sql: string, ...params: unknown[]) => db().prepare(sql).get(...params) as T;
const ledgerRevision = () => one<{ r: number }>('SELECT ledger_revision AS r FROM card_accounts WHERE id = ?', account).r;
const importRows = (rows: CardImportInput['rows'], extra: Partial<CardImportInput> = {}) => repo.importCardTransactions({
  cardAccountId: account, source: 'amex-csv', parserVersion: 'amex-csv@1.0.0', rows, ...extra,
});
const sourcesOf = (transactionId: string) => repo.getCardTransactionSources({ transactionId, continue: null,
  limits: { events: 100, identities: 100, merged: 100 } })!;
const eventsOf = (transactionId: string) => all(`SELECT event_type, transaction_revision, origin, actor_kind, actor_ref, reason,
    from_status, to_status, edit_fields, notify FROM card_transaction_events WHERE card_transaction_id = ? ORDER BY rowid`, transactionId);
const content = (row: ReturnType<typeof cardFileRow>) => rowContentDigest({
  transactionDate: row.transactionDate, postedDate: row.postedDate ?? null, status: row.status as 'pending' | 'posted',
  amountMinor: row.amountMinor, kind: row.kind, description: row.description, merchant: row.merchant ?? null,
  issuerCategory: row.issuerCategory ?? null, originalAmountMinor: row.originalAmountMinor ?? null,
  originalCurrency: row.originalCurrency ?? null,
});

describe('card ledger writer: v1 imports', () => {
  it('records each new row: its legacy identity, its content as inserted, a created event; one ledger revision per import', () => {
    const rows = [cardFileRow({ externalIdHash: REF }), cardFileRow({ amountMinor: 899, description: 'SYNTHETIC BOOKS' })];
    const batch = importRows(rows);
    expect(batch).toMatchObject({ newCount: 2, duplicateCount: 0 });
    expect(ledgerRevision()).toBe(1);
    const stored = repo.listCardTransactions({ cardAccountId: account });
    expect(stored).toHaveLength(2);
    for (const row of stored) {
      const source = rows.find((r) => r.amountMinor === row.amountMinor)!;
      expect(one('SELECT card_scope_id, revision, reversal_snapshot_revision, removed_reason FROM card_transactions WHERE id = ?', row.id))
        .toEqual({ card_scope_id: legacyScope, revision: 1, reversal_snapshot_revision: null, removed_reason: null });
      const identity = one<Record<string, unknown>>('SELECT * FROM card_source_identities WHERE canonical_transaction_id = ?', row.id);
      expect(identity).toMatchObject({
        card_account_id: account, source_scope_id: legacyScope, source_scope_kind: 'legacy', namespace: LEGACY_NAMESPACE,
        namespace_kind: 'legacy-file', id_hash: row.externalIdHash ?? row.fingerprint, status: 'active', first_seen_status: 'posted',
        created_origin: 'file', import_batch_id: batch.id, created_at: CARD_TEST_T0,
      });
      expect(all('SELECT content_digest, resolution, recorded_at FROM card_identity_contents WHERE identity_id = ?', identity.id))
        .toEqual([{ content_digest: content(source), resolution: 'inserted', recorded_at: CARD_TEST_T0 }]);
      expect(all(`SELECT event_type, transaction_revision, origin, actor_kind, actor_ref, import_batch_id, identity_id, reason,
          to_status, to_amount_minor, to_transaction_date, to_scope_id, created_at FROM card_transaction_events
        WHERE card_transaction_id = ?`, row.id)).toEqual([{
        event_type: 'created', transaction_revision: 1, origin: 'file', actor_kind: 'system', actor_ref: null,
        import_batch_id: batch.id, identity_id: identity.id, reason: 'insert', to_status: 'posted', to_amount_minor: source.amountMinor,
        to_transaction_date: source.transactionDate, to_scope_id: legacyScope, created_at: CARD_TEST_T0,
      }]);
    }
  });

  it('names the signed-in owner in the events of an import made in a session', () => {
    importRows([cardFileRow({ externalIdHash: REF })], { actorRef: CARD_TEST_OWNER_REF });
    expect(all('SELECT origin, actor_kind, actor_ref FROM card_transaction_events'))
      .toEqual([{ origin: 'file', actor_kind: 'session', actor_ref: CARD_TEST_OWNER_REF }]);
    expect(() => importRows([cardFileRow()], { actorRef: 'usr_1234' })).toThrow('a card transaction change needs the acting owner');
  });

  it('records an import\'s declared coverage as a committed file window on the legacy scope', () => {
    const batch = importRows([cardFileRow()], { coverage: { start: '2026-09-01', end: '2026-09-30' } });
    expect(all(`SELECT card_scope_id, source_kind, source, import_batch_id, status, requested_start, requested_end, requested_basis,
        evidence, ledger_state FROM card_coverage_windows`)).toEqual([{
      card_scope_id: legacyScope, source_kind: 'file', source: 'amex-csv', import_batch_id: batch.id, status: 'any',
      requested_start: '2026-09-01', requested_end: '2026-09-30', requested_basis: 'posted-or-transaction', evidence: 'file-declared',
      ledger_state: 'committed',
    }]);
  });

  it('posts a pending row in place: promoted content and event, a snapshot of the pending values, the marker cleared', () => {
    const pending = cardFileRow({ externalIdHash: REF, postedDate: null, status: 'pending', amountMinor: 1200 });
    importRows([pending]);
    const [row] = repo.listCardTransactions();
    const posted = cardFileRow({ externalIdHash: REF, amountMinor: 1250 });
    expect(importRows([posted])).toMatchObject({ newCount: 0, duplicateCount: 1 });

    expect(repo.getCardTransaction(row.id)).toMatchObject({ id: row.id, status: 'posted', amountMinor: 1250, postedDate: '2026-09-04' });
    expect(one('SELECT revision, reversal_snapshot_revision FROM card_transactions WHERE id = ?', row.id))
      .toEqual({ revision: 2, reversal_snapshot_revision: null });
    expect(all('SELECT revision, status, amount_minor, posted_date FROM card_transaction_versions WHERE card_transaction_id = ?', row.id))
      .toEqual([{ revision: 1, status: 'pending', amount_minor: 1200, posted_date: null }]);
    expect(all('SELECT resolution, content_digest FROM card_identity_contents ORDER BY rowid')).toEqual([
      { resolution: 'inserted', content_digest: content(pending) },
      { resolution: 'promoted', content_digest: content(posted) },
    ]);
    expect(eventsOf(row.id)).toEqual([
      expect.objectContaining({ event_type: 'created', transaction_revision: 1 }),
      { event_type: 'promoted', transaction_revision: 2, origin: 'file', actor_kind: 'system', actor_ref: null, reason: 'pending-posted',
        from_status: 'pending', to_status: 'posted', edit_fields: 0, notify: 1 },
    ]);
    expect(all('SELECT count(*) AS n FROM card_source_identities')).toEqual([{ n: 1 }]);
    expect(ledgerRevision()).toBe(2);

    // Replaying either file now finds known content: nothing is written (§4.3).
    const before = { events: all('SELECT * FROM card_transaction_events'), rows: all('SELECT * FROM card_transactions') };
    expect(importRows([pending])).toMatchObject({ newCount: 0, duplicateCount: 1 });
    expect(importRows([posted])).toMatchObject({ newCount: 0, duplicateCount: 1 });
    expect({ events: all('SELECT * FROM card_transaction_events'), rows: all('SELECT * FROM card_transactions') }).toEqual(before);
    expect(ledgerRevision()).toBe(2);
  });

  it('restores and posts a dismissed row on the owner\'s word, reversibly', () => {
    importRows([cardFileRow({ externalIdHash: REF, postedDate: null, status: 'pending' })]);
    const [row] = repo.listCardTransactions();
    repo.updateCardTransaction(row.id, { status: 'removed' }, OWNER);
    expect(importRows([cardFileRow({ externalIdHash: REF })])).toMatchObject({ newCount: 0, duplicateCount: 1 });
    expect(repo.getCardTransaction(row.id)?.status).toBe('removed');

    importRows([cardFileRow({ externalIdHash: REF })], { promoteDismissedMatches: true, actorRef: CARD_TEST_OWNER_REF });
    expect(repo.getCardTransaction(row.id)).toMatchObject({ status: 'posted', dismissedAt: undefined });
    expect(one('SELECT revision, reversal_snapshot_revision, removed_reason FROM card_transactions WHERE id = ?', row.id))
      .toEqual({ revision: 3, reversal_snapshot_revision: 2, removed_reason: null });
    expect(eventsOf(row.id).map((e) => [e.event_type, e.transaction_revision, e.reason])).toEqual([
      ['created', 1, 'insert'], ['removed', 2, 'dismissed'], ['promoted', 3, 'same-transaction'], ['restored', 3, 'restore'],
    ]);
    // The owner API offers that change for undo: the promotion, which the signed-in owner decided.
    const promoted = one<{ id: string }>("SELECT id FROM card_transaction_events WHERE card_transaction_id = ? AND event_type = 'promoted'",
      row.id).id;
    expect(sourcesOf(row.id).revertibleEventId).toBe(promoted);
  });

  it('restores and posts a dismissed row through the service token without offering it for undo (§2.10)', () => {
    importRows([cardFileRow({ externalIdHash: REF, postedDate: null, status: 'pending' })]);
    const [row] = repo.listCardTransactions();
    repo.updateCardTransaction(row.id, { status: 'removed' }, OWNER);
    // No actorRef: the service token's import, which no session decided, so the value change clears the marker.
    importRows([cardFileRow({ externalIdHash: REF })], { promoteDismissedMatches: true });
    expect(repo.getCardTransaction(row.id)).toMatchObject({ status: 'posted', dismissedAt: undefined });
    expect(one('SELECT revision, reversal_snapshot_revision FROM card_transactions WHERE id = ?', row.id))
      .toEqual({ revision: 3, reversal_snapshot_revision: null });
    expect(eventsOf(row.id).slice(2).map((e) => [e.event_type, e.reason, e.actor_kind])).toEqual([
      ['promoted', 'same-transaction', 'system'], ['restored', 'restore', 'system'],
    ]);
    expect(sourcesOf(row.id).revertibleEventId).toBeNull();
  });
});

describe('card ledger writer: the owner\'s changes (PATCH)', () => {
  let rowId: string;

  beforeEach(() => {
    importRows([cardFileRow({ externalIdHash: REF, postedDate: null, status: 'pending' })]);
    rowId = repo.listCardTransactions()[0].id;
  });

  it('dismisses and restores a pending row: removal fields, events, reversal marker, ledger revision', () => {
    repo.updateCardTransaction(rowId, { status: 'removed' }, OWNER);
    expect(one(`SELECT status, removed_reason, removed_from_status, removed_at, dismissed_at, revision, reversal_snapshot_revision
      FROM card_transactions WHERE id = ?`, rowId)).toEqual({
      status: 'removed', removed_reason: 'dismissed', removed_from_status: 'pending', removed_at: CARD_TEST_T0,
      dismissed_at: CARD_TEST_T0, revision: 2, reversal_snapshot_revision: null,
    });
    expect(ledgerRevision()).toBe(2);
    repo.updateCardTransaction(rowId, { status: 'pending' }, OWNER);
    expect(one('SELECT status, removed_reason, dismissed_at, revision, reversal_snapshot_revision FROM card_transactions WHERE id = ?', rowId))
      .toEqual({ status: 'pending', removed_reason: null, dismissed_at: null, revision: 3, reversal_snapshot_revision: 2 });
    expect(ledgerRevision()).toBe(3);
    expect(eventsOf(rowId).slice(1)).toEqual([
      { event_type: 'removed', transaction_revision: 2, origin: 'session', actor_kind: 'session', actor_ref: CARD_TEST_OWNER_REF,
        reason: 'dismissed', from_status: 'pending', to_status: 'removed', edit_fields: 0, notify: 0 },
      { event_type: 'restored', transaction_revision: 3, origin: 'session', actor_kind: 'session', actor_ref: CARD_TEST_OWNER_REF,
        reason: 'restore', from_status: 'removed', to_status: 'pending', edit_fields: 0, notify: 0 },
    ]);
  });

  it('records category and notes as one user-edited event naming the fields, without moving the ledger revision', () => {
    repo.updateCardTransaction(rowId, { userCategory: 'Dining' }, OWNER);
    repo.updateCardTransaction(rowId, { notes: 'team coffee' }, OWNER);
    repo.updateCardTransaction(rowId, { userCategory: 'Travel', notes: null }, OWNER);
    expect(eventsOf(rowId).slice(1).map((e) => [e.event_type, e.transaction_revision, e.edit_fields])).toEqual([
      ['user-edited', 2, 1], ['user-edited', 3, 2], ['user-edited', 4, 3],
    ]);
    expect(ledgerRevision()).toBe(1);
    expect(all('SELECT * FROM card_transaction_versions')).toEqual([]);
  });

  it('writes nothing for a change that changes nothing', () => {
    repo.updateCardTransaction(rowId, { userCategory: 'Dining' }, OWNER);
    const before = { row: one('SELECT * FROM card_transactions WHERE id = ?', rowId), events: all('SELECT * FROM card_transaction_events') };
    expect(repo.updateCardTransaction(rowId, { userCategory: 'Dining' }, OWNER)?.userCategory).toBe('Dining');
    expect({ row: one('SELECT * FROM card_transactions WHERE id = ?', rowId), events: all('SELECT * FROM card_transaction_events') })
      .toEqual(before);
  });

  it('refuses a change without the acting owner, writing nothing', () => {
    const before = all('SELECT * FROM card_transactions');
    for (const ctx of [undefined, {}, { actorRef: 'usr_ABC' }, { actorRef: `dev_${'a'.repeat(32)}` }]) {
      expect(() => repo.updateCardTransaction(rowId, { notes: 'x' }, ctx as never)).toThrow('a card transaction change needs the acting owner');
    }
    expect(all('SELECT * FROM card_transactions')).toEqual(before);
  });
});

describe('card ledger writer: the owner\'s pending decisions in file imports (main #22)', () => {
  const identities = () => all<{ id_hash: string; canonical_transaction_id: string; first_seen_status: string }>(
    'SELECT id_hash, canonical_transaction_id, first_seen_status FROM card_source_identities ORDER BY rowid');
  const ledger = () => ({
    rows: all('SELECT * FROM card_transactions ORDER BY rowid'), identities: identities(),
    contents: all('SELECT * FROM card_identity_contents ORDER BY rowid'), events: all('SELECT * FROM card_transaction_events ORDER BY rowid'),
    versions: all('SELECT * FROM card_transaction_versions ORDER BY rowid'), batches: all('SELECT id FROM card_import_batches ORDER BY rowid'),
  });

  it('adds a fingerprint match as another purchase: its own identity under the free occurrence, inserted content, a created event', () => {
    const hotel = { amountMinor: 5000, description: 'SAMPLE HOTEL' };
    importRows([cardFileRow({ ...hotel, status: 'pending', postedDate: null })]);
    const [pending] = repo.listCardTransactions();
    const posted = cardFileRow({ ...hotel, postedDate: '2026-09-12' });
    expect(importRows([posted, posted], { insertFingerprintMatches: true })).toMatchObject({ newCount: 2, duplicateCount: 0 });

    // The pending row keeps occurrence 0; the first posted row, the owner's other purchase, takes
    // occurrence 2, which no stored identity and no row of the import uses; the second is occurrence 1.
    const fingerprint = (occurrence: number) => cardTransactionFingerprint(posted, occurrence);
    const stored = repo.listCardTransactions();
    expect(identities()).toEqual([
      { id_hash: fingerprint(0), canonical_transaction_id: pending.id, first_seen_status: 'pending' },
      { id_hash: fingerprint(2), canonical_transaction_id: stored.find((t) => t.fingerprint === fingerprint(2))!.id, first_seen_status: 'posted' },
      { id_hash: fingerprint(1), canonical_transaction_id: stored.find((t) => t.fingerprint === fingerprint(1))!.id, first_seen_status: 'posted' },
    ]);
    expect(all('SELECT resolution, content_digest FROM card_identity_contents ORDER BY rowid').slice(1))
      .toEqual([{ resolution: 'inserted', content_digest: content(posted) }, { resolution: 'inserted', content_digest: content(posted) }]);
    expect(all("SELECT event_type, transaction_revision FROM card_transaction_events WHERE event_type <> 'created'")).toEqual([]);
    expect(eventsOf(pending.id)).toHaveLength(1);
    expect(one('SELECT revision FROM card_transactions WHERE id = ?', pending.id)).toEqual({ revision: 1 });
    expect(ledgerRevision()).toBe(2);

    const before = ledger();
    expect(importRows([posted, posted])).toMatchObject({ newCount: 0, duplicateCount: 2 });
    expect({ ...ledger(), batches: before.batches }).toEqual(before);
  });

  it('posts fingerprint matches row by row: promoted content, event and snapshot for the listed row only, or nothing at all', () => {
    const bistro = { amountMinor: 5000, description: 'SAMPLE BISTRO' };
    const cinema = { amountMinor: 7000, description: 'SAMPLE CINEMA' };
    importRows([cardFileRow({ ...bistro, status: 'pending', postedDate: null }), cardFileRow({ ...cinema, status: 'pending', postedDate: null })]);
    const pendingOf = (description: string) => repo.listCardTransactions().find((t) => t.description === description)!;
    const [bistroRow, cinemaRow] = [pendingOf('SAMPLE BISTRO'), pendingOf('SAMPLE CINEMA')];
    const statement = [cardFileRow(bistro), cardFileRow(cinema), cardFileRow({ amountMinor: 900, description: 'SAMPLE BAKERY' })];
    const before = ledger();
    expect(() => importRows(statement, { promoteFingerprintMatchRows: [0, 2] }))
      .toThrow('a row to post as its pending row is not a fingerprint match of one; preview the import again');
    expect(ledger()).toEqual(before);

    importRows(statement, { promoteFingerprintMatchRows: [0], actorRef: CARD_TEST_OWNER_REF });
    expect(one('SELECT status, revision, reversal_snapshot_revision FROM card_transactions WHERE id = ?', bistroRow.id))
      .toEqual({ status: 'posted', revision: 2, reversal_snapshot_revision: null });
    expect(all('SELECT revision, status FROM card_transaction_versions WHERE card_transaction_id = ?', bistroRow.id))
      .toEqual([{ revision: 1, status: 'pending' }]);
    expect(eventsOf(bistroRow.id).map((e) => [e.event_type, e.transaction_revision, e.reason, e.actor_ref])).toEqual([
      ['created', 1, 'insert', null], ['promoted', 2, 'pending-posted', CARD_TEST_OWNER_REF],
    ]);
    expect(all(`SELECT c.resolution FROM card_identity_contents c JOIN card_source_identities i ON i.id = c.identity_id
      WHERE i.canonical_transaction_id = ? ORDER BY c.rowid`, bistroRow.id)).toEqual([{ resolution: 'inserted' }, { resolution: 'promoted' }]);
    expect(one('SELECT status, revision FROM card_transactions WHERE id = ?', cinemaRow.id)).toEqual({ status: 'pending', revision: 1 });
    expect(eventsOf(cinemaRow.id)).toHaveLength(1);
    expect(ledgerRevision()).toBe(2);
  });

  it('dismisses the pending rows named with an import: removal fields, a removed event naming the import and its actor, or nothing', () => {
    importRows([
      cardFileRow({ externalIdHash: cardExternalIdHash('HOLD-1'), status: 'pending', postedDate: null, description: 'SAMPLE ORDER' }),
      cardFileRow({ externalIdHash: cardExternalIdHash('HOLD-2'), status: 'pending', postedDate: null, description: 'SAMPLE GROCER' }),
    ]);
    const [order, grocer] = repo.listCardTransactions();
    const statement = [cardFileRow({ externalIdHash: cardExternalIdHash('POST-1'), description: 'SAMPLE BAKERY' })];
    const before = ledger();
    expect(() => importRows(statement, { dismissPendingIds: [order.id, `card-txn-${'k'.repeat(32)}`] }))
      .toThrow('a pending row to dismiss is no longer pending in this card account; preview the import again');
    expect(ledger()).toEqual(before);

    const batch = importRows(statement, { dismissPendingIds: [order.id], actorRef: CARD_TEST_OWNER_REF });
    expect(one(`SELECT status, removed_reason, removed_from_status, removed_at, dismissed_at, revision, reversal_snapshot_revision
      FROM card_transactions WHERE id = ?`, order.id)).toEqual({
      status: 'removed', removed_reason: 'dismissed', removed_from_status: 'pending', removed_at: CARD_TEST_T0,
      dismissed_at: CARD_TEST_T0, revision: 2, reversal_snapshot_revision: null,
    });
    expect(all(`SELECT event_type, transaction_revision, origin, actor_kind, actor_ref, import_batch_id, reason, from_status, to_status
      FROM card_transaction_events WHERE card_transaction_id = ? AND event_type = 'removed'`, order.id)).toEqual([{
      event_type: 'removed', transaction_revision: 2, origin: 'file', actor_kind: 'session', actor_ref: CARD_TEST_OWNER_REF,
      import_batch_id: batch.id, reason: 'dismissed', from_status: 'pending', to_status: 'removed',
    }]);
    expect(ledgerRevision()).toBe(2);

    // The service principal's import names the system; the dismissed row's identity still answers for it.
    importRows([], { coverage: { start: '2026-10-01', end: '2026-10-31' }, dismissPendingIds: [grocer.id] });
    expect(all("SELECT actor_kind, actor_ref, origin FROM card_transaction_events WHERE card_transaction_id = ? AND event_type = 'removed'", grocer.id))
      .toEqual([{ actor_kind: 'system', actor_ref: null, origin: 'file' }]);
    const settled = ledger();
    expect(importRows([cardFileRow({ externalIdHash: cardExternalIdHash('HOLD-1'), status: 'pending', postedDate: null, description: 'SAMPLE ORDER' })]))
      .toMatchObject({ newCount: 0, duplicateCount: 1 });
    expect({ ...ledger(), batches: settled.batches }).toEqual(settled);
  });

  it('matches a pending row to its posted row (postedAs): removed naming the posted row, the fill as a user-edited event, reversible', () => {
    importRows([cardFileRow({ externalIdHash: cardExternalIdHash('AUTH-5'), status: 'pending', postedDate: null, description: 'SQ *SAMPLE COFFEE' })]);
    importRows([
      cardFileRow({ externalIdHash: cardExternalIdHash('POST-5'), postedDate: '2026-09-12' }),
      cardFileRow({ externalIdHash: cardExternalIdHash('POST-6'), postedDate: '2026-09-12', description: 'SAMPLE TEA' }),
    ]);
    const pending = repo.listCardTransactions().find((t) => t.status === 'pending')!;
    const [posted, tea] = repo.listCardTransactions().filter((t) => t.status === 'posted');
    repo.updateCardTransaction(pending.id, { userCategory: 'Coffee', notes: 'synthetic note' }, OWNER);
    repo.updateCardTransaction(posted.id, { notes: 'its own note' }, OWNER);
    const identitiesBefore = identities();
    const revision = (id: string) => one<{ revision: number }>('SELECT revision FROM card_transactions WHERE id = ?', id).revision;
    const [pendingRevision, postedRevision, account] = [revision(pending.id), revision(posted.id), ledgerRevision()];

    repo.updateCardTransaction(pending.id, { postedAs: posted.id }, OWNER);
    expect(all(`SELECT event_type, transaction_revision, origin, actor_ref, related_transaction_id, reason, edit_fields, edit_resolution
      FROM card_transaction_events WHERE card_transaction_id IN (?, ?) AND transaction_revision > ? ORDER BY rowid`,
    posted.id, pending.id, Math.min(pendingRevision, postedRevision))).toEqual([
      { event_type: 'user-edited', transaction_revision: postedRevision + 1, origin: 'session', actor_ref: CARD_TEST_OWNER_REF,
        related_transaction_id: pending.id, reason: 'user-edit', edit_fields: 1, edit_resolution: 'loser-category' },
      { event_type: 'removed', transaction_revision: pendingRevision + 1, origin: 'session', actor_ref: CARD_TEST_OWNER_REF,
        related_transaction_id: posted.id, reason: 'dismissed', edit_fields: 0, edit_resolution: null },
    ]);
    expect(one('SELECT removed_reason, removed_from_status, user_category, notes FROM card_transactions WHERE id = ?', pending.id))
      .toEqual({ removed_reason: 'dismissed', removed_from_status: 'pending', user_category: 'Coffee', notes: 'synthetic note' });
    expect([revision(pending.id), revision(posted.id), revision(tea.id), ledgerRevision()])
      .toEqual([pendingRevision + 1, postedRevision + 1, 1, account + 1]);
    expect(identities()).toEqual(identitiesBefore);

    // A posted row that already has both keeps them: nothing is written to it.
    importRows([cardFileRow({ externalIdHash: cardExternalIdHash('AUTH-7'), status: 'pending', postedDate: null, description: 'SAMPLE TEA' })]);
    const second = repo.listCardTransactions().find((t) => t.status === 'pending')!;
    repo.updateCardTransaction(second.id, { userCategory: 'Tea' }, OWNER);
    repo.updateCardTransaction(tea.id, { userCategory: 'Drinks', notes: 'kept' }, OWNER);
    const teaRow = one('SELECT * FROM card_transactions WHERE id = ?', tea.id);
    repo.updateCardTransaction(second.id, { postedAs: tea.id }, OWNER);
    expect(one('SELECT * FROM card_transactions WHERE id = ?', tea.id)).toEqual(teaRow);
    expect(eventsOf(tea.id).filter((e) => e.event_type === 'user-edited')).toHaveLength(1);

    // Restoring the matched pending row is the owner's reversible decision.
    repo.updateCardTransaction(pending.id, { status: 'pending' }, OWNER);
    expect(one('SELECT status, revision, reversal_snapshot_revision FROM card_transactions WHERE id = ?', pending.id))
      .toEqual({ status: 'pending', revision: pendingRevision + 2, reversal_snapshot_revision: pendingRevision + 1 });
    expect(eventsOf(pending.id).at(-1)).toMatchObject({ event_type: 'restored', reason: 'restore' });
  });
});

describe('card ledger writer: rows removed before v15', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeScratchDir('card-writer-');
  });

  afterEach(async () => {
    await removeScratchDir(dir);
  });

  it('refuses to restore a row a v13/v14 import stored as removed, which nobody dismissed', () => {
    const file = path.join(dir, 'v14.db');
    const { legacyRemovedIds } = writeV14CardLedger(file);
    const upgraded = new SqliteStateRepo({ file, now: () => new Date(CARD_TEST_T0) });
    try {
      for (const id of legacyRemovedIds) {
        expect(() => upgraded.updateCardTransaction(id, { status: 'pending' }, OWNER))
          .toThrow('only a dismissed pending card transaction can be restored');
        expect(upgraded.getCardTransaction(id)?.status).toBe('removed');
      }
    } finally {
      upgraded.close();
    }
  });
});

describe('card ledger: who may write it, and what is admitted', () => {
  it('lets only the writer and the v15 migration write card transactions, identities or their contents (§4.1)', () => {
    const src = fileURLToPath(new URL('../../', import.meta.url));
    const writes = /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+(card_transactions|card_source_identities|card_identity_contents)\b/g;
    const found = new Map<string, Set<string>>();
    const walk = (dirPath: string) => {
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        const full = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'testing' && entry.name !== '__fixtures__') walk(full);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          for (const m of fs.readFileSync(full, 'utf8').matchAll(writes)) {
            const file = path.relative(src, full).split(path.sep).join('/');
            if (!found.has(file)) found.set(file, new Set());
            found.get(file)!.add(m[1]);
          }
        }
      }
    };
    walk(src);
    expect(Object.fromEntries([...found].map(([file, tables]) => [file, [...tables].sort()]))).toEqual({
      'services/cardLedger/writer.ts': ['card_identity_contents', 'card_source_identities', 'card_transactions'],
      'services/cardLedger/migrateV15.ts': ['card_identity_contents', 'card_source_identities'],
      // The design's copy of the rebuilt table (block 3.4b), which only migrateV15.ts runs.
      'services/cardSyncSchemaSql.ts': ['card_transactions'],
    });
  });

  it('keeps every automatic admission closed (E4–E7 gates; design §4.4, Q5)', () => {
    for (const admissions of [CARD_SYNC_ADMISSIONS, NO_ADMISSIONS]) {
      expect(Object.keys(admissions).sort()).toEqual([...CARD_SYNC_IDENTITY_NAMESPACES].sort());
      for (const [namespace, admission] of Object.entries(admissions)) {
        expect(admission, namespace).toEqual({ autoInsert: false, lifecycle: false });
        expect(Object.isFrozen(admission)).toBe(true);
      }
      expect(Object.isFrozen(admissions)).toBe(true);
    }
    expect(all('SELECT id, enabled, main_passive_accepted, approved_contract_version FROM card_sync_issuer_policy ORDER BY id'))
      .toEqual(['amex', 'chase', 'citi', 'wellsfargo'].map((id) => ({ id, enabled: 0, main_passive_accepted: 0, approved_contract_version: null })));
  });
});
