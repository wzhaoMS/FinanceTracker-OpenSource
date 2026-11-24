import type { Database as DB } from 'better-sqlite3';

import { CARD_SYNC_ADMISSIONS } from '../cardLedger/admissions.js';
import { classify, REVIEW_ACTION_BITS, type ReviewDecisionAction } from '../cardLedger/classify.js';
import { LedgerOverlay, type LedgerRow, type LedgerView, type StoredIdentity } from '../cardLedger/ledgerView.js';
import { applyToOverlay, type PlannedAction } from '../cardLedger/simulate.js';
import type { CardSyncContext } from './context.js';
import type { ItemRow } from './items.js';
import { cardSyncRefusal } from './refusals.js';
import { setObservations, type SetObservation, type SetRow } from './sets.js';

/**
 * Changing a decision after commit (E1b design §4.9.2): while the set's
 * acceptance lasts, an item of a committed set may take another of its
 * category's actions; the adjustment plan reverses the committed effect and
 * applies the new decision's ordinary effect through the same overlay.
 * Reversibility is tied to the specific committed change and checked when
 * the decision is recorded and again at prepare and commit.
 *
 * Supported here: a link (same-transaction / attribute-and-link) undone to
 * reject-row, insert-new or attribute (revert when the link wrote the row,
 * then unmatch); an insert undone (remove) or re-attributed
 * (restore-attribution); accept-correction ↔ keep-current; reject-row to an
 * insert. Turning an insert into a link (supersede) or a link into another
 * link is refused `action-not-allowed` and changes nothing (D36, accepted as
 * a temporary fail-closed subset), and an item never advertises them. The
 * merge and re-point maintenance operations (§5.7, §5.7.1) can repair the
 * ledger, but in separate calls: not as one atomic adjustment, and the item
 * keeps its committed decision.
 */

const SUPPORTED: Readonly<Record<ReviewDecisionAction, readonly ReviewDecisionAction[]>> = {
  'same-transaction': ['reject-row', 'insert-new', 'attribute'],
  'attribute-and-link': ['reject-row', 'insert-new', 'attribute'],
  'insert-new': ['reject-row', 'attribute'],
  attribute: ['reject-row', 'insert-new'],
  'accept-correction': ['keep-current'],
  'keep-current': ['accept-correction'],
  'reject-row': ['insert-new', 'attribute'],
  'accept-difference': [],
};

/**
 * What a committed item may be changed to (the supported subset above, D36),
 * its committed decision first, since selecting it again drops a draft:
 * what the item's view advertises. Whether a change is still reversible is
 * known only when it is recorded (`adjustment-not-reversible`).
 */
export function adjustableActions(committed: ReviewDecisionAction): readonly ReviewDecisionAction[] {
  return [committed, ...SUPPORTED[committed]];
}

const WRITING_EVENTS = new Set(['promoted', 'corrected', 'restored', 'attributed']);

/** The identities the committed plan attached for this observation (its identity-linked and created events). */
function linkedByCommit(db: DB, item: ItemRow): string[] {
  return db.prepare(`SELECT DISTINCT identity_id FROM card_transaction_events
    WHERE plan_id = ? AND observation_id = ? AND identity_id IS NOT NULL AND event_type IN ('identity-linked', 'created')
    ORDER BY identity_id`).pluck().all(item.committed_plan_id, item.observation_id) as string[];
}

/** Whether the committed action wrote the row's tracked values (§4.9.2's `value_change`). */
function committedValueChange(db: DB, item: ItemRow): boolean {
  if (item.committed_action === 'insert-new' || item.committed_action === 'attribute') return false;
  const types = db.prepare(`SELECT event_type FROM card_transaction_events WHERE plan_id = ? AND observation_id = ?
    AND card_transaction_id = ?`).pluck().all(item.committed_plan_id, item.observation_id, item.committed_transaction_id) as string[];
  return types.some((type) => WRITING_EVENTS.has(type));
}

/**
 * §4.9.2's reversibility for one changed decision: a supported change, none
 * of the item's tuples moved since the commit, and the commit's own change
 * still the row's latest (`adjustment-reversible`).
 */
