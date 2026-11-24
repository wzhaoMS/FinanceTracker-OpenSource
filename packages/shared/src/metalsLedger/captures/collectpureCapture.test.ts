import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SYNTHETIC_COLLECTPURE_ACCOUNT,
  SYNTHETIC_COLLECTPURE_BANK,
  SYNTHETIC_COLLECTPURE_CAPTURED_AT,
  SYNTHETIC_COLLECTPURE_CONFIRMATION,
  syntheticCollectPureCapture,
  syntheticCollectPureSpec,
  syntheticPayoutId,
  syntheticSellOrderId,
  syntheticSensitiveValues,
  type SyntheticCollectPureCapture,
} from './__fixtures__/collectpureCapture.js';
import { type CaptureIssue } from './captureRead.js';
import {
  collectPureRawComparable,
  readCollectPureCapture,
  readCollectPureInventoryStats,
  readCollectPureOrderStats,
  readCollectPurePayoutHistoryPage,
  readCollectPureRawSellOrder,
  type CollectPureCapture,
  type CollectPureCaptureForm,
  type CollectPureSellOrder,
} from './collectpureCapture.js';

type Json = Record<string, unknown>;

/** The object at a path of keys and indices in a parsed file, to change for a test. */
function at(value: unknown, ...path: Array<string | number>): Json {
  let current = value;
  for (const key of path) current = (current as Json)[key];
  return current as Json;
}

const fresh = (): SyntheticCollectPureCapture => syntheticCollectPureCapture(syntheticCollectPureSpec());

/** The fixture's consolidated file is the base capture's unless a test builds a snapshot's. */
function readOk(json: unknown, form: CollectPureCaptureForm = 'base'): CollectPureCapture {
  const read = readCollectPureCapture(json, form);
  if (!read.ok) assert.fail(`unexpected issues: ${JSON.stringify(read.issues)}`);
  return read.capture;
}

function rawOk(json: unknown, id: string): CollectPureSellOrder {
  const read = readCollectPureRawSellOrder(json, id);
  if (!read.ok) assert.fail(`unexpected issues: ${JSON.stringify(read.issues)}`);
  return read.sellOrder;
}

function issuesOf(read: { ok: true } | { ok: false; issues: CaptureIssue[] }): CaptureIssue[] {
  if (read.ok) assert.fail('read without an issue');
  return read.issues;
}

/** Issues are value-free, so a failure may print them. */
function assertIssue(issues: CaptureIssue[], path: string, message: RegExp): void {
  assert.ok(issues.some((issue) => issue.path === path && message.test(issue.message)), `no issue at ${path} matching ${message}: ${JSON.stringify(issues)}`);
}

