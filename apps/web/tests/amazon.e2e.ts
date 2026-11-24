import { expect, test, type Page } from './fixtures';
import {
  computeCardInsights,
  summarizeCardSpending,
  toCardTransactionView,
  type CardAccount,
  type CardOwner,
} from '@finance-tracker/shared';

/**
 * The Amazon area of Everyday (#/everyday/amazon) on synthetic answers: every `/amazon/*` read (spending by item and
 * category included), the card accounts and the rest of Everyday's card routes are served here, so nothing depends
 * on the stack's data. Everything is made up: refs, item names and models, ASINs, amounts, card nicknames and endings
 * (0001, 0002).
 */

const at = '2026-10-01T00:00:00.000Z';
const CARD_A: CardAccount = {
  id: `card-acct-${'a'.repeat(32)}`, issuer: 'chase', owner: 'casey', nickname: 'Sample Rewards', last4: '0001', currency: 'USD',
  status: 'active', createdAt: at, updatedAt: at,
};
const CARD_B: CardAccount = {
  id: `card-acct-${'b'.repeat(32)}`, issuer: 'amex', owner: 'alex', nickname: 'Sample Gold', last4: '0002', currency: 'USD',
  status: 'active', createdAt: at, updatedAt: at,
};
const LINKED_TX = `card-txn-${'1'.repeat(32)}`;
/** Card rows a held match had as candidates: the API never sends them, and the page must never show them. */
const CANDIDATE_TXS = [`card-txn-${'2'.repeat(32)}`, `card-txn-${'3'.repeat(32)}`];

const ref = (n: number) => `amz-${n.toString(16).padStart(48, '0')}`;
const usd = (amountMinor: number) => ({ currency: 'USD', amountMinor });

type Json = Record<string, unknown>;

const SUMMARY = {
  measure: 'amazon-order-observations-not-card-spending', orders: 3, paymentObservations: 4, refundObservations: 2,
  issuedRefundObservations: 2, linked: 1, held: 2, unknownBeneficiary: 2, itemAttribution: 'unproven',
  version: 'amazon-v1-00000000000000000000beef',
  coverage: [{ captureRef: 'synthetic-capture', coverage: {
    orders: { status: 'partial', reason: 'synthetic-window', pages: 1, records: 3, rejected: 0 },
    payments: { status: 'held', reason: 'synthetic-held', pages: 0, records: 0, rejected: 0 },
    details: { status: 'partial', reason: 'synthetic-window', pages: 3, records: 3, rejected: 0 },
    refunds: { status: 'partial', reason: 'synthetic-window', pages: 1, records: 2, rejected: 0 },
  } }],
};
const EMPTY_SUMMARY = { ...SUMMARY, orders: 0, paymentObservations: 0, refundObservations: 0, issuedRefundObservations: 0,
  linked: 0, held: 0, unknownBeneficiary: 0, coverage: [], version: undefined };

const KETTLE = 'Sample Kettle Model K-100, 1.7 L, Stainless Steel, Auto Shut-Off';
const FILTERS = 'Sample Water Filter Pack Model F-2 (2-Pack)';
const CABLE = 'Sample USB-C Cable Model C-200, 2 m, Braided';
const LAMP = 'Sample Desk Lamp Model L-3 with Dimmer';

/** Each order's own answer (GET /amazon/orders/:ref): full items, summary lines and payment methods. */
const DETAILS: Record<string, Json> = {
  [ref(1)]: {
    ref: ref(1), date: '2026-10-12', total: usd(4210), beneficiary: 'unknown', tenderCoverage: 'single-card-proven',
    paymentCoverage: 'held', itemObservations: 2,
    matches: [{ state: 'linked', evidenceClass: 'unique-total-match', cardTransactionId: LINKED_TX, cardAccountId: CARD_A.id }],
    refunds: [],
    items: [
      { ref: 'amz-line-1a', title: KETTLE, asin: 'B0000000A1', quantity: 1, unitPrice: usd(2999), attribution: 'observation-only',
        category: 'Home', categorySource: 'agent-classification', confidence: 0.92 },
      { ref: 'amz-line-1b', title: FILTERS, asin: 'B0000000A2', quantity: 2, unitPrice: usd(450), attribution: 'observation-only',
        category: 'Kitchen', categorySource: 'item-override', confidence: null },
    ],
    summary: [
      { kind: 'items-subtotal', money: usd(3899) }, { kind: 'shipping', money: usd(0) }, { kind: 'tax', money: usd(311) },
      { kind: 'grand-total', money: usd(4210) },
    ],
    paymentMethods: [{ kind: 'card', network: 'visa', last4: '0001' }],
  },
  [ref(2)]: {
    ref: ref(2), date: '2026-10-05', total: usd(1999), beneficiary: 'alex', tenderCoverage: 'single-card-proven',
    paymentCoverage: 'held', itemObservations: 1,
    matches: [{ state: 'held', evidenceClass: 'unique-total-match', reason: 'ambiguous', candidateCount: 2 }],
    refunds: [],
    items: [{ ref: 'amz-line-2a', title: CABLE, asin: null, quantity: 1, unitPrice: usd(1999), attribution: 'observation-only',
      category: null, categorySource: null, confidence: null }],
    summary: [{ kind: 'items-subtotal', money: usd(1850) }, { kind: 'tax', money: usd(149) }, { kind: 'grand-total', money: usd(1999) }],
    paymentMethods: [{ kind: 'card', network: 'amex', last4: '0002' }],
  },
  [ref(3)]: {
    ref: ref(3), date: '2026-09-28', total: usd(2000), beneficiary: 'unknown', tenderCoverage: 'multi-tender',
    paymentCoverage: 'held', itemObservations: 1,
    matches: [{ state: 'held', evidenceClass: 'unique-total-match', reason: 'evidence-held', candidateCount: 0 }],
    refunds: [
      { ref: 'amz-refund-3a', status: 'issued', date: '2026-10-02', amount: usd(-1500), destination: 'card' },
      { ref: 'amz-refund-3b', status: 'issued', date: '2026-10-03', amount: usd(-500), destination: 'balance' },
    ],
    items: [{ ref: 'amz-line-3a', title: LAMP, asin: 'B0000000A3', quantity: 2, unitPrice: usd(1250), attribution: 'observation-only',
      category: 'Home', categorySource: 'agent-classification', confidence: 0.81 }],
    summary: [
      { kind: 'items-subtotal', money: usd(2500) }, { kind: 'shipping', money: usd(0) }, { kind: 'tax', money: usd(0) },
      { kind: 'gift-card', money: usd(500) }, { kind: 'grand-total', money: usd(2000) },
    ],
    paymentMethods: [{ kind: 'card', network: 'visa', last4: '0001' }, { kind: 'balance', network: 'unknown', last4: null }],
  },
};

/** A list row: the order's answer without its summary and methods, with trimmed items, as GET /amazon/orders gives it. */
function listRow(detail: Json): Json {
  const { summary: _summary, paymentMethods: _methods, items, matches, ...rest } = detail;
  return {
    ...rest,
    // A held match here also carries made-up candidate rows, as a broken server might: the page must drop them.
    matches: (matches as Json[]).map((match) => (match.state === 'held' ? { ...match, candidates: CANDIDATE_TXS } : match)),
    items: (items as Json[]).map(({ ref: line, title, asin, quantity, category, categorySource, image }) =>
      ({ ref: line, title, asin, quantity, category, categorySource, ...(image === undefined ? {} : { image }) })),
  };
}

/** The read API before matches, refunds and list items: what a row looked like at PR #96. */
function olderRow(detail: Json): Json {
  const { ref: order, date, total, beneficiary, tenderCoverage, paymentCoverage, itemObservations } = detail;
  return { ref: order, date, total, beneficiary, tenderCoverage, paymentCoverage, itemObservations };
}

/** One thing bought over a window, as GET /amazon/spending lists it; its latest order is `ref(order)`. */
interface Bought {
  ref: string;
  /** null: the API hid it. */
  title: string | null;
  asin?: string;
  category: string | null;
  source?: 'item-override' | 'agent-classification';
  quantity?: number;
  lines?: number;
  orders?: number;
  amountMinor: number;
  date: string;
  order: number;
  currency?: string;
}

const sumOf = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0);

/** A window's answer, its categories and totals added up from what was bought, as the API adds them. */
function spendingAnswer(key: string, from: string, to: string, bought: Bought[], facts: {
  orders: Json; cardCharges: Json; orderTotals: Record<string, [number, number]>; noPrice?: number; noQuantity?: number;
}): Json {
  const products = bought.map((item) => ({
    ref: item.ref, currency: item.currency ?? 'USD', title: item.title ?? '[redacted]', asin: item.asin ?? null, category: item.category,
    categorySource: item.category === null ? null : item.source ?? 'agent-classification', quantity: item.quantity ?? 1,
    lines: item.lines ?? 1, orders: item.orders ?? 1, amountMinor: item.amountMinor, lastOrderDate: item.date, lastOrderRef: ref(item.order),
  })).sort((a, b) => b.amountMinor - a.amountMinor);
  const categories = new Map<string, { currency: string; category: string | null; amountMinor: number; lines: number; products: number; orders: number }>();
  for (const product of products) {
    const id = JSON.stringify([product.currency, product.category]);
    const entry = categories.get(id)
      ?? { currency: product.currency, category: product.category, amountMinor: 0, lines: 0, products: 0, orders: 0 };
    entry.amountMinor += product.amountMinor;
    entry.lines += product.lines;
    entry.products += 1;
    entry.orders += product.orders;
    categories.set(id, entry);
  }
  const named = products.filter((product) => product.category !== null);
  const priced = sumOf(products.map((product) => product.lines));
  const noPrice = facts.noPrice ?? 0;
  const noQuantity = facts.noQuantity ?? 0;
  return {
    measure: 'amazon-order-item-prices-not-card-spending', window: { key, from, to }, version: SUMMARY.version,
    orders: facts.orders, cardCharges: facts.cardCharges,
    lines: { count: priced + noPrice + noQuantity, priced, noPrice, noQuantity, categorized: sumOf(named.map((product) => product.lines)) },
    totals: [...new Set(products.map((product) => product.currency))].sort().map((currency) => ({
      currency,
      orderTotalMinor: facts.orderTotals[currency][0],
      itemsCompleteOrderTotalMinor: facts.orderTotals[currency][1],
      itemMinor: sumOf(products.filter((product) => product.currency === currency).map((product) => product.amountMinor)),
      categorizedMinor: sumOf(named.filter((product) => product.currency === currency).map((product) => product.amountMinor)),
    })),
    categories: [...categories.values()].sort((a, b) => b.amountMinor - a.amountMinor),
    products,
  };
}

