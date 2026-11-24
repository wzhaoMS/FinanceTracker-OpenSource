/**
 * The words and the batch of the owner's card opening months screen (CardOpenings.tsx), pure so they can be tested:
 * which month each card shows, what is wrong with a month, what "Confirm all shown" sends, and what each card's line
 * says. The API decides (`/spending/card-openings`); these checks only spare the owner a refusal.
 */
import type { CardOpeningMonthView } from '@finance-tracker/shared';

import { longDate, monthLabel, todayIso } from '../spendingFormat';

/** 1900-01 through 2099-12, as the API takes them. */
const MONTH = /^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])$/;

/** What the owner confirms for each card, said once at the top of the screen. */
export const OPENINGS_INTRO = 'Confirm the month each card was opened (its first statement). Holdr then stops expecting a card '
  + 'before that month, and in that month counts it from the first day Holdr has for it; such a month says it includes a '
  + 'card opened this month. So confirm a month only when Holdr has the card from its start. For a card older than what '
  + 'Holdr has, choose the month it opened: the months before its record stay marked as possibly missing spending. A month '
  + 'after the first day Holdr has is not taken.';

export const OPENINGS_NOT_INSTALLED = 'Opening months need a one-time install on this Holdr first; until then nothing can be confirmed.';

/** One card on the screen: the month it shows, what is wrong with it, and whether confirming it changes anything. */
export interface OpeningRow {
  card: CardOpeningMonthView;
  /** YYYY-MM, or '' when there is none to show. */
  month: string;
  /** Why the month shown cannot be confirmed for this card; null when it can, or when none is shown. */
  problem: string | null;
  /** Confirming the month shown changes what coverage uses: a new month, or one earlier evidence has since contradicted. */
  changes: boolean;
}

/**
 * The month a card shows: what the owner typed, else the month in force while coverage uses it, else the prefill (the
 * month of the first day Holdr has for the card), which also replaces a month earlier evidence contradicts.
 */
export function shownMonth(card: CardOpeningMonthView, typed?: string): string {
  if (typed !== undefined) return typed;
  if (card.openingMonth !== null && card.status !== 'contradicted') return card.openingMonth;
  return card.prefillMonth ?? '';
}

/** Why `month` cannot be the card's opening month, said plainly; null when it can. `today` is YYYY-MM-DD. */
export function openingMonthProblem(card: Pick<CardOpeningMonthView, 'firstKnownDate'>, month: string, today: string): string | null {
  if (!MONTH.test(month)) return 'Choose a month';
  if (month > today.slice(0, 7)) return 'Choose this month or an earlier one';
  // Later than the month of the first day Holdr has for it: evidence already exists earlier (the API refuses it too).
  if (card.firstKnownDate !== null && card.firstKnownDate < `${month}-01`) {
    return `Holdr has it from ${longDate(card.firstKnownDate)}: choose ${monthLabel(card.firstKnownDate.slice(0, 7))} or earlier`;
  }
  return null;
}

/** Each card as the screen shows it, with what the owner typed (by card id). */
export function openingRows(
  cards: readonly CardOpeningMonthView[],
  typed: Readonly<Record<string, string>>,
  today: string,
): OpeningRow[] {
  return cards.map((card) => {
    const month = shownMonth(card, typed[card.cardAccountId]);
    const problem = month === '' ? null : openingMonthProblem(card, month, today);
    const inForce = card.openingMonth === month && card.status !== 'contradicted';
    return { card, month, problem, changes: month !== '' && problem === null && !inForce };
  });
}

/** What "Confirm all shown" sends, and how many cards whose month would change it leaves out for their own Confirm. */
export interface ConfirmAll {
  cards: Array<{ cardAccountId: string; openingMonth: string }>;
  /** A month shown is wrong: nothing is sent until it is fixed. */
  blocked: boolean;
  /** Cards whose month would change that are first seen after the earliest card (`firstSeenLater`), left out. */
  flagged: number;
}

/**
 * What "Confirm all shown" sends: each card shown whose month would change, except a card first seen after the earliest
 * one, as its line flags it (`firstSeenLater`, over every card in the answer): its prefill may be only where Holdr's
 * history begins, so it takes its own Confirm. Nothing while any month shown is wrong.
 */
export function confirmAllShown(rows: readonly OpeningRow[], earliest: string | null): ConfirmAll {
  const blocked = rows.some((row) => row.problem !== null);
  const changing = rows.filter((row) => row.changes);
  const flagged = changing.filter((row) => firstSeenLater(row.card, earliest));
  return {
    blocked,
    flagged: flagged.length,
    cards: blocked ? [] : changing.filter((row) => !flagged.includes(row)).map((row) => ({ cardAccountId: row.card.cardAccountId, openingMonth: row.month })),
  };
}

/** What Holdr has of the card: "Holdr has it from Mar 10, 2024 (first transaction Mar 12, 2024)". */
export function evidenceText(card: CardOpeningMonthView): string {
  if (card.firstKnownDate === null) return 'Nothing stored for it yet';
  const row = card.firstRowDate !== null && card.firstRowDate !== card.firstKnownDate ? ` (first transaction ${longDate(card.firstRowDate)})` : '';
  return `Holdr has it from ${longDate(card.firstKnownDate)}${row}`;
}

