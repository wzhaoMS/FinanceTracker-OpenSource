import type { Database as DB } from 'better-sqlite3';

import { CARD_SYNC_ADMISSIONS } from '../cardLedger/admissions.js';
import { plainlyLinkable, REVIEW_ACTION_BITS, REVIEW_DECISION_ACTIONS, type ReviewDecisionAction } from '../cardLedger/classify.js';
import { LedgerView } from '../cardLedger/ledgerView.js';
import { simulate } from '../cardLedger/simulate.js';
import { adjustableActions } from './adjustments.js';
import { audit, sessionActorRef, type CardSyncContext } from './context.js';
import {
  candidatesOf, insertItems, itemsOfSet, reclassifyItem, sameClassification, supersedeItem, type CandidateRow, type ItemRow,
} from './items.js';
import { cardSyncRefusal } from './refusals.js';
import {
  excludedRows, isOpenSet, knownScopesOf, ledgerRevisionOf, readSet, requireSet, scopeKinds, setObservations, type CardSyncSetState,
  type SetRow,
} from './sets.js';

/**
 * The owner's review queue (E1b design §5.5, §4.5, §4.10.2): set lists and
 * item pages pinned to one snapshot, the refresh that re-classifies an open
 * set after the ledger moved, decision batches and discard.
 */

export interface CardSyncSetCounts {
  rows: number; open: number; inserted: number; updated: number; matched: number; attributed: number; unchanged: number;
  rejected: number; expired: number;
}

/** A set as the owner API shows it (`SetSummary`): presented as expired from its deadline on (Q46). */
export interface CardSyncSetSummary {
  observationSetId: string;
  sourceKind: 'extension' | 'file';
  cardAccountId: string;
  importBatchId: string | null;
  runId: string | null;
  bindingId: string | null;
  deviceId: string | null;
  payloadDigest: string | null;
  state: CardSyncSetState;
  version: number;
  counts: CardSyncSetCounts;
  acceptedAt: string;
  expiresAt: string;
  receiptState: SetRow['receipt_state'];
  closeReason: string | null;
  discardReason: string | null;
}

export interface CardSyncItemCandidate {
  rank: number;
  transactionId: string;
  rule: string;
  matchedOn: number;
  blockedReason: string | null;
}

export interface CardSyncReviewItemView {
  itemId: string;
  /** −1 for the set-level item, else the observation's ordinal (the page key). */
  itemKey: number;
  observationId: string | null;
  rowIndex: number | null;
  reason: string;
  category: string;
  /** The actions the owner may choose now; none once the set is past its deadline or closed. */
  allowedActions: ReviewDecisionAction[];
  status: string;
  difference: { field: string; expectedMinor: number; actualMinor: number } | null;
  candidates: CardSyncItemCandidate[];
  draft: { action: ReviewDecisionAction; transactionId: string | null; cardScopeId: string | null; decidedAt: string } | null;
  committed: { action: ReviewDecisionAction; transactionId: string | null; cardScopeId: string | null; revision: number | null;
    planId: string; committedAt: string } | null;
}

/** The cursor of a set's item walk (§5.5, Revision 7): the three pins of the first page and the last key served. */
export interface CardSyncSetPageCursor {
  version: number;
  ledgerRevision: number;
  pastDeadline: boolean;
  itemKey: number;
}

export interface CardSyncSetPage {
  set: CardSyncSetSummary;
  version: number;
  ledgerRevision: number;
  pastDeadline: boolean;
  itemCount: number;
  items: CardSyncReviewItemView[];
  next: CardSyncSetPageCursor | null;
}

export const CARD_SYNC_DISCARD_REASONS = ['not-mine', 'wrong-binding', 'duplicate-of-file', 'bad-data', 'other'] as const;
export type CardSyncDiscardReason = (typeof CARD_SYNC_DISCARD_REASONS)[number];

