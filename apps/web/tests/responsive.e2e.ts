import { expect, requireHealthyApi, test, type Page } from './fixtures';

/**
 * The page's width, from a small phone to a 2560px screen, on the stack's synthetic household: the shell grows with a
 * wide window instead of staying a 1200px column, centred; no page scrolls sideways at any width; and on wide screens
 * the panels that list accounts sit two to a row while the chart and the combined holdings keep the whole width.
 */

const PAGES = [
  '#/investing/portfolio', '#/investing/gold', '#/investing/transactions', '#/investing/add', '#/investing/import', '#/investing/accounts',
  '#/everyday/transactions', '#/everyday/benefits', '#/everyday/amazon', '#/everyday/amazon/fresh', '#/everyday/sync', '#/everyday/devices',
];

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

async function open(page: Page, hash: string): Promise<void> {
  await page.goto(`/${hash}`);
  await expect(page.locator('.app')).toBeVisible();
  // The page's own reads first: a row that arrives late could widen it.
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
}

test.beforeEach(async ({ request }) => {
  await requireHealthyApi(request);
});

test('the page grows with a wide window: 1200px to 1439px, then 1360, 1560 and 1760px, always centred', async ({ page }) => {
  await open(page, '#/investing/portfolio');
  const sizes = [[320, 320], [375, 375], [768, 768], [1280, 1200], [1439, 1200], [1440, 1360], [1680, 1560], [1920, 1760], [2560, 1760]] as const;
  for (const [width, expected] of sizes) {
    await page.setViewportSize({ width, height: 900 });
    const box = (await page.locator('.app').boundingBox())!;
    expect(Math.round(box.width), `${width}px`).toBe(expected);
    expect(Math.abs(box.x - (width - box.x - box.width)), `${width}px centred`).toBeLessThanOrEqual(1);
  }
});

test('no page scrolls sideways, from a small phone to a wide screen', async ({ page }) => {
  test.setTimeout(120_000);
  for (const hash of PAGES) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page, hash);
    for (const width of [320, 375, 430, 768, 1024, 1280, 1440, 1920, 2560]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await sideways(page), `${hash} at ${width}px`).toBeLessThanOrEqual(0);
    }
  }
});

test('wide screens put each account\'s holdings two to a row, and the account cards two to a row', async ({ page }) => {
  await open(page, '#/investing/portfolio');
  const accounts = page.locator('.breakdown > .account:not(.combined)');
  await expect(accounts.nth(1)).toBeVisible();
  const boxes = async () => Promise.all([accounts.nth(0).boundingBox(), accounts.nth(1).boundingBox()]);

  await page.setViewportSize({ width: 1440, height: 900 });
  let [first, second] = await boxes();
  expect(Math.abs(first!.x - second!.x), 'stacked at 1440px').toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1920, height: 1000 });
  [first, second] = await boxes();
  expect(Math.abs(first!.y - second!.y), 'side by side at 1920px').toBeLessThanOrEqual(1);
  expect(second!.x).toBeGreaterThan(first!.x + first!.width);
  // The chart and the combined holdings keep the whole width.
  const breakdown = (await page.locator('.breakdown').boundingBox())!;
  for (const selector of ['.breakdown > .portfolio-chart', '.breakdown > .account.combined']) {
    expect(Math.round((await page.locator(selector).boundingBox())!.width), selector).toBe(Math.round(breakdown.width));
  }

  await open(page, '#/investing/accounts');
  const cards = page.locator('.accounts-grid > *');
  await expect(cards.nth(1)).toBeVisible();
  const [a, b] = await Promise.all([cards.nth(0).boundingBox(), cards.nth(1).boundingBox()]);
  expect(Math.abs(a!.y - b!.y), 'account cards side by side at 1920px').toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1280, height: 900 });
  const [c, d] = await Promise.all([cards.nth(0).boundingBox(), cards.nth(1).boundingBox()]);
  expect(Math.abs(c!.x - d!.x), 'account cards stacked at 1280px').toBeLessThanOrEqual(1);
});
