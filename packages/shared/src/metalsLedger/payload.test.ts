import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  delivered,
  inStore,
  metalItem,
  otherItem,
  syntheticCompetitor,
  syntheticCoverage,
  syntheticKey,
  syntheticOrder,
  syntheticPayload,
  walmartAdmittedOrder,
} from './__fixtures__/metalsPayloads.js';
import { metalsAdmission } from './admission.js';
import { METALS, METALS_CONVERTER, METALS_GUARD_EVIDENCE, METALS_RULES, type Metal, type MetalsLineMetalUncertain } from './model.js';
import {
  METALS_PRODUCT_REF_MAX,
  METALS_RETAIL_FORMATS,
  METALS_RETAIL_INPUTS,
  METALS_RETAIL_POLICIES,
  metalsNaturalKey,
  metalsNewYorkDate,
  metalsSellerKey,
  metalsSellerNameProblem,
  serializeMetalsImportPayload,
  validateMetalsImportPayload,
  type MetalsImportPayload,
} from './payload.js';
import { retailMetalTitleEvidence, retailMetalTitleGuard } from '../retailImportTool/metalTitleRule.js';

/** Synthetic payloads only: invented orders, titles, amounts and last 4s. */
function walmartPayload(): MetalsImportPayload {
  return syntheticPayload('walmart', {
    orders: [walmartAdmittedOrder(1)],
    competitors: [
      syntheticCompetitor('walmart', 'online', 2, '2030-01-12', {
        fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4: '1111', amountMinor: 4321 }],
        refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 4321,
      }),
      syntheticCompetitor('walmart', 'online', 3, '2030-01-15', {
        fulfilment: { shipments: 2 }, methods: [{ kind: 'card', network: 'visa', last4: null, amountMinor: null }],
        refunded: true, cancelled: false, partlyCancelled: false, grossTotalMinor: 10000,
      }),
    ],
    held: [{ key: syntheticKey('walmart', 'order', 4), channel: 'online', date: '2030-01-20', reason: 'field-unsupported', check: 'driver-tip' }],
    coverage: [syntheticCoverage('online', '2029-01-01', '2030-01-31', 4, 4)],
  });
}

function costcoPayload(): MetalsImportPayload {
  const receipt = syntheticOrder({
    source: 'costco', channel: 'warehouse', id: 'r1', date: '2030-02-01',
    skeleton: [metalItem(0, 210000, { taxFlag: 'non-taxable' }), metalItem(1, 105000, { taxFlag: 'non-taxable' }), otherItem(2, 1999, { taxFlag: 'taxable' })],
    components: [{ kind: 'tax', amountMinor: 165 }],
    admission: {
      fulfilment: 'in-store',
      methods: [{ kind: 'card', network: 'visa', last4: '3333', amountMinor: 200000 }, { kind: 'card', network: 'mastercard', last4: '4444', amountMinor: 117164 }],
      refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 317164,
    },
    lines: [
      { ordinal: 0, title: 'GOLD BAR 1OZ PAMP SAMPLE', productRef: 'costco:300001', metal: 'XAU', form: 'bar', statedMass: { value: '1', unit: 'oz' },
        pack: 'single', purity: null, massBasis: null, design: null, quantity: 1, unitPriceMinor: null, events: [inStore(1, '2030-02-01')] },
      { ordinal: 1, title: 'GOLD BAR 1/2OZ SAMPLE', productRef: 'costco:300002', metal: 'XAU', form: 'bar', statedMass: { value: '1/2', unit: 'oz' },
        pack: 'single', purity: null, massBasis: null, design: null, quantity: 1, unitPriceMinor: null, events: [inStore(1, '2030-02-01')] },
    ],
  });
  const online = syntheticOrder({
    source: 'costco', channel: 'online', id: 'o1', date: '2030-02-03',
    skeleton: [metalItem(0, 420000, { shippingMinor: 0 })],
    admission: {
      fulfilment: { shipments: 1 },
      methods: [{ kind: 'card', network: 'visa', last4: '3333', amountMinor: 400000 }, { kind: 'shop-card', network: 'unknown', last4: null, amountMinor: 20000 }],
      refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 420000,
    },
    lines: [{ ordinal: 0, title: '1 oz Gold Bar Sample Refinery (2 pack)', productRef: 'costco:300003', metal: 'XAU', form: 'bar',
      statedMass: { value: '1', unit: 'oz' }, pack: 'multiple', purity: null, massBasis: null, design: null, quantity: 1,
      unitPriceMinor: 420000, events: [{ kind: 'shipped', date: '2030-02-04', dateBasis: 'stated', quantity: 1, occurrence: 1 }, delivered(1, '2030-02-07')] }],
  });
  return syntheticPayload('costco', {
    orders: [receipt, online],
    competitors: [syntheticCompetitor('costco', 'online', 'o2', '2030-02-05', {
      fulfilment: { shipments: 2 }, methods: [{ kind: 'card', network: 'visa', last4: '3333', amountMinor: 6000 }],
      refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 6000,
    })],
    coverage: [syntheticCoverage('online', '2028-02-01', '2030-02-28', null, 2), syntheticCoverage('warehouse', '2028-02-01', '2030-02-28', 1, 1)],
  });
}

