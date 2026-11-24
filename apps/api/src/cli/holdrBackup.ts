import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { ControlError, EXIT } from '../control/errors.js';
import { assertNoLeaseEnv } from '../control/lifecycle.js';
import { isCanonicalNativeAbsolute, repoPaths } from '../control/paths.js';
import { tokenFileFor } from '../control/startupGates.js';
import { withWriterLease } from '../control/writerDb.js';
import { readCurrentUserSid, readWindowsAcls, restrictToUser, takeOwnership } from '../e2e/windowsAcl.js';
import { controlContext, reportFailure, type Io } from './controlCommon.js';
import { ownerOnlyAcl } from './ownerOnlyOutput.js';

export const BACKUP_USAGE = `Usage: npm run holdr-backup [-- --tree <checkout>]

Writes a consistent copy of the data dir (HOLDR_DATA_DIR, or the configured one) to
<checkout>/backups/db/<UTC stamp>/ (the checkout running the command unless --tree names
another one, e.g. the live tree when run from staging): finance.db through VACUUM INTO (a
single self-contained file, taken under the lifecycle shared lease when a control dir is
configured), plus the other regular files of the data dir except its access tokens
(service-token, agent-token): the API makes new ones when they are missing, so a restore
never brings back a token you rotated. Then checks the copy with PRAGMA integrity_check.
The backup directories are private: 0700 on macOS and Linux; on Windows, an ACL for the
current user and SYSTEM only, owned by the current user.
`;

const stamp = (now: Date) => now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

/**
 * Whether a data-dir entry stays out of the copy of its other files: SQLite's own (finance.db goes through VACUUM INTO,
 * its -wal and -shm never), and the access tokens the API makes anew when they are missing: `service-token`,
 * `agent-token`, a temporary copy one left behind, and the service token wherever HOLDR_SERVICE_TOKEN_FILE puts it in the
 * data dir. A restore therefore never brings back a token the owner has rotated.
 */
function leftOut(name: string, dataDir: string, env: NodeJS.ProcessEnv): boolean {
  if (['finance.db', 'finance.db-wal', 'finance.db-shm'].includes(name) || name.toLowerCase().includes('-token')) return true;
  const tokenFile = tokenFileFor(env, dataDir);
  return path.relative(dataDir, path.dirname(tokenFile)) === '' && name === path.basename(tokenFile);
}

/** How a backup directory is made and checked on Windows; injected by tests. */
export interface WindowsPrivacy {
  currentUserSid(): string;
  restrict(dir: string, sid: string): void;
  isOwnerOnly(dir: string, sid: string): boolean;
}
const windowsPrivacy: WindowsPrivacy = {
  currentUserSid: () => readCurrentUserSid(),
  restrict: (dir, sid) => { restrictToUser(dir, sid); takeOwnership(dir, sid); },
  isOwnerOnly: (dir, sid) => ownerOnlyAcl(readWindowsAcls([dir])[0], sid),
};

/**
 * A private directory, created when absent: mode 0700 on POSIX; on Windows a new one gets an ACL for the current user and
 * SYSTEM only and the current user as owner. An existing one is never repaired, only checked (E0I_BACKUP_PERMS).
 */
export function privateDir(dir: string, platform: NodeJS.Platform = process.platform, windows: WindowsPrivacy = windowsPrivacy): void {
  const created = !fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) throw new ControlError('E0I_BACKUP_PERMS', 1, `${dir} must be a directory`);
  if (platform === 'win32') {
    let ownerOnly = false;
    try {
      const sid = windows.currentUserSid();
      if (created) windows.restrict(dir, sid);
      ownerOnly = windows.isOwnerOnly(dir, sid);
    } catch {
      ownerOnly = false;
    }
    if (!ownerOnly) {
      throw new ControlError('E0I_BACKUP_PERMS', 1, `${dir} must be owned by and open to the current user only (see docs/deployment.md)`);
    }
    return;
  }
  if ((stat.mode & 0o7777) !== 0o700) throw new ControlError('E0I_BACKUP_PERMS', 1, `${dir} must be a 0700 directory`);
}

