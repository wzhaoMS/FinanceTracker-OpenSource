import fs from 'node:fs';
import path from 'node:path';

import { aggregatePositions, heldSymbolsAcrossAccounts, positionMarketValue } from '@finance-tracker/shared';
import type { Account, Position, Transaction } from '@finance-tracker/shared';

import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { marketDate } from '../services/symbolHistory.js';
import {
  assertPrivateDirectory,
  assertPrivateFile,
  assertTrustedAncestors,
  batchAclReads,
  batchAclReadsAsync,
  confirmSingleLink,
  createMissingDirectories,
  identityOf,
  lstatOrNull,
  ownedByCurrentUser,
} from './pathSafety.js';

/**
 * Synthetic household for the disposable e2e stack (scripts/e2e-disposable.mjs).
 *
 * Everything is invented: "E2E …" accounts with fake numbers, seeded random
 * walks for prices, and dates relative to `now`, so a seed made today serves
 * every chart range today. The data covers what apps/web/tests/*.e2e.ts
 * exercise: a ~4.5 year ledger for the 1M..ALL replay, returns and the
 * performance tables; observed 5-minute snapshots for 1D/1W; daily closes
 * for every traded symbol plus the QQQ/SPY benchmarks, current through today
 * so the API never asks a provider for history; NBIS and NVDA held; AMD and
 * FNILX bought and fully sold; and same-day trade clusters every month. The
 * metals ledger's gold and silver closes (`holdr:metal:<METAL>`) are seeded
 * too, as the price store keeps them; nothing is fetched, and a Holdr that
 * doesn't fetch values nothing with them (ROOT O110).
 */

/** File that marks a data directory as throwaway. */
export const DISPOSABLE_MARKER = '.holdr-e2e-disposable';

/** Source tag on every seeded price bar, shown in the symbol chart footnote. */
export const SYNTHETIC_SOURCE = 'synthetic';

interface MarketModel {
  symbol: string;
  /** Close on the newest bar. Where apps/web/tests' quote fixtures price the
   *  symbol, this matches them so live values continue the synthetic history. */
  lastClose: number;
  /** Annual log drift and volatility of the random walk. */
  drift: number;
  volatility: number;
}

export const SYNTHETIC_MARKET: readonly MarketModel[] = [
  { symbol: 'NBIS', lastClose: 216.2, drift: 0.42, volatility: 0.55 },
  { symbol: 'NVDA', lastClose: 202.78, drift: 0.38, volatility: 0.45 },
  { symbol: 'MSFT', lastClose: 384.36, drift: 0.12, volatility: 0.24 },
  { symbol: 'GOOGL', lastClose: 358.89, drift: 0.16, volatility: 0.28 },
  { symbol: 'AMZN', lastClose: 247.04, drift: 0.13, volatility: 0.3 },
  { symbol: 'QQQ', lastClose: 723.28, drift: 0.14, volatility: 0.2 },
  { symbol: 'SGOV', lastClose: 100.48, drift: 0, volatility: 0.01 },
  { symbol: 'FBTC', lastClose: 54.96, drift: 0.3, volatility: 0.5 },
  { symbol: 'TSLA', lastClose: 406.55, drift: 0.18, volatility: 0.55 },
  { symbol: 'CEG', lastClose: 250.74, drift: 0.3, volatility: 0.38 },
  { symbol: 'PLTR', lastClose: 129.04, drift: 0.45, volatility: 0.6 },
  { symbol: 'AMD', lastClose: 162.5, drift: 0.15, volatility: 0.48 },
  { symbol: 'FNILX', lastClose: 24.8, drift: 0.11, volatility: 0.17 },
  { symbol: 'SPY', lastClose: 668.4, drift: 0.11, volatility: 0.17 },
];

/** The metals ledger's daily closes are kept under this source, as the read side stores CNBC's series (design v8 §9). */
export const METAL_CLOSE_SOURCE = 'cnbc-spot-daily';

export interface MetalCloseModel {
  metal: 'XAU' | 'XAG';
  lastClose: number;
  drift: number;
  volatility: number;
  decimals: number;
  /** Level shifts: every close from this many business days back is multiplied by the factor (stacking). */
  shifts: ReadonlyArray<{ fromBack: number; factor: number }>;
}

/**
 * Invented spot paths for the Gold page's e2e (never fetched), shaped for the read side's price guard (design v8 §9,
 * D-G3-1): gold moves up 25% twelve business days ago and stays there, so the guard refuses its first three closes at the
 * new level and admits the fourth, and the page notes the move; silver's last eight closes are a unit error (×31, out of
 * silver's band), always refused, so the close silver is valued at is more than five weekdays old (stale, no note).
 */
export const SYNTHETIC_METAL_MARKET: readonly MetalCloseModel[] = [
  { metal: 'XAU', lastClose: 2650.4, drift: 0.1, volatility: 0.12, decimals: 2, shifts: [{ fromBack: 12, factor: 1.25 }] },
  { metal: 'XAG', lastClose: 31.25, drift: 0.05, volatility: 0.16, decimals: 3, shifts: [{ fromBack: 8, factor: 31 }] },
];

