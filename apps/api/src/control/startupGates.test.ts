import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../auth/password.js';
import { LocalAuthRepo } from '../services/localAuthRepo.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { checkControlDir, controlStatus, formatControlStatus, initControlDir, timeMachineExcluded } from './controlDir.js';
import { systemRunner } from './exec.js';
import { acquireSharedLease } from './lifecycle.js';
import { contains, disjoint, repoPaths } from './paths.js';
import {
  checkBackupPerms, checkDataOverlap, checkDataPerms, checkTokenLocation, checkUsers, repairMainDataFiles, runDataAndControlGates,
  tokenFileFor,
} from './startupGates.js';
import { TEST_MACHINE, controlFixture, fakeTmutil, outsideRepoDir } from './testControl.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const outside = () => { const o = outsideRepoDir('gate'); cleanups.push(o.cleanup); return o.dir; };

/** A fake repository layout so overlap checks never depend on where the test tree lives. */
function layout() {
  const root = outside();
  const repo = repoPaths(path.join(root, 'repo'));
  for (const dir of [repo.releasesRoot, repo.shared, repo.nodeModules, path.join(repo.root, 'apps/api/data')]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const dataDir = path.join(repo.root, 'apps/api/data');
  const controlDir = path.join(root, 'control');
  return { root, repo, dataDir, controlDir };
}

describe.skipIf(process.platform !== 'darwin')('control dir (§9.2, K20, init, status)', () => {
  it('init creates exactly the five private files, blocked/init and normal, and refuses to run twice', async () => {
    const { repo, controlDir } = layout();
    expect(await initControlDir(controlDir, { machine: TEST_MACHINE, run: fakeTmutil, repo })).toEqual({ excluded: true });
    expect(fs.readdirSync(controlDir).sort()).toEqual(['authorization.lock', 'lifecycle-state', 'lifecycle.lock', 'recovery.lock', 'sync-auth-state']);
    for (const name of fs.readdirSync(controlDir)) expect(fs.statSync(path.join(controlDir, name)).mode & 0o7777).toBe(0o600);
    expect(fs.statSync(controlDir).mode & 0o7777).toBe(0o700);
    await expect(initControlDir(controlDir, { machine: TEST_MACHINE, run: fakeTmutil, repo })).rejects.toThrow('E0I_CONTROL_DIR');
    expect(() => checkControlDir(controlDir, { repo })).not.toThrow();
  });

  it('K20 refuses a missing, loose, symlinked or overlapping control dir', async () => {
    const { repo, dataDir, controlDir, root } = layout();
    expect(() => checkControlDir(controlDir, { repo })).toThrow('E0I_CONTROL_DIR');
    await initControlDir(controlDir, { machine: TEST_MACHINE, run: fakeTmutil, repo });
    fs.chmodSync(controlDir, 0o750);
    expect(() => checkControlDir(controlDir, { repo })).toThrow('E0I_CONTROL_DIR');
    fs.chmodSync(controlDir, 0o700);
    fs.symlinkSync(controlDir, path.join(root, 'control-link'));
    expect(() => checkControlDir(path.join(root, 'control-link'), { repo })).toThrow('E0I_CONTROL_DIR');
    expect(() => checkControlDir(controlDir, { repo, dataDir: path.join(controlDir, 'data') })).toThrow('E0I_CONTROL_DIR');
    const inRepo = path.join(repo.root, 'control');
    await expect(initControlDir(inRepo, { machine: TEST_MACHINE, run: fakeTmutil, repo })).rejects.toThrow('E0I_CONTROL_DIR');
    // Disposable stacks may keep their control dir under the repo tree (§7.2), never inside the data dir.
    expect(() => checkControlDir(inRepo, { repo, disposable: true })).not.toThrow();
    expect(() => checkControlDir(inRepo, { repo, disposable: true, dataDir: inRepo })).toThrow('E0I_CONTROL_DIR');
    // A child whose name merely starts with `..` is inside (B1 review 1): `<repo>/..control` overlaps the repo tree.
    const dotted = path.join(repo.root, '..control');
    fs.mkdirSync(dotted, { mode: 0o700 });
    fs.chmodSync(dotted, 0o700);
    expect(() => checkControlDir(dotted, { repo })).toThrow('E0I_CONTROL_DIR');
    expect(() => checkControlDir(controlDir, { repo, dataDir: path.join(controlDir, '..data') })).toThrow('E0I_CONTROL_DIR');
    void dataDir;
  });

  it('status is lock-free, value-free and lists holders while a lease is held', async () => {
    const f = await controlFixture();
    cleanups.push(f.cleanup);
    const lease = await acquireSharedLease(f.controlDir, { timeoutMs: 200 });
    try {
      const status = await controlStatus(f.controlDir, { machine: TEST_MACHINE, run: systemRunner });
      expect(status.gate).toBe('blocked (init)');
      expect(status.machineMatches).toBe(true);
      expect(status.marker).toBe('normal');
      expect(status.holders['lifecycle.lock']).toMatch(new RegExp(`^${process.pid} `));
      expect(Object.values(status.entries)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
      const text = formatControlStatus(status);
      expect(text).toContain('device gate: blocked (init)');
      expect(text).toContain('db: not available before E1b v15');
    } finally { lease.release(); }
  });

  it('adds a real, sticky Time Machine exclusion to a disposable control dir', async () => {
    const { repo, controlDir } = layout();
    expect(await initControlDir(controlDir, { machine: TEST_MACHINE, run: systemRunner, repo })).toEqual({ excluded: true });
    expect(await timeMachineExcluded(systemRunner, controlDir)).toBe(true);
  });
});

describe.skipIf(process.platform !== 'darwin')('K17–K23 (§7.2)', () => {
  it('K17: the data dir may not overlap code, releases or the control dir', () => {
    const { repo, dataDir, controlDir } = layout();
    expect(() => checkDataOverlap({ dataDir, controlDir, repo })).not.toThrow();
    for (const [other, field] of [
      [repo.releasesRoot, 'dataDir'], [path.join(repo.releasesRoot, 'abc'), 'releaseDir'], [repo.shared, 'dataDir'],
      [repo.nodeModules, 'dataDir'], [path.join(repo.root, 'apps/web/src'), 'dataDir'],
    ] as const) {
      const input = field === 'releaseDir' ? { dataDir: path.join(repo.releasesRoot, 'abc', 'x'), controlDir, repo, releaseDir: other }
        : { dataDir: other, controlDir, repo };
      expect(() => checkDataOverlap(input)).toThrow('E0I_DATA_OVERLAP');
    }
    expect(() => checkDataOverlap({ dataDir, controlDir: path.join(dataDir, 'control'), repo })).toThrow('E0I_DATA_OVERLAP');
    // Physical paths count too: a symlink cannot smuggle the data dir into the releases root.
    fs.symlinkSync(repo.releasesRoot, path.join(repo.root, 'alias'));
    expect(() => checkDataOverlap({ dataDir: path.join(repo.root, 'alias'), controlDir, repo })).toThrow('E0I_DATA_OVERLAP');
    // Names that merely start with `..` are children (B1 review 1): each of these overlaps, by text and physically.
    for (const input of [
      { dataDir: path.join(repo.web, '..data'), controlDir, repo }, { dataDir: path.join(repo.nodeModules, '..x'), controlDir, repo },
      { dataDir, controlDir: path.join(dataDir, '..control'), repo },
      { dataDir: path.join(repo.releasesRoot, 'abc', '..data'), controlDir, repo, releaseDir: path.join(repo.releasesRoot, 'abc') },
    ]) {
      fs.mkdirSync(input.dataDir, { recursive: true, mode: 0o700 });
      expect(() => checkDataOverlap(input), input.dataDir).toThrow('E0I_DATA_OVERLAP');
    }
  });

  it('contains() and disjoint() judge path components: `..x` is a child, `..` and `../x` are not, a common prefix is not', () => {
    expect(contains('/r', '/r')).toBe(true);
    for (const inner of ['/r/..data', '/r/..', '/r/a/..b', '/r/...']) expect(contains('/r', path.normalize(inner)), inner).toBe(inner !== '/r/..');
    for (const inner of ['/', '/x', '/rr', '/r..', '/x/r', '/r/../x']) expect(contains('/r', path.normalize(inner)), inner).toBe(false);
    expect(disjoint('/r/..data', '/r')).toBe(false);
    expect(disjoint('/r', '/rr')).toBe(true);
  });

  it('K18: repairs the four main files first, then refuses any loose, foreign or symlinked entry; never creates the dir', () => {
    const { dataDir } = layout();
    fs.chmodSync(dataDir, 0o755);
    fs.writeFileSync(path.join(dataDir, 'finance.db'), 'x', { mode: 0o644 });
    fs.chmodSync(path.join(dataDir, 'finance.db'), 0o644);
    const lines: string[] = [];
    repairMainDataFiles(dataDir, (line) => lines.push(line));
    expect(lines).toHaveLength(2);
    expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dataDir, 'finance.db')).mode & 0o777).toBe(0o600);
    expect(() => checkDataPerms(dataDir)).not.toThrow();
    fs.writeFileSync(path.join(dataDir, 'state.json.bak'), 'x', { mode: 0o644 });
    fs.chmodSync(path.join(dataDir, 'state.json.bak'), 0o644);
    expect(() => checkDataPerms(dataDir)).toThrow('E0I_DATA_PERMS');
    fs.chmodSync(path.join(dataDir, 'state.json.bak'), 0o600);
    fs.mkdirSync(path.join(dataDir, 'a/b/c'), { recursive: true, mode: 0o700 });
    fs.symlinkSync('/etc/hosts', path.join(dataDir, 'a/b/c/link'));
    expect(() => checkDataPerms(dataDir)).toThrow('E0I_DATA_PERMS');
    fs.unlinkSync(path.join(dataDir, 'a/b/c/link'));
    expect(() => checkDataPerms(dataDir)).not.toThrow();
    expect(() => checkDataPerms(path.join(dataDir, 'missing'))).toThrow('E0I_DATA_PERMS');
    expect(fs.existsSync(path.join(dataDir, 'missing'))).toBe(false);
  });

  it('K19: backups must be 0700 dirs and 0600 single-link files', () => {
    const { repo } = layout();
    expect(() => checkBackupPerms(repo)).not.toThrow();
    const stamp = path.join(repo.backups, 'db', '20261017T000000Z');
    fs.mkdirSync(stamp, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(stamp, 'finance.db'), 'x', { mode: 0o600 });
    expect(() => checkBackupPerms(repo)).not.toThrow();
    fs.chmodSync(path.join(stamp, 'finance.db'), 0o644);
    expect(() => checkBackupPerms(repo)).toThrow('E0I_BACKUP_PERMS');
    fs.chmodSync(path.join(stamp, 'finance.db'), 0o600);
    fs.linkSync(path.join(stamp, 'finance.db'), path.join(stamp, 'second'));
    expect(() => checkBackupPerms(repo)).toThrow('E0I_BACKUP_PERMS');
  });

  it('K22: the token never lives in releases, apps/web or the control dir', () => {
    const { repo, dataDir, controlDir } = layout();
    expect(tokenFileFor({}, dataDir)).toBe(path.join(dataDir, 'service-token'));
    expect(() => checkTokenLocation({ dataDir, controlDir, repo, tokenFile: path.join(dataDir, 'service-token') })).not.toThrow();
    for (const tokenFile of [path.join(repo.releasesRoot, 't'), path.join(repo.web, 't'), path.join(controlDir, 't'),
      // B1 review 1: a directory whose name starts with `..` is still inside.
      path.join(repo.web, '..private', 'service-token'), path.join(controlDir, '..t', 'service-token'), path.join(repo.releasesRoot, '..x')]) {
      expect(() => checkTokenLocation({ dataDir, controlDir, repo, tokenFile }), tokenFile).toThrow('E0I_TOKEN_LOCATION');
    }
  });

  it('K23: no database or no users refuses; a database with a user passes; an unreadable database only warns', async () => {
    const { dataDir } = layout();
    const db = path.join(dataDir, 'finance.db');
    expect(() => checkUsers(db)).toThrow('E0I_NO_USERS');
    const repo = new SqliteStateRepo({ file: db });
    expect(() => checkUsers(db)).toThrow('E0I_NO_USERS');
    new LocalAuthRepo(repo).createUser('synthetic-user', await hashPassword('synthetic password 1', { ln: 10, r: 8, p: 1 }));
    repo.close();
    expect(checkUsers(db)).toEqual({ users: 1 });
    fs.chmodSync(db, 0o000);
    try {
      expect(checkUsers(db)).toEqual({ warning: expect.stringContaining('K23') });
    } finally {
      fs.chmodSync(db, 0o600);
    }
  });

  it('runs K17–K22 in order and returns the fence for the device-gate log', async () => {
    const { repo, dataDir, controlDir } = layout();
    await initControlDir(controlDir, { machine: TEST_MACHINE, run: fakeTmutil, repo });
    const fence = runDataAndControlGates({ dataDir, controlDir, repo, tokenFile: path.join(dataDir, 'service-token'), machine: TEST_MACHINE });
    expect(fence).toMatchObject({ gate: 'closed', reason: 'blocked:init' });
    fs.chmodSync(path.join(controlDir, 'sync-auth-state'), 0o644);
    expect(() => runDataAndControlGates({ dataDir, controlDir, repo, tokenFile: path.join(dataDir, 't'), machine: TEST_MACHINE })).toThrow('E0I_FENCE_FILE');
  });
});
