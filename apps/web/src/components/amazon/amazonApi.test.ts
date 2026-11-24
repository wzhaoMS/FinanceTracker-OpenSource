import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AMAZON_MEASURE,
  AMAZON_SPENDING_MEASURE,
  AmazonAnswerError,
  MAX_LISTED_PRODUCTS,
  amazonItemImageHref,
  parseAmazonOrder,
  parseAmazonOrderPage,
  parseAmazonSpending,
  parseAmazonSummary,
} from './amazonApi';

/** Synthetic answers only: made-up refs, titles, ASINs, amounts and card endings. */

const REF = (n: number) => `amz-${String(n).padStart(48, '0')}`;
const usd = (amountMinor: number) => ({ currency: 'USD', amountMinor });

const EMPTY_SUMMARY = {
  measure: AMAZON_MEASURE, orders: 0, paymentObservations: 0, refundObservations: 0, issuedRefundObservations: 0,
  linked: 0, held: 0, unknownBeneficiary: 0, itemAttribution: 'unproven', coverage: [],
};

/** A list row as the read API before matches, refunds and list items (main at PR #96). */
const OLD_ROW = {
  ref: REF(1), date: '2026-09-14', total: usd(4250), beneficiary: 'unknown', tenderCoverage: 'single-card-proven',
  paymentCoverage: 'held', itemObservations: 2,
};

test('the empty summary production answers today reads as nothing imported, without coverage or version', () => {
  assert.deepEqual(parseAmazonSummary(EMPTY_SUMMARY), {
    orders: 0, paymentObservations: 0, refundObservations: 0, issuedRefundObservations: 0, linked: 0, held: 0,
    unknownBeneficiary: 0, captures: 0, latestCoverage: null, version: null,
  });
});

test('itemized card charges and their item parts are reported together, consistent, or not at all: never a guessed 0', () => {
  assert.deepEqual(parseAmazonSummary({ ...EMPTY_SUMMARY, itemizedRows: 17, itemParts: 40 }).itemized, { rows: 17, parts: 40 });
  assert.deepEqual(parseAmazonSummary({ ...EMPTY_SUMMARY, itemizedRows: 0, itemParts: 0 }).itemized, { rows: 0, parts: 0 });
  // The API before them (EMPTY_SUMMARY still says `itemAttribution`), or one of the two missing, malformed or fewer
  // parts than charges: not reported, and the rest of the summary still reads.
  for (const extra of [{}, { itemizedRows: 17 }, { itemParts: 40 }, { itemizedRows: -1, itemParts: 40 }, { itemizedRows: 17, itemParts: 4.5 },
    { itemizedRows: '17', itemParts: 40 }, { itemizedRows: 17, itemParts: null }, { itemizedRows: 17, itemParts: 16 }]) {
    const summary = parseAmazonSummary({ ...EMPTY_SUMMARY, orders: 3, ...extra });
    assert.equal('itemized' in summary, false, JSON.stringify(extra));
    assert.equal(summary.orders, 3);
  }
});

test('a summary of another measure, or with a count missing or malformed, is refused rather than shown', () => {
  assert.throws(() => parseAmazonSummary({ ...EMPTY_SUMMARY, measure: 'card-spending' }), AmazonAnswerError);
  assert.throws(() => parseAmazonSummary(null), AmazonAnswerError);
  for (const key of ['orders', 'linked', 'held', 'refundObservations', 'unknownBeneficiary']) {
    const { [key]: _dropped, ...rest } = EMPTY_SUMMARY as Record<string, unknown>;
    assert.throws(() => parseAmazonSummary(rest), AmazonAnswerError, key);
    assert.throws(() => parseAmazonSummary({ ...EMPTY_SUMMARY, [key]: -1 }), AmazonAnswerError, key);
    assert.throws(() => parseAmazonSummary({ ...EMPTY_SUMMARY, [key]: 1.5 }), AmazonAnswerError, key);
  }
});