/** A metal's daily close as the read side keeps it: `holdr:metal:<METAL>`, never a ticker. */
export interface MetalCloseRow {
  symbol: string;
  t: string;
  close: number;
}

// "Alex" and "Casey" are the owner prefixes the Transactions quick filters
// are hard-coded to ("Alex only" / "Casey only"); everything after them is fake.
const ALEX_BROKERAGE = 'e2e-alex-brokerage';
const ALEX_ROTH = 'e2e-alex-roth';
const CASEY_BROKERAGE = 'e2e-casey-brokerage';
const CASEY_RETIREMENT = 'e2e-casey-retirement';
const CASEY_HSA = 'e2e-casey-hsa';
/** The household's account ids, for callers that bring their own ledger (SyntheticDatasetOptions.ledger). */
export const SYNTHETIC_ACCOUNT_IDS = Object.freeze({
  alexBrokerage: ALEX_BROKERAGE,
  alexRoth: ALEX_ROTH,
  caseyBrokerage: CASEY_BROKERAGE,
  caseyRetirement: CASEY_RETIREMENT,
  caseyHsa: CASEY_HSA,
});

const ACCOUNTS: readonly Account[] = [
  { id: ALEX_BROKERAGE, name: 'Alex · E2E Brokerage', type: 'Individual', accountNumber: 'E2E0000101', cashBalance: 18_250.4, currency: 'USD' },
  { id: ALEX_ROTH, name: 'Alex · E2E Roth IRA', type: 'Roth IRA', accountNumber: 'E2E0000102', cashBalance: 1_204.18, currency: 'USD' },
  { id: CASEY_BROKERAGE, name: 'Casey · E2E Brokerage', type: 'Individual', accountNumber: 'E2E0000201', cashBalance: 9_876.54, currency: 'USD' },
  { id: CASEY_RETIREMENT, name: 'Casey · E2E Retirement', type: '401(k)', accountNumber: 'E2E0000202', cashBalance: 512, currency: 'USD' },
  { id: CASEY_HSA, name: 'Casey · E2E HSA', type: 'HSA', accountNumber: 'E2E0000203', cashBalance: 150.25, currency: 'USD' },
];

const OPENING = 'E2E synthetic opening lot';
const CONTRIBUTION = 'E2E synthetic monthly contribution';
const TRIM = 'E2E synthetic rebalance trim';
const EXIT = 'E2E synthetic position exit';

/** `k` counts business days back from the newest bar (0 = today on a weekday). */
interface TradePlan {
  k: number;
  account: string;
  symbol: string;
  /** Signed share count (a fund's may be fractional); negative sells. */
  shares?: number;
  /** Buy roughly this many dollars at the day's close. */
  dollars?: number;
  /** Sell the account's whole position. */
  sellAll?: boolean;
  notes?: string;
}

/** A trade of a caller's own ledger (SyntheticDatasetOptions.ledger): same shape as the built-in plans. */
export type SyntheticTradePlan = Readonly<TradePlan>;

/** What a caller's ledger is chosen from: the synthetic closes, `k` business days back, and how a trade fills. */
export interface SyntheticMarket {
  close: (symbol: string, k: number) => number;
  /** The price a trade of `quantity` (negative sells) fills at on a day with this close, as the ledger records it. */
  fillPrice: (close: number, quantity: number) => number;
}

/** A caller's own ledger: every trade, and the cash each account holds today (an account left out keeps its own). */
export interface SyntheticLedger {
  trades: readonly SyntheticTradePlan[];
  cashBalances?: Readonly<Record<string, number>>;
}

export interface SyntheticDatasetOptions {
  /** Replaces the metal close models (the demo's have no guard-test shifts). */
  metalMarket?: readonly MetalCloseModel[];
  /**
   * Replaces the built-in ledger (its trades and monthly contributions) and, where it says, the accounts' cash: built
   * before the snapshots, so the observed 1D/1W values hold it too. Unset (every e2e stack): the built-in ledger.
   */
  ledger?: (market: SyntheticMarket) => SyntheticLedger;
}

/** A market order's fill: a few basis points through the close. */
const fillPrice = (close: number, quantity: number): number => roundCents(close * (quantity > 0 ? 1.0015 : 0.9985));