const actionNames = (bits: number) => REVIEW_DECISION_ACTIONS.filter((action) => (REVIEW_ACTION_BITS[action] & bits) !== 0);

export function setSummary(set: SetRow, now: string): CardSyncSetSummary {
  const expired = isOpenSet(set) && now >= set.expires_at;
  return {
    observationSetId: set.id, sourceKind: set.origin, cardAccountId: set.card_account_id, importBatchId: set.import_batch_id,
    runId: set.run_id, bindingId: set.binding_id, deviceId: set.device_id, payloadDigest: set.payload_digest,
    state: expired ? 'expired-unreviewed' : set.state, version: set.version,
    counts: {
      rows: set.row_count, open: set.open_count, inserted: set.inserted_count, updated: set.updated_count, matched: set.matched_count,
      attributed: set.attributed_count, unchanged: set.unchanged_count, rejected: set.rejected_count, expired: set.expired_count,
    },
    acceptedAt: set.accepted_at, expiresAt: set.expires_at, receiptState: set.receipt_state, closeReason: set.close_reason,
    discardReason: set.discard_reason,
  };
}

/** Cancels the set's prepared plan, if any (§4.10.2, §5.5). */
export function cancelPreparedPlans(ctx: CardSyncContext, setId: string, reason: string): number {
  return ctx.db.prepare(`UPDATE card_sync_commit_plans SET status = 'cancelled', cancel_reason = ?, closed_at = ?
    WHERE observation_set_id = ? AND status = 'prepared'`).run(reason, ctx.now, setId).changes;
}

const SET_LIST_LIMIT = 50;

/** Sets newest first (§5.5): `open` = open and before the deadline, `closed` = the rest. */
export function listCardSyncObservationSets(ctx: CardSyncContext, input: {
  view: 'open' | 'closed'; after?: { acceptedAt: string; setId: string } | null; limit: number;
}): { sets: CardSyncSetSummary[]; next: { acceptedAt: string; setId: string } | null } {
  const limit = input?.limit;
  if ((input.view !== 'open' && input.view !== 'closed') || !Number.isInteger(limit) || limit < 1 || limit > SET_LIST_LIMIT) {
    throw cardSyncRefusal('invalid-request');
  }
  const open = "state IN ('accepted-uncommitted', 'needs-review', 'blocked-review', 'recovery-review') AND expires_at > :now";
  const rows = ctx.db.prepare(`SELECT * FROM card_sync_observation_sets
    WHERE ${input.view === 'open' ? open : `NOT (${open})`}
      AND (:after_at IS NULL OR (accepted_at, id) < (:after_at, :after_id))
    ORDER BY accepted_at DESC, id DESC LIMIT :limit`).all({
    now: ctx.now, after_at: input.after?.acceptedAt ?? null, after_id: input.after?.setId ?? '', limit: limit + 1,
  }) as SetRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    sets: page.map((set) => setSummary(set, ctx.now)),
    next: rows.length > limit && last ? { acceptedAt: last.accepted_at, setId: last.id } : null,
  };
}

/**
 * The actions an item offers: an open item's classification allows; a
 * committed item's, only the ones an adjustment supports (D36), within what
 * its classification allowed, so nothing advertised is refused for its kind.
 */
function advertisedActions(item: ItemRow): number {
  if (item.committed_action === null) return item.allowed_actions;
  return adjustableActions(item.committed_action).reduce((bits, action) => bits | REVIEW_ACTION_BITS[action], 0) & item.allowed_actions;
}

