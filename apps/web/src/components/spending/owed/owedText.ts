import type { CardOwner, CardScheduleSourceKind } from '@finance-tracker/shared';

import { OWNER_LABELS, dateRangeLabel, daysBetween, formatMinor, formatRowAmount, issuerLabel, longDate } from '../spendingFormat';
import type { OwedCard, OwedRead } from './owedApi';

/**
 * Owed now's figures and words (OwedNowPanel.tsx), from `GET /cash/owed` alone: every card the API lists is shown,
 * read or not, so a card read later fills its own place, its group's and the totals with no change here. A card not
 * read yet, or whose newest reads disagree, is in no total and says so. Amounts: positive owed, negative a credit.
 */

/** A read older than this many days says how old it is. */
export const OWED_STALE_DAYS = 7;

/** Said while the observations table is not installed (the API lists every card, none read). */
export const OWED_NOT_INSTALLED = 'Balance reads are not set up on this Holdr yet, so every card shows as not read.';

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A card's balance now, as last read: null when it is not read yet or its newest reads disagree. */
export function owedBalance(card: OwedCard): number | null {
  return card.read?.currentBalanceMinor ?? null;
}

export interface OwedTotals {
  currency: string;
  /** The positive balances: what is owed. */
  owedMinor: number;
  /** The negative balances: credits the issuers hold (zero or less). */
  creditsMinor: number;
  netMinor: number;
  /** Cards in these totals. */
  cards: number;
}

/**
 * Per currency, over the cards whose balance was read: owed sums the positive balances, credits the negative ones, and
 * net both. The currency with the most cards comes first.
 */
export function owedTotals(cards: readonly OwedCard[]): OwedTotals[] {
  const byCurrency = new Map<string, OwedTotals>();
  for (const card of cards) {
    const balance = owedBalance(card);
    if (balance === null) continue;
    const totals = byCurrency.get(card.currency) ?? { currency: card.currency, owedMinor: 0, creditsMinor: 0, netMinor: 0, cards: 0 };
    if (balance > 0) totals.owedMinor += balance;
    else totals.creditsMinor += balance;
    totals.netMinor += balance;
    totals.cards += 1;
    byCurrency.set(card.currency, totals);
  }
  return [...byCurrency.values()].sort((a, b) => b.cards - a.cards || byText(a.currency, b.currency));
}

export interface OwedCoverage {
  /** Cards listed. */
  total: number;
  /** Cards whose balance was read (in the totals). */
  read: number;
  /** Cards whose newest reads of the balance disagree. */
  disagree: number;
  /** The household dates of the oldest and the newest balance read; null before any. */
  from: string | null;
  to: string | null;
}

export function owedCoverage(cards: readonly OwedCard[]): OwedCoverage {
  const dates = cards.filter((card) => owedBalance(card) !== null).map((card) => card.read!.asOfDate).sort(byText);
  return {
    total: cards.length,
    read: dates.length,
    disagree: cards.filter((card) => card.read?.conflict === true).length,
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
  };
}

/** "$4,200.00 owed now" (each currency apart); before any balance is read, that nothing is. */
export function owedHeadline(totals: readonly OwedTotals[]): string {
  if (totals.length === 0) return 'No balance read yet';
  return `${totals.map((item) => formatMinor(item.owedMinor, item.currency)).join(' and ')} owed now`;
}

/** "Credits −$500.00 · net $3,700.00" (each currency apart); null before any balance is read. */
export function owedNetText(totals: readonly OwedTotals[]): string | null {
  if (totals.length === 0) return null;
  return totals.map((item) => `${item.creditsMinor < 0 ? `Credits ${formatRowAmount(item.creditsMinor, item.currency)}` : 'No credits'}`
    + ` · net ${formatRowAmount(item.netMinor, item.currency)}`).join('; ');
}

/** "3 of 7 cards read, as of Nov 21, 2026"; reads from different days give the span of their dates. */
export function owedCoverageText(coverage: OwedCoverage): string {
  if (coverage.total === 0) return 'No cards yet';
  if (coverage.read === 0) return `0 of ${plural(coverage.total, 'card')} read`;
  const count = coverage.read < coverage.total ? `${coverage.read} of ${plural(coverage.total, 'card')} read`
    : coverage.total === 1 ? '1 card read' : `All ${coverage.total} cards read`;
  return `${count}, as of ${dateRangeLabel(coverage.from!, coverage.to!)}`;
}