describe('CollectPure captures: the consolidated file', () => {
  it('reads every record into the typed shape, money as integer cents', () => {
    const capture = readOk(fresh().consolidated);
    assert.equal(capture.schema, 'holdr-retail-capture/collectpure@1');
    assert.deepEqual(capture.provenance, {
      capturedAt: SYNTHETIC_COLLECTPURE_CAPTURED_AT,
      detailsReusedFromOct24Capture: null,
      pages: [
        {
          path: '/dashboard/sell-orders', rowsSeen: 2, statedTotal: 2, statsCounts: { total: 2, active: 1, completed: 1, cancelled: 0 },
          detailPagesCaptured: null, of: null, pages: null,
        },
        { path: '/order/sell/<id>', rowsSeen: null, statedTotal: null, statsCounts: null, detailPagesCaptured: 2, of: 2, pages: null },
        { path: '/dashboard/payouts', rowsSeen: 1, statedTotal: null, statsCounts: null, detailPagesCaptured: null, of: null, pages: 1 },
        { path: '/dashboard/payments', rowsSeen: null, statedTotal: null, statsCounts: null, detailPagesCaptured: null, of: null, pages: null },
        { path: '/dashboard/buy-orders', rowsSeen: 0, statedTotal: 0, statsCounts: null, detailPagesCaptured: null, of: null, pages: null },
        { path: '/dashboard/inventory', rowsSeen: 0, statedTotal: 0, statsCounts: null, detailPagesCaptured: null, of: null, pages: null },
        { path: '/dashboard/vault', rowsSeen: null, statedTotal: null, statsCounts: null, detailPagesCaptured: null, of: null, pages: null },
        { path: '/dashboard/listings', rowsSeen: null, statedTotal: null, statsCounts: null, detailPagesCaptured: null, of: null, pages: null },
      ],
      checks: { sellOrdersListed: 2, payoutsListed: 1, pageTotalEqualsApiTotal: 1, pageTotalDiffers: 0 },
    });
    assert.equal(capture.sellOrders.length, 2);
    const [complete, inTransit] = capture.sellOrders;

    assert.equal(complete.source, 'consolidated');
    assert.equal(complete.idKeyMaterial, syntheticSellOrderId(1));
    assert.equal(complete.placedAt, '2025-10-01T12:00:00.123Z');
    assert.equal(complete.placedDateNY, '2025-10-01');
    assert.equal(complete.completeAt, '2025-10-08T18:30:00.000Z');
    assert.deepEqual(complete.status, { key: 'order_complete', label: 'SAMPLE STATUS LABEL', pageBadge: 'SAMPLE BADGE', detailStatus: 'Order Complete' });
    assert.deepEqual(complete.timeline.map((step) => step.status), [
      'pending_confirmation', 'ready_for_shipment', 'in_transit', 'items_received', 'check_in_progress', 'check_in_complete', 'order_complete',
    ]);
    assert.deepEqual(complete.timeline[0], {
      status: 'pending_confirmation', at: '2025-10-01T12:00:00.123Z', dateNY: '2025-10-01', pageLabel: 'SAMPLE STEP', pageDate: '10/1/2025',
    });
    // The whole line: the capture's own readings (metal, weight) and the inspection notes are not on it.
    assert.deepEqual(complete.lines[0], {
      lineItemId: '5001', sku: 'SAMPLE-SKU-1', name: 'SAMPLE ITEM ONE', program: 'SAMPLE PROGRAM', premiumCalculationType: 'troy_ounce',
      qty: 2, unitPriceMinor: 123_456, lineTotalMinor: 246_912, lineTotalDerived: true, spotPremiumRaw: '2.5', spotPremiumDollarMinor: 3_086,
      status: 'Item Complete', inspection: { receivedForInspection: true, passedInspection: true, buyerPaid: true },
    });
    assert.equal(complete.lines[1].spotPremiumRaw, 1.25, 'a spot premium is kept exactly as stated');
    assert.equal(complete.lines[1].inspection, null);
    assert.deepEqual(complete.listProducts?.map((product) => [product.sku, product.qty, product.priceMinor]), [['SAMPLE-SKU-1', 2, 123_456], ['SAMPLE-SKU-2', 1, 4_200]]);
    assert.deepEqual(complete.amounts, {
      subtotalMinor: 251_112, shippingMinor: -3_000, processingFeeMinor: -2_511, salesTaxMinor: null, totalMinor: 245_601, currency: 'USD',
      optionalFees: [{ title: 'SAMPLE INSURANCE', feeMinor: -2_511 }], appliedPromotions: 0, instantPayoutAdvance: null,
    });
    assert.deepEqual(complete.pageBreakdown, [
      { label: 'Subtotal', amountMinor: 251_112 },
      { label: 'Insured Shipping', amountMinor: -3_000 },
      { label: 'Platform Fee (1%)', amountMinor: -2_511 },
      { label: 'Total Payout', amountMinor: 245_601 },
    ]);
    assert.deepEqual(complete.payout, {
      method: 'ach',
      destinationLast4: SYNTHETIC_COLLECTPURE_ACCOUNT,
      transactions: [{
        payoutKeyMaterial: syntheticPayoutId(1, 0), amountMinor: 245_601, method: 'ACH', status: 'complete',
        initiatedAt: '2025-10-09T12:00:00.000Z', payoutDate: '2025-10-09', payoutDateRaw: '2025-10-09',
      }],
      totalPaidMinor: 245_601,
    });
    assert.deepEqual(complete.shipments, [{
      carrier: 'SAMPLE CARRIER', status: 'Delivered', delivered: true, labelCreatedAt: '2025-10-01T12:00:00.123Z',
      shippedAt: '2025-10-01T12:00:00.123Z', deliveredAt: '2025-10-06T14:00:00.000Z', deliveredDateLocal: '2025-10-06', estDeliveryDate: 'SAMPLE ESTIMATE',
    }]);
    assert.equal(complete.priceLockStatedOnPage, false);
    assert.deepEqual(complete.combinedSellOrderKeyMaterial, []);
    assert.equal(complete.detailCaptured, true);
    assert.equal(complete.detailCapturedAt, SYNTHETIC_COLLECTPURE_CAPTURED_AT);

    assert.equal(inTransit.status?.key, 'in_transit');
    assert.equal(inTransit.timeline[2].at, null);
    assert.equal(inTransit.lines[0].status, 'Item Pending');
    assert.equal(inTransit.lines[0].premiumCalculationType, null);
    assert.deepEqual(inTransit.payout.transactions, []);
    assert.equal(inTransit.payout.totalPaidMinor, 0);

    assert.deepEqual(capture.payouts, [{
      payoutKeyMaterial: syntheticPayoutId(1, 0), sellOrderKeyMaterial: syntheticSellOrderId(1), amountMinor: 245_601, method: 'ACH',
      status: 'complete', payoutDate: '2025-10-09', payoutDateRaw: '2025-10-09', initiatedAt: '2025-10-09T12:00:00.000Z',
    }]);
    assert.deepEqual(capture.buyOrders, { statedTotal: 0, rows: 0, statsCounts: { total: 0, active: 0, completed: 0, cancelled: 0 } });
    assert.deepEqual(capture.inventory, { statedTotal: 0, rows: 0, totalCount: 0, listedCount: 0, unlistedCount: 0 });
    assert.deepEqual(capture.vault, { enabled: false, state: 'waitlist', holdingsCount: 0 });
  });

  it("keeps none of the capture's own readings, free text, confirmation numbers or account records", () => {
    const text = JSON.stringify(readOk(fresh().consolidated));
    for (const dropped of [
      'SAMPLE-CODE', 'SAMPLE PARSE', 'weightOztPerUnit', 'SAMPLE INSPECTION NOTE', 'SAMPLE PRICE LOCK TEXT',
      SYNTHETIC_COLLECTPURE_CONFIRMATION, SYNTHETIC_COLLECTPURE_BANK, `PO ${syntheticSellOrderId(1)}`, 'pageMethodLines', 'confirmationNumber',
    ]) {
      assert.ok(!text.includes(dropped), `the typed capture keeps ${dropped}`);
    }
  });
});

