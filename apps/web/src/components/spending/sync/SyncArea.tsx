import { useCallback, useId, useState } from 'react';
import type { CardAccount } from '@finance-tracker/shared';
import { Disclosure } from '../../Disclosure';
import { dateRangeLabel } from '../spendingFormat';
import { ActionProblem, useActionStatus, useOwnerActions } from './OwnerActions';
import { OPEN_SET_STATES, type Binding, type OwnerState, type RunSummary, type SetSummary } from './ownerApi';
import { isOwnerApiError, isRefusedCursor } from './ownerClient';
import { ReviewSetDialog } from './ReviewSetDialog';
import { reviewQueuePage } from './reviewQueue';
import { RunDialog } from './RunDialog';
import { SyncBanners } from './SyncBanners';
import { NO_LONGER_LISTED, bindingTitle, bytesText, cardAccountText, deviceText, plural, scopeTextById, setTitle } from './syncFormat';
import { bindingStatus, exactTime, expiryLevel, pastTime, relativeTime, type BindingStatus } from './syncStatus';
import { ABORT_TEXT, CATEGORY_TEXT, FLAG_TEXT, NOT_ON_RECORD, RUN_ERROR_TEXT, STATUS_TEXT, TERMINATION_TEXT, cardGuidance, lastReceivedText } from './syncText';
import { usePagedList, type PagedList } from './usePagedList';
import type { CommitSettlement } from './useCommitSettlement';
import type { OwnerSync } from './useOwnerSync';
import './sync.css';

/** Holdr refused a list's "show more" cursor (the list changed under it, or Holdr restarted): the list is read again. */
const listCursorRefused = (error: unknown) => isRefusedCursor(error, '$.cursor');

interface Props {
  sync: OwnerSync;
  accounts: readonly CardAccount[];
  onOpenDevices: () => void;
  /** Opens Spending's file import; absent while Spending can't write. */
  onImport?: () => void;
  /** A plan was committed (or may have been): the Spending figures and lists must be read again. */
  onLedgerChanged: () => void;
  /** Commits whose answer was lost, watched by the Spending tab until Holdr's record settles them. */
  commits: CommitSettlement;
  /** Goes up whenever Spending's own data changed (an import, an edit); without Holdr's sync state, the review lists read again on it. */
  dataVersion?: number;
}

