import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { request, type FullConfig } from '@playwright/test';

import { AUTH_STATE_FILE, apiHeaders, e2eCredentials } from './authState';

/**
 * Runs after global-setup.ts has verified the disposable stack: signs in once
 * as HOLDR_E2E_USER (which scripts/e2e-disposable.mjs creates in the run's data
 * directory with the holdr-user CLI) and saves the session for every test.
 * global-teardown.ts signs it out again.
 *
 * It posts to WEB_URL's /auth/login from Node, through an API request
 * context: no browser and no page, so there is nothing for the origin guard
 * (originGuard.ts) to watch, and nothing but WEB_URL is contacted. The page
 * global-setup.ts loads before it, the app's signed-out sign-in screen, is
 * under the guard.
 */
export default async function signInForTests(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error('playwright.config.ts must set use.baseURL');
  const { username, password } = e2eCredentials();
  const context = await request.newContext({ baseURL, extraHTTPHeaders: apiHeaders(baseURL) });
  try {
    const res = await context.post('/auth/login', { data: { username, password } });
    if (!res.ok()) throw new Error(`E2E sign-in as ${username} failed: ${res.status()} ${await res.text()}`);
    await mkdir(path.dirname(AUTH_STATE_FILE), { recursive: true });
    await context.storageState({ path: AUTH_STATE_FILE });
  } finally {
    await context.dispose();
  }
}
