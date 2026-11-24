/**
 * Shape mode (plan §5.1, §9.2 "shape mode 零金融值导出"): for at most ten
 * minutes one issuer's collector and observer are replaced by an observer
 * that records only field names and value types of the page's own
 * responses. The report the owner copies has no value, amount, date, name or
 * token; nothing goes to Holdr; stopping restores the sync scripts. Shape
 * capture is also how an update starts after a contract paused on a site
 * change.
 */
import type { Page } from '@playwright/test';
import { AMEX_ROUTING_KEY, AMEX_SUPPLEMENTARY_NAME, AMEX_TOKEN, CHASE_ACCOUNT_IDS, PAGE_CANARIES } from './fake/issuers.js';
import { expect, ORIGINS, test, type Ext, type World } from './support/harness.js';
import { account, chasePreview } from './support/steps.js';

async function registered(ext: Ext): Promise<string[]> {
  return (await ext.inExtension(async () => (await chrome.scripting.getRegisteredContentScripts()).map((script) => script.id), null)).sort();
}

const REPORT_LINES: readonly RegExp[] = [
  /^(GET|POST) \/[A-Za-z0-9._~:/-]* \([a-z0-9.-]+\)$/,
  /^query: (—|[A-Za-z_<>-][A-Za-z0-9_<>-]*(, [A-Za-z_<>-][A-Za-z0-9_<>-]*)*)$/,
  /^request headers: (—|(?:[a-z][a-z0-9-]*|<dynamic-key>)(, (?:[a-z][a-z0-9-]*|<dynamic-key>))*)$/,
  /^request body:$/,
  /^response:$/,
  /^ {2}\$[A-Za-z0-9_.<>[\]-]*: (string|number|boolean|null|object|array)$/,
  /^\(truncated\)$/,
  /^$/,
];

/** No value of the fake issuers, and no calendar day, appears in `text`. */
function expectNoValues(text: string): void {
  expect(text).not.toMatch(/[0-9]{4}-[0-9]{2}-[0-9]{2}/);
  for (const value of [...PAGE_CANARIES, AMEX_TOKEN, AMEX_SUPPLEMENTARY_NAME, ...CHASE_ACCOUNT_IDS, 'SYNTHETIC', 'MEMBERSHIP', '64.2', '18.5', '12.75', 'XXXX']) {
    expect(text).not.toContain(value);
  }
}

/** Every line of the report is a method/path/contract header, key names, or `path: type`; nothing else can carry a value. */
function expectOnlyNamesAndTypes(text: string): void {
  for (const line of text.split('\n')) expect(REPORT_LINES.some((pattern) => pattern.test(line)), `report line: ${line}`).toBe(true);
  expectNoValues(text);
}

function nothingForHoldr(world: World): void {
  expect(world.holdr.requests.filter((request) => request.path !== '/card-sync/capabilities' && request.path !== '/card-sync/pairings/redeem')).toEqual([]);
}

async function startShape(ext: Ext, adapterId: string): Promise<Page> {
  const options = await ext.options();
  await options.getByTestId(`shape-consent-${adapterId}`).check();
  await options.getByTestId(`shape-start-${adapterId}`).click();
  await expect.poll(() => registered(ext)).toEqual([`holdr-${adapterId}-shape-isolated`, `holdr-${adapterId}-shape-main`]);
  return options;
}

