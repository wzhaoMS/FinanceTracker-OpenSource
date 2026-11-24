import { expect, test, type Page } from './fixtures';
import { computeCardInsights, summarizeCardSpending } from '@finance-tracker/shared';

/**
 * What the Amazon items were (the item taxonomy's drill-down in #/everyday/amazon) on synthetic answers: every
 * `/amazon/*` read and Everyday's card routes are served here, so nothing depends on the stack's data. Everything is
 * made up: refs, item names, ASINs and amounts.
 */

const ref = (n: number) => `amz-${n.toString(16).padStart(48, '0')}`;
type Json = Record<string, unknown>;

const SUMMARY = {
  measure: 'amazon-order-observations-not-card-spending', orders: 5, paymentObservations: 0, refundObservations: 1,
  issuedRefundObservations: 1, linked: 0, held: 0, unknownBeneficiary: 5, itemAttribution: 'unproven', coverage: [],
};
const ROW = { ref: ref(1), date: '2026-10-12', total: { currency: 'USD', amountMinor: 1798 }, beneficiary: 'unknown',
  tenderCoverage: 'unknown', paymentCoverage: 'held', itemObservations: 1 };

const PORK = 'Sample Pork Belly, Skin-On, 2 lb';
const CHIPS = 'Sample Sea Salt Kettle Chips (8-Pack)';
const RICE = 'Sample Jasmine Rice, 10 lb';
const ROUTER = 'Sample Mesh Wi-Fi Router Model R-1 (3-Pack)';
const MYSTERY = 'Sample Mystery Gadget Model X';

const purchase = (n: number, date: string, quantity: number, unitPriceMinor: number, refund: { minor: number; units: number } | null = null,
  orderRefunded = refund !== null) => ({
  ref: ref(100 + n), orderRef: ref(200 + n), orderDate: date, quantity, unitPriceMinor, amountMinor: quantity * unitPriceMinor,
  refundMinor: refund?.minor ?? 0, refundedQuantity: refund?.units ?? 0, orderRefunded,
});
const product = (n: number, title: string | null, node: string, purchases: ReturnType<typeof purchase>[], patch: Json = {}) => {
  const amountMinor = purchases.reduce((sum, p) => sum + p.amountMinor, 0), refundMinor = purchases.reduce((sum, p) => sum + p.refundMinor, 0);
  return {
    ref: purchases[0].ref, currency: 'USD', title: title ?? '[redacted]', asin: `B00000000${n}`, node, source: 'agent', confidence: 0.92,
    suggested: false, suggestion: null, cardCategory: 'Merchandise & Supplies-Internet Purchase', cardCategorySource: 'agent-classification',
    quantity: purchases.reduce((sum, p) => sum + p.quantity, 0), refundedQuantity: purchases.reduce((sum, p) => sum + p.refundedQuantity, 0),
    lines: purchases.length, orders: purchases.length, refundedOrders: purchases.filter((p) => p.orderRefunded).length,
    amountMinor, refundMinor, netMinor: amountMinor - refundMinor,
    lastOrderDate: purchases[0].orderDate, lastOrderRef: purchases[0].orderRef, purchases, ...patch,
  };
};
const PRODUCTS = [
  // Returned whole: Amazon's Refund Total for its order is exactly its price.
  product(1, ROUTER, 'electronics/networking', [purchase(1, '2026-09-25', 1, 12999, { minor: 12999, units: 1 })],
    { suggested: true, confidence: 0.7 }),
  product(2, PORK, 'groceries/meat-seafood', [purchase(2, '2026-10-12', 2, 899), purchase(3, '2026-08-30', 1, 949)]),
  // Its order has a refund Amazon's records don't tie to an item.
  product(3, MYSTERY, 'needs-review', [purchase(4, '2026-08-30', 1, 2500, null, true)], { source: null, confidence: null, cardCategory: null,
    cardCategorySource: null, suggestion: { node: 'toys-hobbies/rc-drones', confidence: 0.4 } }),
  product(4, RICE, 'groceries', [purchase(5, '2026-07-01', 1, 1999)], { source: 'owner', confidence: 1 }),
  product(5, CHIPS, 'groceries/snacks-sweets', [purchase(6, '2026-10-12', 3, 299)]),
  product(6, null, 'needs-review', [purchase(7, '2026-06-01', 1, 700)], { source: null, confidence: null, cardCategory: null, cardCategorySource: null }),
].sort((a, b) => b.netMinor - a.netMinor || b.amountMinor - a.amountMinor);
const node = (id: string, amountMinor: number, refundMinor: number, lines: number, products: number, orders: number, refundedOrders = 0) =>
  ({ currency: 'USD', node: id, amountMinor, refundMinor, netMinor: amountMinor - refundMinor, lines, refundedLines: refundMinor > 0 ? 1 : 0,
    products, orders, refundedOrders });
