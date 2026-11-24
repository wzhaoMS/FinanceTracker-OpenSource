import { describe, expect, it } from 'vitest';

import {
  ACL_SCRIPT,
  ADMINISTRATORS_SID,
  CREATOR_OWNER_SID,
  FILE_ACL_SCRIPT,
  SYSTEM_SID,
  TRUSTED_INSTALLER_SID,
  USER_SID_SCRIPT,
  WRITE_RIGHTS,
  parseWindowsAcls,
  parseWindowsFileAcl,
  readCurrentUserSid,
  readWindowsAcls,
  readWindowsFileAcl,
  restrictToUser,
  system32,
  takeOwnership,
  windowsAclProblem,
  windowsPowerShellEnv,
  type PowerShellRunner,
} from './windowsAcl.js';
import {
  AUTHENTICATED_USERS,
  EVERYONE,
  FULL_CONTROL,
  GENERIC_ALL,
  GENERIC_READ_EXECUTE_INT32,
  GENERIC_WRITE,
  MODIFY,
  OTHER_USER,
  PROFILE,
  READ_AND_EXECUTE,
  RESTRICTED,
  UNDER_DRIVE_ROOT,
  USER,
  USERS,
  acl,
  allow,
  deny,
} from './__fixtures__/windowsAcls.js';

const PRIVATE_OWNERS = [USER];
const ANCESTOR_OWNERS = [USER, SYSTEM_SID, ADMINISTRATORS_SID];

