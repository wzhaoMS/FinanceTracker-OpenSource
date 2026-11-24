/**
 * Stops and boundaries (plan §2.4, §3.3, §9.2): kill switch (also for device
 * traffic, and finished at the next start when the worker stopping
 * interrupted it), per-issuer disable, site permission revoked in the
 * browser's own UI, a signed-out page, a page opened before its issuer was
 * enabled (missed document_start), several tabs of one issuer, an SPA account
 * switch and a hostile page.
 */
import { TARGET as TEST_TARGET } from '../../src/config/test.js';
import { expect, ORIGINS, test } from './support/harness.js';
import { account, chasePreview, chaseReady, mapScopes } from './support/steps.js';

async function registered(ext: { inExtension: <R, A>(fn: (arg: A) => R | Promise<R>, arg: A) => Promise<R> }): Promise<string[]> {
  return ext.inExtension(async () => (await chrome.scripting.getRegisteredContentScripts()).map((script) => script.id), null);
}

test('kill switch stops collectors, drops the unsent preview, unregisters scripts and refuses reads until resumed', async ({ ext, world }) => {
  const { bank, popup } = await chasePreview(ext, world);
  expect(await registered(ext)).toEqual(['holdr-fake-chase-isolated']);
  await popup.getByTestId('pause').click();
  await expect(popup.getByTestId('paused-banner')).toBeVisible();
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: discarded');
  await expect(popup.getByTestId('pages')).toContainText('No enabled issuer page is open');
  expect(await registered(ext)).toEqual([]);
  const stored = await ext.inExtension(async () => (await chrome.storage.session.get('capture')).capture as { text: string | null }, null);
  expect(stored.text).toBeNull();
  // A reload brings no collector back while paused.
  const readsBefore = world.issuers.extensionReads('chase.e3.test').length;
  await bank.reload();
  await bank.waitForTimeout(1_000);
  expect(world.issuers.extensionReads('chase.e3.test').length).toBe(readsBefore);
  expect(world.holdr.observationBodies()).toEqual([]);
  await popup.getByTestId('resume').click();
  await expect(popup.getByTestId('pause')).toBeVisible();
  expect(await registered(ext)).toEqual(['holdr-fake-chase-isolated']);
});

test('while paused nothing goes to Holdr at all: a device status check or a pairing is refused before the network', async ({ ext, world }) => {
  await ext.pair();
  const before = world.holdr.arrivals.length;
  expect(await ext.inExtension(() => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'set-paused', on: true }), null)).toMatchObject({ ok: true });
  expect(await ext.inExtension(() => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'refresh-device' }), null)).toMatchObject({ ok: false, code: 'paused' });
  const code = world.holdr.createPairing();
  expect(await ext.inExtension((pairingCode) => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'pair', pairingCode, deviceLabel: 'Second' }), code)).toMatchObject({ ok: false, code: 'paused' });
  expect(world.holdr.arrivals.slice(before)).toEqual([]);
  expect(await ext.inExtension(() => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'set-paused', on: false }), null)).toMatchObject({ ok: true });
  expect(await ext.inExtension(() => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'refresh-device' }), null)).toMatchObject({ ok: true });
});

test('a kill switch that the worker stopping interrupted (stored, not yet carried out) is finished at the next start', async ({ ext, world }) => {
  const { popup } = await chasePreview(ext, world);
  await popup.close();
  // The pause is stored, but the worker stops before dropping the preview and stopping the page.
  await ext.inExtension(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...(settings as object), paused: true } });
  }, null);
  const { restarted } = await ext.stopWorker();
  const reopened = await ext.popup();
  await restarted;
  await expect(reopened.getByTestId('paused-banner')).toBeVisible();
  await expect(reopened.getByTestId('capture-stage')).toHaveText('Stage: discarded');
  await expect(reopened.getByTestId('pages')).toContainText('No enabled issuer page is open');
  expect(await ext.inExtension(async () => ((await chrome.storage.session.get('capture')).capture as { text: string | null }).text, null)).toBeNull();
  expect(await registered(ext)).toEqual([]);
  await reopened.getByTestId('resume').click();
  await expect(reopened.getByTestId('send')).toHaveCount(0);
  expect(world.holdr.observationBodies()).toEqual([]);
});