/** The year to Oct 19, 2026, added up as the API adds it. */
const TAXONOMY = {
  measure: 'amazon-order-item-prices-not-card-spending', window: { key: '1Y', from: '2025-10-20', to: '2026-10-19' },
  taxonomy: { version: 1, digest: 'a'.repeat(64), assignments: 'present' },
  orders: { count: 7, refunded: 2 },
  lines: { count: 8, priced: 7, noPrice: 1, noQuantity: 0, assigned: 5, suggested: 1, needsReview: 2 },
  totals: [{ currency: 'USD', itemMinor: 21842, assignedMinor: 18642, suggestedMinor: 12999, needsReviewMinor: 3200, refundMinor: 15499,
    itemRefundMinor: 12999, unattributedRefundMinor: 2500, netItemMinor: 6343 }],
  nodes: [
    node('groceries', 5643, 0, 4, 3, 4), node('needs-review', 3200, 0, 2, 2, 2, 1), node('groceries/meat-seafood', 2747, 0, 2, 1, 2),
    node('groceries/snacks-sweets', 897, 0, 1, 1, 1), node('electronics', 12999, 12999, 1, 1, 1, 1),
    node('electronics/networking', 12999, 12999, 1, 1, 1, 1),
  ],
  products: PRODUCTS,
};
async function serve(page: Page, taxonomy: Json | null, spending: Json | null = null): Promise<string[]> {
  const requests: string[] = [];
  await page.route((url) => url.pathname.startsWith('/amazon/'), (route) => {
    const url = new URL(route.request().url());
    requests.push(`${url.pathname}${url.search}`);
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/amazon/summary') return json(200, SUMMARY);
    if (url.pathname === '/amazon/orders') return json(200, { total: 1, orders: [ROW] });
    if (url.pathname === '/amazon/spending/taxonomy' && taxonomy && url.searchParams.get('window') === '1Y') return json(200, taxonomy);
    if (url.pathname === '/amazon/spending' && spending && url.searchParams.get('window') === '30D') return json(200, spending);
    return json(404, { error: 'not-found' });
  });
  await page.route((url) => /^\/(?:card-accounts|card-imports|card-transactions|spending)(?:[/?]|$)/.test(url.pathname), (route) => {
    const url = new URL(route.request().url());
    let body: unknown = null;
    if (url.pathname === '/card-accounts') body = { cardAccounts: [] };
    if (url.pathname === '/spending/coverage') body = { cards: [] };
    if (url.pathname === '/spending/summary') body = { ...summarizeCardSpending([], { owners: new Map() }), categories: [] };
    if (url.pathname === '/spending/insights') body = computeCardInsights([], { month: '2026-10', today: '2026-10-17', currency: 'USD' });
    if (url.pathname === '/card-transactions') body = { transactions: [], total: 0, limit: 100, offset: 0, nextOffset: null };
    return route.fulfill(body === null
      ? { status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }) }
      : { status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route((url) => url.pathname.startsWith('/card-sync/'), (route) => route.fulfill({
    status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }),
  }));
  return requests;
}

const panel = (page: Page) => page.getByRole('region', { name: 'What the Amazon items were' });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
async function openAmazon(page: Page): Promise<void> {
  await page.goto('/#/everyday/amazon');
  await expect(page.getByRole('tablist', { name: 'Spending areas' }).getByRole('tab', { name: 'Amazon', exact: true }))
    .toHaveAttribute('aria-selected', 'true');
}

