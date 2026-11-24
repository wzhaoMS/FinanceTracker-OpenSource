import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { formatCurrency, formatGainLoss, formatPercent, formatShownAmount, formatShownPercent, type Transaction } from '@finance-tracker/shared';

import { api } from '../services/api';
import { InteractiveChart } from './InteractiveChart';
import { PerformancePanel } from './PerformancePanel';
import { RollingNumber } from './RollingNumber';
import { Info, Trend } from './icons';
import { toneArrow, withTone } from './tone';

const RANGES = ['1D', '1W', '1M', '3M', 'YTD', '1Y', '5Y', 'ALL'] as const;
type Range = (typeof RANGES)[number];
// Returns come from the daily ledger replay, which serves 1M and longer.
const RETURN_RANGES: ReadonlyArray<Range> = ['1M', '3M', 'YTD', '1Y', '5Y', 'ALL'];
type ChartMode = 'value' | 'return';

interface PortfolioPoint {
  t: string;
  value: number;
  costBasis: number;
  unreliable?: boolean;
  /** 1D: nothing was observed since the previous point. */
  gapBefore?: boolean;
  /** Ledger ranges: an account's cash steps to the broker's balance here; not a market move. */
  cashCorrection?: boolean;
  /** 1D at market prices: some holdings were on a price more than 30 minutes old here. */
  estimated?: boolean;
}

interface PortfolioReturnSeries {
  method: 'time_weighted';
  points: Array<{ t: string; cumulative: number; gain: number }>;
  summary: {
    cumulative: number;
    annualized: number | null;
    gain: number;
    netFlows: number;
    /** Money-weighted return (IRR) over the range; absent from older servers. */
    moneyWeighted?: number | null;
    moneyWeightedAnnualized?: number | null;
  };
  notes: string[];
}

interface PortfolioHistoryResponse {
  range: Range;
  from: string;
  to: string;
  supported: boolean;
  reason?: string;
  approximate: boolean;
  approximationReasons: string[];
  source: 'snapshots' | 'reconstruction' | 'intraday_prices' | 'none';
  valueMethod: 'observed_snapshot' | 'ledger_estimate' | 'current_holdings_backtest' | 'holdings_at_market' | null;
  coverage: {
    requestedFrom: string;
    requestedTo: string;
    actualFrom: string | null;
    actualTo: string | null;
    complete: boolean;
    percent: number;
  };
  points: PortfolioPoint[];
  /** 1D at market prices: the session's span for the x-axis. */
  window?: { from: string; to: string };
  reliability?: {
    totalPoints: number;
    unreliablePoints: number;
    latestReliableFrom: string | null;
  };
  referenceSeries?: {
    valueMethod: 'current_holdings_backtest';
    label: 'Current holdings backtest';
    points: PortfolioPoint[];
    approximationReasons: string[];
  };
  summary: { startValue: number; endValue: number; change: number; changePercent: number };
  trackingSince?: string;
  returns?: PortfolioReturnSeries;
}

interface Props {
  /** Optional account scope. Empty / omitted → household-wide. */
  accountIds?: string[];
  /** Headline title. Defaults to "Portfolio". */
  title?: string;
  /** Headline title in the Return view. Defaults to "<title> · Return". */
  returnTitle?: string;
  /**
   * Additional content rendered under the period-change line in the chart
   * header. Used by PortfolioBreakdown to fold in lifetime P&L + cost
   * basis + account count, so we don't need a separate "grand total" card
   * showing the same headline value twice.
   */
  headerExtra?: ReactNode;
  /**
   * Live portfolio value (positions + cash) for the headline. When
   * supplied, the rolling-number headline reflects the *current* total
   * computed from `accounts + transactions + quotes`, NOT the last point
   * of the historical chart series. The chart series can be slightly
   * stale (yesterday's snapshot was taken before the user edited a
   * holding) which would otherwise produce a headline that disagrees
   * with the Combined-holdings card directly below it.
   *
   * The chart line itself is still drawn from `points`. When the user
   * hovers a historical point we show that point's value; when not
   * hovering we show `liveValue`.
   */
  liveValue?: number;
  /**
   * Render the headline as a placeholder ("—") with a muted reason line
   * instead of a number. Used when the parent knows the value would be
   * misleading (e.g. quotes API is down so positions evaluate to $0).
   */
  valueUnavailable?: boolean;
  /** Short message rendered under the placeholder when valueUnavailable. */
  valueUnavailableReason?: string;
  /** Optional trade markers to annotate major buys/sells on the value line. */
  transactions?: Transaction[];
  accountIdToName?: Map<string, string>;
  /**
   * Render the returns-by-period tables under the Return view. Defaults to
   * true; the household chart passes false because the Portfolio page shows
   * them in their own section after the holdings.
   */
  showPerformance?: boolean;
}

