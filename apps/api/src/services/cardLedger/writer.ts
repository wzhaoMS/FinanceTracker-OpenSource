import type { Database as DB, Statement } from 'better-sqlite3';

import { newCardSyncId, newCardSyncRowId, randomCardSyncLetters, rowContentDigest, type CardRowContent } from '../cardSyncDigests.js';
import { HoldrRefusal } from '../dbErrors.js';
import { LEGACY_NAMESPACE, LEGACY_SCOPE_LABEL } from './migrateV15.js';

/**
 * The ledger writer's v1 entry points on card-sync schema v15 (E1b design
 * §4.1, §4.10.4, §5.7), with Phase 4's outcomes: what a v1 import inserts and
 * promotes, and the Spending tab's category, notes, dismiss and restore. Each
 * change also writes what records it, in the caller's transaction: the source
 * identity and its replay content, the ledger event, the reversal marker, and
 * the card account's ledger revision. The invariant triggers check the
 * result; this module only has to be right, the database refuses anything
 * else.
 *
 * Besides the v15 migration, nothing else writes card transactions, source
 * identities or their contents (a static test keeps it so).
 */

/**
 * Who an event names: the signed-in owner (`usr_` reference), a paired
 * device committing its own auto-eligible plan (`dev_`), or the system for a
 * service-principal v1 import.
 */
export type LedgerActor = { kind: 'session'; ref: string } | { kind: 'device'; ref: string } | { kind: 'system' };

const ACTOR_REF = /^usr_[a-p]{32}$/;

/** A session actor from its `usr_` reference (cardSyncActorRef), refused unless it has that exact shape. */
export function sessionActor(actorRef: unknown): LedgerActor {
  if (typeof actorRef !== 'string' || !ACTOR_REF.test(actorRef)) {
    throw new HoldrRefusal('a card transaction change needs the acting owner');
  }
  return { kind: 'session', ref: actorRef };
}

/** The values a v1 file row brings; the content digest covers exactly the bank fields among them. */
export interface FileRowValues {
  transactionDate: string;
  postedDate: string | null;
  status: 'pending' | 'posted';
  amountMinor: number;
  originalAmountMinor: number | null;
  originalCurrency: string | null;
  kind: string;
  description: string;
  merchant: string | null;
  issuerCategory: string | null;
}

/** A stored row a v1 key resolves to, through its legacy identity. */
export interface LegacyHit {
  identityId: string;
  identityStatus: 'active' | 'detached';
  transactionId: string;
  status: 'pending' | 'posted' | 'removed';
  dismissedAt: string | null;
  revision: number;
  removedReason: string | null;
  removedFromStatus: 'pending' | 'posted' | null;
}

interface StoredValues {
  id: string;
  status: 'pending' | 'posted' | 'removed';
  transaction_date: string;
  posted_date: string | null;
  amount_minor: number;
  original_amount_minor: number | null;
  original_currency: string | null;
  kind: string;
  revision: number;
  card_scope_id: string;
}

interface OwnerFields {
  id: string;
  cardAccountId: string;
  status: 'pending' | 'posted' | 'removed';
  userCategory: string | null;
  notes: string | null;
  revision: number;
}

/** A new v1 row for insertFileRows: its dedupe key and its values. */
export interface NewFileRow {
  key: string;
  row: FileRowValues;
}

/** One ledger event (§2.13); the optional fields are NULL unless given. */
export type LedgerEvent = {
  transactionId: string; cardAccountId: string; type: string; revision: number; origin: 'file' | 'extension' | 'session';
  actor: LedgerActor; reason: string; importBatchId?: string | null; identityId?: string | null;
  runId?: string | null; observationSetId?: string | null; observationId?: string | null; planId?: string | null;
  planDigest?: string | null; causeEventId?: string | null; reversesEventId?: string | null;
  fromStatus?: string | null; toStatus?: string | null; fromAmountMinor?: number | null; toAmountMinor?: number | null;
  fromTransactionDate?: string | null; toTransactionDate?: string | null; fromPostedDate?: string | null; toPostedDate?: string | null;
  fromKind?: string | null; toKind?: string | null; fromScopeId?: string | null; toScopeId?: string | null;
  fromCanonicalId?: string | null; toCanonicalId?: string | null; editFields?: number; notify?: boolean;
  relatedTransactionId?: string | null; editResolution?: 'survivor' | 'loser-category' | 'loser-notes' | 'loser-both' | null;
};

/** The tracked values of a row (§2.11), as a value change writes them. */
export interface TrackedValues {
  status: 'pending' | 'posted' | 'removed';
  transactionDate: string;
  postedDate: string | null;
  amountMinor: number;
  originalAmountMinor: number | null;
  originalCurrency: string | null;
  kind: string;
  description: string;
  merchant: string | null;
  issuerCategory: string | null;
  cardScopeId: string;
  removedReason: string | null;
  removedFromStatus: 'pending' | 'posted' | null;
  removedAt: string | null;
  mergedIntoId: string | null;
  dismissedAt: string | null;
}

