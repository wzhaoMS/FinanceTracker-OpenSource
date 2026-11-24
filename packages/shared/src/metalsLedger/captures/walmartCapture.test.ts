import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SYNTHETIC_WALMART_CAPTURED_AT,
  SYNTHETIC_WALMART_CARD,
  SYNTHETIC_WALMART_GIFT_CARD,
  SYNTHETIC_WALMART_SELLER,
  SYNTHETIC_WALMART_SELLER_ID,
  SYNTHETIC_WALMART_STORE,
  SYNTHETIC_WALMART_TRACKING,
  syntheticSensitiveValues,
  syntheticWalmartCapture,
  syntheticWalmartDisplayId,
  syntheticWalmartOrderId,
  syntheticWalmartSpec,
  type SyntheticWalmartCapture,
} from './__fixtures__/walmartCapture.js';
import { CAPTURE_MAX_ISSUES, type CaptureIssue } from './captureRead.js';
import { readWalmartCapture, readWalmartRawDetail, walmartRawComparable, type WalmartCapture, type WalmartOrder } from './walmartCapture.js';

type Json = Record<string, unknown>;

/** The object at a path of keys and indices in a parsed file, to change for a test. */
function at(value: unknown, ...path: Array<string | number>): Json {
  let current = value;
  for (const key of path) current = (current as Json)[key];
  return current as Json;
}

const fresh = (): SyntheticWalmartCapture => syntheticWalmartCapture(syntheticWalmartSpec());

function readOk(json: unknown): WalmartCapture {
  const read = readWalmartCapture(json);
  if (!read.ok) assert.fail(`unexpected issues: ${JSON.stringify(read.issues)}`);
  return read.capture;
}

function rawOk(json: unknown, orderId: string): WalmartOrder {
  const read = readWalmartRawDetail(json, orderId);
  if (!read.ok) assert.fail(`unexpected issues: ${JSON.stringify(read.issues)}`);
  return read.order;
}

function issuesOf(read: { ok: true } | { ok: false; issues: CaptureIssue[] }): CaptureIssue[] {
  if (read.ok) assert.fail('read without an issue');
  return read.issues;
}

/** Issues are value-free, so a failure may print them. */
function assertIssue(issues: CaptureIssue[], path: string, message: RegExp): void {
  assert.ok(issues.some((issue) => issue.path === path && message.test(issue.message)), `no issue at ${path} matching ${message}: ${JSON.stringify(issues)}`);
}

