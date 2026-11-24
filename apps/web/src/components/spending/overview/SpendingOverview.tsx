import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { CardAccount, CardSpendingCategoryLine } from '@finance-tracker/shared';

import {
  fetchSpendingAccounting,
  fetchSpendingSummary,
  type SpendingAccountingResponse,
  type SpendingFilters,
  type SpendingSummaryResponse,
} from '../spendingApi';
import {
  cardOptionLabel,
  formatMinor,
  formatRowAmount,
  merchantDisplayName,
  monthBounds,
  rankedCategoryLabels,
  shiftMonth,
  shortDate,
  type SpendingPeriod,
  type SpendingPeriodRange,
} from '../spendingFormat';
import { fetchSpendingCompare, fetchSpendingTrend, type OverviewCompareResponse, type OverviewTrendResponse, type OverviewWindow } from './overviewApi';
import {
  driverSentence,
  oneOffsSentence,
  overviewPeriod,
  remainderSentence,
  signedMoney,
  type OverviewPeriod,
} from './overviewText';
import { figureKnown, headlineComparison, headlineComparisonWindow, unknownText } from './headlineText';
import { NotComparableBlock } from './OverviewNotes';
import { OverviewCategories, unknownSentence, type CategoryActions } from './OverviewCategories';
import { MonthsChart, type MonthsBy } from './OverviewMonthsChart';
import { useViewRead } from './useViewRead';
import { CardOpenings } from '../openings/CardOpenings';
import { TitleWithSpinner } from '../../Spinner';
import { useUpdatingMark } from '../../useUpdatingMark';
import './overview.css';

/** Months in the chart. */
const CHART_MONTHS = 12;
/** Categories named in a part's list; the rest are summed. */
const LISTED = 8;

interface ReadInput {
  /** The Spending tab's filters; the overview sets its own dates. */
  filters: SpendingFilters;
  period: SpendingPeriod;
  range: SpendingPeriodRange;
  month: string;
  today: string;
  currency: string;
  /** Bumped when the data changed: everything is read again. */
  dataVersion: number;
}

/**
 * The overview's one read, shared by every part the Spending tab places (the headline and its comparison, where it
 * went and what changed, by category, the months): the period's totals and what they leave out (its summary and what
 * counts, for the period's own dates), each comparison of the period, and the months. The totals are read on their
 * own, so they show even when a comparison can't be read. Only this view's answers are ever shown: while another view
 * loads, or when it fails, no earlier figures are. While the same view is read again after a change (`dataVersion`),
 * its last answers stay, marked busy, so the page keeps its place; a failed read replaces its answer with its error.
 */
export interface OverviewRead {
  period: OverviewPeriod;
  /** The tab's filters with the period's dates. */
  view: SpendingFilters;
  currency: string;
  today: string;
  /** The data version the answer is for: a part that reads more (a merchant line's rows) reads again with it. */
  version: number;
  /** Not this view's latest answers yet: reading, or reading again. */
  busy: boolean;
  /** The comparisons and months (`results`, `trend`) are being read, or read again. */
  compareBusy: boolean;
  /** The period's totals (`totals`) are being read, or read again. */
  totalsBusy: boolean;
  /**
   * The comparisons and months on screen are the last read's while the same view is read again, and a moment after the
   * new ones land (useUpdatingMark): mark them. Never on a view's first read, which shows nothing earlier.
   */
  compareUpdating: boolean;
  /** As `compareUpdating`, for the totals. */
  totalsUpdating: boolean;
  /** Either: a part that reads both is marked. */
  updating: boolean;
  failure: string | null;
  results: Map<string, OverviewCompareResponse>;
  /** The first comparison's answer: the period's own window, and the one-off threshold. */
  first: OverviewCompareResponse | null;
  current: OverviewWindow | null;
  trend: OverviewTrendResponse | null;
  /** The period's summary (its total, and what is not in it) and what counts, for the same dates; null until in. */
  totals: { summary: SpendingSummaryResponse; accounting: SpendingAccountingResponse | null } | null;
  totalsFailure: string | null;
}

