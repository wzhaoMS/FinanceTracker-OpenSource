import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXIT, fail } from './errors.js';

/** The tree this process runs from: `<repo>/apps/api/src` is two levels below the repository root. */
export const API_SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const API_DIR = path.dirname(API_SRC_DIR);
export const REPO_ROOT = path.resolve(API_DIR, '../..');

export interface RepoPaths {
  readonly root: string;
  readonly releasesRoot: string;
  readonly web: string;
  readonly shared: string;
  readonly nodeModules: string;
  readonly backups: string;
  readonly defaultDataDir: string;
  readonly leasedScript: string;
}

export function repoPaths(root = REPO_ROOT): RepoPaths {
  return Object.freeze({
    root,
    releasesRoot: path.join(root, 'apps/web/releases'),
    web: path.join(root, 'apps/web'),
    shared: path.join(root, 'packages/shared'),
    nodeModules: path.join(root, 'node_modules'),
    backups: path.join(root, 'backups'),
    defaultDataDir: path.join(root, 'apps/api/data'),
    leasedScript: path.join(root, 'scripts/holdr-leased.sh'),
  });
}

/**
 * Entries that make the directory holding a `FinanceTracker` a staging tree (its candidate `holdr.conf`) or a rollback kit
 * (`KR/holdr.conf`, `KR/kit-runtime.txt`), never the live deployment, whose configuration lives in Application Support
 * (B-D44). An entry of any type counts, a dangling link included.
 */
export const NON_LIVE_ENTRIES = ['holdr.conf', 'kit-runtime.txt'] as const;

/** The first `NON_LIVE_ENTRIES` name present in `dir`, or null. */
export function nonLiveEntry(dir: string): string | null {
  for (const name of NON_LIVE_ENTRIES) {
    try {
      fs.lstatSync(path.join(dir, name));
      return name;
    } catch { /* absent */ }
  }
  return null;
}

export interface ManagedLive {
  /** `$HOLDR_ROOT`, or `$HOME/Holdr`: what the start script and the stop role take as `--root`. */
  readonly base: string;
  /** The physical path of `base/FinanceTracker`. */
  readonly tree: string;
}

/**
 * The managed live deployment (B1 review 4; B1 round-3 finding 1): `$HOLDR_ROOT/FinanceTracker` when HOLDR_ROOT is set (it
 * must exist), else `$HOME/Holdr/FinanceTracker`, by physical path. Null only when HOLDR_ROOT is unset
 * and that default is absent (a development checkout, or no usable HOME). Refused (`E0I_NOT_LIVE`, 64), with the start script's
 * rule (B-D44): a base, or the tree's physical parent, that holds a `holdr.conf` or `kit-runtime.txt`. HOLDR_ROOT naming a
 * staging tree or a rollback kit, directly or through a link, never makes it the live deployment, here or anywhere that asks
 * (self-validation, the leased role, the stop role, the staged preflight).
 */
export function managedLive(env: NodeJS.ProcessEnv): ManagedLive | null {
  const named = env.HOLDR_ROOT !== undefined;
  const base = named ? env.HOLDR_ROOT! : env.HOME && isCanonicalAbsolute(env.HOME) ? path.join(env.HOME, 'Holdr') : undefined;
  if (base === undefined) return null;
  if (!isCanonicalAbsolute(base)) return fail('E0I_NOT_LIVE', 'HOLDR_ROOT must be an absolute path', EXIT.usage);
  let tree: string;
  try {
    tree = fs.realpathSync(path.join(base, 'FinanceTracker'));
  } catch (error) {
    if (!named && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return fail('E0I_NOT_LIVE', `no tree at ${path.join(base, 'FinanceTracker')}`, EXIT.usage);
  }
  if (!fs.statSync(tree).isDirectory()) return fail('E0I_NOT_LIVE', `${tree} is not a directory`, EXIT.usage);
  for (const dir of [base, path.dirname(tree)]) {
    const entry = nonLiveEntry(dir);
    if (entry) return fail('E0I_NOT_LIVE', `${dir} holds ${entry}: a staging tree or a rollback kit, not the live deployment`, EXIT.usage);
  }
  return Object.freeze({ base, tree });
}

/**
 * The tree whose running API a preflight judges (B1 review 4): the managed live tree, or, only where there is none (a
 * development checkout), the tree this code runs from. A staged candidate (§11.2) therefore judges the running API against
 * the live tree, not itself. A refused base (`managedLive`) throws.
 */
export function managedLiveRoot(env: NodeJS.ProcessEnv, codeRoot = REPO_ROOT): string {
  return managedLive(env)?.tree ?? codeRoot;
}

/** The managed live tree without a fallback (`managedLive`); absent is `E0I_NOT_LIVE` too. */
export function managedLiveTree(env: NodeJS.ProcessEnv): string {
  const live = managedLive(env);
  if (!live) return fail('E0I_NOT_LIVE', 'no live tree (HOLDR_ROOT/FinanceTracker or ~/Holdr/FinanceTracker)', EXIT.usage);
  return live.tree;
}

/** `<releases root>/<first 12 hex of the digest>`, the directory `build:release` writes (§4.4). */
export function releaseDirFor(digest: string, root = REPO_ROOT): string {
  return path.join(repoPaths(root).releasesRoot, digest.slice(0, 12));
}

/**
 * True when `inner` equals `outer` or lies below it. Both must be absolute and normalised. Judged by path components: only a
 * first component that is exactly `..` leaves `outer`, so a child named `..data` or `..private` is inside (B1 review 1).
 */
export function contains(outer: string, inner: string): boolean {
  const relative = path.relative(outer, inner);
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  return relative.split(path.sep)[0] !== '..';
}

/** Neither contains the other. */
export function disjoint(a: string, b: string): boolean {
  return !contains(a, b) && !contains(b, a);
}

/** An absolute, normalised path without control characters or a trailing slash. */
export function isCanonicalAbsolute(value: string): boolean {
  return value.startsWith('/') && value.length <= 1024 && path.posix.normalize(value) === value
    && (value === '/' || !value.endsWith('/')) && !/[\x00-\x1f\x7f]/.test(value);
}

/** `isCanonicalAbsolute` on POSIX; on Windows, a normalized absolute drive (`C:\...`) or UNC (`\\server\...`) path. */
export function isCanonicalNativeAbsolute(value: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return isCanonicalAbsolute(value);
  return value.length <= 1024 && /^(?:[A-Za-z]:\\|\\\\[^\\])/.test(value) && path.win32.normalize(value) === value
    && (!value.endsWith('\\') || /^[A-Za-z]:\\$/.test(value)) && !/[\x00-\x1f\x7f]/.test(value);
}
