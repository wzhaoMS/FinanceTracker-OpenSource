/**
 * How reads stop (plan §4.2, §9.2): an issuer page that is signed in but not
 * on its activity view, a repeated cursor, an empty page without an end
 * marker, a signed-out API or a login page instead of JSON, rate limiting,
 * a slow site, a response the adapter's contract does not describe (the
 * contract pauses, in ISOLATED reads and in MAIN observation), and a scope
 * that contradicts a card's last four digits. Nothing here reaches Holdr.
 */
import type { Locator, Page } from '@playwright/test';
import type { ChaseVariant } from './fake/issuers.js';
import { expect, ORIGINS, test, type Ext, type World } from './support/harness.js';
import { account, mapScopes } from './support/steps.js';

async function registered(ext: Ext): Promise<string[]> {
  return (await ext.inExtension(async () => (await chrome.scripting.getRegisteredContentScripts()).map((script) => script.id), null)).sort();
}

function activityReads(world: World): number {
  return world.issuers.extensionReads('chase.e3.test').filter((request) => request.path.endsWith('/activity')).length;
}

/** Pairs, enables fake Chase, opens its dashboard (discovery runs) and switches the site to `variant` before any read. */
async function chaseWith(ext: Ext, world: World, variant: ChaseVariant): Promise<{ bank: Page; popup: Page; block: Locator }> {
  await ext.pair();
  await ext.enableIssuer('fake-chase', ORIGINS.chase, false);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.chase}/dashboard`);
  const popup = await ext.popup();
  const block = await account(popup, 'fake-chase', 'Card …3391');
  world.issuers.controls.chaseVariant = variant;
  return { bank, popup, block };
}

test('signed in, but not on the activity view: the collector waits and reads nothing until the activity page opens', async ({ ext, world }) => {
  await ext.pair();
  await ext.enableIssuer('fake-chase', ORIGINS.chase, false);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.chase}/dashboard?view=summary`);
  const popup = await ext.popup();
  await expect(popup.getByTestId('page-state-fake-chase')).toContainText('Page: other · collector: waiting for the activity page');
  await bank.waitForTimeout(1_000);
  expect(world.issuers.extensionReads('chase.e3.test')).toEqual([]);

  await bank.click('#to-activity');
  await account(popup, 'fake-chase', 'Card …3391');
  expect(world.issuers.extensionReads('chase.e3.test').map((request) => request.path)).toEqual(['/fake-api/accounts/list']);
});

test('a repeated cursor stops the read there: partial coverage, never a third request', async ({ ext, world }) => {
  const { popup, block } = await chaseWith(ext, world, 'repeated-cursor');
  await block.locator('[data-testid^="read-"]').click();
  await expect(block).toContainText('5 posted · 0 pending · 1 not readable · 2 page(s) · partial (repeated-cursor)');
  await expect(popup.getByTestId('page-state-fake-chase')).toContainText('the site repeated a page (partial)');
  expect(activityReads(world)).toBe(2);

  const binding = world.holdr.bindingFor('chase');
  await mapScopes(block, binding, [{ select: '[data-testid$="-3391"]', scopeLabel: 'Primary card' }]);
  await block.locator('[data-testid^="prepare-"]').click();
  await expect(popup.getByTestId('capture-stage')).toHaveText('Stage: preview');
  const payload = JSON.parse((await popup.getByTestId('preview-json').textContent()) ?? '');
  for (const entry of payload.coverage) {
    expect(entry).toMatchObject({ termination: 'repeated-cursor', completeness: 'partial', pageCount: 2 });
  }
  // E1a §10a: coverage for every confirmed scope of the bound account; the ones without rows were read and are empty.
  const primary = binding.scopes.find((scope) => scope.scopeLabel === 'Primary card')!.cardScopeId;
  expect(new Set(payload.coverage.map((entry: { cardScopeId: string }) => entry.cardScopeId))).toEqual(new Set(binding.scopes.map((scope) => scope.cardScopeId)));
  expect(payload.coverage).toHaveLength(binding.scopes.length * 2);
  for (const entry of payload.coverage.filter((item: { cardScopeId: string }) => item.cardScopeId !== primary)) expect(entry.observed).toBeNull();
});

