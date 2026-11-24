import { useEffect, useMemo, useState } from 'react';
import {
  dayChangeDisplayLabel,
  formatCurrency,
  formatGainLoss,
  formatShownPercent,
  type Transaction,
  type QuoteChangeBasis,
  type QuoteFreshness,
  type QuoteSession,
} from '@finance-tracker/shared';

import { getCachedSymbolHistory } from '../services/symbolHistoryCache';
import { RollingNumber } from './RollingNumber';
import { InteractiveChart } from './InteractiveChart';
import { toneClass, withTone } from './tone';

const RANGES = ['1D', '1W', '1M', '3M', 'YTD', '1Y', '5Y', 'ALL'] as const;
type Range = (typeof RANGES)[number];

interface Point {
  t: string;
  close: number;
  open?: number;
  high?: number;
  low?: number;
}

interface HistoryResponse {
  symbol: string;
  range: Range;
  from: string;
  to: string;
  supported: boolean;
  reason?: string;
  points: Point[];
  summary: { first: number; last: number; change: number; changePercent: number };
  sources: string[];
  /** Most recent fetched_at among the bars (ISO 8601). Used for the
   *  "Last refreshed Xm ago" footnote. */
  lastRefreshedAt?: string;
}

interface Props {
  symbol: string;
  currentPrice?: number | null;
  /** Live-quote day change. Honored only when basis is brokerage-grade. */
  dayChange?: number;
  dayChangePercent?: number;
  /** Discriminator for the day-change baseline (passed through from the row). */
  changeBasis?: QuoteChangeBasis;
  freshness?: QuoteFreshness;
  /** Active US session at quote time — drives Today/Pre-market/After-hours. */
  session?: QuoteSession;
  currency?: string;
  transactions?: Transaction[];
  accountIdToName?: Map<string, string>;
}

/**
 * Robinhood-style price chart for a single ticker.
 *
 * Data: GET /symbols/:symbol/history?range=...
 * Chart: hand-rolled SVG line; no external chart library.
 *
 * Headline change semantics (reviewer 5 fix):
 *   - "Today" label only when freshness ∈ {live, delayed} AND
 *     changeBasis === 'previousClose'. Crypto 24h change gets a "24h"
 *     label; stale/eod/provider-only changes are hidden.
 *
 * Crosshair (D.1):
 *   - Mouse / touch over the chart snaps to the nearest data point and
 *     replaces the headline price + change with the hovered point's
 *     value vs the range start. Pointer leave restores the live values.
 *   - Keyboard: ←/→ move the crosshair; Esc clears.
 *   - Reduced motion: line/puck have no transition; CSS handles it.
 */
