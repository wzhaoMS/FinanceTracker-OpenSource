import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AMAZON_TAXONOMY_NEEDS_REVIEW } from '@finance-tracker/shared';

import {
  freshMayMissText, freshNetDetailText, freshOrderTotalsNote, freshPricedIn, freshTotalsCaptured, freshTotalsMissingText,
} from './amazonFreshFormat';
import type { AmazonFresh, AmazonFreshCategory, AmazonFreshOrderSummary, AmazonFreshTotals } from './amazonFreshApi';

/** Synthetic values only. */

type Knowable = Pick<AmazonFresh, 'orders' | 'totals' | 'categories' | 'orderList'>;
const money = (currency: string, orderTotalMinor: number, lineMinor: number): AmazonFreshTotals => ({
  currency, orderTotalMinor, lineMinor, groceryMinor: 0, categorizedMinor: 0, suggestedMinor: 0, needsReviewMinor: lineMinor,
  refundMinor: 0, lineRefundMinor: 0, unattributedRefundMinor: 0, netLineMinor: lineMinor,
});
const unclassified = (currency: string, lines: number, amountMinor: number): AmazonFreshCategory => ({
  currency, category: AMAZON_TAXONOMY_NEEDS_REVIEW, group: 'needs-review', amountMinor, refundMinor: 0, netMinor: amountMinor, lines,
  refundedLines: 0, products: lines, orders: 1,
});
const listed = (n: number, total: { currency: string; amountMinor: number } | null, priced: number): AmazonFreshOrderSummary => ({
  ref: `amz-${String(n).padStart(48, '0')}`, date: '2026-10-12', total, lines: priced, priced, missing: 0, substituted: 0,
  unreadable: 0, unreadRows: priced ? 0 : 1, lineTotal: null, complete: priced > 0, reconciled: false, refund: null,
});
const counted = (count: number, withTotal: number) => ({ count, withTotal, complete: 0, reconciled: 0, refunded: 0, unreadable: 0, noLines: 0 });
/** Two currencies: a USD order and a EUR order, each with what was captured of it. */
const twoCurrencies = (usd: { total: number | null; line: number | null }): Knowable => ({
  orders: counted(2, 1 + (usd.total === null ? 0 : 1)),
  totals: [money('USD', usd.total ?? 0, usd.line ?? 0), money('EUR', 100, 100)],
  categories: [...(usd.line === null ? [] : [unclassified('USD', 1, usd.line)]), unclassified('EUR', 1, 100)],
  orderList: [listed(1, usd.total === null ? null : { currency: 'USD', amountMinor: usd.total }, usd.line === null ? 0 : 1),
    listed(2, { currency: 'EUR', amountMinor: 100 }, 1)],
});

test('whether a price or an order total was captured in a currency comes from its own records, never from a positive amount', () => {
  // A USD order with a $0.00 total and a $0.00 item, beside a EUR one: both captured, so both shown as $0.00.
  const zero = twoCurrencies({ total: 0, line: 0 });
  assert.deepEqual(freshPricedIn(zero, 'USD'), { priced: 1, unclassified: 1 });
  assert.equal(freshTotalsCaptured(zero, 'USD'), 'captured');
  // Its total captured but none of its items: the items stay unknown, whatever the EUR order has.
  const noItem = twoCurrencies({ total: 125, line: null });
  assert.deepEqual(freshPricedIn(noItem, 'USD'), { priced: 0, unclassified: 0 });
  assert.equal(freshTotalsCaptured(noItem, 'USD'), 'captured');
  // A $0.00 item captured but no order total: the total stays unknown, whatever the EUR order has.
  const noTotal = twoCurrencies({ total: null, line: 0 });
  assert.deepEqual(freshPricedIn(noTotal, 'USD'), { priced: 1, unclassified: 1 });
  assert.equal(freshTotalsCaptured(noTotal, 'USD'), 'none');
  assert.equal(freshTotalsCaptured(noTotal, 'EUR'), 'captured');
  // One currency: any order's total is in it, a $0.00 one included.
  const one: Knowable = { orders: counted(1, 1), totals: [money('USD', 0, 0)], categories: [unclassified('USD', 1, 0)],
    orderList: [listed(1, { currency: 'USD', amountMinor: 0 }, 1)] };
  assert.equal(freshTotalsCaptured(one, 'USD'), 'captured');
  assert.equal(freshTotalsCaptured({ ...one, orders: counted(1, 0), orderList: [listed(1, null, 1)] }, 'USD'), 'none');
  // Only the newest orders listed, none of them with a USD total, while older ones have totals in a currency the answer
  // doesn't name: the claim stays with the listed orders.
  const older = { ...noTotal, orders: counted(3, 2) };
  assert.equal(freshTotalsCaptured(older, 'USD'), 'none listed');
});

