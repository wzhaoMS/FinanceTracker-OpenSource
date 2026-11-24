/**
 * Extension e2e (plan §9.2): the built test extension in Playwright's
 * bundled Chromium, fake issuers and a synthetic Holdr on loopback, every
 * browser request through the local egress gate. One worker: the suite owns
 * its servers and ports.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
// P-NET: refuses any listener beyond 127.0.0.1 or ::1, in the runner and in every worker (both load this config).
import '../../../../scripts/loopback-only.mjs';
import { newRunId } from './support/runId.js';

process.env.E3_E2E_RUN_ID ??= newRunId();
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: join(repoRoot, '.artifacts', 'card-sync-e2e', process.env.E3_E2E_RUN_ID, 'r'),
  use: { trace: 'off', screenshot: 'off', video: 'off' },
});
