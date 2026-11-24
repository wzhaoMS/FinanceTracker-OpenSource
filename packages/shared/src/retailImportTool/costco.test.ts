import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  syntheticBarcode,
  syntheticCostcoCapture,
  syntheticMembershipSpec,
  syntheticOrderNumber,
  syntheticSensitiveValues,
  SYNTHETIC_CARD,
  SYNTHETIC_CARD_2,
  SYNTHETIC_CERTIFICATE,
  SYNTHETIC_FIRST_NAME,
  SYNTHETIC_PLACE,
  type SyntheticCapture,
  type SyntheticCaptureSpec,
  type SyntheticOnlineLine,
  type SyntheticOrder,
  type SyntheticPayment,
  type SyntheticTender,
} from './__fixtures__/costcoCapture.js';
import { convertCostcoCapture, COSTCO_SHOP_CARD_PURCHASES, RetailConvertError, type CostcoConvertResult } from './costco.js';
import { RETAIL_METAL_TITLE_RULE, retailMetalTitleGuard } from './metalTitleRule.js';
import {
  RETAIL_CONVERT_POLICY_VERSION,
  RETAIL_HOLD_CHECK_NAMES,
  retailDigest,
  retailNaturalKey,
  validateRetailImportPayload,
  type RetailImportReceipt,
} from './payload.js';

const DIGEST = retailDigest(new TextEncoder().encode('synthetic consolidated file'));

function convert(capture: SyntheticCapture, folder = 'costco-2'): CostcoConvertResult {
  return convertCostcoCapture({
    folder,
    consolidated: capture.consolidated,
    consolidatedDigest: DIGEST,
    rawReceipts: capture.rawReceipts.map((file) => file.json),
    rawDetails: capture.rawDetails.map((file) => file.json),
    files: 1 + capture.rawReceipts.length + capture.rawDetails.length,
  });
}

const convertSpec = (spec: SyntheticCaptureSpec, folder?: string) => convert(syntheticCostcoCapture(spec), folder ?? spec.folder ?? 'costco');

function receiptOf(result: CostcoConvertResult, kind: 'receipt' | 'order', seed: number): RetailImportReceipt {
  const key = retailNaturalKey('costco', kind, kind === 'receipt' ? syntheticBarcode(seed) : syntheticOrderNumber(seed));
  const receipt = result.payload.receipts.find((entry) => entry.naturalKey === key);
  assert.ok(receipt, `${kind} ${seed} was kept`);
  return receipt;
}

/** A held record's reason and the check that held it. */
function heldBy(result: CostcoConvertResult, kind: 'receipt' | 'order', seed: number): { reason: string; check: string } | undefined {
  const key = retailNaturalKey('costco', kind, kind === 'receipt' ? syntheticBarcode(seed) : syntheticOrderNumber(seed));
  const entry = result.payload.held.find((held) => held.naturalKey === key);
  return entry && { reason: entry.reason, check: entry.check };
}

type RawOrderLine = Record<string, unknown>;
/** The raw details' and the consolidated file's view of one online line, to change for a test. */
function onlineLine(capture: SyntheticCapture, order: number, line: number): { raw: RawOrderLine; listed: RawOrderLine } {
  const details = capture.rawDetails[order].json as { response: { data: { getOrderDetails: { shipToAddress: Array<{ orderLineItems: RawOrderLine[] }> } } } };
  const listed = (capture.consolidated.onlineOrders as Array<{ lines: RawOrderLine[] }>)[order].lines[line];
  return { raw: details.response.data.getOrderDetails.shipToAddress[0].orderLineItems[line], listed };
}

/** The base spec with one receipt or order changed. */
function variant(change: (spec: SyntheticCaptureSpec) => void): SyntheticCaptureSpec {
  const spec = syntheticMembershipSpec();
  change(spec);
  return spec;
}

