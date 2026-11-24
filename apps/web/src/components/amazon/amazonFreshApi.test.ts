import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AmazonAnswerError } from './amazonApi';
import { AMAZON_FRESH_MEASURE, parseAmazonFresh, parseAmazonFreshOrder } from './amazonFreshApi';
import {
  andList,
  emptyGroceryLabels,
  freshCategoryLabel,
  freshCategoryRows,
  freshCurrency,
  freshListText,
  freshMeasureText,
  freshProductMeasureText,
  freshUnitPriceText,
  freshWeightText,
  groceryLabels,
  orList,
} from './amazonFreshFormat';

/** Synthetic answers only: made-up refs, titles, ASINs, weights and amounts. */
const REF = (n: number) => `amz-${String(n).padStart(48, '0')}`;
type Json = Record<string, unknown>;
const usd = (amountMinor: number) => ({ currency: 'USD', amountMinor });
const lb = (value: string, basis = 'actual') => ({ value, unit: 'lb', basis });
const perLb = (amountMinor: number) => ({ money: usd(amountMinor), per: 'lb' });
const perEach = (amountMinor: number) => ({ money: usd(amountMinor), per: 'each' });
const purchase = (n: number, order: number, orderDate: string, amountMinor: number, patch: Json = {}) => ({
  ref: REF(100 + n), orderRef: REF(200 + order), orderDate, status: 'listed', quantity: 1, weight: null, unitPrice: null,
  amountMinor, refundMinor: 0, ...patch,
});
const filed = (category: string, group: string, node = category, patch: Json = {}) => ({
  category, group, node, source: 'owner', confidence: 1, suggested: false, suggestion: null, ...patch,
});
const product = (title: string | null, asin: string | null, where: Json, purchases: Array<ReturnType<typeof purchase>>, patch: Json = {}) => {
  const amountMinor = purchases.reduce((sum, p) => sum + p.amountMinor, 0), refundMinor = purchases.reduce((sum, p) => sum + p.refundMinor, 0);
  return {
    ref: purchases[0].ref, currency: 'USD', title: title ?? '[redacted]', asin, ...where, amountMinor, refundMinor,
    netMinor: amountMinor - refundMinor, lines: purchases.length, orders: new Set(purchases.map((p) => p.orderRef)).size,
    quantity: purchases.length, weight: null, lastUnitPrice: purchases[0].unitPrice, lastOrderDate: purchases[0].orderDate,
    lastOrderRef: purchases[0].orderRef, purchases, ...patch,
  };
};
const category = (id: string, group: string, amountMinor: number, refundMinor: number, lines: number, products: number, orders: number) =>
  ({ currency: 'USD', category: id, group, amountMinor, refundMinor, netMinor: amountMinor - refundMinor, lines,
    refundedLines: refundMinor > 0 ? 1 : 0, products, orders });

/**
 * Three Fresh orders over the year: pork weighed twice, eggs, chips (suggested, refunded whole), paper towels
 * (Household Supplies) and a substituted snack nobody classified.
 */
