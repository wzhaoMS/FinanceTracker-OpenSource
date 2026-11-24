import { chromium, type FullConfig } from '@playwright/test';

import { guardedBrowserArgs, watchOrigin } from './originGuard';
import { verifyRunIdentity } from './stack-identity';

/** Requests the app sends to its API as soon as it loads (signed out, the first is /auth/me). */
const BOOT_API_PATHS = ['/auth/me', '/health', '/accounts', '/transactions'];

/**
 * The write-enabled suite may only run against the disposable stack that
 * scripts/e2e-disposable.mjs started for this run. Before any test:
 *   1. the API behind WEB_URL, asked through WEB_URL, must report this run's
 *      HOLDR_E2E_RUN_ID and a disposable data directory (stack-identity.ts);
 *   2. the app at WEB_URL must send its API requests to WEB_URL's origin, so
 *      the browser reaches that same verified API. A VITE_API_BASE
 *      (environment or apps/web .env file) or a non-loopback WEB_URL host,
 *      for which the app calls that host's :4000, would send them elsewhere.
 *      Requests to any other origin are aborted, never sent, and the page is
 *      under the origin guard (originGuard.ts): any traffic to another origin
 *      stops the run as well.
 * Whatever cannot be verified, a page that does not load included, stops
 * the run before a single test writes.
 */
export default async function verifyDisposableStack(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error('WEB_URL is not set');
  await verifyRunIdentity(baseURL, process.env.HOLDR_E2E_RUN_ID);
  await assertSameOriginApi(baseURL);
}

export async function assertSameOriginApi(baseURL: string): Promise<void> {
  const origin = new URL(baseURL).origin;
  const refuse = (reason: string) => new Error(`Refusing to run the write-enabled e2e suite against ${origin}: ${reason}`);
  const browser = await chromium.launch({ args: guardedBrowserArgs(baseURL) });
  try {
    const context = await browser.newContext();
    // Every page a run opens is under the origin guard, this one included.
    const guard = await watchOrigin(context, baseURL);
    const page = await context.newPage();
    await guard.watch(page);
    await page.route('**/*', (route) => (
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient')
    ));
    const firstApiRequest = page.waitForRequest(
      (request) => BOOT_API_PATHS.some((apiPath) => new URL(request.url()).pathname.endsWith(apiPath)),
      { timeout: 15_000 },
    );
    firstApiRequest.catch(() => undefined); // awaited below unless navigation fails first
    try {
      await page.goto(baseURL);
    } catch (error) {
      throw refuse(`the app could not be loaded (${(error as Error).message.split('\n')[0]}), so where it sends its API requests is unknown.`);
    }
    const apiRequest = await firstApiRequest.catch(() => {
      throw refuse('the app sent no API request within 15s, so its API origin is unknown.');
    });
    const apiOrigin = new URL(apiRequest.url()).origin;
    if (apiOrigin !== origin) {
      throw refuse(
        `the app sends its API requests to ${apiOrigin}, not to WEB_URL. Unset VITE_API_BASE `
        + '(environment and apps/web .env files) and use a loopback WEB_URL; npm run test:e2e (scripts/e2e-disposable.mjs) does both.',
      );
    }
    await guard.settled();
    if (guard.foreign.length > 0) {
      throw refuse(`the app contacted another origin (the origin guard refused it): ${guard.foreign.join(', ')}`);
    }
  } finally {
    await browser.close();
  }
}