describe('Costco captures to holdr.retail-import payloads', () => {
  it('converts one of everything and the payload validates', () => {
    const result = convertSpec(syntheticMembershipSpec());
    assert.equal(validateRetailImportPayload(JSON.parse(result.json)).ok, true);
    assert.deepEqual(result.report.receipts.byChannel, { warehouse: 3, gas: 1, online: 3 });
    assert.deepEqual(result.report.receipts.bySign, { sale: 6, refund: 1 });
    assert.equal(result.report.receipts.held, 0);
    assert.equal(result.payload.held.length, 0);
    assert.equal(result.payload.policyVersion, RETAIL_CONVERT_POLICY_VERSION);
    assert.match(result.payload.converterVersion, /^holdr-retail-convert \d+\.\d+\.\d+$/);
    assert.deepEqual(result.payload.membership, { folder: 'costco-2', memberSinceYear: '2001', tier: 'Gold Star', membershipLast4: '0042' });

    const groceries = receiptOf(result, 'receipt', 1);
    assert.equal(groceries.channel, 'warehouse');
    assert.equal(groceries.localTime, '10:15:00');
    assert.deepEqual(groceries.lines.map((line) => line.kind), ['item', 'item', 'coupon']);
    assert.equal(groceries.lines[2].couponTarget, 1);
    assert.equal(groceries.lines[2].title, null);
    assert.equal(groceries.lines[0].title, 'KS ORGANIC EGGS');
    assert.equal(groceries.lines[0].title2, '24 CT');
    assert.equal(groceries.lines[0].department, 17);
    assert.deepEqual(groceries.tenders, [{ ordinal: 0, kind: 'card', network: 'visa', last4: SYNTHETIC_CARD, amountMinor: 2948 }]);
    assert.deepEqual(groceries.totals, {
      subtotalMinor: 2798, taxMinor: 150, instantSavingsMinor: 400, discountMinor: null, shippingMinor: null, feesMinor: null, storedValueMinor: null, totalMinor: 2948,
    });
    assert.deepEqual(groceries.taxLegends, [{ legend: 'A', amountMinor: 150 }]);

    const gas = receiptOf(result, 'receipt', 2);
    assert.equal(gas.channel, 'gas');
    assert.equal(gas.lines[0].kind, 'fuel');
    assert.equal(gas.lines[0].fuelGallons, '12.345');
    assert.equal(gas.lines[0].fuelUnitPrice, '3.499', 'the price per gallon as stated, tenths of a cent kept');
    assert.equal(gas.lines[0].unitPriceMinor, null, 'never rounded into cents');
    assert.equal(gas.tenders[0].kind, 'card');

    const refund = receiptOf(result, 'receipt', 3);
    assert.equal(refund.sign, 'refund');
    assert.deepEqual(refund.tenders, [{ ordinal: 0, kind: 'card-refund', network: 'unknown', last4: SYNTHETIC_CARD, amountMinor: -2419 }]);

    const split = receiptOf(result, 'receipt', 4);
    assert.deepEqual(split.tenders.map((tender) => [tender.kind, tender.last4]), [['reward-certificate', null], ['card', SYNTHETIC_CARD_2]]);
    assert.ok(!result.json.includes(SYNTHETIC_CERTIFICATE), 'a certificate ending is never kept');

    const tires = receiptOf(result, 'order', 1);
    assert.equal(tires.status, 'delivered');
    assert.deepEqual(tires.lines.map((line) => [line.kind, line.feeParent]), [['item', null], ['fee', 0]]);
    assert.equal(tires.lines[0].fulfilment, 'parcel');
    assert.deepEqual(tires.lines[0].events?.shipped, [{ quantity: 4, date: '2025-05-04' }]);
    assert.deepEqual(tires.lines[0].shipments, [{ shippedDate: '2025-05-04', deliveredDate: '2025-05-07', estimatedArrivalDate: null, carrier: 'ups' }]);
    assert.deepEqual(tires.tenders.map((tender) => [tender.kind, tender.last4, tender.amountMinor]),
      [['card', SYNTHETIC_CARD, 60092], ['coupon', null, 5000]]);
    assert.equal(tires.totals.discountMinor, 5000);

    const gold = receiptOf(result, 'order', 2);
    assert.deepEqual(gold.lines[0].metal, { metal: 'XAU', form: 'bar', statedWeight: { value: '1', unit: 'oz' }, rule: 'title-rule-v3', pack: 'single' });
    assert.deepEqual(gold.lines[0].shipments, [{ shippedDate: '2025-06-12', deliveredDate: null, estimatedArrivalDate: '2025-06-15', carrier: 'fedex' }]);
    assert.equal(gold.tenders[0].network, 'mastercard');

    const cancelled = receiptOf(result, 'order', 3);
    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual(cancelled.tenders, [], 'a payment row of an order that charged nothing proves no charge');
    assert.deepEqual(cancelled.lines[0].events?.cancelled, [{ quantity: 1, date: '2025-07-02' }]);
  });

  it('keeps no native number, name or place, only one-way keys', () => {
    const result = convertSpec(syntheticMembershipSpec());
    for (const value of [syntheticBarcode(1), syntheticOrderNumber(1), 'SAMPLETOWN', 'SMPLTWN', 'TESTNAME', '"ZZ"']) {
      assert.ok(!result.json.includes(value), `payload shows ${value}`);
    }
    for (const receipt of result.payload.receipts) assert.match(receipt.naturalKey, /^costco-(receipt|order)-[a-p]{64}$/);
  });

  it('reports counts, codes and dates only', () => {
    const result = convertSpec(syntheticMembershipSpec());
    const text = JSON.stringify(result.report);
    for (const value of syntheticSensitiveValues()) assert.ok(!text.includes(value), `report shows ${value}`);
    assert.doesNotMatch(text, /[a-p]{64}/, 'no natural key, line key or capture digest');
    assert.equal(result.report.metal.lines, 1);
    assert.equal(result.report.metal.byForm.bar, 1);
    assert.deepEqual(result.report.metal.byPack, { single: 1, multiple: 0, unknown: 0 });
    assert.equal(result.report.metal.byPackReason.none, 1, 'a single pack, for no reason to doubt it');
    assert.deepEqual(result.report.coupons, { resolved: 1, unresolved: 0 });
    assert.deepEqual(result.report.dates, { first: '2025-03-01', last: '2025-07-01' });
    assert.deepEqual(result.report.coverage.online, [{ from: '2025-01-01', to: '2025-12-31', complete: true }]);
    assert.deepEqual(Object.keys(result.report.receipts.heldByCheck), RETAIL_HOLD_CHECK_NAMES, 'every check is listed by name');
    assert.ok(Object.values(result.report.receipts.heldByCheck).every((count) => count === 0));
  });

  it('is byte-identical whatever order the files and records come in', () => {
    const capture = syntheticCostcoCapture(syntheticMembershipSpec());
    const first = convert(capture).json;
    const shuffled: SyntheticCapture = {
      consolidated: {
        ...capture.consolidated,
        warehouseReceipts: [...(capture.consolidated.warehouseReceipts as unknown[])].reverse(),
        onlineOrders: [...(capture.consolidated.onlineOrders as unknown[])].reverse(),
      },
      rawReceipts: [...capture.rawReceipts].reverse(),
      rawDetails: [...capture.rawDetails].reverse(),
    };
    assert.equal(convert(shuffled).json, first);
  });

  it('holds a receipt without its raw receipt, and one the two files disagree on', () => {
    const missing = convertSpec(variant((spec) => { spec.receipts![0].noRaw = true; }));
    assert.deepEqual(heldBy(missing, 'receipt', 1), { reason: 'raw-missing', check: 'raw-missing' });
    assert.equal(missing.report.receipts.heldByReason['raw-missing'], 1);
    assert.equal(missing.report.receipts.heldByCheck['raw-missing'], 1);
    const disagree = convertSpec(variant((spec) => { spec.receipts![0].rawOverrides = { taxes: 1.51, total: 29.49 }; }));
    assert.deepEqual(heldBy(disagree, 'receipt', 1), { reason: 'capture-disagreement', check: 'record-totals' });
  });

  it('holds a receipt whose money does not add up', () => {
    const capture = syntheticCostcoCapture(syntheticMembershipSpec());
    const listed = (capture.consolidated.warehouseReceipts as Array<Record<string, unknown>>)[0];
    listed.subTotal = { cents: 2799, currency: 'USD', raw: 27.99 };
    const raw = capture.rawReceipts[0].json as { response: { data: { receiptsWithCounts: { receipts: Array<Record<string, unknown>> } } } };
    raw.response.data.receiptsWithCounts.receipts[0].subTotal = 27.99;
    assert.deepEqual(heldBy(convert(capture), 'receipt', 1), { reason: 'identity-failed', check: 'lines-subtotal' });
  });

  it('names each money identity that fails, the two files agreeing', () => {
    const totalOff = syntheticCostcoCapture(variant((spec) => { spec.receipts![0].rawOverrides = { total: 29.49 }; }));
    (totalOff.consolidated.warehouseReceipts as Array<Record<string, unknown>>)[0].total = { cents: 2949, currency: 'USD', raw: 29.49 };
    assert.deepEqual(heldBy(convert(totalOff), 'receipt', 1), { reason: 'identity-failed', check: 'subtotal-tax-total' });

    const tendersOff = convertSpec(variant((spec) => { spec.receipts![0].tenders[0].amount -= 1; }));
    assert.deepEqual(heldBy(tendersOff, 'receipt', 1), { reason: 'identity-failed', check: 'tenders-total' });

    const orderOff = convertSpec(variant((spec) => {
      spec.orders![1].total = 500001;
      spec.orders![1].payments[0].charged = 500001;
    }));
    assert.deepEqual(heldBy(orderOff, 'order', 2), { reason: 'identity-failed', check: 'order-total' });

    // The order's merchandise (or shipping) and total move together in both files, its lines don't.
    for (const [field, consolidatedField, check] of [
      ['merchandiseTotal', 'merchandiseTotal', 'lines-merchandise'],
      ['shippingAndHandling', 'shippingAndHandling', 'lines-shipping'],
    ] as const) {
      const capture = syntheticCostcoCapture(syntheticMembershipSpec());
      const details = (capture.rawDetails[1].json as { response: { data: { getOrderDetails: Record<string, number> } } }).response.data.getOrderDetails;
      const listed = (capture.consolidated.onlineOrders as Array<Record<string, { cents: number; currency: string; raw: number }>>)[1];
      details[field] = Math.round(details[field] * 100 + 1) / 100;
      details.orderTotal = Math.round(details.orderTotal * 100 + 1) / 100;
      listed[consolidatedField] = { cents: listed[consolidatedField].cents + 1, currency: 'USD', raw: details[field] };
      listed.total = { cents: listed.total.cents + 1, currency: 'USD', raw: details.orderTotal };
      assert.deepEqual(heldBy(convert(capture), 'order', 2), { reason: 'identity-failed', check });
    }
  });

  it('keeps no last four on a tender that is not a card, whatever the receipt shows', () => {
    const result = convertSpec(variant((spec) => {
      spec.receipts![3].tenders = [
        { name: 'Debit Card', last4: SYNTHETIC_CARD_2, amount: 300 },
        { name: 'Cash', amount: 100 },
        { name: 'Shop Card', last4: SYNTHETIC_CERTIFICATE, amount: 498 },
      ];
    }));
    assert.deepEqual(receiptOf(result, 'receipt', 4).tenders.map((tender) => [tender.kind, tender.network, tender.last4]),
      [['debit', 'unknown', null], ['cash', 'unknown', null], ['shop-card', 'unknown', null]]);
    assert.deepEqual(result.report.tenders.byKind, {
      card: 4, 'card-refund': 1, debit: 1, cash: 1, 'shop-card': 1, 'reward-certificate': 0, coupon: 1,
    });
  });

  it('holds an online order with a line that is not its quantity × unit price, unless the order charged nothing', () => {
    const result = convertSpec(variant((spec) => {
      spec.orders![1].lines[0].merch = 499999;
      spec.orders![1].payments[0].charged = 499999;
    }));
    assert.deepEqual(heldBy(result, 'order', 2), { reason: 'identity-failed', check: 'line-quantity-price' });
    const cancelled = receiptOf(convertSpec(syntheticMembershipSpec()), 'order', 3);
    assert.equal(cancelled.lines[0].amountMinor, 0, 'a cancelled order\'s line keeps its zero, and is not held');
  });

  it('holds an online line whose stated returned quantity is not its return events', () => {
    const returned = variant((spec) => {
      spec.orders![0].status = 'Returned';
      spec.orders![0].lines[0].returned = [{ qty: 1, date: '2025-05-20' }];
    });
    const kept = receiptOf(convertSpec(returned), 'order', 1);
    assert.deepEqual(kept.lines[0].events?.returned, [{ quantity: 1, date: '2025-05-20' }]);

    const rawOnly = syntheticCostcoCapture(syntheticMembershipSpec());
    onlineLine(rawOnly, 0, 0).raw.totalReturnedQuantity = '1';
    assert.deepEqual(heldBy(convert(rawOnly), 'order', 1), { reason: 'capture-disagreement', check: 'returned-quantity' });
    const listedOnly = syntheticCostcoCapture(syntheticMembershipSpec());
    onlineLine(listedOnly, 0, 0).listed.totalReturnedQuantity = '2';
    assert.deepEqual(heldBy(convert(listedOnly), 'order', 1), { reason: 'capture-disagreement', check: 'returned-quantity' });
    const malformed = syntheticCostcoCapture(syntheticMembershipSpec());
    onlineLine(malformed, 0, 0).raw.totalReturnedQuantity = 'one';
    assert.deepEqual(heldBy(convert(malformed), 'order', 1), { reason: 'unreadable', check: 'record-shape' });
  });

  it('holds unknown tenders and card tenders without an ending, never guessing', () => {
    const unknown = convertSpec(variant((spec) => { spec.receipts![0].tenders[0].name = 'SAMPLE WALLET'; }));
    assert.deepEqual(heldBy(unknown, 'receipt', 1), { reason: 'tender-unknown', check: 'tender-name' });
    const noEnding = convertSpec(variant((spec) => { spec.receipts![0].tenders[0].last4 = null; }));
    assert.deepEqual(heldBy(noEnding, 'receipt', 1), { reason: 'tender-unproven', check: 'tender-last4' });
    const pumpWithoutCode = convertSpec(variant((spec) => { spec.receipts![1].tenders[0].code = '061'; }));
    assert.deepEqual(heldBy(pumpWithoutCode, 'receipt', 2), { reason: 'tender-unknown', check: 'tender-name' });
  });

  it('holds an online order whose card payment is not its total, or that a gift of membership or a physical Shop Card paid', () => {
    const mismatch = convertSpec(variant((spec) => { spec.orders![1].payments[0].charged = 499999; }));
    assert.deepEqual(heldBy(mismatch, 'order', 2), { reason: 'payment-mismatch', check: 'card-payment' });
    const gift = convertSpec(variant((spec) => { spec.orders![1].payments[0].gom = true; }));
    assert.deepEqual(heldBy(gift, 'order', 2), { reason: 'tender-unknown', check: 'gift-of-membership-payment' });
    const shopCard = convertSpec(variant((spec) => { spec.orders![1].shopCardApplied = 100; }));
    assert.deepEqual(heldBy(shopCard, 'order', 2), { reason: 'tender-unproven', check: 'shop-card-physical' });
    const coupons = convertSpec(variant((spec) => { spec.orders![0].payments[1].charged = 4999; }));
    assert.deepEqual(heldBy(coupons, 'order', 1), { reason: 'payment-mismatch', check: 'coupons-discount' });
  });

  it('holds a fee line without its parent, and an unknown receipt type', () => {
    const orphan = convertSpec(variant((spec) => { spec.orders![0].lines[1].feeParent = 9; }));
    assert.deepEqual(heldBy(orphan, 'order', 1), { reason: 'fee-parent-missing', check: 'fee-parent' });
    const carWash = convertSpec(variant((spec) => {
      spec.receipts![0].receiptType = 'Car Wash';
      spec.receipts![0].documentType = 'CarWashReceipts';
    }));
    assert.deepEqual(heldBy(carWash, 'receipt', 1), { reason: 'receipt-type-unknown', check: 'receipt-type' });
  });

  it('holds a zero total and a receipt from outside the US', () => {
    const zero = convertSpec(variant((spec) => {
      spec.receipts![0].items = [{ number: '100009', title: 'FREE SAMPLE', amount: 0 }];
      spec.receipts![0].taxes = 0;
      spec.receipts![0].instantSavings = 0;
      spec.receipts![0].tenders = [{ name: 'VISA', last4: SYNTHETIC_CARD, amount: 0 }];
    }));
    assert.deepEqual(heldBy(zero, 'receipt', 1), { reason: 'zero-total', check: 'zero-total' });
    const abroad = convertSpec(variant((spec) => { spec.receipts![0].country = 'CA'; }));
    assert.deepEqual(heldBy(abroad, 'receipt', 1), { reason: 'currency-unsupported', check: 'warehouse-country' });
  });

  it('keeps identical repeats once and holds repeats that differ', () => {
    const same = variant((spec) => { spec.receipts!.push(structuredClone(spec.receipts![0])); });
    const once = convertSpec(same);
    assert.equal(once.report.duplicates.identical, 1);
    assert.ok(receiptOf(once, 'receipt', 1));
    const capture = syntheticCostcoCapture(syntheticMembershipSpec());
    const listed = capture.consolidated.warehouseReceipts as Array<Record<string, unknown>>;
    listed.push({ ...listed[0], rangeLabel: 'Another range', itemLines: 2 });
    const differ = convert(capture);
    assert.deepEqual(heldBy(differ, 'receipt', 1), { reason: 'duplicate-in-capture', check: 'duplicate' });
    assert.equal(differ.payload.held.filter((entry) => entry.reason === 'duplicate-in-capture').length, 1);
  });

  it('holds a record whose own number cannot be read, without a key, and its raw receipt by its own key', () => {
    const capture = syntheticCostcoCapture(syntheticMembershipSpec());
    delete (capture.consolidated.warehouseReceipts as Array<Record<string, unknown>>)[0].barcode;
    const result = convert(capture);
    assert.deepEqual(result.payload.held, [
      { channel: 'warehouse', naturalKey: retailNaturalKey('costco', 'receipt', syntheticBarcode(1)), reason: 'capture-disagreement', check: 'raw-unlisted', date: null },
      { channel: 'warehouse', naturalKey: null, reason: 'unreadable', check: 'record-key', date: null },
    ]);
    assert.equal(result.report.rawUnlisted.receipts, 1);
  });

  it('holds an online order whose two files disagree on funding, a payment flag or a line\'s identity (R2)', () => {
    type Listed = { lines: Array<Record<string, unknown>>; payments: Array<Record<string, unknown>> } & Record<string, unknown>;
    const order = (capture: SyntheticCapture) => (capture.consolidated.onlineOrders as Listed[])[1];
    const cases: Array<[string, (capture: SyntheticCapture) => void, string]> = [
      ['Shop Card applied', (capture) => { order(capture).shopCardApplied = { cents: 100, currency: 'USD', raw: 1 }; }, 'record-totals'],
      ['wallet Shop Card applied', (capture) => { order(capture).walletShopCardApplied = { cents: 100, currency: 'USD', raw: 1 }; }, 'record-totals'],
      ['gift-of-membership flag', (capture) => { order(capture).payments[0].isGiftOfMembership = true; }, 'record-tenders'],
      ['stored-value bucket', (capture) => { order(capture).payments[0].storedValueBucket = 'SAMPLE'; }, 'record-tenders'],
      ['item number', (capture) => { onlineLine(capture, 1, 0).listed.itemNumber = '999001'; }, 'record-lines'],
      ['item id', (capture) => { onlineLine(capture, 1, 0).listed.itemId = 9999; }, 'record-lines'],
      ['description', (capture) => { onlineLine(capture, 1, 0).listed.description = 'Another Sample'; }, 'record-lines'],
      ['fee flag', (capture) => { onlineLine(capture, 1, 0).listed.isFeeItem = true; }, 'record-lines'],
      ['ship method', (capture) => { onlineLine(capture, 1, 0).listed.shipMethod = 'Standard'; }, 'record-lines'],
    ];
    for (const [name, change, check] of cases) {
      const capture = syntheticCostcoCapture(syntheticMembershipSpec());
      change(capture);
      const result = convert(capture);
      assert.deepEqual(heldBy(result, 'order', 2), { reason: 'capture-disagreement', check }, name);
      assert.equal(result.report.receipts.held, 1, name);
    }
  });

  it('reads a payment\'s funding fields by type: no flag but a boolean, and no bucket but the empty forms, mean "none" (R2)', () => {
    type Payment = Record<string, unknown>;
    const listedPayment = (capture: SyntheticCapture) => (capture.consolidated.onlineOrders as Array<{ payments: Payment[] }>)[1].payments[0];
    const rawPayment = (capture: SyntheticCapture) => (capture.rawDetails[1].json as {
      response: { data: { getOrderDetails: { orderPayment: Payment[] } } };
    }).response.data.getOrderDetails.orderPayment[0];
    const cases: Array<[string, (capture: SyntheticCapture) => void, { reason: string; check: string }]> = [
      ['the consolidated flag as text', (capture) => { listedPayment(capture).isGiftOfMembership = 'true'; }, { reason: 'unreadable', check: 'record-shape' }],
      ['the raw flag as text', (capture) => { rawPayment(capture).isGOMPayment = 'true'; }, { reason: 'unreadable', check: 'record-shape' }],
      ['the raw flag as a number', (capture) => { rawPayment(capture).isGOMPayment = 0; }, { reason: 'unreadable', check: 'record-shape' }],
      ['numeric buckets in both files', (capture) => {
        listedPayment(capture).storedValueBucket = 1;
        rawPayment(capture).storedValueBucket = 1;
      }, { reason: 'tender-unknown', check: 'stored-value-payment' }],
      ['a consolidated bucket the raw payment lacks', (capture) => { listedPayment(capture).storedValueBucket = 'SAMPLE'; }, { reason: 'capture-disagreement', check: 'record-tenders' }],
      ['a consolidated bucket of false', (capture) => { listedPayment(capture).storedValueBucket = false; }, { reason: 'capture-disagreement', check: 'record-tenders' }],
    ];
    for (const [name, change, expected] of cases) {
      const capture = syntheticCostcoCapture(syntheticMembershipSpec());
      change(capture);
      const result = convert(capture);
      assert.deepEqual(heldBy(result, 'order', 2), expected, name);
      assert.equal(result.report.receipts.held, 1, name);
    }
    const empty = syntheticCostcoCapture(syntheticMembershipSpec());
    listedPayment(empty).storedValueBucket = '';
    rawPayment(empty).storedValueBucket = null;
    delete listedPayment(empty).isGiftOfMembership;
    rawPayment(empty).isGOMPayment = null;
    assert.equal(convert(empty).report.receipts.held, 0, 'null, absent and the empty string all mean none');
  });

  it('holds a receipt whose two files disagree on its transaction type, a tender\'s type code or its instant savings (R2)', () => {
    const receipt = (capture: SyntheticCapture) => (capture.consolidated.warehouseReceipts as Array<Record<string, unknown> & { tenders: Array<Record<string, unknown>> }>)[0];
    const sale = syntheticCostcoCapture(syntheticMembershipSpec());
    receipt(sale).transactionType = 'Refund';
    assert.deepEqual(heldBy(convert(sale), 'receipt', 1), { reason: 'capture-disagreement', check: 'record-type' });
    const code = syntheticCostcoCapture(syntheticMembershipSpec());
    receipt(code).tenders[0].typeCode = '099';
    assert.deepEqual(heldBy(convert(code), 'receipt', 1), { reason: 'capture-disagreement', check: 'record-tenders' });
    const savings = convertSpec(variant((spec) => { spec.receipts![0].rawOverrides = { instantSavings: null }; }));
    assert.deepEqual(heldBy(savings, 'receipt', 1), { reason: 'capture-disagreement', check: 'record-totals' });
    const none = convertSpec(variant((spec) => { spec.receipts![1].rawOverrides = { instantSavings: null }; }));
    assert.equal(receiptOf(none, 'receipt', 2).totals.instantSavingsMinor, null, 'no savings in either file agree');
  });

  it('refuses a capture missing either required collection, and keeps an empty one as stated (R3)', () => {
    for (const key of ['onlineOrders', 'warehouseReceipts']) {
      for (const value of [undefined, {}, null]) {
        const capture = syntheticCostcoCapture(syntheticMembershipSpec());
        if (value === undefined) delete capture.consolidated[key];
        else capture.consolidated[key] = value;
        assert.throws(() => convert(capture), (error: unknown) => error instanceof RetailConvertError
          && error.code === 'capture-unreadable' && error.at === `$.${key}`, `${key} = ${String(value)}`);
      }
    }
    const empty = convertSpec({ ...syntheticMembershipSpec(), orders: [] });
    assert.equal(empty.report.receipts.byChannel.online, 0);
    assert.equal(empty.report.receipts.held, 0);
  });

  it('holds a raw response that no record of the consolidated file lists, by its own key (R3)', () => {
    const capture = syntheticCostcoCapture(syntheticMembershipSpec());
    (capture.consolidated.onlineOrders as unknown[]).splice(2, 1);
    const result = convert(capture);
    assert.deepEqual(heldBy(result, 'order', 3), { reason: 'capture-disagreement', check: 'raw-unlisted' });
    assert.equal(result.report.rawUnlisted.details, 1);
    assert.equal(result.report.receipts.read, 7);
    assert.equal(result.report.receipts.accepted, 6);
  });

  it('holds an online line of a negative quantity or price, even when the two signs cancel (R5)', () => {
    const flipped = convertSpec(variant((spec) => {
      spec.orders![1].lines[0].qty = -2;
      spec.orders![1].lines[0].price = -250000;
    }));
    assert.deepEqual(heldBy(flipped, 'order', 2), { reason: 'unreadable', check: 'line-negative' });
  });

  it('keeps a fuel line\'s price per gallon exactly as stated, or holds the receipt', () => {
    const tooFine = convertSpec(variant((spec) => { spec.receipts![1].items[0].fuelPrice = 3.49999; }));
    assert.deepEqual(heldBy(tooFine, 'receipt', 2), { reason: 'unreadable', check: 'record-shape' });
    const negative = convertSpec(variant((spec) => { spec.receipts![1].items[0].fuelPrice = -3.499; }));
    assert.deepEqual(heldBy(negative, 'receipt', 2), { reason: 'unreadable', check: 'record-shape' });
  });

  it('accepts cash given back as change on a sale no card paid, and no other tender of the other sign', () => {
    const tendered = (tenders: SyntheticTender[]) => convertSpec(variant((spec) => { spec.receipts![3].tenders = tenders; }));
    const certificate = tendered([{ name: '2% Rebate', last4: SYNTHETIC_CERTIFICATE, amount: (10 * 100) }, { name: 'Cash', amount: -102 }]);
    assert.deepEqual(receiptOf(certificate, 'receipt', 4).tenders.map((tender) => [tender.kind, tender.amountMinor]),
      [['reward-certificate', (10 * 100)], ['cash', -102]]);
    const change = tendered([{ name: 'Cash', amount: (10 * 100) }, { name: 'Cash', amount: -102 }]);
    assert.deepEqual(receiptOf(change, 'receipt', 4).tenders.map((tender) => tender.amountMinor), [(10 * 100), -102]);
    const withCard = tendered([{ name: 'VISA', last4: SYNTHETIC_CARD, amount: (10 * 100) }, { name: 'Cash', amount: -102 }]);
    assert.deepEqual(heldBy(withCard, 'receipt', 4), { reason: 'tender-unproven', check: 'tender-sign' });
    const certificateBack = tendered([{ name: '2% Rebate', last4: SYNTHETIC_CERTIFICATE, amount: -100 }, { name: 'Cash', amount: 998 }]);
    assert.deepEqual(heldBy(certificateBack, 'receipt', 4), { reason: 'tender-unproven', check: 'tender-sign' });
    const refundCash = convertSpec(variant((spec) => {
      spec.receipts![2].tenders = [{ name: 'RTC Whse Pur', last4: SYNTHETIC_CARD, amount: -2519 }, { name: 'Cash', amount: 100 }];
    }));
    assert.deepEqual(heldBy(refundCash, 'receipt', 3), { reason: 'tender-unproven', check: 'tender-sign' });
  });

  it('redacts card numbers in titles as card import does, and stores no title or item number the guard holds', () => {
    const result = convertSpec(variant((spec) => {
      spec.receipts![0].items[0].title = 'GIFT 4111 1111 1111 1111';
      spec.receipts![0].items[0].number = '1234567890123';
      spec.receipts![0].items[1].title2 = 'SAMPLE PIN 1234';
    }));
    const groceries = receiptOf(result, 'receipt', 1);
    assert.equal(groceries.lines[0].title, 'GIFT ***1111');
    assert.equal(groceries.lines[0].itemNumber, null);
    assert.equal(groceries.lines[1].title2, null);
    assert.equal(groceries.lines[2].couponTarget, 1, 'the coupon still finds its item');
    assert.equal(result.report.lines.titlesHeld, 1);
    assert.equal(result.report.lines.itemNumbersHeld, 1);
    assert.ok(!result.json.includes('1111 1111') && !result.json.includes('PIN 1234'));
    assert.equal(validateRetailImportPayload(JSON.parse(result.json)).ok, true);
  });

  it('drops a line that carries no money, and keeps a coupon whose item is not on the receipt at receipt level', () => {
    const result = convertSpec(variant((spec) => {
      spec.receipts![0].items.push({ number: '900000', title: 'MEMBER NOTICE', amount: null, unit: null });
      spec.receipts![0].items[2].title = '/555555';
    }));
    const groceries = receiptOf(result, 'receipt', 1);
    assert.equal(groceries.lines.length, 3);
    assert.equal(groceries.lines[2].couponTarget, null);
    assert.equal(result.report.lines.withoutMoney, 1);
    assert.deepEqual(result.report.coupons, { resolved: 0, unresolved: 1 });
  });

  it('keeps a coupon whose item is on the receipt twice at receipt level too', () => {
    const result = convertSpec(variant((spec) => {
      spec.receipts![0].items.splice(2, 0, { number: '100002', title: 'PAPER TOWELS', title2: '12 ROLLS', amount: 2299, department: 14 });
      spec.receipts![0].tenders[0].amount += 2299;
    }));
    const groceries = receiptOf(result, 'receipt', 1);
    assert.deepEqual(groceries.lines.map((line) => [line.kind, line.couponTarget]), [['item', null], ['item', null], ['item', null], ['coupon', null]]);
    assert.deepEqual(result.report.coupons, { resolved: 0, unresolved: 1 });
  });

  it('persists exactly the weight the strict grammar reads, and none for a title outside it or with another candidate', () => {
    const titled = (title: string) => {
      const result = convertSpec(variant((spec) => { spec.orders![1].lines[0].title = title; }));
      assert.equal(validateRetailImportPayload(JSON.parse(result.json)).ok, true, title);
      return receiptOf(result, 'order', 2).lines[0].metal;
    };
    assert.deepEqual(titled('Gold Bar 1 \u00bd oz')?.statedWeight, { value: '1 1/2', unit: 'oz' });
    assert.deepEqual(titled('Gold Coin 1/10 Troy oz')?.statedWeight, { value: '1/10', unit: 'ozt' });
    assert.deepEqual(titled('Gold Bar 1 oz (1 oz)')?.statedWeight, { value: '1', unit: 'oz' }, 'the same statement twice');
    assert.deepEqual(titled('American Gold Eagle 2024 1 oz Coin')?.statedWeight, { value: '1', unit: 'oz' }, 'a year word (v2)');
    for (const title of [
      'Gold Bar \u0661\u00bd oz', 'Gold Bar 1\u00bd oz', 'Gold Bar 1 / 4 oz', 'Gold Bar \uff11 oz', 'Gold Bar 1 oz (\uff12 \uff47)',
      'Gold Bar 1 oz (2 oz)', 'Gold Bar 1 \u212ag', 'Gold Bar 1 oz\u200bt', 'Gold Bar 1 - 4 oz', 'Gold Bar 1 +/- 4 oz',
      'Gold Bar 2 x 1 oz', 'Gold Bar 1 oz+', 'Gold Bar 2 2024 1 oz', 'Gold Bar 2024 to 2025 1 oz', 'Gold Bar 2 x (2024 1 oz)',
    ]) {
      const metal = titled(title);
      assert.equal(metal?.metal, 'XAU', `${title}: still gold`);
      assert.equal(metal?.statedWeight, null, title);
    }
  });

  it('reads a year word across a warehouse line\'s two description fields, as one title (v2)', () => {
    const lineOf = (title2: string) => {
      const result = convertSpec(variant((spec) => {
        spec.receipts![3].items[0] = { ...spec.receipts![3].items[0], title: 'GOLD BAR', title2 };
      }));
      assert.equal(validateRetailImportPayload(JSON.parse(result.json)).ok, true, title2);
      return receiptOf(result, 'receipt', 4).lines[0];
    };
    const line = lineOf('2024 1 OZ');
    assert.deepEqual([line.title, line.title2], ['GOLD BAR', '2024 1 OZ']);
    assert.deepEqual(line.metal, { metal: 'XAU', form: 'bar', statedWeight: { value: '1', unit: 'oz' }, rule: RETAIL_METAL_TITLE_RULE, pack: 'single' });
    assert.equal(lineOf('2 2024 1 OZ').metal?.statedWeight, null, 'a number before the year');
  });

  // Acceptance cases of the pack rule (gold-ledger-design-v3 §4.4.1 step 2 and §12), through the converter.
  it('reads a metal line\'s pack on the raw title, a warehouse second line and a word past the stored limit included (policy 4)', () => {
    const online = (title: string) => {
      const result = convertSpec(variant((spec) => { spec.orders![1].lines[0].title = title; }));
      assert.equal(validateRetailImportPayload(JSON.parse(result.json)).ok, true, title);
      return receiptOf(result, 'order', 2).lines[0];
    };
    assert.equal(online('1 oz Gold Bar Sample Refinery (New in Assay)').metal?.pack, 'single');
    assert.equal(online('Gold Bar 1 oz, 10-Pack').metal?.pack, 'multiple');
    assert.equal(online('Gold Bar 1 oz \uff22\uff21\uff32\uff33').metal?.pack, 'unknown', 'a fullwidth word is never read as no pack');
    const long = online(`Gold Bar 1 oz ${'Sample '.repeat(34)}10-Pack`);
    assert.equal(long.metal?.pack, 'multiple', 'the raw title is read in full');
    assert.ok(long.title === null || !long.title.includes('10-Pack'), 'the stored title lost the pack word');
    const warehouse = (title2: string) => receiptOf(convertSpec(variant((spec) => {
      spec.receipts![3].items[0] = { ...spec.receipts![3].items[0], title: 'GOLD BAR 1 OZ', title2 };
    })), 'receipt', 4).lines[0].metal?.pack;
    assert.equal(warehouse('5 PACK'), 'multiple', 'a pack word on the second line');
    assert.equal(warehouse('NEW IN ASSAY'), 'single');
    const report = convertSpec(variant((spec) => { spec.orders![1].lines[0].title = 'Gold Bar 1 oz, 10-Pack'; })).report;
    assert.deepEqual(report.metal.byPack, { single: 0, multiple: 1, unknown: 0 });
    assert.equal(Object.values(report.metal.byPackReason).reduce((total, count) => total + count, 0), report.metal.lines, 'one reason per metal line');
    assert.equal(report.metal.byPackReason.none, 0);
    const doubtful = convertSpec(variant((spec) => { spec.orders![1].lines[0].title = 'Gold Bar 1 oz Limit 5'; })).report;
    assert.deepEqual([doubtful.metal.byPack.unknown, doubtful.metal.byPackReason['stray-number']], [1, 1], 'a number nothing explains');
  });

  it('counts a held record\'s metal lines in no pack count', () => {
    const held = convertSpec(variant((spec) => {
      spec.orders![1].lines[0].title = 'Gold Bar 1 oz, 10-Pack';
      spec.orders![1].payments[0].charged = 499999;
    })).report;
    assert.equal(held.receipts.held, 1);
    assert.deepEqual([held.metal.lines, held.metal.byPack.multiple, held.metal.byPackReason.count], [0, 0, 0]);
  });

  it('never uses the pull\'s own metal flag, and counts where it differs from the rule', () => {
    const result = convertSpec(variant((spec) => {
      spec.orders![0].lines[0].pullMetal = true;
      spec.orders![1].lines[0].pullMetal = false;
    }));
    assert.equal(receiptOf(result, 'order', 1).lines[0].metal, null);
    assert.equal(receiptOf(result, 'order', 2).lines[0].metal?.metal, 'XAU');
    assert.equal(result.report.metal.pullFlagOnly, 1);
    assert.equal(result.report.metal.ruleOnly, 1);
  });

  it('refuses a folder of another schema, currency or membership', () => {
    assert.throws(() => convertSpec({ ...syntheticMembershipSpec(), schema: 'holdr-retail-capture/costco@2' }),
      (error: unknown) => error instanceof RetailConvertError && error.code === 'schema-unsupported');
    assert.throws(() => convertSpec({ ...syntheticMembershipSpec(), currency: 'CAD' }),
      (error: unknown) => error instanceof RetailConvertError && error.code === 'currency-unsupported');
    assert.throws(() => convertSpec(syntheticMembershipSpec(), 'costco-3'),
      (error: unknown) => error instanceof RetailConvertError && error.code === 'folder-mismatch');
    assert.throws(() => convertSpec(syntheticMembershipSpec(), 'walmart'),
      (error: unknown) => error instanceof RetailConvertError && error.code === 'folder-mismatch');
  });

  it('reads a first membership captured before its identity was kept', () => {
    const result = convertSpec({ ...syntheticMembershipSpec(), folder: 'costco', account: undefined }, 'costco');
    assert.deepEqual(result.payload.membership, { folder: 'costco', memberSinceYear: null, tier: null, membershipLast4: null });
    assert.equal(result.report.membershipIdentity, 'none');
  });

  it('gives a receipt the same key in every membership', () => {
    const first = convertSpec({ ...syntheticMembershipSpec(), folder: 'costco', account: undefined }, 'costco');
    const second = convertSpec(syntheticMembershipSpec());
    assert.deepEqual(first.payload.receipts.map((receipt) => receipt.naturalKey), second.payload.receipts.map((receipt) => receipt.naturalKey));
  });

  it('reads a membership another household member holds alike, keeping neither the holder\'s name nor a ship-to label', () => {
    const result = convertSpec({ ...syntheticMembershipSpec(), folder: 'costco-3' }, 'costco-3');
    assert.deepEqual(result.payload.membership, { folder: 'costco-3', memberSinceYear: '2001', tier: 'Gold Star', membershipLast4: '0042' });
    assert.equal(result.report.membershipIdentity, 'stated');
    assert.ok(!result.json.includes(SYNTHETIC_FIRST_NAME), 'no holder name');
    assert.ok(!result.json.includes(SYNTHETIC_PLACE.warehouseName), 'no ship-to label');
    assert.equal(receiptOf(result, 'order', 1).tenders[0].last4, SYNTHETIC_CARD, 'a card that pays on several memberships is only a tender');
  });
});

