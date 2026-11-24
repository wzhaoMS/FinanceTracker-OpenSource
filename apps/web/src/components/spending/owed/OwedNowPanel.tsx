import { useEffect, useMemo, useState } from 'react';
import type { CardAccount } from '@finance-tracker/shared';

import { usePortfolioPref } from '../../../hooks/usePortfolioPref';
import { ApiError } from '../../../services/api';
import { Disclosure } from '../../Disclosure';
import { TitleWithSpinner } from '../../Spinner';
import { useUpdatingMark } from '../../useUpdatingMark';
import { apiErrorMessage } from '../spendingApi';
import { cardNameLabel } from '../spendingFormat';
import { fetchOwedNow, type OwedCard, type OwedResponse } from './owedApi';
import {
  OWED_NOT_INSTALLED,
  owedBalance,
  owedCardAmount,
  owedCardDetails,
  owedCardFallbackName,
  owedCoverage,
  owedCoverageText,
  owedGroupAmount,
  owedGroupMeta,
  owedGroups,
  owedHeadline,
  owedHeldText,
  owedLeftOutText,
  owedNetText,
  owedTotals,
  type OwedGroup,
} from './owedText';
import './owed.css';

type FoldState = 'open' | 'closed';
const isFoldState = (value: unknown): value is FoldState => value === 'open' || value === 'closed';

interface Props {
  /** The page's card accounts: each card is named as everywhere else on the page. */
  accountById: ReadonlyMap<string, CardAccount>;
  /** Bumped when card data changes (an import, an edit): owed now is read again. */
  dataVersion: number;
}

/**
 * Owed now: each card's current balance as its issuer last showed it (`GET /cash/owed`), whatever the page's period or
 * person. First what is owed in all, the credits and net, and how many cards are read and as of when; then one line per
 * issuer and person (the list remembers being folded), each opening on its cards with their last statement, due date
 * and as-of. A card not read yet says so in its place and is in no total; a read imported later fills it, with no change
 * here. Read-only: nothing here pays, schedules or changes anything.
 */