test('shape mode on fake Amex: field names and types only, no values, nothing for Holdr; stopping restores sync', async ({ ext, world }) => {
  await ext.pair();
  await ext.enableIssuer('fake-amex', ORIGINS.amex, true);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.amex}/activity`);
  const popup = await ext.popup();
  await account(popup, 'fake-amex', 'Card …0003');

  await startShape(ext, 'fake-amex');
  // The running collector was told to stop; the page is observed again after a reload. Its feed now also carries a map
  // keyed by routing material: that key is never named, only its confirmed structure.
  world.issuers.controls.amexRoutingMap = true;
  await bank.reload();
  const report = popup.getByTestId('shape-report');
  await expect(report).toContainText('POST /ReadAccountActivity.web.v1 (amex.recent.observe)');
  await expect(report).toContainText('$.transactions[].amount: number');
  await expect(report).toContainText('$.accountToken: string');
  await expect(report).toContainText('$.<dynamic-key>.<dynamic-key>.status: string');
  await expect(report).toContainText('request headers: content-type, ce-source, <dynamic-key>');
  // Well over a hundred entries still make one report.
  await expect(report).toContainText('$.<dynamic-key>.accountToken.view: number');
  const text = (await report.textContent()) ?? '';
  expectOnlyNamesAndTypes(text);
  expect(text).not.toContain('cardsByToken');
  expect(text.toLowerCase()).not.toContain(AMEX_ROUTING_KEY.toLowerCase());
  // What the extension keeps is the same names-and-types report.
  expectNoValues(JSON.stringify(JSON.parse(await ext.storageDump()).session.shape));
  await expect(popup.getByTestId('pages')).not.toContainText('Card …0003');
  nothingForHoldr(world);
  world.issuers.controls.amexRoutingMap = false;

  await popup.getByTestId('shape-stop').click();
  await expect.poll(() => registered(ext)).toEqual(['holdr-fake-amex-isolated', 'holdr-fake-amex-main']);
  await expect(popup.getByTestId('shape')).toHaveCount(0);
  await bank.reload();
  const block = await account(popup, 'fake-amex', 'Card …0003');
  await expect(block).toContainText('5 posted · 1 pending');
  nothingForHoldr(world);
});

test('after a contract paused on a site change, shape capture still records the new form and nothing else runs', async ({ ext, world }) => {
  await ext.pair();
  await ext.enableIssuer('fake-chase', ORIGINS.chase, false);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.chase}/dashboard`);
  const popup = await ext.popup();
  const block = await account(popup, 'fake-chase', 'Card …3391');
  world.issuers.controls.chaseVariant = 'unknown-enum';
  await block.locator('[data-testid^="read-"]').click();
  await expect.poll(() => registered(ext)).toEqual([]);
  const readsBefore = world.issuers.extensionReads('chase.e3.test').length;

  const options = await startShape(ext, 'fake-chase');
  await expect(options.getByTestId('issuer-state-fake-chase')).toContainText('Paused: the site changed what it sends');
  await bank.reload();
  const report = popup.getByTestId('shape-report');
  await expect(report).toContainText('GET /fake-api/accounts/:opaque/activity (chase.activity)');
  await expect(report).toContainText('$.activities[].statusCode: string');
  expectOnlyNamesAndTypes((await report.textContent()) ?? '');
  // Only the page's own requests ran: shape mode never reads.
  expect(world.issuers.extensionReads('chase.e3.test')).toHaveLength(readsBefore);
  nothingForHoldr(world);

  await popup.getByTestId('shape-stop').click();
  // The contract stays paused: stopping shape capture registers nothing.
  await expect.poll(() => registered(ext)).toEqual([]);
});

test('while shape mode runs, nothing of that issuer’s capture goes to Holdr: an accepted capture is planned only after it stops', async ({ ext, world }) => {
  world.holdr.admissionsOpen = true;
  const { popup } = await chasePreview(ext, world);
  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toBeVisible();
  await startShape(ext, 'fake-chase');
  await popup.getByTestId('plan').click();
  await expect(popup.getByTestId('notice')).toContainText('Something else is in progress for this issuer');
  expect(world.holdr.arrivals.filter((line) => line === 'POST /card-sync/imports/preview')).toEqual([]);
  await popup.getByTestId('shape-stop').click();
  await expect.poll(() => registered(ext)).toEqual(['holdr-fake-chase-isolated']);
  await popup.getByTestId('plan').click();
  await expect(popup.getByTestId('plan-summary')).toBeVisible();
});