/**
 * Robinhood-style portfolio value chart sitting at the top of the
 * Portfolio tab. Reuses `InteractiveChart` (extracted from SymbolChart in
 * B.2) so crosshair + keyboard nav are identical to the per-symbol chart.
 *
 * Data semantics:
 *   - 1M..ALL replay the full transaction ledger (`ledger_estimate`): one
 *     continuous estimated series with every recorded trade, labelled as a
 *     value change because deposits and transfers are included.
 *   - 1D/1W prefer observed account snapshots. Partial observed coverage is
 *     shown only for its actual dates; requested period return is suppressed
 *     and no backtest prefix is joined.
 *   - With no ledger or observed points, 1W..ALL may show an explicitly
 *     labeled current-holdings backtest. 1D remains snapshot-only.
 */
export function PortfolioHistoryChart({ accountIds, title = 'Portfolio', returnTitle, headerExtra, liveValue, valueUnavailable, valueUnavailableReason, transactions = [], accountIdToName, showPerformance = true }: Props) {
  const [range, setRange] = useState<Range>('1D');
  const [mode, setMode] = useState<ChartMode>('value');
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<PortfolioHistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [approxOpen, setApproxOpen] = useState(false);
  const accountsKey = accountIds?.join(',') ?? '';

  // Auto-clear the hovered scrubber position whenever the window loses
  // focus or visibility flips (alt-tab, modal dialog over the chart,
  // OS file picker). Without this, the headline number stays pinned to
  // whatever date the cursor last landed on — surfaces e.g. the period
  // peak instead of the live total when a file-save dialog opens over
  // the chart, because the native dialog intercepts the pointer-leave
  // event the chart relies on.
  useEffect(() => {
    const clear = () => setHoveredIndex(null);
    const clearWhenHidden = () => {
      if (document.visibilityState !== 'visible') clear();
    };
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', clearWhenHidden);
    return () => {
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', clearWhenHidden);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setData(null); setHoveredIndex(null); setApproxOpen(false);
    const accountsQs = accountsKey
      ? `&accounts=${encodeURIComponent(accountsKey)}`
      : '';
    api<PortfolioHistoryResponse>(`/portfolio/history?range=${range}${accountsQs}`)
      .then((res) => { if (!cancelled) setData(res); })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load portfolio history');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [range, accountsKey]);

  const ledgerPoints = data?.points ?? [];
  // A ledger series ends with a live point; pin it to the headline's own live
  // value so hovering the last day never disagrees with the number above it
  // (browser and server can hold quotes from slightly different moments).
  const rawPoints = data?.valueMethod === 'ledger_estimate' && liveValue != null && ledgerPoints.length > 0
    ? [...ledgerPoints.slice(0, -1), { ...ledgerPoints[ledgerPoints.length - 1], value: liveValue }]
    : ledgerPoints;
  const displaySeries = trimLeadingPartialDisplayPoints(rawPoints, range);
  const points = displaySeries.points;
  const unreliablePointCount = data?.reliability?.unreliablePoints
    ?? points.filter((point) => point.unreliable).length;
  const hasUnreliableHistory = unreliablePointCount > 0;
  const latestSegment = latestReliableSegment(points);
  const displaySummary = summarizePortfolioPoints(latestSegment);
  const hoveredPoint = hoveredIndex != null && points.length > 0 ? points[hoveredIndex] : null;
  const hoverSegmentStart = hoveredIndex != null && !hoveredPoint?.unreliable
    ? findReliableSegmentStart(points, hoveredIndex)
    : -1;
  const hoverBaseline = hoverSegmentStart >= 0 ? points[hoverSegmentStart] : null;
  const coverage = data?.coverage ?? null;
  const isBacktest = data?.valueMethod === 'current_holdings_backtest';
  const isLedgerEstimate = data?.valueMethod === 'ledger_estimate';
  const isMarketComputed = data?.valueMethod === 'holdings_at_market';
  // 1D at market prices spans the whole session on the x-axis, like a broker's, and the line ends at now.
  const sessionWindow = isMarketComputed && range === '1D' ? data?.window ?? null : null;
  const hasNoObservedCoverage = data?.valueMethod === 'observed_snapshot' && coverage != null && coverage.actualFrom == null;
  const hasPartialObservedCoverage = data?.valueMethod === 'observed_snapshot' && coverage != null && !coverage.complete;
  const useRequestedDomain = hasPartialObservedCoverage && range !== '1D';
  const showUnobservedPrefix = useRequestedDomain
    && coverage?.actualFrom != null
    && marketCalendarDate(coverage.actualFrom) > coverage.requestedFrom;
  const referencePoints = hasPartialObservedCoverage
    ? rebaseReferenceThroughObservedStart(
        data?.referenceSeries?.points ?? [],
        coverage?.actualFrom ?? null,
        points[0]?.value ?? null,
      )
    : [];
  const hasReferenceSeries = referencePoints.length > 1;
  const displayTitle = isBacktest ? 'Current holdings backtest' : title;
  const coverageStart = coverage?.actualFrom ?? data?.from ?? null;
  const coverageReasons = data && coverage && !coverage.complete
    ? isLedgerEstimate && coverage.actualFrom
      ? [`Recorded history starts ${formatDateLabel(coverage.actualFrom)}; the requested ${range} range begins ${formatDateLabel(coverage.requestedFrom)}.`]
      : coverage.actualFrom && coverage.actualTo
      ? [
          `Requested ${formatDateLabel(coverage.requestedFrom)} to ${formatDateLabel(coverage.requestedTo)}; observed values cover ${formatDateLabel(coverage.actualFrom)} to ${formatDateLabel(coverage.actualTo)} (${coverage.percent.toFixed(1)}%).`,
          hasReferenceSeries
            ? 'The dashed current-holdings backtest is rebased at tracking start for visual continuity only; it is not joined to observed values or returns.'
            : 'No backtest values are joined to the observed series.',
        ]
      : [
          `No observed snapshots are available for the requested ${formatDateLabel(coverage.requestedFrom)} to ${formatDateLabel(coverage.requestedTo)} range.`,
          'No backtest values are substituted for missing observations.',
        ]
    : [];
  const detailReasons = [
    ...coverageReasons,
    ...(data?.approximationReasons ?? []),
    ...(hasUnreliableHistory && latestSegment[0]
      ? [isLedgerEstimate
        ? `The period change starts at ${formatHoverLabel(latestSegment[0].t, range)}; points valued with approximate cash before that remain visible but are not measured from.`
        : `Verified return calculations resume at ${formatHoverLabel(latestSegment[0].t, range)}; captured points before that boundary remain visible but do not affect returns.`]
      : []),
    ...(displaySeries.removed > 0
      ? [`display filtered ${displaySeries.removed} leading partial snapshot${displaySeries.removed === 1 ? '' : 's'}`]
      : []),
    ...(hasReferenceSeries
      ? (data?.referenceSeries?.approximationReasons ?? []).map((reason) => `Backtest reference: ${reason}`)
      : []),
  ];
  const showDetails = Boolean(data && (data.approximate || (coverage != null && !coverage.complete) || detailReasons.length > 0));
  const detailsLabel = hasUnreliableHistory && !isLedgerEstimate
    ? 'Snapshot reliability details'
    : hasPartialObservedCoverage
    ? 'Coverage details'
    : isMarketComputed
      ? 'How this line is computed'
      : data?.valueMethod === 'observed_snapshot'
      ? 'Data quality details'
      : 'Approximation details';

  // Headline value: hovered point's value during hover, else the last
  // point's value (live), else 0.
  // Headline source-of-truth precedence:
  //   1. User is hovering a chart point -> show that point's value.
  //   2. Caller passed a live value (current positions + cash via the
  //      shared math layer) -> show it. Avoids "chart says $1.08M but
  //      Combined holdings says $1.17M" (the chart's last point can be
  //      a yesterday-EOD reconstruction).
  //   3. Last historical point as a fallback.
  const headlineValue =
    hoveredPoint?.value ?? liveValue ?? points[points.length - 1]?.value ?? 0;
  const hoverDelta = hoveredPoint && !hoveredPoint.unreliable && hoverBaseline
    ? hoveredPoint.value - hoverBaseline.value
    : null;
  const hoverPercent = hoveredPoint && !hoveredPoint.unreliable && hoverBaseline && hoverBaseline.value !== 0
    ? ((hoveredPoint.value - hoverBaseline.value) / hoverBaseline.value) * 100
    : null;

  const periodHigh = latestSegment.length > 0
    ? Math.max(...latestSegment.map((point) => point.value))
    : 0;
  const periodLow = latestSegment.length > 0
    ? Math.min(...latestSegment.map((point) => point.value))
    : 0;

  const showCrosshair = hoveredPoint != null && hoverDelta != null && (hoverPercent != null || isLedgerEstimate);
  // A ledger value change includes deposits and accounts joining, so a
  // percentage over a near-empty starting value (5Y/ALL begin before most
  // accounts are documented) is noise; show the dollar change alone then.
  const meaningfulPercent = (base: number, percent: number | null) => percent != null
    && (!isLedgerEstimate || (base > 0 && Math.abs(percent) <= 1000));
  const showHoverPercent = meaningfulPercent(hoverBaseline?.value ?? 0, hoverPercent);
  const showPeriodPercent = meaningfulPercent(displaySummary.startValue, displaySummary.changePercent);
  // The changes as the header shows them: one that reads zero is unsigned and in neither colour, with no arrow. The
  // value line takes the period change's tone, so a flat period draws in neither colour and the line and its header
  // always agree.
  const signedChange = { signedAmount: true, signedPercent: true };
  const hoverShown = formatGainLoss(hoverDelta, showHoverPercent ? hoverPercent : null, signedChange);
  const periodShown = formatGainLoss(displaySummary.change, showPeriodPercent ? displaySummary.changePercent : null, signedChange);
  const verifiedShown = formatGainLoss(displaySummary.change, displaySummary.changePercent, signedChange);

  const returnMode = mode === 'return';
  const returnSeries = data?.valueMethod === 'ledger_estimate' ? data.returns ?? null : null;
  const returnPoints = returnSeries?.points ?? [];
  const hoveredReturn = returnMode && hoveredIndex != null ? returnPoints[hoveredIndex] ?? null : null;
  const returnLineTone = timeWeightedShown(returnSeries).tone;
  const returnPercents = returnPoints.map((point) => point.cumulative * 100);
  const returnHigh = returnPercents.length > 0 ? Math.max(...returnPercents) : 0;
  const returnLow = returnPercents.length > 0 ? Math.min(...returnPercents) : 0;
  const returnDetails = returnSeries
    ? [
        `Over this range: investment gain ${formatSignedCurrency(returnSeries.summary.gain)}, money added (net) ${formatSignedCurrency(returnSeries.summary.netFlows)}.`,
        ...(returnSeries.summary.moneyWeighted != null
          ? ['the headline is money-weighted: the one rate that grows the starting value and each deposit or withdrawal into today\'s value (an IRR, like XIRR); the line is time-weighted, which leaves out deposit timing and is the one to compare with QQQ or SPY']
          : []),
        ...returnSeries.notes,
        'daily values are the same estimates as the Value view; its notes list how they are valued',
      ]
    : [];
  const headerTitle = returnMode ? returnTitle ?? `${title} · Return` : displayTitle;
  const selectMode = (next: ChartMode) => {
    setMode(next);
    setHoveredIndex(null);
    setApproxOpen(false);
    if (next === 'return' && !RETURN_RANGES.includes(range)) setRange('ALL');
  };
  const visibleRanges = returnMode ? RETURN_RANGES : RANGES;
  const detailsVisible = returnMode ? returnDetails.length > 0 : showDetails;
  const detailsTitle = returnMode
    ? 'How return is calculated'
    : hasUnreliableHistory && !isLedgerEstimate
      ? 'Snapshot reliability'
      : hasPartialObservedCoverage
        ? 'Observed history coverage'
        : isMarketComputed
          ? 'How this line is computed'
          : data?.valueMethod === 'observed_snapshot'
          ? 'Observed data notes'
          : 'Approximations applied';
  const detailItems = returnMode ? returnDetails : detailReasons;

  return (
    <section className="portfolio-chart">
      <div className="portfolio-chart-header">
        <div>
          <div className="muted portfolio-chart-title">{headerTitle}</div>
          {returnMode ? (
            <ReturnHeadline series={returnSeries} hovered={hoveredReturn} range={range} from={data?.from ?? null} />
          ) : null}
          {returnMode ? null : valueUnavailable ? (
            <>
              <div className="portfolio-chart-value muted">—</div>
              {valueUnavailableReason ? (
                <div className="muted portfolio-chart-unavailable">
                  {valueUnavailableReason}
                </div>
              ) : null}
            </>
          ) : points.length > 0 || (liveValue ?? 0) > 0 ? (
            <RollingNumber
              className="portfolio-chart-value"
              value={headlineValue}
              format={(v) => formatCurrency(v)}
              freeze={hoveredPoint != null}
              flash
            />
          ) : (
            <div className="portfolio-chart-value muted">—</div>
          )}
          {returnMode || valueUnavailable ? null : showCrosshair ? (
            <div className={withTone('portfolio-chart-change', hoverShown.tone)}>
              <Trend value={toneArrow(hoverShown.tone)} />
              {hoverShown.amount}
              {showHoverPercent ? ` (${hoverShown.percent})` : ''}
              <span className="muted">
                {hasPartialObservedCoverage && hoverBaseline
                  ? ` · since ${formatDateLabel(hoverBaseline.t)} · `
                  : ' · '}
                {formatHoverLabel(hoveredPoint!.t, range)}
                {hoveredPoint!.cashCorrection ? ' · includes a cash correction to the broker\'s balance, not a market move' : ''}
                {hoveredPoint!.estimated ? ' · estimated: some prices are over 30 minutes old' : ''}
              </span>
            </div>
          ) : hoveredPoint?.unreliable ? (
            <div className="portfolio-chart-coverage muted">
              {isLedgerEstimate ? 'Approximate cash' : 'Captured before broker sync'} · {formatHoverLabel(hoveredPoint.t, range)} · excluded from returns
            </div>
          ) : hasNoObservedCoverage ? (
            <div className="portfolio-chart-coverage muted">
              No observed snapshots in requested {range}
            </div>
          ) : hasUnreliableHistory ? (
            <div className="portfolio-chart-coverage portfolio-chart-reliability muted">
              {latestSegment.length > 1
                ? `Verified ${verifiedShown.amount} (${verifiedShown.percent}) · since ${formatHoverLabel(latestSegment[0].t, range)}`
                : isLedgerEstimate ? 'Approximate cash · change N/A' : 'Captured values · return N/A'}
            </div>
          ) : hasPartialObservedCoverage ? (
            <div className="portfolio-chart-coverage muted">
              <span>
                {range === '1D'
                  ? `Observed from ${formatHoverLabel(coverageStart!, range)} · ${coverage!.percent.toFixed(1)}% of latest session`
                  : `Observed since ${formatDateLabel(coverageStart!)} · ${coverage!.percent.toFixed(1)}% of requested ${range}`}
              </span>
              {hasReferenceSeries ? (
                <span className="portfolio-chart-series-legend" aria-label="Chart series">
                  <span><i className="series-swatch observed" />Observed</span>
                  <span><i className="series-swatch backtest" />Backtest reference</span>
                </span>
              ) : null}
            </div>
          ) : data && points.length > 0 ? (
            <div className={withTone('portfolio-chart-change', periodShown.tone)}>
              <Trend value={toneArrow(periodShown.tone)} />
              {isBacktest ? 'Backtest ' : isLedgerEstimate ? 'Value change ' : ''}
              {periodShown.amount}{' '}
              {showPeriodPercent ? periodShown.percent : null}
              <span className="muted"> · vs {formatRangeStartLabel(data.from, range)} · {range}</span>
            </div>
          ) : null}
          {headerExtra ? <div className="portfolio-chart-extra">{headerExtra}</div> : null}
        </div>
        <div className="portfolio-chart-meta">
          <div className="segmented chart-mode-toggle" role="group" aria-label="Chart view">
            {(['value', 'return'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={`seg ${mode === option ? 'on' : ''}`}
                aria-pressed={mode === option}
                onClick={() => selectMode(option)}
              >
                {option === 'value' ? 'Value' : 'Return'}
              </button>
            ))}
          </div>
          {detailsVisible ? (
            <div className="approx-wrap">
              <button
                type="button"
                className="badge approx"
                aria-expanded={approxOpen}
                aria-controls="approx-popover"
                onClick={() => setApproxOpen((v) => !v)}
                title={returnMode
                  ? `How return is calculated — ${detailItems.length} notes. Click for details.`
                  : `${hasUnreliableHistory ? 'Snapshot reliability' : hasPartialObservedCoverage ? 'Partial history coverage' : isMarketComputed ? 'How this line is computed' : data?.valueMethod === 'observed_snapshot' ? 'Observed data notes' : 'Approximate history'} — ${detailReasons.length} note${detailReasons.length === 1 ? '' : 's'}. Click for details.`}
                aria-label={returnMode ? 'Return calculation details' : detailsLabel}
              >
                <Info size={12} />
              </button>
              {approxOpen ? (
                <div id="approx-popover" className="approx-popover" role="dialog" aria-label="Approximations">
                  <div className="approx-popover-title">{detailsTitle}</div>
                  <ul>
                    {detailItems.map((reason, i) => (
                      <li key={i}>{reason}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : !returnMode && data?.source === 'snapshots' ? (
            <span className="badge live">Live</span>
          ) : null}
        </div>
      </div>

      {/* Round 3 (3.B2): the chart canvas wraps the SVG, the range
          segmented control (top-right), and the period high/low corner
          labels. position:relative so absolute children anchor to the
          card edges. The previous layout put the range pills in their
          own row below the chart — eight buttons full-width on desktop
          dwarfed the data they controlled. */}
      <div className="portfolio-chart-canvas">
        {loading && !data ? (
          <div className="symbol-chart-loading" aria-label="Loading chart" />
        ) : error ? (
          <div className="symbol-chart-empty" title={error}>
            Chart unavailable while the server is offline.
          </div>
        ) : data && !data.supported ? (
          <div className="symbol-chart-empty">
            {data.reason ?? 'Portfolio history is not available for this range.'}
          </div>
        ) : returnMode && data && returnPoints.length < 2 ? (
          <div className="symbol-chart-empty">
            {returnSeries
              ? 'Not enough history for a return yet.'
              : 'Return needs recorded transactions, which this view does not have.'}
          </div>
        ) : returnMode && data ? (
          <InteractiveChart
            points={returnPoints.map((point) => ({ t: point.t, value: point.cumulative * 100 }))}
            tone={returnLineTone}
            hoveredIndex={hoveredIndex}
            onHoverChange={setHoveredIndex}
            ariaLabel={`${headerTitle} chart`}
            tradeMarkers={transactions}
            accountIdToName={accountIdToName}
            adaptiveSampling
            topReserve={0}
          />
        ) : data && points.length > 1 ? (
          <InteractiveChart
            points={points.map((point) => ({
              t: point.t,
              value: point.value,
              ...(point.unreliable ? { unreliable: true } : {}),
              ...(point.gapBefore ? { gapBefore: true } : {}),
            }))}
            tone={periodShown.tone}
            hoveredIndex={hoveredIndex}
            onHoverChange={setHoveredIndex}
            ariaLabel={`${title} value chart${hasUnreliableHistory ? ', with captured snapshots excluded from return calculations' : ''}${hasReferenceSeries ? ', with dashed current holdings backtest before observed tracking' : ''}`}
            tradeMarkers={transactions}
            accountIdToName={accountIdToName}
            domainFrom={useRequestedDomain ? coverage!.requestedFrom : sessionWindow?.from}
            domainTo={useRequestedDomain ? coverage!.requestedTo : sessionWindow?.to}
            showUnobservedRegion={showUnobservedPrefix}
            adaptiveSampling
            referencePoints={referencePoints.map((point) => ({ t: point.t, value: point.value }))}
            formatReferencePoint={(point) => ({
              primary: formatCurrency(point.value),
              secondary: `${formatHoverLabel(point.t, range)} · Backtest reference`,
            })}
            // Round 5: glass over data, not glass blocking data. The
            // floating range pill is now real liquid glass (high blur
            // + saturate). The chart line is allowed to climb behind
            // the capsule and refract through it — that is the iOS 26
            // "data lives behind the chrome" effect. Reserving canvas
            // space at the top would defeat the whole point.
            topReserve={0}
          />
        ) : data && points.length === 1 ? (
          <div className="symbol-chart-empty">
            One observed snapshot is available. Keep tracking to build a trend.
          </div>
        ) : (
          <div className="symbol-chart-empty">
            {range === '1D'
              ? 'No 1D snapshots yet. Set SNAPSHOTS_ENABLED=1 in dev to start collecting.'
              : 'No data in the selected range.'}
          </div>
        )}

        {/* Period high / low corner labels. Robinhood / Public both
            show these as faint chips so the line has gain magnitude
            context, not just gain feel. Hidden on the hover crosshair
            since the scrubber tooltip is the primary readout then. */}
        {returnMode ? (
          returnPercents.length > 1 && hoveredReturn == null ? (
            <>
              <div className="chart-extreme chart-extreme-high">
                <span className="chart-extreme-label">High</span>
                <span className="chart-extreme-value">{formatPercent(returnHigh)}</span>
              </div>
              <div className="chart-extreme chart-extreme-low">
                <span className="chart-extreme-label">Low</span>
                <span className="chart-extreme-value">{formatPercent(returnLow)}</span>
              </div>
            </>
          ) : null
        ) : data && latestSegment.length > 1 && !showCrosshair && !hasPartialObservedCoverage && !hasUnreliableHistory ? (
          <>
            <div className="chart-extreme chart-extreme-high">
              <span className="chart-extreme-label">High</span>
              <span className="chart-extreme-value">{formatCurrency(periodHigh)}</span>
            </div>
            <div className="chart-extreme chart-extreme-low">
              <span className="chart-extreme-label">Low</span>
              <span className="chart-extreme-value">{formatCurrency(periodLow)}</span>
            </div>
          </>
        ) : null}

        {/* Range segmented control floats top-right inside the chart
            canvas, mirroring Public / Wealthfront / Robinhood web. */}
        <div className="segmented symbol-chart-ranges chart-floating-ranges" role="group" aria-label="Time range">
          {visibleRanges.map((r) => (
            <button
              key={r}
              type="button"
              className={`seg ${range === r ? 'on' : ''}`}
              aria-pressed={range === r}
              onClick={() => setRange(r)}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* Sprint 1: approximation reasons live exclusively in the (i)
          popover above so the chart card stays tight. */}
      {data?.trackingSince && range === '1D' ? (
        <div className="muted symbol-chart-footnote">
          Tracking since {new Date(data.trackingSince).toLocaleString()}
        </div>
      ) : null}
      {returnMode && showPerformance ? <PerformancePanel accountIds={accountIds} showGoal={accountsKey === ''} /> : null}
    </section>
  );
}

function ReturnHeadline({ series, hovered, range, from }: {
  series: PortfolioReturnSeries | null;
  hovered: PortfolioReturnSeries['points'][number] | null;
  range: Range;
  from: string | null;
}) {
  if (!series || series.points.length < 2 || !from) {
    return <div className="portfolio-chart-value muted">—</div>;
  }
  const { summary } = series;
  const moneyWeighted = summary.moneyWeighted ?? null;
  const moneyWeightedAnnualized = summary.moneyWeightedAnnualized ?? null;
  // At rest the headline is what the money earned (money-weighted); the line,
  // and any day picked on it, read the time-weighted return.
  const showMoneyWeighted = hovered == null && moneyWeighted != null;
  const perYear = showMoneyWeighted && moneyWeightedAnnualized != null;
  const headline = hovered
    ? hovered.cumulative
    : showMoneyWeighted
      ? moneyWeightedAnnualized ?? moneyWeighted ?? 0
      : summary.cumulative;
  const gain = hovered?.gain ?? summary.gain;
  const annualized = hovered || moneyWeighted != null ? null : summary.annualized;
  // Each figure as shown: one that reads zero is unsigned, and the gain line is in neither colour, with no arrow.
  const gainShown = formatShownAmount(gain, { signed: true });
  return (
    <>
      <div className="portfolio-chart-value-row">
        <RollingNumber
          className="portfolio-chart-value"
          value={headline * 100}
          format={(v) => formatShownPercent(v, { signed: true }).text}
          freeze={hovered != null}
          flash
        />
        {perYear ? <span className="portfolio-chart-value-unit">/yr</span> : null}
      </div>
      <div className={withTone('portfolio-chart-change', gainShown.tone)}>
        <Trend value={toneArrow(gainShown.tone)} />
        {gainShown.text} gain
        {annualized != null ? ` · ${formatShownPercent(annualized * 100, { signed: true }).text}/yr` : ''}
        <span className="muted">
          {hovered
            ? ` · time-weighted · ${formatHoverLabel(hovered.t, range)}`
            : ` · ${showMoneyWeighted ? 'money-weighted' : 'time-weighted'} · vs ${formatRangeStartLabel(from, range)} · ${range}`}
        </span>
      </div>
      {moneyWeighted != null ? (
        <div className="portfolio-chart-line-return muted">
          Line: time-weighted {timeWeightedShown(series).text}
          {summary.annualized != null ? ` · ${formatShownPercent(summary.annualized * 100, { signed: true }).text}/yr` : ''}
        </div>
      ) : null}
    </>
  );
}

function formatSignedCurrency(value: number): string {
  return formatShownAmount(value, { signed: true }).text;
}

/**
 * The time-weighted return the return line plots, as its header shows it (the headline at rest, or "Line: time-weighted"
 * beside a money-weighted headline). The line takes its tone, so a flat return draws in neither colour.
 */
function timeWeightedShown(series: PortfolioReturnSeries | null) {
  return formatShownPercent(series ? series.summary.cumulative * 100 : null, { signed: true });
}

function rebaseReferenceThroughObservedStart(
  points: PortfolioPoint[],
  actualFrom: string | null,
  observedStartValue: number | null,
): PortfolioPoint[] {
  if (!actualFrom || observedStartValue == null || points.length < 2) return [];
  const boundaryMs = pointTimestamp(actualFrom);
  if (!Number.isFinite(boundaryMs)) return [];
  const before = points.filter((point) => pointTimestamp(point.t) < boundaryMs);
  const left = before.at(-1);
  const right = points.find((point) => pointTimestamp(point.t) >= boundaryMs);
  if (!left || !right) return [];
  const leftMs = pointTimestamp(left.t);
  const rightMs = pointTimestamp(right.t);
  const ratio = rightMs > leftMs ? (boundaryMs - leftMs) / (rightMs - leftMs) : 0;
  const referenceAtBoundary = left.value + (right.value - left.value) * ratio;
  if (!Number.isFinite(referenceAtBoundary) || referenceAtBoundary === 0) return [];
  const scale = observedStartValue / referenceAtBoundary;
  const rebased = before.map((point) => ({
    ...point,
    value: point.value * scale,
    costBasis: point.costBasis * scale,
  }));
  return [
    ...rebased,
    {
      t: actualFrom,
      value: observedStartValue,
      costBasis: left.costBasis * scale,
    },
  ];
}

function pointTimestamp(value: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value);
}

function trimLeadingPartialDisplayPoints(
  points: PortfolioPoint[],
  range: Range,
): { points: PortfolioPoint[]; removed: number } {
  if (range !== '1D' || points.length < 20) return { points, removed: 0 };
  const scanLimit = Math.min(points.length - 1, 200);
  for (let index = 1; index <= scanLimit; index++) {
    const previous = points[index - 1];
    const current = points[index];
    if (!Number.isFinite(previous.value) || !Number.isFinite(current.value) || previous.value <= 0) continue;
    if ((current.value - previous.value) / previous.value < 0.25) continue;
    const next = points.slice(index, Math.min(points.length, index + 12));
    if (next.length < 4) continue;
    const nextValueMedian = medianPointValues(next.map((point) => point.value));
    if (previous.value >= nextValueMedian * 0.8) continue;
    const priorPnl = previous.value - previous.costBasis;
    const cashOnlyProxy = Math.abs(priorPnl) <= Math.max(1, Math.abs(previous.value) * 0.0001);
    const nextPnlMedian = medianPointValues(next.map((point) => point.value - point.costBasis));
    const pnlRecovery = Math.abs(nextPnlMedian - priorPnl)
      > Math.max(500, Math.abs(nextValueMedian) * 0.01);
    if (cashOnlyProxy && pnlRecovery) return { points: points.slice(index), removed: index };
  }
  return { points, removed: 0 };
}

function medianPointValues(values: number[]): number {
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function summarizePortfolioPoints(points: PortfolioPoint[]): Omit<PortfolioHistoryResponse['summary'], 'changePercent'> & { changePercent: number | null } {
  if (points.length === 0) return { startValue: 0, endValue: 0, change: 0, changePercent: 0 };
  const startValue = points[0].value;
  const endValue = points[points.length - 1].value;
  const change = endValue - startValue;
  return {
    startValue,
    endValue,
    change,
    // A change from a zero start has no percent: unknown, so it reads "—", never 0.00%.
    changePercent: startValue !== 0 ? (change / startValue) * 100 : null,
  };
}

function findReliableSegmentStart(points: PortfolioPoint[], index: number): number {
  if (points.length === 0 || points[index]?.unreliable) return -1;
  const boundedIndex = Math.min(Math.max(0, index), Math.max(0, points.length - 1));
  for (let current = boundedIndex; current > 0; current--) {
    if (points[current - 1].unreliable) return current;
  }
  return 0;
}

function latestReliableSegment(points: PortfolioPoint[]): PortfolioPoint[] {
  let end = points.length;
  while (end > 0 && points[end - 1].unreliable) end--;
  if (end === 0) return [];
  const start = findReliableSegmentStart(points, end - 1);
  return start >= 0 ? points.slice(start, end) : [];
}

function marketCalendarDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return year && month && day ? `${year}-${month}-${day}` : value.slice(0, 10);
}

/**
 * Short label for the start of the active range. 'Apr 9' for current-year
 * dates, 'Apr 9, 2025' for older ranges. Used in 'vs Apr 9 · 1M'.
 */
function formatRangeStartLabel(from: string, range: Range): string {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(from);
  const d = dateOnly ? new Date(`${from}T12:00:00Z`) : new Date(from);
  if (Number.isNaN(d.getTime())) return from;
  const now = new Date();
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (range === '1Y' || range === '5Y' || range === 'ALL' || d.getFullYear() !== now.getFullYear()) {
    opts.year = 'numeric';
  }
  return d.toLocaleDateString(undefined, opts);
}

function formatDateLabel(value: string): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T12:00:00Z`)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatHoverLabel(t: string, range: Range): string {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(t);
  const d = dateOnly ? new Date(`${t}T12:00:00Z`) : new Date(t);
  if (Number.isNaN(d.getTime())) return t;
  if (dateOnly || range !== '1D') {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
