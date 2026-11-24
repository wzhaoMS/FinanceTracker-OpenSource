import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseRoute } from '../../modes/route';
import { amazonPartLabel, amazonWholeRowReasonText } from '../spending/spendingFormat';
import type { AmazonHeldReason, AmazonMatch, AmazonSpending } from './amazonApi';
import {
  AMAZON_LIST_HREF,
  BENEFICIARY_LABELS,
  NON_CARD_LINES,
  SPENDING_WINDOW_WORDS,
  amazonOrderHref,
  candidateText,
  cardMatchFigure,
  groupMatches,
  heldReasonText,
  itemCategory,
  orderMatchStatus,
  paymentMethodText,
  plural,
  purchaseChannelText,
  refundCountText,
  refundObservationNote,
  refundText,
  shareText,
  spendingCategoryName,
  spendingCoverageLines,
  spendingRefundTaken,
  spendingCurrency,
  spendingWindowPhrase,
  summaryCountedLines,
  summaryLimit,
  summaryLineText,
} from './amazonFormat';

/** Synthetic values only. */

test('an order\'s card match is one plain line: linked, needs review, none, or not reported, never "none" from a gap', () => {
  const held = (reason: AmazonHeldReason, candidateCount: number): AmazonMatch =>
    ({ state: 'held', evidenceClass: 'unique-total-match', reason, candidateCount });
  const linked = (n: number): AmazonMatch => ({
    state: 'linked', evidenceClass: 'payment-event', cardTransactionId: `card-txn-${String(n).repeat(32)}`, cardAccountId: `card-acct-${'a'.repeat(32)}`,
  });
  assert.deepEqual(orderMatchStatus(undefined), { status: 'unreported', text: 'Card match not reported', linked: [] });
  assert.deepEqual(orderMatchStatus([]), { status: 'none', text: 'No card match', linked: [] });
  // A linked transaction may be the order's charge or a refund credit: "card transaction", never "charge".
  assert.deepEqual(orderMatchStatus([linked(1)]), { status: 'linked', text: 'Linked to a card transaction', linked: [linked(1)] });
  // Each card transaction once, however many matches name it.
  assert.deepEqual(orderMatchStatus([linked(1), linked(2), linked(1)]),
    { status: 'linked', text: 'Linked to 2 card transactions', linked: [linked(1), linked(2)] });
  // Any hold, alone or beside a linked transaction, needs review: its reason and candidates are the order page's, not the line's.
  for (const matches of [[held('ambiguous', 2)], Array.from({ length: 5 }, () => held('evidence-held', 0))]) {
    const status = orderMatchStatus(matches);
    assert.deepEqual(status, { status: 'review', text: 'Card match needs review', linked: [] });
    assert.doesNotMatch(status.text, /Held|candidate|×/);
  }
  assert.deepEqual(orderMatchStatus([held('no-candidate', 0), linked(3)]),
    { status: 'review', text: 'Card match needs review', linked: [linked(3)] });
});

test('the summary\'s figures say card matches and refund observations in plain words, and how they were counted folds', () => {
  // Card matches are the API's match counts (Amazon payment records), never said as orders.
  assert.deepEqual(cardMatchFigure(1, 2), { value: '1 linked', note: '2 need review' });
  assert.deepEqual(cardMatchFigure(1, 1), { value: '1 linked', note: '1 needs review' });
  assert.deepEqual(cardMatchFigure(1200, 0), { value: '1,200 linked', note: 'none need review' });
  // Observations, never unique refunds.
  assert.equal(refundObservationNote(2), '2 issued · a refund seen twice counts twice');
  assert.equal(refundObservationNote(1200), '1,200 issued · a refund seen twice counts twice');
  assert.deepEqual(summaryCountedLines({ paymentObservations: 4, unknownBeneficiary: 2, itemized: { rows: 1, parts: 2 } }), [
    'Payment records observed: 4',
    'Card charges itemized in Spending: 1, in 2 item parts',
    'Orders not assigned to anyone (For: Unknown): 2',
  ]);
  // An API that doesn't count itemized charges says nothing of them: never a guessed 0.
  assert.deepEqual(summaryCountedLines({ paymentObservations: 0, unknownBeneficiary: 0 }), [
    'Payment records observed: 0',
    'Orders not assigned to anyone (For: Unknown): 0',
  ]);
});

