import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { MetalsAdmissionFacts, MetalsTender } from '../model.js';
import {
  metalsCardLinks,
  metalsMerchantClass,
  type MetalsCardBinding,
  type MetalsCardLinkGraph,
  type MetalsCardRow,
  type MetalsFundedOrder,
  type MetalsHeldOrder,
} from './cardLinks.js';

/** Synthetic ledgers only: invented orders, rows, accounts and last 4s. */
const card = (last4: string | null, amountMinor: number | null, network: MetalsTender['network'] = 'visa'): MetalsTender =>
  ({ kind: 'card', network, last4, amountMinor });
const facts = (amountMinor: number | null, overrides: Partial<MetalsAdmissionFacts> = {}): MetalsAdmissionFacts => ({
  fulfilment: { shipments: 1 }, methods: [card('1111', amountMinor)], refunded: false, cancelled: false, partlyCancelled: false,
  grossTotalMinor: amountMinor, ...overrides,
});
const gold = (orderKey: string, date: string, amountMinor = 6000, overrides: Partial<MetalsFundedOrder> = {}): MetalsFundedOrder => ({
  orderKey, source: 'walmart', channel: 'online', date, admission: facts(amountMinor), metal: true, active: true, ...overrides,
});
const other = (orderKey: string, date: string, admission: MetalsAdmissionFacts, overrides: Partial<MetalsFundedOrder> = {}) =>
  gold(orderKey, date, 0, { admission, metal: false, ...overrides });
const row = (id: string, date: string, amountMinor = 6000, overrides: Partial<MetalsCardRow> = {}): MetalsCardRow => ({
  id, accountId: 'acct-a', date, amountMinor, kind: 'purchase', currency: 'USD', usable: true, merchantClass: 'walmart-online', ...overrides,
});
const accounts = [{ id: 'acct-a', last4: '1111' }, { id: 'acct-b', last4: '2222' }, { id: 'acct-c', last4: '1111' }];
const bindings: MetalsCardBinding[] = [
  { source: 'walmart', network: 'visa', last4: '1111', accountId: 'acct-a', state: 'active' },
  { source: 'costco', network: 'visa', last4: '1111', accountId: 'acct-a', state: 'active' },
];
function graph(orders: MetalsFundedOrder[], rows: MetalsCardRow[], held: MetalsHeldOrder[] = [], bound = bindings): MetalsCardLinkGraph {
  return metalsCardLinks({ orders, held, rows, accounts, bindings: bound });
}
const stateOf = (result: MetalsCardLinkGraph, orderKey: string, tender = 0) =>
  result.links.find((link) => link.orderKey === orderKey && link.tender === tender)?.state;
const linked = (result: MetalsCardLinkGraph, orderKey: string) => stateOf(result, orderKey) === 'linked';

const SUBJECT = gold('walmart-order-gold', '2030-03-10');
const ROW = row('row-1', '2030-03-15');

describe('card links: the control', () => {
  it('links a subject to its one candidate, as proof, naming its class and rule', () => {
    const result = graph([SUBJECT], [ROW]);
    assert.deepEqual(result.links, [{
      subject: 'walmart-order-gold#0', orderKey: 'walmart-order-gold', tender: 0, evidenceClass: 'walmart-order-total@1',
      rule: 'metals-card-link-v1', amountMinor: 6000, state: 'linked', rowId: 'row-1', candidates: ['row-1'], proof: true,
    }]);
    assert.equal(result.proofByRow.get('row-1'), 'walmart-order-gold#0');
  });

  it('takes rows in the window only, both ends inclusive', () => {
    assert.ok(linked(graph([SUBJECT], [row('r', '2030-03-10')]), SUBJECT.orderKey));
    assert.ok(linked(graph([SUBJECT], [row('r', '2030-04-09')]), SUBJECT.orderKey));
    assert.equal(stateOf(graph([SUBJECT], [row('r', '2030-04-10')]), SUBJECT.orderKey), 'no-candidate');
    assert.equal(stateOf(graph([SUBJECT], [row('r', '2030-03-09')]), SUBJECT.orderKey), 'no-candidate');
  });

  it('never takes a credit, an unusable or non-USD row, another amount, account or merchant class', () => {
    for (const overrides of [{ kind: 'credit' as const }, { usable: false }, { currency: 'CAD' }, { amountMinor: 6001 },
      { accountId: 'acct-b' }, { accountId: 'acct-c' }, { merchantClass: 'costco-online' as const }, { merchantClass: null }]) {
      assert.equal(stateOf(graph([SUBJECT], [row('r', '2030-03-15', 6000, overrides)]), SUBJECT.orderKey), 'no-candidate', JSON.stringify(overrides));
    }
  });

  it('an online receipt never proves a warehouse row', () => {
    const online = gold('costco-order-gold', '2030-03-10', 6000, { source: 'costco' });
    assert.equal(stateOf(graph([online], [row('r', '2030-03-12', 6000, { merchantClass: 'costco-warehouse' })]), online.orderKey), 'no-candidate');
    assert.ok(linked(graph([online], [row('r', '2030-03-12', 6000, { merchantClass: 'costco-online' })]), online.orderKey));
    assert.equal(metalsMerchantClass('costco', 'warehouse'), 'costco-warehouse');
    assert.equal(metalsMerchantClass('collectpure', 'online'), null);
  });
});

