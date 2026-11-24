import { defineConfig } from '@playwright/test';

// P-NET: refuses any listener beyond 127.0.0.1 or ::1, in the runner and in every worker (both load this config).
import '../../scripts/loopback-only.mjs';
import { guardedBrowserArgs } from './tests/originGuard';

/**
 * Tests of the e2e harness itself (tests/*.harness.ts): the global setup's
 * refusal and success paths, against stub servers. They never touch a Holdr
 * stack, so unlike playwright.config.ts this needs no HOLDR_E2E_* settings
 * and has no global setup. Their loopback servers are the only hosts the
 * browser resolves (guardedBrowserArgs in tests/originGuard.ts).
 *
 *   npm run test -w @finance-tracker/web
 */
export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.harness\.ts$/,
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  // A missing snapshot fails every run and is never written: a baseline is recorded only with an
  // explicit --update-snapshots, and reviewed against tests/origin-guard-coverage.harness.ts.
  updateSnapshots: 'none',
  use: { launchOptions: { args: guardedBrowserArgs() } },
});