/** The three orders above, over the last 30 (and 60) days: every item priced, the lamp bought with a gift card. */
const RECENT: Bought[] = [
  { ref: 'amz-line-1a', title: KETTLE, asin: 'B0000000A1', category: 'Home', amountMinor: 2999, date: '2026-10-12', order: 1 },
  { ref: 'amz-line-3a', title: LAMP, asin: 'B0000000A3', category: 'Home', quantity: 2, amountMinor: 2500, date: '2026-09-28', order: 3 },
  { ref: 'amz-line-2a', title: CABLE, category: null, amountMinor: 1999, date: '2026-10-05', order: 2 },
  { ref: 'amz-line-1b', title: FILTERS, asin: 'B0000000A2', category: 'Kitchen', source: 'item-override', quantity: 2, amountMinor: 900,
    date: '2026-10-12', order: 1 },
];
const RECENT_FACTS = {
  orders: { count: 3, withTotal: 3, itemsComplete: 3, noLines: 0, refunded: 1, linked: 1, held: 2, unmatched: 0 },
  cardCharges: { linked: 1, itemized: 1 },
  orderTotals: { USD: [8209, 8209] as [number, number] },
};
/** A year: the kettle bought twice, and older orders, one item's title hidden by the API. */
const YEAR: Bought[] = [
  ...RECENT.map((item) => (item.ref === 'amz-line-1a' ? { ...item, quantity: 2, lines: 2, orders: 2, amountMinor: 5898 } : item)),
  { ref: 'amz-line-y1', title: 'Sample Rice Cooker Model R-5, 5.5 Cups', asin: 'B0000000B1', category: 'Kitchen', amountMinor: 8999, date: '2026-06-02', order: 21 },
  { ref: 'amz-line-y2', title: 'Sample Office Chair Model OC-7', asin: 'B0000000B2', category: 'Office', amountMinor: 15999, date: '2026-04-11', order: 22 },
  { ref: 'amz-line-y3', title: 'Sample Garden Hose 50 ft', asin: 'B0000000B3', category: 'Garden', amountMinor: 3499, date: '2026-05-20', order: 23 },
  { ref: 'amz-line-y4', title: 'Sample Printer Paper, 5 Reams', asin: 'B0000000B4', category: 'Office', quantity: 3, lines: 3, orders: 3, amountMinor: 8997,
    date: '2026-08-15', order: 24 },
  { ref: 'amz-line-y5', title: 'Sample Phone Case Model PC-1', category: null, amountMinor: 1299, date: '2026-02-03', order: 25 },
  { ref: 'amz-line-y6', title: 'Sample Batteries AA (24-Pack)', asin: 'B0000000B6', category: 'Home', amountMinor: 1849, date: '2026-01-14', order: 26 },
  { ref: 'amz-line-y7', title: 'Sample Desk Organizer', asin: 'B0000000B7', category: 'Office', amountMinor: 2499, date: '2025-11-30', order: 27 },
  { ref: 'amz-line-y8', title: 'Sample Plant Food 2 lb', asin: 'B0000000B8', category: 'Garden', amountMinor: 1199, date: '2025-10-25', order: 28 },
  { ref: 'amz-line-y9', title: null, asin: 'B0000000B9', category: null, amountMinor: 700, date: '2025-12-01', order: 29 },
];
const YEAR_FACTS = {
  orders: { count: 14, withTotal: 13, itemsComplete: 11, noLines: 1, refunded: 1, linked: 6, held: 5, unmatched: 3 },
  cardCharges: { linked: 7, itemized: 2 },
  orderTotals: { USD: [62000, 52000] as [number, number] },
  noPrice: 1,
  noQuantity: 1,
};
const TWO_YEARS_FACTS = {
  ...YEAR_FACTS,
  orders: { ...YEAR_FACTS.orders, count: 15, withTotal: 14, itemsComplete: 12, unmatched: 4 },
  orderTotals: { ...YEAR_FACTS.orderTotals, EUR: [3000, 3000] as [number, number] },
};
/** Every window's answer, as the API would give it on Oct 19, 2026. */
const SPENDING: Record<string, Json> = {
  '30D': spendingAnswer('30D', '2026-09-20', '2026-10-19', RECENT, RECENT_FACTS),
  '60D': spendingAnswer('60D', '2026-08-21', '2026-10-19', RECENT, RECENT_FACTS),
  YTD: spendingAnswer('YTD', '2026-01-01', '2026-10-19', YEAR, YEAR_FACTS),
  '1Y': spendingAnswer('1Y', '2025-10-20', '2026-10-19', YEAR, YEAR_FACTS),
  '2Y': spendingAnswer('2Y', '2024-10-20', '2026-10-19', [...YEAR, { ref: 'amz-line-e1', title: 'Sample Euro Item', category: null,
    quantity: 3, amountMinor: 3000, date: '2025-06-01', order: 30, currency: 'EUR' }], TWO_YEARS_FACTS),
};

interface AmazonServer {
  summary: unknown;
  rows: Json[];
  details: Record<string, Json>;
  /** Each window's spending answer; null: an API without that read (404). */
  spending: Record<string, Json> | null;
  requests: string[];
  /** Holds back the answers to requests `matches` picks until `release()`. */
  hold: (matches: (url: URL) => boolean) => { release: () => void };
}

async function serveAmazon(page: Page, options: Partial<Pick<AmazonServer, 'summary' | 'rows' | 'details' | 'spending'>> = {}): Promise<AmazonServer> {
  let gate: { matches: (url: URL) => boolean; released: Promise<void> } | null = null;
  const server: AmazonServer = {
    summary: options.summary ?? SUMMARY,
    rows: options.rows ?? Object.values(DETAILS).map(listRow),
    details: options.details ?? DETAILS,
    spending: options.spending === undefined ? SPENDING : options.spending,
    requests: [],
    hold(matches) {
      let release = () => {};
      gate = { matches, released: new Promise<void>((resolve) => { release = resolve; }) };
      return { release: () => { gate = null; release(); } };
    },
  };
  await page.route((url) => url.pathname.startsWith('/amazon/'), async (route) => {
    const url = new URL(route.request().url());
    server.requests.push(`${url.pathname}${url.search}`);
    const held = gate;
    if (held?.matches(url)) await held.released;
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (route.request().method() !== 'GET') return json(405, { error: 'read only' });
    if (url.pathname === '/amazon/summary') return json(200, server.summary);
    if (url.pathname === '/amazon/orders') {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const beneficiary = url.searchParams.get('beneficiary');
      const rows = beneficiary ? server.rows.filter((row) => row.beneficiary === beneficiary) : server.rows;
      return json(200, { total: rows.length, orders: rows.slice(offset, offset + limit) });
    }
    if (url.pathname === '/amazon/spending') {
      const answer = server.spending?.[url.searchParams.get('window') ?? '30D'];
      return answer ? json(200, answer) : json(404, { error: 'not-found' });
    }
    const detail = /^\/amazon\/orders\/([^/]+)$/.exec(url.pathname);
    const order = detail ? server.details[decodeURIComponent(detail[1])] : undefined;
    return order ? json(200, { order }) : json(404, { error: 'amazon order not found' });
  });
  return server;
}

/** The card charge order 1 is linked to (card 0001), as the card ledger has it. */
const LINKED_VIEW = toCardTransactionView({
  id: LINKED_TX, cardAccountId: CARD_A.id, source: 'ofx', fingerprint: '1'.repeat(64), transactionDate: '2026-10-13',
  status: 'posted', amountMinor: 4210, currency: 'USD', kind: 'purchase', description: 'SAMPLE MARKETPLACE ORDER',
  issuerCategory: 'Shopping', createdAt: at, updatedAt: at,
});

/** Everyday's card routes, synthetic: two cards, no rows, and one linked charge's details. No owner sync API. */
async function serveCards(page: Page): Promise<void> {
  const accounts = [CARD_A, CARD_B];
  const owners = new Map<string, CardOwner>(accounts.map((account) => [account.id, account.owner]));
  await page.route((url) => /^\/(?:card-accounts|card-imports|card-transactions|spending)(?:[/?]|$)/.test(url.pathname), (route) => {
    const url = new URL(route.request().url());
    let body: unknown = null;
    if (url.pathname === '/card-accounts') body = { cardAccounts: accounts };
    if (url.pathname === '/spending/coverage') body = { cards: [] };
    if (url.pathname === '/spending/summary') body = { ...summarizeCardSpending([], { owners }), categories: [] };
    if (url.pathname === '/spending/insights') body = computeCardInsights([], { month: '2026-10', today: '2026-10-17', currency: 'USD' });
    if (url.pathname === '/card-transactions') body = { transactions: [], total: 0, limit: 100, offset: 0, nextOffset: null };
    if (url.pathname === `/card-transactions/${LINKED_TX}`) body = { transaction: LINKED_VIEW, cardAccount: CARD_A, importBatch: null, possiblyPostedAs: [] };
    return route.fulfill(body === null
      ? { status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }) }
      : { status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route((url) => url.pathname.startsWith('/card-sync/'), (route) => route.fulfill({
    status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }),
  }));
}

const areas = (page: Page) => page.getByRole('tablist', { name: 'Spending areas' });
const amazonTab = (page: Page) => areas(page).getByRole('tab', { name: 'Amazon', exact: true });
const orderCard = (page: Page, n: number) => page.locator(`li.amazon-order[data-order="${ref(n)}"]`);
const spendingPanel = (page: Page) => page.getByRole('region', { name: 'Amazon spending by item and category' });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

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
/** What each matched element's text is drawn at, in px. */
const sizes = (locator: ReturnType<Page['locator']>) =>
  locator.evaluateAll((elements) => elements.map((element) => parseFloat(getComputedStyle(element).fontSize)));
