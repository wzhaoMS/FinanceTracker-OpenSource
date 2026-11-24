import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cardSyncActorRef } from '../cardSyncDigests.js';
import { SqliteStateRepo } from '../sqliteStateRepo.js';
import { importAmazonCapture, recordBindingProposal, recordRootApproval, backedUpWrite } from './importer.js';
// STEP 9 integration (B5)
import { activeBindings, proposeBindings, readCardInventory } from './bindings.js';
import { rootApproval, syntheticCapture } from './fixtures.testSupport.js';
import { readLedger } from './matcher.js';
import { createAmazonCategoryResolver } from './resolver.js';
import { amazonSummary } from './readModel.js';
// STEP 9 integration (B5)
import { digest, opaque, SOURCE } from './policy.js';
import { allocateOrder, lineTieKeys, type OrderSnapshot } from './allocation.js';
import {
  // STEP 9 integration (B5)
  decideRefundCredits, itemizeRefundCredits, lagDays, orderChargeSnapshots, orderHistoryBound, readRefundEvidence, refundCreditCalibration,
  REFUND_CREDIT_POLICY,
  REFUND_HOLD_REASONS, REFUND_ORDER_PROOFS, refundOrderFacts, refundTotalsContradict, subsetIndex, subsetItemSets, taxShare,
  type RefundCharge, type RefundCreditPolicy, type RefundDecision, type RefundOrder, type RefundOrderSnapshot,
} from './refundCredits.js';
import { getAmazonOrder } from './readModel.js';
import { productKey } from './products.js';
import type { MatchSubject, OrderObservation, Resolution, Staging } from './types.js';

// SYNTHETIC ONLY: invented refs, cards, dates and amounts. The vectors are the C-MATCHING-SPEC draft 1 reference's.
type OrderSpec = {
  ref: string; date?: string; observedThrough?: string; lines?: Array<{ key?: string; unit: number; qty?: number }>;
  itemsSubtotalMinor?: number; taxMinor?: number; shippingMinor?: number; totalMinor?: number | null; refundSummaryMinor?: number;
  adjustments?: boolean; itemsComplete?: boolean; tender?: string; chargeCards?: string[]; destinationCards?: string[];
};
const order = (o: OrderSpec): RefundOrder => {
  const lines = (o.lines ?? []).map((l, i) => ({ key: l.key ?? `line:${i + 1}`, unitMinor: l.unit, qty: l.qty ?? 1 }));
  const sub = o.itemsSubtotalMinor ?? (lines.length ? lines.reduce((n, l) => n + l.unitMinor * l.qty, 0) : null);
  const tax = o.taxMinor ?? 0;
  return { ref: o.ref, date: o.date ?? '2031-01-10', observedThrough: o.observedThrough ?? o.date ?? '2031-01-10',
    totalMinor: o.totalMinor !== undefined ? o.totalMinor : sub === null ? null : sub + tax + (o.shippingMinor ?? 0),
    refundSummaryMinor: o.refundSummaryMinor ?? null, itemsSubtotalMinor: sub, taxMinor: tax, adjustments: o.adjustments ?? false,
    summaryProven: true,
    itemsComplete: o.itemsComplete ?? true, lines, tender: (o.tender ?? 'single-card-proven') === 'single-card-proven' ? 'single-card-proven' : 'other',
    chargeCards: o.chargeCards ?? ['card-X'], destinationCards: o.destinationCards ?? [], contradictory: false };
};
const credit = (id: string, amountMinor: number, date: string, extra: Record<string, unknown> = {}) =>
  ({ id, cardAccountId: 'card-X', date, amountMinor, inScope: true, alreadyLinked: false, ...extra });
const A: OrderSpec = { ref: 'order-A', lines: [{ key: 'item-1', unit: 2000 }, { key: 'item-2', unit: 1500, qty: 2 }], taxMinor: 400 };
const pair = (ref: string, unit: number, other: number, extra: Partial<OrderSpec> = {}): OrderSpec =>
  ({ ref, lines: [{ key: `${ref}-x`, unit }, { key: `${ref}-y`, unit: other }], ...extra });
type Scenario = { name: string; orders: OrderSpec[]; credits: ReturnType<typeof credit>[]; existingClaims?: Record<string, number>;
  policy?: RefundCreditPolicy; expect: Record<string, Record<string, unknown>> };
const literal: RefundCreditPolicy = { ...REFUND_CREDIT_POLICY, competitors: 'literal' };
/** The spec draft's own default: the vectors were written for it. */
const conservative: RefundCreditPolicy = { ...REFUND_CREDIT_POLICY, competitors: 'conservative' };

const SCENARIOS: Scenario[] = [
  { name: 'subset: one unit of a 2-unit line, tax-inclusive', orders: [A], credits: [credit('c1', 1620, '2031-01-20')],
    expect: { c1: { outcome: 'linked', orderRef: 'order-A', proof: 'subset', itemAttribution: 'unique', lagDays: 10,
      attribution: [{ key: 'item-2', unitMinor: 1500, units: 1 }] } } },
  { name: 'subset: both units of a line', orders: [A], credits: [credit('c1', 3240, '2031-01-20')],
    expect: { c1: { outcome: 'linked', attribution: [{ key: 'item-2', unitMinor: 1500, units: 2 }] } } },
  { name: 'subset: two different lines', orders: [A], credits: [credit('c1', 3780, '2031-01-20')],
    expect: { c1: { outcome: 'linked', attribution: [{ key: 'item-1', unitMinor: 2000, units: 1 }, { key: 'item-2', unitMinor: 1500, units: 1 }] } } },
  { name: 'full order equals the observed grand total', orders: [A], credits: [credit('c1', 5400, '2031-01-20')],
    expect: { c1: { outcome: 'linked', proof: 'full-order+subset', itemAttribution: 'unique' } } },
  { name: 'one cent off is no candidate', orders: [A], credits: [credit('c1', 1621, '2031-01-20')],
    expect: { c1: { outcome: 'held', reason: 'no-candidate' } } },
  { name: 'credit dated before the order', orders: [A], credits: [credit('c1', 1620, '2031-01-09')],
    expect: { c1: { outcome: 'held', reason: 'no-candidate' } } },
  { name: 'window edge: lag 90 inclusive', orders: [A], credits: [credit('c1', 1620, '2031-04-10')],
    expect: { c1: { outcome: 'linked', lagDays: 90 } } },
  { name: 'window edge: lag 91 excluded', orders: [A], credits: [credit('c1', 1620, '2031-04-11')],
    expect: { c1: { outcome: 'held', reason: 'no-candidate' } } },
  { name: 'same day allowed (minLag 0)', orders: [A], credits: [credit('c1', 1620, '2031-01-10')],
    expect: { c1: { outcome: 'linked', lagDays: 0 } } },
  { name: 'order proven on another card is excluded', orders: [A], credits: [credit('c1', 1620, '2031-01-20', { cardAccountId: 'card-Y' })],
    expect: { c1: { outcome: 'held', reason: 'no-candidate' } } },
  { name: 'refund summary plus a unique subset (shipping not refunded)',
    orders: [{ ref: 'order-B', date: '2031-02-01', lines: [{ key: 'item-3', unit: 1999 }, { key: 'item-4', unit: 2999 }], shippingMinor: 599,
      refundSummaryMinor: 2999, observedThrough: '2031-03-01' }], credits: [credit('c1', 2999, '2031-02-15')],
    expect: { c1: { outcome: 'linked', proof: 'refund-summary+subset', itemAttribution: 'unique', attribution: [{ key: 'item-4', unitMinor: 2999, units: 1 }] } } },
  { name: 'refund summary with ambiguous items links the order only',
    orders: [{ ref: 'order-C', lines: [{ key: 'item-5', unit: 1000 }, { key: 'item-6', unit: 1000 }], refundSummaryMinor: 1000, observedThrough: '2031-02-01' }],
    credits: [credit('c1', 1000, '2031-01-20')],
    expect: { c1: { outcome: 'linked', proof: 'refund-summary+subset', itemAttribution: 'held', attribution: null } } },
  { name: 'subset only with two different item sets is held',
    orders: [{ ref: 'order-D', lines: [{ key: 'item-7', unit: 1000 }, { key: 'item-8', unit: 1000 }] }], credits: [credit('c1', 1000, '2031-01-20')],
    expect: { c1: { outcome: 'held', reason: 'ambiguous-subset' } } },
  { name: 'the same item on two lines is one item set',
    orders: [{ ref: 'order-E', lines: [{ key: 'item-9', unit: 1250 }, { key: 'item-9', unit: 1250 }] }], credits: [credit('c1', 1250, '2031-01-20')],
    expect: { c1: { outcome: 'linked', itemAttribution: 'unique', attribution: [{ key: 'item-9', unitMinor: 1250, units: 1 }] } } },
  { name: 'two orders on the same card explain the amount', orders: [pair('order-F1', 999, 500), pair('order-F2', 999, 700)],
    credits: [credit('c1', 999, '2031-01-20')], expect: { c1: { outcome: 'held', reason: 'ambiguous-order', candidates: 2 } } },
  { name: 'conservative: an order with an unknown card still competes',
    orders: [pair('order-G1', 1500, 400), pair('order-G2', 1500, 600, { chargeCards: [], tender: 'unknown' })],
    credits: [credit('c1', 1500, '2031-01-20')], expect: { c1: { outcome: 'held', reason: 'ambiguous-order', candidates: 2 } } },
  { name: 'literal: only proven same-card orders compete', policy: literal,
    orders: [pair('order-G1', 1500, 400), pair('order-G2', 1500, 600, { chargeCards: [], tender: 'unknown' })],
    credits: [credit('c1', 1500, '2031-01-20')], expect: { c1: { outcome: 'linked', orderRef: 'order-G1' } } },
  { name: 'an order proven on another card does not compete',
    orders: [pair('order-G1', 1500, 400), pair('order-G2', 1500, 600, { chargeCards: ['card-Y'] })],
    credits: [credit('c1', 1500, '2031-01-20')], expect: { c1: { outcome: 'linked', orderRef: 'order-G1' } } },
  { name: 'unique order but its card is unproven', orders: [pair('order-H', 1500, 400, { chargeCards: [], tender: 'unknown' })],
    credits: [credit('c1', 1500, '2031-01-20')], expect: { c1: { outcome: 'held', reason: 'card-unproven' } } },
  { name: 'a proven refund destination proves the card',
    orders: [pair('order-H', 1500, 400, { chargeCards: [], tender: 'unknown', destinationCards: ['card-X'] })],
    credits: [credit('c1', 1500, '2031-01-20')], expect: { c1: { outcome: 'linked', orderRef: 'order-H' } } },
  { name: 'conservative: an order with a promotion competes when the amount fits',
    orders: [pair('order-I1', 1500, 400), { ref: 'order-I2', lines: [{ unit: 2600 }, { unit: 2600 }], adjustments: true, totalMinor: 5000 }],
    credits: [credit('c1', 1500, '2031-01-20')], expect: { c1: { outcome: 'held', reason: 'ambiguous-order', candidates: 2 } } },
  { name: 'literal: the promotion order does not compete', policy: literal,
    orders: [pair('order-I1', 1500, 400), { ref: 'order-I2', lines: [{ unit: 2600 }, { unit: 2600 }], adjustments: true, totalMinor: 5000 }],
    credits: [credit('c1', 1500, '2031-01-20')], expect: { c1: { outcome: 'linked', orderRef: 'order-I1' } } },
  { name: 'promotion order proven by its refund summary (items held)',
    orders: [{ ref: 'order-J', lines: [{ unit: 2600 }, { unit: 2600 }], adjustments: true, totalMinor: 5000, refundSummaryMinor: 1234, observedThrough: '2031-02-01' }],
    credits: [credit('c1', 1234, '2031-01-20')], expect: { c1: { outcome: 'linked', proof: 'refund-summary', itemAttribution: 'held' } } },
  { name: 'promotion order without an exact proof',
    orders: [{ ref: 'order-K', lines: [{ unit: 2600 }, { unit: 2600 }], adjustments: true, totalMinor: 5000 }],
    credits: [credit('c1', 777, '2031-01-20')], expect: { c1: { outcome: 'held', reason: 'order-unprovable' } } },
  { name: 'capacity: refund summary observed after both credits',
    orders: [{ ref: 'order-L', lines: [{ key: 'item-10', unit: 3000, qty: 2 }], refundSummaryMinor: 3000, observedThrough: '2031-02-01' }],
    credits: [credit('c1', 3000, '2031-01-20'), credit('c2', 3000, '2031-01-25')],
    expect: { c1: { outcome: 'held', reason: 'capacity-exceeded' }, c2: { outcome: 'held', reason: 'capacity-exceeded' } } },
  { name: 'capacity: second refund after the observation fits the total',
    orders: [{ ref: 'order-L', lines: [{ key: 'item-10', unit: 3000, qty: 2 }], refundSummaryMinor: 3000, observedThrough: '2031-01-22' }],
    credits: [credit('c1', 3000, '2031-01-20'), credit('c2', 3000, '2031-01-25')],
    expect: { c1: { outcome: 'linked', proof: 'refund-summary+subset' }, c2: { outcome: 'linked', proof: 'refund-summary+subset' } } },
  { name: 'capacity: a line returned twice exceeds its quantity',
    orders: [{ ref: 'order-M', lines: [{ key: 'item-11', unit: 1500 }, { key: 'item-12', unit: 2500 }] }],
    credits: [credit('c1', 1500, '2031-01-20'), credit('c2', 1500, '2031-01-27')],
    expect: { c1: { outcome: 'held', reason: 'capacity-exceeded' }, c2: { outcome: 'held', reason: 'capacity-exceeded' } } },
  { name: 'capacity: an existing ledger refund link counts',
    orders: [{ ref: 'order-N', lines: [{ key: 'item-13', unit: 2000 }, { key: 'item-14', unit: 3000 }], refundSummaryMinor: 2000, observedThrough: '2031-03-01' }],
    existingClaims: { 'order-N': 2000 }, credits: [credit('c1', 2000, '2031-01-20')],
    expect: { c1: { outcome: 'held', reason: 'capacity-exceeded' } } },
  { name: 'already linked and out of scope are untouched', orders: [A],
    credits: [credit('c1', 1620, '2031-01-20', { alreadyLinked: true }), credit('c2', 1620, '2031-01-20', { inScope: false })],
    expect: { c1: { outcome: 'already-linked' }, c2: { outcome: 'out-of-scope' } } },
  { name: 'tax share rounds half up to the cent',
    orders: [{ ref: 'order-P', lines: [{ key: 'item-15', unit: 1000 }, { key: 'item-16', unit: 3000 }], taxMinor: 250 }],
    credits: [credit('c1', 1063, '2031-01-20'), credit('c2', 1062, '2031-01-20')],
    expect: { c1: { outcome: 'linked', attribution: [{ key: 'item-15', unitMinor: 1000, units: 1 }] }, c2: { outcome: 'held', reason: 'no-candidate' } } },
  { name: 'search bound: 13 lines are not enumerated, the full order still proves',
    orders: [{ ref: 'order-Q', lines: Array.from({ length: 13 }, (_, i) => ({ key: `item-q${i + 1}`, unit: 100 * (i + 1) })) }],
    credits: [credit('c1', 300, '2031-01-20'), credit('c2', 9100, '2031-01-21')],
    expect: { c1: { outcome: 'held', reason: 'order-unprovable' }, c2: { outcome: 'linked', proof: 'full-order', itemAttribution: 'unique' } } },
];

