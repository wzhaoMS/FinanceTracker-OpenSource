import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CardPaymentReconciliationTotals } from '@finance-tracker/shared';

import {
  ANSWER_CONSEQUENCE,
  ambiguityGroupText,
  answerLabel,
  answerText,
  checkingAccountLabel,
  checkingCoverageText,
  countText,
  debitOffsetText,
  debitReasonText,
  debitText,
  EVIDENCE_LIST_UNDO_TEXT,
  EVIDENCE_UNDO_TEXT,
  knownPayeeLabel,
  notCardPaymentsText,
  pairEvidenceText,
  paymentAmbiguityText,
  paymentReasonText,
  paymentReviewCounts,
  paymentsStandingText,
  possibleReversalsText,
  reconciliationBreakdown,
  reconciliationCardLabel,
  reconciliationHeadline,
  reconciliationStatusLines,
  returnedPaymentText,
  reviewCountText,
  staleAnswersText,
} from './paymentReconciliation';

// Synthetic figures only.
const amount = (count: number, amountMinor = -count * 10_000) => ({ count, amountMinor });
interface Parts {
  matched?: number; confirmed?: number; ambiguous?: number; unmatched?: number; elsewhere?: number; returned?: number; pending?: number;
  debitsUnmatched?: number; housing?: number; notCard?: number;
}
function totals(patch: Parts = {}, currency = 'USD'): CardPaymentReconciliationTotals {
  const { matched = 0, confirmed = 0, ambiguous = 0, unmatched = 0, elsewhere = 0, returned = 0, pending = 0, debitsUnmatched = 0, housing = 0, notCard = 0 } = patch;
  return {
    currency,
    payments: {
      all: amount(matched + confirmed + ambiguous + unmatched + elsewhere + returned), matched: amount(matched), confirmed: amount(confirmed),
      ambiguous: amount(ambiguous), unmatched: amount(unmatched), elsewhere: amount(elsewhere), returned: amount(returned), pending: amount(pending),
    },
    debits: {
      all: amount(matched + confirmed + ambiguous + debitsUnmatched), matched: amount(matched), confirmed: amount(confirmed),
      ambiguous: amount(ambiguous), unmatched: amount(debitsUnmatched), notCardPayment: amount(notCard), biltHousing: amount(housing),
    },
  };
}
const counts = (...all: Array<Parts | CardPaymentReconciliationTotals>) =>
  paymentReviewCounts(all.map((item) => ('currency' in item ? item : totals(item)) as CardPaymentReconciliationTotals));
/** The leading count of each line, added up: the breakdown's parts add up to the posted payments. */
const added = (items: string[]) => items.reduce((sum, item) => sum + Number(/^\d+/.exec(item)![0]), 0);

test('the headline is the next action, counted in payments; withdrawals left over are counted apart, in withdrawals', () => {
  assert.equal(reconciliationHeadline(counts(), true), 'No posted card payments yet');
  assert.equal(reconciliationHeadline(counts({ ambiguous: 3 }), true), '3 payments to review');
  assert.equal(reconciliationHeadline(counts({ matched: 4, unmatched: 1 }), true), '1 payment to review');
  assert.equal(
    reconciliationHeadline(counts({ matched: 9, confirmed: 1, ambiguous: 2, unmatched: 1, elsewhere: 1, debitsUnmatched: 1, housing: 2 }), true),
    '3 payments and 3 withdrawals to review',
  );
  // Only withdrawals left: the headline says so, and the line under it where the payments stand.
  assert.equal(reconciliationHeadline(counts({ matched: 2, debitsUnmatched: 1 }), true), '1 withdrawal to review');
  assert.deepEqual(reconciliationStatusLines(counts({ matched: 2, debitsUnmatched: 1 }), true, 0), ['All card payments are matched']);
  assert.equal(reconciliationHeadline(counts({ matched: 2, elsewhere: 1, housing: 2 }), true), '2 withdrawals to review');
  assert.deepEqual(reconciliationStatusLines(counts({ matched: 2, elsewhere: 1, housing: 2 }), true, 0), ['No payments need review']);
  // With payments to review, the line under the headline adds nothing about them.
  assert.deepEqual(reconciliationStatusLines(counts({ ambiguous: 2, debitsUnmatched: 1 }), true, 0), []);
  assert.deepEqual([reviewCountText(3, 0), reviewCountText(3, 1), reviewCountText(0, 2), reviewCountText(1, 0), reviewCountText(0, 0)],
    ['3 payments', '3 payments and 1 withdrawal', '2 withdrawals', '1 payment', '']);
  assert.deepEqual([countText(1, 'payment'), countText(2, 'payment'), countText(0, 'withdrawal')], ['1 payment', '2 payments', '0 withdrawals']);
});

