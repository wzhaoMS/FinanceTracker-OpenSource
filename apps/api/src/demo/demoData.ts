import {
  CARD_CATEGORY_AIRLINE,
  CARD_CATEGORY_BAR_CAFE,
  CARD_CATEGORY_BOOK_STORES,
  CARD_CATEGORY_CLOTHING_STORES,
  CARD_CATEGORY_FUEL,
  CARD_CATEGORY_FURNISHING,
  CARD_CATEGORY_GROCERIES,
  CARD_CATEGORY_INTERNET_PURCHASE,
  CARD_CATEGORY_LODGING,
  CARD_CATEGORY_PHARMACIES,
  CARD_CATEGORY_RESTAURANT,
  CARD_CATEGORY_SPORTING_GOODS_STORES,
  CARD_CATEGORY_TAXIS_COACH,
  CARD_CATEGORY_VEHICLE_RENTAL,
  CARD_CATEGORY_WHOLESALE_STORES,
  type CardTransactionKind,
  type CashEventInput,
  type CashEventType,
  type CheckingImportPayload,
  type ValidCardScheduleObservation,
} from '@finance-tracker/shared';
import type { MetalsImportPayload, MetalsLine, MetalsOrder } from '@finance-tracker/shared/metals-ledger';
import { metalsDigest } from '@finance-tracker/shared/metals-ledger';
import { metalItem, syntheticCoverage, syntheticKey, syntheticOrder, syntheticPayload } from '@finance-tracker/shared/metals-ledger-fixtures';

import {
  SYNTHETIC_ACCOUNT_IDS,
  SYNTHETIC_METAL_MARKET,
  buildSyntheticDataset,
  type MetalCloseModel,
  type MetalCloseRow,
  type SyntheticDataset,
} from '../e2e/syntheticSeed.js';
import { marketDate } from '../services/symbolHistory.js';
import { buildDemoCheckingPayload, buildDemoObservations, buildDemoStatements, DEMO_CHECKING, type DemoCheckingEntry, type DemoStatement } from './demoBanking.js';
import { buildDemoBenefitCredits } from './demoBenefits.js';
import { addDays, addMonths, dayOf, daysIn, isWeekend, lastDayOf, pickBetween, seededRandom, sha256Hex, weekdayOnOrBefore } from './demoCalendar.js';
import { DEMO_SPENDING_MONTHS, demoHistoryStart, type DemoBenefitMark, type DemoCardKey, type DemoCardRow } from './demoCards.js';
import { DEMO_MONTHLY_CONTRIBUTIONS, demoLedger } from './demoInvesting.js';

export { DEMO_CARDS, DEMO_SPENDING_MONTHS, demoHistoryStart, type DemoBenefitMark, type DemoCard, type DemoCardKey, type DemoCardRow } from './demoCards.js';
export { DEMO_CHECKING } from './demoBanking.js';

/**
 * The demo household for `npm run demo`: a fictional couple, Alex and Casey, with about $60,000 invested in five
 * accounts (demoInvesting.ts: whole shares bought month by month, an index fund in the 401(k), one position held at a
 * loss), its dividends, interest and contributions, a little gold and silver bought and sold over the years, fifteen
 * months of everyday spending on five cards (three of them premium cards whose statement credits fill the Benefits
 * tab), each card's statements and autopay, and the joint checking account that pays them. Everything is invented and
 * deterministic for a given day: merchants are fictional (save the benefit partners a credit names), card endings are
 * fixed synthetic values, prices are seeded random walks, and nothing comes from a real statement or account.
 */

export const DEMO_USER = 'demo';
/** The card import source and parser version every demo row carries. */
export const DEMO_CARD_SOURCE = 'demo-csv';
export const DEMO_CARD_PARSER = 'demo-1';
export const DEMO_METALS_ACCOUNT = 'Demo bullion purchases';
export const DEMO_METALS_SALES_ACCOUNT = 'Demo bullion sales';
/** The card the bullion orders name: not one of DEMO_CARDS (the household keeps it out of Holdr). */
export const DEMO_METALS_CARD_LAST4 = '4004';

/** The metal spot models without the e2e guard tests' level shifts. */
export const DEMO_METAL_MARKET: readonly MetalCloseModel[] = SYNTHETIC_METAL_MARKET.map((model) => ({ ...model, shifts: [] }));

/* ------------------------------------------------------------------ */
/* Portfolio                                                          */
/* ------------------------------------------------------------------ */

const demoAccountId = (id: string) => id.replace(/^e2e-/, 'demo-');
/** The demo's five investment accounts (the synthetic household's, renamed). */
export const DEMO_ACCOUNT_IDS: readonly string[] = Object.freeze(Object.values(SYNTHETIC_ACCOUNT_IDS).map(demoAccountId));

