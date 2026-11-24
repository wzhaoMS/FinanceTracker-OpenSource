import type { Database as DB } from 'better-sqlite3';

import type { SqliteStateRepo } from './sqliteStateRepo.js';
import type { HistoryRepo, RangeKey } from './symbolHistory.js';
import { rangeBounds, getSymbolHistory, marketDate, pickOneBarPerDate } from './symbolHistory.js';
import {
  aggregatePositions,
  dropImportedSnapshotsWhereActivityExists,
  formatOptionSymbol,
  parseOccSymbol,
} from '@finance-tracker/shared';
import type { Position, Transaction, Quote } from '@finance-tracker/shared';
import { getQuotes } from '../providers/quoteProvider.js';
import type { ManualPriceRepo } from './manualPrices.js';
import { errorTypeAndCode, isDatabaseFailure } from './dbErrors.js';
import { FIDELITY_CASH_ADOPTED_REASON } from './historyCorrections.js';
import type { IntradayBarFetcher } from '../providers/intradayBars.js';
import {
  COMPUTED_STEP_MINUTES, INCOME_EVENT_TYPES, WEEK_STEP_MINUTES, computeIntradayValuation, tradeCash, type ComputedPoint,
} from './intradayValuation.js';

/**
 * Phase B.2 / B.3 — portfolio value history.
 *
 * - **Ledger replay (1M..ALL)**: each account's holdings on every business
 *   day are rebuilt from its complete transaction ledger and valued at that
 *   day's close, plus the broker end-of-day cash balance when imported
 *   (`account_cash_history`). One continuous `ledger_estimate` series; no
 *   snapshot/backtest splicing, so overlapping ranges show identical values.
 * - **Snapshots (1D/1W)**: intraday observations stay snapshot-first. Long
 *   ranges fall back to snapshots only when the scope has no ledger data.
 * - **Backtest fallback**: only when no observed snapshot exists, 1W..ALL can
 *   price today's holdings against historical closes. This is explicitly
 *   returned as `current_holdings_backtest`, never as portfolio return.
 */

export type PortfolioRangeKey = RangeKey;
export type PortfolioValueMethod =
  | 'observed_snapshot'
  | 'ledger_estimate'
  | 'current_holdings_backtest'
  | 'holdings_at_market';

export interface PortfolioCoverage {
  requestedFrom: string;
  requestedTo: string;
  actualFrom: string | null;
  actualTo: string | null;
  complete: boolean;
  /** Share of the requested range covered, 0 to 100: market sessions for
   *  snapshot ranges, calendar time otherwise. */
  percent: number;
}

export interface PortfolioPoint {
  /** ISO snapshot timestamp, or YYYY-MM-DD for a backtest point. */
  t: string;
  /** Total market value at `t`: positions × close + cash. */
  value: number;
  /** Sum of cost bases at `t`, observed with snapshots or estimated by ledger replay. */
  costBasis: number;
  /** Captured before later broker activity made the account ledger complete or, in ledger ranges, valued
   *  with stand-in cash around trades the broker's cash history doesn't cover yet. Shown as context;
   *  no period change or return is measured from it. */
  unreliable?: boolean;
  /** 1D only: nothing was observed between the previous point and this one,
   *  so a chart breaks its line here rather than drawing a trend across. */
  gapBefore?: boolean;
  /** Ledger ranges: an account's cash steps here to the broker's balance, which Holdr's recorded cash
   *  events don't reach (an adopted balance). A correction, not a market move; returns leave it out. */
  cashCorrection?: boolean;
  /** 1D computed at market prices: holdings worth over 1% of the value were on a price more than
   *  30 minutes old during regular hours (or had none), so the point is an estimate. */
  estimated?: boolean;
}

export interface PortfolioReliability {
  totalPoints: number;
  unreliablePoints: number;
  /** Start of the newest contiguous reliable segment used for `summary`. */
  latestReliableFrom: string | null;
}

export interface PortfolioReferenceSeries {
  valueMethod: 'current_holdings_backtest';
  label: 'Current holdings backtest';
  points: PortfolioPoint[];
  approximationReasons: string[];
}

export interface PortfolioReturnPoint {
  /** Same date as the value point at this index. */
  t: string;
  /** Time-weighted return since the first point, as a fraction (0.25 = +25%). */
  cumulative: number;
  /** Investment gain in dollars since the first point. */
  gain: number;
}

export interface PortfolioReturnSeries {
  method: 'time_weighted';
  /** One entry per value point, in the same order. */
  points: PortfolioReturnPoint[];
  summary: {
    cumulative: number;
    /** Compound annual rate; null when the series spans less than a year. */
    annualized: number | null;
    gain: number;
    /** Value change that is not investment gain: deposits, withdrawals,
     *  transfers, share deposits and accounts joining. */
    netFlows: number;
    /** Money-weighted return (an IRR) over the series, not annualized; null
     *  when no single rate explains the values and money moved. */
    moneyWeighted: number | null;
    /** Compound annual money-weighted rate; null below a year. */
    moneyWeightedAnnualized: number | null;
  };
  notes: string[];
}

export interface PortfolioBenchmarkReturn {
  /** Price change between daily closes; dividends are not included. */
  return: number;
  /** Compound annual rate; null below a year. */
  annualized: number | null;
  /** Dates of the two closes used. */
  from: string;
  to: string;
}

/** Return measures between two points of the ledger series. */
export interface PortfolioPerformanceFigures {
  from: string;
  to: string;
  /** Starts before every account's broker records are complete. */
  partial: boolean;
  startValue: number;
  endValue: number;
  /** Investment gain in dollars. */
  gain: number;
  /** Money added minus money taken out, including accounts joining. */
  netFlows: number;
  timeWeighted: number;
  /** Compound annual rate; null below a year. */
  timeWeightedAnnualized: number | null;
  moneyWeighted: number | null;
  moneyWeightedAnnualized: number | null;
  /** Benchmark price return between the same dates; null without closes. */
  benchmarks: Record<string, PortfolioBenchmarkReturn | null>;
}

export type PortfolioPerformancePeriodKey = 'YTD' | '1Y' | '3Y' | '5Y' | 'COMPLETE' | 'INCEPTION';

export interface PortfolioPerformancePeriod extends PortfolioPerformanceFigures {
  key: PortfolioPerformancePeriodKey;
}

export interface PortfolioPerformanceYear extends PortfolioPerformanceFigures {
  year: number;
  /** The current year, measured to date. */
  ytd: boolean;
}

export interface PortfolioPerformance {
  supported: true;
  asOf: string;
  /** First day of the series. */
  inception: string;
  /** First day every account's broker records are complete; null when
   *  they are complete from inception. */
  completeFrom: string | null;
  benchmarks: string[];
  periods: PortfolioPerformancePeriod[];
  years: PortfolioPerformanceYear[];
  notes: string[];
  /** How the daily values behind every figure were estimated. */
  approximationReasons: string[];
}

export interface PortfolioHistoryResult {
  range: PortfolioRangeKey;
  from: string;
  to: string;
  /** True when the request was answered. False with `reason` when the
   * range is unsupported (e.g. 5Y/ALL pre-corp-actions, or an unknown
   * account id). */
  supported: boolean;
  reason?: string;
  /** True when the values are estimated rather than measured. 1D from
   * snapshots is exact (false); reconstruction is always approximate
   * because cash history isn't tracked. */
  approximate: boolean;
  /** Human-readable reasons the chart is approximate. Populated when
   * `approximate === true` so the UI can list them in a tooltip. */
  approximationReasons: string[];
  /** Where the points came from. */
  source: 'snapshots' | 'reconstruction' | 'intraday_prices' | 'none';
  /** Financial meaning of the value series. Null only for unsupported results. */
  valueMethod: PortfolioValueMethod | null;
  /** Requested versus actually represented time span. */
  coverage: PortfolioCoverage;
  points: PortfolioPoint[];
  /** 1D computed at market prices: the session's span for the x-axis (ISO instants). */
  window?: { from: string; to: string };
  /** Present for observed snapshots so consumers can distinguish capture
   * coverage from financial reliability. */
  reliability?: PortfolioReliability;
  /** Optional visual context for dates before observed tracking began.
   * Never included in `points`, coverage, or the observed summary. */
  referenceSeries?: PortfolioReferenceSeries;
  /** Investment return over the same points: the ledger replay, and the computed 1W line. */
  returns?: PortfolioReturnSeries;
  summary: {
    /** First displayed value. */
    startValue: number;
    /** Last displayed value. */
    endValue: number;
    change: number;
    changePercent: number;
  };
  /** When `source === 'snapshots'`, the `taken_at` of the very first row
   * we have for the in-scope accounts. The UI uses this to render
   * "Tracking since X" when it's recent. Absent for reconstruction. */
  trackingSince?: string;
}

export interface PortfolioHistoryDeps {
  state: SqliteStateRepo;
  history: HistoryRepo;
  /** Manual price overrides (E.7). When supplied, takes precedence over
   *  cached daily bars for any (symbol, date) it covers. Optional so tests
   *  and old callers don't need to provide it. */
  manualPrices?: ManualPriceRepo;
  /** Override quote provider for tests. Defaults to the real getQuotes(). */
  fetchQuotes?: typeof getQuotes;
  /** Public 1-minute chart prices for the computed 1D line. Without it (tests, read-only checks)
   *  the line uses only stored prices and nothing is fetched or written. */
  intradayBars?: IntradayBarFetcher;
  /** Public 5-minute chart prices of the last five sessions, for the computed 1W line's past sessions. */
  intradayWeekBars?: IntradayBarFetcher;
}

const RANGES_FROM_RECONSTRUCTION: ReadonlyArray<PortfolioRangeKey> = ['1W', '1M', '3M', 'YTD', '1Y', '5Y', 'ALL'];
const LEDGER_RANGES: ReadonlyArray<PortfolioRangeKey> = ['1M', '3M', 'YTD', '1Y', '5Y', 'ALL'];
const DAILY_SNAPSHOT_RANGES: ReadonlyArray<PortfolioRangeKey> = ['1M', '3M', 'YTD', '1Y', '5Y', 'ALL'];
const MAX_REFERENCE_POINTS = 600;
const SNAPSHOT_INTERVAL_MINUTES = 5;
/** Two or more missed 5-minute ticks (job ticks sit on the 5-minute grid): an intraday hole, not a sampling step. */
const INTRADAY_GAP_MS = 2.5 * SNAPSHOT_INTERVAL_MINUTES * 60_000;
const COMPLETE_SESSION_LOOKBACK_DAYS = 10;
const EXTENDED_SESSION_START_MINUTE = 4 * 60;
const EXTENDED_SESSION_END_MINUTE = 20 * 60;
const MARKET_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * Public entry point: fetch portfolio history for one range.
 *
 * `accountIds` filters which accounts contribute; pass undefined for the
 * household-wide chart. (Server-side ownership scoping is documented for
 * the post-auth Phase 4 wiring; pre-auth, anyone can request anything.)
 */
export async function getPortfolioHistory(
  deps: PortfolioHistoryDeps,
  range: PortfolioRangeKey,
  accountIds?: string[],
  now: Date = new Date(),
): Promise<PortfolioHistoryResult> {
  // Daily ranges replay the full ledger so the series is continuous across
  // the snapshot era, includes every trade, and matches across ranges. The
  // snapshot paths below remain for 1D/1W and for scopes with no ledger.
  if (LEDGER_RANGES.includes(range)) {
    try {
      const ledger = await getFromLedger(deps, range, accountIds, now);
      if (ledger) return ledger;
    } catch (error) {
      // A database failure is logged by type and code only: its message can quote the database.
      console.warn('[portfolio] ledger replay failed; using snapshot history', isDatabaseFailure(error) ? errorTypeAndCode(error) : error);
    }
  }

  // Observed values always win. Never splice a reconstruction into `points`:
  // the observed summary and coverage must retain one financial meaning. For
  // partial multi-point ranges, a separately typed reference may be attached
  // so the UI can draw a visually distinct backtest before tracking began.
  const snapshotResult = getFromSnapshots(deps, range, accountIds, now);
  if (range === '1D' || range === '1W') {
    // Brokers draw 1D and 1W from holdings at market prices; the recorded snapshots check that
    // line, and stand in for it wherever it does not hold up.
    try {
      const computed = await computeIntradayLine(deps, range, accountIds, now, snapshotResult.trackingSince);
      if (computed.result) return computed.result;
    } catch (error) {
      console.warn(`[portfolio] computed ${range} line failed; using recorded snapshots`, errorTypeAndCode(error));
    }
  }
  if (snapshotResult.points.length > 0 || range === '1D' || snapshotResult.approximate) {
    if (
      snapshotResult.points.length > 1
      && !snapshotResult.coverage.complete
      && RANGES_FROM_RECONSTRUCTION.includes(range)
    ) {
      try {
        const backtest = await getFromReconstruction(deps, range, accountIds, now);
        const observedStart = snapshotResult.coverage.actualFrom
          ? pointCalendarDate(snapshotResult.coverage.actualFrom)
          : null;
        const referenceStart = backtest.points[0]
          ? pointCalendarDate(backtest.points[0].t)
          : null;
        if (
          backtest.valueMethod === 'current_holdings_backtest'
          && backtest.points.length > 1
          && observedStart
          && referenceStart
          && referenceStart < observedStart
        ) {
          const referencePoints = downsampleReferencePoints(backtest.points, MAX_REFERENCE_POINTS);
          return {
            ...snapshotResult,
            referenceSeries: {
              valueMethod: 'current_holdings_backtest',
              label: 'Current holdings backtest',
              points: referencePoints,
              approximationReasons: [
                ...backtest.approximationReasons,
                ...(referencePoints.length < backtest.points.length
                  ? [`reference display reduced from ${backtest.points.length} to ${referencePoints.length} shape-preserving points`]
                  : []),
              ],
            },
          };
        }
      } catch {
        // Reference generation is best-effort. Observed history remains usable
        // even when price providers or reconstruction data are unavailable.
      }
    }
    return snapshotResult;
  }

  // New installations may not have two snapshots yet. Keep a clearly named
  // current-holdings backtest as a last-resort visualization, never as
  // "portfolio return" and never mixed with snapshots.
  if (RANGES_FROM_RECONSTRUCTION.includes(range)) {
    return getFromReconstruction(deps, range, accountIds, now);
  }
  return makeUnsupported(range, now, `unknown range '${range}'`);
}

/* ------------------------------------------------------------------ */
/* B.2 — 1D from snapshots                                            */
/* ------------------------------------------------------------------ */

/** A recorded snapshot within 0.1%, or 0.5%, of the computed line agrees with it. */
const DRIFT_CLOSE = 0.001;
const DRIFT_TOLERANCE = 0.005;
/** Above this share of recorded snapshots over the tolerance, the line is not used at all. */
const DRIFT_FAILING_SHARE = 0.1;
/** The snapshot job's own rows; an import's capture has another id. */
const JOB_SNAPSHOT = `id = 'snap-' || account_id || '-' || taken_at`;

/**
 * The snapshot job's ticks of the sessions that can check the computed line, by time: each observed
 * every valued account, and was taken from the ledger and cash the line uses. A tick is stamped at
 * its nearest interval, so the first one stamped after a change may have read the accounts before
 * it; distinct stamps are a whole interval apart, so a tick stamped after a later stamp than the
 * change started after the change.
 */
