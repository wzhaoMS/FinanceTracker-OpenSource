import { expect, test, type APIRequestContext, type Page, type Route } from './fixtures';

import { AUTH_STATE_FILE, apiHeaders, e2eCredentials } from './authState';

// This file starts from an anonymous browser; every other test reuses the signed-in session.
test.use({ storageState: { cookies: [], origins: [] } });

/** Sign-outs the server has not confirmed yet: records in the browser's sign-out ledger (services/browserCache.ts). */
function pendingSignOuts(page: Page): Promise<number> {
  return page.evaluate(() => Object.keys(localStorage)
    .filter((key) => key.startsWith('finance-tracker:sign-out:') && localStorage.getItem(key)?.startsWith('pending:'))
    .length);
}

/**
 * A gate for the API requests (fetch and XHR to the app's own origin) the page sends from now on.
 * They pass as usual until holdAllBut(path); from then on every one but that path's is held, and
 * stop() drops the held ones: they never reach the server.
 */
async function gateApiRequests(page: Page) {
  const origin = new URL(page.url()).origin;
  const sameOrigin = (url: URL) => url.origin === origin;
  /** The answer to each request let through (null for one that failed). */
  const answers: Promise<unknown>[] = [];
  const held: Route[] = [];
  let onlyPath: string | null = null;
  const gate = (route: Route) => {
    const request = route.request();
    if (!['fetch', 'xhr'].includes(request.resourceType())) return route.fallback();
    if (onlyPath !== null && new URL(request.url()).pathname !== onlyPath) {
      held.push(route);
      return undefined;
    }
    answers.push(request.response());
    return route.fallback();
  };
  await page.route(sameOrigin, gate);
  return {
    /** Holds every later request but `path`'s; resolves once each one let through so far has its answer. */
    holdAllBut: async (path: string) => {
      onlyPath = path;
      await Promise.all(answers);
    },
    /** Drops the held requests and removes the gate; resolves once each request let through has its answer. */
    stop: async () => {
      onlyPath = null;
      await Promise.all(held.splice(0).map((route) => route.abort()));
      await page.unroute(sameOrigin, gate);
      await Promise.all(answers);
    },
  };
}

/** Signs the page in through the form as the e2e user. */
async function signIn(page: Page): Promise<void> {
  const { username, password } = e2eCredentials();
  const form = page.locator('form.login-form');
  await form.getByLabel('Username').fill(username);
  await form.getByLabel('Password').fill(password);
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.user-chip')).toHaveText(username);
}

/**
 * Holds the answer to the page's first `method` request to `path` from now on: the request reaches the
 * server, which handles it, and its answer waits for the test. Later ones pass; sent() counts them all.
 */
async function holdFirstAnswer(page: Page, method: string, path: string) {
  type Held = { route: Route; response: Awaited<ReturnType<Route['fetch']>> };
  let hold!: (held: Held) => void;
  const first = new Promise<Held>((resolve) => { hold = resolve; });
  let sent = 0;
  await page.route((url) => url.pathname === path, async (route) => {
    if (route.request().method() !== method) return route.fallback();
    sent += 1;
    if (sent > 1) return route.fallback();
    hold({ route, response: await route.fetch() });
    return undefined;
  });
  return { first, sent: () => sent };
}

