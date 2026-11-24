import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { copyDatabase, privateDir, runHoldrBackup, type WindowsPrivacy } from '../cli/holdrBackup.js';
import { runHoldrUserCli, type CliStdin } from '../cli/holdrUser.js';
import { CURRENT_USER_VERSION } from '../services/sqliteStateRepo.js';
import { tablesAndCounts } from '../testing/sqliteContents.js';
import { LIFECYCLE_LOCK, lockPath, marker, probeExclusive, writeMarker } from './lifecycle.js';
import { isCanonicalNativeAbsolute, repoPaths } from './paths.js';
import { checkBackupPerms } from './startupGates.js';
import { FAKE_MACHINE, captureIo, controlEnvFixture, exited, fakeSystem, lockHolder } from './testControl.js';
import { scratchDir } from './testDirs.js';
import { validateOffline } from './validateOffline.js';
import { openWriterDb } from './writerDb.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const coded = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; exitCode?: number }) => ({ code: error.code, exitCode: error.exitCode }));

async function setup() {
  const fixture = await controlEnvFixture({ machine: FAKE_MACHINE });
  cleanups.push(fixture.cleanup);
  return fixture;
}

function syntheticDb(file: string, version = 14): void {
  const db = new Database(file);
  db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
  db.prepare('INSERT INTO items (label) VALUES (?), (?)').run('synthetic-a', 'synthetic-b');
  db.pragma(`user_version = ${version}`);
  db.close();
  fs.chmodSync(file, 0o600);
}

const closeable = () => {
  const state = { opened: 0, closed: 0 };
  return { state, open: () => { state.opened += 1; return { close() { state.closed += 1; } }; } };
};

describe.skipIf(process.platform !== 'darwin')('writers through openWriterDb (§9.3 writer row)', { timeout: 30_000 }, () => {
  it('holds the shared lease while the database is open and releases it on close', async () => {
    const { env, controlDir } = await setup();
    const target = closeable();
    const opened = await openWriterDb(env, target.open);
    expect(probeExclusive(controlDir)).toBe('held');
    opened.close();
    opened.close();
    expect(target.state).toEqual({ opened: 1, closed: 1 });
    expect(probeExclusive(controlDir)).toBe('free');
    const plain = closeable();
    (await openWriterDb({ PATH: process.env.PATH }, plain.open)).close();
    expect(plain.state).toEqual({ opened: 1, closed: 1 });
  });

  it('maintenance is exit 3, a maintenance holder is exit 75, lease variables refuse; nothing is opened', async () => {
    const { env, controlDir } = await setup();
    const target = closeable();
    writeMarker(controlDir, marker({ state: 'maintenance', reason: 'deploy' }, 'test'));
    expect(await coded(openWriterDb(env, target.open))).toEqual({ code: 'E0I_MAINTENANCE', exitCode: 3 });
    writeMarker(controlDir, marker({ state: 'normal' }, 'test'));
    await lockHolder(lockPath(controlDir, LIFECYCLE_LOCK), 'exclusive', cleanups);
    expect(await coded(openWriterDb(env, target.open, { timeoutMs: 200 }))).toEqual({ code: 'E0I_LIFECYCLE_BUSY', exitCode: 75 });
    expect(await coded(openWriterDb({ ...env, HOLDR_LIFECYCLE_LEASE_FD: '3' }, target.open))).toMatchObject({ code: 'E0I_LEASE_ENV' });
    expect(target.state.opened).toBe(0);
  });

  it('releases the lease when opening fails', async () => {
    const { env, controlDir } = await setup();
    await expect(openWriterDb(env, () => { throw new Error('open failed'); })).rejects.toThrow('open failed');
    expect(probeExclusive(controlDir)).toBe('free');
  });

  it('holdr-user refuses during maintenance with exit 3 and creates no database', async () => {
    const { env, controlDir, dataDir } = await setup();
    writeMarker(controlDir, marker({ state: 'maintenance', reason: 'deploy' }, 'test'));
    const stdin = new PassThrough();
    stdin.end('correct horse battery\n');
    const capture = captureIo();
    const code = await runHoldrUserCli(['add', 'alex', '--password-stdin'], {
      io: { stdin: stdin as unknown as CliStdin, stdout: capture.io.stdout as never, stderr: capture.io.stderr as never },
      env, defaultDataDir: dataDir, scryptParams: { ln: 10, r: 8, p: 1 },
    });
    expect(code).toBe(3);
    expect(capture.err()).toContain('E0I_MAINTENANCE');
    expect(fs.existsSync(path.join(dataDir, 'finance.db'))).toBe(false);
  });

  it('holdr-user and holdr-backup refuse lease variables before anything else (§9.3 rule 4)', async () => {
    const { env, dataDir } = await setup();
    const leased = { ...env, HOLDR_LIFECYCLE_LEASE: 'ab'.repeat(8) };
    const capture = captureIo();
    const code = await runHoldrUserCli(['list'], {
      io: { stdin: new PassThrough() as unknown as CliStdin, stdout: capture.io.stdout as never, stderr: capture.io.stderr as never },
      env: leased, defaultDataDir: dataDir,
    });
    expect(code).toBe(1);
    expect(capture.err()).toContain('E0I_LEASE_ENV');
    const backup = captureIo();
    expect(await runHoldrBackup(['--help'], { env: leased, io: backup.io })).toBe(1);
    expect(backup.err()).toContain('E0I_LEASE_ENV');
  });
});