test('a shape mode that lapsed while the worker was stopped ends at the next start: its page collector is told to stop and normal sync returns', async ({ ext }) => {
  await ext.pair();
  await ext.enableIssuer('fake-amex', ORIGINS.amex, true);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.amex}/activity`);
  const popup = await ext.popup();
  await account(popup, 'fake-amex', 'Card …0003');
  await startShape(ext, 'fake-amex');
  await bank.reload();
  await expect(popup.getByTestId('shape-report')).toContainText('POST /ReadAccountActivity.web.v1 (amex.recent.observe)');
  const collectors = () => ext.inExtension(async () => ((await chrome.storage.session.get('collectors')).collectors as unknown[] | undefined)?.length ?? 0, null);
  expect(await collectors()).toBe(1);
  await popup.close();
  // Shape mode lapses while the worker is stopped (no timer can end it).
  await ext.inExtension(async () => {
    const { shape } = await chrome.storage.session.get('shape');
    await chrome.storage.session.set({ shape: { ...(shape as object), expiresAt: Date.now() - 1 } });
  }, null);
  const { restarted } = await ext.stopWorker();
  const reopened = await ext.popup();
  await restarted;
  await expect(reopened.getByTestId('shape')).toHaveCount(0);
  await expect.poll(() => registered(ext)).toEqual(['holdr-fake-amex-isolated', 'holdr-fake-amex-main']);
  // The shape collector was told to stop and forgotten; the page gets a sync collector again when it reloads.
  expect(await collectors()).toBe(0);
  await bank.reload();
  const block = await account(reopened, 'fake-amex', 'Card …0003');
  await expect(block).toContainText('5 posted · 1 pending');
});

/** Puts `add` in place of the registered `remove`, as if a page loaded those scripts in the moment its issuer's mode changed. */
async function registerInstead(ext: Ext, remove: readonly string[], add: ReadonlyArray<{ id: string; file: string; world: 'ISOLATED' | 'MAIN' }>, origin: string): Promise<void> {
  await ext.inExtension(async ({ ids, scripts, match }) => {
    const present = (await chrome.scripting.getRegisteredContentScripts()).map((script) => script.id).filter((id) => ids.includes(id));
    if (present.length > 0) await chrome.scripting.unregisterContentScripts({ ids: present });
    await chrome.scripting.registerContentScripts(scripts.map((script) => ({
      id: script.id, js: [script.file], matches: [match], runAt: 'document_start' as const, allFrames: false, persistAcrossSessions: false, world: script.world,
    })));
  }, { ids: [...remove], scripts: add.map((script) => ({ ...script })), match: `${origin}/*` });
}

/** True while an observer of this extension has the page's fetch (a stopped observer puts the page's own back). */
function fetchObserved(page: Page): Promise<boolean> {
  return page.evaluate(() => !Function.prototype.toString.call(window.fetch).includes('[native code]'));
}

async function trackedDocs(ext: Ext): Promise<unknown[]> {
  return ext.inExtension(async () => ((await chrome.storage.session.get('collectors')).collectors as unknown[] | undefined) ?? [], null);
}

const AMEX_SHAPE_SCRIPTS = [
  { id: 'holdr-fake-amex-shape-isolated', file: 'shape-isolated.js', world: 'ISOLATED' },
  { id: 'holdr-fake-amex-shape-main', file: 'shape-main-fake-amex.js', world: 'MAIN' },
] as const;
const AMEX_SYNC_SCRIPTS = [
  { id: 'holdr-fake-amex-isolated', file: 'isolated-fake-amex.js', world: 'ISOLATED' },
  { id: 'holdr-fake-amex-main', file: 'main-fake-amex.js', world: 'MAIN' },
] as const;

test('a shape relay that reports after its shape mode ended is told to stop at once and never tracked', async ({ ext }) => {
  await ext.pair();
  await ext.enableIssuer('fake-amex', ORIGINS.amex, true);
  // As if the page got the shape scripts in the moment shape mode was ending.
  await registerInstead(ext, AMEX_SYNC_SCRIPTS.map((script) => script.id), AMEX_SHAPE_SCRIPTS, ORIGINS.amex);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.amex}/activity`);
  // Its shape observer was told to stop: the page has its own fetch back, and the worker tracks no such page.
  await expect.poll(() => fetchObserved(bank)).toBe(false);
  expect(await trackedDocs(ext)).toEqual([]);
  // Control: in a live shape mode the same scripts run and keep observing.
  await startShape(ext, 'fake-amex');
  await bank.reload();
  await expect.poll(() => trackedDocs(ext).then((docs) => docs.length)).toBe(1);
  expect(await fetchObserved(bank)).toBe(true);
});

test('a sync collector that reports while its issuer is in shape mode is told to stop at once and never tracked', async ({ ext }) => {
  await ext.pair();
  await ext.enableIssuer('fake-amex', ORIGINS.amex, true);
  await startShape(ext, 'fake-amex');
  // As if the page got the sync scripts in the moment shape mode was starting.
  await registerInstead(ext, AMEX_SHAPE_SCRIPTS.map((script) => script.id), AMEX_SYNC_SCRIPTS, ORIGINS.amex);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.amex}/activity`);
  await expect.poll(() => fetchObserved(bank)).toBe(false);
  expect(await trackedDocs(ext)).toEqual([]);
  // Control: once shape mode is over, the sync scripts run and keep observing.
  const popup = await ext.popup();
  await popup.getByTestId('shape-stop').click();
  await expect.poll(() => registered(ext)).toEqual(['holdr-fake-amex-isolated', 'holdr-fake-amex-main']);
  await bank.reload();
  await expect.poll(() => trackedDocs(ext).then((docs) => docs.length)).toBe(1);
  expect(await fetchObserved(bank)).toBe(true);
});