describe('Walmart captures: the consolidated file', () => {
  it('reads every order into the typed shape, money as integer cents', () => {
    const capture = readOk(fresh().consolidated);
    assert.equal(capture.schema, 'holdr-retail-capture/walmart@1');
    assert.deepEqual(capture.provenance, {
      capturedAt: SYNTHETIC_WALMART_CAPTURED_AT,
      list: { pages: 1, pageSize: 10, rowsSeen: 3, statedTotal: null, lastPageHasNext: false },
      details: { captured: 3, of: 3 },
    });
    assert.equal(capture.orders.length, 3);
    const [delivery, pickup, cancelled] = capture.orders;

    assert.equal(delivery.source, 'consolidated');
    assert.equal(delivery.orderKeyMaterial, syntheticWalmartOrderId(1));
    assert.equal(delivery.orderDate, '2025-03-01');
    assert.equal(delivery.orderDateRaw, '2025-03-01T10:15:00.000-05:00');
    assert.equal(delivery.orderAt, '2025-03-01T15:15:00.000Z');
    assert.equal(delivery.type, 'GLASS');
    assert.equal(delivery.isInStore, false);
    assert.equal(delivery.itemCount, 2);
    assert.deepEqual(delivery.statusTypes, ['DELIVERED']);
    const group = delivery.groups[0];
    assert.equal(group.groupId, '1');
    assert.equal(group.fulfillmentType, 'FC_DELIVERY');
    assert.equal(group.detailedGroupType, 'DELIVERY');
    assert.deepEqual(group.status, { type: 'DELIVERED', unlistedType: null, text: 'Delivered on Mar 04', eventDate: '2025-03-04' });
    assert.equal(group.deliveryDate, '2025-03-04');
    assert.equal(group.readyForPickupDate, null);
    assert.deepEqual(group.seller, {
      id: SYNTHETIC_WALMART_SELLER_ID, name: SYNTHETIC_WALMART_SELLER, isPro: true, shownAsMarketplaceSeller: true, shippedByWalmart: false,
    });
    // The whole item: the capture's own readings (isPreciousMetal, metal, weight) are not on it.
    assert.deepEqual(group.items[0], {
      lineId: '1', name: 'SAMPLE WIDGET', usItemId: '500000001', offerId: 'SAMPLEOFFER1X1', qty: 2,
      linePriceMinor: 123_456, unitPriceMinor: 61_728, unitPriceDerived: true,
    });
    assert.equal(group.items[1].linePriceMinor, 0);
    assert.deepEqual(delivery.amounts, {
      subTotalMinor: 123_456, taxMinor: 9_877, grandTotalMinor: 132_833, grandTotalWithTipsMinor: null, driverTipMinor: null,
      fees: [{ label: 'Shipping', amountMinor: 0 }],
      discounts: [{ label: 'Savings', amountMinor: -500 }],
      refunds: [{ label: 'Refund', amountMinor: -100 }],
      donations: [],
    });
    assert.deepEqual(delivery.payments, [
      { paymentType: 'CREDITCARD', cardType: 'AMEX', last4: SYNTHETIC_WALMART_CARD, chargedMinor: 122_833 },
      { paymentType: 'GIFTCARD', cardType: null, last4: null, chargedMinor: 10_000 },
    ]);
    assert.deepEqual(delivery.refundPayments, [{ paymentType: 'CREDITCARD', cardType: 'AMEX', last4: SYNTHETIC_WALMART_CARD, amountsMinor: [100] }]);
    assert.equal(delivery.chargeHistoryEntries, 2);
    assert.deepEqual(delivery.flags, { cancelled: false, partlyCancelled: false, refunded: true, returned: false });
    assert.equal(delivery.detailCaptured, true);
    assert.equal(delivery.detailCapturedAt, SYNTHETIC_WALMART_CAPTURED_AT);

    assert.equal(pickup.groups[0].detailedGroupType, 'PICKUP_CURBSIDE');
    assert.equal(pickup.groups[0].readyForPickupDate, '2025-04-12');
    assert.equal(pickup.groups[0].seller, null);
    assert.equal(pickup.amounts.grandTotalMinor, 907);
    assert.deepEqual(pickup.payments, [{ paymentType: 'PAYPAL', cardType: 'PAYPAL', last4: null, chargedMinor: 907 }]);

    assert.equal(cancelled.groups[0].status.type, 'CANCELED');
    assert.equal(cancelled.groups[0].seller?.id, '0', 'a numeric seller id is kept as text');
    assert.deepEqual(cancelled.groups[0].items[0], {
      lineId: '1', name: 'SAMPLE PATIO SET', usItemId: '500000001', offerId: 'SAMPLEOFFER3X1', qty: 1,
      linePriceMinor: null, unitPriceMinor: null, unitPriceDerived: false,
    });
    assert.equal(cancelled.amounts.driverTipMinor, 300);
    assert.equal(cancelled.amounts.grandTotalWithTipsMinor, 300);
    assert.deepEqual(cancelled.amounts.donations, [{ label: 'SAMPLE ROUND UP', amountMinor: 42 }]);
    assert.equal(cancelled.payments[0].chargedMinor, null, 'nothing charged');
    assert.equal(cancelled.flags?.cancelled, true);
  });

  it("keeps none of the capture's own readings, free text, tracking, store names or display numbers", () => {
    const text = JSON.stringify(readOk(fresh().consolidated));
    for (const dropped of [
      'SAMPLE-CODE', 'SAMPLE PARSE', 'isPreciousMetal', 'weightOztPerUnit', 'hasPreciousMetal', 'SAMPLE-STATUS',
      SYNTHETIC_WALMART_STORE, SYNTHETIC_WALMART_TRACKING, 'SAMPLE ORDER TITLE', 'SAMPLE CHARGE', 'SAMPLE PAYMENT MESSAGE',
      'SAMPLE DELIVERY MESSAGE', 'Ending in', syntheticWalmartDisplayId(1), SYNTHETIC_WALMART_GIFT_CARD,
    ]) {
      assert.ok(!text.includes(dropped), `the typed capture keeps ${dropped}`);
    }
  });
});

