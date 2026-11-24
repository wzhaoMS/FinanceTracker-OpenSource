import type {
  Account,
  PortfolioSummary,
  Position,
  Quote,
  Transaction,
  ValuedPosition,
} from './types.js';
import { parseOccSymbol } from './options.js';

const POSITION_EPSILON = 1e-9;

export function positionMarketValue(position: Position, quote: Pick<Quote, 'price'>): number {
  return position.quantity * (position.contractMultiplier ?? 1) * quote.price;
}

export function aggregateOptionPosition(symbol: string, txs: Transaction[]): Position | null {
  const optionTxs = txs
    .map((transaction, index) => ({ transaction, index }))
    .filter(({ transaction }) => transaction.symbol === symbol)
    .sort((left, right) => (
      left.transaction.date.localeCompare(right.transaction.date)
      || left.index - right.index
    ))
    .map(({ transaction }) => transaction);
  if (optionTxs.length === 0) return null;
  if (!parseOccSymbol(symbol)) throw new Error(`invalid OCC option symbol: ${symbol}`);

  const multiplier = optionTxs[0].contractMultiplier;
  if (typeof multiplier !== 'number' || !Number.isInteger(multiplier) || multiplier <= 0) {
    throw new Error(`option ${symbol} requires a positive integer contractMultiplier`);
  }
  const currency = optionTxs[0].currency;
  let quantity = 0;
  let costBasis = 0;

  for (const transaction of optionTxs) {
    if (
      transaction.instrumentType !== 'option'
      || transaction.contractMultiplier !== multiplier
      || !transaction.positionEffect
    ) throw new Error(`option ${symbol} has incomplete or inconsistent metadata`);
    if (transaction.currency !== currency) {
      throw new Error(`option ${symbol} mixes currencies`);
    }

    const fees = transaction.fees ?? 0;
    if (transaction.positionEffect === 'open') {
      if (
        Math.abs(quantity) > POSITION_EPSILON
        && Math.sign(quantity) !== Math.sign(transaction.quantity)
      ) throw new Error(`option ${symbol} opening trade crosses the existing position`);
      const grossPremium = Math.abs(transaction.quantity) * multiplier * transaction.pricePerUnit;
      costBasis += transaction.quantity > 0
        ? grossPremium + fees
        : -grossPremium + fees;
      quantity += transaction.quantity;
      continue;
    }

    if (Math.abs(quantity) <= POSITION_EPSILON) {
      throw new Error(`option ${symbol} close has no open position`);
    }
    if (Math.sign(quantity) === Math.sign(transaction.quantity)) {
      throw new Error(`option ${symbol} close does not oppose the open position`);
    }
    const openContracts = Math.abs(quantity);
    const closingContracts = Math.abs(transaction.quantity);
    if (closingContracts > openContracts + POSITION_EPSILON) {
      throw new Error(`option ${symbol} close exceeds the open contract count`);
    }
    const remainingContracts = openContracts - closingContracts;
    if (remainingContracts <= POSITION_EPSILON) {
      quantity = 0;
      costBasis = 0;
    } else {
      costBasis *= remainingContracts / openContracts;
      quantity += transaction.quantity;
    }
  }

  if (Math.abs(quantity) <= POSITION_EPSILON) {
    return { symbol, quantity: 0, averageCost: 0, costBasis: 0, currency, instrumentType: 'option', contractMultiplier: multiplier };
  }
  return {
    symbol,
    quantity,
    averageCost: Math.abs(costBasis) / (Math.abs(quantity) * multiplier),
    costBasis,
    currency,
    instrumentType: 'option',
    contractMultiplier: multiplier,
  };
}

/**
 * Reduce a list of transactions for a single symbol into a `Position`.
 *
 * Cost-basis semantics (weighted-average):
 *   - Buys: cost basis increases by `qty * price + fees`. Average cost is
 *     recomputed as the weighted mean of buy lots.
 *   - Sells: cost basis is reduced by `(soldQty * avgCost) + sellFees`,
 *     i.e. by the basis attributable to the shares being sold. Sale
 *     proceeds DO NOT flow into cost basis — that would conflate realized
 *     and unrealized P/L. Average cost is unchanged by sells (until the
 *     position is fully closed and the next buy starts a fresh lot).
 *   - Fully closed and re-opened: when running quantity reaches 0, both
 *     `costBasis` and `averageCost` reset; the next buy starts a new lot.
 *
 * Realized P/L is NOT returned here (see `aggregateRealizedPnL` if needed).
 * The remaining `costBasis` is consistent with `quantity * averageCost`
 * for any pure-buy or buy-then-partial-sell sequence.
 */