test('an order\'s page counts its refunds, says none only when the API reported none, and not reported otherwise', () => {
  const refund = (ref: string) => ({ ref, status: 'issued' as const, date: null, amount: null, destination: 'card' as const });
  assert.equal(refundCountText(undefined), 'Not reported');
  assert.equal(refundCountText([]), 'None observed');
  assert.equal(refundCountText([refund('r1'), refund('r2')]), '2');
});

test('the summary\'s limit stays in view: imported records only, and a history that may be incomplete unless every family is', () => {
  const family = (status: string) => ({ status, reason: 'synthetic', pages: 1, records: 1, rejected: 0 });
  const incomplete = 'Imported records only; order history may be incomplete.';
  // What the importer reports today: partial or held families.
  assert.deepEqual(summaryLimit({ orders: family('partial'), details: family('partial'), payments: family('held'), refunds: family('partial') }),
    { text: incomplete, complete: false });
  // No capture's coverage, or a family it doesn't report: never read as complete.
  assert.deepEqual(summaryLimit(null), { text: incomplete, complete: false });
  assert.deepEqual(summaryLimit({ orders: family('complete'), details: family('complete'), payments: family('complete') }),
    { text: incomplete, complete: false });
  assert.deepEqual(summaryLimit({ orders: family('complete'), details: family('complete'), payments: family('complete'), refunds: family('complete') }),
    { text: 'Imported records only.', complete: true });
});

test('a held order says why in fixed words, an ambiguous one in Spending\'s words for the same hold', () => {
  // Ambiguous either way (several charges for the order, or several orders for one charge) holds each candidate charge
  // as `match-held` in Spending: both views say it alike, true in both directions.
  assert.equal(heldReasonText('ambiguous'), amazonWholeRowReasonText('match-held'));
  assert.equal(heldReasonText('ambiguous'), 'more than one order or charge could match, so none is linked yet');
  assert.equal(heldReasonText('binding-held'), 'its payment method isn\'t bound to a Holdr card');
  assert.equal(heldReasonText('evidence-held'), 'there isn\'t enough payment evidence to match it');
  assert.equal(heldReasonText('no-candidate'), 'no card charge matches it');
  // Amazon's payment ledger: one payment for several orders links none of them alone.
  assert.equal(heldReasonText('multiple-orders'), 'its payment covers more than one order');
  assert.equal(candidateText(0), '0 candidate card charges');
  assert.equal(candidateText(1), '1 candidate card charge');
  assert.equal(candidateText(2), '2 candidate card charges');
});

test('holds alike are listed once with how many there were; a linked match always stays its own', () => {
  const held = (reason: AmazonHeldReason, candidateCount: number): AmazonMatch =>
    ({ state: 'held', evidenceClass: 'unique-total-match', reason, candidateCount });
  const linked = (n: number): AmazonMatch => ({
    state: 'linked', evidenceClass: 'unique-total-match', cardTransactionId: `card-txn-${String(n).repeat(32)}`, cardAccountId: `card-acct-${'a'.repeat(32)}`,
  });
  // Five holds word for word alike: one entry, counted five times.
  assert.deepEqual(groupMatches(Array.from({ length: 5 }, () => held('evidence-held', 0))), [{ match: held('evidence-held', 0), count: 5 }]);
  // A different reason, or the same reason with another candidate count, says something else: its own entry. Entries keep
  // the order their first match came in.
  assert.deepEqual(groupMatches([
    held('ambiguous', 2), held('evidence-held', 0), held('ambiguous', 2), held('ambiguous', 3), held('evidence-held', 0), held('ambiguous', 2),
  ]), [
    { match: held('ambiguous', 2), count: 3 },
    { match: held('evidence-held', 0), count: 2 },
    { match: held('ambiguous', 3), count: 1 },
  ]);
  // A linked match is one card charge: never merged, even beside holds.
  assert.deepEqual(groupMatches([linked(1), held('no-candidate', 0), linked(2), held('no-candidate', 0)]), [
    { match: linked(1), count: 1 },
    { match: held('no-candidate', 0), count: 2 },
    { match: linked(2), count: 1 },
  ]);
  assert.deepEqual(groupMatches([]), []);
});

