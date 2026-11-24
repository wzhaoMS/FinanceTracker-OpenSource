import { describe, expect, it } from 'vitest';
import {
  REFUND_SEARCH_LIMIT, attributeOrderRefunds, dedupeLedgerRefunds, matchRefund, orderRefundTotal, splitRefund,
  type LedgerRefundObservation,
} from './refundAttribution.js';
import type { Money, OrderObservation } from './types.js';

// Entirely synthetic: made-up order IDs, titles and amounts.
const usd = (amountMinor: number): Money => ({ currency: 'USD', amountMinor });

/** A captured order: its lines as [unit price, quantity], its summary, and proof its item list is complete. */
function order(lines: Array<[number, number]>, options: { tax?: number; shipping?: number; promotion?: number;
  proven?: boolean; tender?: OrderObservation['tenderCoverage']; total?: number | null } = {}): OrderObservation {
  const subtotal = lines.reduce((sum, [price, quantity]) => sum + price * quantity, 0);
  const tax = options.tax ?? 0, shipping = options.shipping ?? 0, promotion = options.promotion ?? 0;
  const total = options.total === undefined ? subtotal + shipping + tax - promotion : options.total;
  return {
    orderId: 'synthetic-order-1', date: '2026-10-01', total: total === null ? null : usd(total),
    items: lines.map(([price, quantity], lineOrdinal) => ({ lineOrdinal, itemId: null, title: `Synthetic item ${lineOrdinal}`,
      quantity, unitPrice: usd(price) })),
    summary: [{ kind: 'items-subtotal', money: usd(subtotal) }, { kind: 'shipping', money: usd(shipping) }, { kind: 'tax', money: usd(tax) },
      ...(promotion ? [{ kind: 'promotion' as const, money: usd(promotion) }] : []), ...(total === null ? [] : [{ kind: 'grand-total' as const, money: usd(total) }])],
    ...(options.proven === false ? {} : { itemProof: { complete: true, unknownLine: false, conflict: false } }),
    tenderCoverage: options.tender ?? 'single-card-proven',
  };
}