export function aggregatePosition(symbol: string, txs: Transaction[]): Position | null {
  const symbolTxs = txs.filter((t) => t.symbol === symbol);
  if (symbolTxs.length === 0) return null;
  const optionCount = symbolTxs.filter((transaction) => transaction.instrumentType === 'option').length;
  if (optionCount > 0) {
    if (optionCount !== symbolTxs.length) {
      throw new Error(`instrument ${symbol} mixes option and equity transactions`);
    }
    return aggregateOptionPosition(symbol, symbolTxs);
  }

  // Process in chronological order so partial sells reduce the right lot.
  const ordered = symbolTxs
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  let quantity = 0;
  let costBasis = 0;
  // Running buy-weighted total cost / total qty so we can recompute avg
  // cost across multiple buys with different prices.
  let runningAvgCost = 0;
  const currency = ordered[0].currency;

  for (const t of ordered) {
    const fees = t.fees ?? 0;
    if (t.quantity > 0) {
      const lotCost = t.quantity * t.pricePerUnit + fees;
      const newQty = quantity + t.quantity;
      // Recompute weighted avg over (existing held shares × avg) + new lot.
      runningAvgCost =
        newQty > 0 ? (quantity * runningAvgCost + lotCost) / newQty : 0;
      costBasis += lotCost;
      quantity = newQty;
    } else {
      // Sell: shares leave at the current average cost.
      const soldQty = -t.quantity;
      const costRemoved = soldQty * runningAvgCost + fees;
      costBasis -= costRemoved;
      quantity -= soldQty;
      // Numerical hygiene: when fully closed, snap to clean zero so the
      // next buy starts a fresh lot.
      if (Math.abs(quantity) < 1e-9) {
        quantity = 0;
        costBasis = 0;
        runningAvgCost = 0;
      }
    }
  }

  return { symbol, quantity, averageCost: runningAvgCost, costBasis, currency };
}

/** Aggregate all transactions into one `Position` per symbol (skipping zero quantity).
 *
 * Also drops symbols whose net quantity is negative. A retail portfolio
 * tracker doesn't model short positions: a negative running quantity is
 * always an artifact of incomplete history (broker activity import
 * captured the SELL of a position that was bought before the activity
 * window). The transactions stay in the DB so the user can audit them;
 * we just don't surface a "you hold -52 MSFT" line in the holdings UI.
 *
 * If short selling becomes a real use case we can gate this on a flag
 * or expose an `aggregatePositionsAllowShort()` variant.
 */
export function aggregatePositions(txs: Transaction[]): Position[] {
  const filtered = dropImportedSnapshotsWhereActivityExists(txs);
  const symbols = Array.from(new Set(filtered.map((t) => t.symbol)));
  const positions: Position[] = [];
  for (const sym of symbols) {
    const p = aggregatePosition(sym, filtered);
    if (
      p
      && (p.instrumentType === 'option'
        ? Math.abs(p.quantity) > POSITION_EPSILON
        : p.quantity > POSITION_EPSILON)
    ) positions.push(p);
  }
  return positions;
}

/**
 * Current positive-position symbols across a household, aggregated within
 * each account first. Account-local aggregation is essential: an orphan SELL
 * from an incomplete activity window in one account must never cancel a real
 * holding in another account.
 */
export function heldSymbolsAcrossAccounts(txs: Transaction[]): string[] {
  const byAccount = new Map<string, Transaction[]>();
  for (const transaction of txs) {
    const rows = byAccount.get(transaction.accountId) ?? [];
    rows.push(transaction);
    byAccount.set(transaction.accountId, rows);
  }

  const symbols = new Set<string>();
  for (const rows of byAccount.values()) {
    for (const position of aggregatePositions(rows)) symbols.add(position.symbol);
  }
  return Array.from(symbols).sort();
}

/**
 * Drop legacy "imported" snapshot rows for any (accountId, symbol) where
 * activity rows also exist, so the same shares are never counted twice.
 *
 * Background: there are two import paths that both write to `transactions`:
 *
 *   1. Snapshot path ("Pull positions"): a single row per holding. Modern
 *      snapshots carry `sourceFingerprint = "pos:<symbol>"`; legacy rows
 *      written by the original `importMapper` left it NULL with `notes`
 *      starting with "imported". Both forms are recognised here.
 *   2. Activity path ("Sync activity"): one row per BUY/SELL/REINVEST,
 *      with a sha256-hex `sourceFingerprint`.
 *
 * The activity path's per-row fingerprint dedup protects activity-vs-activity,
 * but does nothing against the snapshot row. So when a user pulls positions
 * AND syncs activity for the same (account, symbol), the snapshot's
 * cumulative qty plus every activity BUY get summed → the position is
 * inflated by exactly the snapshot qty.
 *
 * Resolution: prefer the activity rows (they are the audit trail). Whenever
 * any activity row exists for a given (accountId, symbol), drop the snapshot
 * row for that pair. Hand-entered rows (any notes that don't start with
 * "imported", and no `pos:` fingerprint) are never touched.
 *
 * The check is keyed on (accountId, symbol) — same symbol in a different
 * account where only the snapshot exists is left alone.
 */
