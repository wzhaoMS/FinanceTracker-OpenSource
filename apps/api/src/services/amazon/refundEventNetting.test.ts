import { describe, expect, it } from 'vitest';
import { attributeOrderRefunds, type OrderRefundAttribution, type OrderRefundEvidence } from './refundAttribution.js';
import {
  REFUND_EVENT_CONFLICT_REASONS, REFUND_EVENT_HOLD_REASONS, REFUND_EVENT_NETTING_POLICY, REFUND_ISSUED_PHRASES, composeOrderRefunds,
  type OrderRefundComposition, type PageRefundEvent, type PageRefundItem,
} from './refundEventNetting.js';
import type { Money, OrderObservation } from './types.js';

// Entirely synthetic: made-up ASINs, titles and amounts.
const usd = (amountMinor: number): Money => ({ currency: 'USD', amountMinor });
const asin = (n: number) => `SYNTH${String(n).padStart(5, '0')}`;

/**
 * A captured order: its lines as [unit price, quantity], ASINs SYNTH00001… and titles `Synthetic item 0…`, its summary
 * (shipping and tax listed unless `unlisted`), and proof its item list is complete.
 */
function order(lines: Array<[number, number]>, options: { tax?: number; shipping?: number; promotion?: number;
  proven?: boolean; tender?: OrderObservation['tenderCoverage']; total?: number | null; unlisted?: Array<'tax' | 'shipping'>;
  asins?: Array<string | null>; titles?: string[] } = {}): OrderObservation {
  const subtotal = lines.reduce((sum, [price, quantity]) => sum + price * quantity, 0);
  const tax = options.tax ?? 0, shipping = options.shipping ?? 0, promotion = options.promotion ?? 0;
  const total = options.total === undefined ? subtotal + shipping + tax - promotion : options.total;
  const unlisted = new Set(options.unlisted ?? []);
  return {
    orderId: 'synthetic-order-1', date: '2026-10-01', total: total === null ? null : usd(total),
    items: lines.map(([price, quantity], lineOrdinal) => ({ lineOrdinal,
      itemId: options.asins ? options.asins[lineOrdinal] : asin(lineOrdinal + 1),
      title: options.titles?.[lineOrdinal] ?? `Synthetic item ${lineOrdinal}`, quantity, unitPrice: usd(price) })),
    summary: [{ kind: 'items-subtotal', money: usd(subtotal) },
      ...(unlisted.has('shipping') ? [] : [{ kind: 'shipping' as const, money: usd(shipping) }]),
      ...(unlisted.has('tax') ? [] : [{ kind: 'tax' as const, money: usd(tax) }]),
      ...(promotion ? [{ kind: 'promotion' as const, money: usd(promotion) }] : []),
      ...(total === null ? [] : [{ kind: 'grand-total' as const, money: usd(total) }])],
    ...(options.proven === false ? {} : { itemProof: { complete: true, unknownLine: false, conflict: false } }),
    tenderCoverage: options.tender ?? 'single-card-proven',
  };
}
/** An item as order details name it (by its line's ASIN), and as the Returns page does (by ASIN, or by title). */
const line = (lineOrdinal: number, units: number | null = null): PageRefundItem =>
  ({ lineOrdinal, itemId: asin(lineOrdinal + 1), title: null, units });
const product = (n: number, units: number | null = null): PageRefundItem => ({ lineOrdinal: null, itemId: asin(n), title: null, units });
const titled = (title: string, units: number | null = null): PageRefundItem => ({ lineOrdinal: null, itemId: null, title, units });
const details = (money: number | null, items: PageRefundItem[], patch: Partial<PageRefundEvent> = {}): PageRefundEvent =>
  ({ source: 'order-details', money: money === null ? null : usd(money), contradictory: false, items, observations: 1, ...patch });
const returns = (money: number | null, items: PageRefundItem[], patch: Partial<PageRefundEvent> = {}): PageRefundEvent =>
  details(money, items, { source: 'returns-page', ...patch });
const none: OrderRefundEvidence = { summaries: [], ledger: [] };
const total = (amount: number): OrderRefundEvidence => ({ summaries: [usd(amount)], ledger: [] });
const compose = (o: OrderObservation, evidence: OrderRefundEvidence, events: PageRefundEvent[]) =>
  composeOrderRefunds(o, attributeOrderRefunds(o, evidence), events);
/** What the spending view takes off each line for an attribution: whole units at their price plus money, capped at its price. */
function taken(o: OrderObservation, attribution: OrderRefundAttribution): Record<number, number> {
  return Object.fromEntries(attribution.lines.map(entry => {
    const item = o.items.find(i => i.lineOrdinal === entry.lineOrdinal)!;
    const price = item.unitPrice!.amountMinor * item.quantity!;
    return [entry.lineOrdinal, Math.min(price, Math.min(entry.units, item.quantity!) * item.unitPrice!.amountMinor + entry.moneyMinor)];
  }));
}
const sum = (values: readonly number[]) => values.reduce((n, v) => n + v, 0);

// Three lines, 10% tax, no shipping: A 1000 (1100 with tax), B 2000 (2200), C 4000 (4400). Total 7700.
const three = order([[1000, 1], [2000, 1], [4000, 1]], { tax: 700 });

