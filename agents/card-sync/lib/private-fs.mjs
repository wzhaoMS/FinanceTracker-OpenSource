// Owner-only folders and files, by the rule the rest of Holdr uses (ownerOnlyAcl in apps/api/src/cli/ownerOnlyOutput.ts).
// - Windows: owned by the current account, with an access list of plain allow and deny entries only, and every allow
//   entry, explicit or inherited, for the current account, SYSTEM or Administrators. The receiver gives its folders and
//   files full control for the current account and SYSTEM, nothing inherited, and makes the current account their owner,
//   as `npm run start:local` and the README's commands set up a private folder; files created inside inherit that.
// - macOS and Linux: owned by the current account, mode 0700 for folders and 0600 for files.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const SYSTEM_SID = 'S-1-5-18';
export const ADMINISTRATORS_SID = 'S-1-5-32-544';
const SID = /^S-1-\d+(?:-\d+)+$/;
const POWERSHELL_TIMEOUT_MS = 30_000;

/** A Windows program by its full path, so that nothing earlier on PATH can stand in for it. */
export const system32 = (file) => path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', file);

const sidCache = new WeakMap();

/** The current Windows account's SID, from `whoami /user`. */
export function currentUserSid(run = execFileSync) {
  if (sidCache.has(run)) return sidCache.get(run);
  const output = String(run(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }));
  const sid = /S-1-\d+(?:-\d+)+/.exec(output)?.[0];
  if (!sid) throw new Error('could not read the SID of the current Windows account');
  sidCache.set(run, sid);
  return sid;
}

function restrictWindows(target, inheritable, run) {
  const sid = currentUserSid(run);
  const rights = inheritable ? '(OI)(CI)F' : 'F';
  const icacls = (args) => run(system32('icacls.exe'), [target, ...args, '/q'], { windowsHide: true, stdio: 'ignore' });
  // /reset first: an existing folder may carry explicit entries for other accounts, which /inheritance:r keeps.
  icacls(['/reset']);
  icacls(['/inheritance:r', '/grant:r', `*${sid}:${rights}`, `*${SYSTEM_SID}:${rights}`]);
  // Taking ownership needs only the full control just granted; it fails (and the folder is refused) if it is not allowed.
  icacls(['/setowner', `*${sid}`]);
}

/**
 * Creates `dir` if needed and makes it private to the current account. Refuses symbolic links. A folder another account
 * owns is refused on macOS and Linux; on Windows the current account takes it over, or it is refused if it cannot.
 */
export function makePrivateDir(dir, { platform = process.platform, run = execFileSync } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${dir} is not a plain folder`);
  if (platform === 'win32') {
    restrictWindows(dir, true, run);
    return;
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(`${dir} belongs to another account`);
  fs.chmodSync(dir, 0o700);
}

/** Makes an existing regular file private to the current account. */
export function makePrivateFile(file, { platform = process.platform, run = execFileSync } = {}) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${file} is not a regular file`);
  if (platform === 'win32') {
    restrictWindows(file, false, run);
    return;
  }
  fs.chmodSync(file, 0o600);
}