export function dropImportedSnapshotsWhereActivityExists(
  txs: Transaction[],
): Transaction[] {
  const hasActivity = new Set<string>();
  for (const t of txs) {
    const fp = t.sourceFingerprint;
    if (fp && !fp.startsWith('pos:')) {
      hasActivity.add(`${t.accountId}\u0000${t.symbol}`);
    }
  }
  if (hasActivity.size === 0) return txs;
  return txs.filter((t) => {
    const fp = t.sourceFingerprint;
    const isModernSnapshot = !!fp && fp.startsWith('pos:');
    const isLegacySnapshot =
      !fp && typeof t.notes === 'string' && /^imported\b/i.test(t.notes);
    if (!isModernSnapshot && !isLegacySnapshot) return true;
    return !hasActivity.has(`${t.accountId}\u0000${t.symbol}`);
  });
}

/** Combine positions with quotes into a full portfolio summary. */
export function summarizePortfolio(
  txs: Transaction[],
  quotes: Quote[],
): PortfolioSummary {
  const positions = aggregatePositions(txs);
  const quoteMap = new Map(quotes.map((q) => [q.symbol, q]));

  const valued: ValuedPosition[] = [];
  const missingQuotes: string[] = [];

  for (const p of positions) {
    const q = quoteMap.get(p.symbol);
    if (!q) {
      missingQuotes.push(p.symbol);
      continue;
    }
    const marketValue = positionMarketValue(p, q);
    const unrealizedPnL = marketValue - p.costBasis;
    valued.push({
      ...p,
      marketPrice: q.price,
      marketValue,
      unrealizedPnL,
      unrealizedPnLPercent: positionsPnLPercent(unrealizedPnL, p.costBasis),
    });
  }

  const totalCostBasis = valued.reduce((s, p) => s + p.costBasis, 0);
  const totalMarketValue = valued.reduce((s, p) => s + p.marketValue, 0);
  const valueAvailable = missingQuotes.length === 0;
  const totalUnrealizedPnL = valueAvailable ? totalMarketValue - totalCostBasis : 0;

  return {
    totalCostBasis,
    totalMarketValue,
    totalUnrealizedPnL,
    // No cash in this summary: every cost is a position's. The percent is the canonical sum over its own positions,
    // the same sum every web scope reads, so one account reads one percent here and on the web, even at a rounding
    // boundary (3ddfcd26, GL-P2-2). Mobile holds one account ('default'), so its pooled positions are that account's.
    positionsUnrealizedPnLPercent: scopePositionsPnLPercent([positions], quoteMap),
    positions: valued,
    missingQuotes,
    valueAvailable,
  };
}

/** Format a number as currency for display. */
export function formatCurrency(amount: number, currency = 'USD', locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
}

export function formatPercent(percent: number, fractionDigits = 2, signed = true): string {
  // Round 3 (3.A3): added `signed` opt-out so callers can render
  // allocations (% of total, % of account) and holdings-table G/L
  // percentages without a leading `+`. Trend glyph + gain/loss color
  // already convey direction in those cells; the `+` is triple-cueing.
  // Negatives always render the minus sign via toFixed().
  const sign = signed && percent > 0 ? '+' : '';
  // Audit polish (2026-05-08): three-digit percentages like +406.22% read as
  // a glitch when crammed alongside two-digit values. Round to whole
  // percent above |100| so the cell stays the same width as a sane
  // value — Robinhood / Public both do this for compounders.
  const digits = Math.abs(percent) >= 100 ? 0 : fractionDigits;
  return `${sign}${percent.toFixed(digits)}%`;
}

/** Which colour and arrow a gain or loss takes: neutral is neither, for one that shows as zero. */
export type GainLossTone = 'gain' | 'loss' | 'neutral';

/** A gain or loss as Portfolio shows it: its amount, its percent and their tones. */
export interface GainLossDisplay {
  amount: string;
  percent: string;
  /** The tone of the amount and its percent shown together: "$1.23 (4.56%)". */
  tone: GainLossTone;
  /** The tone of the percent shown alone (mobile's holding rows): neutral when it reads 0.00% or is unknown. */
  percentTone: GainLossTone;
}

/** A value as it is shown on its own, a change or a percent: its text and its tone. */
export interface ShownValue {
  text: string;
  tone: GainLossTone;
}

/**
 * An amount shown on its own (a day change, a cash flow, a gain): formatting only, the value is the caller's.
 *
 * An unknown amount reads "—", never $0.00. One that reads zero as `format` writes it (to its currency's cents, or a
 * compact "$0") reads that zero, unsigned and neutral: never "-$0.00" or "+$0.00" from a hair of float noise. Any other
 * keeps its sign, "+" before a gain only when `signed`, and takes the gain or loss tone. `format` must write a negative
 * with its leading "-", as formatCurrency does. The zero test formats the size alone exactly as it is shown, so it agrees
 * with the text by construction.
 */
export function formatShownAmount(
  amount: number | null | undefined,
  { currency = 'USD', locale = 'en-US', signed = false, format }: {
    currency?: string;
    locale?: string;
    signed?: boolean;
    format?: (value: number) => string;
  } = {},
): ShownValue {
  if (amount == null) return { text: '—', tone: 'neutral' };
  const write = format ?? ((value: number) => formatCurrency(value, currency, locale));
  const zero = write(0);
  if (write(Math.abs(amount)) === zero) return { text: zero, tone: 'neutral' };
  return { text: `${signed && amount > 0 ? '+' : ''}${write(amount)}`, tone: amount > 0 ? 'gain' : 'loss' };
}