test('the summary shows the newest capture\'s coverage per family, skipping a malformed family', () => {
  const family = (status: string, records: number) => ({ status, reason: 'synthetic-reason', pages: 1, records, rejected: 0 });
  const summary = parseAmazonSummary({
    ...EMPTY_SUMMARY,
    orders: 3,
    version: 'amazon-v1-000000000000000000000001',
    coverage: [
      { captureRef: 'newest', coverage: { orders: family('partial', 3), payments: family('held', 0), details: { status: 'partial' }, refunds: family('held', 0) } },
      { captureRef: 'older', coverage: { orders: family('partial', 1), payments: family('partial', 1), details: family('partial', 1), refunds: family('partial', 1) } },
    ],
  });
  assert.equal(summary.captures, 2);
  assert.equal(summary.version, 'amazon-v1-000000000000000000000001');
  assert.deepEqual(summary.latestCoverage, {
    orders: family('partial', 3), payments: family('held', 0), refunds: family('held', 0),
  });
});

test('a list row of the older read API leaves matches, refunds and items not reported, never empty', () => {
  const page = parseAmazonOrderPage({ total: 1, orders: [OLD_ROW] });
  assert.equal(page.total, 1);
  assert.deepEqual(page.orders[0], {
    ref: REF(1), date: '2026-09-14', total: usd(4250), beneficiary: 'unknown', tenderCoverage: 'single-card-proven', itemCount: 2,
  });
  for (const key of ['matches', 'refunds', 'items', 'summary', 'paymentMethods']) assert.equal(key in page.orders[0], false, key);
});

test('a list row carries its matches, refunds and trimmed items, and a held match nothing but its reason and count', () => {
  const [order] = parseAmazonOrderPage({
    total: 1,
    orders: [{
      ...OLD_ROW,
      matches: [
        { state: 'linked', evidenceClass: 'unique-total-match', cardTransactionId: 'card-txn-synthetic-1', cardAccountId: 'card-acct-synthetic-1' },
        { state: 'held', evidenceClass: 'payment-event', reason: 'ambiguous', candidateCount: 2,
          candidates: ['card-txn-synthetic-2', 'card-txn-synthetic-3'], cardTransactionId: 'card-txn-synthetic-2' },
        // Amazon's payment ledger pays for this order and others in one entry.
        { state: 'held', evidenceClass: 'unique-total-match', reason: 'multiple-orders', candidateCount: 1 },
      ],
      refunds: [{ ref: 'amz-refund-1', status: 'issued', date: '2026-09-20', amount: usd(-1299), destination: 'card' }],
      items: [
        { ref: 'amz-item-1', title: 'Sample Kettle Model K-100, 1.7 L', asin: 'B000000001', quantity: 1, category: 'Home', categorySource: 'agent-classification' },
        { ref: 'amz-item-2', title: '[redacted]', asin: null, quantity: 2, category: null, categorySource: null },
      ],
    }],
  }).orders;
  assert.deepEqual(order.matches, [
    { state: 'linked', evidenceClass: 'unique-total-match', cardTransactionId: 'card-txn-synthetic-1', cardAccountId: 'card-acct-synthetic-1' },
    { state: 'held', evidenceClass: 'payment-event', reason: 'ambiguous', candidateCount: 2 },
    { state: 'held', evidenceClass: 'unique-total-match', reason: 'multiple-orders', candidateCount: 1 },
  ]);
  assert.deepEqual(order.refunds, [{ ref: 'amz-refund-1', status: 'issued', date: '2026-09-20', amount: usd(-1299), destination: 'card' }]);
  assert.deepEqual(order.items, [
    // The list's items carry no confidence or price; those are the order page's.
    { ref: 'amz-item-1', title: 'Sample Kettle Model K-100, 1.7 L', asin: 'B000000001', quantity: 1, category: 'Home',
      categorySource: 'agent-classification', confidence: null },
    { ref: 'amz-item-2', title: null, asin: null, quantity: 2, category: null, categorySource: null, confidence: null },
  ]);
});

