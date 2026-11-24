import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADMINISTRATORS_SID,
  SYSTEM_SID,
  readCurrentUserSid,
  readWindowsAcls,
  readWindowsAclsAsync,
  restrictToUser,
  windowsAclProblem,
  type WindowsAcl,
} from './windowsAcl.js';

/**
 * Checks for the directories that hold disposable e2e data or lead to it.
 * Anyone who can write to a directory can rename its entries and put
 * symlinks in their place, even without entering them, so each such
 * directory must be writable by nobody but its owner: no group or other
 * write bit and, on macOS, no ACL entry that lets anyone else write. The same
 * holds for every directory above it up to a trusted root (the user's home or
 * this checkout), whose owner must be the current user or root.
 *
 * On Windows, mode bits say nothing (Node reports every file and directory
 * as 0o666, or 0o444 when read-only, whatever its ACL, and chmod cannot change
 * that), so the same rules are read from each directory's owner and ACL by SID
 * (windowsAcl.ts): only the current user, SYSTEM and Administrators may hold
 * write-capable rights, and a private directory must be owned by the current
 * user (an ancestor may also be owned by SYSTEM or Administrators, the
 * equivalent of root). Directories created here get their ACL replaced by
 * full control for the current user and SYSTEM, then pass the same check.
 * Files get the same check as private directories (assertPrivateFile): on
 * Windows a private directory does not protect the files in it. Nothing is
 * cached between checks: every check reads every ACL again.
 */

/** What the checks need from the operating system. Tests swap in another platform or ACL reader. */
export interface PathSafetyHost {
  platform: NodeJS.Platform;
  /** Windows: the current user's SID. */
  currentUserSid(): string;
  /** Windows: owner and access rules of each path, in order. */
  readWindowsAcls(paths: readonly string[]): WindowsAcl[];
  /** The same without blocking (the API's /health). */
  readWindowsAclsAsync(paths: readonly string[]): Promise<WindowsAcl[]>;
  /** Windows: leave `dir` with full control for the current user and SYSTEM only. */
  restrictToCurrentUser(dir: string): void;
}

let cachedUserSid: string | undefined;
const userSid = () => (cachedUserSid ??= readCurrentUserSid());

const systemHost: PathSafetyHost = {
  platform: process.platform,
  currentUserSid: userSid,
  readWindowsAcls: (paths) => readWindowsAcls(paths),
  readWindowsAclsAsync: (paths) => readWindowsAclsAsync(paths),
  restrictToCurrentUser: (dir) => restrictToUser(dir, userSid()),
};
let host: PathSafetyHost = systemHost;

/** Tests only: run `action` with parts of the host replaced. */
export function withPathSafetyHost<T>(override: Partial<PathSafetyHost>, action: () => T): T {
  const previous = host;
  host = { ...previous, ...override };
  try {
    return action();
  } finally {
    host = previous;
  }
}

/** Tests only: the same for an async `action`, with the host replaced until it settles. */
export async function withPathSafetyHostAsync<T>(override: Partial<PathSafetyHost>, action: () => Promise<T>): Promise<T> {
  const previous = host;
  host = { ...previous, ...override };
  try {
    return await action();
  } finally {
    host = previous;
  }
}

const onWindows = () => host.platform === 'win32';

/** The checkout this file belongs to (apps/api/src/e2e → repository root). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** macOS ACL permissions that let a principal change a directory or its entries. */
const ACL_WRITE_PERMISSIONS = new Set([
  'write', 'append', 'add_file', 'add_subdirectory', 'delete', 'delete_child',
  'writeattr', 'writeextattr', 'writesecurity', 'chown',
]);

/**
 * `<device>:<inode>`. On Windows the device is the low 32 bits of the volume
 * serial number, which is all libuv 1.51 reports; 1.49 and 1.50 report the
 * full 64-bit serial when they stat by path and the low 32 bits when they
 * stat an open handle (or fall back to one), so the same file would get two
 * identities.
 */
export function identityOf(stats: fs.Stats | fs.BigIntStats): string {
  if (process.platform === 'win32') return `${BigInt.asUintN(32, BigInt(stats.dev))}:${stats.ino}`;
  return `${stats.dev}:${stats.ino}`;
}