describe('which units one refund paid back', () => {
  // A kettle and two filters, with tax: 2999 + 2 × 450 = 3899 of items, 300 of tax.
  const kettle = order([[2999, 1], [450, 2]], { tax: 300 });

  it('ties a refund of the whole order to every unit, without needing the item list proven', () => {
    expect(matchRefund(kettle, usd(4199), 'payment')).toEqual({ kind: 'whole-order', lines: [{ lineOrdinal: 0, units: 1 }, { lineOrdinal: 1, units: 2 }] });
    expect(matchRefund(order([[2999, 1], [450, 2]], { tax: 300, proven: false }), usd(-4199), 'order-total'))
      .toMatchObject({ kind: 'whole-order' });
  });

  it('ties a refund to the one set of units whose prices plus their tax share it equals, within rounding', () => {
    // The kettle: 2999 + 2999 × 300 / 3899 = 3229.75; a cent either way still matches, three cents doesn't.
    for (const amount of [3229, 3230, 3231]) {
      expect(matchRefund(kettle, usd(amount), 'payment')).toEqual({ kind: 'units', lines: [{ lineOrdinal: 0, units: 1 }] });
    }
    expect(matchRefund(kettle, usd(3233), 'payment')).toEqual({ kind: 'held', reason: 'no-match' });
    // One filter of the two (450 + 34.6), then both.
    expect(matchRefund(kettle, usd(485), 'payment')).toEqual({ kind: 'units', lines: [{ lineOrdinal: 1, units: 1 }] });
    expect(matchRefund(kettle, usd(969), 'payment')).toEqual({ kind: 'units', lines: [{ lineOrdinal: 1, units: 2 }] });
    // Without tax, only the exact prices match.
    const untaxed = order([[1000, 1], [1500, 1]]);
    expect(matchRefund(untaxed, usd(1500), 'payment')).toEqual({ kind: 'units', lines: [{ lineOrdinal: 1, units: 1 }] });
    expect(matchRefund(untaxed, usd(1501), 'payment')).toEqual({ kind: 'held', reason: 'no-match' });
  });

  it('holds when more than one set matches, or the search would be too long to rule one out', () => {
    expect(matchRefund(order([[1000, 1], [1000, 1]]), usd(1000), 'payment')).toEqual({ kind: 'held', reason: 'ambiguous' });
    // 15 + 25 = 40: either the 40 or the other two.
    expect(matchRefund(order([[1500, 1], [2500, 1], [4000, 1]]), usd(4000), 'order-total')).toEqual({ kind: 'held', reason: 'ambiguous' });
    // Even prices can't make an odd amount, but there are far too many sets to try them all.
    const many = order(Array.from({ length: 20 }, () => [2, 999] as [number, number]), { total: 999_999 });
    expect(matchRefund(many, usd(19_999), 'order-total')).toEqual({ kind: 'held', reason: 'search-limit' });
    expect(REFUND_SEARCH_LIMIT).toBe(100_000);
  });

  it('needs the item list proven complete, no promotion, the tax, and for one payment a single card', () => {
    expect(matchRefund(order([[2999, 1], [450, 2]], { tax: 300, proven: false }), usd(3230), 'payment'))
      .toEqual({ kind: 'held', reason: 'items-unproven' });
    expect(matchRefund(order([[2999, 1], [450, 2]], { tax: 300, promotion: 100 }), usd(3230), 'order-total'))
      .toEqual({ kind: 'held', reason: 'promotion' });
    const split = order([[2999, 1], [450, 2]], { tax: 300, tender: 'multi-tender' });
    expect(matchRefund(split, usd(3230), 'payment')).toEqual({ kind: 'held', reason: 'mixed-tender' });
    expect(matchRefund(split, usd(3230), 'order-total')).toEqual({ kind: 'units', lines: [{ lineOrdinal: 0, units: 1 }] });
    const noTax = order([[2999, 1], [450, 2]]);
    noTax.summary = noTax.summary!.filter(entry => entry.kind !== 'tax');
    expect(matchRefund(noTax, usd(2999), 'payment')).toEqual({ kind: 'held', reason: 'summary-incomplete' });
  });

  it('gives a partial refund of a proven one-line order to that line, whatever else holds', () => {
    expect(matchRefund(order([[5000, 1]], { tax: 400 }), usd(2000), 'payment')).toEqual({ kind: 'only-line', lineOrdinal: 0 });
    expect(matchRefund(order([[5000, 1]], { tax: 400, promotion: 500, tender: 'multi-tender' }), usd(2000), 'payment'))
      .toEqual({ kind: 'only-line', lineOrdinal: 0 });
    // Two of three units, exactly: units, not money.
    expect(matchRefund(order([[1000, 3]]), usd(2000), 'payment')).toEqual({ kind: 'units', lines: [{ lineOrdinal: 0, units: 2 }] });
    expect(matchRefund(order([[5000, 1]], { proven: false }), usd(2000), 'payment')).toEqual({ kind: 'held', reason: 'items-unproven' });
  });

  it('refuses what contradicts the order: another currency, more than it cost, no amount, no total', () => {
    expect(matchRefund(kettle, { currency: 'EUR', amountMinor: 3230 }, 'payment')).toEqual({ kind: 'held', reason: 'currency-mismatch' });
    expect(matchRefund(kettle, usd(4200), 'payment')).toEqual({ kind: 'held', reason: 'exceeds-order-total' });
    expect(matchRefund(kettle, usd(0), 'payment')).toEqual({ kind: 'held', reason: 'invalid-amount' });
    expect(matchRefund(kettle, usd(1.5), 'payment')).toEqual({ kind: 'held', reason: 'invalid-amount' });
    expect(matchRefund(order([[2999, 1]], { total: null }), usd(2999), 'payment')).toEqual({ kind: 'held', reason: 'order-total-missing' });
  });

  it('splits one refund\'s money over its lines, to the cent, only over a proven item list', () => {
    const whole = splitRefund(kettle, usd(-4199), 'payment');
    expect(whole).toEqual({ kind: 'split', basis: 'whole-order', lines: [{ lineOrdinal: 0, units: 1, amountMinor: 3230 },
      { lineOrdinal: 1, units: 2, amountMinor: 969 }] });
    expect(splitRefund(kettle, usd(3230), 'payment')).toEqual({ kind: 'split', basis: 'units', lines: [{ lineOrdinal: 0, units: 1, amountMinor: 3230 }] });
    expect(splitRefund(order([[5000, 1]], { tax: 400 }), usd(2000), 'payment'))
      .toEqual({ kind: 'split', basis: 'only-line', lines: [{ lineOrdinal: 0, units: null, amountMinor: 2000 }] });
    expect(splitRefund(order([[2999, 1], [450, 2]], { tax: 300, proven: false }), usd(4199), 'payment'))
      .toEqual({ kind: 'held', reason: 'items-unproven' });
  });
  it('STEP 9 integration B5 (Root): a tied cent goes to the lower ordinal, or the lower stable key when every line has its own; else held', () => {
    // C's (2fcb59ae) vector: three lines of 1000 and 1 of tax; a refund of the whole order leaves one cent tied across them.
    const three = order([[1000, 1], [1000, 1], [1000, 1]], { tax: 1 });
    const cents = (keys?: ReadonlyMap<number, string>) => {
      const split = splitRefund(three, usd(3001), 'payment', keys);
      return split.kind === 'split' ? split.lines.map(line => line.amountMinor) : split;
    };
    expect(cents()).toEqual([1001, 1000, 1000]);
    expect(cents(new Map([[0, 'synthetic-key-c'], [1, 'synthetic-key-b'], [2, 'synthetic-key-a']]))).toEqual([1000, 1000, 1001]);
    // Keys on only some lines, mixed with ordinals pair by pair, order no tie totally (0 < 1 < 2 by ordinal, 2 < 0 by key);
    // one key on two lines orders none. Either way there is no stable order: the split holds, an existing reason, no new one.
    const held = { kind: 'held', reason: 'items-unproven' };
    expect(cents(new Map([[0, 'synthetic-key-b'], [1, 'synthetic-key-a']]))).toEqual(held);
    expect(cents(new Map([[0, 'synthetic-key-b'], [2, 'synthetic-key-a']]))).toEqual(held);
    expect(cents(new Map([[0, 'synthetic-key-a'], [1, 'synthetic-key-a'], [2, 'synthetic-key-b']]))).toEqual(held);
  });
});