const SPECIAL_TRADES: readonly TradePlan[] = [
  { k: 1150, account: ALEX_BROKERAGE, symbol: 'MSFT', shares: 40, notes: OPENING },
  { k: 1150, account: ALEX_BROKERAGE, symbol: 'GOOGL', shares: 30, notes: OPENING },
  { k: 1150, account: ALEX_BROKERAGE, symbol: 'AMZN', shares: 35, notes: OPENING },
  { k: 1148, account: ALEX_ROTH, symbol: 'QQQ', shares: 20, notes: OPENING },
  { k: 1148, account: ALEX_ROTH, symbol: 'SGOV', shares: 50, notes: OPENING },
  { k: 1145, account: CASEY_BROKERAGE, symbol: 'NVDA', shares: 150, notes: OPENING },
  { k: 1145, account: CASEY_BROKERAGE, symbol: 'TSLA', shares: 20, notes: OPENING },
  { k: 1145, account: CASEY_BROKERAGE, symbol: 'AMD', shares: 60, notes: OPENING },
  { k: 1140, account: CASEY_RETIREMENT, symbol: 'FNILX', shares: 1200, notes: OPENING },
  { k: 1140, account: CASEY_RETIREMENT, symbol: 'QQQ', shares: 10, notes: OPENING },
  { k: 1135, account: CASEY_HSA, symbol: 'SGOV', shares: 30, notes: OPENING },
  { k: 1135, account: CASEY_HSA, symbol: 'MSFT', shares: 5, notes: OPENING },
  { k: 900, account: CASEY_BROKERAGE, symbol: 'TSLA', shares: -5, notes: TRIM },
  { k: 700, account: CASEY_BROKERAGE, symbol: 'AMD', shares: -30, notes: TRIM },
  { k: 600, account: ALEX_ROTH, symbol: 'CEG', shares: 15 },
  { k: 550, account: CASEY_BROKERAGE, symbol: 'NBIS', shares: 100 },
  { k: 520, account: CASEY_RETIREMENT, symbol: 'FNILX', sellAll: true, notes: EXIT },
  { k: 520, account: CASEY_RETIREMENT, symbol: 'QQQ', shares: 30 },
  { k: 480, account: ALEX_BROKERAGE, symbol: 'NBIS', shares: 60 },
  { k: 400, account: ALEX_BROKERAGE, symbol: 'PLTR', shares: 80 },
  { k: 350, account: CASEY_HSA, symbol: 'FBTC', shares: 40 },
  { k: 300, account: CASEY_BROKERAGE, symbol: 'AMD', sellAll: true, notes: EXIT },
  { k: 250, account: CASEY_BROKERAGE, symbol: 'TSLA', shares: -8, notes: TRIM },
  { k: 200, account: CASEY_HSA, symbol: 'FBTC', shares: 25 },
  { k: 120, account: ALEX_BROKERAGE, symbol: 'PLTR', shares: -30, notes: TRIM },
  // NBIS activity inside the default 3M symbol-chart window.
  { k: 58, account: ALEX_BROKERAGE, symbol: 'NBIS', shares: 20 },
  { k: 58, account: CASEY_BROKERAGE, symbol: 'NBIS', shares: 25 },
  { k: 44, account: CASEY_BROKERAGE, symbol: 'NBIS', shares: -15, notes: TRIM },
  { k: 37, account: ALEX_BROKERAGE, symbol: 'NBIS', shares: 10 },
  { k: 23, account: CASEY_BROKERAGE, symbol: 'NBIS', shares: 12 },
  { k: 23, account: CASEY_BROKERAGE, symbol: 'NVDA', shares: 10 },
  { k: 16, account: ALEX_BROKERAGE, symbol: 'NBIS', shares: -5, notes: TRIM },
  { k: 11, account: CASEY_BROKERAGE, symbol: 'NBIS', shares: 8 },
];

/** Symbols each account adds to on its contribution days; `from`/`until`
 *  bound availability in `k` (inclusive / exclusive). */
const SLEEVES: Record<string, ReadonlyArray<{ symbol: string; from?: number; until?: number }>> = {
  [ALEX_BROKERAGE]: [{ symbol: 'MSFT' }, { symbol: 'GOOGL' }, { symbol: 'AMZN' }, { symbol: 'NBIS', from: 480 }, { symbol: 'PLTR', from: 400 }],
  [CASEY_BROKERAGE]: [{ symbol: 'NVDA' }, { symbol: 'TSLA' }, { symbol: 'NBIS', from: 550 }],
  [ALEX_ROTH]: [{ symbol: 'QQQ' }, { symbol: 'SGOV' }, { symbol: 'CEG', from: 600 }],
  [CASEY_RETIREMENT]: [{ symbol: 'FNILX', until: 520 }, { symbol: 'QQQ' }, { symbol: 'GOOGL', from: 520 }],
  [CASEY_HSA]: [{ symbol: 'SGOV' }, { symbol: 'MSFT' }, { symbol: 'FBTC', from: 350 }],
};
const CONTRIBUTION_ORDER = [ALEX_BROKERAGE, CASEY_BROKERAGE, ALEX_ROTH, CASEY_RETIREMENT, CASEY_HSA];
const FIRST_CONTRIBUTION_K = 1130;
const CONTRIBUTION_EVERY = 21;
/** No trades this close to today, so snapshot values move with prices only. */
export const QUIET_BUSINESS_DAYS = 10;

const PRICE_HISTORY_YEARS = 6;
const SNAPSHOT_LOOKBACK_DAYS = 10;
const SNAPSHOT_STEP_MINUTES = 5;
const SESSION_OPEN_MINUTE = 4 * 60;
const REGULAR_CLOSE_MINUTE = 16 * 60;
const SESSION_LAST_MINUTE = 20 * 60 - SNAPSHOT_STEP_MINUTES;

