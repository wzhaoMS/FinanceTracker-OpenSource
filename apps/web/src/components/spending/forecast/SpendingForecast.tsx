import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type {
  CardAccount,
  CardBill,
  CardCategoryBasis,
  CardOwner,
  CardSeriesForecast,
  CardSpendingPace,
} from '@finance-tracker/shared';

import { Disclosure } from '../../Disclosure';
import { ChevronDown, ChevronRight } from '../../icons';
import { Spinner } from '../../Spinner';
import { coverageGapSentences } from '../overview/overviewText';
import { apiErrorMessage } from '../spendingApi';
import { cardOptionLabel, formatMinor, monthLabel, shortDate, shortMonthLabel } from '../spendingFormat';
import { fetchSpendingForecast, fetchSpendingPatterns, type SpendingForecastResponse, type SpendingPatternsResponse } from './forecastApi';
import {
  FORECAST_FILTERS_NOTE,
  FORECAST_METALS_NOTE,
  FORECAST_NO_RANGE_NOTE,
  FORECAST_QUANTITY,
  FORECAST_ROWS_METHOD,
  FORECAST_ROWS_NOTE,
  anomalyMethodSentence,
  anomalySentences,
  backtestSentences,
  billSentence,
  billsMethodSentence,
  billsSentences,
  forecastCategoryLabels,
  forecastHeadline,
  forecastNotes,
  forecastScopeSentence,
  formatEstimate,
  gapSummaryText,
  methodSentence,
  paceSentences,
  range95Sentence,
  type ForecastSentence,
  type ForecastTemplate,
} from './forecastText';
import './forecast.css';

/** Categories listed before "Show all", and bills before "Show all". */
const VISIBLE_CATEGORIES = 8;
const VISIBLE_BILLS = 8;
/** How long a view must hold before the panel reads its answers: the tab's own lists are read first. */
const SETTLE_MS = 250;

const CADENCE_WORDS: Record<CardBill['cadence'], string> = {
  weekly: 'weekly', biweekly: 'every 2 weeks', monthly: 'monthly', quarterly: 'quarterly', annual: 'yearly',
};

/** This month's sentences that stay on the lead, under the figure: what an estimate or its range still needs, and whether this month's record may be short. */
const PACE_LIMITS: ReadonlySet<ForecastTemplate> = new Set(['pace-no-range', 'pace-spent-only', 'pace-record-incomplete']);
/** ...and at its foot: what is pending, not counted. */
const PACE_STATUS: ReadonlySet<ForecastTemplate> = new Set(['pace-pending']);
/** Notes on the months that are caveats (shown under the lead), not method. */
const MISSING_HISTORY: ReadonlySet<ForecastTemplate> = new Set(['partial-months']);

function Sentences({ items, className }: { items: readonly ForecastSentence[]; className?: string }) {
  if (items.length === 0) return null;
  return (
    <ul className={`forecast-sentences${className ? ` ${className}` : ''}`}>
      {items.map((item) => <li key={`${item.template}-${item.text}`} data-template={item.template}>{item.text}</li>)}
    </ul>
  );
}

/** Spending without large one-offs so far, its estimate's 80% range and the estimate on one track, and a typical month's mark. */
function PaceTrack({ pace }: { pace: CardSpendingPace }) {
  const range = pace.everydayRange80;
  const top = Math.max(pace.everydaySpentMinor, pace.everydayProjectedMinor ?? 0, range?.upperMinor ?? 0, pace.typicalMinor ?? 0) * 1.05;
  if (!(top > 0)) return null;
  const at = (minor: number) => `${Math.max(0, Math.min(100, (minor / top) * 100))}%`;
  return (
    <div className="forecast-track" aria-hidden="true">
      <span className="forecast-track-spent" style={{ width: at(pace.everydaySpentMinor) }} />
      {range ? <span className="forecast-track-band" style={{ left: at(range.lowerMinor), width: `calc(${at(range.upperMinor)} - ${at(range.lowerMinor)})` }} /> : null}
      {pace.everydayProjectedMinor !== null ? <span className="forecast-track-point" style={{ left: at(pace.everydayProjectedMinor) }} /> : null}
      {pace.typicalMinor !== null ? <span className="forecast-track-typical" style={{ left: at(pace.typicalMinor) }} /> : null}
    </div>
  );
}

