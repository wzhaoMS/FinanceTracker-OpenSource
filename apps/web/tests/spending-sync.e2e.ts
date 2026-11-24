import { expect, test, type Locator, type Page, type Route } from './fixtures';
import { computeCardInsights, summarizeCardSpending, toCardTransactionView, type CardOwner, type CardTransaction } from '@finance-tracker/shared';
import {
  DAY,
  FAKE_NOW,
  FAKE_OWNER_PASSWORD,
  FakeOwnerServer,
  HOUR,
  LEDGER_STORY_IDS,
  MINUTE,
  fakeCardAccounts,
  type FakeOwnerOptions,
  type FakeResponse,
} from '../src/components/spending/sync/fakeOwnerServer';
import { addIdentity, changeValues, createRow, identityIdFor, mergeRow, recordUserEdit, removeRow, unmergeRow } from '../src/components/spending/sync/fake/ledger';
import { cardTransactionIdFor, rowAt } from '../src/components/spending/sync/fake/model';

/**
 * The Spending tab's card-sync controls (E8-M), desktop and phone, against a
 * fake Holdr that answers the proposed owner API (synthetic data only). The
 * page's real client calls it through `services/api.ts`; `page.route` hands
 * those calls to the fake in this process, so nothing reaches a real Holdr,
 * and the base Spending routes are served the same way with synthetic card
 * accounts. Device routes are never called by the page: any attempt fails
 * the test.
 */

const accounts = fakeCardAccounts(FAKE_NOW);

interface Harness {
  fake: FakeOwnerServer;
  deviceCalls: string[];
  /** Paths of the base Spending routes the page read, in order. */
  baseCalls: string[];
  /** Hands an intercepted request to the fake and returns its answer, without answering the page. */
  deliver: (route: Route) => Promise<FakeResponse>;
}

async function serve(page: Page, options: FakeOwnerOptions | null, extra: { ledger?: boolean } = {}): Promise<Harness> {
  const fake = new FakeOwnerServer(options ?? {});
  const deviceCalls: string[] = [];
  const baseCalls: string[] = [];
  const owners = new Map<string, CardOwner>(accounts.map((account) => [account.id, account.owner]));
  /** Spending's own rows, from the fake's ledger, as Phase 4's routes would filter them (with `ledger`; otherwise none). */
  const inView = (url: URL): CardTransaction[] => {
    if (!extra.ledger) return [];
    const param = (name: string) => url.searchParams.get(name) ?? '';
    const words = param('q').toLowerCase();
    return fake.spendingRows()
      .filter((row) => (!param('cardAccountId') || row.cardAccountId === param('cardAccountId'))
        && (!param('owner') || owners.get(row.cardAccountId) === param('owner'))
        && (!param('from') || row.transactionDate >= param('from'))
        && (!param('to') || row.transactionDate <= param('to'))
        && (!words || `${row.description} ${row.merchant ?? ''}`.toLowerCase().includes(words)))
      .sort((a, b) => b.transactionDate.localeCompare(a.transactionDate) || a.id.localeCompare(b.id));
  };
  await page.route((url) => /^\/(?:card-accounts|card-imports|card-transactions|spending)(?:[/?]|$)/.test(url.pathname), (route) => {
    const url = new URL(route.request().url());
    baseCalls.push(url.pathname);
    let body: unknown = null;
    if (url.pathname === '/card-accounts') body = { cardAccounts: accounts };
    if (url.pathname === '/spending/coverage') body = { cards: [] };
    if (url.pathname === '/spending/summary') body = { ...summarizeCardSpending(inView(url), { owners }), categories: [] };
    if (url.pathname === '/spending/insights') body = computeCardInsights([], { month: '2026-10', today: '2026-10-17', currency: 'USD' });
    if (url.pathname === '/card-transactions') {
      const status = url.searchParams.get('status');
      const all = inView(url).filter((row) => !status || row.status === status).map(toCardTransactionView);
      const limit = Number(url.searchParams.get('limit') ?? 100);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const transactions = all.slice(offset, offset + limit);
      body = { transactions, total: all.length, limit, offset, nextOffset: offset + transactions.length < all.length ? offset + transactions.length : null };
    }
    const one = /^\/card-transactions\/([^/]+)$/.exec(url.pathname);
    const row = one && extra.ledger && route.request().method() === 'GET' ? fake.spendingRows().find((item) => item.id === decodeURIComponent(one[1])) : null;
    if (row) {
      body = {
        transaction: toCardTransactionView(row),
        cardAccount: accounts.find((account) => account.id === row.cardAccountId) ?? null,
        importBatch: null,
        possiblyPostedAs: [],
        possiblyPaidFrom: [],
      };
    }
    return route.fulfill(body === null
      ? { status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }) }
      : { status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route((url) => url.pathname.startsWith('/card-sync/') && !url.pathname.startsWith('/card-sync/owner/'), (route) => {
    deviceCalls.push(new URL(route.request().url()).pathname);
    return route.abort();
  });
  const deliver = async (route: Route): Promise<FakeResponse> => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = Object.fromEntries(Object.entries(await request.allHeaders()).map(([key, value]) => [key.toLowerCase(), value]));
    return fake.handle({ method: request.method(), url: `${url.pathname}${url.search}`, headers, body: request.postData() });
  };
  if (options) {
    const handle = async (route: Route) => {
      const response = await deliver(route);
      await route.fulfill({ status: response.status, contentType: 'application/json', body: JSON.stringify(response.body) });
    };
    await page.route((url) => url.pathname.startsWith('/card-sync/owner/') || url.pathname === '/auth/reverify', handle);
  }
  return { fake, deviceCalls, baseCalls, deliver };
}

type AreaName = 'Card transactions' | 'Sync & coverage' | 'Extension & devices';

/** One of the Spending tab's own areas (the app's top-level tabs include another \"Transactions\"). */
const areaTab = (page: Page, area: AreaName) => page.getByRole('tablist', { name: 'Spending areas' }).getByRole('tab', { name: new RegExp(`^${area}`) });

async function openArea(page: Page, area: AreaName): Promise<void> {
  await page.clock.setFixedTime(new Date(FAKE_NOW));
  await page.goto('/');
  await page.getByRole('tab', { name: 'Spending', exact: true }).click();
  await areaTab(page, area).click();
}

async function confirmPassword(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Confirm it\'s you' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Holdr password').fill(FAKE_OWNER_PASSWORD);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toHaveCount(0);
}

const card = (page: Page, issuer: string) => page.getByRole('region', { name: 'Connected cards' }).locator(`li[data-binding="${issuer}"]`);
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);

test.use({ timezoneId: 'UTC', locale: 'en-US' });

test.beforeAll(async ({ request }) => {
  const health = await request.get('/health').catch(() => null);
  test.skip(!health || !health.ok(), 'The stack behind WEB_URL is unavailable.');
});

