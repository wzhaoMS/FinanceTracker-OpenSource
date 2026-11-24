import { Router, type Request, type RequestHandler, type Response } from 'express';

import {
  CARD_PAYMENT_DECISION_KINDS,
  CARD_PAYMENT_PAYEE_LABELS,
  CARD_PAYMENT_RECONCILIATION_RULES,
  cardPaymentConfirmRefusal,
  cardPaymentDayOffset,
  cardPaymentSourceWindow,
  isReconcilableCardPayment,
  isReconcilableCheckingDebit,
  reconcileCardPayments,
  suggestCardPaymentSources,
  type CardPaymentCandidate,
  type CardPaymentConfirmRefusal,
  type CardPaymentDecisionKind,
  type CardPaymentPairEvidence,
  type CardPaymentReconciliation,
  type CardTransaction,
  type CheckingDebitClass,
  type ReconciliationCheckingRow,
} from '@finance-tracker/shared';
import {
  CARD_DATA_MESSAGE,
  HttpError,
  cardGuardRefusal,
  isPlainObject,
  jsonBody,
  looksLikeCardData,
  queryParams,
  readBody,
  rejectCardData,
  repositoryError,
  scanQuery,
  sessionActorRef,
} from './cardSpending.js';
import { cardCoverageEvidence } from './cardSpendingOverview.js';
import { HoldrRefusal } from '../services/dbErrors.js';
import {
  CARD_PAYMENT_DECISIONS_NOT_INSTALLED as NOT_INSTALLED,
  CARD_PAYMENT_DECISIONS_CONFLICT,
  CARD_PAYMENT_DECISIONS_CONFLICT_CODE,
  isCardPaymentDecisionTaken,
  isCardPaymentDecisionsNotInstalled,
  type CardPaymentDecisionRecord,
} from '../services/cardPaymentDecisions.js';
import type { SqliteStateRepo } from '../services/sqliteStateRepo.js';

/**
 * Card payments matched one to one with the checking debits that paid them, from every checking account Holdr has
 * imported (Wells Fargo, Fifth Third, …): shared cardPaymentReconciliation.ts has the rules. Served only through
 * `mountCardSpendingRoutes` (cardSpending.ts), as one of its `routers`, behind the same required sign-in, body-parser
 * skip and value-free error handler as every card spending route; the service token may only read.
 *
 *   GET    /spending/payment-reconciliation       → { rulesVersion, rules, checking: { installed, accounts (label,
 *          institution, last 4, coverage) }, decisions: { installed, stale, answers (the rejections, and the answers
 *          that no longer fit their rows, each with what is left of its rows, so the owner can undo them) }, totals (per currency, every payment and
 *          card-payment debit in exactly one part), pairs (matched by the rules, or confirmed; a pair the rules matched
 *          inside a group they hold for the owner says why in `evidence`: interchangeable rows (and whether a description
 *          cue or canonical order paired it), a payer reference and
 *          how many proven pairs back it, or what was left of the group), ambiguous (groups for
 *          the owner), unmatchedPayments and unmatchedDebits (each with why, and what the owner might pair it with; a
 *          payment also with how many brokerage outflows it may have come from, as `possiblyPaidFrom` reads them, and
 *          the card's own reversals of its amount, when the rules settle none), returned (payments the card itself
 *          took back, each with its reversal: no debit needed), returnedDebits (pulls their bank returned unpaid, each
 *          netted with its return: no candidate, no gap), elsewhere, notCardPayments, biltHousing (Bilt housing
 *          pulls with no Bilt housing payment row, apart) }: the whole history, both sides
 *   GET    /spending/payment-reconciliation/payments/:id → { checking: { installed }, decisions: { installed },
 *          paymentMatch } for one card row's detail: where a payment to the card stands (matched or confirmed with its
 *          debit, with the pair's `evidence` where the rules matched it inside a group held for the owner; ambiguous
 *          with its candidates, unmatched with why and what the owner might pair it with, returned by
 *          the card with its reversal, paid from elsewhere, or pending); null for any other row, and while no checking
 *          ledger is installed unless the owner said it was paid from another account or the card's own rows say
 *          something (returned, or a reversal offered). 404 for an id that names no card
 *          row. GET /card-transactions/:id is not changed by any of this.
 *   POST   /spending/payment-reconciliation/decisions   body { decision: 'confirmed' | 'rejected', cardTransactionId,
 *          checkingTransactionId } or { decision: 'elsewhere', cardTransactionId } or { decision: 'not-card-payment',
 *          checkingTransactionId } → 201 { decision }
 *   DELETE /spending/payment-reconciliation/decisions/:id                   → { decision } (undone), or 404
 *
 * Checking rows are read through the checking ledger's reader (`checkingLedger`, read-only); without one, or before
 * the checking tables are installed, `checking.installed` is false and every payment is unmatched with reason
 * `no-checking-account`. Owner decisions live in a table only the Root-GO-gated operator command installs
 * (cli/paymentReconciliation.ts): until then a decision is a 409, and reads work (the rules alone). A table there in
 * another shape is never read as absent: every read and answer here is the fixed 409 `card-payment-decisions-conflict`,
 * so no stored answer is ever ignored. A decision is checked against the rows before it is stored: a posted payment to
 * a card, a posted debit, one amount and currency; a pair's answer (confirmed or rejected) at most
 * CARD_PAYMENT_RECONCILIATION_RULES.confirmDays apart, past the rules' own window if the owner says so, with the day
 * gap kept in the answer, and never across Bilt's lanes (a housing pull only for a Bilt housing payment row, and that
 * row only with a housing pull); a row that already has a decision in force is a 409. A refused decision writes nothing.
 *
 * Every text shown (a card payment's description, a checking descriptor) is one line with every run of five or more
 * digits cut to `***` and its last four (`AMEX EPAYMENT ACH PMT ***9999 W9999`), and is left out when it holds a
 * hidden character or still looks like card data; a debit's payee is the issuer the rules read in it. Card data in the
 * query, the :id or the body is a 422 with paths only, before any other answer; unknown parameters and keys are
 * refused, errors never echo input, and nothing logs a query, body or description. Nothing here writes a card or
 * checking row, or a brokerage account, cash event, holding or return (brokerage cash is only read, for the hints):
 * payments stay transfers, and no spending figure changes.
 */

