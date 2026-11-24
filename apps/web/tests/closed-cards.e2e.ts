import { buildCardImportPayload, serializeCardImportPayload, type CardAccount, type CardImportDraftRow } from '@finance-tracker/shared';
import { expect, requireHealthyApi, test, type APIRequestContext, type Locator, type Page } from './fixtures';

/**
 * Closed cards (plan D, journey 4). Manage cards, always beside the Card picker, lists every card with whose it is, its
 * status in Holdr and the latest day Holdr has of it, oldest activity first; a card is marked closed or reopened only
 * after a confirmation naming it. Closing keeps every transaction and total, hides the card in the picker until "Show
 * closed cards" is on, and, once the page reads its figures again (contract C-1), ends the card's later gap in the
 * months while an earlier gap stays; reopening brings the later gap back. Synthetic cards, merchants and amounts only.
 */

const headers = { 'Content-Type': 'application/json', 'X-Holdr-Request': '1' };
const dates = 'from=2024-03-01&to=2024-03-31';
const CLOSING_DETAIL = 'Later history is no longer expected after this card\'s last recorded activity or imported coverage; earlier gaps may remain.';

async function account(request: APIRequestContext, data: Record<string, string>): Promise<string> {
  const created = await request.post('/card-accounts', { headers, data: { currency: 'USD', ...data } });
  expect(created.status(), await created.text()).toBe(201);
  return (await created.json() as { id: string }).id;
}

async function commit(request: APIRequestContext, id: string, issuer: string, coverage: { start: string; end: string }, rows: CardImportDraftRow[]) {
  const data = serializeCardImportPayload(buildCardImportPayload({
    source: 'e2e-sync', parserVersion: 'e2e@1', issuer, currency: 'USD', coverage, rows,
  }).payload);
  const committed = await request.post(`/card-imports/commit?cardAccountId=${id}`, { headers, data });
  expect(committed.status(), await committed.text()).toBe(201);
}

async function seed(request: APIRequestContext, nickname: string) {
  const id = await account(request, { issuer: 'amex', owner: 'joint', nickname, last5: '90003' });
  await commit(request, id, 'amex', { start: '2024-03-01', end: '2024-03-20' }, [
    { transactionDate: '2024-03-06', amountMinor: 2500, kind: 'purchase', description: `${nickname} SAMPLE MARKET` },
    { transactionDate: '2024-03-07', amountMinor: 500, kind: 'interest', description: `${nickname} INTEREST CHARGE` },
    { transactionDate: '2024-03-08', amountMinor: 700, kind: 'purchase', status: 'pending', description: `${nickname} SAMPLE CAFE` },
  ]);
  return id;
}

async function open(page: Page) {
  await page.clock.setFixedTime(new Date('2024-03-20T12:00:00'));
  await page.goto('/');
  await page.getByRole('tab', { name: 'Spending', exact: true }).click();
  await expect(page.locator('.spending-month-label')).toHaveText('March 2024');
}

async function reports(request: APIRequestContext) {
  return Promise.all([
    `/spending/summary?${dates}`,
    `/card-transactions?${dates}&status=posted&limit=100`,
    `/card-transactions?${dates}&status=pending&limit=100`,
    '/spending/insights?month=2024-03&today=2024-03-20',
    '/spending/coverage',
  ].map(async (path) => {
    const response = await request.get(path);
    expect(response.status()).toBe(200);
    return response.json();
  }));
}

/** Opens Manage cards from its button and waits until each card's latest record is read. */
async function openManager(page: Page) {
  await page.getByRole('button', { name: 'Manage cards', exact: true }).click();
  const manager = page.getByRole('dialog', { name: 'Manage cards' });
  await expect(manager).toBeFocused();
  await expect(manager.getByRole('list', { name: 'Cards' })).toBeVisible();
  return manager;
}

const fits = (locator: Locator) => locator.evaluate((element) => element.scrollWidth <= element.clientWidth);

