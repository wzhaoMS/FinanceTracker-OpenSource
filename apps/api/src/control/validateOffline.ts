import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { verifyRelease } from '@finance-tracker/shared/web-release/files';

import { CURRENT_USER_VERSION } from '../services/sqliteStateRepo.js';
import { checkControlDir } from './controlDir.js';
import { defaultConfPath } from './holdrConf.js';
import { ControlError } from './errors.js';
import { computeMachineId } from './machineId.js';
import { repoPaths } from './paths.js';
import { retiredFiles, retiredPresent } from './retiredFiles.js';
import type { Runner } from './runner.js';
import { checkBackupPerms, checkDataOverlap, checkDataPerms, checkTokenLocation, tokenFileFor } from './startupGates.js';
import { describeGate, readFence } from './syncAuthState.js';

/**
 * Offline validation (design §9.3 maintenance step 5, §9.6), run only inside a proven lease. Read-only: the release,
 * the data, backup and control dirs (K17–K22, without the K18 repair), DB integrity, foreign keys and `user_version`, the
 * fence's metadata and machine. Generation agreement needs E1b v15 and is reported as not yet applicable.
 */
export async function validateOffline(options: {
  env: Readonly<NodeJS.ProcessEnv>; controlDir: string; dataDir: string; run: Runner;
  /** A revert judges the restored tree (`--target-root`), not the validator's own tree (the kit). */
  repoRoot?: string;
  /** A revert checks the target configuration's release in the restored tree; null: none (a login-era target). */
  release?: { dir: string; digest: string } | null;
}): Promise<string[]> {
  const { env, controlDir, dataDir } = options;
  const lines: string[] = [];
  const failures: string[] = [];
  const step = (name: string, check: () => string | void) => {
    try {
      const detail = check();
      lines.push(`ok   ${name}${detail ? `: ${detail}` : ''}`);
    } catch (error) {
      const coded = error as { code?: string; detail?: string };
      failures.push(name);
      lines.push(`FAIL ${name}: ${coded.code ?? 'error'}${coded.detail ? ` (${coded.detail})` : ''}`);
    }
  };
  const repo = repoPaths(options.repoRoot);
  const mode = env.HOLDR_WEB_MODE ?? 'vite';
  const releaseDir = options.release !== undefined ? options.release?.dir : env.HOLDR_WEB_RELEASE_DIR;
  const digest = options.release !== undefined ? options.release?.digest : env.HOLDR_WEB_RELEASE_DIGEST;
  const disposable = Boolean(env.HOLDR_E2E_RUN_ID?.trim());
  if (options.release !== undefined ? options.release !== null : mode === 'dist' || mode === 'local') {
    step('release', () => {
      if (!releaseDir || !digest) throw new ControlError('E0I_RELEASE_CONFIG', 1, 'release dir and digest');
      const release = verifyRelease(releaseDir, digest);
      return `${release.digest.slice(0, 12)}, ${release.manifest.files.length} files`;
    });
  } else if (options.release === null) {
    lines.push('n/a  release (the target configuration names none)');
  }
  // Managed retirement (B-D24 as revised): the tree must not contain a file its own code retires (scripts/retired-files.txt).
  step('retired files', () => {
    const present = retiredPresent(repo.root);
    if (present.length) throw new ControlError('E0I_RETIRED_PRESENT', 1, present.join(', '));
    const listed = retiredFiles(repo.root).length;
    return listed ? `${listed} retired, none present` : 'none listed';
  });
  step('K17 data dir disjoint', () => checkDataOverlap({ dataDir, controlDir, releaseDir, repo }));
  step('K18 data dir private', () => { checkDataPerms(dataDir); });
  if (!disposable) step('K19 backups private', () => checkBackupPerms(repo));
  step('K20 control dir', () => checkControlDir(controlDir, { dataDir, repo, disposable }));
  step('K22 token location', () => checkTokenLocation({ dataDir, controlDir, releaseDir, repo, tokenFile: tokenFileFor(env, dataDir) }));
  let machine: string | null = null;
  try {
    machine = await computeMachineId(options.run, dataDir);
  } catch {
    machine = null;
  }
  step('K21 fence', () => describeGate(readFence(controlDir, machine)));
  const dbFile = path.join(dataDir, 'finance.db');
  if (fs.existsSync(dbFile)) {
    step('database', () => {
      const db = new Database(dbFile, { readonly: true, fileMustExist: true });
      try {
        db.pragma('query_only = 1');
        const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
        if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new ControlError('E0I_DB_INTEGRITY', 1, 'integrity_check');
        if ((db.pragma('foreign_key_check') as unknown[]).length) throw new ControlError('E0I_DB_INTEGRITY', 1, 'foreign_key_check');
        const version = db.pragma('user_version', { simple: true }) as number;
        if (!Number.isSafeInteger(version) || version > CURRENT_USER_VERSION) {
          throw new ControlError('E0I_DB_VERSION', 1, `user_version above ${CURRENT_USER_VERSION}`);
        }
        return `integrity ok, user_version ${version}`;
      } finally {
        db.close();
      }
    });
  } else {
    lines.push('ok   database: none yet');
  }
  lines.push('n/a  generation agreement (needs E1b v15)');
  if (failures.length) throw Object.assign(new ControlError('E0I_VALIDATION', 1, failures.join(', ')), { lines });
  return lines;
}