const run = (s: Scenario, policy: RefundCreditPolicy = s.policy ?? conservative, orders = s.orders.map(order), credits = s.credits) =>
  decideRefundCredits({ orders, credits, existingClaims: new Map(Object.entries(s.existingClaims ?? {})
    .map(([ref, amountMinor]) => [ref, [{ amountMinor, date: orders.find(o => o.ref === ref)!.date }]])) }, policy);
const pick = (actual: RefundDecision | undefined, expected: Record<string, unknown>) =>
  Object.fromEntries(Object.keys(expected).map(k => [k, (actual as Record<string, unknown> | undefined)?.[k]]));
const passes = (s: Scenario, policy?: RefundCreditPolicy) => {
  const got = run(s, policy);
  return got.size === s.credits.length && Object.entries(s.expect).every(([id, want]) => JSON.stringify(pick(got.get(id), want)) === JSON.stringify(want));
};

describe('exact-cents refund proof: the C-MATCHING-SPEC draft 1 vectors', () => {
  it('computes the reference arithmetic: half-up tax shares and calendar-day lags', () => {
    expect([taxShare(1000, 250, 4000), taxShare(3000, 250, 4000), taxShare(1500, 400, 5000), taxShare(1500, 0, 5000)]).toEqual([63, 188, 120, 0]);
    expect([lagDays('2031-01-10', '2031-04-10'), lagDays('2032-02-28', '2032-03-01')]).toEqual([90, 2]);
  });
  it.each(SCENARIOS.map(s => [s.name, s] as const))('%s', (_name, s) => {
    const got = run(s);
    expect(got.size).toBe(s.credits.length);
    for (const [id, want] of Object.entries(s.expect)) expect(pick(got.get(id), want), id).toEqual(want);
    // Never dependent on input order.
    const orders = s.orders.map(order);
    const flipped = run(s, undefined, [...orders].reverse(), [...s.credits].reverse());
    const rotated = run(s, undefined, [...orders.slice(1), ...orders.slice(0, 1)]);
    expect([...flipped]).toEqual([...got]);
    expect([...rotated]).toEqual([...got]);
  });
  it('catches each policy mutant: window edges, competitor policy and the subset bounds', () => {
    const named = (name: string) => SCENARIOS.find(s => s.name === name)!;
    expect(passes(named('window edge: lag 90 inclusive'), { ...REFUND_CREDIT_POLICY, maxLagDays: 89 })).toBe(false);
    expect(passes(named('window edge: lag 91 excluded'), { ...REFUND_CREDIT_POLICY, maxLagDays: 91 })).toBe(false);
    expect(passes(named('same day allowed (minLag 0)'), { ...REFUND_CREDIT_POLICY, minLagDays: 1 })).toBe(false);
    expect(passes(named('conservative: an order with an unknown card still competes'), literal)).toBe(false);
    expect(passes(named('search bound: 13 lines are not enumerated, the full order still proves'),
      { ...REFUND_CREDIT_POLICY, maxLines: 13, maxCombos: 8191 })).toBe(false);
    expect(passes(named('subset: both units of a line'), { ...REFUND_CREDIT_POLICY, maxCombos: 4 })).toBe(false);
    for (const s of SCENARIOS) expect(passes(s), s.name).toBe(true);
  });
  it('hybrid, the default (Root): (a) a refund-total match outranks possible orders, (b) two proven stay held, (c) subsets stay conservative, (d) negatives unchanged', () => {
    const hybrid: RefundCreditPolicy = { ...REFUND_CREDIT_POLICY, competitors: 'hybrid' };
    expect(REFUND_CREDIT_POLICY.competitors).toBe('hybrid');
    const r = order({ ref: 'order-R', lines: [{ unit: 2600 }, { unit: 2600 }], adjustments: true, totalMinor: 5000,
      refundSummaryMinor: 1500, observedThrough: '2031-02-01' });
    const possible = order({ ref: 'order-Q', lines: [{ unit: 2600 }, { unit: 2600 }], adjustments: true, totalMinor: 5000,
      chargeCards: [], tender: 'unknown' });
    const decide = (orders: RefundOrder[], policy: RefundCreditPolicy = hybrid) =>
      decideRefundCredits({ orders, credits: [credit('c1', 1500, '2031-01-20')] }, policy).get('c1');
    // (a) Conservative holds it; the hybrid lets the exact refund-total match on the order's card link.
    expect(decide([r, possible], conservative)).toMatchObject({ outcome: 'held', reason: 'ambiguous-order', candidates: 2 });
    expect(decide([r, possible])).toMatchObject({ outcome: 'linked', orderRef: 'order-R', proof: 'refund-summary', itemAttribution: 'held' });
    // (b) Two orders proving it on the card stay ambiguous; never the nearer one.
    expect(decide([r, { ...r, ref: 'order-R2' }])).toEqual({ outcome: 'held', reason: 'ambiguous-order', candidates: 2 });
    expect(decide([r, { ...r, ref: 'order-R2', date: '2031-01-19' }])).toEqual({ outcome: 'held', reason: 'ambiguous-order', candidates: 2 });
    // (c) Without a refund-total proof on the card, the hybrid is conservative: possible orders still compete.
    expect(decide([order(pair('order-G1', 1500, 400)), possible])).toEqual({ outcome: 'held', reason: 'ambiguous-order', candidates: 2 });
    expect(decide([{ ...r, chargeCards: [], tender: 'other' }, possible])).toEqual({ outcome: 'held', reason: 'ambiguous-order', candidates: 2 });
    expect(decide([{ ...r, refundSummaryMinor: null, totalMinor: 1500 }, possible])).toEqual({ outcome: 'held', reason: 'ambiguous-order', candidates: 2 });
    // (d) Every spec vector written for the conservative default holds under the hybrid too.
    expect(SCENARIOS.filter(s => !s.policy && !passes(s, hybrid)).map(s => s.name)).toEqual([]);
  });
  it('holds an order whose own history conflicts: it competes for what it could explain, never proves', () => {
    const conflicting = { ...order(A), contradictory: true };
    expect(decideRefundCredits({ orders: [conflicting], credits: [credit('c1', 5400, '2031-01-20')] }).get('c1'))
      .toEqual({ outcome: 'held', reason: 'order-unprovable', candidates: 1 });
    const other = order({ ref: 'order-Z', lines: [{ key: 'item-z', unit: 5400 }] });
    expect(decideRefundCredits({ orders: [conflicting, other], credits: [credit('c1', 5400, '2031-01-20')] }).get('c1'))
      .toMatchObject({ outcome: 'held', reason: 'ambiguous-order', candidates: 2 });
  });
  it('never proves a unit subset from an unproven summary: unknown tax is no zero tax (independent review)', () => {
    // Items 1000 + 2000, total 3300, no tax line and an unknown summary: the 300 could be tax, shipping or anything.
    const observed: OrderObservation = { orderId: '111-2222222-3333333', date: '2026-10-01', total: usd(3300),
      items: [1000, 2000].map((amount, lineOrdinal) => ({ lineOrdinal, itemId: null, title: 'Synthetic item', quantity: 1, unitPrice: usd(amount) })),
      summary: [{ kind: 'items-subtotal', money: usd(3000) }, { kind: 'shipping', money: usd(0) }, { kind: 'grand-total', money: usd(3300) }],
      itemProof: { complete: true, unknownLine: false, conflict: false }, paymentMethods: [{ kind: 'card', network: 'visa', last4: '9001' }],
      tenderCoverage: 'unknown',
      tenderProof: { methodComplete: true, summaryComplete: false, unknownMethod: false, unknownSummary: true, conflict: false } };
    const decide = (o: OrderObservation, amountMinor: number) => {
      const { total: _total, ...facts } = refundOrderFacts('order-S', o, '2026-10-19', 3, false);
      return decideRefundCredits({ orders: [{ ...facts, chargeCards: ['card-X'], destinationCards: [] }],
        credits: [{ id: 'c1', cardAccountId: 'card-X', date: '2026-10-12', amountMinor, inScope: true, alreadyLinked: false }] }).get('c1');
    };
    expect(refundOrderFacts('order-S', observed, '2026-10-19', 3, false)).toMatchObject({ summaryProven: false, itemsComplete: true });
    // It still competes for what it could explain, and its grand total still proves.
    expect(decide(observed, 1000)).toEqual({ outcome: 'held', reason: 'order-unprovable', candidates: 1 });
    expect(decide(observed, 3300)).toMatchObject({ outcome: 'linked', proof: 'full-order', itemAttribution: 'unique' });
    // With the tax line and a complete summary proven, only the tax-inclusive price proves: never the pre-tax one.
    const proven: OrderObservation = { ...observed, summary: [...observed.summary!.slice(0, 2), { kind: 'tax', money: usd(300) },
      observed.summary![2]], tenderProof: { ...observed.tenderProof!, summaryComplete: true, unknownSummary: false } };
    expect(refundOrderFacts('order-S', proven, '2026-10-19', 3, false)).toMatchObject({ summaryProven: true, taxMinor: 300 });
    expect(decide(proven, 1100)).toMatchObject({ outcome: 'linked', proof: 'subset', attribution: [{ key: 'line:0', unitMinor: 1000, units: 1 }] });
    expect(decide(proven, 1000)).toEqual({ outcome: 'held', reason: 'no-candidate', candidates: 0 });
    // A summary that does not add up is no proof either.
    expect(refundOrderFacts('order-S', { ...proven, summary: proven.summary!.map(s => s.kind === 'tax' ? { ...s, money: usd(299) } : s) },
      '2026-10-19', 3, false).summaryProven).toBe(false);
  });
  it('keeps a contradictory order competing on every amount its history explains (independent review)', () => {
    // Order A's latest total is 1000, but an earlier observation showed 2000: a 2000 credit could be A's as well as B's.
    const a = { ...order({ ref: 'order-A', lines: [{ key: 'item-a', unit: 1000 }] }), contradictory: true, historyBoundMinor: 2000 };
    const b = order({ ref: 'order-B', lines: [{ key: 'item-b', unit: 2000 }] });
    const decide = (orders: RefundOrder[]) => decideRefundCredits({ orders, credits: [credit('c1', 2000, '2031-01-20')] }).get('c1');
    expect(decide([a, b])).toEqual({ outcome: 'held', reason: 'ambiguous-order', candidates: 2 });
    expect(decide([{ ...a, historyBoundMinor: null }, b])).toMatchObject({ outcome: 'linked', orderRef: 'order-B' });
    expect(orderHistoryBound([{ total: usd(1000) }, { total: usd(2000), refundSummary: usd(300) }] as OrderObservation[])).toBe(2000);
  });
  it('counts ledger links against capacity by the units their amount names and by their dates (independent review)', () => {
    const o = order({ ref: 'order-U', lines: [{ key: 'item-600', unit: 600 }, { key: 'item-1000', unit: 1000 }] });
    const decide = (claims: Array<{ amountMinor: number; date: string }>, amountMinor = 600, extra: Partial<RefundOrder> = {}) =>
      decideRefundCredits({ orders: [{ ...o, ...extra }], credits: [credit('c1', amountMinor, '2031-01-25')],
        existingClaims: new Map([['order-U', claims]]) }).get('c1');
    // The ledger refund already returned the only 600 unit: the same unit cannot be returned again, whatever the cents.
    expect(decide([{ amountMinor: 600, date: '2031-01-15' }])).toEqual({ outcome: 'held', reason: 'capacity-exceeded', candidates: 1 });
    expect(decide([{ amountMinor: 1000, date: '2031-01-15' }])).toMatchObject({ outcome: 'linked', attribution: [{ key: 'item-600', unitMinor: 600, units: 1 }] });
    // A ledger amount that names no unit set leaves the quantities unverifiable for a new claim with units.
    expect(decide([{ amountMinor: 1, date: '2031-01-15' }])).toEqual({ outcome: 'held', reason: 'capacity-exceeded', candidates: 1 });
    // A refund total observed before a later ledger refund does not cover it: capacity falls back to the order total.
    const two = order({ ref: 'order-U', date: '2031-01-01', lines: [{ key: 'item-1000', unit: 1000, qty: 2 }], refundSummaryMinor: 1000,
      observedThrough: '2031-01-15' });
    const fresh = (claimDate: string) => decideRefundCredits({ orders: [two], credits: [credit('c1', 1000, '2031-01-10')],
      existingClaims: new Map([['order-U', [{ amountMinor: 1000, date: claimDate }]]]) }).get('c1');
    expect(fresh('2031-01-25')).toMatchObject({ outcome: 'linked', proof: 'refund-summary+subset' });
    expect(fresh('2031-01-12')).toEqual({ outcome: 'held', reason: 'capacity-exceeded', candidates: 1 });
  });
  it('enumerates each order once, so adversarial carts stay bounded, and agrees with the full search (independent review)', () => {
    const orders = Array.from({ length: 40 }, (_, n) => order({ ref: `order-${n}`, date: '2031-01-01',
      lines: Array.from({ length: 12 }, (_, i) => ({ key: `item-${i}`, unit: 1000 })) }));
    const credits = Array.from({ length: 40 }, (_, n) => credit(`c${n}`, 6000, '2031-01-20'));
    const started = performance.now();
    const decisions = decideRefundCredits({ orders, credits });
    expect(performance.now() - started).toBeLessThan(5000);
    expect([...decisions.values()].every(d => d.outcome === 'held' && d.reason === 'ambiguous-order' && d.candidates === 40)).toBe(true);
    // The cached index says what the full search says, amount by amount.
    for (const o of [order(A), order({ ref: 'order-E', lines: [{ key: 'item-9', unit: 1250 }, { key: 'item-9', unit: 1250 }], taxMinor: 125 }),
      order({ ref: 'order-P', lines: [{ key: 'item-15', unit: 1000 }, { key: 'item-16', unit: 3000, qty: 2 }], taxMinor: 250 })]) {
      const index = subsetIndex(o);
      for (const [amountMinor, entry] of index.byAmount) {
        const sets = subsetItemSets(o, amountMinor);
        expect(entry.count).toBe(Math.min(sets.size, 2));
        if (sets.size === 1) expect(entry.set).toEqual([...sets.values()][0]);
      }
      expect([...index.byAmount.keys()].sort((x, y) => x - y)).toEqual([...new Set(Array.from({ length: 20000 }, (_, n) => n)
        .filter(n => subsetItemSets(o, n).size > 0))]);
    }
  });
});

