import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * Windows directory privacy, by SID. Node reports every file and directory on
 * Windows as mode 0o666 (0o444 when read-only), whatever its ACL says, so on
 * Windows pathSafety.ts reads each directory's owner and access rules through
 * PowerShell instead. Principals
 * are compared only as SIDs and rights as numbers, so nothing depends on the
 * display language. The script is a constant and the paths reach it in an
 * environment variable, never inside the command line. Anything unexpected
 * (a PowerShell error, a timeout, output other than the JSON asked for, a
 * value that is not a SID, an ACL entry type that cannot be checked) refuses.
 */

export interface WindowsAce {
  sid: string;
  /** FileSystemRights as an unsigned 32-bit mask. */
  rights: number;
  type: 'Allow' | 'Deny';
}

export interface WindowsAcl {
  owner: string;
  /** Every access rule, explicit and inherited, inherit-only ones included. */
  aces: WindowsAce[];
  /** The type of each entry in the raw DACL (AceType names), or null when there is no DACL. */
  aceTypes: string[] | null;
}

export const SYSTEM_SID = 'S-1-5-18';
export const ADMINISTRATORS_SID = 'S-1-5-32-544';
export const CREATOR_OWNER_SID = 'S-1-3-0';

export const TRUSTED_INSTALLER_SID = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';

/** Names for messages only; decisions use the SIDs. */
const WELL_KNOWN_NAMES: Record<string, string> = {
  'S-1-1-0': 'Everyone',
  'S-1-2-0': 'LOCAL',
  'S-1-3-0': 'CREATOR OWNER',
  'S-1-3-4': 'OWNER RIGHTS',
  'S-1-5-2': 'NETWORK',
  'S-1-5-4': 'INTERACTIVE',
  'S-1-5-6': 'SERVICE',
  'S-1-5-7': 'ANONYMOUS LOGON',
  'S-1-5-11': 'Authenticated Users',
  'S-1-5-18': 'SYSTEM',
  'S-1-5-19': 'LOCAL SERVICE',
  'S-1-5-20': 'NETWORK SERVICE',
  'S-1-5-32-544': 'Administrators',
  'S-1-5-32-545': 'Users',
  'S-1-5-32-546': 'Guests',
  'S-1-5-32-547': 'Power Users',
  'S-1-5-32-551': 'Backup Operators',
  'S-1-5-113': 'Local account',
  'S-1-5-114': 'Local account and member of Administrators group',
  'S-1-15-2-1': 'ALL APPLICATION PACKAGES',
  'S-1-15-2-2': 'ALL RESTRICTED APPLICATION PACKAGES',
  [TRUSTED_INSTALLER_SID]: 'TrustedInstaller',
};

const SID_PATTERN = /^S-1-\d+(-\d+)+$/;

/**
 * FileSystemRights bits that let a principal change a directory, its
 * entries or its security, including the generic bits of inherit-only rules.
 */
export const WRITE_RIGHTS = 0x2 // WriteData / AddFile
  | 0x4 // AppendData / AddSubdirectory
  | 0x10 // WriteExtendedAttributes
  | 0x40 // DeleteSubdirectoriesAndFiles (DeleteChild)
  | 0x100 // WriteAttributes
  | 0x10000 // Delete
  | 0x40000 // ChangePermissions (WRITE_DAC)
  | 0x80000 // TakeOwnership (WRITE_OWNER)
  | 0x10000000 // GENERIC_ALL
  | 0x40000000; // GENERIC_WRITE

export const POWERSHELL_TIMEOUT_MS = 30_000;

/** Runs a PowerShell script given as -EncodedCommand text, with extra environment; returns stdout. */
export type PowerShellRunner = (encodedScript: string, env: Record<string, string>) => string;

/** The same without blocking: resolves to stdout. Failures look like execFileSync's (status, stderr, code 'ETIMEDOUT'). */
export type AsyncPowerShellRunner = (encodedScript: string, env: Record<string, string>) => Promise<string>;

