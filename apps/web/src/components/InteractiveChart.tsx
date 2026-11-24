import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { monotoneBezierSegments, sampleTimeSeries, type GainLossTone, type Transaction } from '@finance-tracker/shared';

import { TradeTooltip } from './TradeTooltip';

/**
 * Hand-rolled SVG line chart with crosshair / hover readout.
 *
 * Originally lived inside `SymbolChart`; extracted in B.2 so the portfolio
 * chart (`PortfolioHistoryChart`) can reuse the same interaction model
 * without duplicating ~150 LOC of crosshair code.
 *
 * Contract:
 *   - `points` is an array of `{ x, y }`-style data with a `value` we plot
 *     as the y-axis. Caller decides how to map points → labels (date,
 *     time, etc.) since portfolio and symbol charts label hover differently.
 *   - `hoveredIndex` is owned by the parent so the chart's headline can
 *     reflect the hovered point. Pass `null` for "live" mode.
 *   - `tone` decides the line colour: gain or loss, or neither for a change that shows as zero (a flat period). The
 *     caller passes its header change's tone, from the same formatted result, so the line and its header agree.
 *
 * Accessibility:
 *   - Tab-focusable, role="img"; ←/→ moves crosshair, Esc clears.
 *   - Reduced motion: CSS removes the puck transition.
 */

export interface ChartPoint {
  /** Display label for the x-axis position (passed back via onHoverChange). */
  t: string;
  /** Numeric value plotted on y. */
  value: number;
  /** Start a new path because observations before this point are unavailable. */
  gapBefore?: boolean;
  /** Captured before a later broker sync completed the ledger. */
  unreliable?: boolean;
}

const W = 800;
const H = 220;
const PADDING_X = 4;
const PADDING_Y = 8;
const TRADE_MARKER_GAP_PX = 40;

interface TradeTooltipOverlay {
  left: number;
  top: number;
  below: boolean;
  listMaxHeight: number;
}

export interface InteractiveChartProps {
  points: ChartPoint[];
  tone: GainLossTone;
  hoveredIndex: number | null;
  onHoverChange: (i: number | null) => void;
  /** Optional aria-label override; defaults to "Price chart". */
  ariaLabel?: string;
  /**
   * Extra space (in viewBox units, ~ CSS px) reserved at the top of the
   * chart for an absolutely-positioned overlay (e.g. floating range
   * pills + period high/low labels above the data). The line/area path
   * is squashed into the remaining vertical space so its peak never
   * collides with the overlay. Defaults to 0 (full canvas).
   */
  topReserve?: number;
  /** Optional overlay rendered above the line (caller's responsibility to
   *  position with absolute coords). */
  children?: ReactNode;
  tradeMarkers?: Transaction[];
  accountIdToName?: Map<string, string>;
  /** Optional requested time domain. Keeps partial observed history in its
   *  true horizontal position instead of stretching it across the canvas. */
  domainFrom?: string;
  domainTo?: string;
  /** Whether the requested span begins before the first observed point. */
  showUnobservedRegion?: boolean;
  /** Explicitly approximate context drawn only beneath the unobserved prefix. */
  referencePoints?: ChartPoint[];
  formatReferencePoint?: (point: ChartPoint) => { primary: string; secondary: string };
  /** Reduce dense visual paths to actual representative observations based on
   *  rendered width. Hover callbacks still use indices from the full series. */
  adaptiveSampling?: boolean;
}

