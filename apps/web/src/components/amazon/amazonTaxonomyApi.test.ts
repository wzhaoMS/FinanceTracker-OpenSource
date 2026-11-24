import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AMAZON_SPENDING_MEASURE, AmazonAnswerError } from './amazonApi';
import { parseAmazonTaxonomySpending } from './amazonTaxonomyApi';
import {
  cardCategoryText,
  nodeNote,
  otherLabel,
  subcategoryRows,
  taxonomyCurrency,
  taxonomyPathText,
  taxonomySourceText,
  topRows,
} from './amazonTaxonomyFormat';

/** Synthetic answers only: made-up refs, titles, ASINs and amounts. */
const REF = (n: number) => `amz-${String(n).padStart(48, '0')}`;
type Json = Record<string, unknown>;
const purchase = (n: number, quantity: number, unitPriceMinor: number, refundMinor = 0, refundedQuantity = 0, orderRefunded = refundMinor > 0) => ({
  ref: REF(100 + n), orderRef: REF(200 + n), orderDate: `2026-09-${String(10 + n).padStart(2, '0')}`, quantity, unitPriceMinor,
  amountMinor: quantity * unitPriceMinor, refundMinor, refundedQuantity, orderRefunded,
});
const product = (n: number, node: string, purchases: ReturnType<typeof purchase>[], patch: Json = {}) => {
  const amountMinor = purchases.reduce((sum, p) => sum + p.amountMinor, 0), refundMinor = purchases.reduce((sum, p) => sum + p.refundMinor, 0);
  return {
    ref: purchases[0].ref, currency: 'USD', title: `Synthetic item ${n}`, asin: `SYNTH0000${n}`, node, source: 'agent', confidence: 0.9,
    suggested: false, suggestion: null, cardCategory: 'Merchandise & Supplies-Groceries', cardCategorySource: 'agent-classification',
    quantity: purchases.reduce((sum, p) => sum + p.quantity, 0), refundedQuantity: purchases.reduce((sum, p) => sum + p.refundedQuantity, 0),
    lines: purchases.length, orders: purchases.length, refundedOrders: purchases.filter((p) => p.orderRefunded).length,
    amountMinor, refundMinor, netMinor: amountMinor - refundMinor,
    lastOrderDate: purchases[0].orderDate, lastOrderRef: purchases[0].orderRef, purchases, ...patch,
  };
};
const node = (id: string, amountMinor: number, refundMinor: number, lines: number, products: number, orders: number, refundedOrders = 0) =>
  ({ currency: 'USD', node: id, amountMinor, refundMinor, netMinor: amountMinor - refundMinor, lines, refundedLines: refundMinor > 0 ? 1 : 0,
    products, orders, refundedOrders });

/**
 * A router (suggested, refunded whole), pork (meat, 2 purchases), rice (Groceries itself), and one item in Needs review
 * whose order has a refund not tied to it.
 */
