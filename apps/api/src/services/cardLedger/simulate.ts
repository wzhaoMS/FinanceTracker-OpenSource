import { cardSyncRefusal } from '../cardSync/refusals.js';
import {
  classify, deviceCommittable, REVIEW_ACTION_BITS, identityCandidate, plainlyLinkable,
  type Admissions, type Classification, type ContentResolution, type PlanCandidate, type PlanObservation, type ReviewClassification,
  type ReviewDecisionAction,
} from './classify.js';
import { LedgerOverlay, newRowId, type BankValues, type LedgerRow, type LedgerView, type StoredIdentity, type Tuple } from './ledgerView.js';

/**
 * The planner (E1b design §4.7): walks a set's observations in ordinal order
 * over a copy-on-write overlay of the ledger, classifies each against the
 * ledger as the earlier actions of the same plan leave it, applies the
 * owner's decision when one is needed, and applies the resulting action to
 * the overlay before planning the next. Pure apart from the ledger reads the
 * view makes inside the caller's transaction; acceptance, refresh, device and
 * owner prepare, and commit's recomputation all call it.
 */

export type PlanOp = 'insert' | 'unchanged' | 'alias' | 'promote' | 'correct' | 'match' | 'reject' | 'accept-difference'
  | 'unmatch' | 'restore-attribution' | 'revert' | 'supersede' | 'remove';

export interface PlanDecision {
  action: ReviewDecisionAction;
  transactionId: string | null;
  scopeId: string | null;
}

export interface StatementDifference {
  field: 'charges' | 'credits' | 'net' | 'new-balance';
  expectedMinor: number;
  actualMinor: number;
}

export type ObservationOutcome = 'inserted' | 'updated' | 'matched' | 'attributed' | 'unchanged' | 'rejected';

/** One planned action: the stored action row's fields (§2.16, §4.8) and what the writer needs to carry it out. */
export interface PlannedAction {
  ordinal: number;
  op: PlanOp | 'review';
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
  // ---- not part of the body
  source: PlanObservation | null;
  decision: PlanDecision | null;
  outcome: ObservationOutcome | null;
  /** How content is remembered for the observation's identities on the resolved row; null records nothing. */
  resolution: ContentResolution | null;
  /** Tuples given a new identity on the row. */
  attach: Tuple[];
  /** Detached identities re-activated onto the row. */
  reactivate: StoredIdentity[];
  /** The observation's identities already on the row (their `last_seen_*` moves). */
  onRow: StoredIdentity[];
  /** The row's values after the action (insert, promote, correct, compound match). */
  values: BankValues | null;
  /** The row's reversal marker after the action. */
  marker: number | null;
  /** The scope a chosen scope replaces (an `attributed` event), or null. */
  attributedFrom: string | null;
  /** Why a promotion happened: issuer-driven, or the owner's `same-transaction`. */
  promoteReason: 'pending-posted' | 'same-transaction' | null;
  /** The row's revision before (stored rows) and after the action; what the item's `committed_revision` records. */
  before: LedgerRow | null;
  after: LedgerRow | null;
  /** The review a person must decide (only from a simulation without decisions). */
  review: ReviewClassification | null;
  statement: StatementDifference | null;
  deviceCommittable: boolean;
}

export interface SimulationInput {
  /** `classify`: no decisions, review answers kept (acceptance, refresh, device prepare); `set`: the owner's decisions applied. */
  mode: 'classify' | 'set';
  observations: readonly PlanObservation[];
  /** Item id → the owner's draft (set mode). */
  decisions: ReadonlyMap<string, PlanDecision>;
  /** Per observation ordinal, the rows another observation of the same set reaches by identity. */
  excluded: { forObservation(ordinal: number): { has(rowId: string): boolean } };
  knownScopes: ReadonlySet<string>;
  /** An extension set's statement mismatch and its set-level item. */
  statement: { itemId: string | null; difference: StatementDifference } | null;
}

export interface Simulation {
  actions: PlannedAction[];
  overlay: LedgerOverlay;
}

