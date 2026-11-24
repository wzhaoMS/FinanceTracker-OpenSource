import { expect, test, type Page } from './fixtures';
import { computeCardInsights, summarizeCardSpending } from '@finance-tracker/shared';

/**
 * The Amazon area's Amazon Fresh tab (#/everyday/amazon/fresh) on synthetic answers: every `/amazon/*` read and
 * Everyday's card routes are served here, so nothing depends on the stack's data. Everything is made up: refs, item
 * names, ASINs, weights and amounts.
 */

const ref = (n: number) => `amz-${n.toString(16).padStart(48, '0')}`;
type Json = Record<string, unknown>;
const usd = (amountMinor: number) => ({ currency: 'USD', amountMinor });
const lb = (value: string, basis = 'actual') => ({ value, unit: 'lb', basis });
const perLb = (amountMinor: number) => ({ money: usd(amountMinor), per: 'lb' });
const perEach = (amountMinor: number) => ({ money: usd(amountMinor), per: 'each' });

/** Three Fresh orders, newest first: Oct 12 and Oct 5 (whole lists), Sep 20 (a row unread, a substitute, a missing item). */
const O1 = { ref: ref(201), date: '2026-10-12' }, O2 = { ref: ref(202), date: '2026-10-05' }, O3 = { ref: ref(203), date: '2026-09-20' };
const PORK = 'Sample Pork Shoulder, Bone-In', SALMON = 'Sample Wild Salmon Fillet', EGGS = 'Sample Large Brown Eggs, 12 Count';
const MILK = 'Sample Whole Milk, 1 Gallon', YOGURT = 'Sample Greek Yogurt, 32 oz', BANANAS = 'Sample Organic Bananas';
const CHIPS = 'Sample Sea Salt Kettle Chips', CHOCOLATE = 'Sample Dark Chocolate Bar', BREAD = 'Sample Sourdough Bread';
const WATER = 'Sample Sparkling Water, 12 Pack', TOWELS = 'Sample Paper Towels, 6 Rolls', MYSTERY = 'Sample Mystery Snack Mix';
const RICE = 'Sample Jasmine Rice, 5 lb';

let lineRef = 100;
const buy = (order: { ref: string; date: string }, amountMinor: number, patch: Json = {}) => ({
  ref: ref(lineRef++), orderRef: order.ref, orderDate: order.date, status: 'listed', quantity: 1, weight: null, unitPrice: null,
  amountMinor, refundMinor: 0, ...patch,
});
const filed = (category: string, group: string, node = category, patch: Json = {}) => ({
  category, group, node, source: 'owner', confidence: 1, suggested: false, suggestion: null, ...patch,
});
const product = (title: string, asin: string | null, where: Json, purchases: Array<ReturnType<typeof buy>>, patch: Json = {}) => {
  const amountMinor = purchases.reduce((sum, p) => sum + p.amountMinor, 0), refundMinor = purchases.reduce((sum, p) => sum + p.refundMinor, 0);
  return {
    ref: purchases[0].ref, currency: 'USD', title, asin, ...where, amountMinor, refundMinor, netMinor: amountMinor - refundMinor,
    lines: purchases.length, orders: new Set(purchases.map((p) => p.orderRef)).size,
    quantity: purchases.reduce((sum, p) => sum + (p.quantity ?? 0), 0), weight: null, lastUnitPrice: purchases[0].unitPrice,
    lastOrderDate: purchases[0].orderDate, lastOrderRef: purchases[0].orderRef, purchases, ...patch,
  };
};
const PRODUCTS = [
  product(PORK, 'B0SAMPLE01', filed('groceries/meat-seafood', 'groceries'), [
    buy(O1, 938, { weight: lb('2.35'), unitPrice: perLb(399) }), buy(O3, 718, { weight: lb('1.80'), unitPrice: perLb(399) })],
  { weight: { value: '4.15', unit: 'lb', estimated: false } }),
  product(SALMON, 'B0SAMPLE02', filed('groceries/meat-seafood', 'groceries', undefined, { source: 'agent', confidence: 0.92 }), [
    buy(O2, 1429, { weight: lb('1.10'), unitPrice: perLb(1299) })], { weight: { value: '1.1', unit: 'lb', estimated: false } }),
  product(EGGS, 'B0SAMPLE03', filed('groceries/dairy-eggs', 'groceries', undefined, { source: 'agent', confidence: 0.95 }), [
    buy(O1, 898, { quantity: 2, unitPrice: perEach(449) }), buy(O3, 449, { unitPrice: perEach(449) })]),
  product(TOWELS, 'B0SAMPLE04', filed('household', 'other', 'household/paper-disposables'), [buy(O1, 1299, { unitPrice: perEach(1299) })]),
  product(CHOCOLATE, 'B0SAMPLE05', filed('groceries/snacks-sweets', 'groceries', undefined, { source: 'agent', confidence: 0.9 }), [
    buy(O1, 897, { quantity: 3, unitPrice: perEach(299) })]),
  product(RICE, 'B0SAMPLE06', filed('groceries', 'groceries'), [buy(O2, 849, { unitPrice: perEach(849) })]),
  product(WATER, 'B0SAMPLE07', filed('groceries/beverages', 'groceries'), [buy(O3, 599, { unitPrice: perEach(599) })]),
  product(YOGURT, 'B0SAMPLE08', filed('groceries/dairy-eggs', 'groceries'), [buy(O3, 549, { status: 'substituted', unitPrice: perEach(549) })]),
  product(BREAD, 'B0SAMPLE09', filed('groceries/bakery-bread', 'groceries'), [buy(O2, 499, { unitPrice: perEach(499) })]),
  product(MILK, 'B0SAMPLE10', filed('groceries/dairy-eggs', 'groceries'), [buy(O1, 379, { unitPrice: perEach(379) })]),
  product(MYSTERY, null, filed('needs-review', 'needs-review', undefined, { source: null, confidence: null,
    suggestion: { node: 'groceries/snacks-sweets', confidence: 0.5 } }), [buy(O3, 349, { unitPrice: perEach(349) })]),
  product(BANANAS, 'B0SAMPLE11', filed('groceries/produce', 'groceries'), [
    buy(O1, 124, { weight: lb('2.10', 'estimated'), unitPrice: perLb(59) })], { weight: { value: '2.1', unit: 'lb', estimated: true } }),
  // Returned whole: Amazon's records tie the order's refund to exactly these two bags.
  product(CHIPS, 'B0SAMPLE12', filed('groceries/snacks-sweets', 'groceries', undefined, { source: 'agent', confidence: 0.7, suggested: true }), [
    buy(O2, 658, { quantity: 2, unitPrice: perEach(329), refundMinor: 658 })]),
];
const category = (id: string, group: string, amountMinor: number, refundMinor: number, lines: number, products: number, orders: number) =>
  ({ currency: 'USD', category: id, group, amountMinor, refundMinor, netMinor: amountMinor - refundMinor, lines,
    refundedLines: refundMinor > 0 ? 1 : 0, products, orders });
