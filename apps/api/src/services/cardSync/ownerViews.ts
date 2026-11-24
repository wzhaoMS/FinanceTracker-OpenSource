import type { Database as DB } from 'better-sqlite3';

import { MATCHED_ON } from '../cardLedger/classify.js';
import type { PlanCounts } from '../cardLedger/planBody.js';
import { cachedStatement } from './bulk.js';
import type { CardSyncContext } from './context.js';
import { ledgerRow, type CardLedgerRowView, type CardTransactionSources } from './ledger.js';
import { cardSyncRefusal } from './refusals.js';
import type { CardSyncReviewItemView, CardSyncSetPage } from './review.js';
import type { CardSyncRunView } from './runs.js';
import { isOpenSet, type CardSyncSetState, type SetRow } from './sets.js';

/**
 * The owner API's shapes (the E8-M owner API, E1b design §5.5–§5.7.1,
 * §9 X18–X42, §10 items 10, 17–21, 24): what the routes under
 * `/card-sync/owner` answer, built from the repository's own reads inside
 * the caller's one transaction, so an answer always agrees with the pins
 * and digests it carries. Keys are the client's exactly (`sourceKind`,
 * never `origin`; `cardAccountRef` for the card account). Nothing here
 * writes, and nothing here decides: the classifications, actions and
 * refusals are the repository's.
 */

/** The owner API's review categories, in the order its summaries list them. */
const REVIEW_CATEGORIES = [
  'cross-source-similar', 'no-stable-id', 'scope-unknown', 'pending-link', 'posted-correction', 'reconciliation-difference',
] as const;

export type OwnerMatchedOn = 'date' | 'amount' | 'merchant' | 'description' | 'posted-id';
const MATCHED_ON_NAMES: ReadonlyArray<readonly [number, OwnerMatchedOn]> = [
  [MATCHED_ON.date, 'date'], [MATCHED_ON.amount, 'amount'], [MATCHED_ON.merchant, 'merchant'],
  [MATCHED_ON.description, 'description'], [MATCHED_ON.postedId, 'posted-id'],
];

export type OwnerPlanState = 'valid' | 'expired' | 'superseded' | 'committed';

export interface OwnerPlanRef {
  previewId: string;
  createdAt: string;
  expiresAt: string;
  state: OwnerPlanState;
}

export interface OwnerSetSummary {
  observationSetId: string;
  sourceKind: 'extension' | 'file';
  runId: string | null;
  bindingId: string | null;
  deviceId: string | null;
  importBatchId: string | null;
  cardAccountRef: string;
  version: number;
  state: CardSyncSetState;
  acceptedAt: string;
  expiresAt: string;
  rowCount: number;
  byteCount: number;
  reviewCount: number;
  categories: Array<{ category: string; count: number }>;
  plan: OwnerPlanRef | null;
  committedAt: string | null;
  closedAt: string | null;
  closeReason: 'committed' | 'discarded' | 'expired' | null;
}

export interface OwnerDateRange { start: string; end: string; dateBasis: string }

export interface OwnerCoverageEntry {
  cardScopeId: string;
  status: 'pending' | 'posted';
  requested: OwnerDateRange | null;
  observed: OwnerDateRange | null;
  completeness: string;
  termination: string;
  pageCount: number;
  observedAt: string;
}

export interface OwnerRowView {
  rowIndex: number;
  transactionDate: string;
  postedDate: string | null;
  status: 'pending' | 'posted';
  amountMinor: number;
  kind: string;
  description: string;
  merchant: string | null;
  issuerCategory: string | null;
  cardScopeId: string;
  /** The observation's identity kind; a v1 file set's rows are `legacy-file` (E2a-Q3). */
  identity: 'stable' | 'capture' | 'legacy-file';
  originalAmountMinor: number | null;
  originalCurrency: string | null;
}

export interface OwnerCandidate {
  transactionId: string;
  cardScopeId: string | null;
  scopeKind: 'known' | 'unknown' | 'legacy';
  sourceKind: 'file' | 'extension';
  status: 'pending' | 'posted' | 'removed';
  transactionDate: string;
  postedDate: string | null;
  amountMinor: number;
  kind: string;
  description: string;
  merchant: string | null;
  userCategory: string | null;
  notes: string | null;
  matchedOn: OwnerMatchedOn[];
  blockedReason: 'different-known-cards' | null;
}

export interface OwnerDecision {
  itemId: string;
  action: string;
  transactionId: string | null;
  cardScopeId: string | null;
}

export interface OwnerReviewItem {
  itemId: string;
  category: string;
  rowIndex: number | null;
  reason: string;
  observation: OwnerRowView | null;
  candidates: OwnerCandidate[];
  difference: { field: string; expectedMinor: number; actualMinor: number } | null;
  allowedActions: string[];
  decision: (OwnerDecision & { decidedAt: string }) | null;
  committed: (OwnerDecision & { committedAt: string }) | null;
}

export interface OwnerSetDetail extends OwnerSetSummary {
  currency: string;
  payloadDigest: string | null;
  receiptExpiresAt: string | null;
  rejectedCount: number;
  coverage: OwnerCoverageEntry[];
  itemCount: number;
  items: OwnerReviewItem[];
}

export interface OwnerTxnValues {
  status: 'pending' | 'posted' | 'removed';
  transactionDate: string;
  postedDate: string | null;
  amountMinor: number;
  kind: string;
  description: string;
  merchant: string | null;
  cardScopeId: string | null;
}