test('one malformed entry and its whole list is not reported, so a gap never reads as "none"', () => {
  const malformed: Array<[string, unknown]> = [
    ['matches', [{ state: 'linked', evidenceClass: 'unique-total-match', cardTransactionId: 'card-txn-synthetic-1', cardAccountId: 'card-acct-synthetic-1' },
      { state: 'linked', evidenceClass: 'unique-total-match', cardTransactionId: '' }]],
    ['matches', [{ state: 'held', evidenceClass: 'unique-total-match', reason: 'nearest-date', candidateCount: 1 }]],
    ['matches', [{ state: 'invalidated', evidenceClass: 'payment-event' }]],
    ['matches', [{ state: 'held', evidenceClass: 'guess', reason: 'ambiguous', candidateCount: 1 }]],
    ['matches', [{ state: 'held', evidenceClass: 'payment-event', reason: 'ambiguous', candidateCount: -1 }]],
    ['refunds', [{ ref: 'amz-refund-1', status: 'issued', date: '2026-09-20', amount: { currency: 'usd', amountMinor: 5 } }]],
    ['refunds', [{ ref: 'amz-refund-1', status: 'issued', date: '20 Sep', amount: usd(5) }]],
    ['refunds', [{ status: 'issued', date: '2026-09-20', amount: usd(5) }]],
    ['items', [{ ref: 'amz-item-1', title: 'Sample', quantity: 1.5, category: null, categorySource: null }]],
    ['items', [{ title: 'Sample', quantity: 1 }]],
    ['matches', { state: 'linked' }],
  ];
  for (const [key, value] of malformed) {
    const [order] = parseAmazonOrderPage({ total: 1, orders: [{ ...OLD_ROW, [key]: value }] }).orders;
    assert.equal(key in order, false, `${key}: ${JSON.stringify(value)}`);
  }
  // An empty list is a reported "none".
  const [none] = parseAmazonOrderPage({ total: 1, orders: [{ ...OLD_ROW, matches: [], refunds: [], items: [] }] }).orders;
  assert.deepEqual([none.matches, none.refunds, none.items], [[], [], []]);
});

test('a refund\'s missing amount or destination stays unreported or unknown, never inferred', () => {
  const [order] = parseAmazonOrderPage({
    total: 1,
    orders: [{ ...OLD_ROW, refunds: [
      { ref: 'amz-refund-1', status: 'issued', date: '2026-09-20' },
      { ref: 'amz-refund-2', status: 'reversed', date: null, amount: null, destination: 'gift-card' },
    ] }],
  }).orders;
  assert.deepEqual(order.refunds, [
    { ref: 'amz-refund-1', status: 'issued', date: '2026-09-20', amount: null, destination: 'unknown' },
    { ref: 'amz-refund-2', status: 'unknown', date: null, amount: null, destination: 'unknown' },
  ]);
});

test('beneficiary is an explicit person or unknown, and an unknown payment split stays unknown', () => {
  for (const beneficiary of [undefined, null, 'household', 'Alex', 'card-owner']) {
    const [order] = parseAmazonOrderPage({ total: 1, orders: [{ ...OLD_ROW, beneficiary, tenderCoverage: 'probably-single' }] }).orders;
    assert.equal(order.beneficiary, 'unknown', String(beneficiary));
    assert.equal(order.tenderCoverage, 'unknown');
  }
  for (const beneficiary of ['alex', 'casey', 'joint'] as const) {
    assert.equal(parseAmazonOrderPage({ total: 1, orders: [{ ...OLD_ROW, beneficiary }] }).orders[0].beneficiary, beneficiary);
  }
});

test('an order missing what every order has fails the whole answer', () => {
  const broken: Array<Record<string, unknown>> = [
    { ...OLD_ROW, ref: '000-0000001-0000001' },
    { ...OLD_ROW, ref: undefined },
    { ...OLD_ROW, date: '2026-02-30' },
    { ...OLD_ROW, date: undefined },
    { ...OLD_ROW, total: { currency: 'USD', amountMinor: 12.5 } },
    { ...OLD_ROW, total: undefined },
    { ...OLD_ROW, itemObservations: undefined },
  ];
  for (const row of broken) assert.throws(() => parseAmazonOrderPage({ total: 1, orders: [row] }), AmazonAnswerError, JSON.stringify(row));
  assert.throws(() => parseAmazonOrderPage({ orders: [] }), AmazonAnswerError);
  assert.throws(() => parseAmazonOrderPage({ total: 0 }), AmazonAnswerError);
  // A null total is Amazon's own gap, shown as such.
  assert.equal(parseAmazonOrderPage({ total: 1, orders: [{ ...OLD_ROW, total: null }] }).orders[0].total, null);
});