test('site access removed in the browser’s own extensions page stops and disables the issuer', async ({ ext, world }) => {
  const { bank, popup } = await chaseReady(ext);
  await ext.revokeSite(ORIGINS.chase);
  await expect.poll(() => registered(ext)).toEqual([]);
  await expect(popup.getByTestId('pages')).toContainText('No enabled issuer page is open');
  const options = await ext.options();
  await expect(options.getByTestId('issuer-state-fake-chase')).toHaveText('Off');
  const readsBefore = world.issuers.extensionReads('chase.e3.test').length;
  await bank.reload();
  await bank.waitForTimeout(1_000);
  expect(world.issuers.extensionReads('chase.e3.test').length).toBe(readsBefore);
});

test('disabling an issuer in settings removes its site permission and its scripts', async ({ ext }) => {
  await ext.enableIssuer('fake-chase', ORIGINS.chase, false);
  expect(await registered(ext)).toEqual(['holdr-fake-chase-isolated']);
  const options = await ext.options();
  await options.getByTestId('disable-fake-chase').click();
  await expect(options.getByTestId('issuer-state-fake-chase')).toHaveText('Off');
  expect(await ext.inExtension(() => chrome.permissions.contains({ origins: ['http://chase.e3.test/*'] }), null)).toBe(false);
  expect(await registered(ext)).toEqual([]);
});

test('a signed-out issuer page is recognised and nothing is read', async ({ ext, world }) => {
  world.issuers.controls.signedIn = false;
  await ext.pair();
  await ext.enableIssuer('fake-chase', ORIGINS.chase, false);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.chase}/dashboard`);
  const popup = await ext.popup();
  await expect(popup.getByTestId('page-state-fake-chase')).toContainText('Page: auth-required');
  await bank.waitForTimeout(1_000);
  expect(world.issuers.extensionReads('chase.e3.test')).toEqual([]);
});

test('a page opened before its issuer was enabled is not backfilled; a reload starts the collector', async ({ ext }) => {
  await ext.pair();
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.amex}/activity`);
  await ext.enableIssuer('fake-amex', ORIGINS.amex, true);
  const popup = await ext.popup();
  await popup.waitForTimeout(1_000);
  await expect(popup.getByTestId('pages')).toContainText('reload it: Holdr never backfills a page it missed');
  await bank.reload();
  await account(popup, 'fake-amex', 'Card …0003');
  await expect(popup.getByTestId('page-fake-amex')).toContainText('5 posted · 1 pending');
});

test('two tabs of one issuer: discovery runs in one tab at a time, spaced issuer-wide, and both end up ready', async ({ ext, world }) => {
  await ext.pair();
  await ext.enableIssuer('fake-chase', ORIGINS.chase, false);
  const first = await ext.context.newPage();
  const second = await ext.context.newPage();
  await Promise.all([first.goto(`${ORIGINS.chase}/dashboard`), second.goto(`${ORIGINS.chase}/dashboard`)]);
  const popup = await ext.popup();
  await expect(popup.getByTestId('page-fake-chase')).toHaveCount(2);
  for (const page of await popup.getByTestId('page-fake-chase').all()) await expect(page).toContainText('Card …3391');
  // The second tab's discovery (a new reader) waited out the request spacing the first tab's read left.
  const starts = world.issuers.extensionReads('chase.e3.test').map((request) => request.at);
  expect(starts.length).toBeGreaterThanOrEqual(2);
  for (let i = 1; i < starts.length; i += 1) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(TEST_TARGET.timings.requestIntervalMs - 2);
});