const usd = (amountMinor: number) => ({ currency: 'USD', amountMinor });
const itemRef = (n: number) => opaque('line-observation', ['synthetic', 'order', n]);
const charge = (id: string, parts: number[], extra: Partial<RefundCharge> = {}): RefundCharge => ({ id, currency: 'USD',
  amountMinor: parts.reduce((n, p) => n + p, 0), itemized: true,
  allocations: parts.map((amountMinor, n) => ({ itemRef: itemRef(n), amountMinor, currency: 'USD', sourceCategory: null })), ...extra });
// STEP 9 integration B5 (Root): each synthetic line's stable tie key, as the resolver derives one for every observed line.
const stableTies = new Map([0, 1, 2, 3].map(n => [itemRef(n), opaque('line-identity', ['order', `Synthetic line ${n}`, 0])]));

describe('refund item parts mirror the charges they reverse', () => {
  it('negates each item margin exactly for a single full refund, across several charges of the order', () => {
    const plans = itemizeRefundCredits([{ id: 'r1', amountMinor: -1100, currency: 'USD' }],
      [charge('c1', [400, 200]), charge('c2', [300, 200])], usd(1100), [], stableTies);
    expect(plans.get('r1')).toEqual({ kind: 'mirror', parts: [
      { itemRef: itemRef(0), amountMinor: -700, currency: 'USD', sourceCategory: null, classification: 'policy-allocated' },
      { itemRef: itemRef(1), amountMinor: -400, currency: 'USD', sourceCategory: null, classification: 'policy-allocated' },
      // STEP 9 integration B5 (Root): listed by line identity, never by capture-scoped ref.
    ].sort((a, b) => (stableTies.get(a.itemRef)! < stableTies.get(b.itemRef)! ? -1 : 1)) });
  });
  it('spreads a full refund made of several credits by stable largest remainder, conserving every item and credit', () => {
    const credits = [{ id: 'r2', amountMinor: -333, currency: 'USD' }, { id: 'r1', amountMinor: -667, currency: 'USD' }];
    // STEP 9 integration (B5)
    const plans = itemizeRefundCredits(credits, [charge('c1', [501, 499])], usd(1000), [], stableTies);
    const perItem = new Map<string, number>();
    for (const c of credits) {
      const plan = plans.get(c.id)!;
      expect(plan.kind).toBe('mirror');
      if (plan.kind !== 'mirror') continue;
      expect(plan.parts.reduce((n, p) => n + p.amountMinor, 0)).toBe(c.amountMinor);
      for (const p of plan.parts) perItem.set(p.itemRef, (perItem.get(p.itemRef) ?? 0) + p.amountMinor);
    }
    expect(perItem).toEqual(new Map([[itemRef(0), -501], [itemRef(1), -499]]));
    // STEP 9 integration (B5)
    expect(itemizeRefundCredits([...credits].reverse(), [charge('c1', [501, 499])], usd(1000), [], stableTies)).toEqual(plans);
  });
  it('keeps a partial refund with no observation of its charges, unitemized or missing charges whole; refuses more refund than paid or a currency mismatch', () => {
    const whole = (credits: Array<{ id: string; amountMinor: number; currency: string }>, charges: RefundCharge[], total = usd(1000)) =>
      [...itemizeRefundCredits(credits, charges, total, [], undefined).values()]; // STEP 9 integration B5: no observation, no map
    expect(whole([{ id: 'r', amountMinor: -500, currency: 'USD' }], [charge('c', [600, 400])]))
      .toEqual([{ kind: 'whole', reason: 'refund-unattributed' }]);
    expect(whole([{ id: 'r', amountMinor: -1000, currency: 'USD' }], [charge('c', [600, 400], { itemized: false })]))
      .toEqual([{ kind: 'whole', reason: 'refund-unattributed' }]);
    expect(whole([{ id: 'r', amountMinor: -1000, currency: 'USD' }], [])).toEqual([{ kind: 'whole', reason: 'refund-unattributed' }]);
    expect(whole([{ id: 'r', amountMinor: -1100, currency: 'USD' }], [charge('c', [600, 400])]))
      .toEqual([{ kind: 'whole', reason: 'inconsistent-evidence' }]);
    expect(whole([{ id: 'r', amountMinor: -1000, currency: 'USD' }], [], usd(900))).toEqual([{ kind: 'whole', reason: 'inconsistent-evidence' }]);
    expect(whole([{ id: 'r', amountMinor: -1000, currency: 'EUR' }], [charge('c', [600, 400])]))
      .toEqual([{ kind: 'whole', reason: 'currency-mismatch' }]);
    expect(whole([{ id: 'r', amountMinor: -1000, currency: 'USD' }], [charge('c', [600, 300])].map(c => ({ ...c, amountMinor: 1000 }))))
      .toEqual([{ kind: 'whole', reason: 'inconsistent-evidence' }]);
  });
});

/** A complete, single-card observation of one synthetic order in one synthetic capture: [unit, quantity] lines. */
function observed(lines: Array<[unit: number, qty: number]>, { tax = 0, shipping = 0, captureDigest = 'synthetic-capture-1' } = {}):
  RefundOrderSnapshot {
  const subtotal = lines.reduce((n, [unit, qty]) => n + unit * qty, 0), total = subtotal + shipping + tax;
  return { captureDigest, order: { orderId: '000-0000009-0000001', date: '2026-09-01', total: usd(total),
    items: lines.map(([unit, qty], lineOrdinal) => ({ lineOrdinal, itemId: `SYNTH9${String(lineOrdinal).padStart(4, '0')}`,
      title: `Synthetic partial line ${lineOrdinal}`, quantity: qty, unitPrice: usd(unit) })),
    paymentMethods: [{ kind: 'card', network: 'visa', last4: '9001' }],
    summary: [{ kind: 'items-subtotal', money: usd(subtotal) }, { kind: 'shipping', money: usd(shipping) },
      { kind: 'tax', money: usd(tax) }, { kind: 'grand-total', money: usd(total) }],
    tenderCoverage: 'single-card-proven',
    tenderProof: { methodComplete: true, summaryComplete: true, unknownMethod: false, unknownSummary: false, conflict: false },
    itemProof: { complete: true, unknownLine: false, conflict: false } } };
}
const lineRef = (s: RefundOrderSnapshot, lineOrdinal: number) => opaque('line-observation', [s.captureDigest, s.order.orderId, lineOrdinal]);
/**
 * STEP 9 integration B5 (Root): the history reader's tie map over these observations, the ONE key source: each line's key
 * by its capture-scoped ref, null when two observations disagree (contested).
 */
const tiesOf = (...snapshots: RefundOrderSnapshot[]) => {
  const ties = new Map<string, string | null>();
  for (const s of snapshots) {
    const keys = lineTieKeys(s.order);
    for (const i of s.order.items) {
      const ref = lineRef(s, i.lineOrdinal!), key = keys.get(i.lineOrdinal!)!;
      ties.set(ref, ties.has(ref) && ties.get(ref) !== key ? null : key);
    }
  }
  return ties;
};
/** The order's card charge, itemized exactly as the order-total policy files it on that observation; line n's source category is names[n]. */
function chargeOn(s: RefundOrderSnapshot, names: Array<string | null> = []): RefundCharge {
  const { allocations, complete } = allocateOrder(s.order, s.captureDigest, false);
  if (!complete) throw Error('synthetic allocation expected');
  const refs = s.order.items.map(i => lineRef(s, i.lineOrdinal!));
  return { id: 'charge', currency: 'USD', amountMinor: s.order.total!.amountMinor, itemized: true,
    allocations: allocations.map(a => ({ ...a, sourceCategory: names[refs.indexOf(a.itemRef)] ?? null })) };
}
const refund = (id: string, amountMinor: number) => ({ id, amountMinor: -amountMinor, currency: 'USD' });
const partOf = (s: RefundOrderSnapshot, lineOrdinal: number, amountMinor: number, sourceCategory: string | null = null) =>
  ({ itemRef: lineRef(s, lineOrdinal), amountMinor, currency: 'USD', sourceCategory, classification: 'policy-allocated' });
/** STEP 9 integration B5 (Root): parts as a credit lists them, by the line identity of the observation they rest on. */
const byLine = <T extends { itemRef: string }>(s: RefundOrderSnapshot, parts: T[]) => {
  const keys = lineTieKeys(s.order);
  const key = (p: T) => keys.get(s.order.items.find(i => lineRef(s, i.lineOrdinal!) === p.itemRef)!.lineOrdinal!)!;
  return parts.sort((a, b) => (key(a) < key(b) ? -1 : 1));
};
const UNATTRIBUTED = { kind: 'whole', reason: 'refund-unattributed' };
const INCONSISTENT = { kind: 'whole', reason: 'inconsistent-evidence' };