const FRESH = {
  measure: 'amazon-fresh-item-prices-not-card-spending', window: { key: '1Y', from: '2025-10-20', to: '2026-10-19' }, captured: true,
  taxonomy: { version: 1, digest: 'a'.repeat(64), assignments: 'present' },
  orders: { count: 3, withTotal: 3, complete: 2, reconciled: 2, refunded: 2, unreadable: 0, noLines: 0 },
  lines: { count: 16, priced: 15, noPrice: 0, missing: 1, substituted: 1, estimated: 1, categorized: 14, suggested: 1, needsReview: 1,
    refunded: 1, unreadable: 0 },
  totals: [{ currency: 'USD', orderTotalMinor: 12428, lineMinor: 10634, groceryMinor: 8986, categorizedMinor: 10285, suggestedMinor: 658,
    needsReviewMinor: 349, refundMinor: 1191, lineRefundMinor: 658, unattributedRefundMinor: 500, netLineMinor: 9476 }],
  categories: [
    category('groceries/meat-seafood', 'groceries', 3085, 0, 3, 2, 3), category('groceries/dairy-eggs', 'groceries', 2275, 0, 4, 3, 2),
    category('groceries/snacks-sweets', 'groceries', 1555, 658, 2, 2, 2), category('groceries', 'groceries', 849, 0, 1, 1, 1),
    category('groceries/beverages', 'groceries', 599, 0, 1, 1, 1), category('groceries/bakery-bread', 'groceries', 499, 0, 1, 1, 1),
    category('groceries/produce', 'groceries', 124, 0, 1, 1, 1), category('household', 'other', 1299, 0, 1, 1, 1),
    category('needs-review', 'needs-review', 349, 0, 1, 1, 1),
  ],
  products: PRODUCTS,
  orderList: [
    { ...O1, total: usd(5155), lines: 6, priced: 6, missing: 0, substituted: 0, unreadable: 0, unreadRows: 0, lineTotal: usd(4535),
      complete: true, reconciled: true, refund: null },
    { ...O2, total: usd(4134), lines: 4, priced: 4, missing: 0, substituted: 0, unreadable: 0, unreadRows: 0, lineTotal: usd(3435),
      complete: true, reconciled: true, refund: { currency: 'USD', refundMinor: 691, basis: 'units', lineRefundMinor: 658, unattributedMinor: 0 } },
    { ...O3, total: usd(3139), lines: 6, priced: 5, missing: 1, substituted: 1, unreadable: 0, unreadRows: 1, lineTotal: usd(2664),
      complete: false, reconciled: false,
      refund: { currency: 'USD', refundMinor: 500, basis: 'unattributed', lineRefundMinor: 0, unattributedMinor: 500 } },
  ],
};
/** The Sep 20 order's Item List, as GET /amazon/fresh/orders/:ref answers it. */
const line = (n: number, title: string, status: string, linePrice: Json | null, where: Json, patch: Json = {}) => ({
  ref: ref(300 + n), lineOrdinal: n, title, asin: null, status, quantity: 1, weight: null, unitPrice: null, linePrice, replaces: null,
  ...where, refundMinor: 0, ...patch,
});
const O3_LIST = { order: { ref: O3.ref, date: O3.date, total: usd(3139),
  refund: { currency: 'USD', refundMinor: 500, basis: 'unattributed', lineRefundMinor: 0, unattributedMinor: 500 },
  list: { statedCount: 7, rows: 7, unreadRows: 1, lines: 6, unreadable: 0, complete: false, reconciled: false },
  lines: [
    line(0, PORK, 'listed', usd(718), filed('groceries/meat-seafood', 'groceries'), { weight: lb('1.80'), unitPrice: perLb(399) }),
    line(1, EGGS, 'listed', usd(449), filed('groceries/dairy-eggs', 'groceries', undefined, { source: 'agent', confidence: 0.95 }),
      { unitPrice: perEach(449) }),
    line(2, YOGURT, 'substituted', usd(549), filed('groceries/dairy-eggs', 'groceries'), { unitPrice: perEach(549),
      replaces: 'Sample Plain Yogurt, 32 oz' }),
    line(3, WATER, 'listed', usd(599), filed('groceries/beverages', 'groceries'), { unitPrice: perEach(599) }),
    line(4, MYSTERY, 'listed', usd(349), filed('needs-review', 'needs-review', undefined, { source: null, confidence: null,
      suggestion: { node: 'groceries/snacks-sweets', confidence: 0.5 } }), { unitPrice: perEach(349) }),
    line(5, 'Sample Blueberries, 6 oz', 'missing', usd(399), filed('needs-review', 'needs-review', undefined, { source: null, confidence: null }),
      { unitPrice: perEach(399) }),
  ] } };

