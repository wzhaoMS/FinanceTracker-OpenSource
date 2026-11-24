import {
  CHECKING_IMPORT_FORMAT,
  CHECKING_IMPORT_VERSION,
  validateCardScheduleObservation,
  type CardScheduleObservationInput,
  type CheckingImportPayload,
  type CheckingImportRow,
  type ValidCardScheduleObservation,
} from '@finance-tracker/shared';

import { addDays, addMonths, dayOf, isWeekend, lastDayOf, pickBetween, seededRandom, sha256Hex, weekdayOnOrBefore } from './demoCalendar.js';
import { DEMO_CARDS, demoHistoryStart, type DemoCard, type DemoCardRow } from './demoCards.js';
import { DEMO_MONTHLY_CONTRIBUTIONS, type DemoInvestingAccount } from './demoInvesting.js';
import { marketDate } from '../services/symbolHistory.js';

/**
 * The demo household's money around its cards: each card's monthly statement and the autopay that pays it in full on
 * the card's due date, what the issuers' statements and dashboards say (the card schedule observations behind Owed now
 * and the payment schedule), and one fictional joint checking account the household is paid into and pays its cards
 * from (behind the card payments vs checking reconciliation). Everything is derived from the card rows, so the three
 * agree: every autopay on a card has the checking debit that paid it.
 */

export const DEMO_CHECKING = Object.freeze({ institution: 'woodgrove-bank', last4: '7007', label: 'Woodgrove Bank Joint Checking' });
export const DEMO_EXTRACTOR = 'holdr-demo-1';

const AUTOPAY = 'AUTOPAY PAYMENT - THANK YOU';

export interface DemoStatement {
  card: DemoCard['key'];
  /** The statement's month (YYYY-MM): it opens on the 1st and closes on the last day. */
  month: string;
  closing: string;
  due: string;
  balanceMinor: number;
  minimumMinor: number;
}

export interface DemoStatements {
  statements: DemoStatement[];
  /** The autopay rows: each pays its card's previous statement in full on the due date (once that date has come). */
  payments: DemoCardRow[];
}

const minimumOf = (balance: number) => (balance <= 0 ? 0 : balance <= 4_000 ? balance : Math.max(4_000, Math.round(balance * 0.02)));

/**
 * Statements closing at each month's end from the first month of the history (no balance before it) through last
 * month, and the payments of each through `today`: statement = last statement - its payment + the month's posted rows.
 */
export function buildDemoStatements(rows: readonly DemoCardRow[], today: string): DemoStatements {
  const start = demoHistoryStart(today);
  const currentMonth = today.slice(0, 7);
  const statements: DemoStatement[] = [];
  const payments: DemoCardRow[] = [];
  for (const card of DEMO_CARDS) {
    const posted = rows.filter((row) => row.card === card.key && row.status === 'posted' && row.kind !== 'payment');
    let previous: DemoStatement | null = null;
    for (let month = start.slice(0, 7); month <= currentMonth; month = addMonths(month, 1)) {
      let paid = 0;
      if (previous && previous.balanceMinor > 0 && previous.due <= today) {
        paid = previous.balanceMinor;
        payments.push({
          card: card.key, transactionDate: previous.due, status: 'posted', currency: 'USD', amountMinor: -paid, kind: 'payment',
          description: AUTOPAY, merchant: null, issuerCategory: null,
        });
      }
      if (month === currentMonth) break;
      const net = posted.filter((row) => row.transactionDate.startsWith(month)).reduce((total, row) => total + row.amountMinor, 0);
      const balanceMinor: number = (previous?.balanceMinor ?? 0) - paid + net;
      previous = {
        card: card.key, month, closing: lastDayOf(month), due: dayOf(addMonths(month, 1), card.payDay), balanceMinor, minimumMinor: minimumOf(balanceMinor),
      };
      statements.push(previous);
    }
  }
  return { statements, payments };
}

const sourceRef = (label: string) => `sha256:${sha256Hex(`holdr-demo-source:${label}`)}`;

function cardReference(card: DemoCard): CardScheduleObservationInput['card'] {
  return { issuer: card.issuer, last4: card.last4, owner: card.owner, nickname: card.nickname };
}

function validated(input: CardScheduleObservationInput): ValidCardScheduleObservation {
  const result = validateCardScheduleObservation(input);
  if (!result.ok) throw new Error(`demo card schedule observation refused: ${result.reason}`);
  return result.value;
}

/**
 * What the issuers showed: every statement (as its PDF reads, a few days after its close) and, for each card, a
 * dashboard read from just before `now`: the current balance, the last statement and what is left of it, its due date,
 * the last payment and the scheduled autopay.
 */
