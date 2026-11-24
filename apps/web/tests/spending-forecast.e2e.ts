import { expect, requireHealthyApi, test, type APIRequestContext, type Page, type Route } from './fixtures';
import {
  buildCardImportPayload,
  cardSpendingPatterns,
  forecastCardSpending,
  serializeCardImportPayload,
  type CardForecastRow,
  type CardImportDraftRow,
} from '@finance-tracker/shared';

/**
 * Spending's patterns and forecast, end to end on the disposable stack: synthetic card data (fictional merchants,
 * made-up amounts) imported through the API into card accounts of this file's own, then read in the page. The page
 * clock is fixed on October 22, 2026; the expected figures come from the shared engines over the same rows, the way
 * the API computes them, and the page must say exactly those.
 */

const SUFFIX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6) || 'fcast';
const NICKNAME = `Forecast ${SUFFIX}`;
const NEW_NICKNAME = `Newcard ${SUFFIX}`;
const STALE_NICKNAME = `Stale ${SUFFIX}`;
const MUTATION_HEADERS = { 'Content-Type': 'application/json', 'X-Holdr-Request': '1' };
const TODAY = '2026-10-22';
const GROCERIES = 'Merchandise & Supplies-Groceries';
const RESTAURANT = 'Restaurant-Restaurant';

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function monthsFrom(start: string, count: number): string[] {
  const index = Number(start.slice(0, 4)) * 12 + Number(start.slice(5, 7)) - 1;
  return Array.from({ length: count }, (_, offset) => `${Math.floor((index + offset) / 12)}-${String(((index + offset) % 12) + 1).padStart(2, '0')}`);
}

const daysIn = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
const date = (month: string, day: number) => `${month}-${String(day).padStart(2, '0')}`;

/**
 * Sixteen months through October 21, 2026: groceries every fourth day, the bistro on irregular days (busy in
 * September 2026), a monthly streaming bill, a large one-off in June 2026, and this month a pending charge and a
 * large one-off.
 */
function rows(): CardImportDraftRow[] {
  const amount = seeded(29);
  const list: CardImportDraftRow[] = [];
  for (const month of monthsFrom('2025-08', 15)) {
    const last = month === '2026-10' ? 21 : daysIn(month);
    for (let day = 1; day <= last; day += 4) {
      list.push({ transactionDate: date(month, day), amountMinor: 2_000 + Math.floor(amount() * 1_400), kind: 'purchase', description: 'SAMPLE GROCER #0012 SAMPLETOWN', issuerCategory: GROCERIES });
    }
    for (const day of month === '2026-09' ? [2, 4, 8, 11, 13, 17, 19, 22, 25, 28] : [2, 11, 13, 25]) {
      if (day > last) continue;
      list.push({ transactionDate: date(month, day), amountMinor: 4_000 + Math.floor(amount() * 1_200), kind: 'purchase', description: 'SAMPLE BISTRO SAMPLETOWN', issuerCategory: RESTAURANT });
    }
    list.push({ transactionDate: date(month, 6), amountMinor: 1_599, kind: 'purchase', description: 'SAMPLE STREAMING', issuerCategory: 'Entertainment-Other Entertainment' });
  }
  // July 2025, the record's first month, from its own made-up amounts so the months after it keep theirs.
  const july = seeded(31);
  for (let day = 1; day <= 31; day += 4) {
    list.push({ transactionDate: date('2025-07', day), amountMinor: 2_000 + Math.floor(july() * 1_400), kind: 'purchase', description: 'SAMPLE GROCER #0012 SAMPLETOWN', issuerCategory: GROCERIES });
  }
  for (const day of [2, 11, 13, 25]) {
    list.push({ transactionDate: date('2025-07', day), amountMinor: 4_000 + Math.floor(july() * 1_200), kind: 'purchase', description: 'SAMPLE BISTRO SAMPLETOWN', issuerCategory: RESTAURANT });
  }
  list.push({ transactionDate: '2025-07-06', amountMinor: 1_599, kind: 'purchase', description: 'SAMPLE STREAMING', issuerCategory: 'Entertainment-Other Entertainment' });
  list.push({ transactionDate: '2026-06-14', amountMinor: 380_000, kind: 'purchase', description: 'SAMPLE ELECTRONICS STORE', issuerCategory: 'Merchandise & Supplies-Electronics Stores' });
  list.push({ transactionDate: '2026-10-03', amountMinor: 250_000, kind: 'purchase', description: 'SAMPLE FURNITURE HALL', issuerCategory: 'Merchandise & Supplies-Furnishing' });
  list.push({ transactionDate: '2026-10-20', status: 'pending', amountMinor: 3_300, kind: 'purchase', description: 'SAMPLE BISTRO SAMPLETOWN', issuerCategory: RESTAURANT });
  return list;
}

function payload(list: CardImportDraftRow[], coverage: { start: string; end: string }): string {
  return serializeCardImportPayload(buildCardImportPayload({ source: 'e2e-sync', parserVersion: 'e2e@1', issuer: 'amex', currency: 'USD', coverage, rows: list }).payload);
}

