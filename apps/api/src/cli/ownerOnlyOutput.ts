/**
 * Owner-only output for the offline converters: a new file (never an existing one), in a directory only its owner can
 * open, itself checked owner-only before a byte of it is written. Nothing that exists is repaired: an output place that
 * isn't owner-only, or that can't be checked, is refused, and a new file that fails its check is removed while still empty.
 *
 * - Windows: by SID, through windowsAcl.ts (the repository's PowerShell ACL reader; paths reach it in its environment,
 *   never on a command line, and nothing of its output or errors leaves here). Owner-only means: owned by the current
 *   user, a DACL of plain allow and deny entries only, and every allow entry, explicit, inherited or inherit-only, for
 *   the current user, SYSTEM or Administrators. An elevated (administrator) PowerShell makes Administrators the owner of
 *   every file it creates, so a new file owned by Administrators is first given to the current user, by SID (icacls
 *   /setowner, an argument array with no shell), then checked: the only change this module makes on Windows (claimNewFile).
 * - macOS: through the repository's pinned native reader, holdr-pathcheck (darwinPathcheck.ts: the ingress's helper, pin
 *   and parser, unchanged; it reads the raw ACL and fails closed on any ACL API failure, never skipping an entry), since
 *   an ACL isn't masked by the mode there. Owner-only means: owned by the current uid, no group or other bits, and every
 *   allow entry, explicit, inherited or inherit-only, for the current uid itself; deny entries only take access away.
 *   The new file is also checked to be the one just created (its device and inode), and its directory again with it. A
 *   path the reader can't take (over 100 bytes, say) or can't read is uncheckable.
 * - Linux and other POSIX systems: owned by the current user with no group or other bits (a POSIX ACL is masked by
 *   them); the new file is made 0600 and checked.
 *
 * On every platform, an output path with a folder or file name that Windows reads as another file or a device is
 * refused first, before anything is read or created, as `output-name-refused` (`isWindowsAliasName`, ROOT's single
 * rule, which operatorIo's newOutputPath applies too): the ACL reader would check that other file or folder.
 *
 * The same policy also guards reading an existing owner-only input (readOwnerOnlyFile: the metals identity key and
 * folder registry, corrections design r6, section 2.8), bound to the very file read: it is opened first, its identity
 * (device and inode, or volume and file index) taken from the descriptor, the policy read for that identity, the bytes
 * read from the descriptor, and the path checked again after the read.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { PathObject, PathRecord } from '../ingress/socketPath.js';
import {
  ADMINISTRATORS_SID, readCurrentUserSid, readWindowsAcls, readWindowsFileAcl, SYSTEM_SID, takeOwnership, type WindowsAcl,
  type WindowsFileAcl,
} from '../e2e/windowsAcl.js';
import { holdrConfNativePin, readPinnedPathcheck } from './darwinPathcheck.js';

export const OUTPUT_REFUSALS = ['output-not-owner-only', 'output-uncheckable', 'output-name-refused'] as const;
export type OutputRefusalCode = (typeof OUTPUT_REFUSALS)[number];

/** A refusal of the output place, by a closed code that names no path. */
export class OutputRefusal extends Error {
  constructor(readonly code: OutputRefusalCode) {
    super(code);
    this.name = 'OutputRefusal';
  }
}

/**
 * The device names Windows reserves in every folder, without case: CON, PRN, AUX, NUL, CONIN$, CONOUT$, and COM and LPT
 * with a digit 0 to 9 or a superscript ¹, ² or ³ (U+00B9, U+00B2, U+00B3), which Windows takes as digits there.
 */
const WINDOWS_DEVICE = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[0-9\u00B9\u00B2\u00B3])$/i;
/**
 * The prefixes that take a path out of Win32's ordinary file names, each with either separator: the file and device
 * namespaces' `\\?\` and `\\.\`, and the NT object namespace's `\??\` (ROOT's O84).
 */
