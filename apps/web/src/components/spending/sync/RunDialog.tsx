import { useEffect, useState } from 'react';
import { canonicalJson, type JsonValue } from '@finance-tracker/shared';
import { dateRangeLabel } from '../spendingFormat';
import { ActionProblem, useActionStatus } from './OwnerActions';
import type { RunDetail, SentPayload } from './ownerApi';
import { SyncDialog } from './SyncDialog';
import { NO_LONGER_LISTED, bindingById, bindingTitle, plural, scopeTextById } from './syncFormat';
import { exactTime, relativeTime } from './syncStatus';
import { ABORT_TEXT, errorText, RUN_ERROR_TEXT, runRowsNote, TERMINATION_TEXT } from './syncText';
import { runOutcome } from './SyncArea';
import type { OwnerSync } from './useOwnerSync';

const RESULT_LABELS: Record<RunDetail['results'][number]['result'], string> = {
  inserted: 'added',
  updated: 'updated',
  unchanged: 'already in spending',
  matched: 'counted once with an existing transaction',
  attributed: 'put on a card and linked',
  'needs-review': 'waiting for your decision',
  rejected: 'not added',
  waiting: 'waiting for the plan',
};

/**
 * One run, after it was sent (plan §8 「发送后可检查」): received and added to
 * spending as two separate facts, each row's result, why Holdr refused it if
 * it did, the payload digest, and for 7 days the exact object that was sent,
 * shown only when its bytes hash to that digest.
 */