test('an empty page without an end marker stops the read as partial', async ({ ext, world }) => {
  const { block } = await chaseWith(ext, world, 'empty-page');
  await block.locator('[data-testid^="read-"]').click();
  await expect(block).toContainText('4 posted · 0 pending · 1 not readable · 2 page(s) · partial (empty-page)');
  expect(activityReads(world)).toBe(2);
});

test('a signed-out API (401) or a login page instead of JSON: sign-in required, what was read goes, no retries', async ({ ext, world }) => {
  const { bank, popup, block } = await chaseWith(ext, world, 'unauthorized');
  const accounts = popup.getByTestId('page-fake-chase').locator('[data-testid^="account-cnd_"]');
  await block.locator('[data-testid^="read-"]').click();
  await expect(popup.getByTestId('page-state-fake-chase')).toContainText('Page: auth-required');
  await expect(popup.getByTestId('page-state-fake-chase')).toContainText('the site asked you to sign in (sign in yourself)');
  // Signed out: the page's account handles go with that sign-in, and nothing is read again on its own.
  await expect(accounts).toHaveCount(0);
  await popup.waitForTimeout(800);
  expect(activityReads(world)).toBe(1);
  expect(world.issuers.extensionReads('chase.e3.test').filter((request) => request.path === '/fake-api/accounts/list')).toHaveLength(1);

  // A reload starts afresh; a login page in place of JSON is the same sign-out.
  await bank.reload();
  world.issuers.controls.chaseVariant = 'normal';
  const again = await account(popup, 'fake-chase', 'Card …3391');
  world.issuers.controls.chaseVariant = 'login-html';
  await again.locator('[data-testid^="read-"]').click();
  await expect.poll(() => activityReads(world)).toBe(2);
  await expect(popup.getByTestId('page-state-fake-chase')).toContainText('the site asked you to sign in (sign in yourself)');
  await expect(accounts).toHaveCount(0);
  await popup.waitForTimeout(500);
  expect(activityReads(world)).toBe(2);
  expect(world.holdr.requests.filter((request) => request.path !== '/card-sync/capabilities' && request.path !== '/card-sync/pairings/redeem')).toEqual([]);
});

test('a sign-out in place after a read: the rows read before go and cannot be built; signing in again starts afresh', async ({ ext, world }) => {
  const { bank, popup, block } = await chaseWith(ext, world, 'normal');
  await block.locator('[data-testid^="read-"]').click();
  await expect(block).toContainText('7 posted · 1 pending');
  const accounts = popup.getByTestId('page-fake-chase').locator('[data-testid^="account-cnd_"]');
  // The page turns into its sign-in view at the same address.
  await bank.click('#sign-out-in-place');
  await expect(popup.getByTestId('page-state-fake-chase')).toContainText('Page: auth-required');
  await expect(accounts).toHaveCount(0);
  // Signing in again (the activity view after the sign-in view) is a fresh page state: discovered anew, nothing read.
  await bank.click('#sign-in-in-place');
  const fresh = await account(popup, 'fake-chase', 'Card …3391');
  await expect(fresh).toContainText('0 posted · 0 pending · 0 not readable · 0 page(s) · not read');
});

test('signed out between two pages of one read: the first page goes with the sign-in, nothing can be built from it', async ({ ext, world }) => {
  const { popup, block } = await chaseWith(ext, world, 'unauthorized-second');
  const accounts = popup.getByTestId('page-fake-chase').locator('[data-testid^="account-cnd_"]');
  await block.locator('[data-testid^="read-"]').click();
  await expect(popup.getByTestId('page-state-fake-chase')).toContainText('Page: auth-required');
  await expect(accounts).toHaveCount(0);
  expect(activityReads(world)).toBe(2);
});

test('rate limited (429): the read stops and this issuer is not read again during the pause', async ({ ext, world }) => {
  const { popup, block } = await chaseWith(ext, world, 'rate-limited');
  await block.locator('[data-testid^="read-"]').click();
  await expect(popup.getByTestId('page-state-fake-chase')).toContainText('the site is limiting requests; try later');
  expect(activityReads(world)).toBe(1);

  world.issuers.controls.chaseVariant = 'normal';
  await block.locator('[data-testid^="read-"]').click();
  await expect(popup.getByTestId('notice')).toContainText('The site asked to slow down');
  await popup.waitForTimeout(500);
  expect(activityReads(world)).toBe(1);
  const options = await ext.options();
  await expect(options.getByTestId('issuer-fake-chase')).toContainText('Paused after the site limited requests');
});