export type OwnerEffectKind = 'insert' | 'match' | 'alias' | 'attribute' | 'promote' | 'correct' | 'reject' | 'unmatch'
  | 'restore-attribution' | 'revert' | 'remove' | 'accept-difference';

export interface OwnerEffect {
  itemId: string | null;
  rowIndex: number | null;
  effect: OwnerEffectKind;
  transactionId: string | null;
  before: OwnerTxnValues | null;
  after: OwnerTxnValues | null;
}

export interface OwnerPlan {
  previewId: string;
  observationSetId: string;
  setVersion: number;
  planKind: 'set' | 'adjustment';
  payloadDigest: string | null;
  planDigest: string;
  createdAt: string;
  expiresAt: string;
  observationExpiresAt: string;
  counts: PlanCounts;
  effectCount: number;
  effects: OwnerEffect[];
}

export interface OwnerEffectPage {
  previewId: string;
  planDigest: string;
  state: OwnerPlanState;
  effects: OwnerEffect[];
}

export interface OwnerCommitResult {
  status: 'committed';
  previewId: string;
  observationSetId: string;
  committedAt: string;
  counts: PlanCounts;
}

export interface OwnerRunSummary {
  runId: string;
  deviceId: string;
  deviceLabel: string;
  bindingId: string;
  bindingVersion: number;
  issuer: string;
  source: string;
  trigger: 'manual' | 'auto';
  clientRunId: string;
  adapterVersion: string;
  contractVersion: number;
  createdAt: string;
  runExpiresAt: string;
  acceptance: 'none' | CardSyncSetState;
  ledger: 'none' | 'committed';
  observationSetId: string | null;
  payloadDigest: string | null;
  acceptedAt: string | null;
  committedAt: string | null;
  rowCount: number | null;
  runState: CardSyncRunView['runState'];
  abortReason: CardSyncRunView['abortReason'];
  errorCode: CardSyncRunView['errorCode'];
}

export type OwnerRunResult = 'inserted' | 'updated' | 'unchanged' | 'matched' | 'attributed' | 'needs-review' | 'rejected' | 'waiting';

export interface OwnerRunDetail extends OwnerRunSummary {
  observationExpiresAt: string | null;
  receiptExpiresAt: string | null;
  receiptAvailable: boolean;
  contentRetained: boolean;
  rejectedCount: number | null;
  coverage: OwnerCoverageEntry[];
  counts: PlanCounts | null;
  results: Array<{ rowIndex: number; result: OwnerRunResult; transactionId: string | null }>;
}

export interface OwnerLedgerRow {
  transactionId: string;
  cardAccountRef: string;
  revision: number;
  removedReason: string | null;
  mergedIntoId: string | null;
  values: OwnerTxnValues;
}