describe('Walmart captures: raw details', () => {
  it('maps each raw detail to the same typed order as the consolidated file', () => {
    const capture = fresh();
    const orders = readOk(capture.consolidated).orders;
    assert.equal(capture.rawDetails.length, orders.length);
    for (const raw of capture.rawDetails) {
      assert.equal(raw.name, `detail-${raw.orderId}.json`);
      const listed = orders.find((order) => order.orderKeyMaterial === raw.orderId);
      assert.ok(listed, 'the consolidated file lists the order');
      const detail = rawOk(raw.json, raw.orderId);
      assert.equal(detail.source, 'raw-detail');
      assert.deepEqual(walmartRawComparable(detail), walmartRawComparable(listed));
    }
  });

  it('states none of the fields only the order list or the capture gives', () => {
    const raw = fresh().rawDetails[0];
    const order = rawOk(raw.json, raw.orderId);
    assert.equal(order.orderKeyMaterial, raw.orderId);
    assert.equal(order.orderDate, '2025-03-01');
    for (const key of ['orderAt', 'timezone', 'type', 'isInStore', 'itemCount', 'statusTypes', 'refundPayments', 'chargeHistoryEntries', 'flags'] as const) {
      assert.equal(order[key], null, key);
    }
    assert.equal(order.groups[0].status.eventDate, null, "the status message's year is the capture's own inference");
    assert.equal(order.groups[0].status.text, 'Delivered on Mar 04');
    assert.deepEqual(order.groups[0].items.map((item) => [item.unitPriceMinor, item.unitPriceDerived]), [[null, false], [null, false]]);
    assert.equal(order.detailCaptured, true);
    assert.equal(order.detailCapturedAt, SYNTHETIC_WALMART_CAPTURED_AT);
    // A raw detail's comparable view is the raw record itself, without its source.
    const { source, ...rest } = order;
    assert.equal(source, 'raw-detail');
    assert.deepEqual(walmartRawComparable(order), rest);
  });

  it('reads an empty rfpDate as no ready-for-pickup date, as it reads null', () => {
    const raw = fresh().rawDetails[0];
    const group = at(raw.json, 'order', 'groups_2101', 0);
    for (const empty of ['', null]) {
      group.rfpDate = empty;
      assert.equal(rawOk(raw.json, raw.orderId).groups[0].readyForPickupDate, null);
    }
  });

  it('reads the groups list whatever version its key carries', () => {
    const capture = fresh();
    const keys = capture.rawDetails.map((raw) => Object.keys(at(raw.json, 'order')).find((key) => key.startsWith('groups')));
    assert.deepEqual(keys, ['groups_2101', 'groups', 'groups_2200']);
    for (const raw of capture.rawDetails) assert.equal(rawOk(raw.json, raw.orderId).groups.length, 1);
  });

  it('reads Free as zero cents, one fee object as a list, and refunds as negative cents', () => {
    const raw = fresh().rawDetails[0];
    assert.ok(!Array.isArray(at(raw.json, 'order', 'priceDetails').fees), 'the fixture gives the fees as one object');
    const order = rawOk(raw.json, raw.orderId);
    assert.deepEqual(order.amounts.fees, [{ label: 'Shipping', amountMinor: 0 }]);
    assert.equal(order.groups[0].items[1].linePriceMinor, 0);
    assert.equal(order.amounts.subTotalMinor, 123_456, 'thousands separators are dropped');
    assert.deepEqual(order.amounts.discounts, [{ label: 'Savings', amountMinor: -500 }]);
    assert.deepEqual(order.amounts.refunds, [{ label: 'Refund', amountMinor: -100 }]);
  });

  it('reads a minus after the dollar sign, and a price stated only in dollars', () => {
    const raw = fresh().rawDetails[0];
    at(raw.json, 'order', 'priceDetails', 'refund', 0).displayValue = '$-2.50';
    delete at(raw.json, 'order', 'priceDetails', 'subTotal').displayValue;
    const order = rawOk(raw.json, raw.orderId);
    assert.equal(order.amounts.refunds[0].amountMinor, -250);
    assert.equal(order.amounts.subTotalMinor, 123_456);
  });

  it('reads a grand total stated as orderTotal and a detailed type stated as derivedFulfillmentType', () => {
    const raw = fresh().rawDetails[1];
    assert.ok('orderTotal' in at(raw.json, 'order', 'priceDetails'));
    assert.ok('derivedFulfillmentType' in at(raw.json, 'order', 'groups', 0));
    const order = rawOk(raw.json, raw.orderId);
    assert.equal(order.amounts.grandTotalMinor, 907);
    assert.equal(order.groups[0].detailedGroupType, 'PICKUP_CURBSIDE');
  });

  it('keeps a card ending for a card payment only', () => {
    const raw = fresh().rawDetails[0];
    const order = rawOk(raw.json, raw.orderId);
    assert.deepEqual(order.payments.map((payment) => [payment.paymentType, payment.last4]), [['CREDITCARD', SYNTHETIC_WALMART_CARD], ['GIFTCARD', null]]);
  });
});

