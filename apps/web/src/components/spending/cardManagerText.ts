/**
 * The words and the list of Manage cards (CardManager.tsx), pure so they can be tested: every card with the latest day
 * Holdr has anything of it, oldest activity first, narrowed by issuer and person, and what marking a card closed or
 * reopening it says. The owner decides: nothing here infers that a card is closed, and no bank closure date is claimed.
 * What a closed card changes is the coverage rule's (packages/shared/src/cardSpendingCoverage.ts): it is expected only
 * through its last known day, and it is never listed as behind.
 */
import type { CardAccount, CardAccountCoverage, CardOwner } from '@finance-tracker/shared';

import { OWNERS, OWNER_LABELS, cardNameLabel, issuerLabel, longDate } from './spendingFormat';

/** Said first in Manage cards. */
export const CARD_MANAGER_LEAD = 'Holdr never closes a card by itself. History stays.';

/** What marking a card closed changes in the months, said in its confirmation. */
export const CLOSING_DETAIL = 'Later history is no longer expected after this card\'s last recorded activity or imported coverage; '
  + 'earlier gaps may remain.';

/** What reopening a card changes in the months, said in its confirmation (an active card is expected through today). */
export const REOPENING_DETAIL = 'Holdr expects this card\'s history again through today.';

/** What changing a card's status does not change, said in both confirmations. */
export const STATUS_KEEPS = 'All records and transactions stay visible in All cards, totals, charts, insights and search. '
  + 'This only changes Holdr, not your account at the bank.';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The latest day Holdr has anything of a card: the later of its last stored row (`transactions.last`) and the end of its
 * imported coverage (`ranges`); null when it has neither. Never guessed.
 */
export function latestRecorded(coverage: Pick<CardAccountCoverage, 'ranges' | 'transactions'>): string | null {
  const days = [coverage.transactions?.last, ...coverage.ranges.map((range) => range.end)]
    .filter((day): day is string => typeof day === 'string' && DAY.test(day));
  return days.reduce<string | null>((latest, day) => (latest === null || day > latest ? day : latest), null);
}

/** "Latest recorded Mar 31, 2024", or "Nothing recorded" when Holdr has neither a row nor imported coverage of it. */
export function latestRecordedText(latest: string | null): string {
  return latest === null ? 'Nothing recorded' : `Latest recorded ${longDate(latest)}`;
}

/** Said in place of the latest day while the record has not been read, or could not be: never a guess. */
export const LATEST_NOT_READ = 'Latest record not read';

/** One card in Manage cards. */
export interface CardManagerRow {
  account: CardAccount;
  /** YYYY-MM-DD; null when Holdr has nothing of it; undefined when its record is not read. */
  latest: string | null | undefined;
}

/** Manage cards' filters: an issuer slug and a person, each '' for all. */
export interface CardManagerFilters {
  issuer: string;
  owner: CardOwner | '';
}

/** Dated first, then nothing recorded, then not read. */
const rank = (latest: string | null | undefined) => (typeof latest === 'string' ? 0 : latest === null ? 1 : 2);
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The cards Manage cards lists: every card account of the issuer and person chosen, oldest activity first (by the
 * latest day Holdr has of each), the cards with nothing recorded after those, and then any whose record is not read;
 * ties by name. `coverage` is /spending/coverage's answer, or null when it is not read (each card's latest is then
 * undefined, and the cards are by name).
 */
export function cardManagerRows(
  accounts: readonly CardAccount[],
  coverage: readonly CardAccountCoverage[] | null,
  filters: CardManagerFilters,
): CardManagerRow[] {
  const read = new Map((coverage ?? []).map((card) => [card.cardAccountId, card]));
  const names = new Map(accounts.map((account) => [account.id, cardNameLabel(account)]));
  return accounts
    .filter((account) => (filters.issuer === '' || account.issuer === filters.issuer) && (filters.owner === '' || account.owner === filters.owner))
    .map((account) => {
      const card = read.get(account.id);
      return { account, latest: card === undefined ? undefined : latestRecorded(card) };
    })
    .sort((a, b) => rank(a.latest) - rank(b.latest)
      || (typeof a.latest === 'string' && typeof b.latest === 'string' ? byText(a.latest, b.latest) : 0)
      || names.get(a.account.id)!.localeCompare(names.get(b.account.id)!)
      || byText(a.account.id, b.account.id));
}

/** The issuer filter's choices: each issuer of the cards once, by the name shown. */
export function issuerChoices(accounts: readonly CardAccount[]): Array<{ value: string; label: string }> {
  return [...new Set(accounts.map((account) => account.issuer))]
    .map((issuer) => ({ value: issuer, label: issuerLabel(issuer) }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
}

/** The person filter's choices: each person who has a card, in the app's order. */
export function ownerChoices(accounts: readonly CardAccount[]): Array<{ value: CardOwner; label: string }> {
  return OWNERS.filter((owner) => accounts.some((account) => account.owner === owner)).map((owner) => ({ value: owner, label: OWNER_LABELS[owner] }));
}

/** Above the list: how many cards it shows of all, and in what order. */
export function cardManagerCountText(shown: number, total: number, byActivity: boolean): string {
  const cards = `${total} ${total === 1 ? 'card' : 'cards'}`;
  return `${shown === total ? cards : `${shown} of ${cards}`}, ${byActivity ? 'oldest activity first' : 'by name'}`;
}

/** A card's status as Holdr keeps it: never a claim about the bank account. */
export function cardStatusText(status: CardAccount['status']): string {
  return status === 'closed' ? 'Closed in Holdr' : 'Active';
}

/** The confirmation of a status change for a card whose status is now `status`: its title, its lines and its button. */
export function statusConfirmation(status: CardAccount['status']): { title: string; lines: string[]; action: string } {
  return status === 'closed'
    ? { title: 'Reopen card in Holdr?', lines: ['This puts the card back in the active list.', REOPENING_DETAIL, STATUS_KEEPS], action: 'Reopen card' }
    : {
      title: 'Mark card closed in Holdr?',
      lines: [CLOSING_DETAIL, 'This hides the card in the Card picker by default; turn on Show closed cards to select it again.', STATUS_KEEPS],
      action: 'Mark closed',
    };
}

/**
 * The notice after a status change: what was changed, and that every transaction is retained. It says nothing of the
 * figures: they are read again on their own, and a read that fails says so where it is shown.
 */
export function statusChangedText(label: string, status: CardAccount['status']): string {
  return `${label} is ${status === 'closed' ? 'marked closed' : 'active again'}. All transactions are retained.`;
}
