import { readFile } from 'node:fs/promises';
import { expect, requireHealthyApi, test, type APIRequestContext, type Page } from './fixtures';
import { AT } from './marketClock';

const QUOTES = [
  ['NBIS', 216.20], ['NVDA', 202.78], ['GOOGL', 358.89], ['CEG', 250.74],
  ['FBTC', 54.96], ['MSFT', 384.36], ['TSLA', 406.55], ['VST', 157.98],
  ['PLTR', 129.04], ['SGOV', 100.48], ['AMZN', 247.04], ['QQQ', 723.28],
  ['TLRY', 4.39], ['CRWV', 89.70], ['SLB', 47.24], ['BE', 24.12],
  ['NBIS260918P00170000', 4.40], ['NBIS260731P00165000', 6.05],
] as const;

const QUOTE_BY_SYMBOL = new Map<string, number>(QUOTES.map(([symbol, price]) => [symbol, price]));

function requestedSymbols(rawUrl: string) {
  const url = new URL(rawUrl);
  const symbols = url.searchParams.get('symbols');
  if (!symbols) return QUOTES.map(([symbol]) => symbol);
  return symbols.split(',').map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
}

function quotePrice(symbol: string) {
  return QUOTE_BY_SYMBOL.get(symbol.toUpperCase()) ?? 25;
}

async function installQuotes(page: Page) {
  await page.route('**/quotes?**', async (route) => {
    const asOf = Date.now();
    const symbols = requestedSymbols(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        quotes: symbols.map((symbol) => {
          const price = quotePrice(symbol);
          return {
            symbol,
            price,
            currency: 'USD',
            asOf,
            source: 'unknown',
            freshness: 'live',
            session: 'regular',
            changeBasis: 'previousClose',
            baselinePrice: price - 1,
            dayChange: 1,
            dayChangePercent: (1 / (price - 1)) * 100,
          };
        }),
      }),
    });
  });
}

async function apiAccounts(request: APIRequestContext) {
  const response = await request.get('/accounts');
  expect(response.ok()).toBe(true);
  return (await response.json() as { accounts: Array<{ id: string; name: string; cashBalance: number }> }).accounts;
}

/** First account (API order) holding cash and an open position. Chosen from
 *  the stack's data so the suite does not depend on one household's names. */
async function heldAccountWithCash(request: APIRequestContext) {
  const accounts = await apiAccounts(request);
  const response = await request.get('/transactions');
  expect(response.ok()).toBe(true);
  const { transactions } = await response.json() as {
    transactions: Array<{ accountId: string; symbol: string; quantity: number; instrumentType?: string }>;
  };
  const account = accounts.find((candidate) => {
    if (candidate.cashBalance === 0) return false;
    const netQuantity = new Map<string, number>();
    for (const transaction of transactions) {
      if (transaction.accountId !== candidate.id || transaction.instrumentType === 'option') continue;
      netQuantity.set(transaction.symbol, (netQuantity.get(transaction.symbol) ?? 0) + transaction.quantity);
    }
    return [...netQuantity.values()].some((quantity) => quantity > 1e-9);
  });
  expect(account, 'an account holding cash and an open position').toBeDefined();
  return account!;
}

async function cleanupAccount(request: APIRequestContext, id: string) {
  const txResponse = await request.get(`/accounts/${encodeURIComponent(id)}/transactions`);
  if (txResponse.ok()) {
    const { transactions } = await txResponse.json() as { transactions: Array<{ id: string }> };
    for (const transaction of transactions) {
      await request.delete(`/transactions/${encodeURIComponent(transaction.id)}`);
    }
  }
  await request.delete(`/accounts/${encodeURIComponent(id)}`);
}

test.beforeEach(async ({ page, request }) => {
  // Every audit test needs the live API: an unreachable or unhealthy one fails the test, never skips it.
  await requireHealthyApi(request);
  await installQuotes(page);
  await page.goto('/');
});

