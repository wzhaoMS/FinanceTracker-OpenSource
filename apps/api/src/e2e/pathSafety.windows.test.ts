import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertPrivateDirectory,
  assertTrustedAncestors,
  createMissingDirectories,
  identityOf,
  privateDirectoryIdentity,
  withPathSafetyHost,
  withPathSafetyHostAsync,
  type PathSafetyHost,
} from './pathSafety.js';
import { createRunDirectories, directoryIdentity, removeRunDirectory } from './runDir.js';
import { createRunIdentity } from './runIdentity.js';
import { DISPOSABLE_MARKER, assertDisposableDataDir, prepareDisposableDataDir, seedDisposableDataDir } from './syntheticSeed.js';
import { ADMINISTRATORS_SID, SYSTEM_SID, readWindowsAcls, type PowerShellRunner, type WindowsAcl } from './windowsAcl.js';
import {
  EVERYONE,
  FULL_CONTROL,
  MODIFY,
  OTHER_USER,
  PROFILE,
  RESTRICTED,
  UNDER_DRIVE_ROOT,
  USER,
  USERS,
  acl,
  allow,
  deny,
} from './__fixtures__/windowsAcls.js';

/**
 * The Windows branch of the directory checks, run on any platform (Windows
 * included): the platform, the current user's SID, the ACL reader and icacls
 * are replaced (PathSafetyHost), while the directories, links and identities
 * are real. Links are made as junctions, which Windows allows without
 * privileges and other platforms make as plain symlinks.
 * windowsAcl.win32.test.ts runs the real PowerShell and icacls on Windows.
 */

const NOW = new Date('2026-10-17T00:16:49.123Z');

/** The browser's identity gate (apps/web/tests/stack-identity.ts), loaded by path: it is outside this package. */
const BROWSER_GATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'web', 'tests', 'stack-identity.ts');
type VerifyRunIdentity = (webUrl: string, expectedRunId: string | undefined, fetchImpl?: typeof fetch) => Promise<void>;
async function verifyRunIdentity(...args: Parameters<VerifyRunIdentity>): Promise<void> {
  const gate = (await import(pathToFileURL(BROWSER_GATE).href)) as { verifyRunIdentity: VerifyRunIdentity };
  return gate.verifyRunIdentity(...args);
}
const RUN_ID = '0123456789abcdef0123456789abcdef';

interface FakeWindows {
  host: Partial<PathSafetyHost>;
  /** ACL reads and icacls restrictions, in order, as absolute paths. */
  events: string[];
  /** Directories passed to icacls. */
  restricted: string[];
  /** ACLs by absolute path; a restricted directory gets RESTRICTED, anything else PROFILE. */
  acls: Map<string, WindowsAcl>;
}

function fakeWindows(): FakeWindows {
  const fake: FakeWindows = { host: {}, events: [], restricted: [], acls: new Map() };
  fake.host = {
    platform: 'win32',
    currentUserSid: () => USER,
    readWindowsAcls: (paths) => {
      // Relative paths resolve from the working directory, as PowerShell's do.
      const absolute = paths.map((p) => path.resolve(p));
      fake.events.push(`read ${absolute.join(' | ')}`);
      return absolute.map((p) => fake.acls.get(p) ?? (fake.restricted.includes(p) ? RESTRICTED : PROFILE));
    },
    // The API's /health reads without blocking; the fake answers on a later tick.
    readWindowsAclsAsync: async (paths) => {
      const absolute = paths.map((p) => path.resolve(p));
      fake.events.push(`read async ${absolute.join(' | ')}`);
      await new Promise((resolve) => setImmediate(resolve));
      return absolute.map((p) => fake.acls.get(p) ?? (fake.restricted.includes(p) ? RESTRICTED : PROFILE));
    },
    restrictToCurrentUser: (dir) => {
      fake.restricted.push(path.resolve(dir));
      fake.events.push(`restrict ${path.resolve(dir)}`);
    },
  };
  return fake;
}

/** A mock live database with a row that must survive. */
function makeMockLiveDb(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'finance.db');
  const db = new Database(file);
  db.exec("CREATE TABLE live_sentinel (note TEXT); INSERT INTO live_sentinel VALUES ('mock live row')");
  db.close();
  return file;
}

