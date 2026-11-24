import type { Database as DB } from 'better-sqlite3';

import { materialChange } from '../cardLedger/classify.js';
import { CardLedgerWriter, type LedgerActor, type TrackedValues } from '../cardLedger/writer.js';
import { audit, sessionActorRef, type CardSyncContext } from './context.js';
import { cardSyncRefusal } from './refusals.js';

/**
 * The owner's ledger operations (E1b design §5.7) and permanent maintenance
 * (§5.7.1): one row (or one merge, one alias, one change) per transaction,
 * fresh revision checks, events, the account's ledger revision when the
 * ledger changed, and for maintenance one `ledger-maintenance` audit row.
 * None reads or writes a set, plan, run, receipt, device or grant (W19).
 * Every write goes through the ledger writer (W1).
 */

/** A card transaction as the ledger tools show it: the row, its revision, removal, merge and reversal fields. */
export interface CardLedgerRowView {
  id: string;
  cardAccountId: string;
  status: 'pending' | 'posted' | 'removed';
  transactionDate: string;
  postedDate: string | null;
  amountMinor: number;
  currency: string;
  originalAmountMinor: number | null;
  originalCurrency: string | null;
  kind: string;
  description: string;
  merchant: string | null;
  issuerCategory: string | null;
  userCategory: string | null;
  notes: string | null;
  cardScopeId: string;
  revision: number;
  removedReason: string | null;
  removedFromStatus: 'pending' | 'posted' | null;
  removedAt: string | null;
  mergedIntoId: string | null;
  reversalSnapshotRevision: number | null;
  importBatchId: string | null;
  firstSyncRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

const TRANSACTION_ID = /^card-txn-[a-p]{32}$/;
const IDENTITY_ID = /^card-ident-[a-p]{32}$/;
const EVENT_ID = /^card-event-[a-p]{32}$/;

export function ledgerRow(db: DB, id: unknown): CardLedgerRowView | undefined {
  if (typeof id !== 'string' || !TRANSACTION_ID.test(id)) return undefined;
  return db.prepare(`SELECT id, card_account_id AS cardAccountId, status, transaction_date AS transactionDate, posted_date AS postedDate,
      amount_minor AS amountMinor, currency, original_amount_minor AS originalAmountMinor, original_currency AS originalCurrency, kind,
      description, merchant, issuer_category AS issuerCategory, user_category AS userCategory, notes, card_scope_id AS cardScopeId,
      revision, removed_reason AS removedReason, removed_from_status AS removedFromStatus, removed_at AS removedAt,
      merged_into_id AS mergedIntoId, reversal_snapshot_revision AS reversalSnapshotRevision, import_batch_id AS importBatchId,
      first_sync_run_id AS firstSyncRunId, created_at AS createdAt, updated_at AS updatedAt
    FROM card_transactions WHERE id = ?`).get(id) as CardLedgerRowView | undefined;
}

type Tracked = NonNullable<ReturnType<CardLedgerWriter['trackedRow']>>;

function pinned(writer: CardLedgerWriter, id: unknown, expectedRevision: unknown): Tracked {
  const row = typeof id === 'string' && TRANSACTION_ID.test(id) ? writer.trackedRow(id) : undefined;
  if (!row) throw cardSyncRefusal('transaction-not-found');
  if (expectedRevision !== row.revision) throw cardSyncRefusal('transaction-revision-stale');
  return row;
}

const sessionOf = (actorRef: unknown): LedgerActor => ({ kind: 'session', ref: sessionActorRef(actorRef) });
const live = (row: { status: string }) => row.status === 'pending' || row.status === 'posted';

function scopeOf(db: DB, scopeId: string): { id: string; card_account_id: string; kind: string; status: string } | undefined {
  return db.prepare('SELECT id, card_account_id, kind, status FROM card_scopes WHERE id = ?').get(scopeId) as
    { id: string; card_account_id: string; kind: string; status: string } | undefined;
}

const sessionEvent = (row: { id: string; cardAccountId: string }, actor: LedgerActor, revision: number) => ({
  transactionId: row.id, cardAccountId: row.cardAccountId, revision, origin: 'session' as const, actor,
});

/** Removes a live row on the owner's word (§5.7): `dismissed`/`cancelled` from pending only, `mistaken-import` from either. */
export function removeCardTransaction(ctx: CardSyncContext, input: {
  id: string; reason: 'dismissed' | 'cancelled' | 'mistaken-import'; expectedRevision: number; actorRef: string;
}): CardLedgerRowView {
  const actor = sessionOf(input?.actorRef);
  const writer = new CardLedgerWriter(ctx.db, ctx.now);
  const row = pinned(writer, input.id, input.expectedRevision);
  if (!['dismissed', 'cancelled', 'mistaken-import'].includes(input.reason)) throw cardSyncRefusal('invalid-request');
  if (!live(row) || (input.reason !== 'mistaken-import' && row.status !== 'pending')) throw cardSyncRefusal('removal-not-allowed');
  const revision = writer.writeTrackedRow({
    id: row.id, cardAccountId: row.cardAccountId, expectedRevision: row.revision, marker: null,
    values: { ...row, status: 'removed', removedReason: input.reason, removedFromStatus: row.status as 'pending' | 'posted',
      removedAt: ctx.now, mergedIntoId: null, dismissedAt: input.reason === 'dismissed' ? ctx.now : null },
  });
  writer.recordEvent({ ...sessionEvent(row, actor, revision), type: 'removed', reason: input.reason, fromStatus: row.status,
    toStatus: 'removed' });
  writer.finish();
  return ledgerRow(ctx.db, row.id)!;
}

/**
 * Restores a removed row to the status it was removed from (a `legacy` row
 * needs `toStatus`); merged rows come back only through an unmerge. An
 * owner-decided change that leaves the row live: reversible (§4.6).
 */
export function restoreCardTransaction(ctx: CardSyncContext, input: {
  id: string; expectedRevision: number; toStatus?: 'pending' | 'posted'; actorRef: string;
}): CardLedgerRowView {
  const actor = sessionOf(input?.actorRef);
  const writer = new CardLedgerWriter(ctx.db, ctx.now);
  const row = pinned(writer, input.id, input.expectedRevision);
  if (row.status !== 'removed' || row.removedReason === 'superseded' || row.removedReason === 'settled-into') {
    throw cardSyncRefusal('restore-not-allowed');
  }
  const target = row.removedFromStatus ?? input.toStatus;
  if (target !== 'pending' && target !== 'posted') throw cardSyncRefusal('restore-not-allowed');
  if (input.toStatus !== undefined && input.toStatus !== target) throw cardSyncRefusal('restore-not-allowed');
  const revision = writer.writeTrackedRow({
    id: row.id, cardAccountId: row.cardAccountId, expectedRevision: row.revision, marker: row.revision,
    values: { ...row, status: target, removedReason: null, removedFromStatus: null, removedAt: null, mergedIntoId: null, dismissedAt: null },
  });
  writer.recordEvent({ ...sessionEvent(row, actor, revision), type: 'restored', reason: 'restore', fromStatus: 'removed', toStatus: target });
  writer.finish();
  return ledgerRow(ctx.db, row.id)!;
}

/** Plan §7.2.1's explicit correction between scopes of the account; reversible (§4.6). */
export function attributeCardTransaction(ctx: CardSyncContext, input: {
  id: string; cardScopeId: string; expectedRevision: number; actorRef: string;
}): CardLedgerRowView {
  const actor = sessionOf(input?.actorRef);
  const writer = new CardLedgerWriter(ctx.db, ctx.now);
  const row = pinned(writer, input.id, input.expectedRevision);
  const scope = typeof input.cardScopeId === 'string' ? scopeOf(ctx.db, input.cardScopeId) : undefined;
  if (!scope || scope.card_account_id !== row.cardAccountId || scope.status !== 'active' || scope.kind === 'legacy'
    || scope.id === row.cardScopeId) {
    throw cardSyncRefusal('scope-invalid');
  }
  if (!live(row)) throw cardSyncRefusal('transaction-revision-stale');
  const revision = writer.writeTrackedRow({
    id: row.id, cardAccountId: row.cardAccountId, expectedRevision: row.revision, marker: row.revision,
    values: { ...row, cardScopeId: scope.id },
  });
  writer.recordEvent({ ...sessionEvent(row, actor, revision), type: 'attributed', reason: 'attribution', fromScopeId: row.cardScopeId,
    toScopeId: scope.id });
  writer.finish();
  return ledgerRow(ctx.db, row.id)!;
}

function activeIdentitiesOf(db: DB, transactionId: string): string[] {
  return db.prepare(`SELECT id FROM card_source_identities WHERE canonical_transaction_id = ? AND status = 'active' ORDER BY created_at, id`)
    .pluck().all(transactionId) as string[];
}

/**
 * Merges two live rows of one account (§5.7, plan §7.2.4): the owner's
 * category and notes resolved per field, every active identity of the loser
 * re-pointed to the survivor (events naming the merge), then the loser
 * removed with `merged_into_id`. Two different known cards are never one.
 */
export function mergeCardTransactions(ctx: CardSyncContext, input: {
  survivorId: string; loserId: string; reason: 'superseded' | 'settled-into'; expectedRevisions: [number, number];
  categoryFrom: 'survivor' | 'loser'; notesFrom: 'survivor' | 'loser'; actorRef: string;
}): CardLedgerRowView {
  const actor = sessionOf(input?.actorRef);
  const { db, now } = ctx;
  const writer = new CardLedgerWriter(db, now);
  if (!Array.isArray(input.expectedRevisions) || input.expectedRevisions.length !== 2) throw cardSyncRefusal('invalid-request');
  if (input.reason !== 'superseded' && input.reason !== 'settled-into') throw cardSyncRefusal('invalid-request');
  const survivor = pinned(writer, input.survivorId, input.expectedRevisions[0]);
  const loser = pinned(writer, input.loserId, input.expectedRevisions[1]);
  if (survivor.id === loser.id || survivor.cardAccountId !== loser.cardAccountId || !live(survivor) || !live(loser)
    || (input.reason === 'settled-into' && loser.status !== 'pending')) {
    throw cardSyncRefusal('merge-not-allowed');
  }
  const survivorScope = scopeOf(db, survivor.cardScopeId)!;
  const loserScope = scopeOf(db, loser.cardScopeId)!;
  if (survivorScope.kind === 'known' && loserScope.kind === 'known' && survivorScope.id !== loserScope.id) {
    throw cardSyncRefusal('cross-card-link-refused');
  }
  const userCategory = input.categoryFrom === 'loser' ? loser.userCategory : survivor.userCategory;
  const notes = input.notesFrom === 'loser' ? loser.notes : survivor.notes;
  const editFields = (userCategory !== survivor.userCategory ? 1 : 0) | (notes !== survivor.notes ? 2 : 0);
  const resolution = editFields === 3 ? 'loser-both' as const : editFields === 1 ? 'loser-category' as const
    : editFields === 2 ? 'loser-notes' as const : 'survivor' as const;
  let survivorRevision = survivor.revision;
  if (editFields > 0) {
    survivorRevision = writer.writeOwnerFields({ id: survivor.id, expectedRevision: survivor.revision, userCategory, notes });
    writer.recordEvent({ ...sessionEvent(survivor, actor, survivorRevision), type: 'user-edited', reason: 'user-edit', editFields,
      editResolution: resolution, relatedTransactionId: loser.id });
  }
  const mergeEvent = writer.recordEvent({ ...sessionEvent(loser, actor, loser.revision + 1), type: input.reason, reason: input.reason,
    relatedTransactionId: survivor.id, fromStatus: loser.status, toStatus: 'removed', editResolution: resolution });
  for (const identityId of activeIdentitiesOf(db, loser.id)) {
    writer.moveIdentity({ id: identityId, cardAccountId: loser.cardAccountId, from: { status: 'active', canonicalId: loser.id },
      to: { status: 'active', canonicalId: survivor.id } });
    writer.recordEvent({ ...sessionEvent(survivor, actor, survivorRevision), type: 'identity-repointed', reason: input.reason, identityId,
      fromCanonicalId: loser.id, toCanonicalId: survivor.id, causeEventId: mergeEvent });
  }
  writer.writeTrackedRow({
    id: loser.id, cardAccountId: loser.cardAccountId, expectedRevision: loser.revision, marker: null,
    values: { ...loser, status: 'removed', removedReason: input.reason, removedFromStatus: loser.status as 'pending' | 'posted',
      removedAt: now, mergedIntoId: survivor.id, dismissedAt: null },
  });
  writer.finish();
  return ledgerRow(db, survivor.id)!;
}

/**
 * Undoes a merge in §4.9.3's order, at any age (§5.7.1): preconditions, the
 * loser restored, its identities re-pointed back (events naming the
 * restore), the `reversed` event naming the merge, and the end state checked.
 */
export function unmergeCardTransaction(ctx: CardSyncContext, input: {
  loserId: string; expectedRevisions: [number, number]; actorRef: string;
}): CardLedgerRowView {
  const actor = sessionOf(input?.actorRef);
  const { db, now } = ctx;
  const writer = new CardLedgerWriter(db, now);
  if (!Array.isArray(input.expectedRevisions) || input.expectedRevisions.length !== 2) throw cardSyncRefusal('invalid-request');
  const loser = pinned(writer, input.loserId, input.expectedRevisions[0]);
  if (loser.status !== 'removed' || (loser.removedReason !== 'superseded' && loser.removedReason !== 'settled-into')
    || loser.mergedIntoId === null) {
    throw cardSyncRefusal('merge-not-allowed');
  }
  const survivor = pinned(writer, loser.mergedIntoId, input.expectedRevisions[1]);
  const latest = db.prepare(`SELECT id, event_type FROM card_transaction_events WHERE card_transaction_id = ?
    ORDER BY transaction_revision DESC, created_at DESC, id DESC LIMIT 1`).get(loser.id) as { id: string; event_type: string } | undefined;
  if (!latest || latest.event_type !== loser.removedReason) throw cardSyncRefusal('link-not-reversible');
  const moved = db.prepare(`SELECT e.identity_id FROM card_transaction_events e
      JOIN card_source_identities i ON i.id = e.identity_id
    WHERE e.event_type = 'identity-repointed' AND e.cause_event_id = ?`).pluck().all(latest.id) as string[];
  const stillThere = moved.every((identityId) => db.prepare(`SELECT 1 FROM card_source_identities
    WHERE id = ? AND status = 'active' AND canonical_transaction_id = ?`).get(identityId, survivor.id) !== undefined);
  if (!stillThere || activeIdentitiesOf(db, survivor.id).length - moved.length < 1) throw cardSyncRefusal('link-not-reversible');
  const status = loser.removedFromStatus!;
  const revision = writer.writeTrackedRow({
    id: loser.id, cardAccountId: loser.cardAccountId, expectedRevision: loser.revision, marker: null,
    values: { ...loser, status, removedReason: null, removedFromStatus: null, removedAt: null, mergedIntoId: null, dismissedAt: null },
  });
  const base = sessionEvent(loser, actor, revision);
  const restored = writer.recordEvent({ ...base, type: 'restored', reason: 'maintenance', fromStatus: 'removed', toStatus: status });
  for (const identityId of moved) {
    writer.moveIdentity({ id: identityId, cardAccountId: loser.cardAccountId, from: { status: 'active', canonicalId: survivor.id },
      to: { status: 'active', canonicalId: loser.id } });
    writer.recordEvent({ ...base, type: 'identity-repointed', reason: 'maintenance', identityId, fromCanonicalId: survivor.id,
      toCanonicalId: loser.id, causeEventId: restored });
  }
  const reversed = writer.recordEvent({ ...base, type: 'reversed', reason: 'maintenance', reversesEventId: latest.id,
    fromStatus: 'removed', toStatus: status, relatedTransactionId: survivor.id });
  if (activeIdentitiesOf(db, loser.id).length < 1) throw cardSyncRefusal('link-not-reversible');
  audit(ctx, 'ledger-maintenance', actor as { kind: 'session'; ref: string }, {
    cardAccountId: loser.cardAccountId, code: 'unmerge', ledgerEventId: reversed, versionBefore: loser.revision, versionAfter: revision,
  });
  writer.finish();
  return ledgerRow(db, loser.id)!;
}

interface IdentityRow {
  id: string; card_account_id: string; source_scope_id: string; source_scope_kind: string; status: 'active' | 'detached';
  canonical_transaction_id: string;
}

function identityOf(db: DB, identityId: unknown): IdentityRow {
  const identity = typeof identityId === 'string' && IDENTITY_ID.test(identityId)
    ? db.prepare(`SELECT id, card_account_id, source_scope_id, source_scope_kind, status, canonical_transaction_id
      FROM card_source_identities WHERE id = ?`).get(identityId) as IdentityRow | undefined
    : undefined;
  if (!identity) throw cardSyncRefusal('identity-not-found');
  return identity;
}

/** An active alias becomes detached (§5.7.1): its tuple stays reserved, so its next observation asks the owner. */
export function detachCardSourceIdentity(ctx: CardSyncContext, input: {
  identityId: string; transactionId: string; expectedRevision: number; actorRef: string;
}): CardLedgerRowView {
  const actor = sessionOf(input?.actorRef);
  const { db } = ctx;
  const writer = new CardLedgerWriter(db, ctx.now);
  const identity = identityOf(db, input.identityId);
  if (identity.status !== 'active') throw cardSyncRefusal('identity-not-active');
  if (identity.canonical_transaction_id !== input.transactionId) throw cardSyncRefusal('transaction-revision-stale');
  const row = pinned(writer, input.transactionId, input.expectedRevision);
  if (activeIdentitiesOf(db, row.id).length < 2) throw cardSyncRefusal('identity-last-active');
  writer.moveIdentity({ id: identity.id, cardAccountId: row.cardAccountId, from: { status: 'active', canonicalId: row.id },
    to: { status: 'detached', canonicalId: row.id } });
  const event = writer.recordEvent({ ...sessionEvent(row, actor, row.revision), type: 'identity-detached', reason: 'maintenance',
    identityId: identity.id, fromCanonicalId: row.id });
  audit(ctx, 'ledger-maintenance', actor as { kind: 'session'; ref: string }, {
    cardAccountId: row.cardAccountId, code: 'detach', ledgerEventId: event, versionBefore: row.revision, versionAfter: row.revision,
  });
  writer.finish();
  return ledgerRow(db, row.id)!;
}

/** An active alias moves to another live row of the account (§5.7.1); different known cards are never linked. */
export function repointCardSourceIdentity(ctx: CardSyncContext, input: {
  identityId: string; fromTransactionId: string; toTransactionId: string; expectedRevisions: [number, number]; actorRef: string;
}): { from: CardLedgerRowView; to: CardLedgerRowView } {
  const actor = sessionOf(input?.actorRef);
  const { db } = ctx;
  const writer = new CardLedgerWriter(db, ctx.now);
  if (!Array.isArray(input.expectedRevisions) || input.expectedRevisions.length !== 2) throw cardSyncRefusal('invalid-request');
  const identity = identityOf(db, input.identityId);
  if (identity.status !== 'active') throw cardSyncRefusal('identity-not-active');
  if (identity.canonical_transaction_id !== input.fromTransactionId) throw cardSyncRefusal('transaction-revision-stale');
  const from = pinned(writer, input.fromTransactionId, input.expectedRevisions[0]);
  const target = typeof input.toTransactionId === 'string' && TRANSACTION_ID.test(input.toTransactionId)
    ? writer.trackedRow(input.toTransactionId) : undefined;
  if (!target || target.id === from.id || target.cardAccountId !== from.cardAccountId || !live(target)) {
    throw cardSyncRefusal('repoint-not-allowed');
  }
  if (target.revision !== input.expectedRevisions[1]) throw cardSyncRefusal('transaction-revision-stale');
  const targetScope = scopeOf(db, target.cardScopeId)!;
  if (identity.source_scope_kind === 'known' && targetScope.kind === 'known' && identity.source_scope_id !== targetScope.id) {
    throw cardSyncRefusal('cross-card-link-refused');
  }
  if (activeIdentitiesOf(db, from.id).length < 2) throw cardSyncRefusal('identity-last-active');
  writer.moveIdentity({ id: identity.id, cardAccountId: from.cardAccountId, from: { status: 'active', canonicalId: from.id },
    to: { status: 'active', canonicalId: target.id } });
  const event = writer.recordEvent({ ...sessionEvent(target, actor, target.revision), type: 'identity-repointed', reason: 'maintenance',
    identityId: identity.id, fromCanonicalId: from.id, toCanonicalId: target.id });
  audit(ctx, 'ledger-maintenance', actor as { kind: 'session'; ref: string }, {
    cardAccountId: from.cardAccountId, code: 'repoint', ledgerEventId: event, versionBefore: from.revision, versionAfter: from.revision,
  });
  writer.finish();
  return { from: ledgerRow(db, from.id)!, to: ledgerRow(db, target.id)! };
}

interface SnapshotRow {
  status: 'pending' | 'posted' | 'removed'; transaction_date: string; posted_date: string | null; amount_minor: number;
  original_amount_minor: number | null; original_currency: string | null; kind: string; description: string; merchant: string | null;
  issuer_category: string | null; card_scope_id: string; removed_reason: string | null; removed_from_status: 'pending' | 'posted' | null;
  removed_at: string | null; merged_into_id: string | null; dismissed_at: string | null; reversal_snapshot_revision: number | null;
}

/**
 * Reverts the change an event recorded while it is still the row's latest
 * reversible change (§5.7.1, Q47): the row takes that change's snapshot
 * exactly (the database checks it again), with the snapshot's own marker;
 * category and notes are kept.
 */
export function revertCardTransactionChange(ctx: CardSyncContext, input: {
  transactionId: string; eventId: string; expectedRevision: number; actorRef: string;
}): CardLedgerRowView {
  const actor = sessionOf(input?.actorRef);
  const { db } = ctx;
  const writer = new CardLedgerWriter(db, ctx.now);
  const row = pinned(writer, input.transactionId, input.expectedRevision);
  const revertible = ctx.statements.get('revertible-event', { transaction_id: row.id });
  if (typeof input.eventId !== 'string' || !EVENT_ID.test(input.eventId) || revertible?.event_id !== input.eventId
    || row.marker === null) {
    throw cardSyncRefusal('change-not-reversible');
  }
  const snapshot = db.prepare('SELECT * FROM card_transaction_versions WHERE card_transaction_id = ? AND revision = ?')
    .get(row.id, row.marker) as SnapshotRow | undefined;
  if (!snapshot) throw cardSyncRefusal('change-not-reversible');
  const values: TrackedValues = {
    status: snapshot.status, transactionDate: snapshot.transaction_date, postedDate: snapshot.posted_date, amountMinor: snapshot.amount_minor,
    originalAmountMinor: snapshot.original_amount_minor, originalCurrency: snapshot.original_currency, kind: snapshot.kind,
    description: snapshot.description, merchant: snapshot.merchant, issuerCategory: snapshot.issuer_category,
    cardScopeId: snapshot.card_scope_id, removedReason: snapshot.removed_reason, removedFromStatus: snapshot.removed_from_status,
    removedAt: snapshot.removed_at, mergedIntoId: snapshot.merged_into_id, dismissedAt: snapshot.dismissed_at,
  };
  const revision = writer.writeTrackedRow({ id: row.id, cardAccountId: row.cardAccountId, expectedRevision: row.revision, values,
    marker: snapshot.reversal_snapshot_revision });
  const event = writer.recordEvent({ ...sessionEvent(row, actor, revision), type: 'reversed', reason: 'maintenance',
    reversesEventId: input.eventId, fromStatus: row.status, toStatus: values.status, fromAmountMinor: row.amountMinor,
    toAmountMinor: values.amountMinor, fromTransactionDate: row.transactionDate, toTransactionDate: values.transactionDate,
    fromPostedDate: row.postedDate, toPostedDate: values.postedDate, fromKind: row.kind, toKind: values.kind,
    fromScopeId: row.cardScopeId !== values.cardScopeId ? row.cardScopeId : null,
    toScopeId: row.cardScopeId !== values.cardScopeId ? values.cardScopeId : null, notify: materialChange(row, values) });
  audit(ctx, 'ledger-maintenance', actor as { kind: 'session'; ref: string }, {
    cardAccountId: row.cardAccountId, code: 'revert', ledgerEventId: event, versionBefore: row.revision, versionAfter: revision,
  });
  writer.finish();
  return ledgerRow(db, row.id)!;
}

export interface CardTransactionSources {
  transaction: CardLedgerRowView;
  identities: Array<{ identityId: string; namespace: string; scopeId: string; status: 'active' | 'detached'; firstSeenStatus: string;
    createdOrigin: string; createdAt: string; lastSeenAt: string | null }>;
  nextIdentities: { createdAt: string; identityId: string } | null;
  mergedRows: Array<{ transactionId: string; removedAt: string; removedReason: string }>;
  nextMerged: { removedAt: string; transactionId: string } | null;
  revertibleEventId: string | null;
  events: Array<{ eventId: string; transactionId: string; type: string; revision: number; reason: string; origin: string;
    actorKind: string; createdAt: string; relatedTransactionId: string | null; identityId: string | null;
    fromCanonicalId: string | null; toCanonicalId: string | null; reversesEventId: string | null }>;
  nextEvents: { createdAt: string; eventId: string } | null;
}

const FIRST_EVENT_KEY = { createdAt: '9999-12-31T23:59:59.999Z', eventId: 'card-event-q' };

/**
 * The owner API's `GET /transactions/:id/sources` (§5.7.1): one read
 * transaction, live or removed rows alike; at most one list continues from
 * its cursor, the others give their first pages. Live keyset pages, not a
 * snapshot (Revision 8): clients de-duplicate by id.
 */
export function getCardTransactionSources(ctx: CardSyncContext, input: {
  transactionId: string;
  continue: null | { events: { createdAt: string; eventId: string } } | { identities: { createdAt: string; identityId: string } }
    | { merged: { removedAt: string; transactionId: string } };
  limits: { events: number; identities: number; merged: number };
}): CardTransactionSources | null {
  const { db } = ctx;
  const limits = input?.limits;
  const within = (value: unknown, max: number) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= max;
  if (!limits || !within(limits.events, 100) || !within(limits.identities, 500) || !within(limits.merged, 100)) {
    throw cardSyncRefusal('invalid-request');
  }
  const transaction = ledgerRow(db, input.transactionId);
  if (!transaction) return null;
  const cont = (input.continue ?? {}) as Partial<{
    events: { createdAt: string; eventId: string }; identities: { createdAt: string; identityId: string };
    merged: { removedAt: string; transactionId: string };
  }>;
  const eventsAfter = cont.events ?? FIRST_EVENT_KEY;
  const identitiesAfter = cont.identities ?? { createdAt: '', identityId: '' };
  const mergedAfter = cont.merged ?? { removedAt: '', transactionId: '' };
  for (const key of [eventsAfter.createdAt, identitiesAfter.createdAt, mergedAfter.removedAt]) {
    if (typeof key !== 'string') throw cardSyncRefusal('invalid-request');
  }

  const aliasKeys = ctx.statements.all('transaction-aliases-page', { transaction_id: transaction.id,
    after_created_at: identitiesAfter.createdAt, after_id: identitiesAfter.identityId, limit: limits.identities + 1 });
  const identity = db.prepare(`SELECT id AS identityId, namespace, source_scope_id AS scopeId, status, first_seen_status AS firstSeenStatus,
      created_origin AS createdOrigin, created_at AS createdAt, last_seen_at AS lastSeenAt FROM card_source_identities WHERE id = ?`);
  const identities = aliasKeys.slice(0, limits.identities).map((key) => identity.get(key.identity_id) as CardTransactionSources['identities'][number]);
  const mergedKeys = ctx.statements.all('transaction-merged-page', { transaction_id: transaction.id,
    after_removed_at: mergedAfter.removedAt, after_id: mergedAfter.transactionId, limit: limits.merged + 1 });
  const merged = db.prepare('SELECT removed_reason FROM card_transactions WHERE id = ?').pluck();
  const mergedRows = mergedKeys.slice(0, limits.merged).map((key) => ({
    transactionId: key.transaction_id, removedAt: key.removed_at, removedReason: merged.get(key.transaction_id) as string,
  }));
  const eventKeys = ctx.statements.all('transaction-history-page', { transaction_id: transaction.id,
    before_created_at: eventsAfter.createdAt, before_id: eventsAfter.eventId, limit: limits.events + 1 });
  const event = db.prepare(`SELECT id AS eventId, card_transaction_id AS transactionId, event_type AS type, transaction_revision AS revision,
      reason, origin, actor_kind AS actorKind, created_at AS createdAt, related_transaction_id AS relatedTransactionId,
      identity_id AS identityId, from_canonical_id AS fromCanonicalId, to_canonical_id AS toCanonicalId,
      reverses_event_id AS reversesEventId FROM card_transaction_events WHERE id = ?`);
  const events = eventKeys.slice(0, limits.events).map((key) => event.get(key.id) as CardTransactionSources['events'][number]);
  const lastAlias = identities[identities.length - 1];
  const lastMerged = mergedRows[mergedRows.length - 1];
  const lastEvent = events[events.length - 1];
  return {
    transaction, identities,
    nextIdentities: aliasKeys.length > limits.identities && lastAlias
      ? { createdAt: lastAlias.createdAt, identityId: lastAlias.identityId } : null,
    mergedRows,
    nextMerged: mergedKeys.length > limits.merged && lastMerged
      ? { removedAt: lastMerged.removedAt, transactionId: lastMerged.transactionId } : null,
    revertibleEventId: ctx.statements.get('revertible-event', { transaction_id: transaction.id })?.event_id ?? null,
    events,
    nextEvents: eventKeys.length > limits.events && lastEvent ? { createdAt: lastEvent.createdAt, eventId: lastEvent.eventId } : null,
  };
}

/**
 * Pending rows no source has shown again for `days` (default 14): the read
 * side's stale hint (§4.4 row 8). Absence never changes the ledger (W6).
 */
export function listStalePendingCardTransactions(ctx: CardSyncContext, input: { days?: number } = {}): CardLedgerRowView[] {
  const days = input?.days ?? 14;
  if (!Number.isInteger(days) || days < 1 || days > 365) throw cardSyncRefusal('invalid-request');
  const cutoff = new Date(Date.parse(ctx.now) - days * 86_400_000).toISOString();
  const ids = ctx.db.prepare(`SELECT t.id FROM card_transactions t
    WHERE t.status = 'pending'
      AND coalesce((SELECT max(coalesce(i.last_seen_at, i.created_at)) FROM card_source_identities i
                     WHERE i.canonical_transaction_id = t.id AND i.status = 'active'), t.created_at) < ?
    ORDER BY t.transaction_date, t.id`).pluck().all(cutoff) as string[];
  return ids.map((id) => ledgerRow(ctx.db, id)!);
}
