import { Disclosure } from '../../Disclosure';
import { Spinner, TitleWithSpinner } from '../../Spinner';
import { openCardManager } from '../cardManagerEvents';
import type { SpendingSummaryResponse } from '../spendingApi';
import { OWNERS, OWNER_LABELS, chartScaleTop, formatMinorCompact, monthLabel, shortMonthLabel } from '../spendingFormat';
import { openedNote } from '../openings/openingsText';
import type { OverviewTrendResponse } from './overviewApi';
import {
  coverageGapSentences,
  missingHistoryCards,
  missingHistoryLabel,
  monthStateText,
  monthStatesLine,
  personMonthSentence,
  trendMonthSentence,
} from './overviewText';

/** What the bars are split by: the trend's recurring, large one-offs and other spending, or the cards' owners. */
export type MonthsBy = 'type' | 'person';

/** A bar's part: what it is (its colour's class), its name in the legend and the month's name, and its amount. */
interface Part {
  id: string;
  label: string;
  amountMinor: number;
}

const TYPE_PARTS = [
  { id: 'other', label: 'Other spending', field: 'everydayMinor' },
  { id: 'recurring', label: 'Recurring', field: 'recurringMinor' },
  { id: 'oneOffs', label: 'Large one-offs', field: 'oneOffMinor' },
] as const;

/**
 * The overview's one month chart: twelve months, each a button that shows that month (`data-month`, its name starting
 * "<amount> in <Month YYYY>", contract C-4), split by type or by person. A month's state is said in words on it
 * ("Incomplete", "Month in progress"; on a narrow screen in one line under the chart), the hatching only repeats it.
 * The scale is on the axis. Which cards keep months from counting is folded under "Missing history (N cards)", with the
 * way to mark closed cards (contract C-2).
 */