export function checkAdjustment(ctx: CardSyncContext, item: ItemRow, action: ReviewDecisionAction): void {
  const { db } = ctx;
  const committed = item.committed_action;
  if (committed === null || item.observation_id === null || !SUPPORTED[committed].includes(action)) {
    throw cardSyncRefusal('action-not-allowed');
  }
  if (committed === 'reject-row') return;
  const linked = linkedByCommit(db, item);
  const moved = db.prepare(`SELECT 1 FROM card_transaction_events WHERE identity_id IN (SELECT value FROM json_each(?))
      AND event_type IN ('identity-repointed', 'identity-detached') AND created_at >= ? AND plan_id IS NOT ?`)
    .get(JSON.stringify(linked), item.committed_at, item.committed_plan_id) !== undefined;
  if (moved) throw cardSyncRefusal('adjustment-not-reversible');
  const linking = committed === 'same-transaction' || committed === 'attribute-and-link';
  // A link that attached no tuple of its own has nothing to unmatch: only maintenance can undo it.
  if (linking && linked.length === 0 && action !== 'reject-row') throw cardSyncRefusal('adjustment-not-reversible');
  // W13: undoing the link detaches what it attached; the row must keep another active identity (one detached by
  // maintenance since does not count), or the adjustment is refused rather than orphaning or removing the row.
  if (linking && linked.length > 0) {
    const active = db.prepare(`SELECT id FROM card_source_identities WHERE canonical_transaction_id = ? AND status = 'active'`).pluck()
      .all(item.committed_transaction_id) as string[];
    if (active.filter((id) => !linked.includes(id)).length === 0) throw cardSyncRefusal('adjustment-not-reversible');
  }
  const reversible = ctx.statements.get('adjustment-reversible', {
    value_change: committedValueChange(db, item) ? 1 : 0, committed_revision: item.committed_revision!,
    transaction_id: item.committed_transaction_id!,
  });
  if (reversible?.reversible !== 1) throw cardSyncRefusal('adjustment-not-reversible');
}

function blankAction(ordinal: number, observation: SetObservation, item: ItemRow): PlannedAction {
  return {
    ordinal, op: 'reject', observation: observation.ordinal, item: item.id, content: observation.content, transaction: null,
    expectedRevision: null, newRef: null, related: null, relatedRevision: null, scope: null, promote: false, restore: false, identities: 0,
    reverses: null, source: observation, decision: null, outcome: null, resolution: null, attach: [], reactivate: [], onRow: [],
    values: null, marker: null, attributedFrom: null, promoteReason: null, before: null, after: null, review: null, statement: null,
    deviceCommittable: false,
  };
}

/** The identities as the overlay holds them now (planned moves included). */
function identityRows(db: DB, overlay: LedgerOverlay, ids: readonly string[]): StoredIdentity[] {
  return ids.map((id) => {
    const stored = db.prepare(`SELECT id, status, canonical_transaction_id AS canonicalId, first_seen_status AS firstSeenStatus, namespace,
        source_scope_id AS scopeId, id_hash AS idHash FROM card_source_identities WHERE id = ?`).get(id) as StoredIdentity;
    return overlay.identity(stored) ?? stored;
  });
}

/**
 * The adjustment plan's actions (§4.9.2), item by item in observation order:
 * the reversal of each committed effect, then the new decision's effect,
 * each applied to the overlay before the next is planned.
 */
