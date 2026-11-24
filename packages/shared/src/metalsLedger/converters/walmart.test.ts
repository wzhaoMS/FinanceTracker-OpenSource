import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cardImportTextProblem, sanitizeCardText } from '../../cardImport.js';
import { retailMetalPack } from '../../retailImportTool/metalPackRule.js';
import {
  RETAIL_METAL_GUARD,
  RETAIL_METAL_GUARD_CLAUSES,
  RETAIL_METAL_GUARD_EVIDENCE,
  retailMetalTitleEvidence,
  retailMetalTitleGuard,
  type RetailMetalGuardEvidence,
} from '../../retailImportTool/metalTitleRule.js';
import { metalsAdmission, metalsSettlementInterval } from '../admission.js';
import { metalsAllocation } from '../allocation.js';
import { metalsContentFingerprint, metalsFineContent, metalsFineContentWire } from '../contentRule.js';
import { METALS_CAPTURE_SCHEMAS, METALS_RULES } from '../model.js';
import { metalsTitleObservations } from '../observations.js';
import {
  METALS_PRODUCT_REF_MAX,
  METALS_TITLE_MAX,
  metalsNaturalKey,
  metalsSellerKey,
  serializeMetalsImportPayload,
  validateMetalsImportPayload,
  type MetalsCompetitor,
  type MetalsHeldRecord,
  type MetalsImportPayload,
  type MetalsLine,
  type MetalsOrder,
} from '../payload.js';
import { METALS_CONVERTER, MetalsConvertError, type MetalsCaptureFolder, type MetalsConvertOutput } from './common.js';
import {
  convertWalmartCapture,
  WALMART_HOLD_CHECK_NAMES,
  WALMART_HOLD_CHECKS,
  walmartCaptureConverter,
  WALMART_PRODUCT_REF_WITHHELD,
  walmartBullionTokens,
  walmartGuardCensus,
  walmartTitleRefusal,
  type WalmartConvertReport,
  type WalmartCoverageGap,
  type WalmartHoldCheck,
  type WalmartProductRefWithheld,
} from './walmart.js';
import {
  SYNTHETIC_WALMART_BULLION_SELLER,
  SYNTHETIC_WALMART_NUMBERED_SELLER,
  SYNTHETIC_WALMART_SECOND_CARD,
  SYNTHETIC_WALMART_TITLES,
  syntheticWalmartCaptureFolder,
  syntheticWalmartFiles,
  syntheticWalmartFolder,
  syntheticWalmartGroup,
  syntheticWalmartMetalsSensitiveValues,
  syntheticWalmartMetalsSpec,
  syntheticWalmartMoneyText,
  syntheticWalmartOrder,
  syntheticWalmartOrderId,
  type SyntheticWalmartFolder,
  type SyntheticWalmartGroup,
  type SyntheticWalmartOrder,
  type SyntheticWalmartSpec,
} from './__fixtures__/walmart.js';

type Json = Record<string, unknown>;
type Output = MetalsConvertOutput<WalmartConvertReport>;

/** The object at a path of keys and indices in a parsed file, to change for a test. */
function at(value: unknown, ...path: Array<string | number>): Json {
  let current = value;
  for (const key of path) current = (current as Json)[key];
  return current as Json;
}

/** Converts a folder; every payload it returns must validate, as the exact canonical text it would write. */
function convert(folder: SyntheticWalmartFolder): Output {
  const output = convertWalmartCapture(syntheticWalmartCaptureFolder(folder));
  const checked = validateMetalsImportPayload(JSON.parse(output.json));
  if (!checked.ok) assert.fail(`invalid payload: ${JSON.stringify(checked.issues)}`);
  assert.equal(serializeMetalsImportPayload(checked.payload), output.json);
  assert.deepEqual(checked.payload, output.payload);
  return output;
}

/**
 * Runs `action` and returns its value, or the code of the one declared refusal: the converter refusing its own output
 * (MetalsConvertError converter-invalid). Every other error is rethrown as it was, never turned into assertion data
 * (kill standard, addendum 3(e)): the assertion on what this returns stays in the test's body.
 */
function orRefusal<T>(action: () => T): T | 'converter-invalid' {
  try {
    return action();
  } catch (error) {
    if (error instanceof MetalsConvertError && error.code === 'converter-invalid') return error.code;
    throw error;
  }
}

/** The metals spec with one order replaced by what `change` makes of it. */
function specWith(seed: number, change: (order: SyntheticWalmartOrder) => SyntheticWalmartOrder): SyntheticWalmartSpec {
  const spec = syntheticWalmartMetalsSpec();
  return { orders: spec.orders.map((order) => (order.seed === seed ? change(order) : order)) };
}

const fresh = () => syntheticWalmartFolder(syntheticWalmartMetalsSpec());
const keyOf = (seed: number) => metalsNaturalKey('walmart', 'order', [syntheticWalmartOrderId(seed)]);
const lineKeyOf = (seed: number, line: number) => metalsNaturalKey('walmart', 'line', [syntheticWalmartOrderId(seed), String(line)]);

function orderOf(payload: MetalsImportPayload, seed: number): MetalsOrder {
  const order = payload.orders.find((entry) => entry.key === keyOf(seed));
  if (!order) assert.fail(`no order for seed ${seed}`);
  return order;
}

function competitorOf(payload: MetalsImportPayload, seed: number): MetalsCompetitor {
  const competitor = payload.competitors.find((entry) => entry.orderKey === keyOf(seed));
  if (!competitor) assert.fail(`no competitor for seed ${seed}`);
  return competitor;
}

/** The consolidated record and the raw detail's order of one seed, to change alike. */
function recordsOf(folder: SyntheticWalmartFolder, seed: number): { listed: Json; raw: Json } {
  const id = syntheticWalmartOrderId(seed);
  const listed = (folder.consolidated.orders as Json[]).find((order) => order.orderId === id);
  const raw = folder.rawDetails.find((detail) => detail.orderId === id)?.json.order as Json | undefined;
  if (!listed || !raw) assert.fail(`no records for seed ${seed}`);
  return { listed, raw };
}

/** A line's metal facts, recomputed from its raw name by the rules themselves. */
function expectedLine(raw: string): Pick<MetalsLine, 'metal' | 'form' | 'statedMass' | 'pack' | 'purity' | 'massBasis' | 'design' | 'contentFingerprint' | 'fine'> {
  const evidence = retailMetalTitleEvidence(raw);
  if (evidence === null) assert.fail('the title names no metal');
  const observed = metalsTitleObservations(raw);
  const statedMass = evidence.statedWeight === null ? null : { value: evidence.statedWeight.value, unit: evidence.statedWeight.unit };
  const content = {
    source: 'walmart' as const, metal: evidence.metal, form: evidence.form, statedMass, pack: retailMetalPack(raw),
    purity: observed.purity, massBasis: observed.massBasis, design: observed.design, metalUncertain: null,
  };
  return {
    metal: content.metal, form: content.form, statedMass, pack: content.pack, purity: content.purity, massBasis: content.massBasis,
    design: content.design, contentFingerprint: metalsContentFingerprint(content), fine: metalsFineContentWire(metalsFineContent(content)),
  };
}

describe('Walmart converter: orders', () => {
  it('converts an account: metal orders, competitors, and nothing for an order with no card funding', () => {
    const folder = fresh();
    const { payload, report } = convert(folder);
    assert.equal(payload.source, 'walmart');
    assert.deepEqual(payload.account, { folder: 'walmart', identityLast4: null });
    assert.equal(payload.converterVersion, METALS_CONVERTER);
    assert.deepEqual(payload.rules, METALS_RULES);
    assert.ok('files' in payload.input && payload.input.files === 1 + folder.listPages.length + folder.rawDetails.length);
    assert.ok('schema' in payload.input && payload.input.schema === METALS_CAPTURE_SCHEMAS.walmart);
    assert.match('captureDigest' in payload.input ? payload.input.captureDigest : '', /^[a-p]{64}$/);
    assert.deepEqual(payload.orders.map((order) => order.key).sort(), [11, 12, 13].map(keyOf).sort());
    assert.deepEqual(payload.competitors.map((competitor) => competitor.orderKey).sort(), [14, 15, 16].map(keyOf).sort());
    assert.deepEqual(payload.held, []);
    assert.deepEqual(report.records, { read: 7, metal: 3, flagged: 0, competitors: 3, noCardFunding: 1, held: 0, duplicates: { identical: 0, differing: 0 } });
    assert.deepEqual(report.admission, { qualifying: { metal: 2, other: 1 }, aggregate: { metal: 1, other: 2 }, withheld: 0 });
    assert.equal(report.lines.items, 8);
    assert.equal(report.lines.metal, 3);
    assert.equal(report.tenders.byKind.paypal, 1);
    assert.equal(report.tenders.byKind['gift-card'], 1);
    assert.equal(report.tenders.byKind.card, 6);
    assert.deepEqual(report.dates, { first: '2030-03-01', last: '2030-03-01' });
    for (const check of WALMART_HOLD_CHECK_NAMES) assert.equal(report.heldByCheck[check], 0);
  });

  it('admits a one-card, one-group order under walmart-order-total@1 at its grand total', () => {
    const { payload } = convert(fresh());
    const order = orderOf(payload, 11);
    assert.deepEqual(order.admission, {
      fulfilment: { shipments: 1 },
      methods: [{ kind: 'card', network: 'visa', last4: '0007', amountMinor: 262_500 }],
      refunded: false,
      cancelled: false,
      partlyCancelled: false,
      grossTotalMinor: 262_500,
    });
    assert.deepEqual(order.evidence, [{ class: 'walmart-order-total@1', tender: 0, amountMinor: 262_500 }]);
    assert.deepEqual(order.evidence, metalsAdmission('walmart', 'online', order.admission!)?.evidence);
    assert.equal(order.fullPriceMinor, 262_500);
    assert.deepEqual(order.refunds, []);
    assert.equal(orderOf(payload, 13).evidence.length, 1, 'a held content does not change the money evidence');
  });

  it('keeps a metal order paid by a card and a gift card, with no evidence', () => {
    const { payload } = convert(fresh());
    const order = orderOf(payload, 12);
    assert.deepEqual(order.admission!.methods, [
      { kind: 'card', network: 'mastercard', last4: SYNTHETIC_WALMART_SECOND_CARD, amountMinor: 370_000 },
      { kind: 'gift-card', network: 'unknown', last4: null, amountMinor: 50_000 },
    ]);
    assert.deepEqual(order.evidence, []);
    assert.deepEqual(metalsAdmission('walmart', 'online', order.admission!), { basis: 'aggregate', capMinor: 420_000, evidence: [] });
  });

  it('competes every other card-funded order: a refunded one up to its gross total, never its net', () => {
    const { payload, report } = convert(fresh());
    const single = competitorOf(payload, 14);
    assert.equal(single.basis, 'single-charge');
    assert.equal(single.capMinor, null);
    assert.deepEqual(single.interval, metalsSettlementInterval('2030-03-01', 'online'));
    assert.deepEqual(single.interval, { from: '2030-03-01', to: '2030-03-31' });
    const refunded = competitorOf(payload, 15);
    assert.equal(refunded.basis, 'aggregate');
    assert.equal(refunded.admission.refunded, true);
    assert.equal(refunded.admission.grossTotalMinor, 3_998 + 200);
    assert.equal(refunded.capMinor, 3_998 + 200, 'the barrier reaches the gross total, not the net');
    const twoGroups = competitorOf(payload, 16);
    assert.equal(twoGroups.basis, 'aggregate');
    assert.deepEqual(twoGroups.admission.fulfilment, { shipments: 2 });
    assert.equal(twoGroups.capMinor, 3_150);
    assert.ok(!payload.held.some((held) => held.key === keyOf(17)));
    assert.equal(report.records.noCardFunding, 1);
  });

  it('bars any amount for a card stated above the order\'s gross total: its funding contradicts itself', () => {
    const folder = syntheticWalmartFolder(specWith(14, (order) => ({ ...order, payments: [{ ...order.payments[0], charged: [order.grandTotal + 100] }] })));
    const competitor = competitorOf(convert(folder).payload, 14);
    assert.equal(competitor.basis, 'aggregate');
    assert.equal(competitor.capMinor, null);
    assert.deepEqual(metalsAdmission('walmart', 'online', competitor.admission), { basis: 'aggregate', capMinor: null, evidence: [] });
  });

  it('reads every metal fact from the raw name, and keeps the line\'s money, ref, seller and event', () => {
    const { payload, report } = convert(fresh());
    const titles = SYNTHETIC_WALMART_TITLES;
    const [eagle] = orderOf(payload, 11).lines;
    const [bar] = orderOf(payload, 12).lines;
    const [pack] = orderOf(payload, 13).lines;
    for (const [line, title] of [[eagle, titles.eagle], [bar, titles.fineBar], [pack, titles.silverPack]] as const) {
      assert.deepEqual({
        metal: line.metal, form: line.form, statedMass: line.statedMass, pack: line.pack, purity: line.purity, massBasis: line.massBasis,
        design: line.design, contentFingerprint: line.contentFingerprint, fine: line.fine,
      }, expectedLine(title));
      assert.equal(line.title, title);
      assert.equal(line.productRef, 'walmart:500000001');
      assert.equal(line.unitPriceMinor, null, 'Walmart states no unit price');
    }
    assert.equal(eagle.key, lineKeyOf(11, 1));
    assert.ok('basis' in eagle.fine && eagle.fine.basis === 'coin-specification');
    assert.ok('basis' in bar.fine && bar.fine.basis === 'stated-mass-basis');
    assert.equal(pack.pack, 'multiple');
    assert.ok('hold' in pack.fine && pack.fine.hold === 'pack-count');
    assert.equal(eagle.seller, SYNTHETIC_WALMART_BULLION_SELLER);
    assert.equal(pack.seller, null);
    assert.deepEqual(eagle.events, [{ kind: 'delivered', date: '2030-03-08', dateBasis: 'stated', quantity: 1, occurrence: 1 }]);
    assert.deepEqual(bar.events, [{ kind: 'delivered', date: '2030-03-08', dateBasis: 'stated', quantity: 2, occurrence: 1 }]);
    assert.deepEqual(pack.events, [{ kind: 'delivered', date: '2030-03-09', dateBasis: 'year-inferred', quantity: 1, occurrence: 1 }]);
    assert.equal(eagle.amountMinor, 250_000);
    assert.equal(eagle.costMinor, 262_500);
    assert.equal(eagle.complete, true);
    assert.deepEqual(report.content, {
      known: 2,
      byBasis: { 'owner-confirmed': 0, 'coin-specification': 1, 'stated-mass-basis': 1 },
      byHold: Object.fromEntries(Object.keys(report.content.byHold).map((hold) => [hold, hold === 'pack-count' ? 1 : 0])),
    });
    assert.deepEqual(report.events.byBasis, { stated: 2, 'year-inferred': 1, none: 0 });
    assert.deepEqual(report.sellers, { names: 2, keys: 0, none: 1 });
  });
});