export interface DailyBarRow {
  symbol: string;
  t: string;
  close: number;
  open: number;
  high: number;
  low: number;
  volume: number;
}

export interface SnapshotRow {
  id: string;
  accountId: string;
  takenAt: string;
  marketValue: number;
  costBasis: number;
  cashBalance: number;
}

export interface IntradayBarRow {
  symbol: string;
  t: string;
  close: number;
}

export interface SyntheticDataset {
  /** America/New_York date of `now`. */
  today: string;
  accounts: Account[];
  transactions: Transaction[];
  dailyBars: DailyBarRow[];
  snapshots: SnapshotRow[];
  intradayBars: IntradayBarRow[];
  /** The metals ledger's daily closes (the Gold page values from these; nothing fetches them). */
  metalCloses: MetalCloseRow[];
}

/**
 * Build the household deterministically for `now`. `options.metalMarket` replaces the metal close models (the demo's
 * have no guard-test shifts); `options.ledger` replaces the built-in ledger and, where it says, the accounts' cash.
 */
export function buildSyntheticDataset(now: Date, options: SyntheticDatasetOptions = {}): SyntheticDataset {
  const today = marketDate(now);
  const lastBarDay = isWeekday(today) ? today : previousWeekday(today);
  const days = businessDays(addDays(lastBarDay, -Math.round(PRICE_HISTORY_YEARS * 365.25)), lastBarDay);
  const dayAt = (k: number): string => {
    const day = days[days.length - 1 - k];
    if (!day) throw new Error(`synthetic trade ${k} business days back is before the price history`);
    return day;
  };

  const closes = new Map<string, Map<string, number>>();
  const dailyBars: DailyBarRow[] = [];
  for (const model of SYNTHETIC_MARKET) {
    const series = closeSeries(model, days.length);
    const random = mulberry32(hashSeed(`ohlv:${model.symbol}`));
    const byDay = new Map<string, number>();
    series.forEach((close, index) => {
      const previous = index > 0 ? series[index - 1] : close;
      const open = roundCents(previous * (1 + 0.004 * normal(random)));
      dailyBars.push({
        symbol: model.symbol,
        t: days[index],
        close,
        open,
        high: roundCents(Math.max(open, close) * (1 + 0.006 * Math.abs(normal(random)))),
        low: roundCents(Math.min(open, close) * (1 - 0.006 * Math.abs(normal(random)))),
        volume: Math.round(1_000_000 * (1 + 4 * random())),
      });
      byDay.set(days[index], close);
    });
    closes.set(model.symbol, byDay);
  }
  const closeOn = (symbol: string, day: string): number => {
    const close = closes.get(symbol)?.get(day);
    if (close == null) throw new Error(`no synthetic close for ${symbol} on ${day}`);
    return close;
  };

  const ledger = options.ledger?.({ close: (symbol, k) => closeOn(symbol, dayAt(k)), fillPrice });
  const accounts = ACCOUNTS.map((account) => ({ ...account, cashBalance: ledger?.cashBalances?.[account.id] ?? account.cashBalance }));
  const transactions = buildTransactions(dayAt, closeOn, accounts, ledger?.trades ?? [...SPECIAL_TRADES, ...contributionPlans()]);
  const { snapshots, intradayBars } = buildSnapshots(now, today, days, accounts, transactions, closeOn);
  return {
    today,
    accounts,
    transactions,
    dailyBars,
    snapshots,
    intradayBars,
    metalCloses: buildMetalCloses(days, options.metalMarket ?? SYNTHETIC_METAL_MARKET),
  };
}

/** Each metal's closes on the same business days as the stocks', shifted where its model says. */
function buildMetalCloses(days: readonly string[], market: readonly MetalCloseModel[]): MetalCloseRow[] {
  const rows: MetalCloseRow[] = [];
  for (const model of market) {
    const series = closeSeries({ symbol: `metal:${model.metal}`, lastClose: model.lastClose, drift: model.drift, volatility: model.volatility }, days.length);
    const scale = 10 ** model.decimals;
    series.forEach((close, index) => {
      const back = days.length - 1 - index;
      const factor = model.shifts.reduce((total, shift) => (back < shift.fromBack ? total * shift.factor : total), 1);
      rows.push({ symbol: `holdr:metal:${model.metal}`, t: days[index], close: Math.round(close * factor * scale) / scale });
    });
  }
  return rows;
}