/**
 * `<device>:<inode>` of `target` itself (a final symlink is not followed),
 * exact on every platform: NTFS file IDs can exceed 2^53, so they are read
 * as bigints. Null when nothing is there.
 */
export function exactIdentityOrNull(target: string): string | null {
  const stats = fs.lstatSync(target, { bigint: true, throwIfNoEntry: false });
  return stats ? identityOf(stats) : null;
}

export function exactIdentity(target: string): string {
  return identityOf(fs.lstatSync(target, { bigint: true }));
}

/**
 * Windows: count a file's hard links again through an open handle. lstat
 * reports one link whenever it has to fall back to the directory listing
 * (libuv does when opening the file for its attributes is denied or hits a
 * sharing violation), so the file itself must agree, and be the same file
 * (identityOf). Elsewhere lstat's count is the file's own and this does nothing.
 */
export function confirmSingleLink(target: string): void {
  if (!onWindows()) return;
  const before = exactIdentity(target);
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY);
  } catch (error) {
    throw new Error(`${target} could not be opened to count its hard links (${(error as Error).message})`);
  }
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (identityOf(opened) !== before) throw new Error(`${target} changed while its hard links were being counted`);
    if (opened.nlink !== 1n) throw new Error(`${target} has ${opened.nlink} hard links`);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function ownedByCurrentUser(stats: fs.Stats): boolean {
  return typeof process.getuid !== 'function' || stats.uid === process.getuid();
}

/**
 * ACL entries on `target` that let someone other than the current user write
 * to it. Only macOS needs this: elsewhere a POSIX ACL that grants write also
 * sets the group write bit of the mode, which is refused on its own. Entries
 * that cannot be parsed count as grants. A failing listing's own diagnostics
 * (which name the target) stay in the error thrown, never forwarded to stderr.
 */
