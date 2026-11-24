import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { retailNaturalKey, validateRetailImportPayload, type RetailImportPayload } from '../../retailImportTool/payload.js';
import { convertCostcoCapture } from '../../retailImportTool/costco.js';
import { RETAIL_METAL_GUARD_EVIDENCE } from '../../retailImportTool/metalTitleRule.js';
import {
  SYNTHETIC_CARD_2 as CAPTURE_CARD_2,
  syntheticCostcoCapture,
  syntheticMembershipSpec,
  syntheticOrderNumber,
  syntheticSensitiveValues,
} from '../../retailImportTool/__fixtures__/costcoCapture.js';
import { metalsAdmission } from '../admission.js';
import { metalsContentFingerprint, metalsFineContent, metalsFineContentWire } from '../contentRule.js';
import { METALS_GUARD_EVIDENCE, METALS_RULES, METALS_TITLE_GUARD } from '../model.js';
import { metalsDigest, metalsNaturalKey, serializeMetalsImportPayload, validateMetalsImportPayload, type MetalsLine, type MetalsOrder } from '../payload.js';
import { METALS_CONVERTER, MetalsConvertError } from './common.js';
import {
  convertCostcoRetailPayload,
  costcoMetalsFromRetail,
  METALS_COSTCO_CONVERTER,
  METALS_COSTCO_HOLD_CHECKS,
  METALS_COSTCO_TITLE_GUARD,
  type MetalsCostcoConvertResult,
} from './costco.js';
import {
  lineKey,
  onlineOrder,
  orderKey,
  receiptKey,
  retailBytes,
  retailPayload,
  SYNTHETIC_CARD,
  SYNTHETIC_CARD_2,
  SYNTHETIC_MEMBERSHIP,
  metalOf,
  syntheticFlag,
  warehouseReceipt,
  type OnlineLineSpec,
  type OnlineOrderSpec,
  type RetailPayloadSpec,
  type SyntheticEvents,
} from './__fixtures__/costcoRetailPayloads.js';

/** Synthetic retail payloads only: invented keys, titles, amounts and card endings. */
type Rec = Record<string, unknown>;

const ADAPTER_DIGEST = 'd'.repeat(64);

const GOLD_BAR = 'SAMPLE GOLD BAR 1 OZT';
const GOLD_PACK = 'SAMPLE GOLD BAR 1 OZT 5 PACK';
const SILVER_ROUND = 'SAMPLE SILVER ROUND 1 OZT';
const TWO_METALS = 'SAMPLE GOLD AND SILVER BAR 1 OZT';
const PAPER = 'SAMPLE PAPER TOWELS';
const COSTCO_TENDER = 'costco-settled-tender@1';
/** Titles the title rule reads as no metal, and the flags the title guard gave them (stated, never derived). */
const KEEPSAKE = 'SAMPLE GOLD KEEPSAKE 1 OZT';
const GOLD_FLAG = syntheticFlag(['bullion-word', 'troy-or-metric-weight'], 'XAU');
const MIXED_FLAG = syntheticFlag(['shape-with-weight'], null);

type Census = MetalsCostcoConvertResult['report']['census'];

/**
 * A conversion's census as its synthetic fixture knows it: the retail metal lines and flagged lines, each as [in the
 * retail payload, in orders, in records the adapter held], and the held records that have a flagged line.
 */
function census(metal: readonly [number, number, number], flagged: readonly [number, number, number] = [0, 0, 0], heldAlsoFlaggedOrders = 0): Census {
  return {
    retailMetalLines: metal[0], metalLinesInOrders: metal[1], metalLinesInHeldRecords: metal[2],
    retailFlaggedLines: flagged[0], flaggedLinesInOrders: flagged[1], flaggedLinesInHeldRecords: flagged[2],
    heldMetalWordLines: metal[2] + flagged[2], heldAlsoFlaggedOrders,
  };
}

/**
 * Every result is checked as the CLI checks it: valid, canonical, of this source and converter. Its census balances
 * (metal in = metal out, flags in = flags out) and is exactly what the fixture is known to hold.
 */
function checked(result: MetalsCostcoConvertResult, expected: Census): MetalsCostcoConvertResult {
  const validation = validateMetalsImportPayload(JSON.parse(result.json));
  assert.equal(validation.ok, true, validation.ok ? '' : JSON.stringify(validation.issues));
  assert.equal(serializeMetalsImportPayload(result.payload), result.json);
  assert.equal(result.payload.source, 'costco');
  assert.equal(result.payload.converterVersion, METALS_CONVERTER);
  const actual = result.report.census;
  assert.equal(actual.retailMetalLines, actual.metalLinesInOrders + actual.metalLinesInHeldRecords, 'metal in = metal out');
  assert.equal(actual.retailFlaggedLines, actual.flaggedLinesInOrders + actual.flaggedLinesInHeldRecords, 'flags in = flags out');
  assert.deepEqual(actual, expected, 'the census is the known count of the fixture');
  return result;
}

/** A retail payload the retail validator accepts. */
function assertRetailValid(retail: Rec): void {
  const validation = validateRetailImportPayload(retail);
  assert.equal(validation.ok, true, validation.ok ? '' : JSON.stringify(validation.issues));
}

/**
 * Straight to the adapter, with no retail validation: for the adapter's own defences against payloads no retail
 * validator lets through, and for a fixed input digest whatever the payload's bytes.
 */
const adapterOnly = (retail: Rec) => costcoMetalsFromRetail({
  retail: retail as unknown as RetailImportPayload, retailPayloadSha256: ADAPTER_DIGEST, converterVersion: METALS_CONVERTER,
});

/** One retail payload, which the retail validator must accept, through the CLI's entry (its bytes), not yet checked. */
function convertedRetail(retail: Rec): MetalsCostcoConvertResult {
  assertRetailValid(retail);
  return convertCostcoRetailPayload({ bytes: retailBytes(retail), converterVersion: METALS_CONVERTER });
}

/** One retail payload, which the retail validator must accept, through the CLI's entry: its bytes. */
function convertRetail(retail: Rec, expected: Census): MetalsCostcoConvertResult {
  return checked(convertedRetail(retail), expected);
}

const convert = (spec: Omit<RetailPayloadSpec, 'format'>, expected: Census) => convertRetail(retailPayload({ ...spec, format: 3 }), expected);
/**
 * convert's conversion, not yet checked: for a test whose kill site is an assertion of checked(), which its body then
 * calls itself, so that the frame under that assertion is the body's calling line (ROOT's kill addendum 3).
 */
const converted = (spec: Omit<RetailPayloadSpec, 'format'>) => convertedRetail(retailPayload({ ...spec, format: 3 }));

/**
 * The converter's declared refusal a call throws, as its code and path, or null when it throws none. Only a
 * MetalsConvertError is taken; anything else is rethrown unchanged, so that no unexpected error becomes data for an
 * assertion (ROOT's kill addendum 3e). The test body asserts on what it returns.
 */
function refusalOf(run: () => unknown): { code: string; at: string | null } | null {
  try {
    run();
  } catch (error) {
    if (error instanceof MetalsConvertError) return { code: error.code, at: error.at };
    throw error;
  }
  return null;
}

const ONE_SHIPMENT: Pick<OnlineLineSpec, 'shipments' | 'events'> = {
  shipments: [{ shipped: '2030-03-03', delivered: '2030-03-05' }],
  events: { shipped: [[1, '2030-03-03']], delivered: [[1, '2030-03-05']] },
};

/** A one-line gold order with one shipment record, paid by one card. */
function goldOrder(id: string, order: Partial<OnlineOrderSpec> = {}, line: Partial<OnlineLineSpec> = {}): Rec {
  return onlineOrder({
    id, date: '2030-03-01', ...order,
    lines: [{ id: '1', title: GOLD_BAR, itemNumber: '10001', quantity: 1, unitPrice: 250000, ...ONE_SHIPMENT, ...line }],
  });
}

const orderOf = (result: MetalsCostcoConvertResult, key: string): MetalsOrder => {
  const order = result.payload.orders.find((entry) => entry.key === key);
  assert.ok(order, 'the order is there');
  return order;
};

const contentOf = (line: MetalsLine) => ({
  source: 'costco' as const, metal: line.metal, form: line.form, statedMass: line.statedMass, pack: line.pack, purity: null,
  massBasis: null, design: null, metalUncertain: line.metalUncertain,
});

const card = (amountMinor: number, last4 = SYNTHETIC_CARD) => ({ kind: 'card', network: 'visa', last4, amountMinor });

