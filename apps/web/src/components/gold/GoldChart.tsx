import { useEffect, useId, useRef, useState } from 'react';

import { ApiError } from '../../services/api';
import { TitleWithSpinner } from '../Spinner';
import {
  fetchMetalsCloses,
  type GoldCloses,
  type GoldPeriod,
  type Metal,
  type MetalsMeasure,
  type MetalsPurchases,
  type MetalsSales,
  type MetalsTimeline,
  type MetalsTimelineMonth,
} from './goldApi';
import {
  PRICE_JOIN_DAYS,
  SPOT_OFF_WORDS,
  closesInRange,
  combined,
  dateText,
  metalName,
  plural,
  priceChartStart,
  priceLine,
  pricePerTroyOz,
  reasonText,
  usd,
  type GoldSpot,
} from './goldText';

/*
 * The redesign's two charts (Astra's accepted mock, round 4): "Price & your trades", daily spot per troy oz with each
 * trade at its price per troy oz, kept apart from "What you held", the dollars of what was held at each month's end.
 * Each chart draws only what falls in its own dates (nothing is pinned to an edge), a missing price or month is a
 * shaded, labelled gap and never zero, and a chart with nothing to draw keeps its dates and says why.
 */

const DAY_MS = 86_400_000;
const TICK = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', year: '2-digit' });
const MONTH = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', year: 'numeric' });
const time = (date: string) => Date.parse(`${date}T00:00:00Z`);

interface PlotPoint { date: string; value: number | null; title?: string }
interface PlotLine { key: string; className: string; points: PlotPoint[]; dots?: boolean }
interface PlotMark { key: string; date: string; value: number; shape: 'circle' | 'triangle'; className: string; title: string }
interface PlotGap { from: string; to: string; label: string }
interface PlotTick { key: string; date: string; kind: 'buy' | 'sell' }

