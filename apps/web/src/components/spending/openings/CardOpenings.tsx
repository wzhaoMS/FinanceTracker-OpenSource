import { useEffect, useMemo, useRef, useState } from 'react';
import type { CardAccount, CardOpeningMonthsResponse, CardOwner } from '@finance-tracker/shared';

import { usePortfolioStore } from '../../../stores/portfolio';
import { apiErrorMessage } from '../spendingApi';
import { cardOptionLabel } from '../spendingFormat';
import { clearCardOpening, confirmCardOpenings, fetchCardOpenings } from './openingsApi';
import {
  CONFIRM_ALL_NOTE,
  OPENINGS_INTRO,
  OPENINGS_NOT_INSTALLED,
  assertionText,
  changedText,
  confirmAllLabel,
  confirmAllShown,
  earliestFirstKnown,
  evidenceText,
  flaggedNote,
  laterCardText,
  openingRows,
  prefillText,
  statusText,
  type OpeningRow,
} from './openingsText';
import './openings.css';

interface Props {
  /** YYYY-MM-DD: no card opens after this month. */
  today: string;
  /** The card accounts, for their names and owners. */
  cards: readonly CardAccount[];
  /** The overview's cards: one card, one person's, or all. */
  view: { owner?: CardOwner; cardAccountId?: string };
  /** A month was confirmed or cleared: every figure that reads coverage is read again. */
  onChanged: () => void;
  onClose: () => void;
}

/**
 * The owner's card opening months on one screen: each card in view with the month it was opened, prefilled from the
 * first day Holdr has for it and editable, where its month stands, and, folded under it, what Holdr has of it; "Confirm
 * all shown" confirms every month shown that would change, except a card first seen after the earliest one (flagged on
 * its line), which takes its own Confirm; and each card can be confirmed or cleared alone. The API decides
 * (`/spending/card-openings`): until its table is installed nothing can be confirmed, and that is said.
 */