describe('Walmart converter: the raw name and what is stored', () => {
  const FILLER = 'Brilliant Uncirculated Investment Grade Bullion In Original Mint Assay With Certificate Of Authenticity ';
  const LONG = `${SYNTHETIC_WALMART_TITLES.fineBar} ${FILLER.repeat(3)}5 Pack`;
  const withTitle = (title: string) => syntheticWalmartFolder(specWith(11, (order) => ({
    ...order, groups: [syntheticWalmartGroup(1, title, 1, 250_000)],
  })));

  it('sees a pack marker past the stored title\'s length: the pack is read on the raw name', () => {
    assert.ok(LONG.length > METALS_TITLE_MAX && LONG.indexOf('5 Pack') > METALS_TITLE_MAX);
    const [line] = orderOf(convert(withTitle(LONG)).payload, 11).lines;
    assert.equal(line.pack, 'multiple');
    assert.deepEqual({
      metal: line.metal, form: line.form, statedMass: line.statedMass, pack: line.pack, purity: line.purity, massBasis: line.massBasis,
      design: line.design, contentFingerprint: line.contentFingerprint, fine: line.fine,
    }, expectedLine(LONG));
    assert.ok(line.title !== null && line.title.length <= METALS_TITLE_MAX && LONG.startsWith(line.title));
    assert.ok(!line.title.includes('Pack'), 'the stored title is cut before the marker');
    assert.notEqual(retailMetalPack(line.title), 'multiple');
    assert.ok('hold' in line.fine && line.fine.hold === 'pack-count');
  });

  it('neutralizes a formula sign and redacts a long digit run in the stored title, never in the readings', () => {
    const formula = `=${SYNTHETIC_WALMART_TITLES.fineBar}`;
    const [stored] = orderOf(convert(withTitle(formula)).payload, 11).lines;
    assert.equal(stored.title, `'${formula}`);
    assert.equal(cardImportTextProblem(stored.title!, METALS_TITLE_MAX), null);
    assert.deepEqual(stored.fine, expectedLine(formula).fine);

    const digits = `${SYNTHETIC_WALMART_TITLES.fineBar} SKU ${'1234567890'}${'123'}`;
    const [redacted] = orderOf(convert(withTitle(digits)).payload, 11).lines;
    assert.ok(redacted.title !== null && redacted.title.includes('***') && !/\d{5}/.test(redacted.title));
    assert.equal(redacted.pack, retailMetalPack(digits));
    assert.deepEqual(redacted.fine, expectedLine(digits).fine);
  });

  it('keeps a seller\'s business name only behind the guard, else its key', () => {
    const named = (name: string) => {
      const folder = syntheticWalmartFolder(specWith(11, (order) => ({
        ...order,
        groups: [syntheticWalmartGroup(1, SYNTHETIC_WALMART_TITLES.eagle, 1, 250_000, {
          seller: { id: 'SAMPLESELLERID', name, isPro: true, shown: true, shippedByWalmart: false },
        })],
      })));
      const { payload, report } = convert(folder);
      return { seller: orderOf(payload, 11).lines[0].seller, report };
    };
    const numbered = named(SYNTHETIC_WALMART_NUMBERED_SELLER);
    assert.equal(numbered.seller, metalsSellerKey(SYNTHETIC_WALMART_NUMBERED_SELLER));
    assert.match(numbered.seller ?? '', /^seller-[a-p]{8}$/);
    assert.deepEqual(numbered.report.sellers, { names: 1, keys: 1, none: 1 });
    assert.equal(named(`  ${SYNTHETIC_WALMART_BULLION_SELLER.replace(' ', '   ')} `).seller, SYNTHETIC_WALMART_BULLION_SELLER);
    for (const name of ['sample@shop', 'WWW.SAMPLE.COM', 'SAMPLE SHOP.COM', '=SAMPLE SHOP', 'S'.repeat(61)]) {
      assert.equal(named(name).seller, metalsSellerKey(name), name);
    }
  });
});

describe('Walmart converter: product refs', () => {
  /** Seed 11's one item with the catalog id `id` in both of its files: the payload, or the converter's refusal of it. */
  const withCatalogId = (id: string): Output | 'converter-invalid' => {
    const folder = fresh();
    const { listed, raw } = recordsOf(folder, 11);
    at(listed, 'groups', 0, 'items', 0).usItemId = id;
    at(raw, 'groups_2101', 0, 'items', 0, 'productInfo').usItemId = id;
    return orRefusal(() => convert(folder));
  };
  const refOf = (output: Output | string) => (typeof output === 'string' ? output : orderOf(output.payload, 11).lines[0].productRef);

  it('stores a catalog id of exactly the contract\'s METALS_PRODUCT_REF_MAX characters, and withholds one longer', () => {
    const longest = 'A'.repeat(METALS_PRODUCT_REF_MAX);
    assert.equal(refOf(withCatalogId(longest)), `walmart:${longest}`);
    assert.equal(refOf(withCatalogId(`${longest}A`)), null);
  });

  it('withholds a catalog id with a run of 13 digits, which the validator refuses, and stores one of 12', () => {
    assert.equal(refOf(withCatalogId('1'.repeat(13))), null);
    assert.equal(refOf(withCatalogId('1'.repeat(12))), `walmart:${'1'.repeat(12)}`);
  });

  it('withholds exactly the refs the validator refuses, by its first failing check, and emits only refs it keeps', () => {
    const longest = 'A'.repeat(METALS_PRODUCT_REF_MAX);
    const cases: Array<[string, WalmartProductRefWithheld | null]> = [
      [longest, null], ['SAMPLE-ITEM_42', null], ['1'.repeat(12), null],
      ['SAMPLE.ITEM', 'form'], [`${longest}.`, 'form'], [`${longest}A`, 'too-long'], ['1'.repeat(13), 'digit-run'],
      ['XXXXXXXXX00000', 'card-data'],
    ];
    for (const [id, withheld] of cases) {
      const output = withCatalogId(id);
      if (typeof output === 'string') assert.fail(`${id}: the folder was refused (${output})`);
      const line = orderOf(output.payload, 11).lines[0];
      const reasons = output.report.lines.productRefs.metal.withheld;
      assert.deepEqual([line.productRef, WALMART_PRODUCT_REF_WITHHELD.filter((reason) => reasons[reason] > 0)],
        [withheld === null ? `walmart:${id}` : null, withheld === null ? [] : [withheld]], id);
      // Put the ref back: the validator keeps exactly the refs the converter stores.
      const restored = structuredClone(output.payload);
      orderOf(restored, 11).lines[0].productRef = `walmart:${id}`;
      assert.equal(validateMetalsImportPayload(restored).ok, withheld === null, id);
    }
  });
});

