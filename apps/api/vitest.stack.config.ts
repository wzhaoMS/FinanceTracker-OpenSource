import { defineConfig } from 'vitest/config';

// PR B's production stack (§10.2 with the composed runtime integration): spawns the real index.ts many times, so it runs
// on its own (`npm run test:stack`), one file at a time, never beside the main suite. It serves the real release, built
// twice by the same global setup as `test:ingress` (B-D16 retired now that main self-hosts its fonts).
export default defineConfig({
  test: {
    include: ['src/control/productionStack.integration.ts'],
    globalSetup: ['src/ingress/buildSetup.ts'],
    // P-NET: a test listens on 127.0.0.1 only; this refuses any other listener before it binds.
    setupFiles: ['../../scripts/loopback-only.mjs'],
    environment: 'node',
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 60_000,
  },
});
