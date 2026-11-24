/**
 * Passive modes end to end: MAIN observation of the page's own fetch through
 * a cross-origin wrapper (fake Amex) and of XHR with a string continuation
 * flag and a cache-only "load more" (fake Citi), and rendered-DOM reading
 * of a virtual list (fake Wells Fargo).
 */
import { AMEX_SUPPLEMENTARY_NAME, AMEX_TOKEN, CITI_ACCOUNT_ID, CITI_NAMES, CITI_OTHER_ACCOUNT_ID, PAGE_CANARIES, WF_ACCOUNT_KEY } from './fake/issuers.js';
import { expect, ORIGINS, test } from './support/harness.js';
import { account, mapScopes, prepare } from './support/steps.js';

test('fake Amex (MAIN passive): page fetch observed, manual paging merged, re-observation dropped, holder groups mapped', async ({ ext, world }) => {
  await ext.pair();
  await ext.enableIssuer('fake-amex', ORIGINS.amex, true);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.amex}/activity`);
  const popup = await ext.popup();
  const block = await account(popup, 'fake-amex', 'Card …0003');
  await expect(block).toContainText('5 posted · 1 pending · 0 not readable · 1 page(s) · partial (more-available)');

  // Manual paging: the page's own "load more" is a second observed response.
  await bank.click('#load-more');
  await expect(block).toContainText('6 posted · 1 pending · 0 not readable · 2 page(s) · unknown (end-marker)');
  // The page refetching the first page is a re-observation, not new rows.
  await bank.click('#refresh');
  await expect.poll(() => bank.locator('#activity-app').getAttribute('data-loaded')).toBe('3');
  await bank.waitForTimeout(500);
  await expect(block).toContainText('6 posted · 1 pending · 0 not readable · 2 page(s) · unknown (end-marker)');

  await mapScopes(block, world.holdr.bindingFor('amex'), [
    { select: '[data-testid$="-0003"]', scopeLabel: 'Basic card' },
    { select: '[data-testid$="-3382"]', scopeLabel: 'Supplementary card' },
  ]);
  const text = await prepare(block, popup);
  const payload = JSON.parse(text);
  expect(payload.source).toBe('amex-api-recent');
  expect(payload.mode).toBe('main-passive');
  expect(payload.rows).toHaveLength(7);
  expect(payload.rows.every((row: { externalIdHash: string | null; identityNamespace: string }) => row.externalIdHash === null && row.identityNamespace === 'amex-api-recent:capture:v1')).toBe(true);
  // Two identical purchases stay two rows, told apart by occurrence.
  const bookshop = payload.rows.filter((row: { description: string }) => row.description === 'SYNTHETIC BOOKSHOP');
  expect(bookshop).toHaveLength(2);
  expect(bookshop[0].fingerprint).not.toBe(bookshop[1].fingerprint);
  expect(payload.rows.find((row: { kind: string }) => row.kind === 'refund').amountMinor).toBe(-3000);
  expect(payload.coverage.every((entry: { completeness: string; termination: string; pageCount: number; requested: unknown }) => entry.completeness === 'unknown' && entry.termination === 'end-marker' && entry.pageCount === 2 && entry.requested === null)).toBe(true);

  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toContainText('needs-review');
  expect(world.holdr.observationBodies()[0].startsWith(`{"payload":${text},"runId":"run_`)).toBe(true);

  const everything = [await ext.storageDump(), ...world.holdr.requests.map((request) => request.body), ext.consoleLines.join('\n')].join('\n');
  for (const canary of [AMEX_TOKEN, AMEX_SUPPLEMENTARY_NAME, ...PAGE_CANARIES]) expect(everything).not.toContain(canary);
  expect(world.gate.leaks()).toEqual([]);
});