describe('Walmart converter: money and lifecycle', () => {
  it('allocates a mixed order: tax and fees over metal and other lines stay unattributed', () => {
    const group = syntheticWalmartGroup(1, SYNTHETIC_WALMART_TITLES.eagle, 1, 250_000);
    group.items.push({ line: 2, name: SYNTHETIC_WALMART_TITLES.widget, qty: 1, lineCents: 1_000 });
    const base = syntheticWalmartOrder(21, [group]);
    const total = base.grandTotal + 599;
    const spec = { orders: [{ ...base, fees: [{ label: 'Shipping', cents: 599 }], grandTotal: total, payments: [{ ...base.payments[0], charged: [total] }] }] };
    const order = orderOf(convert(syntheticWalmartFolder(spec)).payload, 21);
    const skeleton = [
      { ordinal: 0, kind: 'item', amountMinor: 250_000, shippingMinor: null, feeParent: null, couponTarget: null, taxFlag: null, metal: true },
      { ordinal: 1, kind: 'item', amountMinor: 1_000, shippingMinor: null, feeParent: null, couponTarget: null, taxFlag: null, metal: false },
      { ordinal: 2, kind: 'fee', amountMinor: 599, shippingMinor: null, feeParent: null, couponTarget: null, taxFlag: null, metal: false },
    ] as const;
    assert.deepEqual(order.skeleton, skeleton);
    assert.deepEqual(order.components, [{ kind: 'tax', amountMinor: 12_550 }]);
    const allocation = metalsAllocation(order.skeleton, order.components);
    assert.equal(order.unattributedMinor, allocation.unattributedMinor);
    assert.equal(order.unattributedMinor, 12_550 + 599);
    assert.equal(order.fullPriceMinor, total);
    const [line] = order.lines;
    assert.equal(line.costMinor, 250_000);
    assert.equal(line.complete, false);
    assert.deepEqual(order.evidence, [{ class: 'walmart-order-total@1', tender: 0, amountMinor: total }]);
  });

  it('delivers, picks up and cancels by group status, each date with its basis', () => {
    const titles = SYNTHETIC_WALMART_TITLES;
    const order = syntheticWalmartOrder(22, [
      syntheticWalmartGroup(1, titles.fineBar, 1, 400_000, { eventDate: '2030-03-07' }),
      syntheticWalmartGroup(2, titles.eagle, 2, 500_000, {
        fulfillmentType: 'SC_PICKUP', detailedGroupType: 'PICKUP_CURBSIDE', status: 'PICKED_UP', statusParts: ['Picked up ', 'Mar 09'],
        eventDate: '2030-03-09', deliveryDate: null,
      }),
      syntheticWalmartGroup(3, titles.eagle, 1, 250_000, { status: 'CANCELED', statusParts: ['Canceled'], eventDate: '2030-03-02', deliveryDate: null }),
    ], { flags: { partlyCancelled: true } });
    const { payload, report } = convert(syntheticWalmartFolder({ orders: [order] }));
    const converted = orderOf(payload, 22);
    assert.deepEqual(converted.lines.map((line) => [line.key, line.events]), [
      [lineKeyOf(22, 1), [{ kind: 'delivered', date: '2030-03-08', dateBasis: 'stated', quantity: 1, occurrence: 1 }]],
      [lineKeyOf(22, 2), [{ kind: 'delivered', date: '2030-03-09', dateBasis: 'year-inferred', quantity: 2, occurrence: 1 }]],
      [lineKeyOf(22, 3), [{ kind: 'cancelled', date: '2030-03-02', dateBasis: 'year-inferred', quantity: 1, occurrence: 1 }]],
    ]);
    assert.equal(report.events.dateDisagreements, 1, 'the stated delivery date is kept over the status date');
    assert.deepEqual(report.events.byKind, { delivered: 2, cancelled: 1 });
    assert.equal(converted.admission!.partlyCancelled, true);
    assert.deepEqual(converted.admission!.fulfilment, { shipments: 3 });
    assert.deepEqual(converted.evidence, []);
  });

  it('never places an event before its order: such a date is kept as unknown', () => {
    const order = syntheticWalmartOrder(24, [syntheticWalmartGroup(1, SYNTHETIC_WALMART_TITLES.eagle, 1, 250_000, {
      deliveryDate: '2030-02-01', eventDate: '2030-02-01',
    })]);
    const { payload, report } = convert(syntheticWalmartFolder({ orders: [order] }));
    assert.deepEqual(orderOf(payload, 24).lines[0].events, [{ kind: 'delivered', date: null, dateBasis: null, quantity: 1, occurrence: 1 }]);
    assert.equal(report.events.datesBeforeOrder, 1);
    assert.deepEqual(report.events.byBasis, { stated: 0, 'year-inferred': 0, none: 1 });
  });

  it('never counts PayPal funding as a card, whatever the method\'s type says', () => {
    const eagle = syntheticWalmartOrder(26, [syntheticWalmartGroup(1, SYNTHETIC_WALMART_TITLES.eagle, 1, 250_000)]);
    const widget = syntheticWalmartOrder(27, [syntheticWalmartGroup(1, SYNTHETIC_WALMART_TITLES.widget, 1, 1_000, { seller: null })]);
    const viaPayPal = (order: SyntheticWalmartOrder): SyntheticWalmartOrder => ({
      ...order, payments: [{ type: 'CREDITCARD', cardType: 'PAYPAL', last4: '0007', charged: [order.grandTotal] }],
    });
    const { payload, report } = convert(syntheticWalmartFolder({ orders: [viaPayPal(eagle), viaPayPal(widget)] }));
    const metal = orderOf(payload, 26);
    assert.deepEqual(metal.admission!.methods, [{ kind: 'paypal', network: 'unknown', last4: null, amountMinor: eagle.grandTotal }]);
    assert.deepEqual(metal.evidence, []);
    assert.deepEqual(payload.competitors, []);
    assert.equal(report.records.noCardFunding, 1);
    assert.equal(report.tenders.byKind.paypal, 2);
    assert.equal(report.tenders.byKind.card, 0);
    assert.deepEqual(report.admission, { qualifying: { metal: 0, other: 0 }, aggregate: { metal: 0, other: 0 }, withheld: 0 });
  });

  it('keeps an event undated when its group states no date at all, never the order\'s', () => {
    const order = syntheticWalmartOrder(36, [
      syntheticWalmartGroup(1, SYNTHETIC_WALMART_TITLES.eagle, 1, 250_000, { deliveryDate: null, eventDate: null }),
      syntheticWalmartGroup(2, SYNTHETIC_WALMART_TITLES.fineBar, 1, 400_000, { status: 'CANCELED', statusParts: ['Canceled'], deliveryDate: null, eventDate: null }),
    ]);
    const { payload, report } = convert(syntheticWalmartFolder({ orders: [order] }));
    assert.deepEqual(orderOf(payload, 36).lines.map((line) => line.events), [
      [{ kind: 'delivered', date: null, dateBasis: null, quantity: 1, occurrence: 1 }],
      [{ kind: 'cancelled', date: null, dateBasis: null, quantity: 1, occurrence: 1 }],
    ]);
    assert.equal(report.events.datesBeforeOrder, 0);
    assert.deepEqual(report.events.byBasis, { stated: 0, 'year-inferred': 0, none: 2 });
  });

  it('maps store balance, Walmart credit and other cards exactly: store balance is never a card', () => {
    const titles = SYNTHETIC_WALMART_TITLES;
    const paidBy = (seed: number, title: string, type: 'CREDITCARD' | 'CLOSEDLOOP', cardType: string | null): SyntheticWalmartOrder => {
      const order = syntheticWalmartOrder(seed, [syntheticWalmartGroup(1, title, 1, 10_000, { seller: null })]);
      return { ...order, payments: [{ type, cardType, last4: type === 'CREDITCARD' ? '0007' : null, charged: [order.grandTotal] }] };
    };
    const { payload, report } = convert(syntheticWalmartFolder({
      orders: [
        paidBy(31, titles.eagle, 'CLOSEDLOOP', null),
        paidBy(32, titles.widget, 'CLOSEDLOOP', null),
        paidBy(33, titles.widget, 'CREDITCARD', 'WMCREDIT'),
        paidBy(34, titles.widget, 'CREDITCARD', 'OTHER'),
        paidBy(35, titles.eagle, 'CREDITCARD', 'WMCREDIT'),
      ],
    }));
    const total = 10_000 + 500;
    assert.deepEqual(orderOf(payload, 31).admission!.methods, [{ kind: 'store-balance', network: 'unknown', last4: null, amountMinor: total }]);
    assert.deepEqual(orderOf(payload, 31).evidence, [], 'store balance admits no evidence');
    assert.ok(!payload.competitors.some((competitor) => competitor.orderKey === keyOf(32)), 'store balance competes as no card');
    const card = { kind: 'card', network: 'unknown', last4: '0007', amountMinor: total };
    assert.deepEqual(competitorOf(payload, 33).admission.methods, [card]);
    assert.deepEqual(competitorOf(payload, 34).admission.methods, [card]);
    assert.equal(competitorOf(payload, 33).basis, 'single-charge');
    assert.deepEqual(orderOf(payload, 35).evidence, [{ class: 'walmart-order-total@1', tender: 0, amountMinor: total }]);
    assert.equal(report.records.noCardFunding, 1);
    assert.equal(report.tenders.byKind['store-balance'], 2);
    assert.equal(report.tenders.byKind.card, 3);
  });

  it('reads admission conservatively: a cancelled group with no flag still makes the order partly cancelled', () => {
    const order = syntheticWalmartOrder(23, [
      syntheticWalmartGroup(1, SYNTHETIC_WALMART_TITLES.widget, 1, 1_000, { seller: null }),
      syntheticWalmartGroup(2, SYNTHETIC_WALMART_TITLES.gadget, 1, 2_000, { seller: null, status: 'CANCELED', statusParts: ['Canceled'] }),
    ]);
    const competitor = competitorOf(convert(syntheticWalmartFolder({ orders: [order] })).payload, 23);
    assert.equal(competitor.admission.partlyCancelled, true);
    assert.equal(competitor.admission.cancelled, false);
    assert.equal(competitor.basis, 'aggregate');
  });

  it('holds the grand-total identity with fees and negative refunds, and the tips identity', () => {
    const order = syntheticWalmartOrder(25, [syntheticWalmartGroup(1, SYNTHETIC_WALMART_TITLES.widget, 1, 10_000, { seller: null })]);
    const total = order.subTotal + order.tax + 499 - 2_500;
    const refunded = {
      ...order, fees: [{ label: 'Delivery', cents: 499 }], refunds: [{ label: 'Refund', cents: -2_500 }], grandTotal: total,
      grandTotalWithTips: total, flags: { refunded: true }, payments: [{ ...order.payments[0], charged: [total] }],
    };
    const { payload } = convert(syntheticWalmartFolder({ orders: [refunded] }));
    const competitor = competitorOf(payload, 25);
    assert.equal(competitor.admission.grossTotalMinor, order.subTotal + order.tax + 499);
    assert.equal(competitor.capMinor, order.subTotal + order.tax + 499);
    assert.deepEqual(payload.held, []);
  });
});
describe('Walmart converter: holds', () => {
  const titles = SYNTHETIC_WALMART_TITLES;
  const eagleGroup = () => syntheticWalmartGroup(1, titles.eagle, 1, 250_000);
  const changed = (seed: number, change: (order: SyntheticWalmartOrder) => SyntheticWalmartOrder) => () => syntheticWalmartFolder(specWith(seed, change));
  /** A folder whose two records of one order (its consolidated record and its raw detail's order) are changed. */
  const edited = (seed: number, change: (records: { listed: Json; raw: Json; folder: SyntheticWalmartFolder }) => void) => () => {
    const folder = fresh();
    change({ ...recordsOf(folder, seed), folder });
    return folder;
  };
  const rawItem = (raw: Json) => at(raw, 'groups_2101', 0, 'items', 0);
  const cases: Array<{ check: WalmartHoldCheck; folder: () => SyntheticWalmartFolder; seed?: number; date?: string | null }> = [
    { check: 'order-key', folder: edited(11, ({ listed }) => { listed.orderId = 'SAMPLE'; }), date: '2030-03-01' },
    { check: 'record-shape', folder: edited(11, ({ listed }) => { at(listed, 'groups', 0, 'items', 0).qty = 'one'; }) },
    { check: 'raw-shape', folder: edited(11, ({ raw }) => { raw.priceDetails = 'none'; }) },
    { check: 'line-id', folder: edited(11, ({ listed, raw }) => { at(listed, 'groups', 0, 'items', 0).lineId = null; rawItem(raw).id = null; }) },
    { check: 'raw-missing', folder: edited(11, ({ folder }) => { folder.rawDetails = folder.rawDetails.filter((detail) => detail.orderId !== syntheticWalmartOrderId(11)); }) },
    { check: 'raw-id', folder: edited(11, ({ raw }) => { raw.id = syntheticWalmartOrderId(99); }) },
    { check: 'raw-disagrees', folder: edited(11, ({ raw }) => { at(raw, 'priceDetails', 'subTotal').displayValue = syntheticWalmartMoneyText(100); }) },
    { check: 'currency', folder: edited(11, ({ listed }) => { at(listed, 'amounts', 'subTotal').currency = 'CAD'; }) },
    { check: 'order-date', date: null, folder: edited(11, ({ listed, raw }) => { listed.orderDate = null; listed.orderDateRaw = null; raw.orderDate = null; }) },
    { check: 'items', folder: changed(11, (order) => ({ ...order, groups: [{ ...eagleGroup(), items: [] }], subTotal: 0, tax: 0, grandTotal: 0 })) },
    { check: 'item-name', folder: edited(11, ({ listed, raw }) => { at(listed, 'groups', 0, 'items', 0).name = null; at(rawItem(raw), 'productInfo').name = null; }) },
    { check: 'subtotal', folder: edited(11, ({ listed, raw }) => { delete at(listed, 'amounts').subTotal; delete at(raw, 'priceDetails').subTotal; }) },
    { check: 'tax', folder: edited(11, ({ listed, raw }) => { delete at(listed, 'amounts').tax; delete at(raw, 'priceDetails').taxTotal; }) },
    { check: 'grand-total', folder: edited(11, ({ listed, raw }) => { delete at(listed, 'amounts').grandTotal; delete at(raw, 'priceDetails').grandTotal; }) },
    { check: 'line-price', folder: changed(11, (order) => ({ ...order, groups: [{ ...eagleGroup(), items: [{ line: 1, name: titles.eagle, qty: 1, lineCents: null }] }] })) },
    { check: 'discounts', folder: changed(11, (order) => ({ ...order, discounts: [{ label: 'Savings', cents: -500 }] })) },
    { check: 'discounts', seed: 14, folder: changed(14, (order) => ({ ...order, discounts: [{ label: 'Savings', cents: -500 }] })) },
    { check: 'donations', folder: changed(11, (order) => ({ ...order, donations: [{ label: 'SAMPLE ROUND UP', cents: 42 }] })) },
    { check: 'driver-tip', folder: changed(11, (order) => ({ ...order, driverTip: 0, grandTotalWithTips: order.grandTotal })) },
    { check: 'charge-history', folder: changed(11, (order) => ({ ...order, chargeHistoryEntries: 2 })) },
    { check: 'tax-negative', folder: changed(11, (order) => ({ ...order, tax: -100, grandTotal: order.subTotal - 100 })) },
    {
      check: 'gross-negative',
      folder: changed(11, (order) => ({ ...order, fees: [{ label: 'Credit', cents: -300_000 }], grandTotal: order.grandTotal - 300_000 })),
    },
    {
      check: 'too-many-lines',
      folder: changed(11, (order) => ({
        ...order,
        groups: [{ ...eagleGroup(), items: Array.from({ length: 501 }, (_, index) => ({ line: index + 1, name: titles.eagle, qty: 1, lineCents: 1 })) }],
        subTotal: 501, tax: 25, grandTotal: 526,
      })),
    },
    { check: 'too-many-methods', folder: changed(11, (order) => ({ ...order, payments: Array.from({ length: 11 }, () => ({ ...order.payments[0], charged: [] })) })) },
    { check: 'tender-negative', folder: changed(11, (order) => ({ ...order, payments: [{ ...order.payments[0], charged: [-100] }] })) },
    {
      check: 'tender-negative',
      seed: 14,
      folder: changed(14, (order) => ({ ...order, payments: [...order.payments, { type: 'GIFTCARD', cardType: null, last4: null, charged: [-100] }] })),
    },
    { check: 'subtotal-identity', folder: changed(11, (order) => ({ ...order, subTotal: order.subTotal + 1, grandTotal: order.grandTotal + 1 })) },
    { check: 'grand-total-identity', folder: changed(11, (order) => ({ ...order, grandTotal: order.grandTotal + 1 })) },
    { check: 'tips-identity', folder: changed(11, (order) => ({ ...order, grandTotalWithTips: order.grandTotal + 1 })) },
    { check: 'group-status', folder: changed(11, (order) => ({ ...order, groups: [{ ...eagleGroup(), status: null, statusParts: undefined }] })) },
    { check: 'group-status', folder: changed(11, (order) => ({ ...order, groups: [{ ...eagleGroup(), status: 'SHIPPED' as never }] })) },
    {
      check: 'refund-without-return',
      folder: changed(11, (order) => ({ ...order, refunds: [{ label: 'Refund', cents: -100 }], grandTotal: order.grandTotal - 100, flags: { refunded: true } })),
    },
    { check: 'refund-without-return', folder: changed(11, (order) => ({ ...order, refundPayments: [{ type: 'CREDITCARD', cardType: 'VISA', last4: '0007', amounts: [100] }] })) },
    { check: 'return-lines-unstated', folder: changed(11, (order) => ({ ...order, flags: { returned: true } })) },
    { check: 'partial-cancel-delivered', folder: changed(11, (order) => ({ ...order, flags: { partlyCancelled: true } })) },
    { check: 'cancel-delivered', folder: changed(11, (order) => ({ ...order, flags: { cancelled: true } })) },
    { check: 'in-store', folder: changed(11, (order) => ({ ...order, isInStore: true })) },
    { check: 'line-quantity', folder: changed(11, (order) => ({ ...order, groups: [{ ...eagleGroup(), items: [{ line: 1, name: titles.eagle, qty: 0, lineCents: 250_000 }] }] })) },
    {
      check: 'line-price-negative',
      folder: changed(11, (order) => ({
        ...order,
        groups: [{ ...eagleGroup(), items: [{ line: 1, name: titles.eagle, qty: 1, lineCents: -100 }, { line: 2, name: titles.widget, qty: 1, lineCents: 1_000 }] }],
        subTotal: 900,
        tax: 0,
        grandTotal: 900,
      })),
    },
  ];

  for (const { check, folder, seed = 11, date = '2030-03-01' } of cases) {
    it(`holds an order for ${check}${seed === 11 ? '' : ' (no metal line)'}, keeping its date`, () => {
      const { payload, report } = convert(folder());
      const key = check === 'order-key' ? null : keyOf(seed);
      const reason = WALMART_HOLD_CHECKS[check];
      assert.deepEqual(payload.held.filter((held) => held.check === check), [{ key, channel: 'online', date, reason, check } satisfies MetalsHeldRecord]);
      assert.ok(!payload.orders.some((order) => order.key === keyOf(seed)));
      assert.ok(!payload.competitors.some((competitor) => competitor.orderKey === keyOf(seed)));
      assert.equal(report.heldByCheck[check], 1);
      assert.ok(report.heldByReason[reason] >= 1);
      assert.equal(report.census.omissions, 0, JSON.stringify(report.census.omissionsByPlace));
    });
  }

  it('keeps an order\'s lifecycle out of its competing: a non-metal order is never held for its statuses', () => {
    const folder = syntheticWalmartFolder(specWith(14, (order) => ({
      ...order,
      groups: [{ ...order.groups[0], status: null, statusParts: undefined }],
      flags: { returned: true, partlyCancelled: true },
    })));
    const { payload } = convert(folder);
    assert.deepEqual(payload.held, []);
    assert.equal(competitorOf(payload, 14).admission.partlyCancelled, true);
  });

  const unread: Array<[string, Partial<SyntheticWalmartGroup>]> = [
    ['outside the closed list', { status: 'SHIPPED' as never, statusParts: ['SAMPLE STATUS'] }],
    ['not stated', { status: null, statusParts: undefined }],
  ];
  for (const [what, status] of unread) {
    it(`competes a non-metal order whose group status is ${what}, as possibly cancelled, never holding it`, () => {
      const folder = syntheticWalmartFolder(specWith(14, (order) => ({ ...order, groups: [{ ...order.groups[0], ...status }] })));
      const { payload, report } = convert(folder);
      assert.deepEqual(payload.held, []);
      const competitor = competitorOf(payload, 14);
      assert.equal(competitor.admission.partlyCancelled, true);
      assert.equal(competitor.admission.cancelled, false);
      assert.equal(competitor.basis, 'aggregate');
      assert.equal(competitor.capMinor, competitor.admission.grossTotalMinor);
      assert.deepEqual(report.admission.qualifying, { metal: 2, other: 0 });
    });
  }

  it('holds a metal order whose group status is outside the closed list in both files, and one whose files disagree on it', () => {
    const both = syntheticWalmartFolder(specWith(11, (order) => ({ ...order, groups: [{ ...order.groups[0], status: 'SHIPPED' as never }] })));
    assert.deepEqual(convert(both).payload.held, [
      { key: keyOf(11), channel: 'online', date: '2030-03-01', reason: 'status-unknown', check: 'group-status' },
    ]);
    const disagreeing = fresh();
    at(recordsOf(disagreeing, 14).raw, 'groups_2101', 0, 'status').statusType = 'SHIPPED';
    assert.deepEqual(convert(disagreeing).payload.held, [
      { key: keyOf(14), channel: 'online', date: '2030-03-01', reason: 'capture-disagreement', check: 'raw-disagrees' },
    ]);
  });

  it('keeps identical repeats of an order as one, and holds repeats that differ', () => {
    const identical = fresh();
    const entries = identical.consolidated.orders as Json[];
    entries.push(structuredClone(recordsOf(identical, 11).listed));
    const kept = convert(identical);
    assert.equal(kept.report.records.duplicates.identical, 1);
    assert.equal(kept.report.records.read, 8);
    assert.ok(kept.payload.orders.some((order) => order.key === keyOf(11)));
    assert.deepEqual(kept.payload.coverage[0], { kind: 'online', from: '2030-03-01', to: '2030-03-31', stated: 7, seen: 7, complete: true },
      'distinct ids: an identical repeat is no disagreement with the list');
    assert.deepEqual([kept.report.census.universe, kept.report.census.metal], [3, 3], 'the census reads a repeated order once');

    const differing = fresh();
    const copy = structuredClone(recordsOf(differing, 11).listed);
    at(copy, 'amounts', 'tax').cents = 1;
    (differing.consolidated.orders as Json[]).push(copy);
    const { payload, report } = convert(differing);
    assert.deepEqual(payload.held, [{ key: keyOf(11), channel: 'online', date: '2030-03-01', reason: 'duplicate-in-capture', check: 'duplicate' }]);
    assert.equal(report.records.duplicates.differing, 1);
    assert.equal(report.records.read, report.records.metal + report.records.flagged + report.records.competitors + report.records.noCardFunding
      + report.records.held + report.records.duplicates.identical + report.records.duplicates.differing);
  });

  it('leaves a held order undated when its repeats disagree on the date, whatever their order', () => {
    const build = (copyFirst: boolean) => {
      const folder = fresh();
      const original = recordsOf(folder, 11).listed;
      const copy = structuredClone(original);
      copy.orderDate = '2030-02-01';
      copy.orderDateRaw = '2030-02-01T10:00:00.000-05:00';
      const orders = folder.consolidated.orders as Json[];
      orders.splice(orders.indexOf(original) + (copyFirst ? 0 : 1), 0, copy);
      return convert(folder);
    };
    const marchFirst = build(false);
    const februaryFirst = build(true);
    assert.deepEqual(marchFirst.payload.held, [
      { key: keyOf(11), channel: 'online', date: null, reason: 'duplicate-in-capture', check: 'duplicate' },
    ]);
    assert.deepEqual({ ...februaryFirst.payload, input: null }, { ...marchFirst.payload, input: null });
    assert.deepEqual(februaryFirst.report, marchFirst.report);
    assert.equal(marchFirst.payload.coverage[0].from, '2030-02-01', 'every date read starts the coverage, not only the kept ones');
    assert.deepEqual(marchFirst.report.dates, { first: '2030-02-01', last: '2030-03-01' });
  });

  it('leaves a held order undated when its raw detail states another date, and counts that date read', () => {
    const folder = fresh();
    recordsOf(folder, 14).raw.orderDate = '2030-02-15T10:00:00.000-05:00';
    const { payload, report } = convert(folder);
    assert.deepEqual(payload.held, [
      { key: keyOf(14), channel: 'online', date: null, reason: 'capture-disagreement', check: 'raw-disagrees' },
    ]);
    assert.equal(payload.coverage[0].from, '2030-02-15');
    assert.equal(report.dates.first, '2030-02-15');
  });

  it('holds a raw detail no order lists, by its own key and date', () => {
    const folder = fresh();
    const other = syntheticWalmartFolder({ orders: [syntheticWalmartOrder(99, [eagleGroup()], { orderDateRaw: '2030-02-20T10:00:00.000-05:00' })] });
    folder.rawDetails.push(other.rawDetails[0]);
    const { payload, report } = convert(folder);
    assert.deepEqual(payload.held, [{ key: keyOf(99), channel: 'online', date: '2030-02-20', reason: 'capture-disagreement', check: 'raw-unlisted' }]);
    assert.deepEqual(report.rawDetails, { read: 8, unlisted: 1 });
    assert.equal(report.records.read, 8);
    // An order only a raw detail shows is read but not listed: the pages don't prove the rows, and it counts as seen.
    assert.deepEqual(payload.coverage, [{ kind: 'online', from: '2030-02-20', to: '2030-03-31', stated: null, seen: 8, complete: false }]);
    assert.equal(report.coverage.gap, 'list-disagrees');
    assert.deepEqual([report.census.heldMetalWordLines, report.census.omissions], [1, 0], 'the census reads an unlisted raw detail too');
  });

  it('holds an order whose raw detail is given twice, differently', () => {
    const folder = fresh();
    const capture = syntheticWalmartCaptureFolder(folder);
    const repeated = structuredClone(folder.rawDetails.find((detail) => detail.orderId === syntheticWalmartOrderId(11))!.json);
    at(repeated, 'order').title = 'SAMPLE ORDER TITLE CHANGED';
    const files = [...capture.files, { path: `raw/detail-${syntheticWalmartOrderId(11)}.json`, bytes: new TextEncoder().encode(JSON.stringify(repeated)) }];
    const { payload } = convertWalmartCapture({ ...capture, files });
    assert.equal(validateMetalsImportPayload(payload).ok, true);
    assert.deepEqual(payload.held.map((held) => [held.key, held.check]), [[keyOf(11), 'raw-repeats']]);
  });
});
describe('Walmart converter: coverage', () => {
  const page = (folder: SyntheticWalmartFolder, index: number) => at(folder.listPages[index].json, 'purchaseHistory');
  const rows = (folder: SyntheticWalmartFolder, index: number) => page(folder, index).orders as Json[];

  it('states the rows read to the pager\'s end, complete when they are the orders read', () => {
    const folder = fresh();
    assert.equal(folder.listPages.length, 2);
    const { payload, report } = convert(folder);
    assert.deepEqual(payload.coverage, [{ kind: 'online', from: '2030-03-01', to: '2030-03-31', stated: 7, seen: 7, complete: true }]);
    assert.deepEqual(report.coverage, { basis: 'rows read to the pager\'s end', gap: null, ranges: payload.coverage });
    assert.equal(report.capture.cursor, 'exhausted');
  });

  const gaps: Array<[WalmartCoverageGap, (folder: SyntheticWalmartFolder) => void]> = [
    ['no-list-pages', (folder) => { folder.listPages = []; }],
    ['pages-not-contiguous', (folder) => { folder.listPages[1].name = 'list-p003.json'; }],
    ['pages-not-contiguous', (folder) => { folder.listPages[0].name = 'list-p0001.json'; }],
    ['page-shape', (folder) => { at(folder.listPages[0].json).ok = false; }],
    ['page-shape', (folder) => { delete at(page(folder, 1), 'pageInfo').nextPageCursor; }],
    ['page-shape', (folder) => { rows(folder, 1)[0].id = 42; }],
    ['cursor-missing', (folder) => { at(page(folder, 0), 'pageInfo').nextPageCursor = null; }],
    ['pager-not-ended', (folder) => { at(page(folder, 1), 'pageInfo').nextPageCursor = 'SAMPLE-NEXT-CURSOR-9'; }],
    ['page-short', (folder) => { rows(folder, 0).pop(); }],
    ['rows-repeat', (folder) => { rows(folder, 1)[0].id = rows(folder, 0)[0].id; }],
    ['provenance-disagrees', (folder) => { at(folder.consolidated, 'provenance', 'list').rowsSeen = 8; }],
    ['provenance-disagrees', (folder) => { at(folder.consolidated, 'provenance', 'list').lastPageHasNext = null; }],
    ['list-disagrees', (folder) => { rows(folder, 1)[0].id = syntheticWalmartOrderId(99); }],
  ];
  for (const [gap, change] of gaps) {
    it(`states nothing when the pages don't prove the pager's end: ${gap}`, () => {
      const folder = fresh();
      change(folder);
      const { payload, report } = convert(folder);
      assert.deepEqual(payload.coverage, [{ kind: 'online', from: '2030-03-01', to: '2030-03-31', stated: null, seen: 7, complete: false }]);
      assert.equal(report.coverage.basis, 'none');
      assert.equal(report.coverage.gap, gap);
    });
  }

  it('takes a total the site states only as a cross-check on a proof that holds', () => {
    const agreeing = fresh();
    at(agreeing.consolidated, 'provenance', 'list').statedTotal = 7;
    const agreed = convert(agreeing);
    assert.equal(agreed.payload.coverage[0].stated, 7);
    assert.equal(agreed.payload.coverage[0].complete, true);
    assert.equal(agreed.report.coverage.basis, 'rows read to the pager\'s end');
    const disagreeing = fresh();
    at(disagreeing.consolidated, 'provenance', 'list').statedTotal = 9;
    const disagreed = convert(disagreeing);
    assert.equal(disagreed.payload.coverage[0].stated, null);
    assert.equal(disagreed.payload.coverage[0].complete, false);
    assert.equal(disagreed.report.coverage.gap, 'site-total-disagrees');
  });

  const unproved: Array<[WalmartCoverageGap, (folder: SyntheticWalmartFolder) => void]> = [
    ['no-list-pages', (folder) => { folder.listPages = []; }],
    ['list-disagrees', (folder) => { rows(folder, 1)[0].id = syntheticWalmartOrderId(99); }],
    ['pager-not-ended', (folder) => { at(page(folder, 1), 'pageInfo').nextPageCursor = 'SAMPLE-NEXT-CURSOR-9'; }],
    ['rows-repeat', (folder) => { rows(folder, 1)[0].id = rows(folder, 0)[0].id; }],
    ['provenance-disagrees', (folder) => { at(folder.consolidated, 'provenance', 'list').pages = 3; }],
  ];
  for (const [gap, change] of unproved) {
    it(`never lets a site total stand in for a failed proof: ${gap}`, () => {
      const folder = fresh();
      change(folder);
      at(folder.consolidated, 'provenance', 'list').statedTotal = 7;
      const { payload, report } = convert(folder);
      assert.deepEqual(payload.coverage, [{ kind: 'online', from: '2030-03-01', to: '2030-03-31', stated: null, seen: 7, complete: false }]);
      assert.equal(report.coverage.basis, 'none');
      assert.equal(report.coverage.gap, gap);
    });
  }

  const ends: Array<[string, string, string]> = [
    ['an evening capture in the US (01:30Z)', '2030-04-10T01:30:00.000Z', '2030-04-08'],
    ['a capture just before every US zone has reached the date (09:59Z)', '2030-04-10T09:59:59.000Z', '2030-04-08'],
    ['a capture once every US zone has reached the date (10:00Z)', '2030-04-10T10:00:00.000Z', '2030-04-09'],
    ['a day capture (15:00Z)', '2030-04-10T15:00:00.000Z', '2030-04-09'],
  ];
  for (const [what, capturedAt, to] of ends) {
    it(`ends before the capture's local day in every US zone: ${what}`, () => {
      const { payload } = convert(syntheticWalmartFolder(syntheticWalmartMetalsSpec(), { capturedAt }));
      assert.equal(payload.coverage[0].from, '2030-03-01');
      assert.equal(payload.coverage[0].to, to);
    });
  }

  it('claims no day of the capture even when every order falls on it', () => {
    const { payload } = convert(syntheticWalmartFolder(syntheticWalmartMetalsSpec(), { capturedAt: '2030-03-01T15:00:00.000Z' }));
    assert.deepEqual(payload.coverage, [{ kind: 'online', from: '2030-02-28', to: '2030-02-28', stated: 7, seen: 7, complete: true }]);
  });
});