export interface OwnerSourceIdentity {
  identityId: string;
  status: 'active' | 'detached';
  createdBy: string;
  namespaceKind: string;
  sourceScopeId: string;
  scopeKind: string;
  firstSeenStatus: string;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface OwnerEventValues {
  status: 'pending' | 'posted' | 'removed' | null;
  amountMinor: number | null;
  transactionDate: string | null;
  postedDate: string | null;
  kind: string | null;
  cardScopeId: string | null;
}

export interface OwnerLedgerEvent {
  eventId: string;
  eventType: string;
  reason: string;
  via: 'file' | 'extension' | 'session';
  actor: 'owner' | 'device' | 'file-import';
  deviceId: string | null;
  revision: number | null;
  at: string;
  identityId: string | null;
  relatedTransactionId: string | null;
  reversesEventId: string | null;
  edited: Array<'category' | 'notes'>;
  from: OwnerEventValues | null;
  to: OwnerEventValues | null;
}

export interface OwnerTransactionSources {
  transaction: OwnerLedgerRow;
  identities: OwnerSourceIdentity[];
  mergedRows: OwnerLedgerRow[];
  revertibleEventId: string | null;
  events: OwnerLedgerEvent[];
}

// ---------------------------------------------------------------------------
// Sets and their items
// ---------------------------------------------------------------------------

/** X42: prepared → valid (expired once past its deadline), consumed → committed, expired → expired, cancelled → superseded. */
export function ownerPlanState(status: string, expiresAt: string, now: string): OwnerPlanState {
  if (status === 'prepared') return now >= expiresAt ? 'expired' : 'valid';
  if (status === 'consumed') return 'committed';
  if (status === 'expired') return 'expired';
  return 'superseded';
}

/** Q46: an open set past its deadline is expired in every view, before retention closes it. */
export function presentedSetState(set: Pick<SetRow, 'state' | 'expires_at'>, now: string): CardSyncSetState {
  return isOpenSet(set) && now >= set.expires_at ? 'expired-unreviewed' : set.state;
}

const closeReasonOf = (set: SetRow): OwnerSetSummary['closeReason'] =>
  set.close_reason === 'committed' || set.close_reason === 'discarded' || set.close_reason === 'expired' ? set.close_reason : null;

/** The latest plan this owner prepared for the set: plans belong to the principal that prepared them (§4.10.1). */
function latestPlan(db: DB, setId: string, actorRef: string, now: string): OwnerPlanRef | null {
  const plan = cachedStatement(db, `SELECT id, created_at, expires_at, status FROM card_sync_commit_plans
    WHERE observation_set_id = ? AND principal_kind = 'session' AND actor_ref = ?
    ORDER BY created_at DESC, id DESC LIMIT 1`).get(setId, actorRef) as
    { id: string; created_at: string; expires_at: string; status: string } | undefined;
  return plan ? { previewId: plan.id, createdAt: plan.created_at, expiresAt: plan.expires_at,
    state: ownerPlanState(plan.status, plan.expires_at, now) } : null;
}

/** `SetSummary` (X18): an open set's undecided items as `reviewCount`, its live items by category. */
export function ownerSetSummary(ctx: CardSyncContext, set: SetRow, actorRef: string): OwnerSetSummary {
  const { db, now } = ctx;
  const state = presentedSetState(set, now);
  const reviewCount = isOpenSet({ state })
    ? (cachedStatement(db, `SELECT count(*) AS n FROM card_reconciliation_suggestions
        WHERE observation_set_id = ? AND status = 'open'`).get(set.id) as { n: number }).n
    : 0;
  const byCategory = new Map((cachedStatement(db, `SELECT category, count(*) AS n FROM card_reconciliation_suggestions
      WHERE observation_set_id = ? AND status NOT IN ('superseded', 'discarded') GROUP BY category`).all(set.id) as
    Array<{ category: string; n: number }>).map((row) => [row.category, row.n]));
  return {
    observationSetId: set.id, sourceKind: set.origin, runId: set.run_id, bindingId: set.binding_id, deviceId: set.device_id,
    importBatchId: set.import_batch_id, cardAccountRef: set.card_account_id, version: set.version, state,
    acceptedAt: set.accepted_at, expiresAt: set.expires_at, rowCount: set.row_count, byteCount: set.byte_count, reviewCount,
    categories: REVIEW_CATEGORIES.filter((category) => byCategory.has(category))
      .map((category) => ({ category, count: byCategory.get(category)! })),
    plan: latestPlan(db, set.id, actorRef, now),
    committedAt: set.state === 'committed' ? set.closed_at : null,
    closedAt: set.closed_at,
    closeReason: closeReasonOf(set),
  };
}

/** An extension set's coverage entries as it sent them (`entry_ordinal` order); a file set's windows belong to its batch. */
export function setCoverage(db: DB, set: SetRow): OwnerCoverageEntry[] {
  if (set.origin !== 'extension') return [];
  const rows = cachedStatement(db, `SELECT card_scope_id, status, requested_start, requested_end, requested_basis, observed_start,
      observed_end, observed_basis, claimed_completeness, termination, page_count, observed_at
    FROM card_coverage_windows WHERE observation_set_id = ? ORDER BY entry_ordinal`).all(set.id) as Array<{
    card_scope_id: string; status: 'pending' | 'posted'; requested_start: string | null; requested_end: string | null;
    requested_basis: string | null; observed_start: string | null; observed_end: string | null; observed_basis: string | null;
    claimed_completeness: string; termination: string; page_count: number; observed_at: string | null;
  }>;
  return rows.map((c) => ({
    cardScopeId: c.card_scope_id, status: c.status,
    requested: c.requested_start === null ? null : { start: c.requested_start, end: c.requested_end!, dateBasis: c.requested_basis! },
    observed: c.observed_start === null ? null : { start: c.observed_start, end: c.observed_end!, dateBasis: c.observed_basis! },
    completeness: c.claimed_completeness, termination: c.termination, pageCount: c.page_count,
    observedAt: c.observed_at ?? set.observed_at ?? set.accepted_at,
  }));
}

function receiptExpiry(db: DB, setId: string): string | null {
  const row = cachedStatement(db, 'SELECT expires_at FROM card_sync_payload_receipts WHERE observation_set_id = ?').get(setId) as
    { expires_at: string } | undefined;
  return row?.expires_at ?? null;
}

interface ObservationValues {
  ordinal: number; file_row_index: number | null; transaction_date: string; posted_date: string | null; status: 'pending' | 'posted'; amount_minor: number;
  kind: string; description: string; merchant: string | null; issuer_category: string | null; source_scope_id: string;
  namespace_kind: 'legacy-file' | 'stable' | 'capture'; original_amount_minor: number | null; original_currency: string | null;
}

const OBSERVATION_VALUES = `SELECT id, ordinal, file_row_index, transaction_date, posted_date, status, amount_minor, kind, description,
  merchant, issuer_category, source_scope_id, namespace_kind, original_amount_minor, original_currency FROM card_source_observations`;

/**
 * A row's `rowIndex` (§5.5): its index in the source file for a file set's observation (`file_row_index`, 0–9,999),
 * its position in the payload otherwise (`ordinal`). `ordinal` stays the paging key either way (E2a review r1,
 * finding 7; ruling on E2a-D8).
 */
const rowIndexOf = (o: Pick<ObservationValues, 'ordinal' | 'file_row_index'>): number => o.file_row_index ?? o.ordinal;

const rowView = (o: ObservationValues): OwnerRowView => ({
  rowIndex: rowIndexOf(o), transactionDate: o.transaction_date, postedDate: o.posted_date, status: o.status, amountMinor: o.amount_minor,
  kind: o.kind, description: o.description, merchant: o.merchant, issuerCategory: o.issuer_category, cardScopeId: o.source_scope_id,
  identity: o.namespace_kind, originalAmountMinor: o.original_amount_minor, originalCurrency: o.original_currency,
});

interface CandidateValues {
  id: string; card_scope_id: string; scope_kind: 'known' | 'unknown' | 'legacy'; first_sync_run_id: string | null;
  status: 'pending' | 'posted' | 'removed'; transaction_date: string; posted_date: string | null; amount_minor: number; kind: string;
  description: string; merchant: string | null; user_category: string | null; notes: string | null;
}

/** A candidate as the owner sees it now: the row's current values, category and notes, and where it came from. */
function candidateValues(db: DB, transactionIds: readonly string[]): Map<string, CandidateValues> {
  if (transactionIds.length === 0) return new Map();
  const rows = cachedStatement(db, `SELECT t.id, t.card_scope_id, s.kind AS scope_kind, t.first_sync_run_id, t.status,
      t.transaction_date, t.posted_date, t.amount_minor, t.kind, t.description, t.merchant, t.user_category, t.notes
    FROM card_transactions t JOIN card_scopes s ON s.id = t.card_scope_id
    WHERE t.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify([...new Set(transactionIds)])) as CandidateValues[];
  return new Map(rows.map((row) => [row.id, row]));
}

const matchedOnNames = (bits: number): OwnerMatchedOn[] => MATCHED_ON_NAMES.filter(([bit]) => (bits & bit) !== 0).map(([, name]) => name);

/** One review item as `ReviewItem`: its observation's values, its candidates' current values, the draft and the commit. */
function ownerItems(db: DB, items: readonly CardSyncReviewItemView[]): OwnerReviewItem[] {
  const observationIds = items.map((item) => item.observationId).filter((id): id is string => id !== null);
  const observations = new Map(observationIds.length === 0 ? [] : (cachedStatement(db,
    `${OBSERVATION_VALUES} WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(observationIds)) as
    Array<ObservationValues & { id: string }>).map((o) => [o.id, o]));
  const candidates = candidateValues(db, items.flatMap((item) => item.candidates.map((c) => c.transactionId)));
  return items.map((item) => {
    const observation = item.observationId === null ? undefined : observations.get(item.observationId);
    if (item.observationId !== null && !observation) throw cardSyncRefusal('observation-integrity');
    return {
      itemId: item.itemId, category: item.category, rowIndex: observation ? rowIndexOf(observation) : null, reason: item.reason,
      observation: observation ? rowView(observation) : null,
      candidates: item.candidates.map((c) => {
        const row = candidates.get(c.transactionId);
        if (!row) throw cardSyncRefusal('observation-integrity');
        return {
          transactionId: row.id, cardScopeId: row.card_scope_id, scopeKind: row.scope_kind,
          sourceKind: row.first_sync_run_id === null ? 'file' as const : 'extension' as const, status: row.status,
          transactionDate: row.transaction_date, postedDate: row.posted_date, amountMinor: row.amount_minor, kind: row.kind,
          description: row.description, merchant: row.merchant, userCategory: row.user_category, notes: row.notes,
          matchedOn: matchedOnNames(c.matchedOn), blockedReason: c.blockedReason === 'different-known-cards' ? c.blockedReason : null,
        };
      }),
      difference: item.difference ? { ...item.difference } : null,
      allowedActions: [...item.allowedActions],
      decision: item.draft ? { itemId: item.itemId, action: item.draft.action, transactionId: item.draft.transactionId,
        cardScopeId: item.draft.cardScopeId, decidedAt: item.draft.decidedAt } : null,
      committed: item.committed ? { itemId: item.itemId, action: item.committed.action, transactionId: item.committed.transactionId,
        cardScopeId: item.committed.cardScopeId, committedAt: item.committed.committedAt } : null,
    };
  });
}