const WINDOWS_NAMESPACE = /^(?:[\\/]{2}[?.]|[\\/]\?\?)[\\/]/;
/** A drive root, `C:\`: the one place a colon may be. */
const DRIVE_ROOT = /^[A-Za-z]:[\\/]/;

/**
 * Whether Windows reads a path, by its prefix or by any folder or file name on it, as another file or a device than
 * Node does (E1's probe, #318). SQLite and the ACL reader (Get-Acl -LiteralPath) read `finance.db.` and `finance.db `
 * as `finance.db`, and a folder `run.` as `run`, where Node makes new names; `name:stream` is a stream of `name`; a
 * device name is the device (Node's write to `NUL` lands in the null device); and `\??\UNC\server\share\…` is that
 * share to SQLite, where Node looks under the current drive. This is ROOT's single rule (11/09, with G2's list, and
 * `\??\` by O84), for every output path on every platform. The path is resolved, then refused when:
 * - it starts with `\\?\`, `\\.\` or `\??\` (either separator);
 * - any name on it, the drive root (`C:\`) aside, ends in a dot or a space, or holds a colon;
 * - any such name, up to its first dot and without the spaces before that dot, is a device name (above), in any case:
 *   `NUL`, `nul.txt`, `Com1 .json`, `CONIN$.log`, `LPT³.tar.gz`.
 */
export function isWindowsAliasName(file: string): boolean {
  const resolved = path.resolve(file);
  if (WINDOWS_NAMESPACE.test(file) || WINDOWS_NAMESPACE.test(resolved)) return true;
  return resolved.replace(DRIVE_ROOT, '').split(/[\\/]/).some((name) => name !== ''
    && (/[. ]$/.test(name) || name.includes(':') || WINDOWS_DEVICE.test(name.split('.')[0].replace(/ +$/, ''))));
}

/** How a macOS output place is read: the current uid, and the pinned reader's records for a path. */
export interface DarwinOutputAccess {
  currentUid(): number;
  /** The directories from / down to `target`, then `target` itself (parsePathcheck's records); throws when it can't. */
  readPath(target: string): readonly PathRecord[];
}

/**
 * How the output place is checked: the platform; on Windows the current user's SID and paths' ACLs; on macOS
 * `darwin` (without it, macOS output is refused as uncheckable).
 */
export interface OutputAccess {
  platform: NodeJS.Platform;
  currentUserSid(): string;
  /** Each path's owner and access rules, in order. */
  readAcls(paths: readonly string[]): WindowsAcl[];
  /**
   * Windows, for reading an existing file: its owner, access rules and identity (volume and file index), all read through
   * one handle. Without it, reading an owner-only input on Windows is refused as uncheckable.
   */
  readFileAcl?(file: string): WindowsFileAcl;
  /**
   * Windows: makes `sid` the owner of `file`, a file just created (claimNewFile). Without it, a new file an elevated
   * token made Administrators' is refused as not owner-only.
   */
  setOwner?(file: string, sid: string): void;
  darwin?: DarwinOutputAccess;
}

let userSid: string | null = null;
export const platformOutputAccess: OutputAccess = {
  platform: process.platform,
  currentUserSid: () => (userSid ??= readCurrentUserSid()),
  readAcls: (paths) => readWindowsAcls(paths),
  readFileAcl: (file) => readWindowsFileAcl(file),
  // An absolute path: icacls never reads it as one of its options.
  setOwner: (file, sid) => takeOwnership(path.resolve(file), sid),
  darwin: {
    currentUid: () => {
      if (!process.getuid) throw new Error('no uid');
      return process.getuid();
    },
    readPath: (target) => readPinnedPathcheck(target, holdrConfNativePin()),
  },
};

/** Whether an ACL lets only the current user (its owner), SYSTEM and Administrators in. */
export function ownerOnlyAcl(acl: WindowsAcl, sid: string): boolean {
  return acl.owner === sid && acl.aceTypes !== null
    && acl.aceTypes.every((type) => type === 'AccessAllowed' || type === 'AccessDenied')
    && acl.aces.every((ace) => ace.type === 'Deny' || [sid, SYSTEM_SID, ADMINISTRATORS_SID].includes(ace.sid));
}

