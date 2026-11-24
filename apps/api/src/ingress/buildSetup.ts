import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GlobalSetupContext } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    ingressReleaseDir: string;
    ingressReleaseDigest: string;
  }
}

export default function setup({ provide }: GlobalSetupContext) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const root = path.join(repo, 'apps/api/.test-tmp', `real-release-${randomBytes(6).toString('hex')}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const run = (name: string) => {
    const output = execFileSync(process.execPath, [
      '--import', 'tsx', path.join(repo, 'apps/web/scripts/buildRelease.ts'), '--commit', commit, '--out', path.join(root, name),
    ], { cwd: repo, encoding: 'utf8', env: { ...process.env, VITE_API_BASE: `https://${name}.invalid` }, timeout: 120_000 });
    const match = /^RELEASE digest=([0-9a-f]{64}) dir=(.+) files=(\d+) bytes=(\d+)$/m.exec(output);
    if (!match) throw Error('real release builder did not report an artifact');
    return { digest: match[1], dir: match[2], files: match[3], bytes: match[4] };
  };
  try {
    const first = run('first');
    const second = run('second');
    if (first.digest !== second.digest) throw Error('release build is not deterministic');
    provide('ingressReleaseDir', first.dir);
    provide('ingressReleaseDigest', first.digest);
    console.log(`Real release: digest=${first.digest} files=${first.files} bytes=${first.bytes}; two builds identical`);
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return () => fs.rmSync(root, { recursive: true, force: true });
}