/** A new identity: its tuple, the row it names and where it came from (§2.12). */
export interface NewIdentity {
  cardAccountId: string;
  scopeId: string;
  scopeKind: 'known' | 'unknown' | 'legacy';
  namespace: string;
  namespaceKind: 'legacy-file' | 'stable' | 'capture';
  idHash: string;
  canonicalId: string;
  firstSeenStatus: 'pending' | 'posted';
  createdOrigin: 'file' | 'extension' | 'session';
  importBatchId: string | null;
  firstObservationId: string | null;
  lastSeenRunId: string | null;
}

/**
 * Rows per multi-row INSERT. On these guarded tables a single-row INSERT
 * costs about twice what one row of a multi-row INSERT does (each statement
 * pays for its own statement journal and trigger set-up), so writing a chunk
 * per statement is most of what keeps a 2,000-row v1 import inside design
 * §7.11's P4 (review r1, finding 2). The guards and invariant triggers still
 * check every row, and a refusal still aborts the whole import.
 */
const INSERT_CHUNK_ROWS = 250;
/** SQLite's limit on bound parameters per statement (SQLITE_MAX_VARIABLE_NUMBER, 32,766 since 3.32). */
const MAX_BOUND_PARAMETERS = 32_766;
/** Values per row of a promotion's UPDATE: the row, its revision, its new values and its reversal marker. */
const PROMOTION_COLUMNS = 12;

const TRANSACTION_COLUMNS = ['id', 'card_account_id', 'source', 'external_id_hash', 'fingerprint', 'transaction_date', 'posted_date',
  'status', 'amount_minor', 'currency', 'original_amount_minor', 'original_currency', 'kind', 'description', 'merchant',
  'issuer_category', 'import_batch_id', 'card_scope_id'] as const;
const IDENTITY_COLUMNS = ['id', 'card_account_id', 'source_scope_id', 'source_scope_kind', 'namespace', 'namespace_kind', 'id_hash',
  'canonical_transaction_id', 'status', 'first_seen_status', 'created_origin', 'import_batch_id', 'first_observation_id', 'created_at',
  'last_seen_at', 'last_seen_run_id'] as const;
const CONTENT_COLUMNS = ['identity_id', 'content_digest', 'resolution', 'recorded_at'] as const;
const EVENT_COLUMNS = ['id', 'card_transaction_id', 'card_account_id', 'event_type', 'transaction_revision', 'origin', 'actor_kind',
  'actor_ref', 'import_batch_id', 'identity_id', 'related_transaction_id', 'reason', 'from_status', 'to_status', 'from_amount_minor',
  'to_amount_minor', 'from_transaction_date', 'to_transaction_date', 'from_posted_date', 'to_posted_date', 'from_kind', 'to_kind',
  'to_scope_id', 'edit_fields', 'edit_resolution', 'notify', 'created_at', 'run_id', 'observation_set_id', 'observation_id', 'plan_id',
  'plan_digest', 'cause_event_id', 'reverses_event_id', 'from_scope_id', 'from_canonical_id', 'to_canonical_id'] as const;
// Written out per table, so a search for the statements that write the ledger finds each of them here.
const INSERT_TRANSACTIONS = `INSERT INTO card_transactions (${TRANSACTION_COLUMNS.join(', ')}) VALUES`;
const INSERT_IDENTITIES = `INSERT INTO card_source_identities (${IDENTITY_COLUMNS.join(', ')}) VALUES`;
const INSERT_CONTENTS = `INSERT INTO card_identity_contents (${CONTENT_COLUMNS.join(', ')}) VALUES`;
const INSERT_EVENTS = `INSERT INTO card_transaction_events (${EVENT_COLUMNS.join(', ')}) VALUES`;
const SYNC_TRANSACTION_COLUMNS = [...TRANSACTION_COLUMNS, 'first_sync_run_id'] as const;
const INSERT_SYNC_TRANSACTIONS = `INSERT INTO card_transactions (${SYNC_TRANSACTION_COLUMNS.join(', ')}) VALUES`;

const contentOf = (row: FileRowValues): CardRowContent => ({
  transactionDate: row.transactionDate, postedDate: row.postedDate, status: row.status, amountMinor: row.amountMinor,
  kind: row.kind, description: row.description, merchant: row.merchant, issuerCategory: row.issuerCategory,
  originalAmountMinor: row.originalAmountMinor, originalCurrency: row.originalCurrency,
});

/**
 * One writer per transaction: statements prepared once, the clock read once
 * (`now`, an ISO timestamp), and the accounts whose ledger changed counted so
 * each moves its ledger revision exactly once (W12) when the caller finishes.
 */
export class CardLedgerWriter {
  private readonly changedAccounts = new Set<string>();
  private readonly statements = new Map<string, Statement>();
  /**
   * Contents and events not yet written, in the order they were recorded:
   * nothing reads them before the writer finishes (no trigger, and
   * knowsContent flushes first), so they go in as multi-row INSERTs.
   */
  private readonly pendingContents: unknown[][] = [];
  /** (identity, content) pairs recorded through rememberContent, written or not. */
  private readonly remembered = new Set<string>();
  private readonly pendingEvents: unknown[][] = [];

  constructor(private readonly db: DB, private readonly now: string) {}