/** One page of a set as `SetDetail` (R7): the set's own fields, its coverage and receipt, and the page's items. */
export function ownerSetDetail(ctx: CardSyncContext, set: SetRow, page: CardSyncSetPage, actorRef: string): OwnerSetDetail {
  const { db } = ctx;
  return {
    ...ownerSetSummary(ctx, set, actorRef),
    currency: set.currency,
    payloadDigest: set.payload_digest,
    receiptExpiresAt: receiptExpiry(db, set.id),
    rejectedCount: set.producer_rejected_count,
    coverage: setCoverage(db, set),
    itemCount: page.itemCount,
    items: ownerItems(db, page.items),
  };
}

// ---------------------------------------------------------------------------
// Plans and their effects
// ---------------------------------------------------------------------------

/** A row's values as a plan's effects track them (the tracked bank values, with what `correct` needs to keep a status). */
interface TrackedValues {
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
  removedFromStatus: 'pending' | 'posted' | null;
}

interface StoredAction {
  ordinal: number; op: string; observation_ordinal: number | null; review_item_id: string | null; transaction_id: string | null;
  expected_revision: number | null; new_ref: number | null; scope_id: string | null; promote: 0 | 1; restore: 0 | 1;
  reverses_event_id: string | null;
}

const txnValues = (v: TrackedValues): OwnerTxnValues => ({
  status: v.status, transactionDate: v.transactionDate, postedDate: v.postedDate, amountMinor: v.amountMinor, kind: v.kind,
  description: v.description, merchant: v.merchant, cardScopeId: v.cardScopeId,
});

