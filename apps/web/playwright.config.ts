import { defineConfig, devices } from '@playwright/test';

// P-NET: refuses any listener beyond 127.0.0.1 or ::1, in the runner and in every worker (both load this config).
import '../../scripts/loopback-only.mjs';
import { AUTH_STATE_FILE } from './tests/authState';
import { guardedBrowserArgs } from './tests/originGuard';

if (process.env.HOLDR_E2E_WRITES !== '1') {
  throw new Error('These tests create and delete data. Set HOLDR_E2E_WRITES=1 only with WEB_URL pointing to a disposable test stack (npm run test:e2e, i.e. scripts/e2e-disposable.mjs, starts one and sets both, plus the run identity the global setup checks).');
}

/**
 * Playwright config for the web app smoke suite (E.4).
 *
 * Strategy:
 *   - Run against an isolated disposable stack with SNAPSHOTS_ENABLED=0.
 *     WEB_URL selects the test web server; HOLDR_API_TARGET selects its
 *     API proxy. Never point this write-enabled suite at the real portfolio.
 *     scripts/e2e-disposable.mjs starts one seeded with synthetic data.
 *   - The app requires sign-in. The runner creates HOLDR_E2E_USER in the
 *     run's data directory with the holdr-user CLI; global setup signs in
 *     once and every test reuses the session; global teardown signs it out.
 *   - Headless Chromium only by default. Other browsers can be added if
 *     a regression demands it.
 *   - Tests live in `tests/` (sibling to `src/`); they're not part of
 *     `tsc -p tsconfig.json` so they don't need their own tsconfig.
 *   - A bypassed 'cache mode' is the riskiest UX surface, so smoke
 *     specifically asserts banners + disabled-write affordances.
 *   - Every page is under the origin guard (tests/originGuard.ts), and the
 *     browser resolves no host but loopback and WEB_URL's.
 */
const webUrl = process.env.WEB_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.e2e\.ts$/,
  // In order: refuse to run unless the API behind WEB_URL reports this run's
  // HOLDR_E2E_RUN_ID and the app's API requests stay on WEB_URL's origin;
  // only then sign in (a write) and save the session for the tests.
  globalSetup: ['./tests/global-setup.ts', './tests/global-sign-in.ts'],
  globalTeardown: './tests/global-teardown.ts',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  retries: 0,
  reporter: process.env.CI ? 'list' : [['list']],
  use: {
    baseURL: webUrl,
    launchOptions: { args: guardedBrowserArgs(webUrl) },
    storageState: AUTH_STATE_FILE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
