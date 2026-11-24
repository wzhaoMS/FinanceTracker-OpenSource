import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { AMAZON_TAXONOMY_NODES } from '@finance-tracker/shared';
import { ensureAmazonSchema } from './schema.js';
import { digest, opaque, SOURCE } from './policy.js';
import { productKey } from './products.js';
import { amazonSpending, AMAZON_SPENDING_MEASURE } from './spending.js';
import { AMAZON_TAXONOMY_DIGEST, installAmazonTaxonomySchema } from './taxonomy.js';
import { amazonTaxonomySpending, MAX_PRODUCT_PURCHASES } from './taxonomySpending.js';
import type { ItemObservation, Money } from './types.js';

// Entirely synthetic: made-up order IDs, titles, ASINs, categories and amounts.
const TODAY = '2026-10-19';
const usd = (amountMinor: number): Money => ({ currency: 'USD', amountMinor });
const PORK = { asin: 'SYNTHPORK1', title: 'Synthetic Pork Belly, 2 lb' };
const EGGS = { asin: 'SYNTHEGGS1', title: 'Synthetic Large Eggs, 12 count' };
const CHIPS = { asin: 'SYNTHCHIP1', title: 'Synthetic Sea Salt Chips' };
const ROUTER = { asin: 'SYNTHNET01', title: 'Synthetic Mesh Router Model R-1' };
const TOWELS = { asin: null, title: 'Synthetic Paper Towels, 6 rolls' };
const MYSTERY = { asin: 'SYNTHMYST1', title: 'Synthetic Mystery Gadget' };
const HELD = { asin: 'SYNTHHELD1', title: 'Synthetic 4111111111111111' };
type Product = { asin: string | null; title: string };
type Line = Omit<ItemObservation, 'lineOrdinal'>;
const line = (p: Product, quantity: number | null, unitPrice: Money | null): Line => ({ itemId: p.asin, title: p.title, quantity, unitPrice });

