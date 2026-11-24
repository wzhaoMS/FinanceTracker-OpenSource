import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RetailApiLine } from '@finance-tracker/shared/retail-api';

import { ApiError } from '../../services/api';
import { CostcoAnswerError } from './costcoApi';
import {
  captureText,
  channelCountsText,
  costcoErrorText,
  costcoMoney,
  fuelText,
  groupCostcoLines,
  heldText,
  itemCountText,
  lineKindText,
  lineTitle,
  metalDetailText,
  metalUncertainText,
  pageText,
  quantityText,
  receiptNameText,
  rowItemsText,
  rowSplitText,
  shipmentText,
  shownLineTitle,
  tenderKindsText,
  tenderText,
  totalsRows,
  underReviewText,
} from './costcoFormat';
import { lineRef, onlineDetailFixture, shipmentRef, warehouseDetailFixture, warehouseLinesFixture } from './costcoFixtures';

// Synthetic values only (costcoFixtures.ts).

test('cents read as dollars, and a negative amount, a refund\'s or a coupon\'s, with a minus sign', () => {
  assert.equal(costcoMoney(123456), '$1,234.56');
  assert.equal(costcoMoney(5), '$0.05');
  assert.equal(costcoMoney(0), '$0.00');
  assert.equal(costcoMoney(-0), '$0.00');
  assert.equal(costcoMoney(-1234), '−$12.34');
  assert.equal(costcoMoney(-10_000_000_000), '−$100,000,000.00');
});

test('a card reads with its network and last four as stated; any other tender by its kind', () => {
  assert.equal(tenderText({ kind: 'card', network: 'visa', last4: '0007' }), 'Card · Visa ···0007');
  assert.equal(tenderText({ kind: 'card-refund', network: 'mastercard', last4: '0011' }), 'Card refund · Mastercard ···0011');
  assert.equal(tenderText({ kind: 'card', network: 'unknown', last4: '0007' }), 'Card ···0007');
  assert.equal(tenderText({ kind: 'card', network: 'visa', last4: null }), 'Card · Visa (last four not stated)');
  assert.equal(tenderText({ kind: 'shop-card', network: 'unknown', last4: null }), 'Shop Card');
  assert.equal(tenderText({ kind: 'reward-certificate', network: 'unknown', last4: null }), 'Reward certificate');
  assert.equal(tenderKindsText(['card', 'debit', 'cash', 'shop-card', 'coupon']), 'Card, Debit, Cash, Shop Card, Coupon');
  assert.equal(tenderKindsText([]), 'No tender stated');
  // One receipt's own split, never anything added across receipts.
  assert.equal(rowSplitText({ cardSpendingMinor: 1500, otherMinor: 500 }), 'Card $15.00 · Other $5.00');
  assert.equal(rowSplitText({ cardSpendingMinor: -1234, otherMinor: 0 }), 'Card −$12.34 · Other $0.00');
});

test('each quarantine reason reads in its own plain words, marked under review', () => {
  const texts = (['duplicate-across-memberships', 'receipt-changed', 'policy-reread-changed', 'receipt-held-later'] as const).map(underReviewText);
  assert.equal(new Set(texts).size, 4);
  for (const text of texts) assert.match(text, /^Under review — [a-z][a-z ]+[a-z]$/);
  assert.equal(underReviewText('receipt-changed'), 'Under review — a later capture shows this receipt with different details');
});

test('counts, dates and names read as words', () => {
  assert.equal(itemCountText(1), '1 item');
  assert.equal(itemCountText(3), '3 items');
  assert.equal(rowItemsText({ channel: 'gas', itemLines: 0 }), 'Fuel');
  assert.equal(rowItemsText({ channel: 'warehouse', itemLines: 0 }), '0 items');
  assert.equal(heldText(1), '1 record held (not receipts)');
  assert.equal(heldText(1200), '1,200 records held (not receipts)');
  assert.equal(channelCountsText({ active: 12, quarantined: 0 }), '12 receipts');
  assert.equal(channelCountsText({ active: 12, quarantined: 1 }), '12 active, 1 under review');
  assert.equal(pageText(50, 50, 132), 'Receipts 51–100 of 132');
  assert.equal(pageText(0, 0, 0), '0 receipts');
  assert.equal(captureText('2026-11-03'), 'Captured through Nov 3, 2026');
  assert.equal(captureText(null), 'No capture imported yet');
  assert.equal(receiptNameText('online', 'sale', '2026-10-20'), 'online order of Oct 20, 2026');
  assert.equal(receiptNameText('warehouse', 'refund', '2026-10-05', true), 'Warehouse refund · Oct 5, 2026');
});