/**
 * A percent shown on its own (a day change, a return, a premium), as formatPercent writes it to `digits` places:
 * formatting only. An unknown percent reads "—", never 0%. One that reads zero reads "0.00%" (or "0.0%"), unsigned and
 * neutral: never "+0.00%" or "-0.00%". Any other keeps its sign, "+" before a gain only when `signed`, and takes the gain
 * or loss tone.
 */
export function formatShownPercent(
  percent: number | null | undefined,
  { signed = false, digits = 2 }: { signed?: boolean; digits?: number } = {},
): ShownValue {
  if (percent == null) return { text: '—', tone: 'neutral' };
  const zero = formatPercent(0, digits, false);
  if (formatPercent(Math.abs(percent), digits, false) === zero) return { text: zero, tone: 'neutral' };
  return { text: formatPercent(percent, digits, signed), tone: percent > 0 ? 'gain' : 'loss' };
}

/**
 * How Portfolio, on the web and on mobile, shows a gain or loss: formatting only, the values are the caller's, untouched.
 *
 * A zero reads as zero. An amount that rounds to $0.00 at its currency's precision never carries a sign ("-$0.00" from a
 * hair of float noise), and a percent that rounds to 0.00% reads "0.00%", unsigned, even where gains are signed
 * ("+12.34%" on mobile). An unknown amount or percent reads "—". The tone follows what is shown. A percent alone
 * (percentTone) is neutral when it reads 0.00% or is unknown, else its own sign. An amount with its percent (tone) takes
 * the amount's sign, so "-$0.01 (0.00%)" is a loss; when the amount reads $0.00 or is unknown the percent decides, so
 * "$0.00 (25.00%)" (a sub-cent cost) is a gain and "$0.00 (0.00%)" is neutral. Neutral is neither the gain nor the loss
 * colour, and no arrow. `signedAmount` writes "+" before a gain's amount ("+$1.23 (+4.56%)" with `signedPercent`).
 */
export function formatGainLoss(
  amount: number | null | undefined,
  percent: number | null | undefined,
  { currency = 'USD', signedPercent = false, signedAmount = false, locale = 'en-US' }: {
    currency?: string;
    signedPercent?: boolean;
    signedAmount?: boolean;
    locale?: string;
  } = {},
): GainLossDisplay {
  const shownAmount = formatShownAmount(amount, { currency, locale, signed: signedAmount });
  const shownPercent = formatShownPercent(percent, { signed: signedPercent });
  return {
    amount: shownAmount.text,
    percent: shownPercent.text,
    tone: shownAmount.tone === 'neutral' ? shownPercent.tone : shownAmount.tone,
    percentTone: shownPercent.tone,
  };
}

/**
 * A cost this close to zero is zero: float noise from sums that should cancel (an option bought and one sold for the same
 * premium), never a real cost. It is the module's tolerance for a quantity, far below any amount of money, so a real
 * sub-cent cost (0.001 shares at $4) keeps its percent.
 */
const COST_EPSILON = POSITION_EPSILON;

/**
 * A gain or loss within this share of its cost is no gain or loss: float noise from two sums of the same trades (the
 * dollars' cash-inclusive sum and the percent's canonical one), never a real move. It moves only a zero's sign: a
 * percent under 1e-7% shows 0.00% either way, but a noise-negative one would read "-0.00%" beside a gain.
 */
const ZERO_PNL_RELATIVE = 1e-9;

/**
 * Portfolio's one gain/loss percent: a gain or loss over the cost of the invested positions it is on, with cash left
 * out, G/L ÷ (cost basis − cash). Cash has no gain or loss, so counting it as cost would only shrink the percent. A
 * holding's, an account's, the household's and the combined holdings' percents all come from here, so one scope reads
 * the same percent in every view.
 *
 * Null when the percent is unknown, never 0: a price is missing (`known` is false), or the positions cost nothing, so
 * there is no base to measure against. The base is the cost's size, so a short option's credit counts like a cost. A
 * gain or loss within float noise of zero (|pnl| ≤ 1e-9 × |cost|) is exactly 0, so a true zero reads 0.00% everywhere.
 */
export function positionsPnLPercent(pnl: number, positionsCostBasis: number, known = true): number | null {
  if (!known || !Number.isFinite(pnl) || !Number.isFinite(positionsCostBasis)) return null;
  const base = Math.abs(positionsCostBasis);
  if (base < COST_EPSILON) return null;
  if (Math.abs(pnl) <= ZERO_PNL_RELATIVE * base) return 0;
  return (pnl / base) * 100;
}

/**
 * The gain/loss percent of a scope of accounts, from one canonical sum: holding by holding, each account's positions as
 * `aggregatePositions` forms them, in the accounts' order. An account, the household and the combined holdings all take
 * their percent from here, so the same accounts read the same percent to the bit in every view, whichever order each
 * view sums its own dollars in (at a rounding boundary, two orders could otherwise show 0.00% and 0.01%). Null when any
 * of the positions has no price.
 */
