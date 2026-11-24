import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { SERVICE_TOKEN_FILE_NAME } from '../auth/serviceToken.js';
import { checkControlDir } from './controlDir.js';
import { fail } from './errors.js';
import { currentUid } from './files.js';
import { contains, disjoint, repoPaths, type RepoPaths } from './paths.js';
import { readFence, type FenceRead } from './syncAuthState.js';

/**
 * The data, backup, control-dir, fence-file and token gates K17–K23 (design §7.2) that B runs before any database is
 * opened. Messages name the setting or local path, never data. Disposable stacks (`HOLDR_E2E_RUN_ID`) skip K19 and K20's
 * repo-tree disjointness, because their run directory lives under `<repo>/.e2e-tmp` (§7.2).
 */
export interface GateInput {
  readonly dataDir: string;
  readonly controlDir: string;
  readonly releaseDir?: string;
  readonly tokenFile?: string;
  readonly disposable?: boolean;
  readonly repo?: RepoPaths;
}

const real = (file: string): string => {
  try { return fs.realpathSync(file); } catch { return file; }
};

/** K17: the data dir is disjoint from every code, release and control location (configured and physical paths). */
export function checkDataOverlap(input: GateInput): void {
  const repo = input.repo ?? repoPaths();
  const others: Array<[string, string | undefined]> = [
    ['release dir', input.releaseDir], ['releases root', repo.releasesRoot], ['apps/web', repo.web],
    ['packages/shared', repo.shared], ['node_modules', repo.nodeModules], ['control dir', input.controlDir],
  ];
  for (const [name, other] of others) {
    if (!other) continue;
    for (const [a, b] of [[input.dataDir, other], [real(input.dataDir), real(other)]]) {
      if (!disjoint(a, b)) fail('E0I_DATA_OVERLAP', `HOLDR_DATA_DIR overlaps the ${name}`);
    }
  }
}

/**
 * The repair index.ts has always made (index.ts:122-132 at 8b7a9ca): the data dir and the three database files lose any
 * group/world bits. It only ever tightens permissions and runs before K18 judges the directory.
 */
export function repairMainDataFiles(dataDir: string, log: (line: string) => void = () => {}): void {
  const db = path.join(dataDir, 'finance.db');
  for (const file of [dataDir, db, `${db}-wal`, `${db}-shm`]) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink() || stat.uid !== currentUid()) continue;
    if (stat.mode & 0o077) {
      fs.chmodSync(file, stat.isDirectory() ? 0o700 : 0o600);
      log(`[auth] restricted ${file} to its owner (was ${(stat.mode & 0o777).toString(8)})`);
    }
  }
}

function walk(root: string, maxDepth: number, visit: (file: string, stat: fs.Stats, depth: number) => void): void {
  const queue: Array<[string, number]> = [[root, 0]];
  while (queue.length) {
    const [dir, depth] = queue.shift()!;
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return fail('E0I_DATA_PERMS', dir);
    }
    for (const name of names.sort()) {
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file);
      visit(file, stat, depth + 1);
      if (stat.isDirectory() && depth + 1 < maxDepth) queue.push([file, depth + 1]);
    }
  }
}

/**
 * K18: the data dir exists (B-D5: a release mode never creates an empty production database), is a plain directory owned by
 * this user with no group/world bits, and every entry to depth 4 is an owned regular file or directory without group/world
 * bits and without symlinks.
 */
export function checkDataPerms(dataDir: string, options: { tolerateMainFiles?: boolean } = {}): string[] {
  // The read-only preflight tolerates loose bits on the four files the API itself restricts at start (and reports them).
  const db = path.join(dataDir, 'finance.db');
  const repairable = new Set(options.tolerateMainFiles ? [dataDir, db, `${db}-wal`, `${db}-shm`] : []);
  const wouldRestrict: string[] = [];
  const loose = (file: string, mode: number) => {
    if ((mode & 0o077) === 0) return false;
    if (repairable.has(file)) { wouldRestrict.push(file); return false; }
    return true;
  };
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dataDir);
  } catch {
    return fail('E0I_DATA_PERMS', `${dataDir} is missing`);
  }
  if (!stat.isDirectory() || stat.uid !== currentUid() || loose(dataDir, stat.mode)) {
    return fail('E0I_DATA_PERMS', `${dataDir} must be a private directory owned by this user`);
  }
  if (real(dataDir) !== dataDir) fail('E0I_DATA_PERMS', `${dataDir} is reached through a symlink`);
  walk(dataDir, 4, (file, entry) => {
    if ((!entry.isFile() && !entry.isDirectory()) || entry.uid !== currentUid() || loose(file, entry.mode)) {
      fail('E0I_DATA_PERMS', `${file} must be a private regular file or directory owned by this user`);
    }
  });
  return wouldRestrict;
}

