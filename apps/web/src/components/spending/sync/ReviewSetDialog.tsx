import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CardAccount } from '@finance-tracker/shared';
import { formatMinor } from '../spendingFormat';
import { ActionCancelled, ActionProblem, useActionStatus, useOwnerActions } from './OwnerActions';
import {
  DECISION_BATCH,
  DISCARD_REASONS,
  sameDecision,
  type CommitResult,
  type Decision,
  type DiscardReason,
  type Plan,
  type PlanCounts,
  type PlanKind,
  type ReviewCategory,
  type ReviewItem,
  type SetDetail,
} from './ownerApi';
import { isOwnerApiError, isUnknownOutcome } from './ownerClient';
import { CandidateFacts, decisionLabel, decisionOptions, knownScopesFor, ObservationFacts, optionKey, txnSummary, type DecisionOption } from './ReviewParts';
import { SyncDialog } from './SyncDialog';
import { bindingById, plural, setTitle } from './syncFormat';
import { exactTime, expiryLevel, pauseReasons, relativeTime } from './syncStatus';
import { actionText, CATEGORY_TEXT, commitHeading, COUNT_LABELS, DISCARD_TEXT, effectText, errorText, PAUSE_TEXT, planCountsText, REASON_TEXT, STATUS_TEXT, type ErrorText } from './syncText';
import type { CommitSettlement } from './useCommitSettlement';
import type { OwnerSync } from './useOwnerSync';

interface Props {
  sync: OwnerSync;
  accounts: readonly CardAccount[];
  observationSetId: string;
  onClose: () => void;
  onChanged: () => void;
  /** A plan was committed, or may have been: Spending's figures and lists are read again. */
  onLedgerChanged: () => void;
  /** Watches commits whose answer was lost, above this dialog, until Holdr's record settles them. */
  commits: CommitSettlement;
}

type Draft = { action: Decision['action']; transactionId: string | null; cardScopeId: string | null };

/**
 * Holdr refused to change a decision already in spending (E1b §4.9.2: what it would take back is gone, or two decisions here
 * would use one charge). The decision in spending can always be chosen again, and Sources and history repairs the charge.
 */
const ADJUSTMENT_REFUSED: ErrorText = {
  message: 'Holdr can\'t make that change to a decision already in spending.',
  next: 'The charge, or where its source counts, changed since the decision was added, or another decision here uses the same charge. '
    + 'Choose what is in spending now again, or repair the charge from its Sources and history in Card transactions.',
};

/**
 * One observation set of the durable queue: decide each item, prepare a new
 * plan from the current ledger (never an extension of an old one), check what
 * it changes, then confirm. Also: change a decision after it was committed,
 * or discard the set with a reason.
 *
 * `drafts` holds only the owner's own choices not yet saved; everything else
 * shows what Holdr has. Saving sends them in bounded batches, each against the
 * version the previous batch returned, and a failure keeps what wasn't saved.
 */