function household() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE card_accounts(id,issuer,owner,last4,currency,status);
    CREATE TABLE card_transactions(id,card_account_id,transaction_date,status,kind,currency,amount_minor,
    user_category,issuer_category,dismissed_at,removed_at,merged_into_id,description);`);
  db.prepare('INSERT INTO card_transactions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('synthetic-row', 'synthetic-card', '2026-09-01',
    'posted', 'purchase', 'USD', 500, null, 'Synthetic Groceries', null, null, null, 'SYNTHETIC STORE');
  ensureAmazonSchema(db);
  db.prepare('INSERT INTO amazon_sources VALUES(?)').run(SOURCE);
  db.prepare('INSERT INTO amazon_captures VALUES(?,?,?,?,?,?,?,?,?)').run('capture', SOURCE, 3, '2024-10-01', TODAY, '{}', '{}', TODAY, '{}');
  const orderRef = (name: string) => opaque('order', `synthetic-order-${name}`);
  const lineRef = (name: string, ordinal: number) => opaque('line-observation', ['capture', `synthetic-order-${name}`, ordinal]);
  const stored = new Map<string, Record<string, unknown>>();
  /** `proven`: the capture's positive item proof, with Amazon's item subtotal (the lines' own sum) and no tax. */
  const order = (name: string, date: string, total: Money | null, lines: Line[], proven = false) => {
    const items = lines.map((item, lineOrdinal) => ({ lineOrdinal, ...item }));
    const sum = lines.reduce((n, item) => n + (item.quantity ?? 0) * (item.unitPrice?.amountMinor ?? 0), 0);
    const data = { orderId: `synthetic-order-${name}`, date, total, items, ...(proven ? {
      itemProof: { complete: true, unknownLine: false, conflict: false },
      summary: [{ kind: 'items-subtotal', money: usd(sum) }, { kind: 'tax', money: usd(0) }] } : {}) };
    stored.set(name, data);
    db.prepare('INSERT INTO amazon_orders VALUES(?,?,?,?,?,NULL)').run(orderRef(name), SOURCE, `synthetic-order-${name}`, 'capture',
      JSON.stringify(data));
    items.forEach((item) => db.prepare('INSERT INTO amazon_items VALUES(?,?,?,?)').run(lineRef(name, item.lineOrdinal), orderRef(name),
      `capture:${item.lineOrdinal}`, JSON.stringify(item)));
  };
  let ordinal = 0;
  const observe = (family: 'order' | 'refund', orderName: string | null, data: unknown) => {
    const n = ordinal++;
    db.prepare('INSERT INTO amazon_observations VALUES(?,?,?,?,?,?,?)').run(opaque('observation', ['capture', family, n]), 'capture',
      family, n, orderName === null ? null : orderRef(orderName), 'synthetic-hold', JSON.stringify(data));
  };
  order('A', '2026-10-12', usd(3145), [line(PORK, 2, usd(899)), line(EGGS, 1, usd(450)), line(CHIPS, 3, usd(299))], true);
  order('B', '2026-09-25', usd(14898), [line(ROUTER, 1, usd(12999)), line(TOWELS, 1, usd(1899))], true);
  order('C', '2026-08-30', usd(4500), [line(PORK, 1, usd(949)), line(MYSTERY, 1, usd(2500)), line(HELD, 1, usd(700)),
    line(EGGS, 1, null), line(CHIPS, null, usd(299))]);
  order('D', '2025-12-01', { currency: 'EUR', amountMinor: 2000 }, [line({ asin: null, title: 'Synthetic euro item' }, 2, { currency: 'EUR', amountMinor: 1000 })]);
  // Out of every window: the day after today.
  order('E', '2026-10-20', usd(999), [line(PORK, 1, usd(999))]);
  // Order B's Refund Total is exactly the router's price: its units. Order C's ledger refund can't be tied to an item
  // (its item list isn't proven): off the total only.
  observe('order', 'B', { ...stored.get('B'), refundSummary: usd(12999) });
  observe('refund', null, { date: '2026-09-05', money: usd(-2500), kind: 'refund', status: 'completed',
    method: { kind: 'card', network: 'visa', last4: '9001' }, orderIds: ['synthetic-order-C'], identity: 'native-row',
    provenance: { source: 'ledger', status: 'Refunded', page: 0, ordinal: 0 } });
  // The agent's card category for the pork, and the owner's for the towels' line: shown as the order shows them.
  db.prepare("INSERT INTO amazon_agent_categories VALUES(?,?,?,'agent','categorized from product title')")
    .run(productKey(PORK), 'Synthetic Groceries', 0.9);
  db.prepare('INSERT INTO amazon_item_overrides VALUES(?,?)').run(lineRef('B', 1), 'Synthetic Household');
  const assign = (rows: Array<[Product, 'agent' | 'owner', string, number]>) => db.transaction(() => {
    installAmazonTaxonomySchema(db);
    for (const [p, source, node, confidence] of rows) {
      db.prepare('INSERT INTO amazon_product_taxonomy VALUES(?,?,?,?,1,?)').run(productKey(p), source, node, confidence, digest('synthetic mapping'));
    }
  })();
  return { db, orderRef, lineRef, assign };
}

describe('Amazon spending by item taxonomy', () => {
  it('files every priced item under Needs review until assignments exist, over the same lines and refunds as by category', () => {
    const { db } = household();
    const view = amazonTaxonomySpending(db, '60D', TODAY);
    expect(view.measure).toBe(AMAZON_SPENDING_MEASURE);
    expect(view.window).toEqual({ key: '60D', from: '2026-08-21', to: TODAY });
    expect(view.taxonomy).toEqual({ version: 1, digest: AMAZON_TAXONOMY_DIGEST, assignments: 'absent' });
    expect(view.orders).toEqual({ count: 3, refunded: 2 });
    expect(view.lines).toEqual({ count: 10, priced: 8, noPrice: 1, noQuantity: 1, assigned: 0, suggested: 0, needsReview: 8 });
    // The very figures GET /amazon/spending gives, gross, refunds and net: only where items are filed differs.
    const [byCategory] = amazonSpending(db, '60D', TODAY).totals;
    expect(view.totals).toEqual([{ currency: 'USD', itemMinor: byCategory.itemMinor, assignedMinor: 0, suggestedMinor: 0,
      needsReviewMinor: byCategory.itemMinor, refundMinor: byCategory.refundMinor, itemRefundMinor: byCategory.itemRefundMinor,
      unattributedRefundMinor: byCategory.unattributedRefundMinor, netItemMinor: byCategory.netItemMinor }]);
    expect(view.totals[0]).toMatchObject({ itemMinor: 22192, refundMinor: 15499, itemRefundMinor: 12999, unattributedRefundMinor: 2500,
      netItemMinor: 6693 });
    expect(view.nodes).toEqual([{ currency: 'USD', node: 'needs-review', amountMinor: 22192, refundMinor: 12999, netMinor: 9193,
      lines: 8, refundedLines: 1, products: 7, orders: 3, refundedOrders: 2 }]);
    expect(view.products.every(p => p.node === 'needs-review' && p.source === null && p.suggestion === null)).toBe(true);
  });

  it('drills from top level to subcategory to item: the owner\'s choice wins, a weak agent guess waits in Needs review', () => {
    const { db, orderRef, lineRef, assign } = household();
    assign([[PORK, 'agent', 'groceries/meat-seafood', 0.95], [EGGS, 'agent', 'groceries/dairy-eggs', 0.7],
      [CHIPS, 'agent', 'groceries/pantry-cooking', 0.85], [CHIPS, 'owner', 'groceries/snacks-sweets', 1],
      [ROUTER, 'agent', 'electronics/networking', 0.99], [TOWELS, 'agent', 'household', 0.8],
      [MYSTERY, 'agent', 'toys-hobbies/rc-drones', 0.55],
      // A held title is never classified, even when a row names its key.
      [HELD, 'owner', 'electronics', 1]]);
    const view = amazonTaxonomySpending(db, '60D', TODAY);
    expect(view.taxonomy.assignments).toBe('present');
    expect(view.lines).toEqual({ count: 10, priced: 8, noPrice: 1, noQuantity: 1, assigned: 6, suggested: 1, needsReview: 2 });
    expect(view.totals).toEqual([{ currency: 'USD', itemMinor: 22192, assignedMinor: 18992, suggestedMinor: 450, needsReviewMinor: 3200,
      refundMinor: 15499, itemRefundMinor: 12999, unattributedRefundMinor: 2500, netItemMinor: 6693 }]);
    // Top levels include their subcategories and their own items; largest net first. The router came back whole.
    expect(view.nodes).toEqual([
      { currency: 'USD', node: 'groceries', amountMinor: 4094, refundMinor: 0, netMinor: 4094, lines: 4, refundedLines: 0, products: 3,
        orders: 2, refundedOrders: 1 },
      { currency: 'USD', node: 'needs-review', amountMinor: 3200, refundMinor: 0, netMinor: 3200, lines: 2, refundedLines: 0, products: 2,
        orders: 1, refundedOrders: 1 },
      { currency: 'USD', node: 'groceries/meat-seafood', amountMinor: 2747, refundMinor: 0, netMinor: 2747, lines: 2, refundedLines: 0,
        products: 1, orders: 2, refundedOrders: 1 },
      { currency: 'USD', node: 'household', amountMinor: 1899, refundMinor: 0, netMinor: 1899, lines: 1, refundedLines: 0, products: 1,
        orders: 1, refundedOrders: 1 },
      { currency: 'USD', node: 'groceries/snacks-sweets', amountMinor: 897, refundMinor: 0, netMinor: 897, lines: 1, refundedLines: 0,
        products: 1, orders: 1, refundedOrders: 0 },
      { currency: 'USD', node: 'groceries/dairy-eggs', amountMinor: 450, refundMinor: 0, netMinor: 450, lines: 1, refundedLines: 0,
        products: 1, orders: 1, refundedOrders: 0 },
      { currency: 'USD', node: 'electronics', amountMinor: 12999, refundMinor: 12999, netMinor: 0, lines: 1, refundedLines: 1, products: 1,
        orders: 1, refundedOrders: 1 },
      { currency: 'USD', node: 'electronics/networking', amountMinor: 12999, refundMinor: 12999, netMinor: 0, lines: 1, refundedLines: 1,
        products: 1, orders: 1, refundedOrders: 1 },
    ]);
    const pork = view.products.find(p => p.asin === PORK.asin)!;
    expect(pork).toEqual({ ref: lineRef('A', 0), currency: 'USD', title: PORK.title, asin: PORK.asin, node: 'groceries/meat-seafood',
      source: 'agent', confidence: 0.95, suggested: false, suggestion: null, cardCategory: 'Synthetic Groceries',
      cardCategorySource: 'agent-classification', quantity: 3, refundedQuantity: 0, lines: 2, orders: 2, refundedOrders: 1,
      amountMinor: 2747, refundMinor: 0, netMinor: 2747, lastOrderDate: '2026-10-12', lastOrderRef: orderRef('A'),
      purchases: [
        { ref: lineRef('A', 0), orderRef: orderRef('A'), orderDate: '2026-10-12', quantity: 2, unitPriceMinor: 899, amountMinor: 1798,
          refundMinor: 0, refundedQuantity: 0, orderRefunded: false },
        // Order C has a refund, but it isn't tied to the pork.
        { ref: lineRef('C', 0), orderRef: orderRef('C'), orderDate: '2026-08-30', quantity: 1, unitPriceMinor: 949, amountMinor: 949,
          refundMinor: 0, refundedQuantity: 0, orderRefunded: true },
      ] });
    // The router's refund is its own, as by category: its price off it and its node.
    const router = view.products.find(p => p.asin === ROUTER.asin)!;
    expect(router).toMatchObject({ amountMinor: 12999, refundMinor: 12999, netMinor: 0, refundedQuantity: 1, suggested: false });
    expect(router.purchases).toEqual([expect.objectContaining({ refundMinor: 12999, refundedQuantity: 1, orderRefunded: true })]);
    expect(amazonSpending(db, '60D', TODAY).products.find(p => p.asin === ROUTER.asin)).toMatchObject({ refundMinor: 12999, netMinor: 0 });
    // Largest net first: the refunded router last.
    expect(view.products.at(-1)?.asin).toBe(ROUTER.asin);
    // A weak but usable agent guess counts, marked suggested; the owner's choice is never suggested.
    expect(view.products.find(p => p.asin === EGGS.asin)).toMatchObject({ node: 'groceries/dairy-eggs', source: 'agent', confidence: 0.7,
      suggested: true, suggestion: null });
    expect(view.products.find(p => p.asin === CHIPS.asin)).toMatchObject({ node: 'groceries/snacks-sweets', source: 'owner', confidence: 1,
      suggested: false, cardCategory: null, cardCategorySource: null, quantity: 3, lines: 1 });
    expect(view.products.find(p => p.title === TOWELS.title)).toMatchObject({ node: 'household', source: 'agent', confidence: 0.8,
      cardCategory: 'Synthetic Household', cardCategorySource: 'item-override' });
    // Needs review says exactly what each item is, with the agent's suggestion when it had one.
    expect(view.products.filter(p => p.node === 'needs-review').map(p => [p.title, p.asin, p.source, p.suggestion])).toEqual([
      [MYSTERY.title, MYSTERY.asin, null, { node: 'toys-hobbies/rc-drones', confidence: 0.55 }],
      ['[redacted]', HELD.asin, null, null],
    ]);
    expect(JSON.stringify(view)).not.toContain(HELD.title);
    // Every listed amount adds up: each node's products, and each top level's subcategories and own items.
    for (const node of view.nodes) {
      const own = view.products.filter(p => p.node === node.node || AMAZON_TAXONOMY_NODES.find(n => n.id === p.node)?.parent === node.node);
      expect(own.reduce((sum, p) => sum + p.amountMinor, 0), node.node).toBe(node.amountMinor);
      expect(own.reduce((sum, p) => sum + p.refundMinor, 0), node.node).toBe(node.refundMinor);
    }
  });

  it('counts an item the agent itself said needs review in Needs review, filed by the agent', () => {
    const { db, assign } = household();
    assign([[MYSTERY, 'agent', 'needs-review', 0.9]]);
    const view = amazonTaxonomySpending(db, '60D', TODAY);
    expect(view.products.find(p => p.asin === MYSTERY.asin)).toMatchObject({ node: 'needs-review', source: 'agent', confidence: 0.9,
      suggested: false, suggestion: null });
    expect(view.totals[0].needsReviewMinor).toBe(view.nodes.find(n => n.node === 'needs-review')!.amountMinor);
    expect(view.lines.needsReview).toBe(view.lines.priced);
  });

  it.each([0.6, 0.7, 0.799])('keeps an agent\'s own Needs review at %s out of the assigned and suggested counts (review regression)', confidence => {
    const { db, assign } = household();
    assign([[MYSTERY, 'agent', 'needs-review', confidence], [EGGS, 'agent', 'groceries/dairy-eggs', 0.7]]);
    const view = amazonTaxonomySpending(db, '60D', TODAY);
    expect(view.products.find(p => p.asin === MYSTERY.asin)).toMatchObject({ node: 'needs-review', source: 'agent', confidence,
      suggested: false, suggestion: null });
    // Only the eggs are classified, and only they are suggested; the mystery item counts in Needs review alone.
    expect(view.lines).toEqual({ count: 10, priced: 8, noPrice: 1, noQuantity: 1, assigned: 1, suggested: 1, needsReview: 7 });
    expect(view.totals[0]).toMatchObject({ itemMinor: 22192, assignedMinor: 450, suggestedMinor: 450, needsReviewMinor: 21742 });
    expect(view.lines.assigned + view.lines.needsReview).toBe(view.lines.priced);
    expect(view.totals[0].assignedMinor + view.totals[0].needsReviewMinor).toBe(view.totals[0].itemMinor);
  });

  it('keeps currencies apart, and reads nothing without the Amazon schema', () => {
    const { db, assign } = household();
    assign([]);
    const twoYears = amazonTaxonomySpending(db, '2Y', TODAY);
    expect(twoYears.totals.map(t => t.currency)).toEqual(['EUR', 'USD']);
    expect(twoYears.nodes.find(n => n.currency === 'EUR')).toEqual({ currency: 'EUR', node: 'needs-review', amountMinor: 2000, refundMinor: 0,
      netMinor: 2000, lines: 1, refundedLines: 0, products: 1, orders: 1, refundedOrders: 0 });
    expect(amazonTaxonomySpending(db, '30D', TODAY).orders.count).toBe(2);
    const empty = amazonTaxonomySpending(new Database(':memory:'), 'YTD', TODAY);
    expect(empty).toMatchObject({ window: { key: 'YTD', from: '2026-01-01', to: TODAY }, orders: { count: 0, refunded: 0 },
      totals: [], nodes: [], products: [], taxonomy: { assignments: 'absent' } });
  });

  it('never shows a suggested assignment under a surer one: two titles of one ASIN assigned differently stay two items (review regression)', () => {
    const { db, orderRef, lineRef, assign } = household();
    // The same router ASIN, renamed in a later order: two product keys, the newer one classified with less confidence.
    const RENAMED = { asin: ROUTER.asin, title: 'Synthetic Mesh Router Model R-1, updated name' };
    db.prepare('INSERT INTO amazon_orders VALUES(?,?,?,?,?,NULL)').run(orderRef('R'), SOURCE, 'synthetic-order-R', 'capture',
      JSON.stringify({ orderId: 'synthetic-order-R', date: '2026-10-15', total: usd(3000), items: [{ lineOrdinal: 0, ...line(RENAMED, 1, usd(3000)) }] }));
    db.prepare('INSERT INTO amazon_items VALUES(?,?,?,?)').run(lineRef('R', 0), orderRef('R'), 'capture:0',
      JSON.stringify({ lineOrdinal: 0, ...line(RENAMED, 1, usd(3000)) }));
    assign([[ROUTER, 'agent', 'electronics/networking', 0.95], [RENAMED, 'agent', 'electronics/networking', 0.7]]);
    const view = amazonTaxonomySpending(db, '60D', TODAY);
    const routers = view.products.filter(p => p.asin === ROUTER.asin);
    expect(routers.map(p => [p.title, p.confidence, p.suggested, p.amountMinor])).toEqual([
      [RENAMED.title, 0.7, true, 3000],
      [ROUTER.title, 0.95, false, 12999],
    ]);
    expect(view.nodes.find(n => n.node === 'electronics/networking')).toMatchObject({ amountMinor: 15999, lines: 2, products: 2 });
    // Every listed item's Suggested state is its own lines', and they add up to the window's suggested count.
    for (const product of view.products) {
      expect(product.suggested, product.title).toBe(product.source === 'agent' && product.node !== 'needs-review'
        && product.confidence !== null && product.confidence >= 0.6 && product.confidence < 0.8);
    }
    const suggested = view.products.filter(p => p.suggested);
    expect(suggested.reduce((n, p) => n + p.lines, 0)).toBe(view.lines.suggested);
    expect(suggested.reduce((n, p) => n + p.amountMinor, 0)).toBe(view.totals.find(t => t.currency === 'USD')!.suggestedMinor);
  });

  it('caps each item\'s purchases, latest first, still counting them all', () => {
    const { db } = household();
    for (let n = 0; n < MAX_PRODUCT_PURCHASES + 5; n++) {
      const name = `bulk-${n}`, ref = opaque('order', `synthetic-order-${name}`);
      db.prepare('INSERT INTO amazon_orders VALUES(?,?,?,?,?,NULL)').run(ref, SOURCE, `synthetic-order-${name}`, 'capture',
        JSON.stringify({ orderId: `synthetic-order-${name}`, date: '2026-10-01', total: null, items: [] }));
      db.prepare('INSERT INTO amazon_items VALUES(?,?,?,?)').run(opaque('line', name), ref, 'capture:0',
        JSON.stringify({ lineOrdinal: 0, ...line(EGGS, 1, usd(100)) }));
    }
    const eggs = amazonTaxonomySpending(db, '30D', TODAY).products.find(p => p.asin === EGGS.asin)!;
    expect(eggs.lines).toBe(MAX_PRODUCT_PURCHASES + 6);
    expect(eggs.purchases).toHaveLength(MAX_PRODUCT_PURCHASES);
    expect(eggs.purchases[0].orderDate).toBe('2026-10-12');
  });
});
