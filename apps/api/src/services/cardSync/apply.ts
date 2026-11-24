import { newCardSyncRowId, randomCardSyncLetters } from '../cardSyncDigests.js';
import { CardLedgerWriter, type LedgerActor, type LedgerEvent, type TrackedValues } from '../cardLedger/writer.js';
import { materialChange } from '../cardLedger/classify.js';
import type { StoredIdentity, Tuple } from '../cardLedger/ledgerView.js';
import type { PlannedAction } from '../cardLedger/simulate.js';
import type { CardSyncContext } from './context.js';
import { cardSyncRefusal } from './refusals.js';
import type { SetObservation, SetRow } from './sets.js';

/**
 * Carries out a recomputed set plan (E1b design §4.10.3): the actions in
 * ordinal order through the ledger writer (rows, identities, contents,
 * events, reversal markers), then once the observations' outcomes, the
 * items' committed decisions, the set's counts, state and version, the
 * coverage's ledger state and the account's ledger revision. Every action
 * re-checks its pinned revision; any refusal aborts the caller's whole
 * transaction (W2).
 */

type Outcome = 'inserted' | 'updated' | 'matched' | 'attributed' | 'unchanged' | 'rejected';

export interface AppliedPlan {
  ledgerChanged: boolean;
  /** Each observation's outcome before (`open` for a set plan) and after the plan. */
  transitions: Array<{ observationId: string; from: Outcome | 'open'; to: Outcome }>;
}

/** Rows per multi-row statement (each guarded row still checked; ≤ 5 values a row, well inside SQLite's limit). */
const CHUNK = 250;

interface Resolution {
  state: 'resolved' | 'rejected';
  outcome: 'inserted' | 'updated' | 'matched' | 'attributed' | 'unchanged' | null;
  transactionId: string | null;
  provenance: 0 | 1;
}

interface Committed {
  transactionId: string | null;
  revision: number | null;
  scopeId: string | null;
}

