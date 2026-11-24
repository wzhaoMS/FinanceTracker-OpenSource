import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AMAZON_SPENDING_MEASURE, AmazonAnswerError, parseAmazonSpending } from './amazonApi';
import { itemCategory } from './amazonFormat';
import { readFreshPart } from './amazonFreshItems';
import { FRESH_ITEM_LABEL, freshPartLines } from './amazonFreshItemsFormat';
import { parseAmazonTaxonomySpending } from './amazonTaxonomyApi';

/** Synthetic answers only: made-up refs, titles, ASINs and amounts. */
const REF = (n: number) => `amz-${String(n).padStart(48, '0')}`;
type Json = Record<string, any>;
const GROCERIES = 'Merchandise & Supplies-Groceries';
const usd = (amountMinor: number) => ({ currency: 'USD', amountMinor });
/** Two Fresh orders' lines (pork by weight, eggs by the each) and one item not delivered; and an ordinary router. */
const FRESH_PART = { orders: 2, lines: { priced: 3, missing: 1, unreadable: 0 },
  totals: [{ currency: 'USD', lineMinor: 1318, refundMinor: 0, lineRefundMinor: 0, unattributedRefundMinor: 0, netLineMinor: 1318 }] };
const PORK_LINES = [
  { ref: REF(101), orderRef: REF(201), orderDate: '2026-10-12', quantity: 1, unitPriceMinor: 499, amountMinor: 499, refundMinor: 0,
    refundedQuantity: 0, orderRefunded: false, fresh: { status: 'listed', quantity: 1, weight: { value: '1.25', unit: 'lb', basis: 'actual' },
      unitPrice: { money: usd(399), per: 'lb' } } },
  { ref: REF(102), orderRef: REF(202), orderDate: '2026-09-20', quantity: 1, unitPriceMinor: 319, amountMinor: 319, refundMinor: 0,
    refundedQuantity: 0, orderRefunded: false, fresh: { status: 'substituted', quantity: 1, weight: { value: '0.80', unit: 'lb', basis: 'actual' },
      unitPrice: { money: usd(399), per: 'lb' } } },
];
const EGGS_LINE = { ref: REF(103), orderRef: REF(201), orderDate: '2026-10-12', quantity: 2, unitPriceMinor: 250, amountMinor: 500, refundMinor: 0,
  refundedQuantity: 0, orderRefunded: false, fresh: { status: 'listed', quantity: 2, weight: null, unitPrice: { money: usd(250), per: 'each' } } };

