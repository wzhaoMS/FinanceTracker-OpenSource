import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { releaseFixture } from './fixtures.js';

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Each test starts from a verified release, which Windows refuses on mode bits (Node reports every directory as 0o666,
// whatever its NTFS ACL): macOS and Linux only.
const posixOnly = it.skipIf(process.platform === 'win32');
let release: ReturnType<typeof releaseFixture> | undefined;
afterEach(() => { release?.cleanup(); release = undefined; });
function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const clean = { ...process.env };
  delete clean.HOLDR_LIFECYCLE_LEASE;
  delete clean.HOLDR_LIFECYCLE_LEASE_FD;
  return spawnSync(process.execPath, ['--import', 'tsx', path.join(api, 'src/cli/ingressMain.ts'), ...args], {
    cwd: api, env: { ...clean, ...env }, encoding: 'utf8', timeout: 10_000,
  });
}

posixOnly('verifies a release without opening the database or starting ingress', () => {
  release = releaseFixture();
  const result = run(['verify-release', release.dir, '--digest', release.digest]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(`VERIFIED digest=${release.digest} files=7`);
});

posixOnly('fails closed for an incorrect pin, incomplete arguments and unimplemented lifecycle commands', () => {
  release = releaseFixture();
  expect(run(['verify-release', release.dir, '--digest', '0'.repeat(64)]).stderr).toContain('E0I_MANIFEST_DIGEST');
  expect(run(['verify-release', release.dir]).stderr).toContain('E0I_RELEASE_CONFIG');
  // PR B implements preflight (B-D12): without a release mode's configuration it still fails closed, before any check.
  const home = { HOME: path.join(api, '.test-tmp') };
  expect(run(['preflight'], { ...home, HOLDR_WEB_MODE: 'dist' }).stderr).toContain('PREFLIGHT refused E0I_NODE_ENV');
  expect(run(['preflight', '--now'], home).status).toBe(64);
});

posixOnly('cannot treat caller-supplied lease variables as authorization', () => {
  release = releaseFixture();
  const result = run(['verify-release', release.dir, '--digest', release.digest], { HOLDR_LIFECYCLE_LEASE_FD: '3' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('E0I_LEASE_ENV');
});
