import { expect, requireHealthyApi, test, type APIRequestContext, type Page } from './fixtures';
import { buildCardImportPayload, serializeCardImportPayload, type CardImportDraftRow } from '@finance-tracker/shared';

/**
 * The Spending overview on the live API: one headline, "Spent in <period>", posted after refunds, with whose cards it
 * covers; one comparison, made only when both windows are complete, else "Not comparable" with the reason and both
 * figures labelled (a window with no card data says so, never $0); what is not in the total, a line per kind; where it
 * went (recurring, large one-offs and other spending, each said once); what changed between two complete months, this
 * period against the baseline on every line (one-offs apart, the categories behind the rest, everything else, adding
 * up to the change); the one category view, each category (or merchant) opening in place to its merchants and their
 * charges, the page narrowed only on request; and the one month chart, its scale on the axis, each month's state in
 * words, by type or by person, with the cards missing history folded under their count. A period whose spending is not
 * on record says so in every block, never $0. Synthetic data only (fictional merchants, made-up amounts) on cards of
 * their own; the page clock is fixed on Sep 20, 2024.
 */

const SUFFIX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6) || 'overview';
const NICKNAME = `Overview ${SUFFIX}`;
const LABEL = `Chase ${NICKNAME} ··4141 · Casey`;
const STORES_NICKNAME = `Overview stores ${SUFFIX}`;
const STORES_LABEL = `Chase ${STORES_NICKNAME} ··4242 · Casey`;
const BEHIND_NICKNAME = `Overview behind ${SUFFIX}`;
const BEHIND_LABEL = `Chase ${BEHIND_NICKNAME} ··4343 · Casey`;
const MUTATION_HEADERS = { 'Content-Type': 'application/json', 'X-Holdr-Request': '1' };

function payload(rows: CardImportDraftRow[], coverage: { start: string; end: string }): string {
  return serializeCardImportPayload(buildCardImportPayload({
    source: 'e2e-sync', parserVersion: 'e2e@1', issuer: 'chase', currency: 'USD', coverage, rows,
  }).payload);
}

const streaming = (transactionDate: string): CardImportDraftRow =>
  ({ transactionDate, amountMinor: 1599, kind: 'purchase', description: 'SAMPLE STREAMING', issuerCategory: 'Entertainment' });

// June 1–10, then June 15 – August 31: June 11–14 is a gap, so June is partly covered, and July and August are complete.
const EARLY = payload([
  streaming('2024-06-05'),
  { transactionDate: '2024-06-10', amountMinor: 9000, kind: 'purchase', description: 'NORTHWIND GROCERY', issuerCategory: 'Groceries' },
], { start: '2024-06-01', end: '2024-06-10' });
const LATE = payload([
  streaming('2024-07-05'),
  { transactionDate: '2024-07-16', amountMinor: 12000, kind: 'purchase', description: 'NORTHWIND GROCERY', issuerCategory: 'Groceries' },
  { transactionDate: '2024-07-20', amountMinor: 4000, kind: 'purchase', description: 'PROSEWARE BISTRO', issuerCategory: 'Dining' },
  streaming('2024-08-05'),
  { transactionDate: '2024-08-14', amountMinor: 15000, kind: 'purchase', description: 'NORTHWIND GROCERY', issuerCategory: 'Groceries' },
  { transactionDate: '2024-08-15', amountMinor: 250000, kind: 'purchase', description: 'CONTOSO ELECTRONICS', issuerCategory: 'Electronics' },
  { transactionDate: '2024-08-21', amountMinor: 6000, kind: 'purchase', description: 'PROSEWARE BISTRO', issuerCategory: 'Dining' },
  { transactionDate: '2024-08-25', amountMinor: -50000, kind: 'payment', description: 'AUTOPAY PAYMENT - THANK YOU' },
], { start: '2024-06-15', end: '2024-08-31' });
const SEPTEMBER = payload([
  streaming('2024-09-05'),
  { transactionDate: '2024-09-08', amountMinor: 5000, kind: 'purchase', description: 'NORTHWIND GROCERY', issuerCategory: 'Groceries' },
  { transactionDate: '2024-09-10', amountMinor: 400000, kind: 'purchase', description: 'SAMPLEWAREHOUSE.COM *ONLINE', issuerCategory: 'Wholesale Stores' },
  { transactionDate: '2024-09-12', amountMinor: 3000, kind: 'purchase', description: 'PROSEWARE BISTRO', issuerCategory: 'Dining' },
], { start: '2024-09-01', end: '2024-09-20' });
// Two stores of one grocer: a view of one store keeps to that store all the way down.
const STORES = payload([
  { transactionDate: '2024-09-03', amountMinor: 5000, kind: 'purchase', description: 'NORTHWIND GROCER SEATTLE', issuerCategory: 'Groceries' },
  { transactionDate: '2024-09-04', amountMinor: 7000, kind: 'purchase', description: 'NORTHWIND GROCER PORTLAND', issuerCategory: 'Groceries' },
], { start: '2024-09-01', end: '2024-09-20' });
// Statements only through July: August can't count until a later one is imported, or the card is closed.
const BEHIND = payload([
  { transactionDate: '2024-06-12', amountMinor: 2500, kind: 'purchase', description: 'FABRIKAM BAKERY', issuerCategory: 'Dining' },
  { transactionDate: '2024-07-09', amountMinor: 3000, kind: 'purchase', description: 'FABRIKAM BAKERY', issuerCategory: 'Dining' },
], { start: '2024-06-01', end: '2024-07-31' });
// Recorded for July and August, spent only in July: August is a genuine zero, and June (before any record) is unknown.
const QUIET_NICKNAME = `Overview quiet ${SUFFIX}`;
const QUIET_LABEL = `Chase ${QUIET_NICKNAME} ··4444 · Casey`;
const QUIET = payload([
  { transactionDate: '2024-07-12', amountMinor: 4200, kind: 'purchase', description: 'NORTHWIND GROCERY', issuerCategory: 'Groceries' },
], { start: '2024-07-01', end: '2024-08-31' });
// A row dated after the page's today (Sep 20): "September so far" leaves it out, in the total as in the comparison.
const LATER_NICKNAME = `Overview later ${SUFFIX}`;
const LATER_LABEL = `Chase ${LATER_NICKNAME} ··4545 · Casey`;
const LATER = payload([
  { transactionDate: '2024-09-10', amountMinor: 5000, kind: 'purchase', description: 'NORTHWIND GROCERY', issuerCategory: 'Groceries' },
  { transactionDate: '2024-09-25', amountMinor: 2500, kind: 'purchase', description: 'PROSEWARE BISTRO', issuerCategory: 'Dining' },
], { start: '2024-09-01', end: '2024-09-25' });

// Bought and returned within the month: a category whose charges and credits cancel out, beside one that doesn't.
const ZERO_NICKNAME = `Overview zero ${SUFFIX}`;
const ZERO_LABEL = `Chase ${ZERO_NICKNAME} ··4646 · Casey`;
const ZERO = payload([
  { transactionDate: '2024-09-03', amountMinor: 4500, kind: 'purchase', description: 'LUCERNE OUTFITTERS', issuerCategory: 'Clothing' },
  { transactionDate: '2024-09-09', amountMinor: -4500, kind: 'refund', description: 'LUCERNE OUTFITTERS', issuerCategory: 'Clothing' },
  { transactionDate: '2024-09-11', amountMinor: 2000, kind: 'purchase', description: 'NORTHWIND GROCERY', issuerCategory: 'Groceries' },
], { start: '2024-09-01', end: '2024-09-20' });