function useOverviewRead(input: ReadInput): OverviewRead {
  const { filters, currency, today, dataVersion } = input;
  const period = useMemo(() => overviewPeriod(input.period, input.range, input.month, today), [input.period, input.range, input.month, today]);
  const view = useMemo<SpendingFilters>(() => ({
    owner: filters.owner, cardAccountId: filters.cardAccountId, category: filters.category, merchant: filters.merchant,
    q: filters.q, categoryBasis: filters.categoryBasis, from: period.from, to: period.to,
  }), [filters.owner, filters.cardAccountId, filters.category, filters.merchant, filters.q, filters.categoryBasis, period.from, period.to]);
  const viewKey = JSON.stringify([view, period.comparisons, currency, today]);
  const compared = useViewRead(viewKey, dataVersion, () => Promise.all([
    Promise.all(period.comparisons.map((item) => fetchSpendingCompare(view, item, { today, currency }).then((body) => [item.key, body] as const))),
    fetchSpendingTrend(view, { fromMonth: shiftMonth(period.toMonth, -(CHART_MONTHS - 1)), toMonth: period.toMonth }, { today, currency }),
  ]).then(([results, trend]) => ({ results: new Map(results), trend })));
  // The headline's total and what it leaves out: the period's own dates, as its comparison reads them.
  const totals = useViewRead(viewKey, dataVersion, () => Promise.all([
    fetchSpendingSummary(view),
    // What counts is said beside the figures; without it they still show.
    fetchSpendingAccounting(view).catch(() => null),
  ]).then(([summary, accounting]) => ({ summary, accounting })));

  const results = compared.answer?.results ?? new Map<string, OverviewCompareResponse>();
  const first = period.comparisons.map((item) => results.get(item.key)).find((item) => item !== undefined) ?? null;
  // Each read marks only its own figures, and only while they are on screen: a first read shows none to mark.
  const compareUpdating = useUpdatingMark(compared.busy && compared.answer !== null, { view: viewKey, failed: compared.error !== null });
  const totalsUpdating = useUpdatingMark(totals.busy && totals.answer !== null, { view: viewKey, failed: totals.error !== null });
  return {
    period,
    view,
    currency,
    today,
    version: dataVersion,
    busy: compared.busy || totals.busy,
    compareBusy: compared.busy,
    totalsBusy: totals.busy,
    compareUpdating,
    totalsUpdating,
    updating: compareUpdating || totalsUpdating,
    failure: compared.error,
    results,
    first,
    current: first?.comparison.current ?? null,
    trend: compared.answer?.trend ?? null,
    totals: totals.answer,
    totalsFailure: totals.error,
  };
}

/**
 * The Spending overview: one read of the period (useOverviewRead), shared by the parts the Spending tab places in its
 * own order inside this region (`children`): the headline and its comparison, where it went and what changed, by
 * category, the transactions, and the months. Every figure comes from the API's exact split; nothing here adds amounts
 * the API has not already reconciled, and a period is compared with another only when both are complete.
 */
export function SpendingOverview(props: ReadInput & { children: (read: OverviewRead) => ReactNode }) {
  const read = useOverviewRead(props);
  return (
    <section className="spending-overview" aria-label="Spending overview" aria-busy={read.busy} data-testid="spending-overview">
      {props.children(read)}
    </section>
  );
}

/** Where it went beside what changed: one panel, two blocks (side by side on wide screens). */
export function OverviewBreakdown({ read, previous, onOpen }: {
  read: OverviewRead;
  /** The baseline the tab's period names: What changed starts on the comparison the headline makes. */
  previous: SpendingPeriodRange['previous'];
  onOpen: (id: string) => void;
}) {
  const defaultComparison = headlineComparisonWindow(read.period, previous)?.key ?? 'previous';
  const [open, setOpen] = useState<PartId | null>(null);
  const [selected, setSelected] = useState<'previous' | 'year'>(defaultComparison);
  // Another period starts on the headline's comparison again.
  useEffect(() => { setSelected(defaultComparison); }, [defaultComparison, read.period.name]);
  if (!read.current) return null;
  // Read again after a change: each block's figures stay, dimmed, with a spinner beside its title, until the new answer.
  const updating = read.updating;
  return (
    <div className="spending-panel overview-pair" data-testid="overview-breakdown">
      <WhereItWent window={read.current} blocked={blockedSentence(read)} thresholdMinor={read.first?.comparison.thresholdMinor ?? 0} currency={read.currency}
        open={open} onToggle={(part) => setOpen((now) => (now === part ? null : part))} onOpen={onOpen} updating={updating} />
      <WhatChanged period={read.period} results={read.results} selected={selected} onSelect={setSelected} currency={read.currency} updating={updating} />
    </div>
  );
}

/** The one category view (plan D3), in a panel of its own: categories or merchants, each opening in place. */
export function OverviewByCategory({ read, onOpen, ...actions }: CategoryActions & { read: OverviewRead; onOpen: (id: string) => void }) {
  if (!read.current) return null;
  return (
    <div className="spending-panel overview-panel">
      <OverviewCategories {...actions} window={read.current} summary={read.totals?.summary ?? null} summaryFailure={read.totalsFailure}
        blocked={blockedSentence(read)} periodName={read.period.name} filters={read.view} version={read.version} currency={read.currency} onOpen={onOpen}
        updating={read.updating} />
    </div>
  );
}