export function applyPlan(ctx: CardSyncContext, input: {
  set: SetRow; plan: { id: string; digest: string; kind: 'set' | 'adjustment' }; actor: LedgerActor; actions: readonly PlannedAction[];
}): AppliedPlan {
  const { db, now } = ctx;
  const { set, plan, actor } = input;
  const writer = new CardLedgerWriter(db, now);
  const accountId = set.card_account_id;
  const origin = set.origin;
  const createdOrigin = origin === 'file' ? 'file' as const : actor.kind === 'device' ? 'extension' as const : 'session' as const;
  const runId = origin === 'extension' ? set.run_id : null;
  const batchId = origin === 'file' ? set.import_batch_id : null;
  const resolutions = new Map<string, Resolution>();
  const committed = new Map<string, Committed>();
  const newRows = new Map<number, string>();
  let ledgerChanged = false;
  const adjusting = plan.kind === 'adjustment';

  const eventBase = (observation: SetObservation) => ({
    cardAccountId: accountId, origin, actor, runId, importBatchId: batchId, observationSetId: set.id, observationId: observation.id,
    planId: plan.id, planDigest: plan.digest,
  } satisfies Partial<LedgerEvent>);

  const newIdentity = (observation: SetObservation, tuple: Tuple, canonicalId: string) => {
    const id = writer.createIdentity({
      cardAccountId: accountId, scopeId: tuple.scopeId, scopeKind: tuple.scopeKind, namespace: tuple.namespace,
      namespaceKind: tuple.namespaceKind, idHash: tuple.idHash, canonicalId, firstSeenStatus: observation.values.status, createdOrigin,
      importBatchId: batchId, firstObservationId: observation.id, lastSeenRunId: runId,
    });
    createdHere.add(id);
    return id;
  };

  const reactivate = (identity: StoredIdentity, canonicalId: string) => writer.moveIdentity({
    id: identity.id, cardAccountId: accountId, from: { status: 'detached', canonicalId: identity.canonicalId },
    to: { status: 'active', canonicalId }, lastSeenRunId: runId,
  });

  const createdHere = new Set<string>();
  const unmatchedRows = new Set<string>();
  /** Identities the set's observations used again: their `last_seen_*` moves once, at the end. */
  const seen = new Set<string>();
  /** Remembers the observation's content for each of its identities on the row that does not know it yet (§4.3). */
  const remember = (identityIds: readonly string[], observation: SetObservation, resolution: PlannedAction['resolution']) => {
    if (resolution === null) return;
    for (const id of identityIds) {
      const created = createdHere.has(id);
      // New knowledge about an identity that existed before changes how its next observation classifies (a replay
      // instead of a correction): the account's classification epoch, its ledger revision, moves once for the
      // transaction (writer.finish), so other sets' review marks go stale and refresh (r1 finding 4). A content the
      // ledger already knew changes nothing.
      if (writer.rememberContent(id, observation.content, resolution, created) && !created) writer.markChanged(accountId);
    }
  };

  const valuesEvent = (before: TrackedValues, after: TrackedValues) => ({
    fromStatus: before.status, toStatus: after.status, fromAmountMinor: before.amountMinor, toAmountMinor: after.amountMinor,
    fromTransactionDate: before.transactionDate, toTransactionDate: after.transactionDate, fromPostedDate: before.postedDate,
    toPostedDate: after.postedDate, fromKind: before.kind, toKind: after.kind,
  });

  const queuedRows: Parameters<CardLedgerWriter['insertObservedRowsWithIdentities']>[0][number][] = [];
  const queuedIdentities: Parameters<CardLedgerWriter['insertObservedRowsWithIdentities']>[1][number][] = [];
  /** A run of inserts goes in as multi-row INSERTs; anything else first writes the queued rows. */
  const flushInserts = () => {
    if (queuedRows.length === 0) return;
    writer.insertObservedRowsWithIdentities(queuedRows.splice(0), queuedIdentities.splice(0));
  };

  for (const action of input.actions) {
    const observation = action.source as SetObservation | null;
    const itemId = action.item;
    if (action.op !== 'insert') flushInserts();
    switch (action.op) {
      case 'insert': {
        const obs = observation!;
        const values = action.values!;
        const id = `card-txn-${randomCardSyncLetters()}`;
        newRows.set(action.ordinal, id);
        queuedRows.push({
          id, cardAccountId: accountId, source: set.source, currency: set.currency, values: { ...values, cardScopeId: action.scope! },
          externalIdHash: obs.externalIdHash, fingerprint: obs.externalIdHash === null ? obs.fingerprint : null, runId, importBatchId: batchId,
        });
        const created = action.attach.map((tuple) => {
          const identityId = newCardSyncRowId('card-ident-');
          queuedIdentities.push({
            id: identityId, cardAccountId: accountId, scopeId: tuple.scopeId, scopeKind: tuple.scopeKind, namespace: tuple.namespace,
            namespaceKind: tuple.namespaceKind, idHash: tuple.idHash, canonicalId: id, firstSeenStatus: obs.values.status, createdOrigin,
            importBatchId: batchId, firstObservationId: obs.id, lastSeenRunId: runId,
          });
          createdHere.add(identityId);
          return identityId;
        });
        if (action.reactivate.length > 0) {
          flushInserts();
          for (const identity of action.reactivate) reactivate(identity, id);
        }
        const identities = [...created, ...action.reactivate.map((identity) => identity.id)];
        const base = eventBase(obs);
        writer.recordEvent({
          ...base, transactionId: id, type: 'created', revision: 1, reason: 'insert', identityId: identities[0], toStatus: values.status,
          toAmountMinor: values.amountMinor, toTransactionDate: values.transactionDate, toPostedDate: values.postedDate,
          toKind: values.kind, toScopeId: action.scope,
        });
        if (action.attributedFrom !== null) {
          writer.recordEvent({ ...base, transactionId: id, type: 'attributed', revision: 1, reason: 'attribution',
            fromScopeId: action.attributedFrom, toScopeId: action.scope });
        }
        for (const identityId of identities.slice(1)) {
          writer.recordEvent({ ...base, transactionId: id, type: 'identity-linked', revision: 1, reason: 'alias', identityId });
        }
        remember(identities, obs, 'inserted');
        const outcome = action.attributedFrom !== null ? 'attributed' : 'inserted';
        resolutions.set(obs.id, { state: 'resolved', outcome, transactionId: id, provenance: 1 });
        if (itemId) committed.set(itemId, { transactionId: id, revision: 1, scopeId: action.attributedFrom !== null ? action.scope : null });
        ledgerChanged = true;
        break;
      }
      case 'unchanged':
      case 'alias': {
        const obs = observation!;
        const rowId = action.transaction ?? newRows.get(action.newRef!)!;
        const row = writer.trackedRow(rowId)!;
        if (action.expectedRevision !== null && row.revision !== action.expectedRevision) throw stale();
        const created = action.attach.map((tuple) => newIdentity(obs, tuple, rowId));
        for (const identityId of created) {
          writer.recordEvent({ ...eventBase(obs), transactionId: rowId, type: 'identity-linked', revision: row.revision, reason: 'alias',
            identityId });
        }
        if (runId !== null) for (const identity of action.onRow) seen.add(identity.id);
        remember([...action.onRow.map((identity) => identity.id), ...created], obs, action.resolution);
        resolutions.set(obs.id, { state: 'resolved', outcome: 'unchanged', transactionId: rowId, provenance: created.length > 0 ? 1 : 0 });
        if (itemId) committed.set(itemId, { transactionId: rowId, revision: row.revision, scopeId: null });
        if (created.length > 0) ledgerChanged = true;
        break;
      }
      case 'promote':
      case 'correct':
      case 'match': {
        const obs = observation!;
        const rowId = action.transaction!;
        const before = writer.trackedRow(rowId);
        if (!before || before.revision !== action.expectedRevision) throw stale();
        let revision = before.revision;
        let after: TrackedValues = before;
        const writesRow = action.values !== null || action.scope !== null;
        if (writesRow) {
          const values = action.values;
          after = {
            ...before,
            ...(values ? {
              status: values.status, transactionDate: values.transactionDate, postedDate: values.postedDate, amountMinor: values.amountMinor,
              originalAmountMinor: values.originalAmountMinor, originalCurrency: values.originalCurrency, kind: values.kind,
              description: values.description, merchant: values.merchant, issuerCategory: values.issuerCategory,
            } : {}),
            ...(action.restore ? { removedReason: null, removedFromStatus: null, removedAt: null, mergedIntoId: null, dismissedAt: null } : {}),
            ...(action.scope !== null && action.op === 'match' ? { cardScopeId: action.scope } : {}),
          };
          revision = writer.writeTrackedRow({ id: rowId, cardAccountId: accountId, expectedRevision: before.revision, values: after,
            marker: action.marker });
          ledgerChanged = true;
        }
        const base = { ...eventBase(obs), transactionId: rowId, revision };
        const notify = action.values !== null && materialChange(before, action.values);
        if (action.op === 'correct') {
          writer.recordEvent({ ...base, type: 'corrected', reason: 'posted-correction', ...valuesEvent(before, after), notify });
        } else if (action.promote) {
          writer.recordEvent({ ...base, type: 'promoted', reason: action.promoteReason!, ...valuesEvent(before, after), notify });
        }
        if (action.restore) {
          writer.recordEvent({ ...base, type: 'restored', reason: 'restore', fromStatus: 'removed', toStatus: after.status });
        }
        if (action.op === 'match' && action.scope !== null) {
          writer.recordEvent({ ...base, type: 'attributed', reason: 'attribution', fromScopeId: before.cardScopeId, toScopeId: action.scope });
        }
        const created = action.attach.map((tuple) => newIdentity(obs, tuple, rowId));
        for (const identity of action.reactivate) reactivate(identity, rowId);
        const linked = [...created, ...action.reactivate.map((identity) => identity.id)];
        const linkReason = action.op === 'promote' && action.promoteReason === 'pending-posted' ? 'pending-posted' : 'same-transaction';
        for (const identityId of linked) {
          writer.recordEvent({ ...base, type: 'identity-linked', reason: action.op === 'promote' ? linkReason : 'same-transaction',
            identityId });
        }
        if (linked.length > 0) ledgerChanged = true;
        if (runId !== null) for (const identity of action.onRow) seen.add(identity.id);
        remember([...action.onRow.map((identity) => identity.id), ...linked], obs, action.resolution);
        const outcome = action.op === 'match' ? (action.scope !== null ? 'attributed' : 'matched') : 'updated';
        resolutions.set(obs.id, { state: 'resolved', outcome, transactionId: rowId,
          provenance: writesRow || linked.length > 0 ? 1 : 0 });
        if (itemId) committed.set(itemId, { transactionId: rowId, revision, scopeId: action.op === 'match' ? action.scope : null });
        break;
      }
      case 'reject': {
        resolutions.set(observation!.id, { state: 'rejected', outcome: null, transactionId: null, provenance: 0 });
        if (itemId) committed.set(itemId, { transactionId: null, revision: null, scopeId: null });
        break;
      }
      case 'accept-difference':
        if (itemId) committed.set(itemId, { transactionId: null, revision: null, scopeId: null });
        break;
      case 'revert': {
        const before = writer.trackedRow(action.transaction!);
        if (!before || before.revision !== action.expectedRevision || before.marker === null) throw stale();
        const snapshot = db.prepare('SELECT * FROM card_transaction_versions WHERE card_transaction_id = ? AND revision = ?')
          .get(before.id, before.marker) as Record<string, unknown> | undefined;
        if (!snapshot) throw stale();
        const after: TrackedValues = {
          status: snapshot.status as TrackedValues['status'], transactionDate: snapshot.transaction_date as string,
          postedDate: snapshot.posted_date as string | null, amountMinor: snapshot.amount_minor as number,
          originalAmountMinor: snapshot.original_amount_minor as number | null, originalCurrency: snapshot.original_currency as string | null,
          kind: snapshot.kind as string, description: snapshot.description as string, merchant: snapshot.merchant as string | null,
          issuerCategory: snapshot.issuer_category as string | null, cardScopeId: snapshot.card_scope_id as string,
          removedReason: snapshot.removed_reason as string | null, removedFromStatus: snapshot.removed_from_status as TrackedValues['removedFromStatus'],
          removedAt: snapshot.removed_at as string | null, mergedIntoId: snapshot.merged_into_id as string | null,
          dismissedAt: snapshot.dismissed_at as string | null,
        };
        const revision = writer.writeTrackedRow({ id: before.id, cardAccountId: accountId, expectedRevision: before.revision, values: after,
          marker: snapshot.reversal_snapshot_revision as number | null });
        writer.recordEvent({ ...eventBase(observation!), transactionId: before.id, revision, type: 'reversed', reason: 'adjustment',
          reversesEventId: action.reverses, ...valuesEvent(before, after), notify: materialChange(before, after),
          fromScopeId: before.cardScopeId !== after.cardScopeId ? before.cardScopeId : null,
          toScopeId: before.cardScopeId !== after.cardScopeId ? after.cardScopeId : null });
        ledgerChanged = true;
        break;
      }
      case 'unmatch': {
        const row = writer.trackedRow(action.transaction!);
        if (!row || row.revision !== action.expectedRevision) throw stale();
        unmatchedRows.add(row.id);
        for (const identity of action.reactivate) {
          writer.moveIdentity({ id: identity.id, cardAccountId: accountId, from: { status: 'active', canonicalId: row.id },
            to: { status: 'detached', canonicalId: row.id } });
          writer.recordEvent({ ...eventBase(observation!), transactionId: row.id, revision: row.revision, type: 'identity-detached',
            reason: 'adjustment', identityId: identity.id, fromCanonicalId: row.id });
        }
        ledgerChanged = true;
        break;
      }
      case 'remove': {
        const before = writer.trackedRow(action.transaction!);
        if (!before || before.revision !== action.expectedRevision || before.status === 'removed') throw stale();
        const revision = writer.writeTrackedRow({ id: before.id, cardAccountId: accountId, expectedRevision: before.revision, marker: null,
          values: { ...before, status: 'removed', removedReason: 'mistaken-import', removedFromStatus: before.status as 'pending' | 'posted',
            removedAt: now, mergedIntoId: null, dismissedAt: null } });
        writer.recordEvent({ ...eventBase(observation!), transactionId: before.id, revision, type: 'removed', reason: 'mistaken-import',
          fromStatus: before.status, toStatus: 'removed' });
        resolutions.set(observation!.id, { state: 'rejected', outcome: null, transactionId: null, provenance: 0 });
        if (itemId) committed.set(itemId, { transactionId: null, revision: null, scopeId: null });
        ledgerChanged = true;
        break;
      }
      case 'restore-attribution': {
        const before = writer.trackedRow(action.transaction!);
        if (!before || before.revision !== action.expectedRevision) throw stale();
        const revision = writer.writeTrackedRow({ id: before.id, cardAccountId: accountId, expectedRevision: before.revision,
          marker: action.marker, values: { ...before, cardScopeId: action.scope! } });
        writer.recordEvent({ ...eventBase(observation!), transactionId: before.id, revision, type: 'attributed', reason: 'adjustment',
          fromScopeId: before.cardScopeId, toScopeId: action.scope });
        const outcome = action.outcome === 'attributed' ? 'attributed' : 'inserted';
        resolutions.set(observation!.id, { state: 'resolved', outcome, transactionId: before.id, provenance: 1 });
        if (itemId) committed.set(itemId, { transactionId: before.id, revision, scopeId: outcome === 'attributed' ? action.scope : null });
        ledgerChanged = true;
        break;
      }
      default:
        throw new Error('card ledger: an action this writer does not know');
    }
  }

  flushInserts();
  // W13 after the fact (the plan checked it first): a row this plan unmatched keeps an active identity unless it is merged.
  for (const rowId of unmatchedRows) {
    const row = writer.trackedRow(rowId);
    const merged = row?.removedReason === 'superseded' || row?.removedReason === 'settled-into';
    const active = db.prepare(`SELECT count(*) FROM card_source_identities WHERE canonical_transaction_id = ? AND status = 'active'`)
      .pluck().get(rowId) as number;
    if (!merged && active < 1) throw cardSyncRefusal('adjustment-not-reversible');
  }
  if (runId !== null && seen.size > 0) writer.seeIdentities([...seen], runId);
  const transitions: AppliedPlan['transitions'] = [];
  const entries = [...resolutions];
  for (let start = 0; start < entries.length; start += CHUNK) {
    const chunk = entries.slice(start, start + CHUNK);
    const before = new Map((db.prepare(`SELECT id, state, outcome FROM card_source_observations WHERE id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(chunk.map(([id]) => id))) as Array<{ id: string; state: string; outcome: Outcome | null }>).map((r) => [r.id, r]));
    const changed = db.prepare(`WITH v(id, state, outcome, txn, provenance) AS (VALUES ${chunk.map(() => '(?, ?, ?, ?, ?)').join(', ')})
      UPDATE card_source_observations SET state = v.state, outcome = v.outcome, resolved_transaction_id = v.txn,
        provenance = max(card_source_observations.provenance, v.provenance), resolved_plan_id = ?, resolved_at = ?
      FROM v WHERE card_source_observations.id = v.id AND (card_source_observations.state = 'open') = ?`)
      .run(...chunk.flatMap(([id, r]) => [id, r.state, r.outcome, r.transactionId, r.provenance]), plan.id, now, adjusting ? 0 : 1).changes;
    if (changed !== chunk.length) throw stale();
    for (const [id, r] of chunk) {
      const prior = before.get(id)!;
      const from: Outcome | 'open' = prior.state === 'open' ? 'open' : prior.state === 'rejected' ? 'rejected' : prior.outcome!;
      transitions.push({ observationId: id, from, to: r.state === 'rejected' ? 'rejected' : r.outcome! });
    }
  }
  const items = [...committed];
  for (let start = 0; start < items.length; start += CHUNK) {
    const chunk = items.slice(start, start + CHUNK);
    const changed = db.prepare(`WITH v(id, txn, scope, revision) AS (VALUES ${chunk.map(() => '(?, ?, ?, ?)').join(', ')})
      UPDATE card_reconciliation_suggestions SET status = 'committed', committed_action = draft_action, committed_transaction_id = v.txn,
        committed_scope_id = v.scope, committed_revision = v.revision, committed_plan_id = ?, committed_at = ?, draft_action = NULL,
        draft_transaction_id = NULL, draft_scope_id = NULL, drafted_by_ref = NULL, drafted_at = NULL, updated_at = ?
      FROM v WHERE card_reconciliation_suggestions.id = v.id AND card_reconciliation_suggestions.status = 'decided'`)
      .run(...chunk.flatMap(([id, c]) => [id, c.transactionId, c.scopeId, c.revision]), plan.id, now, now).changes;
    if (changed !== chunk.length) throw stale();
  }
  writer.finish();
  return { ledgerChanged, transitions };
}

/** A pinned row or observation moved under the plan: the digest proved the plan, so this is defensive (§4.10.3). */
const stale = () => cardSyncRefusal('preview-stale');