describe('CollectPure captures: raw sell orders', () => {
  it('maps each raw sell order to the same typed sell order as the consolidated file', () => {
    const capture = fresh();
    const sellOrders = readOk(capture.consolidated).sellOrders;
    assert.equal(capture.rawSellOrders.length, sellOrders.length);
    for (const raw of capture.rawSellOrders) {
      assert.equal(raw.name, `sell-order-${raw.id}.json`);
      const listed = sellOrders.find((order) => order.idKeyMaterial === raw.id);
      assert.ok(listed, 'the consolidated file lists the sell order');
      const detail = rawOk(raw.json, raw.id);
      assert.equal(detail.source, 'raw-sell-order');
      assert.deepEqual(collectPureRawComparable(detail), collectPureRawComparable(listed));
    }
  });

  it('states none of the fields only the list pages or the capture gives', () => {
    const raw = fresh().rawSellOrders[0];
    const order = rawOk(raw.json, raw.id);
    assert.equal(order.idKeyMaterial, raw.id);
    for (const key of [
      'placedAt', 'placedDateNY', 'shipByDate', 'completeAt', 'createdAt', 'status', 'listProducts', 'shipments', 'priceLockStatedOnPage',
      'combinedSellOrderKeyMaterial',
    ] as const) {
      assert.equal(order[key], null, key);
    }
    assert.deepEqual(order.lines.map((line) => [line.lineTotalMinor, line.lineTotalDerived]), [[null, false], [null, false]]);
    assert.deepEqual(order.timeline[0], { status: 'pending_confirmation', at: '2025-10-01T12:00:00.123Z', dateNY: null, pageLabel: null, pageDate: null });
    assert.equal(order.payout.totalPaidMinor, null);
    assert.deepEqual(order.payout.transactions[0], {
      payoutKeyMaterial: syntheticPayoutId(1, 0), amountMinor: 245_601, method: 'ACH', status: 'complete', initiatedAt: null, payoutDate: null, payoutDateRaw: null,
    });
    assert.equal(order.detailCapturedAt, SYNTHETIC_COLLECTPURE_CAPTURED_AT);
    const { source, ...rest } = order;
    assert.equal(source, 'raw-sell-order');
    assert.deepEqual(collectPureRawComparable(order), rest);
  });

  it('keeps what the raw file states of itself, where it states it: its id as text and its status in the page\'s words', () => {
    const raw = fresh().rawSellOrders[0];
    const read = readCollectPureRawSellOrder(raw.json, raw.id);
    if (!read.ok) assert.fail(`unexpected issues: ${JSON.stringify(read.issues)}`);
    assert.deepEqual(read.stated, { idKeyMaterial: raw.id, status: 'Order Complete' });
    // Real captures state the id as a number, and the consolidated file as text: the same id.
    at(raw.json, 'order').id = 70_000_001;
    const numeric = readCollectPureRawSellOrder(raw.json, '70000001');
    if (!numeric.ok) assert.fail(`unexpected issues: ${JSON.stringify(numeric.issues)}`);
    assert.equal(numeric.stated.idKeyMaterial, '70000001');
    delete at(raw.json, 'order').id;
    delete at(raw.json, 'order').status;
    const none = readCollectPureRawSellOrder(raw.json, raw.id);
    if (!none.ok) assert.fail(`unexpected issues: ${JSON.stringify(none.issues)}`);
    assert.deepEqual(none.stated, { idKeyMaterial: null, status: null });
  });

  it('reads a timeline instant written with microseconds and an offset as the same instant', () => {
    const raw = fresh().rawSellOrders[0];
    assert.equal(at(raw.json, 'order', 'statusHistory', 0).changed_at, '2025-10-01T12:00:00.123456+00:00');
    at(raw.json, 'order', 'statusHistory', 1).changed_at = '2025-10-01T08:05:00-04:00';
    const order = rawOk(raw.json, raw.id);
    assert.equal(order.timeline[0].at, '2025-10-01T12:00:00.123Z');
    assert.equal(order.timeline[1].at, '2025-10-01T12:05:00.000Z');
  });

  it('reads a price stated as numeric text, rounded to a whole cent', () => {
    const raw = fresh().rawSellOrders[0];
    assert.equal(at(raw.json, 'order', 'lineItems', 0).price, '123456.0');
    assert.equal(rawOk(raw.json, raw.id).lines[0].unitPriceMinor, 123_456);
    at(raw.json, 'order', 'lineItems', 0).price = 123_456.5;
    assert.equal(rawOk(raw.json, raw.id).lines[0].unitPriceMinor, 123_457);
  });

  it('reads a page without a breakdown, and a file without a page, as no breakdown', () => {
    const raw = fresh().rawSellOrders[1];
    delete at(raw.json, 'page').breakdown;
    assert.deepEqual(rawOk(raw.json, raw.id).pageBreakdown, []);
    delete raw.json.page;
    assert.deepEqual(rawOk(raw.json, raw.id).pageBreakdown, []);
  });
});

