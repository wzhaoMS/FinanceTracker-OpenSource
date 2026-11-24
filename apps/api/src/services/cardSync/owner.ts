import { listCardSyncRuns, getCardSyncRun, type CardSyncRunCursor } from './runs.js';
import { sessionActorRef, type CardSyncContext } from './context.js';
import { getCardSyncPayloadReceipt } from './acceptance.js';
import {
  detachCardSourceIdentity, getCardTransactionSources, repointCardSourceIdentity, revertCardTransactionChange, unmergeCardTransaction,
} from './ledger.js';
import { commitCardSyncPlan, prepareCardSyncPlan, requireReversible } from './plans.js';
import { cardSyncRefusal } from './refusals.js';
import {
  discardCardSyncObservationSet, getCardSyncObservationSetPage, listCardSyncObservationSets, recordCardReviewDecisions, refreshSet,
  type CardReviewDecisionInput, type CardSyncDiscardReason, type CardSyncSetPageCursor,
} from './review.js';
import { isOpenSet, ledgerRevisionOf, readSet } from './sets.js';
import {
  ownerCommitResult, ownerEffectPage, ownerPlan, ownerPlanRecord, ownerRunDetail, ownerRunSummary, ownerSetDetail, ownerSetSummary,
  ownerTransactionSources, type OwnerCommitResult, type OwnerEffectPage, type OwnerPlan, type OwnerRunDetail, type OwnerRunSummary,
  type OwnerSetDetail, type OwnerSetSummary, type OwnerTransactionSources,
} from './ownerViews.js';

/**
 * The owner API's repository operations (E1b design §10 items 4, 17, 18,
 * 21, 24; E2a): each runs one of slice 2's methods and builds the owner
 * shape of its result in the same transaction, so what a route answers is
 * exactly what the call did or read. The page sizes are the owner API's
 * maxima (R7): 50 sets or runs, 100 items, 500 effects, 100 events,
 * 500 aliases and 100 merged rows per answer.
 */

export const OWNER_PAGE_LIMITS = Object.freeze({ sets: 50, runs: 50, items: 100, effects: 500, events: 100, identities: 500, merged: 100 });

/** Where a set item walk, plan effects walk or ledger list continues; the routes encode these as cursors. */
export type OwnerSetsContinuation = { acceptedAt: string; setId: string };
export type OwnerSourcesContinuation = null | { events: { createdAt: string; eventId: string } }
  | { identities: { createdAt: string; identityId: string } } | { merged: { removedAt: string; transactionId: string } };
export interface OwnerSourcesNext {
  events: { createdAt: string; eventId: string } | null;
  identities: { createdAt: string; identityId: string } | null;
  merged: { removedAt: string; transactionId: string } | null;
}

/** Sets newest first as `SetSummary` pages (`open`: open and inside the deadline; `closed`: the rest). */
export function listOwnerSets(ctx: CardSyncContext, input: { view: 'open' | 'closed'; after: OwnerSetsContinuation | null; actorRef: string }):
  { sets: OwnerSetSummary[]; next: OwnerSetsContinuation | null } {
  const actorRef = sessionActorRef(input?.actorRef);
  const { sets, next } = listCardSyncObservationSets(ctx, { view: input.view, after: input.after, limit: OWNER_PAGE_LIMITS.sets });
  return { sets: sets.map((summary) => ownerSetSummary(ctx, readSet(ctx.db, summary.observationSetId)!, actorRef)), next };
}

/** Whether rendering the set needs §4.5's refresh first: open, inside its deadline, its review mark behind the ledger. */
export function setNeedsRefresh(ctx: CardSyncContext, setId: string): boolean {
  const set = readSet(ctx.db, setId);
  return set !== undefined && isOpenSet(set) && ctx.now < set.expires_at
    && set.review_ledger_revision !== ledgerRevisionOf(ctx.db, set.card_account_id);
}

/**
 * One page of a set as `SetDetail` (§5.5, R7). The first page of a walk
 * refreshes the set first when asked to (§10 item 4: E2 refreshes before
 * rendering), in the same transaction as the read.
 */
export function ownerSetPage(ctx: CardSyncContext, input: {
  setId: string; after: CardSyncSetPageCursor | null; actorRef: string; refresh: boolean;
}): { detail: OwnerSetDetail; next: CardSyncSetPageCursor | null } | null {
  const actorRef = sessionActorRef(input?.actorRef);
  if (input.refresh && input.after === null) {
    const stale = readSet(ctx.db, input.setId);
    if (stale) refreshSet(ctx, stale);
  }
  const page = getCardSyncObservationSetPage(ctx, { setId: input.setId, after: input.after, limit: OWNER_PAGE_LIMITS.items });
  if (!page) return null;
  return { detail: ownerSetDetail(ctx, readSet(ctx.db, input.setId)!, page, actorRef), next: page.next };
}