function taxonomy(): Json {
  const node = (id: string, amountMinor: number, refundMinor: number, lines: number, products: number, orders: number, refundedOrders = 0) =>
    ({ currency: 'USD', node: id, amountMinor, refundMinor, netMinor: amountMinor - refundMinor, lines, refundedLines: refundMinor > 0 ? 1 : 0,
      products, orders, refundedOrders });
  const fresh = (n: number, title: string, nodeId: string, purchases: Json[], measure: Json, patch: Json = {}) => ({
    ref: purchases[0].ref, currency: 'USD', title, asin: `SYNTHFRSH${n}`, node: nodeId, source: 'owner', confidence: 1, suggested: false,
    suggestion: null, cardCategory: null, cardCategorySource: null, quantity: purchases.reduce((s, p) => s + p.quantity, 0), refundedQuantity: 0,
    lines: purchases.length, orders: new Set(purchases.map((p) => p.orderRef)).size, refundedOrders: 0,
    amountMinor: purchases.reduce((s, p) => s + p.amountMinor, 0), refundMinor: 0, netMinor: purchases.reduce((s, p) => s + p.amountMinor, 0),
    lastOrderDate: purchases[0].orderDate, lastOrderRef: purchases[0].orderRef, purchases, fresh: measure, ...patch });
  return {
    measure: AMAZON_SPENDING_MEASURE,
    window: { key: '60D', from: '2026-08-21', to: '2026-10-19' },
    taxonomy: { version: 1, digest: 'a'.repeat(64), assignments: 'present' },
    orders: { count: 3, refunded: 1 },
    lines: { count: 4, priced: 4, noPrice: 0, noQuantity: 0, assigned: 4, suggested: 0, needsReview: 0 },
    totals: [{ currency: 'USD', itemMinor: 13318, assignedMinor: 13318, suggestedMinor: 0, needsReviewMinor: 0, refundMinor: 12000,
      itemRefundMinor: 12000, unattributedRefundMinor: 0, netItemMinor: 1318 }],
    nodes: [node('groceries', 1318, 0, 3, 2, 2), node('groceries/meat-seafood', 818, 0, 2, 1, 2), node('groceries/dairy-eggs', 500, 0, 1, 1, 1),
      node('electronics', 12000, 12000, 1, 1, 1, 1), node('electronics/networking', 12000, 12000, 1, 1, 1, 1)],
    products: [
      fresh(1, 'Synthetic Pork Shoulder', 'groceries/meat-seafood', structuredClone(PORK_LINES),
        { quantity: 2, weight: { value: '2.05', unit: 'lb', estimated: false } }),
      fresh(2, 'Synthetic Large Eggs', 'groceries/dairy-eggs', [structuredClone(EGGS_LINE)], { quantity: 2, weight: null }),
      { ref: REF(104), currency: 'USD', title: 'Synthetic Router', asin: 'SYNTHNET01', node: 'electronics/networking', source: 'agent',
        confidence: 0.95, suggested: false, suggestion: null, cardCategory: 'Merchandise & Supplies-Computer Supplies',
        cardCategorySource: 'agent-classification', quantity: 1, refundedQuantity: 1, lines: 1, orders: 1, refundedOrders: 1, amountMinor: 12000,
        refundMinor: 12000, netMinor: 0, lastOrderDate: '2026-09-25', lastOrderRef: REF(203), purchases: [{ ref: REF(104), orderRef: REF(203),
          orderDate: '2026-09-25', quantity: 1, unitPriceMinor: 12000, amountMinor: 12000, refundMinor: 12000, refundedQuantity: 1, orderRefunded: true }] },
    ],
    fresh: structuredClone(FRESH_PART),
  };
}
function spending(): Json {
  return {
    measure: AMAZON_SPENDING_MEASURE,
    window: { key: '60D', from: '2026-08-21', to: '2026-10-19' },
    version: 'amazon-v1-000000000000000000000000',
    orders: { count: 3, withTotal: 3, itemsComplete: 2, noLines: 0, refunded: 1, linked: 1, held: 1, unmatched: 1 },
    cardCharges: { linked: 1, itemized: 0 },
    lines: { count: 4, priced: 4, noPrice: 0, noQuantity: 0, categorized: 4 },
    totals: [{ currency: 'USD', orderTotalMinor: 15000, itemsCompleteOrderTotalMinor: 14000, itemMinor: 13318, categorizedMinor: 13318,
      refundMinor: 12000, itemRefundMinor: 12000, unattributedRefundMinor: 0, netItemMinor: 1318 }],
    categories: [
      { currency: 'USD', category: GROCERIES, amountMinor: 1318, lines: 3, products: 2, orders: 2, refundMinor: 0, netMinor: 1318, refundedLines: 0 },
      { currency: 'USD', category: 'Merchandise & Supplies-Computer Supplies', amountMinor: 12000, lines: 1, products: 1, orders: 1,
        refundMinor: 12000, netMinor: 0, refundedLines: 1 },
    ],
    products: [
      { ref: REF(101), currency: 'USD', title: 'Synthetic Pork Shoulder', asin: 'SYNTHFRSH1', category: GROCERIES, categorySource: 'item-taxonomy',
        quantity: 2, lines: 2, orders: 2, amountMinor: 818, lastOrderDate: '2026-10-12', lastOrderRef: REF(201), refundMinor: 0, netMinor: 818,
        refundedQuantity: 0, fresh: { quantity: 2, weight: { value: '2.05', unit: 'lb', estimated: false } } },
      { ref: REF(103), currency: 'USD', title: 'Synthetic Large Eggs', asin: 'SYNTHFRSH2', category: GROCERIES, categorySource: 'fresh-default',
        quantity: 2, lines: 1, orders: 1, amountMinor: 500, lastOrderDate: '2026-10-12', lastOrderRef: REF(201), refundMinor: 0, netMinor: 500,
        refundedQuantity: 0, fresh: { quantity: 2, weight: null } },
      { ref: REF(104), currency: 'USD', title: 'Synthetic Router', asin: 'SYNTHNET01', category: 'Merchandise & Supplies-Computer Supplies',
        categorySource: 'agent-classification', quantity: 1, lines: 1, orders: 1, amountMinor: 12000, lastOrderDate: '2026-09-25',
        lastOrderRef: REF(203), refundMinor: 12000, netMinor: 0, refundedQuantity: 1 },
    ],
    refunds: {
      policy: 'amazon-refund-attribution-v1',
      orders: [{ basis: 'units', orders: 1 }], unattributed: [], sources: [{ source: 'order-summary', orders: 1 }],
      ledgerRefunds: 0, ledgerObservations: 0, refundTotals: 1, refundTotalObservations: 1, excluded: [],
      refundedProducts: { count: 1, listed: 1, truncated: false },
    },
    fresh: structuredClone(FRESH_PART),
  };
}
const patched = (build: () => Json, patch: (answer: Json) => void): Json => {
  const answer = build();
  patch(answer);
  return answer;
};

