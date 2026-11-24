/**
 * Which months of card spending are fully known. Per month: the cards in view that plausibly existed then, how many of
 * them have data in it, how many are known to have every row stored for every day of it, how many first appear only
 * later, and whether the month is complete. Spending marks the months that are not complete (they are never shown as
 * spending less), and baselines and forecasts learn only from complete ones.
 *
 * Rules (conservative: unknown coverage is never assumed):
 * - a card's known coverage is the inclusive transaction-date ranges in which every one of its rows is known to be
 *   stored (the caller decides which sources count: Spending counts the ranges its imports declared, and card-sync
 *   windows only once Holdr has verified them complete). Overlapping and adjacent ranges are joined;
 * - a card's first known day is its first row or the start of its first coverage, whichever is earlier; it is expected
 *   in a month from then and, once closed, until its last known day (its last row or the end of its last coverage,
 *   whichever is later); an active card is expected through today. A card with neither rows nor coverage is ignored;
 * - an expected card is covered in a month only when its known coverage spans every day of the month, whether or not
 *   it has rows there (a month it was not read is unknown, not empty), so the month a card's history starts in is
 *   covered only when its coverage starts on or before the 1st;
 * - a card in view whose first known day is after the month counts in `cardsStartingLater`. Holdr stores no date a
 *   card was opened, so a card whose data starts later looks exactly like history that was never imported: a month
 *   before a card in view first appears is never complete, because the record may not reach back that far;
 * - unless the owner confirmed the card's opening month (`openingMonth`, cardOpeningMonths.ts): then the card is not
 *   expected, nor starting later, in any month before it; in that month it is expected from its first known day when
 *   that day is in it (else from its 1st), so it is covered there when one range runs from that day to the month's end,
 *   and it is listed in the month's `openedCardIds` when that day is after the 1st; a month later than the month of the
 *   card's first known day is contradicted by that evidence and does not apply;
 * - a month is complete only when it is over (its last day is before `today`), at least one card is expected in it,
 *   every expected card is covered, and no card in view starts later. A month in progress, or still to come, is never
 *   complete.
 *
 * Removed rows are ignored, and so are rows and coverage of cards not in view. Pure and deterministic.
 */
import { cardOpeningDay, isCardOpeningMonth } from './cardOpeningMonths.js';
import { mergeCardCoverage, type CardCoverageRange } from './cardSpending.js';
import type { CardAccountStatus, CardTransactionStatus } from './types.js';

/** A card account in view: only its id, whether it is closed and its confirmed opening month are read. */
export interface CardCoverageCard {
  id: string;
  status?: CardAccountStatus | null;
  /** The owner-confirmed month the card was opened (YYYY-MM); absent or null: none (as before opening months). */
  openingMonth?: string | null;
}

/** A card's known coverage: inclusive YYYY-MM-DD transaction-date ranges (any order, may overlap). */
export interface CardCoverageEvidence {
  cardAccountId: string;
  ranges: readonly CardCoverageRange[];
}

/** A stored row: only its card, its transaction date and its status are read. */
export interface CardCoverageRow {
  cardAccountId: string;
  transactionDate: string;
  status: CardTransactionStatus;
}

export interface CardSpendingCoverageInput {
  /** The card accounts in view (one card, one person's cards, or all). */
  cards: readonly CardCoverageCard[];
  coverage: readonly CardCoverageEvidence[];
  rows: readonly CardCoverageRow[];
  /** YYYY-MM-DD. A month (or range) whose last day is not before it is in progress. */
  today: string;
}

/** The months to list (YYYY-MM, inclusive); see {@link cardSpendingCoverageByMonth} for the defaults. */
export interface CardSpendingCoverageMonthsInput extends CardSpendingCoverageInput {
  from?: string;
  to?: string;
}