describe('card links: binding first (GD-03)', () => {
  it('a unique visible last 4 binds nothing; a suspended binding drifts', () => {
    assert.equal(stateOf(graph([SUBJECT], [ROW], [], []), SUBJECT.orderKey), 'binding-missing');
    const suspended = bindings.map((binding) => ({ ...binding, state: 'suspended' as const }));
    assert.equal(stateOf(graph([SUBJECT], [ROW], [], suspended), SUBJECT.orderKey), 'binding-drift');
    const mastercard = gold('walmart-order-mc', '2030-03-10', 6000, { admission: facts(null, { methods: [card('1111', 6000, 'mastercard')], grossTotalMinor: 6000 }) });
    assert.equal(stateOf(graph([mastercard], [ROW]), mastercard.orderKey), 'binding-missing');
  });

  it('a drifted binding whose account\'s last 4 changed still contests that account, while it exists (C4, as capture does)', () => {
    // acct-a's card was reissued: it shows 2222 now, so the binding approved for 1111 drifted, and one for 2222 is active.
    const reissued = [{ id: 'acct-a', last4: '2222' }, { id: 'acct-b', last4: '3333' }];
    const drifted: MetalsCardBinding[] = [
      { source: 'walmart', network: 'visa', last4: '1111', accountId: 'acct-a', state: 'suspended' },
      { source: 'walmart', network: 'visa', last4: '2222', accountId: 'acct-a', state: 'active' },
    ];
    const newCard = gold('walmart-order-new-card', '2030-03-10', 6000, { admission: facts(6000, { methods: [card('2222', 6000)] }) });
    const oldCard = gold('walmart-order-old-card', '2030-03-08');
    const links = (orders: MetalsFundedOrder[], bound: MetalsCardBinding[]) =>
      metalsCardLinks({ orders, held: [], rows: [ROW], accounts: reissued, bindings: bound });
    // The old card's charge could be the row on acct-a, though no account shows 1111 now: the new card proves nothing.
    const result = links([newCard, oldCard], drifted);
    assert.deepEqual([stateOf(result, oldCard.orderKey), stateOf(result, newCard.orderKey), result.proofByRow.size], ['binding-drift', 'ambiguous', 0]);
    // Alone, the new card links; and a drifted binding whose account is gone contests only the accounts showing its last 4.
    assert.ok(linked(links([newCard], drifted), newCard.orderKey));
    const gone = drifted.map((binding) => (binding.state === 'suspended' ? { ...binding, accountId: 'acct-gone' } : binding));
    assert.ok(linked(links([newCard, oldCard], gone), newCard.orderKey));
  });
});

