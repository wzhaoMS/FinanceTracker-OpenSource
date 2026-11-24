import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { metalsAdmission, metalsSettlementInterval } from './admission.js';
import type { MetalsAdmissionFacts, MetalsTender } from './model.js';

/** Synthetic funding facts only. */
const card = (amountMinor: number | null, last4 = '1111'): MetalsTender => ({ kind: 'card', network: 'visa', last4, amountMinor });
const facts = (overrides: Partial<MetalsAdmissionFacts> = {}): MetalsAdmissionFacts => ({
  fulfilment: { shipments: 1 }, methods: [card(10000)], refunded: false, cancelled: false, partlyCancelled: false,
  grossTotalMinor: 10000, ...overrides,
});

describe('admission: walmart-order-total@1 (GV4-01)', () => {
  it('admits one card, one shipment group, its stated total the grand total', () => {
    assert.deepEqual(metalsAdmission('walmart', 'online', facts()), {
      basis: 'single-charge', capMinor: null, evidence: [{ class: 'walmart-order-total@1', tender: 0, amountMinor: 10000 }],
    });
  });

  it('a refunded order (net method total) is no subject: an aggregate up to its gross total', () => {
    assert.deepEqual(metalsAdmission('walmart', 'online', facts({ refunded: true, methods: [card(8000)] })),
      { basis: 'aggregate', capMinor: 10000, evidence: [] });
  });

  it('cancelled, partly cancelled, multi-group, unknown-group, two-method, missing-total or mismatched orders are aggregates', () => {
    const aggregates: Array<Partial<MetalsAdmissionFacts>> = [
      { cancelled: true },
      { partlyCancelled: true },
      { fulfilment: { shipments: 2 } },
      { fulfilment: { shipments: 0 } },
      { fulfilment: { shipments: null } },
      { methods: [card(6000), card(4000, '2222')] },
      { methods: [card(6000), { kind: 'gift-card', network: 'unknown', last4: null, amountMinor: 4000 }] },
      { methods: [card(null)] },
      { methods: [card(9999)] },
    ];
    for (const overrides of aggregates) {
      assert.deepEqual(metalsAdmission('walmart', 'online', facts(overrides)), { basis: 'aggregate', capMinor: 10000, evidence: [] },
        JSON.stringify(overrides));
    }
    assert.deepEqual(metalsAdmission('walmart', 'online', facts({ grossTotalMinor: null })), { basis: 'aggregate', capMinor: null, evidence: [] });
  });

  it('an order with no card funding is neither a subject nor a competitor', () => {
    assert.equal(metalsAdmission('walmart', 'online', facts({ methods: [{ kind: 'paypal', network: 'unknown', last4: null, amountMinor: 10000 }] })), null);
    assert.equal(metalsAdmission('collectpure', 'online', facts()), null);
  });

  it('a card refund among the methods never admits', () => {
    const refund: MetalsTender = { kind: 'card-refund', network: 'visa', last4: '1111', amountMinor: -500 };
    assert.equal(metalsAdmission('walmart', 'online', facts({ methods: [card(10500), refund] }))?.basis, 'aggregate');
  });

  it('a gross total before refunds is never negative; zero caps at zero', () => {
    assert.throws(() => metalsAdmission('walmart', 'online', facts({ refunded: true, grossTotalMinor: -1 })), RangeError);
    assert.throws(() => metalsAdmission('costco', 'warehouse', facts({ fulfilment: 'in-store', grossTotalMinor: -1 })), RangeError);
    assert.deepEqual(metalsAdmission('walmart', 'online', facts({ methods: [card(0)], grossTotalMinor: 0 })), { basis: 'aggregate', capMinor: 0, evidence: [] });
  });
});

