import type { Database as DB } from 'better-sqlite3';

import { CARD_SYNC_BLOCKS, type CardSyncBlock } from '../cardSyncSchemaSql.js';
import { newCardSyncId, newCardSyncRowId, rowContentDigest } from '../cardSyncDigests.js';
import { CARD_PARSER_VERSION, CARD_SLUG } from '../cardV1Grammar.js';
import { HoldrRefusal } from '../dbErrors.js';

/**
 * Card-sync schema v15 (E1b design §3): the registries, scopes, bindings,
 * policy, pairings and devices, runs, durable observations, receipts,
 * identities, events, review items, coverage, plans, audit and payment links,
 * the rebuilt `card_transactions`, the legacy backfill and the 113 invariant
 * triggers. Every SQL statement is the design's own text (cardSyncSchemaSql.ts).
 *
 * It runs inside the constructor's IMMEDIATE transaction, after the
 * compatibility check under the write lock and before syncCardGuards, which
 * re-checks every stored row of the 31 card tables and installs their guards.
 * Plain CREATE throughout: an object that already exists aborts the upgrade
 * instead of being adopted. Any failure rolls the whole transaction back, so
 * the database stays a v14 database, byte for byte.
 *
 * This module and the ledger writer are the only code that inserts
 * identities and their content baselines.
 */
export const CARD_SYNC_VERSION = 15;

/** The fixed label of every account's legacy source scope: v1 file rows, whose card is not recorded. */
export const LEGACY_SCOPE_LABEL = 'File imports (card not recorded)';

/** The single namespace of every v1 file row, whatever its source slug (design §2.1, Q1). */
export const LEGACY_NAMESPACE = 'legacy-file:v1';

const ISSUERS = ['amex', 'chase', 'citi', 'wellsfargo'] as const;