function itemView(db: DB, item: ItemRow, itemKey: number, rowIndex: number | null, actionable: boolean, pastDeadline: boolean):
  CardSyncReviewItemView {
  const candidates: CandidateRow[] = candidatesOf(db, item.id);
  const live = item.status === 'open' || item.status === 'decided';
  return {
    itemId: item.id, itemKey, observationId: item.observation_id, rowIndex, reason: item.reason, category: item.category,
    allowedActions: actionable ? actionNames(advertisedActions(item)) : [],
    status: pastDeadline && live ? 'expired' : item.status,
    difference: item.difference_field === null ? null
      : { field: item.difference_field, expectedMinor: item.expected_minor!, actualMinor: item.actual_minor! },
    candidates: candidates.map((c) => ({
      rank: c.rank, transactionId: c.transaction_id, rule: c.rule, matchedOn: c.matched_on, blockedReason: c.blocked_reason,
    })),
    draft: item.draft_action === null ? null : {
      action: item.draft_action, transactionId: item.draft_transaction_id, cardScopeId: item.draft_scope_id, decidedAt: item.drafted_at!,
    },
    committed: item.committed_action === null ? null : {
      action: item.committed_action, transactionId: item.committed_transaction_id, cardScopeId: item.committed_scope_id,
      revision: item.committed_revision, planId: item.committed_plan_id!, committedAt: item.committed_at!,
    },
  };
}

const PAGE_LIMIT = 100;

/**
 * One page of a set's items (§5.5, Revisions 6–7): one read transaction that
 * reads the pins and the page together. The first page returns the pins
 * (set version, ledger revision, past the deadline); a later page carries
 * them and is refused `page-stale` when any moved, so a walk is either
 * consistent with its first page or starts over. `superseded` items are not
 * listed.
 */
export function getCardSyncObservationSetPage(ctx: CardSyncContext, input: {
  setId: string; after: CardSyncSetPageCursor | null; limit: number;
}): CardSyncSetPage | null {
  const { db, now } = ctx;
  if (!Number.isInteger(input?.limit) || input.limit < 1 || input.limit > PAGE_LIMIT) throw cardSyncRefusal('invalid-request');
  const set = readSet(db, input.setId);
  if (!set) return null;
  const ledgerRevision = ledgerRevisionOf(db, set.card_account_id);
  const pastDeadline = now >= set.expires_at;
  const after = input.after;
  if (after !== null) {
    if (typeof after !== 'object' || !Number.isInteger(after.itemKey) || after.itemKey < -1) throw cardSyncRefusal('invalid-request');
    if (after.version !== set.version || after.ledgerRevision !== ledgerRevision || after.pastDeadline !== pastDeadline) {
      throw cardSyncRefusal('page-stale');
    }
  }
  const actionable = !pastDeadline && (isOpenSet(set) || set.state === 'committed');
  const afterKey = after?.itemKey ?? -2;
  const keys: Array<{ itemId: string; itemKey: number }> = [];
  if (afterKey < -1) {
    const setLevel = ctx.statements.get('set-level-item', { set_id: set.id });
    if (setLevel) keys.push({ itemId: setLevel.item_id, itemKey: -1 });
  }
  const remaining = input.limit - keys.length;
  const rows = ctx.statements.all('set-items-page', { set_id: set.id, after_key: Math.max(afterKey, -1), limit: remaining + 1 });
  keys.push(...rows.slice(0, remaining).map((row) => ({ itemId: row.item_id, itemKey: row.item_key })));
  const itemCount = db.prepare(`SELECT count(*) FROM card_reconciliation_suggestions
    WHERE observation_set_id = ? AND status <> 'superseded'`).pluck().get(set.id) as number;
  const itemStatement = db.prepare(`SELECT r.*, o.file_row_index AS row_index FROM card_reconciliation_suggestions r
    LEFT JOIN card_source_observations o ON o.id = r.observation_id WHERE r.id = ?`);
  const items = keys.map(({ itemId, itemKey }) => {
    const item = itemStatement.get(itemId) as ItemRow & { row_index: number | null };
    return itemView(db, item, itemKey, item.row_index, actionable, pastDeadline);
  });
  const last = keys[keys.length - 1];
  return {
    set: setSummary(set, now), version: set.version, ledgerRevision, pastDeadline, itemCount, items,
    next: rows.length > remaining && last ? { version: set.version, ledgerRevision, pastDeadline, itemKey: last.itemKey } : null,
  };
}