// The command's own tests below need POSIX modes (0700 directories, 0600 files): its database copy is checked here on
// every platform, the ROG's gates included.
describe('holdr-backup database copy (every platform)', () => {
  it('copies every table and row through VACUUM INTO, and checks the copy', () => {
    const scratch = scratchDir('backup-copy');
    cleanups.push(scratch.cleanup);
    const source = path.join(scratch.dir, 'finance.db');
    syntheticDb(source);
    const dest = path.join(scratch.dir, 'dest');
    fs.mkdirSync(dest);
    copyDatabase(source, dest);
    const copy = new Database(path.join(dest, 'finance.db'), { readonly: true, fileMustExist: true });
    try {
      expect(tablesAndCounts(copy)).toEqual([['items', 2]]);
      expect(copy.prepare('SELECT label FROM items ORDER BY id').pluck().all()).toEqual(['synthetic-a', 'synthetic-b']);
      expect(copy.pragma('user_version', { simple: true })).toBe(14);
      expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      copy.close();
    }
  });

  it('takes native absolute paths: drive and UNC paths on Windows, / paths elsewhere', () => {
    for (const value of ['C:\\Users\\sample\\Holdr', 'C:\\', 'D:\\data', '\\\\server\\share\\holdr']) expect(isCanonicalNativeAbsolute(value, 'win32'), value).toBe(true);
    for (const value of ['C:/Users/sample', 'C:\\Users\\sample\\', 'C:\\a\\..\\b', 'relative', 'C:relative', '/Users/sample', '']) {
      expect(isCanonicalNativeAbsolute(value, 'win32'), value).toBe(false);
    }
    expect(isCanonicalNativeAbsolute('/Users/sample/Holdr', 'darwin')).toBe(true);
    expect(isCanonicalNativeAbsolute('C:\\Users\\sample', 'darwin')).toBe(false);
  });

  it('on Windows, restricts and owns a backup directory it creates and only checks one that exists', () => {
    const scratch = scratchDir('backup-private');
    cleanups.push(scratch.cleanup);
    const calls: string[] = [];
    let ownerOnly = true;
    const windows: WindowsPrivacy = {
      currentUserSid: () => 'S-1-5-21-1-2-3-1001',
      restrict: (dir, sid) => { calls.push(`restrict ${path.basename(dir)} ${sid}`); },
      isOwnerOnly: (dir) => { calls.push(`check ${path.basename(dir)}`); return ownerOnly; },
    };
    const dir = path.join(scratch.dir, 'backups');
    privateDir(dir, 'win32', windows);
    privateDir(dir, 'win32', windows);
    expect(calls).toEqual(['restrict backups S-1-5-21-1-2-3-1001', 'check backups', 'check backups']);
    ownerOnly = false;
    expect(() => privateDir(dir, 'win32', windows)).toThrow('E0I_BACKUP_PERMS');
    expect(() => privateDir(path.join(scratch.dir, 'other'), 'win32', { ...windows, currentUserSid: () => { throw new Error('no PowerShell'); } }))
      .toThrow('E0I_BACKUP_PERMS');
  });
});

