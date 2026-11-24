import type { Database as DB } from 'better-sqlite3';

import { newCardSyncId } from '../cardSyncDigests.js';
import { CARD_SYNC_ADMISSIONS } from '../cardLedger/admissions.js';
import { LedgerView } from '../cardLedger/ledgerView.js';
import {
  bodyAction, countsOf, headerOf, planCounts, planDigest, type PlanCounts, type PlanHeader,
} from '../cardLedger/planBody.js';
import { deviceMayCommit, simulate, type PlanDecision, type PlannedAction } from '../cardLedger/simulate.js';
import type { LedgerActor } from '../cardLedger/writer.js';
import { checkAdjustment, planAdjustment } from './adjustments.js';
import { applyPlan } from './apply.js';
import { consentIsCurrent, currentSourceAuthorization, readBinding, type AuthorizedSource } from './authorization.js';
import { insertRows } from './bulk.js';
import { audit, secondsAfter, type CardSyncContext } from './context.js';
import { itemsOfSet, type ItemRow } from './items.js';
import type { CardSyncPrincipal } from './principals.js';
import { cardSyncRefusal } from './refusals.js';
import { cancelPreparedPlans, refreshSet } from './review.js';
import { runRow } from './runs.js';
import {
  cardSyncPayloadSealed, excludedRows, isOpenSet, knownScopesOf, ledgerRevisionOf, readSet, rehydrateCardSyncPayload, requireSet,
  scopeKinds, setObservations, type SetRow,
} from './sets.js';

/**
 * Plans and commit (E1b design §5.6, §4.8–§4.10.3): a device's preview with
 * a hand-off, the owner's executable plan, and the commit that recomputes
 * the plan, compares digests and applies it whole.
 */

export const CARD_SYNC_PLAN_SECONDS = 600;
/** Prepared plans a device may hold at once (I25). */
export const CARD_SYNC_PLANS_PER_DEVICE = 2;
const EFFECTS_PAGE = 500;

export interface CardSyncPlanEffect {
  ordinal: number;
  op: string;
  observationOrdinal: number | null;
  itemId: string | null;
  transactionId: string | null;
  newRef: number | null;
  relatedTransactionId: string | null;
  cardScopeId: string | null;
  promote: boolean;
  restore: boolean;
  identities: number;
  reversesEventId: string | null;
  expectedRevision: number | null;
}

export interface CardSyncPlanView {
  status: 'executable';
  planKind: 'set' | 'adjustment';
  previewId: string;
  observationSetId: string;
  setVersion: number;
  planDigest: string;
  /** Null exactly for file sets. */
  payloadDigest: string | null;
  expiresAt: string;
  counts: PlanCounts;
  effectCount: number;
  effects: CardSyncPlanEffect[];
}

/** A device's answer when a person is needed: nothing stored, no `previewId` key at all (X24). */
export interface CardSyncOwnerReview {
  status: 'owner-review';
  observationSetId: string;
  counts: PlanCounts;
  reviewCount: number;
}

/**
 * What a commit did, from the consumed plan's row alone, so a replay (C6)
 * answers exactly what the commit answered, however the set and the ledger
 * have moved since (review r1, finding 9): `committedAt` is the plan's
 * closure and `setVersion` the version the commit left the set at (it moves
 * the pinned version by exactly one). The ledger's revision is not part of
 * it: nothing stores the revision a commit produced, and a current one would
 * change between replays.
 */
export interface CardSyncCommitResult {
  status: 'committed';
  previewId: string;
  planKind: 'set' | 'adjustment';
  observationSetId: string;
  planDigest: string;
  payloadDigest: string | null;
  counts: PlanCounts;
  setVersion: number;
  committedAt: string;
  replayed: boolean;
}

interface PlanRow {
  id: string; plan_kind: 'set' | 'adjustment'; card_account_id: string; observation_set_id: string; set_version: number;
  principal_kind: 'device' | 'session'; device_id: string | null; actor_ref: string | null; binding_id: string | null;
  binding_version: number | null; payload_digest: string | null; plan_digest: string; auto_eligible: number; source_reviewed: number;
  action_count: number; count_insert: number; count_update: number; count_unchanged: number; count_aliased: number;
  count_matched: number; count_attributed: number; count_promoted: number; count_corrected: number; count_rejected: number;
  count_unmatched: number; count_superseded: number; ledger_revision: number; policy_revision: number | null;
  issuer_policy_revision: number | null; contract_version: number | null; guard_revision: number;
  authorization_generation: string | null; created_at: string; expires_at: string; status: 'prepared' | 'consumed' | 'expired' | 'cancelled';
  closed_at: string | null; cancel_reason: string | null;
}