describe('partial refunds split by the refund attribution, on the observation the charges were allocated on', () => {
  it('STEP 9 integration B5 (Root): with no single observation, each part ties by its own line identity; else whole', () => {
    // 5b01e72f's native case: two 100-cent charges, each allocated on a different observation, fully refunded by -1 and -199.
    const tieOf = (s: RefundOrderSnapshot) => new Map(s.order.items.map(i => [lineRef(s, i.lineOrdinal!), lineTieKeys(s.order).get(i.lineOrdinal!)!]));
    const plan = (a: string, b: string) => {
      const s1 = observed([[100, 1], [100, 1]], { captureDigest: a }), s2 = observed([[100, 1], [100, 1]], { captureDigest: b });
      const own = (s: RefundOrderSnapshot, lineOrdinal: number, id: string): RefundCharge => {
        const charge = chargeOn(s);
        return { ...charge, id, amountMinor: 100, allocations: charge.allocations.filter(x => x.itemRef === lineRef(s, lineOrdinal)) };
      };
      const ties = new Map([...tieOf(s1), ...tieOf(s2)]);
      const plans = itemizeRefundCredits([refund('r1', 1), refund('r2', 199)], [own(s1, 0, 'c1'), own(s2, 1, 'c2')], usd(200), [s1, s2], ties);
      return { s1, s2, ties, plans };
    };
    // Whatever the capture-scoped refs, the odd cent of each credit lands on the same line: image or ref rereads move none.
    const byLine = (p: ReturnType<typeof plan>) => ['r1', 'r2'].map(id => {
      const item = p.plans.get(id)!;
      if (item.kind === 'whole') return item;
      return item.parts.map(part => [part.itemRef === lineRef(p.s1, 0) ? 0 : part.itemRef === lineRef(p.s2, 1) ? 1 : -1, part.amountMinor]).sort();
    });
    const first = byLine(plan('synthetic-capture-a0', 'synthetic-capture-b0'));
    expect(first[0]).toEqual([[lineTieKeys(observed([[100, 1], [100, 1]]).order).get(0)! < lineTieKeys(observed([[100, 1], [100, 1]]).order).get(1)!
      ? 0 : 1, -1]]);
    for (let n = 1; n < 24; n++) expect(byLine(plan(`synthetic-capture-a${n}`, `synthetic-capture-b${n}`)), String(n)).toEqual(first);
    // A part with no stable key, or two parts with one key, fails closed: every credit stays whole.
    const missing = plan('synthetic-capture-a0', 'synthetic-capture-b0');
    const without = new Map(missing.ties);
    without.delete(lineRef(missing.s2, 1));
    const s1 = missing.s1, s2 = missing.s2;
    const c1 = { ...chargeOn(s1), id: 'c1', amountMinor: 100, allocations: chargeOn(s1).allocations.filter(x => x.itemRef === lineRef(s1, 0)) };
    const c2 = { ...chargeOn(s2), id: 'c2', amountMinor: 100, allocations: chargeOn(s2).allocations.filter(x => x.itemRef === lineRef(s2, 1)) };
    expect(itemizeRefundCredits([refund('r1', 1), refund('r2', 199)], [c1, c2], usd(200), [s1, s2], without).get('r1')).toEqual(UNATTRIBUTED);
    const same = new Map(missing.ties);
    same.set(lineRef(s2, 1), missing.ties.get(lineRef(s1, 0))!);
    expect(itemizeRefundCredits([refund('r1', 1), refund('r2', 199)], [c1, c2], usd(200), [s1, s2], same).get('r1')).toEqual(UNATTRIBUTED);
  });
  it('STEP 9 integration B5 (Root): a partial credit\'s tied cent goes to the lower line identity, never the lower ordinal', () => {
    // 5b01e72f's vector: two 100-cent lines take a 201 credit, so their odd cent is a tie between them.
    const make = (n: number) => {
      const s = observed([[100, 1], [100, 1], [10000, 1]], { tax: 1, shipping: 102 });
      s.order.items = s.order.items.map((item, ordinal) => (ordinal < 2 ? { ...item, title: `Synthetic tie ${'ab'[ordinal]}${n}` } : item));
      return s;
    };
    // Titles whose line identities order opposite to the ordinals: the old rule would give the cent to the other line.
    let n = 0;
    while (lineTieKeys(make(n).order).get(0)! < lineTieKeys(make(n).order).get(1)!) n++;
    const s = make(n);
    // STEP 9 integration (B5)
    const plan = itemizeRefundCredits([refund('r1', 201), refund('r2', 10001)], [chargeOn(s)], s.order.total, [s], tiesOf(s));
    // STEP 9 integration B5 (Root): listed by line identity (line 1's sorts first here), never by capture-scoped ref.
    expect(plan.get('r1')).toMatchObject({ kind: 'split', parts: [partOf(s, 1, -101), partOf(s, 0, -100)] });
  });
  it('STEP 9 integration B5 (Root): lists a partial credit\'s parts by line identity, never by capture-scoped ref (C\'s vector)', () => {
    // Two equal lines titled so that the second line's identity sorts first, in a capture whose refs sort the first line
    // first: listing by ref would put the first line first.
    const titled = (k: number, captureDigest: string) => {
      const s = observed([[1000, 1], [1000, 1]], { tax: 1, shipping: 500, captureDigest });
      return { ...s, order: { ...s.order, items: s.order.items.map((i, n) => ({ ...i, title: `Synthetic tie line ${'AB'[n]}${k}` })) } };
    };
    let s: RefundOrderSnapshot | undefined;
    for (let k = 0; !s && k < 64; k++) for (let d = 0; !s && d < 64; d++) {
      const c = titled(k, `synthetic-capture-${d}`), keys = lineTieKeys(c.order);
      if (keys.get(1)! < keys.get(0)! && lineRef(c, 0) < lineRef(c, 1)) s = c;
    }
    expect(s).toBeTruthy();
    // Both units and all the tax, but not the shipping: a partial refund of 2001 over two lines of 1000, one tied cent.
    expect(itemizeRefundCredits([refund('r', 2001)], [chargeOn(s!)], s!.order.total, [s!], tiesOf(s!)).get('r'))
      .toEqual({ kind: 'split', basis: 'units', parts: [partOf(s!, 1, -1001), partOf(s!, 0, -1000)] });
  });
  it('STEP 9 integration B5 (Root): a partial credit splits only by the history reader\'s keys; no map, an empty one or a contested line holds', () => {
    const s = observed([[600, 1], [400, 1], [300, 1]], { tax: 130 });
    const charges = [chargeOn(s, ['Synthetic Kitchen', 'Synthetic Garden', 'Synthetic Toys'])];
    const plan = (ties: ReadonlyMap<string, string | null> | undefined) =>
      itemizeRefundCredits([refund('r', 1100)], charges, s.order.total, [s], ties).get('r');
    expect(plan(tiesOf(s))).toMatchObject({ kind: 'split', basis: 'units' });
    const contested = (lineOrdinal: number) => new Map([...tiesOf(s)].map(([ref, key]) => [ref, ref === lineRef(s, lineOrdinal) ? null : key]));
    for (const ties of [undefined, new Map<string, string | null>(), contested(0), contested(1)]) expect(plan(ties)).toEqual(UNATTRIBUTED);
    // A contested line the credit does not pay back is no part of it.
    expect(plan(contested(2))).toMatchObject({ kind: 'split', basis: 'units' });
  });
  it('files each credit under the lines it paid back, on the charge\'s own item refs and source categories', () => {
    const s = observed([[600, 1], [400, 1], [300, 1]], { tax: 130 });
    const charges = [chargeOn(s, ['Synthetic Kitchen', 'Synthetic Garden', 'Synthetic Toys'])];
    const plan = (...credits: Array<ReturnType<typeof refund>>) => itemizeRefundCredits(credits, charges, s.order.total, [s], tiesOf(s));
    // One unit and its tax share; two lines, their money by price (the attribution's largest remainder); two credits, two items.
    expect(plan(refund('r', 660)).get('r')).toEqual({ kind: 'split', basis: 'units', parts: [partOf(s, 0, -660, 'Synthetic Kitchen')] });
    expect(plan(refund('r', 1100)).get('r')).toEqual({ kind: 'split', basis: 'units', // STEP 9 integration B5: by line identity
      parts: byLine(s, [partOf(s, 0, -660, 'Synthetic Kitchen'), partOf(s, 1, -440, 'Synthetic Garden')]) });
    expect(plan(refund('r1', 660), refund('r2', 330))).toEqual(new Map([
      ['r1', { kind: 'split', basis: 'units', parts: [partOf(s, 0, -660, 'Synthetic Kitchen')] }],
      ['r2', { kind: 'split', basis: 'units', parts: [partOf(s, 2, -330, 'Synthetic Toys')] }]]));
    // Units of one line; any part of a proven one-line order is that line's.
    const units = observed([[1000, 4]]);
    // STEP 9 integration (B5)
    expect(itemizeRefundCredits([refund('r1', 2000), refund('r2', 1000)], [chargeOn(units)], units.order.total, [units], tiesOf(units)))
      .toEqual(new Map([['r1', { kind: 'split', basis: 'units', parts: [partOf(units, 0, -2000)] }],
        ['r2', { kind: 'split', basis: 'units', parts: [partOf(units, 0, -1000)] }]]));
    const one = observed([[5000, 1]], { tax: 400 });
    expect(itemizeRefundCredits([refund('r', 2000)], [chargeOn(one)], one.order.total, [one], tiesOf(one)).get('r'))
      .toEqual({ kind: 'split', basis: 'only-line', parts: [partOf(one, 0, -2000)] });
    // A full refund keeps mirroring the charges, observation or not.
    expect(itemizeRefundCredits([refund('r', 1430)], charges, s.order.total, [s], tiesOf(s)).get('r')).toMatchObject({ kind: 'mirror' });
  });
  it('keeps a credit whole when the attribution holds, or no single observation is the one the charges were allocated on', () => {
    const s = observed([[600, 1], [400, 1]], { tax: 100 });
    const plan = (amountMinor: number, snapshots: RefundOrderSnapshot[] = [s], charges = [chargeOn(s)]) =>
      itemizeRefundCredits([refund('r', amountMinor)], charges, null, snapshots, tiesOf(...snapshots)).get('r');
    expect(plan(1000)).toEqual(UNATTRIBUTED);
    const twins = observed([[1000, 1], [1000, 1]]);
    expect(plan(1000, [twins], [chargeOn(twins)])).toEqual(UNATTRIBUTED);
    // Split tender: one refund payment may be one tender's share, so units hold; a one-line order is still that line's.
    expect(plan(660, [{ ...s, order: { ...s.order, tenderCoverage: 'multi-tender' } }])).toEqual(UNATTRIBUTED);
    const one = observed([[5000, 1]], { tax: 400 });
    expect(plan(2000, [{ ...one, order: { ...one.order, tenderCoverage: 'multi-tender' } }], [chargeOn(one)]))
      .toMatchObject({ kind: 'split', basis: 'only-line' });
    // Another capture's lines are other items; two different observations of the charges' capture leave it unknown which.
    expect(plan(660, [{ ...s, captureDigest: 'synthetic-capture-2' }])).toEqual(UNATTRIBUTED);
    expect(plan(660, [])).toEqual(UNATTRIBUTED);
    const retitled = { ...s, order: { ...s.order, items: s.order.items.map(i => ({ ...i, title: `${i.title} again` })) } };
    expect(plan(660, [s, retitled])).toEqual(UNATTRIBUTED);
    expect(plan(660, [s, structuredClone(s), { ...s, captureDigest: 'synthetic-capture-2' }])).toMatchObject({ kind: 'split' });
    // The charges filed everything under the second line: the first line, which the credit paid back, is no item of theirs.
    const onSecond = { ...chargeOn(s), allocations: chargeOn(s).allocations.map(a => ({ ...a, itemRef: lineRef(s, 1) })) };
    expect(plan(660, [s], [onSecond])).toEqual(UNATTRIBUTED);
    expect(plan(440, [s], [onSecond])).toMatchObject({ kind: 'split', parts: [{ itemRef: lineRef(s, 1), amountMinor: -440 }] });
  });
  it('holds every credit of the order whole when together they give an item back more than its charges filed, or a line more units', () => {
    // A large shipping share leaves money room on the first line, but it had one unit: two refunds of it contradict.
    const shipped = observed([[1000, 1], [100, 1]], { shipping: 10000 });
    const charges = [chargeOn(shipped)];
    // STEP 9 integration (B5)
    expect([...itemizeRefundCredits([refund('r1', 1000), refund('r2', 1000), refund('r3', 7)], charges, shipped.order.total, [shipped],
      tiesOf(shipped)).values()]).toEqual([INCONSISTENT, INCONSISTENT, INCONSISTENT]);
    expect(itemizeRefundCredits([refund('r1', 1000), refund('r2', 100), refund('r3', 7)], charges, shipped.order.total, [shipped],
      tiesOf(shipped)))
      .toEqual(new Map<string, unknown>([['r1', { kind: 'split', basis: 'units', parts: [partOf(shipped, 0, -1000)] }],
        ['r2', { kind: 'split', basis: 'units', parts: [partOf(shipped, 1, -100)] }], ['r3', UNATTRIBUTED]]));
    // Tied to the first two lines within the attribution's tax rounding, but a cent more than the charge filed under the first.
    const taxed = observed([[600, 1], [400, 1], [300, 1]], { tax: 130 });
    expect(itemizeRefundCredits([refund('r', 1101)], [chargeOn(taxed)], taxed.order.total, [taxed], tiesOf(taxed)).get('r'))
      .toEqual(INCONSISTENT);
  });
  it('fails closed on an observation in another currency, or one whose total is less than the charges paid', () => {
    const s = observed([[600, 1], [400, 1]], { tax: 100 });
    const plan = (order: OrderObservation) => itemizeRefundCredits([refund('r', 660)], [chargeOn(s)], null, [{ ...s, order }], tiesOf(s))
      .get('r');
    expect(plan({ ...s.order, total: { currency: 'EUR', amountMinor: 1100 } })).toEqual({ kind: 'whole', reason: 'currency-mismatch' });
    expect(plan({ ...s.order, total: usd(1000) })).toEqual(INCONSISTENT);
    expect(plan({ ...s.order, total: null })).toEqual(INCONSISTENT);
  });
  it('decides the same whatever the order of the credits and the observations offered', () => {
    const s = observed([[600, 1], [400, 1], [300, 1]], { tax: 130 }), other = { ...s, captureDigest: 'synthetic-capture-0' };
    const credits = [refund('r2', 330), refund('r1', 660), refund('r3', 5)];
    // STEP 9 integration (B5)
    const plans = itemizeRefundCredits(credits, [chargeOn(s)], s.order.total, [other, s], tiesOf(other, s));
    expect([...plans].map(([id, p]) => [id, p.kind]).sort()).toEqual([['r1', 'split'], ['r2', 'split'], ['r3', 'whole']]);
    expect(itemizeRefundCredits([...credits].reverse(), [chargeOn(s)], s.order.total, [s, other], tiesOf(s, other))).toEqual(plans);
  });
  it('offers the observations the charge policies choose: the order-total one and the ledger one, else the latest stored', () => {
    const complete = observed([[600, 1], [400, 1]], { tax: 100 });
    const at = (s: RefundOrderSnapshot, extra: Partial<OrderSnapshot> = {}): OrderSnapshot => ({ ...s, version: 3, scope: 'legacy', ...extra });
    const header = at({ captureDigest: 'synthetic-capture-3', order: { ...complete.order, items: [] } }, { scope: 'header-only' });
    const latest = { captureDigest: 'synthetic-capture-3', order: complete.order };
    // Both policies choose the newest complete observation: it is offered once, and one without lines never.
    expect(orderChargeSnapshots([header, at(complete)], latest)).toEqual([complete]);
    // A newer split-tender observation is the ledger policy's choice, an older single-card one the order-total policy's.
    const split = { captureDigest: 'synthetic-capture-2', order: { ...complete.order, tenderCoverage: 'multi-tender' as const,
      paymentMethods: [...complete.order.paymentMethods!, { kind: 'card' as const, network: 'visa' as const, last4: '9002' }] } };
    expect(orderChargeSnapshots([at(split), at(complete)], latest)).toEqual([complete, split]);
    // No observation with the ledger proof: the ledger policy falls back on the latest stored one.
    expect(orderChargeSnapshots([header], latest)).toEqual([latest]);
  });
  it('STEP 9 integration (#154 x #168): offers the displayed observation first, as both charge policies now choose it', () => {
    const shown = observed([[600, 1], [400, 1]], { tax: 100 }), newer = { ...shown, captureDigest: 'synthetic-capture-2' };
    const at = (s: RefundOrderSnapshot): OrderSnapshot => ({ ...s, version: 3, scope: 'legacy' });
    // A later complete read the display decision kept back: the charges rest on the displayed one, never on it.
    expect(orderChargeSnapshots([at(newer), at(shown)], shown)).toEqual([shown]);
    expect(orderChargeSnapshots([at(newer), at(shown)], newer)).toEqual([newer]);
  });
});

