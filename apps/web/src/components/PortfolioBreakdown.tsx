import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  formatCurrency,
  formatGainLoss,
  formatOptionSymbol,
  formatPercent,
  parseOccSymbol,
  summarizeByAccount,
  summarizeBySymbol,
} from '@finance-tracker/shared';
import type { Account, Quote, Transaction } from '@finance-tracker/shared';

import { usePortfolioStore } from '../stores/portfolio';
import { CombinedHoldings, GainLoss, PercentUnknownNote, PriceStateNote, gainLossArrow, gainLossClass } from './CombinedHoldings';
import { IndicativePanel } from './IndicativePanel';
import { PerformancePanel } from './PerformancePanel';
import { PortfolioHistoryChart } from './PortfolioHistoryChart';
import { isDayChangeMode, isIndicativeMode, usePortfolioPref } from '../hooks/usePortfolioPref';
import { LineChart, Trend } from './icons';
import { EmptyState } from './EmptyState';
import { useScrollShadow } from '../hooks/useScrollShadow';
import { formatRoute } from '../modes/route';
import './portfolio.css';

interface Props {
  quotes: Quote[];
}

/**
 * Robinhood-style masked account number for the per-account header:
 * three bullet characters followed by the last 4 alphanumerics. Industry
 * convention is last-4 (matches Fidelity / Schwab / Robinhood), and the
 * `•••` glyph plays well alongside the existing `·` separators in
 * account names like `Alex · Fidelity Individual TOD`.
 *
 * Returns `''` when the account doesn't have a stored number, so the
 * caller can omit the inline separator without a conditional.
 */
function bulletMask(n: string | undefined): string {
  if (!n) return '';
  const clean = n.replace(/[^A-Za-z0-9]/g, '');
  if (!clean) return '';
  return '•••' + clean.slice(-4);
}

/**
 * Return a quotes array where covered symbols have `price` swapped to their
 * non-official overnight `indicative.price`. Pure; returns the original array
 * untouched when disabled or nothing is covered, so referential equality is
 * preserved for memo deps in the common (off) case. The `indicative` block is
 * retained on each quote so downstream UI can still tag the substituted rows.
 */
function applyIndicativePrices(quotes: Quote[], active: boolean): Quote[] {
  if (!active) return quotes;
  let changed = false;
  const next = quotes.map((q) => {
    if (q.indicative && q.indicative.price > 0) {
      changed = true;
      return { ...q, price: q.indicative.price };
    }
    return q;
  });
  return changed ? next : quotes;
}

function holdingsCount(count: number): string {
  return `${count} holding${count === 1 ? '' : 's'}`;
}

/**
 * The Portfolio page, in reading order: the portfolio value and its dated change (the chart card), then the
 * holdings; after them the AI allocation, the overnight prices and Performance; each account's holdings last.
 */