// Twenty-seven grills, one charge each, in one category: more merchants than an open category names (8) and than By
// merchant lists (25), so both views have an "N other merchants" row. $100.00 for the first, a dollar less for each next.
const MANY_NICKNAME = `Overview many ${SUFFIX}`;
const MANY_LABEL = `Chase ${MANY_NICKNAME} ··4747 · Casey`;
const GRILLS = ['ALDER', 'ASPEN', 'BIRCH', 'CEDAR', 'CYPRESS', 'HAZEL', 'HOLLY', 'JUNIPER', 'LARCH', 'LAUREL', 'LINDEN', 'MAPLE', 'MYRTLE',
  'OLIVE', 'PINE', 'POPLAR', 'REDWOOD', 'ROWAN', 'SPRUCE', 'SUMAC', 'TAMARACK', 'WALNUT', 'WILLOW', 'ACACIA', 'BAMBOO', 'CHESTNUT', 'MAGNOLIA'];
const MANY = payload(GRILLS.map((tree, index): CardImportDraftRow => ({
  transactionDate: `2024-09-${String(1 + (index % 19)).padStart(2, '0')}`, amountMinor: 10_000 - index * 100, kind: 'purchase',
  description: `${tree} SAMPLE GRILL`, issuerCategory: 'Dining',
})), { start: '2024-09-01', end: '2024-09-20' });

async function createCard(request: APIRequestContext, nickname: string, last4: string, imports: string[]): Promise<string> {
  const created = await request.post('/card-accounts', {
    headers: MUTATION_HEADERS, data: JSON.stringify({ issuer: 'chase', owner: 'casey', nickname, last4, currency: 'USD' }),
  });
  expect(created.status(), await created.text()).toBe(201);
  const id = (await created.json() as { id: string }).id;
  for (const json of imports) {
    const committed = await request.post(`/card-imports/commit?cardAccountId=${id}`, { headers: MUTATION_HEADERS, data: json });
    expect(committed.status(), await committed.text()).toBe(201);
  }
  return id;
}

/** The card whose statements stop in July: closing it in the page is read again by the overview. */
let behindId = '';
/** Every card this file creates, to name in a synthetic list of six cards missing history. */
const cardIds: string[] = [];

async function seed(request: APIRequestContext): Promise<void> {
  const id = await createCard(request, NICKNAME, '4141', [EARLY, LATE, SEPTEMBER]);
  cardIds.push(id);
  // The owner's word: the warehouse-club online order was precious metals, an asset and not spending.
  const listed = await request.get(`/card-transactions?cardAccountId=${id}&from=2024-09-10&to=2024-09-10`);
  const metals = (await listed.json() as { transactions: Array<{ id: string; description: string }> }).transactions
    .find((row) => row.description.startsWith('SAMPLEWAREHOUSE'))!;
  const patched = await request.patch(`/card-transactions/${metals.id}`, { headers: MUTATION_HEADERS, data: JSON.stringify({ userCategory: 'Precious metals' }) });
  expect(patched.status(), await patched.text()).toBe(200);
  cardIds.push(await createCard(request, STORES_NICKNAME, '4242', [STORES]));
  behindId = await createCard(request, BEHIND_NICKNAME, '4343', [BEHIND]);
  cardIds.push(behindId);
  cardIds.push(await createCard(request, QUIET_NICKNAME, '4444', [QUIET]));
  cardIds.push(await createCard(request, LATER_NICKNAME, '4545', [LATER]));
  cardIds.push(await createCard(request, ZERO_NICKNAME, '4646', [ZERO]));
  // Not in `cardIds`: its history is complete, so it is never among the cards missing history.
  await createCard(request, MANY_NICKNAME, '4747', [MANY]);
}

async function openOverview(page: Page, label = LABEL) {
  await page.clock.setFixedTime(new Date('2024-09-20T12:00:00'));
  await page.goto('/');
  await page.getByRole('tab', { name: 'Spending', exact: true }).click();
  await page.getByRole('combobox', { name: 'Card' }).selectOption({ label });
  await expect(page.locator('.spending-month-label')).toHaveText('September 2024');
  const overview = page.getByRole('region', { name: 'Spending overview' });
  await expect(overview).toHaveAttribute('aria-busy', 'false');
  return overview;
}

/** The overview's own reads of a merchant line's rows (every page of 200, spending kinds only). */
const isLineRead = (url: URL) => url.pathname === '/card-transactions' && url.searchParams.get('limit') === '200'
  && url.searchParams.has('offset') && url.searchParams.get('kind') === 'purchase,refund,fee,interest,adjustment';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  await requireHealthyApi(request);
  await seed(request);
});

