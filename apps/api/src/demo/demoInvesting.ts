import {
  QUIET_BUSINESS_DAYS,
  SYNTHETIC_ACCOUNT_IDS,
  type SyntheticLedger,
  type SyntheticMarket,
  type SyntheticTradePlan,
} from '../e2e/syntheticSeed.js';

/**
 * The demo household's investing, at the scale of a young couple a few years into saving: about $60,000 across Alex's
 * brokerage account and Roth IRA and Casey's brokerage account, 401(k) and HSA. Opening positions about four and a half
 * years ago, then every month each account's contribution (DEMO_MONTHLY_CONTRIBUTIONS, the same amounts the deposits
 * and the checking account's transfers show) buys whole shares of the next holding it can afford, in turn, and the
 * 401(k) buys its index fund in fractional shares. Along the way: trims and an exit (their proceeds stay in the account
 * and are invested again), new positions, a crypto ETF in the HSA, and one stock Alex bought near its high that is held
 * at a loss today. Deterministic: every choice reads the synthetic closes.
 */

const IDS = SYNTHETIC_ACCOUNT_IDS;
export type DemoInvestingAccount = keyof typeof SYNTHETIC_ACCOUNT_IDS;

/** Dollars a month into each account. The 401(k)'s comes from two paychecks, the HSA's from one. */
export const DEMO_MONTHLY_CONTRIBUTIONS: Readonly<Record<DemoInvestingAccount, number>> = Object.freeze({
  alexBrokerage: 80,
  alexRoth: 150,
  caseyBrokerage: 25,
  caseyRetirement: 360,
  caseyHsa: 45,
});

const OPENING = 'Opening position';
const CONTRIBUTION = 'Monthly contribution';
const PAYROLL = 'Payroll contribution';
const TRIM = 'Rebalance trim';
const EXIT = 'Position exit';
const NEW = 'New position';

/** Bought, sold and opened on their own days, whatever the month's money (a bonus, a gift, a rollover). */
const FIXED_TRADES: readonly SyntheticTradePlan[] = [
  { k: 1150, account: IDS.alexBrokerage, symbol: 'MSFT', shares: 3, notes: OPENING },
  { k: 1150, account: IDS.alexBrokerage, symbol: 'GOOGL', shares: 4, notes: OPENING },
  { k: 1150, account: IDS.alexBrokerage, symbol: 'AMZN', shares: 5, notes: OPENING },
  { k: 1148, account: IDS.alexRoth, symbol: 'QQQ', shares: 2, notes: OPENING },
  { k: 1148, account: IDS.alexRoth, symbol: 'SGOV', shares: 5, notes: OPENING },
  { k: 1145, account: IDS.caseyBrokerage, symbol: 'NVDA', shares: 5, notes: OPENING },
  { k: 1145, account: IDS.caseyBrokerage, symbol: 'TSLA', shares: 2, notes: OPENING },
  { k: 1145, account: IDS.caseyBrokerage, symbol: 'AMD', shares: 4, notes: OPENING },
  { k: 1135, account: IDS.caseyHsa, symbol: 'SGOV', shares: 5, notes: OPENING },
  { k: 900, account: IDS.caseyBrokerage, symbol: 'TSLA', shares: -1, notes: TRIM },
  { k: 700, account: IDS.caseyBrokerage, symbol: 'AMD', shares: -2, notes: TRIM },
  { k: 600, account: IDS.alexRoth, symbol: 'CEG', shares: 3, notes: NEW },
  { k: 550, account: IDS.caseyBrokerage, symbol: 'NBIS', shares: 4, notes: NEW },
  { k: 480, account: IDS.alexBrokerage, symbol: 'NBIS', shares: 8, notes: NEW },
  { k: 400, account: IDS.alexBrokerage, symbol: 'PLTR', shares: 10, notes: NEW },
  { k: 350, account: IDS.caseyHsa, symbol: 'FBTC', shares: 8, notes: NEW },
  { k: 300, account: IDS.caseyBrokerage, symbol: 'AMD', sellAll: true, notes: EXIT },
  { k: 250, account: IDS.caseyBrokerage, symbol: 'TSLA', shares: -1, notes: TRIM },
  { k: 200, account: IDS.caseyHsa, symbol: 'FBTC', shares: 5 },
  { k: 120, account: IDS.alexBrokerage, symbol: 'PLTR', shares: -4, notes: TRIM },
  // NBIS activity inside the default three-month window of its chart.
  { k: 58, account: IDS.alexBrokerage, symbol: 'NBIS', shares: 2 },
  { k: 58, account: IDS.caseyBrokerage, symbol: 'NBIS', shares: 3 },
  { k: 44, account: IDS.caseyBrokerage, symbol: 'NBIS', shares: -2, notes: TRIM },
  { k: 37, account: IDS.alexBrokerage, symbol: 'NBIS', shares: 1 },
  { k: 23, account: IDS.caseyBrokerage, symbol: 'NVDA', shares: 1 },
  { k: 16, account: IDS.alexBrokerage, symbol: 'NBIS', shares: -1, notes: TRIM },
  { k: 11, account: IDS.caseyBrokerage, symbol: 'NBIS', shares: 1 },
];

/** The 401(k)'s rollover into its index fund, in dollars (fractional shares). */
const ROLLOVER = { k: 1140, dollars: 2_000 } as const;