describe('Costco adapter: online orders', () => {
  it('admits the one card tender of an order with exactly one shipment record, and keeps its lot', () => {
    const result = convert({ receipts: [goldOrder('a', { tax: 1300 })] }, census([1, 1, 0]));
    assert.equal(result.payload.orders.length, 1);
    assert.equal(result.payload.competitors.length, 0);
    const order = orderOf(result, orderKey('a'));
    assert.equal(order.channel, 'online');
    assert.equal(order.date, '2030-03-01');
    assert.deepEqual(order.admission, {
      fulfilment: { shipments: 1 }, methods: [card(251300)], refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 251300,
    });
    assert.deepEqual(order.evidence, [{ class: COSTCO_TENDER, tender: 0, amountMinor: 251300 }]);
    assert.equal(order.fullPriceMinor, 251300);
    const [lot] = order.lines;
    assert.equal(lot.key, lineKey('a', '1'));
    assert.equal(lot.title, GOLD_BAR);
    assert.equal(lot.productRef, 'costco:10001');
    assert.equal(lot.metal, 'XAU');
    assert.equal(lot.form, 'bar');
    assert.deepEqual(lot.statedMass, { value: '1', unit: 'ozt' });
    assert.deepEqual([lot.purity, lot.massBasis, lot.design], [null, null, null]);
    assert.equal(lot.quantity, 1);
    assert.equal(lot.unitPriceMinor, 250000);
    assert.deepEqual(lot.allocated, [{ component: 'tax', amountMinor: 1300 }]);
    assert.equal(lot.costMinor, 251300);
    assert.equal(lot.complete, true);
    assert.deepEqual(lot.events, [
      { kind: 'shipped', date: '2030-03-03', dateBasis: 'stated', quantity: 1, occurrence: 1 },
      { kind: 'delivered', date: '2030-03-05', dateBasis: 'stated', quantity: 1, occurrence: 1 },
    ]);
    assert.equal(lot.contentFingerprint, metalsContentFingerprint(contentOf(lot)));
    assert.deepEqual(lot.fine, metalsFineContentWire(metalsFineContent(contentOf(lot))));
  });

  it('counts shipment records order-wide: two on one line, or one on each of two lines, is no single charge', () => {
    const result = convert({
      receipts: [
        goldOrder('b1', {}, { shipments: [{ shipped: '2030-03-03' }, { shipped: '2030-03-04' }] }),
        onlineOrder({
          id: 'b2', date: '2030-03-01', lines: [
            { id: '1', title: GOLD_BAR, quantity: 1, unitPrice: 250000, shipments: [{ shipped: '2030-03-03' }] },
            { id: '2', title: SILVER_ROUND, quantity: 1, unitPrice: 5000, shipments: [{ shipped: '2030-03-04' }] },
          ],
        }),
        onlineOrder({
          id: 'b3', date: '2030-03-01', lines: [
            { id: '1', title: GOLD_BAR, quantity: 1, unitPrice: 250000, shipments: [{ shipped: '2030-03-03' }] },
            { id: '2', title: PAPER, quantity: 1, unitPrice: 2000, shipments: [{ shipped: '2030-03-03' }] },
          ],
        }),
      ],
    }, census([4, 4, 0]));
    for (const id of ['b1', 'b2', 'b3']) {
      const order = orderOf(result, orderKey(id));
      assert.deepEqual(order.admission?.fulfilment, { shipments: 2 }, id);
      assert.deepEqual(order.evidence, [], id);
    }
    assert.equal(orderOf(result, orderKey('b2')).lines.length, 2);
  });

  it('gives no evidence without a shipment record, and a shared shipped date never makes one shipment', () => {
    const shared: SyntheticEvents = { shipped: [[1, '2030-03-03'], [1, '2030-03-03']] };
    const result = convert({
      receipts: [
        goldOrder('c1', {}, { shipments: [] }),
        goldOrder('c2', {}, { shipments: [{ shipped: '2030-03-03' }, { shipped: '2030-03-03' }] }),
        goldOrder('c3', {}, { quantity: 2, unitPrice: 125000, shipments: [], events: shared }),
        onlineOrder({ id: 'c4', date: '2030-03-01', lines: [{ id: '1', title: PAPER, quantity: 2, unitPrice: 1000, shipments: [{ shipped: '2030-03-03' }, { shipped: '2030-03-03' }] }] }),
      ],
    }, census([3, 3, 0]));
    assert.deepEqual(orderOf(result, orderKey('c1')).admission?.fulfilment, { shipments: null });
    assert.deepEqual(orderOf(result, orderKey('c2')).admission?.fulfilment, { shipments: 2 });
    const c3 = orderOf(result, orderKey('c3'));
    assert.deepEqual(c3.admission?.fulfilment, { shipments: null });
    assert.deepEqual(c3.lines[0].events.map((event) => [event.kind, event.date, event.occurrence]), [['shipped', '2030-03-03', 1], ['shipped', '2030-03-03', 2]]);
    for (const id of ['c1', 'c2', 'c3']) assert.deepEqual(orderOf(result, orderKey(id)).evidence, [], id);
    const [competitor] = result.payload.competitors;
    assert.equal(competitor.orderKey, orderKey('c4'));
    assert.equal(competitor.basis, 'aggregate');
    assert.equal(competitor.capMinor, 2000);
  });

  it('keeps coupon tenders as the discount, never as funding', () => {
    const order = orderOf(convert({ receipts: [goldOrder('d', { discount: 5000, coupons: [5000] })] }, census([1, 1, 0])), orderKey('d'));
    assert.deepEqual(order.admission?.methods, [card(245000)]);
    assert.deepEqual(order.components, [{ kind: 'discount', amountMinor: -5000 }]);
    assert.equal(order.fullPriceMinor, 245000);
    assert.deepEqual(order.evidence, [{ class: COSTCO_TENDER, tender: 0, amountMinor: 245000 }]);
    assert.deepEqual(order.lines[0].allocated, [{ component: 'discount', amountMinor: -5000 }]);
    assert.equal(order.lines[0].costMinor, 245000);
  });

  it('carries every money line in the skeleton: fee lines with their parent, order fees unattributed on a mixed order', () => {
    const result = converted({
      receipts: [
        onlineOrder({
          id: 'e1', date: '2030-03-01', lines: [
            { id: '1', title: GOLD_BAR, quantity: 1, unitPrice: 250000, shipments: [{}] },
            { id: '2', title: 'SAMPLE HANDLING FEE', quantity: 1, unitPrice: 1500, feeParent: 0 },
          ],
        }),
        onlineOrder({
          id: 'e2', date: '2030-03-02', tax: 800, fees: 300, lines: [
            { id: '1', title: GOLD_BAR, quantity: 1, unitPrice: 250000, shipments: [{}] },
            { id: '2', title: PAPER, quantity: 1, unitPrice: 2000 },
          ],
        }),
      ],
    });
    // Nothing is held, by its exact records, before the census: a mutant that holds one names its check here.
    assert.deepEqual(result.payload.held, []);
    checked(result, census([2, 2, 0]));
    const e1 = orderOf(result, orderKey('e1'));
    assert.deepEqual(e1.skeleton[1], { ordinal: 1, kind: 'fee', amountMinor: 1500, shippingMinor: 0, feeParent: 0, couponTarget: null, taxFlag: null, metal: true });
    assert.equal(e1.lines[0].directMinor, 251500);
    assert.equal(e1.fullPriceMinor, 251500);
    const e2 = orderOf(result, orderKey('e2'));
    assert.deepEqual(e2.skeleton.map((line) => [line.kind, line.metal, line.feeParent, line.amountMinor]), [
      ['item', true, null, 250000], ['item', false, null, 2000], ['fee', false, null, 300],
    ]);
    assert.equal(e2.unattributedMinor, 1100);
    assert.equal(e2.lines.length, 1);
    assert.equal(e2.lines[0].costMinor, 250000);
    assert.equal(e2.lines[0].complete, false);
    assert.equal(e2.fullPriceMinor, 253100);
  });

  it('turns events into lot events, numbered by occurrence; a return makes the funding an aggregate', () => {
    const order = orderOf(convert({
      receipts: [goldOrder('f', {}, {
        quantity: 3, unitPrice: 100000,
        events: { shipped: [[3, '2030-03-02']], delivered: [[1, '2030-03-04'], [1, '2030-03-04'], [1, '2030-03-06']], returned: [[1, '2030-03-10']] },
      })],
    }, census([1, 1, 0])), orderKey('f'));
    assert.deepEqual(order.lines[0].events.map((event) => [event.kind, event.date, event.quantity, event.occurrence]), [
      ['shipped', '2030-03-02', 3, 1], ['delivered', '2030-03-04', 1, 1], ['delivered', '2030-03-04', 1, 2], ['delivered', '2030-03-06', 1, 1],
      ['returned', '2030-03-10', 1, 1],
    ]);
    assert.equal(order.admission?.refunded, true);
    assert.deepEqual(order.evidence, []);
  });

  it('keeps a cancelled order whose events cancel every unit, with no card and no unit price that disagrees', () => {
    const order = orderOf(convert({
      receipts: [goldOrder('g', { status: 'cancelled' }, { amount: 0, shipments: [], events: { cancelled: [[1, '2030-03-02']] } })],
    }, census([1, 1, 0])), orderKey('g'));
    assert.deepEqual(order.admission?.methods, []);
    assert.equal(order.admission?.cancelled, true);
    assert.deepEqual(order.evidence, []);
    assert.equal(order.lines[0].unitPriceMinor, null);
    assert.equal(order.lines[0].costMinor, 0);
    assert.deepEqual(order.lines[0].events.map((event) => event.kind), ['cancelled']);
  });

  it('holds an order a lot cannot carry: its status or events, an event before the order, no units, a wrong-sign tax or discount', () => {
    const result = checked(converted({
      receipts: [
        goldOrder('h1', { status: 'returned' }),
        goldOrder('h2', { status: 'cancelled' }),
        goldOrder('h3', {}, { events: { delivered: [[1, '2030-03-05'], [1, '2030-03-06']] } }),
        goldOrder('h4', {}, { events: { delivered: [[1, '2030-03-05']], returned: [[1, '2030-03-08'], [1, '2030-03-09']] } }),
        onlineOrder({
          id: 'h5', date: '2030-03-01', lines: [
            { id: '1', title: GOLD_BAR, quantity: 0, unitPrice: 250000, amount: 0 },
            { id: '2', title: PAPER, quantity: 1, unitPrice: 2000, shipments: [{}] },
          ],
        }),
        goldOrder('h6', { discount: -500 }),
        goldOrder('h7', { tax: -100 }),
        goldOrder('h8', { discount: 500, coupons: [500] }),
        goldOrder('h9', {}, { events: { shipped: [[1, '2030-02-27']], delivered: [[1, '2030-03-05']] } }),
      ],
    }), census([9, 1, 8]));
    assert.deepEqual(result.payload.orders.map((order) => order.key), [orderKey('h8')], 'an ordinary discount is never held');
    assert.equal(result.payload.competitors.length, 0);
    const held = (id: string) => result.payload.held.find((entry) => entry.key === orderKey(id));
    assert.deepEqual(held('h1'), { key: orderKey('h1'), channel: 'online', date: '2030-03-01', reason: 'status-ambiguous', check: 'return-unstated' });
    assert.equal(held('h2')?.check, 'cancel-unstated');
    assert.equal(held('h3')?.check, 'event-units');
    assert.equal(held('h4')?.check, 'event-units');
    assert.deepEqual(held('h5'), { key: orderKey('h5'), channel: 'online', date: '2030-03-01', reason: 'quantity-unknown', check: 'metal-quantity' });
    assert.deepEqual(held('h6'), { key: orderKey('h6'), channel: 'online', date: '2030-03-01', reason: 'field-unsupported', check: 'discount-sign' });
    assert.deepEqual(held('h7'), { key: orderKey('h7'), channel: 'online', date: '2030-03-01', reason: 'field-unsupported', check: 'tax-sign' });
    assert.deepEqual(held('h9'), { key: orderKey('h9'), channel: 'online', date: '2030-03-01', reason: 'status-ambiguous', check: 'event-before-order' });
  });

  it('turns every other order with card funding into a competitor, single-charge or aggregate', () => {
    const result = convert({
      receipts: [
        onlineOrder({ id: 'p1', date: '2030-04-01', lines: [{ id: '1', title: PAPER, quantity: 2, unitPrice: 1999, shipments: [{ shipped: '2030-04-02' }] }] }),
        onlineOrder({ id: 'p2', date: '2030-04-02', lines: [{ id: '1', title: PAPER, quantity: 1, unitPrice: 1999, shipments: [{}, {}] }] }),
        onlineOrder({
          id: 'p3', date: '2030-04-03', status: 'returned',
          lines: [{ id: '1', title: PAPER, quantity: 1, unitPrice: 1999, shipments: [{}], events: { delivered: [[1, '2030-04-05']], returned: [[1, '2030-04-09']] } }],
        }),
        onlineOrder({ id: 'p4', date: '2030-04-04', status: 'cancelled', lines: [{ id: '1', title: PAPER, quantity: 1, unitPrice: 1999, amount: 0, events: { cancelled: [[1, '2030-04-04']] } }] }),
      ],
    }, census([0, 0, 0]));
    assert.equal(result.payload.orders.length, 0);
    assert.deepEqual(result.payload.competitors.map((competitor) => [competitor.orderKey, competitor.basis, competitor.capMinor]), [
      [orderKey('p1'), 'single-charge', null], [orderKey('p2'), 'aggregate', 1999], [orderKey('p3'), 'aggregate', 1999],
    ]);
    assert.deepEqual(result.payload.competitors[0], {
      orderKey: orderKey('p1'), channel: 'online', date: '2030-04-01', interval: { from: '2030-04-01', to: '2030-05-01' },
      admission: { fulfilment: { shipments: 1 }, methods: [card(3998)], refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 3998 },
      basis: 'single-charge', capMinor: null,
    });
    assert.equal(result.report.records.noCardFunding, 1);
  });

  it('reads a partly cancelled order: a metal one gets no card evidence, any other is an aggregate up to its gross', () => {
    const partly: Pick<OnlineLineSpec, 'quantity' | 'shipments' | 'events'> = {
      quantity: 2,
      shipments: [{ shipped: '2030-03-03', delivered: '2030-03-05' }],
      events: { shipped: [[1, '2030-03-03']], delivered: [[1, '2030-03-05']], cancelled: [[1, '2030-03-02']] },
    };
    const result = convert({
      receipts: [
        goldOrder('pc1', {}, { ...partly, unitPrice: 125000 }),
        onlineOrder({ id: 'pc2', date: '2030-03-01', lines: [{ id: '1', title: PAPER, unitPrice: 1999, ...partly }] }),
      ],
    }, census([1, 1, 0]));
    const order = orderOf(result, orderKey('pc1'));
    assert.deepEqual(order.admission, {
      fulfilment: { shipments: 1 }, methods: [card(250000)], refunded: false, cancelled: false, partlyCancelled: true, grossTotalMinor: 250000,
    });
    assert.deepEqual(order.evidence, []);
    assert.deepEqual(order.lines[0].events.map((event) => [event.kind, event.quantity]), [['shipped', 1], ['delivered', 1], ['cancelled', 1]]);
    assert.deepEqual(result.payload.competitors.map((competitor) => [competitor.orderKey, competitor.admission.partlyCancelled, competitor.basis, competitor.capMinor]),
      [[orderKey('pc2'), true, 'aggregate', 3998]]);
    assert.deepEqual(result.payload.held, []);
  });

  it('reads a return from the status alone: an order that says returned, with no return event, is an aggregate', () => {
    const result = convert({
      receipts: [onlineOrder({ id: 'rs', date: '2030-04-01', status: 'returned', lines: [{ id: '1', title: PAPER, quantity: 1, unitPrice: 1999, shipments: [{}] }] })],
    }, census([0, 0, 0]));
    assert.deepEqual(result.payload.competitors.map((competitor) => [competitor.orderKey, competitor.admission.refunded, competitor.basis, competitor.capMinor]),
      [[orderKey('rs'), true, 'aggregate', 1999]]);
  });

  it('holds an order it cannot carry whole: a negative metal amount, or more events, lines or shipment records than a payload carries', () => {
    const many = <T>(count: number, make: (index: number) => T): T[] => Array.from({ length: count }, (_, index) => make(index));
    const result = convert({
      receipts: [
        warehouseReceipt({
          id: 'hm', date: '2030-06-10', tenders: [{ kind: 'card', amount: 50000 }],
          lines: [{ title: 'SAMPLE GOLD BAR', title2: '1 OZT', quantity: 1, unitPrice: 250000, amount: -250000 }, { title: PAPER, amount: 300000 }],
        }),
        goldOrder('he', {}, {
          quantity: 30, unitPrice: 10000, shipments: [{}],
          events: { shipped: many(26, () => [1, '2030-03-03'] as const), delivered: many(26, () => [1, '2030-03-05'] as const) },
        }),
        onlineOrder({
          id: 'hl', date: '2030-03-01', fees: 300, lines: [
            { id: '0', title: GOLD_BAR, quantity: 1, unitPrice: 250000, shipments: [{}] },
            ...many(499, (index) => ({ id: String(index + 1), title: PAPER, quantity: 1, unitPrice: 100 })),
          ],
        }),
        onlineOrder({
          id: 'hs', date: '2030-03-01', lines: [
            { id: '0', title: GOLD_BAR, quantity: 1, unitPrice: 250000, shipments: many(20, () => ({})) },
            ...many(50, (index) => ({ id: String(index + 1), title: PAPER, quantity: 1, unitPrice: 100, shipments: many(20, () => ({})) })),
          ],
        }),
      ],
    }, census([4, 0, 4]));
    assert.equal(result.payload.orders.length, 0);
    assert.equal(result.payload.competitors.length, 0);
    assert.equal(result.payload.held.length, 4);
    const held = (key: string) => result.payload.held.find((entry) => entry.key === key);
    assert.deepEqual(held(receiptKey('hm')), { key: receiptKey('hm'), channel: 'warehouse', date: '2030-06-10', reason: 'field-unsupported', check: 'metal-amount' });
    assert.deepEqual(held(orderKey('he')), { key: orderKey('he'), channel: 'online', date: '2030-03-01', reason: 'field-unsupported', check: 'event-count' });
    assert.deepEqual(held(orderKey('hl')), { key: orderKey('hl'), channel: 'online', date: '2030-03-01', reason: 'field-unsupported', check: 'skeleton-size' });
    assert.deepEqual(held(orderKey('hs')), { key: orderKey('hs'), channel: 'online', date: '2030-03-01', reason: 'field-unsupported', check: 'shipment-records' });
  });

  it('holds what no retail validator lets through: a skeleton it cannot read, a full price that is not the total', () => {
    const feeOnFee = onlineOrder({
      id: 'hf', date: '2030-03-01', lines: [
        { id: '1', title: GOLD_BAR, quantity: 1, unitPrice: 250000, shipments: [{}] },
        { id: '2', title: 'SAMPLE HANDLING FEE', quantity: 1, unitPrice: 1500, feeParent: 0 },
      ],
    });
    (feeOnFee.lines as Rec[])[1].feeParent = 1;
    const taxOff = warehouseReceipt({ id: 'ht', date: '2030-06-11', lines: [{ title: 'SAMPLE GOLD BAR', title2: '1 OZT', amount: 250000 }], tenders: [{ kind: 'card', amount: 250000 }] });
    (taxOff.totals as Rec).taxMinor = 100;
    for (const receipt of [feeOnFee, taxOff]) {
      assert.equal(validateRetailImportPayload(retailPayload({ format: 3, receipts: [receipt] })).ok, false);
    }
    const result = checked(adapterOnly(retailPayload({ format: 3, receipts: [feeOnFee, taxOff] })), census([2, 0, 2]));
    assert.equal(result.payload.orders.length, 0);
    assert.deepEqual(result.payload.held, [
      { key: orderKey('hf'), channel: 'online', date: '2030-03-01', reason: 'field-unsupported', check: 'skeleton-shape' },
      { key: receiptKey('ht'), channel: 'warehouse', date: '2030-06-11', reason: 'identity-failed', check: 'full-price' },
    ]);
  });
});