function answer(patch: Json = {}): Json {
  return {
    measure: AMAZON_SPENDING_MEASURE,
    window: { key: '1Y', from: '2025-10-20', to: '2026-10-19' },
    taxonomy: { version: 1, digest: 'a'.repeat(64), assignments: 'present' },
    orders: { count: 5, refunded: 2 },
    lines: { count: 6, priced: 5, noPrice: 1, noQuantity: 0, assigned: 4, suggested: 1, needsReview: 1 },
    totals: [{ currency: 'USD', itemMinor: 18000, assignedMinor: 15500, suggestedMinor: 12000, needsReviewMinor: 2500, refundMinor: 12600,
      itemRefundMinor: 12000, unattributedRefundMinor: 500, netItemMinor: 5500 }],
    nodes: [
      node('groceries', 3500, 0, 3, 2, 3), node('needs-review', 2500, 0, 1, 1, 1, 1), node('groceries/meat-seafood', 2500, 0, 2, 1, 2),
      node('electronics', 12000, 12000, 1, 1, 1, 1), node('electronics/networking', 12000, 12000, 1, 1, 1, 1),
    ],
    products: [
      product(2, 'groceries/meat-seafood', [purchase(2, 2, 1000), purchase(3, 1, 500)]),
      product(3, 'needs-review', [purchase(4, 1, 2500, 0, 0, true)], { source: null, confidence: null,
        suggestion: { node: 'toys-hobbies/rc-drones', confidence: 0.4 }, cardCategory: null, cardCategorySource: null }),
      product(4, 'groceries', [purchase(5, 1, 1000)], { source: 'owner', confidence: 1 }),
      product(1, 'electronics/networking', [purchase(1, 1, 12000, 12000, 1)], { suggested: true, confidence: 0.7 }),
    ],
    ...patch,
  };
}
test('a well-formed answer reads whole: nodes, items with their purchases and refunds, and who filed each', () => {
  const parsed = parseAmazonTaxonomySpending(answer(), '1Y');
  assert.equal(parsed.assignments, 'present');
  assert.deepEqual(parsed.totals, [{ currency: 'USD', itemMinor: 18000, assignedMinor: 15500, suggestedMinor: 12000, needsReviewMinor: 2500,
    refundMinor: 12600, itemRefundMinor: 12000, unattributedRefundMinor: 500, netItemMinor: 5500 }]);
  assert.equal(parsed.nodes.length, 5);
  assert.deepEqual(parsed.products.map((p) => [p.node, p.source, p.suggested, p.netMinor]), [
    ['groceries/meat-seafood', 'agent', false, 2500], ['needs-review', null, false, 2500], ['groceries', 'owner', false, 1000],
    ['electronics/networking', 'agent', true, 0],
  ]);
  assert.deepEqual(parsed.products[1].suggestion, { node: 'toys-hobbies/rc-drones', confidence: 0.4 });
  assert.deepEqual(parsed.products[0].purchases.map((p) => [p.quantity, p.unitPriceMinor, p.amountMinor]), [[2, 1000, 2000], [1, 500, 500]]);
  assert.deepEqual(parsed.products[3].purchases.map((p) => [p.refundMinor, p.refundedQuantity, p.orderRefunded]), [[12000, 1, true]]);
  assert.deepEqual(parsed.products[1].purchases.map((p) => [p.refundMinor, p.orderRefunded]), [[0, true]]);
  // A hidden title reads as no title.
  const hidden = answer();
  (hidden.products as Json[])[0].title = '[redacted]';
  assert.equal(parseAmazonTaxonomySpending(hidden, '1Y').products[0].title, null);
});

test('an answer that doesn\'t add up, or names a node the taxonomy doesn\'t have, is refused whole', () => {
  const totals = (patch: Json) => answer({ totals: [{ ...(answer().totals as Json[])[0], ...patch }] });
  const nodes = (id: string, patch: Json) => answer({ nodes: (answer().nodes as Json[]).map((n) => (n.node === id ? { ...n, ...patch } : n)) });
  const variants: Array<[string, Json]> = [
    ['measure', answer({ measure: 'card-spending' })],
    ['window', answer({ window: { key: '30D', from: '2025-10-20', to: '2026-10-19' } })],
    ['taxonomy version', answer({ taxonomy: { version: 2, digest: 'a'.repeat(64), assignments: 'present' } })],
    ['lines', answer({ lines: { count: 6, priced: 5, noPrice: 1, noQuantity: 0, assigned: 4, suggested: 1, needsReview: 2 } })],
    ['totals', totals({ itemMinor: 18001 })],
    ['net', totals({ netItemMinor: 6000 })],
    ['refunds above prices', totals({ unattributedRefundMinor: 6001, netItemMinor: -1 })],
    ['totals without refunds', totals({ itemRefundMinor: undefined })],
    ['unknown node', answer({ nodes: [...(answer().nodes as Json[]), node('groceries/pork', 1, 0, 1, 1, 1)] })],
    ['tops not adding up', answer({ nodes: (answer().nodes as Json[]).filter((n) => n.node !== 'electronics') })],
    ['child above parent', nodes('groceries/meat-seafood', { amountMinor: 3600, netMinor: 3600 })],
    ['node net', nodes('groceries', { netMinor: 3400 })],
    ['node refunds not adding up', nodes('electronics', { refundMinor: 11000, netMinor: 1000 })],
  ];
  const products = (patch: Json, index = 3) => {
    const list = (answer().products as Json[]).map((p) => ({ ...p }));
    list[index] = { ...list[index], ...patch };
    return answer({ products: list });
  };
  variants.push(
    ['item node', products({ node: 'robots' })],
    ['unfiled outside Needs review', products({ source: null })],
    ['owner suggested', products({ source: 'owner', suggested: true })],
    ['suggested in Needs review', products({ node: 'needs-review', source: 'agent', suggested: true }, 1)],
    ['suggestion on a filed item', products({ suggestion: { node: 'groceries', confidence: 0.4 } })],
    ['purchase arithmetic', products({ purchases: [{ ...purchase(1, 2, 6000, 12000, 1), amountMinor: 12001 }], quantity: 2 })],
    ['purchase refund above its price', products({ purchases: [{ ...purchase(1, 1, 12000, 12000, 1), refundMinor: 12001 }] })],
    ['purchases not adding up', products({ amountMinor: 11000, netMinor: -1000 })],
    ['purchase refunds not adding up', products({ refundMinor: 11000, netMinor: 1000 })],
    ['item net', products({ netMinor: 1 })],
    ['more units refunded than bought', products({ refundedQuantity: 2 })],
    ['more than its node', products({ amountMinor: 3000, netMinor: 3000, purchases: [purchase(9, 1, 3000)] }, 0)],
  );
  for (const [what, value] of variants) {
    assert.throws(() => parseAmazonTaxonomySpending(value, '1Y'), AmazonAnswerError, what);
  }
});

