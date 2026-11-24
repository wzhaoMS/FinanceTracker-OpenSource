import {
  BENEFITS_CATALOG,
  CARD_CATEGORY_AIRLINE,
  CARD_CATEGORY_BAR_CAFE,
  CARD_CATEGORY_CLOTHING_STORES,
  CARD_CATEGORY_ELECTRONICS_STORES,
  CARD_CATEGORY_FEES_ADJUSTMENTS,
  CARD_CATEGORY_GENERAL_RETAIL,
  CARD_CATEGORY_LODGING,
  CARD_CATEGORY_RESTAURANT,
  CARD_CATEGORY_TAXIS_COACH,
  CARD_CATEGORY_TRAVEL_AGENCIES,
  benefitAppliesOn,
  benefitPeriodAmount,
  benefitSpansBetween,
  benefitVersions,
  matchBenefitCredit,
  resolveBenefitProduct,
  type BenefitDefinition,
  type BenefitPeriodSpan,
  type BenefitProduct,
  type CardTransactionKind,
} from '@finance-tracker/shared';

import { addDays, dayOf, daysBetween, pickBetween, seededRandom } from './demoCalendar.js';
import { DEMO_CARDS, demoHistoryStart, type DemoBenefitMark, type DemoCard, type DemoCardKey, type DemoCardRow } from './demoCards.js';

/**
 * The demo's card benefits, built from Holdr's own benefits catalog (BENEFITS_CATALOG): for every premium card the
 * household holds, every period of every statement credit from the start of the card history to today, each used in
 * full, in part or not at all. Every credit follows the purchase it rewards, and its line is checked against the
 * catalog's own matcher when it is built, so it reads as its benefit and no other. Uber Cash, which never posts to
 * the card, gets the owner's marks instead. Also here: a Saks credit taken back after a return (each January–June
 * half), a streaming credit that posts two days into the next month and counts for the month before (the catalog's
 * grace rule; January, May and September), a Global Entry fee credit (once every four years), and each card's annual
 * fee.
 *
 * Each period's plan is drawn from a seed that names the period, never the day the demo is made: a past period looks
 * the same on every later day, and today only decides how much of the current one has happened (a purchase or credit
 * dated after today is not there yet).
 */

interface Purchase {
  description: string;
  merchant: string;
  category: string | null;
}

/** One or more purchases a period, each credited up to what is left of the period's amount. */
interface CreditRecipe {
  kind: 'credit';
  purchases: readonly Purchase[];
  /** The statement credit's line: the catalog's matcher must read it as this benefit and no other. */
  credit: string;
  /** Purchase price in cents; `version` charges the amount of the benefit's version in force that day (CLEAR+). */
  price: readonly [number, number] | 'version';
  /** Purchases per period used. */
  count?: readonly [number, number];
  /** Days from a purchase to its credit. */
  lag: readonly [number, number];
  /** Chances a past period was used in full or in part (else not at all). */
  full: number;
  partial: number;
  /**
   * How each period goes, by the calendar, instead of the chances above: for a card with few, long periods, so every
   * year shows one used in full, one in part and one not at all.
   */
  plan?: (span: BenefitPeriodSpan) => Outcome;
}

/** Monthly charges on fixed days, each credited up to what is left of the month's amount. */
interface SubscriptionRecipe {
  kind: 'subscription';
  charges: ReadonlyArray<Purchase & { day: number; priceMinor: number }>;
  credit: string;
  lag: readonly [number, number];
  /** Chance a month got no credit at all (a missed enrollment, a lapsed membership). */
  skip: number;
}

type Recipe = CreditRecipe | SubscriptionRecipe;

const RESTAURANTS: readonly Purchase[] = [
  { description: 'COHO VINEYARD KITCHEN', merchant: 'Coho Vineyard Kitchen', category: CARD_CATEGORY_RESTAURANT },
  { description: 'MARGIES BISTRO', merchant: "Margie's Bistro", category: CARD_CATEGORY_RESTAURANT },
  { description: 'ALPINE SKI HOUSE GRILL', merchant: 'Alpine Ski House Grill', category: CARD_CATEGORY_RESTAURANT },
];

const HOTEL_BOOKINGS: readonly Purchase[] = [
  { description: 'AMEX TRAVEL FINE HOTELS AND RESORTS', merchant: 'Amex Travel', category: CARD_CATEGORY_LODGING },
  { description: 'AMEX TRAVEL THE HOTEL COLLECTION', merchant: 'Amex Travel', category: CARD_CATEGORY_LODGING },
];

