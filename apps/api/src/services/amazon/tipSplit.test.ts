import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStateRepo } from '../sqliteStateRepo.js';
import { proposeBindings, readCardInventory } from './bindings.js';
import { recordBindingProposal, recordRootApproval } from './importer.js';
import { matchAmazon } from './matcher.js';
import { digest, opaque, POLICY_DIGEST, TIP_SPLIT_POLICY_DIGEST } from './policy.js';
import { createAmazonCategoryResolver } from './resolver.js';
import { ensureAmazonSchema } from './schema.js';
import { gatePassed, importSavedOrders, parseSavedOrders, settleAmazon, type SavedOrdersFile } from './savedOrders.js';
import { amazonDescriptor, orderTip, splitRef, storedSplitSubjects, tipsDescriptor, tipSplitSubjects } from './tipSplit.js';
import { rootApproval, syntheticCards, syntheticRow, syntheticSubject } from './fixtures.testSupport.js';
import { SAVED_CLASSIC, SAVED_FRESH, syntheticSavedOrders } from './savedOrdersFixtures.testSupport.js';
import type { Binding, LedgerRow, MatchResult, MatchSubject, OrderObservation } from './types.js';

// Entirely synthetic: invented order IDs, card endings, descriptors and amounts.
const usd = (amountMinor: number) => ({ currency: 'USD', amountMinor });
const ORDER_ROW = 'AMAZON.COM*SYNTH FRESH', TIP_ROW = 'AMAZON TIPS*SYNTH';
/** A deferred tip part's result (Root 06:36Z): never a candidate, a contest or a link. */
const DEFERRED = ['held', 'deferred', 0, null];

describe('tip-split descriptor classes (Amazon: amzn, amazon or prime now; tips: Amazon and the word tip or tips)', () => {
  it.each([
    ['AMAZON TIPS*SYNTH0001', true, true],
    ['Amazon Tip', true, true],
    ['AMZN TIPS SYNTH', true, true],
    ['PRIME NOW TIPS', true, true],
    ['AMAZON.COM*SYNTH0001', true, false],
    ['AMZN Mktp US*SYNTH', true, false],
    ['AMAZON MKTPL*TIPSY SYNTH', true, false],
    ['SYNTHETIC DINER TIPS', false, false],
    ['', false, false],
  ])('%j: Amazon %s, tips %s', (description, amazon, tips) => {
    expect([amazonDescriptor(description), tipsDescriptor(description)]).toEqual([amazon, tips]);
  });
  it('reads a missing description as neither', () => {
    expect([amazonDescriptor(undefined), tipsDescriptor(null)]).toEqual([false, false]);
  });
});

describe('the split subjects (tipSplitSubjects, storedSplitSubjects)', () => {
  const order = (patch: Partial<OrderObservation> = {}, tip = 300): OrderObservation => ({
    orderId: '000-0000021-0000021', date: '2026-09-10', total: usd(2300), items: [],
    summary: [{ kind: 'items-subtotal', money: usd(2000) }, { kind: 'tip', money: usd(tip) },
      { kind: 'grand-total', money: usd(2300) }], ...patch });
  const total = (o: OrderObservation, patch: Partial<MatchSubject> = {}) => syntheticSubject({ ref: opaque('order-total', o.orderId),
    evidenceClass: 'unique-total-match', nativeOccurrenceId: null, provenance: 'order-total', date: o.date, money: o.total!,
    orderRefs: [opaque('order', o.orderId)], ...patch });
  it('splits a single-card-proven order with a positive tip into its order part (total minus tip) and its tip part', () => {
    const o = order(), t = total(o);
    expect(orderTip(o)).toBe(300);
    const [orderPart, tipPart] = tipSplitSubjects(o, t);
    const shared = { source: t.source, evidenceClass: 'unique-total-match', nativeOccurrenceId: null, provenance: 'order-total-split',
      status: 'completed', date: '2026-09-10', method: t.method, orderRefs: t.orderRefs, tenderProof: 'single-card-complete',
      allocations: [], allocationComplete: false, allocationHoldReason: 'item-identity-unproven' };
    expect(orderPart).toEqual({ ...shared, ref: splitRef(o.orderId, 'order'), money: usd(2000), split: { part: 'order', totalRef: t.ref } });
    expect(tipPart).toEqual({ ...shared, ref: splitRef(o.orderId, 'tip'), money: usd(300), split: { part: 'tip', totalRef: t.ref } });
    expect(new Set([t.ref, orderPart.ref, tipPart.ref]).size).toBe(3);
  });
  it.each([
    ['no tip row', () => order({ summary: [{ kind: 'grand-total', money: usd(2300) }] }), {}],
    ['a zero tip', () => order({}, 0), {}],
    ['a tip of the whole total', () => order({}, 2300), {}],
    ['a tip above the total', () => order({}, 2400), {}],
    ['no total', () => order({ total: null }), {}],
    ['a total not proven single-card', () => order(), { provenance: 'unproven' as const }],
    ['a mixed tender', () => order(), { tenderProof: 'mixed' as const }],
  ])('makes none for an order with %s', (_, make, patch) => {
    const o = make();
    expect(tipSplitSubjects(o, total(o.total ? o : order(), patch))).toEqual([]);
  });
  it('stores the current parts, rewrites a stored part the order no longer has as unproven, and stores none never stored', () => {
    const tipped = order(), t = total(tipped), current = tipSplitSubjects(tipped, t);
    expect(storedSplitSubjects(tipped, t, () => undefined)).toEqual(current);
    const stored = new Map(current.map(s => [s.ref, s]));
    const untipped = order({}, 0);
    expect(storedSplitSubjects(untipped, t, ref => stored.get(ref))).toEqual(current.map(s => ({ ...s, provenance: 'unproven' })));
    expect(storedSplitSubjects(untipped, t, () => undefined)).toEqual([]);
  });
});