test('an item\'s category names its source in Spending\'s words: yours, classified from its title, or reviewed', () => {
  assert.deepEqual(itemCategory({ category: 'Home', categorySource: 'item-override', confidence: null }),
    { name: 'Home', source: 'your category', tone: 'user' });
  assert.deepEqual(itemCategory({ category: 'Home', categorySource: 'agent-classification', confidence: 0.915 }),
    { name: 'Home', source: 'classified from its title, 92% sure', tone: 'agent' });
  assert.deepEqual(itemCategory({ category: 'Home', categorySource: 'agent-classification', confidence: null }),
    { name: 'Home', source: 'classified from its title', tone: 'agent' });
  assert.deepEqual(itemCategory({ category: 'Home', categorySource: 'reviewed-mapping', confidence: null }),
    { name: 'Home', source: 'reviewed category', tone: 'mapping' });
  // Exactly the words a card charge's items use in Spending, never a fork of them.
  for (const categorySource of ['item-override', 'agent-classification', 'reviewed-mapping'] as const) {
    assert.equal(itemCategory({ category: 'Home', categorySource, confidence: null }).source,
      amazonPartLabel({ classification: 'source', categorySource }), categorySource);
  }
  assert.deepEqual(itemCategory({ category: 'Home', categorySource: null, confidence: null }),
    { name: 'Home', source: 'source not reported', tone: 'unreported' });
  assert.deepEqual(itemCategory({ category: null, categorySource: null, confidence: null }),
    { name: 'Uncategorized', source: '', tone: 'uncategorized' });
  assert.deepEqual(itemCategory({ categorySource: null, confidence: null }),
    { name: 'Category not reported', source: '', tone: 'unreported' });
});

test('a refund shows its status, its amount as a refund when reported, and where it went only when known', () => {
  const usd = (amountMinor: number) => ({ currency: 'USD', amountMinor });
  assert.equal(refundText({ ref: 'r1', status: 'issued', date: '2026-09-20', amount: usd(-1299), destination: 'card' }),
    'Refund issued · $12.99 · to the card');
  assert.equal(refundText({ ref: 'r2', status: 'issued', date: null, amount: usd(500), destination: 'balance' }),
    'Refund issued · $5.00 · to the Amazon balance');
  assert.equal(refundText({ ref: 'r3', status: 'pending', date: null, amount: null, destination: 'unknown' }),
    'Refund pending · amount not reported · destination unknown');
  assert.equal(refundText({ ref: 'r4', status: 'unknown', date: null, amount: null, destination: 'points' }),
    'Refund, status unknown · amount not reported · to points');
});

test('gift cards, points and promotions are taken off the order; the total is not', () => {
  const usd = (amountMinor: number) => ({ currency: 'USD', amountMinor });
  assert.deepEqual(summaryLineText({ kind: 'gift-card', money: usd(1000) }), { label: 'Gift card applied', amount: '−$10.00' });
  assert.deepEqual(summaryLineText({ kind: 'rewards', money: usd(250) }), { label: 'Points & rewards applied', amount: '−$2.50' });
  assert.deepEqual(summaryLineText({ kind: 'promotion', money: usd(-300) }), { label: 'Promotions', amount: '−$3.00' });
  assert.deepEqual(summaryLineText({ kind: 'grand-total', money: usd(4250) }), { label: 'Order total', amount: '$42.50' });
  assert.deepEqual(summaryLineText({ kind: 'shipping', money: usd(0) }), { label: 'Shipping & handling', amount: '$0.00' });
  // A Fresh order's tip is added to the order and paid with it: never taken off, never outside card spending.
  assert.deepEqual(summaryLineText({ kind: 'tip', money: usd(200) }), { label: 'Tip', amount: '$2.00' });
  assert.equal(NON_CARD_LINES.has('tip'), false);
});