const PLAN_ID = /^prv_[a-p]{32}$/;
const GENERATION = /^agn_[a-p]{32}$/;
const ACTION_COLUMNS = ['plan_id', 'ordinal', 'card_account_id', 'plan_kind', 'op', 'observation_ordinal', 'review_item_id',
  'content_digest', 'transaction_id', 'expected_revision', 'new_ref', 'related_transaction_id', 'related_revision', 'scope_id', 'promote',
  'restore', 'identity_count', 'reverses_event_id'] as const;

function readPlan(db: DB, previewId: unknown): PlanRow | undefined {
  if (typeof previewId !== 'string' || !PLAN_ID.test(previewId)) return undefined;
  return db.prepare('SELECT * FROM card_sync_commit_plans WHERE id = ?').get(previewId) as PlanRow | undefined;
}

/** The principal as a plan names it; the service token never plans (§4.10.1). */
function planPrincipal(principal: CardSyncPrincipal): { kind: 'device' | 'session'; id: string } {
  const candidate = principal as { kind?: unknown; deviceId?: unknown; actorRef?: unknown } | null;
  if (candidate?.kind === 'device' && typeof candidate.deviceId === 'string' && /^dev_[a-p]{32}$/.test(candidate.deviceId)) {
    return { kind: 'device', id: candidate.deviceId };
  }
  if (candidate?.kind === 'session' && typeof candidate.actorRef === 'string' && /^usr_[a-p]{32}$/.test(candidate.actorRef)) {
    return { kind: 'session', id: candidate.actorRef };
  }
  throw cardSyncRefusal('principal-not-allowed');
}

const generationOf = (value: unknown): string => {
  if (typeof value !== 'string' || !GENERATION.test(value)) throw cardSyncRefusal('invalid-request');
  return value;
};

/** What a set's simulation reads: its open observations, the exclusions, the binding's scopes, its set-level item. */
function simulationInput(db: DB, set: SetRow, view: LedgerView) {
  const observations = setObservations(db, set.id, 'open');
  const setLevel = itemsOfSet(db, set.id).find((item) => item.observation_id === null && item.status !== 'superseded');
  return {
    observations, excluded: excludedRows(view, observations), knownScopes: knownScopesOf(db, set),
    statement: setLevel ? {
      itemId: setLevel.id,
      difference: { field: setLevel.difference_field as 'charges', expectedMinor: setLevel.expected_minor!, actualMinor: setLevel.actual_minor! },
    } : null,
  };
}

/** The owner's drafts of an open set as the planner takes them; every item that needs a person must have one. */
function draftsOf(items: readonly ItemRow[]): Map<string, PlanDecision> {
  const decisions = new Map<string, PlanDecision>();
  for (const item of items) {
    if (item.status === 'open') throw cardSyncRefusal('decisions-incomplete');
    if (item.status === 'decided') {
      decisions.set(item.id, { action: item.draft_action!, transactionId: item.draft_transaction_id, scopeId: item.draft_scope_id });
    }
  }
  return decisions;
}

interface Planned {
  actions: PlannedAction[];
  header: PlanHeader;
  counts: PlanCounts;
  digest: string;
}

/**
 * The plan of a set for a principal, from the ledger as it is now: a device's
 * from a simulation without decisions, an owner's set plan with every
 * decision applied. Commit calls it again with the stored pins and must get
 * the stored digest.
 */
function planSet(ctx: CardSyncContext, set: SetRow, principal: { kind: 'device' | 'session'; id: string }, pins: {
  source: AuthorizedSource | null; generation: string | null; autoEligible: boolean; sourceReviewed: boolean;
}): Planned {
  const { view, actions } = planActions(ctx, set, principal);
  // Only an executable plan has a body (review findings r1, 1): a recomputation that needs a person is stale, never a crash.
  if (actions.some((action) => action.op === 'review')) throw cardSyncRefusal('preview-stale');
  return sealPlan(ctx, set, principal, pins, view, actions);
}