/** Each refusal: a change to the consolidated file, and the issue it must give. */
const CONSOLIDATED_REFUSALS: Array<{ name: string; change: (file: Json) => void; path: string; message: RegExp }> = [
  { name: 'another schema', change: (file) => { file.schema = 'holdr-retail-capture/walmart@2'; }, path: '$.schema', message: /^must be holdr-retail-capture\/walmart@1$/ },
  { name: 'another source', change: (file) => { at(file, 'provenance').source = 'example.com'; }, path: '$.provenance.source', message: /must be walmart\.com/ },
  { name: 'another currency', change: (file) => { at(file, 'provenance').currency = 'EUR'; }, path: '$.provenance.currency', message: /must be USD/ },
  { name: 'a capture time without a zone', change: (file) => { at(file, 'provenance').capturedAt = '2026-01-02T03:04:05'; }, path: '$.provenance.capturedAt', message: /ISO 8601/ },
  { name: 'a list count that is not a whole number', change: (file) => { at(file, 'provenance', 'list').rowsSeen = 2.5; }, path: '$.provenance.list.rowsSeen', message: /integer/ },
  { name: 'orders that are not a list', change: (file) => { file.orders = {}; }, path: '$.orders', message: /must be an array/ },
  { name: 'an order that is not an object', change: (file) => { (file.orders as unknown[])[1] = 'SAMPLE'; }, path: '$.orders[1]', message: /must be an object/ },
  { name: 'an order id that is not digits', change: (file) => { at(file, 'orders', 0).orderId = 'SAMPLE'; }, path: '$.orders[0].orderId', message: /digits/ },
  { name: 'a repeated order id', change: (file) => { at(file, 'orders', 1).orderId = syntheticWalmartOrderId(1); }, path: '$.orders[1].orderId', message: /repeats/ },
  { name: 'an order date that is not a real date', change: (file) => { at(file, 'orders', 0).orderDate = '2025-02-30'; }, path: '$.orders[0].orderDate', message: /real YYYY-MM-DD/ },
  { name: 'an order time without a zone', change: (file) => { at(file, 'orders', 0).orderAt = '2025-03-01 15:15'; }, path: '$.orders[0].orderAt', message: /ISO 8601/ },
  { name: 'status types that are not a list', change: (file) => { at(file, 'orders', 0).statusTypes = 'DELIVERED'; }, path: '$.orders[0].statusTypes', message: /must be an array/ },
  {
    name: 'a fulfillment type outside the closed list', change: (file) => { at(file, 'orders', 0, 'groups', 0).fulfillmentType = 'DRONE'; },
    path: '$.orders[0].groups[0].fulfillmentType', message: /allowed values/,
  },
  {
    name: 'a detailed group type outside the closed list', change: (file) => { at(file, 'orders', 0, 'groups', 0).detailedGroupType = 'LOCKER'; },
    path: '$.orders[0].groups[0].detailedGroupType', message: /allowed values/,
  },
  {
    name: 'a group status type that is not text', change: (file) => { at(file, 'orders', 0, 'groups', 0, 'status').type = 3; },
    path: '$.orders[0].groups[0].status.type', message: /must be a string/,
  },
  {
    name: 'an event date that is not a real date', change: (file) => { at(file, 'orders', 0, 'groups', 0, 'status').eventDate = 'Mar 04'; },
    path: '$.orders[0].groups[0].status.eventDate', message: /real YYYY-MM-DD/,
  },
  { name: 'a seller that is not an object', change: (file) => { at(file, 'orders', 0, 'groups', 0).seller = 'SAMPLE'; }, path: '$.orders[0].groups[0].seller', message: /must be an object/ },
  {
    name: 'a quantity that is not a whole number', change: (file) => { at(file, 'orders', 0, 'groups', 0, 'items', 0).qty = 1.5; },
    path: '$.orders[0].groups[0].items[0].qty', message: /integer/,
  },
  {
    name: 'money the capture could not read', change: (file) => { at(file, 'orders', 0, 'amounts', 'subTotal').cents = null; },
    path: '$.orders[0].amounts.subTotal.cents', message: /could not read/,
  },
  { name: 'money in another currency', change: (file) => { at(file, 'orders', 0, 'amounts', 'tax').currency = 'CAD'; }, path: '$.orders[0].amounts.tax.currency', message: /must be USD/ },
  { name: 'money in fractions of a cent', change: (file) => { at(file, 'orders', 0, 'amounts', 'tax').cents = 98.5; }, path: '$.orders[0].amounts.tax.cents', message: /integer/ },
  { name: 'money without its raw text', change: (file) => { delete at(file, 'orders', 0, 'amounts', 'tax').raw; }, path: '$.orders[0].amounts.tax.raw', message: /is missing/ },
  {
    name: 'a positive refund', change: (file) => { at(file, 'orders', 0, 'amounts', 'refunds', 0, 'amount').cents = 100; },
    path: '$.orders[0].amounts.refunds[0].amount.cents', message: /must not be positive/,
  },
  { name: 'fees that are not a list', change: (file) => { at(file, 'orders', 0, 'amounts').fees = {}; }, path: '$.orders[0].amounts.fees', message: /must be an array/ },
  { name: 'a payment type outside the closed list', change: (file) => { at(file, 'orders', 0, 'payments', 0).paymentType = 'CASH'; }, path: '$.orders[0].payments[0].paymentType', message: /allowed values/ },
  { name: 'a card type outside the closed list', change: (file) => { at(file, 'orders', 0, 'payments', 0).cardType = 'JCB'; }, path: '$.orders[0].payments[0].cardType', message: /allowed values/ },
  { name: 'a last four that is not four digits', change: (file) => { at(file, 'orders', 0, 'payments', 0).last4 = '12345'; }, path: '$.orders[0].payments[0].last4', message: /four digits/ },
  {
    name: 'two charged amounts on one payment',
    change: (file) => { (at(file, 'orders', 0, 'payments', 0).charged as unknown[]).push({ cents: 1, currency: 'USD', raw: '$0.01' }); },
    path: '$.orders[0].payments[0].charged', message: /at most one entry/,
  },
  { name: 'missing flags', change: (file) => { delete at(file, 'orders', 0).flags; }, path: '$.orders[0].flags', message: /is missing/ },
  { name: 'a flag that is not true or false', change: (file) => { at(file, 'orders', 0, 'flags').returned = 'no'; }, path: '$.orders[0].flags.returned', message: /true or false/ },
  { name: 'a detail time without a zone', change: (file) => { at(file, 'orders', 0).detailCapturedAt = '2026-01-02'; }, path: '$.orders[0].detailCapturedAt', message: /ISO 8601/ },
];