test('matched means matched: a payment paid from another account or returned by the card is settled, never called matched', () => {
  assert.equal(paymentsStandingText(counts({ matched: 12 })), 'All card payments are matched');
  assert.equal(paymentsStandingText(counts({ matched: 2, confirmed: 1 })), 'All card payments are matched');
  for (const parts of [{ matched: 3, elsewhere: 1 }, { matched: 3, returned: 1 }, { elsewhere: 2 }, { returned: 1 }, { matched: 1, elsewhere: 1, returned: 1 }]) {
    const settled = counts(parts);
    assert.equal(paymentsStandingText(settled), 'No payments need review', JSON.stringify(parts));
    assert.equal(reconciliationHeadline(settled, true), 'No payments need review', JSON.stringify(parts));
  }
  // Pending payments are checked only once they post: "every" is said of the posted ones, and the pending ones are said.
  assert.equal(reconciliationHeadline(counts({ matched: 3, pending: 1 }), true), 'All posted card payments are matched');
  assert.deepEqual(reconciliationStatusLines(counts({ matched: 3, pending: 1 }), true, 0), ['1 pending payment is checked once it posts']);
  assert.deepEqual(reconciliationStatusLines(counts({ ambiguous: 1, pending: 2 }), true, 0), ['2 pending payments are checked once they post']);
  assert.equal(reconciliationHeadline(counts({ pending: 1 }), true), 'No posted card payments yet');

  // Details: every posted payment in exactly one part, with its reason; the parts add up to the posted count.
  const mixed = counts({ matched: 4, confirmed: 1, ambiguous: 2, unmatched: 1, elsewhere: 1, returned: 1 });
  const breakdown = reconciliationBreakdown(mixed, true)!;
  assert.deepEqual(breakdown, {
    lead: 'Of 10 posted card payments:',
    items: [
      '5 matched to a checking withdrawal (1 confirmed by you)',
      '3 to review',
      '1 paid from another account, as you said',
      '1 returned by the card, so no withdrawal is owed',
    ],
  });
  assert.equal(added(breakdown.items), mixed.posted);
  for (const item of breakdown.items.slice(1)) assert.doesNotMatch(item, /matched/, item);
  assert.deepEqual(reconciliationBreakdown(counts({ matched: 1 }), true), { lead: 'Of 1 posted card payment:', items: ['1 matched to a checking withdrawal'] });
  assert.equal(reconciliationBreakdown(counts(), true), null);
  // Before checking is imported, a payment with no withdrawal waits for it: nothing is left to review yet.
  const waiting = counts({ unmatched: 3, elsewhere: 1, returned: 1 });
  assert.deepEqual(reconciliationBreakdown(waiting, false)!.items,
    ['3 waiting for checking history', '1 paid from another account, as you said', '1 returned by the card, so no withdrawal is owed']);
  assert.equal(added(reconciliationBreakdown(waiting, false)!.items), waiting.posted);
  assert.equal(reconciliationHeadline(waiting, false), 'No checking account is imported yet');
  assert.deepEqual([notCardPaymentsText(1), notCardPaymentsText(2)],
    ['1 withdrawal you said is not a card payment', '2 withdrawals you said are not card payments']);
  assert.equal(counts({ notCard: 2 }).notCardPayments, 2);
});