describe('card links: subjects (GV4-01)', () => {
  it('a refunded order is no subject, and a row equal to its net total links nothing', () => {
    const refunded = gold('walmart-order-refunded', '2030-03-10', 0, { admission: facts(8000, { refunded: true, grossTotalMinor: 10000 }) });
    const result = graph([refunded], [row('r', '2030-03-15', 8000)]);
    assert.deepEqual(result.links, []);
    assert.equal(result.proofByRow.size, 0);
  });

  it('a single group whose charge was split links nothing', () => {
    assert.equal(stateOf(graph([SUBJECT], [row('a', '2030-03-15', 3600), row('b', '2030-03-16', 2400)]), SUBJECT.orderKey), 'no-candidate');
  });

  it('a later refund, cancellation or second group on the active version voids the subject', () => {
    for (const overrides of [{ refunded: true }, { cancelled: true }, { partlyCancelled: true }, { fulfilment: { shipments: 2 } }]) {
      const voided = { ...SUBJECT, admission: facts(6000, overrides) };
      assert.deepEqual(graph([voided], [ROW]).links, [], JSON.stringify(overrides));
    }
  });

  it('a quarantined or superseded order proves nothing: its one clean row is a candidate only', () => {
    const result = graph([{ ...SUBJECT, active: false }], [ROW]);
    assert.equal(stateOf(result, SUBJECT.orderKey), 'ineligible');
    assert.equal(result.links[0].rowId, 'row-1');
    assert.equal(result.links[0].proof, false);
    assert.equal(result.proofByRow.size, 0);
  });

  it('each tender of a warehouse receipt is its own subject, in the warehouse window', () => {
    const receipt = gold('costco-receipt-gold', '2030-03-10', 0, {
      source: 'costco', channel: 'warehouse',
      admission: facts(null, { fulfilment: 'in-store', methods: [card('1111', 7000), card('1111', 3000)], grossTotalMinor: 10000 }),
    });
    const rows = [row('w1', '2030-03-10', 7000, { merchantClass: 'costco-warehouse' }), row('w2', '2030-03-15', 3000, { merchantClass: 'costco-warehouse' })];
    const result = graph([receipt], rows);
    assert.deepEqual(result.links.map((link) => [link.tender, link.state, link.rowId]), [[0, 'linked', 'w1'], [1, 'linked', 'w2']]);
    const late = graph([receipt], [rows[0], { ...rows[1], date: '2030-03-16' }]);
    assert.equal(stateOf(late, receipt.orderKey, 1), 'no-candidate');
  });
});