test('fake Citi (MAIN passive XHR): string continuation flag, cache-only "load more" claims nothing, name-only holder groups', async ({ ext, world }) => {
  world.holdr.admissionsOpen = true;
  await ext.pair();
  await ext.enableIssuer('fake-citi', ORIGINS.citi, true);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.citi}/accounts`);
  const popup = await ext.popup();
  const block = await account(popup, 'fake-citi', 'Card …8812');
  await expect(block).toContainText('3 posted · 1 pending · 0 not readable · 1 page(s) · partial (more-available)');

  const retrievals = () => world.issuers.requests.filter((request) => request.path.endsWith('/transactions/retrieve')).length;
  const before = retrievals();
  await bank.click('#show-cached');
  await bank.waitForTimeout(800);
  expect(retrievals()).toBe(before);
  await expect(block).toContainText('3 posted · 1 pending · 0 not readable · 1 page(s) · partial (more-available)');

  await bank.click('#load-more');
  await expect(block).toContainText('4 posted · 1 pending · 0 not readable · 2 page(s) · unknown (end-marker)');

  await mapScopes(block, world.holdr.bindingFor('citi'), [
    { select: '[data-testid$="-0-none"]', scopeLabel: 'Primary cardholder' },
    { select: '[data-testid$="-1-none"]', scopeLabel: 'Authorized user' },
  ]);
  const text = await prepare(block, popup);
  const payload = JSON.parse(text);
  expect(payload.rows).toHaveLength(5);
  expect(payload.rows.every((row: { identityNamespace: string; externalIdHash: string | null }) => row.identityNamespace === 'citi-api:transaction:v1' && row.externalIdHash !== null)).toBe(true);
  expect(payload.rows.find((row: { kind: string }) => row.kind === 'payment').amountMinor).toBe(-50000);
  const pending = payload.rows.find((row: { status: string }) => row.status === 'pending');
  expect(pending.postedDate).toBeNull();

  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toContainText('accepted-uncommitted');
  await popup.getByTestId('plan').click();
  await expect(popup.getByTestId('plan-summary')).toContainText('5 new');
  await popup.getByTestId('commit').click();
  await expect(popup.getByTestId('committed')).toBeVisible();

  const everything = [await ext.storageDump(), ...world.holdr.requests.map((request) => request.body), ext.consoleLines.join('\n')].join('\n');
  for (const canary of [CITI_ACCOUNT_ID, ...CITI_NAMES]) expect(everything).not.toContain(canary);
});

test('a page request redirected to another account’s path is not observed: nothing lands on the account the page asked for', async ({ ext, world }) => {
  world.issuers.controls.citiRedirect = true;
  await ext.pair();
  await ext.enableIssuer('fake-citi', ORIGINS.citi, true);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.citi}/accounts`);
  // The page itself followed the redirect (same origin, a path the contract allows) and shows the other account's row.
  await expect(bank.locator('#rows')).toContainText('SYNTHETIC OTHER ACCOUNT');
  expect(world.issuers.requests.some((request) => request.path === `/gcg-fake/v1/accounts/${CITI_OTHER_ACCOUNT_ID}/transactions/retrieve`)).toBe(true);
  const popup = await ext.popup();
  const block = await account(popup, 'fake-citi', 'Card …8812');
  await popup.waitForTimeout(800);
  await expect(block).toContainText('0 posted · 0 pending');
});

test('an SPA account switch on a MAIN-passive page drops what was observed before, also with cached rows and no request', async ({ ext, world }) => {
  await ext.pair();
  await ext.enableIssuer('fake-citi', ORIGINS.citi, true);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.citi}/accounts`);
  const popup = await ext.popup();
  await expect(await account(popup, 'fake-citi', 'Card …8812')).toContainText('3 posted · 1 pending');
  const page = popup.getByTestId('page-fake-citi');
  const accounts = page.locator('[data-testid^="account-cnd_"]');

  // A request begins on the first account's page and is answered after the switch, which itself asks for nothing.
  world.issuers.controls.citiDelayMs = 1_500;
  await bank.click('#load-more');
  await bank.click('#to-other');
  await expect(accounts).toHaveCount(0);
  await expect(page).toContainText('you navigated; earlier rows were dropped');
  // The late answer reaches the page and is not taken: it answers a request of the page left behind.
  await expect(bank.locator('#rows')).toContainText('SYNTHETIC FUEL');
  await popup.waitForTimeout(800);
  await expect(accounts).toHaveCount(0);

  // What the page asks for after the switch is observed again.
  world.issuers.controls.citiDelayMs = 0;
  await bank.click('#load-more');
  await expect(accounts).toHaveCount(1);
  await expect(accounts.first()).toContainText('1 posted · 0 pending');
});

test('a cached account switch there and back on a MAIN-passive page: what the page asks for afterwards is observed', async ({ ext }) => {
  await ext.pair();
  await ext.enableIssuer('fake-citi', ORIGINS.citi, true);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.citi}/accounts`);
  const popup = await ext.popup();
  await expect(await account(popup, 'fake-citi', 'Card …8812')).toContainText('3 posted · 1 pending');
  const accounts = popup.getByTestId('page-fake-citi').locator('[data-testid^="account-cnd_"]');
  // Away and back without a response in between: the observer saw neither switch, the collector reset at both.
  await bank.click('#to-other');
  await expect(accounts).toHaveCount(0);
  await bank.click('#to-main');
  await bank.waitForTimeout(500);
  await bank.click('#load-more');
  await expect(accounts).toHaveCount(1);
  await expect(accounts.first()).toContainText('1 posted · 0 pending');
});