/** The months, with the card opening months they open, in a panel of its own. */
export function OverviewMonths({ read, cards, selected, onMonth, onDataChanged }: {
  read: OverviewRead;
  /** The card accounts, for the names the months' note gives the cards behind (the API sends ids only). */
  cards: readonly CardAccount[];
  /** The month shown (pressed), or none while a span such as the last 90 days is shown. */
  selected: string | null;
  onMonth: (month: string) => void;
  /** The owner confirmed or cleared a card's opening month: every figure that reads coverage is read again. */
  onDataChanged?: () => void;
}) {
  /** The owner's card opening months, opened from the months' note. */
  const [openings, setOpenings] = useState(false);
  const [by, setBy] = useState<MonthsBy>('type');
  // By person: the view's summary over the chart's months, read only while it is shown, again with the data version.
  const firstMonth = shiftMonth(read.period.toMonth, -(CHART_MONTHS - 1));
  const personsView = useMemo<SpendingFilters>(() => ({ ...read.view, from: monthBounds(firstMonth).from, to: monthBounds(read.period.toMonth).to }),
    [read.view, firstMonth, read.period.toMonth]);
  const personsKey = JSON.stringify([personsView, read.currency]);
  const persons = useViewRead(personsKey, read.version, () => fetchSpendingSummary(personsView), by === 'person');
  // By person, its months read again while shown: marked as the comparison's are.
  const personsUpdating = useUpdatingMark(by === 'person' && persons.busy && persons.answer !== null,
    { view: `${by}:${personsKey}`, failed: persons.error !== null });
  if (!read.trend || read.trend.months.length === 0) return null;
  const cardName = (id: string) => {
    const account = cards.find((item) => item.id === id);
    return account ? cardOptionLabel(account) : 'a card no longer listed';
  };
  return (
    <div className="spending-panel overview-panel">
      <MonthsChart trend={read.trend} by={by} onBy={setBy} persons={persons} currency={read.currency} selected={selected} onMonth={onMonth}
        cardName={cardName} openings={openings} onOpenings={() => setOpenings(true)}
        updating={read.compareUpdating || personsUpdating} />
      {openings ? (
        <CardOpenings today={read.today} cards={cards} view={{ owner: read.view.owner, cardAccountId: read.view.cardAccountId }}
          onChanged={() => onDataChanged?.()} onClose={() => setOpenings(false)} />
      ) : null}
    </div>
  );
}

/**
 * Why the parts and the categories are not shown beside the headline's total, when it is not known: its own read failed
 * (the headline says so under its "—"), or the period is not on record (the headline's rule: no posted spending, and not
 * every card expected recorded for all of it: "Not recorded", "No card data"). Null when the total is known (or still
 * being read). Never $0 parts beside an unknown total.
 */
function blockedSentence(read: OverviewRead): string | null {
  if (read.totalsFailure) return `Not shown: the total for ${read.period.name} couldn't be read`;
  const window = read.current;
  if (!window || figureKnown(window.count, window.coverage)) return null;
  return unknownSentence(unknownText(window.coverage), read.period.name);
}

const PARTS = [
  { id: 'recurring', label: 'Recurring', field: 'recurringMinor' },
  { id: 'oneOffs', label: 'Large one-offs', field: 'oneOffMinor' },
  { id: 'other', label: 'Other spending', field: 'everydayMinor' },
] as const;
type PartId = typeof PARTS[number]['id'];