describe('Costco adapter: Shop Card, packs and held records', () => {
  it('funds the stored value with Shop Card tenders, and admits the card tender of the total', () => {
    const result = converted({
      receipts: [
        goldOrder('s1', { storedValue: 50000 }, { pack: 'single' }),
        goldOrder('s2', { storedValue: 250000 }, { pack: 'single' }),
        onlineOrder({ id: 's3', date: '2030-03-02', storedValue: 1999, lines: [{ id: '1', title: PAPER, quantity: 1, unitPrice: 1999, shipments: [{}] }] }),
        onlineOrder({ id: 's4', date: '2030-03-02', storedValue: 850, lines: [{ id: '1', title: PAPER, quantity: 1, unitPrice: 2350, shipments: [{}] }] }),
      ],
    });
    // Nothing is held, by its exact records, before the census: a mutant that holds one names its check here.
    assert.deepEqual(result.payload.held, []);
    checked(result, census([2, 2, 0]));
    const shopCard = (amountMinor: number) => ({ kind: 'shop-card', network: 'unknown', last4: null, amountMinor });
    const s1 = orderOf(result, orderKey('s1'));
    assert.deepEqual(s1.admission?.methods, [card(200000), shopCard(50000)]);
    assert.equal(s1.admission?.grossTotalMinor, 250000);
    assert.equal(s1.fullPriceMinor, 250000);
    assert.deepEqual(s1.evidence, [{ class: COSTCO_TENDER, tender: 0, amountMinor: 200000 }]);
    // A Shop-Card-only order has no card evidence; one with no metal competes with nothing.
    const s2 = orderOf(result, orderKey('s2'));
    assert.deepEqual(s2.admission?.methods, [shopCard(250000)]);
    assert.deepEqual(s2.evidence, []);
    assert.deepEqual(result.payload.competitors.map((competitor) => competitor.orderKey), [orderKey('s4')]);
    assert.deepEqual(result.payload.competitors[0].admission.methods, [card(1500), shopCard(850)]);
    assert.equal(result.payload.competitors[0].basis, 'single-charge');
    assert.equal(result.report.records.noCardFunding, 1);
  });

  it("never makes a line that buys a Shop Card metal, and holds a record whose metal evidence is on a line that can't be a lot", () => {
    const result = convertRetail(retailPayload({
      format: 3,
      receipts: [onlineOrder({ id: 'sc', date: '2030-03-01', lines: [{ id: '1', title: 'SAMPLE SHOP CARD', quantity: 1, unitPrice: 50000, shipments: [{}], storedValue: 'costco-shop-card' }] })],
    }), census([0, 0, 0]));
    assert.equal(result.payload.orders.length, 0);
    assert.deepEqual(result.payload.competitors.map((competitor) => competitor.orderKey), [orderKey('sc')]);
    // Metal evidence on a line that buys a Shop Card, or on a fee or fuel line (all of which the retail validator
    // refuses), makes no lot: the record is held, so no retail metal line is lost.
    const goldMetal = metalOf(GOLD_BAR);
    const direct = checked(adapterOnly(retailPayload({
      format: 3,
      receipts: [
        onlineOrder({ id: 'sm', date: '2030-03-01', lines: [{ id: '1', title: GOLD_BAR, quantity: 1, unitPrice: 250000, shipments: [{}], storedValue: 'costco-shop-card' }] }),
        onlineOrder({
          id: 'mf', date: '2030-03-01', lines: [
            { id: '1', title: PAPER, quantity: 1, unitPrice: 2350, shipments: [{}] },
            { id: '2', title: GOLD_BAR, quantity: 1, unitPrice: 1500, feeParent: 0, metal: goldMetal },
          ],
        }),
        warehouseReceipt({ id: 'mg', date: '2030-07-01', gas: true, lines: [{ title: GOLD_BAR, kind: 'fuel', quantity: null, amount: 4500, taxFlag: null, metal: goldMetal }], tenders: [{ kind: 'card', amount: 4500 }] }),
      ],
    })), census([3, 0, 3]));
    assert.equal(direct.payload.orders.length, 0);
    assert.deepEqual(direct.payload.competitors, []);
    assert.deepEqual(direct.payload.held.map((entry) => [entry.reason, entry.check]), Array(3).fill(['field-unsupported', 'metal-not-item']));
    assert.deepEqual(new Set(direct.payload.held.map((entry) => entry.key)), new Set([orderKey('sm'), orderKey('mf'), receiptKey('mg')]));
  });

  it('takes the pack as the retail converter wrote it, and holds a single pack whose stored title shows a marker', () => {
    const result = convert({
      receipts: [
        onlineOrder({
          id: 'pk', date: '2030-03-01', lines: [
            { id: '1', title: GOLD_BAR, itemNumber: '10001', quantity: 1, unitPrice: 250000, pack: 'single', shipments: [{}] },
            { id: '2', title: GOLD_PACK, itemNumber: '10002', quantity: 1, unitPrice: 1250000, pack: 'multiple' },
            { id: '3', title: SILVER_ROUND, itemNumber: '10003', quantity: 2, unitPrice: 5000, pack: 'unknown' },
          ],
        }),
        onlineOrder({ id: 'pt', date: '2030-03-02', lines: [{ id: '1', title: GOLD_PACK, quantity: 1, unitPrice: 1250000, pack: 'single', shipments: [{}] }] }),
      ],
    }, census([4, 3, 1]));
    const lots = orderOf(result, orderKey('pk')).lines;
    assert.deepEqual(lots.map((lot) => lot.pack), ['single', 'multiple', 'unknown']);
    for (const lot of lots) {
      assert.deepEqual(lot.fine, metalsFineContentWire(metalsFineContent(contentOf(lot))));
      assert.equal(lot.contentFingerprint, metalsContentFingerprint(contentOf(lot)));
    }
    assert.deepEqual(lots.map((lot) => ('hold' in lot.fine ? lot.fine.hold : null)), ['fine-content-unknown', 'pack-count', 'pack-unproven']);
    assert.deepEqual(result.payload.held, [{ key: orderKey('pt'), channel: 'online', date: '2030-03-02', reason: 'capture-disagreement', check: 'pack-title' }]);
  });

  it("keeps the retail payload's held records, with their dates", () => {
    const held = [
      { channel: 'online' as const, key: orderKey('x1'), reason: 'identity-failed', check: 'order-total', date: '2030-05-01' },
      { channel: 'gas' as const, key: receiptKey('x2'), reason: 'unreadable', check: 'record-shape', date: '2030-05-02' },
      { channel: 'warehouse' as const, key: null, reason: 'unreadable', check: 'record-key' },
    ];
    assert.deepEqual(convert({ held }, census([0, 0, 0])).payload.held, [
      { key: orderKey('x1'), channel: 'online', date: '2030-05-01', reason: 'retail-held', check: 'order-total' },
      { key: null, channel: 'warehouse', date: null, reason: 'retail-held', check: 'record-key' },
      { key: receiptKey('x2'), channel: 'warehouse', date: '2030-05-02', reason: 'retail-held', check: 'record-shape' },
    ]);
  });
});

