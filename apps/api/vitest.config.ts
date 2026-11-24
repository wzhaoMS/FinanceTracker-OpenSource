import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // P-NET: a test listens on 127.0.0.1 only; this refuses any other listener before it binds.
    setupFiles: ['../../scripts/loopback-only.mjs'],
    // On Windows each e2e directory check starts Windows PowerShell 5.1 to read
    // ACLs (a few hundred milliseconds), and some e2e tests make about thirty.
    ...(process.platform === 'win32' ? { testTimeout: 60_000 } : {}),
    // better-sqlite3 is a native module; running multiple test files in
    // parallel forks sometimes causes vitest's worker pool to fail loading
    // the suite ("No test suite found"). Serializing all tests in a single
    // process avoids the race and is plenty fast for this codebase.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
