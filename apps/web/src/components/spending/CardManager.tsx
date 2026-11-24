import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CardAccount, CardAccountCoverage, CardOwner } from '@finance-tracker/shared';

import {
  CARD_MANAGER_LEAD,
  LATEST_NOT_READ,
  cardManagerCountText,
  cardManagerRows,
  cardStatusText,
  issuerChoices,
  latestRecordedText,
  ownerChoices,
  statusChangedText,
  statusConfirmation,
  type CardManagerRow,
} from './cardManagerText';
import { apiErrorMessage, fetchSpendingCoverage, updateCardAccountStatus } from './spendingApi';
import { OWNER_LABELS, cardNameLabel } from './spendingFormat';
import { SyncDialog } from './sync/SyncDialog';
import './cardManager.css';

interface Props {
  accounts: readonly CardAccount[];
  /** The server is unreachable: the list shows, and no status can change. */
  writesDisabled: boolean;
  /** Each status change the owner confirmed, once Holdr has it (the Spending tab reads its figures again). */
  onUpdated: (account: CardAccount) => void;
  onClose: () => void;
  /** Bumped when Manage cards is asked for again while it is open: focus moves back into it. */
  focusRequest: number;
}

/** A card as the confirmation, the buttons and the notice name it: its name and ending, and whose it is. */
const cardLabel = (account: CardAccount) => `${cardNameLabel(account)} · ${OWNER_LABELS[account.owner]}`;

/**
 * Manage cards: every card with whose it is, its status in Holdr and the latest day Holdr has anything of it
 * (/spending/coverage), oldest activity first, narrowed by issuer and person. Each card is marked closed or reopened
 * only after a confirmation naming it, one at a time. Holdr never closes a card by itself; marking one closed hides it
 * in the Card picker and stops expecting history after its latest record, and every transaction stays.
 */