test.describe('Spending sync controls (desktop)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('says "not set up" when Holdr has no owner API, and never shows fake data instead', async ({ page }) => {
    const { deviceCalls } = await serve(page, null);
    await openArea(page, 'Sync & coverage');
    await expect(page.getByText('Not set up: this Holdr doesn\'t support extension sync yet.')).toBeVisible();
    const banner = page.locator('.sync-banner', { hasText: 'Not set up' });
    // A next step that works now, and what extension sync will take.
    await expect(banner).toContainText('Card spending from offline files keeps working: Import a statement.');
    await expect(banner).toContainText('Extension sync needs a Holdr version that has it; then, in Extension & devices, you turn the bank on');
    await banner.getByRole('button', { name: 'Import a statement' }).click();
    const importing = page.getByRole('dialog', { name: 'Import card spending' });
    await expect(importing).toBeVisible();
    await importing.getByRole('button', { name: 'Close import' }).click();
    await expect(importing).toHaveCount(0);
    await expect(page.getByText(/Synthetic mock data/)).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Connected cards' })).toHaveCount(0);
    await areaTab(page, 'Extension & devices').click();
    await expect(page.getByText('Not set up: this Holdr doesn\'t support extension sync yet.')).toBeVisible();
    await expect(page.locator('.sync-banner', { hasText: 'Not set up' }).getByRole('button', { name: 'Import a statement' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pair a browser…' })).toHaveCount(0);
    expect(deviceCalls).toEqual([]);
  });

  test('with no card connected yet, Sync & coverage says what setting up takes, and file import stays one click away', async ({ page }) => {
    await serve(page, { scenario: 'fresh' });
    await openArea(page, 'Sync & coverage');
    const empty = page.getByRole('region', { name: 'Connected cards' });
    await expect(empty.getByRole('heading', { name: 'Connected cards' })).toBeVisible();
    await expect(empty).toContainText('Not set up. No card is connected to the extension yet.');
    // What setting up takes, one step per line, in order.
    await expect(empty.getByTestId('setup-steps').getByRole('listitem')).toHaveText([
      'Turn the bank on.', 'Confirm which cards are on the card account.', 'Pair a browser and approve it.',
    ]);
    await expect(empty).toContainText('Until then, card spending from offline files keeps working.');
    await empty.getByRole('button', { name: 'Import a statement' }).click();
    const importing = page.getByRole('dialog', { name: 'Import card spending' });
    await expect(importing).toBeVisible();
    await importing.getByRole('button', { name: 'Close import' }).click();
    await empty.getByRole('button', { name: 'Set up in Extension & devices' }).click();
    await expect(areaTab(page, 'Extension & devices')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('region', { name: 'First run' })).toBeVisible();
  });

  test('first run: turn an issuer on, confirm the cards, pair, compare the code and approve', async ({ page }) => {
    const { fake, deviceCalls } = await serve(page, { scenario: 'fresh' });
    await openArea(page, 'Extension & devices');
    const steps = page.getByRole('region', { name: 'First run' });
    await expect(steps.locator('li[data-step="binding"]')).not.toHaveClass(/done/);
    await expect(steps.locator('li[data-step="extension"]')).toHaveClass(/elsewhere/);

    const chase = page.getByRole('region', { name: 'Sync switches' }).locator('li[data-issuer="chase"]');
    await chase.getByRole('button', { name: 'Turn on…' }).click();
    const turnOn = chase.getByRole('button', { name: 'Turn Chase on' });
    await expect(turnOn).toBeDisabled();
    await chase.getByText(/I understand the extension works inside my signed-in bank session/).click();
    await turnOn.click();
    await confirmPassword(page);
    await expect(chase).toContainText('Chase: on');

    await page.getByRole('button', { name: 'Connect a card…' }).click();
    const editor = page.getByRole('dialog', { name: 'Connect a card' });
    await editor.getByLabel('Holdr card account').selectOption({ label: 'Chase Sapphire (synthetic) ··3391 · Joint' });
    await editor.getByLabel('Bank source').selectOption({ label: 'Chase activity, read in the page' });
    await editor.getByLabel('Display name').fill('Chase Sapphire');
    await editor.getByLabel('Card name').fill('Alex\'s card');
    await editor.getByLabel('Holder').selectOption('alex');
    await editor.getByLabel('Last four').fill('3391');
    await expect(editor.getByRole('button', { name: 'Connect this card' })).toBeDisabled();
    await editor.getByText('I checked these cards against what the bank shows for this account.').click();
    await editor.getByRole('button', { name: 'Connect this card' }).click();
    await expect(editor).toHaveCount(0);
    const bindings = page.getByRole('region', { name: 'Connected cards' });
    await expect(bindings).toContainText('Chase Sapphire (Chase)');
    await expect(bindings).toContainText('Alex\'s card ··3391 (Alex)');
    await expect(bindings).toContainText('Holder unknown');

    await page.getByRole('button', { name: 'Pair a browser…' }).click();
    const pairing = page.getByRole('dialog', { name: 'Pair a browser' });
    await expect(pairing.getByRole('button', { name: 'Create a pairing code' })).toBeDisabled();
    await pairing.getByLabel('Chase Sapphire (Chase)').check();
    await pairing.getByRole('button', { name: 'Create a pairing code' }).click();
    const code = pairing.getByTestId('pairing-code');
    await expect(code).toHaveText(/^([a-p]{4} ){7}[a-p]{4}$/);
    const spacedCode = (await code.textContent())!;
    const shownCode = spacedCode.replace(/ /g, '');
    const pairingId = fake.store.pairings.at(-1)!.pairingId;
    expect(shownCode).toBe(fake.pairingCode(pairingId));
    await expect(pairing.getByText('https://holdr-fake.example.test')).toBeVisible();
    await expect(pairing.getByTestId('pairing-countdown')).toHaveText('5:00');
    await expect(pairing.getByRole('button', { name: /copy/i })).toHaveCount(0);

    const device = fake.redeemOpenPairing('Laptop Chrome');
    await pairing.getByRole('button', { name: 'Check now' }).click();
    await expect(pairing.getByTestId('confirmation-code')).toHaveText(device.fingerprint);
    await expect(page.getByText(spacedCode)).toHaveCount(0);
    const approve = pairing.getByRole('button', { name: 'Approve' });
    await expect(approve).toBeDisabled();
    await pairing.getByText('The popup shows exactly this confirmation code and this address').click();
    await approve.click();
    await expect(pairing.getByText('Laptop Chrome can now send for the chosen cards.')).toBeVisible();
    await pairing.getByRole('button', { name: 'Done' }).click();
    const browsers = page.getByRole('region', { name: 'Browsers' });
    await expect(browsers.locator(`li[data-device="${device.deviceId}"]`)).toContainText('Laptop Chrome: active');
    await expect(steps.locator('li[data-step="pair"]')).toHaveClass(/done/);
    expect(fake.requests.every((request) => !request.hadAuthorization)).toBe(true);
    expect(fake.requests.filter((request) => request.method === 'POST').every((request) => request.hadCsrfHeader)).toBe(true);
    expect(deviceCalls).toEqual([]);
  });

  test('rejects a browser whose code differs, and cancels a code nobody used', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    await openArea(page, 'Extension & devices');
    await page.getByRole('button', { name: 'Pair a browser…' }).click();
    let dialog = page.getByRole('dialog', { name: 'Pair a browser' });
    await dialog.getByLabel('Chase Sapphire (Chase)').check();
    await dialog.getByRole('button', { name: 'Create a pairing code' }).click();
    await expect(dialog.getByTestId('pairing-code')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel pairing' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => fake.store.pairings.at(-1)!.status).toBe('cancelled');

    await page.getByRole('button', { name: 'Pair a browser…' }).click();
    dialog = page.getByRole('dialog', { name: 'Pair a browser' });
    await dialog.getByLabel('Chase Sapphire (Chase)').check();
    await dialog.getByRole('button', { name: 'Create a pairing code' }).click();
    await expect(dialog.getByTestId('pairing-code')).toBeVisible();
    const device = fake.redeemOpenPairing('Unknown Chrome');
    await dialog.getByRole('button', { name: 'Check now' }).click();
    await expect(dialog.getByText('If anything differs, reject it: someone else may have used the code.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Reject' }).click();
    await expect(dialog.getByText('This pairing was closed.')).toBeVisible();
    expect(fake.store.devices.find((item) => item.deviceId === device.deviceId)!.revokeReason).toBe('rejected');
  });

  test('pairing waits for the bank to be turned on once; a browser not approved in time shows as expired (E1b revision 3)', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'fresh', recentAuth: 'granted' });
    await openArea(page, 'Extension & devices');
    await page.getByRole('button', { name: 'Connect a card…' }).click();
    const editor = page.getByRole('dialog', { name: 'Connect a card' });
    await editor.getByLabel('Holdr card account').selectOption({ label: 'Chase Sapphire (synthetic) ··3391 · Joint' });
    await editor.getByLabel('Bank source').selectOption({ label: 'Chase activity, read in the page' });
    await editor.getByLabel('Display name').fill('Chase Sapphire');
    await editor.getByLabel('Card name').fill('Alex\'s card');
    await editor.getByLabel('Holder').selectOption('alex');
    await editor.getByLabel('Last four').fill('3391');
    await editor.getByText('I checked these cards against what the bank shows for this account.').click();
    await editor.getByRole('button', { name: 'Connect this card' }).click();
    await expect(editor).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'First run' }).locator('li[data-step="pair"]')).toContainText('Turn the bank on under Sync switches first');

    await page.getByRole('button', { name: 'Pair a browser…' }).click();
    const pairing = page.getByRole('dialog', { name: 'Pair a browser' });
    await pairing.getByLabel('Chase Sapphire (Chase)').check();
    await expect(pairing.getByText(/^Chase is off under Sync switches\. Turn it on there first/)).toBeVisible();
    await pairing.getByRole('button', { name: 'Create a pairing code' }).click();
    await expect(pairing.getByRole('alert')).toContainText('Holdr hasn\'t accepted this bank\'s data format. If the bank is off under Sync switches, turn it on there first.');
    await expect(pairing.getByTestId('pairing-code')).toHaveCount(0);
    expect(fake.store.pairings).toEqual([]);
    await pairing.getByRole('button', { name: 'Cancel', exact: true }).click();

    const chase = page.getByRole('region', { name: 'Sync switches' }).locator('li[data-issuer="chase"]');
    await chase.getByRole('button', { name: 'Turn on…' }).click();
    await chase.getByText(/I understand the extension works inside my signed-in bank session/).click();
    await chase.getByRole('button', { name: 'Turn Chase on' }).click();
    await expect(chase).toContainText('Chase: on');
    await page.getByRole('button', { name: 'Pair a browser…' }).click();
    await pairing.getByLabel('Chase Sapphire (Chase)').check();
    await expect(pairing.getByText(/off under Sync switches/)).toHaveCount(0);
    await pairing.getByRole('button', { name: 'Create a pairing code' }).click();
    await expect(pairing.getByTestId('pairing-code')).toBeVisible();
    const device = fake.redeemOpenPairing('Spare Chrome');
    fake.advance(11 * MINUTE);
    await openArea(page, 'Extension & devices');
    const row = page.getByRole('region', { name: 'Browsers' }).locator(`li[data-device="${device.deviceId}"]`);
    await expect(row).toContainText('Spare Chrome: expired');
    await expect(row).toContainText('Never approved: the time to approve it ran out Oct 17, 2026, 12:10 PM.');
    // It never sent anything, so there is nothing to revoke it for.
    await expect(row.getByRole('button')).toHaveCount(0);
    expect(fake.store.devices.find((item) => item.deviceId === device.deviceId)!.revokeReason).toBeNull();
  });

  test('pausing is one click and needs no password; resuming asks for it', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo' });
    await openArea(page, 'Sync & coverage');
    await page.getByRole('button', { name: 'Pause all syncing' }).click();
    await expect(page.getByText(/^All syncing is paused since/)).toBeVisible();
    await expect(card(page, 'chase').locator('[data-status]')).toHaveText('Paused');
    await expect(card(page, 'chase').getByTestId('next-step')).toHaveText('Next: Resume syncing in Extension & devices (your password is asked again).');
    expect(fake.store.paused).toBe(true);

    await page.getByRole('button', { name: 'Resume in Extension & devices' }).click();
    await page.getByRole('button', { name: 'Resume syncing' }).click();
    await page.getByRole('dialog', { name: 'Confirm it\'s you' }).getByRole('button', { name: 'Cancel' }).click();
    expect(fake.store.paused).toBe(true);
    await page.getByRole('button', { name: 'Resume syncing' }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm it\'s you' });
    await dialog.getByLabel('Holdr password').fill('not the password');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(dialog.getByText('That password didn\'t work. Try again.')).toBeVisible();
    await expect(dialog.getByLabel('Holdr password')).toHaveValue('');
    await dialog.getByLabel('Holdr password').fill(FAKE_OWNER_PASSWORD);
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByText('Syncing resumed.')).toBeVisible();
    expect(fake.store.paused).toBe(false);
  });

  test('a 401 from the password check means the sign-in ended, never "wrong password" (R6)', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo' });
    fake.core.pause();
    await openArea(page, 'Extension & devices');
    fake.failNext(/^POST \/auth\/reverify$/, { status: 401, body: { error: 'unauthorized' } });
    await page.getByRole('button', { name: 'Resume syncing' }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm it\'s you' });
    await dialog.getByLabel('Holdr password').fill(FAKE_OWNER_PASSWORD);
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    // Before sign-in landed, the dialog says so itself; with it, `api()` hands every 401 to the app, which shows its own sign-in form.
    await expect(dialog.getByText('Your Holdr sign-in has ended. Sign in again.').or(page.getByText('Your session has ended. Sign in again.'))).toBeVisible();
    await expect(page.getByText('That password didn\'t work. Try again.')).toHaveCount(0);
    expect(fake.store.paused).toBe(true);
  });

  test('revokes a browser after a warning; its card then has no working device', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo' });
    await openArea(page, 'Extension & devices');
    const browsers = page.getByRole('region', { name: 'Browsers' });
    const edge = browsers.locator('li', { hasText: 'Mac Edge: expired' });
    await expect(edge).toContainText('Its 30 days ran out');
    // E1b §5.3: one that ran out can still be revoked (what it sent then waits for a source check); it is never paired again.
    await expect(edge.getByRole('button')).toHaveText(['Revoke…']);
    const mac = browsers.locator('li', { hasText: 'Mac Chrome: active' });
    await mac.getByRole('button', { name: 'Revoke…' }).click();
    const confirm = page.getByRole('dialog', { name: 'Revoke Mac Chrome?' });
    await expect(confirm).toContainText('also disable or remove it in the browser');
    await confirm.getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByText('Mac Chrome is revoked.')).toBeVisible();
    expect(fake.store.devices.find((device) => device.deviceLabel === 'Mac Chrome')!.revokeReason).toBe('owner');
    await areaTab(page, 'Sync & coverage').click();
    await expect(card(page, 'citi').locator('[data-status]')).toHaveText('No working device');
    await expect(card(page, 'citi')).toContainText('Revoked or expired credentials never come back.');
  });

  test('a browser whose 30 days ran out leaves what it sent waiting as usual, with no source check (E1b revision 4)', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    const laptop = fake.store.devices.find((device) => device.deviceLabel === 'Laptop Chrome')!;
    fake.advance(laptop.deviceExpiresAt! - fake.now() + MINUTE);
    await openArea(page, 'Sync & coverage');
    await expect(card(page, 'chase').locator('[data-status]')).toHaveText('No working device');
    const queue = page.getByRole('region', { name: 'Imports awaiting review' });
    const chaseSet = fake.store.sets.find((set) => set.bindingId === laptop.bindingIds[0] && set.closeReason === null)!;
    const row = queue.locator(`li[data-set="${chaseSet.observationSetId}"]`);
    await expect(row).toBeVisible();
    await expect(row).not.toContainText('check the source');
    await row.getByRole('button', { name: 'Review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review: Chase Sapphire (Chase)' });
    await expect(dialog.getByText('I checked where this import came from and still want to use it')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Prepare the plan from the current ledger' }).click();
    await dialog.getByRole('button', { name: 'Confirm and apply the plan' }).click();
    await expect(dialog.getByText('Plan applied.', { exact: true })).toBeVisible();
    expect(chaseSet.state).toBe('committed');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await areaTab(page, 'Extension & devices').click();
    const browsers = page.getByRole('region', { name: 'Browsers' });
    await expect(browsers.locator(`li[data-device="${laptop.deviceId}"]`)).toContainText('Laptop Chrome: expired');
    await expect(browsers.locator(`li[data-device="${laptop.deviceId}"]`)).toContainText('Its 30 days ran out');
  });

  test('a browser whose 30 days ran out can still be revoked: what it sent then waits for a source check (E1b §5.3)', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo' });
    const laptop = fake.store.devices.find((device) => device.deviceLabel === 'Laptop Chrome')!;
    fake.advance(laptop.deviceExpiresAt! - fake.now() + MINUTE);
    const chaseSet = fake.store.sets.find((set) => set.deviceId === laptop.deviceId && set.closeReason === null)!;
    await openArea(page, 'Extension & devices');
    const row = page.getByRole('region', { name: 'Browsers' }).locator(`li[data-device="${laptop.deviceId}"]`);
    await expect(row).toContainText('Laptop Chrome: expired');
    await row.getByRole('button', { name: 'Revoke…' }).click();
    const confirm = page.getByRole('dialog', { name: 'Revoke Laptop Chrome?' });
    await expect(confirm).toContainText('Laptop Chrome\'s 30 days already ran out, so Holdr refuses it already.');
    await expect(confirm).toContainText('what it sent that isn\'t in spending yet waits for a source check');
    await confirm.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(page.getByText('Laptop Chrome is revoked.')).toBeVisible();
    await expect(row).toContainText('Laptop Chrome: revoked');
    // It keeps the time it stopped working (X34); the revocation came after.
    await expect(row).toContainText(/Its 30 days ran out [^;]+; revoked afterwards \(by you\)\./);
    await expect(row.getByRole('button')).toHaveCount(0);
    const device = fake.store.devices.find((item) => item.deviceId === laptop.deviceId)!;
    expect([device.revokeReason, device.revokedAt]).toEqual(['owner', laptop.deviceExpiresAt]);
    expect(chaseSet.state).toBe('blocked-review');
    await areaTab(page, 'Sync & coverage').click();
    await expect(page.getByRole('region', { name: 'Imports awaiting review' }).locator(`li[data-set="${chaseSet.observationSetId}"]`)).toContainText('check the source');
  });

  test('every card shows its place in the §8 status list, with flags and a safe next step', async ({ page }) => {
    await serve(page, { scenario: 'demo' });
    await openArea(page, 'Sync & coverage');
    await expect(card(page, 'chase').locator('[data-status]')).toHaveText('Received, awaiting review (not in spending)');
    // What the last import covered is folded under the card's details, with Holdr's own check.
    await card(page, 'chase').getByRole('button', { name: 'Details: attempts, plans, browsers and coverage' }).click();
    await expect(card(page, 'chase')).toContainText('read to the end; check against the statement');
    const amex = card(page, 'amex');
    await expect(amex.locator('[data-status]')).toHaveText('Plan expired (prepare a new one)');
    await expect(amex.locator('[data-flag]')).toHaveText(['Bank sign-in needed', 'Partial coverage']);
    await expect(amex).toContainText('Sign in yourself; Holdr and the extension never sign in for you.');
    await expect(amex).toContainText('Review expires in 5 days');
    const citi = card(page, 'citi');
    await expect(citi.locator('[data-flag]')).toHaveText(['Rate-limited', 'Partial coverage']);
    await expect(citi).toContainText('Review expires in 4 hours');
    await expect(citi).toContainText('Import the redacted offline file for the dates not covered.');
    const wf = card(page, 'wellsfargo');
    await expect(wf.locator('[data-status]')).toHaveText('Send result unknown');
    await expect(wf).toContainText('Never switch to HTTP or ignore a certificate error.');
    await expect(areaTab(page, 'Sync & coverage')).toContainText('3');
    await expect(areaTab(page, 'Sync & coverage')).toHaveAccessibleName(/^Sync & coverage\s*, 3 imports awaiting review$/);

    await areaTab(page, 'Card transactions').click();
    await expect(page.getByText('3 imports are awaiting review and not in these figures.')).toBeVisible();
    await page.getByRole('button', { name: 'Review them' }).click();
    await expect(page.getByRole('region', { name: 'Imports awaiting review' })).toBeVisible();
  });

  test('reviews every category: legacy attribution, a blocked merge, then a new plan and its confirmation', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    await openArea(page, 'Sync & coverage');
    await card(page, 'amex').getByRole('button', { name: 'Review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review: Amex Gold (Amex)' });
    await expect(dialog.getByTestId('set-expiry')).toContainText('Less than a week left.');
    await expect(dialog.getByText(/Your last plan \(prepared .*\) expired at .* and was never applied\./)).toBeVisible();
    for (const label of ['Looks like one Holdr already has (2)', 'No stable id (2)', 'Card not known (1)', 'Maybe the same charge, pending and posted (1)']) {
      await expect(dialog.getByRole('heading', { name: label })).toBeVisible();
    }

    const legacy = dialog.locator('fieldset', { hasText: 'File import: no card recorded' });
    await expect(legacy).toContainText('category Date night; notes: Anniversary dinner (synthetic) (kept)');
    await expect(legacy).toContainText('Why Holdr asks: A transaction from another source looks the same.');
    await expect(dialog.locator('fieldset[data-category="pending-link"]')).toContainText('Why Holdr asks: A pending charge may have posted as this row.');
    await legacy.getByLabel(/Same transaction: put it on this card and link them/).check();
    const blocked = dialog.locator('fieldset', { hasText: 'CONTOSO AIRLINES' });
    await expect(blocked).toContainText('Not offered as the same transaction: it is on a different known card.');
    await expect(blocked.getByLabel(/Same transaction/)).toHaveCount(0);
    await blocked.getByLabel('Keep both (they may be counted twice)').check();
    await expect(blocked.getByText('Keeping both means spending may count this purchase twice.')).toBeVisible();
    const noId = dialog.getByRole('region', { name: 'No stable id' });
    await noId.getByLabel('Same decision for the 2 undecided items here').selectOption({ label: 'It\'s a new transaction: add it' });
    await noId.getByRole('button', { name: 'Apply' }).click();
    await dialog.locator('fieldset', { hasText: 'TAILSPIN CINEMA' }).getByLabel('Put it on this card: Basic card ··0003 (Alex)').check();
    await dialog.locator('fieldset', { hasText: 'FABRIKAM FUEL 77' }).getByLabel('It\'s the posted version of this pending charge').check();

    await dialog.getByRole('button', { name: 'Prepare a new plan from the current ledger' }).click();
    const plan = dialog.getByRole('region', { name: 'Plan' });
    await expect(plan).toContainText('Valid until');
    await expect(plan.locator('.sync-counts')).toContainText('4 Added');
    await expect(plan.locator('.sync-counts')).toContainText('2 Put on a card');
    await expect(plan.locator('.sync-counts')).toContainText('1 Pending → posted');
    await expect(plan.locator('li[data-effect="attribute"]')).toContainText('File import: no card recorded');
    await expect(plan.locator('li[data-effect="attribute"]')).toContainText('Basic card ··0003 (Alex)');
    await dialog.getByRole('button', { name: 'Confirm and apply the plan' }).click();
    await expect(dialog.getByText('Plan applied.', { exact: true })).toBeVisible();
    expect(fake.store.sets.find((set) => set.bindingId === fake.store.bindings[1].bindingId && set.committedAt)?.state).toBe('committed');
    await dialog.getByRole('button', { name: 'Close review' }).click();
    await expect(card(page, 'amex').locator('[data-status]')).toHaveText('Plan applied');
  });

  test('an expired plan is never extended: Holdr refuses it, and a new plan is prepared from the current ledger', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    await openArea(page, 'Sync & coverage');
    await card(page, 'chase').getByRole('button', { name: 'Review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review: Chase Sapphire (Chase)' });
    await expect(dialog.getByText('Nothing here needs a decision')).toBeVisible();
    await dialog.getByRole('button', { name: 'Prepare the plan from the current ledger' }).click();
    await expect(dialog.getByRole('region', { name: 'Plan' }).locator('.sync-counts')).toContainText('4 Added');
    const first = fake.store.sets[0].plans.at(-1)!.previewId;
    fake.advance(11 * MINUTE);
    await dialog.getByRole('button', { name: 'Confirm and apply the plan' }).click();
    await expect(dialog.getByText('This plan expired (plans last 10 minutes).')).toBeVisible();
    await dialog.getByRole('button', { name: 'Prepare a new plan from the current ledger' }).click();
    await expect(dialog.getByRole('region', { name: 'Plan' })).toBeVisible();
    expect(fake.store.sets[0].plans.at(-1)!.previewId).not.toBe(first);
    await dialog.getByRole('button', { name: 'Confirm and apply the plan' }).click();
    await expect(dialog.getByText('Plan applied.', { exact: true })).toBeVisible();
  });

  test('a capture that names a charge already in spending by a new id is listed as a new source, never as unchanged (E1b X37)', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    await openArea(page, 'Sync & coverage');
    await card(page, 'chase').getByRole('button', { name: 'Review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review: Chase Sapphire (Chase)' });
    await dialog.getByRole('button', { name: 'Prepare the plan from the current ledger' }).click();
    const plan = dialog.getByRole('region', { name: 'Plan' });
    await expect(plan.locator('.sync-counts')).toContainText('4 Added');
    await expect(plan.locator('.sync-counts')).toContainText('1 New source for a charge already in spending');
    await expect(plan.locator('.sync-counts')).toContainText('1 Unchanged');
    // Listed with what is in spending, once; the row that changes and attaches nothing is only counted.
    await expect(plan.locator('li[data-effect]')).toHaveCount(5);
    const alias = plan.locator('li[data-effect="alias"]');
    await expect(alias).toContainText('Already in spending: add this as another source of it (the charge stays as it is)');
    await expect(alias).toContainText('In spending, unchanged: ALPINE SKI HOUSE · $129.00 · posted');
    await expect(alias).not.toContainText('Before:');
    await dialog.getByRole('button', { name: 'Confirm and apply the plan' }).click();
    await expect(dialog.getByText('Plan applied.', { exact: true })).toBeVisible();
    await expect(dialog).toContainText('New source for a charge already in spending: 1');
    const sources = [...fake.store.ledger.identities.values()].filter((identity) => identity.canonicalId === LEDGER_STORY_IDS.alpine);
    expect(sources.map((identity) => [identity.namespaceKind, identity.status])).toEqual([['capture', 'active'], ['stable', 'active']]);
  });

  test('a change to who may send, made in another window, retires a prepared plan; a new one is prepared (E1b §5.0)', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    await openArea(page, 'Sync & coverage');
    await card(page, 'chase').getByRole('button', { name: 'Review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review: Chase Sapphire (Chase)' });
    await dialog.getByRole('button', { name: 'Prepare the plan from the current ledger' }).click();
    await expect(dialog.getByRole('region', { name: 'Plan' }).locator('.sync-counts')).toContainText('4 Added');
    const first = fake.store.sets[0].plans.at(-1)!.previewId;
    // Another bank turned off elsewhere: an authorization change, so every prepared plan of what browsers sent is retired.
    fake.core.disableIssuer('wellsfargo');
    await dialog.getByRole('button', { name: 'Confirm and apply the plan' }).click();
    await expect(dialog.getByText('Something changed since this plan was made.')).toBeVisible();
    expect(fake.store.sets[0].state).toBe('accepted-uncommitted');
    await dialog.getByRole('button', { name: 'Prepare a new plan from the current ledger' }).click();
    await expect(dialog.getByRole('region', { name: 'Plan' })).toBeVisible();
    expect(fake.store.sets[0].plans.at(-1)!.previewId).not.toBe(first);
    await dialog.getByRole('button', { name: 'Confirm and apply the plan' }).click();
    await expect(dialog.getByText('Plan applied.', { exact: true })).toBeVisible();
  });

  test('warns 7 days and 1 day before observations expire, and an expired review can no longer be confirmed', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo' });
    await openArea(page, 'Sync & coverage');
    const queue = page.getByRole('region', { name: 'Imports awaiting review' });
    await expect(queue.locator('li', { hasText: 'Citi Double Cash' })).toContainText('less than a day left');
    await expect(queue.locator('li', { hasText: 'Amex Gold' })).toContainText('less than a week left');
    fake.advance(5 * HOUR);
    await page.getByRole('region', { name: 'Sync controls' }).getByRole('button', { name: 'Refresh' }).click();
    await expect(card(page, 'citi').locator('[data-status]')).toHaveText('Review expired (capture again)');
    await expect(card(page, 'citi').getByTestId('next-step')).toHaveText('Next: Capture this period again, or import the redacted offline file for it.');
    await expect(card(page, 'citi').getByTestId('card-lines').getByRole('listitem').first()).toHaveText('Nothing was added.');
    await expect(queue.locator('li', { hasText: 'Citi Double Cash' })).toHaveCount(0);
    await queue.getByRole('button', { name: 'Show closed reviews' }).click();
    const closed = queue.getByRole('list', { name: 'Closed reviews' });
    await expect(closed.locator('li', { hasText: 'Citi Double Cash' }).first()).toContainText('Expired without review; nothing was added.');
    await expect(closed.locator('li', { hasText: 'Expired without review' }).getByRole('button')).toHaveCount(0);
  });

  test('discards a set with a reason; nothing is added and it leaves the queue', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo' });
    await openArea(page, 'Sync & coverage');
    await card(page, 'chase').getByRole('button', { name: 'Review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review: Chase Sapphire (Chase)' });
    await dialog.getByRole('button', { name: 'Discard this import…' }).click();
    await expect(dialog.getByRole('button', { name: 'Discard', exact: true })).toBeDisabled();
    await dialog.getByLabel('Why discard it').selectOption('duplicate-of-file');
    await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'Discard this import?' });
    await expect(confirm).toContainText('keeps only a record without values');
    await confirm.getByRole('button', { name: 'Discard' }).click();
    await expect(dialog).toHaveCount(0);
    expect(fake.store.sets[0].state).toBe('rejected');
    await expect(page.getByRole('region', { name: 'Imports awaiting review' }).locator('li', { hasText: 'Chase Sapphire' })).toHaveCount(0);
  });

  test('changes a committed decision with an adjustment plan that unlinks and adds, deleting nothing', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    await openArea(page, 'Sync & coverage');
    const queue = page.getByRole('region', { name: 'Imports awaiting review' });
    await queue.getByRole('button', { name: 'Show closed reviews' }).click();
    await queue.getByRole('list', { name: 'Closed reviews' }).locator('li', { hasText: 'Plan applied' }).getByRole('button', { name: 'Open' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review: Chase Sapphire (Chase)' });
    await expect(dialog.getByTestId('adjust-window')).toContainText('You can still change a decision until');
    await expect(dialog.getByTestId('adjust-window')).toContainText('It never deletes what the bank sent.');
    const item = dialog.locator('fieldset', { hasText: 'FABRIKAM FUEL 77' });
    await expect(item).toContainText('In spending now: Same transaction: count it once');
    await expect(item).toContainText('Why Holdr asks: A transaction from another source looks the same.');
    await expect(dialog.getByRole('button', { name: 'Prepare the plan from the current ledger' })).toBeDisabled();
    await item.getByLabel('Keep both (they may be counted twice)').check();
    await dialog.getByRole('button', { name: 'Prepare the plan from the current ledger' }).click();
    const plan = dialog.getByRole('region', { name: 'Plan' });
    await expect(plan).toHaveAttribute('data-plan-kind', 'adjustment');
    await expect(plan).toContainText('Only the decisions you changed: each first undoes what the earlier decision did, then applies the new one.');
    await expect(plan.locator('li[data-effect]')).toHaveCount(2);
    await expect(plan.locator('li[data-effect="unmatch"]')).toContainText('Unlink');
    await expect(plan.locator('li[data-effect="insert"]')).toContainText('Add');
    await dialog.getByRole('button', { name: 'Confirm and apply the changes' }).click();
    await expect(dialog.getByText('Changes applied.', { exact: true })).toBeVisible();
    const committed = fake.store.sets.find((set) => set.state === 'committed' && set.items.length > 0)!;
    expect(committed.items[0].committed!.action).toBe('insert-new');
    expect(committed.payload).not.toBeNull();
  });

  test('a decision already in spending whose source a repair moved can\'t change in the review any more: Holdr says why and what to do (E1b §4.9.2)', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' }, { ledger: true });
    // A capture linked to a pending charge from an offline file and added to spending; then a repair moved its source to another charge.
    const setId = fake.addLegacyPendingSet(1);
    const set = fake.store.sets.find((item) => item.observationSetId === setId)!;
    const entry = set.items[0];
    const charge = entry.candidates[0].transactionId;
    fake.core.recordDecisions(setId, set.version, [
      { itemId: entry.itemId, action: 'attribute-and-link', transactionId: charge, cardScopeId: rowAt(set, entry.rowIndex!)!.cardScopeId },
    ]);
    const { plan } = fake.core.preparePlan(setId, set.version, false);
    fake.core.commitPlan(plan.previewId, plan.payloadDigest, plan.planDigest);
    const ledger = fake.store.ledger;
    const source = identityIdFor(`observation/${setId}/${entry.rowIndex}`);
    fake.core.repointIdentity(source, charge, LEDGER_STORY_IDS.tailspinLater, ledger.rows.get(charge)!.revision, ledger.rows.get(LEDGER_STORY_IDS.tailspinLater)!.revision);
    const written = ledger.events.length;

    await openArea(page, 'Sync & coverage');
    const queue = page.getByRole('region', { name: 'Imports awaiting review' });
    await queue.getByRole('button', { name: 'Show closed reviews' }).click();
    await queue.getByRole('list', { name: 'Closed reviews' }).locator(`li[data-set="${setId}"]`).getByRole('button', { name: 'Open' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review: Chase Sapphire (Chase)' });
    const item = dialog.locator(`fieldset[data-item="${entry.itemId}"]`);
    await expect(item).toContainText('In spending now:');
    await item.getByLabel('Don\'t add this row').check();
    const prepare = dialog.getByRole('button', { name: 'Prepare the plan from the current ledger' });
    await prepare.click();
    const refusal = dialog.getByRole('alert').filter({ hasText: 'Holdr can\'t make that change to a decision already in spending.' });
    await expect(refusal).toContainText('changed since the decision was added');
    await expect(refusal).toContainText('Choose what is in spending now again, or repair the charge from its Sources and history in Card transactions.');
    await expect(dialog.getByRole('region', { name: 'Plan' })).toHaveCount(0);
    expect([ledger.events.length, set.items[0].committed!.action, ledger.identities.get(source)!.canonicalId]).toEqual([
      written, 'attribute-and-link', LEDGER_STORY_IDS.tailspinLater,
    ]);
    // What is in spending can be chosen again; then there is nothing to change.
    await item.getByLabel(/^Same transaction: put it on this card and link them/).check();
    await expect(prepare).toBeDisabled();
  });

  test('a committed review past its 30 days is read-only: Spending\'s own tools change it from then on (Q34)', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    fake.advance(21 * 24 * HOUR);
    await openArea(page, 'Sync & coverage');
    const queue = page.getByRole('region', { name: 'Imports awaiting review' });
    await queue.getByRole('button', { name: 'Show closed reviews' }).click();
    await queue.getByRole('list', { name: 'Closed reviews' }).locator('li', { hasText: 'Plan applied' }).first().getByRole('button', { name: 'Open' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review: Chase Sapphire (Chase)' });
    await expect(dialog.getByTestId('adjust-window')).toContainText('decisions can\'t change here any more. Change the transactions themselves with Spending\'s own tools.');
    // Holdr offers no action on it any more (C3): what is in spending is shown, with nothing to choose.
    const item = dialog.locator('fieldset', { hasText: 'FABRIKAM FUEL 77' });
    await expect(item).toContainText('In spending now:');
    await expect(item.getByRole('radio')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: /Prepare/ })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Save decisions' })).toHaveCount(0);
  });

  test('a run shows received and added separately, the exact object sent with its digest, and what was cleared', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo' });
    await openArea(page, 'Sync & coverage');
    const runs = page.getByRole('region', { name: 'Recent runs' });
    const fresh = fake.store.runs[0];
    await runs.locator(`li[data-run="${fresh.runId}"]`).getByRole('button', { name: 'Details' }).click();
    let dialog = page.getByRole('dialog', { name: /^Run of / });
    await expect(dialog).toContainText(fake.store.sets[0].payloadDigest!);
    await dialog.getByRole('button', { name: 'Show the exact object sent' }).click();
    await expect(dialog.getByText('Digest checked: these are the bytes Holdr received.')).toBeVisible();
    const json = await dialog.getByRole('region', { name: 'Exact sent object (JSON)' }).textContent();
    expect(json).toContain('"format":"holdr.card-import"');
    expect(json).toContain('PROSEWARE BISTRO');
    expect(json).not.toMatch(/hdv1_|Authorization|token/i);
    await dialog.getByRole('button', { name: 'Close run' }).click();

    const refused = fake.store.runs.find((run) => run.errorCode === 'review-quota-exceeded')!;
    await expect(runs.locator(`li[data-run="${refused.runId}"]`)).toContainText('Holdr refused the whole upload because the review queue was full. Nothing from it is waiting.');
    const amex = fake.store.runs.find((run) => run.runId === fake.store.sets.find((set) => set.state === 'needs-review')!.runId)!;
    await runs.locator(`li[data-run="${amex.runId}"]`).getByRole('button', { name: 'Details' }).click();
    dialog = page.getByRole('dialog', { name: /^Run of / });
    await expect(dialog.getByTestId('receipt-cleared')).toContainText('The exact sent object was cleared after 7 days. The review record is still kept until');
    await expect(dialog.getByRole('button', { name: 'Show the exact object sent' })).toHaveCount(0);
  });

  test('a run whose review expired says none of its rows was added, though Holdr lists no result for them (E2a)', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo' });
    const set = fake.store.sets.find((item) => item.state === 'accepted-uncommitted' && item.runId !== null)!;
    // Its 30 days are over: E2a lists no row of an expired review (handoff 10/18 02:30 item 4).
    fake.advance(set.expiresAt - fake.now() + MINUTE);
    await openArea(page, 'Sync & coverage');
    await page.getByRole('region', { name: 'Recent runs' }).locator(`li[data-run="${set.runId}"]`).getByRole('button', { name: 'Details' }).click();
    const dialog = page.getByRole('dialog', { name: /^Run of / });
    await expect(dialog.getByTestId('run-rows')).toHaveText(
      /^\d+ rows? expired before anyone reviewed (it|them), so nothing from this run was added\. Their values are gone too: only this record without values stays\.$/,
    );
    await expect(dialog.getByRole('region', { name: 'Row results' })).toHaveCount(0);
  });

  test('a run the extension stopped says why, with the safe next step, on the card, in the run list and in the run', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo' });
    const runId = fake.startRun('wellsfargo', 'site-permission-revoked');
    await openArea(page, 'Sync & coverage');
    const wf = card(page, 'wellsfargo');
    await expect(wf.locator('[data-status]')).toHaveText('Stopped: site access was removed');
    await expect(wf.getByTestId('next-step')).toHaveText('Next: Grant access again in the extension popup, then open the activity page.');
    await expect(wf.getByTestId('card-lines').getByRole('listitem')).toHaveText([
      'The browser no longer lets the extension read this bank\'s site.', 'Nothing was sent.',
    ]);
    const runs = page.getByRole('region', { name: 'Recent runs' });
    const signedOut = runs.locator(`li[data-run="${fake.store.runs.find((run) => run.abortReason === 'not-signed-in')!.runId}"]`);
    await expect(signedOut).toContainText('stopped by the extension; nothing received');
    await expect(signedOut).toContainText('Stopped: not signed in to the bank');
    await runs.locator(`li[data-run="${runId}"]`).getByRole('button', { name: 'Details' }).click();
    const stopped = page.getByRole('dialog', { name: /^Run of / }).getByTestId('run-stopped');
    await expect(stopped).toContainText('Stopped: site access was removed');
    await expect(stopped).toContainText('Next: Grant access again in the extension popup, then open the activity page.');
    await expect(stopped).toContainText('Nothing was sent.');
  });

  test('automatic sending: unavailable while Holdr keeps the bank\'s gate closed, then one switch per card, with a warning and the password (Q28, R1)', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo' });
    await openArea(page, 'Extension & devices');
    const bindings = page.getByRole('region', { name: 'Connected cards' });
    const auto = bindings.locator('li[data-binding="chase"]').getByRole('group', { name: 'Automatic sending for Chase Sapphire (Chase)' });
    await expect(auto).toContainText('Not available yet: Holdr opens automatic sending for Chase only after that bank\'s own checks pass.');
    const unavailable = auto.getByRole('button', { name: 'Turn automatic sending on…' });
    await expect(unavailable).toBeDisabled();
    await expect(unavailable).toHaveAccessibleDescription(/^Automatic sending: off\. Not available yet/);
    await expect(bindings.locator('li[data-binding="amex"]').getByRole('group', { name: /^Automatic sending for/ })).toContainText('Not available yet');

    // The gate opens: one switch for the card. If it closes again before the click, Holdr says so and nothing changes.
    fake.setAutoSyncGate('open', 'chase');
    await openArea(page, 'Extension & devices');
    await expect(auto.getByRole('button', { name: 'Turn automatic sending on…' })).toBeEnabled();
    fake.setAutoSyncGate('closed', 'chase');
    await auto.getByRole('button', { name: 'Turn automatic sending on…' }).click();
    await page.getByRole('dialog', { name: 'Send Chase Sapphire automatically?' }).getByRole('button', { name: 'Turn automatic sending on' }).click();
    await expect(bindings.getByText('Holdr hasn\'t opened automatic sending for this bank yet.')).toBeVisible();
    await expect(auto.getByRole('button', { name: 'Turn automatic sending on…' })).toBeDisabled();
    const chase = () => fake.store.bindings.find((binding) => binding.issuer === 'chase')!;
    expect(chase().autoSyncConsent.size).toBe(0);

    fake.setAutoSyncGate('open', 'chase');
    await openArea(page, 'Extension & devices');
    await auto.getByRole('button', { name: 'Turn automatic sending on…' }).click();
    const confirm = page.getByRole('dialog', { name: 'Send Chase Sapphire automatically?' });
    await expect(confirm).toContainText('This is permission given in advance, not a check each time: when the extension in Laptop Chrome reads this card');
    await expect(confirm).toContainText('a browser allowed later, or any change to the card\'s connection, asks again');
    await confirm.getByRole('button', { name: 'Turn automatic sending on' }).click();
    await confirmPassword(page);
    await expect(auto.getByTestId('auto-sync-state')).toHaveText('Automatic sending: on for Laptop Chrome.');
    await expect(auto).toContainText('Laptop Chrome: on since Oct 17, 2026');
    expect([[...chase().autoSyncConsent.keys()], chase().autoSyncRevision]).toEqual([[fake.store.devices[0].deviceId], 1]);
    await auto.getByRole('button', { name: 'Turn automatic sending off' }).click();
    await expect(auto.getByTestId('auto-sync-state')).toHaveText('Automatic sending: off.');
    expect([chase().autoSyncConsent.size, chase().autoSyncRevision]).toEqual([0, 2]);

    // Another window turns it on and off again; this page still shows revision 2, so its "on" is refused, not replayed (R1).
    fake.core.setAutoSync(chase().bindingId, { expectedVersion: chase().bindingVersion, expectedAutoSyncRevision: 2, enabled: true });
    fake.core.setAutoSync(chase().bindingId, { expectedVersion: chase().bindingVersion, expectedAutoSyncRevision: 3, enabled: false });
    await auto.getByRole('button', { name: 'Turn automatic sending on…' }).click();
    await page.getByRole('dialog', { name: 'Send Chase Sapphire automatically?' }).getByRole('button', { name: 'Turn automatic sending on' }).click();
    await expect(bindings.getByText('This changed in another window or browser.')).toBeVisible();
    expect([chase().autoSyncConsent.size, chase().autoSyncRevision]).toEqual([0, 4]);

    // On again; a browser allowed after that starts without consent and is offered on its own.
    await auto.getByRole('button', { name: 'Turn automatic sending on…' }).click();
    await page.getByRole('dialog', { name: 'Send Chase Sapphire automatically?' }).getByRole('button', { name: 'Turn automatic sending on' }).click();
    await expect(auto.getByTestId('auto-sync-state')).toHaveText('Automatic sending: on for Laptop Chrome.');
    const invite = fake.core.createPairing([chase().bindingId], null);
    const spare = fake.core.redeem(invite.code, 'Spare Chrome')!;
    fake.core.approvePairing(invite.pairingId, spare.deviceId, spare.fingerprint);
    await openArea(page, 'Extension & devices');
    await expect(auto).toContainText('Spare Chrome sends for this card but was allowed after you turned this on, so it doesn\'t send automatically.');
    await auto.getByRole('button', { name: 'Also send automatically from Spare Chrome…' }).click();
    const again = page.getByRole('dialog', { name: 'Send Chase Sapphire automatically?' });
    await expect(again).toContainText('when the extension in Spare Chrome reads this card');
    await again.getByRole('button', { name: 'Turn automatic sending on' }).click();
    await expect(auto.getByTestId('auto-sync-state')).toHaveText('Automatic sending: on for Laptop Chrome, Spare Chrome.');
    expect([...chase().autoSyncConsent.keys()].sort()).toEqual([fake.store.devices[0].deviceId, spare.deviceId].sort());
  });

  test('a browser approved while the automatic-sending confirmation is open is never switched on by it (R1)', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    fake.setAutoSyncGate('open', 'chase');
    await openArea(page, 'Extension & devices');
    const bindings = page.getByRole('region', { name: 'Connected cards' });
    const auto = bindings.locator('li[data-binding="chase"]').getByRole('group', { name: 'Automatic sending for Chase Sapphire (Chase)' });
    await auto.getByRole('button', { name: 'Turn automatic sending on…' }).click();
    const confirm = page.getByRole('dialog', { name: 'Send Chase Sapphire automatically?' });
    await expect(confirm).toContainText('when the extension in Laptop Chrome reads this card');
    // Spare Chrome is approved elsewhere while this confirmation, which never named it, is still open.
    const chase = fake.store.bindings.find((binding) => binding.issuer === 'chase')!;
    const invite = fake.core.createPairing([chase.bindingId], null);
    const spare = fake.core.redeem(invite.code, 'Spare Chrome')!;
    fake.core.approvePairing(invite.pairingId, spare.deviceId, spare.fingerprint);
    await confirm.getByRole('button', { name: 'Turn automatic sending on' }).click();
    await expect(bindings.getByText('This changed in another window or browser.')).toBeVisible();
    expect(chase.autoSyncConsent.size).toBe(0);
    await auto.getByRole('button', { name: 'Turn automatic sending on…' }).click();
    await expect(page.getByRole('dialog', { name: 'Send Chase Sapphire automatically?' })).toContainText('when the extension in Laptop Chrome, Spare Chrome reads this card');
  });

  test('confirming a card again keeps no browser unless it is ticked; one can be allowed again (Q35)', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    await openArea(page, 'Extension & devices');
    const chase = page.getByRole('region', { name: 'Connected cards' }).locator('li[data-binding="chase"]');
    await chase.getByRole('button', { name: 'Edit cards…' }).click();
    const editor = page.getByRole('dialog', { name: 'Cards of Chase Sapphire' });
    const keep = editor.getByRole('group', { name: 'Browsers that keep sending for this card' });
    await expect(keep).toContainText('A browser keeps sending for the card only if you tick it here');
    await expect(keep.getByRole('checkbox', { name: 'Laptop Chrome' })).not.toBeChecked();
    await editor.getByText('I checked these cards against what the bank shows for this account.').click();
    await editor.getByRole('button', { name: 'Confirm these cards' }).click();
    await expect(editor).toHaveCount(0);
    const laptop = fake.store.devices.find((device) => device.deviceLabel === 'Laptop Chrome')!;
    expect(laptop.staleBindingIds).toEqual([fake.store.bindings[0].bindingId]);

    const row = page.getByRole('region', { name: 'Browsers' }).locator(`li[data-device="${laptop.deviceId}"]`);
    await expect(row.getByTestId('regrant')).toContainText('Not allowed any more for: Chase Sapphire.');
    await areaTab(page, 'Sync & coverage').click();
    await expect(card(page, 'chase').locator('[data-status]')).toHaveText('No working device: allow a browser again');
    await expect(card(page, 'chase')).toContainText('("Allow again…" under Browsers), or pair a new one.');
    await card(page, 'chase').getByRole('button', { name: 'Open Extension & devices' }).click();

    await row.getByRole('button', { name: 'Allow again…' }).click();
    const allow = row.getByRole('group', { name: 'Allow Laptop Chrome to send again for' });
    await expect(allow.getByRole('button', { name: 'Allow' })).toBeDisabled();
    await allow.getByRole('checkbox', { name: 'Chase Sapphire (Chase), version 2' }).check();
    await allow.getByRole('button', { name: 'Allow' }).click();
    await expect(row.getByText('Laptop Chrome may send again for the cards you chose.')).toBeVisible();
    await expect(row.getByTestId('regrant')).toHaveCount(0);
    expect(laptop.staleBindingIds).toEqual([]);
    expect(laptop.bindingIds).toContain(fake.store.bindings[0].bindingId);
    const regrants = fake.requests.filter((request) => request.path.endsWith('/regrant'));
    expect(regrants.map((request) => [request.method, request.status, request.hadCsrfHeader])).toEqual([['POST', 200, true]]);
  });

  test('a refused upload and a run Holdr closed early each say so, with what to do (R4, Q36)', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    const refusedId = fake.startRun('chase', null, 'card-data');
    const closedId = fake.startRun('citi');
    fake.core.revokeDevice(fake.store.runs.find((run) => run.runId === closedId)!.deviceId);
    await openArea(page, 'Sync & coverage');
    await expect(card(page, 'chase').locator('[data-status]')).toHaveText('Refused by Holdr');
    await expect(card(page, 'chase')).toContainText('Holdr received the last upload but kept nothing from it.');
    const runs = page.getByRole('region', { name: 'Recent runs' });
    await expect(runs.locator(`li[data-run="${refusedId}"]`)).toContainText('refused by Holdr; nothing kept');
    await expect(runs.locator(`li[data-run="${refusedId}"]`)).toContainText('part of it looked like card data');
    await expect(runs.locator(`li[data-run="${closedId}"]`)).toContainText('closed; nothing received');
    await runs.locator(`li[data-run="${closedId}"]`).getByRole('button', { name: 'Details' }).click();
    await expect(page.getByRole('dialog', { name: /^Run of / }).getByTestId('run-closed')).toContainText('its 10 minutes passed, or its browser was revoked');
  });

  test('a file import\'s conflicts are reviewed in the same queue, with no browser or binding behind them (X18)', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    const setId = fake.addFileReviewSet();
    fake.core.pause();
    await openArea(page, 'Sync & coverage');
    const row = page.getByRole('region', { name: 'Imports awaiting review' }).locator(`li[data-set="${setId}"]`);
    await expect(row).toHaveAttribute('data-source-kind', 'file');
    await expect(row.locator('strong')).toHaveText(/^File import · /);
    await expect(row).toContainText('From a file import, not the extension');
    await expect(row).toContainText('2 rows that need a decision');
    await row.getByRole('button', { name: 'Review' }).click();
    const dialog = page.getByRole('dialog', { name: /^Review: File import · / });
    await expect(dialog.getByTestId('file-origin')).toContainText('pausing or turning an issuer off doesn\'t hold them');
    await expect(dialog.getByText('Plans can\'t be prepared or confirmed right now.')).toHaveCount(0);
    const removed = dialog.locator('fieldset[data-reason="removed-hit"]');
    await expect(removed).toContainText('Why Holdr asks: This row matches a transaction the bank had removed');
    await expect(removed).toContainText('What the file import had (row 1)');
    await expect(removed).toContainText('File import: no card recorded');
    await expect(removed.getByRole('radio')).toHaveCount(2);
    await removed.getByLabel('It\'s the posted version of this removed charge: restore it as posted').check();
    const conflict = dialog.locator('fieldset[data-reason="identity-conflict"]');
    await expect(conflict).toContainText('already belongs to another transaction in Holdr');
    await expect(conflict.getByLabel(/Keep both/)).toHaveCount(0);
    await conflict.getByRole('radio', { name: /^Same transaction: count it once: BLUE YONDER AIRLINES · / }).check();
    await dialog.getByRole('button', { name: 'Prepare the plan from the current ledger' }).click();
    const plan = dialog.getByRole('region', { name: 'Plan' });
    await expect(plan).toContainText('for rows from a file import (no sent object)');
    await expect(plan.locator('li[data-effect="promote"]')).toHaveCount(1);
    await expect(plan.locator('li[data-effect="promote"]')).toContainText('Restore, now posted');
    await dialog.getByRole('button', { name: 'Confirm and apply the plan' }).click();
    await expect(dialog.getByText('Plan applied.', { exact: true })).toBeVisible();
    expect(fake.store.sets.find((set) => set.observationSetId === setId)!.state).toBe('committed');
    const commit = fake.requests.find((request) => request.path.endsWith('/commit'))!;
    expect(commit.status).toBe(200);
  });

  test('without Holdr\'s sync state the queue lists file imports only, also behind a page of the extension\'s captures (Astra round 5)', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    fake.addCommittedHistory(110);
    const open = fake.addFileReviewSet();
    const older = fake.addFileReviewSet();
    const record = fake.store.sets.find((set) => set.observationSetId === older)!;
    fake.core.discard(older, record.version, 'other');
    // Accepted before 74 of the history's captures: the closed list's first page holds only the extension's captures.
    record.acceptedAt = FAKE_NOW - 11 * DAY - 75 * HOUR;
    // A Holdr without extension sync (`vite` or `local` mode): `/state` says so, the lists still answer, with the captures
    // a time with extension sync left in the database.
    await page.route((url) => url.pathname === '/card-sync/owner/state',
      (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ extensionSync: 'not-configured' }) }));
    await openArea(page, 'Sync & coverage');
    await expect(page.getByText('Not set up: this Holdr doesn\'t support extension sync yet.')).toBeVisible();
    const queue = page.getByRole('region', { name: 'Imports awaiting review' });
    await expect(queue).toContainText('Holdr keeps the rows that need a decision until the date each shows, then clears them.');
    await expect(queue.locator('li[data-set]')).toHaveCount(1);
    await expect(queue.locator(`li[data-set="${open}"]`)).toHaveAttribute('data-source-kind', 'file');
    await queue.getByRole('button', { name: 'Show closed reviews' }).click();
    const closed = queue.getByRole('list', { name: 'Closed reviews' });
    await expect(closed.locator('li[data-set]')).toHaveCount(1);
    await expect(closed.locator(`li[data-set="${older}"]`)).toHaveAttribute('data-source-kind', 'file');
    await expect(queue.locator('li[data-source-kind="extension"]')).toHaveCount(0);
    // Holdr has closed sets after that page: "Show more" reads on to the end of the list and lists no capture.
    await queue.getByRole('button', { name: 'Show more closed reviews' }).click();
    await expect(queue.getByRole('button', { name: 'Show more closed reviews' })).toHaveCount(0);
    await expect(closed.locator('li[data-set]')).toHaveCount(1);
    await expect(queue.locator('li[data-source-kind="extension"]')).toHaveCount(0);
  });

  test('after a restore: confirm the cards again, turn the issuer on, and check the source before planning', async ({ page }) => {
    await serve(page, { scenario: 'restored' });
    await openArea(page, 'Extension & devices');
    await expect(page.getByText(/^Holdr was restored from a backup on/)).toBeVisible();
    const chase = page.getByRole('region', { name: 'Connected cards' }).locator('li[data-binding="chase"]');
    await expect(chase).toContainText('check these cards against the bank page and confirm them again');
    await chase.getByRole('button', { name: 'Confirm cards again…' }).click();
    const editor = page.getByRole('dialog', { name: 'Confirm the cards of Chase Sapphire again' });
    await expect(editor.getByLabel('Last four').first()).toHaveValue('3391');
    await expect(editor.getByLabel('Last four').first()).toHaveAttribute('readonly', '');
    await editor.getByText('I checked these cards against what the bank shows for this account.').click();
    await editor.getByRole('button', { name: 'Confirm these cards' }).click();
    await confirmPassword(page);
    await expect(chase.getByRole('button', { name: 'Edit cards…' })).toBeVisible();

    const switches = page.getByRole('region', { name: 'Sync switches' }).locator('li[data-issuer="chase"]');
    await switches.getByRole('button', { name: 'Turn on…' }).click();
    await switches.getByText(/I understand the extension works inside my signed-in bank session/).click();
    await switches.getByRole('button', { name: 'Turn Chase on' }).click();
    await expect(switches).toContainText('Chase: on');
    // E1b §5.8: the restore also paused syncing; resuming is the owner's step.
    await expect(page.getByText(/^All syncing is paused since/)).toBeVisible();
    await page.getByRole('button', { name: 'Resume syncing' }).click();
    await expect(page.getByText('Syncing resumed.')).toBeVisible();

    await areaTab(page, 'Sync & coverage').click();
    await card(page, 'chase').getByRole('button', { name: 'Review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review: Chase Sapphire (Chase)' });
    await expect(dialog.getByText('This import is from before Holdr was restored.')).toBeVisible();
    const prepare = dialog.getByRole('button', { name: 'Prepare the plan from the current ledger' });
    await expect(prepare).toBeDisabled();
    await dialog.getByText('I checked where this import came from and still want to use it').click();
    await prepare.click();
    await expect(dialog.getByRole('region', { name: 'Plan' })).toBeVisible();
  });

  test('a closed gate and switched-off device uploads say why; pairing and confirming cards are refused', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    fake.setGate('blocked');
    fake.setDeviceApi('disabled');
    await openArea(page, 'Extension & devices');
    await expect(page.getByText('Device authorization is closed.')).toBeVisible();
    await expect(page.getByText('Device uploads are off on this Holdr.')).toBeVisible();
    await page.getByRole('button', { name: 'Pair a browser…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Pair a browser' });
    await dialog.getByLabel('Chase Sapphire (Chase)').check();
    await dialog.getByRole('button', { name: 'Create a pairing code' }).click();
    await expect(dialog.getByText('Device uploads are off on this Holdr.')).toBeVisible();
    await expect(dialog.getByTestId('pairing-code')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

    // Confirming a binding widens what browsers may do (it can keep a browser), so a blocked gate refuses it too (E1b §5.0).
    const chase = fake.store.bindings.find((binding) => binding.issuer === 'chase')!;
    const version = chase.bindingVersion;
    const laptop = fake.store.devices.find((device) => device.deviceLabel === 'Laptop Chrome')!;
    const grants = [...laptop.bindingIds];
    await page.getByRole('region', { name: 'Connected cards' }).locator('li[data-binding="chase"]').getByRole('button', { name: 'Edit cards…' }).click();
    const editor = page.getByRole('dialog', { name: 'Cards of Chase Sapphire' });
    await editor.getByLabel('Laptop Chrome').check();
    await editor.getByText('I checked these cards against what the bank shows for this account.').click();
    await editor.getByRole('button', { name: 'Confirm these cards' }).click();
    await expect(editor.getByRole('alert')).toContainText('Holdr has closed device authorization.');
    expect(chase.bindingVersion).toBe(version);
    expect(laptop.bindingIds).toEqual(grants);
  });

  test('a change made in another window is shown rather than overwritten', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    await openArea(page, 'Extension & devices');
    fake.failNext(/^POST \/card-sync\/owner\/issuers\/citi\/disable$/, { status: 409, body: { error: 'version-conflict', currentVersion: 99 } });
    await page.getByRole('region', { name: 'Sync switches' }).locator('li[data-issuer="citi"]').getByRole('button', { name: 'Turn off' }).click();
    await expect(page.getByText('This changed in another window or browser.')).toBeVisible();
    await expect(page.getByText('The latest state is shown now. Check it and try again.')).toBeVisible();
  });

  test('refuses an answer carrying a token, and never puts one on the page', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo' });
    const state = fake.handle({ method: 'GET', url: '/card-sync/owner/state' }).body as Record<string, unknown>;
    await page.route((url) => url.pathname === '/card-sync/owner/state', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...state, deviceToken: `hdv1_${'a'.repeat(64)}` }),
    }));
    await openArea(page, 'Sync & coverage');
    await expect(page.getByText('Couldn\'t load sync: Holdr\'s answer didn\'t pass this page\'s checks, so nothing from it is shown.')).toBeVisible();
    expect(await page.content()).not.toContain('hdv1_');
    await expect(page.getByRole('region', { name: 'Connected cards' })).toHaveCount(0);
  });

  test('turning an issuer on that watches the bank page needs a second acknowledgement', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    fake.core.disableIssuer('amex');
    await openArea(page, 'Extension & devices');
    const amex = page.getByRole('region', { name: 'Sync switches' }).locator('li[data-issuer="amex"]');
    await expect(amex).toContainText('Watches the bank page\'s own responses (MAIN world).');
    await amex.getByRole('button', { name: 'Turn on…' }).click();
    await amex.getByText(/I understand the extension works inside my signed-in bank session/).click();
    await expect(amex.getByRole('button', { name: 'Turn Amex on' })).toBeDisabled();
    await amex.getByText(/which a hostile page could forge/).click();
    await amex.getByRole('button', { name: 'Turn Amex on' }).click();
    await expect(amex).toContainText('Amex: on');
  });

  /** Opens a charge from Spending's list, then its sources and history in place of its details. */
  async function openSources(page: Page, rowName: string, merchant: string, description: string) {
    await page.getByRole('button', { name: `${rowName}: details` }).click();
    const drawer = page.getByRole('dialog', { name: merchant, exact: true });
    await drawer.getByRole('button', { name: 'Sources and history…' }).click();
    await expect(drawer).toHaveCount(0);
    const dialog = page.getByRole('dialog', { name: `Sources and history: ${description}` });
    await expect(dialog.getByRole('region', { name: 'History' })).toBeVisible();
    return { drawer, dialog, sources: dialog.getByRole('region', { name: 'Where it came from' }).locator('li[data-identity]') };
  }

  test('a source linked to the wrong charge moves to the one it belongs to, never onto another card; a last source stays (X29)', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' }, { ledger: true });
    await openArea(page, 'Card transactions');
    const { drawer, dialog, sources } = await openSources(page, 'Tailspin Toys, $64.99, Oct 2', 'Tailspin Toys', 'TAILSPIN TOYS');
    await expect(dialog).toContainText('Oct 2, 2026 · $64.99 · posted');
    await expect(sources).toHaveCount(3);
    await expect(sources.nth(1)).toContainText('An offline file\'s key for this charge');
    await expect(sources.nth(1)).toContainText('no card recorded');
    const wrong = sources.filter({ hasText: 'A capture of this charge without a lasting id' });
    await expect(wrong).toContainText('from the extension, first seen posted');
    await wrong.getByRole('button', { name: 'Move to another charge…' }).click();
    const panel = dialog.getByRole('region', { name: 'Move a source' });
    await panel.getByLabel('Filter by description').fill('tailspin toys');
    await expect(panel.locator('label[data-target]')).toHaveCount(2);
    await expect(panel.getByRole('button', { name: 'Move…' })).toBeDisabled();
    // The same amount on Casey's card: Holdr refuses, and nothing moves.
    await panel.locator(`label[data-target="${LEDGER_STORY_IDS.tailspinOtherCard}"]`).click();
    await panel.getByRole('button', { name: 'Move…' }).click();
    const confirm = page.getByRole('dialog', { name: 'Move this source to another charge?' });
    await expect(confirm).toContainText('under Oct 8, 2026 · TAILSPIN TOYS · $64.99');
    await confirm.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('That charge is on a different card. A source moves only to a charge on the same card');
    expect(fake.store.ledger.rows.get(LEDGER_STORY_IDS.tailspinOtherCard)!.revision).toBe(1);
    // The one a week later, from the offline file with no card recorded, is where it belongs.
    await panel.locator(`label[data-target="${LEDGER_STORY_IDS.tailspinLater}"]`).click();
    await panel.getByRole('button', { name: 'Move…' }).click();
    await confirm.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText('The source now counts under Oct 9, 2026 · TAILSPIN TOYS · $64.99.');
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(sources).toHaveCount(2);
    const latest = dialog.getByRole('region', { name: 'History' }).locator('li').first();
    await expect(latest).toContainText('A source moved from here to another charge');
    const moved = [...fake.store.ledger.identities.values()].filter((identity) => identity.canonicalId === LEDGER_STORY_IDS.tailspinLater);
    expect(moved.map((identity) => identity.namespaceKind).sort()).toEqual(['capture', 'legacy-file']);
    // The history leads to the charge it went to, and back.
    await latest.getByRole('button', { name: 'Open the other charge' }).click();
    await expect(dialog).toContainText('Oct 9, 2026 · $64.99 · posted');
    await expect(sources).toHaveCount(2);
    const arrivedHere = dialog.getByRole('region', { name: 'History' }).locator('li').first();
    await expect(arrivedHere).toContainText('A source moved here from another charge');
    await arrivedHere.getByRole('button', { name: 'Open the other charge' }).click();
    await expect(dialog).toContainText('Oct 2, 2026 · $64.99 · posted');
    // Closing goes back to the charge's details.
    await dialog.getByRole('button', { name: 'Close sources and history' }).click();
    await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: 'Close details' }).click();

    // Where it arrived, its history says where it came from.
    const later = await openSources(page, 'Tailspin Toys, $64.99, Oct 9', 'Tailspin Toys', 'TAILSPIN TOYS');
    await expect(later.dialog.getByRole('region', { name: 'History' }).locator('li').first()).toContainText('A source moved here from another charge');
    await expect(later.dialog.getByRole('region', { name: 'History' }).locator('li').first()).toContainText('by you, as a repair');
    await later.dialog.getByRole('button', { name: 'Close sources and history' }).click();
    await later.drawer.getByRole('button', { name: 'Close details' }).click();

    // On Casey's card, the only source can be neither detached nor moved.
    const other = await openSources(page, 'Tailspin Toys, $64.99, Oct 8', 'Tailspin Toys', 'TAILSPIN TOYS');
    await expect(other.sources).toHaveCount(1);
    await expect(other.sources.first()).toContainText('Casey');
    await expect(other.dialog.getByRole('button', { name: 'Detach…' })).toBeDisabled();
    await expect(other.dialog.getByRole('button', { name: 'Move to another charge…' })).toBeDisabled();
    await expect(other.dialog).toContainText('A charge keeps at least one source, so its only one can\'t be detached or moved.');
  });

  test('a promotion is undone to exactly what it was, and a merged duplicate separated again; Spending follows (X29)', async ({ page }) => {
    const { fake, baseCalls } = await serve(page, { scenario: 'demo', recentAuth: 'granted' }, { ledger: true });
    const summaries = () => baseCalls.filter((entry) => entry === '/spending/summary').length;
    await openArea(page, 'Card transactions');
    const coho = await openSources(page, 'Coho Vineyard, $46.08, Oct 11', 'Coho Vineyard', 'COHO VINEYARD');
    const undo = coho.dialog.getByRole('region', { name: 'Undo the latest change' });
    await expect(undo).toContainText('Became posted:');
    await expect(undo).toContainText('pending → posted, $38.40 → $46.08');
    await expect(coho.dialog.getByRole('region', { name: 'History' }).locator('li').first()).toContainText('Became posted (can be undone)');
    const before = summaries();
    await undo.getByRole('button', { name: 'Undo this change…' }).click();
    const confirm = page.getByRole('dialog', { name: 'Undo this change?' });
    await expect(confirm).toContainText('exactly how it was before "Became posted" (pending, $38.40). Your category and notes stay.');
    await confirm.getByRole('button', { name: 'Undo the change' }).click();
    await expect(coho.dialog.getByRole('status')).toHaveText('The change was undone.');
    await expect(undo).toHaveCount(0);
    await expect(coho.dialog).toContainText('Oct 11, 2026 · $38.40 · pending');
    await expect(coho.dialog.getByRole('region', { name: 'History' }).locator('li').first()).toContainText('An earlier change was undone');
    await expect(coho.sources).toHaveCount(2);
    await expect.poll(summaries).toBeGreaterThan(before);
    await coho.dialog.getByRole('button', { name: 'Close sources and history' }).click();
    await coho.drawer.getByRole('button', { name: 'Close details' }).click();
    await expect(page.getByRole('button', { name: 'Coho Vineyard, $38.40, Oct 11: details' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Coho Vineyard, $46.08, Oct 11: details' })).toHaveCount(0);

    const fabrikam = await openSources(page, 'Fabrikam Fuel, $52.10, Oct 5', 'Fabrikam Fuel', 'FABRIKAM FUEL 0042');
    await expect(fabrikam.sources).toHaveCount(2);
    const merged = fabrikam.dialog.getByRole('region', { name: 'Merged into this charge' });
    await expect(merged).toContainText('Oct 5, 2026 · $52.10 · merged into another charge as a duplicate');
    // The merged row itself says what happened to it, and leads back.
    await merged.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(fabrikam.dialog).toContainText('This charge was merged into another charge as a duplicate, so it doesn\'t count on its own.');
    await expect(fabrikam.sources).toHaveCount(0);
    await fabrikam.dialog.getByRole('button', { name: 'Open the charge it was merged into' }).click();
    await merged.getByRole('button', { name: 'Separate again…' }).click();
    const separate = page.getByRole('dialog', { name: 'Separate this charge again?' });
    await expect(separate).toContainText('Oct 5, 2026 · $52.10 becomes a charge of its own again, as it was before the merge (posted or pending)');
    // E2a brings it back with the status it had before the merge: a pending one doesn't count, so the dialog never says both count.
    await expect(separate).toContainText('If it was posted, it counts in spending again next to the charge it was merged into; if it was pending, not until it posts.');
    await expect(separate).not.toContainText('Both then count');
    await expect(separate).toContainText('check that these aren\'t the same transaction twice');
    await separate.getByRole('button', { name: 'Separate', exact: true }).click();
    await expect(fabrikam.dialog.getByRole('status')).toHaveText('It is a charge of its own again.');
    await expect(merged).toHaveCount(0);
    await expect(fabrikam.sources).toHaveCount(1);
    expect(fake.store.ledger.rows.get(LEDGER_STORY_IDS.fabrikamDuplicate)!.values.status).toBe('posted');
    await fabrikam.dialog.getByRole('button', { name: 'Close sources and history' }).click();
    await fabrikam.drawer.getByRole('button', { name: 'Close details' }).click();
    await expect(page.getByRole('button', { name: 'Fabrikam Fuel, $52.10, Oct 5: details' })).toHaveCount(2);
  });

  test('a merged charge whose merge can\'t be undone exactly any more is refused with why, and stays merged (E2a link-not-reversible)', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' }, { ledger: true });
    // A note written on the merged row after the merge: the merge is no longer its latest change.
    const ledger = fake.store.ledger;
    recordUserEdit(ledger, ledger.rows.get(LEDGER_STORY_IDS.fabrikamDuplicate)!, ['notes'], fake.now());
    await openArea(page, 'Card transactions');
    const fabrikam = await openSources(page, 'Fabrikam Fuel, $52.10, Oct 5', 'Fabrikam Fuel', 'FABRIKAM FUEL 0042');
    const merged = fabrikam.dialog.getByRole('region', { name: 'Merged into this charge' });
    await merged.getByRole('button', { name: 'Separate again…' }).click();
    await page.getByRole('dialog', { name: 'Separate this charge again?' }).getByRole('button', { name: 'Separate', exact: true }).click();
    await expect(fabrikam.dialog.getByRole('alert')).toContainText('Holdr can\'t separate these charges exactly any more.');
    await expect(fabrikam.dialog.getByRole('alert')).toContainText('Nothing was changed');
    await expect(merged.locator(`li[data-merged="${LEDGER_STORY_IDS.fabrikamDuplicate}"]`)).toHaveCount(1);
    expect(ledger.rows.get(LEDGER_STORY_IDS.fabrikamDuplicate)!.values.status).toBe('removed');
  });

  test('a charge changed meanwhile is shown again before any repair, and a repair whose answer is lost is never called failed (X29)', async ({ page }) => {
    const { fake, deliver, baseCalls } = await serve(page, { scenario: 'demo', recentAuth: 'granted' }, { ledger: true });
    await openArea(page, 'Card transactions');
    const { dialog, sources } = await openSources(page, 'Tailspin Toys, $64.99, Oct 2', 'Tailspin Toys', 'TAILSPIN TOYS');
    await expect(sources).toHaveCount(3);
    // Another window changes its notes: the charge's revision moves on.
    recordUserEdit(fake.store.ledger, fake.store.ledger.rows.get(LEDGER_STORY_IDS.tailspin)!, ['notes'], fake.now());
    const wrong = sources.filter({ hasText: 'A capture of this charge' });
    await wrong.getByRole('button', { name: 'Detach…' }).click();
    const confirm = page.getByRole('dialog', { name: 'Detach this source?' });
    await expect(confirm).toContainText('If the bank sends this source again, Holdr asks you where it belongs');
    await confirm.getByRole('button', { name: 'Detach', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('This charge or its sources changed since you opened it. The latest is shown now.');
    await expect(dialog.getByRole('region', { name: 'History' }).locator('li').first()).toContainText('You changed the notes');
    await expect(wrong).not.toContainText('Detached');

    // Holdr detaches it, then the connection drops before its answer arrives: Holdr and Spending are read again.
    const summaries = () => baseCalls.filter((entry) => entry === '/spending/summary').length;
    const before = summaries();
    await page.route(/\/card-sync\/owner\/identities\/card-ident-[a-p]{32}\/detach$/, async (route) => {
      await deliver(route);
      await route.abort('connectionreset');
    }, { times: 1 });
    await wrong.getByRole('button', { name: 'Detach…' }).click();
    await confirm.getByRole('button', { name: 'Detach', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Holdr didn\'t confirm whether the change was made. The latest is shown now');
    await expect(wrong).toContainText('Detached: no longer counted here. If the bank sends it again, Holdr asks you where it belongs.');
    await expect(wrong.getByRole('button')).toHaveCount(0);
    await expect(dialog.getByText('Something went wrong')).toHaveCount(0);
    await expect.poll(summaries).toBeGreaterThan(before);
  });

  test('when the read after a repair fails too, what is shown counts as out of date: repairs stay off until it is read again (X29)', async ({ page }) => {
    const { fake, deliver } = await serve(page, { scenario: 'demo', recentAuth: 'granted' }, { ledger: true });
    await openArea(page, 'Card transactions');
    const { dialog, sources } = await openSources(page, 'Tailspin Toys, $64.99, Oct 2', 'Tailspin Toys', 'TAILSPIN TOYS');
    await expect(sources).toHaveCount(3);
    // Holdr detaches the source, its answer is lost, and the read after it fails as well.
    await page.route(/\/card-sync\/owner\/identities\/card-ident-[a-p]{32}\/detach$/, async (route) => {
      await deliver(route);
      fake.failNext(/^GET \/card-sync\/owner\/transactions\/card-txn-[a-p]{32}\/sources$/, { status: 503, body: { error: 'unavailable' } });
      await route.abort('connectionreset');
    }, { times: 1 });
    const wrong = sources.filter({ hasText: 'A capture of this charge' });
    await wrong.getByRole('button', { name: 'Detach…' }).click();
    await page.getByRole('dialog', { name: 'Detach this source?' }).getByRole('button', { name: 'Detach', exact: true }).click();
    const outcome = dialog.getByRole('alert').filter({ hasText: 'Holdr didn\'t confirm whether the change was made.' });
    await expect(outcome).toContainText('What\'s shown may be out of date, so repairs stay off until the latest is read from Holdr.');
    await expect(dialog.getByRole('button', { name: 'Try again' })).toBeEnabled();
    await expect(dialog).not.toContainText('The latest is shown now');
    // The answer from before the repair is still there, and nothing can act on it.
    await expect(wrong).not.toContainText('Detached');
    const repairs = dialog.getByRole('button', { name: /^(Detach…|Move to another charge…)$/ });
    await expect(repairs).toHaveCount(6);
    for (const button of await repairs.all()) await expect(button).toBeDisabled();
    // Read again: the source was detached, and the others can be repaired again.
    await dialog.getByRole('button', { name: 'Try again' }).click();
    await expect(wrong).toContainText('Detached: no longer counted here.');
    await expect(outcome).toContainText('The latest is shown now: check it before trying again.');
    await expect(sources.first().getByRole('button', { name: 'Detach…' })).toBeEnabled();
  });

  test('a source is offered for detaching or moving only when another one known to count stays, past the first page too (X29)', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' }, { ledger: true });
    const ledger = fake.store.ledger;
    const row = ledger.rows.get(LEDGER_STORY_IDS.tailspinOtherCard)!;
    const only = [...ledger.identities.values()].find((identity) => identity.canonicalId === row.transactionId)!;
    // 500 later sources that were detached, then one more that counts: the first page of 500 holds one that counts.
    for (let index = 0; index < 501; index += 1) {
      const extra = addIdentity(ledger, {
        identityId: identityIdFor(`extra/${index}`), createdBy: 'extension', namespaceKind: 'capture', sourceScopeId: only.sourceScopeId,
        scopeKind: only.scopeKind, firstSeenStatus: 'posted',
      }, row, only.createdAt + (index + 1) * MINUTE);
      if (index < 500) extra.status = 'detached';
    }
    await openArea(page, 'Card transactions');
    const { dialog, sources } = await openSources(page, 'Tailspin Toys, $64.99, Oct 8', 'Tailspin Toys', 'TAILSPIN TOYS');
    await expect(sources).toHaveCount(500);
    await expect(sources.first().getByRole('button', { name: 'Detach…' })).toBeDisabled();
    await expect(sources.first().getByRole('button', { name: 'Move to another charge…' })).toBeDisabled();
    await expect(dialog).toContainText('Only one source read so far still counts here, and a charge keeps at least one: show more sources');
    await dialog.getByRole('button', { name: 'Show more sources' }).click();
    await expect(sources).toHaveCount(502);
    await expect(sources.first().getByRole('button', { name: 'Detach…' })).toBeEnabled();
    await expect(sources.last().getByRole('button', { name: 'Move to another charge…' })).toBeEnabled();
    await expect(dialog).not.toContainText('Only one source read so far');
  });

  test('a merged charge that a later page serves again (merged again meanwhile) is shown once, as it is now (E1b revision 8, X39)', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' }, { ledger: true });
    const ledger = fake.store.ledger;
    const survivor = ledger.rows.get(LEDGER_STORY_IDS.fabrikam)!;
    const byOwner = { via: 'extension' as const, actor: 'owner' as const, deviceId: null };
    // 100 earlier duplicates merged into it, before the one the story has: the first page of 100 holds exactly these.
    const merges = Array.from({ length: 100 }, (_, index) => {
      const at = FAKE_NOW - 40 * 24 * HOUR + index * MINUTE;
      const duplicate = createRow(ledger, {
        transactionId: cardTransactionIdFor(`merged/${index}`), cardAccountRef: survivor.cardAccountRef,
        values: { ...survivor.values, description: `FABRIKAM FUEL COPY ${index}` }, at, source: { ...byOwner, reason: 'insert' }, identity: null,
      });
      return { duplicate, merge: mergeRow(ledger, duplicate, survivor, 'superseded', at, byOwner) };
    });
    await openArea(page, 'Card transactions');
    const { dialog } = await openSources(page, 'Fabrikam Fuel, $52.10, Oct 5', 'Fabrikam Fuel', 'FABRIKAM FUEL 0042');
    const merged = dialog.getByRole('region', { name: 'Merged into this charge' });
    await expect(merged.locator('li[data-merged]')).toHaveCount(100);
    const first = merges[0].duplicate.transactionId;
    await expect(merged.locator(`li[data-merged="${first}"]`)).toContainText('merged into another charge as a duplicate');
    // Meanwhile it was separated and merged again, as settled into this charge: a new key puts it on the next page too.
    unmergeRow(ledger, merges[0].duplicate, merges[0].merge, fake.now(), { via: 'session', actor: 'owner', deviceId: null, reason: 'maintenance' });
    mergeRow(ledger, merges[0].duplicate, survivor, 'settled-into', fake.now() + MINUTE, byOwner);
    await merged.getByRole('button', { name: 'Show more merged charges' }).click();
    // Shown once, as the later page has it, and the story's own duplicate after the first 100.
    await expect(merged.locator('li[data-merged]')).toHaveCount(101);
    await expect(merged.locator(`li[data-merged="${first}"]`)).toHaveCount(1);
    await expect(merged.locator(`li[data-merged="${first}"]`)).toContainText('merged into the charge it settled into');
    await expect(merged.locator(`li[data-merged="${LEDGER_STORY_IDS.fabrikamDuplicate}"]`)).toHaveCount(1);
  });

  test('a charge chosen for a source that changed since the list was read is refused before anything is sent (X29)', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' }, { ledger: true });
    await openArea(page, 'Card transactions');
    const { dialog, sources } = await openSources(page, 'Tailspin Toys, $64.99, Oct 2', 'Tailspin Toys', 'TAILSPIN TOYS');
    await sources.filter({ hasText: 'A capture of this charge' }).getByRole('button', { name: 'Move to another charge…' }).click();
    const panel = dialog.getByRole('region', { name: 'Move a source' });
    const target = panel.locator(`label[data-target="${LEDGER_STORY_IDS.tailspinLater}"]`);
    const later = fake.store.ledger.rows.get(LEDGER_STORY_IDS.tailspinLater)!;
    const correct = (values: Partial<typeof later.values>) => changeValues(fake.store.ledger, later, { ...later.values, ...values }, fake.now(), {
      eventType: 'corrected', source: { via: 'extension', actor: 'owner', deviceId: null, reason: 'posted-correction' }, reversible: false,
    });
    const tryMove = async () => {
      await target.click();
      await panel.getByRole('button', { name: 'Move…' }).click();
      await page.getByRole('dialog', { name: 'Move this source to another charge?' }).getByRole('button', { name: 'Move', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText('That charge changed since the list was read. Nothing was moved.');
      await expect(target.getByRole('radio')).not.toBeChecked();
    };
    // Meanwhile Holdr takes the bank's corrected amount for that charge.
    await target.click();
    correct({ amountMinor: 6_999 });
    await tryMove();
    await expect(target).toContainText('$69.99');
    // Or only its description, with the amount and status as they were: the confirmation named the old one, so again.
    await target.click();
    correct({ description: 'TAILSPIN TOYS ONLINE' });
    await tryMove();
    await expect(target).toContainText('TAILSPIN TOYS ONLINE');
    expect(fake.requests.filter((request) => request.path.endsWith('/repoint'))).toEqual([]);
    const onTailspin = [...fake.store.ledger.identities.values()].filter((identity) => identity.canonicalId === LEDGER_STORY_IDS.tailspin);
    expect(onTailspin.map((identity) => identity.status)).toEqual(['active', 'active', 'active']);
  });

  test('the move list reaches every charge of the month, past the first hundred (X29)', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' }, { ledger: true });
    await openArea(page, 'Card transactions');
    const { dialog, sources } = await openSources(page, 'Tailspin Toys, $64.99, Oct 2', 'Tailspin Toys', 'TAILSPIN TOYS');
    const ledger = fake.store.ledger;
    const tailspin = ledger.rows.get(LEDGER_STORY_IDS.tailspin)!;
    // Meanwhile 120 newer posted charges of the same card account arrive, ahead of the right one in Spending's list (newest first).
    for (let index = 0; index < 120; index += 1) {
      const day = `2026-10-${String(10 + (index % 6)).padStart(2, '0')}`;
      createRow(ledger, {
        transactionId: cardTransactionIdFor(`filler/${index}`), cardAccountRef: tailspin.cardAccountRef,
        values: { ...tailspin.values, transactionDate: day, postedDate: day, status: 'posted',
          amountMinor: 1_000 + index, description: `NORTHWIND FILLER ${index}`, merchant: 'Northwind Filler' },
        at: fake.now(), source: { via: 'file', actor: 'file-import', deviceId: null, reason: 'insert' }, identity: null,
      });
    }
    await sources.filter({ hasText: 'A capture of this charge' }).getByRole('button', { name: 'Move to another charge…' }).click();
    const panel = dialog.getByRole('region', { name: 'Move a source' });
    await expect(panel.locator('label[data-target]').first()).toBeVisible();
    const target = panel.locator(`label[data-target="${LEDGER_STORY_IDS.tailspinLater}"]`);
    await panel.getByLabel('Filter by description').fill('tailspin toys');
    await expect(panel).toContainText('No charge matches the filter among those read so far.');
    await panel.getByRole('button', { name: 'Show more charges' }).click();
    await expect(target).toBeVisible();
    await target.click();
    await panel.getByRole('button', { name: 'Move…' }).click();
    await page.getByRole('dialog', { name: 'Move this source to another charge?' }).getByRole('button', { name: 'Move', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText('The source now counts under Oct 9, 2026 · TAILSPIN TOYS · $64.99.');
  });

  test('a removed charge can still give up a source that belongs to another one (X29)', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' }, { ledger: true });
    await openArea(page, 'Card transactions');
    const { dialog, sources } = await openSources(page, 'Tailspin Toys, $64.99, Oct 2', 'Tailspin Toys', 'TAILSPIN TOYS');
    // Meanwhile it is removed as imported by mistake; the next repair finds out, and the latest is shown.
    removeRow(fake.store.ledger, fake.store.ledger.rows.get(LEDGER_STORY_IDS.tailspin)!, 'mistaken-import', fake.now(), {
      via: 'session', actor: 'owner', deviceId: null, reason: 'mistaken-import',
    });
    const wrong = sources.filter({ hasText: 'A capture of this charge' });
    await wrong.getByRole('button', { name: 'Detach…' }).click();
    await page.getByRole('dialog', { name: 'Detach this source?' }).getByRole('button', { name: 'Detach', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('This charge or its sources changed since you opened it.');
    await expect(dialog).toContainText('Removed: removed as imported by mistake. It doesn\'t count in spending.');
    await wrong.getByRole('button', { name: 'Move to another charge…' }).click();
    const panel = dialog.getByRole('region', { name: 'Move a source' });
    await panel.locator(`label[data-target="${LEDGER_STORY_IDS.tailspinLater}"]`).click();
    await panel.getByRole('button', { name: 'Move…' }).click();
    await page.getByRole('dialog', { name: 'Move this source to another charge?' }).getByRole('button', { name: 'Move', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText('The source now counts under Oct 9, 2026 · TAILSPIN TOYS · $64.99.');
    const captures = [...fake.store.ledger.identities.values()].filter((identity) => identity.namespaceKind === 'capture' && identity.canonicalId === LEDGER_STORY_IDS.tailspinLater);
    expect(captures.map((identity) => identity.status)).toEqual(['active']);
  });

  test('while a repair or the read after it is on its way, nothing can act on an older answer (X29)', async ({ page }) => {
    const { fake, deliver } = await serve(page, { scenario: 'demo', recentAuth: 'granted' }, { ledger: true });
    const ledger = fake.store.ledger;
    const row = ledger.rows.get(LEDGER_STORY_IDS.tailspin)!;
    for (let index = 0; index < 120; index += 1) recordUserEdit(ledger, row, ['notes'], fake.now());
    await openArea(page, 'Card transactions');
    const { dialog, sources } = await openSources(page, 'Tailspin Toys, $64.99, Oct 2', 'Tailspin Toys', 'TAILSPIN TOYS');
    const older = dialog.getByRole('button', { name: 'Show older changes' });
    await expect(older).toBeEnabled();
    const hold = () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      return { held, release: () => release() };
    };
    // The detach is held on its way to Holdr: older history can't be asked for meanwhile, nor another repair started.
    const write = hold();
    await page.route(/\/card-sync\/owner\/identities\/card-ident-[a-p]{32}\/detach$/, async (route) => {
      await write.held;
      const response = await deliver(route);
      await route.fulfill({ status: response.status, contentType: 'application/json', body: JSON.stringify(response.body) });
    }, { times: 1 });
    await sources.filter({ hasText: 'A capture of this charge' }).getByRole('button', { name: 'Detach…' }).click();
    await page.getByRole('dialog', { name: 'Detach this source?' }).getByRole('button', { name: 'Detach', exact: true }).click();
    await expect(older).toBeDisabled();
    await expect(sources.first().getByRole('button', { name: 'Detach…' })).toBeDisabled();
    write.release();
    await expect(dialog.getByRole('status')).toHaveText('The source was detached.');
    await expect(older).toBeEnabled();

    // A refused repair: the controls come back only once the latest is on screen.
    recordUserEdit(ledger, row, ['category'], fake.now());
    const reread = hold();
    await page.route(/\/card-sync\/owner\/transactions\/card-txn-[a-p]{32}\/sources$/, async (route) => {
      await reread.held;
      const response = await deliver(route);
      await route.fulfill({ status: response.status, contentType: 'application/json', body: JSON.stringify(response.body) });
    }, { times: 1 });
    await sources.first().getByRole('button', { name: 'Detach…' }).click();
    await page.getByRole('dialog', { name: 'Detach this source?' }).getByRole('button', { name: 'Detach', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('This charge or its sources changed since you opened it.');
    await expect(sources.first().getByRole('button', { name: 'Detach…' })).toBeDisabled();
    await expect(older).toBeDisabled();
    reread.release();
    await expect(sources.first().getByRole('button', { name: 'Detach…' })).toBeEnabled();
    await expect(dialog.getByRole('region', { name: 'History' }).locator('li').first()).toContainText('You changed the category');
  });

  test('every repair asks for the password when Holdr wants it, and runs once it is confirmed (X29)', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo' }, { ledger: true });
    await openArea(page, 'Card transactions');
    const { dialog, sources } = await openSources(page, 'Tailspin Toys, $64.99, Oct 2', 'Tailspin Toys', 'TAILSPIN TOYS');
    await sources.filter({ hasText: 'A capture of this charge' }).getByRole('button', { name: 'Detach…' }).click();
    await page.getByRole('dialog', { name: 'Detach this source?' }).getByRole('button', { name: 'Detach', exact: true }).click();
    await confirmPassword(page);
    await expect(dialog.getByRole('status')).toHaveText('The source was detached.');
    const detached = fake.store.ledger.events.filter((event) => event.eventType === 'identity-detached');
    expect(detached.map((event) => [event.transactionId, event.reason])).toEqual([[LEDGER_STORY_IDS.tailspin, 'maintenance']]);
  });

  test('without the owner API, a charge\'s details offer no sources and history', async ({ page }) => {
    await serve(page, null, { ledger: true });
    await openArea(page, 'Sync & coverage');
    await expect(page.getByText('Not set up: this Holdr doesn\'t support extension sync yet.')).toBeVisible();
    await areaTab(page, 'Card transactions').click();
    await page.getByRole('button', { name: 'Tailspin Toys, $64.99, Oct 2: details' }).click();
    const drawer = page.getByRole('dialog', { name: 'Tailspin Toys' });
    await expect(drawer.getByRole('button', { name: 'All from this merchant' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Sources and history…' })).toHaveCount(0);
  });

  test('the 30-second refresh pauses while another mode or another browser tab hides the Spending tab, and catches up once it shows again', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo' });
    await page.clock.install({ time: new Date(FAKE_NOW) });
    await page.goto('/');
    await page.getByRole('tab', { name: 'Spending', exact: true }).click();
    await areaTab(page, 'Sync & coverage').click();
    await expect(card(page, 'chase').locator('[data-status]')).toBeVisible();
    const panel = page.locator('section.spending');
    const reads = () => fake.requests.filter((request) => request.method === 'GET' && request.path === '/card-sync/owner/state').length;
    const start = reads();
    await page.clock.runFor(31_000);
    await expect.poll(reads).toBe(start + 1);
    // Another UI mode keeps the tab mounted under `display: none` (PR #15's `.app[data-mode='investing'] > .spending`): no
    // refresh at all while it is hidden.
    const setHidden = (hidden: boolean) => page.evaluate((value) => {
      (document.querySelector('section.spending') as HTMLElement).style.display = value ? 'none' : '';
    }, hidden);
    await setHidden(true);
    await expect(panel).toHaveAttribute('data-on-screen', 'false');
    const hidden = reads();
    await page.clock.runFor(95_000);
    expect(reads()).toBe(hidden);
    // Shown again: the state, now 95 seconds old, is read at once, then every 30 seconds as before.
    await setHidden(false);
    await expect(panel).toHaveAttribute('data-on-screen', 'true');
    await expect.poll(reads).toBe(hidden + 1);
    await page.clock.runFor(31_000);
    await expect.poll(reads).toBe(hidden + 2);
    // The browser tab behind another one: no refresh either; in front again with an old state, it is read at once.
    const setTabHidden = (tabHidden: boolean) => page.evaluate((value) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (value ? 'hidden' : 'visible') });
      document.dispatchEvent(new Event('visibilitychange'));
    }, tabHidden);
    await setTabHidden(true);
    const behind = reads();
    await page.clock.runFor(95_000);
    expect(reads()).toBe(behind);
    await setTabHidden(false);
    await expect.poll(reads).toBe(behind + 1);
  });
});

test.describe('Spending sync controls: long queues, lost answers and the keyboard (desktop)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });
  const commitRoute = /\/card-sync\/owner\/plans\/[a-z]{3}_[a-p]{32}\/commit$/;
  /** A little more than the Spending tab's five seconds between checks of an unsettled commit. */
  const CHECK_PAUSE_MS = 6_500;

  test('pages past the first screen of closed reviews and runs, and moves a committed match to the other transaction', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    // E2a's lists come in pages of 50, newest accepted first: 110 older captures make three pages of each list.
    const history = fake.addCommittedHistory(110);
    const oldest = history[history.length - 1];
    await openArea(page, 'Sync & coverage');
    const runs = page.getByRole('region', { name: 'Recent runs' });
    await expect(runs.locator('li[data-run]')).toHaveCount(50);
    await runs.getByRole('button', { name: 'Show more runs' }).click();
    await expect(runs.locator('li[data-run]')).toHaveCount(100);

    const queue = page.getByRole('region', { name: 'Imports awaiting review' });
    await queue.getByRole('button', { name: 'Show closed reviews' }).click();
    const closed = queue.getByRole('list', { name: 'Closed reviews' });
    await expect(closed.locator('li[data-set]')).toHaveCount(50);
    await expect(closed.locator(`li[data-set="${oldest}"]`)).toHaveCount(0);
    await queue.getByRole('button', { name: 'Show more closed reviews' }).click();
    await expect(closed.locator('li[data-set]')).toHaveCount(100);
    await queue.getByRole('button', { name: 'Show more closed reviews' }).click();
    await expect(closed.locator('li[data-set]')).toHaveCount(113);
    await expect(queue.getByRole('button', { name: 'Show more closed reviews' })).toHaveCount(0);
    // A refresh reads as far as the owner had paged, so nothing already shown disappears.
    await page.getByRole('region', { name: 'Sync controls' }).getByRole('button', { name: 'Refresh' }).click();
    await expect(closed.locator('li[data-set]')).toHaveCount(113);
    await expect(runs.locator('li[data-run]')).toHaveCount(100);

    await closed.locator(`li[data-set="${oldest}"]`).getByRole('button', { name: 'Open' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review: Chase Sapphire (Chase)' });
    const item = dialog.locator('fieldset[data-category="cross-source-similar"]');
    await expect(item).toContainText('In spending now: Same transaction: count it once');
    await expect(dialog.getByRole('button', { name: 'Prepare the plan from the current ledger' })).toBeDisabled();
    const matches = item.getByRole('radio', { name: /^Same transaction: count it once: SAMPLE MARKET/ });
    await expect(matches).toHaveCount(2);
    await matches.nth(1).check();
    await dialog.getByRole('button', { name: 'Prepare the plan from the current ledger' }).click();
    const plan = dialog.getByRole('region', { name: 'Plan' });
    await expect(plan.locator('li[data-effect]')).toHaveCount(2);
    await expect(plan.locator('li[data-effect="unmatch"]')).toHaveCount(1);
    await expect(plan.locator('li[data-effect="match"]')).toHaveCount(1);
    await dialog.getByRole('button', { name: 'Confirm and apply the changes' }).click();
    await expect(dialog.getByText('Changes applied.', { exact: true })).toBeVisible();
    const set = fake.store.sets.find((entry) => entry.observationSetId === oldest)!;
    expect(set.items[0].committed!.transactionId).toBe(set.items[0].candidates[1].transactionId);
    expect(set.payload).not.toBeNull();
  });

  test('a "show more" whose cursor Holdr no longer takes reads the list again from its first page, one page further, with no error', async ({ page }) => {
    const { fake, deliver } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    fake.addCommittedHistory(110);
    await openArea(page, 'Sync & coverage');
    const runs = page.getByRole('region', { name: 'Recent runs' });
    await expect(runs.locator('li[data-run]')).toHaveCount(50);
    // Holdr refuses the cursor it gave, once (the list changed under it, or Holdr restarted): 422 `invalid-format` on `$.cursor`.
    let refusals = 0;
    await page.route((url) => url.pathname === '/card-sync/owner/runs', async (route) => {
      if (new URL(route.request().url()).searchParams.has('cursor') && refusals === 0) {
        refusals += 1;
        return route.fulfill({
          status: 422, contentType: 'application/json',
          body: JSON.stringify({ error: 'invalid-request', issues: [{ code: 'invalid-format', path: '$.cursor' }] }),
        });
      }
      const response = await deliver(route);
      return route.fulfill({ status: response.status, contentType: 'application/json', body: JSON.stringify(response.body) });
    });
    await runs.getByRole('button', { name: 'Show more runs' }).click();
    await expect(runs.locator('li[data-run]')).toHaveCount(100);
    expect(refusals).toBe(1);
    await expect(page.getByText('Couldn\'t load the review queue or the runs.')).toHaveCount(0);
    await expect(runs.getByRole('button', { name: 'Show more runs' })).toBeEnabled();
  });

  test('decides a 250-row capture in batches of 100 and keeps the choices a failed batch didn\'t save', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    const setId = fake.addLargeOpenSet(250);
    await openArea(page, 'Sync & coverage');
    await page.getByRole('region', { name: 'Imports awaiting review' }).locator(`li[data-set="${setId}"]`).getByRole('button', { name: 'Review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review: Chase Sapphire (Chase)' });
    const noId = dialog.getByRole('region', { name: 'No stable id' });
    await noId.getByLabel('Same decision for the 250 undecided items here').selectOption({ label: 'It\'s a new transaction: add it' });
    await noId.getByRole('button', { name: 'Apply' }).click();
    await expect(dialog.getByTestId('unsaved')).toHaveText('250 choices not saved yet.');

    fake.failNext(/^POST \/card-sync\/owner\/observation-sets\/[a-z]{3}_[a-p]{32}\/decisions$/, { status: 503, body: { error: 'unavailable' } }, 1, 1);
    await dialog.getByRole('button', { name: 'Save decisions' }).click();
    await expect(dialog.getByText('Holdr is busy.')).toBeVisible();
    await expect(dialog.getByTestId('unsaved')).toHaveText('150 choices not saved yet.');
    await expect(noId.getByRole('radio', { name: 'It\'s a new transaction: add it', checked: true })).toHaveCount(250);

    await dialog.getByRole('button', { name: 'Prepare the plan from the current ledger' }).click();
    await expect(dialog.getByRole('region', { name: 'Plan' }).locator('.sync-counts')).toContainText('250 Added');
    await expect(dialog.getByTestId('unsaved')).toHaveCount(0);
    const batches = fake.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/decisions'));
    expect(batches.map((request) => request.status)).toEqual([200, 503, 200, 200]);
  });

  test('a large set whose pages take longer than a state refresh still shows: a background read waits for the one on its way', async ({ page }) => {
    test.setTimeout(150_000);
    const { fake, deliver } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    const setId = fake.addLargeOpenSet(1_600);
    const setPath = `/card-sync/owner/observation-sets/${setId}`;
    let inFlight = 0;
    let mostAtOnce = 0;
    // 16 pages of 100 items, 2 seconds each: one whole read outlasts the 30 seconds between refreshes of Holdr's state.
    await page.route((url) => url.pathname === setPath, async (route) => {
      inFlight += 1;
      mostAtOnce = Math.max(mostAtOnce, inFlight);
      const answer = await deliver(route);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      inFlight -= 1;
      await route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body) });
    });
    await openArea(page, 'Sync & coverage');
    await page.getByRole('region', { name: 'Imports awaiting review' }).locator(`li[data-set="${setId}"]`).getByRole('button', { name: 'Review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review: Chase Sapphire (Chase)' });
    await expect(dialog.getByRole('heading', { name: 'No stable id (1600)' })).toBeVisible({ timeout: 90_000 });
    await expect(dialog.getByText('Loading…')).toHaveCount(0);
    expect(mostAtOnce).toBe(1);
  });

  test('cancelling a revoke by button, Escape or the backdrop revokes nothing and says nothing was revoked', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo' });
    await openArea(page, 'Extension & devices');
    const mac = page.getByRole('region', { name: 'Browsers' }).locator('li', { hasText: 'Mac Chrome: active' });
    for (const dismiss of ['button', 'escape', 'backdrop'] as const) {
      await mac.getByRole('button', { name: 'Revoke…' }).click();
      const confirm = page.getByRole('dialog', { name: 'Revoke Mac Chrome?' });
      await expect(confirm).toBeVisible();
      if (dismiss === 'button') await confirm.getByRole('button', { name: 'Cancel' }).click();
      else if (dismiss === 'escape') await page.keyboard.press('Escape');
      else await page.mouse.click(8, 450);
      await expect(confirm).toHaveCount(0);
      await expect(page.getByText('Mac Chrome is revoked.')).toHaveCount(0);
    }
    expect(fake.requests.filter((request) => request.path.endsWith('/revoke'))).toEqual([]);
    expect(fake.store.devices.find((device) => device.deviceLabel === 'Mac Chrome')!.status).toBe('active');
  });

  test('a commit reads Spending\'s figures and lists again, without a page reload', async ({ page }) => {
    const { baseCalls } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    await openArea(page, 'Sync & coverage');
    await card(page, 'chase').getByRole('button', { name: 'Review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review: Chase Sapphire (Chase)' });
    await dialog.getByRole('button', { name: 'Prepare the plan from the current ledger' }).click();
    const count = (path: string) => baseCalls.filter((entry) => entry === path).length;
    const before = { summary: count('/spending/summary'), list: count('/card-transactions'), coverage: count('/spending/coverage') };
    await dialog.getByRole('button', { name: 'Confirm and apply the plan' }).click();
    await expect(dialog.getByText('Plan applied.', { exact: true })).toBeVisible();
    await expect.poll(() => count('/spending/summary')).toBeGreaterThan(before.summary);
    await expect.poll(() => count('/card-transactions')).toBeGreaterThan(before.list);
    await expect.poll(() => count('/spending/coverage')).toBeGreaterThan(before.coverage);
  });

  test('a commit whose answer is lost is never called failed: Holdr\'s own record settles it', async ({ page }) => {
    const { fake, deliver } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    await openArea(page, 'Sync & coverage');
    await card(page, 'chase').getByRole('button', { name: 'Review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review: Chase Sapphire (Chase)' });
    await dialog.getByRole('button', { name: 'Prepare the plan from the current ledger' }).click();
    // Holdr applies the plan, then the connection drops before its answer arrives.
    await page.route(commitRoute, async (route) => {
      await deliver(route);
      await route.abort('connectionreset');
    }, { times: 1 });
    await dialog.getByRole('button', { name: 'Confirm and apply the plan' }).click();
    await expect(dialog.getByTestId('commit-settled')).toContainText('Holdr applied this plan; only its answer was lost on the way.');
    await expect(dialog.getByText(/Nothing was changed/)).toHaveCount(0);
    expect(fake.store.sets[0].state).toBe('committed');
    await expect(dialog.getByRole('button', { name: 'Confirm and apply the plan' })).toHaveCount(0);
  });

  test('a commit lost before Holdr saw it stays "unknown" until checking again, which is safe', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    await openArea(page, 'Sync & coverage');
    await card(page, 'chase').getByRole('button', { name: 'Review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review: Chase Sapphire (Chase)' });
    await dialog.getByRole('button', { name: 'Prepare the plan from the current ledger' }).click();
    const previewId = fake.store.sets[0].plans.at(-1)!.previewId;
    await page.route(commitRoute, (route) => route.abort('connectionreset'), { times: 1 });
    await dialog.getByRole('button', { name: 'Confirm and apply the plan' }).click();
    const unknown = dialog.getByTestId('commit-unknown');
    await expect(unknown).toContainText('Holdr didn\'t confirm whether this plan was applied.');
    await expect(dialog.getByText(/Nothing was changed/)).toHaveCount(0);
    expect(fake.store.sets[0].state).toBe('accepted-uncommitted');
    await unknown.getByRole('button', { name: 'Check again' }).click();
    await expect(dialog.getByText('Plan applied.', { exact: true })).toBeVisible();
    const commits = fake.requests.filter((request) => request.path.endsWith('/commit'));
    expect(commits.map((request) => [request.path.includes(previewId), request.status])).toEqual([[true, 200]]);
  });

  test('a commit Holdr finishes after its answer was lost still refreshes Spending, with the review closed', async ({ page }) => {
    const { fake, baseCalls } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    await openArea(page, 'Sync & coverage');
    await card(page, 'chase').getByRole('button', { name: 'Review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review: Chase Sapphire (Chase)' });
    await dialog.getByRole('button', { name: 'Prepare the plan from the current ledger' }).click();
    const plan = fake.store.sets[0].plans.at(-1)!;
    const summaries = () => baseCalls.filter((entry) => entry === '/spending/summary').length;
    const before = summaries();
    // The connection drops before Holdr answers; Holdr will only finish the commit later.
    await page.route(commitRoute, (route) => route.abort('connectionreset'), { times: 1 });
    await dialog.getByRole('button', { name: 'Confirm and apply the plan' }).click();
    await expect(dialog.getByTestId('commit-unknown')).toBeVisible();
    // The month is read once more right away (the outcome is unknown).
    await expect.poll(summaries).toBe(before + 1);
    await dialog.getByRole('button', { name: 'Close review' }).click();
    await expect(dialog).toHaveCount(0);

    fake.core.commitPlan(plan.previewId, plan.payloadDigest, plan.planDigest);
    await page.getByRole('region', { name: 'Sync controls' }).getByRole('button', { name: 'Refresh' }).click();
    await expect(card(page, 'chase').locator('[data-status]')).toHaveText('Plan applied');
    // Settled with the review closed: the month is read once more.
    await expect.poll(summaries).toBe(before + 2);
  });

  test('a late commit settles even when each check of it takes longer than the five seconds between checks', async ({ page }) => {
    test.setTimeout(90_000);
    const { fake, baseCalls, deliver } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    await openArea(page, 'Sync & coverage');
    await card(page, 'chase').getByRole('button', { name: 'Review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review: Chase Sapphire (Chase)' });
    await dialog.getByRole('button', { name: 'Prepare the plan from the current ledger' }).click();
    const plan = fake.store.sets[0].plans.at(-1)!;
    const summaries = () => baseCalls.filter((entry) => entry === '/spending/summary').length;
    const before = summaries();
    await page.route(commitRoute, (route) => route.abort('connectionreset'), { times: 1 });
    await dialog.getByRole('button', { name: 'Confirm and apply the plan' }).click();
    await expect(dialog.getByTestId('commit-unknown')).toBeVisible();
    await expect.poll(summaries).toBe(before + 1);
    await dialog.getByRole('button', { name: 'Close review' }).click();

    // From now on every read of that set answers 6 seconds late, longer than the time between checks.
    const setPath = `/card-sync/owner/observation-sets/${fake.store.sets[0].observationSetId}`;
    let reads = 0;
    await page.route((url) => url.pathname === setPath, async (route) => {
      reads += 1;
      const answer = await deliver(route);
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      await route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body) });
    });
    fake.core.commitPlan(plan.previewId, plan.payloadDigest, plan.planDigest);
    await expect.poll(summaries, { timeout: 45_000 }).toBe(before + 2);
    // Settled: the set is no longer read, and Spending is read only that once more.
    const settledReads = reads;
    await page.waitForTimeout(CHECK_PAUSE_MS);
    expect(reads).toBe(settledReads);
    expect(summaries()).toBe(before + 2);
  });

  test('a read already on its way when decisions are saved never undoes them on screen', async ({ page }) => {
    const { deliver } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    // Fake timers that still run on their own, so the 30-second poll can be brought forward.
    await page.clock.install({ time: new Date(FAKE_NOW) });
    await page.goto('/');
    await page.getByRole('tab', { name: 'Spending', exact: true }).click();
    await areaTab(page, 'Sync & coverage').click();
    await card(page, 'amex').getByRole('button', { name: 'Review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review: Amex Gold (Amex)' });
    const noId = dialog.getByRole('region', { name: 'No stable id' });
    await noId.getByLabel('Same decision for the 2 undecided items here').selectOption({ label: 'It\'s a new transaction: add it' });
    await noId.getByRole('button', { name: 'Apply' }).click();

    // The poll's read of this set answers with what Holdr had before the save, and arrives after it.
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    const setRead = /\/card-sync\/owner\/observation-sets\/[a-z]{3}_[a-p]{32}$/;
    await page.route(setRead, async (route) => {
      started = true;
      const before = await deliver(route);
      await held;
      await route.fulfill({ status: before.status, contentType: 'application/json', body: JSON.stringify(before.body) });
    }, { times: 1 });
    await page.clock.fastForward(31_000);
    await expect.poll(() => started).toBe(true);
    await dialog.getByRole('button', { name: 'Save decisions' }).click();
    await expect(dialog.getByText(/^Decisions saved\./)).toBeVisible();
    const landed = page.waitForEvent('requestfinished', (request) => setRead.test(request.url()));
    release();
    await landed;
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
    await expect(noId.getByRole('radio', { name: 'It\'s a new transaction: add it', checked: true })).toHaveCount(2);
    await expect(dialog.getByTestId('unsaved')).toHaveCount(0);
    await expect(dialog.getByText('2 items still need a decision before a plan can be prepared.')).toHaveCount(0);
  });

  test('"Show more" never races a refresh: it waits for one, and a page on its way is read by the next', async ({ page }) => {
    const { fake, deliver } = await serve(page, { scenario: 'demo' });
    fake.addCommittedHistory(110);
    await openArea(page, 'Sync & coverage');
    const runs = page.getByRole('region', { name: 'Recent runs' });
    await expect(runs.locator('li[data-run]')).toHaveCount(50);
    const hold = async (first: boolean) => {
      let release = () => {};
      const held = new Promise<void>((resolve) => { release = resolve; });
      const state = { started: false };
      await page.route((url) => url.pathname === '/card-sync/owner/runs' && url.searchParams.has('cursor') !== first, async (route) => {
        state.started = true;
        const answer = await deliver(route);
        await held;
        await route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body) });
      }, { times: 1 });
      return { state, release: () => release() };
    };
    const refresh = page.getByRole('region', { name: 'Sync controls' }).getByRole('button', { name: 'Refresh' });

    // "Show more" asked for while a refresh is on its way waits for it, then reads the next page.
    const firstPage = await hold(true);
    await refresh.click();
    await expect.poll(() => firstPage.state.started).toBe(true);
    await runs.getByRole('button', { name: 'Show more runs' }).click();
    await expect(runs.getByRole('button', { name: 'Loading…' })).toBeDisabled();
    await expect(runs.locator('li[data-run]')).toHaveCount(50);
    firstPage.release();
    await expect(runs.locator('li[data-run]')).toHaveCount(100);

    // A page still on its way when a refresh starts is read by the refresh; its own late answer is dropped.
    const nextPage = await hold(false);
    await runs.getByRole('button', { name: 'Show more runs' }).click();
    await expect.poll(() => nextPage.state.started).toBe(true);
    await refresh.click();
    await expect(runs.locator('li[data-run]')).toHaveCount(119);
    nextPage.release();
    await expect(runs.getByRole('button', { name: 'Show more runs' })).toHaveCount(0);
    await expect(runs.locator('li[data-run]')).toHaveCount(119);
  });

  test('an open review that expires on screen locks, and says to capture again', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    await openArea(page, 'Sync & coverage');
    await card(page, 'citi').getByRole('button', { name: 'Review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review: Citi Double Cash (Citi)' });
    await expect(dialog.getByTestId('set-expiry')).toContainText('Less than a day left.');
    fake.advance(5 * HOUR);
    await page.clock.setFixedTime(new Date(FAKE_NOW + 5 * HOUR));
    // Any re-render now runs on the later clock, before Holdr's clean-up is even read.
    await dialog.locator('fieldset[data-category="reconciliation-difference"]').getByRole('radio').first().check();
    await expect(dialog.getByTestId('set-closed')).toContainText('expired');
    await expect(dialog.getByTestId('set-closed')).toContainText('Capture this period again, or import the redacted offline file for it.');
    await expect(dialog.getByRole('button', { name: /^Prepare/ })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Discard this import…' })).toHaveCount(0);
    for (const radio of await dialog.getByRole('radio').all()) await expect(radio).toBeDisabled();
  });

  test('keyboard focus stays in the password dialog while it checks, and in the innermost of two dialogs', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo' });
    fake.core.pause();
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route((url) => url.pathname === '/auth/reverify', async (route) => {
      await held;
      await route.fallback();
    });
    await openArea(page, 'Extension & devices');
    await page.getByRole('button', { name: 'Resume syncing' }).click();
    const password = page.getByRole('dialog', { name: 'Confirm it\'s you' });
    await password.getByLabel('Holdr password').fill(FAKE_OWNER_PASSWORD);
    await password.getByRole('button', { name: 'Confirm' }).click();
    await expect(password.getByRole('button', { name: 'Checking…' })).toBeDisabled();
    const inside = (dialog: typeof password) => dialog.evaluate((element) => element.contains(document.activeElement));
    for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Tab']) {
      await page.keyboard.press(key);
      expect(await inside(password)).toBe(true);
    }
    release();
    await expect(page.getByText('Syncing resumed.')).toBeVisible();

    await areaTab(page, 'Sync & coverage').click();
    await card(page, 'chase').getByRole('button', { name: 'Review' }).click();
    const review = page.getByRole('dialog', { name: 'Review: Chase Sapphire (Chase)' });
    await review.getByRole('button', { name: 'Discard this import…' }).click();
    await review.getByLabel('Why discard it').selectOption('other');
    await review.getByRole('button', { name: 'Discard', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'Discard this import?' });
    for (let press = 0; press < 5; press += 1) {
      await page.keyboard.press('Tab');
      expect(await inside(confirm)).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(review).toBeVisible();
    expect(await inside(review)).toBe(true);
    expect(fake.store.sets[0].state).toBe('accepted-uncommitted');
  });
});