/**
 * Visible text in the Amazon area below its floor (the readability round's D1): 14px for everything (help, labels,
 * status, actions and badges alike), its section heads 18px, 20px from 1280px wide; a line-height of 1.5 for running
 * text, 1.25 for headings, single-line controls, chips, badges and figures; and every paragraph within 65ch of its own
 * font. Text that isn't drawn (a closed fold's, a hidden tab's, words only for screen readers) has no size to read.
 */
function textBelowFloors(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const badges = '.amazon-taxonomy-badge, .amazon-match-times';
    const tight = `h1, h2, h3, h4, h5, h6, button:not(.spending-rank-row), select, [role="tab"], .amazon-figure-value, .amazon-measure,
      .amazon-category-name, .amazon-fact, .amazon-coverage-entry, .amazon-refund-badge, ${badges}`;
    const section = window.innerWidth >= 1280 ? 20 : 18;
    const drawn = (element: Element) => !element.closest('.visually-hidden') && element.checkVisibility()
      && getComputedStyle(element).visibility === 'visible';
    const found: string[] = [];
    for (const root of document.querySelectorAll('.amazon')) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const element = node.parentElement;
        const text = node.textContent?.trim();
        if (!text || !element || !drawn(element)) continue;
        const style = getComputedStyle(element);
        const size = parseFloat(style.fontSize);
        const floor = element.closest('h2, h3') ? section : 14;
        const what = `${element.className || element.localName} "${text.slice(0, 40)}"`;
        if (size < floor) found.push(`${size}px, under ${floor}px: ${what}`);
        const leading = style.lineHeight === 'normal' ? 0 : parseFloat(style.lineHeight) / size;
        const least = element.closest(tight) ? 1.25 : 1.5;
        if (leading < least - 0.005) found.push(`line-height ${style.lineHeight} (${leading.toFixed(2)}), under ${least}: ${what}`);
      }
      // A paragraph keeps to 65ch of its own font, however wide the page is.
      for (const paragraph of root.querySelectorAll('p')) {
        const text = (paragraph.textContent ?? '').trim();
        if (!text || !drawn(paragraph)) continue;
        const probe = document.createElement('span');
        probe.style.cssText = 'position: absolute; visibility: hidden; width: 65ch; height: 0; padding: 0; border: 0;';
        paragraph.appendChild(probe);
        const measure = probe.getBoundingClientRect().width;
        probe.remove();
        const style = getComputedStyle(paragraph);
        const width = paragraph.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
          - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
        if (width > measure + 1) found.push(`${Math.round(width)}px wide, over 65ch (${Math.round(measure)}px): ${paragraph.className || 'p'} "${text.slice(0, 40)}"`);
      }
    }
    return found;
  });
}

test.use({ timezoneId: 'UTC', locale: 'en-US', viewport: { width: 1280, height: 900 } });

test.beforeAll(async ({ request }) => {
  const health = await request.get('/health').catch(() => null);
  test.skip(!health || !health.ok(), 'The stack behind WEB_URL is unavailable.');
});