type Outcome = 'full' | 'partial' | 'none';
const evenYear = (span: BenefitPeriodSpan) => Number(span.start.slice(0, 4)) % 2 === 0;
const firstHalf = (span: BenefitPeriodSpan) => span.start.slice(5, 7) === '01';

/** By `<product id>:<benefit id>`. A benefit without a recipe is never used (an Equinox credit nobody enrolled in). */
const RECIPES: Readonly<Record<string, Recipe>> = {
  'amex-gold:dining': {
    kind: 'credit',
    purchases: [
      { description: 'GRUBHUB ORDER', merchant: 'Grubhub', category: CARD_CATEGORY_RESTAURANT },
      { description: 'FIVE GUYS #1123', merchant: 'Five Guys', category: CARD_CATEGORY_RESTAURANT },
      { description: 'THE CHEESECAKE FACTORY #0207', merchant: 'The Cheesecake Factory', category: CARD_CATEGORY_RESTAURANT },
    ],
    credit: 'GOLD DINING CREDIT',
    price: [1_200, 4_800],
    lag: [1, 3],
    full: 0.72,
    partial: 0.16,
  },
  'amex-gold:resy': { kind: 'credit', purchases: RESTAURANTS, credit: 'RESY CREDIT', price: [6_500, 16_000], lag: [2, 5], full: 0.6, partial: 0.25 },
  'amex-gold:dunkin': {
    kind: 'credit',
    purchases: [{ description: 'DUNKIN #4412', merchant: "Dunkin'", category: CARD_CATEGORY_BAR_CAFE }],
    credit: 'DUNKIN CREDIT',
    price: [700, 1_400],
    lag: [1, 3],
    full: 0.5,
    partial: 0.25,
  },
  'amex-platinum:hotel': { kind: 'credit', purchases: HOTEL_BOOKINGS, credit: 'AMEX TRAVEL HOTEL CREDIT', price: [42_000, 128_000], lag: [2, 6], full: 0.7, partial: 0.15 },
  'amex-platinum:hotel-annual': { kind: 'credit', purchases: HOTEL_BOOKINGS, credit: 'AMEX TRAVEL HOTEL CREDIT', price: [42_000, 98_000], lag: [2, 6], full: 0.8, partial: 0.1 },
  'amex-platinum:uber-one': {
    kind: 'credit',
    purchases: [{ description: 'UBER ONE ANNUAL MEMBERSHIP', merchant: 'Uber One', category: CARD_CATEGORY_TAXIS_COACH }],
    credit: 'UBER ONE CREDIT',
    price: [9_600, 9_600],
    lag: [1, 2],
    full: 0.9,
    partial: 0,
  },
  'amex-platinum:digital-entertainment': {
    kind: 'subscription',
    charges: [
      { description: 'SOUTHRIDGE VIDEO STREAMING', merchant: 'Southridge Video', category: 'Entertainment-Streaming Services', day: 7, priceMinor: 1_549 },
      { description: 'LUCERNE NEWS DIGITAL', merchant: 'Lucerne News', category: 'Entertainment-Streaming Services', day: 15, priceMinor: 999 },
    ],
    credit: 'DIGITAL ENTERTAINMENT CREDIT',
    lag: [1, 2],
    skip: 0.06,
  },
  'amex-platinum:resy': { kind: 'credit', purchases: RESTAURANTS, credit: 'RESY CREDIT', price: [8_000, 22_000], count: [1, 2], lag: [2, 5], full: 0.55, partial: 0.3 },
  'amex-platinum:lululemon': {
    kind: 'credit',
    purchases: [{ description: 'LULULEMON', merchant: 'lululemon', category: CARD_CATEGORY_CLOTHING_STORES }],
    credit: 'LULULEMON CREDIT',
    price: [6_800, 14_800],
    lag: [1, 4],
    full: 0.5,
    partial: 0.3,
  },
  'amex-platinum:saks': {
    kind: 'credit',
    purchases: [{ description: 'SAKS FIFTH AVENUE', merchant: 'Saks Fifth Avenue', category: CARD_CATEGORY_CLOTHING_STORES }],
    credit: 'SAKS CREDIT',
    price: [5_000, 18_000],
    lag: [1, 4],
    full: 0.65,
    partial: 0.2,
  },
  'amex-platinum:walmart-plus': {
    kind: 'subscription',
    // "WALMART PLUS", never WALMART.COM: an online Walmart charge reads as a possible bullion purchase.
    charges: [{ description: 'WALMART PLUS MEMBERSHIP', merchant: 'Walmart Plus', category: 'Other-Memberships', day: 3, priceMinor: 1_295 }],
    credit: 'WALMART PLUS CREDIT',
    lag: [1, 2],
    skip: 0.08,
  },
  'amex-platinum:oura': {
    kind: 'credit',
    purchases: [{ description: 'OURA RING', merchant: 'Oura', category: CARD_CATEGORY_ELECTRONICS_STORES }],
    credit: 'OURA CREDIT',
    price: [29_900, 34_900],
    lag: [3, 7],
    full: 0.6,
    partial: 0,
  },
  'amex-platinum:clear': {
    kind: 'credit',
    purchases: [{ description: 'CLEAR PLUS MEMBERSHIP', merchant: 'CLEAR', category: CARD_CATEGORY_TRAVEL_AGENCIES }],
    credit: 'CLEAR PLUS CREDIT',
    price: 'version',
    lag: [1, 3],
    full: 0.95,
    partial: 0,
  },
  'amex-platinum:airline-fee': {
    kind: 'credit',
    purchases: [
      { description: 'BLUE YONDER AIRLINES BAG FEE', merchant: 'Blue Yonder Airlines', category: CARD_CATEGORY_AIRLINE },
      { description: 'BLUE YONDER AIRLINES SEAT UPGRADE', merchant: 'Blue Yonder Airlines', category: CARD_CATEGORY_AIRLINE },
    ],
    credit: 'AIRLINE FEE CREDIT',
    price: [3_500, 9_000],
    count: [2, 4],
    lag: [6, 20],
    full: 0.8,
    partial: 0.15,
  },
  'citi-strata-elite:hotel': {
    kind: 'credit',
    purchases: [{ description: 'CITI TRAVEL HOTEL BOOKING', merchant: 'Citi Travel', category: CARD_CATEGORY_LODGING }],
    credit: 'CITI TRAVEL HOTEL CREDIT',
    price: [54_000, 96_000],
    lag: [2, 6],
    full: 0.8,
    partial: 0.1,
    plan: (span) => (evenYear(span) ? 'full' : 'partial'),
  },
  'citi-strata-elite:splurge': {
    kind: 'credit',
    purchases: [{ description: 'LITWARE AUDIO', merchant: 'Litware Audio', category: CARD_CATEGORY_ELECTRONICS_STORES }],
    credit: 'SPLURGE CREDIT',
    price: [24_900, 39_900],
    lag: [2, 5],
    full: 0.7,
    partial: 0.2,
    plan: (span) => (evenYear(span) ? 'none' : 'full'),
  },
  'citi-strata-elite:blacklane': {
    kind: 'credit',
    purchases: [{ description: 'BLACKLANE CHAUFFEUR', merchant: 'Blacklane', category: CARD_CATEGORY_TAXIS_COACH }],
    credit: 'BLACKLANE CREDIT',
    price: [11_000, 19_000],
    lag: [1, 3],
    full: 0.5,
    partial: 0.3,
    plan: (span) => (!firstHalf(span) ? 'full' : evenYear(span) ? 'partial' : 'none'),
  },
};