/** Weekdays from `from` through `to` (YYYY-MM-DD): the API's business-day grid. */
function weekdaysThrough(from: string, to: string): number {
  let count = 0;
  for (const day = new Date(`${from}T00:00:00Z`); day <= new Date(`${to}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1)) {
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) count += 1;
  }
  return count;
}

test('Portfolio: every range renders and rapid switching settles on the last range', async ({ page, request }) => {
  test.setTimeout(120_000);
  const chart = page.locator('.breakdown > .portfolio-chart');
  const ranges = ['1D', '1W', '1M', '3M', 'YTD', '1Y', '5Y', 'ALL'];
  const historyByRange = new Map<string, {
    coverage: { complete: boolean; actualFrom: string | null; percent: number };
    reliability?: { unreliablePoints: number; latestReliableFrom: string | null };
  }>();

  for (const range of ranges) {
    const warm = await request.get(`/portfolio/history?range=${range}`, { timeout: 60_000 });
    expect(warm.ok(), `${range} history API`).toBe(true);
    const history = await warm.json() as {
      valueMethod: string | null;
      source: string;
      points: unknown[];
      coverage: { complete: boolean; actualFrom: string | null; percent: number; requestedTo: string };
      reliability?: { unreliablePoints: number; latestReliableFrom: string | null };
    };
    // The ledger needs two business days, so until the year has two, YTD
    // legitimately serves the first session's observed snapshots or, before
    // any session of the year, the labeled current-holdings backtest.
    const today = history.coverage.requestedTo;
    const shortYtd = range === 'YTD' && weekdaysThrough(`${today.slice(0, 4)}-01-01`, today) < 2;
    if (range === '1D') {
      // Computed from the holdings at the seeded intraday prices, like a broker's line. Only in a
      // session's first minutes, with a single tick so far, is it still that recorded snapshot.
      if (history.valueMethod === 'observed_snapshot') {
        expect(history.points.length, '1D before a second tick').toBeLessThan(2);
      } else {
        expect(history.valueMethod, '1D value method').toBe('holdings_at_market');
        expect(history.source).toBe('intraday_prices');
        expect(history.coverage.complete).toBe(true);
      }
    } else if (range === '1W') {
      // The last five sessions, each at that day's holdings and cash, at the seeded intraday prices.
      expect(history.valueMethod, `${range} value method`).toBe('holdings_at_market');
      expect(history.source).toBe('intraday_prices');
      expect(history.coverage.complete).toBe(true);
    } else if (shortYtd) {
      expect(['observed_snapshot', 'current_holdings_backtest'], `${range} value method on ${today}`)
        .toContain(history.valueMethod);
      expect(history.source).toBe(
        history.valueMethod === 'observed_snapshot' ? 'snapshots' : history.points.length > 0 ? 'reconstruction' : 'none',
      );
    } else {
      expect(history.valueMethod, `${range} value method`).toBe('ledger_estimate');
      expect(history.source).toBe('reconstruction');
      // Ledger ranges are one continuous estimate starting at documented history.
      expect(history.coverage.actualFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    historyByRange.set(range, history);
    const rangeButton = chart.getByRole('button', { name: range, exact: true });
    const selected = await rangeButton.getAttribute('aria-pressed') === 'true';
    const response = selected ? null : page.waitForResponse((result) => {
      const url = new URL(result.url());
      return url.pathname === '/portfolio/history' && url.searchParams.get('range') === range && result.status() === 200;
    }, { timeout: 30_000 });
    await rangeButton.click();
    if (response) await response;
    await expect(chart.getByRole('button', { name: range, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => chart.locator('.symbol-chart-loading').count(), { timeout: 30_000 }).toBe(0);
    await expect(chart).not.toContainText('server is offline');
    await expect(chart.locator('.symbol-chart-svg, .symbol-chart-empty').first()).toBeVisible();
  }

  await chart.getByRole('button', { name: '1M', exact: true }).click();
  await chart.getByRole('button', { name: 'YTD', exact: true }).click();
  await chart.getByRole('button', { name: '3M', exact: true }).click();
  await expect(chart.getByRole('button', { name: '3M', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => chart.locator('.symbol-chart-loading').count(), { timeout: 30_000 }).toBe(0);
  const threeMonthHistory = historyByRange.get('3M');
  expect(threeMonthHistory?.coverage.actualFrom).toBeTruthy();
  await expect(chart.locator('.portfolio-chart-change')).toContainText('Value change');
  await expect(chart.locator('.portfolio-chart-coverage')).toHaveCount(0);
});

test('Portfolio: overnight indicative panel expands and opt-in updates then restores totals', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/quotes?**', async (route) => {
    const asOf = Date.now();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        quotes: requestedSymbols(route.request().url()).map((symbol) => ({
          symbol,
          price: quotePrice(symbol),
          currency: 'USD',
          asOf,
          source: 'unknown',
          freshness: 'eod',
          session: 'closed',
          ...(symbol === 'NBIS' ? {
            indicative: {
              price: quotePrice(symbol) + 25,
              source: 'hyperliquid-perp',
              asOf,
              baselineClose: quotePrice(symbol),
              premiumPct: 25 / quotePrice(symbol),
              confidence: 'ok',
            },
          } : {}),
        })),
      }),
    });
  });
  await page.reload();

  const panel = page.getByRole('region', { name: 'Overnight prices' });
  await expect(panel).toBeVisible();
  const disclosure = panel.locator('.indicative-header > button').first();
  const toggle = panel.getByRole('switch', { name: 'Use overnight prices' });
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(panel.locator('.indicative-body')).toHaveCount(0);
  // Folded, the panel still says what these prices are.
  await expect(panel.locator('.indicative-header')).toContainText('Estimated · not official');

  await disclosure.click();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.locator('.indicative-body')).toContainText('NBIS');
  await expect(panel.locator('.indicative-body')).toContainText('not a valuation');

  const householdValue = page.locator('.breakdown > .portfolio-chart .portfolio-chart-value');
  const officialValue = await householdValue.textContent();
  expect(officialValue).not.toBe('—');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.breakdown > .portfolio-chart').getByRole('status')).toContainText('Overnight estimates in use');
  await expect.poll(() => householdValue.textContent()).not.toBe(officialValue);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(householdValue).toHaveText(officialValue ?? '');
});

test('Portfolio: cached quotes survive failure and manual refresh reprices without blanking', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  const householdValue = page.locator('.breakdown > .portfolio-chart .portfolio-chart-value');
  await expect(householdValue).not.toHaveText('—');
  await expect.poll(
    () => page.evaluate(() => localStorage.getItem('finance-tracker:quotes:v1')),
  ).not.toBeNull();
  const cachedValue = await householdValue.textContent();

  await page.route('**/quotes?**', (route) => route.fulfill({ status: 503, body: 'quotes unavailable' }));
  await page.reload();
  await expect(page.locator('.app > .error')).toHaveText('Server error — quotes unavailable');
  await expect(householdValue).toHaveText(cachedValue ?? '');

  await page.unroute('**/quotes?**');
  await page.route('**/quotes?**', async (route) => {
    const asOf = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const symbols = requestedSymbols(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        quotes: symbols.map((symbol) => ({
          symbol,
          price: 1,
          currency: 'USD',
          asOf,
          source: 'cnbc',
          freshness: 'stale',
          session: 'regular',
        })),
      }),
    });
  });
  await page.getByRole('button', { name: 'Refresh quotes' }).click();
  await expect(householdValue).toHaveText(cachedValue ?? '');

  await page.unroute('**/quotes?**');
  await page.route('**/quotes?**', async (route) => {
    const asOf = Date.now();
    const symbols = requestedSymbols(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        quotes: symbols.map((symbol) => {
          const price = quotePrice(symbol);
          return {
          symbol,
          price: price + 5,
          currency: 'USD',
          asOf,
          source: 'unknown',
          freshness: 'live',
          session: 'regular',
          changeBasis: 'previousClose',
          baselinePrice: price,
          dayChange: 5,
          dayChangePercent: (5 / price) * 100,
          };
        }),
      }),
    });
  });
  await page.getByRole('button', { name: 'Refresh quotes' }).click();
  await expect(householdValue).not.toHaveText('—');
  await expect(householdValue).not.toHaveText(cachedValue ?? '');
  await expect(page.locator('.app > .error')).toHaveCount(0);
});

test('Transactions: search, filters, grouping, keyboard shortcuts, and CSV export', async ({ page }) => {
  await page.getByRole('tab', { name: 'Transactions' }).click();
  const summary = page.locator('.tx-summary');
  await expect(summary).toContainText(/Showing \d+ of \d+ transactions/);

  const search = page.getByRole('searchbox', { name: 'Search transactions' });
  await page.keyboard.press('/');
  await expect(search).toBeFocused();
  await search.fill('NBIS');
  await expect(summary).toContainText(/Showing [1-9]\d* of \d+ transactions/);
  await expect(page.locator('.tx-row-title .symbol').first()).toContainText('NBIS');

  await page.getByRole('group', { name: 'Group by' }).getByRole('button', { name: 'Symbol' }).click();
  await expect(page.locator('.tx-group-label').first()).toContainText('NBIS');

  await search.fill('');
  await page.getByRole('group', { name: 'Action' }).getByRole('button', { name: 'Sells' }).click();
  await expect(page.getByRole('group', { name: 'Action' }).getByRole('button', { name: 'Sells' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.tx-row-amount').first()).toContainText('Sold');

  await page.keyboard.press('Escape');
  await expect(search).toHaveValue('');
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('Keyboard shortcuts');
    await dialog.accept();
  });
  await page.keyboard.press('?');

  await page.getByRole('button', { name: 'Clear', exact: false }).first().click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export CSV/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^holdr-transactions-\d{4}-\d{2}-\d{2}\.csv$/);
  const path = await download.path();
  expect(path).not.toBeNull();
  const csv = await readFile(path!, 'utf8');
  expect(csv.split(/\r?\n/, 1)[0]).toContain('date,symbol,action,quantity,price');
  expect(csv).toContain('NBIS');
});

test('Transactions: full filter, grouping, and preset matrix computes correct intersections', async ({ page, request }) => {
  const accountsResponse = await request.get('/accounts');
  const transactionsResponse = await request.get('/transactions');
  expect(accountsResponse.ok()).toBe(true);
  expect(transactionsResponse.ok()).toBe(true);
  const { accounts } = await accountsResponse.json() as { accounts: Array<{ id: string; name: string }> };
  const { transactions } = await transactionsResponse.json() as {
    transactions: Array<{ accountId: string; symbol: string; quantity: number; notes?: string }>;
  };
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const target = transactions.find((transaction) => {
    const account = accountById.get(transaction.accountId);
    return Boolean(account && transaction.notes && account.name.includes(' · '));
  });
  expect(target).toBeTruthy();
  const targetAccount = accountById.get(target!.accountId)!;
  const targetOwner = targetAccount.name.slice(0, targetAccount.name.indexOf(' · '));

  await page.getByRole('tab', { name: 'Transactions' }).click();
  const summary = page.locator('.tx-summary');
  const search = page.getByRole('searchbox', { name: 'Search transactions' });

  await search.fill(target!.symbol);
  await expect(summary).toContainText(/Showing [1-9]\d* of/);
  await search.fill(targetAccount.name);
  await expect(summary).toContainText(/Showing [1-9]\d* of/);
  await search.fill(target!.notes!);
  await expect(summary).toContainText(/Showing [1-9]\d* of/);
  await search.fill('');

  const action = page.getByRole('group', { name: 'Action' });
  for (const label of ['Buys', 'Sells', 'All']) {
    await action.getByRole('button', { name: label, exact: true }).click();
    await expect(action.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
  }

  const range = page.getByRole('group', { name: 'Range' });
  for (const label of ['Today', '7D', '30D', '90D', 'YTD', 'All']) {
    await range.getByRole('button', { name: label, exact: true }).click();
    await expect(range.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
  }

  const owner = page.getByRole('group', { name: 'Owner' });
  await owner.getByRole('button', { name: targetOwner, exact: true }).click();
  const accountsPicker = page.locator('.tx-account-picker');
  await accountsPicker.locator('summary').click();
  await accountsPicker.getByLabel(targetAccount.name, { exact: true }).check();
  await search.fill(target!.symbol);
  await action.getByRole('button', {
    name: target!.quantity > 0 ? 'Buys' : 'Sells',
    exact: true,
  }).click();
  const expectedIntersection = transactions.filter((transaction) => (
    transaction.accountId === target!.accountId
    && transaction.symbol.toLowerCase().includes(target!.symbol.toLowerCase())
    && (target!.quantity > 0 ? transaction.quantity > 0 : transaction.quantity < 0)
  )).length;
  await expect(summary).toContainText(`Showing ${expectedIntersection} of ${transactions.length} transactions`);
  await page.getByRole('button', { name: /Clear \(/ }).click();

  const grouping = page.getByRole('group', { name: 'Group by' });
  for (const label of ['Account', 'Owner', 'Symbol', 'Month']) {
    await grouping.getByRole('button', { name: label, exact: true }).click();
    await expect(grouping.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.tx-group-label').first()).toBeVisible();
  }
  await grouping.getByRole('button', { name: 'Date (newest)', exact: true }).click();
  await expect(grouping.getByRole('button', { name: 'Date (newest)', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('group', { name: 'Filter presets' }).getByRole('button', { name: 'Buys (7D)' }).click();
  await expect(action.getByRole('button', { name: 'Buys', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(range.getByRole('button', { name: '7D', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('group', { name: 'Filter presets' }).getByRole('button', { name: 'All sells' }).click();
  await expect(action.getByRole('button', { name: 'Sells', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('group', { name: 'Filter presets' }).getByRole('button', { name: 'Alex only' }).click();
  await expect(owner.getByRole('button', { name: 'Alex', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('group', { name: 'Filter presets' }).getByRole('button', { name: 'Casey only' }).click();
  await expect(owner.getByRole('button', { name: 'Casey', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('group', { name: 'Filter presets' }).getByRole('button', { name: "Today's trades" }).click();
  await expect(range.getByRole('button', { name: 'Today', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('Transactions: row expansion and bulk-selection cancel path', async ({ page }) => {
  await page.getByRole('tab', { name: 'Transactions' }).click();
  const firstRow = page.locator('.tx-row').first();
  await expect(firstRow).toBeVisible();
  const body = firstRow.locator('.tx-row-main');
  await body.click();
  await expect(body).toHaveAttribute('aria-expanded', 'true');
  await expect(firstRow.locator('.tx-row-drawer')).toBeVisible();

  await firstRow.getByRole('checkbox').check();
  const bulk = page.getByRole('region', { name: 'Bulk actions' });
  await expect(bulk).toContainText('1 selected');
  await bulk.getByRole('button', { name: 'Clear' }).click();
  await expect(bulk).toHaveCount(0);
});

test('Transactions: inline edit, duplicate focus, and disposable bulk delete', async ({ page, request }) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const accountId = `e2e-tx-account-${suffix}`;
  const inlineSymbol = `EI${suffix.replace(/[^A-Za-z0-9]/g, '').slice(-5).toUpperCase()}`;
  const duplicateSymbol = `ED${suffix.replace(/[^A-Za-z0-9]/g, '').slice(-5).toUpperCase()}`;
  const date = new Date().toISOString().slice(0, 10);
  const transactions = [
    { id: `e2e-inline-${suffix}`, symbol: inlineSymbol, quantity: 2, pricePerUnit: 10 },
    { id: `e2e-dup-a-${suffix}`, symbol: duplicateSymbol, quantity: 3, pricePerUnit: 11 },
    { id: `e2e-dup-b-${suffix}`, symbol: duplicateSymbol, quantity: 3, pricePerUnit: 11 },
  ];
  try {
    await request.post('/accounts', {
      data: { id: accountId, name: `E2E Transactions ${suffix}`, type: 'Test', cashBalance: 0, currency: 'USD' },
    }).then((response) => expect(response.status()).toBe(201));
    for (const transaction of transactions) {
      await request.post(`/accounts/${accountId}/transactions`, {
        data: { ...transaction, date, currency: 'USD' },
      }).then((response) => expect(response.status()).toBe(201));
    }

    await page.reload();
    await page.getByRole('tab', { name: 'Transactions' }).click();
    const search = page.getByRole('searchbox', { name: 'Search transactions' });
    await search.fill(inlineSymbol);
    const inlineRow = page.locator('.tx-row').filter({ hasText: inlineSymbol });
    await expect(inlineRow).toHaveCount(1);

    // Quantity and price are edited in the row's drawer; the summary shows neither.
    await expect(inlineRow.locator('.tx-row-main')).not.toContainText('@');
    await inlineRow.locator('.tx-row-main').click();
    await inlineRow.getByTitle('Edit quantity').click();
    const quantityInput = inlineRow.getByLabel('Quantity');
    await quantityInput.fill('0');
    await quantityInput.press('Enter');
    await expect(inlineRow.getByRole('alert')).toHaveText('Quantity must be a positive number');
    expect((await request.get(`/accounts/${accountId}/transactions`).then((r) => r.json()) as { transactions: Array<{ id: string; quantity: number }> }).transactions
      .find((transaction) => transaction.id === transactions[0].id)?.quantity).toBe(2);
    await quantityInput.press('Escape');

    await inlineRow.getByTitle('Edit quantity').click();
    await inlineRow.getByLabel('Quantity').fill('2.5');
    await inlineRow.getByLabel('Quantity').press('Enter');
    await expect.poll(async () => {
      const body = await request.get(`/accounts/${accountId}/transactions`).then((r) => r.json()) as { transactions: Array<{ id: string; quantity: number }> };
      return body.transactions.find((transaction) => transaction.id === transactions[0].id)?.quantity;
    }).toBe(2.5);
    await inlineRow.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(async () => {
      const body = await request.get(`/accounts/${accountId}/transactions`).then((r) => r.json()) as { transactions: Array<{ id: string; quantity: number }> };
      return body.transactions.find((transaction) => transaction.id === transactions[0].id)?.quantity;
    }).toBe(2);

    await search.fill(duplicateSymbol);
    await expect(page.locator('.tx-row')).toHaveCount(2);
    await expect(page.locator('.tx-status-badge.dup')).toHaveCount(2);
    const duplicateBanner = page.locator('.tx-dup-banner');
    await expect(duplicateBanner).toBeVisible();
    await duplicateBanner.getByRole('button', { name: 'Show duplicates' }).click();
    await expect(search).toHaveValue('');
    await expect.poll(async () => page.locator('.tx-row').count()).toBe(await page.locator('.tx-status-badge.dup').count());

    await search.fill(duplicateSymbol);
    const duplicateRows = page.locator('.tx-row');
    await duplicateRows.nth(0).getByRole('checkbox').check();
    await duplicateRows.nth(1).getByRole('checkbox').check();
    const bulk = page.getByRole('region', { name: 'Bulk actions' });
    await expect(bulk).toContainText('2 selected');

    page.once('dialog', (dialog) => dialog.dismiss());
    await bulk.getByRole('button', { name: 'Remove 2' }).click();
    await expect(page.locator('.tx-row')).toHaveCount(2);

    page.once('dialog', (dialog) => dialog.accept());
    await bulk.getByRole('button', { name: 'Remove 2' }).click();
    await expect.poll(async () => {
      const body = await request.get(`/accounts/${accountId}/transactions`).then((r) => r.json()) as { transactions: Array<{ symbol: string }> };
      return body.transactions.filter((transaction) => transaction.symbol === duplicateSymbol).length;
    }).toBe(0);
  } finally {
    await cleanupAccount(request, accountId);
  }
});

test('Add transaction: validation, disposable save, visibility, and cleanup', async ({ page, request }) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const accountId = `e2e-account-${suffix}`;
  const accountName = `E2E Disposable ${suffix}`;
  const symbol = `E2E${suffix.replace(/[^A-Za-z0-9]/g, '').slice(-6).toUpperCase()}`;
  try {
    const created = await request.post('/accounts', {
      data: { id: accountId, name: accountName, type: 'Individual', cashBalance: 0, currency: 'USD' },
    });
    expect(created.status()).toBe(201);
    await page.reload();
    await page.getByRole('tab', { name: 'Add' }).click();

    // The page says what it does, groups the trade and then its numbers, and its button says the outcome.
    const form = page.getByRole('form', { name: 'Add a transaction' });
    await expect(form.getByRole('heading', { level: 2 })).toHaveText('Add a transaction');
    await expect(form.locator('legend')).toHaveText(['Trade', 'Quantity and price']);
    await expect(form.getByLabel('Buy or sell')).toBeVisible();

    await page.getByRole('button', { name: 'Add transaction' }).click();
    await expect(page.locator('.form-error')).toHaveText('Symbol is required');
    // An error reads at 14px or more, at line-height 1.5.
    const errorType = await page.locator('.form-error').evaluate((node) => {
      const style = getComputedStyle(node);
      return { size: parseFloat(style.fontSize), leading: parseFloat(style.lineHeight) / parseFloat(style.fontSize) };
    });
    expect(errorType.size).toBeGreaterThanOrEqual(14);
    expect(errorType.leading).toBeGreaterThanOrEqual(1.49);

    await page.getByLabel('Account').selectOption(accountId);
    await page.getByLabel('Buy or sell').selectOption('buy');
    await page.getByLabel('Symbol').fill(symbol);
    await page.getByRole('button', { name: 'Add transaction' }).click();
    await expect(page.locator('.form-error')).toHaveText('Quantity must be a positive number');

    await page.getByLabel('Quantity').fill('1.25');
    await page.getByLabel('Price per unit (USD)').fill('-1');
    await page.getByRole('button', { name: 'Add transaction' }).click();
    await expect(page.locator('.form-error')).toHaveText('Price must be a non-negative number');

    await page.getByLabel('Price per unit (USD)').fill('10');
    await page.getByLabel('Fees (optional)').fill('-0.25');
    await page.getByRole('button', { name: 'Add transaction' }).click();
    await expect(page.locator('.form-error')).toHaveText('Fees must be a non-negative number');

    await page.getByLabel('Fees (optional)').fill('0.25');
    await page.getByLabel('Date').fill('');
    await page.getByRole('button', { name: 'Add transaction' }).click();
    await expect(page.locator('.form-error')).toHaveText('Date must be YYYY-MM-DD');

    await page.getByLabel('Date').fill(new Date().toISOString().slice(0, 10));
    await page.getByRole('button', { name: 'Add transaction' }).click();

    await expect.poll(async () => {
      const response = await request.get(`/accounts/${accountId}/transactions`);
      const body = await response.json() as { transactions: Array<{ symbol: string }> };
      return body.transactions.some((transaction) => transaction.symbol === symbol);
    }, { timeout: 10_000 }).toBe(true);

    await expect(page.getByRole('tab', { name: 'Transactions' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('searchbox', { name: 'Search transactions' }).fill(symbol);
    await expect(page.locator('.tx-row-title .symbol')).toHaveText(symbol);
  } finally {
    await cleanupAccount(request, accountId);
  }
});

test('Add and Import: empty accounts and quote/write failures degrade safely', async ({ page }) => {
  await page.evaluate(() => localStorage.removeItem('finance-tracker:state:v2'));
  await page.route('**/accounts', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ accounts: [] }),
  }));
  await page.route('**/transactions', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ transactions: [] }),
  }));
  await page.reload();

  await page.getByRole('tab', { name: 'Add' }).click();
  await page.getByRole('button', { name: 'Add transaction' }).click();
  await expect(page.locator('.form-error')).toHaveText('Pick an account');
  await page.getByRole('tab', { name: 'Import' }).click();
  await expect(page.getByRole('button', { name: 'Preview import' })).toBeDisabled();
  // With no account to import into, the page offers the step that is missing.
  await expect(page.getByRole('button', { name: 'Add account', exact: true })).toBeVisible();

  await page.unroute('**/accounts');
  await page.unroute('**/transactions');
  await page.reload();
  await page.getByRole('tab', { name: 'Add' }).click();
  await page.route('**/quotes?**', (route) => route.fulfill({ status: 503, body: 'quotes down' }));
  await page.route('**/accounts/*/transactions', (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({ status: 500, body: 'forced write failure' });
    }
    return route.continue();
  });
  const quoteFailure = page.waitForResponse(
    (response) => response.url().includes('/quotes?symbols=E2EFAIL') && response.status() === 503,
  );
  await page.getByLabel('Symbol').fill('E2EFAIL');
  await page.getByLabel('Quantity').fill('1');
  await page.getByLabel('Price per unit (USD)').fill('10');
  await quoteFailure;
  await expect(page.locator('.form-hint')).toHaveCount(0);
  await page.getByRole('button', { name: 'Add transaction' }).click();

  await expect(page.getByRole('tab', { name: 'Add' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.form-error')).toContainText('500 Internal Server Error');
  const toast = page.locator('.error-toast');
  await expect(toast).toContainText('forced write failure');
  await toast.getByRole('button', { name: 'Dismiss' }).click();
  await expect(toast).toHaveCount(0);
});

test('Import: the sample table previews two mapped rows without saving', async ({ page }) => {
  await page.getByRole('tab', { name: 'Import' }).click();
  // The page asks what to import first; the holdings table starts empty, so nothing can be previewed by accident.
  await expect(page.getByRole('group', { name: 'What do you want to import?' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Holdings or trades for an account' })).toBeChecked();
  await expect(page.getByRole('textbox', { name: 'Holdings table', exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Preview import' })).toBeDisabled();
  // The table's format and a sample are under Advanced.
  await page.getByRole('button', { name: /^Advanced/ }).click();
  await page.getByRole('button', { name: 'Use this sample' }).click();
  await page.getByRole('button', { name: 'Preview import' }).click();
  const preview = page.getByRole('region', { name: 'Import preview' });
  await expect(preview).toBeVisible({ timeout: 10_000 });
  await expect(preview).toContainText('2 transactions to import');
  await expect(preview).toContainText('AAPL');
  await expect(preview).toContainText('VTI');
  await expect(preview).toContainText('Nothing is saved until you choose Import.');
  await expect(preview.getByRole('button', { name: 'Import 2 transactions' })).toBeVisible();
});

test('Import: Fidelity, Citi, and Schwab-shaped tables map and explain rejected rows', async ({ page }) => {
  await page.getByRole('tab', { name: 'Import' }).click();
  const input = page.getByRole('textbox', { name: 'Holdings table', exact: true });
  const previewButton = page.getByRole('button', { name: 'Preview import' });
  const fixtures = [
    {
      symbol: 'AAPL',
      table: {
        headers: ['Symbol', 'Quantity', 'Last price', 'Average cost basis'],
        rows: [{ Symbol: 'AAPL', Quantity: '2', 'Last price': '$20', 'Average cost basis': '$10' }],
      },
    },
    {
      symbol: 'MSFT',
      table: {
        headers: ['Ticker', 'Shares', 'Price'],
        rows: [{ Ticker: 'MSFT', Shares: '3', Price: '$11' }],
      },
    },
    {
      symbol: 'VTI',
      table: {
        headers: ['Symbol', 'Qty', 'Current Price', 'Avg Cost'],
        rows: [{ Symbol: 'VTI', Qty: '4', 'Current Price': '$12', 'Avg Cost': '$9' }],
      },
    },
  ];

  for (const fixture of fixtures) {
    await input.fill(JSON.stringify(fixture.table));
    await previewButton.click();
    const preview = page.locator('.preview').last();
    await expect(preview).toContainText('1 transaction to import');
    await expect(preview).toContainText(fixture.symbol);
  }

  await input.fill(JSON.stringify({
    headers: ['Symbol', 'Quantity', 'Price'],
    rows: [
      { Symbol: 'VTI', Quantity: '1', Price: '$10' },
      { Symbol: 'CASH', Quantity: '100', Price: '$1' },
      { Symbol: 'AAPLAPPLEINC', Quantity: '1', Price: '$10' },
      { Symbol: 'TSLA', Quantity: '0', Price: '$10' },
      { Symbol: 'MSFT', Quantity: '1', Price: '' },
    ],
  }));
  await previewButton.click();
  const preview = page.locator('.preview').last();
  await expect(preview).toContainText('1 transaction to import');
  await expect(preview).toContainText('4 rejected rows');
  await expect(preview).toContainText('cash or non-symbol row');
  await expect(preview).toContainText('ambiguous ticker');
  await expect(preview).toContainText('quantity not parseable or zero');
  await expect(preview).toContainText('no average-cost or price column found');
});

test('Accounts: disposable create, edit, cash update, remove, and cleanup', async ({ page, request }) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const originalName = `E2E Account ${suffix}`;
  const renamed = `E2E Renamed ${suffix}`;
  let accountId: string | null = null;
  try {
    const held = await heldAccountWithCash(request);
    await page.getByRole('tab', { name: 'Accounts' }).click();
    // Manual prices are named once: the panel's own heading, which names its region.
    await expect(page.getByRole('heading', { name: 'Manual prices', exact: true })).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Manual prices', exact: true })).toBeVisible();
    const heldAccount = page.locator('.accounts-card').filter({ hasText: held.name }).first();
    await expect(heldAccount.locator('.accounts-card-cash-label')).toHaveText('Value');
    await expect(heldAccount.locator('.accounts-card-cash-secondary').first()).toContainText('cash');

    await page.getByRole('button', { name: 'New account' }).click();
    await page.getByLabel('Account name').fill(originalName);
    await page.getByLabel('Type').fill('Test');
    await page.getByLabel('Account #').fill('9999');
    await page.getByLabel('Starting cash').fill('12.34');
    await page.getByRole('button', { name: 'Add account' }).click();

    await expect.poll(async () => {
      const match = (await apiAccounts(request)).find((account) => account.name === originalName);
      accountId = match?.id ?? null;
      return Boolean(match);
    }, { timeout: 10_000 }).toBe(true);

    const card = page.locator('.accounts-card').filter({ hasText: originalName });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Account actions' }).click();
    await card.getByRole('menuitem', { name: 'Edit account' }).click();
    await card.getByLabel('Name').fill(renamed);
    await card.getByLabel('Name').press('Tab');

    await expect.poll(async () => {
      const match = (await apiAccounts(request)).find((account) => account.id === accountId);
      return match?.name ?? '';
    }, { timeout: 10_000 }).toBe(renamed);

    const renamedCard = page.locator('.accounts-card').filter({ hasText: renamed });
    await renamedCard.getByLabel('Cash').fill('42.50');
    await renamedCard.getByLabel('Cash').press('Tab');
    await expect.poll(async () => {
      const match = (await apiAccounts(request)).find((account) => account.id === accountId);
      return match?.cashBalance;
    }, { timeout: 10_000 }).toBe(42.5);

    page.once('dialog', (dialog) => dialog.dismiss());
    await renamedCard.getByRole('button', { name: 'Account actions' }).click();
    await renamedCard.getByRole('menuitem', { name: 'Remove account' }).click();
    await expect.poll(async () => (await apiAccounts(request)).some((account) => account.id === accountId)).toBe(true);
    await expect(renamedCard).toBeVisible();

    page.once('dialog', (dialog) => dialog.accept());
    await renamedCard.getByRole('button', { name: 'Account actions' }).click();
    await renamedCard.getByRole('menuitem', { name: 'Remove account' }).click();
    await expect.poll(async () => (await apiAccounts(request)).some((account) => account.id === accountId), { timeout: 10_000 }).toBe(false);
    accountId = null;
  } finally {
    if (accountId) await cleanupAccount(request, accountId);
  }
});

test('Resilience: corrupt local caches do not crash startup', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('finance-tracker:state:v2', '{broken');
    localStorage.setItem('finance-tracker:quotes:v1', '{broken');
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Holdr' })).toBeVisible();
  await expect(page.locator('.account.combined .account-name')).toContainText('Invested holdings');
  await expect(page.locator('.portfolio-chart-value')).not.toHaveText('—');
});

test('Resilience: offline cache preserves reads and disables write controls', async ({ page }) => {
  await expect.poll(
    () => page.evaluate(() => localStorage.getItem('finance-tracker:state:v2')),
  ).not.toBeNull();

  await page.route('**/accounts', (route) => route.fulfill({ status: 503, body: 'offline' }));
  await page.route('**/transactions', (route) => route.fulfill({ status: 503, body: 'offline' }));
  await page.route('**/quotes?**', (route) => route.fulfill({ status: 503, body: 'offline' }));
  await page.reload();

  await expect(page.getByRole('alert').filter({ hasText: 'Server unreachable' })).toBeVisible();
  await expect(page.locator('.account.combined .account-name')).toContainText('Invested holdings');
  await expect(page.getByRole('button', { name: 'Refresh quotes' })).toBeDisabled();

  await page.getByRole('tab', { name: 'Add' }).click();
  await expect(page.getByRole('button', { name: 'Add transaction' })).toBeDisabled();

  await page.getByRole('tab', { name: 'Import' }).click();
  await expect(page.getByRole('button', { name: 'Preview import' })).toBeDisabled();

  await page.getByRole('tab', { name: 'Accounts' }).click();
  await expect(page.getByRole('button', { name: 'New account' })).toBeDisabled();

  await page.getByRole('tab', { name: 'Transactions' }).click();
  await expect(page.locator('.tx-row').first().getByRole('checkbox')).toBeDisabled();
});

test('Accessibility and diagnostics: clean runtime, keyboard reachability, and responsive screenshots', async ({ page, request }, testInfo) => {
  test.setTimeout(90_000);
  await page.waitForLoadState('networkidle');
  const localHostname = new URL(page.url()).hostname;
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const badResponses: string[] = [];
  const isLocalStackUrl = (raw: string) => {
    const url = new URL(raw);
    return url.hostname === localHostname;
  };
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    if (isLocalStackUrl(request.url())) {
      failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`);
    }
  });
  page.on('response', (response) => {
    if (isLocalStackUrl(response.url()) && response.status() >= 400) {
      badResponses.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });

  await page.reload();
  await expect(page.locator('.account.combined .account-name')).toContainText('Invested holdings');
  const chart = page.locator('.breakdown > .portfolio-chart');
  const warm = await request.get('/portfolio/history?range=ALL', { timeout: 60_000 });
  expect(warm.ok()).toBe(true);
  await chart.getByRole('button', { name: 'ALL', exact: true }).click();
  await expect(chart.locator('.trade-marker-badge').first()).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Refresh quotes' }).focus();
  await page.keyboard.press('Tab');
  // The header's last control is Sign out (the user's name next to it is plain text).
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeFocused();
  await page.keyboard.press('Tab');
  for (const tabName of ['Portfolio', 'Gold', 'Transactions', 'Spending', 'Add', 'Import', 'Accounts']) {
    await expect(page.getByRole('tab', { name: tabName })).toBeFocused();
    if (tabName !== 'Accounts') await page.keyboard.press('Tab');
  }

  await chart.getByRole('button', { name: '1D', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(chart.getByRole('button', { name: '1W', exact: true })).toBeFocused();
  await chart.getByRole('button', { name: 'ALL', exact: true }).click();
  const svg = chart.locator('.symbol-chart-svg');
  await svg.focus();
  await page.keyboard.press('Tab');
  const firstMarker = chart.locator('.trade-marker-badge').first();
  await expect(firstMarker).toBeFocused();
  await expect(firstMarker).toHaveAttribute('aria-label', /Buy|Sell|trades/);
  await expect(firstMarker).toHaveAttribute('aria-expanded', 'false');

  await page.getByRole('tab', { name: 'Add' }).click();
  await page.getByRole('tab', { name: 'Accounts' }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Account')).toBeFocused();
  for (const tabName of ['Transactions', 'Import', 'Accounts', 'Portfolio']) {
    await page.getByRole('tab', { name: tabName }).click();
    await expect(page.getByRole('tab', { name: tabName })).toHaveAttribute('aria-selected', 'true');
  }

  await chart.getByRole('button', { name: 'ALL', exact: true }).click();
  const desktopMarkers = chart.locator('.trade-marker-badge');
  await expect(desktopMarkers.first()).toBeVisible({ timeout: 30_000 });
  const desktopCounts = await desktopMarkers.evaluateAll((nodes) => nodes.map(
    (node) => Number((node as HTMLElement).dataset.tradeCount ?? '0'),
  ));
  const desktopMarker = desktopMarkers.nth(desktopCounts.indexOf(Math.max(...desktopCounts)));
  await desktopMarker.click();
  await expect(page.getByRole('dialog', { name: 'Trade details' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  const desktopScreenshot = testInfo.outputPath('desktop-portfolio-trade-details.png');
  await page.screenshot({ path: desktopScreenshot });
  await testInfo.attach('desktop-portfolio-trade-details', {
    path: desktopScreenshot,
    contentType: 'image/png',
  });
  await desktopMarker.press('Escape');

  await page.setViewportSize({ width: 390, height: 844 });
  for (const tabName of ['Portfolio', 'Gold', 'Transactions', 'Spending', 'Add', 'Import', 'Accounts']) {
    await expect(page.getByRole('tab', { name: tabName })).toBeVisible();
  }
  await expect(chart.locator('.trade-marker-badge').first()).toBeHidden();
  // On a phone a holding's chart is one of its Details.
  await page.getByRole('button', { name: 'NBIS details', exact: true }).click();
  await page.getByRole('button', { name: 'Show NBIS price chart', exact: true }).click();
  const mobileChart = page.locator('.symbol-chart').first();
  await expect(mobileChart.locator('.symbol-chart-line')).toBeVisible();
  const mobileMarkers = mobileChart.locator('.trade-marker-badge');
  await expect(mobileMarkers.first()).toBeVisible({ timeout: 30_000 });
  const mobileCounts = await mobileMarkers.evaluateAll((nodes) => nodes.map(
    (node) => Number((node as HTMLElement).dataset.tradeCount ?? '0'),
  ));
  const mobileMarker = mobileMarkers.nth(mobileCounts.indexOf(Math.max(...mobileCounts)));
  await mobileMarker.click();
  await expect(page.getByRole('dialog', { name: 'Trade details' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  const mobileScreenshot = testInfo.outputPath('mobile-portfolio-trade-details.png');
  await page.screenshot({ path: mobileScreenshot });
  await testInfo.attach('mobile-portfolio-trade-details', {
    path: mobileScreenshot,
    contentType: 'image/png',
  });
  await mobileMarker.press('Escape');
  const mobileFullPageScreenshot = testInfo.outputPath('mobile-portfolio-full-page.png');
  await page.screenshot({ path: mobileFullPageScreenshot, fullPage: true });
  await testInfo.attach('mobile-portfolio-full-page', {
    path: mobileFullPageScreenshot,
    contentType: 'image/png',
  });

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(badResponses).toEqual([]);
});

test('Performance: ALL history API and warmed render stay within release budget', async ({ page, request }, testInfo) => {
  test.setTimeout(90_000);
  const apiUrl = new URL('/portfolio/history?range=ALL', page.url());
  const apiStarted = performance.now();
  const response = await request.get(apiUrl.toString(), { timeout: 60_000 });
  const apiMs = performance.now() - apiStarted;
  expect(response.ok()).toBe(true);
  const body = await response.json() as { points: unknown[] };
  expect(body.points.length).toBeGreaterThan(1);
  expect(apiMs).toBeLessThan(30_000);

  const chart = page.locator('.breakdown > .portfolio-chart');
  const renderStarted = performance.now();
  const renderedHistory = page.waitForResponse((result) => {
    const url = new URL(result.url());
    return url.pathname === '/portfolio/history' && url.searchParams.get('range') === 'ALL' && result.status() === 200;
  }, { timeout: 30_000 });
  await chart.getByRole('button', { name: 'ALL', exact: true }).click();
  await renderedHistory;
  await expect.poll(async () => chart.locator('.symbol-chart-loading').count(), { timeout: 30_000 }).toBe(0);
  await expect(chart.locator('.symbol-chart-svg, .symbol-chart-empty').first()).toBeVisible();
  const renderMs = performance.now() - renderStarted;
  expect(renderMs).toBeLessThan(10_000);
  testInfo.annotations.push({
    type: 'performance',
    description: `ALL API ${apiMs.toFixed(0)}ms; warmed UI render ${renderMs.toFixed(0)}ms`,
  });
  console.log(`[performance] ALL API ${apiMs.toFixed(0)}ms; warmed UI render ${renderMs.toFixed(0)}ms`);
});

test('Mobile: trade popover stays inside viewport and is rendered via portal', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const warm = await request.get('/symbols/NBIS/history?range=3M', { timeout: 60_000 });
  expect(warm.ok()).toBe(true);
  await page.getByRole('button', { name: 'NBIS details', exact: true }).click();
  await page.getByRole('button', { name: 'Show NBIS price chart', exact: true }).click();
  const chart = page.locator('.symbol-chart').first();
  await expect(chart.locator('.symbol-chart-line')).toBeVisible();
  const markers = chart.locator('.trade-marker-badge');
  await expect(markers.first()).toBeVisible({ timeout: 30_000 });
  const markerBoxes = await markers.evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
  }));
  const collisions: Array<[number, number]> = [];
  for (let leftIndex = 0; leftIndex < markerBoxes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < markerBoxes.length; rightIndex += 1) {
      const left = markerBoxes[leftIndex];
      const right = markerBoxes[rightIndex];
      if (
        Math.min(left.right, right.right) > Math.max(left.left, right.left)
        && Math.min(left.bottom, right.bottom) > Math.max(left.top, right.top)
      ) {
        collisions.push([leftIndex, rightIndex]);
      }
    }
  }
  expect(collisions).toEqual([]);
  const counts = await markers.evaluateAll((nodes) => nodes.map((node) => Number((node as HTMLElement).dataset.tradeCount ?? '0')));
  const marker = markers.nth(counts.indexOf(Math.max(...counts)));
  await marker.click();
  const dialog = page.getByRole('dialog', { name: 'Trade details' });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => element.parentElement === document.body)).toBe(true);
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y + box!.height).toBeLessThanOrEqual(844);
});