const HOME_VARIABLES = ['HOME', 'USERPROFILE'] as const;
type SavedHome = Record<(typeof HOME_VARIABLES)[number], string | undefined>;

/** Make `dir` the home directory, the trusted root of the ancestor checks (HOME, or USERPROFILE on Windows). */
function setHome(dir: string): SavedHome {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  for (const name of HOME_VARIABLES) process.env[name] = dir;
  return saved;
}

function restoreHome(saved: SavedHome): void {
  for (const name of HOME_VARIABLES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
}

describe('directory checks on Windows (platform and ACL reader injected)', () => {
  let root: string;
  let savedHome: SavedHome;
  let fake: FakeWindows;
  const onWindows = <T>(action: () => T): T => withPathSafetyHost(fake.host, action);
  const onWindowsAsync = <T>(action: () => Promise<T>): Promise<T> => withPathSafetyHostAsync(fake.host, action);
  const onPosix = <T>(action: () => T): T => withPathSafetyHost({ platform: 'linux' }, action);
  const privateDir = (name: string) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  };

  beforeEach(async () => {
    root = fs.realpathSync(await mkdtemp(path.join(tmpdir(), 'ft-e2e-win-')));
    // The trusted root for the ancestor checks: the walk stops here.
    savedHome = setHome(root);
    fake = fakeWindows();
  });

  afterEach(async () => {
    restoreHome(savedHome);
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('ignores the mode bits, which on Windows never reflect the ACL (Node reports 0o666, or 0o444 when read-only), and reads the ACL instead', () => {
    const dir = privateDir('group-and-other-writable');
    // 0o777 here; on Windows chmod cannot change the 0o666 Node reports, which has the same write bits.
    fs.chmodSync(dir, 0o777);
    // The POSIX branch, unchanged: group and other write bits refuse.
    expect(() => onPosix(() => assertPrivateDirectory(dir))).toThrow(/writable by its group or by other users \(mode (777|666)\)/);
    fake.acls.set(dir, RESTRICTED);
    expect(() => onWindows(() => assertPrivateDirectory(dir))).not.toThrow();
    expect(fake.events).toEqual([`read ${dir}`]);
    fake.acls.set(dir, UNDER_DRIVE_ROOT);
    expect(() => onWindows(() => assertPrivateDirectory(dir))).toThrow(
      `${dir} has an ACL that lets Authenticated Users (S-1-5-11) write to it (rights 0x1301bf)`,
    );
  });

  it.each([
    ['inherits "Authenticated Users: Modify" (a checkout under C:\\)', UNDER_DRIVE_ROOT, /lets Authenticated Users \(S-1-5-11\) write/],
    ['lets Everyone write', acl(USER, [...RESTRICTED.aces, allow(EVERYONE, FULL_CONTROL)]), /lets Everyone \(S-1-1-0\) write/],
    ['lets Users write', acl(USER, [...RESTRICTED.aces, allow(USERS, MODIFY)]), /lets Users \(S-1-5-32-545\) write/],
    ['lets another user (an unknown SID) write', acl(USER, [...RESTRICTED.aces, allow(OTHER_USER, MODIFY)]), new RegExp(`lets ${OTHER_USER} write`)],
    ['belongs to another user', acl(OTHER_USER, RESTRICTED.aces), /is owned by S-1-5-21-[\d-]+-1002, not by the current user/],
    ['has no DACL', { ...RESTRICTED, aceTypes: null }, /no DACL/],
    ['has a callback entry', { ...RESTRICTED, aceTypes: ['AccessAllowedCallback'] }, /cannot be checked/],
  ])('refuses a directory whose ACL %s', (_, dirAcl, message) => {
    const dir = privateDir('checked');
    fake.acls.set(dir, dirAcl);
    expect(() => onWindows(() => assertPrivateDirectory(dir))).toThrow(message);
  });

  it('accepts deny rules, which only take rights away', () => {
    const dir = privateDir('denied');
    fake.acls.set(dir, acl(USER, [deny(EVERYONE, FULL_CONTROL), deny(USERS, MODIFY), ...RESTRICTED.aces]));
    expect(() => onWindows(() => assertPrivateDirectory(dir))).not.toThrow();
  });

  it.each([
    ['PowerShell fails', () => {
      throw Object.assign(new Error('Command failed'), { status: 1, stderr: 'Get-Acl : Attempted to perform an unauthorized operation.' });
    }, /could not read the owner and ACL \(PowerShell exited with code 1: Get-Acl : Attempted to perform an unauthorized operation\.\); refusing to trust it/],
    ['PowerShell times out', () => {
      throw Object.assign(new Error('spawnSync powershell.exe ETIMEDOUT'), { code: 'ETIMEDOUT' });
    }, /PowerShell did not answer within 30s\); refusing to trust it/],
    ['PowerShell prints garbage', () => 'Get-Acl : Access is denied', /something other than the JSON asked for/],
    ['PowerShell describes another number of directories', () => '[]', /described 0 directories instead of 1/],
    ['PowerShell names an account instead of a SID', () => JSON.stringify({
      owner: USER, aceTypes: ['AccessAllowed'], aces: [{ sid: 'NT AUTHORITY\\Authenticated Users', rights: MODIFY, type: 'Allow' }],
    }), /names "NT AUTHORITY\\\\Authenticated Users", not a SID/],
  ] as [string, PowerShellRunner, RegExp][])('refuses when %s', (_, run, message) => {
    const dir = privateDir('unreadable');
    fake.host.readWindowsAcls = (paths) => readWindowsAcls(paths, run);
    expect(() => onWindows(() => assertPrivateDirectory(dir))).toThrow(message);
  });

  it("refuses when the current user's SID cannot be read", () => {
    const dir = privateDir('no-user');
    fake.host.currentUserSid = () => {
      throw new Error("could not read the current user's SID (PowerShell did not answer within 30s)");
    };
    expect(() => onWindows(() => assertPrivateDirectory(dir))).toThrow(/could not read the current user's SID .*refusing to trust it/);
  });

  it('refuses a symlink (Node reports a junction as one) before reading any ACL', () => {
    const target = privateDir('target');
    const link = path.join(root, 'link');
    fs.symlinkSync(target, link, 'junction');
    expect(() => onWindows(() => assertPrivateDirectory(link))).toThrow(/not a plain directory/);
    expect(fake.events).toEqual([]);
  });

  it('reads every directory above, up to the home directory, in one call', () => {
    const deep = privateDir(path.join('a', 'b', 'c'));
    onWindows(() => assertTrustedAncestors(deep));
    expect(fake.events).toEqual([`read ${path.join(root, 'a', 'b')} | ${path.join(root, 'a')} | ${root}`]);
    fake.acls.set(path.join(root, 'a'), UNDER_DRIVE_ROOT);
    expect(() => onWindows(() => assertTrustedAncestors(deep))).toThrow(
      `${path.join(root, 'a')} (above ${deep}) has an ACL that lets Authenticated Users (S-1-5-11) write to it`,
    );
  });

  it('lets SYSTEM or Administrators own a directory above, but only the user own a private one', () => {
    const deep = privateDir(path.join('a', 'b'));
    fake.acls.set(path.join(root, 'a'), acl(ADMINISTRATORS_SID, PROFILE.aces));
    fake.acls.set(root, acl(SYSTEM_SID, PROFILE.aces));
    expect(() => onWindows(() => assertTrustedAncestors(deep))).not.toThrow();
    fake.acls.set(deep, acl(ADMINISTRATORS_SID, RESTRICTED.aces));
    expect(() => onWindows(() => assertPrivateDirectory(deep))).toThrow(
      `${deep} is owned by Administrators (S-1-5-32-544), not by the current user (${USER})`,
    );
  });

  it('restricts each directory it creates to the user and SYSTEM, after checking the part that exists', () => {
    const target = path.join(root, 'w', 'x');
    onWindows(() => createMissingDirectories(target));
    expect(fake.events).toEqual([`read ${root}`, `restrict ${path.join(root, 'w')}`, `restrict ${target}`]);
    // Nothing is created below a directory others can write to.
    fake.acls.set(root, UNDER_DRIVE_ROOT);
    expect(() => onWindows(() => createMissingDirectories(path.join(root, 'y', 'z')))).toThrow(/Authenticated Users/);
    expect(fs.existsSync(path.join(root, 'y'))).toBe(false);
  });

  it('restricts and then checks the work, run, data and logs directories', () => {
    const work = path.join(root, 'work');
    const dirs = onWindows(() => createRunDirectories(work, { label: '4242', now: NOW, suffix: 'a1b2c3' }));
    expect(fake.restricted).toEqual([work, dirs.runDir, dirs.dataDir, dirs.logDir]);
    for (const dir of [dirs.runDir, dirs.dataDir, dirs.logDir]) {
      const restrictedAt = fake.events.indexOf(`restrict ${dir}`);
      expect(fake.events.indexOf(`read ${dir}`, restrictedAt)).toBeGreaterThan(restrictedAt);
    }
    expect(dirs.dataDirId).toBe(`${directoryIdentity(work)}/${directoryIdentity(dirs.runDir)}/${directoryIdentity(dirs.dataDir)}`);
  });

  it('stops when icacls fails', () => {
    fake.host.restrictToCurrentUser = () => {
      throw new Error('could not restrict run-x to the current user with icacls (Command failed)');
    };
    expect(() => onWindows(() => createRunDirectories(privateDir('work')))).toThrow(/could not restrict .* with icacls/);
  });

  it('deletes a run directory only while its ACLs and identities still pass', () => {
    const dirs = onWindows(() => createRunDirectories(path.join(root, 'work'), { now: NOW }));
    fake.acls.set(dirs.runDir, acl(USER, [...RESTRICTED.aces, allow(USERS, MODIFY)]));
    expect(() => onWindows(() => removeRunDirectory(dirs.dataDir, dirs.dataDirId))).toThrow(/not deleting .* lets Users/);
    expect(fs.existsSync(dirs.dataDir)).toBe(true);
    fake.acls.delete(dirs.runDir);
    expect(onWindows(() => removeRunDirectory(dirs.runDir, dirs.runDirId))).toBe('removed');
    expect(fs.existsSync(dirs.runDir)).toBe(false);
  });

  it('refuses a directory replaced while its ACL was being read', () => {
    const dir = privateDir('swapped');
    fake.host.readWindowsAcls = (paths) => {
      fs.renameSync(dir, path.join(root, 'original'));
      fs.mkdirSync(dir, { mode: 0o700 });
      return paths.map(() => RESTRICTED);
    };
    expect(() => onWindows(() => privateDirectoryIdentity(dir))).toThrow(`${dir} changed while it was being checked`);
  });

  it('applies the same checks to the seed and to API startup, which still refuse linked databases', () => {
    const checkout = privateDir('checkout');
    const marked = privateDir(path.join('checkout', 'data'));
    fs.writeFileSync(path.join(marked, DISPOSABLE_MARKER), 'marked by this test', { mode: 0o600 });
    fake.acls.set(checkout, UNDER_DRIVE_ROOT);
    onWindows(() => {
      expect(() => assertDisposableDataDir(marked)).toThrow(/checkout \(above .*\) has an ACL that lets Authenticated Users/);
      expect(() => prepareDisposableDataDir(marked)).toThrow(/^refusing to seed .*Authenticated Users/);
      expect(() => createRunIdentity(RUN_ID, marked)).toThrow(/is not a disposable e2e data directory .*Authenticated Users.*refusing to start/);
    });

    const live = makeMockLiveDb(path.join(root, 'mock-live'));
    const liveBytes = fs.readFileSync(live);
    const dataDir = onWindows(() => prepareDisposableDataDir(path.join(root, 'data')));
    fs.linkSync(live, path.join(dataDir, 'finance.db'));
    onWindows(() => {
      expect(() => createRunIdentity(RUN_ID, dataDir)).toThrow(/finance\.db has 2 hard links/);
      expect(() => seedDisposableDataDir(dataDir, NOW)).toThrow(/finance\.db has 2 hard links/);
    });
    expect(fs.readFileSync(live).equals(liveBytes)).toBe(true);
  });

  it("counts hard links again through the open file, since lstat can report one (libuv's directory-listing fallback)", () => {
    const live = makeMockLiveDb(path.join(root, 'mock-live'));
    const liveBytes = fs.readFileSync(live);
    const dataDir = onWindows(() => prepareDisposableDataDir(path.join(root, 'data')));
    const linked = path.join(dataDir, 'finance.db');
    fs.linkSync(live, linked);
    // What libuv reports when opening the file for its attributes fails:
    // the right file ID, but always one link.
    const realLstat = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) => {
      const stats = realLstat(target, options as fs.StatSyncOptions & { bigint: false }) as fs.Stats | fs.BigIntStats | undefined;
      if (stats && String(target) === linked) (stats as { nlink: number | bigint }).nlink = typeof stats.nlink === 'bigint' ? 1n : 1;
      return stats;
    }) as typeof fs.lstatSync);
    // Control: lstat alone now sees one link (on POSIX its count is the file's own, so it is trusted there).
    if (process.platform !== 'win32') expect(() => onPosix(() => assertDisposableDataDir(dataDir))).not.toThrow();
    onWindows(() => {
      expect(() => assertDisposableDataDir(dataDir)).toThrow(`${linked} has 2 hard links`);
      expect(() => createRunIdentity(RUN_ID, dataDir)).toThrow(/finance\.db has 2 hard links/);
      expect(() => seedDisposableDataDir(dataDir, NOW)).toThrow(/finance\.db has 2 hard links/);
    });
    expect(fs.readFileSync(live).equals(liveBytes)).toBe(true);
  });

  describe("each file's own owner and ACL (a private directory does not protect its files on Windows)", () => {
    const reads = () => fake.events.filter((event) => event.startsWith('read '));
    /** A marked, private data dir holding a "moved-in" finance.db that keeps an ACL of its own. */
    function withMovedInDatabase(fileAcl: WindowsAcl) {
      const dataDir = onWindows(() => prepareDisposableDataDir(path.join(root, 'data')));
      const db = path.join(dataDir, 'finance.db');
      fs.writeFileSync(db, 'moved in');
      fake.acls.set(db, fileAcl);
      return { dataDir, db };
    }

    it.each([
      ['lets another user write', acl(USER, [...RESTRICTED.aces, allow(OTHER_USER, MODIFY)]), new RegExp(`finance\\.db has an ACL that lets ${OTHER_USER} write to it`)],
      ['lets Everyone write', acl(USER, [...RESTRICTED.aces, allow(EVERYONE, FULL_CONTROL)]), /finance\.db has an ACL that lets Everyone \(S-1-1-0\) write to it/],
      ['belongs to another user', acl(OTHER_USER, RESTRICTED.aces), /finance\.db is owned by S-1-5-21-[\d-]+-1002, not by the current user/],
      ['belongs to Administrators', acl(ADMINISTRATORS_SID, RESTRICTED.aces), /finance\.db is owned by Administrators \(S-1-5-32-544\), not by the current user/],
    ])('refuses, at the seed and at API start, a database file that %s', (_, fileAcl, message) => {
      const { dataDir, db } = withMovedInDatabase(fileAcl);
      onWindows(() => {
        expect(() => seedDisposableDataDir(dataDir, NOW)).toThrow(message);
        expect(() => createRunIdentity(RUN_ID, dataDir)).toThrow(message);
      });
      expect(fs.readFileSync(db, 'utf8')).toBe('moved in');
    });

    it('refuses a marker that lets others write', () => {
      const dataDir = onWindows(() => prepareDisposableDataDir(path.join(root, 'data')));
      fake.acls.set(path.join(dataDir, DISPOSABLE_MARKER), acl(USER, [...RESTRICTED.aces, allow(USERS, MODIFY)]));
      onWindows(() => expect(() => createRunIdentity(RUN_ID, dataDir)).toThrow(/\.holdr-e2e-disposable has an ACL that lets Users \(S-1-5-32-545\) write/));
    });

    it('reads the directory, the ones above it and its files in one PowerShell call', () => {
      const { dataDir, db } = withMovedInDatabase(PROFILE);
      fake.events.length = 0;
      onWindows(() => assertDisposableDataDir(dataDir));
      expect(reads()).toHaveLength(1);
      expect(new Set(reads()[0].slice('read '.length).split(' | '))).toEqual(new Set([dataDir, root, path.join(dataDir, DISPOSABLE_MARKER), db]));
    });

    it('reads the directory, every directory above it and every file again at each check, /health without blocking', async () => {
      const dataDir = onWindows(() => prepareDisposableDataDir(path.join(root, 'data')));
      const db = path.join(dataDir, 'finance.db');
      fs.writeFileSync(db, '');
      const marker = path.join(dataDir, DISPOSABLE_MARKER);
      const wal = path.join(dataDir, 'finance.db-wal');
      const shm = path.join(dataDir, 'finance.db-shm');
      const pathsRead = (event: string) => new Set(event.replace(/^read (async )?/, '').split(' | '));
      await onWindowsAsync(async () => {
        const run = createRunIdentity(RUN_ID, dataDir);
        fake.events.length = 0;
        run.assertUnchanged();
        // SQLite's files appear at the open; the post-open pin reads them with everything else.
        fs.writeFileSync(wal, '');
        fs.writeFileSync(shm, '');
        run.recordOpened();
        expect(await run.identity()).toEqual({ runId: RUN_ID, disposableDataDir: true });
        expect(await run.identity()).toEqual({ runId: RUN_ID, disposableDataDir: true });
        expect(fake.events.map((event) => event.startsWith('read async') ? 'async' : 'sync')).toEqual(['sync', 'sync', 'async', 'async']);
        expect(pathsRead(fake.events[0])).toEqual(new Set([dataDir, root, marker, db]));
        for (const event of fake.events.slice(1)) expect(pathsRead(event)).toEqual(new Set([dataDir, root, marker, db, wal, shm]));

        // A permissive file moved in after startup is refused at the next check.
        const journal = path.join(dataDir, 'finance.db-journal');
        fs.writeFileSync(journal, 'moved in');
        fake.acls.set(journal, acl(USER, [...RESTRICTED.aces, allow(OTHER_USER, MODIFY)]));
        expect(await run.identity()).toEqual({ runId: RUN_ID, disposableDataDir: false });
        expect(() => run.assertUnchanged()).toThrow(/finance\.db-journal has an ACL that lets S-1-5-21-[\d-]+-1002 write/);
      });
    });

    describe('an ACL changed on the same file after it was checked (the same file, so the same identity)', () => {
      it.each([
        ['finance.db lets another user write', (dataDir: string) => [path.join(dataDir, 'finance.db'), acl(USER, [...PROFILE.aces, allow(OTHER_USER, MODIFY)])] as const, /finance\.db has an ACL that lets S-1-5-21-[\d-]+-1002 write/],
        ['the marker lets Users write', (dataDir: string) => [path.join(dataDir, DISPOSABLE_MARKER), acl(USER, [...PROFILE.aces, allow(USERS, MODIFY)])] as const, /\.holdr-e2e-disposable has an ACL that lets Users \(S-1-5-32-545\) write/],
        ['the data directory lets Everyone write', (dataDir: string) => [dataDir, acl(USER, [...RESTRICTED.aces, allow(EVERYONE, FULL_CONTROL)])] as const, /data has an ACL that lets Everyone \(S-1-1-0\) write/],
        ['a directory above it lets Authenticated Users modify it', () => [root, UNDER_DRIVE_ROOT] as const, /has an ACL that lets Authenticated Users \(S-1-5-11\) write/],
      ])('is refused at the next pre-open check and /health when %s', async (_, change, message) => {
        const dataDir = onWindows(() => prepareDisposableDataDir(path.join(root, 'data')));
        fs.writeFileSync(path.join(dataDir, 'finance.db'), '');
        await onWindowsAsync(async () => {
          const run = createRunIdentity(RUN_ID, dataDir);
          run.assertUnchanged();
          run.recordOpened();
          expect(await run.identity()).toEqual({ runId: RUN_ID, disposableDataDir: true });
          const [target, changedAcl] = change(dataDir);
          const identityBefore = fs.lstatSync(target, { bigint: true }).ino;
          fake.acls.set(target, changedAcl); // e.g. icacls /grant by the owner or an administrator
          expect(fs.lstatSync(target, { bigint: true }).ino).toBe(identityBefore);
          expect(() => run.assertUnchanged()).toThrow(message);
          expect(await run.identity()).toEqual({ runId: RUN_ID, disposableDataDir: false });
          // And the browser's identity gate, fed that /health, refuses.
          const health = { ok: true, e2e: await run.identity() };
          const fetchHealth = (async () => new Response(JSON.stringify(health), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
          await expect(verifyRunIdentity('http://127.0.0.1:5306', RUN_ID, fetchHealth)).rejects.toThrow(/does not report a disposable data directory/);
        });
      });
    });

    it('refuses a file replaced while its ACL was being read', () => {
      const dataDir = onWindows(() => prepareDisposableDataDir(path.join(root, 'data')));
      const db = path.join(dataDir, 'finance.db');
      fs.writeFileSync(db, '');
      const readAcls = fake.host.readWindowsAcls!;
      fake.host.readWindowsAcls = (paths) => {
        fs.rmSync(db);
        fs.writeFileSync(db, 'swapped in');
        return readAcls(paths);
      };
      onWindows(() => expect(() => createRunIdentity(RUN_ID, dataDir)).toThrow(`${db} changed while it was being checked`));
    });
  });

  it('seeds and starts on a directory whose ACLs pass', async () => {
    const result = onWindows(() => seedDisposableDataDir(path.join(root, 'seeded'), NOW));
    expect(result.accounts).toBeGreaterThan(0);
    const identity = onWindows(() => createRunIdentity(RUN_ID, result.dataDir));
    expect(identity.dataDir).toBe(result.dataDir);
    expect(await onWindowsAsync(() => identity.identity())).toEqual({ runId: RUN_ID, disposableDataDir: true });
  });
});

describe('directory identities', () => {
  it('stay exact beyond 2^53, where NTFS file IDs often are', () => {
    const big = 2n ** 60n;
    const one = { dev: 2_870_247_731n, ino: big } as unknown as fs.BigIntStats;
    const next = { dev: 2_870_247_731n, ino: big + 1n } as unknown as fs.BigIntStats;
    expect(identityOf(one)).toBe('2870247731:1152921504606846976');
    expect(identityOf(next)).toBe('2870247731:1152921504606846977');
    // As numbers the two files would have looked the same.
    expect(Number(one.ino)).toBe(Number(next.ino));
  });

  it('use the low 32 bits of the volume serial number on Windows, whichever way libuv read it', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try {
      // libuv 1.49/1.50 by path: the 64-bit serial; by handle, and libuv 1.51 always: its low 32 bits.
      const byPath = { dev: 0x1234_5678_9abc_def0n, ino: 2n ** 60n } as unknown as fs.BigIntStats;
      const byHandle = { dev: 0x9abc_def0n, ino: 2n ** 60n } as unknown as fs.BigIntStats;
      expect(identityOf(byPath)).toBe('2596069104:1152921504606846976');
      expect(identityOf(byHandle)).toBe(identityOf(byPath));
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
    // POSIX identities are unchanged.
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    try {
      expect(identityOf({ dev: 0x1234_5678_9abc_def0n, ino: 7n } as unknown as fs.BigIntStats)).toBe('1311768467463790320:7');
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('are read as bigints', async () => {
    const dir = fs.realpathSync(await mkdtemp(path.join(tmpdir(), 'ft-e2e-id-')));
    const savedHome = setHome(dir);
    try {
      const stats = fs.lstatSync(dir, { bigint: true });
      expect(directoryIdentity(dir)).toBe(identityOf(stats));
      expect(privateDirectoryIdentity(dir)).toBe(identityOf(stats));
      expect(identityOf(stats)).toMatch(/^\d+:\d+$/);
    } finally {
      restoreHome(savedHome);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
