/**
 * Discover card statement PDF (a Discover it card's monthly statement, downloaded from the issuer's website), read from
 * the positioned text pdf.js gives the statement converter (apps/api cli/cardStatementConvert.ts). Discover offers these
 * accounts no transaction export, so their statements are the only record of their history.
 *
 * Three layouts are read, named by the year each was first seen:
 * - A (2019): `Open Date: Sep 06, 2019 - Close Date: Oct 05, 2019`; an ACCOUNT SUMMARY whose operators (`-` before
 *   Payments and Credits, `+` before each charge) are items of their own, a little above their line; and transactions
 *   grouped under a category (`Payments and Credits`, or a merchant category for purchases), each row a transaction
 *   and a post date (`Oct 02`), a description, a `$` and the amount (`-12.34` for a credit).
 * - B (2020 to 2025): `OPEN TO CLOSE DATE: 01/06/2021 - 02/05/2021`; an Account Summary with signed amounts
 *   (`-$12.34`, `+$0.00`); and transactions under the column headings `DATE PAYMENTS AND CREDITS AMOUNT` and
 *   `DATE PURCHASES MERCHANT CATEGORY AMOUNT`, each row a transaction date (`01/12`), a description, a purchase's
 *   merchant category, and the amount right-aligned under AMOUNT. The Cashback Bonus box stands to their right.
 * - C (2026): as B, but its summary names purchases `Transactions`, prints no Balance Transfers line and sets each
 *   sign apart from the dollar sign (`+ $0.00`).
 * Each column is read on its own (the Account Summary left of Payment Information, the transactions left of the
 * Cashback Bonus box), so a figure beside it never joins one of its lines.
 *
 * Nothing is taken on trust. A statement is refused, naming what failed and never a value, unless:
 * - every printing of the card's last four digits agrees, and so does every printing of the statement period, whose
 *   length is the `Billing Period: N days` the statement prints (each printing read, however many share a line, and a
 *   period wording in any case counted);
 * - its Account Summary is read whole: each line one label and one amount, each operator where it belongs, so no sign
 *   is ever guessed (a credit balance is `-$`); and a summary figure printed again (wherever its label stands in a
 *   line: on page 1 anywhere outside the Account Summary, beside its label or under it as a column heading; on a later
 *   page, but for the Interest Charge Calculation's rows) is the summary's own figure, its sign too when it prints one;
 * - every line of the transactions, from their heading to the Interest Charge Calculation, is a heading, a row, a total,
 *   or a line without a date or an amount: prose, or a description or category wrapped under a row (a wrapped line
 *   with a date or an amount is refused, never joined to a row's text). A row must stand in the columns its heading
 *   prints, and only its date and amount columns may hold a date or an amount. Beside the transactions, in the
 *   Cashback Bonus column, and anywhere else in the statement, a line with a transaction date and an amount refuses
 *   it, so a row is never passed over;
 * - the rows add up to the summary: payments and credits to Payments and Credits, purchases to Purchases, and
 *   Previous Balance - Payments and Credits + Purchases + Balance Transfers + Cash Advances + Fees Charged + Interest
 *   Charged is the New Balance, to the cent. A statement that prints no rows must say NO ACTIVITY FOR THIS BILLING
 *   PERIOD, and one that says so must print none;
 * - no two rows are the same (date, amount, description and category): two identical charges cannot be told from one
 *   row printed twice, whatever the totals say.
 * Fees, interest, balance transfers and cash advances are refused when not zero: no statement of these cards charged
 * any, so their rows' layout is unknown. So is a list of transactions that runs onto another page.
 *
 * Row dates: B and C print a transaction date only, A a transaction and a post date. A post date must fall in the
 * period; a transaction date may be up to 90 days before it (a charge that posted later), never after. The year
 * comes from the period.
 */
import { isCardImportDate } from '../cardImport.js';
import { parseAmount } from './amount.js';
import type { StatementPdfPage, StatementPdfTextItem } from './parsed.js';
import { dateOfDay, dayNumber } from './statementDates.js';

export const DISCOVER_STATEMENT_SOURCE = 'discover-statement';
export const DISCOVER_ISSUER = 'discover';

export type DiscoverLayout = 'A' | 'B' | 'C';

/** Why a statement was refused, for the converter's counts: messages say more, never a value. */
export type DiscoverRefusalReason = 'not-a-statement' | 'layout' | 'sign' | 'reconciliation' | 'unsupported' | 'duplicate';

export class DiscoverStatementError extends Error {
  readonly reason: DiscoverRefusalReason;
  /**
   * The card and the period, when the statement was refused after reading both (the period checked against its own
   * billing-period length): a refused statement still says which days it speaks for, so it bounds the others' periods.
   */
  read?: { last4: string; period: { start: string; end: string } };
  constructor(reason: DiscoverRefusalReason, message: string) {
    super(message);
    this.name = 'DiscoverStatementError';
    this.reason = reason;
  }
}

function refuse(reason: DiscoverRefusalReason, message: string): never {
  throw new DiscoverStatementError(reason, message);
}

/** The figures of the Account Summary, in minor units: balances owed-positive, the rest as amounts added or taken off. */
export interface DiscoverSummary {
  previousBalanceMinor: number;
  /** Taken off the balance. */
  paymentsAndCreditsMinor: number;
  /** Layout C's `Transactions`. */
  purchasesMinor: number;
  /** Zero in layout C, which prints no such line. */
  balanceTransfersMinor: number;
  cashAdvancesMinor: number;
  feesMinor: number;
  interestMinor: number;
  newBalanceMinor: number;
}

export interface DiscoverStatementRow {
  /** Where the row is printed, for messages. */
  page: number;
  line: number;
  /** The heading or category the statement prints the row under. */
  section: 'credits' | 'purchases';
  transactionDate: string;
  /** Layout A only; B and C print none. */
  postedDate: string | null;
  /** Holdr sign: positive = money spent, so credits are negative. */
  amountMinor: number;
  /** Raw: wrapped lines joined with a space. Redacted by the payload builder. */
  description: string;
  /** The merchant category a purchase is printed with, raw; null for credits. */
  category: string | null;
  /** Every raw text the row was read from, for the converter's leak checks only. */
  sourceTexts: string[];
}