/**
 * §4.5's refresh of an open set whose review mark is behind the ledger: the
 * same simulation re-classifies its open observations in place. New
 * ambiguity gets an item, a changed item its new classification under the
 * draft protocol, an item that no longer needs a person is superseded. The
 * set's version moves once if anything changed (and its prepared plan is
 * cancelled); otherwise only the mark moves. Returns how many items changed.
 */
export function refreshSet(ctx: CardSyncContext, set: SetRow): { changed: number; set: SetRow } {
  const { db, now } = ctx;
  const ledgerRevision = ledgerRevisionOf(db, set.card_account_id);
  if (!isOpenSet(set) || now >= set.expires_at || set.review_ledger_revision === ledgerRevision) return { changed: 0, set };
  const observations = setObservations(db, set.id, 'open');
  const view = new LedgerView(db, set.card_account_id, set.currency);
  const { actions } = simulate({
    mode: 'classify', observations, decisions: new Map(), excluded: excludedRows(view, observations), knownScopes: knownScopesOf(db, set),
    statement: null,
  }, view, CARD_SYNC_ADMISSIONS, scopeKinds(db, set.card_account_id));
  const items = new Map(itemsOfSet(db, set.id).filter((item) => item.observation_id !== null).map((item) => [item.observation_id!, item]));
  let changed = 0;
  const fresh: Array<{ observationId: string; action: (typeof actions)[number] }> = [];
  for (const action of actions) {
    const observation = action.source;
    if (!observation) continue;
    const item = items.get(observation.id);
    if (action.op === 'review') {
      if (!item) {
        fresh.push({ observationId: observation.id, action });
      } else if (item.status === 'superseded'
        || ((item.status === 'open' || item.status === 'decided') && !sameClassification(item, candidatesOf(db, item.id), action.review!))) {
        reclassifyItem(db, now, item, action.review!, ledgerRevision);
        changed += 1;
      }
    } else if (item && (item.status === 'open' || item.status === 'decided')) {
      supersedeItem(db, now, item);
      changed += 1;
    }
  }
  if (fresh.length > 0) {
    insertItems(db, now, set, fresh.map(({ observationId, action }) => ({ observationId, review: action.review!, statement: null })),
      ledgerRevision);
    changed += fresh.length;
  }
  const needsPerson = (db.prepare(`SELECT count(*) FROM card_reconciliation_suggestions
    WHERE observation_set_id = ? AND status IN ('open', 'decided')`).pluck().get(set.id) as number) > 0;
  const state = needsPerson && set.state === 'accepted-uncommitted' ? 'needs-review' : set.state;
  db.prepare(`UPDATE card_sync_observation_sets SET review_ledger_revision = ?, state = ?, version = version + ?
    WHERE id = ? AND version = ?`).run(ledgerRevision, state, changed > 0 ? 1 : 0, set.id, set.version);
  if (changed > 0) {
    cancelPreparedPlans(ctx, set.id, 'decisions-changed');
    audit(ctx, 'review-refreshed', { kind: 'system' }, {
      cardAccountId: set.card_account_id, observationSetId: set.id, itemCount: changed, versionBefore: set.version,
      versionAfter: set.version + 1,
    });
  }
  return { changed, set: readSet(db, set.id)! };
}

/** E2 refreshes a set before rendering it (§5.5); a write, never an owner action. */
export function refreshCardReviewItems(ctx: CardSyncContext, input: { setId: string }):
  { changed: boolean; version: number; expired: boolean } {
  const set = requireSet(ctx.db, input?.setId);
  const expired = ctx.now >= set.expires_at;
  const { changed, set: after } = refreshSet(ctx, set);
  return { changed: changed > 0, version: after.version, expired };
}

export interface CardReviewDecisionInput {
  itemId: string;
  action: ReviewDecisionAction;
  transactionId: string | null;
  cardScopeId: string | null;
}