/**
 * The panel's lead, always in view (its compact state): this month's estimate of spending without large one-offs with
 * its 80% range beside it, and under it what a range or an estimate still needs and whether this month's record may be
 * short; then the month's parts, one to a line, each labelled with what it holds (the large one-offs already posted
 * counted once, never projected); then what is pending. How the estimate was made is folded below the panel's answers.
 */
function PaceLead({ forecast }: { forecast: SpendingForecastResponse }) {
  const { pace, currency } = forecast;
  const said = paceSentences(pace, forecast.today, currency);
  const range = pace.everydayRange80;
  const total = pace.projectedRange80;
  const projected = pace.everydayProjectedMinor !== null;
  const through = shortDate(forecast.today);
  // While some card's record of this month is short, the amount so far is only what is recorded, never all that was spent.
  const recorded = pace.monthSoFarComplete === false;
  const span = (lower: number, upper: number) => `${formatEstimate(lower, currency)}–${formatEstimate(upper, currency)}`;
  return (
    <article className="forecast-lead" aria-labelledby="forecast-pace-title" data-forecast="pace">
      <div className="forecast-lead-main">
        <h4 id="forecast-pace-title">{`This month: ${FORECAST_QUANTITY.toLowerCase()}`}</h4>
        <p className="forecast-figure" data-figure={projected ? 'everyday-estimate' : 'everyday-so-far'}>
          <span className="forecast-figure-value num">
            {projected ? formatEstimate(pace.everydayProjectedMinor!, currency) : formatMinor(pace.everydaySpentMinor, currency)}
          </span>
          {' '}
          <span className="forecast-figure-label">
            {projected ? `estimate for all of ${monthLabel(pace.month)}` : `${recorded ? 'recorded' : 'spent'} through ${through}`}
            {' · '}
            {!projected ? 'no estimate yet'
              : range ? <span className="forecast-figure-range num" data-range="80">{`80% range ${span(range.lowerMinor, range.upperMinor)}`}</span>
                : 'no range yet'}
          </span>
        </p>
        <Sentences items={said.filter((item) => PACE_LIMITS.has(item.template))} className="forecast-limits" />
        <PaceTrack pace={pace} />
      </div>
      <dl className="forecast-parts">
        {projected ? (
          <div data-part="everyday-so-far">
            <dt>{`${recorded ? 'Recorded so far' : 'So far'}, through ${through}`}</dt>
            <dd className="num">{formatMinor(pace.everydaySpentMinor, currency)}</dd>
          </div>
        ) : null}
        {pace.typicalMinor !== null ? (
          <div data-part="typical"><dt>A typical month</dt><dd className="num">{formatMinor(pace.typicalMinor, currency)}</dd></div>
        ) : null}
        <div data-part="one-offs-so-far">
          <dt>{recorded ? 'Large one-offs recorded so far' : pace.oneOffsMinor < 0 ? 'Large one-offs so far, net of refunds for them' : 'Large one-offs so far, as posted'}</dt>
          <dd className="num">{formatMinor(pace.oneOffsMinor, currency)}</dd>
        </div>
        {pace.projectedMinor !== null && pace.oneOffsMinor !== 0 ? (
          <div data-part="month-total">
            <dt>Month total with those one-offs, estimate</dt>
            <dd className="num">
              {formatEstimate(pace.projectedMinor, currency)}
              {total ? <small>{`80% range ${span(total.lowerMinor, total.upperMinor)}`}</small> : null}
            </dd>
          </div>
        ) : null}
      </dl>
      <Sentences items={said.filter((item) => PACE_STATUS.has(item.template))} className="forecast-status" />
    </article>
  );
}

function rangeText(series: CardSeriesForecast, index: number, currency: string): string | null {
  const range = series.months[index]?.range80;
  return range ? `${formatEstimate(range.lowerMinor, currency)}–${formatEstimate(range.upperMinor, currency)}` : null;
}