test('drills from category to subcategory to each item\'s purchases, and lists exactly what needs review', async ({ page }) => {
  const requests = await serve(page, TAXONOMY);
  await openAmazon(page);
  const items = panel(page);
  const figure = (label: string) => items.locator('.amazon-figure').filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) });
  await expect(figure('Spent on items')).toContainText('$218.42');
  await expect(figure('Refunded')).toContainText('−$154.99');
  await expect(figure('Refunded')).toContainText('2 orders, $25.00 not tied to an item');
  await expect(figure('Net of refunds')).toContainText('$63.43');
  await expect(figure('Classified')).toContainText('$186.42');
  await expect(figure('Classified')).toContainText('$129.99 only suggested');
  await expect(figure('Needs review')).toContainText('2 items not classified yet');
  const categories = items.getByRole('list', { name: 'Categories, largest first' });
  // After refunds: the returned router leaves Electronics at $0.00, below Groceries; Needs review is always last.
  await expect(categories.locator('.spending-rank-row .spending-rank-name')).toHaveText(['Groceries', 'Electronics', 'Needs review']);
  await expect(categories.locator('.spending-rank-row').nth(1)).toContainText('$129.99 refunded of $129.99');
  await expect(categories.locator('.amazon-unattributed-refunds')).toContainText('Refunded, not tied to an item');
  await expect(categories.locator('.amazon-unattributed-refunds')).toContainText('−$25.00');
  // Before any choice: the largest items, wherever they're filed, with what they are and who said so.
  const router = items.getByRole('list', { name: 'Items, largest first' }).locator('.amazon-spend-item').filter({ hasText: ROUTER });
  await expect(router).toContainText(ROUTER);
  await expect(router.locator('.amazon-category-name')).toHaveText('Electronics › Networking');
  await expect(router.locator('.amazon-taxonomy-badge')).toHaveText('Suggested');
  await expect(router).toContainText('suggested from its title, 70% sure');
  await expect(router).toContainText('Card category: Internet Purchase');
  await expect(router.locator('.amazon-spend-amount')).toHaveText('$129.99 $0.00');
  await expect(router.locator('.amazon-item-meta')).toContainText('1 refunded');
  await expect(router.locator('.amazon-fact')).toHaveText('Refunded $129.99 (1 unit)');

  await items.getByRole('button', { name: /^Groceries/ }).click();
  await expect(items.getByRole('navigation', { name: 'Category path' })).toContainText('Every category › Groceries');
  const subs = items.getByRole('list', { name: 'Groceries by subcategory, largest first' }).locator('.spending-rank-name');
  await expect(subs).toHaveText(['Meat & Seafood', 'Snacks & Sweets', 'Other Groceries']);
  await expect(items.getByRole('list', { name: 'Items in Groceries, largest first' }).locator('.amazon-spend-item')).toHaveCount(3);

  await items.getByRole('button', { name: /^Meat & Seafood/ }).click();
  const meat = items.getByRole('list', { name: 'Items in Meat & Seafood, largest first' }).locator('.amazon-spend-item');
  await expect(meat).toHaveCount(1);
  await expect(meat).toContainText(PORK);
  await expect(meat).toContainText('Qty 3');
  const purchases = meat.getByRole('list', { name: `Purchases of ${PORK}, latest first` }).getByRole('listitem');
  await expect(purchases).toHaveCount(2);
  await expect(purchases.first()).toContainText('Oct 12, 2026');
  await expect(purchases.first()).toContainText('2 × $8.99 = $17.98');
  await expect(purchases.last()).toContainText('$9.49');
  await expect(purchases.first().getByRole('link', { name: 'Amazon order of Oct 12, 2026' })).toHaveAttribute('href', `#/everyday/amazon/orders/${ref(202)}`);

  await items.getByRole('navigation', { name: 'Category path' }).getByRole('button', { name: 'Groceries' }).click();
  await items.getByRole('button', { name: /^Other Groceries/ }).click();
  await expect(items.getByRole('list', { name: 'Items in Other Groceries, largest first' })).toContainText(RICE);
  await expect(items.getByRole('list', { name: 'Items in Other Groceries, largest first' })).toContainText('your choice');

  await items.getByRole('button', { name: 'Every category' }).click();
  await items.getByRole('button', { name: /^Needs review/ }).click();
  await expect(items.getByRole('heading', { name: 'Needs review: what each item is' })).toBeVisible();
  const review = items.getByRole('list', { name: 'Items in Needs review, largest first' }).locator('.amazon-spend-item');
  await expect(review).toHaveCount(2);
  await expect(review.first()).toContainText(MYSTERY);
  await expect(review.first()).toContainText('best guess Toys, Hobbies & RC › RC & Drones, only 40% sure');
  await expect(review.first()).toContainText('Uncategorized on cards');
  await expect(review.first().locator('.amazon-fact')).toHaveText('Order has a refund');
  await expect(review.last().locator('.amazon-hidden-title')).toHaveText('Title hidden: it looked like card details');
  await expect(review.last()).toContainText('not classified yet');

  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(new Set(requests.filter((request) => request.startsWith('/amazon/spending/taxonomy'))
    .map((request) => new URL(request, 'http://synthetic.invalid').searchParams.get('window')))).toEqual(new Set(['1Y']));
});