function loadCheckingTicks(
  db: DB,
  accountIds: string[],
  sessions: string[],
  lastChange: number | null,
  now: Date,
): Map<number, { value: number; costBasis: number }> {
  const checking = new Map<number, { value: number; costBasis: number }>();
  if (accountIds.length === 0 || sessions.length === 0) return checking;
  let after = Number.NEGATIVE_INFINITY;
  if (lastChange !== null) {
    const firstStamp = db.prepare(
      `SELECT taken_at FROM account_snapshots
        WHERE account_id = ? AND taken_at >= ? AND ${JOB_SNAPSHOT} ORDER BY taken_at LIMIT 1`,
    ).pluck();
    after = Number.POSITIVE_INFINITY;
    for (const id of accountIds) {
      const stamp = firstStamp.get(id, new Date(lastChange).toISOString()) as string | undefined;
      if (typeof stamp === 'string') after = Math.min(after, pointTime(stamp));
    }
  }
  // A New York evening runs past UTC midnight: a broad envelope, then each tick's own market date.
  const sessionSet = new Set(sessions);
  const envelopeStart = Date.parse(`${sessions[0]}T00:00:00.000Z`);
  const envelopeEnd = Date.parse(`${sessions[sessions.length - 1]}T00:00:00.000Z`) + 2 * 86400_000;
  const rows = db.prepare(
    `SELECT account_id, taken_at, market_value, cost_basis FROM account_snapshots
      WHERE account_id IN (${accountIds.map(() => '?').join(',')}) AND taken_at >= ? AND taken_at <= ? AND ${JOB_SNAPSHOT}`,
  ).all(
    ...accountIds,
    new Date(envelopeStart).toISOString(),
    new Date(Math.min(now.getTime(), envelopeEnd)).toISOString(),
  ) as Array<{ account_id: string; taken_at: string; market_value: number; cost_basis: number }>;
  const byTime = new Map<string, { value: number; costBasis: number; accounts: number }>();
  for (const row of rows) {
    const tick = byTime.get(row.taken_at) ?? { value: 0, costBasis: 0, accounts: 0 };
    tick.value += row.market_value;
    tick.costBasis += row.cost_basis;
    tick.accounts += 1;
    byTime.set(row.taken_at, tick);
  }
  for (const [t, tick] of byTime) {
    const at = pointTime(t);
    // One row per account and time, so a tick that observed every valued account has one each.
    if (tick.accounts === accountIds.length && at > after && sessionSet.has(pointCalendarDate(t))) {
      checking.set(at, { value: tick.value, costBasis: tick.costBasis });
    }
  }
  return checking;
}

/** How a computed line compared with the recorded snapshots of its sessions. Counts and dates only. */
export interface IntradayDriftCheck {
  range: '1D' | '1W';
  /** The first session on the line; the same as `sessionDate` for 1D. */
  firstSession: string;
  /** The newest session on the line. */
  sessionDate: string;
  points: number;
  estimatedPoints: number;
  compared: number;
  within01: number;
  within05: number;
  over05: number;
  /** The line is shown: few enough recorded snapshots disagree. */
  passed: boolean;
}

const loggedDriftChecks = new Map<string, string>();