/** A disposable account, made and removed (with its transactions) through `api`. */
function disposableAccount(api: APIRequestContext, name: string) {
  const id = `e2e-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const transactions = async () => ((await (await api.get(`/accounts/${encodeURIComponent(id)}/transactions`)).json()) as {
    transactions: Array<{ id: string; quantity: number }>;
  }).transactions;
  return {
    id,
    transactions,
    create: async () => {
      const created = await api.post('/accounts', { data: { id, name: `E2E ${name}`, type: 'Test', cashBalance: 0, currency: 'USD' } });
      expect(created.status()).toBe(201);
    },
    remove: async () => {
      for (const transaction of await transactions().catch(() => [])) await api.delete(`/transactions/${encodeURIComponent(transaction.id)}`);
      await api.delete(`/accounts/${encodeURIComponent(id)}`);
    },
  };
}

test('Login: app and API stay locked until sign-in; sign-out or any 401 returns to the form', async ({ page }) => {
  const { username, password } = e2eCredentials();
  const form = page.locator('form.login-form');

  // Anonymous: the sign-in form, no dashboard, and no data from the API.
  await page.goto('/');
  await expect(form).toBeVisible();
  // The form says what signing in opens: both modes.
  await expect(form.locator('.login-lede')).toHaveText('Sign in to your household portfolio and spending.');
  await expect(page.locator('.tabs')).toHaveCount(0);
  expect((await page.request.get('/accounts')).status()).toBe(401);
  // Without a session /health has no data: only ok, the schema and this run's e2e identity.
  expect(await (await page.request.get('/health')).json()).toEqual({
    ok: true,
    schemaVersion: expect.any(Number),
    e2e: { runId: process.env.HOLDR_E2E_RUN_ID, disposableDataDir: true },
  });

  // A wrong password gets the generic error and no session.
  await form.getByLabel('Username').fill(username);
  await form.getByLabel('Password').fill(`${password}-wrong`);
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(form.getByRole('alert')).toHaveText('Invalid username or password');
  await expect(page.locator('.tabs')).toHaveCount(0);

  // Signing in shows the dashboard with the user's name; the cookie is HttpOnly and SameSite=Strict.
  await form.getByLabel('Password').fill(password);
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.user-chip')).toHaveText(username);
  await expect(page.locator('.tabs')).toBeVisible();
  const cookie = (await page.context().cookies()).find((entry) => entry.name === 'holdr_session');
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
  expect((await page.request.get('/accounts')).status()).toBe(200);
  // Every API request the reloaded page sends goes through this gate, which knows when the ones sent
  // with the cookie have their answers (see below).
  const apiRequests = await gateApiRequests(page);
  await page.reload();
  await expect(page.locator('.user-chip')).toHaveText(username);
  // The signed-in page caches the user's data in this browser (the 401 below must clear it).
  await expect.poll(() => page.evaluate(() => localStorage.getItem('finance-tracker:state:v2'))).not.toBeNull();

  // The session disappears underneath the page: the next API call's 401 brings back the form.
  // That call is the click's (GET /manual-prices, from the Accounts tab), and no other API request
  // reaches the server without the cookie. The reloaded dashboard can still be loading when the
  // cookie goes (quotes, then a price history per holding), and the first of its requests to arrive
  // without the cookie used to bring the form back before the click, which then waited for a tab that
  // was gone. So the gate holds every other API request from here on, and the cookie goes once each
  // request sent with it has its answer.
  await apiRequests.holdAllBut('/manual-prices');
  await page.context().clearCookies();
  const unauthorized = page.waitForResponse((response) => new URL(response.url()).pathname === '/manual-prices');
  await page.locator('button.tab:has-text("Accounts")').click();
  expect((await unauthorized).status()).toBe(401);
  await expect(form).toBeVisible();
  await expect(page.locator('.login-message')).toHaveText('Your session has ended. Sign in again.');
  expect(await page.evaluate(() => localStorage.getItem('finance-tracker:state:v2'))).toBeNull();
  // The held requests are dropped, and every answer is in before the next sign-in: a 401 arriving
  // after it would end the new session too.
  await apiRequests.stop();

  // Sign in again, then sign out explicitly: the server forgets the session too.
  await form.getByLabel('Username').fill(username);
  await form.getByLabel('Password').fill(password);
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.user-chip')).toHaveText(username);
  const signedIn = (await page.context().cookies()).find((entry) => entry.name === 'holdr_session');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(form).toBeVisible();
  // "Signing out…" disappears only after the server confirmed the session is gone.
  await expect(page.locator('.login-message')).toHaveCount(0);
  expect((await page.request.get('/accounts')).status()).toBe(401);
  const replayed = await page.request.get('/auth/me', { headers: { Cookie: `holdr_session=${signedIn?.value}` } });
  expect(replayed.status()).toBe(401);
  expect(await page.evaluate(() => localStorage.getItem('finance-tracker:state:v2'))).toBeNull();
});

test('Login: a failed sign-out keeps data hidden across reloads and retries until the server confirms', async ({ page }) => {
  const { username, password } = e2eCredentials();
  const form = page.locator('form.login-form');
  const warning = page.locator('.login-warning');
  await page.goto('/');
  await form.getByLabel('Username').fill(username);
  await form.getByLabel('Password').fill(password);
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.user-chip')).toHaveText(username);
  // The sign-out screen also retries by itself every 10 s. The page's clock stands still from here on,
  // so only the reload and the "Retry now" click below retry: no timer can end the sign-out between
  // the steps (the button would then be gone before the click). The clock stops a minute ahead: it may
  // not stop behind the time it shows, which runs on until then.
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 60_000);

  // The proxy answers 502: the dashboard goes away at once, but sign-out is not declared done.
  await page.route('**/auth/logout', (route) => route.fulfill({
    status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Holdr API unreachable' }),
  }));
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(warning).toContainText('Sign-out not confirmed');
  await expect(warning).toContainText('HTTP 502');
  await expect(page.locator('.tabs')).toHaveCount(0);
  // The server session really is still alive, which is why the UI must not claim success.
  expect((await page.request.get('/auth/me')).status()).toBe(200);

  // A reload while the network fails neither signs back in nor skips the revocation.
  await page.unroute('**/auth/logout');
  await page.route('**/auth/logout', (route) => route.abort('failed'));
  await page.reload();
  await expect(warning).toContainText('could not be reached');
  await expect(page.locator('.tabs')).toHaveCount(0);
  await expect(page.locator('.user-chip')).toHaveCount(0);
  expect(await pendingSignOuts(page)).toBe(1);

  // Once the server is reachable, retrying ends the session for real.
  await page.unroute('**/auth/logout');
  await page.getByRole('button', { name: 'Retry now' }).click();
  await expect(warning).toHaveCount(0);
  await expect(form).toBeVisible();
  expect((await page.request.get('/auth/me')).status()).toBe(401);
  expect(await pendingSignOuts(page)).toBe(0);
});

test('Login: an answer to a request sent before the user signed in again cannot sign the new session out', async ({ page, request }) => {
  const { username, password } = e2eCredentials();
  const form = page.locator('form.login-form');
  const signIn = async () => {
    await form.getByLabel('Username').fill(username);
    await form.getByLabel('Password').fill(password);
    await form.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('.user-chip')).toHaveText(username);
  };
  const sessionCookie = async () => (await page.context().cookies()).find((entry) => entry.name === 'holdr_session')?.value;
  // The dashboard's first quote request is held: it gets no answer before the end.
  let hold!: (route: Route) => void;
  const held = new Promise<Route>((resolve) => { hold = resolve; });
  let holding = true;
  await page.route('**/quotes?**', (route) => {
    if (!holding) return route.fallback();
    holding = false;
    hold(route);
    return undefined;
  });
  await page.goto('/');
  await signIn();
  const stale = await held;
  const first = await sessionCookie();

  // The user signs out (the server ends that session), then signs in again.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(form).toBeVisible();
  await expect(page.locator('.login-message')).toHaveCount(0);
  await signIn();
  const second = await sessionCookie();
  expect(second).toBeTruthy();
  expect(second).not.toBe(first);

  // Then the old request gets its answer as the server gives it: a 401 that also clears the cookie of
  // the session it refuses. That 401 no longer counts, but the cookie it would clear now is the new
  // session's.
  const refused = await request.get(stale.request().url(), { headers: { Cookie: `holdr_session=${first}` } });
  expect(refused.status()).toBe(401);
  expect(refused.headers()['set-cookie']).toMatch(/^holdr_session=;.*Max-Age=0/);
  await stale.fulfill({ response: refused });
  await stale.request().response();

  // The new session stays: its cookie in place, and the next request answered.
  expect(await sessionCookie()).toBe(second);
  const prices = page.waitForResponse((response) => new URL(response.url()).pathname === '/manual-prices');
  await page.getByRole('tab', { name: 'Accounts' }).click();
  expect((await prices).status()).toBe(200);
  await expect(page.locator('.user-chip')).toHaveText(username);
  await expect(form).toHaveCount(0);
  // The old request never got there: the new sign-in cancelled it as it began.
  expect(stale.request().failure()?.errorText).toBe('net::ERR_ABORTED');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(form).toBeVisible();
});

/*
 * A write still unanswered when the user signs in again is cancelled with the old session's other requests.
 * Its caller sees the cancellation as a failure: the page must take it without an unhandled error, and
 * without reporting it in the new session. Cancelling stops the browser waiting, not the server: a write it
 * had already accepted stays.
 */
test('Login: an import write a new sign-in cancels ends quietly, and the server may still have kept it', async ({ page, playwright, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`));
  // Set-up and clean-up use the suite's session: this page signs in and out with its own.
  const api = await playwright.request.newContext({ baseURL, storageState: AUTH_STATE_FILE, extraHTTPHeaders: apiHeaders(baseURL!) });
  const account = disposableAccount(api, 'import-cancel');
  try {
    await account.create();
    await page.goto('/');
    await signIn(page);
    await page.getByRole('tab', { name: 'Import', exact: true }).click();
    await page.getByRole('combobox', { name: 'Account', exact: true }).selectOption(account.id);
    await page.getByRole('button', { name: /^Advanced/ }).click();
    await page.getByRole('button', { name: 'Use this sample', exact: true }).click();
    await page.getByRole('button', { name: 'Preview import', exact: true }).click();
    const commit = page.getByRole('button', { name: 'Import 2 transactions', exact: true });
    await expect(commit).toBeVisible();

    // The import's first write reaches the server, which saves it; its answer is held.
    const writes = await holdFirstAnswer(page, 'POST', `/accounts/${encodeURIComponent(account.id)}/transactions`);
    await commit.click();
    const write = await writes.first;
    expect(write.response.status()).toBe(201);
    const saved = ((await write.response.json()) as { id: string }).id;

    // The user signs out, then signs in again while that answer is on its way; the sign-in cancels the write.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.locator('form.login-form')).toBeVisible();
    await signIn(page);
    await expect.poll(() => write.route.request().failure()?.errorText).toBe('net::ERR_ABORTED');
    await write.route.fulfill({ response: write.response });

    // The server kept the write, and the import sent no other.
    expect((await account.transactions()).map((transaction) => transaction.id)).toEqual([saved]);
    expect(writes.sent()).toBe(1);
    // The new session goes on: no write left saving or reported as failed, and no unhandled error.
    await expect(page.locator('.user-chip')).toHaveText(e2eCredentials().username);
    await expect(page.locator('.action-status.saving')).toHaveCount(0);
    await expect(page.locator('.error-toast')).toHaveCount(0);
    expect(errors).toEqual([]);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.locator('form.login-form')).toBeVisible();
  } finally {
    await account.remove();
    await api.dispose();
  }
});