export function buildDemoObservations(rows: readonly DemoCardRow[], built: DemoStatements, now: Date): ValidCardScheduleObservation[] {
  const observed = new Date(now.getTime() - 3 * 60_000);
  const observedDay = marketDate(observed);
  const observations: ValidCardScheduleObservation[] = [];
  for (const card of DEMO_CARDS) {
    const statements = built.statements.filter((statement) => statement.card === card.key);
    for (const statement of statements) {
      const read = new Date(Math.min(Date.parse(`${addDays(statement.closing, 3)}T14:00:00Z`), observed.getTime()));
      if (marketDate(read) < statement.closing) continue;
      observations.push(validated({
        card: cardReference(card),
        currency: 'USD',
        sourceKind: 'statement-pdf',
        sourceRef: sourceRef(`statement:${card.key}:${statement.month}`),
        observedAt: read.toISOString(),
        extractorVersion: DEMO_EXTRACTOR,
        asOf: { source: 'statement', at: statement.closing, precision: 'date' },
        statementPeriodStartDate: `${statement.month}-01`,
        statementClosingDate: statement.closing,
        paymentDueDate: statement.due,
        statementBalanceMinor: statement.balanceMinor,
        minimum: { minor: statement.minimumMinor, basis: 'total-due' },
        autopay: 'on-statement',
      }));
    }
    const last = statements.at(-1);
    if (!last) continue;
    const cardPayments = built.payments.filter((row) => row.card === card.key && row.transactionDate <= observedDay)
      .sort((a, b) => a.transactionDate.localeCompare(b.transactionDate));
    const paidLast = cardPayments.some((row) => row.transactionDate > last.closing);
    const sinceClose = rows.filter((row) => row.card === card.key && row.status === 'posted' && row.kind !== 'payment'
      && row.transactionDate > last.closing && row.transactionDate <= observedDay).reduce((total, row) => total + row.amountMinor, 0);
    const remaining = paidLast ? 0 : Math.max(last.balanceMinor, 0);
    const lastPayment = cardPayments.at(-1);
    observations.push(validated({
      card: cardReference(card),
      currency: 'USD',
      sourceKind: 'issuer-dashboard-dom',
      sourceRef: sourceRef(`dashboard:${card.key}:${observedDay}`),
      observedAt: observed.toISOString(),
      extractorVersion: DEMO_EXTRACTOR,
      statementClosingDate: last.closing,
      paymentDueDate: last.due,
      statementBalanceMinor: last.balanceMinor,
      remainingStatementMinor: remaining,
      currentBalanceMinor: last.balanceMinor - (paidLast ? Math.max(last.balanceMinor, 0) : 0) + sinceClose,
      minimum: { minor: paidLast ? 0 : last.minimumMinor, basis: 'total-due' },
      autopay: 'on-statement',
      ...(lastPayment ? { lastPaymentDate: lastPayment.transactionDate, lastPaymentMinor: -lastPayment.amountMinor } : {}),
      ...(remaining > 0 && last.due >= observedDay ? { scheduledPaymentDate: last.due, scheduledPaymentMinor: remaining } : {}),
    }));
  }
  return observations;
}

/** What the bank prints for a card's autopay: the issuer's name, and a masked card number where the issuer has two cards. */
function autopayDescriptor(card: DemoCard): string {
  const twins = DEMO_CARDS.filter((other) => other.issuer === card.issuer).length > 1;
  const masked = twins ? ` XXXXXX${card.last4}` : '';
  if (card.issuer === 'amex') return `AMERICAN EXPRESS ACH PMT${masked}`;
  if (card.issuer === 'chase') return `CHASE CREDIT CRD AUTOPAY${masked}`;
  return `CITI AUTOPAY PAYMENT${masked}`;
}

/** Money into or out of the checking account that is not a card autopay. */
export interface DemoCheckingEntry {
  date: string;
  amountMinor: number;
  description: string;
}

const nextWeekday = (date: string) => {
  let day = date;
  while (isWeekend(day)) day = addDays(day, 1);
  return day;
};

/**
 * The monthly transfers to the brokerage, one per account they fund, each ending in that account's number: what the
 * brokerage shows as each account's deposit the next business day (demoInvesting.ts, demoData.ts buildDemoCashEvents).
 * Casey's 401(k) and HSA are funded from Casey's pay before it reaches this account.
 */
const BROKERAGE_TRANSFERS: ReadonlyArray<{ account: DemoInvestingAccount; description: string }> = [
  { account: 'alexBrokerage', description: 'ONLINE TRANSFER TO SAMPLE BROKERAGE XXXX0101' },
  { account: 'alexRoth', description: 'ONLINE TRANSFER TO SAMPLE BROKERAGE XXXX0102' },
  { account: 'caseyBrokerage', description: 'ONLINE TRANSFER TO SAMPLE BROKERAGE XXXX0201' },
];