function answer(patch: Json = {}): Json {
  return {
    measure: AMAZON_FRESH_MEASURE,
    window: { key: '1Y', from: '2025-10-20', to: '2026-10-19' },
    captured: true,
    taxonomy: { version: 1, digest: 'a'.repeat(64), assignments: 'present' },
    orders: { count: 3, withTotal: 3, complete: 2, reconciled: 2, refunded: 2, unreadable: 0, noLines: 0 },
    lines: { count: 7, priced: 6, noPrice: 0, missing: 1, substituted: 1, estimated: 0, categorized: 5, suggested: 1, needsReview: 1,
      refunded: 1, unreadable: 0 },
    totals: [{ currency: 'USD', orderTotalMinor: 3783, lineMinor: 2552, groceryMinor: 1553, categorizedMinor: 2252, suggestedMinor: 235,
      needsReviewMinor: 300, refundMinor: 335, lineRefundMinor: 235, unattributedRefundMinor: 100, netLineMinor: 2217 }],
    categories: [
      category('groceries/meat-seafood', 'groceries', 818, 0, 2, 1, 2), category('groceries/dairy-eggs', 'groceries', 500, 0, 1, 1, 1),
      category('groceries/snacks-sweets', 'groceries', 235, 235, 1, 1, 1), category('household', 'other', 699, 0, 1, 1, 1),
      category('needs-review', 'needs-review', 300, 0, 1, 1, 1),
    ],
    products: [
      product('Synthetic Pork Shoulder', 'SYNTHPORK2', filed('groceries/meat-seafood', 'groceries'), [
        purchase(1, 1, '2026-10-12', 499, { weight: lb('1.25'), unitPrice: perLb(399) }),
        purchase(2, 2, '2026-09-20', 319, { weight: lb('0.80'), unitPrice: perLb(399) }),
      ], { quantity: 2, weight: { value: '2.05', unit: 'lb', estimated: false } }),
      product('Synthetic Paper Towels', 'SYNTHTOWL1', filed('household', 'other', 'household/paper-disposables'), [
        purchase(5, 1, '2026-10-12', 699, { unitPrice: perEach(699) })]),
      product('Synthetic Large Eggs', 'SYNTHEGGS2', filed('groceries/dairy-eggs', 'groceries', undefined, { source: 'agent', confidence: 0.9 }), [
        purchase(3, 1, '2026-10-12', 500, { quantity: 2 })], { quantity: 2 }),
      product(null, null, filed('needs-review', 'needs-review', undefined, { source: null, confidence: null,
        suggestion: { node: 'groceries/snacks-sweets', confidence: 0.5 } }), [
        purchase(6, 3, '2026-08-25', 300, { status: 'substituted', unitPrice: perEach(300) })]),
      product('Synthetic Potato Chips', null, filed('groceries/snacks-sweets', 'groceries', undefined,
        { source: 'agent', confidence: 0.7, suggested: true }), [
        purchase(4, 1, '2026-10-12', 235, { unitPrice: perEach(235), refundMinor: 235 })]),
    ],
    orderList: [
      { ref: REF(201), date: '2026-10-12', total: usd(2233), lines: 4, priced: 4, missing: 0, substituted: 0, unreadable: 0, unreadRows: 0,
        lineTotal: usd(1933), complete: true, reconciled: true,
        refund: { currency: 'USD', refundMinor: 235, basis: 'units', lineRefundMinor: 235, unattributedMinor: 0 } },
      { ref: REF(202), date: '2026-09-20', total: usd(1100), lines: 2, priced: 1, missing: 1, substituted: 0, unreadable: 0, unreadRows: 1,
        lineTotal: usd(319), complete: false, reconciled: false,
        refund: { currency: 'USD', refundMinor: 100, basis: 'unattributed', lineRefundMinor: 0, unattributedMinor: 100 } },
      { ref: REF(203), date: '2026-08-25', total: usd(450), lines: 1, priced: 1, missing: 0, substituted: 1, unreadable: 0, unreadRows: 0,
        lineTotal: usd(300), complete: true, reconciled: true, refund: null },
    ],
    ...patch,
  };
}
const refuses = (raw: unknown, what: string) => assert.throws(() => parseAmazonFresh(raw, '1Y'),
  (error: unknown) => error instanceof AmazonAnswerError && error.message === `Holdr couldn't read the Amazon answer (${what}).`, what);
const edit = (path: string, value: unknown): Json => {
  const raw = structuredClone(answer());
  const keys = path.split('.');
  let at: Json = raw;
  for (const name of keys.slice(0, -1)) at = at[name] as Json;
  at[keys[keys.length - 1]] = value;
  return raw;
};