test('a request the page makes right after its URL changes belongs to the new page and is observed', async ({ ext }) => {
  await ext.pair();
  await ext.enableIssuer('fake-citi', ORIGINS.citi, true);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.citi}/accounts`);
  const popup = await ext.popup();
  await expect(await account(popup, 'fake-citi', 'Card …8812')).toContainText('3 posted · 1 pending');
  const accounts = popup.getByTestId('page-fake-citi').locator('[data-testid^="account-cnd_"]');
  // pushState and the new page's request in one task: the observer starts the new page's stream at the request, before
  // the collector's reset retires the old one; that reset must not drop the new page's answer.
  await bank.click('#switch-and-load');
  await expect(bank.locator('#rows')).toContainText('SYNTHETIC FUEL');
  await expect(accounts).toHaveCount(1);
  await expect(accounts.first()).toContainText('1 posted · 0 pending');
});

test('an answer to a request begun before route changes there and back is not taken, even with nothing observed between them', async ({ ext, world }) => {
  await ext.pair();
  await ext.enableIssuer('fake-citi', ORIGINS.citi, true);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.citi}/accounts`);
  const popup = await ext.popup();
  await expect(await account(popup, 'fake-citi', 'Card …8812')).toContainText('3 posted · 1 pending');
  const accounts = popup.getByTestId('page-fake-citi').locator('[data-testid^="account-cnd_"]');
  await bank.click('#to-other');
  await expect(accounts).toHaveCount(0);
  // A request on this page, answered only after the page went away and came back.
  const answers = async () => Number((await bank.locator('#citi-app').getAttribute('data-answers')) ?? 0);
  const before = await answers();
  world.issuers.controls.citiDelayMs = 4_000;
  await bank.click('#load-more');
  await bank.click('#to-main');
  await bank.click('#to-other');
  // The page went away and came back while its request was still unanswered.
  expect(await answers()).toBe(before);
  await expect.poll(answers, { timeout: 10_000 }).toBe(before + 1);
  await popup.waitForTimeout(800);
  await expect(accounts).toHaveCount(0);
  // A request made now is observed.
  world.issuers.controls.citiDelayMs = 0;
  await bank.click('#load-more');
  await expect(accounts).toHaveCount(1);
  await expect(accounts.first()).toContainText('1 posted · 0 pending');
});

test('an XHR opened again after an abort: the earlier request never reads the later answer', async ({ ext }) => {
  await ext.pair();
  await ext.enableIssuer('fake-citi', ORIGINS.citi, true);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.citi}/accounts`);
  const popup = await ext.popup();
  const block = await account(popup, 'fake-citi', 'Card …8812');
  await expect(block).toContainText('3 posted · 1 pending · 0 not readable · 1 page(s) · partial (more-available)');
  // The aborted page-2 request's bookkeeping must not take the page-1 answer of the reused XHR as page 2.
  await bank.click('#reuse-xhr');
  await expect(bank.locator('#citi-app')).toHaveAttribute('data-reused', 'true');
  await popup.waitForTimeout(800);
  await expect(block).toContainText('3 posted · 1 pending · 0 not readable · 1 page(s) · partial (more-available)');
});

test('fake Wells Fargo (rendered DOM): virtual list accumulated by row index, deposit table ignored, unreadable row counted', async ({ ext, world }) => {
  await ext.pair();
  await ext.enableIssuer('fake-wf', ORIGINS.wf, false);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.wf}/activity`);
  const popup = await ext.popup();
  const block = await account(popup, 'fake-wf', 'Card …4417');
  await expect(block).toContainText('3 posted · 2 pending · 1 not readable · 1 page(s) · partial (more-available)');

  // Scrolling unmounts rows 1–4 and mounts 7–10; unmounted rows are not deletions. A snapshot claims at most `unknown`.
  await bank.click('#scroll-down');
  await expect(block).toContainText('7 posted · 2 pending · 1 not readable · 1 page(s) · unknown (snapshot)');

  await mapScopes(block, world.holdr.bindingFor('wellsfargo'), [{ select: '[data-testid$="-0-none"]', scopeLabel: 'Card' }]);
  const text = await prepare(block, popup);
  const payload = JSON.parse(text);
  expect(payload.rows).toHaveLength(9);
  expect(text).not.toContain('DEPOSIT ACCOUNT ROW');
  expect(text).not.toContain('SYNTHETIC BAD ROW');
  expect(payload.rejectedCount).toBe(1);
  expect(payload.rows.every((row: { kind: string; identityNamespace: string }) => row.kind === 'other' && row.identityNamespace === 'wf-dom:capture:v1')).toBe(true);
  expect(payload.rows.find((row: { description: string }) => row.description === 'ONLINE PAYMENT THANK YOU').amountMinor).toBe(-120000);

  await popup.getByTestId('send').click();
  await expect(popup.getByTestId('accepted')).toContainText('needs-review');
  const everything = [await ext.storageDump(), ...world.holdr.requests.map((request) => request.body)].join('\n');
  expect(everything).not.toContain(WF_ACCOUNT_KEY);
  // A DOM-only adapter makes no request of its own.
  expect(world.issuers.extensionReads('wf.e3.test')).toEqual([]);
});