function contributionPlans(): TradePlan[] {
  const plans: TradePlan[] = [];
  for (let month = 0; FIRST_CONTRIBUTION_K - month * CONTRIBUTION_EVERY >= QUIET_BUSINESS_DAYS; month++) {
    const k = FIRST_CONTRIBUTION_K - month * CONTRIBUTION_EVERY;
    const account = CONTRIBUTION_ORDER[month % CONTRIBUTION_ORDER.length];
    const sleeve = SLEEVES[account].filter((entry) => (
      (entry.from === undefined || k <= entry.from) && (entry.until === undefined || k > entry.until)
    ));
    const picks = new Set([sleeve[month % sleeve.length].symbol, sleeve[(month + 1) % sleeve.length].symbol]);
    for (const symbol of picks) {
      plans.push({ k, account, symbol, dollars: 1_500 + 500 * (month % 5), notes: CONTRIBUTION });
    }
  }
  return plans;
}

function buildTransactions(
  dayAt: (k: number) => string,
  closeOn: (symbol: string, day: string) => number,
  accounts: readonly Account[],
  ledger: readonly SyntheticTradePlan[],
): Transaction[] {
  const accountOrder = new Map(accounts.map((account, index) => [account.id, index]));
  const plans = [...ledger]
    .map((plan, index) => ({ plan, index }))
    .sort((left, right) => (
      right.plan.k - left.plan.k
      || accountOrder.get(left.plan.account)! - accountOrder.get(right.plan.account)!
      || left.index - right.index
    ))
    .map(({ plan }) => plan);

  const held = new Map<string, number>();
  const transactions: Transaction[] = [];
  for (const plan of plans) {
    const date = dayAt(plan.k);
    const close = closeOn(plan.symbol, date);
    const key = `${plan.account}\u0000${plan.symbol}`;
    const position = held.get(key) ?? 0;
    const quantity = plan.sellAll
      ? -position
      : plan.shares ?? Math.max(1, Math.round((plan.dollars ?? 0) / close));
    if (quantity === 0 || position + quantity < -1e-9) {
      throw new Error(`synthetic plan sells ${plan.symbol} that ${plan.account} does not hold on ${date}`);
    }
    held.set(key, position + quantity);
    transactions.push({
      id: `e2e-seed-${String(transactions.length + 1).padStart(4, '0')}`,
      accountId: plan.account,
      symbol: plan.symbol,
      date,
      quantity,
      pricePerUnit: fillPrice(close, quantity),
      currency: 'USD',
      ...(plan.notes ? { notes: plan.notes } : {}),
    });
  }
  return transactions;
}

function buildSnapshots(
  now: Date,
  today: string,
  days: string[],
  accounts: readonly Account[],
  transactions: Transaction[],
  closeOn: (symbol: string, day: string) => number,
): { snapshots: SnapshotRow[]; intradayBars: IntradayBarRow[] } {
  const snapshots: SnapshotRow[] = [];
  const intradayBars: IntradayBarRow[] = [];
  const firstDay = addDays(today, -SNAPSHOT_LOOKBACK_DAYS);
  for (let index = 1; index < days.length; index++) {
    const day = days[index];
    if (day < firstDay || day > today) continue;
    const priorDay = days[index - 1];
    const asOfDay = transactions.filter((transaction) => transaction.date <= day);
    const positionsByAccount = new Map<string, Position[]>(accounts.map((account) => [
      account.id,
      aggregatePositions(asOfDay.filter((transaction) => transaction.accountId === account.id)),
    ]));
    const symbols = heldSymbolsAcrossAccounts(asOfDay);
    const paths = new Map(symbols.map((symbol) => [
      symbol,
      intradayPath(symbol, day, closeOn(symbol, priorDay), closeOn(symbol, day)),
    ]));
    for (let minute = SESSION_OPEN_MINUTE; minute <= SESSION_LAST_MINUTE; minute += SNAPSHOT_STEP_MINUTES) {
      const instant = easternInstant(day, minute);
      if (instant.getTime() > now.getTime()) break;
      // Same shape as the live snapshot job: every account at one taken_at.
      const takenAt = instant.toISOString();
      const tick = (minute - SESSION_OPEN_MINUTE) / SNAPSHOT_STEP_MINUTES;
      for (const account of accounts) {
        let marketValue = account.cashBalance;
        let costBasis = account.cashBalance;
        for (const position of positionsByAccount.get(account.id) ?? []) {
          marketValue += positionMarketValue(position, { price: paths.get(position.symbol)![tick] });
          costBasis += position.costBasis;
        }
        snapshots.push({
          id: `snap-${account.id}-${takenAt}`,
          accountId: account.id,
          takenAt,
          marketValue: roundCents(marketValue),
          costBasis: roundCents(costBasis),
          cashBalance: account.cashBalance,
        });
      }
      for (const symbol of symbols) intradayBars.push({ symbol, t: takenAt, close: paths.get(symbol)![tick] });
    }
  }
  return { snapshots, intradayBars };
}

/** One price per snapshot tick: a bridge from the prior close at 04:00 ET to
 *  the day's close at 16:00 ET, then a small after-hours drift. */