/**
 * The actions of a set's plan for a principal, from the ledger as it is now:
 * a device's simulation without decisions (review actions kept, so the
 * caller can see that a person is needed), an owner's set plan with every
 * decision applied, or an adjustment plan.
 */
function planActions(ctx: CardSyncContext, set: SetRow, principal: { kind: 'device' | 'session'; id: string }):
  { view: LedgerView; actions: PlannedAction[] } {
  const { db } = ctx;
  const view = new LedgerView(db, set.card_account_id, set.currency);
  const base = simulationInput(db, set, view);
  let actions: PlannedAction[];
  if (set.state === 'committed') {
    actions = planAdjustment(ctx, set, view, knownScopesOf(db, set), scopeKinds(db, set.card_account_id));
  } else if (principal.kind === 'device') {
    actions = simulate({ mode: 'classify', ...base, decisions: new Map(), statement: null }, view, CARD_SYNC_ADMISSIONS,
      scopeKinds(db, set.card_account_id)).actions;
  } else {
    const items = itemsOfSet(db, set.id).filter((item) => item.status !== 'superseded');
    const decisions = draftsOf(items);
    actions = simulate({ mode: 'set', ...base, decisions }, view, CARD_SYNC_ADMISSIONS, scopeKinds(db, set.card_account_id)).actions;
    const used = new Set(actions.map((action) => action.item));
    if ([...decisions.keys()].some((itemId) => !used.has(itemId))) throw cardSyncRefusal('review-stale');
  }
  return { view, actions };
}

/** An executable plan's header, counts and `pl1:` digest over its actions (none of them a review). */
function sealPlan(ctx: CardSyncContext, set: SetRow, principal: { kind: 'device' | 'session'; id: string }, pins: {
  source: AuthorizedSource | null; generation: string | null; autoEligible: boolean; sourceReviewed: boolean;
}, view: LedgerView, actions: PlannedAction[]): Planned {
  const planKind = set.state === 'committed' ? 'adjustment' as const : 'set' as const;
  const header: PlanHeader = {
    planKind, cardAccountId: set.card_account_id, observationSetId: set.id, setVersion: set.version, principal,
    bindingId: set.origin === 'extension' ? set.binding_id : null,
    bindingVersion: pins.source ? pins.source.binding.version : null, contractVersion: set.origin === 'extension' ? set.contract_version : null,
    payloadDigest: set.payload_digest, ledgerRevision: view.ledgerRevision(), policyRevision: pins.source?.policyRevision ?? null,
    issuerPolicyRevision: pins.source?.issuerRevision ?? null, guardRevision: ctx.guardRevision, authorizationGeneration: pins.generation,
    autoEligible: pins.autoEligible, sourceReviewed: pins.sourceReviewed,
  };
  const counts = planCounts(actions);
  return { actions, header, counts, digest: planDigest(header, actions.map(bodyAction), counts) };
}

