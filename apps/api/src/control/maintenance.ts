import { spawn, type ChildProcess, type StdioNull, type StdioPipe } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { EXIT, fail } from './errors.js';
import { randomHex16 } from './files.js';
import { formatHolders, openHolders } from './holders.js';
import {
  LEASE_FD_VAR, LEASE_VAR, LIFECYCLE_LOCK, acquireExclusiveLease, leaseStillOn, lockPath, marker, readMarker, writeMarker, type Lease,
} from './lifecycle.js';
import type { LeaveTarget } from './leaveTarget.js';
import { managedLive, repoPaths } from './paths.js';
import type { Runner } from './runner.js';

/**
 * The maintenance holder's side of §9.3: the process that takes `lifecycle.lock` exclusively (`holdr-lifecycle exclusive`,
 * `holdr-recovery reinit`, E2's recovery commands) and hands the descriptor to its work as fd 3. Not a lease-accepting role.
 */
export interface HeldLease {
  readonly lease: Lease;
  readonly nonce: string;
}

/**
 * `exclusive` requires the marker `maintenance`, acquires `lifecycle.lock` exclusively within `timeoutMs` (on timeout it
 * reports the holders and exits 75 without changing anything; holders are never killed) and then writes a fresh lease
 * nonce into the marker.
 */
export async function holdExclusive(controlDir: string, options: { timeoutMs: number; run: Runner; owner: string; log: (line: string) => void }): Promise<HeldLease> {
  const before = readMarker(controlDir);
  if (!before || before.state !== 'maintenance') {
    return fail('E0I_LIFECYCLE_STATE', 'exclusive needs the marker maintenance (holdr-lifecycle enter --reason <r>)');
  }
  const lease = await acquireExclusiveLease(controlDir, options.timeoutMs);
  if (!lease) {
    const holders = await openHolders(options.run, [lockPath(controlDir, LIFECYCLE_LOCK)]);
    options.log(`lifecycle.lock holders: ${holders === null ? 'unknown' : formatHolders(holders)}`);
    return fail('E0I_LIFECYCLE_BUSY', `lifecycle.lock still held after ${options.timeoutMs} ms; nothing changed`, EXIT.busy);
  }
  try {
    const current = readMarker(controlDir);
    if (!current || current.state !== 'maintenance') fail('E0I_LIFECYCLE_STATE', 'the marker left maintenance while waiting');
    const nonce = randomHex16();
    writeMarker(controlDir, marker({ state: 'maintenance', reason: current.reason!, lease: nonce }, options.owner));
    return { lease, nonce };
  } catch (error) {
    lease.release();
    throw error;
  }
}

/** Best-effort guard for processes outside the protocol (§9.3 step 4): a snapshot, stated as such. */
export async function dbInUseGuard(run: Runner, dataDir: string): Promise<void> {
  const db = path.join(dataDir, 'finance.db');
  const files = [db, `${db}-wal`, `${db}-shm`].filter((file) => fs.existsSync(file));
  const holders = await openHolders(run, files);
  if (holders === null) fail('E0I_DB_IN_USE', 'lsof failed; cannot show that finance.db is unused');
  if (holders.length) fail('E0I_DB_IN_USE', `finance.db is open in: ${formatHolders(holders)}`);
}

type Stdio = StdioNull | StdioPipe;

/** Starts `file` with the held lease as its fd 3 (`HOLDR_LIFECYCLE_LEASE_FD=3` and the nonce); bash keeps it for its tools. */
export function spawnUnderLease(held: HeldLease, file: string, args: readonly string[], options: {
  env: NodeJS.ProcessEnv; cwd?: string; stdio?: readonly [Stdio, Stdio, Stdio];
}): ChildProcess {
  const [stdin, stdout, stderr] = options.stdio ?? ['inherit', 'inherit', 'inherit'];
  return spawn(file, [...args], {
    cwd: options.cwd,
    env: { ...options.env, [LEASE_FD_VAR]: '3', [LEASE_VAR]: held.nonce },
    stdio: [stdin, stdout, stderr, held.lease.fd],
    shell: false,
  });
}

export function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.once('error', () => resolve(127));
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

/**
 * Maintenance step 2 for the recovery commands (§9.3): this tree's stop role (`scripts/holdr-stop.sh`, ownership checks and
 * the TCP-owner guard; it works in maintenance), always aimed at the managed live deployment (`managedLive`: `HOLDR_ROOT`, or
 * `~/Holdr`), never at the tree this code runs from: from a staging tree or a rollback kit it stops the
 * live Holdr, exactly as `"$K/scripts/holdr-stop.sh" --root "$HOME/Holdr"` does (B1 round-3 finding 2).
 * A HOLDR_ROOT naming a staging tree, a kit or nothing refuses (`E0I_NOT_LIVE`) before anything is stopped. Only without any
 * managed live tree (a development checkout) is the step skipped; the drain and the database guard then decide.
 */