test('a passive page whose own data arrives before DOMContentLoaded is tracked from its first message and keeps collecting', async ({ ext, world }) => {
  await ext.pair();
  await ext.enableIssuer('fake-amex', ORIGINS.amex, true);
  const bank = await ext.context.newPage();
  // The page's own request answers while a slow script still holds the parser.
  await bank.goto(`${ORIGINS.amex}/activity?slowParse=1`);
  const popup = await ext.popup();
  const block = await account(popup, 'fake-amex', 'Card …0003');
  await expect(block).toContainText('5 posted · 1 pending');
  // Its next page carries the very candidate the first one did, so the merge takes it and a preview can be prepared.
  await bank.click('#load-more');
  await expect(block).toContainText('6 posted · 1 pending');
  await mapScopes(block, world.holdr.bindingFor('amex'), [
    { select: '[data-testid$="-0003"]', scopeLabel: 'Basic card' },
    { select: '[data-testid$="-3382"]', scopeLabel: 'Supplementary card' },
  ]);
  const text = await prepare(block, popup);
  expect(JSON.parse(text).rows).toHaveLength(7);
});

test('an XHR opened again in its own load handler: both of its requests are observed', async ({ ext }) => {
  await ext.pair();
  await ext.enableIssuer('fake-citi', ORIGINS.citi, true);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.citi}/accounts?chain=1`);
  await expect(bank.locator('#citi-app')).toHaveAttribute('data-chained', 'true');
  const popup = await ext.popup();
  const block = await account(popup, 'fake-citi', 'Card …8812');
  await expect(block).toContainText('4 posted · 1 pending · 0 not readable · 2 page(s) · unknown (end-marker)');
});

test('a sign-out in place on a MAIN-passive page: what was observed goes, and an answer to a request begun before it is never taken', async ({ ext, world }) => {
  await ext.pair();
  await ext.enableIssuer('fake-citi', ORIGINS.citi, true);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.citi}/accounts`);
  const popup = await ext.popup();
  await expect(await account(popup, 'fake-citi', 'Card …8812')).toContainText('3 posted · 1 pending');
  const accounts = popup.getByTestId('page-fake-citi').locator('[data-testid^="account-cnd_"]');
  const answers = async () => Number((await bank.locator('#citi-app').getAttribute('data-answers')) ?? 0);
  const before = await answers();
  world.issuers.controls.citiDelayMs = 4_000;
  await bank.click('#load-more');
  await bank.click('#sign-out-in-place');
  await expect(popup.getByTestId('page-state-fake-citi')).toContainText('Page: auth-required');
  await expect(accounts).toHaveCount(0);
  // Signed in again before the answer to the request begun under the earlier sign-in arrives: it is still not taken.
  await bank.click('#sign-in-in-place');
  expect(await answers()).toBe(before);
  await expect.poll(answers, { timeout: 10_000 }).toBe(before + 1);
  await popup.waitForTimeout(800);
  await expect(accounts).toHaveCount(0);
  // What the page asks for under the new sign-in is observed.
  world.issuers.controls.citiDelayMs = 0;
  await bank.click('#load-more');
  await expect(accounts).toHaveCount(1);
  await expect(accounts.first()).toContainText('1 posted · 0 pending');
});

