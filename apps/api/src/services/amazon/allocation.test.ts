import { describe, expect, it } from 'vitest';
import { allocateOrder, itemBlockReconciles, largestRemainder, lineTieKeys, orderHistoryConflicts, provenOrderFacts } from './allocation.js';
import { syntheticCapture, syntheticRow, syntheticSubject } from './fixtures.testSupport.js';
import { resolveSubject } from './resolver.js';
import { digest, opaque, ORDER_HISTORY_POLICY, ORDER_HISTORY_POLICY_DIGEST } from './policy.js';
import type { OrderObservation } from './types.js';

function order(): OrderObservation {
  const o = structuredClone(syntheticCapture().staging.orders[0]);
  o.itemProof = { complete: true, unknownLine: false, conflict: false };
  o.items = [0, 1, 2].map(lineOrdinal => ({ ...o.items[0], lineOrdinal, quantity: 1,
    unitPrice: { currency: 'USD', amountMinor: 100 } }));
  o.summary = [
    { kind: 'items-subtotal', money: { currency: 'USD', amountMinor: 300 } },
    { kind: 'shipping', money: { currency: 'USD', amountMinor: 1 } },
    { kind: 'tax', money: { currency: 'USD', amountMinor: 2 } },
    { kind: 'promotion', money: { currency: 'USD', amountMinor: 1 } },
    { kind: 'grand-total', money: { currency: 'USD', amountMinor: 302 } },
  ];
  o.total = { currency: 'USD', amountMinor: 302 };
  return o;
}
describe('positively complete single-card policy allocation', () => {
  it('never treats a changing post-order refund summary as purchase money or a purchase-proof conflict', () => {
    const o = order(), captureDigest = digest('synthetic-refund-summary');
    const facts = provenOrderFacts(o), before = allocateOrder(o, captureDigest, false);
    for (const amountMinor of [0, 100, 100000000]) {
      o.refundSummary = { currency: 'USD', amountMinor };
      expect(provenOrderFacts(o)).toEqual(facts);
      expect(allocateOrder(o, captureDigest, false)).toEqual(before);
    }
  });
  it('allocates finalized inferred quantity one without changing the staging or allocation contract', () => {
    const o = order();
    expect(o.items.every(i => i.quantity === 1)).toBe(true);
    expect(itemBlockReconciles(o)).toBe(true);
    const result = allocateOrder(o, digest('synthetic-inferred-one'), false);
    expect(result.complete).toBe(true);
    expect(result.allocations.reduce((n, a) => n + a.amountMinor, 0)).toBe(o.total!.amountMinor);
    o.items[0].quantity = null;
    expect(itemBlockReconciles(o)).toBe(false);
    expect(allocateOrder(o, digest('synthetic-unfinalized'), false).complete).toBe(false);
  });
  it('keeps repeated ASIN lines distinct, allocates each component exactly with stable ref ties', () => {
    const o = order(), result = allocateOrder(o, digest('synthetic'), false);
    expect(result.complete).toBe(true);
    expect(new Set(result.allocations.map(a => a.itemRef)).size).toBe(3);
    expect(result.allocations.reduce((n, a) => n + a.amountMinor, 0)).toBe(302);
    expect(result.allocations.every(a => a.amountMinor > 0 && a.attribution === 'order-total-policy')).toBe(true);
    expect(allocateOrder({ ...o, items: [...o.items].reverse() }, digest('synthetic'), false).allocations
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
      .toEqual([...result.allocations].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  });
  it('gives a tied cent by the order and the line\'s stable identity, never by a capture ref or an image ID', () => {
    // Two $1 lines and a one-cent tax: the cent's remainder ties between the lines.
    const o = order();
    o.items = o.items.slice(0, 2).map((item, n) => ({ ...item, title: `Synthetic tied product ${n}` }));
    o.summary = [{ kind: 'items-subtotal', money: { currency: 'USD', amountMinor: 200 } },
      { kind: 'shipping', money: { currency: 'USD', amountMinor: 0 } }, { kind: 'tax', money: { currency: 'USD', amountMinor: 1 } },
      { kind: 'grand-total', money: { currency: 'USD', amountMinor: 201 } }];
    o.total = { currency: 'USD', amountMinor: 201 };
    const byLine = (read: OrderObservation, captureDigest: string) => {
      const result = allocateOrder(read, captureDigest, false);
      expect(result.complete).toBe(true);
      const ordinals = new Map(read.items.map(i => [opaque('line-observation', [captureDigest, read.orderId, i.lineOrdinal]), i.lineOrdinal]));
      return result.allocations.reduce((sums, a) => sums.set(ordinals.get(a.itemRef)!, (sums.get(ordinals.get(a.itemRef)!) ?? 0)
        + a.amountMinor), new Map<number | undefined, number>());
    };
    const first = byLine(o, digest('synthetic-capture-1'));
    expect([...first.values()].sort()).toEqual([100, 101]);
    // Display-only re-reads (new capture refs, an image ID) and a learned ASIN, which every replacement may bring.
    for (let n = 2; n <= 24; n++) {
      const reread = structuredClone(o);
      reread.items[n % 2].imageId = '91SynthAA0L';
      if (n % 3 === 0) reread.items.forEach(i => { i.itemId = null; });
      expect(byLine(reread, digest(`synthetic-capture-${n}`))).toEqual(first);
    }
    expect(lineTieKeys(o)).toEqual(new Map([0, 1].map(n => [n, opaque('line-identity', [o.orderId, `Synthetic tied product ${n}`, 0])])));
    // Repeated titles stay distinct by occurrence, in line order, however the lines are listed.
    const repeated = order(), keys = lineTieKeys(repeated);
    expect(new Set(keys.values()).size).toBe(3);
    expect(lineTieKeys({ ...repeated, items: [...repeated.items].reverse() })).toEqual(keys);
  });
  it('lets a stable tie key decide a tied remainder, and refuses one that is not unique', () => {
    const [r1, r2, t1, t2] = ['a', 'b', 'c', 'd'].map(n => opaque('synthetic', n)).sort();
    expect(largestRemainder(1, [{ ref: r1, weight: 1, tie: t2 }, { ref: r2, weight: 1, tie: t1 }])).toEqual(new Map([[r2, 1], [r1, 0]]));
    expect(largestRemainder(1, [{ ref: r2, weight: 1, tie: t1 }, { ref: r1, weight: 1, tie: t2 }])).toEqual(new Map([[r2, 1], [r1, 0]]));
    expect(() => largestRemainder(1, [{ ref: r1, weight: 1, tie: t1 }, { ref: r2, weight: 1, tie: t1 }])).toThrow();
    expect(() => largestRemainder(1, [{ ref: r1, weight: 1, tie: 'not-a-ref' }])).toThrow();
  });
  it('folds net discounts into one policy part per item with no opposite-sign contributions', () => {
    const o = order();
    o.summary!.find(s => s.kind === 'promotion')!.money.amountMinor = 100;
    o.summary!.find(s => s.kind === 'grand-total')!.money.amountMinor = 203;
    o.total!.amountMinor = 203;
    const result = allocateOrder(o, digest('synthetic'), false);
    expect(result.complete).toBe(true);
    expect(result.allocations).toHaveLength(3);
    expect(result.allocations.every(a => a.amountMinor > 0 && a.classification === 'policy-allocated')).toBe(true);
    expect(result.allocations.reduce((n, a) => n + a.amountMinor, 0)).toBe(203);
  });
  it('requires a positive block witness, not merely subtotal equality or observed ordinals', () => {
    const o = order();
    for (const proof of [undefined, { complete: false, unknownLine: false, conflict: false },
      { complete: true, unknownLine: true, conflict: false }, { complete: true, unknownLine: false, conflict: true }]) {
      expect(allocateOrder({ ...o, itemProof: proof }, digest('synthetic'), false))
        .toMatchObject({ complete: false, reason: 'item-identity-unproven', allocations: [] });
    }
    expect(allocateOrder(o, digest('synthetic'), true)).toMatchObject({ reason: 'inconsistent-evidence', allocations: [] });
  });
  it('does not accept truncated subsets even when every surviving line is typed', () => {
    const o = order();
    o.items.pop();
    expect(itemBlockReconciles(o)).toBe(false);
    // A subset with an accidentally matching total still cannot turn a failed block parse into proof.
    o.items[0].quantity = 2;
    o.itemProof!.unknownLine = true;
    expect(itemBlockReconciles(o)).toBe(false);
    expect(allocateOrder(o, digest('synthetic'), false).complete).toBe(false);
  });
  it.each(['quantity', 'unitPrice', 'currency', 'ordinal'] as const)('holds unknown or conflicting %s', field => {
    const o = order();
    if (field === 'quantity') o.items[0].quantity = null;
    if (field === 'unitPrice') o.items[0].unitPrice = null;
    if (field === 'currency') o.items[0].unitPrice!.currency = 'EUR';
    if (field === 'ordinal') o.items[0].lineOrdinal = o.items[1].lineOrdinal;
    expect(allocateOrder(o, digest('synthetic'), false).complete).toBe(false);
  });
  it('produces only conserving purchase splits and labels policy, never fabricates event attribution', () => {
    const o = order(), result = allocateOrder(o, digest('synthetic'), false);
    const subject = syntheticSubject({ evidenceClass: 'unique-total-match', nativeOccurrenceId: null,
      provenance: 'order-total', money: o.total!, allocationComplete: result.complete, allocations: result.allocations });
    const refs = [...new Set(result.allocations.map(a => a.itemRef))];
    const agents = new Map(refs.map(r => [r, 'Shopping']));
    const row = syntheticRow({ amountMinor: 302 });
    const split = resolveSubject(row, subject, new Set(['Shopping']), new Map(), new Map(), agents);
    expect(split.kind).toBe('split');
    if (split.kind !== 'split') return;
    expect(split.contributions.reduce((n, p) => n + p.amountMinor, 0)).toBe(row.amountMinor);
    expect(split.contributions.some(p => p.classification === 'policy-allocated')).toBe(true);
    expect(split.contributions.every(p => p.categorySource === 'agent-classification')).toBe(true);
    expect(resolveSubject(row, { ...subject, evidenceClass: 'payment-event' }, new Set(['Shopping']), new Map(), new Map(), agents))
      .toMatchObject({ kind: 'whole-row', reason: 'inconsistent-evidence' });
    expect(resolveSubject({ ...row, amountMinor: -302, kind: 'refund' }, subject, new Set(['Shopping']), new Map(), new Map(), agents))
      .toMatchObject({ kind: 'whole-row' });
  });
  it('compares proven collections in any order but never past a differing known attribute', () => {
    const a = order(), b = structuredClone(a);
    b.items.reverse(); b.summary!.reverse();
    expect(orderHistoryConflicts([{ order: a }, { order: b }])).toBe(false);
    b.items[0].quantity = 2;
    expect(orderHistoryConflicts([{ order: a }, { order: b }])).toBe(true);
  });
  it('compares every stated line attribute but the position and the display-only imageId under order-history policy v3', () => {
    const a = order(), b = order();
    a.items.forEach((i, n) => { i.imageId = ['91Synth+01L', '91Synth-02L', 'A1Synth+-3S'][n]; });
    b.items[0].imageId = '91SynthAA0L';
    expect(orderHistoryConflicts([{ order: a }, { order: b }])).toBe(false);
    expect(a.items[0].imageId).toBe('91Synth+01L');
    expect(provenOrderFacts(a).items!.every(line => !line.has('imageId') && !line.has('lineOrdinal') && line.has('title'))).toBe(true);
    // Any other attribute both state still counts; one that only one of them states is unread in the other.
    const stating = (url: string) => {
      const o = order();
      o.items.forEach(i => { (i as unknown as Record<string, unknown>).imageUrl = url; });
      return o;
    };
    expect(orderHistoryConflicts([{ order: stating('https://synthetic.invalid/kettle.jpg') }, { order: order() }])).toBe(false);
    expect(orderHistoryConflicts([{ order: stating('https://synthetic.invalid/kettle.jpg') },
      { order: stating('https://synthetic.invalid/teapot.jpg') }])).toBe(true);
    expect(ORDER_HISTORY_POLICY).toEqual({ version: 'amazon-order-history-v4',
      header: 'validated-explicit-unobserved-empty-header-only',
      conflicts: 'explicit-item-or-tender-proof-conflict-or-a-fact-proven-in-both-with-different-values',
      unread: 'a-tender-conflict-its-capture-attributes-only-to-unknown-label-summary-hold-or-method-incomplete-is-no-conflict',
      compared: 'total-if-non-null|tenderCoverage-if-not-unknown'
        + '|items-if-complete-no-unknown-line-or-conflict-multiset-of-lines-by-stated-attributes-except-lineOrdinal-and-display-only-imageId'
        + '|methods-if-methodComplete-multiset-of-instruments-by-kind-network-last4'
        + '|summary-if-summaryComplete-multiset-of-components-by-kind-and-amount',
      absent: 'null-or-unknown-is-unread-never-a-value-collections-pair-one-to-one-in-any-order',
      allocation: 'retained-independently-complete-observation-no-anchor-promotion',
      rounding: 'largest-remainder-ties-by-order-exact-title-and-occurrence-by-ordinal-never-capture-refs-or-image-ids' });
    expect(ORDER_HISTORY_POLICY_DIGEST).toBe(digest(ORDER_HISTORY_POLICY));
    // Pinned: the resolver snapshot version hashes this digest, so any change to the policy changes every version.
    expect(ORDER_HISTORY_POLICY_DIGEST).toBe('87dc580f546a425b22aab232e9407280b4e5fef0cda76271495d3ff706896bde');
    // v3 (b4625915…) counted every explicit tender conflict, an unread one included.
    expect(ORDER_HISTORY_POLICY_DIGEST).not.toBe('b4625915f8538d294967291e5f096e6b9f786cc8efe0fd5017d62a859d11f439');
    expect(ORDER_HISTORY_POLICY_DIGEST).not.toBe(digest({ version: 'amazon-order-history-v2',
      header: 'validated-explicit-unobserved-empty-header-only',
      conflicts: 'all-nonheaders-whole-fingerprint-except-display-only-item-imageId-and-all-positive-totals',
      allocation: 'retained-independently-complete-observation-no-anchor-promotion' }));
  });
  it('proves a fact only where the observation proves it, and an unread value is absent', () => {
    const o = order();
    expect(Object.keys(provenOrderFacts(o)).sort()).toEqual(['items', 'methods', 'summary', 'tenderCoverage', 'total']);
    expect(provenOrderFacts({ ...o, total: null })).not.toHaveProperty('total');
    expect(provenOrderFacts({ ...o, itemProof: undefined })).not.toHaveProperty('items');
    for (const itemProof of [{ complete: false, unknownLine: false, conflict: false },
      { complete: true, unknownLine: true, conflict: false }, { complete: true, unknownLine: false, conflict: true }]) {
      expect(provenOrderFacts({ ...o, itemProof })).not.toHaveProperty('items');
    }
    const tender = { methodComplete: true, summaryComplete: true, unknownMethod: false, unknownSummary: false, conflict: false };
    expect(provenOrderFacts({ ...o, tenderProof: tender })).toEqual(provenOrderFacts(o));
    expect(provenOrderFacts({ ...o, tenderProof: { ...tender, methodComplete: false } })).not.toHaveProperty('methods');
    expect(provenOrderFacts({ ...o, tenderProof: { ...tender, summaryComplete: false } })).not.toHaveProperty('summary');
    expect(provenOrderFacts({ ...o, tenderProof: undefined })).not.toHaveProperty('methods');
    expect(provenOrderFacts({ ...o, tenderCoverage: 'unknown' })).not.toHaveProperty('tenderCoverage');
    expect(provenOrderFacts({ ...o, tenderCoverage: undefined })).not.toHaveProperty('tenderCoverage');
    expect(provenOrderFacts({ ...o, date: '2026-09-30', refundSummary: { currency: 'USD', amountMinor: 1 } }))
      .toEqual(provenOrderFacts(o));
    const unread = order();
    unread.items[0].itemId = null; unread.items[1].quantity = null; unread.items[2].unitPrice = null;
    unread.paymentMethods = [{ kind: 'card', network: 'unknown', last4: null }];
    const facts = provenOrderFacts(unread);
    expect(facts.items!.map(line => [...line.keys()].sort())).toEqual([['quantity', 'title', 'unitPrice'],
      ['itemId', 'title', 'unitPrice'], ['itemId', 'quantity', 'title']]);
    expect(facts.methods!.map(method => [...method.keys()])).toEqual([['kind']]);
  });
  it('keeps zero-price observed lines but omits zero contributions and refuses an all-zero base', () => {
    const o = order();
    o.items.push({ ...o.items[0], lineOrdinal: 3, unitPrice: { currency: 'USD', amountMinor: 0 } });
    expect(itemBlockReconciles(o)).toBe(true);
    const result = allocateOrder(o, digest('synthetic'), false);
    expect(result.complete).toBe(true);
    expect(new Set(result.allocations.map(a => a.itemRef)).size).toBe(3);
    for (const i of o.items) i.unitPrice!.amountMinor = 0;
    o.summary!.find(s => s.kind === 'items-subtotal')!.money.amountMinor = 0;
    o.total!.amountMinor = 2; o.summary!.find(s => s.kind === 'grand-total')!.money.amountMinor = 2;
    expect(itemBlockReconciles(o)).toBe(true);
    expect(allocateOrder(o, digest('synthetic'), false)).toMatchObject({ complete: false, allocations: [] });
  });
  it('holds negative final components caused by unsupported discount rounding', () => {
    const o = order();
    o.items.forEach(i => { i.unitPrice!.amountMinor = 1; });
    for (const s of o.summary!) {
      if (s.kind === 'items-subtotal') s.money.amountMinor = 3;
      if (s.kind === 'shipping' || s.kind === 'tax') s.money.amountMinor = 2;
      if (s.kind === 'promotion') s.money.amountMinor = 6;
      if (s.kind === 'grand-total') s.money.amountMinor = 1;
    }
    o.total!.amountMinor = 1;
    expect(allocateOrder(o, digest('synthetic'), false)).toMatchObject({ complete: false, reason: 'negative-component', allocations: [] });
  });
});

describe('order-history policy v3: only a field both observations prove, with different values, conflicts', () => {
  const conflicts = (...orders: OrderObservation[]) => orderHistoryConflicts(orders.map(o => ({ order: o })));
  const tender = (patch: Partial<NonNullable<OrderObservation['tenderProof']>> = {}) => ({ methodComplete: false,
    summaryComplete: false, unknownMethod: false, unknownSummary: false, conflict: false, ...patch });
  const unprovenItems = () => ({ complete: false, unknownLine: true, conflict: false });
  const header = (o: OrderObservation) => {
    o.items = []; o.paymentMethods = []; o.summary = []; o.tenderCoverage = 'unknown'; o.tenderProof = tender();
    delete o.itemProof;
  };
  // Each read differs from the proven order only where it proves nothing, or in what is never compared.
  const unproven: Array<[string, (o: OrderObservation) => void]> = [
    ['a header-only read', header],
    ['a charge-free read with no total', o => { header(o); o.total = null; }],
    ['a method-only read', o => { header(o); o.paymentMethods = order().paymentMethods; o.tenderProof = tender({ methodComplete: true });
      o.itemProof = unprovenItems(); }],
    ['a title-only read', o => { header(o); o.items = [{ ...order().items[0], quantity: null, unitPrice: null }];
      o.itemProof = unprovenItems(); }],
    ['another title and price on an unproven item list', o => { o.items[0].title = 'Synthetic retitled widget';
      o.items[0].unitPrice = { currency: 'USD', amountMinor: 90 }; o.itemProof = unprovenItems(); }],
    ['one line fewer without an item proof', o => { o.items.pop(); delete o.itemProof; }],
    ['other methods without method completeness', o => { o.paymentMethods = [{ kind: 'balance', network: 'unknown', last4: null }];
      o.tenderProof = tender({ summaryComplete: true }); o.tenderCoverage = 'unknown'; }],
    ['another summary without summary completeness', o => { o.summary = o.summary!.filter(s => s.kind === 'grand-total');
      o.tenderProof = tender({ methodComplete: true }); o.tenderCoverage = 'unknown'; }],
    ['an unknown tender coverage', o => { o.tenderCoverage = 'unknown'; }],
    ['a larger Refund Total', o => { o.refundSummary = { currency: 'USD', amountMinor: 200 }; }],
    ['a smaller Refund Total', o => { o.refundSummary = { currency: 'USD', amountMinor: 50 }; }],
    ['another order date', o => { o.date = '2026-09-02'; }],
    ['other display-only image IDs', o => { o.items.forEach((i, n) => { i.imageId = `91Synth+0${n}L`; }); }],
    ['an unread ASIN in a complete item list', o => { o.items[0].itemId = null; }],
    ['an unread quantity and price in a complete item list', o => { o.items[0].quantity = null; o.items[1].unitPrice = null; }],
    ['an unread card network and last four in a complete method list', o => {
      o.paymentMethods = [{ kind: 'card', network: 'unknown', last4: null }]; }],
    ['the same lines and summary components in another order', o => {
      o.items = o.items.reverse().map((item, lineOrdinal) => ({ ...item, lineOrdinal })); o.summary!.reverse(); }],
  ];
  it.each(unproven)('never conflicts over %s', (_, change) => {
    const shown = order(), next = order();
    shown.refundSummary = { currency: 'USD', amountMinor: 100 };
    change(next);
    expect(conflicts(shown, next)).toBe(false);
    expect(conflicts(next, shown)).toBe(false);
  });
  const proven: Array<[string, (o: OrderObservation) => void]> = [
    ['another total on a header-only read', o => { header(o); o.total = { currency: 'USD', amountMinor: 303 }; }],
    ['another title in a complete item list', o => { o.items[0].title = 'Synthetic retitled widget'; }],
    ['other line prices in a complete item list', o => { o.items[0].unitPrice = { currency: 'USD', amountMinor: 90 };
      o.items[1].unitPrice = { currency: 'USD', amountMinor: 110 }; }],
    ['one line fewer in a complete item list', o => { o.items.pop(); }],
    ['other complete methods', o => { o.paymentMethods = [{ kind: 'card', network: 'visa', last4: '9002' }]; }],
    ['another complete summary', o => { o.summary!.find(s => s.kind === 'shipping')!.money.amountMinor = 2;
      o.summary!.find(s => s.kind === 'tax')!.money.amountMinor = 1; }],
    ['another known tender coverage', o => { o.tenderCoverage = 'multi-tender'; }],
    ['another known ASIN in a complete item list', o => { o.items[0].itemId = 'SYNTH00009'; }],
    ['another known card network in a complete method list', o => {
      o.paymentMethods = [{ kind: 'card', network: 'mastercard', last4: '9001' }]; }],
    ['one instrument more in a complete method list', o => { o.paymentMethods!.push({ kind: 'balance', network: 'unknown', last4: null }); }],
  ];
  it.each(proven)('conflicts over %s', (_, change) => {
    const shown = order(), next = order();
    change(next);
    expect(conflicts(shown, next)).toBe(true);
    expect(conflicts(next, shown)).toBe(true);
  });
  it.each([['item', (o: OrderObservation) => { o.itemProof = { complete: false, unknownLine: false, conflict: true }; }],
    ['tender', (o: OrderObservation) => { o.tenderProof!.conflict = true; }]] as const)(
    'keeps an explicit %s proof conflict held on its own', (_, change) => {
      const o = order();
      change(o);
      expect(conflicts(o)).toBe(true);
      expect(conflicts(order(), o)).toBe(true);
    });
  it('never lets a later agreeing read hide an earlier proven difference, and compares each field among its provers only', () => {
    const a = order(), b = order(), c = order();
    b.items[0].title = 'Synthetic retitled widget';
    expect(conflicts(a, b, c)).toBe(true);
    expect(conflicts(c, a, b)).toBe(true);
    const partial = order();
    partial.items[0].title = 'Synthetic retitled widget'; partial.itemProof = unprovenItems();
    expect(conflicts(a, partial, c)).toBe(false);
    expect(conflicts(partial)).toBe(false);
    expect(conflicts()).toBe(false);
  });
  it('pairs every two provers on their own: an unread value agrees with each known one, two known ones still differ', () => {
    const unread = order(), first = order(), second = order();
    unread.items.forEach(i => { i.itemId = null; });
    second.items.forEach(i => { i.itemId = 'SYNTH00009'; });
    expect(conflicts(unread, first)).toBe(false);
    expect(conflicts(unread, second)).toBe(false);
    expect(conflicts(first, unread, second)).toBe(true);
    expect(conflicts(unread, second, first)).toBe(true);
  });
});

describe('order-history policy v3: proven collections in any order (property)', () => {
  const conflicts = (...orders: OrderObservation[]) => orderHistoryConflicts(orders.map(o => ({ order: o })));
  // A seeded generator (mulberry32): the same permutations on every run.
  const generator = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const shuffle = <T>(list: T[], next: () => number): T[] => {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  };
  const proven = (): OrderObservation => {
    const o = order();
    o.items = [0, 1, 2, 3, 4].map(n => ({ lineOrdinal: n, itemId: `SYNTH0000${n + 1}`, title: `Synthetic gadget ${n + 1}`,
      quantity: 1 + (n % 2), unitPrice: { currency: 'USD', amountMinor: 100 + 10 * n } }));
    o.paymentMethods = [{ kind: 'card', network: 'visa', last4: '9001' }, { kind: 'card', network: 'visa', last4: '9002' },
      { kind: 'balance', network: 'unknown', last4: null }];
    o.tenderCoverage = 'multi-tender';
    return o;
  };
  // The same facts in another presentation order: line ordinals are positions, so they are renumbered in the new order.
  const permuted = (o: OrderObservation, next: () => number) => {
    const p = structuredClone(o);
    p.items = shuffle(p.items, next).map((item, lineOrdinal) => ({ ...item, lineOrdinal }));
    p.paymentMethods = shuffle(p.paymentMethods!, next);
    p.summary = shuffle(p.summary!, next);
    return p;
  };
  const pick = <T>(list: T[], next: () => number) => list[Math.floor(next() * list.length)];
  it('never conflicts over any reordering, with or without unread values, and always over a known change', () => {
    const next = generator(168), base = proven();
    for (let n = 0; n < 300; n++) {
      const same = permuted(base, next);
      expect(conflicts(base, same)).toBe(false);
      expect(conflicts(same, base)).toBe(false);
      const unread = permuted(base, next);
      pick(unread.items, next).itemId = null;
      pick(unread.items, next).unitPrice = null;
      const card = unread.paymentMethods!.find(m => m.last4 === (n % 2 ? '9001' : '9002'))!;
      card.network = 'unknown'; card.last4 = null;
      expect(conflicts(base, unread)).toBe(false);
      expect(conflicts(unread, same)).toBe(false);
      const changed = permuted(base, next), line = pick(changed.items, next);
      if (n % 4 === 0) line.unitPrice = { currency: 'USD', amountMinor: line.unitPrice!.amountMinor + 1 };
      if (n % 4 === 1) line.itemId = 'SYNTH00099';
      if (n % 4 === 2) changed.paymentMethods = changed.paymentMethods!
        .map(m => (m.last4 === '9002' ? { ...m, last4: '9003' } : m));
      if (n % 4 === 3) pick(changed.summary!, next).money.amountMinor += 1;
      expect(conflicts(base, changed)).toBe(true);
      expect(conflicts(changed, permuted(base, next))).toBe(true);
    }
  });
});