test('Login: an undo a new sign-in cancels ends quietly, and the server may still have applied it', async ({ page, playwright, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`));
  const api = await playwright.request.newContext({ baseURL, storageState: AUTH_STATE_FILE, extraHTTPHeaders: apiHeaders(baseURL!) });
  const account = disposableAccount(api, 'undo-cancel');
  const transactionId = `${account.id}-tx`;
  const symbol = `EU${account.id.replace(/[^A-Za-z0-9]/g, '').slice(-5).toUpperCase()}`;
  const quantity = async () => (await account.transactions()).find((transaction) => transaction.id === transactionId)?.quantity;
  try {
    await account.create();
    const created = await api.post(`/accounts/${encodeURIComponent(account.id)}/transactions`, {
      data: { id: transactionId, symbol, quantity: 2, pricePerUnit: 10, date: new Date().toISOString().slice(0, 10), currency: 'USD' },
    });
    expect(created.status()).toBe(201);
    await page.goto('/');
    await signIn(page);
    await page.getByRole('tab', { name: 'Transactions' }).click();
    await page.getByRole('searchbox', { name: 'Search transactions' }).fill(symbol);
    const row = page.locator('.tx-row').filter({ hasText: symbol });
    await expect(row).toHaveCount(1);
    await row.locator('.tx-row-main').click();
    await row.getByTitle('Edit quantity').click();
    await row.getByLabel('Quantity').fill('3');
    await row.getByLabel('Quantity').press('Enter');
    await expect.poll(quantity).toBe(3);
    await expect(row.locator('.tx-edit-saving')).toHaveCount(0);

    // The undo reaches the server, which applies it; its answer is held.
    const undos = await holdFirstAnswer(page, 'PATCH', `/transactions/${encodeURIComponent(transactionId)}`);
    await row.getByRole('button', { name: 'Undo', exact: true }).click();
    const undo = await undos.first;
    expect(undo.response.status()).toBe(200);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.locator('form.login-form')).toBeVisible();
    await signIn(page);
    await expect.poll(() => undo.route.request().failure()?.errorText).toBe('net::ERR_ABORTED');
    await undo.route.fulfill({ response: undo.response });

    expect(await quantity()).toBe(2);
    expect(undos.sent()).toBe(1);
    await expect(page.locator('.user-chip')).toHaveText(e2eCredentials().username);
    await expect(page.locator('.action-status.saving')).toHaveCount(0);
    await expect(page.locator('.error-toast')).toHaveCount(0);
    expect(errors).toEqual([]);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.locator('form.login-form')).toBeVisible();
  } finally {
    await account.remove();
    await api.dispose();
  }
});