describe('Costco wallet Shop Card (Shop Card design v1)', () => {
  const blender = (overrides: Partial<SyntheticOnlineLine> = {}): SyntheticOnlineLine => ({
    line: 1, number: '2000101', title: 'Sample Blender', qty: 1, price: 30000,
    shipped: [{ qty: 1, date: '2025-09-02' }], delivered: [{ qty: 1, date: '2025-09-04' }], ...overrides,
  });
  const wallet = (charged: number): SyntheticPayment => ({ type: 'Wallet Shop Card', last4: '', charged, shopCard: true });
  const visa = (charged: number): SyntheticPayment => ({ type: 'Visa', last4: SYNTHETIC_CARD, charged });
  /** The base membership plus order 11: 300.00 of goods and 20.00 of tax, 120.00 of it paid by the wallet Shop Card. */
  const mixed = (change: (order: SyntheticOrder) => void = () => {}): SyntheticCaptureSpec => variant((spec) => {
    const order: SyntheticOrder = {
      seed: 11, placed: '2025-09-01T10:00:00', status: 'Delivered', lines: [blender()], tax: 2000, walletShopCardApplied: 12000,
      payments: [visa(30000 + 2000 - 12000), wallet(12000)],
    };
    change(order);
    spec.orders!.push(order);
  });
  /** Order 11 cancelled: nothing charged, its rows still showing the original amounts, the Shop Card's +X and −X. */
  const cancelled = (change: (order: SyntheticOrder) => void = () => {}): SyntheticCaptureSpec => mixed((order) => {
    order.status = 'Cancelled';
    order.lines = [blender({ merch: 0, shipped: undefined, delivered: undefined, cancelled: [{ qty: 1, date: '2025-09-02' }] })];
    order.tax = 0;
    order.total = 0;
    order.walletShopCardApplied = 0;
    order.payments = [visa(20000), wallet(12000), wallet(-12000)];
    change(order);
  });
  /** Order 11's payment rows in both files, and its consolidated record, to change for a test. */
  function order11(capture: SyntheticCapture): { raw: Array<Record<string, unknown>>; listed: Array<Record<string, unknown>>; order: Record<string, unknown> } {
    const orderNumber = syntheticOrderNumber(11);
    const order = (capture.consolidated.onlineOrders as Array<Record<string, unknown>>).find((entry) => entry.orderNumber === orderNumber)!;
    const details = capture.rawDetails
      .map((file) => (file.json as { response: { data: { getOrderDetails: Record<string, unknown> } } }).response.data.getOrderDetails)
      .find((entry) => entry.orderNumber === orderNumber)!;
    return { raw: details.orderPayment as Array<Record<string, unknown>>, listed: order.payments as Array<Record<string, unknown>>, order };
  }
  const SHOP_CARD_ROW = { reason: 'tender-unknown', check: 'shop-card-row' };

  it('converts a live order paid by card and the wallet Shop Card: the card pays the total, the Shop Card its own amount', () => {
    const result = convertSpec(mixed());
    assert.equal(result.report.receipts.held, 0);
    assert.equal(validateRetailImportPayload(JSON.parse(result.json)).ok, true);
    const order = receiptOf(result, 'order', 11);
    assert.deepEqual(order.totals, {
      subtotalMinor: 30000, taxMinor: 2000, instantSavingsMinor: null, discountMinor: 0, shippingMinor: 0, feesMinor: 0,
      storedValueMinor: 12000, totalMinor: 20000,
    });
    assert.deepEqual(order.tenders, [
      { ordinal: 0, kind: 'card', network: 'visa', last4: SYNTHETIC_CARD, amountMinor: 20000 },
      { ordinal: 1, kind: 'shop-card', network: 'unknown', last4: null, amountMinor: 12000 },
    ]);
    assert.equal(order.lines[0].storedValue, null);
    assert.equal(result.report.tenders.byKind['shop-card'], 1);
    assert.equal(receiptOf(result, 'order', 1).totals.storedValueMinor, 0, 'an order without the Shop Card states 0');
    assert.equal(receiptOf(result, 'receipt', 1).totals.storedValueMinor, null, 'a warehouse receipt states none');
  });

  it('keeps the tenders in order: the card, then each Shop Card payment, then the coupons', () => {
    const result = convertSpec(mixed((order) => {
      order.discount = (10 * 100);
      order.payments = [{ type: 'Coupon', last4: '0'.repeat(4), charged: (10 * 100) }, wallet((70 * 100)), visa((300 * 100) + (20 * 100) - (10 * 100) - (120 * 100)), wallet((50 * 100))];
    }));
    assert.deepEqual(receiptOf(result, 'order', 11).tenders.map((tender) => [tender.ordinal, tender.kind, tender.amountMinor]),
      [[0, 'card', (190 * 100)], [1, 'shop-card', (70 * 100)], [2, 'shop-card', (50 * 100)], [3, 'coupon', (10 * 100)]]);
  });

  it('converts an order the Shop Card paid alone: no card tender, a total of zero and the Shop Card amount', () => {
    const result = convertSpec(mixed((order) => {
      order.walletShopCardApplied = 32000;
      order.payments = [wallet(32000)];
    }));
    const order = receiptOf(result, 'order', 11);
    assert.deepEqual([order.status, order.totals.totalMinor, order.totals.storedValueMinor], ['delivered', 0, 32000]);
    assert.deepEqual(order.tenders, [{ ordinal: 0, kind: 'shop-card', network: 'unknown', last4: null, amountMinor: 32000 }]);
    assert.equal(validateRetailImportPayload(JSON.parse(result.json)).ok, true);
    const base = convertSpec(syntheticMembershipSpec()).report.online;
    assert.deepEqual([result.report.online.live, result.report.online.zeroTotal], [base.live + 1, base.zeroTotal],
      'reported live: the Shop Card paid something (design v1 §3), never a zero total');
  });

  it('converts a cancelled order whose Shop Card payments cancel exactly, with no tenders', () => {
    const result = convertSpec(cancelled());
    const order = receiptOf(result, 'order', 11);
    assert.deepEqual([order.status, order.totals.totalMinor, order.totals.storedValueMinor], ['cancelled', 0, 0]);
    assert.deepEqual(order.tenders, []);
    assert.equal(validateRetailImportPayload(JSON.parse(result.json)).ok, true);
    const base = convertSpec(syntheticMembershipSpec()).report.online;
    assert.deepEqual([result.report.online.live, result.report.online.zeroTotal], [base.live, base.zeroTotal + 1], 'charged nothing: a zero total');
  });

  it('flags a line that buys a Shop Card only by the exact catalog list, and holds one the list does not name', () => {
    assert.ok(COSTCO_SHOP_CARD_PURCHASES.length > 0, 'the reviewed catalog list');
    const keys = COSTCO_SHOP_CARD_PURCHASES.map((entry) => JSON.stringify([entry.channel, entry.itemNumber, entry.title, entry.title2]));
    assert.equal(new Set(keys).size, keys.length, 'each catalog entry once');
    for (const entry of COSTCO_SHOP_CARD_PURCHASES) {
      assert.match(`${entry.title} ${entry.title2 ?? ''}`, /SHOP\s?CARD/i, 'a listed title names a Shop Card');
      assert.equal(entry.title, entry.title.trim(), 'a listed title as the catalog writes it, trimmed');
      if (entry.channel === 'online') {
        const result = convertSpec(mixed((order) => { order.lines = [blender({ number: entry.itemNumber, title: entry.title })]; }));
        assert.equal(receiptOf(result, 'order', 11).lines[0].storedValue, 'costco-shop-card', entry.title);
        const otherNumber = convertSpec(mixed((order) => { order.lines = [blender({ number: '2000998', title: entry.title })]; }));
        assert.deepEqual(heldBy(otherNumber, 'order', 11), { reason: 'stored-value-unlisted', check: 'shop-card-purchase-unlisted' }, entry.title);
      } else {
        const result = convertSpec(variant((spec) => {
          spec.receipts![0].items[0] = { ...spec.receipts![0].items[0], number: entry.itemNumber, title: entry.title, title2: entry.title2 ?? undefined };
        }));
        assert.equal(receiptOf(result, 'receipt', 1).lines[0].storedValue, 'costco-shop-card', entry.title);
      }
    }
    const unlisted = convertSpec(mixed((order) => { order.lines = [blender({ number: '2000999', title: 'Sample Shop Card Bundle' })]; }));
    assert.deepEqual(heldBy(unlisted, 'order', 11), { reason: 'stored-value-unlisted', check: 'shop-card-purchase-unlisted' });
    const warehouse = convertSpec(variant((spec) => { spec.receipts![0].items[0] = { ...spec.receipts![0].items[0], title: 'SAMPLE SHOPCARD' }; }));
    assert.deepEqual(heldBy(warehouse, 'receipt', 1), { reason: 'stored-value-unlisted', check: 'shop-card-purchase-unlisted' });
  });

  it('holds a physical Shop Card, whose shape has never been seen', () => {
    assert.deepEqual(heldBy(convertSpec(mixed((order) => { order.shopCardApplied = 100; })), 'order', 11), { reason: 'tender-unproven', check: 'shop-card-physical' });
  });

  it('holds a Shop Card payment of any other shape: another type, another bucket, a card ending, a gift of membership, a missing field or no amount', () => {
    const type = convertSpec(mixed((order) => { order.payments[1] = { ...wallet(12000), type: 'Wallet Gift Card' }; }));
    assert.deepEqual(heldBy(type, 'order', 11), { reason: 'tender-unknown', check: 'payment-type' });
    const cases: Array<[string, (capture: SyntheticCapture) => void]> = [
      ['another bucket in both files', (capture) => { order11(capture).raw[1].storedValueBucket = 'GIFTCARD'; order11(capture).listed[1].storedValueBucket = 'GIFTCARD'; }],
      ['the files disagree on the bucket', (capture) => { order11(capture).listed[1].storedValueBucket = null; }],
      ['no bucket in either file', (capture) => { delete order11(capture).raw[1].storedValueBucket; delete order11(capture).listed[1].storedValueBucket; }],
      ['a card ending in both files', (capture) => { order11(capture).raw[1].cardNumberLast4 = '1234'; order11(capture).listed[1].last4 = '1234'; }],
      ['a card ending in one file', (capture) => { order11(capture).raw[1].cardNumberLast4 = '1234'; }],
      ['no last four in the raw file', (capture) => { delete order11(capture).raw[1].cardNumberLast4; }],
      ['no last four in the consolidated file', (capture) => { delete order11(capture).listed[1].last4; }],
      ['a gift of membership', (capture) => { order11(capture).raw[1].isGOMPayment = true; order11(capture).listed[1].isGiftOfMembership = true; }],
      ['no gift flag in the raw file', (capture) => { delete order11(capture).raw[1].isGOMPayment; }],
      ['no gift flag in the consolidated file', (capture) => { delete order11(capture).listed[1].isGiftOfMembership; }],
      ['a gift flag of null in the consolidated file', (capture) => { order11(capture).listed[1].isGiftOfMembership = null; }],
    ];
    for (const [name, change] of cases) {
      const capture = syntheticCostcoCapture(mixed());
      change(capture);
      assert.deepEqual(heldBy(convert(capture), 'order', 11), SHOP_CARD_ROW, name);
    }
    const zero = convertSpec(mixed((order) => { order.payments.push(wallet(0)); }));
    assert.deepEqual(heldBy(zero, 'order', 11), SHOP_CARD_ROW, 'a Shop Card row of no amount');
  });

  it('reads the Shop Card bucket as a payment type is read, in any case, but spelt the same in both files', () => {
    const real = syntheticCostcoCapture(mixed());
    assert.deepEqual([order11(real).raw[1].storedValueBucket, order11(real).listed[1].storedValueBucket], ['ShopCard', 'ShopCard'], 'the captures\' own spelling');
    const upper = syntheticCostcoCapture(mixed());
    order11(upper).raw[1].storedValueBucket = 'SHOPCARD';
    order11(upper).listed[1].storedValueBucket = 'SHOPCARD';
    assert.equal(receiptOf(convert(upper), 'order', 11).tenders[1].kind, 'shop-card', 'SHOPCARD in both files');
    const differ = syntheticCostcoCapture(mixed());
    order11(differ).listed[1].storedValueBucket = 'SHOPCARD';
    assert.deepEqual(heldBy(convert(differ), 'order', 11), { reason: 'capture-disagreement', check: 'record-tenders' }, 'ShopCard against SHOPCARD');
  });

  it('holds any spelling of a Shop Card the list does not name: spaces, punctuation, full width, invisible characters, two lines', () => {
    const UNLISTED = { reason: 'stored-value-unlisted', check: 'shop-card-purchase-unlisted' };
    for (const title of ['COSTCO DIGITAL SHOP  CARD', 'Costco Shop-Card', 'Shop\tCard Sample', 'Shop.Card', '\uFF33\uFF28\uFF2F\uFF30 \uFF23\uFF21\uFF32\uFF24', 'SHOP\u200BCARD']) {
      const result = convertSpec(mixed((order) => { order.lines = [blender({ number: '2000999', title })]; }));
      assert.deepEqual(heldBy(result, 'order', 11), UNLISTED, JSON.stringify(title));
    }
    const split = convertSpec(variant((spec) => { spec.receipts![0].items[0] = { ...spec.receipts![0].items[0], title: 'SHOP', title2: ' CARD' }; }));
    assert.deepEqual(heldBy(split, 'receipt', 1), UNLISTED, 'a warehouse title split over its two lines');
    const plain = convertSpec(mixed((order) => { order.lines = [blender({ title: 'Sample Shopping Cart' })]; }));
    assert.equal(receiptOf(plain, 'order', 11).lines[0].storedValue, null, 'no Shop Card named');
  });

  it('never takes a fuel receipt\'s line for a Shop Card purchase: the list is the online and warehouse catalog', () => {
    const result = convertSpec(variant((spec) => {
      spec.receipts![1].items.push({ number: '155', title: 'SHOP CARD', amount: (100 * 100) });
      spec.receipts![1].tenders[0].amount += (100 * 100);
    }));
    assert.deepEqual(heldBy(result, 'receipt', 2), { reason: 'stored-value-unlisted', check: 'shop-card-purchase-unlisted' });
    const ordinary = convertSpec(variant((spec) => {
      spec.receipts![1].items.push({ number: '100005', title: 'SAMPLE WIPER FLUID', amount: 999 });
      spec.receipts![1].tenders[0].amount += 999;
    }));
    const gas = receiptOf(ordinary, 'receipt', 2);
    assert.deepEqual([gas.channel, gas.lines[1].kind, gas.lines[1].storedValue], ['gas', 'item', null], 'a fuel receipt\'s other item stays goods');
  });

  it('holds Shop Card payments that are not the wallet amount applied, or a wallet amount of the wrong sign', () => {
    const SUM = { reason: 'payment-mismatch', check: 'shop-card-sum' };
    assert.deepEqual(heldBy(convertSpec(mixed((order) => { order.payments[1] = wallet((110 * 100)); })), 'order', 11), SUM, 'rows short of the amount');
    assert.deepEqual(heldBy(convertSpec(mixed((order) => { order.payments = [visa(20000)]; })), 'order', 11), SUM, 'an amount with no rows');
    assert.deepEqual(heldBy(convertSpec(mixed((order) => {
      order.walletShopCardApplied = 0;
      order.payments = [visa(32000), wallet(5000)];
    })), 'order', 11), SUM, 'rows with no amount');
    assert.deepEqual(heldBy(convertSpec(mixed((order) => {
      order.walletShopCardApplied = -100;
      order.payments = [visa(32100)];
    })), 'order', 11), SUM, 'a negative amount');
  });

  it('holds a live order with a negative Shop Card row, even when the rows add up', () => {
    const result = convertSpec(mixed((order) => { order.payments = [visa((200 * 100)), wallet((130 * 100)), wallet(-(10 * 100))]; }));
    assert.deepEqual(heldBy(result, 'order', 11), { reason: 'tender-unproven', check: 'shop-card-live-refund' });
  });

  it('holds a cancelled order whose Shop Card payments do not cancel exactly, or that shows no cancellation', () => {
    const CANCEL = { reason: 'payment-mismatch', check: 'shop-card-cancel' };
    assert.deepEqual(heldBy(convertSpec(cancelled((order) => { order.payments = [visa((200 * 100)), wallet((120 * 100)), wallet(-(110 * 100))]; })), 'order', 11), CANCEL);
    assert.deepEqual(heldBy(convertSpec(cancelled((order) => { order.lines = [blender({ merch: 0, shipped: undefined, delivered: undefined })]; })), 'order', 11), CANCEL);
  });

  it('holds two cards beside the Shop Card, and files that disagree on the wallet amount', () => {
    assert.deepEqual(heldBy(convertSpec(mixed((order) => { order.payments = [visa((100 * 100)), visa((100 * 100)), wallet((120 * 100))]; })), 'order', 11),
      { reason: 'payment-mismatch', check: 'card-payment' });
    const capture = syntheticCostcoCapture(mixed());
    order11(capture).order.walletShopCardApplied = { cents: 12001, currency: 'USD', raw: 120.01 };
    assert.deepEqual(heldBy(convert(capture), 'order', 11), { reason: 'capture-disagreement', check: 'record-totals' });
  });

  it('checks every line of an order the Shop Card paid alone: it charged something', () => {
    const result = convertSpec(mixed((order) => {
      order.lines = [blender({ merch: 29999 })];
      order.walletShopCardApplied = 31999;
      order.payments = [wallet(31999)];
    }));
    assert.deepEqual(heldBy(result, 'order', 11), { reason: 'identity-failed', check: 'line-quantity-price' });
  });
});