function logDriftCheck(check: IntradayDriftCheck, accountIds: string[] | undefined): void {
  const scope = accountIds && accountIds.length > 0 ? `${accountIds.length} account(s)` : 'household';
  const span = check.firstSession === check.sessionDate ? check.sessionDate : `${check.firstSession} to ${check.sessionDate}`;
  const line = `[portfolio] ${check.range} for ${span} (${scope}) computed at market prices: ${check.points} points, `
    + `${check.estimatedPoints} estimated; checked against ${check.compared} recorded snapshots: `
    + `${check.within01} within 0.1%, ${check.within05} within 0.5%, ${check.over05} over 0.5%`
    + `${check.passed ? '' : '; using the recorded snapshots instead'}`;
  const key = `${check.range}\u0000${span}\u0000${scope}`;
  // Said once, and again only when the counts change.
  if (loggedDriftChecks.get(key) === line) return;
  loggedDriftChecks.set(key, line);
  if (loggedDriftChecks.size > 200) loggedDriftChecks.delete(loggedDriftChecks.keys().next().value!);
  console.info(line);
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * 1W: time-weighted return over the computed points. A recorded deposit, withdrawal, transfer or
 * tax steps the value at its session's first point; it is money moved, not return.
 */
function computedLineReturns(computed: ComputedPoint[], points: PortfolioPoint[]): PortfolioReturnSeries {
  let growth = 1;
  let totalGain = 0;
  let skipped = 0;
  const returnPoints: PortfolioReturnPoint[] = [{ t: points[0].t, cumulative: 0, gain: 0 }];
  for (let index = 1; index < points.length; index++) {
    const gain = points[index].value - points[index - 1].value - (computed[index].flow ?? 0);
    const base = points[index - 1].value;
    // A total loss is a growth factor of zero: -100%, not a step left out.
    if (base > 0 && 1 + gain / base >= 0) growth *= 1 + gain / base;
    else if (Math.abs(gain) >= 0.005) skipped += 1;
    totalGain += gain;
    returnPoints.push({ t: points[index].t, cumulative: roundRatio(growth - 1), gain: roundCents(totalGain) });
  }
  const first = points[0];
  const last = points[points.length - 1];
  return {
    method: 'time_weighted',
    points: returnPoints,
    summary: {
      cumulative: returnPoints[returnPoints.length - 1].cumulative,
      annualized: null,
      gain: roundCents(totalGain),
      netFlows: roundCents(last.value - first.value - totalGain),
      moneyWeighted: null,
      moneyWeightedAnnualized: null,
    },
    notes: [
      "time-weighted: each step's gain (price moves, dividends, interest, fees, and trades at their price) divided by the value before it, then chained",
      "recorded deposits, withdrawals, transfers and taxes step the value at their day's open: money moved, not return",
      ...(skipped > 0 ? [`${plural(skipped, 'step', 'steps')} with no starting value left out`] : []),
    ],
  };
}

/**
 * The 1D or 1W line computed from holdings at market prices (see intradayValuation), checked
 * against the snapshot job's ticks of its sessions that observed every account since the latest
 * change to them (loadCheckingTicks): within 0.5% they agree; one further off is shown at its
 * recorded value; when over a tenth of them are, the line is not used and the range shows the
 * recorded snapshots with #72's rules.
 */
async function computeIntradayLine(
  deps: PortfolioHistoryDeps,
  range: '1D' | '1W',
  accountIds: string[] | undefined,
  now: Date,
  trackingSince?: string,
): Promise<{ result: PortfolioHistoryResult | null; check: IntradayDriftCheck | null }> {
  const db: DB = deps.state.internalGetDb();
  const week = range === '1W';
  const requested = rangeBounds(range, now);
  const valuation = await computeIntradayValuation({
    db,
    accountIds,
    now,
    fetchBars: deps.intradayBars,
    ...(week ? { fetchWeekBars: deps.intradayWeekBars, week: { from: requested.from } } : {}),
    dailyCloses: (symbol, from, to) => deps.history.readBars(symbol, from, to),
    manualPrices: deps.manualPrices ? (symbol) => deps.manualPrices!.list(symbol) : undefined,
  });
  if (!valuation || valuation.points.length < 2) return { result: null, check: null };

  const sessionDate = valuation.sessionDate;
  const firstSession = valuation.sessions[0];
  // An earlier tick, or one that left an account out, holds other figures: it never checks or
  // replaces the line.
  const recordedAt = loadCheckingTicks(db, valuation.accountIds, valuation.sessions, valuation.lastChange, now);
  let compared = 0;
  let within01 = 0;
  let within05 = 0;
  let over05 = 0;
  const checked: ComputedPoint[] = valuation.points.map((point) => {
    const snapshot = recordedAt.get(pointTime(point.t));
    if (!snapshot) return point;
    compared += 1;
    const drift = Math.abs(point.value - snapshot.value) / Math.max(1, Math.abs(snapshot.value));
    if (drift <= DRIFT_CLOSE) within01 += 1;
    else if (drift <= DRIFT_TOLERANCE) within05 += 1;
    else {
      over05 += 1;
      // The recorded value stands where the computed one disagrees.
      return {
        t: point.t, value: snapshot.value, costBasis: snapshot.costBasis, cashBalance: point.cashBalance,
        ...(point.flow !== undefined ? { flow: point.flow } : {}),
      };
    }
    return point;
  });
  const check: IntradayDriftCheck = {
    range,
    firstSession,
    sessionDate,
    points: checked.length,
    estimatedPoints: checked.filter((point) => point.estimated).length,
    compared,
    within01,
    within05,
    over05,
    passed: over05 <= compared * DRIFT_FAILING_SHARE,
  };
  logDriftCheck(check, accountIds);
  if (!check.passed) return { result: null, check };

  const points: PortfolioPoint[] = checked.map(({ t, value, costBasis, estimated }) => ({
    t,
    value,
    costBasis,
    ...(estimated ? { estimated: true } : {}),
  }));
  const how = week
    ? [
        `computed every ${WEEK_STEP_MINUTES} minutes over the last ${plural(valuation.sessions.length, 'session', 'sessions')} from each day's holdings at market prices plus its cash: today's holdings and cash, walked back day by day through the ledger and the recorded cash events dated after it. A trade counts at its price, so trades, cash corrections, adoptions and first syncs never make a step`,
        "prices: the newest session's as in 1D; an earlier session's from the snapshot job's own quotes at its ticks, then CNBC's 5-minute chart prices, each carried forward until the next",
        ...(valuation.nettedTransactions > 0
          ? [`${plural(valuation.nettedTransactions, 'share transaction', 'share transactions')} this week ${valuation.nettedTransactions === 1 ? 'is' : 'are'} counted as bought or sold with cash at ${valuation.nettedTransactions === 1 ? 'its' : 'their'} recorded price: if one was a share deposit or transfer (RSU, ESPP or ACAT), it shows no step, and the days before it are off by its value`]
          : []),
        ...(valuation.syncedAccounts > 0
          ? [`${plural(valuation.syncedAccounts, 'account', 'accounts')} synced from Fidelity: Fidelity's dividends and deposits are not recorded as cash events, so any this week is spread over the whole week instead of stepping on its day`]
          : []),
        ...(valuation.recordedFlows > 0
          ? [valuation.recordedFlows === 1
              ? "1 recorded deposit, withdrawal or transfer steps the value at its day's open: money moved, not return"
              : `${valuation.recordedFlows} recorded deposits, withdrawals or transfers step the value at their day's open: money moved, not return`]
          : []),
      ]
    : [
        `computed every ${COMPUTED_STEP_MINUTES} minutes from the current holdings at market prices plus each account's current cash: the snapshot job's own quotes at its ticks, then Nasdaq's 1-minute chart prices, then CNBC's, each carried forward until the next; so the change is price movement alone`,
      ];
  return {
    check,
    result: {
      range,
      from: firstSession,
      to: sessionDate,
      supported: true,
      approximate: check.estimatedPoints > 0 || valuation.nettedTransactions > 0 || valuation.syncedAccounts > 0,
      approximationReasons: [
        ...how,
        ...(valuation.activityOnSession
          ? [`activity dated ${week ? 'the newest' : 'this'} session counts from its start: trade times are not recorded`]
          : []),
        compared > 0
          ? `checked against ${compared} recorded snapshot${compared === 1 ? '' : 's'} taken since the latest change to these accounts: ${within01} within 0.1%, ${within05} within 0.5%, ${over05} over 0.5%${over05 > 0 ? ' (shown at the recorded value)' : ''}`
          : 'no recorded snapshot taken since the latest change to these accounts to check against',
        ...(check.estimatedPoints > 0
          ? [`${check.estimatedPoints} point${check.estimatedPoints === 1 ? '' : 's'} estimated: holdings worth over 1% of the value had no price for more than 30 minutes`]
          : []),
        ...(valuation.optionPositions > 0 ? ['options at the last mark the snapshot job recorded, carried forward'] : []),
        ...(valuation.fundPositions > 0 ? ['mutual funds at their latest NAV'] : []),
        ...(valuation.unpricedSymbols > 0
          ? [`${valuation.unpricedSymbols} holding${valuation.unpricedSymbols === 1 ? '' : 's'} without any price left out where unpriced`]
          : []),
      ],
      source: 'intraday_prices',
      valueMethod: 'holdings_at_market',
      coverage: {
        requestedFrom: week ? requested.from : sessionDate,
        requestedTo: week ? requested.to : sessionDate,
        actualFrom: points[0].t,
        actualTo: points[points.length - 1].t,
        complete: true,
        percent: 100,
      },
      points,
      // 1D spans its session on the x-axis; 1W's points sit side by side, so nights and weekends take no room.
      ...(week ? { returns: computedLineReturns(checked, points) } : { window: valuation.window }),
      reliability: { totalPoints: points.length, unreliablePoints: 0, latestReliableFrom: points[0].t },
      summary: summarize(points),
      ...(trackingSince ? { trackingSince } : {}),
    },
  };
}

/**
 * The read-only check behind `intradayDriftCheckMain`: how today's computed 1D (or 1W) line compares
 * with the recorded snapshots, without fetching or writing anything. Null when there is no line to
 * compute.
 */
export async function checkIntradayLine(
  deps: PortfolioHistoryDeps,
  now: Date = new Date(),
  range: '1D' | '1W' = '1D',
): Promise<IntradayDriftCheck | null> {
  return (await computeIntradayLine({ ...deps, intradayBars: undefined, intradayWeekBars: undefined }, range, undefined, now)).check;
}

interface SnapshotRow {
  account_id: string;
  taken_at: string;
  market_value: number;
  cost_basis: number;
  cash_balance: number;
}

interface HistoryInvalidationRow {
  account_id: string;
  effective_date: string;
  detected_at: string;
  reason: string;
}

/** History corrections of the in-scope accounts that start by `upTo`. */
function loadInvalidations(db: DB, accountIds: string[] | undefined, upTo: string): HistoryInvalidationRow[] {
  const filter = accountIds && accountIds.length > 0
    ? `AND account_id IN (${accountIds.map(() => '?').join(',')})`
    : '';
  return db.prepare(
    `SELECT account_id, effective_date, detected_at, reason
       FROM account_history_invalidations
      WHERE effective_date <= ? ${filter}
      ORDER BY effective_date, detected_at`,
  ).all(upTo, ...(accountIds ?? [])) as HistoryInvalidationRow[];
}

interface SnapshotGroup extends SnapshotPoint {
  /** Accounts observed at this moment. */
  accounts: Set<string>;
}

function groupSnapshotRows(rows: SnapshotRow[]): SnapshotGroup[] {
  const byTime = new Map<string, SnapshotGroup>();
  for (const row of rows) {
    const current = byTime.get(row.taken_at);
    if (current) {
      current.value += row.market_value;
      current.costBasis += row.cost_basis;
      current.cashBalance += row.cash_balance;
      current.accounts.add(row.account_id);
    } else {
      byTime.set(row.taken_at, {
        t: row.taken_at,
        value: row.market_value,
        costBasis: row.cost_basis,
        cashBalance: row.cash_balance,
        accounts: new Set([row.account_id]),
      });
    }
  }
  return Array.from(byTime.values()).sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
}

/** When each in-scope account was first observed: from then on, a point must include it. */
function firstObservations(db: DB, accountIds: string[] | undefined): Map<string, number> {
  const ids = accountIds && accountIds.length > 0
    ? accountIds
    : db.prepare('SELECT id FROM accounts').pluck().all() as string[];
  const first = db.prepare('SELECT MIN(taken_at) FROM account_snapshots WHERE account_id = ?').pluck();
  const observed = new Map<string, number>();
  for (const id of ids) {
    const takenAt = first.get(id) as string | null | undefined;
    if (typeof takenAt === 'string') observed.set(id, pointTime(takenAt));
  }
  return observed;
}

/** Every account observed by this moment is observed at it, so the sum is the whole scope's value. */
function observesEveryAccount(
  group: { t: string; accounts: ReadonlySet<string> },
  firstObserved: ReadonlyMap<string, number>,
): boolean {
  const at = pointTime(group.t);
  for (const [accountId, first] of firstObserved) {
    if (first <= at && !group.accounts.has(accountId)) return false;
  }
  return true;
}

function loadSessionRows(
  db: DB,
  sessionDate: string,
  now: Date,
  filter: string,
  accountArgs: string[],
): SnapshotRow[] {
  // A New York market date always fits inside [date 00:00Z, date+2d 00:00Z],
  // across both EST and EDT. The exact market-date filter applied to the
  // groups removes the deliberately broad envelope without hand-rolling a DST
  // offset.
  const envelopeStart = Date.parse(`${sessionDate}T00:00:00.000Z`);
  return db.prepare(
    `SELECT account_id, taken_at, market_value, cost_basis, cash_balance
       FROM account_snapshots
      WHERE taken_at >= ? AND taken_at <= ? ${filter}
      ORDER BY taken_at ASC, account_id ASC`,
  ).all(
    new Date(envelopeStart).toISOString(),
    new Date(Math.min(now.getTime(), envelopeStart + 2 * 86400_000)).toISOString(),
    ...accountArgs,
  ) as SnapshotRow[];
}

/** The newest earlier market date with a moment that observed every account, within a bounded look-back. */
function latestCompleteSessionBefore(
  db: DB,
  sessionDate: string,
  filter: string,
  accountArgs: string[],
  firstObserved: ReadonlyMap<string, number>,
): string | null {
  const day = Date.parse(`${sessionDate}T00:00:00.000Z`);
  const earliest = new Date(day - COMPLETE_SESSION_LOOKBACK_DAYS * 86400_000).toISOString().slice(0, 10);
  // A New York evening runs past UTC midnight, so the window is broad and each
  // candidate is kept or not by its own market date.
  const rows = db.prepare(
    `SELECT account_id, taken_at
       FROM account_snapshots
      WHERE taken_at >= ? AND taken_at < ? ${filter}`,
  ).all(
    `${earliest}T00:00:00.000Z`,
    new Date(day + 86400_000).toISOString(),
    ...accountArgs,
  ) as Array<{ account_id: string; taken_at: string }>;
  const byTime = new Map<string, Set<string>>();
  for (const row of rows) {
    const accounts = byTime.get(row.taken_at) ?? new Set<string>();
    accounts.add(row.account_id);
    byTime.set(row.taken_at, accounts);
  }
  let latest: string | null = null;
  for (const [t, accounts] of byTime) {
    const date = pointCalendarDate(t);
    if (date < earliest || date >= sessionDate) continue;
    if (observesEveryAccount({ t, accounts }, firstObserved) && (latest === null || pointTime(t) > pointTime(latest))) {
      latest = t;
    }
  }
  return latest === null ? null : pointCalendarDate(latest);
}

function getFromSnapshots(
  deps: PortfolioHistoryDeps,
  range: PortfolioRangeKey,
  accountIds: string[] | undefined,
  now: Date,
): PortfolioHistoryResult {
  const db: DB = deps.state.internalGetDb();
  const requested = rangeBounds(range, now);

  const filter = accountIds && accountIds.length > 0
    ? `AND account_id IN (${accountIds.map(() => '?').join(',')})`
    : '';
  const accountArgs = accountIds ?? [];
  const firstObserved = firstObservations(db, accountIds);
  let requestedFrom = requested.from;
  let requestedTo = requested.to;
  let rows: SnapshotRow[];

  if (range === '1D') {
    const latest = db.prepare(
      `SELECT MAX(taken_at) as ts
         FROM account_snapshots
        WHERE taken_at <= ? ${filter}`,
    ).get(now.toISOString(), ...accountArgs) as { ts: string | null };
    let sessionDate = latest.ts ? pointCalendarDate(latest.ts) : requested.to;
    rows = loadSessionRows(db, sessionDate, now, filter, accountArgs);
    // A capture that observed only some accounts (an import records just the
    // accounts it read) never decides the session: 1D shows the newest one in
    // which every account was observed together.
    if (latest.ts && !groupSnapshotRows(rows).some((group) => (
      pointCalendarDate(group.t) === sessionDate && observesEveryAccount(group, firstObserved)
    ))) {
      const earlier = latestCompleteSessionBefore(db, sessionDate, filter, accountArgs, firstObserved);
      if (earlier) {
        sessionDate = earlier;
        rows = loadSessionRows(db, sessionDate, now, filter, accountArgs);
      }
    }
    requestedFrom = sessionDate;
    requestedTo = sessionDate;
  } else {
    rows = db.prepare(
      `SELECT account_id, taken_at, market_value, cost_basis, cash_balance
         FROM account_snapshots
        WHERE taken_at >= ? AND taken_at <= ? ${filter}
        ORDER BY taken_at ASC, account_id ASC`,
    ).all(`${requested.from}T00:00:00.000Z`, now.toISOString(), ...accountArgs) as SnapshotRow[];
  }

  // Group by taken_at; sum across accounts.
  const groupedPoints = groupSnapshotRows(rows);
  const inRange = range === '1D'
    ? groupedPoints.filter((point) => pointCalendarDate(point.t) === requestedFrom)
    : groupedPoints.filter((point) => {
        const date = pointCalendarDate(point.t);
        return date >= requested.from && date <= requested.to;
      });
  // A point is the sum of every account observed at one moment. A moment that
  // missed an account already being tracked (an import's own capture of the
  // accounts it read) would chart those accounts alone as the whole value.
  const rawPoints: SnapshotPoint[] = inRange
    .filter((group) => observesEveryAccount(group, firstObserved))
    .map(({ t, value, costBasis, cashBalance }) => ({ t, value, costBasis, cashBalance }));
  const partialRemoved = inRange.length - rawPoints.length;
  const invalidations = loadInvalidations(db, accountIds, requestedTo);
  const annotated = annotateSnapshotReliability(
    rawPoints,
    invalidations.map((entry) => startCashCorrectionAtLastKeptPoint(entry, rawPoints)),
  );
  const reliabilityRuns = partitionSnapshotReliabilityRuns(annotated);
  let filteredRemoved = 0;
  let trimmedRemoved = 0;
  let compactedRemoved = 0;
  const processedSegments: SnapshotPoint[][] = [];
  for (const segment of reliabilityRuns) {
    const filtered = filterSnapshotOutliers(segment);
    filteredRemoved += filtered.removed;
    const trimmed = trimLeadingPartialSnapshots(filtered.points, range);
    trimmedRemoved += trimmed.removed;
    const compacted = collapseFlatSnapshotRuns(trimmed.points, range);
    compactedRemoved += compacted.removed;
    const selected = DAILY_SNAPSHOT_RANGES.includes(range)
      ? lastSnapshotPerDay(compacted.points)
      : compacted.points;
    if (selected.length > 0) processedSegments.push(selected);
  }
  const selectedPoints = processedSegments.flat();
  const points: PortfolioPoint[] = selectedPoints.map(({ t, value, costBasis, unreliable }, index) => ({
    t,
    value,
    costBasis,
    ...(unreliable ? { unreliable: true } : {}),
    // Nothing was observed in between: the chart must not draw a trend across it.
    ...(range === '1D' && index > 0 && pointTime(t) - pointTime(selectedPoints[index - 1].t) > INTRADAY_GAP_MS
      ? { gapBefore: true }
      : {}),
  }));
  const coverage = range === '1D'
    ? measureIntradayCoverage(requestedFrom, points, now)
    : measureSessionCoverage(requested.from, requested.to, points, now);
  const unreliablePoints = points.filter((point) => point.unreliable).length;
  const latestReliable = latestReliableSegment(points);

  // "Tracking since" — earliest snapshot for the in-scope accounts, ever.
  const earliestRow = db.prepare(
    `SELECT MIN(taken_at) as ts FROM account_snapshots ${filter ? `WHERE 1=1 ${filter}` : ''}`,
  ).get(...(accountIds ?? [])) as { ts: string | null };
  const trackingSince = earliestRow?.ts ?? undefined;

  return {
    range,
    from: coverage.actualFrom ? pointCalendarDate(coverage.actualFrom) : requestedFrom,
    to: coverage.actualTo ? pointCalendarDate(coverage.actualTo) : requestedTo,
    supported: true,
    approximate: unreliablePoints > 0,
    approximationReasons: [
      ...(unreliablePoints > 0
        ? [`${unreliablePoints} captured snapshot${unreliablePoints === 1 ? '' : 's'} predate later broker activity; shown as unverified context and excluded from return calculations`]
        : []),
      ...(partialRemoved > 0
        ? [`left out ${partialRemoved} snapshot${partialRemoved === 1 ? '' : 's'} that observed only some of the accounts`]
        : []),
      ...(filteredRemoved > 0
        ? [`filtered ${filteredRemoved} isolated snapshot outlier${filteredRemoved === 1 ? '' : 's'}`]
        : []),
      ...(trimmedRemoved > 0
        ? [`trimmed ${trimmedRemoved} leading partial snapshot${trimmedRemoved === 1 ? '' : 's'}`]
        : []),
      ...(compactedRemoved > 0
        ? [`collapsed ${compactedRemoved} stale flat snapshot${compactedRemoved === 1 ? '' : 's'}`]
        : []),
    ],
    source: points.length > 0 ? 'snapshots' : 'none',
    valueMethod: 'observed_snapshot',
    coverage,
    points,
    reliability: {
      totalPoints: points.length,
      unreliablePoints,
      latestReliableFrom: latestReliable[0]?.t ?? null,
    },
    summary: summarize(latestReliable),
    ...(trackingSince ? { trackingSince } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* B.3 — 1W..1Y via reconstruction                                    */
/* ------------------------------------------------------------------ */

interface AccountRow {
  id: string;
  cash_balance: number;
  currency: string;
}

interface TxRow {
  id: string;
  account_id: string;
  symbol: string;
  date: string;
  quantity: number;
  price_per_unit: number;
  instrument_type: string | null;
  contract_multiplier: number | null;
  position_effect: string | null;
  fees: number | null;
  currency: string;
  notes?: string | null;
  source_fingerprint?: string | null;
  /** When the row was written: a sync's trades carry the time that sync applied them. */
  created_at?: string;
}

/* ------------------------------------------------------------------ */
/* 1M..ALL — full-ledger replay                                       */
/* ------------------------------------------------------------------ */

interface LedgerAccountRow {
  id: string;
  name: string;
  cash_balance: number;
  currency: string;
  created_at: string | null;
}

interface LedgerCashRow {
  account_id: string;
  as_of_date: string;
  cash_balance: number;
  method: string;
  /** When the row was written; for a sync's capture, when that sync applied. */
  imported_at: string;
}

interface AccountTimeline {
  account: LedgerAccountRow;
  /** First transaction or cash-history date; null when neither exists. */
  documentedStart: string | null;
  /** First day the account contributes: documented start, else its creation
   *  date, else '' (no evidence either way: contributes on every day). */
  start: string;
  /** Holdings after applying every transaction dated on or before `date`. */
  states: Array<{ date: string; positions: Position[] }>;
  /** End-of-day cash at each broker row, ascending, and the row's own balance. They differ on a sync's
   *  capture day with trades a later sync applied: its end comes back from the next balance. */
  cash: Array<{ date: string; balance: number; observed: number }>;
  /** Capture days whose end-of-day cash the next balance confirms with trades a later sync applied. */
  lateTradeDays: string[];
  /** Capture days with trades a later sync applied whose cash nothing confirms: the capture's balance stands. */
  unconfirmedLateDays: string[];
  /** Where the broker rows leave business days uncovered, cash rebuilt when read; nothing is written. */
  cashSpans: CashSpan[];
  /** Holding snapshots kept because no activity exists for that symbol. */
  seedDates: string[];
  /** Dates on which recorded sells exceeded recorded buys, per symbol. */
  orphanSells: Array<{ symbol: string; date: string }>;
}

/**
 * After the newest broker cash row, and between two rows with business days in between where either is
 * a sync's capture, cash follows the recorded cash events: forward from the earlier row, and back from
 * the later balance (the next row's, or today's after the newest) once the broker's balance was adopted.
 * Where the events don't reach that balance, the difference is a cash correction where it first applies
 * (the adoption, the next row, or the last day), never a market move. Trades and sweeps carry cash the
 * events don't record, so from the first of them the later balance stands in: an approximate stretch.
 */
interface CashSpan {
  /** Day of the earlier broker row, and its balance. */
  after: string;
  balance: number;
  /** Day of the later row; null after the newest row, where today's balance ends the span. */
  until: string | null;
  /** The later balance: the next row's, or today's. */
  endBalance: number;
  /** Recorded cash events after `after` and up to `until`, ascending by day. */
  events: Array<{ date: string; amount: number }>;
  /** The later balance less (the earlier row plus the events). */
  residual: number;
  /** Market day from which the later balance, less the events still to come, applies; null: where it
   *  first applies anyway (the next row, or the last day). */
  correctionDay: string | null;
  /** First and last trade or sweep in the span, the later row's day included (that row has their cash,
   *  unseparated from any correction). From the first, cash comes back from the later balance less the
   *  events still to come, which mistimes trades until the last: an approximate stretch. */
  unexplainedFrom: string | null;
  unexplainedUntil: string | null;
}

/** Cash rebuilt from a broker row and the recorded events agrees with the later balance within this. */
const CASH_TAIL_TOLERANCE = 0.02;
/** The method of the rows the Fidelity importer appends when a sync applies: capture-time observations. */
const CAPTURED_CASH_METHOD = 'fidelity-capture';
/** A span's switch after the last day: it lands on the live point. */
const LIVE_SWITCH = Symbol('live switch');

const MAX_LISTED = 6;
// Cash events that are investment results rather than money moving in or out.
const RETURN_INCOME_TYPES = INCOME_EVENT_TYPES;

function listSome(items: string[]): string {
  return items.length <= MAX_LISTED
    ? items.join(', ')
    : `${items.slice(0, MAX_LISTED).join(', ')} and ${items.length - MAX_LISTED} more`;
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function isoDaysBefore(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function isHoldingSnapshotRow(transaction: Transaction): boolean {
  const fingerprint = transaction.sourceFingerprint;
  if (fingerprint) return fingerprint.startsWith('pos:');
  return typeof transaction.notes === 'string' && /^imported\b/i.test(transaction.notes);
}

function buildAccountTimeline(
  account: LedgerAccountRow,
  accountTransactions: Transaction[],
  cashRows: LedgerCashRow[],
  cashEvents: Array<{ date: string; type: string; amount: number }>,
  correctionDays: string[],
  appliedAt: ReadonlyMap<string, string>,
): AccountTimeline {
  // Normalise the COMPLETE ledger once, before any date filtering, so a
  // snapshot row superseded by later activity never counts on early days.
  const ledger = dropImportedSnapshotsWhereActivityExists(accountTransactions)
    .map((transaction, index) => ({ transaction, index }))
    .sort((left, right) => (
      left.transaction.date.localeCompare(right.transaction.date) || left.index - right.index
    ))
    .map(({ transaction }) => transaction);

  const states: AccountTimeline['states'] = [];
  const runningQuantity = new Map<string, number>();
  const orphanSells: AccountTimeline['orphanSells'] = [];
  for (let index = 0; index < ledger.length; index++) {
    const transaction = ledger[index];
    if (transaction.instrumentType !== 'option') {
      const quantity = (runningQuantity.get(transaction.symbol) ?? 0) + transaction.quantity;
      runningQuantity.set(transaction.symbol, quantity);
      if (quantity < -1e-6 && transaction.quantity < 0) {
        orphanSells.push({ symbol: transaction.symbol, date: transaction.date });
      }
    }
    const nextDate = ledger[index + 1]?.date;
    if (nextDate === transaction.date) continue;
    states.push({
      date: transaction.date,
      positions: aggregatePositions(ledger.slice(0, index + 1)),
    });
  }

  const rows = cashRows
    .map((row) => ({
      date: row.as_of_date,
      balance: row.cash_balance,
      captured: row.method === CAPTURED_CASH_METHOD,
      importedAt: row.imported_at,
    }))
    .sort((left, right) => left.date.localeCompare(right.date));
  const sortedEvents = cashEvents.slice().sort((left, right) => left.date.localeCompare(right.date));
  const trades = ledger.filter((transaction) => !isHoldingSnapshotRow(transaction));
  const tradesOn = new Map<string, Transaction[]>();
  for (const transaction of trades) {
    const sameDay = tradesOn.get(transaction.date);
    if (sameDay) sameDay.push(transaction);
    else tradesOn.set(transaction.date, [transaction]);
  }
  const sweeps = sortedEvents.filter((event) => event.type === 'sweep').map((event) => event.date);
  // A capture row is the account's cash at that day's first sync: a trade of that day that a later
  // sync applied (when the trader traded after it) is not in it.
  const appliedLater = (row: (typeof rows)[number], transaction: Transaction) => row.captured
    && transaction.date === row.date && (appliedAt.get(transaction.id) ?? '') > row.importedAt;
  const lateTradeDays: string[] = [];
  const unconfirmedLateDays: string[] = [];
  // Rows whose later trades the next balance confirms: only their days change.
  const confirmedLate = new Set<number>();
  const cash = rows.map((row, index) => {
    const late = row.captured ? (tradesOn.get(row.date) ?? []).filter((transaction) => appliedLater(row, transaction)) : [];
    if (late.length === 0) return { date: row.date, balance: row.balance, observed: row.balance };
    // The day's end, back from the next balance (the next row's, or today's) less the events between.
    const next = rows[index + 1] ?? null;
    const until = next?.date ?? null;
    const between = (date: string) => date > row.date && (until === null || date <= until);
    const fromNext = sortedEvents
      .filter((event) => between(event.date))
      .reduce((sum, event) => sum - event.amount, next ? next.balance : account.cash_balance);
    // It holds only where nothing else moved cash before that balance and the later trades, all or some
    // of them (shares deposited or reinvested move none), account for the difference. Otherwise nothing
    // tells a purchase from a deposit, and the day stays exactly as before: the capture's balance, and
    // its trades still make it approximate where a span ends there.
    const confirmed = !sweeps.some(between) && !correctionDays.some(between)
      && !trades.some((transaction) => between(transaction.date) && !(next && appliedLater(next, transaction)))
      && explainedByTrades(fromNext - row.balance, late);
    if (!confirmed) {
      unconfirmedLateDays.push(row.date);
      return { date: row.date, balance: row.balance, observed: row.balance };
    }
    confirmedLate.add(index);
    if (Math.abs(fromNext - row.balance) >= 0.005) lateTradeDays.push(row.date);
    return { date: row.date, balance: fromNext, observed: row.balance };
  });
  const cashSpans: CashSpan[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const next = rows[index + 1] ?? null;
    // Imported history has a row for every day with posted broker activity, so between two of its rows
    // the earlier balance holds. Capture rows exist only for days a sync ran, and rows a weekend apart
    // leave no business day to rebuild.
    if (next && (!(row.captured || next.captured) || !hasWeekdayBetween(row.date, next.date))) continue;
    const until = next?.date ?? null;
    const within = (date: string) => date > row.date && (until === null || date <= until);
    const events = sortedEvents.filter((event) => within(event.date));
    // A trade on the later row's own day is in that row, unseparated from any correction it carries,
    // unless a later sync applied it and the balance after confirms its cash.
    const nextConfirmed = next !== null && confirmedLate.has(index + 1);
    const traded = [
      ...trades
        .filter((transaction) => within(transaction.date) && !(nextConfirmed && appliedLater(next!, transaction)))
        .map((transaction) => transaction.date),
      ...sweeps.filter(within),
    ].sort();
    // Forward from the earlier row's end of day.
    const start = cash[index].balance;
    const endBalance = next ? next.balance : account.cash_balance;
    cashSpans.push({
      after: row.date,
      balance: start,
      until,
      endBalance,
      events: events.map((event) => ({ date: event.date, amount: event.amount })),
      residual: endBalance - events.reduce((sum, event) => sum + event.amount, start),
      // The first time Holdr adopted the broker's balance within the span.
      correctionDay: correctionDays.filter(within).sort()[0] ?? null,
      unexplainedFrom: traded[0] ?? null,
      unexplainedUntil: traded.at(-1) ?? null,
    });
  }
  const createdAt = account.created_at ? new Date(account.created_at) : null;
  const created = createdAt && Number.isFinite(createdAt.getTime()) ? marketDate(createdAt) : null;
  const documentedStarts = [ledger[0]?.date, cash[0]?.date].filter((date): date is string => Boolean(date));
  const documentedStart = documentedStarts.length > 0 ? documentedStarts.sort()[0] : null;

  return {
    account,
    documentedStart,
    start: documentedStart ?? created ?? '',
    states,
    cash,
    lateTradeDays,
    unconfirmedLateDays,
    cashSpans,
    seedDates: Array.from(new Set(ledger.filter(isHoldingSnapshotRow).map((row) => row.date))).sort(),
    orphanSells,
  };
}

/** A weekday strictly between two dates (YYYY-MM-DD). */
function hasWeekdayBetween(from: string, to: string): boolean {
  for (let day = nextCalendarDay(from); day < to; day = nextCalendarDay(day)) {
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (weekday >= 1 && weekday <= 5) return true;
  }
  return false;
}

function nextCalendarDay(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** The span that rebuilds `day`'s cash, if any. */
function spanOn(timeline: AccountTimeline, day: string): CashSpan | undefined {
  return timeline.cashSpans.find((span) => day > span.after && (span.until === null || day < span.until));
}

const MAX_EXPLAINING_TRADES = 12;

/** Whether the cash of all or some of `trades` accounts for `delta`: entries for shares deposited or
 *  reinvested move none. Beyond a dozen trades, only all or none. */
function explainedByTrades(delta: number, trades: Transaction[]): boolean {
  const amounts = trades.map(tradeCash);
  if (amounts.length > MAX_EXPLAINING_TRADES) {
    const all = amounts.reduce((sum, amount) => sum + amount, 0);
    return Math.abs(delta) <= CASH_TAIL_TOLERANCE || Math.abs(all - delta) <= CASH_TAIL_TOLERANCE;
  }
  for (let mask = 0; mask < 1 << amounts.length; mask++) {
    let sum = 0;
    for (let bit = 0; bit < amounts.length; bit++) if (mask & (1 << bit)) sum += amounts[bit];
    if (Math.abs(sum - delta) <= CASH_TAIL_TOLERANCE) return true;
  }
  return false;
}

/** Index of the last element whose date is on or before `day`, or -1. */
function lastIndexOnOrBefore<T>(rows: T[], day: string, dateOf: (row: T) => string): number {
  let low = 0;
  let high = rows.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (dateOf(rows[middle]) <= day) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

async function getFromLedger(
  deps: PortfolioHistoryDeps,
  range: PortfolioRangeKey,
  accountIds: string[] | undefined,
  now: Date,
): Promise<PortfolioHistoryResult | null> {
  return (await replayLedger(deps, range, accountIds, now))?.result ?? null;
}

async function replayLedger(
  deps: PortfolioHistoryDeps,
  range: PortfolioRangeKey,
  accountIds: string[] | undefined,
  now: Date,
): Promise<{ result: PortfolioHistoryResult; timelines: AccountTimeline[] } | null> {
  const db: DB = deps.state.internalGetDb();
  const requested = rangeBounds(range, now);
  const accountFilter = accountIds && accountIds.length > 0
    ? `WHERE id IN (${accountIds.map(() => '?').join(',')})`
    : '';
  const accounts = db.prepare(
    `SELECT id, name, cash_balance, currency, created_at FROM accounts ${accountFilter} ORDER BY sort_order`,
  ).all(...(accountIds ?? [])) as LedgerAccountRow[];
  if (accounts.length === 0) return null;

  const accountIdSet = new Set(accounts.map((account) => account.id));
  const transactionRows = (db.prepare(
    `SELECT id, account_id, symbol, date, quantity, price_per_unit, fees, currency,
            instrument_type, contract_multiplier, position_effect, notes, source_fingerprint, created_at
     FROM transactions ORDER BY sort_order`,
  ).all() as TxRow[])
    .filter((row) => accountIdSet.has(row.account_id));
  const transactions = transactionRows.map(rowToTx);
  const appliedAt = new Map(transactionRows.map((row) => [row.id, row.created_at ?? '']));
  const cashRows = (db.prepare(
    `SELECT account_id, as_of_date, cash_balance, method, imported_at
     FROM account_cash_history ORDER BY account_id, as_of_date`,
  ).all() as LedgerCashRow[]).filter((row) => accountIdSet.has(row.account_id));
  if (transactions.length === 0 && cashRows.length === 0) return null;
  const cashEvents = (db.prepare(
    'SELECT account_id, event_date, event_type, amount FROM account_cash_events',
  ).all() as Array<{ account_id: string; event_date: string; event_type: string; amount: number }>)
    .filter((row) => accountIdSet.has(row.account_id));
  // When Holdr adopted a broker's cash balance (the importer's own history corrections).
  const correctionDays = new Map<string, string[]>();
  for (const row of db.prepare(
    'SELECT account_id, detected_at FROM account_history_invalidations WHERE reason = ?',
  ).all(FIDELITY_CASH_ADOPTED_REASON) as Array<{ account_id: string; detected_at: string }>) {
    const detected = new Date(row.detected_at);
    if (!accountIdSet.has(row.account_id) || !Number.isFinite(detected.getTime())) continue;
    correctionDays.set(row.account_id, [...(correctionDays.get(row.account_id) ?? []), marketDate(detected)]);
  }

  const timelines = accounts.map((account) => buildAccountTimeline(
    account,
    transactions.filter((transaction) => transaction.accountId === account.id),
    cashRows.filter((row) => row.account_id === account.id),
    cashEvents
      .filter((row) => row.account_id === account.id)
      .map((row) => ({ date: row.event_date, type: row.event_type, amount: row.amount })),
    correctionDays.get(account.id) ?? [],
    appliedAt,
  ));
  const firstDocumented = timelines
    .map((timeline) => timeline.documentedStart)
    .filter((date): date is string => date !== null)
    .sort()[0];
  if (!firstDocumented) return null;
  const requestedFrom = range === 'ALL' ? firstDocumented : requested.from;
  const gridFrom = firstDocumented > requestedFrom ? firstDocumented : requestedFrom;
  const days = Array.from(businessDays(gridFrom, requested.to));
  if (days.length === 0) return null;

  // Price every equity and option underlying ever held in scope. Bars older
  // than the range stay readable so the first day can carry a prior close.
  const optionContracts = new Map<string, ReturnType<typeof parseOccSymbol>>();
  const pricedSymbols = new Set<string>();
  for (const transaction of transactions) {
    if (transaction.instrumentType === 'option') {
      const contract = parseOccSymbol(transaction.symbol);
      optionContracts.set(transaction.symbol, contract);
      if (contract) pricedSymbols.add(contract.underlyingSymbol);
    } else {
      pricedSymbols.add(transaction.symbol);
    }
  }
  // Providers are only asked about symbols actually held inside the window;
  // positions closed before it are never valued and need no refresh.
  const windowSymbols = new Set<string>();
  const lastGridDay = days[days.length - 1];
  for (const timeline of timelines) {
    timeline.states.forEach((state, index) => {
      const until = timeline.states[index + 1]?.date ?? '9999-12-31';
      if (state.date > lastGridDay || until <= gridFrom) return;
      for (const position of state.positions) {
        const contract = position.instrumentType === 'option' ? optionContracts.get(position.symbol) : null;
        windowSymbols.add(contract ? contract.underlyingSymbol : position.symbol);
      }
    });
  }
  const fetchFailures: string[] = [];
  const unsupportedSymbols: string[] = [];
  // Only ask providers for as much history as the grid needs, plus a short
  // lookback so a holiday first day still has a prior close.
  const lookbackFrom = isoDaysBefore(gridFrom, 10);
  const historyRange = (['1M', '3M', 'YTD', '1Y', '5Y'] as const)
    .find((candidate) => rangeBounds(candidate, now).from <= lookbackFrom)
    ?? (rangeBounds('5Y', now).from <= gridFrom ? '5Y' : 'ALL');
  const symbolQueue = Array.from(windowSymbols);
  await Promise.all(Array.from({ length: Math.min(4, symbolQueue.length) }, async () => {
    for (let symbol = symbolQueue.shift(); symbol; symbol = symbolQueue.shift()) {
      try {
        const history = await getSymbolHistory(deps.history, symbol, historyRange, now);
        if (!history.supported) unsupportedSymbols.push(symbol);
      } catch {
        fetchFailures.push(symbol);
      }
    }
  }));
  const barsBySymbol = new Map<string, Array<{ t: string; close: number }>>();
  const manualBySymbol = new Map<string, Array<{ t: string; close: number }>>();
  for (const symbol of pricedSymbols) {
    // One close per date: several providers can store the same day.
    barsBySymbol.set(
      symbol,
      pickOneBarPerDate(deps.history.readBars(symbol, '1900-01-01', requested.to))
        .map((bar) => ({ t: bar.t, close: bar.close })),
    );
    const manual = deps.manualPrices?.list(symbol) ?? [];
    if (manual.length > 0) {
      manualBySymbol.set(symbol, manual
        .map((price) => ({ t: price.date, close: price.close }))
        .sort((left, right) => left.t.localeCompare(right.t)));
    }
  }
  // Trade prices are the last-resort mark when no daily close exists yet.
  const tradePricesBySymbol = new Map<string, Array<{ t: string; close: number }>>();
  for (const transaction of transactions) {
    if (transaction.instrumentType === 'option' || !(transaction.pricePerUnit > 0)) continue;
    const rows = tradePricesBySymbol.get(transaction.symbol) ?? [];
    rows.push({ t: transaction.date, close: transaction.pricePerUnit });
    tradePricesBySymbol.set(transaction.symbol, rows);
  }
  for (const rows of tradePricesBySymbol.values()) rows.sort((left, right) => left.t.localeCompare(right.t));

  const manualSymbols = new Set<string>();
  const tradePriceSymbols = new Set<string>();
  const unpricedSymbols = new Set<string>();
  const intrinsicOptions = new Set<string>();
  const expiredOpenOptions = new Set<string>();
  const closeCache = new Map<string, number | null>();
  const closeFor = (symbol: string, day: string): number | null => {
    const key = `${symbol}\u0000${day}`;
    if (closeCache.has(key)) return closeCache.get(key)!;
    const close = lookupClose(symbol, day);
    closeCache.set(key, close);
    return close;
  };
  const lookupClose = (symbol: string, day: string): number | null => {
    // A manual price applies until a newer daily close exists; it never
    // freezes a symbol that providers price on later dates.
    const manual = manualBySymbol.get(symbol) ?? [];
    const manualIndex = lastIndexOnOrBefore(manual, day, (price) => price.t);
    const bars = barsBySymbol.get(symbol) ?? [];
    const barIndex = lastIndexOnOrBefore(bars, day, (bar) => bar.t);
    if (manualIndex >= 0 && (barIndex < 0 || manual[manualIndex].t >= bars[barIndex].t)) {
      manualSymbols.add(symbol);
      return manual[manualIndex].close;
    }
    if (barIndex >= 0) return bars[barIndex].close;
    const trades = tradePricesBySymbol.get(symbol) ?? [];
    const tradeIndex = lastIndexOnOrBefore(trades, day, (trade) => trade.t);
    if (tradeIndex >= 0) {
      tradePriceSymbols.add(symbol);
      return trades[tradeIndex].close;
    }
    unpricedSymbols.add(symbol);
    return null;
  };
  const intrinsicValue = (position: Position, day: string): number => {
    const contract = optionContracts.get(position.symbol) ?? parseOccSymbol(position.symbol);
    if (!contract) {
      unpricedSymbols.add(position.symbol);
      return 0;
    }
    // Without a closing record an expired contract keeps its value at expiry
    // (the economic result of exercise or assignment), not later prices.
    const expired = day > contract.expirationDate;
    if (expired) expiredOpenOptions.add(position.symbol);
    const underlying = closeFor(contract.underlyingSymbol, expired ? contract.expirationDate : day);
    if (underlying == null) return 0;
    intrinsicOptions.add(position.symbol);
    const perShare = contract.optionType === 'call'
      ? Math.max(0, underlying - contract.strikePrice)
      : Math.max(0, contract.strikePrice - underlying);
    return position.quantity * (position.contractMultiplier ?? 100) * perShare;
  };
  const cashOn = (timeline: AccountTimeline, day: string): number => {
    if (timeline.cash.length === 0) return timeline.account.cash_balance;
    const span = spanOn(timeline, day);
    if (!span) {
      const cashIndex = lastIndexOnOrBefore(timeline.cash, day, (row) => row.date);
      // Before the first row its own balance stands: a later sync's trades of that day came after.
      return cashIndex < 0 ? timeline.cash[0].observed : timeline.cash[cashIndex].balance;
    }
    // With trades or sweeps in the span, the events stand until the first of them and the later balance
    // from then on, whenever the broker's balance was adopted: the adoption can't be told apart from the
    // cash those trades moved, and the later balance before them would backdate it.
    const fromLater = span.unexplainedFrom !== null
      ? day >= span.unexplainedFrom
      : span.correctionDay !== null && day >= span.correctionDay;
    // Forward from the earlier row through the events so far, or back from the later balance through the
    // events still to come.
    return fromLater
      ? span.events.reduce((cash, event) => (event.date > day ? cash - event.amount : cash), span.endBalance)
      : span.events.reduce((cash, event) => (event.date <= day ? cash + event.amount : cash), span.balance);
  };

  // The first point valued with the later balance after a trade or sweep the events don't cover marks the
  // switch, even when the trades fall on days without a point of their own (a weekend). A switch before
  // the first day happened outside the range; one after the last day lands on the live point.
  const switchDays = new Map<CashSpan, string | typeof LIVE_SWITCH>();
  for (const timeline of timelines) {
    for (const span of timeline.cashSpans) {
      const from = span.unexplainedFrom;
      if (from === null) continue;
      const index = days.findIndex((day) => day >= from);
      if (index < 0) switchDays.set(span, LIVE_SWITCH);
      else if (from >= days[0]) switchDays.set(span, days[index]);
    }
  }
  // Spans whose approximate stretch or switch shows in the range, for the reasons below.
  const approximatedSpans = new Set<CashSpan>();
  const points: PortfolioPoint[] = [];
  for (const day of days) {
    let value = 0;
    let costBasis = 0;
    let active = false;
    let approximateCash = false;
    for (const timeline of timelines) {
      if (day < timeline.start) continue;
      active = true;
      for (const span of timeline.cashSpans) {
        if (span.unexplainedFrom !== null && day >= span.unexplainedFrom
          && (day <= span.unexplainedUntil! || day === switchDays.get(span))) {
          approximateCash = true;
          approximatedSpans.add(span);
        }
      }
      const stateIndex = lastIndexOnOrBefore(timeline.states, day, (state) => state.date);
      const cash = cashOn(timeline, day);
      value += cash;
      costBasis += cash;
      for (const position of stateIndex >= 0 ? timeline.states[stateIndex].positions : []) {
        costBasis += position.costBasis;
        if (position.instrumentType === 'option') {
          value += intrinsicValue(position, day);
        } else {
          const close = closeFor(position.symbol, day);
          if (close != null) value += position.quantity * close;
        }
      }
    }
    if (active) {
      points.push({
        t: day,
        value: roundCents(value),
        costBasis: roundCents(costBasis),
        // Cash that mistimes trades: visible context, never the start of a period change.
        ...(approximateCash ? { unreliable: true } : {}),
      });
    }
  }
  // Days on which every documented account was still empty only add a flat
  // zero line, a $0 period low and a meaningless percentage base.
  const firstNonZero = points.findIndex((point) => point.value !== 0 || point.costBasis !== 0);
  if (firstNonZero > 0) points.splice(0, firstNonZero);
  if (points.length < 2) return null;

  // The last point uses the same live inputs as the headline: current
  // quotes (option marks included) and today's cash for EVERY account in
  // scope, including one whose history starts after the last business day.
  const approximationReasons: string[] = [];
  const lastDay = points[points.length - 1].t;
  const finalPositions = timelines.map((timeline) => ({
    timeline,
    positions: timeline.states.at(-1)?.positions ?? [],
  }));
  const liveSymbols = Array.from(new Set(
    finalPositions.flatMap(({ positions }) => positions.map((position) => position.symbol)),
  ));
  let liveQuotes: Quote[] = [];
  if (liveSymbols.length > 0) {
    try {
      liveQuotes = await (deps.fetchQuotes ?? getQuotes)(liveSymbols);
    } catch {
      liveQuotes = [];
    }
  }
  const livePrice = new Map(
    liveQuotes
      .filter((quote) => Number.isFinite(quote.price) && quote.price > 0)
      .map((quote) => [quote.symbol, quote.price]),
  );
  let liveValue = 0;
  let liveCostBasis = 0;
  for (const { timeline, positions } of finalPositions) {
    liveValue += timeline.account.cash_balance;
    liveCostBasis += timeline.account.cash_balance;
    for (const position of positions) {
      liveCostBasis += position.costBasis;
      const price = livePrice.get(position.symbol);
      if (position.instrumentType === 'option') {
        liveValue += price != null
          ? position.quantity * (position.contractMultiplier ?? 100) * price
          : intrinsicValue(position, lastDay);
      } else {
        const close = price ?? closeFor(position.symbol, lastDay);
        if (close != null) liveValue += position.quantity * close;
      }
    }
  }
  const replaced = points[points.length - 1];
  // The live point takes today's balance for every account. Where that is the switch from the events to
  // the later balance after trades they don't cover (dated after the last point, even after a cash row
  // dated on it), it stays approximate: no period change is measured across it.
  const liveSwitches = timelines
    .filter((timeline) => timeline.start <= lastDay)
    .flatMap((timeline) => timeline.cashSpans)
    .filter((span) => switchDays.get(span) === LIVE_SWITCH);
  for (const span of liveSwitches) approximatedSpans.add(span);
  points[points.length - 1] = {
    t: lastDay,
    value: roundCents(liveValue),
    costBasis: roundCents(liveCostBasis),
    ...(replaced.unreliable || liveSwitches.length > 0 ? { unreliable: true } : {}),
  };
  // Where the later balance first applies for an account whose recorded events don't reach it: the
  // broker's figure replacing Holdr's, a cash correction rather than a market move. After a cash row
  // dated on the last point there is no rebuilt day for it to correct.
  const corrected: Array<{ timeline: AccountTimeline; day: string }> = [];
  for (const timeline of timelines) {
    for (const span of timeline.cashSpans) {
      if (span.unexplainedFrom !== null || span.after >= lastDay
        || Math.abs(span.residual) <= CASH_TAIL_TOLERANCE) continue;
      const target = span.correctionDay ?? span.until ?? lastDay;
      const stepDay = target <= lastDay ? target : lastDay;
      const index = points.findIndex((point) => point.t >= stepDay);
      // A correction before the first point leaves the whole range on the corrected balance.
      if (index <= 0) continue;
      points[index] = { ...points[index], cashCorrection: true };
      corrected.push({ timeline, day: points[index].t });
    }
  }

  const returns = buildReturnSeries({
    points,
    timelines,
    cashOn,
    income: cashEvents
      .filter((row) => RETURN_INCOME_TYPES.has(row.event_type))
      .map((row) => ({ accountId: row.account_id, date: row.event_date, amount: row.amount })),
    optionTrades: transactions.filter((transaction) => (
      transaction.instrumentType === 'option' && !isHoldingSnapshotRow(transaction)
    )),
    // Marked exactly like the value series, including the live final point.
    mark: (symbol, quantity, isOption, multiplier, day, live) => {
      const quote = live ? livePrice.get(symbol) : undefined;
      if (!isOption) {
        const close = quote ?? closeFor(symbol, day);
        return close == null ? null : quantity * close;
      }
      if (quote != null) return quantity * multiplier * quote;
      const contract = optionContracts.get(symbol) ?? parseOccSymbol(symbol);
      if (!contract) return null;
      const underlying = closeFor(contract.underlyingSymbol, day > contract.expirationDate ? contract.expirationDate : day);
      if (underlying == null) return null;
      const perShare = contract.optionType === 'call'
        ? Math.max(0, underlying - contract.strikePrice)
        : Math.max(0, contract.strikePrice - underlying);
      return quantity * multiplier * perShare;
    },
  });

  const inGrid = (timeline: AccountTimeline) => timeline.start <= lastDay;
  approximationReasons.push("estimated by replaying every recorded transaction at each day's closing price");
  const withCash = timelines.filter((timeline) => inGrid(timeline) && timeline.cash.length > 0);
  const withoutCash = timelines.filter((timeline) => inGrid(timeline) && timeline.cash.length === 0);
  if (withCash.length > 0) {
    approximationReasons.push(
      `cash uses broker end-of-day balances for ${withCash.length} account${withCash.length === 1 ? '' : 's'}`,
    );
    const heldEarly = withCash.filter((timeline) => timeline.cash[0].date > gridFrom && timeline.start < timeline.cash[0].date);
    if (heldEarly.length > 0) {
      approximationReasons.push(`cash before broker history held at the earliest known balance: ${listSome(
        heldEarly.map((timeline) => `${timeline.account.name} (before ${timeline.cash[0].date})`),
      )}`);
    }
    // Spans with a rebuilt day on a point in range, for the tails (after the newest row) and the gaps.
    const shown = withCash
      .flatMap((timeline) => timeline.cashSpans.map((span) => ({ timeline, span })))
      .filter(({ span }) => points.some((point) => point.t > span.after && (span.until === null || point.t < span.until)));
    const followed = shown.filter(({ span }) => span.unexplainedFrom === null);
    const followedTails = followed.filter(({ span }) => span.until === null);
    if (followedTails.length > 0) {
      approximationReasons.push(`cash after broker history ends follows the recorded cash events (derived when read; nothing is stored): ${listSome(
        followedTails.map(({ timeline, span }) => `${timeline.account.name} (after ${span.after})`),
      )}`);
    }
    const followedGaps = followed.filter(({ span }) => span.until !== null);
    if (followedGaps.length > 0) {
      approximationReasons.push(`cash on business days between broker cash rows around a sync capture follows the recorded cash events (derived when read; nothing is stored): ${listSome(
        followedGaps.map(({ timeline, span }) => `${timeline.account.name} (${span.after} to ${span.until})`),
      )}`);
    }
    // Capture days whose end-of-day cash a past point uses: the day itself, or days rebuilt from it.
    const shownDays = (timeline: AccountTimeline, days: string[]) => days
      .filter((day) => {
        const nextRow = timeline.cash.find((row) => row.date > day)?.date ?? lastDay;
        return points.some((point) => point.t >= day && point.t < nextRow && point.t < lastDay);
      })
      .map((day) => `${timeline.account.name} (${day})`);
    const lateTraded = withCash.flatMap((timeline) => shownDays(timeline, timeline.lateTradeDays));
    if (lateTraded.length > 0) {
      approximationReasons.push(`cash on days with trades a later sync applied is the next balance less the cash events between, which those trades account for (derived when read; nothing is stored): ${listSome(lateTraded)}`);
    }
    const lateKept = withCash.flatMap((timeline) => shownDays(timeline, timeline.unconfirmedLateDays));
    if (lateKept.length > 0) {
      approximationReasons.push(`cash on days with trades a later sync applied that nothing after them confirms stays at that day's sync capture, which those trades may have moved: ${listSome(lateKept)}`);
    }
    if (corrected.length > 0) {
      approximationReasons.push(`cash steps to the broker's balance where the recorded cash events don't reach it, a correction rather than a market move, which returns leave out: ${listSome(
        corrected.map(({ timeline, day }) => `${timeline.account.name} (${day})`),
      )}`);
    }
    // Every switch to the later balance after trades or sweeps that shows in the range is flagged, the
    // live point's included.
    const approximated = withCash
      .flatMap((timeline) => timeline.cashSpans.map((span) => ({ timeline, span })))
      .filter(({ span }) => approximatedSpans.has(span));
    const approximatedTails = approximated.filter(({ span }) => span.until === null);
    if (approximatedTails.length > 0) {
      approximationReasons.push(`cash around trades or sweeps the broker cash history doesn't cover yet is today's balance less later cash events, shown as approximate and never the start of a period change: ${listSome(
        approximatedTails.map(({ timeline, span }) => `${timeline.account.name} (${span.unexplainedFrom} to ${span.unexplainedUntil})`),
      )}`);
    }
    const approximatedGaps = approximated.filter(({ span }) => span.until !== null);
    if (approximatedGaps.length > 0) {
      approximationReasons.push(`cash around trades or sweeps between broker cash rows is the next row's balance less the cash events until it, shown as approximate and never the start of a period change: ${listSome(
        approximatedGaps.map(({ timeline, span }) => `${timeline.account.name} (${span.unexplainedFrom} to ${span.unexplainedUntil})`),
      )}`);
    }
  }
  if (withoutCash.length > 0) {
    approximationReasons.push(`cash held at current balance (no broker cash history): ${listSome(
      withoutCash.map((timeline) => timeline.account.name),
    )}`);
  }
  const joined = timelines.filter((timeline) => timeline.start > gridFrom && inGrid(timeline));
  if (joined.length > 0) {
    approximationReasons.push(`accounts join on their first recorded activity (or when added): ${listSome(
      joined
        .slice()
        .sort((left, right) => left.start.localeCompare(right.start))
        .map((timeline) => `${timeline.account.name} (${timeline.start})`),
    )}`);
  }
  const seeded = timelines.filter((timeline) => timeline.seedDates.some((date) => date >= gridFrom && date <= lastDay));
  if (seeded.length > 0) {
    approximationReasons.push(`holdings imported without trade history appear on their import date: ${listSome(
      seeded.map((timeline) => `${timeline.account.name} (${timeline.seedDates.join(', ')})`),
    )}`);
  }
  const orphaned = timelines
    .map((timeline) => ({
      timeline,
      symbols: Array.from(new Set(timeline.orphanSells
        .filter((sell) => sell.date <= lastDay)
        .map((sell) => sell.symbol))).sort(),
    }))
    .filter(({ symbols }) => symbols.length > 0);
  if (orphaned.length > 0) {
    approximationReasons.push(`recorded sells exceed recorded buys (incomplete trade history): ${listSome(
      orphaned.map(({ timeline, symbols }) => `${symbols.join('/')} in ${timeline.account.name}`),
    )}`);
  }
  if (intrinsicOptions.size > 0) {
    approximationReasons.push(`options valued at intrinsic value on past dates: ${listSome(
      Array.from(intrinsicOptions).sort().map(formatOptionSymbol),
    )}`);
  }
  if (expiredOpenOptions.size > 0) {
    approximationReasons.push(`options past expiry without a closing record held at their expiry value: ${listSome(
      Array.from(expiredOpenOptions).sort().map(formatOptionSymbol),
    )}`);
  }
  if (manualSymbols.size > 0) {
    approximationReasons.push(`manual price overrides applied for ${Array.from(manualSymbols).sort().join(', ')}`);
  }
  if (tradePriceSymbols.size > 0) {
    approximationReasons.push(`valued at the last trade price where no daily close exists: ${Array.from(tradePriceSymbols).sort().join(', ')}`);
  }
  if (unpricedSymbols.size > 0) {
    approximationReasons.push(`no price available on some dates (excluded there): ${Array.from(unpricedSymbols).sort().join(', ')}`);
  }
  if (fetchFailures.length > 0) {
    approximationReasons.push(`price history refresh failed for ${fetchFailures.sort().join(', ')}; cached closes used`);
  }
  if (unsupportedSymbols.length > 0) {
    approximationReasons.push(`no daily price history available for ${unsupportedSymbols.sort().join(', ')}`);
  }
  const liveSession = liveQuotes.find((quote) => !parseOccSymbol(quote.symbol))?.session;
  if (liveSession === 'pre-market' || liveSession === 'after-hours') {
    approximationReasons.push(`last point uses ${liveSession} prices; earlier points are regular-session closes`);
  }

  // A weekend or holiday range end is covered by the last business day; ALL
  // means the documented history, so it starts wherever the series starts.
  const coverage = measureCoverage(
    range === 'ALL' ? points[0].t : gridFrom === requestedFrom ? days[0] : requestedFrom,
    days[days.length - 1],
    points,
  );
  // As for captured snapshots: a period change starts after the last point valued with stand-in cash.
  const unreliablePoints = points.filter((point) => point.unreliable).length;
  const latestReliable = unreliablePoints > 0 ? latestReliableSegment(points) : points;
  return {
    result: {
      range,
      from: points[0].t,
      to: requested.to,
      supported: true,
      approximate: true,
      approximationReasons,
      source: 'reconstruction',
      valueMethod: 'ledger_estimate',
      coverage,
      points,
      ...(unreliablePoints > 0
        ? { reliability: { totalPoints: points.length, unreliablePoints, latestReliableFrom: latestReliable[0]?.t ?? null } }
        : {}),
      summary: summarize(latestReliable),
      returns,
    },
    timelines,
  };
}

interface ReturnSeriesInput {
  /** Final value points; the last one is the live point. */
  points: PortfolioPoint[];
  timelines: AccountTimeline[];
  cashOn: (timeline: AccountTimeline, day: string) => number;
  income: Array<{ accountId: string; date: string; amount: number }>;
  optionTrades: Transaction[];
  /** Market value of `quantity` units on `day`, or null when unpriced. */
  mark: (symbol: string, quantity: number, isOption: boolean, multiplier: number, day: string, live: boolean) => number | null;
}

/**
 * Chained daily return: the move of holdings carried from the previous close,
 * plus income and option trades, over the previous day's value. Every other
 * value change (deposits, transfers, share deposits, new accounts) is money moving.
 */
function buildReturnSeries(input: ReturnSeriesInput): PortfolioReturnSeries {
  const { points, timelines, cashOn, mark } = input;
  const income = input.income.slice().sort((left, right) => left.date.localeCompare(right.date));
  const optionTrades = input.optionTrades.slice().sort((left, right) => left.date.localeCompare(right.date));
  let incomeCursor = 0;
  while (incomeCursor < income.length && income[incomeCursor].date <= points[0].t) incomeCursor++;
  let tradeCursor = 0;
  while (tradeCursor < optionTrades.length && optionTrades[tradeCursor].date <= points[0].t) tradeCursor++;
  const timelineById = new Map(timelines.map((timeline) => [timeline.account.id, timeline]));
  // An entry counts only once its account is part of the previous day's value.
  const inBase = (accountId: string, previous: string) => {
    const timeline = timelineById.get(accountId);
    return timeline !== undefined && previous >= timeline.start;
  };

  let growth = 1;
  let totalGain = 0;
  let borrowedDays = 0;
  let skippedDays = 0;
  let entriesBeforeStart = 0;
  const returnPoints: PortfolioReturnPoint[] = [{ t: points[0].t, cumulative: 0, gain: 0 }];
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1].t;
    const day = points[index].t;
    const live = index === points.length - 1;
    let gain = 0;
    let negativeCash = 0;
    for (const timeline of timelines) {
      if (previous < timeline.start) continue;
      const cash = cashOn(timeline, previous);
      if (cash < 0) negativeCash -= cash;
      const stateIndex = lastIndexOnOrBefore(timeline.states, previous, (state) => state.date);
      for (const position of stateIndex >= 0 ? timeline.states[stateIndex].positions : []) {
        const isOption = position.instrumentType === 'option';
        const multiplier = position.contractMultiplier ?? 100;
        const before = mark(position.symbol, position.quantity, isOption, multiplier, previous, false);
        const after = mark(position.symbol, position.quantity, isOption, multiplier, day, live);
        if (before != null && after != null) gain += after - before;
      }
    }
    for (; tradeCursor < optionTrades.length && optionTrades[tradeCursor].date <= day; tradeCursor++) {
      const trade = optionTrades[tradeCursor];
      if (!inBase(trade.accountId, previous)) {
        entriesBeforeStart++;
        continue;
      }
      const multiplier = trade.contractMultiplier ?? 100;
      const value = mark(trade.symbol, trade.quantity, true, multiplier, day, live) ?? 0;
      gain += value - trade.quantity * trade.pricePerUnit * multiplier - (trade.fees ?? 0);
    }
    for (; incomeCursor < income.length && income[incomeCursor].date <= day; incomeCursor++) {
      if (!inBase(income[incomeCursor].accountId, previous)) {
        entriesBeforeStart++;
        continue;
      }
      gain += income[incomeCursor].amount;
    }
    // Negative broker cash is an unsettled purchase, not equity to divide by.
    if (negativeCash > 0) borrowedDays++;
    const base = points[index - 1].value + negativeCash;
    if (base > 0 && 1 + gain / base > 0) {
      growth *= 1 + gain / base;
    } else if (Math.abs(gain) >= 0.005) {
      skippedDays++;
    }
    totalGain += gain;
    returnPoints.push({ t: day, cumulative: roundRatio(growth - 1), gain: roundCents(totalGain) });
  }

  const first = points[0];
  const last = points[points.length - 1];
  const spanDays = (Date.parse(`${last.t}T00:00:00Z`) - Date.parse(`${first.t}T00:00:00Z`)) / 86_400_000;
  const cumulative = returnPoints[returnPoints.length - 1].cumulative;
  const notes = [
    "time-weighted: each day's gain (price moves, dividends, interest, fees) divided by that day's starting value, then chained",
    'deposits, withdrawals, transfers, tax withholding, RSU/ESPP/ACAT share deposits and new accounts are money added, not return',
    'a stock trade counts from its first full day held; its trade-day move is left out',
    'options use intrinsic value on past days; premiums count when received or paid',
  ];
  if (borrowedDays > 0) {
    notes.push(`negative cash from unsettled purchases is not subtracted from the starting value (${borrowedDays} day${borrowedDays === 1 ? '' : 's'})`);
  }
  if (skippedDays > 0) {
    notes.push(`${skippedDays} day${skippedDays === 1 ? '' : 's'} with no starting value left out`);
  }
  if (entriesBeforeStart > 0) {
    notes.push(`${entriesBeforeStart} income or option entr${entriesBeforeStart === 1 ? 'y' : 'ies'} on or before their account's first recorded day left out`);
  }
  const moneyWeighted = moneyWeightedReturn(points, returnPoints, 0, points.length - 1);
  return {
    method: 'time_weighted',
    points: returnPoints,
    summary: {
      cumulative,
      annualized: annualizeReturn(cumulative, spanDays),
      gain: roundCents(totalGain),
      netFlows: roundCents(last.value - first.value - totalGain),
      moneyWeighted,
      moneyWeightedAnnualized: annualizeReturn(moneyWeighted, spanDays),
    },
    notes,
  };
}

function roundRatio(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

/** Compound annual rate for a total return over `spanDays`; null below a year. */
function annualizeReturn(total: number | null, spanDays: number): number | null {
  if (total == null || spanDays < 365 || total <= -1) return null;
  return roundRatio((1 + total) ** (365.25 / spanDays) - 1);
}

/**
 * Money-weighted return between points[start] and points[end], not annualized:
 * the one growth rate that turns the starting value plus each day's money
 * added (value change that is not investment gain) into the ending value.
 * Null when no rate fits, e.g. nothing was ever invested, or when several do.
 */
export function moneyWeightedReturn(
  points: PortfolioPoint[],
  returnPoints: PortfolioReturnPoint[],
  start: number,
  end: number,
): number | null {
  const spanDays = daysBetween(points[start].t, points[end].t);
  if (!(spanDays > 0)) return null;
  // Each amount is money put in (negative) or taken out (positive), in whole
  // cents so same-day amounts cancel exactly, at its fraction of the span.
  // A few cents of rounding between values and gains is not money moving.
  const toCents = (dollars: number) => Math.round(dollars * 100);
  const flows: Array<{ at: number; amount: number }> = [{ at: 0, amount: -toCents(points[start].value) }];
  for (let index = start + 1; index <= end; index++) {
    const added = toCents(points[index].value - points[index - 1].value
      - (returnPoints[index].gain - returnPoints[index - 1].gain));
    if (Math.abs(added) >= 5) {
      flows.push({ at: daysBetween(points[start].t, points[index].t) / spanDays, amount: -added });
    }
  }
  const lastFlow = flows[flows.length - 1];
  if (lastFlow.at === 1) lastFlow.amount += toCents(points[end].value);
  else flows.push({ at: 1, amount: toCents(points[end].value) });
  const moves = flows.filter((flow) => flow.amount !== 0);
  if (moves.length < 2) return null;
  const discountedAt = (rate: number) => moves.map((flow) => flow.amount / (1 + rate) ** flow.at);
  const presentValue = (rate: number) => discountedAt(rate).reduce((sum, amount) => sum + amount, 0);
  let low = MIN_PERIOD_RATE;
  let high = MAX_PERIOD_RATE;
  const lowSign = Math.sign(presentValue(low));
  const highSign = Math.sign(presentValue(high));
  if (lowSign === 0 || highSign === 0 || lowSign === highSign) return null;
  for (let step = 0; step < 200 && high - low > 1e-10; step++) {
    const middle = (low + high) / 2;
    if (Math.sign(presentValue(middle)) === lowSign) low = middle;
    else high = middle;
  }
  // Only a rate that is provably the only one is reported. Summing by parts,
  // the present value at any rate g is a sum of the running totals D_k of the
  // flows discounted at a pivot r, each times a factor that is negative for
  // g < r and positive for g > r, plus the full total times a positive factor.
  // If every running total before the last has the sign s of the first flow
  // (the money stayed invested), and the full total has sign -s at `low` and
  // s at `high`, the present value keeps one sign below `low` and the other
  // above `high`: no other rate fits. Running totals before the last that are
  // within rounding error of zero count as unknown, so the rate is withheld;
  // a full total that close to zero is the root itself and is accepted.
  const s = Math.sign(moves[0].amount);
  const certifies = (rate: number, totalSign: number) => {
    const discounted = discountedAt(rate);
    const margin = 1e-9 * discounted.reduce((sum, amount) => sum + Math.abs(amount), 0);
    let runningTotal = 0;
    for (let index = 0; index < discounted.length - 1; index++) {
      runningTotal += discounted[index];
      if (!(s * runningTotal > margin)) return false;
    }
    const total = runningTotal + discounted[discounted.length - 1];
    return Math.abs(total) <= margin || Math.sign(total) === totalSign;
  };
  if (!certifies(low, -s) || !certifies(high, s)) return null;
  const rate = roundRatio((low + high) / 2);
  return rate === 0 ? 0 : rate;
}

const MIN_PERIOD_RATE = -0.9999;
const MAX_PERIOD_RATE = 1_000;

const BENCHMARK_SYMBOLS = ['QQQ', 'SPY'] as const;
// A benchmark close older than this (a week of holidays at most) is missing data.
const BENCHMARK_MAX_STALE_DAYS = 6;

/** Benchmark close on or shortly before `day`; null when none is recent. */
function recentClose(bars: Array<{ t: string; close: number }>, day: string): { t: string; close: number } | null {
  const index = lastIndexOnOrBefore(bars, day, (bar) => bar.t);
  if (index < 0 || daysBetween(bars[index].t, day) > BENCHMARK_MAX_STALE_DAYS) return null;
  return bars[index];
}

/** The same calendar date `years` earlier; Feb 29 becomes Feb 28. */
function yearsBefore(day: string, years: number): string {
  const [year, month, date] = day.split('-').map(Number);
  const target = year - years;
  const lastDate = new Date(Date.UTC(target, month, 0)).getUTCDate();
  return `${target}-${String(month).padStart(2, '0')}-${String(Math.min(date, lastDate)).padStart(2, '0')}`;
}

/**
 * First day from which every account's records describe it fully: an account
 * whose broker cash history opens with money in it that recorded deposits
 * net of withdrawals do not explain, or with trades before that history, is
 * only known from the history's first day; a holding snapshot is only known
 * from its own date.
 */
function recordsCompleteFrom(
  timelines: AccountTimeline[],
  netMoneyInBy: (accountId: string, day: string) => number,
): string | null {
  const knownFrom: string[] = [];
  for (const timeline of timelines) {
    const firstCash = timeline.cash[0];
    if (firstCash) {
      const balance = firstCash.observed;
      const openedFunded = balance < -0.005
        || (balance > 0.005 && netMoneyInBy(timeline.account.id, firstCash.date) < balance - Math.max(1, balance * 0.01));
      const tradedBefore = timeline.states.length > 0 && timeline.states[0].date < firstCash.date;
      if (openedFunded || tradedBefore) knownFrom.push(firstCash.date);
    }
    knownFrom.push(...timeline.seedDates);
  }
  return knownFrom.sort().at(-1) ?? null;
}

/**
 * Long-run performance for the whole ledger series: trailing periods,
 * calendar years and benchmarks, each with time- and money-weighted returns.
 * Null when the scope has no ledger to replay.
 */
export async function getPortfolioPerformance(
  deps: PortfolioHistoryDeps,
  accountIds?: string[],
  now: Date = new Date(),
): Promise<PortfolioPerformance | null> {
  const replay = await replayLedger(deps, 'ALL', accountIds, now);
  const returns = replay?.result.returns;
  if (!replay || !returns) return null;
  const { points } = replay.result;
  const returnPoints = returns.points;
  const last = points.length - 1;
  const inception = points[0].t;
  const asOf = points[last].t;

  const db: DB = deps.state.internalGetDb();
  const moneyMoves = db.prepare(
    `SELECT account_id, event_date, amount FROM account_cash_events
     WHERE event_type NOT IN (${Array.from(RETURN_INCOME_TYPES).map(() => '?').join(',')})`,
  ).all(...RETURN_INCOME_TYPES) as Array<{ account_id: string; event_date: string; amount: number }>;
  const recordedFrom = recordsCompleteFrom(
    replay.timelines,
    (accountId, day) => moneyMoves
      .filter((row) => row.account_id === accountId && row.event_date <= day)
      .reduce((sum, row) => sum + row.amount, 0),
  );
  const completeFrom = recordedFrom !== null && recordedFrom > inception ? recordedFrom : null;

  // Benchmark closes reach back before the first point so it has a prior close.
  const benchmarkRange: RangeKey = rangeBounds('5Y', now).from <= isoDaysBefore(inception, 10) ? '5Y' : 'ALL';
  const benchmarks = await Promise.all(BENCHMARK_SYMBOLS.map(async (symbol) => {
    try {
      await getSymbolHistory(deps.history, symbol, benchmarkRange, now);
    } catch {
      // Cached closes still serve.
    }
    // One close per date, preferring sources the same way the price charts do.
    const bars = pickOneBarPerDate(deps.history.readBars(symbol, '1900-01-01', asOf))
      .map((bar) => ({ t: bar.t, close: bar.close }));
    return { symbol, bars };
  }));

  const measure = (start: number, end: number): PortfolioPerformanceFigures => {
    const from = points[start].t;
    const to = points[end].t;
    const spanDays = daysBetween(from, to);
    const timeWeighted = roundRatio((1 + returnPoints[end].cumulative) / (1 + returnPoints[start].cumulative) - 1);
    const moneyWeighted = moneyWeightedReturn(points, returnPoints, start, end);
    const gain = roundCents(returnPoints[end].gain - returnPoints[start].gain);
    return {
      from,
      to,
      partial: completeFrom !== null && from < completeFrom,
      startValue: points[start].value,
      endValue: points[end].value,
      gain,
      netFlows: roundCents(points[end].value - points[start].value - gain),
      timeWeighted,
      timeWeightedAnnualized: annualizeReturn(timeWeighted, spanDays),
      moneyWeighted,
      moneyWeightedAnnualized: annualizeReturn(moneyWeighted, spanDays),
      benchmarks: Object.fromEntries(benchmarks.map(({ symbol, bars }) => {
        const before = recentClose(bars, from);
        const after = recentClose(bars, to);
        if (before == null || after == null || before.close <= 0) return [symbol, null];
        const total = roundRatio(after.close / before.close - 1);
        return [symbol, { return: total, annualized: annualizeReturn(total, spanDays), from: before.t, to: after.t }];
      })),
    };
  };
  const indexOnOrBefore = (day: string) => lastIndexOnOrBefore(points, day, (point) => point.t);

  const periods: PortfolioPerformancePeriod[] = [];
  // A trailing period that would reach back to the first point is the
  // inception period, so it is listed once, as that.
  const addPeriod = (key: PortfolioPerformancePeriodKey, start: number) => {
    if (start < 0 || start >= last || (start === 0 && key !== 'INCEPTION')) return;
    periods.push({ key, ...measure(start, last) });
  };
  const currentYear = Number(asOf.slice(0, 4));
  addPeriod('YTD', indexOnOrBefore(`${currentYear - 1}-12-31`));
  addPeriod('1Y', indexOnOrBefore(yearsBefore(asOf, 1)));
  addPeriod('3Y', indexOnOrBefore(yearsBefore(asOf, 3)));
  addPeriod('5Y', indexOnOrBefore(yearsBefore(asOf, 5)));
  if (completeFrom !== null) addPeriod('COMPLETE', points.findIndex((point) => point.t >= completeFrom));
  addPeriod('INCEPTION', 0);

  const years: PortfolioPerformanceYear[] = [];
  for (let year = Number(inception.slice(0, 4)); year <= currentYear; year++) {
    const priorYearEnd = indexOnOrBefore(`${year - 1}-12-31`);
    const start = Math.max(0, priorYearEnd);
    const end = indexOnOrBefore(`${year}-12-31`);
    if (end <= start) continue;
    const figures = measure(start, end);
    // A year the series began part-way through is partial too.
    years.push({ year, ytd: year === currentYear, ...figures, partial: figures.partial || priorYearEnd < 0 });
  }

  // Benchmarks end at a daily close; the last household value can be live.
  const benchmarkEnds = benchmarks.flatMap(({ symbol, bars }) => {
    const through = bars.at(-1)?.t;
    return through !== undefined && through < asOf ? [`${symbol} at the ${through} close`] : [];
  });

  return {
    supported: true,
    asOf,
    inception,
    completeFrom,
    benchmarks: [...BENCHMARK_SYMBOLS],
    periods,
    years,
    notes: [
      'time-weighted: daily investment returns chained together, so deposits and withdrawals do not move it; compare this one with QQQ and SPY',
      'money-weighted: the one rate that grows the starting value and every deposit and withdrawal, from its own date, into the ending value (an IRR, like XIRR); it is what your dollars earned, timing included',
      'periods of a year or more show compound annual rates; shorter periods show the total',
      ...([...periods, ...years].some((figures) => figures.moneyWeighted === null)
        ? ['money-weighted is blank (\u2014) where a single rate could not be confirmed: usually when more money was taken out than was still invested, or none was invested']
        : []),
      'QQQ and SPY are price changes between daily closes; their dividends are not included',
      ...(benchmarkEnds.length > 0
        ? [`benchmarks end ${benchmarkEnds.join(' and ')}; your value on ${asOf} uses the latest quotes`]
        : []),
      ...(completeFrom !== null
        ? [`broker records are complete from ${completeFrom}; periods and years that start earlier are marked partial`]
        : []),
    ],
    approximationReasons: replay.result.approximationReasons,
  };
}

async function getFromReconstruction(
  deps: PortfolioHistoryDeps,
  range: PortfolioRangeKey,
  accountIds: string[] | undefined,
  now: Date,
): Promise<PortfolioHistoryResult> {
  const db: DB = deps.state.internalGetDb();
  const { from, to } = rangeBounds(range, now);

  // Load in-scope accounts + transactions.
  const accountFilter = accountIds && accountIds.length > 0
    ? `WHERE id IN (${accountIds.map(() => '?').join(',')})`
    : '';
  const accounts = db.prepare(
    `SELECT id, cash_balance, currency FROM accounts ${accountFilter}`,
  ).all(...(accountIds ?? [])) as AccountRow[];

  if (accounts.length === 0) {
    return makeUnsupported(range, now, 'no accounts match the request');
  }

  const accountIdSet = new Set(accounts.map((a) => a.id));
  const allTxs = db.prepare(
    `SELECT id, account_id, symbol, date, quantity, price_per_unit, fees, currency,
            instrument_type, contract_multiplier, position_effect, notes, source_fingerprint
     FROM transactions`,
  ).all() as TxRow[];
  const txs: Transaction[] = allTxs
    .filter((t) => accountIdSet.has(t.account_id))
    .map(rowToTx);

  // Determine the symbol set we need price history for: any symbol that
  // appears in any transaction — even ones fully sold by the start of the
  // range, since intermediate dates may still have held it.
  const symbols = Array.from(new Set(
    txs
      .filter((transaction) => transaction.instrumentType !== 'option')
      .map((transaction) => transaction.symbol),
  ));

  // Ensure each symbol's daily bars are cached for the requested range.
  // `getSymbolHistory` handles cache + provider fallthrough; running these
  // in parallel keeps cold-start latency tolerable. Failures don't abort —
  // missing-symbol is recorded as an approximation reason.
  const approximationReasons: string[] = [];
  const missingSymbolFirstDate = new Map<string, string>();   // symbol → first available bar
  await Promise.all(
    symbols.map(async (sym) => {
      try {
        const r = await getSymbolHistory(deps.history, sym, range, now);
        if (!r.supported) {
          approximationReasons.push(`no price history available for ${sym}`);
        } else if (r.bars.length > 0 && r.bars[0].t > from) {
          missingSymbolFirstDate.set(sym, r.bars[0].t);
        }
      } catch (err) {
        // A database failure is the request's failure, never a reason quoting it (its message can quote the database).
        if (isDatabaseFailure(err)) throw err;
        // Provider failed — surface, don't crash. Symbol is treated as
        // unpriced for any date its cache doesn't cover.
        approximationReasons.push(`price history fetch failed for ${sym}: ${(err as Error).message}`);
      }
    }),
  );

  // Build a per-symbol list of bars for fast last-known-close lookup. Sort
  // ascending so binary-search-like scans work.
  const barsBySymbol = new Map<string, Array<{ t: string; close: number }>>();
  for (const sym of symbols) {
    const bars = deps.history.readBars(sym, '1900-01-01', to);
    bars.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
    barsBySymbol.set(sym, bars.map((b) => ({ t: b.t, close: b.close })));
  }

  // Tracked total cash across the in-scope accounts at present time. We
  // hold this constant across history because we don't have a cash log —
  // this is the headline approximation.
  const totalCurrentCash = accounts.reduce((s, a) => s + a.cash_balance, 0);
  approximationReasons.unshift('cash held at current balance for prior dates (no cash-history log)');
  approximationReasons.push(
    "values use today's holdings at historical closes; intermediate buys and sells are not reflected",
  );

  // If the requested range starts before the earliest transaction, we have
  // a choice: render those pre-ledger days as "cash only" (literal but
  // useless) or *project* the user's current holdings backward against
  // historical closes (informative, like a brokerage's "what would my
  // current portfolio have been worth then?"). We do the latter — it's
  // what users want to see — and label it explicitly.
  // IMPORTANT: aggregate per-account, then merge across accounts. The
  // naive single-call `aggregatePositions(txs)` pools every txn together
  // and lets an orphan SELL in one account silently cancel real BUYs
  // in other accounts (e.g. a -52.349 MSFT SELL in fid-individual-tod
  // with no matching BUY would cancel 52 of the 330 MSFT shares the
  // user actually owns across other accounts). Per-account aggregation
  // matches `summarizeByAccount`, which is what the Invested-Holdings
  // card uses — so the chart's value series and the card now agree.
  const txsByAcct = new Map<string, Transaction[]>();
  for (const t of txs) {
    if (!txsByAcct.has(t.accountId)) txsByAcct.set(t.accountId, []);
    txsByAcct.get(t.accountId)!.push(t);
  }
  const positionsBySymbol = new Map<string, { quantity: number; costBasis: number }>();
  const openOptionSymbols = new Set<string>();
  for (const acctTxs of txsByAcct.values()) {
    for (const p of aggregatePositions(acctTxs)) {
      if (p.instrumentType === 'option') {
        openOptionSymbols.add(p.symbol);
        continue;
      }
      const prev = positionsBySymbol.get(p.symbol) ?? { quantity: 0, costBasis: 0 };
      positionsBySymbol.set(p.symbol, {
        quantity: prev.quantity + p.quantity,
        costBasis: prev.costBasis + p.costBasis,
      });
    }
  }
  const currentPositions = Array.from(positionsBySymbol.entries()).map(([symbol, v]) => ({
    symbol,
    quantity: v.quantity,
    costBasis: v.costBasis,
    averageCost: v.quantity > 0 ? v.costBasis / v.quantity : 0,
    currency: 'USD' as const,
  }));
  if (openOptionSymbols.size > 0) {
    approximationReasons.push(
      `options excluded from current-holdings backtest: ${Array.from(openOptionSymbols).sort().map(formatOptionSymbol).join(', ')}; current cash may already include option proceeds`,
    );
  }
  const closedSymbols = findClosedPositionSymbols(txsByAcct, currentPositions);
  if (closedSymbols.length > 0) {
    approximationReasons.push(
      `closed positions excluded from current-holdings backtest: ${closedSymbols.join(', ')}`,
    );
  }

  // Iterate business days in [from, to] inclusive.
  //
  // VALUE series: always use today's holdings × historical close. This is
  // the brokerage / Robinhood behavior the user asked for: "what would my
  // current portfolio have been worth on day X?". Using ledger replay
  // creates jarring discontinuities when the ledger is partial — e.g. if
  // half of today's tickers were bought on day N and the other half on
  // day N+1, the chart drops to ~half on day N and snaps back on N+1.
  //
  // COST BASIS series: still uses the ledger so it's accurate per-day.
  // It's a different question ("what did I pay?") with a different right
  // answer, and they don't have to agree visually.
  const points: PortfolioPoint[] = [];
  let firstHoldingPointIdx = -1;
  // Track which symbols got rescued by manual prices so we can clean up
  // approximation reasons that erroneously claim "no price history".
  const symbolsCoveredByManual = new Set<string>();
  for (const day of businessDays(from, to)) {
    // Per-account ledger replay matches the per-account `currentPositions`
    // computed above (see comment there). Skip accounts whose snapshot-up-to-
    // `day` resolves to a short — they're orphan SELLs that shouldn't drag
    // down cost basis for the household.
    let dayCostBasis = totalCurrentCash;
    for (const acctTxs of txsByAcct.values()) {
      const acctLedger = aggregatePositions(acctTxs.filter((t) => t.date <= day));
      for (const lp of acctLedger) {
        if (lp.instrumentType !== 'option') dayCostBasis += lp.costBasis;
      }
    }
    let value = totalCurrentCash;
    let costBasis = dayCostBasis;
    for (const p of currentPositions) {
      // Manual NAV (E.7) takes precedence over the cached daily bar so
      // unlisted holdings stop dropping out of the value series.
      const manual = deps.manualPrices?.closeOnOrBefore(p.symbol, day) ?? null;
      const close = manual ?? priceOnOrBefore(barsBySymbol.get(p.symbol) ?? [], day);
      if (close == null) continue;             // unpriced symbol — drops out of value
      if (manual != null) symbolsCoveredByManual.add(p.symbol);
      value += p.quantity * close;
    }
    if (currentPositions.length > 0 && firstHoldingPointIdx === -1) {
      firstHoldingPointIdx = points.length;
    }
    points.push({ t: day, value, costBasis });
  }

  // List the symbols whose first cached bar is *inside* the range (so the
  // chart's early days are missing them). Helps the user understand why
  // the curve might dip early.
  for (const [sym, firstAvail] of missingSymbolFirstDate.entries()) {
    approximationReasons.push(`${sym} priced from ${firstAvail} onward (earlier dates exclude it)`);
  }

  // E.7 — manual NAV cleanup. Strip "no price history" reasons for symbols
  // that got rescued by a manual override; replace with a single positive
  // note so the user knows the manual entries were honored. We keep the
  // approximate flag because manual NAV entries are still user-supplied
  // estimates, not market closes.
  if (symbolsCoveredByManual.size > 0) {
    const rescued = Array.from(symbolsCoveredByManual);
    for (let i = approximationReasons.length - 1; i >= 0; i--) {
      const reason = approximationReasons[i];
      if (rescued.some((sym) => reason === `no price history available for ${sym}`)) {
        approximationReasons.splice(i, 1);
      }
    }
    approximationReasons.push(
      `manual price overrides applied for ${rescued.sort().join(', ')}`,
    );
  }

  // Last-point freshness: the latest cached daily bar is yesterday's close
  // (or last weekday's). The Grand-total card on the same screen uses live
  // quotes via /quotes, so the chart's headline would otherwise lag the
  // card by minutes-to-hours. Replace the last point's value with a live
  // quote sum so the two numbers match. Cost basis stays from the ledger
  // (it doesn't move intraday). Best-effort — falls back to the daily
  // close on quote-fetch failure.
  if (points.length > 0 && currentPositions.length > 0) {
    try {
      const fetcher = deps.fetchQuotes ?? getQuotes;
      const liveQuotes: Quote[] = await fetcher(currentPositions.map((p) => p.symbol));
      const liveBySym = new Map(liveQuotes.map((q) => [q.symbol, q.price]));
      let liveValue = totalCurrentCash;
      for (const p of currentPositions) {
        const px = liveBySym.get(p.symbol);
        if (px != null) liveValue += p.quantity * px;
        else {
          // Fall back to the day's close if the quote provider didn't
          // return this symbol — better than zero.
          const close = priceOnOrBefore(barsBySymbol.get(p.symbol) ?? [], points[points.length - 1].t);
          if (close != null) liveValue += p.quantity * close;
        }
      }
      points[points.length - 1] = { ...points[points.length - 1], value: liveValue };
      // If the live quotes came during pre-market or after-hours, the
      // chart's last point uses an extended-hours price while every other
      // point is a regular-session close. Surface this — otherwise the
      // user sees a tiny upward/downward "spike" on the right edge that
      // isn't really part of the regular-session curve.
      const liveSession = liveQuotes[0]?.session;
      if (liveSession === 'pre-market') {
        approximationReasons.push(
          'last point uses pre-market price; earlier points are regular-session closes',
        );
      } else if (liveSession === 'after-hours') {
        approximationReasons.push(
          'last point uses after-hours price; earlier points are regular-session closes',
        );
      }
    } catch {
      // Live-quote fetch failed; the last point keeps the daily-close
      // value. No reason added — this is a transient infra issue, not
      // an inherent approximation.
    }
  }

  // Trim leading no-holdings days. Without this, a 1Y request from a user
  // whose earliest tx is yesterday renders as a flat line at the cash
  // baseline for ~252 days followed by a one-pixel jump. We keep ONE
  // baseline day before the first holding so the visual jump is still
  // visible, and surface the trim in the reason list so it's not a
  // hidden mutation.
  let displayPoints = points;
  if (firstHoldingPointIdx > 1) {
    const startIdx = firstHoldingPointIdx - 1;
    displayPoints = points.slice(startIdx);
    approximationReasons.push(
      `chart trimmed to start ${displayPoints[0].t} (earlier ${startIdx} days had no holdings; full requested range was ${from} → ${to})`,
    );
  }

  const coverage = measureCoverage(from, to, displayPoints);
  return {
    range,
    from: coverage.actualFrom ? pointCalendarDate(coverage.actualFrom) : from,
    to,
    supported: true,
    approximate: true,
    approximationReasons,
    source: displayPoints.length > 0 ? 'reconstruction' : 'none',
    valueMethod: 'current_holdings_backtest',
    coverage,
    points: displayPoints,
    summary: summarize(displayPoints),
  };
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function rowToTx(r: TxRow): Transaction {
  return {
    id: r.id, accountId: r.account_id, symbol: r.symbol, date: r.date,
    quantity: r.quantity, pricePerUnit: r.price_per_unit,
    ...(r.instrument_type === 'option'
      ? {
          instrumentType: 'option' as const,
          contractMultiplier: r.contract_multiplier ?? undefined,
          positionEffect: r.position_effect === 'open' || r.position_effect === 'close'
            ? r.position_effect
            : undefined,
        }
      : {}),
    fees: r.fees ?? undefined, currency: r.currency,
    ...(r.notes ? { notes: r.notes } : {}),
    ...(r.source_fingerprint ? { sourceFingerprint: r.source_fingerprint } : {}),
  };
}

function findClosedPositionSymbols(
  txsByAccount: Map<string, Transaction[]>,
  currentPositions: Array<{ symbol: string }>,
): string[] {
  const currentSymbols = new Set(currentPositions.map((position) => position.symbol));
  const accountBalancesBySymbol = new Map<string, number[]>();
  const symbolsWithBuys = new Set<string>();
  for (const accountTransactions of txsByAccount.values()) {
    const balances = new Map<string, number>();
    for (const transaction of accountTransactions) {
      if (transaction.instrumentType === 'option') continue;
      balances.set(
        transaction.symbol,
        (balances.get(transaction.symbol) ?? 0) + transaction.quantity,
      );
      if (transaction.quantity > 0) symbolsWithBuys.add(transaction.symbol);
    }
    for (const [symbol, balance] of balances) {
      const accountBalances = accountBalancesBySymbol.get(symbol) ?? [];
      accountBalances.push(balance);
      accountBalancesBySymbol.set(symbol, accountBalances);
    }
  }
  return Array.from(accountBalancesBySymbol)
    .filter(([symbol, accountBalances]) => (
      !currentSymbols.has(symbol)
      && symbolsWithBuys.has(symbol)
      && accountBalances.every((balance) => Math.abs(balance) <= 1e-9)
    ))
    .map(([symbol]) => symbol)
    .sort();
}

function summarize(points: PortfolioPoint[]): PortfolioHistoryResult['summary'] {
  if (points.length === 0) {
    return { startValue: 0, endValue: 0, change: 0, changePercent: 0 };
  }
  const startValue = points[0].value;
  const endValue = points[points.length - 1].value;
  const change = endValue - startValue;
  const changePercent = startValue !== 0 ? (change / startValue) * 100 : 0;
  return { startValue, endValue, change, changePercent };
}

/** Largest-Triangle-Three-Buckets downsampling for visual-only reference data. */
export function downsampleReferencePoints(
  points: PortfolioPoint[],
  maxPoints: number,
): PortfolioPoint[] {
  if (points.length <= maxPoints || maxPoints >= points.length) return points;
  if (!Number.isInteger(maxPoints) || maxPoints < 3) {
    throw new Error('reference maxPoints must be an integer of at least 3');
  }

  const sampled: PortfolioPoint[] = [points[0]];
  const bucketSize = (points.length - 2) / (maxPoints - 2);
  let anchorIndex = 0;

  for (let bucket = 0; bucket < maxPoints - 2; bucket++) {
    const averageStart = Math.floor((bucket + 1) * bucketSize) + 1;
    const averageEnd = Math.min(Math.floor((bucket + 2) * bucketSize) + 1, points.length);
    let averageX = 0;
    let averageY = 0;
    const averageLength = Math.max(1, averageEnd - averageStart);
    for (let index = averageStart; index < averageEnd; index++) {
      averageX += pointTime(points[index].t);
      averageY += points[index].value;
    }
    if (averageEnd <= averageStart) {
      averageX = pointTime(points[points.length - 1].t);
      averageY = points[points.length - 1].value;
    } else {
      averageX /= averageLength;
      averageY /= averageLength;
    }

    const rangeStart = Math.floor(bucket * bucketSize) + 1;
    const rangeEnd = Math.min(Math.floor((bucket + 1) * bucketSize) + 1, points.length - 1);
    const anchorX = pointTime(points[anchorIndex].t);
    const anchorY = points[anchorIndex].value;
    let selectedIndex = rangeStart;
    let maxArea = -1;
    for (let index = rangeStart; index < rangeEnd; index++) {
      const candidateX = pointTime(points[index].t);
      const area = Math.abs(
        (anchorX - averageX) * (points[index].value - anchorY)
        - (anchorX - candidateX) * (averageY - anchorY),
      );
      if (area > maxArea) {
        maxArea = area;
        selectedIndex = index;
      }
    }
    sampled.push(points[selectedIndex]);
    anchorIndex = selectedIndex;
  }
  sampled.push(points[points.length - 1]);
  return sampled;
}

function pointTime(value: string): number {
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pointCalendarDate(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : marketDate(new Date(value));
}

function lastSnapshotPerDay<T extends PortfolioPoint>(points: T[]): T[] {
  const byDay = new Map<string, T>();
  for (const point of points) {
    const day = pointCalendarDate(point.t);
    const current = byDay.get(day);
    if (!current || pointTime(point.t) > pointTime(current.t)) byDay.set(day, point);
  }
  return Array.from(byDay.values()).sort((a, b) => a.t.localeCompare(b.t));
}

function marketMinuteOfDay(value: Date): number {
  const parts = MARKET_TIME_FORMATTER.formatToParts(value);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error('Unable to format market time');
  }
  return hour * 60 + minute;
}

function measureIntradayCoverage(
  sessionDate: string,
  points: PortfolioPoint[],
  now: Date,
): PortfolioCoverage {
  const actualFrom = points[0]?.t ?? null;
  const actualTo = points[points.length - 1]?.t ?? null;
  if (!actualFrom || !actualTo) {
    return {
      requestedFrom: sessionDate,
      requestedTo: sessionDate,
      actualFrom: null,
      actualTo: null,
      complete: false,
      percent: 0,
    };
  }

  const currentMarketDate = marketDate(now);
  const nowMinute = marketMinuteOfDay(now);
  const expectedEnd = sessionDate === currentMarketDate
    ? Math.max(
        EXTENDED_SESSION_START_MINUTE + SNAPSHOT_INTERVAL_MINUTES,
        Math.min(nowMinute, EXTENDED_SESSION_END_MINUTE),
      )
    : EXTENDED_SESSION_END_MINUTE;
  const firstMinute = marketMinuteOfDay(new Date(actualFrom));
  const lastMinute = marketMinuteOfDay(new Date(actualTo));
  const expectedSpan = Math.max(
    SNAPSHOT_INTERVAL_MINUTES,
    expectedEnd - EXTENDED_SESSION_START_MINUTE,
  );
  // Observed time is each run of points the line connects, plus one interval
  // after its last point. A gap between runs was not observed, so a session
  // with one is not complete even when its first and last points are on time.
  let observedSpan = 0;
  let runStart = 0;
  for (let index = 1; index <= points.length; index++) {
    if (index < points.length && !points[index].gapBefore) continue;
    const start = Math.max(EXTENDED_SESSION_START_MINUTE, marketMinuteOfDay(new Date(points[runStart].t)));
    const end = Math.min(expectedEnd, marketMinuteOfDay(new Date(points[index - 1].t)) + SNAPSHOT_INTERVAL_MINUTES);
    observedSpan += Math.max(0, end - start);
    runStart = index;
  }
  const complete = points.length > 1
    && firstMinute <= EXTENDED_SESSION_START_MINUTE + SNAPSHOT_INTERVAL_MINUTES
    && lastMinute + SNAPSHOT_INTERVAL_MINUTES >= expectedEnd
    && !points.some((point, index) => index > 0 && point.gapBefore);
  const percent = complete
    ? 100
    : Math.round(Math.min(100, (observedSpan / expectedSpan) * 100) * 10) / 10;

  return {
    requestedFrom: sessionDate,
    requestedTo: sessionDate,
    actualFrom,
    actualTo,
    complete,
    percent,
  };
}

function measureCoverage(
  requestedFrom: string,
  requestedTo: string,
  points: PortfolioPoint[],
): PortfolioCoverage {
  const actualFrom = points[0]?.t ?? null;
  const actualTo = points[points.length - 1]?.t ?? null;
  if (!actualFrom || !actualTo) {
    return {
      requestedFrom,
      requestedTo,
      actualFrom: null,
      actualTo: null,
      complete: false,
      percent: 0,
    };
  }

  const requestedStartMs = Date.parse(`${requestedFrom}T00:00:00Z`);
  const requestedEndMs = Date.parse(`${requestedTo}T00:00:00Z`);
  const actualStartMs = Date.parse(`${pointCalendarDate(actualFrom)}T00:00:00Z`);
  const actualEndMs = Date.parse(`${pointCalendarDate(actualTo)}T00:00:00Z`);
  const dayMs = 24 * 60 * 60 * 1000;
  const requestedSpan = Math.max(dayMs, requestedEndMs - requestedStartMs + dayMs);
  const overlapStart = Math.max(requestedStartMs, actualStartMs);
  const overlapEnd = Math.min(requestedEndMs, actualEndMs);
  const overlap = overlapEnd >= overlapStart ? overlapEnd - overlapStart + dayMs : 0;
  const percent = Math.round(Math.min(100, Math.max(0, (overlap / requestedSpan) * 100)) * 10) / 10;

  return {
    requestedFrom,
    requestedTo,
    actualFrom,
    actualTo,
    complete: actualStartMs <= requestedStartMs && actualEndMs >= requestedEndMs,
    percent,
  };
}

/**
 * Multi-day snapshot coverage in market sessions: snapshots only exist on
 * weekdays once the extended session opens, so weekends and the hours before
 * today's open are not missing history.
 */
function measureSessionCoverage(
  requestedFrom: string,
  requestedTo: string,
  points: PortfolioPoint[],
  now: Date,
): PortfolioCoverage {
  const today = marketDate(now);
  const todayOpened = marketMinuteOfDay(now) >= EXTENDED_SESSION_START_MINUTE + SNAPSHOT_INTERVAL_MINUTES;
  const sessions = Array.from(businessDays(requestedFrom, requestedTo))
    .filter((day) => day < today || (day === today && todayOpened));
  if (points.length === 0 || sessions.length === 0) return measureCoverage(requestedFrom, requestedTo, points);
  const firstObserved = pointCalendarDate(points[0].t);
  const lastObserved = pointCalendarDate(points[points.length - 1].t);
  const complete = firstObserved <= sessions[0] && lastObserved >= sessions[sessions.length - 1];
  const observedDays = new Set(points.map((point) => pointCalendarDate(point.t)));
  const covered = sessions.filter((day) => observedDays.has(day)).length;
  return {
    requestedFrom,
    requestedTo,
    actualFrom: points[0].t,
    actualTo: points[points.length - 1].t,
    complete,
    percent: complete ? 100 : Math.round((covered / sessions.length) * 1000) / 10,
  };
}

function filterSnapshotOutliers<T extends PortfolioPoint>(points: T[]): { points: T[]; removed: number } {
  if (points.length < 5) return { points, removed: 0 };
  const out: T[] = [];
  let removed = 0;
  for (let i = 0; i < points.length; i++) {
    if (i < 2 || i > points.length - 3) {
      out.push(points[i]);
      continue;
    }
    const lo = Math.max(0, i - 6);
    const hi = Math.min(points.length, i + 7);
    const neighbors = points
      .slice(lo, hi)
      .filter((_, idx) => lo + idx !== i)
      .map((p) => p.value)
      .filter((v) => Number.isFinite(v));
    if (neighbors.length < 4) {
      out.push(points[i]);
      continue;
    }
    const localMedian = median(neighbors);
    const current = points[i].value;
    const deviation = Math.abs(current - localMedian);
    const threshold = Math.max(500, Math.abs(localMedian) * 0.04);
    const nearbySameLevel = neighbors.filter((v) => {
      const base = Math.max(Math.abs(current), 1);
      return Math.abs(v - current) / base <= 0.04;
    }).length;
    if (deviation > threshold && nearbySameLevel <= 2) {
      removed++;
      continue;
    }
    out.push(points[i]);
  }
  return { points: out, removed };
}

interface SnapshotPoint extends PortfolioPoint {
  cashBalance: number;
}

function annotateSnapshotReliability(
  points: SnapshotPoint[],
  invalidations: HistoryInvalidationRow[],
): SnapshotPoint[] {
  return points.map((point) => {
    const pointDate = pointCalendarDate(point.t);
    const unreliable = invalidations.some((entry) => (
      pointDate >= entry.effective_date && pointTime(point.t) < pointTime(entry.detected_at)
    ));
    return unreliable ? { ...point, unreliable: true } : point;
  });
}

/**
 * A cash correction, unlike added activity, leaves nothing before it known to hold the right cash.
 * Its stored start is the market day of the account's own last observation before the capture. A
 * chart whose last kept point before the correction is older (a household chart that left out a
 * tick observing only some accounts) starts it at that point's day instead, so its returns restart
 * after the correction rather than measuring across it.
 */
function startCashCorrectionAtLastKeptPoint(
  entry: HistoryInvalidationRow,
  points: SnapshotPoint[],
): HistoryInvalidationRow {
  if (entry.reason !== FIDELITY_CASH_ADOPTED_REASON) return entry;
  const detected = pointTime(entry.detected_at);
  let lastKept: string | null = null;
  for (const point of points) {
    if (pointTime(point.t) >= detected) break;
    lastKept = point.t;
  }
  if (lastKept === null) return entry;
  const day = pointCalendarDate(lastKept);
  return day < entry.effective_date ? { ...entry, effective_date: day } : entry;
}

function partitionSnapshotReliabilityRuns(points: SnapshotPoint[]): SnapshotPoint[][] {
  const segments: SnapshotPoint[][] = [];
  let current: SnapshotPoint[] = [];
  for (const point of points) {
    if (
      current.length > 0
      && Boolean(current[current.length - 1].unreliable) !== Boolean(point.unreliable)
    ) {
      segments.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function latestReliableSegment(points: PortfolioPoint[]): PortfolioPoint[] {
  let end = points.length;
  while (end > 0 && points[end - 1].unreliable) end--;
  if (end === 0) return [];
  let start = end - 1;
  while (start > 0 && !points[start - 1].unreliable) start--;
  return points.slice(start, end);
}

function trimLeadingPartialSnapshots(
  points: SnapshotPoint[],
  range: PortfolioRangeKey,
): { points: SnapshotPoint[]; removed: number } {
  if (points.length < 20) return { points, removed: 0 };
  const scanLimit = Math.min(points.length - 1, 200);
  for (let i = 1; i <= scanLimit; i++) {
    const previous = points[i - 1].value;
    const current = points[i].value;
    if (!Number.isFinite(previous) || !Number.isFinite(current) || previous <= 0) continue;
    const jumpPct = (current - previous) / previous;
    if (jumpPct < 0.25) continue;

    const nextValues = points.slice(i, Math.min(points.length, i + 12)).map((p) => p.value);
    const nextMedian = median(nextValues);
    if (nextValues.length < 4 || previous >= nextMedian * 0.8) continue;
    if (range === '1D') {
      const previousPoint = points[i - 1];
      const cashTolerance = Math.max(1, Math.abs(previousPoint.cashBalance) * 0.0001);
      const cashOnly = Math.abs(previousPoint.value - previousPoint.cashBalance) <= cashTolerance
        && Math.abs(previousPoint.costBasis - previousPoint.cashBalance) <= cashTolerance;
      const nextPnlMedian = median(
        points
          .slice(i, Math.min(points.length, i + 12))
          .map((point) => point.value - point.costBasis),
      );
      const priorPnl = previousPoint.value - previousPoint.costBasis;
      const pnlRecovery = Math.abs(nextPnlMedian - priorPnl)
        > Math.max(500, Math.abs(nextMedian) * 0.01);
      if (!cashOnly || !pnlRecovery) continue;
    }
    {
      return { points: points.slice(i), removed: i };
    }
  }
  return { points, removed: 0 };
}

function collapseFlatSnapshotRuns<T extends PortfolioPoint>(
  points: T[],
  range: PortfolioRangeKey,
): { points: T[]; removed: number } {
  if (range === '1D' || points.length < 20) return { points, removed: 0 };
  const out: T[] = [];
  let removed = 0;
  let i = 0;
  while (i < points.length) {
    const start = i;
    i++;
    while (
      i < points.length &&
      Math.abs(points[i].value - points[i - 1].value) <= 1 &&
      Math.abs(points[i].costBasis - points[i - 1].costBasis) <= 1
    ) {
      i++;
    }
    const runLength = i - start;
    if (runLength >= 12) {
      out.push(points[start]);
      out.push(points[i - 1]);
      removed += runLength - 2;
    } else {
      out.push(...points.slice(start, i));
    }
  }
  return { points: out, removed };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function makeUnsupported(
  range: PortfolioRangeKey,
  now: Date,
  reason: string,
): PortfolioHistoryResult {
  const requested = rangeBounds(range, now);
  return {
    range,
    from: requested.from,
    to: requested.to,
    supported: false,
    reason,
    approximate: false,
    approximationReasons: [],
    source: 'none',
    valueMethod: null,
    coverage: measureCoverage(requested.from, requested.to, []),
    points: [],
    summary: { startValue: 0, endValue: 0, change: 0, changePercent: 0 },
  };
}

/**
 * Iterate weekdays from `from` to `to` (inclusive), both YYYY-MM-DD.
 * Doesn't model market holidays — close enough; the only effect of a
 * holiday is the same close repeated, which `priceOnOrBefore` handles.
 */
function* businessDays(from: string, to: string): Generator<string> {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    yield d.toISOString().slice(0, 10);
  }
}

/**
 * Return the close price on or before `day`. For weekends or holidays this
 * carries forward the prior close. Linear scan (sorted bars are passed in);
 * fast enough for our scale (≤ ~250 entries per symbol per request).
 */
function priceOnOrBefore(bars: Array<{ t: string; close: number }>, day: string): number | null {
  let last: number | null = null;
  for (const b of bars) {
    if (b.t > day) break;
    last = b.close;
  }
  return last;
}