export async function runStopRole(env: NodeJS.ProcessEnv, configPath: string | null, log: (line: string) => void, root = repoPaths().root): Promise<number> {
  const live = managedLive(env);
  if (!live) {
    log('holdr-stop skipped: no managed live tree (HOLDR_ROOT/FinanceTracker or ~/Holdr/FinanceTracker); the drain below waits for every holder');
    return 0;
  }
  log(`holdr-stop --root ${live.base}: the managed live deployment (${live.tree})`);
  const child = spawn('/bin/bash', [path.join(root, 'scripts/holdr-stop.sh'), '--root', live.base], {
    env: { ...env, ...(configPath ? { HOLDR_CONFIG: configPath } : {}) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  return waitForExit(child);
}

/**
 * The `validate-offline` role under the held lease, exactly as `scripts/holdr-leased.sh` starts it (one Node process with the
 * tsx loader in-process, so the role itself holds fd 3 and proves it), on this holder's own Node binary: no Node path is ever
 * taken from the environment (B-D32).
 */
export async function runValidateOffline(held: HeldLease, env: NodeJS.ProcessEnv, extra: readonly string[] = [], root = repoPaths().root): Promise<number> {
  const child = spawnUnderLease(held, process.execPath, [
    '--import', path.join(root, 'node_modules/tsx/dist/loader.mjs'), path.join(root, 'apps/api/src/cli/leasedMain.ts'), 'validate-offline', ...extra,
  ], { env });
  return waitForExit(child);
}

/**
 * The validation a leave runs for its target (`leaveTarget`, B-D36): the live tree validates itself with its own code and the
 * live configuration; every other target runs this tree's role with the target options.
 */
export async function validateLeaveTarget(held: HeldLease, env: NodeJS.ProcessEnv, target: LeaveTarget, root = repoPaths().root): Promise<number> {
  if (target.kind === 'live') return runValidateOffline(held, { ...env, HOLDR_CONFIG: target.config }, [], target.root);
  return runValidateOffline(held, env, target.args, root);
}

/**
 * This holder's lease is still the exclusive lock on the control dir's current `lifecycle.lock` (`leaseStillOn`), and the
 * marker still names it (B1 round-2 finding 4: a valid lease identity before every holder check).
 */
function assertLeaseIdentity(controlDir: string, held: HeldLease): void {
  if (!leaseStillOn(held.lease, controlDir)) fail('E0I_LIFECYCLE_STATE', 'this holder\'s lease is no longer the lock on lifecycle.lock; marker left in maintenance');
  const current = readMarker(controlDir);
  if (!current || current.state !== 'maintenance' || current.lease !== held.nonce) {
    fail('E0I_LIFECYCLE_STATE', 'the marker does not name this lease; left unchanged');
  }
}

/** The other holders of `lifecycle.lock`, from an lsof answer that lists this holder itself (B1 round-2 finding 4). */
async function otherLeaseHolders(controlDir: string, run: Runner, what: string) {
  const holders = await openHolders(run, [lockPath(controlDir, LIFECYCLE_LOCK)], { self: true });
  if (holders === null) {
    fail('E0I_LIFECYCLE_BUSY', `lsof gave no complete answer that lists this holder; cannot show that ${what}; marker left in maintenance`, EXIT.busy);
  }
  return holders.filter((holder) => holder.pid !== process.pid);
}

/**
 * Before validating (B1 review 3): waits until no process other than this holder has `lifecycle.lock` open. Work a command
 * left behind with the lease shares this lease's open file description, so it never blocks the holder; it must finish before
 * validation, or its later changes would go unvalidated. Each check needs this holder's lease identity and an lsof answer that
 * lists this holder (an empty or unreadable one proves nothing); otherwise, and on the timeout, maintenance is kept.
 */
export async function drainLeaseHolders(controlDir: string, held: HeldLease, options: { run: Runner; timeoutMs: number; log: (line: string) => void }): Promise<void> {
  const deadline = performance.now() + options.timeoutMs;
  let reported = false;
  for (;;) {
    assertLeaseIdentity(controlDir, held);
    const others = await otherLeaseHolders(controlDir, options.run, 'the work has finished');
    if (others.length === 0) return;
    if (!reported) {
      options.log(`waiting for the work's remaining lease holders: ${formatHolders(others)}`);
      reported = true;
    }
    if (performance.now() >= deadline) {
      fail('E0I_LIFECYCLE_BUSY', `lease holders still running after ${Math.round(options.timeoutMs / 1000)} s: ${formatHolders(others)}; marker left in maintenance`, EXIT.busy);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * `--leave` / `leave`, after `drainLeaseHolders` and the validation: `normal` only when this holder's lease is still the lock
 * on `lifecycle.lock`, the marker still names it, and an lsof answer that lists this holder shows no other process with
 * `lifecycle.lock` open (surviving work keeps the lease and the maintenance state).
 */
export async function leaveMaintenance(controlDir: string, held: HeldLease, options: { run: Runner; owner: string }): Promise<void> {
  assertLeaseIdentity(controlDir, held);
  const others = await otherLeaseHolders(controlDir, options.run, 'no other process holds lifecycle.lock');
  if (others.length) fail('E0I_LIFECYCLE_BUSY', `other processes still hold lifecycle.lock: ${formatHolders(others)}`, EXIT.busy);
  assertLeaseIdentity(controlDir, held);
  writeMarker(controlDir, marker({ state: 'normal' }, options.owner));
}