const blank = (ordinal: number, source: PlanObservation | null): PlannedAction => ({
  ordinal, op: 'reject', observation: source?.ordinal ?? null, item: source?.itemId ?? null, content: source?.content ?? null,
  transaction: null, expectedRevision: null, newRef: null, related: null, relatedRevision: null, scope: null, promote: false,
  restore: false, identities: 0, reverses: null, source, decision: null, outcome: null, resolution: null, attach: [], reactivate: [],
  onRow: [], values: null, marker: null, attributedFrom: null, promoteReason: null, before: null, after: null, review: null,
  statement: null, deviceCommittable: false,
});

const notAllowed = () => cardSyncRefusal('action-not-allowed');

/** The values a row takes from an observation, its status kept or restored (a correction never changes status, §4.6). */
const valuesWithStatus = (values: BankValues, status: 'pending' | 'posted'): BankValues => ({ ...values, status });

/** What the observation's identities on `rowId` are once the action attached its tuples. */
const identitiesOnRow = (hits: readonly StoredIdentity[], rowId: string) => hits.filter((identity) => identity.canonicalId === rowId);

function liveStatusOf(row: LedgerRow): 'pending' | 'posted' {
  if (row.status !== 'removed') return row.status;
  return row.removedFromStatus ?? 'posted';
}

/** The action a classification answers with when no person is involved. */
function automaticAction(ordinal: number, observation: PlanObservation, cls: Exclude<Classification, ReviewClassification>,
  admissions: Admissions): PlannedAction {
  const action = blank(ordinal, observation);
  action.item = null;
  action.deviceCommittable = deviceCommittable(cls, observation, admissions);
  if (cls.kind === 'insert') {
    action.op = 'insert';
    action.scope = observation.scopeId;
    action.attach = cls.fresh;
    action.reactivate = cls.detached;
    action.identities = cls.fresh.length + cls.detached.length;
    action.values = observation.values;
    action.resolution = 'inserted';
    action.outcome = 'inserted';
    return action;
  }
  action.transaction = cls.row.id;
  action.expectedRevision = cls.row.revision;
  action.before = cls.row;
  action.onRow = identitiesOnRow(cls.hits, cls.row.id);
  action.attach = cls.fresh;
  if (cls.kind === 'promote') {
    action.op = 'promote';
    action.promote = true;
    action.values = valuesWithStatus(observation.values, 'posted');
    action.marker = null;                                  // issuer-driven: not reversible (§4.6)
    action.promoteReason = 'pending-posted';
    action.identities = cls.fresh.length;
    action.resolution = 'promoted';
    action.outcome = 'updated';
    return action;
  }
  action.op = cls.fresh.length > 0 ? 'alias' : 'unchanged';
  action.identities = cls.fresh.length;
  // A legacy-removed hit is v14's duplicate and records nothing; known content teaches the row's other ids (§4.3).
  action.resolution = cls.resolution ?? (cls.row.removedReason === 'legacy' ? null : 'linked');
  action.outcome = 'unchanged';
  return action;
}

/** A review the planner keeps as review (no decisions), or that has to wait for one. */
function reviewAction(ordinal: number, observation: PlanObservation, cls: ReviewClassification): PlannedAction {
  const action = blank(ordinal, observation);
  action.op = 'review';
  action.review = cls;
  action.before = cls.row;
  return action;
}

/** `rows[0]` reached a row an earlier action of this plan already acts on: one action per row (§4.7). */
function conflictReview(observation: PlanObservation, taken: LedgerRow | undefined, cls: Classification): ReviewClassification {
  const candidates: PlanCandidate[] = taken && taken.newRef === undefined ? [identityCandidate(taken, observation)] : [];
  const hits = cls.kind === 'insert' ? [] : cls.hits;
  return {
    kind: 'review', reason: 'identity-conflict', category: 'cross-source-similar',
    allowed: REVIEW_ACTION_BITS['reject-row'] | (candidates.length > 0 ? REVIEW_ACTION_BITS['same-transaction'] : 0), candidates,
    row: null, hits, detached: cls.kind === 'review' || cls.kind === 'insert' ? cls.detached : [], fresh: cls.fresh,
  };
}

