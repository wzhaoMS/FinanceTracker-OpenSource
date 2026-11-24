import { cardSyncPlanDigest, type JsonObject } from '@finance-tracker/shared';

import type { PlannedAction } from './simulate.js';

/**
 * The plan body (`holdr.card-sync-plan` v2, E1b design §4.8): canonical JSON
 * of the plan's header and actions, digested with `cardSyncPlanDigest`
 * (`pl1:`). It holds no financial values (ids, enums, revisions, digests and
 * counts), and it is assembled field for field from what the plan and action
 * rows store, so a stored plan can be checked against storage and commit's
 * recomputation must reproduce it exactly.
 */

export interface PlanHeader {
  planKind: 'set' | 'adjustment';
  cardAccountId: string;
  observationSetId: string;
  setVersion: number;
  principal: { kind: 'session' | 'device'; id: string };
  bindingId: string | null;
  bindingVersion: number | null;
  contractVersion: number | null;
  payloadDigest: string | null;
  ledgerRevision: number;
  policyRevision: number | null;
  issuerPolicyRevision: number | null;
  guardRevision: number;
  authorizationGeneration: string | null;
  autoEligible: boolean;
  sourceReviewed: boolean;
}

/** The owner API's `PlanCounts` (§4.8). */
export interface PlanCounts {
  insert: number;
  update: number;
  unchanged: number;
  aliased: number;
  matched: number;
  attributed: number;
  promoted: number;
  corrected: number;
  rejected: number;
  unmatched: number;
  superseded: number;
}

/** One action as the body and the action row hold it. */
export interface PlanBodyAction {
  ordinal: number;
  op: string;
  observation: number | null;
  item: string | null;
  content: string | null;
  transaction: string | null;
  expectedRevision: number | null;
  newRef: number | null;
  related: string | null;
  relatedRevision: number | null;
  scope: string | null;
  promote: boolean;
  restore: boolean;
  identities: number;
  reverses: string | null;
}

export const bodyAction = (action: PlannedAction): PlanBodyAction => {
  if (action.op === 'review') throw new Error('card ledger: a plan never holds a review');
  return {
    ordinal: action.ordinal, op: action.op, observation: action.observation, item: action.item, content: action.content,
    transaction: action.transaction, expectedRevision: action.expectedRevision, newRef: action.newRef, related: action.related,
    relatedRevision: action.relatedRevision, scope: action.scope, promote: action.promote, restore: action.restore,
    identities: action.identities, reverses: action.reverses,
  };
};

/** §4.8's counts over the planned actions. */
export function planCounts(actions: readonly PlannedAction[]): PlanCounts {
  const counts: PlanCounts = {
    insert: 0, update: 0, unchanged: 0, aliased: 0, matched: 0, attributed: 0, promoted: 0, corrected: 0, rejected: 0, unmatched: 0,
    superseded: 0,
  };
  for (const action of actions) {
    switch (action.op) {
      case 'insert': counts.insert += 1; if (action.attributedFrom !== null) counts.attributed += 1; break;
      case 'unchanged': counts.unchanged += 1; break;
      case 'alias': counts.aliased += 1; break;
      case 'promote': counts.promoted += 1; counts.update += 1; break;
      case 'correct': counts.corrected += 1; counts.update += 1; break;
      case 'revert': counts.update += 1; break;
      case 'match':
        counts.matched += 1;
        if (action.scope !== null) counts.attributed += 1;
        if (action.promote) { counts.promoted += 1; counts.update += 1; }
        break;
      case 'reject': case 'remove': counts.rejected += 1; break;
      case 'unmatch': counts.unmatched += 1; break;
      case 'supersede': counts.superseded += 1; break;
      default: break;
    }
  }
  return counts;
}