describe('Walmart converter: refusals', () => {
  /**
   * The action: converts `capture` and returns null, or what its refusal states (code, place and message). Only a
   * MetalsConvertError is read; every other error is rethrown as it was (kill standard, addendum 3(e) and ruling 8), so
   * the body's assertions never see one.
   */
  const refusalOf = (capture: MetalsCaptureFolder): { code: string; at: string | null; message: string } | null => {
    try {
      convertWalmartCapture(capture);
      return null;
    } catch (error) {
      if (error instanceof MetalsConvertError) return { code: error.code, at: error.at, message: error.message };
      throw error;
    }
  };
  const REFUSAL_MESSAGE = /^[a-z][a-z0-9-]+(?: at [$A-Za-z0-9_.[\]]+)?$/;
  type Refused = [capture: MetalsCaptureFolder, code: string, where: string | null];
  const replaced = (capture: MetalsCaptureFolder, path: string, text: string): MetalsCaptureFolder => ({
    ...capture, files: capture.files.map((file) => (file.path === path ? { path, bytes: new TextEncoder().encode(text) } : file)),
  });

  it('refuses a folder named otherwise, or a snapshot', () => {
    const capture = syntheticWalmartCaptureFolder(fresh());
    const cases: Refused[] = [
      [{ ...capture, folder: 'walmart-0' }, 'folder-mismatch', null],
      [{ ...capture, folder: 'costco' }, 'folder-mismatch', null],
      [{ ...capture, snapshot: 'snap20301108' }, 'folder-mismatch', null],
    ];
    const refusals = cases.map(([folder]) => refusalOf(folder));
    assert.deepEqual(refusals.map((refusal) => refusal && [refusal.code, refusal.at]), cases.map(([, code, where]) => [code, where]));
    for (const refusal of refusals) assert.match(refusal?.message ?? '', REFUSAL_MESSAGE);
    assert.equal(refusalOf({ ...capture, folder: 'walmart-2' }), null, 'walmart-2 is an account folder');
  });

  it('refuses another schema or currency, a file that is not JSON, and files it does not know', () => {
    const schema = fresh();
    at(schema.consolidated).schema = 'holdr-retail-capture/walmart@2';
    const currency = fresh();
    at(currency.consolidated, 'provenance').currency = 'CAD';
    const capture = syntheticWalmartCaptureFolder(fresh());
    const cases: Refused[] = [
      [syntheticWalmartCaptureFolder(schema), 'schema-unsupported', null],
      [syntheticWalmartCaptureFolder(currency), 'currency-unsupported', null],
      [replaced(capture, 'walmart.json', '{ not json'), 'capture-unreadable', null],
      [replaced(capture, `raw/detail-${syntheticWalmartOrderId(11)}.json`, '{ not json'), 'capture-unreadable', 'raw'],
      [replaced(capture, 'raw/list-p001.json', '{ not json'), 'capture-unreadable', 'raw'],
      [{ ...capture, files: [...capture.files, { path: 'raw/other.json', bytes: new Uint8Array() }] }, 'capture-unreadable', 'files'],
      [{ ...capture, files: capture.files.filter((file) => file.path !== 'walmart.json') }, 'capture-unreadable', 'files'],
    ];
    const refusals = cases.map(([folder]) => refusalOf(folder));
    assert.deepEqual(refusals.map((refusal) => refusal && [refusal.code, refusal.at]), cases.map(([, code, where]) => [code, where]));
    for (const refusal of refusals) assert.match(refusal?.message ?? '', REFUSAL_MESSAGE);
  });

  it('refuses a consolidated file whose header or order list doesn\'t read, by its structural path', () => {
    const noTime = fresh();
    delete at(noTime.consolidated, 'provenance').capturedAt;
    const noList = fresh();
    noList.consolidated.orders = {};
    const cases: Refused[] = [
      [syntheticWalmartCaptureFolder(noTime), 'capture-unreadable', '$.provenance.capturedAt'],
      [syntheticWalmartCaptureFolder(noList), 'capture-unreadable', '$.orders'],
    ];
    const refusals = cases.map(([folder]) => refusalOf(folder));
    assert.deepEqual(refusals.map((refusal) => refusal && [refusal.code, refusal.at]), cases.map(([, code, where]) => [code, where]));
    for (const refusal of refusals) assert.match(refusal?.message ?? '', REFUSAL_MESSAGE);
  });
});