/** A checking account as the checking ledger's reader lists it. */
export interface CheckingLedgerAccount {
  id: string;
  /** The bank's slug: `wellsfargo`, `fifththird`, … */
  institution: string;
  /** A display name with no digits, e.g. "Sample Bank Everyday Checking". */
  label: string;
  last4?: string | null;
  currency: string;
  status: string;
}

/**
 * The checking ledger's read-only reader (its own module implements it; createApp passes it in). Row ids never change
 * on re-import, rows are posted only, and `amountMinor` is negative for money out.
 */
export interface CheckingLedgerReader {
  installed(): boolean;
  listAccounts(): CheckingLedgerAccount[];
  /** Rows dated from `from` to `to` (inclusive), by date then id. */
  listRows(range: { from: string; to: string }): ReconciliationCheckingRow[];
  /** Per account, the merged, sorted, inclusive ranges of days its imports cover in full. */
  coverage(): Array<{ checkingAccountId: string; ranges: Array<{ start: string; end: string }> }>;
}

const BODY_LIMIT_BYTES = 4 * 1024;
const DECISION_KEYS = new Set(['decision', 'cardTransactionId', 'checkingTransactionId']);
const DECISION_ID = /^cpd_[a-p]{32}$/;
const CARD_TRANSACTION_ID = /^card-txn-[a-p]{32}$/;
const CHECKING_TRANSACTION_ID = /^chk-txn-[a-p]{32}$/;
/** Every date a checking ledger can hold: the reconciliation reads its whole history. */
const ALL_DAYS = { from: '1900-01-01', to: '9999-12-31' } as const;
const UNNAMED_CHECKING_ACCOUNT = 'Checking account';
const CHECKING_NOT_INSTALLED = 'checking accounts are not installed on this Holdr';

/** The decisions table in another shape than this build's: every reconciliation read and answer is this fixed 409. */
function decisionsConflict(): HttpError {
  return new HttpError(409, CARD_PAYMENT_DECISIONS_CONFLICT, { code: CARD_PAYMENT_DECISIONS_CONFLICT_CODE });
}