describe('card links: barriers, tested on each row\'s own date (GV4-02, GV5-01)', () => {
  it('a held order of March 1 bars a March 15 row a gold order of March 10 would take, on both interval boundaries', () => {
    const held = (date: string | null): MetalsHeldOrder => ({ source: 'walmart', channel: 'online', date });
    assert.equal(stateOf(graph([SUBJECT], [ROW], [held('2030-03-01')]), SUBJECT.orderKey), 'competitor-held');
    assert.equal(stateOf(graph([SUBJECT], [ROW], [held('2030-02-13')]), SUBJECT.orderKey), 'competitor-held');
    assert.equal(stateOf(graph([SUBJECT], [ROW], [held('2030-03-15')]), SUBJECT.orderKey), 'competitor-held');
    assert.ok(linked(graph([SUBJECT], [ROW], [held('2030-02-12')]), SUBJECT.orderKey));
    assert.ok(linked(graph([SUBJECT], [ROW], [held('2030-03-16')]), SUBJECT.orderKey));
  });

  it('an undated held record bars every row of its class at any date; another class bars nothing', () => {
    assert.equal(stateOf(graph([SUBJECT], [ROW], [{ source: 'walmart', channel: 'online', date: null }]), SUBJECT.orderKey), 'competitor-held');
    assert.ok(linked(graph([SUBJECT], [ROW], [{ source: 'costco', channel: 'online', date: null }]), SUBJECT.orderKey));
  });

  it('a two-shipment competitor totaling 10000 removes the link to a 6000 row, imported before or after the subject', () => {
    const twoGroups = other('walmart-order-two', '2030-03-05', facts(10000, { fulfilment: { shipments: 2 } }));
    assert.equal(stateOf(graph([SUBJECT, twoGroups], [ROW]), SUBJECT.orderKey), 'competitor-unknown');
    assert.equal(stateOf(graph([twoGroups, SUBJECT], [ROW]), SUBJECT.orderKey), 'competitor-unknown');
    const metalTwoGroups = { ...twoGroups, metal: true };
    assert.equal(stateOf(graph([SUBJECT, metalTwoGroups], [ROW]), SUBJECT.orderKey), 'competitor-unknown');
  });

  it('a refunded order\'s net total doesn\'t free its original gross charge', () => {
    const refunded = other('walmart-order-refunded', '2030-03-05', facts(4000, { refunded: true, grossTotalMinor: 6000 }));
    assert.equal(stateOf(graph([SUBJECT, refunded], [ROW]), SUBJECT.orderKey), 'competitor-unknown');
  });

  it('an unknown-amount order bars any amount; a multi-method one bars up to its gross total, on any account', () => {
    const unknown = other('walmart-order-unknown', '2030-03-05', facts(null, { methods: [card(null, null)], grossTotalMinor: null }));
    assert.equal(stateOf(graph([SUBJECT, unknown], [ROW]), SUBJECT.orderKey), 'competitor-unknown');
    const unknownMetal = { ...unknown, orderKey: 'walmart-order-unknown-gold', metal: true };
    const withMetal = graph([SUBJECT, unknownMetal], [ROW]);
    assert.equal(stateOf(withMetal, SUBJECT.orderKey), 'competitor-unknown');
    assert.equal(stateOf(withMetal, unknownMetal.orderKey), undefined, 'an unknown-amount metal order is no subject');
    const twoMethods = other('walmart-order-two-methods', '2030-03-05', facts(null, { methods: [card('2222', 3000), card('2222', 3000)], grossTotalMinor: 6000 }));
    assert.equal(stateOf(graph([SUBJECT, twoMethods], [ROW]), SUBJECT.orderKey), 'competitor-unknown');
  });

  it('rows above an aggregate\'s gross total, other channels and non-overlapping intervals gain no barrier', () => {
    const small = other('walmart-order-small', '2030-03-05', facts(5999, { fulfilment: { shipments: 2 } }));
    assert.ok(linked(graph([SUBJECT, small], [ROW]), SUBJECT.orderKey));
    const costco = other('costco-order-agg', '2030-03-05', facts(10000, { fulfilment: { shipments: 2 } }), { source: 'costco' });
    assert.ok(linked(graph([SUBJECT, costco], [ROW]), SUBJECT.orderKey));
    const later = other('walmart-order-later', '2030-03-16', facts(10000, { fulfilment: { shipments: 2 } }));
    assert.ok(linked(graph([SUBJECT, later], [ROW]), SUBJECT.orderKey));
    const earlier = other('walmart-order-earlier', '2030-02-12', facts(10000, { fulfilment: { shipments: 2 } }));
    assert.ok(linked(graph([SUBJECT, earlier], [ROW]), SUBJECT.orderKey));
  });

  it('a competitor whose funding contradicts itself bars rows of any amount, even above its stated gross total (G1A-05)', () => {
    const subject = gold('walmart-order-gold-big', '2030-03-10', 15000);
    const bigRow = row('row-big', '2030-03-15', 15000);
    assert.ok(linked(graph([subject], [bigRow]), subject.orderKey));
    const credit = other('walmart-order-credit', '2030-03-05', facts(null, {
      methods: [card('2222', 12000), { kind: 'gift-card', network: 'unknown', last4: null, amountMinor: -2000 }], grossTotalMinor: 10000,
    }));
    const overstated = other('walmart-order-overstated', '2030-03-05', facts(null, { methods: [card('2222', 12000)], grossTotalMinor: 10000 }));
    assert.equal(stateOf(graph([subject, credit], [bigRow]), subject.orderKey), 'competitor-unknown');
    assert.equal(stateOf(graph([subject, overstated], [bigRow]), subject.orderKey), 'competitor-unknown');
    const consistent = other('walmart-order-consistent', '2030-03-05', facts(10000, { fulfilment: { shipments: 2 } }));
    assert.ok(linked(graph([subject, consistent], [bigRow]), subject.orderKey), 'a consistent aggregate bars only up to its gross total');
  });
});

describe('card links: contests, one each way', () => {
  it('a single-charge competitor contests exactly its amount on its account scope', () => {
    const same = other('walmart-order-same', '2030-03-12', facts(6000));
    assert.equal(stateOf(graph([SUBJECT, same], [ROW]), SUBJECT.orderKey), 'ambiguous');
    const otherAmount = other('walmart-order-other', '2030-03-12', facts(5000));
    assert.ok(linked(graph([SUBJECT, otherAmount], [ROW]), SUBJECT.orderKey));
    const otherAccount = other('walmart-order-b', '2030-03-12', facts(6000, { methods: [card('2222', 6000)] }));
    assert.ok(linked(graph([SUBJECT, otherAccount], [ROW]), SUBJECT.orderKey));
  });

  it('an unbound identity with a matching last 4 contests; a last 4 no account has doesn\'t; no last 4 contests everywhere', () => {
    const suffix = other('walmart-order-mc', '2030-03-12', facts(6000, { methods: [card('1111', 6000, 'mastercard')] }));
    assert.equal(stateOf(graph([SUBJECT, suffix], [ROW]), SUBJECT.orderKey), 'ambiguous');
    const stranger = other('walmart-order-9', '2030-03-12', facts(6000, { methods: [card('9999', 6000)] }));
    assert.ok(linked(graph([SUBJECT, stranger], [ROW]), SUBJECT.orderKey));
    const anonymous = other('walmart-order-anon', '2030-03-12', facts(6000, { methods: [card(null, 6000)] }));
    assert.equal(stateOf(graph([SUBJECT, anonymous], [ROW]), SUBJECT.orderKey), 'ambiguous');
  });

  it('two subjects that could take one row both stay unlinked, even when one is quarantined', () => {
    const second = gold('walmart-order-gold-2', '2030-03-12');
    const result = graph([SUBJECT, second], [ROW]);
    assert.deepEqual([stateOf(result, SUBJECT.orderKey), stateOf(result, second.orderKey)], ['ambiguous', 'ambiguous']);
    assert.equal(stateOf(graph([SUBJECT, { ...second, active: false }], [ROW]), SUBJECT.orderKey), 'ambiguous');
  });

  it('two candidate rows are ambiguous', () => {
    assert.equal(stateOf(graph([SUBJECT], [ROW, row('row-2', '2030-03-20')]), SUBJECT.orderKey), 'ambiguous');
  });

  it('refuses a ledger that lists one order twice', () => {
    assert.throws(() => graph([SUBJECT, SUBJECT], [ROW]));
  });
});

