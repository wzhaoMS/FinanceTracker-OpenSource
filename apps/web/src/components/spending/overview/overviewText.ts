/**
 * The overview's words and windows, pure so they can be tested and linted: which dates a period compares with, and
 * one honest sentence per comparison, with a number and a time window. Two windows are compared ("$1,203.00 less than
 * September at this point") only when both are complete: over, every card expected in them recorded for each of their
 * days, no card in view first seen later, and data from as many cards in each. Otherwise neither is called more or
 * less, not even "at least" (a missing refund can lower a window as a missing charge can raise it): both figures are
 * shown side by side, with a note on each window that may be incomplete. No percentages, no "will" or "always".
 */
import type { CardSpendingDriver } from '@finance-tracker/shared';

import { openedText } from '../openings/openingsText';
import {
  addDays,
  addMonths,
  formatMinor,
  longDate,
  monthBounds,
  monthLabel,
  shiftMonth,
  shortDate,
  type SpendingPeriod,
  type SpendingPeriodRange,
} from '../spendingFormat';

/** One comparison the overview makes: its own period and its baseline, and how a sentence names the baseline. */
export interface OverviewComparisonWindow {
  key: 'previous' | 'year';
  from: string;
  to: string;
  baselineFrom: string;
  baselineTo: string;
  /** In a sentence: "September at this point", "October 2025", "the 90 days before". */
  baselineName: string;
  /** On its tab: "vs September", "vs October 2025". */
  label: string;
}

export interface OverviewPeriod {
  from: string;
  to: string;
  /** In a sentence: "October so far", "September 2026", "the last 90 days". */
  name: string;
  /** The period reaches today: its own figures are still growing. */
  inProgress: boolean;
  comparisons: OverviewComparisonWindow[];
  /** The months chart ends here. */
  toMonth: string;
}

const MONTH_NAME = (month: string) => monthLabel(month).replace(/ \d{4}$/, '');

/** A month's name, with its year when it is not `year`. */
function monthName(month: string, year: string): string {
  return month.slice(0, 4) === year ? MONTH_NAME(month) : monthLabel(month);
}

/** A month's first days, through `day` (or its last day when it is shorter). */
function monthTo(month: string, day: number): { from: string; to: string } {
  const bounds = monthBounds(month);
  return { from: bounds.from, to: `${month}-${String(Math.min(day, Number(bounds.to.slice(8, 10)))).padStart(2, '0')}` };
}

/**
 * The overview's period for the Spending tab's choice, and what it is compared with: a month with the month before and
 * the same month last year (to this day while it is the current month); 60 or 90 days with the days just before and
 * the same days last year; 6 months with the 6 before and the same 6 last year; 12 months with the 12 before; the
 * year to date with last year to the same date. A baseline always ends before its period starts.
 */