describe('Costco adapter: retail policies 3 and 4 (formats 1 and 2)', () => {
  it('refuses them: every Costco payload is converted again at policy 5 first', () => {
    for (const format of [1, 2] as const) {
      const retail = retailPayload({ format, receipts: [goldOrder('p3')] });
      assert.deepEqual(refusalOf(() => convertCostcoRetailPayload({ bytes: retailBytes(retail), converterVersion: METALS_CONVERTER })), { code: 'retail-policy-unsupported', at: '$.policyVersion' });
      assert.deepEqual(refusalOf(() => adapterOnly(retail)), { code: 'retail-policy-unsupported', at: '$.policyVersion' });
    }
  });
});

describe('Costco adapter: warehouse receipts', () => {
  const goldLine = { title: 'SAMPLE GOLD BAR', title2: '1 OZT', amount: 250000 };

  it('delivers a sale receipt’s metal line at the register, and admits every card tender', () => {
    const result = convert({
      receipts: [warehouseReceipt({
        id: 'w1', date: '2030-06-01', lines: [goldLine, { title: PAPER, amount: 2000 }],
        tenders: [{ kind: 'card', amount: 150000 }, { kind: 'card', amount: 80000, last4: SYNTHETIC_CARD_2 }, { kind: 'shop-card', amount: 20000 }, { kind: 'cash', amount: 2000 }],
      })],
    }, census([1, 1, 0]));
    const order = orderOf(result, receiptKey('w1'));
    assert.equal(order.channel, 'warehouse');
    assert.deepEqual(order.admission, {
      fulfilment: 'in-store',
      methods: [card(150000), card(80000, SYNTHETIC_CARD_2), { kind: 'shop-card', network: 'unknown', last4: null, amountMinor: 20000 },
        { kind: 'cash', network: 'unknown', last4: null, amountMinor: 2000 }],
      refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 252000,
    });
    assert.deepEqual(order.evidence, [{ class: COSTCO_TENDER, tender: 0, amountMinor: 150000 }, { class: COSTCO_TENDER, tender: 1, amountMinor: 80000 }]);
    const [lot] = order.lines;
    assert.equal(lot.key, metalsNaturalKey('costco', 'wline', [receiptKey('w1'), '0']));
    assert.equal(lot.title, 'SAMPLE GOLD BAR 1 OZT');
    assert.equal(lot.productRef, 'costco:20001');
    assert.deepEqual(lot.statedMass, { value: '1', unit: 'ozt' });
    assert.deepEqual(lot.events, [{ kind: 'delivered', date: '2030-06-01', dateBasis: 'in-store', quantity: 1, occurrence: 1 }]);
    assert.equal(lot.costMinor, 250000);
  });

  it('holds a refund receipt’s metal or flagged line as an unlinked return with its date, and a metal line with no units', () => {
    const result = checked(converted({
      receipts: [
        warehouseReceipt({ id: 'w2', date: '2030-06-03', lines: [{ ...goldLine, quantity: -1, unitPrice: 250000, amount: -250000 }], tenders: [{ kind: 'card-refund', amount: -250000 }] }),
        warehouseReceipt({ id: 'w3', date: '2030-06-04', lines: [{ ...goldLine, quantity: null, unitPrice: null }], tenders: [{ kind: 'card', amount: 250000 }] }),
        warehouseReceipt({
          id: 'w4', date: '2030-06-05', lines: [{ ...goldLine, quantity: -1, unitPrice: 250000, amount: -250000 }, { title: PAPER, amount: 300000 }],
          tenders: [{ kind: 'card', amount: 50000 }],
        }),
        warehouseReceipt({
          id: 'w5', date: '2030-06-06', lines: [{ title: 'SAMPLE GOLD KEEPSAKE', title2: '1 OZT', quantity: -1, unitPrice: 180000, amount: -180000, metalUncertain: GOLD_FLAG }],
          tenders: [{ kind: 'card-refund', amount: -180000 }],
        }),
      ],
    }), census([3, 0, 3], [1, 0, 1], 1));
    assert.equal(result.payload.orders.length, 0);
    assert.equal(result.payload.competitors.length, 0);
    for (const [id, date] of [['w2', '2030-06-03'], ['w5', '2030-06-06']]) {
      assert.deepEqual(result.payload.held.find((entry) => entry.key === receiptKey(id)),
        { key: receiptKey(id), channel: 'warehouse', date, reason: 'return-unlinked', check: 'refund-receipt-metal' });
    }
    for (const id of ['w3', 'w4']) {
      assert.deepEqual(result.payload.held.find((entry) => entry.key === receiptKey(id))?.reason, 'quantity-unknown', id);
    }
  });

  it('keeps a lot’s unit price only when the quantity times it is the amount, and the amount as stated', () => {
    const order = orderOf(convert({
      receipts: [warehouseReceipt({
        id: 'up', date: '2030-06-12', tenders: [{ kind: 'card', amount: 255000 }],
        lines: [
          { title: 'SAMPLE GOLD BAR', title2: '1 OZT', quantity: 2, unitPrice: 125000, amount: 250000 },
          { title: 'SAMPLE SILVER ROUND', title2: '1 OZT', quantity: 1, unitPrice: 6000, amount: 5000 },
        ],
      })],
    }, census([2, 2, 0])), receiptKey('up'));
    assert.deepEqual(order.lines.map((lot) => [lot.quantity, lot.unitPriceMinor, lot.amountMinor, lot.costMinor]), [[2, 125000, 250000, 250000], [1, null, 5000, 5000]]);
  });

  it('reads tax flags Y and N only: a non-taxable metal line gets no tax, an unread flag leaves tax unattributed', () => {
    const result = convert({
      receipts: [
        warehouseReceipt({ id: 't1', date: '2030-06-06', tax: 165, lines: [{ ...goldLine, taxFlag: 'N' }, { title: PAPER, amount: 1999, taxFlag: 'Y' }], tenders: [{ kind: 'card', amount: 252164 }] }),
        warehouseReceipt({ id: 't2', date: '2030-06-06', tax: 165, lines: [{ ...goldLine, taxFlag: 'A' }, { title: PAPER, amount: 1999, taxFlag: 'Y' }], tenders: [{ kind: 'card', amount: 252164 }] }),
      ],
    }, census([2, 2, 0]));
    const t1 = orderOf(result, receiptKey('t1'));
    assert.deepEqual(t1.skeleton.map((line) => line.taxFlag), ['non-taxable', 'taxable']);
    assert.equal(t1.unattributedMinor, 0);
    assert.deepEqual(t1.lines[0].allocated, []);
    assert.equal(t1.lines[0].complete, true);
    const t2 = orderOf(result, receiptKey('t2'));
    assert.deepEqual(t2.skeleton.map((line) => line.taxFlag), [null, 'taxable']);
    assert.equal(t2.unattributedMinor, 165);
    assert.equal(t2.lines[0].complete, false);
  });

  it('makes a coupon on a metal line metal, lowering that line’s cost', () => {
    const result = converted({
      receipts: [warehouseReceipt({
        id: 'cp', date: '2030-06-07', lines: [goldLine, { title: '', kind: 'coupon', amount: -5000, couponTarget: 0 }], tenders: [{ kind: 'card', amount: 245000 }],
      })],
    });
    // Nothing is held, by its exact records, before the census: a mutant that holds one names its check here.
    assert.deepEqual(result.payload.held, []);
    const order = orderOf(checked(result, census([1, 1, 0])), receiptKey('cp'));
    assert.deepEqual(order.skeleton[1], { ordinal: 1, kind: 'coupon', amountMinor: -5000, shippingMinor: null, feeParent: null, couponTarget: 0, taxFlag: 'non-taxable', metal: true });
    assert.equal(order.lines[0].directMinor, 245000);
    assert.equal(order.lines[0].costMinor, 245000);
  });

  it('turns other sale receipts with card funding into competitors, gas as a warehouse receipt; a refund receipt is a credit', () => {
    const result = convert({
      receipts: [
        warehouseReceipt({ id: 'g1', date: '2030-07-01', gas: true, lines: [{ title: 'SAMPLE UNLEADED', kind: 'fuel', quantity: null, amount: 4500, taxFlag: null }], tenders: [{ kind: 'card', amount: 4500 }] }),
        warehouseReceipt({ id: 'r1', date: '2030-07-02', lines: [{ title: PAPER, quantity: -1, unitPrice: 1999, amount: -1999 }], tenders: [{ kind: 'card-refund', amount: -1999 }] }),
        warehouseReceipt({ id: 'c1', date: '2030-07-03', lines: [{ title: PAPER, amount: 1999 }], tenders: [{ kind: 'cash', amount: 1999 }] }),
      ],
    }, census([0, 0, 0]));
    assert.deepEqual(result.payload.competitors, [{
      orderKey: receiptKey('g1'), channel: 'warehouse', date: '2030-07-01', interval: { from: '2030-07-01', to: '2030-07-06' },
      admission: { fulfilment: 'in-store', methods: [card(4500)], refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 4500 },
      basis: 'single-charge', capMinor: null,
    }]);
    assert.deepEqual(result.payload.held, []);
    assert.equal(result.report.competitors.fromGas, 1);
    assert.deepEqual(result.report.records, { orders: 0, competitors: 1, held: 0, credits: 1, noCardFunding: 1 });
  });

  it('holds an order or competitor whose funding has a method of the wrong sign, and nothing else for it', () => {
    const result = convert({
      receipts: [
        // A metal sale paid by a reward certificate above the bill, the change given back in cash: a negative cash method.
        warehouseReceipt({
          id: 'ms1', date: '2030-06-08', lines: [{ title: 'SAMPLE GOLD BAR', title2: '1 OZT', amount: 250000 }],
          tenders: [{ kind: 'reward-certificate', amount: 260000 }, { kind: 'cash', amount: -10000 }],
        }),
        // The same funding with no metal and no card is neither an order nor a competitor, so nothing is held.
        warehouseReceipt({ id: 'ms2', date: '2030-06-08', lines: [{ title: PAPER, amount: 1999 }], tenders: [{ kind: 'reward-certificate', amount: 2500 }, { kind: 'cash', amount: -501 }] }),
        // A card refund that isn't negative, on a sale with a card: a competitor whose funding contradicts itself.
        warehouseReceipt({ id: 'ms3', date: '2030-06-08', lines: [{ title: PAPER, amount: 2350 }], tenders: [{ kind: 'card', amount: 1500 }, { kind: 'card-refund', amount: 850 }] }),
      ],
    }, census([1, 0, 1]));
    assert.equal(result.payload.orders.length, 0);
    assert.equal(result.payload.competitors.length, 0);
    assert.deepEqual(result.payload.held.map((entry) => [entry.key, entry.channel, entry.date, entry.reason, entry.check]).sort(), [
      [receiptKey('ms1'), 'warehouse', '2030-06-08', 'field-unsupported', 'method-sign'],
      [receiptKey('ms3'), 'warehouse', '2030-06-08', 'field-unsupported', 'method-sign'],
    ].sort());
    assert.deepEqual(result.report.records, { orders: 0, competitors: 0, held: 2, credits: 0, noCardFunding: 1 });
  });
});