function collectpurePayload(): MetalsImportPayload {
  const sale = syntheticOrder({
    source: 'collectpure', channel: 'online', id: 's1', date: '2030-03-02', tradeMoment: '2030-03-02T23:30:00Z', completedDate: '2030-03-12',
    skeleton: [metalItem(0, 400000), metalItem(1, 70000)],
    components: [{ kind: 'platform-fee', amountMinor: -4700 }, { kind: 'insured-shipping', amountMinor: -1500 }],
    lines: [
      { ordinal: 0, title: '1 oz Gold American Eagle', productRef: 'collectpure:SKU-A1', metal: 'XAU', form: 'coin', statedMass: { value: '1', unit: 'oz' },
        pack: 'single', purity: null, massBasis: 'none', design: null, quantity: 2, unitPriceMinor: 200000,
        events: [{ kind: 'agreed', date: '2030-03-02', dateBasis: 'stated', quantity: 2, occurrence: 1 }],
        sale: { program: 'Sell to Dealer', premium: { text: 'Spot + $X per oz', basis: 'troy_ounce' }, inspection: 'passed' } },
      { ordinal: 1, title: '1/4 oz Gold Eagle 22K', productRef: 'collectpure:SKU-A2', metal: 'XAU', form: 'coin', statedMass: { value: '1/4', unit: 'oz' },
        pack: 'single', purity: { text: '22K', value: '11/12' }, massBasis: 'none', design: 'eagle', quantity: 1, unitPriceMinor: 70000, events: [] },
    ],
    payouts: [{ key: syntheticKey('collectpure', 'payout', 1), method: 'ach', destinationLast4: '5555', amountMinor: 463800,
      initiatedDate: '2030-03-11', payoutDate: '2030-03-12', status: 'complete' }],
  });
  return syntheticPayload('collectpure', {
    orders: [sale],
    coverage: [syntheticCoverage('sell-orders', '2029-01-01', '2030-03-31', 1, 1), syntheticCoverage('payouts', '2029-01-01', '2030-03-31', 1, 1)],
  });
}