/** Whether a macOS path the pinned reader saw is the current uid's, with no group or other bits and no allow for anyone else. */
export function ownerOnlyDarwinPath(object: PathObject, uid: number): boolean {
  return object.uid === uid && (object.mode & 0o077) === 0
    && object.acl.every((ace) => ace.type === 'deny' || (ace.principal === 'uid' && ace.id === uid));
}

/**
 * Windows: refuses `target` unless its ACL is owner-only for the current user. A new file (`created`) is first claimed
 * for that user (claimNewFile); anything else is only read.
 */
function assertWindowsOwnerOnly(target: string, access: OutputAccess, created = false): void {
  let ownerOnly: boolean;
  try {
    const [acl] = access.readAcls([target]);
    const sid = access.currentUserSid();
    const checked = created ? claimNewFile(target, acl, access, sid) : acl;
    ownerOnly = checked !== undefined && ownerOnlyAcl(checked, sid);
  } catch {
    throw new OutputRefusal('output-uncheckable');
  }
  if (!ownerOnly) throw new OutputRefusal('output-not-owner-only');
}

/**
 * Windows: `file`, just created by this process or a child it ran, with `acl` as read. An elevated (administrator) token
 * makes Administrators the owner of every file it creates, which the owner-only rule refuses; such a file is given to
 * the current user `sid` (where `access.setOwner` can) and its ACL read again, so an elevated PowerShell writes owner-only
 * output too. Any other owner is left as it is, to be judged by ownerOnlyAcl. Only a new file's owner is ever changed,
 * never a directory's or an input's. A reader or owner change that fails throws.
 */
export function claimNewFile(file: string, acl: WindowsAcl | undefined, access: OutputAccess, sid: string): WindowsAcl | undefined {
  if (acl?.owner !== ADMINISTRATORS_SID || !access.setOwner) return acl;
  access.setOwner(file, sid);
  return access.readAcls([file])[0];
}

/**
 * macOS: the pinned reader's records for `target`, the one it is checked as (its last record), and the current uid. The
 * reader takes canonical absolute paths only, so `target` is read as its real path: a directory's own, and a new file's
 * directory's joined with its name, however the caller named it. For a new file (`fd`, its open descriptor) its
 * directory is checked with it, and it must be that very file.
 */
function assertDarwinOwnerOnly(target: string, access: OutputAccess, fd?: number): void {
  let checked: PathObject[];
  let uid: number;
  try {
    if (!access.darwin) throw new Error('no macOS reader');
    uid = access.darwin.currentUid();
    const canonical = fd === undefined ? fs.realpathSync.native(target)
      : path.join(fs.realpathSync.native(path.dirname(path.resolve(target))), path.basename(target));
    const records = access.darwin.readPath(canonical);
    const endpoint = records.at(-1);
    if (endpoint?.kind !== 'socket') throw new Error('no record of the path itself');
    if (fd === undefined) {
      if (endpoint.type !== 'dir') throw new Error('not a directory');
      checked = [endpoint];
    } else {
      const opened = fs.fstatSync(fd, { bigint: true });
      const parent = records.at(-2);
      if (endpoint.type !== 'other' || endpoint.dev !== opened.dev.toString() || endpoint.ino !== opened.ino.toString()) {
        throw new Error('not the new file');
      }
      if (parent?.kind !== 'dir' || parent.type !== 'dir') throw new Error('no record of its directory');
      checked = [parent, endpoint];
    }
  } catch {
    throw new OutputRefusal('output-uncheckable');
  }
  if (!checked.every((object) => ownerOnlyDarwinPath(object, uid))) throw new OutputRefusal('output-not-owner-only');
}

const currentUid = () => process.getuid?.() ?? null;

/**
 * Refuses a directory others can open, or one that can't be checked; first, before anything is read, one with a name
 * Windows reads as another (`isWindowsAliasName`). `dir` is a real path (no link on it).
 */