/**
 * The revert's extra checks (design §11.5): with both configurations named separately, the live configuration path holds
 * exactly the target configuration (byte-equal, 0600, owned, one link) or nothing (`none`); `T` equals the code snapshot
 * (`rsync` dry run with checksums, the snapshot's excludes) and `~/bin/start-finance-mac.sh` its snapshot copy (or is absent
 * when the snapshot has none). `KC`, the operation's configuration, only located the lease and the dirs.
 */
export async function validateRevert(options: {
  snap: string; targetRoot: string; targetConfig: string; home: string; run: Runner;
}): Promise<string[]> {
  const { snap, targetRoot, targetConfig, home } = options;
  const lines: string[] = [];
  const failures: string[] = [];
  const result = (name: string, ok: boolean, detail: string) => {
    lines.push(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
    if (!ok) failures.push(name);
  };
  const live = defaultConfPath(home);
  if (targetConfig === 'none') {
    result('target configuration', !fs.existsSync(live) && fs.existsSync(path.join(snap, 'holdr.conf.absent')), `${live} absent`);
  } else {
    let same = false;
    try {
      const stat = fs.lstatSync(live);
      same = path.dirname(targetConfig) === snap && stat.isFile() && (stat.mode & 0o7777) === 0o600 && stat.nlink === 1
        && stat.uid === process.getuid?.() && fs.readFileSync(live).equals(fs.readFileSync(targetConfig));
    } catch { same = false; }
    result('target configuration', same, `${live} equals ${targetConfig}`);
  }
  const rsync = await options.run('/usr/bin/rsync', ['-anc', '--delete', '--itemize-changes', '--exclude', '/apps/api/data/',
    '--exclude', '/backups/', `${path.join(snap, 'FinanceTracker')}/`, `${targetRoot}/`]);
  result('tree', rsync.exitCode === 0 && rsync.stdout.trim() === '', `${targetRoot} equals the snapshot`);
  const script = path.join(home, 'bin', 'start-finance-mac.sh');
  const saved = path.join(snap, 'start-finance-mac.sh');
  let scriptOk = false;
  try {
    scriptOk = fs.existsSync(saved) ? fs.readFileSync(script).equals(fs.readFileSync(saved)) : !fs.existsSync(script);
  } catch { scriptOk = false; }
  result('start script', scriptOk, `${script} equals the snapshot's`);
  if (failures.length) throw Object.assign(new ControlError('E0I_VALIDATION', 1, failures.join(', ')), { lines });
  return lines;
}