/**
 * The effects of a stored plan's actions after `afterOrdinal` (at most
 * `limit`), with before/after values (design §5.6, Revision 7 finding 4):
 * a function of the stored body and the pinned revisions only. A row's
 * values at revision r are `values-at-revision` (the first snapshot at or
 * after r, else the current row, taken whole); the plan's actions are
 * replayed from ordinal 0 through the page's last ordinal over those values,
 * as the commit applies them, so every page of a plan agrees with every
 * other whatever the ledger did since. `after` comes from the observation's
 * content, or for `revert` from the snapshot the reversed change replaced.
 */
export function planEffects(ctx: CardSyncContext, plan: { id: string; observationSetId: string }, afterOrdinal: number, limit: number):
  { effects: OwnerEffect[]; nextAfterOrdinal: number | null } {
  const { db, statements } = ctx;
  const listed = statements.all('plan-effects-page', { plan_id: plan.id, after_ordinal: afterOrdinal, limit: limit + 1 });
  const page = listed.slice(0, limit);
  if (page.length === 0) return { effects: [], nextAfterOrdinal: null };
  const last = page[page.length - 1].ordinal;
  const wanted = new Set(page.map((row) => row.ordinal));
  const actions = cachedStatement(db, `SELECT ordinal, op, observation_ordinal, review_item_id, transaction_id, expected_revision,
      new_ref, scope_id, promote, restore, reverses_event_id FROM card_sync_plan_actions WHERE plan_id = ? AND ordinal <= ?
    ORDER BY ordinal`).all(plan.id, last) as StoredAction[];
  const observationOrdinals = [...new Set(actions.map((a) => a.observation_ordinal).filter((o): o is number => o !== null))];
  const observations = new Map(observationOrdinals.length === 0 ? [] : (cachedStatement(db,
    `${OBSERVATION_VALUES} WHERE observation_set_id = ? AND ordinal IN (SELECT value FROM json_each(?))`)
    .all(plan.observationSetId, JSON.stringify(observationOrdinals)) as ObservationValues[]).map((o) => [o.ordinal, o]));
  const observed = (action: StoredAction): ObservationValues => {
    const o = action.observation_ordinal === null ? undefined : observations.get(action.observation_ordinal);
    // A closed set's content can be purged before its plan is (§5.9): its effects can no longer be shown.
    if (!o) throw cardSyncRefusal('not-found');
    return o;
  };
  const atRevision = (transactionId: string, revision: number): TrackedValues => {
    const v = statements.get('values-at-revision', { transaction_id: transactionId, revision });
    if (!v) throw cardSyncRefusal('not-found');
    return {
      status: v.status, transactionDate: v.transaction_date, postedDate: v.posted_date, amountMinor: v.amount_minor,
      originalAmountMinor: v.original_amount_minor, originalCurrency: v.original_currency, kind: v.kind, description: v.description,
      merchant: v.merchant, issuerCategory: v.issuer_category, cardScopeId: v.card_scope_id, removedFromStatus: v.removed_from_status,
    };
  };
  const overlay = new Map<string, TrackedValues>();
  const rowKey = (action: StoredAction) => action.transaction_id ?? `new:${action.new_ref}`;
  const current = (action: StoredAction): TrackedValues => {
    const key = rowKey(action);
    const known = overlay.get(key);
    if (known) return known;
    if (action.transaction_id === null || action.expected_revision === null) throw cardSyncRefusal('not-found');
    return atRevision(action.transaction_id, action.expected_revision);
  };
  const bank = (o: ObservationValues) => ({
    transactionDate: o.transaction_date, postedDate: o.posted_date, amountMinor: o.amount_minor,
    originalAmountMinor: o.original_amount_minor, originalCurrency: o.original_currency, kind: o.kind, description: o.description,
    merchant: o.merchant, issuerCategory: o.issuer_category,
  });
  const liveStatus = (row: TrackedValues): 'pending' | 'posted' => (row.status === 'removed' ? row.removedFromStatus ?? 'posted' : row.status);
  const restored = (values: TrackedValues, restore: boolean): TrackedValues => (restore ? { ...values, removedFromStatus: null } : values);

  const effects: OwnerEffect[] = [];
  for (const action of actions) {
    let effect: OwnerEffectKind | null = null;
    let before: TrackedValues | null = null;
    let after: TrackedValues | null = null;
    let transactionId: string | null = action.transaction_id;
    switch (action.op) {
      case 'insert': {
        const o = observed(action);
        after = { ...bank(o), status: o.status, cardScopeId: action.scope_id ?? o.source_scope_id, removedFromStatus: null };
        overlay.set(`new:${action.ordinal}`, after);
        effect = 'insert';
        transactionId = null;
        break;
      }
      case 'unchanged':
        break;
      case 'alias':
        before = current(action);
        after = before;
        effect = 'alias';
        break;
      case 'promote':
      case 'correct':
      case 'match': {
        before = current(action);
        const writesValues = action.op !== 'match' || action.promote === 1;
        const status = action.op === 'correct' ? liveStatus(before) : 'posted';
        after = restored({
          ...before,
          ...(writesValues ? { ...bank(observed(action)), status } : {}),
          ...(action.op === 'match' && action.scope_id !== null ? { cardScopeId: action.scope_id } : {}),
        }, action.restore === 1);
        if (writesValues || action.scope_id !== null) overlay.set(rowKey(action), after);
        effect = action.op === 'match' ? (action.promote === 1 ? 'promote' : action.scope_id !== null ? 'attribute' : 'match')
          : action.op as 'promote' | 'correct';
        break;
      }
      case 'reject':
        effect = 'reject';
        transactionId = null;
        break;
      case 'accept-difference':
        effect = 'accept-difference';
        transactionId = null;
        break;
      case 'revert': {
        before = current(action);
        const reversed = action.reverses_event_id === null ? undefined : cachedStatement(db,
          'SELECT transaction_revision FROM card_transaction_events WHERE id = ? AND card_transaction_id = ?')
          .get(action.reverses_event_id, action.transaction_id) as { transaction_revision: number } | undefined;
        if (!reversed || reversed.transaction_revision < 2) throw cardSyncRefusal('not-found');
        // The reversed change wrote revision r; its snapshot of revision r − 1 is what the revert restores (§4.9.2).
        after = atRevision(action.transaction_id!, reversed.transaction_revision - 1);
        overlay.set(rowKey(action), after);
        effect = 'revert';
        break;
      }
      case 'unmatch':
        before = current(action);
        after = before;
        effect = 'unmatch';
        break;
      case 'remove':
        before = current(action);
        after = { ...before, status: 'removed', removedFromStatus: liveStatus(before) };
        overlay.set(rowKey(action), after);
        effect = 'remove';
        break;
      case 'restore-attribution':
        before = current(action);
        after = { ...before, cardScopeId: action.scope_id ?? before.cardScopeId };
        overlay.set(rowKey(action), after);
        effect = 'restore-attribution';
        break;
      default:
        // An op this build cannot show: refuse rather than hide an effect.
        throw cardSyncRefusal('observation-integrity');
    }
    if (effect !== null && wanted.has(action.ordinal)) {
      effects.push({
        itemId: action.review_item_id, rowIndex: action.observation_ordinal === null ? null : rowIndexOf(observed(action)), effect,
        transactionId,
        before: before ? txnValues(before) : null, after: after ? txnValues(after) : null,
      });
    }
  }
  if (effects.length !== page.length) throw cardSyncRefusal('observation-integrity');
  return { effects, nextAfterOrdinal: listed.length > limit ? last : null };
}