test('reads a whole Fresh answer: groceries by category, items with their purchases, and every order', () => {
  const fresh = parseAmazonFresh(answer(), '1Y');
  assert.equal(fresh.captured, true);
  assert.equal(fresh.assignments, 'present');
  assert.deepEqual(fresh.totals[0], (answer().totals as Json[])[0]);
  assert.deepEqual(fresh.categories.map((c) => [c.category, c.group, c.netMinor]), [['groceries/meat-seafood', 'groceries', 818],
    ['groceries/dairy-eggs', 'groceries', 500], ['groceries/snacks-sweets', 'groceries', 0], ['household', 'other', 699],
    ['needs-review', 'needs-review', 300]]);
  const pork = fresh.products[0];
  assert.deepEqual([pork.title, pork.node, pork.weight, pork.purchases.map((p) => [p.orderDate, p.weight?.value, p.unitPrice?.per, p.amountMinor])],
    ['Synthetic Pork Shoulder', 'groceries/meat-seafood', { value: '2.05', unit: 'lb', estimated: false },
      [['2026-10-12', '1.25', 'lb', 499], ['2026-09-20', '0.80', 'lb', 319]]]);
  // A title the guard hid reads as none; the household item keeps where the taxonomy filed it.
  assert.equal(fresh.products[3].title, null);
  assert.deepEqual([fresh.products[1].category, fresh.products[1].node], ['household', 'household/paper-disposables']);
  assert.deepEqual(fresh.orderList.map((o) => [o.ref, o.complete, o.refund?.basis ?? null]), [[REF(201), true, 'units'],
    [REF(202), false, 'unattributed'], [REF(203), true, null]]);
  // The classifier itself said an item needs review: it stays there, by the agent, never suggested.
  const reviewed = structuredClone(answer());
  Object.assign((reviewed.products as Json[])[3], { source: 'agent', confidence: 0.7, suggestion: null });
  assert.deepEqual(parseAmazonFresh(reviewed, '1Y').products[3], { ...fresh.products[3], source: 'agent', confidence: 0.7, suggestion: null });
  // Before any Fresh list was imported: nothing at all, still a whole answer.
  const none = parseAmazonFresh(answer({ captured: false, taxonomy: { version: 1, digest: 'a'.repeat(64), assignments: 'absent' },
    orders: { count: 0, withTotal: 0, complete: 0, reconciled: 0, refunded: 0, unreadable: 0, noLines: 0 },
    lines: { count: 0, priced: 0, noPrice: 0, missing: 0, substituted: 0, estimated: 0, categorized: 0, suggested: 0, needsReview: 0,
      refunded: 0, unreadable: 0 }, totals: [], categories: [], products: [], orderList: [] }), '1Y');
  assert.deepEqual([none.captured, none.assignments, none.orders.count, none.products], [false, 'absent', 0, []]);
});

test('refuses an answer that doesn\'t add up, or files an item where the taxonomy can\'t', () => {
  refuses(edit('measure', 'amazon-order-item-prices-not-card-spending'), 'measure');
  refuses(edit('window.key', '30D'), 'window');
  refuses(edit('taxonomy.version', 2), 'taxonomy');
  refuses(edit('captured', 'yes'), 'taxonomy');
  refuses(edit('orders.reconciled', 3), 'orders');
  refuses(edit('captured', false), 'orders');
  refuses(edit('lines.count', 8), 'lines');
  refuses(edit('lines.categorized', 6), 'lines');
  refuses(edit('totals.0.netLineMinor', 2552), 'totals');
  refuses(edit('totals.0.groceryMinor', 2300), 'totals');
  refuses(edit('totals', [...(answer().totals as Json[]), (answer().totals as Json[])[0]]), 'totals');
  refuses(edit('categories.0.amountMinor', 819), 'categories');
  refuses(edit('categories.0.group', 'other'), 'categories');
  refuses(edit('categories.3.category', 'household/cleaning'), 'categories');
  refuses(edit('categories.4.group', 'groceries'), 'categories');
  refuses(edit('products.0.category', 'groceries/produce'), 'items');
  refuses(edit('products.0.node', 'groceries/produce'), 'items');
  refuses(edit('products.1.node', 'electronics/networking'), 'items');
  refuses(edit('products.2.source', null), 'items');
  refuses(edit('products.3.suggested', true), 'items');
  refuses(edit('products.4.purchases.0.amountMinor', 230), 'items');
  refuses(edit('products.4.purchases.0.status', 'missing'), 'items');
  refuses(edit('products.0.purchases.0.weight', { value: '1,25', unit: 'lb', basis: 'actual' }), 'items');
  refuses(edit('products.0.weight', { value: '2.05', unit: 'kg', estimated: false }), 'items');
  refuses(edit('orderList.1.refund.unattributedMinor', 400), 'order list');
  refuses(edit('orderList.1.reconciled', true), 'order list');
  refuses(edit('orderList.0.refund.basis', 'guessed'), 'order list');
  refuses(edit('orders', { count: 2, withTotal: 2, complete: 2, reconciled: 2, refunded: 2, unreadable: 0, noLines: 0 }), 'order list');
});

