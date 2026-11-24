/**
 * The words of Spending's patterns and forecast: one honest sentence per insight, built from the API's numbers
 * (`/spending/forecast`, `/spending/patterns`). Pure, so every sentence is linted without React (forecastText.test.ts):
 * each has a number and a time window, says "estimate" (with its range, when it has one) where it is one, never says
 * "will" or "always", and gives a thin category amounts, never percentages.
 *
 * Estimates are shown in whole units of the currency: cents on a forecast would claim a precision it does not have.
 * What was actually spent keeps its cents.
 *
 * The quantity forecast is posted spending without large one-off purchases (recurring bills included), the engine's
 * "everyday" series. It has one name on screen, `FORECAST_QUANTITY`: the overview's residual is a different quantity.
 */
import {
  CARD_SPENDING_FORECAST,
  CARD_SPENDING_STATS,
  cardMinorToMajor,
  type CardAccount,
  type CardBill,
  type CardBillsCalendar,
  type CardForecastMethod,
  type CardOwner,
  type CardSeriesForecast,
  type CardSpendingAnomaly,
  type CardSpendingForecast,
  type CardSpendingPace,
  type CardSpendingPatterns,
} from '@finance-tracker/shared';

import { OWNER_LABELS, cardOptionLabel, formatMinor, monthLabel, rankedCategoryLabels, shiftMonth, shortDate } from '../spendingFormat';

/** Every sentence the panel can say, by template. The lint test makes each of them at least once. */
export const FORECAST_TEMPLATES = [
  'pace-everyday-ranged', 'pace-everyday', 'pace-no-range', 'pace-spent-only', 'pace-coverage', 'pace-typical', 'pace-total-ranged', 'pace-total',
  'pace-one-offs', 'pace-pending', 'pace-record-incomplete',
  'forecast-ranged', 'forecast-no-range', 'forecast-untested', 'forecast-none', 'range95',
  'backtest-mase-mape', 'backtest-mase', 'backtest-mae', 'coverage',
  'method', 'method-untested', 'method-none',
  'fit-window', 'one-offs-left-out', 'one-offs-refunded', 'one-offs-none', 'partial-months',
  'anomaly-high', 'anomaly-low', 'anomaly-none', 'anomaly-wait', 'anomaly-this-month', 'anomaly-method',
  'bills-this-month', 'bills-this-month-charged-due', 'bills-this-month-charged', 'bills-this-month-none', 'bills-window', 'bills-none-active',
  'bills-method', 'bill-evidence', 'bill-late', 'bill-not-in-record',
] as const;
export type ForecastTemplate = (typeof FORECAST_TEMPLATES)[number];

export interface ForecastSentence {
  template: ForecastTemplate;
  text: string;
  /** An estimate: its words say so, with its range when it has one. */
  estimate: boolean;
  /** It gives an 80% (or 95%) range. */
  ranged: boolean;
  /** About a thin category: amounts only, never a percentage. */
  thin: boolean;
  /** A name it quotes (a category or merchant), as the data spells it. */
  subject?: string;
}

function sentence(template: ForecastTemplate, text: string, flags: Partial<Pick<ForecastSentence, 'estimate' | 'ranged' | 'thin' | 'subject'>> = {}): ForecastSentence {
  return { template, text, estimate: flags.estimate ?? false, ranged: flags.ranged ?? false, thin: flags.thin ?? false, ...(flags.subject ? { subject: flags.subject } : {}) };
}

/** An estimate's amount in whole units of its currency ("$3,410"). */
export function formatEstimate(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0 })
    .format(cardMinorToMajor(amountMinor, currency));
}

const counted = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** "July 2026", or "July 2026 to September 2026". */
export function monthSpan(from: string, to: string): string {
  return from === to ? monthLabel(from) : `${monthLabel(from)} to ${monthLabel(to)}`;
}

/** Short, distinct names for the categories an answer names (the category bars' own labels). */
export function forecastCategoryLabels(names: readonly string[]): Map<string, string> {
  return rankedCategoryLabels([...new Set(names)]);
}

/** The quantity forecast, in the panel's one name for it (D7): not the overview's "Other spending". */
export const FORECAST_QUANTITY = 'Spending without large one-offs';
const QUANTITY = 'spending without large one-offs';

/** Which filters of the tab the panel follows: it reads as of today for the person and card in view, nothing else. */
export const FORECAST_FILTERS_NOTE = 'Person and card apply; the period, search, category and merchant filters don\'t.';