const valid = (payload: unknown) => {
  const result = validateMetalsImportPayload(payload);
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.issues));
};
const refused = (payload: unknown, path: string, message?: RegExp) => {
  const result = validateMetalsImportPayload(payload);
  assert.equal(result.ok, false, `expected a refusal at ${path}`);
  if (result.ok) return;
  assert.equal(result.issues[0].path, path, JSON.stringify(result.issues));
  if (message) assert.match(result.issues[0].message, message);
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('metals payload: valid synthetic payloads', () => {
  it('validates each source\'s payload, round-trips canonical JSON byte for byte, and holds no digit-bearing key', () => {
    for (const payload of [walmartPayload(), costcoPayload(), collectpurePayload()]) {
      valid(payload);
      const text = serializeMetalsImportPayload(payload);
      assert.equal(serializeMetalsImportPayload(JSON.parse(text) as MetalsImportPayload), text);
      valid(JSON.parse(text));
      for (const key of text.match(/"(?:key|orderKey)": "[^"]*"/g) ?? []) assert.doesNotMatch(key, /\d/);
    }
  });

  it('derives what the rules say: evidence, fine content, cost completeness', () => {
    const [receipt, online] = costcoPayload().orders;
    assert.deepEqual(receipt.evidence.map((entry) => entry.amountMinor), [200000, 117164]);
    assert.deepEqual(receipt.lines.map((line) => [line.costMinor, line.complete]), [[210000, true], [105000, true]]);
    assert.deepEqual(receipt.lines[0].fine, { hold: 'unit-unconfirmed', missing: ['unit-unconfirmed', 'fine-content-unknown'] });
    assert.deepEqual(online.evidence, [{ class: 'costco-settled-tender@1', tender: 0, amountMinor: 400000 }]);
    assert.deepEqual(online.lines[0].fine, { hold: 'pack-count', missing: ['pack-count', 'unit-unconfirmed', 'fine-content-unknown'] });
    const [sale] = collectpurePayload().orders;
    assert.deepEqual(sale.lines.map((line) => line.fine), [
      { hold: 'fine-content-unknown', missing: ['fine-content-unknown', 'unit-unconfirmed'] },
      { troyOz: '1/4', basis: 'coin-specification' },
    ]);
    assert.equal(sale.lines.reduce((total, line) => total + line.netMinor!, 0), 463800);
  });
});

describe('metals payload: recomputation refuses a tampered fact', () => {
  it('fine content, fingerprint and pinned observations', () => {
    const payload = collectpurePayload();
    const fine = clone(payload);
    fine.orders[0].lines[1].fine = { troyOz: '11/48', basis: 'coin-specification' };
    refused(fine, '$.orders[0].lines[1].fine', /content rule/);
    const print = clone(payload);
    print.orders[0].lines[1].contentFingerprint = 'a'.repeat(64);
    refused(print, '$.orders[0].lines[1].contentFingerprint');
    const purity = clone(payload);
    purity.orders[0].lines[1].purity = { text: '22K', value: '22/24' };
    refused(purity, '$.orders[0].lines[1].purity.value');
    const unread = clone(payload);
    unread.orders[0].lines[1].purity = { text: '91.6%', value: '229/250' };
    refused(unread, '$.orders[0].lines[1].purity.text');
  });

  it('an allocation moved between lines, even keeping the totals', () => {
    const payload = costcoPayload();
    const moved = clone(payload);
    moved.orders[0].lines[0].costMinor! += 1;
    moved.orders[0].lines[1].costMinor! -= 1;
    refused(moved, '$.orders[0].lines[0].costMinor', /allocation rule/);
    const hidden = clone(payload);
    hidden.orders[0].unattributedMinor = 1;
    refused(hidden, '$.orders[0].unattributedMinor');
    const price = clone(payload);
    price.orders[0].admission!.grossTotalMinor = 317165;
    refused(price, '$.orders[0].admission.grossTotalMinor');
  });

  it('card evidence the admission doesn\'t give, or withheld evidence it does', () => {
    const payload = walmartPayload();
    const added = clone(payload);
    added.orders[0].admission!.fulfilment = { shipments: 2 };
    refused(added, '$.orders[0].evidence', /admission/);
    const withheld = clone(payload);
    withheld.orders[0].evidence = [];
    refused(withheld, '$.orders[0].evidence');
    const refundedFlag = clone(payload);
    refundedFlag.orders[0].refunds = [{ amountMinor: -100, date: null }];
    refused(refundedFlag, '$.orders[0].admission.refunded');
  });

  it('a competitor\'s stated basis, cap or interval that its facts don\'t give', () => {
    const payload = walmartPayload();
    const basis = clone(payload);
    basis.competitors[1].basis = 'single-charge';
    refused(basis, '$.competitors[1].basis');
    const cap = clone(payload);
    cap.competitors[1].capMinor = 9000;
    refused(cap, '$.competitors[1].capMinor');
    const interval = clone(payload);
    interval.competitors[0].interval.to = '2030-02-10';
    refused(interval, '$.competitors[0].interval');
    const noCard = clone(payload);
    noCard.competitors[0].admission.methods = [{ kind: 'paypal', network: 'unknown', last4: null, amountMinor: 4321 }];
    refused(noCard, '$.competitors[0].admission', /no card funding/);
  });

  it('coverage that claims completeness it lacks', () => {
    const payload = costcoPayload();
    payload.coverage[0].complete = true;
    refused(payload, '$.coverage[0].complete');
  });
});

describe('metals payload: observations and guards', () => {
  it('a single pack whose stored title visibly shows a pack marker', () => {
    const payload = walmartPayload();
    payload.orders[0].lines[0].title = 'Sample Refinery 1 ozt Gold Bar Tube';
    refused(payload, '$.orders[0].lines[0].pack', /pack marker/);
  });

  it('a Costco line with raw qualifier evidence', () => {
    const qualified = costcoPayload();
    qualified.orders[0].lines[0].massBasis = 'none';
    refused(qualified, '$.orders[0].lines[0].massBasis');
  });

  it('reads exactly the retail inputs it lists: format 3, written by retail policy 5 (storage generates its checks from them)', () => {
    assert.deepEqual(METALS_RETAIL_INPUTS, [{ format: 3, policy: 5 }]);
    assert.deepEqual([METALS_RETAIL_FORMATS, METALS_RETAIL_POLICIES], [[3], [5]]);
    for (const format of [0, 4, '3', null]) {
      const payload = costcoPayload();
      (payload.input as unknown as Record<string, unknown>).retailFormat = format;
      refused(payload, '$.input.retailFormat', /retail format/);
    }
  });

  it('keeps a guarded seller name or a seller key, never contact or number data', () => {
    for (const name of ['Sample Bullion Shop', "Sample & Sons Metals, Inc."]) assert.equal(metalsSellerNameProblem(name), null, name);
    for (const name of ['Shop 12345', 'Shop 555 123 45', 'mail@example', 'www.example', 'example.com', ' Padded', 'x'.repeat(61), 'Caf\u00E9']) {
      assert.notEqual(metalsSellerNameProblem(name), null, name);
    }
    assert.match(metalsSellerKey('Shop 12345'), /^seller-[a-p]{8}$/);
    const keyed = walmartPayload();
    keyed.orders[0].lines[0].seller = metalsSellerKey('Shop 12345');
    valid(keyed);
    const leaked = walmartPayload();
    leaked.orders[0].lines[0].seller = 'Shop 12345';
    refused(leaked, '$.orders[0].lines[0].seller');
  });

  it('keys with digits, unknown fields, foreign rules and repeated keys', () => {
    const digits = walmartPayload();
    digits.orders[0].key = 'walmart-order-1234';
    refused(digits, '$.orders[0].key');
    const extra = walmartPayload() as unknown as Record<string, unknown>;
    extra.note = 'x';
    refused(extra, '$', /unknown key/);
    const rules = walmartPayload();
    (rules.rules as Record<string, string>).pack = 'metals-pack-v0';
    refused(rules, '$.rules');
    const twice = walmartPayload();
    twice.held.push({ ...twice.held[0] });
    refused(twice, '$.held[1].key', /repeated/);
    const both = walmartPayload();
    both.held[0].key = both.competitors[0].orderKey;
    refused(both, '$.held[0].key');
    assert.match(metalsNaturalKey('walmart', 'order', ['x']), /^walmart-order-[a-p]{64}$/);
  });
});

describe('metals payload: lifecycle and sale facts', () => {
  it('a warehouse lot is one in-store delivery on the receipt date', () => {
    const payload = costcoPayload();
    payload.orders[0].lines[0].events = [delivered(1, '2030-02-01')];
    refused(payload, '$.orders[0].lines[0].events', /in-store/);
  });

  it('online events never deliver or return more than they may, and number identical events in order', () => {
    const over = costcoPayload();
    over.orders[1].lines[0].events.push({ kind: 'cancelled', date: '2030-02-05', dateBasis: 'stated', quantity: 1, occurrence: 1 });
    refused(over, '$.orders[1].lines[0].events', /more units/);
    const occurrence = costcoPayload();
    occurrence.orders[1].lines[0].events[1].occurrence = 2;
    refused(occurrence, '$.orders[1].lines[0].events[1].occurrence');
    const basis = costcoPayload();
    basis.orders[1].lines[0].events[1].dateBasis = null;
    refused(basis, '$.orders[1].lines[0].events[1].dateBasis');
  });

  it('a complete sale\'s payouts add up to its net proceeds', () => {
    const short = collectpurePayload();
    short.orders[0].payouts[0].amountMinor -= 1;
    refused(short, '$.orders[0].payouts', /net proceeds/);
    const pending = collectpurePayload();
    pending.orders[0].payouts[0].status = 'pending';
    refused(pending, '$.orders[0].payouts');
    const inProgress = collectpurePayload();
    inProgress.orders[0].status = 'received';
    inProgress.orders[0].payouts = [];
    valid(inProgress);
  });

  it('a sale carries no card funding and no competitors', () => {
    const funded = collectpurePayload();
    funded.orders[0].evidence = [{ class: 'walmart-order-total@1', tender: 0, amountMinor: 1 }];
    refused(funded, '$.orders[0].evidence');
    const competing = collectpurePayload();
    competing.competitors = walmartPayload().competitors;
    refused(competing, '$.competitors');
  });

  it('a sale\'s short texts are stored text: no formula start, long digit run or address', () => {
    for (const text of ['+$X per oz', '=X per oz', 'Spot plus 123456', 'mail@example']) {
      const payload = collectpurePayload();
      payload.orders[0].lines[0].sale!.premium!.text = text;
      refused(payload, '$.orders[0].lines[0].sale.premium.text');
    }
  });
});

describe('metals payload: review findings at 9ddbcbf1 (synthetic)', () => {
  it('reads a UTC instant\'s New York date, daylight time included', () => {
    const cases: Array<[string, string]> = [
      ['2030-01-11T04:30:00Z', '2030-01-10'], ['2030-01-11T05:00:00Z', '2030-01-11'],
      ['2030-07-11T03:30:00Z', '2030-07-10'], ['2030-07-11T04:00:00Z', '2030-07-11'],
      ['2030-03-10T04:59:59Z', '2030-03-09'], ['2030-03-10T06:59:59Z', '2030-03-10'],
      ['2030-11-03T04:30:00Z', '2030-11-03'], ['2030-11-04T04:30:00Z', '2030-11-03'],
      ['2030-12-31T23:30:00Z', '2030-12-31'], ['2031-01-01T04:59:59.999Z', '2030-12-31'],
    ];
    for (const [moment, day] of cases) assert.equal(metalsNewYorkDate(moment), day, moment);
  });

  it('a sale\'s date is its trade moment\'s New York date, never the UTC date', () => {
    const evening = collectpurePayload();
    evening.orders[0].tradeMoment = '2030-03-03T04:30:00Z';
    valid(evening);
    const utcDay = clone(evening);
    utcDay.orders[0].date = '2030-03-03';
    refused(utcDay, '$.orders[0].date', /New York date/);
  });

  it('a gross total before refunds is never negative, on an order or a competitor', () => {
    const order = costcoPayload();
    order.orders[0].admission!.grossTotalMinor = -1;
    refused(order, '$.orders[0].admission.grossTotalMinor');
    const competitor = walmartPayload();
    competitor.competitors[1].admission.grossTotalMinor = -1;
    refused(competitor, '$.competitors[1].admission.grossTotalMinor');
  });

  it('keeps an own "__proto__" key as data, so it is refused wherever a shape is compared canonically', () => {
    const ownProto = (target: object) => Object.defineProperty(target, '__proto__', { value: { extra: true }, enumerable: true, configurable: true, writable: true });
    // Cloned first, so no shared constant (the rule versions) is ever touched.
    const rules = clone(walmartPayload());
    ownProto(rules.rules);
    refused(rules, '$.rules');
    const evidence = clone(walmartPayload());
    ownProto(evidence.orders[0].evidence[0]);
    refused(evidence, '$.orders[0].evidence');
    const interval = clone(walmartPayload());
    ownProto(interval.competitors[0].interval);
    refused(interval, '$.competitors[0].interval');
    const fine = clone(collectpurePayload());
    ownProto(fine.orders[0].lines[0].fine);
    refused(fine, '$.orders[0].lines[0].fine');
    const parsed = JSON.parse('{"b": 1, "__proto__": {"x": 1}, "a": 2}') as unknown as MetalsImportPayload;
    assert.equal(serializeMetalsImportPayload(parsed), '{\n  "__proto__": {\n    "x": 1\n  },\n  "a": 2,\n  "b": 1\n}\n');
  });

  it('nothing stated happens before the order, and a sale\'s agreed and completed events are its own days', () => {
    const early = costcoPayload();
    early.orders[1].lines[0].events[0].date = '2030-02-02';
    refused(early, '$.orders[1].lines[0].events[0].date', /before the order/);
    const agreed = collectpurePayload();
    agreed.orders[0].lines[0].events[0].date = '2030-03-03';
    refused(agreed, '$.orders[0].lines[0].events[0].date', /agreed day/);
    const completed = collectpurePayload();
    completed.orders[0].lines[0].events.push({ kind: 'completed', date: '2030-03-11', dateBasis: 'stated', quantity: 2, occurrence: 1 });
    refused(completed, '$.orders[0].lines[0].events[1].date', /completed date/);
    completed.orders[0].lines[0].events[1].date = '2030-03-12';
    valid(completed);
    const finished = collectpurePayload();
    finished.orders[0].completedDate = '2030-03-01';
    refused(finished, '$.orders[0].completedDate', /before the order/);
    const initiated = collectpurePayload();
    initiated.orders[0].payouts[0].initiatedDate = '2030-03-01';
    refused(initiated, '$.orders[0].payouts[0].initiatedDate', /before the order/);
    const paid = collectpurePayload();
    paid.orders[0].payouts[0].payoutDate = '2030-03-10';
    refused(paid, '$.orders[0].payouts[0].payoutDate', /initiated/);
    valid(syntheticPayload('walmart', { orders: [walmartAdmittedOrder(1, '2030-05-20')], coverage: [syntheticCoverage('online', '2029-01-01', '2030-12-31', 1, 1)] }));
  });

  it('an instant must be canonical: no hour 24, and no field that rolls over into another instant', () => {
    const midnight = collectpurePayload();
    midnight.orders[0].tradeMoment = '2030-03-02T24:00:00Z';
    refused(midnight, '$.orders[0].tradeMoment', /real UTC instant/);
    for (const capturedAt of ['2030-03-31T23:59:60Z', '2030-03-31T23:60:00Z', '2030-03-31T25:00:00Z']) {
      const captured = clone(collectpurePayload());
      (captured.input as { capturedAt: string }).capturedAt = capturedAt;
      refused(captured, '$.input.capturedAt', /real UTC instant/);
    }
    const fraction = collectpurePayload();
    fraction.orders[0].tradeMoment = '2030-03-02T23:30:00.5Z';
    valid(fraction);
  });

  it('a metal item\'s own amount is never negative', () => {
    const negative = costcoPayload();
    negative.orders[1].skeleton[0].amountMinor = -1;
    refused(negative, '$.orders[1].skeleton[0].amountMinor', /negative on a metal item/);
  });

  it('a cancelled sale has no payouts', () => {
    const paidOut = collectpurePayload();
    paidOut.orders[0].status = 'cancelled';
    refused(paidOut, '$.orders[0].payouts', /cancelled sale/);
    const cancelled = collectpurePayload();
    cancelled.orders[0].status = 'cancelled';
    cancelled.orders[0].payouts = [];
    cancelled.orders[0].completedDate = null;
    valid(cancelled);
  });

  it('a method never pays a negative amount, a card refund is always negative, and a card above the gross bars any amount (G1A-05)', () => {
    const credit = costcoPayload();
    credit.orders[1].admission!.methods[1].amountMinor = -20000;
    refused(credit, '$.orders[1].admission.methods[1].amountMinor');
    const positiveRefund = walmartPayload();
    positiveRefund.competitors[1].admission.methods.push({ kind: 'card-refund', network: 'visa', last4: null, amountMinor: 500 });
    refused(positiveRefund, '$.competitors[1].admission.methods[1].amountMinor');
    const refund = walmartPayload();
    refund.competitors[1].admission.methods.push({ kind: 'card-refund', network: 'visa', last4: null, amountMinor: -500 });
    valid(refund);
    // A card stated above the gross total: the stored single charge is refused; the any-amount aggregate is the answer.
    const above = walmartPayload();
    above.competitors[0].admission.methods[0].amountMinor = 5000;
    refused(above, '$.competitors[0].basis');
    above.competitors[0].basis = 'aggregate';
    above.competitors[0].capMinor = 4321;
    refused(above, '$.competitors[0].capMinor');
    above.competitors[0].capMinor = null;
    valid(above);
  });
});

describe('metals payload: product refs up to 80 characters (contract follow-up 1, synthetic)', () => {
  // A catalog id of letters and dashes only, so it holds no digit unless a test puts some in.
  const slug = (length: number) => 'sample-refinery-gold-bar-in-assay-'.repeat(4).slice(0, length);
  const withRef = (id: string) => {
    const payload = walmartPayload();
    payload.orders[0].lines[0].productRef = `walmart:${id}`;
    return payload;
  };

  it('keeps a catalog id of 80 characters and refuses one of 81', () => {
    assert.equal(METALS_PRODUCT_REF_MAX, 80);
    valid(withRef(slug(80)));
    refused(withRef(slug(81)), '$.orders[0].lines[0].productRef', /wrong form/);
  });

  it('refuses a run of 13 or more digits by its own rule, even in an 80-character id, and keeps a run of 12', () => {
    for (const run of ['1234567890123', '12345678901234567']) {
      const id = `${slug(80 - run.length - 1)}-${run}`;
      assert.equal(id.length, 80);
      refused(withRef(id), '$.orders[0].lines[0].productRef', /13 or more digits/);
    }
    for (const id of [`${slug(80 - 13)}-123456789012`, 'SKU123456789012B', '123456789012']) valid(withRef(id));
  });
});

describe('metals payload: metal-uncertain lines (contract follow-up 1, synthetic)', () => {
  const flag = (overrides: Partial<MetalsLineMetalUncertain> = {}): MetalsLineMetalUncertain =>
    ({ guard: 'metal-guard-v1', evidence: ['shape-with-weight', 'troy-or-metric-weight'], metal: 'XAU', ...overrides });
  const funding = {
    fulfilment: { shipments: 1 }, methods: [{ kind: 'card' as const, network: 'visa' as const, last4: '1111', amountMinor: 200000 }],
    refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 200000,
  };
  /** A Walmart order whose one line the title rule refused and the guard flagged; its funding alone would admit evidence. */
  const flaggedWalmart = (metalUncertain: MetalsLineMetalUncertain | null = flag(), metal: Metal | null = null) => syntheticPayload('walmart', {
    orders: [syntheticOrder({
      source: 'walmart', channel: 'online', id: 'f1', date: '2030-01-10', skeleton: [metalItem(0, 200000)],
      components: [{ kind: 'tax', amountMinor: 0 }], admission: funding,
      lines: [{ ordinal: 0, title: 'Sample Refinery 1 ozt Gold Bar Assay Card', productRef: 'walmart:100002', metal, metalUncertain,
        form: null, statedMass: null, pack: 'single', purity: null, massBasis: 'none', design: null, quantity: 1, unitPriceMinor: 200000,
        events: [delivered(1, '2030-01-14')], seller: 'Sample Bullion Shop' }],
    })],
    coverage: [syntheticCoverage('online', '2029-01-01', '2030-01-31', 1, 1)],
  });
  const at = '$.orders[0].lines[0]';

  it('keeps a flagged line held bullion-unconfirmed, and its order out of card evidence its funding would admit', () => {
    const payload = flaggedWalmart();
    valid(payload);
    const [order] = payload.orders;
    assert.deepEqual(order.lines[0].fine, { hold: 'bullion-unconfirmed', missing: ['bullion-unconfirmed', 'weight-unstated', 'fine-content-unknown'] });
    assert.deepEqual(order.evidence, []);
    assert.equal(metalsAdmission('walmart', 'online', order.admission!)?.evidence.length, 1);
    valid(JSON.parse(serializeMetalsImportPayload(payload)));
  });

  it('keeps every evidence code alone, all of them in the closed order, each metal and no metal', () => {
    for (const code of METALS_GUARD_EVIDENCE) valid(flaggedWalmart(flag({ evidence: [code] })));
    valid(flaggedWalmart(flag({ evidence: [...METALS_GUARD_EVIDENCE] })));
    for (const metal of [...METALS, null]) valid(flaggedWalmart(flag({ metal })));
  });

  it('refuses a flag whose shape or vocabulary is not the guard\'s', () => {
    const cases: Array<[unknown, string, RegExp]> = [
      ['flagged', `${at}.metalUncertain`, /must be an object/],
      [{ ...flag(), clause: 'near-miss/adjacency' }, `${at}.metalUncertain`, /unknown key/],
      [{ guard: 'metal-guard-v1', evidence: ['purity'] }, `${at}.metalUncertain.metal`, /missing/],
      [flag({ guard: 'metal-guard-v2' as never }), `${at}.metalUncertain.guard`, /expected value/],
      [flag({ evidence: 'purity' as never }), `${at}.metalUncertain.evidence`, /must be an array/],
      [flag({ evidence: [] }), `${at}.metalUncertain.evidence`, /must not be empty/],
      [flag({ evidence: [...METALS_GUARD_EVIDENCE, 'purity'] }), `${at}.metalUncertain.evidence`, new RegExp(`at most ${METALS_GUARD_EVIDENCE.length} entries`)],
      [flag({ evidence: ['weight' as never] }), `${at}.metalUncertain.evidence[0]`, /allowed value/],
      [flag({ evidence: ['troy-or-metric-weight', 'shape-with-weight'] }), `${at}.metalUncertain.evidence[1]`, /closed order/],
      [flag({ evidence: ['purity', 'purity'] }), `${at}.metalUncertain.evidence[1]`, /closed order/],
      [flag({ metal: 'GOLD' as never }), `${at}.metalUncertain.metal`, /allowed value/],
    ];
    for (const [value, path, message] of cases) {
      const payload = flaggedWalmart();
      (payload.orders[0].lines[0] as unknown as Record<string, unknown>).metalUncertain = value;
      refused(payload, path, message);
    }
    const missing = flaggedWalmart(null);
    delete (missing.orders[0].lines[0] as unknown as Record<string, unknown>).metalUncertain;
    refused(missing, `${at}.metalUncertain`, /missing/);
  });

  it('a flag only marks a line whose title names no metal', () => {
    refused(flaggedWalmart(flag(), 'XAU'), `${at}.metalUncertain`, /names no metal/);
    valid(flaggedWalmart(null, 'XAU'));
  });

  it('a flagged line is held bullion-unconfirmed, by value', () => {
    for (const fine of [{ hold: 'weight-unstated', missing: ['weight-unstated', 'fine-content-unknown'] }, { troyOz: '1/1', basis: 'owner-confirmed' }]) {
      const payload = flaggedWalmart();
      (payload.orders[0].lines[0] as unknown as Record<string, unknown>).fine = fine;
      refused(payload, `${at}.fine`, /bullion-unconfirmed on a flagged line/);
    }
  });

  it('an order with a flagged line has no card evidence', () => {
    const payload = flaggedWalmart();
    payload.orders[0].evidence = metalsAdmission('walmart', 'online', payload.orders[0].admission!)!.evidence;
    refused(payload, '$.orders[0].evidence', /flagged line/);
  });

  it('a flag is content evidence: changing what fired changes the fingerprint', () => {
    const payload = flaggedWalmart();
    payload.orders[0].lines[0].metalUncertain = flag({ evidence: ['bullion-word'] });
    refused(payload, `${at}.contentFingerprint`);
    const metal = flaggedWalmart();
    metal.orders[0].lines[0].metalUncertain = flag({ metal: 'XAG' });
    refused(metal, `${at}.contentFingerprint`);
  });

  it('a CollectPure sale line may be flagged too, held like any other', () => {
    const sale = syntheticOrder({
      source: 'collectpure', channel: 'online', id: 'sf', date: '2030-03-02', completedDate: '2030-03-12',
      skeleton: [metalItem(0, 200000)], components: [{ kind: 'platform-fee', amountMinor: -2000 }],
      lines: [{ ordinal: 0, title: 'Sample Refinery Gold Bar Assay Card 1 oz', productRef: 'collectpure:SKU-F1', metal: null,
        metalUncertain: flag({ evidence: ['shape-with-weight'] }), form: null, statedMass: null, pack: 'single', purity: null,
        massBasis: 'none', design: null, quantity: 1, unitPriceMinor: 200000,
        events: [{ kind: 'agreed', date: '2030-03-02', dateBasis: 'stated', quantity: 1, occurrence: 1 }] }],
      payouts: [{ key: syntheticKey('collectpure', 'payout', 'f'), method: 'ach', destinationLast4: '5555', amountMinor: 198000,
        initiatedDate: '2030-03-11', payoutDate: '2030-03-12', status: 'complete' }],
    });
    const payload = syntheticPayload('collectpure', { orders: [sale] });
    valid(payload);
    assert.equal((payload.orders[0].lines[0].fine as { hold: string }).hold, 'bullion-unconfirmed');
  });
});

describe('metals payload: retail format 3, written by retail policy 5, the one retail input (contract follow-up 1, synthetic)', () => {
  const policy = (payload: MetalsImportPayload, retailFormat: number, retailPolicyVersion: number) => {
    (payload as unknown as { input: unknown }).input = { retailPayloadSha256: 'a'.repeat(64), retailFormat, retailPolicyVersion };
    return payload;
  };
  /** A warehouse receipt whose one line the title rule refused and the guard flagged. */
  const flaggedReceipt = () => syntheticPayload('costco', {
    orders: [syntheticOrder({
      source: 'costco', channel: 'warehouse', id: 'rp5', date: '2030-02-01', skeleton: [metalItem(0, 100000, { taxFlag: 'non-taxable' })],
      admission: { fulfilment: 'in-store', methods: [{ kind: 'card', network: 'visa', last4: '3333', amountMinor: 100000 }],
        refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 100000 },
      lines: [{ ordinal: 0, title: 'GOLD BAR 1OZ ASSAY CARD SAMPLE', productRef: 'costco:300010', metal: null,
        metalUncertain: { guard: 'metal-guard-v1', evidence: ['shape-with-weight'], metal: 'XAU' }, form: null, statedMass: null,
        pack: 'unknown', purity: null, massBasis: null, design: null, quantity: 1, unitPriceMinor: null, events: [inStore(1, '2030-02-01')] }],
    })],
  });

  it('reads a Costco payload of retail format 3 under retail policy 5, and under no other policy', () => {
    valid(policy(costcoPayload(), 3, 5));
    refused(policy(costcoPayload(), 3, 4), '$.input.retailPolicyVersion');
  });

  it('refuses retail formats 1 and 2 whole: their lines were read under title rule v2 and pack v1', () => {
    for (const [format, version] of [[1, 3], [2, 4]]) {
      refused(policy(costcoPayload(), format, version), '$.input.retailFormat', /retail format/);
      refused(policy(flaggedReceipt(), format, version), '$.input.retailFormat', /retail format/);
    }
  });

  it('lets a Costco line carry the guard\'s flag, as retail format 3 maps it', () => {
    valid(policy(flaggedReceipt(), 3, 5));
  });
});

describe('metals payload: the stored title and the pinned title guard, one direction only (contract follow-up 1E, synthetic)', () => {
  /** The title rule refuses it (CARD is a near-miss word here: it isn't the title's last word); the guard flags it. */
  const GUARD_FLAGS = 'SAMPLE 1 oz Gold Bar in Assay Card Holder';
  /** The title rule reads gold in it, so the guard never flags it once the rule has assessed it. */
  const READS_AS_METAL = 'Sample Refinery 1 ozt Gold Bar';
  /** The title rule reads a bar of no one metal in it (metal-unknown), so the guard never flags it either. */
  const READS_AS_TWO_METALS = 'Sample 1 oz Gold and Silver Bar';
  const at = '$.orders[0].lines[0]';
  /**
   * A Walmart order whose one line is stored with this title: unflagged, as a gold line or a metal-unknown one (both read
   * as bullion: a metals line is a metal item of its skeleton), or flagged.
   */
  const stored = (title: string | null, line: 'gold' | 'metal-unknown' | 'flagged') => syntheticPayload('walmart', {
    orders: [syntheticOrder({
      source: 'walmart', channel: 'online', id: 'g1', date: '2030-01-10', skeleton: [metalItem(0, 200000)],
      components: [{ kind: 'tax', amountMinor: 0 }],
      admission: { fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4: '1111', amountMinor: 200000 }],
        refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 200000 },
      lines: [{ ordinal: 0, title, productRef: 'walmart:100003', metal: line === 'gold' ? 'XAU' : null,
        metalUncertain: line === 'flagged' ? { guard: 'metal-guard-v1', evidence: ['shape-with-weight'], metal: 'XAU' } : null,
        form: null, statedMass: null, pack: 'single', purity: null, massBasis: 'none', design: null, quantity: 1, unitPriceMinor: 200000,
        events: [delivered(1, '2030-01-14')], seller: 'Sample Bullion Shop' }],
    })],
    coverage: [syntheticCoverage('online', '2029-01-01', '2030-01-31', 1, 1)],
  });

  it('refuses a line stored unflagged whose stored title the pinned title guard reads as metal-uncertain', () => {
    assert.equal(retailMetalTitleGuard(GUARD_FLAGS, { assessed: true }).uncertain, true);
    refused(stored(GUARD_FLAGS, 'gold'), `${at}.metalUncertain`, /pinned title guard/);
  });

  it('refuses a metal-unknown line stored unflagged too: the check reads the flag, never the line\'s metal', () => {
    refused(stored(GUARD_FLAGS, 'metal-unknown'), `${at}.metalUncertain`, /pinned title guard/);
    const reading = retailMetalTitleEvidence(READS_AS_TWO_METALS);
    assert.ok(reading !== null && reading.metal === null);
    valid(stored(READS_AS_TWO_METALS, 'metal-unknown'));
  });

  it('never refuses a flagged line whose stored title reads as metal: a cut may have dropped the word that refused it', () => {
    assert.notEqual(retailMetalTitleEvidence(READS_AS_METAL), null);
    valid(stored(READS_AS_METAL, 'flagged'));
  });

  it('runs the pinned rule on the stored title itself, never the payload\'s claim: an ordinary metal title passes', () => {
    // Unassessed, the guard would flag this title (a metal word with bullion evidence); the pinned rule reads gold in it.
    assert.equal(retailMetalTitleGuard(READS_AS_METAL, { assessed: false }).uncertain, true);
    valid(stored(READS_AS_METAL, 'gold'));
  });

  it('checks no withheld title', () => {
    valid(stored(null, 'gold'));
  });
});