/** One order's Item List: a weighed line, a substitute, a missing line, and a title the guard hid. */
function order(patch: Json = {}): Json {
  const line = (n: number, title: string, status: string, linePrice: unknown, extra: Json = {}) => ({
    ref: REF(300 + n), lineOrdinal: n, title, asin: null, status, quantity: 1, weight: null, unitPrice: null, linePrice, replaces: null,
    ...filed('needs-review', 'needs-review', undefined, { source: null, confidence: null }), refundMinor: 0, ...extra,
  });
  return { order: {
    ref: REF(202), date: '2026-09-20', total: usd(1100),
    refund: { currency: 'USD', refundMinor: 100, basis: 'unattributed', lineRefundMinor: 0, unattributedMinor: 100 },
    list: { statedCount: 5, rows: 5, unreadRows: 1, lines: 4, unreadable: 0, complete: false, reconciled: false },
    lines: [
      line(0, 'Synthetic Organic Bananas', 'listed', usd(124), { weight: lb('2.10', 'estimated'), unitPrice: perLb(59),
        ...filed('groceries/produce', 'groceries') }),
      line(1, 'Synthetic Greek Yogurt', 'substituted', usd(349), { replaces: 'Synthetic Plain Yogurt', unitPrice: perEach(349) }),
      line(2, 'Synthetic Sourdough Loaf', 'missing', null),
      line(3, '[redacted]', 'listed', usd(319)),
    ],
    ...patch,
  } };
}

test('reads one order\'s Item List whole, and refuses one that doesn\'t hold together', () => {
  const list = parseAmazonFreshOrder(order());
  assert.deepEqual(list.lines.map((l) => [l.title, l.status, l.linePrice?.amountMinor ?? null, l.category, l.replaces]), [
    ['Synthetic Organic Bananas', 'listed', 124, 'groceries/produce', null],
    ['Synthetic Greek Yogurt', 'substituted', 349, 'needs-review', 'Synthetic Plain Yogurt'],
    ['Synthetic Sourdough Loaf', 'missing', null, 'needs-review', null],
    [null, 'listed', 319, 'needs-review', null]]);
  assert.deepEqual(list.list, { statedCount: 5, rows: 5, unreadRows: 1, lines: 4, unreadable: 0, complete: false, reconciled: false });
  const broken = (patch: Json) => assert.throws(() => parseAmazonFreshOrder(order(patch)), AmazonAnswerError);
  broken({ list: { statedCount: 5, rows: 5, unreadRows: 1, lines: 3, unreadable: 0, complete: false, reconciled: false } });
  broken({ list: { statedCount: 5, rows: 5, unreadRows: 1, lines: 4, unreadable: 0, complete: false, reconciled: true } });
  const lines = (order().order as Json).lines as Json[];
  broken({ lines: [{ ...lines[0], linePrice: null }, ...lines.slice(1)] });
  // A missing line may still show the price it was listed at: never charged, so never refunded.
  const listed = parseAmazonFreshOrder(order({ lines: [...lines.slice(0, 2), { ...lines[2], linePrice: usd(399) }, lines[3]] }));
  assert.deepEqual([listed.lines[2].status, listed.lines[2].linePrice, listed.lines[2].refundMinor], ['missing', usd(399), 0]);
  broken({ lines: [...lines.slice(0, 2), { ...lines[2], linePrice: usd(399), refundMinor: 1 }, lines[3]] });
  broken({ lines: [lines[0], lines[0], ...lines.slice(2)] });
  broken({ lines: [{ ...lines[0], refundMinor: 125 }, ...lines.slice(1)] });
  broken({ ref: '000-0000001-0000001' });
  assert.throws(() => parseAmazonFreshOrder({ order: null }), AmazonAnswerError);
});