/**
 * The database's part of a backup: `source` copied to `<dest>/finance.db` through VACUUM INTO from a read-only handle
 * (a single self-contained file; VACUUM INTO fails loudly where the online backup could copy nothing), made 0600, then
 * checked with PRAGMA integrity_check. Its own export, so that its content test runs on every platform: the command's
 * tests need POSIX modes.
 */
export function copyDatabase(source: string, dest: string): void {
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    db.prepare('VACUUM INTO ?').run(path.join(dest, 'finance.db'));
  } finally {
    db.close();
  }
  fs.chmodSync(path.join(dest, 'finance.db'), 0o600);
  const check = new Database(path.join(dest, 'finance.db'), { readonly: true, fileMustExist: true });
  try {
    const result = check.pragma('integrity_check', { simple: true });
    if (result !== 'ok') throw new ControlError('E0I_BACKUP_INTEGRITY', 1, `${dest}/finance.db failed integrity_check`);
  } finally {
    check.close();
  }
}

/**
 * `holdr-backup` (design §11.3 step 9, K19): replaces the body of `scripts/backup.sh`. The whole operation, every read of
 * the live data dir included, runs under the writer's shared lease (`withWriterLease`; B1 review 6), so a backup never
 * runs beside a maintenance holder; the database is opened read-only and nothing is migrated.
 */
export async function runHoldrBackup(argv: readonly string[], options: { env: NodeJS.ProcessEnv; io: Io; now?: () => Date; repoRoot?: string }): Promise<number> {
  const { io } = options;
  try {
    // The lease-variable contract (§9.3 rule 4): no ordinary CLI runs inside a maintenance lease.
    assertNoLeaseEnv(options.env);
    if (argv.includes('--help') || argv.includes('-h')) {
      io.stdout.write(BACKUP_USAGE);
      return 0;
    }
    let tree: string | undefined;
    if (argv.length === 2 && argv[0] === '--tree' && isCanonicalNativeAbsolute(argv[1]) && fs.statSync(argv[1], { throwIfNoEntry: false })?.isDirectory()) {
      tree = argv[1];
    } else if (argv.length) throw new ControlError('E0I_USAGE', EXIT.usage, `unexpected argument ${argv[0]}`);
    const context = controlContext(options.env);
    const dataDir = context.dataDir;
    const source = path.join(dataDir, 'finance.db');
    return await withWriterLease(context.env, () => {
      if (!fs.existsSync(dataDir)) {
        io.stdout.write(`No data directory at ${dataDir}; nothing to back up. If Holdr keeps its data in another folder, `
          + 'set HOLDR_DATA_DIR to that folder.\n');
        return 0;
      }
      const repo = repoPaths(tree ?? options.repoRoot);
      const dest = path.join(repo.backups, 'db', stamp((options.now ?? (() => new Date()))()));
      privateDir(repo.backups);
      privateDir(path.join(repo.backups, 'db'));
      fs.mkdirSync(dest, { mode: 0o700 });
      fs.chmodSync(dest, 0o700);
      const withDatabase = fs.existsSync(source);
      if (withDatabase) copyDatabase(source, dest);
      for (const name of fs.readdirSync(dataDir).sort()) {
        if (leftOut(name, dataDir, context.env)) continue;
        const file = path.join(dataDir, name);
        const stat = fs.lstatSync(file);
        if (!stat.isFile()) continue;
        fs.copyFileSync(file, path.join(dest, name), fs.constants.COPYFILE_EXCL);
        fs.chmodSync(path.join(dest, name), 0o600);
      }
      io.stdout.write(withDatabase
        ? `Backed up ${dataDir} -> ${dest} (integrity_check ok)\n`
        : `Backed up ${dataDir} -> ${dest}: it holds no finance.db, so only its other files were copied\n`);
      return 0;
    });
  } catch (error) {
    return reportFailure('holdr-backup', io, error);
  }
}