/**
 * Journey 8 (readability round, I1): every price on the Portfolio page says what it is, in words, without a hover,
 * and nothing unknown reads as a measured zero. Synthetic quotes over the stack's synthetic household: fresh prices
 * with a day change, NVDA stale (a week old) and GOOGL missing; then markets closed, with overnight estimates for
 * NBIS and FBTC turned on. The page's own text keeps the D1 floors at 375 and 1920px.
 */
test.describe('Journey 8: fresh, stale, missing and overnight prices', () => {
  /**
   * Each scenario runs on its own pinned clock, and every time it serves comes from that clock, never the test runner's,
   * so it reads the same whenever it runs. Markets open at noon on a weekday: fresh quotes taken now, NVDA's a week ago.
   * Markets closed at noon on a Saturday: the close's quotes six hours old (official end-of-day prices), the overnight
   * estimates twenty minutes old.
   */
  const OPEN_AT = Date.parse(AT.regular);
  const CLOSED_AT = Date.parse(AT.closed);
  const STALE_AS_OF = OPEN_AT - 7 * 24 * 60 * 60 * 1000;
  const OVERNIGHT_AS_OF = CLOSED_AT - 20 * 60 * 1000;

  async function routePriceStates(page: Page, scenario: 'open' | 'closed') {
    const now = scenario === 'open' ? OPEN_AT : CLOSED_AT;
    await page.clock.setFixedTime(now);
    await page.route('**/quotes?**', async (route) => {
      const quotes = requestedSymbols(route.request().url())
        .filter((symbol) => !(scenario === 'open' && symbol === 'GOOGL'))
        .map((symbol) => {
          const price = quotePrice(symbol);
          if (scenario === 'open') {
            const stale = symbol === 'NVDA';
            return {
              symbol, price, currency: 'USD', asOf: stale ? STALE_AS_OF : now, source: 'nasdaq',
              freshness: stale ? 'stale' : 'live', session: 'regular',
              ...(stale ? {} : { changeBasis: 'previousClose', baselinePrice: price - 1, dayChange: 1, dayChangePercent: (1 / (price - 1)) * 100 }),
            };
          }
          const estimated = symbol === 'NBIS' || symbol === 'FBTC';
          return {
            symbol, price, currency: 'USD', asOf: now - 6 * 60 * 60 * 1000, source: 'nasdaq', freshness: 'eod', session: 'closed',
            changeBasis: 'previousClose', baselinePrice: price - 1, dayChange: 1, dayChangePercent: (1 / (price - 1)) * 100,
            ...(estimated ? { indicative: {
              price: Number((price * 1.04).toFixed(2)), source: symbol === 'FBTC' ? 'btc-proxy' : 'hyperliquid-perp', asOf: OVERNIGHT_AS_OF,
              baselineClose: price, premiumPct: 0.04, confidence: symbol === 'FBTC' ? 'thin' : 'ok',
            } } : {}),
          };
        });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ quotes, fallbackSymbols: [], missingSymbols: [] }) });
    });
    // The page keeps the newest quote it holds for a symbol, and until it unloads it may still cache the quotes it was
    // first served (stamped by the real clock, so newer than these): the cache goes as the page reloads, before the app
    // reads it.
    await page.addInitScript(() => localStorage.removeItem('finance-tracker:quotes:v1'));
    await page.reload();
  }

  /** How the page writes a price's time, in the browser's own locale and zone. */
  const priceTime = (page: Page, ms: number) => page.evaluate((at) => new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(at)), ms);

  const holdingRow = (page: Page, symbol: string) => page.locator('.account.combined tr.holding-row')
    .filter({ has: page.getByRole('button', { name: `${symbol} details`, exact: true }) });

  /** The header's quote badge, whatever its kind. */
  const quoteBadge = (page: Page) => page.locator(['live', 'pre', 'after', 'eod', 'stale', 'delayed', 'synthetic']
    .map((kind) => `.quote-status.quote-${kind}`).join(', ')).first();

  /**
   * Visible text in the page's own parts below its D1 floor: row names and reading text (the overnight panel's
   * explanation and table) 16px; the themed holding badges, and on wider screens the dense tables' column heads (T1's
   * lists), 13px; everything else, status and warnings included, 14px. The chart itself is T1's (its readability
   * sweep); the lines this page puts under the value are checked here.
   */
  const belowTypeFloor = (page: Page) => page.evaluate(() => {
    const wide = window.innerWidth >= 1280;
    const found: string[] = [];
    for (const node of document.querySelectorAll('.breakdown *')) {
      if (node.closest('svg, .visually-hidden')) continue;
      if (node.closest('.portfolio-chart') && !node.closest('.portfolio-chart-extra')) continue;
      if (![...node.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').trim())) continue;
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      if (box.width === 0 || box.height === 0 || style.visibility === 'hidden') continue;
      const reading = node.matches('.holding-symbol')
        || (node.matches('td.sym') && !node.closest('tfoot, .contributor-row'))
        || node.matches('.contributor-name')
        || (node.closest('.performance-table tbody th') !== null && !node.closest('.performance-sub, .performance-tag'))
        || node.closest('.indicative-explainer') !== null
        || (node.closest('.indicative-table tbody') !== null && !node.closest('.indicative-sub'));
      const small = node.matches('.holding-badge.theme, .holding-badge.alt, .holding-badge.risk, .holding-badge.neutral')
        || (wide && node.closest('.holdings th, .performance-table thead th') !== null);
      const floor = reading ? 16 : small ? 13 : 14;
      const size = parseFloat(style.fontSize);
      if (size < floor) found.push(`${node.tagName.toLowerCase()}.${[...node.classList].join('.')} "${(node.textContent ?? '').trim().slice(0, 30)}" ${size}px < ${floor}px`);
    }
    return found;
  });

  /** Running text that can wrap (notes, help, status, descriptions, reading text) set tighter than line-height 1.5. */
  const tightRunningText = (page: Page) => page.evaluate(() => {
    const running = [
      '.portfolio-value-meta', '.portfolio-overnight-text', '.holdings-overnight-note', '.holdings-total-note', '.account-total-note',
      '.account-meta', '.holding-price-note', '.day-change-note', '.holdings-phone-hint', '.holding-details dt', '.contributor-quantity',
      '.contributor-name',
      '.ai-thesis-unavailable', '.indicative-count', '.indicative-effect', '.indicative-explainer', '.indicative-sub', '.indicative-table td',
      '.performance-status', '.performance-heading p', '.performance-sub', '.performance-footnote', '.performance-goal-note',
      '.performance-goal-empty p', '.performance-goal-stat small', '.performance-notes li',
    ].map((selector) => `.breakdown ${selector}`).join(', ');
    return [...document.querySelectorAll(running)]
      .filter((node) => node.getBoundingClientRect().width > 0)
      .map((node) => ({ node, style: getComputedStyle(node) }))
      .filter(({ style }) => style.lineHeight === 'normal' || parseFloat(style.lineHeight) < 1.5 * parseFloat(style.fontSize) - 0.5)
      .map(({ node, style }) => `${node.tagName.toLowerCase()}.${[...node.classList].join('.')}: ${style.lineHeight} at ${style.fontSize}`);
  });

  /** Caveats left to a hover (a title) on the page's own parts, outside the chart. */
  const hoverOnlyCaveats = (page: Page) => page.locator('.breakdown > :not(.portfolio-chart) [title]').evaluateAll((nodes) => nodes
    .map((node) => node.getAttribute('title') ?? '')
    .filter((title) => /official|overnight|indicative|stale|unavailable|no quote|approximate|after-hours|pre-market|24-hour|partial/i.test(title)));

  for (const width of [375, 1920] as const) {
    test(`at ${width}px a stale price is dated, a missing one says so, and nothing unknown reads as zero`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await routePriceStates(page, 'open');
      const chart = page.locator('.breakdown > .portfolio-chart');
      await expect(chart.locator('.portfolio-chart-value')).toHaveText('—');
      // The synthetic quotes have landed (MSFT at its synthetic price).
      await expect(page.locator('.account.combined tbody tr').filter({ hasText: 'MSFT' }).first()).toContainText('$384.36');

      // No visible cell reads as a zero: the share of an unknown total read 0.00% on every row.
      const zeros = await page.locator('.breakdown td').evaluateAll((cells) => cells
        .filter((cell) => cell.getBoundingClientRect().width > 0)
        .map((cell) => (cell as HTMLElement).innerText.trim())
        .filter((text) => /^(\$0\.00|0\.00%|0%)$/.test(text)));
      expect(zeros).toEqual([]);
      // The totals are withheld with the reason, never summed without the missing holding.
      await expect(chart).toContainText('Price unavailable for 1 holding');
      await expect(page.locator('.account.combined .account-totals')).toContainText('Price unavailable for 1 holding');
      await expect(page.locator('.ai-thesis-panel')).toContainText('Allocation unavailable: price unavailable for 1 holding.');

      const missing = holdingRow(page, 'GOOGL');
      const stale = holdingRow(page, 'NVDA');
      // Missing: said in words under the symbol; its value a dash, never a figure.
      await expect(missing.locator('.holding-price-note')).toHaveText('Price unavailable');
      await expect(missing.locator('.holding-price-note')).toBeVisible();
      await expect(missing.locator('td.col-value')).toHaveText('—');
      // Stale: still used, and dated.
      await expect(stale.locator('.holding-price-note')).toHaveText(`Stale price · ${await priceTime(page, STALE_AS_OF)}`);
      await expect(stale.locator('.holding-price-note')).toBeVisible();
      await expect(stale.locator('td.col-value')).toHaveText(/^\$[1-9][\d,]*\.\d{2}$/);
      // Fresh: nothing to add.
      await expect(holdingRow(page, 'MSFT').locator('.holding-price-note')).toHaveCount(0);
      // Every row's share is a dash while the total is unknown.
      const shares = await page.locator('.account.combined tr.holding-row td.col-pct').allTextContents();
      expect(shares.length).toBeGreaterThan(5);
      expect(shares.map((text) => text.trim())).toEqual(shares.map(() => '—'));
      // An account holding it withholds its value the same way, and its row says why.
      const account = page.locator('.breakdown > .account:not(.combined)').filter({ has: page.locator('td.sym', { hasText: /^GOOGL/ }) }).first();
      await expect(account.locator('.account-totals')).toContainText('Price unavailable for 1 holding');
      await expect(account.locator('tbody tr').filter({ has: page.locator('td.sym', { hasText: /^GOOGL/ }) }).locator('.holding-price-note')).toHaveText('Price unavailable');

      expect(await hoverOnlyCaveats(page)).toEqual([]);
      // Row names read at 16px (review of #246): an open holding's accounts, and Performance's periods and years once
      // loaded. Both are on the page for the floor checks below.
      await holdingRow(page, 'MSFT').getByRole('button', { name: 'MSFT details', exact: true }).click();
      const contributorNames = page.locator('.account.combined tr.contributor-row .contributor-name');
      await expect(contributorNames.first()).toBeVisible();
      const performance = page.locator('.breakdown > .performance-card');
      await performance.scrollIntoViewIfNeeded();
      await expect(performance.locator('.performance-periods tbody th').first()).toBeVisible({ timeout: 30_000 });
      await expect(performance.locator('.performance-years tbody th').first()).toBeVisible();
      const rowNames = [
        ...await contributorNames.evaluateAll((nodes) => nodes.map((node) => parseFloat(getComputedStyle(node).fontSize))),
        ...await performance.locator('.performance-table tbody th').evaluateAll((nodes) => nodes.map((node) => parseFloat(getComputedStyle(node).fontSize))),
      ];
      expect(rowNames.length).toBeGreaterThan(4);
      expect(Math.min(...rowNames)).toBeGreaterThanOrEqual(16);
      expect(await belowTypeFloor(page)).toEqual([]);
      expect(await tightRunningText(page)).toEqual([]);
      expect(await page.locator('.portfolio-value-meta').evaluate((node) => parseFloat(getComputedStyle(node).fontSize)))
        .toBeGreaterThanOrEqual(14);
    });
  }

  test('overnight estimates are named and dated on every row they price, and the value says it includes them', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1000 });
    await routePriceStates(page, 'closed');
    // An official close: every quote is the close's, so the badge reads "Closed" and no price reads stale.
    await expect(quoteBadge(page)).toHaveText('Closed');
    await expect(page.locator('.holding-price-note.stale')).toHaveCount(0);
    const panel = page.getByRole('region', { name: 'Overnight prices' });
    const toggle = panel.getByRole('switch', { name: 'Use overnight prices' });
    // Folded and off, the panel still says what these prices are and what its switch changes; nothing on the page is
    // priced off them.
    await expect(panel.locator('.indicative-header')).toContainText('Estimated · not official');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(panel.locator('.indicative-effect')).toHaveText('Off: your holdings and portfolio value use official prices only.');
    await expect(panel.locator('.indicative-effect')).toBeVisible();
    await expect(page.locator('.holding-price-note.overnight')).toHaveCount(0);

    await toggle.click();
    await expect(panel.locator('.indicative-effect')).toHaveText('On: your holdings and portfolio value include these estimates.');
    const chart = page.locator('.breakdown > .portfolio-chart');
    const status = chart.getByRole('status');
    await expect(chart.locator('.portfolio-chart-title')).toHaveText('Portfolio value · includes overnight estimates');
    await expect(status).toContainText('Overnight estimates in use');
    await expect(status).toContainText('2 of 11 holdings use estimated overnight prices: not official, not a valuation.');
    await expect(page.locator('.holdings-overnight-note')).toContainText('2 holdings use estimated overnight prices, not official.');
    const note = `Estimated price · overnight, not official · ${await priceTime(page, OVERNIGHT_AS_OF)}`;
    for (const symbol of ['NBIS', 'FBTC']) {
      await expect(holdingRow(page, symbol).locator('.holding-price-note')).toHaveText(note);
      // Every account that holds it says so too.
      const rows = page.locator('.breakdown > .account:not(.combined) tbody tr').filter({ has: page.locator('td.sym', { hasText: new RegExp(`^${symbol}`) }) });
      expect(await rows.count()).toBeGreaterThan(0);
      for (const row of await rows.all()) await expect(row.locator('.holding-price-note')).toHaveText(note);
    }
    await expect(holdingRow(page, 'MSFT').locator('.holding-price-note')).toHaveCount(0);
    // The panel opened: the confidence note is text, not a tooltip; the explanation and table read at 16px, the column
    // heads and the notes under a price at 14px (the sweep below checks the same at both widths).
    await panel.locator('.indicative-header > button').first().click();
    const body = panel.locator('.indicative-body');
    await expect(body.locator('tbody tr').filter({ hasText: 'FBTC' }).locator('.indicative-sub')).toContainText(['Thin trading']);
    const bodyFloors = async (where: string) => {
      const seen = await body.evaluate((root) => {
        const sizes = (selector: string) => [...root.querySelectorAll(selector)].map((node) => parseFloat(getComputedStyle(node).fontSize));
        return {
          reading: Math.min(...sizes('.indicative-explainer'), ...sizes('.indicative-table tbody th'), ...sizes('.indicative-table tbody td')),
          labels: Math.min(...sizes('.indicative-table thead th'), ...sizes('.indicative-sub')),
        };
      });
      expect(seen.reading, `${where}: the panel's explanation and table`).toBeGreaterThanOrEqual(16);
      expect(seen.labels, `${where}: its column heads and the notes under a price`).toBeGreaterThanOrEqual(14);
    };
    await bodyFloors('1920px');
    expect(await hoverOnlyCaveats(page)).toEqual([]);
    expect(await belowTypeFloor(page)).toEqual([]);
    expect(await tightRunningText(page)).toEqual([]);
    // The status, the line under the value, and the overnight panel's count and switch label (12px before): 14px.
    const fourteen = [status, page.locator('.portfolio-value-meta'), panel.locator('.indicative-count'), panel.locator('.indicative-switch-label')];
    for (const line of fourteen) {
      expect(await line.evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(14);
    }

    // On a phone the same words show, without a hover.
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(holdingRow(page, 'NBIS').locator('.holding-price-note')).toBeVisible();
    await expect(status).toBeVisible();
    expect(await belowTypeFloor(page)).toEqual([]);
    expect(await tightRunningText(page)).toEqual([]);
    await bodyFloors('375px');
    for (const line of fourteen) {
      expect(await line.evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(14);
    }

    // Back to official prices: the estimates leave every total and row.
    await page.setViewportSize({ width: 1920, height: 1000 });
    await status.getByRole('button', { name: 'Use official prices' }).click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('.holding-price-note.overnight')).toHaveCount(0);
    await expect(chart.locator('.portfolio-chart-title')).toHaveText('Portfolio value');
  });
});