export function overviewPeriod(period: SpendingPeriod, range: SpendingPeriodRange, month: string, today: string): OverviewPeriod {
  const thisYear = today.slice(0, 4);
  if (period === 'month') {
    const current = month === today.slice(0, 7);
    const previous = shiftMonth(month, -1);
    const lastYear = shiftMonth(month, -12);
    if (current) {
      const day = Number(today.slice(8, 10));
      const before = monthTo(previous, day);
      const yearAgo = monthTo(lastYear, day);
      return {
        from: `${month}-01`,
        to: today,
        name: `${monthName(month, thisYear)} so far`,
        inProgress: true,
        toMonth: month,
        comparisons: [
          { key: 'previous', from: `${month}-01`, to: today, baselineFrom: before.from, baselineTo: before.to,
            baselineName: `${monthName(previous, thisYear)} at this point`, label: `vs ${monthName(previous, thisYear)}` },
          { key: 'year', from: `${month}-01`, to: today, baselineFrom: yearAgo.from, baselineTo: yearAgo.to,
            baselineName: `${monthLabel(lastYear)} at this point`, label: `vs ${monthLabel(lastYear)}` },
        ],
      };
    }
    const bounds = monthBounds(month);
    const year = month.slice(0, 4);
    return {
      ...bounds,
      name: monthLabel(month),
      inProgress: bounds.to >= today,
      toMonth: month,
      comparisons: [
        { key: 'previous', ...bounds, baselineFrom: monthBounds(previous).from, baselineTo: monthBounds(previous).to,
          baselineName: monthName(previous, year), label: `vs ${monthName(previous, year)}` },
        { key: 'year', ...bounds, baselineFrom: monthBounds(lastYear).from, baselineTo: monthBounds(lastYear).to,
          baselineName: monthLabel(lastYear), label: `vs ${monthLabel(lastYear)}` },
      ],
    };
  }
  const own = { from: range.from, to: range.to };
  const base = { name: range.phrase, inProgress: range.to >= today, toMonth: today.slice(0, 7), ...own };
  const yearAgo = { baselineFrom: addMonths(range.from, -12), baselineTo: addMonths(range.to, -12) };
  if (period === 'last60' || period === 'last90') {
    const days = period === 'last60' ? 60 : 90;
    return {
      ...base,
      comparisons: [
        { key: 'previous', ...own, baselineFrom: range.previous!.from, baselineTo: range.previous!.to,
          baselineName: `the ${days} days before`, label: `vs the ${days} days before` },
        { key: 'year', ...own, ...yearAgo, baselineName: `the same ${days} days last year`, label: 'vs a year earlier' },
      ],
    };
  }
  if (period === 'last6m') {
    return {
      ...base,
      comparisons: [
        { key: 'previous', ...own, baselineFrom: addMonths(range.from, -6), baselineTo: addDays(range.from, -1),
          baselineName: 'the 6 months before', label: 'vs the 6 months before' },
        { key: 'year', ...own, ...yearAgo, baselineName: 'the same 6 months last year', label: 'vs a year earlier' },
      ],
    };
  }
  if (period === 'last12m') {
    return {
      ...base,
      comparisons: [{ key: 'year', ...own, baselineFrom: range.previous!.from, baselineTo: range.previous!.to,
        baselineName: 'the 12 months before', label: 'vs the 12 months before' }],
    };
  }
  // The year to date.
  const lastYear = String(Number(thisYear) - 1);
  return {
    ...base,
    comparisons: [{ key: 'year', ...own, baselineFrom: range.previous!.from, baselineTo: range.previous!.to,
      baselineName: `${lastYear} to the same date`, label: `vs ${lastYear} to date` }],
  };
}

/** What a comparison reads of each window: its last day, its spending and what is known of its card record. */
export interface SentenceWindow {
  to: string;
  spendingMinor: number;
  count: number;
  coverage: { cardsWithData: number; cardsExpected: number; cardsCovered: number; cardsStartingLater: number; inProgress: boolean };
}

/** Why two windows are not compared, about one of them or about both. */
export interface ComparisonNote {
  /** `current`: the period's own window, the same in each of its comparisons. */
  about: 'current' | 'baseline' | 'both';
  text: string;
}

export interface ComparisonSentence {
  /** Compared: one sentence ("$1,203.00 less than September at this point"). Not compared: both figures, side by side. */
  text: string;
  /** Beside the period's own total: the sentence, or, not compared, the baseline's figure alone. */
  beside: string;
  /** `none`: not compared, so neither more nor less. */
  tone: 'more' | 'less' | 'same' | 'none';
  /** Not compared: each window that may be incomplete and why, and how many cards each has data from when they differ. */
  notes: ComparisonNote[];
  /** Compared: only then is the change split by category. */
  bothKnown: boolean;
}

const money = (minor: number, currency: string) => formatMinor(Math.abs(minor), currency);
const cardsText = (count: number) => `${count} ${count === 1 ? 'card' : 'cards'}`;

/** Why a window may be incomplete, in a few words each; none when it is complete. */
function incompleteReasons(window: SentenceWindow): string[] {
  const { coverage } = window;
  const reasons: string[] = [];
  if (coverage.inProgress) reasons.push(`still going through ${shortDate(window.to)}, and recent charges may not have posted yet`);
  if (coverage.cardsStartingLater > 0) {
    reasons.push(`${cardsText(coverage.cardsStartingLater)} in view ${coverage.cardsStartingLater === 1 ? 'has' : 'have'} no data that early`);
  }
  const uncovered = coverage.cardsExpected - coverage.cardsCovered;
  if (uncovered > 0) reasons.push(`${uncovered} of ${cardsText(coverage.cardsExpected)} ${uncovered === 1 ? 'has' : 'have'} no recorded dates for all of it`);
  if (coverage.cardsExpected === 0 && coverage.cardsStartingLater === 0) reasons.push(`${cardsText(0)} in view had data then`);
  return reasons;
}

/** Over, every card expected in it recorded for each of its days, and no card in view first seen later. */
export function windowKnown(window: SentenceWindow): boolean {
  return incompleteReasons(window).length === 0;
}

/** Why a window may be incomplete, each in a few words ("still going through Sep 20, …"); none when it is complete. */
export function windowReasons(window: SentenceWindow): string[] {
  return incompleteReasons(window);
}