/** §4.6: the owner's decision on a review, as one action; refuses what the item does not allow. */
function decidedAction(ordinal: number, observation: PlanObservation, cls: ReviewClassification, decision: PlanDecision,
  overlay: LedgerOverlay, knownScopes: ReadonlySet<string>): PlannedAction {
  if ((REVIEW_ACTION_BITS[decision.action] & cls.allowed) === 0) throw notAllowed();
  const targeted = decision.action === 'same-transaction' || decision.action === 'attribute-and-link';
  if (targeted !== (decision.transactionId !== null)) throw notAllowed();
  const scoped = decision.action === 'attribute' || decision.action === 'attribute-and-link';
  if (!scoped && decision.scopeId !== null) throw notAllowed();
  const action = blank(ordinal, observation);
  action.decision = decision;
  switch (decision.action) {
    case 'reject-row':
      action.op = 'reject';
      action.outcome = 'rejected';
      return action;
    case 'keep-current':
    case 'accept-correction': {
      const row = cls.row;
      if (!row) throw notAllowed();
      action.transaction = row.id;
      action.expectedRevision = row.revision;
      action.before = row;
      action.onRow = identitiesOnRow(cls.hits, row.id);
      if (decision.action === 'keep-current') {
        action.op = 'unchanged';
        // Never remembered for a removed row: the next import or capture asks again (§4.3).
        action.resolution = row.status === 'removed' ? null : 'kept-current';
        action.outcome = 'unchanged';
        return action;
      }
      action.op = 'correct';
      action.restore = row.status === 'removed';
      action.values = valuesWithStatus(observation.values, liveStatusOf(row));
      action.marker = row.revision;                        // owner-decided and live: reversible (§4.6)
      action.resolution = 'corrected';
      action.outcome = 'updated';
      return action;
    }
    case 'insert-new':
    case 'attribute': {
      let scope = observation.scopeId;
      if (decision.action === 'attribute') {
        if (decision.scopeId === null || !knownScopes.has(decision.scopeId) || observation.scopeKind === 'known') throw notAllowed();
        scope = decision.scopeId;
        action.attributedFrom = observation.scopeId;
      }
      action.op = 'insert';
      action.scope = scope;
      action.attach = cls.fresh;
      action.reactivate = cls.detached;
      action.identities = cls.fresh.length + cls.detached.length;
      if (action.identities === 0) throw notAllowed();     // every tuple already names a row: nothing a new row could own
      action.values = observation.values;
      action.resolution = 'inserted';
      action.outcome = decision.action === 'attribute' ? 'attributed' : 'inserted';
      return action;
    }
    case 'same-transaction':
    case 'attribute-and-link': {
      const candidate = cls.candidates.find((c) => c.transactionId === decision.transactionId && c.blocked === null);
      if (!candidate) throw notAllowed();
      const target = overlay.row(candidate.transactionId);
      if (!target) throw notAllowed();
      action.transaction = target.id;
      action.expectedRevision = target.revision;
      action.before = target;
      action.onRow = identitiesOnRow(cls.hits, target.id);
      action.attach = cls.fresh;
      action.reactivate = cls.detached;
      if (decision.action === 'same-transaction' && (cls.reason === 'pending-posted' || cls.reason === 'removed-hit')) {
        // The identity hit itself: a promotion on the owner's word (restored first when removed), reversible.
        action.op = 'promote';
        action.promote = true;
        action.restore = target.status === 'removed';
        action.values = valuesWithStatus(observation.values, 'posted');
        action.marker = target.revision;
        action.promoteReason = 'same-transaction';
        action.identities = cls.fresh.length;
        action.resolution = 'promoted';
        action.outcome = 'updated';
        return action;
      }
      // §4.4 row 5 (S10): a known observation joins an unresolved row only with that row's attribution.
      if (decision.action === 'same-transaction' && !plainlyLinkable({ blocked: null, scopeKind: target.scopeKind }, observation)) {
        throw notAllowed();
      }
      action.op = 'match';
      action.identities = action.onRow.length + cls.fresh.length + cls.detached.length;
      if (action.identities === 0 || action.identities > 4) throw notAllowed();
      const compound = observation.values.status === 'posted'
        && (target.status === 'pending' || (target.status === 'removed' && target.removedFromStatus === 'pending'));
      if (compound) {
        action.promote = true;
        action.restore = target.status === 'removed';
        action.values = valuesWithStatus(observation.values, 'posted');
        action.promoteReason = 'same-transaction';
      }
      if (decision.action === 'attribute-and-link') {
        const scope = observation.scopeKind === 'known' ? observation.scopeId : decision.scopeId;
        if (scope === null || (observation.scopeKind === 'known' && decision.scopeId !== null && decision.scopeId !== scope)) {
          throw notAllowed();
        }
        if (!knownScopes.has(scope) || target.cardScopeId === scope || target.scopeKind === 'known') {
          throw cardSyncRefusal(target.scopeKind === 'known' && target.cardScopeId !== scope ? 'cross-card-link-refused' : 'action-not-allowed');
        }
        action.scope = scope;
        action.attributedFrom = target.cardScopeId;
      }
      // A match that writes the row (values or scope) is owner-decided and live: reversible (§4.6).
      action.marker = compound || action.scope !== null ? target.revision : target.marker;
      action.resolution = 'linked';
      action.outcome = action.scope !== null ? 'attributed' : 'matched';
      return action;
    }
    default:
      throw notAllowed();
  }
}