/** The Global Entry fee: charged once, credited a few days later; the product's every-four-years window starts there. */
const GLOBAL_ENTRY = {
  purchase: { description: 'US CUSTOMS GLOBAL ENTRY APPLICATION', merchant: 'US Customs', category: CARD_CATEGORY_GENERAL_RETAIL },
  credit: 'GLOBAL ENTRY FEE CREDIT',
} as const;

/** Which cards used the Global Entry credit in the card history: the other premium card's is still available. */
const GLOBAL_ENTRY_USED_ON: readonly DemoCardKey[] = ['casey-platinum'];

/** The Saks purchase returned after its credit posted, and the credit taken back. */
const REVERSAL = { benefit: 'saks', card: 'casey-platinum' as DemoCardKey, priceMinor: 12_000 };
/** The streaming charge on a month's last day whose credit posts in the next month and counts for the month before. */
const GRACE = { benefit: 'digital-entertainment', card: 'casey-platinum' as DemoCardKey, charge: 0 };

const ISSUER_NAME: Readonly<Record<DemoCard['issuer'], string>> = { amex: 'American Express', chase: 'Chase', citi: 'Citi' };

export interface DemoBenefitCredits {
  /** Qualifying purchases, statement credits, the credit taken back, and the annual fees. */
  rows: DemoCardRow[];
  /** The owner's marks for Uber Cash (never posted to the card). */
  marks: DemoBenefitMark[];
}