describe('matchAmazon: a tipped order\'s order part links, its tip part is deferred (TIP_SPLIT_POLICY, Root 06:36Z)', () => {
  const bindings: Binding[] = syntheticCards.map(c => ({ network: 'visa', last4: c.last4!, cardAccountId: c.id }));
  /** A tipped order of 2300 with a 300 tip, dated 2026-09-10, on the synthetic Visa ending 9001: total, order part, tip part. */
  const tipped = (orderId = '000-0000021-0000021', amounts = { total: 2300, tip: 300 }, date = '2026-09-10') => {
    const order: OrderObservation = { orderId, date, total: usd(amounts.total), items: [],
      summary: [{ kind: 'items-subtotal', money: usd(amounts.total - amounts.tip) }, { kind: 'tip', money: usd(amounts.tip) },
        { kind: 'grand-total', money: usd(amounts.total) }] };
    const total = syntheticSubject({ ref: opaque('order-total', orderId), evidenceClass: 'unique-total-match', nativeOccurrenceId: null,
      provenance: 'order-total', date, money: usd(amounts.total), orderRefs: [opaque('order', orderId)] });
    return [total, ...tipSplitSubjects(order, total)];
  };
  let rowNumber = 0;
  const row = (amountMinor: number, description: string | undefined, patch: Partial<LedgerRow> = {}) =>
    syntheticRow({ id: `synthetic-row-${++rowNumber}`, amountMinor, description, transactionDate: '2026-09-11', ...patch });
  const match = (subjects: MatchSubject[], rows: LedgerRow[]) => {
    const { results } = matchAmazon(subjects, rows, bindings);
    return new Map(results.map(r => [r.subjectRef, r]));
  };
  const at = (results: Map<string, MatchResult>, subject: MatchSubject) => {
    const r = results.get(subject.ref)!;
    return [r.state, r.reason, r.candidateCount, r.cardTransactionId];
  };
  it('links the order part; the total stays held with no candidate; the tip part is deferred; split results carry the split digest', () => {
    const [total, orderPart, tipPart] = tipped();
    const charge = row(2000, ORDER_ROW), tip = row(300, TIP_ROW, { transactionDate: '2026-09-12' });
    const { results, candidates } = matchAmazon([total, orderPart, tipPart], [charge, tip], bindings);
    const byRef = new Map(results.map(r => [r.subjectRef, r]));
    expect(at(byRef, total)).toEqual(['held', 'no-candidate', 0, null]);
    expect(at(byRef, orderPart)).toEqual(['linked', 'unique', 1, charge.id]);
    expect(at(byRef, tipPart)).toEqual(DEFERRED);
    expect([orderPart, tipPart].map(s => byRef.get(s.ref)!.policyDigest)).toEqual([TIP_SPLIT_POLICY_DIGEST, TIP_SPLIT_POLICY_DIGEST]);
    expect(byRef.get(total.ref)!.policyDigest).toBeUndefined();
    // The tips row is no subject's candidate at all.
    expect(candidates).toEqual([{ subjectRef: orderPart.ref, cardTransactionId: charge.id, evidenceClass: 'unique-total-match' }]);
  });
  it.each([
    ['no tips row', () => [] as LedgerRow[]],
    ['one tips row', () => [row(300, TIP_ROW)]],
    ['two tips rows', () => [row(300, TIP_ROW), row(300, TIP_ROW, { transactionDate: '2026-09-13' })]],
    ['tips rows on every day of the window', () => ['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13']
      .map(transactionDate => row(300, TIP_ROW, { transactionDate }))],
  ])('links the order part and defers the tip part with %s, whatever the order of subjects and rows', (_, tips) => {
    const [total, orderPart, tipPart] = tipped();
    const charge = row(2000, ORDER_ROW), extra = tips();
    for (const [subjects, rows] of [[[total, orderPart, tipPart], [charge, ...extra]],
      [[tipPart, orderPart, total], [...extra].reverse().concat(charge)]] as Array<[MatchSubject[], LedgerRow[]]>) {
      const results = match(subjects, rows);
      expect([at(results, orderPart), at(results, tipPart)]).toEqual([['linked', 'unique', 1, charge.id], DEFERRED]);
    }
  });
  it('never binds the order part to a tips-class, non-Amazon or undescribed charge', () => {
    const [total, orderPart, tipPart] = tipped();
    const results = match([total, orderPart, tipPart], [row(2000, TIP_ROW), row(2000, 'SYNTHETIC GROCER'), row(2000, undefined)]);
    expect([at(results, orderPart), at(results, tipPart)]).toEqual([['held', 'no-candidate', 0, null], DEFERRED]);
  });
  it('matches the order part to the cent', () => {
    const [total, orderPart] = tipped();
    expect(at(match(tipped(), [row(1999, ORDER_ROW), row(2001, ORDER_ROW)]), orderPart)).toEqual(['held', 'no-candidate', 0, null]);
    expect(total.money.amountMinor - orderPart.money.amountMinor).toBe(300);
  });
  it.each([
    ['2026-09-09', false], ['2026-09-10', true], ['2026-09-17', true], ['2026-09-24', true], ['2026-09-25', false],
  ])('an order charge on %s is in the order part\'s window: %s', (transactionDate, inWindow) => {
    const [, orderPart] = tipped();
    expect(match(tipped(), [row(2000, ORDER_ROW, { transactionDate })]).get(orderPart.ref)!.state).toBe(inWindow ? 'linked' : 'held');
  });
  it('matches the order part only to posted purchases on the bound card', () => {
    const [, orderPart] = tipped();
    const results = match(tipped(), [row(2000, ORDER_ROW, { status: 'pending' }), row(2000, ORDER_ROW, { kind: 'refund' }),
      row(2000, ORDER_ROW, { cardAccountId: 'synthetic-marriott' }), row(2000, ORDER_ROW, { currency: 'CAD' })]);
    expect(at(results, orderPart)).toEqual(['held', 'no-candidate', 0, null]);
  });
  it('holds the order part on a card with no binding; the tip part stays deferred', () => {
    const subjects = tipped().map(s => ({ ...s, method: { kind: 'card' as const, network: 'visa' as const, last4: '9009' } }));
    const results = match(subjects, [row(2000, ORDER_ROW), row(300, TIP_ROW)]);
    expect(subjects.map(s => results.get(s.ref)!.reason)).toEqual(['binding-held', 'binding-held', 'deferred']);
  });
  it('uses the order part only where the total has no candidate: a full-total charge links the total', () => {
    const [total, orderPart, tipPart] = tipped();
    const full = row(2300, ORDER_ROW), charge = row(2000, ORDER_ROW), tip = row(300, TIP_ROW);
    const { results, candidates } = matchAmazon([total, orderPart, tipPart], [full, charge, tip], bindings);
    const byRef = new Map(results.map(r => [r.subjectRef, r]));
    expect([at(byRef, total), at(byRef, orderPart), at(byRef, tipPart)]).toEqual([['linked', 'unique', 1, full.id],
      ['held', 'superseded', 0, null], DEFERRED]);
    expect(candidates.map(c => c.cardTransactionId)).toEqual([full.id]);
    // An ambiguous total (two full-total charges) still has candidates: the split stays out of it.
    const twice = matchAmazon([total, orderPart, tipPart], [full, row(2300, ORDER_ROW), charge, tip], bindings).results;
    expect(twice.map(r => r.reason)).toEqual(['ambiguous', 'superseded', 'deferred']);
  });
  it('stands the order part down where another subject of the order has a candidate, or a payments-ledger subject names it', () => {
    const [total, orderPart, tipPart] = tipped();
    const charge = row(2000, ORDER_ROW), tip = row(300, TIP_ROW);
    // The order's own native payment event for the same charge links it, exactly as without the split.
    const event = syntheticSubject({ ref: opaque('subject', 'synthetic-event'), date: '2026-09-10', money: usd(2000),
      orderRefs: total.orderRefs });
    const withEvent = match([total, orderPart, tipPart, event], [charge, tip]);
    expect(at(withEvent, event)).toEqual(at(match([total, event], [charge, tip]), event));
    expect(at(withEvent, event)).toEqual(['linked', 'unique', 1, charge.id]);
    expect([withEvent.get(orderPart.ref)!.reason, withEvent.get(tipPart.ref)!.reason]).toEqual(['superseded', 'deferred']);
    // A payments-ledger row naming the order, even one with no candidate.
    const ledger = syntheticSubject({ ref: opaque('subject', 'synthetic-ledger'), evidenceClass: 'payment-ledger-complete',
      nativeOccurrenceId: null, date: '2026-09-10', money: usd(777), orderRefs: total.orderRefs, tenderProof: 'unknown',
      ledgerObservation: { captureDigest: 'c'.repeat(64), runId: 'synthetic-run', page: 0, ordinal: 0 } });
    const withLedger = match([total, orderPart, tipPart, ledger], [charge, tip]);
    expect(at(withLedger, ledger)).toEqual(['held', 'no-candidate', 0, null]);
    expect([withLedger.get(orderPart.ref)!.reason, withLedger.get(tipPart.ref)!.reason]).toEqual(['superseded', 'deferred']);
  });
  describe('the tip\'s own ledger charge never stands the order part down (TIP_SPLIT_POLICY amendment, Root 2026-11-23)', () => {
    let read = 0;
    /** A payments-ledger read naming the tipped order, each in its own run: by default the tip's own completed Charged row. */
    const ledgerRow = (patch: Partial<MatchSubject> = {}) => syntheticSubject({ ref: opaque('subject', `synthetic-ledger-read-${++read}`),
      evidenceClass: 'payment-ledger-complete', nativeOccurrenceId: null, provenance: 'ledger-Charged', status: 'completed',
      date: '2026-09-10', money: usd(300), orderRefs: [opaque('order', '000-0000021-0000021')], tenderProof: 'unknown',
      ledgerObservation: { captureDigest: 'e'.repeat(64), runId: `synthetic-run-${read}`, page: 0, ordinal: 0 }, ...patch });
    it('links the order part where the only ledger rows naming the order are its tip\'s charge, read in seven runs (#9\'s shape)', () => {
      const [total, orderPart, tipPart] = tipped();
      const charge = row(2000, ORDER_ROW), tip = row(300, TIP_ROW, { transactionDate: '2026-09-12' });
      const reads = Array.from({ length: 7 }, () => ledgerRow());
      for (const subjects of [[total, orderPart, tipPart, ...reads], [...reads].reverse().concat(tipPart, orderPart, total)]) {
        const { results, candidates } = matchAmazon(subjects, [charge, tip], bindings);
        const byRef = new Map(results.map(r => [r.subjectRef, r]));
        expect([at(byRef, total), at(byRef, orderPart), at(byRef, tipPart)]).toEqual([['held', 'no-candidate', 0, null],
          ['linked', 'unique', 1, charge.id], DEFERRED]);
        // Every read would have had only the tips row: the class rule narrowed it away, so it takes nothing.
        for (const r of reads) {
          expect(at(byRef, r)).toEqual(['held', 'no-candidate', 0, null]);
          expect(byRef.get(r.ref)!.tipRowsExcludedBy).toBe(TIP_SPLIT_POLICY_DIGEST);
        }
        expect(candidates).toEqual([{ subjectRef: orderPart.ref, cardTransactionId: charge.id, evidenceClass: 'unique-total-match' }]);
      }
    });
    it.each([
      ['a Charged row a cent above the tip', () => ledgerRow({ money: usd(301) })],
      ['a Charged row a cent below the tip', () => ledgerRow({ money: usd(299) })],
      ['a Charged row of the order part\'s amount', () => ledgerRow({ money: usd(2000), date: '2026-09-30' })],
      ['a Charged row of the tip\'s amount in another currency', () => ledgerRow({ money: { currency: 'CAD', amountMinor: 300 } })],
      ['a Charged row of the tip\'s amount naming two orders', () => ledgerRow({ evidenceHoldReason: 'multiple-orders',
        orderRefs: [opaque('order', '000-0000021-0000021'), opaque('order', '000-0000029-0000029')] })],
      ['a Refunded row of the tip\'s amount', () => ledgerRow({ provenance: 'ledger-Refunded', money: usd(-300) })],
      ['a pending row of the tip\'s amount', () => ledgerRow({ provenance: 'unproven', status: 'pending' })],
      ['a Charged row of the tip\'s amount not completed', () => ledgerRow({ status: 'pending' })],
      ['a completed row of the tip\'s amount not read as Charged', () => ledgerRow({ provenance: 'unproven' })],
    ])('still stands it down for %s, alone or next to the tip\'s own charge', (_, other) => {
      const [total, orderPart, tipPart] = tipped();
      const rows = [row(2000, ORDER_ROW), row(300, TIP_ROW)];
      for (const ledger of [[other()], [ledgerRow(), other()], [other(), ledgerRow(), ledgerRow()]]) {
        const results = match([total, orderPart, tipPart, ...ledger], rows);
        expect([at(results, orderPart), at(results, tipPart)]).toEqual([['held', 'superseded', 0, null], DEFERRED]);
      }
    });
    it('still stands it down where the tip\'s charge found a candidate of its own: another subject of the order has one', () => {
      const [total, orderPart, tipPart] = tipped();
      const own = ledgerRow(), other = row(300, 'AMAZON.COM*SYNTH DIGITAL', { transactionDate: '2026-09-10' });
      const results = match([total, orderPart, tipPart, own], [row(2000, ORDER_ROW), row(300, TIP_ROW), other]);
      expect([at(results, own), at(results, orderPart), at(results, tipPart)]).toEqual([['linked', 'unique', 1, other.id],
        ['held', 'superseded', 0, null], DEFERRED]);
    });
    it.each([
      ['its tender is not proven single-card', (order: OrderObservation, total: MatchSubject): [OrderObservation, MatchSubject] =>
        [order, { ...total, tenderProof: 'mixed' }]],
      ['its summary states no tip', (order: OrderObservation, total: MatchSubject): [OrderObservation, MatchSubject] =>
        [{ ...order, summary: order.summary!.filter(s => s.kind !== 'tip') }, total]],
    ])('leaves an order as before where %s: no split subjects, so the tip\'s amount on the ledger changes nothing', (_, unproven) => {
      const orderId = '000-0000021-0000021', date = '2026-09-10';
      const [order, total] = unproven({ orderId, date, total: usd(2300), items: [], summary: [
        { kind: 'items-subtotal', money: usd(2000) }, { kind: 'tip', money: usd(300) }, { kind: 'grand-total', money: usd(2300) }] },
      syntheticSubject({ ref: opaque('order-total', orderId), evidenceClass: 'unique-total-match', nativeOccurrenceId: null,
        provenance: 'order-total', date, money: usd(2300), orderRefs: [opaque('order', orderId)] }));
      expect(tipSplitSubjects(order, total)).toEqual([]);
      const rows = [row(2000, ORDER_ROW), row(300, TIP_ROW)], own = ledgerRow();
      const results = match([total, own], rows);
      expect(results.get(total.ref)).toEqual(match([total], rows).get(total.ref));
      expect(at(results, total)[0]).toBe('held');
      expect(at(results, own)).toEqual(['held', 'no-candidate', 0, null]);
    });
    it('holds a stored order part rewritten unproven (its order no longer a proven tipped order), the tip\'s charge or not', () => {
      const [total, orderPart, tipPart] = tipped();
      const stale = [{ ...orderPart, provenance: 'unproven' as const }, { ...tipPart, provenance: 'unproven' as const }];
      const results = match([total, ...stale, ledgerRow()], [row(2000, ORDER_ROW), row(300, TIP_ROW)]);
      expect(at(results, stale[0])).toEqual(['held', 'evidence-held', 0, null]);
    });
  });
  it('never claims a row twice: two orders\' parts, or a part and another order\'s total, on one row are all held', () => {
    const a = tipped('000-0000021-0000021'), b = tipped('000-0000022-0000022');
    const charge = row(2000, ORDER_ROW);
    let results = match([...a, ...b], [charge]);
    expect([at(results, a[1]), at(results, b[1])]).toEqual([['held', 'ambiguous', 1, null], ['held', 'ambiguous', 1, null]]);
    const other = syntheticSubject({ ref: opaque('order-total', '000-0000023-0000023'), evidenceClass: 'unique-total-match',
      nativeOccurrenceId: null, provenance: 'order-total', date: '2026-09-10', money: usd(2000),
      orderRefs: [opaque('order', '000-0000023-0000023')] });
    results = match([...a, other], [charge]);
    expect([at(results, a[1]), at(results, other)]).toEqual([['held', 'ambiguous', 1, null], ['held', 'ambiguous', 1, null]]);
    // Two orders' tips that would fit one tips row: both deferred; each order part links its own row.
    const own = row(2000, ORDER_ROW), second = row(1800, ORDER_ROW), tip = row(300, TIP_ROW);
    const c = tipped('000-0000024-0000024', { total: 2100, tip: 300 });
    results = match([...a, ...c], [own, second, tip]);
    expect([at(results, a[1]), at(results, c[1]), at(results, a[2]), at(results, c[2])]).toEqual([
      ['linked', 'unique', 1, own.id], ['linked', 'unique', 1, second.id], DEFERRED, DEFERRED]);
  });
  it.each([
    ['parts that do not add up to the total', (s: MatchSubject[]) => [s[0], { ...s[1], money: usd(1999) }, s[2]]],
    ['a missing tip part', (s: MatchSubject[]) => [s[0], s[1]]],
    ['a repeated part', (s: MatchSubject[]) => [s[0], s[1], s[2], { ...s[2], ref: opaque('subject', 'synthetic-repeat') }]],
    ['a part on another date', (s: MatchSubject[]) => [s[0], { ...s[1], date: '2026-09-11' }, s[2]]],
    ['a part on another card', (s: MatchSubject[]) => [s[0], s[1], { ...s[2], method: { ...s[2].method, last4: '9002' } }]],
    ['a part naming another order', (s: MatchSubject[]) => [s[0], { ...s[1], orderRefs: [opaque('order', 'other')] }, s[2]]],
    ['a part naming no total', (s: MatchSubject[]) => [{ ...s[0], ref: opaque('order-total', 'other') }, s[1], s[2]]],
    ['a part rewritten unproven', (s: MatchSubject[]) => [s[0], { ...s[1], provenance: 'unproven' as const }, s[2]]],
  ])('holds the order part as evidence-held with %s', (_, tamper) => {
    const subjects = tamper(tipped()) as MatchSubject[];
    const results = match(subjects, [row(2000, ORDER_ROW), row(300, TIP_ROW)]);
    const orderPart = subjects.find(s => s.split?.part === 'order')!;
    expect(at(results, orderPart)).toEqual(['held', 'evidence-held', 0, null]);
    for (const tip of subjects.filter(s => s.split?.part === 'tip')) expect(at(results, tip)).toEqual(DEFERRED);
  });
  it('holds the order part as its total is held where the total is not evidenced', () => {
    const [total, orderPart, tipPart] = tipped();
    const results = match([{ ...total, status: 'pending' }, orderPart, tipPart], [row(2000, ORDER_ROW), row(300, TIP_ROW)]);
    expect([results.get(orderPart.ref)!.reason, results.get(tipPart.ref)!.reason]).toEqual(['evidence-held', 'deferred']);
  });
  it('leaves an untipped order exactly as before: its total alone, linked on its full total', () => {
    const [total] = tipped();
    const full = row(2300, ORDER_ROW);
    expect(matchAmazon([total], [full, row(2000, ORDER_ROW), row(300, TIP_ROW)], bindings)).toEqual({
      candidates: [{ subjectRef: total.ref, cardTransactionId: full.id, evidenceClass: 'unique-total-match' }],
      results: [{ subjectRef: total.ref, state: 'linked', reason: 'unique', candidateCount: 1, cardTransactionId: full.id,
        evidenceClass: 'unique-total-match' }],
    });
  });
  describe('the class rule (Root 05:52/05:55Z): a tips-class row is never a candidate of any non-tip subject', () => {
    /** Another order's subject of the tip's amount, dated with the tipped order: a non-tip subject a tips row would fit. */
    const other = (patch: Partial<MatchSubject> = {}) => syntheticSubject({ ref: opaque('order-total', '000-0000031-0000031'),
      evidenceClass: 'unique-total-match', nativeOccurrenceId: null, provenance: 'order-total', date: '2026-09-10',
      money: usd(300), orderRefs: [opaque('order', '000-0000031-0000031')], ...patch });
    it.each([
      ['an order total', () => other()],
      ['a native payment event', () => other({ ref: opaque('subject', 'synthetic-event'), evidenceClass: 'payment-event',
        nativeOccurrenceId: 'synthetic-occurrence-two', provenance: 'ledger-Charged' })],
      ['a payments-ledger row', () => other({ ref: opaque('subject', 'synthetic-ledger-row'), evidenceClass: 'payment-ledger-complete',
        provenance: 'ledger-Charged', tenderProof: 'unknown',
        ledgerObservation: { captureDigest: 'd'.repeat(64), runId: 'synthetic-run-two', page: 0, ordinal: 0 } })],
    ])('never gives %s of the tip\'s amount a tips-class row, and records the class rule on its result', (_, make) => {
      const [total, orderPart, tipPart] = tipped(), subject = make();
      const tip = row(300, TIP_ROW), own = row(300, ORDER_ROW);
      // With only the tips row it has no candidate, and the tips row is no subject's candidate at all.
      let { results, candidates } = matchAmazon([total, orderPart, tipPart, subject], [row(2000, ORDER_ROW), tip], bindings);
      let byRef = new Map(results.map(r => [r.subjectRef, r]));
      expect([at(byRef, subject), at(byRef, tipPart)]).toEqual([['held', 'no-candidate', 0, null], DEFERRED]);
      expect(byRef.get(subject.ref)!.tipRowsExcludedBy).toBe(TIP_SPLIT_POLICY_DIGEST);
      expect(candidates.filter(c => c.cardTransactionId === tip.id)).toEqual([]);
      // With its own non-tip charge too, it links that one.
      ({ results, candidates } = matchAmazon([total, orderPart, tipPart, subject], [row(2000, ORDER_ROW), tip, own], bindings));
      byRef = new Map(results.map(r => [r.subjectRef, r]));
      expect(at(byRef, subject)).toEqual(['linked', 'unique', 1, own.id]);
      // A subject no tips row fits is not marked: its result is exactly as before.
      expect(match([subject], [own]).get(subject.ref)!.tipRowsExcludedBy).toBeUndefined();
    });
    it('gives an untipped ordinary order no tips row, whatever its date in the window', () => {
      const ordinary = other();
      for (const transactionDate of ['2026-09-10', '2026-09-17', '2026-09-24']) {
        expect(at(match([ordinary], [row(300, TIP_ROW, { transactionDate })]), ordinary)).toEqual(['held', 'no-candidate', 0, null]);
      }
      expect(at(match([ordinary], [row(300, TIP_ROW), row(300, 'AMAZON MKTPL*SYNTH')]), ordinary)[0]).toBe('linked');
    });
  });
});

