import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CardTransactionView } from '@finance-tracker/shared';
import { fetchCardTransactions } from '../spendingApi';
import { formatRowAmount, longDate } from '../spendingFormat';
import { ActionCancelled, useOwnerActions } from './OwnerActions';
import type { LedgerEvent, LedgerRow, SourceIdentity, TransactionSources } from './ownerApi';
import { isOwnerApiError, isUnknownOutcome, type SourcesList } from './ownerClient';
import { SyncDialog } from './SyncDialog';
import { REMOVED_TEXT, eventText, identityText, separateText, valuesText } from './ledgerText';
import { errorText, type ErrorText } from './syncText';
import { mergeById } from './usePagedList';
import type { OwnerSync } from './useOwnerSync';

interface Props {
  sync: OwnerSync;
  transactionId: string;
  onClose: () => void;
  /** A repair changed the ledger: Spending's figures and lists are read again. */
  onLedgerChanged: () => void;
}

const DAY = 86_400_000;
/** How far either side of the charge's date "Move to another charge…" looks for the charge a source belongs to. */
const MOVE_WINDOW_DAYS = 31;
const MOVE_PAGE = 100;

/** The charge chosen from Spending's list changed before the move was sent: nothing was written. */
class TargetChanged extends Error {
  constructor() {
    super('target changed');
    this.name = 'TargetChanged';
  }
}

/** What a failed repair means here; a refusal because the charge moved on says so rather than "not allowed". */
function repairProblem(error: unknown): ErrorText {
  if (error instanceof TargetChanged) {
    return { message: 'That charge changed since the list was read.', next: 'Nothing was moved. Choose it again from the list, which is read again now.' };
  }
  if (isOwnerApiError(error, 'action-not-allowed')) {
    return { message: 'Holdr doesn\'t allow that change now.', next: 'The charge may have changed since it was shown; the latest is shown now.' };
  }
  // Holdr never deletes a charge (a removed or merged one keeps its row): what's shown is older than Holdr's data.
  if (isOwnerApiError(error, 'transaction-not-found')) {
    return { message: 'Holdr has no such charge.', next: 'Nothing was changed. Close this and reload Spending to see the charges Holdr has now.' };
  }
  if (isOwnerApiError(error, 'not-found')) {
    return {
      message: 'Holdr has no sources or history for this charge.',
      next: 'What\'s shown may be out of date, or this Holdr may not offer repairs yet. Close this and reload Spending.',
    };
  }
  return errorText(error);
}

function shiftDay(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY).toISOString().slice(0, 10);
}

const NO_CURSORS: Record<SourcesList, string | null> = { identities: null, merged: null, events: null };

/** After a repair Holdr refused or may have made, until a fresh read of the charge is on screen (Astra round 12). */
const STALE_NEXT = 'What\'s shown may be out of date, so repairs stay off until the latest is read from Holdr.';

/** `current` followed by the items of `more` it doesn't have yet (pages are keyset: nothing shifts, but a reread may repeat). */
function appendNew<T>(current: T[], more: T[], key: (item: T) => string): T[] {
  const known = new Set(current.map(key));
  return [...current, ...more.filter((item) => !known.has(key(item)))];
}

/** Spending's charges newest first, as its own list shows them. */
function newestFirst(items: CardTransactionView[]): CardTransactionView[] {
  return [...items].sort((a, b) => b.transactionDate.localeCompare(a.transactionDate) || a.id.localeCompare(b.id));
}

/**
 * Proposal §3.8 (X29): where one charge came from and what happened to it, with the owner's permanent repairs. Each alias
 * can be detached or moved to the charge it really belongs to (never the last one); a row merged into this one can be
 * separated again; and the latest change the owner decided can be undone. Each repair asks first, needs the password, and
 * reads Spending's figures again afterwards. Plain text only.
 */