/** Runs a program (no shell); throws unless it exits 0. */
export type CommandRunner = (file: string, args: string[]) => void;

/** A program in System32, by absolute path: a bare name would be looked up in the working directory first. */
export function system32(file: string): string {
  return path.win32.join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', file);
}

const powerShell = () => system32('WindowsPowerShell\\v1.0\\powershell.exe');
const powerShellArgs = (encodedScript: string) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedScript];

/**
 * The environment for Windows PowerShell 5.1: this process's, without PSModulePath (in any casing). PowerShell 7 exports
 * its own module path, and 5.1 started under it cannot load Microsoft.PowerShell.Security, so Get-Acl would fail.
 */
export function windowsPowerShellEnv(extra: NodeJS.ProcessEnv = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) if (key.toLowerCase() !== 'psmodulepath') env[key] = value;
  return { ...env, ...extra };
}

export const runPowerShell: PowerShellRunner = (encodedScript, env) => execFileSync(powerShell(), powerShellArgs(encodedScript), {
  env: windowsPowerShellEnv(env),
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: POWERSHELL_TIMEOUT_MS,
  windowsHide: true,
  maxBuffer: 4 << 20,
});

export const runPowerShellAsync: AsyncPowerShellRunner = (encodedScript, env) => new Promise((resolve, reject) => {
  execFile(powerShell(), powerShellArgs(encodedScript), {
    env: windowsPowerShellEnv(env),
    encoding: 'utf8',
    timeout: POWERSHELL_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 4 << 20,
  }, (error, stdout, stderr) => {
    if (!error) {
      resolve(stdout);
      return;
    }
    const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
    if (typeof code === 'number') reject(Object.assign(new Error(error.message), { status: code, stderr }));
    else if (code == null && error.killed) reject(Object.assign(new Error('PowerShell was stopped after the timeout'), { code: 'ETIMEDOUT' }));
    else reject(error);
  });
});

export const runCommand: CommandRunner = (file, args) => {
  execFileSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true });
};

/** PowerShell's -EncodedCommand form: base64 of the UTF-16LE script. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export const USER_SID_SCRIPT = `$ErrorActionPreference = 'Stop'
[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value`;

/**
 * Owner, access rules and raw DACL entry types of every path in
 * $env:HOLDR_ACL_PATHS ('|'-separated: no Windows path contains '|'), as
 * SIDs and numbers. No path is printed back.
 */
export const ACL_SCRIPT = `$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.SecurityIdentifier]
$result = foreach ($p in ($env:HOLDR_ACL_PATHS -split '\\|')) {
  $acl = Get-Acl -LiteralPath $p
  $dacl = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0).DiscretionaryAcl
  $types = $null
  if ($null -ne $dacl) { $types = @(foreach ($entry in $dacl) { $entry.AceType.ToString() }) }
  [pscustomobject]@{
    owner = $acl.GetOwner($sid).Value
    aceTypes = $types
    aces = @(foreach ($rule in $acl.GetAccessRules($true, $true, $sid)) {
      [pscustomobject]@{
        sid = $rule.IdentityReference.Value
        rights = [int64][int]$rule.FileSystemRights
        type = $rule.AccessControlType.ToString()
      }
    })
  }
}
ConvertTo-Json -InputObject @($result) -Depth 5 -Compress`;

function isSid(value: unknown): value is string {
  return typeof value === 'string' && SID_PATTERN.test(value);
}

function describeSid(sid: string): string {
  const name = WELL_KNOWN_NAMES[sid];
  return name ? `${name} (${sid})` : sid;
}

