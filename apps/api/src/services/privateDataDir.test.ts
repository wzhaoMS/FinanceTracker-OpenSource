import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readCurrentUserSid, readWindowsAcls, SYSTEM_SID } from '../e2e/windowsAcl.js';
import { ensurePrivateDataDir, parseWhoamiUserSid, type WindowsFolderPrivacy } from './privateDataDir.js';
import { SqliteStateRepo } from './sqliteStateRepo.js';

const SID = 'S-1-5-21-1000000000-2000000000-3000000000-1001';
const scratches: string[] = [];

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdr-private-data-'));
  scratches.push(dir);
  return dir;
}

function recording(fail = false): WindowsFolderPrivacy & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    currentUserSid: () => SID,
    restrict: (dir, sid) => {
      calls.push(`${dir} ${sid}`);
      if (fail) throw new Error('icacls refused');
    },
  };
}

afterEach(() => {
  for (const dir of scratches.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ensurePrivateDataDir', () => {
  it('creates each missing folder and, on Windows, restricts every new one to the current user', () => {
    const root = scratch();
    const target = path.join(root, 'Holdr', 'data');
    const windows = recording();
    expect(ensurePrivateDataDir(target, 'win32', windows)).toEqual([path.join(root, 'Holdr'), target]);
    expect(fs.statSync(target).isDirectory()).toBe(true);
    expect(windows.calls).toEqual([`${path.join(root, 'Holdr')} ${SID}`, `${target} ${SID}`]);
  });

  it('leaves a folder that already exists as it is', () => {
    const windows = recording();
    expect(ensurePrivateDataDir(scratch(), 'win32', windows)).toEqual([]);
    expect(windows.calls).toEqual([]);
  });

  it('removes the folders it created when they cannot be made private', () => {
    const root = scratch();
    const target = path.join(root, 'Holdr', 'data');
    expect(() => ensurePrivateDataDir(target, 'win32', recording(true))).toThrow(/could not make the new data folder .* private/);
    expect(fs.existsSync(path.join(root, 'Holdr'))).toBe(false);
    expect(fs.existsSync(root)).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('creates new folders with mode 0700 on macOS and Linux', () => {
    const target = path.join(scratch(), 'Holdr', 'data');
    ensurePrivateDataDir(target);
    expect(fs.statSync(target).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.dirname(target)).mode & 0o777).toBe(0o700);
  });

  it.runIf(process.platform === 'win32')('gives a new folder an ACL for the current user and SYSTEM only, owned by the user', () => {
    const target = path.join(scratch(), 'data');
    new SqliteStateRepo({ file: path.join(target, 'finance.db') }).close();
    const [acl] = readWindowsAcls([target]);
    const sid = readCurrentUserSid();
    expect(acl.owner).toBe(sid);
    expect(new Set(acl.aces.map((ace) => ace.sid))).toEqual(new Set([sid, SYSTEM_SID]));
  }, 60_000);
});

describe('parseWhoamiUserSid', () => {
  it("reads the SID from whoami's CSV line", () => {
    expect(parseWhoamiUserSid(`"desktop-sample\\alex","${SID}"\r\n`)).toBe(SID);
    expect(() => parseWhoamiUserSid('ERROR: access denied')).toThrow(/whoami/);
  });
});