test('an order page\'s items carry unit price, ASIN, category, its source and the agent\'s confidence', () => {
  const order = parseAmazonOrder({
    ...OLD_ROW,
    items: [
      { ref: 'amz-item-1', title: 'Sample Kettle Model K-100', asin: 'B000000001', quantity: 1, unitPrice: usd(2999),
        attribution: 'observation-only', category: 'Home', categorySource: 'agent-classification', confidence: 0.92 },
      { ref: 'amz-item-2', title: 'Sample Cable Model C-2 (2 m)', asin: 'not-an-asin', quantity: 2, unitPrice: null,
        attribution: 'observation-only', category: 'Electronics', categorySource: 'item-override', confidence: 0.4 },
      { ref: 'amz-item-3', title: '   ', asin: null, quantity: null, unitPrice: usd(100), attribution: 'observation-only',
        category: 'Mystery', categorySource: 'guessed', confidence: 2 },
    ],
    summary: [{ kind: 'items-subtotal', money: usd(4000) }, { kind: 'gift-card', money: usd(1000) }, { kind: 'grand-total', money: usd(3000) }],
    paymentMethods: [{ kind: 'card', network: 'visa', last4: '0001' }, { kind: 'balance', network: 'unknown', last4: null }],
  }, true);
  assert.deepEqual(order.items, [
    { ref: 'amz-item-1', title: 'Sample Kettle Model K-100', asin: 'B000000001', quantity: 1, unitPrice: usd(2999),
      category: 'Home', categorySource: 'agent-classification', confidence: 0.92 },
    // Confidence is the agent's only; your own choice carries none.
    { ref: 'amz-item-2', title: 'Sample Cable Model C-2 (2 m)', asin: null, quantity: 2, unitPrice: null,
      category: 'Electronics', categorySource: 'item-override', confidence: null },
    // A category whose source isn't one the API names is shown without a source, never as the agent's.
    { ref: 'amz-item-3', title: null, asin: null, quantity: null, unitPrice: usd(100), category: 'Mystery', categorySource: null, confidence: null },
  ]);
  assert.deepEqual(order.summary, [
    { kind: 'items-subtotal', money: usd(4000) }, { kind: 'gift-card', money: usd(1000) }, { kind: 'grand-total', money: usd(3000) },
  ]);
  assert.deepEqual(order.paymentMethods, [{ kind: 'card', network: 'visa', last4: '0001' }, { kind: 'balance', network: 'unknown', last4: null }]);

  // Items without category fields (the read API before categories) report no category at all, not "Uncategorized".
  const before = parseAmazonOrder({ ...OLD_ROW, items: [{ ref: 'amz-item-1', title: 'Sample Lamp', quantity: 1, unitPrice: usd(999), attribution: 'observation-only' }] }, true);
  assert.equal(before.items?.[0].category, undefined);
  assert.equal(before.items && 'category' in before.items[0], false);
  // A malformed price, summary line or method: that list is not reported.
  const bad = parseAmazonOrder({
    ...OLD_ROW,
    items: [{ ref: 'amz-item-1', title: 'Sample Lamp', quantity: 1, unitPrice: { currency: 'USD' } }],
    summary: [{ kind: 'surcharge', money: usd(1) }],
    paymentMethods: [{ kind: 'crypto' }],
  }, true);
  assert.deepEqual([bad.items, bad.summary, bad.paymentMethods], [undefined, undefined, undefined]);
});

test('an order bought in a Whole Foods store says so; null, absent or any other value is an ordinary Amazon order\'s', () => {
  const store = { ...OLD_ROW, purchaseChannel: 'whole-foods-in-store' };
  assert.equal(parseAmazonOrderPage({ total: 1, orders: [store] }).orders[0].purchaseChannel, 'whole-foods-in-store');
  assert.equal(parseAmazonOrder(store, true).purchaseChannel, 'whole-foods-in-store');
  for (const purchaseChannel of [undefined, null, 'amazon', 'Whole Foods', 1]) {
    const order = parseAmazonOrder({ ...OLD_ROW, purchaseChannel }, true);
    assert.equal('purchaseChannel' in order, false, String(purchaseChannel));
    assert.deepEqual(order, parseAmazonOrder(OLD_ROW, true));
  }
});

