/**
 * The fake Holdr's planner: the effects a set's decisions would have on the
 * ledger, computed fresh from the kept observation and the recorded drafts
 * (never extended from an earlier plan), and what committing them records.
 * It models E1b's planner for the UI (decisions and statuses as E1b §4.6
 * lists them, counts as §4.8 defines them, adjustments as §4.9.2 orders
 * them); it is not E2's planner.
 */
import { cardSyncPlanDigest, type JsonValue } from '@finance-tracker/shared';
import { sameDecision, type PlanCounts, type PlanKind, type TxnValues } from '../ownerApi';
import { cardTransactionIdFor, rowCountOf, type CandidateRec, type DecisionRec, type EffectRec, type ItemRec, type RowResult, type SetRec } from './model';
import { txnFromCandidate, txnFromRow } from './views';

export function emptyCounts(): PlanCounts {
  return { insert: 0, update: 0, unchanged: 0, aliased: 0, matched: 0, attributed: 0, promoted: 0, corrected: 0, rejected: 0, unmatched: 0, superseded: 0 };
}

type CountKey = keyof PlanCounts;

/** One plan action as the owner sees it, with the counts E1b §4.8 gives it. */
interface Step {
  effect: EffectRec;
  counts: CountKey[];
}

const step = (effect: EffectRec, ...counts: CountKey[]): Step => ({ effect, counts });

/** The row a decision is about: the candidate it names; for a correction, which names none, the item's own row (E1b). */
function candidateOf(entry: ItemRec, decision: DecisionRec): CandidateRec | null {
  if (decision.action === 'accept-correction') return entry.candidates[0] ?? null;
  return entry.candidates.find((candidate) => candidate.transactionId === decision.transactionId) ?? null;
}

function observedOf(set: SetRec, entry: ItemRec): TxnValues | null {
  return entry.rowIndex === null ? null : txnFromRow(set, entry.rowIndex);
}

/** The bank's values (E1b §4.6: dates, amounts, kind and texts) on a transaction; its status, scope and the owner's edits stay. */
function bankValues(current: TxnValues, observed: TxnValues): TxnValues {
  return {
    ...current,
    transactionDate: observed.transactionDate,
    postedDate: observed.postedDate,
    amountMinor: observed.amountMinor,
    kind: observed.kind,
    description: observed.description,
    merchant: observed.merchant,
  };
}

/**
 * Whether linking a posted observation to T makes T posted: T pending, or removed from pending (a `removed-hit`; it is
 * restored first). A row removed from posted stays removed: the link only attaches its alias (C4, E1b X36), and the
 * bank's values for it come as a `posted-correction` item. Any other pair leaves T's values as they are: a pending
 * observation never downgrades a posted row.
 */
function promotes(observed: TxnValues | null, target: TxnValues, removedFrom: CandidateRec['removedFrom']): boolean {
  if (observed === null || observed.status !== 'posted') return false;
  return target.status === 'pending' || (target.status === 'removed' && removedFrom !== 'posted');
}

/** What a `same-transaction` or `attribute-and-link` decision does to its target T. */
function linkStep(set: SetRec, entry: ItemRec, decision: DecisionRec, candidate: CandidateRec): Step {
  const base = { itemId: entry.itemId, rowIndex: entry.rowIndex };
  const observed = observedOf(set, entry);
  const before = txnFromCandidate(candidate);
  const linked = decision.action === 'attribute-and-link';
  const scope = linked ? decision.cardScopeId : before.cardScopeId;
  const attributed: CountKey[] = linked ? ['attributed'] : [];
  if (observed && promotes(observed, before, candidate.removedFrom)) {
    // An identity hit on a pending row is E1b's plain `promote`; a candidate is a `match` that promotes (both change values).
    const counts: CountKey[] = entry.reason === 'pending-posted' ? ['promoted', 'update'] : ['matched', 'promoted', 'update'];
    const after: TxnValues = { ...bankValues(before, observed), status: 'posted', cardScopeId: scope };
    return step({ ...base, effect: 'promote', transactionId: candidate.transactionId, before, after }, ...counts, ...attributed);
  }
  if (linked) {
    return step({ ...base, effect: 'attribute', transactionId: candidate.transactionId, before, after: { ...before, cardScopeId: scope } }, 'matched', 'attributed');
  }
  return step({ ...base, effect: 'match', transactionId: candidate.transactionId, before, after: before }, 'matched');
}