/** Reading text (names, amounts, dates, lists and prose) is 16px or more wherever it shows. */
async function expectReading(page: Page, selectors: readonly string[], where: string): Promise<void> {
  for (const selector of selectors) {
    const drawn = await sizes(page.locator(selector));
    expect(drawn.length, `${selector} shown, ${where}`).toBeGreaterThan(0);
    for (const size of drawn) expect(size, `${selector}, ${where}`).toBeGreaterThanOrEqual(16);
  }
}

async function openAmazon(page: Page, hash = '#/everyday/amazon'): Promise<void> {
  await page.goto(`/${hash}`);
  await expect(amazonTab(page)).toHaveAttribute('aria-selected', 'true');
}

test.use({ timezoneId: 'UTC', locale: 'en-US', viewport: { width: 1280, height: 900 } });

test.beforeAll(async ({ request }) => {
  const health = await request.get('/health').catch(() => null);
  test.skip(!health || !health.ok(), 'The stack behind WEB_URL is unavailable.');
});

test.beforeEach(async ({ page }) => {
  await serveCards(page);
});

test('with nothing imported, the Amazon area says so plainly and asks for no order', async ({ page }) => {
  const server = await serveAmazon(page, { summary: EMPTY_SUMMARY, rows: [] });
  await openAmazon(page);
  await expect(page.getByText('No Amazon data imported yet')).toBeVisible();
  await expect(page.locator('.amazon-empty')).toContainText('card charges stay in Card transactions');
  await expect(page.getByRole('combobox', { name: 'For' })).toHaveCount(0);
  await expect(page.locator('.amazon-summary')).toHaveCount(0);
  await expect(page.locator('.amazon-order')).toHaveCount(0);
  await expect(page).toHaveTitle('Amazon · Everyday · Holdr');
  // StrictMode runs a dev page's effects twice: what was asked matters, not how often.
  expect(new Set(server.requests)).toEqual(new Set(['/amazon/orders?offset=0&limit=50', '/amazon/summary']));
});

test('the orders lead: three figures, how they were counted folded, and each order its date, amount, who it was for, items and one card match line', async ({ page }) => {
  const server = await serveAmazon(page);
  await openAmazon(page);

  // Purchases first: orders, card matching and refund observations (named as observations), and nothing else.
  const summary = page.getByRole('region', { name: 'Amazon order activity' });
  // Order-date figures, apart from card spending, said without opening anything.
  await expect(summary.locator('.amazon-measure')).toHaveText('Its own measure, by order date: not card spending');
  await expect(summary.locator('.amazon-figure dt')).toHaveText(['Orders', 'Card matches', 'Refund observations']);
  const figure = (label: string) => summary.locator('.amazon-figure').filter({ has: page.getByText(label, { exact: true }) });
  await expect(figure('Orders').locator('.amazon-figure-value')).toHaveText('3');
  await expect(figure('Card matches').locator('.amazon-figure-value')).toHaveText('1 linked');
  await expect(figure('Card matches').locator('.amazon-figure-note')).toHaveText('2 need review');
  await expect(figure('Refund observations').locator('.amazon-figure-value')).toHaveText('2');
  await expect(figure('Refund observations').locator('.amazon-figure-note')).toHaveText('2 issued · a refund seen twice counts twice');
  // The figures' limit stays beside them, folded or not: the capture's coverage is partial.
  await expect(summary.locator('.amazon-limit')).toHaveText('Imported records only; order history may be incomplete.');
  // How they were counted folds away: the observations note, the other counts, the coverage and the evidence revision.
  const counted = summary.getByRole('button', { name: 'How this was counted' });
  await expect(counted).toHaveAttribute('aria-expanded', 'false');
  await expect(summary).not.toContainText('Returns aren\'t captured yet');
  await expect(summary.locator('.amazon-coverage, .amazon-version')).toHaveCount(0);
  await counted.click();
  await expect(counted).toHaveAttribute('aria-expanded', 'true');
  await expect(summary).toContainText('Order totals come from Amazon and are never added to card spending.');
  // Each count says what it counts: card matches are payment records, not orders; refunds are each time one was seen.
  await expect(summary).toContainText('Card matches count Amazon\'s payment records matched against card transactions, not orders');
  await expect(summary).toContainText('Refund observations count each time a refund was seen, so one refund can count more than once.');
  await expect(summary).toContainText('Returns aren\'t captured yet');
  await expect(summary.locator('.amazon-counted-lines li')).toHaveText([
    'Payment records observed: 4',
    'Orders not assigned to anyone (For: Unknown): 2',
  ]);
  await expect(summary.locator('.amazon-coverage')).toContainText('Payments held · 0 records');
  await expect(summary.locator('.amazon-version')).toHaveText('Evidence revision amazon-v1-00000000000000000000beef');
  await expect(summary.locator('.amazon-limit')).toBeVisible();

  // Purchases first: the orders follow the summary under their own heading; the analysis of their items comes after them,
  // one step from that heading, focus included.
  const ordersTitle = page.getByRole('heading', { name: 'Orders', exact: true });
  const top = async (locator: ReturnType<Page['locator']>) => (await locator.boundingBox())!.y;
  await expect(page.locator('li.amazon-order')).toHaveCount(3);
  await expect(spendingPanel(page).locator('.amazon-figure').first()).toBeVisible();
  expect(await top(ordersTitle)).toBeGreaterThan(await top(summary));
  expect(await top(spendingPanel(page))).toBeGreaterThan(await top(page.locator('li.amazon-order').last()));
  await page.getByRole('button', { name: 'Go to spending by item' }).click();
  await expect(page.locator('#amazon-spending-title')).toBeFocused();
  await expect(page.locator('#amazon-spending-title')).toBeInViewport();

  const list = page.getByRole('list', { name: 'Amazon orders' });
  await expect(list.locator(':scope > li')).toHaveCount(3);
  await expect(page.getByText('Showing 3 of 3 orders')).toBeVisible();
  // Newest first, as the API orders them, each by its Amazon order date and total.
  await expect(list.locator('.amazon-order-date')).toHaveText(['Oct 12, 2026', 'Oct 5, 2026', 'Sep 28, 2026']);
  await expect(list.getByRole('heading', { level: 4 })).toHaveText(['Oct 12, 2026', 'Oct 5, 2026', 'Sep 28, 2026']);
  await expect(list.getByRole('link', { name: /^Amazon order of / })).toHaveCount(3);
  await expect(list.locator('.amazon-order-total')).toHaveText(['$42.10', '$19.99', '$20.00']);
  // Who each was for: assigned explicitly, else Unknown, never the card's owner.
  await expect(list.locator('.amazon-order-for')).toHaveText(['For: Unknown', 'For: Alex', 'For: Unknown']);
  // Ordinary Amazon orders (no purchase channel in the answer) say nothing of where they were bought.
  await expect(list.locator('.amazon-order-source')).toHaveCount(0);
  // Each card says its card match in one plain line, after its items; its payment, refunds and evidence are on its page.
  await expect(list.locator('.amazon-order-status')).toHaveCount(3);
  for (const n of [1, 2, 3]) {
    const card = orderCard(page, n);
    const box = async (selector: string) => (await card.locator(selector).last().boundingBox())!;
    expect((await box('.amazon-order-status')).y).toBeGreaterThan((await box('.amazon-item')).y);
    await expect(card).not.toContainText('Beneficiary');
    await expect(card).not.toContainText(/Paid by one card|Split payment|Payment split|refund|Held|candidate|tied by/);
  }

  // The linked order: full names (models included), quantities, each category and who chose it, and its card.
  const linked = orderCard(page, 1);
  const kettle = linked.locator('.amazon-item').filter({ hasText: KETTLE });
  await expect(kettle.locator('.amazon-item-title')).toHaveText(KETTLE);
  await expect(kettle.locator('.amazon-category')).toHaveText(/^Home\s*\(classified from its title\)$/);
  const filters = linked.locator('.amazon-item').filter({ hasText: FILTERS });
  await expect(filters).toContainText('Qty 2');
  await expect(filters.locator('.amazon-category')).toHaveText(/^Kitchen\s*\(your category\)$/);
  const link = linked.locator('.amazon-order-status');
  await expect(link).toHaveAttribute('data-status', 'linked');
  await expect(link).toHaveText(/^Linked to a card transaction\s*Chase Sample Rewards ··0001\s*Open transaction$/);

  // The held order: one plain line, its reason and candidates on its page only; its candidates appear nowhere.
  const held = orderCard(page, 2);
  await expect(held.locator('.amazon-order-status')).toHaveAttribute('data-status', 'review');
  await expect(held.locator('.amazon-order-status')).toHaveText('Card match needs review');
  await expect(held.getByRole('button', { name: /Open card transaction/ })).toHaveCount(0);
  await expect(held.locator('.amazon-category')).toHaveText('Uncategorized');
  const html = await page.content();
  for (const candidate of CANDIDATE_TXS) expect(html).not.toContain(candidate);

  // Refunds and a split payment: on the order's page, not its card.
  const refunded = orderCard(page, 3);
  await expect(refunded.locator('.amazon-order-status')).toHaveText('Card match needs review');

  // The list carries its items: no order is fetched one by one.
  expect(server.requests.filter((request) => /^\/amazon\/orders\/amz-/.test(request))).toEqual([]);
});