/** A line's runs between gaps: a missing point breaks it. */
function runsOf(points: readonly PlotPoint[]): Array<Array<PlotPoint & { value: number }>> {
  const runs: Array<Array<PlotPoint & { value: number }>> = [];
  let run: Array<PlotPoint & { value: number }> = [];
  for (const point of points) {
    if (point.value === null) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else run.push({ ...point, value: point.value });
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

function useWidth() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(720);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      // Whole pixels, rounded down: the drawing is never scaled below 1, so its 14px labels are drawn at 14px or more.
      const next = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (next > 0) setWidth(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

function niceStep(span: number, ticks: number) {
  const raw = span / ticks;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
}

/**
 * One chart's plot over [from, to]: only what falls inside is drawn or scaled (a shaded band is trimmed to the plot; a
 * point is never clamped to an edge). With nothing to draw, the dates and their bands stay, and `emptyReason` says why.
 */
function GoldPlot({ lines, marks, from, to, format, label, yTitle, gaps, ticks: tradeTicks = [], emptyReason, testId }: {
  lines: PlotLine[];
  marks: PlotMark[];
  from: string;
  to: string;
  format: (value: number) => string;
  label: string;
  yTitle: string;
  gaps: PlotGap[];
  ticks?: PlotTick[];
  emptyReason: string;
  testId: string;
}) {
  const { ref, width } = useWidth();
  const x0 = time(from);
  const x1 = Math.max(time(to), x0 + DAY_MS);
  const within = (date: string) => time(date) >= x0 && time(date) <= x1;
  const shownLines = lines.map((line) => ({ ...line, points: line.points.filter((point) => within(point.date)) }));
  const shownMarks = marks.filter((mark) => within(mark.date));
  const shownTicks = tradeTicks.filter((tick) => within(tick.date));
  const narrow = width < 520;
  const height = narrow ? 240 : 300;
  const pad = { left: narrow ? 64 : 80, right: 14, top: 26, bottom: shownTicks.length > 0 ? 50 : 32 };
  const values = [...shownLines.flatMap((line) => line.points.flatMap((point) => (point.value === null ? [] : [point.value]))), ...shownMarks.map((mark) => mark.value)];
  let y0 = values.length > 0 ? Math.min(...values) : 0;
  let y1 = values.length > 0 ? Math.max(...values) : 1;
  if (y1 - y0 < 100) { y0 -= 100; y1 += 100; }
  const margin = (y1 - y0) * 0.08;
  y0 -= margin;
  y1 += margin;
  const step = niceStep(y1 - y0, narrow ? 3 : 4);
  const yTicks: number[] = [];
  if (values.length > 0) for (let value = Math.ceil(y0 / step) * step; value <= y1; value += step) yTicks.push(value);
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const X = (t: number) => pad.left + ((t - x0) / (x1 - x0)) * plotWidth;
  const Y = (v: number) => pad.top + (1 - (v - y0) / (y1 - y0)) * plotHeight;
  const starts: number[] = [];
  const begin = new Date(x0);
  for (let cursor = Date.UTC(begin.getUTCFullYear(), begin.getUTCMonth() + 1, 1); cursor <= x1;) {
    starts.push(cursor);
    const at = new Date(cursor);
    cursor = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
  }
  const every = Math.max(1, Math.ceil(starts.length / (narrow ? 3 : 7)));
  const xTicks = starts.filter((_, index) => index % every === 0);
  return (
    <div ref={ref} className="gold-plot" data-testid={testId}>
      {/* A labelled group: its axis words are drawn for the eye; each gap, point and trade is an image named by its readout. */}
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="group" aria-label={label}>
        <text x={pad.left} y={14} className="gold-plot-axis" aria-hidden="true">{yTitle}</text>
        {gaps.map((gap) => {
          const left = Math.max(X(time(gap.from)), pad.left);
          const right = Math.min(X(time(gap.to)), width - pad.right);
          if (right - left < 1) return null;
          const readout = `${gap.label}: ${dateText(gap.from)} – ${dateText(gap.to)}`;
          return (
            <g key={`${gap.from}-${gap.to}`} className="gold-plot-gap" data-testid="gold-plot-gap" role="img" aria-label={readout}>
              <rect x={left} y={pad.top} width={right - left} height={plotHeight}><title>{readout}</title></rect>
              {right - left > gap.label.length * 8.8 + 14 ? <text x={left + 6} y={pad.top + 18} className="gold-plot-axis" aria-hidden="true">{gap.label}</text> : null}
            </g>
          );
        })}
        <line x1={pad.left} x2={width - pad.right} y1={pad.top + plotHeight} y2={pad.top + plotHeight} className="gold-plot-grid" />
        {yTicks.map((tick) => (
          <g key={tick} aria-hidden="true">
            <line x1={pad.left} x2={width - pad.right} y1={Y(tick)} y2={Y(tick)} className="gold-plot-grid" />
            <text x={pad.left - 8} y={Y(tick)} className="gold-plot-axis" textAnchor="end" dominantBaseline="middle">{format(tick)}</text>
          </g>
        ))}
        {xTicks.map((tick) => {
          const x = X(tick);
          const anchor = x > width - pad.right - 30 ? 'end' : x < pad.left + 30 ? 'start' : 'middle';
          return <text key={tick} x={x} y={height - 8} className="gold-plot-axis" textAnchor={anchor} aria-hidden="true">{TICK.format(new Date(tick))}</text>;
        })}
        {shownLines.flatMap((line) => runsOf(line.points).map((run, index) => (run.length > 1 ? (
          <polyline key={`${line.key}-${index}`} className={line.className} fill="none"
            points={run.map((point) => `${X(time(point.date)).toFixed(1)},${Y(point.value).toFixed(1)}`).join(' ')} />
        ) : (
          <circle key={`${line.key}-${index}`} className={`${line.className} dot`} cx={X(time(run[0].date))} cy={Y(run[0].value)} r={3.5}
            role={run[0].title ? 'img' : undefined} aria-label={run[0].title}>
            {run[0].title ? <title>{run[0].title}</title> : null}
          </circle>
        ))))}
        {shownLines.filter((line) => line.dots).flatMap((line) => line.points.flatMap((point) => (point.value === null ? [] : [(
          <circle key={`${line.key}-dot-${point.date}`} className={`${line.className} dot`} cx={X(time(point.date))} cy={Y(point.value)} r={3.5} tabIndex={0}
            role="img" aria-label={point.title ?? `${point.date}: ${format(point.value)}`}>
            {point.title ? <title>{point.title}</title> : null}
          </circle>
        )])))}
        {shownMarks.map((mark) => {
          const cx = X(time(mark.date));
          const cy = Y(mark.value);
          return mark.shape === 'circle'
            ? <circle key={mark.key} className={mark.className} cx={cx} cy={cy} r={narrow ? 4.5 : 5.5} tabIndex={0} role="img" aria-label={mark.title}><title>{mark.title}</title></circle>
            : (
              <path key={mark.key} className={mark.className} tabIndex={0} role="img" aria-label={mark.title}
                d={`M ${cx.toFixed(1)} ${(cy - 7).toFixed(1)} L ${(cx + 6.5).toFixed(1)} ${(cy + 5).toFixed(1)} L ${(cx - 6.5).toFixed(1)} ${(cy + 5).toFixed(1)} Z`}>
                <title>{mark.title}</title>
              </path>
            );
        })}
        {shownTicks.map((tick) => {
          const x = X(time(tick.date)).toFixed(1);
          const y = pad.top + plotHeight + (tick.kind === 'buy' ? 6 : 15);
          return <line key={tick.key} x1={x} x2={x} y1={y} y2={y + 7} className={tick.kind === 'buy' ? 'gold-plot-tick-buy' : 'gold-plot-tick-sell'} />;
        })}
      </svg>
      {values.length === 0 ? <p className="gold-help" data-testid="gold-plot-empty">{emptyReason}</p> : null}
    </div>
  );
}

/** Dollars on an axis, a negative one signed before the dollar sign ("−$1", never "$-1"). */
const perOzTick = (minor: number) => {
  const dollars = Math.round(minor / 100);
  return `${dollars < 0 ? '−' : ''}$${Math.abs(dollars).toLocaleString('en-US')}`;
};
const moneyTick = (minor: number) => {
  const dollars = minor / 100;
  const sign = dollars < 0 ? '−' : '';
  if (Math.abs(dollars) >= 1000) return `${sign}$${(Math.abs(dollars) / 1000).toFixed(Math.abs(dollars) >= 10_000 ? 0 : 1)}k`;
  const whole = Math.round(dollars);
  return `${whole < 0 ? '−' : ''}$${Math.abs(whole)}`;
};

type ClosesRead =
  | { status: 'loading' }
  | { status: 'ok'; read: GoldCloses }
  | { status: 'unavailable' }
  | { status: 'error' };

/**
 * The daily closes, kept apart: loading, read (possibly none stored; `fetching` says whether this Holdr fetches them),
 * not available on this Holdr (the route isn't there: a 404), or a read that failed (said so, with Retry). A failed read
 * is never shown as "no usable close".
 */
function useCloses(metal: Metal, period: GoldPeriod): { read: ClosesRead; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const key = `${metal}|${period.from ?? ''}|${period.to}|${attempt}`;
  const [state, setState] = useState<{ key: string; read: ClosesRead }>({ key: '', read: { status: 'loading' } });
  useEffect(() => {
    let cancelled = false;
    fetchMetalsCloses(metal, period)
      .then((answer) => {
        if (cancelled) return;
        setState({ key, read: answer.installed ? { status: 'ok', read: answer } : { status: 'unavailable' } });
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setState({ key, read: reason instanceof ApiError && reason.status === 404 ? { status: 'unavailable' } : { status: 'error' } });
      });
    return () => { cancelled = true; };
  }, [key, metal, period]);
  return { read: state.key === key ? state.read : { status: 'loading' }, retry: () => setAttempt((value) => value + 1) };
}

interface GoldTrade { key: string; date: string; perOzMinor: number; troyOz: number }

const ouncesOf = (exact: string, quantity: number) => {
  const [numerator, denominator] = exact.split('/');
  return (Number(numerator) / Number(denominator ?? '1')) * quantity;
};

/**
 * Buys at their price per troy oz: kept (neither cancelled nor returned), contents confirmed and cost complete. A partial
 * cost (part of its order's cost not assigned, or records that disagree) is no exact price, so it is a tick instead.
 */
function buysOf(read: MetalsPurchases | null): GoldTrade[] {
  return (read?.purchases ?? []).flatMap((purchase) => {
    if (purchase.delivery.state === 'cancelled' || purchase.delivery.state === 'returned' || !purchase.content.known) return [];
    if (purchase.costMinor.state !== 'complete') return [];
    const perOz = pricePerTroyOz(purchase.costMinor.value, purchase.content.troyOzPerUnit, purchase.quantity);
    return perOz === null ? [] : [{ key: purchase.key, date: purchase.orderDate, perOzMinor: perOz, troyOz: ouncesOf(purchase.content.troyOzPerUnit.exact, purchase.quantity) }];
  });
}

/** Sales at what they brought in per troy oz, after fees: not cancelled, contents confirmed. */
function sellsOf(read: MetalsSales | null): GoldTrade[] {
  return (read?.sales ?? []).flatMap((sale) => {
    if (sale.status === 'cancelled' || !sale.content.known) return [];
    const perOz = pricePerTroyOz(sale.netMinor, sale.content.troyOzPerUnit, sale.quantity);
    return perOz === null ? [] : [{ key: sale.key, date: sale.agreedDate, perOzMinor: perOz, troyOz: ouncesOf(sale.content.troyOzPerUnit.exact, sale.quantity) }];
  });
}

/**
 * Trades with no exact price per troy oz yet (contents not confirmed, or a purchase's cost not complete): a tick on their
 * day.
 */
function waitingTicks(purchases: MetalsPurchases | null, sales: MetalsSales | null): PlotTick[] {
  const ticks: PlotTick[] = [];
  for (const purchase of purchases?.purchases ?? []) {
    if (purchase.delivery.state === 'cancelled' || purchase.delivery.state === 'returned') continue;
    if (!purchase.content.known || purchase.costMinor.value === null || purchase.costMinor.state !== 'complete') {
      ticks.push({ key: `buy-${purchase.key}`, date: purchase.orderDate, kind: 'buy' });
    }
  }
  for (const sale of sales?.sales ?? []) {
    if (sale.status !== 'cancelled' && !sale.content.known) ticks.push({ key: `sell-${sale.key}`, date: sale.agreedDate, kind: 'sell' });
  }
  return ticks;
}

const averagePerOz = (trades: readonly GoldTrade[]) => {
  const ounces = trades.reduce((total, trade) => total + trade.troyOz, 0);
  return ounces > 0 ? Math.round(trades.reduce((total, trade) => total + trade.perOzMinor * trade.troyOz, 0) / ounces) : null;
};

/**
 * Price & your trades: the metal's daily close per troy oz over its own dates, each buy and sale at its price per troy oz.
 * A purchases or sales read that failed is said so (`tradesError`), never as "no trades".
 */
export function GoldPriceChart({ metal, period, purchases, sales, tradesError }: {
  metal: Metal;
  period: GoldPeriod;
  purchases: MetalsPurchases | null;
  sales: MetalsSales | null;
  tradesError: string | null;
}) {
  const titleId = useId();
  const { read, retry } = useCloses(metal, period);
  const tradesReading = tradesError === null && (purchases === null || sales === null);
  const closes = read.status === 'ok' ? read.read.closes : [];
  const allBuys = buysOf(purchases);
  const allSells = sellsOf(sales);
  const allTicks = waitingTicks(purchases, sales);
  const firstClose = [...closes].sort((a, b) => a.date.localeCompare(b.date))[0]?.date;
  const start = priceChartStart(period.from, [firstClose, ...allBuys.map((trade) => trade.date), ...allSells.map((trade) => trade.date),
    ...allTicks.map((tick) => tick.date)].filter((date): date is string => typeof date === 'string'), period.to);
  const end = period.to;
  const inside = (date: string) => date >= start && date <= end;
  const spot = closesInRange(closes, start, end);
  const buys = allBuys.filter((trade) => inside(trade.date));
  const sells = allSells.filter((trade) => inside(trade.date));
  const ticks = allTicks.filter((tick) => inside(tick.date));
  const line = read.status === 'ok' ? priceLine(spot, start, end) : { points: [], gaps: [] };
  const first = spot[0] ?? null;
  const latest = spot.length > 0 ? spot[spot.length - 1] : null;
  const endpoints: PlotMark[] = [first, spot.length > 1 ? latest : null].flatMap((point, index) => (point === null ? [] : [{
    key: `close-${index === 0 ? 'first' : 'last'}`, date: point.date, value: point.minor, shape: 'circle' as const, className: 'gold-plot-endpoint',
    title: `${index === 0 ? 'First close shown' : 'Latest close'}: ${dateText(point.date)}, ${usd(point.minor)} per troy oz`,
  }]));
  const marks: PlotMark[] = [
    ...endpoints,
    ...buys.map((trade): PlotMark => ({
      key: `buy-${trade.key}`, date: trade.date, value: trade.perOzMinor, shape: 'circle', className: 'gold-plot-buy',
      title: `Bought ${trade.troyOz.toFixed(3)} troy oz on ${dateText(trade.date)} at ${usd(trade.perOzMinor)} per troy oz`,
    })),
    ...sells.map((trade): PlotMark => ({
      key: `sell-${trade.key}`, date: trade.date, value: trade.perOzMinor, shape: 'triangle', className: 'gold-plot-sell',
      title: `Sold ${trade.troyOz.toFixed(3)} troy oz on ${dateText(trade.date)} at ${usd(trade.perOzMinor)} per troy oz, after fees`,
    })),
  ];
  const tickBuys = ticks.filter((tick) => tick.kind === 'buy').length;
  const avgBuy = averagePerOz(buys);
  const avgSell = averagePerOz(sells);
  const tradesWords = tradesError !== null ? 'your trades couldn\'t be read'
    : tradesReading ? 'your trades are still being read' : 'no trade at a known price in these dates';
  const emptyReason = read.status === 'loading' ? 'Reading daily prices…'
    : read.status === 'error' ? `Daily prices unavailable, and ${tradesWords}`
      : read.status === 'unavailable' ? `Daily prices aren't available on this Holdr, and ${tradesWords}`
        : `No usable close, and ${tradesWords}`;
  return (
    <section className="gold-card gold-chart-card" aria-labelledby={titleId} data-testid="gold-price-chart" aria-busy={read.status === 'loading'}>
      <div className="gold-chart-head">
        <h3 id={titleId}>Price &amp; your trades</h3>
        {latest && read.status === 'ok' && read.read.fetching
          ? <p className="gold-help">Spot <span className="num">{usd(latest.minor)}</span> per troy oz, {dateText(latest.date)} close</p> : null}
      </div>
      {read.status === 'error' ? (
        <p className="gold-warning" role="status" data-testid="gold-closes-error">
          Daily prices unavailable: they couldn&apos;t be read just now.{' '}
          <button type="button" className="gold-link" onClick={retry}>Retry</button>
        </p>
      ) : read.status === 'unavailable' ? (
        <p className="gold-help" data-testid="gold-closes-unavailable">Daily prices aren&apos;t available on this Holdr.</p>
      ) : read.status === 'ok' && !read.read.fetching ? (
        <p className="gold-help" data-testid="gold-closes-off">Prices off: this Holdr doesn&apos;t fetch CNBC daily closes, so the line shows only closes already stored.</p>
      ) : null}
      <GoldPlot lines={line.points.length > 0 ? [{ key: 'spot', className: 'gold-plot-spot', points: line.points }] : []} marks={marks}
        from={start} to={end} format={perOzTick} yTitle="USD per troy oz" testId="gold-price-plot"
        gaps={line.gaps.map((gap) => ({ ...gap, label: 'No usable close' }))} ticks={ticks} emptyReason={emptyReason}
        label={`${metalName(metal)} spot in US dollars per troy ounce, ${dateText(start)} to ${dateText(end)}, with each buy and sale at its price per troy ounce`} />
      <ul className="gold-legend">
        <li><span className="gold-swatch spot" aria-hidden="true" />{metalName(metal)} spot, CNBC daily close</li>
        <li><span className="gold-swatch buy" aria-hidden="true" />Bought: paid per troy oz</li>
        <li><span className="gold-swatch sell" aria-hidden="true" />Sold: received per troy oz, after fees</li>
        {ticks.length > 0 ? (
          <li><span className="gold-swatch tick" aria-hidden="true" />Ticks: trades with no exact price per troy oz yet (contents not confirmed, or cost not complete)</li>
        ) : null}
      </ul>
      <p className="gold-help">
        {dateText(start)} – {dateText(end)}. The line connects stored closes up to {PRICE_JOIN_DAYS} days apart; daily prices in between
        are not shown. A longer gap is shaded as no usable close.
      </p>
      {tradesError !== null ? (
        <p className="gold-error-text" data-testid="gold-trades-error">Your trades couldn&apos;t be read: {tradesError}</p>
      ) : (
        <p className="gold-chart-facts" data-testid="gold-price-facts">
          {tradesReading ? 'Reading your trades…' : (
            <>
              {buys.length > 0 ? `${plural(buys.length, 'buy', 'buys')} at a known price, average ${usd(avgBuy ?? 0)} per troy oz` : 'No buys at a known price'}
              {' · '}
              {sells.length > 0 ? `${plural(sells.length, 'sale', 'sales')}, average ${usd(avgSell ?? 0)} per troy oz` : 'no sales at a known price'}
              {ticks.length > 0
                ? ` · ${plural(tickBuys, 'buy', 'buys')} and ${plural(ticks.length - tickBuys, 'sale', 'sales')} with no exact price per troy oz yet`
                : ''}
            </>
          )}
        </p>
      )}
    </section>
  );
}

/** A month's point readout: its figure with its state and why. */
function monthTitle(month: MetalsTimelineMonth, what: 'cost' | 'value', measure: MetalsMeasure<number>, metal: Metal): string {
  const state = measure.state === 'complete' ? '' : ` (${measure.state}: ${measure.reasons.map((reason) => reasonText(reason, metal)).join('; ')})`;
  return `${MONTH.format(new Date(time(`${month.month}-01`)))}: ${what} ${measure.value === null ? 'unknown' : usd(measure.value)}${state}`;
}

/**
 * What you held: the cost (and, while values show, the value at spot) of what was held at each month's end. A month no
 * source recorded, or whose figure is unknown, is a shaded, labelled gap, one band for each run of such months; values
 * follow v0's rule (prices off or no price yet: no value line, said in the legend). A timeline read that failed is said
 * so, never left reading. `unresolved` says, under it, the units kept whose metal is unresolved: in no month's figure.
 * While its read is under way (`busy`), what it shows (the same period's months, read before) is marked as being read again.
 */
export function GoldHeldChart({ metal, start, end, timeline, error, spot, unresolved = null, busy = false }: {
  metal: Metal;
  start: string;
  end: string;
  timeline: MetalsTimeline | null;
  error: string | null;
  spot: GoldSpot;
  unresolved?: string | null;
  busy?: boolean;
}) {
  const titleId = useId();
  const months = timeline?.months ?? [];
  const gaps: PlotGap[] = [];
  // The months come one after another, oldest first: a run of months of the same kind is one band.
  let open: PlotGap | null = null;
  for (const month of months) {
    if (month.recorded && month.costMinor.value !== null) {
      open = null;
      continue;
    }
    const label = month.recorded ? 'Unknown' : 'Not recorded';
    if (open && open.label === label) open.to = month.endDate;
    else {
      open = { from: `${month.month}-01`, to: month.endDate, label };
      gaps.push(open);
    }
  }
  const showValue = spot === 'shown';
  const cost: PlotPoint[] = months.map((month) => ({ date: month.endDate, value: month.recorded ? month.costMinor.value : null, title: monthTitle(month, 'cost', month.costMinor, metal) }));
  const value: PlotPoint[] = months.map((month) => ({ date: month.endDate, value: month.recorded ? month.valueMinor.value : null, title: monthTitle(month, 'value', month.valueMinor, metal) }));
  const hasValue = showValue && value.some((point) => point.value !== null);
  const unknown = combined(...months.filter((month) => !(month.recorded && month.costMinor.value !== null)).map((month) => month.costMinor));
  const unknownWhy = [...new Set(unknown.reasons.map((reason) => reasonText(reason, metal)))].join(' · ');
  const partial = months.filter((month) => month.recorded && month.costMinor.value !== null
    && (month.costMinor.state !== 'complete' || (showValue && month.valueMinor.value !== null && month.valueMinor.state !== 'complete'))).length;
  // A month whose value is unknown has no value point: said unknown, with its reasons, never partial (Astra).
  const valueUnknown = showValue ? months.filter((month) => month.recorded && month.costMinor.value !== null && month.valueMinor.value === null) : [];
  const valueWhy = [...new Set(valueUnknown.flatMap((month) => month.valueMinor.reasons.map((reason) => reasonText(reason, metal))))].join(' · ');
  return (
    <section className="gold-card gold-chart-card" aria-labelledby={titleId} data-testid="gold-held-chart" aria-busy={busy || undefined}>
      <div className="gold-chart-head">
        {busy ? (
          <TitleWithSpinner busy><h3 id={titleId}>What you held: cost and value</h3></TitleWithSpinner>
        ) : <h3 id={titleId}>What you held: cost and value</h3>}
        <p className="gold-help">At each month&apos;s end, the {metalName(metal)} you held then</p>
      </div>
      {error !== null ? (
        <p className="gold-error-text" data-testid="gold-held-error">What you held couldn&apos;t be read: {error}</p>
      ) : timeline === null ? <p className="gold-help">Reading the months…</p> : (
        <GoldPlot lines={[{ key: 'cost', className: 'gold-plot-cost', points: cost, dots: true },
          ...(hasValue ? [{ key: 'value', className: 'gold-plot-value', points: value, dots: true }] : [])]}
          marks={[]} from={start} to={end} format={moneyTick} yTitle="US dollars, what you held" gaps={gaps} testId="gold-held-plot"
          emptyReason={`Cost and value unknown for these months${unknownWhy ? `: ${unknownWhy}` : ''}`}
          label={`Cost of the ${metalName(metal)} you held at each month's end, in US dollars${hasValue ? ', and its value at spot' : ''}`} />
      )}
      <ul className="gold-legend">
        <li><span className="gold-swatch cost" aria-hidden="true" />Cost of what you held</li>
        <li><span className="gold-swatch value" aria-hidden="true" />{showValue ? 'Value at spot' : `Value at spot: ${SPOT_OFF_WORDS[spot]}`}</li>
        <li><span className="gold-swatch gap" aria-hidden="true" />Shaded: months unknown or not recorded, never zero</li>
      </ul>
      {gaps.length > 0 && unknownWhy ? <p className="gold-help" data-testid="gold-held-unknown">Unknown months: {unknownWhy}.</p> : null}
      {valueUnknown.length > 0 ? (
        <p className="gold-help" data-testid="gold-held-value-unknown">
          {valueUnknown.length === 1 ? '1 month’s value is unknown.' : `${valueUnknown.length} months’ values are unknown.`}
          {valueWhy ? ` ${valueWhy.charAt(0).toUpperCase()}${valueWhy.slice(1)}.` : ''}
        </p>
      ) : null}
      {partial > 0 ? <p className="gold-help">{plural(partial, 'month is', 'months are')} partial; each point says why.</p> : null}
      {unresolved ? <p className="gold-help" data-testid="gold-held-chart-unresolved">{unresolved}</p> : null}
    </section>
  );
}
