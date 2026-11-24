/**
 * Spending's patterns and forecast over stored card transactions, learned only from months whose card record is
 * complete (cardSpendingCoverage.ts decides; a partial month is listed with its spending, marked, and never split or
 * fitted):
 * - the months: posted spending, its large one-offs and everyday spending, so spending = one-offs + everyday exactly;
 * - the next three months' everyday spending, for all of it and per category, each from its own monthly series
 *   (cardSpendingStats.ts: the method by history, a rolling-origin backtest, ranges from its errors, each with its
 *   tested coverage). The total is forecast from the total's own series, never by adding category estimates or ranges;
 * - this month's pace: everyday spending so far plus the typical rest of a month (an estimate, with an 80% range once
 *   its coverage can be tested), and the month's total: that plus the large one-offs already posted, counted once;
 * - unusual months (robust: the median and the MAD), and a calendar of the recurring bills due.
 *
 * Kept out of every baseline, forecast, anomaly and pace: asset purchases (precious metals the owner decided; never
 * spending, cardSpendingExclusions.ts) and large one-off purchases with the refunds set against them (the insights'
 * own split, splitLargeCardPurchases). Everything that split learns (the one-off threshold, which merchants bill on a
 * rhythm, which refunds pay a one-off back) comes from the complete months' rows alone, as of the last complete day:
 * a partial month's rows, or this month's, never change anything computed for a complete month. With the caller's
 * order links (the insights' and the overview's), a credit one of whose orders has a charge linked to a card row pays
 * back only one of those charges, decided from the household's links, never from the rows split. A row's category is
 * given, never learned here: its effective category (an inferred one the caller set included) or the caller's split
 * parts, counted exactly as the summary counts them. Amounts are integer
 * minor units of one currency. Pure and deterministic: the caller passes today and the complete months; every
 * threshold is a named constant here.
 */
import { currencyExponent } from './cardImportTool/amount.js';
import {
  findRecurringCardSeries, splitLargeCardPurchases, type CardInsightRow, type CardOrderLinks, type RecurringCadence,
} from './cardInsights.js';
import {
  cardCategoryPartTotals,
  cardSpendingExclusionOf,
  cardSpendingRole,
  effectiveCardCategory,
  type CardCategoryAmount,
  type CardSpendingExclusion,
} from './cardSpending.js';
import {
  empiricalRange,
  forecastSpendingSeries,
  knownValues,
  leaveOneOutCoverage,
  median,
  robustSpread,
  type CardForecastMethod,
  type RangeCoverage,
  type SeriesForecast,
  type SpendingSeries,
  type TestedRange,
} from './cardSpendingStats.js';

/** Thresholds, in major units of the currency where they are money. */
export const CARD_SPENDING_FORECAST = {
  /** The months forecast: the three after the current one. */
  horizonMonths: 3,
  /** The most recent complete months a forecast learns from. */
  fitMaxMonths: 60,
  /** MAPE leaves out actuals smaller than this: near zero, a percentage error says nothing. */
  mapeMinActual: 50,
  /**
   * A category is thin with fewer than `thinMinMonths` complete months, or spending in fewer than `thinActiveShare` of
   * them: its words use amounts, never percentages.
   */
  thinMinMonths: 6,
  thinActiveShare: 0.5,
  /** A series' typical month in its words: the median of its last this many complete months. */
  recentMonths: 6,
  /** Pace: the rest of the month from up to this many complete earlier months, needing `paceMinMonths`. */
  paceMonths: 12,
  paceMinMonths: 3,
  /**
   * Its 80% range needs this many: each month's rest is tested against the range the others give (an 80% range needs
   * 9 values), so the range never goes out untested.
   */
  paceRangeMinMonths: 10,
  /** Unusual: against at least `anomalyMinMonths` complete months before (up to `anomalyMonths`)... */
  anomalyMonths: 12,
  anomalyMinMonths: 6,
  /** ...further than this many robust standard deviations from their median... */
  anomalyZ: 3,
  /** ...and at least this far from it. */
  anomalyMin: 50,
  /** Bills: the calendar's days from today. */
  billsDays: 60,
} as const;

/** A row as the forecast reads it: an enriched answer's inferred category, where it has none of its own. */
export type CardForecastRow = CardInsightRow & { inferredCategory?: string | null };