test('an order\'s own page shows unit prices, ASINs, gift card and balance apart from card spending, and refund destinations', async ({ page }) => {
  const server = await serveAmazon(page);
  await openAmazon(page);
  await orderCard(page, 3).getByRole('link', { name: 'Amazon order of Sep 28, 2026' }).click();
  await expect(page).toHaveURL(new RegExp(`#/everyday/amazon/orders/${ref(3)}$`));
  await expect(page).toHaveTitle('Amazon order · Everyday · Holdr');
  const order = page.locator('article.amazon-page');
  await expect(order.getByRole('heading', { level: 3 })).toHaveText('Amazon order · Sep 28, 2026');
  await expect(order.locator('.amazon-page-head .amazon-order-total')).toHaveText('$20.00');
  await expect(order.locator('.amazon-page-head')).toContainText('its own measure, never added to card spending');
  // Who it was for, how it was paid and how many refunds: the facts its card in the list leaves to this page.
  await expect(order.locator('.amazon-page-facts > div')).toHaveText([
    /^For\s*Unknown$/, /^Payment\s*Split payment$/, /^Items observed\s*1$/, /^Refunds\s*2$/,
  ]);

  // The card match in one plain line, and why behind "Why?".
  const match = order.getByRole('region', { name: 'Card match' });
  await expect(match.locator('.amazon-order-status')).toHaveText('Card match needs review');
  const why = match.getByRole('button', { name: /^Why\?/ });
  await expect(why).toHaveAttribute('aria-expanded', 'false');
  await expect(match).not.toContainText('payment evidence');
  await why.click();
  await expect(match.locator('.amazon-why-match')).toHaveText([
    /^Needs review:\s*there isn't enough payment evidence to match it\s*\(0 candidate card charges\)$/,
  ]);
  await expect(match).toContainText('how many card charges could match, never which');

  const items = order.getByRole('region', { name: 'Items' });
  await expect(items.locator('.amazon-item-title')).toHaveText(LAMP);
  await expect(items.locator('.amazon-item-meta')).toHaveText(/Qty 2\s*\$12\.50 each\s*ASIN B0000000A3/);
  await expect(items.locator('.amazon-category')).toHaveText(/^Home\s*\(classified from its title, 81% sure\)$/);

  const payment = order.getByRole('region', { name: 'Payment' });
  await expect(payment.locator('.amazon-payment-group').filter({ hasText: 'Paid with' })).toContainText('Visa ··0001');
  const nonCard = payment.locator('.amazon-non-card');
  await expect(nonCard).toContainText('not card spending');
  await expect(nonCard).toContainText('Amazon balance');
  await expect(nonCard).toContainText(/Gift card applied\s*−\$5\.00/);
  await expect(payment.locator('.amazon-payment-group').filter({ hasText: 'Paid with' })).not.toContainText('Amazon balance');
  await expect(payment.locator('.amazon-lines [data-kind="grand-total"]')).toHaveText(/Order total\s*\$20\.00/);

  const refunds = order.getByRole('region', { name: 'Refunds' });
  await expect(refunds.locator('.amazon-refunds li')).toHaveText([
    /Refund issued · \$15\.00 · to the card\s*Oct 2, 2026/,
    /Refund issued · \$5\.00 · to the Amazon balance\s*Oct 3, 2026/,
  ]);
  await expect(refunds).toContainText('never reduces card spending');

  // Back to the list as it was: its orders are kept, not fetched again.
  const listRequests = server.requests.filter((request) => request.startsWith('/amazon/orders?')).length;
  await order.getByRole('link', { name: 'All Amazon orders' }).click();
  await expect(page).toHaveURL(/#\/everyday\/amazon$/);
  await expect(page.getByRole('list', { name: 'Amazon orders' }).locator(':scope > li')).toHaveCount(3);
  expect(server.requests.filter((request) => request.startsWith('/amazon/orders?')).length).toBe(listRequests);
});

test('a linked order opens its card charge in Everyday; a held one has no link to follow', async ({ page }) => {
  await serveAmazon(page);
  await openAmazon(page, `#/everyday/amazon/orders/${ref(1)}`);
  const match = page.getByRole('region', { name: 'Card match' });
  await expect(match.locator('.amazon-order-status')).toHaveText(/^Linked to a card transaction\s*Chase Sample Rewards ··0001\s*Open transaction$/);
  // How it was tied, in Spending's words, behind "Why?".
  await expect(match).not.toContainText('tied by');
  await match.getByRole('button', { name: /^Why\?/ }).click();
  await expect(match.locator('.amazon-why-match')).toHaveText([/^Linked:\s*Chase Sample Rewards ··0001, tied by its order total only \(lower evidence\)$/]);
  await expect(match).not.toContainText('never which');
  await match.getByRole('button', { name: 'Open card transaction, Chase Sample Rewards ··0001' }).click();
  const dialog = page.getByRole('dialog', { name: 'SAMPLE MARKETPLACE ORDER' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await page.goto(`/#/everyday/amazon/orders/${ref(2)}`);
  const held = page.getByRole('region', { name: 'Card match' });
  await expect(held.locator('.amazon-order-status')).toHaveText('Card match needs review');
  await expect(held.getByRole('button', { name: /Open card transaction/ })).toHaveCount(0);
  // The keyboard opens "Why?" as any button.
  await held.getByRole('button', { name: /^Why\?/ }).focus();
  await page.keyboard.press('Enter');
  await expect(held.locator('.amazon-why-match[data-tone="held"]')).toHaveText(/^Needs review:\s*more than one order or charge could match, so none is linked yet\s*\(2 candidate card charges\)$/);
  await expect(held).not.toContainText('tied by');
});

test('a card charge\'s Amazon order in Spending opens its page here, and both say it in the same words', async ({ page }) => {
  await serveAmazon(page);
  // The linked charge's details as Spending answers them: how it was tied, its items' parts, and its order's opaque ref.
  await page.route((url) => url.pathname === `/card-transactions/${LINKED_TX}`, (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({
      transaction: LINKED_VIEW, cardAccount: CARD_A, importBatch: null, possiblyPostedAs: [],
      amazon: {
        version: SUMMARY.version, match: 'linked', evidenceClass: 'unique-total-match', aggregate: 'split',
        parts: [
          { category: 'Home', amountMinor: 3210, categorySource: 'agent-classification', classification: 'source', itemRef: 'amz-line-1a' },
          { category: 'Kitchen', amountMinor: 1000, categorySource: 'item-override', classification: 'source', itemRef: 'amz-line-1b' },
        ],
        items: [
          { itemRef: 'amz-line-1a', title: KETTLE, quantity: 1, asin: 'B0000000A1' },
          { itemRef: 'amz-line-1b', title: FILTERS, quantity: 2, asin: 'B0000000A2' },
        ],
        orderRefs: [ref(1)], coverage: { complete: false },
      },
    }),
  }));
  await openAmazon(page);
  await orderCard(page, 1).getByRole('button', { name: 'Open card transaction, Chase Sample Rewards ··0001' }).click();
  const dialog = page.getByRole('dialog', { name: 'SAMPLE MARKETPLACE ORDER' });
  const spending = dialog.getByRole('region', { name: 'Amazon order' });
  await expect(spending).toContainText('Amazon order, tied by its order total only (lower evidence).');
  await expect(spending).toContainText('Home (classified from its title)');
  await expect(spending).toContainText('Kitchen (your category)');

  await spending.getByRole('link', { name: 'Open the order in Amazon' }).click();
  await expect(page).toHaveURL(new RegExp(`#/everyday/amazon/orders/${ref(1)}$`));
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('article.amazon-page h3')).toHaveText('Amazon order · Oct 12, 2026');
  const charge = page.getByRole('region', { name: 'Card match' });
  await charge.getByRole('button', { name: /^Why\?/ }).click();
  await expect(charge.locator('.amazon-why-match[data-tone="linked"]'))
    .toContainText('Chase Sample Rewards ··0001, tied by its order total only (lower evidence)');
  const items = page.getByRole('region', { name: 'Items' }).locator('.amazon-item');
  await expect(items.filter({ hasText: KETTLE }).locator('.amazon-category')).toHaveText(/^Home\s*\(classified from its title, 92% sure\)$/);
  await expect(items.filter({ hasText: FILTERS }).locator('.amazon-category')).toHaveText(/^Kitchen\s*\(your category\)$/);
});

test('spending by item and category: each window\'s figures, what they leave out, a category\'s items and their orders', async ({ page }) => {
  const server = await serveAmazon(page);
  await openAmazon(page);
  const panel = spendingPanel(page);
  const periods = panel.getByRole('group', { name: 'Period' });
  await expect(periods.getByRole('button')).toHaveText(['30 days', '60 days', 'YTD', '1 year', '2 years']);
  await expect(periods.getByRole('button', { name: '30 days' })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.locator('.amazon-spending-measure')).toHaveText(/^Item prices by order date: not card spending\s*Sep 20 – Oct 19, 2026$/);

  // Item prices, the orders' own totals (a gift card paid part of one), and the categorized part, each in words.
  const figure = (label: string) => panel.locator('.amazon-figure').filter({ has: page.getByText(label, { exact: true }) });
  await expect(figure('Spent on items')).toContainText('$83.98');
  await expect(figure('Spent on items')).toContainText('4 items in 3 orders, before tax and shipping');
  await expect(figure('Order totals')).toContainText('$82.09');
  await expect(figure('Categorized')).toContainText('$63.99');
  await expect(figure('Categorized')).toContainText('76% of item prices');
  const coverage = panel.getByRole('list', { name: 'What these figures cover' });
  await expect(coverage.locator('li')).toHaveText([
    'Items proven complete in 3 of 3 orders: $82.09 of $82.09 in order totals (100%)',
    'Linked to a card charge: 1 of 3 orders · 2 held for review',
    'Itemized in Spending: 1 of 1 linked card charge',
    '1 order has a refund; refunds aren\'t taken off item prices',
  ]);

  // Categories largest first, each with its share of item prices; then the items, largest first.
  const categories = panel.locator('.amazon-spending-categories .spending-rank-row');
  await expect(categories.locator('.spending-rank-name')).toHaveText(['Home', 'Uncategorized', 'Kitchen']);
  await expect(categories.locator('.spending-rank-amount')).toHaveText(['$54.99', '$19.99', '$9.00']);
  await expect(categories.locator('.spending-rank-share')).toHaveText(['65%', '23%', '10%']);
  await expect(categories.locator('.spending-rank-note')).toHaveText(['2 items · 2 orders', '1 item · 1 order', '1 item · 1 order']);
  const items = panel.getByRole('list', { name: 'Items, largest first' }).locator('.amazon-spend-item');
  await expect(items.locator('.amazon-item-title')).toHaveText([KETTLE, LAMP, CABLE, FILTERS]);
  await expect(items.locator('.amazon-spend-amount')).toHaveText(['$29.99', '$25.00', '$19.99', '$9.00']);
  await expect(items.nth(0).locator('.amazon-category')).toHaveText(/^Home\s*\(classified from its title\)$/);
  await expect(items.nth(1).locator('.amazon-item-meta')).toHaveText(/Qty 2\s*1 order\s*Last ordered Sep 28, 2026\s*ASIN B0000000A3/);
  await expect(items.nth(2).locator('.amazon-category')).toHaveText('Uncategorized');
  await expect(items.nth(3).locator('.amazon-category')).toHaveText(/^Kitchen\s*\(your category\)$/);

  // A category narrows the items to its own.
  await categories.filter({ hasText: 'Home' }).click();
  await expect(categories.filter({ hasText: 'Home' })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByRole('heading', { name: 'Items in Home' })).toBeVisible();
  await expect(panel.getByRole('list', { name: 'Items in Home, largest first' }).locator('.amazon-item-title')).toHaveText([KETTLE, LAMP]);

  // A year, the category still chosen: the kettle bought twice is one item, over two orders.
  await periods.getByRole('button', { name: '1 year' }).click();
  await expect(periods.getByRole('button', { name: '1 year' })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.locator('.amazon-spending-measure')).toContainText('Oct 20, 2025 – Oct 19, 2026');
  const home = panel.getByRole('list', { name: 'Items in Home, largest first' }).locator('.amazon-spend-item');
  await expect(home.locator('.amazon-item-title')).toHaveText([KETTLE, LAMP, 'Sample Batteries AA (24-Pack)']);
  await expect(home.first().locator('.amazon-item-meta')).toContainText(/Qty 2\s*2 orders/);
  // What the year's figures can't vouch for: unproven item lists, unpriced items, and an order without a total.
  await expect(coverage.locator('li')).toHaveText([
    'Items proven complete in 11 of 14 orders: $520.00 of $620.00 in order totals (83%)',
    'Not proven complete: 2 orders, which may have more items than counted here',
    'Left out of item prices: 1 item without a price · 1 item without a quantity · 1 order whose items weren\'t captured',
    'Order totals leave out 1 order without a captured total',
    'Linked to a card charge: 6 of 14 orders · 5 held for review · 3 not matched',
    'Itemized in Spending: 2 of 7 linked card charges',
    '1 order has a refund; refunds aren\'t taken off item prices',
  ]);
  await expect(figure('Order totals')).toContainText('13 of 14 orders with a total, tax and shipping included');
  // Every category again: the top ten, then all thirteen; a title the API hid stays hidden.
  await panel.getByRole('button', { name: 'Show every category' }).click();
  const all = panel.getByRole('list', { name: 'Items, largest first' }).locator('.amazon-spend-item');
  await expect(all).toHaveCount(10);
  await panel.getByRole('button', { name: 'Show all 13 items' }).click();
  await expect(all).toHaveCount(13);
  await expect(all.last().locator('.amazon-hidden-title')).toHaveText('Title hidden: it looked like card details');

  // Back to 30 days: read once already, so not asked again; each window asked for with the viewer's date.
  await periods.getByRole('button', { name: '30 days' }).click();
  await expect(figure('Spent on items')).toContainText('$83.98');
  const asked = server.requests.filter((request) => request.startsWith('/amazon/spending?'));
  expect(new Set(asked.map((request) => new URL(request, 'http://synthetic.invalid').searchParams.get('window')))).toEqual(new Set(['30D', '1Y']));
  for (const request of asked) expect(request).toMatch(/^\/amazon\/spending\?window=(30D|1Y)&today=\d{4}-\d{2}-\d{2}$/);

  // An item's latest order opens its page; back on the list, the figures are as they were, not asked for again.
  await items.first().getByRole('link', { name: 'Amazon order of Oct 12, 2026' }).click();
  await expect(page).toHaveURL(new RegExp(`#/everyday/amazon/orders/${ref(1)}$`));
  await expect(page.locator('article.amazon-page h3')).toHaveText('Amazon order · Oct 12, 2026');
  await page.getByRole('link', { name: 'All Amazon orders' }).click();
  await expect(figure('Spent on items')).toContainText('$83.98');
  expect(server.requests.filter((request) => request.startsWith('/amazon/spending?'))).toHaveLength(asked.length);
});

test('spending reads "not reported" from an API without it, and asks no more', async ({ page }) => {
  const server = await serveAmazon(page, { spending: null });
  await openAmazon(page);
  const panel = spendingPanel(page);
  await expect(panel).toContainText('Spending by item isn\'t reported by this version of Holdr.');
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(panel.locator('.amazon-figure')).toHaveCount(0);
  await panel.getByRole('button', { name: '1 year' }).click();
  await expect(panel).toContainText('Spending by item isn\'t reported by this version of Holdr.');
  expect(new Set(server.requests.filter((request) => request.startsWith('/amazon/spending?'))
    .map((request) => new URL(request, 'http://synthetic.invalid').searchParams.get('window')))).toEqual(new Set(['30D']));
  // The orders still show.
  await expect(page.locator('.amazon-order')).toHaveCount(3);
});

test('a spending answer that doesn\'t add up is an error, never figures, until it reads', async ({ page }) => {
  // Item prices less than their own categorized part.
  const recent = SPENDING['30D'] as { totals: Json[] };
  const server = await serveAmazon(page, { spending: { ...SPENDING, '30D': { ...recent, totals: [{ ...recent.totals[0], itemMinor: 1 }] } } });
  await openAmazon(page);
  const panel = spendingPanel(page);
  await expect(panel.getByRole('alert')).toContainText('Amazon spending: Holdr couldn\'t read the Amazon answer (totals).');
  await expect(panel.locator('.amazon-figure')).toHaveCount(0);
  server.spending = SPENDING;
  await panel.getByRole('button', { name: 'Try again' }).click();
  await expect(panel.locator('.amazon-figure').first()).toContainText('$83.98');
  await expect(panel.getByRole('alert')).toHaveCount(0);
});

test('a window with orders but no item price or total says what is missing, never a figure of nothing', async ({ page }) => {
  const bare = spendingAnswer('30D', '2026-09-20', '2026-10-19', [], {
    orders: { count: 2, withTotal: 0, itemsComplete: 0, noLines: 2, refunded: 0, linked: 0, held: 0, unmatched: 2 },
    cardCharges: { linked: 0, itemized: 0 },
    orderTotals: {},
  });
  await serveAmazon(page, { spending: { ...SPENDING, '30D': bare } });
  await openAmazon(page);
  const panel = spendingPanel(page);
  await expect(panel.getByRole('status')).toHaveText('No item prices or order totals in the last 30 days.');
  await expect(panel.getByRole('list', { name: 'What these figures cover' }).locator('li')).toHaveText([
    'Items proven complete in 0 of 2 orders',
    'Left out of item prices: 2 orders whose items weren\'t captured',
    'Order totals leave out 2 orders without a captured total',
    'Linked to a card charge: 0 of 2 orders · 2 not matched',
  ]);
  await expect(panel.locator('.amazon-figure')).toHaveCount(0);
});

test('a category whose items all fall below the largest the API lists says so, never "no items"', async ({ page }) => {
  // As the API's cap would leave it: the kitchen's item off the list, the categories still counting it.
  const full = spendingAnswer('30D', '2026-09-20', '2026-10-19', RECENT, RECENT_FACTS) as Json & { products: Json[] };
  await serveAmazon(page, { spending: { ...SPENDING, '30D': { ...full, products: full.products.filter((product) => product.category !== 'Kitchen') } } });
  await openAmazon(page);
  const panel = spendingPanel(page);
  await panel.locator('.amazon-spending-categories .spending-rank-row').filter({ hasText: 'Kitchen' }).click();
  await expect(panel.getByRole('heading', { name: 'Items in Kitchen' })).toBeVisible();
  await expect(panel.locator('.amazon-spending-part').last()).toContainText(
    'Kitchen\'s 1 item isn\'t among the 3 largest listed; the totals count it.');
  await expect(panel).not.toContainText('No items in Kitchen');
  await expect(panel.locator('.amazon-spend-item')).toHaveCount(0);
});

/** One grey pixel as a PNG: a synthetic stand-in for a cached thumbnail, never a product image. */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64');

test('each item shows its cached thumbnail beside it, from Holdr\'s own origin, or a neutral placeholder', async ({ page }) => {
  const line = (n: number) => ref(0x1000 + n);
  const image = (n: number) => `/amazon/items/${line(n)}/image`;
  const [kettle, filters] = DETAILS[ref(1)].items as Json[];
  const order = {
    ...DETAILS[ref(1)], itemObservations: 3,
    items: [
      { ...kettle, ref: line(1), image: true },
      // Cached, but its image no longer loads: the placeholder takes its place.
      { ...filters, ref: line(2), image: true },
      { ref: line(3), title: LAMP, asin: null, quantity: 1, unitPrice: null, attribution: 'observation-only', category: null,
        categorySource: null, confidence: null },
    ],
  };
  // The spending-by-item list names the kettle by its latest line, with a cached thumbnail; the rest have none.
  const recent = spendingAnswer('30D', '2026-09-20', '2026-10-19', RECENT, RECENT_FACTS) as Json & { products: Json[] };
  Object.assign(recent.products[0], { ref: line(1), image: true });
  await serveAmazon(page, { rows: [listRow(order)], details: { [ref(1)]: order }, spending: { ...SPENDING, '30D': recent } });
  const asked: string[] = [];
  await page.route((url) => /^\/amazon\/items\/[^/]+\/image$/.test(url.pathname), (route) => {
    const { pathname } = new URL(route.request().url());
    asked.push(pathname);
    return pathname === image(1)
      ? route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL })
      : route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'amazon item image not found' }) });
  });
  const loaded = async (thumb: ReturnType<Page['locator']>) => expect.poll(() => thumb.evaluate(
    (element) => ((element as HTMLImageElement).complete ? (element as HTMLImageElement).naturalWidth : 0))).toBeGreaterThan(0);
  // The linked card charge, in the transactions list and in its details, carrying the order's items.
  const amazon = {
    version: SUMMARY.version, match: 'linked', evidenceClass: 'unique-total-match', aggregate: 'split',
    parts: [
      { category: 'Home', amountMinor: 3210, categorySource: 'agent-classification', classification: 'source', itemRef: line(1) },
      { category: 'Shopping', amountMinor: 1000, categorySource: 'original-effective', classification: 'residual' },
    ],
    items: [
      { itemRef: line(1), title: KETTLE, quantity: 1, asin: 'B0000000A1', image: true },
      { itemRef: line(3), title: LAMP, quantity: 1, asin: null },
    ],
    orderRefs: [ref(1)], coverage: { complete: false },
  };
  await page.route((url) => url.pathname === '/card-transactions', (route) => {
    const posted = new URL(route.request().url()).searchParams.get('status') === 'posted';
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      transactions: posted ? [{ ...LINKED_VIEW, amazon }] : [], total: posted ? 1 : 0, limit: 100, offset: 0, nextOffset: null,
    }) });
  });
  await page.route((url) => url.pathname === `/card-transactions/${LINKED_TX}`, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ transaction: LINKED_VIEW, cardAccount: CARD_A, importBatch: null, possiblyPostedAs: [], amazon }),
  }));

  await openAmazon(page);
  const listed = orderCard(page, 1).locator('.amazon-item');
  await expect(listed).toHaveCount(3);
  const thumb = listed.nth(0).locator('img.amazon-thumb');
  await expect(thumb).toHaveAttribute('src', image(1));
  await expect(thumb).toHaveAttribute('alt', '');
  await loaded(thumb);
  for (const n of [1, 2]) {
    await expect(listed.nth(n).locator('.amazon-thumb.placeholder')).toBeVisible();
    await expect(listed.nth(n).locator('img')).toHaveCount(0);
  }
  // Beside the item: left of its title, level with it.
  const thumbBox = (await thumb.boundingBox())!, titleBox = (await listed.nth(0).locator('.amazon-item-title').boundingBox())!;
  expect(thumbBox.x + thumbBox.width).toBeLessThanOrEqual(titleBox.x);
  expect(titleBox.y).toBeGreaterThanOrEqual(thumbBox.y - 1);
  expect(titleBox.y).toBeLessThan(thumbBox.y + thumbBox.height);
  // Only the cached ones are asked for, and only of this origin: the item without a thumbnail asks nothing.
  expect(new Set(asked)).toEqual(new Set([image(1), image(2)]));
  const spent = spendingPanel(page).locator('.amazon-spend-item');
  await expect(spent.first()).toContainText(KETTLE);
  await expect(spent.first().locator('img.amazon-thumb.medium')).toHaveAttribute('src', image(1));
  await loaded(spent.first().locator('img.amazon-thumb'));
  await expect(spent.nth(1).locator('.amazon-thumb.placeholder')).toBeVisible();

  await page.goto(`/#/everyday/amazon/orders/${ref(1)}`);
  const onPage = page.getByRole('region', { name: 'Items' }).locator('.amazon-item');
  await expect(onPage.nth(0).locator('img.amazon-thumb.large')).toHaveAttribute('src', image(1));
  await loaded(onPage.nth(0).locator('img.amazon-thumb'));
  await expect(onPage.nth(2).locator('.amazon-thumb.placeholder')).toBeVisible();

  // The card charge's items, in its details and in the transactions list: the same thumbnails beside them.
  await page.getByRole('region', { name: 'Card match' }).getByRole('button', { name: 'Open card transaction, Chase Sample Rewards ··0001' }).click();
  const detail = page.getByRole('dialog', { name: 'SAMPLE MARKETPLACE ORDER' }).getByRole('region', { name: 'Amazon order' });
  const detailLines = detail.locator('.spending-amazon-items li');
  await expect(detailLines).toHaveCount(3);
  await expect(detailLines.nth(0).locator('img.amazon-thumb.medium')).toHaveAttribute('src', image(1));
  await expect(detailLines.nth(1).locator('.amazon-thumb.placeholder')).toBeVisible();
  // The rest of the charge has no item and no thumbnail, its text still level with the items'.
  await expect(detailLines.nth(2).locator('.amazon-thumb')).toHaveCount(0);
  const restBox = (await detailLines.nth(2).locator('.spending-amazon-title').boundingBox())!;
  const itemBox = (await detailLines.nth(0).locator('.spending-amazon-title').boundingBox())!;
  expect(Math.abs(restBox.x - itemBox.x)).toBeLessThanOrEqual(1);
  await page.keyboard.press('Escape');

  await page.goto('/#/everyday/transactions');
  const row = page.locator(`li.spending-row[data-transaction-id="${LINKED_TX}"]`);
  await row.getByRole('button', { name: /^Amazon · 2 items: / }).click();
  const rowLines = row.locator('.spending-row-amazon-items li');
  await expect(rowLines).toHaveCount(3);
  await expect(rowLines.nth(0).locator('img.amazon-thumb.small')).toHaveAttribute('src', image(1));
  await loaded(rowLines.nth(0).locator('img.amazon-thumb'));
  await expect(rowLines.nth(1).locator('.amazon-thumb.placeholder')).toBeVisible();
  await expect(rowLines.nth(2).locator('.amazon-thumb')).toHaveCount(0);
  expect(await overflow(page)).toBeLessThanOrEqual(1);
});