  private prepared(sql: string): Statement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** The account's legacy source scope: every v1 row is attributed to it until a person decides otherwise. */
  legacyScopeOf(cardAccountId: string): string {
    const row = this.prepared("SELECT id FROM card_scopes WHERE card_account_id = ? AND kind = 'legacy'")
      .get(cardAccountId) as { id: string } | undefined;
    if (!row) throw new HoldrRefusal('card account has no legacy card scope');
    return row.id;
  }

  /** A new account's legacy scope, created in the account's own transaction (design §3.2, M15). */
  createLegacyScope(cardAccountId: string): string {
    const id = newCardSyncId('scp_');
    this.prepared(`INSERT INTO card_scopes (id, card_account_id, kind, holder_alias, last4, label, status, version,
        confirmed_by_ref, confirmed_at, retired_at, created_at, updated_at)
      VALUES (?, ?, 'legacy', 'unknown', NULL, ?, 'active', 1, NULL, NULL, NULL, ?, ?)`)
      .run(id, cardAccountId, LEGACY_SCOPE_LABEL, this.now, this.now);
    return id;
  }

  /** The stored row a v1 key names: one probe of the identity tuple (account, legacy scope, legacy-file:v1, key). */
  findLegacy(cardAccountId: string, legacyScopeId: string, key: string): LegacyHit | undefined {
    const row = this.prepared(`SELECT i.id AS identityId, i.status AS identityStatus, t.id AS transactionId, t.status,
        t.dismissed_at AS dismissedAt, t.revision, t.removed_reason AS removedReason, t.removed_from_status AS removedFromStatus
      FROM card_source_identities i JOIN card_transactions t ON t.id = i.canonical_transaction_id
      WHERE i.card_account_id = ? AND i.source_scope_id = ? AND i.namespace = '${LEGACY_NAMESPACE}' AND i.id_hash = ?`)
      .get(cardAccountId, legacyScopeId, key) as LegacyHit | undefined;
    return row;
  }

  /** True when the identity tuple (account, legacy scope, legacy-file:v1, key) exists, whatever its row or status. */
  legacyKeyTaken(cardAccountId: string, legacyScopeId: string, key: string): boolean {
    return this.prepared(`SELECT 1 FROM card_source_identities
      WHERE card_account_id = ? AND source_scope_id = ? AND namespace = '${LEGACY_NAMESPACE}' AND id_hash = ?`)
      .get(cardAccountId, legacyScopeId, key) !== undefined;
  }

  /** True when this content is already known for the identity: a replay, never a change (§4.3). */
  knowsContent(identityId: string, row: FileRowValues): boolean {
    this.flush();
    return this.prepared('SELECT 1 FROM card_identity_contents WHERE identity_id = ? AND content_digest = ?')
      .get(identityId, rowContentDigest(contentOf(row))) !== undefined;
  }

  /**
   * v1 rows new to the ledger, in order: each a canonical row on the legacy
   * scope at revision 1, its legacy identity (first seen with the row's
   * status), its content as `inserted`, and its `created` event. Written a
   * table at a time in multi-row INSERTs (rows, then identities, contents
   * and events), each table's rows in the given order. Returns the new
   * transaction ids.
   */
  insertFileRows(input: {
    cardAccountId: string; legacyScopeId: string; batchId: string; source: string; currency: string; actor: LedgerActor;
    rows: readonly NewFileRow[];
  }): string[] {
    const { cardAccountId, legacyScopeId, batchId, source, currency, actor, rows } = input;
    if (rows.length === 0) return [];
    const transactionIds = rows.map(() => `card-txn-${randomCardSyncLetters()}`);
    const identityIds = rows.map(() => newCardSyncRowId('card-ident-'));
    this.insertMany(INSERT_TRANSACTIONS, TRANSACTION_COLUMNS.length, rows.map(({ key, row }, i) => [
      transactionIds[i], cardAccountId, source, key.startsWith('xid') ? key : null, key.startsWith('cfp') ? key : null,
      row.transactionDate, row.postedDate, row.status, row.amountMinor, currency, row.originalAmountMinor, row.originalCurrency,
      row.kind, row.description, row.merchant, row.issuerCategory, batchId, legacyScopeId,
    ]));
    this.insertMany(INSERT_IDENTITIES, IDENTITY_COLUMNS.length, rows.map(({ key, row }, i) => [
      identityIds[i], cardAccountId, legacyScopeId, 'legacy', LEGACY_NAMESPACE, 'legacy-file', key, transactionIds[i], 'active',
      row.status, 'file', batchId, null, this.now, null, null,
    ]));
    rows.forEach(({ row }, i) => {
      this.recordContent(identityIds[i], row, 'inserted');
      this.event({
        transactionId: transactionIds[i], cardAccountId, type: 'created', revision: 1, origin: 'file', actor, importBatchId: batchId,
        identityId: identityIds[i], reason: 'insert', toStatus: row.status, toAmountMinor: row.amountMinor,
        toTransactionDate: row.transactionDate, toPostedDate: row.postedDate, toKind: row.kind, toScopeId: legacyScopeId,
      });
    });
    this.changedAccounts.add(cardAccountId);
    return transactionIds;
  }