export function RunDialog({ sync, runId, onClose }: { sync: OwnerSync; runId: string; onClose: () => void }) {
  const client = sync.client!;
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [problem, setProblem] = useState<{ message: string; next: string } | null>(null);
  const [sent, setSent] = useState<SentPayload | null>(null);
  const status = useActionStatus();
  const now = sync.now();

  useEffect(() => {
    let cancelled = false;
    client.getRun(runId)
      .then((value) => { if (!cancelled) setDetail(value); })
      .catch((error: unknown) => { if (!cancelled) setProblem(errorText(error)); });
    return () => { cancelled = true; };
  }, [client, runId]);

  const showSent = () => status.track(async () => setSent(await client.getSentPayload(runId)));
  const binding = detail ? bindingById(sync.state, detail.bindingId) : null;
  const counts = detail ? detail.results.reduce((map, entry) => map.set(entry.result, (map.get(entry.result) ?? 0) + 1), new Map<string, number>()) : null;

  return (
    <SyncDialog title={detail ? `Run of ${exactTime(detail.createdAt)}` : 'Run'} onClose={onClose} busy={status.busy} wide closeLabel="Close run">
      <ActionProblem problem={problem} />
      {!detail ? (problem ? null : <p className="spending-muted">Loading…</p>) : (
        <>
          <dl className="spending-detail-fields">
            <dt>Card</dt>
            <dd>{binding ? bindingTitle(binding) : NO_LONGER_LISTED} (version {detail.bindingVersion})</dd>
            <dt>Browser</dt>
            <dd>{detail.deviceLabel} · {detail.trigger === 'auto' ? 'automatic' : 'sent by hand'} · {detail.adapterVersion} · contract {detail.contractVersion}</dd>
            <dt>Outcome</dt>
            <dd>{runOutcome(detail, now)}</dd>
            <dt>Received by Holdr</dt>
            <dd>{detail.acceptedAt ? exactTime(detail.acceptedAt) : 'No'}</dd>
            <dt>Plan applied</dt>
            <dd>{detail.committedAt ? exactTime(detail.committedAt) : 'No'}</dd>
            {detail.rowCount !== null ? (<><dt>Rows</dt><dd>{detail.rowCount}{detail.rejectedCount ? `; the extension dropped ${plural(detail.rejectedCount, 'invalid row')}` : ''}</dd></>) : null}
            {detail.payloadDigest ? (<><dt>Payload digest</dt><dd className="sync-mono">{detail.payloadDigest}</dd></>) : null}
            {detail.observationExpiresAt && detail.ledger !== 'committed' ? (
              <><dt>Review record kept until</dt><dd>{exactTime(detail.observationExpiresAt)} ({relativeTime(detail.observationExpiresAt, now)})</dd></>
            ) : null}
          </dl>
          {detail.errorCode ? <p className="sync-expiry warn" role="status">{RUN_ERROR_TEXT[detail.errorCode]}</p> : null}
          {detail.runState === 'aborted' && detail.abortReason ? (
            <div className="sync-group" data-testid="run-stopped">
              <p className={detail.abortReason === 'user-cancelled' ? 'sync-text' : 'sync-expiry warn'}>{ABORT_TEXT[detail.abortReason].label}</p>
              <p className="sync-text"><span className="sync-next-label">Next:</span> {ABORT_TEXT[detail.abortReason].next}</p>
              <ul className="sync-lines">
                {ABORT_TEXT[detail.abortReason].more.map((line) => <li key={line}>{line}</li>)}
              </ul>
            </div>
          ) : null}
          {detail.runState === 'expired' ? (
            <p className="sync-text" data-testid="run-closed">
              Holdr closed this run without receiving anything: its 10 minutes passed, or its browser was revoked. What happened in the browser is only
              in the extension popup; nothing here was added.
            </p>
          ) : detail.runState === 'open' ? (
            <p className="sync-text">Holdr has nothing from this run yet. What happens before sending is only in the extension popup; nothing here was added.</p>
          ) : null}

          {detail.coverage.length > 0 ? (
            <section className="sync-group" aria-label="Coverage of this run">
              <h4>What this run covered</h4>
              <ul className="sync-coverage-list">
                {detail.coverage.map((entry) => (
                  <li key={`${entry.cardScopeId} ${entry.status}`}>
                    {scopeTextById(sync.state, entry.cardScopeId)} · {entry.status}:{' '}
                    {entry.observed ? `seen ${dateRangeLabel(entry.observed.start, entry.observed.end)}` : 'no rows'}
                    {entry.requested ? `; asked for ${dateRangeLabel(entry.requested.start, entry.requested.end)}` : ''}
                    {' · '}{entry.completeness === 'complete' ? 'read to the end' : entry.completeness} · {TERMINATION_TEXT[entry.termination]}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {counts && counts.size > 0 ? (
            <section className="sync-group" aria-label="Row results">
              <h4>Each row</h4>
              <p className="sync-text">{[...counts.entries()].map(([result, count]) => `${count} ${RESULT_LABELS[result as keyof typeof RESULT_LABELS]}`).join(' · ')}</p>
              <ol className="sync-results">
                {detail.results.map((entry) => (
                  <li key={entry.rowIndex}>Row {entry.rowIndex + 1}: {RESULT_LABELS[entry.result]}</li>
                ))}
              </ol>
            </section>
          ) : runRowsNote(detail) ? (
            <p className="sync-text" data-testid="run-rows">{runRowsNote(detail)}</p>
          ) : null}

          <section className="sync-group" aria-label="Exact sent object">
            <h4>The exact object that was sent</h4>
            {detail.receiptAvailable && detail.receiptExpiresAt ? (
              <>
                <p className="sync-text">
                  Kept for {sync.state?.limits.receiptDays ?? 7} days after receipt, until {exactTime(detail.receiptExpiresAt)}. It is shown only if its bytes match the digest above.
                </p>
                {!sent ? (
                  <button type="button" className="spending-button" disabled={status.busy} onClick={() => { void showSent(); }}>Show the exact object sent</button>
                ) : (
                  <>
                    <p className="sync-done" role="status">Digest checked: these are the bytes Holdr received.</p>
                    <div className="sync-json" role="region" aria-label="Exact sent object (JSON)" tabIndex={0}>
                      <pre>{canonicalJson(sent.payload as unknown as JsonValue)}</pre>
                    </div>
                  </>
                )}
              </>
            ) : detail.acceptance === 'none' ? (
              <p className="sync-text">Nothing was received for this run.</p>
            ) : (
              <p className="sync-text" data-testid="receipt-cleared">
                The exact sent object was cleared {detail.acceptance === 'rejected' ? 'when the import was discarded' : `after ${sync.state?.limits.receiptDays ?? 7} days`}.{' '}
                {detail.ledger === 'committed'
                  ? 'What its plan added or changed stays in your card transactions, with where it came from.'
                  : detail.contentRetained && detail.observationExpiresAt
                    ? `The review record is still kept until ${exactTime(detail.observationExpiresAt)}.`
                    : 'Nothing from it was added.'}
                {' '}It is never rebuilt from today&apos;s data.
              </p>
            )}
            <ActionProblem problem={status.problem} />
          </section>
        </>
      )}
    </SyncDialog>
  );
}