/** What is known of one month's card data. */
export interface CardSpendingMonthCoverage {
  /** YYYY-MM. */
  month: string;
  /** Over, with at least one card expected, every expected card covered for every day, and no card starting later. */
  complete: boolean;
  /** Expected cards with at least one row (pending or posted) dated in the month. */
  cardsWithData: number;
  /** Cards in view that plausibly existed in the month. */
  cardsExpected: number;
  /** Expected cards whose known coverage spans every day of the month. */
  cardsCovered: number;
  /** Cards in view whose first known day is after the month: the record may not reach back this far for them. */
  cardsStartingLater: number;
  /** The month is not over before `today` (or is still to come): never complete. */
  inProgress: boolean;
  /** Expected cards not covered for every day of the month, sorted. */
  uncoveredCardIds: string[];
  /**
   * Expected cards opened in the month after its 1st, by their owner-confirmed opening month: expected only from their
   * first known day, so a complete month is complete only because they opened in it. Sorted; present only when there
   * are any (never while no opening month applies).
   */
  openedCardIds?: string[];
}

/** What is known of an inclusive range of days: the same rules as a month, over the range's own days. */
export interface CardSpendingRangeCoverage {
  from: string;
  to: string;
  complete: boolean;
  cardsWithData: number;
  cardsExpected: number;
  cardsCovered: number;
  /** Cards in view whose first known day is after the range's last day. */
  cardsStartingLater: number;
  inProgress: boolean;
  uncoveredCardIds: string[];
  /** Expected cards opened after the range's first day, as for a month; present only when there are any. */
  openedCardIds?: string[];
}

/** Months listed at most, as the spending summary fills months. */
const MAX_MONTHS = 1200;
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;

function isDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function monthIndex(month: string): number {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

function monthOf(index: number): string {
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** The last day of a YYYY-MM month, as YYYY-MM-DD. */
function lastDayOf(month: string): string {
  const days = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  return `${month}-${String(days).padStart(2, '0')}`;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface CardState {
  id: string;
  closed: boolean;
  /** First and last day the card is known to exist; null when it has neither rows nor coverage. */
  first: string | null;
  last: string | null;
  /** The day it counts from under its confirmed opening month; null when it has none, or that month does not apply. */
  opening: string | null;
  /** Merged, sorted, disjoint. */
  ranges: CardCoverageRange[];
  /** Its rows' transaction dates, sorted. */
  dates: string[];
}

function cardStates(input: CardSpendingCoverageInput): CardState[] {
  if (!isDay(input.today)) throw new RangeError('today must be a valid YYYY-MM-DD date');
  const states = new Map<string, CardState & { raw: CardCoverageRange[]; openingMonth: string | null }>();
  for (const card of input.cards) {
    if (typeof card?.id !== 'string' || states.has(card.id)) continue;
    const openingMonth = card.openingMonth ?? null;
    if (openingMonth !== null && !isCardOpeningMonth(openingMonth)) throw new RangeError('a card\'s openingMonth must be a YYYY-MM month');
    states.set(card.id, {
      id: card.id, closed: card.status === 'closed', first: null, last: null, opening: null, ranges: [], dates: [], raw: [], openingMonth,
    });
  }
  for (const row of input.rows) {
    if (row.status === 'removed' || !isDay(row.transactionDate)) continue;
    states.get(row.cardAccountId)?.dates.push(row.transactionDate);
  }
  for (const evidence of input.coverage) states.get(evidence.cardAccountId)?.raw.push(...evidence.ranges);
  return [...states.values()].map(({ raw, openingMonth, ...state }) => {
    const ranges = mergeCardCoverage(raw);
    const dates = state.dates.sort(byText);
    const firsts = [dates[0], ranges[0]?.start].filter((day): day is string => day !== undefined);
    const lasts = [dates[dates.length - 1], ranges[ranges.length - 1]?.end].filter((day): day is string => day !== undefined);
    const first = firsts.length === 0 ? null : firsts.sort(byText)[0];
    return {
      ...state,
      ranges,
      dates,
      first,
      last: lasts.length === 0 ? null : lasts.sort(byText)[lasts.length - 1],
      opening: openingMonth === null ? null : cardOpeningDay(openingMonth, { firstKnownDate: first }),
    };
  });
}

/** True when some row of the card is dated within [from, to]. */
function hasDataIn(state: CardState, from: string, to: string): boolean {
  let low = 0;
  let high = state.dates.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (state.dates[middle] < from) low = middle + 1;
    else high = middle;
  }
  return low < state.dates.length && state.dates[low] <= to;
}

/** What is known of [from, to] over the cards' states. */
function rangeCoverage(states: readonly CardState[], from: string, to: string, today: string) {
  const expected = states.filter((state) => state.first !== null && (state.opening ?? state.first) <= to
    && (!state.closed || state.last! >= from));
  // Merged ranges are disjoint and never adjacent, so a span of days is covered only inside one of them. A card's days
  // before its opening day are before it existed.
  const uncovered = expected.filter((state) => {
    const start = state.opening !== null && state.opening > from ? state.opening : from;
    return !state.ranges.some((range) => range.start <= start && range.end >= to);
  }).map((state) => state.id).sort(byText);
  // Unless the owner confirmed when a card opened, a card first seen later may simply not have been imported this far back.
  const cardsStartingLater = states.filter((state) => state.first !== null && state.opening === null && state.first > to).length;
  // Cards expected only from an opening day inside the range: the range's days before it are before they existed.
  const opened = expected.filter((state) => state.opening !== null && state.opening > from).map((state) => state.id).sort(byText);
  const inProgress = to >= today;
  return {
    complete: !inProgress && expected.length > 0 && uncovered.length === 0 && cardsStartingLater === 0,
    cardsWithData: expected.filter((state) => hasDataIn(state, from, to)).length,
    cardsExpected: expected.length,
    cardsCovered: expected.length - uncovered.length,
    cardsStartingLater,
    inProgress,
    uncoveredCardIds: uncovered,
    ...(opened.length > 0 ? { openedCardIds: opened } : {}),
  };
}

/**
 * Per month from `from` through `to` (YYYY-MM, inclusive), oldest first: what is known of the cards in view. By default
 * from the month of the earliest row of a card in view (or, with no rows, of its earliest coverage) through today's
 * month; empty when there is neither, or when `from` is after `to`.
 */
export function cardSpendingCoverageByMonth(input: CardSpendingCoverageMonthsInput): CardSpendingMonthCoverage[] {
  checkMonths(input);
  const states = cardStates(input);
  const { from, to } = viewMonths(input, states);
  if (from === undefined || from > to) return [];
  const first = monthIndex(from);
  const last = Math.min(monthIndex(to), first + MAX_MONTHS - 1);
  const months: CardSpendingMonthCoverage[] = [];
  for (let index = first; index <= last; index += 1) {
    const month = monthOf(index);
    months.push({ month, ...rangeCoverage(states, `${month}-01`, lastDayOf(month), input.today) });
  }
  return months;
}

function checkMonths(input: CardSpendingCoverageMonthsInput): void {
  for (const [name, value] of [['from', input.from], ['to', input.to]] as const) {
    if (value !== undefined && !MONTH.test(value)) throw new RangeError(`${name} must be a YYYY-MM month`);
  }
}

/** The months a view lists: `from` and `to` as given, else from its earliest row (or coverage) through today's month. */
function viewMonths(input: CardSpendingCoverageMonthsInput, states: readonly CardState[]): { from: string | undefined; to: string } {
  const earliestRow = states.flatMap((state) => state.dates.slice(0, 1)).sort(byText)[0];
  const earliestCoverage = states.flatMap((state) => state.ranges.slice(0, 1).map((range) => range.start)).sort(byText)[0];
  return { from: input.from ?? (earliestRow ?? earliestCoverage)?.slice(0, 7), to: input.to ?? input.today.slice(0, 7) };
}

/** An open card whose known coverage stops before the last month that can be complete. */
export interface CardSpendingCoverageBehind {
  cardAccountId: string;
  /** The last day its known coverage reaches; null when none is recorded. */
  coveredThrough: string | null;
}

/** A card in view first seen after the view's first month. */
export interface CardSpendingCoverageStartingLater {
  cardAccountId: string;
  /** Its first known day: its first row or the start of its first coverage, whichever is earlier. */
  firstKnown: string;
}

/**
 * What keeps a view's months from being complete, card by card, with ids and dates only (a card's name is the app's to
 * show): the cards behind, and the cards that start later. A month can also be incomplete for a gap inside a card's
 * coverage, or for a card's first or last month only partly covered; those are not listed here.
 */
export interface CardSpendingCoverageGaps {
  /** The view's last month that can be complete: its last month over before `today`; null when none of its months is. */
  lastCompletableMonth: string | null;
  /**
   * Open cards expected in that month whose known coverage does not reach its last day, those with none recorded
   * first, then by the day their coverage reaches. No month after that day can be complete until their later
   * statements are imported, or the card is marked closed. Closed cards are not listed.
   */
  behind: CardSpendingCoverageBehind[];
  /**
   * Cards in view first seen after the view's first month, earliest first: no month before a card's first known day
   * can be complete. As many as the first month's `cardsStartingLater`: a card whose confirmed opening month applies
   * is never listed.
   */
  startingLater: CardSpendingCoverageStartingLater[];
}

/**
 * Why a view's months may not be complete, from the same input and by the same rules as
 * {@link cardSpendingCoverageByMonth}: the open cards whose known coverage stops before the view's last month that can
 * be complete, and the cards first seen after its first month.
 */
export function cardSpendingCoverageGaps(input: CardSpendingCoverageMonthsInput): CardSpendingCoverageGaps {
  checkMonths(input);
  const states = cardStates(input);
  const { from, to } = viewMonths(input, states);
  if (from === undefined || from > to) return { lastCompletableMonth: null, behind: [], startingLater: [] };
  const lastOver = monthOf(monthIndex(input.today.slice(0, 7)) - 1);
  const latest = to < lastOver ? to : lastOver;
  const lastCompletableMonth = latest >= from ? latest : null;
  const behind: CardSpendingCoverageBehind[] = [];
  if (lastCompletableMonth !== null) {
    const end = lastDayOf(lastCompletableMonth);
    for (const state of states) {
      // Expected in that month as rangeCoverage expects it: from its opening day under a confirmed month.
      if (state.first === null || state.closed || (state.opening ?? state.first) > end) continue;
      const coveredThrough = state.ranges.length > 0 ? state.ranges[state.ranges.length - 1].end : null;
      if (coveredThrough === null || coveredThrough < end) behind.push({ cardAccountId: state.id, coveredThrough });
    }
    behind.sort((a, b) => (a.coveredThrough === b.coveredThrough ? byText(a.cardAccountId, b.cardAccountId)
      : a.coveredThrough === null ? -1 : b.coveredThrough === null ? 1 : byText(a.coveredThrough, b.coveredThrough)));
  }
  const firstMonthEnd = lastDayOf(from);
  const startingLater = states
    .filter((state): state is CardState & { first: string } => state.first !== null && state.opening === null && state.first > firstMonthEnd)
    .map((state) => ({ cardAccountId: state.id, firstKnown: state.first }))
    .sort((a, b) => byText(a.firstKnown, b.firstKnown) || byText(a.cardAccountId, b.cardAccountId));
  return { lastCompletableMonth, behind, startingLater };
}

/** What is known of an inclusive range of days (YYYY-MM-DD), by the same rules as a month. */
export function cardSpendingCoverageForRange(
  input: CardSpendingCoverageInput,
  range: { from: string; to: string },
): CardSpendingRangeCoverage {
  if (!isDay(range.from) || !isDay(range.to) || range.from > range.to) {
    throw new RangeError('a range needs valid YYYY-MM-DD dates, from not after to');
  }
  return { from: range.from, to: range.to, ...rangeCoverage(cardStates(input), range.from, range.to, input.today) };
}