describe('Walmart converter: value-free and deterministic', () => {
  /** Every string a report holds. */
  function strings(value: unknown, found: string[] = []): string[] {
    if (typeof value === 'string') found.push(value);
    else if (Array.isArray(value)) value.forEach((entry) => strings(entry, found));
    else if (value !== null && typeof value === 'object') Object.values(value).forEach((entry) => strings(entry, found));
    return found;
  }

  it('reports counts, closed codes, dates and digests only', () => {
    const { report } = convert(fresh());
    const text = JSON.stringify(report);
    for (const value of syntheticWalmartMetalsSensitiveValues()) assert.ok(!text.includes(value), `the report shows ${value}`);
    const allowed = new Set<string>([
      METALS_CONVERTER, 'walmart', 'online', METALS_CAPTURE_SCHEMAS.walmart, ...Object.values(METALS_RULES), 'rows read to the pager\'s end', 'exhausted',
    ]);
    for (const value of strings(report)) {
      assert.ok(allowed.has(value) || /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}\.\d{3}Z)?$/.test(value), `the report holds an unexpected string: ${value.length} characters`);
    }
  });

  it('drops names, tracking, native numbers, cursors and gift-card endings from the payload', () => {
    const { json, payload } = convert(fresh());
    for (const value of [
      ...[11, 12, 13, 14, 15, 16, 17].map((seed) => syntheticWalmartOrderId(seed)), 'SAMPLESELLERID', 'SAMPLEOFFER', 'SAMPLE ORDER TITLE',
      'SAMPLE PAYMENT MESSAGE', 'SAMPLE DELIVERY MESSAGE', 'SAMPLE-NEXT-CURSOR', 'Delivered on', 'Picked up', 'Ending in',
    ]) assert.ok(!json.includes(value), `the payload shows ${value}`);
    const tenders = [...payload.orders.map((order) => order.admission!.methods), ...payload.competitors.map((competitor) => competitor.admission.methods)].flat();
    assert.ok(tenders.filter((tender) => tender.kind !== 'card').every((tender) => tender.last4 === null));
  });

  it('writes the same bytes for the same capture, whatever order its files and orders come in', () => {
    const capture = syntheticWalmartCaptureFolder(fresh());
    const once = convertWalmartCapture(capture).json;
    assert.equal(convertWalmartCapture({ ...capture, files: [...capture.files].reverse() }).json, once);
    const reordered = fresh();
    (reordered.consolidated.orders as Json[]).reverse();
    const again = convertWalmartCapture(syntheticWalmartCaptureFolder(reordered)).payload;
    const first = convertWalmartCapture(capture).payload;
    assert.deepEqual({ ...again, input: null }, { ...first, input: null });
  });

  it('is walmart\'s entry in the CLI registry', () => {
    assert.equal(walmartCaptureConverter.input, 'capture-folder');
    assert.equal(walmartCaptureConverter.source, 'walmart');
    assert.equal(walmartCaptureConverter.convert, convertWalmartCapture);
    for (const name of ['walmart', 'walmart-2', 'walmart-12']) assert.ok(walmartCaptureConverter.folder.test(name), name);
    for (const name of ['walmart-0', 'Walmart', 'walmart-1000', 'costco', 'walmart2']) assert.ok(!walmartCaptureConverter.folder.test(name), name);
    const names = syntheticWalmartFiles(fresh()).map((file) => file.path);
    for (const name of names) {
      const [dir, base] = name.includes('/') ? name.split('/') : ['', name];
      assert.ok(walmartCaptureConverter.files.some((files) => files.dir === dir && files.name.test(base)), name);
    }
  });
});
describe('Walmart converter: generated accounts', () => {
  /** A small seeded generator (mulberry32), so any failure reproduces from its seed. */
  function generator(seed: number) {
    let state = seed >>> 0;
    const next = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let mixed = state;
      mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
    };
    const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
    const pick = <T>(values: readonly T[]): T => values[int(0, values.length - 1)];
    return { next, int, pick };
  }

  const NAMES = [
    ...Object.values(SYNTHETIC_WALMART_TITLES),
    'Sample Mint 10 g Gold Bar GROSS 999.9',
    'Gold and Silver Sample Bar 1 oz',
    'Sample Refinery 1/10 oz Gold Bar',
    // Metal guard v1: a refused name with bullion evidence (flagged), and one with none (drift).
    'SAMPLE Gold Bar Candy',
    'SAMPLE Gold Star Membership',
  ];
  const SELLERS = [SYNTHETIC_WALMART_BULLION_SELLER, SYNTHETIC_WALMART_NUMBERED_SELLER];

  function generatedSpec(seed: number, count: number): SyntheticWalmartSpec {
    const random = generator(seed);
    const orders: SyntheticWalmartOrder[] = [];
    for (let index = 0; index < count; index += 1) {
      const groups = Array.from({ length: random.int(1, 3) }, (_, group) => {
        const status = random.pick(['DELIVERED', 'DELIVERED', 'PICKED_UP', 'CANCELED', null] as const);
        return syntheticWalmartGroup(group + 1, random.pick(NAMES), random.int(1, 3), random.int(1, 500_000), {
          status,
          statusParts: status === null ? undefined : ['SAMPLE STATUS'],
          eventDate: random.pick(['2030-03-05', '2030-02-20', null]),
          deliveryDate: status === 'DELIVERED' ? random.pick(['2030-03-06', null]) : null,
          seller: random.next() < 0.5 ? null : { id: 'SAMPLESELLERID', name: random.pick(SELLERS), isPro: true, shown: true, shippedByWalmart: false },
        });
      });
      const base = syntheticWalmartOrder(100 + index, groups);
      const fees = random.next() < 0.3 ? [{ label: 'Shipping', cents: random.int(0, 999) }] : [];
      const refunds = random.next() < 0.2 ? [{ label: 'Refund', cents: -random.int(1, 999) }] : [];
      const total = base.subTotal + base.tax + fees.reduce((sum, fee) => sum + fee.cents, 0) + refunds.reduce((sum, refund) => sum + refund.cents, 0);
      const card = { type: 'CREDITCARD' as const, cardType: random.pick(['VISA', 'AMEX', 'WMCREDIT']), last4: '0007' };
      const payments = random.pick([
        [{ ...card, charged: [total] }],
        [{ ...card, charged: [] }],
        [{ ...card, charged: [total - 100] }, { type: 'GIFTCARD' as const, cardType: null, last4: '0011', charged: [100] }],
        [{ type: 'PAYPAL' as const, cardType: 'PAYPAL', last4: null, charged: [total] }],
        [{ type: 'CLOSEDLOOP' as const, cardType: null, last4: null, charged: [total] }],
      ]);
      orders.push({
        ...base,
        fees,
        refunds,
        grandTotal: total + (random.next() < 0.05 ? 1 : 0),
        payments,
        flags: {
          refunded: refunds.length > 0 && random.next() < 0.8,
          partlyCancelled: random.next() < 0.1,
          cancelled: random.next() < 0.05,
          returned: random.next() < 0.05,
        },
      });
    }
    return { orders };
  }

  for (const seed of [1, 2, 3, 4, 5]) {
    it(`converts a generated account (seed ${seed}): every payload validates, every order lands once`, () => {
      const spec = generatedSpec(seed, 40);
      const { payload, report } = convert(syntheticWalmartFolder(spec));
      const placed = [
        ...payload.orders.map((order) => order.key),
        ...payload.competitors.map((competitor) => competitor.orderKey),
        ...payload.held.map((held) => held.key),
      ];
      assert.equal(new Set(placed).size, placed.length);
      assert.ok(placed.every((key) => key !== null && spec.orders.some((order) => keyOf(order.seed) === key)));
      const { records } = report;
      assert.equal(records.read, 40);
      assert.equal(records.read, records.metal + records.flagged + records.competitors + records.noCardFunding + records.held
        + records.duplicates.identical + records.duplicates.differing);
      const { census } = report;
      assert.equal(census.omissions, 0, JSON.stringify(census.omissionsByPlace));
      assert.equal(census.universe, census.heldMetalWordLines + census.metal + census.flagged + census.drift);
      assert.equal(census.flagged, report.lines.flagged);
      assert.ok(payload.orders.every((order) => order.evidence.length === 0 || order.lines.every((line) => line.metalUncertain === null)));
      assert.equal(report.coverage.basis, 'rows read to the pager\'s end');
      assert.deepEqual(payload.coverage[0], { kind: 'online', from: '2030-03-01', to: '2030-03-31', stated: 40, seen: 40, complete: true });
      for (const order of payload.orders) {
        assert.ok(order.lines.length > 0);
        assert.deepEqual(order.refunds, [], 'a refunded metal order is held');
        if (order.evidence.length > 0) {
          assert.equal(order.admission!.methods.length, 1);
          assert.equal(order.admission!.methods[0].kind, 'card');
          assert.deepEqual(order.admission!.fulfilment, { shipments: 1 });
        }
        for (const line of order.lines) {
          assert.equal(line.events.length, 1);
          assert.ok(line.events[0].date === null || line.events[0].date >= order.date);
          assert.ok(line.seller === null || line.seller === SYNTHETIC_WALMART_BULLION_SELLER || /^seller-[a-p]{8}$/.test(line.seller));
          if (line.events[0].kind === 'cancelled') {
            assert.deepEqual([line.amountMinor, line.directMinor, line.allocated, line.costMinor], [0, 0, [], 0], 'a cancelled lot costs 0, no tax or fee attributed');
          }
        }
      }
      const lines = payload.orders.flatMap((order) => order.lines);
      const cancelled = (line: MetalsLine) => line.events[0].kind === 'cancelled';
      assert.equal(report.cost.incompleteLines, lines.filter((line) => !line.complete).length);
      assert.deepEqual(report.cost.cancelledLots, {
        lots: lines.filter(cancelled).length,
        incomplete: lines.filter((line) => cancelled(line) && !line.complete).length,
        incompleteOrders: payload.orders.filter((order) => order.lines.some((line) => cancelled(line) && !line.complete)).length,
      });
      for (const competitor of payload.competitors) {
        const { methods, grossTotalMinor } = competitor.admission;
        assert.ok(methods.some((method) => method.kind === 'card'));
        assert.ok(methods.every((method) => method.amountMinor === null || method.amountMinor >= 0), 'a negative method holds its order');
        const contradictory = methods.some((method) => method.kind === 'card' && method.amountMinor !== null && method.amountMinor > grossTotalMinor!);
        if (competitor.basis === 'aggregate') assert.equal(competitor.capMinor, contradictory ? null : grossTotalMinor);
      }
    });
  }
});

