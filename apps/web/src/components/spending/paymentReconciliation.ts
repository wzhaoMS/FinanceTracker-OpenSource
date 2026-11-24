import {
  CARD_PAYMENT_RECONCILIATION_RULES,
  mergeCardCoverage,
  type CardAccount,
  type CardCoverageRange,
  type CardPaymentDecisionKind,
  type CardPaymentPairEvidence,
  type CardPaymentReconciliationTotals,
  type StaleCardPaymentDecision,
  type UnmatchedDebitReason,
  type UnmatchedPaymentReason,
} from '@finance-tracker/shared';

import type { CheckingAccountView, ReconciledDebit } from './spendingApi';
import { dateRangeLabel, daysBetween, formatMinor, issuerLabel, longDate } from './spendingFormat';

/**
 * Words for the card payment reconciliation (GET /spending/payment-reconciliation): every card payment matched one to
 * one with the checking withdrawal (a debit) that paid it. Every count names its unit, payments or withdrawals; a
 * group of them is counted only inside, by what it holds. Pure; the panel and a payment's details share them.
 */

const WINDOW = `${CARD_PAYMENT_RECONCILIATION_RULES.daysBefore === CARD_PAYMENT_RECONCILIATION_RULES.daysAfter
  ? `within ${CARD_PAYMENT_RECONCILIATION_RULES.daysAfter} days`
  : `from ${CARD_PAYMENT_RECONCILIATION_RULES.daysBefore} days before to ${CARD_PAYMENT_RECONCILIATION_RULES.daysAfter} days after`}`;