export function MonthsChart(props: {
  trend: OverviewTrendResponse;
  by: MonthsBy;
  onBy: (by: MonthsBy) => void;
  /** By person: the view's summary over the same months, as read (null while By type is shown). */
  persons: { answer: SpendingSummaryResponse | null; error: string | null; busy: boolean };
  currency: string;
  selected: string | null;
  onMonth: (month: string) => void;
  cardName: (id: string) => string;
  /** Whether the card opening months are open below. */
  openings: boolean;
  onOpenings: () => void;
  /** The same view is being read again: the months shown are the last read's. */
  updating?: boolean;
}) {
  const { trend, currency, by } = props;
  const owners = by === 'person' ? props.persons.answer : null;
  const stacks = trend.months.map((item): { item: typeof item; parts: Part[]; totalMinor: number } => {
    if (by === 'person') {
      const parts = OWNERS.map((owner) => ({
        id: owner,
        label: OWNER_LABELS[owner],
        amountMinor: owners?.byMonthOwner.find((entry) => entry.currency === currency && entry.month === item.month && entry.owner === owner)?.spendingMinor ?? 0,
      }));
      const totalMinor = owners?.byMonth.find((entry) => entry.currency === currency && entry.month === item.month)?.spendingMinor ?? 0;
      return { item, parts, totalMinor };
    }
    return { item, parts: TYPE_PARTS.map((part) => ({ id: part.id, label: part.label, amountMinor: item[part.field] })), totalMinor: item.spendingMinor };
  });
  const max = Math.max(0, ...stacks.map((stack) => stack.parts.reduce((sum, part) => sum + Math.max(0, part.amountMinor), 0)));
  // Round amounts at the top and the middle of the axis, so a bar's height reads as dollars.
  const top = chartScaleTop(max, currency);
  const scale = top > 0 ? top : 1;
  const ticks = top > 0 ? [top, top / 2, 0] : [0];
  const partial = trend.months.some((item) => monthStateText(item.coverage) === 'Incomplete');
  const states = monthStatesLine(trend.months, shortMonthLabel);
  // Why, card by card: the cards behind by name, how many were first seen later, and the fixes.
  const gapSentences = partial ? coverageGapSentences(trend.gaps, { cardName: props.cardName, firstMonth: trend.months[0].month }) : [];
  // The months complete only because a card opened in them, each said in words.
  const opened = trend.months.flatMap((item) => {
    const note = openedNote(item.coverage, { subject: monthLabel(item.month) });
    return note === null ? [] : [{ month: item.month, note }];
  });
  const legend: Array<Omit<Part, 'amountMinor'>> = by === 'person'
    ? OWNERS.map((owner) => ({ id: owner, label: OWNER_LABELS[owner] }))
    : TYPE_PARTS.map((part) => ({ id: part.id, label: part.label }));
  return (
    <div className="overview-block" role="group" aria-label="Months" data-updating={props.updating ? 'true' : undefined}>
      <div className="overview-block-head">
        <TitleWithSpinner busy={Boolean(props.updating)}><h3>Months</h3></TitleWithSpinner>
        <div className="overview-tabs" role="group" aria-label="Split the bars by">
          {(['type', 'person'] as const).map((value) => (
            <button key={value} type="button" className={`overview-toggle${by === value ? ' active' : ''}`} aria-pressed={by === value}
              onClick={() => props.onBy(value)}>
              {value === 'type' ? 'By type' : 'By person'}
            </button>
          ))}
        </div>
      </div>
      <div className="overview-legend" aria-hidden="true">
        {legend.map((part) => <span key={part.id} className={`overview-key ov-${part.id}`}>{part.label}</span>)}
      </div>
      {by === 'person' && !owners ? (
        props.persons.error
          ? <p className="overview-error" role="status">{props.persons.error}</p>
          // Asked for by the owner's own press: said once, as it appears.
          : <p className="overview-help" role="status"><Spinner label="Reading the months by person" testId="overview-persons-reading" /></p>
      ) : null}
      <div className="overview-chart">
        <div className="overview-axis" aria-hidden="true">
          {ticks.map((tick) => (
            <span key={tick} className="overview-axis-tick num" style={{ bottom: `${(tick / scale) * 100}%` }}>{formatMinorCompact(tick, currency)}</span>
          ))}
        </div>
        <div className="overview-months">
          {stacks.map(({ item, parts, totalMinor }) => {
            const state = monthStateText(item.coverage);
            const marked = state === 'Incomplete';
            const empty = item.coverage.cardsExpected === 0;
            const sentence = by === 'person' && owners
              ? personMonthSentence(item.month, totalMinor, parts.map((part) => ({ name: part.label, amountMinor: part.amountMinor })), state, currency)
              : trendMonthSentence(item, currency);
            return (
              <button key={item.month} type="button"
                className={`overview-month${marked ? ' partial' : ''}${empty ? ' no-cards' : ''}${item.coverage.inProgress ? ' in-progress' : ''}${item.month === props.selected ? ' selected' : ''}`}
                aria-label={sentence} aria-pressed={item.month === props.selected} title={sentence}
                data-month={item.month} data-partial={marked} onClick={() => props.onMonth(item.month)}>
                <span className="overview-month-stack">
                  {parts.map((part) => (part.amountMinor > 0
                    ? <span key={part.id} className={`overview-month-part ov-${part.id}`} style={{ height: `${(part.amountMinor / scale) * 100}%` }} /> : null))}
                </span>
                <span className="overview-month-label">
                  {/* A phone names each month by its initial, at the reading floor; the button's name says it in full. */}
                  <span className="overview-month-name">{shortMonthLabel(item.month)}</span>
                  <span className="overview-month-initial" aria-hidden="true">{shortMonthLabel(item.month).charAt(0)}</span>
                </span>
                {state ? <span className={`overview-month-state${marked ? ' incomplete' : ''}`} aria-hidden="true">{state}</span> : null}
              </button>
            );
          })}
        </div>
      </div>
      {states ? <p className="overview-month-states" data-testid="overview-month-states">{states}</p> : null}
      <p className="overview-chart-note">
        {partial
          ? 'Incomplete months may be missing spending: a card has no recorded dates for all of the month, or no data that early. They are not lower spending.'
          : 'Every month shown has recorded dates for each card.'}
        {' '}
        <button type="button" className="overview-link" aria-expanded={props.openings} onClick={props.onOpenings} data-testid="overview-openings">
          {partial ? 'Confirm when your cards were opened' : 'When your cards were opened'}
        </button>
      </p>
      {gapSentences.length > 0 ? (
        <Disclosure className="overview-missing" summary={missingHistoryLabel(missingHistoryCards(trend.gaps))}>
          <ul className="overview-gaps" aria-label="Why months are incomplete" data-testid="overview-gaps">
            {gapSentences.map((sentence) => <li key={sentence}>{sentence}</li>)}
          </ul>
          {trend.gaps.behind.length > 0 ? (
            <button type="button" className="overview-link" onClick={openCardManager} data-testid="overview-mark-closed">Mark closed cards</button>
          ) : null}
        </Disclosure>
      ) : null}
      {opened.length > 0 ? (
        <ul className="overview-opened" aria-label="Months that include a card opened in them" data-testid="overview-opened">
          {opened.map((item) => <li key={item.month}>{item.note}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