/** An answer needs the decisions table in this build's shape: absent, the 409 to install it; another shape, the conflict. */
function requireDecisionsTable(repo: SqliteStateRepo): void {
  const state = repo.cardPaymentDecisionsSchemaState();
  if (state === 'conflict') throw decisionsConflict();
  if (state !== 'present') throw new HttpError(409, NOT_INSTALLED);
}

/** Control, format (zero-width, bidi), private-use and lone surrogate code points, and combining marks not on a letter. */
const HIDING = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]|(?<![\p{L}\p{M}])\p{M}/u;
/** A run of digits (in any script) and the separators numbers are written with between them (as cardNumbers.ts reads them). */
const DIGIT_RUN = /\p{N}+(?:[\s\p{Pd}\u2043\u2212./\\,_|'·∙⋅]+\p{N}+)*/gu;
const MAX_SHOWN = 120;

/**
 * Text as the reconciliation shows it, a card payment's description or a checking descriptor: one line, at most 120
 * characters, every run of five or more digits (in any script, after compatibility folding, counted across the
 * separators numbers are written with) cut to `***` and its last four, so no card, account or reference number can
 * survive it. Where what is left still reads as card data (two masked numbers side by side), no digit is shown at all;
 * undefined when even that reads as card data, or the text holds a character that could hide something.
 */
export function maskedDescriptor(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  const line = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!line || HIDING.test(line)) return undefined;
  const masked = line.replace(DIGIT_RUN, (run) => {
    const digits = Array.from(run.replace(/[^\p{N}]/gu, ''));
    return digits.length >= 5 ? `***${digits.slice(-4).join('')}` : run;
  });
  const chars = Array.from(masked);
  const shown = chars.length > MAX_SHOWN ? `${chars.slice(0, MAX_SHOWN - 1).join('')}…` : masked;
  if (!looksLikeCardData(shown)) return shown;
  const hashed = shown.replace(/\p{N}/gu, '#');
  return looksLikeCardData(hashed) ? undefined : hashed;
}

/** A checking account's institution slug as the ledger names it (`wellsfargo`): letters and hyphens only, else `other`. */
function institutionSlug(text: unknown): string {
  return typeof text === 'string' && text.length <= 40 && /^[a-z]+(?:-[a-z]+)*$/.test(text) ? text : 'other';
}

/** A display name from the checking ledger, shown only without digits or hidden characters. */
function accountLabel(text: unknown): string {
  if (typeof text !== 'string') return UNNAMED_CHECKING_ACCOUNT;
  const line = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!line || line.length > 80 || HIDING.test(line) || /\p{N}/u.test(line) || looksLikeCardData(line)) return UNNAMED_CHECKING_ACCOUNT;
  return line;
}

export interface PaymentView {
  id: string;
  cardAccountId: string;
  /** The card row's transaction date. */
  date: string;
  amountMinor: number;
  currency: string;
  /** The card row's description, masked (`maskedDescriptor`); absent when it cannot be shown. */
  description?: string;
}

export interface DebitView {
  id: string;
  checkingAccountId: string;
  /** The checking account's display name (no digits), or a neutral label. */
  accountLabel: string;
  date: string;
  amountMinor: number;
  currency: string;
  class: CheckingDebitClass;
  /** The issuer the descriptor names (a CARD_PAYMENT_PAYEES slug), or null. */
  payee: string | null;
  /** That issuer's name, or null. */
  payeeLabel: string | null;
  /** The descriptor, masked (`maskedDescriptor`); absent when it cannot be shown. */
  descriptor?: string;
}

/** Everything one answer reads, once. */
export interface CardPaymentReconciliationRead {
  installed: boolean;
  accounts: CheckingLedgerAccount[];
  coverage: Map<string, Array<{ start: string; end: string }>>;
  decisionsInstalled: boolean;
  /** The owner's answers in force (undone ones left out). */
  decisions: CardPaymentDecisionRecord[];
  result: CardPaymentReconciliation;
  payments: Map<string, CardTransaction>;
  debits: Map<string, ReconciliationCheckingRow>;
}