// The real thing on Windows: icacls and the PowerShell ACL reader, no HOME and no control dir needed.
describe.runIf(process.platform === 'win32')('holdr-backup on Windows', { timeout: 60_000 }, () => {
  it('backs up a data dir named by a Windows path into owner-only directories, and refuses a shared backups directory', async () => {
    const scratch = scratchDir('backup-windows');
    cleanups.push(scratch.cleanup);
    const dataDir = path.join(scratch.dir, 'data');
    fs.mkdirSync(dataDir);
    syntheticDb(path.join(dataDir, 'finance.db'));
    // The access tokens, a temporary copy one left behind, and the service token where HOLDR_SERVICE_TOKEN_FILE puts it:
    // the API makes them anew when they are missing, so none is backed up and a restore never brings a rotated one back.
    for (const name of ['service-token', 'agent-token', 'service-token.4242.0123456789ab.tmp', 'api.secret', 'state.json']) {
      fs.writeFileSync(path.join(dataDir, name), 'synthetic\n');
    }
    const repo = path.join(scratch.dir, 'checkout');
    fs.mkdirSync(repo);
    const env = {
      HOLDR_DATA_DIR: dataDir, HOLDR_SERVICE_TOKEN_FILE: path.join(dataDir, 'api.secret'), PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    };
    const capture = captureIo();
    expect(await runHoldrBackup([], { env, io: capture.io, repoRoot: repo, now: () => new Date('2026-10-17T13:00:00.000Z') }), capture.err()).toBe(0);
    expect(fs.readdirSync(path.join(repo, 'backups', 'db', '20261017T130000Z')).sort()).toEqual(['finance.db', 'state.json']);
    const again = captureIo();
    expect(await runHoldrBackup([], { env, io: again.io, repoRoot: repo, now: () => new Date('2026-10-17T14:00:00.000Z') }), again.err()).toBe(0);

    // A folder without a database is backed up, and the output says that no database was in it.
    fs.rmSync(path.join(dataDir, 'finance.db'));
    const empty = captureIo();
    expect(await runHoldrBackup([], { env, io: empty.io, repoRoot: repo, now: () => new Date('2026-10-17T15:00:00.000Z') }), empty.err()).toBe(0);
    expect(empty.out()).toContain('holds no finance.db');
    expect(empty.out()).not.toContain('integrity_check');
    // A data folder that does not exist backs up nothing, creates nothing, and says where to point HOLDR_DATA_DIR.
    const missing = captureIo();
    const elsewhere = path.join(scratch.dir, 'elsewhere');
    expect(await runHoldrBackup([], { env: { ...env, HOLDR_DATA_DIR: path.join(scratch.dir, 'missing') }, io: missing.io, repoRoot: elsewhere })).toBe(0);
    expect(missing.out()).toMatch(/nothing to back up.*HOLDR_DATA_DIR/);
    expect(fs.existsSync(elsewhere)).toBe(false);

    // A backups directory others can read is refused, never repaired.
    const shared = path.join(scratch.dir, 'shared-checkout');
    fs.mkdirSync(path.join(shared, 'backups'), { recursive: true });
    execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [path.join(shared, 'backups'), '/grant', '*S-1-1-0:(OI)(CI)R'], { stdio: 'ignore' });
    const refused = captureIo();
    expect(await runHoldrBackup([], { env, io: refused.io, repoRoot: shared })).toBe(1);
    expect(refused.err()).toContain('E0I_BACKUP_PERMS');
    expect(fs.readdirSync(path.join(shared, 'backups'))).toEqual([]);
  });
});

