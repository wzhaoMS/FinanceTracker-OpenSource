import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { opaque } from './policy.js';
import { AMAZON_TAXONOMY_DIGEST } from './taxonomy.js';
import { amazonFresh, amazonFreshOrder, AMAZON_FRESH_MEASURE, MAX_FRESH_PURCHASES } from './fresh.js';
import {
  amazonDatabase, assignFreshHousehold, each, FRESH_HOUSEHOLD, freshDatabase, freshLine, freshOrderRef, seedFreshHousehold, seedFreshList,
  seedOrder, seedRefundTotal, usd, weighed,
} from './freshFixtures.testSupport.js';

// Entirely synthetic: made-up orders, products, ASINs, weights, prices and refunds (freshFixtures.testSupport.ts).
const TODAY = '2026-10-19';
const { PORK, EGGS, CHIPS, TOWELS, MYSTERY, BANANAS, YOGURT, BREAD } = FRESH_HOUSEHOLD;

function household() {
  const db = new Database(':memory:');
  freshDatabase(db);
  return { db, refs: seedFreshHousehold(db) };
}
const groceries = (db: Database.Database) => assignFreshHousehold(db);
const changes = (db: Database.Database) => ({ total: db.prepare('SELECT total_changes()').pluck().get(),
  objects: db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all() });

