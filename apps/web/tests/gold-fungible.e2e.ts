import type { MetalsOverview, MetalsRead } from '@finance-tracker/shared/metals-api';

import { expect, requireHealthyApi, test, type APIRequestContext, type Locator, type Page } from './fixtures';
import { longDate, metalsStack, type MetalsStack } from './metalsStack';

/**
 * Investing › Gold under the owner's fungible policy (`HOLDR_METALS_FUNGIBLE=XAU`, contract `MetalsAssignmentMethod`),
 * as Holdr reads after the owner's flip: the synthetic ledger of gold.e2e.ts (tests/metalsStack.ts, through the
 * operator's real install and import) on a disposable stack whose API runs with the policy set. gold.e2e.ts and
 * readability.e2e.ts hold metals-assignment-v1's words, so this file runs on its own stack, the switch set for that run
 * alone (the runner hands its environment to the API):
 *
 *   HOLDR_METALS_FUNGIBLE=XAU npm run test:e2e -- gold-fungible.e2e.ts
 *   PowerShell: $env:HOLDR_METALS_FUNGIBLE = 'XAU'; npm run test:e2e -- gold-fungible.e2e.ts
 *               Remove-Item Env:HOLDR_METALS_FUNGIBLE
 *
 * Without the switch every test here skips. With it: the API serves the policy for gold alone; gold's classes take every
 * form together, under a heading that says so, and the Walmart coin a sale took while it awaited delivery counts as
 * delivered, said right under its class's sum; a sale's note, the period's method and the declared method say "across
 * all forms (your rule)"; silver, which the policy doesn't name, keeps metals-assignment-v1's words. At 375 and 1920 px
 * the new lines stay inside the page, captured for review. Synthetic orders, titles and amounts only.
 */

const POLICY = { rule: 'metals-assignment-v1+fungible', fungible: ['XAU'] };
// The page's words, pinned here rather than read from goldText.ts.
const INFERRED = '1 unit counts as delivered because a sale took it (your rule); no delivery is recorded for it';
const NOTE = 'Purchases assigned oldest first across all forms (your rule) — not a confirmed physical match.';
const METHOD = `${NOTE} Within each kind of item (metal and fine content per unit, every form together), the earliest purchase not `
  + 'yet assigned goes to each sale; a unit a sale took before its delivery was recorded counts as delivered from the day the sale '
  + 'was agreed.';
const METHOD_V1 = 'Purchases assigned oldest first — not a confirmed physical match. Within each kind of item (metal, form and fine '
  + 'content per unit), the earliest purchase not yet assigned goes to each sale.';
const PERIOD_METHOD = 'What the sales brought in minus what those units cost, earliest units first across all forms (your rule)';
const CLASSES_HEADING = 'By fine content, all forms together (your rule)';

test.describe.configure({ mode: 'serial' });
test.skip(process.env.HOLDR_METALS_FUNGIBLE !== 'XAU',
  'needs its own stack whose API runs with HOLDR_METALS_FUNGIBLE=XAU (see the comment at the top of this file)');

let stack: MetalsStack;

test.beforeAll(async ({ request }) => {
  stack = await metalsStack(request);
});

test.beforeEach(async ({ request }) => {
  await requireHealthyApi(request);
});

async function overviewOf(request: APIRequestContext, metal: 'XAU' | 'XAG'): Promise<MetalsOverview> {
  const answer = await request.get(`/metals/overview?metal=${metal}`);
  expect(answer.ok(), `GET /metals/overview?metal=${metal}`).toBe(true);
  const read = await answer.json() as MetalsRead<MetalsOverview>;
  expect(read.installed).toBe(true);
  return read as MetalsOverview;
}