/** Each refusal: a change to the consolidated file, and the issue it must give. */
const CONSOLIDATED_REFUSALS: Array<{ name: string; change: (file: Json) => void; path: string; message: RegExp }> = [
  { name: 'another schema', change: (file) => { file.schema = 'holdr-retail-capture/collectpure@2'; }, path: '$.schema', message: /^must be holdr-retail-capture\/collectpure@1$/ },
  { name: 'another source', change: (file) => { at(file, 'provenance').source = 'example.com'; }, path: '$.provenance.source', message: /must be collectpure\.com/ },
  { name: 'a capture time without a zone', change: (file) => { at(file, 'provenance').capturedAt = '2026-01-02 03:04'; }, path: '$.provenance.capturedAt', message: /ISO 8601/ },
  { name: 'a check that is not an integer', change: (file) => { at(file, 'provenance', 'checks').payoutsListed = 'one'; }, path: '$.provenance.checks', message: /integer/ },
  { name: 'a check name that is not a plain identifier', change: (file) => { at(file, 'provenance', 'checks')['not plain'] = 1; }, path: '$.provenance.checks', message: /plain identifier/ },
  { name: 'stats counts that are not whole numbers', change: (file) => { at(file, 'provenance', 'pages', 0, 'statsCounts').active = -1; }, path: '$.provenance.pages[0].statsCounts.active', message: /integer/ },
  { name: 'sell orders that are not a list', change: (file) => { file.sellOrders = {}; }, path: '$.sellOrders', message: /must be an array/ },
  { name: 'a sell-order id of another form', change: (file) => { at(file, 'sellOrders', 0).id = 'SO7 0000001'; }, path: '$.sellOrders[0].id', message: /letters, digits, hyphens or underscores/ },
  { name: 'a repeated sell-order id', change: (file) => { at(file, 'sellOrders', 1).id = syntheticSellOrderId(1); }, path: '$.sellOrders[1].id', message: /repeats/ },
  { name: 'a status key outside the closed list', change: (file) => { at(file, 'sellOrders', 0, 'status').key = 'order_lost'; }, path: '$.sellOrders[0].status.key', message: /allowed values/ },
  { name: 'a timeline status outside the closed list', change: (file) => { at(file, 'sellOrders', 0, 'timeline', 0).status = 'shipped'; }, path: '$.sellOrders[0].timeline[0].status', message: /allowed values/ },
  { name: 'a timeline time without a zone', change: (file) => { at(file, 'sellOrders', 0, 'timeline', 0).at = '10/1/2025'; }, path: '$.sellOrders[0].timeline[0].at', message: /ISO 8601/ },
  { name: 'a New York date that is not a real date', change: (file) => { at(file, 'sellOrders', 0).placedDateNY = '2025-13-01'; }, path: '$.sellOrders[0].placedDateNY', message: /real YYYY-MM-DD/ },
  {
    name: 'a premium calculation type outside the closed list', change: (file) => { at(file, 'sellOrders', 0, 'lines', 0).premiumCalculationType = 'gram'; },
    path: '$.sellOrders[0].lines[0].premiumCalculationType', message: /allowed values/,
  },
  { name: 'a line status outside the closed list', change: (file) => { at(file, 'sellOrders', 0, 'lines', 0).status = 'Item Lost'; }, path: '$.sellOrders[0].lines[0].status', message: /allowed values/ },
  { name: 'a quantity that is not a whole number', change: (file) => { at(file, 'sellOrders', 0, 'lines', 0).qty = 1.5; }, path: '$.sellOrders[0].lines[0].qty', message: /integer/ },
  { name: 'a line without its id', change: (file) => { delete at(file, 'sellOrders', 0, 'lines', 0).lineItemId; }, path: '$.sellOrders[0].lines[0].lineItemId', message: /is missing/ },
  {
    name: 'money in a unit other than cents', change: (file) => { at(file, 'sellOrders', 0, 'lines', 0, 'unitPrice').rawUnit = 'dollars'; },
    path: '$.sellOrders[0].lines[0].unitPrice.rawUnit', message: /must be cents/,
  },
  { name: 'money in fractions of a cent', change: (file) => { at(file, 'sellOrders', 0, 'amounts', 'subtotal').cents = 2511.12; }, path: '$.sellOrders[0].amounts.subtotal.cents', message: /integer/ },
  { name: 'money in another currency', change: (file) => { at(file, 'sellOrders', 0, 'amounts', 'total').currency = 'EUR'; }, path: '$.sellOrders[0].amounts.total.currency', message: /must be USD/ },
  { name: 'missing money', change: (file) => { delete at(file, 'sellOrders', 0, 'amounts').total; }, path: '$.sellOrders[0].amounts.total', message: /is missing/ },
  { name: 'a missing page breakdown', change: (file) => { delete at(file, 'sellOrders', 0).pageBreakdown; }, path: '$.sellOrders[0].pageBreakdown', message: /is missing/ },
  {
    name: 'a payout account ending that is not four digits', change: (file) => { at(file, 'sellOrders', 0, 'payout').destinationLast4 = '007'; },
    path: '$.sellOrders[0].payout.destinationLast4', message: /four digits/,
  },
  {
    name: 'a payout transaction without its id', change: (file) => { delete at(file, 'sellOrders', 0, 'payout', 'transactions', 0).payoutId; },
    path: '$.sellOrders[0].payout.transactions[0].payoutId', message: /is missing/,
  },
  { name: 'a price lock without its flag', change: (file) => { at(file, 'sellOrders', 0).priceLock = {}; }, path: '$.sellOrders[0].priceLock.statedOnPage', message: /is missing/ },
  { name: 'a payout naming a sell order of another form', change: (file) => { at(file, 'payouts', 0).sellOrderId = 'SO7/1'; }, path: '$.payouts[0].sellOrderId', message: /letters, digits/ },
  { name: 'a vault flag that is not true or false', change: (file) => { at(file, 'vault').enabled = 'no'; }, path: '$.vault.enabled', message: /true or false/ },
  { name: 'vault holdings that are not a list', change: (file) => { at(file, 'vault').holdings = {}; }, path: '$.vault.holdings', message: /must be an array/ },
];