describe('Walmart converter: a metal order whatever its funding', () => {
  it('is a lot, never skipped: gift card only, PayPal only, or no method at all', () => {
    const eagle = (seed: number) => syntheticWalmartOrder(seed, [syntheticWalmartGroup(1, SYNTHETIC_WALMART_TITLES.eagle, 1, 250_000)]);
    const giftCard = eagle(51);
    const payPal = eagle(52);
    const spec = {
      orders: [
        { ...giftCard, payments: [{ type: 'GIFTCARD' as const, cardType: null, last4: '0011', charged: [giftCard.grandTotal] }] },
        { ...payPal, payments: [{ type: 'PAYPAL' as const, cardType: 'PAYPAL', last4: null, charged: [payPal.grandTotal] }] },
        { ...eagle(53), payments: [] },
      ],
    };
    const { payload, report } = convert(syntheticWalmartFolder(spec));
    assert.deepEqual([51, 52, 53].map((seed) => orderOf(payload, seed).admission!.methods.map((method) => method.kind)), [
      ['gift-card'], ['paypal'], [],
    ]);
    assert.ok(payload.orders.every((order) => order.evidence.length === 0 && order.lines.length === 1));
    assert.equal(report.records.noCardFunding, 0);
    assert.deepEqual(payload.competitors, []);
    assert.deepEqual(payload.held, []);
  });
});

describe('Walmart converter: an empty rfpDate', () => {
  it('reads as no ready-for-pickup date, so a pickup order whose raw detail writes one converts', () => {
    const folder = fresh();
    at(recordsOf(folder, 13).raw, 'groups_2101', 0).rfpDate = '';
    const { payload } = convert(folder);
    assert.deepEqual(payload.held, []);
    assert.equal(orderOf(payload, 13).lines.length, 1);
  });
});

describe('Walmart converter: cancelled groups and the subtotal', () => {
  const titles = SYNTHETIC_WALMART_TITLES;
  const cancelledGroup = (line: number, title: string, cents: number) => syntheticWalmartGroup(line, title, 1, cents, {
    seller: null, status: 'CANCELED', statusParts: ['Canceled'], eventDate: '2030-03-02', deliveryDate: null,
  });

  it('leaves a cancelled group\'s lines out of the subtotal, to the cent, and puts them in the skeleton at amount 0', () => {
    const order = syntheticWalmartOrder(71, [syntheticWalmartGroup(1, titles.eagle, 1, 250_000), cancelledGroup(2, titles.widget, 1_000)]);
    assert.equal(order.subTotal, 250_000, 'the fixture states the subtotal as Walmart does');
    const { payload } = convert(syntheticWalmartFolder({ orders: [order] }));
    const converted = orderOf(payload, 71);
    assert.deepEqual(converted.skeleton.map((line) => [line.kind, line.amountMinor, line.metal]), [['item', 250_000, true], ['item', 0, false]]);
    assert.equal(converted.fullPriceMinor, 250_000 + order.tax);
    assert.equal(converted.admission!.grossTotalMinor, 250_000 + order.tax);
    assert.equal(converted.admission!.partlyCancelled, true);
    assert.deepEqual(converted.lines.map((line) => [line.amountMinor, line.costMinor, line.complete]), [[250_000, 250_000 + order.tax, true]]);
  });

  it('holds an order whose subtotal includes a cancelled group\'s lines', () => {
    const order = syntheticWalmartOrder(72, [syntheticWalmartGroup(1, titles.widget, 1, 1_000, { seller: null }), cancelledGroup(2, titles.gadget, 2_000)]);
    const total = 3_000 + order.tax;
    const including = { ...order, subTotal: 3_000, grandTotal: total, payments: [{ ...order.payments[0], charged: [total] }] };
    const { payload } = convert(syntheticWalmartFolder({ orders: [including] }));
    assert.deepEqual(payload.held.map((held) => [held.key, held.check]), [[keyOf(72), 'subtotal-identity']]);
  });

  it('keeps a cancelled metal line as a cancelled lot at amount and cost 0, complete when another line of positive price carries the tax', () => {
    const order = syntheticWalmartOrder(73, [syntheticWalmartGroup(1, titles.widget, 1, 1_000, { seller: null }), cancelledGroup(2, titles.eagle, 250_000)]);
    const { payload, report } = convert(syntheticWalmartFolder({ orders: [order] }));
    const [lot] = orderOf(payload, 73).lines;
    const { amountMinor, directMinor, allocated, costMinor, complete, events } = lot;
    assert.deepEqual({ amountMinor, directMinor, allocated, costMinor, complete, events }, {
      amountMinor: 0, directMinor: 0, allocated: [], costMinor: 0, complete: true,
      events: [{ kind: 'cancelled', date: '2030-03-02', dateBasis: 'year-inferred', quantity: 1, occurrence: 1 }],
    });
    assert.deepEqual(report.cost, {
      unattributedOrders: { 'mixed-metal': 0, 'no-positive-base': 0, 'tax-flags-partial': 0 },
      incompleteLines: 0,
      cancelledLots: { lots: 1, incomplete: 0, incompleteOrders: 0 },
    });
  });

  it('never lets the tax or a fee reach an amount-0 line', () => {
    const base = syntheticWalmartOrder(74, [syntheticWalmartGroup(1, titles.eagle, 1, 250_000), cancelledGroup(2, titles.fineBar, 400_000)]);
    const total = base.subTotal + base.tax + 599;
    const order = { ...base, fees: [{ label: 'Delivery', cents: 599 }], grandTotal: total, payments: [{ ...base.payments[0], charged: [total] }] };
    const { payload, report } = convert(syntheticWalmartFolder({ orders: [order] }));
    const converted = orderOf(payload, 74);
    assert.equal(converted.unattributedMinor, 0);
    assert.deepEqual(converted.lines.map((line) => [line.amountMinor, line.allocated, line.costMinor, line.complete]), [
      [250_000, [{ component: 'fee@2', amountMinor: 599 }, { component: 'tax', amountMinor: base.tax }], total, true],
      [0, [], 0, true],
    ]);
    assert.deepEqual(report.cost.cancelledLots, { lots: 1, incomplete: 0, incompleteOrders: 0 });
  });

  it('leaves a fee no line of positive price can carry unattributed: the cancelled lot costs 0 and is incomplete', () => {
    const withFee = (order: SyntheticWalmartOrder): SyntheticWalmartOrder => ({
      ...order, fees: [{ label: 'Delivery', cents: 599 }], grandTotal: 599, payments: [{ ...order.payments[0], charged: [599] }],
    });
    // Only a cancelled metal line; and the same beside a delivered line priced 0.
    const alone = withFee(syntheticWalmartOrder(75, [cancelledGroup(1, titles.eagle, 250_000)]));
    const besideFree = withFee(syntheticWalmartOrder(76, [syntheticWalmartGroup(1, titles.widget, 1, 0, { seller: null }), cancelledGroup(2, titles.eagle, 250_000)]));
    assert.deepEqual([alone.subTotal, alone.tax, besideFree.subTotal, besideFree.tax], [0, 0, 0, 0]);
    const { payload, report } = convert(syntheticWalmartFolder({ orders: [alone, besideFree] }));
    for (const [seed, skeleton] of [
      [75, [['item', 0, true], ['fee', 599, false]]],
      [76, [['item', 0, false], ['item', 0, true], ['fee', 599, false]]],
    ] as const) {
      const converted = orderOf(payload, seed);
      assert.deepEqual(converted.skeleton.map((line) => [line.kind, line.amountMinor, line.metal]), skeleton);
      // The fee stays unattributed, and no cent is lost: Σ direct + Σ attributed + unattributed = the full price.
      assert.equal(converted.unattributedMinor, 599);
      assert.equal(converted.fullPriceMinor, 599);
      assert.equal(converted.admission!.grossTotalMinor, 599);
      const [lot] = converted.lines;
      const { amountMinor, directMinor, allocated, costMinor, complete } = lot;
      assert.deepEqual({ amountMinor, directMinor, allocated, costMinor, complete }, {
        amountMinor: 0, directMinor: 0, allocated: [], costMinor: 0, complete: false,
      });
      assert.equal(lot.events[0].kind, 'cancelled');
      const attributed = converted.lines.reduce((total, line) => total + line.directMinor + line.allocated.reduce((sum, share) => sum + share.amountMinor, 0), 0);
      assert.equal(attributed + converted.unattributedMinor, converted.fullPriceMinor);
    }
    assert.deepEqual(payload.held, []);
    assert.deepEqual(report.cost, {
      unattributedOrders: { 'mixed-metal': 0, 'no-positive-base': 2, 'tax-flags-partial': 0 },
      incompleteLines: 2,
      cancelledLots: { lots: 2, incomplete: 2, incompleteOrders: 2 },
    });
  });
});