test('an SPA account switch drops the old stream: rows read before are not carried into the new page state', async ({ ext }) => {
  const { bank, popup } = await chaseReady(ext);
  await bank.click('#to-other');
  const block = await account(popup, 'fake-chase', 'Card …3391');
  await expect(block).toContainText('0 posted · 0 pending · 0 not readable · 0 page(s) · not read');
});

test('a read cut short by a navigation leaves nothing behind: the pages it had read never reach the new page state', async ({ ext, world }) => {
  await ext.pair();
  await ext.enableIssuer('fake-chase', ORIGINS.chase, false);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.chase}/dashboard`);
  const popup = await ext.popup();
  const block = await account(popup, 'fake-chase', 'Card …3391');
  world.issuers.controls.chaseVariant = 'slow-second';
  const activityReads = () => world.issuers.extensionReads('chase.e3.test').filter((request) => request.path.endsWith('/activity')).length;
  await block.locator('[data-testid^="read-"]').click();
  // The first page is in; the second is on its way when the page navigates.
  await expect.poll(activityReads).toBe(2);
  await bank.click('#to-other');
  // A fresh discovery of the new page state: its two cards, nothing read.
  const accounts = popup.getByTestId('page-fake-chase').locator('[data-testid^="account-cnd_"]');
  await expect(accounts).toHaveCount(2);
  await bank.waitForTimeout(3_000);
  await expect(accounts).toHaveCount(2);
  for (const item of await accounts.all()) await expect(item).toContainText('0 posted · 0 pending · 0 not readable · 0 page(s) · not read');
});

test('a preview cannot be prepared while a read runs on that page, so the read keeps its issuer lease until it ends', async ({ ext, world }) => {
  const { popup, block } = await chaseReady(ext);
  const discoveries = () => world.issuers.extensionReads('chase.e3.test').filter((request) => request.path === '/fake-api/accounts/list').length;
  const activityReads = () => world.issuers.extensionReads('chase.e3.test').filter((request) => request.path.endsWith('/activity')).length;
  const before = activityReads();
  world.issuers.controls.chaseVariant = 'slow';
  await block.locator('[data-testid^="read-"]').click();
  await expect.poll(activityReads).toBe(before + 1);
  // A second tab of the issuer waits for the lease the running read holds.
  const second = await ext.context.newPage();
  await second.goto(`${ORIGINS.chase}/dashboard`);
  await expect(popup.getByTestId('page-fake-chase')).toHaveCount(2);
  await mapScopes(block, world.holdr.bindingFor('chase'), [
    { select: '[data-testid$="-3391"]', scopeLabel: 'Primary card' },
    { select: '[data-testid$="-7720"]', scopeLabel: 'Authorized user' },
  ]);
  await block.locator('[data-testid^="prepare-"]').click();
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: failed');
  await second.waitForTimeout(1_500);
  // The read still holds the lease: the other tab has not started reading.
  expect(discoveries()).toBe(1);
});

test('a hostile page cannot forge observations, stop the observer, or command the extension', async ({ ext }) => {
  await ext.pair();
  await ext.enableIssuer('fake-amex', ORIGINS.amex, true);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.amex}/activity?hostile=1`);
  const popup = await ext.popup();
  const block = await account(popup, 'fake-amex', 'Card …0003');
  // The real observation still arrives; the forged batch, the forged stop and the oversized message changed nothing.
  await expect(block).toContainText('5 posted · 1 pending');
  await bank.click('#load-more');
  await expect(block).toContainText('6 posted · 1 pending');
  await expect(popup.getByTestId('pause')).toBeVisible();
  const settings = await ext.inExtension(async () => (await chrome.storage.local.get('settings')).settings as { paused: boolean }, null);
  expect(settings.paused).toBe(false);
});