export function CardOpenings(props: Props) {
  const writesDisabled = usePortfolioStore((s) => s.apiStatus) === 'cache';
  const [answer, setAnswer] = useState<CardOpeningMonthsResponse | null>(null);
  /** Months the owner typed, by card id, until they are confirmed. */
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const section = useRef<HTMLElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetchCardOpenings()
      .then((openings) => { if (!cancelled) setAnswer(openings); })
      .catch((reason: unknown) => { if (!cancelled) setError(apiErrorMessage(reason)); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { section.current?.focus(); }, []);

  const accounts = useMemo(() => new Map(props.cards.map((account) => [account.id, account])), [props.cards]);
  const { owner, cardAccountId } = props.view;
  const shown = useMemo(() => (answer?.cards ?? []).filter((card) => {
    const account = accounts.get(card.cardAccountId);
    return account !== undefined && (cardAccountId === undefined || account.id === cardAccountId) && (owner === undefined || account.owner === owner);
  }), [answer, accounts, owner, cardAccountId]);
  const rows = openingRows(shown, typed, props.today);
  // Over every card account in the answer, not only those shown: a card first seen after it is flagged, and left out
  // of "Confirm all shown".
  const earliest = earliestFirstKnown(answer?.cards ?? []);
  const all = confirmAllShown(rows, earliest);
  const leftOut = all.blocked ? null : flaggedNote(all.flagged);
  const installed = answer?.installed ?? false;
  const locked = busy || writesDisabled || !installed;

  /** Sends a change; the answer is the screen again. What was typed for the cards sent is dropped. */
  const change = (request: Promise<CardOpeningMonthsResponse>, sent: readonly string[], said: (body: CardOpeningMonthsResponse) => string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    request
      .then((body) => {
        setAnswer({ installed: body.installed, cards: body.cards });
        setTyped((now) => Object.fromEntries(Object.entries(now).filter(([id]) => !sent.includes(id))));
        setNotice(said(body));
        props.onChanged();
      })
      .catch((reason: unknown) => setError(apiErrorMessage(reason)))
      .finally(() => setBusy(false));
  };
  const confirm = (cards: Array<{ cardAccountId: string; openingMonth: string }>) =>
    change(confirmCardOpenings(cards), cards.map((card) => card.cardAccountId), (body) => changedText((body as { changed?: number }).changed ?? 0));
  const clear = (id: string, name: string) =>
    change(clearCardOpening(id), [id], (body) => ((body as { cleared?: boolean }).cleared ? `Cleared ${name}'s opening month` : `${name} had no confirmed month`));

  return (
    <section ref={section} tabIndex={-1} className="overview-block spending-openings" aria-label="When your cards were opened"
      aria-busy={answer === null || busy} data-testid="card-openings">
      <div className="overview-block-head">
        <h3>When your cards were opened</h3>
        <button type="button" className="spending-link" onClick={props.onClose}>Done</button>
      </div>
      <p className="spending-muted openings-intro">{OPENINGS_INTRO}</p>
      {answer && !installed ? <p className="openings-note" data-testid="openings-not-installed">{OPENINGS_NOT_INSTALLED}</p> : null}
      {error ? <div className="spending-error" role="alert">{error}</div> : null}
      {notice ? <p className="openings-notice" role="status">{notice}</p> : null}
      {answer ? (
        rows.length === 0 ? <p className="spending-muted">No cards in this view.</p> : (
          <ul className="openings-list" aria-label="Cards">
            {rows.map((row) => (
              <OpeningLine
                key={row.card.cardAccountId}
                row={row}
                name={cardOptionLabel(accounts.get(row.card.cardAccountId)!)}
                later={laterCardText(row.card, earliest)}
                today={props.today}
                locked={locked}
                onType={(month) => setTyped((now) => ({ ...now, [row.card.cardAccountId]: month }))}
                onConfirm={() => confirm([{ cardAccountId: row.card.cardAccountId, openingMonth: row.month }])}
                onClear={() => clear(row.card.cardAccountId, cardOptionLabel(accounts.get(row.card.cardAccountId)!))}
              />
            ))}
          </ul>
        )
      ) : null}
      {rows.length > 0 ? (
        <div className="openings-actions">
          <button type="button" className="spending-button primary" disabled={locked || all.blocked || all.cards.length === 0}
            onClick={() => confirm(all.cards)}>
            {confirmAllLabel(all)}
          </button>
          {all.blocked ? <span className="spending-muted">Fix the months marked first.</span> : null}
          {!all.blocked && all.cards.length > 0 ? <span className="spending-muted" data-testid="openings-confirm-all-note">{CONFIRM_ALL_NOTE}</span> : null}
          {leftOut ? <span className="openings-flag-note" data-testid="openings-flagged-note">{leftOut}</span> : null}
        </div>
      ) : null}
    </section>
  );
}

function OpeningLine(props: {
  row: OpeningRow;
  name: string;
  /** First seen after the earliest card: said before the click. */
  later: string | null;
  today: string;
  locked: boolean;
  onType: (month: string) => void;
  onConfirm: () => void;
  onClear: () => void;
}) {
  const { row, name } = props;
  const problemId = `opening-problem-${row.card.cardAccountId}`;
  const assertion = assertionText(row);
  const prefill = prefillText(row);
  return (
    <li className="openings-row" data-card={row.card.cardAccountId} data-status={row.card.status ?? 'none'}>
      <span className="openings-name" title={name}>{name}</span>
      <input
        type="month"
        className="openings-month"
        aria-label={`${name}: opened in`}
        aria-invalid={row.problem !== null}
        aria-describedby={row.problem ? problemId : undefined}
        min="1900-01"
        max={props.today.slice(0, 7)}
        placeholder="YYYY-MM"
        value={row.month}
        onChange={(event) => props.onType(event.target.value)}
      />
      <span className="openings-buttons">
        <button type="button" className="spending-button ghost" disabled={props.locked || !row.changes} onClick={props.onConfirm}
          aria-label={`Confirm ${name}`}>
          Confirm
        </button>
        {row.card.openingMonth !== null ? (
          <button type="button" className="spending-link" disabled={props.locked} onClick={props.onClear} aria-label={`Clear ${name}`}>
            Clear
          </button>
        ) : null}
      </span>
      <span className="openings-status" data-testid="opening-status">{statusText(row.card)}</span>
      {row.problem ? <span className="openings-problem" id={problemId}>{row.problem}</span> : null}
      {props.later ? <span className="openings-flag" data-testid="opening-later">{props.later}</span> : null}
      {assertion ? <span className="openings-assert" data-testid="opening-assert">{assertion}</span> : null}
      {/* What Holdr has of it, and where a prefilled month comes from: folded, so each card reads in a few lines. */}
      <details className="openings-evidence" data-testid="opening-evidence">
        <summary>What Holdr has</summary>
        <span className="openings-evidence-body">
          <span data-testid="opening-record">{evidenceText(row.card)}</span>
          {prefill ? <span className="openings-prefill" data-testid="opening-prefill">{prefill}</span> : null}
        </span>
      </details>
    </li>
  );
}