function failureReason(error: unknown): string {
  const failure = error as NodeJS.ErrnoException & { status?: number | null; stderr?: unknown };
  if (failure.code === 'ETIMEDOUT') return `PowerShell did not answer within ${POWERSHELL_TIMEOUT_MS / 1000}s`;
  if (typeof failure.status === 'number') {
    const detail = String(failure.stderr ?? '').trim().split(/\r?\n/)[0]?.slice(0, 200);
    return `PowerShell exited with code ${failure.status}${detail ? `: ${detail}` : ''}`;
  }
  return String(failure.message ?? error).split('\n')[0].slice(0, 200);
}

/** The current user's SID, from WindowsIdentity. */
export function readCurrentUserSid(run: PowerShellRunner = runPowerShell): string {
  let output: string;
  try {
    output = run(encodePowerShell(USER_SID_SCRIPT), {}).trim();
  } catch (error) {
    throw new Error(`could not read the current user's SID (${failureReason(error)})`);
  }
  if (!SID_PATTERN.test(output)) throw new Error(`PowerShell printed ${JSON.stringify(output.slice(0, 80))} instead of the current user's SID`);
  return output;
}

/** An array, also as Windows PowerShell 5.1 sometimes writes one: { "value": [...], "Count": n }. */
function asArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object') {
    const { value: items, Count: count } = value as { value?: unknown; Count?: unknown };
    if (Object.keys(value).length === 2 && Array.isArray(items) && count === items.length) return items;
  }
  return null;
}

/** Validate PowerShell's JSON: exactly `count` entries, SIDs only, numeric rights, Allow or Deny. */
export function parseWindowsAcls(stdout: string, count: number): WindowsAcl[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`PowerShell printed something other than the JSON asked for: ${JSON.stringify(stdout.slice(0, 80))}`);
  }
  const entries = asArray(data) ?? [data];
  if (entries.length !== count) throw new Error(`PowerShell described ${entries.length} directories instead of ${count}`);
  return entries.map((entry, index) => {
    if (entry === null || typeof entry !== 'object') throw new Error(`entry ${index} is not an object`);
    const { owner, aces, aceTypes } = entry as { owner?: unknown; aces?: unknown; aceTypes?: unknown };
    if (!isSid(owner)) throw new Error(`entry ${index}: the owner ${JSON.stringify(owner)} is not a SID`);
    const rules = asArray(aces) ?? (aces !== null && typeof aces === 'object' ? [aces] : null);
    if (!rules) throw new Error(`entry ${index}: no list of access rules`);
    let types: string[] | null = null;
    if (aceTypes !== null) {
      const list = asArray(aceTypes) ?? (typeof aceTypes === 'string' ? [aceTypes] : null);
      if (!list || !list.every((type): type is string => typeof type === 'string')) {
        throw new Error(`entry ${index}: no list of ACL entry types`);
      }
      types = list;
    }
    return {
      owner,
      aceTypes: types,
      aces: rules.map((rule) => {
        const { sid, rights, type } = (rule ?? {}) as { sid?: unknown; rights?: unknown; type?: unknown };
        if (!isSid(sid)) throw new Error(`entry ${index}: an access rule names ${JSON.stringify(sid)}, not a SID`);
        if (typeof rights !== 'number' || !Number.isInteger(rights)) {
          throw new Error(`entry ${index}: rights ${JSON.stringify(rights)} are not an integer`);
        }
        if (type !== 'Allow' && type !== 'Deny') throw new Error(`entry ${index}: access type ${JSON.stringify(type)} is neither Allow nor Deny`);
        return { sid, rights: rights >>> 0, type };
      }),
    };
  });
}

function assertPassable(paths: readonly string[]): void {
  if (paths.some((p) => p.includes('|') || p === '')) throw new Error('cannot pass an empty path or one containing "|" to PowerShell');
}

/** Owner and access rules of each path, in order, read through one PowerShell call. */
export function readWindowsAcls(paths: readonly string[], run: PowerShellRunner = runPowerShell): WindowsAcl[] {
  if (paths.length === 0) return [];
  assertPassable(paths);
  let stdout: string;
  try {
    stdout = run(encodePowerShell(ACL_SCRIPT), { HOLDR_ACL_PATHS: paths.join('|') });
  } catch (error) {
    throw new Error(`could not read the owner and ACL (${failureReason(error)})`);
  }
  return parseWindowsAcls(stdout, paths.length);
}

