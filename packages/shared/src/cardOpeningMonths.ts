/**
 * Card opening months: the owner's word on the month each card account was opened, so that card coverage
 * (cardSpendingCoverage.ts) stops expecting a card before it. Holdr stores no opening date of its own: without the
 * owner's month, a card first seen later looks exactly like history that was never imported, and no month before it
 * can ever be complete.
 *
 * What the owner confirms for a card: "<month> is the month this card was opened (its first statement), and Holdr has
 * its record from its start". Holdr prefills the month of the card's first known day: its first stored row (pending or
 * posted) or the first day of its known coverage (the dates its imports declared, and sync windows Holdr verified
 * complete), whichever is earlier. For a confirmed month M (Root's ruling on iteration 4):
 * - in the months before M the card is not expected, and does not count in `cardsStartingLater`;
 * - in M the card is expected from its first known day when that day is in M (the days of M before it are before the
 *   card existed), else from M's 1st: M is covered for it when one range of its known coverage runs from that day to
 *   M's last day. A month complete only because a card opened in it lists that card (`openedCardIds`), and the app
 *   says so;
 * - after M, as without a month: every day of each month (a closed card until its last known day);
 * - a month earlier than the month of the first known day leaves the months between it and the card's first evidence
 *   expected but not covered: they stay partial;
 * - a month later than the month of the first known day is contradicted by that evidence (the card existed earlier):
 *   it is refused when confirmed, and if the evidence comes after the confirmation, the month does not apply and the
 *   card counts exactly as it would without one (the owner is asked again). A card with neither rows nor coverage is
 *   still ignored.
 *
 * Pure and deterministic: the months are plain data, so a sealed probe can bundle this file with the coverage.
 */
import { mergeCardCoverage, type CardCoverageRange } from './cardSpending.js';
import type { CardTransactionStatus } from './types.js';

const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;

/** True for a YYYY-MM month. */
export function isCardOpeningMonth(value: unknown): value is string {
  return typeof value === 'string' && MONTH.test(value);
}

function isDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** What Holdr knows of when a card's record starts. */
export interface CardOpeningEvidence {
  cardAccountId: string;
  /** Its first stored row (pending or posted), YYYY-MM-DD; null without one. */
  firstRowDate: string | null;
  /** The first day of its known coverage; null without any. */
  firstCoverageDate: string | null;
  /** The earlier of the two: the card's first known day, from which coverage expects it without a month; null without either. */
  firstKnownDate: string | null;
  /** The month of its first known day: the opening month to prefill; null without either. */
  prefillMonth: string | null;
}

/** How coverage takes a confirmed month: see the rules above. */
export type CardOpeningMonthStatus = 'applied' | 'contradicted' | 'no-data';

/**
 * Whether a confirmed month applies: `contradicted` when the card's first known day is before the month (evidence
 * already exists earlier: the card is counted as without a month), `no-data` when the card has neither rows nor
 * coverage (it is ignored either way), else `applied`.
 */
export function cardOpeningMonthStatus(
  openingMonth: string,
  evidence: Pick<CardOpeningEvidence, 'firstKnownDate'>,
): CardOpeningMonthStatus {
  if (!isCardOpeningMonth(openingMonth)) throw new RangeError('an opening month must be a YYYY-MM month');
  if (evidence.firstKnownDate === null) return 'no-data';
  return evidence.firstKnownDate < `${openingMonth}-01` ? 'contradicted' : 'applied';
}

/**
 * The day a card is expected from under a confirmed opening month: its first known day when that is in the month, else
 * the month's 1st (the month is earlier than its first evidence); null when the month does not apply (contradicted, or
 * no data).
 */
export function cardOpeningDay(
  openingMonth: string,
  evidence: Pick<CardOpeningEvidence, 'firstKnownDate'>,
): string | null {
  if (cardOpeningMonthStatus(openingMonth, evidence) !== 'applied') return null;
  return evidence.firstKnownDate!.slice(0, 7) === openingMonth ? evidence.firstKnownDate : `${openingMonth}-01`;
}

/** The inputs coverage reads (cardSpendingCoverage.ts's), by structure: ids, rows and known coverage. */
export interface CardOpeningEvidenceInput {
  cards: readonly { id: string }[];
  coverage: readonly { cardAccountId: string; ranges: readonly CardCoverageRange[] }[];
  rows: readonly { cardAccountId: string; transactionDate: string; status: CardTransactionStatus }[];
}

/**
 * Per card, in the order given (each id once), what Holdr knows of when its record starts, read as coverage reads it:
 * removed rows and rows without a valid date are ignored, and so are rows and coverage of other cards.
 */
export function cardOpeningEvidence(input: CardOpeningEvidenceInput): CardOpeningEvidence[] {
  const cards = new Map<string, { firstRowDate: string | null; ranges: CardCoverageRange[] }>();
  for (const card of input.cards) {
    if (typeof card?.id === 'string' && !cards.has(card.id)) cards.set(card.id, { firstRowDate: null, ranges: [] });
  }
  for (const row of input.rows) {
    if (row.status === 'removed' || !isDay(row.transactionDate)) continue;
    const card = cards.get(row.cardAccountId);
    if (card && (card.firstRowDate === null || row.transactionDate < card.firstRowDate)) card.firstRowDate = row.transactionDate;
  }
  for (const evidence of input.coverage) cards.get(evidence.cardAccountId)?.ranges.push(...evidence.ranges);
  return [...cards].map(([cardAccountId, { firstRowDate, ranges }]) => {
    const firstCoverageDate = mergeCardCoverage(ranges)[0]?.start ?? null;
    const firstKnownDate = firstRowDate === null ? firstCoverageDate
      : firstCoverageDate === null || firstRowDate < firstCoverageDate ? firstRowDate : firstCoverageDate;
    return { cardAccountId, firstRowDate, firstCoverageDate, firstKnownDate, prefillMonth: firstKnownDate?.slice(0, 7) ?? null };
  });
}

/** One confirmation of a card's opening month (who confirmed it is stored, never shown). */
export interface CardOpeningConfirmation {
  /** YYYY-MM. */
  openingMonth: string;
  /** ISO instant. */
  confirmedAt: string;
  /** When it was changed or cleared (ISO instant); null while it is in force. */
  revokedAt: string | null;
}

/** A card on the owner's opening-month screen (`GET /spending/card-openings`). */
export interface CardOpeningMonthView extends CardOpeningEvidence {
  /** The month in force, by the owner; null when none is. */
  openingMonth: string | null;
  confirmedAt: string | null;
  /** How coverage takes the month in force; null without one. */
  status: CardOpeningMonthStatus | null;
  /** Every confirmation of the card, oldest first: changes and clears are kept. */
  history: CardOpeningConfirmation[];
}

/** `GET /spending/card-openings`, and the answer of each change. */
export interface CardOpeningMonthsResponse {
  /** Whether the operator installed the opening months' table: until then changes answer 409. */
  installed: boolean;
  cards: CardOpeningMonthView[];
}