describe('ledger refunds, each counted once', () => {
  const refund = (run: string, ordinal: number, amountMinor: number, options: { orders?: string[]; repeat?: boolean;
    evidence?: string; date?: string } = {}): LedgerRefundObservation => ({
    run, page: 0, ordinal, evidence: options.evidence ?? `synthetic-${amountMinor}-${(options.orders ?? ['A']).join()}`,
    refund: { date: options.date ?? '2026-10-02', money: usd(amountMinor), orderIds: options.orders ?? ['A'], repeat: options.repeat ?? false },
  });

  it('merges a refund every run shows again, and keeps two that one run shows apart', () => {
    const { groups, excluded } = dedupeLedgerRefunds([
      refund('run-1', 0, 1500), refund('run-2', 4, -1500), refund('run-3', 7, 1500, { date: '2026-10-03' }),
      // The same row twice in one run (two captures of it): one occurrence.
      refund('run-3', 7, 1500, { date: '2026-10-03' }),
      refund('run-1', 1, 700), refund('run-1', 2, 700, { date: '2026-10-05' }), refund('run-2', 5, 700),
    ]);
    expect(excluded).toEqual([]);
    // Ordered by orders, currency and size as text.
    expect(groups).toEqual([
      { orderIds: ['A'], currency: 'USD', amountMinor: 1500, events: 1, dates: ['2026-10-02'], observations: 4, ambiguousRepeats: 0 },
      { orderIds: ['A'], currency: 'USD', amountMinor: 700, events: 2, dates: ['2026-10-02', '2026-10-05'], observations: 3, ambiguousRepeats: 0 },
    ]);
  });

  it('counts exactly one of the rows the ledger showed identically, and leaves out rows read two ways or unreadable', () => {
    const { groups, excluded } = dedupeLedgerRefunds([
      // Three identical rows in one run, and again in another: one refund counts, two are left out once.
      refund('run-1', 0, 900, { repeat: true }), refund('run-1', 1, 900, { repeat: true }), refund('run-1', 6, 900, { repeat: true }),
      refund('run-3', 0, 900, { repeat: true }), refund('run-3', 1, 900, { repeat: true }),
      { ...refund('run-1', 2, 400), evidence: 'one-way' }, { ...refund('run-1', 2, 400), evidence: 'other-way' },
      { run: 'run-1', page: 0, ordinal: 3, evidence: 'a-charge', refund: null },
      { ...refund('run-2', 3, 600), evidence: 'refund' },
      refund('run-1', 4, 0),
      refund('run-1', 5, 800, { orders: ['B', 'A'] }),
    ]);
    expect(groups.map(g => [g.orderIds, g.amountMinor, g.events, g.ambiguousRepeats]))
      .toEqual([[['A', 'B'], 800, 1, 0], [['A'], 600, 1, 0], [['A'], 900, 1, 2]]);
    expect(excluded).toEqual([{ orderIds: ['A'], reason: 'contradictory', observations: 2 }, { orderIds: ['A'], reason: 'invalid', observations: 1 }]);
  });
});