/** The rows an action writes or attaches to (its claim on them, §4.7). */
function touched(action: PlannedAction): string[] {
  switch (action.op) {
    case 'insert': return [newRowId(action.ordinal)];
    case 'review': case 'reject': case 'accept-difference': return [];
    default: return action.transaction === null ? [] : [action.transaction, ...(action.related ? [action.related] : [])];
  }
}

/** Applies an action to the overlay: rows, identities and contents as the writer will leave them. */
export function applyToOverlay(overlay: LedgerOverlay, action: PlannedAction, accountScopeKind: (scopeId: string) => LedgerRow['scopeKind']):
  void {
  const observation = action.source;
  if (action.op === 'insert' && observation && action.values && action.scope) {
    const id = newRowId(action.ordinal);
    const row: LedgerRow = {
      id, status: action.values.status, transactionDate: action.values.transactionDate, postedDate: action.values.postedDate,
      amountMinor: action.values.amountMinor, originalAmountMinor: action.values.originalAmountMinor,
      originalCurrency: action.values.originalCurrency, kind: action.values.kind, description: action.values.description,
      merchant: action.values.merchant, issuerCategory: action.values.issuerCategory, currency: overlay.view.currency,
      cardScopeId: action.scope, scopeKind: accountScopeKind(action.scope), revision: 1, marker: null, removedReason: null,
      removedFromStatus: null, extensionCreated: observation.origin === 'extension', newRef: action.ordinal,
    };
    overlay.setRow(row);
    action.after = row;
    attachAll(overlay, action, id);
    return;
  }
  if (action.transaction === null || !observation) return;
  const before = overlay.row(action.transaction);
  if (!before) return;
  let after = before;
  if (action.values || action.scope !== null && action.op === 'match') {
    after = { ...before, revision: before.revision + 1, marker: action.marker };
    if (action.values) {
      Object.assign(after, {
        status: action.values.status, transactionDate: action.values.transactionDate, postedDate: action.values.postedDate,
        amountMinor: action.values.amountMinor, originalAmountMinor: action.values.originalAmountMinor,
        originalCurrency: action.values.originalCurrency, kind: action.values.kind, description: action.values.description,
        merchant: action.values.merchant, issuerCategory: action.values.issuerCategory, removedReason: null, removedFromStatus: null,
      });
    }
    if (action.scope !== null) Object.assign(after, { cardScopeId: action.scope, scopeKind: accountScopeKind(action.scope) });
    overlay.setRow(after);
  }
  action.after = after;
  if (action.op !== 'reject') attachAll(overlay, action, before.id);
}