/** The Gold page at rest: its reads in, nothing updating. */
async function openGold(page: Page, metal: 'Gold' | 'Silver' = 'Gold'): Promise<Locator> {
  await page.goto('/#/investing/gold');
  const gold = page.getByTestId('gold-page');
  await expect(gold.getByTestId('gold-summary')).toBeVisible();
  if (metal !== 'Gold') {
    await gold.getByRole('group', { name: 'Metal' }).getByRole('button', { name: metal, exact: true }).click();
    await expect(gold.getByRole('heading', { level: 2, name: metal, exact: true })).toBeVisible();
  }
  await expect(gold).toHaveAttribute('aria-busy', 'false');
  return gold;
}

async function chooseAll(gold: Locator): Promise<void> {
  const button = gold.getByRole('group', { name: 'Period' }).getByRole('button', { name: 'All', exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(gold).toHaveAttribute('aria-busy', 'false');
}

/** Details, open: what to check, the lists, holdings and coverage. */
async function openDetails(gold: Locator): Promise<void> {
  const details = gold.getByTestId('gold-details');
  if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open))) await details.locator(':scope > summary').click();
  await expect(details).toHaveJSProperty('open', true);
}

/** Where these figures come from, unfolded. */
async function openSources(gold: Locator): Promise<Locator> {
  const sources = gold.getByTestId('gold-sources');
  const toggle = sources.getByRole('button', { name: 'Where these figures come from' });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  return sources;
}

/** A pattern for exactly `text`. */
const exactly = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
/** A gold class's title under the policy, as the page writes it: its fine ounces per unit, every form together. */
const classTitle = (item: MetalsOverview['holdings']['classes'][number]) => `${item.fineTroyOzPerUnit.display} troy oz gold pieces of any form`;