const ITEM_ID = /^rvw_[a-p]{32}$/;
const TRANSACTION_ID = /^card-txn-[a-p]{32}$/;
const SCOPE_ID = /^scp_[a-p]{32}$/;
const MAX_DECISIONS = 200;

function readDecisions(value: unknown): CardReviewDecisionInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_DECISIONS) throw cardSyncRefusal('invalid-request');
  const seen = new Set<string>();
  return value.map((entry: unknown) => {
    const d = entry as Partial<CardReviewDecisionInput> | null;
    if (typeof d !== 'object' || d === null || typeof d.itemId !== 'string' || !ITEM_ID.test(d.itemId) || seen.has(d.itemId)
      || !REVIEW_DECISION_ACTIONS.includes(d.action as ReviewDecisionAction)
      || !(d.transactionId === null || (typeof d.transactionId === 'string' && TRANSACTION_ID.test(d.transactionId)))
      || !(d.cardScopeId === null || (typeof d.cardScopeId === 'string' && SCOPE_ID.test(d.cardScopeId)))) {
      throw cardSyncRefusal('invalid-request');
    }
    seen.add(d.itemId);
    return { itemId: d.itemId, action: d.action!, transactionId: d.transactionId, cardScopeId: d.cardScopeId };
  });
}

/** An observation's ids on its scope: its primary tuple, then its secondary ids. */
function observationTuples(db: DB, observationId: string): Array<{ scopeId: string; namespace: string; idHash: string }> {
  return db.prepare(`SELECT source_scope_id AS scopeId, identity_namespace AS namespace, identity_hash AS idHash
      FROM card_source_observations WHERE id = ?
    UNION ALL SELECT o.source_scope_id, s.namespace, s.id_hash FROM card_observation_secondary_ids s
      JOIN card_source_observations o ON o.id = s.observation_id WHERE s.observation_id = ?`)
    .all(observationId, observationId) as Array<{ scopeId: string; namespace: string; idHash: string }>;
}