describe('Walmart converter: diagnostics', () => {
  const metalLines = (orders: number, delivered = orders, cancelled = 0, other = 0, titleUnread = 0) => ({ orders, delivered, cancelled, other, titleUnread });

  it('reconciles the metal-reading lines by group status over every order and per outcome, and sorts skips by tender kinds', () => {
    const spec = specWith(17, (order) => order);
    const giftCardOnly = syntheticWalmartOrder(18, [syntheticWalmartGroup(1, SYNTHETIC_WALMART_TITLES.gadget, 1, 700, { seller: null })]);
    spec.orders.push(
      { ...giftCardOnly, payments: [{ type: 'GIFTCARD', cardType: null, last4: null, charged: [giftCardOnly.grandTotal] }] },
      { ...syntheticWalmartOrder(19, [syntheticWalmartGroup(1, SYNTHETIC_WALMART_TITLES.gadget, 1, 700, { seller: null })]), payments: [] },
    );
    const { report } = convert(syntheticWalmartFolder(spec));
    const { diagnostics } = report;
    assert.deepEqual(diagnostics.metalLines.all, metalLines(3));
    assert.deepEqual(diagnostics.metalLines.byOutcome, { converted: metalLines(3), competitor: metalLines(0), skipped: metalLines(0) });
    assert.deepEqual(diagnostics.skipped, { withMetalNames: 0, byTenderKinds: { paypal: 1, 'gift-card': 1, none: 1 } });
    assert.deepEqual(diagnostics.held, {});
    assert.deepEqual(diagnostics.readerIssues, {});
  });

  it('counts each refused raw detail by its first issue\'s value-free pattern and level, with the held facts', () => {
    const folder = fresh();
    recordsOf(folder, 11).raw.priceDetails = 'none';
    at(recordsOf(folder, 14).raw, 'groups_2101', 0, 'items', 0).quantity = 2.5;
    const { payload, report } = convert(folder);
    const { diagnostics } = report;
    assert.deepEqual(payload.held.map((held) => held.check), ['raw-shape', 'raw-shape']);
    assert.deepEqual(diagnostics.readerIssues, {
      '$.order.priceDetails: must be an object': 1,
      '$.order.groups[*].items[*].quantity: must be an integer from 0 to 1000000': 1,
    });
    assert.deepEqual(diagnostics.readerIssueLevels, { item: 1, group: 0, order: 1 });
    assert.deepEqual(diagnostics.metalLines.byOutcome['held:raw-shape'], metalLines(1));
    assert.deepEqual(diagnostics.held['raw-shape'], {
      orders: 2, withCard: 2, allNonMetalTitles: 1, nonMetalSoundGrandTotal: 1, nonMetalSoundWithCard: 1, dated: 2, fullPriceKnown: 2,
    });
  });

  it('reads a held order\'s titles from its raw detail when its record can\'t be read, else counts it unread', () => {
    const folder = fresh();
    recordsOf(folder, 11).listed.groups = 'none';
    recordsOf(folder, 12).listed.groups = 'none';
    recordsOf(folder, 12).raw.groups_2101 = 'none';
    const { report } = convert(folder);
    const { diagnostics } = report;
    assert.deepEqual(diagnostics.metalLines.byOutcome['held:record-shape'], metalLines(1, 1, 0, 0, 1));
    assert.deepEqual(diagnostics.readerIssues, { '$.orders[*].groups: must be an array': 2 });
    assert.deepEqual(diagnostics.held['record-shape'], {
      orders: 2, withCard: 0, allNonMetalTitles: 0, nonMetalSoundGrandTotal: 0, nonMetalSoundWithCard: 0, dated: 2, fullPriceKnown: 0,
    });
    assert.deepEqual(diagnostics.metalLines.all, metalLines(2, 2, 0, 0, 1));
    assert.equal(report.census.heldMetalWordLines, 1, 'the census reads 11\'s lines from its raw detail, and none of 12\'s');
  });

  it('counts the shapes of orders held for the subtotal identity, metal and not apart', () => {
    const titles = SYNTHETIC_WALMART_TITLES;
    const cancelled = syntheticWalmartOrder(41, [
      syntheticWalmartGroup(1, titles.eagle, 1, 250_000),
      syntheticWalmartGroup(2, titles.widget, 1, 1_000, { seller: null, status: 'CANCELED', statusParts: ['Canceled'], deliveryDate: null }),
    ], { flags: { partlyCancelled: true } });
    const perUnit = syntheticWalmartOrder(42, [syntheticWalmartGroup(1, titles.widget, 2, 5_000, { seller: null })]);
    const spec = {
      orders: [
        // A subtotal that includes the cancelled group's line.
        { ...cancelled, subTotal: 251_000, grandTotal: 251_000 + cancelled.tax },
        { ...perUnit, subTotal: 10_000, grandTotal: 10_000 + perUnit.tax },
      ],
    };
    const { payload, report } = convert(syntheticWalmartFolder(spec));
    const { diagnostics } = report;
    assert.deepEqual(payload.held.map((held) => held.check), ['subtotal-identity', 'subtotal-identity']);
    assert.deepEqual(diagnostics.subtotal.metal, {
      held: 1, linesAbove: 0, linesBelow: 1, withCancelledGroup: 1, withQuantityAboveOne: 0, withZeroPricedLine: 0,
      allLinesExplain: 1, unitPricesExplain: 0, neitherExplains: 0, oneLineExplains: 1, oneFeeExplains: 0, oneOtherFieldExplains: 0,
    });
    assert.deepEqual(diagnostics.subtotal.other, {
      held: 1, linesAbove: 0, linesBelow: 1, withCancelledGroup: 0, withQuantityAboveOne: 1, withZeroPricedLine: 0,
      allLinesExplain: 0, unitPricesExplain: 1, neitherExplains: 0, oneLineExplains: 1, oneFeeExplains: 0, oneOtherFieldExplains: 0,
    });
    assert.deepEqual(diagnostics.held['subtotal-identity'], {
      orders: 2, withCard: 2, allNonMetalTitles: 1, nonMetalSoundGrandTotal: 1, nonMetalSoundWithCard: 1, dated: 2, fullPriceKnown: 2,
    });
    assert.deepEqual(diagnostics.metalLines.byOutcome['held:subtotal-identity'], metalLines(1));
  });

  it('counts a difference that one stated fee, or one other price field of the raw detail, explains', () => {
    const titles = SYNTHETIC_WALMART_TITLES;
    const fee = syntheticWalmartOrder(43, [syntheticWalmartGroup(1, titles.widget, 1, 1_000, { seller: null })]);
    const savings = syntheticWalmartOrder(44, [syntheticWalmartGroup(1, titles.gadget, 1, 2_000, { seller: null })]);
    const spec = {
      orders: [
        { ...fee, subTotal: 1_599, fees: [{ label: 'Delivery', cents: 599 }], grandTotal: 1_599 + fee.tax + 599 },
        { ...savings, subTotal: 1_700, grandTotal: 1_700 + savings.tax },
      ],
    };
    const folder = syntheticWalmartFolder(spec);
    recordsOf(folder, 44).raw.priceDetails = { ...(recordsOf(folder, 44).raw.priceDetails as Json), savings: { displayValue: '-$3.00', value: -3 } };
    const { report } = convert(folder);
    assert.deepEqual(report.diagnostics.subtotal.other, {
      held: 2, linesAbove: 1, linesBelow: 1, withCancelledGroup: 0, withQuantityAboveOne: 0, withZeroPricedLine: 0,
      allLinesExplain: 0, unitPricesExplain: 0, neitherExplains: 2, oneLineExplains: 0, oneFeeExplains: 1, oneOtherFieldExplains: 1,
    });
  });

  it('counts refused metal-word lines by clause, what a fail-closed guard would hold, and tokens with no metal word', () => {
    const one = (seed: number, title: string) => syntheticWalmartOrder(seed, [syntheticWalmartGroup(1, title, 1, 1_000, { seller: null })]);
    const spec = {
      orders: [
        one(61, 'SAMPLE 1 oz Gold Bar in Assay Card'),
        one(62, 'SAMPLE 14K Gold Chain'),
        syntheticWalmartOrder(63, [
          syntheticWalmartGroup(1, SYNTHETIC_WALMART_TITLES.eagle, 1, 250_000),
          syntheticWalmartGroup(2, 'SAMPLE Gold American Eagle', 1, 0, { seller: null, status: 'CANCELED', statusParts: ['Canceled'], deliveryDate: null }),
        ]),
        one(64, 'SAMPLE Maple Leaf 1 ozt .9999'),
        one(65, 'SAMPLE Gold Leaf Frame'),
        one(66, 'SAMPLE Gold Bar'),
        one(67, 'SAMPLE GOLD WIDGET 16 oz'),
        // Title rule v3 (retail policy 5): CARD right after ASSAY, as the last word, beside a bullion form is no near-miss,
        // so 61 converts. 68's CARD is not the last word: still refused, so the CARD clause stays covered.
        one(68, 'SAMPLE 1 oz Gold Bar in Assay Card Holder'),
      ],
    };
    const folder = syntheticWalmartFolder(spec);
    // The synthetic capture's own flags call every item metal; for these two orders they don't.
    for (const seed of [62, 67]) at(recordsOf(folder, seed).listed, 'groups', 0, 'items', 0).isPreciousMetal = false;
    const { report } = convert(folder);
    // Metal guard v1 keeps 62 (purity), 66 (adjacency) and 68 (bullion word, shape with weight, adjacency) as flagged
    // orders; 64 names no metal, and 65 and 67 show no bullion evidence (drift), so they still compete.
    assert.equal(report.records.metal, 2);
    assert.equal(report.records.flagged, 3);
    assert.equal(report.records.competitors, 3);
    assert.deepEqual([report.census.metal, report.census.flagged, report.census.drift, report.census.omissions], [2, 3, 3, 0]);
    const { titleRefusals, titleGuard, tokensWithoutMetalWord } = report.diagnostics;
    const status = (delivered: number, cancelled = 0) => ({ delivered, cancelled, other: 0 });
    const guard = (orders: number) => ({ orders, lines: status(orders) });
    assert.deepEqual(titleRefusals, {
      orders: 6,
      all: status(5, 1),
      byOutcome: { competitor: status(2), converted: status(3, 1) },
      byClause: {
        'near-miss:CARD': status(1), 'near-miss:CHAIN': status(1), 'design-not-after-metal': status(0, 1), leaf: status(1),
        'shape-without-weight': status(1), 'no-form-word': status(1),
      },
    });
    assert.deepEqual(titleGuard, {
      ...guard(3), byOutcome: { converted: guard(2), competitor: guard(1) }, byOrderFlag: { metal: guard(1), none: guard(2), unread: guard(0) },
    });
    assert.deepEqual(tokensWithoutMetalWord, { ...guard(1), byItemFlag: { metal: guard(1), none: guard(0), unread: guard(0) } });
  });

  it('reads tokens and refusal clauses as closed shapes, never the title rule\'s answer', () => {
    assert.deepEqual(walmartBullionTokens('SAMPLE 2 Troy Ounce 24 kt 999.9'), { weight: true, troyWeight: true, fineness: true, karat: true });
    assert.deepEqual(walmartBullionTokens('SAMPLE 2 x 16oz'), { weight: true, troyWeight: false, fineness: false, karat: false });
    assert.deepEqual(walmartBullionTokens('SAMPLE $999 MODEL 5000K'), { weight: false, troyWeight: false, fineness: false, karat: false });
    assert.equal(walmartBullionTokens('SAMPLE 14K Ring').karat, true);
    assert.equal(walmartBullionTokens('SAMPLE MODEL X4K Cable').karat, false, 'a letter glued before the digits is a model code');
    assert.equal(walmartBullionTokens('SAMPLE 1,999 Pieces').fineness, false, 'a number after a comma is no fineness');
    assert.equal(walmartTitleRefusal('SAMPLE WIDGET 1 oz'), null, 'no metal word, no clause');
    assert.equal(walmartTitleRefusal('SAMPLE Gold-Tone Card'), 'near-miss:TONE', 'the first near-miss word');
  });
});