test('a Fresh order\'s tip is a summary line like the rest; a kind the API doesn\'t name still drops the whole summary', () => {
  const tipped = [{ kind: 'items-subtotal', money: usd(1500) }, { kind: 'shipping', money: usd(0) }, { kind: 'tax', money: usd(100) },
    { kind: 'tip', money: usd(200) }, { kind: 'grand-total', money: usd(1800) }];
  assert.deepEqual(parseAmazonOrder({ ...OLD_ROW, summary: tipped }, true).summary, tipped);
  for (const kind of ['gratuity', 'driver-tip', 'Tip', 'tips']) {
    const summary = tipped.map((line) => (line.kind === 'tip' ? { ...line, kind } : line));
    assert.equal(parseAmazonOrder({ ...OLD_ROW, summary }, true).summary, undefined, kind);
  }
});

/** A 60-day answer as the API gives it: made-up refs, names, ASINs, categories and amounts. */
const SPENDING = {
  measure: AMAZON_SPENDING_MEASURE,
  window: { key: '60D', from: '2026-08-21', to: '2026-10-19' },
  version: 'amazon-v1-000000000000000000000000',
  orders: { count: 3, withTotal: 3, itemsComplete: 2, noLines: 0, refunded: 0, linked: 1, held: 1, unmatched: 1 },
  cardCharges: { linked: 2, itemized: 1 },
  lines: { count: 6, priced: 4, noPrice: 1, noQuantity: 1, categorized: 3 },
  totals: [{ currency: 'USD', orderTotalMinor: 11209, itemsCompleteOrderTotalMinor: 6209, itemMinor: 8797, categorizedMinor: 6798 }],
  categories: [
    { currency: 'USD', category: 'Home' as string | null, amountMinor: 5898, lines: 2, products: 1, orders: 2 },
    { currency: 'USD', category: null as string | null, amountMinor: 1999, lines: 1, products: 1, orders: 1 },
    { currency: 'USD', category: 'Kitchen' as string | null, amountMinor: 900, lines: 1, products: 1, orders: 1 },
  ],
  products: [
    { ref: REF(11), currency: 'USD', title: 'Sample Kettle Model K-100', asin: 'B0000000A1' as string | null, category: 'Home' as string | null,
      categorySource: 'agent-classification' as string | null, quantity: 2, lines: 2, orders: 2, amountMinor: 5898,
      lastOrderDate: '2026-10-12', lastOrderRef: REF(1) },
    { ref: REF(12), currency: 'USD', title: '[redacted]', asin: null as string | null, category: null as string | null,
      categorySource: null as string | null, quantity: 1, lines: 1, orders: 1, amountMinor: 1999, lastOrderDate: '2026-09-25', lastOrderRef: REF(2) },
    { ref: REF(13), currency: 'USD', title: 'Sample Filter Pack (2-Pack)', asin: 'B0000000A2' as string | null, category: 'Kitchen' as string | null,
      categorySource: 'item-override' as string | null, quantity: 2, lines: 1, orders: 1, amountMinor: 900,
      lastOrderDate: '2026-10-12', lastOrderRef: REF(1) },
  ],
};
type SpendingAnswer = typeof SPENDING;
const spendingWith = (patch: (answer: SpendingAnswer) => void): unknown => {
  const answer = structuredClone(SPENDING);
  patch(answer);
  return answer;
};