describe('the saved-pages import of a tipped Fresh order (TIP_SPLIT_POLICY gate, order parts only)', () => {
  // The synthetic saved Fresh order: 2369 in all with a 300 tip (order part 2069), dated 2026-09-10; its classic sibling:
  // 1100, dated 2026-09-01, untipped. Both on the synthetic Visa ending 9001.
  const TODAY = '2026-10-24';
  let dir: string, repo: SqliteStateRepo, backups = 0, cardId: string;
  const db = () => repo.internalGetDb();
  const backup = () => path.join(dir, `backup-${++backups}.db`);
  const rows = (entries: Array<[number, string, string?]>) => repo.importCardTransactions({ cardAccountId: cardId, source: 'synthetic',
    parserVersion: 'synthetic@1', rows: entries.map(([amountMinor, description, transactionDate]) => ({
      transactionDate: transactionDate ?? '2026-09-11', status: 'posted', kind: 'purchase', currency: 'USD', amountMinor, description,
      issuerCategory: 'Shopping' })) });
  const rowId = (amountMinor: number) => db().prepare('SELECT id FROM card_transactions WHERE amount_minor=? ORDER BY id')
    .pluck().get(amountMinor) as string;
  const rowBy = (description: string) => db().prepare('SELECT id FROM card_transactions WHERE description=?')
    .pluck().get(description) as string;
  const importSaved = async (file: SavedOrdersFile) => {
    const parsed = await parseSavedOrders(file, TODAY);
    return db().transaction(() => {
      ensureAmazonSchema(db());
      return importSavedOrders(db(), parsed, digest(file), '2026-10-24T05:00:00.000Z');
    }).immediate();
  };
  const freshOnly = () => { const file = syntheticSavedOrders(); file.orders = [file.orders[1]]; return file; };
  /** Everything a held order's import may never change: its display, history, subjects and matches. */
  const orderState = (orderId: string) => {
    const refs = [opaque('order-total', orderId), splitRef(orderId, 'order'), splitRef(orderId, 'tip')];
    return {
      order: db().prepare('SELECT latest_digest,data_json FROM amazon_orders WHERE ref=?').get(opaque('order', orderId)),
      history: db().prepare('SELECT ref FROM amazon_observations WHERE order_ref=? ORDER BY ref').pluck().all(opaque('order', orderId)),
      subjects: refs.map(ref => db().prepare('SELECT data_json FROM amazon_subjects WHERE ref=?').pluck().get(ref)),
      matches: refs.map(ref => db().prepare('SELECT data_json FROM amazon_matches WHERE subject_ref=?').pluck().get(ref)),
    };
  };
  const gateOf = (outcome: Awaited<ReturnType<typeof importSaved>>, index: number) =>
    [...outcome.trial.orders, ...(outcome.written?.gate.orders ?? [])].filter(o => o.index === index).at(-1)!;
  const linkedRow = (subjectRef: string) => db().prepare("SELECT card_transaction_id FROM amazon_matches WHERE subject_ref=? AND state='linked'")
    .pluck().get(subjectRef) as string | undefined;
  /** Every stored match as subject, state and its card row: comparable across databases. */
  const matchState = () => db().prepare(`SELECT m.subject_ref AS ref,m.state,c.amount_minor AS amount,c.description AS row
    FROM amazon_matches m LEFT JOIN card_transactions c ON c.id=m.card_transaction_id ORDER BY m.subject_ref`).all();
  /** No tip part is ever linked, and every stored tip result is the deferred one. */
  const tipsDeferred = () => {
    expect(db().prepare(`SELECT count(*) FROM amazon_matches WHERE state='linked' AND subject_ref IN
      (SELECT ref FROM amazon_subjects WHERE json_extract(data_json,'$.split.part')='tip')`).pluck().get()).toBe(0);
    const reasons = db().prepare(`SELECT DISTINCT json_extract(data_json,'$.reason') FROM amazon_matches WHERE subject_ref IN
      (SELECT ref FROM amazon_subjects WHERE json_extract(data_json,'$.split.part')='tip')`).pluck().all();
    expect(reasons.every(reason => reason === 'deferred')).toBe(true);
    expect(db().prepare(`SELECT count(*) FROM amazon_candidates WHERE subject_ref IN
      (SELECT ref FROM amazon_subjects WHERE json_extract(data_json,'$.split.part')='tip')`).pluck().get()).toBe(0);
  };
  const DEFERRED_PART = { state: 'held', reason: 'deferred', candidateCount: 0 };
  const ORDINARY_ROW = 'AMAZON MKTPL*SYNTH ORDINARY';
  const SECOND_FRESH = '000-0000013-0000013';
  /** 5b01e72f's second tipped order: the Fresh order with 100 more delivery (2469 in all), the same 300 tip and date. */
  const secondFresh = () => {
    const file = freshOnly(), order = file.orders[0];
    order.orderId = SECOND_FRESH;
    order.total = usd(2469);
    order.summary = order.summary.map(s => s.kind === 'shipping' ? { ...s, money: usd(1095) }
      : s.kind === 'grand-total' ? { ...s, money: usd(2469) } : s);
    return file;
  };
  /** An ordinary order of 300, dated with the Fresh order: its total would fit the 300 tips row (a total has no descriptor rule). */
  const ordinary300 = () => {
    const file = syntheticSavedOrders(), order = file.orders[0];
    file.orders = [order];
    order.date = '2026-09-10';
    order.items = [{ ...order.items![0], quantity: 1, unitPrice: usd(300) }];
    order.total = usd(300);
    order.summary = [{ kind: 'items-subtotal', money: usd(300) }, { kind: 'shipping', money: usd(0) },
      { kind: 'tax', money: usd(0) }, { kind: 'grand-total', money: usd(300) }];
    return file;
  };
  const REPRO_ROWS: Array<[number, string, string?]> = [[2069, 'AMAZON.COM*SYNTH ORDER A'], [2169, 'AMAZON.COM*SYNTH ORDER B'],
    [300, TIP_ROW]];
  const setup = async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-tip-split-synthetic-'));
    backups = 0;
    repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
    cardId = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9001', currency: 'USD' }).id;
    const proposal = proposeBindings([{ network: 'visa', last4: '9001', cardAccountId: cardId }], readCardInventory(db()));
    await recordBindingProposal(db(), proposal, backup());
    await recordRootApproval(db(), proposal, rootApproval(proposal), backup());
  };
  const teardown = () => { repo.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  beforeEach(setup);
  afterEach(teardown);

  it('passes a tipped order on its order part, its tip deferred, and leaves its untipped sibling on its total', async () => {
    rows([[1100, 'AMAZON SYNTHETIC', '2026-09-02'], [2069, ORDER_ROW], [300, TIP_ROW, '2026-09-12']]);
    const outcome = await importSaved(syntheticSavedOrders());
    expect(outcome.trial).toMatchObject({ passed: 2, failed: 0, linkedRowsLost: 0, linkedRowsMoved: 0 });
    const gate = outcome.written!.gate;
    expect(gatePassed(gate)).toBe(true);
    expect(gate.orders.map(o => [o.index, o.state, o.reason, o.charge, o.orderPart, o.tipPart, o.passed])).toEqual([
      [0, 'linked', 'unique', 'total', null, null, true],
      [1, 'held', 'no-candidate', 'order-part', { state: 'linked', reason: 'unique', candidateCount: 1 }, DEFERRED_PART, true]]);
    expect(outcome.written!.receipt).toMatchObject({ newMatches: 2, invalidated: 0 });
    tipsDeferred();
    // The classic order has no split subject; the Fresh order's order part links its row, under the split digest.
    expect(db().prepare('SELECT count(*) FROM amazon_subjects WHERE ref IN (?,?)').pluck()
      .get(splitRef(SAVED_CLASSIC, 'order'), splitRef(SAVED_CLASSIC, 'tip'))).toBe(0);
    const stored = (ref: string) => JSON.parse(db().prepare('SELECT data_json FROM amazon_matches WHERE subject_ref=?').pluck().get(ref) as string);
    expect(stored(splitRef(SAVED_FRESH, 'order'))).toMatchObject({ state: 'linked', cardTransactionId: rowId(2069),
      policyDigest: TIP_SPLIT_POLICY_DIGEST });
    expect(stored(splitRef(SAVED_FRESH, 'tip'))).toEqual({ subjectRef: splitRef(SAVED_FRESH, 'tip'), state: 'held', reason: 'deferred',
      candidateCount: 0, cardTransactionId: null, evidenceClass: 'unique-total-match', policyDigest: TIP_SPLIT_POLICY_DIGEST });
    // The tip part is stored with its amount, date and card, kept for a later policy.
    expect(JSON.parse(db().prepare('SELECT data_json FROM amazon_subjects WHERE ref=?').pluck().get(splitRef(SAVED_FRESH, 'tip')) as string))
      .toMatchObject({ money: usd(300), date: '2026-09-10', method: { kind: 'card', network: 'visa', last4: '9001' },
        split: { part: 'tip', totalRef: opaque('order-total', SAVED_FRESH) } });
    const digests = (action: string, ref: string) => db().prepare(
      'SELECT DISTINCT policy_digest FROM amazon_audit WHERE action=? AND subject_ref=?').pluck().all(action, ref);
    for (const part of ['order', 'tip'] as const) {
      expect(digests('subject-observation', splitRef(SAVED_FRESH, part))).toEqual([TIP_SPLIT_POLICY_DIGEST]);
      expect(digests('reconcile', splitRef(SAVED_FRESH, part))).toEqual([TIP_SPLIT_POLICY_DIGEST]);
    }
    expect(digests('subject-observation', opaque('order-total', SAVED_FRESH))).toEqual([POLICY_DIGEST]);
    // The resolver shows the order charge linked (filed whole) and the tips row not linked to anything.
    const snapshot = createAmazonCategoryResolver(db()).snapshot();
    expect(snapshot.getCardDetail(rowId(2069))).toMatchObject({ match: 'linked', evidenceClass: 'unique-total-match',
      orderRefs: [opaque('order', SAVED_FRESH)] });
    expect(snapshot.linkedChargeItemization(rowId(2069))).toBe('whole');
    expect(snapshot.getCardDetail(rowId(300))).toMatchObject({ match: 'none' });
    expect(snapshot.getOrderMatches(opaque('order', SAVED_FRESH))).toEqual(expect.arrayContaining([
      { state: 'held', evidenceClass: 'unique-total-match', reason: 'no-candidate', candidateCount: 0 },
      { state: 'linked', evidenceClass: 'unique-total-match', cardTransactionId: rowId(2069), cardAccountId: cardId }]));
    expect(snapshot.getOrderMatches(opaque('order', SAVED_FRESH))).toHaveLength(2);
    // The same file again imports nothing new and moves no link.
    const before = orderState(SAVED_FRESH);
    const again = await importSaved(syntheticSavedOrders());
    expect(again.written!.receipt).toMatchObject({ newCaptures: 0, newOrders: 0, newObservations: 0, newMatches: 0, invalidated: 0 });
    expect(gatePassed(again.written!.gate)).toBe(true);
    expect(orderState(SAVED_FRESH)).toEqual(before);
  });
  it.each([
    ['its only total-minus-tip charge is a tips-class one', [[2069, TIP_ROW], [300, TIP_ROW]] as Array<[number, string, string?]>,
      { state: 'held', reason: 'no-candidate', candidateCount: 0 }],
    ['two total-minus-tip charges', [[2069, ORDER_ROW], [2069, ORDER_ROW, '2026-09-12']] as Array<[number, string, string?]>,
      { state: 'held', reason: 'ambiguous', candidateCount: 2 }],
    ['charges a cent off', [[2068, ORDER_ROW], [2070, ORDER_ROW]] as Array<[number, string, string?]>,
      { state: 'held', reason: 'no-candidate', candidateCount: 0 }],
  ])('holds the order, changing nothing, where %s', async (_, entries, orderPart) => {
    rows(entries);
    const before = orderState(SAVED_FRESH);
    const outcome = await importSaved(freshOnly());
    expect(outcome.held.map(o => [o.index, o.charge, o.orderPart, o.tipPart, o.passed])).toEqual([[0, 'none', orderPart, DEFERRED_PART, false]]);
    expect(outcome.written).toBeNull();
    expect(orderState(SAVED_FRESH)).toEqual(before);
    expect(db().prepare('SELECT count(*) FROM amazon_subjects').pluck().get()).toBe(0);
  });
  it('holds an order part that would take a card row already linked to another order, and leaves that link alone', async () => {
    // The classic order is imported first and links the 1100 row; a tipped order whose order part is also 1100 then
    // contends for it (1400 in all: 1022 + 26 delivery + 52 tax + 300 tip, dated 2026-09-01).
    rows([[1100, 'AMAZON SYNTHETIC', '2026-09-02']]);
    const classic = syntheticSavedOrders();
    classic.orders = [classic.orders[0]];
    expect(gatePassed((await importSaved(classic)).written!.gate)).toBe(true);
    const kept = orderState(SAVED_CLASSIC);
    const file = freshOnly(), fresh = file.orders[0];
    fresh.date = '2026-09-01';
    fresh.total = usd(1400);
    fresh.summary = fresh.summary.map(s => s.kind === 'shipping' ? { ...s, money: usd(26) }
      : s.kind === 'grand-total' ? { ...s, money: usd(1400) } : s);
    const outcome = await importSaved(file);
    expect(outcome.trial.linkedRowsLost).toBe(1);
    expect(outcome.held.map(o => [o.charge, o.orderPart])).toEqual([['none', { state: 'held', reason: 'ambiguous', candidateCount: 1 }]]);
    expect(outcome.written).toBeNull();
    expect(orderState(SAVED_CLASSIC)).toEqual(kept);
    expect(orderState(SAVED_FRESH)).toEqual({ order: undefined, history: [], subjects: [undefined, undefined, undefined],
      matches: [undefined, undefined, undefined] });
  });
  it('links the total where a full-total charge exists, its order part superseded and its tip deferred, claiming no other row', async () => {
    rows([[2369, ORDER_ROW], [2069, ORDER_ROW], [300, TIP_ROW]]);
    const outcome = await importSaved(freshOnly());
    expect(gateOf(outcome, 0)).toMatchObject({ state: 'linked', reason: 'unique', charge: 'total',
      orderPart: { state: 'held', reason: 'superseded', candidateCount: 0 }, tipPart: DEFERRED_PART, passed: true });
    expect(db().prepare('SELECT card_transaction_id FROM amazon_candidates').pluck().all()).toEqual([rowId(2369)]);
    // Superseded and deferred parts say nothing of the order's charge: its view shows its one link, and nothing held.
    const snapshot = createAmazonCategoryResolver(db()).snapshot();
    expect(snapshot.getOrderMatches(opaque('order', SAVED_FRESH))).toEqual([
      { state: 'linked', evidenceClass: 'unique-total-match', cardTransactionId: rowId(2369), cardAccountId: cardId }]);
    expect(snapshot.matchCounts.held).toBe(0);
  });
  describe('a deferred tip never links and never affects another link or the gate (Root 06:36Z)', () => {
    it('never links a tip, under any file order, a held sibling, or a later settle and unrelated import', async () => {
      // Two tipped orders whose tips would fit one tips row, and a held sibling (no order charge) of the second's amounts.
      rows(REPRO_ROWS);
      expect(gatePassed((await importSaved(freshOnly())).written!.gate)).toBe(true);
      const second = await importSaved(secondFresh());
      expect(second.written!.gate).toMatchObject({ passed: 1, failed: 0, linkedRowsLost: 0, linkedRowsMoved: 0 });
      expect(second.written!.gate.orders[0]).toMatchObject({ charge: 'order-part', tipPart: DEFERRED_PART });
      tipsDeferred();
      // A held sibling in the same input: the passing order still imports on its order part, its tip deferred.
      const held = secondFresh(), sibling = held.orders[0];
      sibling.orderId = '000-0000015-0000015';
      sibling.total = usd(2569);
      sibling.summary = sibling.summary.map(s => s.kind === 'shipping' ? { ...s, money: usd(1195) }
        : s.kind === 'grand-total' ? { ...s, money: usd(2569) } : s);
      const both = freshOnly();
      both.orders.push(sibling);
      const outcome = await importSaved(both);
      expect(outcome.held.map(o => [o.index, o.charge])).toEqual([[1, 'none']]);
      expect(outcome.written!.gate).toMatchObject({ passed: 1, failed: 0, linkedRowsLost: 0, linkedRowsMoved: 0 });
      // A later settle and an unrelated import link no tip either.
      db().transaction(() => settleAmazon(db(), '2026-10-24T05:10:00.000Z'))();
      rows([[1100, 'AMAZON SYNTHETIC CLASSIC', '2026-09-02']]);
      const classic = syntheticSavedOrders();
      classic.orders = [classic.orders[0]];
      expect(gatePassed((await importSaved(classic)).written!.gate)).toBe(true);
      tipsDeferred();
      expect([linkedRow(splitRef(SAVED_FRESH, 'order')), linkedRow(splitRef(SECOND_FRESH, 'order'))])
        .toEqual([rowBy('AMAZON.COM*SYNTH ORDER A'), rowBy('AMAZON.COM*SYNTH ORDER B')]);
      expect(linkedRow(splitRef(SAVED_FRESH, 'tip'))).toBeUndefined();
    });
    it('never lets an ordinary total of a tip\'s amount take the tips row: held with only that row, linked to its own charge', async () => {
      // The Fresh order first, then an ordinary order of the tip's amount: the class rule keeps the tips row from it.
      rows(REPRO_ROWS);
      expect(gatePassed((await importSaved(freshOnly())).written!.gate)).toBe(true);
      let outcome = await importSaved(ordinary300());
      expect(outcome.trial).toMatchObject({ passed: 0, failed: 1, linkedRowsLost: 0, linkedRowsMoved: 0 });
      expect(outcome.held.map(o => [o.state, o.reason, o.candidateCount])).toEqual([['held', 'no-candidate', 0]]);
      expect(outcome.written).toBeNull();
      rows([[300, ORDINARY_ROW]]);
      outcome = await importSaved(ordinary300());
      expect(outcome.written!.gate).toMatchObject({ passed: 1, failed: 0, linkedRowsLost: 0, linkedRowsMoved: 0 });
      expect(gatePassed(outcome.written!.gate)).toBe(true);
      expect(linkedRow(opaque('order-total', SAVED_CLASSIC))).toBe(rowBy(ORDINARY_ROW));
      tipsDeferred();
      // Its result records the class rule that kept the tips row from it, as does its reconcile audit.
      const result = JSON.parse(db().prepare('SELECT data_json FROM amazon_matches WHERE subject_ref=?').pluck()
        .get(opaque('order-total', SAVED_CLASSIC)) as string) as MatchResult;
      expect(result.tipRowsExcludedBy).toBe(TIP_SPLIT_POLICY_DIGEST);
      expect(db().prepare(`SELECT policy_digest FROM amazon_audit WHERE action='reconcile' AND subject_ref=?
        ORDER BY sequence DESC LIMIT 1`).pluck().get(opaque('order-total', SAVED_CLASSIC))).toBe(TIP_SPLIT_POLICY_DIGEST);
    });
    it('ends the same orders identically together, one after the other, or in reversed file order', async () => {
      /** A fresh database with every repro row and the ordinary order's own charge, the files imported in turn. */
      const run = async (imports: SavedOrdersFile[][]) => {
        teardown(); await setup();
        rows([...REPRO_ROWS, [300, ORDINARY_ROW]]);
        const accepted: string[] = [];
        for (const files of imports) {
          const file = files[0];
          file.orders = files.flatMap(f => f.orders);
          const outcome = await importSaved(file);
          expect(outcome.written!.gate).toMatchObject({ failed: 0, linkedRowsLost: 0, linkedRowsMoved: 0 });
          accepted.push(...outcome.written!.file.orders.map(o => o.orderId));
        }
        tipsDeferred();
        return { accepted: accepted.sort(), matches: matchState() };
      };
      const tipped = await run([[freshOnly()], [secondFresh()]]);
      expect(await run([[freshOnly(), secondFresh()]])).toEqual(tipped);
      expect(await run([[secondFresh(), freshOnly()]])).toEqual(tipped);
      expect(tipped.accepted).toEqual([SAVED_FRESH, SECOND_FRESH].sort());
      const withOrdinary = await run([[ordinary300()], [freshOnly()]]);
      expect(await run([[freshOnly()], [ordinary300()]])).toEqual(withOrdinary);
      expect(await run([[ordinary300(), freshOnly()]])).toEqual(withOrdinary);
      expect(withOrdinary.matches).toContainEqual({ ref: opaque('order-total', SAVED_CLASSIC), state: 'linked', amount: 300, row: ORDINARY_ROW });
    });
  });
});