test.describe('Spending overview (desktop)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('shows one total so far, says why it can\'t be compared with the days before, and what is not in it', async ({ page }) => {
    const overview = await openOverview(page);
    const headline = overview.getByTestId('overview-headline');
    // Posted spending so far; the precious metals are an asset, so not in it. One total: the summary cards are gone.
    await expect(headline.getByTestId('overview-headline-label')).toHaveText('Spent in September so far');
    await expect(overview.getByTestId('overview-total')).toHaveText('$95.99');
    await expect(page.locator('[data-card="spent"] .spending-card-value')).toHaveText('$95.99');
    await expect(page.locator('.spending-cards')).toHaveCount(0);
    await expect(page.locator('[data-card="change"]')).toHaveCount(0);
    // The name already says "so far": not again beside the figure.
    await expect(overview.getByTestId('overview-so-far')).toHaveCount(0);
    await expect(headline.getByTestId('overview-scope')).toHaveText(`Posted, after refunds · ${LABEL}`);
    // Said once, in a line; why is folded under it.
    const note = overview.getByTestId('overview-current-note');
    await expect(note.getByRole('button')).toHaveText('September so far may be incomplete');
    await expect(note.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    await note.getByRole('button').click();
    await expect(note.getByRole('listitem')).toHaveText(['Still going through Sep 20, and recent charges may not have posted yet']);
    // One comparison, never a percentage or "more" or "less": September is still going.
    const compare = headline.getByTestId('overview-compare');
    await expect(compare.getByTestId('overview-not-comparable-reason')).toHaveText('Not comparable: this period is still in progress');
    await expect(compare.locator('.overview-figure')).toHaveText(['September so far$95.99', 'August at this point$2,665.99']);
    await expect(compare).not.toContainText('%');
    await expect(compare.getByTestId('overview-compared')).toHaveCount(0);
    // Nothing more to say about August: no fold for it.
    await expect(compare.getByRole('button', { name: 'Why they can\'t be compared' })).toHaveCount(0);

    // Not in this total: the precious metals, on a line of their own, as What counts says them.
    const out = headline.getByTestId('overview-out');
    await expect(out.getByRole('listitem')).toHaveText(['$4,000.00 precious metals bought · not counted']);
    await expect(out.getByTestId('metals-not-counted')).toHaveText('$4,000.00 precious metals bought · not counted');
    // "What counts as spending" lands on What counts.
    await out.getByRole('button', { name: 'What counts as spending' }).click();
    const counts = page.getByRole('region', { name: 'What counts as spending' });
    await expect(counts).toBeFocused();
    await expect(counts).toBeInViewport();
  });

  test('splits true spend into its parts, and the change only between two complete months', async ({ page }) => {
    const overview = await openOverview(page);
    const where = overview.getByRole('group', { name: 'Where it went' });
    // The three parts, each said once, and no sum written out.
    await expect(where.getByTestId('overview-part-recurring')).toHaveText('Recurring$15.99');
    await expect(where.getByTestId('overview-part-oneOffs')).toHaveText('Large one-offs$0.00');
    await expect(where.getByTestId('overview-part-other')).toHaveText('Other spending$80.00');
    await expect(where).not.toContainText('=');
    await expect(where).not.toContainText(/everyday/i);
    await where.getByTestId('overview-part-recurring').click();
    await expect(where.getByRole('list', { name: 'Recurring charges' })).toContainText('Sample Streaming');
    // September is still going: what changed is not split by category, and both figures are labelled, with why.
    const changed = overview.getByRole('group', { name: 'What changed' });
    const unsplit = changed.getByTestId('overview-changes-not-comparable');
    await expect(unsplit.getByTestId('overview-changes-not-comparable-reason')).toHaveText('Not comparable: this period is still in progress');
    await expect(unsplit.locator('.overview-figure')).toHaveText(['September so far$95.99', 'August at this point$2,665.99']);
    await unsplit.getByRole('button', { name: 'Why they can\'t be compared' }).click();
    await expect(unsplit.getByRole('listitem')).toHaveText(['September so far: still going through Sep 20, and recent charges may not have posted yet']);
    // The two figures and why, and no paragraph after them.
    await expect(changed).not.toContainText('The change is split by category');
    await expect(changed.getByTestId('overview-changes')).toHaveCount(0);

    // August against July, both complete: one sentence, then each line this period against the baseline.
    await page.getByRole('button', { name: 'Previous month' }).click();
    await expect(page.locator('.spending-month-label')).toHaveText('August 2024');
    const compared = overview.getByTestId('overview-compared');
    await expect(compared.getByTestId('overview-compared-text')).toHaveText('$2,550.00 more than July');
    await expect(compared).toHaveAttribute('data-tone', 'more');
    await expect(compared.locator('.overview-figure')).toHaveText(['July$175.99']);
    await expect(overview.getByTestId('overview-headline-label')).toHaveText('Spent in August 2024');
    await expect(overview.getByTestId('overview-so-far')).toHaveCount(0);
    // August's card payment is not in its total: on its own line.
    await expect(overview.getByTestId('overview-out').getByRole('listitem')).toHaveText(['$500.00 card payments · 1 transfer, not spending']);
    await expect(changed.getByTestId('overview-changes-head')).toHaveText('August 2024 vs July');
    const lines = changed.getByTestId('overview-changes').getByRole('listitem');
    await expect(lines).toHaveCount(4);
    await expect(lines.nth(0)).toContainText('Large one-offs');
    await expect(lines.nth(0)).toContainText('$2,500.00 vs $0.00');
    await expect(lines.nth(0)).toContainText('+$2,500.00');
    await expect(lines.nth(1)).toHaveAccessibleName('Groceries: $30.00 more than July, mostly Northwind Grocery ($30.00 more)');
    await expect(lines.nth(1)).toContainText('$150.00 vs $120.00');
    await expect(lines.nth(1)).toContainText('+$30.00');
    await expect(lines.nth(2)).toHaveAccessibleName('Dining: $20.00 more than July, mostly Proseware Bistro ($20.00 more)');
    await expect(lines.nth(2)).toContainText('$60.00 vs $40.00');
    // Nothing else changed, in no other category: no line for it.
    await expect(changed.getByTestId('overview-changes')).not.toContainText('Everything else');
    await expect(lines.nth(3)).toContainText('Total change');
    await expect(lines.nth(3)).toContainText('$2,725.99 vs $175.99');
    await expect(changed.getByTestId('overview-change-total')).toHaveText('+$2,550.00');

    // Against August last year, before the card was first seen: no card data then, never $0 and never "no spending".
    await changed.getByRole('button', { name: 'vs August 2023' }).click();
    await expect(changed.getByRole('button', { name: 'vs August 2023' })).toHaveAttribute('aria-pressed', 'true');
    const lastYear = changed.getByTestId('overview-changes-not-comparable');
    await expect(lastYear.getByTestId('overview-changes-not-comparable-reason')).toHaveText('Not comparable: no card data for August 2023');
    await expect(lastYear.locator('.overview-figure')).toHaveText(['August 2024$2,725.99', 'August 2023No card data']);
    await expect(lastYear).not.toContainText('$0.00');
    await expect(lastYear).not.toContainText(/no spending/i);
    await expect(changed.getByTestId('overview-changes')).toHaveCount(0);
  });

  test('opens a category in place to its merchants and their charges, each adding up to the one above, and narrows the page only on request', async ({ page }) => {
    const overview = await openOverview(page);
    const view = overview.getByRole('group', { name: 'Categories' });
    const rows = view.getByTestId('overview-categories').getByRole('listitem');
    // A row is the name, the net amount and the charges; the total under them.
    await expect(rows).toHaveCount(4);
    const groceries = rows.nth(0).locator(':scope > .overview-row');
    await expect(groceries).toHaveText('Groceries1 charge$50.00');
    await expect(rows.nth(3)).toHaveText('Total$95.99');
    await expect(groceries).toHaveAttribute('aria-expanded', 'false');
    await groceries.click();
    await expect(groceries).toHaveAttribute('aria-expanded', 'true');
    // Open, the row stays as it was; under it, the way to narrow the page, and its merchants.
    await expect(groceries).toHaveText('Groceries1 charge$50.00');
    const detail = view.getByTestId('overview-category-detail');
    await expect(detail.getByRole('button', { name: 'Filter this spending view' })).toBeVisible();
    await expect(detail).toContainText('Updates total and transactions');
    // No Amazon items here: nothing is said about them.
    await expect(detail.getByTestId('overview-item-contribution')).toHaveCount(0);
    const merchants = detail.getByTestId('overview-merchants').getByRole('listitem');
    await expect(merchants).toHaveCount(1);
    await expect(merchants.nth(0)).toContainText('Northwind Grocery');
    await expect(merchants.nth(0)).toContainText('$50.00');
    await merchants.nth(0).locator(':scope > .overview-row').click();
    const transactions = detail.getByTestId('overview-transactions');
    await expect(transactions.getByTestId('overview-line-total')).toHaveText('$50.00');
    await expect(transactions).toContainText('1 charge');
    await expect(transactions).toContainText('adds up to the line');
    await transactions.getByRole('button', { name: /Northwind Grocery/ }).click();
    await expect(page.getByRole('dialog', { name: 'NORTHWIND GROCERY' })).toBeVisible();
    await page.keyboard.press('Escape');
    // Opening changed nothing else: the total is the period's, and no filter is in use.
    await expect(overview.getByTestId('overview-total')).toHaveText('$95.99');
    await expect(page.getByRole('group', { name: 'Active filters' })).toHaveCount(0);

    // Narrowing is its own step: the total and the transactions follow it.
    await detail.getByRole('button', { name: 'Filter this spending view' }).click();
    await expect(page.getByRole('group', { name: 'Active filters' })).toContainText('Category: Groceries');
    await expect(overview.getByTestId('overview-total')).toHaveText('$50.00');
    await expect(page.getByRole('region', { name: 'Card transactions' }).locator('.spending-row-merchant')).toHaveText(['NORTHWIND GROCERY']);
    await expect(rows).toHaveCount(2);
    await rows.nth(0).locator(':scope > .overview-row').click();
    await expect(detail.getByRole('button', { name: 'Filter this spending view' })).toHaveCount(0);
    await expect(detail).toContainText('This spending view is filtered to it');
    await page.getByRole('button', { name: 'Clear Category: Groceries' }).click();
    await expect(overview.getByTestId('overview-total')).toHaveText('$95.99');
    // Closed again, its detail goes.
    await expect(rows).toHaveCount(4);
    await expect(view.getByTestId('overview-category-detail')).toHaveCount(0);
  });

  test('reads a line again after it failed: the new read clears the error, and its rows show', async ({ page }) => {
    const overview = await openOverview(page);
    let failing = true;
    await page.route(isLineRead, (route) => (failing
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'synthetic line failure' }) })
      : route.continue()));
    const view = overview.getByRole('group', { name: 'Categories' });
    await view.getByTestId('overview-categories').getByRole('button', { name: /^Groceries/ }).click();
    const detail = view.getByTestId('overview-category-detail');
    const line = detail.getByTestId('overview-merchants').getByRole('listitem').nth(0).locator(':scope > .overview-row');
    await line.click();
    await expect(detail.getByRole('status')).toHaveText('synthetic line failure');
    // The list answers again: the line closed and opened once more.
    failing = false;
    await line.click();
    await expect(line).toHaveAttribute('aria-expanded', 'false');
    await line.click();
    const transactions = detail.getByTestId('overview-transactions');
    await expect(transactions.getByTestId('overview-line-total')).toHaveText('$50.00');
    await expect(transactions).toContainText('adds up to the line');
    await expect(detail.getByRole('status')).toHaveCount(0);
  });

  test('keeps a view of one store to that store, down to its transactions', async ({ page }) => {
    const overview = await openOverview(page, STORES_LABEL);
    await expect(overview.getByTestId('overview-total')).toHaveText('$120.00');
    // By merchant: each store of the grocer is a row of its own; one opens to its charges, adding up to it.
    const view = overview.locator('.overview-categories');
    await view.getByRole('button', { name: 'By merchant' }).click();
    await expect(view.getByRole('heading', { name: 'Merchants' })).toBeVisible();
    const stores = view.getByTestId('overview-merchant-rows');
    await expect(stores.getByRole('button', { name: /Northwind Grocer Portland/ })).toHaveText('Northwind Grocer Portland1 charge$70.00');
    await stores.getByRole('button', { name: /Northwind Grocer Seattle/ }).click();
    const store = view.getByTestId('overview-merchant-detail');
    await expect(store.getByTestId('overview-line-total')).toHaveText('$50.00');
    await expect(store).toContainText('adds up to the line');
    // Then the page narrowed to it: the overview is that store's, and so is its category view.
    await store.getByRole('button', { name: 'Filter this spending view' }).click();
    await expect(overview.getByTestId('overview-total')).toHaveText('$50.00');
    await view.getByRole('button', { name: 'By category' }).click();
    await view.getByTestId('overview-categories').getByRole('button', { name: /^Groceries/ }).click();
    const merchants = view.getByTestId('overview-merchants').getByRole('listitem');
    await expect(merchants).toHaveCount(1);
    await expect(merchants.nth(0)).toContainText('$50.00');
    await merchants.nth(0).getByRole('button').click();
    const transactions = view.getByTestId('overview-transactions');
    await expect(transactions.getByTestId('overview-line-total')).toHaveText('$50.00');
    await expect(transactions).toContainText('1 charge');
    await expect(transactions).toContainText('adds up to the line');
    await expect(transactions.getByRole('button', { name: /Portland/i })).toHaveCount(0);
  });

  test('opens "N other merchants" in place, in both views: every merchant behind it and its charges, adding up to the row', async ({ page }) => {
    const overview = await openOverview(page, MANY_LABEL);
    await expect(overview.getByTestId('overview-total')).toHaveText('$2,349.00');
    const view = overview.getByRole('group', { name: 'Categories' });
    await view.getByTestId('overview-categories').getByRole('button', { name: /^Dining/ }).click();
    const detail = view.getByTestId('overview-category-detail');
    // Eight lines named, then the rest in one row that opens like they do.
    const lines = detail.getByTestId('overview-merchants').locator(':scope > li > .overview-row');
    await expect(lines).toHaveCount(9);
    const others = lines.last();
    await expect(others).toHaveText('19 other merchants19 charges$1,577.00');
    await expect(others).toHaveAttribute('aria-expanded', 'false');
    await others.click();
    await expect(others).toHaveAttribute('aria-expanded', 'true');
    // Every merchant behind it, largest first, and how they add up to the row.
    const behind = detail.getByTestId('overview-other-merchants');
    const rows = behind.locator(':scope > li > .overview-row');
    await expect(rows).toHaveCount(19);
    await expect(rows.first()).toHaveText('Larch Sample Grill1 charge$92.00');
    await expect(rows.last()).toHaveText('Magnolia Sample Grill1 charge$74.00');
    await expect(behind.getByTestId('overview-others-tie')).toContainText('19 merchants · 19 charges');
    await expect(behind.getByTestId('overview-others-tie')).toContainText('adds up to the line');
    await expect(behind.getByTestId('overview-others-total')).toHaveText('$1,577.00');
    // One of them opens to its charge, and the charge to its details.
    await rows.last().click();
    await expect(rows.last()).toHaveAttribute('aria-expanded', 'true');
    const charges = behind.getByTestId('overview-transactions');
    await expect(charges.getByTestId('overview-line-total')).toHaveText('$74.00');
    await expect(charges).toContainText('adds up to the line');
    await charges.getByRole('button', { name: /Magnolia Sample Grill/ }).click();
    await expect(page.getByRole('dialog', { name: 'MAGNOLIA SAMPLE GRILL' })).toBeVisible();
    await page.keyboard.press('Escape');
    // A named line opens in its place, as one line does in another's.
    await lines.first().click();
    await expect(lines.first()).toHaveAttribute('aria-expanded', 'true');
    await expect(others).toHaveAttribute('aria-expanded', 'false');
    await expect(detail.getByTestId('overview-other-merchants')).toHaveCount(0);

    // By merchant: twenty-five named, the other two behind one row, each opening as a named merchant does.
    const block = overview.locator('.overview-categories');
    await block.getByRole('button', { name: 'By merchant' }).click();
    await expect(block.getByRole('heading', { name: 'Merchants' })).toBeVisible();
    const merchants = block.getByTestId('overview-merchant-rows').locator(':scope > li > .overview-row');
    await expect(merchants).toHaveCount(26);
    const rest = merchants.last();
    await expect(rest).toHaveText('2 other merchants2 charges$149.00');
    await rest.click();
    await expect(rest).toHaveAttribute('aria-expanded', 'true');
    const restDetail = block.getByTestId('overview-other-merchants-detail');
    const restRows = restDetail.getByTestId('overview-other-merchants').locator(':scope > li > .overview-row');
    await expect(restRows).toHaveText(['Chestnut Sample Grill1 charge$75.00', 'Magnolia Sample Grill1 charge$74.00']);
    await expect(restDetail.getByTestId('overview-others-tie')).toContainText('2 merchants · 2 charges');
    await expect(restDetail.getByTestId('overview-others-tie')).toContainText('adds up to the line');
    await expect(restDetail.getByTestId('overview-others-total')).toHaveText('$149.00');
    await restRows.first().click();
    const chestnut = restDetail.getByTestId('overview-other-merchant-detail');
    await expect(chestnut.getByTestId('overview-line-total')).toHaveText('$75.00');
    // Narrowing the page to it is its own step, as for a named merchant.
    await expect(overview.getByTestId('overview-total')).toHaveText('$2,349.00');
    await chestnut.getByRole('button', { name: 'Filter this spending view' }).click();
    await expect(page.getByRole('button', { name: 'Clear Merchant: Chestnut Sample Grill' })).toBeVisible();
    await expect(overview.getByTestId('overview-total')).toHaveText('$75.00');
    // A new view starts the category view afresh, by category, as after a named merchant's narrowing.
    await block.getByRole('button', { name: 'By merchant' }).click();
    await expect(block.getByTestId('overview-merchant-rows').locator(':scope > li > .overview-row')).toHaveText(['Chestnut Sample Grill1 charge$75.00']);
  });

  test('marks a partly covered month in the months and says why, and a month opens with its own split', async ({ page }) => {
    const overview = await openOverview(page);
    const months = overview.getByRole('group', { name: 'Months' });
    await expect(months.locator('.overview-month')).toHaveCount(12);
    await expect(months.locator('[data-month="2024-06"]')).toHaveAttribute('data-partial', 'true');
    await expect(months.locator('[data-month="2024-07"]')).toHaveAttribute('data-partial', 'false');
    await expect(months.locator('[data-month="2024-08"]')).toHaveAttribute('data-partial', 'false');
    await expect(months.locator('[data-month="2024-09"]')).toHaveClass(/in-progress/);
    // Its amount and month first (contract C-4), then its state in words, its parts and what is known of its record.
    await expect(months.locator('[data-month="2024-06"]')).toHaveAccessibleName(
      '$105.99 in June 2024 (incomplete): recurring $15.99, large one-offs $0.00, other spending $90.00; data from 1 of 1 cards; '
      + 'partial: 0 of 1 cards with recorded dates, so this month may be missing spending; it is not lower spending',
    );
    await expect(months.locator('[data-month="2024-07"]')).toHaveAccessibleName(
      '$175.99 in July 2024: recurring $15.99, large one-offs $0.00, other spending $160.00; data from 1 of 1 cards; every card\'s dates recorded (1 card)',
    );
    // Before the card first appears, the record may not reach back: those months are marked too, never shown as lower.
    await expect(months.locator('[data-month="2024-05"]')).toHaveAttribute('data-partial', 'true');
    await expect(months.locator('[data-month="2024-05"]')).toHaveAccessibleName(
      '$0.00 in May 2024 (incomplete): recurring $0.00, large one-offs $0.00, other spending $0.00; data from 0 of 0 cards; '
      + 'partial: 1 card in view has no data this early, so this month may be missing spending; it is not lower spending',
    );
    // Each month's state is said on it in words (the hatching only repeats it), and the scale is on the axis.
    await expect(months.locator('[data-month="2024-06"] .overview-month-state')).toHaveText('Incomplete');
    await expect(months.locator('[data-month="2024-09"] .overview-month-state')).toHaveText('Month in progress');
    await expect(months.locator('[data-month="2024-07"] .overview-month-state')).toHaveCount(0);
    await expect(months.locator('.overview-axis-tick')).toHaveText(['$3K', '$1.5K', '$0']);
    await expect(months).not.toContainText('Scale to');
    await expect(months).toContainText('Incomplete months may be missing spending');
    // Which cards keep months from counting, folded under how many; none is behind, so none to mark closed.
    const missing = months.getByRole('button', { name: 'Missing history (1 card)' });
    await expect(missing).toHaveAttribute('aria-expanded', 'false');
    await expect(months.getByTestId('overview-gaps')).toHaveCount(0);
    await missing.click();
    await expect(months.getByTestId('overview-gaps').getByRole('listitem'))
      .toHaveText(['1 card in view was first seen after October 2023, on Jun 1, 2024, so earlier months can\'t count']);
    await expect(months.getByRole('button', { name: 'Mark closed cards' })).toHaveCount(0);

    // July against a partly covered June: not comparable, June named as the reason, both figures labelled, and why.
    await months.locator('[data-month="2024-07"]').click();
    await expect(page.locator('.spending-month-label')).toHaveText('July 2024');
    const previous = overview.getByTestId('overview-not-comparable');
    await expect(previous.getByTestId('overview-not-comparable-reason')).toHaveText('Not comparable: June may be incomplete');
    await expect(previous.locator('.overview-figure')).toHaveText(['July 2024$175.99', 'June$105.99']);
    await previous.getByRole('button', { name: 'Why they can\'t be compared' }).click();
    await expect(previous.getByRole('listitem')).toHaveText(['June: 1 of 1 card has no recorded dates for all of it']);
    await expect(overview.getByTestId('overview-compared')).toHaveCount(0);
    await expect(overview.getByRole('group', { name: 'What changed' }).getByTestId('overview-changes')).toHaveCount(0);

    await page.getByRole('button', { name: 'Next month' }).click();
    await expect(page.locator('.spending-month-label')).toHaveText('August 2024');
    await expect(overview.getByTestId('overview-total')).toHaveText('$2,725.99');
    await expect(overview.getByTestId('overview-compared-text')).toHaveText('$2,550.00 more than July');
    const where = overview.getByRole('group', { name: 'Where it went' });
    await expect(where.getByTestId('overview-part-oneOffs')).toHaveText('Large one-offs$2,500.00');
    await expect(where.getByTestId('overview-part-other')).toHaveText('Other spending$210.00');
    await where.getByTestId('overview-part-oneOffs').click();
    const oneOffs = where.getByTestId('overview-one-offs');
    await expect(oneOffs).toContainText('Contoso Electronics');
    await expect(oneOffs).toContainText('purchases of $2,500.00 or more, not at a recurring merchant');
    await oneOffs.getByRole('button', { name: 'Contoso Electronics' }).click();
    await expect(page.getByRole('dialog', { name: 'CONTOSO ELECTRONICS' })).toBeVisible();
  });

  test('names the card whose statements stop early under Missing history, says what would let them count, and opens Manage cards', async ({ page }) => {
    const overview = await openOverview(page, BEHIND_LABEL);
    const months = overview.getByRole('group', { name: 'Months' });
    // One card, behind and first seen later: counted once.
    await months.getByRole('button', { name: 'Missing history (1 card)' }).click();
    await expect(months.getByTestId('overview-gaps').getByRole('listitem')).toHaveText([
      `No statements imported after Jul 31, 2024 for ${BEHIND_LABEL}`,
      '1 card in view was first seen after October 2023, on Jun 1, 2024, so earlier months can\'t count',
      'To count those months, import recent statements, or mark cards no longer used as closed',
    ]);
    // The way to mark closed cards opens Manage cards, with focus in it (contract C-2).
    await months.getByRole('button', { name: 'Mark closed cards' }).click();
    await expect(page.getByRole('dialog', { name: 'Manage cards' })).toBeFocused();
  });

  test('reads the overview again when a card is marked closed in the page, and every total and count stays as it was', async ({ page, request }) => {
    const dates = `cardAccountId=${behindId}&from=2024-06-01&to=2024-09-30`;
    const ledger = async () => {
      const summary = await (await request.get(`/spending/summary?${dates}`)).json() as { totals: unknown; pending: unknown };
      const list = await (await request.get(`/card-transactions?${dates}&status=posted&limit=200`)).json() as {
        total: number; transactions: Array<{ id: string; amountMinor: number; transactionDate: string }>;
      };
      return { totals: summary.totals, pending: summary.pending, total: list.total, rows: list.transactions.map((row) => [row.id, row.amountMinor, row.transactionDate]) };
    };
    const before = await ledger();
    expect(before.total).toBe(2);
    const overview = await openOverview(page, BEHIND_LABEL);
    const months = overview.getByRole('group', { name: 'Months' });
    const gaps = months.getByTestId('overview-gaps');
    const behind = `No statements imported after Jul 31, 2024 for ${BEHIND_LABEL}`;
    // The cards missing history are folded under their count: opened, and it stays open while the months are read again.
    await months.getByRole('button', { name: 'Missing history (1 card)' }).click();
    await expect(gaps).toContainText(behind);
    await expect(months.locator('[data-month="2024-08"]')).toHaveAttribute('data-partial', 'true');
    const july = await months.locator('[data-month="2024-07"]').getAttribute('aria-label');
    expect(july).toContain('$30.00 in July 2024');

    // The owner's word, in the page: the card is closed in Holdr, and the overview reads its months again.
    await page.getByRole('button', { name: 'Manage cards', exact: true }).click();
    await page.getByRole('dialog', { name: 'Manage cards' }).getByRole('button', { name: `Mark closed: ${BEHIND_LABEL}`, exact: true }).click();
    await page.getByRole('dialog', { name: 'Mark card closed in Holdr?' }).getByRole('button', { name: 'Mark closed', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Mark card closed in Holdr?' })).toHaveCount(0);
    await page.getByRole('dialog', { name: 'Manage cards' }).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(months.locator('[data-month="2024-08"]')).toHaveAttribute('data-partial', 'false');
    await expect(gaps.getByRole('listitem')).toHaveText(['1 card in view was first seen after October 2023, on Jun 1, 2024, so earlier months can\'t count']);
    // Its months' figures and the ledger are as they were: closing changes what is expected, never a total or a count.
    await expect(months.locator('[data-month="2024-07"]')).toHaveAttribute('aria-label', july!);
    expect(await ledger()).toEqual(before);

    // Opened again: later history is expected again, and the overview says so.
    await page.getByRole('button', { name: 'Manage cards', exact: true }).click();
    await page.getByRole('dialog', { name: 'Manage cards' }).getByRole('button', { name: `Reopen: ${BEHIND_LABEL}`, exact: true }).click();
    await page.getByRole('dialog', { name: 'Reopen card in Holdr?' }).getByRole('button', { name: 'Reopen card', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Reopen card in Holdr?' })).toHaveCount(0);
    await page.getByRole('dialog', { name: 'Manage cards' }).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(gaps).toContainText(behind);
    await expect(months.locator('[data-month="2024-08"]')).toHaveAttribute('data-partial', 'true');
    expect(await ledger()).toEqual(before);
  });

  test('says $0 only for a month its record covers, and what is missing for one with no record, in every block', async ({ page }) => {
    const overview = await openOverview(page, QUIET_LABEL);
    const where = overview.getByRole('group', { name: 'Where it went' });
    const categories = overview.getByRole('group', { name: 'Categories' });
    // September: the card is there but nothing is imported for it yet, so not known, never $0: not in the total, nor
    // in its parts or categories, which say the same instead.
    await expect(overview.getByTestId('overview-total')).toHaveText('Not recorded');
    await expect(overview.getByTestId('overview-not-comparable-reason')).toHaveText('Not comparable: no record for September so far');
    await expect(where.getByTestId('overview-parts-unknown')).toHaveText('Not recorded: no posted spending on record for September so far');
    await expect(categories.getByTestId('overview-categories-unknown')).toHaveText('Not recorded: no posted spending on record for September so far');
    for (const block of [where, categories]) await expect(block).not.toContainText('$0.00');
    await expect(where.locator('.overview-part')).toHaveCount(0);
    await expect(categories.getByTestId('overview-categories')).toHaveCount(0);
    // August: every day recorded and nothing spent, a genuine zero; July had spending, so the two are not compared.
    await page.getByRole('button', { name: 'Previous month' }).click();
    await expect(page.locator('.spending-month-label')).toHaveText('August 2024');
    await expect(overview.getByTestId('overview-total')).toHaveText('$0.00');
    const august = overview.getByTestId('overview-not-comparable');
    await expect(august.getByTestId('overview-not-comparable-reason')).toHaveText('Not comparable: the two periods have data from different numbers of cards');
    await expect(august.locator('.overview-figure')).toHaveText(['August 2024$0.00', 'July$42.00']);
    // A genuine zero is said as one, in its parts too.
    await expect(where.getByTestId('overview-part-other')).toHaveText('Other spending$0.00');
    await expect(categories).toContainText('No posted spending in August 2024');
    await expect(where.getByTestId('overview-parts-unknown')).toHaveCount(0);
    // June and May, before the card's record begins: unknown, both, in every block.
    await page.getByRole('button', { name: 'Previous month' }).click();
    await page.getByRole('button', { name: 'Previous month' }).click();
    await expect(page.locator('.spending-month-label')).toHaveText('June 2024');
    await expect(overview.getByTestId('overview-total')).toHaveText('No card data');
    const june = overview.getByTestId('overview-not-comparable');
    await expect(june.getByTestId('overview-not-comparable-reason')).toHaveText('Not comparable: no card data for May');
    await expect(june.locator('.overview-figure')).toHaveText(['June 2024No card data', 'MayNo card data']);
    await expect(where.getByTestId('overview-parts-unknown')).toHaveText('No card data for June 2024');
    await expect(categories.getByTestId('overview-categories-unknown')).toHaveText('No card data for June 2024');
    for (const block of [overview.getByTestId('overview-headline'), where, categories]) await expect(block).not.toContainText('$0.00');
  });

  test('reads a category whose charges and credits cancel out as Net $0.00, with its charges a click away', async ({ page }) => {
    const overview = await openOverview(page, ZERO_LABEL);
    await expect(overview.getByTestId('overview-total')).toHaveText('$20.00');
    const view = overview.getByRole('group', { name: 'Categories' });
    const rows = view.getByTestId('overview-categories').getByRole('listitem');
    // Activity, not an empty row: its net and its charges, never a bare $0.00 and never left out.
    await expect(rows).toHaveCount(3);
    const clothing = rows.nth(1).locator(':scope > .overview-row');
    await expect(clothing).toHaveText('Clothing2 chargesNet $0.00');
    await clothing.click();
    await expect(clothing).toHaveText('Clothing2 chargesNet $0.00');
    const detail = view.getByTestId('overview-category-detail');
    const line = detail.getByTestId('overview-merchants').locator('li > .overview-row', { hasText: 'Lucerne Outfitters' });
    await expect(line).toHaveText('Lucerne Outfitters2 chargesNet $0.00');
    await line.click();
    const charges = detail.getByTestId('overview-transactions');
    await expect(charges.locator('li:not(.overview-list-total)')).toHaveCount(2);
    await expect(charges.getByTestId('overview-line-total')).toHaveText('$0.00');
    await expect(charges).toContainText('2 charges');
    await expect(charges).toContainText('adds up to the line');
  });

  test('works the category and month toggles and a row from the keyboard', async ({ page }) => {
    const overview = await openOverview(page);
    const view = overview.locator('.overview-categories');
    const byMerchant = view.getByRole('button', { name: 'By merchant' });
    await byMerchant.focus();
    await page.keyboard.press('Enter');
    await expect(byMerchant).toHaveAttribute('aria-pressed', 'true');
    await expect(view.getByRole('heading', { name: 'Merchants' })).toBeVisible();
    const byCategory = view.getByRole('button', { name: 'By category' });
    await byCategory.focus();
    await page.keyboard.press('Space');
    await expect(byCategory).toHaveAttribute('aria-pressed', 'true');
    await expect(view.getByRole('heading', { name: 'Categories' })).toBeVisible();
    // A row opens and closes from the keyboard.
    const groceries = view.getByTestId('overview-categories').getByRole('button', { name: /^Groceries/ });
    await groceries.focus();
    await page.keyboard.press('Enter');
    await expect(groceries).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Enter');
    await expect(groceries).toHaveAttribute('aria-expanded', 'false');
    // The months by person and back: by type, each month's name starts with its amount and month (contract C-4).
    const months = overview.getByRole('group', { name: 'Months' });
    const byPerson = months.getByRole('button', { name: 'By person' });
    await byPerson.focus();
    await page.keyboard.press('Enter');
    await expect(byPerson).toHaveAttribute('aria-pressed', 'true');
    await expect(months.locator('[data-month="2024-09"]'))
      .toHaveAccessibleName(/^\$95\.99 in September 2024 \(month in progress\): Alex \$0\.00, Casey \$95\.99, Joint \$0\.00$/);
    await expect(months.locator('.overview-legend')).toHaveText('WeicaseyJoint');
    const byType = months.getByRole('button', { name: 'By type' });
    await byType.focus();
    await page.keyboard.press('Space');
    await expect(byType).toHaveAttribute('aria-pressed', 'true');
    await expect(months.locator('[data-month="2024-09"]')).toHaveAccessibleName(/^\$95\.99 in September 2024 \(month in progress\): recurring /);
    await expect(months.locator('.overview-legend')).toHaveText('Other spendingRecurringLarge one-offs');
  });
  test('counts "so far" to today in the total as in its comparison, whatever is dated later in the month', async ({ page }) => {
    const overview = await openOverview(page, LATER_LABEL);
    await expect(overview.getByTestId('overview-headline-label')).toHaveText('Spent in September so far');
    // The $25.00 dated Sep 25 is after today: in neither the total nor the comparison's own figure.
    await expect(overview.getByTestId('overview-total')).toHaveText('$50.00');
    await expect(overview.getByTestId('overview-not-comparable').locator('[data-figure="current"]')).toHaveText('September so far$50.00');
  });

  test('says when the total\'s own read fails, beside a comparison that answered, and reads it again later', async ({ page }) => {
    // Only the period's own summary (to today) is refused; the comparison and the list's month still answer.
    const isPeriodSummary = (url: URL) => url.pathname === '/spending/summary'
      && url.searchParams.get('from') === '2024-09-01' && url.searchParams.get('to') === '2024-09-20';
    await page.route(isPeriodSummary, (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'synthetic totals refusal' }) }));
    const overview = await openOverview(page);
    const headline = overview.getByTestId('overview-headline');
    await expect(headline.getByTestId('overview-totals-error')).toHaveText('Couldn\'t read this total: synthetic totals refusal');
    await expect(headline.getByTestId('overview-totals-error')).toHaveAttribute('role', 'status');
    await expect(headline.getByTestId('overview-total')).toHaveText('—');
    await expect(headline.locator('[data-figure="current"]')).toHaveText('September so far$95.99');
    // Beside a total that couldn't be read, no parts and no categories: why, instead.
    const where = overview.getByRole('group', { name: 'Where it went' });
    await expect(where.getByTestId('overview-parts-unknown')).toHaveText('Not shown: the total for September so far couldn\'t be read');
    await expect(where.locator('.overview-part')).toHaveCount(0);
    await expect(overview.getByTestId('overview-categories-unknown')).toHaveText('Not shown: the total for September so far couldn\'t be read');
    await expect(overview.getByTestId('overview-categories')).toHaveCount(0);
    // Another view, then back: read again, and the refusal is gone with its answer.
    await page.unroute(isPeriodSummary);
    await page.getByRole('button', { name: 'Previous month' }).click();
    await expect(overview.getByTestId('overview-total')).toHaveText('$2,725.99');
    await page.getByRole('button', { name: 'Next month' }).click();
    await expect(overview.getByTestId('overview-total')).toHaveText('$95.99');
    await expect(headline.getByTestId('overview-totals-error')).toHaveCount(0);
    await expect(where.locator('.overview-part')).toHaveCount(3);
    await expect(overview.getByTestId('overview-categories-unknown')).toHaveCount(0);
  });

  test('never shows a previous view\'s figures or errors under a new view, nor an old error after a good read', async ({ page }) => {
    const overview = await openOverview(page);
    await expect(overview.getByTestId('overview-total')).toHaveText('$95.99');
    // The next view's figures are slow, then its comparison fails: September's total must not stand as August's meanwhile.
    let releaseSummary: () => void = () => {};
    const summaryHeld = new Promise<void>((resolve) => { releaseSummary = resolve; });
    const isAugustSummary = (url: URL) => url.pathname === '/spending/summary' && url.searchParams.get('from') === '2024-08-01';
    await page.route(isAugustSummary, async (route) => { await summaryHeld; await route.continue(); });
    const isCompare = (url: URL) => url.pathname === '/spending/compare';
    await page.route(isCompare, (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'synthetic failure' }) }));
    await page.getByRole('button', { name: 'Previous month' }).click();
    await expect(page.locator('.spending-month-label')).toHaveText('August 2024');
    await expect(overview.getByTestId('overview-headline-label')).toHaveText('Spent in August 2024');
    // August's total is still being read: a spinner in its place, never September's figure (nor "—", which says unknown).
    await expect(overview.getByTestId('overview-total-reading')).toBeVisible();
    await expect(overview.getByTestId('overview-total')).toHaveCount(0);
    await expect(overview.getByRole('status')).toContainText('synthetic failure');
    releaseSummary();
    await page.unroute(isAugustSummary);
    // August's own total, from its own summary; nothing compared, and no part of the overview from September.
    await expect(overview.getByTestId('overview-total')).toHaveText('$2,725.99');
    await expect(overview.getByTestId('overview-compared')).toHaveCount(0);
    await expect(overview.getByTestId('overview-not-comparable')).toHaveCount(0);
    await expect(overview.getByRole('group', { name: 'Where it went' })).toHaveCount(0);
    // Back to a view that answers: its own figures, read again.
    await page.unroute(isCompare);
    await page.getByRole('button', { name: 'Next month' }).click();
    await expect(overview.getByTestId('overview-total')).toHaveText('$95.99');
    await expect(overview.getByTestId('overview-not-comparable-reason')).toHaveText('Not comparable: this period is still in progress');
    // And back to the month that failed: read again, with no earlier error left beside its figures.
    await page.getByRole('button', { name: 'Previous month' }).click();
    await expect(overview.getByTestId('overview-total')).toHaveText('$2,725.99');
    await expect(overview.getByTestId('overview-compared-text')).toHaveText('$2,550.00 more than July');
    await expect(overview.getByRole('status')).toHaveCount(0);
  });
});