  /**
   * v1 posted rows whose keys name pending rows, or pending rows the owner
   * dismissed: each row takes its posted values, keeping its id, custom
   * category and notes. An issuer-driven promotion of a pending row clears
   * the reversal marker; restoring a dismissal on the signed-in owner's word
   * (`promoteDismissedMatches`, or a fingerprint match the owner confirmed)
   * is a session decision that leaves the row live, so its marker names the
   * revision it replaced and an exact revert stays possible (§4.6, §4.11).
   * The same restore through the service token is not session-decided and
   * clears the marker (§2.10), so it is never offered for undo.
   * Every row is updated at the revision read here, in multi-row UPDATEs;
   * any row that moved meanwhile refuses the whole import.
   */
  promoteFileRows(input: {
    cardAccountId: string; batchId: string; actor: LedgerActor; rows: ReadonlyArray<{ hit: LegacyHit; row: FileRowValues }>;
  }): void {
    const { cardAccountId, batchId, actor, rows } = input;
    if (rows.length === 0) return;
    const befores = rows.map(({ hit }) => this.stored(hit.transactionId));
    // One UPDATE … FROM per chunk needs each card transaction once; a v1 key names its own row, so two never share one.
    if (new Set(befores.map((before) => before.id)).size !== befores.length) {
      throw new HoldrRefusal('two rows of one import name the same card transaction');
    }
    const perStatement = Math.min(INSERT_CHUNK_ROWS, Math.floor(MAX_BOUND_PARAMETERS / PROMOTION_COLUMNS));
    const tuple = `(${Array<string>(PROMOTION_COLUMNS).fill('?').join(', ')})`;
    for (let start = 0; start < rows.length; start += perStatement) {
      const chunk = rows.slice(start, start + perStatement);
      const changed = this.prepared(`WITH v(id, revision, transaction_date, posted_date, amount_minor, original_amount_minor,
            original_currency, kind, description, merchant, issuer_category, marker)
          AS (VALUES ${Array<string>(chunk.length).fill(tuple).join(', ')})
        UPDATE card_transactions
          SET status = 'posted', transaction_date = v.transaction_date, posted_date = v.posted_date, amount_minor = v.amount_minor,
              original_amount_minor = v.original_amount_minor, original_currency = v.original_currency, kind = v.kind,
              description = v.description, merchant = v.merchant, issuer_category = v.issuer_category, dismissed_at = NULL,
              removed_reason = NULL, removed_from_status = NULL, removed_at = NULL, reversal_snapshot_revision = v.marker,
              revision = card_transactions.revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          FROM v
        WHERE card_transactions.id = v.id AND card_transactions.revision = v.revision`)
        .run(chunk.flatMap(({ row }, i) => {
          const before = befores[start + i];
          return [before.id, before.revision, row.transactionDate, row.postedDate, row.amountMinor, row.originalAmountMinor,
            row.originalCurrency, row.kind, row.description, row.merchant, row.issuerCategory,
            before.status === 'removed' && actor.kind === 'session' ? before.revision : null];
        })).changes;
      if (changed !== chunk.length) throw new HoldrRefusal('card transaction changed while it was being promoted');
    }
    rows.forEach(({ hit, row }, i) => {
      const before = befores[i];
      const restoring = before.status === 'removed';
      this.recordContent(hit.identityId, row, 'promoted');
      const material = before.transaction_date !== row.transactionDate || before.posted_date !== row.postedDate
        || before.amount_minor !== row.amountMinor || before.kind !== row.kind
        || before.original_amount_minor !== row.originalAmountMinor || before.original_currency !== row.originalCurrency;
      const common = { transactionId: hit.transactionId, cardAccountId, revision: before.revision + 1, origin: 'file' as const, actor,
        importBatchId: batchId, identityId: hit.identityId };
      this.event({
        ...common, type: 'promoted', reason: restoring ? 'same-transaction' : 'pending-posted', fromStatus: before.status,
        toStatus: 'posted', fromAmountMinor: before.amount_minor, toAmountMinor: row.amountMinor,
        fromTransactionDate: before.transaction_date, toTransactionDate: row.transactionDate, fromPostedDate: before.posted_date,
        toPostedDate: row.postedDate, fromKind: before.kind, toKind: row.kind, notify: material,
      });
      if (restoring) this.event({ ...common, type: 'restored', reason: 'restore', fromStatus: 'removed', toStatus: 'posted' });
    });
    this.changedAccounts.add(cardAccountId);
  }