export function aclWriteGrants(target: string): string[] {
  if (process.platform !== 'darwin') return [];
  const listing = execFileSync('/bin/ls', ['-lde', '--', target], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const self = `user:${os.userInfo().username}`;
  return listing.split('\n').slice(1).map((line) => line.trim()).filter((entry) => {
    if (!entry) return false;
    const match = /^\d+:\s+(\S+)\s+(?:inherited\s+)?(allow|deny)\s+(\S+)/.exec(entry);
    if (!match) return true;
    const [, principal, kind, permissions] = match;
    return kind === 'allow' && principal !== self
      && permissions.split(',').some((permission) => ACL_WRITE_PERMISSIONS.has(permission));
  });
}

function assertOnlyOwnerWrites(target: string, stats: fs.Stats, shown: string): void {
  if ((stats.mode & 0o022) !== 0) {
    throw new Error(`${shown} is writable by its group or by other users (mode ${(stats.mode & 0o7777).toString(8)})`);
  }
  const grants = aclWriteGrants(target);
  if (grants.length > 0) throw new Error(`${shown} has an ACL that lets others write to it (${grants.join('; ')})`);
}

interface WindowsTarget {
  target: string;
  shown: string;
  /** Who may own it: the current user, or for a directory above, also SYSTEM or Administrators. */
  owners: 'user' | 'user, SYSTEM or Administrators';
  /** Files only: the identity read before the ACL, which must not change while it is read. */
  identity?: string;
}

/** Targets batchAclReads has collected, read together when it ends. */
let pendingTargets: WindowsTarget[] | null = null;

function unreadable(targets: WindowsTarget[], error: unknown): Error {
  return new Error(`${targets.map(({ shown }) => shown).join(', ')}: ${(error as Error).message}; refusing to trust ${targets.length === 1 ? 'it' : 'them'}`);
}

/**
 * Check what was just read for `targets`: each owner, every write-capable
 * right, and that each file is still the file whose identity was read before
 * its ACL. Nothing is kept for later: every check reads every ACL again, so
 * an ACL changed on the same file is seen at the next check.
 */
function checkWindowsAcls(targets: WindowsTarget[], user: string, acls: WindowsAcl[]): void {
  if (acls.length !== targets.length) throw unreadable(targets, new Error(`read ${acls.length} ACLs for ${targets.length} paths`));
  targets.forEach(({ shown, owners }, index) => {
    const problem = windowsAclProblem(acls[index], user, owners === 'user' ? [user] : [user, SYSTEM_SID, ADMINISTRATORS_SID]);
    if (problem) throw new Error(`${shown} ${problem}`);
  });
  for (const { target, shown, identity } of targets) {
    if (identity !== undefined && exactIdentityOrNull(target) !== identity) {
      throw new Error(`${shown} changed while it was being checked`);
    }
  }
}

function readAndCheckWindowsTargets(targets: WindowsTarget[]): void {
  let user: string;
  let acls: WindowsAcl[];
  try {
    user = host.currentUserSid();
    acls = host.readWindowsAcls(targets.map(({ target }) => target));
  } catch (error) {
    throw unreadable(targets, error);
  }
  checkWindowsAcls(targets, user, acls);
}

async function readAndCheckWindowsTargetsAsync(targets: WindowsTarget[]): Promise<void> {
  let user: string;
  let acls: WindowsAcl[];
  try {
    user = host.currentUserSid();
    acls = await host.readWindowsAclsAsync(targets.map(({ target }) => target));
  } catch (error) {
    throw unreadable(targets, error);
  }
  checkWindowsAcls(targets, user, acls);
}

/**
 * Windows: refuse unless each target's ACL leaves write-capable rights to the
 * current user, SYSTEM and Administrators alone and its owner is one it may
 * have. One PowerShell call reads all of them, or everything a batchAclReads
 * collects; any failure refuses.
 */
function assertWindowsPrivate(targets: WindowsTarget[]): void {
  if (targets.length === 0) return;
  if (pendingTargets) {
    pendingTargets.push(...targets);
    return;
  }
  readAndCheckWindowsTargets(targets);
}

/**
 * Run read-only checks with the Windows ACL reads they need deferred to one
 * PowerShell call when they end, e.g. a data directory, the directories
 * above it and its files. `checks` may only throw: nothing it does may
 * depend on an ACL. Elsewhere, and inside another batch, it just runs `checks`.
 */
export function batchAclReads<T>(checks: () => T): T {
  if (!onWindows() || pendingTargets) return checks();
  pendingTargets = [];
  try {
    const result = checks();
    const targets = pendingTargets;
    pendingTargets = null;
    if (targets.length > 0) readAndCheckWindowsTargets(targets);
    return result;
  } finally {
    pendingTargets = null;
  }
}

/**
 * batchAclReads whose single PowerShell call does not block the event loop
 * (the API's /health). `checks` itself still runs synchronously.
 */
export async function batchAclReadsAsync<T>(checks: () => T): Promise<T> {
  if (!onWindows() || pendingTargets) return checks();
  pendingTargets = [];
  let result: T;
  let targets: WindowsTarget[];
  try {
    result = checks();
    targets = pendingTargets;
  } finally {
    pendingTargets = null;
  }
  if (targets.length > 0) await readAndCheckWindowsTargetsAsync(targets);
  return result;
}

/**
 * Windows only: `target`, an existing file, must be owned by the current
 * user, and nobody else may hold a write-capable right on it. On Windows a
 * private directory does not protect the files in it: anyone who knows a
 * file's path can open it (traverse checking is bypassed by default), and a
 * file moved in keeps its own ACL. Read at every check, like the directory's.
 * Elsewhere callers check the owner with lstat.
 */
export function assertPrivateFile(target: string, shown: string = target): void {
  if (!onWindows()) return;
  assertWindowsPrivate([{ target, shown, owners: 'user', identity: exactIdentity(target) }]);
}

/**
 * lstat `target` (a symlink is never followed) and require a directory owned
 * by the current user that no one else can write to. `shown` names it in
 * errors, e.g. when `target` is relative to an anchored working directory.
 */
export function assertPrivateDirectory(target: string, shown: string = target): fs.Stats {
  const stats = fs.lstatSync(target);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`${shown} is not a plain directory`);
  if (onWindows()) {
    assertWindowsPrivate([{ target, shown, owners: 'user' }]);
    return stats;
  }
  if (!ownedByCurrentUser(stats)) throw new Error(`${shown} belongs to another user`);
  assertOnlyOwnerWrites(target, stats, shown);
  return stats;
}