function intradayPath(symbol: string, day: string, priorClose: number, close: number): number[] {
  const random = mulberry32(hashSeed(`intraday:${symbol}:${day}`));
  const regularTicks = (REGULAR_CLOSE_MINUTE - SESSION_OPEN_MINUTE) / SNAPSHOT_STEP_MINUTES;
  const totalTicks = (SESSION_LAST_MINUTE - SESSION_OPEN_MINUTE) / SNAPSHOT_STEP_MINUTES + 1;
  const walk = [0];
  for (let tick = 1; tick <= regularTicks; tick++) walk.push(walk[tick - 1] + 0.0012 * normal(random));
  const start = Math.log(priorClose);
  const end = Math.log(close);
  const prices: number[] = [];
  for (let tick = 0; tick <= regularTicks; tick++) {
    const fraction = tick / regularTicks;
    prices.push(roundCents(Math.exp(start + fraction * (end - start) + walk[tick] - fraction * walk[regularTicks])));
  }
  let drift = 0;
  while (prices.length < totalTicks) {
    drift += 0.0004 * normal(random);
    prices.push(roundCents(close * Math.exp(drift)));
  }
  return prices;
}

/** Closes for `count` business days ending at `model.lastClose`: a Brownian
 *  bridge around the drift line, pinned at both ends. */
function closeSeries(model: MarketModel, count: number): number[] {
  const random = mulberry32(hashSeed(`close:${model.symbol}`));
  const end = Math.log(model.lastClose);
  const start = end - model.drift * ((count - 1) / 252);
  const step = model.volatility / Math.sqrt(252);
  const walk = [0];
  for (let index = 1; index < count; index++) walk.push(walk[index - 1] + step * normal(random));
  return walk.map((_, index) => {
    if (index === count - 1) return model.lastClose;
    const fraction = index / (count - 1);
    const value = Math.exp(start + fraction * (end - start) + walk[index] - fraction * walk[count - 1]);
    return Math.max(0.5, roundCents(value));
  });
}

/* ------------------------------------------------------------------ */
/* Writing a disposable data directory                                */
/* ------------------------------------------------------------------ */

export interface SeedResult {
  dataDir: string;
  dbFile: string;
  today: string;
  accounts: number;
  transactions: number;
  dailyBars: number;
  snapshots: number;
  intradayBars: number;
  metalCloses: number;
  firstTradeDate: string;
  lastTradeDate: string;
  latestSnapshot: string | null;
  heldSymbols: string[];
}

/** Tables that must be empty before seeding: rows there could be real data. */
const GUARDED_TABLES = [
  'accounts',
  'transactions',
  'account_snapshots',
  'symbol_price_bars',
  'account_cash_events',
  'account_cash_history',
  'account_nav_history',
  'manual_prices',
] as const;

/** Write the synthetic household into an empty repo. */
export function seedSyntheticHousehold(repo: SqliteStateRepo, now: Date = new Date()): SyntheticDataset {
  return writeSyntheticDataset(repo, buildSyntheticDataset(now));
}

/** Write `dataset` into an empty repo (refused when any guarded table has rows: they could be real data). */
export function writeSyntheticDataset(repo: SqliteStateRepo, dataset: SyntheticDataset): SyntheticDataset {
  const db = repo.internalGetDb();
  const occupied = GUARDED_TABLES.filter((table) => (
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n > 0
  ));
  if (occupied.length > 0) {
    throw new Error(`refusing to seed: the database already has rows in ${occupied.join(', ')}`);
  }
  const insertDailyBar = db.prepare(
    `INSERT INTO symbol_price_bars (symbol, range_kind, t, close, open, high, low, volume, source)
     VALUES (?, 'daily', ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertIntradayBar = db.prepare(
    `INSERT INTO symbol_price_bars (symbol, range_kind, t, close, source) VALUES (?, 'intraday', ?, ?, ?)`,
  );
  const insertMetalClose = db.prepare(
    `INSERT INTO symbol_price_bars (symbol, range_kind, t, close, source) VALUES (?, 'daily', ?, ?, ?)`,
  );
  const insertSnapshot = db.prepare(
    `INSERT INTO account_snapshots (id, account_id, taken_at, market_value, cost_basis, cash_balance)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const account of dataset.accounts) repo.createAccount(account);
    // Ledger rows go in before any snapshot exists, so none of them is
    // recorded as a late import that invalidates captured history.
    for (const transaction of dataset.transactions) repo.createTransaction(transaction);
    for (const bar of dataset.dailyBars) {
      insertDailyBar.run(bar.symbol, bar.t, bar.close, bar.open, bar.high, bar.low, bar.volume, SYNTHETIC_SOURCE);
    }
    for (const bar of dataset.intradayBars) insertIntradayBar.run(bar.symbol, bar.t, bar.close, SYNTHETIC_SOURCE);
    for (const row of dataset.metalCloses) insertMetalClose.run(row.symbol, row.t, row.close, METAL_CLOSE_SOURCE);
    for (const row of dataset.snapshots) {
      insertSnapshot.run(row.id, row.accountId, row.takenAt, row.marketValue, row.costBasis, row.cashBalance);
    }
  })();
  return dataset;
}

/** True for `…/apps/api/data` (the API's default, i.e. the live database on a
 *  deployed checkout) and anything inside it. */