/** Why the category rows are no parts of "All of it": said beside the table. */
export const FORECAST_ROWS_NOTE = 'Each row is its own estimate, so the categories don\'t add up to All of it.';

/** A limit, said beside the table whenever a row has no range yet: what one needs. */
export const FORECAST_NO_RANGE_NOTE = `“No range yet”: a range needs past estimates in ${CARD_SPENDING_STATS.rangeMinMonths} complete months to test it on.`;

/** The same, with its reason, for "How this was estimated". */
export const FORECAST_ROWS_METHOD = 'Each row is estimated on its own from its complete months: a typical month per category does not add up to a '
  + 'typical month overall, so the rows are not summed.';

/**
 * Owner-confirmed asset purchases are never spending anywhere in Holdr, so they are in none of the panel's figures
 * (estimates, amounts so far, the month total with its one-offs, bills, unusual months): a scope, said beside it.
 */
export const FORECAST_METALS_NOTE = 'Confirmed precious-metal purchases are excluded from every figure here, including the month total with one-offs.';

/**
 * While some months can't count, how many cards in view keep them from it, in one line beside the caveats; which cards
 * and why are folded ("per-card missing-history detail"). Neutral: a card first seen later may simply be newer, so this
 * never says its statements are missing. Null when no card does.
 */
export function gapSummaryText(gaps: {
  behind: ReadonlyArray<{ cardAccountId: string }>;
  startingLater: ReadonlyArray<{ cardAccountId: string }>;
}): string | null {
  const cards = new Set([...gaps.behind, ...gaps.startingLater].map((item) => item.cardAccountId)).size;
  if (cards === 0) return null;
  return `${cards === 1 ? '1 card in view keeps' : `${cards} cards in view keep`} some months from counting yet.`;
}

export const FORECAST_METHOD_LABELS: Record<CardForecastMethod, string> = {
  'median-run-rate': 'the median of recent complete months',
  'seasonal-naive': 'the same month a year before',
  'ets-damped': 'a smoothed level with a damped trend (ETS)',
  'holt-winters-damped': 'a smoothed level, damped trend and season (Holt-Winters)',
};

/**
 * Whose cards the panel's estimates are for, and as of when: "Estimates as of Oct 22, for Alex's cards." The API applies
 * the person and the card together, so a card of someone other than the chosen person says both.
 */
export function forecastScopeSentence(view: { today: string; owner?: CardOwner; cardAccountId?: string; card?: CardAccount | null }): string {
  const { owner, cardAccountId, card } = view;
  const person = owner ? OWNER_LABELS[owner] : null;
  let subject: string;
  if (cardAccountId) {
    const name = card ? cardOptionLabel(card) : 'the chosen card';
    subject = person && card?.owner !== owner ? `${name}, with Person set to ${person}` : name;
  } else if (owner === 'joint') {
    subject = 'joint cards';
  } else {
    subject = person ? `${person}'s cards` : 'everyone\'s cards';
  }
  return `Estimates as of ${shortDate(view.today)}, for ${subject}.`;
}

// ---------------------------------------------------------------------------
// This month's pace
// ---------------------------------------------------------------------------

/**
 * This month in words. First the pace, spending without large one-offs (an estimate); then how its range tested, a
 * typical month to compare it with, and the month's total with the one-offs already posted (counted once, not
 * projected). Without a range or an estimate, what it needs, in counts.
 */
