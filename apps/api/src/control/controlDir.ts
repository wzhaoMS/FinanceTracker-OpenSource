import fs from 'node:fs';
import path from 'node:path';

import { fail } from './errors.js';
import { createPrivateFile, currentUid, fsyncDirectory } from './files.js';
import { formatHolders, openHolders } from './holders.js';
import {
  AUTHORIZATION_LOCK, LIFECYCLE_LOCK, LOCK_FILES, MARKER_FILE, RECOVERY_LOCK, lockPath, marker, readMarker, serializeMarker, tryRecoveryLock,
  withAuthorizationLock, writeMarker, type Lease,
} from './lifecycle.js';
import { disjoint, isCanonicalAbsolute, type RepoPaths } from './paths.js';
import type { Runner } from './runner.js';
import { FENCE_FILE, describeGate, fenceState, readFence, serializeFence, writeFence } from './syncAuthState.js';

/** §9.2: the control dir holds exactly these (plus transient `<name>.tmp.<pid>.<hex>` files of an atomic write). */
export const CONTROL_ENTRIES = [FENCE_FILE, MARKER_FILE, ...LOCK_FILES] as const;
export const defaultControlDir = (home: string) => path.join(home, 'Library/Application Support/Holdr/control');

/** HOLDR_CONTROL_DIR when set (canonical absolute, else E0I_CONTROL_DIR), else null: the protocol applies only when set. */
export function configuredControlDir(env: NodeJS.ProcessEnv): string | null {
  const value = env.HOLDR_CONTROL_DIR;
  if (value === undefined) return null;
  if (!isCanonicalAbsolute(value)) return fail('E0I_CONTROL_DIR', 'HOLDR_CONTROL_DIR is not an absolute path');
  return value;
}

/** For the recovery and lifecycle CLIs: the configured dir, else §9.2's default under HOME. */
export function controlDirFor(env: NodeJS.ProcessEnv): string {
  const configured = configuredControlDir(env);
  if (configured) return configured;
  if (!env.HOME || !isCanonicalAbsolute(env.HOME)) return fail('E0I_CONTROL_DIR_UNSET', 'HOLDR_CONTROL_DIR or HOME');
  return defaultControlDir(env.HOME);
}

/**
 * K20: a plain directory (no symlink), owned by this user, mode exactly 0700, `realpath` equal to the configured path,
 * disjoint from the data dir, the repo tree (except for disposable stacks, §7.2), the backups and the releases.
 */
export function checkControlDir(dir: string, options: { dataDir?: string; repo: RepoPaths; disposable?: boolean }): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return fail('E0I_CONTROL_DIR', `${dir} is missing (run holdr-recovery init)`);
  }
  if (!stat.isDirectory() || stat.uid !== currentUid() || (stat.mode & 0o7777) !== 0o700) {
    return fail('E0I_CONTROL_DIR', `${dir} must be a 0700 directory owned by this user`);
  }
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return fail('E0I_CONTROL_DIR', dir);
  }
  if (real !== dir) return fail('E0I_CONTROL_DIR', `${dir} is reached through a symlink`);
  const others: Array<[string, string | undefined]> = [
    ['data dir', options.dataDir], ['backups', options.repo.backups], ['releases', options.repo.releasesRoot],
    ['repo tree', options.disposable ? undefined : options.repo.root],
  ];
  for (const [name, other] of others) {
    if (other && !disjoint(dir, other)) return fail('E0I_CONTROL_DIR', `${dir} overlaps the ${name}`);
  }
}

/**
 * `holdr-recovery init`: creates the control dir (0700), `blocked/init` for this machine, `lifecycle-state` `normal` and the
 * three lock files; refuses if the dir exists. Missing parents are created 0700. Then the Time Machine exclusion
 * (`tmutil addexclusion`, sticky, no root): a mitigation only (§9.2), so a failure is reported, not fatal.
 */