export function isInsideApiDataDir(candidate: string): boolean {
  const parts = path.resolve(candidate).split(path.sep).map((part) => part.toLowerCase());
  return parts.some((part, index) => part === 'apps' && parts[index + 1] === 'api' && parts[index + 2] === 'data');
}

/** Whether `target`, as written or with its existing part resolved through
 *  symlinks, is inside an `apps/api/data` directory. */
export function resolvesIntoApiDataDir(target: string): boolean {
  return isInsideApiDataDir(target) || isInsideApiDataDir(realTarget(path.resolve(target)));
}

const MARKER_TEXT = 'Synthetic Holdr e2e data. Safe to delete.\n';
/** The database and the files SQLite keeps next to it. */
const DATABASE_FILES = ['finance.db', 'finance.db-wal', 'finance.db-shm', 'finance.db-journal'] as const;
/** Create-only: fails on any existing entry, a symlink included. */
const CREATE_EXCLUSIVE = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
  | (fs.constants.O_NOFOLLOW ?? 0);

/** Allow only a regular file of ours that nothing else links to: writing
 *  through a symlink or hard link could reach a real database. On Windows
 *  its own owner and ACL are checked too (assertPrivateFile). */
function assertPlainFile(target: string): void {
  const stats = lstatOrNull(target);
  if (!stats) return;
  if (stats.isSymbolicLink()) throw new Error(`${target} is a symbolic link`);
  if (!stats.isFile()) throw new Error(`${target} is not a regular file`);
  if (stats.nlink !== 1) throw new Error(`${target} has ${stats.nlink} hard links`);
  if (!ownedByCurrentUser(stats)) throw new Error(`${target} belongs to another user`);
  confirmSingleLink(target);
  assertPrivateFile(target);
}

function createExclusive(target: string, contents = ''): void {
  const descriptor = fs.openSync(target, CREATE_EXCLUSIVE, 0o600);
  try {
    if (contents) fs.writeSync(descriptor, contents);
  } finally {
    fs.closeSync(descriptor);
  }
}

/** `target` with its deepest existing ancestor resolved through symlinks. */
function realTarget(target: string): string {
  let existing = target;
  const rest: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return target;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...rest);
}

/** The apps/api/data path `target` names or resolves to, if any. */
function liveDataDir(target: string): string | null {
  for (const candidate of [target, realTarget(target)]) {
    if (isInsideApiDataDir(candidate)) return candidate;
  }
  return null;
}

/**
 * Read-only: throw unless `dataDir` is a disposable e2e data directory, and
 * return its physical path. It must be outside apps/api/data (also through
 * symlinks), a plain directory of ours that no one else can write to, below
 * directories no one else can write to up to the user's home or this
 * checkout (pathSafety.ts), and hold what assertDisposableEntries allows.
 * Nothing is created or changed, the marker included. The seed runs this
 * before it writes; an API started with HOLDR_E2E_RUN_ID runs it before it
 * opens the database, and again before each open, after the SQLite open
 * and on every /health (runIdentity.ts). On Windows the directory, the ones
 * above it and its files are read in one PowerShell call, every time.
 */
export function assertDisposableDataDir(dataDir: string): string {
  return batchAclReads(() => disposableDataDirChecks(dataDir));
}

/** assertDisposableDataDir with its PowerShell call off the event loop (the API's /health). */
export function assertDisposableDataDirAsync(dataDir: string): Promise<string> {
  return batchAclReadsAsync(() => disposableDataDirChecks(dataDir));
}

function disposableDataDirChecks(dataDir: string): string {
  const requested = path.resolve(dataDir);
  if (/[\r\n]/.test(requested)) throw new Error('the data directory path contains a line break');
  const live = liveDataDir(requested);
  if (live) throw new Error(`${live} is inside apps/api/data, the API's default (live) data directory`);
  assertPrivateDirectory(requested);
  const resolved = fs.realpathSync(requested);
  if (isInsideApiDataDir(resolved)) {
    throw new Error(`${resolved} is inside apps/api/data, the API's default (live) data directory`);
  }
  assertTrustedAncestors(resolved);
  assertDisposableEntries(resolved);
  return resolved;
}

/**
 * Read-only: `dir` must hold the seed's marker and nothing but SQLite's own
 * files, each a regular, singly linked file of ours. A symlink or hard link
 * could lead to a real database. On Windows each file's owner and ACL must
 * pass too, all read in one PowerShell call (assertPrivateFile).
 */
export function assertDisposableEntries(dir: string): void {
  batchAclReads(() => {
    const entries = fs.readdirSync(dir);
    if (!entries.includes(DISPOSABLE_MARKER)) {
      throw new Error(entries.length > 0
        ? `${dir} already has files and no ${DISPOSABLE_MARKER} marker; use a new directory for a disposable stack`
        : `${dir} has no ${DISPOSABLE_MARKER} marker`);
    }
    for (const entry of entries) {
      if (entry !== DISPOSABLE_MARKER && !(DATABASE_FILES as readonly string[]).includes(entry)) {
        throw new Error(`unexpected ${entry} next to the marker in ${dir}`);
      }
      assertPlainFile(path.join(dir, entry));
    }
  });
}