describe.skipIf(process.platform !== 'darwin')('holdr-backup (K19, §11.3)', { timeout: 30_000 }, () => {
  it('writes a checked VACUUM INTO copy and the other files, 0600 in 0700 directories, under the shared lease', async () => {
    const { env, dataDir } = await setup();
    syntheticDb(path.join(dataDir, 'finance.db'));
    fs.writeFileSync(path.join(dataDir, 'state.json'), '{}\n', { mode: 0o600 });
    // The access tokens are the API's to make anew: never in a backup.
    for (const name of ['service-token', 'agent-token']) fs.writeFileSync(path.join(dataDir, name), 'synthetic\n', { mode: 0o600 });
    const repo = scratchDir('backup-repo');
    cleanups.push(repo.cleanup);
    const capture = captureIo();
    const code = await runHoldrBackup([], { env, io: capture.io, repoRoot: repo.dir, now: () => new Date('2026-10-17T13:00:00.123Z') });
    expect(code, capture.err()).toBe(0);
    const dest = path.join(repo.dir, 'backups/db/20261017T130000Z');
    expect(capture.out()).toBe(`Backed up ${dataDir} -> ${dest} (integrity_check ok)\n`);
    expect(fs.readdirSync(dest).sort()).toEqual(['finance.db', 'state.json']);
    for (const dir of ['backups', 'backups/db', 'backups/db/20261017T130000Z']) expect(fs.statSync(path.join(repo.dir, dir)).mode & 0o7777).toBe(0o700);
    for (const name of ['finance.db', 'state.json']) expect(fs.statSync(path.join(dest, name)).mode & 0o7777).toBe(0o600);
    const copy = new Database(path.join(dest, 'finance.db'), { readonly: true });
    expect(copy.prepare('SELECT label FROM items ORDER BY id').pluck().all()).toEqual(['synthetic-a', 'synthetic-b']);
    copy.close();
    expect(() => checkBackupPerms(repoPaths(repo.dir))).not.toThrow();
    // From the staging tree, --tree names the live tree whose backups dir receives the copy (§11.3 step 9).
    const live = scratchDir('backup-live');
    cleanups.push(live.cleanup);
    const other = captureIo();
    expect(await runHoldrBackup(['--tree', live.dir], { env, io: other.io, now: () => new Date('2026-10-17T14:00:00.000Z') })).toBe(0);
    expect(fs.readdirSync(path.join(live.dir, 'backups/db/20261017T140000Z')).sort()).toEqual(['finance.db', 'state.json']);
    expect(await runHoldrBackup(['--tree', 'relative'], { env, io: captureIo().io })).toBe(64);
  });

  it('refuses during maintenance (exit 3) before reading anything, with or without a database (B1 review 6)', async () => {
    for (const withDb of [true, false]) {
      const { env, controlDir, dataDir } = await setup();
      if (withDb) syntheticDb(path.join(dataDir, 'finance.db'));
      fs.writeFileSync(path.join(dataDir, 'state.json'), '{}\n', { mode: 0o600 });
      writeMarker(controlDir, marker({ state: 'maintenance', reason: 'deploy' }, 'test'));
      const repo = scratchDir('backup-repo');
      cleanups.push(repo.cleanup);
      const capture = captureIo();
      expect(await runHoldrBackup([], { env, io: capture.io, repoRoot: repo.dir }), String(withDb)).toBe(3);
      expect(capture.err()).toContain('E0I_MAINTENANCE');
      // The lease comes first: no backup directory was even created, and no data file was read.
      expect(fs.existsSync(path.join(repo.dir, 'backups')), String(withDb)).toBe(false);
    }
  });

  it('holds the shared lease for the whole backup, also without a database', async () => {
    const { env, controlDir, dataDir } = await setup();
    fs.writeFileSync(path.join(dataDir, 'state.json'), '{}\n', { mode: 0o600 });
    const repo = scratchDir('backup-repo');
    cleanups.push(repo.cleanup);
    const holder = await lockHolder(lockPath(controlDir, LIFECYCLE_LOCK), 'exclusive', cleanups);
    const capture = captureIo();
    expect(await runHoldrBackup([], { env, io: capture.io, repoRoot: repo.dir })).toBe(75);
    expect(capture.err()).toContain('E0I_LIFECYCLE_BUSY');
    expect(fs.existsSync(path.join(repo.dir, 'backups'))).toBe(false);
    holder.kill('SIGKILL');
    await exited(holder);
    const after = captureIo();
    expect(await runHoldrBackup([], { env, io: after.io, repoRoot: repo.dir, now: () => new Date('2026-10-17T15:00:00.000Z') })).toBe(0);
    expect(fs.readdirSync(path.join(repo.dir, 'backups/db/20261017T150000Z'))).toEqual(['state.json']);
  });
});

describe.skipIf(process.platform !== 'darwin')('validate-offline checks (§9.3 step 5)', () => {
  it('passes a healthy data dir and reports integrity and user_version', async () => {
    const { env, controlDir, dataDir } = await setup();
    syntheticDb(path.join(dataDir, 'finance.db'));
    const lines = await validateOffline({ env, controlDir, dataDir, run: fakeSystem });
    expect(lines).toContain(`ok   database: integrity ok, user_version 14`);
    expect(lines).toContain('ok   K21 fence: blocked (init)');
    expect(lines.at(-1)).toBe('n/a  generation agreement (needs E1b v15)');
  });

  it('fails on a newer user_version, an unsafe data dir and a corrupt database, listing every failure', async () => {
    const { env, controlDir, dataDir } = await setup();
    syntheticDb(path.join(dataDir, 'finance.db'), CURRENT_USER_VERSION + 1);
    await expect(validateOffline({ env, controlDir, dataDir, run: fakeSystem })).rejects.toMatchObject({
      code: 'E0I_VALIDATION', lines: expect.arrayContaining([`FAIL database: E0I_DB_VERSION (user_version above ${CURRENT_USER_VERSION})`]),
    });
    fs.chmodSync(dataDir, 0o755);
    await expect(validateOffline({ env, controlDir, dataDir, run: fakeSystem })).rejects.toMatchObject({
      detail: 'K18 data dir private, database',
    });
    fs.chmodSync(dataDir, 0o700);
    const file = path.join(dataDir, 'finance.db');
    const bytes = fs.readFileSync(file);
    bytes.fill(0x55, 4096, 8192);
    fs.writeFileSync(file, bytes);
    await expect(validateOffline({ env, controlDir, dataDir, run: fakeSystem })).rejects.toMatchObject({ code: 'E0I_VALIDATION' });
  });
});