describe('page refund statements in an order\'s refunds', () => {
  it('names its policy, the issued statements it counts, every hold reason and every surfaced conflict', () => {
    expect(REFUND_EVENT_NETTING_POLICY.version).toBe('amazon-refund-event-netting-v1');
    expect(REFUND_ISSUED_PHRASES).toEqual(['refund-issued', 'refund-complete', 'refund-processed', 'refunded']);
    expect(REFUND_EVENT_HOLD_REASONS).toEqual(['order-total-missing', 'currency-mismatch', 'contradictory', 'item-unmapped',
      'exceeds-order-total', 'exceeds-item-charge']);
    expect(REFUND_EVENT_CONFLICT_REASONS).toEqual(['refund-status-regressed']);
  });

  it('answers v1\'s own attribution, the same object, without statements or when they add nothing', () => {
    const base = attributeOrderRefunds(three, total(1100));
    expect(composeOrderRefunds(three, base, [])).toEqual({ attribution: base, events: 0, observations: 0, held: null, parts: [],
      conflicts: [] });
    expect(composeOrderRefunds(three, base, []).attribution).toBe(base);
    // Only pending statements: nothing issued, v1's own answer and no counts.
    expect(composeOrderRefunds(three, base, [returns(null, [product(1)], { issued: false, capture: 1, event: 'e1' })]))
      .toEqual({ attribution: base, events: 0, observations: 0, held: null, parts: [], conflicts: [] });
    // A refund the page tied to no item, within what the Refund Total already counts: v1's answer stands.
    const within = composeOrderRefunds(three, base, [details(1100, [])]);
    expect(within.attribution).toBe(base);
    expect(within).toMatchObject({ events: 1, held: null });
    // A statement without money and nothing else counted: nothing to tie.
    expect(compose(three, none, [details(null, [line(0)])]).attribution).toEqual(attributeOrderRefunds(three, none));
  });

  it('counts an item refund from the statements alone, its item cents off its line and the rest its tax', () => {
    const one = compose(three, none, [details(1100, [line(0)])]);
    expect(one.attribution).toEqual({ currency: 'USD', refundMinor: 1100, source: 'item-records', basis: 'item-records',
      lines: [{ lineOrdinal: 0, units: 1, moneyMinor: 0 }], unattributedMinor: 0, unattributedReason: null, excluded: [] });
    expect(one.parts).toEqual([{ kind: 'line', lines: [0], moneyMinor: 1100, itemMinor: 1000, allocation: [{ lineOrdinal: 0, minor: 1000 }] }]);
    expect(compose(three, none, [returns(2200, [product(2)])]).attribution)
      .toMatchObject({ refundMinor: 2200, basis: 'item-records', lines: [{ lineOrdinal: 1, units: 1, moneyMinor: 0 }] });
  });

  it('counts one refund once across the Refund Total, the ledger, order details and the Returns page', () => {
    const once = { currency: 'USD', refundMinor: 1100, lines: [{ lineOrdinal: 0, units: 1, moneyMinor: 0 }], unattributedMinor: 0 };
    for (const [evidence, events] of [
      [total(1100), [details(1100, [line(0)])]],
      [{ summaries: [], ledger: [usd(1100)] }, [returns(1100, [product(1)])]],
      [none, [details(1100, [line(0)]), returns(1100, [product(1)])]],
      [{ summaries: [usd(1100)], ledger: [usd(1100)] }, [details(1100, [line(0)]), returns(1100, [product(1)])]],
    ] as Array<[OrderRefundEvidence, PageRefundEvent[]]>) {
      expect(compose(three, evidence, events).attribution).toMatchObject(once);
    }
    // The Refund Total names the source when it agrees; the larger evidence otherwise.
    expect(compose(three, total(1100), [details(1100, [line(0)])]).attribution.source).toBe('order-summary');
    expect(compose(three, { summaries: [], ledger: [usd(1100)] }, [details(1100, [line(0)])]).attribution.source).toBe('ledger');
    expect(compose(three, total(1100), [returns(3300, [product(1), product(2)])]).attribution.source).toBe('item-records');
  });

  it('takes the largest amount per line across sources and statements, never their sum', () => {
    // A: 400 by order details, 600 by the Returns page; B: 1200 and 900. Per line the largest: 600 + 1200.
    const plain = order([[1000, 1], [2000, 1], [4000, 1]]);
    const result = compose(plain, total(1500), [details(400, [line(0)]), returns(600, [product(1)]), details(1200, [line(1)]),
      returns(900, [product(2)])]);
    expect(result).toMatchObject({ held: null, attribution: { refundMinor: 1800, unattributedMinor: 0 } });
    expect(taken(plain, result.attribution)).toEqual({ 0: 600, 1: 1200 });
    // Two returns of one line are one line's refund: the larger, never two (a later run may restate it).
    expect(compose(three, none, [returns(1100, [product(1)]), returns(1100, [product(1)])]).attribution.refundMinor).toBe(1100);
    // Even as two statements of one capture: one line's refund, the larger (only statements naming no item add up).
    expect(compose(three, none, [details(300, [line(0)], { capture: 1, event: 'a0' }), details(500, [line(0)], { capture: 1, event: 'a1' })])
      .attribution.refundMinor).toBe(500);
    // Refunds of different items add up.
    expect(compose(three, none, [details(1100, [line(0)]), returns(2200, [product(2)])]).attribution).toMatchObject({
      refundMinor: 3300, basis: 'item-records', lines: [{ lineOrdinal: 0, units: 1 }, { lineOrdinal: 1, units: 1 }] });
  });

  describe('maps every statement to a line by identity before counting it', () => {
    it('by ASIN, else by exact title; a position never names a line', () => {
      // Its position says line 0, its ASIN says line 1: the ASIN names it.
      expect(compose(three, none, [details(2200, [{ ...line(0), itemId: asin(2) }])]).attribution.lines)
        .toEqual([{ lineOrdinal: 1, units: 1, moneyMinor: 0 }]);
      expect(compose(three, none, [returns(4400, [titled('Synthetic item 2')])]).attribution.lines)
        .toEqual([{ lineOrdinal: 2, units: 1, moneyMinor: 0 }]);
    });
    it('counts once an item seen without, then with, its ASIN; and items with different titles apart', () => {
      expect(compose(three, none, [returns(1100, [titled('Synthetic item 0')]), returns(1100, [product(1)])]).attribution.refundMinor)
        .toBe(1100);
      const noAsins = order([[1000, 1], [2000, 1], [4000, 1]], { tax: 700, asins: [null, null, null] });
      expect(compose(noAsins, none, [details(1100, [titled('Synthetic item 0')]), details(2200, [titled('Synthetic item 1')])])
        .attribution).toMatchObject({ refundMinor: 3300, lines: [{ lineOrdinal: 0, units: 1 }, { lineOrdinal: 1, units: 1 }] });
      // A statement with an ASIN the order doesn't show matches a line by title only when that line shows no ASIN.
      expect(compose(noAsins, none, [returns(1100, [{ ...product(9), title: 'Synthetic item 0' }])]).attribution.lines)
        .toEqual([{ lineOrdinal: 0, units: 1, moneyMinor: 0 }]);
      expect(compose(three, none, [returns(1100, [{ ...product(9), title: 'Synthetic item 0' }])]).held).toBe('item-unmapped');
    });
    it('holds when an identity names no line, or more than one', () => {
      const twins = order([[1000, 1], [1000, 1]], { asins: [null, null], titles: ['Synthetic twin', 'Synthetic twin'] });
      expect(compose(twins, none, [returns(1000, [titled('Synthetic twin')])]).held).toBe('item-unmapped');
      const shared = order([[1000, 1], [1000, 1]], { asins: [asin(1), asin(1)] });
      expect(compose(shared, none, [returns(1000, [product(1)])]).held).toBe('item-unmapped');
      expect(compose(three, none, [returns(1100, [titled('Synthetic item 9')])]).held).toBe('item-unmapped');
      expect(compose(three, none, [returns(1100, [{ lineOrdinal: 0, itemId: null, title: null, units: null }])]).held).toBe('item-unmapped');
      const unpriced = { ...three, items: three.items.map((item, i) => (i === 1 ? { ...item, unitPrice: null } : item)) };
      expect(compose(unpriced, none, [returns(2200, [product(2)])]).held).toBe('item-unmapped');
      // Two items of one statement naming one line.
      expect(compose(three, none, [returns(1100, [product(1), titled('Synthetic item 0')])]).held).toBe('item-unmapped');
    });
  });

  describe('uses the finest amounts the statements prove', () => {
    it('splits a statement naming several lines when its units and money prove each line\'s amount', () => {
      // No tax or shipping. D: two units of A. R: one unit each of A and B, exactly their prices. Per line: 2A and B.
      const cart = order([[1000, 2], [1000, 1], [5000, 1]]);
      const result = compose(cart, none, [details(2000, [line(0, 2)]), returns(2000, [product(1, 1), product(2, 1)])]);
      expect(result).toMatchObject({ held: null, attribution: { refundMinor: 3000, basis: 'item-records' } });
      expect(taken(cart, result.attribution)).toEqual({ 0: 2000, 1: 1000 });
      // A single-unit line needs no stated units; tax shares are part of the proof.
      expect(compose(three, none, [details(1100, [line(0)]), returns(3300, [product(1), product(2)])]).attribution)
        .toMatchObject({ refundMinor: 3300, lines: [{ lineOrdinal: 0, units: 1 }, { lineOrdinal: 1, units: 1 }] });
      // A split that doesn't divide evenly still puts every cent of the statement on a line (largest remainder).
      const odd = order([[1000, 1], [2000, 1], [4000, 1]], { tax: 8 });
      const split = compose(odd, none, [returns(3004, [product(1), product(2)])]);
      expect(split).toMatchObject({ held: null, attribution: { refundMinor: 3004 } });
      expect(split.parts.map(part => [part.kind, part.moneyMinor, part.itemMinor])).toEqual([['line', 1001, 1000], ['line', 2003, 2000]]);
    });
    it('keeps a bundle together when nothing proves its split: the larger of it and its lines\' own amounts', () => {
      const cart = order([[1000, 2], [1000, 1], [5000, 1]]);
      // Units unknown on a line of two: R's 1500 for A and B is a bundle. A's own amount (D: 2000) is larger.
      expect(compose(cart, none, [details(2000, [line(0, 2)]), returns(1500, [product(1), product(2)])]).attribution.refundMinor)
        .toBe(2000);
      // The bundle larger than its lines' own amounts: A keeps its own 500, the bundle's money beyond it goes first to
      // B (no amount proved for it), up to B's price, and the rest to A.
      const bundle = compose(cart, none, [details(500, [line(0)]), returns(2400, [product(1), product(2)])]);
      expect(bundle.attribution.refundMinor).toBe(2400);
      expect(taken(cart, bundle.attribution)).toEqual({ 0: 1400, 1: 1000 });
      expect(bundle.parts).toEqual([{ kind: 'bundle', lines: [0, 1], moneyMinor: 2400, itemMinor: 2400,
        allocation: [{ lineOrdinal: 0, minor: 1400 }, { lineOrdinal: 1, minor: 1000 }] }]);
    });
    it('never takes a line\'s proven amount back to split a bundle: only the bundle\'s excess is spread', () => {
      // Root's example: D A 900, R A+B 1000, both priced 1000: A 900, B 100.
      const pair = order([[1000, 1], [1000, 1], [5000, 1]]);
      const result = compose(pair, none, [details(900, [line(0)]), returns(1000, [product(1), product(2)])]);
      expect(result).toMatchObject({ held: null, attribution: { refundMinor: 1000 } });
      expect(taken(pair, result.attribution)).toEqual({ 0: 900, 1: 100 });
      // A bundle no larger than its lines' own amounts adds nothing and changes no line.
      expect(taken(pair, compose(pair, none, [details(900, [line(0)]), returns(800, [product(1), product(2)])]).attribution))
        .toEqual({ 0: 900 });
    });
    it('takes a bundle at or below its prices off its items to the cent, whatever their tax shares', () => {
      // Two units of a 1¢ line and a 100¢ line, tax 100: 101 refunded for both is 101 off them, never 98 and 3 of tax.
      const cheap = order([[1, 2], [100, 1], [1000, 1]], { tax: 100 });
      const result = compose(cheap, none, [details(101, [line(0), line(1)])]);
      expect(result).toMatchObject({ held: null, attribution: { refundMinor: 101, unattributedMinor: 0 } });
      expect(result.parts).toEqual([{ kind: 'bundle', lines: [0, 1], moneyMinor: 101, itemMinor: 101,
        allocation: [{ lineOrdinal: 0, minor: 2 }, { lineOrdinal: 1, minor: 99 }] }]);
      expect(taken(cheap, result.attribution)).toEqual({ 0: 2, 1: 99 });
      // Uneven lines; tax, shipping or both; below, at and above their prices: only cents above them are tax and shipping.
      for (const prices of [[2, 100], [3, 997], [1, 1, 98]]) {
        for (const [tax, shipping] of [[100, 0], [0, 100], [50, 50]]) {
          const cart = order(prices.map(price => [price, 1] as [number, number]), { tax, shipping });
          const all = sum(prices);
          for (const money of [all - 1, all, all + 1]) {
            const shape = compose(cart, none, [returns(money, prices.map((_, i) => product(i + 1)))]);
            expect(shape.held).toBeNull();
            expect(sum(shape.parts.map(part => part.itemMinor))).toBe(Math.min(money, all));
            expect(sum(Object.values(taken(cart, shape.attribution)))).toBe(Math.min(money, all));
          }
        }
      }
      // A line's own amount above its price keeps its tax; the bundle's excess comes off what the prices leave.
      const taxed = compose(three, none, [details(1100, [line(0)]), returns(2000, [product(1), product(2)])]);
      expect(taxed.parts).toEqual([{ kind: 'bundle', lines: [0, 1], moneyMinor: 2000, itemMinor: 1900,
        allocation: [{ lineOrdinal: 0, minor: 1000 }, { lineOrdinal: 1, minor: 900 }] }]);
    });
    it('picks the best set of overlapping bundles that never counts a line twice', () => {
      const cart = order([[1000, 2], [1000, 2], [1000, 2], [8000, 1]]);
      // A+B 1500, B+C 1500, C alone 1200 (own): A+B and C (2700) beats B+C alone (1500).
      const result = compose(cart, none, [returns(1500, [product(1), product(2)]), details(1500, [line(1), line(2)]),
        details(1200, [line(2)])]);
      expect(result.attribution.refundMinor).toBe(2700);
      expect(sum(Object.values(taken(cart, result.attribution)))).toBe(2700);
    });
  });

  describe('holds each statement to exactly the items it names, before anything is combined', () => {
    const heldWith = (reason: string, left: string, events = 1) => ({
      held: reason, events,
      attribution: { currency: 'USD', refundMinor: 1100, source: 'order-summary', basis: 'unattributed', lines: [],
        unattributedMinor: 1100, unattributedReason: 'conflict', excluded: [{ source: 'item-records', reason: left, count: events }] },
    });
    it.each([
      ['currency-mismatch', 'currency-mismatch', [details(1100, [line(0)], { money: { currency: 'EUR', amountMinor: 1100 } })]],
      ['contradictory', 'contradictory', [returns(1100, [product(1)], { contradictory: true })]],
      ['item-unmapped', 'unresolved', [returns(1100, [product(9)])]],
      ['exceeds-order-total', 'exceeds-order-total', [returns(7800, [product(1), product(2), product(3)])]],
      ['exceeds-order-total', 'exceeds-order-total', [details(7701, [])]],
      ['exceeds-item-charge', 'contradictory', [returns(1103, [product(1)])]],
      ['exceeds-item-charge', 'contradictory', [returns(1100, [product(1, 2)])]],
    ] as Array<[string, string, PageRefundEvent[]]>)('%s (left out as %s)', (reason, left, events) => {
      expect(compose(three, total(1100), events)).toMatchObject(heldWith(reason, left));
      // Without other evidence nothing is counted at all.
      expect(compose(three, none, events)).toMatchObject({ held: reason, parts: [], attribution: { refundMinor: 0, basis: null,
        lines: [], excluded: [{ source: 'item-records', reason: left, count: 1 }] } });
    });
    it('caps a named item at its price plus its proportional share of tax and shipping, within v1\'s rounding margin', () => {
      // A: 1000 + 700 × 1000 / 7000 = 1100, plus half a cent per unit and per priced line: 1102.
      expect(compose(three, none, [returns(1102, [product(1)])]).held).toBeNull();
      expect(compose(three, none, [returns(1103, [product(1)])]).held).toBe('exceeds-item-charge');
      // Shipping shares too: 1000 + (700 + 700) × 1000 / 7000 = 1200, plus 2.
      const shipped = order([[1000, 1], [2000, 1], [4000, 1]], { tax: 700, shipping: 700 });
      expect(compose(shipped, none, [returns(1202, [product(1)])]).held).toBeNull();
      expect(compose(shipped, none, [returns(1203, [product(1)])]).held).toBe('exceeds-item-charge');
      // Without tax or shipping, the price exactly.
      const plain = order([[1000, 1], [2000, 1], [4000, 1]]);
      expect(compose(plain, none, [returns(1000, [product(1)])]).held).toBeNull();
      expect(compose(plain, none, [returns(1001, [product(1)])]).held).toBe('exceeds-item-charge');
    });
    it('caps a named item at its price when the order\'s tax or shipping is unknown', () => {
      for (const unlisted of [['tax'], ['shipping']] as Array<Array<'tax' | 'shipping'>>) {
        const unknown = order([[1000, 1], [2000, 1], [4000, 1]], { tax: 700, unlisted });
        expect(compose(unknown, none, [returns(1000, [product(1)])]).held).toBeNull();
        expect(compose(unknown, none, [returns(1001, [product(1)])]).held).toBe('exceeds-item-charge');
      }
      // A named $10 item can't carry a $90 refund, however large the order.
      const large = order([[1000, 1], [9000, 1]], { total: 10000, unlisted: ['tax', 'shipping'] });
      expect(compose(large, none, [details(9000, [line(0)])]).held).toBe('exceeds-item-charge');
    });
    it('caps stated units at their own price, and never more units than a line has', () => {
      const pair = order([[1000, 2], [3000, 1]]);
      expect(compose(pair, none, [returns(1000, [product(1, 1)])]).held).toBeNull();
      expect(compose(pair, none, [returns(1001, [product(1, 1)])]).held).toBe('exceeds-item-charge');
      expect(compose(pair, none, [returns(2000, [product(1, 3)])]).held).toBe('exceeds-item-charge');
      expect(compose(three, none, [returns(1100, [product(1, 1)]), returns(1100, [product(1, 1)])]).held).toBeNull();
    });
    it('never lets a larger statement launder another one\'s impossible amount', () => {
      const cart = order([[1000, 1], [9000, 1], [10000, 1]]);
      expect(compose(cart, none, [details(5000, [line(0)]), returns(10000, [product(1), product(2)])]))
        .toMatchObject({ held: 'exceeds-item-charge', attribution: { refundMinor: 0 } });
      expect(compose(three, none, [details(4000, [line(0), line(1)])]).held).toBe('exceeds-item-charge');
    });
    it('holds whole even when v1 alone would tie the whole order, and counts every statement of the order once', () => {
      const all = total(7700);
      expect(attributeOrderRefunds(three, all).basis).toBe('whole-order');
      expect(compose(three, all, [details(1100, [line(0)]), returns(2200, [product(9)])])).toMatchObject({
        held: 'item-unmapped', events: 2, attribution: { refundMinor: 7700, basis: 'unattributed', unattributedMinor: 7700,
          unattributedReason: 'conflict', excluded: [{ source: 'item-records', reason: 'unresolved', count: 2 }] } });
    });
    it('holds without an order total, which caps nothing', () => {
      const untotaled = order([[1000, 1]], { total: null });
      expect(compose(untotaled, none, [details(1000, [line(0)])])).toMatchObject({ held: 'order-total-missing',
        attribution: { refundMinor: 0, excluded: [{ source: 'item-records', reason: 'unresolved', count: 1 }] } });
    });
  });

  it('counts statements naming no item as distinct only when seen together in one capture, else the largest', () => {
    const cart = order([[1000, 1], [9000, 1], [10000, 1]]);
    // Without a capture in common, nothing proves them distinct: the largest.
    expect(compose(cart, none, [details(1000, []), details(2000, [])]).attribution.refundMinor).toBe(2000);
    expect(compose(cart, none, [details(2000, []), returns(1500, [])]).attribution.refundMinor).toBe(2000);
    // Two statements of one source in one capture are two refunds; the same statement in later captures is one.
    const seen = (money: number, capture: number, event: string) => details(money, [], { capture, event });
    expect(compose(cart, none, [seen(1000, 1, 'e0'), seen(2000, 1, 'e1')]).attribution.refundMinor).toBe(3000);
    expect(compose(cart, none, [seen(1000, 1, 'e0'), seen(2000, 1, 'e1'), seen(1000, 2, 'e0'), seen(2000, 2, 'e1')])
      .attribution.refundMinor).toBe(3000);
    expect(compose(cart, none, [seen(1000, 1, 'e0'), seen(1500, 2, 'e0')]).attribution.refundMinor).toBe(1500);
    // #155 tells them apart only by their place among them in a capture: two amounts read back in swapped places read as
    // one statement going down, which holds rather than guesses.
    expect(compose(cart, none, [seen(1000, 1, 'e0'), seen(2000, 1, 'e1'), seen(2000, 2, 'e0'), seen(1000, 2, 'e1')]).held)
      .toBe('contradictory');
    // Across sources, never added: the largest.
    expect(compose(cart, none, [seen(1000, 1, 'e0'), seen(2000, 1, 'e1'), returns(2500, [], { capture: 1, event: 'r0' })])
      .attribution.refundMinor).toBe(3000);
    // Distinct statements beyond the order's total hold it, keeping v1's amount whole.
    const ten = order([[1000, 1], [9000, 1]]);
    expect(compose(ten, total(1000), [seen(6000, 1, 'e0'), seen(6000, 1, 'e1')])).toMatchObject({ held: 'exceeds-order-total',
      attribution: { refundMinor: 1000, unattributedMinor: 1000 } });
    expect(compose(ten, total(1000), [seen(6000, 1, 'e0'), seen(6000, 2, 'e0')]).held).toBeNull();
    expect(compose(three, none, [details(2200, [])]).attribution).toMatchObject({ refundMinor: 2200, source: 'item-records',
      basis: 'units', lines: [{ lineOrdinal: 1, units: 1 }] });
    expect(compose(three, none, [returns(2500, [])]).attribution).toMatchObject({ refundMinor: 2500, basis: 'unattributed',
      unattributedMinor: 2500, unattributedReason: 'no-match' });
    // Never added to itemized money either: the larger of the two.
    expect(compose(three, none, [details(1100, [line(0)]), details(1100, [])]).attribution.refundMinor).toBe(1100);
  });

  describe('follows each refund\'s history on its stable line, in import order', () => {
    // A seen first by title, later by ASIN: one line, one refund's history.
    const byTitle = (money: number | null, capture: number, patch: Partial<PageRefundEvent> = {}) =>
      returns(money, [titled('Synthetic item 0')], { capture, event: 'title-a', ...patch });
    const byAsin = (money: number | null, capture: number, patch: Partial<PageRefundEvent> = {}) =>
      returns(money, [product(1)], { capture, event: 'asin-a', ...patch });
    it('counts a refund once when its identity improves, and advances from pending to completed', () => {
      expect(compose(three, none, [byTitle(1100, 1), byAsin(1100, 2)])).toMatchObject({ held: null, conflicts: [],
        attribution: { refundMinor: 1100 } });
      expect(compose(three, none, [byTitle(null, 1, { issued: false }), byAsin(1100, 2)])).toMatchObject({ held: null, conflicts: [],
        attribution: { refundMinor: 1100 } });
      expect(compose(three, none, [byTitle(600, 1), byAsin(1100, 2)]).attribution.refundMinor).toBe(1100);
    });
    it('keeps the furthest completed amount when a later statement steps back to pending, and surfaces it', () => {
      for (const later of [byAsin(null, 2, { issued: false }), byTitle(null, 2, { issued: false })]) {
        expect(compose(three, none, [byTitle(1100, 1), later])).toMatchObject({ held: null, events: 1,
          conflicts: ['refund-status-regressed'], attribution: { refundMinor: 1100, lines: [{ lineOrdinal: 0, units: 1 }] } });
      }
      // A pending statement in the same capture as a completed one steps nothing back.
      expect(compose(three, none, [byTitle(1100, 1), byAsin(null, 1, { issued: false })]).conflicts).toEqual([]);
    });
    it('holds a later smaller completed amount on the same line as contradictory, whatever its identity', () => {
      expect(compose(three, total(1100), [byTitle(1100, 1), byAsin(500, 2)])).toMatchObject({ held: 'contradictory',
        attribution: { refundMinor: 1100, unattributedMinor: 1100 } });
      expect(compose(three, none, [byAsin(1100, 1), byAsin(900, 2, { event: 'asin-a' })]).held).toBe('contradictory');
      // A different source may show another amount: never a contradiction, the larger counts.
      expect(compose(three, none, [byAsin(1100, 1), details(900, [line(0)], { capture: 2, event: 'd-a' })]))
        .toMatchObject({ held: null, attribution: { refundMinor: 1100 } });
    });
    it('holds when a pending statement names an item the order doesn\'t have', () => {
      expect(compose(three, none, [byAsin(1100, 1), returns(null, [product(9)], { issued: false, capture: 2, event: 'x' })]).held)
        .toBe('item-unmapped');
    });
  });

  describe('takes off items exactly the cents counted for them', () => {
    it('never more than the refund: a cent short of a unit takes that many cents, not the unit', () => {
      const pair = order([[1000, 1], [1000, 1]], { tax: 1 });
      const result = compose(pair, none, [details(999, [line(0)])]);
      expect(result).toMatchObject({ held: null, attribution: { refundMinor: 999, lines: [{ lineOrdinal: 0, units: 0, moneyMinor: 999 }] } });
      expect(taken(pair, result.attribution)).toEqual({ 0: 999 });
      const cents = order([[100, 1], [100, 1]], { tax: 1 });
      expect(taken(cents, compose(cents, none, [details(99, [line(0)])]).attribution)).toEqual({ 0: 99 });
    });
    it('takes a partial refund\'s cents off its line, and a refund with tax off its price, the rest being tax', () => {
      expect(compose(three, none, [returns(600, [product(1)])]).parts)
        .toEqual([{ kind: 'line', lines: [0], moneyMinor: 600, itemMinor: 600, allocation: [{ lineOrdinal: 0, minor: 600 }] }]);
      // One unit of a line of two, found by its money: its price off the line, not two units' worth of tax.
      const pair = order([[1000, 2], [3000, 1]], { tax: 500 });
      expect(compose(pair, none, [returns(1100, [product(1)])]).attribution.lines).toEqual([{ lineOrdinal: 0, units: 1, moneyMinor: 0 }]);
    });
    it('spreads the whole refund of a promoted order over its lines, never more than it', () => {
      const promoted = order([[1000, 1], [3000, 1]], { promotion: 400 });
      const result = compose(promoted, none, [returns(3600, [])]);
      expect(result.attribution).toMatchObject({ basis: 'whole-order', refundMinor: 3600 });
      expect(sum(Object.values(taken(promoted, result.attribution)))).toBe(3600);
      // Shares that don't divide evenly still add up to the refund.
      const odd = order([[1000, 1], [2000, 1]], { promotion: 1 });
      expect(taken(odd, compose(odd, none, [returns(2999, [])]).attribution)).toEqual({ 0: 1000, 1: 1999 });
    });
  });

  it('ties what v1 counts beyond the statements to lines named without an amount, then by v1 over the units left', () => {
    // A Refund Total for A and B; the Returns page shows A: A is its, and v1 finds B for the rest.
    expect(compose(three, total(3300), [returns(1100, [product(1)])]).attribution).toMatchObject({
      refundMinor: 3300, source: 'order-summary', basis: 'item-records', unattributedMinor: 0,
      lines: [{ lineOrdinal: 0, units: 1, moneyMinor: 0 }, { lineOrdinal: 1, units: 1, moneyMinor: 0 }] });
    // Two pens at one price: v1 alone can't tell which came back; the Returns page can.
    const pens = order([[1000, 1], [1000, 1]]);
    expect(attributeOrderRefunds(pens, total(1000))).toMatchObject({ basis: 'unattributed', unattributedReason: 'ambiguous' });
    expect(compose(pens, total(1000), [returns(null, [product(2)])]).attribution).toMatchObject({
      refundMinor: 1000, basis: 'item-records', lines: [{ lineOrdinal: 1, units: 1, moneyMinor: 0 }], unattributedMinor: 0 });
    // A line named without an amount takes at least a unit; v1 finds the line's other unit in what is left.
    const pair = order([[1000, 2], [3000, 1]], { tax: 500 });
    expect(compose(pair, total(2200), [details(null, [line(0)])]).attribution)
      .toMatchObject({ basis: 'item-records', lines: [{ lineOrdinal: 0, units: 2, moneyMinor: 0 }], unattributedMinor: 0 });
    // What v1 can't tie stays not attributed, with v1's reason; a ledger refund keeps a payment's scope.
    const split = order([[1000, 1], [2000, 1], [4000, 1]], { tax: 700, tender: 'multi-tender' });
    expect(compose(split, { summaries: [], ledger: [usd(3300)] }, [returns(1100, [product(1)])]).attribution).toMatchObject({
      refundMinor: 3300, source: 'ledger', basis: 'partly', lines: [{ lineOrdinal: 0, units: 1 }], unattributedMinor: 2200,
      unattributedReason: 'mixed-tender' });
    expect(compose(split, total(3300), [returns(1100, [product(1)])]).attribution)
      .toMatchObject({ basis: 'item-records', lines: [{ lineOrdinal: 0 }, { lineOrdinal: 1 }] });
    // A later Returns-page refund beyond the Refund Total raises the amount; the order's whole total ties every unit.
    expect(compose(three, total(1100), [returns(1100, [product(1)]), returns(2200, [product(2)])]).attribution)
      .toMatchObject({ refundMinor: 3300, source: 'item-records' });
    expect(compose(three, none, [details(1100, [line(0)]), returns(6600, [product(2), product(3)])]).attribution).toMatchObject({
      refundMinor: 7700, basis: 'whole-order', lines: [{ lineOrdinal: 0, units: 1 }, { lineOrdinal: 1, units: 1 }, { lineOrdinal: 2, units: 1 }] });
  });

  it('reads an order with an unpriced line without failing, and never ties a refund to it', () => {
    const unpriced = { ...three, items: three.items.map((item, i) => (i === 2 ? { ...item, unitPrice: null } : item)) };
    expect(compose(unpriced, total(3300), [returns(1100, [product(1)])]).attribution).toMatchObject({
      refundMinor: 3300, basis: 'partly', lines: [{ lineOrdinal: 0, units: 1 }], unattributedMinor: 2200,
      unattributedReason: 'items-unproven' });
  });
});