function SeriesRow({ series, label, currency, months, total, onCategory }: {
  series: CardSeriesForecast;
  label: string;
  currency: string;
  /** The forecast months: a row without an estimate spans them. */
  months: number;
  total?: boolean;
  onCategory?: (category: string) => void;
}) {
  return (
    <tr className={total ? 'total' : undefined} data-thin={series.thin || undefined}>
      <th scope="row">
        {!total && onCategory && series.category ? (
          <button type="button" className="forecast-category" onClick={() => onCategory(series.category!)} aria-label={`Show ${label}`}>{label}</button>
        ) : label}
        {series.thin && !total ? <span className="forecast-note">occasional</span> : null}
      </th>
      {series.months.length > 0 ? series.months.map((item, index) => (
        <td key={item.month} title={range95Sentence(series, index, currency, total ? undefined : label)?.text}>
          <span className="num">{formatEstimate(item.pointMinor, currency)}</span>
          <span className="forecast-cell-range num">{rangeText(series, index, currency) ?? 'no range yet'}</span>
        </td>
      )) : <td colSpan={months} className="forecast-none">No estimate yet</td>}
    </tr>
  );
}

/**
 * The next three months: the headline (all spending without large one-offs, the first month), then a row for all of it
 * and one per category, each month's estimate with its 80% range under it. How each row was made, and how it tested,
 * is folded under "How this was estimated".
 */