export function assertOwnerOnlyDirectory(dir: string, access: OutputAccess = platformOutputAccess): void {
  if (isWindowsAliasName(dir)) throw new OutputRefusal('output-name-refused');
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) throw new OutputRefusal('output-uncheckable');
  if (access.platform === 'win32') return assertWindowsOwnerOnly(dir, access);
  if (access.platform === 'darwin') return assertDarwinOwnerOnly(dir, access);
  if (currentUid() === null) throw new OutputRefusal('output-uncheckable');
  if (stat.uid !== currentUid() || (stat.mode & 0o077) !== 0) throw new OutputRefusal('output-not-owner-only');
}

/**
 * Refuses a new file others can open, or one that can't be checked: `file` is the file just created and still open as
 * `fd`, checked before a byte of it is written: on Windows after it is claimed for the current user (claimNewFile), on
 * Linux after it is made 0600. writeOwnerOnlyNewFile's own check, for a caller that writes the file by other means
 * (SQLite's backup, say) and must know it is the file it created.
 */
export function assertOwnerOnlyFile(file: string, fd: number, access: OutputAccess = platformOutputAccess): void {
  if (access.platform === 'win32') assertWindowsOwnerOnly(file, access, true);
  else if (access.platform === 'darwin') assertDarwinOwnerOnly(file, access, fd);
  else if (currentUid() === null) throw new OutputRefusal('output-uncheckable');
  else {
    fs.fchmodSync(fd, 0o600);
    const stat = fs.fstatSync(fd);
    if (stat.uid !== currentUid() || (stat.mode & 0o777) !== 0o600) throw new OutputRefusal('output-not-owner-only');
  }
}

/**
 * Writes `text` to `file`, a new file (creating it fails if anything is there), checked owner-only before a byte is
 * written, then synced. A new file that fails its check, or a write that fails, leaves no file behind. A path with a
 * name Windows reads as another (`isWindowsAliasName`) is refused before anything is created.
 */
export function writeOwnerOnlyNewFile(file: string, text: string, access: OutputAccess = platformOutputAccess): void {
  if (isWindowsAliasName(file)) throw new OutputRefusal('output-name-refused');
  const fd = fs.openSync(file, 'wx', 0o600);
  let done = false;
  try {
    assertOwnerOnlyFile(file, fd, access);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    done = true;
  } finally {
    fs.closeSync(fd);
    if (!done) fs.rmSync(file, { force: true });
  }
}

/** Why an existing owner-only input can't be read (corrections design r6, section 2.8): a closed list naming no path. */
export const INPUT_REFUSALS = ['missing', 'malformed', 'not-owner-only', 'uncheckable', 'changed'] as const;
export type InputRefusalReason = (typeof INPUT_REFUSALS)[number];

/** A refusal of an owner-only input, by a closed reason that names no path. */
export class InputRefusal extends Error {
  constructor(readonly reason: InputRefusalReason) {
    super(reason);
    this.name = 'InputRefusal';
  }
}

/** Where a test may change the path while an input is read (production passes no probe). */
export type OwnerOnlyReadPoint = 'opened' | 'checked' | 'read';

/** The descriptor's identity, as both the policy readers and lstat report it: device and inode, in decimal. */
interface FileIdentity {
  dev: string;
  ino: string;
}
const identityOf = (stat: fs.BigIntStats): FileIdentity => ({ dev: stat.dev.toString(), ino: stat.ino.toString() });
const sameIdentity = (a: FileIdentity, b: FileIdentity): boolean => a.dev === b.dev && a.ino === b.ino;

/**
 * The owner-only policy, bound to the opened file's identity. Windows: the ACL and the identity read through one handle,
 * the identity equal to the descriptor's. macOS: the pinned reader's record of the file (by its canonical path, its
 * directory resolved), its device and inode equal to the descriptor's. Other POSIX systems: the owner and mode of the
 * descriptor's own fstat. A reader that fails, or reports no identity, is `uncheckable`; another identity is `changed`.
 */