  /**
   * Phase 4's PATCH on one row, in one update: custom category and notes
   * (a `user-edited` event, no ledger revision), dismissing a pending row
   * (removed as `dismissed`, from `pending`) or restoring a dismissed one (an
   * owner decision that leaves the row live, so reversible). Nothing changes,
   * and nothing is recorded, when the patch changes nothing.
   */
  editOwnerFields(input: {
    transactionId: string; userCategory: string | null; notes: string | null; status: 'pending' | 'posted' | 'removed';
    actor: LedgerActor;
  }): boolean {
    const current = this.prepared(`SELECT id, card_account_id AS cardAccountId, status, user_category AS userCategory,
        notes, revision, reversal_snapshot_revision AS marker, dismissed_at AS dismissedAt
      FROM card_transactions WHERE id = ?`).get(input.transactionId) as {
      id: string; cardAccountId: string; status: 'pending' | 'posted' | 'removed'; userCategory: string | null; notes: string | null;
      revision: number; marker: number | null; dismissedAt: string | null;
    } | undefined;
    if (!current) return false;
    const editFields = (input.userCategory !== current.userCategory ? 1 : 0) | (input.notes !== current.notes ? 2 : 0);
    const dismissing = current.status === 'pending' && input.status === 'removed';
    const restoring = current.status === 'removed' && input.status === 'pending';
    if (editFields === 0 && !dismissing && !restoring) return false;
    const revision = current.revision + 1;
    let changed: number;
    if (dismissing) {
      changed = this.prepared(`UPDATE card_transactions
          SET user_category = ?, notes = ?, status = 'removed', removed_reason = 'dismissed', removed_from_status = 'pending',
              removed_at = ?, dismissed_at = ?, reversal_snapshot_revision = NULL, revision = revision + 1,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND revision = ?`)
        .run(input.userCategory, input.notes, this.now, this.now, current.id, current.revision).changes;
    } else if (restoring) {
      changed = this.prepared(`UPDATE card_transactions
          SET user_category = ?, notes = ?, status = 'pending', removed_reason = NULL, removed_from_status = NULL, removed_at = NULL,
              dismissed_at = NULL, reversal_snapshot_revision = ?, revision = revision + 1,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND revision = ?`)
        .run(input.userCategory, input.notes, current.revision, current.id, current.revision).changes;
    } else {
      changed = this.prepared(`UPDATE card_transactions
          SET user_category = ?, notes = ?, revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND revision = ?`)
        .run(input.userCategory, input.notes, current.id, current.revision).changes;
    }
    if (changed !== 1) throw new HoldrRefusal('card transaction changed while it was being edited');
    const common = { transactionId: current.id, cardAccountId: current.cardAccountId, revision, origin: 'session' as const,
      actor: input.actor };
    if (dismissing) this.event({ ...common, type: 'removed', reason: 'dismissed', fromStatus: 'pending', toStatus: 'removed' });
    if (restoring) this.event({ ...common, type: 'restored', reason: 'restore', fromStatus: 'removed', toStatus: 'pending' });
    if (editFields > 0) this.event({ ...common, type: 'user-edited', reason: 'user-edit', editFields });
    if (dismissing || restoring) this.changedAccounts.add(current.cardAccountId);
    return true;
  }

  /**
   * `dismissPendingIds`: a pending row the owner dismisses together with an
   * import (a complete, closed statement leaves it out). It is dismissed and
   * kept, so its identities still answer for it; the event names the import
   * it came with.
   */
  dismissWithImport(input: { transactionId: string; cardAccountId: string; batchId: string; actor: LedgerActor }): void {
    this.dismissPending({
      transactionId: input.transactionId, cardAccountId: input.cardAccountId, actor: input.actor, origin: 'file',
      importBatchId: input.batchId,
      refusal: 'a pending row to dismiss is no longer pending in this card account; preview the import again',
    });
  }

  /**
   * `postedAs`: the owner's word that a pending row posted as another, posted
   * row of its card account (typically under another issuer reference). The
   * posted row takes the pending row's custom category and notes where it
   * has none, as a `user-edited` event whose `edit_resolution` says which it
   * took and whose related row is the pending one. The pending row is then
   * dismissed and kept, its event naming the posted row: its identities
   * still answer for it on any later import, and the owner can restore it.
   */
  dismissAsPostedElsewhere(input: { transactionId: string; postedId: string; actor: LedgerActor }): void {
    const owned = this.prepared(`SELECT id, card_account_id AS cardAccountId, status, user_category AS userCategory, notes, revision
      FROM card_transactions WHERE id = ?`);
    const pending = owned.get(input.transactionId) as OwnerFields | undefined;
    const posted = owned.get(input.postedId) as OwnerFields | undefined;
    if (!pending || pending.status !== 'pending' || !posted || posted.status !== 'posted'
      || posted.cardAccountId !== pending.cardAccountId) {
      throw new HoldrRefusal('postedAs must be a posted transaction of the same card account and currency');
    }
    const userCategory = posted.userCategory ?? pending.userCategory;
    const notes = posted.notes ?? pending.notes;
    const editFields = (userCategory !== posted.userCategory ? 1 : 0) | (notes !== posted.notes ? 2 : 0);
    if (editFields > 0) {
      const changed = this.prepared(`UPDATE card_transactions
          SET user_category = ?, notes = ?, revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND revision = ?`).run(userCategory, notes, posted.id, posted.revision).changes;
      if (changed !== 1) throw new HoldrRefusal('card transaction changed while it was being edited');
      this.event({
        transactionId: posted.id, cardAccountId: posted.cardAccountId, type: 'user-edited', revision: posted.revision + 1,
        origin: 'session', actor: input.actor, reason: 'user-edit', editFields,
        editResolution: editFields === 3 ? 'loser-both' : editFields === 1 ? 'loser-category' : 'loser-notes',
        relatedTransactionId: pending.id,
      });
    }
    this.dismissPending({
      transactionId: pending.id, cardAccountId: pending.cardAccountId, actor: input.actor, origin: 'session',
      relatedTransactionId: posted.id, refusal: 'only a pending card transaction can be matched to its posted row',
    });
  }

