/**
 * Spending insights over stored card transactions, for a period against its
 * baseline: merchant names grouped across descriptor variants, the month's
 * pace, large one-off purchases (together, with the period without them),
 * category and merchant movers, recurring charges and the ones that started,
 * went up or stopped, possible duplicates, large charges at new merchants,
 * pending refunds, and fees and interest. Pure and deterministic: the caller
 * passes "today" and the period, and every threshold is a named constant here.
 *
 * Built from what established tools surface (Copilot Money, Monarch,
 * Simplifi, PocketGuard, Lunch Money, Rocket Money) for a household whose
 * only data is card transactions. Statistics stay internal; callers phrase
 * each insight as a headline, a number and one reason.
 */
import { currencyExponent } from './cardImportTool/amount.js';
import { cardCategorySplitView, largestCardCategory, type CardCategoryPart } from './cardCategoryParts.js';
import {
  cardCategoryPartTotals, cardSpendingExclusionOf, cardSpendingRole, effectiveCardCategory, effectiveCardMerchant,
  type CardSpendingExclusion, type CardSpendingRow,
} from './cardSpending.js';
import { cardMerchantDisplayNames as displayNames, cardMerchantKey, groupCardMerchantKeys, isCardMerchantKey, matchesCardMerchantGroup } from './cardMerchants.js';

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

export type CardInsightRow = CardSpendingRow & { id: string; originalCurrency?: string | null };

/**
 * Order links (the Amazon domain's, STEP 9) from one snapshot, for the large one-off split. Both are the household's,
 * whatever rows a split is given: an order's charge on a card or a date outside them still counts.
 */
export interface CardOrderLinks {
  /** The orders a card row is linked to, by row id (charges and credits alike); none (empty or undefined) for a row linked to none. */
  orderRefsOf(rowId: string): readonly string[] | undefined;
  /** The card rows an order's charges are linked to, by order; none (empty or undefined) when no charge of it is linked to a card row. */
  chargeIdsOf(orderRef: string): readonly string[] | undefined;
}

export type RecurringCadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual';

const CADENCES: ReadonlyArray<{ cadence: RecurringCadence; days: number; min: number; max: number; tolerance: number }> = [
  { cadence: 'weekly', days: 7, min: 5, max: 9, tolerance: 2 },
  { cadence: 'biweekly', days: 14, min: 12, max: 16, tolerance: 3 },
  { cadence: 'monthly', days: 30.44, min: 26, max: 35, tolerance: 5 },
  { cadence: 'quarterly', days: 91.3, min: 80, max: 102, tolerance: 12 },
  { cadence: 'annual', days: 365.25, min: 345, max: 385, tolerance: 20 },
];

/** Thresholds, in major units where they are money (scaled to each currency's minor units). */
export const CARD_INSIGHT_THRESHOLDS = {
  /** Recurring: occurrences needed (weekly and biweekly need one more, annual two), share of intervals on cadence, fixed-amount spread. */
  recurringMinOccurrences: 3,
  recurringRegularShare: 0.75,
  recurringFixedSpread: 0.05,
  /** An annual charge seen only twice counts when the two amounts are within this share (a renewal, perhaps repriced). */
  recurringAnnualPairSpread: 0.25,
  /** Subscriptions sharing one descriptor are told apart by price, within this share. */
  recurringClusterSpread: 0.01,
  recurringLookbackDays: 400,
  /** Two yearly cycles plus the tolerance, so a yearly charge keeps its earlier payment until the renewal is overdue. */
  recurringAnnualLookbackDays: 800,
  /** A price change on a fixed recurring charge: at least this much and this share. */
  priceChangeMin: 1,
  priceChangeShare: 0.02,
  /** Pace compares against up to this many earlier months, needing at least two. */
  historyMonths: 3,
  minHistoryMonths: 2,
  /** Projections start once this many days of the month have passed. */
  paceMinDays: 7,
  /**
   * A large one-off purchase: at least this much, at least the 99th percentile of the year's purchases and this multiple
   * of their median, and not at a recurring merchant. They are reported together, and left out of the movers.
   */
  largeMin: 500,
  largeQuantile: 0.99,
  largeMedianMultiple: 4,
  /** Category movers: both a relative and an absolute change against the baseline. */
  moverShare: 0.25,
  moverMin: 50,
  /** A second merchant is named behind a category change only when it makes at least this share of the change. */
  moverDriverShare: 0.1,
  /** Merchant movers: both a relative and an absolute change against the baseline. */
  merchantMoverShare: 0.5,
  merchantMoverMin: 100,
  /** Duplicates: same card, merchant and amount within this many days, at least this amount. */
  duplicateDays: 3,
  duplicateMin: 25,
  /** New merchant: none in the year before, at least this much (and the 90th percentile of recent charges). */
  newMerchantMin: 100,
  newMerchantBaselineDays: 90,
  /** Listed items per kind. */
  maxItems: 5,
} as const;

export interface RecurringCharge {
  /** Merchant group key; filter with `matchesCardMerchantGroup`. */
  key: string;
  merchant: string;
  cadence: RecurringCadence;
  /** Fixed amount (within 5%) or a varying bill. */
  fixed: boolean;
  /** Median amount of the series. */
  typicalMinor: number;
  lastMinor: number;
  /** The series' first charge. */
  firstDate: string;
  lastDate: string;
  nextDate: string;
  occurrences: number;
  /** Typical amount as a monthly cost. */
  monthlyMinor: number;
  /** False when the next charge is overdue: maybe cancelled. */
  active: boolean;
  /** The latest fixed charge differs from the earlier price, since the first charge at the new one. */
  priceChange: { fromMinor: number; toMinor: number; since: string } | null;
  cardAccountIds: string[];
}

export interface SpendingPace {
  daysElapsed: number;
  daysInMonth: number;
  /** Posted spending so far this month. */
  spentMinor: number;
  /** Pending charges so far this month, not in `spentMinor` (they may change or already be in under another reference). */
  pendingMinor: number;
  /** Average spent by the same day of the month in the earlier months, large one-offs aside. */
  typicalToDateMinor: number;
  /** Average full earlier month, large one-offs aside. */
  typicalMonthMinor: number;
  /** Spent so far plus what the rest of a usual month adds; null early in the month. */
  projectedMinor: number | null;
  historyMonths: number;
  /** Large one-off purchases so far this month, net of what was refunded for them (or for earlier ones), part of `spentMinor`: the pace without them is `projectedMinor` minus this. */
  largeMinor: number;
  largeCount: number;
}

/** The days insights cover, and the days they are compared with: the period's own comparison. */
export interface CardInsightPeriod {
  from: string;
  to: string;
  /** Null when the period is compared with nothing. */
  baseline: { from: string; to: string } | null;
}