/** Each refusal: a change to the first raw sell order, and the issue it must give. */
const RAW_REFUSALS: Array<{ name: string; change: (file: Json) => void; path: string; message: RegExp }> = [
  { name: 'a file without its order', change: (file) => { delete file.order; }, path: '$.order', message: /is missing/ },
  { name: 'an order that is not an object', change: (file) => { file.order = []; }, path: '$.order', message: /must be an object/ },
  { name: 'a capture time without a zone', change: (file) => { file.capturedAt = '2026-01-02'; }, path: '$.capturedAt', message: /ISO 8601/ },
  { name: 'a breakdown of odd length', change: (file) => { (at(file, 'page').breakdown as unknown[]).pop(); }, path: '$.page.breakdown', message: /even number of entries/ },
  { name: 'a breakdown amount it cannot read', change: (file) => { (at(file, 'page').breakdown as unknown[])[1] = 'about a dollar'; }, path: '$.page.breakdown[1]', message: /money text/ },
  { name: 'a breakdown label that is not text', change: (file) => { (at(file, 'page').breakdown as unknown[])[0] = 7; }, path: '$.page.breakdown[0]', message: /must be a string/ },
  { name: 'a line with a quantity that is not a whole number', change: (file) => { at(file, 'order', 'lineItems', 0).quantity = 1.5; }, path: '$.order.lineItems[0].quantity', message: /integer/ },
  { name: 'a line with a price that is not a number', change: (file) => { at(file, 'order', 'lineItems', 0).price = 'priceless'; }, path: '$.order.lineItems[0].price', message: /number of cents/ },
  {
    name: 'a line with a premium calculation type outside the closed list', change: (file) => { at(file, 'order', 'lineItems', 0, 'product').premiumCalculationType = 'gram'; },
    path: '$.order.lineItems[0].product.premiumCalculationType', message: /allowed values/,
  },
  { name: 'a line status outside the closed list', change: (file) => { at(file, 'order', 'lineItems', 0).status = 'Item Lost'; }, path: '$.order.lineItems[0].status', message: /allowed values/ },
  { name: 'an inspection field that is not a scalar', change: (file) => { at(file, 'order', 'lineItems', 0, 'tracking').passedInspection = {}; }, path: '$.order.lineItems[0].tracking.passedInspection', message: /true, false, a number/ },
  { name: 'a timeline status outside the closed list', change: (file) => { at(file, 'order', 'statusHistory', 0).status = 'shipped'; }, path: '$.order.statusHistory[0].status', message: /allowed values/ },
  { name: 'a timeline time without a zone', change: (file) => { at(file, 'order', 'statusHistory', 0).changed_at = '2025-10-01 12:00:00'; }, path: '$.order.statusHistory[0].changed_at', message: /ISO 8601/ },
  { name: 'an id of another form', change: (file) => { at(file, 'order').id = 'SO7 0000001'; }, path: '$.order.id', message: /letters, digits, hyphens or underscores/ },
  { name: 'a status that is not text', change: (file) => { at(file, 'order').status = 7; }, path: '$.order.status', message: /must be a string/ },
  { name: 'another currency', change: (file) => { at(file, 'order').currency = 'EUR'; }, path: '$.order.currency', message: /must be USD/ },
  { name: 'a subtotal in fractions of a cent', change: (file) => { at(file, 'order').subtotal = 2511.12; }, path: '$.order.subtotal', message: /integer/ },
  { name: 'promotions that are not a list', change: (file) => { at(file, 'order').appliedPromotions = 2; }, path: '$.order.appliedPromotions', message: /must be an array/ },
  { name: 'a payout account ending that is not four digits', change: (file) => { at(file, 'order', 'payoutDetails', 'ach').last4 = '007'; }, path: '$.order.payoutDetails.ach.last4', message: /four digits/ },
  { name: 'a payout transaction in fractions of a cent', change: (file) => { at(file, 'order', 'payoutTransactions', 0).amount = 1.5; }, path: '$.order.payoutTransactions[0].amount', message: /integer/ },
];