/**
 * Readability (plan item H): plain names in every visible heading, each connected card leading with when Holdr last
 * received something and the one next step, consent kept in view, and the D1 type floors measured on the page, in
 * the default, expanded, empty and failed states, on a phone and on a wide screen.
 */
test.describe('Spending sync controls: readability (plan H)', () => {
  /** The text of every visible heading, legend and dialog title on the page. */
  const visibleHeadings = (page: Page) => page.evaluate(() => [...document.querySelectorAll('h1, h2, h3, h4, h5, h6, legend, [role="heading"]')]
    .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
    .map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim()));

  /**
   * Every visible text of the sync pages, their dialogs, the notice in Card transactions and the area tabs, measured
   * against D1: 18px or more in a section heading, 16px or more for reading text, 13px only in a tab's count badge,
   * 14px or more for everything else (help, labels, status, warnings, controls). Running text that can wrap has a line
   * height of 1.5 or more; headings, titles and single-line controls (buttons, tabs, chips, badges) 1.25 or more.
   * Answers what falls short.
   */
  const floors = (page: Page) => page.evaluate(() => {
    type Kind = 'heading' | 'read' | 'badge' | 'other';
    const READ = '.sync-text, .sync-lead, .sync-card-name, .sync-row-text > strong, .sync-steps strong, .sync-option, .sync-item legend';
    const TIGHT = 'h1, h2, h3, h4, h5, h6, button, [role="tab"], .sync-status, .sync-flag, .spending-area-badge, .sync-banner > strong';
    const FLOOR: Record<Kind, number> = { heading: 18, read: 16, badge: 13, other: 14 };
    const counts: Record<Kind | 'control', number> = { heading: 0, read: 0, badge: 0, other: 0, control: 0 };
    const short: string[] = [];
    const seen = new Set<Node>();
    const shown = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'
      && element.closest('.visually-hidden') === null;
    for (const root of document.querySelectorAll('.sync-area, .sync-dialog, .spending-areas, .sync-waiting')) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
        const element = node.parentElement;
        if (!text || !element || seen.has(node) || !shown(element)) continue;
        seen.add(node);
        const kind: Kind = element.closest('h3') ? 'heading' : element.closest('.spending-area-badge') ? 'badge' : element.closest(READ) ? 'read' : 'other';
        counts[kind] += 1;
        const style = getComputedStyle(element);
        const size = parseFloat(style.fontSize);
        if (size < FLOOR[kind]) short.push(`${kind} ${size}px: ${text.slice(0, 70)}`);
        const leading = style.lineHeight === 'normal' ? 1.2 : parseFloat(style.lineHeight) / size;
        const least = element.closest(TIGHT) ? 1.25 : 1.5;
        if (leading < least - 0.01) short.push(`${kind} line height ${leading.toFixed(2)}: ${text.slice(0, 70)}`);
      }
      for (const control of root.querySelectorAll('select, textarea, input:not([type="checkbox"]):not([type="radio"])')) {
        if (!shown(control)) continue;
        counts.control += 1;
        const size = parseFloat(getComputedStyle(control).fontSize);
        if (size < 14) short.push(`control ${size}px: ${control.outerHTML.slice(0, 70)}`);
      }
      // Paragraphs stop at 65ch, as CSS resolves 65ch in the paragraph's own font (the T1 sweep's measure).
      for (const p of root.querySelectorAll('p')) {
        const text = (p.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (!text || !shown(p)) continue;
        const probe = document.createElement('span');
        probe.style.cssText = 'position: absolute; visibility: hidden; width: 65ch; height: 0; margin: 0; padding: 0; border: 0;';
        p.appendChild(probe);
        const measure = probe.getBoundingClientRect().width;
        probe.remove();
        const style = getComputedStyle(p);
        const content = p.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
          - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
        if (content > measure + 1) short.push(`measure ${Math.round(content)}px, 65ch is ${Math.round(measure)}px: ${text.slice(0, 70)}`);
      }
    }
    return { short: [...new Set(short)], counts };
  });

  async function expectFloors(page: Page, state: string, least = 1): Promise<void> {
    const { short, counts } = await floors(page);
    expect(short, `${state}: texts under the D1 floors`).toEqual([]);
    expect(counts.read, `${state}: reading texts measured`).toBeGreaterThanOrEqual(least);
  }

  /** Fully on screen once scrolled to, at a readable size: nothing about it clipped, folded or shrunk. */
  async function expectInView(locator: Locator, least = 14): Promise<void> {
    await locator.scrollIntoViewIfNeeded();
    await expect(locator).toBeInViewport({ ratio: 1 });
    const { size, clipped } = await locator.evaluate((element) => ({
      size: parseFloat(getComputedStyle(element).fontSize),
      clipped: element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1,
    }));
    expect(size).toBeGreaterThanOrEqual(least);
    expect(clipped).toBe(false);
  }

  /** A consent's label is a plain block of text: no pill or border drawn through it, whatever the width. */
  const unboxed = (label: Locator) => label.evaluate((element) => {
    const style = getComputedStyle(element);
    return { border: parseFloat(style.borderTopWidth) + parseFloat(style.borderLeftWidth), radius: parseFloat(style.borderTopLeftRadius) };
  });

  test('no visible heading says "binding" or "observation", on either page or in the dialogs they open', async ({ page }) => {
    await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    const seen: string[] = [];
    const collect = async () => { seen.push(...await visibleHeadings(page)); };
    await openArea(page, 'Sync & coverage');
    await expect(card(page, 'chase')).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: 'Connected cards' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: 'Imports awaiting review (3)' })).toBeVisible();
    // Each section is named by its own heading, so what a screen reader announces is what the page shows.
    for (const name of ['Connected cards', 'Imports awaiting review (3)', 'Recent runs']) {
      await expect(page.getByRole('region', { name, exact: true })).toBeVisible();
    }
    await expect(page.getByRole('region', { name: 'Sync controls' }).getByTestId('awaiting-count')).toHaveText('3 imports awaiting review, not in spending yet.');
    await collect();
    // Expanded: a card's details and the closed reviews, then a review and a run.
    await card(page, 'amex').getByRole('button', { name: 'Details: attempts, plans, browsers and coverage' }).click();
    const queue = page.getByRole('region', { name: 'Imports awaiting review' });
    await queue.getByRole('button', { name: 'Show closed reviews' }).click();
    await expect(queue.getByRole('list', { name: 'Closed reviews' }).locator('li').first()).toBeVisible();
    await collect();
    await card(page, 'amex').getByRole('button', { name: 'Review' }).click();
    const review = page.getByRole('dialog', { name: 'Review: Amex Gold (Amex)' });
    await expect(review.getByRole('heading', { name: 'No stable id (2)' })).toBeVisible();
    await collect();
    await review.getByRole('button', { name: 'Close review' }).click();
    await page.getByRole('region', { name: 'Recent runs' }).locator('li[data-run]').first().getByRole('button', { name: 'Details' }).click();
    const run = page.getByRole('dialog', { name: /^Run of / });
    await expect(run.getByRole('heading', { name: 'The exact object that was sent' })).toBeVisible();
    await collect();
    await run.getByRole('button', { name: 'Close run' }).click();

    await areaTab(page, 'Extension & devices').click();
    const connected = page.getByRole('region', { name: 'Connected cards' });
    await expect(connected.getByRole('heading', { level: 3, name: 'Connected cards' })).toBeVisible();
    for (const name of ['Sync switches', 'Connected cards', 'Browsers', 'What Holdr keeps, and for how long']) {
      await expect(page.getByRole('region', { name, exact: true }).getByRole('heading', { level: 3, name, exact: true })).toBeVisible();
    }
    await expect(connected.getByRole('heading', { level: 4 })).toHaveText([
      'Chase Sapphire (Chase)', 'Amex Gold (Amex)', 'Citi Double Cash (Citi)', 'Wells Fargo Active Cash (Wells Fargo)',
    ]);
    await expect(connected.locator('li[data-binding="chase"]').getByRole('button', { name: 'Disconnect…' })).toBeVisible();
    await collect();
    await page.getByRole('button', { name: 'Connect a card…' }).click();
    const editor = page.getByRole('dialog', { name: 'Connect a card' });
    await expect(editor.getByRole('group', { name: 'Cards the bank shows on this account' })).toBeVisible();
    await collect();
    await editor.getByRole('button', { name: 'Cancel' }).click();
    await connected.locator('li[data-binding="chase"]').getByRole('button', { name: 'Edit cards…' }).click();
    const cards = page.getByRole('dialog', { name: 'Cards of Chase Sapphire' });
    await expect(cards.getByRole('group', { name: 'Browsers that keep sending for this card' })).toBeVisible();
    await collect();
    await cards.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Pair a browser…' }).click();
    const pairing = page.getByRole('dialog', { name: 'Pair a browser' });
    await expect(pairing.getByRole('group', { name: 'Connected cards for this browser' })).toBeVisible();
    await collect();

    expect(seen.length).toBeGreaterThan(20);
    expect(seen.filter((text) => /binding|observation/i.test(text))).toEqual([]);
  });

  test('a card whose imports Holdr no longer keeps says its last times are not on record, never that nothing arrived (review P2)', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo' });
    // Retention, as its last phase leaves a card a year on: every closed, cleared import and its runs deleted. Holdr works
    // out "last received", "last attempt" and "last plan applied" from what it still keeps, so all three come back empty.
    const citi = fake.store.bindings.find((binding) => binding.issuer === 'citi')!.bindingId;
    const kept = { sets: fake.store.sets.filter((set) => set.bindingId !== citi), runs: fake.store.runs.filter((run) => run.bindingId !== citi) };
    expect(fake.store.sets.length - kept.sets.length).toBeGreaterThan(0);
    fake.store.sets.splice(0, fake.store.sets.length, ...kept.sets);
    fake.store.runs.splice(0, fake.store.runs.length, ...kept.runs);
    await openArea(page, 'Sync & coverage');
    const item = card(page, 'citi');
    await expect(item.getByTestId('last-received')).toHaveText('Last received: not on record');
    await expect(item.getByTestId('next-step')).toHaveText('Next: Sign in to the bank yourself and open its activity page; the extension starts from there.');
    await item.getByRole('button', { name: 'Details: attempts, plans, browsers and coverage' }).click();
    await expect(item.locator('.sync-facts dd')).toHaveText(['Not on record', 'Not on record', 'Mac Chrome']);
    await expect(item.locator('.sync-details')).toContainText('No coverage on record for this card.');
    // Unknown is said as unknown: nothing on the card claims that nothing was ever received, attempted or applied.
    expect(await item.innerText()).not.toMatch(/nothing (received|yet)|none yet|never|\byet\b/i);
  });

  for (const [width, height, mobile] of [[375, 812, true], [1920, 1080, false]] as const) {
    test.describe(`${width}px`, () => {
      test.use({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });

      test(`each connected card's first two lines say when Holdr last received something and what to do next (${width}px)`, async ({ page }) => {
        await serve(page, { scenario: 'demo' });
        await openArea(page, 'Sync & coverage');
        const expected: Record<string, [string, string, string]> = {
          chase: ['Chase Sapphire (Chase)', 'Last received 2 hours ago · Oct 17, 2026, 10:00 AM', 'Next: Review it before it expires.'],
          amex: ['Amex Gold (Amex)', 'Last received 25 days ago · Sep 22, 2026, 12:00 PM', 'Next: Open the review and prepare a new plan from the current ledger.'],
          citi: ['Citi Double Cash (Citi)', 'Last received 29 days ago · Sep 17, 2026, 4:00 PM', 'Next: Review it before it expires.'],
          wellsfargo: ['Wells Fargo Active Cash (Wells Fargo)', 'Last received: not on record', 'Next: Open the extension popup to see what happened.'],
        };
        for (const [issuer, [name, received, next]] of Object.entries(expected)) {
          const item = card(page, issuer);
          // In reading order: the card's name and Holdr card account, then when, then what next; everything else after.
          const lines = (await item.innerText()).split('\n').map((line) => line.trim()).filter(Boolean);
          expect(lines[0], issuer).toBe(name);
          expect(lines.slice(2, 4), issuer).toEqual([received, next]);
          // And on screen, in that order, top to bottom.
          const top = async (locator: Locator) => (await locator.boundingBox())!.y;
          const when = await top(item.getByTestId('last-received'));
          const step = await top(item.getByTestId('next-step'));
          expect(when, issuer).toBeLessThan(step);
          expect(step, issuer).toBeLessThan(await top(item.locator('[data-status]')));
          expect(step, issuer).toBeLessThan(await top(item.getByRole('button', { name: 'Details: attempts, plans, browsers and coverage' })));
        }
        // Attempts, plans and browsers are folded: closed at first, one keypress away, and each says its own value.
        const chase = card(page, 'chase');
        const details = chase.getByRole('button', { name: 'Details: attempts, plans, browsers and coverage' });
        await expect(details).toHaveAttribute('aria-expanded', 'false');
        await expect(chase.getByText('Last attempt')).toHaveCount(0);
        await details.focus();
        await page.keyboard.press('Enter');
        await expect(details).toHaveAttribute('aria-expanded', 'true');
        const facts = chase.locator('.sync-facts');
        await expect(facts.locator('dt')).toHaveText(['Last attempt', 'Last plan applied', 'Browsers']);
        await expect(facts.locator('dd')).toHaveText(['Oct 17, 2026, 10:00 AM (2 hours ago)', 'Oct 7, 2026, 1:00 PM', 'Laptop Chrome']);
        await page.keyboard.press('Space');
        await expect(details).toHaveAttribute('aria-expanded', 'false');
        await noOverflow(page);
      });

      test(`the queue's explanation is short lines, one rule or instruction each (${width}px)`, async ({ page }) => {
        await serve(page, { scenario: 'demo' });
        await openArea(page, 'Sync & coverage');
        const queue = page.getByRole('region', { name: 'Imports awaiting review' });
        await expect(queue.getByRole('heading', { level: 3 })).toHaveText('Imports awaiting review (3)');
        await expect(queue.getByTestId('queue-lines').getByRole('listitem')).toHaveText([
          'Nothing here is in spending until a plan for it is confirmed.',
          'Confirm plans here, or in the extension when nothing needs a decision.',
          'Holdr keeps each import 30 days from receipt, then clears it.',
        ]);
        // The three imports waiting are the ones listed.
        await expect(queue.locator('li[data-set]')).toHaveCount(3);
        await noOverflow(page);
      });

      test(`consent stays in view: turning a bank on, automatic sending, and approving a browser (${width}px)`, async ({ page }) => {
        const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
        fake.core.disableIssuer('amex');
        fake.setAutoSyncGate('open', 'chase');
        await openArea(page, 'Extension & devices');
        const chase = page.getByRole('region', { name: 'Connected cards' }).locator('li[data-binding="chase"]');
        // Whether automatic sending is on, and for which browsers, is said on the card itself, never folded away.
        await expect(chase.getByTestId('auto-sync-state')).toHaveText('Automatic sending: off.');
        await expectInView(chase.getByTestId('auto-sync-state'));
        // Turning a bank on: both acknowledgements, in full and at reading size, before it can be switched on.
        const amex = page.getByRole('region', { name: 'Sync switches' }).locator('li[data-issuer="amex"]');
        await amex.getByRole('button', { name: 'Turn on…' }).click();
        for (const text of [/^I understand the extension works inside my signed-in bank session/, /^I understand Amex is read by watching/]) {
          await expectInView(amex.getByText(text), 16);
        }
        for (const label of await amex.locator('.sync-consent > label').all()) expect(await unboxed(label)).toEqual({ border: 0, radius: 0 });
        await expect(amex.getByRole('button', { name: 'Turn Amex on' })).toBeDisabled();
        await amex.getByRole('button', { name: 'Cancel' }).click();
        // Automatic sending: the permission it gives, in full, in its confirmation.
        await chase.getByRole('button', { name: 'Turn automatic sending on…' }).click();
        const confirm = page.getByRole('dialog', { name: 'Send Chase Sapphire automatically?' });
        await expectInView(confirm.getByText(/^This is permission given in advance, not a check each time/), 16);
        await confirm.getByRole('button', { name: 'Cancel' }).click();
        expect(fake.store.bindings.find((binding) => binding.issuer === 'chase')!.autoSyncConsent.size).toBe(0);
        // Approving a browser: what the owner compares and confirms.
        await page.getByRole('button', { name: 'Pair a browser…' }).click();
        const pairing = page.getByRole('dialog', { name: 'Pair a browser' });
        await pairing.getByLabel('Chase Sapphire (Chase)').check();
        await pairing.getByRole('button', { name: 'Create a pairing code' }).click();
        await expect(pairing.getByTestId('pairing-code')).toBeVisible();
        fake.redeemOpenPairing('Phone test');
        await pairing.getByRole('button', { name: 'Check now' }).click();
        await expectInView(pairing.getByText('The popup shows exactly this confirmation code and this address'), 16);
        expect(await unboxed(pairing.locator('.sync-approval > label'))).toEqual({ border: 0, radius: 0 });
        await expect(pairing.getByRole('button', { name: 'Approve' })).toBeDisabled();
      });

      test(`type floors on Sync & coverage: as it opens, expanded, its dialogs, and a failed action (${width}px)`, async ({ page }) => {
        const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
        await openArea(page, 'Sync & coverage');
        await expect(card(page, 'chase')).toBeVisible();
        await expect(page.getByRole('region', { name: 'Recent runs' }).locator('li[data-run]').first()).toBeVisible();
        await expectFloors(page, 'sync');
        for (const issuer of ['chase', 'amex', 'citi', 'wellsfargo']) {
          await card(page, issuer).getByRole('button', { name: 'Details: attempts, plans, browsers and coverage' }).click();
        }
        const queue = page.getByRole('region', { name: 'Imports awaiting review' });
        await queue.getByRole('button', { name: 'Show closed reviews' }).click();
        await expect(queue.getByRole('list', { name: 'Closed reviews' }).locator('li').first()).toBeVisible();
        await expectFloors(page, 'sync, expanded');
        await card(page, 'amex').getByRole('button', { name: 'Review' }).click();
        const review = page.getByRole('dialog', { name: 'Review: Amex Gold (Amex)' });
        await expect(review.getByRole('heading', { name: 'No stable id (2)' })).toBeVisible();
        await review.getByRole('button', { name: 'Discard this import…' }).click();
        await expect(review.getByLabel('Why discard it')).toBeVisible();
        await expectFloors(page, 'review');
        await review.getByRole('button', { name: 'Close review' }).click();
        const runs = page.getByRole('region', { name: 'Recent runs' });
        await runs.locator(`li[data-run="${fake.store.runs[0].runId}"]`).getByRole('button', { name: 'Details' }).click();
        const run = page.getByRole('dialog', { name: /^Run of / });
        await run.getByRole('button', { name: 'Show the exact object sent' }).click();
        await expect(run.getByRole('region', { name: 'Exact sent object (JSON)' })).toBeVisible();
        await expectFloors(page, 'run');
        await run.getByRole('button', { name: 'Close run' }).click();
        fake.failNext(/^POST \/card-sync\/owner\/pause$/, { status: 503, body: { error: 'unavailable' } });
        await page.getByRole('region', { name: 'Sync controls' }).getByRole('button', { name: 'Pause all syncing' }).click();
        await expect(page.getByRole('region', { name: 'Sync controls' }).getByRole('alert')).toContainText('Holdr is busy.');
        await expectFloors(page, 'sync, failed action');
        await areaTab(page, 'Card transactions').click();
        await expect(page.locator('.sync-waiting')).toBeVisible();
        await expectFloors(page, 'transactions notice', 0);
      });

      test(`type floors on Extension & devices: as it opens, expanded, a failure, and its dialogs (${width}px)`, async ({ page }) => {
        const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
        fake.core.disableIssuer('amex');
        await openArea(page, 'Extension & devices');
        await expect(page.getByRole('region', { name: 'Browsers' }).locator('li[data-device]').first()).toBeVisible();
        await expectFloors(page, 'devices');
        const steps = page.getByRole('region', { name: 'First run' });
        await steps.getByRole('button', { name: 'Set up: show the steps' }).click();
        await expect(steps.locator('li[data-step]')).toHaveCount(7);
        const amex = page.getByRole('region', { name: 'Sync switches' }).locator('li[data-issuer="amex"]');
        await amex.getByRole('button', { name: 'Turn on…' }).click();
        await expect(amex.getByText(/which a hostile page could forge/)).toBeVisible();
        await expectFloors(page, 'devices, expanded');
        fake.failNext(/^POST \/card-sync\/owner\/issuers\/citi\/disable$/, { status: 409, body: { error: 'version-conflict', currentVersion: 99 } });
        await page.getByRole('region', { name: 'Sync switches' }).locator('li[data-issuer="citi"]').getByRole('button', { name: 'Turn off' }).click();
        await expect(page.getByText('This changed in another window or browser.')).toBeVisible();
        await expectFloors(page, 'devices, failed action');
        await page.getByRole('button', { name: 'Connect a card…' }).click();
        const editor = page.getByRole('dialog', { name: 'Connect a card' });
        await editor.getByText('I checked these cards against what the bank shows for this account.').click();
        await editor.getByRole('button', { name: 'Connect this card' }).click();
        await expect(editor.getByRole('alert')).toContainText('Give it a short plain name');
        await expectFloors(page, 'connect a card, refused');
        await editor.getByRole('button', { name: 'Cancel' }).click();
        await page.getByRole('button', { name: 'Pair a browser…' }).click();
        const pairing = page.getByRole('dialog', { name: 'Pair a browser' });
        await pairing.getByLabel('Chase Sapphire (Chase)').check();
        await pairing.getByRole('button', { name: 'Create a pairing code' }).click();
        await expect(pairing.getByTestId('pairing-code')).toBeVisible();
        await expectFloors(page, 'pairing code');
        fake.redeemOpenPairing('Phone test');
        await pairing.getByRole('button', { name: 'Check now' }).click();
        await expect(pairing.getByTestId('confirmation-code')).toBeVisible();
        await expectFloors(page, 'approval');
      });

      test(`type floors when nothing is connected, without Holdr's sync, and when loading it fails (${width}px)`, async ({ page }) => {
        await serve(page, { scenario: 'fresh' });
        await openArea(page, 'Sync & coverage');
        await expect(page.getByTestId('setup-steps')).toBeVisible();
        await expectFloors(page, 'sync, nothing connected');
        await areaTab(page, 'Extension & devices').click();
        await expect(page.getByRole('region', { name: 'Connected cards' })).toContainText('No connected cards yet.');
        await expectFloors(page, 'devices, nothing connected');
      });

      test(`type floors when Holdr's answer fails the page's checks (${width}px)`, async ({ page }) => {
        const { fake } = await serve(page, { scenario: 'demo' });
        const state = fake.handle({ method: 'GET', url: '/card-sync/owner/state' }).body as Record<string, unknown>;
        await page.route((url) => url.pathname === '/card-sync/owner/state', (route) => route.fulfill({
          status: 200, contentType: 'application/json', body: JSON.stringify({ ...state, deviceToken: `hdv1_${'a'.repeat(64)}` }),
        }));
        await openArea(page, 'Sync & coverage');
        await expect(page.getByText(/^Couldn't load sync: /)).toBeVisible();
        await expectFloors(page, 'sync, failed to load', 0);
      });

      test(`type floors when Holdr has no extension sync (${width}px)`, async ({ page }) => {
        await serve(page, null);
        await openArea(page, 'Sync & coverage');
        await expect(page.getByText('Not set up: this Holdr doesn\'t support extension sync yet.')).toBeVisible();
        await expectFloors(page, 'no extension sync', 0);
        await areaTab(page, 'Extension & devices').click();
        await expect(page.getByText('Not set up: this Holdr doesn\'t support extension sync yet.')).toBeVisible();
        await expectFloors(page, 'devices, no extension sync', 0);
      });
    });
  }
});