function assertOwnerOnlyOpened(file: string, opened: fs.BigIntStats, access: OutputAccess): void {
  const identity = identityOf(opened);
  if (access.platform === 'win32') {
    let acl: WindowsFileAcl;
    let sid: string;
    try {
      if (!access.readFileAcl) throw new Error('no handle reader');
      acl = access.readFileAcl(file);
      sid = access.currentUserSid();
    } catch {
      throw new InputRefusal('uncheckable');
    }
    if (!sameIdentity({ dev: acl.volume, ino: acl.index }, identity)) throw new InputRefusal('changed');
    if (!ownerOnlyAcl(acl, sid)) throw new InputRefusal('not-owner-only');
    return;
  }
  if (access.platform === 'darwin') {
    let endpoint: PathObject;
    let uid: number;
    try {
      if (!access.darwin) throw new Error('no macOS reader');
      uid = access.darwin.currentUid();
      const records = access.darwin.readPath(path.join(fs.realpathSync.native(path.dirname(file)), path.basename(file)));
      const last = records.at(-1);
      if (last?.kind !== 'socket' || last.type !== 'other') throw new Error('no record of the file itself');
      endpoint = last;
    } catch {
      throw new InputRefusal('uncheckable');
    }
    if (!sameIdentity({ dev: endpoint.dev, ino: endpoint.ino }, identity)) throw new InputRefusal('changed');
    if (!ownerOnlyDarwinPath(endpoint, uid)) throw new InputRefusal('not-owner-only');
    return;
  }
  const uid = currentUid();
  if (uid === null) throw new InputRefusal('uncheckable');
  if (opened.uid !== BigInt(uid) || (opened.mode & 0o077n) !== 0n) throw new InputRefusal('not-owner-only');
}

/** At most `maxBytes` from the descriptor, from its start; any more is `malformed`. */
function readDescriptor(fd: number, maxBytes: number): Buffer {
  const buffer = Buffer.alloc(maxBytes + 1);
  let total = 0;
  for (;;) {
    const read = fs.readSync(fd, buffer, total, buffer.length - total, total);
    if (read === 0) return buffer.subarray(0, total);
    total += read;
    if (total > maxBytes) throw new InputRefusal('malformed');
  }
}

/**
 * Reads an existing owner-only file (corrections design r6, section 2.8), every check bound to the opened descriptor:
 * 1. open first, without following a link where the platform allows it (a link there is `changed`), and without
 *    blocking where the platform has O_NONBLOCK: an open for reading of a FIFO with no writer would otherwise wait
 *    forever before step 2 could refuse it as no regular file (`malformed`); a regular file reads as before;
 * 2. the identity comes from the descriptor (fstat, BigInt: a Windows file index can exceed 2^53);
 * 3. the policy comes from that identity (assertOwnerOnlyOpened);
 * 4. the bytes are read from the descriptor, never by path;
 * 5. the path is checked again after the read, without following a link: its identity must still be the descriptor's,
 *    so a swap at any step, or a link, is `changed`. The descriptor is closed only after that check.
 * A missing file is `missing`; anything but a regular file of at most `maxBytes` is `malformed`.
 */
export function readOwnerOnlyFile(file: string, maxBytes: number, access: OutputAccess = platformOutputAccess,
  probe?: (point: OwnerOnlyReadPoint) => void): Buffer {
  if (!path.isAbsolute(file)) throw new InputRefusal('uncheckable');
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new InputRefusal(code === 'ENOENT' ? 'missing' : code === 'ELOOP' || code === 'EMLINK' ? 'changed'
      : code === 'EISDIR' ? 'malformed' : 'uncheckable');
  }
  try {
    probe?.('opened');
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.size > BigInt(maxBytes)) throw new InputRefusal('malformed');
    assertOwnerOnlyOpened(file, opened, access);
    probe?.('checked');
    const bytes = readDescriptor(fd, maxBytes);
    probe?.('read');
    let again: fs.BigIntStats | undefined;
    try {
      again = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
    } catch {
      again = undefined;
    }
    if (again === undefined || !sameIdentity(identityOf(again), identityOf(opened))) throw new InputRefusal('changed');
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}
