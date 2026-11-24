import { test as base, request as apiRequest, type APIRequestContext } from '@playwright/test';

import { apiHeaders } from './authState';
import { expectNoForeignTraffic, watchOrigin, type OriginGuard } from './originGuard';

export { expect } from '@playwright/test';
export type { APIRequestContext, Locator, Page, Route } from '@playwright/test';
export type { OriginGuard, PageRequest } from './originGuard';

/**
 * Tag for tests that mock every data route they touch and need only the Vite
 * page. Everything untagged needs the live API (see requireHealthyApi).
 */
export const MOCKED_API = '@mocked-api';

/**
 * Precondition for tests that need the live API: GET /health must answer 200
 * with ok: true and the signed-in details. An unreachable or unhealthy API
 * throws, so the test FAILS. This write-enabled release suite never treats a
 * failed health check as a reason to skip.
 */
export async function requireHealthyApi(request: APIRequestContext): Promise<void> {
  const response = await request.get('/health').catch((error: Error) => {
    throw new Error(`The API behind WEB_URL is unreachable: ${error.message.split('\n')[0]}`);
  });
  const body = await response.json().catch(() => null) as { ok?: unknown; service?: unknown } | null;
  if (response.status() !== 200 || body?.ok !== true) {
    throw new Error(`The API behind WEB_URL is unhealthy: GET /health answered ${response.status()} ${JSON.stringify(body)}`);
  }
  if (body.service !== 'holdr-api') {
    throw new Error('GET /health answered without the signed-in details: the e2e session is no longer valid');
  }
}

/**
 * Tests that call the API directly use the browser's signed-in session
 * (use.storageState) plus the Origin and X-Holdr-Request headers the API
 * requires on state-changing requests. Browser pages send Origin themselves.
 *
 * In every test the pages may contact only the app's own origin (WEB_URL's):
 * the origin guard (originGuard.ts) is installed, and watches the test's page,
 * before its first navigation. Any traffic to another origin, any attempt at it
 * through a channel the guard switches off, and any other page (a popup) fails
 * the test once it ends. no-third-party.e2e.ts walks every screen under this
 * guard.
 */
export const test = base.extend<{ originGuard: OriginGuard }>({
  request: async ({ baseURL, storageState }, use) => {
    if (!baseURL) throw new Error('baseURL is required');
    const context = await apiRequest.newContext({
      baseURL,
      storageState: storageState ?? undefined,
      extraHTTPHeaders: apiHeaders(baseURL),
    });
    await use(context);
    await context.dispose();
  },
  originGuard: [async ({ context, baseURL }, use) => {
    if (!baseURL) throw new Error('baseURL is required');
    const guard = await watchOrigin(context, baseURL);
    await use(guard);
    await expectNoForeignTraffic(guard);
  }, { auto: true }],
  // The guard watches the test's page from before its first navigation.
  page: async ({ page, originGuard }, use) => {
    await originGuard.watch(page);
    await use(page);
  },
});