function scopePositionsPnLPercent(positionsByAccount: Position[][], quoteMap: Map<string, Pick<Quote, 'price'>>): number | null {
  let pnl = 0;
  let costBasis = 0;
  let known = true;
  for (const positions of positionsByAccount) {
    for (const position of positions) {
      costBasis += position.costBasis;
      const quote = quoteMap.get(position.symbol);
      if (quote) pnl += positionMarketValue(position, quote) - position.costBasis;
      else known = false;
    }
  }
  return positionsPnLPercent(pnl, costBasis, known);
}

/** A single row in an account's holdings table — either a position or the cash line. */
export interface AccountRow {
  kind: 'position' | 'cash';
  symbol: string;
  quantity: number | null;
  averageCost: number | null;
  marketPrice: number | null;
  marketValue: number;
  costBasis: number;
  unrealizedPnL: number;
  /** `positionsPnLPercent` of this holding; null for cash, a holding with no price, or one that cost nothing. */
  unrealizedPnLPercent: number | null;
  /** Share of this account's total market value (incl. cash). */
  pctOfAccount: number;
  currency: string;
  instrumentType?: 'option';
  contractMultiplier?: number;
}

export interface AccountSummary {
  account: Account;
  rows: AccountRow[];
  cashValue: number;
  positionsMarketValue: number;
  totalMarketValue: number;
  totalCostBasis: number;
  totalUnrealizedPnL: number;
  /** The account's gain/loss over its positions' cost, cash left out (`positionsPnLPercent`); null when unknown. */
  positionsUnrealizedPnLPercent: number | null;
  missingQuotes: string[];
  valueAvailable: boolean;
}

export interface MultiAccountSummary {
  accounts: AccountSummary[];
  grandTotalMarketValue: number;
  grandTotalCostBasis: number;
  grandTotalUnrealizedPnL: number;
  /** The household's gain/loss over all its positions' cost, cash left out (`positionsPnLPercent`); null when unknown. */
  positionsUnrealizedPnLPercent: number | null;
  valueAvailable: boolean;
}

/** Fidelity-style breakdown grouped by account, with a grand total across all accounts. */
export function summarizeByAccount(
  accounts: Account[],
  txs: Transaction[],
  quotes: Quote[],
): MultiAccountSummary {
  const quoteMap = new Map(quotes.map((q) => [q.symbol, q]));
  const accountSummaries: AccountSummary[] = [];
  const positionsByAccount: Position[][] = [];

  for (const account of accounts) {
    const accTxs = txs.filter((t) => t.accountId === account.id);
    const positions = aggregatePositions(accTxs);
    positionsByAccount.push(positions);

    const valued: Array<Position & { marketPrice: number; marketValue: number; unrealizedPnL: number }> = [];
    const unpriced: Position[] = [];
    const missingQuotes: string[] = [];
    for (const p of positions) {
      const q = quoteMap.get(p.symbol);
      if (!q) { missingQuotes.push(p.symbol); unpriced.push(p); continue; }
      const marketValue = positionMarketValue(p, q);
      valued.push({
        ...p,
        marketPrice: q.price,
        marketValue,
        unrealizedPnL: marketValue - p.costBasis,
      });
    }

    const positionsMarketValue = valued.reduce((s, p) => s + p.marketValue, 0);
    const cashValue = account.cashBalance;
    const totalMarketValue = positionsMarketValue + cashValue;

    const rows: AccountRow[] = valued
      .slice()
      .sort((a, b) => b.marketValue - a.marketValue)
      .map<AccountRow>((p) => ({
        kind: 'position',
        symbol: p.symbol,
        quantity: p.quantity,
        averageCost: p.averageCost,
        marketPrice: p.marketPrice,
        marketValue: p.marketValue,
        costBasis: p.costBasis,
        unrealizedPnL: p.unrealizedPnL,
        unrealizedPnLPercent: positionsPnLPercent(p.unrealizedPnL, p.costBasis),
        pctOfAccount: totalMarketValue > 0 ? (p.marketValue / totalMarketValue) * 100 : 0,
        currency: p.currency,
        instrumentType: p.instrumentType,
        contractMultiplier: p.contractMultiplier,
      }));

    rows.push(...unpriced.map<AccountRow>((position) => ({
      kind: 'position',
      symbol: position.symbol,
      quantity: position.quantity,
      averageCost: position.averageCost,
      marketPrice: null,
      marketValue: 0,
      costBasis: position.costBasis,
      unrealizedPnL: 0,
      unrealizedPnLPercent: positionsPnLPercent(0, position.costBasis, false),
      pctOfAccount: 0,
      currency: position.currency,
      instrumentType: position.instrumentType,
      contractMultiplier: position.contractMultiplier,
    })));

    if (cashValue !== 0 || valued.length === 0) {
      rows.push({
        kind: 'cash',
        symbol: 'Cash',
        quantity: null,
        averageCost: null,
        marketPrice: null,
        marketValue: cashValue,
        costBasis: cashValue,
        unrealizedPnL: 0,
        // Cash is no position: it has no gain/loss percent.
        unrealizedPnLPercent: null,
        pctOfAccount: totalMarketValue > 0 ? (cashValue / totalMarketValue) * 100 : 0,
        currency: account.currency,
      });
    }

    const positionsCostBasis = positions.reduce((s, p) => s + p.costBasis, 0);
    const totalCostBasis = positionsCostBasis + cashValue;
    const valueAvailable = unpriced.length === 0;
    const totalUnrealizedPnL = valueAvailable ? totalMarketValue - totalCostBasis : 0;

    accountSummaries.push({
      account,
      rows,
      cashValue,
      positionsMarketValue,
      totalMarketValue,
      totalCostBasis,
      totalUnrealizedPnL,
      positionsUnrealizedPnLPercent: scopePositionsPnLPercent([positions], quoteMap),
      missingQuotes,
      valueAvailable,
    });
  }

  const grandTotalMarketValue = accountSummaries.reduce((s, a) => s + a.totalMarketValue, 0);
  const grandTotalCostBasis = accountSummaries.reduce((s, a) => s + a.totalCostBasis, 0);
  const valueAvailable = accountSummaries.every((account) => account.valueAvailable);
  const grandTotalUnrealizedPnL = valueAvailable ? grandTotalMarketValue - grandTotalCostBasis : 0;

  return {
    accounts: accountSummaries,
    grandTotalMarketValue,
    grandTotalCostBasis,
    grandTotalUnrealizedPnL,
    positionsUnrealizedPnLPercent: scopePositionsPnLPercent(positionsByAccount, quoteMap),
    valueAvailable,
  };
}