describe('Walmart converter: metal guard v1', () => {
  const titles = SYNTHETIC_WALMART_TITLES;
  /** One synthetic title per kind of bullion evidence: each refused by the title rule and flagged on that kind alone. */
  const ONE_EVIDENCE: Readonly<Record<RetailMetalGuardEvidence, string>> = {
    'bullion-word': 'SAMPLE Gold Assay Card Holder',
    'design-after-metal': 'SAMPLE Gold Eagle Candy',
    'shape-with-weight': 'SAMPLE Gold Chocolate Coin 1.5 oz',
    'troy-or-metric-weight': 'SAMPLE Gold Foil 1 ozt',
    purity: 'SAMPLE Gold Plated .9999 Fine',
    adjacency: 'SAMPLE Gold Bar Candy',
  };
  /** A confident metal line through the rule's coin-design path alone: no weight, no shape word, no bullion word. */
  const DESIGN_ONLY = 'SAMPLE Gold Eagle';
  /** An order of one delivered group per title (lines 1, 2, …), paid in full by one card. */
  const titled = (seed: number, names: readonly string[]) =>
    syntheticWalmartOrder(seed, names.map((name, index) => syntheticWalmartGroup(index + 1, name, 1, 10_000, { seller: null })));
  /** An order of one delivered group holding every title (lines 1, 2, …), paid in full by one card. */
  const oneGroup = (seed: number, names: readonly string[]) => syntheticWalmartOrder(seed, [syntheticWalmartGroup(1, names[0], 1, 10_000, {
    seller: null, items: names.map((name, index) => ({ line: index + 1, name, qty: 1, lineCents: 10_000 })),
  })]);
  const payPal = (order: SyntheticWalmartOrder): SyntheticWalmartOrder =>
    ({ ...order, payments: [{ type: 'PAYPAL', cardType: 'PAYPAL', last4: null, charged: [order.grandTotal] }] });
  /** The metals spec's seven orders, and these. */
  const folderOf = (...orders: SyntheticWalmartOrder[]) => syntheticWalmartFolder({ orders: [...syntheticWalmartMetalsSpec().orders, ...orders] });
  const competes = (payload: MetalsImportPayload, seed: number) => payload.competitors.some((competitor) => competitor.orderKey === keyOf(seed));
  const countsOf = <K extends string>(keys: readonly K[], hits: Partial<Record<K, number>>) =>
    Object.fromEntries(keys.map((key) => [key, hits[key] ?? 0])) as Record<K, number>;

  it('flags a refused title for each kind of bullion evidence, iterating the guard\'s closed list: a lot of no metal', () => {
    const kinds = [...RETAIL_METAL_GUARD_EVIDENCE];
    const { payload } = convert(folderOf(...kinds.map((kind, index) => titled(81 + index, [ONE_EVIDENCE[kind]]))));
    for (const [index, kind] of kinds.entries()) {
      const [line] = orderOf(payload, 81 + index).lines;
      assert.deepEqual([line.metal, line.metalUncertain], [null, { guard: RETAIL_METAL_GUARD, evidence: [kind], metal: 'XAU' }], kind);
    }
  });

  it('flags several kinds of evidence in the guard\'s closed order, as the guard returns them', () => {
    const title = 'SAMPLE 1 oz Gold Bar in Assay Card Holder';
    const [line] = orderOf(convert(folderOf(titled(81, [title]))).payload, 81).lines;
    assert.deepEqual(line.metalUncertain, { guard: RETAIL_METAL_GUARD, evidence: ['bullion-word', 'shape-with-weight', 'adjacency'], metal: 'XAU' });
    assert.deepEqual(line.metalUncertain?.evidence, retailMetalTitleGuard(title, { assessed: true }).evidence);
  });

  it('reads the guard on the raw name: evidence past the stored title\'s length flags the line; the stored title alone is drift', () => {
    const long = `SAMPLE Gold Card Holder ${'SAMPLE FILLER WORDS FOR A LONG LISTING '.repeat(7)}1 ozt`;
    assert.ok(long.indexOf('1 ozt') > METALS_TITLE_MAX, 'the only bullion evidence lies past the stored length');
    const stored = sanitizeCardText(long, METALS_TITLE_MAX)!;
    const { payload, report } = convert(folderOf(titled(81, [long]), titled(82, [stored])));
    const [line] = orderOf(payload, 81).lines;
    assert.deepEqual(line.metalUncertain, { guard: RETAIL_METAL_GUARD, evidence: ['troy-or-metric-weight'], metal: 'XAU' });
    assert.equal(line.title, stored, 'the stored title is the raw name cut to its length');
    assert.equal(competes(payload, 82), true, 'the stored title read as a name shows no evidence: drift, so it competes');
    assert.deepEqual([report.census.flagged, report.census.drift, report.census.omissions], [1, 1, 0]);
  });

  it('reads a title the rule reads as metal with its metal word and evidence too (the guard\'s interface), never flagging it', () => {
    for (const title of [titles.eagle, titles.fineBar, titles.silverPack, DESIGN_ONLY, 'SAMPLE 1 oz Gold Bar in Assay Card']) {
      assert.notEqual(retailMetalTitleEvidence(title), null, title);
      const reading = retailMetalTitleGuard(title, { assessed: true });
      assert.deepEqual([reading.metalWord, reading.uncertain, reading.evidence.length > 0], [true, false, true], title);
    }
  });

  it('converts a v3 assay-card title as metal, unflagged; an assay card holder is flagged with evidence, else drift', () => {
    const { payload, report } = convert(folderOf(
      titled(81, ['SAMPLE 1 oz Gold Bar in Assay Card']),
      titled(82, ['SAMPLE 1 oz Gold Bar in Assay Card Holder']),
      titled(83, ['SAMPLE Gold Card Holder']),
    ));
    assert.deepEqual(orderOf(payload, 81).lines.map((line) => [line.metal, line.metalUncertain]), [['XAU', null]]);
    assert.deepEqual(orderOf(payload, 82).lines.map((line) => [line.metal, line.metalUncertain?.guard]), [[null, RETAIL_METAL_GUARD]]);
    assert.equal(competes(payload, 83), true);
    assert.deepEqual([report.census.metal, report.census.flagged, report.census.drift, report.census.omissions], [4, 1, 1, 0]);
  });

  it('keeps a flagged order its funding would admit in orders, in full, never as a competitor, with no card evidence', () => {
    const { payload, report } = convert(folderOf(titled(81, [ONE_EVIDENCE.adjacency])));
    const order = orderOf(payload, 81);
    assert.equal(competes(payload, 81), false);
    assert.equal(metalsAdmission('walmart', 'online', order.admission!)?.basis, 'single-charge', 'its funding would admit it');
    assert.deepEqual(order.evidence, []);
    assert.deepEqual(order.skeleton.map((line) => line.metal), [true]);
    assert.ok('hold' in order.lines[0].fine && order.lines[0].fine.hold === 'bullion-unconfirmed');
    assert.deepEqual([report.records.flagged, report.records.competitors, report.admission.withheld, report.lines.flagged], [1, 3, 1, 1]);
  });

  it('keeps a flagged order with no card funding in orders, never skipped', () => {
    const { payload, report } = convert(folderOf(payPal(titled(81, [ONE_EVIDENCE['troy-or-metric-weight']]))));
    assert.deepEqual(orderOf(payload, 81).lines.map((line) => line.metalUncertain?.evidence), [['troy-or-metric-weight']]);
    assert.equal(report.records.noCardFunding, 1, 'only the spec\'s PayPal order with no metal word');
  });

  it('carries a mixed order in full: its metal and flagged lines both lots of its skeleton, sharing its tax, with no card evidence', () => {
    const { payload, report } = convert(folderOf(oneGroup(81, [titles.eagle, ONE_EVIDENCE.purity, titles.widget])));
    const order = orderOf(payload, 81);
    assert.deepEqual(order.skeleton.map((line) => line.metal), [true, true, false]);
    assert.deepEqual(order.lines.map((line) => [line.ordinal, line.metal, line.metalUncertain?.evidence ?? null]), [[0, 'XAU', null], [1, null, ['purity']]]);
    assert.deepEqual(order.evidence, []);
    const allocation = metalsAllocation(order.skeleton, order.components);
    assert.deepEqual(order.lines.map((line) => line.costMinor), allocation.lines.filter((line) => line.metal).map((line) => line.totalMinor));
    assert.deepEqual([report.census.flaggedOrders, report.census.mixedOrders, report.admission.withheld], [1, 1, 1]);
  });

  it('holds a flagged order for what holds a metal one (holds first), counting its metal-word line as held', () => {
    const base = titled(81, [ONE_EVIDENCE.adjacency]);
    const { payload, report } = convert(folderOf({ ...base, refunds: [{ label: 'Refund', cents: -100 }], grandTotal: base.grandTotal - 100, flags: { refunded: true } }));
    assert.deepEqual(payload.held, [{ key: keyOf(81), channel: 'online', date: '2030-03-01', reason: 'status-ambiguous', check: 'refund-without-return' }]);
    assert.deepEqual([report.census.heldMetalWordLines, report.census.heldAlsoFlaggedOrders, report.census.flagged], [1, 1, 0]);
  });

  it('leaves a metal word with no bullion evidence no metal and unflagged (drift): it competes, or stays a plain line', () => {
    const { payload, report } = convert(folderOf(titled(81, ['SAMPLE Gold Star Membership']), oneGroup(82, [titles.eagle, 'SAMPLE Gold Card Holder'])));
    assert.equal(competes(payload, 81), true);
    assert.deepEqual(orderOf(payload, 82).skeleton.map((line) => line.metal), [true, false]);
    assert.deepEqual([report.census.drift, report.census.flagged, report.census.omissions], [2, 0, 0]);
  });

  it('counts the census in lines over every captured order: each bucket\'s known count, and no omissions', () => {
    const discounted = oneGroup(75, [titles.eagle, ONE_EVIDENCE.adjacency]);
    const { report } = convert(folderOf(
      titled(71, [ONE_EVIDENCE.adjacency]),
      payPal(titled(72, [ONE_EVIDENCE['troy-or-metric-weight']])),
      titled(73, [DESIGN_ONLY, ONE_EVIDENCE.purity]),
      titled(74, ['SAMPLE Gold Star Membership']),
      { ...discounted, discounts: [{ label: 'Savings', cents: -500 }] },
      oneGroup(76, [titles.eagle, 'SAMPLE Gold Card Holder', titles.widget]),
    ));
    const first = { adjacency: 1, 'troy-or-metric-weight': 1, purity: 1 };
    assert.deepEqual(report.census, {
      universe: 12, heldMetalWordLines: 2, metal: 5, flagged: 3, drift: 2, omissions: 0, omissionsByPlace: {},
      flaggedByClause: countsOf(RETAIL_METAL_GUARD_CLAUSES, { 'near-miss/adjacency': 1, 'near-miss/troy-or-metric-weight': 1, 'near-miss/purity': 1 }),
      flaggedByFirstEvidence: countsOf(RETAIL_METAL_GUARD_EVIDENCE, first),
      flaggedWithEvidence: countsOf(RETAIL_METAL_GUARD_EVIDENCE, first),
      adjacencyOnly: 1, flaggedOrders: 3, mixedOrders: 1, heldAlsoFlaggedOrders: 1,
    });
  });

  it('finds each misrouting in a payload: a flagged order dropped, a flag or a flagged line dropped, a metal line dropped', () => {
    const folder = folderOf(titled(71, [ONE_EVIDENCE.adjacency]), oneGroup(73, [DESIGN_ONLY, ONE_EVIDENCE.purity]));
    const { payload } = convert(folder);
    const files = syntheticWalmartFiles(folder);
    const omissions = (change: (copy: MetalsImportPayload) => void) => {
      const copy = structuredClone(payload);
      change(copy);
      return walmartGuardCensus(files, copy).omissionsByPlace;
    };
    assert.deepEqual(omissions(() => undefined), {});
    assert.deepEqual(omissions((copy) => { copy.orders = copy.orders.filter((order) => order.key !== keyOf(71)); }), { 'flagged>elsewhere': 1 });
    assert.deepEqual(omissions((copy) => { orderOf(copy, 73).lines[1].metalUncertain = null; }), { 'flagged>metal': 1 });
    assert.deepEqual(omissions((copy) => { orderOf(copy, 73).lines.splice(1, 1); }), { 'flagged>elsewhere': 1 });
    assert.deepEqual(omissions((copy) => { orderOf(copy, 73).skeleton[0].metal = false; }), { 'metal>elsewhere': 1 });
  });

  it('counts each lot line\'s product ref by kind: stored, or withheld and why', () => {
    const folder = folderOf(titled(71, [ONE_EVIDENCE.adjacency]));
    const { listed, raw } = recordsOf(folder, 71);
    at(listed, 'groups', 0, 'items', 0).usItemId = 'A'.repeat(METALS_PRODUCT_REF_MAX + 1);
    at(raw, 'groups_2101', 0, 'items', 0, 'productInfo').usItemId = 'A'.repeat(METALS_PRODUCT_REF_MAX + 1);
    const { report } = convert(folder);
    const none = { absent: 0, 'too-long': 0, form: 0, 'digit-run': 0, 'card-data': 0 };
    assert.deepEqual(report.lines.productRefs, { metal: { stored: 3, withheld: none }, flagged: { stored: 0, withheld: { ...none, 'too-long': 1 } } });
    assert.equal(report.lines.productRefsMissing, 1);
  });

  it('counts the owner\'s questions by the shared definitions: confirmations per product, flagged lots as bullion decisions', () => {
    // 77 repeats 11's coin (one product, one confirmation) and holds a flagged lot whose group was cancelled; 78's silver
    // pack (a lot-scoped confirmation) was cancelled; 79's flagged lot states no catalog id (a lot-scoped bullion question).
    const partly = syntheticWalmartOrder(77, [
      syntheticWalmartGroup(1, titles.eagle, 1, 10_000, { seller: null }),
      syntheticWalmartGroup(2, ONE_EVIDENCE.adjacency, 1, 10_000, { seller: null, status: 'CANCELED', statusParts: ['Canceled'], deliveryDate: null }),
    ], { flags: { partlyCancelled: true } });
    const cancelledPack = syntheticWalmartOrder(78, [
      syntheticWalmartGroup(1, titles.silverPack, 1, 10_000, { seller: null, status: 'CANCELED', statusParts: ['Canceled'], deliveryDate: null }),
      syntheticWalmartGroup(2, titles.widget, 1, 10_000, { seller: null }),
    ], { flags: { partlyCancelled: true } });
    const folder = folderOf(titled(71, [ONE_EVIDENCE.adjacency]), partly, cancelledPack, titled(79, [ONE_EVIDENCE.adjacency]));
    const { listed, raw } = recordsOf(folder, 79);
    at(listed, 'groups', 0, 'items', 0).usItemId = null;
    at(raw, 'groups_2101', 0, 'items', 0, 'productInfo').usItemId = null;
    const { report } = convert(folder);
    assert.deepEqual(report.confirmations, {
      needed: 3, neededIncludingFullyCancelledOrReturned: 4, productRefs: 1, productScoped: 2, lotScoped: 2, metalUnknown: 0,
      notCancelledOrReturned: { productScoped: 2, lotScoped: 1, metalUnknown: 0 },
    });
    assert.deepEqual(report.bullion, {
      needed: 2, productScoped: 1, lotScoped: 1, includingFullyCancelledOrReturned: { needed: 3, productScoped: 2, lotScoped: 1 },
    });
  });

  it('withholds an unflagged line\'s final stored title the guard reads as metal-uncertain (metal-guard); a flagged line keeps its own', () => {
    // The Gold lead's synthetic pair (from 223e9adb): the raw name is a gold bar with its weight, read as metal; its first
    // 240 characters end just before the weight, so the stored title alone is refused (shape without weight) and the
    // guard flags it on adjacency. The control states the weight right after Bar, inside the stored length.
    const cut = `Sample Refinery Gold Bar${' Gift Edition'.repeat(16)} Display 1 oz`;
    const whole = `Sample Refinery Gold Bar 1 oz${' Gift Edition'.repeat(16)} Display`;
    assert.equal(retailMetalTitleGuard(sanitizeCardText(cut, METALS_TITLE_MAX)!, { assessed: true }).uncertain, true);
    const output = orRefusal(() => convert(folderOf(titled(81, [cut]), titled(82, [whole]), titled(83, [ONE_EVIDENCE.adjacency]))));
    if (output === 'converter-invalid') assert.fail('the converter refused its own output (converter-invalid)');
    const { payload, report } = output;
    assert.deepEqual(orderOf(payload, 81).lines.map((line) => [line.metal, line.metalUncertain, line.title]), [['XAU', null, null]]);
    assert.equal(orderOf(payload, 82).lines[0].title, sanitizeCardText(whole, METALS_TITLE_MAX), 'its weight inside the stored title: kept');
    assert.equal(orderOf(payload, 83).lines[0].title, ONE_EVIDENCE.adjacency, 'a flagged line keeps the title the guard flags');
    assert.deepEqual(report.lines.titlesWithheldBy, { text: 0, 'pack-marker': 0, 'metal-guard': 1 });
    // 1E's predicate, on every line: no unflagged line stores a title the guard reads as metal-uncertain.
    assert.ok(payload.orders.every((order) => order.lines.every((line) => line.metalUncertain !== null || line.title === null
      || !retailMetalTitleGuard(line.title, { assessed: true }).uncertain)));
  });

  it('counts held orders\' lines from every branch of the walk: unlisted, numberless, read from the raw detail, repeated', () => {
    // Each held order has a metal line and one the guard would flag.
    const pair = [titles.eagle, ONE_EVIDENCE.adjacency];
    const folder = folderOf(titled(92, pair), titled(93, pair), titled(94, pair));
    // 95: a raw detail the list doesn't name (held raw-unlisted).
    folder.rawDetails.push(syntheticWalmartFolder({ orders: [titled(95, pair)] }).rawDetails[0]);
    // 92: its number doesn't read (held order-key), and it has no raw detail.
    recordsOf(folder, 92).listed.orderId = 'SAMPLE';
    folder.rawDetails = folder.rawDetails.filter((detail) => detail.orderId !== syntheticWalmartOrderId(92));
    // 93: its list entry shows no item name at all (an empty groups list), so its raw detail is read.
    recordsOf(folder, 93).listed.groups = [];
    // 94: repeated, the repeats differing (held duplicate): read once.
    const copy = structuredClone(recordsOf(folder, 94).listed);
    at(copy, 'amounts', 'tax').cents = 1;
    (folder.consolidated.orders as Json[]).push(copy);
    const { payload, report } = convert(folder);
    assert.equal(payload.held.length, 4);
    assert.ok(!payload.orders.some((order) => [92, 93, 94, 95].some((seed) => order.key === keyOf(seed))));
    const { universe, heldMetalWordLines, heldAlsoFlaggedOrders, metal, omissions } = report.census;
    assert.deepEqual({ universe, heldMetalWordLines, heldAlsoFlaggedOrders, metal, omissions },
      { universe: 11, heldMetalWordLines: 8, heldAlsoFlaggedOrders: 4, metal: 3, omissions: 0 });
  });
});