test('a page a stop could not reach stays reported through every later cleanup, until its tab closes', async ({ ext }) => {
  await ext.pair();
  await ext.enableIssuer('fake-chase', ORIGINS.chase, false);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.chase}/dashboard`);
  const popup = await ext.popup();
  await account(popup, 'fake-chase', 'Card …3391');
  // The page navigates away without the worker hearing of it: no stop can reach that document any more.
  await bank.goto(`${ORIGINS.holdr}/`);
  const unconfirmed = async () =>
    ((await ext.inExtension(() => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'get-state' }), null)) as { state: { unreachableCollectors: number } }).state.unreachableCollectors;
  expect(await ext.inExtension(() => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'disable-issuer', adapterId: 'fake-chase' }), null)).toMatchObject({ ok: true });
  await expect(popup.getByText('1 page(s) could not be told to stop')).toBeVisible();
  // The permission removal the disable caused runs the same cleanup again, and a kill switch another: the warning stays.
  await popup.waitForTimeout(1_000);
  expect(await unconfirmed()).toBe(1);
  expect(await ext.inExtension(() => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'set-paused', on: true }), null)).toMatchObject({ ok: true });
  expect(await unconfirmed()).toBe(1);
  expect(await ext.inExtension(() => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'set-paused', on: false }), null)).toMatchObject({ ok: true });
  expect(await unconfirmed()).toBe(1);
  // Closing the tab takes the page with it.
  await bank.close();
  await expect.poll(unconfirmed).toBe(0);
  await expect(popup.getByText('could not be told to stop')).toHaveCount(0);
});

test('a drift report from a page that missed a stop still pauses the contract durably: the issuer is never blocked in memory only', async ({ ext, world }) => {
  await ext.pair();
  await ext.enableIssuer('fake-amex', ORIGINS.amex, true);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.amex}/activity`);
  const popup = await ext.popup();
  await account(popup, 'fake-amex', 'Card …0003');
  // As if an earlier stop had not reached this page: its document is on record as an unconfirmed stop.
  await ext.inExtension(async () => {
    const docs = (await chrome.storage.session.get('collectors')).collectors as Array<{ tabId: number; documentId: string; adapterId: string }>;
    const doc = docs.find((item) => item.adapterId === 'fake-amex')!;
    await chrome.storage.session.set({ unconfirmedStops: [{ tabId: doc.tabId, documentId: doc.documentId, adapterId: doc.adapterId, reason: 'issuer-paused' }] });
  }, null);
  world.issuers.controls.amexUnknownType = true;
  await bank.click('#refresh');
  const options = await ext.options();
  await expect(options.getByTestId('issuer-state-fake-amex')).toContainText('Paused: the site changed what it sends');
  await expect.poll(() => registered(ext)).toEqual([]);
});

test('tracking is bounded: a page that leaves it to make room for a newer one is told to stop first', async ({ ext }) => {
  await ext.pair();
  await ext.enableIssuer('fake-amex', ORIGINS.amex, true);
  const observed = (page: import('@playwright/test').Page) => page.evaluate(() => !Function.prototype.toString.call(window.fetch).includes('[native code]'));
  const tracked = () => ext.inExtension(async () => ((await chrome.storage.session.get('collectors')).collectors as unknown[] | undefined)?.length ?? 0, null);
  const pages: Array<import('@playwright/test').Page> = [];
  for (let index = 0; index < 20; index += 1) {
    const page = await ext.context.newPage();
    await page.goto(`${ORIGINS.amex}/activity`);
    pages.push(page);
  }
  await expect.poll(tracked).toBe(20);
  expect(await observed(pages[0])).toBe(true);
  const newest = await ext.context.newPage();
  await newest.goto(`${ORIGINS.amex}/activity`);
  // The oldest page left tracking: its observer was told to stop (the page has its own fetch back); the newest observes.
  await expect.poll(() => observed(pages[0])).toBe(false);
  expect(await observed(newest)).toBe(true);
  expect(await tracked()).toBe(20);
  expect(((await ext.inExtension(() => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'get-state' }), null)) as { state: { unreachableCollectors: number } }).state.unreachableCollectors).toBe(0);
});