describe('windowsAclProblem', () => {
  it('accepts a directory only the user, SYSTEM and Administrators can write to', () => {
    expect(windowsAclProblem(RESTRICTED, USER, PRIVATE_OWNERS)).toBeNull();
    expect(windowsAclProblem(PROFILE, USER, PRIVATE_OWNERS)).toBeNull();
  });

  it('refuses the inherited "Authenticated Users: Modify" of a checkout under C:\\', () => {
    expect(windowsAclProblem(UNDER_DRIVE_ROOT, USER, PRIVATE_OWNERS))
      .toBe('has an ACL that lets Authenticated Users (S-1-5-11) write to it (rights 0x1301bf)');
  });

  it.each([
    ['Everyone', EVERYONE, FULL_CONTROL, /Everyone \(S-1-1-0\)/],
    ['Users', USERS, MODIFY, /Users \(S-1-5-32-545\)/],
    ['another user (a SID it does not know)', OTHER_USER, MODIFY, new RegExp(OTHER_USER)],
  ])('refuses a write grant to %s', (_, sid, rights, message) => {
    expect(windowsAclProblem(acl(USER, [...RESTRICTED.aces, allow(sid, rights)]), USER, PRIVATE_OWNERS)).toMatch(message);
  });

  it('refuses every write-capable right on its own, the generic ones included', () => {
    const writeBits = [0x2, 0x4, 0x10, 0x40, 0x100, 0x10000, 0x40000, 0x80000, GENERIC_ALL, GENERIC_WRITE];
    expect(writeBits.reduce((all, bit) => all | bit, 0)).toBe(WRITE_RIGHTS);
    for (const bit of writeBits) {
      expect(windowsAclProblem(acl(USER, [...RESTRICTED.aces, allow(USERS, bit)]), USER, PRIVATE_OWNERS), `0x${bit.toString(16)}`)
        .toMatch(/lets Users \(S-1-5-32-545\) write/);
    }
  });

  it('accepts read-only grants to others, also generic ones that print as negative numbers', () => {
    for (const rights of [0x1, 0x8, 0x20, 0x80, 0x20000, 0x100000, READ_AND_EXECUTE, GENERIC_READ_EXECUTE_INT32 >>> 0]) {
      expect(windowsAclProblem(acl(USER, [...RESTRICTED.aces, allow(EVERYONE, rights)]), USER, PRIVATE_OWNERS)).toBeNull();
    }
  });

  it('ignores deny rules, which only take rights away, but never lets one excuse an allow', () => {
    expect(windowsAclProblem(acl(USER, [deny(EVERYONE, FULL_CONTROL), ...RESTRICTED.aces]), USER, PRIVATE_OWNERS)).toBeNull();
    expect(windowsAclProblem(acl(USER, [deny(USERS, MODIFY), ...RESTRICTED.aces, allow(USERS, MODIFY)]), USER, PRIVATE_OWNERS))
      .toMatch(/lets Users/);
  });

  it('allows CREATOR OWNER only while the owner is the current user', () => {
    const creatorOwner = (owner: string) => acl(owner, [...PROFILE.aces, allow(CREATOR_OWNER_SID, FULL_CONTROL)]);
    expect(windowsAclProblem(creatorOwner(USER), USER, ANCESTOR_OWNERS)).toBeNull();
    expect(windowsAclProblem(creatorOwner(ADMINISTRATORS_SID), USER, ANCESTOR_OWNERS))
      .toMatch(/lets CREATOR OWNER \(S-1-3-0\) write/);
  });

  it('requires the current user as the owner of a private directory, and allows SYSTEM or Administrators above it', () => {
    for (const owner of [OTHER_USER, ADMINISTRATORS_SID, SYSTEM_SID]) {
      expect(windowsAclProblem(acl(owner, RESTRICTED.aces), USER, PRIVATE_OWNERS)).toMatch(/^is owned by .*, not by the current user/);
    }
    expect(windowsAclProblem(acl(ADMINISTRATORS_SID, PROFILE.aces), USER, ANCESTOR_OWNERS)).toBeNull();
    expect(windowsAclProblem(acl(SYSTEM_SID, PROFILE.aces), USER, ANCESTOR_OWNERS)).toBeNull();
    expect(windowsAclProblem(acl(OTHER_USER, PROFILE.aces), USER, ANCESTOR_OWNERS)).toMatch(/is owned by S-1-5-21-.*-1002/);
  });

  it('names well-known owners and principals, e.g. TrustedInstaller, which owns C:\\ on Windows 11 25H2', () => {
    expect(windowsAclProblem(acl(TRUSTED_INSTALLER_SID, PROFILE.aces), USER, ANCESTOR_OWNERS)).toBe(
      `is owned by TrustedInstaller (${TRUSTED_INSTALLER_SID}), not by the current user (${USER}) or SYSTEM (S-1-5-18) or Administrators (S-1-5-32-544)`,
    );
    expect(windowsAclProblem(acl(USER, [...RESTRICTED.aces, allow('S-1-15-2-1', MODIFY)]), USER, PRIVATE_OWNERS))
      .toBe('has an ACL that lets ALL APPLICATION PACKAGES (S-1-15-2-1) write to it (rights 0x1301bf)');
  });

  it('refuses a missing DACL and entries it cannot check', () => {
    expect(windowsAclProblem({ ...RESTRICTED, aceTypes: null }, USER, PRIVATE_OWNERS)).toMatch(/no DACL/);
    expect(windowsAclProblem({ ...RESTRICTED, aceTypes: ['AccessAllowed', 'AccessAllowedCallback'] }, USER, PRIVATE_OWNERS))
      .toMatch(/type AccessAllowedCallback, which cannot be checked/);
  });

  it('refuses when the current user is not a SID', () => {
    expect(windowsAclProblem(RESTRICTED, '', PRIVATE_OWNERS)).toMatch(/cannot be checked/);
    expect(windowsAclProblem(RESTRICTED, 'DESKTOP\\me', PRIVATE_OWNERS)).toMatch(/cannot be checked/);
  });
});

