import fs from 'node:fs';
import path from 'node:path';

import { ControlError } from './errors.js';

/**
 * Managed retirement (design §11.4 step 16a; deviation B-D24 as revised after the B2 review, finding 5): a tree's own
 * `scripts/retired-files.txt` names the files its code no longer ships. `deploy-apply.sh` deletes them from the live tree, and
 * offline validation refuses a tree that still contains one, so a deployment cannot complete with a retired entrypoint (the
 * one-off writers that opened the database directly) left installed. A tree without the list (older code) retires nothing.
 */
export const RETIRED_LIST = 'scripts/retired-files.txt';

/** The shell parser in deploy-apply.sh accepts exactly these entries. */
const ENTRY = /^[A-Za-z0-9._@+-][A-Za-z0-9._@+/-]*$/;

function validEntry(entry: string): boolean {
  if (!ENTRY.test(entry) || entry.endsWith('/')) return false;
  const parts = entry.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return false;
  return !(entry === 'apps/api/data' || entry.startsWith('apps/api/data/') || parts[0] === 'backups' || parts[0] === 'node_modules');
}

/** The entries of `root`'s own list; a malformed list is `E0I_RETIRED_LIST`. */
export function retiredFiles(root: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, RETIRED_LIST), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new ControlError('E0I_RETIRED_LIST', 1, `${RETIRED_LIST} unreadable`);
  }
  const entries: string[] = [];
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    if (!validEntry(line)) throw new ControlError('E0I_RETIRED_LIST', 1, `invalid entry in ${RETIRED_LIST}`);
    entries.push(line);
  }
  return entries;
}

/** Listed paths that still exist in `root` (a symlink counts, dangling or not). */
export function retiredPresent(root: string): string[] {
  return retiredFiles(root).filter((entry) => {
    try {
      fs.lstatSync(path.join(root, entry));
      return true;
    } catch {
      return false;
    }
  });
}