describe('composed refunds on random carts', () => {
  let seed = 20261022;
  const rand = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const pick = <T>(list: readonly T[]): T => list[rand(list.length)];
  /** A random cart: 1 to 5 lines of 1 to 3 units, some free; tax and shipping known or not; sometimes a promotion. */
  function cart(): OrderObservation {
    const lines = Array.from({ length: 1 + rand(5) }, () => [rand(8) === 0 ? 0 : 1 + rand(5000), 1 + rand(3)] as [number, number]);
    const subtotal = lines.reduce((n, [p, q]) => n + p * q, 0);
    const tax = rand(3) === 0 ? 0 : rand(Math.max(1, Math.floor(subtotal / 8))), shipping = rand(2) ? 0 : rand(1500);
    const promotion = rand(10) === 0 ? rand(Math.max(1, Math.floor(subtotal / 4))) : 0;
    const unlisted = pick([[], [], [], ['tax'], ['shipping'], ['tax', 'shipping']] as Array<Array<'tax' | 'shipping'>>);
    const asins = lines.map((_, i) => (rand(5) === 0 ? null : asin(i + 1)));
    return order(lines, { tax, shipping, promotion, unlisted, asins, tender: rand(6) === 0 ? 'multi-tender' : 'single-card-proven',
      proven: rand(10) !== 0, total: subtotal + tax + shipping - promotion > 0 ? undefined : 1 });
  }
  /**
   * Random statements: items by ASIN or title (sometimes unknown), units, money up to a bit over their items' value or
   * none; read in one of three captures under one of four projection events, sometimes pending; rarely contradictory
   * or in another currency. Half the time, no capture or event at all (a refund taken as it is).
   */
  function statements(o: OrderObservation): PageRefundEvent[] {
    const total = o.total!.amountMinor;
    const timed = rand(2) === 0;
    return Array.from({ length: 1 + rand(6) }, () => {
      const lines = o.items.filter(() => rand(3) === 0);
      const items = rand(6) === 0 ? [] : lines.map(item => {
        const units = rand(3) === 0 ? 1 + rand(item.quantity! + 1) : null;
        if (rand(25) === 0) return product(99, units);
        return item.itemId !== null && rand(4) !== 0 ? { lineOrdinal: item.lineOrdinal!, itemId: item.itemId, title: null, units }
          : titled(item.title, units);
      });
      const value = items.length ? lines.reduce((n, item) => n + item.unitPrice!.amountMinor * item.quantity!, 0) : total;
      const pending = timed && rand(5) === 0;
      const money = pending || rand(5) === 0 ? null : 1 + rand(Math.max(1, Math.floor(value * (rand(4) === 0 ? 1.3 : 1.05)) + 2));
      const event = (rand(2) ? details : returns)(money, items,
        timed ? { capture: 1 + rand(3), event: `event-${rand(4)}`, ...(pending ? { issued: false } : {}) } : {});
      if (rand(40) === 0) event.contradictory = true;
      if (rand(40) === 0 && event.money) event.money = { currency: 'EUR', amountMinor: event.money.amountMinor };
      return event;
    });
  }
  function base(o: OrderObservation): OrderRefundEvidence {
    const total = o.total!.amountMinor;
    return pick([none, total > 1 ? { summaries: [usd(1 + rand(total))], ledger: [] } : none,
      { summaries: [], ledger: [usd(1 + rand(total))] }, { summaries: [usd(total)], ledger: [] }]);
  }
  /** Every cent of a composed refund accounted for, exactly; nothing taken off a line beyond its price or the refund. */
  function conserved(o: OrderObservation, evidence: OrderRefundEvidence, events: PageRefundEvent[], result: OrderRefundComposition) {
    const v1 = attributeOrderRefunds(o, evidence);
    const { attribution, parts } = result;
    if (result.held) {
      expect(parts).toEqual([]);
      expect(attribution.refundMinor).toBe(v1.refundMinor);
      expect(attribution.lines).toEqual([]);
      if (v1.refundMinor > 0 && v1.basis) expect(attribution.unattributedMinor).toBe(v1.refundMinor);
      expect(attribution.excluded.filter(entry => entry.source === 'item-records').reduce((n, e) => n + e.count, 0))
        .toBeGreaterThanOrEqual(result.events);
      expect(result.conflicts).toEqual([]);
      return 'held';
    }
    if (!parts.length) {
      expect(attribution).toEqual(v1);
      return 'v1';
    }
    const off = taken(o, attribution);
    expect(sum(parts.map(part => part.moneyMinor))).toBe(attribution.refundMinor);
    const byLine = new Map<number, number>();
    for (const part of parts) {
      expect(sum(part.allocation.map(a => a.minor))).toBe(part.itemMinor);
      expect(part.itemMinor).toBeGreaterThanOrEqual(0);
      expect(part.itemMinor).toBeLessThanOrEqual(part.moneyMinor);
      for (const a of part.allocation) {
        expect(part.lines).toContain(a.lineOrdinal);
        byLine.set(a.lineOrdinal, (byLine.get(a.lineOrdinal) ?? 0) + a.minor);
      }
    }
    for (const item of o.items) {
      const cents = byLine.get(item.lineOrdinal!) ?? 0;
      expect(off[item.lineOrdinal!] ?? 0).toBe(cents);
      expect(cents).toBeLessThanOrEqual(item.unitPrice ? item.unitPrice.amountMinor * item.quantity! : 0);
    }
    const items = sum(Object.values(off));
    const taxAndShipping = sum(parts.filter(part => part.kind !== 'unattributed').map(part => part.moneyMinor - part.itemMinor));
    expect(items + taxAndShipping + attribution.unattributedMinor).toBe(attribution.refundMinor);
    expect(attribution.refundMinor).toBeLessThanOrEqual(o.total!.amountMinor);
    expect(attribution.refundMinor).toBeGreaterThanOrEqual(v1.refundMinor);
    for (const event of events) {
      if (event.money && event.issued !== false) expect(attribution.refundMinor).toBeGreaterThanOrEqual(event.money.amountMinor);
    }
    return 'composed';
  }

  it('accounts for every cent exactly, per part and per order, whatever the order of its statements', () => {
    const outcomes = { held: 0, v1: 0, composed: 0, regressed: 0 };
    for (let n = 0; n < 3000; n++) {
      const o = cart(), evidence = base(o), events = statements(o);
      const result = compose(o, evidence, events);
      outcomes[conserved(o, evidence, events, result)]++;
      if (result.conflicts.length) outcomes.regressed++;
      const shuffled = [...events].sort(() => rand(3) - 1);
      expect(compose(o, evidence, shuffled)).toEqual(result);
    }
    // The random carts reach every outcome, step-backs included.
    expect(outcomes.held).toBeGreaterThan(200);
    expect(outcomes.composed).toBeGreaterThan(200);
    expect(outcomes.regressed).toBeGreaterThan(20);
  });

  it('takes a bundle\'s cents off its items up to their prices, keeping proven amounts, whatever their tax shares', () => {
    // Its own generator (mulberry32): a low bit of the carts' generator alternates, which would pair every choice.
    let state = 20261023;
    const draw = (n: number) => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = Math.imul(state ^ (state >>> 15), state | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
    const seen = { checked: 0, beyond: 0, owned: 0 };
    for (let n = 0; n < 2000; n++) {
      // The first line has several units and the bundle names it without units, so nothing proves a split; cheap and
      // dear lines make tax shares and rounding margins uneven.
      const lines = Array.from({ length: 2 + draw(3) }, (_, i) =>
        [1 + draw(draw(2) ? 10 : 3000), i === 0 ? 2 + draw(2) : 1 + draw(3)] as [number, number]);
      const subtotal = lines.reduce((total, [price, quantity]) => total + price * quantity, 0);
      const o = order(lines, { tax: draw(4) ? 1 + draw(1 + Math.floor(subtotal / 5)) : 0, shipping: draw(2) ? draw(500) : 0 });
      const named = [0, ...lines.slice(1).map((_, i) => i + 1).filter(() => draw(2) === 0)];
      if (named.length < 2) named.push(1);
      const units = named.map(l => (l === 0 || draw(2) ? null : 1 + draw(lines[l][1])));
      const ceilings = new Map(named.map((l, i) => [l, lines[l][0] * (units[i] ?? lines[l][1])]));
      const prices = sum([...ceilings.values()]);
      const statements = [details(1 + draw(prices + Math.floor(prices / 5) + 2), named.map((l, i) => line(l, units[i])))];
      const owned = draw(2) === 0;
      if (owned) {
        // A line's own amount, at or below the price of the units it states.
        const l = named[draw(named.length)], stated = 1 + draw(lines[l][1]);
        statements.push(returns(1 + draw(lines[l][0] * stated), [product(l + 1, stated)]));
        ceilings.set(l, Math.max(ceilings.get(l)!, lines[l][0] * stated));
      }
      const result = compose(o, none, statements);
      if (result.held || result.attribution.refundMinor === o.total!.amountMinor) continue;
      const refund = result.attribution.refundMinor, items = Math.min(refund, sum([...ceilings.values()]));
      expect(sum(result.parts.map(part => part.itemMinor))).toBe(items);
      expect(sum(Object.values(taken(o, result.attribution)))).toBe(items);
      seen.checked++;
      if (refund > items) seen.beyond++;
      if (owned) seen.owned++;
    }
    // Most carts reach a composed refund; many above their prices, half with a line's own amount inside the bundle.
    expect(seen.checked).toBeGreaterThan(1500);
    expect(seen.beyond).toBeGreaterThan(100);
    expect(seen.owned).toBeGreaterThan(700);
  });
});
