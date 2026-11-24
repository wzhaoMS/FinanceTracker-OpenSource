import { mkdir, mkdtemp, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Per-test directories under apps/api/.test-tmp/ (gitignored), removed again by the test. */
const ROOT = fileURLToPath(new URL('../../.test-tmp/', import.meta.url));

export async function makeScratchDir(prefix: string): Promise<string> {
  await mkdir(ROOT, { recursive: true });
  return mkdtemp(path.join(ROOT, prefix));
}

export async function removeScratchDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await rmdir(ROOT).catch(() => undefined);
}