/**
 * The reconciliation over the whole history: every card payment row, every checking row (through `reader`), the
 * owner's decisions in force and both sides' coverage. Reads only. A decisions table in another shape than this
 * build's is the fixed 409 (`decisionsConflict`), before anything is matched: the stored answers are never ignored.
 * What the checking reader throws is a server fault: it goes on to the mount's handler, the value-free 500.
 */
export function readCardPaymentReconciliation(repo: SqliteStateRepo, reader: CheckingLedgerReader | null): CardPaymentReconciliationRead {
  const decisionsState = repo.cardPaymentDecisionsSchemaState();
  if (decisionsState === 'conflict') throw decisionsConflict();
  const installed = reader !== null && reader.installed() === true;
  const accounts = installed ? reader.listAccounts() : [];
  const rows = installed ? reader.listRows(ALL_DAYS) : [];
  const coverage = new Map((installed ? reader.coverage() : []).map((item) => [item.checkingAccountId, item.ranges]));
  const cardRows = repo.listCardTransactionsMatching({ statuses: ['pending', 'posted'], kinds: ['payment'] });
  const decisionsInstalled = decisionsState === 'present';
  const decisions = decisionsInstalled ? repo.listCardPaymentDecisions() : [];
  const result = reconcileCardPayments({
    // The cards' last fours, and each checking account's own: a masked card number in a debit names a card only by them.
    cardAccounts: repo.listCardAccounts().map((account) => ({ id: account.id, issuer: account.issuer, last4: account.last4 ?? null, last5: account.last5 ?? null })),
    cardRows,
    checkingAccounts: accounts.map((account) => ({ id: account.id, last4: account.last4 })),
    checkingRows: rows,
    decisions,
    cardCoverage: cardCoverageEvidence(repo).map((item) => ({ accountId: item.cardAccountId, ranges: item.ranges })),
    checkingCoverage: [...coverage].map(([accountId, ranges]) => ({ accountId, ranges })),
  });
  return {
    installed,
    accounts,
    coverage,
    decisionsInstalled,
    decisions,
    result,
    payments: new Map(cardRows.map((row) => [row.id, row])),
    debits: new Map(rows.map((row) => [row.id, row])),
  };
}

function paymentView(row: CardTransaction): PaymentView {
  const description = maskedDescriptor(row.description);
  return {
    id: row.id, cardAccountId: row.cardAccountId, date: row.transactionDate, amountMinor: row.amountMinor,
    currency: row.currency, ...(description ? { description } : {}),
  };
}

function debitView(row: ReconciliationCheckingRow, read: CardPaymentReconciliationRead): DebitView {
  const kind = read.result.classes.get(row.id);
  const payee = kind?.payee ?? null;
  const descriptor = maskedDescriptor(row.description);
  const account = read.accounts.find((item) => item.id === row.checkingAccountId);
  return {
    id: row.id, checkingAccountId: row.checkingAccountId, accountLabel: accountLabel(account?.label), date: row.date,
    amountMinor: row.amountMinor, currency: row.currency,
    class: kind?.class ?? 'other', payee, payeeLabel: payee ? CARD_PAYMENT_PAYEE_LABELS[payee] : null,
    ...(descriptor ? { descriptor } : {}),
  };
}

/**
 * For each payment left without a checking debit, how many brokerage withdrawals or transfers out it may have come from
 * (shared suggestCardPaymentSources, the rules of `possiblyPaidFrom`): a hint that brokerage cash paid it. Brokerage
 * accounts and cash events are only read, and only around those payments; nothing is linked. Whatever the brokerage
 * reads throw is a server fault: it goes on to the mount's handler, the value-free 500.
 */
export function brokeragePaymentHints(repo: SqliteStateRepo, read: CardPaymentReconciliationRead): Map<string, number> {
  const rows = read.result.unmatchedPayments.map((item) => read.payments.get(item.paymentId)!);
  if (rows.length === 0) return new Map();
  const dates = rows.map((row) => row.transactionDate).sort();
  const window = cardPaymentSourceWindow(dates[0], dates[dates.length - 1]);
  if (!window) return new Map();
  // The cash event reader takes dates from 1900 to 9999.
  const from = window.from < '1900-01-01' ? '1900-01-01' : window.from;
  const to = window.to > '9999-12-31' ? '9999-12-31' : window.to;
  const events = from > to ? [] : repo.listAccounts().flatMap((account) => repo.listCashEvents(account.id, from, to));
  return new Map(rows.map((row) => [row.id, suggestCardPaymentSources(row, events, Number.POSITIVE_INFINITY).length]));
}