/** What each month's money buys: whole shares of these in turn (each from `from`, `k` days back, on), or a fund. */
const MONTHLY_PLANS: ReadonlyArray<{ account: DemoInvestingAccount; sleeve?: ReadonlyArray<{ symbol: string; from?: number }>; fund?: string }> = [
  { account: 'alexBrokerage', sleeve: [{ symbol: 'MSFT' }, { symbol: 'GOOGL' }, { symbol: 'AMZN' }, { symbol: 'NBIS', from: 480 }, { symbol: 'PLTR', from: 400 }] },
  { account: 'alexRoth', sleeve: [{ symbol: 'QQQ' }, { symbol: 'SGOV' }, { symbol: 'CEG', from: 600 }] },
  { account: 'caseyBrokerage', sleeve: [{ symbol: 'NVDA' }, { symbol: 'TSLA' }, { symbol: 'NBIS', from: 550 }] },
  { account: 'caseyRetirement', fund: 'FNILX' },
  { account: 'caseyHsa', sleeve: [{ symbol: 'SGOV' }, { symbol: 'MSFT' }, { symbol: 'FBTC', from: 350 }] },
];

/** The first month's contribution, `k` business days back, and one every 21 business days until the quiet days. */
const FIRST_CONTRIBUTION_K = 1130;
const CONTRIBUTION_EVERY = 21;

/** The volatile stocks the position bought near a high is chosen from, and what it cost. */
const LOSER_CANDIDATES = ['AMD', 'TSLA', 'FBTC'] as const;
const LOSER_DOLLARS = 900;

const cents = (value: number) => Math.round(value * 100) / 100;
const thousandths = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Alex's position bought near a high: the candidate whose close between one and twelve months back stood furthest
 * above today's, if any stood more than 4% above it.
 */
function losingPosition(market: SyntheticMarket): SyntheticTradePlan[] {
  let peak: { symbol: string; k: number; ratio: number } | null = null;
  for (const symbol of LOSER_CANDIDATES) {
    for (let k = 21; k <= 250; k += 1) {
      const ratio = market.close(symbol, k) / market.close(symbol, 0);
      if (!peak || ratio > peak.ratio) peak = { symbol, k, ratio };
    }
  }
  if (!peak || peak.ratio <= 1.04) return [];
  const shares = Math.max(1, Math.round(LOSER_DOLLARS / market.close(peak.symbol, peak.k)));
  return [{ k: peak.k, account: IDS.alexBrokerage, symbol: peak.symbol, shares, notes: NEW }];
}

/**
 * The household's ledger for the synthetic market: the fixed trades, the 401(k)'s rollover, the position bought near a
 * high and every month's contributions, with the cash each account holds today (what its contributions and sales left
 * unspent). Walked in the order the ledger is written (newest `k` last; within a day, by account, fixed trades first),
 * so every sale finds the shares it sells.
 */
export function demoLedger(market: SyntheticMarket): SyntheticLedger {
  const accountOrder = MONTHLY_PLANS.map((plan) => IDS[plan.account]);
  const fixed = [
    ...FIXED_TRADES,
    { k: ROLLOVER.k, account: IDS.caseyRetirement, symbol: 'FNILX', shares: thousandths(ROLLOVER.dollars / market.close('FNILX', ROLLOVER.k)), notes: OPENING },
    ...losingPosition(market),
  ];
  const contributionDays: number[] = [];
  for (let k = FIRST_CONTRIBUTION_K; k >= QUIET_BUSINESS_DAYS; k -= CONTRIBUTION_EVERY) contributionDays.push(k);
  const days = [...new Set([...fixed.map((trade) => trade.k), ...contributionDays])].sort((a, b) => b - a);

  const held = new Map<string, number>();
  const cash = new Map<string, number>(accountOrder.map((id) => [id, 0]));
  const turn = new Map<string, number>(accountOrder.map((id) => [id, 0]));
  const trades: SyntheticTradePlan[] = [];
  const record = (trade: SyntheticTradePlan, quantity: number) => {
    const key = `${trade.account}\u0000${trade.symbol}`;
    held.set(key, (held.get(key) ?? 0) + quantity);
    // Fixed buys bring their own money; a sale's proceeds stay in the account for the next contribution to invest.
    if (quantity < 0) cash.set(trade.account, cents(cash.get(trade.account)! - quantity * market.fillPrice(market.close(trade.symbol, trade.k), quantity)));
    trades.push(trade);
  };

  for (const k of days) {
    for (const account of accountOrder) {
      for (const trade of fixed.filter((entry) => entry.k === k && entry.account === account)) {
        const quantity = trade.sellAll ? -(held.get(`${account}\u0000${trade.symbol}`) ?? 0) : trade.shares!;
        record(trade, quantity);
      }
      if (!contributionDays.includes(k)) continue;
      const plan = MONTHLY_PLANS.find((entry) => IDS[entry.account] === account)!;
      let pool = cents(cash.get(account)! + DEMO_MONTHLY_CONTRIBUTIONS[plan.account]);
      if (plan.fund) {
        // A fund takes the whole contribution, in fractional shares to the thousandth.
        const price = market.fillPrice(market.close(plan.fund, k), 1);
        const shares = thousandths(pool / price);
        record({ k, account, symbol: plan.fund, shares, notes: PAYROLL }, shares);
        pool = 0;
      } else {
        const sleeve = plan.sleeve!.filter((entry) => entry.from === undefined || k <= entry.from);
        const symbol = sleeve[turn.get(account)! % sleeve.length].symbol;
        const price = market.fillPrice(market.close(symbol, k), 1);
        const shares = Math.floor(pool / price);
        // Not enough for one share yet: the money waits for next month.
        if (shares >= 1) {
          record({ k, account, symbol, shares, notes: CONTRIBUTION }, shares);
          pool = cents(pool - shares * price);
          turn.set(account, turn.get(account)! + 1);
        }
      }
      cash.set(account, pool);
    }
  }
  return { trades, cashBalances: Object.fromEntries(cash) };
}