describe('parseWindowsAcls', () => {
  const entry = (owner: string, aces: unknown, aceTypes: unknown = ['AccessAllowed']) => ({ owner, aceTypes, aces });

  it('reads what the script prints, with rights as unsigned masks', () => {
    const stdout = `${JSON.stringify([
      entry(USER, [{ sid: USER, rights: FULL_CONTROL, type: 'Allow' }, { sid: EVERYONE, rights: GENERIC_READ_EXECUTE_INT32, type: 'Deny' }], ['AccessAllowed', 'AccessDenied']),
      entry(SYSTEM_SID, [], null),
    ])}\r\n`;
    expect(parseWindowsAcls(stdout, 2)).toEqual([
      { owner: USER, aceTypes: ['AccessAllowed', 'AccessDenied'], aces: [allow(USER, FULL_CONTROL), deny(EVERYONE, 0xa0000000)] },
      { owner: SYSTEM_SID, aceTypes: null, aces: [] },
    ]);
  });

  it('accepts the shapes Windows PowerShell 5.1 may print for one-element arrays', () => {
    const rule = { sid: USER, rights: FULL_CONTROL, type: 'Allow' };
    const expected = [{ owner: USER, aceTypes: ['AccessAllowed'], aces: [allow(USER, FULL_CONTROL)] }];
    expect(parseWindowsAcls(JSON.stringify(entry(USER, rule, 'AccessAllowed')), 1)).toEqual(expected);
    expect(parseWindowsAcls(JSON.stringify({ value: [entry(USER, { value: [rule], Count: 1 }, { value: ['AccessAllowed'], Count: 1 })], Count: 1 }), 1))
      .toEqual(expected);
  });

  it.each([
    ['an error message', 'Get-Acl : Access is denied', /something other than the JSON/],
    ['nothing', '', /something other than the JSON/],
    ['HTML', '<html>proxy error</html>', /something other than the JSON/],
    ['null entries', '[null,null]', /entry 0 is not an object/],
    ['too few entries', JSON.stringify([entry(USER, [])]), /described 1 directories instead of 2/],
    ['an account name as the owner', JSON.stringify([entry('BUILTIN\\Administrators', []), entry(USER, [])]), /owner "BUILTIN\\\\Administrators" is not a SID/],
    ['a truncated SID', JSON.stringify([entry('S-1-5-', []), entry(USER, [])]), /is not a SID/],
    ['an account name in a rule', JSON.stringify([entry(USER, [{ sid: 'Everyone', rights: 1, type: 'Allow' }]), entry(USER, [])]), /names "Everyone", not a SID/],
    ['rights as text', JSON.stringify([entry(USER, [{ sid: USER, rights: 'FullControl', type: 'Allow' }]), entry(USER, [])]), /not an integer/],
    ['fractional rights', JSON.stringify([entry(USER, [{ sid: USER, rights: 1.5, type: 'Allow' }]), entry(USER, [])]), /not an integer/],
    ['an audit rule', JSON.stringify([entry(USER, [{ sid: USER, rights: 1, type: 'Audit' }]), entry(USER, [])]), /neither Allow nor Deny/],
    ['no rule list', JSON.stringify([entry(USER, null), entry(USER, [])]), /no list of access rules/],
    ['bad entry types', JSON.stringify([entry(USER, [], [1]), entry(USER, [])]), /no list of ACL entry types/],
  ])('refuses %s', (_, stdout, message) => {
    expect(() => parseWindowsAcls(stdout, 2)).toThrow(message);
  });
});