/** The whole answer of GET /spending/payment-reconciliation. */
export function cardPaymentReconciliationView(read: CardPaymentReconciliationRead, brokerage: ReadonlyMap<string, number> = new Map()) {
  const { result } = read;
  const payment = (id: string) => paymentView(read.payments.get(id)!);
  const debit = (id: string) => debitView(read.debits.get(id)!, read);
  const candidate = (item: CardPaymentCandidate) => ({ paymentId: item.paymentId, debitId: item.debitId, dayOffset: item.dayOffset });
  const { daysBefore, daysAfter, confirmDays, returnDays } = CARD_PAYMENT_RECONCILIATION_RULES;
  // Answers the other lists do not show with an Undo of their own: rejections, and answers that no longer fit their rows.
  const staleReasons = new Map(result.staleDecisions.map((item) => [item.decisionId, item.reason]));
  const answers = read.decisions
    .filter((item) => item.decision === 'rejected' || staleReasons.has(item.id))
    .map((item) => {
      const card = item.cardTransactionId ? read.payments.get(item.cardTransactionId) : undefined;
      const bank = item.checkingTransactionId ? read.debits.get(item.checkingTransactionId) : undefined;
      const reason = staleReasons.get(item.id);
      return {
        id: item.id,
        decision: item.decision,
        createdAt: item.createdAt,
        ...(reason ? { stale: reason } : {}),
        ...(card && isReconcilableCardPayment(card) ? { payment: paymentView(card) } : {}),
        ...(bank ? { debit: debitView(bank, read) } : {}),
      };
    });
  return {
    rulesVersion: result.rulesVersion,
    rules: { daysBefore, daysAfter, confirmDays, returnDays },
    checking: {
      installed: read.installed,
      accounts: read.accounts.map((account) => ({
        id: account.id,
        label: accountLabel(account.label),
        institution: institutionSlug(account.institution),
        last4: typeof account.last4 === 'string' && /^\d{4}$/.test(account.last4) ? account.last4 : null,
        currency: /^[A-Z]{3}$/.test(account.currency) ? account.currency : 'XXX',
        status: typeof account.status === 'string' && /^[a-z][a-z-]{0,19}$/.test(account.status) ? account.status : 'other',
        coverage: read.coverage.get(account.id) ?? [],
      })),
    },
    decisions: { installed: read.decisionsInstalled, stale: result.staleDecisions, answers },
    totals: result.totals,
    pairs: result.pairs.map((pair) => ({
      status: pair.status,
      dayOffset: pair.dayOffset,
      ...(pair.decisionId ? { decisionId: pair.decisionId } : {}),
      ...(pair.evidence ? { evidence: pair.evidence } : {}),
      payment: payment(pair.paymentId),
      debit: debit(pair.debitId),
    })),
    ambiguous: result.ambiguous.map((group) => ({
      id: group.id,
      payments: group.paymentIds.map(payment),
      debits: group.debitIds.map(debit),
      candidates: group.candidates.map(candidate),
    })),
    unmatchedPayments: result.unmatchedPayments.map((item) => ({
      payment: payment(item.paymentId),
      reason: item.reason,
      possibleDebits: item.possibleDebits.map((option) => ({ debit: debit(option.debitId), dayOffset: option.dayOffset })),
      ...(item.possibleReversals
        ? { possibleReversals: item.possibleReversals.map((option) => ({ reversal: payment(option.reversalId), dayOffset: option.dayOffset })) }
        : {}),
      brokerageSuggestions: brokerage.get(item.paymentId) ?? 0,
    })),
    unmatchedDebits: result.unmatchedDebits.map((item) => ({
      debit: debit(item.debitId),
      reason: item.reason,
      possiblePayments: item.possiblePayments.map((option) => ({ payment: payment(option.paymentId), dayOffset: option.dayOffset })),
    })),
    elsewhere: result.elsewhere.map((item) => ({ payment: payment(item.paymentId), decisionId: item.decisionId })),
    returned: result.returned.map((item) => ({ payment: payment(item.paymentId), reversal: payment(item.reversalId), dayOffset: item.dayOffset })),
    // Pulls their bank returned unpaid, each netted with its return (by the return's date): no candidate, no gap.
    returnedDebits: result.returnedDebits.map((item) => ({
      debit: debit(item.debitId), returnedOn: read.debits.get(item.creditId)!.date, dayOffset: item.dayOffset,
    })),
    notCardPayments: result.notCardPayments.map((item) => ({ debit: debit(item.debitId), decisionId: item.decisionId })),
    biltHousing: result.biltHousing.map((item) => ({
      debit: debit(item.debitId),
      reason: item.reason,
      possiblePayments: item.possiblePayments.map((option) => ({ payment: payment(option.paymentId), dayOffset: option.dayOffset })),
    })),
  };
}

