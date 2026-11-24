import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { fail } from './errors.js';

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK } = fs.constants;

export function currentUid(): number {
  if (typeof process.getuid !== 'function') return fail('E0I_PLATFORM', 'POSIX uid required');
  return process.getuid();
}

/**
 * Reads a small private file: a regular file (never a symlink), owned by this user, mode exactly 0600, one link,
 * at most `limit` bytes, and the same inode before and after opening. Anything else is `code`.
 * Returns null for ENOENT when `missingOk`.
 */
export function readPrivateFile(file: string, options: { code: string; limit: number; missingOk?: boolean }): Buffer | null {
  let before: fs.Stats;
  try {
    before = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && options.missingOk) return null;
    return fail(options.code, file);
  }
  if (!before.isFile() || before.uid !== currentUid() || (before.mode & 0o7777) !== 0o600 || before.nlink !== 1
    || before.size > options.limit) return fail(options.code, file);
  let fd: number;
  try {
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch {
    return fail(options.code, file);
  }
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile() || opened.size > options.limit) {
      return fail(options.code, file);
    }
    const bytes = Buffer.alloc(options.limit + 1);
    let read = 0;
    for (;;) {
      const count = fs.readSync(fd, bytes, read, bytes.length - read, read);
      if (count === 0) break;
      read += count;
      if (read > options.limit) return fail(options.code, file);
    }
    return bytes.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

export function fsyncDirectory(dir: string): void {
  const fd = fs.openSync(dir, O_RDONLY | O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/**
 * Atomic replace in `dir`: `<name>.tmp.<pid>.<16 hex>` created with O_CREAT|O_EXCL|O_NOFOLLOW and mode 0600,
 * written, fsynced, renamed over `<name>`, then the directory is fsynced (§9.4). Readers see the old or the new file.
 */
export function writePrivateFileAtomic(dir: string, name: string, data: string | Buffer): void {
  if (name.includes('/') || name.startsWith('.')) fail('E0I_INTERNAL', name);
  const temporary = path.join(dir, `${name}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`);
  const fd = fs.openSync(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try {
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, path.join(dir, name));
    fsyncDirectory(dir);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Creates a private file that must not exist yet. */
export function createPrivateFile(file: string, data: string | Buffer = ''): void {
  const fd = fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try {
    if (data.length) fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** `toISOString()` form only (round-trips exactly). */
export function isIsoTime(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

export const HEX16 = /^[0-9a-f]{16}$/;
export const randomHex16 = (): string => randomBytes(8).toString('hex');

/** The nearest existing ancestor of `file` (itself when it exists); `df` needs an existing path. */
export function existingAncestor(file: string): string {
  let current = file;
  while (!fs.existsSync(current) && path.dirname(current) !== current) current = path.dirname(current);
  return current;
}
