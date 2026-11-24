import { useId } from 'react';

import { Spinner } from '../../Spinner';
import { useUpdatingMark } from '../../useUpdatingMark';
import { formatMinor, type SpendingPeriod, type SpendingPeriodRange } from '../spendingFormat';
import { openedNote } from '../openings/openingsText';
import { accountingFor, pendingEffectText } from '../whatCounts';
import {
  headlineBasis,
  headlineComparison,
  headlineComparisonWindow,
  headlineFigure,
  headlineLabel,
  matchingText,
  notInTotalRows,
  soFarMarker,
} from './headlineText';
import { windowReasons, windowShortNote } from './overviewText';
import { IncompleteNote, NotComparableBlock } from './OverviewNotes';
import type { OverviewRead } from './SpendingOverview';

/** What counts (session C's panel), which "What counts as spending" opens. */
const WHAT_COUNTS = 'section[aria-label="What counts as spending"]';

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The tab's one headline: "Spent in <period>" (posted, after refunds), whose cards it covers, the one comparison the
 * coverage rule allows (or "Not comparable" with both figures), and what is not in the total, each kind on its own
 * line. The total, what it leaves out and the comparison are the overview's own read of the period's dates; a figure is
 * shown only under its own view, and a window with no card data is never shown as $0.
 */