test('the For filter asks the API, and an order nobody was assigned stays Unknown', async ({ page }) => {
  const server = await serveAmazon(page);
  await openAmazon(page);
  const beneficiary = page.getByRole('combobox', { name: 'For' });
  await beneficiary.selectOption({ label: 'Casey' });
  await expect(page.getByText('No orders for Casey')).toBeVisible();
  await expect(page.locator('.amazon-empty')).toContainText('An order is for someone only when it was assigned explicitly; the others stay Unknown.');
  await expect(page.locator('.amazon-order')).toHaveCount(0);
  await beneficiary.selectOption({ label: 'Unknown' });
  await expect(page.locator('.amazon-order')).toHaveCount(2);
  await expect(page.locator('.amazon-order-for')).toHaveText(['For: Unknown', 'For: Unknown']);
  await expect(page.getByText('Showing 2 of 2 orders')).toBeVisible();
  await beneficiary.selectOption({ label: 'Everyone' });
  await expect(page.locator('.amazon-order')).toHaveCount(3);
  const lists = server.requests.filter((request) => request.startsWith('/amazon/orders?'));
  expect([...new Set(lists)]).toEqual([
    '/amazon/orders?offset=0&limit=50',
    '/amazon/orders?offset=0&limit=50&beneficiary=casey',
    '/amazon/orders?offset=0&limit=50&beneficiary=unknown',
  ]);
  expect(lists.at(-1)).toBe('/amazon/orders?offset=0&limit=50');
});