export interface CardSpendingForecastInput {
  /** YYYY-MM-DD: the current month is in progress; the forecast covers the three months after it. */
  today: string;
  currency: string;
  /** Months (YYYY-MM) whose card record is complete for the cards in view (cardSpendingCoverage.ts). Only these are fitted. */
  completeMonths: ReadonlySet<string>;
  /** Asset purchases by row id (cardSpendingExclusions.ts): never spending, so in no baseline. */
  exclusions?: ReadonlyMap<string, CardSpendingExclusion>;
  /** Accepted category parts per row id (cardCategoryParts.ts): a whole split row counts under its parts' categories. */
  categoryParts?: ReadonlyMap<string, readonly CardCategoryAmount[]>;
  /** Whether every card in view has its record complete for this month's days before today; null when not known. */
  monthSoFarComplete?: boolean | null;
  /**
   * Order links (the Amazon domain's, cardInsights.ts `CardOrderLinks`), the household's whatever rows are given, as
   * the insights and the overview read them. In both splits, a credit one of whose orders has a charge linked to a
   * card row pays back only one of those charges; any other refund goes by the merchant rule. Without them, every
   * refund goes by the merchant rule alone.
   */
  orderLinks?: CardOrderLinks;
}

/**
 * One month: posted spending (as the summary counts it), its large one-offs and everyday spending. A partial month
 * shows its spending only: its record is incomplete, and nothing learned from complete months is spent splitting it.
 */
export interface CardSpendingMonthBook {
  month: string;
  spendingMinor: number;
  /**
   * Large one-off purchases dated in the month, less the parts of refunds dated in it set against them. Null for a
   * partial month (neither complete nor in progress).
   */
  oneOffsMinor: number | null;
  /** spendingMinor - oneOffsMinor; null for a partial month. */
  everydayMinor: number | null;
  /** Its card record is complete: only such months are fitted. */
  complete: boolean;
  /** The current month. */
  inProgress: boolean;
}

export interface CardForecastRange {
  lowerMinor: number;
  upperMinor: number;
  /** `extended`: a 95% range widened from the 80% one (too few backtest errors for its own ranks). */
  basis: TestedRange['basis'];
  /** Leave-one-month-out: past forecasts inside the range the other months gave, of all tested (never 0). */
  coverage: RangeCoverage;
}

/** A forecast's backtest, in money: accuracy on the last fifth of its complete months, and how its ranges held. */
export interface CardForecastBacktest {
  /** The months accuracy is reported on. */
  from: string;
  to: string;
  months: number;
  origins: number;
  forecasts: number;
  maeMinor: number;
  /** Mean error: above 0 when actual spending ran above the forecasts. */
  biasMinor: number;
  mase: number | null;
  maseBenchmark: 'seasonal-naive' | 'naive' | null;
  /** In percent, over actuals of at least `mapeMinActual`; null when none was. */
  mape: number | null;
  mapeForecasts: number;
  /** The months and forecasts the ranges are calibrated on. */
  calibrationMonths: number;
  calibrationForecasts: number;
  /** Leave-one-month-out: how many past forecasts fell inside the ranges the other months gave. */
  coverage80: RangeCoverage;
  coverage95: RangeCoverage;
}

export interface CardSeriesForecast {
  /** Null: all everyday spending. */
  category: string | null;
  /** Null: too few complete months to forecast. */
  method: CardForecastMethod | null;
  /** Backtested. An untested forecast is the median of recent months, with no range. */
  tested: boolean;
  /** Complete months it learned from. */
  historyMonths: number;
  /** Few complete months, or spending in fewer than half of them: amounts only, never percentages. */
  thin: boolean;
  /** The median of its last `recentMonths` complete months; null without any. */
  recentMedianMinor: number | null;
  /**
   * Per forecast month: the estimate, and its ranges with their tested coverage (null until the backtest has errors
   * from `rangeMinMonths` months to test them on).
   */
  months: Array<{ month: string; pointMinor: number; range80: CardForecastRange | null; range95: CardForecastRange | null }>;
  backtest: CardForecastBacktest | null;
  /** The methods compared (or tried), with their backtest MAE; null when one could not be backtested. */
  candidates: Array<{ method: CardForecastMethod; maeMinor: number | null }>;
}

/** The pace's 80% range, with its tested coverage. */
export interface CardPaceRange {
  lowerMinor: number;
  upperMinor: number;
  /** Leave one month out: the history months whose rest fell inside the range the other months gave, of all tested. */
  coverage: RangeCoverage;
}

/**
 * This month so far, and where it is heading. The pace is everyday spending's: so far plus the typical rest of a
 * month, from complete earlier months without one-offs (an estimate). The month's total adds the large one-offs
 * already posted, as posted: counted once, not projected. Exactly: spentMinor = everydaySpentMinor + oneOffsMinor,
 * everydayProjectedMinor = everydaySpentMinor + restMinor, projectedMinor = everydayProjectedMinor + oneOffsMinor.
 */