export async function initControlDir(dir: string, options: { machine: string; run: Runner; repo: RepoPaths; dataDir?: string }) {
  if (!isCanonicalAbsolute(dir)) fail('E0I_CONTROL_DIR', dir);
  try {
    fs.lstatSync(dir);
    return fail('E0I_CONTROL_DIR', `${dir} already exists; after a restore, a migration or an interrupted init use holdr-recovery reinit (it rebuilds a partial control dir)`);
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
  const parent = path.dirname(dir);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  checkControlDir(dir, { repo: options.repo, dataDir: options.dataDir });
  for (const name of LOCK_FILES) createPrivateFile(path.join(dir, name));
  createPrivateFile(path.join(dir, MARKER_FILE), serializeMarker(marker({ state: 'normal' }, 'holdr-recovery init')));
  createPrivateFile(path.join(dir, FENCE_FILE), serializeFence(fenceState({
    gate: 'blocked', reason: 'init', generation: null, next: null, op: null, machine: options.machine,
  })));
  fsyncDirectory(dir);
  fsyncDirectory(parent);
  const excluded = await addTimeMachineExclusion(options.run, dir);
  return { excluded };
}

/** A transient file of an atomic write (`<entry>.tmp.<pid>.<16 hex>`), left behind only by a crash. */
const TRANSIENT = new RegExp(`^(${CONTROL_ENTRIES.map((name) => name.replace('.', '\\.')).join('|')})\\.tmp\\.[0-9]+\\.[0-9a-f]{16}$`);

/** What `reinit` finds (B1 review 5): `complete`, `absent`, `partial` (some of the five entries missing), or `unsafe`. */
export type ControlShape =
  | { readonly kind: 'complete' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'partial'; readonly missing: readonly string[] }
  | { readonly kind: 'unsafe'; readonly detail: string };

export function controlShape(dir: string, options: { dataDir?: string; repo: RepoPaths }): ControlShape {
  try {
    fs.lstatSync(dir);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'unsafe', detail: `${dir} cannot be inspected` };
  }
  try {
    checkControlDir(dir, options);
  } catch (error) {
    return { kind: 'unsafe', detail: (error as { detail?: string }).detail ?? `${dir} fails K20` };
  }
  const unexpected = fs.readdirSync(dir).filter((name) => !(CONTROL_ENTRIES as readonly string[]).includes(name) && !TRANSIENT.test(name));
  if (unexpected.length) return { kind: 'unsafe', detail: `unexpected entries in ${dir}: ${unexpected.sort().join(', ')}` };
  const missing: string[] = [];
  for (const name of CONTROL_ENTRIES) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(path.join(dir, name));
    } catch {
      missing.push(name);
      continue;
    }
    if (!stat.isFile() || stat.uid !== currentUid() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1) {
      return { kind: 'unsafe', detail: `${name} is not a private regular file of this user` };
    }
  }
  return missing.length ? { kind: 'partial', missing } : { kind: 'complete' };
}

/** Where a bootstrap stands, for tests that inspect the control dir at each point (B1 round-2 finding 1). */
export type BootstrapStep = 'serialized' | 'quarantined' | 'repaired';

/**
 * `reinit`'s bootstrap of an absent or partial control dir (B1 review 5; B1 round-2 finding 1), run only after the caller
 * refused lease variables and proved that Holdr is stopped and no process holds a control file or the database. Nothing that
 * exists is ever replaced as a file, so no lock identity anyone could hold changes, and nothing it leaves behind, interrupted
 * at any point, lets Holdr start or admit:
 * 1. serialization: the dir (0700; missing parents 0700) when absent, then `recovery.lock` when missing (it gates neither a
 *    start nor an admission), taken without waiting (`E0I_RECOVERY_BUSY`, 75) and returned held, for `enterRecovery`;
 * 2. quarantine, durable before any repair: the marker `maintenance (reinit)` and the fence `blocked/reinit` for this machine
 *    (under `authorization.lock` where that exists), each created or atomically rewritten, whatever they said (an open fence
 *    is never kept: an old authorization is never needed or restored), then fsync;
 * 3. repair: the missing `lifecycle.lock` and `authorization.lock`, created exclusively and empty (one that appears meanwhile
 *    stops the bootstrap), then fsync.
 * The Time Machine exclusion is the caller's, once `enterRecovery` holds the quarantine.
 */
export async function bootstrapControlDir(dir: string, options: {
  machine: string; repo: RepoPaths; dataDir?: string; observe?: (step: BootstrapStep) => void;
}): Promise<{ created: string[]; recoveryLock: Lease }> {
  if (!isCanonicalAbsolute(dir)) fail('E0I_CONTROL_DIR', dir);
  const shape = controlShape(dir, { repo: options.repo, dataDir: options.dataDir });
  if (shape.kind === 'unsafe') return fail('E0I_CONTROL_DIR', `${shape.detail}; reinit never replaces an unsafe entry`);
  if (shape.kind === 'complete') return fail('E0I_INTERNAL', 'the control dir is complete; nothing to rebuild');
  const parent = path.dirname(dir);
  if (shape.kind === 'absent') {
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as { code?: string }).code === 'EEXIST') fail('E0I_RECOVERY_BUSY', `${dir} appeared while reinit was rebuilding it`, 75);
      throw error;
    }
    fs.chmodSync(dir, 0o700);
    checkControlDir(dir, { repo: options.repo, dataDir: options.dataDir });
  }
  const missing = shape.kind === 'absent' ? [...CONTROL_ENTRIES] : [...shape.missing];
  const created: string[] = [];
  const create = (name: string, data = '') => {
    try {
      createPrivateFile(path.join(dir, name), data);
    } catch (error) {
      if ((error as { code?: string }).code === 'EEXIST') fail('E0I_RECOVERY_BUSY', `${name} appeared while reinit was rebuilding the control dir`, 75);
      throw error;
    }
    created.push(name);
  };
  if (missing.includes(RECOVERY_LOCK)) create(RECOVERY_LOCK);
  const recoveryLock = tryRecoveryLock(dir);
  try {
    options.observe?.('serialized');
    const quarantine = () => {
      writeFence(dir, fenceState({ gate: 'blocked', reason: 'reinit', generation: null, next: null, op: null, machine: options.machine }));
    };
    if (missing.includes(AUTHORIZATION_LOCK)) quarantine();
    else await withAuthorizationLock(dir, quarantine);
    if (missing.includes(FENCE_FILE)) created.push(FENCE_FILE);
    writeMarker(dir, marker({ state: 'maintenance', reason: 'reinit' }, 'holdr-recovery reinit'));
    if (missing.includes(MARKER_FILE)) created.push(MARKER_FILE);
    fsyncDirectory(dir);
    options.observe?.('quarantined');
    for (const name of [LIFECYCLE_LOCK, AUTHORIZATION_LOCK] as const) if (missing.includes(name)) create(name);
    fsyncDirectory(dir);
    fsyncDirectory(parent);
    options.observe?.('repaired');
    return { created, recoveryLock };
  } catch (error) {
    recoveryLock.release();
    throw error;
  }
}