/** Recurring, large one-offs and other spending: a bar, the three amounts once, and each part's list. */
function WhereItWent(props: {
  window: OverviewWindow;
  /** Why no part is shown (the total is not known), else null. */
  blocked: string | null;
  thresholdMinor: number;
  currency: string;
  open: PartId | null;
  onToggle: (part: PartId) => void;
  onOpen: (id: string) => void;
  /** The same view is being read again: the figures shown are the last read's. */
  updating: boolean;
}) {
  const { window, currency } = props;
  const money = (minor: number) => formatMinor(minor, currency);
  const head = (
    <div className="overview-block-head">
      <TitleWithSpinner busy={props.updating}><h3>Where it went</h3></TitleWithSpinner>
    </div>
  );
  const updating = props.updating ? 'true' : undefined;
  if (props.blocked !== null) {
    return (
      <div className="overview-block" role="group" aria-label="Where it went" data-updating={updating}>
        {head}
        <p className="overview-unknown" data-testid="overview-parts-unknown">{props.blocked}</p>
      </div>
    );
  }
  const positive = PARTS.reduce((sum, part) => sum + Math.max(0, window[part.field]), 0);
  const other = otherCategories(window.categories);
  return (
    <div className="overview-block" role="group" aria-label="Where it went" data-updating={updating}>
      {head}
      <div className="overview-bar" aria-hidden="true">
        {PARTS.map((part) => (window[part.field] > 0 && positive > 0 ? (
          <span key={part.id} className={`overview-bar-part ov-${part.id}`} style={{ width: `${(window[part.field] / positive) * 100}%` }} />
        ) : null))}
      </div>
      <ul className="overview-parts">
        {PARTS.map((part) => (
          <li key={part.id}>
            <button type="button" className={`overview-part ov-${part.id}`} aria-expanded={props.open === part.id} onClick={() => props.onToggle(part.id)}
              data-testid={`overview-part-${part.id}`}>
              <span className="overview-swatch" aria-hidden="true" />
              <span>{part.label}</span>
              <strong className="num">{money(window[part.field])}</strong>
            </button>
          </li>
        ))}
      </ul>
      {props.open === 'recurring' ? (
        <ul className="overview-list" aria-label="Recurring charges">
          {window.recurring.length === 0 ? <li className="spending-muted">No recurring charges in this period.</li> : window.recurring.map((line) => (
            <li key={line.key}>
              <span title={line.name}>{merchantDisplayName(line.name, line.key)}</span>
              <span className="spending-muted">{line.count} {line.count === 1 ? 'charge' : 'charges'}</span>
              <strong className="num">{money(line.amountMinor)}</strong>
            </li>
          ))}
        </ul>
      ) : null}
      {props.open === 'oneOffs' ? (
        <ul className="overview-list" aria-label="Large one-offs" data-testid="overview-one-offs">
          {window.oneOffs.items.length === 0 && window.oneOffs.refundsMinor === 0
            ? <li className="spending-muted">No large one-offs in this period.</li> : null}
          {window.oneOffs.items.map((item) => (
            <li key={item.id}>
              <button type="button" className="spending-link inline" onClick={() => props.onOpen(item.id)}>{merchantDisplayName(item.merchant, item.key)}</button>
              <span className="spending-muted">{shortDate(item.date)} · {item.category}{item.refundedMinor > 0 ? ` · ${money(item.refundedMinor)} refunded since` : ''}</span>
              <strong className="num">{money(item.amountMinor)}</strong>
            </li>
          ))}
          {window.oneOffs.refundsMinor !== 0 ? (
            <li>
              <span>Refunds of large one-offs</span>
              <span className="spending-muted">dated in this period</span>
              <strong className="num">{formatRowAmount(window.oneOffs.refundsMinor, currency)}</strong>
            </li>
          ) : null}
          <li className="overview-list-total">
            <span>Large one-offs</span>
            <span className="spending-muted">{`purchases of ${money(props.thresholdMinor)} or more, not at a recurring merchant`}</span>
            <strong className="num">{money(window.oneOffMinor)}</strong>
          </li>
        </ul>
      ) : null}
      {props.open === 'other' ? (
        <ul className="overview-list" aria-label="Other spending by category">
          {other.map((line) => (
            <li key={line.category}>
              <span>{line.category}</span>
              <span className="spending-muted">{line.others > 0 ? `${line.others} categories` : ''}</span>
              <strong className="num">{money(line.everydayMinor)}</strong>
            </li>
          ))}
          <li className="overview-list-total"><span>Other spending</span><span /><strong className="num">{money(window.everydayMinor)}</strong></li>
        </ul>
      ) : null}
    </div>
  );
}

/** Other spending by category, the largest {@link LISTED} named and the rest summed, adding up to the part. */
function otherCategories(lines: readonly CardSpendingCategoryLine[]) {
  const sorted = lines.filter((line) => line.everydayMinor !== 0).sort((a, b) => b.everydayMinor - a.everydayMinor || (a.category < b.category ? -1 : 1));
  const named = sorted.slice(0, LISTED).map((line) => ({ category: line.category, everydayMinor: line.everydayMinor, others: 0 }));
  const rest = sorted.slice(LISTED);
  return rest.length === 0 ? named
    : [...named, { category: 'Other categories', everydayMinor: rest.reduce((sum, line) => sum + line.everydayMinor, 0), others: rest.length }];
}

/**
 * What changed against each baseline, when both periods can be compared: "this period vs the baseline" on every line
 * (large one-offs apart, the drivers with their merchants, everything else, the total). Otherwise "Not comparable",
 * with the two figures and why, and nothing split.
 */