/** The card's product in the catalog, as the Benefits tab resolves it. */
export function demoCardProduct(card: DemoCard): BenefitProduct | null {
  return resolveBenefitProduct(BENEFITS_CATALOG, { issuer: card.issuer, nickname: card.nickname }, { productChoice: card.productChoice, productId: null }).product;
}

/** The first and last day any version of a benefit applies (null: open-ended). */
function validity(versions: readonly BenefitDefinition[]): { from: string | null; until: string | null } {
  const froms = versions.map((version) => version.validFrom ?? null);
  const untils = versions.map((version) => version.validUntil ?? null);
  return {
    from: froms.includes(null) ? null : [...froms as string[]].sort()[0],
    until: untils.includes(null) ? null : [...untils as string[]].sort().at(-1)!,
  };
}

const later = (a: string, b: string | null) => (b !== null && b > a ? b : a);
const earlier = (a: string, b: string | null) => (b !== null && b < a ? b : a);

interface Builder {
  today: string;
  start: string;
  rows: DemoCardRow[];
  add(row: Omit<DemoCardRow, 'currency' | 'status'>): DemoCardRow | null;
}

/** Throws unless the catalog's matcher reads the credit line as `benefitId` (and so as no other benefit of the card). */
function checkCredit(product: BenefitProduct, benefitId: string, row: DemoCardRow): void {
  const read = matchBenefitCredit(product, {
    id: 'demo', cardAccountId: 'demo', date: row.transactionDate, amountMinor: row.amountMinor, kind: row.kind,
    description: row.description, merchant: row.merchant ?? null,
  });
  if (read !== benefitId) throw new Error(`demo credit "${row.description}" on ${row.transactionDate} reads as ${read ?? 'no benefit'}, not ${benefitId}`);
}

function creditRow(builder: Builder, product: BenefitProduct, card: DemoCard, benefitId: string, line: string, date: string,
  amountMinor: number, kind: CardTransactionKind = 'adjustment'): DemoCardRow | null {
  const row = builder.add({
    card: card.key, transactionDate: date, amountMinor, kind, description: line, merchant: ISSUER_NAME[card.issuer],
    issuerCategory: CARD_CATEGORY_FEES_ADJUSTMENTS,
  });
  if (row) checkCredit(product, benefitId, row);
  return row;
}

function purchaseRow(builder: Builder, card: DemoCard, purchase: Purchase, date: string, amountMinor: number, kind: CardTransactionKind = 'purchase') {
  return builder.add({
    card: card.key, transactionDate: date, amountMinor, kind, description: purchase.description, merchant: purchase.merchant,
    issuerCategory: purchase.category,
  });
}

/** How a period goes: by the recipe's calendar plan, else drawn from its own seed, whatever day it is. */
function outcomeOf(recipe: CreditRecipe, span: BenefitPeriodSpan, next: () => number): Outcome {
  const draw = next();
  if (recipe.plan) return recipe.plan(span);
  return draw < recipe.full ? 'full' : draw < recipe.full + recipe.partial ? 'partial' : 'none';
}

function creditPeriod(builder: Builder, product: BenefitProduct, card: DemoCard, versions: readonly BenefitDefinition[], recipe: CreditRecipe,
  span: BenefitPeriodSpan, amount: number, next: () => number): void {
  const id = versions[0].id;
  const { from, until } = validity(versions);
  const first = later(span.start, from);
  // Purchases early enough that their credits post inside the period: none spills into the next one by accident.
  const latestPurchase = addDays(earlier(span.end, until), -recipe.lag[1]);
  if (first > latestPurchase) return;
  const outcome = outcomeOf(recipe, span, next);
  if (outcome === 'none') return;
  const count = outcome === 'partial' || !recipe.count ? 1 : pickBetween(next, recipe.count[0], recipe.count[1]);
  const days = Array.from({ length: count }, () => addDays(first, pickBetween(next, 0, daysBetween(first, latestPurchase)))).sort();
  let left = amount;
  for (const date of days) {
    if (left <= 0) break;
    const purchase = recipe.purchases[pickBetween(next, 0, recipe.purchases.length - 1)];
    const versionAmount = versions.find((version) => benefitAppliesOn(version, date))?.value;
    const price = recipe.price === 'version'
      ? (versionAmount?.unit === 'usd' ? versionAmount.amountMinor : amount)
      : outcome === 'partial'
        ? Math.max(100, Math.round(amount * (0.3 + 0.5 * next())))
        : pickBetween(next, recipe.price[0], recipe.price[1]);
    // Used in full with one purchase: it cost at least the credit.
    const charged = outcome === 'full' && count === 1 && recipe.price !== 'version' ? Math.max(price, amount + pickBetween(next, 0, 4_000)) : price;
    const lag = pickBetween(next, recipe.lag[0], recipe.lag[1]);
    // Before the card history starts, or after today: neither the purchase nor its credit is shown.
    if (!purchaseRow(builder, card, purchase, date, charged)) continue;
    const credited = Math.min(charged, left);
    left -= credited;
    creditRow(builder, product, card, id, recipe.credit, addDays(date, lag), -credited);
  }
}