/**
 * The reading floors (plan D1) in the overview's own CSS: every text of the headline, its comparison and what is not in
 * the total, where it went and what changed, the category view (open, by merchant, a line's charges), the months (by
 * type or person, their states, missing history open), the scope lines and the folded imported dates,
 * by its computed size: 16px for rows, figures and sentences, 14px for the rest (help, labels, status, chips, the
 * months' names), and section heads 18px (20px from 1280px); and by its line height: 1.5 for running text that can wrap
 * (reading text, help, notes, status and warnings), 1.25 for headings and single-line controls. The card opening months
 * panel is another session's CSS, and is left out.
 */
async function sizeProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const roots = ['[data-testid="overview-headline"]', '[data-testid="overview-breakdown"]', '.overview-panel', '.overview-scope-line',
      '.spending-coverage', '.spending-active-filters'].flatMap((selector) => [...document.querySelectorAll<HTMLElement>(selector)]);
    const wide = window.innerWidth >= 1280;
    const floorOf = (element: Element): number => {
      if (element.closest('.overview-headline-label, .overview-block h3')) return wide ? 20 : 18;
      // Help, status and controls (a category's own narrowing button included): 14px.
      if (element.closest('.spending-muted, .overview-out-note, .overview-help, .overview-scope, .overview-error, .fold-toggle, .overview-note-reasons, '
        + '.overview-filter')) return 14;
      if (element.closest('.overview-row, .overview-list > li, .overview-changes > li, .overview-out-row, .overview-figure, '
        + '.overview-compared-text, .overview-not-comparable-reason, .overview-part, .overview-jump, .overview-unknown, .overview-items')) return 16;
      return 14;
    };
    // Running text that can wrap; everything else here is a heading or a one-line control.
    const RUNNING = ['.overview-scope', '.overview-help', '.overview-scope-line', '.overview-waiting', '.overview-other-currencies',
      '.overview-note-reasons', '.overview-note-fold', '.overview-why', '.overview-opened-note', '.overview-error', '.overview-compared-text',
      '.overview-not-comparable-reason', '.overview-figure', '.overview-out-row', '.overview-row', '.overview-list > li',
      '.overview-changes > li', '.overview-chart-note', '.overview-gaps', '.overview-opened', '.spending-coverage-row', '.overview-jump',
      '.overview-link', '.overview-unknown', '.overview-changes-head', '.overview-items', '.overview-filter', '.overview-amazon-coverage p',
      '.overview-month-state', '.overview-month-states'].join(', ');
    const problems: string[] = [];
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent?.trim();
        const element = node.parentElement;
        if (!text || !element || element.closest('[aria-label="When your cards were opened"]')) continue;
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        const style = getComputedStyle(element);
        const size = Number.parseFloat(style.fontSize);
        const floor = floorOf(element);
        const where = `"${text.slice(0, 40)}" (${element.tagName.toLowerCase()}.${String(element.className)})`;
        if (size < floor) problems.push(`${size}px < ${floor}px: ${where}`);
        // "normal" is about 1.2: below either floor.
        const leading = style.lineHeight === 'normal' ? 1.2 : Number.parseFloat(style.lineHeight) / size;
        const least = element.closest(RUNNING) ? 1.5 : 1.25;
        if (leading < least - 0.01) problems.push(`line-height ${leading.toFixed(2)} < ${least}: ${where}`);
      }
    }
    return problems;
  });
}