/** A window that may be incomplete, said in a line ("September so far may be incomplete"), why apart (windowReasons). */
export function windowShortNote(window: SentenceWindow, name: string): string | null {
  return windowKnown(window) ? null : `${capitalize(name)} may be incomplete`;
}

/** A window's note when it may be incomplete ("September so far may be incomplete (still going through Sep 20, …)"); null when complete. */
export function windowNote(window: SentenceWindow, name: string): string | null {
  const reasons = incompleteReasons(window);
  return reasons.length === 0 ? null : `${capitalize(name)} may be incomplete (${reasons.join('; ')})`;
}

/**
 * One Apple-style sentence for a comparison ("$1,203.00 less than September at this point"), made only when both
 * windows are complete and have data from as many cards each. Otherwise no claim of more or less is made, bounded or
 * not: a window still going may not have its latest charges posted, and a window not recorded for every day may be
 * missing charges or refunds. Both figures are then shown side by side, with a note on each window that may be
 * incomplete, and the change is not split by category.
 */
export function comparisonSentence(
  current: SentenceWindow,
  baseline: SentenceWindow,
  options: { currency: string; periodName: string; baselineName: string },
): ComparisonSentence {
  const { currency, periodName, baselineName } = options;
  const notes: ComparisonNote[] = [];
  const nowNote = windowNote(current, periodName);
  if (nowNote) notes.push({ about: 'current', text: nowNote });
  const beforeNote = windowNote(baseline, baselineName);
  if (beforeNote) notes.push({ about: 'baseline', text: beforeNote });
  const now = current.coverage.cardsWithData;
  const before = baseline.coverage.cardsWithData;
  if (now !== before) {
    notes.push({
      about: 'both',
      text: now < before
        ? `${capitalize(periodName)} has data from ${cardsText(now)}; ${baselineName} from ${before}`
        : `${capitalize(baselineName)} has data from ${cardsText(before)}; ${periodName} from ${now}`,
    });
  }
  if (notes.length > 0) {
    const figure = (minor: number) => formatMinor(minor, currency);
    return {
      text: `${capitalize(periodName)}: ${figure(current.spendingMinor)}; ${baselineName}: ${figure(baseline.spendingMinor)}`,
      beside: `${capitalize(baselineName)}: ${figure(baseline.spendingMinor)}`,
      tone: 'none',
      notes,
      bothKnown: false,
    };
  }
  const delta = current.spendingMinor - baseline.spendingMinor;
  const text = delta === 0
    ? `The same as ${baselineName}: ${money(0, currency)} difference`
    : `${money(delta, currency)} ${delta < 0 ? 'less' : 'more'} than ${baselineName}`;
  return { text, beside: text, tone: delta === 0 ? 'same' : delta < 0 ? 'less' : 'more', notes, bothKnown: true };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "+$420" or "−$420"; "$0" for nothing. */
export function signedMoney(minor: number, currency: string): string {
  if (minor === 0) return formatMinor(0, currency);
  return `${minor < 0 ? '−' : '+'}${formatMinor(Math.abs(minor), currency)}`;
}

/** "1 charge", "1,204 charges". */
export function chargesText(count: number): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'charge' : 'charges'}`;
}

/** "1 other merchant", "92 other merchants": the row holding the merchants not named above it. */
export function otherMerchantsText(count: number): string {
  return `${count.toLocaleString('en-US')} other ${count === 1 ? 'merchant' : 'merchants'}`;
}

/** A row's net amount: "Net $0.00" when its charges and credits cancel out (activity, not an empty row), else the amount. */
export function netText(amountMinor: number, count: number, currency: string): string {
  return amountMinor === 0 && count > 0 ? `Net ${formatMinor(0, currency)}` : formatMinor(amountMinor, currency);
}

/** "$420 more than September", "$80 less than September", "the same as September". */
export function changeText(minor: number, currency: string, baselineName: string): string {
  if (minor === 0) return `the same as ${baselineName} (${formatMinor(0, currency)} difference)`;
  return `${money(minor, currency)} ${minor > 0 ? 'more' : 'less'} than ${baselineName}`;
}

/** A driver as one sentence: "Groceries: $420 more than September, mostly Sample Grocer ($310 more)". */
export function driverSentence(
  driver: Pick<CardSpendingDriver, 'category' | 'deltaMinor' | 'merchants'>,
  options: { currency: string; baselineName: string; merchantName: (key: string, name: string) => string },
): string {
  const lead = driver.merchants[0];
  const behind = lead && Math.sign(lead.deltaMinor) === Math.sign(driver.deltaMinor)
    ? `, mostly ${options.merchantName(lead.key, lead.name)}${lead.itemized ? ' items' : ''} (${money(lead.deltaMinor, options.currency)} ${lead.deltaMinor > 0 ? 'more' : 'less'})`
    : '';
  return `${driver.category}: ${changeText(driver.deltaMinor, options.currency, options.baselineName)}${behind}`;
}

/** The one-offs' line of a comparison. */
export function oneOffsSentence(currentMinor: number, baselineMinor: number, options: { currency: string; periodName: string; baselineName: string }): string {
  return `Large one-offs: ${formatMinor(currentMinor, options.currency)} in ${options.periodName}, ${formatMinor(baselineMinor, options.currency)} in ${options.baselineName}`;
}

/** Everything else: the change no driver names. */
export function remainderSentence(minor: number, categories: number, options: { currency: string; baselineName: string }): string {
  const across = categories > 0 ? `, across ${categories} other ${categories === 1 ? 'category' : 'categories'}` : '';
  return `Everything else: ${changeText(minor, options.currency, options.baselineName)}${across}`;
}

/** A month's state, said on it beside its bar (never by hatching alone): still going, or possibly missing spending. */
export function monthStateText(coverage: { complete: boolean; inProgress: boolean; cardsExpected: number; cardsStartingLater: number }):
  'Month in progress' | 'Incomplete' | null {
  if (coverage.inProgress) return 'Month in progress';
  // A card expected in it has no recorded dates for all of it, or a card in view has no data this early.
  if (!coverage.complete && (coverage.cardsExpected > 0 || coverage.cardsStartingLater > 0)) return 'Incomplete';
  return null;
}

/**
 * A month of the chart, in words: its amount and month first ("$1,200.00 in November 2025", what a test or a reader
 * finds it by), then its state when it has one, its parts, and how much of its card record is known.
 */
export function trendMonthSentence(
  month: { month: string; spendingMinor: number; recurringMinor: number; oneOffMinor: number; everydayMinor: number;
    coverage: { complete: boolean; inProgress: boolean; cardsWithData: number; cardsExpected: number; cardsCovered: number; cardsStartingLater: number;
      openedCardIds?: readonly string[] } },
  currency: string,
): string {
  const m = (minor: number) => formatMinor(minor, currency);
  const { coverage } = month;
  const cards = (count: number) => `${count} ${count === 1 ? 'card' : 'cards'}`;
  let known: string;
  if (coverage.inProgress) {
    known = 'still going, and recent charges may not have posted yet, so it is not lower spending';
  } else if (coverage.complete) {
    // Complete only because a card opened in it (its owner-confirmed opening month): said so.
    const opened = coverage.openedCardIds?.length ?? 0;
    known = `every card's dates recorded (${cards(coverage.cardsExpected)})${opened > 0 ? `; ${openedText(opened)}` : ''}`;
  } else {
    const reasons: string[] = [];
    if (coverage.cardsCovered < coverage.cardsExpected) reasons.push(`${coverage.cardsCovered} of ${coverage.cardsExpected} cards with recorded dates`);
    if (coverage.cardsStartingLater > 0) {
      reasons.push(`${cards(coverage.cardsStartingLater)} in view ${coverage.cardsStartingLater === 1 ? 'has' : 'have'} no data this early`);
    }
    known = reasons.length === 0
      ? 'no card data for this month'
      : `partial: ${reasons.join('; ')}, so this month may be missing spending; it is not lower spending`;
  }
  const state = monthStateText(coverage);
  return `${m(month.spendingMinor)} in ${monthLabel(month.month)}${state ? ` (${state.toLowerCase()})` : ''}: recurring ${m(month.recurringMinor)}, `
    + `large one-offs ${m(month.oneOffMinor)}, other spending ${m(month.everydayMinor)}; data from ${coverage.cardsWithData} of ${coverage.cardsExpected} cards; ${known}`;
}