/** Each refusal: a change to the first raw detail, and the issue it must give. */
const RAW_REFUSALS: Array<{ name: string; change: (file: Json) => void; path: string; message: RegExp }> = [
  { name: 'a file without its order', change: (file) => { delete file.order; }, path: '$.order', message: /is missing/ },
  { name: 'a capture time without a zone', change: (file) => { file.capturedAt = '2026-01-02'; }, path: '$.capturedAt', message: /ISO 8601/ },
  { name: 'an order without priceDetails', change: (file) => { delete at(file, 'order').priceDetails; }, path: '$.order.priceDetails', message: /is missing/ },
  { name: 'an order without a groups list', change: (file) => { delete at(file, 'order').groups_2101; }, path: '$.order', message: /groups/ },
  {
    name: 'a payment with two charged values', change: (file) => { at(file, 'order', 'paymentMethods', 0).displayValues = ['$1.00', '$2.00']; },
    path: '$.order.paymentMethods[0].displayValues', message: /at most one entry/,
  },
  {
    name: 'money text it cannot read',
    change: (file) => {
      const tax = at(file, 'order', 'priceDetails', 'taxTotal');
      tax.displayValue = 'about a dollar';
      delete tax.value;
    },
    path: '$.order.priceDetails.taxTotal.displayValue', message: /money text/,
  },
  { name: 'a positive refund', change: (file) => { at(file, 'order', 'priceDetails', 'refund', 0).displayValue = '$1.00'; }, path: '$.order.priceDetails.refund[0]', message: /must not be positive/ },
  { name: 'fees that are neither a list nor a price value', change: (file) => { at(file, 'order', 'priceDetails').fees = 'Free'; }, path: '$.order.priceDetails.fees', message: /price value/ },
  {
    name: 'a payment type outside the closed list', change: (file) => { at(file, 'order', 'paymentMethods', 0).paymentType = 'CASH'; },
    path: '$.order.paymentMethods[0].paymentType', message: /allowed values/,
  },
  {
    name: 'a status type that is not text', change: (file) => { at(file, 'order', 'groups_2101', 0, 'status').statusType = { type: 'SHIPPED' }; },
    path: '$.order.groups[0].status.statusType', message: /must be a string/,
  },
  {
    name: 'a delivery date that does not start with a date', change: (file) => { at(file, 'order', 'groups_2101', 0).deliveryDate = 'Tuesday'; },
    path: '$.order.groups[0].deliveryDate', message: /start with a real YYYY-MM-DD date/,
  },
  {
    name: 'a quantity that is not a whole number', change: (file) => { at(file, 'order', 'groups_2101', 0, 'items', 0).quantity = 2.5; },
    path: '$.order.groups[0].items[0].quantity', message: /integer/,
  },
  {
    name: 'a ready-for-pickup date of blank text, not empty', change: (file) => { at(file, 'order', 'groups_2101', 0).rfpDate = ' '; },
    path: '$.order.groups[0].rfpDate', message: /start with a real YYYY-MM-DD date/,
  },
  {
    name: 'an empty delivery date (only rfpDate reads empty as absent)', change: (file) => { at(file, 'order', 'groups_2101', 0).deliveryDate = ''; },
    path: '$.order.groups[0].deliveryDate', message: /start with a real YYYY-MM-DD date/,
  },
  { name: 'an order date that starts with an unreal date', change: (file) => { at(file, 'order').orderDate = '2025-02-30T10:00:00Z'; }, path: '$.order.orderDate', message: /real YYYY-MM-DD/ },
];

