import { ADMINISTRATORS_SID, SYSTEM_SID, type WindowsAce, type WindowsAcl } from '../windowsAcl.js';

/** Fake SIDs and ACLs shaped like what Windows reports, for the win32 tests that run anywhere. */

// Fake SIDs: a user, another local user, and the well-known groups.
export const USER = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
export const OTHER_USER = 'S-1-5-21-1111111111-2222222222-3333333333-1002';
export const EVERYONE = 'S-1-1-0';
export const AUTHENTICATED_USERS = 'S-1-5-11';
export const USERS = 'S-1-5-32-545';

// FileSystemRights as Windows reports them.
export const FULL_CONTROL = 0x1f01ff;
export const MODIFY = 0x1301bf;
export const READ_AND_EXECUTE = 0x1200a9;
export const GENERIC_ALL = 0x10000000;
export const GENERIC_WRITE = 0x40000000;
/** GENERIC_READ | GENERIC_EXECUTE, as PowerShell's [int] cast prints it: negative. */
export const GENERIC_READ_EXECUTE_INT32 = -1610612736;

export const allow = (sid: string, rights: number): WindowsAce => ({ sid, rights, type: 'Allow' });
export const deny = (sid: string, rights: number): WindowsAce => ({ sid, rights, type: 'Deny' });
export function acl(owner: string, aces: WindowsAce[]): WindowsAcl {
  return { owner, aces, aceTypes: aces.map((ace) => (ace.type === 'Allow' ? 'AccessAllowed' : 'AccessDenied')) };
}

/** What icacls /inheritance:r /grant:r leaves on a directory the runner created. */
export const RESTRICTED = acl(USER, [allow(USER, FULL_CONTROL), allow(SYSTEM_SID, FULL_CONTROL)]);
/** A profile directory, inherited by %TEMP% and everything below it. */
export const PROFILE = acl(USER, [allow(SYSTEM_SID, FULL_CONTROL), allow(ADMINISTRATORS_SID, FULL_CONTROL), allow(USER, FULL_CONTROL)]);
/** What a checkout under C:\ inherits: Authenticated Users may modify it. */
export const UNDER_DRIVE_ROOT = acl(USER, [...PROFILE.aces, allow(AUTHENTICATED_USERS, MODIFY), allow(USERS, READ_AND_EXECUTE)]);