export interface CardSpendingPace {
  month: string;
  daysElapsed: number;
  daysInMonth: number;
  /** Posted spending dated this month through today, as the summary counts it: everyday spending and one-offs. */
  spentMinor: number;
  /** Everyday spending in it: without large one-offs, or the refunds set against them. */
  everydaySpentMinor: number;
  /** Large one-offs in it, less this month's refunds set against one-offs. Never projected. */
  oneOffsMinor: number;
  /** Pending charges this month through today: not counted. */
  pendingMinor: number;
  /** Whether the record of this month's days before today is complete for every card in view; null when not known. */
  monthSoFarComplete: boolean | null;
  /** The complete months the rest of the month comes from (newest last), and how many. */
  historyMonths: number;
  from: string | null;
  to: string | null;
  /**
   * Everyday spending in the rest of a month (the days after today's day, scaled to this month's days left): the median
   * over those months; null with fewer than `paceMinMonths`.
   */
  restMinor: number | null;
  /** The comparison: a typical month of everyday spending, the median over the same months; null with too few. */
  typicalMinor: number | null;
  /** The everyday pace: everydaySpentMinor + restMinor, an estimate; null with too few months. */
  everydayProjectedMinor: number | null;
  /** everydaySpentMinor + the rest's 80% range; null with fewer than `paceRangeMinMonths` (never untested). */
  everydayRange80: CardPaceRange | null;
  /** The month's total: everydayProjectedMinor + oneOffsMinor, an estimate; null with too few months. */
  projectedMinor: number | null;
  /** everydayRange80 + oneOffsMinor, with the same coverage. */
  projectedRange80: CardPaceRange | null;
}

export interface CardSpendingForecast {
  currency: string;
  today: string;
  /** The current month. */
  month: string;
  /** From the first month with spending (or the first complete one) through the current month, oldest first. */
  months: CardSpendingMonthBook[];
  /** The complete months fitted: the first and last, how many, the partial months between them, and their one-offs. */
  fit: {
    from: string;
    to: string;
    completeMonths: number;
    partialMonths: number;
    /** Large one-off purchases dated in the fitted months: how many, and what they came to. */
    oneOffPurchases: number;
    oneOffPurchasesMinor: number;
    /** Refunds dated in the fitted months set against one-offs (theirs or earlier ones'), in positive minor units. */
    oneOffRefundsMinor: number;
    /** oneOffPurchasesMinor - oneOffRefundsMinor: the fitted months' one-offs, as their books count them. */
    oneOffsMinor: number;
  } | null;
  /**
   * Purchases at or above this, not at a merchant that bills on a rhythm, are large one-offs: learned from the year of
   * complete months up to the last one (with none, the insights' floor).
   */
  oneOffThresholdMinor: number;
  /** The forecast months. */
  horizon: string[];
  /** All everyday spending: from its own series. Null without a complete month. */
  total: CardSeriesForecast | null;
  /** Each category with spending in a fitted month, largest typical month first. Not parts of `total`. */
  categories: CardSeriesForecast[];
  pace: CardSpendingPace;
}

export interface CardSpendingAnomaly {
  /** Null: all everyday spending. */
  category: string | null;
  /** The last complete month. A month in progress is never compared, whatever its record. */
  window: 'month';
  month: string;
  amountMinor: number;
  /** The median of the months compared with, and their robust standard deviation. */
  medianMinor: number;
  sigmaMinor: number;
  sigmaBasis: 'mad' | 'mean-absolute-deviation' | 'none';
  direction: 'high' | 'low';
  /** Robust standard deviations from the median, to two places; null when the months compared were all equal. */
  z: number | null;
  /** The months compared with. */
  historyMonths: number;
  from: string;
  to: string;
  thin: boolean;
}

/** What an anomaly check looked at, whether or not it found anything. */
export interface CardSpendingAnomalyCheck {
  /** The last complete month: a month in progress is never compared. */
  window: 'month';
  month: string;
  /** False: fewer than `anomalyMinMonths` complete months before it to compare with. */
  checked: boolean;
  historyMonths: number;
  from: string | null;
  to: string | null;
}

/** A recurring charge expected on a day: its usual amount, an estimate. */
export interface CardBill {
  date: string;
  /** Its merchant group (`matchesCardMerchantGroup`) and name. */
  key: string;
  merchant: string;
  cadence: RecurringCadence;
  /** Fixed (within 5%) or a bill that varies. */
  fixed: boolean;
  /** Its typical amount. */
  amountMinor: number;
  /** Expected before today and not in the record yet. */
  expectedBeforeToday: boolean;
  /**
   * Expected before today in a complete month, and not charged in it. Never for a month whose record is not complete
   * (this one included): a missing row there is no evidence of a missed bill.
   */
  late: boolean;
  /**
   * What shows it bills on a rhythm: the charges found in its series (rows of any month, complete or not), and the
   * months of the first and the last of them.
   */
  evidence: { occurrences: number; from: string; to: string };
  cardAccountIds: string[];
}

