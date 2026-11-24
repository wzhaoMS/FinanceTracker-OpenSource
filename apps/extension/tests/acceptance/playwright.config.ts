/**
 * The acceptance suite (E2c M6): the acceptance build, which carries the
 * production extension id, in Playwright's bundled Chromium. Its scenario
 * against Holdr's real device API (acceptance.spec.ts) runs on macOS only,
 * where E2c's device world runs; its transport checks (transport.spec.ts) run
 * everywhere. One worker: the suite owns its servers and ports.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
// P-NET: refuses any listener beyond 127.0.0.1 or ::1, in the runner and in every worker (both load this config).
import '../../../../scripts/loopback-only.mjs';
import { newRunId } from '../e2e/support/runId.js';

process.env.E3_E2E_RUN_ID ??= newRunId();
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  outputDir: join(repoRoot, '.artifacts', 'card-sync-e2e', process.env.E3_E2E_RUN_ID, 'ra'),
  use: { trace: 'off', screenshot: 'off', video: 'off' },
});