describe('Walmart captures: refusals', () => {
  for (const refusal of CONSOLIDATED_REFUSALS) {
    it(`refuses a consolidated file with ${refusal.name}`, () => {
      const capture = fresh();
      refusal.change(capture.consolidated);
      assertIssue(issuesOf(readWalmartCapture(capture.consolidated)), refusal.path, refusal.message);
    });
  }

  for (const refusal of RAW_REFUSALS) {
    it(`refuses a raw detail with ${refusal.name}`, () => {
      const raw = fresh().rawDetails[0];
      refusal.change(raw.json);
      assertIssue(issuesOf(readWalmartRawDetail(raw.json, raw.orderId)), refusal.path, refusal.message);
    });
  }

  it('refuses a file that is not an object, or is missing', () => {
    assertIssue(issuesOf(readWalmartCapture('SAMPLE')), '$', /must be an object/);
    assertIssue(issuesOf(readWalmartCapture(undefined)), '$', /is missing/);
    assertIssue(issuesOf(readWalmartRawDetail([], syntheticWalmartOrderId(1))), '$', /must be an object/);
  });

  it('refuses an order id argument that is not digits', () => {
    const raw = fresh().rawDetails[0];
    assertIssue(issuesOf(readWalmartRawDetail(raw.json, `${raw.orderId}-1`)), 'orderId', /digits/);
  });

  it('collects every issue, not only the first', () => {
    const capture = fresh();
    at(capture.consolidated, 'orders', 0).orderId = 'SAMPLE';
    at(capture.consolidated, 'orders', 1, 'groups', 0).fulfillmentType = 'DRONE';
    at(capture.consolidated, 'orders', 2, 'payments', 0).cardType = 'JCB';
    at(capture.consolidated, 'orders', 2, 'amounts', 'tax').cents = null;
    const issues = issuesOf(readWalmartCapture(capture.consolidated));
    assert.deepEqual(issues.map((issue) => issue.path), [
      '$.orders[0].orderId',
      '$.orders[1].groups[0].fulfillmentType',
      '$.orders[2].amounts.tax.cents',
      '$.orders[2].payments[0].cardType',
    ]);
  });

  it(`lists at most ${CAPTURE_MAX_ISSUES} issues, the last saying there are more`, () => {
    const capture = fresh();
    const template = at(capture.consolidated, 'orders', 0);
    capture.consolidated.orders = Array.from({ length: 300 }, () => ({ ...template, orderId: 'SAMPLE' }));
    const issues = issuesOf(readWalmartCapture(capture.consolidated));
    assert.equal(issues.length, CAPTURE_MAX_ISSUES);
    assert.deepEqual(issues[0], { path: '$.orders[0].orderId', message: 'must be 1 to 40 digits' });
    assert.deepEqual(issues[CAPTURE_MAX_ISSUES - 2], { path: `$.orders[${CAPTURE_MAX_ISSUES - 2}].orderId`, message: 'must be 1 to 40 digits' });
    assert.deepEqual(issues[CAPTURE_MAX_ISSUES - 1], { path: '$', message: `has more issues than the ${CAPTURE_MAX_ISSUES - 1} listed` });
  });

  it('names no value in any issue', () => {
    const capture = fresh();
    const order = at(capture.consolidated, 'orders', 0);
    order.orderId = `${syntheticWalmartOrderId(1)} SAMPLE WIDGET`;
    order.orderDate = SYNTHETIC_WALMART_SELLER;
    order.timezone = { name: SYNTHETIC_WALMART_STORE };
    at(order, 'groups', 0).fulfillmentType = 'SAMPLE WIDGET';
    at(order, 'groups', 0, 'seller').name = [SYNTHETIC_WALMART_SELLER];
    at(order, 'groups', 0, 'seller').id = { id: SYNTHETIC_WALMART_SELLER_ID };
    at(order, 'groups', 0, 'items', 0).name = { text: 'TESTNAME GADGET' };
    at(order, 'groups', 0, 'items', 0, 'linePrice').cents = '$1,234.56';
    at(order, 'groups', 0, 'items', 0, 'linePrice').currency = '1,234.56';
    at(order, 'payments', 0).last4 = `${SYNTHETIC_WALMART_CARD}${SYNTHETIC_WALMART_GIFT_CARD}`;
    at(order, 'payments', 0).cardType = `Ending in ${SYNTHETIC_WALMART_CARD}`;
    at(order, 'amounts', 'fees', 0).label = 123_456;
    at(order, 'amounts', 'refunds', 0, 'amount').cents = 123_456;
    at(capture.consolidated, 'orders', 1).orderId = syntheticWalmartOrderId(1);
    const raw = capture.rawDetails[0];
    const subTotal = at(raw.json, 'order', 'priceDetails', 'subTotal');
    subTotal.displayValue = 'SAMPLE WIDGET $1,234.56';
    delete subTotal.value;
    at(raw.json, 'order', 'paymentMethods', 0).paymentType = `Ending in ${SYNTHETIC_WALMART_CARD}`;
    at(raw.json, 'order', 'paymentMethods', 0).displayValues = ['$1,228.33', '$1,234.56'];
    at(raw.json, 'order', 'groups_2101', 0, 'seller').name = { name: SYNTHETIC_WALMART_SELLER };
    at(raw.json, 'order', 'groups_2101', 0).deliveryDate = SYNTHETIC_WALMART_STORE;
    at(raw.json, 'order').orderDate = { text: 'Delivered on Mar 04' };
    const issues = [
      ...issuesOf(readWalmartCapture(capture.consolidated)),
      ...issuesOf(readWalmartRawDetail(raw.json, `${raw.orderId} ${SYNTHETIC_WALMART_SELLER}`)),
    ];
    assert.ok(issues.length >= 18, `expected an issue for each broken value: ${JSON.stringify(issues)}`);
    const text = JSON.stringify(issues);
    for (const value of syntheticSensitiveValues()) assert.ok(!text.includes(value), `an issue shows ${value}`);
  });

  it('never names the groups list by its key: the key is the capture\'s own text', () => {
    const raw = fresh().rawDetails[0];
    const order = at(raw.json, 'order');
    const marker = 'groups_SAMPLE_PRIVATE_MARKER';
    order[marker] = order.groups_2101;
    delete order.groups_2101;
    at(order, marker, 0, 'items', 0).quantity = 2.5;
    (order[marker] as unknown[]).push('SAMPLE');
    const issues = issuesOf(readWalmartRawDetail(raw.json, raw.orderId));
    assertIssue(issues, '$.order.groups[0].items[0].quantity', /integer/);
    assertIssue(issues, '$.order.groups[1]', /must be an object/);
    assert.ok(!JSON.stringify(issues).includes('SAMPLE_PRIVATE_MARKER'), 'an issue names the key');
  });
});

describe('Walmart captures: status types outside the closed list', () => {
  it('keeps one as data in both files, and the two still compare', () => {
    const capture = fresh();
    at(capture.consolidated, 'orders', 0, 'groups', 0, 'status').type = 'SHIPPED';
    const raw = capture.rawDetails[0];
    at(raw.json, 'order', 'groups_2101', 0, 'status').statusType = 'SHIPPED';
    const listed = readOk(capture.consolidated).orders[0];
    const detail = rawOk(raw.json, raw.orderId);
    assert.equal(listed.groups[0].status.type, null);
    assert.equal(listed.groups[0].status.unlistedType, 'SHIPPED');
    assert.equal(detail.groups[0].status.type, null);
    assert.equal(detail.groups[0].status.unlistedType, 'SHIPPED');
    assert.deepEqual(walmartRawComparable(listed), walmartRawComparable(detail));
    at(raw.json, 'order', 'groups_2101', 0, 'status').statusType = 'IN_TRANSIT';
    assert.notDeepEqual(walmartRawComparable(listed), walmartRawComparable(rawOk(raw.json, raw.orderId)));
  });
});