/** The canonical body (§4.8). */
export function planBody(header: PlanHeader, actions: readonly PlanBodyAction[], counts: PlanCounts): JsonObject {
  return {
    format: 'holdr.card-sync-plan', version: 2, planKind: header.planKind, cardAccountId: header.cardAccountId,
    observationSetId: header.observationSetId, setVersion: header.setVersion,
    principal: { kind: header.principal.kind, id: header.principal.id }, bindingId: header.bindingId,
    bindingVersion: header.bindingVersion, contractVersion: header.contractVersion, payloadDigest: header.payloadDigest,
    ledgerRevision: header.ledgerRevision, policyRevision: header.policyRevision, issuerPolicyRevision: header.issuerPolicyRevision,
    guardRevision: header.guardRevision, authorizationGeneration: header.authorizationGeneration, autoEligible: header.autoEligible,
    sourceReviewed: header.sourceReviewed,
    actions: actions.map((a) => ({
      ordinal: a.ordinal, op: a.op, observation: a.observation, item: a.item, content: a.content, transaction: a.transaction,
      expectedRevision: a.expectedRevision, newRef: a.newRef, related: a.related, relatedRevision: a.relatedRevision, scope: a.scope,
      promote: a.promote, restore: a.restore, identities: a.identities, reverses: a.reverses,
    })),
    counts: { ...counts },
  };
}

export function planDigest(header: PlanHeader, actions: readonly PlanBodyAction[], counts: PlanCounts): string {
  return cardSyncPlanDigest(planBody(header, actions, counts));
}

interface StoredPlanRow {
  plan_kind: 'set' | 'adjustment'; card_account_id: string; observation_set_id: string; set_version: number;
  principal_kind: 'session' | 'device'; device_id: string | null; actor_ref: string | null; binding_id: string | null;
  binding_version: number | null; contract_version: number | null; payload_digest: string | null; ledger_revision: number;
  policy_revision: number | null; issuer_policy_revision: number | null; guard_revision: number; authorization_generation: string | null;
  auto_eligible: number; source_reviewed: number; count_insert: number; count_update: number; count_unchanged: number;
  count_aliased: number; count_matched: number; count_attributed: number; count_promoted: number; count_corrected: number;
  count_rejected: number; count_unmatched: number; count_superseded: number;
}

interface StoredActionRow {
  ordinal: number; op: string; observation_ordinal: number | null; review_item_id: string | null; content_digest: string | null;
  transaction_id: string | null; expected_revision: number | null; new_ref: number | null; related_transaction_id: string | null;
  related_revision: number | null; scope_id: string | null; promote: number; restore: number; identity_count: number;
  reverses_event_id: string | null;
}

/** The header a stored plan row pins. */
export function headerOf(plan: StoredPlanRow): PlanHeader {
  return {
    planKind: plan.plan_kind, cardAccountId: plan.card_account_id, observationSetId: plan.observation_set_id,
    setVersion: plan.set_version,
    principal: plan.principal_kind === 'device' ? { kind: 'device', id: plan.device_id! } : { kind: 'session', id: plan.actor_ref! },
    bindingId: plan.binding_id, bindingVersion: plan.binding_version, contractVersion: plan.contract_version,
    payloadDigest: plan.payload_digest, ledgerRevision: plan.ledger_revision, policyRevision: plan.policy_revision,
    issuerPolicyRevision: plan.issuer_policy_revision, guardRevision: plan.guard_revision,
    authorizationGeneration: plan.authorization_generation, autoEligible: plan.auto_eligible === 1,
    sourceReviewed: plan.source_reviewed === 1,
  };
}

export const countsOf = (plan: StoredPlanRow): PlanCounts => ({
  insert: plan.count_insert, update: plan.count_update, unchanged: plan.count_unchanged, aliased: plan.count_aliased,
  matched: plan.count_matched, attributed: plan.count_attributed, promoted: plan.count_promoted, corrected: plan.count_corrected,
  rejected: plan.count_rejected, unmatched: plan.count_unmatched, superseded: plan.count_superseded,
});

/** The body as storage holds it: the plan row and its action rows, field for field. */
export function storedPlanBody(plan: StoredPlanRow, actions: readonly StoredActionRow[]): JsonObject {
  return planBody(headerOf(plan), actions.map((a) => ({
    ordinal: a.ordinal, op: a.op, observation: a.observation_ordinal, item: a.review_item_id, content: a.content_digest,
    transaction: a.transaction_id, expectedRevision: a.expected_revision, newRef: a.new_ref, related: a.related_transaction_id,
    relatedRevision: a.related_revision, scope: a.scope_id, promote: a.promote === 1, restore: a.restore === 1,
    identities: a.identity_count, reverses: a.reverses_event_id,
  })), countsOf(plan));
}