/** Where one payment to a card stands against the checking debits, for its detail. */
export type CardPaymentMatchView =
  | { status: 'matched' | 'confirmed'; debit: DebitView & { dayOffset: number }; decisionId?: string; evidence?: CardPaymentPairEvidence }
  | { status: 'ambiguous'; candidates: Array<DebitView & { dayOffset: number }>; otherPayments: number }
  | { status: 'unmatched'; reason: string; possibleDebits: Array<DebitView & { dayOffset: number }>; possibleReversals?: Array<PaymentView & { dayOffset: number }> }
  | { status: 'returned'; reversal: PaymentView & { dayOffset: number } }
  | { status: 'elsewhere'; decisionId: string }
  | { status: 'pending' };

/**
 * Where one card row stands against the checking debits, for its detail (GET
 * /spending/payment-reconciliation/payments/:id): matched or confirmed with its debit, ambiguous with its candidates,
 * unmatched with why and the debits (and the card's reversals) the owner might pair it with, returned by the card with
 * its reversal, paid from elsewhere, or pending. Null for a row that is not a payment to the card. While no checking
 * ledger is installed there is no checking side: null, unless the owner said it was paid from another account (that
 * answer, and its Undo, stand either way) or the card's own rows say something (returned, or a reversal offered).
 */
export function cardPaymentMatchFor(read: CardPaymentReconciliationRead, transaction: CardTransaction): CardPaymentMatchView | null {
  if (transaction.kind !== 'payment' || transaction.amountMinor >= 0) return null;
  const { result } = read;
  const elsewhere = result.elsewhere.find((item) => item.paymentId === transaction.id);
  if (elsewhere) return { status: 'elsewhere', decisionId: elsewhere.decisionId };
  // The card's own rows say what they say whether or not checking is installed.
  const reversal = (id: string, dayOffset: number) => ({ ...paymentView(read.payments.get(id)!), dayOffset });
  const returned = result.returned.find((item) => item.paymentId === transaction.id);
  if (returned) return { status: 'returned', reversal: reversal(returned.reversalId, returned.dayOffset) };
  const unmatched = result.unmatchedPayments.find((item) => item.paymentId === transaction.id);
  const reversals = unmatched?.possibleReversals
    ? { possibleReversals: unmatched.possibleReversals.map((item) => reversal(item.reversalId, item.dayOffset)) }
    : null;
  if (!read.installed) return unmatched && reversals ? { status: 'unmatched', reason: unmatched.reason, possibleDebits: [], ...reversals } : null;
  if (transaction.status === 'pending') return { status: 'pending' };
  if (!isReconcilableCardPayment(transaction)) return null;
  const withOffset = (debitId: string, dayOffset: number) => ({ ...debitView(read.debits.get(debitId)!, read), dayOffset });
  const pair = result.pairs.find((item) => item.paymentId === transaction.id);
  if (pair) {
    return {
      status: pair.status, debit: withOffset(pair.debitId, pair.dayOffset),
      ...(pair.decisionId ? { decisionId: pair.decisionId } : {}), ...(pair.evidence ? { evidence: pair.evidence } : {}),
    };
  }
  const group = result.ambiguous.find((item) => item.paymentIds.includes(transaction.id));
  if (group) {
    const candidates = group.candidates.filter((item) => item.paymentId === transaction.id).map((item) => withOffset(item.debitId, item.dayOffset));
    return { status: 'ambiguous', candidates, otherPayments: group.paymentIds.length - 1 };
  }
  if (!unmatched) return null;
  return {
    status: 'unmatched',
    reason: unmatched.reason,
    possibleDebits: unmatched.possibleDebits.map((item) => withOffset(item.debitId, item.dayOffset)),
    ...reversals,
  };
}