test('display words: paths, who filed it, card category, and each level\'s rows after refunds', () => {
  const parsed = parseAmazonTaxonomySpending(answer(), '1Y');
  const [pork, mystery, rice, router] = parsed.products;
  assert.equal(taxonomyPathText('groceries/meat-seafood'), 'Groceries › Meat & Seafood');
  assert.equal(otherLabel('groceries'), 'Other Groceries');
  assert.equal(taxonomySourceText(router), 'suggested from its title, 70% sure');
  assert.equal(taxonomySourceText(pork), 'classified from its title, 90% sure');
  assert.equal(taxonomySourceText(mystery), 'best guess Toys, Hobbies & RC › RC & Drones, only 40% sure');
  assert.equal(taxonomySourceText(rice), 'your choice');
  assert.equal(taxonomySourceText({ node: 'needs-review', source: null, confidence: null, suggested: false, suggestion: null }), 'not classified yet');
  assert.equal(cardCategoryText(pork), 'Card category: Groceries');
  assert.equal(cardCategoryText({ cardCategory: 'Synthetic Household' }), 'Card category: Synthetic Household');
  assert.equal(cardCategoryText(mystery), 'Uncategorized on cards');
  assert.equal(taxonomyCurrency(parsed), 'USD');
  // Top levels largest after refunds first, Needs review last: the refunded router's Electronics comes after Groceries.
  assert.deepEqual(topRows(parsed, 'USD').map((row) => [row.node, row.netMinor]), [['groceries', 3500], ['electronics', 0], ['needs-review', 2500]]);
  // A top level's subcategories, then what is filed on it directly ("Other …"): its orders aren't reported apart.
  assert.deepEqual(subcategoryRows(parsed, 'USD', 'groceries'), [
    { node: 'groceries/meat-seafood', amountMinor: 2500, refundMinor: 0, netMinor: 2500, lines: 2, orders: 2, refundedOrders: 0 },
    { node: null, amountMinor: 1000, refundMinor: 0, netMinor: 1000, lines: 1, orders: null, refundedOrders: null },
  ]);
  assert.deepEqual(subcategoryRows(parsed, 'USD', 'needs-review'), []);
  assert.equal(nodeNote({ lines: 3, orders: 2, refundedOrders: 1, amountMinor: 3500, refundMinor: 0 }, 'USD'), '3 items · 2 orders · 1 with a refund');
  assert.equal(nodeNote({ lines: 1, orders: 1, refundedOrders: 1, amountMinor: 12000, refundMinor: 12000 }, 'USD'),
    '1 item · 1 order · $120.00 refunded of $120.00');
  assert.equal(nodeNote({ lines: 1, orders: null, refundedOrders: null, amountMinor: 1000, refundMinor: 0 }, 'USD'), '1 item');
});