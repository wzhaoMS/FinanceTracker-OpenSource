import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildManifest, verifyRelease } from '@finance-tracker/shared/web-release/files';
import { SOURCE_COMMIT, WebReleaseError } from '@finance-tracker/shared/web-release';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(web, '../..');
const { values } = parseArgs({ options: { commit: { type: 'string' }, out: { type: 'string' } }, strict: true });
if (!values.commit || !SOURCE_COMMIT.test(values.commit)) {
  console.error('E0I_MANIFEST_INVALID: --commit must be the 40 lowercase hex release source commit');
  process.exit(1);
}
const root = path.resolve(values.out ?? path.join(web, 'releases'));
const staging = path.join(root, `building-${process.pid}-${randomBytes(6).toString('hex')}`);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITE_')));
env.NODE_ENV = 'production';

try {
  execFileSync(process.execPath, [path.join(repo, 'node_modules/typescript/bin/tsc'), '-p', path.join(web, 'tsconfig.json')], {
    cwd: web, env, stdio: 'inherit',
  });
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(staging, { mode: 0o755 });
  execFileSync(process.execPath, [
    path.join(repo, 'node_modules/vite/bin/vite.js'), 'build',
    '--config', path.join(web, 'vite.release.config.ts'), '--mode', 'production',
    '--outDir', path.join(staging, 'public'),
  ], { cwd: web, env, stdio: 'inherit' });
  const built = buildManifest(path.join(staging, 'public'), values.commit);
  fs.writeFileSync(path.join(staging, 'manifest.json'), built.bytes, { flag: 'wx', mode: 0o644 });
  const destination = path.join(root, built.digest.slice(0, 12));
  if (fs.existsSync(destination)) {
    // A matching manifest alone is not enough: an existing release may have been tampered with.
    verifyRelease(destination, built.digest);
  } else {
    fs.renameSync(staging, destination);
  }
  const bytes = built.manifest.files.reduce((sum, file) => sum + file.size, 0);
  console.log(`RELEASE digest=${built.digest} dir=${destination} files=${built.manifest.files.length} bytes=${bytes}`);
} catch (error) {
  console.error(error instanceof WebReleaseError ? error.code : 'E0I_RELEASE_BUILD: build failed');
  process.exitCode = 1;
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