const NOT_CAPTURED = { ...FRESH, captured: false, taxonomy: { ...FRESH.taxonomy, assignments: 'absent' },
  orders: { count: 0, withTotal: 0, complete: 0, reconciled: 0, refunded: 0, unreadable: 0, noLines: 0 },
  lines: { count: 0, priced: 0, noPrice: 0, missing: 0, substituted: 0, estimated: 0, categorized: 0, suggested: 0, needsReview: 0,
    refunded: 0, unreadable: 0 }, totals: [], categories: [], products: [], orderList: [] };

const SUMMARY = {
  measure: 'amazon-order-observations-not-card-spending', orders: 3, paymentObservations: 0, refundObservations: 0,
  issuedRefundObservations: 0, linked: 0, held: 0, unknownBeneficiary: 3, itemAttribution: 'unproven', coverage: [],
};
const ROW = { ref: O1.ref, date: O1.date, total: usd(5155), beneficiary: 'unknown', tenderCoverage: 'unknown', paymentCoverage: 'held',
  itemObservations: 0 };

async function serve(page: Page, fresh: Json | null, detail: Json = O3_LIST): Promise<string[]> {
  const requests: string[] = [];
  await page.route((url) => url.pathname.startsWith('/amazon/'), (route) => {
    const url = new URL(route.request().url());
    requests.push(`${url.pathname}${url.search}`);
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/amazon/summary') return json(200, SUMMARY);
    if (url.pathname === '/amazon/orders') return json(200, { total: 1, orders: [ROW] });
    if (url.pathname === '/amazon/fresh' && fresh && url.searchParams.get('window') === '1Y') return json(200, fresh);
    if (url.pathname === `/amazon/fresh/orders/${O3.ref}` && fresh) return json(200, detail);
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

const views = (page: Page) => page.getByRole('tablist', { name: 'Amazon views' });
const panel = (page: Page) => page.getByRole('region', { name: 'Amazon Fresh' });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
async function openFresh(page: Page): Promise<void> {
  await page.goto('/#/everyday/amazon/fresh');
  await expect(page.getByRole('tablist', { name: 'Spending areas' }).getByRole('tab', { name: 'Amazon', exact: true }))
    .toHaveAttribute('aria-selected', 'true');
  await expect(views(page).getByRole('tab', { name: 'Amazon Fresh' })).toHaveAttribute('aria-selected', 'true');
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
/** Reading text (names, amounts, dates, lists and prose) is 16px or more wherever it shows. */
async function expectReading(page: Page, selectors: readonly string[], where: string): Promise<void> {
  for (const selector of selectors) {
    const drawn = await page.locator(selector).evaluateAll((elements) => elements.map((element) => parseFloat(getComputedStyle(element).fontSize)));
    expect(drawn.length, `${selector} shown, ${where}`).toBeGreaterThan(0);
    for (const size of drawn) expect(size, `${selector}, ${where}`).toBeGreaterThanOrEqual(16);
  }
}

test.use({ timezoneId: 'UTC', locale: 'en-US', viewport: { width: 1280, height: 900 } });

test.beforeAll(async ({ request }) => {
  const health = await request.get('/health').catch(() => null);
  test.skip(!health || !health.ok(), 'The stack behind WEB_URL is unavailable.');
});

test('Amazon Fresh is its own big tab: groceries by category, each item\'s weights, prices and dates, and each order\'s list', async ({ page }) => {
  const requests = await serve(page, FRESH);
  await openFresh(page);
  await expect(page).toHaveTitle('Amazon Fresh · Everyday · Holdr');
  const fresh = panel(page);
  const figure = (label: string) => fresh.locator('.amazon-figure').filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) });
  // Order-date item prices, apart from card spending, said up front.
  await expect(fresh.locator('.amazon-measure')).toHaveText('Fresh item prices by order date: not card spending');
  // The net item cost first, what it excludes right beside it, and how it adds up under it: refunds not tied to an
  // item said in view.
  await expect(fresh.locator('.amazon-figure dt')).toHaveText(['Net item cost', 'Groceries', 'Not yet classified']);
  const net = figure('Net item cost');
  await expect(net.locator('.amazon-figure-value')).toHaveText('$94.76');
  await expect(net.locator('.amazon-figure-note')).toHaveText('excludes tax, delivery and tips');
  const [amount, beside] = [(await net.locator('.amazon-figure-value').boundingBox())!, (await net.locator('.amazon-figure-note').boundingBox())!];
  expect(beside.x).toBeGreaterThan(amount.x + amount.width);
  expect(beside.y).toBeLessThan(amount.y + amount.height);
  await expect(fresh.locator('.amazon-fresh-net-detail'))
    .toHaveText('$106.34 for 15 items, less $11.58 in refunds on 2 orders, $5.00 of it not tied to an item.');
  await expect(figure('Groceries')).toContainText('$89.86');
  await expect(figure('Groceries')).toContainText('84% of item prices, before refunds');
  await expect(figure('Not yet classified')).toContainText('1 item not classified yet');
  // The orders' own totals: apart from the item cost, another measure, never one of its figures.
  await expect(fresh.locator('.amazon-fresh-totals')).toHaveText(/^Order totals\s*\$124\.28\s*for 3 Fresh orders, tax, delivery and tips included$/);
  await expect(fresh.locator('.amazon-figure').filter({ hasText: '$124.28' })).toHaveCount(0);
  // What the figures may miss: the orders that may be missing items stay in view; the rest folds.
  await expect(fresh.locator('.amazon-fresh-gap')).toHaveText('Items may be missing from 1 order.');
  const mayMiss = fresh.getByRole('button', { name: 'What may be missing' });
  await expect(mayMiss).toHaveAttribute('aria-expanded', 'false');
  await expect(fresh.getByRole('list', { name: 'What these figures cover' })).toHaveCount(0);
  await mayMiss.click();
  const coverage = fresh.getByRole('list', { name: 'What these figures cover' });
  await expect(coverage).toContainText('1 order has an Item List not proven complete');
  await expect(coverage).toContainText('1 item marked missing (not delivered) cost nothing here.');
  await expect(coverage).toContainText('1 weight is Amazon\'s estimate.');
  await expect(coverage).toContainText('Amazon refunded $11.91 for these orders in all, tax and delivery included');

  // Pork and eggs, snacks and the rest: every grocery category with something in it, then other groceries, the household
  // items bought on Fresh, and what isn't classified.
  const categories = fresh.getByRole('list', { name: 'Fresh categories, groceries first' });
  await expect(categories.locator('.spending-rank-row .spending-rank-name')).toHaveText(['Meat & Seafood', 'Dairy & Eggs',
    'Snacks & Sweets', 'Beverages', 'Bakery & Bread', 'Produce', 'Other groceries', 'Household Supplies', 'Not yet classified']);
  await expect(categories.locator('.spending-rank-row').nth(2)).toContainText('$6.58 refunded of $15.55');
  await expect(categories.locator('.amazon-unattributed-refunds')).toContainText('−$5.00');
  await expect(fresh).toContainText('Nothing in Pantry & Cooking, Frozen or Prepared Meals in the last year.');

  await categories.getByRole('button', { name: /^Meat & Seafood/ }).click();
  const meat = fresh.getByRole('list', { name: 'Items in Meat & Seafood, largest first' }).locator('.amazon-spend-item');
  await expect(meat).toHaveCount(2);
  await expect(meat.first()).toContainText(PORK);
  await expect(meat.first().locator('.amazon-item-meta')).toContainText('Qty 2 · 4.15 lb');
  await expect(meat.first().locator('.amazon-item-meta')).toContainText('latest $3.99/lb');
  await expect(meat.first().locator('.amazon-category-name')).toHaveText('Groceries › Meat & Seafood');
  const pork = meat.first().getByRole('list', { name: `Purchases of ${PORK}, latest first` }).getByRole('listitem');
  await expect(pork).toHaveCount(2);
  await expect(pork.first()).toContainText('Oct 12, 2026');
  await expect(pork.first()).toContainText('2.35 lb at $3.99/lb');
  await expect(pork.first()).toContainText('$9.38');
  await expect(pork.last()).toContainText('Sep 20, 2026');
  await expect(pork.first().getByRole('link', { name: 'Amazon order of Oct 12, 2026' })).toHaveAttribute('href', `#/everyday/amazon/orders/${O1.ref}`);

  await categories.getByRole('button', { name: /^Snacks & Sweets/ }).click();
  const chips = fresh.getByRole('list', { name: 'Items in Snacks & Sweets, largest first' }).locator('.amazon-spend-item').filter({ hasText: CHIPS });
  await expect(chips.locator('.amazon-taxonomy-badge')).toHaveText('Suggested');
  await expect(chips.locator('.amazon-spend-amount')).toHaveText('$6.58 $0.00');
  await expect(chips).toContainText('Qty 2 at $3.29 each');
  await expect(chips).toContainText('Refunded $6.58');

  await categories.getByRole('button', { name: /^Not yet classified/ }).click();
  await expect(fresh.getByRole('heading', { name: 'Not yet classified: what each item is' })).toBeVisible();
  await expect(fresh.getByRole('list', { name: 'Items in Not yet classified, largest first' }))
    .toContainText('best guess Groceries › Snacks & Sweets, only 50% sure');

  // Each order, newest first; the partial one opens its Item List.
  await expect(fresh.getByRole('heading', { name: 'Fresh orders, newest first' })).toBeVisible();
  const orders = fresh.getByRole('list', { name: 'Amazon Fresh orders' }).locator('li.amazon-fresh-order');
  await expect(orders).toHaveCount(3);
  // Without a purchase channel in the answer, no order is said to be from a store.
  await expect(orders.locator('.amazon-order-source')).toHaveCount(0);
  await expect(orders.first()).toContainText('Oct 12, 2026');
  await expect(orders.first()).toContainText('6 items, list complete');
  await expect(orders.last()).toContainText('6 items, 1 row unread');
  await expect(orders.last()).toContainText('Refunded $5.00');
  await orders.last().getByRole('button', { name: 'Show 6 items' }).click();
  const list = orders.last().getByRole('list', { name: 'Items of the Fresh order of Sep 20, 2026' }).locator('li.amazon-fresh-line');
  await expect(list).toHaveCount(6);
  await expect(list.first()).toContainText('1.80 lb at $3.99/lb');
  await expect(list.first()).toContainText('$7.18');
  await expect(list.nth(2)).toContainText('Substitute for Sample Plain Yogurt, 32 oz');
  await expect(list.last()).toContainText('Missing: not delivered');
  await expect(list.last().locator('.amazon-fresh-line-price')).toHaveText('$3.99 Not charged');
  await expect(list.last().locator('.amazon-fresh-line-price s')).toHaveAttribute('aria-label', 'listed at $3.99');
  await expect(orders.last()).toContainText('1 row of this Item List couldn\'t be read and isn\'t listed.');

  // The other big tab, and back: the address follows, and the Fresh tab keeps what was chosen.
  await views(page).getByRole('tab', { name: 'Amazon orders' }).click();
  await expect(page).toHaveURL(/#\/everyday\/amazon$/);
  await expect(page.locator('.amazon-order')).toHaveCount(1);
  await expect(panel(page)).toBeHidden();
  await views(page).getByRole('tab', { name: 'Amazon orders' }).press('ArrowRight');
  await expect(views(page).getByRole('tab', { name: 'Amazon Fresh' })).toBeFocused();
  await expect(page).toHaveURL(/#\/everyday\/amazon\/fresh$/);
  await expect(fresh.getByRole('heading', { name: 'Not yet classified: what each item is' })).toBeVisible();

  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(new Set(requests.filter((request) => request.startsWith('/amazon/fresh?'))
    .map((request) => new URL(request, 'http://synthetic.invalid').searchParams.get('window')))).toEqual(new Set(['1Y']));
});

test('before any Fresh list is imported the tab says so; an answer that doesn\'t add up is an error with a retry', async ({ page }) => {
  await serve(page, NOT_CAPTURED);
  await openFresh(page);
  await expect(panel(page).getByRole('status')).toContainText('Amazon Fresh items haven\'t been captured yet');
  await expect(panel(page).locator('.amazon-figure')).toHaveCount(0);

  // A Fresh order whose list had no readable line and whose total wasn't captured: listed, never "no orders".
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await serve(page, { ...NOT_CAPTURED, captured: true,
    orders: { count: 1, withTotal: 0, complete: 0, reconciled: 0, refunded: 0, unreadable: 0, noLines: 1 },
    lines: { ...NOT_CAPTURED.lines, unreadable: 1 },
    orderList: [{ ...O1, total: null, lines: 0, priced: 0, missing: 0, substituted: 0, unreadable: 1, unreadRows: 2, lineTotal: null,
      complete: false, reconciled: false, refund: null }] });
  await page.reload();
  await expect(panel(page).getByRole('status'))
    .toHaveText('1 Amazon Fresh order in the last year, but no order total or item price of it was captured yet.');
  const order = panel(page).getByRole('list', { name: 'Amazon Fresh orders' }).locator('li.amazon-fresh-order');
  await expect(order).toHaveCount(1);
  await expect(order).toContainText('Total not captured');
  await expect(order).toContainText('Items not captured yet');
  await expect(order.getByRole('button')).toHaveCount(0);

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await serve(page, { ...FRESH, totals: [{ ...FRESH.totals[0], netLineMinor: 1 }] });
  await page.reload();
  await expect(panel(page).getByRole('alert')).toContainText('Amazon Fresh: Holdr couldn\'t read the Amazon answer (totals).');
  await expect(panel(page).getByRole('button', { name: 'Try again' })).toBeVisible();

  // An item its own purchases don't add up to (999 lb of pork from 4.15 lb bought): the same, never shown.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await serve(page, { ...FRESH, products: [{ ...PRODUCTS[0], weight: { value: '999', unit: 'lb', estimated: false } }, ...PRODUCTS.slice(1)] });
  await page.reload();
  await expect(panel(page).getByRole('alert')).toContainText('Amazon Fresh: Holdr couldn\'t read the Amazon answer (items).');
  await expect(panel(page).locator('.amazon-figure')).toHaveCount(0);

  // An Item List naming one line twice: that order's own error with a retry, and none of its lines.
  const duplicateKeys: string[] = [];
  page.on('console', (message) => { if (/same key/i.test(message.text())) duplicateKeys.push(message.text()); });
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  const lines = O3_LIST.order.lines;
  await serve(page, FRESH, { order: { ...O3_LIST.order, lines: [lines[0], { ...lines[1], ref: lines[0].ref }, ...lines.slice(2)] } });
  await page.reload();
  const partial = panel(page).getByRole('list', { name: 'Amazon Fresh orders' }).locator('li.amazon-fresh-order').last();
  await partial.getByRole('button', { name: 'Show 6 items' }).click();
  await expect(partial.getByRole('alert')).toContainText('Fresh items: Holdr couldn\'t read the Amazon answer (order).');
  await expect(partial.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(partial.locator('li.amazon-fresh-line')).toHaveCount(0);
  expect(duplicateKeys).toEqual([]);

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await serve(page, null);
  await page.reload();
  await expect(panel(page)).toContainText('Amazon Fresh isn\'t available in this version of Holdr.');
});

test('a Whole Foods store\'s receipt among the Fresh orders is said as such, never as a Fresh order', async ({ page }) => {
  await serve(page, { ...FRESH, orderList: FRESH.orderList.map((order, index) => (index === 1 ? { ...order, purchaseChannel: 'whole-foods-in-store' }
    : index === 2 ? { ...order, purchaseChannel: null } : order)) });
  await openFresh(page);
  const fresh = panel(page);
  await expect(fresh.getByRole('heading', { name: 'Fresh and Whole Foods orders, newest first' })).toBeVisible();
  await expect(fresh.getByRole('heading', { name: 'Fresh orders, newest first' })).toHaveCount(0);
  const orders = fresh.getByRole('list', { name: 'Amazon Fresh and Whole Foods orders' }).locator('li.amazon-fresh-order');
  await expect(orders).toHaveCount(3);
  await expect(orders.nth(1).locator('.amazon-order-source')).toHaveText('Whole Foods (in store)');
  await expect(orders.nth(1)).toContainText('Oct 5, 2026');
  for (const n of [0, 2]) await expect(orders.nth(n).locator('.amazon-order-source')).toHaveCount(0);
  // The figures are the same answer's, whatever the orders' source.
  await expect(fresh.locator('.amazon-figure[data-figure="net"] .amazon-figure-value')).toHaveText('$94.76');
});

test('an item cost or order totals that weren\'t captured say so, never $0.00', async ({ page }) => {
  // Two orders with their totals, but no line of either Item List read: no item price at all.
  const unread = (order: { ref: string; date: string }, total: number, rows: number) => ({ ...order, total: usd(total), lines: 0, priced: 0,
    missing: 0, substituted: 0, unreadable: 0, unreadRows: rows, lineTotal: null, complete: false, reconciled: false, refund: null });
  await serve(page, { ...FRESH,
    orders: { count: 2, withTotal: 2, complete: 0, reconciled: 0, refunded: 0, unreadable: 0, noLines: 2 },
    lines: { ...NOT_CAPTURED.lines },
    totals: [{ currency: 'USD', orderTotalMinor: 9289, lineMinor: 0, groceryMinor: 0, categorizedMinor: 0, suggestedMinor: 0,
      needsReviewMinor: 0, refundMinor: 0, lineRefundMinor: 0, unattributedRefundMinor: 0, netLineMinor: 0 }],
    categories: [], products: [], orderList: [unread(O1, 5155, 2), unread(O2, 4134, 1)] });
  await openFresh(page);
  const fresh = panel(page);
  const net = fresh.locator('.amazon-figure').filter({ has: page.locator('dt', { hasText: /^Net item cost$/ }) });
  await expect(net.locator('.amazon-figure-value')).toHaveText('Not captured');
  await expect(net.locator('.amazon-figure-note')).toHaveText('no item price was captured for these orders');
  await expect(fresh.locator('.amazon-fresh-summary')).not.toContainText('$0.00');
  await expect(fresh.locator('.amazon-fresh-net-detail, .amazon-fresh-split')).toHaveCount(0);
  await expect(fresh.locator('.amazon-fresh-totals')).toHaveText(/^Order totals\s*\$92\.89\s*for 2 Fresh orders, tax, delivery and tips included$/);
  await expect(fresh.locator('.amazon-fresh-gap')).toHaveText('Items may be missing from 2 orders.');

  // Every item priced, but no order total captured: the item cost stands; the totals say they weren't captured.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await serve(page, { ...FRESH, orders: { ...FRESH.orders, withTotal: 0 }, totals: [{ ...FRESH.totals[0], orderTotalMinor: 0 }],
    orderList: FRESH.orderList.map((order) => ({ ...order, total: null })) });
  await page.reload();
  await expect(net.locator('.amazon-figure-value')).toHaveText('$94.76');
  await expect(fresh.locator('.amazon-fresh-totals')).toHaveText(/^Order totals\s*not captured for these orders$/);
  await expect(fresh.locator('.amazon-fresh-totals')).not.toContainText('$');

  // Some orders without a total: the totals say which orders they cover.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await serve(page, { ...FRESH, orders: { ...FRESH.orders, withTotal: 2 }, totals: [{ ...FRESH.totals[0], orderTotalMinor: 9289 }],
    orderList: FRESH.orderList.map((order, index) => (index === 2 ? { ...order, total: null } : order)) });
  await page.reload();
  await expect(fresh.locator('.amazon-fresh-totals'))
    .toHaveText(/^Order totals\s*\$92\.89\s*for 2 of 3 Fresh orders \(1 order without a captured total\), tax, delivery and tips included$/);
});