describe('a full refund of several credits rounds as its charges do (order-history v3)', () => {
  it('sends a tied cent by the charges\' line identity, so a re-read capture moves no cent between a credit\'s items', () => {
    // Two equal lines: each credit's odd cent is a tie between them.
    const twins = (captureDigest: string) => observed([[1000, 1], [1000, 1]], { captureDigest });
    const refsAscending = (d: string) => lineRef(twins(d), 0) < lineRef(twins(d), 1);
    const digests = Array.from({ length: 64 }, (_, n) => `synthetic-capture-${n}`);
    // Two captures of the same order whose capture-scoped refs sort its lines in opposite orders.
    const one = digests.find(refsAscending), other = digests.find(d => !refsAscending(d));
    expect(one && other).toBeTruthy();
    const perLine = (d: string) => {
      const s = twins(d);
      // STEP 9 integration (B5)
      const plans = itemizeRefundCredits([refund('r1', 999), refund('r2', 1001)], [chargeOn(s)], s.order.total, [s], tiesOf(s));
      return [...plans].map(([id, plan]) => [id, plan.kind === 'mirror'
        ? plan.parts.map(p => [s.order.items.findIndex(i => lineRef(s, i.lineOrdinal!) === p.itemRef), p.amountMinor]).sort()
        : plan]);
    };
    expect(perLine(one!)).toEqual(perLine(other!));
    // STEP 9 integration B5 (Root): each credit lists its parts in the same line order in both captures, whatever their refs.
    const lineOrder = (d: string) => {
      const s = twins(d);
      return [...itemizeRefundCredits([refund('r1', 999), refund('r2', 1001)], [chargeOn(s)], s.order.total, [s], tiesOf(s))]
        .map(([id, plan]) => [id, plan.kind === 'mirror' ? plan.parts.map(p => s.order.items.findIndex(i => lineRef(s, i.lineOrdinal!) === p.itemRef)) : plan]);
    };
    expect(lineOrder(one!)).toEqual(lineOrder(other!));
    // The first credit's tied cent (card-row order) goes to the line of the lower identity, as a charge's would.
    const keys = lineTieKeys(twins(one!).order), lower = keys.get(0)! < keys.get(1)! ? 0 : 1;
    expect(perLine(one!)).toEqual([['r1', [[lower, -500], [1 - lower, -499]].sort()], ['r2', [[lower, -500], [1 - lower, -501]].sort()]]);
    // STEP 9 integration B5 (Root): keys come only from the history reader's map (its own observation's key per part); with
    // no map, an empty one, or a contested ref the credits stay whole, never decided by a capture-scoped ref or a key
    // rebuilt from the observation offered.
    const s = twins(one!);
    expect(itemizeRefundCredits([refund('r1', 999), refund('r2', 1001)], [chargeOn(s)], s.order.total, [], undefined).get('r1')).toEqual(UNATTRIBUTED);
    for (const ties of [undefined, new Map<string, string | null>(), new Map([...tiesOf(s)].map(([ref, key], n) => [ref, n ? key : null]))]) {
      expect(itemizeRefundCredits([refund('r1', 999), refund('r2', 1001)], [chargeOn(s)], s.order.total, [s], ties).get('r1')).toEqual(UNATTRIBUTED);
    }
    const own = new Map(s.order.items.map(i => [lineRef(s, i.lineOrdinal!), keys.get(i.lineOrdinal!)!]));
    expect(itemizeRefundCredits([refund('r1', 999), refund('r2', 1001)], [chargeOn(s)], s.order.total, [], own).get('r1'))
      .toEqual({ kind: 'mirror', parts: [partOf(s, lower, -500), partOf(s, 1 - lower, -499)] }); // STEP 9 integration B5: by line identity
  });
});

let dir: string, repo: SqliteStateRepo, number: number, cardId: string, otherCardId: string, rowNumber: number;
const db = () => repo.internalGetDb();
const backup = () => path.join(dir, `backup-${++number}.db`);
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-refund-credits-synthetic-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'synthetic.db') }); number = 0; rowNumber = 0;
  cardId = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9001', currency: 'USD' }).id;
  otherCardId = repo.createCardAccount({ issuer: 'chase', owner: 'alex', last4: '9002', currency: 'USD' }).id;
  const cards = readCardInventory(db());
  const proposal = proposeBindings(cards.map(c => ({ network: 'visa', last4: c.last4, cardAccountId: c.id })), cards);
  await recordBindingProposal(db(), proposal, backup());
  await recordRootApproval(db(), proposal, rootApproval(proposal), backup());
});
afterEach(() => { repo.close(); fs.rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });

/** Card rows on the Prime card unless said otherwise: purchases positive, credits negative, Amazon descriptors. */
function card(...rows: Array<{ date: string; amountMinor: number; description?: string; cardAccountId?: string }>) {
  for (const r of rows) {
    repo.importCardTransactions({ cardAccountId: r.cardAccountId ?? cardId, source: 'synthetic', parserVersion: 'synthetic@1',
      rows: [{ transactionDate: r.date, status: 'posted', kind: r.amountMinor > 0 ? 'purchase' : 'refund', amountMinor: r.amountMinor,
        currency: 'USD', description: r.description ?? `AMAZON MKTPL*SYNTH${String(++rowNumber).padStart(3, '0')}`, issuerCategory: 'Shopping' }] });
  }
}
const rowId = (amountMinor: number, date?: string) =>
  readLedger(db()).find(r => r.amountMinor === amountMinor && (date === undefined || r.transactionDate === date))!.id;
interface SyntheticOrder { id: string; date: string; lines: Array<[unit: number, qty: number]>; tax: number; refundSummary?: number }
/** A ledger `Refunded` (negative) or `Charged` row of one synthetic order, on the Prime card. */
const ledgerPayment = (amountMinor: number, date: string, ordinal = 0, orderId = '000-0000002-0000001') => ({
  date, money: usd(amountMinor), kind: amountMinor < 0 ? 'refund' as const : 'charge' as const, status: 'completed' as const,
  method: { kind: 'card' as const, network: 'visa' as const, last4: '9001' }, orderIds: [orderId], identity: 'native-row' as const,
  provenance: { source: 'ledger' as const, status: amountMinor < 0 ? 'Refunded' as const : 'Charged' as const, page: 0, ordinal } });
/** A v3 capture of complete, single-card synthetic orders (no ledger rows unless given), its 59-day window ending `through`. */
function refundCapture(orders: SyntheticOrder[], run = 1, payments: Staging['payments'] = [], through = '2026-10-19') {
  const c = syntheticCapture();
  c.staging.runId = `00000000-0000-4000-8000-${String(run).padStart(12, '0')}`;
  c.staging.window.from = new Date(Date.parse(through) - 59 * 86400000).toISOString().slice(0, 10);
  c.staging.window.through = through;
  const base = c.staging.orders[0];
  c.staging.orders = orders.map((o, n) => {
    const subtotal = o.lines.reduce((sum, [unit, qty]) => sum + unit * qty, 0), total = subtotal + o.tax;
    return { ...structuredClone(base), orderId: o.id, date: o.date, total: usd(total),
      items: o.lines.map(([unit, qty], lineOrdinal) => ({ lineOrdinal, itemId: `SYNTH${String(n * 10 + lineOrdinal + 1).padStart(5, '0')}`,
        title: `Synthetic refund item ${n}-${lineOrdinal}`, quantity: qty, unitPrice: usd(unit) })),
      summary: [{ kind: 'items-subtotal' as const, money: usd(subtotal) }, { kind: 'shipping' as const, money: usd(0) },
        { kind: 'tax' as const, money: usd(o.tax) }, { kind: 'grand-total' as const, money: usd(total) }],
      itemProof: { complete: true, unknownLine: false, conflict: false },
      ...(o.refundSummary !== undefined ? { refundSummary: usd(o.refundSummary) } : {}) };
  });
  c.staging.payments = payments;
  const refunds = payments.filter(p => p.kind === 'refund').length;
  const coverage = (records: number) => ({ status: records ? 'partial' as const : 'held' as const,
    reason: records ? 'budget' : 'selector-failed', pages: records ? 1 : 0, records, rejected: 0 });
  c.staging.coverage = { orders: coverage(orders.length), details: coverage(orders.reduce((n, o) => n + o.lines.length, 0)),
    payments: coverage(payments.length), refunds: coverage(refunds) };
  return c;
}
/** Files each order line under a category of its own (line ordinal n -> names[n]). */
async function categorize(names = ['Synthetic Kitchen', 'Synthetic Garden', 'Synthetic Toys']) {
  await backedUpWrite(db(), backup(), () => {
    for (const item of db().prepare('SELECT ref,data_json FROM amazon_items').all() as Array<{ ref: string; data_json: string }>) {
      db().prepare('INSERT OR REPLACE INTO amazon_item_overrides VALUES(?,?)').run(item.ref, names[JSON.parse(item.data_json).lineOrdinal]);
    }
  });
}
const snapshot = () => createAmazonCategoryResolver(db()).snapshot();
const resolved = () => snapshot().resolve(readLedger(db()));
/** Category totals of every split row's parts, and each whole row under its own effective category. */
function byCategory() {
  const answer = resolved(), totals = new Map<string, number>();
  for (const row of readLedger(db())) {
    const r = answer.get(row.id);
    const parts = r?.kind === 'split' ? r.contributions.map(p => [p.category ?? row.effectiveCategory!, p.amountMinor] as const)
      : [[row.effectiveCategory!, row.amountMinor] as const];
    for (const [category, amountMinor] of parts) totals.set(category, (totals.get(category) ?? 0) + amountMinor);
  }
  return Object.fromEntries([...totals].sort(([a], [b]) => (a < b ? -1 : 1)));
}
const ORDER_A: SyntheticOrder = { id: '000-0000002-0000001', date: '2026-09-01', lines: [[600, 1], [400, 1]], tax: 100 };