test('payment methods name a card by network and ending, and the rest by kind', () => {
  assert.equal(paymentMethodText({ kind: 'card', network: 'visa', last4: '0001' }), 'Visa ··0001');
  assert.equal(paymentMethodText({ kind: 'card', network: 'unknown', last4: '0002' }), 'Card ··0002');
  assert.equal(paymentMethodText({ kind: 'card', network: 'amex', last4: null }), 'Amex (ending not captured)');
  assert.equal(paymentMethodText({ kind: 'balance', network: 'unknown', last4: null }), 'Amazon balance');
  assert.equal(paymentMethodText({ kind: 'points', network: 'unknown', last4: null }), 'Points');
  assert.equal(paymentMethodText({ kind: 'unknown', network: 'unknown', last4: null }), 'Unknown payment method');
});

test('beneficiaries are the household\'s people or unknown, and counts read naturally', () => {
  assert.deepEqual(BENEFICIARY_LABELS, { alex: 'Alex', casey: 'Casey', joint: 'Joint', unknown: 'Unknown' });
  assert.equal(plural(1, 'order'), '1 order');
  assert.equal(plural(0, 'order'), '0 orders');
  assert.equal(plural(1200, 'record'), '1,200 records');
});

test('a Whole Foods store\'s receipt is said as such, never as an Amazon Fresh delivery; an ordinary order says nothing', () => {
  assert.equal(purchaseChannelText('whole-foods-in-store'), 'Whole Foods (in store)');
  assert.equal(purchaseChannelText(undefined), null);
});

test('an order\'s link opens its own page, and the list link the Amazon area', () => {
  const ref = `amz-${'ab'.repeat(24)}`;
  assert.deepEqual(parseRoute(amazonOrderHref(ref)), { mode: 'everyday', area: 'amazon', amazonOrder: ref });
  assert.deepEqual(parseRoute(AMAZON_LIST_HREF), { mode: 'everyday', area: 'amazon' });
});

/** A 60-day window's answer, parsed: made-up amounts. */
const SPENDING: AmazonSpending = {
  window: { key: '60D', from: '2026-08-21', to: '2026-10-19' },
  orders: { count: 18, withTotal: 17, itemsComplete: 16, noLines: 1, refunded: 2, linked: 12, held: 4, unmatched: 2 },
  cardCharges: { linked: 14, itemized: 3 },
  lines: { count: 45, priced: 42, noPrice: 2, noQuantity: 1, categorized: 30 },
  totals: [{ currency: 'USD', orderTotalMinor: 140000, itemsCompleteOrderTotalMinor: 129999, itemMinor: 123456, categorizedMinor: 100000 }],
  categories: [],
  products: [],
  version: null,
};

test('the windows read as the switch and the sentences say them, the year to date by its year', () => {
  assert.deepEqual(Object.values(SPENDING_WINDOW_WORDS).map((words) => words.label), ['30 days', '60 days', 'YTD', '1 year', '2 years']);
  assert.equal(SPENDING_WINDOW_WORDS['1Y'].title, 'The last 12 months, today included');
  assert.equal(spendingWindowPhrase({ key: '30D', from: '2026-09-20', to: '2026-10-19' }), 'in the last 30 days');
  assert.equal(spendingWindowPhrase({ key: 'YTD', from: '2026-01-01', to: '2026-10-19' }), 'in 2026 to date');
  assert.equal(spendingWindowPhrase({ key: '2Y', from: '2024-10-20', to: '2026-10-19' }), 'in the last 2 years');
  assert.equal(spendingCategoryName(null), 'Uncategorized');
  assert.equal(spendingCategoryName('Home'), 'Home');
});

test('a share is rounded down, so it says 100% only when it is all', () => {
  assert.equal(shareText(999, 1000), '99%');
  assert.equal(shareText(1000, 1000), '100%');
  assert.equal(shareText(0, 1000), '0%');
  assert.equal(shareText(5, 0), '');
});

test('the figures are shown in US dollars when there are any, else in the window\'s largest currency', () => {
  const total = (currency: string, itemMinor: number) => ({ currency, orderTotalMinor: itemMinor, itemsCompleteOrderTotalMinor: 0, itemMinor, categorizedMinor: 0 });
  assert.equal(spendingCurrency({ totals: [total('EUR', 900), total('USD', 100)] }), 'USD');
  assert.equal(spendingCurrency({ totals: [total('CAD', 100), total('EUR', 900)] }), 'EUR');
  assert.equal(spendingCurrency({ totals: [] }), null);
});