export function paceSentences(pace: CardSpendingPace, today: string, currency: string): ForecastSentence[] {
  const month = monthLabel(pace.month);
  const through = shortDate(today);
  const spent = formatMinor(pace.spentMinor, currency);
  const everyday = formatMinor(pace.everydaySpentMinor, currency);
  const estimate = (minor: number) => formatEstimate(minor, currency);
  const history = counted(pace.historyMonths, 'complete month');
  const there = `there ${pace.historyMonths === 1 ? 'is' : 'are'} ${pace.historyMonths}`;
  // While some card's record of this month is short, what is in it so far is recorded, never all that was spent.
  const soFar = pace.monthSoFarComplete === false ? 'recorded' : 'spent';
  const list: ForecastSentence[] = [];
  const range = pace.everydayRange80;
  if (pace.everydayProjectedMinor !== null && range) {
    list.push(sentence('pace-everyday-ranged', `Estimate of ${QUANTITY} for all of ${month}: ${estimate(pace.everydayProjectedMinor)}, with an 80% range of `
      + `${estimate(range.lowerMinor)} to ${estimate(range.upperMinor)}, from ${everyday} ${soFar} through ${through} plus a typical rest of the month `
      + `from the last ${history}.`, { estimate: true, ranged: true }));
    list.push(sentence('pace-coverage', `Tested on those ${history}: the rest of the month fell inside the 80% range the other months gave `
      + `in ${range.coverage.inside} of ${range.coverage.tested}.`));
  } else if (pace.everydayProjectedMinor !== null) {
    list.push(sentence('pace-everyday', `Estimate of ${QUANTITY} for all of ${month}: ${estimate(pace.everydayProjectedMinor)}, from ${everyday} `
      + `${soFar} through ${through} plus a typical rest of the month from the last ${history}; a range needs `
      + `${CARD_SPENDING_FORECAST.paceRangeMinMonths} of them.`, { estimate: true }));
    list.push(sentence('pace-no-range', `An 80% range for ${month} needs ${CARD_SPENDING_FORECAST.paceRangeMinMonths} complete months of card data, `
      + `and ${there}.`));
  } else {
    list.push(sentence('pace-spent-only', `No estimate for all of ${month} yet: it needs ${CARD_SPENDING_FORECAST.paceMinMonths} complete months of card `
      + `data, and ${there}.`));
  }
  if (pace.typicalMinor !== null) {
    list.push(sentence('pace-typical', `A typical month of ${QUANTITY} was ${formatMinor(pace.typicalMinor, currency)} over the last ${history}, `
      + 'their median.'));
  }
  if (pace.projectedMinor !== null && pace.oneOffsMinor !== 0) {
    const oneOffs = pace.oneOffsMinor > 0
      ? `the ${formatMinor(pace.oneOffsMinor, currency)} of large one-offs already posted`
      : `the ${formatMinor(-pace.oneOffsMinor, currency)} refunded this month for large one-offs`;
    const total = pace.projectedRange80;
    list.push(total
      ? sentence('pace-total-ranged', `Estimate for all of ${month} with ${oneOffs}, counted once and not projected: ${estimate(pace.projectedMinor)}, `
        + `with an 80% range of ${estimate(total.lowerMinor)} to ${estimate(total.upperMinor)}.`, { estimate: true, ranged: true })
      : sentence('pace-total', `Estimate for all of ${month} with ${oneOffs}, counted once and not projected: ${estimate(pace.projectedMinor)}.`, { estimate: true }));
  } else if (pace.oneOffsMinor > 0) {
    list.push(sentence('pace-one-offs', `Large one-off purchases make up ${formatMinor(pace.oneOffsMinor, currency)} of the ${spent} ${soFar} in ${month} so far.`));
  }
  if (pace.pendingMinor > 0) {
    list.push(sentence('pace-pending', `Another ${formatMinor(pace.pendingMinor, currency)} is pending in ${month}, not counted until it posts.`));
  }
  if (pace.monthSoFarComplete === false) {
    // The amount the lead shows (spending without large one-offs in the record so far), and the estimate built on it.
    list.push(sentence('pace-record-incomplete', `Some cards' records for ${month} are not complete yet, so the ${everyday} recorded so far`
      + `${pace.everydayProjectedMinor !== null ? ', and the estimate built on it,' : ''} may be low.`));
  }
  return list;
}

// ---------------------------------------------------------------------------
// The next three months
// ---------------------------------------------------------------------------

/** The headline: all spending without large one-offs in the first forecast month, or why there is no forecast. */
export function forecastHeadline(forecast: CardSpendingForecast): ForecastSentence {
  const { total, currency } = forecast;
  const estimate = (minor: number) => formatEstimate(minor, currency);
  if (!total || total.method === null || total.months.length === 0) {
    const count = forecast.fit?.completeMonths ?? 0;
    return sentence('forecast-none', `No forecast yet: it needs ${CARD_SPENDING_STATS.runRateMinMonths} complete months of card data, and there `
      + `${count === 1 ? 'is' : 'are'} ${count} through ${monthLabel(shiftMonth(forecast.month, -1))}.`);
  }
  const [first] = total.months;
  const month = monthLabel(first.month);
  if (!total.tested) {
    return sentence('forecast-untested', `Estimate for ${month}: ${estimate(first.pointMinor)} of ${QUANTITY}, the median of the last `
      + `${counted(Math.min(total.historyMonths, CARD_SPENDING_STATS.runRateMonths), 'complete month')}, too few to test it or give a range.`, { estimate: true });
  }
  if (first.range80) {
    return sentence('forecast-ranged', `Estimate for ${month}: ${estimate(first.pointMinor)} of ${QUANTITY}, with an 80% range of `
      + `${estimate(first.range80.lowerMinor)} to ${estimate(first.range80.upperMinor)}.`, { estimate: true, ranged: true });
  }
  return sentence('forecast-no-range', `Estimate for ${month}: ${estimate(first.pointMinor)} of ${QUANTITY}; a range needs past estimates in `
    + `${CARD_SPENDING_STATS.rangeMinMonths} complete months to test it on, and there are ${total.backtest?.calibrationMonths ?? 0}.`, { estimate: true });
}