  /**
   * Writes the recorded contents and events, then moves the ledger revision
   * of every account this writer changed, once each (W12). Call last, in the
   * same transaction.
   */
  finish(): void {
    this.flush();
    for (const cardAccountId of this.changedAccounts) {
      this.prepared('UPDATE card_accounts SET ledger_revision = ledger_revision + 1 WHERE id = ?').run(cardAccountId);
    }
    this.changedAccounts.clear();
  }

  /**
   * A pending row dismissed on the owner's word and kept: removed as
   * `dismissed` from `pending` at this writer's time, its reversal marker
   * cleared, one revision and one `removed` event. Refused with `refusal`
   * unless the row is still pending in that card account.
   */
  private dismissPending(input: {
    transactionId: string; cardAccountId: string; actor: LedgerActor; origin: 'file' | 'session'; importBatchId?: string;
    relatedTransactionId?: string; refusal: string;
  }): void {
    const current = this.prepared(`SELECT revision FROM card_transactions WHERE id = ? AND card_account_id = ? AND status = 'pending'`)
      .get(input.transactionId, input.cardAccountId) as { revision: number } | undefined;
    if (!current) throw new HoldrRefusal(input.refusal);
    const changed = this.prepared(`UPDATE card_transactions
        SET status = 'removed', removed_reason = 'dismissed', removed_from_status = 'pending', removed_at = ?, dismissed_at = ?,
            reversal_snapshot_revision = NULL, revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND revision = ?`).run(this.now, this.now, input.transactionId, current.revision).changes;
    if (changed !== 1) throw new HoldrRefusal(input.refusal);
    this.event({
      transactionId: input.transactionId, cardAccountId: input.cardAccountId, type: 'removed', revision: current.revision + 1,
      origin: input.origin, actor: input.actor, importBatchId: input.importBatchId, reason: 'dismissed', fromStatus: 'pending',
      toStatus: 'removed', relatedTransactionId: input.relatedTransactionId,
    });
    this.changedAccounts.add(input.cardAccountId);
  }

  private stored(transactionId: string): StoredValues {
    return this.prepared(`SELECT id, status, transaction_date, posted_date, amount_minor, original_amount_minor, original_currency,
        kind, revision, card_scope_id FROM card_transactions WHERE id = ?`).get(transactionId) as StoredValues;
  }

  private recordContent(identityId: string, row: FileRowValues, resolution: 'inserted' | 'promoted'): void {
    this.pendingContents.push([identityId, rowContentDigest(contentOf(row)), resolution, this.now]);
  }

  private event(e: LedgerEvent): string {
    const values = this.eventValues(e);
    this.pendingEvents.push(values);
    return values[0] as string;
  }

  // -------------------------------------------------------------------------
  // The planner's actions (§4.10.3): primitives apply.ts composes, each one
  // write of a canonical row, an identity, a content or an event.
  // -------------------------------------------------------------------------

