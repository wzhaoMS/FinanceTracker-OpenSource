import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMINISTRATORS_SID, SYSTEM_SID, readCurrentUserSid, readWindowsAcls, type WindowsAcl } from '../../e2e/windowsAcl.js';
import { refuse } from './policy.js';
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

export function privateAcl(acl: WindowsAcl, owner: string): boolean {
  return acl.owner === owner && acl.aceTypes !== null
    && acl.aceTypes.every(t => t === 'AccessAllowed' || t === 'AccessDenied')
    && acl.aces.every(a => a.type === 'Deny' || [owner, SYSTEM_SID, ADMINISTRATORS_SID].includes(a.sid));
}
/** Never repair ACLs on existing operator files. No native paths/errors escape the CLI. */
export function assertPrivate(target: string): void {
  if (!path.isAbsolute(target)) return refuse();
  const relative = path.relative(repository, target);
  if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) return refuse();
  let current = path.resolve(target);
  for (;;) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) return refuse();
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const stat = fs.lstatSync(target);
  if ((!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) return refuse();
  if (process.platform === 'win32') {
    if (!privateAcl(readWindowsAcls([target])[0], readCurrentUserSid())) return refuse();
  } else if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) return refuse();
}
export function readPrivateJson(file: string): unknown {
  assertPrivate(path.dirname(file));
  assertPrivate(file);
  if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 2 * 1024 * 1024) return refuse();
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
/** A new owner-only JSON file in an owner-only directory, of at most `maxBytes` (2 MiB unless a caller's input allows more). */
export function writePrivateJson(file: string, value: unknown, maxBytes = 2 * 1024 * 1024): void {
  const content = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(content, 'utf8') > maxBytes) return refuse();
  assertPrivate(path.dirname(file));
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    assertPrivate(file);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