async function createAccount(request: APIRequestContext, draft: Record<string, string>): Promise<string> {
  const created = await request.post('/card-accounts', { headers: MUTATION_HEADERS, data: JSON.stringify({ currency: 'USD', ...draft }) });
  expect(created.status(), await created.text()).toBe(201);
  return (await created.json() as { id: string }).id;
}

async function commit(request: APIRequestContext, cardAccountId: string, json: string): Promise<void> {
  const committed = await request.post(`/card-imports/commit?cardAccountId=${cardAccountId}`, { headers: MUTATION_HEADERS, data: json });
  expect(committed.status(), await committed.text()).toBe(201);
}

const whole = (minor: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0, minimumFractionDigits: 0 }).format(minor / 100);
const cents = (minor: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(minor / 100);

/** What the API computes for a card from its rows, given the months its record holds in full and whether this month's so far is. */
function computed(list: CardImportDraftRow[], completeMonths: readonly string[], monthSoFarComplete: boolean) {
  const asRows: CardForecastRow[] = list.map((row, index) => ({
    id: `e2e-${index}`, cardAccountId: 'card', transactionDate: row.transactionDate, status: row.status ?? 'posted', amountMinor: row.amountMinor,
    currency: 'USD', kind: row.kind, description: row.description, merchant: null, issuerCategory: row.issuerCategory ?? null, userCategory: null,
  }));
  const input = { today: TODAY, currency: 'USD', completeMonths: new Set(completeMonths), monthSoFarComplete };
  return { forecast: forecastCardSpending(asRows, input), patterns: cardSpendingPatterns(asRows, input) };
}

/** What the API computes for the card, from the same rows: February 28, 2026 is a gap in its record. */
function expected() {
  return computed(rows(), monthsFrom('2025-07', 15).filter((month) => month !== '2026-02'), true);
}

/** The card whose statements stop in May 2026: January to May complete, and nothing of October recorded. */
function expectedStale() {
  return computed(rows().filter((row) => row.transactionDate >= '2026-01-01' && row.transactionDate <= '2026-05-31'), monthsFrom('2026-01', 5), false);
}

async function openSpending(page: Page, label: string, options: { scroll?: boolean } = {}): Promise<void> {
  await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00`));
  await page.goto('/');
  await page.getByRole('tab', { name: 'Spending' }).click();
  await expect(page.getByRole('region', { name: 'Spending', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Card' }).selectOption({ label });
  // The panel reads its answers once it is near the screen with the tab's own answers in.
  if (options.scroll !== false) await scrollToPanel(page);
}

const panel = (page: Page) => page.getByRole('region', { name: 'Patterns and forecast' });

/** Scrolls to the panel as a reader would, again while the page above it is still growing, until it shows its answers. */
async function scrollToPanel(page: Page): Promise<void> {
  await expect(async () => {
    await panel(page).scrollIntoViewIfNeeded();
    await expect(panel(page).locator('[data-forecast="pace"]')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

/** The panel's one fold: how the estimates were made. */
const howToggle = (page: Page) => panel(page).getByRole('button', { name: 'How this was estimated' });

/** What the panel reads at 16px (D1): its sentences, the lead and its parts, the table's rows, the bills, the caveats. */
const READ = [
  '.forecast-lead h4', '.forecast-card h4', '.forecast-figure-label', '.forecast-sentences:not(.forecast-help):not(.forecast-status) > li',
  '.forecast-parts dt', '.forecast-parts dd', '.forecast-caveats', '.forecast-caveat-cards', '.forecast-gaps li', '.forecast-table tbody th',
  '.forecast-table tbody td > .num:first-child', '.forecast-table td.forecast-none', '.forecast-bill-merchant', '.forecast-bill-amount',
  '.forecast-how-body h4', '.forecast-how-text', '.spending-error',
].join(', ');

/**
 * The panel's type, as computed (D1): no visible text under 14px (help, labels, status and links included), what is read
 * at 16px or more, every running text (reading, help, notes, status, warnings) at a line-height of 1.5 or more (only the
 * headings and the lead's figure may be tighter), every paragraph at most 65ch wide, and the heading at 18px (20px from
 * 1280px wide).
 */
async function expectTypeFloors(page: Page, state: string): Promise<void> {
  const found = await panel(page).evaluate((root, read) => {
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      return element.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const leadingOf = (style: CSSStyleDeclaration) => parseFloat(style.lineHeight) / parseFloat(style.fontSize);
    const small: string[] = [];
    const tight: string[] = [];
    let texts = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? '').trim();
      const element = node.parentElement;
      if (!text || !element || !visible(element)) continue;
      texts += 1;
      const style = getComputedStyle(element);
      const size = parseFloat(style.fontSize);
      if (size < 14) small.push(`${size}px: ${text.slice(0, 50)}`);
      // Headings and the lead's figure (one short line each) may be tighter; running text may not ("normal" fails too).
      if (!element.closest('h3, h4, .forecast-figure-value') && !(leadingOf(style) >= 1.49)) {
        tight.push(`${size}px/${style.lineHeight}: ${text.slice(0, 50)}`);
      }
    }
    const unread: string[] = [];
    let reads = 0;
    for (const element of root.querySelectorAll(read)) {
      if (!visible(element) || !(element.textContent ?? '').trim()) continue;
      reads += 1;
      const style = getComputedStyle(element);
      const size = parseFloat(style.fontSize);
      if (size < 16) unread.push(`${size}px: ${(element.textContent ?? '').trim().slice(0, 50)}`);
    }
    const heading = parseFloat(getComputedStyle(root.querySelector('h3')!).fontSize);
    // Paragraphs at most 65ch wide, as CSS resolves 65ch in the paragraph's own font (the readability sweep's measure).
    const wide: string[] = [];
    for (const p of root.querySelectorAll('p')) {
      if (!visible(p) || !(p.textContent ?? '').trim()) continue;
      const probe = document.createElement('span');
      probe.style.cssText = 'position: absolute; visibility: hidden; width: 65ch; height: 0; margin: 0; padding: 0; border: 0;';
      p.appendChild(probe);
      const measure = probe.getBoundingClientRect().width;
      probe.remove();
      const style = getComputedStyle(p);
      const content = p.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
        - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
      if (content > measure + 1) wide.push(`${Math.round(content)}px > ${Math.round(measure)}px: ${(p.textContent ?? '').trim().slice(0, 50)}`);
    }
    return { small, tight, unread, wide, texts, reads, heading };
  }, READ);
  expect(found.texts, `${state}: texts read`).toBeGreaterThan(0);
  expect(found.small, `${state}: text under 14px`).toEqual([]);
  expect(found.unread, `${state}: what is read, under 16px`).toEqual([]);
  expect(found.tight, `${state}: running text under a 1.5 line-height`).toEqual([]);
  expect(found.wide, `${state}: paragraphs wider than 65ch`).toEqual([]);
  expect(found.heading, `${state}: the panel's heading`).toBeGreaterThanOrEqual(page.viewportSize()!.width >= 1280 ? 20 : 18);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  await requireHealthyApi(request);
  const account = await createAccount(request, { issuer: 'amex', owner: 'alex', nickname: NICKNAME, last5: '90004' });
  const list = rows();
  await commit(request, account, payload(list.filter((row) => row.transactionDate <= '2026-02-27'), { start: '2025-07-01', end: '2026-02-27' }));
  await commit(request, account, payload(list.filter((row) => row.transactionDate >= '2026-03-01'), { start: '2026-03-01', end: '2026-10-21' }));
  const fresh = await createAccount(request, { issuer: 'amex', owner: 'casey', nickname: NEW_NICKNAME, last5: '90005' });
  await commit(request, fresh, payload(list.filter((row) => row.transactionDate >= '2026-08-01'), { start: '2026-08-01', end: '2026-10-21' }));
  // A card whose statements stop in May 2026: no later month of its own can be complete.
  const stale = await createAccount(request, { issuer: 'amex', owner: 'joint', nickname: STALE_NICKNAME, last5: '90006' });
  await commit(request, stale, payload(list.filter((row) => row.transactionDate >= '2026-01-01' && row.transactionDate <= '2026-05-31'), { start: '2026-01-01', end: '2026-05-31' }));
});

