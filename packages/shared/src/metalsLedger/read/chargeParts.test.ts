import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { metalsAllocation } from '../allocation.js';
import type {
  Metal,
  MetalsAdmissionFacts,
  MetalsChannel,
  MetalsOrderComponent,
  MetalsSkeletonLine,
  MetalsSource,
  MetalsTender,
} from '../model.js';
import { metalsCardLinks, metalsMerchantClass, type MetalsCardBinding, type MetalsCardRow, type MetalsFundedOrder } from './cardLinks.js';
import { metalsChargeParts, metalsReceiptCharges, type MetalsChargeOrder } from './chargeParts.js';
import { metalsDepositLinks } from './depositLinks.js';

/** Synthetic orders only: invented keys, amounts, accounts and last 4s. */
const item = (ordinal: number, amountMinor: number, metal: boolean, extra: Partial<MetalsSkeletonLine> = {}): MetalsSkeletonLine => ({
  ordinal, kind: 'item', amountMinor, shippingMinor: null, feeParent: null, couponTarget: null, taxFlag: null, metal, ...extra,
});
const card = (amountMinor: number, last4 = '1111'): MetalsTender => ({ kind: 'card', network: 'visa', last4, amountMinor });
const funding = (kind: 'shop-card' | 'gift-card' | 'store-balance', amountMinor: number): MetalsTender => ({ kind, network: 'unknown', last4: null, amountMinor });
const shopCard = (amountMinor: number) => funding('shop-card', amountMinor);
const BINDINGS: MetalsCardBinding[] = [
  { source: 'costco', network: 'visa', last4: '1111', accountId: 'acct-a', state: 'active' },
  { source: 'walmart', network: 'visa', last4: '1111', accountId: 'acct-a', state: 'active' },
];

interface Spec {
  key: string;
  source?: MetalsSource;
  channel?: MetalsChannel;
  skeleton: MetalsSkeletonLine[];
  components?: MetalsOrderComponent[];
  /** The order's payment methods, given its full price. */
  methods: (fullPriceMinor: number) => MetalsTender[];
  /** The metal of each metal line; by default every metal item is gold. */
  metals?: Array<[number, Metal | null]>;
  active?: boolean;
  /** Admission facts the source states beyond the defaults (not refunded, cancelled or partly cancelled). */
  admission?: Partial<MetalsAdmissionFacts>;
}

/** One order as the card graph sees it, as the charge contracts see it, and the card rows its card methods charged. */
function build(spec: Spec) {
  const source = spec.source ?? 'costco';
  const channel = spec.channel ?? 'online';
  const components = spec.components ?? [];
  const fullPrice = metalsAllocation(spec.skeleton, components).fullPriceMinor;
  const methods = spec.methods(fullPrice);
  const admission: MetalsAdmissionFacts = {
    fulfilment: channel === 'warehouse' ? 'in-store' : { shipments: 1 }, methods, refunded: false, cancelled: false, partlyCancelled: false,
    grossTotalMinor: fullPrice, ...spec.admission,
  };
  const funded: MetalsFundedOrder = { orderKey: spec.key, source, channel, date: '2030-03-10', admission, metal: true, active: spec.active ?? true };
  const metals = new Map<number, Metal | null>(spec.metals
    ?? spec.skeleton.filter((line) => line.kind === 'item' && line.metal).map((line): [number, Metal | null] => [line.ordinal, 'XAU']));
  const charge: MetalsChargeOrder = { orderKey: spec.key, skeleton: spec.skeleton, components, admission, metals };
  const rows = methods.flatMap((method, index): MetalsCardRow[] => (method.kind !== 'card' ? [] : [{
    id: `${spec.key}-row-${index}`, accountId: 'acct-a', date: '2030-03-12', amountMinor: method.amountMinor!, kind: 'purchase', currency: 'USD',
    usable: true, merchantClass: metalsMerchantClass(source, channel),
  }]));
  return { funded, charge, rows };
}