/** The set's current version, for a `version-conflict` answer; null when there is no such set. */
export function ownerSetVersion(ctx: CardSyncContext, setId: string): number | null {
  return readSet(ctx.db, setId)?.version ?? null;
}

/** A decision batch (§4.10.2), answered with the set's first page after it. */
export function recordOwnerDecisions(ctx: CardSyncContext, input: {
  setId: string; expectedVersion: number; decisions: CardReviewDecisionInput[]; actorRef: string;
}): { detail: OwnerSetDetail; next: CardSyncSetPageCursor | null } {
  const actorRef = sessionActorRef(input?.actorRef);
  const page = recordCardReviewDecisions(ctx, { ...input, actorRef }, requireReversible(ctx));
  return { detail: ownerSetDetail(ctx, readSet(ctx.db, input.setId)!, page, actorRef), next: page.next };
}

/**
 * An extension set's plan and commit pin the authorization generation E2's
 * gate holds (§10 item 2). Without one (the gate blocked, or E2b's gate not
 * wired yet) they are refused as `generation-mismatch` (owner:
 * `authorization-blocked`) before anything else; file sets need none.
 */
function generationFor(origin: 'extension' | 'file', expectedGeneration: string | null): string | undefined {
  if (origin === 'file') return undefined;
  if (expectedGeneration === null) throw cardSyncRefusal('generation-mismatch');
  return expectedGeneration;
}

/** Owner prepare (§5.6): the executable plan with its first page of effects and their values. */
export function prepareOwnerPlan(ctx: CardSyncContext, input: {
  setId: string; expectedVersion: number; sourceReviewed: boolean; actorRef: string; expectedGeneration: string | null;
}): { plan: OwnerPlan; nextAfterOrdinal: number | null } {
  const actorRef = sessionActorRef(input?.actorRef);
  const set = readSet(ctx.db, input.setId);
  if (!set) throw cardSyncRefusal('not-found');
  const prepared = prepareCardSyncPlan(ctx, {
    principal: { kind: 'session', actorRef }, setId: set.id, expectedVersion: input.expectedVersion, sourceReviewed: input.sourceReviewed,
    expectedGeneration: generationFor(set.origin, input.expectedGeneration),
  });
  if (prepared.status !== 'executable') throw cardSyncRefusal('observation-integrity');
  return ownerPlan(ctx, ownerPlanRecord(ctx.db, prepared.previewId, actorRef)!, readSet(ctx.db, set.id)!, OWNER_PAGE_LIMITS.effects);
}

/** A later page of the owner's plan's effects (§5.6); null when the owner has no such plan. */
export function ownerPlanEffects(ctx: CardSyncContext, input: { previewId: string; afterOrdinal: number; actorRef: string }):
  { page: OwnerEffectPage; nextAfterOrdinal: number | null } | null {
  const actorRef = sessionActorRef(input?.actorRef);
  const plan = ownerPlanRecord(ctx.db, input.previewId, actorRef);
  if (!plan) return null;
  // §5.6: past its deadline a plan's effects are `plan-expired`, whatever its state (a committed or superseded plan
  // shows its state only until then), by this transaction's clock (E2a review r1, finding 8).
  if (ctx.now >= plan.expires_at) throw cardSyncRefusal('plan-expired');
  return ownerEffectPage(ctx, plan, input.afterOrdinal, OWNER_PAGE_LIMITS.effects);
}

/** Owner commit (§4.10.3), or the stored result of a commit already made with the same digests. */
export function commitOwnerPlan(ctx: CardSyncContext, input: {
  previewId: string; payloadDigest: string | null; planDigest: string; actorRef: string; expectedGeneration: string | null;
}): OwnerCommitResult {
  const actorRef = sessionActorRef(input?.actorRef);
  const plan = ownerPlanRecord(ctx.db, input.previewId, actorRef);
  if (!plan) throw cardSyncRefusal('plan-not-found');
  const set = readSet(ctx.db, plan.observation_set_id)!;
  const result = commitCardSyncPlan(ctx, {
    principal: { kind: 'session', actorRef }, previewId: plan.id, payloadDigest: input.payloadDigest, planDigest: input.planDigest,
    expectedGeneration: plan.status === 'consumed' ? undefined : generationFor(set.origin, input.expectedGeneration),
  });
  return ownerCommitResult(ownerPlanRecord(ctx.db, result.previewId, actorRef)!);
}

/** Discard (§5.5), answered with the set's summary. */
export function discardOwnerSet(ctx: CardSyncContext, input: {
  setId: string; expectedVersion: number; reason: CardSyncDiscardReason; actorRef: string;
}): OwnerSetSummary {
  const actorRef = sessionActorRef(input?.actorRef);
  const summary = discardCardSyncObservationSet(ctx, { ...input, actorRef });
  return ownerSetSummary(ctx, readSet(ctx.db, summary.observationSetId)!, actorRef);
}