test('from an older read API, items load per order on request and matches and refunds read "not reported", never "none"', async ({ page }) => {
  const rows = Array.from({ length: 60 }, (_, index) => olderRow({ ...DETAILS[ref(1)], ref: ref(100 + index),
    date: `2026-08-${String(30 - Math.floor(index / 2)).padStart(2, '0')}` }));
  const details = { ...DETAILS, [ref(100)]: { ...olderRow(DETAILS[ref(1)]), ref: ref(100), date: '2026-08-30',
    items: [{ ref: 'amz-line-x', title: KETTLE, quantity: 1, unitPrice: usd(2999), attribution: 'observation-only' }],
    summary: [], paymentMethods: [] },
  // An item without its ref: that answer's items can't be read.
  [ref(101)]: { ...olderRow(DETAILS[ref(1)]), ref: ref(101), date: '2026-08-30', items: [{ title: CABLE, quantity: 1 }] } };
  const server = await serveAmazon(page, { summary: { ...SUMMARY, orders: 60 }, rows, details });
  await openAmazon(page);
  await expect(page.getByText('Showing 50 of 60 orders')).toBeVisible();
  const first = orderCard(page, 100);
  await expect(first.locator('.amazon-order-status')).toHaveAttribute('data-status', 'unreported');
  await expect(first.locator('.amazon-order-status')).toHaveText('Card match not reported');
  await expect(first).not.toContainText('No card match');
  await first.getByRole('button', { name: 'Show 2 items' }).click();
  await expect(first.locator('.amazon-item-title')).toHaveText(KETTLE);
  // That API reported no categories: not "Uncategorized".
  await expect(first.locator('.amazon-category')).toHaveText('Category not reported');
  expect(server.requests.filter((request) => /^\/amazon\/orders\/amz-/.test(request))).toEqual([`/amazon/orders/${ref(100)}`]);

  await page.getByRole('button', { name: 'Show 10 more' }).click();
  await expect(page.getByText('Showing 60 of 60 orders')).toBeVisible();
  await expect(page.locator('.amazon-order')).toHaveCount(60);
  await expect(page.getByRole('button', { name: /more$/ })).toHaveCount(0);
  expect([...new Set(server.requests.filter((request) => request.startsWith('/amazon/orders?')))]).toEqual([
    '/amazon/orders?offset=0&limit=50', '/amazon/orders?offset=50&limit=50',
  ]);

  // An order whose own answer carries no readable items says so, rather than offering them again.
  const second = orderCard(page, 101);
  await second.getByRole('button', { name: 'Show 2 items' }).click();
  await expect(second).toContainText('Items not reported');
  await expect(second.getByRole('button', { name: 'Show 2 items' })).toHaveCount(0);
});