test('every currency counts: nothing is called settled while any currency has something left', () => {
  const euros = totals({ unmatched: 1 }, 'EUR');
  assert.equal(reconciliationHeadline(counts(totals({ matched: 3 }), euros), true), '1 payment to review');
  assert.equal(reconciliationHeadline(counts(totals({ matched: 3 }), totals({ matched: 1 }, 'EUR')), true), 'All card payments are matched');
  assert.equal(reconciliationHeadline(counts(totals({ matched: 3 }), totals({ elsewhere: 1 }, 'EUR')), true), 'No payments need review');
  assert.equal(reconciliationHeadline(counts(totals({ matched: 3 }), totals({ housing: 1 }, 'EUR')), true), '1 withdrawal to review');
  assert.equal(counts(totals({ matched: 3 }), euros).posted, 4);
});

test('a payment the card took back is its own settled part, and said in its details; before checking, the hints are said', () => {
  assert.equal(counts({ matched: 4, returned: 2 }).returned, 2);
  assert.equal(reconciliationHeadline(counts({ matched: 4, returned: 2 }), true), 'No payments need review');
  // An API that predates returned payments sends no such part: nothing is said of it.
  const { returned: _returned, ...older } = totals({ matched: 2 }).payments;
  const old = paymentReviewCounts([{ ...totals({ matched: 2 }), payments: older as CardPaymentReconciliationTotals['payments'] }]);
  assert.equal(old.returned, 0);
  assert.equal(reconciliationHeadline(old, true), 'All card payments are matched');
  assert.equal(returnedPaymentText(3), 'The card took this payment back 3 days after it: never paid, so no checking withdrawal is owed.');
  assert.equal(returnedPaymentText(1), 'The card took this payment back 1 day after it: never paid, so no checking withdrawal is owed.');
  assert.equal(returnedPaymentText(0), 'The card took this payment back the same day: never paid, so no checking withdrawal is owed.');
  assert.equal(possibleReversalsText(1),
    'A row on this card adds this amount back: if the card took this payment back, no checking withdrawal is owed. Holdr does not decide it by itself.');
  assert.match(possibleReversalsText(2), /^2 rows on this card add this amount back: /);
  // Before any checking is imported, the headline says so, and the line under it what the card's own rows may say.
  assert.equal(reconciliationHeadline(counts({ unmatched: 3, returned: 1 }), false), 'No checking account is imported yet');
  assert.deepEqual(reconciliationStatusLines(counts({ unmatched: 3, returned: 1 }), false, 2), ['2 payments may have been taken back by the card']);
  assert.deepEqual(reconciliationStatusLines(counts({ unmatched: 3 }), false, 1), ['1 payment may have been taken back by the card']);
  assert.deepEqual(reconciliationStatusLines(counts({ unmatched: 3, pending: 1 }), false, 0), []);
});

test('reasons say which side is missing what', () => {
  assert.equal(paymentReasonText('no-checking-account'), 'No checking account is imported yet.');
  assert.equal(paymentReasonText('checking-not-covered'), 'Checking history for this date is not imported yet.');
  assert.equal(paymentReasonText('no-checking-debit'), 'No checking withdrawal of this amount within 5 days. Paid from another account?');
  assert.equal(debitReasonText('no-card-account', 'Discover'), 'No Discover card is in Holdr.');
  assert.equal(debitReasonText('no-card-account', null), 'No card is in Holdr.');
  assert.equal(debitReasonText('card-not-covered', 'Citi'), 'The Citi card\'s history for this date is not imported yet.');
  assert.equal(debitReasonText('no-card-payment', 'American Express'), 'No American Express card payment of this amount within 5 days.');
});