test.describe('Spending tab (patterns and forecast)', () => {
  test.use({ viewport: { width: 1280, height: 1000 } });

  test('leads with this month\'s estimate and its range beside it, then the answers one to a line; only how they were made is folded', async ({ page }) => {
    const { forecast, patterns } = expected();
    const pace = forecast.pace;
    const total = forecast.total!;
    const label = `Amex ${NICKNAME} ··90004 · Alex`;
    await openSpending(page, label);
    await expect(panel(page)).toBeVisible();

    // The scope: whose cards, that these are estimates, which of the tab's filters apply, and what no figure here holds.
    await expect(panel(page).locator('.forecast-scope')).toHaveText(
      `Estimates as of Oct 22, for ${label}. Person and card apply; the period, search, category and merchant filters don't. `
      + 'Confirmed precious-metal purchases are excluded from every figure here, including the month total with one-offs.',
    );

    // The lead, with the fold closed: the estimate of spending without large one-offs, labelled an estimate, with its 80%
    // range beside it; then the month's parts, each labelled with what it holds, and what is pending.
    await expect(howToggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(panel(page).locator('[data-forecast="how"]')).toHaveCount(0);
    const lead = panel(page).locator('[data-forecast="pace"]');
    await expect(lead.getByRole('heading', { level: 4 })).toHaveText('This month: spending without large one-offs');
    const figure = lead.locator('[data-figure="everyday-estimate"]');
    await expect(figure).toHaveText(`${whole(pace.everydayProjectedMinor!)} estimate for all of October 2026 · 80% range `
      + `${whole(pace.everydayRange80!.lowerMinor)}–${whole(pace.everydayRange80!.upperMinor)}`);
    // Beside it: on the figure's line, to its right.
    const value = await figure.locator('.forecast-figure-value').boundingBox();
    const range = await figure.locator('[data-range="80"]').boundingBox();
    expect(range!.x, 'the range sits right of the estimate').toBeGreaterThanOrEqual(value!.x + value!.width);
    expect(range!.y < value!.y + value!.height && range!.y + range!.height > value!.y, 'the range sits on the estimate\'s line').toBe(true);
    const part = (name: string) => lead.locator(`[data-part="${name}"]`);
    await expect(part('everyday-so-far')).toHaveText(`So far, through Oct 22${cents(pace.everydaySpentMinor)}`);
    await expect(part('typical')).toHaveText(`A typical month${cents(pace.typicalMinor!)}`);
    await expect(part('one-offs-so-far')).toHaveText('Large one-offs so far, as posted$2,500.00');
    await expect(part('month-total').locator('dt')).toHaveText('Month total with those one-offs, estimate');
    await expect(part('month-total').locator('dd')).toHaveText(`${whole(pace.projectedMinor!)}80% range `
      + `${whole(pace.projectedRange80!.lowerMinor)}–${whole(pace.projectedRange80!.upperMinor)}`);
    expect(pace.projectedMinor).toBe(pace.everydayProjectedMinor! + 250_000);
    await expect(lead.locator('[data-template="pace-pending"]')).toHaveText('Another $33.00 is pending in October 2026, not counted until it posts.');
    // The missing history, under the lead and outside the fold.
    await expect(panel(page).locator('[data-forecast="caveats"] [data-template="partial-months"]')).toHaveText(
      '1 of the 15 months from July 2025 to September 2026 had partial card data and is not used.',
    );
    await expect(panel(page).locator('[data-forecast="caveats"]')).toBeVisible();

    // The next three months: all of it first, then each category, each month's estimate with its 80% range under it.
    const months = panel(page).getByRole('table');
    await expect(months.getByRole('columnheader')).toHaveText(['Spending without large one-offs', 'Nov 2026', 'Dec 2026', 'Jan 2027']);
    await expect(panel(page).locator('[data-template="forecast-ranged"]')).toHaveText(
      `Estimate for November 2026: ${whole(total.months[0].pointMinor)} of spending without large one-offs, with an 80% range of `
      + `${whole(total.months[0].range80!.lowerMinor)} to ${whole(total.months[0].range80!.upperMinor)}.`,
    );
    const firstRow = months.getByRole('row').nth(1);
    await expect(firstRow.getByRole('rowheader')).toHaveText('All of it');
    await expect(firstRow.getByRole('cell').first()).toHaveText(
      `${whole(total.months[0].pointMinor)}${whole(total.months[0].range80!.lowerMinor)}–${whole(total.months[0].range80!.upperMinor)}`,
    );
    // Its 95% range, said with what it is (widened from the 80% one) and how it tested.
    const range95 = total.months[0].range95!;
    expect(range95.basis).toBe('extended');
    const range95Text = `Estimate for November 2026: ${whole(total.months[0].pointMinor)}, with a 95% range of ${whole(range95.lowerMinor)} to `
      + `${whole(range95.upperMinor)}, widened from the 80% range (too few past estimates for its own); ${range95.coverage.inside} of `
      + `${range95.coverage.tested} past estimates fell inside their 95% ranges.`;
    await expect(firstRow.getByRole('cell').first()).toHaveAttribute('title', range95Text);
    await expect(months.getByRole('rowheader')).toHaveText(['All of it', ...forecast.categories.map(() => /.+/)]);
    await expect(panel(page).locator('[data-forecast="months"] [data-note="rows"]')).toHaveText(
      'Each row is its own estimate, so the categories don\'t add up to All of it.',
    );
    // Every row has its range: nothing to say of one missing.
    await expect(panel(page).locator('[data-forecast="months"] [data-note="no-range"]')).toHaveCount(0);

    // Unusual: the bistro in September 2026, against its twelve complete months before.
    const restaurant = patterns.anomalies.find((item) => item.category === RESTAURANT && item.window === 'month')!;
    await expect(panel(page).locator('[data-forecast="unusual"]')).toContainText(
      `Restaurant: ${cents(restaurant.amountMinor)} in September 2026, above its median of ${cents(restaurant.medianMinor)} over the 12 complete months before.`,
    );

    // Bills: the streaming bill's next two charges, adding up, each with its rhythm.
    expect(patterns.bills.activeCharges, 'the scenario has one recurring charge').toBe(1);
    const bills = panel(page).locator('[data-forecast="bills"]');
    await expect(bills.locator('[data-template="bills-window"]')).toHaveText(
      `Estimate: ${whole(patterns.bills.totalMinor)} in recurring bills from Oct 22 to Dec 21, ${patterns.bills.count} charges at their usual amounts.`,
    );
    await expect(bills.locator('[data-template="bills-this-month-charged"]')).toHaveText(
      'Recurring bills in October 2026: $15.99 charged so far from 1 charge, and none due again this month.',
    );
    const dueList = bills.getByRole('list', { name: 'Recurring bills due' });
    await expect(dueList.getByRole('listitem')).toHaveCount(patterns.bills.count);
    await expect(dueList.getByRole('listitem').first().locator('.forecast-bill-date')).toHaveText('Nov 5');
    await expect(dueList.getByRole('listitem').first().locator('.forecast-bill-note')).toHaveText('monthly');
    // What shows a bill bills is evidence: folded, with the method.
    await expect(panel(page).locator('[data-template="bill-evidence"]')).toHaveCount(0);
    for (const template of ['pace-everyday-ranged', 'pace-coverage', 'pace-total-ranged', 'fit-window', 'one-offs-left-out', 'method']) {
      await expect(panel(page).locator(`[data-template="${template}"]`), `${template} waits in the fold`).toHaveCount(0);
    }
    await expectTypeFloors(page, 'answered, fold closed');

    // The fold, from the keyboard: Enter opens it, Space closes it.
    await howToggle(page).focus();
    await page.keyboard.press('Enter');
    await expect(howToggle(page)).toHaveAttribute('aria-expanded', 'true');
    const how = panel(page).locator('[data-forecast="how"]');
    await expect(how).toBeVisible();
    await expect(how.locator('[data-template="pace-everyday-ranged"]')).toHaveText(
      `Estimate of spending without large one-offs for all of October 2026: ${whole(pace.everydayProjectedMinor!)}, with an 80% range of `
      + `${whole(pace.everydayRange80!.lowerMinor)} to ${whole(pace.everydayRange80!.upperMinor)}, from ${cents(pace.everydaySpentMinor)} spent through `
      + 'Oct 22 plus a typical rest of the month from the last 12 complete months.',
    );
    await expect(how.locator('[data-template="pace-coverage"]')).toHaveText(
      `Tested on those 12 complete months: the rest of the month fell inside the 80% range the other months gave in ${pace.everydayRange80!.coverage.inside} of 12.`,
    );
    await expect(how.locator('[data-template="pace-total-ranged"]')).toHaveText(
      `Estimate for all of October 2026 with the $2,500.00 of large one-offs already posted, counted once and not projected: ${whole(pace.projectedMinor!)}, `
      + `with an 80% range of ${whole(pace.projectedRange80!.lowerMinor)} to ${whole(pace.projectedRange80!.upperMinor)}.`,
    );
    // What the estimates learn from, and what they leave out, in numbers.
    await expect(how.locator('[data-template="fit-window"]')).toHaveText(
      'Estimates are fitted on 14 complete months, July 2025 to September 2026, each with every card\'s record in full.',
    );
    await expect(how.locator('[data-template="one-offs-left-out"]')).toHaveText(
      `Estimates leave out large one-off purchases of ${cents(forecast.oneOffThresholdMinor)} or more: 1 purchase for $3,800.00 in the 14 complete months fitted.`,
    );
    // Each row's method, and the total's tests and 95% ranges, in words a touch screen can read.
    await expect(how.locator('[data-template="method"]').first()).toContainText('All of it: ');
    await expect(how.locator('[data-template^="method"]')).toHaveCount(1 + forecast.categories.length);
    await expect(how.locator('[data-template="range95"]').first()).toHaveText(range95Text);
    await expect(how.locator('[data-template="bill-evidence"]')).toHaveText(['Seen 13 times, October 2025 to October 2026.']);
    await expect(how.locator('[data-template="anomaly-method"]')).toBeVisible();
    await expectTypeFloors(page, 'answered, fold open');
    await page.keyboard.press('Space');
    await expect(howToggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(how).toHaveCount(0);
    await expect(howToggle(page)).toBeFocused();

    // A category filters the tab.
    await months.getByRole('button', { name: /^Show / }).first().click();
    await expect(page.locator('.spending-active-filters')).toContainText(`Category: ${forecast.categories[0].category}`);
  });

  test('says there is no forecast yet, and why, in numbers', async ({ page }) => {
    await openSpending(page, `Amex ${NEW_NICKNAME} ··90005 · Casey`);
    await expect(panel(page).locator('[data-template="forecast-none"]')).toHaveText(
      'No forecast yet: it needs 3 complete months of card data, and there are 2 through September 2026.',
    );
    // The lead shows what was spent, never an estimate it has not got, and says what one needs, outside the fold.
    const lead = panel(page).locator('[data-forecast="pace"]');
    await expect(lead.locator('[data-figure="everyday-estimate"]')).toHaveCount(0);
    await expect(lead.locator('[data-figure="everyday-so-far"]')).toHaveText(/^\$[\d,]+\.\d\d spent through Oct 22 · no estimate yet$/);
    await expect(lead.locator('[data-template="pace-spent-only"]')).toHaveText(
      'No estimate for all of October 2026 yet: it needs 3 complete months of card data, and there are 2.',
    );
    await expect(howToggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(panel(page).getByRole('table')).toHaveCount(0);
    await expectTypeFloors(page, 'no forecast yet');
  });

  test('says why months can\'t count, naming the card whose statements stop, and the fix', async ({ page }) => {
    const label = `Amex ${STALE_NICKNAME} ··90006 · Joint`;
    const { pace } = expectedStale().forecast;
    await openSpending(page, label);
    // Five complete months, January to May 2026: an untested estimate, no range, nothing compared yet.
    await expect(panel(page).locator('[data-template="forecast-untested"]')).toBeVisible();
    await expect(panel(page).locator('[data-template="anomaly-wait"]')).toBeVisible();
    // The caveats, with the fold closed: which months can't count, and how many cards keep them from it; which cards and
    // why are one link away, folded with the method, so a long list of cards never walls off the answers...
    await expect(howToggle(page)).toHaveAttribute('aria-expanded', 'false');
    const caveats = panel(page).locator('[data-forecast="caveats"]');
    await expect(caveats.locator('[data-template="partial-months"]')).toHaveText(
      '4 of the 9 months from January 2026 to September 2026 had partial card data and are not used.',
    );
    await expect(caveats.locator('[data-caveat="cards"]')).toHaveText('1 card in view keeps some months from counting yet. Which cards, and why');
    await expect(panel(page).getByRole('group', { name: 'Why months can\'t count yet' })).toHaveCount(0);
    await caveats.getByRole('button', { name: 'Which cards, and why' }).click();
    await expect(howToggle(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(panel(page).locator('#forecast-how-gaps')).toBeFocused();
    const gaps = panel(page).locator('[data-forecast="how"]').getByRole('group', { name: 'Why months can\'t count yet' });
    await expect(gaps.getByRole('listitem')).toHaveText([
      `No statements imported after May 31, 2026 for ${label}`,
      'To count those months, import recent statements, or mark cards no longer used as closed',
    ]);
    await expectTypeFloors(page, 'months that can\'t count, fold open at the cards');
    await howToggle(page).click();
    await expect(gaps).toHaveCount(0);
    // ...and this month's record, short: what is recorded so far is no measure of what was spent, and the lead says so
    // under its figure, with what its range still needs.
    const lead = panel(page).locator('[data-forecast="pace"]');
    expect(pace.monthSoFarComplete === false && pace.everydaySpentMinor === 0 && pace.everydayProjectedMinor !== null).toBe(true);
    await expect(lead.locator('[data-part="everyday-so-far"]')).toHaveText('Recorded so far, through Oct 22$0.00');
    await expect(lead.locator('[data-part="one-offs-so-far"]')).toHaveText('Large one-offs recorded so far$0.00');
    await expect(lead.locator('.forecast-limits [data-template="pace-record-incomplete"]')).toHaveText(
      'Some cards\' records for October 2026 are not complete yet, so the $0.00 recorded so far, and the estimate built on it, may be low.',
    );
    await expect(lead.locator('[data-figure="everyday-estimate"]')).toHaveText(
      `${whole(pace.everydayProjectedMinor!)} estimate for all of October 2026 · no range yet`,
    );
    await expect(lead.locator('.forecast-limits [data-template="pace-no-range"]')).toHaveText(
      `An 80% range for October 2026 needs 10 complete months of card data, and there are ${pace.historyMonths}.`,
    );
    // The table's rows have no range yet: the cells say so, and what one needs is said beside them, unfolded.
    await expect(panel(page).getByRole('table').locator('.forecast-cell-range').first()).toHaveText('no range yet');
    await expect(panel(page).locator('[data-forecast="months"] [data-note="no-range"]')).toHaveText(
      '“No range yet”: a range needs past estimates in 10 complete months to test it on.',
    );
    await expectTypeFloors(page, 'months that can\'t count');
    // A view whose answers need nothing more says nothing of it.
    await page.getByRole('combobox', { name: 'Card' }).selectOption({ label: `Amex ${NICKNAME} ··90004 · Alex` });
    await expect(panel(page).locator('[data-template="forecast-ranged"]')).toBeVisible({ timeout: 20_000 });
    await expect(panel(page).locator('[data-caveat="cards"]')).toHaveCount(0);
    await howToggle(page).click();
    await expect(panel(page).locator('[data-forecast="how"]')).toBeVisible();
    await expect(panel(page).getByRole('group', { name: 'Why months can\'t count yet' })).toHaveCount(0);
    await expect(panel(page).locator('[data-template="pace-record-incomplete"]')).toHaveCount(0);
  });

  test('never shows one card\'s answer under another: a new card waits, busy, and a failed read leaves no old figures', async ({ page }) => {
    await openSpending(page, `Amex ${NICKNAME} ··90004 · Alex`);
    await expect(panel(page).locator('[data-template="forecast-ranged"]')).toBeVisible();
    await expect(panel(page)).toHaveAttribute('aria-busy', 'false');
    const held: Route[] = [];
    await page.route((url) => url.pathname === '/spending/forecast' || url.pathname === '/spending/patterns', (route) => { held.push(route); });
    await page.getByRole('combobox', { name: 'Card' }).selectOption({ label: `Amex ${NEW_NICKNAME} ··90005 · Casey` });
    // The panel reads once the tab's own answers for that card are in.
    await expect.poll(() => held.length, { timeout: 20_000 }).toBe(2);
    // The other card's answers are on their way: nothing of the first card shows, and the panel says it is busy.
    await expect(panel(page)).toHaveAttribute('aria-busy', 'true');
    await expect(panel(page).locator('[data-forecast]')).toHaveCount(0);
    await expect(panel(page).getByTestId('forecast-looking')).toBeVisible();
    // The scope already names the card in view.
    await expect(panel(page).locator('.forecast-scope')).toContainText(`for Amex ${NEW_NICKNAME} ··90005 · Casey.`);
    await expectTypeFloors(page, 'reading');
    // They fail: the error, still no figures of the first card, and no longer busy.
    for (const route of held.splice(0)) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable' }) });
    }
    await expect(panel(page).getByRole('status')).toBeVisible();
    await expect(panel(page)).toHaveAttribute('aria-busy', 'false');
    await expect(panel(page).locator('[data-forecast]')).toHaveCount(0);
    await expect(panel(page).getByTestId('forecast-looking')).toHaveCount(0);
    await expectTypeFloors(page, 'refused');
  });

  test('reads a refused view again when it comes back: only its latest attempt decides what shows, busy while it runs', async ({ page }) => {
    const alex = `Amex ${NICKNAME} ··90004 · Alex`;
    const casey = `Amex ${NEW_NICKNAME} ··90005 · Casey`;
    const FORECAST = '/spending/forecast';
    const PATTERNS = '/spending/patterns';
    await openSpending(page, alex);
    await expect(panel(page).locator('[data-template="forecast-ranged"]')).toBeVisible();
    const held: Route[] = [];
    await page.route((url) => url.pathname === FORECAST || url.pathname === PATTERNS, (route) => { held.push(route); });
    const card = page.getByRole('combobox', { name: 'Card' });
    const refusal = panel(page).locator('.spending-error');
    const pathOf = (route: Route) => new URL(route.request().url()).pathname;
    const cardOf = (route: Route) => new URL(route.request().url()).searchParams.get('cardAccountId');
    /** The panel's two reads for the card in view, once both are held. */
    const reads = async (): Promise<Route[]> => {
      await expect.poll(() => held.length, { timeout: 20_000 }).toBe(2);
      return held.splice(0);
    };
    const refuse = (route: Route, message: string) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: message }) });
    const busyShowingNothing = async () => {
      await expect(panel(page)).toHaveAttribute('aria-busy', 'true');
      await expect(refusal).toHaveCount(0);
      await expect(panel(page).locator('[data-forecast]')).toHaveCount(0);
    };
    const answered = async () => {
      await expect(panel(page).locator('[data-forecast="pace"]')).toBeVisible();
      await expect(panel(page)).toHaveAttribute('aria-busy', 'false');
      await expect(refusal).toHaveCount(0);
    };
    let caseyId: string | null = null;
    const refusecasey = async (message: string) => {
      await card.selectOption({ label: casey });
      const pair = await reads();
      caseyId = cardOf(pair[0]);
      for (const route of pair) await refuse(route, message);
      await expect(refusal).toHaveText([message]);
      await expect(panel(page)).toHaveAttribute('aria-busy', 'false');
      await expect(panel(page).locator('[data-forecast]')).toHaveCount(0);
    };
    const answerAlex = async () => {
      await card.selectOption({ label: alex });
      for (const route of await reads()) await route.continue();
      await answered();
      await expect(panel(page).locator('[data-template="forecast-ranged"]')).toBeVisible();
    };

    // The reviewer's sequence, once with each of the two answers first: A answered, B refused, A answered, then B
    // again with its reads held: busy and no refusal; then its answer, and still no refusal.
    for (const [first, second] of [[FORECAST, PATTERNS], [PATTERNS, FORECAST]]) {
      await refusecasey('Spending is unavailable for a moment.');
      await answerAlex();
      await card.selectOption({ label: casey });
      const pair = await reads();
      await busyShowingNothing();
      await pair.find((route) => pathOf(route) === first)!.continue();
      await busyShowingNothing();
      await pair.find((route) => pathOf(route) === second)!.continue();
      await answered();
      await expect(panel(page).locator('[data-template="forecast-none"]')).toBeVisible();
      await answerAlex();
    }

    // Refused again when it comes back: only the new refusal shows.
    await refusecasey('Spending is unavailable for a moment.');
    await answerAlex();
    await card.selectOption({ label: casey });
    for (const route of await reads()) await refuse(route, 'Spending is still unavailable.');
    await expect(refusal).toHaveText(['Spending is still unavailable.']);
    await expect(panel(page)).toHaveAttribute('aria-busy', 'false');

    // Back to it before any other card is read: the retry clears its refusal while it runs, and answers.
    await card.selectOption({ label: alex });
    await card.selectOption({ label: casey });
    const iscasey = (route: Route) => cardOf(route) === caseyId;
    await expect.poll(() => held.filter(iscasey).length, { timeout: 20_000 }).toBe(2);
    const retry = held.filter(iscasey);
    const other = held.filter((route) => !iscasey(route));
    held.length = 0;
    await busyShowingNothing();
    for (const route of retry) await route.continue();
    await answered();

    // Superseded attempts set nothing: refused once their card is no longer in view, the answer shown stays.
    const refuseSuperseded = async (routes: Route[]) => {
      for (const route of routes) await refuse(route, 'Too late.');
      await Promise.all(routes.map(async (route) => (await route.request().response())?.finished()));
      // A refusal from them would show by now.
      await page.waitForTimeout(300);
      await answered();
    };
    // The other card's reads, if the quick change started any.
    await refuseSuperseded(other);
    // B's reads, held, then superseded by a change back to A, whose answer is shown without reading it again.
    await answerAlex();
    await card.selectOption({ label: casey });
    const superseded = await reads();
    await busyShowingNothing();
    await card.selectOption({ label: alex });
    await answered();
    await expect(panel(page).locator('[data-template="forecast-ranged"]')).toBeVisible();
    await refuseSuperseded(superseded);
    await expect(panel(page).locator('[data-template="forecast-ranged"]')).toBeVisible();

    // B answered, A refused, then B refused: only B's new refusal shows, none of its earlier figures.
    await card.selectOption({ label: casey });
    for (const route of await reads()) await route.continue();
    await answered();
    await card.selectOption({ label: alex });
    for (const route of await reads()) await refuse(route, 'Spending is unavailable for this card.');
    await expect(refusal).toHaveText(['Spending is unavailable for this card.']);
    await card.selectOption({ label: casey });
    const last = await reads();
    await busyShowingNothing();
    for (const route of last) await refuse(route, 'Spending is unavailable for the other card.');
    await expect(refusal).toHaveText(['Spending is unavailable for the other card.']);
    await expect(panel(page)).toHaveAttribute('aria-busy', 'false');
    await expect(panel(page).locator('[data-forecast]')).toHaveCount(0);
    expect(held).toHaveLength(0);
  });
});