export function InteractiveChart({
  points,
  tone,
  hoveredIndex,
  onHoverChange,
  ariaLabel,
  topReserve = 0,
  tradeMarkers = [],
  accountIdToName,
  domainFrom,
  domainTo,
  showUnobservedRegion = false,
  referencePoints = [],
  formatReferencePoint,
  adaptiveSampling = false,
}: InteractiveChartProps) {
  const chartRootRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const rafRef = useRef<number | null>(null);
  const [chartWidth, setChartWidth] = useState(336);
  const samplingTarget = Math.max(72, Math.min(240, Math.round(chartWidth / 3)));
  const samplingAnchors = useMemo(
    () => tradeMarkers.map((transaction) => transaction.date),
    [tradeMarkers],
  );
  const displaySeries = useMemo(
    () => adaptiveSampling
      ? sampleTimeSeries(
          points,
          samplingTarget,
          samplingAnchors,
          domainFrom && domainTo ? 'time' : 'index',
        )
      : sampleTimeSeries(points, points.length),
    [adaptiveSampling, domainFrom, domainTo, points, samplingAnchors, samplingTarget],
  );
  const displayPoints = displaySeries.points;
  const hasReliabilityGaps = points.some((point) => point.gapBefore);
  const hasUnreliablePoints = points.some((point) => point.unreliable);
  const displayRatios = useMemo(
    () => displaySeries.sourceIndices.map((index) => index / Math.max(1, points.length - 1)),
    [displaySeries.sourceIndices, points.length],
  );
  const fullResolutionXs = useMemo(
    () => buildXPositions(points, domainFrom, domainTo),
    [points, domainFrom, domainTo],
  );
  const valueRange = useMemo(
    () => measureValueRange([...points, ...referencePoints]),
    [points, referencePoints],
  );
  const path = useMemo(
    () => buildPath(
      displayPoints,
      topReserve,
      domainFrom,
      domainTo,
      valueRange,
      displayRatios,
      adaptiveSampling ? 'monotone' : 'linear',
    ),
    [adaptiveSampling, displayPoints, displayRatios, topReserve, domainFrom, domainTo, valueRange],
  );
  const referencePath = useMemo(
    () => buildPath(referencePoints, topReserve, domainFrom, domainTo, valueRange),
    [referencePoints, topReserve, domainFrom, domainTo, valueRange],
  );
  const markerModel = useMemo(
    () => buildTradeMarkers(
      points,
      tradeMarkers,
      topReserve,
      valueRange,
      fullResolutionXs,
      (TRADE_MARKER_GAP_PX / Math.max(1, chartWidth)) * W,
    ),
    [points, tradeMarkers, topReserve, valueRange, fullResolutionXs, chartWidth],
  );
  const [hoveredTradeIndex, setHoveredTradeIndex] = useState<number | null>(null);
  const [hoveredReferenceIndex, setHoveredReferenceIndex] = useState<number | null>(null);
  const [pinnedTradeIndex, setPinnedTradeIndex] = useState<number | null>(null);
  const [hoveredTradeOverlay, setHoveredTradeOverlay] = useState<TradeTooltipOverlay | null>(null);
  const chartId = useId().replace(/:/g, '');

  const handlePointer = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg || !path || points.length === 0) return;
    const rect = svg.getBoundingClientRect();
    const localX = ((clientX - rect.left) / rect.width) * W;
    if (
      referencePath
      && showUnobservedRegion
      && localX >= referencePath.xs[0]
      && localX < path.xs[0]
    ) {
      const index = nearestXIndex(referencePath.xs, localX);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        onHoverChange(null);
        setHoveredReferenceIndex(index);
        rafRef.current = null;
      });
      return;
    }
    if (localX < path.xs[0] || localX > path.xs[path.xs.length - 1]) {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      onHoverChange(null);
      setHoveredReferenceIndex(null);
      return;
    }
    const idx = nearestXIndex(fullResolutionXs, localX);
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      setHoveredReferenceIndex(null);
      onHoverChange(idx);
      rafRef.current = null;
    });
  };

  const handleKey = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (points.length === 0) return;
    const cur = hoveredIndex ?? 0;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onHoverChange(Math.max(0, cur - 1));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      onHoverChange(Math.min(points.length - 1, cur + 1));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onHoverChange(null);
    }
  };

  const showTradeTooltip = (index: number, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    // The tooltip can grow to 360px. Keep its centre at least half that
    // width from a desktop edge; on small screens its max-width shrinks to
    // the viewport, so the dynamic half-width rail remains safe.
    const horizontalRail = Math.min(188, viewportWidth / 2 - 8);
    const left = Math.max(horizontalRail, Math.min(viewportWidth - horizontalRail, centerX));
    const spaceAbove = Math.max(0, centerY - 12);
    const spaceBelow = Math.max(0, viewportHeight - centerY - 12);
    const below = spaceBelow >= 260 || spaceBelow >= spaceAbove;
    const available = below ? spaceBelow : spaceAbove;
    setHoveredTradeIndex(index);
    setHoveredTradeOverlay({
      left,
      top: centerY,
      below,
      listMaxHeight: Math.max(96, Math.min(280, available - 80)),
    });
  };

  const hideTradeTooltip = () => {
    setHoveredTradeIndex(null);
    setHoveredTradeOverlay(null);
  };

  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
  }, []);

  useEffect(() => {
    const element = chartRootRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const updateWidth = (width: number) => {
      const rounded = Math.max(1, Math.round(width));
      setChartWidth((current) => Math.abs(current - rounded) >= 2 ? rounded : current);
    };
    updateWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width != null) updateWidth(width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setPinnedTradeIndex(null);
    hideTradeTooltip();
  }, [JSON.stringify(markerModel.markers.map((marker) => [
    marker.x, marker.y, marker.transactions.map((transaction) => transaction.id),
  ]))]);

  useEffect(() => {
    if (pinnedTradeIndex == null) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !chartRootRef.current?.contains(target)
        && !tooltipRef.current?.contains(target)
      ) {
        setPinnedTradeIndex(null);
        hideTradeTooltip();
      }
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [pinnedTradeIndex]);

  if (!path) return null;
  // Sprint 2: hero chart uses the strong saturation tier (the only chart
  // line on screen). Body table cells stay muted via --gain/--loss. A flat
  // period draws in neither colour: the muted text tone.
  const stroke = tone === 'gain' ? 'var(--gain-strong)' : tone === 'loss' ? 'var(--loss-strong)' : 'var(--text-muted)';
  const gradId = `chart-area-${chartId}`;
  const referenceClipId = `chart-reference-clip-${chartId}`;

  let crosshair: { x: number; y: number } | null = null;
  if (hoveredIndex != null && hoveredIndex >= 0 && hoveredIndex < points.length) {
    const range = valueRange.max - valueRange.min || 1;
    const topPad = PADDING_Y + topReserve;
    const ySpan = H - topPad - PADDING_Y;
    crosshair = {
      x: fullResolutionXs[hoveredIndex],
      y: topPad + (1 - (points[hoveredIndex].value - valueRange.min) / range) * ySpan,
    };
  }
  let referenceCrosshair: { x: number; y: number; point: ChartPoint } | null = null;
  if (
    referencePath
    && hoveredReferenceIndex != null
    && hoveredReferenceIndex >= 0
    && hoveredReferenceIndex < referencePoints.length
  ) {
    const range = valueRange.max - valueRange.min || 1;
    const topPad = PADDING_Y + topReserve;
    const ySpan = H - topPad - PADDING_Y;
    const point = referencePoints[hoveredReferenceIndex];
    referenceCrosshair = {
      x: referencePath.xs[hoveredReferenceIndex],
      y: topPad + (1 - (point.value - valueRange.min) / range) * ySpan,
      point,
    };
  }

  // Sprint 2.1: track the SVG's actual rendered width so we can position
  // the floating scrubber chip in CSS pixels (the SVG itself uses a
  // viewBox so coordinates inside it are 0..800 regardless of width).
  // The crosshair % position is what we expose to children via `overlay`.
  const crosshairPct = crosshair ? (crosshair.x / W) * 100 : null;
  const hoveredTrade = hoveredTradeIndex != null ? markerModel.markers[hoveredTradeIndex] : null;
  const hoveredTradeX = hoveredTrade ? (hoveredTrade.x / W) * 100 : null;
  const hoveredTradeY = hoveredTrade ? (hoveredTrade.y / H) * 100 : null;
  const placeTooltipBelow = hoveredTrade != null && hoveredTrade.y < 76;
  const clearHover = () => {
    if (pinnedTradeIndex == null) hideTradeTooltip();
    setHoveredReferenceIndex(null);
    onHoverChange(null);
  };

  return (
    <div ref={chartRootRef} className="interactive-chart" onPointerLeave={clearHover} onPointerCancel={clearHover}>
    <svg
      ref={svgRef}
      className="symbol-chart-svg"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      tabIndex={0}
      aria-label={`${ariaLabel ?? 'Chart'}, ${points.length} points observed${points.some((point) => point.unreliable) ? `, ${points.filter((point) => point.unreliable).length} shown as unverified captured history` : ''}${displayPoints.length < points.length ? `, ${displayPoints.length} used for the trend line` : ''}. Use arrow keys to inspect every observation.`}
      onPointerMove={(e) => {
        e.stopPropagation();
        handlePointer(e.clientX);
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        handlePointer(e.clientX);
      }}
      onPointerLeave={(e) => {
        e.stopPropagation();
        onHoverChange(null);
      }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={handleKey}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity={0.20} />
          <stop offset="58%" stopColor={stroke} stopOpacity={0.05} />
          <stop offset="100%" stopColor={stroke} stopOpacity={0} />
        </linearGradient>
        {referencePath && showUnobservedRegion ? (
          <clipPath id={referenceClipId} className="symbol-chart-reference-clip">
            <rect x={0} y={0} width={path.xs[0]} height={H} />
          </clipPath>
        ) : null}
      </defs>
      {referencePath && showUnobservedRegion ? (
        <path
          d={referencePath.d}
          className="symbol-chart-reference-line"
          fill="none"
          clipPath={`url(#${referenceClipId})`}
        />
      ) : null}
      {!hasUnreliablePoints ? (
        <line x1={path.xs[0]} y1={path.zeroY} x2={path.xs[path.xs.length - 1]} y2={path.zeroY} className="symbol-chart-baseline" />
      ) : null}
      <path d={path.area} className="symbol-chart-area" fill={`url(#${gradId})`} />
      <path
        d={path.d}
        className="symbol-chart-line symbol-chart-observed-line"
        stroke={stroke}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {referenceCrosshair ? (
        <g className="symbol-chart-reference-crosshair">
          <line
            x1={referenceCrosshair.x} y1={0}
            x2={referenceCrosshair.x} y2={H}
            className="symbol-chart-reference-crosshair-line"
          />
          <circle
            cx={referenceCrosshair.x} cy={referenceCrosshair.y}
            r={4}
            className="symbol-chart-reference-crosshair-puck"
          />
        </g>
      ) : null}
      {crosshair ? (
        <g className="symbol-chart-crosshair">
          <line
            x1={crosshair.x} y1={0}
            x2={crosshair.x} y2={H}
            className="symbol-chart-crosshair-line"
          />
          <circle
            cx={crosshair.x} cy={crosshair.y}
            r={5}
            className={`symbol-chart-crosshair-puck ${hoveredIndex != null && points[hoveredIndex]?.unreliable ? 'unreliable' : ''}`}
            stroke={hoveredIndex != null && points[hoveredIndex]?.unreliable ? 'var(--warning, #fbbf24)' : stroke}
          />
        </g>
      ) : null}
      {/* Sprint 2.1: tiny label at the right edge of the start-value
          baseline, so the dashed line reads as a meaningful reference
          rather than a stray gridline. preserveAspectRatio="none" on
          the parent SVG would distort text, so we render this label as
          an HTML overlay below instead — see the .chart-baseline-label
          element at the bottom of the wrapper. */}
    </svg>
    {showUnobservedRegion ? (
      <div
        className="chart-unobserved-region"
        style={{ width: `${Math.min(100, Math.max(0, (path.xs[0] / W) * 100))}%` }}
        aria-hidden
      >
        <span>
          <strong>No observed history</strong>
          {referencePath ? <small>Dashed line: current holdings backtest</small> : null}
        </span>
      </div>
    ) : null}
    {markerModel.markers.map((m, i) => (
      <button
        key={`${m.transactions.map((t) => t.id).join('|')}-${i}`}
        type="button"
        className={`trade-marker-badge ${m.kind === 'buy' ? 'trade-marker-buy' : m.kind === 'sell' ? 'trade-marker-sell' : 'trade-marker-mixed'} trade-marker-placement-${m.placement} ${m.transactions.length > 1 ? 'multi' : 'single'}`}
        style={{
          left: `clamp(16px, ${(m.x / W) * 100}%, calc(100% - 16px))`,
          top: `${(m.y / H) * 100}%`,
        }}
        aria-label={tradeMarkerLabel(m.transactions)}
        data-trade-count={m.transactions.length}
        aria-haspopup="dialog"
        aria-expanded={pinnedTradeIndex === i}
        onPointerEnter={(e) => {
          e.stopPropagation();
          if (pinnedTradeIndex == null) showTradeTooltip(i, e.currentTarget);
        }}
        onPointerLeave={(e) => {
          e.stopPropagation();
          const next = e.relatedTarget;
          if (
            pinnedTradeIndex == null
            && (!(next instanceof Node) || !tooltipRef.current?.contains(next))
          ) {
            hideTradeTooltip();
          }
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          if (pinnedTradeIndex === i) {
            setPinnedTradeIndex(null);
            hideTradeTooltip();
          } else {
            setPinnedTradeIndex(i);
            showTradeTooltip(i, e.currentTarget);
          }
        }}
        onFocus={(e) => {
          if (pinnedTradeIndex == null) showTradeTooltip(i, e.currentTarget);
        }}
        onBlur={() => {
          if (pinnedTradeIndex == null) hideTradeTooltip();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            setPinnedTradeIndex(null);
            hideTradeTooltip();
          }
        }}
      >
        <span className="trade-marker-symbol" aria-hidden>
          {m.kind === 'buy' ? '↑' : m.kind === 'sell' ? '↓' : '↕'}
        </span>
        {m.transactions.length > 1 ? (
          <span className="trade-marker-count">{m.transactions.length}</span>
        ) : null}
      </button>
    ))}
    {/* Baseline label, anchored to the first-point y position. The
        SVG uses preserveAspectRatio="none" so any <text> inside would
        stretch; render it as HTML positioned via top:% calc instead. */}
    {!hasReliabilityGaps && !hasUnreliablePoints ? (
      <span
        className="chart-baseline-label"
        aria-hidden
        style={{ top: `${(path.zeroY / H) * 100}%` }}
      >
        Start
      </span>
    ) : null}
    {crosshairPct != null ? (
      <span
        className="chart-scrubber-rule"
        aria-hidden
        style={{ left: `${crosshairPct}%` }}
      />
    ) : null}
    {referenceCrosshair && formatReferencePoint ? (() => {
      const formatted = formatReferencePoint(referenceCrosshair.point);
      return (
        <span
          className="chart-reference-readout"
          style={{
            left: `clamp(78px, ${(referenceCrosshair.x / W) * 100}%, calc(100% - 78px))`,
            top: `clamp(38px, ${(referenceCrosshair.y / H) * 100}%, calc(100% - 38px))`,
          }}
          role="status"
        >
          <strong>{formatted.primary}</strong>
          <small>{formatted.secondary}</small>
        </span>
      );
    })() : null}
    {hoveredTrade && hoveredTradeOverlay && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={tooltipRef}
            className={`chart-trade-tooltip ${hoveredTradeOverlay.below ? 'below' : ''}`}
            role="dialog"
            aria-label="Trade details"
            onPointerEnter={(e) => e.stopPropagation()}
            onPointerLeave={(e) => {
              e.stopPropagation();
              if (pinnedTradeIndex == null) hideTradeTooltip();
            }}
            style={{
              left: `${hoveredTradeOverlay.left}px`,
              top: `${hoveredTradeOverlay.top}px`,
              '--trade-tooltip-list-max': `${hoveredTradeOverlay.listMaxHeight}px`,
            } as CSSProperties}
          >
            <TradeTooltip
              transactions={hoveredTrade.transactions}
              accountIdToName={accountIdToName}
            />
          </div>,
          document.body,
        )
      : null}
    </div>
  );
}