/** readWindowsAcls without blocking the event loop (the API's /health). */
export async function readWindowsAclsAsync(paths: readonly string[], run: AsyncPowerShellRunner = runPowerShellAsync): Promise<WindowsAcl[]> {
  if (paths.length === 0) return [];
  assertPassable(paths);
  let stdout: string;
  try {
    stdout = await run(encodePowerShell(ACL_SCRIPT), { HOLDR_ACL_PATHS: paths.join('|') });
  } catch (error) {
    throw new Error(`could not read the owner and ACL (${failureReason(error)})`);
  }
  return parseWindowsAcls(stdout, paths.length);
}

/** A file's owner and access rules, with the identity of the very object they were read from (its volume and file index). */
export interface WindowsFileAcl extends WindowsAcl {
  /** The volume serial number, in decimal: what Node's fstat reports as `dev`. */
  volume: string;
  /** The 64-bit file index, in decimal: what Node's fstat reports as `ino`. */
  index: string;
}

/**
 * The owner, access rules and raw DACL entry types of the file in $env:HOLDR_ACL_FILE, and its volume serial number and
 * file index, all read through ONE handle (corrections design r6, section 2.8: the policy is bound to the identity of the
 * object it was read from). The handle shares read, write and delete, so it never blocks the caller's own descriptor.
 * No path is printed back.
 */
export const FILE_ACL_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class HoldrFileIdentity {
  [StructLayout(LayoutKind.Sequential)]
  public struct Information {
    public uint Attributes;
    public uint CreationLow;
    public uint CreationHigh;
    public uint AccessLow;
    public uint AccessHigh;
    public uint WriteLow;
    public uint WriteHigh;
    public uint VolumeSerialNumber;
    public uint SizeHigh;
    public uint SizeLow;
    public uint Links;
    public uint IndexHigh;
    public uint IndexLow;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Information information);
}
'@
$sid = [System.Security.Principal.SecurityIdentifier]
$share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
$stream = [System.IO.File]::Open($env:HOLDR_ACL_FILE, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)
try {
  $information = New-Object HoldrFileIdentity+Information
  if (-not [HoldrFileIdentity]::GetFileInformationByHandle($stream.SafeFileHandle, [ref]$information)) { throw 'no file information' }
  $acl = $stream.GetAccessControl()
  $dacl = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0).DiscretionaryAcl
  $types = $null
  if ($null -ne $dacl) { $types = @(foreach ($entry in $dacl) { $entry.AceType.ToString() }) }
  $index = ([uint64]$information.IndexHigh -shl 32) -bor [uint64]$information.IndexLow
  ConvertTo-Json -Compress -Depth 5 -InputObject ([pscustomobject]@{
    volume = ([uint64]$information.VolumeSerialNumber).ToString()
    index = $index.ToString()
    owner = $acl.GetOwner($sid).Value
    aceTypes = $types
    aces = @(foreach ($rule in $acl.GetAccessRules($true, $true, $sid)) {
      [pscustomobject]@{
        sid = $rule.IdentityReference.Value
        rights = [int64][int]$rule.FileSystemRights
        type = $rule.AccessControlType.ToString()
      }
    })
  })
} finally {
  $stream.Dispose()
}`;

/** FILE_ACL_SCRIPT's JSON: the ACL as parseWindowsAcls checks it, and the identity as two decimal strings. */
export function parseWindowsFileAcl(stdout: string): WindowsFileAcl {
  const [acl] = parseWindowsAcls(stdout, 1);
  const { volume, index } = JSON.parse(stdout.trim()) as { volume?: unknown; index?: unknown };
  const decimal = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value);
  if (!decimal(volume) || !decimal(index)) throw new Error('PowerShell reported no identity for the file it read');
  return { ...acl, volume, index };
}

/** A file's owner, access rules and identity, read through one handle in one PowerShell call. */
export function readWindowsFileAcl(file: string, run: PowerShellRunner = runPowerShell): WindowsFileAcl {
  assertPassable([file]);
  let stdout: string;
  try {
    stdout = run(encodePowerShell(FILE_ACL_SCRIPT), { HOLDR_ACL_FILE: file });
  } catch (error) {
    throw new Error(`could not read the file's owner, ACL and identity (${failureReason(error)})`);
  }
  return parseWindowsFileAcl(stdout);
}

