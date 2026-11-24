import { useId, useMemo, useState } from 'react';
import { formatShownPercent } from '@finance-tracker/shared';
import type { IndicativeQuote, Quote } from '@finance-tracker/shared';

import type { IndicativeMode } from '../hooks/usePortfolioPref';
import { ChevronRight, ChevronDown } from './icons';
import { withTone } from './tone';
import './portfolio.css';

interface Props {
  quotes: Quote[];
  /** Overlay preference (persisted by the parent). */
  mode: IndicativeMode;
  onModeChange: (mode: IndicativeMode) => void;
  /** True when the overlay is actually folded into the holdings/value math. */
  active: boolean;
  /** Count of held symbols with a real official price (denominator). */
  pricedCount: number;
}

interface Row {
  symbol: string;
  ind: IndicativeQuote;
}

const SOURCE_LABEL: Record<IndicativeQuote['source'], string> = {
  'hyperliquid-perp': 'Hyperliquid perp',
  'btc-proxy': 'BTC proxy',
};

const CONFIDENCE_LABEL: Record<IndicativeQuote['confidence'], string | null> = {
  ok: null,
  thin: 'Thin trading',
  dislocated: 'Far from last close',
};

const AS_OF = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function money(value: number): string {
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Overnight / weekend estimated prices: a deliberately quiet panel, folded by default. It exists to satisfy
 * curiosity about where holdings are drifting while the US market is closed, NOT to drive decisions: these are
 * perpetual-futures and bitcoin-proxy prices, never official, and they touch no value or total unless the owner
 * turns on "Use overnight prices".
 *
 *   - Renders nothing while official markets are live (no quote carries `.indicative` then).
 *   - The header says what they are ("estimated, not official") without opening anything; the body is opt-in.
 *   - The body explains the sources and carries the "not a valuation, not a trade signal" caution.
 */
export function IndicativePanel({ quotes, mode, onModeChange, active, pricedCount }: Props) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const q of quotes) {
      if (q.indicative) out.push({ symbol: q.symbol, ind: q.indicative });
    }
    // Largest absolute drift first — but this is just ordering, not emphasis.
    out.sort((a, b) => Math.abs(b.ind.premiumPct) - Math.abs(a.ind.premiumPct));
    return out;
  }, [quotes]);

  // While markets are live, nothing is indicative → render nothing.
  if (rows.length === 0) return null;

  const dislocated = rows.filter((r) => r.ind.confidence === 'dislocated').length;
  const on = mode === 'on';
  const effectId = `${bodyId}-effect`;

  return (
    <section className="indicative-panel" aria-label="Overnight prices">
      <div className="indicative-header">
        <button
          type="button"
          className="indicative-disclosure"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
        >
          <span aria-hidden className="indicative-chevron">
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
          <span className="indicative-title">Overnight prices</span>
          <span className="indicative-tag">Estimated · not official</span>
          <span className="indicative-count">
            {rows.length} of {pricedCount} holdings
            {dislocated > 0 ? <span className="loss"> · {dislocated} far from last close</span> : null}
          </span>
        </button>

        {/* Folds the overnight estimates into the holdings card and the portfolio value above. Off by default;
            display only: cost basis, history and snapshots never change. */}
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-describedby={effectId}
          className={`indicative-switch${on ? ' on' : ''}`}
          onClick={() => onModeChange(on ? 'off' : 'on')}
        >
          <span className="indicative-switch-label">Use overnight prices</span>
          <span aria-hidden className="indicative-switch-track">
            <span className="indicative-switch-thumb" />
          </span>
        </button>
        {/* What the switch changes, in words beside it: never only in a tooltip. */}
        <p className="indicative-effect" id={effectId}>
          {on
            ? 'On: your holdings and portfolio value include these estimates.'
            : 'Off: your holdings and portfolio value use official prices only.'}
        </p>
      </div>

      {open ? (
        <div className="indicative-body" id={bodyId}>
          <p className="indicative-explainer">
            Estimated prices while the US market is closed: Hyperliquid equity perpetuals (priced in USDC, on an
            anonymous third-party venue) and a spot-bitcoin proxy for bitcoin ETFs.
          </p>
          <p className="indicative-explainer">
            They echo the last close plus crypto traders&rsquo; positioning: <strong>not a valuation</strong>, and not
            a trade signal.
          </p>
          <p className="indicative-explainer">
            {active
              ? <>Now used in your holdings and portfolio value above, for display only: cost basis, history and
                  snapshots are unchanged. Don&rsquo;t act on them before the open.</>
              : <>Left out of every total, gain/loss and chart unless you turn on &ldquo;Use overnight prices&rdquo;.</>}
          </p>
          <div className="indicative-table-wrap">
            <table className="indicative-table" role="table">
              <thead role="rowgroup">
                <tr role="row">
                  <th scope="col" role="columnheader">Symbol</th>
                  <th scope="col" role="columnheader" className="num">Estimated price</th>
                  <th scope="col" role="columnheader" className="num">vs last close</th>
                  <th scope="col" role="columnheader" className="num">Last close</th>
                  <th scope="col" role="columnheader">Source</th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                {rows.map(({ symbol, ind }) => {
                  const caveat = [CONFIDENCE_LABEL[ind.confidence], ind.note].filter(Boolean).join(' · ');
                  // A premium that reads zero is unsigned and in neither colour.
                  const premium = formatShownPercent(ind.premiumPct * 100, { signed: true });
                  return (
                    <tr key={symbol} role="row">
                      <th scope="row" role="rowheader">{symbol}</th>
                      <td className="num" role="cell" data-label="Estimated price">
                        {money(ind.price)}
                        {Number.isFinite(ind.asOf) && ind.asOf > 0
                          ? <span className="indicative-sub">{AS_OF.format(new Date(ind.asOf))}</span>
                          : null}
                      </td>
                      <td className={withTone('num', premium.tone)} role="cell" data-label="vs last close">{premium.text}</td>
                      <td className="num" role="cell" data-label="Last close">{money(ind.baselineClose)}</td>
                      <td role="cell" data-label="Source">
                        <span className="muted">{SOURCE_LABEL[ind.source]}</span>
                        {caveat ? (
                          <span className={`indicative-sub${ind.confidence === 'dislocated' ? ' loss' : ''}`}>{caveat}</span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