export function OverviewHeadline(props: {
  read: OverviewRead;
  /** The tab's period choice: a month's notes say "this month". */
  periodKind: SpendingPeriod;
  /** The baseline the tab's period names: the headline compares with it. */
  previous: SpendingPeriodRange['previous'];
  /** Whose cards, in words. */
  scope: string;
  /** How many rows the list shows for the filters in use; null with none in use, or until the list is in. */
  matching: number | null;
  /** The list is being read again: its count, while shown, may change. */
  matchingUpdating?: boolean;
  onShowTransactions: () => void;
}) {
  const { read } = props;
  const { currency, period } = read;
  const summary = read.totals?.summary ?? null;
  // What confirming the precious-metals suggestions waiting would take out, in What counts' words; none when none wait.
  const waiting = pendingEffectText(accountingFor(read.totals?.accounting?.accounting, currency));
  const labelId = useId();
  const outId = useId();
  const totals = summary?.totals.find((item) => item.currency === currency);
  const pending = summary?.pending.find((item) => item.currency === currency);
  const others = (summary?.totals ?? []).filter((item) => item.currency !== currency && item.count > 0);
  const paidFromBrokerage = summary?.paymentsPossiblyPaidFrom?.find((item) => item.currency === currency)?.count ?? 0;
  const current = read.current;
  const figure = headlineFigure({
    amountMinor: summary ? totals?.spendingMinor ?? 0 : null,
    rows: totals?.count ?? 0,
    record: current?.coverage ?? null,
    recordFailed: read.failure !== null,
    currency,
  });
  const soFar = soFarMarker(period);
  // The period's own note, said once beside its total: still going, or not recorded for every day; why folded under it.
  const currentNote = current ? windowShortNote(current, period.name) : null;
  // A window complete only because a card opened in it says so (the owner's confirmed opening months).
  const scope = props.periodKind === 'month' ? 'month' : 'period';
  const currentOpened = current ? openedNote(current.coverage, { scope }) : null;
  const compared = headlineComparisonWindow(period, props.previous);
  const result = compared ? read.results.get(compared.key) : undefined;
  const comparison = compared && result
    ? headlineComparison(result.comparison.current, result.comparison.baseline, { currency, periodName: period.name, baselineName: compared.baselineName })
    : null;
  const baselineOpened = compared && result
    ? openedNote(result.comparison.baseline.coverage, { subject: capitalize(compared.baselineName), scope })
    : null;
  const out = summary ? notInTotalRows({ totals, pending, paidFromBrokerage, currency }) : null;
  // A figure being read for the first time is a spinner in its place, never "—", which says "unknown" (a failed read
  // keeps it). A figure from the last read, while the same view is read again, stays, dimmed at once, with one spinner
  // for the headline beside its label, until a moment after the new one lands: no number changes unmarked.
  const totalReading = figure === '—' && read.busy && read.totalsFailure === null;
  const totalsUpdating = read.totalsUpdating;
  const compareUpdating = read.compareUpdating && comparison !== null;
  const matchingUpdating = useUpdatingMark(props.matching !== null && Boolean(props.matchingUpdating));
  const updating = totalsUpdating || compareUpdating || (props.matching !== null && matchingUpdating);
  const openWhatCounts = () => {
    const panel = document.querySelector<HTMLElement>(WHAT_COUNTS);
    if (!panel) return;
    panel.setAttribute('tabindex', '-1');
    panel.scrollIntoView({ block: 'start' });
    panel.focus({ preventScroll: true });
  };

  return (
    <div className="spending-panel overview-headline" role="group" aria-labelledby={labelId} data-testid="overview-headline">
      {/* data-card="spent" and .spending-card-value: the same figure the summary cards showed, for the specs that read it. */}
      <div className="overview-headline-total" data-card="spent" data-updating={totalsUpdating ? 'true' : undefined}>
        <div className="overview-headline-head">
          <h3 id={labelId} className="overview-headline-label" data-testid="overview-headline-label">{headlineLabel(period)}</h3>
          {updating ? <Spinner label="Updating" testId="overview-updating" /> : null}
        </div>
        <p className="overview-total-line">
          {totalReading
            ? <Spinner label="Reading the total" testId="overview-total-reading" className="overview-total-spinner" deferred />
            : <strong className="overview-total spending-card-value num" data-testid="overview-total">{figure}</strong>}
          {soFar ? <span className="overview-so-far" data-testid="overview-so-far">{soFar}</span> : null}
        </p>
        {/* The total's own read failed: said here, never a settled dash. */}
        {read.totalsFailure ? (
          <p className="overview-error" role="status" data-testid="overview-totals-error">{`Couldn't read this total: ${read.totalsFailure}`}</p>
        ) : null}
        <p className="overview-scope" data-testid="overview-scope">{`${headlineBasis(totals?.creditsMinor ?? 0, currency)} · ${props.scope}`}</p>
        {others.length > 0 ? (
          <p className="overview-other-currencies" data-testid="overview-other-currencies">
            {`Also ${others.map((item) => formatMinor(item.spendingMinor, item.currency)).join(' and ')} on cards in ${others.length === 1 ? 'another currency' : 'other currencies'}`}
          </p>
        ) : null}
        {waiting ? <p className="overview-waiting" data-testid="possible-metals">{waiting}</p> : null}
        {currentNote && current ? <IncompleteNote summary={currentNote} reasons={windowReasons(current)} testId="overview-current-note" /> : null}
        {currentOpened ? <p className="overview-opened-note" data-testid="overview-current-opened">{currentOpened}</p> : null}
        {props.matching !== null ? (
          <p className="overview-matching" data-updating={matchingUpdating && !totalsUpdating ? 'true' : undefined}>
            <button type="button" className="overview-jump" onClick={props.onShowTransactions} data-testid="overview-matching">
              {matchingText(props.matching)} <span aria-hidden="true">↓</span> Transactions
            </button>
          </p>
        ) : null}
      </div>

      <div className="overview-headline-compare" data-testid="overview-compare" data-updating={compareUpdating ? 'true' : undefined}>
        {read.failure ? <p className="overview-error" role="status">{read.failure}</p>
          : comparison === null ? (read.busy
            ? <p className="overview-help"><Spinner label="Comparing" testId="overview-comparing" deferred /></p>
            : <p className="overview-help">No comparison for this period</p>)
            : comparison.kind === 'compared' ? (
              <div className="overview-compared" data-testid="overview-compared" data-tone={comparison.tone}>
                <p className="overview-compared-text" data-testid="overview-compared-text">{comparison.text}</p>
                <dl className="overview-figures">
                  <div className="overview-figure" data-figure="baseline">
                    <dt>{comparison.baseline.label}</dt>
                    <dd className="num">{comparison.baseline.figure}</dd>
                  </div>
                </dl>
              </div>
            ) : (
              // The period's own reasons are said beside its total; only the baseline's and the card counts here.
              <NotComparableBlock comparison={comparison} whyAbout={['baseline', 'both']} testId="overview-not-comparable" />
            )}
        {baselineOpened && !read.failure ? <p className="overview-opened-note" data-testid="overview-opened-baseline">{baselineOpened}</p> : null}
      </div>

      <div className="overview-out" role="group" aria-labelledby={outId} data-testid="overview-out">
        <h4 id={outId}>Not in this total</h4>
        {out === null ? (read.totalsBusy
          ? <p className="overview-help"><Spinner label="Reading what is not in this total" testId="overview-out-reading" deferred /></p>
          : <p className="overview-help">—</p>)
          : out.length === 0 ? <p className="overview-help" data-testid="overview-out-none">Nothing pending or left out</p> : (
            <ul className="overview-out-rows" data-updating={totalsUpdating ? 'true' : undefined}>
              {out.map((row) => (
                // The pending row's amount and the metals row keep the hooks the summary cards had (same figures, same words).
                <li key={row.key} className="overview-out-row" data-out={row.key} data-card={row.key === 'pending' ? 'pending' : undefined}
                  data-testid={row.key === 'metals' ? 'metals-not-counted' : undefined}>
                  <span className={`overview-out-amount num${row.key === 'pending' ? ' spending-card-value' : ''}`}>{row.amount}</span>
                  {' '}
                  <span className="overview-out-text">{row.text}</span>
                  {row.note ? <span className="overview-out-note">{row.note}</span> : null}
                </li>
              ))}
            </ul>
          )}
        <button type="button" className="overview-link" onClick={openWhatCounts}>What counts as spending</button>
      </div>
    </div>
  );
}