test('an answer that doesn\'t add up is an error with a retry, and an API without the read shows nothing', async ({ page }) => {
  await serve(page, { ...TAXONOMY, totals: [{ ...TAXONOMY.totals[0], itemMinor: 1 }] });
  await openAmazon(page);
  await expect(panel(page).getByRole('alert')).toContainText('Holdr couldn\'t read the Amazon answer (totals).');
  await expect(panel(page).locator('.amazon-figure')).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: 'Try again' })).toBeVisible();

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await serve(page, null);
  await openAmazon(page);
  await page.reload();
  await expect(page.locator('.amazon-order')).toHaveCount(1);
  await expect(panel(page)).toHaveCount(0);
});

/** Two Amazon Fresh orders' lines (pork by weight, eggs nobody classified, one item not delivered) and a returned router. */
const FRESH_PART = { orders: 2, lines: { priced: 3, missing: 1, unreadable: 0 },
  totals: [{ currency: 'USD', lineMinor: 1318, refundMinor: 0, lineRefundMinor: 0, unattributedRefundMinor: 0, netLineMinor: 1318 }] };
const FRESH_PORK = 'Sample Fresh Pork Shoulder, Bone-In';
const FRESH_EGGS = 'Sample Fresh Large Eggs, 12 Count';
const pound = (value: string) => ({ value, unit: 'lb', basis: 'actual' });
const perPound = { money: { currency: 'USD', amountMinor: 399 }, per: 'lb' };
const freshPurchase = (n: number, date: string, amountMinor: number, fresh: Json) => ({ ref: ref(300 + n), orderRef: ref(400 + n), orderDate: date,
  quantity: 1, unitPriceMinor: amountMinor, amountMinor, refundMinor: 0, refundedQuantity: 0, orderRefunded: false, fresh });