function ledger(built: Array<ReturnType<typeof build>>, extraRows: MetalsCardRow[] = []) {
  const graph = metalsCardLinks({
    orders: built.map((entry) => entry.funded), held: [], rows: [...built.flatMap((entry) => entry.rows), ...extraRows],
    accounts: [{ id: 'acct-a', last4: '1111' }], bindings: BINDINGS,
  });
  return { graph, orders: new Map(built.map((entry) => [entry.funded.orderKey, entry.charge])) };
}

const ALL_METAL_SPEC: Spec = {
  key: 'costco-order-all-metal',
  skeleton: [item(0, 6000, true), item(1, 4000, true)],
  methods: (full) => [card(full - 1000), shopCard(1000)],
  metals: [[0, 'XAU'], [1, 'XAG']],
};
const ALL_METAL = build(ALL_METAL_SPEC);

describe('charge parts: per proof-linked row only (GD-07)', () => {
  it('an all-metal order: the whole row is one metal part, whatever its tenders; a Shop Card is funding, never a part', () => {
    const { graph, orders } = ledger([ALL_METAL]);
    assert.equal(graph.links[0].state, 'linked');
    assert.deepEqual(metalsChargeParts('costco-order-all-metal-row-0', graph, orders), {
      provable: true, basis: 'all-metal', parts: [{ kind: 'precious-metals', metals: ['XAG', 'XAU'], amountMinor: 9000 }],
    });
  });

  it('an order-level fee or discount line doesn\'t make an all-metal order mixed', () => {
    const order = build({
      key: 'costco-order-fee',
      skeleton: [item(0, 9000, true), { ...item(1, 500, false), kind: 'fee' }, { ...item(2, -300, false), kind: 'coupon' }],
      methods: (full) => [card(full - 1000), shopCard(1000)],
    });
    const { graph, orders } = ledger([order]);
    assert.deepEqual(metalsChargeParts('costco-order-fee-row-0', graph, orders), {
      provable: true, basis: 'all-metal', parts: [{ kind: 'precious-metals', metals: ['XAU'], amountMinor: 8200 }],
    });
    assert.deepEqual(metalsReceiptCharges(graph, orders).map((charge) => charge.rowId), ['costco-order-fee-row-0']);
  });

  it('a single card at the full price on a mixed order: each line once, metal and other, summing to the row exactly', () => {
    const order = build({
      key: 'walmart-order-mixed',
      source: 'walmart',
      skeleton: [
        item(0, 8000, true, { taxFlag: 'non-taxable' }), item(1, 2000, false, { taxFlag: 'taxable' }), { ...item(2, 150, true), kind: 'fee', feeParent: 0 },
      ],
      components: [{ kind: 'tax', amountMinor: 160 }],
      methods: (full) => [card(full)],
    });
    const { graph, orders } = ledger([order]);
    const parts = metalsChargeParts('walmart-order-mixed-row-0', graph, orders);
    assert.deepEqual(parts, {
      provable: true, basis: 'single-card-full-price', parts: [
        { kind: 'precious-metals', metals: ['XAU'], amountMinor: 8150 }, { kind: 'other', metals: [], amountMinor: 2160 },
      ],
    });
    assert.ok(parts.provable && parts.parts.reduce((total, part) => total + part.amountMinor, 0) === 10310);
    assert.deepEqual(metalsReceiptCharges(graph, orders), [], 'a mixed charge stays in spending');
  });

  it('two cards, card plus Shop Card, or a mixed order with unattributed cost give no parts', () => {
    const twoCards = build({
      key: 'costco-receipt-two-cards', channel: 'warehouse', skeleton: [item(0, 7000, true), item(1, 3000, false)],
      methods: (full) => [card(6000), card(full - 6000)],
    });
    const twoCardsLedger = ledger([twoCards]);
    assert.deepEqual(twoCardsLedger.graph.links.map((link) => link.state), ['linked', 'linked']);
    for (const rowId of ['costco-receipt-two-cards-row-0', 'costco-receipt-two-cards-row-1']) {
      assert.deepEqual(metalsChargeParts(rowId, twoCardsLedger.graph, twoCardsLedger.orders), { provable: false, reason: 'parts-unprovable' });
    }
    const shop = build({
      key: 'costco-order-shop-card', skeleton: [item(0, 7000, true), item(1, 3000, false)], methods: (full) => [card(full - 1000), shopCard(1000)],
    });
    const shopLedger = ledger([shop]);
    assert.equal(shopLedger.graph.links[0].state, 'linked');
    assert.deepEqual(metalsChargeParts('costco-order-shop-card-row-0', shopLedger.graph, shopLedger.orders), { provable: false, reason: 'parts-unprovable' });
    const unattributed = build({
      key: 'walmart-order-unattributed', source: 'walmart', skeleton: [item(0, 8000, true), item(1, 2000, false)],
      components: [{ kind: 'tax', amountMinor: 800 }], methods: (full) => [card(full)],
    });
    const unattributedLedger = ledger([unattributed]);
    assert.equal(unattributedLedger.graph.links[0].state, 'linked');
    assert.deepEqual(metalsChargeParts('walmart-order-unattributed-row-0', unattributedLedger.graph, unattributedLedger.orders),
      { provable: false, reason: 'parts-unprovable' });
  });

  it('offsetting unattributed components prove no parts: zero net unattributed is not none', () => {
    const order = build({
      key: 'walmart-order-net-zero', source: 'walmart',
      skeleton: [
        item(0, 10000, true, { taxFlag: 'taxable' }), item(1, 10000, false, { taxFlag: 'taxable' }), item(2, 10000, false, { taxFlag: 'non-taxable' }),
      ],
      components: [{ kind: 'tax', amountMinor: 1000 }, { kind: 'discount', amountMinor: -1000 }],
      methods: (full) => [card(full)],
    });
    const allocation = metalsAllocation(order.charge.skeleton, order.charge.components);
    assert.deepEqual([allocation.fullPriceMinor, allocation.unattributedMinor], [30000, 0]);
    assert.deepEqual(allocation.components.map((component) => component.attributed), [false, false]);
    assert.deepEqual(allocation.lines.map((line) => line.complete), [false, false, false]);
    const { graph, orders } = ledger([order]);
    assert.equal(graph.links[0].state, 'linked');
    assert.deepEqual(metalsChargeParts('walmart-order-net-zero-row-0', graph, orders), { provable: false, reason: 'parts-unprovable' });
  });

  it('a zero component is attributed and blocks nothing; an all-metal row is one metal part whatever its components', () => {
    const zero = build({
      key: 'walmart-order-zero', source: 'walmart',
      skeleton: [item(0, 8000, true, { taxFlag: 'non-taxable' }), item(1, 2000, false, { taxFlag: 'taxable' })],
      components: [{ kind: 'tax', amountMinor: 160 }, { kind: 'discount', amountMinor: 0 }],
      methods: (full) => [card(full)],
    });
    const zeroLedger = ledger([zero]);
    assert.deepEqual(metalsChargeParts('walmart-order-zero-row-0', zeroLedger.graph, zeroLedger.orders), {
      provable: true, basis: 'single-card-full-price', parts: [
        { kind: 'precious-metals', metals: ['XAU'], amountMinor: 8000 }, { kind: 'other', metals: [], amountMinor: 2160 },
      ],
    });
    const metal = build({
      key: 'walmart-order-metal-tax', source: 'walmart',
      skeleton: [item(0, 10000, true, { taxFlag: 'taxable' }), item(1, 10000, true, { taxFlag: null })],
      components: [{ kind: 'tax', amountMinor: 1000 }, { kind: 'discount', amountMinor: -1000 }],
      methods: (full) => [card(full)],
    });
    assert.equal(metalsAllocation(metal.charge.skeleton, metal.charge.components).components[0].attributed, false);
    const metalLedger = ledger([metal]);
    assert.deepEqual(metalsChargeParts('walmart-order-metal-tax-row-0', metalLedger.graph, metalLedger.orders), {
      provable: true, basis: 'all-metal', parts: [{ kind: 'precious-metals', metals: ['XAU'], amountMinor: 20000 }],
    });
  });

  it('two different cards, a gift card or store balance beside a card, or a partly refunded order: no parts on a mixed order', () => {
    const mixed = [item(0, 7000, true), item(1, 3000, false)];
    const twoCards = build({ key: 'costco-receipt-two-cards', channel: 'warehouse', skeleton: mixed, methods: (full) => [card(6000), card(full - 6000, '2222')] });
    const twoCardsLedger = ledger([twoCards]);
    assert.deepEqual(twoCardsLedger.graph.links.map((link) => link.state), ['linked', 'binding-missing']);
    assert.deepEqual(metalsChargeParts('costco-receipt-two-cards-row-0', twoCardsLedger.graph, twoCardsLedger.orders), { provable: false, reason: 'parts-unprovable' });
    for (const kind of ['gift-card', 'store-balance'] as const) {
      for (const [skeleton, expected] of [
        [mixed, { provable: false, reason: 'parts-unprovable' }],
        [[item(0, 7000, true), item(1, 3000, true)], { provable: true, basis: 'all-metal', parts: [{ kind: 'precious-metals', metals: ['XAU'], amountMinor: 9000 }] }],
      ] as const) {
        const order = build({ key: `costco-order-${kind}`, skeleton: [...skeleton], methods: (full) => [card(full - 1000), funding(kind, 1000)] });
        const { graph, orders } = ledger([order]);
        assert.equal(graph.links[0].state, 'linked', kind);
        assert.deepEqual(metalsChargeParts(`costco-order-${kind}-row-0`, graph, orders), expected, kind);
      }
    }
    const refunded = build({
      key: 'walmart-order-refunded', source: 'walmart', skeleton: mixed, methods: (full) => [card(full - 500)],
      admission: { refunded: true },
    });
    const refundedLedger = ledger([refunded]);
    assert.deepEqual(refundedLedger.graph.links, []);
    assert.deepEqual(metalsChargeParts('walmart-order-refunded-row-0', refundedLedger.graph, refundedLedger.orders), { provable: false, reason: 'not-linked' });
    assert.deepEqual(metalsReceiptCharges(refundedLedger.graph, refundedLedger.orders), []);
  });

  it('an all-metal receipt paid with two cards: each row is one metal part of exactly its own amount', () => {
    const order = build({
      key: 'costco-receipt-metal', channel: 'warehouse', skeleton: [item(0, 7000, true), item(1, 3000, true)],
      methods: (full) => [card(6000), card(full - 6000)],
    });
    const { graph, orders } = ledger([order]);
    assert.deepEqual(['costco-receipt-metal-row-0', 'costco-receipt-metal-row-1'].map((rowId) => metalsChargeParts(rowId, graph, orders)), [
      { provable: true, basis: 'all-metal', parts: [{ kind: 'precious-metals', metals: ['XAU'], amountMinor: 6000 }] },
      { provable: true, basis: 'all-metal', parts: [{ kind: 'precious-metals', metals: ['XAU'], amountMinor: 4000 }] },
    ]);
    assert.deepEqual(metalsReceiptCharges(graph, orders).map((charge) => [charge.rowId, charge.evidenceClass]), [
      ['costco-receipt-metal-row-0', 'costco-settled-tender@1'], ['costco-receipt-metal-row-1', 'costco-settled-tender@1'],
    ]);
  });
});