describe('CollectPure captures: refusals', () => {
  for (const refusal of CONSOLIDATED_REFUSALS) {
    it(`refuses a consolidated file with ${refusal.name}`, () => {
      const capture = fresh();
      refusal.change(capture.consolidated);
      assertIssue(issuesOf(readCollectPureCapture(capture.consolidated, 'base')), refusal.path, refusal.message);
    });
  }

  for (const refusal of RAW_REFUSALS) {
    it(`refuses a raw sell order with ${refusal.name}`, () => {
      const raw = fresh().rawSellOrders[0];
      refusal.change(raw.json);
      assertIssue(issuesOf(readCollectPureRawSellOrder(raw.json, raw.id)), refusal.path, refusal.message);
    });
  }

  it('refuses a file that is not an object', () => {
    assertIssue(issuesOf(readCollectPureCapture(null, 'base')), '$', /must be an object/);
    assertIssue(issuesOf(readCollectPureRawSellOrder('SAMPLE', syntheticSellOrderId(1))), '$', /must be an object/);
  });

  it('refuses a sell-order id argument of another form', () => {
    const raw = fresh().rawSellOrders[0];
    assertIssue(issuesOf(readCollectPureRawSellOrder(raw.json, `${raw.id}/..`)), 'id', /letters, digits, hyphens or underscores/);
  });

  it('collects every issue, not only the first', () => {
    const raw = fresh().rawSellOrders[0];
    at(raw.json, 'order', 'lineItems', 0).quantity = 1.5;
    at(raw.json, 'order', 'statusHistory', 2).status = 'shipped';
    (at(raw.json, 'page').breakdown as unknown[]).pop();
    const issues = issuesOf(readCollectPureRawSellOrder(raw.json, raw.id));
    assert.deepEqual(issues.map((issue) => issue.path), ['$.order.statusHistory[2].status', '$.order.lineItems[0].quantity', '$.page.breakdown']);
  });

  it('names no value in any issue', () => {
    const capture = fresh();
    const order = at(capture.consolidated, 'sellOrders', 0);
    order.id = `${syntheticSellOrderId(1)} ${SYNTHETIC_COLLECTPURE_BANK}`;
    order.placedDateNY = 'SAMPLE ITEM ONE';
    at(order, 'status').key = 'TESTNAME ITEM TWO';
    at(order, 'lines', 0).sku = { sku: 'SAMPLE-SKU-1' };
    at(order, 'lines', 0).name = ['SAMPLE ITEM ONE'];
    at(order, 'lines', 0).program = 251_112;
    at(order, 'lines', 0, 'unitPrice').cents = '$2,511.12';
    at(order, 'lines', 0, 'unitPrice').rawUnit = '2,511.12';
    at(order, 'payout').destinationLast4 = `${SYNTHETIC_COLLECTPURE_ACCOUNT}${SYNTHETIC_COLLECTPURE_ACCOUNT}`;
    at(order, 'payout', 'transactions', 0).payoutId = { id: syntheticPayoutId(1, 0) };
    at(capture.consolidated, 'payouts', 0).sellOrderId = `${syntheticSellOrderId(1)} ${SYNTHETIC_COLLECTPURE_CONFIRMATION}`;
    at(capture.consolidated, 'provenance', 'checks')[`${SYNTHETIC_COLLECTPURE_BANK} ${SYNTHETIC_COLLECTPURE_ACCOUNT}`] = 1;
    // A check named like a native id: its issue names only the checks' fixed path.
    at(capture.consolidated, 'provenance', 'checks')[syntheticSellOrderId(1)] = 'bad';
    const raw = capture.rawSellOrders[0];
    (at(raw.json, 'page').breakdown as unknown[])[1] = 'SAMPLE INSURANCE $2,511.12';
    at(raw.json, 'order', 'lineItems', 0).price = 'SAMPLE ITEM ONE';
    at(raw.json, 'order', 'lineItems', 0, 'product').premiumCalculationType = 'SAMPLE PROGRAM';
    at(raw.json, 'order', 'lineItems', 0, 'tracking').buyerPaid = { note: 'SAMPLE INSPECTION NOTE' };
    at(raw.json, 'order', 'statusHistory', 0).status = 'SAMPLE STATUS LABEL';
    at(raw.json, 'order').id = `${syntheticSellOrderId(1)} ${SYNTHETIC_COLLECTPURE_BANK}`;
    at(raw.json, 'order').status = { words: 'SAMPLE STATUS LABEL' };
    at(raw.json, 'order', 'payoutDetails', 'ach').last4 = SYNTHETIC_COLLECTPURE_BANK;
    at(raw.json, 'order', 'payoutTransactions', 0).id = [SYNTHETIC_COLLECTPURE_CONFIRMATION];
    const issues = [
      ...issuesOf(readCollectPureCapture(capture.consolidated, 'base')),
      ...issuesOf(readCollectPureRawSellOrder(raw.json, `${raw.id} ${SYNTHETIC_COLLECTPURE_BANK}`)),
    ];
    assert.ok(issues.length >= 21, `expected an issue for each broken value: ${JSON.stringify(issues)}`);
    const text = JSON.stringify(issues);
    for (const value of syntheticSensitiveValues()) assert.ok(!text.includes(value), `an issue shows ${value}`);
  });
});