test('signed in again in place and loading at once: the new sign-in\'s first answer is taken, not lost to the sign-out', async ({ ext }) => {
  await ext.pair();
  await ext.enableIssuer('fake-citi', ORIGINS.citi, true);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.citi}/accounts`);
  const popup = await ext.popup();
  await expect(await account(popup, 'fake-citi', 'Card …8812')).toContainText('3 posted · 1 pending');
  const accounts = popup.getByTestId('page-fake-citi').locator('[data-testid^="account-cnd_"]');
  await bank.click('#sign-out-in-place');
  await expect(popup.getByTestId('page-state-fake-citi')).toContainText('Page: auth-required');
  await expect(accounts).toHaveCount(0);
  // The activity view returns and its request goes out in the same click, before the collector's next look.
  await bank.click('#sign-in-and-load');
  await expect(accounts).toHaveCount(1);
  await expect(accounts.first()).toContainText('1 posted · 0 pending');
});

test('a new sign-in whose page loads while it still shows its sign-in view: those answers wait, and all are taken once the activity shows', async ({ ext }) => {
  await ext.pair();
  await ext.enableIssuer('fake-citi', ORIGINS.citi, true);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.citi}/accounts`);
  const popup = await ext.popup();
  await expect(await account(popup, 'fake-citi', 'Card …8812')).toContainText('3 posted · 1 pending');
  const accounts = popup.getByTestId('page-fake-citi').locator('[data-testid^="account-cnd_"]');
  const answers = async () => Number((await bank.locator('#citi-app').getAttribute('data-answers')) ?? 0);
  await bank.click('#sign-out-in-place');
  await expect(popup.getByTestId('page-state-fake-citi')).toContainText('Page: auth-required');
  await expect(accounts).toHaveCount(0);
  const before = await answers();
  await bank.click('#load-3-pages');
  await expect.poll(answers).toBe(before + 3);
  // Still the sign-in view: nothing is taken yet.
  await popup.waitForTimeout(800);
  await expect(popup.getByTestId('page-state-fake-citi')).toContainText('Page: auth-required');
  await expect(accounts).toHaveCount(0);
  await bank.click('#sign-in-in-place');
  await expect(accounts).toHaveCount(1);
  await expect(accounts.first()).toContainText('3 posted · 0 pending');
});

test('more answers while it still shows its sign-in view than can wait: none is taken, nothing can be built, the page says to reload; a new sign-out starts afresh', async ({ ext }) => {
  await ext.pair();
  await ext.enableIssuer('fake-citi', ORIGINS.citi, true);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.citi}/accounts`);
  const popup = await ext.popup();
  await expect(await account(popup, 'fake-citi', 'Card …8812')).toContainText('3 posted · 1 pending');
  const accounts = popup.getByTestId('page-fake-citi').locator('[data-testid^="account-cnd_"]');
  const pageState = popup.getByTestId('page-state-fake-citi');
  const answers = async () => Number((await bank.locator('#citi-app').getAttribute('data-answers')) ?? 0);
  await bank.click('#sign-out-in-place');
  await expect(pageState).toContainText('Page: auth-required');
  await expect(accounts).toHaveCount(0);
  const before = await answers();
  // Nine pages answer while the page shows its sign-in view; at most eight wait. The observer has marked all nine as
  // seen, so one would be gone for good: none is kept rather than a collection with a hole in it.
  await bank.click('#load-9-pages');
  await expect.poll(answers).toBe(before + 9);
  await expect(pageState).toContainText('reload the page');
  await bank.click('#sign-in-in-place');
  await expect(pageState).toContainText('Page: activity');
  await expect(pageState).toContainText('reload the page');
  await popup.waitForTimeout(800);
  await expect(accounts).toHaveCount(0);
  // A new sign-out and sign-in start afresh (the observer starts a new stream, so its pages are new again).
  await bank.click('#sign-out-in-place');
  await expect(pageState).toContainText('Page: auth-required');
  await bank.click('#sign-in-and-load');
  await expect(accounts).toHaveCount(1);
  await expect(accounts.first()).toContainText('1 posted · 0 pending');
});

test('leaving a page (pagehide, as for the back/forward cache) stops its observer and collector for good', async ({ ext }) => {
  await ext.pair();
  await ext.enableIssuer('fake-amex', ORIGINS.amex, true);
  const bank = await ext.context.newPage();
  await bank.goto(`${ORIGINS.amex}/activity`);
  const popup = await ext.popup();
  await account(popup, 'fake-amex', 'Card …0003');
  const observed = () => bank.evaluate(() => !Function.prototype.toString.call(window.fetch).includes('[native code]'));
  expect(await observed()).toBe(true);
  await bank.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect.poll(observed).toBe(false);
  await expect(popup.getByTestId('pages')).toContainText('stopped');
});