export function PortfolioBreakdown({ quotes }: Props) {
  const accounts = usePortfolioStore((s) => s.accounts);
  const transactions = usePortfolioStore((s) => s.transactions);

  // Single source of truth for "Dollars vs Percent" across the Portfolio tab. Persists
  // per-browser; the toggle UI lives in CombinedHoldings (passed as props).
  const [dayChangeMode, setDayChangeMode] = usePortfolioPref(
    'dayChangeMode',
    'absolute' as const,
    isDayChangeMode,
  );

  // Overnight/weekend estimates. OFF by default. When ON *and* the server actually attached indicative prices
  // (official data is stale: weekend / after-hours), covered holdings are repriced off the non-official estimate
  // for the holdings card AND the portfolio value. Display only: cost basis, transactions, snapshots and the
  // historical chart line are untouched. It auto-no-ops during market hours because `coveredSymbols` is empty
  // when no quote carries `.indicative`.
  const [indicativeMode, setIndicativeMode] = usePortfolioPref(
    'indicativeMode',
    'off' as const,
    isIndicativeMode,
  );
  const coveredSymbols = useMemo(
    () =>
      new Set(
        quotes
          .filter((q) => q.indicative && q.indicative.price > 0)
          .map((q) => q.symbol.toUpperCase()),
      ),
    [quotes],
  );
  const indicativeAvailable = coveredSymbols.size > 0;
  const indicativeActive = indicativeMode === 'on' && indicativeAvailable;
  const pricedCount = useMemo(
    () => quotes.filter((q) => Number.isFinite(q.price) && q.price > 0).length,
    [quotes],
  );
  // Effective quotes feeding ALL value math when the overlay is active.
  const effectiveQuotes = useMemo(
    () => applyIndicativePrices(quotes, indicativeActive),
    [quotes, indicativeActive],
  );
  const quoteBySymbol = useMemo(
    () => new Map(effectiveQuotes.map((quote) => [quote.symbol, quote])),
    [effectiveQuotes],
  );

  // Per-account chart expansion. Set of account IDs whose chart is open.
  // Multiple can be open at once for comparison; charts lazy-mount on toggle
  // because 16 accounts × full chart fetch on every page load would be
  // wasteful and trigger 16 parallel /portfolio/history requests.
  const [openCharts, setOpenCharts] = useState<Set<string>>(() => new Set());
  const toggleChart = (accountId: string) => {
    setOpenCharts((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });
  };

  const summary = useMemo(
    () => summarizeByAccount(accounts, transactions, effectiveQuotes),
    [accounts, transactions, effectiveQuotes],
  );
  const accountIdToName = useMemo(
    () => new Map(accounts.map((a) => [a.id, a.name])),
    [accounts],
  );
  const thesisSummary = useMemo(() => summarizeAiThesis(accounts, transactions, effectiveQuotes), [accounts, transactions, effectiveQuotes]);
  const missingSymbols = useMemo(
    () => [...new Set(summary.accounts.flatMap((account) => account.missingQuotes))],
    [summary],
  );

  // True when the household holds positions and any of them has no quote — typically because the quotes endpoint
  // failed (offline / 5xx). `summarizeByAccount` *excludes* no-quote positions from each account's value, so the
  // total would silently shrink; the value is withheld instead, with the reason.
  const quotesUnavailable = !summary.valueAvailable;
  // Cash alone has no gain or loss to show: the line appears once the household holds a position.
  const householdHasPositions = summary.accounts.some((account) => account.rows.some((row) => row.kind === 'position'));
  const accountCount = `${summary.accounts.length} account${summary.accounts.length === 1 ? '' : 's'}`;

  if (accounts.length === 0) {
    return (
      <EmptyState
        icon={<LineChart size={20} />}
        title="No accounts yet"
        body="Add your first account to start tracking holdings, transactions, and portfolio history."
        actions={[{ label: 'Add account', onAction: () => { window.location.hash = formatRoute({ mode: 'investing', tab: 'accounts' }); } }]}
      />
    );
  }

  return (
    <div className="breakdown">
      {/*
        The chart card leads: the portfolio value, its change over the chosen range with the date it is measured
        from, and (here) whether overnight estimates are in it and the gain or loss on invested positions.
      */}
      <PortfolioHistoryChart
        title={indicativeActive ? 'Portfolio value · includes overnight estimates' : 'Portfolio value'}
        returnTitle="Portfolio return"
        liveValue={quotesUnavailable ? undefined : summary.grandTotalMarketValue}
        valueUnavailable={quotesUnavailable}
        valueUnavailableReason={`Price unavailable for ${holdingsCount(missingSymbols.length)}`}
        transactions={transactions}
        accountIdToName={accountIdToName}
        showPerformance={false}
        headerExtra={
          <>
            {indicativeActive ? (
              <div role="status" className="portfolio-overnight-status">
                <span className="indicative-banner-label">Overnight estimates in use</span>
                <span className="portfolio-overnight-text">
                  {coveredSymbols.size} of {pricedCount} holdings use estimated overnight prices: not official, not a valuation.
                </span>
                <button type="button" className="portfolio-overnight-off" onClick={() => setIndicativeMode('off')}>
                  Use official prices
                </button>
              </div>
            ) : null}
            <div className="portfolio-value-meta">
              {quotesUnavailable || !householdHasPositions ? null : (
                <>
                  <span className="portfolio-value-gl">
                    Gain/loss on invested positions (excludes cash){' '}
                    <GainLoss value={summary.grandTotalUnrealizedPnL} percent={summary.positionsUnrealizedPnLPercent} />
                  </span>
                  <span aria-hidden className="portfolio-value-sep">{' · '}</span>
                </>
              )}
              <span className="portfolio-value-count">{accountCount}</span>
            </div>
          </>
        }
      />

      <CombinedHoldings
        accounts={accounts}
        transactions={transactions}
        quotes={effectiveQuotes}
        dayChangeMode={dayChangeMode}
        onDayChangeModeChange={setDayChangeMode}
        indicativeActive={indicativeActive}
        coveredSymbols={coveredSymbols}
      />

      <AiAllocationPanel summary={thesisSummary} valueAvailable={summary.valueAvailable} missingCount={missingSymbols.length} />

      <IndicativePanel
        quotes={quotes}
        mode={indicativeMode}
        onModeChange={setIndicativeMode}
        active={indicativeActive}
        pricedCount={pricedCount}
      />

      <PerformanceSection />

      {summary.accounts.map((acc) => {
        const a = acc.account;
        const pctOfGrand =
          summary.valueAvailable && acc.valueAvailable && summary.grandTotalMarketValue !== 0
            ? (acc.totalMarketValue / summary.grandTotalMarketValue) * 100
            : 0;
        const chartOpen = openCharts.has(a.id);
        const masked = bulletMask(a.accountNumber);
        const hasPositions = acc.rows.some((row) => row.kind === 'position');
        return (
          <section className="account" key={a.id}>
            <header className="account-header">
              <div>
                <div className="account-name">
                  <span className="account-name-text">{a.name}</span>{' '}
                  <button
                    type="button"
                    className={`chart-toggle ${chartOpen ? 'active' : ''}`}
                    onClick={() => toggleChart(a.id)}
                    title={chartOpen ? 'Hide value chart' : 'Show value chart'}
                    aria-expanded={chartOpen}
                    aria-label={`${chartOpen ? 'Hide' : 'Show'} ${a.name} value chart`}
                  >
                    <LineChart size={14} />
                  </button>
                </div>
                {/*
                  Type + masked number on one muted line, with the same `·` separator the account name itself
                  uses. Falls back to either alone when the other is missing.
                */}
                {a.type || masked ? (
                  <div className="muted account-meta">
                    {a.type ?? ''}
                    {a.type && masked ? ' · ' : ''}
                    {masked ? (
                      <span
                        style={{ fontVariantNumeric: 'tabular-nums' }}
                        title={a.accountNumber ? `Account ${a.accountNumber}` : undefined}
                      >
                        {masked}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <div className="account-totals">
                {acc.valueAvailable ? (
                  <>
                    <div className="account-value">{formatCurrency(acc.totalMarketValue, a.currency)}</div>
                    {hasPositions ? (
                      <div className="account-gl">
                        <span className="account-gl-label">Gain/loss on invested positions (excludes cash)</span>{' '}
                        <GainLoss value={acc.totalUnrealizedPnL} percent={acc.positionsUnrealizedPnLPercent} currency={a.currency} />
                      </div>
                    ) : null}
                    <div className="muted">
                      {summary.valueAvailable
                        ? `${formatPercent(pctOfGrand, 2, false)} of total`
                        : 'Share of total unavailable'}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="account-value muted">—</div>
                    <div className="account-total-note">Price unavailable for {holdingsCount(acc.missingQuotes.length)}</div>
                  </>
                )}
              </div>
            </header>

            {chartOpen ? (
              // Lazy-mount: only fetch & render when the user opens the chart.
              <PortfolioHistoryChart
                accountIds={[a.id]}
                title={a.name}
                liveValue={acc.valueAvailable ? acc.totalMarketValue : undefined}
                valueUnavailable={!acc.valueAvailable}
                valueUnavailableReason={`Price unavailable for ${holdingsCount(acc.missingQuotes.length)}`}
                transactions={transactions.filter((t) => t.accountId === a.id)}
                accountIdToName={accountIdToName}
              />
            ) : null}

            <AccountHoldingsTable acc={acc} a={a} quoteBySymbol={quoteBySymbol} indicativeActive={indicativeActive} />
          </section>
        );
      })}
    </div>
  );
}

/**
 * Performance after the holdings: its heading and a status line render at once; the results mount when the
 * section comes near the screen or receives focus, so a page load doesn't replay the whole ledger and nobody
 * meets an empty section. No click is needed for the results.
 */
function PerformanceSection() {
  const ref = useRef<HTMLElement>(null);
  const headingId = useId();
  const [near, setNear] = useState(() => typeof window === 'undefined' || typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const section = ref.current;
    if (near || !section) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setNear(true);
    }, { rootMargin: '1000px 0px' });
    observer.observe(section);
    return () => observer.disconnect();
  }, [near]);
  return (
    <section
      ref={ref}
      className="performance-card"
      aria-labelledby={headingId}
      tabIndex={-1}
      onFocus={() => setNear(true)}
    >
      <h2 id={headingId} className="performance-card-title">Performance</h2>
      {near
        ? <PerformancePanel showGoal standalone />
        : <p className="performance-status muted" role="status">Loading performance…</p>}
    </section>
  );
}

interface AiThesisSummary {
  total: number;
  aiCompute: number;
  aiPower: number;
  crypto: number;
  cash: number;
  topSymbol: string;
  topPct: number;
}

function summarizeAiThesis(accounts: Account[], transactions: Transaction[], quotes: Quote[]): AiThesisSummary {
  const symbolSummary = summarizeBySymbol(accounts, transactions, quotes);
  const aiComputeSymbols = new Set(['NBIS', 'NVDA', 'GOOGL', 'MSFT', 'AMZN', 'PLTR', 'CRWV', 'TSM', 'AVGO', 'ASML', 'ANET', 'VRT']);
  const aiPowerSymbols = new Set(['CEG', 'VST', 'NEE', 'BE']);
  const cryptoSymbols = new Set(['FBTC', 'BTC', 'BTC-USD', 'CLSK', 'MSTR']);
  let aiCompute = 0;
  let aiPower = 0;
  let crypto = 0;
  let topSymbol = '—';
  let topPct = 0;
  for (const row of symbolSummary.rows) {
    const symbol = row.symbol.toUpperCase();
    if (aiComputeSymbols.has(symbol)) aiCompute += row.marketValue;
    if (aiPowerSymbols.has(symbol)) aiPower += row.marketValue;
    if (cryptoSymbols.has(symbol)) crypto += row.marketValue;
    if (!row.missingQuote && row.pctOfTotal > topPct) {
      topPct = row.pctOfTotal;
      topSymbol = row.symbol;
    }
  }
  return { total: symbolSummary.totalMarketValue, aiCompute, aiPower, crypto, cash: symbolSummary.cash.total, topSymbol, topPct };
}

function AiAllocationPanel({
  summary,
  valueAvailable,
  missingCount,
}: {
  summary: AiThesisSummary;
  valueAvailable: boolean;
  missingCount: number;
}) {
  const pct = (value: number) => summary.total > 0 ? (value / summary.total) * 100 : 0;
  return (
    <section className="ai-thesis-panel" aria-label="AI allocation">
      <div className="ai-thesis-header">
        <div className="ai-thesis-title">AI allocation</div>
      </div>
      {!valueAvailable ? (
        <p className="ai-thesis-unavailable">
          Allocation unavailable: price unavailable for {holdingsCount(missingCount)}.
        </p>
      ) : (
      <div className="ai-thesis-grid">
        <div><span>AI compute</span><strong>{formatPercent(pct(summary.aiCompute), 1, false)}</strong><em>{formatCurrency(summary.aiCompute)}</em></div>
        <div><span>AI power</span><strong>{formatPercent(pct(summary.aiPower), 1, false)}</strong><em>{formatCurrency(summary.aiPower)}</em></div>
        <div><span>Crypto</span><strong>{formatPercent(pct(summary.crypto), 1, false)}</strong><em>{formatCurrency(summary.crypto)}</em></div>
        <div><span>Cash</span><strong>{formatPercent(pct(summary.cash), 1, false)}</strong><em>{formatCurrency(summary.cash)}</em></div>
        <div><span>Largest holding</span><strong>{summary.topSymbol}</strong><em>{formatPercent(summary.topPct, 1, false)} of total</em></div>
      </div>
      )}
    </section>
  );
}

/**
 * Per-account holdings table. Extracted into its own component so each instance owns its own scroll-shadow hook
 * (one ref per scrollable container; we can't share one). Its column heads show: the combined table's are far
 * above by now. A holding whose price is missing, stale or an overnight estimate says so under its symbol.
 */
interface AccountHoldingsTableProps {
  acc: ReturnType<typeof summarizeByAccount>['accounts'][number];
  a: ReturnType<typeof summarizeByAccount>['accounts'][number]['account'];
  quoteBySymbol: Map<string, Quote>;
  indicativeActive: boolean;
}

function AccountHoldingsTable({ acc, a, quoteBySymbol, indicativeActive }: AccountHoldingsTableProps) {
  const scrollShadow = useScrollShadow<HTMLDivElement>();
  return (
    <div
      ref={scrollShadow.ref}
      className={`holdings-scroll${scrollShadow.scrolled ? ' is-scrolled' : ''}`}
    >
      <table className="holdings compact">
        <thead>
          <tr>
            <th className="col-sym">Symbol</th>
            <th className="num col-qty">Quantity</th>
            <th className="num col-price">Price</th>
            <th className="num col-value">Market value</th>
            <th className="num col-gl">Gain/loss <span className="holdings-head-sub">(excludes cash)</span></th>
            <th className="num col-pct">% of account</th>
          </tr>
        </thead>
        <tbody>
          {acc.rows.map((row) => {
            const option = row.instrumentType === 'option' ? parseOccSymbol(row.symbol) : null;
            const exerciseNotional = option && row.quantity != null
              ? Math.abs(row.quantity) * (row.contractMultiplier ?? 1) * option.strikePrice
              : null;
            const unpriced = row.kind === 'position' && row.marketPrice == null;
            const shown = formatGainLoss(row.unrealizedPnL, row.unrealizedPnLPercent, { currency: row.currency });
            return (
            <tr key={`${a.id}-${row.symbol}`} className={row.kind === 'cash' ? 'cash-row' : undefined}>
              <td className="sym col-sym">
                {option ? formatOptionSymbol(row.symbol) : row.symbol}
                {option ? (
                  <span className="option-cell-label">
                    {row.quantity != null && row.quantity < 0 ? 'Short' : 'Long'} {option.optionType}
                    {exerciseNotional != null ? ` · ${formatCurrency(exerciseNotional, row.currency)} exercise notional` : ''}
                  </span>
                ) : null}
                {row.kind === 'position'
                  ? <PriceStateNote quote={quoteBySymbol.get(row.symbol)} overnight={indicativeActive} />
                  : null}
              </td>
              <td className="num col-qty">
                {row.quantity != null ? row.quantity.toLocaleString(undefined, { maximumFractionDigits: 4 }) : '—'}
                {option ? <span className="option-cell-label">contracts</span> : null}
              </td>
              <td className="num col-price">
                {row.marketPrice != null ? formatCurrency(row.marketPrice, row.currency) : '—'}
                {option && row.marketPrice != null ? <span className="option-cell-label">Delayed mark</span> : null}
              </td>
              <td className="num col-value">
                {unpriced ? <span className="muted">—</span> : formatCurrency(row.marketValue, row.currency)}
              </td>
              <td className={`num col-gl ${row.kind === 'cash' || unpriced ? '' : gainLossClass(shown.tone)}`}>
                {row.kind === 'cash' || unpriced
                  ? <span className="muted">—</span>
                  : <>
                      <Trend value={gainLossArrow(shown.tone)} />
                      {shown.amount} ({shown.percent})
                      <PercentUnknownNote percent={row.unrealizedPnLPercent} />
                    </>}
              </td>
              <td className="num col-pct">{acc.valueAvailable ? formatPercent(row.pctOfAccount, 2, false) : <span className="muted">—</span>}</td>
            </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td className="sym col-sym">Account total</td>
            <td className="num col-qty" />
            <td className="num col-price" />
            <td className="num col-value">{acc.valueAvailable ? formatCurrency(acc.totalMarketValue, a.currency) : '—'}</td>
            <td className="num col-gl">
              {acc.valueAvailable && acc.rows.some((row) => row.kind === 'position')
                ? <GainLoss value={acc.totalUnrealizedPnL} percent={acc.positionsUnrealizedPnLPercent} currency={a.currency} />
                : '—'}
            </td>
            <td className="num col-pct">{acc.valueAvailable ? '100.00%' : '—'}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