const exec = (db: DB, block: CardSyncBlock) => db.exec(CARD_SYNC_BLOCKS[block]);
const count = (db: DB, sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;

function refuse(precondition: string, problem: string): never {
  throw new HoldrRefusal(
    `card schema v15 upgrade refused (${precondition}): ${problem}. Nothing was changed; ` +
      'restore a backup made before those rows were written, or fix them with the build that wrote them, then open the database again.',
  );
}

/**
 * Step 0: read-only preconditions the rebuild and the backfill rely on. Each
 * refusal names the precondition and a count, never a stored value.
 */
export function assertCardSyncPreconditions(db: DB): void {
  // P1: nothing but card_transactions itself and its own indexes and triggers
  // names the table, so the rename in the rebuild rewrites no other object.
  const mentions = count(db, `SELECT count(*) AS n FROM sqlite_master
     WHERE tbl_name <> 'card_transactions' AND instr(lower(sql), 'card_transactions') > 0`);
  if (mentions > 0) refuse('P1', `${mentions} schema object(s) besides card_transactions refer to it`);
  // P2: the composite (account, currency) foreign key of the rebuilt table holds for every row.
  const currency = count(db, `SELECT count(*) AS n FROM card_transactions t JOIN card_accounts a ON a.id = t.card_account_id
     WHERE t.currency IS NOT a.currency`);
  if (currency > 0) refuse('P2', `${currency} card transaction(s) are in a currency other than their card account's`);
  // P3: v13's unique keys still hold, so the backfill makes exactly one identity per key.
  const duplicated = count(db, `SELECT count(*) AS n FROM (
       SELECT 1 FROM card_transactions WHERE external_id_hash IS NOT NULL GROUP BY card_account_id, external_id_hash HAVING count(*) > 1
       UNION ALL
       SELECT 1 FROM card_transactions WHERE fingerprint IS NOT NULL GROUP BY card_account_id, fingerprint HAVING count(*) > 1)`);
  if (duplicated > 0) refuse('P3', `${duplicated} dedupe key(s) are stored more than once for one card account`);
  // P4: every row's account and batch exist.
  const dangling = (db.prepare('PRAGMA foreign_key_check(card_transactions)').all() as unknown[]).length;
  if (dangling > 0) refuse('P4', `${dangling} card transaction reference(s) point at a missing card account or import batch`);
  // P5: v1 provenance in v1's own grammars, which v15's tables CHECK when the backfill copies it.
  let outside = 0;
  for (const [value] of db.prepare('SELECT source FROM card_transactions UNION ALL SELECT source FROM card_import_batches')
    .raw().iterate() as IterableIterator<[unknown]>) {
    if (typeof value !== 'string' || !CARD_SLUG.test(value)) outside += 1;
  }
  for (const [value] of db.prepare('SELECT parser_version FROM card_import_batches').raw().iterate() as IterableIterator<[unknown]>) {
    if (typeof value !== 'string' || !CARD_PARSER_VERSION.test(value)) outside += 1;
  }
  if (outside > 0) refuse('P5', `${outside} stored import source or parser version value(s) are outside the v1 grammar`);
}

interface V14Row {
  id: string;
  card_account_id: string;
  external_id_hash: string | null;
  fingerprint: string | null;
  transaction_date: string;
  posted_date: string | null;
  status: 'pending' | 'posted' | 'removed';
  amount_minor: number;
  original_amount_minor: number | null;
  original_currency: string | null;
  kind: string;
  description: string;
  merchant: string | null;
  issuer_category: string | null;
  import_batch_id: string | null;
  removed_from_status: 'pending' | 'posted' | null;
}

/**
 * Step 11 (§3.2): one legacy identity per row (removed rows included) with
 * the content it was observed with as its replay baseline, and one file
 * coverage window per batch that recorded a coverage. Ids come from the
 * CSPRNG; the content digest is the writer's own rowContentDigest.
 */
function backfillLegacyLedger(db: DB, legacyScope: ReadonlyMap<string, string>, now: string): void {
  const insertIdentity = db.prepare(`INSERT INTO card_source_identities (id, card_account_id, source_scope_id, source_scope_kind,
      namespace, namespace_kind, id_hash, canonical_transaction_id, status, first_seen_status, created_origin, import_batch_id,
      first_observation_id, created_at, last_seen_at, last_seen_run_id)
    VALUES (?, ?, ?, 'legacy', '${LEGACY_NAMESPACE}', 'legacy-file', ?, ?, 'active', ?, 'migration', ?, NULL, ?, NULL, NULL)`);
  const insertContent = db.prepare(`INSERT INTO card_identity_contents (identity_id, content_digest, resolution, recorded_at)
    VALUES (?, ?, 'migration-baseline', ?)`);
  const rows = db.prepare(`SELECT id, card_account_id, external_id_hash, fingerprint, transaction_date, posted_date, status,
      amount_minor, original_amount_minor, original_currency, kind, description, merchant, issuer_category, import_batch_id,
      removed_from_status
    FROM card_transactions ORDER BY rowid`).all() as V14Row[];
  for (const t of rows) {
    // The status the row was observed with: its recorded prior status, else
    // its status, else (a legacy removal) posted when it had a posted date.
    const seen = t.removed_from_status ?? (t.status === 'removed' ? (t.posted_date ? 'posted' : 'pending') : t.status);
    const identityId = newCardSyncRowId('card-ident-');
    insertIdentity.run(identityId, t.card_account_id, legacyScope.get(t.card_account_id), t.external_id_hash ?? t.fingerprint, t.id,
      seen, t.import_batch_id, now);
    insertContent.run(identityId, rowContentDigest({
      transactionDate: t.transaction_date, postedDate: t.posted_date, status: seen, amountMinor: t.amount_minor, kind: t.kind,
      description: t.description, merchant: t.merchant, issuerCategory: t.issuer_category,
      originalAmountMinor: t.original_amount_minor, originalCurrency: t.original_currency,
    }), now);
  }
  const insertWindow = db.prepare(`INSERT INTO card_coverage_windows (id, card_account_id, card_scope_id, source_kind, source,
      import_batch_id, observation_set_id, entry_ordinal, status, requested_start, requested_end, requested_basis, observed_start,
      observed_end, observed_basis, claimed_completeness, verified_completeness, termination, page_count, evidence, ledger_state,
      observed_at, recorded_at, updated_at)
    VALUES (?, ?, ?, 'file', ?, ?, NULL, NULL, 'any', ?, ?, 'posted-or-transaction', NULL, NULL, NULL, 'unknown', 'unknown', NULL,
      NULL, 'file-declared', 'committed', NULL, ?, ?)`);
  const batches = db.prepare(`SELECT id, card_account_id, source, coverage_start, coverage_end FROM card_import_batches
    WHERE coverage_start IS NOT NULL ORDER BY rowid`).all() as Array<{
    id: string; card_account_id: string; source: string; coverage_start: string; coverage_end: string;
  }>;
  for (const b of batches) {
    insertWindow.run(newCardSyncRowId('card-cover-'), b.card_account_id, legacyScope.get(b.card_account_id), b.source, b.id,
      b.coverage_start, b.coverage_end, now, now);
  }
}

/** The tables the v15 migration creates, in the design's order (card_transactions is rebuilt). */
export const CARD_SYNC_V15_TABLES = [
  'card_sync_sources', 'card_sync_namespaces', 'card_scopes', 'card_source_bindings', 'card_source_binding_scopes',
  'card_sync_policy', 'card_sync_issuer_policy', 'card_sync_pairings', 'card_sync_pairing_scopes', 'card_sync_devices',
  'card_sync_device_scopes', 'card_sync_runs', 'card_transactions', 'card_sync_observation_sets', 'card_sync_set_card_hints',
  'card_source_observations', 'card_observation_secondary_ids', 'card_sync_payload_receipts', 'card_transaction_versions',
  'card_source_identities', 'card_identity_contents', 'card_transaction_events', 'card_reconciliation_suggestions',
  'card_reconciliation_candidates', 'card_coverage_windows', 'card_sync_commit_plans', 'card_sync_plan_actions',
  'card_sync_audit_events', 'card_payment_links',
] as const;

/** Step 13: the upgrade's own accounting. Any mismatch throws, and the transaction rolls back. */
function assertMigrated(db: DB, before: number): void {
  const checks: Array<[string, number, number]> = [
    ['card transactions kept', count(db, 'SELECT count(*) AS n FROM card_transactions'), before],
    ['one legacy scope per card account', count(db, "SELECT count(*) AS n FROM card_scopes WHERE kind = 'legacy'"),
      count(db, 'SELECT count(*) AS n FROM card_accounts')],
    ['one identity per card transaction', count(db, 'SELECT count(*) AS n FROM card_source_identities'), before],
    ['one content baseline per identity', count(db, 'SELECT count(*) AS n FROM card_identity_contents'), before],
    ['one coverage window per covered import', count(db, 'SELECT count(*) AS n FROM card_coverage_windows'),
      count(db, 'SELECT count(*) AS n FROM card_import_batches WHERE coverage_start IS NOT NULL')],
  ];
  for (const [what, got, want] of checks) {
    if (got !== want) throw new HoldrRefusal(`card schema v15 upgrade failed its own check (${what}); nothing was changed`);
  }
  // Card tables only, so unrelated data can never block the card upgrade.
  for (const table of [...CARD_SYNC_V15_TABLES, 'card_accounts', 'card_import_batches']) {
    if ((db.prepare(`PRAGMA foreign_key_check(${table})`).all() as unknown[]).length > 0) {
      throw new HoldrRefusal(`card schema v15 upgrade failed its own check (foreign keys of ${table}); nothing was changed`);
    }
  }
}

/**
 * The v14 → v15 upgrade, steps 0–14 of the design's §3.1, in the caller's
 * transaction. `now` is the repository clock as an ISO timestamp.
 */
export function migrateCardSyncSchema(db: DB, now: string): void {
  assertCardSyncPreconditions(db);
  const before = count(db, 'SELECT count(*) AS n FROM card_transactions');

  exec(db, '2.1');                                         // 1: registries and their seed rows
  exec(db, '2.2');                                         // 2: ledger_revision and FK-target indexes
  exec(db, '2.3');                                         // 3: card scopes, one legacy scope per account
  const insertScope = db.prepare(`INSERT INTO card_scopes (id, card_account_id, kind, holder_alias, last4, label, status, version,
      confirmed_by_ref, confirmed_at, retired_at, created_at, updated_at)
    VALUES (?, ?, 'legacy', 'unknown', NULL, ?, 'active', 1, NULL, NULL, NULL, ?, ?)`);
  const legacyScope = new Map<string, string>();
  for (const { id } of db.prepare('SELECT id FROM card_accounts ORDER BY rowid').all() as Array<{ id: string }>) {
    const scopeId = newCardSyncId('scp_');
    insertScope.run(scopeId, id, LEGACY_SCOPE_LABEL, now, now);
    legacyScope.set(id, scopeId);
  }
  exec(db, '2.4');                                         // 4: bindings and binding scopes
  exec(db, '2.5');                                         // 5: policy, with a fresh generation; four disabled issuers
  db.prepare(`INSERT INTO card_sync_policy (id, revision, paused, paused_at, authorization_generation, generation_changed_at,
      recovery_completed_at, updated_by_ref, updated_at)
    VALUES ('card-sync-policy', 1, 0, NULL, ?, ?, NULL, NULL, ?)`).run(newCardSyncId('agn_'), now, now);
  const insertIssuer = db.prepare(`INSERT INTO card_sync_issuer_policy (id, enabled, enabled_at, approved_contract_version,
      risk_acknowledged_at, main_passive_accepted, revision, updated_by_ref, updated_at)
    VALUES (?, 0, NULL, NULL, NULL, 0, 1, NULL, ?)`);
  for (const issuer of ISSUERS) insertIssuer.run(issuer, now);
  exec(db, '2.6');                                         // 6: pairings, devices and their scopes
  exec(db, '2.7');                                         // 7: runs
  exec(db, '3.4a');                                        // 8: rebuild card_transactions, rowids kept
  exec(db, '2.10');
  const copied = db.prepare(CARD_SYNC_BLOCKS['3.4b'].replace(/^-- @block .*\n/, '').replace(/;\s*$/, ''))
    .run({ migrated_at: now }).changes;
  if (copied !== before) throw new HoldrRefusal('card schema v15 upgrade failed its own check (card transactions copied); nothing was changed');
  exec(db, '3.4c');
  exec(db, '2.8');                                         // 9: after the rebuild, so their FKs name the new table
  for (const block of ['2.9', '2.11', '2.12', '2.13', '2.14', '2.15', '2.16', '2.17', '2.18'] as const) exec(db, block);   // 10
  backfillLegacyLedger(db, legacyScope, now);              // 11
  exec(db, '2.19');                                        // 12: invariant triggers, after the plain backfill inserts
  assertMigrated(db, before);                              // 13
  db.prepare(`INSERT INTO card_sync_audit_events (id, event_type, actor_kind, actor_ref, row_count, created_at)
    VALUES (?, 'migration-completed', 'migration', NULL, ?, ?)`).run(newCardSyncRowId('card-audit-'), before, now);   // 14
}
