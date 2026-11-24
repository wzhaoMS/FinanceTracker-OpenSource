import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertPrivateDirectory, assertTrustedAncestors, exactIdentity, makePrivateDirectory } from './pathSafety.js';
import { createRunDirectories, removeRunDirectory } from './runDir.js';
import { createRunIdentity } from './runIdentity.js';
import { prepareDisposableDataDir } from './syntheticSeed.js';
import { ADMINISTRATORS_SID, SYSTEM_SID, readCurrentUserSid, readWindowsAcls, restrictToUser, system32, windowsAclProblem } from './windowsAcl.js';

/**
 * The real Windows calls behind the directory checks: PowerShell's ACL read,
 * icacls, junctions and NTFS hard links, under the per-user temp folder the
 * runner uses by default. Windows only (README: checklist for Windows);
 * pathSafety.windows.test.ts covers the same logic on every platform with
 * the ACL reader replaced.
 */

const RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'scripts', 'e2e-disposable.mjs');

describe.runIf(process.platform === 'win32')('Windows ACLs, for real', () => {
  let root: string;
  let user: string;

  beforeAll(async () => {
    root = fs.realpathSync.native(await mkdtemp(path.join(fs.realpathSync.native(os.tmpdir()), 'ft-e2e-win32-')));
    user = readCurrentUserSid();
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it("reads the current user's SID", () => {
    expect(user).toMatch(/^S-1-\d+(-\d+)+$/);
  });

  it('finds the temp folder, and every directory above it up to the profile, private', () => {
    expect(root.toLowerCase().startsWith(fs.realpathSync.native(os.homedir()).toLowerCase())).toBe(true);
    const [tempAcl] = readWindowsAcls([path.dirname(root)]);
    expect(windowsAclProblem(tempAcl, user, [user, SYSTEM_SID, ADMINISTRATORS_SID])).toBeNull();
    expect(() => assertTrustedAncestors(root)).not.toThrow();
  });

  it('leaves full control to the user and SYSTEM alone after icacls', () => {
    const dir = path.join(root, 'restricted');
    fs.mkdirSync(dir);
    restrictToUser(dir, user);
    const [dirAcl] = readWindowsAcls([dir]);
    expect(dirAcl.owner).toBe(user);
    expect(new Set(dirAcl.aces.map((ace) => ace.sid))).toEqual(new Set([user, SYSTEM_SID]));
    expect(dirAcl.aces.every((ace) => ace.type === 'Allow')).toBe(true);
    expect(windowsAclProblem(dirAcl, user, [user])).toBeNull();
  });

  it('accepts a private directory although Node reports group and other write bits', () => {
    const dir = path.join(root, 'reported-mode');
    makePrivateDirectory(dir);
    expect(fs.lstatSync(dir).mode & 0o022).not.toBe(0);
    expect(() => assertPrivateDirectory(dir)).not.toThrow();
  });

  it('refuses a directory that Users may modify', () => {
    const dir = path.join(root, 'shared');
    makePrivateDirectory(dir);
    execFileSync(system32('icacls.exe'), [dir, '/grant', '*S-1-5-32-545:(OI)(CI)M'], { stdio: 'ignore' });
    expect(() => assertPrivateDirectory(dir)).toThrow(/lets Users \(S-1-5-32-545\) write to it/);
  });

  it('reports a junction as a symbolic link, which is refused', () => {
    const target = path.join(root, 'junction-target');
    makePrivateDirectory(target);
    const junction = path.join(root, 'junction');
    fs.symlinkSync(target, junction, 'junction');
    expect(fs.lstatSync(junction).isSymbolicLink()).toBe(true);
    expect(() => assertPrivateDirectory(junction)).toThrow(/not a plain directory/);
  });

  it('counts NTFS hard links and reads exact file IDs', () => {
    const file = path.join(root, 'file');
    fs.writeFileSync(file, 'x');
    fs.linkSync(file, path.join(root, 'file-link'));
    expect(fs.lstatSync(file).nlink).toBe(2);
    expect(exactIdentity(file)).toMatch(/^\d+:\d+$/);
    expect(exactIdentity(file)).toBe(exactIdentity(path.join(root, 'file-link')));
  });

  it('refuses a data directory whose finance.db is a hard link to another database', () => {
    const live = path.join(root, 'mock-live.db');
    fs.writeFileSync(live, 'mock live database');
    const dataDir = prepareDisposableDataDir(path.join(root, 'data'));
    fs.linkSync(live, path.join(dataDir, 'finance.db'));
    expect(() => createRunIdentity('0123456789abcdef0123456789abcdef', dataDir)).toThrow(/finance\.db has 2 hard links/);
    expect(fs.readFileSync(live, 'utf8')).toBe('mock live database');
  });

  it("refuses a data directory whose finance.db has its own ACL letting Users modify it", () => {
    const dataDir = prepareDisposableDataDir(path.join(root, 'data-with-shared-db'));
    const db = path.join(dataDir, 'finance.db');
    fs.writeFileSync(db, '');
    // As a file moved in from elsewhere keeps: the directory's ACL does not protect it.
    execFileSync(system32('icacls.exe'), [db, '/grant', '*S-1-5-32-545:(M)'], { stdio: 'ignore' });
    expect(() => createRunIdentity('0123456789abcdef0123456789abcdef', dataDir)).toThrow(/finance\.db has an ACL that lets Users \(S-1-5-32-545\) write to it/);
  });

  it('creates private run directories under the temp folder and removes them', () => {
    const dirs = createRunDirectories(path.join(root, 'work'));
    for (const dir of [dirs.runDir, dirs.dataDir, dirs.logDir]) expect(() => assertPrivateDirectory(dir)).not.toThrow();
    expect(removeRunDirectory(dirs.runDir, dirs.runDirId)).toBe('removed');
    expect(fs.existsSync(dirs.runDir)).toBe(false);
  });

  it("puts the runner's default work directory under the temp folder", () => {
    // In plain Node, not through Vite: Vite's hashbang handling expects LF, and
    // a checkout older than the .gitattributes rule for scripts/*.mjs has CRLF.
    const script = `import { defaultWorkDir } from ${JSON.stringify(pathToFileURL(RUNNER).href)}; process.stdout.write(defaultWorkDir());`;
    const workDir = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(workDir).toBe(path.join(fs.realpathSync.native(os.tmpdir()), 'holdr-e2e'));
  });
});