describe('admission: costco-settled-tender@1 (GV5-01)', () => {
  const shopCard: MetalsTender = { kind: 'shop-card', network: 'unknown', last4: null, amountMinor: 2500 };

  it('admits an online order with one card and exactly one shipment record order-wide; Shop Card is funding, not evidence', () => {
    const admitted = metalsAdmission('costco', 'online', facts({ methods: [card(7500), shopCard] }));
    assert.deepEqual(admitted?.evidence, [{ class: 'costco-settled-tender@1', tender: 0, amountMinor: 7500 }]);
  });

  it('zero, missing or several shipment records make it an aggregate', () => {
    for (const shipments of [0, 2, 3, null]) {
      assert.equal(metalsAdmission('costco', 'online', facts({ fulfilment: { shipments } }))?.basis, 'aggregate', String(shipments));
    }
  });

  it('a Shop-Card-only order has no card evidence and no card funding', () => {
    assert.equal(metalsAdmission('costco', 'online', facts({ methods: [{ ...shopCard, amountMinor: 10000 }] })), null);
  });

  it('a warehouse receipt settles each card tender at the register', () => {
    const admitted = metalsAdmission('costco', 'warehouse', facts({ fulfilment: 'in-store', methods: [card(6000), card(4000, '2222')] }));
    assert.deepEqual(admitted?.evidence.map((entry) => [entry.tender, entry.amountMinor]), [[0, 6000], [1, 4000]]);
  });

  it('two cards online, or tenders that miss the total, are aggregates', () => {
    assert.equal(metalsAdmission('costco', 'online', facts({ methods: [card(6000), card(4000, '2222')] }))?.basis, 'aggregate');
    assert.equal(metalsAdmission('costco', 'warehouse', facts({ fulfilment: 'in-store', methods: [card(6000)] }))?.basis, 'aggregate');
  });

  it('funding that contradicts itself is an aggregate barring any amount: a credit, or a card stated above the gross', () => {
    const credit: MetalsTender = { kind: 'gift-card', network: 'unknown', last4: null, amountMinor: -2000 };
    const anyAmount = { basis: 'aggregate', capMinor: null, evidence: [] };
    assert.deepEqual(metalsAdmission('costco', 'online', facts({ methods: [card(12000), credit] })), anyAmount);
    assert.deepEqual(metalsAdmission('costco', 'warehouse', facts({ fulfilment: 'in-store', methods: [card(12000), credit] })), anyAmount);
    assert.deepEqual(metalsAdmission('costco', 'online', facts({ methods: [card(12000), { ...shopCard, amountMinor: -2000 }] })), anyAmount);
    assert.deepEqual(metalsAdmission('walmart', 'online', facts({ methods: [card(12000), credit] })), anyAmount);
    // No credit at all: one card stated above the gross total, even on a refunded or cancelled order.
    assert.deepEqual(metalsAdmission('walmart', 'online', facts({ methods: [card(12000)] })), anyAmount);
    assert.deepEqual(metalsAdmission('walmart', 'online', facts({ refunded: true, methods: [card(12000)] })), anyAmount);
    assert.deepEqual(metalsAdmission('costco', 'online', facts({ cancelled: true, methods: [card(10001)] })), anyAmount);
    // A card refund is no credit: the gross total still bounds every charge.
    assert.deepEqual(metalsAdmission('walmart', 'online', facts({ refunded: true, methods: [card(10000), { ...card(-2000), kind: 'card-refund' }] })),
      { basis: 'aggregate', capMinor: 10000, evidence: [] });
    // A zero-amount method is no credit: the card's charge is still the order's price.
    assert.equal(metalsAdmission('costco', 'online', facts({ methods: [card(10000), { ...shopCard, amountMinor: 0 }] }))?.basis, 'single-charge');
  });
});

describe('admission: settlement intervals', () => {
  it('runs from the date through the channel window, both ends inclusive, across month, year and leap days', () => {
    assert.deepEqual(metalsSettlementInterval('2030-01-10', 'online'), { from: '2030-01-10', to: '2030-02-09' });
    assert.deepEqual(metalsSettlementInterval('2030-12-30', 'warehouse'), { from: '2030-12-30', to: '2031-01-04' });
    assert.deepEqual(metalsSettlementInterval('2028-02-27', 'warehouse'), { from: '2028-02-27', to: '2028-03-03' });
    assert.throws(() => metalsSettlementInterval('not a date', 'online'));
  });
});