test('a line reads as stated: its title, else its item number; quantity, fuel, metal facts and the guard\'s flag', () => {
  const [widget, coupon, silver] = warehouseLinesFixture();
  assert.equal(lineTitle(widget), 'SAMPLE WIDGET');
  assert.equal(lineTitle({ kind: 'item', title: null, itemNumber: '7654321' }), 'Item 7654321');
  assert.equal(lineTitle({ kind: 'item', title: null, itemNumber: null }), 'Item (title not shown)');
  assert.equal(lineTitle(coupon), 'Item 1234567');
  assert.equal(shownLineTitle({ kind: 'coupon', title: null, itemNumber: null }), null);
  assert.equal(shownLineTitle({ kind: 'item', title: null, itemNumber: null }), 'Item (title not shown)');
  assert.equal(lineKindText(widget, false), null);
  assert.equal(lineKindText(coupon, false), 'Coupon');
  assert.equal(lineKindText({ kind: 'coupon', couponFor: null }, false), 'Coupon on the whole receipt');
  assert.equal(lineKindText({ kind: 'fee', couponFor: null }, true), 'Fee for a line not on this receipt');
  assert.equal(quantityText({ quantity: 2, unitPriceMinor: 499 }), '2 × $4.99');
  assert.equal(quantityText({ quantity: null, unitPriceMinor: null }), null);
  assert.equal(quantityText({ quantity: 3, unitPriceMinor: null }), 'Qty 3');
  assert.equal(fuelText({ gallons: '13.203', unitPrice: '3.459' }), '13.203 gal at $3.459/gal');
  assert.equal(fuelText({ gallons: '13.203', unitPrice: null }), '13.203 gal');
  assert.equal(fuelText({ gallons: null, unitPrice: null }), 'Gallons and price not stated');
  assert.equal(metalDetailText(silver.metal!), 'Silver · round · 1 ozt');
  assert.equal(metalUncertainText({ metal: null, evidence: [] }), 'Uncertain metal: its title names a metal, but it didn\'t read as a precious metal.');
  assert.equal(metalDetailText({ metal: 'XAU', form: 'bar', statedWeight: { value: '1', unit: 'ozt' }, pack: 'single' }), 'Gold · bar · 1 ozt');
  assert.equal(metalDetailText({ metal: null, form: null, statedWeight: null, pack: 'multiple' }), 'Metal not named · more than one piece');
  assert.equal(metalUncertainText({ metal: 'XAU', evidence: ['purity', 'bullion-word'] }),
    'Uncertain metal: its title names gold with a purity and a bullion word, but it didn\'t read as a precious metal.');
});

test('a receipt\'s totals are its own, as stated: one it doesn\'t state is left out, never $0.00', () => {
  assert.deepEqual(totalsRows(warehouseDetailFixture().totals).map(({ label, amount }) => `${label} ${amount}`),
    ['Subtotal $9.50', 'Instant savings (in the lines above) $3.00', 'Tax $0.50', 'Total $10.00']);
  assert.deepEqual(totalsRows(onlineDetailFixture().totals).map(({ label }) => label),
    ['Subtotal', 'Discount', 'Shipping', 'Fees', 'Tax', 'Shop Card applied', 'Total']);
});

test('a shipment reads its carrier and dates; an estimate only while no delivery is stated', () => {
  const shipment = { shipmentRef: shipmentRef(1), shippedDate: '2026-10-21', deliveredDate: '2026-10-23', estimatedArrivalDate: '2026-10-24',
    carrier: 'ups' as const };
  assert.equal(shipmentText(shipment), 'UPS · shipped Oct 21, 2026 · delivered Oct 23, 2026');
  assert.equal(shipmentText({ ...shipment, deliveredDate: null }), 'UPS · shipped Oct 21, 2026 · expected Oct 24, 2026');
  assert.equal(shipmentText({ ...shipment, carrier: null, shippedDate: null, deliveredDate: null, estimatedArrivalDate: null }), 'Carrier not stated');
});