describe('Costco adapter: lines the title guard flagged (retail policy 5)', () => {
  it("maps a flag 1:1, every evidence code of the guard's closed list in its order, the contract's own list", () => {
    assert.equal(METALS_COSTCO_TITLE_GUARD.guard, METALS_TITLE_GUARD);
    assert.deepEqual([...METALS_COSTCO_TITLE_GUARD.evidence], [...METALS_GUARD_EVIDENCE]);
    // Every code at once; the metal stays null (a title naming several metals), and the next test pins a flag's metal.
    const every = syntheticFlag([...RETAIL_METAL_GUARD_EVIDENCE], null);
    const result = convert({
      receipts: [onlineOrder({
        id: 'ue', date: '2030-03-01',
        lines: [{ id: '1', title: 'SAMPLE GOLD AND SILVER KEEPSAKE 1 OZT', itemNumber: '10041', quantity: 1, unitPrice: 9000, ...ONE_SHIPMENT, metalUncertain: every }],
      })],
    }, census([0, 0, 0], [1, 1, 0]));
    assert.deepEqual(orderOf(result, orderKey('ue')).lines[0].metalUncertain, { guard: METALS_TITLE_GUARD, evidence: [...METALS_GUARD_EVIDENCE], metal: null });
  });
  it('carries an order with a flagged line in full: a lot with no metal and its flag, held bullion-unconfirmed, and no card evidence', () => {
    const result = convert({
      receipts: [
        onlineOrder({
          id: 'u1', date: '2030-03-01',
          lines: [{ id: '1', title: KEEPSAKE, itemNumber: '10021', quantity: 1, unitPrice: 180000, ...ONE_SHIPMENT, metalUncertain: GOLD_FLAG }],
        }),
        onlineOrder({
          id: 'u2', date: '2030-03-01', lines: [
            { id: '1', title: GOLD_BAR, quantity: 1, unitPrice: 250000, ...ONE_SHIPMENT },
            { id: '2', title: 'SAMPLE GOLD AND SILVER KEEPSAKE ROUND', itemNumber: '10022', quantity: 1, unitPrice: 3000, metalUncertain: MIXED_FLAG },
          ],
        }),
        warehouseReceipt({
          id: 'u3', date: '2030-06-01', lines: [{ title: 'SAMPLE GOLD KEEPSAKE', title2: '1 OZT', amount: 180000, metalUncertain: GOLD_FLAG }],
          tenders: [{ kind: 'card', amount: 180000 }],
        }),
      ],
    }, census([1, 1, 0], [3, 3, 0]));
    assert.deepEqual(result.payload.held, []);
    assert.equal(result.payload.competitors.length, 0);
    const u1 = orderOf(result, orderKey('u1'));
    const [lot] = u1.lines;
    assert.deepEqual([lot.key, lot.metal, lot.form, lot.statedMass, lot.pack], [lineKey('u1', '1'), null, null, null, 'unknown']);
    assert.deepEqual(lot.metalUncertain, { guard: 'metal-guard-v1', evidence: ['bullion-word', 'troy-or-metric-weight'], metal: 'XAU' });
    assert.equal('hold' in lot.fine ? lot.fine.hold : null, 'bullion-unconfirmed');
    assert.deepEqual(lot.fine, metalsFineContentWire(metalsFineContent(contentOf(lot))));
    assert.equal(lot.contentFingerprint, metalsContentFingerprint(contentOf(lot)));
    assert.notEqual(lot.contentFingerprint, metalsContentFingerprint({ ...contentOf(lot), metalUncertain: null }), 'the flag is content evidence');
    assert.equal(u1.skeleton[0].metal, true);
    assert.equal(metalsAdmission('costco', 'online', u1.admission!)?.basis, 'single-charge', 'its funding alone would be admitted');
    assert.deepEqual(u1.evidence, []);
    // A flagged line beside a metal line takes the whole order's card evidence away.
    const u2 = orderOf(result, orderKey('u2'));
    assert.deepEqual(u2.lines.map((line) => [line.metal, line.metalUncertain]), [['XAU', null], [null, { guard: 'metal-guard-v1', evidence: ['shape-with-weight'], metal: null }]]);
    assert.deepEqual(u2.skeleton.map((line) => line.metal), [true, true]);
    assert.deepEqual(u2.evidence, []);
    const u3 = orderOf(result, receiptKey('u3'));
    assert.deepEqual(u3.lines[0].events, [{ kind: 'delivered', date: '2030-06-01', dateBasis: 'in-store', quantity: 1, occurrence: 1 }]);
    assert.deepEqual(u3.evidence, []);
    assert.deepEqual([result.report.lots.flagged, result.report.lots.flaggedByMetal.XAU, result.report.lots.flaggedByMetal.none], [3, 2, 1]);
    assert.equal(result.report.lots.byContentHold['bullion-unconfirmed'], 3);
    assert.deepEqual(result.report.evidence, { online: 0, warehouse: 0 });
  });

  it("holds a record whose flag is on a line that can't be a lot: a fee line beside its metal principal, a fuel line, a Shop Card purchase", () => {
    const result = checked(converted({
      receipts: [
        onlineOrder({
          id: 'n1', date: '2030-03-01', lines: [
            { id: '1', title: GOLD_BAR, quantity: 1, unitPrice: 250000, ...ONE_SHIPMENT },
            { id: '2', title: 'SAMPLE GOLD BAR CASE FEE 1 OZT', quantity: 1, unitPrice: 1500, feeParent: 0, metalUncertain: GOLD_FLAG },
          ],
        }),
        warehouseReceipt({
          id: 'n2', date: '2030-07-01', gas: true,
          lines: [{ title: 'SAMPLE GOLD GRADE FUEL 1 OZT', kind: 'fuel', quantity: null, amount: 4500, taxFlag: null, metalUncertain: GOLD_FLAG }],
          tenders: [{ kind: 'card', amount: 4500 }],
        }),
      ],
    }), census([1, 0, 1], [2, 0, 2], 2));
    assert.equal(result.payload.orders.length, 0);
    assert.equal(result.payload.competitors.length, 0);
    assert.deepEqual(result.payload.held, [
      { key: orderKey('n1'), channel: 'online', date: '2030-03-01', reason: 'field-unsupported', check: 'flag-not-item' },
      { key: receiptKey('n2'), channel: 'warehouse', date: '2030-07-01', reason: 'field-unsupported', check: 'flag-not-item' },
    ]);
    // A flag on a line that buys a Shop Card, which the retail validator refuses, holds its record too.
    const shopCard = onlineOrder({
      id: 'n3', date: '2030-03-01',
      lines: [{ id: '1', title: 'SAMPLE GOLD SHOP CARD', quantity: 1, unitPrice: 50000, shipments: [{}], storedValue: 'costco-shop-card', metalUncertain: GOLD_FLAG }],
    });
    assert.equal(validateRetailImportPayload(retailPayload({ format: 3, receipts: [shopCard] })).ok, false);
    assert.deepEqual(checked(adapterOnly(retailPayload({ format: 3, receipts: [shopCard] })), census([0, 0, 0], [1, 0, 1], 1)).payload.held.map((entry) => entry.check), ['flag-not-item']);
  });

  it('answers Q1b beside Q1: bullion decisions over the flagged lots with a unit kept or on the way, by ref and fingerprint whatever the pack', () => {
    const flagged = (id: string, line: Partial<OnlineLineSpec> = {}, order: Partial<OnlineOrderSpec> = {}) => onlineOrder({
      id, date: '2030-03-01', ...order,
      lines: [{ id: '1', title: KEEPSAKE, itemNumber: '10031', quantity: 1, unitPrice: 180000, ...ONE_SHIPMENT, metalUncertain: GOLD_FLAG, ...line }],
    });
    const result = convert({
      receipts: [
        goldOrder('q1', {}, { pack: 'single' }),
        flagged('q2'),
        flagged('q3'),
        flagged('q4', { itemNumber: null }),
        flagged('q5', { itemNumber: '10032', amount: 0, shipments: [], events: { cancelled: [[1, '2030-03-02']] } }, { status: 'cancelled' }),
      ],
    }, census([1, 1, 0], [4, 4, 0]));
    assert.deepEqual(result.payload.held, []);
    const { bullion, confirmations } = result.report;
    assert.deepEqual(bullion, {
      needed: 2, productScoped: 1, lotScoped: 1, includingFullyCancelledOrReturned: { needed: 3, productScoped: 2, lotScoped: 1 },
    });
    assert.deepEqual(confirmations, {
      needed: 1, neededIncludingFullyCancelledOrReturned: 1, productRefs: 1, productScoped: 1, lotScoped: 0, metalUnknown: 0,
      notCancelledOrReturned: { productScoped: 1, lotScoped: 0, metalUnknown: 0 },
    });
  });
});

