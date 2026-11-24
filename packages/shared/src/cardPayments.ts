/**
 * Card payments and the brokerage cash they may have come from.
 *
 * A card payment is a transfer from the owner's other accounts, never
 * spending. When the money left a brokerage account Holdr tracks, that
 * account's activity has an outflow in `account_cash_events`. These
 * functions only suggest which outflows a payment may be: a withdrawal or
 * an outgoing transfer in the same currency, of exactly the payment's amount
 * in minor units, dated a few days around it, closest first. Equal numbers
 * in different currencies are never paired, and no float is compared or
 * rounded: a cash amount counts only when its decimal form is a whole number
 * of minor units.
 *
 * A suggestion changes nothing. No brokerage cash is created or deducted,
 * and cash history, holdings, NAV and returns stay as they are; the owner
 * judges. Pure and deterministic.
 */
import { currencyExponent } from './cardImportTool/amount.js';
import type { CardTransaction, CashEvent, CashEventType } from './types.js';

export const CARD_PAYMENT_SOURCE_RULES = {
  /**
   * Outflows dated up to this many days before the payment's date, or up to
   * this many after it: a debit settles a few business days from the day
   * the issuer credits the card, either way round, weekends included.
   */
  daysBefore: 5,
  daysAfter: 5,
  /** Suggestions listed per payment. */
  maxSuggestions: 3,
} as const;

/**
 * Cash event types money can leave a brokerage account by to pay a card.
 * Fees, taxes and sweeps never pay a card; deposits, dividends and interest
 * are money in.
 */
export const CARD_PAYMENT_SOURCE_EVENT_TYPES: readonly CashEventType[] = ['withdrawal', 'transfer'];

/** The card row fields a suggestion looks at. */
export type CardPaymentRow = Pick<CardTransaction, 'id' | 'transactionDate' | 'status' | 'amountMinor' | 'currency' | 'kind'>;

/** The cash event fields a suggestion looks at. */
export type CardPaymentCashEvent = Pick<CashEvent, 'id' | 'accountId' | 'date' | 'eventType' | 'amount' | 'currency'>;

/** A brokerage outflow a card payment may have come from. A suggestion only. */
export interface CardPaymentSourceSuggestion {
  cashEventId: string;
  /** The brokerage account the outflow left. */
  accountId: string;
  /** The outflow's date (YYYY-MM-DD). */
  date: string;
  eventType: CashEventType;
  /** The outflow in integer minor units of `currency`: negative, and equal to the payment's amount. */
  amountMinor: number;
  currency: string;
  /** Calendar days from the payment's date to the outflow's; negative when the outflow came first. */
  dayOffset: number;
}

/**
 * A suggested outflow as the card routes answer it: the brokerage account's
 * name instead of any id, and no account number. The name and the broker's
 * description are only shown when they cannot be carrying card data.
 */
export interface CardPaymentSourceView extends Omit<CardPaymentSourceSuggestion, 'cashEventId' | 'accountId'> {
  /** The brokerage account's name, or a neutral label. */
  accountName: string;
  description?: string;
}

const PLAIN_DECIMAL = /^(\d+)(?:\.(\d+))?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
/** Days since 1970-01-01 of the first and last YYYY-MM-DD dates. */
const FIRST_DAY = Date.parse('0000-01-01T00:00:00Z') / DAY_MS;
const LAST_DAY = Date.parse('9999-12-31T00:00:00Z') / DAY_MS;
const SOURCE_TYPES: ReadonlySet<string> = new Set(CARD_PAYMENT_SOURCE_EVENT_TYPES);

/**
 * A cash amount in major units (stored as a float, as broker activity is) as
 * integer minor units of `currency`. It is read from the number's shortest
 * decimal form, so nothing is scaled or rounded: null when that form has a
 * fraction of the minor unit, or the amount is not finite or not exact.
 */
export function cashAmountToMinor(amount: number, currency: string): number | null {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  // Exponent notation (below 1e-6, or 1e21 and up) is no amount a card is paid with.
  const match = PLAIN_DECIMAL.exec(String(Math.abs(amount)));
  if (!match) return null;
  const exponent = currencyExponent(currency);
  const fraction = match[2] ?? '';
  // The shortest form has no trailing zeros: any digit past the minor unit is a fraction of it.
  if (fraction.length > exponent) return null;
  const minor = Number(`${match[1]}${fraction.padEnd(exponent, '0')}`);
  if (!Number.isSafeInteger(minor)) return null;
  return amount < 0 ? -minor : minor;
}

/** Days since 1970-01-01 of a valid YYYY-MM-DD date, else null. */
function dayNumber(date: unknown): number | null {
  if (typeof date !== 'string' || !ISO_DATE.test(date)) return null;
  const time = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== date) return null;
  return time / DAY_MS;
}

/** A day number as YYYY-MM-DD, kept within years 0000 to 9999. */
function isoDay(day: number): string {
  return new Date(Math.min(LAST_DAY, Math.max(FIRST_DAY, day)) * DAY_MS).toISOString().slice(0, 10);
}

/**
 * True for a card row that may have been paid from brokerage cash: a card
 * payment of money to the card (negative), pending or posted. A positive
 * payment row (a returned payment) is money back, and a removed row is gone.
 */
export function isCardPaymentToCard(row: Pick<CardTransaction, 'kind' | 'status' | 'amountMinor'>): boolean {
  return row.kind === 'payment'
    && (row.status === 'posted' || row.status === 'pending')
    && Number.isSafeInteger(row.amountMinor)
    && row.amountMinor < 0;
}