interface PathBundle { d: string; area: string; zeroY: number; xs: number[] }
interface ValueRange { min: number; max: number }
type CurveKind = 'linear' | 'monotone';
type TradeMarkerKind = 'buy' | 'sell' | 'mixed';
type TradeMarkerPlacement = 'above' | 'below' | 'center';
interface TradeMarkerGroup {
  idx: number;
  x: number;
  transactions: Transaction[];
}
interface TradeMarker extends TradeMarkerGroup {
  y: number;
  kind: TradeMarkerKind;
  placement: TradeMarkerPlacement;
}

function buildPath(
  points: ChartPoint[],
  topReserve = 0,
  domainFrom?: string,
  domainTo?: string,
  valueRange: ValueRange = measureValueRange(points),
  xRatios?: number[],
  curve: CurveKind = 'linear',
): PathBundle | null {
  if (points.length < 2) return null;
  const range = valueRange.max - valueRange.min || 1;
  const xs = buildXPositions(points, domainFrom, domainTo, xRatios);
  const topPad = PADDING_Y + topReserve;
  const ySpan = H - topPad - PADDING_Y;
  const xy = (i: number, v: number): [number, number] => [
    xs[i],
    topPad + (1 - (v - valueRange.min) / range) * ySpan,
  ];
  const coordinates: Array<[number, number]> = [];
  for (let i = 0; i < points.length; i++) {
    coordinates.push(xy(i, points[i].value));
  }
  const baseY = H - PADDING_Y;
  const starts = [0];
  for (let index = 1; index < points.length; index++) {
    if (points[index].gapBefore) starts.push(index);
  }
  const ranges = starts.map((start, index) => ({
    start,
    end: starts[index + 1] ?? points.length,
  }));
  const lineParts: string[] = [];
  const areaParts: string[] = [];
  for (const segment of ranges) {
    const segmentCoordinates = coordinates.slice(segment.start, segment.end);
    // A lone observation between gaps is a dot (the line's round cap), never a
    // line to a neighbour it was not observed next to.
    const segmentD = segmentCoordinates.length === 1
      ? `M${segmentCoordinates[0][0].toFixed(2)},${segmentCoordinates[0][1].toFixed(2)}l0,0`
      : curve === 'monotone'
      ? buildMonotonePath(segmentCoordinates)
      : segmentCoordinates.map(([x, y], index) => (
          `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
        )).join('');
    const firstX = xs[segment.start];
    const lastX = xs[segment.end - 1];
    lineParts.push(segmentD);
    areaParts.push(`${segmentD}L${lastX.toFixed(2)},${baseY}L${firstX.toFixed(2)},${baseY}Z`);
  }
  const d = lineParts.join('');
  const area = areaParts.join('');
  const [, zeroY] = xy(0, points[0].value);
  return { d, area, zeroY, xs };
}

function buildMonotonePath(coordinates: Array<[number, number]>): string {
  const [first] = coordinates;
  const segments = monotoneBezierSegments(
    coordinates.map(([x]) => x),
    coordinates.map(([, y]) => y),
  );
  return `M${first[0].toFixed(2)},${first[1].toFixed(2)}${segments.map((segment) => (
    `C${segment.control1[0].toFixed(2)},${segment.control1[1].toFixed(2)} `
    + `${segment.control2[0].toFixed(2)},${segment.control2[1].toFixed(2)} `
    + `${segment.end[0].toFixed(2)},${segment.end[1].toFixed(2)}`
  )).join('')}`;
}

function buildTradeMarkers(
  points: ChartPoint[],
  transactions: Transaction[],
  topReserve = 0,
  valueRange: ValueRange = measureValueRange(points),
  xs: number[] = buildXPositions(points),
  minSeparation = 0,
) {
  if (points.length < 2 || transactions.length === 0) return { markers: [] as TradeMarker[] };
  const range = valueRange.max - valueRange.min || 1;
  const topPad = PADDING_Y + topReserve;
  const ySpan = H - topPad - PADDING_Y;
  const first = points[0].t;
  const last = points[points.length - 1].t;
  const dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const firstDate = first.length === 10 ? first : dateFormatter.format(new Date(first));
  const lastDate = last.length === 10 ? last : dateFormatter.format(new Date(last));
  const visible = transactions
    .filter((t) => t.date >= firstDate && t.date <= lastDate)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const raw = visible.map((transaction) => {
    const idx = nearestPointIndex(points, transaction.date);
    return { transaction, idx };
  });
  const grouped = new Map<number, Transaction[]>();
  for (const item of raw) {
    const list = grouped.get(item.idx) ?? [];
    list.push(item.transaction);
    grouped.set(item.idx, list);
  }
  const pointGroups = Array.from(grouped.entries())
    .map(([idx, groupedTransactions]) => ({
      idx,
      x: xs[idx],
      transactions: groupedTransactions,
    }))
    .sort((left, right) => left.x - right.x || left.idx - right.idx);
  const markerGroups = clusterTradeMarkerGroups(pointGroups, minSeparation);
  const markers = markerGroups.map(({ idx, x, transactions }) => {
      const hasBuy = transactions.some((t) => t.quantity > 0);
      const hasSell = transactions.some((t) => t.quantity < 0);
      const kind = hasBuy && hasSell ? 'mixed' as const : hasBuy ? 'buy' as const : 'sell' as const;
      const y = topPad + (1 - (points[idx].value - valueRange.min) / range) * ySpan;
      const placement = kind === 'buy'
        ? (y > H - 31 ? 'above' as const : 'below' as const)
        : kind === 'sell'
          ? (y < 31 ? 'below' as const : 'above' as const)
          : y < 13
            ? 'below' as const
            : y > H - 13
              ? 'above' as const
              : 'center' as const;
      return {
        transactions,
        kind,
        placement,
        idx,
        x,
        y,
      };
    });
  return { markers };
}

function clusterTradeMarkerGroups(
  groups: TradeMarkerGroup[],
  minSeparation: number,
): TradeMarkerGroup[] {
  if (groups.length < 2 || minSeparation <= 0) return groups;
  const clusters: TradeMarkerGroup[][] = [];
  let current: TradeMarkerGroup[] = [];
  let representative: TradeMarkerGroup | null = null;

  for (const group of groups) {
    if (representative && group.x - representative.x >= minSeparation) {
      clusters.push(current);
      current = [];
    }
    current.push(group);
    const meanX = current.reduce((sum, member) => sum + member.x, 0) / current.length;
    representative = current.reduce((closest, member) => (
      Math.abs(member.x - meanX) < Math.abs(closest.x - meanX) ? member : closest
    ));
  }
  if (current.length > 0) clusters.push(current);

  return clusters.map((cluster) => {
    const meanX = cluster.reduce((sum, member) => sum + member.x, 0) / cluster.length;
    const anchor = cluster.reduce((closest, member) => (
      Math.abs(member.x - meanX) < Math.abs(closest.x - meanX) ? member : closest
    ));
    return {
      idx: anchor.idx,
      x: anchor.x,
      transactions: cluster.flatMap((member) => member.transactions),
    };
  });
}

function measureValueRange(points: ChartPoint[]): ValueRange {
  const values = points.map((point) => point.value).filter(Number.isFinite);
  if (values.length === 0) return { min: 0, max: 1 };
  return { min: Math.min(...values), max: Math.max(...values) };
}

function nearestXIndex(xs: number[], localX: number): number {
  let low = 0;
  let high = xs.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (xs[middle] < localX) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return 0;
  const previous = low - 1;
  return Math.abs(xs[previous] - localX) <= Math.abs(xs[low] - localX)
    ? previous
    : low;
}

function buildXPositions(
  points: ChartPoint[],
  domainFrom?: string,
  domainTo?: string,
  xRatios?: number[],
): number[] {
  if (domainFrom && domainTo) {
    const domainStart = parseDomainBoundary(domainFrom, false);
    const domainEnd = parseDomainBoundary(domainTo, true);
    if (Number.isFinite(domainStart) && Number.isFinite(domainEnd) && domainEnd > domainStart) {
      const span = domainEnd - domainStart;
      const width = W - 2 * PADDING_X;
      return points.map((point, index) => {
        const timestamp = parsePointTimestamp(point.t);
        if (!Number.isFinite(timestamp)) {
          return PADDING_X + index * width / Math.max(1, points.length - 1);
        }
        const ratio = Math.min(1, Math.max(0, (timestamp - domainStart) / span));
        return PADDING_X + ratio * width;
      });
    }
  }

  if (xRatios?.length === points.length) {
    const width = W - 2 * PADDING_X;
    return xRatios.map((ratio) => PADDING_X + Math.min(1, Math.max(0, ratio)) * width);
  }

  const step = (W - 2 * PADDING_X) / Math.max(1, points.length - 1);
  return points.map((_, index) => PADDING_X + index * step);
}

function parsePointTimestamp(value: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value);
}

function parseDomainBoundary(value: string, end: boolean): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return Date.parse(`${value}T${end ? '23:59:59.999' : '00:00:00.000'}Z`);
  }
  return Date.parse(value);
}

function tradeMarkerLabel(transactions: Transaction[]): string {
  const [first] = transactions;
  if (transactions.length === 1) {
    return `${first.quantity > 0 ? 'Buy' : 'Sell'} ${Math.abs(first.quantity)} ${first.symbol} at ${first.pricePerUnit} on ${first.date}`;
  }
  const symbols = Array.from(new Set(transactions.map((t) => t.symbol)));
  const dates = Array.from(new Set(transactions.map((t) => t.date))).sort();
  const symbolLabel = symbols.length === 1 ? `${symbols[0]} ` : '';
  const dateLabel = dates.length === 1
    ? `on ${dates[0]}`
    : `from ${dates[0]} to ${dates[dates.length - 1]}`;
  const buyCount = transactions.filter((transaction) => transaction.quantity > 0).length;
  const sellCount = transactions.filter((transaction) => transaction.quantity < 0).length;
  const directions = [
    buyCount > 0 ? `${buyCount} ${buyCount === 1 ? 'buy' : 'buys'}` : null,
    sellCount > 0 ? `${sellCount} ${sellCount === 1 ? 'sell' : 'sells'}` : null,
  ].filter(Boolean).join(' and ');
  return `${transactions.length} ${symbolLabel}trades: ${directions} ${dateLabel}`;
}

function nearestPointIndex(points: ChartPoint[], date: string): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  const target = Date.parse(`${date}T12:00:00Z`);
  for (let i = 0; i < points.length; i++) {
    const pointDate = /^\d{4}-\d{2}-\d{2}$/.test(points[i].t)
      ? `${points[i].t}T12:00:00Z`
      : points[i].t;
    const d = Math.abs(Date.parse(pointDate) - target);
    if (d < bestDistance) {
      best = i;
      bestDistance = d;
    }
  }
  return best;
}