function WhatChanged(props: {
  period: OverviewPeriod;
  results: Map<string, OverviewCompareResponse>;
  selected: 'previous' | 'year';
  onSelect: (key: 'previous' | 'year') => void;
  currency: string;
  /** The same view is being read again: the figures shown are the last read's. */
  updating: boolean;
}) {
  const { period, currency } = props;
  const item = period.comparisons.find((entry) => entry.key === props.selected) ?? period.comparisons[0];
  const result = item ? props.results.get(item.key) : undefined;
  if (!item || !result) return null;
  const { comparison } = result;
  const labels = rankedCategoryLabels(comparison.drivers.map((driver) => driver.category));
  const baselineName = item.baselineName;
  const compared = headlineComparison(comparison.current, comparison.baseline, { currency, periodName: period.name, baselineName });
  const updating = props.updating ? 'true' : undefined;
  const title = <TitleWithSpinner busy={props.updating}><h3>What changed</h3></TitleWithSpinner>;
  const tabs = period.comparisons.length > 1 ? (
    <div className="overview-tabs" role="group" aria-label="Compare with">
      {period.comparisons.map((entry) => (
        <button key={entry.key} type="button" aria-pressed={entry.key === item.key} className={`overview-toggle${entry.key === item.key ? ' active' : ''}`}
          onClick={() => props.onSelect(entry.key)}>
          {entry.label}
        </button>
      ))}
    </div>
  ) : <span className="spending-muted">{item.label}</span>;
  if (compared.kind === 'notComparable') {
    return (
      <div className="overview-block" role="group" aria-label="What changed" data-updating={updating}>
        <div className="overview-block-head">{title}{tabs}</div>
        <NotComparableBlock comparison={compared} whyAbout={['current', 'baseline', 'both']} testId="overview-changes-not-comparable" />
      </div>
    );
  }
  const vs = (current: number, baseline: number) => `${formatMinor(current, currency)} vs ${formatMinor(baseline, currency)}`;
  return (
    <div className="overview-block" role="group" aria-label="What changed" data-updating={updating}>
      <div className="overview-block-head">
        {title}
        {tabs}
      </div>
      <p className="overview-changes-head" data-testid="overview-changes-head">{`${capitalize(period.name)} vs ${baselineName}`}</p>
      <ul className="overview-changes" data-testid="overview-changes">
        <li aria-label={oneOffsSentence(comparison.current.oneOffMinor, comparison.baseline.oneOffMinor, { currency, periodName: period.name, baselineName })}>
          <span>Large one-offs</span>
          <span className="spending-muted num">{vs(comparison.current.oneOffMinor, comparison.baseline.oneOffMinor)}</span>
          <strong className="num">{signedMoney(comparison.oneOffDeltaMinor, currency)}</strong>
        </li>
        {comparison.drivers.map((driver) => (
          <li key={driver.category} aria-label={driverSentence(driver, { currency, baselineName, merchantName: merchantDisplayName })}>
            <span title={driver.category}>{labels.get(driver.category) ?? driver.category}</span>
            <span className="spending-muted num">{vs(driver.currentMinor, driver.baselineMinor)}</span>
            <strong className="num">{signedMoney(driver.deltaMinor, currency)}</strong>
            <span className="spending-muted overview-merchants">
              {driver.merchants.map((merchant) => `${merchantDisplayName(merchant.name, merchant.key)}${merchant.itemized ? ' items' : ''} ${signedMoney(merchant.deltaMinor, currency)}`)
                .concat(driver.otherMerchants.lines > 0 ? [`${driver.otherMerchants.lines} more ${signedMoney(driver.otherMerchants.deltaMinor, currency)}`] : [])
                .join(' · ')}
            </span>
          </li>
        ))}
        {/* Everything else, when there is anything in it: no line for no category and no change. */}
        {comparison.remainder.categories > 0 || comparison.remainder.deltaMinor !== 0 ? (
          <li aria-label={remainderSentence(comparison.remainder.deltaMinor, comparison.remainder.categories, { currency, baselineName })}>
            <span>Everything else</span>
            <span className="spending-muted">{comparison.remainder.categories} {comparison.remainder.categories === 1 ? 'category' : 'categories'}</span>
            <strong className="num">{signedMoney(comparison.remainder.deltaMinor, currency)}</strong>
          </li>
        ) : null}
        <li className="overview-list-total">
          <span>Total change</span>
          <span className="spending-muted num">{vs(comparison.current.spendingMinor, comparison.baseline.spendingMinor)}</span>
          <strong className="num" data-testid="overview-change-total">{signedMoney(comparison.deltaMinor, currency)}</strong>
        </li>
      </ul>
    </div>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}