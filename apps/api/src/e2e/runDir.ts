import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  assertPrivateDirectory,
  assertTrustedAncestors,
  createMissingDirectories,
  identityOf,
  lstatOrNull,
  makePrivateDirectory,
  privateDirectoryIdentity,
} from './pathSafety.js';
import { isInsideApiDataDir, resolvesIntoApiDataDir } from './syntheticSeed.js';

/**
 * Private run directories for scripts/e2e-disposable.mjs. The work directory
 * and every directory above it up to the user's home or this checkout must be
 * writable by nobody but their owner (see pathSafety.ts), so no other user can
 * rename or replace anything on the way to a run. Each run gets a new
 * directory, created exclusively, and cleanup deletes it only while every
 * component from the work directory down is still the directory recorded at
 * creation. Creation and deletion run with the process's working directory on
 * the verified parent and use names relative to it, so a rename or symlink
 * swap anywhere above cannot redirect them.
 */

export interface RunDirectories {
  runDir: string;
  dataDir: string;
  logDir: string;
  /**
   * Identity chains recorded at creation: `<work>/<run>`, `<work>/<run>/<data>`
   * and `<work>/<run>/<logs>`, each element a directory's `<device>:<inode>`.
   */
  runDirId: string;
  dataDirId: string;
  logDirId: string;
}

/**
 * Exact identity (`<device>:<inode>`, read as bigints: NTFS file IDs can
 * exceed 2^53) of a plain directory owned by the current user and writable
 * by nobody else, the same before and after the check.
 */
export function directoryIdentity(target: string, shown: string = target): string {
  return privateDirectoryIdentity(target, shown);
}

/**
 * Run `action` with the working directory on `dir`, verified to be the
 * directory with `identity` once entered: relative paths then resolve from
 * that directory itself, whatever happens to the path above it.
 */
function insideDirectory<T>(dir: string, identity: string, action: () => T): T {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    if (identityOf(fs.statSync('.', { bigint: true })) !== identity) throw new Error(`${dir} changed while it was being entered`);
    return action();
  } finally {
    process.chdir(previous);
  }
}

/** The physical path of the parent for run directories, created (0700) if
 *  missing. It must be private and every directory above it safe; nothing is
 *  created when the path leads into an apps/api/data directory. */
export function prepareWorkRoot(workRoot: string): string {
  const resolved = path.resolve(workRoot);
  if (/[\r\n]/.test(resolved)) throw new Error('the work directory path may not contain line breaks');
  if (resolvesIntoApiDataDir(resolved)) {
    throw new Error(`refusing ${resolved}: apps/api/data is the API's default (live) data directory`);
  }
  try {
    createMissingDirectories(resolved);
    assertPrivateDirectory(resolved);
    const physical = fs.realpathSync(resolved);
    if (isInsideApiDataDir(physical)) {
      throw new Error(`${physical} is inside apps/api/data, the API's default (live) data directory`);
    }
    assertTrustedAncestors(physical);
    return physical;
  } catch (error) {
    throw new Error(`refusing work directory: ${(error as Error).message}`);
  }
}

/** A new private run directory holding empty data/ and logs/, every one of
 *  them created exclusively inside the verified work directory. */
export function createRunDirectories(
  workRoot: string,
  options: { label?: string; now?: Date; suffix?: string } = {},
): RunDirectories {
  const root = prepareWorkRoot(workRoot);
  const rootId = directoryIdentity(root);
  const stamp = (options.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const label = (options.label ?? '').replace(/[^A-Za-z0-9]/g, '');
  const suffix = (options.suffix ?? randomBytes(6).toString('hex')).replace(/[^A-Za-z0-9]/g, '');
  const name = ['run', stamp, label, suffix].filter(Boolean).join('-');
  const runDir = path.join(root, name);
  return insideDirectory(root, rootId, () => {
    // Relative to the work directory itself: an existing entry, a symlink
    // included, makes the exclusive mkdir fail. On Windows each new
    // directory's ACL is then restricted to the current user and SYSTEM.
    makePrivateDirectory(name);
    const runId = directoryIdentity(name, runDir);
    const childId = (child: string) => {
      makePrivateDirectory(path.join(name, child));
      return directoryIdentity(path.join(name, child), path.join(runDir, child));
    };
    const dataId = childId('data');
    const logId = childId('logs');
    return {
      runDir,
      dataDir: path.join(runDir, 'data'),
      logDir: path.join(runDir, 'logs'),
      runDirId: `${rootId}/${runId}`,
      dataDirId: `${rootId}/${runId}/${dataId}`,
      logDirId: `${rootId}/${runId}/${logId}`,
    };
  });
}

/**
 * Delete `target` recursively only while it, and each directory above it up
 * to the work directory, is still the private directory recorded in
 * `identityChain` (see RunDirectories) and the work directory's ancestors are
 * still safe. The deletion itself runs inside the verified parent, by name,
 * and never follows a symlink inside the target.
 */
export function removeRunDirectory(target: string, identityChain: string): 'removed' | 'absent' {
  const resolved = path.resolve(target);
  const ids = identityChain.split('/');
  if (ids.length < 2 || !ids.every((id) => /^\d+:\d+$/.test(id))) {
    throw new Error(`not deleting ${resolved}: malformed identity chain ${identityChain}`);
  }
  if (!lstatOrNull(resolved)) return 'absent';
  // The chain covers the last ids.length components of the path: work directory first.
  const components = [resolved];
  while (components.length < ids.length) components.unshift(path.dirname(components[0]));
  try {
    assertTrustedAncestors(components[0]);
    components.forEach((component, index) => {
      if (directoryIdentity(component) !== ids[index]) {
        throw new Error(`${component} is no longer the directory this run created`);
      }
    });
    const name = path.basename(resolved);
    insideDirectory(components[components.length - 2], ids[ids.length - 2], () => {
      if (directoryIdentity(name, resolved) !== ids[ids.length - 1]) {
        throw new Error(`${resolved} is no longer the directory this run created`);
      }
      // Windows refuses to delete a file another process still holds open,
      // e.g. a database the stopped API had not yet released.
      fs.rmSync(name, { recursive: true, ...(process.platform === 'win32' ? { maxRetries: 10, retryDelay: 200 } : {}) });
    });
  } catch (error) {
    throw new Error(`not deleting ${resolved}: ${(error as Error).message}`);
  }
  return 'removed';
}