/** A seeded generator (mulberry32): deterministic, every bit in play, so small bounds vary too. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return (bound: number) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * bound);
  };
}

describe('card links: monotone (property)', () => {
  it('adding a competitor, a barrier, a conflict or another candidate row never creates a link (seeded)', () => {
    const next = seeded(7);
    const day = (offset: number) => new Date(Date.UTC(2030, 2, 1) + offset * 86_400_000).toISOString().slice(0, 10);
    const proofs = (result: MetalsCardLinkGraph) => new Set(result.links.filter((link) => link.proof).map((link) => `${link.subject}>${link.rowId}`));
    let linksSeen = 0;
    for (let round = 0; round < 400; round += 1) {
      const amounts = [3000, 6000, 9000];
      const orders: MetalsFundedOrder[] = [];
      for (let index = 0; index < 1 + next(4); index += 1) {
        orders.push(gold(`walmart-order-${round}-${index}`, day(next(40)), amounts[next(3)], { active: next(5) !== 0 }));
      }
      const rows: MetalsCardRow[] = [];
      for (let index = 0; index < 1 + next(5); index += 1) {
        rows.push(row(`row-${round}-${index}`, day(next(60)), amounts[next(3)], { accountId: ['acct-a', 'acct-b', 'acct-c'][next(3)] }));
      }
      const held: MetalsHeldOrder[] = [];
      const base = graph(orders, rows, held);
      const before = proofs(base);
      linksSeen += before.size;
      const variants: Array<[MetalsFundedOrder[], MetalsCardRow[], MetalsHeldOrder[]]> = [
        [[...orders, other(`walmart-order-c-${round}`, day(next(40)), facts(amounts[next(3)]))], rows, held],
        [[...orders, other(`walmart-order-a-${round}`, day(next(40)), facts(amounts[next(3)], { fulfilment: { shipments: 2 } }))], rows, held],
        [[...orders, other(`walmart-order-u-${round}`, day(next(40)), facts(null, { methods: [card(null, null)], grossTotalMinor: null }))], rows, held],
        [orders, rows, [...held, { source: 'walmart', channel: 'online', date: next(4) === 0 ? null : day(next(40)) }]],
        [orders.map((order, index) => (index === 0 ? { ...order, active: false } : order)), rows, held],
        // Another candidate row: a second row wherever an existing one is a candidate.
        [orders, [...rows, { ...rows[next(rows.length)], id: `row-again-${round}` }], held],
      ];
      for (const [variantOrders, variantRows, variantHeld] of variants) {
        const after = proofs(graph(variantOrders, variantRows, variantHeld));
        for (const proof of after) assert.ok(before.has(proof), `round ${round}: a new link ${proof}`);
      }
      // A brand-new row may be a subject's first candidate, and only then can it link: never a subject that had one.
      const hadCandidate = new Set(base.links.filter((link) => link.candidates.length > 0).map((link) => link.subject));
      const fresh = row(`row-new-${round}`, day(next(60)), amounts[next(3)]);
      for (const link of graph(orders, [...rows, fresh], held).links) {
        if (!link.proof || before.has(`${link.subject}>${link.rowId}`)) continue;
        assert.ok(!hadCandidate.has(link.subject) && link.rowId === fresh.id, `round ${round}: a new link ${link.subject}>${link.rowId}`);
      }
    }
    assert.ok(linksSeen > 20, `the generated ledgers link something (${linksSeen})`);
  });
});