/** 「同步与覆盖」: each connected card's place in the §8 status list, the imports awaiting review, and the runs. */
export function SyncArea({ sync, accounts, onOpenDevices, onImport, onLedgerChanged, commits, dataVersion = 0 }: Props) {
  const { state, client } = sync;
  const [showClosed, setShowClosed] = useState(false);
  const [setId, setSetId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  // Without Holdr's sync state (`/state` says this Holdr has no extension sync, as in `vite` mode), file
  // imports' review sets are still listed and reviewed here: file sets never consult the sync gate (E1b §10 items 10, 14).
  // Only they are listed then (reviewQueuePage): an extension capture still in the database needs the gate and its binding.
  const fileOnly = state === null && sync.status === 'unavailable' && client !== null;
  const [fileReloads, setFileReloads] = useState(0);
  const revision = state ? sync.revision : 0;
  const reloadKey = client && revision > 0 ? String(revision) : fileOnly ? `file/${dataVersion}/${fileReloads}` : null;

  const openSets = usePagedList<SetSummary>(
    (cursor) => reviewQueuePage((next) => client!.listObservationSets('open', next), cursor, fileOnly),
    (set) => set.observationSetId, reloadKey, listCursorRefused,
  );
  // Without Holdr's sync state, closed reviews are read too: whether any exist decides whether the queue is shown at all.
  const closedSets = usePagedList<SetSummary>(
    (cursor) => reviewQueuePage((next) => client!.listObservationSets('closed', next), cursor, fileOnly),
    (set) => set.observationSetId, showClosed || fileOnly ? reloadKey : null, listCursorRefused,
  );
  const runs = usePagedList<RunSummary>(async (cursor) => {
    const page = await client!.listRuns({ cursor });
    return { items: page.runs, nextCursor: page.nextCursor };
  }, (run) => run.runId, fileOnly ? null : reloadKey, listCursorRefused);
  const listError = openSets.error ?? closedSets.error ?? runs.error;

  const changed = useCallback(() => {
    void sync.refresh();
    setFileReloads((count) => count + 1);
  }, [sync]);
  // A Holdr without the owner API at all answers 404 here too: then there is simply nothing to list.
  const fileListError = fileOnly && listError && !(isOwnerApiError(listError) && listError.status === 404) ? listError : null;
  // Shown once Holdr lists any review: an open one, or a closed one the owner may open again (a committed one can still change).
  const fileQueue = fileOnly && ((openSets.items?.length ?? 0) > 0 || (closedSets.items?.length ?? 0) > 0);

  return (
    <div className="sync-area">
      <SyncBanners sync={sync} onResume={onOpenDevices} onImport={onImport} />
      {state ? (
        <>
          <SyncHeader sync={sync} onOpenDevices={onOpenDevices} />
          <BindingStatusList
            state={state}
            now={sync.now()}
            accounts={accounts}
            onReview={setSetId}
            onOpenDevices={onOpenDevices}
            onImport={onImport}
          />
          <ReviewQueue
            state={state}
            now={sync.now()}
            accounts={accounts}
            open={openSets}
            closed={closedSets}
            showClosed={showClosed}
            onShowClosed={setShowClosed}
            onOpen={setSetId}
          />
          <RunList state={state} now={sync.now()} runs={runs} onOpen={setRunId} />
          {listError ? <ActionProblem problem={{ message: 'Couldn\'t load the review queue or the runs.', next: 'Refresh to try again.' }} /> : null}
        </>
      ) : null}
      {fileQueue ? (
        <ReviewQueue
          state={null}
          now={sync.now()}
          accounts={accounts}
          open={openSets}
          closed={closedSets}
          showClosed={showClosed}
          onShowClosed={setShowClosed}
          onOpen={setSetId}
        />
      ) : null}
      {fileListError ? <ActionProblem problem={{ message: 'Couldn\'t load the file imports waiting for review.', next: 'Open this area again to retry.' }} /> : null}
      {setId && client ? (
        <ReviewSetDialog
          sync={sync}
          accounts={accounts}
          observationSetId={setId}
          onClose={() => setSetId(null)}
          onChanged={changed}
          onLedgerChanged={onLedgerChanged}
          commits={commits}
        />
      ) : null}
      {runId && client ? <RunDialog sync={sync} runId={runId} onClose={() => setRunId(null)} /> : null}
    </div>
  );
}

function SyncHeader({ sync, onOpenDevices }: { sync: OwnerSync; onOpenDevices: () => void }) {
  const actions = useOwnerActions();
  const status = useActionStatus();
  const state = sync.state as OwnerState;
  const pause = () => status.track(async () => {
    await actions.run(() => sync.client!.pause());
    await sync.refresh();
  });
  return (
    <section className="spending-panel sync-header" aria-label="Sync controls">
      <div className="sync-header-row">
        <div className="sync-header-text">
          <p className="sync-text">Checked {pastTime(state.generatedAt, sync.now())} on Holdr&apos;s clock.</p>
          <p className="sync-text" data-testid="awaiting-count">
            {state.queue.open > 0 ? `${plural(state.queue.open, 'import')} awaiting review, not in spending yet.` : 'Nothing is awaiting review.'}
          </p>
        </div>
        <div className="spending-detail-actions">
          <button type="button" className="spending-button" onClick={() => { void sync.refresh(); }}>Refresh</button>
          {state.settings.paused
            ? <button type="button" className="spending-button" onClick={onOpenDevices}>Resume in Extension &amp; devices</button>
            : <button type="button" className="spending-button danger" disabled={status.busy} onClick={() => { void pause(); }}>Pause all syncing</button>}
        </div>
      </div>
      <ActionProblem problem={status.problem} />
    </section>
  );
}

function BindingStatusList(props: {
  state: OwnerState;
  now: number;
  accounts: readonly CardAccount[];
  onReview: (observationSetId: string) => void;
  onOpenDevices: () => void;
  onImport?: () => void;
}) {
  const { state, now } = props;
  const bindings = state.bindings.filter((binding) => binding.status !== 'retired');
  const headingId = useId();
  return (
    <section className="spending-panel" aria-labelledby={headingId}>
      <header className="spending-panel-head">
        <h3 id={headingId}>Connected cards</h3>
      </header>
      <p className="spending-muted">What Holdr last received from each card. Green never means all history is here.</p>
      {bindings.length === 0 ? (
        <div className="sync-empty">
          <p className="sync-text"><strong>Not set up.</strong> No card is connected to the extension yet.</p>
          <p className="spending-muted">To set it up, in Extension &amp; devices:</p>
          <ol className="sync-lines numbered" data-testid="setup-steps">
            <li>Turn the bank on.</li>
            <li>Confirm which cards are on the card account.</li>
            <li>Pair a browser and approve it.</li>
          </ol>
          <p className="spending-muted">Until then, card spending from offline files keeps working.</p>
          <div className="spending-detail-actions">
            <button type="button" className="spending-button primary" onClick={props.onOpenDevices}>Set up in Extension &amp; devices</button>
            {props.onImport ? <button type="button" className="spending-button" onClick={props.onImport}>Import a statement</button> : null}
          </div>
        </div>
      ) : (
        <ul className="sync-list">
          {bindings.map((binding) => (
            <BindingStatusCard
              key={binding.bindingId}
              binding={binding}
              status={bindingStatus(binding, state, now)}
              state={state}
              now={now}
              accounts={props.accounts}
              onReview={props.onReview}
              onOpenDevices={props.onOpenDevices}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One connected card, in the order the owner needs it: when Holdr last received something for it, then the one next
 * step (with the button that takes it), then its status and the short lines behind it. Attempts, plans, browsers and
 * what the last import covered are folded under Details.
 */
function BindingStatusCard(props: {
  binding: Binding;
  status: BindingStatus;
  state: OwnerState;
  now: number;
  accounts: readonly CardAccount[];
  onReview: (observationSetId: string) => void;
  onOpenDevices: () => void;
}) {
  const { binding, status, state, now } = props;
  const run = binding.sync.lastRun;
  const label = status.stopped ? ABORT_TEXT[status.stopped].label : STATUS_TEXT[status.primary].label;
  const guidance = cardGuidance(status);
  // Reviewing is open whenever a set waits, even while paused or without a working device.
  const reviewSet = run?.observationSetId && OPEN_SET_STATES.includes(run.acceptance as SetSummary['state']) ? run.observationSetId : null;
  const openDevices = status.primary === 'paused' || status.primary === 'not-set-up' || status.primary === 'no-device' || status.primary === 'regrant-needed';
  const devices = binding.deviceIds.map((deviceId) => deviceText(state, deviceId));
  return (
    <li className={`sync-binding tone-${status.tone}`} data-binding={binding.issuer}>
      <div className="sync-binding-head">
        <h4 className="sync-card-name">{bindingTitle(binding)}</h4>
        <span className="spending-muted">{cardAccountText(props.accounts, binding.cardAccountRef)}</span>
      </div>
      <p className="sync-lead sync-received" data-testid="last-received">{lastReceivedText(binding.sync.lastAcceptedAt, now)}</p>
      <div className="sync-next-row">
        <p className="sync-lead" data-testid="next-step"><span className="sync-next-label">Next:</span> {guidance.next}</p>
        {reviewSet || openDevices ? (
          <div className="spending-detail-actions">
            {reviewSet ? <button type="button" className="spending-button primary" onClick={() => props.onReview(reviewSet)}>Review</button> : null}
            {openDevices ? <button type="button" className="spending-button" onClick={props.onOpenDevices}>Open Extension &amp; devices</button> : null}
          </div>
        ) : null}
      </div>
      <div className="sync-chips">
        <span className={`sync-status tone-${status.tone}`} data-status={status.primary}>{label}</span>
        {status.flags.map((flag) => <span key={flag} className="sync-flag" data-flag={flag}>{FLAG_TEXT[flag].label}</span>)}
        {status.reviewExpiresAt && (status.reviewExpiry === 'week' || status.reviewExpiry === 'day') ? (
          <span className={`sync-flag ${status.reviewExpiry === 'day' ? 'tone-error' : 'tone-warn'}`}>
            Review expires {relativeTime(status.reviewExpiresAt, now)}
          </span>
        ) : null}
      </div>
      {guidance.more.length > 0 ? (
        <ul className="sync-lines" data-testid="card-lines">
          {guidance.more.map((line, index) => <li key={index}>{line}</li>)}
        </ul>
      ) : null}
      <Disclosure className="sync-details" summary="Details: attempts, plans, browsers and coverage">
        <dl className="spending-detail-fields sync-facts">
          <dt>Last attempt</dt>
          <dd>{run ? `${exactTime(run.createdAt)} (${pastTime(run.createdAt, now)})` : NOT_ON_RECORD}</dd>
          <dt>Last plan applied</dt>
          <dd>{binding.sync.lastCommittedAt ? exactTime(binding.sync.lastCommittedAt) : NOT_ON_RECORD}</dd>
          <dt>Browsers</dt>
          <dd>{devices.length > 0 ? devices.join(', ') : 'None working'}</dd>
        </dl>
        {binding.sync.coverage.length > 0 ? (
          <div className="sync-coverage">
            <span className="spending-muted">What the last import covered (Holdr&apos;s check)</span>
            <ul>
              {binding.sync.coverage.map((entry) => (
                <li key={`${entry.cardScopeId} ${entry.status}`}>
                  <span>{scopeTextById(state, entry.cardScopeId)} · {entry.status}</span>
                  <span>{entry.observed ? `seen ${dateRangeLabel(entry.observed.start, entry.observed.end)}` : 'no rows'}</span>
                  <span className={`sync-completeness ${entry.completeness}`}>
                    {entry.completeness === 'complete' ? 'read to the end; check against the statement' : entry.completeness === 'partial' ? 'partial' : 'completeness unknown'}
                  </span>
                  <span className="spending-muted">{TERMINATION_TEXT[entry.termination]}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="spending-muted">No coverage on record for this card.</p>
        )}
      </Disclosure>
    </li>
  );
}

function MoreButton({ list, label }: { list: PagedList<unknown>; label: string }) {
  if (!list.hasMore) return null;
  return (
    <button type="button" className="spending-button sync-more" disabled={list.loadingMore} onClick={list.loadMore}>
      {list.loadingMore ? 'Loading…' : label}
    </button>
  );
}

function ReviewQueue(props: {
  /** Null where Holdr has no sync state to give (the extension's device API is off): only file imports' sets are listed. */
  state: OwnerState | null;
  now: number;
  accounts: readonly CardAccount[];
  open: PagedList<SetSummary>;
  closed: PagedList<SetSummary>;
  showClosed: boolean;
  onShowClosed: (show: boolean) => void;
  onOpen: (observationSetId: string) => void;
}) {
  const { state, now, accounts } = props;
  const open = props.open.items;
  const closed = props.closed.items;
  const headingId = useId();
  // One rule or instruction per line (readability plan, item H).
  const lines = state
    ? [
      'Nothing here is in spending until a plan for it is confirmed.',
      'Confirm plans here, or in the extension when nothing needs a decision.',
      `Holdr keeps each import ${plural(state.limits.retentionDays, 'day')} from receipt, then clears it.`,
    ]
    : [
      'Nothing here is in spending until you confirm a plan.',
      'Holdr keeps the rows that need a decision until the date each shows, then clears them.',
    ];
  return (
    <section className="spending-panel" aria-labelledby={headingId}>
      <header className="spending-panel-head">
        <h3 id={headingId}>Imports awaiting review{state ? ` (${state.queue.open})` : ''}</h3>
      </header>
      <ul className="sync-lines" data-testid="queue-lines">
        {lines.map((line) => <li key={line}>{line}</li>)}
      </ul>
      {open === null ? <p className="spending-muted">Loading…</p>
        : open.length === 0 ? <p className="spending-muted">Nothing is awaiting review.</p>
          : (
            <ul className="sync-list">
              {open.map((set) => <SetRow key={set.observationSetId} set={set} state={state} now={now} accounts={accounts} onOpen={props.onOpen} />)}
            </ul>
          )}
      <MoreButton list={props.open as PagedList<unknown>} label="Show more imports awaiting review" />
      <button type="button" className="spending-link" aria-expanded={props.showClosed} onClick={() => props.onShowClosed(!props.showClosed)}>
        {props.showClosed ? 'Hide closed reviews' : 'Show closed reviews'}
      </button>
      {props.showClosed ? (
        closed === null ? <p className="spending-muted">Loading…</p> : closed.length === 0 ? <p className="spending-muted">No closed reviews.</p> : (
          <>
            <ul className="sync-list" aria-label="Closed reviews">
              {closed.map((set) => <SetRow key={set.observationSetId} set={set} state={state} now={now} accounts={accounts} onOpen={props.onOpen} />)}
            </ul>
            <MoreButton list={props.closed as PagedList<unknown>} label="Show more closed reviews" />
          </>
        )
      ) : null}
    </section>
  );
}

function SetRow({ set, state, now, accounts, onOpen }: { set: SetSummary; state: OwnerState | null; now: number; accounts: readonly CardAccount[]; onOpen: (id: string) => void }) {
  const fromFile = set.sourceKind === 'file';
  const open = set.closeReason === null;
  const level = open ? expiryLevel(set.expiresAt, now) : null;
  const planExpired = open && set.plan !== null && set.plan.state !== 'committed' && (set.plan.state !== 'valid' || Date.parse(set.plan.expiresAt) <= now);
  return (
    <li className={`sync-row${level === 'day' ? ' tone-error' : level === 'week' ? ' tone-warn' : ''}`} data-set={set.observationSetId} data-source-kind={set.sourceKind}>
      <div className="sync-row-text">
        <strong>{setTitle(set, state, accounts)}</strong>
        <span className="spending-muted">
          {fromFile ? `Imported ${exactTime(set.acceptedAt)} · ${plural(set.rowCount, 'row')} that need a decision` : `Received ${exactTime(set.acceptedAt)} · ${plural(set.rowCount, 'row')} · ${bytesText(set.byteCount)}`}
          {open && set.reviewCount > 0 ? ` · ${plural(set.reviewCount, 'item')} to decide` : ''}
        </span>
        <div className="sync-chips">
          {fromFile ? <span className="sync-flag">From a file import, not the extension</span> : null}
          {set.categories.map((entry) => <span key={entry.category} className="sync-flag">{CATEGORY_TEXT[entry.category].label}: {entry.count}</span>)}
          {set.state === 'blocked-review' ? <span className="sync-flag tone-warn">Its browser was revoked or its card connection changed: check the source</span> : null}
          {set.state === 'recovery-review' ? <span className="sync-flag tone-warn">From before a restore: check the source</span> : null}
          {planExpired ? <span className="sync-flag tone-warn">Your plan expired: prepare a new one</span> : null}
        </div>
        {open ? (
          <span className={level === 'day' || level === 'week' ? 'sync-expiry warn' : 'spending-muted'}>
            Kept until {exactTime(set.expiresAt)} ({relativeTime(set.expiresAt, now)}){level === 'day' ? ': less than a day left' : level === 'week' ? ': less than a week left' : ''}
          </span>
        ) : (
          <span className="spending-muted">
            {set.closeReason === 'committed' ? `Plan applied ${set.committedAt ? exactTime(set.committedAt) : ''}`
              : set.closeReason === 'discarded' ? `Discarded ${set.closedAt ? exactTime(set.closedAt) : ''}; nothing was added`
                : 'Expired without review; nothing was added. Capture again or import the offline file.'}
          </span>
        )}
      </div>
      {open || set.closeReason === 'committed' ? (
        <button type="button" className="spending-button" onClick={() => onOpen(set.observationSetId)}>
          {open ? 'Review' : 'Open'}
        </button>
      ) : null}
    </li>
  );
}

function RunList({ state, now, runs: list, onOpen }: { state: OwnerState; now: number; runs: PagedList<RunSummary>; onOpen: (runId: string) => void }) {
  const runs = list.items;
  const headingId = useId();
  return (
    <section className="spending-panel" aria-labelledby={headingId}>
      <header className="spending-panel-head">
        <h3 id={headingId}>Recent runs</h3>
      </header>
      <ul className="sync-lines">
        <li>Each time a browser started sending.</li>
        <li>The exact object sent stays viewable for {plural(state.limits.receiptDays, 'day')}.</li>
      </ul>
      {runs === null ? <p className="spending-muted">Loading…</p> : runs.length === 0 ? <p className="spending-muted">No runs yet.</p> : (
        <ul className="sync-list">
          {runs.map((run) => (
            <li key={run.runId} className="sync-row" data-run={run.runId}>
              <div className="sync-row-text">
                <strong>{exactTime(run.createdAt)} · {state.bindings.find((item) => item.bindingId === run.bindingId)?.bindingLabel ?? NO_LONGER_LISTED}</strong>
                <span className="spending-muted">
                  {run.deviceLabel} · {run.trigger === 'auto' ? 'automatic' : 'sent by hand'} · {runOutcome(run, now)}
                </span>
                {run.errorCode ? <span className="sync-expiry warn">{RUN_ERROR_TEXT[run.errorCode]}</span> : null}
                {run.abortReason ? (
                  <span className={run.abortReason === 'user-cancelled' ? 'spending-muted' : 'sync-expiry warn'}>{ABORT_TEXT[run.abortReason].label}</span>
                ) : null}
              </div>
              <button type="button" className="spending-button" onClick={() => onOpen(run.runId)}>Details</button>
            </li>
          ))}
        </ul>
      )}
      <MoreButton list={list as PagedList<unknown>} label="Show more runs" />
    </section>
  );
}

/** A run as one phrase, from its own state first (Q36), then what became of what it sent. */
export function runOutcome(run: Pick<RunSummary, 'acceptance' | 'ledger' | 'runState' | 'runExpiresAt'>, now: number): string {
  switch (run.runState) {
    case 'refused':
      return 'refused by Holdr; nothing kept';
    case 'aborted':
      return 'stopped by the extension; nothing received';
    case 'expired':
      return 'closed; nothing received';
    case 'open':
      return Date.parse(run.runExpiresAt) > now ? 'started, nothing received yet' : 'closed; nothing received';
    default:
      break;
  }
  if (run.ledger === 'committed') return 'received; its plan was applied';
  if (run.acceptance === 'expired-unreviewed') return 'received, expired without review';
  if (run.acceptance === 'rejected') return 'received, discarded';
  return 'received, waiting for review';
}