/** A group's lines as refs: the line, then what sits under it. */
const shape = (lines: RetailApiLine[]) => groupCostcoLines(lines).map((group) => ({
  line: group.line.lineRef, under: group.children.map((child) => child.lineRef), orphan: group.orphan,
}));

test('lines keep the receipt\'s order, each coupon under its item and each fee under its parent; a receipt coupon stays', () => {
  assert.deepEqual(shape(warehouseLinesFixture()), [
    { line: lineRef(1), under: [lineRef(2)], orphan: false },
    { line: lineRef(3), under: [], orphan: false },
    { line: lineRef(4), under: [lineRef(5)], orphan: false },
    { line: lineRef(6), under: [], orphan: false },
    { line: lineRef(7), under: [], orphan: false },
  ]);
});

test('no line is ever dropped: a coupon before its item, a coupon of a fee, an orphan and a loop all stay, each once', () => {
  const item = (n: number): RetailApiLine => ({ ...warehouseLinesFixture()[0], lineRef: lineRef(n) });
  const coupon = (n: number, target: string | null): RetailApiLine => ({ ...warehouseLinesFixture()[1], lineRef: lineRef(n), couponFor: target });
  const fee = (n: number, parent: string | null): RetailApiLine => ({ ...warehouseLinesFixture()[4], lineRef: lineRef(n), feeOf: parent });
  const lines = [
    coupon(20, lineRef(21)), // before the item it discounts
    item(21),
    fee(22, lineRef(21)),
    coupon(23, lineRef(22)), // a coupon of the item's fee: under the item, after the fee
    coupon(24, lineRef(99)), // its line isn't on the receipt
    fee(25, lineRef(98)),
    coupon(26, lineRef(26)), // itself
    coupon(27, lineRef(28)), // a loop
    coupon(28, lineRef(27)),
    fee(29, null),
  ];
  const groups = shape(lines);
  assert.deepEqual(groups, [
    { line: lineRef(21), under: [lineRef(20), lineRef(22), lineRef(23)], orphan: false },
    { line: lineRef(24), under: [], orphan: true },
    { line: lineRef(25), under: [], orphan: true },
    { line: lineRef(26), under: [], orphan: true },
    { line: lineRef(28), under: [lineRef(27)], orphan: true },
    { line: lineRef(29), under: [], orphan: false },
  ]);
  const shown = groups.flatMap((group) => [group.line, ...group.under]);
  assert.deepEqual([...shown].sort(), lines.map((line) => line.lineRef).sort());
});

test('what failed is said in fixed words, never the server\'s text', () => {
  const conflict = (reason: string) => new ApiError(409, 'Conflict', JSON.stringify({ error: 'SAMPLE SERVER TEXT 0007', reason }));
  assert.equal(costcoErrorText(conflict('schema-conflict'), 'receipts'), 'The retail tables on this Holdr have another shape, so nothing was read.');
  assert.match(costcoErrorText(conflict('retail-reserved-value'), 'receipts'), /reserved for a later rule/);
  assert.equal(costcoErrorText(conflict('reserved-value'), 'receipts'), 'Holdr refused to read the Costco receipts.');
  assert.equal(costcoErrorText(new ApiError(404, 'Not Found', '{"error":"SAMPLE SERVER TEXT"}'), 'receipt'), 'This receipt isn\'t in Holdr.');
  assert.equal(costcoErrorText(new ApiError(404, 'Not Found', ''), 'receipts'), 'This Holdr doesn\'t serve Costco receipts.');
  assert.match(costcoErrorText(new ApiError(403, 'Forbidden', '{"error":"SAMPLE SERVER TEXT"}'), 'receipts'), /owner/);
  assert.equal(costcoErrorText(new ApiError(500, 'Internal Server Error', 'SAMPLE SERVER TEXT'), 'receipts'),
    'Holdr couldn\'t load the Costco receipts (HTTP 500).');
  assert.match(costcoErrorText(new CostcoAnswerError('line'), 'receipt'), /couldn't read this answer/);
  assert.match(costcoErrorText(new TypeError('SAMPLE SERVER TEXT'), 'receipts'), /Check the connection/);
  for (const error of [conflict('schema-conflict'), new ApiError(500, 'x', 'SAMPLE SERVER TEXT'), new TypeError('SAMPLE SERVER TEXT')]) {
    assert.doesNotMatch(costcoErrorText(error, 'receipts'), /SAMPLE/);
  }
});