test('an order total not captured in the figures\' currency is said in it when the window has others', () => {
  assert.equal(freshTotalsMissingText('none', true, 'USD'), 'not captured for these orders');
  assert.equal(freshTotalsMissingText('none', false, 'USD'), 'not captured in USD');
  assert.equal(freshTotalsMissingText('none listed', false, 'USD'), 'not captured in USD for the listed orders');
});

test('the net item cost says how it adds up: items, less refunds, and the part not tied to an item whenever there is one', () => {
  const total = { lineMinor: 10634, unattributedRefundMinor: 500 };
  assert.equal(freshNetDetailText(total, 1158, 15, 2, 'USD'),
    '$106.34 for 15 items, less $11.58 in refunds on 2 orders, $5.00 of it not tied to an item.');
  assert.equal(freshNetDetailText({ ...total, unattributedRefundMinor: 0 }, 658, 15, 1, 'USD'),
    '$106.34 for 15 items, less $6.58 in refunds on 1 order.');
  assert.equal(freshNetDetailText({ lineMinor: 499, unattributedRefundMinor: 0 }, 0, 1, 0, 'USD'), '$4.99 for 1 item; no refunds for these orders.');
  // A refund that took nothing off the items (its order's delivery, say): said, never shown as an item refund.
  assert.equal(freshNetDetailText({ lineMinor: 499, unattributedRefundMinor: 0 }, 0, 1, 1, 'USD'),
    '$4.99 for 1 item; refunds on 1 order took nothing off the items.');
  // Refunded orders are counted across the window's currencies: with more than one, the sentence names none.
  assert.equal(freshNetDetailText(total, 1158, 15, null, 'USD'), '$106.34 for 15 items, less $11.58 in refunds, $5.00 of it not tied to an item.');
  // A captured $0.00 is a price like any other.
  assert.equal(freshNetDetailText({ lineMinor: 0, unattributedRefundMinor: 0 }, 0, 1, null, 'USD'), '$0.00 for 1 item; no refunds taken off them.');
});

test('the orders whose Item List isn\'t proven complete stay in view; none when every list is', () => {
  assert.equal(freshMayMissText({ count: 3, complete: 2 }), 'Items may be missing from 1 order');
  assert.equal(freshMayMissText({ count: 5, complete: 1 }), 'Items may be missing from 4 orders');
  assert.equal(freshMayMissText({ count: 3, complete: 3 }), null);
});

test('the orders\' own totals say what they include and which orders they cover, counts only for one currency', () => {
  assert.equal(freshOrderTotalsNote({ count: 3, withTotal: 3 }, true), 'for 3 Fresh orders, tax, delivery and tips included');
  assert.equal(freshOrderTotalsNote({ count: 1, withTotal: 1 }, true), 'for 1 Fresh order, tax, delivery and tips included');
  assert.equal(freshOrderTotalsNote({ count: 4, withTotal: 3 }, true),
    'for 3 of 4 Fresh orders (1 order without a captured total), tax, delivery and tips included');
  assert.equal(freshOrderTotalsNote({ count: 4, withTotal: 3 }, false), 'tax, delivery and tips included');
});