/**
 * A month by person, in words, as the chart names it By person: its amount and month first, as By type ("$1,200.00 in
 * November 2025"), its state, then each person's spending, from the summary's own split.
 */
export function personMonthSentence(month: string, totalMinor: number, people: ReadonlyArray<{ name: string; amountMinor: number }>,
  state: string | null, currency: string): string {
  const m = (minor: number) => formatMinor(minor, currency);
  return `${m(totalMinor)} in ${monthLabel(month)}${state ? ` (${state.toLowerCase()})` : ''}: ${people.map((person) => `${person.name} ${m(person.amountMinor)}`).join(', ')}`;
}

/** How many cards keep months from counting: those behind, and those first seen after the first month shown. */
export function missingHistoryCards(gaps: {
  behind: ReadonlyArray<{ cardAccountId: string }>;
  startingLater: ReadonlyArray<{ cardAccountId: string }>;
}): number {
  return new Set([...gaps.behind, ...gaps.startingLater].map((item) => item.cardAccountId)).size;
}

/** "Missing history (1 card)", "Missing history (6 cards)": the fold's label, the limit still said while folded. */
export function missingHistoryLabel(cards: number): string {
  return `Missing history (${cards} ${cards === 1 ? 'card' : 'cards'})`;
}

/** "A", "A and B", "A, B and C". */
function listText(items: readonly string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The months' states in one line, for a screen too narrow to say them on each month ("Incomplete: Oct–Mar and Jun ·
 * Month in progress: Sep"); consecutive months run together. Null when no month has a state.
 */
export function monthStatesLine(months: ReadonlyArray<{ month: string; coverage: Parameters<typeof monthStateText>[0] }>,
  label: (month: string) => string): string | null {
  const runsOf = (state: 'Incomplete' | 'Month in progress') => {
    const runs: string[][] = [];
    let open = false;
    for (const item of months) {
      if (monthStateText(item.coverage) !== state) {
        open = false;
        continue;
      }
      if (open) runs[runs.length - 1].push(item.month);
      else runs.push([item.month]);
      open = true;
    }
    return runs.map((run) => (run.length === 1 ? label(run[0]) : `${label(run[0])}–${label(run[run.length - 1])}`));
  };
  const parts = (['Incomplete', 'Month in progress'] as const)
    .map((state) => [state, runsOf(state)] as const)
    .filter(([, runs]) => runs.length > 0)
    .map(([state, runs]) => `${state}: ${listText(runs)}`);
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * Why the hatched months can't count, card by card, and what would let them (the API's `gaps`): the open cards with no
 * statements imported, or none after a day, by the names the app shows them by; how many cards were first seen after
 * the first month shown; and the fixes. Card names stay in the page: the API sends ids and dates only.
 */
export function coverageGapSentences(
  gaps: {
    behind: ReadonlyArray<{ cardAccountId: string; coveredThrough: string | null }>;
    startingLater: ReadonlyArray<{ cardAccountId: string; firstKnown: string }>;
  },
  options: { cardName: (id: string) => string; firstMonth: string },
): string[] {
  const sentences: string[] = [];
  const never = gaps.behind.filter((item) => item.coveredThrough === null).map((item) => options.cardName(item.cardAccountId));
  if (never.length > 0) sentences.push(`No statements imported for ${listText(never)}`);
  const byDay = new Map<string, string[]>();
  for (const item of gaps.behind) {
    if (item.coveredThrough !== null) byDay.set(item.coveredThrough, [...(byDay.get(item.coveredThrough) ?? []), options.cardName(item.cardAccountId)]);
  }
  for (const [day, names] of byDay) sentences.push(`No statements imported after ${longDate(day)} for ${listText(names)}`);
  const later = gaps.startingLater.length;
  if (later > 0) {
    const latest = longDate(gaps.startingLater[later - 1].firstKnown);
    sentences.push(later === 1
      ? `1 card in view was first seen after ${monthLabel(options.firstMonth)}, on ${latest}, so earlier months can't count`
      : `${later} cards in view were first seen after ${monthLabel(options.firstMonth)}, the latest on ${latest}, so earlier months can't count`);
  }
  if (gaps.behind.length > 0) sentences.push('To count those months, import recent statements, or mark cards no longer used as closed');
  return sentences;
}

const TIME_WINDOW = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|days?|weeks?|months?|years?|today|to date|so far)\b|\b\d{4}\b/i;
const FUTURE_OR_ABSOLUTE = /\b(?:will|always|never|guaranteed?)\b/i;
const ESTIMATE_WORDS = /\b(?:forecast|projected|projection|expected|predict\w*)\b/i;

/**
 * What is wrong with an insight sentence, by the overview's rules: it needs a number and a time window; it never says
 * "will" or "always" (or "never"); it carries no percentage (the overview's categories are too thin for them); and a
 * forecast says it is an estimate.
 */
export function insightLintProblems(sentence: string): string[] {
  const problems: string[] = [];
  if (!/\d/.test(sentence)) problems.push('no number');
  if (!TIME_WINDOW.test(sentence)) problems.push('no time window');
  if (FUTURE_OR_ABSOLUTE.test(sentence)) problems.push('says will, always or never');
  if (sentence.includes('%')) problems.push('has a percentage');
  if (ESTIMATE_WORDS.test(sentence) && !/\bestimate/i.test(sentence)) problems.push('a forecast not called an estimate');
  return problems;
}
