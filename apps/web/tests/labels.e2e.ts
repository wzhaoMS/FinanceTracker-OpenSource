import { expect, requireHealthyApi, test, type Locator, type Page } from './fixtures';

/**
 * Small labels and chips in both modes (UI plan P2-15), on the stack's synthetic household: sentence case, as the text
 * is written, and one chip shape, through the --label-* and --chip-* tokens in styles.css. Capitals come back
 * everywhere at once with the one token, should the owner want them, with their tracking and the chips' shape.
 */

const PAGES = ['#/investing/portfolio', '#/investing/gold', '#/investing/transactions', '#/investing/accounts', '#/everyday/transactions', '#/everyday/sync'];

/** Tickers of the stack's synthetic household, and acronyms: written in capitals on purpose. */
const CAPITALS_ALLOWED = ['AI', 'AH', 'ID', 'CSV', 'YTD', 'ETF', 'IRA', 'HSA', 'USD', 'TWR', 'SPY', 'QQQ', 'NBIS', 'NVDA', 'MSFT',
  'GOOGL', 'AMZN', 'SGOV', 'FBTC', 'TSLA', 'CEG', 'PLTR', 'AMD', 'FNILX', 'BTC'];
/** Labels and chips: headings, labels, captions and titles, and anything named a badge, pill, chip or tag. */
const LABELS_AND_CHIPS = 'th, label, h3, h4, [class*="label"], [class*="badge"], [class*="pill"], [class*="chip"], [class*="tag"], '
  + '[class*="caption"], [class*="heading"], [class*="title"], [class*="type"]';
/** The one token, and a tracking and a chip shape that cannot be mistaken for a default. */
const CAPITALS_AGAIN = ':root { --label-case: uppercase; --label-tracking: 2px; --chip-radius: 12px; }';