describe('Costco adapter: input', () => {
  it('names its input by the SHA-256 of the bytes it read, and its account by the membership', () => {
    const retail = retailPayload({ format: 3, folder: 'costco-2', membershipLast4: null, receipts: [goldOrder('i')] });
    const result = convertRetail(retail, census([1, 1, 0]));
    assert.deepEqual(result.payload.account, { folder: 'costco-2', identityLast4: null });
    assert.deepEqual(result.payload.input, { retailPayloadSha256: metalsDigest(retailBytes(retail)), retailFormat: 3, retailPolicyVersion: 5 });
    assert.deepEqual(result.payload.rules, METALS_RULES);
    assert.deepEqual(result.payload.coverage, [
      { kind: 'online', from: '2030-01-01', to: '2030-12-31', stated: 4, seen: 4, complete: true },
      { kind: 'warehouse', from: '2030-01-01', to: '2030-12-31', stated: null, seen: 2, complete: false },
    ]);
    assert.equal(convert({ receipts: [goldOrder('i')] }, census([1, 1, 0])).payload.account.identityLast4, SYNTHETIC_MEMBERSHIP);
  });

  it('refuses any other format or policy, before reading anything else', () => {
    const base = retailPayload({ format: 3, receipts: [goldOrder('v')] });
    for (const [version, policyVersion] of [[1, 3], [2, 4], [1, 5], [2, 5], [3, 3], [3, 4], [3, 6], [4, 5], ['3', 5]]) {
      const refusal = refusalOf(() => convertCostcoRetailPayload({ bytes: retailBytes({ ...base, version, policyVersion }), converterVersion: METALS_CONVERTER }));
      assert.deepEqual(refusal, { code: 'retail-policy-unsupported', at: '$.policyVersion' });
    }
  });

  it('refuses bytes that are not a Costco retail payload its validator accepts', () => {
    const bytes = retailBytes(retailPayload({ format: 3, receipts: [goldOrder('u')] }));
    const run = (input: Uint8Array) => () => convertCostcoRetailPayload({ bytes: input, converterVersion: METALS_CONVERTER });
    assert.equal(refusalOf(run(new Uint8Array([0xff, 0xfe, 0x7b])))?.code, 'retail-unreadable');
    assert.equal(refusalOf(run(new TextEncoder().encode('not json')))?.code, 'retail-unreadable');
    assert.equal(refusalOf(run(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes])))?.code, 'retail-unreadable');
    assert.deepEqual(refusalOf(run(new TextEncoder().encode('[]'))), { code: 'retail-invalid', at: '$.format' });
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as Rec;
    assert.deepEqual(refusalOf(run(retailBytes({ ...payload, format: 'holdr.other-import' }))), { code: 'retail-invalid', at: '$.format' });
    assert.deepEqual(refusalOf(run(retailBytes({ ...payload, merchant: 'sample' }))), { code: 'retail-invalid', at: '$.merchant' });
    const broken = JSON.parse(new TextDecoder().decode(bytes)) as { receipts: Array<{ totals: { taxMinor: number } }> };
    broken.receipts[0].totals.taxMinor += 1;
    assert.deepEqual(refusalOf(run(retailBytes(broken as unknown as Rec))), { code: 'retail-invalid', at: '$.receipts[0].totals' });
    assert.equal(refusalOf(() => convertCostcoRetailPayload({ bytes, converterVersion: 'holdr-metals-convert 1.0' }))?.code, 'converter-version');
  });

  it('refuses metal evidence of another title rule, and a flag of another guard', () => {
    const order = goldOrder('tr');
    ((order.lines as Rec[])[0].metal as Rec).rule = 'title-rule-v1';
    const ruleRefusal = refusalOf(() => adapterOnly(retailPayload({ format: 3, receipts: [order] })));
    assert.deepEqual(ruleRefusal, { code: 'retail-policy-unsupported', at: '$.receipts[0].lines[0].metal.rule' });
    const flagged = onlineOrder({
      id: 'tg', date: '2030-03-01', lines: [{ id: '1', title: KEEPSAKE, quantity: 1, unitPrice: 180000, ...ONE_SHIPMENT, metalUncertain: { ...GOLD_FLAG, guard: 'metal-guard-v0' } }],
    });
    const guardRefusal = refusalOf(() => adapterOnly(retailPayload({ format: 3, receipts: [flagged] })));
    assert.deepEqual(guardRefusal, { code: 'retail-policy-unsupported', at: '$.receipts[0].lines[0].metalUncertain.guard' });
  });
});