test('a slow site: the request times out after the budget and nothing is kept', async ({ ext, world }) => {
  const { popup, block } = await chaseWith(ext, world, 'slow');
  await block.locator('[data-testid^="read-"]').click();
  await expect(popup.getByTestId('page-state-fake-chase')).toContainText('the site did not answer in time', { timeout: 10_000 });
  await expect(block).toContainText('not read');
  expect(activityReads(world)).toBe(1);
});

test('an unknown enum in an isolated read pauses the contract: nothing kept, scripts gone, no re-enabling until an update, shape capture still offered', async ({ ext, world }) => {
  const { popup, block } = await chaseWith(ext, world, 'unknown-enum');
  expect(await registered(ext)).toEqual(['holdr-fake-chase-isolated']);
  await block.locator('[data-testid^="read-"]').click();
  await expect.poll(() => registered(ext)).toEqual([]);
  await expect(popup.getByTestId('pages')).toContainText('No enabled issuer page is open');

  const options = await ext.options();
  await expect(options.getByTestId('issuer-state-fake-chase')).toContainText('Paused: the site changed what it sends');
  await options.getByTestId('risk-fake-chase').check();
  await expect(options.getByTestId('enable-fake-chase')).toBeDisabled();
  await expect(options.getByTestId('shape-start-fake-chase')).toBeVisible();
  const reply = await ext.inExtension(
    () => chrome.runtime.sendMessage({ type: 'ui-command/v1', command: 'enable-issuer', adapterId: 'fake-chase', riskAccepted: true, mainPassiveAccepted: false }),
    null,
  );
  expect(reply).toMatchObject({ ok: false, code: 'shape-changed' });
  // The site permission stays, so shape capture can record the new form.
  expect(await ext.inExtension((origin) => chrome.permissions.contains({ origins: [origin] }), `${ORIGINS.chase}/*`)).toBe(true);
  expect(world.holdr.observations.size).toBe(0);
});

test('a signed amount where the contract sends a magnitude and a direction pauses the contract too', async ({ ext, world }) => {
  const { block } = await chaseWith(ext, world, 'negative-amount');
  await block.locator('[data-testid^="read-"]').click();
  await expect.poll(() => registered(ext)).toEqual([]);
  const options = await ext.options();
  await expect(options.getByTestId('issuer-state-fake-chase')).toContainText('Paused: the site changed what it sends');
  expect(world.holdr.observations.size).toBe(0);
});

test('an unknown transaction type observed in MAIN pauses the contract the same way', async ({ ext, world }) => {
  world.issuers.controls.amexUnknownType = true;
  await ext.pair();
  await ext.enableIssuer('fake-amex', ORIGINS.amex, true);
  expect(await registered(ext)).toEqual(['holdr-fake-amex-isolated', 'holdr-fake-amex-main']);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.amex}/activity`);
  await expect.poll(() => registered(ext)).toEqual([]);
  const options = await ext.options();
  await expect(options.getByTestId('issuer-state-fake-amex')).toContainText('Paused: the site changed what it sends');
  expect(world.holdr.observations.size).toBe(0);
});

test('a scope that contradicts a card’s last four digits is refused before anything is built', async ({ ext, world }) => {
  const { popup, block } = await chaseWith(ext, world, 'normal');
  await block.locator('[data-testid^="read-"]').click();
  await expect(block).toContainText('7 posted · 1 pending');
  await mapScopes(block, world.holdr.bindingFor('chase'), [
    { select: '[data-testid$="-3391"]', scopeLabel: 'Authorized user' },
    { select: '[data-testid$="-7720"]', scopeLabel: 'Primary card' },
  ]);
  await block.locator('[data-testid^="prepare-"]').click();
  await expect(popup.getByTestId('notice')).toContainText('do not match the Holdr card you chose');
  await expect(popup.getByTestId('capture-stage')).toHaveCount(0);
  expect(world.holdr.requests.filter((request) => request.path !== '/card-sync/capabilities' && request.path !== '/card-sync/pairings/redeem')).toEqual([]);
});
