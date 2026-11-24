import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { sha256 } from '@finance-tracker/shared/web-release/files';
import { SOURCE_COMMIT } from '@finance-tracker/shared/web-release';
import { NATIVE_DIR, PATHCHECK_FORMAT, nativeManifestBytes, readNativeFile, verifyNativeHelper, type NativeManifest } from '../src/ingress/nativeHelper.js';

let temporary: string | undefined;
let nextManifest: string | undefined;
try {
  if (process.platform !== 'darwin') throw Error('darwin required');
  const { values } = parseArgs({ options: { commit: { type: 'string' }, out: { type: 'string' } }, strict: true });
  const commit = values.commit ?? execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: NATIVE_DIR, encoding: 'utf8' }).trim();
  if (!SOURCE_COMMIT.test(commit)) throw Error('source commit required');
  const out = path.resolve(values.out ?? path.join(NATIVE_DIR, 'build'));
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(out);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || stat.mode & 0o022 || fs.realpathSync(out) !== out) throw Error('unsafe output');
  for (const name of ['holdr-pathcheck', 'native-manifest.json']) {
    try { readNativeFile(path.join(out, name), 8 * 1024 * 1024); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const sources = {
    'holdr-pathcheck.c': sha256(readNativeFile(path.join(NATIVE_DIR, 'holdr-pathcheck.c'), 1024 * 1024)),
    'acl_decode.h': sha256(readNativeFile(path.join(NATIVE_DIR, 'acl_decode.h'), 1024 * 1024)),
  };
  const nonce = `${process.pid}-${randomBytes(6).toString('hex')}`;
  temporary = path.join(out, `building-${nonce}`);
  nextManifest = path.join(out, `manifest-${nonce}.json`);
  execFileSync('/usr/bin/cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-o', temporary, path.join(NATIVE_DIR, 'holdr-pathcheck.c')], {
    env: { PATH: '/usr/bin:/bin', TMPDIR: process.env.TMPDIR }, stdio: 'inherit', timeout: 60_000,
  });
  for (const name of ['holdr-pathcheck.c', 'acl_decode.h'] as const) {
    if (sha256(readNativeFile(path.join(NATIVE_DIR, name), 1024 * 1024)) !== sources[name]) throw Error('sources changed');
  }
  const binary = readNativeFile(temporary, 8 * 1024 * 1024, true);
  const manifest: NativeManifest = {
    format: 'holdr-native/1', reportFormat: PATHCHECK_FORMAT, sourceCommit: commit, sources,
    binary: { path: 'holdr-pathcheck', size: binary.length, sha256: sha256(binary) },
  };
  fs.writeFileSync(nextManifest, nativeManifestBytes(manifest), { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, path.join(out, 'holdr-pathcheck'));
  fs.renameSync(nextManifest, path.join(out, 'native-manifest.json'));
  verifyNativeHelper({ buildDir: out, sourceCommit: commit });
  console.log(`NATIVE commit=${commit} manifest=${sha256(nativeManifestBytes(manifest))} binary=${manifest.binary.sha256} format=${PATHCHECK_FORMAT}`);
} catch {
  console.error('E0I_NATIVE_HELPER: build or verification failed');
  process.exitCode = 1;
} finally {
  if (temporary) fs.rmSync(temporary, { force: true });
  if (nextManifest) fs.rmSync(nextManifest, { force: true });
}