interface PlanRecord {
  id: string; plan_kind: 'set' | 'adjustment'; observation_set_id: string; set_version: number; payload_digest: string | null;
  plan_digest: string; created_at: string; expires_at: string; status: string; closed_at: string | null; action_count: number;
  count_insert: number; count_update: number; count_unchanged: number; count_aliased: number; count_matched: number;
  count_attributed: number; count_promoted: number; count_corrected: number; count_rejected: number; count_unmatched: number;
  count_superseded: number; principal_kind: string; actor_ref: string | null;
}

/** A plan this owner prepared, or undefined (another principal's plan is not found, §4.10.1). */
export function ownerPlanRecord(db: DB, previewId: string, actorRef: string): PlanRecord | undefined {
  const plan = cachedStatement(db, 'SELECT * FROM card_sync_commit_plans WHERE id = ?').get(previewId) as PlanRecord | undefined;
  return plan && plan.principal_kind === 'session' && plan.actor_ref === actorRef ? plan : undefined;
}

export const planCountsOf = (p: PlanRecord): PlanCounts => ({
  insert: p.count_insert, update: p.count_update, unchanged: p.count_unchanged, aliased: p.count_aliased, matched: p.count_matched,
  attributed: p.count_attributed, promoted: p.count_promoted, corrected: p.count_corrected, rejected: p.count_rejected,
  unmatched: p.count_unmatched, superseded: p.count_superseded,
});

/** `Plan`: the stored plan with its first page of effects. */
export function ownerPlan(ctx: CardSyncContext, plan: PlanRecord, set: SetRow, limit: number):
  { plan: OwnerPlan; nextAfterOrdinal: number | null } {
  const { effects, nextAfterOrdinal } = planEffects(ctx, { id: plan.id, observationSetId: plan.observation_set_id }, -1, limit);
  return {
    plan: {
      previewId: plan.id, observationSetId: plan.observation_set_id, setVersion: plan.set_version, planKind: plan.plan_kind,
      payloadDigest: plan.payload_digest, planDigest: plan.plan_digest, createdAt: plan.created_at, expiresAt: plan.expires_at,
      observationExpiresAt: set.expires_at, counts: planCountsOf(plan), effectCount: plan.action_count - plan.count_unchanged, effects,
    },
    nextAfterOrdinal,
  };
}

/** `EffectPage`: the plan's digest and state (X35, X42) with one more page of effects. */
export function ownerEffectPage(ctx: CardSyncContext, plan: PlanRecord, afterOrdinal: number, limit: number):
  { page: OwnerEffectPage; nextAfterOrdinal: number | null } {
  const { effects, nextAfterOrdinal } = planEffects(ctx, { id: plan.id, observationSetId: plan.observation_set_id }, afterOrdinal, limit);
  return {
    page: { previewId: plan.id, planDigest: plan.plan_digest, state: ownerPlanState(plan.status, plan.expires_at, ctx.now), effects },
    nextAfterOrdinal,
  };
}