describe('card credits linked by exact-cents order proof, in the live resolver', () => {
  it('files a full refund of an itemized order exactly against its charge, leaving the charge byte-identical', async () => {
    card({ date: '2026-09-02', amountMinor: 1100 });
    await importAmazonCapture(db(), refundCapture([ORDER_A]), backup()); await categorize();
    const chargeId = rowId(1100), before = resolved().get(chargeId);
    expect(before).toMatchObject({ kind: 'split', evidenceClass: 'unique-total-match' });
    expect(byCategory()).toEqual({ 'Synthetic Garden': 440, 'Synthetic Kitchen': 660 });
    card({ date: '2026-09-20', amountMinor: -1100 });
    const refundId = rowId(-1100), answer = resolved();
    expect(answer.get(chargeId)).toEqual(before);
    expect(answer.get(refundId)).toMatchObject({ kind: 'split', evidenceClass: 'unique-total-match' });
    expect(byCategory()).toEqual({ 'Synthetic Garden': 0, 'Synthetic Kitchen': 0 });
    expect(snapshot().getCardDetail(refundId)).toMatchObject({ match: 'linked', evidenceClass: 'unique-total-match',
      orderRefs: [opaque('order', ORDER_A.id)] });
    expect(snapshot().getCardDetail(refundId).items).toHaveLength(2);
    expect(snapshot().matchCounts.refundCredits).toMatchObject({ rows: 1, ledgerLinked: 0, linked: 1, itemized: 1,
      linkedByProof: [{ proof: 'refund-summary', count: 0 }, { proof: 'full-order', count: 1 }, { proof: 'subset', count: 1 }],
      itemAttribution: { unique: 1, held: 0 } });
    // The original card ledger is untouched by reads.
    expect(snapshot().matchCounts.itemizedRows).toBe(1);
  });
  // STEP 9 integration (B5)
  it('moves no cent between a full refund\'s credit rows when a re-read replaces the display (order-history v3)', async () => {
    const twins: SyntheticOrder = { ...ORDER_A, lines: [[1000, 1], [1000, 1]], tax: 0 };
    card({ date: '2026-09-02', amountMinor: 2000 }, { date: '2026-09-20', amountMinor: -999 }, { date: '2026-09-21', amountMinor: -1001 });
    // Two final ledger refunds that together refund everything the charge paid: each credit's odd cent is a tie.
    const first = refundCapture([twins], 1, [ledgerPayment(-999, '2026-09-20', 0), ledgerPayment(-1001, '2026-09-21', 1)]);
    const refsAscending = (captureDigest: string) =>
      opaque('line-observation', [captureDigest, twins.id, 0]) < opaque('line-observation', [captureDigest, twins.id, 1]);
    // A complete re-read whose capture-scoped refs sort the two lines the other way round.
    const reread = Array.from({ length: 64 }, (_, n) => refundCapture([twins], n + 2))
      .find(c => refsAscending(digest(c)) !== refsAscending(digest(first)))!;
    const split = () => {
      const answer = resolved();
      return [rowId(2000), rowId(-999), rowId(-1001)].map(id => {
        const r = answer.get(id);
        return r?.kind === 'split' ? r.contributions.map(p => [p.category, p.amountMinor]).sort() : r;
      });
    };
    await importAmazonCapture(db(), first, backup()); await categorize();
    const before = split();
    expect(before.every(Array.isArray)).toBe(true);
    await importAmazonCapture(db(), reread, backup()); await categorize();
    expect(db().prepare('SELECT digest FROM amazon_captures ORDER BY rowid').pluck().all()).toEqual([digest(first), digest(reread)]);
    expect(db().prepare('SELECT latest_digest FROM amazon_orders').pluck().get()).toBe(digest(reread));
    expect(split()).toEqual(before);
    expect(byCategory()).toEqual({ 'Synthetic Garden': 0, 'Synthetic Kitchen': 0 });
  });
  it('STEP 9 integration B5 (Root): a line ref two reads in one capture title differently has no tie key, never the first or last read\'s', async () => {
    const twins: SyntheticOrder = { ...ORDER_A, lines: [[100, 1], [100, 1]], tax: 0 };
    const refs = (c: ReturnType<typeof refundCapture>) => [0, 1].map(n => opaque('line-observation', [digest(c), twins.id, n]));
    const ties = () => readRefundEvidence(db(), activeBindings(db(), readCardInventory(db()))).lineTies.get(opaque('order', twins.id));
    // STEP 9 integration (B5)
    // Each ref with its key, or null where it is contested: every observed ref keeps its entry (Root: explicit).
    const keyed = () => [...ties()!].map(([ref, key]) => [ref, typeof key]).sort();
    const shape = (strings: string[], contested: string[]) =>
      [...strings.map(ref => [ref, 'string']), ...contested.map(ref => [ref, 'object'])].sort();
    const once = refundCapture([twins]), other = refundCapture([twins], 2);
    await importAmazonCapture(db(), once, backup());
    await importAmazonCapture(db(), other, backup());
    expect(keyed()).toEqual(shape([...refs(once), ...refs(other)], []));
    // Import refuses one capture reading an order twice; a store holding such reads anyway (here, a second read of `other`
    // titling its lines differently: the same refs, contradictory keys) keeps those refs contested, in either read order.
    const second = (ordinal: number, order: object) => backedUpWrite(db(), backup(), () => {
      db().prepare('INSERT INTO amazon_observations VALUES(?,?,?,?,?,?,?)').run(opaque('observation', [digest(other), 'order', ordinal]),
        digest(other), 'order', ordinal, opaque('order', twins.id), 'payment-coverage-held', JSON.stringify(order));
    });
    const read = db().prepare(`SELECT data_json FROM amazon_observations WHERE family='order' AND capture_digest=?`).pluck().get(digest(other)) as string;
    const retitled = (n: number) => { const o = JSON.parse(read); o.items = o.items.map((i: { title: string }) => ({ ...i, title: `${i.title} ${n}` })); return o; };
    await second(1, retitled(1));
    // STEP 9 integration (B5)
    expect(keyed()).toEqual(shape(refs(once), refs(other)));
    expect(refs(other).map(ref => ties()!.get(ref))).toEqual([null, null]);
    await backedUpWrite(db(), backup(), () => { db().prepare(`DELETE FROM amazon_observations WHERE ref=?`).run(opaque('observation', [digest(other), 'order', 1])); });
    await second(-1, retitled(2));
    expect(keyed()).toEqual(shape(refs(once), refs(other)));
    // A second read that agrees with the first keeps its keys.
    await backedUpWrite(db(), backup(), () => { db().prepare(`DELETE FROM amazon_observations WHERE ref=?`).run(opaque('observation', [digest(other), 'order', -1])); });
    await second(1, JSON.parse(read));
    expect(keyed()).toEqual(shape([...refs(once), ...refs(other)], []));
  });
  it('STEP 9 integration B5 (Root): image-only re-reads keep month-window category totals and each credit\'s part order byte-identical', async () => {
    // Root's literal case (1f309a7f; C's v2 vector): a purchase of 200 split across two 100-cent owner categories, final
    // refunds of -1 on 09-20 (September) and -199 on 10-05 (October).
    const pair: SyntheticOrder = { ...ORDER_A, lines: [[100, 1], [100, 1]], tax: 0 };
    card({ date: '2026-09-02', amountMinor: 200 }, { date: '2026-09-20', amountMinor: -1 }, { date: '2026-10-05', amountMinor: -199 });
    const first = refundCapture([pair], 1, [ledgerPayment(-1, '2026-09-20', 0), ledgerPayment(-199, '2026-10-05', 1)]);
    const refsAscending = (captureDigest: string) =>
      opaque('line-observation', [captureDigest, pair.id, 0]) < opaque('line-observation', [captureDigest, pair.id, 1]);
    // The same order read again with only a display-only image ID added; the re-reads' capture-scoped refs sort its lines
    // both ways round.
    const rereads = Array.from({ length: 6 }, (_, n) => {
      const c = refundCapture([pair], n + 2);
      c.staging.orders[0].items[0].imageId = '91SynthAA0L';
      return c;
    });
    expect(new Set(rereads.map(c => refsAscending(digest(c)) === refsAscending(digest(first))))).toEqual(new Set([true, false]));
    /** Per calendar month, each category's total: split rows by their parts, whole rows under their own category. */
    const windows = () => {
      const answer = resolved(), totals = new Map<string, Map<string, number>>();
      for (const row of readLedger(db())) {
        const r = answer.get(row.id), month = totals.get(row.transactionDate.slice(0, 7)) ?? new Map<string, number>();
        const parts = r?.kind === 'split' ? r.contributions.map(p => [p.category ?? row.effectiveCategory!, p.amountMinor] as const)
          : [[row.effectiveCategory!, row.amountMinor] as const];
        for (const [category, amountMinor] of parts) month.set(category, (month.get(category) ?? 0) + amountMinor);
        totals.set(row.transactionDate.slice(0, 7), month);
      }
      return JSON.stringify([...totals].sort(([a], [b]) => (a < b ? -1 : 1)).map(([m, c]) => [m, [...c].sort(([a], [b]) => (a < b ? -1 : 1))]));
    };
    /** Each credit's parts in the order the resolver and the card detail list them (never re-sorted here). */
    const order = () => JSON.stringify([rowId(-1), rowId(-199)].map(id => {
      const r = resolved().get(id);
      return [r?.kind === 'split' ? r.contributions.map(p => [p.category, p.amountMinor]) : r,
        snapshot().getCardDetail(id).parts?.map(p => [p.category, p.amountMinor])];
    }));
    await importAmazonCapture(db(), first, backup()); await categorize();
    // Both credits are filed under the items: the -1 lands in one category of September, the -199 in both of October.
    expect([rowId(-1), rowId(-199)].map(id => resolved().get(id)?.kind)).toEqual(['split', 'split']);
    expect(JSON.parse(order())[1][0]).toHaveLength(2);
    const before = { windows: windows(), order: order() };
    expect(JSON.parse(before.windows).map(([month]: [string]) => month)).toEqual(['2026-09', '2026-10']);
    for (const reread of rereads) {
      await importAmazonCapture(db(), reread, backup()); await categorize();
      expect(db().prepare('SELECT latest_digest FROM amazon_orders').pluck().get()).toBe(digest(reread));
      expect({ windows: windows(), order: order() }).toEqual(before);
    }
  });
  // STEP 9 integration B5 (Root): native explicit-item charges on one capture's line refs, and a second, contradictory read
  // of that same capture seeded into the history (import refuses one capture reading an order twice).
  const nativeCharge = (n: number, date: string, amountMinor: number, captureDigest: string, orderId: string,
    parts: Array<[lineOrdinal: number, amountMinor: number]>) => {
    const subject: MatchSubject = { ref: opaque('subject', `synthetic-native-charge-${n}`), source: SOURCE, evidenceClass: 'payment-event',
      nativeOccurrenceId: `synthetic-native-charge-${n}`, provenance: 'ledger-Charged', status: 'completed', date, money: usd(amountMinor),
      method: { kind: 'card', network: 'visa', last4: '9001' }, orderRefs: [opaque('order', orderId)], tenderProof: 'unknown',
      allocations: parts.map(([lineOrdinal, amount]) => ({ itemRef: opaque('line-observation', [captureDigest, orderId, lineOrdinal]),
        amountMinor: amount, currency: 'USD', attribution: 'explicit-payment-item' as const, classification: 'source' as const,
        sourceCategory: null })), allocationComplete: true };
    return backedUpWrite(db(), backup(), () => {
      db().prepare('INSERT INTO amazon_subjects VALUES(?,?,?,?,?)')
        .run(subject.ref, SOURCE, 'payment-event', subject.nativeOccurrenceId, JSON.stringify(subject));
      db().prepare('INSERT OR IGNORE INTO amazon_event_orders VALUES(?,?)').run(subject.ref, opaque('order', orderId));
    });
  };
  const secondRead = (captureDigest: string, orderId: string, retitle: readonly number[], ordinal: number) =>
    backedUpWrite(db(), backup(), () => {
      const order = JSON.parse(db().prepare(`SELECT data_json FROM amazon_observations WHERE family='order' AND capture_digest=?`)
        .pluck().get(captureDigest) as string) as OrderObservation;
      order.items = order.items.map(i => (retitle.includes(i.lineOrdinal!) ? { ...i, title: `${i.title} read again` } : i));
      db().prepare('INSERT INTO amazon_observations VALUES(?,?,?,?,?,?,?)').run(opaque('observation', [captureDigest, 'order', ordinal]),
        captureDigest, 'order', ordinal, opaque('order', orderId), 'payment-coverage-held', JSON.stringify(order));
    });
  /**
   * STEP 9 integration B5 (Root, C's M13): the history reader keeps the order's entry with every one of its refs explicit,
   * the contested ones null and the others their key, even when every ref of the order is contested.
   */
  const expectHistoryTies = (orderId: string, captureDigest: string, lines: number, contested: readonly number[]) => {
    const ties = readRefundEvidence(db(), activeBindings(db(), readCardInventory(db()))).lineTies.get(opaque('order', orderId));
    const refOf = (n: number) => opaque('line-observation', [captureDigest, orderId, n]);
    expect(ties).toBeDefined();
    expect([...ties!.keys()].sort()).toEqual(Array.from({ length: lines }, (_, n) => refOf(n)).sort());
    for (let n = 0; n < lines; n++) {
      if (contested.includes(n)) expect(ties!.get(refOf(n)), `line ${n}`).toBeNull();
      else expect(typeof ties!.get(refOf(n)), `line ${n}`).toBe('string');
    }
  };
  const contestedCases: Array<[name: string, retitle: number[], ordinal: number]> = [['no second read (control)', [], 0],
    ['one line contested, read after', [0], 1], ['one line contested, read before', [0], -1],
    ['every line contested, read after', [0, 1, 2], 1], ['every line contested, read before', [0, 1, 2], -1]];
  for (const [name, retitle, ordinal] of contestedCases) {
    it(`STEP 9 integration B5 (Root): a mirrored full refund keys ties only from the history reader, 5b01e72f's case: ${name}`, async () => {
      const pair: SyntheticOrder = { ...ORDER_A, lines: [[100, 1], [100, 1]], tax: 0 };
      card({ date: '2026-09-02', amountMinor: 100 }, { date: '2026-09-18', amountMinor: 100 },
        { date: '2026-09-30', amountMinor: -1 }, { date: '2026-10-01', amountMinor: -199 });
      const capture = refundCapture([pair], 1, [ledgerPayment(-1, '2026-09-30', 0), ledgerPayment(-199, '2026-10-01', 1)]);
      await importAmazonCapture(db(), capture, backup()); await categorize();
      await nativeCharge(1, '2026-09-02', 100, digest(capture), pair.id, [[0, 100]]);
      await nativeCharge(2, '2026-09-18', 100, digest(capture), pair.id, [[1, 100]]);
      if (retitle.length) await secondRead(digest(capture), pair.id, retitle.filter(n => n < 2), ordinal);
      expectHistoryTies(pair.id, digest(capture), 2, retitle.filter(n => n < 2)); // STEP 9 integration B5 (Root, C's M13)
      const answer = resolved();
      for (const id of [rowId(100, '2026-09-02'), rowId(100, '2026-09-18')]) expect(answer.get(id)?.kind).toBe('split');
      for (const id of [rowId(-1), rowId(-199)]) {
        expect(snapshot().getCardDetail(id).match).toBe('linked');
        if (retitle.length) expect(answer.get(id)).toEqual({ kind: 'whole-row', cardTransactionId: id, reason: 'refund-unattributed' });
        else expect(answer.get(id)?.kind).toBe('split');
      }
    });
    it(`STEP 9 integration B5 (Root): a partial refund keys lines only from the history reader, C's case: ${name}`, async () => {
      const order: SyntheticOrder = { ...ORDER_A, lines: [[600, 1], [400, 1], [300, 1]], tax: 130 };
      card({ date: '2026-09-02', amountMinor: 1000 }, { date: '2026-09-03', amountMinor: 430 }, { date: '2026-09-20', amountMinor: -1100 });
      const capture = refundCapture([order], 1, [ledgerPayment(-1100, '2026-09-20', 0)]);
      await importAmazonCapture(db(), capture, backup()); await categorize();
      await nativeCharge(1, '2026-09-02', 1000, digest(capture), order.id, [[0, 660], [1, 340]]);
      await nativeCharge(2, '2026-09-03', 430, digest(capture), order.id, [[1, 100], [2, 330]]);
      if (retitle.length) await secondRead(digest(capture), order.id, retitle, ordinal);
      expectHistoryTies(order.id, digest(capture), 3, retitle); // STEP 9 integration B5 (Root, C's M13)
      const answer = resolved(), credit = rowId(-1100);
      for (const id of [rowId(1000), rowId(430)]) expect(answer.get(id)?.kind).toBe('split');
      expect(snapshot().getCardDetail(credit).match).toBe('linked');
      if (retitle.length) expect(answer.get(credit)).toEqual({ kind: 'whole-row', cardTransactionId: credit, reason: 'refund-unattributed' });
      else expect(answer.get(credit)).toMatchObject({ kind: 'split' });
    });
  }
  it('files a one-item partial refund under that item of its charge, leaving the charge byte-identical', async () => {
    card({ date: '2026-09-02', amountMinor: 1100 });
    await importAmazonCapture(db(), refundCapture([ORDER_A]), backup()); await categorize();
    const chargeId = rowId(1100), before = JSON.stringify(resolved().get(chargeId));
    card({ date: '2026-09-20', amountMinor: -660 });
    const refundId = rowId(-660), answer = resolved();
    expect(JSON.stringify(answer.get(chargeId))).toBe(before);
    // 660 is the first line's price and its tax share: that line, on the charge's own capture-scoped item ref.
    const charge = answer.get(chargeId) as Extract<Resolution, { kind: 'split' }>;
    const kitchen = charge.contributions.find(p => p.category === 'Synthetic Kitchen')!.itemRef;
    expect(answer.get(refundId)).toEqual({ kind: 'split', cardTransactionId: refundId, currency: 'USD', evidenceClass: 'unique-total-match',
      contributions: [{ itemRef: kitchen, amountMinor: -660, category: 'Synthetic Kitchen', categorySource: 'item-override',
        classification: 'policy-allocated' }] });
    expect(byCategory()).toEqual({ 'Synthetic Garden': 440, 'Synthetic Kitchen': 0 });
    expect(snapshot().getCardDetail(refundId)).toMatchObject({ match: 'linked', evidenceClass: 'unique-total-match',
      items: [{ itemRef: kitchen }], parts: [{ category: 'Synthetic Kitchen', amountMinor: -660, itemRef: kitchen }] });
    expect(snapshot().matchCounts.refundCredits).toMatchObject({ linked: 1, itemized: 1,
      wholeByReason: [{ reason: 'refund-unattributed', count: 0 }, { reason: 'inconsistent-evidence', count: 0 },
        { reason: 'currency-mismatch', count: 0 }, { reason: 'user-category', count: 0 }, { reason: 'category-unreviewed', count: 0 }] });
    expect(snapshot().matchCounts.itemizedRows).toBe(1);
  });
  it('holds a credit two orders can explain, never choosing the nearer one, and leaves its category unchanged', async () => {
    const b: SyntheticOrder = { id: '000-0000002-0000002', date: '2026-09-05', lines: [[500, 1], [300, 1]], tax: 0 };
    const a: SyntheticOrder = { ...ORDER_A, lines: [[500, 1]], tax: 0 };
    card({ date: '2026-09-02', amountMinor: 500 }, { date: '2026-09-06', amountMinor: 800 }, { date: '2026-09-20', amountMinor: -500 });
    await importAmazonCapture(db(), refundCapture([a, b]), backup()); await categorize();
    const refundId = rowId(-500);
    expect(resolved().get(refundId)).toEqual({ kind: 'whole-row', cardTransactionId: refundId, reason: 'match-held' });
    expect(snapshot().getCardDetail(refundId)).toMatchObject({ match: 'held', hold: { reason: 'match-held', candidateCount: 2 } });
    expect(snapshot().getCardDetail(refundId)).not.toHaveProperty('items');
    expect(snapshot().matchCounts.refundCredits.heldByReason).toContainEqual({ reason: 'ambiguous-order', count: 1 });
    expect(byCategory().Shopping).toBe(-500);
  });
  it('never links across cards, before the order, after the window, or a credit without an Amazon descriptor', async () => {
    card({ date: '2026-09-02', amountMinor: 1100 },
      { date: '2026-09-20', amountMinor: -1100, cardAccountId: otherCardId },
      { date: '2026-08-31', amountMinor: -660 },
      { date: '2026-12-01', amountMinor: -440 },
      { date: '2026-09-21', amountMinor: -1100, description: 'SYNTHETIC HARDWARE STORE RETURN' });
    await importAmazonCapture(db(), refundCapture([ORDER_A]), backup()); await categorize();
    const answer = resolved();
    for (const r of readLedger(db()).filter(r => r.amountMinor < 0)) {
      expect(answer.has(r.id), r.transactionDate).toBe(false);
      expect(snapshot().getCardDetail(r.id).match).toBe('none');
    }
    // The KPI period ends today: the credit dated after it is decided, but not counted.
    expect(snapshot().matchCounts.refundCredits).toMatchObject({ rows: 2, linked: 0 });
    expect(snapshot().matchCounts.refundCredits.heldByReason).toContainEqual({ reason: 'no-candidate', count: 2 });
  });
  it('keeps a linked full refund whole while the owner keeps its charge whole under a category of their own', async () => {
    card({ date: '2026-09-02', amountMinor: 1100 }, { date: '2026-09-20', amountMinor: -1100 });
    await importAmazonCapture(db(), refundCapture([ORDER_A]), backup()); await categorize();
    expect(resolved().get(rowId(-1100))).toMatchObject({ kind: 'split' });
    repo.updateCardTransaction(rowId(1100), { userCategory: 'Synthetic Gifts' }, { actorRef: cardSyncActorRef('synthetic-owner') });
    expect(resolved().get(rowId(-1100))).toMatchObject({ kind: 'whole-row', reason: 'refund-unattributed' });
    expect(snapshot().matchCounts.refundCredits.wholeByReason).toContainEqual({ reason: 'refund-unattributed', count: 1 });
  });
  it('proves the card from a stated refund destination when no charge of the order is linked', async () => {
    card({ date: '2026-09-20', amountMinor: -1100 });
    await importAmazonCapture(db(), refundCapture([ORDER_A]), backup()); await categorize();
    const refundId = rowId(-1100);
    expect(snapshot().matchCounts.refundCredits.heldByReason).toContainEqual({ reason: 'card-unproven', count: 1 });
    // STEP 9 integration (B5)
    // A provenance source that is not exactly one of the closed names never proves the card, even one that reads as it.
    const coerced = opaque('refund-observation', ['synthetic-returns-page', 1]);
    await backedUpWrite(db(), backup(), () => {
      db().prepare('INSERT INTO amazon_refunds VALUES(?,NULL,?,?)').run(coerced, 'issued', JSON.stringify({ kind: 'refund',
        status: 'completed', date: '2026-09-19', money: usd(1100), orderIds: [ORDER_A.id], destinations: [], items: [],
        provenance: { source: ['returns-page'], page: 0, ordinal: 1, phrase: 'refund-issued' } }));
      db().prepare('INSERT INTO amazon_refund_destinations VALUES(?,?,?,?)').run(opaque('refund-destination', [coerced, 0]), coerced,
        'card', JSON.stringify({ method: { kind: 'card', network: 'visa', last4: '9001' }, money: usd(1100), basis: 'stated' }));
    });
    expect(snapshot().matchCounts.refundCredits.heldByReason).toContainEqual({ reason: 'card-unproven', count: 1 });
    expect(snapshot().getCardDetail(refundId).match).toBe('held');
    const before = snapshot().version;
    const refundRef = opaque('refund-observation', ['synthetic-returns-page', 0]);
    await backedUpWrite(db(), backup(), () => {
      db().prepare('INSERT INTO amazon_refunds VALUES(?,NULL,?,?)').run(refundRef, 'issued', JSON.stringify({ kind: 'refund',
        status: 'completed', date: '2026-09-19', money: usd(1100), orderIds: [ORDER_A.id], destinations: [], items: [],
        provenance: { source: 'returns-page', page: 0, ordinal: 0, phrase: 'refund-issued' } }));
      db().prepare('INSERT INTO amazon_refund_destinations VALUES(?,?,?,?)').run(opaque('refund-destination', [refundRef, 0]), refundRef,
        'card', JSON.stringify({ method: { kind: 'card', network: 'visa', last4: '9001' }, money: usd(1100), basis: 'stated' }));
    });
    expect(snapshot().version).not.toBe(before);
    expect(snapshot().getCardDetail(refundId)).toMatchObject({ match: 'linked', evidenceClass: 'unique-total-match' });
    // Linked, but no charge of the order is itemized: it stays whole.
    expect(resolved().get(refundId)).toMatchObject({ kind: 'whole-row', reason: 'refund-unattributed' });
  });
  it('treats a ledger Refunded link as final and counts it against the order capacity', async () => {
    // The second credit is outside the ledger row's own window, so the ledger row has exactly one candidate.
    card({ date: '2026-09-02', amountMinor: 1760 }, { date: '2026-09-20', amountMinor: -660 }, { date: '2026-09-30', amountMinor: -660 });
    await importAmazonCapture(db(), refundCapture([{ ...ORDER_A, lines: [[600, 2], [400, 1]], tax: 160 }], 1,
      [ledgerPayment(-660, '2026-09-20')]), backup());
    await categorize();
    const first = rowId(-660, '2026-09-20'), second = rowId(-660, '2026-09-30');
    expect(snapshot().getCardDetail(first)).toMatchObject({ match: 'linked', evidenceClass: 'payment-ledger-complete' });
    // The second unit's refund is proven by its price and, with the ledger refund, fits the order: linked by the subset.
    expect(snapshot().getCardDetail(second)).toMatchObject({ match: 'linked', evidenceClass: 'unique-total-match' });
    expect(snapshot().matchCounts.refundCredits).toMatchObject({ rows: 2, ledgerLinked: 1, linked: 1, itemized: 2 });
    // Together they refund part of the order, each one unit of the first line: both are filed under that item.
    const kitchen = { amountMinor: -660, category: 'Synthetic Kitchen', classification: 'policy-allocated' };
    expect([first, second].map(id => resolved().get(id))).toMatchObject([
      { kind: 'split', evidenceClass: 'payment-ledger-complete', contributions: [kitchen] },
      { kind: 'split', evidenceClass: 'unique-total-match', contributions: [kitchen] }]);
    expect(byCategory()).toEqual({ 'Synthetic Garden': 440, 'Synthetic Kitchen': 0 });
  });
  it('holds a credit an order with a conflicting history could explain', async () => {
    card({ date: '2026-09-20', amountMinor: -1100 });
    await importAmazonCapture(db(), refundCapture([ORDER_A]), backup());
    const conflicting = refundCapture([ORDER_A], 2);
    conflicting.staging.orders[0].items[0].title = 'Synthetic contradictory line';
    await importAmazonCapture(db(), conflicting, backup());
    expect(snapshot().matchCounts.refundCredits.heldByReason).toContainEqual({ reason: 'order-unprovable', count: 1 });
    expect(snapshot().getCardDetail(rowId(-1100))).toMatchObject({ match: 'held', hold: { candidateCount: 1 } });
  });
  it('treats a refund total that shrinks across captures as contradictory, and one that grows as the latest', async () => {
    card({ date: '2026-09-02', amountMinor: 1100 }, { date: '2026-09-20', amountMinor: -777 });
    await importAmazonCapture(db(), refundCapture([{ ...ORDER_A, refundSummary: 1000 }]), backup());
    await importAmazonCapture(db(), refundCapture([{ ...ORDER_A, refundSummary: 777 }], 2), backup());
    expect(snapshot().getCardDetail(rowId(-777))).toMatchObject({ match: 'held', hold: { candidateCount: 1 } });
    expect(snapshot().matchCounts.refundCredits.heldByReason).toContainEqual({ reason: 'order-unprovable', count: 1 });
    // Once a capture showed it shrinking, a later larger total does not clear the contradiction.
    card({ date: '2026-09-21', amountMinor: -1000 });
    await importAmazonCapture(db(), refundCapture([{ ...ORDER_A, refundSummary: 1000 }], 3), backup());
    expect(snapshot().getCardDetail(rowId(-1000))).toMatchObject({ match: 'held' });
    expect(refundTotalsContradict([{ refundSummary: usd(1000) }, { refundSummary: usd(777) }] as OrderObservation[])).toBe(false);
    expect(refundTotalsContradict([{ refundSummary: usd(777) }, { refundSummary: usd(1000) }] as OrderObservation[])).toBe(true);
    expect(refundTotalsContradict([{ refundSummary: usd(777) }, {}, { refundSummary: { currency: 'EUR', amountMinor: 1 } }] as OrderObservation[])).toBe(true);
  });
  it('links the latest refund total when the history only ever grew', async () => {
    card({ date: '2026-09-02', amountMinor: 1100 }, { date: '2026-09-20', amountMinor: -1000 });
    await importAmazonCapture(db(), refundCapture([{ ...ORDER_A, refundSummary: 777 }]), backup());
    await importAmazonCapture(db(), refundCapture([{ ...ORDER_A, refundSummary: 1000 }], 2), backup());
    expect(snapshot().getCardDetail(rowId(-1000))).toMatchObject({ match: 'linked', evidenceClass: 'unique-total-match' });
    expect(snapshot().matchCounts.refundCredits).toMatchObject({ linked: 1, itemAttribution: { unique: 0, held: 1 } });
    // No set of the order's units comes to 1000: the attribution holds, so the credit stays whole.
    expect(resolved().get(rowId(-1000))).toMatchObject({ kind: 'whole-row', reason: 'refund-unattributed' });
  });
  it('lists a proof-linked credit among its order\'s matches, as the order API shows them (independent review)', async () => {
    card({ date: '2026-09-02', amountMinor: 1100 }, { date: '2026-09-20', amountMinor: -1100 });
    await importAmazonCapture(db(), refundCapture([ORDER_A]), backup()); await categorize();
    const orderRef = opaque('order', ORDER_A.id);
    const entry = { state: 'linked', evidenceClass: 'unique-total-match', cardTransactionId: rowId(-1100), cardAccountId: cardId };
    expect(snapshot().getOrderMatches(orderRef)).toContainEqual(entry);
    expect(getAmazonOrder(db(), orderRef)!.matches).toContainEqual(entry);
    expect(snapshot().getOrderMatches(orderRef)).toHaveLength(2);
  });
  it('holds a credit an order with a larger earlier total could explain, never itemizing it to another order (independent review)', async () => {
    const a: SyntheticOrder = { ...ORDER_A, lines: [[2000, 1]], tax: 0 };
    const b: SyntheticOrder = { id: '000-0000002-0000002', date: '2026-09-16', lines: [[2000, 1]], tax: 0 };
    card({ date: '2026-09-02', amountMinor: 2000 }, { date: '2026-09-17', amountMinor: 2000 }, { date: '2026-09-30', amountMinor: -2000 });
    await importAmazonCapture(db(), refundCapture([a, b]), backup());
    await importAmazonCapture(db(), refundCapture([{ ...a, lines: [[1000, 1]] }], 2), backup()); await categorize();
    const refundId = rowId(-2000);
    expect(snapshot().getCardDetail(refundId)).toMatchObject({ match: 'held', hold: { candidateCount: 2 } });
    expect(resolved().get(refundId)).toEqual({ kind: 'whole-row', cardTransactionId: refundId, reason: 'match-held' });
    expect(snapshot().matchCounts.refundCredits.heldByReason).toContainEqual({ reason: 'ambiguous-order', count: 1 });
  });
  it('does not let a new credit return the unit a final ledger refund already returned (independent review)', async () => {
    card({ date: '2026-09-02', amountMinor: 1600 }, { date: '2026-09-10', amountMinor: -600 }, { date: '2026-09-25', amountMinor: -600 });
    await importAmazonCapture(db(), refundCapture([{ ...ORDER_A, lines: [[600, 1], [1000, 1]], tax: 0 }], 1,
      [ledgerPayment(-600, '2026-09-10')]), backup());
    expect(snapshot().getCardDetail(rowId(-600, '2026-09-10'))).toMatchObject({ match: 'linked', evidenceClass: 'payment-ledger-complete' });
    expect(snapshot().getCardDetail(rowId(-600, '2026-09-25'))).toMatchObject({ match: 'held', hold: { candidateCount: 1 } });
    expect(snapshot().matchCounts.refundCredits.heldByReason).toContainEqual({ reason: 'capacity-exceeded', count: 1 });
  });
  it('lets a refund total observed before a later ledger refund cover only the claims before it (independent review)', async () => {
    card({ date: '2026-09-02', amountMinor: 2000 }, { date: '2026-09-10', amountMinor: -1000 }, { date: '2026-09-25', amountMinor: -1000 });
    await importAmazonCapture(db(), refundCapture([{ ...ORDER_A, lines: [[1000, 2]], tax: 0, refundSummary: 1000 }], 1, [], '2026-09-15'), backup());
    await importAmazonCapture(db(), refundCapture([], 2, [ledgerPayment(-1000, '2026-09-25')]), backup());
    expect(snapshot().getCardDetail(rowId(-1000, '2026-09-25'))).toMatchObject({ match: 'linked', evidenceClass: 'payment-ledger-complete' });
    expect(snapshot().getCardDetail(rowId(-1000, '2026-09-10'))).toMatchObject({ match: 'linked', evidenceClass: 'unique-total-match' });
  });
  it('lets a refund-total match on the order\'s card link past an order that could only possibly explain it (hybrid, Root)', async () => {
    // Order C's summary is unproven and its charge unlinked: it could explain 660, but proves nothing.
    const c: SyntheticOrder = { id: '000-0000002-0000003', date: '2026-09-05', lines: [[3000, 1]], tax: 0 };
    card({ date: '2026-09-02', amountMinor: 1100 }, { date: '2026-09-20', amountMinor: -660 });
    const capture = refundCapture([{ ...ORDER_A, refundSummary: 660 }, c]);
    Object.assign(capture.staging.orders[1], { tenderCoverage: 'unknown',
      tenderProof: { ...capture.staging.orders[1].tenderProof!, summaryComplete: false, unknownSummary: true } });
    await importAmazonCapture(db(), capture, backup()); await categorize();
    expect(snapshot().getCardDetail(rowId(-660))).toMatchObject({ match: 'linked', evidenceClass: 'unique-total-match',
      orderRefs: [opaque('order', ORDER_A.id)] });
    expect(snapshot().matchCounts.refundCredits.linkedByProof).toContainEqual({ proof: 'refund-summary', count: 1 });
    // The same credit under the conservative policy: C competes, so it is held.
    expect(refundCreditCalibration(db(), { ...REFUND_CREDIT_POLICY, competitors: 'conservative' }).outcomes)
      .toEqual([{ outcome: 'held:ambiguous-order', count: 1 }]);
  });
  it('counts a native refund event the matcher links as a final ledger link (independent review)', async () => {
    card({ date: '2026-09-02', amountMinor: 1100 }, { date: '2026-09-10', amountMinor: -1100 }, { date: '2026-09-25', amountMinor: -660 });
    await importAmazonCapture(db(), refundCapture([ORDER_A]), backup()); await categorize();
    const native: MatchSubject = { ref: opaque('subject', 'synthetic-native-refund'), source: SOURCE, evidenceClass: 'payment-event',
      nativeOccurrenceId: 'synthetic-native-refund-1', provenance: 'ledger-Refunded', status: 'completed', date: '2026-09-10',
      money: usd(-1100), method: { kind: 'card', network: 'visa', last4: '9001' }, orderRefs: [opaque('order', ORDER_A.id)],
      tenderProof: 'unknown', allocations: [], allocationComplete: false };
    await backedUpWrite(db(), backup(), () => db().prepare('INSERT INTO amazon_subjects VALUES(?,?,?,?,?)')
      .run(native.ref, SOURCE, 'payment-event', native.nativeOccurrenceId, JSON.stringify(native)));
    expect(snapshot().getCardDetail(rowId(-1100))).toMatchObject({ match: 'linked', evidenceClass: 'payment-event' });
    // The order is already refunded in full by the native event: the new subset credit does not fit it.
    expect(snapshot().getCardDetail(rowId(-660))).toMatchObject({ match: 'held', hold: { candidateCount: 1 } });
    expect(snapshot().matchCounts.refundCredits.heldByReason).toContainEqual({ reason: 'capacity-exceeded', count: 1 });
    // And the native refund itself mirrors the order's itemized charge.
    expect(resolved().get(rowId(-1100))).toMatchObject({ kind: 'split', evidenceClass: 'payment-event' });
    expect(byCategory()).toEqual({ Shopping: -660, 'Synthetic Garden': 0, 'Synthetic Kitchen': 0 });
    expect(snapshot().matchCounts.refundCredits).toMatchObject({ rows: 2, ledgerLinked: 1, linked: 0, itemized: 1 });
  });
  it('counts a linked native refund naming two orders as a ledger link, kept whole, against both orders (independent review)', async () => {
    const b: SyntheticOrder = { id: '000-0000002-0000002', date: '2026-09-03', lines: [[500, 1]], tax: 0 };
    card({ date: '2026-09-02', amountMinor: 1100 }, { date: '2026-09-04', amountMinor: 500 },
      { date: '2026-09-10', amountMinor: -1100 }, { date: '2026-09-25', amountMinor: -500 });
    await importAmazonCapture(db(), refundCapture([ORDER_A, b]), backup()); await categorize();
    const orderRefs = [opaque('order', ORDER_A.id), opaque('order', b.id)];
    const native: MatchSubject = { ref: opaque('subject', 'synthetic-native-two-orders'), source: SOURCE, evidenceClass: 'payment-event',
      nativeOccurrenceId: 'synthetic-native-two-orders-1', provenance: 'ledger-Refunded', status: 'completed', date: '2026-09-10',
      money: usd(-1100), method: { kind: 'card', network: 'visa', last4: '9001' }, orderRefs,
      tenderProof: 'unknown', allocations: [], allocationComplete: false };
    await backedUpWrite(db(), backup(), () => db().prepare('INSERT INTO amazon_subjects VALUES(?,?,?,?,?)')
      .run(native.ref, SOURCE, 'payment-event', native.nativeOccurrenceId, JSON.stringify(native)));
    const nativeId = rowId(-1100);
    expect(snapshot().getCardDetail(nativeId)).toMatchObject({ match: 'linked', evidenceClass: 'payment-event', orderRefs });
    expect(resolved().get(nativeId)).toEqual({ kind: 'whole-row', cardTransactionId: nativeId, reason: 'refund-unattributed' });
    // Its 1100 counts against B too: B's full refund of 500 no longer fits B's 500 total.
    expect(snapshot().getCardDetail(rowId(-500))).toMatchObject({ match: 'held' });
    expect(snapshot().matchCounts.refundCredits).toMatchObject({ rows: 2, ledgerLinked: 1, linked: 0 });
    expect(snapshot().matchCounts.refundCredits.wholeByReason).toContainEqual({ reason: 'refund-unattributed', count: 1 });
  });
  it('lists every closed reason and proof in the KPI and the summary, and calibrates with counts and sums only', async () => {
    // One item refunded 19 days after the order; the other 105 days after, past the 90-day window.
    card({ date: '2026-09-02', amountMinor: 1100 }, { date: '2026-09-20', amountMinor: -660 }, { date: '2026-12-15', amountMinor: -440 });
    await importAmazonCapture(db(), refundCapture([ORDER_A]), backup()); await categorize();
    const counts = snapshot().matchCounts.refundCredits;
    expect(counts.heldByReason.map(r => r.reason)).toEqual(REFUND_HOLD_REASONS);
    expect(counts.linkedByProof.map(r => r.proof)).toEqual(REFUND_ORDER_PROOFS);
    expect(Object.isFrozen(counts) && Object.isFrozen(counts.heldByReason)).toBe(true);
    expect(amazonSummary(db()).refundCredits).toEqual(counts);
    const calibration = refundCreditCalibration(db());
    expect(calibration).toMatchObject({ credits: 2, itemAttribution: { unique: 1, held: 0 },
      outcomes: [{ outcome: 'held:no-candidate', count: 1 }, { outcome: 'linked', count: 1 }],
      linkedByProof: [{ proof: 'subset', count: 1, sumMinor: 660 }] });
    expect(calibration.lagHistogram.find(b => b.from === 15)).toEqual({ from: 15, to: 30, count: 1 });
    // A 180-day shadow run also finds the late credit; neither run names a row, order or card.
    const shadow = refundCreditCalibration(db(), { ...REFUND_CREDIT_POLICY, maxLagDays: 180 });
    expect(shadow).toMatchObject({ outcomes: [{ outcome: 'linked', count: 2 }], itemAttribution: { unique: 2, held: 0 } });
    expect(shadow.lagHistogram.find(b => b.from === 91)).toEqual({ from: 91, to: 120, count: 1 });
    const text = JSON.stringify([calibration, shadow]);
    for (const id of [...readLedger(db()).map(r => r.id), cardId, opaque('order', ORDER_A.id), ORDER_A.id]) expect(text).not.toContain(id);
  });
});