describe('Amazon Fresh read model', () => {
  it('counts each window\'s Fresh orders by their active list, by grocery subcategory, with refunds taken off', () => {
    const { db } = household();
    groceries(db);
    const view = amazonFresh(db, '60D', TODAY);
    expect(view.measure).toBe(AMAZON_FRESH_MEASURE);
    expect(view.window).toEqual({ key: '60D', from: '2026-08-21', to: TODAY });
    expect(view.captured).toBe(true);
    expect(view.taxonomy).toEqual({ version: 1, digest: AMAZON_TAXONOMY_DIGEST, assignments: 'present' });
    expect(view.orders).toEqual({ count: 3, withTotal: 3, complete: 2, reconciled: 2, refunded: 2, unreadable: 0, noLines: 0 });
    expect(view.lines).toEqual({ count: 10, priced: 9, noPrice: 0, missing: 1, substituted: 1, estimated: 1, categorized: 7,
      suggested: 1, needsReview: 2, refunded: 1, unreadable: 2 });
    // Lines: F1 2233, F2 124 + 349 + 319 (the missing line costs nothing), F5 450. The chips' refund is tied to them
    // (exactly their price, on a whole list); F2's ledger refund comes off the total only.
    expect(view.totals).toEqual([{ currency: 'USD', orderTotalMinor: 3783, lineMinor: 3475, groceryMinor: 2026,
      categorizedMinor: 2725, suggestedMinor: 235, needsReviewMinor: 750, refundMinor: 335, lineRefundMinor: 235,
      unattributedRefundMinor: 100, netLineMinor: 3140 }]);
    const row = (category: string, group: string, amountMinor: number, refundMinor: number, lines: number, products: number, orders: number) =>
      ({ currency: 'USD', category, group, amountMinor, refundMinor, netMinor: amountMinor - refundMinor, lines,
        refundedLines: refundMinor > 0 ? 1 : 0, products, orders });
    expect(view.categories).toEqual([
      row('groceries/dairy-eggs', 'groceries', 849, 0, 2, 2, 2),
      row('groceries/meat-seafood', 'groceries', 818, 0, 2, 1, 2),
      row('groceries/produce', 'groceries', 124, 0, 1, 1, 1),
      row('groceries/snacks-sweets', 'groceries', 235, 235, 1, 1, 1),
      row('household', 'other', 699, 0, 1, 1, 1),
      row('needs-review', 'needs-review', 750, 0, 2, 2, 2),
    ]);
    expect(view.products.map(p => [p.title, p.netMinor])).toEqual([[PORK.title, 818], [TOWELS.title, 699], [EGGS.title, 500],
      ['[redacted]', 450], [YOGURT.title, 349], [MYSTERY.title, 300], [BANANAS.title, 124], [CHIPS.title, 0]]);
    const pork = view.products[0];
    expect(pork).toMatchObject({ asin: PORK.asin, category: 'groceries/meat-seafood', group: 'groceries', node: 'groceries/meat-seafood',
      source: 'owner', confidence: 1, suggested: false, amountMinor: 818, refundMinor: 0, lines: 2, orders: 2, quantity: 2,
      weight: { value: '2.05', unit: 'lb', estimated: false }, lastUnitPrice: { money: usd(399), per: 'lb' },
      lastOrderDate: '2026-10-12', lastOrderRef: freshOrderRef('F1') });
    // Every purchase, latest first: its order date, weight or quantity, unit price and line price.
    expect(pork.purchases).toEqual([
      { ref: expect.stringMatching(/^amz-[a-f0-9]{48}$/), orderRef: freshOrderRef('F1'), orderDate: '2026-10-12', status: 'listed',
        quantity: 1, weight: { value: '1.25', unit: 'lb', basis: 'actual' }, unitPrice: { money: usd(399), per: 'lb' }, amountMinor: 499, refundMinor: 0 },
      { ref: expect.stringMatching(/^amz-[a-f0-9]{48}$/), orderRef: freshOrderRef('F2'), orderDate: '2026-09-20', status: 'listed',
        quantity: 1, weight: { value: '0.80', unit: 'lb', basis: 'actual' }, unitPrice: { money: usd(399), per: 'lb' }, amountMinor: 319, refundMinor: 0 },
    ]);
    // Household items bought on Fresh count under their own top level, filed precisely.
    expect(view.products.find(p => p.title === TOWELS.title)).toMatchObject({ category: 'household', group: 'other',
      node: 'household/paper-disposables', source: 'owner' });
    // An agent's assignment counts from 0.6, shown as suggested below 0.8; below 0.6 it waits in Needs review.
    expect(view.products.find(p => p.title === CHIPS.title)).toMatchObject({ category: 'groceries/snacks-sweets', source: 'agent',
      confidence: 0.7, suggested: true, amountMinor: 235, refundMinor: 235, netMinor: 0,
      purchases: [expect.objectContaining({ amountMinor: 235, refundMinor: 235, quantity: 1, unitPrice: { money: usd(235), per: 'each' } })] });
    expect(view.products.find(p => p.title === MYSTERY.title)).toMatchObject({ category: 'needs-review', group: 'needs-review',
      node: 'needs-review', source: null, suggested: false, suggestion: { node: 'groceries/snacks-sweets', confidence: 0.5 } });
    // The guard's title is never classified, whatever was assigned to its key.
    expect(view.products.find(p => p.title === '[redacted]')).toMatchObject({ category: 'needs-review', asin: null, source: null });
    expect(view.products.find(p => p.title === BANANAS.title)?.weight).toEqual({ value: '2.1', unit: 'lb', estimated: true });
    expect(view.products.find(p => p.title === YOGURT.title)?.purchases).toMatchObject([{ status: 'substituted', amountMinor: 349 }]);
    expect(view.orderList.map(o => [o.ref, o.date, o.complete, o.reconciled, o.lineTotal?.amountMinor, o.refund?.basis])).toEqual([
      [freshOrderRef('F1'), '2026-10-12', true, true, 2233, 'units'],
      [freshOrderRef('F2'), '2026-09-20', false, false, 792, 'unattributed'],
      [freshOrderRef('F5'), '2026-08-25', true, true, 450, undefined],
    ]);
    expect(view.orderList[0].refund).toEqual({ currency: 'USD', refundMinor: 235, basis: 'units', lineRefundMinor: 235, unattributedMinor: 0 });
    expect(view.orderList[1]).toEqual({ ref: freshOrderRef('F2'), date: '2026-09-20', total: usd(1100), lines: 4, priced: 3, missing: 1,
      substituted: 1, unreadable: 2, unreadRows: 1, lineTotal: usd(792), complete: false, reconciled: false,
      refund: { currency: 'USD', refundMinor: 100, basis: 'unattributed', lineRefundMinor: 0, unattributedMinor: 100 } });
    // Amazon's measure: no native order ID ever leaves.
    expect(JSON.stringify(view)).not.toContain('synthetic-fresh-F');
  });

  it('files every line under Needs review until a classification is imported, over the same totals', () => {
    const { db } = household();
    const view = amazonFresh(db, '60D', TODAY);
    expect(view.taxonomy.assignments).toBe('absent');
    expect(view.totals[0]).toMatchObject({ lineMinor: 3475, groceryMinor: 0, categorizedMinor: 0, suggestedMinor: 0,
      needsReviewMinor: 3475, refundMinor: 335, netLineMinor: 3140 });
    expect(view.categories).toEqual([{ currency: 'USD', category: 'needs-review', group: 'needs-review', amountMinor: 3475,
      refundMinor: 235, netMinor: 3240, lines: 9, refundedLines: 1, products: 8, orders: 3 }]);
    expect(view.lines).toMatchObject({ priced: 9, categorized: 0, suggested: 0, needsReview: 9 });
    expect(view.products.every(p => p.source === null && p.category === 'needs-review')).toBe(true);
  });

  it('reads 30D, YTD, 1Y and 2Y by Amazon\'s order date, inclusive, each currency apart', () => {
    const { db } = household();
    groceries(db);
    const counts = (window: Parameters<typeof amazonFresh>[1]) => {
      const view = amazonFresh(db, window, TODAY);
      return { orders: view.orderList.map(o => o.date), totals: view.totals.map(t => [t.currency, t.lineMinor]) };
    };
    expect(counts('30D')).toEqual({ orders: ['2026-10-12', '2026-09-20'], totals: [['USD', 3025]] });
    expect(counts('YTD')).toEqual({ orders: ['2026-10-12', '2026-09-20', '2026-08-25'], totals: [['USD', 3475]] });
    expect(counts('1Y')).toEqual({ orders: ['2026-10-12', '2026-09-20', '2026-08-25', '2025-12-01'],
      totals: [['EUR', 1500], ['USD', 3475]] });
    expect(counts('2Y')).toEqual(counts('1Y'));
    const year = amazonFresh(db, '1Y', TODAY);
    expect(year.categories.filter(c => c.currency === 'EUR')).toEqual([{ currency: 'EUR', category: 'groceries/dairy-eggs',
      group: 'groceries', amountMinor: 1500, refundMinor: 0, netMinor: 1500, lines: 1, refundedLines: 0, products: 1, orders: 1 }]);
    expect(year.products.filter(p => p.title === EGGS.title).map(p => p.currency)).toEqual(['USD']);
    // A window before any Fresh order is empty, still captured.
    const before = amazonFresh(db, '30D', '2024-01-31');
    expect(before).toMatchObject({ captured: true, orders: { count: 0 }, totals: [], categories: [], products: [], orderList: [] });
  });

  it('serves one order\'s active list, every line as it showed it, with its category and refund', () => {
    const { db, refs } = household();
    groceries(db);
    const f1 = amazonFreshOrder(db, refs.f1)!;
    expect(f1).toMatchObject({ ref: refs.f1, date: '2026-10-12', total: usd(2233),
      refund: { currency: 'USD', refundMinor: 235, basis: 'units', lineRefundMinor: 235, unattributedMinor: 0 },
      list: { statedCount: 5, rows: 5, unreadRows: 0, lines: 5, unreadable: 0, complete: true, reconciled: true } });
    expect(f1.lines.map(l => [l.title, l.linePrice?.amountMinor, l.category, l.refundMinor])).toEqual([
      [PORK.title, 499, 'groceries/meat-seafood', 0], [EGGS.title, 500, 'groceries/dairy-eggs', 0],
      [CHIPS.title, 235, 'groceries/snacks-sweets', 235], [TOWELS.title, 699, 'household', 0], [MYSTERY.title, 300, 'needs-review', 0]]);
    expect(f1.lines[0]).toEqual({ ref: expect.stringMatching(/^amz-[a-f0-9]{48}$/), lineOrdinal: 0, title: PORK.title, asin: PORK.asin,
      status: 'listed', quantity: 1, weight: { value: '1.25', unit: 'lb', basis: 'actual' }, unitPrice: { money: usd(399), per: 'lb' },
      linePrice: usd(499), replaces: null, category: 'groceries/meat-seafood', group: 'groceries', node: 'groceries/meat-seafood',
      source: 'owner', confidence: 1, suggested: false, suggestion: null, refundMinor: 0 });
    const f2 = amazonFreshOrder(db, refs.f2)!;
    expect(f2.list).toEqual({ statedCount: 7, rows: 7, unreadRows: 1, lines: 4, unreadable: 2, complete: false, reconciled: false });
    expect(f2.refund).toEqual({ currency: 'USD', refundMinor: 100, basis: 'unattributed', lineRefundMinor: 0, unattributedMinor: 100 });
    expect(f2.lines.map(l => [l.status, l.replaces, l.linePrice?.amountMinor ?? null])).toEqual([['listed', null, 124],
      ['substituted', 'Synthetic Plain Yogurt', 349], ['missing', null, null], ['listed', null, 319]]);
    // The active list only, and a title the guard hides stays hidden.
    expect(amazonFreshOrder(db, refs.f5)!.lines.map(l => l.title)).toEqual(['[redacted]']);
    expect(amazonFreshOrder(db, opaque('order', 'synthetic-unknown'))).toBeNull();
    expect(JSON.stringify(f1)).not.toContain('synthetic-fresh-F');
  });

  it('takes a whole-order refund off every line, and never more than an order\'s lines still cost', () => {
    const db = new Database(':memory:');
    freshDatabase(db);
    // Amazon's Refund Total equal to the grand total: every line came back, delivery and tax included.
    const whole = seedOrder(db, 'W1', '2026-10-02', usd(1080), 1000, 80);
    seedFreshList(db, whole, [freshLine(EGGS.title, { asin: EGGS.asin, ...each(2, 300) }),
      freshLine(PORK.title, { asin: PORK.asin, quantity: 1, ...weighed('1.00', 400, 400) })]);
    seedRefundTotal(db, 'W1', usd(1080));
    // Delivery and a tip make the total larger than the lines; a Refund Total no rule ties stops at the lines' price.
    const capped = seedOrder(db, 'G1', '2026-10-01', usd(1000), 450);
    seedFreshList(db, capped, [freshLine(EGGS.title, { asin: EGGS.asin, quantity: 1, linePrice: usd(200) }),
      freshLine(BREAD.title, { asin: BREAD.asin, quantity: 1, linePrice: usd(250) })]);
    seedRefundTotal(db, 'G1', usd(800));
    const view = amazonFresh(db, '30D', TODAY);
    expect(view.totals[0]).toMatchObject({ lineMinor: 1450, refundMinor: 1880, lineRefundMinor: 1000, unattributedRefundMinor: 450,
      netLineMinor: 0 });
    expect(view.orderList.map(o => o.refund)).toEqual([
      { currency: 'USD', refundMinor: 1080, basis: 'whole-order', lineRefundMinor: 1000, unattributedMinor: 0 },
      { currency: 'USD', refundMinor: 800, basis: 'unattributed', lineRefundMinor: 0, unattributedMinor: 450 },
    ]);
    expect(view.categories).toEqual([{ currency: 'USD', category: 'needs-review', group: 'needs-review', amountMinor: 1450,
      refundMinor: 1000, netMinor: 450, lines: 4, refundedLines: 2, products: 3, orders: 2 }]);
    expect(amazonFreshOrder(db, whole)!.lines.map(l => l.refundMinor)).toEqual([600, 400]);
    expect(amazonFreshOrder(db, capped)!.refund).toMatchObject({ refundMinor: 800, unattributedMinor: 450 });
  });

  it('never charges or refunds a missing line, even one whose list shows the price it was listed at', () => {
    const db = new Database(':memory:');
    freshDatabase(db);
    const ref = seedOrder(db, 'M1', '2026-10-03', usd(500), 500);
    seedFreshList(db, ref, [freshLine(EGGS.title, { asin: EGGS.asin, ...each(1, 500) }),
      freshLine(BREAD.title, { asin: BREAD.asin, status: 'missing', ...each(1, 400) })]);
    seedRefundTotal(db, 'M1', usd(500));
    const view = amazonFresh(db, '30D', TODAY);
    expect(view.lines).toMatchObject({ count: 2, priced: 1, missing: 1, refunded: 1 });
    expect(view.totals[0]).toMatchObject({ lineMinor: 500, refundMinor: 500, lineRefundMinor: 500, unattributedRefundMinor: 0, netLineMinor: 0 });
    expect(view.orderList[0]).toMatchObject({ lines: 2, priced: 1, missing: 1, lineTotal: usd(500), complete: true, reconciled: true,
      refund: { refundMinor: 500, basis: 'whole-order', lineRefundMinor: 500, unattributedMinor: 0 } });
    expect(view.products.map(p => p.title)).toEqual([EGGS.title]);
    expect(amazonFreshOrder(db, ref)!.lines.map(l => [l.status, l.linePrice, l.refundMinor])).toEqual([['listed', usd(500), 500],
      ['missing', usd(400), 0]]);
  });

  it('takes a whole-order refund off every priced line, past the 100th too', () => {
    const db = new Database(':memory:');
    freshDatabase(db);
    // A list longer than the 100 item ordinals an ordinary order has: the shared rule names only those.
    const ref = seedOrder(db, 'L1', '2026-10-04', usd(10100), 10100);
    seedFreshList(db, ref, Array.from({ length: 101 }, (_, n) => freshLine(`Synthetic Pantry Item ${n + 1}`, each(1, 100))));
    seedRefundTotal(db, 'L1', usd(10100));
    const view = amazonFresh(db, '30D', TODAY);
    expect(view.totals[0]).toMatchObject({ lineMinor: 10100, refundMinor: 10100, lineRefundMinor: 10100, unattributedRefundMinor: 0,
      netLineMinor: 0 });
    expect(view.orderList[0].refund).toEqual({ currency: 'USD', refundMinor: 10100, basis: 'whole-order', lineRefundMinor: 10100,
      unattributedMinor: 0 });
    expect(view.lines.refunded).toBe(101);
    expect(view.products.every(p => p.refundMinor === 100 && p.netMinor === 0)).toBe(true);
    expect(amazonFreshOrder(db, ref)!.lines.map(l => l.refundMinor)).toEqual(Array(101).fill(100));
  });

  it('counts an order whose list record can\'t be read, and never trusts its lines as proven', () => {
    const { db, refs } = household();
    db.prepare('UPDATE amazon_fresh_lists SET data_json=? WHERE order_ref=?').run('{"synthetic":"unreadable"}', refs.f1);
    const view = amazonFresh(db, '60D', TODAY);
    expect(view.orders).toMatchObject({ count: 3, unreadable: 1, complete: 1, reconciled: 1 });
    expect(view.orderList[0]).toMatchObject({ ref: refs.f1, complete: false, reconciled: false, unreadRows: null, lineTotal: usd(2233) });
    // The chips can't be told apart without a proven list: the Refund Total stays off the total only.
    expect(view.orderList[0].refund).toMatchObject({ refundMinor: 235, basis: 'unattributed', unattributedMinor: 235 });
    expect(amazonFreshOrder(db, refs.f1)!.list).toMatchObject({ statedCount: null, rows: null, unreadRows: null, lines: 5, complete: false });
  });

  it('shows an order whose list has no readable line, its items not captured', () => {
    const db = new Database(':memory:');
    freshDatabase(db);
    const ref = seedOrder(db, 'N1', '2026-10-10', usd(3100), 3000, 100);
    seedFreshList(db, ref, [{ raw: { synthetic: 'unreadable' } }], { unreadRows: 2 });
    const view = amazonFresh(db, '30D', TODAY);
    expect(view.orders).toEqual({ count: 1, withTotal: 1, complete: 0, reconciled: 0, refunded: 0, unreadable: 0, noLines: 1 });
    expect(view.totals).toEqual([{ currency: 'USD', orderTotalMinor: 3100, lineMinor: 0, groceryMinor: 0, categorizedMinor: 0,
      suggestedMinor: 0, needsReviewMinor: 0, refundMinor: 0, lineRefundMinor: 0, unattributedRefundMinor: 0, netLineMinor: 0 }]);
    expect(view.orderList).toEqual([{ ref, date: '2026-10-10', total: usd(3100), lines: 0, priced: 0, missing: 0, substituted: 0,
      unreadable: 1, unreadRows: 2, lineTotal: null, complete: false, reconciled: false, refund: null }]);
    expect(view.categories).toEqual([]);
  });

  it('lists each product\'s latest purchases only, while its totals count them all', () => {
    const db = new Database(':memory:');
    freshDatabase(db);
    const n = MAX_FRESH_PURCHASES + 2;
    for (let i = 0; i < n; i++) {
      const day = `2026-10-${String(1 + (i % 18)).padStart(2, '0')}`;
      const ref = seedOrder(db, `P${i}`, day, usd(100), 100);
      seedFreshList(db, ref, [freshLine(EGGS.title, { asin: EGGS.asin, ...each(1, 100) })]);
    }
    const [eggs] = amazonFresh(db, '30D', TODAY).products;
    expect(eggs).toMatchObject({ lines: n, orders: n, quantity: n, amountMinor: 100 * n });
    expect(eggs.purchases).toHaveLength(MAX_FRESH_PURCHASES);
    expect(eggs.purchases[0].orderDate >= eggs.purchases[MAX_FRESH_PURCHASES - 1].orderDate).toBe(true);
  });

  it('reads without the Fresh tables (or any Amazon table) as never captured, and writes nothing', () => {
    const empty = new Database(':memory:');
    const before = changes(empty);
    expect(amazonFresh(empty, '30D', TODAY)).toMatchObject({ captured: false, taxonomy: { assignments: 'absent' },
      orders: { count: 0 }, totals: [], orderList: [] });
    expect(amazonFreshOrder(empty, freshOrderRef('F1'))).toBeNull();
    expect(changes(empty)).toEqual(before);
    const amazonOnly = new Database(':memory:');
    amazonDatabase(amazonOnly);
    const untouched = changes(amazonOnly);
    expect(amazonFresh(amazonOnly, '2Y', TODAY)).toEqual({ measure: AMAZON_FRESH_MEASURE, window: { key: '2Y', from: '2024-10-20', to: TODAY },
      captured: false, taxonomy: { version: 1, digest: AMAZON_TAXONOMY_DIGEST, assignments: 'absent' },
      orders: { count: 0, withTotal: 0, complete: 0, reconciled: 0, refunded: 0, unreadable: 0, noLines: 0 },
      lines: { count: 0, priced: 0, noPrice: 0, missing: 0, substituted: 0, estimated: 0, categorized: 0, suggested: 0, needsReview: 0,
        refunded: 0, unreadable: 0 },
      totals: [], categories: [], products: [], orderList: [] });
    expect(amazonFreshOrder(amazonOnly, freshOrderRef('F1'))).toBeNull();
    expect(changes(amazonOnly)).toEqual(untouched);
    expect(amazonOnly.prepare("SELECT count(*) FROM sqlite_master WHERE name LIKE 'amazon_fresh%'").pluck().get()).toBe(0);
  });

  it('reads the Fresh tables and the taxonomy without writing anything', () => {
    const { db, refs } = household();
    groceries(db);
    const before = changes(db);
    for (const window of ['30D', '60D', 'YTD', '1Y', '2Y'] as const) amazonFresh(db, window, TODAY);
    for (const ref of Object.values(refs)) amazonFreshOrder(db, ref);
    expect(changes(db)).toEqual(before);
  });
});