/** The steps of one decision on an open set, against the ledger as it is now (E1b §4.6). */
function decisionSteps(set: SetRec, entry: ItemRec, decision: DecisionRec): Step[] {
  const base = { itemId: entry.itemId, rowIndex: entry.rowIndex };
  const observed = observedOf(set, entry);
  const candidate = candidateOf(entry, decision);
  switch (decision.action) {
    case 'same-transaction':
    case 'attribute-and-link':
      return candidate ? [linkStep(set, entry, decision, candidate)] : [];
    case 'attribute':
      return observed
        ? [step({ ...base, effect: 'insert', transactionId: null, before: null, after: { ...observed, cardScopeId: decision.cardScopeId } }, 'insert', 'attributed')]
        : [];
    case 'insert-new':
      return observed ? [step({ ...base, effect: 'insert', transactionId: null, before: null, after: observed }, 'insert')] : [];
    case 'accept-correction': {
      if (!candidate || !observed) return [];
      const before = txnFromCandidate(candidate);
      // The bank's values; the status is kept, or restored when the row had been removed.
      const status = before.status === 'removed' ? observed.status : before.status;
      return [step({ ...base, effect: 'correct', transactionId: candidate.transactionId, before, after: { ...bankValues(before, observed), status } }, 'corrected', 'update')];
    }
    case 'reject-row':
      return [step({ ...base, effect: 'reject', transactionId: null, before: null, after: null }, 'rejected')];
    case 'accept-difference':
      // The set-level acknowledgement: an action of the plan, nothing in spending changes.
      return [step({ ...base, effect: 'accept-difference', transactionId: null, before: null, after: null })];
    case 'keep-current':
    default:
      return [];
  }
}

/**
 * A changed decision of a committed set (E1b §4.9.2): the reversal of exactly
 * what the committed decision did, then the new decision's effect. Nothing is
 * deleted: a row the commit created is superseded or removed, never erased,
 * and a matched transaction keeps its own identities.
 */
function adjustmentSteps(set: SetRec, entry: ItemRec, committed: DecisionRec, decision: DecisionRec): Step[] {
  const base = { itemId: entry.itemId, rowIndex: entry.rowIndex };
  const observed = observedOf(set, entry);
  switch (committed.action) {
    case 'insert-new':
    case 'attribute': {
      if (!observed) return [];
      // The row N the commit created.
      const created: TxnValues = { ...observed, cardScopeId: committed.action === 'attribute' ? committed.cardScopeId : observed.cardScopeId };
      const removed: TxnValues = { ...created, status: 'removed' };
      const transactionId = entry.insertedTransactionId ?? cardTransactionIdFor(`inserted/${entry.itemId}`);
      if (decision.action === 'same-transaction' || decision.action === 'attribute-and-link') {
        const candidate = candidateOf(entry, decision);
        if (!candidate) return [];
        // N's identities move to T and N is retired as superseded; T itself changes only when the link promotes or attributes it.
        const steps = [step({ ...base, effect: 'supersede', transactionId, before: created, after: removed }, 'superseded')];
        const link = linkStep(set, entry, decision, candidate);
        if (link.effect.effect !== 'match') steps.push({ effect: link.effect, counts: link.counts.filter((key) => key !== 'matched') });
        return steps;
      }
      if (decision.action === 'reject-row') return [step({ ...base, effect: 'remove', transactionId, before: created, after: removed }, 'rejected')];
      if (decision.action === 'insert-new' || decision.action === 'attribute') {
        const scope = decision.action === 'attribute' ? decision.cardScopeId : observed.cardScopeId;
        // E1b §4.8 gives this no count of its own; the fake counts it as an attribution (E2 decides).
        return [step({ ...base, effect: 'restore-attribution', transactionId, before: created, after: { ...created, cardScopeId: scope } }, 'attributed')];
      }
      return [];
    }
    case 'same-transaction':
    case 'attribute-and-link': {
      const candidate = candidateOf(entry, committed);
      if (!candidate) return [];
      const original = txnFromCandidate(candidate);
      const committedLink = linkStep(set, entry, committed, candidate);
      const steps: Step[] = [];
      const current: TxnValues = committedLink.effect.after ?? original;
      if (committedLink.effect.effect !== 'match') {
        // The link wrote T (the bank's values and posted, a restore, or its card): one revert takes back the exact earlier
        // snapshot, card scope included (E1b §2.10, X30). `restore-attribution` is only for a row the commit created.
        steps.push(step({ ...base, effect: 'revert', transactionId: candidate.transactionId, before: current, after: original }, 'update'));
      }
      steps.push(step({ ...base, effect: 'unmatch', transactionId: candidate.transactionId, before: original, after: original }, 'unmatched'));
      // Rejecting adds nothing: the observation's identities stay detached and reserved. At most three steps per item
      // (E1b §4.8: an adjustment has at most three actions per changed item).
      return decision.action === 'reject-row' ? steps : [...steps, ...decisionSteps(set, entry, decision)];
    }
    case 'accept-correction': {
      const candidate = candidateOf(entry, committed);
      if (!candidate || !observed) return [];
      const original = txnFromCandidate(candidate);
      const corrected = decisionSteps(set, entry, committed)[0]?.effect.after ?? original;
      // Back to the snapshot taken by the correction (a row it restored is removed again); keeping the values is then recorded.
      return [step({ ...base, effect: 'revert', transactionId: candidate.transactionId, before: corrected, after: original }, 'update')];
    }
    case 'keep-current':
    case 'reject-row':
      return decisionSteps(set, entry, decision);
    default:
      // An accepted statement difference has no other action to change to.
      return [];
  }
}

export interface PlanResult {
  counts: PlanCounts;
  effects: EffectRec[];
}