test.describe('Spending tab (patterns and forecast) below the fold', () => {
  test.use({ viewport: { width: 1280, height: 500 } });

  test('reads its answers only once it is near the screen, so a change of card never waits on them', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path === '/spending/forecast' || path === '/spending/patterns') asked.push(path);
    });
    await openSpending(page, `Amex ${NICKNAME} ··90004 · Alex`, { scroll: false });
    await expect(page.locator('[data-card="spent"] .spending-card-value')).toBeVisible();
    expect(asked).toEqual([]);
    await scrollToPanel(page);
    await expect(panel(page).locator('[data-template="forecast-ranged"]')).toBeVisible();
    expect([...asked].sort()).toEqual(['/spending/forecast', '/spending/patterns']);
  });
});

test.describe('Spending tab (patterns and forecast) on a phone', () => {
  test.use({ viewport: { width: 280, height: 900 } });

  test('fits a 280px screen: the table scrolls inside its card, nothing else overflows', async ({ page }) => {
    await openSpending(page, `Amex ${NICKNAME} ··90004 · Alex`);
    await expect(panel(page).getByRole('table')).toBeVisible();
    await expect(panel(page).locator('[data-forecast="bills"]').getByRole('list', { name: 'Recurring bills due' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    for (const card of ['pace', 'caveats', 'bills', 'unusual', 'months']) {
      expect(await panel(page).locator(`[data-forecast="${card}"]`).evaluate((element) => element.scrollWidth - element.clientWidth), card).toBeLessThanOrEqual(1);
    }
    await expectTypeFloors(page, '280px');
    // How it was estimated, open: it wraps too.
    await howToggle(page).click();
    await expect(panel(page).locator('[data-forecast="how"]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    expect(await panel(page).locator('[data-forecast="how"]').evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await expectTypeFloors(page, '280px, fold open');
    // The explanation, with a card's full name in it, wraps too: the caveat's line, and the cards behind it once opened.
    await page.getByRole('combobox', { name: 'Card' }).selectOption({ label: `Amex ${STALE_NICKNAME} ··90006 · Joint` });
    const cards = panel(page).locator('[data-caveat="cards"]');
    await expect(cards).toBeVisible({ timeout: 20_000 });
    expect(await panel(page).locator('[data-forecast="caveats"]').evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await cards.getByRole('button', { name: 'Which cards, and why' }).click();
    await expect(panel(page).locator('[data-forecast="gaps"]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    expect(await panel(page).locator('[data-forecast="gaps"]').evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await expectTypeFloors(page, '280px, the cards behind the missing months');
  });
});