describe('an order\'s Refund Total, counted once', () => {
  it('is the latest observation while it never goes down; else it contradicts itself', () => {
    expect(orderRefundTotal([])).toBeNull();
    expect(orderRefundTotal([usd(500), usd(500), usd(1200)])).toEqual({ kind: 'total', money: usd(1200), observations: 3 });
    expect(orderRefundTotal([usd(1200), usd(500)])).toEqual({ kind: 'contradictory', observations: 2 });
    expect(orderRefundTotal([usd(500), { currency: 'EUR', amountMinor: 600 }])).toEqual({ kind: 'contradictory', observations: 2 });
    expect(orderRefundTotal([usd(-5)])).toEqual({ kind: 'invalid', observations: 1 });
  });
});

describe('an order\'s refunds, tied to its items only on proof', () => {
  const none = { summaries: [], ledger: [] };

  it('counts the larger of the Refund Total and the ledger, never both', () => {
    const kettle = order([[2999, 1], [450, 2]], { tax: 300 });
    expect(attributeOrderRefunds(kettle, none)).toMatchObject({ refundMinor: 0, basis: null, source: null });
    expect(attributeOrderRefunds(kettle, { summaries: [usd(3230)], ledger: [usd(3230)] }))
      .toMatchObject({ refundMinor: 3230, source: 'order-summary', basis: 'units', lines: [{ lineOrdinal: 0, units: 1, moneyMinor: 0 }] });
    expect(attributeOrderRefunds(kettle, { summaries: [usd(485)], ledger: [usd(3230), usd(485)] }))
      .toMatchObject({ refundMinor: 3715, source: 'ledger', basis: 'units' });
    expect(attributeOrderRefunds(kettle, { summaries: [usd(4199)], ledger: [usd(485)] }))
      .toMatchObject({ refundMinor: 4199, source: 'order-summary', basis: 'whole-order' });
  });

  it('keeps a ledger refund of a split payment off the items: it may be one tender\'s share', () => {
    // Review reproduction: one 500 ledger refund on a proven 500/1000 order paid by more than one tender.
    const split = order([[500, 1], [1000, 1]], { tender: 'multi-tender' });
    expect(attributeOrderRefunds(split, { summaries: [], ledger: [usd(500)] }))
      .toMatchObject({ refundMinor: 500, basis: 'unattributed', lines: [], unattributedMinor: 500, unattributedReason: 'mixed-tender' });
    // Amazon's Refund Total is every refund of the order together: it may.
    expect(attributeOrderRefunds(split, { summaries: [usd(500)], ledger: [usd(500)] }))
      .toMatchObject({ basis: 'units', lines: [{ lineOrdinal: 0, units: 1 }] });
    // A whole order's worth is the whole order, however it was paid.
    expect(attributeOrderRefunds(split, { summaries: [], ledger: [usd(1500)] })).toMatchObject({ basis: 'whole-order' });
  });

  it('never lets the total tie units when the ledger refunds contradict each other', () => {
    // Review reproduction: two 500 refunds each match the one 500 unit; together they name two; 1000 matches the 1000.
    const three = order([[500, 1], [1000, 1], [3000, 1]]);
    expect(attributeOrderRefunds(three, { summaries: [], ledger: [usd(500), usd(500)] }))
      .toMatchObject({ refundMinor: 1000, basis: 'unattributed', lines: [], unattributedMinor: 1000, unattributedReason: 'conflict' });
    expect(attributeOrderRefunds(three, { summaries: [usd(1000)], ledger: [usd(500), usd(500)] }))
      .toMatchObject({ basis: 'unattributed', unattributedReason: 'conflict' });
    // One line of two units can take both.
    expect(attributeOrderRefunds(order([[500, 2], [1000, 1]]), { summaries: [], ledger: [usd(500), usd(500)] }))
      .toMatchObject({ basis: 'units', lines: [{ lineOrdinal: 0, units: 2 }] });
  });

  it('ties each ledger refund on its own when the total is ambiguous, and the rest stays off the items', () => {
    const three = order([[1500, 1], [2500, 1], [4000, 1]]);
    expect(attributeOrderRefunds(three, { summaries: [], ledger: [usd(1500), usd(2500)] }))
      .toMatchObject({ basis: 'units', lines: [{ lineOrdinal: 0, units: 1 }, { lineOrdinal: 1, units: 1 }], unattributedMinor: 0 });
    expect(attributeOrderRefunds(three, { summaries: [], ledger: [usd(1500), usd(700)] }))
      .toMatchObject({ basis: 'partly', lines: [{ lineOrdinal: 0, units: 1 }], unattributedMinor: 700, unattributedReason: 'no-match' });
    expect(attributeOrderRefunds(three, { summaries: [usd(3000)], ledger: [usd(1500)] }))
      .toMatchObject({ basis: 'partly', source: 'order-summary', lines: [{ lineOrdinal: 0, units: 1 }], unattributedMinor: 1500 });
  });

  it('takes a partial refund of a proven one-line order off that line, up to its price', () => {
    expect(attributeOrderRefunds(order([[5000, 1]], { tax: 400, shipping: 600 }), { summaries: [usd(5300)], ledger: [] }))
      .toMatchObject({ refundMinor: 5300, basis: 'only-line', lines: [{ lineOrdinal: 0, units: 0, moneyMinor: 5000 }], unattributedMinor: 0 });
    expect(attributeOrderRefunds(order([[5000, 1]]), { summaries: [usd(1234)], ledger: [] }))
      .toMatchObject({ basis: 'only-line', lines: [{ lineOrdinal: 0, units: 0, moneyMinor: 1234 }] });
  });

  it('leaves out and counts evidence that contradicts the order, and keeps the rest', () => {
    const kettle = order([[2999, 1], [450, 2]], { tax: 300 });
    expect(attributeOrderRefunds(kettle, { summaries: [usd(9999)], ledger: [usd(485)] })).toMatchObject({
      refundMinor: 485, source: 'ledger', basis: 'units', excluded: [{ source: 'order-summary', reason: 'exceeds-order-total', count: 1 }] });
    expect(attributeOrderRefunds(kettle, { summaries: [usd(900), usd(800)], ledger: [{ currency: 'EUR', amountMinor: 485 }] })).toMatchObject({
      refundMinor: 0, basis: null, excluded: [{ source: 'ledger', reason: 'currency-mismatch', count: 1 },
        { source: 'order-summary', reason: 'contradictory', count: 1 }] });
    expect(attributeOrderRefunds(kettle, { summaries: [], ledger: [usd(3000), usd(3000)] })).toMatchObject({
      refundMinor: 0, excluded: [{ source: 'ledger', reason: 'exceeds-order-total', count: 2 }] });
  });

  it('never lets rejected item records count money, or an amount tie an item other than those they name', () => {
    const three = order([[500, 1], [1000, 1], [3000, 1]]);
    // (a) A record of 500 naming two units of the one 500 unit: contradictory, and the only evidence. Nothing counts.
    expect(attributeOrderRefunds(three, { summaries: [], ledger: [], itemRecords: [{ money: usd(500), lines: [{ lineOrdinal: 0, units: 2 }] }] }))
      .toEqual({ currency: 'USD', refundMinor: 0, source: null, basis: null, lines: [], unattributedMinor: 0, unattributedReason: null,
        excluded: [{ source: 'item-records', reason: 'contradictory', count: 1 }] });
    // (b) Two 500 records naming the one 500 unit: unproven, and their money never refunds the unrelated 1000 line.
    const twice = [{ money: usd(500), lines: [{ lineOrdinal: 0, units: 1 }] }, { money: usd(500), lines: [{ lineOrdinal: 0, units: 1 }] }];
    expect(attributeOrderRefunds(three, { summaries: [], ledger: [], itemRecords: twice }))
      .toMatchObject({ refundMinor: 0, basis: null, lines: [], excluded: [{ source: 'item-records', reason: 'unresolved', count: 2 }] });
    // An independent Refund Total of 1000 still counts, but the records named the 500: it may not tie the 1000.
    expect(attributeOrderRefunds(three, { summaries: [usd(1000)], ledger: [], itemRecords: twice }))
      .toMatchObject({ refundMinor: 1000, source: 'order-summary', basis: 'unattributed', lines: [], unattributedMinor: 1000,
        unattributedReason: 'conflict' });
    // Tax-free 10 and 20, a Refund Total of 20, two records each of the one 10: never the 20.
    expect(attributeOrderRefunds(order([[1000, 1], [2000, 1]]), { summaries: [usd(2000)], ledger: [], itemRecords: [
      { money: usd(1000), lines: [{ lineOrdinal: 0, units: 1 }] }, { money: usd(1000), lines: [{ lineOrdinal: 0, units: 1 }] }] }))
      .toMatchObject({ basis: 'unattributed', lines: [], unattributedMinor: 2000, unattributedReason: 'conflict' });
    // The whole order's worth is every item, whatever the records named.
    expect(attributeOrderRefunds(three, { summaries: [usd(4500)], ledger: [], itemRecords: twice })).toMatchObject({ basis: 'whole-order' });
  });

  it('ties Amazon\'s own item records when every one resolves, and otherwise falls back to the amounts', () => {
    const kettle = order([[2999, 1], [450, 2]], { tax: 300 });
    expect(attributeOrderRefunds(kettle, { summaries: [usd(4000)], ledger: [],
      itemRecords: [{ money: usd(3230), lines: [{ lineOrdinal: 0, units: null }] }] }))
      .toMatchObject({ basis: 'partly', lines: [{ lineOrdinal: 0, units: 1 }], unattributedMinor: 770 });
    // A record of one filter of two, by its money.
    expect(attributeOrderRefunds(kettle, { summaries: [], ledger: [], itemRecords: [{ money: usd(485), lines: [{ lineOrdinal: 1, units: null }] }] }))
      .toMatchObject({ source: 'item-records', basis: 'item-records', lines: [{ lineOrdinal: 1, units: 1 }] });
    // A record without money accounts for its units' prices: the rest of the Refund Total stays at order level.
    expect(attributeOrderRefunds(order([[1000, 1], [2000, 1]]), { summaries: [usd(1500)], ledger: [],
      itemRecords: [{ money: null, lines: [{ lineOrdinal: 0, units: null }] }] }))
      .toMatchObject({ basis: 'partly', lines: [{ lineOrdinal: 0, units: 1 }], unattributedMinor: 500, unattributedReason: 'no-match' });
    // Two records of one unit each of a two-unit line: the same unit twice, or both? Unproven: neither resolves, and
    // their money counts for nothing.
    expect(attributeOrderRefunds(order([[1000, 2], [2000, 1]]), { summaries: [], ledger: [], itemRecords: [
      { money: usd(1000), lines: [{ lineOrdinal: 0, units: 1 }] }, { money: usd(1000), lines: [{ lineOrdinal: 0, units: 1 }] }] }))
      .toMatchObject({ refundMinor: 0, source: null, basis: null, lines: [],
        excluded: [{ source: 'item-records', reason: 'unresolved', count: 2 }] });
    // A record without money, on a taxed order: its units' tax share is theirs too, so nothing is left over.
    expect(attributeOrderRefunds(order([[1000, 1], [2000, 1]], { tax: 300 }), { summaries: [usd(1100)], ledger: [],
      itemRecords: [{ money: null, lines: [{ lineOrdinal: 0, units: 1 }] }] }))
      .toMatchObject({ basis: 'item-records', lines: [{ lineOrdinal: 0, units: 1 }], unattributedMinor: 0 });
    // And with more refunded than that: only what is beyond its price and its tax share stays at order level (15 − 11).
    expect(attributeOrderRefunds(order([[1000, 1], [2000, 1]], { tax: 300 }), { summaries: [usd(1500)], ledger: [],
      itemRecords: [{ money: null, lines: [{ lineOrdinal: 0, units: 1 }] }] }))
      .toMatchObject({ basis: 'partly', lines: [{ lineOrdinal: 0, units: 1 }], unattributedMinor: 400 });
    // Without a tax basis, a record without money can't conserve its tax: it is held, and its line still bounds the rest.
    const untaxed = order([[1000, 1], [2000, 1]], { tax: 300 });
    untaxed.summary = untaxed.summary!.filter(entry => entry.kind !== 'tax');
    expect(attributeOrderRefunds(untaxed, { summaries: [usd(1500)], ledger: [], itemRecords: [{ money: null, lines: [{ lineOrdinal: 0, units: 1 }] }] }))
      .toMatchObject({ basis: 'unattributed', unattributedMinor: 1500, excluded: [{ source: 'item-records', reason: 'unresolved', count: 1 }] });
    // More units than were ordered: contradictory, left out; the amount still ties the kettle.
    expect(attributeOrderRefunds(kettle, { summaries: [usd(3230)], ledger: [], itemRecords: [{ money: null, lines: [{ lineOrdinal: 0, units: 2 }] }] }))
      .toMatchObject({ basis: 'units', lines: [{ lineOrdinal: 0, units: 1 }], excluded: [{ source: 'item-records', reason: 'contradictory', count: 1 }] });
  });
});
