import { expect, requireHealthyApi, test, type Page } from './fixtures';

/**
 * Investing on phones and touch screens, on the stack's synthetic household (display only):
 * - Transactions: from 360 to 600px a row is two lines: the symbol, Bought or Sold and the amount (and the row's
 *   menu); then the date and the owner's account. Narrower, Bought/Sold may drop under the amount; the amount never
 *   leaves the symbol's line. Quantity, price and source are in the row's drawer, which takes the row's width.
 * - Touch targets: the refresh icon's hit area is 44px square (the icon stays 24px), a row's checkbox and menu
 *   are 40px, every holdings row that opens (the cash row too) is 44px tall, and the chart toggles are 40px (an
 *   account's 44px; a holding's sits in its Details on a phone).
 * - Holdings on a phone: the symbol, its price with the day's change under it, and its value; its Details hold the
 *   rest (see journey 8 in audit.e2e.ts for what each price state says).
 */

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } as const;

interface Rect { left: number; right: number; top: number; bottom: number; width: number; height: number }

/** Two boxes on one line: they overlap vertically by at least half the shorter one. */
const sameLine = (a: Rect, b: Rect) => Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) >= Math.min(a.height, b.height) / 2;

async function installQuotes(page: Page): Promise<void> {
  await page.route('**/quotes?**', async (route) => {
    const symbols = (new URL(route.request().url()).searchParams.get('symbols') ?? '').split(',').filter(Boolean);
    const asOf = Date.now();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        quotes: symbols.map((symbol) => ({
          symbol, price: 100, currency: 'USD', asOf, source: 'unknown', freshness: 'live', session: 'regular',
          changeBasis: 'previousClose', baselinePrice: 99, dayChange: 1, dayChangePercent: 100 / 99,
        })),
        fallbackSymbols: [],
        missingSymbols: [],
      }),
    });
  });
}

async function open(page: Page, hash: string): Promise<void> {
  await page.goto(`/${hash}`);
  await expect(page.locator('.app')).toBeVisible();
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
}

/** Where each part of the first rows of the list sits, on how many lines its text is set, and at what size. */
function rowFacts(page: Page, count: number) {
  return page.evaluate((n) => {
    const rect = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const lines = (el: Element | null) => (el ? new Set([...el.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size : 0);
    const size = (el: Element | null) => (el ? parseFloat(getComputedStyle(el).fontSize) : 0);
    return [...document.querySelectorAll('.tx-row')].slice(0, n).map((row) => {
      const q = (selector: string) => row.querySelector(selector);
      const meta = getComputedStyle(q('.tx-row-meta')!);
      return {
        symbolText: q('.tx-row-title .symbol')?.textContent ?? '',
        row: rect(row)!,
        summaryText: q('.tx-row-main')?.textContent ?? '',
        symbol: rect(q('.tx-row-title .symbol'))!,
        verb: rect(q('.tx-amount-verb'))!,
        value: rect(q('.tx-amount-value'))!,
        date: rect(q('.tx-row-date'))!,
        owner: rect(q('.tx-owner-pill')),
        account: rect(q('.tx-account-short')),
        lines: [q('.tx-row-title .symbol'), q('.tx-amount-verb'), q('.tx-amount-value'), q('.tx-row-date'), q('.tx-owner-pill'), q('.tx-account-short')].map(lines),
        sizes: {
          symbol: size(q('.tx-row-title .symbol')), value: size(q('.tx-amount-value')), verb: size(q('.tx-amount-verb')),
          date: size(q('.tx-row-date')), owner: size(q('.tx-owner-pill')), account: size(q('.tx-account-short')),
        },
        metaLeading: parseFloat(meta.lineHeight) / parseFloat(meta.fontSize),
      };
    });
  }, count);
}

/** How far from the element's centre a tap along each axis still lands on it. */
function hitExtents(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)!;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hits = (x: number, y: number) => { const target = document.elementFromPoint(x, y); return !!target && el.contains(target); };
    const reach = (dx: number, dy: number) => { let d = 0; while (d < 60 && hits(cx + dx * (d + 0.5), cy + dy * (d + 0.5))) d += 1; return d; };
    return { width: reach(-1, 0) + reach(1, 0), height: reach(0, -1) + reach(0, 1), boxWidth: r.width, boxHeight: r.height };
  }, selector);
}

test.beforeEach(async ({ page, request }) => {
  await requireHealthyApi(request);
  await installQuotes(page);
});