export function SourcesDialog({ sync, transactionId, onClose, onLedgerChanged }: Props) {
  const actions = useOwnerActions();
  const client = sync.client!;
  const state = sync.state;
  const [shownId, setShownId] = useState(transactionId);
  /** The latest answer: the charge itself and the change that can be undone, as they are now. */
  const [sources, setSources] = useState<TransactionSources | null>(null);
  // Each list as read so far, and the cursor of its next page (§3.8: 500 aliases, 100 merged rows, 100 events a page).
  const [identities, setIdentities] = useState<SourceIdentity[]>([]);
  const [mergedRows, setMergedRows] = useState<LedgerRow[]>([]);
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [cursors, setCursors] = useState<Record<SourcesList, string | null>>(NO_CURSORS);
  const [loadProblem, setLoadProblem] = useState<ErrorText | null>(null);
  const [loadingMore, setLoadingMore] = useState<SourcesList | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * The answer on screen may be older than the ledger: a repair was refused, or its answer never came, or its own answer was
   * about another charge. Only a read that lands clears it; until then no repair or older page can start from it.
   */
  const [stale, setStale] = useState(false);
  const [problem, setProblem] = useState<ErrorText | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [moving, setMoving] = useState<SourceIdentity | null>(null);
  /** Read the move list again (the chosen charge changed under it). */
  const [moveAttempt, setMoveAttempt] = useState(0);
  // Every read and write takes a number; an answer lands only if nothing started after it.
  const sequence = useRef(0);
  const shownRef = useRef(shownId);
  shownRef.current = shownId;

  const show = useCallback((answer: TransactionSources) => {
    setSources(answer);
    setIdentities(answer.identities);
    setMergedRows(answer.mergedRows);
    setEvents(answer.events);
    setCursors({ identities: answer.nextIdentitiesCursor, merged: answer.nextMergedRowsCursor, events: answer.nextEventsCursor });
    setStale(false);
  }, []);

  /** The charge's first pages, read again: the answer once it is on screen, or null (a failed read leaves the earlier one, and says so). */
  const load = useCallback(async (): Promise<TransactionSources | null> => {
    const seq = ++sequence.current;
    const id = shownRef.current;
    setLoadProblem(null);
    try {
      const answer = await client.getTransactionSources(id);
      if (seq === sequence.current && shownRef.current === id) {
        show(answer);
        return answer;
      }
    } catch (error) {
      if (seq === sequence.current) setLoadProblem(repairProblem(error));
    }
    return null;
  }, [client, show]);

  useEffect(() => {
    setSources(null);
    setIdentities([]);
    setMergedRows([]);
    setEvents([]);
    setCursors(NO_CURSORS);
    setMoving(null);
    setStale(false);
    void load();
  }, [shownId, load]);

  /** The next page of one list; the charge and what can be undone come as they are now, the other lists stay as read. */
  const showMore = async (list: SourcesList) => {
    const cursor = cursors[list];
    // Never while a repair runs (its answer would be older than the repair's), nor onto an answer that may be out of date.
    if (cursor === null || loadingMore !== null || busy || stale) return;
    const seq = sequence.current;
    const id = shownId;
    setLoadingMore(list);
    try {
      const page = await client.getTransactionSources(id, { list, cursor });
      // A write or a fresh read since then has its own first pages; this one would mix two states.
      if (seq !== sequence.current || shownRef.current !== id) return;
      setSources(page);
      // Live lists (E1b revision 8, X39): a member served again on a later page (a row merged again) is shown once, as the
      // later page has it; the history's events never change. A walk is never taken as the exact list: each repair still
      // checks the latest first.
      if (list === 'events') {
        setEvents((current) => mergeById(current, page.events, (event) => event.eventId));
        setCursors((current) => ({ ...current, events: page.nextEventsCursor }));
      } else if (list === 'identities') {
        setIdentities((current) => mergeById(current, page.identities, (identity) => identity.identityId));
        setCursors((current) => ({ ...current, identities: page.nextIdentitiesCursor }));
      } else {
        setMergedRows((current) => mergeById(current, page.mergedRows, (merged) => merged.transactionId));
        setCursors((current) => ({ ...current, merged: page.nextMergedRowsCursor }));
      }
    } catch (error) {
      if (seq === sequence.current) setLoadProblem(repairProblem(error));
    } finally {
      setLoadingMore(null);
    }
  };

  /**
   * One repair: asks first, then runs it (the password is asked for when Holdr wants it). Its answer is shown when it is
   * the charge on show; otherwise the charge is read again. A refusal because something moved on shows the latest, and an
   * answer that never came is never called a failure: Holdr is read again, and Spending too. Until a read lands after it,
   * what's on screen counts as out of date: no repair starts from it, and nothing claims the latest is shown. No read
   * started before or during the write can land after it.
   */
  const repair = async (confirm: { title: string; body: string; confirmLabel: string }, work: () => Promise<TransactionSources>, success: string) => {
    if (busy || stale) return;
    // The source being moved, when this repair is a move.
    const movingId = moving?.identityId ?? null;
    setProblem(null);
    setDone(null);
    if (!(await actions.confirm({ ...confirm, danger: true }))) return;
    setBusy(true);
    const seq = ++sequence.current;
    try {
      const answer = await actions.run(work);
      if (seq === sequence.current) {
        // Retires any read that started while the write ran: it may have seen the ledger before it.
        sequence.current += 1;
        setMoving(null);
        setDone(success);
        if (answer.transaction.transactionId === shownRef.current) {
          show(answer);
        } else {
          setStale(true);
          await load();
        }
      }
      onLedgerChanged();
    } catch (error) {
      if (error instanceof ActionCancelled) return;
      if (error instanceof TargetChanged) {
        setProblem(repairProblem(error));
        setMoveAttempt((value) => value + 1);
        return;
      }
      // What's shown is no longer the ledger (refused), or may not be (no answer): it is read again before anything else.
      setStale(true);
      if (isUnknownOutcome(error)) {
        // Never "failed": Holdr may have made the change before its answer was lost.
        setProblem({ message: 'Holdr didn\'t confirm whether the change was made.', next: 'The latest is shown now: check it before trying again.' });
        onLedgerChanged();
      } else {
        setProblem(repairProblem(error));
      }
      const latest = await load();
      // A move goes on only while its source still counts here (another charge can be chosen); otherwise back to the charge.
      if (!latest || !latest.identities.some((identity) => identity.identityId === movingId && identity.status === 'active')) setMoving(null);
    } finally {
      setBusy(false);
    }
  };

  const row = sources?.transaction ?? null;
  const locked = busy || stale;
  const active = identities.filter((identity) => identity.status === 'active');
  // A charge keeps one source: detaching or moving one needs another known to stay. A further page may hold only detached ones.
  const canRelease = active.length >= 2;
  const moreSources = cursors.identities !== null;
  const revertible = sources?.revertibleEventId ? events.find((event) => event.eventId === sources.revertibleEventId) ?? null : null;

  const detach = (identity: SourceIdentity) => {
    if (!row) return;
    void repair({
      title: 'Detach this source?',
      body: 'Holdr stops counting this source under this charge. The charge stays as it is, with its other sources. If the bank sends this '
        + 'source again, Holdr asks you where it belongs instead of adding it by itself.',
      confirmLabel: 'Detach',
    }, () => client.detachIdentity(identity.identityId, { transactionId: row.transactionId, expectedRevision: row.revision }), 'The source was detached.');
  };

  const undo = () => {
    if (!row || !sources?.revertibleEventId) return;
    const eventId = sources.revertibleEventId;
    const before = revertible?.from;
    const back = before
      ? [before.status, before.amountMinor === null ? null : formatRowAmount(before.amountMinor, 'USD')].filter(Boolean).join(', ')
      : null;
    void repair({
      title: 'Undo this change?',
      body: `This charge goes back to exactly how it was before ${revertible ? `"${eventText(revertible, state).title}"` : 'its latest change'}`
        + `${back ? ` (${back})` : ''}. Your category and notes stay. Only this change is undone; an earlier one can be undone after it.`,
      confirmLabel: 'Undo the change',
    }, () => client.revertChange(row.transactionId, { eventId, expectedRevision: row.revision }), 'The change was undone.');
  };

  const separate = (merged: LedgerRow, survivorRevision: number | null) => {
    void repair({
      title: 'Separate this charge again?',
      body: separateText(merged),
      confirmLabel: 'Separate',
    }, async () => {
      // On the merged row itself, the survivor's revision comes from a fresh read of it.
      const expectedSurvivorRevision = survivorRevision ?? (await client.getTransactionSources(merged.mergedIntoId as string)).transaction.revision;
      return client.unmergeTransaction(merged.transactionId, { expectedRevision: merged.revision, expectedSurvivorRevision });
    }, 'It is a charge of its own again.');
  };

  const move = (identity: SourceIdentity, target: CardTransactionView) => {
    if (!row) return;
    const targetText = `${longDate(target.transactionDate)} · ${target.description} · ${formatRowAmount(target.amountMinor, target.currency)}`;
    void repair({
      title: 'Move this source to another charge?',
      body: `From now on Holdr counts what this source sends under ${targetText}. This charge keeps its other sources, and neither charge's amounts change.`,
      confirmLabel: 'Move',
    }, async () => {
      const current = await client.getTransactionSources(target.id);
      // The owner chose it from Spending's list, and the confirmation named it: if anything shown changed since, they choose again.
      const values = current.transaction.values;
      if (values.amountMinor !== target.amountMinor || values.status !== target.status || values.transactionDate !== target.transactionDate
        || values.description !== target.description) {
        throw new TargetChanged();
      }
      return client.repointIdentity(identity.identityId, {
        fromTransactionId: row.transactionId,
        expectedRevision: row.revision,
        toTransactionId: target.id,
        expectedToRevision: current.transaction.revision,
      });
    }, `The source now counts under ${targetText}.`);
  };

  const title = row ? `Sources and history: ${row.values.description}` : 'Sources and history';
  return (
    <SyncDialog title={title} onClose={onClose} busy={busy} wide closeLabel="Close sources and history">
      {loadProblem ? (
        <div className="spending-error" role="alert">
          <strong>{loadProblem.message}</strong> {loadProblem.next}{' '}
          <button type="button" className="spending-link inline" disabled={busy} onClick={() => { void load(); }}>Try again</button>
        </div>
      ) : null}
      {!sources || !row ? (loadProblem ? null : <p className="spending-muted">Loading…</p>) : moving ? (
        <MovePanel
          key={`${moving.identityId}/${moveAttempt}`}
          row={row}
          alias={moving}
          busy={locked}
          onCancel={() => setMoving(null)}
          onMove={(target) => move(moving, target)}
        />
      ) : (
        <>
          <p className="sync-text">{valuesText(row.values, state)}</p>
          {row.mergedIntoId ? (
            <div className="sync-approval" role="note">
              <p className="sync-text">This charge was {REMOVED_TEXT[row.removedReason ?? 'superseded']}, so it doesn&apos;t count on its own.</p>
              <div className="spending-detail-actions">
                <button type="button" className="spending-button" disabled={locked} onClick={() => separate(row, null)}>Separate again…</button>
                <button type="button" className="spending-button ghost" disabled={busy} onClick={() => setShownId(row.mergedIntoId as string)}>
                  Open the charge it was merged into
                </button>
              </div>
            </div>
          ) : row.values.status === 'removed' && row.removedReason ? (
            <p className="sync-expiry warn">Removed: {REMOVED_TEXT[row.removedReason]}. It doesn&apos;t count in spending.</p>
          ) : null}

          <section className="sync-group" aria-label="Where it came from">
            <h4 className="sync-subhead">Where it came from</h4>
            <p className="spending-muted">
              Each source is how an offline file or the extension names this charge. Whatever a source sends again counts under the charge
              it points at.
            </p>
            <ul className="sync-list">
              {identities.map((identity) => {
                const text = identityText(identity, state);
                const live = identity.status === 'active';
                return (
                  <li key={identity.identityId} className={`sync-row${live ? '' : ' inactive'}`} data-identity={identity.identityId}>
                    <div className="sync-row-text">
                      <strong>{text.title}</strong>
                      <span className="spending-muted">{text.detail}</span>
                      {live ? null : (
                        <span className="sync-flag">Detached: no longer counted here. If the bank sends it again, Holdr asks you where it belongs.</span>
                      )}
                    </div>
                    {live ? (
                      <div className="spending-detail-actions">
                        <button type="button" className="spending-button" disabled={locked || !canRelease} onClick={() => detach(identity)}>Detach…</button>
                        <button
                          type="button"
                          className="spending-button"
                          disabled={locked || !canRelease}
                          onClick={() => { setProblem(null); setDone(null); setMoving(identity); }}
                        >
                          Move to another charge…
                        </button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <MoreButton list="identities" label="Show more sources" loading={loadingMore} busy={locked} cursor={cursors.identities} onMore={showMore} />
            {active.length === 1 && !moreSources ? (
              <p className="spending-muted">A charge keeps at least one source, so its only one can&apos;t be detached or moved.</p>
            ) : active.length === 1 ? (
              <p className="spending-muted">
                Only one source read so far still counts here, and a charge keeps at least one: show more sources to find another before
                detaching or moving it.
              </p>
            ) : null}
          </section>

          {mergedRows.length > 0 ? (
            <section className="sync-group" aria-label="Merged into this charge">
              <h4 className="sync-subhead">Merged into this charge</h4>
              <ul className="sync-list">
                {mergedRows.map((merged) => (
                  <li key={merged.transactionId} className="sync-row" data-merged={merged.transactionId}>
                    <div className="sync-row-text">
                      <strong>{merged.values.description}</strong>
                      <span className="spending-muted">
                        {longDate(merged.values.transactionDate)} · {formatRowAmount(merged.values.amountMinor, 'USD')} · {REMOVED_TEXT[merged.removedReason ?? 'superseded']}
                      </span>
                    </div>
                    <div className="spending-detail-actions">
                      <button type="button" className="spending-button" disabled={locked} onClick={() => separate(merged, row.revision)}>Separate again…</button>
                      <button type="button" className="spending-button ghost" disabled={busy} onClick={() => setShownId(merged.transactionId)}>Open</button>
                    </div>
                  </li>
                ))}
              </ul>
              <MoreButton list="merged" label="Show more merged charges" loading={loadingMore} busy={locked} cursor={cursors.merged} onMore={showMore} />
            </section>
          ) : null}

          {sources.revertibleEventId ? (
            <section className="sync-group" aria-label="Undo the latest change">
              <h4 className="sync-subhead">Undo the latest change</h4>
              <p className="sync-text">
                {revertible
                  ? `${eventText(revertible, state).title}: ${eventText(revertible, state).detail}.`
                  : 'The latest change a person decided on this charge can be undone.'}
              </p>
              <div className="spending-detail-actions">
                <button type="button" className="spending-button" disabled={locked} onClick={undo}>Undo this change…</button>
              </div>
            </section>
          ) : null}

          <section className="sync-group" aria-label="History">
            <h4 className="sync-subhead">History, newest first</h4>
            <ol className="sync-effects">
              {events.map((event) => {
                const text = eventText(event, state);
                return (
                  <li key={event.eventId} data-event={event.eventId}>
                    <strong>{text.title}{event.eventId === sources.revertibleEventId ? ' (can be undone)' : ''}</strong>
                    <span>{text.detail}</span>
                    {event.relatedTransactionId && event.relatedTransactionId !== row.transactionId ? (
                      <button
                        type="button"
                        className="spending-link inline"
                        disabled={busy}
                        onClick={() => setShownId(event.relatedTransactionId as string)}
                      >
                        Open the other charge
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ol>
            <MoreButton list="events" label="Show older changes" loading={loadingMore} busy={locked} cursor={cursors.events} onMore={showMore} />
          </section>
        </>
      )}
      {problem ? (
        <div className="spending-error" role="alert">
          <strong>{problem.message}</strong> {stale ? STALE_NEXT : problem.next}
        </div>
      ) : stale && sources ? <p className="sync-expiry warn" role="note">{STALE_NEXT}</p> : null}
      {done ? <p className="sync-done" role="status">{done}</p> : null}
    </SyncDialog>
  );
}

/** "Show more" for one paged list of a charge's sources: absent on its last page, off while any page or a repair is on its way. */
function MoreButton({ list, label, loading, busy, cursor, onMore }: {
  list: SourcesList;
  label: string;
  loading: SourcesList | null;
  busy: boolean;
  cursor: string | null;
  onMore: (list: SourcesList) => Promise<void>;
}) {
  if (cursor === null) return null;
  return (
    <button type="button" className="spending-link" disabled={loading !== null || busy} onClick={() => { void onMore(list); }}>
      {loading === list ? 'Loading…' : label}
    </button>
  );
}

type MoveOffsets = Record<'posted' | 'pending', number | null>;

/**
 * Choosing the charge a source really belongs to: live charges of the same card account within a month of this one, from
 * Spending's own list, page by page (Show more charges reaches every one). Holdr checks the rest (the same card, or none
 * recorded).
 */
function MovePanel({ row, alias, busy, onCancel, onMove }: {
  row: LedgerRow;
  alias: SourceIdentity;
  busy: boolean;
  onCancel: () => void;
  onMove: (target: CardTransactionView) => void;
}) {
  const [candidates, setCandidates] = useState<CardTransactionView[] | null>(null);
  const [next, setNext] = useState<MoveOffsets>({ posted: null, pending: null });
  const [loadingMore, setLoadingMore] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Pages answer only the read they belong to: a fresh first read retires a "show more" on its way.
  const generation = useRef(0);
  const filters = useMemo(() => ({
    from: shiftDay(row.values.transactionDate, -MOVE_WINDOW_DAYS),
    to: shiftDay(row.values.transactionDate, MOVE_WINDOW_DAYS),
    cardAccountId: row.cardAccountRef,
  }), [row.values.transactionDate, row.cardAccountRef]);
  const usable = useCallback((items: CardTransactionView[]) => items.filter((item) => item.id !== row.transactionId && item.status !== 'removed'), [row.transactionId]);

  useEffect(() => {
    const current = ++generation.current;
    setCandidates(null);
    setNext({ posted: null, pending: null });
    setProblem(null);
    Promise.all([
      fetchCardTransactions(filters, { status: 'posted', limit: MOVE_PAGE }),
      fetchCardTransactions(filters, { status: 'pending', limit: MOVE_PAGE }),
    ])
      .then(([posted, pending]) => {
        if (current !== generation.current) return;
        setCandidates(newestFirst(usable([...posted.transactions, ...pending.transactions])));
        setNext({ posted: posted.nextOffset, pending: pending.nextOffset });
      })
      .catch(() => {
        if (current === generation.current) setProblem('Couldn\'t read Spending\'s list of charges.');
      });
  }, [filters, usable, attempt]);

  const showMore = async () => {
    if (loadingMore || (next.posted === null && next.pending === null)) return;
    const current = generation.current;
    setLoadingMore(true);
    try {
      const [posted, pending] = await Promise.all([
        next.posted === null ? null : fetchCardTransactions(filters, { status: 'posted', limit: MOVE_PAGE, offset: next.posted }),
        next.pending === null ? null : fetchCardTransactions(filters, { status: 'pending', limit: MOVE_PAGE, offset: next.pending }),
      ]);
      if (current !== generation.current) return;
      const more = usable([...(posted?.transactions ?? []), ...(pending?.transactions ?? [])]);
      setCandidates((items) => newestFirst(appendNew(items ?? [], more, (item) => item.id)));
      setNext({ posted: posted ? posted.nextOffset : null, pending: pending ? pending.nextOffset : null });
    } catch {
      if (current === generation.current) setProblem('Couldn\'t read more of Spending\'s charges.');
    } finally {
      setLoadingMore(false);
    }
  };

  const shown = useMemo(() => {
    const words = filter.trim().toLowerCase();
    return (candidates ?? []).filter((item) => !words || `${item.description} ${item.merchant ?? ''}`.toLowerCase().includes(words));
  }, [candidates, filter]);
  const picked = shown.find((item) => item.id === chosen) ?? null;
  const text = identityText(alias, null);
  const more = next.posted !== null || next.pending !== null;

  return (
    <section className="sync-group" aria-label="Move a source">
      <h4 className="sync-subhead">Move this source to another charge</h4>
      <p className="sync-text">{text.title}.</p>
      <p className="spending-muted">
        Choose the charge it really belongs to: charges of the same card account within a month of {longDate(row.values.transactionDate)}.
        A source of one card never moves to a charge on another card.
      </p>
      {problem ? (
        <div className="spending-error" role="alert">
          <strong>{problem}</strong> Nothing was moved.{' '}
          <button type="button" className="spending-link inline" onClick={() => setAttempt((value) => value + 1)}>Try again</button>
        </div>
      ) : null}
      {candidates === null ? (problem ? null : <p className="spending-muted">Loading charges…</p>) : candidates.length === 0 ? (
        <p className="sync-text">
          No other charge of this card account within a month of it. Detach the source instead: Holdr then asks you where it belongs when the
          bank sends it again.
        </p>
      ) : (
        <>
          <label className="spending-detail-form">
            <span>Filter by description</span>
            <input value={filter} maxLength={100} onChange={(event) => setFilter(event.target.value)} />
          </label>
          <fieldset className="sync-options">
            <legend className="spending-muted">Charges</legend>
            {shown.map((item) => (
              <label key={item.id} className="sync-option" data-target={item.id}>
                <input type="radio" name="move-target" checked={chosen === item.id} onChange={() => setChosen(item.id)} />
                <span>
                  {longDate(item.transactionDate)} · {item.description} · {formatRowAmount(item.amountMinor, item.currency)} · {item.status}
                </span>
              </label>
            ))}
            {shown.length === 0 ? <p className="spending-muted">No charge matches the filter{more ? ' among those read so far' : ''}.</p> : null}
          </fieldset>
          {more ? (
            <button type="button" className="spending-link" disabled={loadingMore} onClick={() => { void showMore(); }}>
              {loadingMore ? 'Loading more charges…' : 'Show more charges'}
            </button>
          ) : null}
        </>
      )}
      <div className="spending-detail-actions">
        <button type="button" className="spending-button primary" disabled={busy || picked === null} onClick={() => { if (picked) onMove(picked); }}>
          Move…
        </button>
        <button type="button" className="spending-button" disabled={busy} onClick={onCancel}>Back</button>
      </div>
    </section>
  );
}