describe('a held record keeps its date only when both capture files agree on it (format 2, Root 11/08)', () => {
  const HELD_FIELDS = ['channel', 'check', 'date', 'naturalKey', 'reason'];
  function heldEntry(result: CostcoConvertResult, kind: 'receipt' | 'order', seed: number) {
    const key = retailNaturalKey('costco', kind, kind === 'receipt' ? syntheticBarcode(seed) : syntheticOrderNumber(seed));
    const entry = result.payload.held.find((held) => held.naturalKey === key);
    assert.ok(entry, `${kind} ${seed} was held`);
    return entry;
  }
  /** Every held record keeps exactly its channel, key, reason, check and date, as written and as the validator reads it. */
  function onlyHeldFields(result: CostcoConvertResult, name: string): void {
    assert.ok(result.payload.held.length > 0, name);
    for (const entry of result.payload.held) assert.deepEqual(Object.keys(entry).sort(), HELD_FIELDS, name);
    for (const entry of (JSON.parse(result.json) as { held: object[] }).held) assert.deepEqual(Object.keys(entry).sort(), HELD_FIELDS, name);
    assert.equal(validateRetailImportPayload(JSON.parse(result.json)).ok, true, name);
    assert.equal(result.report.receipts.heldWithDate, result.payload.held.filter((entry) => entry.date !== null).length, name);
  }
  const rawOrder = (capture: SyntheticCapture, index: number) =>
    (capture.rawDetails[index].json as { response: { data: { getOrderDetails: Record<string, unknown> } } }).response.data.getOrderDetails;
  const listedOrder = (capture: SyntheticCapture, index: number) => (capture.consolidated.onlineOrders as Array<Record<string, unknown>>)[index];
  const listedReceipt = (capture: SyntheticCapture, index: number) => (capture.consolidated.warehouseReceipts as Array<Record<string, unknown>>)[index];

  it('keeps the date of a record held for another reason when both files agree on it, in every channel', () => {
    const cases: Array<[string, CostcoConvertResult, 'receipt' | 'order', number, string, string]> = [
      ['an online order', convertSpec(variant((spec) => { spec.orders![1].payments[0].charged = 499999; })), 'order', 2, 'card-payment', '2025-06-10'],
      ['a warehouse receipt', convertSpec(variant((spec) => {
        spec.receipts![0].receiptType = 'Car Wash';
        spec.receipts![0].documentType = 'CarWashReceipts';
      })), 'receipt', 1, 'receipt-type', '2025-03-01'],
      ['a fuel receipt', convertSpec(variant((spec) => { spec.receipts![1].country = 'CA'; })), 'receipt', 2, 'warehouse-country', '2025-03-04'],
    ];
    for (const [name, result, kind, seed, check, date] of cases) {
      const entry = heldEntry(result, kind, seed);
      assert.deepEqual([entry.check, entry.date], [check, date], name);
      assert.equal(result.report.receipts.heldWithDate, 1, name);
      onlyHeldFields(result, name);
    }
    assert.equal(heldEntry(cases[2][1], 'receipt', 2).channel, 'gas');
  });

  it('keeps no date when the two files disagree on it, whatever check held the record', () => {
    const online = syntheticCostcoCapture(syntheticMembershipSpec());
    listedOrder(online, 1).orderDate = '2025-06-11';
    const fields = syntheticCostcoCapture(variant((spec) => { spec.receipts![0].rawOverrides = { transactionDate: '2025-03-02' }; }));
    const listed = syntheticCostcoCapture(syntheticMembershipSpec());
    listedReceipt(listed, 0).date = '2025-03-02';
    // Held first for another reason (abroad), while the files also disagree on the date.
    const abroad = syntheticCostcoCapture(variant((spec) => { spec.receipts![0].country = 'CA'; }));
    listedReceipt(abroad, 0).date = '2025-03-02';
    const cases: Array<[string, SyntheticCapture, 'receipt' | 'order', number, string]> = [
      ['the placed date against the listed date', online, 'order', 2, 'record-date'],
      ['the raw receipt\'s two date fields', fields, 'receipt', 1, 'record-date'],
      ['the listed date against the raw receipt\'s', listed, 'receipt', 1, 'record-date'],
      ['another check first', abroad, 'receipt', 1, 'warehouse-country'],
    ];
    for (const [name, capture, kind, seed, check] of cases) {
      const result = convert(capture);
      const entry = heldEntry(result, kind, seed);
      assert.deepEqual([entry.check, entry.date], [check, null], name);
      onlyHeldFields(result, name);
    }
  });

  it('keeps no date when either file lacks it or it can\'t be read', () => {
    const unreadableRaw = syntheticCostcoCapture(syntheticMembershipSpec());
    rawOrder(unreadableRaw, 1).orderPlacedDate = 'Sample June day';
    const noListed = syntheticCostcoCapture(syntheticMembershipSpec());
    delete listedOrder(noListed, 1).orderDate;
    const unlisted = syntheticCostcoCapture(syntheticMembershipSpec());
    (unlisted.consolidated.onlineOrders as unknown[]).splice(1, 1);
    const cases: Array<[string, CostcoConvertResult, 'receipt' | 'order', number, string]> = [
      ['no raw details', convertSpec(variant((spec) => { spec.orders![1].noRaw = true; })), 'order', 2, 'raw-missing'],
      ['no raw receipt', convertSpec(variant((spec) => { spec.receipts![0].noRaw = true; })), 'receipt', 1, 'raw-missing'],
      ['an unreadable placed date', convert(unreadableRaw), 'order', 2, 'record-shape'],
      ['no listed date', convert(noListed), 'order', 2, 'record-shape'],
      ['an unreadable raw receipt date', convertSpec(variant((spec) => { spec.receipts![0].rawOverrides = { transactionDateTime: null }; })), 'receipt', 1, 'record-shape'],
      ['raw details no record lists', convert(unlisted), 'order', 2, 'raw-unlisted'],
    ];
    for (const [name, result, kind, seed, check] of cases) {
      const entry = heldEntry(result, kind, seed);
      assert.deepEqual([entry.check, entry.date], [check, null], name);
      onlyHeldFields(result, name);
    }
    const keyless = syntheticCostcoCapture(syntheticMembershipSpec());
    delete listedReceipt(keyless, 0).barcode;
    const result = convert(keyless);
    assert.deepEqual(result.payload.held.map((entry) => [entry.check, entry.date]), [['raw-unlisted', null], ['record-key', null]]);
    onlyHeldFields(result, 'a record whose own number can\'t be read');
  });

  it('keeps the date of repeats that differ only when every one of them has the same', () => {
    const same = syntheticCostcoCapture(syntheticMembershipSpec());
    (same.consolidated.warehouseReceipts as unknown[]).push({ ...listedReceipt(same, 0), rangeLabel: 'Another range', itemLines: 2 });
    const other = syntheticCostcoCapture(syntheticMembershipSpec());
    (other.consolidated.warehouseReceipts as unknown[]).push({ ...listedReceipt(other, 0), date: '2025-03-02' });
    for (const [name, capture, date] of [['every repeat agrees', same, '2025-03-01'], ['a repeat of another date', other, null]] as const) {
      const result = convert(capture);
      const entry = heldEntry(result, 'receipt', 1);
      assert.deepEqual([entry.check, entry.date], ['duplicate', date], name);
      onlyHeldFields(result, name);
    }
  });

  it('keeps no date on a record it converts: an accepted receipt has its own date, and no held entry', () => {
    const result = convertSpec(syntheticMembershipSpec());
    assert.equal(result.payload.held.length, 0);
    assert.equal(result.report.receipts.heldWithDate, 0);
  });
});