/** K19: `<repo>/backups`, if present: 0700 directories, 0600 regular files, no symlinks, one link each. */
export function checkBackupPerms(repo: RepoPaths = repoPaths()): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(repo.backups);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    return fail('E0I_BACKUP_PERMS', repo.backups);
  }
  const ok = (entry: fs.Stats) => entry.uid === currentUid() && ((entry.isDirectory() && (entry.mode & 0o7777) === 0o700)
    || (entry.isFile() && (entry.mode & 0o7777) === 0o600 && entry.nlink === 1));
  if (!stat.isDirectory() || !ok(stat)) fail('E0I_BACKUP_PERMS', `${repo.backups} must be a 0700 directory`);
  walk(repo.backups, 8, (file, entry) => {
    if (!ok(entry)) fail('E0I_BACKUP_PERMS', `${file} must be a 0700 directory or a 0600 regular file with one link`);
  });
}

/** K22: the service token never lives in the release dir, the releases root, apps/web or the control dir. */
export function checkTokenLocation(input: GateInput & { tokenFile: string }): void {
  const repo = input.repo ?? repoPaths();
  const dir = path.dirname(input.tokenFile);
  for (const [name, outer] of [['release dir', input.releaseDir], ['releases root', repo.releasesRoot], ['apps/web', repo.web],
    ['control dir', input.controlDir]] as const) {
    if (!outer) continue;
    if (contains(outer, input.tokenFile) || contains(real(outer), path.join(real(dir), path.basename(input.tokenFile)))) {
      fail('E0I_TOKEN_LOCATION', `the service-token file is inside the ${name}`);
    }
  }
}

export function tokenFileFor(env: NodeJS.ProcessEnv, dataDir: string): string {
  const setting = env.HOLDR_SERVICE_TOKEN_FILE?.trim();
  return setting ? path.resolve(setting) : path.join(dataDir, SERVICE_TOKEN_FILE_NAME);
}

/**
 * K17–K22 in order, for the API (dist and local) and the preflight, before any database is opened. Returns the fence
 * read for the device-gate log line of §9.5 (content problems never stop Holdr).
 */
export function runDataAndControlGates(input: GateInput & { tokenFile: string; machine: string | null; log?: (line: string) => void }): FenceRead {
  const repo = input.repo ?? repoPaths();
  checkDataOverlap({ ...input, repo });
  repairMainDataFiles(input.dataDir, input.log);
  checkDataPerms(input.dataDir);
  if (!input.disposable) checkBackupPerms(repo);
  checkControlDir(input.controlDir, { dataDir: input.dataDir, repo, disposable: input.disposable });
  const fence = readFence(input.controlDir, input.machine);
  checkTokenLocation({ ...input, repo });
  return fence;
}

/**
 * K23 (preflight only): at least one local user, read with `{ readonly: true, fileMustExist: true }` and `PRAGMA query_only`,
 * no migration. A failing read-only open is a warning, not a refusal (e.g. WAL files that cannot be opened read-only).
 */
export function checkUsers(dbFile: string): { users: number } | { warning: string } {
  let db: Database.Database | undefined;
  // No database file at all certainly means no users; only a failing open of an existing file is a warning.
  if (!fs.existsSync(dbFile)) return fail('E0I_NO_USERS', `no database at ${dbFile} yet (npm run holdr-user -- add <username>)`);
  try {
    db = new Database(dbFile, { readonly: true, fileMustExist: true });
    db.pragma('query_only = 1');
    const row = db.prepare('SELECT COUNT(*) AS n FROM local_users').get() as { n: number };
    if (row.n < 1) return fail('E0I_NO_USERS', `${dbFile} has no local users (npm run holdr-user -- add <username>)`);
    return { users: row.n };
  } catch (error) {
    if ((error as { code?: string }).code === 'E0I_NO_USERS') throw error;
    // A database without the accounts table certainly has no users; anything else is a read-only open problem.
    if (/no such table: local_users/.test((error as Error).message ?? '')) {
      return fail('E0I_NO_USERS', `${dbFile} has no local users (npm run holdr-user -- add <username>)`);
    }
    return { warning: `K23 read-only check could not run (${(error as { code?: string }).code ?? 'error'})` };
  } finally {
    db?.close();
  }
}