const FRESH_PRODUCTS = [
  product(7, FRESH_PORK, 'groceries/meat-seafood', [
    freshPurchase(1, '2026-10-12', 499, { status: 'listed', quantity: 1, weight: pound('1.25'), unitPrice: perPound }),
    freshPurchase(2, '2026-09-20', 319, { status: 'substituted', quantity: 1, weight: pound('0.80'), unitPrice: perPound })],
  { source: 'owner', confidence: 1, cardCategory: null, cardCategorySource: null, quantity: 2, orders: 2,
    fresh: { quantity: 2, weight: { value: '2.05', unit: 'lb', estimated: false } } }),
  product(8, FRESH_EGGS, 'needs-review', [{ ...freshPurchase(3, '2026-10-12', 500, { status: 'listed', quantity: 2, weight: null,
    unitPrice: { money: { currency: 'USD', amountMinor: 250 }, per: 'each' } }), quantity: 2, unitPriceMinor: 250, orderRef: ref(401) }],
  { source: null, confidence: null, cardCategory: null, cardCategorySource: null, quantity: 2, fresh: { quantity: 2, weight: null } }),
];
const ROUTER_ONLY = PRODUCTS.find((p) => p.title === ROUTER)!;
const TAXONOMY_FRESH = {
  ...TAXONOMY,
  orders: { count: 3, refunded: 1 },
  lines: { count: 4, priced: 4, noPrice: 0, noQuantity: 0, assigned: 3, suggested: 1, needsReview: 1 },
  totals: [{ currency: 'USD', itemMinor: 14317, assignedMinor: 13817, suggestedMinor: 12999, needsReviewMinor: 500, refundMinor: 12999,
    itemRefundMinor: 12999, unattributedRefundMinor: 0, netItemMinor: 1318 }],
  nodes: [node('groceries', 818, 0, 2, 1, 2), node('groceries/meat-seafood', 818, 0, 2, 1, 2), node('needs-review', 500, 0, 1, 1, 1),
    node('electronics', 12999, 12999, 1, 1, 1, 1), node('electronics/networking', 12999, 12999, 1, 1, 1, 1)],
  products: [...FRESH_PRODUCTS, ROUTER_ONLY],
  fresh: FRESH_PART,
};
const GROCERIES_CARD = 'Merchandise & Supplies-Groceries';
const SPENDING_FRESH = {
  measure: 'amazon-order-item-prices-not-card-spending', window: { key: '30D', from: '2026-09-20', to: '2026-10-19' },
  version: 'amazon-v1-000000000000000000000000',
  orders: { count: 3, withTotal: 3, itemsComplete: 2, noLines: 0, refunded: 1, linked: 0, held: 0, unmatched: 3 },
  cardCharges: { linked: 0, itemized: 0 },
  lines: { count: 4, priced: 4, noPrice: 0, noQuantity: 0, categorized: 4 },
  totals: [{ currency: 'USD', orderTotalMinor: 15000, itemsCompleteOrderTotalMinor: 14000, itemMinor: 14317, categorizedMinor: 14317,
    refundMinor: 12999, itemRefundMinor: 12999, unattributedRefundMinor: 0, netItemMinor: 1318 }],
  categories: [
    { currency: 'USD', category: GROCERIES_CARD, amountMinor: 1318, lines: 3, products: 2, orders: 2, refundMinor: 0, netMinor: 1318, refundedLines: 0 },
    { currency: 'USD', category: 'Merchandise & Supplies-Computer Supplies', amountMinor: 12999, lines: 1, products: 1, orders: 1,
      refundMinor: 12999, netMinor: 0, refundedLines: 1 },
  ],
  products: [
    { ref: ref(301), currency: 'USD', title: FRESH_PORK, asin: 'B000000007', category: GROCERIES_CARD, categorySource: 'item-taxonomy', quantity: 2,
      lines: 2, orders: 2, amountMinor: 818, lastOrderDate: '2026-10-12', lastOrderRef: ref(401), refundMinor: 0, netMinor: 818, refundedQuantity: 0,
      fresh: { quantity: 2, weight: { value: '2.05', unit: 'lb', estimated: false } } },
    { ref: ref(303), currency: 'USD', title: FRESH_EGGS, asin: 'B000000008', category: GROCERIES_CARD, categorySource: 'fresh-default', quantity: 2,
      lines: 1, orders: 1, amountMinor: 500, lastOrderDate: '2026-10-12', lastOrderRef: ref(401), refundMinor: 0, netMinor: 500, refundedQuantity: 0,
      fresh: { quantity: 2, weight: null } },
    { ref: ref(101), currency: 'USD', title: ROUTER, asin: 'B000000001', category: 'Merchandise & Supplies-Computer Supplies',
      categorySource: 'agent-classification', quantity: 1, lines: 1, orders: 1, amountMinor: 12999, lastOrderDate: '2026-09-25',
      lastOrderRef: ref(201), refundMinor: 12999, netMinor: 0, refundedQuantity: 1 },
  ],
  refunds: { policy: 'amazon-refund-attribution-v1', orders: [{ basis: 'units', orders: 1 }], unattributed: [],
    sources: [{ source: 'order-summary', orders: 1 }], ledgerRefunds: 0, ledgerObservations: 0, refundTotals: 1, refundTotalObservations: 1,
    excluded: [], refundedProducts: { count: 1, listed: 1, truncated: false } },
  fresh: FRESH_PART,
};