describe('metals payload: the converters\' one importable release (contract follow-up 1E, synthetic)', () => {
  it('accepts only the release METALS_CONVERTER names, and refuses a 1.0.0 payload, written before the title guard ran', () => {
    valid(walmartPayload());
    for (const release of ['holdr-metals-convert 1.0.0', 'holdr-metals-convert 0.9.0', 'holdr-metals-convert 1.1.1', 'holdr-metals-convert 1.10']) {
      const payload = walmartPayload();
      payload.converterVersion = release;
      refused(payload, '$.converterVersion', /expected value/);
    }
    // As a 1.0.0 converter wrote it, its rules name no title guard either; with the current release, those rules refuse.
    const olderRules = Object.fromEntries(Object.entries(METALS_RULES).filter(([key]) => key !== 'titleGuard'));
    const older = walmartPayload();
    older.converterVersion = 'holdr-metals-convert 1.0.0';
    (older as unknown as { rules: unknown }).rules = olderRules;
    refused(older, '$.converterVersion', /expected value/);
    const relabelled = walmartPayload();
    (relabelled as unknown as { rules: unknown }).rules = olderRules;
    refused(relabelled, '$.rules', /rule versions/);
    assert.equal(walmartPayload().converterVersion, METALS_CONVERTER);
  });
});