/**
 * Refuse any target that could hold real data, then create and mark it. A
 * missing directory is created (0700) and an empty one is marked, both
 * exclusively, only after the directory and everything above it have passed
 * the checks; an existing marker is never rewritten. The result must then
 * pass assertDisposableDataDir. Returns the directory's physical path.
 */
export function prepareDisposableDataDir(dataDir: string): string {
  const requested = path.resolve(dataDir);
  if (/[\r\n]/.test(requested)) throw new Error('refusing to seed: the data directory path contains a line break');
  const live = liveDataDir(requested);
  if (live) throw new Error(`refusing to seed ${live}: apps/api/data is the API's default (live) data directory`);
  try {
    createMissingDirectories(requested);
    assertPrivateDirectory(requested);
    const resolved = fs.realpathSync(requested);
    if (isInsideApiDataDir(resolved)) {
      throw new Error(`${resolved} is inside apps/api/data, the API's default (live) data directory`);
    }
    assertTrustedAncestors(resolved);
    if (fs.readdirSync(resolved).length === 0) createExclusive(path.join(resolved, DISPOSABLE_MARKER), MARKER_TEXT);
    return assertDisposableDataDir(resolved);
  } catch (error) {
    throw new Error(`refusing to seed ${requested}: ${(error as Error).message}`);
  }
}

/** Guard, then seed `<dataDir>/finance.db`, the file HOLDR_DATA_DIR points the API at. */
export function seedDisposableDataDir(dataDir: string, now: Date = new Date()): SeedResult {
  const resolved = prepareDisposableDataDir(dataDir);
  const dbFile = path.join(resolved, 'finance.db');
  // SQLite follows links, so check the files again right before opening them
  // writable, and create a missing database exclusively so it is our file.
  try {
    batchAclReads(() => {
      for (const name of DATABASE_FILES) assertPlainFile(path.join(resolved, name));
    });
  } catch (error) {
    throw new Error(`refusing to seed: ${(error as Error).message}`);
  }
  if (!lstatOrNull(dbFile)) createExclusive(dbFile);
  // Exact identities (bigints: NTFS file IDs can exceed 2^53), compared as identityOf does.
  const checked = fs.lstatSync(dbFile, { bigint: true });
  const repo = new SqliteStateRepo({ file: dbFile, now: () => now });
  try {
    const opened = fs.lstatSync(dbFile, { bigint: true });
    if (identityOf(opened) !== identityOf(checked) || opened.isSymbolicLink()) {
      throw new Error(`refusing to seed: ${dbFile} was replaced while it was being opened`);
    }
    const dataset = seedSyntheticHousehold(repo, now);
    const dates = dataset.transactions.map((transaction) => transaction.date).sort();
    return {
      dataDir: resolved,
      dbFile,
      today: dataset.today,
      accounts: dataset.accounts.length,
      transactions: dataset.transactions.length,
      dailyBars: dataset.dailyBars.length,
      snapshots: dataset.snapshots.length,
      intradayBars: dataset.intradayBars.length,
      metalCloses: dataset.metalCloses.length,
      firstTradeDate: dates[0],
      lastTradeDate: dates[dates.length - 1],
      latestSnapshot: dataset.snapshots.at(-1)?.takenAt ?? null,
      heldSymbols: heldSymbolsAcrossAccounts(dataset.transactions),
    };
  } finally {
    repo.close();
  }
}

/* ------------------------------------------------------------------ */
/* Calendar and randomness helpers                                    */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;
const EASTERN_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function isWeekday(day: string): boolean {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

function previousWeekday(day: string): string {
  let candidate = addDays(day, -1);
  while (!isWeekday(candidate)) candidate = addDays(candidate, -1);
  return candidate;
}

/** Weekdays from `from` to `to`, inclusive; like the API, no holiday calendar. */
function businessDays(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    if (isWeekday(day)) days.push(day);
  }
  return days;
}

function easternMinute(instant: Date): number {
  const parts = EASTERN_CLOCK.formatToParts(instant);
  return Number(parts.find((part) => part.type === 'hour')?.value) * 60
    + Number(parts.find((part) => part.type === 'minute')?.value);
}

/** The instant a New York wall clock reads `minute` past midnight on `day`. */
function easternInstant(day: string, minute: number): Date {
  for (const offsetHours of [4, 5]) {
    const candidate = new Date(Date.parse(`${day}T00:00:00Z`) + (minute + offsetHours * 60) * 60_000);
    if (marketDate(candidate) === day && easternMinute(candidate) === minute) return candidate;
  }
  throw new Error(`no America/New_York instant for ${day} at minute ${minute}`);
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function hashSeed(text: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/** Small deterministic PRNG (mulberry32): the same seed gives the same data. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function normal(random: () => number): number {
  const u = Math.max(random(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}