export interface CardBillsCalendar {
  /** Today through `billsDays` ahead. */
  from: string;
  to: string;
  /** By date, then merchant. */
  items: CardBill[];
  /** The sum of `items`. */
  totalMinor: number;
  count: number;
  /**
   * This month: the items due by its end (those expected before today included), at their usual amounts (an
   * estimate), and what the active recurring charges have already charged in it through today (their posted purchases).
   */
  thisMonth: { through: string; dueMinor: number; dueCount: number; chargedMinor: number; chargedCount: number };
  /** Active recurring charges found (cardInsights.ts). */
  activeCharges: number;
}

export interface CardSpendingPatterns {
  currency: string;
  today: string;
  month: string;
  anomalies: CardSpendingAnomaly[];
  checks: CardSpendingAnomalyCheck[];
  bills: CardBillsCalendar;
}

// ---------------------------------------------------------------------------
// Dates and money
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function checkToday(today: string): void {
  const date = new Date(`${today}T00:00:00Z`);
  if (!ISO_DATE.test(today) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== today) {
    throw new RangeError('today must be a valid YYYY-MM-DD date');
  }
}

function monthIndex(month: string): number {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

function monthOf(index: number): string {
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

function daysIn(month: string): number {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
}

function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

function dateOf(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

function scale(amount: number, currency: string): number {
  return Math.round(amount * 10 ** currencyExponent(currency));
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
/** Months listed at most, as the spending summary fills months. */
const MAX_LISTED_MONTHS = 1200;

// ---------------------------------------------------------------------------
// The months
// ---------------------------------------------------------------------------

/** A row's amount per category: its parts while they add up to it (a refund set against a one-off is read whole). */
function categoryAmounts(row: CardForecastRow, parts: CardSpendingForecastInput['categoryParts']): Array<[string, number]> {
  const own = row.id === undefined ? undefined : parts?.get(row.id);
  const whole = own && sum(own.map((part) => part.amountMinor)) === row.amountMinor ? own : null;
  return whole ? [...cardCategoryPartTotals(whole)] : [[effectiveCardCategory(row), row.amountMinor]];
}

const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;

/**
 * What the forecast and the patterns both read: rows by month, everyday spending by category, and the fitted months.
 *
 * Everything the one-off split learns comes from the complete months alone, as of their last day: the threshold (the
 * year of purchases up to it), the merchants that bill on a rhythm, and which refunds pay a one-off back. Two splits:
 * - `split`, of the complete months' rows only: their books, every fitted series and every baseline (forecast, pace
 *   history, anomalies) come from it, so a partial month's rows, or this month's, never change any of them;
 * - `currentSplit`, of the same rows and this month's, as of that same day: this month's rows come after it, so they
 *   move neither the threshold nor the recurring merchants; only this month's books are read from it (the pace, and
 *   this month so far against the same days before).
 * Both read the caller's order links, if any: a credit's link is decided from the household's links, so a complete
 * month's credit whose order was charged in a partial month, or on a card out of view, pays back no other one-off.
 * A partial month is never split. With no complete month nothing is learned: the threshold is the insights' floor.
 */
function readSpending(rows: readonly CardForecastRow[], input: CardSpendingForecastInput) {
  checkToday(input.today);
  const { currency, today } = input;
  const current = today.slice(0, 7);
  const inCurrency = rows.filter((row) => row.currency === currency && !cardSpendingExclusionOf(row, input.exclusions));
  const spent = inCurrency.filter((row) => row.status === 'posted' && cardSpendingRole(row.kind) === 'spending');
  const complete = new Set([...input.completeMonths].filter((month) => MONTH.test(month) && month < current));
  const ordered = [...complete].sort(byText);
  const lastComplete = ordered[ordered.length - 1];
  const learnedThrough = lastComplete === undefined
    ? dateOf(dayNumber(`${current}-01`) - 1)
    : `${lastComplete}-${String(daysIn(lastComplete)).padStart(2, '0')}`;
  const completeRows = rows.filter((row) => complete.has(row.transactionDate.slice(0, 7)));
  const learn = { currency, through: learnedThrough, exclusions: input.exclusions, orderLinks: input.orderLinks };
  const split = splitLargeCardPurchases(completeRows, learn);
  const currentSplit = splitLargeCardPurchases([...completeRows, ...rows.filter((row) => row.transactionDate.slice(0, 7) === current)], learn);
  /** Everyday spending of the complete months and of this one; none of a partial month. */
  const everyday = [...split.everyday, ...currentSplit.everyday.filter((row) => row.transactionDate.slice(0, 7) === current)];
  const spendingBy = new Map<string, number>();
  for (const row of spent) {
    const month = row.transactionDate.slice(0, 7);
    spendingBy.set(month, (spendingBy.get(month) ?? 0) + row.amountMinor);
  }
  const everydayBy = new Map<string, number>();
  const categoriesBy = new Map<string, Map<string, number>>();
  for (const row of everyday) {
    const month = row.transactionDate.slice(0, 7);
    everydayBy.set(month, (everydayBy.get(month) ?? 0) + row.amountMinor);
    const categories = categoriesBy.get(month) ?? new Map<string, number>();
    for (const [category, amountMinor] of categoryAmounts(row, input.categoryParts)) {
      categories.set(category, (categories.get(category) ?? 0) + amountMinor);
    }
    categoriesBy.set(month, categories);
  }

  // The complete months before this one, at most `fitMaxMonths` back, oldest first.
  const fitted = ordered.slice(-CARD_SPENDING_FORECAST.fitMaxMonths);
  const span = fitted.length === 0 ? [] : Array.from(
    { length: monthIndex(fitted[fitted.length - 1]) - monthIndex(fitted[0]) + 1 },
    (_, index) => monthOf(monthIndex(fitted[0]) + index),
  );
  const isFitted = new Set(fitted);
  const series = (value: (month: string) => number): SpendingSeries => span.map((month) => (isFitted.has(month) ? value(month) : null));
  const categoryNames = [...new Set(fitted.flatMap((month) => [...(categoriesBy.get(month)?.keys() ?? [])]))].sort(byText);
  const categorySeries = new Map(categoryNames.map((category) => [category, series((month) => categoriesBy.get(month)?.get(category) ?? 0)]));
  return { current, inCurrency, spent, complete, split, everyday, spendingBy, everydayBy, categoriesBy, fitted, span, series, categorySeries };
}
type Read = ReturnType<typeof readSpending>;

/**
 * The monthly series a forecast fits: everyday spending in all and per category over the fitted months (from the
 * first complete month to the last before today's), null for a partial month between them.
 */
export function readCardSpendingSeries(rows: readonly CardForecastRow[], input: CardSpendingForecastInput): {
  months: string[];
  total: SpendingSeries;
  categories: Map<string, SpendingSeries>;
} {
  const read = readSpending(rows, input);
  return { months: read.span, total: read.series((month) => read.everydayBy.get(month) ?? 0), categories: read.categorySeries };
}

/** Few complete months, or spending in fewer than half of them. */
function isThin(series: SpendingSeries): boolean {
  const known = knownValues(series);
  return known.length < CARD_SPENDING_FORECAST.thinMinMonths
    || known.filter((value) => value !== 0).length < CARD_SPENDING_FORECAST.thinActiveShare * known.length;
}

function recentMedian(series: SpendingSeries): number | null {
  const recent = knownValues(series).slice(-CARD_SPENDING_FORECAST.recentMonths);
  return recent.length === 0 ? null : Math.round(median(recent));
}

const round = (value: number) => Math.round(value) + 0;
const ratio = (value: number | null, places: number) => (value === null ? null : Math.round(value * 10 ** places) / 10 ** places);

function rangeView(range: TestedRange | null): CardForecastRange | null {
  return range ? { lowerMinor: round(range.lower), upperMinor: round(range.upper), basis: range.basis, coverage: { ...range.coverage } } : null;
}

function seriesView(category: string | null, series: SpendingSeries, result: SeriesForecast, read: Read, horizon: readonly string[]): CardSeriesForecast {
  const { backtest } = result;
  return {
    category,
    method: result.method,
    tested: result.tested,
    historyMonths: result.history,
    thin: isThin(series),
    recentMedianMinor: recentMedian(series),
    months: result.forecasts.map((item, index) => ({
      month: horizon[index],
      pointMinor: round(item.point),
      range80: rangeView(item.range80),
      range95: rangeView(item.range95),
    })),
    backtest: backtest === null ? null : {
      from: read.span[backtest.targetIndexes[0]],
      to: read.span[backtest.targetIndexes[backtest.targetIndexes.length - 1]],
      months: backtest.targets,
      origins: backtest.origins,
      forecasts: backtest.errors,
      maeMinor: round(backtest.mae),
      biasMinor: round(backtest.bias),
      mase: ratio(backtest.mase, 3),
      maseBenchmark: backtest.maseBenchmark,
      mape: ratio(backtest.mape, 1),
      mapeForecasts: backtest.mapeErrors,
      calibrationMonths: backtest.calibrationMonths,
      calibrationForecasts: backtest.calibrationErrors,
      coverage80: backtest.coverage80,
      coverage95: backtest.coverage95,
    },
    candidates: result.candidates.map((item) => ({ method: item.method, maeMinor: item.mae === null ? null : round(item.mae) })),
  };
}

// ---------------------------------------------------------------------------
// The forecast
// ---------------------------------------------------------------------------

function paceOf(read: Read, input: CardSpendingForecastInput): CardSpendingPace {
  const t = CARD_SPENDING_FORECAST;
  const { today } = input;
  const month = read.current;
  const day = Number(today.slice(8, 10));
  const length = daysIn(month);
  const soFar = (row: CardForecastRow) => row.transactionDate.slice(0, 7) === month && row.transactionDate <= today;
  const spentMinor = sum(read.spent.filter(soFar).map((row) => row.amountMinor));
  const everydaySpentMinor = sum(read.everyday.filter(soFar).map((row) => row.amountMinor));
  const oneOffsMinor = spentMinor - everydaySpentMinor;
  const pendingMinor = sum(read.inCurrency
    .filter((row) => row.status === 'pending' && cardSpendingRole(row.kind) === 'spending' && soFar(row))
    .map((row) => row.amountMinor));
  // The rest of each earlier complete month: its everyday spending after today's day of the month, scaled to the days
  // this month has left (a month with no days after it says nothing about them).
  const left = length - day;
  const rests: Array<{ month: string; restMinor: number }> = [];
  for (const earlier of read.fitted.slice(-t.paceMonths)) {
    const earlierLeft = daysIn(earlier) - day;
    if (left > 0 && earlierLeft <= 0) continue;
    const after = sum(read.everyday
      .filter((row) => row.transactionDate.slice(0, 7) === earlier && Number(row.transactionDate.slice(8, 10)) > day)
      .map((row) => row.amountMinor));
    rests.push({ month: earlier, restMinor: left === 0 ? 0 : (after * left) / earlierLeft });
  }
  const values = rests.map((item) => item.restMinor);
  const enough = rests.length >= t.paceMinMonths;
  const restMinor = enough ? round(median(values)) : null;
  // A range only with its coverage tested: each month's rest against the range the other months give.
  const range = rests.length >= t.paceRangeMinMonths ? empiricalRange(values, 80) : null;
  const coverage = range ? leaveOneOutCoverage(values, 80) : null;
  const everydayRange80 = range && coverage && coverage.tested > 0
    ? { lowerMinor: everydaySpentMinor + round(range.lower), upperMinor: everydaySpentMinor + round(range.upper), coverage }
    : null;
  const everydayProjectedMinor = restMinor === null ? null : everydaySpentMinor + restMinor;
  return {
    month,
    daysElapsed: day,
    daysInMonth: length,
    spentMinor,
    everydaySpentMinor,
    oneOffsMinor,
    pendingMinor,
    monthSoFarComplete: input.monthSoFarComplete ?? null,
    historyMonths: rests.length,
    from: rests[0]?.month ?? null,
    to: rests[rests.length - 1]?.month ?? null,
    restMinor,
    typicalMinor: enough ? round(median(rests.map((item) => read.everydayBy.get(item.month) ?? 0))) : null,
    everydayProjectedMinor,
    everydayRange80,
    projectedMinor: everydayProjectedMinor === null ? null : everydayProjectedMinor + oneOffsMinor,
    projectedRange80: everydayRange80 === null ? null : {
      lowerMinor: everydayRange80.lowerMinor + oneOffsMinor,
      upperMinor: everydayRange80.upperMinor + oneOffsMinor,
      coverage: { ...everydayRange80.coverage },
    },
  };
}

/**
 * The months, the next three months' everyday spending (all of it, and per category), and this month's pace, for
 * one currency. Rows may span any dates and statuses: posted rows count, like the summary; pending ones only in the
 * pace's `pendingMinor`.
 */
export function forecastCardSpending(rows: readonly CardForecastRow[], input: CardSpendingForecastInput): CardSpendingForecast {
  const read = readSpending(rows, input);
  const { current, fitted, span } = read;
  const firstSpent = [...read.spendingBy.keys()].filter((month) => month <= current).sort(byText)[0];
  const first = [firstSpent, fitted[0]].filter((month): month is string => month !== undefined).sort(byText)[0] ?? current;
  const months: CardSpendingMonthBook[] = [];
  for (let index = Math.max(monthIndex(first), monthIndex(current) - MAX_LISTED_MONTHS + 1); index <= monthIndex(current); index += 1) {
    const month = monthOf(index);
    const spendingMinor = read.spendingBy.get(month) ?? 0;
    const complete = read.complete.has(month);
    const inProgress = month === current;
    // A partial month is shown with its spending only: nothing learned from complete months splits it.
    const everydayMinor = complete || inProgress ? read.everydayBy.get(month) ?? 0 : null;
    months.push({
      month,
      spendingMinor,
      oneOffsMinor: everydayMinor === null ? null : spendingMinor - everydayMinor,
      everydayMinor,
      complete,
      inProgress,
    });
  }
  const horizon = Array.from({ length: CARD_SPENDING_FORECAST.horizonMonths }, (_, index) => monthOf(monthIndex(current) + index + 1));
  const pace = paceOf(read, input);
  const base = {
    currency: input.currency,
    today: input.today,
    month: current,
    months,
    oneOffThresholdMinor: read.split.thresholdMinor,
    horizon,
    pace,
  };
  if (fitted.length === 0) return { ...base, fit: null, total: null, categories: [] };
  const last = fitted[fitted.length - 1];
  const offsets = horizon.map((month) => monthIndex(month) - monthIndex(last));
  const nearZero = scale(CARD_SPENDING_FORECAST.mapeMinActual, input.currency);
  const forecastOf = (category: string | null, series: SpendingSeries) =>
    seriesView(category, series, forecastSpendingSeries(series, offsets, { nearZero }), read, horizon);
  const totalSeries = read.series((month) => read.everydayBy.get(month) ?? 0);
  const categories = [...read.categorySeries].map(([category, series]) => forecastOf(category, series))
    .sort((a, b) => (b.recentMedianMinor ?? 0) - (a.recentMedianMinor ?? 0)
      || sum(knownValues(read.categorySeries.get(b.category!)!)) - sum(knownValues(read.categorySeries.get(a.category!)!))
      || byText(a.category!, b.category!));
  const fittedMonths = new Set(fitted);
  const inFit = (row: { transactionDate: string }) => fittedMonths.has(row.transactionDate.slice(0, 7));
  const purchases = read.split.large.filter((item) => inFit(item.row));
  const oneOffPurchasesMinor = sum(purchases.map((item) => item.row.amountMinor));
  const oneOffRefundsMinor = sum(read.inCurrency.filter(inFit).map((row) => read.split.refundsSetAgainstLarge.get(row.id) ?? 0));
  return {
    ...base,
    fit: {
      from: fitted[0],
      to: last,
      completeMonths: fitted.length,
      partialMonths: span.length - fitted.length,
      oneOffPurchases: purchases.length,
      oneOffPurchasesMinor,
      oneOffRefundsMinor,
      oneOffsMinor: oneOffPurchasesMinor - oneOffRefundsMinor,
    },
    total: forecastOf(null, totalSeries),
    categories,
  };
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** Everyday spending per category (and, under null, in all) dated in `month`. */
function everydayIn(read: Read, month: string, parts: CardSpendingForecastInput['categoryParts']) {
  const totals = new Map<string | null, number>();
  for (const row of read.everyday) {
    if (row.transactionDate.slice(0, 7) !== month) continue;
    totals.set(null, (totals.get(null) ?? 0) + row.amountMinor);
    for (const [category, amountMinor] of categoryAmounts(row, parts)) totals.set(category, (totals.get(category) ?? 0) + amountMinor);
  }
  return totals;
}

/**
 * The last complete month against the complete months before it, all everyday spending and each category. A month in
 * progress is never compared: its record may still be missing rows, whatever is known of it.
 */
function anomalyCheck(read: Read, input: CardSpendingForecastInput): { check: CardSpendingAnomalyCheck; anomalies: CardSpendingAnomaly[] } | null {
  const t = CARD_SPENDING_FORECAST;
  const month = read.fitted[read.fitted.length - 1];
  if (month === undefined) return null;
  const history = read.fitted.filter((item) => item < month).slice(-t.anomalyMonths);
  const check: CardSpendingAnomalyCheck = {
    window: 'month',
    month,
    checked: history.length >= t.anomalyMinMonths,
    historyMonths: history.length,
    from: history[0] ?? null,
    to: history[history.length - 1] ?? null,
  };
  if (!check.checked) return { check, anomalies: [] };
  const now = everydayIn(read, month, input.categoryParts);
  const before = history.map((item) => everydayIn(read, item, input.categoryParts));
  const keys = [...new Set([...now.keys(), ...before.flatMap((totals) => [...totals.keys()])])];
  const anomalies: CardSpendingAnomaly[] = [];
  const minimum = scale(t.anomalyMin, input.currency);
  for (const key of keys) {
    const amountMinor = now.get(key) ?? 0;
    const spread = robustSpread(before.map((totals) => totals.get(key) ?? 0));
    const deviation = amountMinor - spread.median;
    if (Math.abs(deviation) <= t.anomalyZ * spread.sigma || Math.abs(deviation) < minimum) continue;
    const series = key === null ? read.series((item) => read.everydayBy.get(item) ?? 0) : read.categorySeries.get(key);
    anomalies.push({
      category: key,
      window: 'month',
      month,
      amountMinor,
      medianMinor: round(spread.median),
      sigmaMinor: round(spread.sigma),
      sigmaBasis: spread.basis,
      direction: deviation > 0 ? 'high' : 'low',
      z: spread.sigma > 0 ? ratio(deviation / spread.sigma, 2) : null,
      historyMonths: history.length,
      from: history[0],
      to: history[history.length - 1],
      thin: series === undefined ? true : isThin(series),
    });
  }
  return { check, anomalies };
}

/**
 * Recurring charges due from today through `billsDays` ahead, at their usual amounts, and this month's so far. Any
 * month's rows may show a charge bills on a rhythm, and its next date and amount; only a complete month's record can
 * show one is late.
 */
function billsOf(read: Read, input: CardSpendingForecastInput): CardBillsCalendar {
  const { today } = input;
  const end = dateOf(dayNumber(today) + CARD_SPENDING_FORECAST.billsDays);
  const monthStart = `${read.current}-01`;
  const monthEnd = `${read.current}-${String(daysIn(read.current)).padStart(2, '0')}`;
  const series = findRecurringCardSeries(read.inCurrency, today).filter((item) => item.charge.active);
  const active = series.map((item) => item.charge);
  const items: CardBill[] = [];
  for (const charge of active) {
    const step = dayNumber(charge.nextDate) - dayNumber(charge.lastDate);
    if (step <= 0) continue;
    for (let day = dayNumber(charge.nextDate); dateOf(day) <= end; day += step) {
      const date = dateOf(day);
      const expectedBeforeToday = date < today;
      // Only the next charge can be overdue: an active charge is never a whole cycle overdue.
      if (expectedBeforeToday && day !== dayNumber(charge.nextDate)) continue;
      items.push({
        date,
        key: charge.key,
        merchant: charge.merchant,
        cadence: charge.cadence,
        fixed: charge.fixed,
        amountMinor: charge.typicalMinor,
        expectedBeforeToday,
        late: expectedBeforeToday && read.complete.has(date.slice(0, 7)),
        evidence: { occurrences: charge.occurrences, from: charge.firstDate.slice(0, 7), to: charge.lastDate.slice(0, 7) },
        cardAccountIds: [...charge.cardAccountIds],
      });
    }
  }
  items.sort((a, b) => byText(a.date, b.date) || byText(a.merchant, b.merchant) || a.amountMinor - b.amountMinor || byText(a.key, b.key));
  const dueThisMonth = items.filter((item) => item.date <= monthEnd);
  // What the active recurring charges have charged this month so far: their own posted purchases.
  const byId = new Map(read.inCurrency.map((row) => [row.id, row]));
  const charged = series.flatMap((item) => item.rowIds.flatMap((id) => {
    const row = byId.get(id);
    return row && row.transactionDate >= monthStart && row.transactionDate <= today ? [row] : [];
  }));
  return {
    from: today,
    to: end,
    items,
    totalMinor: sum(items.map((item) => item.amountMinor)),
    count: items.length,
    thisMonth: {
      through: monthEnd,
      dueMinor: sum(dueThisMonth.map((item) => item.amountMinor)),
      dueCount: dueThisMonth.length,
      chargedMinor: sum(charged.map((row) => row.amountMinor)),
      chargedCount: charged.length,
    },
    activeCharges: active.length,
  };
}

/**
 * Unusual spending (the last complete month, both ways, all of it and per category, everyday spending only; a month
 * in progress is never compared), and the bills calendar.
 */
export function cardSpendingPatterns(rows: readonly CardForecastRow[], input: CardSpendingForecastInput): CardSpendingPatterns {
  const read = readSpending(rows, input);
  const result = anomalyCheck(read, input);
  const anomalies = (result?.anomalies ?? [])
    .sort((a, b) => Math.abs(b.amountMinor - b.medianMinor) - Math.abs(a.amountMinor - a.medianMinor) || byText(a.category ?? '', b.category ?? ''));
  return {
    currency: input.currency,
    today: input.today,
    month: read.current,
    anomalies,
    checks: result ? [result.check] : [],
    bills: billsOf(read, input),
  };
}