/** The scope rules of §4.6 for a decision on a row item; refuses what the item cannot take. */
function checkDecision(db: DB, set: SetRow, item: ItemRow, decision: CardReviewDecisionInput, knownScopes: ReadonlySet<string>): void {
  if ((REVIEW_ACTION_BITS[decision.action] & item.allowed_actions) === 0) throw cardSyncRefusal('action-not-allowed');
  const targeted = decision.action === 'same-transaction' || decision.action === 'attribute-and-link';
  if (targeted !== (decision.transactionId !== null)) throw cardSyncRefusal('action-not-allowed');
  const scoped = decision.action === 'attribute' || decision.action === 'attribute-and-link';
  if (!scoped && decision.cardScopeId !== null) throw cardSyncRefusal('action-not-allowed');
  if (targeted && !candidatesOf(db, item.id).some((c) => c.transaction_id === decision.transactionId && c.blocked_reason === null)) {
    throw cardSyncRefusal('action-not-allowed');
  }
  const observation = db.prepare('SELECT source_scope_id AS scopeId, source_scope_kind AS scopeKind FROM card_source_observations WHERE id = ?')
    .get(item.observation_id) as { scopeId: string; scopeKind: 'known' | 'unknown' | 'legacy' };
  // §4.4 row 5 (S10): a known observation joins an unresolved row (unknown or legacy scope) only through `attribute-and-link`.
  // An identity hit's own row (pending-posted, removed-hit: a promotion) is not a new link.
  if (decision.action === 'same-transaction' && item.reason !== 'pending-posted' && item.reason !== 'removed-hit') {
    const target = db.prepare(`SELECT s.kind FROM card_transactions t JOIN card_scopes s ON s.id = t.card_scope_id WHERE t.id = ?`)
      .get(decision.transactionId) as { kind: 'known' | 'unknown' | 'legacy' };
    if (!plainlyLinkable({ blocked: null, scopeKind: target.kind }, observation)) throw cardSyncRefusal('action-not-allowed');
  }
  // A link needs a tuple of the observation that can be the target's: one with no identity yet, a detached one, or one
  // already on the target. A candidate the observation's ids all name another row for (a v1 row whose key belongs to the
  // pending row it would post, listed beside a synced row that may be the same purchase; E2d review r1, finding 2) is
  // refused now, as the plan would refuse it (§4.6).
  if (targeted && item.reason !== 'pending-posted' && item.reason !== 'removed-hit'
    && !observationTuples(db, item.observation_id!).some((tuple) => {
      const identity = db.prepare(`SELECT status, canonical_transaction_id AS canonicalId FROM card_source_identities
        WHERE card_account_id = ? AND source_scope_id = ? AND namespace = ? AND id_hash = ?`)
        .get(set.card_account_id, tuple.scopeId, tuple.namespace, tuple.idHash) as { status: string; canonicalId: string } | undefined;
      return !identity || identity.status !== 'active' || identity.canonicalId === decision.transactionId;
    })) {
    throw cardSyncRefusal('action-not-allowed');
  }
  if (!scoped) return;
  if (decision.action === 'attribute') {
    if (observation.scopeKind === 'known' || decision.cardScopeId === null || !knownScopes.has(decision.cardScopeId)) {
      throw cardSyncRefusal('action-not-allowed');
    }
    return;
  }
  const scope = observation.scopeKind === 'known' ? observation.scopeId : decision.cardScopeId;
  if (scope === null || !knownScopes.has(scope) || (observation.scopeKind === 'known' && decision.cardScopeId !== null
    && decision.cardScopeId !== scope)) {
    throw cardSyncRefusal('action-not-allowed');
  }
  const target = db.prepare(`SELECT t.card_scope_id AS scopeId, s.kind FROM card_transactions t JOIN card_scopes s ON s.id = t.card_scope_id
    WHERE t.id = ?`).get(decision.transactionId) as { scopeId: string; kind: string };
  if (target.kind === 'known') throw cardSyncRefusal(target.scopeId === scope ? 'action-not-allowed' : 'cross-card-link-refused');
  void set;
}

/**
 * Whether a decision on a committed item is its committed decision, compared
 * in the decision's own shape (review r1, finding 11). The committed columns
 * hold what the commit used (an inserted or corrected row's id, the scope an
 * attribution took), while a decision names a row only for the two linking
 * actions and a scope only for the two attributing ones, and a known
 * observation's `attribute-and-link` may leave its own scope implicit.
 */
function isCommittedDecision(db: DB, item: ItemRow, decision: CardReviewDecisionInput): boolean {
  if (decision.action !== item.committed_action) return false;
  const targeted = decision.action === 'same-transaction' || decision.action === 'attribute-and-link';
  if (decision.transactionId !== (targeted ? item.committed_transaction_id : null)) return false;
  if (decision.action === 'attribute') return decision.cardScopeId === item.committed_scope_id;
  if (decision.action !== 'attribute-and-link') return decision.cardScopeId === null;
  if (decision.cardScopeId !== null || item.observation_id === null) return decision.cardScopeId === item.committed_scope_id;
  const observation = db.prepare('SELECT source_scope_id AS scopeId, source_scope_kind AS scopeKind FROM card_source_observations WHERE id = ?')
    .get(item.observation_id) as { scopeId: string; scopeKind: string } | undefined;
  return observation?.scopeKind === 'known' && observation.scopeId === item.committed_scope_id;
}

/**
 * §4.10.2's decision batch, one transaction: the whole batch validated
 * (items of this set, ids unique, actions allowed, targets unblocked
 * candidates, scope rules, no two decisions on one row, and for a committed
 * set a changed decision whose committed effect is still reversible), every
 * draft stored, the set version moved once, its prepared plan cancelled.
 * Answers the set's first page.
 */