function storePlan(ctx: CardSyncContext, set: SetRow, planned: Planned): CardSyncPlanView {
  const { db, now } = ctx;
  const { header, counts, actions } = planned;
  cancelPreparedPlans(ctx, set.id, 'superseded');
  const previewId = newCardSyncId('prv_');
  const expiresAt = [secondsAfter(now, CARD_SYNC_PLAN_SECONDS), set.expires_at].sort()[0];
  db.prepare(`INSERT INTO card_sync_commit_plans (id, plan_kind, card_account_id, observation_set_id, set_version, principal_kind,
      device_id, actor_ref, binding_id, binding_version, payload_digest, plan_digest, auto_eligible, source_reviewed, action_count,
      count_insert, count_update, count_unchanged, count_aliased, count_matched, count_attributed, count_promoted, count_corrected,
      count_rejected, count_unmatched, count_superseded, ledger_revision, policy_revision, issuer_policy_revision, contract_version,
      guard_revision, authorization_generation, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(previewId, header.planKind, header.cardAccountId, header.observationSetId, header.setVersion, header.principal.kind,
      header.principal.kind === 'device' ? header.principal.id : null, header.principal.kind === 'session' ? header.principal.id : null,
      header.bindingId, header.bindingVersion, header.payloadDigest, planned.digest, header.autoEligible ? 1 : 0,
      header.sourceReviewed ? 1 : 0, actions.length, counts.insert, counts.update, counts.unchanged, counts.aliased, counts.matched,
      counts.attributed, counts.promoted, counts.corrected, counts.rejected, counts.unmatched, counts.superseded, header.ledgerRevision,
      header.policyRevision, header.issuerPolicyRevision, header.contractVersion, header.guardRevision, header.authorizationGeneration,
      now, expiresAt);
  insertRows(db, 'card_sync_plan_actions', ACTION_COLUMNS, actions.map(bodyAction).map((a) => [
    previewId, a.ordinal, header.cardAccountId, header.planKind, a.op, a.observation, a.item, a.content, a.transaction, a.expectedRevision,
    a.newRef, a.related, a.relatedRevision, a.scope, a.promote ? 1 : 0, a.restore ? 1 : 0, a.identities, a.reverses,
  ]));
  audit(ctx, 'plan-prepared', header.principal.kind === 'device' ? { kind: 'device', ref: header.principal.id }
    : { kind: 'session', ref: header.principal.id }, {
    cardAccountId: set.card_account_id, bindingId: header.bindingId, deviceId: set.device_id, runId: set.run_id, observationSetId: set.id,
    planId: previewId, rowCount: actions.length, versionBefore: set.version, versionAfter: set.version,
    generation: header.authorizationGeneration,
  });
  const effectCount = actions.length - counts.unchanged;
  return {
    status: 'executable', planKind: header.planKind, previewId, observationSetId: set.id, setVersion: set.version,
    planDigest: planned.digest, payloadDigest: set.payload_digest, expiresAt, counts, effectCount,
    effects: actions.filter((action) => action.op !== 'unchanged').slice(0, EFFECTS_PAGE).map(effectOf),
  };
}

const effectOf = (action: { ordinal: number; op: string; observation: number | null; item: string | null; transaction: string | null;
  newRef: number | null; related: string | null; scope: string | null; promote: boolean; restore: boolean; identities: number;
  reverses: string | null; expectedRevision: number | null }): CardSyncPlanEffect => ({
  ordinal: action.ordinal, op: action.op, observationOrdinal: action.observation, itemId: action.item, transactionId: action.transaction,
  newRef: action.newRef, relatedTransactionId: action.related, cardScopeId: action.scope, promote: action.promote, restore: action.restore,
  identities: action.identities, reversesEventId: action.reverses, expectedRevision: action.expectedRevision,
});

/**
 * Device prepare (§5.6, X24, Revision 4): a preview that hands the set to the
 * owner whenever a person is needed. It checks only what a device can be
 * refused for, refreshes the set's items inline (persisting them as the
 * owner's refresh would), simulates without any owner draft, and stores a
 * plan only for a set that needs no person; otherwise it stores nothing.
 */
function prepareDevicePlan(ctx: CardSyncContext, deviceId: string, input: { setId: string; expectedGeneration?: string }):
  CardSyncPlanView | CardSyncOwnerReview {
  const { db, now } = ctx;
  const set = readSet(db, input.setId);
  if (!set || set.origin !== 'extension' || set.device_id !== deviceId) throw cardSyncRefusal('not-found');
  if (now >= set.expires_at) throw cardSyncRefusal('observation-expired');
  if (!isOpenSet(set)) throw cardSyncRefusal('set-closed');
  const generation = generationOf(input.expectedGeneration);
  const source = currentSourceAuthorization(db, now, {
    binding: readBinding(db, set.binding_id!)!, contractVersion: set.contract_version!, expectedGeneration: generation,
    device: { id: deviceId, bindingVersion: set.binding_version! },
  });
  if (!rehydrateCardSyncPayload(db, set.id).ok) throw cardSyncRefusal('observation-integrity');
  const current = refreshSet(ctx, set).set;
  const principal = { kind: 'device' as const, id: deviceId };
  // Classification first: whenever a person is needed the device gets `owner-review` and nothing is stored, before any
  // plan body or digest exists (review findings r1, 1; the inline refresh above stays, as the owner's would).
  const { view, actions } = planActions(ctx, current, principal);
  const reviewCount = db.prepare(`SELECT count(*) FROM card_reconciliation_suggestions
    WHERE observation_set_id = ? AND status IN ('open', 'decided')`).pluck().get(set.id) as number;
  const run = runRow(db, set.run_id!)!;
  const consented = run.run_trigger !== 'auto' || consentIsCurrent(source, ctx.guardRevision);
  if (current.state !== 'accepted-uncommitted' || reviewCount > 0 || !deviceMayCommit(actions) || !consented) {
    const counts = planCounts(actions.filter((action) => action.op !== 'review'));
    return { status: 'owner-review', observationSetId: set.id, counts, reviewCount };
  }
  const held = db.prepare(`SELECT count(*) FROM card_sync_commit_plans
    WHERE device_id = ? AND status = 'prepared' AND expires_at > ? AND observation_set_id <> ?`).pluck().get(deviceId, now, set.id) as number;
  if (held >= CARD_SYNC_PLANS_PER_DEVICE) throw cardSyncRefusal('plan-quota-exceeded');
  return storePlan(ctx, current, sealPlan(ctx, current, principal, { source, generation, autoEligible: true, sourceReviewed: false },
    view, actions));
}

/**
 * Owner prepare (§5.6): every precondition of an executable plan, every
 * necessary decision included. File sets need a session only;
 * extension sets the current-source authorization without a device.
 */
function prepareOwnerPlan(ctx: CardSyncContext, actorRef: string, input: {
  setId: string; expectedVersion?: number; sourceReviewed?: boolean; expectedGeneration?: string;
}): CardSyncPlanView {
  const { db, now } = ctx;
  const set = requireSet(db, input.setId);
  if (set.version !== input.expectedVersion) throw cardSyncRefusal('version-conflict');
  if (set.state === 'rejected') throw cardSyncRefusal('set-closed');
  if (now >= set.expires_at || set.state === 'expired-unreviewed') throw cardSyncRefusal('observation-expired');
  const sourceReviewed = input.sourceReviewed === true;
  let source: AuthorizedSource | null = null;
  let generation: string | null = null;
  if (set.origin === 'extension') {
    generation = generationOf(input.expectedGeneration);
    source = currentSourceAuthorization(db, now, {
      binding: readBinding(db, set.binding_id!)!, contractVersion: set.contract_version!, expectedGeneration: generation, sourceReviewed,
      setBindingVersion: set.binding_version!,
    });
    if ((set.state === 'blocked-review' || set.state === 'recovery-review') && !sourceReviewed) {
      throw cardSyncRefusal('source-review-required');
    }
    if (!rehydrateCardSyncPayload(db, set.id).ok) throw cardSyncRefusal('observation-integrity');
  }
  if (isOpenSet(set) && set.review_ledger_revision !== ledgerRevisionOf(db, set.card_account_id)) throw cardSyncRefusal('review-stale');
  const planned = planSet(ctx, set, { kind: 'session', id: actorRef }, { source, generation, autoEligible: false, sourceReviewed });
  return storePlan(ctx, set, planned);
}

export function prepareCardSyncPlan(ctx: CardSyncContext, input: {
  principal: CardSyncPrincipal; setId: string; expectedVersion?: number; sourceReviewed?: boolean; expectedGeneration?: string;
}): CardSyncPlanView | CardSyncOwnerReview {
  const principal = planPrincipal(input?.principal);
  return principal.kind === 'device' ? prepareDevicePlan(ctx, principal.id, input) : prepareOwnerPlan(ctx, principal.id, input);
}

function commitResult(plan: PlanRow, replayed: boolean): CardSyncCommitResult {
  if (plan.status !== 'consumed' || plan.closed_at === null) throw cardSyncRefusal('observation-integrity');
  return {
    status: 'committed', previewId: plan.id, planKind: plan.plan_kind, observationSetId: plan.observation_set_id,
    planDigest: plan.plan_digest, payloadDigest: plan.payload_digest, counts: countsOf(plan), setVersion: plan.set_version + 1,
    committedAt: plan.closed_at, replayed,
  };
}

/**
 * Commit (§4.10.3): the principal that prepared the plan, the plan still
 * prepared and unexpired, both digests equal, the set inside its deadline,
 * the current-source authorization (extension sets), every pin unchanged,
 * and the recomputed body's digest equal to the stored one; then the plan
 * is applied whole and consumed. A consumed plan answers its stored result
 * (`replayed`) for the same digests.
 */
export function commitCardSyncPlan(ctx: CardSyncContext, input: {
  principal: CardSyncPrincipal; previewId: string; payloadDigest: string | null; planDigest: string; expectedGeneration?: string;
}): CardSyncCommitResult {
  const { db, now } = ctx;
  const principal = planPrincipal(input?.principal);
  const plan = readPlan(db, input.previewId);
  if (!plan || plan.principal_kind !== principal.kind || (principal.kind === 'device' ? plan.device_id : plan.actor_ref) !== principal.id) {
    throw cardSyncRefusal('plan-not-found');
  }
  const sameDigests = input.planDigest === plan.plan_digest && input.payloadDigest === plan.payload_digest;
  if (plan.status === 'consumed') {
    if (!sameDigests) throw cardSyncRefusal('plan-mismatch');
    return commitResult(plan, true);
  }
  if (plan.status === 'cancelled') throw cardSyncRefusal('plan-cancelled');
  if (plan.status === 'expired' || now >= plan.expires_at) throw cardSyncRefusal('plan-expired');
  if (!sameDigests) throw cardSyncRefusal('plan-mismatch');
  const set = readSet(db, plan.observation_set_id)!;
  if (now >= set.expires_at) throw cardSyncRefusal('observation-expired');
  let source: AuthorizedSource | null = null;
  let generation: string | null = null;
  if (set.origin === 'extension') {
    generation = generationOf(input.expectedGeneration);
    source = currentSourceAuthorization(db, now, {
      binding: readBinding(db, set.binding_id!)!, contractVersion: set.contract_version!, expectedGeneration: generation,
      ...(principal.kind === 'device'
        ? { device: { id: principal.id, bindingVersion: set.binding_version! } }
        : { sourceReviewed: plan.source_reviewed === 1, setBindingVersion: set.binding_version! }),
    });
  }
  if (principal.kind === 'device' && plan.auto_eligible !== 1) throw cardSyncRefusal('plan-needs-review');
  const pinned = headerOf(plan);
  const pinsChanged = set.version !== plan.set_version || ledgerRevisionOf(db, set.card_account_id) !== plan.ledger_revision
    || ctx.guardRevision !== plan.guard_revision || (plan.plan_kind === 'set' ? !isOpenSet(set) : set.state !== 'committed')
    || (source !== null && (source.policyRevision !== plan.policy_revision || source.issuerRevision !== plan.issuer_policy_revision
      || source.binding.version !== plan.binding_version || generation !== plan.authorization_generation));
  if (pinsChanged) throw cardSyncRefusal('preview-stale');
  // §5.4: commit checks the payload's integrity as prepare did, before it commits anything of it (slice 2 review r2,
  // finding 1; the sealed form of the check, sets.ts). A consumed plan's replay above needs no payload.
  if (set.origin === 'extension' && !cardSyncPayloadSealed(db, set)) throw cardSyncRefusal('observation-integrity');
  const recomputed = planSet(ctx, set, pinned.principal, {
    source, generation, autoEligible: pinned.autoEligible, sourceReviewed: pinned.sourceReviewed,
  });
  if (recomputed.digest !== plan.plan_digest) throw cardSyncRefusal('preview-stale');
  const actor: LedgerActor = principal.kind === 'device' ? { kind: 'device', ref: principal.id } : { kind: 'session', ref: principal.id };
  const applied = applyPlan(ctx, { set, plan: { id: plan.id, digest: plan.plan_digest, kind: plan.plan_kind }, actor,
    actions: recomputed.actions });
  const delta: Record<string, number> = { open: 0, inserted: 0, updated: 0, matched: 0, attributed: 0, unchanged: 0, rejected: 0 };
  for (const t of applied.transitions) {
    delta[t.from] -= 1;
    delta[t.to] += 1;
  }
  const counts = `open_count = open_count + ${delta.open}, inserted_count = inserted_count + ${delta.inserted},
      updated_count = updated_count + ${delta.updated}, matched_count = matched_count + ${delta.matched},
      attributed_count = attributed_count + ${delta.attributed}, unchanged_count = unchanged_count + ${delta.unchanged},
      rejected_count = rejected_count + ${delta.rejected}`;
  if (plan.plan_kind === 'set') {
    db.prepare(`UPDATE card_sync_observation_sets SET state = 'committed', version = version + 1, ${counts}, closed_at = ?,
        close_reason = 'committed', closed_by_ref = ? WHERE id = ? AND version = ?`)
      .run(now, principal.kind === 'session' ? principal.id : null, set.id, set.version);
  } else {
    db.prepare(`UPDATE card_sync_observation_sets SET version = version + 1, ${counts} WHERE id = ? AND version = ?`).run(set.id, set.version);
  }
  db.prepare(`UPDATE card_coverage_windows SET ledger_state = 'committed', updated_at = ?
    WHERE observation_set_id = ? AND ledger_state = 'observed-uncommitted'`).run(now, set.id);
  db.prepare(`UPDATE card_sync_commit_plans SET status = 'consumed', closed_at = ? WHERE id = ? AND status = 'prepared'`).run(now, plan.id);
  audit(ctx, 'plan-committed', principal.kind === 'device' ? { kind: 'device', ref: principal.id } : { kind: 'session', ref: principal.id }, {
    cardAccountId: set.card_account_id, bindingId: set.binding_id, deviceId: set.device_id, runId: set.run_id, observationSetId: set.id,
    planId: plan.id, rowCount: recomputed.actions.length, versionBefore: set.version, versionAfter: set.version + 1, generation,
  });
  return commitResult(readPlan(db, plan.id)!, false);
}

/**
 * One page of a plan's effects (§5.6, Revision 6): the actions other than
 * `unchanged`, by ordinal, at most 500; every page echoes the plan's digest,
 * status and expiry. Only the principal that prepared the plan reads it.
 */
export function getCardSyncPlanEffectsPage(ctx: CardSyncContext, input: {
  principal: CardSyncPrincipal; previewId: string; afterOrdinal: number; limit: number;
}): { previewId: string; planDigest: string; status: string; expiresAt: string; effectCount: number; effects: CardSyncPlanEffect[];
  nextAfterOrdinal: number | null } | null {
  const principal = planPrincipal(input?.principal);
  if (!Number.isInteger(input.afterOrdinal) || input.afterOrdinal < -1 || !Number.isInteger(input.limit) || input.limit < 1
    || input.limit > EFFECTS_PAGE) {
    throw cardSyncRefusal('invalid-request');
  }
  const plan = readPlan(ctx.db, input.previewId);
  if (!plan || plan.principal_kind !== principal.kind || (principal.kind === 'device' ? plan.device_id : plan.actor_ref) !== principal.id) {
    return null;
  }
  const rows = ctx.statements.all('plan-effects-page', { plan_id: plan.id, after_ordinal: input.afterOrdinal, limit: input.limit + 1 });
  const page = rows.slice(0, input.limit);
  const status = plan.status === 'prepared' && ctx.now >= plan.expires_at ? 'expired' : plan.status;
  return {
    previewId: plan.id, planDigest: plan.plan_digest, status, expiresAt: plan.expires_at,
    effectCount: plan.action_count - plan.count_unchanged,
    effects: page.map((a) => effectOf({
      ordinal: a.ordinal, op: a.op, observation: a.observation_ordinal, item: a.review_item_id, transaction: a.transaction_id,
      newRef: a.new_ref, related: a.related_transaction_id, scope: a.scope_id, promote: a.promote === 1, restore: a.restore === 1,
      identities: a.identity_count, reverses: a.reverses_event_id, expectedRevision: a.expected_revision,
    })),
    nextAfterOrdinal: rows.length > input.limit ? page[page.length - 1].ordinal : null,
  };
}

/** The reversibility check a changed decision on a committed set needs when it is recorded (§4.9.2). */
export function requireReversible(ctx: CardSyncContext) {
  return (_set: SetRow, item: ItemRow, decision: { action: ItemRow['committed_action'] }): void => {
    checkAdjustment(ctx, item, decision.action!);
  };
}