test('a spending answer reads whole: its window, counts, totals, categories and items, a hidden title as hidden', () => {
  const spending = parseAmazonSpending(SPENDING, '60D');
  assert.deepEqual(spending.window, { key: '60D', from: '2026-08-21', to: '2026-10-19' });
  assert.deepEqual(spending.orders, SPENDING.orders);
  assert.deepEqual(spending.cardCharges, { linked: 2, itemized: 1 });
  assert.deepEqual(spending.lines, SPENDING.lines);
  assert.deepEqual(spending.totals, SPENDING.totals);
  assert.deepEqual(spending.categories, SPENDING.categories);
  assert.equal(spending.version, SPENDING.version);
  assert.deepEqual(spending.products.map((product) => [product.title, product.category, product.categorySource, product.lastOrderRef]), [
    ['Sample Kettle Model K-100', 'Home', 'agent-classification', REF(1)],
    [null, null, null, REF(2)],
    ['Sample Filter Pack (2-Pack)', 'Kitchen', 'item-override', REF(1)],
  ]);
  // An unreadable ASIN or category source is not said; the rest of the item still reads.
  const loose = parseAmazonSpending(spendingWith((answer) => {
    answer.products[0].asin = 'not an asin';
    answer.products[0].categorySource = 'mystery';
  }), '60D');
  assert.deepEqual([loose.products[0].asin, loose.products[0].category, loose.products[0].categorySource], [null, 'Home', null]);
  // A window with no order: nothing to add up, and nothing refused.
  const empty = parseAmazonSpending({ ...SPENDING, orders: { count: 0, withTotal: 0, itemsComplete: 0, noLines: 0, refunded: 0, linked: 0, held: 0, unmatched: 0 },
    cardCharges: { linked: 0, itemized: 0 }, lines: { count: 0, priced: 0, noPrice: 0, noQuantity: 0, categorized: 0 },
    totals: [], categories: [], products: [] }, '60D');
  assert.deepEqual([empty.orders.count, empty.totals, empty.products], [0, [], []]);
});

test('a spending answer of another measure or window, or whose figures do not add up, is refused rather than shown', () => {
  const refusals: Array<[string, unknown]> = [
    ['another measure', { ...SPENDING, measure: AMAZON_MEASURE }],
    ['another window', { ...SPENDING, window: { ...SPENDING.window, key: '30D' } }],
    ['dates out of order', { ...SPENDING, window: { ...SPENDING.window, from: '2026-10-20' } }],
    ['a count missing', spendingWith((answer) => { delete (answer.orders as Partial<SpendingAnswer['orders']>).refunded; })],
    ['orders neither linked, held nor unmatched', spendingWith((answer) => { answer.orders.unmatched = 0; })],
    ['lines that do not add up', spendingWith((answer) => { answer.lines.noPrice = 0; })],
    ['more charges itemized than linked', spendingWith((answer) => { answer.cardCharges.itemized = 3; })],
    ['a currency twice', spendingWith((answer) => { answer.totals.push({ ...answer.totals[0] }); })],
    ['a negative amount', spendingWith((answer) => { answer.totals[0].itemMinor = -1; })],
    ['categories short of the items', spendingWith((answer) => { answer.categories[1].amountMinor = 1000; })],
    ['categorized items over-counted', spendingWith((answer) => { answer.totals[0].categorizedMinor = 8797; })],
    ['a category in another currency', spendingWith((answer) => { answer.categories[2].currency = 'EUR'; })],
    ['an item in no category', spendingWith((answer) => { answer.products[2].category = 'Garden'; })],
    ['an item over its category', spendingWith((answer) => { answer.products[2].amountMinor = 901; })],
    ['an item without its order', spendingWith((answer) => { answer.products[0].lastOrderRef = 'order-1'; })],
    ['an item listed twice', spendingWith((answer) => { answer.products[1].ref = answer.products[0].ref; })],
  ];
  for (const [label, answer] of refusals) assert.throws(() => parseAmazonSpending(answer, '60D'), AmazonAnswerError, label);
});