test('the item-category view reads Fresh lines whole: what each list showed, its product\'s weight, and the Fresh part', () => {
  const parsed = parseAmazonTaxonomySpending(taxonomy(), '60D');
  assert.deepEqual(parsed.fresh, FRESH_PART);
  const [pork, eggs, router] = parsed.products;
  assert.deepEqual(pork.fresh, { quantity: 2, weight: { value: '2.05', unit: 'lb', estimated: false } });
  assert.deepEqual(pork.purchases.map((p) => [p.amountMinor, p.fresh?.status, p.fresh?.weight?.value, p.fresh?.unitPrice?.per]),
    [[499, 'listed', '1.25', 'lb'], [319, 'substituted', '0.80', 'lb']]);
  assert.deepEqual([pork.cardCategory, pork.cardCategorySource, pork.image], [null, null, undefined]);
  assert.deepEqual(eggs.purchases[0].fresh, { status: 'listed', quantity: 2, weight: null, unitPrice: { money: usd(250), per: 'each' } });
  assert.equal(router.fresh, undefined);
  assert.equal(router.purchases[0].fresh, undefined);
  // A window without a Fresh order says nothing of Fresh, as before.
  const plain = patched(taxonomy, (answer) => {
    delete answer.fresh;
    answer.products = [answer.products[2]];
    answer.nodes = answer.nodes.filter((n: Json) => n.node.startsWith('electronics'));
    answer.totals[0] = { ...answer.totals[0], itemMinor: 12000, assignedMinor: 12000, netItemMinor: 0 };
    answer.lines = { ...answer.lines, count: 1, priced: 1, assigned: 1 };
    answer.orders = { count: 1, refunded: 1 };
  });
  assert.equal('fresh' in parseAmazonTaxonomySpending(plain, '60D'), false);
});

/** Refused for this reason (the error names the part of the answer that failed), not merely refused. */
const refusedFor = (why: string) => (error: unknown) => error instanceof AmazonAnswerError && error.message.includes(`(${why})`);

test('an item-category answer whose Fresh lines don\'t hold together is refused whole', () => {
  const variants: Array<[string, Json, 'items' | 'fresh']> = [
    ['a Fresh product with a card category', patched(taxonomy, (a) => { a.products[0].cardCategory = GROCERIES; }), 'items'],
    ['a Fresh product with a thumbnail', patched(taxonomy, (a) => { a.products[0].image = true; }), 'items'],
    ['a Fresh product with units refunded', patched(taxonomy, (a) => { a.products[0].refundedQuantity = 1; }), 'items'],
    ['a Fresh purchase without its list', patched(taxonomy, (a) => { delete a.products[0].purchases[1].fresh; }), 'items'],
    ['an order item with a Fresh purchase', patched(taxonomy, (a) => {
      a.products[2].purchases[0].refundedQuantity = 0;
      a.products[2].purchases[0].fresh = structuredClone(EGGS_LINE.fresh); }), 'items'],
    ['a Fresh purchase with units refunded', patched(taxonomy, (a) => { a.products[1].purchases[0].refundedQuantity = 1; }), 'items'],
    ['a missing line as a purchase', patched(taxonomy, (a) => { a.products[1].purchases[0].fresh.status = 'missing'; }), 'items'],
    ['a per-pound price without a weight', patched(taxonomy, (a) => { a.products[1].purchases[0].fresh.unitPrice.per = 'lb'; }), 'items'],
    ['a weight that is not one', patched(taxonomy, (a) => { a.products[0].purchases[0].fresh.weight.value = '1.2.5'; }), 'items'],
    ['a product weight its lines don\'t add up to', patched(taxonomy, (a) => { a.products[0].fresh.weight.value = '2.06'; }), 'items'],
    ['an estimate not said', patched(taxonomy, (a) => { a.products[0].purchases[1].fresh.weight.basis = 'estimated'; }), 'items'],
    ['a product quantity its lines don\'t add up to', patched(taxonomy, (a) => { a.products[1].fresh.quantity = 3; }), 'items'],
    ['Fresh products without the Fresh part', patched(taxonomy, (a) => { delete a.fresh; }), 'fresh'],
    ['a Fresh part that doesn\'t add up', patched(taxonomy, (a) => { a.fresh.totals[0].netLineMinor = 1317; }), 'fresh'],
    ['more Fresh orders than orders', patched(taxonomy, (a) => { a.fresh.orders = 4; }), 'fresh'],
    ['more Fresh lines than priced lines', patched(taxonomy, (a) => { a.fresh.lines.priced = 5; }), 'fresh'],
    ['Fresh prices above the window\'s', patched(taxonomy, (a) => {
      a.fresh.totals[0] = { ...a.fresh.totals[0], lineMinor: 13319, netLineMinor: 13319 }; }), 'fresh'],
    ['Fresh products above the Fresh part', patched(taxonomy, (a) => {
      a.fresh.totals[0] = { ...a.fresh.totals[0], lineMinor: 1000, netLineMinor: 1000 }; }), 'fresh'],
    ['a Fresh currency the window doesn\'t have', patched(taxonomy, (a) => { a.fresh.totals[0].currency = 'EUR'; }), 'fresh'],
    ['a Fresh part with no order', patched(taxonomy, (a) => { a.fresh.orders = 0; }), 'fresh'],
  ];
  for (const [what, value, why] of variants) {
    assert.throws(() => parseAmazonTaxonomySpending(value, '60D'), refusedFor(why), what);
  }
});