describe('receipt-confirmed charges: proof links on all-metal orders only (§10)', () => {
  it('names the charge, its evidence class and every metal, a content hold or an unnamed metal included', () => {
    const { graph, orders } = ledger([ALL_METAL]);
    assert.deepEqual(metalsReceiptCharges(graph, orders), [{
      rowId: 'costco-order-all-metal-row-0', subject: 'costco-order-all-metal#0', orderKey: 'costco-order-all-metal',
      evidenceClass: 'costco-settled-tender@1', metals: ['XAG', 'XAU'],
    }]);
    const unnamed = build({
      key: 'walmart-order-unnamed', source: 'walmart', skeleton: [item(0, 5000, true), item(1, 2500, true)], methods: (full) => [card(full)],
      metals: [[0, null], [1, 'XAU']],
    });
    const unnamedLedger = ledger([unnamed]);
    assert.deepEqual(metalsReceiptCharges(unnamedLedger.graph, unnamedLedger.orders).map((charge) => [charge.evidenceClass, charge.metals]), [
      ['walmart-order-total@1', ['XAU', 'metal-unknown']],
    ]);
  });

  it('a candidate is never a receipt-confirmed charge and has no parts: quarantined, ambiguous, unknown row or order', () => {
    const quarantined = ledger([build({ ...ALL_METAL_SPEC, active: false })]);
    assert.equal(quarantined.graph.links[0].state, 'ineligible');
    assert.deepEqual(metalsReceiptCharges(quarantined.graph, quarantined.orders), []);
    assert.deepEqual(metalsChargeParts('costco-order-all-metal-row-0', quarantined.graph, quarantined.orders), { provable: false, reason: 'not-linked' });
    const twin: MetalsCardRow = { ...ALL_METAL.rows[0], id: 'twin-row', date: '2030-03-13' };
    const ambiguous = ledger([ALL_METAL], [twin]);
    assert.equal(ambiguous.graph.links[0].state, 'ambiguous');
    assert.deepEqual(metalsReceiptCharges(ambiguous.graph, ambiguous.orders), []);
    assert.deepEqual(metalsChargeParts('twin-row', ambiguous.graph, ambiguous.orders), { provable: false, reason: 'not-linked' });
    const { graph, orders } = ledger([ALL_METAL]);
    assert.deepEqual(metalsChargeParts('no-such-row', graph, orders), { provable: false, reason: 'not-linked' });
    assert.deepEqual(metalsChargeParts('costco-order-all-metal-row-0', graph, new Map()), { provable: false, reason: 'not-linked' });
    assert.deepEqual(metalsReceiptCharges(graph, new Map()), []);
  });
});