test('a Whole Foods store\'s receipt among the Fresh orders says so; null, absent or another value is an Amazon Fresh order', () => {
  const store = structuredClone(answer());
  (store.orderList as Json[])[1].purchaseChannel = 'whole-foods-in-store';
  (store.orderList as Json[])[2].purchaseChannel = null;
  const fresh = parseAmazonFresh(store, '1Y');
  assert.deepEqual(fresh.orderList.map((entry) => entry.purchaseChannel), [undefined, 'whole-foods-in-store', undefined]);
  assert.equal('purchaseChannel' in fresh.orderList[2], false);
  // The rest of the answer reads exactly as without the field.
  assert.deepEqual({ ...fresh, orderList: [] }, { ...parseAmazonFresh(answer(), '1Y'), orderList: [] });
  assert.equal(parseAmazonFreshOrder(order({ purchaseChannel: 'whole-foods-in-store' })).purchaseChannel, 'whole-foods-in-store');
  for (const purchaseChannel of [undefined, null, 'amazon-fresh', 'Whole Foods', 1]) {
    assert.equal('purchaseChannel' in parseAmazonFreshOrder(order({ purchaseChannel })), false, String(purchaseChannel));
  }
});

/** A copy of `base` with each [dot path, value] set. */
function alter(base: Json, ...changes: Array<[string, unknown]>): Json {
  const raw = structuredClone(base);
  for (const [path, value] of changes) {
    const names = path.split('.');
    (names.slice(0, -1).reduce<unknown>((at, name) => (at as Json)[name], raw) as Json)[names[names.length - 1]] = value;
  }
  return raw;
}
/** A copy of `base` with two entries of the list at `path` swapped. */
function swapped(base: Json, path: string, a: number, b: number): Json {
  const raw = structuredClone(base);
  const list = path.split('.').reduce<unknown>((at, name) => (at as Json)[name], raw) as unknown[];
  [list[a], list[b]] = [list[b], list[a]];
  return raw;
}