/**
 * assertPrivateDirectory between two exact identity reads, so the identity
 * returned is the directory that passed: a replacement during the check fails.
 */
export function privateDirectoryIdentity(target: string, shown: string = target): string {
  // The ACL must be read between the two identity reads: never batched.
  const outer = pendingTargets;
  pendingTargets = null;
  try {
    const before = exactIdentity(target);
    assertPrivateDirectory(target, shown);
    if (exactIdentity(target) !== before) throw new Error(`${shown} changed while it was being checked`);
    return before;
  } finally {
    pendingTargets = outer;
  }
}

/**
 * Create `target` with one exclusive mkdir (mode 0700). On Windows, where the
 * mode means nothing and a new directory inherits its parent's ACL, its ACL
 * is then replaced by full control for the current user and SYSTEM only.
 * Callers still check the result with assertPrivateDirectory.
 */
export function makePrivateDirectory(target: string): void {
  fs.mkdirSync(target, { mode: 0o700 });
  if (onWindows()) host.restrictToCurrentUser(target);
}

/** A directory on the way to private ones: ours or root's, writable by nobody else. */
function assertSafeAncestor(dir: string, shown: string): void {
  const stats = fs.lstatSync(dir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`${shown} is not a plain directory`);
  if (onWindows()) {
    assertWindowsPrivate([{ target: dir, shown, owners: 'user, SYSTEM or Administrators' }]);
    return;
  }
  if (!ownedByCurrentUser(stats) && stats.uid !== 0) throw new Error(`${shown} belongs to another user`);
  assertOnlyOwnerWrites(dir, stats, shown);
}

/** The physical paths of the user's home and this checkout. */
export function trustedRoots(): string[] {
  const roots = new Set<string>();
  for (const candidate of [os.homedir(), REPO_ROOT]) {
    try {
      roots.add(fs.realpathSync(candidate));
    } catch {
      // A root that does not exist is not trusted.
    }
  }
  return [...roots];
}

/**
 * Check every directory above `dir` (a physical path), up to and including
 * the first trusted root, or `/` when there is none on the way.
 */
export function assertTrustedAncestors(dir: string): void {
  const roots = trustedRoots();
  if (onWindows()) {
    assertTrustedAncestorsOnWindows(dir, roots);
    return;
  }
  let current = path.resolve(dir);
  while (!roots.includes(current)) {
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
    assertSafeAncestor(current, `${current} (above ${dir})`);
  }
}

/** The same walk on Windows (case-insensitive paths), with one ACL read for all of it. */
function assertTrustedAncestorsOnWindows(dir: string, roots: string[]): void {
  const isRoot = (candidate: string) => roots.some((root) => root.toLowerCase() === candidate.toLowerCase());
  const ancestors: WindowsTarget[] = [];
  let current = path.resolve(dir);
  while (!isRoot(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
    const shown = `${current} (above ${dir})`;
    const stats = fs.lstatSync(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`${shown} is not a plain directory`);
    ancestors.push({ target: current, shown, owners: 'user, SYSTEM or Administrators' });
  }
  assertWindowsPrivate(ancestors);
}

/**
 * Create `dir` and its missing parents (mode 0700, one exclusive mkdir each)
 * once the deepest part that exists, and everything above it, has passed the
 * ancestor checks, so nothing is created below a directory others control.
 */
export function createMissingDirectories(dir: string): void {
  const missing: string[] = [];
  let existing = path.resolve(dir);
  while (lstatOrNull(existing) === null) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(existing);
    existing = parent;
  }
  if (missing.length === 0) return;
  const physical = fs.realpathSync(existing);
  assertSafeAncestor(physical, physical);
  assertTrustedAncestors(physical);
  for (const entry of missing) makePrivateDirectory(entry);
}