describe('CollectPure captures: pages, payout history and stats', () => {
  it('identifies each provenance page by its fixed path, and a path outside the closed list as none', () => {
    const capture = fresh();
    at(capture.consolidated, 'provenance', 'pages', 3).path = '/dashboard/somewhere-new';
    delete at(capture.consolidated, 'provenance', 'pages', 6).path;
    const pages = readOk(capture.consolidated).provenance.pages;
    assert.deepEqual(pages.map((page) => page.path), [
      '/dashboard/sell-orders', '/order/sell/<id>', '/dashboard/payouts', null, '/dashboard/buy-orders', '/dashboard/inventory', null,
      '/dashboard/listings',
    ]);
    assert.equal(pages[2].pages, 1);
    at(capture.consolidated, 'provenance', 'pages', 0).path = 7;
    assertIssue(issuesOf(readCollectPureCapture(capture.consolidated, 'base')), '$.provenance.pages[0].path', /must be a string/);
  });

  it('reads a base capture without the two keys only a snapshot states, and still requires them of a snapshot', () => {
    const base = fresh().consolidated;
    const snapshot = syntheticCollectPureCapture({ ...syntheticCollectPureSpec(), snapshot: true }).consolidated;
    for (const key of ['snapshotFolder', 'detailsReusedFromOct24Capture']) {
      assert.equal(key in at(base, 'provenance'), false, key);
      assert.equal(key in at(snapshot, 'provenance'), true, key);
    }
    assert.equal(readOk(base, 'base').provenance.detailsReusedFromOct24Capture, null);
    assert.equal(readOk(snapshot, 'snapshot').provenance.detailsReusedFromOct24Capture, 0);
    // A base capture that states them anyway is still read, them included.
    assert.equal(readOk(snapshot, 'base').provenance.detailsReusedFromOct24Capture, 0);
    // A snapshot's file without them is refused, as before.
    const missing = issuesOf(readCollectPureCapture(base, 'snapshot'));
    assertIssue(missing, '$.provenance.snapshotFolder', /is missing/);
    assertIssue(missing, '$.provenance.detailsReusedFromOct24Capture', /is missing/);
    // Optional in a base capture means absent: stated, each must still read.
    at(base, 'provenance').snapshotFolder = null;
    at(base, 'provenance').detailsReusedFromOct24Capture = -1;
    const stated = issuesOf(readCollectPureCapture(base, 'base'));
    assertIssue(stated, '$.provenance.snapshotFolder', /must be a string/);
    assertIssue(stated, '$.provenance.detailsReusedFromOct24Capture', /must be an integer/);
  });

  it('reads a payout-history page in the base and the snapshot forms, never its confirmation numbers or cursor', () => {
    for (const snapshot of [false, true]) {
      const capture = syntheticCollectPureCapture({ ...syntheticCollectPureSpec(), snapshot });
      assert.equal(capture.payoutHistoryPages.length, 1);
      const [page] = capture.payoutHistoryPages;
      assert.equal(page.name, 'payout-history-p01.json');
      const read = readCollectPurePayoutHistoryPage(page.json);
      if (!read.ok) assert.fail(`unexpected issues: ${JSON.stringify(read.issues)}`);
      assert.deepEqual(read.page, {
        items: [{
          payoutKeyMaterial: syntheticPayoutId(1, 0), sellOrderKeyMaterial: syntheticSellOrderId(1), amountMinor: 245_601, method: 'ACH',
          status: 'complete', payoutDate: '2025-10-09', createdAt: '2025-10-09T12:00:00.000Z',
        }],
        hasNext: false,
      });
      assert.ok(!JSON.stringify(read.page).includes(SYNTHETIC_COLLECTPURE_CONFIRMATION));
    }
  });

  it('reads a page whose pager names a next page, and a base-form created time with microseconds and an offset', () => {
    const spec = syntheticCollectPureSpec();
    spec.payoutPageSize = 1;
    spec.sellOrders[1].payouts = [{ amount: 1_000, status: 'complete', date: '2025-11-09', createdAt: '2025-11-09T23:30:00.000Z' }];
    const pages = syntheticCollectPureCapture(spec).payoutHistoryPages;
    assert.deepEqual(pages.map((page) => page.name), ['payout-history-p01.json', 'payout-history-p02.json']);
    at(pages[1].json, 'result', 'data', 'json', 'items', 0).createdAt = '2025-11-09T23:30:00.123456+00:00';
    const reads = pages.map((page) => readCollectPurePayoutHistoryPage(page.json));
    assert.deepEqual(reads.map((read) => read.ok && read.page.hasNext), [true, false]);
    assert.equal(reads[1].ok && reads[1].page.items[0].createdAt, '2025-11-09T23:30:00.123Z');
  });

  it('reads the stats files as counts only', () => {
    for (const snapshot of [false, true]) {
      const [sell, buy, inventory] = syntheticCollectPureCapture({ ...syntheticCollectPureSpec(), snapshot }).stats;
      assert.deepEqual([sell.name, buy.name, inventory.name], ['sell-stats.json', 'buy-stats.json', 'inventory-stats.json']);
      assert.deepEqual(readCollectPureOrderStats(sell.json), { ok: true, counts: { total: 2, active: 1, completed: 1, cancelled: 0 } });
      assert.deepEqual(readCollectPureOrderStats(buy.json), { ok: true, counts: { total: 0, active: 0, completed: 0, cancelled: 0 } });
      assert.deepEqual(readCollectPureInventoryStats(inventory.json), { ok: true, counts: { totalCount: 0, listedCount: 0, unlistedCount: 0 } });
    }
  });

  it('refuses a raw API file of another shape, a snapshot copy whose fetch failed, and a cursor of another type', () => {
    const capture = syntheticCollectPureCapture({ ...syntheticCollectPureSpec(), snapshot: true });
    const page = capture.payoutHistoryPages[0].json;
    const [sell, , inventory] = capture.stats;
    page.status = 500;
    assertIssue(issuesOf(readCollectPurePayoutHistoryPage(page)), '$.status', /must be 200/);
    page.status = 200;
    at(page, 'result', 'data', 'json').nextCursor = { next: 2 };
    assertIssue(issuesOf(readCollectPurePayoutHistoryPage(page)), '$.result.data.json.nextCursor', /must be a number or null/);
    at(page, 'result', 'data', 'json').nextCursor = '2';
    assertIssue(issuesOf(readCollectPurePayoutHistoryPage(page)), '$.result.data.json.nextCursor', /must be a number or null/);
    delete at(page, 'result', 'data', 'json').nextCursor;
    assertIssue(issuesOf(readCollectPurePayoutHistoryPage(page)), '$.result.data.json.nextCursor', /is missing/);
    at(page, 'result', 'data', 'json', 'items', 0).amount = 2456.01;
    assertIssue(issuesOf(readCollectPurePayoutHistoryPage(page)), '$.result.data.json.items[0].amount', /integer/);
    at(page, 'result', 'data', 'json', 'items', 0).payoutDate = '10/9/2025';
    assertIssue(issuesOf(readCollectPurePayoutHistoryPage(page)), '$.result.data.json.items[0].payoutDate', /real YYYY-MM-DD/);
    at(sell.json, 'result', 'data', 'json').total = 2.5;
    assertIssue(issuesOf(readCollectPureOrderStats(sell.json)), '$.result.data.json.total', /integer/);
    delete at(inventory.json, 'result').data;
    assertIssue(issuesOf(readCollectPureInventoryStats(inventory.json)), '$.result.data', /is missing/);
    assertIssue(issuesOf(readCollectPureOrderStats([])), '$', /must be an object/);
  });

  it('names no value in any issue of a payout-history page', () => {
    const page = fresh().payoutHistoryPages[0].json;
    const item = at(page, 'result', 'data', 'json', 'items', 0);
    item.id = { id: syntheticPayoutId(1, 0) };
    item.orderId = `${syntheticSellOrderId(1)} ${SYNTHETIC_COLLECTPURE_BANK}`;
    item.amount = '$2,456.01';
    item.payoutDate = SYNTHETIC_COLLECTPURE_CONFIRMATION;
    item.createdAt = SYNTHETIC_COLLECTPURE_ACCOUNT;
    const issues = issuesOf(readCollectPurePayoutHistoryPage(page));
    assert.equal(issues.length, 5);
    const text = JSON.stringify(issues);
    for (const value of syntheticSensitiveValues()) assert.ok(!text.includes(value), `an issue shows ${value}`);
  });
});
