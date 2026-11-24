import { useEffect, useId, useRef, useState } from 'react';
import { formatPercent, formatShownAmount, formatShownPercent, type ShownValue } from '@finance-tracker/shared';

import { api } from '../services/api';
import { onPageRetired } from '../services/browserCache';
import { usePortfolioStore } from '../stores/portfolio';
import type { StoreOp } from '../stores/storeOp';
import { Disclosure } from './Disclosure';
import { EMPTY_GOAL, readGoal, writeGoal, type GoalDraft } from './performanceGoal';
import { toneClass } from './tone';
import './portfolio.css';

type PeriodKey = 'YTD' | '1Y' | '3Y' | '5Y' | 'COMPLETE' | 'INCEPTION';

interface BenchmarkReturn {
  return: number;
  annualized: number | null;
  /** Dates of the two closes used. */
  from: string;
  to: string;
}

interface PerformanceFigures {
  from: string;
  to: string;
  partial: boolean;
  startValue: number;
  endValue: number;
  gain: number;
  netFlows: number;
  timeWeighted: number;
  timeWeightedAnnualized: number | null;
  moneyWeighted: number | null;
  moneyWeightedAnnualized: number | null;
  benchmarks: Record<string, BenchmarkReturn | null>;
}

interface PerformanceResponse {
  supported: boolean;
  reason?: string;
  asOf?: string;
  inception?: string;
  completeFrom?: string | null;
  benchmarks?: string[];
  periods?: Array<PerformanceFigures & { key: PeriodKey }>;
  years?: Array<PerformanceFigures & { year: number; ytd: boolean }>;
  notes?: string[];
  approximationReasons?: string[];
}

const PERIOD_LABELS: Record<PeriodKey, string> = {
  YTD: 'Year to date',
  '1Y': '1 year',
  '3Y': '3 years',
  '5Y': '5 years',
  COMPLETE: 'Full records',
  INCEPTION: 'All history',
};
const PERIOD_PARTIAL_NOTE = "Partial: starts before every account's broker records are complete.";
const YEAR_PARTIAL_NOTE = 'Partial: covers only part of the year, or starts before complete broker records.';
const DAY_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const MONTH_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const COMPACT_CURRENCY = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});
// The report replays the whole ledger; reopening the Return view within this
// window reuses it instead of asking again. Each report keeps the store
// operation it was fetched under, and counts only while that is current: a
// sign-out (here or in another tab) or a store reset outdates it.
const REPORT_REUSE_MS = 2 * 60_000;
const loadedReports = new Map<string, { at: number; op: StoreOp; data: PerformanceResponse }>();
onPageRetired(() => loadedReports.clear());

function recentReport(accountsKey: string): PerformanceResponse | null {
  const entry = loadedReports.get(accountsKey);
  if (!entry) return null;
  if (!entry.op.current()) {
    loadedReports.delete(accountsKey);
    return null;
  }
  return Date.now() - entry.at < REPORT_REUSE_MS ? entry.data : null;
}

interface Props {
  /** Optional account scope. Empty / omitted → household-wide. */
  accountIds?: string[];
  /** Show the goal tracker (household view). */
  showGoal?: boolean;
  /**
   * The panel stands alone (the Portfolio page's Performance section) rather than under a Return chart that
   * already explains a scope without a ledger: say why there are no results instead of rendering nothing.
   */
  standalone?: boolean;
}

/**
 * Long-run performance: trailing periods and calendar years with time- and money-weighted returns next to QQQ and
 * SPY, plus an optional goal tracker. The results stay in view; only how they are calculated folds away. Loads once
 * per account scope, independent of the chart's range.
 */