test('"Show more" waits while the first page reloads, so no order is skipped or repeated', async ({ page }) => {
  const rows = Array.from({ length: 150 }, (_, index) => olderRow({ ...DETAILS[ref(1)], ref: ref(300 + index) }));
  const server = await serveAmazon(page, { summary: { ...SUMMARY, orders: 150 }, rows });
  await openAmazon(page);
  const more = page.getByRole('button', { name: 'Show 50 more' });
  await more.click();
  await expect(page.getByText('Showing 100 of 150 orders')).toBeVisible();

  // Away to another beneficiary and straight back, both answers held: the hundred rows already read show again
  // while the first page reloads, and more can't be asked for from them.
  const lists = server.hold((url) => url.pathname === '/amazon/orders');
  const beneficiary = page.getByRole('combobox', { name: 'For' });
  await beneficiary.selectOption({ label: 'Alex' });
  await beneficiary.selectOption({ label: 'Everyone' });
  await expect(page.getByText('Showing 100 of 150 orders')).toBeVisible();
  await expect(more).toBeDisabled();
  lists.release();
  await expect(page.getByText('Showing 50 of 150 orders')).toBeVisible();
  await more.click();
  await expect(page.getByText('Showing 100 of 150 orders')).toBeVisible();
  await more.click();
  await expect(page.getByText('Showing 150 of 150 orders')).toBeVisible();
  const shown = await page.locator('li.amazon-order').evaluateAll((items) => items.map((item) => item.getAttribute('data-order')));
  expect(shown).toEqual(rows.map((row) => row.ref));
});

test('keyboard: arrow keys reach the Amazon tab, an order opens with Enter, and its back link returns', async ({ page }) => {
  await serveAmazon(page);
  await page.goto('/#/everyday/benefits');
  await areas(page).getByRole('tab', { name: 'Benefits' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(amazonTab(page)).toBeFocused();
  await expect(amazonTab(page)).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/#\/everyday\/amazon$/);
  await page.keyboard.press('ArrowRight');
  await expect(areas(page).getByRole('tab', { name: 'Costco receipts' })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(amazonTab(page)).toBeFocused();

  const link = orderCard(page, 2).getByRole('link', { name: 'Amazon order of Oct 5, 2026' });
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`#/everyday/amazon/orders/${ref(2)}$`));
  await expect(page.locator('article.amazon-page h3')).toHaveText('Amazon order · Oct 5, 2026');
  // Like any in-app link: the page's top, with focus on the section's tab.
  await expect(amazonTab(page)).toBeFocused();
  const back = page.getByRole('link', { name: 'All Amazon orders' });
  await back.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/everyday\/amazon$/);
  await expect(page.locator('.amazon-order')).toHaveCount(3);
  // Back and forward step through the same pages.
  await page.goBack();
  await expect(page.locator('article.amazon-page h3')).toHaveText('Amazon order · Oct 5, 2026');
  await page.goForward();
  await expect(page.locator('article.amazon-page')).toHaveCount(0);
});

test('an order that isn\'t in Holdr says so, and a malformed answer is an error, never an empty state', async ({ page }) => {
  await serveAmazon(page, { summary: { ...SUMMARY, measure: 'card-spending' } });
  await openAmazon(page, `#/everyday/amazon/orders/${ref(9)}`);
  await expect(page.getByText('This Amazon order isn\'t in Holdr')).toBeVisible();
  await page.getByRole('link', { name: 'All Amazon orders' }).click();
  await expect(page.locator('.amazon').getByRole('alert')).toContainText('Amazon summary: Holdr couldn\'t read the Amazon answer (measure).');
  await expect(page.getByText('No Amazon data imported yet')).toHaveCount(0);
  await expect(page.locator('.amazon-summary')).toHaveCount(0);
  // The orders still show; only the summary failed.
  await expect(page.locator('.amazon-order')).toHaveCount(3);
});

/** An order's held matches, all alike: what a capture can report for an order whose payments are each held. */
const holds = (count: number, reason: string, candidateCount: number): Json[] =>
  Array.from({ length: count }, () => ({ state: 'held', evidenceClass: 'unique-total-match', reason, candidateCount }));