const CONFIRM_REFUSALS: Readonly<Record<CardPaymentConfirmRefusal, string>> = Object.freeze({
  'not-a-payment': 'cardTransactionId must name a posted payment to a card',
  'not-a-debit': 'checkingTransactionId must name a posted checking debit',
  'amount-differs': 'the payment and the debit must have one amount and currency',
  'too-far-apart': `the payment and the debit must be at most ${CARD_PAYMENT_RECONCILIATION_RULES.confirmDays} days apart`,
  housing: 'a Bilt housing pull pays only a Bilt housing payment, and a Bilt housing payment is paid only by a Bilt housing pull',
});

export function createCardPaymentReconciliationRouter(
  repo: SqliteStateRepo,
  options: { log?: (line: string) => void; checkingLedger?: CheckingLedgerReader | null } = {},
): Router {
  const router = Router();
  const log = options.log ?? ((line: string) => console.error(line));
  const reader = options.checkingLedger ?? null;
  const body = readBody(BODY_LIMIT_BYTES);

  // As on the other card spending routes: card data in the query first (422); the store's own refusals as 400s, a
  // decision table not installed or a row already decided as a 409; database failures go on to the mount's handler.
  const handle = (fn: (req: Request, res: Response) => void): RequestHandler => (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      scanQuery(req, []);
      fn(req, res);
    } catch (caught) {
      const error = caught instanceof HttpError
        ? caught
        : isCardPaymentDecisionsNotInstalled(caught)
          ? new HttpError(409, NOT_INSTALLED)
          : isCardPaymentDecisionTaken(caught)
            ? new HttpError(409, (caught as Error).message)
            : cardGuardRefusal(caught, '$', log)
              ?? (caught instanceof HoldrRefusal ? repositoryError(caught, 'invalid card payment decision') : caught);
      if (error instanceof HttpError) {
        res.status(error.status).json({ error: error.message, ...error.extra });
        return;
      }
      next(error);
    }
  };

  /** Only a signed-in owner decides; the service principal never reaches these writes. */
  const owner = (req: Request): string => {
    const actorRef = sessionActorRef(req);
    if (actorRef === undefined) throw new HttpError(403, 'only a signed-in owner can decide card payments');
    return actorRef;
  };

  router.get('/spending/payment-reconciliation', handle((req, res) => {
    queryParams(req, []);
    const read = readCardPaymentReconciliation(repo, reader);
    res.json(cardPaymentReconciliationView(read, brokeragePaymentHints(repo, read)));
  }));

  router.get('/spending/payment-reconciliation/payments/:id', handle((req, res) => {
    const raw: unknown = req.params.id;
    const id = typeof raw === 'string' ? raw : '';
    if (looksLikeCardData(id)) throw new HttpError(422, CARD_DATA_MESSAGE, { paths: ['params.id'] });
    queryParams(req, []);
    if (!CARD_TRANSACTION_ID.test(id)) throw new HttpError(404, 'card transaction not found');
    const transaction = repo.getCardTransaction(id);
    if (!transaction) throw new HttpError(404, 'card transaction not found');
    const read = readCardPaymentReconciliation(repo, reader);
    res.json({
      checking: { installed: read.installed },
      decisions: { installed: read.decisionsInstalled },
      paymentMatch: cardPaymentMatchFor(read, transaction),
    });
  }));

  router.post('/spending/payment-reconciliation/decisions', ...body, handle((req, res) => {
    const input = jsonBody(req);
    rejectCardData(input, DECISION_KEYS);
    queryParams(req, []);
    const actorRef = owner(req);
    if (!isPlainObject(input)) throw new HttpError(400, 'body must be an object');
    if (Object.keys(input).some((key) => !DECISION_KEYS.has(key))) throw new HttpError(400, 'body has an unexpected key');
    const decision = input.decision;
    if (typeof decision !== 'string' || !(CARD_PAYMENT_DECISION_KINDS as readonly string[]).includes(decision)) {
      throw new HttpError(400, `decision must be one of ${CARD_PAYMENT_DECISION_KINDS.join(', ')}`);
    }
    const kind = decision as CardPaymentDecisionKind;
    const needsPayment = kind !== 'not-card-payment';
    const needsDebit = kind !== 'elsewhere';
    const cardTransactionId = input.cardTransactionId;
    const checkingTransactionId = input.checkingTransactionId;
    if (needsPayment !== (cardTransactionId !== undefined) || needsDebit !== (checkingTransactionId !== undefined)) {
      throw new HttpError(400, 'confirmed and rejected name a card payment and a checking debit; elsewhere a card payment; not-card-payment a checking debit');
    }
    if (needsPayment && (typeof cardTransactionId !== 'string' || !CARD_TRANSACTION_ID.test(cardTransactionId))) {
      throw new HttpError(400, 'cardTransactionId must be a card transaction id');
    }
    if (needsDebit && (typeof checkingTransactionId !== 'string' || !CHECKING_TRANSACTION_ID.test(checkingTransactionId))) {
      throw new HttpError(400, 'checkingTransactionId must be a checking transaction id');
    }
    requireDecisionsTable(repo);
    if (needsDebit && (reader === null || reader.installed() !== true)) throw new HttpError(409, CHECKING_NOT_INSTALLED);
    // Synchronous from here to the write, so no other request changes the rows in between.
    const payment = needsPayment ? repo.getCardTransaction(cardTransactionId as string) : null;
    if (needsPayment && !payment) throw new HttpError(404, 'card transaction not found');
    const debit = needsDebit ? reader!.listRows(ALL_DAYS).find((row) => row.id === checkingTransactionId) ?? null : null;
    if (needsDebit && !debit) throw new HttpError(404, 'checking transaction not found');
    if (payment && !isReconcilableCardPayment(payment)) throw new HttpError(400, CONFIRM_REFUSALS['not-a-payment']);
    if (debit && !isReconcilableCheckingDebit(debit)) throw new HttpError(400, CONFIRM_REFUSALS['not-a-debit']);
    if (payment && debit) {
      const refusal = cardPaymentConfirmRefusal(payment, debit, repo.getCardAccount(payment.cardAccountId)?.issuer ?? '');
      // A pair's answer, confirmed or rejected, needs a pair that could be one: one amount and currency, at most
      // confirmDays apart (an owner's word may reach past the rules' window), within Bilt's lanes. Refused, nothing is written.
      if (refusal) throw new HttpError(400, CONFIRM_REFUSALS[refusal]);
    }
    const amount = (payment ?? debit)!;
    const record: CardPaymentDecisionRecord = repo.recordCardPaymentDecision({
      decision: kind,
      cardTransactionId: payment?.id ?? null,
      checkingTransactionId: debit?.id ?? null,
      amountMinor: amount.amountMinor,
      currency: amount.currency,
      // The day gap the owner answered across, kept with the answer.
      dayOffset: payment && debit ? cardPaymentDayOffset(payment, debit) : null,
    }, { actorRef });
    res.status(201).json({ decision: record });
  }));

  router.delete('/spending/payment-reconciliation/decisions/:id', handle((req, res) => {
    const raw: unknown = req.params.id;
    const id = typeof raw === 'string' ? raw : '';
    if (looksLikeCardData(id)) throw new HttpError(422, CARD_DATA_MESSAGE, { paths: ['params.id'] });
    queryParams(req, []);
    const actorRef = owner(req);
    if (!DECISION_ID.test(id)) throw new HttpError(404, 'card payment decision not found');
    requireDecisionsTable(repo);
    const record = repo.revokeCardPaymentDecision(id, { actorRef });
    if (!record) throw new HttpError(404, 'card payment decision not found');
    res.json({ decision: record });
  }));

  return router;
}