// ---------------------------------------------------------------------------
// Combined-by-symbol view
// ---------------------------------------------------------------------------

/** One account's contribution to a combined-by-symbol row. */
export interface SymbolContributor {
  accountId: string;
  accountName: string;
  quantity: number;
  costBasis: number;
  marketValue: number;
  /** Convenience: marketValue - costBasis. 0 when no quote. */
  unrealizedPnL: number;
  /** `positionsPnLPercent` of this account's part; null with no price or no cost. */
  unrealizedPnLPercent: number | null;
}

/** A single row in the combined holdings-by-asset table. */
export interface SymbolRow {
  symbol: string;
  quantity: number;
  averageCost: number;
  costBasis: number;
  marketPrice: number | null;     // null when no quote available
  marketValue: number;
  unrealizedPnL: number;
  /** `positionsPnLPercent` of this holding; null with no price or no cost. */
  unrealizedPnLPercent: number | null;
  /** Share of the selected-view total (positions + cash). */
  pctOfTotal: number;
  currency: string;
  contributors: SymbolContributor[];
  /** True when no quote is available for this symbol. */
  missingQuote: boolean;
  /**
   * Day-change passthroughs from the underlying quote, when the provider
   * gave us a trustworthy baseline. UI uses `changeBasis` to decide whether
   * to render and how to label it.
   */
  changeBasis?: 'previousClose' | 'open' | '24h' | 'provider';
  dayChange?: number;
  dayChangePercent?: number;
  /** Quote freshness ("live" | "delayed" | "eod" | "stale") for stale gating. */
  freshness?: 'live' | 'delayed' | 'eod' | 'stale';
  /** Active US session at quote time — drives "Today" vs "Pre-market" vs
   *  "After hours" labeling on the day-change line. */
  session?: 'pre-market' | 'regular' | 'after-hours' | 'closed';
  /** Quote source — useful for the "Stooq -> hide day-change" rule. */
  source?: string;
  instrumentType?: 'option';
  contractMultiplier?: number;
}

/** Combined-by-asset summary across an arbitrary slice of accounts. */
export interface SymbolSummary {
  rows: SymbolRow[];
  /** Cash row, broken out per contributing account. Always present. */
  cash: {
    total: number;
    pctOfTotal: number;
    contributors: Array<{ accountId: string; accountName: string; amount: number }>;
  };
  totalMarketValue: number;
  totalCostBasis: number;
  totalUnrealizedPnL: number;
  /** The slice's gain/loss over its positions' cost, cash left out (`positionsPnLPercent`); null when unknown. */
  positionsUnrealizedPnLPercent: number | null;
  /** Symbols with positions but no quote, surfaced for the UI to flag. */
  missingQuotes: string[];
  valueAvailable: boolean;
}

/**
 * Combine an arbitrary slice of accounts (Alex view, Casey view, Household)
 * into a flat by-asset table. Each `SymbolRow` is one ticker, regardless of
 * how many accounts hold it; per-account quantities/values are preserved as
 * `contributors` so the UI can drill down.
 *
 * Cash is included in `totalMarketValue` and exposed as a separate `cash`
 * line so callers can render it as a dedicated row.
 *
 * No deduplication of accounts: callers are expected to pre-filter the
 * `accounts` array to avoid double-counting joint accounts in views where
 * that matters. (For per-user views joint accounts ARE intentionally
 * counted at 100% — see the multi-user plan.)
 */
