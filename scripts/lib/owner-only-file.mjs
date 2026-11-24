// Writes text that may hold real data (the cards scripts/insights-preview.mts --values writes, with real merchants and
// amounts) to a file only the current user can read, never leaving it readable by others even for a moment. Plain Node,
// so its tests run under `node --test`; the Windows ACL steps are passed in (the preview passes the API's SID-based
// helpers from apps/api/src/e2e/windowsAcl.ts), so nothing here depends on the display language.
//
// The caller must first have checked that the target's directory, and every directory above it, can be changed by no
// one else (the preview uses the e2e runner's assertPrivateDirectory and assertTrustedAncestors): otherwise another
// user could change the new file's ACL, or swap a directory, while it is being made.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A refusal with a fixed message: safe to print, as it names no path or value. */
export class OwnerOnlyRefusal extends Error {}

/**
 * @typedef {object} WindowsAccess
 * @property {() => string} currentUserSid The current user's SID.
 * @property {(dir: string, sid: string) => void} restrictDirectory Replace a directory's ACL with entries for `sid` (and
 *   the system) that every file created in it inherits, and nothing inherited from above.
 * @property {(file: string, sid: string) => void} restrictToUser Replace a file's ACL with one entry, full control for
 *   `sid`, and nothing inherited.
 * @property {(file: string) => { aces: Array<{ sid: string, type: string }>, aceTypes: string[] | null }} readAcl The
 *   file's access rules (explicit and inherited) as SIDs, and the types of its raw DACL entries (null: no DACL).
 */

/**
 * macOS: the ACL entries of `file` that allow anyone but the current user anything. macOS ACLs are not masked by the
 * mode, so a file made 0600 can still be read through an entry it inherited from its directory. Entries that cannot be
 * parsed count. (POSIX ACLs elsewhere are masked by the group bits of the mode, which are 0 here.) Its own diagnostics
 * are kept, never forwarded: they name the file.
 *
 * @param {string} file
 * @returns {string[]}
 */
export function macAclGrants(file) {
  const listing = execFileSync('/bin/ls', ['-lde', '--', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const self = `user:${os.userInfo().username}`;
  return listing.split('\n').slice(1).map((line) => line.trim()).filter((entry) => {
    if (!entry) return false;
    const match = /^\d+:\s+(\S+)\s+(?:inherited\s+)?(allow|deny)\s+\S+/.exec(entry);
    return !match || (match[2] === 'allow' && match[1] !== self);
  });
}

/**
 * Write `text` to `target`, replacing any file there, so that only the current user can read it. A new file is made
 * beside it and checked before a byte is written, then renamed over `target`, so whatever was there is replaced
 * whole, never written through.
 *
 * - POSIX: the new file is created with mode 0600 (and checked); on macOS, a file that inherited an ACL entry allowing
 *   anyone else anything is refused before it is written to.
 * - Windows: a file's ACL can only be set once it exists, so the new file is created inside a new directory
 *   restricted first, and no one else can open it at any moment; its own ACL is then set to one entry, the current
 *   user, with nothing inherited, and read back by SID to check.
 *
 * Anything unexpected removes what was made, with anything written into it, and leaves `target` as it was. Refusals
 * are OwnerOnlyRefusal; other errors are the file system's.
 *
 * @param {string} target
 * @param {string} text
 * @param {{ platform?: NodeJS.Platform, windows?: WindowsAccess, aclGrants?: (file: string) => string[] }} [options]
 */
export function writeOwnerOnlyFile(target, text, { platform = process.platform, windows, aclGrants = macAclGrants } = {}) {
  const directory = path.dirname(target);
  const base = path.basename(target);
  if (platform === 'win32' && !windows) throw new OwnerOnlyRefusal('cannot restrict a file on Windows without its ACL helpers');
  let privateDirectory = null;
  let temp = null;
  let fd = null;
  try {
    if (platform === 'win32') {
      const sid = windows.currentUserSid();
      privateDirectory = fs.mkdtempSync(path.join(directory, `.${base}.`));
      windows.restrictDirectory(privateDirectory, sid);
      temp = path.join(privateDirectory, `${randomBytes(6).toString('hex')}.tmp`);
      fd = fs.openSync(temp, 'wx', 0o600);
      windows.restrictToUser(temp, sid);
      const acl = windows.readAcl(temp);
      const alone = acl.aceTypes !== null && acl.aceTypes.length === 1 && acl.aceTypes[0] === 'AccessAllowed'
        && acl.aces.length === 1 && acl.aces[0].sid === sid && acl.aces[0].type === 'Allow';
      if (!alone) throw new OwnerOnlyRefusal('the new file would not be readable by you alone');
    } else {
      temp = path.join(directory, `.${base}.${randomBytes(6).toString('hex')}.tmp`);
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.fchmodSync(fd, 0o600);
      if ((fs.fstatSync(fd).mode & 0o777) !== 0o600) throw new OwnerOnlyRefusal('the new file would not be readable by you alone');
      if (platform === 'darwin' && aclGrants(temp).length > 0) {
        throw new OwnerOnlyRefusal('the directory gives new files an ACL that lets someone else in');
      }
    }
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, target);
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* the failure that brought us here is the one to report */ }
    }
    if (privateDirectory !== null) fs.rmSync(privateDirectory, { recursive: true, force: true });
    else if (temp !== null) fs.rmSync(temp, { force: true });
    throw error;
  }
  // The file is in place: the private directory is empty, and harmless if it cannot be removed.
  if (privateDirectory !== null) {
    try { fs.rmdirSync(privateDirectory); } catch { /* harmless */ }
  }
}