function subscriptionPeriod(builder: Builder, product: BenefitProduct, card: DemoCard, versions: readonly BenefitDefinition[],
  recipe: SubscriptionRecipe, span: BenefitPeriodSpan, amount: number, next: () => number, graced: boolean): void {
  const id = versions[0].id;
  const month = span.start.slice(0, 7);
  if (next() < recipe.skip) {
    // Charged, never credited: the month shows the benefit unused.
    for (const charge of recipe.charges) purchaseRow(builder, card, charge, dayOf(month, charge.day), charge.priceMinor);
    return;
  }
  let left = amount;
  recipe.charges.forEach((charge, index) => {
    // The grace example: the month's first charge on its last day, credited two days into the next month.
    const late = graced && index === GRACE.charge;
    const date = late ? span.end : dayOf(month, charge.day);
    const lag = late ? 2 : pickBetween(next, recipe.lag[0], recipe.lag[1]);
    if (!purchaseRow(builder, card, charge, date, charge.priceMinor)) return;
    const credited = Math.min(charge.priceMinor, left);
    if (credited <= 0) return;
    left -= credited;
    creditRow(builder, product, card, id, recipe.credit, addDays(date, lag), -credited);
  });
}

/** The grace example's months: January, May and September, whatever day the demo is made on. */
const isGraceMonth = (span: BenefitPeriodSpan) => [1, 5, 9].includes(Number(span.start.slice(5, 7)));

/** The Saks return: every first half year, bought in April, so the history always holds one that is over. */
const isReversalSpan = (span: BenefitPeriodSpan) => span.start.endsWith('-01-01');

function reversalPeriod(builder: Builder, product: BenefitProduct, card: DemoCard, recipe: CreditRecipe, span: BenefitPeriodSpan, amount: number): void {
  const bought = addDays(span.start, 100);
  const purchase = recipe.purchases[0];
  if (!purchaseRow(builder, card, purchase, bought, REVERSAL.priceMinor)) return;
  creditRow(builder, product, card, REVERSAL.benefit, recipe.credit, addDays(bought, 2), -amount);
  // Returned: the store refunds the purchase, and the issuer takes its credit back.
  purchaseRow(builder, card, purchase, addDays(bought, 12), -REVERSAL.priceMinor, 'refund');
  creditRow(builder, product, card, REVERSAL.benefit, `${recipe.credit} REVERSAL`, addDays(bought, 15), amount);
}

function uberCashMarks(card: DemoCard, versions: readonly BenefitDefinition[], start: string, today: string): DemoBenefitMark[] {
  const marks: DemoBenefitMark[] = [];
  for (const span of benefitSpansBetween(versions[0].cadence, start, today, card.anniversaryMonth) ?? []) {
    const amount = benefitPeriodAmount([...versions], span);
    if (amount === null) continue;
    const next = seededRandom(`holdr-demo-benefit-mark:${card.key}:${versions[0].id}:${span.start}`);
    const draw = next();
    if (span.end >= today) {
      // This month: marked once most of it is gone, and then only in part.
      if (daysBetween(today, span.end) <= 9) marks.push({ card: card.key, benefitId: versions[0].id, periodStart: span.start, status: 'partial', usedMinor: Math.round(amount * 0.4) });
      continue;
    }
    if (draw < 0.7) marks.push({ card: card.key, benefitId: versions[0].id, periodStart: span.start, status: 'used', usedMinor: null });
    else if (draw < 0.9) {
      marks.push({ card: card.key, benefitId: versions[0].id, periodStart: span.start, status: 'partial', usedMinor: Math.round(amount * (0.25 + 0.5 * next())) });
    } else marks.push({ card: card.key, benefitId: versions[0].id, periodStart: span.start, status: 'unused', usedMinor: null });
  }
  return marks;
}