function attachAll(overlay: LedgerOverlay, action: PlannedAction, rowId: string): void {
  const observation = action.source!;
  const attached: StoredIdentity[] = [...action.onRow];
  action.attach.forEach((tuple, index) => {
    const identity: StoredIdentity = {
      id: `new:${action.ordinal}:${index}`, status: 'active', canonicalId: rowId, firstSeenStatus: observation.values.status,
      namespace: tuple.namespace, scopeId: tuple.scopeId, idHash: tuple.idHash,
    };
    overlay.setIdentity(identity);
    attached.push(identity);
  });
  for (const identity of action.reactivate) {
    const moved: StoredIdentity = { ...identity, status: 'active', canonicalId: rowId };
    overlay.setIdentity(moved);
    attached.push(moved);
  }
  if (action.resolution !== null) {
    for (const identity of attached) overlay.remember(identity.id, observation.content);
  }
}

/**
 * §4.7's loop. In `classify` mode a review stays a review action; in `set`
 * mode every review needs the owner's decision (`decisions-incomplete`), and
 * a decision that reaches a row another action of the plan already holds is
 * `decision-conflict`. The statement acknowledgement comes last.
 */
export function simulate(input: SimulationInput, view: LedgerView, admissions: Admissions,
  accountScopeKind: (scopeId: string) => LedgerRow['scopeKind']): Simulation {
  const overlay = new LedgerOverlay(view);
  const claimed = new Map<string, number>();
  const actions: PlannedAction[] = [];
  for (const observation of input.observations) {
    const ordinal = actions.length;
    const cls = classify(observation, {
      overlay, admissions, excluded: input.excluded.forObservation(observation.ordinal), knownScopes: input.knownScopes,
    });
    let review: ReviewClassification | null = cls.kind === 'review' ? cls : null;
    let action: PlannedAction | null = null;
    if (cls.kind !== 'review') {
      const automatic = automaticAction(ordinal, observation, cls, admissions);
      const taken = touched(automatic).find((row) => claimed.has(row));
      if (taken === undefined) action = automatic;
      else review = conflictReview(observation, overlay.row(taken), cls);
    }
    if (review) {
      if (input.mode === 'classify') {
        action = reviewAction(ordinal, observation, review);
      } else {
        const decision = observation.itemId === null ? undefined : input.decisions.get(observation.itemId);
        if (!decision) throw cardSyncRefusal('decisions-incomplete');
        action = decidedAction(ordinal, observation, review, decision, overlay, input.knownScopes);
        if (touched(action).some((row) => claimed.has(row))) throw cardSyncRefusal('decision-conflict');
      }
    }
    applyToOverlay(overlay, action!, accountScopeKind);
    for (const row of touched(action!)) claimed.set(row, ordinal);
    actions.push(action!);
  }
  if (input.statement) {
    const action = blank(actions.length, null);
    action.item = input.statement.itemId;
    action.statement = input.statement.difference;
    action.content = null;
    if (input.mode === 'classify') {
      action.op = 'review';
      action.review = {
        kind: 'review', reason: 'statement-mismatch', category: 'reconciliation-difference', allowed: REVIEW_ACTION_BITS['accept-difference'],
        candidates: [], row: null, hits: [], detached: [], fresh: [],
      };
    } else {
      const decision = input.statement.itemId === null ? undefined : input.decisions.get(input.statement.itemId);
      if (!decision) throw cardSyncRefusal('decisions-incomplete');
      if (decision.action !== 'accept-difference' || decision.transactionId !== null || decision.scopeId !== null) throw notAllowed();
      action.op = 'accept-difference';
      action.decision = decision;
    }
    actions.push(action);
  }
  return { actions, overlay };
}

/** Whether a device may commit the whole simulation (§4.4, W7): no review, every action device-committable. */
export function deviceMayCommit(actions: readonly PlannedAction[]): boolean {
  return actions.every((action) => action.op !== 'review' && action.deviceCommittable);
}