export function summarizeBySymbol(
  accounts: Account[],
  txs: Transaction[],
  quotes: Quote[],
): SymbolSummary {
  const quoteMap = new Map(quotes.map((q) => [q.symbol, q]));
  const accountIds = new Set(accounts.map((a) => a.id));
  const accountById = new Map(accounts.map((a) => [a.id, a] as const));
  const inScopeTxs = dropImportedSnapshotsWhereActivityExists(
    txs.filter((t) => accountIds.has(t.accountId)),
  );

  // group: (symbol, accountId) → aggregated Position for that pair
  const perAccountPositions = new Map<string, Map<string, ReturnType<typeof aggregatePosition>>>();
  for (const t of inScopeTxs) {
    let inner = perAccountPositions.get(t.symbol);
    if (!inner) {
      inner = new Map();
      perAccountPositions.set(t.symbol, inner);
    }
    if (!inner.has(t.accountId)) {
      const accTxs = inScopeTxs.filter((x) => x.symbol === t.symbol && x.accountId === t.accountId);
      inner.set(t.accountId, aggregatePosition(t.symbol, accTxs));
    }
  }

  const cashTotal = accounts.reduce((s, a) => s + a.cashBalance, 0);
  const cashContribs = accounts
    .filter((a) => a.cashBalance !== 0)
    .map((a) => ({ accountId: a.id, accountName: a.name, amount: a.cashBalance }));

  const rows: SymbolRow[] = [];
  const missingQuotes: string[] = [];

  for (const [symbol, perAcct] of perAccountPositions) {
    let quantity = 0;
    let costBasis = 0;
    let buyQty = 0;
    let buyCost = 0;
    let instrumentType: 'option' | undefined;
    let contractMultiplier: number | undefined;
    const contributors: SymbolContributor[] = [];
    const heldByAccount = new Map<string, Position>();

    // Walk all txs once per (symbol, account) so we can compute contributor
    // marketValue with a quote lookup outside the inner loop.
    for (const [accountId, pos] of perAcct) {
      // Skip empty AND short positions. See aggregatePositions docstring:
      // a retail tracker doesn't model shorts; negative balances are
      // always incomplete-history artifacts.
      if (
        !pos
        || (pos.instrumentType === 'option'
          ? Math.abs(pos.quantity) < POSITION_EPSILON
          : pos.quantity < POSITION_EPSILON)
      ) continue;
      const q = quoteMap.get(symbol);
      const acct = accountById.get(accountId);
      if (!acct) continue;
      heldByAccount.set(accountId, pos);
      const acctMv = q ? positionMarketValue(pos, q) : 0;
      const acctPnl = q ? acctMv - pos.costBasis : 0;
      const acctPnlPct = positionsPnLPercent(acctPnl, pos.costBasis, !!q);
      contributors.push({
        accountId,
        accountName: acct.name,
        quantity: pos.quantity,
        costBasis: pos.costBasis,
        marketValue: acctMv,
        unrealizedPnL: acctPnl,
        unrealizedPnLPercent: acctPnlPct,
      });
      quantity += pos.quantity;
      costBasis += pos.costBasis;
      if (pos.instrumentType === 'option') {
        instrumentType = 'option';
        contractMultiplier = pos.contractMultiplier;
      }
      // Recompute buy-weighted avg cost from the underlying txs for this
      // (symbol, accountId) so the symbol-level avg is buy-weighted across
      // accounts, not just an arithmetic mean.
      for (const t of inScopeTxs) {
        if (t.symbol !== symbol || t.accountId !== accountId) continue;
        if (t.instrumentType !== 'option' && t.quantity > 0) {
          buyQty += t.quantity;
          buyCost += t.quantity * t.pricePerUnit + (t.fees ?? 0);
        }
      }
    }

    // Drop fully-closed positions and negative aggregates (the same
    // short-position rule as aggregatePositions). A symbol that's negative
    // in one account and positive in another would still show: only the
    // sum is checked.
    if (
      contributors.length === 0
      || (instrumentType !== 'option' && quantity < POSITION_EPSILON)
    ) continue;

    const q = quoteMap.get(symbol);
    const marketValue = q ? quantity * (contractMultiplier ?? 1) * q.price : 0;
    if (!q) missingQuotes.push(symbol);
    const unrealizedPnL = marketValue - costBasis;
    // A holding across accounts is a scope too: its percent is the canonical sum over its accounts' positions, in the
    // accounts' order, so when it is all the household holds it reads the household's percent to the bit.
    const unrealizedPnLPercent = scopePositionsPnLPercent(
      accounts.flatMap((account) => {
        const held = heldByAccount.get(account.id);
        return held ? [[held]] : [];
      }),
      quoteMap,
    );

    rows.push({
      symbol,
      quantity,
      averageCost: instrumentType === 'option'
        ? Math.abs(quantity) > POSITION_EPSILON
          ? Math.abs(costBasis) / (Math.abs(quantity) * (contractMultiplier ?? 1))
          : 0
        : buyQty > 0 ? buyCost / buyQty : 0,
      costBasis,
      marketPrice: q ? q.price : null,
      marketValue,
      unrealizedPnL,
      unrealizedPnLPercent,
      pctOfTotal: 0, // filled in below once we know the denominator
      currency: contributors[0] ? (accountById.get(contributors[0].accountId)?.currency ?? 'USD') : 'USD',
      contributors: contributors.sort((a, b) => b.marketValue - a.marketValue),
      missingQuote: !q,
      // Day-change passthrough so the UI can render dollar/percent change
      // without re-walking quotes. Caller (UI) decides whether to show by
      // examining `changeBasis` and `freshness`.
      changeBasis: q?.changeBasis,
      dayChange: q?.dayChange,
      dayChangePercent: q?.dayChangePercent,
      freshness: q?.freshness,
      session: q?.session,
      source: q?.source,
      instrumentType,
      contractMultiplier,
    });
  }

  rows.sort((a, b) => b.marketValue - a.marketValue);

  const totalPositionsMv = rows.reduce((s, r) => s + r.marketValue, 0);
  const totalMarketValue = totalPositionsMv + cashTotal;
  const totalCostBasis = rows.reduce((s, r) => s + r.costBasis, 0) + cashTotal;
  const valueAvailable = missingQuotes.length === 0;
  const totalUnrealizedPnL = valueAvailable ? totalMarketValue - totalCostBasis : 0;
  // The slice's percent is summed the canonical way, account by account, exactly as summarizeByAccount sums the same
  // accounts, so the combined holdings and the household never round to different percents.
  const positionsUnrealizedPnLPercent = scopePositionsPnLPercent(
    accounts.map((account) => aggregatePositions(txs.filter((t) => t.accountId === account.id))),
    quoteMap,
  );

  for (const r of rows) {
    r.pctOfTotal = valueAvailable && totalMarketValue !== 0
      ? (r.marketValue / totalMarketValue) * 100
      : 0;
  }

  return {
    rows,
    cash: {
      total: cashTotal,
      pctOfTotal: valueAvailable && totalMarketValue !== 0
        ? (cashTotal / totalMarketValue) * 100
        : 0,
      contributors: cashContribs,
    },
    totalMarketValue,
    totalCostBasis,
    totalUnrealizedPnL,
    positionsUnrealizedPnLPercent,
    missingQuotes,
    valueAvailable,
  };
}