function annualFees(builder: Builder, card: DemoCard, product: BenefitProduct): void {
  if (card.anniversaryMonth === null || !product.annualFeeMinor) return;
  for (let year = Number(builder.start.slice(0, 4)); year <= Number(builder.today.slice(0, 4)); year += 1) {
    const date = `${year}-${String(card.anniversaryMonth).padStart(2, '0')}-02`;
    if (date < builder.start) continue;
    builder.add({
      card: card.key, transactionDate: date, amountMinor: product.annualFeeMinor, kind: 'fee',
      description: card.issuer === 'amex' ? 'ANNUAL MEMBERSHIP FEE' : 'ANNUAL FEE', merchant: ISSUER_NAME[card.issuer],
      issuerCategory: CARD_CATEGORY_FEES_ADJUSTMENTS,
    });
  }
}

function globalEntry(builder: Builder, product: BenefitProduct, card: DemoCard, versions: readonly BenefitDefinition[]): void {
  if (!GLOBAL_ENTRY_USED_ON.includes(card.key)) return;
  const applied = addDays(builder.start, 45);
  const amount = versions.find((version) => benefitAppliesOn(version, applied))?.value;
  if (!amount || amount.unit !== 'usd' || addDays(applied, 4) > builder.today) return;
  purchaseRow(builder, card, GLOBAL_ENTRY.purchase, applied, amount.amountMinor);
  creditRow(builder, product, card, versions[0].id, GLOBAL_ENTRY.credit, addDays(applied, 4), -amount.amountMinor);
}

/**
 * Every benefit row and mark of the demo household through `today` (a New York date, YYYY-MM-DD), from the first day
 * of its card history (demoHistoryStart). Deterministic: the same rows for the same day.
 */
export function buildDemoBenefitCredits(today: string): DemoBenefitCredits {
  const start = demoHistoryStart(today);
  const rows: DemoCardRow[] = [];
  const builder: Builder = {
    today,
    start,
    rows,
    add(row) {
      if (row.transactionDate > today || row.transactionDate < start) return null;
      const created: DemoCardRow = { status: 'posted', currency: 'USD', ...row };
      rows.push(created);
      return created;
    },
  };
  const marks: DemoBenefitMark[] = [];

  for (const card of DEMO_CARDS) {
    const product = demoCardProduct(card);
    if (!product) continue;
    annualFees(builder, card, product);
    for (const versions of benefitVersions(product)) {
      const id = versions[0].id;
      if (versions[0].tracking.method === 'manual') {
        if (id === 'uber-cash') marks.push(...uberCashMarks(card, versions, start, today));
        continue;
      }
      if (versions[0].cadence.every === 'years') {
        globalEntry(builder, product, card, versions);
        continue;
      }
      const recipe = RECIPES[`${product.id}:${id}`];
      if (!recipe) continue;
      for (const span of benefitSpansBetween(versions[0].cadence, start, today, card.anniversaryMonth) ?? []) {
        const amount = benefitPeriodAmount([...versions], span);
        if (amount === null) continue;
        const next = seededRandom(`holdr-demo-benefit:${card.key}:${id}:${span.start}`);
        if (recipe.kind === 'subscription') {
          subscriptionPeriod(builder, product, card, versions, recipe, span, amount, next,
            card.key === GRACE.card && id === GRACE.benefit && isGraceMonth(span));
        } else if (card.key === REVERSAL.card && id === REVERSAL.benefit && isReversalSpan(span)) {
          reversalPeriod(builder, product, card, recipe, span, amount);
        } else {
          creditPeriod(builder, product, card, versions, recipe, span, amount, next);
        }
      }
    }
  }
  rows.sort((left, right) => left.transactionDate.localeCompare(right.transactionDate) || left.card.localeCompare(right.card)
    || left.description.localeCompare(right.description) || left.amountMinor - right.amountMinor);
  return { rows, marks };
}

/** The demo's annual fee for a card, from the catalog (0 for a card without one). */
export function demoAnnualFeeMinor(key: DemoCardKey): number {
  const card = DEMO_CARDS.find((entry) => entry.key === key)!;
  return demoCardProduct(card)?.annualFeeMinor ?? 0;
}
