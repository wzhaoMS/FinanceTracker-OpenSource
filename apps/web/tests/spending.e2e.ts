import { createHash } from 'node:crypto';
import { expect, requireHealthyApi, test, type APIRequestContext, type Page } from './fixtures';
import {
  amazonCardChargeKind,
  buildCardImportPayload,
  cardCategoryBasisMarkerFor,
  cardCategoryPortion,
  cardCategorySplitView,
  cardSpendingTrend,
  classifyCardSpending,
  compareCardSpending,
  computeCardInsights,
  primaryCardCurrency,
  resolveCardCategorySplits,
  serializeCardImportPayload,
  summarizeCardSpending,
  toCardTransactionView,
  type CardAccount,
  type CardCategoryResolution,
  type CardImportDraftRow,
  type CardOwner,
  type CardTransaction,
} from '@finance-tracker/shared';

/**
 * The Spending tab, desktop and phone, on synthetic card data (fictional
 * merchants, made-up amounts) that this file imports through the API into
 * two card accounts of its own. The page clock is fixed in March 2024 so the
 * tab opens on the seeded month (and insights are as of March 20); other
 * data on the stack is filtered out by card.
 */

const SUFFIX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6) || 'spend';
const NICKNAME = `E2E ${SUFFIX}`;
// Must not contain NICKNAME: coverage rows are found by nickname.
const INSIGHTS_NICKNAME = `Insights ${SUFFIX}`;
const PENDING_NICKNAME = `Pending ${SUFFIX}`;
const MATCH_NICKNAME = `Match ${SUFFIX}`;
const PAYMENTS_NICKNAME = `Payments ${SUFFIX}`;
const DISMISSED_NICKNAME = `Dismissed ${SUFFIX}`;
const TWIN_NICKNAME = `Twin ${SUFFIX}`;
const STALE_NICKNAME = `Stale ${SUFFIX}`;
const MERGE_NICKNAME = `Merge ${SUFFIX}`;
const SPLIT_NICKNAME = `Split ${SUFFIX}`;
const REVIEW_NICKNAME = `Review ${SUFFIX}`;
const AGAIN_NICKNAME = `Again ${SUFFIX}`;
const MUTATION_HEADERS = { 'Content-Type': 'application/json', 'X-Holdr-Request': '1' };

interface SyntheticCashEvent {
  date: string;
  eventType: 'withdrawal';
  amount: number;
  currency: string;
  broker: string;
  accountLast4: string;
  description: string;
  sourceOccurrence: number;
}

/** The API's fingerprint of a broker cash event (computeCashEventFingerprint in apps/api/src/services/cashEvents.ts). */
function cashEventFingerprint(event: SyntheticCashEvent): string {
  return createHash('sha256').update([
    event.broker.trim().toLowerCase(),
    event.date,
    event.accountLast4,
    event.eventType,
    (Math.round(event.amount * 10_000) / 10_000).toFixed(4),
    event.description.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase(),
    String(event.sourceOccurrence),
  ].join('|')).digest('hex');
}

function payload(rows: CardImportDraftRow[], coverage: { start: string; end: string }, issuer = 'amex'): string {
  return serializeCardImportPayload(buildCardImportPayload({
    source: 'e2e-sync', parserVersion: 'e2e@1', issuer, currency: 'USD', coverage, rows,
  }).payload);
}

const JANUARY = payload([
  { transactionDate: '2024-01-05', amountMinor: 12000, kind: 'purchase', description: 'NORTHWIND GROCERY', issuerCategory: 'Groceries' },
  { transactionDate: '2024-01-12', amountMinor: 8000, kind: 'purchase', description: 'PROSEWARE BISTRO', issuerCategory: 'Restaurant' },
  { transactionDate: '2024-01-20', amountMinor: -50000, kind: 'payment', description: 'AUTOPAY PAYMENT - THANK YOU' },
], { start: '2024-01-01', end: '2024-01-31' });
const FEBRUARY = payload([
  { transactionDate: '2024-02-03', amountMinor: 15000, kind: 'purchase', description: 'NORTHWIND GROCERY', issuerCategory: 'Groceries' },
  { transactionDate: '2024-02-14', amountMinor: 10000, kind: 'purchase', description: 'PROSEWARE BISTRO', issuerCategory: 'Restaurant' },
  { transactionDate: '2024-02-20', amountMinor: 40000, kind: 'purchase', description: 'CONTOSO AIRLINES', issuerCategory: 'Travel' },
], { start: '2024-02-01', end: '2024-02-29' });
// March starts on the 5th: March 1–4 is a coverage gap.
const MARCH = payload([
  { transactionDate: '2024-03-06', amountMinor: 9000, kind: 'purchase', description: 'NORTHWIND GROCERY', issuerCategory: 'Groceries' },
  { transactionDate: '2024-03-08', amountMinor: 4500, kind: 'purchase', description: 'LITWARE BOOKS', issuerCategory: 'Shopping' },
  { transactionDate: '2024-03-10', amountMinor: -1500, kind: 'refund', description: 'LITWARE BOOKS RETURN', issuerCategory: 'Shopping' },
  { transactionDate: '2024-03-12', status: 'pending', amountMinor: 6000, kind: 'purchase', description: 'FABRIKAM FUEL', issuerCategory: 'Fuel' },
  { transactionDate: '2024-03-15', amountMinor: 350, kind: 'fee', description: 'FOREIGN TRANSACTION FEE', issuerCategory: 'Fees' },
  { transactionDate: '2024-03-15', amountMinor: 11650, kind: 'purchase', description: 'HOTEL SAMPLE LISBOA', issuerCategory: 'Travel' },
], { start: '2024-03-05', end: '2024-03-20' });
const APRIL = payload([
  { transactionDate: '2024-04-02', amountMinor: 2400, kind: 'purchase', description: 'TAILSPIN CINEMA', issuerCategory: 'Entertainment' },
], { start: '2024-04-01', end: '2024-04-03' });
// A second card for insights: a subscription that went up, a fare billed
// twice, interest, and groceries on irregular days (so not recurring).
const INSIGHTS = payload([
  { transactionDate: '2024-01-04', amountMinor: 9500, kind: 'purchase', description: 'NORTHWIND GROCERY', issuerCategory: 'Groceries' },
  { transactionDate: '2024-01-07', amountMinor: 1549, kind: 'purchase', description: 'SAMPLE STREAMING', issuerCategory: 'Entertainment' },
  { transactionDate: '2024-02-07', amountMinor: 1549, kind: 'purchase', description: 'SAMPLE STREAMING', issuerCategory: 'Entertainment' },
  { transactionDate: '2024-02-13', amountMinor: 10200, kind: 'purchase', description: 'NORTHWIND GROCERY', issuerCategory: 'Groceries' },
  { transactionDate: '2024-03-07', amountMinor: 1799, kind: 'purchase', description: 'SAMPLE STREAMING', issuerCategory: 'Entertainment' },
  { transactionDate: '2024-03-08', amountMinor: 41200, kind: 'purchase', description: 'CONTOSO AIRLINES', issuerCategory: 'Travel' },
  { transactionDate: '2024-03-09', amountMinor: 41200, kind: 'purchase', description: 'CONTOSO AIRLINES', issuerCategory: 'Travel' },
  { transactionDate: '2024-03-11', amountMinor: 9800, kind: 'purchase', description: 'NORTHWIND GROCERY', issuerCategory: 'Groceries' },
  { transactionDate: '2024-03-15', amountMinor: 2400, kind: 'interest', description: 'INTEREST CHARGE ON PURCHASES' },
], { start: '2024-01-01', end: '2024-03-20' }, 'chase');
// A third card with something of every kind, so the insights differ by period and outnumber the six shown
// first: a large one-off, merchants that moved, a new and a stopped subscription, a price rise, a fare billed
// twice, a first-time merchant, a pending refund and a foreign transaction fee.
const RICH_NICKNAME = `Rich ${SUFFIX}`;
const RICH = payload([
  { transactionDate: '2023-06-01', amountMinor: 3000, kind: 'purchase', description: 'LITWARE BOOKS', issuerCategory: 'Shopping' },
  ...([['2023-09-25', 11000], ['2023-11-14', 12500], ['2023-12-12', 12500], ['2024-02-15', 12000]] as const).map(([transactionDate, amountMinor]) =>
    ({ transactionDate, amountMinor, kind: 'purchase' as const, description: 'NORTHWIND GROCERY', issuerCategory: 'Groceries' })),
  ...['2024-01-15', '2024-02-20'].map((transactionDate) =>
    ({ transactionDate, amountMinor: 10000, kind: 'purchase' as const, description: 'SAMPLE MARKET', issuerCategory: 'Groceries' })),
  ...([['2023-10-05', 3000], ['2023-11-20', 2500], ['2023-12-02', 3500], ['2024-01-09', 2000], ['2024-02-25', 4000], ['2024-03-10', 3000]] as const)
    .map(([transactionDate, amountMinor]) => ({ transactionDate, amountMinor, kind: 'purchase' as const, description: 'PROSEWARE BISTRO', issuerCategory: 'Dining' })),
  ...['2024-01-20', '2024-03-01'].map((transactionDate) =>
    ({ transactionDate, amountMinor: 9000, kind: 'purchase' as const, description: 'CONTOSO NOODLES', issuerCategory: 'Dining' })),
  ...['2023-09-10', '2023-10-10', '2023-11-10', '2023-12-10', '2024-01-10'].map((transactionDate) =>
    ({ transactionDate, amountMinor: 4000, kind: 'purchase' as const, description: 'SAMPLE GYM', issuerCategory: 'Fitness' })),
  ...([['2023-10-07', 1549], ['2023-11-07', 1549], ['2023-12-07', 1549], ['2024-01-07', 1549], ['2024-02-07', 1799], ['2024-03-07', 1799]] as const)
    .map(([transactionDate, amountMinor]) => ({ transactionDate, amountMinor, kind: 'purchase' as const, description: 'SAMPLE STREAMING', issuerCategory: 'Entertainment' })),
  ...['2024-01-12', '2024-02-12', '2024-03-12'].map((transactionDate) =>
    ({ transactionDate, amountMinor: 999, kind: 'purchase' as const, description: 'SAMPLE MUSIC', issuerCategory: 'Entertainment' })),
  { transactionDate: '2024-02-10', amountMinor: 250000, kind: 'purchase', description: 'SAMPLE DEVICES INC ROUND ROCK TX', issuerCategory: 'Electronics' },
  { transactionDate: '2024-03-02', amountMinor: 4500, kind: 'purchase', description: 'TAILSPIN TAXI', issuerCategory: 'Travel' },
  { transactionDate: '2024-03-03', amountMinor: 4500, kind: 'purchase', description: 'TAILSPIN TAXI', issuerCategory: 'Travel' },
  { transactionDate: '2024-03-14', amountMinor: 30000, kind: 'purchase', description: 'WINGTIP TAILOR', issuerCategory: 'Shopping' },
  { transactionDate: '2024-03-15', amountMinor: 350, kind: 'fee', description: 'FOREIGN TRANSACTION FEE', issuerCategory: 'Fees' },
  { transactionDate: '2024-03-18', status: 'pending', amountMinor: -2500, kind: 'refund', description: 'LITWARE BOOKS', issuerCategory: 'Shopping' },
], { start: '2023-06-01', end: '2024-03-20' }, 'chase');

let cardLabel = '';
let insightsLabel = '';
let richLabel = '';

async function createAccount(request: APIRequestContext, draft: Record<string, string>): Promise<string> {
  const created = await request.post('/card-accounts', { headers: MUTATION_HEADERS, data: JSON.stringify({ currency: 'USD', ...draft }) });
  expect(created.status(), await created.text()).toBe(201);
  return (await created.json() as { id: string }).id;
}

async function commit(request: APIRequestContext, cardAccountId: string, json: string): Promise<void> {
  const committed = await request.post(`/card-imports/commit?cardAccountId=${cardAccountId}`, { headers: MUTATION_HEADERS, data: json });
  expect(committed.status(), await committed.text()).toBe(201);
}

async function seed(request: APIRequestContext): Promise<void> {
  const account = await createAccount(request, { issuer: 'amex', owner: 'alex', nickname: NICKNAME, last5: '90003' });
  for (const json of [JANUARY, FEBRUARY, MARCH]) await commit(request, account, json);
  cardLabel = `Amex ${NICKNAME} ··90003 · Alex`;
  const second = await createAccount(request, { issuer: 'chase', owner: 'casey', nickname: INSIGHTS_NICKNAME, last4: '2002' });
  await commit(request, second, INSIGHTS);
  insightsLabel = `Chase ${INSIGHTS_NICKNAME} ··2002 · Casey`;
  const third = await createAccount(request, { issuer: 'chase', owner: 'alex', nickname: RICH_NICKNAME, last4: '3003' });
  await commit(request, third, RICH);
  richLabel = `Chase ${RICH_NICKNAME} ··3003 · Alex`;
}