test('coverage says what the figures leave out and why, never a zero, so no total reads as complete when it is not', () => {
  assert.deepEqual(spendingCoverageLines(SPENDING, 'USD'), [
    'Items proven complete in 16 of 18 orders: $1,299.99 of $1,400.00 in order totals (92%)',
    'Not proven complete: 1 order, which may have more items than counted here',
    'Left out of item prices: 2 items without a price · 1 item without a quantity · 1 order whose items weren\'t captured',
    'Order totals leave out 1 order without a captured total',
    'Linked to a card charge: 12 of 18 orders · 4 held for review · 2 not matched',
    'Itemized in Spending: 3 of 14 linked card charges',
    '2 orders have a refund; refunds aren\'t taken off item prices',
  ]);
  const complete: AmazonSpending = {
    ...SPENDING,
    orders: { ...SPENDING.orders, withTotal: 18, itemsComplete: 18, noLines: 0, refunded: 0, linked: 18, held: 0, unmatched: 0 },
    cardCharges: { linked: 0, itemized: 0 },
    lines: { ...SPENDING.lines, noPrice: 0, noQuantity: 0, priced: 45 },
    totals: [{ ...SPENDING.totals[0], itemsCompleteOrderTotalMinor: 140000 },
      { currency: 'EUR', orderTotalMinor: 3000, itemsCompleteOrderTotalMinor: 3000, itemMinor: 3000, categorizedMinor: 0 }],
  };
  assert.deepEqual(spendingCoverageLines(complete, 'USD'), [
    'Items proven complete in 18 of 18 orders: $1,400.00 of $1,400.00 in order totals (100%)',
    'Linked to a card charge: 18 of 18 orders',
    'Also €30.00 of items in other currencies, not converted',
  ]);
});

test('coverage says what refunds took off and how, what was left out, and that each counted once', () => {
  const refunded: AmazonSpending = {
    ...SPENDING,
    orders: { ...SPENDING.orders, refunded: 3 },
    totals: [{ ...SPENDING.totals[0], refundMinor: 4500, itemRefundMinor: 2999, unattributedRefundMinor: 1000, netItemMinor: 119457 }],
    refunds: {
      policy: 'amazon-refund-attribution-v1',
      orders: { 'whole-order': 1, units: 1, partly: 0, unattributed: 1 },
      unattributed: { ambiguous: 1, promotion: 0 },
      sources: { 'order-summary': 2, ledger: 1 },
      excluded: { 'multiple-orders': 1, contradictory: 2, invalid: 0 },
      ledgerRefunds: 1, ledgerObservations: 2, refundTotals: 2, refundTotalObservations: 3,
      refundedProducts: { count: 1, listed: 1, truncated: false },
    },
  };
  const lines = spendingCoverageLines(refunded, 'USD');
  assert.deepEqual(lines.slice(6), [
    'Refunds on 3 orders: $29.99 off the items refunded · $10.00 not tied to an item, off the total only',
    'Amazon refunded $45.00 for them in all, tax and shipping included; a refund counts in the window of its order\'s date',
    'Not tied to an item: 1 order, more than one set of the order\'s items matches it',
    'Refunds left out, never counted: 1 covering several orders at once · 2 contradictory',
    'Each refund counted once: 1 ledger refund seen 2 times · 2 order Refund Totals seen 3 times',
  ]);
  assert.equal(lines.some((line) => line.includes('aren\'t taken off')), false);
  assert.equal(spendingRefundTaken(refunded.totals[0]), 3999);
  // No refund for these orders: nothing said of refunds.
  const none: AmazonSpending = { ...refunded, orders: { ...refunded.orders, refunded: 0 },
    refunds: { ...refunded.refunds!, orders: {}, unattributed: {}, sources: {}, excluded: {}, ledgerRefunds: 0, ledgerObservations: 0,
      refundTotals: 0, refundTotalObservations: 0 } };
  assert.equal(spendingCoverageLines(none, 'USD').some((line) => /refund/i.test(line)), false);
});