/** The elements whose own text the page draws in capitals. */
const capitals = (page: Page) => page.evaluate(() => [...document.querySelectorAll('body *')]
  .filter((node) => getComputedStyle(node).textTransform === 'uppercase'
    && [...node.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').trim()))
  .map((node) => `${node.tagName.toLowerCase()}.${[...node.classList].join('.')}`));

/** Labels and chips whose own text is written in capitals (a word of two letters or more), tickers and acronyms aside. */
const writtenInCapitals = (page: Page) => page.evaluate(({ selector, allowed }) => {
  const ok = new Set(allowed);
  const found = new Set<string>();
  for (const node of document.querySelectorAll(selector)) {
    const own = [...node.childNodes].filter((child) => child.nodeType === Node.TEXT_NODE).map((child) => child.textContent ?? '').join(' ');
    if (own.split(/[^A-Za-z0-9]+/).some((word) => word.length >= 2 && /^[A-Z]+$/.test(word) && !ok.has(word))) {
      found.add(`${node.tagName.toLowerCase()}.${[...node.classList].join('.')}: ${own.trim()}`);
    }
  }
  return [...found];
}, { selector: LABELS_AND_CHIPS, allowed: CAPITALS_ALLOWED });

async function open(page: Page, hash: string): Promise<void> {
  // A fresh load each time: moving between hashes stays in the page, and would keep what it read before.
  await page.goto('about:blank');
  await page.goto(`/${hash}`);
  await expect(page.locator('.app')).toBeVisible();
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
}

/** With the one token, labels and chips are drawn in capitals with the label tracking, and the chips take the chip shape. */
async function capitalsAgain(page: Page, labels: Locator[], chips: Locator[]): Promise<void> {
  await page.addStyleTag({ content: CAPITALS_AGAIN });
  for (const item of [...labels, ...chips]) {
    await expect(item).toHaveCSS('text-transform', 'uppercase');
    await expect(item).toHaveCSS('letter-spacing', '2px');
  }
  for (const chip of chips) await expect(chip).toHaveCSS('border-radius', '12px');
}

test.beforeEach(async ({ request }) => {
  await requireHealthyApi(request);
});

test('labels and chips read in sentence case in both modes, chips are one shape, and one token brings capitals back', async ({ page }) => {
  for (const hash of PAGES) {
    await open(page, hash);
    expect(await capitals(page), hash).toEqual([]);
    expect(await writtenInCapitals(page), hash).toEqual([]);
  }
  // Investing: the holdings' column heads and theme chips, the transactions' labels and owner chips.
  await open(page, '#/investing/portfolio');
  const head = page.locator('.holdings th').first();
  const badge = page.locator('.holding-badge.theme').first();
  await expect(head).toHaveCSS('text-transform', 'none');
  await expect(badge).toHaveText('AI compute');
  await expect(badge).toHaveCSS('border-radius', '999px');
  await open(page, '#/investing/transactions');
  const filters = page.locator('.tx-presets-label');
  const owner = page.locator('.tx-owner-pill').first();
  await expect(filters).toHaveText('Quick filters');
  await expect(filters).toHaveCSS('letter-spacing', 'normal');
  await expect(owner).toHaveCSS('border-radius', '999px');
  await capitalsAgain(page, [filters], [owner]);
  expect((await capitals(page)).length).toBeGreaterThan(0);
});

test('status, cash and overnight chips and Everyday\'s labels are written in sentence case and follow the one token too', async ({ page, request }) => {
  test.setTimeout(60_000);
  // A disposable synthetic account with two identical trades dated today (pending, likely duplicates), one then edited
  // here; a synthetic dividend in the cash ledger and overnight prices, both answered here (review of #214).
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const accountId = `e2e-labels-${suffix}`;
  const symbol = `LB${String(Date.now()).slice(-4)}`;
  // Today where the page runs (the browser keeps this machine's time zone): a trade dated today is pending.
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  try {
    await request.post('/accounts', { data: { id: accountId, name: `E2E Labels ${suffix}`, type: 'Test', cashBalance: 0, currency: 'USD' } })
      .then((response) => expect(response.status()).toBe(201));
    for (const copy of ['a', 'b']) {
      await request.post(`/accounts/${accountId}/transactions`, {
        data: { id: `e2e-labels-${copy}-${suffix}`, symbol, quantity: 3, pricePerUnit: 11, date: today, currency: 'USD' },
      }).then((response) => expect(response.status()).toBe(201));
    }
    await page.route('**/cash-events', (route) => (route.request().method() !== 'GET' ? route.continue() : route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ cashEvents: [{
        id: 'labels-dividend', accountId, date: today, eventType: 'dividend', amount: 1.23, currency: 'USD', broker: 'fidelity',
        accountLast4: '0000', description: 'SYNTHETIC DIVIDEND', sourceFingerprint: 'e'.repeat(64), importedAt: '2026-01-01T00:00:00.000Z',
      }] }),
    })));

    // Investing transactions: the status chips, then one row edited here.
    await open(page, '#/investing/transactions');
    await page.getByRole('searchbox', { name: 'Search transactions' }).fill(symbol);
    const rows = page.locator('.tx-row');
    await expect(rows).toHaveCount(2);
    const pending = rows.first().locator('.tx-status-badge.pending');
    await expect(pending).toHaveText('Pending');
    await expect(rows.first().locator('.tx-status-badge.dup')).toHaveText('Possible duplicate');
    await rows.first().locator('.tx-row-main').click();
    await rows.first().getByTitle('Edit quantity').click();
    await rows.first().getByLabel('Quantity').fill('4');
    await rows.first().getByLabel('Quantity').press('Enter');
    const edited = page.locator('.tx-status-badge.edited');
    await expect(edited).toHaveText('Edited');
    const ledger = page.getByRole('region', { name: 'Cash ledger' });
    await ledger.getByRole('button', { name: 'Cash ledger' }).click();
    const dividend = ledger.locator('.cash-event-type').first();
    await expect(dividend).toHaveText('Dividend');
    expect(await writtenInCapitals(page), 'transactions').toEqual([]);
    expect(await capitals(page), 'transactions').toEqual([]);
    await capitalsAgain(page, [page.locator('.tx-presets-label')], [pending, edited, dividend]);

    // Investing portfolio with overnight prices on: the household banner's label and the panel's chip.
    await page.route('**/quotes?**', async (route) => {
      const asOf = Date.now();
      const asked = (new URL(route.request().url()).searchParams.get('symbols') ?? '').split(',').map((name) => name.trim().toUpperCase()).filter(Boolean);
      const symbols = asked.length > 0 ? asked : CAPITALS_ALLOWED.slice(CAPITALS_ALLOWED.indexOf('SPY'));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ quotes: symbols.map((name) => ({
          symbol: name, price: 25, currency: 'USD', asOf, source: 'unknown', freshness: 'eod', session: 'closed',
          ...(name === 'NBIS' ? { indicative: { price: 50, source: 'hyperliquid-perp', asOf, baselineClose: 25, premiumPct: 1, confidence: 'ok' } } : {}),
        })) }),
      });
    });
    await open(page, '#/investing/portfolio');
    await page.getByRole('region', { name: 'Overnight prices' })
      .getByRole('switch', { name: 'Use overnight prices' }).click();
    const banner = page.locator('.indicative-banner-label');
    await expect(banner).toHaveText('Overnight estimates in use');
    expect(await writtenInCapitals(page), 'portfolio, overnight').toEqual([]);
    expect(await capitals(page), 'portfolio, overnight').toEqual([]);
    await capitalsAgain(page, [banner, page.locator('.holdings th').first()], [page.locator('.indicative-tag'), page.locator('.holding-badge.theme').first()]);

    // Everyday: a day heading as Everyday draws it (its own rule, under data-mode="everyday").
    // S1 removed the KPI label this probe also planted (.spending-card-label), and T2 removed its dead rules.
    await open(page, '#/everyday/transactions');
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend',
      '<div data-mode="everyday" data-probe="labels"><div class="spending-group"><h4>Today</h4></div></div>'));
    const day = page.locator('[data-probe="labels"] .spending-group h4');
    await expect(day).toHaveCSS('text-transform', 'none');
    await capitalsAgain(page, [day], []);
  } finally {
    const listed = await request.get(`/accounts/${encodeURIComponent(accountId)}/transactions`);
    if (listed.ok()) {
      for (const transaction of (await listed.json() as { transactions: Array<{ id: string }> }).transactions) {
        await request.delete(`/transactions/${encodeURIComponent(transaction.id)}`);
      }
    }
    await request.delete(`/accounts/${encodeURIComponent(accountId)}`);
  }
});