describe('partial card refunds filed under the items they paid back, in the live resolver', () => {
  it('splits on the observation the charge was allocated on, not on a later one without a proven item block', async () => {
    card({ date: '2026-09-02', amountMinor: 1100 }, { date: '2026-09-20', amountMinor: -660 });
    await importAmazonCapture(db(), refundCapture([{ ...ORDER_A, refundSummary: 660 }]), backup());
    // The order is captured again: the same purchase, but its item block is not proven complete this time.
    const later = refundCapture([{ ...ORDER_A, refundSummary: 660 }], 2);
    later.staging.orders[0].itemProof = { complete: false, unknownLine: false, conflict: false };
    await importAmazonCapture(db(), later, backup()); await categorize();
    const [firstCapture] = db().prepare('SELECT digest FROM amazon_captures ORDER BY rowid').pluck().all() as string[];
    const kitchen = opaque('line-observation', [firstCapture, ORDER_A.id, 0]);
    const answer = resolved();
    expect(answer.get(rowId(1100))).toMatchObject({ kind: 'split', contributions: [{ itemRef: kitchen }, { itemRef: kitchen }, {}, {}] });
    expect(answer.get(rowId(-660))).toMatchObject({ kind: 'split', evidenceClass: 'unique-total-match',
      contributions: [{ itemRef: kitchen, amountMinor: -660, category: 'Synthetic Kitchen', classification: 'policy-allocated' }] });
    expect(byCategory()).toEqual({ 'Synthetic Garden': 440, 'Synthetic Kitchen': 0 });
  });
  it('STEP 9 integration (#154 x #168): splits on the displayed observation when a later complete read is kept back', async () => {
    card({ date: '2026-09-02', amountMinor: 1100 }, { date: '2026-09-20', amountMinor: -660 });
    // The first read lacks the kitchen line's ASIN, which the agent categorized by title alone (#168's owner decisions).
    const first = refundCapture([{ ...ORDER_A, refundSummary: 660 }]);
    first.staging.orders[0].items[0].itemId = null;
    await importAmazonCapture(db(), first, backup());
    const title = first.staging.orders[0].items[0].title;
    db().prepare("INSERT INTO amazon_agent_categories VALUES(?,?,?,'agent','categorized from product title')")
      .run(productKey({ asin: null, title }), 'Shopping', 0.9);
    // A complete re-read learns the ASIN: the agent category cannot follow the new key, so the display stays on the first.
    const kept = await importAmazonCapture(db(), refundCapture([{ ...ORDER_A, refundSummary: 660 }], 2), backup());
    expect(kept.holds).toContainEqual({ reason: 'item-category-unmatched', count: 1 });
    await categorize();
    const [firstCapture, secondCapture] = db().prepare('SELECT digest FROM amazon_captures ORDER BY rowid').pluck().all() as string[];
    expect(db().prepare('SELECT latest_digest FROM amazon_orders').pluck().get()).toBe(firstCapture);
    const kitchen = opaque('line-observation', [firstCapture, ORDER_A.id, 0]);
    expect(kitchen).not.toBe(opaque('line-observation', [secondCapture, ORDER_A.id, 0]));
    const answer = resolved();
    expect(answer.get(rowId(1100))).toMatchObject({ kind: 'split', contributions: [{ itemRef: kitchen }, { itemRef: kitchen }, {}, {}] });
    expect(answer.get(rowId(-660))).toMatchObject({ kind: 'split', evidenceClass: 'unique-total-match',
      contributions: [{ itemRef: kitchen, amountMinor: -660, category: 'Synthetic Kitchen', classification: 'policy-allocated' }] });
    expect(byCategory()).toEqual({ 'Synthetic Garden': 440, 'Synthetic Kitchen': 0 });
  });
  it('keeps every credit of the order whole when two final refunds give its one unit of a line back twice', async () => {
    // A large shipping share leaves money room on the first line's charge part, but the line had one unit.
    card({ date: '2026-09-02', amountMinor: 6100 }, { date: '2026-09-10', amountMinor: -660 }, { date: '2026-09-25', amountMinor: -660 });
    const capture = refundCapture([ORDER_A], 1, [ledgerPayment(-660, '2026-09-10'), ledgerPayment(-660, '2026-09-25', 1)]);
    const order = capture.staging.orders[0];
    order.total = usd(6100);
    order.summary = order.summary!.map(s => (s.kind === 'shipping' ? { ...s, money: usd(5000) } : s.kind === 'grand-total' ? { ...s, money: usd(6100) } : s));
    await importAmazonCapture(db(), capture, backup()); await categorize();
    const chargeId = rowId(6100), refunds = [rowId(-660, '2026-09-10'), rowId(-660, '2026-09-25')];
    for (const id of refunds) expect(snapshot().getCardDetail(id)).toMatchObject({ match: 'linked', evidenceClass: 'payment-ledger-complete' });
    const answer = resolved();
    expect(refunds.map(id => answer.get(id))).toEqual(refunds.map(id => ({ kind: 'whole-row', cardTransactionId: id, reason: 'inconsistent-evidence' })));
    expect(answer.get(chargeId)).toMatchObject({ kind: 'split', evidenceClass: 'unique-total-match' });
    expect(snapshot().matchCounts.refundCredits).toMatchObject({ ledgerLinked: 2, itemized: 0 });
    expect(snapshot().matchCounts.refundCredits.wholeByReason).toContainEqual({ reason: 'inconsistent-evidence', count: 2 });
    expect(byCategory()).toEqual({ Shopping: -1320, 'Synthetic Garden': 2440, 'Synthetic Kitchen': 3660 });
  });
});