test('a debit to Bilt from before Cardless issued the card says it paid the Wells Fargo-issued card', () => {
  const bilt = (date: string) => ({ payee: 'bilt' as const, date });
  const old = 'Before Feb 7, 2026, Wells Fargo issued the Bilt card: this paid it, and its payment is in the Wells Fargo card\'s history.';
  for (const reason of ['card-not-covered', 'no-card-account', 'no-card-payment'] as const) {
    assert.equal(debitReasonText(reason, 'Bilt', bilt('2026-02-06')), old, reason);
    assert.equal(debitReasonText(reason, 'Bilt', bilt('2024-09-23')), old, reason);
  }
  // From that day on, and for any other issuer, the reasons read as before.
  assert.equal(debitReasonText('card-not-covered', 'Bilt', bilt('2026-02-07')), 'The Bilt card\'s history for this date is not imported yet.');
  assert.equal(debitReasonText('card-not-covered', 'Wells Fargo', { payee: 'wellsfargo', date: '2026-01-05' }), 'The Wells Fargo card\'s history for this date is not imported yet.');
  assert.equal(debitReasonText('no-card-payment', 'Bilt', {}), 'No Bilt card payment of this amount within 5 days.');
});

test('accounts, coverage, withdrawals and offsets read plainly', () => {
  assert.equal(checkingAccountLabel({ label: 'Sample Bank Everyday Checking', last4: '0001' }), 'Sample Bank Everyday Checking ··0001');
  assert.equal(checkingAccountLabel({ label: 'Sample Checking', last4: null }), 'Sample Checking');
  assert.equal(checkingAccountLabel(undefined), 'Checking account');
  assert.equal(checkingCoverageText([]), 'No history imported yet');
  assert.equal(checkingCoverageText([{ start: '2023-10-01', end: '2026-09-30' }]), 'Oct 1, 2023 – Sep 30, 2026 · 36 months');
  assert.equal(
    checkingCoverageText([{ start: '2025-01-01', end: '2025-06-30' }, { start: '2025-08-01', end: '2025-12-31' }, { start: '2025-07-01', end: '2025-07-15' }]),
    'Jan 1 – Jul 15, 2025, Aug 1 – Dec 31, 2025 · 11 months (1 gap)',
  );
  assert.equal(debitText({ class: 'card-payment', payeeLabel: 'Citi' }), 'Paid to Citi');
  assert.equal(debitText({ class: 'card-payment', payeeLabel: null }), 'Paid to a card');
  assert.equal(debitText({ class: 'bilt-housing', payeeLabel: 'Bilt' }), 'Bilt housing pull (rent or mortgage)');
  assert.equal(debitText({ class: 'other', payeeLabel: null, descriptor: 'ONLINE TRANSFER TO SAMPLE SAVINGS' }), 'ONLINE TRANSFER TO SAMPLE SAVINGS');
  assert.equal(debitText({ class: 'other', payeeLabel: null }), 'Checking withdrawal');
  assert.equal(debitText({ class: 'card-payment', payee: 'unrecognized', payeeLabel: 'Unrecognized issuer' }), 'Paid to an issuer Holdr does not recognize');
  assert.equal(knownPayeeLabel({ payee: 'unrecognized', payeeLabel: 'Unrecognized issuer' }), null);
  assert.equal(reconciliationCardLabel({ issuer: 'amex', last4: '0003', last5: '90003' } as never), 'Amex ··0003');
  assert.equal(reconciliationCardLabel({ issuer: 'citi', last4: null } as never), 'Citi');
  assert.equal(reconciliationCardLabel(undefined), 'Unknown card');
  // A custom issuer slug's numbers never show, split up or not.
  for (const issuer of ['synthetic-12345', 'synthetic-1234567890', 'synthetic-1234-5678', 'synthetic-123-456-7890']) {
    assert.equal(reconciliationCardLabel({ issuer, last4: '0003' } as never), 'Synthetic ··0003', issuer);
  }
  assert.equal(reconciliationCardLabel({ issuer: '12345', last4: '0003' } as never), 'Card ··0003');
  assert.equal(knownPayeeLabel({ payee: 'several', payeeLabel: 'More than one issuer' }), null);
  assert.equal(debitText({ class: 'card-payment', payee: 'several', payeeLabel: 'More than one issuer' }), 'Paid to a card, naming more than one issuer');
  // A withdrawal is never called a card payment: that is the card's own row.
  for (const debit of [{ class: 'card-payment', payeeLabel: 'Citi' }, { class: 'card-payment', payeeLabel: null }] as const) {
    assert.doesNotMatch(debitText(debit), /card payment/i);
  }
  assert.equal(knownPayeeLabel({ payee: 'citi', payeeLabel: 'Citi' }), 'Citi');
  assert.equal(debitReasonText('no-card-account', knownPayeeLabel({ payee: 'unrecognized', payeeLabel: 'Unrecognized issuer' })), 'No card is in Holdr.');
  assert.deepEqual([debitOffsetText(0), debitOffsetText(1), debitOffsetText(-2)], ['same day', '1 day after', '2 days before']);
});