/**
 * The joint checking account through yesterday (a bank export never covers a day still in progress): two salaries
 * (and a December bonus), the mortgage, the monthly transfers to the brokerage, cash and Zelle, interest, every card
 * autopay (posted the next business day when its due date falls on a weekend), and `extra` entries (the bullion
 * dealer's payouts, the bullion card's payments). Its opening balance is set so it never runs below $2,500.
 */
export function buildDemoCheckingPayload(today: string, payments: readonly DemoCardRow[], extra: readonly DemoCheckingEntry[]): CheckingImportPayload {
  const start = demoHistoryStart(today);
  const end = addDays(today, -1);
  const entries: DemoCheckingEntry[] = [...extra];
  for (let month = start.slice(0, 7); `${month}-01` <= end; month = addMonths(month, 1)) {
    const next = seededRandom(`holdr-demo-checking:${month}`);
    const monthEnd = weekdayOnOrBefore(lastDayOf(month));
    entries.push(
      { date: weekdayOnOrBefore(dayOf(month, 15)), amountMinor: 412_500, description: 'FABRIKAM INC PAYROLL PPD' },
      { date: monthEnd, amountMinor: 412_500, description: 'FABRIKAM INC PAYROLL PPD' },
      { date: nextWeekday(dayOf(month, 1)), amountMinor: 348_000, description: 'ADVENTURE WORKS DIR DEP' },
      { date: weekdayOnOrBefore(dayOf(month, 16)), amountMinor: 348_000, description: 'ADVENTURE WORKS DIR DEP' },
      { date: nextWeekday(dayOf(month, 1)), amountMinor: -286_000, description: 'SAMPLE HOME LOANS MORTGAGE PMT' },
      ...BROKERAGE_TRANSFERS.map(({ account, description }) => ({
        date: nextWeekday(dayOf(month, 5)), amountMinor: -DEMO_MONTHLY_CONTRIBUTIONS[account] * 100, description,
      })),
      { date: lastDayOf(month), amountMinor: pickBetween(next, 85, 240), description: 'INTEREST PAYMENT' },
    );
    if (month.endsWith('-12')) entries.push({ date: weekdayOnOrBefore(dayOf(month, 15)), amountMinor: 600_000, description: 'FABRIKAM INC BONUS PPD' });
    for (let count = pickBetween(next, 1, 3); count > 0; count -= 1) {
      entries.push(next() < 0.5
        ? { date: dayOf(month, pickBetween(next, 2, 27)), amountMinor: -pickBetween(next, 1, 3) * 10_000, description: 'ATM WITHDRAWAL' }
        : { date: dayOf(month, pickBetween(next, 2, 27)), amountMinor: -pickBetween(next, 6_000, 25_000), description: 'ZELLE PAYMENT SENT' });
    }
  }
  for (const payment of payments) {
    const card = DEMO_CARDS.find((entry) => entry.key === payment.card)!;
    entries.push({ date: nextWeekday(payment.transactionDate), amountMinor: payment.amountMinor, description: autopayDescriptor(card) });
  }
  const rows: CheckingImportRow[] = entries
    .filter((entry) => entry.date >= start && entry.date <= end)
    .sort((a, b) => a.date.localeCompare(b.date) || b.amountMinor - a.amountMinor || a.description.localeCompare(b.description))
    .map((entry) => ({
      postedDate: entry.date, amountMinor: entry.amountMinor, description: entry.description, checkNumber: null,
      bankType: entry.amountMinor > 0 ? 'CREDIT' : 'DEBIT', externalIdHash: null,
    }));
  let running = 0;
  let lowest = 0;
  for (const row of rows) {
    running += row.amountMinor;
    lowest = Math.min(lowest, running);
  }
  const opening = Math.ceil((250_000 - lowest) / 10_000) * 10_000;
  return {
    format: CHECKING_IMPORT_FORMAT,
    version: CHECKING_IMPORT_VERSION,
    parserVersion: DEMO_EXTRACTOR,
    account: { institution: DEMO_CHECKING.institution, type: 'checking', last4: DEMO_CHECKING.last4, label: DEMO_CHECKING.label, currency: 'USD' },
    segments: [{
      source: 'demo-export',
      coverage: { start, end },
      anchors: [
        { date: addDays(start, -1), balanceMinor: opening, kind: 'opening' },
        { date: end, balanceMinor: opening + running, kind: 'closing' },
      ],
      rows,
    }],
  };
}