export function ReviewSetDialog({ sync, accounts, observationSetId, onClose, onChanged, onLedgerChanged, commits }: Props) {
  const client = sync.client!;
  const actions = useOwnerActions();
  const status = useActionStatus();
  const [detail, setDetail] = useState<SetDetail | null>(null);
  const [loadProblem, setLoadProblem] = useState<{ message: string; next: string } | null>(null);
  const [drafts, setDrafts] = useState<Map<string, Draft>>(new Map());
  const [sourceReviewed, setSourceReviewed] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [result, setResult] = useState<{ commit: CommitResult; kind: PlanKind } | null>(null);
  /** A commit sent without a clear answer: whether Holdr applied it is unknown until it says so. */
  const [unknownCommit, setUnknownCommit] = useState<Plan | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [reason, setReason] = useState<DiscardReason | ''>('');
  const [, setTick] = useState(0);
  const state = sync.state;
  const now = sync.now();

  /** Every read and every write takes a number: a read answers only if nothing newer started after it. */
  const sequence = useRef(0);
  /** Holdr's answer, unless it is older than the one shown (a set's version never goes down). */
  const adopt = useCallback((next: SetDetail) => {
    setDetail((current) => (current !== null && current.observationSetId === next.observationSetId && next.version < current.version ? current : next));
  }, []);
  /** A write starts: reads already on their way can no longer replace what it returns. */
  const beginWrite = () => { sequence.current += 1; };

  /** Reads on their way, background or not. */
  const reading = useRef(0);
  /** A background refresh asked for while a read was on its way: it runs once no read is left. */
  const refreshAfter = useRef(false);
  const refreshRef = useRef<() => void>(() => {});

  const load = useCallback(async (): Promise<SetDetail | null> => {
    const mine = ++sequence.current;
    reading.current += 1;
    try {
      const next = await client.getObservationSet(observationSetId);
      if (mine !== sequence.current) return null;
      adopt(next);
      setLoadProblem(null);
      return next;
    } catch (error) {
      if (mine === sequence.current) setLoadProblem(errorText(error));
      return null;
    } finally {
      reading.current -= 1;
      if (reading.current === 0 && refreshAfter.current) {
        refreshAfter.current = false;
        refreshRef.current();
      }
    }
  }, [adopt, client, observationSetId]);

  // Read on open and whenever the shared state moves (polling, another window, a clean-up); unsaved choices stay.
  const revision = sync.revision;
  const busyRef = useRef(status.busy);
  busyRef.current = status.busy;
  /**
   * A background read never starts while another read is on its way: a large set comes in many pages (R7), and a new
   * read would discard one that may take longer than the 30 seconds between Holdr's state refreshes, so nothing would
   * ever show. It waits, and runs once that read is done. A write still discards every read started before it.
   */
  const refresh = useCallback(() => {
    if (busyRef.current) return;
    if (reading.current > 0) {
      refreshAfter.current = true;
      return;
    }
    void load();
  }, [load]);
  refreshRef.current = refresh;
  useEffect(() => {
    refresh();
  }, [refresh, revision]);
  // The plan's ten minutes and the set's expiry count down on screen.
  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), 15_000);
    return () => clearInterval(timer);
  }, []);

  const binding = detail ? bindingById(state, detail.bindingId) : null;
  const fromFile = detail?.sourceKind === 'file';
  const knownScopes = useMemo(() => (detail ? knownScopesFor(detail, state) : []), [detail, state]);
  const committedSet = detail?.state === 'committed';
  // Kept until `expiresAt` on Holdr's clock: past it nothing can be decided or planned, even before Holdr's clean-up runs.
  const lapsed = detail ? detail.closeReason === null && Date.parse(detail.expiresAt) <= now : false;
  const open = detail ? detail.closeReason === null && !lapsed : false;
  // A committed set takes changed decisions only until the same `expiresAt`; after that, Spending's own tools (Q34).
  const adjustable = detail !== null && committedSet && Date.parse(detail.expiresAt) > now;
  const choiceOf = useCallback((entry: ReviewItem): Draft | null => drafts.get(entry.itemId) ?? entry.decision ?? null, [drafts]);
  const changed = useMemo(() => (detail ? detail.items.filter((entry) => {
    const draft = drafts.get(entry.itemId);
    return draft !== undefined && !sameDecision(draft, entry.decision);
  }) : []), [detail, drafts]);
  const undecided = detail && open ? detail.items.filter((entry) => choiceOf(entry) === null).length : 0;
  const committedChanges = detail && committedSet
    ? detail.items.filter((entry) => { const choice = choiceOf(entry); return choice !== null && entry.committed !== null && !sameDecision(choice, entry.committed); }).length
    : 0;
  const blockers = binding && state ? pauseReasons(binding, state).filter((reasonCode) => reasonCode !== 'device-api-off') : [];
  const needsSourceReview = detail?.state === 'blocked-review' || detail?.state === 'recovery-review';
  // A plan is usable only while Holdr still lists it as this set's valid plan and its ten minutes aren't over. Holdr lists
  // only the plan this signed-in owner prepared last (E2a: plans belong to whoever prepared them); another owner's isn't shown.
  const planUsable = plan !== null && unknownCommit === null && result === null && Date.parse(plan.expiresAt) > now
    && detail?.plan?.previewId === plan.previewId && detail.plan.state === 'valid';
  const previousPlan = detail?.plan ?? null;
  const previousPlanLapsed = previousPlan !== null && previousPlan.state !== 'committed'
    && (previousPlan.state !== 'valid' || Date.parse(previousPlan.expiresAt) <= now);
  const prepareLabel = (plan && !planUsable) || (!plan && previousPlanLapsed)
    ? 'Prepare a new plan from the current ledger'
    : 'Prepare the plan from the current ledger';

  const choose = (entry: ReviewItem, option: DecisionOption) => {
    setDrafts((current) => new Map(current).set(entry.itemId, { action: option.action, transactionId: option.transactionId, cardScopeId: option.cardScopeId }));
    setPlan(null);
  };

  /** A refused change of a decision already in spending gets its own text; any other failure the code's. */
  const adjustmentProblem = (error: unknown): ErrorText | null => (committedSet && isOwnerApiError(error, 'action-not-allowed') ? ADJUSTMENT_REFUSED : null);

  const applyToCategory = (category: ReviewCategory, action: Decision['action']) => {
    if (!detail) return;
    setDrafts((current) => {
      const next = new Map(current);
      for (const entry of detail.items) {
        if (entry.category === category && (next.get(entry.itemId) ?? entry.decision ?? null) === null && entry.allowedActions.includes(action)) {
          next.set(entry.itemId, { action, transactionId: null, cardScopeId: null });
        }
      }
      return next;
    });
    setPlan(null);
  };

  /** Saves the unsaved choices in batches; each batch uses the version the last one returned. */
  const saveDecisions = async (): Promise<SetDetail | null> => {
    if (!detail) return null;
    let current = detail;
    const pending: Decision[] = changed.map((entry) => ({ itemId: entry.itemId, ...drafts.get(entry.itemId)! }));
    for (let start = 0; start < pending.length; start += DECISION_BATCH) {
      const batch = pending.slice(start, start + DECISION_BATCH);
      beginWrite();
      current = await client.recordDecisions(current.observationSetId, { expectedVersion: current.version, decisions: batch });
      adopt(current);
      setDrafts((existing) => {
        const next = new Map(existing);
        for (const decision of batch) if (sameDecision(next.get(decision.itemId), decision)) next.delete(decision.itemId);
        return next;
      });
    }
    return current;
  };

  const save = () => status.track(async () => {
    try {
      await saveDecisions();
    } catch (error) {
      await load();
      throw error;
    }
  }, 'Decisions saved. Holdr keeps them with this import, so you can finish later from any signed-in browser.', adjustmentProblem);

  const preparePlan = () => status.track(async () => {
    try {
      const saved = await saveDecisions();
      if (!saved) return;
      beginWrite();
      const prepared = await client.preparePlan(saved.observationSetId, { expectedVersion: saved.version, sourceReviewed });
      setPlan(prepared);
      setResult(null);
      setUnknownCommit(null);
      await load();
    } catch (error) {
      await load();
      throw error;
    }
  }, undefined, adjustmentProblem);

  /** Sends the plan; repeating it is safe because Holdr applies a plan at most once and answers a repeat with what it did. */
  const commit = (target: Plan) => status.track(async () => {
    beginWrite();
    try {
      const committed = await client.commitPlan(target.previewId, { payloadDigest: target.payloadDigest, planDigest: target.planDigest });
      commits.forget(target.previewId);
      setResult({ commit: committed, kind: target.planKind });
      setPlan(null);
      setUnknownCommit(null);
      await load();
      onChanged();
      onLedgerChanged();
    } catch (error) {
      if (isUnknownOutcome(error)) {
        // Never assume it failed: keep the plan, show the outcome as unknown, and let Holdr's own record settle it,
        // here or, once this dialog is closed, in the Spending tab, which reads Spending again when it does.
        setUnknownCommit(target);
        commits.watch({ observationSetId, previewId: target.previewId });
        await load();
        onChanged();
        onLedgerChanged();
        throw new ActionCancelled();
      }
      const next = await load();
      if (next?.plan?.previewId === target.previewId && next.plan.state === 'committed') {
        // An earlier attempt went through; Holdr's record says so even though this answer is a refusal.
        commits.forget(target.previewId);
        setUnknownCommit(target);
        setPlan(null);
        onChanged();
        onLedgerChanged();
        throw new ActionCancelled();
      }
      setPlan(null);
      setUnknownCommit(null);
      throw error;
    }
  }, undefined, adjustmentProblem);

  const discard = () => status.track(async () => {
    if (!detail || !reason) return;
    const confirmed = await actions.confirm({
      title: 'Discard this import?',
      body: 'Nothing from it is added to spending. Holdr deletes its rows and the exact sent object, and keeps only a record without values. This can\'t be undone; to get them back, capture again or import the offline file.',
      confirmLabel: 'Discard',
      danger: true,
    });
    if (!confirmed) throw new ActionCancelled();
    beginWrite();
    await client.discardObservationSet(detail.observationSetId, { expectedVersion: detail.version, reason });
    onChanged();
    onClose();
  });

  // Holdr's own record settles an unknown commit: its plan committed means it was applied.
  const settledCommit = unknownCommit !== null && detail?.plan?.previewId === unknownCommit.previewId && detail.plan.state === 'committed';

  const title = detail ? `Review: ${setTitle(detail, state, accounts)}` : 'Review';
  const level = detail && open ? expiryLevel(detail.expiresAt, now) : null;
  const legacyScopes = useMemo(() => new Set((detail?.items ?? []).flatMap((entry) => entry.candidates)
    .filter((candidate) => candidate.scopeKind === 'legacy' && candidate.cardScopeId !== null).map((candidate) => candidate.cardScopeId as string)), [detail]);
  const groups = useMemo(() => {
    const byCategory = new Map<ReviewCategory, ReviewItem[]>();
    for (const entry of detail?.items ?? []) byCategory.set(entry.category, [...(byCategory.get(entry.category) ?? []), entry]);
    return [...byCategory.entries()];
  }, [detail]);

  return (
    <SyncDialog title={title} onClose={onClose} busy={status.busy} wide closeLabel="Close review">
      {loadProblem ? <ActionProblem problem={loadProblem} /> : null}
      {!detail ? <p className="spending-muted">Loading…</p> : (
        <>
          <div className="sync-set-facts">
            <p className="sync-text">
              {fromFile ? 'Imported from a file' : 'Received'} {exactTime(detail.acceptedAt)} · {plural(detail.rowCount, 'row')}
              {detail.rejectedCount > 0 ? ` · the extension dropped ${plural(detail.rejectedCount, 'invalid row')}` : ''}
            </p>
            {fromFile ? (
              <p className="spending-muted" data-testid="file-origin">
                These rows came from an offline file import, not the extension; they need a decision because Holdr already has something like them.
                No browser or extension connection is involved, so pausing or turning an issuer off doesn&apos;t hold them.
              </p>
            ) : null}
            {open ? (
              <p className={level === 'day' || level === 'week' ? 'sync-expiry warn' : 'sync-text'} data-testid="set-expiry">
                Holdr keeps this import until {exactTime(detail.expiresAt)} ({relativeTime(detail.expiresAt, now)}); then it is cleared and nothing from it is added.
                {level === 'day' ? ' Less than a day left.' : level === 'week' ? ' Less than a week left.' : ''}
              </p>
            ) : committedSet && adjustable ? (
              <p className="sync-text" data-testid="adjust-window">
                Plan applied {detail.committedAt ? exactTime(detail.committedAt) : ''}. You can still change a decision until {exactTime(detail.expiresAt)}
                {' '}({relativeTime(detail.expiresAt, now)}): Holdr prepares a new plan that undoes the old one and applies the new one. It never deletes what the bank sent.
              </p>
            ) : committedSet ? (
              <p className="sync-text" role="status" data-testid="adjust-window">
                Plan applied {detail.committedAt ? exactTime(detail.committedAt) : ''}. Holdr kept this import until {exactTime(detail.expiresAt)}, so
                decisions can&apos;t change here any more. Change the transactions themselves with Spending&apos;s own tools.
              </p>
            ) : lapsed || detail.closeReason === 'expired' ? (
              <p className="sync-expiry warn" role="status" data-testid="set-closed">
                This import expired {exactTime(detail.expiresAt)} without review. {STATUS_TEXT['review-expired'].more.join(' ')} {STATUS_TEXT['review-expired'].next}
              </p>
            ) : detail.closeReason === 'discarded' ? (
              <p className="sync-text" data-testid="set-closed">
                Discarded {detail.closedAt ? exactTime(detail.closedAt) : ''}; nothing from this import was added.
              </p>
            ) : null}
          </div>

          {needsSourceReview ? (
            <div className="sync-banner tone-warn" role="status">
              <strong>{detail.state === 'recovery-review' ? 'This import is from before Holdr was restored.' : 'The browser that sent it was revoked, or the card\'s connection changed.'}</strong>
              <span>Check where it came from before using it. Nothing is reused automatically.</span>
              <label className="spending-toggle">
                <input type="checkbox" checked={sourceReviewed} onChange={(event) => setSourceReviewed(event.target.checked)} />
                <span>I checked where this import came from and still want to use it</span>
              </label>
            </div>
          ) : null}
          {blockers.length > 0 ? (
            <div className="sync-banner tone-warn" role="status">
              <strong>Plans can&apos;t be prepared or confirmed right now.</strong>
              <span>{blockers.map((reasonCode) => PAUSE_TEXT[reasonCode]).join(' ')} You can still decide items and discard.</span>
            </div>
          ) : null}

          {detail.items.length === 0 && open ? (
            <p className="sync-text">Nothing here needs a decision: every row has the bank&apos;s own id and no conflict. Prepare the plan to see what would be added.</p>
          ) : null}

          {groups.map(([category, entries]) => (
            <section key={category} className="sync-group" aria-label={CATEGORY_TEXT[category].label}>
              <h4>{CATEGORY_TEXT[category].label} ({entries.length})</h4>
              <p className="spending-muted">{CATEGORY_TEXT[category].detail}</p>
              {open && entries.length > 1 ? (
                <BulkDecision category={category} entries={entries} choiceOf={choiceOf} onApply={applyToCategory} />
              ) : null}
              {entries.map((entry) => (
                <ItemDecision
                  key={entry.itemId}
                  entry={entry}
                  options={decisionOptions(entry, knownScopes, state, detail.currency)}
                  chosen={choiceOf(entry)}
                  disabled={status.busy || unknownCommit !== null || (!open && !adjustable)}
                  fromFile={fromFile}
                  currency={detail.currency}
                  onChoose={(option) => choose(entry, option)}
                  sync={sync}
                />
              ))}
            </section>
          ))}

          <ActionProblem problem={status.problem} />
          {status.done ? <p className="sync-done" role="status">{status.done}</p> : null}

          {result ? (
            <div className="sync-result" role="status">
              <strong>{commitHeading(result.kind)}</strong>
              <span>{planCountsText(result.commit.counts)}</span>
            </div>
          ) : null}
          {unknownCommit && settledCommit ? (
            <div className="sync-result" role="status" data-testid="commit-settled">
              <strong>Holdr applied this plan; only its answer was lost on the way.</strong>
              <span>{planCountsText(unknownCommit.counts)}</span>
            </div>
          ) : unknownCommit ? (
            <div className="sync-banner tone-warn" role="status" data-testid="commit-unknown">
              <strong>Holdr didn&apos;t confirm whether this plan was applied.</strong>
              <span>
                The connection or the answer failed after it was sent, so it may already be applied. Checking again is safe: Holdr applies a plan at
                most once and answers a repeat with what it did.
              </span>
              <button type="button" className="spending-button" disabled={status.busy} onClick={() => { void commit(unknownCommit); }}>Check again</button>
            </div>
          ) : null}

          {!plan && open && previousPlanLapsed && previousPlan ? (
            <p className="sync-expiry warn" role="status">
              Your last plan (prepared {exactTime(previousPlan.createdAt)}) {previousPlan.state === 'superseded' ? 'was replaced or cancelled' : `expired at ${exactTime(previousPlan.expiresAt)}`}
              {' '}and was never applied. Prepare a new one from the current ledger: it is checked again, not extended.
            </p>
          ) : null}
          {plan && !unknownCommit ? <PlanView plan={plan} now={now} sync={sync} legacyScopes={legacyScopes} currency={detail.currency} /> : null}

          {(open || adjustable) && !unknownCommit ? (
            <div className="spending-detail-actions sync-review-actions">
              <button type="button" className="spending-button" disabled={status.busy || changed.length === 0} onClick={() => { void save(); }}>
                Save decisions
              </button>
              <button
                type="button"
                className="spending-button primary"
                disabled={status.busy || blockers.length > 0 || (needsSourceReview && !sourceReviewed) || undecided > 0 || (committedSet && committedChanges === 0)}
                onClick={() => { void preparePlan(); }}
              >
                {prepareLabel}
              </button>
              {planUsable && plan ? (
                <button type="button" className="spending-button primary" disabled={status.busy || blockers.length > 0} onClick={() => { void commit(plan); }}>
                  {plan.planKind === 'adjustment' ? 'Confirm and apply the changes' : 'Confirm and apply the plan'}
                </button>
              ) : null}
            </div>
          ) : null}
          {changed.length > 0 && (open || adjustable) ? (
            <p className="spending-muted" data-testid="unsaved">{plural(changed.length, 'choice')} not saved yet.</p>
          ) : null}
          {undecided > 0 && open ? <p className="spending-muted">{plural(undecided, 'item')} still need a decision before a plan can be prepared.</p> : null}

          {open ? (
            <div className="sync-discard">
              {!discardOpen ? (
                <button type="button" className="spending-link" onClick={() => setDiscardOpen(true)}>Discard this import…</button>
              ) : (
                <div className="spending-detail-form">
                  <label>
                    Why discard it
                    <select value={reason} onChange={(event) => setReason(event.target.value as DiscardReason | '')}>
                      <option value="">Choose a reason…</option>
                      {DISCARD_REASONS.filter((item) => !(fromFile && item === 'wrong-binding')).map((item) => <option key={item} value={item}>{DISCARD_TEXT[item]}</option>)}
                    </select>
                  </label>
                  <div className="spending-detail-actions">
                    <button type="button" className="spending-button danger" disabled={status.busy || !reason} onClick={() => { void discard(); }}>Discard</button>
                    <button type="button" className="spending-button" onClick={() => setDiscardOpen(false)}>Keep it</button>
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </>
      )}
    </SyncDialog>
  );
}

function BulkDecision({ category, entries, choiceOf, onApply }: {
  category: ReviewCategory;
  entries: ReviewItem[];
  choiceOf: (entry: ReviewItem) => Draft | null;
  onApply: (category: ReviewCategory, action: Decision['action']) => void;
}) {
  const [action, setAction] = useState<Decision['action'] | ''>('');
  const open = entries.filter((entry) => choiceOf(entry) === null);
  // Only decisions that need no transaction or card, allowed for every open item; never preselected.
  const shared = (['insert-new', 'reject-row', 'keep-current', 'accept-difference'] as const)
    .filter((candidate) => open.length > 1 && open.every((entry) => entry.allowedActions.includes(candidate)));
  if (shared.length === 0) return null;
  return (
    <div className="sync-bulk">
      <label className="spending-select">
        <span>Same decision for the {plural(open.length, 'undecided item')} here</span>
        <select value={action} onChange={(event) => setAction(event.target.value as Decision['action'] | '')}>
          <option value="">Choose…</option>
          {shared.map((item) => <option key={item} value={item}>{actionText(item, category)}</option>)}
        </select>
      </label>
      <button type="button" className="spending-button" disabled={!action} onClick={() => { if (action) onApply(category, action); setAction(''); }}>
        Apply
      </button>
    </div>
  );
}

function ItemDecision({ entry, options, chosen, disabled, fromFile, currency, onChoose, sync }: {
  entry: ReviewItem;
  options: DecisionOption[];
  chosen: Draft | null;
  disabled: boolean;
  fromFile: boolean;
  /** The set's currency: USD for the extension's, the card account's for a file import's. */
  currency: string;
  onChoose: (option: DecisionOption) => void;
  sync: OwnerSync;
}) {
  const chosenKey = chosen ? optionKey(chosen.action, chosen.transactionId, chosen.cardScopeId) : null;
  const legend = entry.observation
    ? `${entry.observation.description} · ${formatMinor(Math.abs(entry.observation.amountMinor), currency)}`
    : CATEGORY_TEXT[entry.category].label;
  return (
    <fieldset className="sync-item" data-item={entry.itemId} data-category={entry.category} data-reason={entry.reason}>
      <legend>{legend}</legend>
      <p className="spending-muted sync-reason">Why Holdr asks: {REASON_TEXT[entry.reason]}</p>
      {entry.observation ? <ObservationFacts row={entry.observation} state={sync.state} fromFile={fromFile} currency={currency} /> : null}
      {entry.difference ? (
        <p className="sync-text">
          The statement shows {formatMinor(entry.difference.expectedMinor, currency)} for {entry.difference.field.replace('-', ' ')}; the rows Holdr can account for
          give {formatMinor(entry.difference.actualMinor, currency)}. The difference may be rows the capture didn&apos;t include.
        </p>
      ) : null}
      {entry.candidates.map((candidate, index) => (
        <CandidateFacts
          key={candidate.transactionId}
          candidate={candidate}
          state={sync.state}
          currency={currency}
          title={entry.category === 'posted-correction' ? 'What Holdr has now' : entry.candidates.length > 1 ? `Possible match ${index + 1}` : 'Possible match in Holdr'}
        />
      ))}
      {entry.committed ? (
        <p className="sync-text">In spending now: {decisionLabel(entry, entry.committed.action, entry.committed.transactionId)} (since {exactTime(entry.committed.committedAt)}).</p>
      ) : null}
      {options.length > 0 ? (
        <div className="sync-options" role="radiogroup" aria-label={`Decision for ${legend}`}>
          {options.map((option) => (
            <label key={option.key} className="sync-option">
              <input
                type="radio"
                name={`decision-${entry.itemId}`}
                checked={chosenKey === option.key}
                disabled={disabled}
                onChange={() => onChoose(option)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      ) : entry.committed ? null : (
        // A committed set past its acceptance offers no action (C3); anything else without one says so plainly.
        <p className="spending-muted">Holdr offers no decision for this item.</p>
      )}
      {entry.category === 'cross-source-similar' && chosen?.action === 'insert-new' ? (
        <p className="sync-expiry warn">Keeping both means spending may count this purchase twice.</p>
      ) : null}
    </fieldset>
  );
}

function PlanView({ plan, now, sync, legacyScopes, currency }: { plan: Plan; now: number; sync: OwnerSync; legacyScopes: ReadonlySet<string>; currency: string }) {
  const expired = Date.parse(plan.expiresAt) <= now;
  const adjustment = plan.planKind === 'adjustment';
  return (
    <section className={`sync-plan${expired ? ' expired' : ''}`} aria-label="Plan" data-plan-kind={plan.planKind}>
      <h4>{adjustment ? 'Plan to change what is in spending, from the current ledger' : 'Plan from the current ledger'}</h4>
      {adjustment ? (
        <p className="sync-text">
          Only the decisions you changed: each first undoes what the earlier decision did, then applies the new one. Nothing is deleted; your own
          category and notes stay.
        </p>
      ) : null}
      {expired ? (
        <p className="sync-expiry warn" role="status">
          This plan expired at {exactTime(plan.expiresAt)}. Plans are never extended: prepare a new one from the current ledger. The imported rows are still kept.
        </p>
      ) : (
        <p className="sync-text" role="status">
          Valid until {exactTime(plan.expiresAt)} ({relativeTime(plan.expiresAt, now)}). Nothing changes until you confirm.
        </p>
      )}
      <ul className="sync-counts">
        {COUNT_LABELS.filter(([key]) => plan.counts[key] > 0).map(([key, label]) => (
          <li key={key}><strong className="num">{plan.counts[key]}</strong> {label}</li>
        ))}
      </ul>
      {plan.effects.length > 0 ? (
        <ol className="sync-effects">
          {plan.effects.map((effect, index) => (
            <li key={`${effect.itemId ?? 'row'}-${effect.rowIndex ?? 'set'}-${effect.effect}-${index}`} data-effect={effect.effect}>
              <strong>{effectText(effect)}</strong>
              {effect.effect === 'alias' && effect.after ? (
                // Values unchanged (E1b X37): what is in spending, once.
                <span>In spending, unchanged: {txnSummary(effect.after, sync.state, legacyScopes, currency)}</span>
              ) : (
                <>
                  {effect.before ? <span>Before: {txnSummary(effect.before, sync.state, legacyScopes, currency)}</span> : null}
                  {effect.after ? <span>After: {txnSummary(effect.after, sync.state, legacyScopes, currency)}</span> : null}
                </>
              )}
            </li>
          ))}
        </ol>
      ) : null}
      <p className="spending-muted">
        Plan digest {plan.planDigest.slice(0, 16)}… {plan.payloadDigest ? `for sent object ${plan.payloadDigest.slice(0, 16)}…` : 'for rows from a file import (no sent object)'}
      </p>
    </section>
  );
}