test('refuses a window whose orders, items and purchases don\'t say what its figures say', () => {
  const base = answer();
  const zero = { count: 0, withTotal: 0, complete: 0, reconciled: 0, refunded: 0, unreadable: 0, noLines: 0 };
  const cases: Array<[string, Json, string]> = [
    // Every order listed: the window's totals and counts are exactly its orders'.
    ['a listed order total one cent more than the window\'s', alter(base, ['orderList.0.total.amountMinor', 2234]), 'order list'],
    ['a listed refund the window doesn\'t count', alter(base, ['orderList.0.refund.refundMinor', 236]), 'order list'],
    ['listed orders complete that the window doesn\'t count',
      alter(base, ['orderList.2.complete', false], ['orderList.2.reconciled', false]), 'order list'],
    ['listed missing lines the window doesn\'t count', alter(base, ['orderList.1.missing', 0]), 'order list'],
    ['a listed complete order with an unread row', alter(base, ['orderList.0.unreadRows', 1]), 'order list'],
    ['an order outside the window', alter(base, ['orderList.2.date', '2025-10-19']), 'order list'],
    ['orders that aren\'t newest first', swapped(base, 'orderList', 0, 1), 'order list'],
    ['a whole-order refund that doesn\'t take every line', alter(base, ['orderList.0.refund.basis', 'whole-order']), 'order list'],
    ['a refund tied to no line that takes money off one', alter(base, ['orderList.0.refund.basis', 'unattributed']), 'order list'],
    ['a refund tied to lines that leaves some over', alter(base, ['orderList.0.refund.unattributedMinor', 1]), 'order list'],
    // Every purchase listed: an item's figures are exactly its purchases', weight and count included.
    ['an item weighing more than its purchases', alter(base, ['products.0.weight.value', '999']), 'items'],
    ['an item counting more than its purchases', alter(base, ['products.0.quantity', 3]), 'items'],
    ['an estimated weight none of its purchases has', alter(base, ['products.0.weight.estimated', true]), 'items'],
    ['an item naming a purchase that isn\'t its latest', alter(base, ['products.0.ref', REF(102)]), 'items'],
    ['a latest unit price its latest purchase doesn\'t show', alter(base, ['products.0.lastUnitPrice', perLb(398)]), 'items'],
    ['purchases that aren\'t latest first', alter(swapped(base, 'products.0.purchases', 0, 1), ['products.0.ref', REF(102)],
      ['products.0.lastOrderRef', REF(202)], ['products.0.lastOrderDate', '2026-09-20']), 'items'],
    ['a purchase from an order the window doesn\'t list',
      alter(base, ['products.3.purchases.0.orderRef', REF(209)], ['products.3.lastOrderRef', REF(209)]), 'items'],
    ['a purchase dated apart from its order',
      alter(base, ['products.3.purchases.0.orderDate', '2026-08-26'], ['products.3.lastOrderDate', '2026-08-26']), 'items'],
    ['one line listed under two items', alter(base, ['products.1.purchases.0.ref', REF(102)], ['products.1.ref', REF(102)]), 'items'],
    ['one line listed twice under one item', alter(base, ['products.0.purchases.1.ref', REF(101)]), 'items'],
    ['a currency the window has no totals for', alter(base, ['orderList.2.total', { currency: 'EUR', amountMinor: 450 }]), 'order list'],
    ['items that aren\'t largest first', swapped(base, 'products', 0, 1), 'items'],
    ['an order whose purchases aren\'t its priced lines', alter(base, ['products.1.purchases.0.orderRef', REF(202)],
      ['products.1.purchases.0.orderDate', '2026-09-20'], ['products.1.lastOrderRef', REF(202)], ['products.1.lastOrderDate', '2026-09-20']),
    'items'],
    ['suggested prices its items don\'t add up to', alter(base, ['totals.0.suggestedMinor', 236]), 'items'],
    ['estimated weights its purchases don\'t show', alter(base, ['lines.estimated', 1]), 'items'],
    ['a per-pound price without a weight', alter(base, ['products.2.purchases.0.unitPrice', perLb(250)],
      ['products.2.lastUnitPrice', perLb(250)]), 'items'],
    // Categories, classification and an empty window.
    ['refunded lines its categories don\'t hold', alter(base, ['lines.refunded', 2]), 'categories'],
    ['a category in more orders than the window', alter(base, ['categories.4.orders', 4]), 'categories'],
    ['classified items before any classification', alter(base, ['taxonomy.assignments', 'absent']), 'taxonomy'],
    ['figures for a window without orders', answer({ orders: zero, lines: { count: 0, priced: 0, noPrice: 0, missing: 0, substituted: 0,
      estimated: 0, categorized: 0, suggested: 0, needsReview: 0, refunded: 0, unreadable: 0 },
    totals: [{ currency: 'USD', orderTotalMinor: 0, lineMinor: 0, groceryMinor: 0, categorizedMinor: 0, suggestedMinor: 0,
      needsReviewMinor: 0, refundMinor: 0, lineRefundMinor: 0, unattributedRefundMinor: 0, netLineMinor: 0 }],
    categories: [], products: [], orderList: [] }), 'orders'],
  ];
  for (const [what, raw, label] of cases) {
    assert.throws(() => parseAmazonFresh(raw, '1Y'), (error: unknown) => error instanceof AmazonAnswerError
      && error.message === `Holdr couldn't read the Amazon answer (${label}).`, what);
  }
  // Fewer orders listed than the window holds (the newest): at most its figures, never refused for that alone.
  const newest = alter(base, ['orderList', (base.orderList as Json[]).slice(0, 2)]);
  assert.equal(parseAmazonFresh(newest, '1Y').orderList.length, 2);
  assert.throws(() => parseAmazonFresh(alter(newest, ['orderList.0.total.amountMinor', 3784]), '1Y'), AmazonAnswerError);
});