/** What the totals leave out, in words: cards not read yet, and cards whose newest reads disagree. Null: nothing. */
export function owedLeftOutText(coverage: OwedCoverage): string | null {
  const unread = coverage.total - coverage.read - coverage.disagree;
  const parts = [
    unread > 0 ? `${plural(unread, 'card')} not read yet` : null,
    coverage.disagree > 0 ? `${plural(coverage.disagree, 'card')} whose newest reads disagree` : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : `Not in these totals: ${parts.join(' and ')}`;
}

/** Reads stored but shown on no card: matched to no single card, or held for another reason. Null: none. */
export function owedHeldText(held: number): string | null {
  if (held <= 0) return null;
  return `${plural(held, 'stored read')} ${held === 1 ? 'is' : 'are'} not shown: no single card matched, or held for another reason`;
}

export interface OwedGroup {
  key: string;
  issuer: string;
  owner: CardOwner;
  /** "Amex · Alex" */
  label: string;
  /** Balances read first, most owed first; then the cards not read, as the API lists them. */
  cards: OwedCard[];
  totals: OwedTotals[];
  /** Cards in the totals. */
  read: number;
}

function orderCards(cards: readonly OwedCard[]): OwedCard[] {
  return cards.map((card, index) => ({ card, index })).sort((a, b) => {
    const x = owedBalance(a.card);
    const y = owedBalance(b.card);
    if ((x === null) !== (y === null)) return x === null ? 1 : -1;
    return (x !== null && y !== null ? y - x : 0) || a.index - b.index;
  }).map((item) => item.card);
}

/** The cards by issuer and person: groups with a balance read first, the most owed first; then the rest, by name. */
export function owedGroups(cards: readonly OwedCard[]): OwedGroup[] {
  const byKey = new Map<string, OwedCard[]>();
  for (const card of cards) {
    const key = `${card.issuer}|${card.owner}`;
    byKey.set(key, [...(byKey.get(key) ?? []), card]);
  }
  const groups = [...byKey.entries()].map(([key, list]): OwedGroup => ({
    key,
    issuer: list[0].issuer,
    owner: list[0].owner,
    label: `${issuerLabel(list[0].issuer)} · ${OWNER_LABELS[list[0].owner] ?? list[0].owner}`,
    cards: orderCards(list),
    totals: owedTotals(list),
    read: list.filter((card) => owedBalance(card) !== null).length,
  }));
  const owed = (group: OwedGroup) => group.totals[0]?.owedMinor ?? 0;
  return groups.sort((a, b) => Number(b.read > 0) - Number(a.read > 0) || owed(b) - owed(a) || byText(a.label, b.label));
}

/** A group's amount: what its cards owe (each currency apart), or why none of them is in a total. */
export function owedGroupAmount(group: OwedGroup): string {
  if (group.totals.length > 0) return group.totals.map((item) => formatMinor(item.owedMinor, item.currency)).join(' and ');
  return group.cards.length > 0 && group.cards.every((card) => card.read?.conflict === true) ? 'Reads disagree' : 'Not read yet';
}

/** "3 cards: 2 read, 1 not read yet · credits −$500.00": how much of the group is read, and its credits. */
export function owedGroupMeta(group: OwedGroup): string {
  const total = group.cards.length;
  const disagree = group.cards.filter((card) => card.read?.conflict === true).length;
  const unread = total - group.read - disagree;
  const count = group.read === total ? plural(total, 'card')
    : total === 1 ? `1 card, ${disagree === 1 ? 'reads disagree' : 'not read yet'}`
      : `${total} cards: ${[
        group.read > 0 ? `${group.read} read` : null,
        unread > 0 ? `${unread} not read yet` : null,
        disagree > 0 ? `${disagree} with reads that disagree` : null,
      ].filter((part): part is string => part !== null).join(', ')}`;
  const credits = group.totals.filter((item) => item.creditsMinor < 0)
    .map((item) => `credits ${formatRowAmount(item.creditsMinor, item.currency)}`);
  return [count, ...credits].join(' · ');
}

/** A card's name when the page doesn't know its account: issuer, nickname and the ending the issuer shows. */
export function owedCardFallbackName(card: OwedCard): string {
  const ending = card.last5 ?? card.last4;
  return [issuerLabel(card.issuer), card.nickname?.trim() || null, ending ? `··${ending}` : null].filter(Boolean).join(' ');
}

/** A card's balance as shown: the amount, or why there is none. */
export function owedCardAmount(card: OwedCard): string {
  const balance = owedBalance(card);
  if (balance !== null) return formatRowAmount(balance, card.currency);
  return card.read?.conflict ? 'Reads disagree' : 'Not read yet';
}

const SOURCE_WORDS: Record<CardScheduleSourceKind, string> = {
  'issuer-dashboard-dom': 'from the issuer',
  'issuer-dashboard-json': 'from the issuer',
  'statement-pdf': 'from a statement',
  'owner-entry': 'entered by hand',
};

/** "As of Nov 22, 2026, from the issuer"; a read more than a week old says how many days. */
export function owedAsOfText(read: OwedRead, today: string): string {
  const days = daysBetween(read.asOfDate, today);
  const age = days > OWED_STALE_DAYS ? ` (${days} days ago)` : '';
  return `As of ${longDate(read.asOfDate)}${age}, ${SOURCE_WORDS[read.sourceKind] ?? 'from a read'}`;
}

/** What else was read of a card, part by part: its last statement, the due date and minimum, and as of when. */
export function owedCardDetails(card: OwedCard, today: string): string[] {
  const read = card.read;
  if (read === null) return [];
  const money = (minor: number) => formatRowAmount(minor, card.currency);
  const remaining = read.remainingStatementMinor;
  const parts: string[] = [];
  if (read.statementBalanceMinor !== null) {
    const statement = read.statementClosingDate !== null
      ? `Statement of ${longDate(read.statementClosingDate)}: ${money(read.statementBalanceMinor)}`
      : `Last statement ${money(read.statementBalanceMinor)}`;
    parts.push(remaining === null ? statement : `${statement}, ${remaining > 0 ? `${money(remaining)} still to pay` : 'paid'}`);
  } else if (remaining !== null) {
    parts.push(remaining > 0 ? `${money(remaining)} of the last statement still to pay` : 'Last statement paid');
  }
  if (read.paymentDueDate !== null) {
    parts.push(`Due ${longDate(read.paymentDueDate)}${read.minimumDueMinor !== null ? `, minimum ${money(read.minimumDueMinor)}` : ''}`);
  }
  if (read.conflict) parts.push('Its newest reads disagree on the balance; the next read settles it');
  parts.push(owedAsOfText(read, today));
  return parts;
}