export function CardManager(props: Props) {
  const { accounts, writesDisabled } = props;
  const [coverage, setCoverage] = useState<CardAccountCoverage[] | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  /** Reads of the record so far: "Try again" asks for another. */
  const [reads, setReads] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [issuer, setIssuer] = useState('');
  const [owner, setOwner] = useState<CardOwner | ''>('');
  /** The card whose status change waits for the owner's word. */
  const [confirming, setConfirming] = useState<CardAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const count = useRef<HTMLParagraphElement>(null);
  const countId = useId();

  useEffect(() => {
    let cancelled = false;
    // A failed read stays on screen, with the cards by name, until a read succeeds.
    fetchSpendingCoverage()
      .then((cards) => {
        if (cancelled) return;
        setCoverage(cards);
        setReadError(null);
        // After "Try again", focus goes to what was read, not back to the page.
        if (reads > 0) count.current?.focus();
      })
      .catch((reason: unknown) => { if (!cancelled) setReadError(apiErrorMessage(reason)); })
      .finally(() => { if (!cancelled) setRetrying(false); });
    return () => { cancelled = true; };
  }, [reads]);

  // Asked for again while open: back into Manage cards, unless a confirmation is waiting on top of it.
  useEffect(() => {
    if (props.focusRequest > 0 && confirming === null) root.current?.closest<HTMLElement>('[role="dialog"]')?.focus();
    // Only a new request moves focus.
  }, [props.focusRequest]);

  const issuers = useMemo(() => issuerChoices(accounts), [accounts]);
  const owners = useMemo(() => ownerChoices(accounts), [accounts]);
  const rows = useMemo(() => cardManagerRows(accounts, coverage, { issuer, owner }), [accounts, coverage, issuer, owner]);
  const loading = coverage === null && readError === null;
  const latestOf = (row: CardManagerRow) => (row.latest === undefined ? LATEST_NOT_READ : latestRecordedText(row.latest));

  const change = async () => {
    if (!confirming || busy || writesDisabled) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await updateCardAccountStatus(confirming.id, confirming.status === 'closed' ? 'active' : 'closed');
      props.onUpdated(updated);
      setNotice(statusChangedText(cardLabel(updated), updated.status));
      setConfirming(null);
    } catch (reason: unknown) {
      setError(apiErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const confirmation = confirming ? statusConfirmation(confirming.status) : null;
  const confirmingRow = confirming ? rows.find((row) => row.account.id === confirming.id) : undefined;

  return (
    <>
      <SyncDialog title="Manage cards" wide onClose={props.onClose}>
        <div ref={root} className="card-manager" data-testid="card-manager">
          <p className="card-manager-lead">{CARD_MANAGER_LEAD}</p>
          {writesDisabled ? (
            <p className="card-manager-help" data-testid="card-manager-writes-off">Server unreachable: no card can be marked closed or reopened until it reconnects.</p>
          ) : null}
          <p className="card-manager-notice" role="status" data-testid="card-manager-notice">{notice}</p>
          {accounts.length === 0 ? (
            <p className="card-manager-help" data-testid="card-manager-empty">No cards yet. Importing a statement adds one.</p>
          ) : (
            <>
              {issuers.length > 1 || owners.length > 1 ? (
                <div className="card-manager-filters" role="group" aria-label="Filter cards">
                  {issuers.length > 1 ? (
                    <label className="card-manager-field">
                      <span>Issuer</span>
                      <select value={issuer} onChange={(event) => setIssuer(event.target.value)}>
                        <option value="">All issuers</option>
                        {issuers.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                      </select>
                    </label>
                  ) : null}
                  {owners.length > 1 ? (
                    <label className="card-manager-field">
                      <span>Person</span>
                      <select value={owner} onChange={(event) => setOwner(event.target.value as CardOwner | '')}>
                        <option value="">Everyone</option>
                        {owners.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                      </select>
                    </label>
                  ) : null}
                </div>
              ) : null}
              {readError ? (
                <div className="spending-error card-manager-error" role="alert" data-testid="card-manager-read-error">
                  <span>{`Couldn't read when each card was last recorded: ${readError}`}</span>
                  <button type="button" className="spending-button" onClick={() => { setRetrying(true); setReads((n) => n + 1); }}>
                    {retrying ? 'Trying again…' : 'Try again'}
                  </button>
                </div>
              ) : null}
              {loading ? (
                <p className="card-manager-help" data-testid="card-manager-loading">Reading when each card was last recorded…</p>
              ) : (
                <>
                  <p ref={count} id={countId} tabIndex={-1} className="card-manager-count" data-testid="card-manager-count">
                    {cardManagerCountText(rows.length, accounts.length, coverage !== null)}
                  </p>
                  {rows.length === 0 ? (
                    <div className="card-manager-none">
                      <p className="card-manager-help">No cards match these filters.</p>
                      <button type="button" className="spending-button" onClick={() => { setIssuer(''); setOwner(''); }}>Show all cards</button>
                    </div>
                  ) : (
                    <ul className="card-manager-list" aria-label="Cards" aria-describedby={countId}>
                      {rows.map((row) => {
                        const label = cardLabel(row.account);
                        const action = row.account.status === 'closed' ? 'Reopen' : 'Mark closed';
                        return (
                          <li key={row.account.id} className="card-manager-row" data-card={row.account.id} data-status={row.account.status}>
                            <span className="card-manager-text">
                              <span className="card-manager-name">{cardNameLabel(row.account)}</span>
                              <span className="card-manager-meta" data-testid="card-manager-meta">
                                {`${OWNER_LABELS[row.account.owner]} · ${cardStatusText(row.account.status)}`}
                              </span>
                              <span className="card-manager-latest" data-testid="card-manager-latest">{latestOf(row)}</span>
                            </span>
                            <button type="button" className="spending-button" disabled={writesDisabled} aria-label={`${action}: ${label}`}
                              onClick={() => { setConfirming(row.account); setError(null); setNotice(null); }}>
                              {action}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </SyncDialog>
      {confirming && confirmation ? (
        <SyncDialog title={confirmation.title} busy={busy} onClose={() => setConfirming(null)}>
          <div className="card-manager-confirm" data-testid="card-manager-confirm">
            <p className="card-manager-confirm-name">{cardLabel(confirming)}</p>
            <p className="card-manager-latest">{confirmingRow ? latestOf(confirmingRow) : LATEST_NOT_READ}</p>
            {confirmation.lines.map((line) => <p key={line} className="card-manager-confirm-text">{line}</p>)}
            {error ? <p className="spending-error card-manager-error" role="alert">{error}</p> : null}
            <div className="spending-detail-actions">
              <button type="button" className="spending-button primary" disabled={busy || writesDisabled} onClick={() => { void change(); }}>
                {busy ? 'Saving…' : confirmation.action}
              </button>
              <button type="button" className="spending-button" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
            </div>
          </div>
        </SyncDialog>
      ) : null}
    </>
  );
}