// The owner, the raw access list's entry types (null without an access list) and every access rule, explicit, inherited
// or inherit-only, as SIDs: what the repository's ACL reader (apps/api/src/e2e/windowsAcl.ts) reads. The path reaches
// PowerShell in its environment, never on its command line.
const WINDOWS_ACL_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$sid = [System.Security.Principal.SecurityIdentifier]
$acl = Get-Acl -LiteralPath $env:CARD_SYNC_ACL_PATH
$dacl = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0).DiscretionaryAcl
$types = $null
if ($null -ne $dacl) { $types = @(foreach ($entry in $dacl) { $entry.AceType.ToString() }) }
[pscustomobject]@{
  owner = $acl.GetOwner($sid).Value
  aceTypes = $types
  aces = @(foreach ($rule in $acl.GetAccessRules($true, $true, $sid)) {
    [pscustomobject]@{ sid = $rule.IdentityReference.Value; type = $rule.AccessControlType.ToString() }
  })
} | ConvertTo-Json -Depth 4 -Compress`;

/** A list as Windows PowerShell 5.1 may write one: an array, `{ "value": [...], "Count": n }`, or its single item. */
export function asList(value) {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object' && Object.keys(value).length === 2 && Array.isArray(value.value)
    && value.Count === value.value.length) return value.value;
  return value === null || value === undefined ? null : [value];
}

/** PowerShell's answer, checked: `{ owner, aceTypes, aces: [{ sid, type }] }`; anything unexpected throws. */
export function parseWindowsAcl(output) {
  const data = JSON.parse(String(output).trim());
  if (!data || typeof data !== 'object' || !SID.test(data.owner ?? '') || !Object.hasOwn(data, 'aceTypes')) throw new Error('no owner');
  const aceTypes = data.aceTypes === null ? null : asList(data.aceTypes);
  if (aceTypes !== null && !aceTypes.every((type) => typeof type === 'string')) throw new Error('no entry types');
  const aces = asList(data.aces) ?? [];
  for (const ace of aces) {
    if (!SID.test(ace?.sid ?? '') || (ace.type !== 'Allow' && ace.type !== 'Deny')) throw new Error('an unreadable rule');
  }
  return { owner: data.owner, aceTypes, aces: aces.map(({ sid, type }) => ({ sid, type })) };
}

/**
 * Why a Windows access list is not owner-only for the account `sid`, or null: Holdr's rule (ownerOnlyAcl), which deny
 * entries never break since they only take access away.
 */
export function windowsAclProblem(acl, sid) {
  if (acl.aceTypes === null) return 'it has no access list, so everyone has access';
  if (acl.aceTypes.some((type) => type !== 'AccessAllowed' && type !== 'AccessDenied')) return 'its access list has entries that cannot be checked';
  if (acl.aces.some((ace) => ace.type !== 'Deny' && ![sid, SYSTEM_SID, ADMINISTRATORS_SID].includes(ace.sid))) return 'other accounts have access';
  if (acl.owner === ADMINISTRATORS_SID) return 'owned by the Administrators group, not by you';
  if (acl.owner !== sid) return 'owned by another account';
  return null;
}

/** The owner and access list of `target` on Windows (parseWindowsAcl's shape), read through Windows PowerShell. */
export function readWindowsAcl(target, run = execFileSync) {
  // Windows PowerShell 5.1 started from PowerShell 7 inherits PS7's module path and cannot load Get-Acl: drop it
  // (Windows variable names ignore case, so match it that way).
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'));
  const encoded = Buffer.from(WINDOWS_ACL_SCRIPT, 'utf16le').toString('base64');
  return parseWindowsAcl(run(system32('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8', windowsHide: true, timeout: POWERSHELL_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, CARD_SYNC_ACL_PATH: target },
  }));
}

/**
 * Whether `target` is private to the current account: `{ ok, problem, owner }`, where `owner` is 'current', 'other'
 * (on Windows also 'administrators'), or null when it could not be read. On Windows this reads the owner and access list
 * through PowerShell (about a second), so the receiver runs it only for `check`, never on every start.
 */
export function inspectPrivate(target, { platform = process.platform, run = execFileSync } = {}) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return { ok: false, problem: 'missing', owner: null };
  }
  if (stat.isSymbolicLink()) return { ok: false, problem: 'symbolic link', owner: null };
  if (platform === 'win32') {
    let acl;
    let sid;
    try {
      acl = readWindowsAcl(target, run);
      sid = currentUserSid(run);
    } catch {
      return { ok: false, problem: 'access list could not be read', owner: null };
    }
    const problem = windowsAclProblem(acl, sid);
    const owner = acl.owner === sid ? 'current' : acl.owner === ADMINISTRATORS_SID ? 'administrators' : 'other';
    return { ok: problem === null, problem, owner };
  }
  const owner = typeof process.getuid === 'function' ? (stat.uid === process.getuid() ? 'current' : 'other') : null;
  if (owner === 'other') return { ok: false, problem: 'owned by another account', owner };
  if ((stat.mode & 0o077) !== 0) return { ok: false, problem: `mode ${(stat.mode & 0o777).toString(8)} lets other accounts in`, owner };
  return { ok: true, problem: null, owner };
}
