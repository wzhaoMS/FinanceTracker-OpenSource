import { Fragment, useMemo, useState } from 'react';
import {
  dayChangeDisplayBasis,
  formatCurrency,
  formatGainLoss,
  formatOptionSymbol,
  formatPercent,
  parseOccSymbol,
  summarizeBySymbol,
  type GainLossTone,
  type SymbolRow,
} from '@finance-tracker/shared';
import type { Account, Quote, Transaction } from '@finance-tracker/shared';

import { DayChangeCell } from './DayChangeCell';
import { RollingNumber } from './RollingNumber';
import { Sparkline } from './Sparkline';
import { SymbolChart } from './SymbolChart';
import type { DayChangeMode } from '../hooks/usePortfolioPref';
import { useScrollShadow } from '../hooks/useScrollShadow';
import { ChevronRight, ChevronDown, LineChart, Trend } from './icons';
import './portfolio.css';

interface Props {
  accounts: Account[];
  transactions: Transaction[];
  quotes: Quote[];
  dayChangeMode: DayChangeMode;
  onDayChangeModeChange: (mode: DayChangeMode) => void;
  /** When true, covered rows are priced off non-official overnight estimates; those rows say so under their symbol. */
  indicativeActive?: boolean;
  /** Uppercased symbols that carry an overnight estimate (the substituted ones). */
  coveredSymbols?: Set<string>;
}

type SortKey = 'marketValue' | 'symbol' | 'unrealizedPnL' | 'pctOfTotal';

const SORT_LABELS: Record<SortKey, string> = {
  marketValue: 'Market value',
  symbol: 'Symbol',
  unrealizedPnL: 'Gain/loss',
  pctOfTotal: '% of total',
};

const CASH_KEY = '__cash__';

function sortRows(rows: SymbolRow[], key: SortKey): SymbolRow[] {
  const out = rows.slice();
  out.sort((a, b) => {
    if (key === 'symbol') return a.symbol.localeCompare(b.symbol);
    return (b[key] as number) - (a[key] as number);
  });
  return out;
}

function holdingBadges(row: SymbolRow): Array<{ label: string; tone: 'theme' | 'alt'; title: string }> {
  if (row.symbol === 'Cash') return [];
  const symbol = row.symbol.toUpperCase();
  const badges: Array<{ label: string; tone: 'theme' | 'alt'; title: string }> = [];
  if (['NBIS', 'NVDA', 'GOOGL', 'MSFT', 'AMZN', 'PLTR', 'CRWV', 'TSM', 'AVGO', 'ASML', 'ANET', 'VRT'].includes(symbol)) {
    badges.push({ label: 'AI compute', tone: 'theme', title: 'AI compute / software / infrastructure exposure' });
  }
  if (['CEG', 'VST', 'NEE', 'BE'].includes(symbol)) {
    badges.push({ label: 'AI power', tone: 'theme', title: 'Power-generation exposure tied to AI data-center demand' });
  }
  if (['FBTC', 'BTC', 'BTC-USD', 'CLSK', 'MSTR'].includes(symbol)) {
    badges.push({ label: 'Crypto', tone: 'alt', title: 'Crypto or bitcoin-linked exposure' });
  }
  return badges;
}

const PRICE_TIME = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function priceTime(ms: number): string {
  return Number.isFinite(ms) && ms > 0 ? ` · ${PRICE_TIME.format(new Date(ms))}` : '';
}

/**
 * Why a holding's price is not a current official one, in words, or null when it is. Missing prices are never
 * read as zero; stale and overnight prices carry the time they were taken.
 */
function priceNote(quote: Quote | undefined, overnight: boolean): { kind: 'missing' | 'stale' | 'overnight'; text: string } | null {
  if (!quote) return { kind: 'missing', text: 'Price unavailable' };
  if (overnight && quote.indicative && quote.indicative.price > 0) {
    return { kind: 'overnight', text: `Estimated price · overnight, not official${priceTime(quote.indicative.asOf)}` };
  }
  if (quote.freshness === 'stale') return { kind: 'stale', text: `Stale price${priceTime(quote.asOf)}` };
  return null;
}

/** The note under a holding's symbol when its price is missing, stale or an overnight estimate; nothing otherwise. */
export function PriceStateNote({ quote, overnight }: { quote: Quote | undefined; overnight: boolean }) {
  const note = priceNote(quote, overnight);
  return note ? <span className={`holding-price-note ${note.kind}`}>{note.text}</span> : null;
}