test('a group held for the owner is counted by what it holds, in payments and withdrawals, and never says "more than one"', () => {
  // Root 04:25Z: one payment and one withdrawal, several payments and one, one payment and several; and the plan's example.
  assert.equal(ambiguityGroupText(1, 1), '1 payment; 1 withdrawal could pay it. Holdr does not pair them by itself: confirm it if it did.');
  assert.equal(ambiguityGroupText(2, 1), '2 payments; 1 withdrawal could pay one of them. Say which one it paid.');
  assert.equal(ambiguityGroupText(1, 2), '1 payment; 2 withdrawals could pay it. Say which one did.');
  assert.equal(ambiguityGroupText(2, 3), '2 payments; 3 withdrawals could pay them. Say which withdrawal paid which payment.');
  assert.equal(ambiguityGroupText(3, 2), '3 payments; 2 withdrawals could pay them. Say which withdrawal paid which payment.');
  assert.deepEqual(paymentAmbiguityText(1, 0), { heading: 'Paid by this withdrawal?', text: 'This pairing needs your confirmation: Holdr does not pair it by itself.' });
  assert.deepEqual(paymentAmbiguityText(1, 1), {
    heading: 'Paid by this withdrawal?',
    text: 'One checking withdrawal of this amount fits, and 1 other card payment of this amount is close by: Holdr does not pick. Confirm it if it paid this one.',
  });
  assert.deepEqual(paymentAmbiguityText(2, 0), { heading: 'Which withdrawal paid it?', text: '2 checking withdrawals of this amount fit. Holdr does not pick: say which.' });
  assert.deepEqual(paymentAmbiguityText(3, 2), {
    heading: 'Which withdrawal paid it?',
    text: '3 checking withdrawals of this amount fit, and 2 other card payments of this amount are close by. Holdr does not pick: say which.',
  });
  for (const text of [ambiguityGroupText(1, 1), paymentAmbiguityText(1, 0).text, paymentAmbiguityText(1, 2).text, ambiguityGroupText(2, 1)]) {
    assert.doesNotMatch(text, /more than one|withdrawals could pay|withdrawals of this amount fit\b|[2-9] (checking )?withdrawals/i, text);
  }
  for (const [payments, withdrawals] of [[1, 1], [1, 2], [2, 1], [2, 3], [3, 2]]) {
    assert.doesNotMatch(ambiguityGroupText(payments, withdrawals), /more than one|debit|group/i);
  }
});