test('beside another currency, a captured $0.00 reads as $0.00, and what wasn\'t captured in the figures\' currency stays unknown', async ({ page }) => {
  // A USD order beside a EUR one (one item, €1.00): the USD order's total and its one item as each case captured them.
  const U = { ref: ref(221), date: '2026-10-12' }, E = { ref: ref(222), date: '2026-10-11' };
  const eur = { currency: 'EUR', amountMinor: 100 };
  const unfiled = filed('needs-review', 'needs-review', undefined, { source: null, confidence: null });
  const money = (currency: string, orderTotalMinor: number, lineMinor: number) => ({ currency, orderTotalMinor, lineMinor,
    groceryMinor: 0, categorizedMinor: 0, suggestedMinor: 0, needsReviewMinor: lineMinor, refundMinor: 0, lineRefundMinor: 0,
    unattributedRefundMinor: 0, netLineMinor: lineMinor });
  const unclassified = (currency: string, amountMinor: number) => ({ ...category('needs-review', 'needs-review', amountMinor, 0, 1, 1, 1), currency });
  const twoCurrencies = (dollars: { total: number | null; line: number | null }) => {
    const orderList = [
      { ...U, total: dollars.total === null ? null : usd(dollars.total), lines: dollars.line === null ? 0 : 1,
        priced: dollars.line === null ? 0 : 1, missing: 0, substituted: 0, unreadable: 0, unreadRows: dollars.line === null ? 1 : 0,
        lineTotal: dollars.line === null ? null : usd(dollars.line), complete: dollars.line !== null,
        reconciled: dollars.line !== null && dollars.total !== null, refund: null },
      { ...E, total: eur, lines: 1, priced: 1, missing: 0, substituted: 0, unreadable: 0, unreadRows: 0, lineTotal: eur, complete: true,
        reconciled: true, refund: null },
    ];
    const products = [product('Sample Euro Item', null, unfiled, [buy(E, 100)], { currency: 'EUR' }),
      ...(dollars.line === null ? [] : [product('Sample Dollar Item', null, unfiled, [buy(U, dollars.line)])])];
    const count = (has: (order: (typeof orderList)[number]) => boolean) => orderList.filter(has).length;
    return { ...FRESH, taxonomy: { ...FRESH.taxonomy, assignments: 'absent' },
      orders: { count: 2, withTotal: count((order) => order.total !== null), complete: count((order) => order.complete),
        reconciled: count((order) => order.reconciled), refunded: 0, unreadable: 0, noLines: count((order) => order.lines === 0) },
      lines: { count: products.length, priced: products.length, noPrice: 0, missing: 0, substituted: 0, estimated: 0, categorized: 0,
        suggested: 0, needsReview: products.length, refunded: 0, unreadable: 0 },
      totals: [money('USD', dollars.total ?? 0, dollars.line ?? 0), money('EUR', 100, 100)],
      categories: [...(dollars.line === null ? [] : [unclassified('USD', dollars.line)]), unclassified('EUR', 100)],
      products, orderList };
  };
  const fresh = panel(page);
  const net = fresh.locator('.amazon-figure').filter({ has: page.locator('dt', { hasText: /^Net item cost$/ }) });
  const unsorted = fresh.locator('.amazon-figure').filter({ has: page.locator('dt', { hasText: /^Not yet classified$/ }) });

  // A $0.00 order total and a $0.00 item, both captured: $0.00, never "not captured".
  await serve(page, twoCurrencies({ total: 0, line: 0 }));
  await openFresh(page);
  await expect(net.locator('.amazon-figure-value')).toHaveText('$0.00');
  await expect(net.locator('.amazon-figure-note')).toHaveText('excludes tax, delivery and tips');
  await expect(fresh.locator('.amazon-fresh-net-detail')).toHaveText('$0.00 for 1 item; no refunds taken off them.');
  await expect(unsorted.locator('.amazon-figure-value')).toHaveText('$0.00');
  await expect(unsorted.locator('.amazon-figure-note')).toHaveText('1 item not classified yet');
  await expect(fresh.locator('.amazon-fresh-totals')).toHaveText(/^Order totals\s*\$0\.00\s*tax, delivery and tips included$/);
  await expect(fresh.locator('.amazon-fresh-summary')).not.toContainText(/not captured/i);

  // Its total captured but no item of it: the USD item cost stays unknown, whatever the EUR order's item cost.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await serve(page, twoCurrencies({ total: 125, line: null }));
  await page.reload();
  await expect(net.locator('.amazon-figure-value')).toHaveText('Not captured');
  await expect(net.locator('.amazon-figure-note')).toHaveText('no item price in USD');
  await expect(fresh.locator('.amazon-fresh-net-detail, .amazon-fresh-split')).toHaveCount(0);
  await expect(fresh.locator('.amazon-fresh-totals')).toHaveText(/^Order totals\s*\$1\.25\s*tax, delivery and tips included$/);

  // A $0.00 item captured but no order total: the USD order total stays unknown, whatever the EUR order's total.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await serve(page, twoCurrencies({ total: null, line: 0 }));
  await page.reload();
  await expect(net.locator('.amazon-figure-value')).toHaveText('$0.00');
  await expect(fresh.locator('.amazon-fresh-totals')).toHaveText(/^Order totals\s*not captured in USD$/);
  await expect(fresh.locator('.amazon-fresh-totals')).not.toContainText('$');
});