/** `CommitResult`: the consumed plan, with the time it was consumed (a replay answers the first commit's time). */
export function ownerCommitResult(plan: PlanRecord): OwnerCommitResult {
  if (plan.status !== 'consumed' || plan.closed_at === null) throw cardSyncRefusal('observation-integrity');
  return { status: 'committed', previewId: plan.id, observationSetId: plan.observation_set_id, committedAt: plan.closed_at,
    counts: planCountsOf(plan) };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

interface RunContext {
  deviceLabel: string;
  issuer: string;
  source: string;
  set: SetRow | undefined;
}

function runContext(db: DB, run: CardSyncRunView): RunContext {
  const device = cachedStatement(db, 'SELECT label FROM card_sync_devices WHERE id = ?').get(run.deviceId) as { label: string } | undefined;
  const binding = cachedStatement(db, 'SELECT issuer, source FROM card_source_bindings WHERE id = ?').get(run.bindingId) as
    { issuer: string; source: string } | undefined;
  if (!device || !binding) throw cardSyncRefusal('observation-integrity');
  const set = run.observationSetId === null ? undefined
    : cachedStatement(db, 'SELECT * FROM card_sync_observation_sets WHERE id = ?').get(run.observationSetId) as SetRow | undefined;
  return { deviceLabel: device.label, issuer: binding.issuer, source: binding.source, set };
}

function runSummaryOf(run: CardSyncRunView, context: RunContext, now: string): OwnerRunSummary {
  const { set } = context;
  return {
    runId: run.runId, deviceId: run.deviceId, deviceLabel: context.deviceLabel, bindingId: run.bindingId,
    bindingVersion: run.bindingVersion, issuer: context.issuer, source: context.source, trigger: run.trigger,
    clientRunId: run.clientRunId, adapterVersion: run.adapterVersion, contractVersion: run.contractVersion, createdAt: run.createdAt,
    runExpiresAt: run.uploadExpiresAt, acceptance: set ? presentedSetState(set, now) : 'none',
    ledger: set?.state === 'committed' ? 'committed' : 'none', observationSetId: set?.id ?? null,
    payloadDigest: set?.payload_digest ?? run.payloadDigest, acceptedAt: set?.accepted_at ?? run.acceptedAt,
    committedAt: set?.state === 'committed' ? set.closed_at : null, rowCount: set ? set.row_count : null, runState: run.runState,
    abortReason: run.abortReason, errorCode: run.errorCode,
  };
}

/** `RunSummary` (Q36): the run with its set's state as the owner sees it. */
export function ownerRunSummary(ctx: CardSyncContext, run: CardSyncRunView): OwnerRunSummary {
  return runSummaryOf(run, runContext(ctx.db, run), ctx.now);
}

/**
 * `RunDetail`: the summary, the set's deadline, receipt and coverage, the
 * committed plan's counts, and each row's result while the set's content is
 * kept. An expired set's rows have no result the client names (E2a-Q4):
 * none is listed for them.
 */
export function ownerRunDetail(ctx: CardSyncContext, run: CardSyncRunView): OwnerRunDetail {
  const { db, now } = ctx;
  const context = runContext(db, run);
  const summary = runSummaryOf(run, context, now);
  const { set } = context;
  if (!set) {
    return { ...summary, observationExpiresAt: null, receiptExpiresAt: null, receiptAvailable: false, contentRetained: false,
      rejectedCount: null, coverage: [], counts: null, results: [] };
  }
  const receipt = cachedStatement(db, 'SELECT expires_at FROM card_sync_payload_receipts WHERE observation_set_id = ?').get(set.id) as
    { expires_at: string } | undefined;
  const committedPlan = cachedStatement(db, `SELECT * FROM card_sync_commit_plans
    WHERE observation_set_id = ? AND plan_kind = 'set' AND status = 'consumed' ORDER BY closed_at DESC, id DESC LIMIT 1`)
    .get(set.id) as PlanRecord | undefined;
  const contentRetained = set.content_purged_at === null;
  const listResults = contentRetained && summary.acceptance !== 'expired-unreviewed';
  const results = !listResults ? [] : (cachedStatement(db, `SELECT o.ordinal, o.state, o.outcome, o.resolved_transaction_id,
      EXISTS (SELECT 1 FROM card_reconciliation_suggestions r WHERE r.observation_id = o.id AND r.status IN ('open', 'decided')) AS waiting_review
    FROM card_source_observations o WHERE o.observation_set_id = ? ORDER BY o.ordinal`).all(set.id) as Array<{
    ordinal: number; state: string; outcome: string | null; resolved_transaction_id: string | null; waiting_review: 0 | 1;
  }>).flatMap((o): OwnerRunDetail['results'] => {
    if (o.state === 'resolved') {
      return [{ rowIndex: o.ordinal, result: o.outcome as OwnerRunResult, transactionId: o.resolved_transaction_id }];
    }
    if (o.state === 'rejected') return [{ rowIndex: o.ordinal, result: 'rejected', transactionId: null }];
    if (o.state === 'open') return [{ rowIndex: o.ordinal, result: o.waiting_review === 1 ? 'needs-review' : 'waiting', transactionId: null }];
    return [];
  });
  return {
    ...summary,
    observationExpiresAt: set.expires_at,
    receiptExpiresAt: receipt?.expires_at ?? null,
    receiptAvailable: receipt !== undefined && set.receipt_state === 'kept' && now < receipt.expires_at,
    contentRetained,
    rejectedCount: set.producer_rejected_count,
    coverage: setCoverage(db, set),
    counts: committedPlan ? planCountsOf(committedPlan) : null,
    results,
  };
}

// ---------------------------------------------------------------------------
// Ledger sources (§5.7.1)
// ---------------------------------------------------------------------------

export const ledgerRowView = (row: CardLedgerRowView): OwnerLedgerRow => ({
  transactionId: row.id, cardAccountRef: row.cardAccountId, revision: row.revision, removedReason: row.removedReason,
  mergedIntoId: row.mergedIntoId,
  values: { status: row.status, transactionDate: row.transactionDate, postedDate: row.postedDate, amountMinor: row.amountMinor,
    kind: row.kind, description: row.description, merchant: row.merchant, cardScopeId: row.cardScopeId },
});

interface EventRecord {
  id: string; card_transaction_id: string; event_type: string; transaction_revision: number; origin: 'file' | 'extension' | 'session';
  actor_kind: 'session' | 'device' | 'system'; actor_ref: string | null; reason: string; created_at: string; identity_id: string | null;
  related_transaction_id: string | null; from_canonical_id: string | null; reverses_event_id: string | null; edit_fields: number;
  from_status: OwnerEventValues['status']; to_status: OwnerEventValues['status']; from_amount_minor: number | null;
  to_amount_minor: number | null; from_transaction_date: string | null; to_transaction_date: string | null;
  from_posted_date: string | null; to_posted_date: string | null; from_kind: string | null; to_kind: string | null;
  from_scope_id: string | null; to_scope_id: string | null;
}

function eventValues(status: OwnerEventValues['status'], amountMinor: number | null, transactionDate: string | null,
  postedDate: string | null, kind: string | null, cardScopeId: string | null): OwnerEventValues | null {
  if (status === null && amountMinor === null && transactionDate === null && postedDate === null && kind === null && cardScopeId === null) {
    return null;
  }
  return { status, amountMinor, transactionDate, postedDate, kind, cardScopeId };
}

/**
 * One history event of `transactionId` as `LedgerEvent` (X32): an event of
 * another row (an alias that left this one) has no revision here and names
 * that row; a re-point onto this row names where the alias came from.
 */
function ledgerEvent(e: EventRecord, transactionId: string): OwnerLedgerEvent {
  const own = e.card_transaction_id === transactionId;
  return {
    eventId: e.id, eventType: e.event_type, reason: e.reason, via: e.origin,
    actor: e.actor_kind === 'session' ? 'owner' : e.actor_kind === 'device' ? 'device' : 'file-import',
    deviceId: e.actor_kind === 'device' ? e.actor_ref : null,
    revision: own ? e.transaction_revision : null, at: e.created_at, identityId: e.identity_id,
    relatedTransactionId: own
      ? e.related_transaction_id ?? (e.event_type === 'identity-repointed' ? e.from_canonical_id : null)
      : e.card_transaction_id,
    reversesEventId: e.reverses_event_id,
    edited: [...((e.edit_fields & 1) !== 0 ? ['category' as const] : []), ...((e.edit_fields & 2) !== 0 ? ['notes' as const] : [])],
    from: eventValues(e.from_status, e.from_amount_minor, e.from_transaction_date, e.from_posted_date, e.from_kind, e.from_scope_id),
    to: eventValues(e.to_status, e.to_amount_minor, e.to_transaction_date, e.to_posted_date, e.to_kind, e.to_scope_id),
  };
}

/** `TransactionSources` from the repository's live keyset pages (§5.7.1, Revision 8): ids only there, values read here. */
export function ownerTransactionSources(ctx: CardSyncContext, sources: CardTransactionSources): OwnerTransactionSources {
  const { db } = ctx;
  const transactionId = sources.transaction.id;
  const identityKinds = new Map((sources.identities.length === 0 ? [] : cachedStatement(db, `SELECT id, namespace_kind,
      source_scope_kind FROM card_source_identities WHERE id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(sources.identities.map((i) => i.identityId))) as Array<{ id: string; namespace_kind: string; source_scope_kind: string }>)
    .map((row) => [row.id, row]));
  const events = new Map((sources.events.length === 0 ? [] : cachedStatement(db, `SELECT id, card_transaction_id, event_type,
      transaction_revision, origin, actor_kind, actor_ref, reason, created_at, identity_id, related_transaction_id, from_canonical_id,
      reverses_event_id, edit_fields, from_status, to_status, from_amount_minor, to_amount_minor, from_transaction_date,
      to_transaction_date, from_posted_date, to_posted_date, from_kind, to_kind, from_scope_id, to_scope_id
    FROM card_transaction_events WHERE id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(sources.events.map((e) => e.eventId))) as EventRecord[]).map((e) => [e.id, e]));
  return {
    transaction: ledgerRowView(sources.transaction),
    identities: sources.identities.map((identity) => {
      const kinds = identityKinds.get(identity.identityId);
      if (!kinds) throw cardSyncRefusal('observation-integrity');
      return {
        identityId: identity.identityId, status: identity.status, createdBy: identity.createdOrigin, namespaceKind: kinds.namespace_kind,
        sourceScopeId: identity.scopeId, scopeKind: kinds.source_scope_kind, firstSeenStatus: identity.firstSeenStatus,
        createdAt: identity.createdAt, lastSeenAt: identity.lastSeenAt,
      };
    }),
    mergedRows: sources.mergedRows.map((merged) => {
      const row = ledgerRow(db, merged.transactionId);
      if (!row) throw cardSyncRefusal('observation-integrity');
      return ledgerRowView(row);
    }),
    revertibleEventId: sources.revertibleEventId,
    events: sources.events.map((event) => {
      const record = events.get(event.eventId);
      if (!record) throw cardSyncRefusal('observation-integrity');
      return ledgerEvent(record, transactionId);
    }),
  };
}