describe('the PowerShell and icacls calls', () => {
  const decode = (encoded: string) => Buffer.from(encoded, 'base64').toString('utf16le');

  it('passes the paths in HOLDR_ACL_PATHS to a constant script that reads SIDs and numeric rights', () => {
    const paths = ["C:\\Users\\me\\it's [odd] $(name)", 'C:\\Users\\me'];
    const calls: { script: string; env: Record<string, string> }[] = [];
    const run: PowerShellRunner = (encoded, env) => {
      calls.push({ script: decode(encoded), env });
      return JSON.stringify([entry(), entry()]);
      function entry() {
        return { owner: USER, aceTypes: ['AccessAllowed'], aces: [{ sid: USER, rights: FULL_CONTROL, type: 'Allow' }] };
      }
    };
    expect(readWindowsAcls(paths, run)).toHaveLength(2);
    expect(calls).toEqual([{ script: ACL_SCRIPT, env: { HOLDR_ACL_PATHS: paths.join('|') } }]);
    // Nothing from the paths reaches the command; the script reads them from the environment.
    expect(ACL_SCRIPT).not.toContain('odd');
    expect(ACL_SCRIPT).toContain("Get-Acl -LiteralPath $p");
    expect(ACL_SCRIPT).toContain("$env:HOLDR_ACL_PATHS -split '\\|'");
    expect(ACL_SCRIPT).toContain('$acl.GetOwner($sid).Value');
    expect(ACL_SCRIPT).toContain('$acl.GetAccessRules($true, $true, $sid)');
    expect(ACL_SCRIPT).toContain('rights = [int64][int]$rule.FileSystemRights');
    expect(ACL_SCRIPT).toContain("$ErrorActionPreference = 'Stop'");
  });

  it('runs nothing for no paths and refuses a path it cannot pass', () => {
    const run: PowerShellRunner = () => { throw new Error('must not run'); };
    expect(readWindowsAcls([], run)).toEqual([]);
    expect(() => readWindowsAcls(['C:\\a|b'], run)).toThrow(/containing "\|"/);
    expect(() => readWindowsAcls([''], run)).toThrow(/empty path/);
  });

  it('refuses when PowerShell fails, times out or prints garbage', () => {
    const failed: PowerShellRunner = () => {
      throw Object.assign(new Error('Command failed: powershell.exe -EncodedCommand ...'), {
        status: 1,
        stderr: "Get-Acl : Cannot find path 'C:\\x' because it does not exist.\r\nAt line:4 char:10",
      });
    };
    expect(() => readWindowsAcls(['C:\\x'], failed)).toThrow(
      "could not read the owner and ACL (PowerShell exited with code 1: Get-Acl : Cannot find path 'C:\\x' because it does not exist.)",
    );
    const timedOut: PowerShellRunner = () => { throw Object.assign(new Error('spawnSync powershell.exe ETIMEDOUT'), { code: 'ETIMEDOUT' }); };
    expect(() => readWindowsAcls(['C:\\x'], timedOut)).toThrow('could not read the owner and ACL (PowerShell did not answer within 30s)');
    expect(() => readWindowsAcls(['C:\\x'], () => 'WARNING: something\r\n')).toThrow(/something other than the JSON/);
  });

  it('reads the current user SID with WindowsIdentity and refuses anything else', () => {
    let script = '';
    expect(readCurrentUserSid((encoded) => { script = decode(encoded); return `${USER}\r\n`; })).toBe(USER);
    expect(script).toBe(USER_SID_SCRIPT);
    expect(script).toContain('[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
    expect(() => readCurrentUserSid(() => 'DESKTOP\\me')).toThrow(/instead of the current user's SID/);
    expect(() => readCurrentUserSid(() => { throw Object.assign(new Error('x'), { code: 'ETIMEDOUT' }); })).toThrow(/did not answer within 30s/);
  });

  it('restricts a directory with icacls from System32, by SID', () => {
    const calls: [string, string[]][] = [];
    restrictToUser('run-1', USER, (file, args) => { calls.push([file, args]); });
    expect(calls).toEqual([[system32('icacls.exe'), ['run-1', '/inheritance:r', '/grant:r', `*${USER}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F']]]);
    expect(system32('icacls.exe')).toMatch(/\\System32\\icacls\.exe$/);
    expect(() => restrictToUser('run-1', 'me', () => { throw new Error('must not run'); })).toThrow(/is not a SID/);
    expect(() => restrictToUser('run-1', USER, () => { throw new Error('Command failed: icacls'); })).toThrow(/could not restrict run-1/);
  });

  it('makes the current user the owner with icacls, by SID', () => {
    const calls: [string, string[]][] = [];
    takeOwnership('run-1', USER, (file, args) => { calls.push([file, args]); });
    expect(calls).toEqual([[system32('icacls.exe'), ['run-1', '/setowner', `*${USER}`]]]);
    expect(() => takeOwnership('run-1', 'me', () => { throw new Error('must not run'); })).toThrow(/is not a SID/);
    expect(() => takeOwnership('run-1', USER, () => { throw new Error('Command failed: icacls'); })).toThrow(/could not make the current user the owner of run-1/);
  });

  it('starts Windows PowerShell without PowerShell 7\'s module path, in any casing, and keeps everything else', () => {
    const env = windowsPowerShellEnv({ HOLDR_ACL_PATHS: 'a' }, { PSModulePath: 'x', PSMODULEPATH: 'y', Path: 'C:\\Windows', SystemRoot: 'C:\\Windows' });
    expect(env).toEqual({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', HOLDR_ACL_PATHS: 'a' });
  });
});

describe('the one-handle file reader (corrections design r6, section 2.8)', () => {
  const decode = (encoded: string) => Buffer.from(encoded, 'base64').toString('utf16le');
  const printed = (patch: Record<string, unknown> = {}) => JSON.stringify({
    volume: '17', index: '42', owner: USER, aceTypes: ['AccessAllowed'], aces: [{ sid: USER, rights: FULL_CONTROL, type: 'Allow' }], ...patch,
  });

  it('reads the owner, the rules and the identity through one handle, the path only in HOLDR_ACL_FILE', () => {
    const file = "C:\\Users\\me\\it's [odd] $(name).key";
    const calls: { script: string; env: Record<string, string> }[] = [];
    const run: PowerShellRunner = (encoded, env) => {
      calls.push({ script: decode(encoded), env });
      return `${printed()}\r\n`;
    };
    expect(readWindowsFileAcl(file, run)).toEqual({ owner: USER, aceTypes: ['AccessAllowed'], aces: [allow(USER, FULL_CONTROL)], volume: '17', index: '42' });
    expect(calls).toEqual([{ script: FILE_ACL_SCRIPT, env: { HOLDR_ACL_FILE: file } }]);
    expect(FILE_ACL_SCRIPT).not.toContain('odd');
    expect(FILE_ACL_SCRIPT).toContain('[System.IO.File]::Open($env:HOLDR_ACL_FILE');
    expect(FILE_ACL_SCRIPT).toContain('GetFileInformationByHandle($stream.SafeFileHandle, [ref]$information)');
    expect(FILE_ACL_SCRIPT).toContain('$acl = $stream.GetAccessControl()');
    expect(FILE_ACL_SCRIPT).toContain("$ErrorActionPreference = 'Stop'");
  });

  it.each([
    ['no identity', JSON.stringify({ owner: USER, aceTypes: ['AccessAllowed'], aces: [] })],
    ['an index as a number', printed({ index: 42 })],
    ['a signed volume', printed({ volume: '-17' })],
    ['a leading zero', printed({ index: '042' })],
  ])('refuses %s', (_, stdout) => {
    expect(() => parseWindowsFileAcl(stdout)).toThrow(/reported no identity/);
  });

  it('refuses what parseWindowsAcls refuses, a path it cannot pass, and a call that fails', () => {
    expect(() => parseWindowsFileAcl(printed({ owner: 'Everyone' }))).toThrow(/is not a SID/);
    expect(() => readWindowsFileAcl('C:\\a|b', () => { throw new Error('must not run'); })).toThrow(/containing "\|"/);
    expect(() => readWindowsFileAcl('C:\\x', () => { throw Object.assign(new Error('x'), { code: 'ETIMEDOUT' }); }))
      .toThrow("could not read the file's owner, ACL and identity (PowerShell did not answer within 30s)");
  });
});