/** A list row by its own name ("Sep 10, 2026 · …", its date first). */
const row = (gold: Locator, testId: string, date: string) => gold.getByTestId(testId)
  .filter({ has: gold.page().locator('.gold-row-name', { hasText: new RegExp(`^${date.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }) });

async function expand(item: Locator): Promise<Locator> {
  const toggle = item.locator('.gold-row-toggle');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  return item.locator('.gold-row-details');
}

/** Gold's overview and its one class whose Delivered counts units a sale took before their delivery was recorded. */
async function inferredClass(request: APIRequestContext) {
  const overview = await overviewOf(request, 'XAU');
  const inferred = overview.holdings.classes.filter((entry) => (entry.reconciliation.deliveryInferred ?? 0) > 0);
  expect(inferred, 'the seed\'s coin sold while its purchase awaited delivery reads delivered, in one class').toHaveLength(1);
  return { overview, item: inferred[0], title: classTitle(inferred[0]) };
}

test('the API runs the owner\'s policy for gold alone: gold\'s classes take every form together, silver\'s keep theirs', async ({ request }) => {
  const gold = await overviewOf(request, 'XAU');
  const silver = await overviewOf(request, 'XAG');
  // Every read the assignment makes carries the policy while it names a metal: silver's too, naming gold alone.
  expect(gold.assignment).toEqual(POLICY);
  expect(silver.assignment).toEqual(POLICY);
  expect(gold.holdings.classes.length).toBeGreaterThan(0);
  for (const item of gold.holdings.classes) {
    expect(item.form).toBe('any');
    expect(item.key).toMatch(/^XAU\|any\|/);
    expect(item.units.soldFromAwaiting).toBe(0);
  }
  for (const item of silver.holdings.classes) {
    expect(item.form).not.toBe('any');
    expect(item.reconciliation.deliveryInferred).toBeUndefined();
  }
  // The seed's one unit a sale took while its purchase awaited delivery (the Walmart coin): read delivered, said once.
  expect(gold.holdings.classes.map((item) => item.reconciliation.deliveryInferred ?? 0).filter((units) => units > 0)).toEqual([1]);
});

test('gold\'s holdings: the unit a sale took before its delivery was recorded counts as delivered, said right under its class\'s sum', async ({ page, request }) => {
  const { overview, item, title } = await inferredClass(request);
  const gold = await openGold(page);
  await openDetails(gold);
  const holdings = gold.getByTestId('gold-holdings');
  await expect(holdings.getByRole('heading', { level: 4, name: CLASSES_HEADING, exact: true })).toBeVisible();
  // Every gold class is across forms, as served.
  await expect(holdings.getByTestId('gold-class').locator('.gold-row-name')).toHaveText(overview.holdings.classes.map(classTitle));
  const holdingClass = holdings.getByTestId('gold-class').filter({ has: page.locator('.gold-row-name', { hasText: exactly(title) }) });
  await expect(holdingClass).toHaveCount(1);
  await expect(holdingClass.locator('.gold-reconciliation li').nth(0))
    .toHaveText(`Delivered ${item.units.delivered} · Sold ${item.units.sold} · Recorded holdings ${item.units.held}`);
  await expect(holdingClass.locator('.gold-reconciliation li').nth(1)).toHaveText(INFERRED);
  // Said once, in its class; and no unit reads as sold while awaiting delivery: under the policy it is delivered.
  await expect(holdings.getByText(INFERRED, { exact: true })).toHaveCount(1);
  await expect(holdings).not.toContainText('sold while awaiting delivery');
});

test('a sale\'s assigned purchases: oldest first across all forms (your rule), the coin sale\'s still the coin that awaited delivery', async ({ page }) => {
  const gold = await openGold(page);
  await chooseAll(gold);
  // The period's method, under its profit or loss on the covered sales.
  await expect(gold.getByTestId('gold-sale-profit')).toContainText(PERIOD_METHOD);
  await openDetails(gold);
  const bar = await expand(row(gold, 'gold-sale', longDate(stack.dates.barSale)));
  await expect(bar.getByTestId('gold-cycle')).toContainText(`Bought${longDate(stack.dates.walmartLinked)} at Walmart account`);
  await expect(bar.getByTestId('gold-assignment-note')).toHaveText(NOTE);
  const coin = await expand(row(gold, 'gold-sale', longDate(stack.dates.coinSale)));
  await expect(coin.getByTestId('gold-cycle')).toContainText(`Bought${longDate(stack.dates.walmartAwaiting)} at Walmart account`);
  await expect(coin.getByTestId('gold-assignment-note')).toHaveText(NOTE);
});

test('where these figures come from: gold\'s method across all forms; silver, which the policy doesn\'t name, as before', async ({ page }) => {
  const gold = await openGold(page);
  await openDetails(gold);
  await expect((await openSources(gold)).getByTestId('gold-assignment-method')).toHaveText(METHOD);
  const silver = await openGold(page, 'Silver');
  await openDetails(silver);
  await expect((await openSources(silver)).getByTestId('gold-assignment-method')).toHaveText(METHOD_V1);
  await expect(silver.getByTestId('gold-holdings').getByRole('heading', { level: 4, name: 'By form', exact: true })).toBeVisible();
  await expect(silver.getByTestId('gold-holdings')).not.toContainText('your rule');
});

for (const width of [375, 1920]) {
  test(`at ${width}px the new words wrap inside the page and are captured for review`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const { title } = await inferredClass(request);
    const gold = await openGold(page);
    await chooseAll(gold);
    await openDetails(gold);
    const holdingClass = gold.getByTestId('gold-class').filter({ has: page.locator('.gold-row-name', { hasText: exactly(title) }) });
    await expect(holdingClass.getByText(INFERRED, { exact: true })).toBeVisible();
    const coin = await expand(row(gold, 'gold-sale', longDate(stack.dates.coinSale)));
    await expect(coin.getByTestId('gold-assignment-note')).toHaveText(NOTE);
    const sources = await openSources(gold);
    await expect(sources.getByTestId('gold-assignment-method')).toHaveText(METHOD);
    // Never sideways: the page is no wider than the screen with every new line shown.
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await holdingClass.screenshot({ path: testInfo.outputPath(`gold-fungible-${width}-class.png`) });
    await coin.screenshot({ path: testInfo.outputPath(`gold-fungible-${width}-coin-sale.png`) });
    await sources.getByTestId('gold-assignment-method').screenshot({ path: testInfo.outputPath(`gold-fungible-${width}-method.png`) });
  });
}
