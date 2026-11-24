import { expect, test, type Page } from './fixtures';
import {
  computeCardInsights,
  summarizeCardSpending,
  toCardTransactionView,
  type CardAccount,
  type CardOwner,
} from '@finance-tracker/shared';
import { FAKE_NOW, FakeOwnerServer, type FakeOwnerOptions } from '../src/components/spending/sync/fakeOwnerServer';

/**
 * Holdr's two modes: the Investing | Everyday switch beside the wordmark and
 * the hash routes behind it (#/investing/<tab>, #/everyday/<area>). Investing
 * reads the stack's own (synthetic) portfolio; Everyday's card data is served
 * here, synthetic, with no owner sync API (one test uses E8-M's synthetic owner
 * fake for its dialogs), so nothing depends on card routes.
 */

const at = '2026-10-01T00:00:00.000Z';
const accounts: CardAccount[] = [{
  id: `card-acct-${'m'.repeat(32)}`, issuer: 'amex', owner: 'alex', nickname: 'Modes', last4: '0003', currency: 'USD',
  status: 'active', createdAt: at, updatedAt: at,
}];

async function serveCards(page: Page): Promise<void> {
  const owners = new Map<string, CardOwner>(accounts.map((account) => [account.id, account.owner]));
  await page.route((url) => /^\/(?:card-accounts|card-imports|card-transactions|spending)(?:[/?]|$)/.test(url.pathname), (route) => {
    const url = new URL(route.request().url());
    let body: unknown = null;
    if (url.pathname === '/card-accounts') body = { cardAccounts: accounts };
    if (url.pathname === '/spending/coverage') body = { cards: [] };
    if (url.pathname === '/spending/summary') body = { ...summarizeCardSpending([], { owners }), categories: [] };
    if (url.pathname === '/spending/insights') body = computeCardInsights([], { month: '2026-10', today: '2026-10-17', currency: 'USD' });
    if (url.pathname === '/card-transactions') body = { transactions: [], total: 0, limit: 100, offset: 0, nextOffset: null };
    return route.fulfill(body === null
      ? { status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }) }
      : { status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  // No owner sync API on this stack: Everyday's sync areas say "Not set up".
  await page.route((url) => url.pathname.startsWith('/card-sync/'), (route) => route.fulfill({
    status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }),
  }));
}

/**
 * E8-M's synthetic owner (the fake its own spec uses), so Extension & devices has its dialogs. The next
 * write can be held back, to answer it only after the page has moved on.
 */
async function serveOwner(page: Page, options: FakeOwnerOptions = {}) {
  const fake = new FakeOwnerServer(options);
  const control = { holdNextWrite: false, held: false, release: () => {} };
  await page.route((url) => url.pathname.startsWith('/card-sync/owner/') || url.pathname === '/auth/reverify', async (route) => {
    const request = route.request();
    if (control.holdNextWrite && request.method() !== 'GET') {
      control.holdNextWrite = false;
      await new Promise<void>((resolve) => {
        control.release = resolve;
        control.held = true;
      });
    }
    const url = new URL(request.url());
    const headers = Object.fromEntries(Object.entries(await request.allHeaders()).map(([key, value]) => [key.toLowerCase(), value]));
    const response = await fake.handle({ method: request.method(), url: `${url.pathname}${url.search}`, headers, body: request.postData() });
    await route.fulfill({ status: response.status, contentType: 'application/json', body: JSON.stringify(response.body) });
  });
  await page.clock.setFixedTime(new Date(FAKE_NOW));
  return control;
}

const modeSwitch = (page: Page) => page.getByRole('radiogroup', { name: 'Mode' });
const modeRadio = (page: Page, name: 'Investing' | 'Everyday') => modeSwitch(page).getByRole('radio', { name });
const sections = (page: Page) => page.getByRole('tablist', { name: 'Sections' });
const areas = (page: Page) => page.getByRole('tablist', { name: 'Spending areas' });
const area = (page: Page, name: string) => areas(page).getByRole('tab', { name: new RegExp(`^${name}`) });
const storedMode = (page: Page) => page.evaluate(() => localStorage.getItem('finance-tracker:pref:mode'));
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

