import { useEffect, useMemo, useState } from 'react';
import { formatShownAmount, type Transaction } from '@finance-tracker/shared';

import { getCachedSymbolHistory } from '../services/symbolHistoryCache';
import { TradeTooltip } from './TradeTooltip';

interface HistoryPoint {
  t: string;
  close: number;
}

interface HistoryResponse {
  supported: boolean;
  points: HistoryPoint[];
}

interface Props {
  symbol: string;
  transactions: Transaction[];
  range?: '3M' | '1Y';
  /** The price's currency: a change that reads zero at its cents draws in neither colour. */
  currency?: string;
}

export function Sparkline({ symbol, transactions, range = '3M', currency = 'USD' }: Props) {
  const [points, setPoints] = useState<HistoryPoint[]>([]);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState(false);
  const [hoveredMarker, setHoveredMarker] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    getCachedSymbolHistory<HistoryResponse>(symbol, range)
      .then((res) => {
        if (cancelled) return;
        setSupported(res.supported);
        setPoints(res.supported ? res.points : []);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => { cancelled = true; };
  }, [symbol, range]);

  const model = useMemo(() => buildSparkline(points, transactions), [points, transactions]);
  // The line's colour follows its net change (last close minus first) as the price shows it: neither colour when that
  // reads zero, a flat price such as a money-market fund's.
  const tone = useMemo(() => {
    const closes = points.map((p) => p.close).filter((close) => Number.isFinite(close));
    return closes.length < 2 ? 'neutral' : formatShownAmount(closes[closes.length - 1] - closes[0], { currency }).tone;
  }, [points, currency]);

  if (error || !supported || !model) {
    return <span className="sparkline sparkline-empty" aria-hidden />;
  }

  return (
    <span className="sparkline-wrap">
      <svg
        className={`sparkline ${tone === 'gain' ? 'positive' : tone === 'loss' ? 'negative' : 'neutral'}`}
        viewBox="0 0 96 28"
        role="img"
        aria-label={`${symbol} ${range} sparkline with trade markers`}
      >
        <path d={model.path} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        {model.markers.map((m, i) => (
          <g
            key={`${m.transactions.map((t) => t.id).join('|')}-${i}`}
            className="spark-marker-group"
            tabIndex={0}
            aria-label={m.transactions.length > 1 ? `${m.transactions.length} ${symbol} trades on ${m.transactions[0].date}` : `${m.kind === 'buy' ? 'Buy' : 'Sell'} ${Math.abs(m.transactions[0].quantity)} ${symbol} at ${m.transactions[0].pricePerUnit} on ${m.transactions[0].date}`}
            onPointerEnter={() => setHoveredMarker(i)}
            onPointerLeave={() => setHoveredMarker(null)}
            onFocus={() => setHoveredMarker(i)}
            onBlur={() => setHoveredMarker(null)}
          >
            <circle
              className={m.kind === 'buy' ? 'spark-buy' : m.kind === 'sell' ? 'spark-sell' : 'spark-mixed'}
              cx={m.x}
              cy={m.y}
              r={m.transactions.length > 1 ? 3.2 : 2.4}
            />
            {m.transactions.length > 1 ? (
              <text className="spark-count" x={m.x} y={m.y + 0.2} textAnchor="middle" dominantBaseline="middle">
                {m.transactions.length}
              </text>
            ) : null}
          </g>
        ))}
      </svg>
      {hoveredMarker != null && model.markers[hoveredMarker] ? (
        <span
          className="sparkline-tooltip"
          style={{ left: `${model.markers[hoveredMarker].x}px`, top: `${model.markers[hoveredMarker].y}px` }}
        >
          <TradeTooltip transactions={model.markers[hoveredMarker].transactions} compact />
        </span>
      ) : null}
    </span>
  );
}

function buildSparkline(points: HistoryPoint[], transactions: Transaction[]) {
  const clean = points.filter((p) => Number.isFinite(p.close));
  if (clean.length < 2) return null;
  const width = 96;
  const height = 28;
  const pad = 3;
  const closes = clean.map((p) => p.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const xFor = (idx: number) => pad + (idx / (clean.length - 1)) * (width - pad * 2);
  const yFor = (value: number) => pad + (1 - (value - min) / span) * (height - pad * 2);
  const path = clean
    .map((p, idx) => `${idx === 0 ? 'M' : 'L'}${xFor(idx).toFixed(2)},${yFor(p.close).toFixed(2)}`)
    .join(' ');
  const rawMarkers = transactions
    .filter((t) => clean.some((p) => p.t >= t.date))
    .slice(-10)
    .map((t) => {
      const idx = nearestPointIndex(clean, t.date);
      return {
        idx,
        transaction: t,
        x: xFor(idx),
        y: yFor(clean[idx].close),
      };
    });
  const grouped = new Map<number, typeof rawMarkers>();
  for (const marker of rawMarkers) {
    const list = grouped.get(marker.idx) ?? [];
    list.push(marker);
    grouped.set(marker.idx, list);
  }
  const markers = Array.from(grouped.values()).map((group) => {
    const transactions = group.map((g) => g.transaction);
    const hasBuy = transactions.some((t) => t.quantity > 0);
    const hasSell = transactions.some((t) => t.quantity < 0);
    return {
      kind: hasBuy && hasSell ? 'mixed' as const : hasBuy ? 'buy' as const : 'sell' as const,
      transactions,
      x: group[0].x,
      y: group[0].y,
    };
  });
  return {
    path,
    positive: clean[clean.length - 1].close >= clean[0].close,
    markers,
  };
}

function nearestPointIndex(points: HistoryPoint[], date: string): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  const target = Date.parse(`${date}T12:00:00Z`);
  for (let i = 0; i < points.length; i++) {
    const d = Math.abs(Date.parse(`${points[i].t}T12:00:00Z`) - target);
    if (d < bestDistance) {
      best = i;
      bestDistance = d;
    }
  }
  return best;
}