/**
 * A gain or loss on invested positions with its percent: "↑$1,234.56 (12.34%)". The percent is the summary's one
 * positions-only percent (cash left out); this only formats it, through the shared formatGainLoss. An unknown percent
 * reads "(—)" with its reason, never 0%: callers show no gain/loss at all when a price is missing, so here it is unknown
 * because the positions cost nothing. A zero reads "$0.00 (0.00%)" in neither colour and without an arrow.
 */
export function GainLoss({ value, percent, currency }: { value: number; percent: number | null; currency?: string }) {
  const shown = formatGainLoss(value, percent, { currency });
  return (
    <>
      <span className={gainLossClass(shown.tone)}>
        <Trend value={gainLossArrow(shown.tone)} />
        {shown.amount} ({shown.percent})
      </span>
      <PercentUnknownNote percent={percent} />
    </>
  );
}

/** A gain/loss tone's class: the gain or loss colour, or for a zero a colourless one that keeps the figures' type. */
export function gainLossClass(tone: GainLossTone): string {
  return tone === 'neutral' ? 'gl-zero' : tone;
}

/** A gain/loss tone's arrow, as Trend draws it: up for a gain, down for a loss, none for a zero. */
export function gainLossArrow(tone: GainLossTone): number {
  return tone === 'gain' ? 1 : tone === 'loss' ? -1 : 0;
}

/** Why a priced holding's gain/loss percent is unknown, in words: it cost nothing, so there is no base. */
export function PercentUnknownNote({ percent }: { percent: number | null }) {
  return percent == null ? <span className="gl-percent-unknown">Percent unknown: no cost basis</span> : null;
}

/**
 * Combined holdings by asset. Aggregates positions across all in-scope accounts so the user sees one row per
 * ticker, then breaks down which accounts contribute to that row on demand.
 *
 * Desktop keeps every column, aligned for comparison. Phones show the symbol, its price with the day's change
 * under it (the change is the price's), and its value; each holding's Details (its button, or a tap on the row) open
 * the rest: quantity, cost, gain/loss, share, the chart and the accounts that hold it.
 *
 * Cash is included in the total-value math and rendered as a dedicated row with per-account contributors so it
 * never silently disappears from the allocation picture.
 */