async function expectInvesting(page: Page, tab: string): Promise<void> {
  await expect(modeRadio(page, 'Investing')).toHaveAttribute('aria-checked', 'true');
  await expect(modeRadio(page, 'Everyday')).toHaveAttribute('aria-checked', 'false');
  await expect(sections(page).getByRole('tab', { name: tab, exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(areas(page)).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'investing');
  await expect(page.locator('.app')).toHaveAttribute('data-mode', 'investing');
}

async function expectEveryday(page: Page, name: string): Promise<void> {
  await expect(modeRadio(page, 'Everyday')).toHaveAttribute('aria-checked', 'true');
  await expect(modeRadio(page, 'Investing')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('region', { name: 'Spending', exact: true })).toBeVisible();
  await expect(area(page, name)).toHaveAttribute('aria-selected', 'true');
  await expect(sections(page)).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'everyday');
  await expect(page.locator('.app')).toHaveAttribute('data-mode', 'everyday');
}

test.use({ timezoneId: 'UTC', locale: 'en-US' });

test.beforeAll(async ({ request }) => {
  const health = await request.get('/health').catch(() => null);
  test.skip(!health || !health.ok(), 'The stack behind WEB_URL is unavailable.');
});

test.beforeEach(async ({ page }) => {
  await serveCards(page);
});

test.describe('Two modes (desktop)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('a first visit opens Investing as before, and the address names it', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/#\/investing\/portfolio$/);
    await expectInvesting(page, 'Portfolio');
    await expect(page).toHaveTitle('Portfolio · Investing · Holdr');
    await expect(page.getByRole('heading', { name: 'Holdr' })).toBeVisible();
    // Investing keeps its tabs, in order, Gold after Portfolio; Spending is still there and opens Everyday.
    await expect(sections(page).getByRole('tab')).toHaveText(['Portfolio', 'Gold', 'Transactions', 'Spending', 'Add', 'Import', 'Accounts']);
    await expect(page.getByRole('button', { name: 'Refresh quotes' })).toBeVisible();
  });

  test('the switch opens Everyday, and a reload keeps it', async ({ page }) => {
    await page.goto('/');
    await modeRadio(page, 'Everyday').click();
    await expect(page).toHaveURL(/#\/everyday\/transactions$/);
    await expectEveryday(page, 'Card transactions');
    await expect(page).toHaveTitle('Card transactions · Everyday · Holdr');
    await area(page, 'Sync & coverage').click();
    await expect(page).toHaveURL(/#\/everyday\/sync$/);
    await expect(page.getByText('Not set up: this Holdr doesn\'t support extension sync yet.')).toBeVisible();
    await page.reload();
    await expectEveryday(page, 'Sync & coverage');
    await expect(page.getByText('Not set up: this Holdr doesn\'t support extension sync yet.')).toBeVisible();
  });

  test('tabs, areas and modes are history entries: back and forward', async ({ page }) => {
    await page.goto('/');
    await sections(page).getByRole('tab', { name: 'Transactions', exact: true }).click();
    await expectInvesting(page, 'Transactions');
    await modeRadio(page, 'Everyday').click();
    await expectEveryday(page, 'Card transactions');
    await area(page, 'Extension & devices').click();
    await expectEveryday(page, 'Extension & devices');

    await page.goBack();
    await expect(page).toHaveURL(/#\/everyday\/transactions$/);
    await expectEveryday(page, 'Card transactions');
    await page.goBack();
    await expect(page).toHaveURL(/#\/investing\/transactions$/);
    await expectInvesting(page, 'Transactions');
    await page.goBack();
    await expectInvesting(page, 'Portfolio');
    await page.goForward();
    await page.goForward();
    await expectEveryday(page, 'Card transactions');
    await page.goForward();
    await expectEveryday(page, 'Extension & devices');
  });

  test('every route opens directly; unknown sections and the Spending tab\'s old place are rewritten in place', async ({ page }) => {
    await page.goto('/#/everyday/devices');
    await expectEveryday(page, 'Extension & devices');
    await page.goto('/#/investing/accounts');
    await expectInvesting(page, 'Accounts');
    const entries = await page.evaluate(() => history.length);
    await page.goto('/#/investing/spending');
    await expect(page).toHaveURL(/#\/everyday\/transactions$/);
    await expectEveryday(page, 'Card transactions');
    await page.goto('/#/everyday/nowhere');
    await expect(page).toHaveURL(/#\/everyday\/transactions$/);
    await page.goto('/#/Investing/IMPORT/');
    await expect(page).toHaveURL(/#\/investing\/import$/);
    await expectInvesting(page, 'Import');
    // Rewrites replace the entry they correct; they never add one.
    expect(await page.evaluate(() => history.length)).toBe(entries + 3);
  });

  test('a bare address opens the mode last chosen with the switch; only its name is stored', async ({ page }) => {
    await page.goto('/');
    await expectInvesting(page, 'Portfolio');
    expect(await storedMode(page)).toBeNull();
    // Investing's Spending entry visits Everyday; it does not change where a bare address opens.
    await sections(page).getByRole('tab', { name: 'Spending', exact: true }).click();
    await expectEveryday(page, 'Card transactions');
    await page.goto('/');
    await expectInvesting(page, 'Portfolio');
    expect(await storedMode(page)).toBeNull();
    await modeRadio(page, 'Everyday').click();
    await expectEveryday(page, 'Card transactions');
    expect(await storedMode(page)).toBe('everyday');
    await page.goto('/');
    await expect(page).toHaveURL(/#\/everyday\/transactions$/);
    await expectEveryday(page, 'Card transactions');
    await page.evaluate(() => localStorage.setItem('finance-tracker:pref:mode', 'something else'));
    await page.goto('/');
    await expectInvesting(page, 'Portfolio');
  });

  test('Investing\'s Spending entry opens Everyday\'s card transactions', async ({ page }) => {
    await page.goto('/#/investing/transactions');
    const spending = sections(page).getByRole('tab', { name: 'Spending', exact: true });
    await expect(spending).toHaveAttribute('aria-selected', 'false');
    await spending.click();
    await expect(page).toHaveURL(/#\/everyday\/transactions$/);
    await expectEveryday(page, 'Card transactions');
    await page.goBack();
    await expectInvesting(page, 'Transactions');
  });

  test('switching back returns to where each mode was left', async ({ page }) => {
    await page.goto('/#/investing/accounts');
    await modeRadio(page, 'Everyday').click();
    await area(page, 'Sync & coverage').click();
    await modeRadio(page, 'Investing').click();
    await expectInvesting(page, 'Accounts');
    await modeRadio(page, 'Everyday').click();
    await expectEveryday(page, 'Sync & coverage');
  });

  test('keyboard: the switch is one tab stop, and arrow keys change the mode', async ({ page }) => {
    await page.goto('/');
    await expect(modeRadio(page, 'Everyday')).toHaveAttribute('tabindex', '-1');
    await modeRadio(page, 'Investing').focus();
    await page.keyboard.press('ArrowRight');
    await expect(modeRadio(page, 'Everyday')).toBeFocused();
    await expectEveryday(page, 'Card transactions');
    await page.keyboard.press('ArrowRight');
    await expect(modeRadio(page, 'Investing')).toBeFocused();
    await expectInvesting(page, 'Portfolio');
    await page.keyboard.press('End');
    await expectEveryday(page, 'Card transactions');
    await page.keyboard.press('Home');
    await expectInvesting(page, 'Portfolio');
    await page.keyboard.press('ArrowLeft');
    await expect(modeRadio(page, 'Everyday')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(modeRadio(page, 'Investing')).not.toBeFocused();
    await expect(modeRadio(page, 'Everyday')).not.toBeFocused();
  });

  test('back and forward move focus to the checked mode and say the mode when the switch had focus', async ({ page }) => {
    await page.goto('/');
    await modeRadio(page, 'Investing').focus();
    await page.keyboard.press('ArrowRight');
    await expectEveryday(page, 'Card transactions');
    await expect(modeRadio(page, 'Everyday')).toBeFocused();
    // A change made with the switch is announced by the radio itself, not repeated.
    await expect(page.locator('[aria-live="polite"]').filter({ hasText: 'mode' })).toHaveCount(0);
    await page.goBack();
    await expectInvesting(page, 'Portfolio');
    await expect(modeRadio(page, 'Investing')).toBeFocused();
    await expect(page.locator('[aria-live="polite"]').filter({ hasText: 'Investing mode' })).toHaveCount(1);
  });

  test('Everyday leaves out Investing\'s ticker and quote controls and keeps the rest of the header', async ({ page }) => {
    await page.goto('/');
    // Count once the dashboard's header is up: until the session check ends the page shows only a splash.
    await expect(page.locator('.local-only-chip')).toBeVisible();
    const signOuts = await page.getByRole('button', { name: 'Sign out' }).count();
    await modeRadio(page, 'Everyday').click();
    await expectEveryday(page, 'Card transactions');
    await expect(page.getByRole('button', { name: 'Refresh quotes' })).toHaveCount(0);
    await expect(page.locator('.ticker-banner')).toHaveCount(0);
    await expect(page.locator('.local-only-chip')).toBeVisible();
    // Sign-in's controls (where the stack has them) are the same in both modes.
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(signOuts);
  });

  test('a card payment\'s details link to the cash ledger in Investing, and back returns to the same place in the list', async ({ page }) => {
    const payment = toCardTransactionView({
      id: `card-txn-${'p'.repeat(32)}`, cardAccountId: accounts[0].id, source: 'ofx', fingerprint: 'f'.repeat(64),
      transactionDate: '2026-10-01', status: 'posted', amountMinor: -50000, currency: 'USD', kind: 'payment',
      description: 'AUTOPAY PAYMENT - THANK YOU', createdAt: at, updatedAt: at,
    });
    // A month of two pages: the payment, last, is on the second, shown after "Show more".
    const purchases = Array.from({ length: 160 }, (_, index) => toCardTransactionView({
      id: `card-txn-${index.toString(16).padStart(32, '0')}`, cardAccountId: accounts[0].id, source: 'ofx', fingerprint: index.toString(16).padStart(64, '0'),
      transactionDate: `2026-10-${String(16 - Math.floor(index / 11)).padStart(2, '0')}`, status: 'posted', amountMinor: 1200 + index, currency: 'USD',
      kind: 'purchase', description: `SYNTHETIC SHOP ${index + 1}`, createdAt: at, updatedAt: at,
    }));
    const posted = [...purchases, payment];
    let listRequests = 0;
    await page.route((url) => url.pathname.startsWith('/card-transactions'), async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/card-transactions') {
        listRequests += 1;
        // Like a real fetch: the rows come a moment after the page does.
        await new Promise((resolve) => { setTimeout(resolve, 300); });
        const pending = url.searchParams.get('status') === 'pending';
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const rows = pending ? [] : posted.slice(offset, offset + 100);
        const nextOffset = pending || offset + 100 >= posted.length ? null : offset + 100;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ transactions: rows, total: pending ? 0 : posted.length, limit: 100, offset, nextOffset }) });
      }
      return route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify({
          transaction: payment, cardAccount: accounts[0], importBatch: null, possiblyPostedAs: [],
          possiblyPaidFrom: [{ date: '2026-10-02', eventType: 'withdrawal', amountMinor: -50000, currency: 'USD', dayOffset: 1, accountName: 'Synthetic brokerage' }],
        }),
      });
    });
    await page.goto('/#/everyday/transactions');
    await page.getByRole('button', { name: 'Show more (61 left)' }).click();
    const paymentRow = page.locator('.spending-transactions .spending-row-main').filter({ hasText: 'AUTOPAY PAYMENT' });
    await paymentRow.scrollIntoViewIfNeeded();
    await paymentRow.click();
    const dialog = page.getByRole('dialog', { name: 'AUTOPAY PAYMENT - THANK YOU' });
    await expect(dialog.getByRole('region', { name: 'Possibly paid from' })).toContainText('Synthetic brokerage');
    // The web fonts swap in when they arrive (display=swap), which moves every row a little: measure once they have.
    await page.evaluate(() => document.fonts.ready);
    const listPlace = await page.evaluate(() => window.scrollY);
    expect(listPlace).toBeGreaterThan(3000);
    const requestsBefore = listRequests;
    await dialog.getByRole('link', { name: 'Open the cash ledger in Investing' }).click();
    await expect(page).toHaveURL(/#\/investing\/transactions$/);
    await expectInvesting(page, 'Transactions');
    await expect(page.getByRole('region', { name: 'Cash ledger' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // Like loading a page: the top, with focus on the section it opened.
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await expect(sections(page).getByRole('tab', { name: 'Transactions', exact: true })).toBeFocused();
    // A link (not the switch) changed the mode: it is said for screen readers, and not remembered.
    await expect(page.locator('[aria-live="polite"]').filter({ hasText: 'Investing mode' })).toHaveCount(1);
    expect(await storedMode(page)).toBeNull();
    // Back: the same view, both pages and all, at the same place; the details were closed when the link was followed.
    await page.goBack();
    await expectEveryday(page, 'Card transactions');
    await expect.poll(() => page.evaluate((place) => Math.abs(window.scrollY - place), listPlace), { timeout: 6000 }).toBeLessThan(2);
    await expect(paymentRow).toBeInViewport();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(listRequests).toBe(requestsBefore);
    // Opening Everyday afresh (here with the switch) starts its view anew, as opening the Spending tab always did.
    await modeRadio(page, 'Investing').click();
    await expectInvesting(page, 'Transactions');
    await modeRadio(page, 'Everyday').click();
    await expectEveryday(page, 'Card transactions');
    await expect(page.getByRole('button', { name: 'Show more (61 left)' })).toBeVisible();
    await expect(paymentRow).toHaveCount(0);
  });

  test('a view left with a dialog open is not kept: back to Investing leaves nothing that traps Tab', async ({ page }) => {
    await serveOwner(page);
    await page.goto('/#/everyday/devices');
    await modeRadio(page, 'Investing').click();
    await expectInvesting(page, 'Portfolio');
    await modeRadio(page, 'Everyday').click();
    await expectEveryday(page, 'Extension & devices');
    await page.getByRole('button', { name: 'Connect a card…' }).click();
    await expect(page.getByRole('dialog', { name: 'Connect a card' })).toBeVisible();
    // Back while the dialog is open: Investing shows, and the view that held the dialog is let go.
    await page.goBack();
    await expectInvesting(page, 'Portfolio');
    await expect(page.locator('.app > .spending')).toHaveCount(0);
    await page.getByRole('button', { name: 'Sign out' }).focus();
    await page.keyboard.press('Tab');
    await expect(sections(page).getByRole('tab', { name: 'Portfolio', exact: true })).toBeFocused();
    // Forward opens Everyday afresh, with no dialog.
    await page.goForward();
    await expectEveryday(page, 'Extension & devices');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('a dialog that opens in the hidden view later (an answer that comes after leaving) lets the view go too', async ({ page }) => {
    const owner = await serveOwner(page, { scenario: 'fresh' });
    await page.goto('/#/everyday/devices');
    const chase = page.getByRole('region', { name: 'Sync switches' }).locator('li[data-issuer="chase"]');
    await chase.getByRole('button', { name: 'Turn on…' }).click();
    await chase.getByText(/I understand the extension works inside my signed-in bank session/).click();
    owner.holdNextWrite = true;
    await chase.getByRole('button', { name: 'Turn Chase on' }).click();
    await expect.poll(() => owner.held).toBe(true);
    // Leave before the answer: nothing is open yet, so the view is kept.
    await modeRadio(page, 'Investing').click();
    await expectInvesting(page, 'Portfolio');
    await expect(page.locator('.app > .spending')).toHaveCount(1);
    // The answer asks the owner to confirm it's them: that dialog opens in the hidden view, which is let go.
    owner.release();
    await expect(page.locator('.app > .spending')).toHaveCount(0);
    await page.getByRole('button', { name: 'Sign out' }).focus();
    await page.keyboard.press('Tab');
    await expect(sections(page).getByRole('tab', { name: 'Portfolio', exact: true })).toBeFocused();
  });

  test('Everyday is dark like Investing: a switch never paints a light frame, and it prints dark on paper', async ({ page }) => {
    const html = page.locator('html');
    /** The lightest opaque background (WCAG relative luminance) painted in any frame until the switch has settled. */
    const lightestFrame = async (to: 'Investing' | 'Everyday'): Promise<{ lightest: number; frames: number }> => {
      await page.evaluate(() => {
        const state = window as unknown as { lightest: number; frames: number; sampling: boolean };
        const channel = (value: number) => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
        Object.assign(state, { lightest: 0, frames: 0, sampling: true });
        const sample = () => {
          if (!state.sampling) return;
          state.frames += 1;
          for (const node of document.querySelectorAll('html, body, .app > header, .spending-card, .spending-panel')) {
            const [r, g, b, alpha = 1] = (getComputedStyle(node).backgroundColor.match(/[\d.]+/g) ?? []).map(Number);
            if (alpha > 0) state.lightest = Math.max(state.lightest, 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b));
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      await modeRadio(page, to).click();
      // The colours ease while <html> has .mode-switching (useModeRoute marks it with the new mode, then drops it):
      // sample until it is gone, and two frames more.
      await expect(html).toHaveAttribute('data-mode', to.toLowerCase());
      await expect(html).not.toHaveClass(/\bmode-switching\b/);
      return page.evaluate(() => new Promise<{ lightest: number; frames: number }>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const state = window as unknown as { lightest: number; frames: number; sampling: boolean };
          state.sampling = false;
          resolve({ lightest: state.lightest, frames: state.frames });
        }));
      }));
    };
    await page.goto('/#/investing/portfolio');
    await expectInvesting(page, 'Portfolio');
    const toEveryday = await lightestFrame('Everyday');
    await expectEveryday(page, 'Card transactions');
    const toInvesting = await lightestFrame('Investing');
    await expectInvesting(page, 'Portfolio');
    expect(Math.min(toEveryday.frames, toInvesting.frames)).toBeGreaterThan(5);
    // Black is 0 and white 1: both palettes stay under 0.03 (Everyday's cards, its lightest, are 0.015).
    expect(Math.max(toEveryday.lightest, toInvesting.lightest)).toBeLessThan(0.03);

    // Browsers leave backgrounds out of print unless asked: Everyday prints dark text on white, not light on nothing.
    await modeRadio(page, 'Everyday').click();
    await expectEveryday(page, 'Card transactions');
    // Once the colours have finished easing, print takes its own at once.
    await expect(html).not.toHaveClass(/\bmode-switching\b/);
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(page.locator('body')).toHaveCSS('color', 'rgb(41, 40, 35)');
    await page.emulateMedia({ media: 'screen' });
  });
});

test.describe('Two modes (phone)', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('the switch fits beside the wordmark and neither mode overflows', async ({ page }) => {
    await page.goto('/');
    await expect(modeSwitch(page)).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    await modeRadio(page, 'Everyday').tap();
    await expectEveryday(page, 'Card transactions');
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    const option = await modeRadio(page, 'Everyday').boundingBox();
    expect(option!.height).toBeGreaterThanOrEqual(30);
    await page.setViewportSize({ width: 280, height: 700 });
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    await modeRadio(page, 'Investing').tap();
    await expectInvesting(page, 'Portfolio');
    expect(await overflow(page)).toBeLessThanOrEqual(1);
  });
});