export function recordCardReviewDecisions(ctx: CardSyncContext, input: {
  setId: string; expectedVersion: number; decisions: CardReviewDecisionInput[]; actorRef: string;
}, reversible: (set: SetRow, item: ItemRow, decision: CardReviewDecisionInput) => void): CardSyncSetPage {
  const { db, now } = ctx;
  const actorRef = sessionActorRef(input?.actorRef);
  const set = requireSet(db, input.setId);
  if (set.state === 'rejected') throw cardSyncRefusal('set-closed');
  if (now >= set.expires_at || set.state === 'expired-unreviewed') throw cardSyncRefusal('observation-expired');
  if (set.version !== input.expectedVersion) throw cardSyncRefusal('version-conflict');
  const committed = set.state === 'committed';
  if (!committed && set.review_ledger_revision !== ledgerRevisionOf(db, set.card_account_id)) throw cardSyncRefusal('review-stale');
  const decisions = readDecisions(input.decisions);
  const items = new Map(itemsOfSet(db, set.id).map((item) => [item.id, item]));
  const knownScopes = knownScopesOf(db, set);
  const finals = new Map<string, ItemRow['status']>();
  for (const decision of decisions) {
    const item = items.get(decision.itemId);
    if (!item) throw cardSyncRefusal('not-found');
    if (committed) {
      if (item.committed_action === null || (item.status !== 'committed' && item.status !== 'decided')) {
        throw cardSyncRefusal('action-not-allowed');
      }
      if (isCommittedDecision(db, item, decision)) {
        finals.set(item.id, 'committed');
        continue;
      }
      if (item.observation_id === null) throw cardSyncRefusal('action-not-allowed');
      checkDecision(db, set, item, decision, knownScopes);
      reversible(set, item, decision);
    } else {
      if (item.status !== 'open' && item.status !== 'decided') throw cardSyncRefusal('action-not-allowed');
      if (item.observation_id === null) {
        if (decision.action !== 'accept-difference' || decision.transactionId !== null || decision.cardScopeId !== null) {
          throw cardSyncRefusal('action-not-allowed');
        }
      } else {
        checkDecision(db, set, item, decision, knownScopes);
      }
    }
    finals.set(item.id, 'decided');
  }
  // No two decisions of the set (this batch and the drafts it leaves in place) may claim one row.
  const claims = new Map<string, string>();
  const claim = (itemId: string, action: ReviewDecisionAction | null, transactionId: string | null) => {
    if (transactionId === null || (action !== 'same-transaction' && action !== 'attribute-and-link')) return;
    const holder = claims.get(transactionId);
    if (holder !== undefined && holder !== itemId) throw cardSyncRefusal('decision-conflict');
    claims.set(transactionId, itemId);
  };
  const batch = new Map(decisions.map((d) => [d.itemId, d]));
  for (const item of items.values()) {
    const decision = batch.get(item.id);
    if (decision) claim(item.id, decision.action, decision.transactionId);
    else if (item.status === 'decided') claim(item.id, item.draft_action, item.draft_transaction_id);
    else if (committed && item.status === 'committed') claim(item.id, item.committed_action, item.committed_transaction_id);
  }
  const writeDraft = db.prepare(`UPDATE card_reconciliation_suggestions SET status = 'decided', draft_action = ?,
      draft_transaction_id = ?, draft_scope_id = ?, drafted_by_ref = ?, drafted_at = ?, updated_at = ? WHERE id = ?`);
  const backToCommitted = db.prepare(`UPDATE card_reconciliation_suggestions SET status = 'committed', draft_action = NULL,
      draft_transaction_id = NULL, draft_scope_id = NULL, drafted_by_ref = NULL, drafted_at = NULL, updated_at = ? WHERE id = ?`);
  for (const decision of decisions) {
    if (finals.get(decision.itemId) === 'committed') {
      if (items.get(decision.itemId)!.status !== 'committed') backToCommitted.run(now, decision.itemId);
    } else {
      writeDraft.run(decision.action, decision.transactionId, decision.cardScopeId, actorRef, now, now, decision.itemId);
    }
  }
  db.prepare('UPDATE card_sync_observation_sets SET version = version + 1 WHERE id = ? AND version = ?').run(set.id, set.version);
  cancelPreparedPlans(ctx, set.id, 'decisions-changed');
  audit(ctx, 'review-decided', { kind: 'session', ref: actorRef }, {
    cardAccountId: set.card_account_id, observationSetId: set.id, itemCount: decisions.length, versionBefore: set.version,
    versionAfter: set.version + 1,
  });
  return getCardSyncObservationSetPage(ctx, { setId: set.id, after: null, limit: PAGE_LIMIT })!;
}