/** Where the card's month stands: not confirmed, confirmed (and when), or confirmed but not used, and why. */
export function statusText(card: CardOpeningMonthView): string {
  if (card.openingMonth === null) return card.prefillMonth === null ? 'Not confirmed' : 'Not confirmed: shown from the first day Holdr has';
  const month = monthLabel(card.openingMonth);
  if (card.status === 'contradicted' && card.firstKnownDate !== null) {
    return `${month} was confirmed, but Holdr has it from ${longDate(card.firstKnownDate)}: not used until you confirm again`;
  }
  const on = card.confirmedAt === null ? '' : ` on ${longDate(todayIso(new Date(card.confirmedAt)))}`;
  if (card.status === 'no-data') return `Confirmed ${month}${on}; used once Holdr has data for it`;
  return `Confirmed ${month}${on}`;
}

/** Root's words for a month complete only because a card opened in it: "includes a card opened this month". */
export function openedText(count: number, scope: 'month' | 'period' = 'month'): string {
  return `includes ${count === 1 ? 'a card' : `${count} cards`} opened ${scope === 'month' ? 'this month' : 'in this period'}`;
}

/**
 * A complete window's note when it is complete only because a card opened in it (the API's `openedCardIds`: cards
 * expected only from their first known day, after the window's first day); null otherwise. "Includes a card opened
 * this month", or with a subject, "August 2024 includes a card opened this month".
 */
export function openedNote(
  coverage: { complete: boolean; openedCardIds?: readonly string[] },
  options: { subject?: string; scope?: 'month' | 'period' } = {},
): string | null {
  const count = coverage.openedCardIds?.length ?? 0;
  if (!coverage.complete || count === 0) return null;
  const text = openedText(count, options.scope);
  return options.subject ? `${options.subject} ${text}` : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** The answer to a confirmation. */
export function changedText(changed: number): string {
  if (changed === 0) return 'Nothing changed: those months were already confirmed';
  return changed === 1 ? 'Confirmed 1 card\'s opening month' : `Confirmed ${changed} cards' opening months`;
}

/**
 * What confirming the month shown asserts for the card, said before the click; null when confirming changes nothing,
 * the month cannot be confirmed, or Holdr has no data for the card. The day is the one coverage counts it from: its
 * first known day when that falls in the month, else the month's 1st, and then the months before its first known day
 * stay partial.
 */
export function assertionText(row: OpeningRow): string | null {
  const { card, month } = row;
  if (!row.changes || card.firstKnownDate === null) return null;
  const from = card.firstKnownDate.slice(0, 7) === month ? card.firstKnownDate : `${month}-01`;
  const says = `Confirming ${monthLabel(month)} says this card had no spending before ${longDate(from)}`;
  return from === card.firstKnownDate
    ? says
    : `${says}; the months before ${longDate(card.firstKnownDate)}, its first day in Holdr, stay marked as possibly missing spending`;
}

/** The earliest first known day among every card account on the screen's answer (not only those shown); null without any. */
export function earliestFirstKnown(cards: readonly Pick<CardOpeningMonthView, 'firstKnownDate'>[]): string | null {
  return cards.reduce<string | null>((earliest, card) => (card.firstKnownDate !== null && (earliest === null || card.firstKnownDate < earliest)
    ? card.firstKnownDate : earliest), null);
}

/**
 * A card first seen after the earliest first known day among every card account in the answer (`earliest`): where a
 * confirmation can most easily hide spending (an older card whose earlier statements were never imported). Its line
 * flags it (`laterCardText`), and "Confirm all shown" leaves it out (`confirmAllShown`): one predicate for both.
 */
export function firstSeenLater(card: Pick<CardOpeningMonthView, 'firstKnownDate'>, earliest: string | null): boolean {
  return card.firstKnownDate !== null && earliest !== null && card.firstKnownDate > earliest;
}

/** A card first seen after the earliest of all the cards (`firstSeenLater`), flagged before the click; null otherwise. */
export function laterCardText(card: Pick<CardOpeningMonthView, 'firstKnownDate'>, earliest: string | null): string | null {
  if (!firstSeenLater(card, earliest)) return null;
  return `First seen after your earliest card (${longDate(earliest!)}): confirm only if it was opened then`;
}

/**
 * On a line still showing its prefill, with no month in force (none confirmed, or one its evidence contradicts), said
 * plainly under "What Holdr has" (the line's status already says it is shown from the first day Holdr has): the month
 * shown is where Holdr's history of the card begins, which may not be the month it was opened.
 */
export function prefillText(row: OpeningRow): string | null {
  const { card, month } = row;
  if (card.prefillMonth === null || month !== card.prefillMonth) return null;
  if (card.openingMonth !== null && card.status !== 'contradicted') return null;
  return `${monthLabel(month)} is where Holdr's history of this card begins, which may not be the month it was opened`;
}

/** Beside "Confirm all shown": what the one click says for every card it confirms. */
export const CONFIRM_ALL_NOTE = 'Confirming says each card had no spending before the day its line names.';

/** Beside "Confirm all shown" when it leaves flagged cards out: each needs its own Confirm. Null when none is left out. */
export function flaggedNote(flagged: number): string | null {
  if (flagged === 0) return null;
  return flagged === 1 ? '1 flagged card is left out: it needs its own Confirm.' : `${flagged} flagged cards are left out: each needs its own Confirm.`;
}

/** The "Confirm all shown" button's words: how many cards it confirms, and that flagged cards are not among them. */
export function confirmAllLabel(all: ConfirmAll): string {
  if (all.blocked) return 'Confirm all shown';
  if (all.cards.length > 0) {
    return all.flagged > 0 ? `Confirm all shown except flagged (${all.cards.length})` : `Confirm all shown (${all.cards.length})`;
  }
  return all.flagged > 0 ? 'Nothing to confirm at once: each card left is flagged' : 'Every month shown is confirmed';
}