export function SymbolChart({
  symbol,
  currentPrice,
  dayChange,
  dayChangePercent,
  changeBasis,
  freshness,
  session,
  currency = 'USD',
  transactions = [],
  accountIdToName,
}: Props) {
  // Match the compact holdings sparkline range so expanding a row keeps
  // the same visual reference frame the user just inspected.
  const [range, setRange] = useState<Range>('3M');
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  // Headline label for the day-change line. Session-aware: "Today" during
  // regular hours, "Pre-market" / "After hours" during extended sessions,
  // "24h" for crypto, "Recent" for provider-only baselines, null when the
  // change shouldn't be shown at all.
  const dayLabel = dayChangeDisplayLabel({ changeBasis, freshness, session });

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    setHoveredIndex(null);              // clear crosshair when range/symbol changes
    getCachedSymbolHistory<HistoryResponse>(symbol, range)
      .then((res) => {
        if (cancelled) return;
        setData(res);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load history');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [symbol, range]);

  // Hover-aware headline derivations. When the user is hovering, the headline
  // shows the point under the crosshair; otherwise it shows the live values.
  const points = data?.points;
  const hoveredPoint = hoveredIndex != null && points ? points[hoveredIndex] : null;
  const headlinePrice = hoveredPoint?.close ?? currentPrice ?? null;
  const hoverDelta = hoveredPoint && points && points.length > 0
    ? hoveredPoint.close - points[0].close
    : null;
  const hoverPercent = hoveredPoint && points && points.length > 0 && points[0].close !== 0
    ? ((hoveredPoint.close - points[0].close) / points[0].close) * 100
    : null;
  const hoverLabel = hoveredPoint ? formatHoverLabel(hoveredPoint.t, range) : null;
  // The changes as the header shows them: one that reads zero is unsigned and in neither colour. The line takes the
  // period change's tone, so a flat period draws in neither colour and the line and its header always agree.
  const signedChange = { currency, signedAmount: true, signedPercent: true };
  const hoverShown = formatGainLoss(hoverDelta, hoverPercent, signedChange);
  const dayShown = formatGainLoss(dayChange, dayChangePercent, signedChange);
  const periodShown = formatGainLoss(data?.summary.change, data?.summary.changePercent, signedChange);
  const chartTrades = useMemo(() => {
    if (!data?.supported || data.points.length === 0) return [];
    const from = data.from.slice(0, 10);
    const to = data.to.slice(0, 10);
    return transactions.filter((t) => t.symbol === symbol && t.date >= from && t.date <= to);
  }, [data, transactions, symbol]);
  const tradeQuality = useMemo(() => summarizeTradeQuality(transactions.filter((t) => t.symbol === symbol), currentPrice ?? data?.summary.last ?? null), [transactions, symbol, currentPrice, data?.summary.last]);
  const vsAvgBuyShown = formatShownPercent(tradeQuality?.currentVsAvgBuy, { signed: true, digits: 1 });

  return (
    <div className="symbol-chart">
      <div className="symbol-chart-header">
        <div>
          <div className="symbol-chart-title">{symbol}</div>
          {headlinePrice != null ? (
            <RollingNumber
              className="symbol-chart-price"
              value={headlinePrice}
              format={(v) => formatCurrency(v, currency)}
              // Freeze the odometer while the user is dragging the crosshair
              // — otherwise every snap to a new point would re-trigger a roll
              // and turn flicks into visual noise. Per the plan self-review #1.
              freeze={hoveredPoint != null}
              flash
            />
          ) : null}
          {hoveredPoint && hoverDelta != null && hoverPercent != null ? (
            <div className={withTone('symbol-chart-change', hoverShown.tone)}>
              {hoverShown.amount} ({hoverShown.percent}) {hoverLabel}
            </div>
          ) : dayLabel && dayChange !== undefined && dayChangePercent !== undefined ? (
            <div className={withTone('symbol-chart-change', dayShown.tone)}>
              {dayShown.amount} ({dayShown.percent}) {dayLabel}
            </div>
          ) : null}
        </div>
        <div className="symbol-chart-period">
          {data && data.supported && !hoveredPoint ? (
            <span className={toneClass(periodShown.tone) || undefined}>
              {periodShown.amount} ({periodShown.percent}) past {range}
            </span>
          ) : null}
        </div>
      </div>

      {loading ? (
        <div className="symbol-chart-loading">Loading…</div>
      ) : error ? (
        <div className="error">{error}</div>
      ) : data && !data.supported ? (
        <div className="symbol-chart-empty">
          {data.reason ?? `No price history available for ${symbol}.`}
        </div>
      ) : data && data.points.length > 0 ? (
        <InteractiveChart
          points={data.points.map((p) => ({ t: p.t, value: p.close }))}
          tone={periodShown.tone}
          hoveredIndex={hoveredIndex}
          onHoverChange={setHoveredIndex}
          ariaLabel={`${symbol} price chart`}
          tradeMarkers={chartTrades}
          accountIdToName={accountIdToName}
        />
      ) : null}

      <div className="symbol-chart-ranges">
        {RANGES.map((r) => (
          <button
            key={r}
            type="button"
            className={`tab small ${range === r ? 'active' : ''}`}
            onClick={() => setRange(r)}
          >
            {r}
          </button>
        ))}
      </div>

      {tradeQuality ? (
        <div className="trade-quality-strip" aria-label={`${symbol} trade quality summary`}>
          <div>
            <span>Avg buy</span>
            <strong>{formatCurrency(tradeQuality.avgBuy, currency)}</strong>
          </div>
          <div>
            <span>Vs avg buy</span>
            <strong className={toneClass(vsAvgBuyShown.tone) || undefined}>
              {vsAvgBuyShown.text}
            </strong>
          </div>
          {tradeQuality.avgSell != null ? (
            <div>
              <span>Avg sell</span>
              <strong>{formatCurrency(tradeQuality.avgSell, currency)}</strong>
            </div>
          ) : null}
          <div>
            <span>Best buy</span>
            <strong>{formatCurrency(tradeQuality.bestBuy, currency)}</strong>
          </div>
          <div>
            <span>Worst buy</span>
            <strong>{formatCurrency(tradeQuality.worstBuy, currency)}</strong>
          </div>
        </div>
      ) : null}

      {data && data.supported ? (
        <div className="muted symbol-chart-footnote">
          {data.points.length} bars from {data.sources.join(', ')} · {data.from} → {data.to}
          {data.lastRefreshedAt ? ` · refreshed ${formatRelativeTime(data.lastRefreshedAt)}` : null}
        </div>
      ) : null}
    </div>
  );
}

function summarizeTradeQuality(transactions: Transaction[], currentPrice: number | null) {
  const buys = transactions.filter((t) => t.quantity > 0);
  if (buys.length === 0 || currentPrice == null || currentPrice <= 0) return null;
  const buyShares = buys.reduce((s, t) => s + t.quantity, 0);
  const buyCost = buys.reduce((s, t) => s + t.quantity * t.pricePerUnit, 0);
  const avgBuy = buyCost / buyShares;
  const sells = transactions.filter((t) => t.quantity < 0);
  const sellShares = sells.reduce((s, t) => s + Math.abs(t.quantity), 0);
  const sellProceeds = sells.reduce((s, t) => s + Math.abs(t.quantity) * t.pricePerUnit, 0);
  return {
    avgBuy,
    avgSell: sellShares > 0 ? sellProceeds / sellShares : null,
    // Against an average buy of $0 (shares that cost nothing) there is no percent: unknown, so it reads "—", never 0%.
    currentVsAvgBuy: avgBuy > 0 ? ((currentPrice - avgBuy) / avgBuy) * 100 : null,
    bestBuy: Math.min(...buys.map((t) => t.pricePerUnit)),
    worstBuy: Math.max(...buys.map((t) => t.pricePerUnit)),
  };
}

/** Format an ISO timestamp as "just now" / "Xm ago" / "Xh ago" / "Xd ago".
 *  Used in chart footers so the user can tell when the underlying bars
 *  were last fetched (rolling 7-day refresh window means recent bars get
 *  re-pulled but older history stays put). */
function formatRelativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Format a point's `t` for the headline subtitle when hovering. Daily
 * bars get `"Apr 21, 2026"`; intraday bars get `"10:35 AM"` plus the date
 * abbreviated. The range hints at whether the source is intraday.
 */
function formatHoverLabel(t: string, range: Range): string {
  // Daily bars are stored as YYYY-MM-DD. Add a noon UTC anchor so the local
  // formatter doesn't slide them across the international date line.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(t);
  const d = dateOnly ? new Date(`${t}T12:00:00Z`) : new Date(t);
  if (Number.isNaN(d.getTime())) return t;
  if (dateOnly || range !== '1D') {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  // Intraday: "10:35 AM" — concise; full date is implied by 1D range.
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