/**
 * Decide whether a quote's day-change should be rendered.
 *
 * Rules (per plan v2):
 *   - hide if no `changeBasis` (provider didn't supply a baseline)
 *   - hide if `freshness === 'stale'` (market open but data is from prior session)
 *   - hide if basis is `'open'` (Stooq close-vs-open is misleading)
 *   - hide if basis is `'previousClose'` AND freshness is `'eod'` AND markets
 *     are likely open (handled implicitly: when `eod` during open hours, the
 *     freshness classifier has already labeled it `stale`; this is an extra
 *     belt-and-suspenders guard for `eod` rows shown during regular hours).
 *
 * Returns the `changeBasis` (truthy) when display is allowed, undefined otherwise.
 */
export function dayChangeDisplayBasis(q: {
  changeBasis?: 'previousClose' | 'open' | '24h' | 'provider';
  freshness?: 'live' | 'delayed' | 'eod' | 'stale';
}): 'previousClose' | '24h' | 'provider' | undefined {
  if (!q.changeBasis) return undefined;
  if (q.freshness === 'stale') return undefined;
  if (q.changeBasis === 'open') return undefined;
  return q.changeBasis;
}

/**
 * Compute the human-readable label for a day-change line that's already
 * cleared `dayChangeDisplayBasis` (i.e. the change is OK to show).
 *
 * The brokerage convention is:
 *   - regular session   "Today"        — change vs prior close
 *   - pre-market        "Pre-market"   — change vs prior close
 *   - after-hours       "After hours"  — change vs *today's* close (Nasdaq's
 *                                        baseline switches at 4 PM ET; the
 *                                        number is correct, only the label
 *                                        was wrong)
 *   - closed            "Today"        — frozen at last close, vs prior close
 *
 * Crypto and provider-only baselines override the session label because
 * "Today" or "After hours" doesn't make sense for a 24h rolling window.
 *
 * Returns null when the change shouldn't be labeled (mirrors
 * `dayChangeDisplayBasis` returning undefined). Caller is responsible for
 * showing/hiding the line.
 */
export function dayChangeDisplayLabel(q: {
  changeBasis?: 'previousClose' | 'open' | '24h' | 'provider';
  freshness?: 'live' | 'delayed' | 'eod' | 'stale';
  session?: 'pre-market' | 'regular' | 'after-hours' | 'closed';
}): string | null {
  const basis = dayChangeDisplayBasis(q);
  if (!basis) return null;
  if (basis === '24h') return '24h';
  if (basis === 'provider') return 'Recent';
  // basis === 'previousClose' — the brokerage default. Session decides label.
  switch (q.session) {
    case 'pre-market':  return 'Pre-market';
    case 'after-hours': return 'After hours';
    case 'regular':
    case 'closed':
    default:
      return 'Today';
  }
}