test('refuses an Item List whose proof, lines or refund don\'t hold together', () => {
  const base = order(), lines = (base.order as Json).lines as Json[];
  const complete = alter(base, ['order.list', { statedCount: 4, rows: 4, unreadRows: 0, lines: 4, unreadable: 0, complete: true,
    reconciled: true }]);
  const whole = alter(base, ['order.refund', { currency: 'USD', refundMinor: 1100, basis: 'whole-order', lineRefundMinor: 792,
    unattributedMinor: 0 }], ['order.lines.0.refundMinor', 124], ['order.lines.1.refundMinor', 349], ['order.lines.3.refundMinor', 319]);
  assert.deepEqual(parseAmazonFreshOrder(complete).list, { statedCount: 4, rows: 4, unreadRows: 0, lines: 4, unreadable: 0,
    complete: true, reconciled: true });
  assert.deepEqual(parseAmazonFreshOrder(whole).lines.map((line) => line.refundMinor), [124, 349, 0, 319]);
  const partly = { currency: 'USD', refundMinor: 900, basis: 'partly', lineRefundMinor: 124, unattributedMinor: 100 };
  const cases: Array<[string, Json]> = [
    // Refunds conserved: what comes off lines is exactly what the lines show, never more than they cost.
    ['more taken off lines than the list holds', alter(base, ['order.refund.lineRefundMinor', 999999])],
    ['refunds off lines the lines don\'t show', alter(base, ['order.refund', { ...partly, lineRefundMinor: 999999 }])],
    ['a line refund the refund doesn\'t count', alter(base, ['order.refund', { ...partly, lineRefundMinor: 0 }], ['order.lines.0.refundMinor', 124])],
    ['refunds beyond what the delivered lines cost', alter(base, ['order.refund', { ...partly, unattributedMinor: 700 }],
      ['order.lines.0.refundMinor', 124])],
    ['a line refund without a refund', alter(base, ['order.refund', null], ['order.lines.0.refundMinor', 124])],
    ['a line refund in another currency', alter(base, ['order.refund', { ...partly, currency: 'EUR' }], ['order.lines.0.refundMinor', 124])],
    ['a whole-order refund that leaves a line', alter(whole, ['order.lines.3.refundMinor', 0], ['order.refund.lineRefundMinor', 473])],
    // A complete list: every row read and stored, any stated count matched, each line once.
    ['a complete list with an unread row', alter(complete, ['order.list.unreadRows', 1])],
    ['a complete list listing a line twice', alter(complete, ['order.lines.1.ref', lines[0].ref])],
    ['a list listing a line twice', alter(base, ['order.lines.1.ref', lines[0].ref])],
    ['a complete list with fewer lines than rows', alter(complete, ['order.list.rows', 5])],
    ['a complete list whose page stated another count', alter(complete, ['order.list.statedCount', 3])],
    ['a reconciled list in two currencies', alter(complete, ['order.lines.3.linePrice', { currency: 'EUR', amountMinor: 319 }])],
    ['lines out of position', swapped(base, 'order.lines', 0, 1)],
    ['an unread list record with a stated count', alter(base, ['order.list', { statedCount: 5, rows: null, unreadRows: null, lines: 4,
      unreadable: 0, complete: false, reconciled: false }])],
    ['more unread rows than rows', alter(base, ['order.list.unreadRows', 6])],
    // Each line as the Item List contract admits it.
    ['a listed line naming what it replaced', alter(base, ['order.lines.0.replaces', 'Synthetic Other Bananas'])],
    ['a weight longer than a list shows', alter(base, ['order.lines.0.weight.value', '1234567'])],
    ['a count above 999', alter(base, ['order.lines.3.quantity', 1000])],
    ['a line price above the list contract\'s', alter(base, ['order.lines.3.linePrice', usd(100_000_001)])],
    ['a per-pound price without a weight', alter(base, ['order.lines.1.unitPrice', perLb(349)])],
  ];
  for (const [what, raw] of cases) {
    assert.throws(() => parseAmazonFreshOrder(raw), (error: unknown) => error instanceof AmazonAnswerError
      && error.message === 'Holdr couldn\'t read the Amazon answer (order).', what);
  }
});

