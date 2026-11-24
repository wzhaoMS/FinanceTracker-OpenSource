import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRunDirectories, directoryIdentity, prepareWorkRoot, removeRunDirectory } from './runDir.js';

const NOW = new Date('2026-10-17T00:16:49.123Z');

/**
 * Directory links: junctions on Windows, which any user may create there
 * (Node reports them as symlinks), symlinks elsewhere. Targets are absolute.
 */
const DIR_LINK = process.platform === 'win32' ? 'junction' : 'dir';
/**
 * macOS and Linux only: tests that use chmod to let others write (on Windows
 * the ACL decides, and chmod cannot change it) or rename the directory this
 * process is working in (Windows refuses). Each names its Windows
 * counterpart, mostly in pathSafety.windows.test.ts (ACLs injected) and
 * windowsAcl.win32.test.ts (real ACLs and icacls).
 */
const posixOnly = it.skipIf(process.platform === 'win32');

describe('e2e run directories', () => {
  let root: string;
  let savedHome: { HOME?: string; USERPROFILE?: string };
  // A mock deployed checkout: nothing here may ever be created, followed or deleted.
  let mockApi: string;
  let mockData: string;

  const mockDataIsIntact = () => {
    expect(fs.readdirSync(mockApi)).toEqual(['data']);
    expect(fs.readFileSync(path.join(mockData, 'finance.db'), 'utf8')).toBe('mock live database');
  };

  beforeEach(async () => {
    root = fs.realpathSync(await mkdtemp(path.join(tmpdir(), 'ft-e2e-run-')));
    // The trusted root for the ancestor checks is the home directory (or the
    // checkout); make it this private test root so the host's temp directory
    // permissions do not matter. os.homedir() is HOME, or USERPROFILE on Windows.
    savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    mockApi = path.join(root, 'mock-deploy', 'FinanceTracker', 'apps', 'api');
    mockData = path.join(mockApi, 'data');
    fs.mkdirSync(mockData, { recursive: true });
    fs.writeFileSync(path.join(mockData, 'finance.db'), 'mock live database');
  });

  afterEach(async () => {
    for (const [name, value] of Object.entries(savedHome)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('creates a private run directory with data and logs and records their identity chains', () => {
    const dirs = createRunDirectories(path.join(root, 'work'), { label: '4242', now: NOW, suffix: 'a1b2c3' });
    expect(dirs.runDir).toBe(path.join(root, 'work', 'run-20261017T001649Z-4242-a1b2c3'));
    expect(dirs.dataDir).toBe(path.join(dirs.runDir, 'data'));
    expect(dirs.logDir).toBe(path.join(dirs.runDir, 'logs'));
    const work = directoryIdentity(path.join(root, 'work'));
    const run = directoryIdentity(dirs.runDir);
    expect(dirs.runDirId).toBe(`${work}/${run}`);
    expect(dirs.dataDirId).toBe(`${work}/${run}/${directoryIdentity(dirs.dataDir)}`);
    expect(dirs.logDirId).toBe(`${work}/${run}/${directoryIdentity(dirs.logDir)}`);
    // Mode bits say nothing on Windows (Node reports 0o666 there); windowsAcl.win32.test.ts checks the ACL icacls leaves.
    if (process.platform !== 'win32') {
      for (const dir of [path.join(root, 'work'), dirs.runDir, dirs.dataDir, dirs.logDir]) {
        expect(fs.lstatSync(dir).mode & 0o777).toBe(0o700);
      }
    }
    expect(fs.readdirSync(dirs.dataDir)).toEqual([]);
  });

  it('refuses a work directory that is a symlink, creating nothing behind it', () => {
    const link = path.join(root, 'work-link');
    fs.symlinkSync(mockApi, link, DIR_LINK);
    expect(() => createRunDirectories(link)).toThrow(/not a plain directory/);
    mockDataIsIntact();
  });

  it('refuses work directories inside apps/api/data, also through a symlinked parent', () => {
    const inCheckout = path.join(root, 'checkout', 'apps', 'api', 'data', 'e2e');
    expect(() => prepareWorkRoot(inCheckout)).toThrow(/live/);
    expect(fs.existsSync(path.join(root, 'checkout'))).toBe(false);

    const link = path.join(root, 'innocent');
    fs.symlinkSync(mockApi, link, DIR_LINK);
    expect(() => prepareWorkRoot(path.join(link, 'data', 'e2e'))).toThrow(/live/);
    mockDataIsIntact();
    expect(fs.readdirSync(mockData)).toEqual(['finance.db']);
  });

  it('never creates a run directory through an entry planted at its name', () => {
    const work = path.join(root, 'work');
    fs.mkdirSync(work);
    fs.symlinkSync(mockApi, path.join(work, 'run-20261017T001649Z-4242-a1b2c3'), DIR_LINK);
    expect(() => createRunDirectories(work, { label: '4242', now: NOW, suffix: 'a1b2c3' })).toThrow(/EEXIST/);
    mockDataIsIntact();
  });

  describe('directories other users could change', () => {
    // Windows: ACLs that let Authenticated Users, Everyone or Users write are refused
    // (pathSafety.windows.test.ts; a real Users grant in windowsAcl.win32.test.ts).
    posixOnly.each([0o777, 0o775, 0o757, 0o1777])('refuses an existing work directory with mode %o', (mode) => {
      const work = path.join(root, 'work');
      fs.mkdirSync(work);
      fs.chmodSync(work, mode);
      expect(() => createRunDirectories(work)).toThrow(/writable by its group or by other users/);
      expect(fs.readdirSync(work)).toEqual([]);
    });

    // Windows: nothing is created below a directory whose ACL lets others write (pathSafety.windows.test.ts).
    posixOnly('refuses a work directory below a directory others can write to, before creating anything', () => {
      const shared = path.join(root, 'shared');
      fs.mkdirSync(shared);
      fs.chmodSync(shared, 0o777);
      expect(() => createRunDirectories(path.join(shared, 'work'))).toThrow(/shared .*writable by its group or by other users/);
      expect(fs.readdirSync(shared)).toEqual([]);

      const existing = path.join(shared, 'private-work');
      fs.mkdirSync(existing, { mode: 0o700 });
      expect(() => createRunDirectories(existing)).toThrow(/above .*private-work/);
      expect(fs.readdirSync(existing)).toEqual([]);
    });

    // Windows: every directory above is read up to the home directory (pathSafety.windows.test.ts).
    posixOnly('checks the ancestors only up to the trusted root (the home directory or the checkout)', () => {
      const shared = path.join(root, 'shared');
      const home = path.join(shared, 'home');
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      fs.chmodSync(shared, 0o777);
      process.env.HOME = home;
      expect(createRunDirectories(path.join(home, 'work')).runDir.startsWith(path.join(home, 'work', 'run-'))).toBe(true);
      process.env.HOME = root;
      expect(() => createRunDirectories(path.join(home, 'work'))).toThrow(/writable by its group or by other users/);
    });

    it.runIf(process.platform === 'darwin')('refuses a work directory whose ACL lets others write, but not one that only denies', () => {
      const work = path.join(root, 'work');
      fs.mkdirSync(work, { mode: 0o700 });
      execFileSync('chmod', ['+a', 'group:everyone allow add_file,add_subdirectory,delete_child', work]);
      expect(() => createRunDirectories(work)).toThrow(/ACL that lets others write .*group:everyone allow add_file/);
      expect(fs.readdirSync(work)).toEqual([]);

      // Like the entry macOS puts on home folders.
      const denied = path.join(root, 'denied');
      fs.mkdirSync(denied, { mode: 0o700 });
      execFileSync('chmod', ['+a', 'group:everyone deny delete', denied]);
      try {
        expect(fs.readdirSync(createRunDirectories(denied).runDir).sort()).toEqual(['data', 'logs']);
      } finally {
        execFileSync('chmod', ['-N', denied]);
      }
    });

    // Windows: a run directory is deleted only while its ACLs and identities still pass (pathSafety.windows.test.ts).
    posixOnly('refuses to clean up once the work or run directory has become writable by others', () => {
      const dirs = createRunDirectories(path.join(root, 'work'));
      fs.chmodSync(path.join(root, 'work'), 0o777);
      expect(() => removeRunDirectory(dirs.runDir, dirs.runDirId)).toThrow(/writable by its group or by other users/);
      fs.chmodSync(path.join(root, 'work'), 0o700);
      fs.chmodSync(dirs.runDir, 0o777);
      expect(() => removeRunDirectory(dirs.dataDir, dirs.dataDirId)).toThrow(/writable by its group or by other users/);
      expect(fs.readdirSync(dirs.runDir).sort()).toEqual(['data', 'logs']);
    });
  });

  it('removes a run directory only while it is the directory the run created', () => {
    const dirs = createRunDirectories(path.join(root, 'work'));
    fs.writeFileSync(path.join(dirs.dataDir, 'finance.db'), 'synthetic');
    expect(removeRunDirectory(dirs.dataDir, dirs.dataDirId)).toBe('removed');
    expect(fs.existsSync(dirs.dataDir)).toBe(false);
    expect(removeRunDirectory(dirs.dataDir, dirs.dataDirId)).toBe('absent');
    expect(removeRunDirectory(dirs.runDir, dirs.runDirId)).toBe('removed');
    expect(fs.existsSync(dirs.runDir)).toBe(false);
  });

  it('refuses a malformed identity chain', () => {
    const dirs = createRunDirectories(path.join(root, 'work'));
    for (const chain of ['', '1:2', '1:2/x', `${dirs.runDirId}/`]) {
      expect(() => removeRunDirectory(dirs.runDir, chain)).toThrow(/malformed identity chain/);
    }
    expect(fs.existsSync(dirs.runDir)).toBe(true);
  });

  it('refuses to delete a run path that now leads into a deployed data directory', () => {
    const dirs = createRunDirectories(path.join(root, 'work'));
    fs.rmdirSync(dirs.dataDir);
    fs.symlinkSync(mockData, dirs.dataDir, DIR_LINK);
    expect(() => removeRunDirectory(dirs.dataDir, dirs.dataDirId)).toThrow(/not a plain directory/);
    mockDataIsIntact();

    const moved = `${dirs.runDir}-moved`;
    fs.renameSync(dirs.runDir, moved);
    fs.symlinkSync(mockApi, dirs.runDir, DIR_LINK);
    expect(() => removeRunDirectory(dirs.runDir, dirs.runDirId)).toThrow(/not a plain directory/);
    expect(() => removeRunDirectory(path.join(dirs.runDir, 'data'), dirs.dataDirId)).toThrow(/not a plain directory/);
    mockDataIsIntact();
  });

  it('removes a symlink inside the run directory without following it', () => {
    const dirs = createRunDirectories(path.join(root, 'work'));
    fs.rmdirSync(dirs.dataDir);
    fs.symlinkSync(mockData, dirs.dataDir, DIR_LINK);
    expect(removeRunDirectory(dirs.runDir, dirs.runDirId)).toBe('removed');
    expect(fs.existsSync(dirs.runDir)).toBe(false);
    // The link's target survives with its contents: the recursive deletion
    // removes the link (a junction on Windows) and never descends into it.
    mockDataIsIntact();
    expect(fs.readdirSync(mockData)).toEqual(['finance.db']);
  });

  it('refuses a directory that was replaced by a different one', () => {
    const dirs = createRunDirectories(path.join(root, 'work'));
    fs.renameSync(dirs.dataDir, `${dirs.dataDir}-original`);
    fs.mkdirSync(dirs.dataDir, { mode: 0o700 });
    expect(directoryIdentity(dirs.dataDir)).not.toBe(dirs.dataDirId.split('/')[2]);
    expect(() => removeRunDirectory(dirs.dataDir, dirs.dataDirId)).toThrow(/no longer the directory this run created/);
    expect(fs.existsSync(dirs.dataDir)).toBe(true);
  });

  describe('a parent swapped between the checks and the deletion', () => {
    // fs.rmSync is the deletion itself: swapping just before it runs is the
    // latest moment a rename by someone who can write to the parent could land.
    // macOS and Linux only. Windows has no counterpart: there the parent is this
    // process's working directory during the deletion, and Windows refuses to
    // rename a process's working directory, so the swap cannot happen at all.
    const swapJustBeforeDeletion = (victim: string, decoy: string): string[] => {
      const realRmSync = fs.rmSync;
      const deleted: string[] = [];
      vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
        deleted.push(String(target));
        fs.renameSync(victim, `${victim}-moved`);
        fs.symlinkSync(decoy, victim);
        return realRmSync(target, options);
      });
      return deleted;
    };

    posixOnly('failed-run cleanup deletes the verified data/, never the data/ of a swapped-in run directory', () => {
      const dirs = createRunDirectories(path.join(root, 'work'));
      fs.writeFileSync(path.join(dirs.dataDir, 'finance.db'), 'synthetic');
      const deleted = swapJustBeforeDeletion(dirs.runDir, mockApi);
      expect(removeRunDirectory(dirs.dataDir, dirs.dataDirId)).toBe('removed');
      expect(deleted).toEqual(['data']);
      mockDataIsIntact();
      expect(fs.readdirSync(`${dirs.runDir}-moved`)).toEqual(['logs']);
    });

    posixOnly('successful-run cleanup deletes the verified run directory, never one in a swapped-in work directory', () => {
      const work = path.join(root, 'work');
      const dirs = createRunDirectories(work);
      const runName = path.basename(dirs.runDir);
      const decoyWork = path.join(mockApi, 'data');
      fs.mkdirSync(path.join(decoyWork, runName));
      fs.writeFileSync(path.join(decoyWork, runName, 'finance.db'), 'mock live database');
      const deleted = swapJustBeforeDeletion(work, decoyWork);
      expect(removeRunDirectory(dirs.runDir, dirs.runDirId)).toBe('removed');
      expect(deleted).toEqual([runName]);
      expect(fs.readFileSync(path.join(decoyWork, runName, 'finance.db'), 'utf8')).toBe('mock live database');
      expect(fs.readdirSync(`${work}-moved`)).toEqual([]);
    });
  });
});