test('Amazon Fresh lines count in both item views: by what each list showed, under Groceries as a default until classified', async ({ page }) => {
  await serve(page, TAXONOMY_FRESH, SPENDING_FRESH);
  await openAmazon(page);
  // By card category: each Fresh line under its item category's card category, or Groceries' as a visible default.
  const cards = page.getByRole('region', { name: 'Amazon spending by item and category' });
  const coverage = cards.getByRole('list', { name: 'What these figures cover' });
  await expect(coverage).toContainText('Amazon Fresh: 2 orders count by their Fresh item lists here: 3 items, $13.18');
  await expect(coverage).toContainText('Not counted from Fresh item lists: 1 item not delivered, never charged');
  await expect(coverage).toContainText('Splitting a Fresh order\'s card charge by its Fresh item list in Spending isn\'t done yet');
  const cardItems = cards.getByRole('list', { name: 'Items, largest first' }).locator('.amazon-spend-item');
  const eggs = cardItems.filter({ hasText: FRESH_EGGS }), pork = cardItems.filter({ hasText: FRESH_PORK });
  await expect(eggs.locator('.amazon-category-name')).toHaveText(GROCERIES_CARD);
  await expect(eggs.locator('.amazon-category-source')).toHaveText('(Amazon Fresh default until it is classified)');
  await expect(eggs.locator('.amazon-taxonomy-badge')).toHaveText('Amazon Fresh');
  await expect(pork.locator('.amazon-category-source')).toHaveText('(from its item category)');
  await expect(pork.locator('.amazon-fresh-measure')).toHaveText('Qty 2 · 2.05 lb');

  // By item category: the Fresh pork in Meat & Seafood with each purchase as its list showed it, the eggs in Needs review.
  const items = panel(page);
  await expect(items.getByRole('list', { name: 'What these figures cover' }))
    .toContainText('Amazon Fresh: 2 orders count by their Fresh item lists here: 3 items, $13.18');
  await expect(items.getByRole('list', { name: 'What these figures cover' })).not.toContainText('Spending isn\'t done yet');
  await items.getByRole('button', { name: /^Groceries/ }).click();
  await items.getByRole('button', { name: /^Meat & Seafood/ }).click();
  const meat = items.getByRole('list', { name: 'Items in Meat & Seafood, largest first' }).locator('.amazon-spend-item');
  await expect(meat).toHaveCount(1);
  await expect(meat.locator('.amazon-item-meta .amazon-fresh-measure')).toHaveText('Qty 2 · 2.05 lb');
  await expect(meat.locator('.amazon-item-meta .amazon-taxonomy-badge')).toHaveText('Amazon Fresh');
  await expect(meat).not.toContainText('Card category');
  const purchases = meat.getByRole('list', { name: `Purchases of ${FRESH_PORK}, latest first` }).getByRole('listitem');
  await expect(purchases.first()).toContainText('1.25 lb at $3.99/lb');
  await expect(purchases.first().locator('.amazon-amount')).toHaveText('$4.99');
  await expect(purchases.last()).toContainText('0.80 lb at $3.99/lb');
  await expect(purchases.last().locator('.amazon-fact')).toHaveText('Substitute');
  await items.getByRole('button', { name: 'Every category' }).click();
  await items.getByRole('button', { name: /^Needs review/ }).click();
  const review = items.getByRole('list', { name: 'Items in Needs review, largest first' }).locator('.amazon-spend-item');
  await expect(review).toHaveCount(1);
  await expect(review).toContainText(FRESH_EGGS);
  await expect(review).toContainText('not classified yet');
  expect(await overflow(page)).toBeLessThanOrEqual(0);
});

test('every text in the item drill-down reads at its floor at 1920 and 375px: rows, the path, badges, purchases and an error', async ({ page }) => {
  await serve(page, TAXONOMY);
  for (const width of [1920, 375]) {
    const where = `${width}px`;
    await page.setViewportSize({ width, height: 900 });
    await openAmazon(page);
    await page.reload();
    const items = panel(page);
    await expect(items.getByRole('list', { name: 'Items, largest first' }).locator('.amazon-taxonomy-badge')).toHaveText(['Suggested']);
    await items.getByRole('button', { name: /^Groceries/ }).click();
    await items.getByRole('button', { name: /^Meat & Seafood/ }).click();
    await expect(items.getByRole('navigation', { name: 'Category path' })).toContainText('Every category › Groceries › Meat & Seafood');
    await expect(items.getByRole('list', { name: `Purchases of ${PORK}, latest first` }).getByRole('listitem')).toHaveCount(2);
    expect(await textBelowFloors(page), `the drill-down at ${where}`).toEqual([]);
    const drawn = await page.locator('.amazon-taxonomy .spending-rank-name, .amazon-taxonomy .amazon-item-title, .amazon-taxonomy .amazon-spend-amount')
      .evaluateAll((elements) => elements.map((element) => parseFloat(getComputedStyle(element).fontSize)));
    expect(drawn.length).toBeGreaterThan(0);
    for (const size of drawn) expect(size, `reading text at ${where}`).toBeGreaterThanOrEqual(16);
    expect(await overflow(page), where).toBeLessThanOrEqual(0);
  }
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await serve(page, { ...TAXONOMY, totals: [{ ...TAXONOMY.totals[0], itemMinor: 1 }] });
  for (const width of [1920, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    await expect(panel(page).getByRole('alert')).toBeVisible();
    expect(await textBelowFloors(page), `an error at ${width}px`).toEqual([]);
  }
});