test.describe('Investing on a phone', () => {
  test.use(PHONE);

  test('a transaction is two lines: symbol, Bought or Sold and the amount; then the date and the account', async ({ page }) => {
    await open(page, '#/investing/transactions');
    await expect(page.locator('.tx-row').nth(11)).toBeVisible();
    for (const width of [320, 360, 375, 390, 430, 600]) {
      await page.setViewportSize({ width, height: 844 });
      const rows = await rowFacts(page, 12);
      expect(rows.length, `${width}px`).toBe(12);
      for (const [i, row] of rows.entries()) {
        const where = `${width}px, row ${i + 1} (${row.symbolText})`;
        // No part is set on two lines, and none is under its floor (D1): the symbol and the amount at 16px; Bought/Sold,
        // the date, the owner and the account at 14px; line 2, which may wrap, at line-height 1.5.
        expect(row.lines, where).toEqual([1, 1, 1, 1, 1, 1]);
        expect(Math.min(row.sizes.symbol, row.sizes.value), `${where}: ${JSON.stringify(row.sizes)}`).toBeGreaterThanOrEqual(16);
        expect(Math.min(row.sizes.verb, row.sizes.date, row.sizes.owner, row.sizes.account), `${where}: ${JSON.stringify(row.sizes)}`)
          .toBeGreaterThanOrEqual(14);
        expect(row.metaLeading, where).toBeGreaterThanOrEqual(1.49);
        // Line 1: the symbol, then the amount at the line's end, Bought/Sold between them; under 360px Bought/Sold may
        // drop under the amount, but the amount never leaves the symbol's line.
        expect(sameLine(row.symbol, row.value), `${where}: the amount is on the symbol's line`).toBe(true);
        expect(row.value.left, `${where}: the amount follows the symbol`).toBeGreaterThanOrEqual(row.symbol.right);
        if (width >= 360) {
          expect(sameLine(row.verb, row.value), `${where}: Bought/Sold on line 1`).toBe(true);
          expect(row.verb.left, `${where}: Bought/Sold follows the symbol`).toBeGreaterThanOrEqual(row.symbol.right);
          expect(row.verb.right, `${where}: the amount follows Bought/Sold`).toBeLessThanOrEqual(row.value.left);
        } else {
          expect(sameLine(row.verb, row.value) || row.verb.top >= row.value.bottom - 1, `${where}: Bought/Sold beside or under the amount`).toBe(true);
        }
        // Line 2: the date under the symbol, then the owner and the account; from 360px all on the line under line 1.
        expect(row.owner, where).not.toBeNull();
        expect(row.account, where).not.toBeNull();
        expect(row.date.top, `${where}: the date under line 1`).toBeGreaterThanOrEqual(Math.max(row.symbol.bottom, row.verb.bottom) - 1);
        expect(Math.abs(row.date.left - row.symbol.left), `${where}: line 2 starts under the symbol`).toBeLessThanOrEqual(1);
        if (width >= 360) {
          expect(sameLine(row.date, row.owner!) && sameLine(row.date, row.account!), `${where}: date, owner and account on line 2`).toBe(true);
          expect(row.date.top - Math.max(row.symbol.bottom, row.value.bottom), `${where}: no line between`).toBeLessThanOrEqual(8);
        }
        // Quantity @ price is in the drawer, not the row.
        expect(row.summaryText, where).not.toContain('@');
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${width}px`).toBeLessThanOrEqual(0);
    }
  });

  test('an open row\'s drawer holds quantity, price and source, takes the row\'s width, and the amount stays on line 1', async ({ page }) => {
    await open(page, '#/investing/transactions');
    const row = page.locator('.tx-row').nth(1);
    await row.locator('.tx-row-title .symbol').tap();
    const summary = row.locator('.tx-row-main');
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
    const drawer = row.locator('.tx-row-drawer');
    await expect(drawer).toBeVisible();
    await expect(summary).toHaveAttribute('aria-controls', (await drawer.getAttribute('id'))!);
    // Quantity and price first, each still editable, then where the trade came from.
    await expect(drawer.locator('dt').nth(0)).toHaveText('Quantity');
    await expect(drawer.locator('dt').nth(1)).toHaveText('Price');
    await expect(drawer.locator('dt').nth(2)).toHaveText('Source');
    await expect(drawer.getByTitle('Edit quantity')).toBeVisible();
    await expect(drawer.getByTitle('Edit price')).toBeVisible();
    await expect(drawer.locator('dd').nth(2)).toHaveText(/^(Broker activity import|Positions import|No import record)$/);
    // Values read at 16px, labels and IDs at 14px; a value that wraps at line-height 1.5.
    const type = await drawer.evaluate((el) => [...el.querySelectorAll('dt, dd')].map((node) => {
      const style = getComputedStyle(node);
      return { tag: node.tagName, mono: node.classList.contains('mono'), size: parseFloat(style.fontSize), leading: parseFloat(style.lineHeight) / parseFloat(style.fontSize) };
    }));
    for (const item of type) {
      expect(item.size, JSON.stringify(item)).toBeGreaterThanOrEqual(item.tag === 'DD' && !item.mono ? 16 : 14);
      if (item.tag === 'DD') expect(item.leading, JSON.stringify(item)).toBeGreaterThanOrEqual(1.49);
    }
    const [rowBox, drawerBox, symbol, value, check] = await Promise.all([
      row.boundingBox(), drawer.boundingBox(), row.locator('.tx-row-title .symbol').boundingBox(),
      row.locator('.tx-amount-value').boundingBox(), row.locator('.tx-row-check').boundingBox(),
    ]);
    // Everything right of the checkbox column, to the row's padding.
    expect(drawerBox!.x).toBeLessThanOrEqual(symbol!.x + 1);
    expect(drawerBox!.x + drawerBox!.width).toBeGreaterThanOrEqual(rowBox!.x + rowBox!.width - 13);
    expect(drawerBox!.width).toBeGreaterThan(rowBox!.width - check!.width - 40);
    expect(Math.abs(symbol!.y + symbol!.height / 2 - (value!.y + value!.height / 2))).toBeLessThanOrEqual(6);
    // The drawer is not part of the summary's control: a tap on its text leaves it open; the summary closes it.
    await drawer.locator('dt').first().tap();
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
    await row.locator('.tx-row-title .symbol').tap();
    await expect(summary).toHaveAttribute('aria-expanded', 'false');
    await expect(drawer).toHaveCount(0);
  });

  test('a holding is its symbol, its price with the day\'s change, and its value; its Details open from the keyboard', async ({ page }) => {
    await open(page, '#/investing/portfolio');
    const row = page.locator('.account.combined tr.holding-row').first();
    await expect(row).toBeVisible();
    const shown = (target: typeof row) => target.locator('td').evaluateAll((cells) => cells
      .filter((cell) => cell.getBoundingClientRect().width > 0)
      .map((cell) => [...cell.classList].find((name) => name.startsWith('col-'))));
    for (const width of [320, 375, 390, 430, 600]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await shown(row), `${width}px`).toEqual(['col-sym', 'col-price', 'col-value']);
      await expect(row.locator('.price-day-change')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${width}px`).toBeLessThanOrEqual(0);
      // From 360px the three fit without the table scrolling sideways.
      if (width >= 360) {
        expect(await page.locator('.account.combined .holdings-scroll').evaluate((box) => box.scrollWidth - box.clientWidth), `${width}px`)
          .toBeLessThanOrEqual(0);
      }
    }
    await expect(page.locator('.holdings-phone-hint')).toBeVisible();

    const toggle = row.getByRole('button', { name: / details$/ });
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const details = page.locator('.account.combined tr.holding-details-row').first();
    await expect(details).toBeVisible();
    await expect(details.locator('dt')).toContainText(['Quantity', 'Avg cost', 'Gain/loss (excludes cash)', '% of total']);
    await expect(details.getByRole('button', { name: /^Show .+ price chart$/ })).toBeVisible();
    await expect(page.locator('.account.combined tr.contributor-row').first()).toBeVisible();
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(details).toHaveCount(0);
  });

  test('touch targets: refresh 44px, a row\'s checkbox and menu 40px, holdings expanders 44px', async ({ page }) => {
    await open(page, '#/investing/portfolio');
    // The refresh icon stays a 24px chip; its hit area is a 44px square.
    const refresh = await hitExtents(page, '.app > header .refresh');
    expect(Math.round(refresh.boxWidth)).toBe(24);
    expect(refresh.width).toBeGreaterThanOrEqual(44);
    expect(refresh.height).toBeGreaterThanOrEqual(44);

    // Every combined-holdings row that opens its accounts, the cash row too, is 44px tall; a tap near the cash
    // row's top edge opens it, and another near its bottom edge closes it. Near, not on: within a few pixels of a
    // boundary the browser's touch adjustment may pick the neighbouring row's text (rows now hold two lines), so the
    // taps land 10px inside each edge, still outside the row's text.
    const expanders = page.locator('.account.combined table.holdings tbody tr:not(.contributor-row):not(.chart-row)');
    await expect(expanders.first()).toBeVisible();
    const heights = await expanders.evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThan(1);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
    const cash = page.locator('.account.combined tr.cash-row');
    await cash.scrollIntoViewIfNeeded();
    let cashBox = (await cash.boundingBox())!;
    await page.touchscreen.tap(cashBox.x + 40, cashBox.y + 10);
    await expect(cash).toHaveClass(/\bexpanded\b/);
    await expect(page.locator('.account.combined tr.contributor-row').first()).toBeVisible();
    cashBox = (await cash.boundingBox())!;
    await page.touchscreen.tap(cashBox.x + 40, cashBox.y + cashBox.height - 10);
    await expect(cash).not.toHaveClass(/\bexpanded\b/);

    // The chart toggles: a holding's (a "Chart" pill in its Details on phones) 40px, an account's 44px.
    await page.locator('.account.combined tr.holding-row').first().getByRole('button', { name: / details$/ }).tap();
    const rowToggle = (await page.locator('.account.combined tr.holding-details-row .chart-toggle').first().boundingBox())!;
    expect(rowToggle.width).toBeGreaterThanOrEqual(40);
    expect(rowToggle.height).toBeGreaterThanOrEqual(40);
    const accountToggle = (await page.locator('.account:not(.combined) .account-name .chart-toggle').first().boundingBox())!;
    expect(accountToggle.width).toBeGreaterThanOrEqual(44);
    expect(accountToggle.height).toBeGreaterThanOrEqual(44);

    // A transaction's checkbox: a 40px box; a tap at its edge, beside the 18px box, selects the row.
    await open(page, '#/investing/transactions');
    const row = page.locator('.tx-row').first();
    await row.scrollIntoViewIfNeeded();
    const checkbox = row.getByRole('checkbox');
    const label = (await row.locator('.tx-row-check').boundingBox())!;
    expect(label.width).toBeGreaterThanOrEqual(40);
    expect(label.height).toBeGreaterThanOrEqual(40);
    await page.touchscreen.tap(label.x + 3, label.y + label.height / 2);
    await expect(checkbox).toBeChecked();
    await page.touchscreen.tap(label.x + label.width - 3, label.y + 3);
    await expect(checkbox).not.toBeChecked();

    // Its menu: a 40px button; a tap near its edge opens it.
    const trigger = row.getByRole('button', { name: 'Row actions' });
    const menu = (await trigger.boundingBox())!;
    expect(menu.width).toBeGreaterThanOrEqual(40);
    expect(menu.height).toBeGreaterThanOrEqual(40);
    await page.touchscreen.tap(menu.x + 4, menu.y + menu.height / 2);
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(row.getByRole('menuitem', { name: 'Remove transaction' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
});

test.describe('Investing on a desktop', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('a row reads symbol, Bought or Sold and the amount, then the date and the account; mouse-sized controls', async ({ page }) => {
    await open(page, '#/investing/transactions');
    await expect(page.locator('.tx-row').nth(5)).toBeVisible();
    for (const [i, row] of (await rowFacts(page, 6)).entries()) {
      const where = `row ${i + 1} (${row.symbolText})`;
      expect(sameLine(row.symbol, row.verb) && sameLine(row.symbol, row.value), `${where}: line 1`).toBe(true);
      expect(row.verb.left, where).toBeGreaterThanOrEqual(row.symbol.right);
      expect(row.verb.right, `${where}: Bought/Sold beside the amount`).toBeLessThanOrEqual(row.value.left);
      expect(row.date.top, `${where}: the date under the symbol`).toBeGreaterThanOrEqual(row.symbol.bottom - 1);
      expect(Math.abs(row.date.left - row.symbol.left), where).toBeLessThanOrEqual(1);
      expect(sameLine(row.date, row.owner!) && sameLine(row.date, row.account!), `${where}: date, owner and account on line 2`).toBe(true);
      expect(row.summaryText, where).not.toContain('@');
    }
    const row = page.locator('.tx-row').first();
    expect(Math.round((await row.locator('.tx-row-check').boundingBox())!.width)).toBe(24);
    const menu = (await row.getByRole('button', { name: 'Row actions' }).boundingBox())!;
    expect([Math.round(menu.width), Math.round(menu.height)]).toEqual([22, 22]);
    await open(page, '#/investing/portfolio');
    // Desktop keeps every holdings column, aligned for comparison; the change sits in its own column.
    const holding = page.locator('.account.combined tr.holding-row').first();
    expect(await holding.locator('td').evaluateAll((cells) => cells
      .filter((cell) => cell.getBoundingClientRect().width > 0)
      .map((cell) => [...cell.classList].find((name) => name.startsWith('col-')))))
      .toEqual(['col-sym', 'col-trend', 'col-qty', 'col-avg', 'col-price', 'col-day', 'col-value', 'col-gl', 'col-pct']);
    await expect(holding.locator('.price-day-change')).toBeHidden();
    await expect(page.locator('.account.combined thead th')).toHaveText([
      'Symbol', 'Trend', 'Quantity', 'Avg cost', 'Price', 'Day change', 'Market value', 'Gain/loss (excludes cash)', '% of total',
    ]);
    await expect(page.locator('.holdings-phone-hint')).toBeHidden();
    // A mouse screen keeps the 24px icon's own hit area (no ring).
    const refresh = await hitExtents(page, '.app > header .refresh');
    expect(refresh.width).toBeLessThanOrEqual(26);
    expect(refresh.height).toBeLessThanOrEqual(26);
  });
});