/** Runs newest first as `RunSummary` pages, optionally of one binding. */
export function listOwnerRuns(ctx: CardSyncContext, input: { bindingId: string | null; after: CardSyncRunCursor | null }):
  { runs: OwnerRunSummary[]; next: CardSyncRunCursor | null } {
  const { runs, next } = listCardSyncRuns(ctx.db, {
    ...(input.bindingId === null ? {} : { bindingId: input.bindingId }), after: input.after, limit: OWNER_PAGE_LIMITS.runs,
  });
  return { runs: runs.map((run) => ownerRunSummary(ctx, run)), next };
}

/** One run as `RunDetail`, or null. */
export function ownerRun(ctx: CardSyncContext, runId: string): OwnerRunDetail | null {
  const run = getCardSyncRun(ctx.db, runId);
  return run ? ownerRunDetail(ctx, run) : null;
}

/** The exact object a run sent (§5.4), while its receipt is kept: `receipt-expired` after, `not-found` if nothing was accepted. */
export function ownerRunPayload(ctx: CardSyncContext, runId: string): {
  runId: string; observationSetId: string; payloadDigest: string; acceptedAt: string; receiptExpiresAt: string; canonicalJson: string;
} | null {
  const run = getCardSyncRun(ctx.db, runId);
  if (!run) return null;
  if (run.observationSetId === null) throw cardSyncRefusal('not-found');
  const receipt = getCardSyncPayloadReceipt(ctx, { setId: run.observationSetId });
  return {
    runId: run.runId, observationSetId: run.observationSetId, payloadDigest: receipt.payloadDigest, acceptedAt: receipt.acceptedAt,
    receiptExpiresAt: receipt.expiresAt, canonicalJson: receipt.canonicalJson,
  };
}

/** A card transaction's sources as `TransactionSources` (§5.7.1), with where each list continues. */
export function ownerSources(ctx: CardSyncContext, input: { transactionId: string; continue: OwnerSourcesContinuation }):
  { sources: OwnerTransactionSources; next: OwnerSourcesNext } | null {
  const sources = getCardTransactionSources(ctx, {
    transactionId: input.transactionId, continue: input.continue,
    limits: { events: OWNER_PAGE_LIMITS.events, identities: OWNER_PAGE_LIMITS.identities, merged: OWNER_PAGE_LIMITS.merged },
  });
  if (!sources) return null;
  return {
    sources: ownerTransactionSources(ctx, sources),
    next: { events: sources.nextEvents, identities: sources.nextIdentities, merged: sources.nextMerged },
  };
}

const sourcesAfter = (ctx: CardSyncContext, transactionId: string) => ownerSources(ctx, { transactionId, continue: null })!;

/** Maintenance (§5.7.1, §10 items 14, 18, 24): detach the alias from the row the owner saw it on; answers that row's sources. */
export function detachOwnerIdentity(ctx: CardSyncContext, input: {
  identityId: string; transactionId: string; expectedRevision: number; actorRef: string;
}): { sources: OwnerTransactionSources; next: OwnerSourcesNext } {
  detachCardSourceIdentity(ctx, input);
  return sourcesAfter(ctx, input.transactionId);
}

/** Maintenance: move the alias the owner saw on `fromTransactionId` to another live row; answers the row it left. */
export function repointOwnerIdentity(ctx: CardSyncContext, input: {
  identityId: string; fromTransactionId: string; toTransactionId: string; expectedRevision: number; expectedToRevision: number;
  actorRef: string;
}): { sources: OwnerTransactionSources; next: OwnerSourcesNext } {
  repointCardSourceIdentity(ctx, {
    identityId: input.identityId, fromTransactionId: input.fromTransactionId, toTransactionId: input.toTransactionId,
    expectedRevisions: [input.expectedRevision, input.expectedToRevision], actorRef: input.actorRef,
  });
  return sourcesAfter(ctx, input.fromTransactionId);
}

/** Maintenance: revert the row's latest reversible change, the one its sources name as `revertibleEventId`. */
export function revertOwnerChange(ctx: CardSyncContext, input: {
  transactionId: string; eventId: string; expectedRevision: number; actorRef: string;
}): { sources: OwnerTransactionSources; next: OwnerSourcesNext } {
  revertCardTransactionChange(ctx, input);
  return sourcesAfter(ctx, input.transactionId);
}

/** Maintenance: separate a merged row from the row it was merged into; answers the separated row. */
export function unmergeOwnerTransaction(ctx: CardSyncContext, input: {
  transactionId: string; expectedRevision: number; expectedSurvivorRevision: number; actorRef: string;
}): { sources: OwnerTransactionSources; next: OwnerSourcesNext } {
  unmergeCardTransaction(ctx, {
    loserId: input.transactionId, expectedRevisions: [input.expectedRevision, input.expectedSurvivorRevision], actorRef: input.actorRef,
  });
  return sourcesAfter(ctx, input.transactionId);
}