for (const width of [375, 1920]) {
  test.describe(`Spending overview (reading sizes at ${width}px)`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('keeps every text at its floor, folds open, after an error and with nothing left out', async ({ page }) => {
      const overview = await openOverview(page);
      // A search in use: its chip and the way down to its rows.
      await page.getByRole('searchbox', { name: 'Search merchant or description' }).fill('northwind');
      await expect(overview.getByTestId('overview-matching')).toBeVisible();
      await expect(overview).toHaveAttribute('aria-busy', 'false');
      // Folds and lists open: the period's note, why the change isn't split, a part's list, a category's merchants.
      await overview.getByTestId('overview-current-note').getByRole('button').click();
      const changed = overview.getByRole('group', { name: 'What changed' });
      await changed.getByRole('button', { name: 'Why they can\'t be compared' }).click();
      await overview.getByTestId('overview-part-recurring').click();
      const view = overview.locator('.overview-categories');
      await view.getByTestId('overview-categories').getByRole('button', { name: /^Groceries/ }).click();
      await view.getByTestId('overview-merchants').getByRole('listitem').nth(0).locator(':scope > .overview-row').click();
      const months = overview.getByRole('group', { name: 'Months' });
      await months.getByRole('button', { name: /^Missing history/ }).click();
      await page.getByRole('region', { name: 'Import coverage' }).getByRole('button', { name: /^Imported dates: / }).click();
      await expect(overview.getByTestId('overview-current-note').getByRole('listitem')).toHaveCount(1);
      await expect(changed.getByTestId('overview-changes-not-comparable').getByRole('listitem')).toHaveCount(1);
      await expect(view.getByTestId('overview-line-total')).toHaveText('$50.00');
      await expect(months.getByTestId('overview-gaps')).toBeVisible();
      expect(await sizeProblems(page)).toEqual([]);
      // By merchant with a merchant's charges open, and the months by person.
      await view.getByRole('button', { name: 'By merchant' }).click();
      await view.getByTestId('overview-merchant-rows').getByRole('button', { name: /Northwind Grocery/ }).click();
      await expect(view.getByTestId('overview-line-total')).toHaveText('$50.00');
      await months.getByRole('button', { name: 'By person' }).click();
      await expect(months.locator('[data-month="2024-09"]')).toHaveAccessibleName(/^\$50\.00 in September 2024 \(month in progress\): Alex \$0\.00, Casey \$50\.00, Joint \$0\.00$/);
      expect(await sizeProblems(page)).toEqual([]);
      await page.getByRole('button', { name: 'Clear Search: “northwind”' }).click();
      await expect(page.locator('.spending-active-filters')).toHaveCount(0);

      // A comparison that can't be read: its error, at the status floor.
      const isCompare = (url: URL) => url.pathname === '/spending/compare';
      await page.route(isCompare, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'synthetic failure' }) }));
      await page.getByRole('button', { name: 'Previous month' }).click();
      await expect(overview.getByRole('status')).toContainText('synthetic failure');
      expect(await sizeProblems(page)).toEqual([]);
      await page.unroute(isCompare);

      // Nothing pending or left out: said at the help floor.
      await page.getByRole('combobox', { name: 'Card' }).selectOption({ label: STORES_LABEL });
      await page.getByRole('button', { name: 'Next month' }).click();
      await expect(page.locator('.spending-month-label')).toHaveText('September 2024');
      await expect(overview.getByTestId('overview-out-none')).toHaveText('Nothing pending or left out');
      expect(await sizeProblems(page)).toEqual([]);

      // The total's own read refused (to today): its error under the total, at the status floor too.
      const isPeriodSummary = (url: URL) => url.pathname === '/spending/summary' && url.searchParams.get('to') === '2024-09-20';
      await page.route(isPeriodSummary, (route) =>
        route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'synthetic totals refusal' }) }));
      await page.getByRole('combobox', { name: 'Card' }).selectOption({ label: LABEL });
      await expect(overview.getByTestId('overview-totals-error')).toHaveText('Couldn\'t read this total: synthetic totals refusal');
      expect(await sizeProblems(page)).toEqual([]);
      await page.unroute(isPeriodSummary);
    });
  });
}

