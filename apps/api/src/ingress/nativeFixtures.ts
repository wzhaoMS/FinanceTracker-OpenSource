import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NATIVE_DIR } from './nativeHelper.js';
import { sha256 } from '@finance-tracker/shared/web-release/files';

export const NATIVE_TEST_COMMIT = 'a'.repeat(40);

export function nativeFixture() {
  const repo = path.resolve(NATIVE_DIR, '../../..');
  const root = path.join(repo, `.i-${randomBytes(4).toString('hex')}`);
  fs.mkdirSync(root, { mode: 0o700 });
  const buildDir = path.join(root, 'build');
  const cc = (...args: string[]) => execFileSync('/usr/bin/cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-I', NATIVE_DIR, ...args], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin', TMPDIR: process.env.TMPDIR },
  });
  const masks = path.join(root, 'masks');
  const interposer = path.join(root, 'race.dylib');
  try {
    execFileSync(process.execPath, ['--import', 'tsx', path.resolve(NATIVE_DIR, '../scripts/buildNative.ts'),
      '--commit', NATIVE_TEST_COMMIT, '--out', buildDir], { encoding: 'utf8', cwd: repo });
    cc('-o', masks, path.join(NATIVE_DIR, 'testing/aclmask-test.c'));
    cc('-dynamiclib', '-o', interposer, path.join(NATIVE_DIR, 'testing/race.c'));
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const binary = path.join(buildDir, 'holdr-pathcheck');
  return {
    root, buildDir, binary, interposer, masks,
    native: { buildDir, sourceCommit: NATIVE_TEST_COMMIT, manifestDigest: sha256(fs.readFileSync(path.join(buildDir, 'native-manifest.json'))) },
    read(socketPath: string, env: NodeJS.ProcessEnv = {}) {
      const result = spawnSync(binary, [socketPath], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ...env }, timeout: 5000 });
      return { exitCode: result.status ?? 'spawn-error' as const, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    },
    mkdir(name: string, mode = 0o755) {
      const dir = path.join(root, name);
      fs.mkdirSync(dir, { recursive: true, mode });
      fs.chmodSync(dir, mode);
      return dir;
    },
    acl(dir: string, entry: string) { execFileSync('/bin/chmod', ['+a', entry, dir]); },
    cleanup() {
      spawnSync('/bin/chmod', ['-R', '-N', root]);
      spawnSync('/bin/chmod', ['-R', 'u+rwx', root]);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