export function planAdjustment(ctx: CardSyncContext, set: SetRow, view: LedgerView, knownScopes: ReadonlySet<string>,
  scopeKind: (scopeId: string) => LedgerRow['scopeKind']): PlannedAction[] {
  const { db } = ctx;
  const overlay = new LedgerOverlay(view);
  const observations = new Map(setObservations(db, set.id, 'all').map((o) => [o.id, o]));
  const changed = (db.prepare(`SELECT r.* FROM card_reconciliation_suggestions r JOIN card_source_observations o ON o.id = r.observation_id
    WHERE r.observation_set_id = ? AND r.status = 'decided' AND r.committed_action IS NOT NULL ORDER BY o.ordinal`).all(set.id) as ItemRow[]);
  if (changed.length === 0) throw cardSyncRefusal('nothing-to-adjust');
  const actions: PlannedAction[] = [];
  const push = (action: PlannedAction) => {
    applyToOverlay(overlay, action, scopeKind);
    actions.push(action);
  };
  for (const item of changed) {
    const draft = item.draft_action!;
    checkAdjustment(ctx, item, draft);
    const observation = observations.get(item.observation_id!)!;
    const committed = item.committed_action!;
    const target = item.committed_transaction_id === null ? undefined : overlay.row(item.committed_transaction_id);
    let detached: StoredIdentity[] = [];

    if ((committed === 'same-transaction' || committed === 'attribute-and-link' || committed === 'accept-correction') && target) {
      let row = target;
      if (committedValueChange(db, item)) {
        const revert = blankAction(actions.length, observation, item);
        const snapshot = db.prepare('SELECT * FROM card_transaction_versions WHERE card_transaction_id = ? AND revision = ?')
          .get(row.id, row.marker) as Record<string, unknown> | undefined;
        if (row.marker === null || !snapshot) throw cardSyncRefusal('adjustment-not-reversible');
        Object.assign(revert, {
          op: 'revert', transaction: row.id, expectedRevision: row.revision, before: row,
          reverses: ctx.statements.get('revertible-event', { transaction_id: row.id })?.event_id ?? null,
          content: null, observation: observation.ordinal,
        });
        if (revert.reverses === null) throw cardSyncRefusal('adjustment-not-reversible');
        const reverted: LedgerRow = {
          ...row, status: snapshot.status as LedgerRow['status'], transactionDate: snapshot.transaction_date as string,
          postedDate: snapshot.posted_date as string | null, amountMinor: snapshot.amount_minor as number,
          originalAmountMinor: snapshot.original_amount_minor as number | null, originalCurrency: snapshot.original_currency as string | null,
          kind: snapshot.kind as string, description: snapshot.description as string, merchant: snapshot.merchant as string | null,
          issuerCategory: snapshot.issuer_category as string | null, cardScopeId: snapshot.card_scope_id as string,
          scopeKind: scopeKind(snapshot.card_scope_id as string), removedReason: snapshot.removed_reason as string | null,
          removedFromStatus: snapshot.removed_from_status as LedgerRow['removedFromStatus'],
          marker: snapshot.reversal_snapshot_revision as number | null, revision: row.revision + 1,
        };
        overlay.setRow(reverted);
        revert.after = reverted;
        actions.push(revert);
        row = reverted;
      }
      if (committed !== 'accept-correction') {
        const identities = identityRows(db, overlay, linkedByCommit(db, item)).filter((i) => i.status === 'active' && i.canonicalId === row.id);
        if (identities.length > 0) {
          const unmatch = blankAction(actions.length, observation, item);
          Object.assign(unmatch, { op: 'unmatch', transaction: row.id, expectedRevision: row.revision, identities: identities.length,
            content: null, before: row, after: row });
          for (const identity of identities) overlay.setIdentity({ ...identity, status: 'detached' });
          detached = identities.map((identity) => ({ ...identity, status: 'detached' as const }));
          unmatch.reactivate = detached;
          actions.push(unmatch);
        }
      }
      if (committed === 'accept-correction') {
        const keep = blankAction(actions.length, observation, item);
        Object.assign(keep, { op: 'unchanged', transaction: row.id, expectedRevision: row.revision, before: row,
          resolution: row.status === 'removed' ? null : 'kept-current', outcome: 'unchanged',
          decision: { action: draft, transactionId: null, scopeId: null } });
        push(keep);
        continue;
      }
    } else if ((committed === 'insert-new' || committed === 'attribute') && target) {
      const action = blankAction(actions.length, observation, item);
      if (draft === 'reject-row') {
        Object.assign(action, { op: 'remove', transaction: target.id, expectedRevision: target.revision, before: target, outcome: 'rejected',
          decision: { action: draft, transactionId: null, scopeId: null } });
        const removed: LedgerRow = { ...target, status: 'removed', removedReason: 'mistaken-import',
          removedFromStatus: target.status as 'pending' | 'posted', revision: target.revision + 1, marker: null };
        overlay.setRow(removed);
        action.after = removed;
        actions.push(action);
      } else {
        const scope = draft === 'attribute' ? item.draft_scope_id : observation.scopeId;
        if (scope === null || scope === target.cardScopeId || (draft === 'attribute' && !knownScopes.has(scope))) {
          throw cardSyncRefusal('action-not-allowed');
        }
        Object.assign(action, { op: 'restore-attribution', transaction: target.id, expectedRevision: target.revision, scope,
          before: target, attributedFrom: target.cardScopeId, marker: target.revision, content: null,
          outcome: draft === 'attribute' ? 'attributed' : 'inserted', decision: { action: draft, transactionId: null, scopeId: item.draft_scope_id } });
        const moved: LedgerRow = { ...target, cardScopeId: scope, scopeKind: scopeKind(scope), revision: target.revision + 1,
          marker: target.revision };
        overlay.setRow(moved);
        action.after = moved;
        actions.push(action);
      }
      continue;
    }

    // The new decision's effect.
    const action = blankAction(actions.length, observation, item);
    action.decision = { action: draft, transactionId: item.draft_transaction_id, scopeId: item.draft_scope_id };
    if (draft === 'reject-row') {
      action.op = 'reject';
      action.outcome = 'rejected';
      action.content = observation.content;
      push(action);
      continue;
    }
    if (draft === 'accept-correction' && committed === 'keep-current' && target) {
      Object.assign(action, { op: 'correct', transaction: target.id, expectedRevision: target.revision, before: target,
        restore: target.status === 'removed', marker: target.revision, resolution: 'corrected', outcome: 'updated',
        values: { ...observation.values, status: target.status === 'removed' ? (target.removedFromStatus ?? 'posted') : target.status } });
      push(action);
      continue;
    }
    if (draft === 'insert-new' || draft === 'attribute') {
      const cls = classify(observation, { overlay, admissions: CARD_SYNC_ADMISSIONS, excluded: new Set(), knownScopes });
      const fresh = cls.kind === 'insert' || cls.kind === 'review' ? cls.fresh : [];
      const reactivate = [...detached, ...(cls.kind === 'review' || cls.kind === 'insert' ? cls.detached : [])]
        .filter((identity, i, all) => all.findIndex((other) => other.id === identity.id) === i);
      if (cls.kind !== 'review' && cls.kind !== 'insert') throw cardSyncRefusal('adjustment-not-reversible');
      if ((REVIEW_ACTION_BITS[draft] & item.allowed_actions) === 0) throw cardSyncRefusal('action-not-allowed');
      const scope = draft === 'attribute' ? item.draft_scope_id : observation.scopeId;
      if (scope === null || (draft === 'attribute' && (!knownScopes.has(scope) || observation.scopeKind === 'known'))) {
        throw cardSyncRefusal('action-not-allowed');
      }
      Object.assign(action, { op: 'insert', scope, attach: fresh, reactivate, identities: fresh.length + reactivate.length,
        values: observation.values, resolution: 'inserted', attributedFrom: draft === 'attribute' ? observation.scopeId : null,
        outcome: draft === 'attribute' ? 'attributed' : 'inserted' });
      if (action.identities === 0 || action.identities > 4) throw cardSyncRefusal('adjustment-not-reversible');
      push(action);
      continue;
    }
    throw cardSyncRefusal('action-not-allowed');
  }
  // W13 for the whole adjustment's end state: every row it unmatches keeps an active identity unless it is merged.
  for (const rowId of new Set(actions.filter((action) => action.op === 'unmatch').map((action) => action.transaction!))) {
    const row = overlay.row(rowId);
    const merged = row?.removedReason === 'superseded' || row?.removedReason === 'settled-into';
    if (!merged && overlay.activeIdentitiesOf(rowId).length === 0) throw cardSyncRefusal('adjustment-not-reversible');
  }
  return actions;
}