test.describe('Spending overview (phone)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('fits the screen', async ({ page }) => {
    const overview = await openOverview(page);
    await expect(overview.getByTestId('overview-total')).toHaveText('$95.99');
    const overflow = await overview.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('keeps every month in its column, the months no card is expected in too', async ({ page }) => {
    const overview = await openOverview(page);
    const months = overview.getByRole('group', { name: 'Months' });
    // Before the card first appears, no card is expected: such a month is as wide as any other, its name readable
    // (never the app's 64px empty-state box, which pushed the last month off a phone's screen).
    await expect(months.locator('[data-month="2024-05"]')).toHaveAccessibleName(/^\$0\.00 in May 2024 \(incomplete\): .*data from 0 of 0 cards/);
    // Too narrow to say each month's state on it: said in one line under the chart, by name.
    await expect(months.locator('.overview-month-state').first()).toBeHidden();
    await expect(months.getByTestId('overview-month-states')).toHaveText('Incomplete: Oct–Jun · Month in progress: Sep');
    const widths = await months.locator('.overview-month').evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().width));
    expect(widths).toHaveLength(12);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    const label = months.locator('[data-month="2024-05"] .overview-month-label');
    expect(await label.evaluate((node) => node.clientWidth)).toBeGreaterThan(0);
    // Twelve months across a phone: each named by its initial at 14px, none cut short; the button's name says it in full.
    const labels = await months.locator('.overview-month-label').evaluateAll((spans) => spans.map((span) => ({
      text: (span as HTMLElement).innerText.trim(), size: Number.parseFloat(getComputedStyle(span).fontSize), cut: span.scrollWidth > span.clientWidth,
    })));
    expect(labels.map((item) => item.text)).toEqual(['O', 'N', 'D', 'J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S']);
    expect(labels.every((item) => item.size >= 14 && !item.cut)).toBe(true);
  });
});