export function PerformancePanel({ accountIds, showGoal = false, standalone = false }: Props) {
  const accountsKey = accountIds?.join(',') ?? '';
  const [loaded, setLoaded] = useState<{ key: string; data: PerformanceResponse } | null>(() => {
    const report = recentReport(accountsKey);
    return report ? { key: accountsKey, data: report } : null;
  });
  const [error, setError] = useState<string | null>(null);
  const ids = useId();
  const beginOp = usePortfolioStore((s) => s.beginOp);

  useEffect(() => {
    setError(null);
    const report = recentReport(accountsKey);
    if (report) {
      setLoaded({ key: accountsKey, data: report });
      return undefined;
    }
    let cancelled = false;
    const op = beginOp();
    const query = accountsKey ? `?accounts=${encodeURIComponent(accountsKey)}` : '';
    api<PerformanceResponse>(`/portfolio/performance${query}`)
      .then((response) => {
        op.commit(() => {
          loadedReports.set(accountsKey, { at: Date.now(), op, data: response });
          if (!cancelled) setLoaded({ key: accountsKey, data: response });
        });
      })
      .catch((e: unknown) => {
        op.commit(() => {
          if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load performance');
        });
      });
    return () => { cancelled = true; };
  }, [accountsKey, beginOp]);

  const data = loaded?.key === accountsKey ? loaded.data : null;
  if (error) {
    return <p className="performance-status muted" role="status" title={error}>Performance is unavailable right now.</p>;
  }
  if (!data) {
    return <p className="performance-status muted" role="status" aria-busy="true">Loading performance…</p>;
  }
  if (!data.supported || !data.asOf || !data.periods || !data.years) {
    // Under a Return chart, the chart above already explains a scope without a ledger.
    return standalone
      ? <p className="performance-status muted" role="status">{data.reason ?? 'Performance needs recorded transactions or broker cash history.'}</p>
      : null;
  }

  const benchmarks = data.benchmarks ?? [];
  const inception = data.periods.find((period) => period.key === 'INCEPTION') ?? null;
  const trailingYear = data.periods.find((period) => period.key === '1Y') ?? null;
  const anyPartialPeriod = data.periods.some((period) => period.partial);
  const anyPartialYear = data.years.some((year) => year.partial);

  return (
    <div className="performance-panel">
      <section className="performance-section" aria-labelledby={`${ids}-periods`}>
        <div className="performance-heading">
          <h3 id={`${ids}-periods`}>Returns by period</h3>
          <p>
            {benchmarks.length > 0
              ? `Compare the time-weighted return with ${benchmarks.join(' and ')}`
              : 'Time-weighted and money-weighted returns'}
          </p>
        </div>
        <div className="performance-table-wrap">
          {/* Explicit table roles: on a phone the rows stack into labelled blocks (portfolio.css), and a change of
            * display must not cost a screen reader the table. Each value carries its column's name as data-label. */}
          <table className="performance-table performance-periods" role="table">
            <thead role="rowgroup">
              <tr role="row">
                <th scope="col" role="columnheader">Period</th>
                <th scope="col" role="columnheader">Time-weighted</th>
                {benchmarks.map((symbol) => <th scope="col" role="columnheader" key={symbol}>{symbol}</th>)}
                <th scope="col" role="columnheader">Money-weighted</th>
                <th scope="col" role="columnheader">Gain</th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {data.periods.map((period) => (
                <tr key={period.key} role="row" className={period.partial ? 'partial' : undefined}>
                  <th scope="row" role="rowheader">
                    {PERIOD_LABELS[period.key]}
                    {period.partial ? <span className="performance-tag">Partial</span> : null}
                    <span className="performance-sub">from {formatDay(period.from)}</span>
                  </th>
                  <RateCell label="Time-weighted" total={period.timeWeighted} annualized={period.timeWeightedAnnualized} />
                  {benchmarks.map((symbol) => (
                    <BenchmarkCell key={symbol} label={symbol} value={period.benchmarks[symbol] ?? null} annualize />
                  ))}
                  <RateCell label="Money-weighted" total={period.moneyWeighted} annualized={period.moneyWeightedAnnualized} />
                  <ValueCell label="Gain" className={toneClass(formatCompactSigned(period.gain).tone)} value={formatCompactSigned(period.gain).text} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {anyPartialPeriod ? <p className="performance-footnote">{PERIOD_PARTIAL_NOTE}</p> : null}
      </section>

      <section className="performance-section" aria-labelledby={`${ids}-years`}>
        <div className="performance-heading">
          <h3 id={`${ids}-years`}>Calendar years</h3>
          <p>Added is money in minus money out</p>
        </div>
        <div className="performance-table-wrap">
          <table className="performance-table performance-years" role="table">
            <thead role="rowgroup">
              <tr role="row">
                <th scope="col" role="columnheader">Year</th>
                <th scope="col" role="columnheader">Time-weighted</th>
                {benchmarks.map((symbol) => <th scope="col" role="columnheader" key={symbol}>{symbol}</th>)}
                <th scope="col" role="columnheader">Money-weighted</th>
                <th scope="col" role="columnheader">Gain</th>
                <th scope="col" role="columnheader">Added</th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {[...data.years].reverse().map((year) => (
                <tr key={year.year} role="row" className={year.partial ? 'partial' : undefined}>
                  <th scope="row" role="rowheader">
                    {year.ytd ? `${year.year} YTD` : year.year}
                    {year.partial ? <span className="performance-tag">Partial</span> : null}
                  </th>
                  <RateCell label="Time-weighted" total={year.timeWeighted} annualized={null} />
                  {benchmarks.map((symbol) => (
                    <BenchmarkCell key={symbol} label={symbol} value={year.benchmarks[symbol] ?? null} annualize={false} />
                  ))}
                  <RateCell label="Money-weighted" total={year.moneyWeighted} annualized={null} />
                  <ValueCell label="Gain" className={toneClass(formatCompactSigned(year.gain).tone)} value={formatCompactSigned(year.gain).text} />
                  <ValueCell label="Added" value={formatCompactSigned(year.netFlows).text} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {anyPartialYear ? <p className="performance-footnote">{YEAR_PARTIAL_NOTE}</p> : null}
      </section>

      {showGoal && inception ? (
        <GoalTracker
          asOf={data.asOf}
          currentValue={inception.endValue}
          recentAdded={trailingYear?.netFlows ?? inception.netFlows}
          recentAddedLabel={trailingYear
            ? 'the last 12 months\u2019 net money added'
            : `net money added since ${formatDay(inception.from)}`}
          rate={inception.moneyWeightedAnnualized}
          rateFrom={inception.from}
        />
      ) : null}

      {(data.notes?.length ?? 0) + (data.approximationReasons?.length ?? 0) > 0 ? (
        <Disclosure className="performance-notes" summary="How returns are calculated">
          <ul>
            {(data.notes ?? []).map((note) => <li key={note}>{note}</li>)}
            {(data.approximationReasons ?? []).map((reason) => <li key={`estimate:${reason}`}>value estimate: {reason}</li>)}
          </ul>
        </Disclosure>
      ) : null}
    </div>
  );
}

/** A table cell whose value sits in .performance-value, named by data-label for the phone's stacked layout. */
function ValueCell({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <td role="cell" className={className} data-label={label}>
      <span className="performance-value">{value}</span>
    </td>
  );
}

function RateCell({ label, total, annualized }: { label: string; total: number | null; annualized: number | null }) {
  if (total == null) return <ValueCell label={label} className="muted" value="—" />;
  // A rate that reads zero is unsigned and in neither colour.
  const shown = formatShownPercent((annualized ?? total) * 100, { signed: true });
  return (
    <td role="cell" className={toneClass(shown.tone)} data-label={label}>
      <span className="performance-value">
        {shown.text}
        {annualized != null ? (
          <>
            <span className="performance-unit">/yr</span>
            <span className="performance-sub">{formatShownPercent(total * 100, { signed: true }).text} total</span>
          </>
        ) : null}
      </span>
    </td>
  );
}

function BenchmarkCell({ label, value, annualize }: { label: string; value: BenchmarkReturn | null; annualize: boolean }) {
  if (value == null) return <ValueCell label={label} className="performance-benchmark" value="—" />;
  const annualized = annualize ? value.annualized : null;
  return (
    <td
      role="cell"
      className="performance-benchmark"
      data-label={label}
      title={value.from && value.to ? `Closes ${formatDay(value.from)} to ${formatDay(value.to)}` : undefined}
    >
      <span className="performance-value">
        {formatShownPercent((annualized ?? value.return) * 100, { signed: true }).text}
        {annualized != null ? (
          <>
            <span className="performance-unit">/yr</span>
            <span className="performance-sub">{formatShownPercent(value.return * 100, { signed: true }).text} total</span>
          </>
        ) : null}
      </span>
    </td>
  );
}

/** This browser's localStorage, or null where it refuses storage (a goal then lasts as long as the page). */
function goalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The household goal. A new household has none: the section offers to set one and shows no target and no progress
 * until someone enters it. A goal is kept in this browser (performanceGoal.ts) until it is removed.
 */
function GoalTracker({ asOf, currentValue, recentAdded, recentAddedLabel, rate, rateFrom }: {
  asOf: string;
  currentValue: number;
  /** Default yearly additions (signed: withdrawals are negative). */
  recentAdded: number;
  recentAddedLabel: string;
  /** Money-weighted annual rate to project with; null when unknown. */
  rate: number | null;
  rateFrom: string;
}) {
  const [draft, setDraft] = useState<GoalDraft | null>(() => readGoal(goalStorage()));
  const ids = useId();
  const targetInput = useRef<HTMLInputElement>(null);
  const setButton = useRef<HTMLButtonElement>(null);
  // Where focus goes once "Set a goal" or "Remove goal" has swapped the section's contents.
  const focusNext = useRef<'target' | 'set' | null>(null);

  useEffect(() => {
    writeGoal(goalStorage(), draft);
    if (focusNext.current === 'target') targetInput.current?.focus();
    if (focusNext.current === 'set') setButton.current?.focus();
    focusNext.current = null;
  }, [draft]);

  if (!draft) {
    return (
      <section className="performance-section performance-goal" aria-labelledby={`${ids}-goal`}>
        <div className="performance-heading">
          <h3 id={`${ids}-goal`}>Goal</h3>
          <p>Not set</p>
        </div>
        <div className="performance-goal-empty">
          <p>Set a target and a date to see the yearly return it needs and where your current rate leads.</p>
          <button
            ref={setButton}
            type="button"
            className="performance-goal-button"
            onClick={() => {
              focusNext.current = 'target';
              setDraft(EMPTY_GOAL);
            }}
          >
            Set a goal
          </button>
        </div>
      </section>
    );
  }

  const target = Number(draft.target);
  const update = (field: keyof GoalDraft, value: string) => setDraft((current) => ({ ...(current ?? EMPTY_GOAL), [field]: value }));
  const added = draft.yearlyAdded.trim() === '' ? recentAdded : Number(draft.yearlyAdded);
  const years = isIsoDate(draft.by) ? daysBetween(asOf, draft.by) / 365.25 : Number.NaN;
  const valid = draft.target.trim() !== '' && Number.isFinite(target) && target > 0
    && Number.isFinite(added) && Number.isFinite(years) && years > 0;
  const reached = valid && currentValue >= target;
  const needed = valid && !reached ? requiredRate(currentValue, added, target, years) : null;
  const projected = valid && rate != null ? futureValue(currentValue, added, rate, years) : null;

  return (
    <section className="performance-section performance-goal" aria-labelledby={`${ids}-goal`}>
      <div className="performance-heading">
        <h3 id={`${ids}-goal`}>Goal</h3>
        <p>
          {valid
            ? `${formatCompactCurrency(target)} by ${formatDay(draft.by)} · ${years.toFixed(1)} years left`
            : `Enter a target above $0 and a date after ${formatDay(asOf)}`}
        </p>
      </div>
      <div className="performance-goal-stats">
        <div className="performance-goal-stat">
          <span>Needed</span>
          <strong>
            {!valid ? '—' : reached ? 'Reached' : needed == null ? 'Over 1000%/yr' : `${formatPercent(needed * 100)}/yr`}
          </strong>
          <small>{valid ? `with ${formatCompactCurrency(added)} added a year` : '\u00a0'}</small>
        </div>
        <div className="performance-goal-stat">
          <span>Your rate</span>
          <strong>{rate == null ? '—' : `${formatPercent(rate * 100)}/yr`}</strong>
          <small>
            money-weighted since {formatMonth(rateFrom)}
            {rate == null || needed == null || reached
              ? ''
              : rate >= needed
                ? ' · on track'
                : ` · ${((needed - rate) * 100).toFixed(1)} pts short`}
          </small>
        </div>
        <div className="performance-goal-stat">
          <span>At your rate</span>
          <strong>{projected == null ? '—' : formatCompactCurrency(projected)}</strong>
          <small>
            {projected == null ? '\u00a0' : `by ${formatDay(draft.by)} · ${Math.round((projected / target) * 100)}% of goal`}
          </small>
        </div>
      </div>
      <div className="performance-goal-inputs">
        <label>
          Target ($)
          <input
            ref={targetInput}
            type="number"
            min="1"
            step="any"
            inputMode="decimal"
            value={draft.target}
            onChange={(event) => update('target', event.target.value)}
          />
        </label>
        <label>
          By
          <input
            type="date"
            value={draft.by}
            onChange={(event) => update('by', event.target.value)}
          />
        </label>
        <label>
          Added per year ($)
          <input
            type="number"
            step="any"
            inputMode="decimal"
            placeholder={String(Math.round(recentAdded))}
            value={draft.yearlyAdded}
            onChange={(event) => update('yearlyAdded', event.target.value)}
          />
        </label>
        <button
          type="button"
          className="performance-goal-button"
          onClick={() => {
            focusNext.current = 'set';
            setDraft(null);
          }}
        >
          Remove goal
        </button>
      </div>
      <p className="performance-goal-note">
        Blank &ldquo;added per year&rdquo; uses {recentAddedLabel} ({formatCompactCurrency(recentAdded)}).
        The projection grows today&rsquo;s value and those additions at your rate; it is an estimate, not a forecast.
      </p>
    </section>
  );
}

/** Value after `years` of growth at `rate`, adding `added` at the end of each year. */
function futureValue(start: number, added: number, rate: number, years: number): number {
  const growth = (1 + rate) ** years;
  return start * growth + (Math.abs(rate) < 1e-9 ? added * years : (added * (growth - 1)) / rate);
}

/** Annual rate that reaches `target`; null above 1000%/yr. */
function requiredRate(start: number, added: number, target: number, years: number): number | null {
  let low = -0.99;
  let high = 10;
  if (futureValue(start, added, high, years) < target) return null;
  if (futureValue(start, added, low, years) >= target) return low;
  for (let step = 0; step < 100; step++) {
    const middle = (low + high) / 2;
    if (futureValue(start, added, middle, years) < target) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

/** A real calendar date written YYYY-MM-DD (rejects e.g. 2031-02-30). */
function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function formatCompactCurrency(value: number): string {
  return `${value < 0 ? '-' : ''}${COMPACT_CURRENCY.format(Math.abs(value))}`;
}

/** A gain or a flow as the table shows it: "+$1.2K", and one that reads "$0" unsigned and in neither colour. */
function formatCompactSigned(value: number): ShownValue {
  return formatShownAmount(value, { signed: true, format: formatCompactCurrency });
}

function formatDay(day: string): string {
  return DAY_FORMAT.format(new Date(`${day}T00:00:00Z`));
}

function formatMonth(day: string): string {
  return MONTH_FORMAT.format(new Date(`${day}T00:00:00Z`));
}