export interface ParsedDiscoverStatement {
  layout: DiscoverLayout;
  last4: string;
  period: { start: string; end: string };
  /** The `Billing Period: N days` the statement prints, equal to the period's length. */
  billingDays: number;
  summary: DiscoverSummary;
  /** The statement says NO ACTIVITY FOR THIS BILLING PERIOD (and so has no rows). */
  noActivity: boolean;
  rows: DiscoverStatementRow[];
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

/** One line of a page (or of one column of it): items on the same baseline, left to right. */
export interface DiscoverLine {
  /** 1-based page number. */
  page: number;
  /** 1-based line number on its page (or in its column), for messages. */
  number: number;
  y: number;
  items: StatementPdfTextItem[];
  /** The items' text, whitespace collapsed, a space where they stand apart. */
  text: string;
}

/** Items closer than this (in PDF points) to a line's baseline belong to it. */
const BASELINE_TOLERANCE = 2;
/** A gap wider than this between two items is a space. */
const WORD_GAP = 1;
/** A row's piece starts within this distance of its column heading, or of the column its row started. */
const COLUMN_TOLERANCE = 4;
/** A right-aligned amount ends within this distance of its column heading's right edge. */
const AMOUNT_ALIGN = 4;
/** How far before the period a transaction date may be: a charge that posted later. */
const EARLIEST_TRANSACTION_DAYS = 90;

const at = (line: Pick<DiscoverLine, 'page' | 'number'>) => `page ${line.page} line ${line.number}`;

function joined(items: readonly StatementPdfTextItem[]): string {
  return itemSpans(items).text;
}

/** A line's text from its items, as `joined` writes it, and each printing item's place in it (`from` to `to`). */
function itemSpans(items: readonly StatementPdfTextItem[]): { text: string; spans: Array<{ item: StatementPdfTextItem; from: number; to: number }> } {
  let text = '';
  let end: number | null = null;
  let spaceAfter = false;
  const spans: Array<{ item: StatementPdfTextItem; from: number; to: number }> = [];
  for (const item of items) {
    const piece = item.text.replace(/\s+/g, ' ').trim();
    if (piece === '') continue;
    const apart = end !== null && item.x - end > WORD_GAP;
    if (text !== '' && (apart || spaceAfter || /^\s/.test(item.text))) text += ' ';
    spans.push({ item, from: text.length, to: text.length + piece.length });
    text += piece;
    end = item.x + Math.max(0, item.width);
    spaceAfter = /\s$/.test(item.text);
  }
  return { text, spans };
}

/** One page's items (or a column's) grouped into lines, top to bottom, each line's items left to right. */
function groupLines(items: readonly StatementPdfTextItem[], page: number): DiscoverLine[] {
  const sorted = items
    .filter((item) => typeof item.text === 'string' && item.text.trim() !== '' && [item.x, item.y, item.width].every(Number.isFinite))
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const grouped: Array<{ y: number; items: StatementPdfTextItem[] }> = [];
  for (const item of sorted) {
    const line = grouped.find((candidate) => Math.abs(candidate.y - item.y) <= BASELINE_TOLERANCE);
    if (line) line.items.push(item);
    else grouped.push({ y: item.y, items: [item] });
  }
  grouped.sort((a, b) => b.y - a.y);
  return grouped.map((line, index) => {
    line.items.sort((a, b) => a.x - b.x);
    return { page, number: index + 1, y: line.y, items: line.items, text: joined(line.items) };
  });
}

/** Every page's lines, the page's whole width. */
export function discoverStatementLines(pages: readonly StatementPdfPage[]): DiscoverLine[] {
  return pages.flatMap((page, index) => groupLines(page.items, index + 1));
}

/** The lines of one column of a page: its items left of `split` only, grouped on their own. */
function columnLines(pages: readonly StatementPdfPage[], page: number, split: number): DiscoverLine[] {
  return groupLines(pages[page - 1].items.filter((item) => item.x < split), page);
}

/** The lines of the column right of `split` on a page, grouped on their own. */
function columnsRightOf(pages: readonly StatementPdfPage[], page: number, split: number): DiscoverLine[] {
  return groupLines(pages[page - 1].items.filter((item) => item.x >= split), page);
}

const right = (item: StatementPdfTextItem) => item.x + Math.max(0, item.width);
const near = (x: number, column: number) => Math.abs(x - column) <= COLUMN_TOLERANCE;

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

const NUMBER = String.raw`[0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2}`;
const SIGN = String.raw`[-+\u2212\u2013]`;
/** `$1,234.56`, `-$1,234.56`, `+$0.00`, `+ $0.00`: an optional sign, a dollar sign, then the amount. */
const DOLLAR_AMOUNT = new RegExp(String.raw`^(${SIGN})?\s?\$\s?(${NUMBER})$`);
/** Layout A's row amounts, after their own `$` item: `12.34`, `-12.34`. */
const BARE_AMOUNT = new RegExp(String.raw`^(${SIGN})?(${NUMBER})$`);
/** A total, with or without its dollar sign (layout A prints that apart), never signed. */
const TOTAL_AMOUNT = new RegExp(String.raw`^\$?\s?(${NUMBER})$`);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const MONTH = String.raw`(?:${MONTHS.join('|')})`;
const CALENDAR_MM_DD = String.raw`(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12][0-9]|3[01])`;
/**
 * A transaction date as a row prints one, `01/12` or `Oct 02`, standing alone: a date with its year (`05/25/2021`,
 * `May 25, 2021`) is no row's.
 */
const DATE_TOKEN = new RegExp(String.raw`(?:^|\s)(?:${CALENDAR_MM_DD}|${MONTH}\s+[0-9]{1,2})(?=\s|$)`);
const CENTS = /[0-9]\.[0-9]{2}/;
/** A `$` and a digit, with at most signs or an opening parenthesis between them. */
const DOLLAR = /\$[-\u2212\u2013+(]*[0-9]/;
const compact = (text: string) => text.replace(/\s+/g, '');
/** A line that carries a date or an amount, as a row would: read whole or refused, never passed over. */
const carriesFigure = (text: string) => DATE_TOKEN.test(text) || CENTS.test(compact(text)) || DOLLAR.test(compact(text));
/** A line with a transaction date and an amount, wherever it stands: a row, or something that would pass for one. */
const transactionShaped = (text: string) => DATE_TOKEN.test(text) && (CENTS.test(compact(text)) || DOLLAR.test(compact(text)));

interface Money {
  sign: '+' | '-' | null;
  minor: number;
}

function minorOf(number: string): number {
  const read = parseAmount(number, 2, { thousands: true });
  if (!read.ok) refuse('layout', 'an amount could not be read');
  return read.minor;
}

function money(text: string, pattern: RegExp): Money | null {
  const match = pattern.exec(text.trim());
  if (!match) return null;
  const sign = match[1] === undefined ? null : match[1] === '+' ? '+' : '-';
  return { sign, minor: minorOf(match[2]) };
}

function totalOf(text: string): number | null {
  const match = TOTAL_AMOUNT.exec(text.trim());
  return match ? minorOf(match[1]) : null;
}

/** A YYYY-MM-DD from a year and a month and day, or null when that is no date. */
function isoDate(year: number, month: number, day: number): string | null {
  const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isCardImportDate(date) ? date : null;
}

function monthNumber(name: string): number {
  return MONTHS.indexOf(name.slice(0, 3) as (typeof MONTHS)[number]) + 1;
}

/** The date in the year of `to` or the year before that falls in [from, to], or null. */
function dateWithin(month: number, day: number, from: string, to: string): string | null {
  const endYear = Number(to.slice(0, 4));
  for (const year of [endYear, endYear - 1]) {
    const date = isoDate(year, month, day);
    if (date !== null && date >= from && date <= to) return date;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Identity and period
// ---------------------------------------------------------------------------

/**
 * Every match of `pattern` in `text`: a line is read for every printing it holds, never only its first. The patterns
 * themselves stay non-global, so no `test` or `exec` elsewhere ever carries a `lastIndex` over.
 */
const every = (pattern: RegExp, text: string) => [...text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))];

/**
 * Where a statement names its card, each read whole: the four digits and nothing stuck to them. pdf.js may set the
 * pieces of a printing a fraction of a point apart (`ENDING` `IN` `1234` read as `ENDINGIN1234`), so the spaces
 * between them are optional.
 */
const CARD_PRINTINGS: readonly RegExp[] = [
  /(?:^|\s)Account number ending in\s*([0-9]{4})(?=\s|$)/,
  /(?:^|\s)DISCOVER IT\s*CARD\s*ENDING\s*IN\s*([0-9]{4})(?=\s|$)/,
  /(?:^|\s)Discover it\s*Card\s*ending\s*in\s*([0-9]{4})(?=\s|$)/,
  /(?:^|\s)ACCOUNT NUMBER ENDING IN\s*([0-9]{4})(?=\s|$)/,
  /(?:^|\s)Account ending in\s*([0-9]{4})(?=\s|$)/,
];
/**
 * Any wording that names a card's ending (a word of its own: "pending in" is none): each occurrence on a line must be
 * one of CARD_PRINTINGS.
 */
const CARD_LABEL = /\bending\s*in/i;
/** The issuer naming its card: Discover it Card (A, C), DISCOVER IT CARD ENDING IN (B). */
const DISCOVER_CARD = /(?:^|\s)(?:Discover it\s+Card|DISCOVER IT\s*CARD)(?=\s|$)/;

const LONG_DATE = String.raw`(${MONTH})[a-z]*\.?\s+([0-9]{1,2}),\s*([0-9]{4})`;
/** Layout A: `Open Date: Sep 06, 2019 - Close Date: Oct 05, 2019`, on one line, its pieces apart or not. */
const OPEN_CLOSE = new RegExp(String.raw`(?:^|\s)Open Date:\s*${LONG_DATE}\s*-?\s*Close Date:\s*${LONG_DATE}(?=\s|$)`);
/** Layouts B and C: `OPEN TO CLOSE DATE: 01/06/2021 - 02/05/2021`. */
const OPEN_TO_CLOSE = /(?:^|\s)OPEN TO CLOSE DATE:\s*([0-9]{2})\/([0-9]{2})\/([0-9]{4})\s*-\s*([0-9]{2})\/([0-9]{2})\/([0-9]{4})(?=\s|$)/;
/** Layouts B and C print the period in the Account Summary's heading too. */
const SUMMARY_PERIOD = /^Account Summary\s+([0-9]{2})\/([0-9]{2})\/([0-9]{4})\s*-\s*([0-9]{2})\/([0-9]{2})\/([0-9]{4})$/;
/**
 * A period label (with its colon: prose such as "credits posted after the Close Date." is no printing of it), in any
 * case: a wording in an unexpected case is still counted, and refused unless a printing reads it whole.
 */
const PERIOD_WORDING = /(?:Open Date|Close Date|OPEN TO CLOSE DATE)\s*:/i;
const BILLING_DAYS = /\bBILLING PERIOD:\s*([0-9]{1,3})\s+DAYS\b/i;
const BILLING_WORDING = /\bBILLING PERIOD:/i;

function cardLast4(lines: readonly DiscoverLine[]): string {
  const printed = new Set<string>();
  for (const line of lines) {
    const labels = every(CARD_LABEL, line.text).length;
    if (labels === 0) continue;
    const found = CARD_PRINTINGS.flatMap((pattern) => every(pattern, line.text).map((match) => match[1]));
    // Every wording that names an ending must be one of the known printings, read whole: never cut back to a prefix, and
    // never passed over for another printing on the same line.
    if (found.length !== labels) refuse('layout', `${at(line)}: a printing of the card's ending is not its last four digits alone`);
    for (const digits of found) printed.add(digits);
  }
  if (printed.size === 0) refuse('layout', 'the statement does not print its card\'s last four digits');
  if (printed.size > 1) refuse('layout', 'the statement prints two different card endings; one card per statement is supported');
  return [...printed][0];
}

interface Period {
  start: string;
  end: string;
  form: 'month-name' | 'numeric';
}

/** Every printing of the period: on the page headers, and in the Account Summary's heading (`summary`, page 1's left column). */
function statementPeriod(lines: readonly DiscoverLine[], summary: readonly DiscoverLine[]): Period {
  const found = new Map<string, Period>();
  const add = (line: DiscoverLine, start: string | null, end: string | null, form: Period['form']) => {
    if (start === null || end === null || start > end) refuse('layout', `${at(line)}: the statement period is not a valid date range`);
    found.set(`${start}..${end}..${form}`, { start, end, form });
  };
  for (const line of lines) {
    const long = every(OPEN_CLOSE, line.text);
    const numeric = every(OPEN_TO_CLOSE, line.text);
    // Every period wording on a line (two in layout A's printing, one in B's and C's) must belong to a printing read
    // whole: none is ever passed over for another on the same line.
    if (every(PERIOD_WORDING, line.text).length !== 2 * long.length + numeric.length) {
      refuse('layout', `${at(line)}: the statement period is not printed as two whole dates`);
    }
    for (const match of long) {
      add(line, isoDate(Number(match[3]), monthNumber(match[1]), Number(match[2])), isoDate(Number(match[6]), monthNumber(match[4]), Number(match[5])), 'month-name');
    }
    for (const match of numeric) add(line, isoDate(Number(match[3]), Number(match[1]), Number(match[2])), isoDate(Number(match[6]), Number(match[4]), Number(match[5])), 'numeric');
  }
  for (const line of summary) {
    const match = SUMMARY_PERIOD.exec(line.text);
    if (match) add(line, isoDate(Number(match[3]), Number(match[1]), Number(match[2])), isoDate(Number(match[6]), Number(match[4]), Number(match[5])), 'numeric');
  }
  const periods = [...found.values()];
  if (periods.length === 0) refuse('not-a-statement', 'this does not look like a Discover statement: it prints no Open and Close Date');
  if (new Set(periods.map((period) => `${period.start}..${period.end}`)).size > 1) {
    refuse('layout', 'the statement prints two different periods; download each statement on its own');
  }
  if (periods.length > 1) refuse('layout', 'the statement prints its period in two layouts');
  return periods[0];
}

function billingDays(lines: readonly DiscoverLine[], period: Period): number {
  const days = new Set<number>();
  for (const line of lines) {
    const wordings = every(BILLING_WORDING, line.text).length;
    if (wordings === 0) continue;
    const found = every(BILLING_DAYS, line.text);
    if (found.length !== wordings) refuse('layout', `${at(line)}: the billing period is not a whole number of days`);
    for (const match of found) days.add(Number(match[1]));
  }
  if (days.size === 0) refuse('layout', 'the statement does not print its billing period\'s length');
  if (days.size > 1) refuse('layout', 'the statement prints two different billing period lengths');
  const [printed] = [...days];
  if (printed !== dayNumber(period.end) - dayNumber(period.start) + 1) {
    refuse('layout', 'the billing period\'s length is not the number of days from the Open to the Close Date; the period was misread');
  }
  return printed;
}

// ---------------------------------------------------------------------------
// Account Summary
// ---------------------------------------------------------------------------

type SummaryKey = keyof DiscoverSummary;

/** The summary's labels: a Map, so no other text (`constructor`, say) can ever look one up. */
const SUMMARY_LABELS: ReadonlyMap<string, SummaryKey> = new Map([
  ['Previous Balance', 'previousBalanceMinor'],
  ['Payments and Credits', 'paymentsAndCreditsMinor'],
  ['Purchases', 'purchasesMinor'],
  ['Transactions', 'purchasesMinor'],
  ['Balance Transfers', 'balanceTransfersMinor'],
  ['Cash Advances', 'cashAdvancesMinor'],
  ['Fees Charged', 'feesMinor'],
  ['Interest Charged', 'interestMinor'],
  ['New Balance', 'newBalanceMinor'],
  ['New Balance:', 'newBalanceMinor'],
]);
const SUMMARY_NAMES: Readonly<Record<SummaryKey, string>> = {
  previousBalanceMinor: 'Previous Balance',
  paymentsAndCreditsMinor: 'Payments and Credits',
  purchasesMinor: 'Purchases',
  balanceTransfersMinor: 'Balance Transfers',
  cashAdvancesMinor: 'Cash Advances',
  feesMinor: 'Fees Charged',
  interestMinor: 'Interest Charged',
  newBalanceMinor: 'New Balance',
};
const BALANCES: ReadonlySet<SummaryKey> = new Set(['previousBalanceMinor', 'newBalanceMinor']);
/** Layout A's operators, items of their own a little above the line they belong to. */
const OPERATOR = /^[-+\u2212\u2013]$/;
/** How far above its label's baseline layout A prints an operator. */
const OPERATOR_RISE = 4;

interface SummaryRead {
  summary: DiscoverSummary;
  /** Which label the summary gives purchases (layout C: Transactions). */
  purchasesLabel: 'Purchases' | 'Transactions';
  hasBalanceTransfers: boolean;
  /** The summary column's lines before its heading and after its New Balance: where a figure printed again is checked. */
  before: DiscoverLine[];
  after: DiscoverLine[];
}

/** The Payment Information column's left edge on the first page: the Account Summary is everything left of it. */
function summarySplit(pages: readonly StatementPdfPage[]): number {
  const heading = pages[0].items.find((item) => /^payment information$/i.test(item.text.trim()));
  if (!heading) refuse('layout', 'the first page has no Payment Information column, so its Account Summary cannot be told apart');
  return heading.x - 8;
}

/**
 * The Account Summary, from its heading to its New Balance, page 1's left column: every line one label and one
 * amount (layout A: and the operator items that sign it), each label once.
 */
function readSummary(column: readonly DiscoverLine[], operatorItems: readonly StatementPdfTextItem[], form: Period['form']): SummaryRead {
  const start = column.findIndex((line) => /^account summary\b/i.test(line.text));
  if (start === -1) refuse('layout', 'the first page has no Account Summary');
  const read = new Map<SummaryKey, number>();
  let purchasesLabel: SummaryRead['purchasesLabel'] | null = null;
  let end = -1;
  for (let index = start + 1; index < column.length && end === -1; index += 1) {
    const line = column[index];
    if (form === 'month-name' && OPERATOR.test(line.text)) continue;
    const [labelItem, ...rest] = line.items;
    const label = labelItem.text.trim();
    const key = SUMMARY_LABELS.get(label);
    // Layout A's operators may join their label's line; they are read from where they stand, below.
    const amountItems = form === 'month-name' ? rest.filter((item) => !OPERATOR.test(item.text.trim())) : rest;
    if (key === undefined || amountItems.length === 0) refuse('layout', `${at(line)}: an Account Summary line this reader does not know`);
    if (read.has(key)) refuse('layout', `${at(line)}: the Account Summary prints ${SUMMARY_NAMES[key]} twice`);
    if (key === 'purchasesMinor') purchasesLabel = label as SummaryRead['purchasesLabel'];
    const amount = money(joined(amountItems), DOLLAR_AMOUNT);
    if (!amount) refuse('layout', `${at(line)}: the Account Summary's ${SUMMARY_NAMES[key]} is not one whole amount`);
    let sign = amount.sign;
    if (form === 'month-name') {
      const operators = operatorItems.filter((item) => item.x > right(labelItem) && item.x < amountItems[0].x
        && item.y - labelItem.y >= -1 && item.y - labelItem.y <= OPERATOR_RISE);
      if (BALANCES.has(key)) {
        if (operators.length > 0) refuse('sign', `${at(line)}: the Account Summary prints an operator beside ${SUMMARY_NAMES[key]}`);
      } else {
        if (operators.length !== 1 || amount.sign !== null) {
          refuse('sign', `${at(line)}: the Account Summary's ${SUMMARY_NAMES[key]} does not have exactly one sign`);
        }
        sign = operators[0].text.trim() === '+' ? '+' : '-';
      }
    }
    read.set(key, signedSummaryFigure(key, sign, amount.minor, line));
    if (key === 'newBalanceMinor') end = index;
  }
  if (end === -1) refuse('layout', 'the Account Summary has no New Balance');
  const hasBalanceTransfers = read.has('balanceTransfersMinor');
  const wanted: SummaryKey[] = ['previousBalanceMinor', 'paymentsAndCreditsMinor', 'purchasesMinor', 'cashAdvancesMinor', 'feesMinor', 'interestMinor',
    'newBalanceMinor', ...(purchasesLabel === 'Transactions' ? [] : ['balanceTransfersMinor' as const])];
  const missing = wanted.find((key) => !read.has(key));
  if (missing) refuse('layout', `the Account Summary has no ${SUMMARY_NAMES[missing]} line`);
  if (purchasesLabel === 'Transactions' && hasBalanceTransfers) refuse('layout', 'the Account Summary mixes two layouts\' labels');
  const figure = (key: SummaryKey) => read.get(key) ?? 0;
  return {
    summary: {
      previousBalanceMinor: figure('previousBalanceMinor'),
      paymentsAndCreditsMinor: figure('paymentsAndCreditsMinor'),
      purchasesMinor: figure('purchasesMinor'),
      balanceTransfersMinor: figure('balanceTransfersMinor'),
      cashAdvancesMinor: figure('cashAdvancesMinor'),
      feesMinor: figure('feesMinor'),
      interestMinor: figure('interestMinor'),
      newBalanceMinor: figure('newBalanceMinor'),
    },
    purchasesLabel: purchasesLabel ?? 'Purchases',
    hasBalanceTransfers,
    before: column.slice(0, start),
    after: column.slice(end + 1),
  };
}

/** A figure printed again: an optional sign and dollar sign, then the amount (`35.50`, `- 12.34`, `+$999.99`). */
const REPEATED_AMOUNT = new RegExp(String.raw`^(${SIGN})?\s?\$?\s?(${NUMBER})$`);
/** How far below a label printed as a column heading its figure may stand (the Payment Information box, the coupon). */
const HEADING_DEPTH = 20;
/** The summary's labels as words of a line's text, however its items were cut. */
const SUMMARY_LABEL_WORDS = 'Previous Balance|Payments and Credits|Purchases|Transactions|Balance Transfers|Cash Advances|Fees Charged|Interest Charged|New Balance';
/**
 * A summary label standing in a line, with or without its colon: a word of its own, so no letter on either side, but
 * anything else may touch it (items set with no gap join with no space: `Purchases+$999.99`).
 */
const SUMMARY_LABEL_TEXT = new RegExp(String.raw`(?<![A-Za-z])(${SUMMARY_LABEL_WORDS}):?(?![A-Za-z])`);

/** A summary label printed in a line: which figure it names, the text after it (to the next label), and where it stands. */
interface LabelPrinting {
  key: SummaryKey;
  rest: string;
  left: number;
  right: number;
  /** Where the text after it ends. */
  end: number;
}

/**
 * Every summary label in a line's text, a word of its own, whether its item holds it alone or with more (`Purchases
 * +$999.99` as one item): each with the text that follows it up to the next label, and its left and right edges,
 * placed within its items by their share of the text.
 */
function labelPrintings(line: DiscoverLine): LabelPrinting[] {
  const { text, spans } = itemSpans(line.items);
  const xAt = (offset: number) => {
    const span = spans.find((candidate) => offset >= candidate.from && offset <= candidate.to) ?? spans[spans.length - 1];
    return span.item.x + ((offset - span.from) / Math.max(1, span.to - span.from)) * Math.max(0, span.item.width);
  };
  const found = every(SUMMARY_LABEL_TEXT, text);
  return found.map((match, index) => {
    const from = match.index!;
    const to = from + match[0].length;
    const next = found[index + 1]?.index ?? text.length;
    return {
      key: SUMMARY_LABELS.get(match[1])!,
      rest: text.slice(to, next).trim(),
      left: xAt(from),
      right: xAt(to),
      end: xAt(next),
    };
  });
}

/**
 * A summary figure printed again must be the figure the Account Summary states, so the statement is never read with
 * one of two figures passed over. A printing with a sign must make the summary's own signed figure by the summary's
 * rules (a balance owed is unsigned, a credit balance `-`; Payments and Credits `-`; a charge never `-`); one without
 * a sign (the payment coupon prints balances so) must print its amount. Wherever a summary label stands in a line,
 * a word of its own, the text after it (to the next label) is read:
 * - Page 1, everywhere but the Account Summary itself (its column above and below it, and the Payment Information
 *   column): text after a label that holds a date or an amount must be one whole amount, the summary's. A label with
 *   no figure after it heads a table (layouts B and C print the New Balance under its label, layout C's coupon too):
 *   the first line below it, within HEADING_DEPTH points, that prints more than a `$` under the label must print there
 *   one whole amount, the summary's.
 * - Every later page (`laterPages`): text after a label that holds a date or an amount must be one whole amount, the
 *   summary's.
 * - The transactions and the Interest Charge Calculation's rows (`tables`), where a row may start with a summary
 *   label (`Purchases 19.24% (v) $0.00 $0.00`, layout A's `Payments and Credits` heading its rows): only a label
 *   followed by one whole amount is a printing of the figure, and is compared.
 */
function checkRepeatedFigures(pages: readonly StatementPdfPage[], summary: DiscoverSummary, firstPage: ReadonlyArray<readonly DiscoverLine[]>,
  laterPages: readonly DiscoverLine[], tables: readonly DiscoverLine[]): void {
  // An operator set apart from the line, as layout A signs its summary, beside a figure printed again: its sign
  // cannot be read, so the statement is refused rather than the figure read unsigned.
  const floating = (line: DiscoverLine, from: number, to: number) => pages[line.page - 1].items.some((item) => OPERATOR.test(item.text.trim())
    && !line.items.includes(item) && Math.abs(item.y - line.y) <= OPERATOR_RISE && item.x >= from - COLUMN_TOLERANCE && item.x <= to + COLUMN_TOLERANCE);
  const compare = (line: DiscoverLine, key: SummaryKey, text: string, strict: boolean, from: number, to: number) => {
    const amount = money(text, REPEATED_AMOUNT);
    if (!amount) {
      if (strict) refuse('layout', `${at(line)}: a line names ${SUMMARY_NAMES[key]} with a date or an amount that is not one whole amount`);
      return;
    }
    if (floating(line, from, to)) refuse('sign', `${at(line)}: an operator set apart beside ${SUMMARY_NAMES[key]} printed again leaves its sign unread`);
    const same = amount.sign === null ? amount.minor === Math.abs(summary[key]) : signedSummaryFigure(key, amount.sign, amount.minor, line) === summary[key];
    if (!same) refuse('layout', `${at(line)}: the statement prints ${SUMMARY_NAMES[key]} again with another amount or sign`);
  };
  const read = (line: DiscoverLine, strict: boolean) => {
    const printings = labelPrintings(line);
    for (const printing of printings) {
      if (carriesFigure(printing.rest)) compare(line, printing.key, printing.rest, strict, printing.right, printing.end);
    }
    return printings.filter((printing) => !carriesFigure(printing.rest));
  };
  for (const column of firstPage) {
    column.forEach((line, index) => {
      for (const heading of read(line, true)) {
        const under = (item: StatementPdfTextItem) => item.x < heading.right && right(item) > heading.left - COLUMN_TOLERANCE;
        for (const below of column.slice(index + 1)) {
          if (line.y - below.y > HEADING_DEPTH) break;
          const items = below.items.filter(under);
          if (items.length === 0 || items.every((item) => item.text.trim() === '$')) continue;
          const text = joined(items);
          if (carriesFigure(text)) compare(below, heading.key, text, true, heading.left, Math.max(...items.map(right)));
          break;
        }
      }
    });
  }
  for (const line of laterPages) read(line, true);
  for (const line of tables) read(line, false);
}

/** A row of the Interest Charge Calculation table: a summary label, then its APR (`Purchases 19.24% (v) $0.00 $0.00`). */
const INTEREST_ROW = new RegExp(String.raw`^(?:${SUMMARY_LABEL_WORDS})\s+[0-9]{1,2}\.[0-9]{2}%(?=\s|$)`);
/** The heading of the Interest Charge Calculation, or of its continuation on a later page. */
const INTEREST_HEADING = /^Interest Charge Calculation\b/i;

/**
 * Every later page's lines for checkRepeatedFigures, held to page 1's rule (`strict`) but for table rows (`tables`):
 * the transactions and the Cashback Bonus column beside them, read on their own, and the rows of the Interest Charge
 * Calculation (a summary label, then an APR) below its heading, on the transactions' page or continued on a later one.
 */
function laterLines(lines: readonly DiscoverLine[], region: Region): [strict: DiscoverLine[], tables: DiscoverLine[]] {
  const interestFrom = new Map<number, number>([[region.page, region.bottom]]);
  for (const line of lines) if (line.page > region.page && !interestFrom.has(line.page) && INTEREST_HEADING.test(line.text)) interestFrom.set(line.page, line.y);
  const strict: DiscoverLine[] = [];
  const tables: DiscoverLine[] = [];
  for (const line of lines) {
    if (line.page === 1) continue;
    const transactions = line.page === region.page && line.y < region.top + BASELINE_TOLERANCE && line.y > region.bottom - BASELINE_TOLERANCE;
    const heading = interestFrom.get(line.page);
    const interestRow = heading !== undefined && line.y < heading - BASELINE_TOLERANCE && INTEREST_ROW.test(line.text);
    (transactions || interestRow ? tables : strict).push(line);
  }
  return [strict, tables];
}

/**
 * A summary figure from its printed sign: a balance is owed unless signed `-` (a credit balance); Payments and
 * Credits come off the balance, so a non-zero one must be signed `-`; every other component is added and must not be.
 * A zero amount carries any sign or none. Any other sign is ambiguous and refuses the statement.
 */
function signedSummaryFigure(key: SummaryKey, sign: Money['sign'], minor: number, line: DiscoverLine): number {
  if (BALANCES.has(key)) {
    if (sign === '+') refuse('sign', `${at(line)}: ${SUMMARY_NAMES[key]} is signed +, which this reader does not know`);
    return sign === '-' ? -minor + 0 : minor;
  }
  if (minor === 0) return 0;
  if (key === 'paymentsAndCreditsMinor') {
    if (sign !== '-') refuse('sign', `${at(line)}: Payments and Credits is not signed -, so it could be added or taken off`);
    return minor;
  }
  if (sign === '-') refuse('sign', `${at(line)}: ${SUMMARY_NAMES[key]} is signed -, but it adds to the balance`);
  return minor;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

interface Region {
  page: number;
  /** The Cashback Bonus box's left edge (B, C); Infinity in layout A, which has none. */
  split: number;
  /** The transactions column's lines between the Transactions heading and the Interest Charge Calculation. */
  lines: DiscoverLine[];
  /** The heading's and the Interest Charge Calculation's baselines. */
  top: number;
  bottom: number;
}

const REWARDS_LABEL = /^(?:PREVIOUS BALANCE|EARNED THIS PERIOD|REDEEMED THIS PERIOD|CASHBACK BONUS BALANCE)$/;
const CALCULATION = /^Interest Charge Calculation$/;

/**
 * The Transactions heading: the word alone at the left margin, with nothing beside it but the Cashback Bonus box's
 * heading on the right (B, C). Layout C's summary line `Transactions + $0.00` is no heading.
 */
const isTransactionsHeading = (line: DiscoverLine) => line.items[0].text.trim() === 'Transactions' && line.items[0].x < 100
  && line.items.slice(1).every((item) => item.x > 300);

function transactionsRegion(pages: readonly StatementPdfPage[], lines: readonly DiscoverLine[], layout: DiscoverLayout): Region {
  const headings = lines.filter(isTransactionsHeading);
  if (headings.length === 0) refuse('layout', 'the statement has no Transactions heading');
  if (headings.length > 1) refuse('unsupported', 'the statement prints its Transactions heading twice (a list that runs onto another page), which this reader has not seen');
  const [heading] = headings;
  // Layouts B and C print the Cashback Bonus box beside the transactions, its heading on the same line.
  const box = heading.items.slice(1);
  if (layout === 'A' && box.length > 0) refuse('layout', `${at(heading)}: the Transactions heading has something beside it`);
  if (layout !== 'A' && box.length === 0) refuse('layout', `${at(heading)}: the Transactions heading has no Cashback Bonus box beside it`);
  const split = layout === 'A' ? Infinity : Math.min(...box.map((item) => item.x)) - 6;
  // Every label of the Cashback Bonus box must stand right of the split, so none of its figures is read as a transaction.
  if (pages[heading.page - 1].items.some((item) => REWARDS_LABEL.test(item.text.trim()) && item.x < split)) {
    refuse('layout', `page ${heading.page}: the Cashback Bonus box does not stand right of the transactions`);
  }
  const column = columnLines(pages, heading.page, split);
  const start = column.findIndex((line) => line.text === 'Transactions' && Math.abs(line.y - heading.y) <= BASELINE_TOLERANCE);
  const end = column.findIndex((line, index) => index > start && CALCULATION.test(line.text));
  if (start === -1) refuse('layout', `${at(heading)}: the Transactions heading is not a line of its own column`);
  if (end === -1) {
    const later = lines.some((line) => line.page > heading.page && CALCULATION.test(line.text));
    if (later) refuse('unsupported', 'the transactions run onto another page, which this reader has not seen; nothing was read');
    refuse('layout', 'the transactions are not followed by the Interest Charge Calculation');
  }
  const [top, bottom] = [column[start].y, column[end].y];
  // The Cashback Bonus column beside the transactions is never read for rows, so none may stand there: a line in it
  // with a transaction date and an amount refuses the statement (its own figures carry no transaction date).
  if (split !== Infinity) {
    const box = columnsRightOf(pages, heading.page, split);
    for (const line of box) {
      if (line.y < top + BASELINE_TOLERANCE && line.y > bottom - BASELINE_TOLERANCE && transactionShaped(line.text)) {
        refuse('layout', `page ${line.page}, line ${line.number} of the Cashback Bonus column: a line beside the transactions holds a transaction date and an amount`);
      }
    }
  }
  return { page: heading.page, split, lines: column.slice(start + 1, end), top, bottom };
}

interface Activity {
  rows: DiscoverStatementRow[];
  noActivity: boolean;
  feesTotalMinor: number;
  interestTotalMinor: number;
}

/** Layout B and C's column headings: the section each starts, and where its columns stand. */
const CREDITS_HEADING = /^DATE PAYMENTS AND CREDITS AMOUNT$/;
const PURCHASES_HEADING = /^DATE PURCHASES MERCHANT CATEGORY AMOUNT$/;
const ANY_HEADING = /^DATE\b.*\bAMOUNT$/;
const NO_ACTIVITY = /^NO ACTIVITY FOR THIS BILLING PERIOD$/;
const FEES_HEADING = /^Fees and Interest Charged$/;
const FEES_TOTAL = /^(?:Fees\s+)?TOTAL FEES FOR THIS PERIOD\s+(\S.*)$/;
const INTEREST_TOTAL = /^(?:Interest Charged\s+)?TOTAL INTEREST FOR THIS PERIOD\s+(\S.*)$/;
const YEAR_HEADING = /^[0-9]{4}\s+(?:TOTALS YEAR-TO-DATE CHARGED AMOUNT|Totals Year-to-Date)$/;
const YEAR_TOTAL = /^TOTALS?\s+(?:FEES|INTEREST)\s+CHARGED IN\s+[0-9]{4}\s+(\S.*)$/;

interface Columns {
  section: 'credits' | 'purchases';
  date: number;
  description: number;
  /** The merchant category's left edge (purchases); null for credits. */
  category: number | null;
  /** The AMOUNT heading's right edge, where every amount ends. */
  amountRight: number;
}

function columnsOf(line: DiscoverLine, section: Columns['section']): Columns {
  const find = (pattern: RegExp) => line.items.find((item) => pattern.test(item.text.trim()));
  const date = find(/^DATE$/);
  const description = find(section === 'credits' ? /^PAYMENTS AND CREDITS$/ : /^PURCHASES$/);
  const category = section === 'purchases' ? find(/^MERCHANT CATEGORY$/) : undefined;
  const amount = find(/^AMOUNT$/);
  if (!date || !description || !amount || (section === 'purchases' && !category)) {
    refuse('layout', `${at(line)}: a column heading is not printed as its own columns`);
  }
  return { section, date: date.x, description: description.x, category: category ? category.x : null, amountRight: right(amount) };
}

interface Totals {
  fees: number | null;
  interest: number | null;
}

/** A Fees and Interest total, read once: its amount whole. */
function readTotal(totals: Totals, key: keyof Totals, raw: string, line: DiscoverLine): void {
  const value = totalOf(raw);
  if (value === null) refuse('layout', `${at(line)}: the total ${key} for this period is not one whole amount`);
  if (totals[key] !== null) refuse('layout', `${at(line)}: the statement prints its total ${key} for this period twice`);
  totals[key] = value;
}

/** A year-to-date total: read whole, never used (the period's own totals are). */
function checkYearTotal(raw: string, line: DiscoverLine): void {
  if (totalOf(raw) === null) refuse('layout', `${at(line)}: a year-to-date total is not one whole amount`);
}

function rowAmount(raw: string, pattern: RegExp, section: Columns['section'], line: DiscoverLine): number {
  const amount = money(raw, pattern);
  if (!amount) refuse('layout', `${at(line)}: a row's amount is not one whole amount`);
  if (amount.minor === 0) refuse('layout', `${at(line)}: a row's amount is zero`);
  if (section === 'credits') {
    if (amount.sign !== '-') refuse('sign', `${at(line)}: a row under Payments and Credits is not signed -`);
    return -amount.minor;
  }
  if (amount.sign === '-') refuse('sign', `${at(line)}: a purchase is signed -`);
  return amount.minor;
}

function readActivityB(region: Region, period: Period): Activity {
  const rows: DiscoverStatementRow[] = [];
  const totals: Totals = { fees: null, interest: null };
  let noActivity = false;
  let columns: Columns | null = null;
  let inFees = false;
  let inYear = false;
  /** The row the next wrapped line may continue. */
  let last: DiscoverStatementRow | null = null;
  const earliest = dateOfDay(dayNumber(period.start) - EARLIEST_TRANSACTION_DAYS);
  for (const line of region.lines) {
    const { items, text } = line;
    if (text === 'TRANS.') {
      last = null;
      continue;
    }
    if (CREDITS_HEADING.test(text) || PURCHASES_HEADING.test(text)) {
      if (inFees || inYear) refuse('layout', `${at(line)}: a transactions heading after the fees and interest`);
      columns = columnsOf(line, CREDITS_HEADING.test(text) ? 'credits' : 'purchases');
      last = null;
      continue;
    }
    if (ANY_HEADING.test(text)) refuse('unsupported', `${at(line)}: a transactions heading this reader does not know`);
    if (NO_ACTIVITY.test(text)) {
      noActivity = true;
      last = null;
      continue;
    }
    if (FEES_HEADING.test(text)) {
      inFees = true;
      columns = null;
      last = null;
      continue;
    }
    const fees = FEES_TOTAL.exec(text);
    const interest = INTEREST_TOTAL.exec(text);
    if (fees || interest) {
      if (!inFees) refuse('layout', `${at(line)}: a fees or interest total outside Fees and Interest Charged`);
      readTotal(totals, fees ? 'fees' : 'interest', (fees ?? interest)![1], line);
      last = null;
      continue;
    }
    if (YEAR_HEADING.test(text)) {
      inYear = true;
      last = null;
      continue;
    }
    const year = YEAR_TOTAL.exec(text);
    if (year && inYear) {
      checkYearTotal(year[1], line);
      continue;
    }
    const [first] = items;
    if (/^[0-9]{2}\/[0-9]{2}$/.test(first.text.trim())) {
      if (inFees || inYear) refuse('unsupported', `${at(line)}: a fee or interest row, which this reader has not seen`);
      if (!columns) refuse('layout', `${at(line)}: a row comes before its column heading`);
      last = readRowB(line, columns, earliest, period.end);
      rows.push(last);
      continue;
    }
    // Read whole or refused before anything else: a date or an amount is never taken in as a wrapped description.
    if (carriesFigure(text)) refuse('layout', `${at(line)}: a line of the transactions holds a date or an amount but is not a row`);
    if (last && columns && (near(first.x, columns.description) || (columns.category !== null && near(first.x, columns.category)))) {
      wrapB(last, line, columns);
      continue;
    }
    last = null;
  }
  if (totals.fees === null || totals.interest === null) refuse('layout', 'the statement does not print its total fees and interest for this period');
  return { rows, noActivity, feesTotalMinor: totals.fees, interestTotalMinor: totals.interest };
}

function readRowB(line: DiscoverLine, columns: Columns, earliest: string, latest: string): DiscoverStatementRow {
  const [dateItem, ...rest] = line.items;
  if (!near(dateItem.x, columns.date)) refuse('layout', `${at(line)}: a row's date is not in the DATE column`);
  const amountItem = rest[rest.length - 1];
  if (!amountItem || Math.abs(right(amountItem) - columns.amountRight) > AMOUNT_ALIGN) {
    refuse('layout', `${at(line)}: a row's amount does not stand in the AMOUNT column`);
  }
  const amountMinor = rowAmount(amountItem.text, DOLLAR_AMOUNT, columns.section, line);
  const middle = rest.slice(0, -1);
  const categoryFrom = columns.category === null ? Infinity : columns.category - COLUMN_TOLERANCE;
  const descriptionItems = middle.filter((item) => item.x < categoryFrom);
  const categoryItems = middle.filter((item) => item.x >= categoryFrom);
  if (descriptionItems.length === 0 || !near(descriptionItems[0].x, columns.description)) {
    refuse('layout', `${at(line)}: a row's description does not start in its column`);
  }
  const [month, day] = dateItem.text.trim().split('/').map(Number);
  const transactionDate = dateWithin(month, day, earliest, latest);
  if (!transactionDate) refuse('layout', `${at(line)}: a row's date is not in or shortly before the statement period`);
  const description = joined(descriptionItems);
  const category = categoryItems.length > 0 ? joined(categoryItems) : null;
  // Only the DATE and AMOUNT columns hold figures: one in a row's text would be a date or an amount passed over.
  if (carriesFigure(description) || (category !== null && carriesFigure(category))) {
    refuse('layout', `${at(line)}: a row's description or category holds a date or an amount`);
  }
  return {
    page: line.page,
    line: line.number,
    section: columns.section,
    transactionDate,
    postedDate: null,
    amountMinor,
    description,
    category: columns.section === 'purchases' ? category : null,
    sourceTexts: [line.text, description, ...(category === null ? [] : [category])],
  };
}

/** A description or merchant category wrapped onto the next line, joined to its row. */
function wrapB(row: DiscoverStatementRow, line: DiscoverLine, columns: Columns): void {
  const categoryFrom = columns.category === null ? Infinity : columns.category - COLUMN_TOLERANCE;
  const description = joined(line.items.filter((item) => item.x < categoryFrom));
  const category = joined(line.items.filter((item) => item.x >= categoryFrom));
  if (description !== '') row.description = `${row.description} ${description}`;
  if (category !== '') row.category = row.category === null ? category : `${row.category} ${category}`;
  row.sourceTexts.push(line.text, row.description, ...(row.category === null ? [] : [row.category]));
}

/** Layout A's group labels that are no merchant category. */
const CREDITS_GROUP = /^Payments and Credits$/;
const UNSUPPORTED_GROUP = /^(?:Fees|Interest Charged|Balance Transfers|Cash Advances)$/;
const LONG_ROW_DATE = new RegExp(String.raw`^(${MONTH})\s+([0-9]{1,2})$`);

type RowA = DiscoverStatementRow & { descriptionX: number };

function readActivityA(region: Region, period: Period): Activity {
  const rows: RowA[] = [];
  const totals: Totals = { fees: null, interest: null };
  let dates: { transaction: number; posted: number } | null = null;
  let group: string | null = null;
  let inYear = false;
  let last: RowA | null = null;
  const earliest = dateOfDay(dayNumber(period.start) - EARLIEST_TRANSACTION_DAYS);
  for (const line of region.lines) {
    const { items, text } = line;
    if (text === '$') continue;
    if (text === 'Trans. Date Post Date') {
      const transaction = items.find((item) => item.text.trim() === 'Trans. Date');
      const posted = items.find((item) => item.text.trim() === 'Post Date');
      if (!transaction || !posted) refuse('layout', `${at(line)}: the column heading is not printed as its own columns`);
      dates = { transaction: transaction.x, posted: posted.x };
      last = null;
      continue;
    }
    const fees = FEES_TOTAL.exec(text);
    const interest = INTEREST_TOTAL.exec(text);
    if (fees || interest) {
      readTotal(totals, fees ? 'fees' : 'interest', (fees ?? interest)![1], line);
      group = null;
      last = null;
      continue;
    }
    if (YEAR_HEADING.test(text)) {
      inYear = true;
      last = null;
      continue;
    }
    const year = YEAR_TOTAL.exec(text);
    if (year && inYear) {
      checkYearTotal(year[1], line);
      continue;
    }
    const columns = dates;
    const dateIndex = columns === null ? -1 : items.findIndex((item) => near(item.x, columns.transaction) && LONG_ROW_DATE.test(item.text.trim()));
    if (columns !== null && dateIndex !== -1) {
      if (inYear) refuse('layout', `${at(line)}: a row after the year-to-date totals`);
      const label = joined(items.slice(0, dateIndex));
      if (label !== '') group = label;
      if (group === null) refuse('layout', `${at(line)}: a row is printed under no category`);
      if (UNSUPPORTED_GROUP.test(group)) refuse('unsupported', `${at(line)}: a ${group} row, which this reader has not seen`);
      last = readRowA(line, items.slice(dateIndex), columns, group, earliest, period);
      rows.push(last);
      continue;
    }
    if (columns === null && carriesFigure(text)) refuse('layout', `${at(line)}: a row comes before its column heading`);
    // Read whole or refused before anything else: a date or an amount is never taken in as a wrapped description.
    if (carriesFigure(text)) refuse('layout', `${at(line)}: a line of the transactions holds a date or an amount but is not a row`);
    if (last && near(items[0].x, last.descriptionX)) {
      last.description = `${last.description} ${text}`;
      last.sourceTexts.push(text, last.description);
      continue;
    }
    if (columns !== null && items.every((item) => right(item) < columns.transaction)) {
      // A category label on its own line heads the rows below it; one wrapped under a row is a layout not seen.
      if (last) refuse('layout', `${at(line)}: a category wrapped under its row, which this reader has not seen`);
      group = text;
      continue;
    }
    last = null;
  }
  if (totals.fees === null || totals.interest === null) refuse('layout', 'the statement does not print its total fees and interest for this period');
  // Layout A has no NO ACTIVITY line this reader has seen: a statement of that layout without rows is refused.
  return { rows: rows.map(({ descriptionX: _, ...row }) => row), noActivity: false, feesTotalMinor: totals.fees, interestTotalMinor: totals.interest };
}

function readRowA(line: DiscoverLine, items: readonly StatementPdfTextItem[], dates: { transaction: number; posted: number }, group: string,
  earliest: string, period: Period): RowA {
  const [transactionItem, postedItem, ...rest] = items;
  if (!postedItem || !near(postedItem.x, dates.posted) || !LONG_ROW_DATE.test(postedItem.text.trim())) {
    refuse('layout', `${at(line)}: a row's post date is not in the Post Date column`);
  }
  const amountItem = rest[rest.length - 1];
  const dollarItem = rest[rest.length - 2];
  if (!amountItem || !dollarItem || dollarItem.text.trim() !== '$') refuse('layout', `${at(line)}: a row's amount is not a $ and one whole amount`);
  const section: Columns['section'] = CREDITS_GROUP.test(group) ? 'credits' : 'purchases';
  const amountMinor = rowAmount(amountItem.text, BARE_AMOUNT, section, line);
  const descriptionItems = rest.slice(0, -2);
  if (descriptionItems.length === 0 || descriptionItems.some((item) => item.text.trim() === '$')) {
    refuse('layout', `${at(line)}: a row has no description, or more than one amount`);
  }
  const dateOf = (item: StatementPdfTextItem) => {
    const [, month, day] = LONG_ROW_DATE.exec(item.text.trim())!;
    return { month: monthNumber(month), day: Number(day) };
  };
  const posted = dateOf(postedItem);
  const postedDate = dateWithin(posted.month, posted.day, period.start, period.end);
  if (!postedDate) refuse('layout', `${at(line)}: a row's post date is not in the statement period`);
  const transaction = dateOf(transactionItem);
  const transactionDate = dateWithin(transaction.month, transaction.day, earliest, postedDate);
  if (!transactionDate) refuse('layout', `${at(line)}: a row's transaction date is not on or shortly before its post date`);
  const description = joined(descriptionItems);
  // Only the date and amount columns hold figures: one in a row's text would be a date or an amount passed over.
  if (carriesFigure(description)) refuse('layout', `${at(line)}: a row's description holds a date or an amount`);
  return {
    page: line.page,
    line: line.number,
    section,
    transactionDate,
    postedDate,
    amountMinor,
    description,
    category: section === 'purchases' ? group : null,
    sourceTexts: [line.text, description, group],
    descriptionX: descriptionItems[0].x,
  };
}

// ---------------------------------------------------------------------------
// The statement
// ---------------------------------------------------------------------------

/** Parses the positioned text of one Discover statement PDF, or refuses it with a `DiscoverStatementError`. */
export function parseDiscoverStatement(pages: readonly StatementPdfPage[]): ParsedDiscoverStatement {
  const lines = discoverStatementLines(pages);
  if (lines.length === 0) refuse('not-a-statement', 'the PDF has no text (a scanned statement cannot be read)');
  if (!lines.some((line) => DISCOVER_CARD.test(line.text))) {
    refuse('not-a-statement', 'this does not look like a Discover statement: no page names a Discover it card');
  }
  const last4 = cardLast4(lines);
  const split = summarySplit(pages);
  const summaryColumn = columnLines(pages, 1, split);
  const period = statementPeriod(lines, summaryColumn);
  const days = billingDays(lines, period);
  try {
    return readFromSummary(pages, lines, split, summaryColumn, last4, period, days);
  } catch (error) {
    // Refused after its card and period were read: it still says which days it speaks for (see DiscoverStatementError).
    if (error instanceof DiscoverStatementError) error.read = { last4, period: { start: period.start, end: period.end } };
    throw error;
  }
}

/** The rest of parseDiscoverStatement, once the statement's card, period and billing-period length are read. */
function readFromSummary(pages: readonly StatementPdfPage[], lines: readonly DiscoverLine[], split: number, summaryColumn: readonly DiscoverLine[],
  last4: string, period: Period, days: number): ParsedDiscoverStatement {
  const operators = period.form === 'month-name' ? pages[0].items.filter((item) => item.x < split && OPERATOR.test(item.text.trim())) : [];
  const { summary, purchasesLabel, hasBalanceTransfers, before, after } = readSummary(summaryColumn, operators, period.form);
  let layout: DiscoverLayout;
  if (period.form === 'month-name') {
    if (purchasesLabel !== 'Purchases' || !hasBalanceTransfers) refuse('layout', 'the Account Summary is not the one its period\'s layout prints');
    layout = 'A';
  } else {
    layout = purchasesLabel === 'Transactions' ? 'C' : 'B';
  }
  const region = transactionsRegion(pages, lines, layout);
  checkRepeatedFigures(pages, summary, [before, after, columnsRightOf(pages, 1, split)], ...laterLines(lines, region));
  // Anywhere outside the transactions, a line with a transaction date and an amount would be a row passed over.
  for (const line of lines) {
    const inside = line.page === region.page && line.y < region.top + BASELINE_TOLERANCE && line.y > region.bottom - BASELINE_TOLERANCE;
    if (!inside && transactionShaped(line.text)) {
      refuse('layout', `${at(line)}: a line outside the transactions holds a transaction date and an amount`);
    }
  }
  const activity = layout === 'A' ? readActivityA(region, period) : readActivityB(region, period);
  verify(summary, activity);
  return { layout, last4, period: { start: period.start, end: period.end }, billingDays: days, summary, noActivity: activity.noActivity, rows: activity.rows };
}

/** The rows against the Account Summary and the summary against itself, to the cent. */
function verify(summary: DiscoverSummary, activity: Activity): void {
  const { rows, noActivity } = activity;
  const unsupported = (['feesMinor', 'interestMinor', 'balanceTransfersMinor', 'cashAdvancesMinor'] as const).find((key) => summary[key] !== 0);
  if (unsupported) {
    refuse('unsupported', `the statement charges ${SUMMARY_NAMES[unsupported]}, whose rows this reader has not seen; nothing was read`);
  }
  if (activity.feesTotalMinor !== summary.feesMinor || activity.interestTotalMinor !== summary.interestMinor) {
    refuse('reconciliation', 'the fees or interest for this period are not the Account Summary\'s');
  }
  if (noActivity && rows.length > 0) refuse('layout', 'the statement says it has no activity but prints rows');
  if (!noActivity && rows.length === 0) refuse('layout', 'the statement prints no rows and does not say it has no activity');
  const sum = (section: DiscoverStatementRow['section']) => rows.filter((row) => row.section === section).reduce((total, row) => total + row.amountMinor, 0);
  if (sum('credits') !== -summary.paymentsAndCreditsMinor) {
    refuse('reconciliation', 'the rows under Payments and Credits do not add up to the Account Summary\'s Payments and Credits; a row was not read');
  }
  if (sum('purchases') !== summary.purchasesMinor) {
    refuse('reconciliation', 'the purchases do not add up to the Account Summary\'s Purchases; a row was not read');
  }
  const computed = summary.previousBalanceMinor - summary.paymentsAndCreditsMinor + summary.purchasesMinor + summary.balanceTransfersMinor
    + summary.cashAdvancesMinor + summary.feesMinor + summary.interestMinor;
  if (computed !== summary.newBalanceMinor) {
    refuse('reconciliation', 'Previous Balance - Payments and Credits + Purchases + fees and interest is not the New Balance');
  }
  // Two identical rows cannot be told from one row printed twice, whatever the totals say: the statement is held.
  const seen = new Map<string, DiscoverStatementRow>();
  for (const row of rows) {
    const key = JSON.stringify([row.section, row.transactionDate, row.postedDate, row.amountMinor, row.description, row.category]);
    const twin = seen.get(key);
    if (twin) {
      refuse('duplicate', `page ${twin.page} line ${twin.line} and page ${row.page} line ${row.line} print the same row: two identical charges `
        + 'cannot be told from one row printed twice');
    }
    seen.set(key, row);
  }
}

/** Cheap check that the pages look like a Discover statement: a Discover it card and a statement period on the first two pages. */
export function looksLikeDiscoverStatement(pages: readonly StatementPdfPage[]): boolean {
  const lines = discoverStatementLines(pages.slice(0, 2));
  return lines.some((line) => DISCOVER_CARD.test(line.text)) && lines.some((line) => OPEN_CLOSE.test(line.text) || OPEN_TO_CLOSE.test(line.text));
}