/**
 * A set plan: decided items, then every other row (new rows inserted, known rows unchanged or, with a new id, aliased). An
 * adjustment plan of a committed set: only the items whose decision changed, each reversed and re-applied (E1b §4.9.2).
 * `rowValues` reads a ledger row's current values, which an alias shows unchanged; without it, the observed values.
 */
export function computePlan(set: SetRec, rowValues: (transactionId: string) => TxnValues | null = () => null): PlanResult {
  const counts = emptyCounts();
  const effects: EffectRec[] = [];
  const reviewed = new Set<number>();
  const committedSet = set.state === 'committed';
  for (const entry of set.items) {
    if (entry.rowIndex !== null) reviewed.add(entry.rowIndex);
    const decision = entry.decision;
    let steps: Step[] = [];
    if (committedSet) {
      if (decision && entry.committed && !sameDecision(decision, entry.committed)) steps = adjustmentSteps(set, entry, entry.committed, decision);
    } else if (decision) {
      steps = decisionSteps(set, entry, decision);
    }
    if (steps.length === 0 && entry.rowIndex !== null) counts.unchanged += 1;
    for (const { effect, counts: keys } of steps) {
      for (const key of keys) counts[key] += 1;
      effects.push(effect);
    }
  }
  const rows = rowCountOf(set);
  for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
    if (reviewed.has(rowIndex)) continue;
    const auto = committedSet ? 'unchanged' : set.autoRows.get(rowIndex) ?? 'insert';
    if (auto === 'unchanged') {
      counts.unchanged += 1;
      continue;
    }
    const after = txnFromRow(set, rowIndex);
    if (typeof auto === 'object') {
      // E1b X37: the row stays exactly as it is and gains the observation as another source: listed and counted, never unchanged.
      const values = rowValues(auto.alias) ?? after;
      counts.aliased += 1;
      effects.push({ itemId: null, rowIndex, effect: 'alias', transactionId: auto.alias, before: values, after: values });
      continue;
    }
    counts.insert += 1;
    effects.push({ itemId: null, rowIndex, effect: 'insert', transactionId: null, before: null, after });
  }
  return { counts, effects };
}

export function planDigestFor(set: SetRec, version: number, planKind: PlanKind, plan: PlanResult): string {
  return cardSyncPlanDigest({
    observationSetId: set.observationSetId,
    setVersion: version,
    planKind,
    payloadDigest: set.payloadDigest,
    counts: plan.counts,
    effects: plan.effects,
  } as unknown as JsonValue);
}

/** A row's outcome for the decision now in effect (E1b §4.6's outcome column). */
function outcomeOf(entry: ItemRec, decision: DecisionRec): RowResult | null {
  switch (decision.action) {
    case 'same-transaction':
      return entry.reason === 'pending-posted' ? 'updated' : 'matched';
    case 'attribute-and-link':
    case 'attribute':
      return 'attributed';
    case 'insert-new':
      return 'inserted';
    case 'accept-correction':
      return 'updated';
    case 'keep-current':
      return 'unchanged';
    case 'reject-row':
      return 'rejected';
    default:
      return null;
  }
}

/** What a committed plan leaves behind: per-row results, and the decisions now reflected in the ledger. */
export function applyCommit(set: SetRec, effects: EffectRec[], at: number): void {
  const byRow = new Map<number, { result: RowResult; transactionId: string | null }>();
  for (const effect of effects) {
    if (effect.itemId !== null || effect.rowIndex === null) continue;
    if (effect.effect === 'insert') {
      byRow.set(effect.rowIndex, { result: 'inserted', transactionId: cardTransactionIdFor(`inserted/${set.observationSetId}/${effect.rowIndex}`) });
    } else if (effect.effect === 'alias') {
      // E1b X37: the row's own outcome stays `unchanged` (its values changed nothing); the plan and its counts show the alias.
      byRow.set(effect.rowIndex, { result: 'unchanged', transactionId: effect.transactionId });
    }
  }
  for (const entry of set.items) {
    const decision = entry.decision;
    if (!decision) continue;
    // A new row of this item (a later adjustment can create another one, so each gets its own id).
    if (effects.some((effect) => effect.itemId === entry.itemId && effect.effect === 'insert')) {
      entry.insertedTransactionId = cardTransactionIdFor(`inserted/${entry.itemId}/${at}`);
    }
    const result = entry.rowIndex === null ? null : outcomeOf(entry, decision);
    if (entry.rowIndex !== null && result !== null) {
      const transactionId = decision.action === 'insert-new' || decision.action === 'attribute' ? entry.insertedTransactionId
        : result === 'rejected' || result === 'unchanged' ? null
          : decision.transactionId;
      byRow.set(entry.rowIndex, { result, transactionId });
    }
    entry.committed = { ...decision, at };
    entry.decision = null;
  }
  const rows = rowCountOf(set);
  const previous = new Map(set.results.map((entry) => [entry.rowIndex, entry]));
  set.results = Array.from({ length: rows }, (_row, rowIndex) => {
    const next = byRow.get(rowIndex);
    if (next) return { rowIndex, ...next };
    return previous.get(rowIndex) ?? { rowIndex, result: 'unchanged' as const, transactionId: null };
  });
}