/** "1 payment", "3 payments": a count with its unit. */
export function countText(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/** What an answer does, said beside every way to give one. */
export const ANSWER_CONSEQUENCE = 'Answers can be undone and never change spending: card payments are transfers.';

/** Why a card payment has no checking withdrawal. */
export function paymentReasonText(reason: UnmatchedPaymentReason): string {
  switch (reason) {
    case 'no-checking-account': return 'No checking account is imported yet.';
    case 'checking-not-covered': return 'Checking history for this date is not imported yet.';
    default: return `No checking withdrawal of this amount ${WINDOW}. Paid from another account?`;
  }
}

/** Why a checking withdrawal that reads as a card payment has no card payment. */
export function debitReasonText(
  reason: UnmatchedDebitReason,
  payeeLabel: string | null,
  debit?: Partial<Pick<ReconciledDebit, 'payee' | 'date'>>,
): string {
  // A debit to Bilt from before Cardless issued the card paid the Wells Fargo-issued Bilt card: whatever the rules found
  // missing on the Bilt card, its payment is in the Wells Fargo card's history.
  const cardless = CARD_PAYMENT_RECONCILIATION_RULES.biltCardlessFrom;
  if (debit?.payee === 'bilt' && typeof debit.date === 'string' && debit.date < cardless) {
    return `Before ${longDate(cardless)}, Wells Fargo issued the Bilt card: this paid it, and its payment is in the Wells Fargo card's history.`;
  }
  const card = payeeLabel ? `${payeeLabel} card` : 'card';
  switch (reason) {
    case 'no-card-account': return payeeLabel ? `No ${payeeLabel} card is in Holdr.` : 'No card is in Holdr.';
    case 'card-not-covered': return `The ${card}'s history for this date is not imported yet.`;
    default: return `No ${card} payment of this amount ${WINDOW}.`;
  }
}

/** "Wells Fargo Everyday Checking ··2931": the account's name and the last four digits the bank shows. */
export function checkingAccountLabel(account: Pick<CheckingAccountView, 'label' | 'last4'> | undefined): string {
  if (!account) return 'Checking account';
  return account.last4 ? `${account.label} ··${account.last4}` : account.label;
}

/**
 * "Amex ··0003": a card as the reconciliation shows it, by its last four digits only, even where the card has five
 * (as Amex shows them), and by an issuer name with no number in it (a custom issuer slug's digits never show; a name
 * of nothing else reads "Card"). Spending's other labels keep theirs.
 */
export function reconciliationCardLabel(account: Pick<CardAccount, 'issuer' | 'last4'> | undefined): string {
  if (!account) return 'Unknown card';
  const name = numberFreeName(issuerLabel(typeof account.issuer === 'string' ? account.issuer : ''));
  return typeof account.last4 === 'string' && /^\d{4}$/.test(account.last4) ? `${name} ··${account.last4}` : name;
}

/** Digits (any script) with the separators numbers are written with between them. */
const NUMBER_GROUPS = /\p{N}+(?:[\s\p{Pd}./\\,_|'·∙⋅]+\p{N}+)*/gu;

/** A name with every number taken out; "Card" when no letter is left. */
function numberFreeName(text: string): string {
  const name = text.replace(NUMBER_GROUPS, ' ').replace(/\s+/g, ' ').trim();
  return /\p{L}/u.test(name) ? name : 'Card';
}

/** "Oct 1, 2023 – Oct 15, 2026 · 36 months", or the ranges when imports left gaps; nothing imported yet says so. */
export function checkingCoverageText(ranges: readonly CardCoverageRange[]): string {
  const merged = mergeCardCoverage(ranges);
  if (merged.length === 0) return 'No history imported yet';
  const days = merged.reduce((sum, range) => sum + daysBetween(range.start, range.end) + 1, 0);
  const months = Math.floor(days / 30.4375);
  const span = merged.map((range) => dateRangeLabel(range.start, range.end)).join(', ');
  return `${span} · ${months} ${months === 1 ? 'month' : 'months'}${merged.length > 1 ? ` (${merged.length - 1} ${merged.length === 2 ? 'gap' : 'gaps'})` : ''}`;
}

/** A debit's issuer, for words that name its card: none for a payee the rules do not recognize, or several. */
export function knownPayeeLabel(debit: Pick<ReconciledDebit, 'payeeLabel'> & Partial<Pick<ReconciledDebit, 'payee'>>): string | null {
  return debit.payee === 'unrecognized' || debit.payee === 'several' ? null : debit.payeeLabel;
}

/** A withdrawal as a line of text: whom it paid, else its masked descriptor. Never "card payment": that is the card's row. */
export function debitText(debit: Pick<ReconciledDebit, 'payeeLabel' | 'descriptor' | 'class'> & Partial<Pick<ReconciledDebit, 'payee'>>): string {
  if (debit.class === 'bilt-housing') return 'Bilt housing pull (rent or mortgage)';
  if (debit.payee === 'unrecognized') return 'Paid to an issuer Holdr does not recognize';
  if (debit.payee === 'several') return 'Paid to a card, naming more than one issuer';
  if (debit.payeeLabel) return `Paid to ${debit.payeeLabel}`;
  if (debit.class === 'card-payment') return 'Paid to a card';
  return debit.descriptor ?? 'Checking withdrawal';
}

/** A withdrawal's date against its payment's: "same day", "1 day after", "2 days before". */
export function debitOffsetText(dayOffset: number): string {
  if (dayOffset === 0) return 'same day';
  const count = Math.abs(dayOffset);
  return `${count} ${count === 1 ? 'day' : 'days'} ${dayOffset < 0 ? 'before' : 'after'}`;
}

/** A payment its card took back, in its details: when, and why no checking withdrawal is owed. */
export function returnedPaymentText(dayOffset: number): string {
  const when = dayOffset === 0 ? 'the same day' : `${debitOffsetText(dayOffset)} it`;
  return `The card took this payment back ${when}: never paid, so no checking withdrawal is owed.`;
}

/** Under a payment with no withdrawal: the card's own rows adding its amount back, which Holdr settles nothing on. */
export function possibleReversalsText(count: number): string {
  const rows = count === 1 ? 'A row on this card adds this amount back' : `${count} rows on this card add this amount back`;
  return `${rows}: if the card took this payment back, no checking withdrawal is owed. Holdr does not decide it by itself.`;
}

/**
 * Why Holdr matched a pair inside a group it holds for the owner, in plain words (#231): interchangeable rows (Root
 * 04:24Z's display, verbatim), a payer reference and how many proven pairs back it, or what was left of the group.
 */
export function pairEvidenceText(evidence: CardPaymentPairEvidence): string {
  switch (evidence.basis) {
    case 'interchangeable':
      return `${evidence.payments} payments of the same amount on this card that day; any pairing gives the same result.`;
    case 'reference':
      return `Matched: this checking withdrawal carries the same reference as ${countText(evidence.proofs, 'other payment')} to this card.`;
    default:
      return 'Matched: once the pairs matched by reference were taken out of its group, this was the only withdrawal left for it.';
  }
}

/**
 * What Undo does to a pair Holdr matched from evidence, said before it is clicked: it saves the owner's "not this one"
 * (the answer then shown: this withdrawal did not pay this payment), so that pairing is no longer offered, and the whole
 * group is the owner's again. Never that the rest matches again: no rule pairs any of its rows while the answer stands.
 * In a payment's details, of the pair shown.
 */
export const EVIDENCE_UNDO_TEXT = 'Undo saves that this withdrawal did not pay this payment and hands the whole group back to you: '
  + 'Holdr then asks which withdrawal paid which payment, without this pairing.';

/** The same, above a list of such pairs, each with its Undo. */
export const EVIDENCE_LIST_UNDO_TEXT = 'Undo on a pair saves that its withdrawal did not pay its payment and hands the whole group back '
  + 'to you: Holdr then asks which withdrawal paid which payment, without that pairing.';

/**
 * A group held for the owner, counted by what it holds, then what it asks: one payment and one withdrawal (the rules
 * never pair it by themselves: a withdrawal naming several issuers, or text they do not read), one payment and
 * several withdrawals, several payments and one withdrawal, or several of each. "More than one" is never said; each
 * side is counted.
 */
export function ambiguityGroupText(paymentCount: number, debitCount: number): string {
  if (paymentCount <= 1 && debitCount <= 1) {
    return '1 payment; 1 withdrawal could pay it. Holdr does not pair them by itself: confirm it if it did.';
  }
  if (paymentCount <= 1) return `1 payment; ${countText(debitCount, 'withdrawal')} could pay it. Say which one did.`;
  if (debitCount <= 1) return `${countText(paymentCount, 'payment')}; 1 withdrawal could pay one of them. Say which one it paid.`;
  return `${countText(paymentCount, 'payment')}; ${countText(debitCount, 'withdrawal')} could pay them. Say which withdrawal paid which payment.`;
}

/**
 * The same in one payment's details, from its own candidates and the other payments in its group: one withdrawal
 * alone asks for a confirmation, never "which".
 */
export function paymentAmbiguityText(candidateCount: number, otherPayments: number): { heading: string; text: string } {
  const others = otherPayments > 0
    ? `${otherPayments} other card ${otherPayments === 1 ? 'payment' : 'payments'} of this amount ${otherPayments === 1 ? 'is' : 'are'} close by`
    : null;
  if (candidateCount <= 1) {
    return {
      heading: 'Paid by this withdrawal?',
      text: others
        ? `One checking withdrawal of this amount fits, and ${others}: Holdr does not pick. Confirm it if it paid this one.`
        : 'This pairing needs your confirmation: Holdr does not pair it by itself.',
    };
  }
  return {
    heading: 'Which withdrawal paid it?',
    text: `${candidateCount} checking withdrawals of this amount fit${others ? `, and ${others}` : ''}. Holdr does not pick: say which.`,
  };
}

/**
 * Every currency's payments and withdrawals, counted together (a payment counts once in any currency). Each posted
 * payment is in exactly one of matched, ambiguous, unmatched, elsewhere and returned; pending ones are in none.
 */
export interface PaymentReviewCounts {
  /** Posted payments to a card. */
  posted: number;
  /** Matched to a checking withdrawal: by the rules, or confirmed by the owner. */
  matched: number;
  /** Of the matched, the ones the owner confirmed. */
  confirmed: number;
  /** In a group held for the owner. */
  ambiguous: number;
  /** With no checking withdrawal. */
  unmatched: number;
  /** Paid from another account, as the owner said. */
  elsewhere: number;
  /** Taken back by the card: no withdrawal is owed. */
  returned: number;
  /** Pending payments: checked only once they post. */
  pending: number;
  /** Withdrawals left over: ones reading as card payments with no card payment, and Bilt housing pulls with no housing row. */
  withdrawals: number;
  /** Withdrawals the owner said are not card payments. */
  notCardPayments: number;
}

export function paymentReviewCounts(all: readonly CardPaymentReconciliationTotals[]): PaymentReviewCounts {
  const counts: PaymentReviewCounts = {
    posted: 0, matched: 0, confirmed: 0, ambiguous: 0, unmatched: 0, elsewhere: 0, returned: 0, pending: 0, withdrawals: 0, notCardPayments: 0,
  };
  for (const { payments, debits } of all) {
    counts.posted += payments.all.count;
    counts.matched += payments.matched.count + payments.confirmed.count;
    counts.confirmed += payments.confirmed.count;
    counts.ambiguous += payments.ambiguous.count;
    counts.unmatched += payments.unmatched.count;
    counts.elsewhere += payments.elsewhere.count;
    // Absent from APIs that predate returned payments.
    counts.returned += payments.returned?.count ?? 0;
    counts.pending += payments.pending?.count ?? 0;
    counts.withdrawals += debits.unmatched.count + debits.biltHousing.count;
    counts.notCardPayments += debits.notCardPayment?.count ?? 0;
  }
  return counts;
}

/** "3 payments", "3 payments and 1 withdrawal", "1 withdrawal": what is left for the owner, each in its own unit. */
export function reviewCountText(payments: number, withdrawals: number): string {
  const parts = [payments > 0 ? countText(payments, 'payment') : null, withdrawals > 0 ? countText(withdrawals, 'withdrawal') : null];
  return parts.filter((part): part is string => part !== null).join(' and ');
}

/**
 * Where the posted payments stand. "Matched" only when every one is matched to a checking withdrawal (with pending
 * ones, every posted one); settled otherwise (paid from another account, returned by the card), no review is needed,
 * and Details says why.
 */
export function paymentsStandingText(counts: PaymentReviewCounts): string {
  const left = counts.ambiguous + counts.unmatched;
  if (counts.posted === 0) return 'No posted card payments yet';
  if (left > 0) return `${countText(left, 'payment')} to review`;
  if (counts.matched === counts.posted && counts.elsewhere === 0 && counts.returned === 0) {
    return counts.pending > 0 ? 'All posted card payments are matched' : 'All card payments are matched';
  }
  return 'No payments need review';
}

/**
 * The panel's headline, the next action first: what is left to review, payments (and withdrawals, each counted in
 * its own unit); else where the payments stand. Before any checking is imported, that.
 */
export function reconciliationHeadline(counts: PaymentReviewCounts, checkingInstalled: boolean): string {
  if (!checkingInstalled) return 'No checking account is imported yet';
  const left = counts.ambiguous + counts.unmatched;
  if (left > 0 || counts.withdrawals > 0) return `${reviewCountText(left, counts.withdrawals)} to review`;
  return paymentsStandingText(counts);
}

/**
 * The lines under the headline, each in its own unit: where the payments stand when only withdrawals are left to
 * review, the pending payments (checked once they post), and before checking is imported, the payments a row on
 * their card may have taken back.
 */
export function reconciliationStatusLines(counts: PaymentReviewCounts, checkingInstalled: boolean, possiblyReturned: number): string[] {
  if (!checkingInstalled) {
    return possiblyReturned > 0 ? [`${countText(possiblyReturned, 'payment')} may have been taken back by the card`] : [];
  }
  const lines: string[] = [];
  if (counts.ambiguous + counts.unmatched === 0 && counts.withdrawals > 0) lines.push(paymentsStandingText(counts));
  if (counts.pending > 0) {
    lines.push(counts.pending === 1 ? '1 pending payment is checked once it posts' : `${counts.pending} pending payments are checked once they post`);
  }
  return lines;
}

/**
 * Under Details: every posted payment in exactly one part, with its accurate reason (a payment paid from another
 * account or returned by the card is never called matched), so the parts add up to the posted count. None while no
 * payment is posted.
 */
export function reconciliationBreakdown(counts: PaymentReviewCounts, checkingInstalled: boolean): { lead: string; items: string[] } | null {
  if (counts.posted === 0) return null;
  const review = counts.ambiguous + (checkingInstalled ? counts.unmatched : 0);
  const waiting = checkingInstalled ? 0 : counts.unmatched;
  const items = [
    counts.matched > 0
      ? `${counts.matched} matched to a checking withdrawal${counts.confirmed > 0 ? ` (${counts.confirmed} confirmed by you)` : ''}` : null,
    review > 0 ? `${review} to review` : null,
    waiting > 0 ? `${waiting} waiting for checking history` : null,
    counts.elsewhere > 0 ? `${counts.elsewhere} paid from another account, as you said` : null,
    counts.returned > 0 ? `${counts.returned} returned by the card, so no withdrawal is owed` : null,
  ];
  return { lead: `Of ${countText(counts.posted, 'posted card payment')}:`, items: items.filter((item): item is string => item !== null) };
}

/** The withdrawals the owner set aside, under Details. */
export function notCardPaymentsText(count: number): string {
  return count === 1 ? '1 withdrawal you said is not a card payment' : `${count} withdrawals you said are not card payments`;
}

/** The owner's answers that no longer fit their rows: they do nothing, and are undone under Details. */
export function staleAnswersText(count: number): string {
  return count === 1
    ? '1 earlier answer no longer fits its rows (a row changed or is gone) and does nothing: undo it under Details.'
    : `${count} earlier answers no longer fit their rows (a row changed or is gone) and do nothing: undo them under Details.`;
}

/** A row an answer names: a payment or a withdrawal, by its date and amount. */
interface AnsweredRow {
  date: string;
  amountMinor: number;
  currency: string;
}

const money = (row: AnsweredRow) => formatMinor(Math.abs(row.amountMinor), row.currency);

/**
 * What one answer says, by its rows' dates and amounts, for the line that confirms it was saved or undone: "the
 * $300.00 payment on Oct 6, 2026 was paid by the withdrawal on Oct 8, 2026".
 */
export function answerText(decision: CardPaymentDecisionKind, payment?: AnsweredRow | null, debit?: AnsweredRow | null): string {
  const thePayment = payment ? `the ${money(payment)} payment on ${longDate(payment.date)}` : 'the payment';
  const theWithdrawal = debit ? `the withdrawal on ${longDate(debit.date)}` : 'the withdrawal';
  switch (decision) {
    case 'confirmed': return `${thePayment} was paid by ${theWithdrawal}`;
    case 'rejected': return `${theWithdrawal} did not pay ${thePayment}`;
    case 'elsewhere': return `${thePayment} was paid from another account`;
    default: return `${debit ? `the ${money(debit)} withdrawal on ${longDate(debit.date)}` : 'the withdrawal'} is not a card payment`;
  }
}

/** One of the owner's earlier answers as its button said it, and why it does nothing now if it doesn't. */
export function answerLabel(decision: CardPaymentDecisionKind, stale?: StaleCardPaymentDecision['reason']): string {
  const said = decision === 'rejected' ? 'Not this one'
    : decision === 'confirmed' ? 'Paid by this withdrawal'
      : decision === 'elsewhere' ? 'Paid from another account' : 'Not a card payment';
  if (!stale) return said;
  const why = stale === 'row-missing' ? 'a row is gone' : stale === 'row-changed' ? 'a row changed'
    : stale === 'conflict' ? 'an earlier answer took a row' : 'a Bilt housing payment and a Bilt housing pull pay only each other';
  return `${said} (no longer fits: ${why})`;
}