describe('Costco adapter: stored titles (metal-guard)', () => {
  /** A raw name the title rule reads as XAU, one bar: its first 240 characters, the stored cut, end just before ` 1 oz`. */
  const LONG_RAW = `Sample Refinery Gold Bar${' Gift Edition'.repeat(16)} Display 1 oz`;
  /** The same words with ` 1 oz` right after `Bar`, so that the stored cut keeps the weight. */
  const LONG_KEPT_RAW = `Sample Refinery Gold Bar 1 oz${' Gift Edition'.repeat(16)} Display`;
  const cut = (raw: string) => raw.slice(0, 240);
  /** A second printed line that joins past the stored-text limit, so that the warehouse title falls back to the first. */
  const LONG_SECOND = `1 OZ${' X'.repeat(118)}`;
  const GOLD_BAR_OZ = metalOf('GOLD BAR 1 OZ');

  it("withholds an unflagged lot's stored title the title guard reads as metal-uncertain, last, and keeps the lot", () => {
    let result: MetalsCostcoConvertResult | undefined;
    // Once 1E's validator refuses such a title, a missing withholding is refused converter-invalid, and fails here.
    assert.equal(refusalOf(() => {
      result = convert({
        receipts: [
          onlineOrder({ id: 'mg1', date: '2030-03-01', lines: [{ id: '1', title: cut(LONG_RAW), quantity: 1, unitPrice: 900, ...ONE_SHIPMENT, metal: metalOf(LONG_RAW) }] }),
          onlineOrder({ id: 'mg2', date: '2030-03-01', lines: [{ id: '1', title: cut(LONG_KEPT_RAW), quantity: 1, unitPrice: 900, ...ONE_SHIPMENT, metal: metalOf(LONG_KEPT_RAW) }] }),
          warehouseReceipt({ id: 'mg3', date: '2030-07-01', lines: [{ title: 'GOLD BAR', title2: null, amount: 800, metal: GOLD_BAR_OZ }], tenders: [{ kind: 'card', amount: 800 }] }),
          warehouseReceipt({ id: 'mg4', date: '2030-07-02', lines: [{ title: 'GOLD BAR', title2: LONG_SECOND, amount: 800, metal: GOLD_BAR_OZ }], tenders: [{ kind: 'card', amount: 800 }] }),
          warehouseReceipt({ id: 'mg5', date: '2030-07-03', lines: [{ title: 'GOLD BAR', title2: '1 OZ', amount: 800 }], tenders: [{ kind: 'card', amount: 800 }] }),
          onlineOrder({ id: 'mg6', date: '2030-03-01', lines: [{ id: '1', title: KEEPSAKE, quantity: 1, unitPrice: 900, ...ONE_SHIPMENT, metalUncertain: GOLD_FLAG }] }),
        ],
      }, census([5, 5, 0], [1, 1, 0]));
    }), null, 'converted, not refused');
    const titles = [orderKey('mg1'), orderKey('mg2'), receiptKey('mg3'), receiptKey('mg4'), receiptKey('mg5'), orderKey('mg6')]
      .map((key) => orderOf(result!, key).lines[0].title);
    // Withheld: the online cut, a null second line, the warehouse fallback. Kept: the cut with its weight, the joined
    // warehouse lines, and a flagged line (the guard's own flag is its record).
    assert.deepEqual(titles, [null, cut(LONG_KEPT_RAW), null, null, 'GOLD BAR 1 OZ', KEEPSAKE]);
    assert.deepEqual(result!.report.lots.titlesWithheldBy, { 'metal-guard': 3 });
    const lot = orderOf(result!, receiptKey('mg3')).lines[0];
    assert.deepEqual([lot.metal, lot.form, lot.pack, lot.statedMass !== null], ['XAU', 'bar', 'single', true], 'the lot keeps what was read on its raw title');
  });
});