function MonthsCard({ forecast, onCategory }: { forecast: SpendingForecastResponse; onCategory?: (category: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const { total, currency } = forecast;
  const labels = useMemo(() => forecastCategoryLabels(forecast.categories.map((item) => item.category!)), [forecast.categories]);
  const shown = expanded ? forecast.categories : forecast.categories.slice(0, VISIBLE_CATEGORIES);
  const headline = forecastHeadline(forecast);
  return (
    <article className="forecast-card" aria-labelledby="forecast-months-title" data-forecast="months">
      <h4 id="forecast-months-title">Next three months</h4>
      <Sentences items={[headline]} />
      {total && total.method !== null ? (
        <>
          <div className="forecast-table-wrap">
            <table className="forecast-table">
              <caption>Estimates, each with its 80% range under it</caption>
              <thead>
                <tr>
                  <th scope="col">{FORECAST_QUANTITY}</th>
                  {forecast.horizon.map((month) => <th scope="col" key={month}>{`${shortMonthLabel(month)} ${month.slice(0, 4)}`}</th>)}
                </tr>
              </thead>
              <tbody>
                <SeriesRow series={total} label="All of it" currency={currency} months={forecast.horizon.length} total />
                {shown.map((series) => (
                  <SeriesRow key={series.category} series={series} label={labels.get(series.category!) ?? series.category!} currency={currency}
                    months={forecast.horizon.length} onCategory={onCategory} />
                ))}
              </tbody>
            </table>
          </div>
          {forecast.categories.length > VISIBLE_CATEGORIES ? (
            <button type="button" className="spending-link" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {expanded ? 'Show fewer' : `Show all (${forecast.categories.length})`}
            </button>
          ) : null}
          {[total, ...shown].some((series) => series.months.some((item) => item.range80 === null)) ? (
            <p className="forecast-help" data-note="no-range">{FORECAST_NO_RANGE_NOTE}</p>
          ) : null}
          <p className="forecast-help" data-note="rows">{FORECAST_ROWS_NOTE}</p>
        </>
      ) : null}
    </article>
  );
}

function UnusualCard({ forecast, patterns, onCategory }: {
  forecast: SpendingForecastResponse;
  patterns: SpendingPatternsResponse;
  onCategory?: (category: string) => void;
}) {
  const labels = useMemo(() => forecastCategoryLabels([
    ...forecast.categories.map((item) => item.category!),
    ...patterns.anomalies.flatMap((item) => (item.category ? [item.category] : [])),
  ]), [forecast.categories, patterns.anomalies]);
  const said = anomalySentences(patterns, labels);
  const notes = said.slice(patterns.anomalies.length);
  return (
    <article className="forecast-card" aria-labelledby="forecast-unusual-title" data-forecast="unusual">
      <h4 id="forecast-unusual-title">Unusual spending</h4>
      {patterns.anomalies.length > 0 ? (
        <>
          <ul className="forecast-sentences">
            {patterns.anomalies.map((item, index) => (
              <li key={`${item.window}-${item.category ?? 'all'}`} data-template={said[index].template} data-direction={item.direction}>
                {said[index].text}
                {item.category && onCategory ? (
                  <button type="button" className="spending-link inline forecast-show" onClick={() => onCategory(item.category!)}>Show</button>
                ) : null}
              </li>
            ))}
          </ul>
          <Sentences items={notes} className="forecast-help" />
        </>
      ) : (
        <>
          <Sentences items={said.slice(0, 1)} />
          <Sentences items={said.slice(1)} className="forecast-help" />
        </>
      )}
    </article>
  );
}

function billNote(bill: CardBill): string {
  if (bill.late) return 'late';
  if (bill.expectedBeforeToday) return 'not in the record yet';
  return CADENCE_WORDS[bill.cadence];
}

/**
 * The recurring bills due, each on its line: the day, the merchant, the amount (about, when it varies), and under them
 * its rhythm, or that it is late or not in the record yet. What shows each one bills is folded with the method.
 */
function BillsCard({ patterns, onMerchant }: { patterns: SpendingPatternsResponse; onMerchant?: (merchant: { key: string; name: string }) => void }) {
  const [expanded, setExpanded] = useState(false);
  const { bills, currency } = patterns;
  const shown = expanded ? bills.items : bills.items.slice(0, VISIBLE_BILLS);
  return (
    <article className="forecast-card" aria-labelledby="forecast-bills-title" data-forecast="bills">
      <h4 id="forecast-bills-title">Recurring bills</h4>
      <Sentences items={billsSentences(bills, patterns.month, currency)} />
      {shown.length > 0 ? (
        <ul className="forecast-bills" aria-label="Recurring bills due">
          {shown.map((bill) => (
            <li key={`${bill.date}-${bill.key}-${bill.amountMinor}`} className="forecast-bill" data-late={bill.late || undefined}
              data-unseen={(bill.expectedBeforeToday && !bill.late) || undefined}>
              <span className="forecast-bill-date num">{shortDate(bill.date)}</span>
              {onMerchant ? (
                <button type="button" className="forecast-category forecast-bill-merchant" onClick={() => onMerchant({ key: bill.key, name: bill.merchant })}>
                  {bill.merchant}
                </button>
              ) : <span className="forecast-bill-merchant">{bill.merchant}</span>}
              <span className="forecast-bill-amount num">{bill.fixed ? '' : 'about '}{formatEstimate(bill.amountMinor, currency)}</span>
              <span className="forecast-bill-note">{billNote(bill)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {bills.items.length > VISIBLE_BILLS ? (
        <button type="button" className="spending-link" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {expanded ? 'Show fewer' : `Show all (${bills.items.length})`}
        </button>
      ) : null}
    </article>
  );
}

/**
 * True once the element has been within `margin` of the viewport while `ready` (the page above it laid out with its
 * answers), and from then on; at once without IntersectionObserver. The panel sits below the fold: it reads its
 * answers only once it is about to be seen, so a hidden tab never reads them, and the short page of a first render,
 * before the tab's own answers are in, does not count.
 */
function useSeen(ref: RefObject<Element | null>, ready: boolean, margin = '400px'): boolean {
  const supported = typeof IntersectionObserver !== 'undefined';
  const [near, setNear] = useState(!supported);
  const [seen, setSeen] = useState(!supported);
  useEffect(() => {
    const element = ref.current;
    if (seen || !element || !supported) return undefined;
    const observer = new IntersectionObserver((entries) => {
      const latest = entries[entries.length - 1];
      if (latest) setNear(latest.isIntersecting);
    }, { rootMargin: margin });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, seen, supported, margin]);
  useEffect(() => { if (near && ready) setSeen(true); }, [near, ready]);
  return seen;
}

/**
 * Whether the forecast, the pace or the anomaly check came out empty for want of complete months: no forecast, an
 * untested one or one without a range; no everyday estimate or no range for it; no month compared.
 */
function wantsCompleteMonths(forecast: SpendingForecastResponse, patterns: SpendingPatternsResponse): boolean {
  const { total, pace } = forecast;
  const forecastEmpty = !total || total.method === null || !total.tested || total.months.every((item) => item.range80 === null);
  const paceEmpty = pace.everydayProjectedMinor === null || pace.everydayRange80 === null;
  return forecastEmpty || paceEmpty || !patterns.checks.some((check) => check.checked);
}

/**
 * Why months can't count yet, card by card, in the overview's own words (`coverageGapSentences`): the cards whose
 * statements stop early, by the names this page gives them (the API sends ids only), how many cards were first seen
 * later, and the fixes. Only while the forecast, the pace or the anomaly check is empty for want of complete months.
 */
function gapSentences(forecast: SpendingForecastResponse, patterns: SpendingPatternsResponse, cards: readonly CardAccount[]): string[] {
  if (!wantsCompleteMonths(forecast, patterns)) return [];
  const cardName = (id: string) => {
    const account = cards.find((item) => item.id === id);
    return account ? cardOptionLabel(account) : 'a card no longer listed';
  };
  return coverageGapSentences(forecast.coverage.gaps, { cardName, firstMonth: forecast.coverage.firstMonth ?? forecast.month });
}

/**
 * The missing-history caveats, always in view under the lead (never folded): the months left out for partial card data,
 * and, while some months can't count yet, how many cards in view keep them from it, with a link to which cards and why
 * (that detail, card by card, is folded with the method, so a long list of cards never walls off the answers).
 */
function Caveats({ forecast, gaps, onShowGaps }: { forecast: SpendingForecastResponse; gaps: readonly string[]; onShowGaps: () => void }) {
  const partial = forecastNotes(forecast).filter((item) => MISSING_HISTORY.has(item.template));
  const summary = gaps.length > 0 ? gapSummaryText(forecast.coverage.gaps) : null;
  if (partial.length === 0 && summary === null) return null;
  return (
    <div className="forecast-caveats" data-forecast="caveats">
      <Sentences items={partial} />
      {summary !== null ? (
        <p className="forecast-caveat-cards" data-caveat="cards">
          {summary}
          {' '}
          <button type="button" className="spending-link inline" onClick={onShowGaps}>Which cards, and why</button>
        </p>
      ) : null}
    </div>
  );
}

/**
 * The panel's answers for one view: the lead, the caveats, the bills and unusual spending, the next three months, and
 * the one fold. The fold's open state is theirs, so another view's answers start with it closed; the caveats' link
 * opens it at the cards behind the missing months and moves focus there.
 */
function ForecastAnswers({ forecast, patterns, cards, onCategory, onMerchant }: {
  forecast: SpendingForecastResponse;
  patterns: SpendingPatternsResponse;
  cards: readonly CardAccount[];
  onCategory?: (category: string) => void;
  onMerchant?: (merchant: { key: string; name: string }) => void;
}) {
  const [howOpen, setHowOpen] = useState(false);
  const [toGaps, setToGaps] = useState(false);
  const gapsHeading = useRef<HTMLHeadingElement>(null);
  const gaps = useMemo(() => gapSentences(forecast, patterns, cards), [forecast, patterns, cards]);
  useEffect(() => {
    if (!toGaps || !howOpen) return;
    gapsHeading.current?.focus();
    setToGaps(false);
  }, [toGaps, howOpen]);
  return (
    <>
      <PaceLead forecast={forecast} />
      <Caveats forecast={forecast} gaps={gaps} onShowGaps={() => { setHowOpen(true); setToGaps(true); }} />
      <div className="forecast-grid">
        <BillsCard patterns={patterns} onMerchant={onMerchant} />
        <UnusualCard forecast={forecast} patterns={patterns} onCategory={onCategory} />
      </div>
      <MonthsCard forecast={forecast} onCategory={onCategory} />
      <HowEstimated forecast={forecast} patterns={patterns} gaps={gaps} open={howOpen} onOpenChange={setHowOpen} gapsHeading={gapsHeading} />
    </>
  );
}

/**
 * The one fold: how the estimates were made and what they rest on, never an answer, a range or a limit. First, while
 * some months can't count, which cards keep them from it and why (the caveats' per-card detail); then this month's
 * method and how its range tested; what the next three months learn from and leave out, the total's method and tests
 * and its next month's 95% range, and each row's method and miss; what makes a bill recurring, and what shows each one
 * bills; what makes a month unusual.
 */
function HowEstimated({ forecast, patterns, gaps, open, onOpenChange, gapsHeading }: {
  forecast: SpendingForecastResponse;
  patterns: SpendingPatternsResponse;
  /** Why months can't count yet, card by card: the caveats' detail, first in the fold. */
  gaps: readonly string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gapsHeading: RefObject<HTMLHeadingElement | null>;
}) {
  const { total, currency } = forecast;
  const pace = paceSentences(forecast.pace, forecast.today, currency).filter((item) => !PACE_LIMITS.has(item.template) && !PACE_STATUS.has(item.template));
  const notes = forecastNotes(forecast).filter((item) => !MISSING_HISTORY.has(item.template));
  const labels = forecastCategoryLabels(forecast.categories.map((item) => item.category!));
  // The total: its method in brief, then its tests in full and the next month's 95% range (each cell's is on its title).
  const range95 = total ? range95Sentence(total, 0, currency) : null;
  const totalSaid = total && total.method !== null ? [
    methodSentence(total, 'All of it', currency, { brief: true }),
    ...backtestSentences(total, currency),
    ...(range95 ? [range95] : []),
  ] : [];
  const rows = forecast.categories.map((series) => methodSentence(series, labels.get(series.category!) ?? series.category!, currency));
  // A bill due twice in the calendar has the same evidence twice: once is enough.
  const evidence = new Map<string, { merchant: string; said: ForecastSentence }>();
  for (const bill of patterns.bills.items) {
    const said = billSentence(bill);
    evidence.set(`${bill.key}|${said.text}`, { merchant: bill.merchant, said });
  }
  return (
    <Disclosure summary="How this was estimated" className="forecast-how" open={open} onOpenChange={onOpenChange}>
      <div className="forecast-how-body" data-forecast="how">
        {gaps.length > 0 ? (
          <section aria-labelledby="forecast-how-gaps">
            <h4 id="forecast-how-gaps" ref={gapsHeading} tabIndex={-1}>Why months can&apos;t count yet</h4>
            <div className="forecast-gaps" role="group" aria-label="Why months can't count yet" data-forecast="gaps">
              <ul>{gaps.map((sentence) => <li key={sentence}>{sentence}</li>)}</ul>
            </div>
          </section>
        ) : null}
        {pace.length > 0 ? (
          <section aria-labelledby="forecast-how-month">
            <h4 id="forecast-how-month">This month</h4>
            <Sentences items={pace} />
          </section>
        ) : null}
        <section aria-labelledby="forecast-how-months">
          <h4 id="forecast-how-months">Next three months</h4>
          <Sentences items={[...notes, ...totalSaid]} />
          {rows.length > 0 ? (
            <>
              <p className="forecast-how-text">{FORECAST_ROWS_METHOD}</p>
              <Sentences items={rows} />
            </>
          ) : null}
        </section>
        <section aria-labelledby="forecast-how-bills">
          <h4 id="forecast-how-bills">Recurring bills</h4>
          <Sentences items={[billsMethodSentence()]} />
          {evidence.size > 0 ? (
            <ul className="forecast-sentences" aria-label="What shows each bill">
              {[...evidence.values()].map(({ merchant, said }) => (
                <li key={`${merchant}-${said.text}`}>
                  <span className="forecast-how-subject">{`${merchant}: `}</span>
                  <span data-template={said.template}>{said.text}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
        <section aria-labelledby="forecast-how-unusual">
          <h4 id="forecast-how-unusual">Unusual spending</h4>
          <Sentences items={[anomalyMethodSentence(currency)]} />
        </section>
      </div>
    </Disclosure>
  );
}

/**
 * Spending's patterns and forecast, as of today, for the cards in view. Its lead comes first and is always in view (the
 * panel's compact state): this month's estimate of spending without large one-offs with its 80% range beside it, then
 * any missing history. Then the answers, one idea to a line: the recurring bills due, what was unusual, and the next
 * three months (all of it and per category, each month's estimate with its 80% range). Only how they were estimated is
 * folded. It reads its own answers (`/spending/forecast`, `/spending/patterns`) once it has been near the screen, and
 * only after the tab's own answers for the view are in and the view has held for a moment (so a change of card or person
 * never waits on it), whatever period the tab shows; and again when the cards in view or the tab's data change.
 */
export function SpendingForecastPanel(props: {
  today: string;
  owner?: CardOwner;
  cardAccountId?: string;
  categoryBasis: CardCategoryBasis;
  /** Bumped when rows change (a category edited, an import): the panel reads again. */
  dataVersion: number;
  /** Whether the tab's own answers for this view are in: the panel reads after them, so they never wait on it. */
  ready?: boolean;
  /** The card accounts, for the names the explanation gives the cards behind (the API sends ids only). */
  cards: readonly CardAccount[];
  onCategory?: (category: string) => void;
  onMerchant?: (merchant: { key: string; name: string }) => void;
}) {
  const { today, owner, cardAccountId, categoryBasis, dataVersion } = props;
  const ready = props.ready ?? true;
  const sectionRef = useRef<HTMLElement>(null);
  const seen = useSeen(sectionRef, ready);
  /**
   * The last outcome, answered or refused, and its view: shown only while it is the view's own (`key`), never under
   * another view's. One state for both, so an answer replaces a refusal and a refusal an answer, and only the latest
   * attempt for the view in front decides what shows.
   */
  const [outcome, setOutcome] = useState<
    | { key: string; kind: 'answer'; forecast: SpendingForecastResponse; patterns: SpendingPatternsResponse }
    | { key: string; kind: 'refused'; message: string }
    | null
  >(null);
  const requestKey = JSON.stringify([today, owner ?? null, cardAccountId ?? null, categoryBasis, dataVersion]);
  /**
   * The view whose answer is shown: the tab reloading its own lists does not read it again. A refused view is read again
   * whenever the panel would read (it comes back, or the tab's own answers reload).
   */
  const answeredKey = useRef<string | null>(null);

  useEffect(() => {
    if (!seen || !ready || answeredKey.current === requestKey) return undefined;
    let cancelled = false;
    const key = requestKey;
    const params = { today, owner, cardAccountId, categoryBasis };
    // Read once the view has held for a moment: a quick run of changes reads once.
    const timer = setTimeout(() => {
      // This attempt alone decides what its view shows: the view's earlier refusal goes now, so the panel says it is
      // busy until the attempt is answered or refused. An attempt superseded (its view gone, or read again) sets nothing.
      setOutcome((prior) => (prior?.key === key ? null : prior));
      Promise.all([fetchSpendingForecast(params), fetchSpendingPatterns(params)])
        .then(([forecast, patterns]) => { if (!cancelled) { answeredKey.current = key; setOutcome({ key, kind: 'answer', forecast, patterns }); } })
        .catch((reason: unknown) => { if (!cancelled) { answeredKey.current = null; setOutcome({ key, kind: 'refused', message: apiErrorMessage(reason) }); } });
    }, SETTLE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
    // requestKey holds every input of the request.
  }, [seen, ready, requestKey]);

  // Only this view's answer, or its refusal: another card's or person's figures are never shown under this one.
  const current = outcome?.key === requestKey ? outcome : null;
  const own = current?.kind === 'answer' ? current : null;
  const failure = current?.kind === 'refused' ? current.message : null;
  // Busy while this view's answers are to be read: seen, and not yet answered or refused.
  const loading = seen && current === null;
  const card = cardAccountId ? props.cards.find((item) => item.id === cardAccountId) ?? null : null;

  return (
    <section ref={sectionRef} className="spending-panel forecast" aria-label="Patterns and forecast" aria-busy={loading}>
      <header className="spending-panel-head forecast-head">
        <h3>Patterns and forecast</h3>
        <p className="forecast-scope">
          <span>{forecastScopeSentence({ today, owner, cardAccountId, card })}</span>
          {' '}
          <span>{FORECAST_FILTERS_NOTE}</span>
          {' '}
          <span data-scope="metals">{FORECAST_METALS_NOTE}</span>
        </p>
      </header>
      {failure ? <p className="spending-error" role="status">{failure}</p> : null}
      {loading ? <p className="spending-muted forecast-loading"><Spinner label="Looking for patterns" testId="forecast-looking" deferred /></p> : null}
      {own ? (
        <ForecastAnswers forecast={own.forecast} patterns={own.patterns} cards={props.cards} onCategory={props.onCategory} onMerchant={props.onMerchant} />
      ) : null}
    </section>
  );
}