/** The synthetic portfolio for `now`, with demo names, ids and account numbers, clean metal closes and the demo's own ledger. */
export function buildDemoPortfolio(now: Date): SyntheticDataset {
  const dataset = buildSyntheticDataset(now, { metalMarket: DEMO_METAL_MARKET, ledger: demoLedger });
  return {
    ...dataset,
    accounts: dataset.accounts.map((account) => ({
      ...account,
      id: demoAccountId(account.id),
      name: account.name.replace(' E2E ', ' '),
      accountNumber: account.accountNumber?.replace(/^E2E0*/, 'DEMO-'),
    })),
    transactions: dataset.transactions.map((transaction) => ({
      ...transaction,
      id: transaction.id.replace(/^e2e-seed-/, 'demo-trade-'),
      accountId: demoAccountId(transaction.accountId),
    })),
    snapshots: dataset.snapshots.map((snapshot) => ({
      ...snapshot,
      id: snapshot.id.replace('-e2e-', '-demo-'),
      accountId: demoAccountId(snapshot.accountId),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Dividends, interest and contributions                              */
/* ------------------------------------------------------------------ */

/** Months of brokerage cash activity before the current one. */
const CASH_EVENT_MONTHS = 24;

/** Annual yields paid out as dividends: SGOV monthly, the others quarterly (FNILX once a year, in December). */
const DIVIDENDS: ReadonlyArray<{ symbol: string; yield: number; months: readonly number[]; day: number }> = [
  { symbol: 'SGOV', yield: 0.045, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], day: 3 },
  { symbol: 'QQQ', yield: 0.006, months: [3, 6, 9, 12], day: 24 },
  { symbol: 'MSFT', yield: 0.008, months: [3, 6, 9, 12], day: 12 },
  { symbol: 'GOOGL', yield: 0.004, months: [3, 6, 9, 12], day: 16 },
  { symbol: 'FNILX', yield: 0.012, months: [12], day: 20 },
];

const nextWeekday = (date: string) => {
  let day = date;
  while (isWeekend(day)) day = addDays(day, 1);
  return day;
};
const cents = (value: number) => Math.round(value * 100) / 100;

/**
 * The brokerage accounts' cash activity over the last two years: dividends on what each account held that day,
 * interest on the brokerage accounts' cash, and money added (the monthly transfers from checking to both brokerage
 * accounts and the Roth IRA, and payroll contributions to the 401(k) and the HSA, as demoInvesting.ts invests them).
 * Amounts are dollars, as brokers report them.
 */
export function buildDemoCashEvents(portfolio: SyntheticDataset, today: string): CashEventInput[] {
  const events: CashEventInput[] = [];
  const closes = new Map<string, Array<{ t: string; close: number }>>();
  for (const bar of portfolio.dailyBars) closes.set(bar.symbol, [...(closes.get(bar.symbol) ?? []), { t: bar.t, close: bar.close }]);
  const closeOn = (symbol: string, date: string) => {
    let found: number | null = null;
    for (const bar of closes.get(symbol) ?? []) {
      if (bar.t > date) break;
      found = bar.close;
    }
    return found;
  };
  const heldOn = (accountId: string, symbol: string, date: string) => portfolio.transactions
    .filter((transaction) => transaction.accountId === accountId && transaction.symbol === symbol && transaction.date <= date)
    .reduce((total, transaction) => total + transaction.quantity, 0);
  const add = (accountId: string, date: string, eventType: CashEventType, amount: number, description: string) => {
    if (date > today || amount === 0) return;
    const account = portfolio.accounts.find((entry) => entry.id === accountId)!;
    events.push({
      accountId, date, eventType, amount: cents(amount), currency: 'USD', broker: 'demo-broker',
      accountLast4: (account.accountNumber ?? '').replace(/\D/g, '').padStart(4, '0').slice(-4),
      description,
      sourceFingerprint: sha256Hex(`holdr-demo-cash:${accountId}:${date}:${eventType}:${description}`),
    });
  };
  const ids = Object.fromEntries(Object.entries(SYNTHETIC_ACCOUNT_IDS).map(([key, id]) => [key, id.replace(/^e2e-/, 'demo-')])) as
    Record<keyof typeof SYNTHETIC_ACCOUNT_IDS, string>;
  for (let month = addMonths(today.slice(0, 7), -CASH_EVENT_MONTHS); month <= today.slice(0, 7); month = addMonths(month, 1)) {
    const monthNumber = Number(month.slice(5, 7));
    for (const account of portfolio.accounts) {
      for (const dividend of DIVIDENDS) {
        if (!dividend.months.includes(monthNumber)) continue;
        const date = nextWeekday(dayOf(month, dividend.day));
        const shares = heldOn(account.id, dividend.symbol, date);
        const close = closeOn(dividend.symbol, date);
        if (shares <= 0 || close === null) continue;
        const amount = (shares * close * dividend.yield) / dividend.months.length;
        if (amount >= 0.01) add(account.id, date, 'dividend', amount, `DIVIDEND RECEIVED ${dividend.symbol}`);
      }
    }
    const monthEnd = weekdayOnOrBefore(lastDayOf(month));
    for (const id of [ids.alexBrokerage, ids.caseyBrokerage]) {
      const cash = portfolio.accounts.find((account) => account.id === id)?.cashBalance ?? 0;
      add(id, monthEnd, 'interest', (cash * 0.04) / 12, 'INTEREST EARNED ON CASH');
    }
    // The month's contributions (demoInvesting.ts): the transfers the joint checking account sends the day before
    // (demoBanking.ts), and Casey's payroll deductions on Casey's paydays.
    const received = nextWeekday(dayOf(month, 6));
    add(ids.alexBrokerage, received, 'deposit', DEMO_MONTHLY_CONTRIBUTIONS.alexBrokerage, 'ELECTRONIC FUNDS TRANSFER RECEIVED');
    add(ids.caseyBrokerage, received, 'deposit', DEMO_MONTHLY_CONTRIBUTIONS.caseyBrokerage, 'ELECTRONIC FUNDS TRANSFER RECEIVED');
    add(ids.alexRoth, received, 'deposit', DEMO_MONTHLY_CONTRIBUTIONS.alexRoth, 'IRA CONTRIBUTION CURRENT YEAR');
    const payday = weekdayOnOrBefore(dayOf(month, 15));
    add(ids.caseyRetirement, payday, 'deposit', DEMO_MONTHLY_CONTRIBUTIONS.caseyRetirement / 2, 'PAYROLL CONTRIBUTION');
    add(ids.caseyRetirement, monthEnd, 'deposit', DEMO_MONTHLY_CONTRIBUTIONS.caseyRetirement / 2, 'PAYROLL CONTRIBUTION');
    add(ids.caseyHsa, payday, 'deposit', DEMO_MONTHLY_CONTRIBUTIONS.caseyHsa, 'HSA PAYROLL CONTRIBUTION');
  }
  return events.sort((a, b) => a.date.localeCompare(b.date) || a.accountId.localeCompare(b.accountId) || a.description.localeCompare(b.description));
}

/* ------------------------------------------------------------------ */
/* Everyday spending                                                  */
/* ------------------------------------------------------------------ */

interface EverydayMerchant {
  description: string;
  merchant: string;
  category: string;
  card: DemoCardKey;
  low: number;
  high: number;
  perMonth: number;
  /** Share of purchases returned later, in full or in part. */
  refundRate?: number;
  /** Gift shopping: more and larger purchases in November and December. */
  holiday?: boolean;
}

const UTILITIES = 'Utilities-Electric & Water';
const STREAMING = 'Entertainment-Streaming Services';
const MEMBERSHIPS = 'Other-Memberships';
const INTERNET = 'Communications-Cable & Internet Comm';
const MOBILE = 'Communications-Mobile Telecom';
const SOFTWARE = 'Business Services-Software & Online Services';

const EVERYDAY: readonly EverydayMerchant[] = [
  { description: 'NORTHWIND MARKET #104', merchant: 'Northwind Market', category: CARD_CATEGORY_GROCERIES, card: 'joint-cash', low: 2_500, high: 18_000, perMonth: 5 },
  { description: 'CONTOSO FRESH FOODS', merchant: 'Contoso Fresh Foods', category: CARD_CATEGORY_GROCERIES, card: 'casey-visa', low: 1_200, high: 9_000, perMonth: 3 },
  { description: 'SAMPLE WAREHOUSE CLUB #0042', merchant: 'Sample Warehouse Club', category: CARD_CATEGORY_WHOLESALE_STORES, card: 'joint-cash', low: 9_000, high: 32_000, perMonth: 1, holiday: true },
  { description: 'FOURTH COFFEE #114', merchant: 'Fourth Coffee', category: CARD_CATEGORY_BAR_CAFE, card: 'alex-gold', low: 450, high: 1_400, perMonth: 7 },
  { description: 'COHO VINEYARD KITCHEN', merchant: 'Coho Vineyard Kitchen', category: CARD_CATEGORY_RESTAURANT, card: 'joint-strata', low: 4_500, high: 14_000, perMonth: 2 },
  { description: 'WINGTIP TACOS', merchant: 'Wingtip Tacos', category: CARD_CATEGORY_RESTAURANT, card: 'casey-visa', low: 1_200, high: 3_800, perMonth: 3 },
  { description: 'TAILSPIN FUEL #2231', merchant: 'Tailspin Fuel', category: CARD_CATEGORY_FUEL, card: 'casey-visa', low: 3_000, high: 7_500, perMonth: 3 },
  { description: 'BLUE YONDER RIDES', merchant: 'Blue Yonder Rides', category: CARD_CATEGORY_TAXIS_COACH, card: 'alex-gold', low: 900, high: 3_500, perMonth: 2 },
  { description: 'PROSEWARE ONLINE MARKETPLACE', merchant: 'Proseware Marketplace', category: CARD_CATEGORY_INTERNET_PURCHASE, card: 'casey-platinum', low: 1_200, high: 14_000, perMonth: 3, refundRate: 0.1, holiday: true },
  { description: 'WIDE WORLD IMPORTERS HOME', merchant: 'Wide World Importers', category: CARD_CATEGORY_FURNISHING, card: 'joint-strata', low: 4_000, high: 40_000, perMonth: 1, refundRate: 0.12, holiday: true },
  { description: 'TAILWIND TRADERS APPAREL', merchant: 'Tailwind Traders', category: CARD_CATEGORY_CLOTHING_STORES, card: 'casey-platinum', low: 2_500, high: 12_000, perMonth: 1, refundRate: 0.15, holiday: true },
  { description: 'LUCERNE PUBLISHING BOOKS', merchant: 'Lucerne Publishing', category: CARD_CATEGORY_BOOK_STORES, card: 'alex-gold', low: 1_200, high: 4_500, perMonth: 1, holiday: true },
  { description: 'WOODGROVE PHARMACY', merchant: 'Woodgrove Pharmacy', category: CARD_CATEGORY_PHARMACIES, card: 'joint-cash', low: 800, high: 6_000, perMonth: 1 },
  { description: 'ADVENTURE WORKS OUTFITTERS', merchant: 'Adventure Works Outfitters', category: CARD_CATEGORY_SPORTING_GOODS_STORES, card: 'casey-visa', low: 2_000, high: 16_000, perMonth: 0, refundRate: 0.1, holiday: true },
];

interface RecurringBill {
  description: string;
  merchant: string;
  category: string;
  card: DemoCardKey;
  amount: number;
  day: number;
  /** Up to this much more or less each month (utilities). */
  varies?: number;
  /** Higher in winter and summer (electricity). */
  seasonal?: boolean;
}

/** The streaming subscriptions on the Platinum card are its digital entertainment credit's (demoBenefits.ts). */
const RECURRING: readonly RecurringBill[] = [
  { description: 'LUCERNE MUSIC SUBSCRIPTION', merchant: 'Lucerne Music', category: STREAMING, card: 'casey-visa', amount: 1_099, day: 15 },
  { description: 'ADVENTURE WORKS FITNESS', merchant: 'Adventure Works Fitness', category: MEMBERSHIPS, card: 'joint-cash', amount: 4_900, day: 1 },
  { description: 'LITWARE CLOUD STORAGE', merchant: 'Litware Cloud', category: SOFTWARE, card: 'alex-gold', amount: 299, day: 22 },
  { description: 'FABRIKAM FIBER INTERNET', merchant: 'Fabrikam Fiber', category: INTERNET, card: 'joint-cash', amount: 7_000, day: 10 },
  { description: 'THE PHONE COMPANY', merchant: 'The Phone Company', category: MOBILE, card: 'joint-cash', amount: 8_500, day: 12, varies: 900 },
  { description: 'CONTOSO POWER & LIGHT', merchant: 'Contoso Power & Light', category: UTILITIES, card: 'joint-cash', amount: 11_000, day: 18, varies: 1_500, seasonal: true },
  { description: 'CONTOSO WATER UTILITY', merchant: 'Contoso Water', category: UTILITIES, card: 'joint-cash', amount: 4_500, day: 20, varies: 700 },
];

export interface DemoSpending {
  /** First day of the oldest month and the day the history runs to (today). */
  coverage: { start: string; end: string };
  /** Every card row: purchases, refunds, credits, fees, pending charges and the autopay payments. */
  rows: DemoCardRow[];
  /** Each card's statements, closing at each month's end. */
  statements: DemoStatement[];
  /** The autopay payments (also in `rows`). */
  payments: DemoCardRow[];
  /** The owner's Benefits marks (Uber Cash). */
  marks: DemoBenefitMark[];
}

/**
 * Fifteen months of card history up to `today` (YYYY-MM-DD) plus the current month so far: groceries, dining, fuel,
 * rides, shopping (some returned, more of it at the holidays), subscriptions and utilities that recur, a trip every
 * four months, the premium cards' benefit purchases, credits and annual fees (demoBenefits.ts), a few pending charges,
 * and each card's autopay of its last statement on its due date (demoBanking.ts). Each month draws from its own seed,
 * so a month looks the same whichever later day the demo is made on.
 */
export function buildDemoSpending(today: string): DemoSpending {
  const start = demoHistoryStart(today);
  const rows: DemoCardRow[] = [];
  const add = (row: Omit<DemoCardRow, 'currency' | 'status'> & { status?: DemoCardRow['status'] }) => {
    if (row.transactionDate > today || row.transactionDate < start) return null;
    const created: DemoCardRow = { status: 'posted', currency: 'USD', ...row };
    rows.push(created);
    return created;
  };
  const purchase = (card: DemoCardKey, transactionDate: string, amountMinor: number, description: string, merchant: string,
    category: string | null, kind: CardTransactionKind = 'purchase') => add({
    card, transactionDate, amountMinor, kind, description, merchant, issuerCategory: category,
  });

  for (let offset = 0; offset <= DEMO_SPENDING_MONTHS; offset += 1) {
    const month = addMonths(start.slice(0, 7), offset);
    const next = seededRandom(`holdr-demo-spending:${month}`);
    const pick = (low: number, high: number) => pickBetween(next, low, high);
    const length = daysIn(month);
    const on = (day: number) => dayOf(month, day);
    const monthNumber = Number(month.slice(5, 7));
    const holiday = monthNumber === 12 ? 2.2 : monthNumber === 11 ? 1.4 : 1;

    for (const merchant of EVERYDAY) {
      const base = Math.max(0, merchant.perMonth + pick(-1, 1));
      const count = merchant.holiday ? Math.round(base * holiday) + (monthNumber === 12 ? pick(1, 2) : 0) : base;
      const scale = merchant.holiday && monthNumber === 12 ? 1.3 : 1;
      for (let index = 0; index < count; index += 1) {
        // December's gift shopping comes before the holidays.
        const day = monthNumber === 12 && merchant.holiday ? pick(1, 22) : pick(1, length);
        const bought = purchase(merchant.card, on(day), Math.round(pick(merchant.low, merchant.high) * scale), merchant.description,
          merchant.merchant, merchant.category);
        if (bought && merchant.refundRate && next() < merchant.refundRate) {
          const back = next() < 0.6 ? bought.amountMinor : Math.max(100, Math.floor(bought.amountMinor / pick(2, 4)));
          purchase(merchant.card, addDays(bought.transactionDate, pick(3, 25)), -back, merchant.description, merchant.merchant,
            merchant.category, 'refund');
        }
      }
    }

    for (const bill of RECURRING) {
      const season = bill.seasonal && [1, 2, 7, 8, 12].includes(monthNumber) ? 6_000 : 0;
      const amount = bill.amount + season + (bill.varies ? pick(-bill.varies, bill.varies) : 0);
      purchase(bill.card, on(bill.day + pick(0, 1)), amount, bill.description, bill.merchant, bill.category);
    }

    // A trip every four months, on the Platinum card or the joint Strata Elite: flights, a hotel stay, sometimes a car.
    if (offset % 4 === 1) {
      const card: DemoCardKey = offset % 8 === 1 ? 'joint-strata' : 'casey-platinum';
      const leave = pick(3, 14);
      purchase(card, on(leave - 2), pick(28_000, 72_000), 'BLUE YONDER AIRLINES', 'Blue Yonder Airlines', CARD_CATEGORY_AIRLINE);
      purchase(card, on(leave + 4), pick(3, 5) * pick(16_000, 26_000), 'MARGIES TRAVEL HOTEL', "Margie's Travel Hotel", CARD_CATEGORY_LODGING);
      if (next() < 0.6) purchase(card, on(leave + 4), pick(18_000, 42_000), 'ALPINE CAR RENTAL', 'Alpine Car Rental', CARD_CATEGORY_VEHICLE_RENTAL);
    }
  }

  const benefits = buildDemoBenefitCredits(today);
  rows.push(...benefits.rows);

  // The last two days' charges have not posted yet.
  for (const [card, back, amount, merchant] of [['casey-visa', 1, 2_675, EVERYDAY[5]], ['alex-gold', 0, 1_150, EVERYDAY[3]]] as const) {
    add({ card, transactionDate: addDays(today, -back), status: 'pending', amountMinor: amount, kind: 'purchase', description: merchant.description, merchant: merchant.merchant, issuerCategory: merchant.category });
  }

  const { statements, payments } = buildDemoStatements(rows, today);
  rows.push(...payments);
  rows.sort((left, right) => left.transactionDate.localeCompare(right.transactionDate) || left.card.localeCompare(right.card)
    || left.description.localeCompare(right.description) || left.amountMinor - right.amountMinor);
  return { coverage: { start, end: today }, rows, statements, payments, marks: benefits.marks };
}

/* ------------------------------------------------------------------ */
/* Precious metals                                                    */
/* ------------------------------------------------------------------ */

interface DemoMetalPurchase {
  back: number;
  title: string;
  metal: 'XAU' | 'XAG';
  /** A coin's fine content comes from its specification; a round's from its stated fine weight. */
  form: 'coin' | 'round';
  mass: { value: string; unit: 'ozt' | 'oz' | 'g' };
  /** Troy ounces per unit, for the price. */
  troyOz: number;
  purity: MetalsLine['purity'];
  design: MetalsLine['design'];
  quantity: number;
  premium: number;
}

const SILVER = { text: '.999', value: '999/1000' } as const;

/**
 * The household's bullion purchases, calendar days back from today: fractional gold coins (their fine content comes from
 * the coins' official specifications) and one-ounce silver rounds (their stated fine weight). About 0.8 troy ounces of
 * gold and 25 of silver in all.
 */
const METAL_PURCHASES: readonly DemoMetalPurchase[] = [
  { back: 980, title: 'Sample Mint 1/10 oz Gold Eagle Coin', metal: 'XAU', form: 'coin', mass: { value: '1/10', unit: 'oz' }, troyOz: 0.1, purity: null, design: 'eagle', quantity: 2, premium: 0.1 },
  { back: 900, title: 'Sample Refinery 1 ozt Silver Round FINE SILVER .999', metal: 'XAG', form: 'round', mass: { value: '1', unit: 'ozt' }, troyOz: 1, purity: SILVER, design: null, quantity: 10, premium: 0.09 },
  { back: 500, title: 'Sample Mint 1/4 oz Gold Maple Leaf Coin', metal: 'XAU', form: 'coin', mass: { value: '1/4', unit: 'oz' }, troyOz: 0.25, purity: null, design: 'maple-leaf', quantity: 1, premium: 0.07 },
  { back: 420, title: 'Example Mint 1 ozt Silver Round FINE SILVER .999', metal: 'XAG', form: 'round', mass: { value: '1', unit: 'ozt' }, troyOz: 1, purity: SILVER, design: null, quantity: 10, premium: 0.08 },
  { back: 220, title: 'Sample Mint 1/10 oz Gold Eagle Coin', metal: 'XAU', form: 'coin', mass: { value: '1/10', unit: 'oz' }, troyOz: 0.1, purity: null, design: 'eagle', quantity: 1, premium: 0.1 },
  { back: 150, title: 'Sample Refinery 1 ozt Silver Round FINE SILVER .999', metal: 'XAG', form: 'round', mass: { value: '1', unit: 'ozt' }, troyOz: 1, purity: SILVER, design: null, quantity: 5, premium: 0.09 },
  { back: 60, title: 'Sample Mint 1/4 oz Gold Eagle Coin', metal: 'XAU', form: 'coin', mass: { value: '1/4', unit: 'oz' }, troyOz: 0.25, purity: null, design: 'eagle', quantity: 1, premium: 0.075 },
];

interface DemoMetalSale {
  /** The purchase (index in METAL_PURCHASES) whose product is sold: the same content, so it is assigned those lots. */
  purchase: number;
  quantity: number;
  /** Calendar days back the sale is agreed within (oldest first), on the day with the highest or lowest close. */
  window: readonly [number, number];
  pick: 'high' | 'low';
  /** The dealer's bid below spot. */
  discount: number;
}

/**
 * Sold to a dealer within the last few months: the quarter-ounce Maple Leaf near a high (a gain) and five of the oldest
 * silver rounds after a dip (a loss), both inside the Gold page's default six-month view. The demo's closes keep one
 * shape relative to today, so these stay a gain and a loss whatever day the demo is made (demoData.test.ts checks).
 */
const METAL_SALES: readonly DemoMetalSale[] = [
  { purchase: 2, quantity: 1, window: [40, 10], pick: 'high', discount: 0.015 },
  { purchase: 1, quantity: 5, window: [75, 20], pick: 'low', discount: 0.03 },
];

/** The metal's closes, sorted by date. */
function metalSeries(metalCloses: readonly MetalCloseRow[], metal: 'XAU' | 'XAG'): MetalCloseRow[] {
  return metalCloses.filter((row) => row.symbol === `holdr:metal:${metal}`).sort((left, right) => left.t.localeCompare(right.t));
}

/** The newest close on or before `date` (closes sorted by date). */
function closeOn(closes: readonly MetalCloseRow[], date: string): number {
  let found: number | null = null;
  for (const row of closes) {
    if (row.t > date) break;
    found = row.close;
  }
  if (found === null) throw new Error(`no demo metal close on or before ${date}`);
  return found;
}

/** The purchase's product as a metals line (content, title and references): its unit price and events come from the caller. */
function productLine(purchase: DemoMetalPurchase) {
  return {
    title: purchase.title,
    metal: purchase.metal,
    form: purchase.form,
    statedMass: purchase.mass,
    pack: 'single' as const,
    purity: purchase.purity,
    massBasis: purchase.form === 'coin' ? 'none' as const : 'fine' as const,
    design: purchase.design,
  };
}

/** The bullion orders, each with its card charge: what the household's checking account later pays the bullion card. */
export interface DemoMetalOrderCharge {
  date: string;
  amountMinor: number;
}

/**
 * The bullion purchases as one `holdr.metals-import` v1 payload (online orders, delivered five days after each order),
 * priced from `metalCloses` plus a dealer premium. `today` is a New York date (YYYY-MM-DD).
 */
export function buildDemoMetalsPayload(today: string, metalCloses: readonly MetalCloseRow[]): MetalsImportPayload {
  const day = (back: number) => addDays(today, -back);
  const closes = { XAU: metalSeries(metalCloses, 'XAU'), XAG: metalSeries(metalCloses, 'XAG') };
  const orders: MetalsOrder[] = METAL_PURCHASES.map((purchase, index) => {
    const date = day(purchase.back);
    const unitPriceMinor = Math.round(closeOn(closes[purchase.metal], date) * purchase.troyOz * (1 + purchase.premium) * 100);
    const amountMinor = unitPriceMinor * purchase.quantity;
    return syntheticOrder({
      source: 'walmart',
      channel: 'online',
      id: `demo-${index + 1}`,
      date,
      skeleton: [metalItem(0, amountMinor)],
      components: [{ kind: 'tax', amountMinor: 0 }],
      // Paid with a card the demo household keeps out of Holdr, so the charges stay out of Spending.
      admission: {
        fulfilment: { shipments: 1 },
        methods: [{ kind: 'card', network: 'visa', last4: DEMO_METALS_CARD_LAST4, amountMinor }],
        refunded: false,
        cancelled: false,
        partlyCancelled: false,
        grossTotalMinor: amountMinor,
      },
      lines: [{
        ordinal: 0,
        ...productLine(purchase),
        productRef: `walmart:${900_001 + index}`,
        quantity: purchase.quantity,
        unitPriceMinor,
        events: [{ kind: 'delivered', date: addDays(date, 5), dateBasis: 'stated', quantity: purchase.quantity, occurrence: 1 }],
        seller: index % 2 === 0 ? 'Sample Bullion Shop' : 'Example Mint Store',
      }],
    });
  });
  // Captured today, so holdings as of today are covered.
  const payload = syntheticPayload('walmart', {
    orders,
    coverage: [syntheticCoverage('online', day(METAL_PURCHASES[0].back + 30), today, orders.length, orders.length)],
  });
  const captureDigest = metalsDigest(new TextEncoder().encode(`holdr-demo-metals:${today}`));
  return { ...payload, input: { ...payload.input, capturedAt: `${today}T00:00:00Z`, captureDigest } as MetalsImportPayload['input'] };
}

/** Each bullion order's card charge, from the purchases payload. */
export function demoMetalOrderCharges(payload: MetalsImportPayload): DemoMetalOrderCharge[] {
  return payload.orders.map((order) => ({ date: order.date, amountMinor: order.admission?.grossTotalMinor ?? 0 }));
}

/** A dealer payout: the ACH credit the household's checking account receives for a sale. */
export interface DemoMetalPayout {
  date: string;
  amountMinor: number;
}

/**
 * The household's bullion sales to a dealer as one `holdr.metals-import` v1 payload: each sells units of a product the
 * household bought (the same content, so the ledger assigns it those purchases, oldest first), agreed on the day of
 * its window with the highest (or lowest) close, at the dealer's bid below spot less a platform fee and insured
 * shipping, completed five days later and paid out by ACH to the joint checking account.
 */
export function buildDemoMetalsSalesPayload(today: string, metalCloses: readonly MetalCloseRow[]): { payload: MetalsImportPayload; payouts: DemoMetalPayout[] } {
  const closes = { XAU: metalSeries(metalCloses, 'XAU'), XAG: metalSeries(metalCloses, 'XAG') };
  const payouts: DemoMetalPayout[] = [];
  const orders: MetalsOrder[] = METAL_SALES.map((sale, index) => {
    const purchase = METAL_PURCHASES[sale.purchase];
    const series = closes[purchase.metal].filter((row) => row.t >= addDays(today, -sale.window[0]) && row.t <= addDays(today, -sale.window[1]));
    if (series.length === 0) throw new Error('no demo metal close in a sale window');
    const chosen = series.reduce((best, row) => ((sale.pick === 'high' ? row.close > best.close : row.close < best.close) ? row : best));
    const date = chosen.t;
    const unitPriceMinor = Math.round(chosen.close * purchase.troyOz * (1 - sale.discount) * 100);
    const grossMinor = unitPriceMinor * sale.quantity;
    const platformFee = -Math.round(grossMinor * 0.005);
    const shipping = -1_200;
    const completed = addDays(date, 5);
    const netMinor = grossMinor + platformFee + shipping;
    payouts.push({ date: completed, amountMinor: netMinor });
    const id = `demo-sale-${index + 1}`;
    return syntheticOrder({
      source: 'collectpure',
      channel: 'online',
      id,
      date,
      tradeMoment: `${date}T15:00:00Z`,
      status: 'complete',
      completedDate: completed,
      skeleton: [metalItem(0, grossMinor)],
      components: [{ kind: 'platform-fee', amountMinor: platformFee }, { kind: 'insured-shipping', amountMinor: shipping }],
      payouts: [{
        key: syntheticKey('collectpure', 'payout', id), method: 'ach', destinationLast4: DEMO_CHECKING.last4, amountMinor: netMinor,
        initiatedDate: completed, payoutDate: completed, status: 'complete',
      }],
      lines: [{
        ordinal: 0,
        ...productLine(purchase),
        productRef: `collectpure:SKU-DEMO-${sale.purchase + 1}`,
        quantity: sale.quantity,
        unitPriceMinor,
        events: [{ kind: 'agreed', date, dateBasis: 'stated', quantity: sale.quantity, occurrence: 1 }],
      }],
    });
  });
  // The dealer's export covers the account's whole history: opened when the household began buying bullion.
  const opened = addDays(today, -(METAL_PURCHASES[0].back + 30));
  const payload = syntheticPayload('collectpure', {
    orders,
    coverage: [
      syntheticCoverage('sell-orders', opened, today, orders.length, orders.length),
      syntheticCoverage('payouts', opened, today, orders.length, orders.length),
    ],
  });
  const captureDigest = metalsDigest(new TextEncoder().encode(`holdr-demo-metals-sales:${today}`));
  return {
    payload: { ...payload, input: { ...payload.input, capturedAt: `${today}T00:00:00Z`, captureDigest } as MetalsImportPayload['input'] },
    payouts,
  };
}

/* ------------------------------------------------------------------ */
/* The household                                                      */
/* ------------------------------------------------------------------ */

/** Everything the demo seeds, for `now`. */
export interface DemoHousehold {
  today: string;
  portfolio: SyntheticDataset;
  cashEvents: CashEventInput[];
  spending: DemoSpending;
  metals: MetalsImportPayload;
  metalsSales: MetalsImportPayload;
  checking: CheckingImportPayload;
  /** What the card issuers showed: statements and today's dashboards (Owed now, the payment schedule). */
  observations: ValidCardScheduleObservation[];
}

export function buildDemoHousehold(now: Date): DemoHousehold {
  const today = marketDate(now);
  const portfolio = buildDemoPortfolio(now);
  const spending = buildDemoSpending(today);
  const metals = buildDemoMetalsPayload(today, portfolio.metalCloses);
  const sales = buildDemoMetalsSalesPayload(today, portfolio.metalCloses);
  const extra: DemoCheckingEntry[] = [
    // The dealer's payouts land a business day after they are sent; the bank prints its counterparty name.
    ...sales.payouts.map((payout) => ({ date: nextWeekday(addDays(payout.date, 1)), amountMinor: payout.amountMinor, description: 'PM TECHNOLOGIES ACH CREDIT' })),
    // The bullion card (kept out of Holdr) is paid off the month after each order.
    ...demoMetalOrderCharges(metals).map((charge) => ({ date: nextWeekday(addDays(charge.date, 26)), amountMinor: -charge.amountMinor, description: 'BARCLAYCARD PAYMENT' })),
  ];
  return {
    today,
    portfolio,
    cashEvents: buildDemoCashEvents(portfolio, today),
    spending,
    metals,
    metalsSales: sales.payload,
    checking: buildDemoCheckingPayload(today, spending.payments, extra),
    observations: buildDemoObservations(spending.rows.filter((row) => row.kind !== 'payment'), { statements: spending.statements, payments: spending.payments }, now),
  };
}
