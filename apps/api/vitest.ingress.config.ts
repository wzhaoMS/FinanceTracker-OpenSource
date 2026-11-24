import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/ingress/distStack.integration.ts', 'src/ingress/cspRegression.integration.ts'],
    globalSetup: ['src/ingress/buildSetup.ts'],
    // P-NET: a test listens on 127.0.0.1 only; this refuses any other listener before it binds.
    setupFiles: ['../../scripts/loopback-only.mjs'],
    environment: 'node',
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
  },
});