for (const width of [1280, 390, 280]) {
  test(`closed cards retain all spending and can reopen at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    await requireHealthyApi(request);
    const nickname = `Archive ${width}`;
    const label = `Amex ${nickname} ··90003 · Joint`;
    const id = await seed(request, nickname);
    const before = await reports(request);
    await open(page);
    const picker = page.getByRole('combobox', { name: 'Card', exact: true });
    await picker.selectOption(id);
    const total = page.getByTestId('overview-total');
    await expect(total).toHaveText('$30.00');

    // Manage cards is beside the picker whatever is selected; each card says whose it is, its status and its latest record.
    let manager = await openManager(page);
    expect(await fits(manager)).toBe(true);
    const row = manager.locator(`[data-card="${id}"]`);
    await expect(row).toContainText(label.replace(' · Joint', ''));
    await expect(row.getByTestId('card-manager-meta')).toHaveText('Joint · Active');
    await expect(row.getByTestId('card-manager-latest')).toHaveText('Latest recorded Mar 20, 2024');
    await row.getByRole('button', { name: `Mark closed: ${label}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Mark card closed in Holdr?' });
    await expect(dialog).toContainText(label);
    await expect(dialog).toContainText('Latest recorded Mar 20, 2024');
    await expect(dialog).toContainText(CLOSING_DETAIL);
    await expect(dialog).toContainText('not your account at the bank');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row.getByRole('button', { name: `Mark closed: ${label}`, exact: true })).toBeFocused();
    await row.getByRole('button', { name: `Mark closed: ${label}`, exact: true }).click();
    await dialog.getByRole('button', { name: 'Mark closed', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row.getByRole('button', { name: `Reopen: ${label}`, exact: true })).toBeFocused();
    await expect(row.getByTestId('card-manager-meta')).toHaveText('Joint · Closed in Holdr');
    await expect(manager.getByTestId('card-manager-notice')).toHaveText(`${label} is marked closed. All transactions are retained.`);
    await page.keyboard.press('Escape');
    await expect(manager).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Manage cards', exact: true })).toBeFocused();
    await expect(picker).toHaveValue(id);
    await expect(picker.locator('option:checked')).toContainText('(closed)');
    await expect(total).toHaveText('$30.00');
    expect(await reports(request)).toEqual(before);

    // A new visit starts with closed cards hidden in the picker, but All cards still includes every row.
    await page.reload();
    const toggle = page.getByRole('checkbox', { name: /^Show closed cards \(\d+\)$/ });
    await expect(toggle).not.toBeChecked();
    await expect(picker).toHaveValue('');
    await expect(picker.locator(`option[value="${id}"]`)).toHaveCount(0);
    await page.getByRole('searchbox', { name: 'Search merchant or description' }).fill(nickname);
    await expect(page.locator('.spending-transactions .spending-row')).toHaveCount(3);
    await expect(total).toHaveText('$30.00');
    await expect(page.getByRole('group', { name: 'Months' }).locator('[data-month="2024-03"]')).toHaveAccessibleName(/^\$30\.00 in March 2024/);
    await page.getByRole('searchbox', { name: 'Search merchant or description' }).fill('');
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(toggle).toBeChecked();
    await expect(picker.locator(`optgroup option[value="${id}"]`)).toHaveCount(1);
    await picker.selectOption(id);
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(picker).toHaveValue(id);
    await expect(picker.locator('option:checked')).toContainText('(closed)');
    await expect(total).toHaveText('$30.00');

    manager = await openManager(page);
    await manager.locator(`[data-card="${id}"]`).getByRole('button', { name: `Reopen: ${label}`, exact: true }).click();
    const reopen = page.getByRole('dialog', { name: 'Reopen card in Holdr?' });
    await expect(reopen).toBeVisible();
    await expect(reopen).toContainText('This puts the card back in the active list.');
    await expect(reopen).toContainText('Holdr expects this card\'s history again through today.');
    expect(await fits(reopen)).toBe(true);
    await page.keyboard.press('Shift+Tab');
    await expect(reopen.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(reopen.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
    await reopen.getByRole('button', { name: 'Reopen card', exact: true }).click();
    await expect(reopen).toHaveCount(0);
    await expect(manager.getByTestId('card-manager-notice')).toHaveText(`${label} is active again. All transactions are retained.`);
    await manager.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(picker.locator('option:checked')).not.toContainText('(closed)');
    expect(await reports(request)).toEqual(before);
    await page.reload();
    await expect(picker.locator(`option[value="${id}"]`)).toHaveCount(1);
    const layout = await page.locator('.spending-toolbar').evaluate((el) => ({
      left: el.getBoundingClientRect().left,
      right: el.getBoundingClientRect().right,
      scrollWidth: el.scrollWidth,
      width: el.clientWidth,
    }));
    expect(layout.left).toBeGreaterThanOrEqual(0);
    expect(layout.right).toBeLessThanOrEqual(width);
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
  });
}

test('a rejected status update stays in the confirmation with an error and leaves the card active', async ({ page, request }) => {
  const nickname = 'Archive refused';
  const label = `Amex ${nickname} ··90003 · Joint`;
  const id = await seed(request, nickname);
  await open(page);
  await page.route(`**/card-accounts/${id}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Unable to save card status' }) });
    } else await route.continue();
  });
  const manager = await openManager(page);
  const row = manager.locator(`[data-card="${id}"]`);
  await row.getByRole('button', { name: `Mark closed: ${label}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Mark card closed in Holdr?' });
  await dialog.getByRole('button', { name: 'Mark closed', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Unable to save card status');
  await expect(dialog.getByRole('button', { name: 'Mark closed', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(row.getByTestId('card-manager-meta')).toHaveText('Joint · Active');
  await expect(manager.getByTestId('card-manager-notice')).toHaveText('');
  await page.keyboard.press('Escape');
  await expect(manager).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Card', exact: true }).locator(`option[value="${id}"]`)).not.toContainText('(closed)');
});

// ---- Journey 4: a card whose statements stop --------------------------------------------------------------------------

const purchase = (transactionDate: string, amountMinor: number, description: string): CardImportDraftRow =>
  ({ transactionDate, amountMinor, kind: 'purchase', description, issuerCategory: 'Groceries' });

/** January and March 2024, and nothing after: February is an earlier gap, April and May a later one. */
async function seedStopped(request: APIRequestContext, nickname: string, last5: string) {
  const id = await account(request, { issuer: 'amex', owner: 'casey', nickname, last5 });
  await commit(request, id, 'amex', { start: '2024-01-01', end: '2024-01-31' },
    [purchase('2024-01-06', 4_200, 'NORTHWIND GROCERY'), purchase('2024-01-20', 1_800, 'PROSEWARE BISTRO')]);
  await commit(request, id, 'amex', { start: '2024-03-01', end: '2024-03-31' },
    [purchase('2024-03-04', 2_600, 'NORTHWIND GROCERY'), purchase('2024-03-18', 900, 'CONTOSO CAFE')]);
  return id;
}

/** The card's own ledger: its year-to-date total, its rows and its record, as the API has them. */
async function ledger(request: APIRequestContext, id: string) {
  const range = `from=2024-01-01&to=2024-06-20&cardAccountId=${id}`;
  const [summary, posted, pending, coverage] = await Promise.all([
    `/spending/summary?${range}`,
    `/card-transactions?${range}&status=posted&limit=100`,
    `/card-transactions?${range}&status=pending&limit=100`,
    '/spending/coverage',
  ].map(async (path) => {
    const response = await request.get(path);
    expect(response.status()).toBe(200);
    return response.json();
  }));
  return { summary, posted, pending, coverage: (coverage as { cards: Array<{ cardAccountId: string }> }).cards.find((card) => card.cardAccountId === id) };
}

/** Spending for the stopped card, year to date (June 20, 2024), with its months. */
async function openStopped(page: Page, id: string) {
  await page.clock.setFixedTime(new Date('2024-06-20T12:00:00'));
  await page.goto('/');
  await page.getByRole('tab', { name: 'Spending', exact: true }).click();
  await page.getByRole('combobox', { name: 'Card', exact: true }).selectOption(id);
  await page.getByRole('group', { name: 'Period' }).getByRole('button', { name: 'YTD', exact: true }).click();
  const overview = page.getByRole('region', { name: 'Spending overview' });
  await expect(overview).toHaveAttribute('aria-busy', 'false');
  return { overview, months: overview.getByRole('group', { name: 'Months' }) };
}

const partial = (months: Locator, month: string) => months.locator(`[data-month="${month}"]`);

for (const width of [1280, 390]) {
  test(`closing a stopped card ends its later gap once the page reads again, keeps its totals, and reopening restores the gap, from the keyboard at ${width}px`,
    async ({ page, request }) => {
      await page.setViewportSize({ width, height: 900 });
      await requireHealthyApi(request);
      const nickname = `Stopped ${width}`;
      const last5 = width === 1280 ? '91280' : '90390';
      const label = `Amex ${nickname} ··${last5} · Casey`;
      const later = `No statements imported after Mar 31, 2024 for ${label}`;
      const id = await seedStopped(request, nickname, last5);
      const before = await ledger(request, id);
      expect(before.summary.totals).toEqual([expect.objectContaining({ currency: 'USD', spendingMinor: 9_500 })]);
      expect(before.posted.total).toBe(4);

      const { overview, months } = await openStopped(page, id);
      const total = overview.getByTestId('overview-total');
      const rows = page.locator('.spending-transactions .spending-row');
      await expect(total).toHaveText('$95.00');
      await expect(rows).toHaveCount(4);
      // The cards missing history are folded under their count (S2): opened, it stays open while the months read again.
      const missing = months.getByRole('button', { name: /^Missing history \(\d+ cards?\)$/ });
      await missing.click();
      await expect(missing).toHaveAttribute('aria-expanded', 'true');
      await expect(months).toContainText(later);
      for (const month of ['2024-02', '2024-04', '2024-05']) await expect(partial(months, month)).toHaveAttribute('data-partial', 'true');
      for (const month of ['2024-01', '2024-03']) await expect(partial(months, month)).toHaveAttribute('data-partial', 'false');

      // From the keyboard: Manage cards, the card's Mark closed, then the confirmation's.
      const manage = page.getByRole('button', { name: 'Manage cards', exact: true });
      await manage.focus();
      await page.keyboard.press('Enter');
      const manager = page.getByRole('dialog', { name: 'Manage cards' });
      await expect(manager).toBeFocused();
      const row = manager.locator(`[data-card="${id}"]`);
      await expect(row.getByTestId('card-manager-latest')).toHaveText('Latest recorded Mar 31, 2024');
      await row.getByRole('button', { name: `Mark closed: ${label}`, exact: true }).focus();
      await page.keyboard.press('Enter');
      const confirm = page.getByRole('dialog', { name: 'Mark card closed in Holdr?' });
      await expect(confirm).toBeFocused();
      await expect(confirm).toContainText(label);
      await expect(confirm).toContainText(CLOSING_DETAIL);
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await expect(confirm.getByRole('button', { name: 'Mark closed', exact: true })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(confirm).toHaveCount(0);
      await expect(row.getByRole('button', { name: `Reopen: ${label}`, exact: true })).toBeFocused();
      const notice = manager.getByTestId('card-manager-notice');
      await expect(notice).toHaveText(`${label} is marked closed. All transactions are retained.`);
      await page.keyboard.press('Escape');
      await expect(manager).toHaveCount(0);
      await expect(manage).toBeFocused();

      // Read again (C-1): April, no longer expected, proves the new answer is in; the later gap is gone, and February's
      // earlier gap stays.
      for (const month of ['2024-04', '2024-05']) await expect(partial(months, month)).toHaveAttribute('data-partial', 'false');
      await expect(overview).toHaveAttribute('aria-busy', 'false');
      await expect(months).toBeVisible();
      // Missing history still open (the card is still first seen after the months' start): its later gap is gone.
      await expect(missing).toHaveAttribute('aria-expanded', 'true');
      await expect(months).not.toContainText(later);
      await expect(months).not.toContainText('No statements imported after');
      await expect(partial(months, '2024-02')).toHaveAttribute('data-partial', 'true');
      await expect(total).toHaveText('$95.00');
      await expect(rows).toHaveCount(4);
      expect(await ledger(request, id)).toEqual(before);

      // Reopened, from the keyboard too: the later gap is back.
      await manage.focus();
      await page.keyboard.press('Enter');
      await expect(manager).toBeFocused();
      await row.getByRole('button', { name: `Reopen: ${label}`, exact: true }).focus();
      await page.keyboard.press('Enter');
      const reopen = page.getByRole('dialog', { name: 'Reopen card in Holdr?' });
      await expect(reopen).toBeFocused();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await expect(reopen.getByRole('button', { name: 'Reopen card', exact: true })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(reopen).toHaveCount(0);
      await expect(notice).toHaveText(`${label} is active again. All transactions are retained.`);
      await page.keyboard.press('Escape');
      await expect(manager).toHaveCount(0);
      for (const month of ['2024-04', '2024-05']) await expect(partial(months, month)).toHaveAttribute('data-partial', 'true');
      await expect(overview).toHaveAttribute('aria-busy', 'false');
      await expect(missing).toHaveAttribute('aria-expanded', 'true');
      await expect(months).toContainText(later);
      await expect(partial(months, '2024-02')).toHaveAttribute('data-partial', 'true');
      await expect(total).toHaveText('$95.00');
      await expect(rows).toHaveCount(4);
      expect(await ledger(request, id)).toEqual(before);
    });
}

test('a read that fails after a status change stays on screen, and the notice claims no refresh', async ({ page, request }) => {
  const nickname = 'Stopped unread';
  const label = `Amex ${nickname} ··90404 · Casey`;
  const id = await seedStopped(request, nickname, '90404');
  const { overview, months } = await openStopped(page, id);
  await months.getByRole('button', { name: /^Missing history \(\d+ cards?\)$/ }).click();
  await expect(months).toContainText(`No statements imported after Mar 31, 2024 for ${label}`);
  // Every read of the months from now on fails.
  await page.route((url) => url.pathname === '/spending/trend', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Unable to read the months' }) }));
  const manager = await openManager(page);
  await manager.locator(`[data-card="${id}"]`).getByRole('button', { name: `Mark closed: ${label}`, exact: true }).click();
  await page.getByRole('dialog', { name: 'Mark card closed in Holdr?' }).getByRole('button', { name: 'Mark closed', exact: true }).click();
  const notice = manager.getByTestId('card-manager-notice');
  await expect(notice).toHaveText(`${label} is marked closed. All transactions are retained.`);
  await expect(notice).not.toContainText(/refresh|updated|chart/i);
  await page.keyboard.press('Escape');
  // The overview read again and failed: it says so, and shows no months as if they were read.
  const failure = overview.locator('.overview-error');
  await expect(failure).toContainText('Unable to read the months');
  await expect(months).toHaveCount(0);
  await page.waitForTimeout(500);
  await expect(failure).toBeVisible();
  expect((await request.patch(`/card-accounts/${id}`, { headers, data: { status: 'active' } })).status()).toBe(200);
});

test('Manage cards says when it could not read the latest records, lists the cards by name, and reads again', async ({ page, request }) => {
  const nickname = 'Unread record';
  const label = `Amex ${nickname} ··90405 · Casey`;
  const id = await seedStopped(request, nickname, '90405');
  await openStopped(page, id);
  let fail = true;
  await page.route((url) => url.pathname === '/spending/coverage', (route) => (fail
    ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Unable to read coverage' }) })
    : route.continue()));
  await page.getByRole('button', { name: 'Manage cards', exact: true }).click();
  const manager = page.getByRole('dialog', { name: 'Manage cards' });
  const failure = manager.getByTestId('card-manager-read-error');
  await expect(failure).toHaveText(/^Couldn't read when each card was last recorded: Unable to read coverage/);
  const row = manager.locator(`[data-card="${id}"]`);
  // Never a guess: not "Nothing recorded".
  await expect(row.getByTestId('card-manager-latest')).toHaveText('Latest record not read');
  await expect(manager.getByTestId('card-manager-count')).toHaveText(/ cards?, by name$/);
  await expect(row.getByRole('button', { name: `Mark closed: ${label}`, exact: true })).toBeEnabled();
  fail = false;
  await failure.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(failure).toHaveCount(0);
  await expect(manager.getByTestId('card-manager-count')).toBeFocused();
  await expect(manager.getByTestId('card-manager-count')).toHaveText(/ cards?, oldest activity first$/);
  await expect(row.getByTestId('card-manager-latest')).toHaveText('Latest recorded Mar 31, 2024');
});

test('openCardManager() opens Manage cards from anywhere on the page and moves focus into it, open or not', async ({ page, request }) => {
  await seedStopped(request, 'Asked for', '90406');
  await page.clock.setFixedTime(new Date('2024-06-20T12:00:00'));
  await page.goto('/');
  await page.getByRole('tab', { name: 'Spending', exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Search merchant or description' });
  await search.focus();
  await page.evaluate(() => window.dispatchEvent(new Event('holdr:open-card-manager')));
  const manager = page.getByRole('dialog', { name: 'Manage cards' });
  await expect(manager).toBeFocused();
  await expect(manager.getByRole('list', { name: 'Cards' })).toBeVisible();
  // Asked for again while open, with focus elsewhere in it: back to Manage cards itself.
  await manager.getByRole('button', { name: 'Close', exact: true }).focus();
  await page.evaluate(() => window.dispatchEvent(new Event('holdr:open-card-manager')));
  await expect(manager).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(manager).toHaveCount(0);
  await expect(search).toBeFocused();
});

// ---- Where Manage cards sits ----------------------------------------------------------------------------------------------

async function openToolbar(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.clock.setFixedTime(new Date('2024-06-20T12:00:00'));
  await page.goto('/');
  await page.getByRole('tab', { name: 'Spending', exact: true }).click();
  const manage = page.getByRole('button', { name: 'Manage cards', exact: true });
  await expect(manage).toBeVisible();
  return {
    manage,
    person: page.getByRole('combobox', { name: 'Person', exact: true }),
    picker: page.getByRole('combobox', { name: 'Card', exact: true }),
  };
}

for (const width of [360, 375, 390, 430]) {
  test(`on a phone, Manage cards shows in full in the filter row before any sideways scroll, after Person, at ${width}px`, async ({ page }) => {
    const { manage, person, picker } = await openToolbar(page, width, 800);
    const filters = page.locator('.spending-filters');
    expect(await filters.evaluate((element) => element.scrollLeft)).toBe(0);
    await expect(manage).toBeInViewport({ ratio: 1 });
    const box = (await manage.boundingBox())!;
    const row = (await filters.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(row.x);
    expect(box.x + box.width).toBeLessThanOrEqual(Math.min(row.x + row.width, width));
    // A 44px touch target, its words at the type floor and in one line.
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(await fontSize(manage)).toBeGreaterThanOrEqual(14);
    expect(await manage.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    // Person, Manage cards, then the Card picker: on screen and in focus order alike.
    expect((await person.boundingBox())!.x).toBeLessThan(box.x);
    expect(box.x).toBeLessThan((await picker.boundingBox())!.x);
    await person.focus();
    await page.keyboard.press('Tab');
    await expect(manage).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(picker).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  });
}

test('on a desktop, Manage cards follows the Card picker, on screen and in focus order', async ({ page }) => {
  const { manage, picker } = await openToolbar(page, 1920, 1080);
  await expect(manage).toBeInViewport({ ratio: 1 });
  expect((await picker.boundingBox())!.x).toBeLessThan((await manage.boundingBox())!.x);
  await picker.focus();
  await page.keyboard.press('Tab');
  await expect(manage).toBeFocused();
});

for (const [from, to] of [[430, 1920], [1920, 430]] as const) {
  test(`across the phone breakpoint (${from} to ${to}px) with a confirmation open, closing each dialog returns focus where it was`, async ({ page, request }) => {
    const nickname = `Resize ${from}`;
    const last5 = from === 430 ? '90430' : '91920';
    const label = `Amex ${nickname} ··${last5} · Casey`;
    const id = await seedStopped(request, nickname, last5);
    const { manage, picker } = await openToolbar(page, from, 900);
    await manage.click();
    const manager = page.getByRole('dialog', { name: 'Manage cards' });
    await expect(manager.getByRole('list', { name: 'Cards' })).toBeVisible();
    const markClosed = manager.locator(`[data-card="${id}"]`).getByRole('button', { name: `Mark closed: ${label}`, exact: true });
    await markClosed.click();
    const confirm = page.getByRole('dialog', { name: 'Mark card closed in Holdr?' });
    await expect(confirm).toBeFocused();
    // Manage cards moves to the other side of the picker: the same button, moved.
    await page.setViewportSize({ width: to, height: 900 });
    await expect.poll(async () => (await manage.boundingBox())!.x < (await picker.boundingBox())!.x).toBe(to <= 720);
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(markClosed).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(manager).toHaveCount(0);
    await expect(manage).toBeFocused();
  });
}

// ---- Type floors (plan D1) ----------------------------------------------------------------------------------------------

/**
 * Every visible text in `root` below the floors (plan D1): set under `floor` px, or, for running text that can wrap (not
 * a heading or a single-line control), set tighter than 1.5.
 */
function textBelow(root: Locator, floor: number): Promise<string[]> {
  return root.evaluate((element, min) => {
    const small: string[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      const parent = node.parentElement;
      if (!text || !parent || parent.closest('option, optgroup')) continue;
      const box = parent.getBoundingClientRect();
      const style = getComputedStyle(parent);
      if (style.visibility === 'hidden' || box.width <= 1 || box.height <= 1) continue;
      const size = Number.parseFloat(style.fontSize);
      if (size < min) small.push(`${text} (${size}px)`);
      if (parent.closest('h1, h2, h3, h4, h5, h6, button, select, summary, input, .spending-toggle') === null
        && !(Number.parseFloat(style.lineHeight) >= size * 1.5 - 0.5)) small.push(`${text} (line-height ${style.lineHeight} at ${size}px)`);
    }
    return small;
  }, floor);
}

const fontSize = (locator: Locator) => locator.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));

const SYNTHETIC: CardAccount[] = [
  ['type-amex', 'amex', 'alex', 'Type Gold', '63061', 'active'],
  ['type-chase', 'chase', 'casey', 'Type Travel', '6823', 'closed'],
  ['type-citi', 'citi', 'joint', 'Type Spare', '8075', 'active'],
].map(([id, issuer, owner, nickname, ending, status]) => ({
  id, issuer, owner: owner as CardAccount['owner'], nickname, ...(ending.length === 5 ? { last5: ending, last4: ending.slice(1) } : { last4: ending }),
  currency: 'USD', status: status as CardAccount['status'], createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
}));

/** Spending with only the synthetic cards and their records, every status change refused; `failCoverage` fails each later read of the records. */
async function openSynthetic(page: Page, cards: CardAccount[] = SYNTHETIC) {
  const state = { failCoverage: false };
  await page.route((url) => url.pathname === '/card-accounts', (route) => route.fulfill({ json: { cardAccounts: cards } }));
  await page.route((url) => url.pathname === '/spending/coverage', (route) => (state.failCoverage
    ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Unable to read coverage' }) })
    : route.fulfill({ json: { cards: cards.map((card, index) => ({
      cardAccountId: card.id, ranges: index === 2 ? [] : [{ start: '2024-01-01', end: `2024-0${index + 2}-28` }],
      transactions: index === 2 ? null : { count: 2, first: '2024-01-05', last: `2024-0${index + 2}-20` }, imports: [],
    })) } })));
  await page.route((url) => url.pathname.startsWith('/card-accounts/'), (route) => (route.request().method() === 'PATCH'
    ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Unable to save card status' }) })
    : route.continue()));
  await page.clock.setFixedTime(new Date('2024-06-20T12:00:00'));
  await page.goto('/');
  await page.getByRole('tab', { name: 'Spending', exact: true }).click();
  return state;
}

for (const [width, height] of [[375, 812], [1920, 1080]] as const) {
  test(`Manage cards reads at the type floors in every state at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const state = await openSynthetic(page);
    const section = width >= 1280 ? 20 : 18;
    // Beside the picker.
    for (const control of [page.getByRole('button', { name: 'Manage cards', exact: true }), page.locator('label.spending-toggle', { hasText: 'Show closed cards (1)' })]) {
      expect(await fontSize(control)).toBeGreaterThanOrEqual(14);
    }
    const manager = await openManager(page);
    expect(await fits(manager)).toBe(true);
    // Oldest activity first, then the card with nothing recorded.
    await expect(manager.locator('[data-card]')).toHaveText([/Type Gold/, /Type Travel/, /Type Spare/]);
    await expect(manager.locator('[data-card="type-citi"]').getByTestId('card-manager-latest')).toHaveText('Nothing recorded');
    expect(await textBelow(manager, 14)).toEqual([]);
    expect(await fontSize(manager.locator('h3'))).toBeGreaterThanOrEqual(section);
    expect(await fontSize(manager.locator('.card-manager-lead'))).toBeGreaterThanOrEqual(16);
    for (const name of await manager.locator('.card-manager-name').all()) expect(await fontSize(name)).toBeGreaterThanOrEqual(16);
    // Fields read at the help size, as every field in Holdr's dialogs (T1's --text-help; sync.css).
    for (const select of await manager.locator('select').all()) expect(await fontSize(select)).toBeGreaterThanOrEqual(14);

    // Filters that match no card.
    await manager.getByRole('combobox', { name: 'Issuer' }).selectOption('chase');
    await manager.getByRole('combobox', { name: 'Person' }).selectOption('alex');
    await expect(manager).toContainText('No cards match these filters.');
    await expect(manager.getByTestId('card-manager-count')).toHaveText('0 of 3 cards, oldest activity first');
    expect(await textBelow(manager, 14)).toEqual([]);
    await manager.getByRole('button', { name: 'Show all cards', exact: true }).click();
    await expect(manager.locator('[data-card]')).toHaveCount(3);

    // A confirmation, and its refusal.
    await manager.getByRole('button', { name: 'Mark closed: Amex Type Gold ··63061 · Alex', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'Mark card closed in Holdr?' });
    expect(await fits(confirm)).toBe(true);
    expect(await textBelow(confirm, 14)).toEqual([]);
    expect(await fontSize(confirm.locator('h3'))).toBeGreaterThanOrEqual(section);
    for (const line of await confirm.locator('.card-manager-confirm-text, .card-manager-confirm-name').all()) {
      expect(await fontSize(line)).toBeGreaterThanOrEqual(16);
    }
    await confirm.getByRole('button', { name: 'Mark closed', exact: true }).click();
    await expect(confirm.getByRole('alert')).toHaveText('Unable to save card status');
    expect(await textBelow(confirm, 14)).toEqual([]);
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.keyboard.press('Escape');

    // A record that could not be read.
    state.failCoverage = true;
    await page.getByRole('button', { name: 'Manage cards', exact: true }).click();
    await expect(manager.getByTestId('card-manager-read-error')).toBeVisible();
    await expect(manager.getByText('Latest record not read').first()).toBeVisible();
    expect(await textBelow(manager, 14)).toEqual([]);
    await page.keyboard.press('Escape');
  });
}

test('Manage cards with no cards says how to add one, at the type floors', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openSynthetic(page, []);
  await page.getByRole('button', { name: 'Manage cards', exact: true }).click();
  const manager = page.getByRole('dialog', { name: 'Manage cards' });
  await expect(manager.getByTestId('card-manager-empty')).toHaveText('No cards yet. Importing a statement adds one.');
  await expect(manager.getByRole('list', { name: 'Cards' })).toHaveCount(0);
  expect(await textBelow(manager, 14)).toEqual([]);
});