describe('metal guard v1 in the converter: flagged, never silently no metal, and nothing else changes (policy 5)', () => {
  const FLAG = (evidence: string[]) => ({ guard: 'metal-guard-v1', evidence, metal: 'XAU' });
  /** The base membership with receipt 1's first item (eggs) titled otherwise. */
  const groceries = (title: string, title2: string | null) => variant((spec) => {
    spec.receipts![0].items[0] = { ...spec.receipts![0].items[0], title, title2 };
  });

  it('reports the guard over every line with a title: the base membership names one metal line, and it is metal', () => {
    const guard = convertSpec(syntheticMembershipSpec()).report.metal.guard;
    assert.deepEqual([guard.metalWordLines, guard.metal, guard.uncertain, guard.adjacencyOnly, guard.withoutEvidence, guard.silentOmissions], [1, 1, 0, 0, 0, 0]);
    assert.ok(Object.values(guard.byClause).every((count) => count === 0));
  });

  it('flags a warehouse line that names a metal with bullion evidence, and keeps its receipt exactly as it is', () => {
    const result = convertSpec(groceries('GOLD BAR', null));
    assert.equal(validateRetailImportPayload(JSON.parse(result.json)).ok, true);
    const receipt = receiptOf(result, 'receipt', 1);
    assert.deepEqual([receipt.lines[0].metal, receipt.lines[0].metalUncertain], [null, FLAG(['adjacency'])]);
    assert.equal(result.report.receipts.held, 0, 'a flag never holds the retail record: holding the line is the metals ledger\'s (#300)');
    const plain = (lines: RetailImportReceipt['lines']) => lines.map((line) => ({ ...line, title: null, title2: null, metalUncertain: null }));
    const before = receiptOf(convertSpec(syntheticMembershipSpec()), 'receipt', 1);
    assert.deepEqual({ ...receipt, lines: plain(receipt.lines) }, { ...before, lines: plain(before.lines) }, 'nothing else of the receipt changes');
    const guard = result.report.metal.guard;
    assert.deepEqual([guard.metalWordLines, guard.metal, guard.uncertain, guard.adjacencyOnly, guard.withoutEvidence, guard.silentOmissions], [2, 1, 1, 1, 0, 0]);
    assert.equal(guard.byClause['shape-without-weight/adjacency'], 1);
  });

  it('reads a warehouse title split over its two lines as one title', () => {
    const result = convertSpec(groceries('GOLD', 'BAR CANDY'));
    assert.deepEqual(receiptOf(result, 'receipt', 1).lines[0].metalUncertain, FLAG(['adjacency']));
    assert.equal(result.report.metal.guard.byClause['near-miss/adjacency'], 1);
  });

  it('flags an online item, a fee line and a fuel line on the same evidence: a line the rule never reads is not-assessed', () => {
    const result = convertSpec(variant((spec) => {
      spec.orders![0].lines[0] = { ...spec.orders![0].lines[0], title: 'Gold Bar Chocolate 1.5 oz' };
      spec.orders![0].lines[1] = { ...spec.orders![0].lines[1], title: 'Gold Bullion Handling' };
      spec.receipts![1].items[0] = { ...spec.receipts![1].items[0], title: 'GOLD 1 OZT' };
    }));
    assert.equal(validateRetailImportPayload(JSON.parse(result.json)).ok, true);
    assert.deepEqual(receiptOf(result, 'order', 1).lines.map((line) => [line.kind, line.metal, line.metalUncertain]), [
      ['item', null, FLAG(['shape-with-weight', 'adjacency'])],
      ['fee', null, FLAG(['bullion-word'])],
    ]);
    const fuel = receiptOf(result, 'receipt', 2).lines[0];
    assert.deepEqual([fuel.kind, fuel.metalUncertain], ['fuel', FLAG(['troy-or-metric-weight'])]);
    const guard = result.report.metal.guard;
    assert.deepEqual([guard.byClause['near-miss/shape-with-weight'], guard.byClause['not-assessed/bullion-word'],
      guard.byClause['not-assessed/troy-or-metric-weight']], [1, 1, 1]);
    assert.deepEqual([guard.metalWordLines, guard.uncertain, guard.adjacencyOnly, guard.silentOmissions], [4, 3, 0, 0]);
  });

  it('counts a line that names a metal with no bullion evidence, unflagged, so drift stays visible', () => {
    const result = convertSpec(groceries('GOLD STAR MBR', null));
    assert.equal(receiptOf(result, 'receipt', 1).lines[0].metalUncertain, null);
    const guard = result.report.metal.guard;
    assert.deepEqual([guard.metalWordLines, guard.metal, guard.uncertain, guard.withoutEvidence, guard.silentOmissions], [2, 1, 0, 1, 0]);
  });

  it('never meets a Shop Card purchase: no listed Shop Card title names a metal', () => {
    for (const entry of COSTCO_SHOP_CARD_PURCHASES) {
      assert.equal(retailMetalTitleGuard([entry.title, entry.title2 ?? ''].join(' ').trim(), { assessed: true }).metalWord, false, entry.title);
    }
  });

  it('reads a warehouse line with only its second description: the rule never did, so the guard flags it as not-assessed', () => {
    const capture = syntheticCostcoCapture(groceries('SAMPLE PLACEHOLDER', '1 OZ GOLD BAR'));
    const raw = capture.rawReceipts[0].json as { response: { data: { receiptsWithCounts: { receipts: Array<{ itemArray: Array<Record<string, unknown>> }> } } } };
    raw.response.data.receiptsWithCounts.receipts[0].itemArray[0].itemDescription01 = null;
    const result = convert(capture);
    assert.equal(validateRetailImportPayload(JSON.parse(result.json)).ok, true);
    const line = receiptOf(result, 'receipt', 1).lines[0];
    assert.deepEqual([line.kind, line.title, line.title2, line.metal, line.metalUncertain], ['item', null, '1 OZ GOLD BAR', null, FLAG(['shape-with-weight', 'adjacency'])]);
    const guard = result.report.metal.guard;
    assert.equal(guard.byClause['not-assessed/shape-with-weight'], 1);
    assert.deepEqual([guard.metalWordLines, guard.metal, guard.uncertain, guard.silentOmissions], [2, 1, 1, 0]);
  });

  it('never flags a coupon line, whatever its text names: a coupon is no line of goods', () => {
    const result = convertSpec(variant((spec) => {
      spec.receipts![0].items[2] = { ...spec.receipts![0].items[2], title: '/100002 1 OZ GOLD BAR', title2: '1 OZ GOLD BAR .9999 FINE' };
    }));
    assert.equal(validateRetailImportPayload(JSON.parse(result.json)).ok, true);
    const coupon = receiptOf(result, 'receipt', 1).lines.find((line) => line.kind === 'coupon');
    assert.deepEqual([coupon?.metal, coupon?.metalUncertain, result.report.coupons.resolved], [null, null, 1]);
    assert.deepEqual(result.report.metal.guard, convertSpec(syntheticMembershipSpec()).report.metal.guard, 'no guard count moves');
  });
});