test('every Fresh text reads at its floor at 1920 and 375px: what may be missing opened, a category\'s items, an order\'s list, errors and empty states', async ({ page }) => {
  await serve(page, FRESH);
  for (const width of [1920, 375]) {
    const where = `${width}px`;
    await page.setViewportSize({ width, height: 900 });
    await openFresh(page);
    await page.reload();
    const fresh = panel(page);
    await fresh.getByRole('button', { name: 'What may be missing' }).click();
    await expect(fresh.getByRole('list', { name: 'What these figures cover' })).toBeVisible();
    await fresh.getByRole('list', { name: 'Fresh categories, groceries first' }).getByRole('button', { name: /^Meat & Seafood/ }).click();
    await expect(fresh.getByRole('list', { name: 'Items in Meat & Seafood, largest first' }).locator('.amazon-spend-item')).toHaveCount(2);
    const partial = fresh.getByRole('list', { name: 'Amazon Fresh orders' }).locator('li.amazon-fresh-order').last();
    await partial.getByRole('button', { name: 'Show 6 items' }).click();
    await expect(partial.locator('li.amazon-fresh-line')).toHaveCount(6);
    expect(await textBelowFloors(page), `Fresh at ${where}`).toEqual([]);
    await expectReading(page, ['.amazon-fresh-net-detail', '.amazon-fresh-totals-value', '.amazon .spending-rank-name', '.amazon .spending-rank-amount',
      '.amazon-item-title', '.amazon-spend-amount', '.amazon-fresh-line-price', '.amazon-order-date', '.amazon-spending-part h4',
      '.amazon-unattributed-refunds .spending-rank-name'], where);
    // The limits stay in view at every width: the orders that may be missing items, and refunds tied to no item.
    await expect(fresh.locator('.amazon-fresh-gap')).toBeVisible();
    await expect(fresh.locator('.amazon-fresh-net-detail')).toContainText('$5.00 of it not tied to an item');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), where).toBeLessThanOrEqual(0);
  }

  // An answer that doesn't add up, an order's list that can't be read, and nothing captured yet.
  const lines = O3_LIST.order.lines;
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await serve(page, FRESH, { order: { ...O3_LIST.order, lines: [lines[0], { ...lines[1], ref: lines[0].ref }, ...lines.slice(2)] } });
  for (const width of [1920, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    const partial = panel(page).getByRole('list', { name: 'Amazon Fresh orders' }).locator('li.amazon-fresh-order').last();
    await partial.getByRole('button', { name: 'Show 6 items' }).click();
    await expect(partial.getByRole('alert')).toBeVisible();
    expect(await textBelowFloors(page), `an order's list error at ${width}px`).toEqual([]);
  }
  for (const answer of [{ ...FRESH, totals: [{ ...FRESH.totals[0], netLineMinor: 1 }] }, NOT_CAPTURED]) {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await serve(page, answer);
    for (const width of [1920, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.reload();
      await expect(panel(page).getByRole(answer === NOT_CAPTURED ? 'status' : 'alert')).toBeVisible();
      expect(await textBelowFloors(page), `${answer === NOT_CAPTURED ? 'nothing captured' : 'an error'} at ${width}px`).toEqual([]);
      if (answer === NOT_CAPTURED) await expectReading(page, ['.amazon-fresh-empty p'], `nothing captured at ${width}px`);
    }
  }
});