test('an item carries a cached thumbnail only when the API says exactly so, and it is only ever asked of this origin', () => {
  const [order] = parseAmazonOrderPage({
    total: 1,
    orders: [{
      ...OLD_ROW,
      items: [
        { ref: REF(11), title: 'Sample Lamp', asin: 'B000000011', quantity: 1, category: null, categorySource: null, image: true },
        { ref: REF(12), title: 'Sample Mug', asin: 'B000000012', quantity: 1, category: null, categorySource: null, image: 'true' },
        { ref: REF(13), title: 'Sample Rug', asin: null, quantity: 1, category: null, categorySource: null, image: false },
        { ref: REF(14), title: 'Sample Pen', asin: 'B000000014', quantity: 1, category: null, categorySource: null },
      ],
    }],
  }).orders;
  assert.deepEqual(order.items?.map((item) => item.image), [true, undefined, undefined, undefined]);
  assert.equal(order.items && 'image' in order.items[3], false);
  assert.equal(amazonItemImageHref(REF(11)), `/amazon/items/${REF(11)}/image`);
  // The spending-by-item list's products say so the same strict way.
  const spending = parseAmazonSpending(spendingWith((answer) => {
    Object.assign(answer.products[0], { image: true });
    Object.assign(answer.products[2], { image: 'yes' });
  }), '60D');
  assert.deepEqual(spending.products.map((product) => product.image), [true, undefined, undefined]);
  // Only an opaque item ref: nothing else (another path, a full URL, a malformed ref) ever becomes an image address.
  for (const ref of ['amz-item-1', `${REF(11)}0`, REF(11).toUpperCase(), '../amazon/summary', 'https://example.invalid/a.jpg',
    `${REF(11)}/../x`, `${REF(11)}?x=1`, '']) {
    assert.equal(amazonItemImageHref(ref), null, ref);
  }
});

/** The same window from an API that takes refunds off: one kettle of two refunded, and a refund tied to no item. */
const REFUNDED = {
  ...SPENDING,
  orders: { ...SPENDING.orders, refunded: 2 },
  totals: [{ ...SPENDING.totals[0], refundMinor: 4500, itemRefundMinor: 2999, unattributedRefundMinor: 1000, netItemMinor: 4798 }],
  categories: [
    { ...SPENDING.categories[0], refundMinor: 2999, netMinor: 2899, refundedLines: 1 },
    { ...SPENDING.categories[1], refundMinor: 0, netMinor: 1999, refundedLines: 0 },
    { ...SPENDING.categories[2], refundMinor: 0, netMinor: 900, refundedLines: 0 },
  ],
  products: [
    { ...SPENDING.products[0], refundMinor: 2999, netMinor: 2899, refundedQuantity: 1 },
    { ...SPENDING.products[1], refundMinor: 0, netMinor: 1999, refundedQuantity: 0 },
    { ...SPENDING.products[2], refundMinor: 0, netMinor: 900, refundedQuantity: 0 },
  ],
  refunds: {
    policy: 'amazon-refund-attribution-v1',
    orders: [{ basis: 'whole-order', orders: 0 }, { basis: 'units', orders: 1 }, { basis: 'unattributed', orders: 1 }],
    unattributed: [{ reason: 'ambiguous', orders: 1 }, { reason: 'promotion', orders: 0 }],
    sources: [{ source: 'order-summary', orders: 2 }, { source: 'ledger', orders: 0 }],
    ledgerRefunds: 1, ledgerObservations: 2, refundTotals: 2, refundTotalObservations: 3,
    excluded: [{ reason: 'multiple-orders', count: 1 }, { reason: 'contradictory', count: 0 }],
    refundedProducts: { count: 1, listed: 1, truncated: false },
  },
};
type RefundedAnswer = typeof REFUNDED;
const refundedWith = (patch: (answer: RefundedAnswer) => void): unknown => {
  const answer = structuredClone(REFUNDED);
  patch(answer);
  return answer;
};

test('a spending answer that takes refunds off reads its nets, and how its refunds were counted', () => {
  const spending = parseAmazonSpending(REFUNDED, '60D');
  assert.deepEqual(spending.totals, REFUNDED.totals);
  assert.deepEqual(spending.categories.map((entry) => [entry.category, entry.amountMinor, entry.refundMinor, entry.netMinor, entry.refundedLines]),
    [['Home', 5898, 2999, 2899, 1], [null, 1999, 0, 1999, 0], ['Kitchen', 900, 0, 900, 0]]);
  assert.deepEqual(spending.products.map((product) => [product.refundMinor, product.netMinor, product.refundedQuantity]),
    [[2999, 2899, 1], [0, 1999, 0], [0, 900, 0]]);
  assert.deepEqual(spending.refunds, {
    policy: 'amazon-refund-attribution-v1',
    orders: { 'whole-order': 0, units: 1, unattributed: 1 },
    unattributed: { ambiguous: 1, promotion: 0 },
    sources: { 'order-summary': 2, ledger: 0 },
    excluded: { 'multiple-orders': 1, contradictory: 0 },
    ledgerRefunds: 1, ledgerObservations: 2, refundTotals: 2, refundTotalObservations: 3,
    refundedProducts: { count: 1, listed: 1, truncated: false },
  });
  // An API that doesn't take refunds off says nothing of them: its figures read as before refunds.
  const before = parseAmazonSpending(SPENDING, '60D');
  assert.equal(before.refunds, undefined);
  assert.equal('netItemMinor' in before.totals[0], false);
  assert.equal('netMinor' in before.products[0], false);
});