export function CombinedHoldings({
  accounts,
  transactions,
  quotes,
  dayChangeMode,
  onDayChangeModeChange,
  indicativeActive = false,
  coveredSymbols,
}: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('marketValue');
  const [openDetails, setOpenDetails] = useState<Set<string>>(() => new Set());
  const [openCharts, setOpenCharts] = useState<Set<string>>(() => new Set());
  const scrollShadow = useScrollShadow<HTMLDivElement>();

  const summary = useMemo(
    () => summarizeBySymbol(accounts, transactions, quotes),
    [accounts, transactions, quotes],
  );
  const quoteBySymbol = useMemo(() => new Map(quotes.map((quote) => [quote.symbol, quote])), [quotes]);
  const transactionsBySymbol = useMemo(() => {
    const map = new Map<string, Transaction[]>();
    for (const t of transactions) {
      const arr = map.get(t.symbol) ?? [];
      arr.push(t);
      map.set(t.symbol, arr);
    }
    return map;
  }, [transactions]);

  // When the household holds positions but any one of them is missing a quote, the total is unknown: no
  // confident dollar figure, and no share of it (never "0.00%").
  const quotesUnavailable = !summary.valueAvailable;

  if (accounts.length === 0) return null;

  const rows = sortRows(summary.rows, sortKey);
  // Round 3 (3.A4): when every position-row's day change is unavailable (markets closed and no extended-hours
  // quote), the Day column is just a stripe of dashes. Hide it entirely then (and its line under the price on phones).
  const hasAnyDayChange = rows.some(
    (r) => r.dayChange != null && r.dayChangePercent != null,
  );
  const columnCount = hasAnyDayChange ? 9 : 8;
  // Round 4 (4.A1): positions-only totals so the big number on this card doesn't duplicate the portfolio value
  // above the chart. Gain/loss on cash is 0 by construction (cost == market), so only the cost changes; the percent is
  // the summary's own positions-only one, the same as the household's above.
  const positionsMarketValue = summary.totalMarketValue - summary.cash.total;
  const positionsCostBasis = summary.totalCostBasis - summary.cash.total;
  const missingCount = summary.missingQuotes.length;
  const flip = (setter: typeof setOpenDetails, key: string) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleDetails = (key: string) => flip(setOpenDetails, key);
  const toggleChart = (key: string) => flip(setOpenCharts, key);
  const shareOfTotal = (row: SymbolRow) => (
    summary.valueAvailable && !row.missingQuote
      ? formatPercent(row.pctOfTotal, 2, false)
      : <span className="muted">—</span>
  );

  return (
    <section className="account combined">
      <header className="account-header">
        <div>
          <div className="account-name">Invested holdings</div>
          {/*
            Sprint 1 reconciliation: relabelled from "Holdings" so the gap between this card and the portfolio value
            above reads as expected (the portfolio includes cash; this card excludes it).
          */}
          <div className="muted account-meta">
            {accounts.length} account{accounts.length === 1 ? '' : 's'} · excludes cash
          </div>
          {indicativeActive && coveredSymbols && coveredSymbols.size > 0 ? (
            <p className="holdings-overnight-note">
              {coveredSymbols.size} holding{coveredSymbols.size === 1 ? ' uses an estimated overnight price' : 's use estimated overnight prices'},
              not official. The rest use their last official price.
            </p>
          ) : null}
        </div>
        <div className="account-totals">
          {quotesUnavailable ? (
            <>
              <div className="account-value muted">—</div>
              <div className="holdings-total-note">
                Price unavailable for {missingCount} holding{missingCount === 1 ? '' : 's'}
              </div>
              <div className="muted">Cost basis {formatCurrency(positionsCostBasis)}</div>
            </>
          ) : (
            <>
              <div className="account-value">{formatCurrency(positionsMarketValue)}</div>
              {summary.rows.length > 0 ? (
                <div className="holdings-total-gain">
                  <span className="holdings-total-label">Gain/loss on invested positions (excludes cash)</span>{' '}
                  <GainLoss value={summary.totalUnrealizedPnL} percent={summary.positionsUnrealizedPnLPercent} />
                </div>
              ) : null}
              <div className="muted">Cost basis {formatCurrency(positionsCostBasis)}</div>
            </>
          )}
        </div>
      </header>

      <div className="combined-toolbar">
        {/* Sprint 1: two segmented controls on one dark surface, brighter active fill, no underlines. */}
        <div className="segmented" role="group" aria-label="Sort holdings by">
          <span className="segmented-label">Sort</span>
          {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
            <button
              key={k}
              type="button"
              className={`seg ${sortKey === k ? 'on' : ''}`}
              aria-pressed={sortKey === k}
              onClick={() => setSortKey(k)}
            >
              {SORT_LABELS[k]}
            </button>
          ))}
        </div>
        <span className="combined-toolbar-spacer" />
        {hasAnyDayChange ? (
          <div className="segmented day-change-toggle" role="group" aria-label="Show day change in">
            <span className="segmented-label">Day change</span>
            <button
              type="button"
              className={`seg ${dayChangeMode === 'absolute' ? 'on' : ''}`}
              aria-pressed={dayChangeMode === 'absolute'}
              onClick={() => onDayChangeModeChange('absolute')}
            >Dollars</button>
            <button
              type="button"
              className={`seg ${dayChangeMode === 'percent' ? 'on' : ''}`}
              aria-pressed={dayChangeMode === 'percent'}
              onClick={() => onDayChangeModeChange('percent')}
            >Percent</button>
          </div>
        ) : null}
      </div>
      <p className="holdings-phone-hint">Tap a holding for its quantity, cost, gain/loss, chart and accounts.</p>

      <div
        ref={scrollShadow.ref}
        className={`holdings-scroll${scrollShadow.scrolled ? ' is-scrolled' : ''}`}
      >
      <table className="holdings">
        <thead>
          <tr>
            <th className="col-sym">Symbol</th>
            <th className="trend-col col-trend">Trend</th>
            <th className="num col-qty">Quantity</th>
            <th className="num col-avg">Avg cost</th>
            <th className="num col-price">Price</th>
            {hasAnyDayChange ? <th className="num col-day">Day change</th> : null}
            <th className="num col-value">Market value</th>
            <th className="num col-gl">Gain/loss <span className="holdings-head-sub">(excludes cash)</span></th>
            <th className="num col-pct">% of total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const detailsOpen = openDetails.has(row.symbol);
            const chartOpen = openCharts.has(row.symbol);
            const accountIdToName = new Map(row.contributors.map((c) => [c.accountId, c.accountName]));
            const isOption = row.instrumentType === 'option';
            const optionContract = isOption ? parseOccSymbol(row.symbol) : null;
            const optionSide = row.quantity < 0 ? 'Short' : row.quantity > 0 ? 'Long' : 'Offsetting';
            const optionKind = optionContract?.optionType ?? 'option';
            const grossOptionContracts = row.contributors.reduce(
              (total, contributor) => total + Math.abs(contributor.quantity),
              0,
            );
            const exerciseNotional = optionContract
              ? grossOptionContracts * (row.contractMultiplier ?? 1) * optionContract.strikePrice
              : null;
            const label = isOption ? formatOptionSymbol(row.symbol) : row.symbol;
            const overnight = indicativeActive && !!coveredSymbols?.has(row.symbol.toUpperCase());
            const quantity = row.quantity.toLocaleString(undefined, { maximumFractionDigits: 4 });
            const shown = formatGainLoss(row.unrealizedPnL, row.unrealizedPnLPercent, { currency: row.currency });
            const gainLoss = row.missingQuote
              ? <span className="muted">—</span>
              : <>
                  <Trend value={gainLossArrow(shown.tone)} />
                  {shown.amount} ({shown.percent})
                  <PercentUnknownNote percent={row.unrealizedPnLPercent} />
                </>;
            const chartButton = (where: 'row' | 'details') => (
              <button
                type="button"
                className={`chart-toggle ${chartOpen ? 'active' : ''}${where === 'details' ? ' holding-details-chart' : ''}`}
                aria-pressed={chartOpen}
                aria-label={`Show ${row.symbol} price chart`}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleChart(row.symbol);
                }}
              >
                <LineChart size={14} />
                <span className="mobile-chart-label">Chart</span>
              </button>
            );
            return (
              <Fragment key={row.symbol}>
                <tr
                  onClick={(e) => {
                    const target = e.target as HTMLElement;
                    if (target.closest('button, a, input, .trend-cell, .holding-chart-controls, .sparkline-wrap')) return;
                    toggleDetails(row.symbol);
                  }}
                  className={`holding-row${detailsOpen ? ' expanded' : ''}`}
                  style={{ cursor: 'pointer' }}
                >
                  <td className="sym col-sym">
                    <span className="holding-symbol-main">
                      <button
                        type="button"
                        className="holding-toggle"
                        aria-expanded={detailsOpen}
                        onClick={() => toggleDetails(row.symbol)}
                      >
                        <span className="disclosure" aria-hidden>
                          {detailsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        </span>
                        <span className="holding-symbol">{label}</span>
                        <span className="visually-hidden"> details</span>
                      </button>
                      <span className="holding-badges">
                        {isOption ? (
                          <span className="holding-badge alt" title={`${optionSide} ${optionKind} option position`}>
                            {optionSide} {optionKind}
                          </span>
                        ) : null}
                        {holdingBadges(row).map((badge) => (
                          <span key={`${row.symbol}-${badge.label}`} className={`holding-badge ${badge.tone}`} title={badge.title}>
                            {badge.label}
                          </span>
                        ))}
                      </span>
                    </span>
                    <PriceStateNote quote={quoteBySymbol.get(row.symbol)} overnight={overnight} />
                  </td>
                  <td
                    className="trend-cell col-trend"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!isOption) toggleChart(row.symbol);
                    }}
                  >
                    {isOption ? (
                      <span className="muted option-mark-label">Delayed mark</span>
                    ) : (
                      <span className="holding-chart-controls">
                        {chartButton('row')}
                        {!row.missingQuote ? (
                          <Sparkline symbol={row.symbol} transactions={transactionsBySymbol.get(row.symbol) ?? []} currency={row.currency} />
                        ) : null}
                      </span>
                    )}
                  </td>
                  <td className="num col-qty">
                    {quantity}
                    {isOption ? (
                      <span className="option-cell-label">
                        {row.quantity === 0 ? ' net contracts' : ' contracts'}
                      </span>
                    ) : null}
                  </td>
                  <td className="num col-avg">
                    {row.averageCost > 0 ? formatCurrency(row.averageCost, row.currency) : '—'}
                    {isOption ? <span className="option-cell-label">Avg {row.quantity < 0 ? 'credit' : 'debit'}</span> : null}
                  </td>
                  <td className="num col-price">
                    {row.marketPrice != null ? (
                      <>
                        <RollingNumber
                          value={row.marketPrice}
                          format={(v) => formatCurrency(v, row.currency)}
                          flash
                        />
                        {isOption ? <span className="option-cell-label">Delayed mark</span> : null}
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                    {hasAnyDayChange ? (
                      // Phones: the day change is the price's, so it sits under the price (its own column on wider screens).
                      <span className="price-day-change">
                        <DayChangeCell
                          changeBasis={dayChangeDisplayBasis(row)}
                          dayChange={row.dayChange}
                          dayChangePercent={row.dayChangePercent}
                          mode={dayChangeMode}
                          currency={row.currency}
                          session={row.session}
                        />
                      </span>
                    ) : null}
                  </td>
                  {hasAnyDayChange ? (
                    <td className="num col-day">
                      <DayChangeCell
                        changeBasis={dayChangeDisplayBasis(row)}
                        dayChange={row.dayChange}
                        dayChangePercent={row.dayChangePercent}
                        mode={dayChangeMode}
                        currency={row.currency}
                        session={row.session}
                      />
                    </td>
                  ) : null}
                  <td className="num col-value">
                    {row.missingQuote ? (
                      <span className="muted">—</span>
                    ) : (
                      <RollingNumber
                        value={row.marketValue}
                        format={(v) => formatCurrency(v, row.currency)}
                        flash
                      />
                    )}
                    {isOption && exerciseNotional != null ? (
                      <span className="option-cell-label">
                        {formatCurrency(exerciseNotional, row.currency)}{row.quantity === 0 ? ' gross' : ''} exercise notional
                      </span>
                    ) : null}
                  </td>
                  <td className={`num col-gl ${row.missingQuote ? 'muted' : gainLossClass(shown.tone)}`}>
                    {gainLoss}
                  </td>
                  <td className="num col-pct">{shareOfTotal(row)}</td>
                </tr>
                {detailsOpen ? (
                  <tr className="holding-details-row">
                    <td colSpan={columnCount}>
                      <dl className="holding-details">
                        <div>
                          <dt>Quantity</dt>
                          <dd>{quantity}{isOption ? ' contracts' : ''}</dd>
                        </div>
                        <div>
                          <dt>{isOption ? `Avg ${row.quantity < 0 ? 'credit' : 'debit'}` : 'Avg cost'}</dt>
                          <dd>{row.averageCost > 0 ? formatCurrency(row.averageCost, row.currency) : '—'}</dd>
                        </div>
                        <div className="holding-details-gl">
                          <dt>Gain/loss (excludes cash)</dt>
                          <dd className={row.missingQuote ? 'muted' : gainLossClass(shown.tone)}>{gainLoss}</dd>
                        </div>
                        <div>
                          <dt>% of total</dt>
                          <dd>{shareOfTotal(row)}</dd>
                        </div>
                        {isOption && exerciseNotional != null ? (
                          <div>
                            <dt>Exercise notional</dt>
                            <dd>{formatCurrency(exerciseNotional, row.currency)}</dd>
                          </div>
                        ) : null}
                      </dl>
                      {!isOption ? chartButton('details') : null}
                    </td>
                  </tr>
                ) : null}
                {detailsOpen ? (
                  /*
                   * Held-in rows (Round 4 polish): each contributor is a real <tr> mirroring the parent's columns
                   * so numbers line up under the parent row; the first cell carries a brand-soft left rail.
                   */
                  row.contributors.map((c, i) => {
                    const perAcctAvg =
                      c.quantity !== 0 ? c.costBasis / c.quantity : 0;
                    const pctOfRow =
                      row.marketValue > 0
                        ? (c.marketValue / row.marketValue) * 100
                        : 0;
                    const contributorQuantity = c.quantity.toLocaleString(undefined, { maximumFractionDigits: 4 });
                    const contributorShown = formatGainLoss(c.unrealizedPnL, c.unrealizedPnLPercent, { currency: row.currency });
                    return (
                      <tr
                        key={c.accountId}
                        className={`contributor-row${i === 0 ? ' contributor-first' : ''}${i === row.contributors.length - 1 ? ' contributor-last' : ''}`}
                      >
                        <td className="sym contributor-name-cell col-sym">
                          <span className="contributor-rail" aria-hidden />
                          <span className="contributor-name">{c.accountName}</span>
                          <span className="contributor-quantity">Quantity {contributorQuantity}</span>
                        </td>
                        <td className="trend-cell col-trend" />
                        <td className="num col-qty">{contributorQuantity}</td>
                        <td className="num col-avg">
                          {perAcctAvg > 0 ? formatCurrency(perAcctAvg, row.currency) : '—'}
                        </td>
                        <td className="num col-price" />
                        {hasAnyDayChange ? <td className="num col-day" /> : null}
                        <td className="num col-value">
                          {row.missingQuote ? <span className="muted">—</span> : formatCurrency(c.marketValue, row.currency)}
                        </td>
                        <td className={`num col-gl ${gainLossClass(contributorShown.tone)}`}>
                          {row.missingQuote
                            ? '—'
                            : <>
                                {contributorShown.amount}
                                {' '}
                                <span className="muted-pct">
                                  ({contributorShown.percent})
                                </span>
                                <PercentUnknownNote percent={c.unrealizedPnLPercent} />
                              </>}
                        </td>
                        <td className="num muted col-pct">
                          {row.contributors.length > 1 && !row.missingQuote
                            ? formatPercent(pctOfRow, 1, false)
                            : ''}
                        </td>
                      </tr>
                    );
                  })
                ) : null}
                {chartOpen && !isOption ? (
                  <tr className="chart-row">
                    <td colSpan={columnCount}>
                      <SymbolChart
                        symbol={row.symbol}
                        currentPrice={row.marketPrice ?? undefined}
                        dayChange={row.dayChange}
                        dayChangePercent={row.dayChangePercent}
                        changeBasis={row.changeBasis}
                        freshness={row.freshness}
                        session={row.session}
                        currency={row.currency}
                        transactions={transactionsBySymbol.get(row.symbol) ?? []}
                        accountIdToName={accountIdToName}
                      />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}

          {summary.cash.total !== 0 ? (
            <Fragment key={CASH_KEY}>
              <tr
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest('button')) return;
                  toggleDetails(CASH_KEY);
                }}
                className={`holding-row cash-row${openDetails.has(CASH_KEY) ? ' expanded' : ''}`}
                style={{ cursor: 'pointer' }}
              >
                <td className="sym col-sym">
                  <button
                    type="button"
                    className="holding-toggle"
                    aria-expanded={openDetails.has(CASH_KEY)}
                    onClick={() => toggleDetails(CASH_KEY)}
                  >
                    <span className="disclosure" aria-hidden>
                      {openDetails.has(CASH_KEY) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </span>
                    <span className="holding-symbol">Cash</span>
                    <span className="visually-hidden"> details</span>
                  </button>
                </td>
                <td className="trend-cell col-trend" />
                <td className="num col-qty">—</td>
                <td className="num col-avg">—</td>
                <td className="num col-price">—</td>
                {hasAnyDayChange ? <td className="num col-day">—</td> : null}
                <td className="num col-value">{formatCurrency(summary.cash.total)}</td>
                <td className="num col-gl">—</td>
                <td className="num col-pct">
                  {summary.valueAvailable ? formatPercent(summary.cash.pctOfTotal, 2, false) : <span className="muted">—</span>}
                </td>
              </tr>
              {openDetails.has(CASH_KEY) ? (
                /*
                 * Cash contributors mirror the parent column structure the same way symbol contributors do: the
                 * Symbol cell carries the account name and rail, Market value the amount, and (for more than one
                 * contributor) % of total its share of the cash.
                 */
                summary.cash.contributors.map((c, i) => {
                  const pctOfCash =
                    summary.cash.total > 0
                      ? (c.amount / summary.cash.total) * 100
                      : 0;
                  return (
                    <tr
                      key={c.accountId}
                      className={`contributor-row${i === 0 ? ' contributor-first' : ''}${i === summary.cash.contributors.length - 1 ? ' contributor-last' : ''}`}
                    >
                      <td className="sym contributor-name-cell col-sym">
                        <span className="contributor-rail" aria-hidden />
                        <span className="contributor-name">{c.accountName}</span>
                      </td>
                      <td className="trend-cell col-trend" />
                      <td className="num col-qty" />
                      <td className="num col-avg" />
                      <td className="num col-price" />
                      {hasAnyDayChange ? <td className="num col-day" /> : null}
                      <td className="num col-value">{formatCurrency(c.amount)}</td>
                      <td className="num col-gl" />
                      <td className="num muted col-pct">
                        {summary.cash.contributors.length > 1
                          ? formatPercent(pctOfCash, 1, false)
                          : ''}
                      </td>
                    </tr>
                  );
                })
              ) : null}
            </Fragment>
          ) : null}
        </tbody>
      </table>
      </div>
    </section>
  );
}