/**
 * Discards an open set (§5.5): its observations deleted (items, candidates
 * and secondary ids cascade), the set-level item discarded, prepared plans
 * cancelled, the receipt given up and deleted, coverage rejected, and the
 * set closed as `rejected` with its reason (a 365-day tombstone). Allowed
 * while paused or blocked; idempotent for a discarded set.
 */
export function discardCardSyncObservationSet(ctx: CardSyncContext, input: {
  setId: string; expectedVersion: number; reason: CardSyncDiscardReason; actorRef: string;
}): CardSyncSetSummary {
  const { db, now } = ctx;
  const actorRef = sessionActorRef(input?.actorRef);
  if (!CARD_SYNC_DISCARD_REASONS.includes(input.reason)) throw cardSyncRefusal('invalid-request');
  const set = requireSet(db, input.setId);
  if (set.state === 'rejected') return setSummary(set, now);
  if (!isOpenSet(set)) throw cardSyncRefusal('set-closed');
  if (now >= set.expires_at) throw cardSyncRefusal('observation-expired');
  if (set.version !== input.expectedVersion) throw cardSyncRefusal('version-conflict');
  if (db.prepare("SELECT 1 FROM card_source_observations WHERE observation_set_id = ? AND (state <> 'open' OR provenance = 1)")
    .get(set.id) !== undefined) {
    throw cardSyncRefusal('set-closed');
  }
  db.prepare(`UPDATE card_reconciliation_suggestions SET status = 'discarded', draft_action = NULL, draft_transaction_id = NULL,
      draft_scope_id = NULL, drafted_by_ref = NULL, drafted_at = NULL, updated_at = ?
    WHERE observation_set_id = ? AND observation_id IS NULL AND status IN ('open', 'decided', 'superseded')`).run(now, set.id);
  db.prepare('DELETE FROM card_source_observations WHERE observation_set_id = ?').run(set.id);
  cancelPreparedPlans(ctx, set.id, 'set-closed');
  let version = set.version;
  if (set.receipt_state === 'kept') {
    db.prepare(`UPDATE card_sync_observation_sets SET receipt_state = 'deleted', version = version + 1 WHERE id = ?`).run(set.id);
    db.prepare('DELETE FROM card_sync_payload_receipts WHERE observation_set_id = ?').run(set.id);
    version += 1;
  }
  db.prepare(`UPDATE card_coverage_windows SET ledger_state = 'rejected', updated_at = ?
    WHERE observation_set_id = ? AND ledger_state = 'observed-uncommitted'`).run(now, set.id);
  db.prepare(`UPDATE card_sync_observation_sets SET state = 'rejected', version = version + 1, rejected_count = rejected_count + open_count,
      open_count = 0, closed_at = ?, close_reason = 'discarded', discard_reason = ?, closed_by_ref = ?, content_purged_at = ?
    WHERE id = ?`).run(now, input.reason, actorRef, now, set.id);
  audit(ctx, 'set-discarded', { kind: 'session', ref: actorRef }, {
    cardAccountId: set.card_account_id, observationSetId: set.id, code: input.reason, rowCount: set.open_count,
    versionBefore: set.version, versionAfter: version + 1,
  });
  return setSummary(readSet(db, set.id)!, now);
}