test('words for Fresh lines, products, categories and orders say only what the list showed', () => {
  assert.equal(freshCategoryLabel('groceries/meat-seafood'), 'Meat & Seafood');
  assert.equal(freshCategoryLabel('groceries'), 'Other groceries');
  assert.equal(freshCategoryLabel('household'), 'Household Supplies');
  assert.equal(freshCategoryLabel('needs-review'), 'Not yet classified');
  assert.equal(freshWeightText({ value: '2.10', unit: 'lb', basis: 'estimated' }), '2.10 lb (estimated)');
  assert.equal(freshUnitPriceText({ money: usd(399), per: 'lb' }), '$3.99/lb');
  assert.equal(freshUnitPriceText({ money: usd(250), per: 'each' }), '$2.50 each');
  assert.equal(freshMeasureText({ quantity: 1, weight: { value: '1.25', unit: 'lb', basis: 'actual' }, unitPrice: { money: usd(399), per: 'lb' } }),
    '1.25 lb at $3.99/lb');
  assert.equal(freshMeasureText({ quantity: 2, weight: { value: '2.1', unit: 'lb', basis: 'unlabeled' }, unitPrice: { money: usd(59), per: 'lb' } }),
    'Qty 2 · 2.1 lb at $0.59/lb');
  assert.equal(freshMeasureText({ quantity: 2, weight: null, unitPrice: { money: usd(250), per: 'each' } }), 'Qty 2 at $2.50 each');
  assert.equal(freshMeasureText({ quantity: 2, weight: null, unitPrice: null }), 'Qty 2');
  assert.equal(freshMeasureText({ quantity: null, weight: null, unitPrice: { money: usd(250), per: 'each' } }), '$2.50 each');
  assert.equal(freshMeasureText({ quantity: null, weight: null, unitPrice: null }), '');
  assert.equal(freshProductMeasureText({ quantity: 3, weight: { value: '4.2', estimated: true } }), 'Qty 3 · 4.2 lb, some estimated');
  assert.equal(freshProductMeasureText({ quantity: null, weight: null }), '');
  const fresh = parseAmazonFresh(answer(), '1Y');
  assert.equal(freshCurrency(fresh), 'USD');
  assert.deepEqual(freshCategoryRows(fresh, 'USD').map((row) => row.category), ['groceries/meat-seafood', 'groceries/dairy-eggs',
    'groceries/snacks-sweets', 'household', 'needs-review']);
  assert.deepEqual(emptyGroceryLabels(fresh, 'USD'), ['Produce', 'Bakery & Bread', 'Beverages', 'Pantry & Cooking', 'Frozen', 'Prepared Meals']);
  assert.equal(orList(['Produce', 'Frozen', 'Beverages']), 'Produce, Frozen or Beverages');
  assert.equal(orList(['Frozen']), 'Frozen');
  assert.equal(andList(['Produce', 'Frozen', 'Beverages']), 'Produce, Frozen and Beverages');
  assert.deepEqual(groceryLabels(), ['Meat & Seafood', 'Dairy & Eggs', 'Produce', 'Bakery & Bread', 'Snacks & Sweets', 'Beverages',
    'Pantry & Cooking', 'Frozen', 'Prepared Meals']);
  assert.equal(freshListText({ lines: 4, complete: true, reconciled: true, unreadable: 0, unreadRows: 0 }), '4 items, list complete');
  assert.equal(freshListText({ lines: 2, complete: false, reconciled: false, unreadable: 1, unreadRows: 1 }), '2 items, 2 rows unread');
  assert.equal(freshListText({ lines: 0, complete: false, reconciled: false, unreadable: 1, unreadRows: 2 }), 'Items not captured yet');
});