export interface LargePurchase {
  id: string;
  /** The row's own merchant name; `key` is its merchant group. */
  merchant: string;
  key: string;
  /** What it cost: the purchase less its refunds so far. */
  amountMinor: number;
  /**
   * Refunded so far (same card and merchant, within 90 days; one refund may cover several; a credit whose order link is
   * decisive only when this is one of its orders' charges), already taken off `amountMinor`.
   */
  refundedMinor: number;
  date: string;
  /** The row's own category, or for a split row the category its parts add up to most in (ties by name). */
  category: string;
  /** A split row's amount per category, largest first; absent for a row filed whole. */
  split?: Array<{ category: string; amountMinor: number }>;
  /** No purchase at this merchant (or a variant of its name) in the year before, with enough history to tell. */
  firstTime: boolean;
}

/** Large one-off purchases in the period, together: what they add, and the period without them. */
export interface LargePurchases {
  /** Purchases at or above this (not at a recurring merchant) count; one refunded in full does not. */
  thresholdMinor: number;
  count: number;
  /** Net of their refunds. */
  totalMinor: number;
  /** Their part of the period's spending with them; null when that is not positive. */
  share: number | null;
  /** The period's spending without them, or what was refunded for them (or for earlier ones). */
  coreMinor: number;
  /** The baseline's spending without its own large one-offs or what was refunded for them; null without a baseline. */
  baselineCoreMinor: number | null;
  /** The largest, at most `maxItems`. */
  items: LargePurchase[];
}

/** A merchant behind a category's change, with its own part of it. */
export interface MoverDriver {
  key: string;
  merchant: string;
  deltaMinor: number;
}

export interface CategoryMover {
  category: string;
  currentMinor: number;
  /** The baseline's spending in this category. */
  typicalMinor: number;
  deltaMinor: number;
  /** Change against the baseline; null for a category new in the period. */
  share: number | null;
  /** The merchants that moved it most, in its direction. */
  drivers: MoverDriver[];
}

export interface MerchantMover {
  key: string;
  merchant: string;
  currentMinor: number;
  baselineMinor: number;
  deltaMinor: number;
  /** Change against the baseline; null for a merchant new in the period. */
  share: number | null;
}

/** Recurring charges (as of today) that started, went up or stopped within the period. */
export interface RecurringChanges {
  started: RecurringCharge[];
  priceUps: RecurringCharge[];
  stopped: RecurringCharge[];
}

export interface PendingRefunds {
  count: number;
  /** Money coming back, as a positive amount. */
  totalMinor: number;
  ids: string[];
  /** The largest, at most `maxItems`, each with its own merchant name (and its group) and as a positive amount. */
  items: Array<{ id: string; merchant: string; key: string; amountMinor: number; date: string }>;
}

export interface DuplicateCharge {
  ids: [string, string];
  merchant: string;
  key: string;
  amountMinor: number;
  dates: [string, string];
  cardAccountId: string;
}

export interface NewMerchantCharge {
  id: string;
  merchant: string;
  key: string;
  amountMinor: number;
  date: string;
}

export interface CardCosts {
  feesMinor: number;
  interestMinor: number;
  /** Fee rows for foreign transactions or currency conversion, part of `feesMinor`. */
  foreignFeesMinor: number;
  /** Fee and interest reversals (adjustments), zero or negative. */
  reversalsMinor: number;
}

export interface CardSpendingInsights {
  currency: string;
  /** The month the pace is about (the month shown, or this month for a span). */
  month: string;
  today: string;
  period: CardInsightPeriod;
  /** Posted spending in the period, and in its baseline (null without one). */
  spendingMinor: number;
  baselineMinor: number | null;
  /** Only for the current month, with enough history. */
  pace: SpendingPace | null;
  largePurchases: LargePurchases | null;
  /**
   * Against the baseline, on what was bought (purchases, and refunds from merchants bought from), without large
   * one-offs, fees, interest or adjustments (they are reported on their own).
   */
  movers: CategoryMover[];
  merchantMovers: MerchantMover[];
  /** As of today, whatever the period. */
  recurring: RecurringCharge[];
  recurringChanges: RecurringChanges;
  /** In the period, oldest first. */
  duplicates: DuplicateCharge[];
  /**
   * First charges at merchants new in a year (no purchase there, or at a variant of its name, in the year before),
   * not already among the large purchases: one per merchant and day, largest first.
   */
  newMerchants: NewMerchantCharge[];
  /** Pending refunds dated in the period. */
  pendingRefunds: PendingRefunds | null;
  /**
   * The period's, and the year to date of the period's last day. A fee credited back by an issuer adjustment of its
   * exact amount (same card, within 60 days) counts as neither, and a payment taken back (misposted, reversed,
   * returned) is no cost even where it is filed under fees.
   */
  costs: { period: CardCosts; year: CardCosts & { year: string } };
}

const FOREIGN_FEE = /\bFOREIGN\b|\bINTERNATIONAL\b|\bFX\b|CURRENCY CONVERSION|CROSS[- ]?BORDER/i;
/**
 * A payment taken back (misposted, reversed, returned or dishonoured): an issuer may file it under fees or
 * adjustments, but it moves a payment and is no cost. A fee for it ("RETURNED PAYMENT FEE") is one.
 */
const PAYMENT_WORD = /\b(?:PYMT|PMT|PAYMENT)S?\b/i;
const TAKEN_BACK_WORD = /\b(?:MISPOST\w*|REVERS\w*|RETURN\w*|DISHONOU?R\w*)\b/i;
const FEE_WORD = /\bFEES?\b/i;

function isPaymentTakenBack(row: Pick<CardInsightRow, 'description' | 'merchant'>): boolean {
  const text = `${row.description} ${row.merchant ?? ''}`;
  return PAYMENT_WORD.test(text) && TAKEN_BACK_WORD.test(text) && !FEE_WORD.test(text);
}