export async function addTimeMachineExclusion(run: Runner, dir: string): Promise<boolean> {
  const added = await run('/usr/bin/tmutil', ['addexclusion', dir]);
  return added.exitCode === 0 && await timeMachineExcluded(run, dir) === true;
}

export async function timeMachineExcluded(run: Runner, dir: string): Promise<boolean | null> {
  const result = await run('/usr/bin/tmutil', ['isexcluded', dir]);
  if (result.exitCode !== 0) return null;
  if (/^\[Excluded\]/m.test(result.stdout)) return true;
  if (/^\[Included\]/m.test(result.stdout)) return false;
  return null;
}

export interface ControlStatus {
  readonly controlDir: string;
  readonly gate: string;
  readonly generation: string | null;
  readonly machineMatches: boolean | null;
  readonly entries: Readonly<Record<string, string>>;
  readonly unexpected: readonly string[];
  readonly timeMachineExcluded: boolean | null;
  readonly marker: string;
  readonly holders: Readonly<Record<string, string>>;
}

/** The file part of `status` (§9.6, §9.3 `status` row): lock-free, never opens SQLite. */
export async function controlStatus(dir: string, options: { machine: string | null; run: Runner }): Promise<ControlStatus> {
  const entries: Record<string, string> = {};
  let unexpected: string[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    names = [];
  }
  for (const name of CONTROL_ENTRIES) {
    try {
      const stat = fs.lstatSync(path.join(dir, name));
      const ok = stat.isFile() && stat.uid === currentUid() && (stat.mode & 0o7777) === 0o600 && stat.nlink === 1;
      entries[name] = ok ? 'ok' : `unsafe (${stat.isFile() ? (stat.mode & 0o7777).toString(8) : 'not a regular file'})`;
    } catch {
      entries[name] = 'missing';
    }
  }
  unexpected = names.filter((name) => !(CONTROL_ENTRIES as readonly string[]).includes(name)).sort();
  let gate = 'unreadable';
  let generation: string | null = null;
  let machineMatches: boolean | null = null;
  try {
    const read = readFence(dir, options.machine);
    gate = describeGate(read);
    const state = read.state;
    generation = state?.generation ? `${state.generation.slice(0, 8)}…` : null;
    machineMatches = state ? options.machine !== null && state.machine === options.machine : null;
  } catch {
    gate = 'unsafe file (E0I_FENCE_FILE)';
  }
  const current = readMarker(dir);
  const holders: Record<string, string> = {};
  for (const name of LOCK_FILES) {
    const file = lockPath(dir, name);
    if (!fs.existsSync(file)) continue;
    const list = await openHolders(options.run, [file]);
    holders[name] = list === null ? 'unknown' : formatHolders(list);
  }
  return Object.freeze({
    controlDir: dir, gate, generation, machineMatches, entries: Object.freeze(entries), unexpected: Object.freeze(unexpected),
    timeMachineExcluded: fs.existsSync(dir) ? await timeMachineExcluded(options.run, dir) : null,
    marker: current ? `${current.state}${current.reason ? ` (${current.reason})` : ''}${current.lease ? ' with lease' : ''}` : 'missing or invalid',
    holders: Object.freeze(holders),
  });
}

export function formatControlStatus(status: ControlStatus): string {
  return [
    `control dir: ${status.controlDir}`,
    `device gate: ${status.gate}`,
    `generation: ${status.generation ?? 'none'}`,
    `machine: ${status.machineMatches === null ? 'unknown' : status.machineMatches ? 'matches' : 'DIFFERENT (machine-changed)'}`,
    `files: ${Object.entries(status.entries).map(([name, state]) => `${name} ${state}`).join(', ')}`,
    ...(status.unexpected.length ? [`unexpected entries: ${status.unexpected.join(', ')}`] : []),
    `time machine: ${status.timeMachineExcluded === null ? 'unknown' : status.timeMachineExcluded ? 'excluded' : 'NOT excluded'}`,
    `lifecycle: ${status.marker}`,
    `lock holders: ${Object.entries(status.holders).map(([name, list]) => `${name} ${list}`).join('; ') || 'none'}`,
    'db: not available before E1b v15 (no DB part yet)',
  ].join('\n') + '\n';
}