test.describe('Spending sync controls (phone)', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('areas scroll sideways, cards stack, and review and pairing open full screen without overflow', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    await openArea(page, 'Sync & coverage');
    await expect(card(page, 'amex').locator('[data-status]')).toHaveText('Plan expired (prepare a new one)');
    await noOverflow(page);
    expect(await page.locator('.spending-areas').evaluate((element) => getComputedStyle(element).overflowX)).toBe('auto');
    const chaseBox = await card(page, 'chase').boundingBox();
    const amexBox = await card(page, 'amex').boundingBox();
    expect(amexBox!.y).toBeGreaterThan(chaseBox!.y + chaseBox!.height - 1);

    await card(page, 'amex').getByRole('button', { name: 'Review' }).click();
    const review = page.getByRole('dialog', { name: 'Review: Amex Gold (Amex)' });
    const box = await review.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(389);
    expect(box!.x).toBeLessThanOrEqual(1);
    await review.getByRole('button', { name: 'Close review' }).click();

    await areaTab(page, 'Extension & devices').click();
    await page.getByRole('button', { name: 'Pair a browser…' }).click();
    const pairing = page.getByRole('dialog', { name: 'Pair a browser' });
    await pairing.getByLabel('Chase Sapphire (Chase)').check();
    await pairing.getByRole('button', { name: 'Create a pairing code' }).click();
    await expect(pairing.getByTestId('pairing-code')).toBeVisible();
    const code = await pairing.getByTestId('pairing-code').boundingBox();
    expect(code!.x + code!.width).toBeLessThanOrEqual(390);
    fake.redeemOpenPairing('Phone test');
    await pairing.getByRole('button', { name: 'Check now' }).click();
    await expect(pairing.getByTestId('confirmation-code')).toBeVisible();
    await noOverflow(page);
  });

  test('a file import review and a browser to allow again fit the phone without overflow', async ({ page }) => {
    const { fake } = await serve(page, { scenario: 'demo', recentAuth: 'granted' });
    const setId = fake.addFileReviewSet();
    const chase = fake.store.bindings[0];
    fake.core.confirmBinding(chase.bindingId, {
      expectedVersion: chase.bindingVersion, bindingLabel: chase.bindingLabel, regrantDeviceIds: [],
      scopes: chase.scopes.filter((scope) => scope.kind === 'known' && scope.status === 'active')
        .map((scope) => ({ cardScopeId: scope.cardScopeId, scopeLabel: scope.scopeLabel, holderAlias: scope.holderAlias as 'alex', last4: scope.last4 })),
    });
    await openArea(page, 'Sync & coverage');
    await expect(card(page, 'chase').locator('[data-status]')).toHaveText('No working device: allow a browser again');
    await page.getByRole('region', { name: 'Imports awaiting review' }).locator(`li[data-set="${setId}"]`).getByRole('button', { name: 'Review' }).click();
    const review = page.getByRole('dialog', { name: /^Review: File import · / });
    await expect(review.locator('fieldset[data-reason="removed-hit"]')).toBeVisible();
    const box = await review.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(389);
    expect(box!.x).toBeLessThanOrEqual(1);
    await noOverflow(page);
    await review.getByRole('button', { name: 'Close review' }).click();
    await areaTab(page, 'Extension & devices').click();
    const row = page.getByRole('region', { name: 'Browsers' }).locator('li', { hasText: 'Laptop Chrome: active' });
    await row.getByRole('button', { name: 'Allow again…' }).click();
    await expect(row.getByRole('group', { name: 'Allow Laptop Chrome to send again for' })).toBeVisible();
    await noOverflow(page);
  });

  test('a charge\'s sources and history, and moving a source, fit the phone without overflow (X29)', async ({ page }) => {
    await serve(page, { scenario: 'demo', recentAuth: 'granted' }, { ledger: true });
    await openArea(page, 'Card transactions');
    await page.getByRole('button', { name: 'Fabrikam Fuel, $52.10, Oct 5: details' }).click();
    await page.getByRole('dialog', { name: 'Fabrikam Fuel', exact: true }).getByRole('button', { name: 'Sources and history…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Sources and history: FABRIKAM FUEL 0042' });
    await expect(dialog.getByRole('region', { name: 'Merged into this charge' })).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(389);
    expect(box!.x).toBeLessThanOrEqual(1);
    await noOverflow(page);
    await dialog.locator('li[data-identity]').first().getByRole('button', { name: 'Move to another charge…' }).click();
    const panel = dialog.getByRole('region', { name: 'Move a source' });
    await expect(panel.locator('label[data-target]').first()).toBeVisible();
    await noOverflow(page);
    const option = await panel.locator('label[data-target]').first().boundingBox();
    expect(option!.x + option!.width).toBeLessThanOrEqual(390);
  });
});