describe('Costco adapter: payload and report', () => {
  it('converts the retail converter’s own payload of a synthetic capture: one gold order, every other carded record a competitor', () => {
    const capture = syntheticCostcoCapture(syntheticMembershipSpec());
    const converted = convertCostcoCapture({
      folder: 'costco-2',
      consolidated: capture.consolidated,
      consolidatedDigest: 'e'.repeat(64),
      rawReceipts: capture.rawReceipts.map((file) => file.json),
      rawDetails: capture.rawDetails.map((file) => file.json),
      files: 1 + capture.rawReceipts.length + capture.rawDetails.length,
    });
    assert.equal(converted.payload.held.length, 0);
    const retail = JSON.parse(converted.json) as Rec;
    assert.deepEqual([retail.version, retail.policyVersion], [3, 5]);
    const result = convertRetail(retail, census([1, 1, 0]));
    assert.deepEqual(result.payload.account, { folder: 'costco-2', identityLast4: '0042' });
    assert.equal(result.payload.orders.length, 1);
    const [order] = result.payload.orders;
    assert.equal(order.key, retailNaturalKey('costco', 'order', syntheticOrderNumber(2)));
    assert.deepEqual(order.admission?.fulfilment, { shipments: 1 });
    assert.deepEqual(order.admission?.methods, [{ kind: 'card', network: 'mastercard', last4: CAPTURE_CARD_2, amountMinor: 500000 }]);
    assert.deepEqual(order.evidence, [{ class: COSTCO_TENDER, tender: 0, amountMinor: 500000 }]);
    const [lot] = order.lines;
    assert.deepEqual([lot.metal, lot.form, lot.statedMass, lot.quantity, lot.unitPriceMinor], ['XAU', 'bar', { value: '1', unit: 'oz' }, 2, 250000]);
    assert.deepEqual(lot.events, [{ kind: 'shipped', date: '2025-06-12', dateBasis: 'stated', quantity: 2, occurrence: 1 }]);
    assert.deepEqual(lot.fine, metalsFineContentWire(metalsFineContent(contentOf(lot))));
    assert.deepEqual(result.payload.competitors.map((competitor) => [competitor.channel, competitor.date, competitor.basis]), [
      ['warehouse', '2025-03-01', 'single-charge'], ['warehouse', '2025-03-04', 'single-charge'],
      ['warehouse', '2025-04-11', 'single-charge'], ['online', '2025-05-02', 'single-charge'],
    ]);
    assert.deepEqual(result.report.records, { orders: 1, competitors: 4, held: 0, credits: 1, noCardFunding: 1 });
    assert.equal(result.report.competitors.fromGas, 1);
    const text = JSON.stringify(result.report);
    for (const value of syntheticSensitiveValues()) assert.equal(text.includes(value), false, value);
  });
  it('reports counts, codes and dates only, and every record once', () => {
    const result = convert({
      receipts: [
        goldOrder('r1', {}, { pack: 'single' }),
        goldOrder('r2', {}, { pack: 'single' }),
        onlineOrder({ id: 'r3', date: '2030-03-04', lines: [{ id: '1', title: GOLD_PACK, itemNumber: '10002', quantity: 1, unitPrice: 1250000, pack: 'multiple' }] }),
        onlineOrder({ id: 'r4', date: '2030-03-05', lines: [{ id: '1', title: TWO_METALS, itemNumber: '10004', quantity: 1, unitPrice: 260000, pack: 'single' }] }),
        goldOrder('r5', {}, { itemNumber: null, pack: 'single' }),
        warehouseReceipt({ id: 'w1', date: '2030-06-01', lines: [{ title: 'SAMPLE GOLD BAR', title2: '1 OZT', amount: 250000, pack: 'single' }],
          tenders: [{ kind: 'card', amount: 200000 }, { kind: 'card', amount: 50000, last4: SYNTHETIC_CARD_2 }] }),
        warehouseReceipt({ id: 'w2', date: '2030-06-03', lines: [{ title: 'SAMPLE GOLD BAR', title2: '1 OZT', quantity: -1, unitPrice: 250000, amount: -250000 }],
          tenders: [{ kind: 'card-refund', amount: -250000 }] }),
        warehouseReceipt({ id: 'g1', date: '2030-07-01', gas: true, lines: [{ title: 'SAMPLE UNLEADED', kind: 'fuel', quantity: null, amount: 4500, taxFlag: null }],
          tenders: [{ kind: 'card', amount: 4500 }] }),
        warehouseReceipt({ id: 'c1', date: '2030-07-03', lines: [{ title: PAPER, amount: 1999 }], tenders: [{ kind: 'cash', amount: 1999 }] }),
        onlineOrder({ id: 'p1', date: '2030-04-01', lines: [{ id: '1', title: PAPER, quantity: 1, unitPrice: 1999, shipments: [{}] }] }),
      ],
      held: [
        { channel: 'online', key: orderKey('x1'), reason: 'identity-failed', check: 'order-total', date: '2030-05-01' },
        { channel: 'warehouse', key: null, reason: 'unreadable', check: 'record-key' },
      ],
    }, census([7, 6, 1]));
    const { report } = result;
    assert.deepEqual(report.retail, { format: 3, policyVersion: 5, records: 10, held: 2 });
    assert.deepEqual(report.records, { orders: 6, competitors: 2, held: 1, credits: 0, noCardFunding: 1 });
    assert.deepEqual(report.orders, { online: 5, warehouse: 1 });
    assert.equal(report.lots.online, 5);
    assert.equal(report.lots.warehouse, 1);
    assert.deepEqual(report.lots.byPack, { single: 5, multiple: 1, unknown: 0 });
    assert.equal(report.lots.byMetal.XAU, 5);
    assert.equal(report.lots.byMetal.none, 1);
    assert.equal(report.lots.byContentHold['metal-unknown'], 1);
    assert.equal(report.lots.byContentHold['pack-count'], 1);
    assert.deepEqual(report.confirmations, {
      needed: 4, neededIncludingFullyCancelledOrReturned: 4, productRefs: 4, productScoped: 2, lotScoped: 2, metalUnknown: 1,
      notCancelledOrReturned: { productScoped: 2, lotScoped: 2, metalUnknown: 1 },
    });
    assert.deepEqual(report.evidence, { online: 3, warehouse: 2 });
    assert.deepEqual(report.competitors, { online: 1, warehouse: 1, fromGas: 1, singleCharge: 2, aggregate: 0 });
    assert.equal(report.held.retail, 2);
    assert.equal(report.held.adapter, 1);
    assert.equal(report.held.byReason['retail-held'], 2);
    assert.equal(report.held.byReason['return-unlinked'], 1);
    assert.deepEqual(report.held.byCheck, { 'order-total': 1, 'record-key': 1, 'refund-receipt-metal': 1 });
    assert.deepEqual(report.dates, { first: '2030-03-01', last: '2030-07-03' });
    const text = JSON.stringify(report);
    for (const value of ['250000', '1250000', SYNTHETIC_CARD, SYNTHETIC_CARD_2, SYNTHETIC_MEMBERSHIP, 'SAMPLE', 'costco-order-', 'costco-receipt-', 'costco-line-', 'costco:']) {
      assert.equal(text.includes(value), false, value);
    }
  });

  it('answers Q1 over the lots with a unit kept or on the way, with every lot counted beside it', () => {
    const result = convert({
      receipts: [
        goldOrder('k1', {}, { pack: 'single' }),
        goldOrder('k2', { status: 'cancelled' }, { itemNumber: '10006', pack: 'single', amount: 0, shipments: [], events: { cancelled: [[1, '2030-03-02']] } }),
        goldOrder('k3', { status: 'returned' }, {
          itemNumber: '10007', pack: 'unknown', events: { shipped: [[1, '2030-03-03']], delivered: [[1, '2030-03-05']], returned: [[1, '2030-03-09']] },
        }),
        goldOrder('k4', {}, {
          itemNumber: '10008', pack: 'unknown', quantity: 2, unitPrice: 125000,
          events: { shipped: [[2, '2030-03-03']], delivered: [[2, '2030-03-05']], returned: [[1, '2030-03-09']] },
        }),
      ],
    }, census([4, 4, 0]));
    assert.deepEqual(result.payload.held, []);
    assert.equal(result.payload.orders.length, 4);
    assert.deepEqual(result.report.confirmations, {
      needed: 2, neededIncludingFullyCancelledOrReturned: 4, productRefs: 4, productScoped: 2, lotScoped: 2, metalUnknown: 0,
      notCancelledOrReturned: { productScoped: 1, lotScoped: 1, metalUnknown: 0 },
    });
  });

  it('writes the same payload whatever the order of the retail records', () => {
    const receipts = [
      goldOrder('z1'),
      onlineOrder({ id: 'z2', date: '2030-03-01', lines: [{ id: '1', title: PAPER, quantity: 1, unitPrice: 1999, shipments: [{}] }] }),
      warehouseReceipt({ id: 'z3', date: '2030-03-01', lines: [{ title: 'SAMPLE GOLD BAR', title2: '1 OZT', amount: 250000 }], tenders: [{ kind: 'card', amount: 250000 }] }),
    ];
    const json = (records: Rec[]) => checked(adapterOnly(retailPayload({ format: 3, receipts: records })), census([2, 2, 0])).json;
    assert.equal(json(receipts), json([...receipts].reverse()));
  });

  it('is the CLI registry entry for --source costco, and names only its own hold checks', () => {
    assert.equal(METALS_COSTCO_CONVERTER.input, 'retail-payload');
    assert.equal(METALS_COSTCO_CONVERTER.source, 'costco');
    assert.equal(METALS_COSTCO_CONVERTER.convert, convertCostcoRetailPayload);
    for (const check of Object.keys(METALS_COSTCO_HOLD_CHECKS)) assert.match(check, /^[a-z][a-z0-9-]{0,47}$/);
  });
});