export function OwedNowPanel(props: Props) {
  const [data, setData] = useState<OwedResponse | null>(null);
  /** Why the last read failed, until a read succeeds. */
  const [readError, setReadError] = useState<{ message: string; missing: boolean } | null>(null);
  const [reading, setReading] = useState(true);
  const [version, setVersion] = useState(0);
  const [fold, setFold] = usePortfolioPref<FoldState>('owed-now-groups', 'open', isFoldState);
  // Read again: what is shown is the last read's, dimmed at once until a moment after the new answer lands.
  const updating = useUpdatingMark(reading && data !== null, { failed: readError !== null });

  useEffect(() => {
    let cancelled = false;
    setReading(true);
    fetchOwedNow()
      .then((body) => {
        if (cancelled) return;
        setData(body);
        setReadError(null);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setReadError({ message: apiErrorMessage(reason), missing: reason instanceof ApiError && reason.status === 404 });
      })
      .finally(() => { if (!cancelled) setReading(false); });
    return () => { cancelled = true; };
  }, [props.dataVersion, version]);

  const view = useMemo(() => (data === null ? null : {
    totals: owedTotals(data.cards),
    coverage: owedCoverage(data.cards),
    groups: owedGroups(data.cards),
  }), [data]);
  const readAgain = () => {
    setReading(true);
    setVersion((value) => value + 1);
  };

  if (data === null || view === null) {
    // An API that predates owed now has no route for it: nothing to show, nothing in the page's way.
    if (readError === null || readError.missing) return null;
    return (
      <section className="spending-panel spending-owed" aria-label="Owed now" aria-busy={reading} data-testid="owed-now">
        <PanelHead />
        <div className="spending-error" role="alert" data-testid="owed-read-error">Owed now could not be read: {readError.message}</div>
        <button type="button" className="spending-button ghost owed-read-again" disabled={reading} onClick={readAgain}>Read again</button>
      </section>
    );
  }

  const name = (card: OwedCard) => {
    const account = props.accountById.get(card.cardAccountId);
    const label = account ? cardNameLabel(account) : owedCardFallbackName(card);
    return card.status === 'closed' ? `${label} (closed)` : label;
  };
  const net = owedNetText(view.totals);
  const leftOut = owedLeftOutText(view.coverage);
  const held = owedHeldText(data.held);
  return (
    <section className="spending-panel spending-owed" aria-label="Owed now" aria-busy={reading}
      data-updating={updating ? 'true' : undefined} data-testid="owed-now">
      <PanelHead updating={updating} />
      <div className="owed-summary">
        <p className="owed-headline" data-testid="owed-headline">{owedHeadline(view.totals)}</p>
        <ul className="owed-lines" data-testid="owed-status">
          {net ? <li data-testid="owed-net">{net}</li> : null}
          <li data-testid="owed-coverage">{owedCoverageText(view.coverage)}</li>
          {leftOut ? <li className="owed-left-out" data-testid="owed-left-out">{leftOut}</li> : null}
        </ul>
        {!data.installed ? <p className="owed-note" data-testid="owed-not-installed">{OWED_NOT_INSTALLED}</p> : null}
        {held ? <p className="owed-note" data-testid="owed-held">{held}</p> : null}
      </div>
      {readError ? (
        <div className="spending-error" role="alert" data-testid="owed-read-error">
          Owed now could not be read again: {readError.message}. What shows is from the last read.{' '}
          <button type="button" className="spending-link inline" disabled={reading} onClick={readAgain}>Read again</button>
        </div>
      ) : null}
      {view.groups.length > 0 ? (
        <Disclosure className="owed-fold owed-groups-fold" summary={`By issuer and person (${view.groups.length})`}
          open={fold === 'open'} onOpenChange={(open) => setFold(open ? 'open' : 'closed')}>
          <ul className="owed-groups" aria-label="By issuer and person">
            {view.groups.map((group) => <GroupLine key={group.key} group={group} name={name} today={data.today} />)}
          </ul>
        </Disclosure>
      ) : null}
    </section>
  );
}

/** One issuer and person: what its cards owe, how many are read, and, opened, each card in its place. */
function GroupLine({ group, name, today }: { group: OwedGroup; name: (card: OwedCard) => string; today: string }) {
  const amount = owedGroupAmount(group);
  const meta = owedGroupMeta(group);
  return (
    <li className="owed-group" data-read={group.read > 0 ? 'true' : 'false'} data-testid="owed-group">
      <Disclosure
        className="owed-fold owed-group-fold"
        label={`${group.label}: ${amount}, ${meta}`}
        summary={(
          <span className="owed-group-summary">
            <span className="owed-group-name">{group.label}</span>
            <span className="owed-group-meta">{meta}</span>
            <span className={`owed-group-amount${group.read > 0 ? ' num' : ''}`}>{amount}</span>
          </span>
        )}
      >
        <ul className="owed-cards" aria-label={`${group.label}: cards`}>
          {group.cards.map((card) => {
            const balance = owedBalance(card);
            const details = owedCardDetails(card, today);
            return (
              <li key={card.cardAccountId} className="owed-card" data-read={balance !== null ? 'true' : 'false'} data-testid="owed-card">
                <span className="owed-card-name">{name(card)}</span>
                <span className={`owed-card-amount${balance === null ? '' : balance < 0 ? ' num credit' : ' num'}`}>{owedCardAmount(card)}</span>
                {details.length > 0 ? <span className="owed-card-details">{details.join(' · ')}</span> : null}
              </li>
            );
          })}
        </ul>
      </Disclosure>
    </li>
  );
}

/** The title, and the scope: every card's balance now, whatever the page's period or person. */
function PanelHead({ updating = false }: { updating?: boolean }) {
  return (
    <header className="spending-panel-head owed-head">
      <TitleWithSpinner busy={updating} testId="owed-updating"><h3>Owed now</h3></TitleWithSpinner>
      <p className="owed-scope" data-testid="owed-scope">Each card&apos;s balance as its issuer last showed it, any period or person</p>
    </header>
  );
}