test('an answer is said by its rows, saved or undone, and its consequence is said beside every way to give one', () => {
  const paymentRow = { date: '2026-10-06', amountMinor: -30_000, currency: 'USD' };
  const withdrawalRow = { date: '2026-10-08', amountMinor: -30_000, currency: 'USD' };
  assert.equal(answerText('confirmed', paymentRow, withdrawalRow), 'the $300.00 payment on Oct 6, 2026 was paid by the withdrawal on Oct 8, 2026');
  assert.equal(answerText('rejected', paymentRow, withdrawalRow), 'the withdrawal on Oct 8, 2026 did not pay the $300.00 payment on Oct 6, 2026');
  assert.equal(answerText('elsewhere', { date: '2026-10-09', amountMinor: -9_999, currency: 'USD' }), 'the $99.99 payment on Oct 9, 2026 was paid from another account');
  assert.equal(answerText('not-card-payment', null, { date: '2026-10-05', amountMinor: -4_000, currency: 'USD' }), 'the $40.00 withdrawal on Oct 5, 2026 is not a card payment');
  // An earlier answer whose rows are gone is still said.
  assert.equal(answerText('rejected'), 'the withdrawal did not pay the payment');
  assert.equal(answerLabel('confirmed', 'row-missing'), 'Paid by this withdrawal (no longer fits: a row is gone)');
  assert.equal(answerLabel('rejected'), 'Not this one');
  assert.equal(answerLabel('elsewhere', 'conflict'), 'Paid from another account (no longer fits: an earlier answer took a row)');
  assert.equal(answerLabel('not-card-payment', 'housing'), 'Not a card payment (no longer fits: a Bilt housing payment and a Bilt housing pull pay only each other)');
  assert.equal(staleAnswersText(1), '1 earlier answer no longer fits its rows (a row changed or is gone) and does nothing: undo it under Details.');
  assert.equal(staleAnswersText(2), '2 earlier answers no longer fit their rows (a row changed or is gone) and do nothing: undo them under Details.');
  assert.equal(ANSWER_CONSEQUENCE, 'Answers can be undone and never change spending: card payments are transfers.');
});

test('a pair Holdr matched from evidence says why in plain words, and before its Undo what that saves (#231)', () => {
  // Root 04:24Z's display for interchangeable rows, verbatim; whichever pairing, the figures are the same.
  assert.equal(pairEvidenceText({ basis: 'interchangeable', payments: 2, pairedBy: 'cue' }),
    '2 payments of the same amount on this card that day; any pairing gives the same result.');
  assert.equal(pairEvidenceText({ basis: 'interchangeable', payments: 3, pairedBy: 'order' }),
    '3 payments of the same amount on this card that day; any pairing gives the same result.');
  assert.equal(pairEvidenceText({ basis: 'reference', proofs: 8 }),
    'Matched: this checking withdrawal carries the same reference as 8 other payments to this card.');
  assert.equal(pairEvidenceText({ basis: 'reference', proofs: 1 }),
    'Matched: this checking withdrawal carries the same reference as 1 other payment to this card.');
  // A remainder says only what was taken out: the rest of its group may still be held for the owner (code review).
  assert.equal(pairEvidenceText({ basis: 'remainder' }),
    'Matched: once the pairs matched by reference were taken out of its group, this was the only withdrawal left for it.');
  // Undo is the owner's "not this one": said before it is clicked, as the answer it saves, the pairing it takes away
  // and the whole group handed back (Astra's visual review); never that the rest matches again.
  assert.equal(EVIDENCE_UNDO_TEXT, 'Undo saves that this withdrawal did not pay this payment and hands the whole group back to you: '
    + 'Holdr then asks which withdrawal paid which payment, without this pairing.');
  assert.equal(EVIDENCE_LIST_UNDO_TEXT, 'Undo on a pair saves that its withdrawal did not pay its payment and hands the whole group '
    + 'back to you: Holdr then asks which withdrawal paid which payment, without that pairing.');
  for (const text of [EVIDENCE_UNDO_TEXT, EVIDENCE_LIST_UNDO_TEXT]) assert.doesNotMatch(text, /again|re-?match|automatic/i, text);
  for (const text of [EVIDENCE_UNDO_TEXT, EVIDENCE_LIST_UNDO_TEXT, pairEvidenceText({ basis: 'reference', proofs: 12 }), pairEvidenceText({ basis: 'remainder' })]) {
    assert.doesNotMatch(text, /\bdebit\b|need your word|\d{5}/i, text);
  }
});