async function openSpending(page: Page, label = cardLabel): Promise<void> {
  await page.clock.setFixedTime(new Date('2024-03-20T12:00:00'));
  await page.goto('/');
  await page.getByRole('tab', { name: 'Spending' }).click();
  await expect(page.getByRole('region', { name: 'Spending', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Card' }).selectOption({ label });
  await expect(page.locator('.spending-month-label')).toHaveText('March 2024');
}

const card = (page: Page, name: string) => page.locator(`[data-card="${name}"] .spending-card-value`);
const rows = (page: Page) => page.locator('.spending-transactions .spending-row');
const merchants = (page: Page) => rows(page).locator('.spending-row-merchant');
const insightCards = (page: Page) => page.getByRole('region', { name: 'Insights' }).locator('.spending-insight');
const insightTitles = (page: Page) => insightCards(page).locator('.spending-insight-text strong');
/** The overview's one category view (by category, or by merchant), and its one month chart's months (contract C-4). */
const categoryView = (page: Page) => page.getByRole('region', { name: 'Spending overview' }).locator('.overview-categories');
const monthsGroup = (page: Page) => page.getByRole('region', { name: 'Spending overview' }).getByRole('group', { name: 'Months' });
const monthButton = (page: Page, month: string) => monthsGroup(page).locator(`[data-month="${month}"]`);
const INSIGHT_TITLES = [
  // $963.99 so far; Jan and Feb added nothing after the 20th.
  'On pace for $963.99 this month',
  'Possible duplicate at Contoso Airlines',
  // Then by the money each is about.
  'Travel up $824.00',
  'Sample Streaming went up to $17.99',
  '$24.00 in interest and fees',
];
// The rich card's insights for each period, in order; the first six show until "Show all".
const RICH_MONTH = [
  'On pace for $554.81 this month',
  'Possible duplicate at Tailspin Taxi',
  'First time at Wingtip Tailor: $300.00',
  'Groceries down $220.00 (−100%)',
  'Dining up $120.00',
  'Travel up $90.00',
  // The streaming price rose in February: not March's news.
  '$25.00 refund pending from Litware Books',
  '$3.50 in interest and fees',
];
const RICH_90_DAYS = [
  'Possible duplicate at Tailspin Taxi',
  '1 large purchase: $2,500.00',
  'Sample Gym may have stopped',
  'First time at Wingtip Tailor: $300.00',
  'Biggest changes by merchant',
  'Dining up $180.00 (+200%)',
  'New monthly charge: Sample Music',
  'Travel up $90.00',
  'Fitness down $80.00 (−67%)',
  'Sample Streaming went up to $17.99',
  '$25.00 refund pending from Litware Books',
  '$3.50 in interest and fees',
];
const RICH_12_MONTHS = [
  'Possible duplicate at Tailspin Taxi',
  '1 large purchase: $2,500.00',
  'Sample Gym may have stopped',
  '2 first-time merchants: $410.00',
  '2 new recurring charges: $27.98 a month',
  'Sample Streaming went up to $17.99',
  '$25.00 refund pending from Litware Books',
  '$3.50 in interest and fees',
];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  // The signed-in session (fixtures.ts). An unreachable or unhealthy API, or one that does not
  // serve the Spending routes behind sign-in, FAILS these tests: this release suite never skips them.
  await requireHealthyApi(request);
  const routes = await request.get('/spending/coverage');
  expect(routes.status(), `GET /spending/coverage: ${await routes.text()}`).toBe(200);
  await seed(request);
});

test.describe('Spending tab (desktop)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('keeps wallet merchants separate and opens the charge named by an insight', async ({ page, request }) => {
    const nickname = `Wallet ${SUFFIX}`;
    const id = await createAccount(request, { issuer: 'amex', owner: 'alex', nickname, last5: '80003' });
    await commit(request, id, payload([
      ...['2023-11-03', '2023-12-09', '2024-01-13', '2024-02-19'].map((transactionDate) => ({
        transactionDate, amountMinor: 1700, kind: 'purchase' as const, description: 'AplPay TARGET DULUTH GA',
      })),
      { transactionDate: '2024-02-21', amountMinor: 1000, kind: 'purchase', description: 'APLPAY' },
      { transactionDate: '2024-03-05', amountMinor: 620000, kind: 'purchase', description: 'AplPay MICRO CENTER DULUTH GA' },
      { transactionDate: '2024-03-06', amountMinor: 20000, kind: 'purchase', description: 'TARGET 00012345 DULUTH GA' },
      { transactionDate: '2024-03-07', amountMinor: 20000, kind: 'purchase', description: 'AplPay TARGET DULUTH GA' },
    ], { start: '2023-11-01', end: '2024-03-20' }));
    await openSpending(page, `Amex ${nickname} ··80003 · Alex`);
    const insights = page.getByRole('region', { name: 'Insights' });
    // The card's own insights, not the previous view's still on screen while they load: then whether there are more.
    await expect(insights.locator('.spending-insight-text strong').first()).toHaveText('On pace for $6,603.33 this month');
    const all = insights.getByRole('button', { name: /^Show all \(\d+\)$/ });
    if (await all.count()) await all.click();
    // No card per purchase measured against a merchant's usual: the large one is listed with the period's large purchases.
    await expect(insights).not.toContainText('your usual');
    await insights.getByRole('button', { name: 'Open: Micro Center, $6,200.00, Mar 5 · first time here' }).click();
    await expect(page.getByRole('dialog', { name: 'AplPay MICRO CENTER DULUTH GA' })).toBeVisible();
    await page.keyboard.press('Escape');
    await insights.getByRole('button', { name: 'Open: Possible duplicate at Target' }).click();
    await expect(page.getByRole('dialog', { name: 'AplPay TARGET DULUTH GA' })).toBeVisible();
    await page.keyboard.press('Escape');
    // By merchant: wallet purchases under the store's own name; one opened, then the page narrowed to it.
    const view = categoryView(page);
    await view.getByRole('button', { name: 'By merchant' }).click();
    const top = view.getByTestId('overview-merchant-rows');
    await expect(top).toContainText('Micro Center');
    await top.getByRole('button', { name: /^Target/ }).click();
    await view.getByTestId('overview-merchant-detail').getByRole('button', { name: 'Filter this spending view' }).click();
    await expect(merchants(page)).toHaveText(['AplPay TARGET DULUTH GA', 'TARGET 00012345 DULUTH GA']);
    await expect(merchants(page)).not.toContainText(['MICRO CENTER']);
  });

  test('summarizes the month in one total, compares it only when comparable, and keeps payments out of spending', async ({ page }) => {
    await openSpending(page);
    // Posted only, after refunds: the $60 pending fuel charge is on a line of its own, not in the total.
    await expect(card(page, 'spent')).toHaveText('$240.00');
    const headline = page.getByTestId('overview-headline');
    await expect(headline.getByTestId('overview-headline-label')).toHaveText('Spent in March so far');
    await expect(headline.getByTestId('overview-scope')).toHaveText(`Posted, after $15.00 in refunds · ${cardLabel}`);
    // March is still going: one comparison, never a percentage, never more or less.
    await expect(headline.getByTestId('overview-not-comparable-reason')).toHaveText('Not comparable: this period is still in progress');
    await expect(headline).not.toContainText('%');
    await expect(page.locator('[data-card="change"]')).toHaveCount(0);
    await expect(card(page, 'pending')).toHaveText('$60.00');
    const out = headline.getByTestId('overview-out').getByRole('listitem');
    await expect(out).toHaveText(['$60.00 pending · 1 not posted yet; not included']);

    // The one month chart: twelve months, the one shown pressed, and the dollar scale on its axis (February's $650 is the
    // highest month: round top $800, middle $400).
    const bars = monthsGroup(page).locator('.overview-month');
    await expect(bars).toHaveCount(12);
    await expect(bars.last()).toHaveAttribute('aria-pressed', 'true');
    await expect(monthsGroup(page).locator('.overview-axis-tick')).toHaveText(['$800', '$400', '$0']);
    await expect(monthButton(page, '2024-02')).toHaveAccessibleName(/^\$650\.00 in February 2024\b/);
    await monthButton(page, '2024-01').click();
    await expect(page.locator('.spending-month-label')).toHaveText('January 2024');
    // The chart ends at the month shown.
    await expect(bars.last()).toHaveAttribute('data-month', '2024-01');
    await expect(bars.last()).toHaveAttribute('aria-pressed', 'true');
    await expect(card(page, 'spent')).toHaveText('$200.00');
    // The card payment is a transfer, on its own line; December has no card data, never "no spending" or $0.
    await expect(out).toHaveText(['$500.00 card payments · 1 transfer, not spending']);
    await expect(headline.getByTestId('overview-not-comparable-reason')).toHaveText('Not comparable: no card data for December 2023');
    await expect(headline.locator('[data-figure="baseline"]')).toHaveText('December 2023No card data');
    await page.getByRole('button', { name: 'Next month' }).click();
    await expect(card(page, 'spent')).toHaveText('$650.00');
    // February against January, both complete: one sentence, with its amount.
    await expect(headline.getByTestId('overview-compared-text')).toHaveText('$450.00 more than January');
    await expect(headline.getByTestId('overview-compared')).toHaveAttribute('data-tone', 'more');

    // Forced colours drop background images: the scale's lines are kept, in the user's grey.
    await page.emulateMedia({ forcedColors: 'active' });
    const lines = await monthButton(page, '2024-02').locator('.overview-month-stack').evaluate((bar) => {
      const style = getComputedStyle(bar);
      return { adjust: style.getPropertyValue('forced-color-adjust'), image: style.backgroundImage };
    });
    expect(lines.adjust).toBe('none');
    expect(lines.image).toContain('linear-gradient');
  });

  test('shows the last 60 or 90 days, the last 6 or 12 months, or the year to date beside the month, each against its own comparison', async ({ page }) => {
    await openSpending(page);
    const periods = page.getByRole('group', { name: 'Period' });
    await expect(periods.getByRole('button')).toHaveText(['Month', '60 days', '90 days', '6 months', '12 months', 'YTD']);
    // Exact: "Month" is also part of "6 months" and "12 months".
    await expect(periods.getByRole('button', { name: 'Month', exact: true })).toHaveAttribute('aria-pressed', 'true');

    await periods.getByRole('button', { name: '90 days' }).click();
    await expect(periods.getByRole('button', { name: '90 days' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.spending-month-label')).toHaveText('Dec 22, 2023 – Mar 20, 2024');
    await expect(page.getByRole('button', { name: 'Previous month' })).toHaveCount(0);
    const headline = page.getByTestId('overview-headline');
    await expect(headline.getByTestId('overview-headline-label')).toHaveText('Spent in the last 90 days');
    // January ($200), February ($650) and March so far ($240): posted, after refunds; the payment is not spending.
    await expect(card(page, 'spent')).toHaveText('$1,090.00');
    await expect(headline.getByTestId('overview-so-far')).toHaveText('so far');
    // The 90 days before hold no card data: said so, never as "no spending", never as $0, and never as a percentage.
    const reason = headline.getByTestId('overview-not-comparable-reason');
    const figures = headline.getByTestId('overview-not-comparable').locator('.overview-figure');
    await expect(reason).toHaveText('Not comparable: no card data for the 90 days before');
    await expect(figures).toHaveText(['The last 90 days$1,090.00', 'The 90 days beforeNo card data']);
    await expect(headline).not.toContainText(/no spending|%/i);
    // The category view and the list cover the same days; no month is the one shown.
    const categories = categoryView(page).getByTestId('overview-categories').getByRole('listitem');
    await expect(categories.first()).toContainText('Travel');
    await expect(categories.first()).toContainText('$516.50');
    await expect(rows(page).filter({ hasText: 'PROSEWARE BISTRO' })).toHaveCount(2);
    await expect(monthsGroup(page).locator('.overview-month[aria-pressed="true"]')).toHaveCount(0);

    await periods.getByRole('button', { name: '60 days' }).click();
    await expect(page.locator('.spending-month-label')).toHaveText('Jan 21 – Mar 20, 2024');
    await expect(card(page, 'spent')).toHaveText('$890.00');
    // The 60 days before (Nov 22 – Jan 20) hold January's $200, but the period is still going: both figures, no claim.
    await expect(reason).toHaveText('Not comparable: this period is still in progress');
    await expect(figures).toHaveText(['The last 60 days$890.00', 'The 60 days before$200.00']);

    // The last 6 months: from the day after the same date 6 months back, against the same 6 months a year earlier.
    await periods.getByRole('button', { name: '6 months' }).click();
    await expect(periods.getByRole('button', { name: '6 months' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.spending-month-label')).toHaveText('Sep 21, 2023 – Mar 20, 2024');
    await expect(page.getByRole('button', { name: 'Previous month' })).toHaveCount(0);
    await expect(headline.getByTestId('overview-headline-label')).toHaveText('Spent in the last 6 months');
    await expect(card(page, 'spent')).toHaveText('$1,090.00');
    await expect(reason).toHaveText('Not comparable: no card data for the same 6 months last year');
    await expect(figures).toHaveText(['The last 6 months$1,090.00', 'The same 6 months last yearNo card data']);
    await expect(rows(page).filter({ hasText: 'PROSEWARE BISTRO' })).toHaveCount(2);

    // The last 12 months, against the 12 months before.
    await periods.getByRole('button', { name: '12 months' }).click();
    await expect(page.locator('.spending-month-label')).toHaveText('Mar 21, 2023 – Mar 20, 2024');
    await expect(headline.getByTestId('overview-headline-label')).toHaveText('Spent in the last 12 months');
    await expect(card(page, 'spent')).toHaveText('$1,090.00');
    await expect(reason).toHaveText('Not comparable: no card data for the 12 months before');

    await periods.getByRole('button', { name: 'YTD' }).click();
    await expect(page.locator('.spending-month-label')).toHaveText('Jan 1 – Mar 20, 2024');
    await expect(headline.getByTestId('overview-headline-label')).toHaveText('Spent in 2024 to date');
    await expect(headline.getByTestId('overview-so-far')).toHaveCount(0);
    await expect(card(page, 'spent')).toHaveText('$1,090.00');
    await expect(reason).toHaveText('Not comparable: no card data for 2023 to the same date');

    // A month in the chart opens that month again.
    await monthButton(page, '2024-02').click();
    await expect(periods.getByRole('button', { name: 'Month', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.spending-month-label')).toHaveText('February 2024');
    await expect(card(page, 'spent')).toHaveText('$650.00');
  });

  test('lists pending charges first and on their own card, never in spending, and hides them on request', async ({ page }) => {
    await openSpending(page);
    const pending = page.getByRole('group', { name: 'Pending (1)' });
    await expect(pending.locator('.spending-row-merchant')).toHaveText(['FABRIKAM FUEL']);
    await expect(merchants(page).first()).toHaveText('FABRIKAM FUEL');
    await page.getByLabel('Show pending').uncheck();
    await expect(page.getByRole('group', { name: /^Pending/ })).toHaveCount(0);
    await expect(card(page, 'spent')).toHaveText('$240.00');
    await expect(card(page, 'pending')).toHaveText('$60.00');
  });

  test('filters by clicking a category or merchant, and by text or amount search', async ({ page }) => {
    await openSpending(page);
    // A category opens in place; narrowing the page is its own button.
    const view = categoryView(page);
    await view.getByTestId('overview-categories').getByRole('button', { name: /^Groceries/ }).click();
    await view.getByTestId('overview-category-detail').getByRole('button', { name: 'Filter this spending view' }).click();
    await expect(page.getByText('Category: Groceries')).toBeVisible();
    await expect(merchants(page)).toHaveText(['NORTHWIND GROCERY']);
    await expect(card(page, 'spent')).toHaveText('$90.00');
    await page.getByRole('button', { name: 'Clear Category: Groceries' }).click();

    // By merchant, merchants read as names; the bank's text is in the title.
    await view.getByRole('button', { name: 'By merchant' }).click();
    const hotel = view.getByTestId('overview-merchant-rows').getByRole('button', { name: /^Hotel Sample Lisboa/ });
    await expect(hotel).toHaveAttribute('title', 'HOTEL SAMPLE LISBOA');
    await hotel.click();
    await view.getByTestId('overview-merchant-detail').getByRole('button', { name: 'Filter this spending view' }).click();
    await expect(merchants(page)).toHaveText(['HOTEL SAMPLE LISBOA']);
    await page.getByRole('button', { name: 'Clear Merchant: Hotel Sample Lisboa' }).click();

    const search = page.getByRole('searchbox', { name: 'Search merchant or description' });
    await search.fill('litware');
    await expect(merchants(page)).toHaveText(['LITWARE BOOKS RETURN', 'LITWARE BOOKS']);
    // The search is said in its own chip, and the headline offers a way down to the rows it matches.
    const filters = page.getByRole('group', { name: 'Active filters' });
    await expect(filters).toContainText('Search: “litware”');
    const matching = page.getByTestId('overview-matching');
    await expect(matching).toHaveText('2 matching charges ↓ Transactions');
    await matching.click();
    const list = page.getByRole('region', { name: 'Card transactions' });
    await expect(list).toBeFocused();
    await expect(list).toBeInViewport();
    await page.getByRole('button', { name: 'Clear Search: “litware”' }).click();
    await expect(search).toHaveValue('');
    await expect(page.getByTestId('overview-matching')).toHaveCount(0);
    await expect(rows(page)).toHaveCount(6);
    await search.fill('116.50');
    await expect(merchants(page)).toHaveText(['HOTEL SAMPLE LISBOA']);
    await search.fill('GB29 NWBK 6016 1331 9268 19');
    await expect(page.getByRole('alert')).toHaveText(/^Holdr doesn't keep card details/);
    await search.fill('');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(rows(page)).toHaveCount(6);
  });

  test('keeps the filters, the place on the page and the focus when a charge\'s details open, change and close', async ({ page }) => {
    await openSpending(page);
    const search = page.getByRole('searchbox', { name: 'Search merchant or description' });
    await search.fill('northwind');
    await expect(merchants(page)).toHaveText(['NORTHWIND GROCERY']);
    // Down to the list from the headline, then the charge's details, and back.
    await page.getByTestId('overview-matching').click();
    const row = rows(page).filter({ hasText: 'NORTHWIND GROCERY' }).locator('.spending-row-main');
    await row.scrollIntoViewIfNeeded();
    const atList = await page.evaluate(() => window.scrollY);
    await row.click();
    const dialog = page.getByRole('dialog', { name: 'NORTHWIND GROCERY' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(row).toBeFocused();
    expect(Math.abs(await page.evaluate(() => window.scrollY) - atList)).toBeLessThanOrEqual(2);
    await expect(search).toHaveValue('northwind');
    await expect(page.getByRole('group', { name: 'Active filters' })).toContainText('Search: “northwind”');

    // From the category view, opened in place, with a change saved in the details: the figures are read again, and what
    // is open, the place on the page and the focus all stay.
    const drill = categoryView(page);
    await drill.getByTestId('overview-categories').getByRole('button', { name: /Groceries/ }).click();
    await drill.getByTestId('overview-merchants').getByRole('listitem').nth(0).getByRole('button').click();
    const charge = drill.getByTestId('overview-transactions').getByRole('button', { name: /Northwind Grocery/ });
    await charge.scrollIntoViewIfNeeded();
    const atDrill = await page.evaluate(() => window.scrollY);
    await charge.click();
    await expect(dialog).toBeVisible();
    const reread = page.waitForRequest((request) => new URL(request.url()).pathname === '/spending/compare');
    await dialog.getByLabel('Notes').fill('Synthetic weekly shop');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await reread;
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Spending overview' })).toHaveAttribute('aria-busy', 'false');
    await expect(charge).toBeFocused();
    await expect(drill.getByTestId('overview-transactions').getByTestId('overview-line-total')).toHaveText('$90.00');
    expect(Math.abs(await page.evaluate(() => window.scrollY) - atDrill)).toBeLessThanOrEqual(2);
    await expect(search).toHaveValue('northwind');
    await expect(card(page, 'spent')).toHaveText('$90.00');
  });

  test('says what the categories are based on, once, and switches to every charge\'s own category in one click', async ({ page }) => {
    await openSpending(page);
    const categories = categoryView(page);
    const insights = page.getByRole('region', { name: 'Insights' });
    const basis = categories.locator('.spending-category-basis');
    // The app reads Amazon orders, and none are imported here; every charge on this card has a category of its own:
    // nothing is split or inferred, never claimed as either. Said once, above the categories: not in Insights, with
    // no revision said (it is kept in an attribute) and no count of nothing.
    await expect(basis).toHaveText('Categories: card categories');
    await expect(categories.locator('.spending-category-basis-line')).toHaveAttribute('data-revision', /^amazon-v1-/);
    await expect(page.locator('.spending-category-basis-line')).toHaveCount(1);
    await expect(insights.locator('.spending-category-basis-line')).toHaveCount(0);
    // Why is folded under "About these categories".
    const about = categories.getByRole('button', { name: 'About these categories' });
    await expect(about).toHaveAttribute('aria-expanded', 'false');
    await expect(categories.locator('.spending-category-why')).toHaveCount(0);
    await about.click();
    await expect(categories.locator('.spending-category-why')).toContainText('No charge here is split by Amazon items.');
    await expect(categories.locator('.spending-category-evidence')).toHaveCount(0);
    const figures = categories.getByTestId('overview-categories').locator('strong.num');
    await expect(figures.first()).toBeVisible();
    const amounts = await figures.allTextContents();
    const titles = await insightTitles(page).allTextContents();
    const spent = (await card(page, 'spent').textContent()) ?? '';
    await categories.getByRole('button', { name: 'Original categories' }).click();
    await expect(basis).toHaveText('Categories: original card categories');
    await expect(categories.locator('.spending-category-evidence')).toHaveCount(0);
    // Only what the categories are based on changes; here nothing is split, so every figure stays.
    await expect(figures).toHaveText(amounts);
    await expect(insightTitles(page)).toHaveText(titles);
    await expect(card(page, 'spent')).toHaveText(spent);
    // The choice stays with this browser; the switch goes back.
    await openSpending(page);
    await expect(basis).toHaveText('Categories: original card categories');
    await categories.getByRole('button', { name: 'Enriched categories' }).click();
    await expect(basis).toHaveText('Categories: card categories');
  });

  test('says a card\'s issuer once in its label, and keeps apart two cards that would then read alike', async ({ page }) => {
    // Made-up cards added to the list the page reads (nothing is written). One alone: the issuer once, said shorter.
    // Two tiers of one card with no ending, and two with the same last four (legal): each keeps its network and tier.
    // Two nicknames apart only by the issuer's name: those keep their previous labels. A closed card counts, unlisted.
    const extra = [
      ['label-solo', 'citi', 'Citi/Label Solo Executive World Elite Mastercard', '7011'],
      ['label-elite', 'citi', 'Citi Label Miles World Elite Mastercard'],
      ['label-world', 'citi', 'Citi Label Miles World Mastercard'],
      ['label-signature', 'chase', 'Chase Label Summit Visa Signature', '7012'],
      ['label-infinite', 'chase', 'Chase Label Summit Visa Infinite', '7012'],
      ['label-prefixed', 'citi', 'Citi/Label Sample', '7013'],
      ['label-plain', 'citi', 'Label Sample', '7013'],
      ['label-open', 'chase', 'Label Reserve Visa Infinite', '7014'],
      ['label-closed', 'chase', 'Label Reserve Visa Signature', '7014', 'closed'],
      // A nickname that ends like a label's ending (review of #205): its label as shown is compared, ending included.
      ['label-literal', 'citi', 'Label Literal Visa', '7015'],
      ['label-literal-text', 'citi', 'Label Literal ··7015'],
      // Names in another script are compared as they are: told apart, said shorter (P3 after #205).
      ['label-cjk-a', 'citi', 'Citi/交通 Visa', '7016'],
      ['label-cjk-b', 'citi', '餐饮 Visa', '7016'],
    ].map(([id, issuer, nickname, last4, status = 'active']) => ({
      id, issuer, owner: 'joint', nickname, last4, currency: 'USD', status, createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
    }));
    await page.route((url) => url.pathname === '/card-accounts', async (route) => {
      const response = await route.fetch();
      const body = await response.json() as { cardAccounts: unknown[] };
      await route.fulfill({ response, json: { ...body, cardAccounts: [...body.cardAccounts, ...extra] } });
    });
    await openSpending(page);
    const picker = page.getByRole('combobox', { name: 'Card', exact: true });
    const labels = [
      'Citi Label Solo Executive ··7011 · Joint',
      'Citi Label Miles World Elite Mastercard · Joint',
      'Citi Label Miles World Mastercard · Joint',
      'Chase Label Summit Visa Signature ··7012 · Joint',
      'Chase Label Summit Visa Infinite ··7012 · Joint',
      'Citi Citi/Label Sample ··7013 · Joint',
      'Citi Label Sample ··7013 · Joint',
      'Chase Label Reserve Visa Infinite ··7014 · Joint',
      'Citi Label Literal Visa ··7015 · Joint',
      'Citi Label Literal ··7015 · Joint',
      'Citi 交通 ··7016 · Joint',
      'Citi 餐饮 ··7016 · Joint',
    ];
    // Each reads as itself: once, and like no other card in the list.
    const once = async (expected: string[]) => {
      const options = await picker.locator('option').allTextContents();
      for (const label of expected) expect(options.filter((option) => option === label), label).toHaveLength(1);
    };
    await once(labels);
    await page.getByRole('checkbox', { name: /^Show closed cards \(\d+\)$/ }).check();
    await once([...labels, 'Chase Label Reserve Visa Signature ··7014 · Joint (closed)']);
  });

  test('names a card created in an import at once, and every other card again with it, before anything is imported', async ({ page, request }) => {
    // A made-up card with no ending, alone said shorter; the import's preview creates another of the same issuer and
    // owner with no ending (review of #205). Nothing is imported.
    const name = `Label Addition ${SUFFIX}`;
    const existing = await createAccount(request, { issuer: 'citi', owner: 'joint', nickname: `Citi ${name} Visa` });
    await openSpending(page);
    const behind = page.locator(`select[aria-label="Card"] option[value="${existing}"]`);
    await expect(behind).toHaveText(`Citi ${name} · Joint`);
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Import card spending' });
    const statement = payload([{ transactionDate: '2024-03-05', amountMinor: 100, kind: 'purchase', description: 'PROSEWARE LABEL' }],
      { start: '2024-03-01', end: '2024-03-31' }, 'citi');
    const file = { name: 'statement.json', mimeType: 'application/json', buffer: Buffer.from(statement) };
    await dialog.getByLabel('Redacted JSON').setInputFiles(file);
    const target = dialog.getByRole('combobox', { name: 'Card account' });
    await target.selectOption('__new__');
    await dialog.getByLabel('Whose card').selectOption('joint');
    await dialog.getByLabel('Nickname').fill(name);
    const creating = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/card-accounts');
    await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
    const createdResponse = await creating;
    expect(createdResponse.status()).toBe(201);
    const created = (await createdResponse.json() as { id: string }).id;
    await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeVisible();
    // At once, on the page behind the import too: the card already there keeps its network, the new one reads apart.
    await expect(behind).toHaveText(`Citi ${name} Visa · Joint`);
    await dialog.getByLabel('Redacted JSON').setInputFiles(file);
    await expect(target).toBeEnabled();
    await expect(target.locator(`option[value="${existing}"]`)).toHaveText(`Citi ${name} Visa · Joint`);
    await expect(target.locator(`option[value="${created}"]`)).toHaveText(`Citi ${name} · Joint`);
    await dialog.getByRole('button', { name: 'Close import' }).click();
    // Read again: the same.
    await openSpending(page);
    const picker = page.getByRole('combobox', { name: 'Card', exact: true });
    await expect(picker.locator(`option[value="${existing}"]`)).toHaveText(`Citi ${name} Visa · Joint`);
    await expect(picker.locator(`option[value="${created}"]`)).toHaveText(`Citi ${name} · Joint`);
  });

  test('infers a category for a charge with none, says how, and keeps the original one a click away', async ({ page, request }) => {
    // Inference learns from every row of the household: this test's merchant is its own (the suffix), or a rule's.
    const tag = SUFFIX.toUpperCase();
    const deli = `PROSEWARE DELI ${tag}`;
    const learn = await createAccount(request, { issuer: 'amex', owner: 'alex', nickname: `Learn ${SUFFIX}`, last5: '70003' });
    await commit(request, learn, payload([
      { transactionDate: '2024-02-06', amountMinor: 1800, kind: 'purchase', description: deli, issuerCategory: 'Restaurant-Restaurant' },
      { transactionDate: '2024-02-20', amountMinor: 2200, kind: 'purchase', description: deli, issuerCategory: 'Restaurant-Restaurant' },
    ], { start: '2024-02-01', end: '2024-02-29' }));
    // A statement-file card: no categories at all.
    const nickname = `Statement ${SUFFIX}`;
    const statement = await createAccount(request, { issuer: 'chase', owner: 'casey', nickname, last4: '0003' });
    await commit(request, statement, payload([
      { transactionDate: '2024-03-04', amountMinor: 2600, kind: 'purchase', description: `${deli} #12` },
      { transactionDate: '2024-03-07', amountMinor: 4100, kind: 'purchase', description: 'SUNOCO 0412' },
      { transactionDate: '2024-03-09', amountMinor: 9900, kind: 'purchase', description: `SAMPLE PLUMBING ${tag}` },
    ], { start: '2024-03-01', end: '2024-03-20' }, 'chase'));
    await openSpending(page, `Chase ${nickname} ··0003 · Casey`);
    const categories = categoryView(page);
    const basis = categories.locator('.spending-category-basis');
    // How many charges are inferred, and how many of those by rule, in the note, and where each came from under it.
    await expect(basis).toHaveText('Categories: 2 charges inferred (1 from merchant history, 1 by rule)');
    await categories.getByRole('button', { name: 'About these categories' }).click();
    await expect(categories.locator('.spending-category-why')).toHaveText(
      /^Where these charges' categories come from: your own 0, the issuer's 0, Amazon items 0, inferred 2 \(1 from merchant history, 1 by rule\), none 1\./);
    // Nothing split here: no count of nothing.
    await expect(categories.locator('.spending-category-evidence')).toHaveCount(0);
    // Each inferred chip says so, and why; a charge nothing recognizes stays uncategorized.
    const deliRow = rows(page).filter({ hasText: `${deli} #12` });
    const deliChip = deliRow.getByRole('button', { name: /^Category Restaurant-Restaurant \(inferred\) for / });
    await expect(deliChip).toHaveText('Restaurant');
    await expect(deliChip).toHaveClass(/\binferred\b/);
    await expect(deliChip).toHaveAttribute('title', 'Restaurant-Restaurant · Inferred from merchant history (2) · click to set your own category');
    await expect(rows(page).filter({ hasText: 'SUNOCO 0412' }).getByRole('button', { name: /^Category Transportation-Fuel \(inferred\) for / }))
      .toHaveAttribute('title', /· Inferred by rule: Fuel brand ·/);
    await expect(rows(page).filter({ hasText: `SAMPLE PLUMBING ${tag}` }).getByRole('button', { name: /^Category Uncategorized for / })).toBeVisible();
    // Leaving an inferred category as it is never makes it the owner's own.
    await deliChip.click();
    const input = deliRow.getByRole('combobox', { name: /^Category for / });
    await expect(input).toHaveValue('Restaurant-Restaurant');
    await input.press('Enter');
    await expect(deliChip).toBeVisible();
    // A category filter picks the inferred charge; only categories move, not what was spent.
    await expect(card(page, 'spent')).toHaveText('$166.00');
    await categories.getByTestId('overview-categories').getByRole('button', { name: /^Transportation/ }).click();
    await categories.getByTestId('overview-category-detail').getByRole('button', { name: 'Filter this spending view' }).click();
    await expect(merchants(page)).toHaveText(['SUNOCO 0412']);
    await expect(card(page, 'spent')).toHaveText('$41.00');
    await page.getByRole('button', { name: /^Clear Category: Transportation/ }).click();
    // The details say why.
    await rows(page).filter({ hasText: 'SUNOCO 0412' }).locator('.spending-row-main').click();
    const dialog = page.getByRole('dialog', { name: 'SUNOCO 0412' });
    await expect(dialog.locator('[data-inferred-category]')).toHaveText('Transportation-Fuel · Inferred by rule: Fuel brand');
    await expect(dialog.getByLabel('Your category')).toHaveAttribute('placeholder', 'Transportation-Fuel');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    // Saving the drawer with the inferred category as it is, and a note, saves only the note: it stays inferred.
    await deliRow.locator('.spending-row-main').click();
    const deliDialog = page.getByRole('dialog', { name: `${deli} #12` });
    await deliDialog.getByLabel('Your category').fill('Restaurant-Restaurant');
    await deliDialog.getByLabel('Notes').fill('Synthetic lunch');
    const [patched] = await Promise.all([
      page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().includes('/card-transactions/')),
      deliDialog.getByRole('button', { name: 'Save' }).click(),
    ]);
    expect(patched.status()).toBe(200);
    expect(JSON.parse(patched.request().postData() ?? '{}')).toEqual({ notes: 'Synthetic lunch' });
    await expect(deliDialog.getByLabel('Your category')).toHaveValue('');
    await page.keyboard.press('Escape');
    await expect(deliChip).toBeVisible();
    // The original categories: the card's own only, nothing inferred anywhere, the same amount spent.
    await categories.getByRole('button', { name: 'Original categories' }).click();
    await expect(basis).toHaveText('Categories: original card categories');
    await expect(deliRow.getByRole('button', { name: /^Category Uncategorized for / })).toBeVisible();
    await expect(page.locator('.spending-category.inferred')).toHaveCount(0);
    await expect(card(page, 'spent')).toHaveText('$166.00');
    await rows(page).filter({ hasText: 'SUNOCO 0412' }).locator('.spending-row-main').click();
    await expect(dialog.locator('[data-inferred-category]')).toHaveCount(0);
    await expect(dialog.getByLabel('Your category')).toHaveAttribute('placeholder', 'Uncategorized');
    await page.keyboard.press('Escape');
    await categories.getByRole('button', { name: 'Enriched categories' }).click();
    await expect(basis).toHaveText(/^Categories: 2 charges inferred/);
    await expect(deliChip).toBeVisible();
  });

  test('opens a transaction, sets a custom category and notes, and edits a category in place', async ({ page }) => {
    await openSpending(page);
    await rows(page).filter({ hasText: 'HOTEL SAMPLE LISBOA' }).locator('.spending-row-main').click();
    const dialog = page.getByRole('dialog', { name: 'HOTEL SAMPLE LISBOA' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Mar 15, 2024');
    await expect(dialog).toContainText('e2e-sync');
    await expect(dialog).toContainText(`Amex ${NICKNAME} ··90003 · Alex`);
    // A long number in typed text is refused, not shortened, and the drawer says so plainly.
    await dialog.getByLabel('Notes').fill('Wire from IBAN GB29 NWBK 6016 1331 9268 19');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByRole('alert')).toHaveText(/^Holdr doesn't keep card details/);
    await dialog.getByLabel('Your category').fill('Vacation');
    await dialog.getByLabel('Notes').fill('Synthetic trip');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(dialog.getByLabel('Your category')).toHaveValue('Vacation');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    const hotel = rows(page).filter({ hasText: 'HOTEL SAMPLE LISBOA' });
    await expect(hotel.getByRole('button', { name: /^Category Vacation/ })).toBeVisible();
    await expect(categoryView(page)).toContainText('Vacation');

    const grocery = rows(page).filter({ hasText: 'NORTHWIND GROCERY' });
    await grocery.getByRole('button', { name: /^Category Groceries/ }).click();
    const input = grocery.getByRole('combobox', { name: 'Category for NORTHWIND GROCERY' });
    await input.fill('Food');
    await input.press('Enter');
    await expect(grocery.getByRole('button', { name: /^Category Food/ })).toBeVisible();
    await expect(categoryView(page)).toContainText('Food');
  });

  test('dismisses a pending charge and restores it', async ({ page }) => {
    await openSpending(page);
    await rows(page).filter({ hasText: 'FABRIKAM FUEL' }).locator('.spending-row-main').click();
    const dialog = page.getByRole('dialog', { name: 'FABRIKAM FUEL' });
    await dialog.getByRole('button', { name: 'Dismiss pending' }).click();
    await expect(dialog.locator('.spending-status')).toHaveText('Removed');
    await expect(page.getByRole('group', { name: /^Pending/ })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Restore as pending' }).click();
    await expect(dialog.locator('.spending-status')).toHaveText('Pending');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('group', { name: 'Pending (1)' })).toBeVisible();
  });

  test('suggests where a pending charge may have posted, and leaves the call to the owner', async ({ page, request }) => {
    // Its own card: a pending fuel charge, then the statement where it posted under a new reference.
    const id = await createAccount(request, { issuer: 'citi', owner: 'joint', nickname: PENDING_NICKNAME, last4: '3003' });
    await commit(request, id, payload([
      { transactionDate: '2024-03-12', status: 'pending', amountMinor: 6000, kind: 'purchase', description: 'FABRIKAM FUEL', issuerCategory: 'Fuel' },
    ], { start: '2024-03-12', end: '2024-03-12' }, 'citi'));
    await commit(request, id, payload([
      {
        transactionDate: '2024-03-13', postedDate: '2024-03-14', amountMinor: 6000, kind: 'purchase',
        description: 'FABRIKAM FUEL 77', issuerCategory: 'Fuel', externalId: 'SYN-POST-77',
      },
    ], { start: '2024-03-13', end: '2024-03-14' }, 'citi'));
    await openSpending(page, `Citi ${PENDING_NICKNAME} ··3003 · Joint`);
    // Counted once: the posted row is spending, the pending one stays pending until the owner decides.
    await expect(card(page, 'spent')).toHaveText('$60.00');
    await expect(card(page, 'pending')).toHaveText('$60.00');
    await page.getByRole('group', { name: 'Pending (1)' }).locator('.spending-row-main').click();
    const dialog = page.getByRole('dialog', { name: 'FABRIKAM FUEL' });
    const suggestions = dialog.getByRole('region', { name: 'Possibly posted as' });
    await expect(suggestions).toContainText('FABRIKAM FUEL 77');
    await dialog.getByRole('button', { name: 'Dismiss pending' }).click();
    await expect(dialog.locator('.spending-status')).toHaveText('Removed');
    await expect(suggestions).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('group', { name: /^Pending/ })).toHaveCount(0);
    await expect(card(page, 'spent')).toHaveText('$60.00');
    await expect(card(page, 'pending')).toHaveCount(0);
  });

  test('asks the owner whether a posted row without a reference is a pending charge that went through', async ({ page, request }) => {
    const id = await createAccount(request, { issuer: 'wellsfargo', owner: 'alex', nickname: MATCH_NICKNAME, last4: '4004' });
    const bistro = { transactionDate: '2024-03-14', amountMinor: 5200, kind: 'purchase', description: 'PROSEWARE BISTRO', issuerCategory: 'Restaurant' } as const;
    await commit(request, id, payload([{ ...bistro, status: 'pending' }], { start: '2024-03-14', end: '2024-03-14' }, 'wellsfargo'));
    const label = `Wells Fargo ${MATCH_NICKNAME} ··4004 · Alex`;
    await openSpending(page, label);
    await expect(card(page, 'pending')).toHaveText('$52.00');

    await page.getByRole('button', { name: 'Import', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Import card spending' });
    const statement = payload([{ ...bistro, postedDate: '2024-03-15' }], { start: '2024-03-14', end: '2024-03-15' }, 'wellsfargo');
    await dialog.getByLabel('Redacted JSON').setInputFiles({ name: 'statement.json', mimeType: 'application/json', buffer: Buffer.from(statement) });
    await dialog.getByRole('combobox', { name: 'Card account' }).selectOption({ label });
    await dialog.getByRole('button', { name: 'Preview' }).click();
    // Same date, amount and text, but no reference to prove it: nothing is assumed.
    const importButton = dialog.getByRole('button', { name: 'Import', exact: true });
    await expect(dialog.locator('.spending-choice')).toContainText('same date, amount and description as a stored pending charge');
    // The pending charge it matches is shown, and no posted row like it is stored.
    const matches = dialog.locator('.spending-match-list');
    await expect(matches).toContainText('Pending charge: Mar 14, 2024 · PROSEWARE BISTRO · $52.00');
    await expect(matches).toContainText('No posted row like it is stored.');
    await expect(importButton).toBeDisabled();
    // "Another purchase" adds a row, so it needs its own confirmation.
    await dialog.getByLabel('It is a different, new purchase').check();
    await expect(importButton).toBeDisabled();
    await expect(dialog.getByLabel('I checked: it is neither the pending charge nor a purchase already stored')).toBeVisible();
    await dialog.getByLabel('It is the pending charge, now posted').check();
    await expect(importButton).toBeEnabled();
    await importButton.click();
    await expect(dialog.getByRole('status')).toContainText('1 pending charge posted');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(card(page, 'spent')).toHaveText('$52.00');
    await expect(card(page, 'pending')).toHaveCount(0);
  });

  test('shows the posted twin of a match and offers only post or skip, and advises posting when the file lists that twin too', async ({ page, request }) => {
    const id = await createAccount(request, { issuer: 'citi', owner: 'alex', nickname: TWIN_NICKNAME, last4: '6116' });
    const bistro = { transactionDate: '2024-03-14', amountMinor: 5000, kind: 'purchase', description: 'SAMPLE BISTRO TWIN', issuerCategory: 'Restaurant' } as const;
    // A still pending, B posted: the same date, amount and text, no references.
    await commit(request, id, payload([{ ...bistro, status: 'pending' }, { ...bistro, postedDate: '2024-03-15' }], { start: '2024-03-14', end: '2024-03-15' }, 'citi'));
    const label = `Citi ${TWIN_NICKNAME} ··6116 · Alex`;
    await openSpending(page, label);
    await expect(card(page, 'spent')).toHaveText('$50.00');
    await expect(card(page, 'pending')).toHaveText('$50.00');

    // A posted-only export with just B: its fingerprint now names A.
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Import card spending' });
    const onlyB = payload([{ ...bistro, postedDate: '2024-03-15' }], { start: '2024-03-14', end: '2024-03-15' }, 'citi');
    await dialog.getByLabel('Redacted JSON').setInputFiles({ name: 'statement.json', mimeType: 'application/json', buffer: Buffer.from(onlyB) });
    await dialog.getByRole('combobox', { name: 'Card account' }).selectOption({ label });
    await dialog.getByRole('button', { name: 'Preview' }).click();
    const matches = dialog.locator('.spending-match-list');
    await expect(matches).toContainText('Pending charge: Mar 14, 2024 · SAMPLE BISTRO TWIN · $50.00');
    await expect(matches).toContainText('Already stored as posted with the same date, amount and description: Mar 14, 2024, posted Mar 15, 2024');
    await expect(dialog.locator('.spending-choice')).toContainText('skipping is usually right');
    await expect(dialog.getByLabel('It is a different, new purchase')).toHaveCount(0);
    await dialog.getByLabel('Skip this row: the pending charge stays as it is').check();
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('Nothing new');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(card(page, 'spent')).toHaveText('$50.00');
    await expect(card(page, 'pending')).toHaveText('$50.00');

    // A later export with both posted: its second row is B itself, so B is no sign that the
    // first repeats it, and the advice is that the pending charge posted.
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    const again = page.getByRole('dialog', { name: 'Import card spending' });
    const both = payload([{ ...bistro, postedDate: '2024-03-15' }, { ...bistro, postedDate: '2024-03-15' }], { start: '2024-03-14', end: '2024-03-15' }, 'citi');
    await again.getByLabel('Redacted JSON').setInputFiles({ name: 'statement.json', mimeType: 'application/json', buffer: Buffer.from(both) });
    await again.getByRole('combobox', { name: 'Card account' }).selectOption({ label });
    await again.getByRole('button', { name: 'Preview' }).click();
    await expect(again.locator('.spending-match-list')).toContainText('another row of this file is that one');
    await expect(again.locator('.spending-choice')).toContainText('it is most likely the pending charge, now posted');
    await expect(again.getByLabel('It is a different, new purchase')).toHaveCount(1);
    await again.getByLabel('It is the pending charge, now posted').check();
    await again.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(again.getByRole('status')).toContainText('1 pending charge posted');
    await again.getByRole('button', { name: 'Done' }).click();
    await expect(card(page, 'spent')).toHaveText('$100.00');
    await expect(card(page, 'pending')).toHaveCount(0);
  });

  test('offers to post the matches without a posted twin and skip the others when one answer fits not all', async ({ page, request }) => {
    const id = await createAccount(request, { issuer: 'wellsfargo', owner: 'joint', nickname: SPLIT_NICKNAME, last4: '9119' });
    const bistro = { transactionDate: '2024-03-14', amountMinor: 5000, kind: 'purchase', description: 'SAMPLE BISTRO SPLIT', issuerCategory: 'Restaurant' } as const;
    const cinema = { transactionDate: '2024-03-14', amountMinor: 7000, kind: 'purchase', description: 'SAMPLE CINEMA SPLIT', issuerCategory: 'Entertainment' } as const;
    // A and C still pending, B and D posted: two pairs with the same date, amount and text, no references.
    await commit(request, id, payload([
      { ...bistro, status: 'pending' }, { ...bistro, postedDate: '2024-03-15' },
      { ...cinema, status: 'pending' }, { ...cinema, postedDate: '2024-03-15' },
    ], { start: '2024-03-14', end: '2024-03-15' }, 'wellsfargo'));
    const label = `Wells Fargo ${SPLIT_NICKNAME} ··9119 · Joint`;
    await openSpending(page, label);
    await expect(card(page, 'spent')).toHaveText('$120.00');
    await expect(card(page, 'pending')).toHaveText('$120.00');

    // A posted (with B); C still pending: the file has A, B and D, posted. Skipping both
    // would leave A pending, posting both would count D twice.
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Import card spending' });
    const mixed = payload([
      { ...bistro, postedDate: '2024-03-15' }, { ...bistro, postedDate: '2024-03-15' }, { ...cinema, postedDate: '2024-03-15' },
    ], { start: '2024-03-14', end: '2024-03-15' }, 'wellsfargo');
    await dialog.getByLabel('Redacted JSON').setInputFiles({ name: 'statement.json', mimeType: 'application/json', buffer: Buffer.from(mixed) });
    await dialog.getByRole('combobox', { name: 'Card account' }).selectOption({ label });
    await dialog.getByRole('button', { name: 'Preview' }).click();
    const choice = dialog.locator('.spending-choice');
    await expect(choice).toContainText('1 of them has a posted row like it stored, most likely that purchase again');
    await expect(choice).toContainText('posting the ones without and skipping the others is usually right');
    await expect(choice).not.toContainText('so skipping is usually right');
    await dialog.getByLabel('Post the 1 with no posted row like it stored, and skip the 1 with one').check();
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('1 pending charge posted');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(card(page, 'spent')).toHaveText('$170.00');
    await expect(card(page, 'pending')).toHaveText('$70.00');
  });

  test('previews posted and pending apart, and dismisses what a closed statement leaves out only on confirmation', async ({ page, request }) => {
    const id = await createAccount(request, { issuer: 'chase', owner: 'joint', nickname: STALE_NICKNAME, last4: '7117' });
    const label = `Chase ${STALE_NICKNAME} ··7117 · Joint`;
    await openSpending(page, label);
    const importFile = async (json: string) => {
      await page.getByRole('button', { name: 'Import', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Import card spending' });
      await dialog.getByLabel('Redacted JSON').setInputFiles({ name: 'export.json', mimeType: 'application/json', buffer: Buffer.from(json) });
      await dialog.getByRole('combobox', { name: 'Card account' }).selectOption({ label });
      await dialog.getByRole('button', { name: 'Preview' }).click();
      return dialog;
    };

    // Pending purchases, refunds and payments each show, not only their net (preview only).
    const mixed = await importFile(payload([
      { transactionDate: '2024-03-01', status: 'pending', amountMinor: 125000, kind: 'purchase', description: 'SAMPLE HOTEL HOLD', externalId: 'SYN-AUTH-81' },
      { transactionDate: '2024-03-02', status: 'pending', amountMinor: -5000, kind: 'refund', description: 'SAMPLE HOTEL CREDIT', externalId: 'SYN-AUTH-82' },
      { transactionDate: '2024-03-03', status: 'pending', amountMinor: -120000, kind: 'payment', description: 'SAMPLE PAYMENT - THANK YOU', externalId: 'SYN-AUTH-83' },
    ], { start: '2024-03-01', end: '2024-03-03' }, 'chase'));
    await expect(mixed.getByLabel('What the file holds')).toContainText(
      'Pending · 3 rows: charges $1,250.00, refunds \u2212$50.00, net $1,200.00; payments \u2212$1,200.00. Pending is not spending',
    );
    await mixed.getByRole('button', { name: 'Close import' }).click();
    await expect(mixed).toHaveCount(0);

    // A sync with three pending charges, nothing posted yet.
    const sync = await importFile(payload([
      { transactionDate: '2024-03-02', status: 'pending', amountMinor: 125000, kind: 'purchase', description: 'SAMPLE MEGASTORE ORDER', externalId: 'SYN-AUTH-71' },
      { transactionDate: '2024-03-04', status: 'pending', amountMinor: 4200, kind: 'purchase', description: 'SAMPLE GROCER', externalId: 'SYN-AUTH-72' },
      { transactionDate: '2024-03-15', status: 'pending', amountMinor: 1800, kind: 'purchase', description: 'SAMPLE CINEMA', externalId: 'SYN-AUTH-73' },
    ], { start: '2024-03-02', end: '2024-03-15' }, 'chase'));
    const split = sync.getByLabel('What the file holds');
    await expect(split).toContainText('Posted · 0 rows');
    await expect(split).toContainText('Pending · 3 rows: charges $1,310.00, net $1,310.00. Pending is not spending');
    await sync.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(sync.getByRole('status')).toContainText('Imported 3 new rows');
    await sync.getByRole('button', { name: 'Done' }).click();
    // Pending only, with Mar 2–15 recorded: no posted spending on record for all of March so far, so never $0.
    await expect(card(page, 'spent')).toHaveText('Not recorded');
    await expect(card(page, 'pending')).toHaveText('$1,310.00');
    // Old pending charges say so in the list; a recent one does not.
    await expect(rows(page).filter({ hasText: 'SAMPLE MEGASTORE ORDER' })).toContainText('Pending 18 days · may have been cancelled');
    await expect(rows(page).filter({ hasText: 'SAMPLE CINEMA' }).locator('.spending-badge')).toHaveCount(0);

    // The closed statement: the grocer posted under its reference; the order never did; the
    // cinema, dated a few days before the close, may still post.
    const statement = await importFile(payload([
      { transactionDate: '2024-03-04', postedDate: '2024-03-05', amountMinor: 4200, kind: 'purchase', description: 'SAMPLE GROCER', externalId: 'SYN-AUTH-72' },
      { transactionDate: '2024-03-08', postedDate: '2024-03-09', amountMinor: 900, kind: 'purchase', description: 'SAMPLE BAKERY', externalId: 'SYN-POST-74' },
      { transactionDate: '2024-03-10', postedDate: '2024-03-11', amountMinor: -300, kind: 'refund', description: 'SAMPLE BAKERY RETURN', externalId: 'SYN-POST-75' },
    ], { start: '2024-03-01', end: '2024-03-19' }, 'chase'));
    await expect(statement.getByLabel('What the file holds')).toContainText('Posted · 3 rows: spending $51.00, refunds \u2212$3.00, net $48.00');
    const stale = statement.locator('.spending-choice').filter({ hasText: 'not in it' });
    await expect(stale).toContainText('1 pending charge is dated in this file\'s period');
    await expect(stale).toContainText('Missing is not proof of cancelled');
    await expect(stale.locator('.spending-match-list')).toContainText('SAMPLE MEGASTORE ORDER');
    await expect(stale.locator('.spending-match-list')).not.toContainText('SAMPLE CINEMA');
    const importButton = statement.getByRole('button', { name: 'Import', exact: true });
    // Kept by default; dismissing needs the owner's word that the statement is complete.
    await expect(importButton).toBeEnabled();
    await stale.getByLabel('Dismiss it').check();
    await expect(importButton).toBeDisabled();
    await stale.getByLabel('This file is the complete, closed statement').check();
    await importButton.click();
    await expect(statement.getByRole('status')).toContainText('1 pending charge posted; 1 pending charge dismissed');
    await statement.getByRole('button', { name: 'Done' }).click();
    // Only the separate pending total drops; spending counts posted rows only.
    await expect(card(page, 'spent')).toHaveText('$48.00');
    await expect(card(page, 'pending')).toHaveText('$18.00');
  });

  test('matches a pending charge to the posted row the owner picks in its details', async ({ page, request }) => {
    const id = await createAccount(request, { issuer: 'discover', owner: 'casey', nickname: MERGE_NICKNAME, last4: '8118' });
    await commit(request, id, payload([
      { transactionDate: '2024-03-11', status: 'pending', amountMinor: 2500, kind: 'purchase', description: 'FABRIKAM PARKING', issuerCategory: 'Travel' },
    ], { start: '2024-03-11', end: '2024-03-11' }, 'discover'));
    // It posted under a new reference and wording.
    await commit(request, id, payload([
      {
        transactionDate: '2024-03-11', postedDate: '2024-03-12', amountMinor: 2500, kind: 'purchase',
        description: 'FABRIKAM PARKING GARAGE', issuerCategory: 'Travel', externalId: 'SYN-POST-81',
      },
    ], { start: '2024-03-12', end: '2024-03-12' }, 'discover'));
    const listed = await request.get(`/card-transactions?cardAccountId=${id}&status=pending`);
    const [held] = (await listed.json() as { transactions: Array<{ id: string }> }).transactions;
    const noted = await request.patch(`/card-transactions/${held.id}`, { headers: MUTATION_HEADERS, data: JSON.stringify({ notes: 'Synthetic parking' }) });
    expect(noted.status(), await noted.text()).toBe(200);

    await openSpending(page, `Discover ${MERGE_NICKNAME} ··8118 · Casey`);
    await expect(card(page, 'spent')).toHaveText('$25.00');
    await expect(card(page, 'pending')).toHaveText('$25.00');
    await page.getByRole('group', { name: 'Pending (1)' }).locator('.spending-row-main').click();
    const pending = page.getByRole('dialog', { name: 'FABRIKAM PARKING' });
    const suggestions = pending.getByRole('region', { name: 'Possibly posted as' });
    await expect(suggestions).toContainText('FABRIKAM PARKING GARAGE');
    await suggestions.getByRole('button', { name: /^This is its posted row/ }).click();
    // The drawer moves to the posted row, which now carries the pending row's notes.
    const posted = page.getByRole('dialog');
    await expect(posted.locator('.spending-status')).toHaveText('Posted');
    await expect(posted.getByLabel('Notes')).toHaveValue('Synthetic parking');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('group', { name: /^Pending/ })).toHaveCount(0);
    await expect(card(page, 'spent')).toHaveText('$25.00');
    await expect(card(page, 'pending')).toHaveCount(0);
  });

  test('suggests the brokerage withdrawal a card payment may have come from, and changes no brokerage cash', async ({ page, request }) => {
    // A synthetic brokerage account of this test's own, with one withdrawal of $812.34 on March 11.
    const brokerageId = `e2e-brokerage-${SUFFIX}`;
    const brokerageName = `Synthetic Brokerage ${SUFFIX}`;
    const created = await request.post('/accounts', {
      headers: MUTATION_HEADERS,
      data: JSON.stringify({ id: brokerageId, name: brokerageName, type: 'Individual', cashBalance: 1000, currency: 'USD', accountNumber: 'Z1064308' }),
    });
    expect(created.status(), await created.text()).toBe(201);
    let cashEventId: string | null = null;
    try {
      const withdrawal: SyntheticCashEvent = {
        date: '2024-03-11', eventType: 'withdrawal', amount: -812.34, currency: 'USD', broker: 'fidelity',
        accountLast4: '4308', description: 'Electronic Funds Transfer Paid (Cash)', sourceOccurrence: 0,
      };
      const stored = await request.post(`/accounts/${brokerageId}/cash-events`, {
        headers: { ...MUTATION_HEADERS, 'X-Confirm-Account-Last4': '4308' },
        data: JSON.stringify({ ...withdrawal, sourceFingerprint: cashEventFingerprint(withdrawal) }),
      });
      expect(stored.status(), await stored.text()).toBe(201);
      cashEventId = (await stored.json() as { event: { id: string } }).event.id;
      const brokerage = async () => ({
        account: ((await (await request.get('/accounts')).json()) as { accounts: Array<{ id: string }> }).accounts
          .find((account) => account.id === brokerageId),
        cashEvents: await (await request.get(`/accounts/${brokerageId}/cash-events`)).json(),
      });
      const before = await brokerage();

      // The card: a payment of exactly that amount the day before, and one that no brokerage cash matches.
      const id = await createAccount(request, { issuer: 'discover', owner: 'casey', nickname: PAYMENTS_NICKNAME, last4: '5005' });
      await commit(request, id, payload([
        { transactionDate: '2024-03-04', amountMinor: 18000, kind: 'purchase', description: 'SAMPLE MART WHOLESALE', issuerCategory: 'Shopping' },
        { transactionDate: '2024-03-10', amountMinor: -81234, kind: 'payment', description: 'ONLINE PAYMENT - THANK YOU' },
        { transactionDate: '2024-03-18', amountMinor: -2500, kind: 'payment', description: 'AUTOPAY PAYMENT - THANK YOU' },
      ], { start: '2024-03-01', end: '2024-03-20' }, 'discover'));
      await openSpending(page, `Discover ${PAYMENTS_NICKNAME} ··5005 · Casey`);
      // Payments stay transfers: spending is the purchase alone, and the payments are a line of their own.
      await expect(card(page, 'spent')).toHaveText('$180.00');
      const payments = page.getByTestId('overview-out').locator('[data-out="payments"]');
      await expect(payments.locator('.overview-out-amount')).toHaveText('$837.34');
      await expect(payments.locator('.overview-out-text')).toHaveText('card payments · 2 transfers, not spending');
      await expect(payments.locator('.overview-out-note')).toHaveText('1 possibly paid from brokerage cash');

      await rows(page).filter({ hasText: 'ONLINE PAYMENT - THANK YOU' }).locator('.spending-row-main').click();
      const dialog = page.getByRole('dialog', { name: 'ONLINE PAYMENT - THANK YOU' });
      const paidFrom = dialog.getByRole('region', { name: 'Possibly paid from' });
      await expect(paidFrom).toContainText('A suggestion only: Holdr links nothing');
      await expect(paidFrom.locator('li')).toHaveCount(1);
      await expect(paidFrom.locator('li')).toContainText(`Mar 11, 2024 · ${brokerageName} · Withdrawal, 1 day after the payment`);
      await expect(paidFrom.locator('li')).toContainText('Electronic Funds Transfer Paid (Cash)');
      await expect(paidFrom.locator('li .num')).toHaveText('−$812.34');
      await expect(dialog).toContainText('Card payment · a transfer, not spending');
      await page.keyboard.press('Escape');

      // The other payment has nothing to suggest, and a purchase never does.
      await rows(page).filter({ hasText: 'AUTOPAY PAYMENT - THANK YOU' }).locator('.spending-row-main').click();
      const other = page.getByRole('dialog', { name: 'AUTOPAY PAYMENT - THANK YOU' });
      await expect(other).toContainText('Card payment · a transfer, not spending');
      await expect(other.getByRole('region', { name: 'Possibly paid from' })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await rows(page).filter({ hasText: 'SAMPLE MART WHOLESALE' }).locator('.spending-row-main').click();
      const purchase = page.getByRole('dialog', { name: 'SAMPLE MART WHOLESALE' });
      await expect(purchase).toContainText('Purchase');
      await expect(purchase.getByRole('region', { name: 'Possibly paid from' })).toHaveCount(0);
      await page.keyboard.press('Escape');

      // Suggesting changed no brokerage cash: the account and its cash events are as they were.
      expect(await brokerage()).toEqual(before);
    } finally {
      // Soft, so a failure above is the one reported; an account with cash events cannot be deleted.
      if (cashEventId) {
        expect.soft((await request.delete(`/cash-events/${encodeURIComponent(cashEventId)}`, { headers: MUTATION_HEADERS })).status()).toBe(204);
      }
      expect.soft((await request.delete(`/accounts/${brokerageId}`, { headers: MUTATION_HEADERS })).status()).toBe(204);
    }
  });

  test('asks the owner before a dismissed charge posts under its own reference, keeping it dismissed unless told otherwise', async ({ page, request }) => {
    const id = await createAccount(request, { issuer: 'chase', owner: 'casey', nickname: DISMISSED_NICKNAME, last4: '6006' });
    const hold = { transactionDate: '2024-03-16', amountMinor: 2500, kind: 'purchase', description: 'FABRIKAM HOTEL', issuerCategory: 'Travel', externalId: 'SYN-HOLD-88' } as const;
    await commit(request, id, payload([{ ...hold, status: 'pending' }], { start: '2024-03-16', end: '2024-03-16' }, 'chase'));
    const listed = await request.get(`/card-transactions?cardAccountId=${id}&status=pending`);
    const [held] = (await listed.json() as { transactions: Array<{ id: string }> }).transactions;
    const dismissed = await request.patch(`/card-transactions/${held.id}`, { headers: MUTATION_HEADERS, data: JSON.stringify({ status: 'removed' }) });
    expect(dismissed.status(), await dismissed.text()).toBe(200);
    const label = `Chase ${DISMISSED_NICKNAME} ··6006 · Casey`;
    await openSpending(page, label);
    // Nothing posted, and only Mar 16 recorded: never $0, and no pending line for the dismissed charge.
    await expect(card(page, 'spent')).toHaveText('Not recorded');
    await expect(card(page, 'pending')).toHaveCount(0);

    await page.getByRole('button', { name: 'Import', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Import card spending' });
    const statement = payload([{ ...hold, postedDate: '2024-03-18', amountMinor: 2600 }], { start: '2024-03-16', end: '2024-03-18' }, 'chase');
    await dialog.getByLabel('Redacted JSON').setInputFiles({ name: 'statement.json', mimeType: 'application/json', buffer: Buffer.from(statement) });
    await dialog.getByRole('combobox', { name: 'Card account' }).selectOption({ label });
    await dialog.getByRole('button', { name: 'Preview' }).click();
    // The issuer's reference says it posted, but the dismissal is the owner's to undo. It stays dismissed unless the owner
    // says otherwise: a charge matched to its posted row ("This is its posted row") is dismissed too, and counting its own
    // posted row would count that purchase twice (D14).
    const importButton = dialog.getByRole('button', { name: 'Import', exact: true });
    const choice = dialog.locator('.spending-choice', { hasText: 'the issuer reference of a pending charge you dismissed' });
    await expect(choice).toContainText('If you matched that charge to its posted row ("This is its posted row" in its details), it is already counted there');
    await expect(choice.getByLabel('Keep them dismissed')).toBeChecked();
    await expect(importButton).toBeEnabled();
    await dialog.getByLabel('They did post after all: count them').check();
    await importButton.click();
    await expect(dialog.getByRole('status')).toContainText('1 pending charge posted');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(card(page, 'spent')).toHaveText('$26.00');
    await expect(card(page, 'pending')).toHaveCount(0);
  });

  test('says what an import left for review, and opens it in Sync & coverage, where the stored row changes only on the owner\'s word', async ({ page, request }) => {
    // The issuers whose review sets E2d stores (amex, chase, citi, wellsfargo).
    const id = await createAccount(request, { issuer: 'chase', owner: 'alex', nickname: REVIEW_NICKNAME, last4: '7007' });
    const label = `Chase ${REVIEW_NICKNAME} ··7007 · Alex`;
    const coverage = { start: '2024-03-01', end: '2024-03-10' };
    const bakery = { transactionDate: '2024-03-04', postedDate: '2024-03-05', amountMinor: 1800, kind: 'purchase', description: 'SAMPLE BAKERY', externalId: 'SYN-REF-77' } as const;
    await commit(request, id, payload([bakery], coverage, 'chase'));
    await openSpending(page, label);
    await expect(card(page, 'spent')).toHaveText('$18.00');

    // The same file again, but the issuer now shows that purchase with more details: its reference is stored, with other
    // content (E-Q7). The stored row stays as it is and the import opens a review item: a 201 with nothing new (Q13).
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Import card spending' });
    const again = payload([{ ...bakery, description: 'SAMPLE BAKERY DOWNTOWN' }], coverage, 'chase');
    await dialog.getByLabel('Redacted JSON').setInputFiles({ name: 'again.json', mimeType: 'application/json', buffer: Buffer.from(again) });
    await dialog.getByRole('combobox', { name: 'Card account' }).selectOption({ label });
    await dialog.getByRole('button', { name: 'Preview' }).click();
    await expect(dialog.locator('.spending-import-facts')).toContainText('1 stored row differs from the file: kept, and left for review');
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    const result = dialog.getByRole('status');
    await expect(result).toContainText('No new rows; 1 already stored; 1 stored row differs from the file.');
    await expect(result).toContainText('The stored row stays as it is unless you apply the file\'s version in the review.');
    await dialog.getByRole('button', { name: 'Review in Sync & coverage' }).click();
    await expect(dialog).toHaveCount(0);

    // Where Holdr has no extension sync (`/state` says so, as in `vite` mode), the file import's review is still listed and opened.
    const syncState = await request.get('/card-sync/owner/state');
    if (syncState.ok() && (await syncState.json() as { extensionSync?: string }).extensionSync === 'not-configured') {
      await expect(page.getByText('Not set up: this Holdr doesn\'t support extension sync yet.')).toBeVisible();
    }
    const row = page.getByRole('region', { name: 'Imports awaiting review' }).locator('li[data-source-kind="file"]', { hasText: REVIEW_NICKNAME });
    await expect(row).toContainText(`File import · ${label}`);
    await row.getByRole('button', { name: 'Review' }).click();
    const review = page.getByRole('dialog', { name: `Review: File import · ${label}` });
    const item = review.locator('fieldset[data-reason="posted-correction"]');
    await expect(item).toContainText('What the file import had (row 1)');
    await expect(item).toContainText('SAMPLE BAKERY DOWNTOWN');
    await expect(item).toContainText('The file import\'s key for the row');
    await expect(item).toContainText('$18.00');
    // Applying the file's version: the decision names no transaction (the stored identity names the row), as Holdr requires.
    await item.getByLabel('Accept the bank\'s change (your category and notes stay)').check();
    await review.getByRole('button', { name: 'Prepare the plan from the current ledger' }).click();
    await expect(review.getByRole('region', { name: 'Plan' }).locator('li[data-effect="correct"]')).toContainText('After: SAMPLE BAKERY DOWNTOWN · $18.00');
    await review.getByRole('button', { name: 'Confirm and apply the plan' }).click();
    await expect(review.getByText('Plan applied.', { exact: true })).toBeVisible();
    await review.getByRole('button', { name: 'Close review' }).click();
    const stored = await request.get(`/card-transactions?cardAccountId=${id}&status=posted`);
    expect((await stored.json() as { transactions: Array<{ description: string; amountMinor: number }> }).transactions
      .map((txn) => [txn.description, txn.amountMinor])).toEqual([['SAMPLE BAKERY DOWNTOWN', 1800]]);
    // Nothing waits any more, and the committed review can still be opened again (a decision can be changed later).
    const queue = page.getByRole('region', { name: 'Imports awaiting review' });
    await expect(queue.locator('li[data-source-kind="file"]', { hasText: REVIEW_NICKNAME })).toHaveCount(0);
    await queue.getByRole('button', { name: 'Show closed reviews' }).click();
    const closed = queue.getByRole('list', { name: 'Closed reviews' }).locator('li[data-source-kind="file"]', { hasText: REVIEW_NICKNAME });
    await expect(closed).toContainText('Plan applied');
    await expect(closed.getByRole('button', { name: 'Open' })).toBeVisible();
    // The correction changed the description only: spending is as it was.
    await page.getByRole('tablist', { name: 'Spending areas' }).getByRole('tab', { name: /^Card transactions/ }).click();
    await expect(card(page, 'spent')).toHaveText('$18.00');
    await expect(merchants(page)).toHaveText(['SAMPLE BAKERY DOWNTOWN']);
  });

  test('previews again when card spending changed after the preview, and imports only what the owner saw', async ({ page, request }) => {
    const id = await createAccount(request, { issuer: 'chase', owner: 'alex', nickname: AGAIN_NICKNAME, last4: '8008' });
    const label = `Chase ${AGAIN_NICKNAME} ··8008 · Alex`;
    await openSpending(page, label);
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Import card spending' });
    const noodles = payload([{ transactionDate: '2024-03-06', amountMinor: 2100, kind: 'purchase', description: 'SAMPLE NOODLES', externalId: 'SYN-N-1' }],
      { start: '2024-03-06', end: '2024-03-06' }, 'chase');
    await dialog.getByLabel('Redacted JSON').setInputFiles({ name: 'noodles.json', mimeType: 'application/json', buffer: Buffer.from(noodles) });
    await dialog.getByRole('combobox', { name: 'Card account' }).selectOption({ label });
    await dialog.getByRole('button', { name: 'Preview' }).click();
    await expect(dialog.locator('.spending-import-facts')).toContainText('1 new');
    // Meanwhile another import (a sync, another window) changes this card's ledger: the commit echoes the preview's
    // digest (Q10), Holdr refuses it with nothing written (Q11), and the dialog shows a new preview to confirm.
    await commit(request, id, payload([{ transactionDate: '2024-03-07', amountMinor: 900, kind: 'purchase', description: 'SAMPLE TEA', externalId: 'SYN-T-1' }],
      { start: '2024-03-07', end: '2024-03-07' }, 'chase'));
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(dialog.locator('.spending-import-notice')).toContainText('Card spending changed since that preview');
    await expect(dialog.locator('.spending-import-notice')).toContainText('so nothing was imported');
    expect((await (await request.get(`/card-transactions?cardAccountId=${id}&status=posted`)).json() as { total: number }).total).toBe(1);
    await expect(dialog.locator('.spending-import-facts')).toContainText('1 new');
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('Imported 1 new row.');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(card(page, 'spent')).toHaveText('$30.00');
  });

  test('shows imported date ranges with the gap, and imports redacted JSON only', async ({ page }) => {
    await openSpending(page);
    // A diagnostic: folded under how many cards and gaps there are, opened on request.
    const region = page.getByRole('region', { name: 'Import coverage' });
    const fold = region.getByRole('button', { name: /^Imported dates: \d+ cards?( · \d+ gaps?)?$/ });
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await expect(region.locator('.spending-coverage-range')).toHaveCount(0);
    await fold.click();
    const coverage = region.locator('li').filter({ hasText: NICKNAME });
    await expect(coverage.locator('.spending-coverage-range')).toHaveText(['Jan 1 – Feb 29, 2024', 'Mar 5 – Mar 20, 2024']);
    await expect(coverage.locator('.spending-coverage-gap')).toHaveText('Gap Mar 1 – Mar 4, 2024');

    await page.getByRole('button', { name: 'Import', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Import card spending' });
    const file = dialog.getByLabel('Redacted JSON');
    await file.setInputFiles({ name: 'export.csv', mimeType: 'text/csv', buffer: Buffer.from('Date,Description,Amount\n03/01/2024,SAMPLE,1.00\n') });
    await expect(dialog.getByRole('alert')).toContainText('not a redacted Holdr card import');
    await file.setInputFiles({ name: 'april.json', mimeType: 'application/json', buffer: Buffer.from(APRIL) });
    await dialog.getByRole('combobox', { name: 'Card account' }).selectOption({ label: cardLabel });
    await dialog.getByRole('button', { name: 'Preview' }).click();
    await expect(dialog.locator('.spending-import-preview')).toContainText('1 new');
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('Imported 1 new row');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: 'Next month' }).click();
    await expect(page.locator('.spending-month-label')).toHaveText('April 2024');
    await expect(merchants(page)).toHaveText(['TAILSPIN CINEMA']);
  });

  test('turns the month into insights, opens the charges behind them and lists recurring charges', async ({ page }) => {
    await openSpending(page, insightsLabel);
    await expect(insightTitles(page)).toHaveText(INSIGHT_TITLES);
    await expect(page.getByRole('region', { name: 'Insights' }).locator('.spending-panel-head .spending-muted'))
      .toHaveText('This month so far, against last month to this day');
    // Insights and recurring charges read the cards in view, not the list's filters, and say so with their own period.
    await expect(page.getByTestId('insights-scope')).toHaveText('Ignores search and category/merchant filters; person and card apply');
    await expect(page.getByTestId('recurring-scope')).toHaveText('As of Mar 20, 2024, from the last 400 days of charges (800 days for yearly ones). '
      + 'Ignores search and category/merchant filters; person and card apply');
    // Six or fewer: nothing waits behind "Show all".
    await expect(page.getByRole('button', { name: /^Show all/ })).toHaveCount(0);

    const insights = page.getByRole('region', { name: 'Insights' });
    await insights.getByRole('button', { name: 'Open: Possible duplicate at Contoso Airlines' }).click();
    const dialog = page.getByRole('dialog', { name: 'CONTOSO AIRLINES' });
    await expect(dialog).toContainText('Mar 9, 2024');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(insightCards(page).filter({ hasText: 'Travel up $824.00' })).toContainText('Mostly Contoso Airlines (+$824.00).');
    await insights.getByRole('button', { name: 'Show: Travel up $824.00' }).click();
    await expect(merchants(page)).toHaveText(['CONTOSO AIRLINES', 'CONTOSO AIRLINES']);
    await page.getByRole('button', { name: 'Clear Category: Travel' }).click();

    // Groceries on irregular days are not a subscription.
    const recurring = page.getByRole('region', { name: 'Recurring charges' });
    await expect(recurring.locator('.spending-recurring-row')).toHaveCount(1);
    await expect(recurring).toContainText('1 active · about $17.99 a month');
    await expect(recurring.locator('.spending-recurring-row')).toContainText('Price up');
    await expect(recurring.locator('.spending-recurring-row')).toContainText('Monthly · next about Apr 6');
    await recurring.getByRole('button', { name: 'SAMPLE STREAMING, monthly $17.99: show its charges' }).click();
    await expect(page.getByRole('button', { name: 'Clear Merchant: Sample Streaming' })).toBeVisible();
    await expect(merchants(page)).toHaveText(['SAMPLE STREAMING']);
  });

  test('insights follow the period, each against what its comparison card compares it with', async ({ page }) => {
    await openSpending(page, richLabel);
    const insights = page.getByRole('region', { name: 'Insights' });
    const heading = insights.locator('.spending-panel-head .spending-muted');
    const periods = page.getByRole('group', { name: 'Period' });
    await expect(heading).toHaveText('This month so far, against last month to this day');
    await expect(insightTitles(page)).toHaveText(RICH_MONTH.slice(0, 6));
    await insights.getByRole('button', { name: `Show all (${RICH_MONTH.length})` }).click();
    await expect(insightTitles(page)).toHaveText(RICH_MONTH);
    await insights.getByRole('button', { name: 'Show fewer' }).click();
    await expect(insightTitles(page)).toHaveText(RICH_MONTH.slice(0, 6));

    await periods.getByRole('button', { name: '90 days' }).click();
    await expect(heading).toHaveText('The last 90 days, against the 90 days before');
    await expect(insightTitles(page)).toHaveText(RICH_90_DAYS.slice(0, 6));
    await expect(insights.getByRole('button', { name: `Show all (${RICH_90_DAYS.length})` })).toBeVisible();
    // One card for the period's large purchases: what they add, and the period without them.
    await expect(insightCards(page).filter({ hasText: '1 large purchase' })).toContainText('Without it: $1,104.94, up 79% on $616.47 in the 90 days before.');
    // Each item opens its own row under its cleaned name, or shows the merchant group it names.
    await insights.getByRole('button', { name: 'Open: Sample Devices, $2,500.00, Feb 10 · first time here' }).click();
    await expect(page.getByRole('dialog', { name: 'SAMPLE DEVICES INC ROUND ROCK TX' })).toBeVisible();
    await page.keyboard.press('Escape');
    await insights.getByRole('button', { name: 'Show: Northwind Grocery, −$240.00, $120.00 vs $360.00' }).click();
    await expect(page.getByRole('button', { name: 'Clear Merchant: Northwind Grocery' })).toBeVisible();
    await expect(merchants(page)).toHaveText(['NORTHWIND GROCERY']);
    await page.getByRole('button', { name: 'Clear Merchant: Northwind Grocery' }).click();

    await periods.getByRole('button', { name: '12 months' }).click();
    await expect(heading).toHaveText('The last 12 months, against the 12 months before');
    await expect(insightTitles(page)).toHaveText(RICH_12_MONTHS.slice(0, 6));
    await insights.getByRole('button', { name: `Show all (${RICH_12_MONTHS.length})` }).click();
    await expect(insightTitles(page)).toHaveText(RICH_12_MONTHS);

    // A grid across the panel, never a sideways scroller: cards share rows and stay on the page.
    expect(await insights.locator('.spending-insight-list').evaluate((element) => getComputedStyle(element).overflowX)).toBe('visible');
    const boxes = await insightCards(page).evaluateAll((items) => items.map((item) => {
      const rect = item.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), right: rect.right };
    }));
    expect(new Set(boxes.map((box) => box.y)).size).toBeLessThan(boxes.length);
    expect(new Set(boxes.map((box) => box.x)).size).toBeGreaterThan(1);
    expect(boxes.every((box) => box.right <= 1280)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  });
});

test.describe('Spending tab (phone)', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('stacks the headline, scrolls the filters sideways and opens details full screen', async ({ page }) => {
    await openSpending(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    // The total, then its comparison, then what is not in it: one column, in that order.
    const headline = page.getByTestId('overview-headline');
    const [total, compare, out] = await Promise.all(['[data-card="spent"]', '[data-testid="overview-compare"]', '[data-testid="overview-out"]']
      .map((selector) => headline.locator(selector).boundingBox()));
    expect(total && compare && out).toBeTruthy();
    expect(compare!.y).toBeGreaterThanOrEqual(total!.y + total!.height - 1);
    expect(out!.y).toBeGreaterThanOrEqual(compare!.y + compare!.height - 1);
    expect(Math.abs(compare!.x - total!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(out!.x - total!.x)).toBeLessThanOrEqual(1);
    const filters = page.locator('.spending-filters');
    expect(await filters.evaluate((element) => getComputedStyle(element).overflowX)).toBe('auto');
    await expect(page.getByRole('combobox', { name: 'Person' })).toBeVisible();
    // Search and Import keep a row of their own, outside the sideways-scrolling filters.
    await expect(filters.getByRole('searchbox')).toHaveCount(0);
    await expect(page.getByRole('searchbox', { name: 'Search merchant or description' })).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeInViewport();
    await expect(card(page, 'spent')).toHaveText('$240.00');
    // The period switch: its six choices in two rows of three, each in full and on screen.
    const choices = page.getByRole('group', { name: 'Period' }).getByRole('button');
    await expect(choices).toHaveCount(6);
    const boxes = await choices.evaluateAll((buttons) => buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return { x: rect.x, y: rect.y, right: rect.right, clipped: button.scrollWidth > button.clientWidth };
    }));
    expect(boxes.map((box) => box.clipped)).toEqual([false, false, false, false, false, false]);
    expect(boxes.every((box) => box.x >= 0 && box.right <= 390)).toBe(true);
    expect(new Set(boxes.map((box) => Math.round(box.y))).size).toBe(2);
    expect(Math.abs(boxes[0].y - boxes[2].y)).toBeLessThanOrEqual(1);
    expect(boxes[3].y).toBeGreaterThan(boxes[0].y);

    await rows(page).filter({ hasText: 'LITWARE BOOKS RETURN' }).locator('.spending-row-main').click();
    const dialog = page.getByRole('dialog', { name: 'LITWARE BOOKS RETURN' });
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(389);
    expect(box?.x).toBeLessThanOrEqual(1);
    await expect(dialog.locator('.spending-detail-amount')).toContainText('−$15.00');
    // The details scroll; Save stays in a footer at the bottom of the screen.
    expect(await dialog.locator('.spending-detail-body').evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto');
    const footer = await dialog.locator('.spending-detail-footer').boundingBox();
    expect(footer!.y + footer!.height).toBeGreaterThanOrEqual(843);
    await expect(dialog.locator('.spending-detail-footer').getByRole('button', { name: 'Save' })).toBeInViewport();
    await dialog.getByRole('button', { name: 'Close details' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('stacks the insights in one column, the first six and the rest on request, with nothing off the side at 390 or 280 px', async ({ page }) => {
    await openSpending(page, richLabel);
    await page.getByRole('group', { name: 'Period' }).getByRole('button', { name: '90 days' }).click();
    const insights = page.getByRole('region', { name: 'Insights' });
    await expect(insightTitles(page)).toHaveText(RICH_90_DAYS.slice(0, 6));
    await insights.getByRole('button', { name: `Show all (${RICH_90_DAYS.length})` }).click();
    await expect(insightTitles(page)).toHaveText(RICH_90_DAYS);
    await expect(insights.getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');
    for (const width of [390, 280]) {
      await page.setViewportSize({ width, height: 844 });
      const boxes = await insightCards(page).evaluateAll((items) => items.map((item) => {
        const rect = item.getBoundingClientRect();
        return { x: Math.round(rect.x), right: rect.right, clipped: item.scrollWidth > item.clientWidth };
      }));
      expect(new Set(boxes.map((box) => box.x)).size, `one column at ${width}px`).toBe(1);
      expect(boxes.every((box) => box.right <= width && !box.clipped), `cards inside ${width}px`).toBe(true);
      const outside = await page.evaluate((viewport) => [...document.querySelectorAll('.spending-insights *')]
        .filter((element) => element.getBoundingClientRect().right > viewport + 0.5).map((element) => element.className), width);
      expect(outside, `nothing of the insights past ${width}px`).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `no sideways scroll at ${width}px`).toBeLessThanOrEqual(1);
    }
  });
});

test.describe('Spending tab (a host name other than localhost)', () => {
  test('keeps every card spending request on the page\'s own origin', async ({ page, baseURL }) => {
    // *.localhost reaches this machine and the dev server accepts it, but to the app it is a
    // LAN host name: the kind of page where other calls may go to a separate API origin.
    const site = new URL(baseURL ?? 'http://localhost:5173');
    site.hostname = 'holdr-e2e.localhost';
    // The same signed-in session on that host name (cookies are per host). Only reads happen here,
    // so the API's Origin allowlist for state-changing requests does not come into it.
    const session = (await page.context().cookies(new URL(baseURL ?? site).origin)).filter((cookie) => /holdr_session$/.test(cookie.name));
    expect(session).toHaveLength(1);
    await page.context().addCookies(session.map(({ name, value }) => ({ name, value, url: site.origin, httpOnly: true, sameSite: 'Strict' as const })));
    // Nothing may leave the page's origin in this test: anything else is refused, never sent.
    await page.route('**/*', (route) => (new URL(route.request().url()).origin === site.origin ? route.continue() : route.abort()));
    const cardRequests: string[] = [];
    const isCardPath = (url: string) => /^\/(?:card-accounts|card-imports|card-transactions|spending)(?:[/?]|$)/.test(new URL(url).pathname);
    page.on('request', (request) => {
      if (isCardPath(request.url())) cardRequests.push(request.url());
    });
    await page.clock.setFixedTime(new Date('2024-03-20T12:00:00'));
    const firstCardRequest = page.waitForRequest((request) => isCardPath(request.url()));
    await page.goto(site.toString());
    await page.getByRole('tab', { name: 'Spending' }).click();
    expect(new URL((await firstCardRequest).url()).origin).toBe(site.origin);
    await page.getByRole('combobox', { name: 'Card' }).selectOption({ label: cardLabel });
    await expect(card(page, 'spent')).toHaveText('$240.00');
    await rows(page).filter({ hasText: 'HOTEL SAMPLE LISBOA' }).locator('.spending-row-main').click();
    await expect(page.getByRole('dialog', { name: 'HOTEL SAMPLE LISBOA' })).toContainText('Mar 15, 2024');
    expect(cardRequests.length).toBeGreaterThan(4);
    expect(cardRequests.filter((url) => new URL(url).origin !== site.origin)).toEqual([]);
  });
});
test.describe('Spending tab (a person whose cards use another currency)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('shows a person\'s figures in the currency their own cards use', async ({ page }) => {
    // This test serves its own synthetic card data, built with the API's own summary and insights
    // code, so no other card on the stack can change which currency a person's cards mostly use:
    // two cards in dollars, and the joint card in euros.
    const at = '2024-03-01T00:00:00.000Z';
    const account = (letter: string, issuer: string, owner: CardOwner, last4: string, currency: string): CardAccount => ({
      id: `card-acct-${letter.repeat(32)}`, issuer, owner, nickname: `Currency ${SUFFIX}`, last4, currency,
      status: 'active', createdAt: at, updatedAt: at,
    });
    const accounts = [
      account('a', 'amex', 'alex', '0003', 'USD'),
      account('b', 'chase', 'casey', '2002', 'USD'),
      account('c', 'samplebank', 'joint', '3003', 'EUR'),
    ];
    const [alex, casey, joint] = accounts.map((item) => item.id);
    const data: Array<[cardAccountId: string, currency: string, date: string, amountMinor: number, description: string,
      category: string, status?: 'posted' | 'pending']> = [
      [alex, 'USD', '2024-03-04', 2500, 'NORTHWIND GROCERY', 'Groceries'],
      [casey, 'USD', '2024-03-05', 1200, 'PROSEWARE BISTRO', 'Restaurant'],
      [joint, 'EUR', '2024-02-10', 3000, 'SAMPLE BAKERY', 'Restaurant'],
      [joint, 'EUR', '2024-03-06', 4000, 'SAMPLE BAKERY', 'Restaurant'],
      [joint, 'EUR', '2024-03-09', 1500, 'SAMPLE MARKET', 'Groceries'],
      [joint, 'EUR', '2024-03-12', 2000, 'SAMPLE FUEL', 'Fuel', 'pending'],
    ];
    const transactions = data.map(([cardAccountId, currency, transactionDate, amountMinor, description, issuerCategory, status = 'posted'],
      index): CardTransaction => ({
      id: `card-txn-${'abcdefghijklmnop'[index].repeat(32)}`,
      cardAccountId,
      source: 'e2e-sync',
      fingerprint: `e2e-currency-${index}`,
      transactionDate,
      ...(status === 'posted' ? { postedDate: transactionDate } : {}),
      status,
      amountMinor,
      currency,
      kind: 'purchase',
      description,
      issuerCategory,
      createdAt: at,
      updatedAt: at,
    }));
    const owners = new Map(accounts.map((item) => [item.id, item.owner]));
    await page.route((url) => /^\/(?:card-accounts|card-imports|card-transactions|spending)(?:[/?]|$)/.test(url.pathname), (route) => {
      const url = new URL(route.request().url());
      const param = (name: string) => url.searchParams.get(name) ?? undefined;
      const view = { owner: param('owner') as CardOwner | undefined, cardAccountId: param('cardAccountId') };
      const inView = transactions.filter((item) => (!view.owner || owners.get(item.cardAccountId) === view.owner)
        && (!view.cardAccountId || item.cardAccountId === view.cardAccountId));
      const inRange = inView.filter((item) => item.transactionDate >= (param('from') ?? '0000-01-01') && item.transactionDate <= (param('to') ?? '9999-12-31'));
      let body: unknown = null;
      if (url.pathname === '/card-accounts') body = { cardAccounts: accounts };
      if (url.pathname === '/spending/coverage') body = { cards: [] };
      if (url.pathname === '/spending/summary') body = { ...summarizeCardSpending(inRange, { owners }), categories: [] };
      if (url.pathname === '/spending/insights') {
        const [from, to, baselineFrom, baselineTo] = ['from', 'to', 'baselineFrom', 'baselineTo'].map(param);
        body = computeCardInsights(inView, {
          month: param('month') ?? '2024-03',
          today: param('today') ?? '2024-03-20',
          currency: primaryCardCurrency(accounts, view),
          ...(from && to ? { period: { from, to, baseline: baselineFrom && baselineTo ? { from: baselineFrom, to: baselineTo } : null } } : {}),
        });
      }
      if (url.pathname === '/card-transactions') {
        const statuses = (param('status') ?? 'pending,posted').split(',');
        const listed = inRange.filter((item) => statuses.includes(item.status));
        body = { transactions: listed.map(toCardTransactionView), total: listed.length, limit: 50, offset: 0, nextOffset: null };
      }
      // The overview's reads, from the API's own split; each window recorded for every day there is data for it.
      const today = param('today') ?? '2024-03-20';
      const recorded = (range: { from: string; to: string }) => {
        const withData = new Set(inView.filter((item) => item.transactionDate >= range.from && item.transactionDate <= range.to)
          .map((item) => item.cardAccountId)).size;
        const inProgress = range.to >= today;
        return { complete: !inProgress && withData > 0, cardsWithData: withData, cardsExpected: withData, cardsCovered: withData,
          cardsStartingLater: 0, inProgress, uncoveredCardIds: [] };
      };
      if (url.pathname === '/spending/compare') {
        const [from, to, baselineFrom, baselineTo] = ['from', 'to', 'baselineFrom', 'baselineTo'].map((name) => param(name)!);
        const comparison = compareCardSpending(inView, {
          currency: param('currency') ?? 'USD', through: to, today, current: { from, to }, baseline: { from: baselineFrom, to: baselineTo },
        });
        body = { basis: 'original', comparison: {
          ...comparison,
          current: { ...comparison.current, coverage: { from, to, ...recorded({ from, to }) } },
          baseline: { ...comparison.baseline, coverage: { from: baselineFrom, to: baselineTo, ...recorded({ from: baselineFrom, to: baselineTo }) } },
        } };
      }
      if (url.pathname === '/spending/trend') {
        const [fromMonth, toMonth] = [param('fromMonth')!, param('toMonth')!];
        const months: string[] = [];
        for (let month = fromMonth; month <= toMonth; month = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 7)) {
          months.push(month);
        }
        const currency = param('currency') ?? 'USD';
        const classification = classifyCardSpending(inView, { currency, through: today, today });
        const monthEnd = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
        body = {
          basis: 'original', currency, thresholdMinor: classification.thresholdMinor,
          months: cardSpendingTrend(classification, months).map((item) => ({ ...item, coverage: recorded({ from: `${item.month}-01`, to: monthEnd(item.month) }) })),
          gaps: { behind: [], startingLater: [] },
        };
      }
      return route.fulfill(body === null
        ? { status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }) }
        : { status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    await page.clock.setFixedTime(new Date('2024-03-20T12:00:00'));
    await page.goto('/');
    await page.getByRole('tab', { name: 'Spending' }).click();
    await expect(page.locator('.spending-month-label')).toHaveText('March 2024');
    const categories = categoryView(page);
    // Everyone: most cards are in dollars, so dollars lead and the euros are said beside them.
    await expect(card(page, 'spent')).toHaveText('$37.00');
    await expect(page.getByTestId('overview-other-currencies')).toHaveText('Also €55.00 on cards in another currency');

    // Joint: their only card is in euros, so every figure is in euros, as the insights are.
    await page.getByRole('combobox', { name: 'Person' }).selectOption('joint');
    await expect(card(page, 'spent')).toHaveText('€55.00');
    await expect(card(page, 'pending')).toHaveText('€20.00');
    await expect(page.getByTestId('overview-scope')).toHaveText('Posted, after refunds · Joint cards');
    await expect(page.getByTestId('overview-not-comparable').locator('[data-figure="baseline"]')).toHaveText('February at this point€30.00');
    await expect(categories).toContainText('Restaurant');
    await expect(categories).toContainText('€40.00');
    await expect(categories).not.toContainText('No spending in this view');

    // Back to one person whose card is in dollars.
    await page.getByRole('combobox', { name: 'Person' }).selectOption('alex');
    await expect(card(page, 'spent')).toHaveText('$25.00');
    await expect(card(page, 'pending')).toHaveCount(0);
    await expect(page.getByTestId('overview-out-none')).toHaveText('Nothing pending or left out');
  });
});

test.describe('Spending tab (a charge with an Amazon order)', () => {
  const LONG_TITLE = `Sample ultra-wide monitor stand, model SW-3420, ${'with an adjustable arm and a cable tray, '.repeat(10)}in black`;
  // A custom category may be one long word, up to the custom category limit.
  const LONG_CATEGORY = 'HomeOfficeEquipment'.repeat(5);

  for (const width of [1280, 390, 280]) {
    test(`shows its order's items by full name, each with its category and amount, and only why a held match is held, at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      // The Amazon domain's import does not run in this stack: its answers for two rows are added to their details.
      await page.route((url) => /^\/card-transactions\/[^/]+$/.test(url.pathname), async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const response = await route.fetch();
        const body = await response.json() as { transaction: { description: string; amountMinor: number; issuerCategory: string | null } };
        const { transaction } = body;
        if (transaction.description === 'NORTHWIND GROCERY') {
          return route.fulfill({ response, json: { ...body, amazon: {
            version: 'amazon-v1-sample', match: 'linked', evidenceClass: 'unique-total-match', aggregate: 'split',
            parts: [
              { category: 'Electronics', amountMinor: transaction.amountMinor - 3000, categorySource: 'agent-classification', classification: 'source', itemRef: 'item-a' },
              { category: 'Electronics', amountMinor: 500, categorySource: 'agent-classification', classification: 'policy-allocated', itemRef: 'item-a' },
              { category: 'Home', amountMinor: 1000, categorySource: 'item-override', classification: 'source', itemRef: 'item-b' },
              { category: transaction.issuerCategory, amountMinor: 1500, categorySource: 'original-effective', classification: 'residual' },
            ],
            items: [
              { itemRef: 'item-a', title: LONG_TITLE, quantity: 1, asin: 'B0SAMPLE11' },
              { itemRef: 'item-b', title: 'Sample wall hook', quantity: 3, asin: null },
              { itemRef: 'item-c', title: null, quantity: 1, asin: 'B0SAMPLE12' },
            ],
            orderRefs: ['order-sample-1'], coverage: { complete: false },
          } } });
        }
        if (transaction.description === 'HOTEL SAMPLE LISBOA') {
          return route.fulfill({ response, json: { ...body, amazon: {
            version: 'amazon-v1-sample', match: 'held', aggregate: 'whole-row-declined', wholeRowReason: 'match-held',
            hold: { reason: 'match-held', candidateCount: 2 }, coverage: { complete: false },
          } } });
        }
        if (transaction.description === 'LITWARE BOOKS') {
          return route.fulfill({ response, json: { ...body, transaction: { ...body.transaction, userCategory: LONG_CATEGORY }, amazon: {
            version: 'amazon-v1-sample', match: 'linked', evidenceClass: 'payment-event', aggregate: 'whole-row-user-category',
            parts: [{ category: 'Books', amountMinor: transaction.amountMinor, categorySource: 'agent-classification', classification: 'source', itemRef: 'item-d' }],
            items: [{ itemRef: 'item-d', title: 'Sample hardcover notebook', quantity: 2, asin: 'B0SAMPLE13' }],
            orderRefs: ['order-sample-2'], coverage: { complete: false },
          } } });
        }
        return route.fulfill({ response });
      });
      await openSpending(page);
      // The card's own list, not the previous view's still on screen while it loads.
      await expect(rows(page).filter({ hasText: 'NORTHWIND GROCERY' })).toHaveCount(1);
      await rows(page).filter({ hasText: 'NORTHWIND GROCERY' }).locator('.spending-row-main').click();
      const dialog = page.getByRole('dialog', { name: 'NORTHWIND GROCERY' });
      const amazon = dialog.getByRole('region', { name: 'Amazon order' });
      await expect(amazon.locator('p')).toHaveText('Amazon order, tied by its order total only (lower evidence). Counted under its items’ categories.');
      await expect(amazon.locator('.spending-amazon-title')).toHaveText([LONG_TITLE, 'Sample wall hook', 'Item title not shown', 'Rest of the charge']);
      // $90.00 in all: the stand with its share of tax and shipping, three hooks, and the rest under the card's own category.
      await expect(amazon.locator('.spending-amazon-items li .num')).toHaveText(['$65.00', '$10.00', '', '$15.00']);
      await expect(amazon.locator('.spending-amazon-meta')).toHaveText([
        'Electronics (classified from its title) · ASIN B0SAMPLE11',
        'includes $5.00 of tax, shipping and discounts, shared by price',
        'Home (your category) · × 3',
        'ASIN B0SAMPLE12',
        'Groceries (the card’s own category)',
      ]);
      // The full name is in the page and its tooltip; on screen it is clamped, and nothing goes off the side.
      const title = amazon.locator('.spending-amazon-title').first();
      await expect(title).toHaveAttribute('title', LONG_TITLE);
      expect(await title.evaluate((element) => element.scrollHeight > element.clientHeight + 1)).toBe(true);
      expect(await dialog.locator('.spending-detail-body').evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
      // The order opens in the Amazon view, by its opaque ref (amazon.e2e.ts follows the link there).
      await expect(amazon.getByRole('link')).toHaveCount(1);
      await expect(amazon.getByRole('link', { name: 'Open the order in Amazon' })).toHaveAttribute('href', '#/everyday/amazon/orders/order-sample-1');

      await page.keyboard.press('Escape');
      await rows(page).filter({ hasText: 'HOTEL SAMPLE LISBOA' }).locator('.spending-row-main').click();
      const held = page.getByRole('dialog', { name: 'HOTEL SAMPLE LISBOA' }).getByRole('region', { name: 'Amazon order' });
      await expect(held).toHaveText('Amazon order on hold: more than one order or charge could match, so none is linked yet (2 possible orders). '
        + 'The charge counts whole, under its own category.');
      await expect(held.locator('li')).toHaveCount(0);
      // Only a linked order opens in the Amazon view.
      await expect(held.getByRole('link')).toHaveCount(0);

      // Kept whole under the owner's own category, however long a word it is: nothing goes off the side.
      await page.keyboard.press('Escape');
      await rows(page).filter({ has: page.locator('.spending-row-merchant', { hasText: /^LITWARE BOOKS$/ }) }).locator('.spending-row-main').click();
      const custom = page.getByRole('dialog', { name: 'LITWARE BOOKS' });
      await expect(custom.getByRole('region', { name: 'Amazon order' }).locator('p'))
        .toHaveText(`Amazon order, tied by its Amazon payment. Counted whole under your category, ${LONG_CATEGORY}.`);
      await expect(custom.locator('.spending-amazon-title')).toHaveText(['Sample hardcover notebook']);
      expect(await custom.locator('.spending-detail-body').evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    });
  }
});

test.describe('Spending tab (Amazon items in the list and the categories)', () => {
  // This test serves its own synthetic card data, split by the shared code the API uses (resolveCardCategorySplits,
  // summarizeCardSpending), so the categories, their totals and the list come from one answer: a charge split by its
  // Amazon items (by payment), one by the order total (lower evidence), one kept whole by the owner's own category,
  // a held one, an item returned (a refund split by its item, in a category of its own: a negative item contribution),
  // and plain charges in many categories.
  const LONG_TITLE = `Sample ultra-wide monitor stand, model SW-3420, ${'with an adjustable arm and a cable tray, '.repeat(10)}in black`;
  const ONLINE = 'Merchandise & Supplies-Internet Purchase';
  const VERSION = 'amazon-v1-e2e-items';
  const at = '2024-03-01T00:00:00.000Z';
  const account: CardAccount = {
    id: `card-acct-${'s'.repeat(32)}`, issuer: 'amex', owner: 'alex', nickname: `Items ${SUFFIX}`, last4: '0007', currency: 'USD',
    status: 'active', createdAt: at, updatedAt: at,
  };
  const owners = new Map([[account.id, account.owner]]);
  const id = (letter: string) => `card-txn-${letter.repeat(32)}`;
  const data: Array<[letter: string, date: string, amountMinor: number, description: string, issuerCategory: string, userCategory?: string]> = [
    ['a', '2024-03-04', 9000, 'AMAZON MKTPL*SAMPLE1', ONLINE],
    ['b', '2024-03-06', 4500, 'AMAZON.COM*SAMPLE2', ONLINE],
    ['c', '2024-03-08', 2500, 'AMAZON MKTPL*SAMPLE3', ONLINE, 'Gifts'],
    ['d', '2024-03-10', 3000, 'AMAZON MKTPL*SAMPLE4', ONLINE],
    ['e', '2024-03-12', 12000, 'NORTHWIND GROCERY', 'Groceries'],
    ['f', '2024-03-14', 11650, 'HOTEL SAMPLE LISBOA', 'Travel'],
    ['g', '2024-03-15', 4000, 'FABRIKAM FUEL', 'Fuel'],
    ['h', '2024-03-16', 2200, 'PROSEWARE BISTRO', 'Dining'],
    ['i', '2024-03-17', 1500, 'TAILSPIN CINEMA', 'Entertainment'],
    ['j', '2024-03-18', 800, 'SAMPLE PHARMACY', 'Health'],
  ];
  const transactions = [...data, ['k', '2024-03-19', -1500, 'AMAZON MKTPL*SAMPLE5', ONLINE] as const].map(([letter, transactionDate, amountMinor, description, issuerCategory, userCategory]): CardTransaction => ({
    id: id(letter), cardAccountId: account.id, source: 'e2e-sync', fingerprint: `e2e-items-${letter}`, transactionDate,
    postedDate: transactionDate, status: 'posted', amountMinor, currency: 'USD', kind: amountMinor < 0 ? 'refund' : 'purchase', description, issuerCategory,
    ...(userCategory ? { userCategory } : {}), createdAt: at, updatedAt: at,
  }));
  const item = (amountMinor: number, category: string, classification: 'source' | 'policy-allocated', itemRef: string,
    categorySource: 'agent-classification' | 'item-override' = 'agent-classification') =>
    ({ amountMinor, category, categorySource, classification, itemRef });
  const rest = (amountMinor: number) => ({ amountMinor, category: null, categorySource: null, classification: 'residual' as const });
  const answers = new Map<string, CardCategoryResolution>([
    [id('a'), { kind: 'split', cardTransactionId: id('a'), currency: 'USD', evidenceClass: 'payment-event', contributions: [
      item(6000, 'Electronics', 'source', 'item-a'), item(500, 'Electronics', 'policy-allocated', 'item-a'),
      item(1000, 'Home', 'source', 'item-b', 'item-override'), rest(1500),
    ] }],
    [id('b'), { kind: 'split', cardTransactionId: id('b'), currency: 'USD', evidenceClass: 'unique-total-match', contributions: [
      item(3000, 'Books', 'source', 'item-d'), item(500, 'Books', 'policy-allocated', 'item-d'), item(1000, 'Home', 'source', 'item-e'),
    ] }],
    [id('c'), { kind: 'split', cardTransactionId: id('c'), currency: 'USD', evidenceClass: 'payment-event', contributions: [
      item(2500, 'Books', 'source', 'item-f'),
    ] }],
    [id('d'), { kind: 'whole-row', cardTransactionId: id('d'), reason: 'match-held' }],
    [id('k'), { kind: 'split', cardTransactionId: id('k'), currency: 'USD', evidenceClass: 'payment-event', contributions: [
      item(-1500, 'Toys', 'source', 'item-g'),
    ] }],
  ]);
  const orders = new Map<string, { evidenceClass: string; items: unknown[]; orderRefs: string[] }>([
    [id('a'), { evidenceClass: 'payment-event', orderRefs: ['order-sample-1'], items: [
      { itemRef: 'item-a', title: LONG_TITLE, quantity: 1, asin: 'B0SAMPLE11' },
      { itemRef: 'item-b', title: 'Sample wall hook', quantity: 3, asin: null },
      { itemRef: 'item-c', title: null, quantity: 1, asin: 'B0SAMPLE12' },
    ] }],
    [id('b'), { evidenceClass: 'unique-total-match', orderRefs: ['order-sample-2'], items: [
      { itemRef: 'item-d', title: 'Sample hardcover notebook', quantity: 2, asin: null },
      { itemRef: 'item-e', title: 'Sample desk lamp', quantity: 1, asin: null },
    ] }],
    [id('c'), { evidenceClass: 'payment-event', orderRefs: ['order-sample-3'], items: [
      { itemRef: 'item-f', title: 'Sample gift box', quantity: 1, asin: null },
    ] }],
    [id('k'), { evidenceClass: 'payment-event', orderRefs: ['order-sample-5'], items: [
      { itemRef: 'item-g', title: 'Sample toy robot', quantity: 1, asin: null },
    ] }],
  ]);
  const KNOWN = new Set(['Electronics', 'Home', 'Books', 'Toys', ...data.map((entry) => entry[4])]);
  // The Amazon domain's rule for an Amazon card charge (a posted, positive purchase with an itemizable descriptor),
  // and whether Spending files it under item parts: as the API counts coverage.
  const isAmazonCharge = (row: CardTransaction) => row.status === 'posted' && row.kind === 'purchase' && row.amountMinor > 0
    && amazonCardChargeKind({ description: row.description }) === 'itemizable';
  const itemized = (row: CardTransaction, splits: ReturnType<typeof resolveCardCategorySplits>) =>
    splits.parts.get(row.id)?.some((part) => part.classification !== 'residual') ?? false;
  const coverageOf = (rows: CardTransaction[], splits: ReturnType<typeof resolveCardCategorySplits>) => {
    const amazon = rows.filter((row) => amazonCardChargeKind({ description: row.description }) !== null);
    return amazon.length === 0 ? [] : [{
      currency: 'USD',
      charges: amazon.filter(isAmazonCharge).length,
      itemized: amazon.filter((row) => isAmazonCharge(row) && itemized(row, splits)).length,
      notItemizable: 0, pending: 0, refunds: amazon.filter((row) => row.kind === 'refund').length, other: 0,
    }];
  };

  /** The Spending answers for a request, as the API builds them from the rows and the source's splits. */
  function answer(url: URL): unknown {
    const param = (name: string) => url.searchParams.get(name) ?? undefined;
    const enriched = param('categoryBasis') !== 'original';
    const inRange = transactions.filter((row) => row.transactionDate >= (param('from') ?? '0000-01-01') && row.transactionDate <= (param('to') ?? '9999-12-31'));
    const splits = resolveCardCategorySplits(inRange, {
      requested: enriched ? 'enriched' : 'original',
      snapshot: enriched ? { version: VERSION, resolve: (rows) => new Map([...answers].filter(([key]) => rows.some((row) => row.id === key))) } : null,
      knownCategories: KNOWN,
      isAllowedCategoryName: () => true,
    });
    const category = param('category');
    // What a row puts in the category asked for: its part there when split, else all of it under its own category.
    const portion = (row: CardTransaction) => {
      const parts = splits.parts.get(row.id);
      return parts ? cardCategoryPortion(parts, category ?? '') : toCardTransactionView(row).category === category ? row.amountMinor : 0;
    };
    const shown = category === undefined ? inRange : inRange.filter((row) => portion(row) !== 0);
    const marker = !enriched || category === undefined ? splits.marker : cardCategoryBasisMarkerFor(splits, shown.map((row) => row.id), category);
    if (url.pathname === '/card-accounts') return { cardAccounts: [account] };
    if (url.pathname === '/spending/coverage') return { cards: [] };
    if (url.pathname === '/spending/insights') {
      const [from, to, baselineFrom, baselineTo] = ['from', 'to', 'baselineFrom', 'baselineTo'].map(param);
      return computeCardInsights(transactions, {
        month: param('month') ?? '2024-03',
        today: param('today') ?? '2024-03-20',
        currency: 'USD',
        ...(from && to ? { period: { from, to, baseline: baselineFrom && baselineTo ? { from: baselineFrom, to: baselineTo } : null } } : {}),
      });
    }
    // The rows as the summary counts them (under a category filter, a split row's part there), and their category parts.
    const counted = shown.map((row) => (category !== undefined && splits.parts.has(row.id) ? { ...row, amountMinor: portion(row) } : row));
    const parts = category === undefined ? splits.parts : new Map(shown.filter((row) => splits.parts.has(row.id)).map((row) =>
      [row.id, [{ category, amountMinor: portion(row), categorySource: 'original-effective' as const, classification: 'source' as const }]]));
    // The overview's reads, classified as the API's compare and trend classify them: the summary's parts, with every
    // part of each split row; each window recorded for every day there is data for it.
    const today = param('today') ?? '2024-03-20';
    const classifyWith = { currency: 'USD', today, categoryParts: parts, fullParts: splits.parts, splitIds: new Set(splits.parts.keys()) };
    const recorded = (range: { from: string; to: string }) => {
      const withData = transactions.some((row) => row.transactionDate >= range.from && row.transactionDate <= range.to) ? 1 : 0;
      const inProgress = range.to >= today;
      return { complete: !inProgress && withData > 0, cardsWithData: withData, cardsExpected: withData, cardsCovered: withData,
        cardsStartingLater: 0, inProgress, uncoveredCardIds: [] };
    };
    if (url.pathname === '/spending/compare') {
      const [from, to, baselineFrom, baselineTo] = ['from', 'to', 'baselineFrom', 'baselineTo'].map((name) => param(name)!);
      const comparison = compareCardSpending(counted, { ...classifyWith, through: to, current: { from, to }, baseline: { from: baselineFrom, to: baselineTo } });
      return { basis: enriched ? 'enriched' : 'original', comparison: {
        ...comparison,
        current: { ...comparison.current, coverage: { from, to, ...recorded({ from, to }) } },
        baseline: { ...comparison.baseline, coverage: { from: baselineFrom, to: baselineTo, ...recorded({ from: baselineFrom, to: baselineTo }) } },
      } };
    }
    if (url.pathname === '/spending/trend') {
      const [fromMonth, toMonth] = [param('fromMonth')!, param('toMonth')!];
      const months: string[] = [];
      for (let month = fromMonth; month <= toMonth; month = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 7)) {
        months.push(month);
      }
      const classification = classifyCardSpending(counted, { ...classifyWith, through: today });
      const monthEnd = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
      return {
        basis: enriched ? 'enriched' : 'original', currency: 'USD', thresholdMinor: classification.thresholdMinor,
        months: cardSpendingTrend(classification, months).map((item) => ({ ...item, coverage: recorded({ from: `${item.month}-01`, to: monthEnd(item.month) }) })),
        gaps: { behind: [], startingLater: [] },
      };
    }
    if (url.pathname === '/spending/summary') {
      const fromItems = new Map<string, { currency: string; category: string; amountMinor: number; rows: number }>();
      for (const row of shown) {
        const seen = new Set<string>();
        for (const part of splits.parts.get(row.id) ?? []) {
          if (part.classification === 'residual' || (category !== undefined && part.category !== category)) continue;
          const entry = fromItems.get(part.category) ?? { currency: row.currency, category: part.category, amountMinor: 0, rows: 0 };
          entry.amountMinor += part.amountMinor;
          if (!seen.has(part.category)) entry.rows += 1;
          seen.add(part.category);
          fromItems.set(part.category, entry);
        }
      }
      return {
        ...summarizeCardSpending(counted, { owners, categoryParts: parts }), categories: [], categoryBasis: marker,
        ...(enriched ? { fromAmazonItems: [...fromItems.values()], amazonCoverage: coverageOf(inRange, splits) } : {}),
      };
    }
    if (url.pathname === '/card-transactions') {
      const statuses = (param('status') ?? 'pending,posted').split(',');
      const listed = shown.filter((row) => statuses.includes(row.status))
        .filter((row) => param('amazon') !== 'unitemized' || (isAmazonCharge(row) && !itemized(row, splits)))
        .filter((row) => param('currency') === undefined || row.currency === param('currency'))
        .sort((a, b) => (a.transactionDate < b.transactionDate ? 1 : -1));
      return {
        transactions: listed.map((row) => {
          const parts = splits.parts.get(row.id);
          const outcome = splits.outcomes.get(row.id);
          const order = enriched ? orders.get(row.id) : undefined;
          // A linked order, as the API lists it: split, or kept whole by the owner's category with the source's parts.
          const amazon = order && outcome && (outcome.kind === 'split' || outcome.kind === 'kept-whole-by-user-category') ? {
            version: VERSION, match: 'linked', evidenceClass: order.evidenceClass,
            aggregate: outcome.kind === 'split' ? 'split' : 'whole-row-user-category',
            ...(outcome.parts ? { parts: outcome.parts } : {}), items: order.items, orderRefs: order.orderRefs, coverage: { complete: false },
          } : undefined;
          return {
            ...toCardTransactionView(row),
            ...(parts ? { split: cardCategorySplitView(parts) } : {}),
            ...(enriched ? { categorySource: parts ? 'amazon' : row.userCategory ? 'user' : 'issuer' } : {}),
            ...(amazon ? { amazon } : {}),
            ...(category !== undefined ? { categoryPortionMinor: portion(row) } : {}),
          };
        }),
        total: listed.length, limit: 100, offset: 0, nextOffset: null, categoryBasis: marker,
      };
    }
    return null;
  }

  const cents = (text: string) => Math.round(Number(text.replace(/[^0-9.]/g, '')) * 100);

  for (const width of [1280, 390, 280]) {
    test(`shows a charge's Amazon items in the list and files the categories by them, adding up, at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.route((url) => /^\/(?:card-accounts|card-imports|card-transactions|spending)(?:[/?]|$)/.test(url.pathname), (route) => {
        const body = answer(new URL(route.request().url()));
        return route.fulfill(body === null
          ? { status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }) }
          : { status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      });
      await page.clock.setFixedTime(new Date('2024-03-20T12:00:00'));
      await page.goto('/');
      await page.getByRole('tab', { name: 'Spending' }).click();
      await expect(page.locator('.spending-month-label')).toHaveText('March 2024');
      await expect(card(page, 'spent')).toHaveText('$496.50');
      const noSideways = async () =>
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);

      // The one category view: Amazon items under their own categories, every category adding up to the spending.
      const view = categoryView(page);
      // The splits by evidence, under "About these categories": only the kinds that split a charge.
      await view.getByRole('button', { name: 'About these categories' }).click();
      await expect(view.locator('.spending-category-evidence'))
        .toHaveText('Amazon splits: 2 by payment · 1 by order total (lower evidence)');
      await expect(view.getByTestId('overview-amazon-items')).toHaveText('Includes $105.00 of Amazon items, each counted under its own category.');
      // The categories' own rows, not the merchant lines of one opened under them.
      const categoryRows = view.getByTestId('overview-categories').locator(':scope > li > .overview-row');
      await expect(categoryRows.locator('.overview-row-name')).toHaveText([
        'Groceries', 'Travel', 'Electronics', 'Merchandise', 'Fuel', 'Books', 'Gifts', 'Dining', 'Home', 'Entertainment', 'Health', 'Toys',
      ]);
      const signed = (text: string) => (/[−-]/.test(text) ? -1 : 1) * cents(text);
      const amounts = await categoryRows.locator('strong.num').allTextContents();
      expect(amounts.reduce((sum, text) => sum + signed(text), 0)).toBe(49650);
      // A row is its name, its net and its charges: what Amazon items contribute is said only once it is open, as their
      // signed amount and in how many charges, and nothing reads as moved, refunded or reclassified.
      const row = (name: string) => categoryRows.filter({ has: page.locator('.overview-row-name', { hasText: new RegExp(`^${name}$`) }) });
      const contribution = view.getByTestId('overview-item-contribution');
      await expect(row('Toys')).toHaveText(/^Toys1 charge[−-]\$15\.00$/);
      await expect(contribution).toHaveCount(0);
      await row('Toys').click();
      await expect(row('Toys')).toHaveText(/^Toys1 charge[−-]\$15\.00$/);
      await expect(contribution).toHaveText('Amazon item contribution−$15.00items in 1 charge');
      await expect(view.getByTestId('overview-category-detail')).not.toContainText(/moved|refund|reclassif/i);
      await row('Electronics').click();
      await expect(contribution).toHaveText('Amazon item contribution+$65.00items in 1 charge');
      await row('Home').click();
      await expect(contribution).toHaveText('Amazon item contribution+$20.00items in 2 charges');
      // No items in Groceries, and the kept-whole charge counts under the owner's own category, not its items'.
      await row('Groceries').click();
      await expect(contribution).toHaveCount(0);
      await row('Gifts').click();
      await expect(contribution).toHaveCount(0);
      await row('Gifts').click();
      await expect(view.getByTestId('overview-category-detail')).toHaveCount(0);
      // How many of the view's Amazon card charges are itemized, every other Amazon row said apart.
      const coverage = view.getByRole('group', { name: 'Amazon coverage' });
      await expect(coverage.locator('strong')).toHaveText('Amazon charges itemized: 2 of 4 (50%)');
      await expect(coverage.locator('.overview-help')).toHaveText('Not counted: 0 digital, subscription, tip or Amazon Pay · 0 pending · 1 refund');
      await noSideways();
      // The list: a split charge shows its items' categories, and its items with their amounts in place.
      const split = rows(page).filter({ hasText: 'AMAZON MKTPL*SAMPLE1' });
      await expect(split.locator('.spending-category')).toHaveText('Electronics +2');
      // Its name starts with what it shows, then the whole split: a voice command naming the label finds it.
      await expect(split.locator('.spending-category')).toHaveAttribute('aria-label',
        /^Electronics \+2: categories Electronics \$65\.00, Merchandise & Supplies-Internet Purchase \$15\.00, Home \$10\.00 for /);
      await expect(split.getByRole('button', { name: /^Electronics \+2/ })).toHaveCount(1);
      const toggle = split.getByRole('button', { name: /^Amazon · 3 items: / });
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(split.locator('.spending-row-amazon-items')).toHaveCount(0);
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      const order = split.locator('.spending-row-amazon-items');
      await expect(order.locator('p')).toHaveText('Amazon order, tied by its Amazon payment. Counted under its items’ categories.');
      await expect(order.locator('.spending-row-item-title')).toHaveText([LONG_TITLE, 'Sample wall hook', 'Item title not shown', 'Rest of the charge']);
      await expect(order.locator('.spending-row-item-amount')).toHaveText(['$65.00', '$10.00', '', '$15.00']);
      await expect(order.locator('.spending-row-item-meta')).toHaveText(['Electronics', '× 3 · Home', `${ONLINE} (the card’s own)`]);
      // The full name is in the page and its tooltip; on screen it is clamped, and nothing goes off the side.
      const title = order.locator('.spending-row-item-title').first();
      await expect(title).toHaveAttribute('title', LONG_TITLE);
      expect(await title.evaluate((element) => element.scrollHeight > element.clientHeight + 1)).toBe(true);
      await noSideways();
      await expect(rows(page).filter({ hasText: 'AMAZON.COM*SAMPLE2' }).locator('.spending-category')).toHaveText('Books +1');
      // Kept whole by the owner's own category: the order and why it counts whole, no split.
      const kept = rows(page).filter({ hasText: 'AMAZON MKTPL*SAMPLE3' });
      await expect(kept.locator('.spending-category')).toHaveText('Gifts');
      await kept.getByRole('button', { name: /^Amazon · 1 item: / }).click();
      await expect(kept.locator('.spending-row-amazon-items p'))
        .toHaveText('Amazon order, tied by its Amazon payment. Counted whole under your category, Gifts.');
      // A held match shows no order in the list; plain charges have none.
      await expect(rows(page).filter({ hasText: 'AMAZON MKTPL*SAMPLE4' }).locator('.spending-row-amazon')).toHaveCount(0);
      await expect(page.locator('.spending-row-amazon')).toHaveCount(4);
      await noSideways();
      // Closed again, the items go.
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(split.locator('.spending-row-amazon-items')).toHaveCount(0);

      // Narrowed to a category: the list shows the charges with a part there, for that part, its items there marked.
      await row('Electronics').click();
      await view.getByTestId('overview-category-detail').getByRole('button', { name: 'Filter this spending view' }).click();
      await expect(page.locator('.spending-chip.active')).toContainText('Category: Electronics');
      await expect(rows(page)).toHaveCount(1);
      const drilled = rows(page).first();
      await expect(drilled).toContainText('$65.00 in this category');
      await drilled.getByRole('button', { name: /^Amazon · 3 items: / }).click();
      await expect(drilled.locator('li.in-category .spending-row-item-title')).toHaveText([LONG_TITLE]);
      await expect(drilled.locator('li.in-category .spending-row-item-meta')).toHaveText('Electronics · in this category');
      await expect(categoryRows.locator('.overview-row-name')).toHaveText(['Electronics']);
      await row('Electronics').click();
      await expect(contribution).toHaveText('Amazon item contribution+$65.00items in 1 charge');
      // By merchant under the filter: the charge counts for its part here, and its charges add up to the row.
      await view.getByRole('button', { name: 'By merchant' }).click();
      const amazon = view.getByTestId('overview-merchant-rows').locator(':scope > li > .overview-row').first();
      await expect(amazon).toContainText('$65.00');
      await amazon.click();
      const merchantCharges = view.getByTestId('overview-merchant-detail').getByTestId('overview-transactions');
      await expect(merchantCharges.getByTestId('overview-line-total')).toHaveText('$65.00');
      await expect(merchantCharges).toContainText('adds up to the line');
      await view.getByRole('button', { name: 'By category' }).click();
      await noSideways();
      await page.getByRole('button', { name: 'Clear Category: Electronics' }).click();
      await expect(rows(page)).toHaveCount(11);

      // The coverage line lists exactly the charges it counts as not itemized, in its currency: one kept whole by the
      // owner's category, one held.
      await coverage.getByRole('button', { name: 'Show the 2 not itemized' }).click();
      await expect(page.locator('.spending-chip.active')).toHaveText('Amazon charges not itemized (USD)');
      await expect(rows(page)).toHaveCount(2);
      await expect(rows(page).filter({ hasText: 'AMAZON MKTPL*SAMPLE3' })).toHaveCount(1);
      await expect(rows(page).filter({ hasText: 'AMAZON MKTPL*SAMPLE4' })).toHaveCount(1);
      await noSideways();
      await page.getByRole('button', { name: 'Clear Amazon charges not itemized (USD)' }).click();
      await expect(rows(page)).toHaveCount(11);

      // The original categories: every charge under its own, no Amazon items anywhere, the same spending.
      await view.getByRole('button', { name: 'Original categories' }).click();
      await expect(view.locator('.spending-category-basis')).toHaveText('Categories: original card categories');
      await expect(page.locator('.spending-row-amazon')).toHaveCount(0);
      await expect(view.getByTestId('overview-amazon-items')).toHaveCount(0);
      await expect(view.getByRole('group', { name: 'Amazon coverage' })).toHaveCount(0);
      await row('Merchandise').click();
      await expect(contribution).toHaveCount(0);
      await expect(rows(page).filter({ hasText: 'AMAZON MKTPL*SAMPLE1' }).locator('.spending-category')).toHaveText('Merchandise');
      await expect(card(page, 'spent')).toHaveText('$496.50');
      const original = await categoryRows.locator('strong.num').allTextContents();
      expect(original.reduce((sum, text) => sum + signed(text), 0)).toBe(49650);
      await noSideways();
    });
  }
});