describe('one proof-eligibility predicate for card and checking consumers (GV4-07)', () => {
  it('a quarantined order proves no card charge and no deposit; resolving it restores both', () => {
    const run = (active: boolean) => {
      const cards = ledger([build({ ...ALL_METAL_SPEC, active })]);
      const deposits = metalsDepositLinks({
        payouts: [{
          payoutKey: 'payout', saleOrderKey: 'sell', source: 'collectpure', amountMinor: 9000, initiatedDate: null, payoutDate: '2030-03-20',
          destinationLast4: '7777', status: 'complete', active,
        }],
        rows: [{ id: 'credit', accountId: 'chk-a', date: '2030-03-21', amountMinor: 9000, kind: 'credit', currency: 'USD', usable: true, originSources: ['collectpure'] }],
        accounts: [{ id: 'chk-a', last4: '7777' }],
        bindings: [{ source: 'collectpure', last4: '7777', accountId: 'chk-a', state: 'active' }],
        coverage: [{ accountId: 'chk-a', from: '2030-01-01', to: '2030-12-31' }],
      });
      return {
        card: [cards.graph.links[0].state, cards.graph.links[0].rowId, cards.graph.links[0].proof],
        deposit: [deposits.links[0].state, deposits.links[0].rowId, deposits.links[0].proof],
        receiptCharges: metalsReceiptCharges(cards.graph, cards.orders).length,
        parts: metalsChargeParts('costco-order-all-metal-row-0', cards.graph, cards.orders).provable,
        depositEvidence: deposits.evidence.length,
      };
    };
    assert.deepEqual(run(false), {
      card: ['ineligible', 'costco-order-all-metal-row-0', false], deposit: ['ineligible', 'credit', false], receiptCharges: 0, parts: false, depositEvidence: 0,
    });
    assert.deepEqual(run(true), {
      card: ['linked', 'costco-order-all-metal-row-0', true], deposit: ['linked', 'credit', true], receiptCharges: 1, parts: true, depositEvidence: 1,
    });
  });
});