test('the card-category view reads Fresh lines under their item category\'s card category, or Groceries as a default', () => {
  const parsed = parseAmazonSpending(spending(), '60D');
  assert.deepEqual(parsed.fresh, FRESH_PART);
  assert.deepEqual(parsed.products.map((p) => [p.title, p.category, p.categorySource, p.fresh?.quantity]), [
    ['Synthetic Pork Shoulder', GROCERIES, 'item-taxonomy', 2], ['Synthetic Large Eggs', GROCERIES, 'fresh-default', 2],
    ['Synthetic Router', 'Merchandise & Supplies-Computer Supplies', 'agent-classification', undefined]]);
  // A Fresh source on an order item, or an order item's on a Fresh product, isn't one it can have: not said.
  const swapped = parseAmazonSpending(patched(spending, (a) => {
    a.products[2].categorySource = 'item-taxonomy';
    a.products[0].categorySource = 'item-override';
  }), '60D');
  assert.deepEqual([swapped.products[0].categorySource, swapped.products[2].categorySource], [null, null]);
  const refusals: Array<[string, Json, 'items' | 'fresh']> = [
    ['a Fresh product with a thumbnail', patched(spending, (a) => { a.products[0].image = true; }), 'items'],
    ['a Fresh product with units refunded', patched(spending, (a) => {
      Object.assign(a.products[1], { refundMinor: 250, netMinor: 250, refundedQuantity: 1 });
      a.categories[0] = { ...a.categories[0], refundMinor: 250, netMinor: 1068, refundedLines: 1 };
      a.totals[0] = { ...a.totals[0], refundMinor: 12250, itemRefundMinor: 12250, netItemMinor: 1068 };
      a.fresh.totals[0] = { ...a.fresh.totals[0], refundMinor: 250, lineRefundMinor: 250, netLineMinor: 1068 }; }), 'items'],
    ['a malformed Fresh measure', patched(spending, (a) => { a.products[0].fresh.weight.estimated = 'no'; }), 'items'],
    ['Fresh products without the Fresh part', patched(spending, (a) => { delete a.fresh; }), 'fresh'],
    ['Fresh refunds above the window\'s', patched(spending, (a) => { a.fresh.totals[0] = { ...a.fresh.totals[0], refundMinor: 12001 }; }), 'fresh'],
    ['Fresh lines above the window\'s', patched(spending, (a) => { a.fresh.lines.priced = 5; }), 'fresh'],
  ];
  for (const [what, value, why] of refusals) assert.throws(() => parseAmazonSpending(value, '60D'), refusedFor(why), what);
});

test('display words: where a Fresh line\'s card category comes from, and what of the figures Amazon Fresh is', () => {
  assert.deepEqual(itemCategory({ category: GROCERIES, categorySource: 'item-taxonomy', confidence: null }),
    { name: GROCERIES, source: 'from its item category', tone: 'mapping' });
  assert.deepEqual(itemCategory({ category: GROCERIES, categorySource: 'fresh-default', confidence: null }),
    { name: GROCERIES, source: 'Amazon Fresh default until it is classified', tone: 'uncategorized' });
  assert.equal(FRESH_ITEM_LABEL, 'Amazon Fresh');
  assert.deepEqual(freshPartLines(undefined, 'USD', true), []);
  assert.deepEqual(freshPartLines(readFreshPart(FRESH_PART), 'USD'), [
    'Amazon Fresh: 2 orders count by their Fresh item lists here: 3 items, $13.18',
    'Not counted from Fresh item lists: 1 item not delivered, never charged',
  ]);
  const one = { orders: 1, lines: { priced: 2, missing: 0, unreadable: 3 },
    totals: [{ currency: 'USD', lineMinor: 1000, refundMinor: 400, lineRefundMinor: 300, unattributedRefundMinor: 100, netLineMinor: 600 }] };
  assert.deepEqual(freshPartLines(readFreshPart(one), 'USD', true), [
    'Amazon Fresh: 1 order counts by its Fresh item list here: 2 items, $10.00 ($6.00 after refunds)',
    'Not counted from Fresh item lists: 3 stored lines that couldn\'t be read',
    'Splitting a Fresh order\'s card charge by its Fresh item list in Spending isn\'t done yet',
  ]);
});