/**
 * A forecast month's 95% range in words, with what it is (its own ranks, or the 80% range widened) and how it tested;
 * null without one.
 */
export function range95Sentence(series: CardSeriesForecast, index: number, currency: string, label?: string): ForecastSentence | null {
  const item = series.months[index];
  const range = item?.range95;
  if (!range) return null;
  const estimate = (minor: number) => formatEstimate(minor, currency);
  const widened = range.basis === 'extended' ? ', widened from the 80% range (too few past estimates for its own)' : '';
  return sentence('range95', `Estimate for ${monthLabel(item.month)}: ${estimate(item.pointMinor)}, with a 95% range of ${estimate(range.lowerMinor)} `
    + `to ${estimate(range.upperMinor)}${widened}; ${range.coverage.inside} of ${range.coverage.tested} past estimates fell inside their 95% ranges.`,
  { estimate: true, ranged: true, thin: series.thin, ...(label ? { subject: label } : {}) });
}

/** How a forecast did when tested: its accuracy on the last fifth of its months, and how often its ranges held. */
export function backtestSentences(series: CardSeriesForecast, currency: string, label?: string): ForecastSentence[] {
  const { backtest } = series;
  if (!backtest) return [];
  const span = monthSpan(backtest.from, backtest.to);
  const mae = formatEstimate(backtest.maeMinor, currency);
  const flags = { thin: series.thin, ...(label ? { subject: label } : {}) };
  const benchmark = backtest.maseBenchmark === 'seasonal-naive' ? 'repeating the same month a year before' : 'repeating the month before';
  const list: ForecastSentence[] = [];
  if (backtest.mase === null) {
    list.push(sentence('backtest-mae', `Tested on ${span}: off by ${mae} a month on average.`, flags));
  } else if (backtest.mape === null || series.thin) {
    list.push(sentence('backtest-mase', `Tested on ${span}: off by ${mae} a month on average, a MASE of ${backtest.mase.toFixed(2)} `
      + `(under 1 beats ${benchmark}).`, flags));
  } else {
    list.push(sentence('backtest-mase-mape', `Tested on ${span}: off by ${mae} a month on average, a MASE of ${backtest.mase.toFixed(2)} `
      + `(under 1 beats ${benchmark}) and a MAPE of ${Math.round(backtest.mape)}%.`, flags));
  }
  if (backtest.coverage80.tested > 0) {
    list.push(sentence('coverage', `In the backtest, ${backtest.coverage80.inside} of ${backtest.coverage80.tested} past estimates fell inside `
      + `their 80% ranges, over ${counted(backtest.calibrationMonths, 'complete month')}.`, flags));
  }
  return list;
}

/**
 * How one row of the next three months is estimated, in one line for "How this was estimated": its method and what it
 * learned from, and, once tested, its average miss; or why it has no test or no estimate. `brief` leaves the test out,
 * for a row whose tests are said in full beside it.
 */
export function methodSentence(series: CardSeriesForecast, label: string, currency: string, options: { brief?: boolean } = {}): ForecastSentence {
  const flags = { thin: series.thin, subject: label };
  if (series.method === null || series.months.length === 0) {
    return sentence('method-none', `${label}: no estimate from ${counted(series.historyMonths, 'complete month')}; an estimate needs `
      + `${CARD_SPENDING_STATS.runRateMinMonths}.`, flags);
  }
  if (!series.tested) {
    return sentence('method-untested', `${label}: the median of its last `
      + `${counted(Math.min(series.historyMonths, CARD_SPENDING_STATS.runRateMonths), 'complete month')}, too few to test it.`, flags);
  }
  const tested = series.backtest && !options.brief
    ? `, tested on ${monthSpan(series.backtest.from, series.backtest.to)} and off by ${formatEstimate(series.backtest.maeMinor, currency)} a month on average`
    : '';
  const noRange = series.months[0].range80 === null && !options.brief
    ? `; no range until its past estimates cover ${CARD_SPENDING_STATS.rangeMinMonths} complete months (now ${series.backtest?.calibrationMonths ?? 0})`
    : '';
  return sentence('method', `${label}: ${FORECAST_METHOD_LABELS[series.method]}, learned from ${counted(series.historyMonths, 'complete month')}`
    + `${tested}${noRange}.`, flags);
}