/**
 * Why `acl` does not keep a directory private, or null. The owner must be
 * one of `owners`. Every Allow rule that grants a write-capable right must
 * name the current user, SYSTEM, Administrators, or CREATOR OWNER (only
 * while the owner is the current user); Deny rules only take rights away.
 * There must be a DACL (none lets everyone in) holding only plain allow and
 * deny entries: callback or object entries are not checked, so they refuse.
 */
export function windowsAclProblem(acl: WindowsAcl, userSid: string, owners: readonly string[]): string | null {
  if (!isSid(userSid)) return `cannot be checked: ${JSON.stringify(userSid)} is not a SID for the current user`;
  if (!owners.includes(acl.owner)) {
    return `is owned by ${describeSid(acl.owner)}, not by ${owners.map((owner) => (owner === userSid ? `the current user (${owner})` : describeSid(owner))).join(' or ')}`;
  }
  if (acl.aceTypes === null) return 'has no DACL, which gives everyone full access';
  const unchecked = acl.aceTypes.find((type) => type !== 'AccessAllowed' && type !== 'AccessDenied');
  if (unchecked) return `has an ACL entry of type ${unchecked}, which cannot be checked`;
  for (const ace of acl.aces) {
    if (ace.type !== 'Allow') continue;
    const rights = ace.rights >>> 0;
    if ((rights & WRITE_RIGHTS) === 0) continue;
    if (ace.sid === userSid || ace.sid === SYSTEM_SID || ace.sid === ADMINISTRATORS_SID) continue;
    if (ace.sid === CREATOR_OWNER_SID && acl.owner === userSid) continue;
    return `has an ACL that lets ${describeSid(ace.sid)} write to it (rights 0x${rights.toString(16)})`;
  }
  return null;
}

/**
 * Replace `dir`'s ACL with full control for the current user and SYSTEM,
 * inherited by everything created inside it, and drop everything inherited
 * from above. SIDs only, so the result does not depend on the display language.
 */
export function restrictToUser(dir: string, userSid: string, run: CommandRunner = runCommand): void {
  if (!isSid(userSid)) throw new Error(`${JSON.stringify(userSid)} is not a SID`);
  try {
    run(system32('icacls.exe'), [dir, '/inheritance:r', '/grant:r', `*${userSid}:(OI)(CI)F`, `*${SYSTEM_SID}:(OI)(CI)F`]);
  } catch (error) {
    throw new Error(`could not restrict ${dir} to the current user with icacls (${String((error as Error).message).split('\n')[0].slice(0, 200)})`);
  }
}

/**
 * Make the current user the owner of a directory it just created: an elevated shell creates objects owned by
 * Administrators, which an owner-only check (`owner === user`) would refuse. SIDs only.
 */
export function takeOwnership(dir: string, userSid: string, run: CommandRunner = runCommand): void {
  if (!isSid(userSid)) throw new Error(`${JSON.stringify(userSid)} is not a SID`);
  try {
    run(system32('icacls.exe'), [dir, '/setowner', `*${userSid}`]);
  } catch (error) {
    throw new Error(`could not make the current user the owner of ${dir} with icacls (${String((error as Error).message).split('\n')[0].slice(0, 200)})`);
  }
}