test.describe('Journey 9: from an empty state to an import that only its final action saves', () => {
  /** A synthetic holdings table, in the format the import reads. */
  const TABLE = {
    headers: ['Symbol', 'Quantity', 'Last price', 'Average cost basis'],
    rows: [
      { Symbol: 'MSFT', Quantity: '3', 'Last price': '$384.36', 'Average cost basis': '$250.00' },
      { Symbol: 'SGOV', Quantity: '10', 'Last price': '$100.48', 'Average cost basis': '$99.00' },
    ],
  };

  /**
   * Visible text in `scope` below its D1 floor (16px for the empty state's words and the import's choices, 14px for
   * everything else, form fields included) and running text that can wrap set tighter than line-height 1.5.
   */
  const entryTypeProblems = (page: Page, scope: string) => page.evaluate((root) => {
    const found: string[] = [];
    const running = 'p, .empty-state-body, .import-error, .import-status-reason';
    for (const node of document.querySelectorAll(`${root}, ${root} *`)) {
      if (node.closest('svg, .visually-hidden')) continue;
      const field = node.matches('textarea, select, input:not([type="radio"]):not([type="checkbox"]):not([type="file"])');
      if (!field && ![...node.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').trim())) continue;
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      if (box.width === 0 || box.height === 0 || style.visibility === 'hidden') continue;
      const reading = node.matches('.empty-state-title, .empty-state-body, .import-choice-option > label, .row .symbol');
      const floor = reading ? 16 : 14;
      const size = parseFloat(style.fontSize);
      const name = `${node.tagName.toLowerCase()}.${[...node.classList].join('.')} "${(node.textContent ?? '').trim().slice(0, 30)}"`;
      if (size < floor) found.push(`${name} ${size}px < ${floor}px`);
      if (node.matches(running) && parseFloat(style.lineHeight) / size < 1.49) found.push(`${name} line-height ${style.lineHeight}`);
    }
    return found;
  }, scope);

  for (const width of [375, 1920] as const) {
    test(`at ${width}px: each empty state offers its next step, and Import saves nothing before its one final action`, async ({ page, request }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width, height: width === 375 ? 812 : 1080 });
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const accountId = `e2e-journey9-${suffix}`;
      const twinId = `e2e-journey9-twin-${suffix}`;
      // A long name, and a twin of the same name: only its type and masked number tell them apart (review of #248).
      const accountName = `E2E Journey ${suffix} · Synthetic rollover retirement account from a former employer`;
      const last4 = String(1000 + Math.floor(Math.random() * 8000));
      const twinLast4 = String(Number(last4) + 1);
      const identity = `${accountName} · Individual · ***${last4}`;
      const twinIdentity = `${accountName} · Joint · ***${twinLast4}`;
      const savedIn = async (id: string) => {
        const body = await request.get(`/accounts/${id}/transactions`).then((r) => r.json()) as { transactions: Array<{ symbol: string }> };
        return body.transactions.map((transaction) => transaction.symbol).sort();
      };
      const saved = () => savedIn(accountId);
      try {
        // No accounts: the one step is to add one.
        await page.evaluate(() => localStorage.removeItem('finance-tracker:state:v2'));
        await page.route('**/accounts', (route) => (route.request().method() !== 'GET' ? route.continue()
          : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accounts: [] }) })));
        const household = (url: URL) => url.pathname.endsWith('/transactions') && !url.pathname.includes('/accounts/');
        await page.route(household, (route) => (route.request().method() !== 'GET' ? route.continue()
          : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ transactions: [] }) })));
        // A fresh load each time (a hash change alone stays in the page and keeps what it read).
        await page.goto('about:blank');
        await page.goto('/#/investing/transactions');
        const empty = page.locator('.empty-state');
        await expect(empty.locator('.empty-state-title')).toHaveText('No accounts yet');
        await expect(empty.getByRole('button')).toHaveText(['Add account']);
        expect(await entryTypeProblems(page, '.empty-state')).toEqual([]);
        await empty.getByRole('button', { name: 'Add account' }).click();
        await expect(page.getByRole('tab', { name: 'Accounts' })).toHaveAttribute('aria-selected', 'true');

        // An account but no trades: add one by hand, or import them.
        const created = await request.post('/accounts', {
          data: { id: accountId, name: accountName, type: 'Individual', accountNumber: `9${last4}`, cashBalance: 0, currency: 'USD' },
        });
        expect(created.status()).toBe(201);
        const twin = await request.post('/accounts', {
          data: { id: twinId, name: accountName, type: 'Joint', accountNumber: `9${twinLast4}`, cashBalance: 0, currency: 'USD' },
        });
        expect(twin.status()).toBe(201);
        await page.unroute('**/accounts');
        await page.goto('about:blank');
        await page.goto('/#/investing/transactions');
        await expect(empty.locator('.empty-state-title')).toHaveText('No transactions yet');
        await expect(empty.getByRole('button')).toHaveText(['Add transaction', 'Import']);
        expect(await entryTypeProblems(page, '.empty-state')).toEqual([]);
        await empty.getByRole('button', { name: 'Import', exact: true }).click();

        // Import asks what first; then the account and the table; then a preview.
        await expect(page.getByRole('tab', { name: 'Import' })).toHaveAttribute('aria-selected', 'true');
        const question = page.getByRole('group', { name: 'What do you want to import?' });
        await expect(question.getByRole('radio')).toHaveCount(2);
        await expect(question.getByRole('radio', { name: 'Holdings or trades for an account' })).toBeChecked();
        await expect(page.getByRole('button', { name: /^Advanced/ })).toHaveAttribute('aria-expanded', 'false');
        // The account is said in full under its select, wrapping rather than cut, so a twin of the same name is told
        // apart before anything is saved.
        const select = page.getByRole('combobox', { name: 'Account', exact: true });
        const destination = page.locator('.import-holdings .import-destination');
        await select.selectOption(twinId);
        await expect(destination).toHaveText(`These holdings go into ${twinIdentity}.`);
        await select.selectOption(accountId);
        await expect(destination).toHaveText(`These holdings go into ${identity}.`);
        await expect(select).toHaveAttribute('aria-describedby', (await destination.getAttribute('id'))!);
        const fit = await destination.evaluate((node) => {
          const form = node.closest('form')!.getBoundingClientRect();
          const box = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return {
            cut: node.scrollWidth > node.clientWidth + 0.5,
            inside: box.left >= form.left - 0.5 && box.right <= form.right + 0.5,
            lines: Math.round(box.height / parseFloat(style.lineHeight)),
            size: parseFloat(style.fontSize),
            leading: parseFloat(style.lineHeight) / parseFloat(style.fontSize),
          };
        });
        expect(fit.cut).toBe(false);
        expect(fit.inside).toBe(true);
        if (width === 375) expect(fit.lines, 'the long account wraps on a phone').toBeGreaterThan(1);
        expect(fit.size).toBeGreaterThanOrEqual(14);
        expect(fit.leading).toBeGreaterThanOrEqual(1.49);
        await page.getByRole('textbox', { name: 'Holdings table', exact: true }).fill(JSON.stringify(TABLE));
        await page.getByRole('button', { name: 'Preview import' }).click();
        const preview = page.getByRole('region', { name: 'Import preview' });
        // The preview's title names the same account in full, never cut.
        await expect(preview.getByRole('heading')).toHaveText([`2 transactions to import into ${identity}`]);
        expect(await preview.getByRole('heading').evaluate((node) => node.scrollWidth <= node.clientWidth + 0.5)).toBe(true);
        await expect(preview).toContainText('MSFT');
        await expect(preview).toContainText('SGOV');
        await expect(preview).toContainText('Nothing is saved until you choose Import.');
        expect(await entryTypeProblems(page, '.import-panel')).toEqual([]);

        // Nothing is saved by the preview; its one action saves the two, and says so.
        expect(await saved()).toEqual([]);
        await expect(preview.getByRole('button')).toHaveText(['Import 2 transactions']);
        await preview.getByRole('button', { name: 'Import 2 transactions' }).click();
        await expect(page.locator('.import-panel .import-done')).toHaveText(`Imported 2 transactions into ${identity}.`);
        await expect(preview).toHaveCount(0);
        await expect.poll(saved).toEqual(['MSFT', 'SGOV']);
        expect(await savedIn(twinId)).toEqual([]);

        // A pull that finds two accounts, suggested as the twins: each box names its account in full, and on a phone too
        // keeps its select, suggestion and button inside it (the select is as wide as the long name). The pull saves nothing.
        await page.route('**/import/from-broker', (route) => route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            previews: [[accountId, last4, 'AAPL'], [twinId, twinLast4, 'VTI']].map(([id, digits, symbol]) => ({
              section: `Brokerage ***${digits}`,
              suggestion: { accountId: id, accountName, confidence: 1 },
              transactions: [{ id: `pull-${symbol}`, accountId: '', symbol, date: '2026-07-10', quantity: 1, pricePerUnit: 100, currency: 'USD' }],
              rejected: [],
              mapping: { symbol: 'Symbol', quantity: 'Quantity', price: 'Price', cost: null },
            })),
            source: { broker: 'schwab', sourceUrl: null, tableCount: 2, candidateCount: 2 },
            accounts: [],
          }),
        }));
        const advanced = page.getByRole('button', { name: /^Advanced/ });
        await advanced.click();
        await page.getByRole('button', { name: /^Pull positions from/ }).click();
        const found = page.getByRole('region', { name: 'Accounts found' });
        await expect(found).toContainText('2 accounts found.');
        await advanced.click();
        await expect(found.locator('.import-section-suggestion'))
          .toHaveText([`Suggested: ${identity} (100% match)`, `Suggested: ${twinIdentity} (100% match)`]);
        await expect(found.getByRole('button', { name: /^Import 1 into / }))
          .toHaveText([`Import 1 into ${identity}`, `Import 1 into ${twinIdentity}`]);
        const outside = await found.locator('fieldset.import-section').evaluateAll((boxes) => boxes.flatMap((box) => {
          const edge = box.getBoundingClientRect();
          return [...box.querySelectorAll('*')].filter((node) => {
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && (rect.left < edge.left - 0.5 || rect.right > edge.right + 0.5);
          }).map((node) => `${node.tagName.toLowerCase()}.${[...node.classList].join('.')} "${(node.textContent ?? '').trim().slice(0, 40)}"`);
        }));
        expect(outside, 'everything in a found account stays inside its box').toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
        expect(await entryTypeProblems(page, '.import-panel')).toEqual([]);
        expect(await saved()).toEqual(['MSFT', 'SGOV']);
        expect(await savedIn(twinId)).toEqual([]);
      } finally {
        await cleanupAccount(request, accountId);
        await cleanupAccount(request, twinId);
      }
    });
  }
});