/**
 * The dates (inclusive) whose cash events can be suggested for payments
 * dated from `first` to `last`; null for an invalid date or range.
 */
export function cardPaymentSourceWindow(first: string, last: string = first): { from: string; to: string } | null {
  const start = dayNumber(first);
  const end = dayNumber(last);
  if (start === null || end === null || start > end) return null;
  return { from: isoDay(start - CARD_PAYMENT_SOURCE_RULES.daysBefore), to: isoDay(end + CARD_PAYMENT_SOURCE_RULES.daysAfter) };
}

interface Outflow {
  event: CardPaymentCashEvent;
  day: number;
  amountMinor: number;
}

/** Withdrawals and outgoing transfers by currency and exact amount; everything else is left out. */
function indexOutflows(events: readonly CardPaymentCashEvent[]): Map<string, Outflow[]> {
  const index = new Map<string, Outflow[]>();
  for (const event of events) {
    if (!event || !SOURCE_TYPES.has(event.eventType) || typeof event.currency !== 'string') continue;
    const amountMinor = cashAmountToMinor(event.amount, event.currency);
    const day = dayNumber(event.date);
    if (amountMinor === null || amountMinor >= 0 || day === null) continue;
    const key = JSON.stringify([event.currency, amountMinor]);
    const list = index.get(key);
    if (list) list.push({ event, day, amountMinor });
    else index.set(key, [{ event, day, amountMinor }]);
  }
  return index;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Closest first; then the earlier outflow; then by account and event id, so the order never depends on input order. */
function bySuggestionOrder(a: CardPaymentSourceSuggestion, b: CardPaymentSourceSuggestion): number {
  return Math.abs(a.dayOffset) - Math.abs(b.dayOffset)
    || a.dayOffset - b.dayOffset
    || compareText(a.accountId, b.accountId)
    || compareText(a.cashEventId, b.cashEventId);
}

function candidates(payment: CardPaymentRow, index: Map<string, Outflow[]>): CardPaymentSourceSuggestion[] {
  if (!isCardPaymentToCard(payment)) return [];
  const paymentDay = dayNumber(payment.transactionDate);
  if (paymentDay === null) return [];
  const outflows = index.get(JSON.stringify([payment.currency, payment.amountMinor])) ?? [];
  const found: CardPaymentSourceSuggestion[] = [];
  for (const outflow of outflows) {
    const dayOffset = outflow.day - paymentDay;
    if (dayOffset < -CARD_PAYMENT_SOURCE_RULES.daysBefore || dayOffset > CARD_PAYMENT_SOURCE_RULES.daysAfter) continue;
    found.push({
      cashEventId: outflow.event.id,
      accountId: outflow.event.accountId,
      date: outflow.event.date,
      eventType: outflow.event.eventType,
      amountMinor: outflow.amountMinor,
      currency: outflow.event.currency,
      dayOffset,
    });
  }
  return found.sort(bySuggestionOrder);
}

/**
 * The brokerage outflows `payment` may have come from: withdrawals and
 * outgoing transfers in its currency, of exactly its amount, dated from
 * `daysBefore` days before it to `daysAfter` days after it; closest first,
 * at most `limit`. Empty for anything but a payment to the card.
 */
export function suggestCardPaymentSources(
  payment: CardPaymentRow,
  events: readonly CardPaymentCashEvent[],
  limit: number = CARD_PAYMENT_SOURCE_RULES.maxSuggestions,
): CardPaymentSourceSuggestion[] {
  return candidates(payment, indexOutflows(events)).slice(0, Math.max(0, limit));
}

export interface CardPaymentSourceCount {
  currency: string;
  /** Payments that look paid from one of the outflows, each from a different one. */
  count: number;
}

/**
 * Per currency (each with at least one payment to the card in `payments`),
 * how many of those payments look paid from one of `events`, each from a
 * different outflow: the largest number of payments that can be paired
 * one-to-one with suggested outflows, so two payments of the same amount
 * never both count one withdrawal. A summary of suggestions; it links nothing.
 */
export function countCardPaymentSources(
  payments: readonly CardPaymentRow[],
  events: readonly CardPaymentCashEvent[],
): CardPaymentSourceCount[] {
  const index = indexOutflows(events);
  const counts = new Map<string, number>();
  const options: string[][] = [];
  const currencies: string[] = [];
  for (const payment of payments) {
    if (!isCardPaymentToCard(payment)) continue;
    if (!counts.has(payment.currency)) counts.set(payment.currency, 0);
    currencies.push(payment.currency);
    options.push(candidates(payment, index).map((item) => JSON.stringify([item.accountId, item.cashEventId])));
  }
  // Maximum bipartite matching by augmenting paths. A path only runs through
  // payments of one currency and amount, so it stays short.
  const holder = new Map<string, number>();
  const assign = (payment: number, seen: Set<string>): boolean => {
    for (const outflow of options[payment]) {
      if (seen.has(outflow)) continue;
      seen.add(outflow);
      const current = holder.get(outflow);
      if (current === undefined || assign(current, seen)) {
        holder.set(outflow, payment);
        return true;
      }
    }
    return false;
  };
  options.forEach((_options, payment) => {
    if (assign(payment, new Set())) counts.set(currencies[payment], (counts.get(currencies[payment]) ?? 0) + 1);
  });
  return [...counts.entries()]
    .sort((a, b) => compareText(a[0], b[0]))
    .map(([currency, count]) => ({ currency, count }));
}