  /** A canonical row from an observation, at revision 1 (an `insert` action); returns its id. */
  insertObservedRow(input: {
    cardAccountId: string; source: string; currency: string; values: Omit<TrackedValues, 'removedReason' | 'removedFromStatus'
      | 'removedAt' | 'mergedIntoId' | 'dismissedAt' | 'status'> & { status: 'pending' | 'posted' };
    externalIdHash: string | null; fingerprint: string | null; runId: string | null; importBatchId: string | null;
  }): string {
    const id = `card-txn-${randomCardSyncLetters()}`;
    const v = input.values;
    this.prepared(`INSERT INTO card_transactions (id, card_account_id, source, external_id_hash, fingerprint, transaction_date,
        posted_date, status, amount_minor, currency, original_amount_minor, original_currency, kind, description, merchant,
        issuer_category, import_batch_id, first_sync_run_id, card_scope_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.cardAccountId, input.source, input.externalIdHash, input.fingerprint, v.transactionDate, v.postedDate, v.status,
        v.amountMinor, input.currency, v.originalAmountMinor, v.originalCurrency, v.kind, v.description, v.merchant, v.issuerCategory,
        input.importBatchId, input.runId, v.cardScopeId);
    this.changedAccounts.add(input.cardAccountId);
    return id;
  }

  /** A row's tracked values as stored now, with its revision and marker. */
  trackedRow(id: string): (TrackedValues & { id: string; cardAccountId: string; revision: number; marker: number | null;
    userCategory: string | null; notes: string | null }) | undefined {
    return this.prepared(`SELECT id, card_account_id AS cardAccountId, status, transaction_date AS transactionDate,
        posted_date AS postedDate, amount_minor AS amountMinor, original_amount_minor AS originalAmountMinor,
        original_currency AS originalCurrency, kind, description, merchant, issuer_category AS issuerCategory,
        card_scope_id AS cardScopeId, removed_reason AS removedReason, removed_from_status AS removedFromStatus, removed_at AS removedAt,
        merged_into_id AS mergedIntoId, dismissed_at AS dismissedAt, revision, reversal_snapshot_revision AS marker,
        user_category AS userCategory, notes
      FROM card_transactions WHERE id = ?`).get(id) as ReturnType<CardLedgerWriter['trackedRow']>;
  }

  /**
   * One update of a row at its pinned revision: every tracked value as
   * given, the reversal marker as given, revision + 1 (the snapshot trigger
   * records the replaced values). Refused unless the row is still at
   * `expectedRevision`. Returns the new revision.
   */
  writeTrackedRow(input: { id: string; cardAccountId: string; expectedRevision: number; values: TrackedValues; marker: number | null;
    userCategory?: string | null; notes?: string | null }): number {
    const v = input.values;
    const owner = input.userCategory !== undefined || input.notes !== undefined;
    const changed = this.prepared(`UPDATE card_transactions
        SET status = ?, transaction_date = ?, posted_date = ?, amount_minor = ?, original_amount_minor = ?, original_currency = ?,
            kind = ?, description = ?, merchant = ?, issuer_category = ?, card_scope_id = ?, removed_reason = ?,
            removed_from_status = ?, removed_at = ?, merged_into_id = ?, dismissed_at = ?, reversal_snapshot_revision = ?,
            ${owner ? 'user_category = ?, notes = ?,' : ''}
            revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND card_account_id = ? AND revision = ?`)
      .run(v.status, v.transactionDate, v.postedDate, v.amountMinor, v.originalAmountMinor, v.originalCurrency, v.kind, v.description,
        v.merchant, v.issuerCategory, v.cardScopeId, v.removedReason, v.removedFromStatus, v.removedAt, v.mergedIntoId, v.dismissedAt,
        input.marker, ...(owner ? [input.userCategory ?? null, input.notes ?? null] : []), input.id, input.cardAccountId,
        input.expectedRevision).changes;
    if (changed !== 1) throw new HoldrRefusal('card-sync:preview-stale');
    this.changedAccounts.add(input.cardAccountId);
    return input.expectedRevision + 1;
  }

  /** Category and notes only (a `user-edited` change): revision + 1, no snapshot, no ledger revision. Returns the new revision. */
  writeOwnerFields(input: { id: string; expectedRevision: number; userCategory: string | null; notes: string | null }): number {
    const changed = this.prepared(`UPDATE card_transactions
        SET user_category = ?, notes = ?, revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND revision = ?`).run(input.userCategory, input.notes, input.id, input.expectedRevision).changes;
    if (changed !== 1) throw new HoldrRefusal('card-sync:transaction-revision-stale');
    return input.expectedRevision + 1;
  }

  /** A new identity (§2.12); returns its id. */
  createIdentity(input: NewIdentity): string {
    const id = newCardSyncRowId('card-ident-');
    this.prepared(`INSERT INTO card_source_identities (${IDENTITY_COLUMNS.join(', ')})
      VALUES (${IDENTITY_COLUMNS.map(() => '?').join(', ')})`)
      .run(id, input.cardAccountId, input.scopeId, input.scopeKind, input.namespace, input.namespaceKind, input.idHash, input.canonicalId,
        'active', input.firstSeenStatus, input.createdOrigin, input.importBatchId, input.firstObservationId, this.now,
        input.lastSeenRunId === null ? null : this.now, input.lastSeenRunId);
    this.changedAccounts.add(input.cardAccountId);
    return id;
  }

  /** An identity's mapping changes (re-activated, re-pointed or detached); refused unless it still has the expected mapping. */
  moveIdentity(input: { id: string; cardAccountId: string; from: { status: 'active' | 'detached'; canonicalId: string };
    to: { status: 'active' | 'detached'; canonicalId: string }; lastSeenRunId?: string | null }): void {
    const seen = input.lastSeenRunId !== undefined && input.lastSeenRunId !== null;
    const changed = this.prepared(`UPDATE card_source_identities
        SET status = ?, canonical_transaction_id = ?${seen ? ', last_seen_at = ?, last_seen_run_id = ?' : ''}
      WHERE id = ? AND status = ? AND canonical_transaction_id = ?`)
      .run(input.to.status, input.to.canonicalId, ...(seen ? [this.now, input.lastSeenRunId] : []), input.id, input.from.status,
        input.from.canonicalId).changes;
    if (changed !== 1) throw new HoldrRefusal('card-sync:preview-stale');
    this.changedAccounts.add(input.cardAccountId);
  }

  /** `last_seen_*` of identities an extension observation used again (§4.3; v2 only), in chunks of 500. */
  seeIdentities(identityIds: readonly string[], runId: string): void {
    const statement = this.prepared(`UPDATE card_source_identities SET last_seen_at = ?, last_seen_run_id = ?
      WHERE id IN (SELECT value FROM json_each(?))`);
    for (let start = 0; start < identityIds.length; start += 500) {
      statement.run(this.now, runId, JSON.stringify(identityIds.slice(start, start + 500)));
    }
  }

  /**
   * New canonical rows from observations (`insert` actions), each at
   * revision 1, in multi-row INSERTs, then their new identities: the batch
   * form of insertObservedRow and createIdentity, for a plan's run of inserts.
   */
  insertObservedRowsWithIdentities(rows: ReadonlyArray<{
    id: string; cardAccountId: string; source: string; currency: string;
    values: Omit<TrackedValues, 'removedReason' | 'removedFromStatus' | 'removedAt' | 'mergedIntoId' | 'dismissedAt' | 'status'>
      & { status: 'pending' | 'posted' };
    externalIdHash: string | null; fingerprint: string | null; runId: string | null; importBatchId: string | null;
  }>, identities: ReadonlyArray<NewIdentity & { id: string }>): void {
    this.insertMany(INSERT_SYNC_TRANSACTIONS, SYNC_TRANSACTION_COLUMNS.length, rows.map((r) => [
      r.id, r.cardAccountId, r.source, r.externalIdHash, r.fingerprint, r.values.transactionDate, r.values.postedDate, r.values.status,
      r.values.amountMinor, r.currency, r.values.originalAmountMinor, r.values.originalCurrency, r.values.kind, r.values.description,
      r.values.merchant, r.values.issuerCategory, r.importBatchId, r.values.cardScopeId, r.runId,
    ]));
    this.insertMany(INSERT_IDENTITIES, IDENTITY_COLUMNS.length, identities.map((i) => [
      i.id, i.cardAccountId, i.scopeId, i.scopeKind, i.namespace, i.namespaceKind, i.idHash, i.canonicalId, 'active', i.firstSeenStatus,
      i.createdOrigin, i.importBatchId, i.firstObservationId, this.now, i.lastSeenRunId === null ? null : this.now, i.lastSeenRunId,
    ]));
    for (const r of rows) this.changedAccounts.add(r.cardAccountId);
  }

  /**
   * Remembers a content for an identity (§4.3) unless it is known already,
   * stored or recorded by this writer; an identity this writer created is
   * known to know nothing else, so it skips the read. Returns whether it
   * recorded.
   */
  rememberContent(identityId: string, digest: string, resolution: 'inserted' | 'promoted' | 'corrected' | 'linked' | 'matched-current'
    | 'kept-current', created = false): boolean {
    const key = `${identityId}|${digest}`;
    if (this.remembered.has(key)) return false;
    if (!created && this.prepared('SELECT 1 FROM card_identity_contents WHERE identity_id = ? AND content_digest = ?')
      .get(identityId, digest) !== undefined) {
      return false;
    }
    this.remembered.add(key);
    this.pendingContents.push([identityId, digest, resolution, this.now]);
    return true;
  }

  /** Records a ledger event; returns its id (events are written when the writer finishes or reads contents). */
  recordEvent(e: LedgerEvent): string {
    return this.event(e);
  }

  /** The account's ledger changed without a row write through this writer (e.g. an identity re-pointed elsewhere). */
  markChanged(cardAccountId: string): void {
    this.changedAccounts.add(cardAccountId);
  }

  /** Writes the recorded contents and events, each table's in the order recorded. */
  private flush(): void {
    this.insertMany(INSERT_CONTENTS, CONTENT_COLUMNS.length, this.pendingContents.splice(0));
    this.insertMany(INSERT_EVENTS, EVENT_COLUMNS.length, this.pendingEvents.splice(0));
  }

  /** An event's values in EVENT_COLUMNS order. */
  private eventValues(e: LedgerEvent): unknown[] {
    return [newCardSyncRowId('card-event-'), e.transactionId, e.cardAccountId, e.type, e.revision, e.origin, e.actor.kind,
      e.actor.kind === 'system' ? null : e.actor.ref, e.importBatchId ?? null, e.identityId ?? null,
      e.relatedTransactionId ?? null, e.reason, e.fromStatus ?? null, e.toStatus ?? null, e.fromAmountMinor ?? null,
      e.toAmountMinor ?? null, e.fromTransactionDate ?? null, e.toTransactionDate ?? null, e.fromPostedDate ?? null,
      e.toPostedDate ?? null, e.fromKind ?? null, e.toKind ?? null, e.toScopeId ?? null, e.editFields ?? 0,
      e.editResolution ?? null, e.notify ? 1 : 0, this.now, e.runId ?? null, e.observationSetId ?? null, e.observationId ?? null,
      e.planId ?? null, e.planDigest ?? null, e.causeEventId ?? null, e.reversesEventId ?? null, e.fromScopeId ?? null,
      e.fromCanonicalId ?? null, e.toCanonicalId ?? null];
  }

  /**
   * `rows` through one of the INSERT_* statements, in order, in multi-row
   * INSERTs of at most INSERT_CHUNK_ROWS rows (statements cached by size).
   */
  private insertMany(insert: string, columnCount: number, rows: ReadonlyArray<readonly unknown[]>): void {
    const perStatement = Math.max(1, Math.min(INSERT_CHUNK_ROWS, Math.floor(MAX_BOUND_PARAMETERS / columnCount)));
    const tuple = `(${Array<string>(columnCount).fill('?').join(', ')})`;
    for (let start = 0; start < rows.length; start += perStatement) {
      const chunk = rows.slice(start, start + perStatement);
      this.prepared(`${insert} ${Array<string>(chunk.length).fill(tuple).join(', ')}`).run(chunk.flat());
    }
  }
}
