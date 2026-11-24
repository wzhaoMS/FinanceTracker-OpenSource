import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { API_DIR, REPO_ROOT } from './paths.js';

/** Disposable private directories for B's tests: under apps/api/.test-tmp (git-ignored), never a real HOME. */
export function scratchDir(prefix = 'b'): { dir: string; cleanup: () => void } {
  const root = path.join(API_DIR, '.test-tmp');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = path.join(root, `${prefix}-${randomBytes(6).toString('hex')}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  return { dir, cleanup: () => removeTree(dir) };
}

/** A short private directory for Unix sockets (`<repo>/.i-<8 hex>`, git-ignored), as A2's fixtures use. */
export function shortDir(): { dir: string; cleanup: () => void } {
  const dir = path.join(REPO_ROOT, `.i-${randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  return { dir, cleanup: () => removeTree(dir) };
}

export function removeTree(dir: string): void {
  try {
    fs.chmodSync(dir, 0o700);
  } catch { /* already gone */ }
  for (const entry of (() => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } })()) {
    if (entry.isDirectory()) {
      try { fs.chmodSync(path.join(dir, entry.name), 0o700); } catch { /* best effort */ }
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

export function writePrivate(file: string, text: string, mode = 0o600): void {
  fs.writeFileSync(file, text, { mode, flag: 'wx' });
  fs.chmodSync(file, mode);
}