function scale(amount: number, currency: string): number {
  return Math.round(amount * 10 ** currencyExponent(currency));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

function dateOf(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

function daysInMonth(month: string): number {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
}

function addMonths(month: string, delta: number): string {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + delta;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

function sum(rows: readonly CardInsightRow[]): number {
  return rows.reduce((total, row) => total + row.amountMinor, 0);
}

/** Spending rows (purchases, fees, interest, refunds, adjustments) of one status. */
function spending(rows: readonly CardInsightRow[], status: 'posted' | 'pending'): CardInsightRow[] {
  return rows.filter((row) => cardSpendingRole(row.kind) === 'spending' && row.status === status);
}

interface SeriesOptions {
  /** Picked out of a merchant's purchases by price. */
  fromCluster?: boolean;
  /** Only a yearly rhythm counts (the long look back that finds a yearly charge's earlier payment). */
  onlyAnnual?: boolean;
}

function cadenceOf(intervals: readonly number[], occurrences: number, options: SeriesOptions) {
  if (intervals.length === 0) return null;
  const typical = median(intervals);
  const match = CADENCES.find((item) => typical >= item.min && typical <= item.max);
  if (!match) return null;
  if (options.onlyAnnual && match.cadence !== 'annual') return null;
  // Two yearly charges are enough only when they are all the merchant has: a
  // pair picked out of many purchases by price can be chance.
  const needed = match.cadence === 'annual' && !options.fromCluster ? 2
    : match.cadence === 'weekly' || match.cadence === 'biweekly' ? CARD_INSIGHT_THRESHOLDS.recurringMinOccurrences + 1
      : CARD_INSIGHT_THRESHOLDS.recurringMinOccurrences;
  if (occurrences < needed) return null;
  const regular = intervals.filter((interval) => Math.abs(interval - match.days) <= match.tolerance).length;
  return regular / intervals.length >= CARD_INSIGHT_THRESHOLDS.recurringRegularShare ? match : null;
}

/**
 * Splits amounts, in date order, into runs of one price (each within the
 * fixed spread of the run's first amount).
 */
function priceRuns(amounts: readonly number[]): number[][] {
  const runs: number[][] = [];
  for (const amount of amounts) {
    const run = runs[runs.length - 1];
    if (run && Math.abs(amount - run[0]) <= Math.abs(run[0]) * CARD_INSIGHT_THRESHOLDS.recurringFixedSpread) run.push(amount);
    else runs.push([amount]);
  }
  return runs;
}

function recurringSeries(
  key: string,
  merchant: string,
  series: readonly CardInsightRow[],
  today: number,
  options: SeriesOptions = {},
): RecurringCharge | null {
  const days = series.map((row) => dayNumber(row.transactionDate));
  const intervals = days.slice(1).map((day, index) => day - days[index]);
  const cadence = cadenceOf(intervals, series.length, options);
  if (!cadence) return null;
  const amounts = series.map((row) => row.amountMinor);
  if (series.length === 2 && Math.abs(amounts[1] - amounts[0])
    > Math.max(amounts[0], amounts[1]) * CARD_INSIGHT_THRESHOLDS.recurringAnnualPairSpread) return null;
  const last = amounts[amounts.length - 1];
  const currency = series[0].currency;
  // One price throughout, or one earlier price then a new one: a fixed charge.
  // More changes than that: a bill whose amount varies. A yearly renewal seen
  // twice is fixed, perhaps repriced.
  const runs = priceRuns(amounts);
  const fixed = runs.length === 1 || (runs.length === 2 && (runs[0].length >= 2 || series.length === 2));
  const before = runs.length === 2 ? median(runs[0]) : last;
  const changed = fixed && runs.length === 2
    && Math.abs(last - before) >= Math.max(scale(CARD_INSIGHT_THRESHOLDS.priceChangeMin, currency), before * CARD_INSIGHT_THRESHOLDS.priceChangeShare);
  const typical = fixed ? median(runs[runs.length - 1]) : median(amounts);
  const lastDay = days[days.length - 1];
  const next = lastDay + Math.round(cadence.days);
  return {
    key,
    merchant,
    cadence: cadence.cadence,
    fixed,
    typicalMinor: typical,
    lastMinor: last,
    firstDate: dateOf(days[0]),
    lastDate: dateOf(lastDay),
    nextDate: dateOf(next),
    occurrences: series.length,
    monthlyMinor: Math.round(typical * (30.44 / cadence.days)),
    active: today <= next + cadence.tolerance * 2,
    priceChange: changed ? { fromMinor: before, toMinor: last, since: dateOf(days[runs[0].length]) } : null,
    cardAccountIds: [...new Set(series.map((row) => row.cardAccountId))].sort(),
  };
}

/** A recurring charge, with the purchases its series is made of. */
interface RecurringFind {
  charge: RecurringCharge;
  rows: readonly CardInsightRow[];
}

/**
 * One merchant group's recurring charges: the whole series when its dates
 * keep a rhythm, otherwise series of one price each (one merchant billing
 * several subscriptions).
 */
function groupRecurring(
  key: string,
  merchant: string,
  list: readonly CardInsightRow[],
  today: number,
  onlyAnnual: boolean,
): RecurringFind[] {
  if (list.length < 2) return [];
  const series = [...list].sort((a, b) => (a.transactionDate < b.transactionDate ? -1 : a.transactionDate > b.transactionDate ? 1 : 0));
  const whole = recurringSeries(key, merchant, series, today, { onlyAnnual });
  if (whole) return [{ charge: whole, rows: series }];
  const clusters: CardInsightRow[][] = [];
  for (const row of [...series].sort((a, b) => a.amountMinor - b.amountMinor)) {
    const cluster = clusters.find((items) => Math.abs(row.amountMinor - median(items.map((item) => item.amountMinor)))
      <= Math.max(1, row.amountMinor * CARD_INSIGHT_THRESHOLDS.recurringClusterSpread));
    if (cluster) cluster.push(row);
    else clusters.push([row]);
  }
  const found: RecurringFind[] = [];
  for (const cluster of clusters) {
    if (cluster.length === list.length) continue;
    const ordered = cluster.sort((a, b) => (a.transactionDate < b.transactionDate ? -1 : 1));
    const charge = recurringSeries(key, merchant, ordered, today, { fromCluster: true, onlyAnnual });
    if (charge) found.push({ charge, rows: ordered });
  }
  return found;
}

/**
 * Recurring charges among posted purchases, per merchant group, from the
 * last `recurringLookbackDays`. A group with none there is looked at again
 * over `recurringAnnualLookbackDays` for a yearly charge only, whose earlier
 * payment is up to two years back: so a yearly subscription stays listed
 * (and active) all year until its renewal is overdue.
 */
export function findRecurringCharges(rows: readonly CardInsightRow[], today: string): RecurringCharge[] {
  return recurringFinds(rows, today).map((find) => find.charge);
}

/** The recurring charges {@link findRecurringCharges} finds, in its order, each with the ids of the purchases in its series. */
export function findRecurringCardSeries(rows: readonly CardInsightRow[], today: string): Array<{ charge: RecurringCharge; rowIds: string[] }> {
  return recurringFinds(rows, today).map((find) => ({ charge: find.charge, rowIds: find.rows.map((row) => row.id) }));
}

function recurringFinds(rows: readonly CardInsightRow[], today: string): RecurringFind[] {
  const todayNumber = dayNumber(today);
  const t = CARD_INSIGHT_THRESHOLDS;
  const age = (row: CardInsightRow) => todayNumber - dayNumber(row.transactionDate);
  const purchases = rows.filter((row) => row.status === 'posted' && row.kind === 'purchase' && row.amountMinor > 0
    && age(row) >= 0 && age(row) <= t.recurringAnnualLookbackDays);
  const keyed = purchases.map((row) => ({ row, key: cardMerchantKey(effectiveCardMerchant(row)), name: effectiveCardMerchant(row) }));
  const groups = groupCardMerchantKeys(keyed.map((item) => item.key));
  const names = displayNames(keyed, groups);
  const byGroup = new Map<string, CardInsightRow[]>();
  for (const item of keyed) {
    if (!isCardMerchantKey(item.key)) continue;
    const group = groups.get(item.key)!;
    byGroup.set(group, [...(byGroup.get(group) ?? []), item.row]);
  }
  const found: RecurringFind[] = [];
  for (const [key, list] of byGroup) {
    const merchant = names.get(key) ?? key;
    const recent = groupRecurring(key, merchant, list.filter((row) => age(row) <= t.recurringLookbackDays), todayNumber, false);
    found.push(...(recent.length > 0 ? recent : groupRecurring(key, merchant, list, todayNumber, true)));
  }
  return found.sort((a, b) => Number(b.charge.active) - Number(a.charge.active) || b.charge.monthlyMinor - a.charge.monthlyMinor
    || (a.charge.merchant < b.charge.merchant ? -1 : 1));
}

function monthTotalsUpTo(rows: readonly CardInsightRow[], month: string, lastDay: number): number {
  const end = `${month}-${String(Math.min(lastDay, daysInMonth(month))).padStart(2, '0')}`;
  return sum(rows.filter((row) => row.transactionDate >= `${month}-01` && row.transactionDate <= end));
}

/** Earlier months with any spending, newest first, up to the history limit. */
function historyMonths(rows: readonly CardInsightRow[], month: string): string[] {
  const months = new Set(rows.map((row) => row.transactionDate.slice(0, 7)));
  const result: string[] = [];
  for (let back = 1; back <= 24 && result.length < CARD_INSIGHT_THRESHOLDS.historyMonths; back += 1) {
    const candidate = addMonths(month, -back);
    if (months.has(candidate)) result.push(candidate);
  }
  return result;
}

function costs(rows: readonly CardInsightRow[]): CardCosts {
  const posted = rows.filter((row) => row.status === 'posted' && !isPaymentTakenBack(row));
  const fees = posted.filter((row) => row.kind === 'fee');
  return {
    feesMinor: sum(fees),
    interestMinor: sum(posted.filter((row) => row.kind === 'interest')),
    foreignFeesMinor: sum(fees.filter((row) => FOREIGN_FEE.test(row.description))),
    reversalsMinor: sum(posted.filter((row) => row.kind === 'adjustment')),
  };
}

function pad(day: number): string {
  return String(day).padStart(2, '0');
}

/**
 * The Month period's days and comparison: the month against the month before,
 * or (for the current month, up to today) the month before to the same day.
 */
export function cardMonthInsightPeriod(month: string, today: string): CardInsightPeriod {
  const current = today.slice(0, 7) === month;
  const lastDay = current ? Number(today.slice(8, 10)) : daysInMonth(month);
  const before = addMonths(month, -1);
  const beforeLast = current ? Math.min(lastDay, daysInMonth(before)) : daysInMonth(before);
  return {
    from: `${month}-01`,
    to: `${month}-${pad(lastDay)}`,
    baseline: { from: `${before}-01`, to: `${before}-${pad(beforeLast)}` },
  };
}

function quantile(values: readonly number[], share: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
}

function within(date: string, range: { from: string; to: string }): boolean {
  return date >= range.from && date <= range.to;
}

/**
 * Two merchant groups that are likely one merchant for "first time here": one
 * names the other and more ("SAMPLE TOOLS" and "SAMPLE TOOLS DULUTH"), or
 * both go on past the same two words ("SAMPLE TOOLS DULUTH", "SAMPLE TOOLS
 * ATHENS"). Looser than the grouping on purpose: it only stops a claim.
 */
function relatedMerchantGroups(a: string, b: string): boolean {
  if (a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `)) return true;
  const left = a.split(' ');
  const right = b.split(' ');
  return left.length > 2 && right.length > 2 && left[0] === right[0] && left[1] === right[1];
}

function byDay<T extends { transactionDate: string; id: string }>(a: T, b: T): number {
  return a.transactionDate < b.transactionDate ? -1 : a.transactionDate > b.transactionDate ? 1 : a.id < b.id ? -1 : 1;
}

/** A posted purchase with its merchant key, name and day. */
interface KeyedPurchase {
  row: CardInsightRow;
  key: string;
  name: string;
  day: number;
}

/**
 * What insights and the large one-off split read in one currency: the rows that count (asset purchases aside), posted
 * spending, and merchant groups over every posted purchase, so a finding names a group its Show reaches exactly.
 */
function insightRows(rows: readonly CardInsightRow[], currency: string, exclusions: ReadonlyMap<string, CardSpendingExclusion> | undefined) {
  const inCurrency = rows.filter((row) => row.currency === currency && !cardSpendingExclusionOf(row, exclusions));
  const spent = spending(inCurrency, 'posted');
  const posted = inCurrency.filter((row) => row.status === 'posted');
  const keyedPurchases: KeyedPurchase[] = posted
    .filter((row) => row.kind === 'purchase' && row.amountMinor > 0)
    .map((row) => ({ row, key: cardMerchantKey(effectiveCardMerchant(row)), name: effectiveCardMerchant(row), day: dayNumber(row.transactionDate) }));
  const groups = groupCardMerchantKeys(keyedPurchases.map((item) => item.key));
  const groupOf = (key: string) => groups.get(key) ?? key;
  const purchaseRoots = [...new Set(groups.values())];
  // A refund or fee row's merchant joins a purchase group only through a recognized descriptor extension.
  const merchantGroup = (key: string) => groups.get(key) ?? purchaseRoots.find((root) => matchesCardMerchantGroup(key, root)) ?? key;
  return { currency, inCurrency, spent, posted, keyedPurchases, groups, groupOf, purchaseRoots, merchantGroup };
}
type InsightRows = ReturnType<typeof insightRows>;

/**
 * Recurring charges are grouped over their own window of history, so a purchase is at a recurring merchant when its
 * group here, its own name, or a descriptor of it is one of theirs.
 */
function atRecurringMerchant(base: InsightRows, recurring: readonly RecurringCharge[]): (item: KeyedPurchase) => boolean {
  const recurringRoots = new Set(recurring.flatMap((charge) => [charge.key, base.merchantGroup(charge.key)]));
  return (item) => recurringRoots.has(base.groupOf(item.key)) || recurringRoots.has(item.key)
    || recurring.some((charge) => matchesCardMerchantGroup(item.key, charge.key));
}

/**
 * Whether a credit may be set against a purchase by their orders. A credit linked to no order goes by the merchant rule
 * alone. So does one none of whose orders has a charge linked to a card row: which purchase it belongs to is not
 * known. Any other credit's link is decisive: it goes only with one of its orders' charges. Null without links: the
 * merchant rule alone. Each credit's and each order's links are asked for once, and only for a pair the merchant rule
 * allows.
 */
function orderMatcher(links: CardOrderLinks | undefined): ((creditId: string, purchaseId: string) => boolean) | null {
  if (!links) return null;
  const orderCharges = new Map<string, readonly string[]>();
  const chargesOf = (order: string) => {
    let ids = orderCharges.get(order);
    if (!ids) orderCharges.set(order, (ids = links.chargeIdsOf(order) ?? []));
    return ids;
  };
  /** Per credit: its orders' charges, by row id; empty when it goes by the merchant rule alone. */
  const creditCharges = new Map<string, ReadonlySet<string>>();
  return (creditId, purchaseId) => {
    let charges = creditCharges.get(creditId);
    if (!charges) creditCharges.set(creditId, (charges = new Set((links.orderRefsOf(creditId) ?? []).flatMap(chargesOf))));
    return charges.size === 0 || charges.has(purchaseId);
  };
}

/**
 * Large one-offs: well above what this household usually pays for one purchase over the year to `through`, and not
 * at a merchant that bills on a rhythm; with the refunds set against them, and everyday spending without both.
 */
function splitLarge(base: InsightRows, atRecurring: (item: KeyedPurchase) => boolean, through: string, orderLinks?: CardOrderLinks) {
  const t = CARD_INSIGHT_THRESHOLDS;
  const { keyedPurchases, posted, spent, groupOf, merchantGroup } = base;
  const toDay = dayNumber(through);
  const yearAmounts = keyedPurchases.filter((item) => item.day <= toDay && toDay - item.day < 365).map((item) => item.row.amountMinor);
  const thresholdMinor = Math.max(
    scale(t.largeMin, base.currency),
    quantile(yearAmounts, t.largeQuantile),
    yearAmounts.length > 0 ? median(yearAmounts) * t.largeMedianMultiple : 0,
  );
  const large = keyedPurchases.filter((item) => item.row.amountMinor >= thresholdMinor && !atRecurring(item))
    .sort((a, b) => byDay(a.row, b.row));
  const largeIds = new Set(large.map((item) => item.row.id));
  // A large purchase's refunds go with it: refunds on the same card at the same merchant, within 90 days after it, are
  // set against it, oldest first, each purchase up to its amount (one refund may cover several purchases, and what is
  // left of it stays an ordinary refund). A credit whose order link is decisive (`orderLinks`: one of its orders has a
  // charge linked to a card row) goes only with one of those charges, never with another order's purchase or an
  // unlinked one; a credit linked to no order, or to orders with no linked charge, goes by the merchant rule alone. One
  // returned in full is no large purchase, and what went back for it is no drop in everyday spending.
  const refundRows = posted.filter((row) => row.kind === 'refund' && row.amountMinor < 0).sort(byDay);
  const refundLeft = new Map(refundRows.map((row) => [row.id, -row.amountMinor]));
  const allocated = new Map<string, number>();
  const refundedBy = new Map<string, number>();
  const sameOrder = orderMatcher(orderLinks);
  for (const item of large) {
    let left = item.row.amountMinor;
    for (const refund of refundRows) {
      if (left === 0) break;
      const available = refundLeft.get(refund.id)!;
      const day = dayNumber(refund.transactionDate);
      if (available === 0 || refund.cardAccountId !== item.row.cardAccountId || day < item.day || day - item.day > 90
        || merchantGroup(cardMerchantKey(effectiveCardMerchant(refund))) !== groupOf(item.key)
        || (sameOrder !== null && !sameOrder(refund.id, item.row.id))) continue;
      const taken = Math.min(left, available);
      left -= taken;
      refundLeft.set(refund.id, available - taken);
      allocated.set(refund.id, (allocated.get(refund.id) ?? 0) + taken);
    }
    if (left < item.row.amountMinor) refundedBy.set(item.row.id, item.row.amountMinor - left);
  }
  /** Everyday spending: the posted rows without large one-offs, and without what was refunded for them. */
  const core = spent.flatMap((row): CardInsightRow[] => {
    if (largeIds.has(row.id)) return [];
    const back = allocated.get(row.id) ?? 0;
    if (back === 0) return [row];
    return row.amountMinor + back === 0 ? [] : [{ ...row, amountMinor: row.amountMinor + back }];
  });
  return { thresholdMinor, large, largeIds, allocated, refundedBy, core };
}

/** A large one-off purchase, with what was refunded for it. */
export interface CardLargePurchase {
  /** The posted purchase as given. */
  row: CardInsightRow;
  /** Its merchant group (filter with `matchesCardMerchantGroup`) and its own merchant name. */
  key: string;
  merchant: string;
  /**
   * Refunds set against it: same card and merchant, within 90 days after it, oldest first; a credit whose order link is
   * decisive (`orderLinks`) only when this is one of its orders' charges.
   */
  refundedMinor: number;
  /** What it cost: its amount less `refundedMinor` (zero when returned in full). */
  netMinor: number;
}

/**
 * Posted spending in one currency split into large one-off purchases and everyday spending, as the insights split it.
 * For any range of days R, exactly: spending dated in R = the large purchases dated in R − the parts of refunds dated in
 * R set against them + everyday rows dated in R.
 */
export interface CardLargePurchaseSplit {
  currency: string;
  /** Purchases at or above this (as of `through`), not at a recurring merchant, are large one-offs. */
  thresholdMinor: number;
  /** Every large purchase, whatever its date, oldest first. */
  large: CardLargePurchase[];
  /** Per refund row id: the part of it set against large purchases, in positive minor units. */
  refundsSetAgainstLarge: ReadonlyMap<string, number>;
  /**
   * Everyday spending: the posted spending rows without the large purchases, a refund less its part set against them
   * (and left out when that is all of it). Rows keep their ids and dates; amounts are what remains. Recurring charges
   * are everyday spending here.
   */
  everyday: CardInsightRow[];
}

/**
 * The insights' large one-off split over any rows (dates and statuses as they come; posted rows of `currency` count,
 * asset purchases aside): one threshold as of `through`, from the year of purchases up to it, and recurring merchants
 * as of `today` (default `through`). With `orderLinks`, a credit with a decisive order link (one of its orders has a
 * charge linked to a card row, anywhere in the household) is set only against one of those charges; without them,
 * every refund goes by the merchant rule alone. `computeCardInsights` splits with the same code.
 */
export function splitLargeCardPurchases(
  rows: readonly CardInsightRow[],
  options: {
    currency: string;
    through: string;
    today?: string;
    exclusions?: ReadonlyMap<string, CardSpendingExclusion>;
    orderLinks?: CardOrderLinks;
  },
): CardLargePurchaseSplit {
  const base = insightRows(rows, options.currency, options.exclusions);
  const atRecurring = atRecurringMerchant(base, findRecurringCharges(base.inCurrency, options.today ?? options.through));
  const split = splitLarge(base, atRecurring, options.through, options.orderLinks);
  return {
    currency: options.currency,
    thresholdMinor: split.thresholdMinor,
    large: split.large.map((item) => {
      const refundedMinor = split.refundedBy.get(item.row.id) ?? 0;
      return { row: item.row, key: base.groupOf(item.key), merchant: item.name, refundedMinor, netMinor: item.row.amountMinor - refundedMinor };
    }),
    refundsSetAgainstLarge: split.allocated,
    everyday: split.core,
  };
}

/**
 * Insights for a period in one currency (the month's own days and the month
 * before when no period is given). Rows may span any dates and statuses;
 * every figure counts posted rows only, like the spending totals
 * (`summarizeCardSpending`): a pending charge may still change, vanish, or
 * already be in as its posted version under another reference. The pace
 * reports the month's pending charges on their own.
 *
 * Large one-off purchases are reported together, with the period (and its
 * baseline) without them, and left out of the movers, which compare the
 * period with its baseline by category (naming the merchants behind each
 * change) and by merchant. Recurring charges are as of today; the ones that
 * started, went up or stopped within the period are listed apart.
 */
export function computeCardInsights(
  rows: readonly CardInsightRow[],
  options: {
    month: string;
    today: string;
    currency: string;
    period?: CardInsightPeriod;
    /**
     * Accepted category parts per row id (cardCategoryParts.ts), one snapshot for the period and its baseline alike.
     * Only the category movers, a large purchase's category and the new-category check read them.
     */
    categoryParts?: ReadonlyMap<string, readonly CardCategoryPart[]>;
    /** Told of every row whose category the answer reads, and whether it was read through its parts. */
    onCategoryRead?: (rowId: string, throughParts: boolean) => void;
    /**
     * Asset purchases by row id (cardSpendingExclusions.ts). They are not spending, so no figure here reads them; a
     * row with the owner's asset category is left out with or without this map.
     */
    exclusions?: ReadonlyMap<string, CardSpendingExclusion>;
    /**
     * Order links (the Amazon domain's), the household's. A credit with a decisive order link (one of its orders has a
     * charge linked to a card row) is set only against one of those charges; a credit linked to no order, or to orders
     * with no linked charge, and every refund without this, goes by the merchant rule alone.
     */
    orderLinks?: CardOrderLinks;
  },
): CardSpendingInsights {
  const { month, today, currency } = options;
  const period = options.period ?? cardMonthInsightPeriod(month, today);
  const { baseline } = period;
  const t = CARD_INSIGHT_THRESHOLDS;
  const base = insightRows(rows, currency, options.exclusions);
  const { inCurrency, spent, posted, keyedPurchases, groups, groupOf, purchaseRoots, merchantGroup } = base;
  // A row's parts while it is whole: a refund partly set against a large purchase below stays under its own category.
  const partsOf = (row: CardInsightRow): readonly CardCategoryPart[] | null => {
    const parts = options.categoryParts?.get(row.id);
    const whole = parts && parts.reduce((sum, part) => sum + part.amountMinor, 0) === row.amountMinor ? parts : null;
    options.onCategoryRead?.(row.id, whole !== null);
    return whole;
  };
  const categoryAmounts = (row: CardInsightRow): Array<[string, number]> => {
    const parts = partsOf(row);
    return parts ? [...cardCategoryPartTotals(parts)] : [[effectiveCardCategory(row), row.amountMinor]];
  };

  const groupNames = displayNames(keyedPurchases, groups);
  const firstDay = keyedPurchases.reduce((first, item) => Math.min(first, item.day), Infinity);
  const byGroup = new Map<string, KeyedPurchase[]>();
  for (const item of keyedPurchases) byGroup.set(groupOf(item.key), [...(byGroup.get(groupOf(item.key)) ?? []), item]);
  const related = new Map<string, string[]>();
  const relatedTo = (group: string) => {
    if (!related.has(group)) related.set(group, [...byGroup.keys()].filter((other) => relatedMerchantGroups(group, other)));
    return related.get(group)!;
  };
  // No purchase at this merchant (or a variant of it) on an earlier day in the year before, with 90 days of history.
  const firstTime = (item: KeyedPurchase) => isCardMerchantKey(item.key) && item.day - firstDay >= t.newMerchantBaselineDays
    && !relatedTo(groupOf(item.key)).some((group) => byGroup.get(group)!.some((other) => other.day < item.day && item.day - other.day <= 365));

  // Recurring charges are as of today, whatever the period.
  const recurring = findRecurringCharges(inCurrency, today);
  const atRecurring = atRecurringMerchant(base, recurring);

  // Large one-offs, with one threshold for the period, its baseline and the pace's months: as of the period's end.
  const { thresholdMinor, large, largeIds, allocated, refundedBy, core } = splitLarge(base, atRecurring, period.to, options.orderLinks);
  const netOf = (item: KeyedPurchase) => item.row.amountMinor - (refundedBy.get(item.row.id) ?? 0);
  const largeIn = (range: { from: string; to: string }) => large.filter((item) => within(item.row.transactionDate, range) && netOf(item) > 0);
  const coreIn = (range: { from: string; to: string }) => sum(core.filter((row) => within(row.transactionDate, range)));

  const spendingIn = (range: { from: string; to: string }) => sum(spent.filter((row) => within(row.transactionDate, range)));
  const spendingMinor = spendingIn(period);
  const baselineMinor = baseline ? spendingIn(baseline) : null;

  const periodLarge = largeIn(period).sort((a, b) => netOf(b) - netOf(a) || (a.row.id < b.row.id ? -1 : 1));
  const largeTotal = periodLarge.reduce((total, item) => total + netOf(item), 0);
  const coreMinor = coreIn(period);
  const largePurchases: LargePurchases | null = periodLarge.length === 0 ? null : {
    thresholdMinor,
    count: periodLarge.length,
    totalMinor: largeTotal,
    share: coreMinor + largeTotal > 0 ? largeTotal / (coreMinor + largeTotal) : null,
    coreMinor,
    baselineCoreMinor: baseline ? coreIn(baseline) : null,
    items: periodLarge.slice(0, t.maxItems).map((item) => {
      const parts = partsOf(item.row);
      return {
        id: item.row.id,
        merchant: item.name,
        key: groupOf(item.key),
        amountMinor: netOf(item),
        refundedMinor: refundedBy.get(item.row.id) ?? 0,
        date: item.row.transactionDate,
        category: parts ? largestCardCategory(parts) : effectiveCardCategory(item.row),
        ...(parts ? { split: cardCategorySplitView(parts) } : {}),
        firstTime: firstTime(item),
      };
    }),
  };

  // The pace is the month's own: only while the period is this month's days.
  const isCurrent = today.slice(0, 7) === month;
  const lastDay = isCurrent ? Number(today.slice(8, 10)) : daysInMonth(month);
  const history = historyMonths(spent, month);
  let pace: SpendingPace | null = null;
  if (isCurrent && period.from === `${month}-01` && period.to.slice(0, 7) === month && history.length >= t.minHistoryMonths) {
    const spentMinor = monthTotalsUpTo(spent, month, lastDay);
    // A usual month is everyday spending: one big purchase last month would make every month after look small.
    const typicalToDateMinor = Math.round(history.reduce((acc, item) => acc + monthTotalsUpTo(core, item, lastDay), 0) / history.length);
    const typicalMonthMinor = Math.round(history.reduce((acc, item) => acc + monthTotalsUpTo(core, item, 31), 0) / history.length);
    const monthRange = { from: `${month}-01`, to: `${month}-${pad(lastDay)}` };
    pace = {
      daysElapsed: lastDay,
      daysInMonth: daysInMonth(month),
      spentMinor,
      pendingMinor: monthTotalsUpTo(spending(inCurrency, 'pending'), month, lastDay),
      typicalToDateMinor,
      typicalMonthMinor,
      // Not a straight line: one large purchase would inflate the whole month,
      // and bills that usually land later would be missed.
      projectedMinor: lastDay >= t.paceMinDays ? spentMinor + Math.max(0, typicalMonthMinor - typicalToDateMinor) : null,
      historyMonths: history.length,
      largeMinor: spentMinor - coreIn(monthRange),
      largeCount: largeIn(monthRange).length,
    };
  }

  // Same card, merchant and amount within a few days, in the period. A recurring charge billed twice is worth checking
  // too; weekly series never fall that close together. Only a refund on the same card settles it.
  const refunds = posted.filter((row) => row.amountMinor < 0 && row.kind === 'refund')
    .map((row) => ({
      cardAccountId: row.cardAccountId,
      key: merchantGroup(cardMerchantKey(effectiveCardMerchant(row))),
      amount: -row.amountMinor,
      day: dayNumber(row.transactionDate),
    }));
  const inPeriod = keyedPurchases.filter((item) => within(item.row.transactionDate, period));
  const duplicates: DuplicateCharge[] = [];
  const used = new Set<string>();
  for (const item of [...inPeriod].sort((a, b) => a.day - b.day || (a.row.id < b.row.id ? -1 : 1))) {
    if (!isCardMerchantKey(item.key)) continue;
    if (used.has(item.row.id) || item.row.amountMinor < scale(t.duplicateMin, currency)) continue;
    const group = groupOf(item.key);
    const twin = keyedPurchases.find((other) => other.row.id !== item.row.id && !used.has(other.row.id)
      && other.row.cardAccountId === item.row.cardAccountId && groupOf(other.key) === group
      && other.row.amountMinor === item.row.amountMinor && other.day >= item.day && other.day - item.day <= t.duplicateDays);
    if (!twin) continue;
    const refunded = refunds.some((refund) => refund.cardAccountId === item.row.cardAccountId && refund.key === group
      && refund.amount === item.row.amountMinor && refund.day >= item.day && refund.day - item.day <= 45);
    if (refunded) continue;
    used.add(item.row.id);
    used.add(twin.row.id);
    duplicates.push({
      ids: [item.row.id, twin.row.id],
      merchant: twin.name,
      key: group,
      amountMinor: item.row.amountMinor,
      dates: [item.row.transactionDate, twin.row.transactionDate],
      cardAccountId: item.row.cardAccountId,
    });
  }

  // A first charge at a merchant new in a year, large for this household; the large one-offs list their own.
  // Several on its first day are one finding: the largest.
  const newMerchants: NewMerchantCharge[] = [];
  for (const item of inPeriod) {
    if (!isCardMerchantKey(item.key) || largeIds.has(item.row.id) || !firstTime(item)) continue;
    const recent = keyedPurchases.filter((other) => other.day < item.day && item.day - other.day <= 180).map((other) => other.row.amountMinor);
    if (item.row.amountMinor >= Math.max(scale(t.newMerchantMin, currency), quantile(recent, 0.9))) {
      newMerchants.push({ id: item.row.id, merchant: item.name, key: groupOf(item.key), amountMinor: item.row.amountMinor, date: item.row.transactionDate });
    }
  }
  newMerchants.sort((a, b) => b.amountMinor - a.amountMinor || (a.id < b.id ? -1 : 1));
  const firstCharges = newMerchants.filter((item, index) => newMerchants.findIndex((other) => other.key === item.key && other.date === item.date) === index);

  // A fee credited back by the issuer (an adjustment of exactly its amount, on the same card within 60 days) is no
  // cost, and its credit no reversal to report. A merchant refund never cancels a fee, and a payment taken back
  // (no cost either way) never takes the credit meant for one.
  const corrections = new Set<string>();
  const adjustments = posted.filter((row) => row.kind === 'adjustment' && row.amountMinor < 0 && !isPaymentTakenBack(row)).sort(byDay);
  for (const fee of posted.filter((row) => row.kind === 'fee' && row.amountMinor > 0 && !isPaymentTakenBack(row)).sort(byDay)) {
    const credit = adjustments.find((row) => !corrections.has(row.id) && row.cardAccountId === fee.cardAccountId && row.amountMinor === -fee.amountMinor
      && Math.abs(dayNumber(row.transactionDate) - dayNumber(fee.transactionDate)) <= 60);
    if (!credit) continue;
    corrections.add(fee.id);
    corrections.add(credit.id);
  }

  // Movers: the period against its baseline by category (naming the merchants behind each change) and by merchant,
  // on what was bought: purchases, and refunds from merchants bought from, in everyday spending; large one-offs,
  // fees, interest and adjustments aside (they have cards of their own). Nothing to compare with (no baseline, or
  // nothing spent in it): no movers.
  const purchaseGroups = new Set(purchaseRoots);
  const bought = core.filter((row) => row.kind === 'purchase'
    || (row.kind === 'refund' && purchaseGroups.has(merchantGroup(cardMerchantKey(effectiveCardMerchant(row))))));
  const movers: CategoryMover[] = [];
  const merchantMovers: MerchantMover[] = [];
  if (baseline && baselineMinor !== null && baselineMinor > 0) {
    const nameOf = new Map<string, string>();
    const totals = (range: { from: string; to: string }) => {
      const byCategory = new Map<string, number>();
      const byCategoryMerchant = new Map<string, Map<string, number>>();
      const byMerchant = new Map<string, number>();
      for (const row of bought) {
        if (!within(row.transactionDate, range)) continue;
        const key = merchantGroup(cardMerchantKey(effectiveCardMerchant(row)));
        if (!nameOf.has(key)) nameOf.set(key, groupNames.get(key) ?? effectiveCardMerchant(row));
        for (const [category, amountMinor] of categoryAmounts(row)) {
          byCategory.set(category, (byCategory.get(category) ?? 0) + amountMinor);
          const merchants = byCategoryMerchant.get(category) ?? new Map<string, number>();
          merchants.set(key, (merchants.get(key) ?? 0) + amountMinor);
          byCategoryMerchant.set(category, merchants);
        }
        if (isCardMerchantKey(key)) byMerchant.set(key, (byMerchant.get(key) ?? 0) + row.amountMinor);
      }
      return { byCategory, byCategoryMerchant, byMerchant };
    };
    const now = totals(period);
    const before = totals(baseline);
    const moverMin = scale(t.moverMin, currency);
    for (const category of new Set([...now.byCategory.keys(), ...before.byCategory.keys()])) {
      const currentMinor = now.byCategory.get(category) ?? 0;
      const typicalMinor = before.byCategory.get(category) ?? 0;
      const deltaMinor = currentMinor - typicalMinor;
      if (Math.abs(deltaMinor) < moverMin) continue;
      if (typicalMinor > 0 && Math.abs(deltaMinor) < typicalMinor * t.moverShare) continue;
      const nowMerchants = now.byCategoryMerchant.get(category) ?? new Map<string, number>();
      const beforeMerchants = before.byCategoryMerchant.get(category) ?? new Map<string, number>();
      const drivers = [...new Set([...nowMerchants.keys(), ...beforeMerchants.keys()])]
        .filter((key) => isCardMerchantKey(key))
        .map((key) => ({ key, merchant: nameOf.get(key) ?? key, deltaMinor: (nowMerchants.get(key) ?? 0) - (beforeMerchants.get(key) ?? 0) }))
        .filter((driver) => Math.sign(driver.deltaMinor) === Math.sign(deltaMinor) && driver.deltaMinor !== 0)
        .sort((a, b) => Math.abs(b.deltaMinor) - Math.abs(a.deltaMinor) || (a.key < b.key ? -1 : 1))
        .filter((driver, index) => index === 0 || Math.abs(driver.deltaMinor) >= Math.abs(deltaMinor) * t.moverDriverShare)
        .slice(0, 2);
      movers.push({ category, currentMinor, typicalMinor, deltaMinor, share: typicalMinor > 0 ? deltaMinor / typicalMinor : null, drivers });
    }
    movers.sort((a, b) => Math.abs(b.deltaMinor) - Math.abs(a.deltaMinor) || (a.category < b.category ? -1 : 1));
    const merchantMin = scale(t.merchantMoverMin, currency);
    for (const key of new Set([...now.byMerchant.keys(), ...before.byMerchant.keys()])) {
      const currentMinor = now.byMerchant.get(key) ?? 0;
      const baselineMerchantMinor = before.byMerchant.get(key) ?? 0;
      const deltaMinor = currentMinor - baselineMerchantMinor;
      if (Math.abs(deltaMinor) < merchantMin) continue;
      if (baselineMerchantMinor > 0 && Math.abs(deltaMinor) < baselineMerchantMinor * t.merchantMoverShare) continue;
      merchantMovers.push({
        key, merchant: nameOf.get(key) ?? key, currentMinor, baselineMinor: baselineMerchantMinor, deltaMinor,
        share: baselineMerchantMinor > 0 ? deltaMinor / baselineMerchantMinor : null,
      });
    }
    merchantMovers.sort((a, b) => Math.abs(b.deltaMinor) - Math.abs(a.deltaMinor) || (a.key < b.key ? -1 : 1));
  }

  // A category new in the period made up only of first charges at new merchants would say the same thing twice.
  const newMerchantIds = new Set(newMerchants.map((item) => item.id));
  const explainedByNewMerchants = (category: string) => {
    const list = bought.filter((row) => within(row.transactionDate, period)
      && categoryAmounts(row).some(([name]) => name === category));
    return list.length > 0 && list.every((row) => newMerchantIds.has(row.id));
  };
  const shownMovers = movers.filter((mover) => mover.share !== null || !explainedByNewMerchants(mover.category)).slice(0, t.maxItems);

  const pendingRefundRows = inCurrency.filter((row) => row.status === 'pending' && row.kind === 'refund' && row.amountMinor < 0
    && within(row.transactionDate, period));
  // A series "started" only where its cards' history goes back at least one billing interval before its first charge:
  // otherwise its first charge may just be where the imported history begins.
  const historyStart = (cardAccountIds: readonly string[]) => keyedPurchases
    .filter((item) => cardAccountIds.includes(item.row.cardAccountId))
    .reduce((first, item) => Math.min(first, item.day), Infinity);
  const startedAfterHistory = (charge: RecurringCharge) => dayNumber(charge.firstDate) - historyStart(charge.cardAccountIds)
    >= CADENCES.find((item) => item.cadence === charge.cadence)!.max;
  const year = period.to.slice(0, 4);
  return {
    currency,
    month,
    today,
    period,
    spendingMinor,
    baselineMinor,
    pace,
    largePurchases,
    movers: shownMovers,
    merchantMovers: merchantMovers.slice(0, t.maxItems),
    recurring,
    recurringChanges: {
      started: recurring.filter((charge) => charge.active && within(charge.firstDate, period) && startedAfterHistory(charge)),
      priceUps: recurring.filter((charge) => charge.active && charge.priceChange !== null
        && charge.priceChange.toMinor > charge.priceChange.fromMinor && within(charge.priceChange.since, period)),
      stopped: recurring.filter((charge) => !charge.active && within(charge.nextDate, period)),
    },
    duplicates,
    newMerchants: firstCharges,
    pendingRefunds: pendingRefundRows.length === 0 ? null : {
      count: pendingRefundRows.length,
      totalMinor: -sum(pendingRefundRows),
      ids: pendingRefundRows.map((row) => row.id),
      items: [...pendingRefundRows].sort((a, b) => a.amountMinor - b.amountMinor || (a.id < b.id ? -1 : 1)).slice(0, t.maxItems)
        .map((row) => ({
          id: row.id,
          merchant: effectiveCardMerchant(row),
          key: merchantGroup(cardMerchantKey(effectiveCardMerchant(row))),
          amountMinor: -row.amountMinor,
          date: row.transactionDate,
        })),
    },
    costs: {
      period: costs(inCurrency.filter((row) => !corrections.has(row.id) && within(row.transactionDate, period))),
      year: {
        year,
        ...costs(inCurrency.filter((row) => !corrections.has(row.id) && row.transactionDate >= `${year}-01-01` && row.transactionDate <= period.to)),
      },
    },
  };
}