/** What the estimates learn from, what they leave out, and which months they could not use. */
export function forecastNotes(forecast: CardSpendingForecast): ForecastSentence[] {
  const { currency, fit } = forecast;
  const notes: ForecastSentence[] = [];
  if (fit) {
    notes.push(sentence('fit-window', `Estimates are fitted on ${counted(fit.completeMonths, 'complete month')}, ${monthSpan(fit.from, fit.to)}, `
      + `each with every card's record in full.`));
    const threshold = formatMinor(forecast.oneOffThresholdMinor, currency);
    const months = counted(fit.completeMonths, 'complete month');
    const purchases = counted(fit.oneOffPurchases, 'purchase');
    const gross = formatMinor(fit.oneOffPurchasesMinor, currency);
    if (fit.oneOffRefundsMinor > 0) {
      // Refunded in part or in full: never "none", whatever they net to.
      const refunded = formatMinor(fit.oneOffRefundsMinor, currency);
      notes.push(sentence('one-offs-refunded', fit.oneOffPurchases > 0
        ? `Estimates leave out large one-off purchases of ${threshold} or more: ${purchases} for ${gross} in the ${months} fitted, and ${refunded} refunded for one-offs.`
        : `Estimates leave out large one-off purchases of ${threshold} or more: none in the ${months} fitted, and ${refunded} refunded for earlier ones.`));
    } else if (fit.oneOffPurchases > 0) {
      notes.push(sentence('one-offs-left-out', `Estimates leave out large one-off purchases of ${threshold} or more: ${purchases} for ${gross} in the ${months} fitted.`));
    } else {
      notes.push(sentence('one-offs-none', `Estimates leave out large one-off purchases of ${threshold} or more, and there were none in the ${months} fitted.`));
    }
  }
  const past = forecast.months.filter((book) => !book.inProgress);
  const partial = past.filter((book) => !book.complete);
  if (partial.length > 0 && past.length > 0) {
    notes.push(sentence('partial-months', `${partial.length} of the ${past.length} months from ${monthSpan(past[0].month, past[past.length - 1].month)} `
      + `had partial card data and ${partial.length === 1 ? 'is' : 'are'} not used.`));
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Unusual spending
// ---------------------------------------------------------------------------

export function anomalySentence(anomaly: CardSpendingAnomaly, label: string, currency: string): ForecastSentence {
  const amount = formatMinor(anomaly.amountMinor, currency);
  const median = formatMinor(anomaly.medianMinor, currency);
  const month = monthLabel(anomaly.month);
  const before = `${counted(anomaly.historyMonths, 'complete month')} before`;
  const flags = { thin: anomaly.thin, ...(anomaly.category === null ? {} : { subject: label }) };
  return sentence(anomaly.direction === 'high' ? 'anomaly-high' : 'anomaly-low', `${label}: ${amount} in ${month}, `
    + `${anomaly.direction === 'high' ? 'above' : 'below'} its median of ${median} over the ${before}.`, flags);
}

/**
 * The anomalies in words, or what was checked when nothing stood out, or why nothing could be checked; then that the
 * month in progress is compared only once it is over.
 */
export function anomalySentences(patterns: CardSpendingPatterns, labels: ReadonlyMap<string, string>): ForecastSentence[] {
  const labelOf = (category: string | null) => (category === null ? FORECAST_QUANTITY : labels.get(category) ?? category);
  const thisMonth = sentence('anomaly-this-month', `${monthLabel(patterns.month)} is compared with earlier months only once it is over `
    + 'and every card\'s record of it is complete.');
  if (patterns.anomalies.length > 0) {
    return [...patterns.anomalies.map((item) => anomalySentence(item, labelOf(item.category), patterns.currency)), thisMonth];
  }
  const checked = patterns.checks.find((check) => check.checked);
  if (checked) {
    return [sentence('anomaly-none', `Nothing unusual in ${monthLabel(checked.month)}, against ${counted(checked.historyMonths, 'complete month')} before.`), thisMonth];
  }
  const check = patterns.checks[0];
  const month = monthLabel(check?.month ?? patterns.month);
  const count = check?.historyMonths ?? 0;
  return [sentence('anomaly-wait', `Unusual spending needs ${CARD_SPENDING_FORECAST.anomalyMinMonths} complete months to compare with, `
    + `and there ${count === 1 ? 'is' : 'are'} ${count} before ${month}.`), thisMonth];
}

/** An amount given in whole major units of the currency ("$50"), as the engine's thresholds are. */
function formatMajor(amount: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(amount);
}

/** What makes a month unusual, in the engine's own thresholds, for "How this was estimated". */
export function anomalyMethodSentence(currency: string): ForecastSentence {
  const { anomalyZ, anomalyMin, anomalyMonths, anomalyMinMonths } = CARD_SPENDING_FORECAST;
  return sentence('anomaly-method', `A complete month is unusual when it is more than ${anomalyZ} robust standard deviations, and at least `
    + `${formatMajor(anomalyMin, currency)}, from the median of up to ${anomalyMonths} complete months before it, with at least ${anomalyMinMonths} of them.`);
}

// ---------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------

/** How the bills calendar is made, for "How this was estimated". */
export function billsMethodSentence(): ForecastSentence {
  return sentence('bills-method', 'A charge is a recurring bill once its payments repeat on a regular rhythm; the calendar shows those due in the '
    + `next ${CARD_SPENDING_FORECAST.billsDays} days, each at its usual amount.`);
}

/**
 * What shows a bill is one: the charges found and the months they span; and, for one expected before today, whether
 * its month's record is complete (only then is it late) or not (then it is not in the record yet, nothing more).
 */
export function billSentence(bill: CardBill): ForecastSentence {
  const seen = `Seen ${counted(bill.evidence.occurrences, 'time')}, ${monthSpan(bill.evidence.from, bill.evidence.to)}`;
  const expected = shortDate(bill.date);
  if (bill.late) {
    return sentence('bill-late', `${seen}; expected ${expected} and not in ${monthLabel(bill.date.slice(0, 7))}'s record, which is complete.`);
  }
  if (bill.expectedBeforeToday) {
    return sentence('bill-not-in-record', `${seen}; expected ${expected}, and not in the record yet.`);
  }
  return sentence('bill-evidence', `${seen}.`);
}

export function billsSentences(bills: CardBillsCalendar, month: string, currency: string): ForecastSentence[] {
  const estimate = (minor: number) => formatEstimate(minor, currency);
  const usual = (count: number) => (count === 1 ? 'at its usual amount' : 'at their usual amounts');
  if (bills.activeCharges === 0) {
    return [sentence('bills-none-active', `No recurring charges are active as of ${shortDate(bills.from)}: a charge needs 3 payments on a regular rhythm.`)];
  }
  const { dueMinor, dueCount, chargedMinor, chargedCount } = bills.thisMonth;
  const name = monthLabel(month);
  const charged = formatMinor(chargedMinor, currency);
  const list: ForecastSentence[] = [];
  if (chargedCount > 0 && dueCount > 0) {
    list.push(sentence('bills-this-month-charged-due', `Recurring bills in ${name}: ${charged} charged so far, and an estimate of `
      + `${estimate(dueMinor)} still due from ${counted(dueCount, 'charge')} ${usual(dueCount)}.`, { estimate: true }));
  } else if (chargedCount > 0) {
    list.push(sentence('bills-this-month-charged', `Recurring bills in ${name}: ${charged} charged so far from ${counted(chargedCount, 'charge')}, `
      + 'and none due again this month.'));
  } else if (dueCount > 0) {
    list.push(sentence('bills-this-month', `Estimate: ${estimate(dueMinor)} in recurring bills still due in ${name}, `
      + `${counted(dueCount, 'charge')} ${usual(dueCount)}.`, { estimate: true }));
  } else {
    list.push(sentence('bills-this-month-none', bills.activeCharges === 1
      ? `The 1 active recurring charge is not due again in the rest of ${name}.`
      : `None of the ${bills.activeCharges} active recurring charges is due again in the rest of ${name}.`));
  }
  if (bills.count > 0) {
    list.push(sentence('bills-window', `Estimate: ${estimate(bills.totalMinor)} in recurring bills from ${shortDate(bills.from)} to `
      + `${shortDate(bills.to)}, ${counted(bills.count, 'charge')} ${usual(bills.count)}.`, { estimate: true }));
  }
  return list;
}