test('holds and links are each one plain line on the card; the order\'s page says why, holds alike once with how many; a list\'s categories carry their source on their edge', async ({ page }) => {
  const linkedTwice = { state: 'linked', evidenceClass: 'payment-event', cardTransactionId: `card-txn-${'4'.repeat(32)}`, cardAccountId: CARD_B.id };
  const details = {
    ...DETAILS,
    [ref(1)]: { ...DETAILS[ref(1)], matches: [...(DETAILS[ref(1)].matches as Json[]), linkedTwice] },
    [ref(2)]: { ...DETAILS[ref(2)], matches: [...holds(3, 'ambiguous', 2), ...holds(2, 'evidence-held', 0), ...holds(1, 'ambiguous', 2)] },
    [ref(3)]: { ...DETAILS[ref(3)], matches: holds(5, 'evidence-held', 0) },
  };
  await serveAmazon(page, { details, rows: Object.values(details).map(listRow) });
  await openAmazon(page);

  // Five holds alike, or six of two kinds: on the card, one plain line each, with no reason, count or chip.
  for (const n of [2, 3]) {
    const status = orderCard(page, n).locator('.amazon-order-status');
    await expect(status).toHaveText('Card match needs review');
    await expect(status).toHaveAttribute('data-status', 'review');
    expect(await status.evaluate((el) => getComputedStyle(el).borderLeftWidth)).toBe('0px');
  }
  await expect(page.locator('.amazon-order .amazon-match-times')).toHaveCount(0);
  // Two linked charges: one line, each card with its own way to open its charge.
  const links = orderCard(page, 1).locator('.amazon-order-status');
  await expect(links).toHaveText(/^Linked to 2 card transactions\s*Chase Sample Rewards ··0001\s*Open transaction\s*Amex Sample Gold ··0002\s*Open transaction$/);
  await expect(links.getByRole('button', { name: /^Open card transaction, / })).toHaveText(['Open transaction', 'Open transaction']);
  // A card's other facts: only who it was for; its payment and refunds are on its page.
  await expect(orderCard(page, 3).locator('.amazon-order-for')).toHaveText('For: Unknown');
  await expect(orderCard(page, 3)).not.toContainText(/Split payment|2 refunds/);

  // In the list a category classified from its title says so on its dashed edge, its words in its title and for screen
  // readers; yours is said in words. A line above the list explains the edge once.
  await expect(page.locator('.amazon-legend')).toHaveText('Dashed categories were classified from the item\'s title; an order\'s own page says how sure.');
  const kettle = orderCard(page, 1).locator('.amazon-item').filter({ hasText: KETTLE }).locator('.amazon-category');
  await expect(kettle).toHaveAttribute('data-source', 'edge');
  await expect(kettle).toHaveAttribute('title', 'Home (classified from its title)');
  await expect(kettle.locator('.amazon-category-source')).toHaveClass(/visually-hidden/);
  expect(await kettle.locator('.amazon-category-name').evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('dashed');
  const filters = orderCard(page, 1).locator('.amazon-item').filter({ hasText: FILTERS }).locator('.amazon-category');
  await expect(filters).not.toHaveAttribute('data-source', 'edge');
  await expect(filters.locator('.amazon-category-source')).toBeVisible();
  await expect(filters.locator('.amazon-category-source')).not.toHaveClass(/visually-hidden/);

  // An order's own page says the source in words, and under "Why?" its holds alike once (seen as ×5, heard as "5 times").
  await orderCard(page, 3).getByRole('link', { name: 'Amazon order of Sep 28, 2026' }).click();
  const lamp = page.getByRole('region', { name: 'Items' }).locator('.amazon-category');
  await expect(lamp.locator('.amazon-category-source')).toBeVisible();
  await expect(lamp.locator('.amazon-category-source')).toHaveText('(classified from its title, 81% sure)');
  const charge = page.getByRole('region', { name: 'Card match' });
  await expect(charge.locator('.amazon-order-status')).toHaveText('Card match needs review');
  await charge.getByRole('button', { name: /^Why\?/ }).click();
  const repeated = charge.locator('.amazon-why-match[data-tone="held"]');
  await expect(repeated).toHaveCount(1);
  await expect(repeated).toHaveAttribute('data-count', '5');
  await expect(repeated).toHaveText(/^Needs review:\s*there isn't enough payment evidence to match it\s*\(0 candidate card charges\)\s*×5 \(5 times\)$/);
  await expect(repeated.locator('.amazon-match-times [aria-hidden="true"]')).toHaveText('×5');
  // Two reasons: one entry each, in the order they first came, each with its own count.
  await page.goto(`/#/everyday/amazon/orders/${ref(2)}`);
  const mixedCharge = page.getByRole('region', { name: 'Card match' });
  await mixedCharge.getByRole('button', { name: /^Why\?/ }).click();
  await expect(mixedCharge.locator('.amazon-why-match[data-tone="held"]')).toHaveText([
    /^Needs review:\s*more than one order or charge could match, so none is linked yet\s*\(2 candidate card charges\)\s*×4 \(4 times\)$/,
    /^Needs review:\s*there isn't enough payment evidence to match it\s*\(0 candidate card charges\)\s*×2 \(2 times\)$/,
  ]);
  // Each linked charge once, how it was tied in Spending's words.
  await page.goto(`/#/everyday/amazon/orders/${ref(1)}`);
  const linkedCharge = page.getByRole('region', { name: 'Card match' });
  await linkedCharge.getByRole('button', { name: /^Why\?/ }).click();
  await expect(linkedCharge.locator('.amazon-why-match')).toHaveText([
    /^Linked:\s*Chase Sample Rewards ··0001, tied by its order total only \(lower evidence\)$/,
    /^Linked:\s*Amex Sample Gold ··0002, tied by its Amazon payment$/,
  ]);
});

test('every Amazon text reads at its floor at 1920 and 375px: the figures, folds opened, the lists and an order\'s page', async ({ page }) => {
  await serveAmazon(page);
  for (const width of [1920, 375]) {
    const where = `${width}px`;
    await page.setViewportSize({ width, height: 900 });
    await openAmazon(page);
    await page.reload();
    const summary = page.getByRole('region', { name: 'Amazon order activity' });
    await summary.getByRole('button', { name: 'How this was counted' }).click();
    await expect(summary.locator('.amazon-version')).toBeVisible();
    await expect(spendingPanel(page).locator('.amazon-spend-item')).toHaveCount(4);
    await expect(page.locator('.amazon-order-status')).toHaveCount(3);
    expect(await textBelowFloors(page), `the orders at ${where}`).toEqual([]);
    await expectReading(page, ['.amazon-item-title', '.amazon-order-date', '.amazon-spend-amount', '.amazon .spending-rank-name',
      '.amazon .spending-rank-amount', '.amazon-spending-part h4'], where);
    for (const size of await sizes(page.locator('.amazon h3'))) expect(size, `a section head at ${where}`).toBeGreaterThanOrEqual(width >= 1280 ? 20 : 18);

    // Nothing for one person: the empty list's words too, its sentence as prose.
    await page.getByRole('combobox', { name: 'For' }).selectOption({ label: 'Casey' });
    await expect(page.getByText('No orders for Casey')).toBeVisible();
    expect(await textBelowFloors(page), `no orders for a person at ${where}`).toEqual([]);
    await expectReading(page, ['.amazon-empty p'], where);

    // An order's page with "Why?" open: its facts, items, card match, payment and refunds.
    await page.goto(`/#/everyday/amazon/orders/${ref(3)}`);
    const charge = page.getByRole('region', { name: 'Card match' });
    await charge.getByRole('button', { name: /^Why\?/ }).click();
    await expect(charge.locator('.amazon-why-match')).toHaveCount(1);
    expect(await textBelowFloors(page), `an order's page at ${where}`).toEqual([]);
    await expectReading(page, ['.amazon-page-facts dd', '.amazon-item-title', '.amazon-section .amazon-order-status',
      '.amazon-section h4', '.amazon-payment-group li', '.amazon-lines dt', '.amazon-lines dd', '.amazon-refunds li > span:first-child'], where);
    const [title] = await sizes(page.locator('article.amazon-page h3'));
    expect(title, `the order's title at ${where}`).toBeGreaterThanOrEqual(width >= 1280 ? 20 : 18);
    // Prose keeps to a readable measure (65ch) however wide the page is.
    for (const prose of [charge.locator('.fold-content > p'), page.getByRole('region', { name: 'Refunds' }).locator('p.spending-muted')]) {
      const box = (await prose.boundingBox())!;
      expect(box.width, `a paragraph's measure at ${where}`).toBeLessThanOrEqual(width >= 1280 ? 720 : width);
    }
    expect(await overflow(page), where).toBeLessThanOrEqual(0);
  }
});

test('errors and empty states read at their floors too, at 1920 and 375px', async ({ page }) => {
  // The summary, spending by item and an order's items all fail; the order itself isn't in Holdr.
  const recent = SPENDING['30D'] as { totals: Json[] };
  const server = await serveAmazon(page, {
    summary: { ...SUMMARY, measure: 'card-spending' }, rows: [olderRow(DETAILS[ref(1)])], details: {},
    spending: { ...SPENDING, '30D': { ...recent, totals: [{ ...recent.totals[0], itemMinor: 1 }] } },
  });
  for (const width of [1920, 375]) {
    const where = `${width}px`;
    await page.setViewportSize({ width, height: 900 });
    await openAmazon(page);
    await page.reload();
    await expect(page.locator('.amazon-error').filter({ hasText: 'Amazon summary:' })).toBeVisible();
    await expect(spendingPanel(page).getByRole('alert')).toContainText('Amazon spending:');
    await orderCard(page, 1).getByRole('button', { name: 'Show 2 items' }).click();
    await expect(orderCard(page, 1).getByRole('alert')).toBeVisible();
    expect(await textBelowFloors(page), `errors at ${where}`).toEqual([]);
    await page.goto(`/#/everyday/amazon/orders/${ref(9)}`);
    await expect(page.getByText('This Amazon order isn\'t in Holdr')).toBeVisible();
    expect(await textBelowFloors(page), `an order not in Holdr at ${where}`).toEqual([]);
  }
  server.summary = EMPTY_SUMMARY;
  server.rows = [];
  for (const width of [1920, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await openAmazon(page);
    await page.reload();
    await expect(page.getByText('No Amazon data imported yet')).toBeVisible();
    expect(await textBelowFloors(page), `nothing imported at ${width}px`).toEqual([]);
    await expectReading(page, ['.amazon-empty p'], `nothing imported at ${width}px`);
  }
});

test('a Whole Foods store\'s receipt says so on its card and its page; an ordinary order says nothing of where it was bought', async ({ page }) => {
  const details = { ...DETAILS, [ref(2)]: { ...DETAILS[ref(2)], purchaseChannel: 'whole-foods-in-store' },
    [ref(3)]: { ...DETAILS[ref(3)], purchaseChannel: null } };
  await serveAmazon(page, { details, rows: Object.values(details).map(listRow) });
  await openAmazon(page);
  await expect(orderCard(page, 2).locator('.amazon-order-source')).toHaveText('Whole Foods (in store)');
  await expect(page.locator('.amazon-order-source')).toHaveCount(1);
  await expect(page.locator('.amazon')).not.toContainText(/fresh delivery/i);
  // Its own page says the same, first among its facts; an ordinary order's page says nothing of a source.
  await orderCard(page, 2).getByRole('link', { name: 'Amazon order of Oct 5, 2026' }).click();
  await expect(page.locator('.amazon-page-facts > div').first()).toHaveText(/^Source\s*Whole Foods \(in store\)$/);
  for (const n of [1, 3]) {
    await page.goto(`/#/everyday/amazon/orders/${ref(n)}`);
    await expect(page.locator('article.amazon-page h3')).toBeVisible();
    await expect(page.locator('.amazon-page-facts > div').first()).toHaveText(/^For\s*Unknown$/);
    await expect(page.locator('.amazon-page-facts')).not.toContainText('Source');
  }
});

test('an order partly linked and partly held needs review, and still opens what is linked; its page says which is which', async ({ page }) => {
  const mixed = { state: 'linked', evidenceClass: 'payment-event', cardTransactionId: `card-txn-${'5'.repeat(32)}`, cardAccountId: CARD_B.id };
  const details = { ...DETAILS, [ref(2)]: { ...DETAILS[ref(2)], matches: [...(DETAILS[ref(2)].matches as Json[]), mixed] } };
  await serveAmazon(page, { details, rows: Object.values(details).map(listRow) });
  await openAmazon(page);
  const status = orderCard(page, 2).locator('.amazon-order-status');
  await expect(status).toHaveAttribute('data-status', 'review');
  await expect(status).toHaveText(/^Card match needs review\s*Also linked:\s*Amex Sample Gold ··0002\s*Open transaction$/);
  await expect(status.getByRole('button', { name: 'Open card transaction, Amex Sample Gold ··0002' })).toBeVisible();
  await orderCard(page, 2).getByRole('link', { name: 'Amazon order of Oct 5, 2026' }).click();
  const charge = page.getByRole('region', { name: 'Card match' });
  await charge.getByRole('button', { name: /^Why\?/ }).click();
  await expect(charge.locator('.amazon-why-match')).toHaveText([
    /^Needs review:\s*more than one order or charge could match, so none is linked yet\s*\(2 candidate card charges\)$/,
    /^Linked:\s*Amex Sample Gold ··0002, tied by its Amazon payment$/,
  ]);
  // The review note speaks of the match that needs review, never of the order as unlinked.
  await expect(charge).toContainText('Until it is linked, no card transaction is filed under the order\'s items through it.');
});

test('wide screens lay the orders two to a row; narrower ones keep one column', async ({ page }) => {
  await serveAmazon(page);
  await openAmazon(page);
  const list = page.getByRole('list', { name: 'Amazon orders' });
  const columns = () => list.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  for (const [width, expected] of [[1280, 1], [1439, 1], [1440, 2], [1920, 2], [2560, 2]] as const) {
    await page.setViewportSize({ width, height: 900 });
    expect(await columns(), `${width}px`).toBe(expected);
    expect(await overflow(page), `${width}px`).toBeLessThanOrEqual(0);
  }
  // Two to a row, newest first along each row.
  const [first, second] = await Promise.all([orderCard(page, 1).boundingBox(), orderCard(page, 2).boundingBox()]);
  expect(Math.abs(first!.y - second!.y)).toBeLessThanOrEqual(1);
  expect(second!.x).toBeGreaterThan(first!.x + first!.width);
});

test.describe('narrow screen', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('the list and an order\'s page fit without sideways scrolling', async ({ page }) => {
    const long = `${KETTLE}, ${'Extra Long Synthetic Descriptor '.repeat(12)}Model K-100X`;
    const details = { ...DETAILS, [ref(1)]: { ...DETAILS[ref(1)], items: [{ ...(DETAILS[ref(1)].items as Json[])[0], title: long }] } };
    const spending = { ...SPENDING, '30D': spendingAnswer('30D', '2026-09-20', '2026-10-19',
      RECENT.map((item) => (item.ref === 'amz-line-1a' ? { ...item, title: long } : item)), RECENT_FACTS) };
    await serveAmazon(page, { details, rows: Object.values(details).map(listRow), spending });
    await openAmazon(page);
    await expect(orderCard(page, 1).locator('.amazon-item-title')).toHaveText(long);
    // Purchases first on a phone too: every order before the first screen of analysis.
    await expect(spendingPanel(page).locator('.amazon-spend-item')).toHaveCount(4);
    expect((await orderCard(page, 3).boundingBox())!.y).toBeLessThan((await spendingPanel(page).boundingBox())!.y);
    expect((await page.getByRole('heading', { name: 'Orders', exact: true }).boundingBox())!.y)
      .toBeLessThan((await orderCard(page, 1).boundingBox())!.y);
    // The item list keeps the whole name, clamped on screen, with its categories and the window switch beside it.
    await expect(spendingPanel(page).locator('.amazon-spend-item').first().locator('.amazon-item-title')).toHaveText(long);
    await expect(spendingPanel(page).locator('.amazon-spending-categories .spending-rank-row')).toHaveCount(3);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await orderCard(page, 3).getByRole('link', { name: 'Amazon order of Sep 28, 2026' }).click();
    await expect(page.locator('article.amazon-page h3')).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
});