test.describe('Spending overview (six cards missing history, at 375px)', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('keeps a six-card missing history folded under its count, and opens it from the keyboard', async ({ page }) => {
    // Synthetic gaps naming six of this file's cards, served in place of the months' own; the months are the API's.
    const isTrend = (url: URL) => url.pathname === '/spending/trend';
    await page.route(isTrend, async (route) => {
      const response = await route.fetch();
      const body = await response.json() as { gaps: unknown };
      body.gaps = { behind: cardIds.map((cardAccountId, index) => ({ cardAccountId, coveredThrough: `2024-0${3 + (index % 3)}-30` })), startingLater: [] };
      await route.fulfill({ response, json: body });
    });
    const overview = await openOverview(page);
    const months = overview.getByRole('group', { name: 'Months' });
    const missing = months.getByRole('button', { name: 'Missing history (6 cards)' });
    await expect(missing).toHaveAttribute('aria-expanded', 'false');
    await expect(months.getByTestId('overview-gaps')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    // From the keyboard: open, every card named, and the way to mark closed cards; then closed again.
    await missing.focus();
    await page.keyboard.press('Enter');
    await expect(missing).toHaveAttribute('aria-expanded', 'true');
    const gaps = months.getByTestId('overview-gaps');
    for (const label of [LABEL, STORES_LABEL, BEHIND_LABEL, QUIET_LABEL, LATER_LABEL, ZERO_LABEL]) await expect(gaps).toContainText(label);
    await expect(months.getByRole('button', { name: 'Mark closed cards' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    await missing.press('Enter');
    await expect(missing).toHaveAttribute('aria-expanded', 'false');
    await expect(months.getByTestId('overview-gaps')).toHaveCount(0);
  });
});