test('a spending answer whose refunds do not add up is refused rather than shown', () => {
  const refusals: Array<[string, unknown]> = [
    ['a net that is not gross less refunds', refundedWith((answer) => { answer.totals[0].netItemMinor = 4799; })],
    ['a total refund field missing', refundedWith((answer) => { delete (answer.totals[0] as Partial<RefundedAnswer['totals'][0]>).refundMinor; })],
    ['categories\' refunds short of the items\'', refundedWith((answer) => { answer.categories[0].refundMinor = 2000; answer.categories[0].netMinor = 3898; })],
    ['a category net that is not its gross less its refunds', refundedWith((answer) => { answer.categories[1].netMinor = 1000; })],
    ['more refunded lines than lines', refundedWith((answer) => { answer.categories[2].refundedLines = 2; })],
    ['an item refunded more than its category', refundedWith((answer) => { answer.products[2].refundMinor = 1; answer.products[2].netMinor = 899; })],
    ['an item net that is not its gross less its refunds', refundedWith((answer) => { answer.products[0].netMinor = 5898; })],
    ['more units refunded than bought', refundedWith((answer) => { answer.products[0].refundedQuantity = 3; })],
    ['refunded orders that do not add up', refundedWith((answer) => { answer.refunds.orders[1].orders = 2; })],
    ['sources that do not add up', refundedWith((answer) => { answer.refunds.sources[0].orders = 1; })],
    ['unattributed reasons that do not add up', refundedWith((answer) => { answer.refunds.unattributed[0].orders = 0; })],
    ['a basis named twice', refundedWith((answer) => { answer.refunds.orders.push({ basis: 'units', orders: 0 }); })],
    ['more distinct refunds than observations', refundedWith((answer) => { answer.refunds.ledgerRefunds = 3; })],
    ['refunds without a policy', refundedWith((answer) => { answer.refunds.policy = ''; })],
    ['more refunded items listed than there are', refundedWith((answer) => { answer.refunds.refundedProducts.listed = 2; })],
    ['a cut list said whole', refundedWith((answer) => { answer.refunds.refundedProducts.count = 3; })],
    ['refunded items not said', refundedWith((answer) => { delete (answer.refunds as Partial<RefundedAnswer['refunds']>).refundedProducts; })],
  ];
  for (const [label, answer] of refusals) assert.throws(() => parseAmazonSpending(answer, '60D'), AmazonAnswerError, label);
});

test('a list longer than the page reads is read in part, never a reason to refuse the whole answer', () => {
  const many = Array.from({ length: MAX_LISTED_PRODUCTS + 2000 }, (_, n) => ({
    ref: REF(100_000 + n), currency: 'USD', title: `Synthetic item ${n}`, asin: null, category: null, categorySource: null,
    quantity: 1, lines: 1, orders: 1, amountMinor: 1, lastOrderDate: '2026-10-01', lastOrderRef: REF(2) }));
  const answer = spendingWith((raw) => {
    const count = many.length;
    raw.orders = { ...raw.orders };
    raw.lines = { count, priced: count, noPrice: 0, noQuantity: 0, categorized: 0 };
    raw.totals = [{ ...raw.totals[0], itemMinor: count, categorizedMinor: 0 }];
    raw.categories = [{ currency: 'USD', category: null, amountMinor: count, lines: count, products: count, orders: 3 }];
    raw.products = many as unknown as typeof raw.products;
  });
  const spending = parseAmazonSpending(answer, '60D');
  assert.equal(spending.products.length, MAX_LISTED_PRODUCTS);
  assert.equal(spending.productsTruncated, true);
  assert.equal(parseAmazonSpending(SPENDING, '60D').productsTruncated, undefined);
});
