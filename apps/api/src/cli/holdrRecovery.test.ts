import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CONTROL_ENTRIES, bootstrapControlDir } from '../control/controlDir.js';
import {
  AUTHORIZATION_LOCK, LIFECYCLE_LOCK, RECOVERY_LOCK, acquireSharedLease, lockPath, marker, probeExclusive, readMarker, serializeMarker,
} from '../control/lifecycle.js';
import { repoPaths } from '../control/paths.js';
import type { Runner } from '../control/runner.js';
import { fenceState, newGeneration, readFence, writeFence } from '../control/syncAuthState.js';
import {
  FAKE_MACHINE, captureIo, controlEnvFixture, exited, fakeSystem, liveHome, lockHolder, outsideRepoDir,
} from '../control/testControl.js';
import { TEST_PORT, TEST_WEB_PORT } from '../ingress/fixtures.js';
import { runHoldrRecovery } from './holdrRecovery.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function recovery(env: NodeJS.ProcessEnv, argv: string[]) {
  const capture = captureIo();
  const code = await runHoldrRecovery(argv, { env, io: capture.io, run: fakeSystem });
  return { code, out: capture.out(), err: capture.err() };
}

/** The fence as a start would read it: `open` or the closed reason. */
function gateOf(controlDir: string): string {
  const read = readFence(controlDir, FAKE_MACHINE);
  return read.gate === 'open' ? 'open' : read.reason;
}

async function coded(fn: () => Promise<unknown>) {
  try {
    await fn();
    return null;
  } catch (error) {
    return { code: (error as { code?: string }).code };
  }
}

async function initialised() {
  const fixture = await controlEnvFixture({ machine: FAKE_MACHINE, run: fakeSystem });
  cleanups.push(fixture.cleanup);
  return fixture;
}

describe.skipIf(process.platform !== 'darwin')('holdr-recovery (§9.6)', { timeout: 60_000 }, () => {
  it('init creates the private control dir once: blocked/init for this machine, lifecycle normal, Time Machine exclusion', async () => {
    const outer = outsideRepoDir('init');
    cleanups.push(outer.cleanup);
    const env = { HOLDR_CONTROL_DIR: path.join(outer.dir, 'Holdr/control'), HOLDR_DATA_DIR: path.join(outer.dir, 'data'), PATH: process.env.PATH };
    const created = await recovery(env, ['init']);
    expect(created.code, created.err).toBe(0);
    expect(created.out).toBe(`created ${env.HOLDR_CONTROL_DIR}: device gate blocked (init), lifecycle normal\ntime machine: excluded\n`);
    expect((fs.statSync(env.HOLDR_CONTROL_DIR).mode & 0o7777)).toBe(0o700);
    expect(fs.readdirSync(env.HOLDR_CONTROL_DIR).sort()).toEqual([...CONTROL_ENTRIES].sort());
    for (const name of CONTROL_ENTRIES) expect(fs.statSync(path.join(env.HOLDR_CONTROL_DIR, name)).mode & 0o7777).toBe(0o600);
    expect(readFence(env.HOLDR_CONTROL_DIR, FAKE_MACHINE)).toMatchObject({ gate: 'closed', reason: 'blocked:init' });
    expect(readMarker(env.HOLDR_CONTROL_DIR)).toMatchObject({ state: 'normal' });
    const again = await recovery(env, ['init']);
    expect(again.code).toBe(1);
    expect(again.err).toContain('E0I_CONTROL_DIR');
    expect((await recovery(env, ['init', 'extra'])).code).toBe(64);
  });

  it('status is lock-free and value-free; block is idempotent and works beside a running API', async () => {
    const { env, controlDir } = await initialised();
    const holder = await lockHolder(lockPath(controlDir, LIFECYCLE_LOCK), 'shared', cleanups);
    const status = await recovery(env, ['status']);
    expect(status.code).toBe(0);
    for (const line of ['device gate: blocked (init)', 'generation: none', 'machine: matches', 'time machine: excluded',
      'lifecycle: normal', `lock holders: lifecycle.lock ${holder.pid} node; authorization.lock none; recovery.lock none`,
      'db: not available before E1b v15 (no DB part yet)']) expect(status.out).toContain(`${line}\n`);
    expect(await recovery(env, ['block'])).toMatchObject({ code: 0, out: 'device gate: blocked (incident)\n' });
    expect(await recovery(env, ['block', '--reason', 'incident'])).toMatchObject({ code: 0, out: 'device gate: already blocked (incident)\n' });
    expect((await recovery(env, ['block', '--reason', 'init'])).code).toBe(64);
    expect(readFence(controlDir, FAKE_MACHINE)).toMatchObject({ reason: 'blocked:incident' });
    holder.kill('SIGKILL');
    await exited(holder);
  });

  it('reinit rebuilds an absent control dir (Time Machine excludes it) once Holdr is shown to be stopped (B1 review 5)', async () => {
    const outer = outsideRepoDir('boot');
    cleanups.push(outer.cleanup);
    const dataDir = path.join(outer.dir, 'data');
    fs.mkdirSync(dataDir, { mode: 0o700 });
    const controlDir = path.join(outer.dir, 'Holdr/control');
    const env = { HOLDR_CONTROL_DIR: controlDir, HOLDR_DATA_DIR: dataDir, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: liveHome(outer.dir) };
    const result = await recovery(env, ['reinit', '--timeout', '5']);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('control dir absent: showing that Holdr is stopped before rebuilding it\n');
    expect(result.out).toContain('control dir rebuilt (created recovery.lock, sync-auth-state, lifecycle-state, lifecycle.lock, authorization.lock; '
      + 'device gate blocked (reinit), lifecycle maintenance (reinit))\n');
    expect(result.out).toContain('time machine: excluded\n');
    expect(fs.readdirSync(controlDir).sort()).toEqual([...CONTROL_ENTRIES].sort());
    for (const name of CONTROL_ENTRIES) expect(fs.statSync(path.join(controlDir, name)).mode & 0o7777).toBe(0o600);
    expect(fs.statSync(controlDir).mode & 0o7777).toBe(0o700);
    // A fresh blocked fence, never an old one; lifecycle normal only after validation.
    expect(readFence(controlDir, FAKE_MACHINE)).toMatchObject({ reason: 'blocked:reinit', state: { generation: null } });
    expect(readMarker(controlDir)).toMatchObject({ state: 'normal', lease: null });
  });

  it('reinit completes an interrupted init without replacing what exists, and not while a control file is held', async () => {
    const outer = outsideRepoDir('part');
    cleanups.push(outer.cleanup);
    const dataDir = path.join(outer.dir, 'data');
    fs.mkdirSync(dataDir, { mode: 0o700 });
    const controlDir = path.join(outer.dir, 'control');
    fs.mkdirSync(controlDir, { mode: 0o700 });
    fs.chmodSync(controlDir, 0o700);
    // init stopped after its first lock file.
    fs.writeFileSync(lockPath(controlDir, LIFECYCLE_LOCK), '', { mode: 0o600 });
    const env = { HOLDR_CONTROL_DIR: controlDir, HOLDR_DATA_DIR: dataDir, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: liveHome(outer.dir) };
    expect((await recovery(env, ['init'])).err).toContain('use holdr-recovery reinit');
    const holder = await lockHolder(lockPath(controlDir, LIFECYCLE_LOCK), 'shared', cleanups);
    const refused = await recovery(env, ['reinit', '--timeout', '1']);
    expect(refused.code).toBe(75);
    expect(refused.err).toContain(`control files are held by ${holder.pid} node`);
    expect(fs.readdirSync(controlDir)).toEqual(['lifecycle.lock']);
    holder.kill('SIGKILL');
    await exited(holder);
    const identity = fs.statSync(lockPath(controlDir, LIFECYCLE_LOCK)).ino;
    const done = await recovery(env, ['reinit', '--timeout', '5']);
    expect(done.code, done.err).toBe(0);
    expect(done.out).toContain('control dir partial (missing sync-auth-state, lifecycle-state, authorization.lock, recovery.lock)');
    expect(fs.statSync(lockPath(controlDir, LIFECYCLE_LOCK)).ino, 'an existing lock file is never replaced').toBe(identity);
    expect(readMarker(controlDir)).toMatchObject({ state: 'normal' });
    expect(readFence(controlDir, FAKE_MACHINE)).toMatchObject({ reason: 'blocked:reinit' });
  });

  it('reinit refuses an unsafe control dir, or a database still in use, before creating anything', async () => {
    const outer = outsideRepoDir('unsafe');
    cleanups.push(outer.cleanup);
    const dataDir = path.join(outer.dir, 'data');
    fs.mkdirSync(dataDir, { mode: 0o700 });
    const controlDir = path.join(outer.dir, 'control');
    fs.mkdirSync(controlDir, { mode: 0o700 });
    fs.chmodSync(controlDir, 0o700);
    const env = { HOLDR_CONTROL_DIR: controlDir, HOLDR_DATA_DIR: dataDir, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: liveHome(outer.dir) };
    fs.writeFileSync(path.join(controlDir, 'sync-auth-state.bak'), 'x', { mode: 0o600 });
    const unsafe = await recovery(env, ['reinit', '--timeout', '1']);
    expect(unsafe.code).toBe(1);
    expect(unsafe.err).toContain('E0I_CONTROL_DIR (unexpected entries');
    fs.rmSync(path.join(controlDir, 'sync-auth-state.bak'));
    fs.writeFileSync(path.join(controlDir, 'lifecycle-state'), '{}', { mode: 0o644 });
    fs.chmodSync(path.join(controlDir, 'lifecycle-state'), 0o644);
    expect((await recovery(env, ['reinit', '--timeout', '1'])).err).toContain('lifecycle-state is not a private regular file');
    fs.rmSync(path.join(controlDir, 'lifecycle-state'));
    const db = path.join(dataDir, 'finance.db');
    fs.writeFileSync(db, '', { mode: 0o600 });
    const reader = spawn(process.execPath, ['-e', "require('fs').openSync(process.argv[1], 'r'); process.stdout.write('open'); setInterval(() => {}, 1000);", db], { stdio: ['ignore', 'pipe', 'ignore'] });
    cleanups.push(() => { reader.kill('SIGKILL'); });
    await new Promise<void>((resolve) => reader.stdout!.once('data', () => resolve()));
    const inUse = await recovery(env, ['reinit', '--timeout', '1']);
    expect(inUse.code).toBe(1);
    expect(inUse.err).toContain('E0I_DB_IN_USE');
    expect(fs.readdirSync(controlDir)).toEqual([]);
  });

  it('reinit: blocked/reinit first, then maintenance, drain, offline validation inside the lease, and normal again', async () => {
    const { env, controlDir } = await initialised();
    const result = await recovery(env, ['reinit', '--timeout', '5']);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('device gate: blocked (reinit); lifecycle: maintenance (reinit)\n');
    expect(result.out).toContain('reinit complete: lifecycle normal, device gate stays blocked (reinit) until E2 reset-authorization\n');
    expect(readFence(controlDir, FAKE_MACHINE)).toMatchObject({ reason: 'blocked:reinit', state: { generation: null, next: null, op: null } });
    expect(readMarker(controlDir)).toMatchObject({ state: 'normal', lease: null });
    expect(probeExclusive(controlDir)).toBe('free');
  });

  it('reinit runs this tree\'s stop role before the drain, so a running API releases its lease (maintenance step 2)', async () => {
    const { env, controlDir } = await initialised();
    const root = outsideRepoDir('root');
    cleanups.push(root.cleanup);
    const tree = path.join(root.dir, 'FinanceTracker');
    fs.mkdirSync(path.join(tree, 'apps/api'), { recursive: true });
    fs.mkdirSync(path.join(tree, 'node_modules/.bin'), { recursive: true });
    const logs = path.join(root.dir, 'logs');
    fs.mkdirSync(logs);
    // A stand-in for this tree's API: owned by the user, cwd apps/api, command naming node_modules and src/index.ts, holding
    // the shared lifecycle lease and listening on its port.
    const fake = path.join(tree, 'node_modules/.bin/tsx');
    fs.writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs');
fs.openSync(${JSON.stringify(lockPath(controlDir, LIFECYCLE_LOCK))}, fs.constants.O_RDONLY | 0x10);
require('node:http').createServer((q, r) => r.end('ok')).listen(${TEST_PORT}, '127.0.0.1', () => process.stdout.write('ready\\n'));
process.on('SIGTERM', () => process.exit(0));
`, { mode: 0o755 });
    const api = spawn(fake, ['src/index.ts'], { cwd: path.join(tree, 'apps/api'), stdio: ['ignore', 'pipe', 'inherit'] });
    cleanups.push(() => { api.kill('SIGKILL'); });
    await new Promise<void>((resolve) => api.stdout!.once('data', () => resolve()));
    fs.writeFileSync(path.join(logs, 'api.pid'), `${api.pid}\n`);
    expect(probeExclusive(controlDir)).toBe('held');
    const result = await recovery({
      ...env, HOME: root.dir, HOLDR_ROOT: root.dir, HOLDR_LOG_DIR: logs, HOLDR_API_PORT: String(TEST_PORT), HOLDR_WEB_PORT: String(TEST_WEB_PORT), HOLDR_BRIDGE_PORT: '3325',
    }, ['reinit', '--timeout', '5']);
    // The stop role stopped the tree's API before the drain, so the drain got the lease.
    await exited(api);
    expect(readFence(controlDir, FAKE_MACHINE)).toMatchObject({ reason: 'blocked:reinit' });
    // This code is not the managed live tree HOLDR_ROOT names, so it validates nothing by itself and leaves maintenance alone
    // (B1 round-2 finding 3): run from the live tree, or name the target.
    expect(result.code).toBe(64);
    expect(result.err).toContain('E0I_LEAVE_TARGET');
    expect(readMarker(controlDir)).toMatchObject({ state: 'maintenance', reason: 'reinit' });
  });

  it('reinit quarantines before it repairs: an open fence and a normal marker become blocked/maintenance before a missing lock exists (B1 round-2 finding 1)', async () => {
    const { env, controlDir } = await initialised();
    // An open fence for this machine and a normal marker, with only lifecycle.lock missing: the regression's starting point.
    writeFence(controlDir, fenceState({ gate: 'open', reason: null, generation: newGeneration(), next: null, op: null, machine: FAKE_MACHINE }));
    fs.rmSync(lockPath(controlDir, LIFECYCLE_LOCK));
    expect(readMarker(controlDir)).toMatchObject({ state: 'normal' });
    const identities = Object.fromEntries(([AUTHORIZATION_LOCK, RECOVERY_LOCK] as const).map((name) => [name, fs.statSync(lockPath(controlDir, name)).ino]));
    // What a start would see at each point: the Time Machine call comes only after the quarantine and the recovery entry.
    const seen: string[] = [];
    const watching: Runner = async (file, args) => {
      if (file === '/usr/bin/tmutil' && args[0] === 'addexclusion') {
        seen.push(`tmutil: fence ${gateOf(controlDir)}, marker ${readMarker(controlDir)?.state}, `
          + `lease ${await acquireSharedLease(controlDir, { timeoutMs: 0 }).then((lease) => { lease.release(); return 'granted'; }, (error) => error.code)}`);
      }
      return fakeSystem(file, args);
    };
    const capture = captureIo();
    const code = await runHoldrRecovery(['reinit', '--timeout', '5'], { env, io: capture.io, run: watching });
    expect(code, capture.err()).toBe(0);
    expect(seen).toEqual(['tmutil: fence blocked:reinit, marker maintenance, lease E0I_MAINTENANCE']);
    for (const [name, ino] of Object.entries(identities)) expect(fs.statSync(path.join(controlDir, name)).ino, `${name} kept`).toBe(ino);
    expect(readFence(controlDir, FAKE_MACHINE)).toMatchObject({ reason: 'blocked:reinit', state: { generation: null } });
    expect(readMarker(controlDir)).toMatchObject({ state: 'normal' });
  });

  it('a bootstrap interrupted anywhere leaves nothing startable: quarantine is durable before lifecycle.lock or authorization.lock is made', async () => {
    const outer = outsideRepoDir('order');
    cleanups.push(outer.cleanup);
    const controlDir = path.join(outer.dir, 'control');
    fs.mkdirSync(controlDir, { mode: 0o700 });
    fs.chmodSync(controlDir, 0o700);
    // An interrupted init: the marker said normal, the fence was open (a restore), and both gating locks are missing.
    fs.writeFileSync(path.join(controlDir, 'lifecycle-state'), serializeMarker(marker({ state: 'normal' }, 'test')), { mode: 0o600 });
    writeFence(controlDir, fenceState({ gate: 'open', reason: null, generation: newGeneration(), next: null, op: null, machine: FAKE_MACHINE }));
    const states: Record<string, unknown> = {};
    const result = await bootstrapControlDir(controlDir, {
      machine: FAKE_MACHINE, repo: repoPaths(), observe: (step) => {
        states[step] = {
          fence: gateOf(controlDir), marker: readMarker(controlDir)?.state,
          locks: ([LIFECYCLE_LOCK, AUTHORIZATION_LOCK, RECOVERY_LOCK] as const).filter((name) => fs.existsSync(lockPath(controlDir, name))),
        };
      },
    });
    try {
      expect(states).toEqual({
        serialized: { fence: 'open', marker: 'normal', locks: [RECOVERY_LOCK] },
        quarantined: { fence: 'blocked:reinit', marker: 'maintenance', locks: [RECOVERY_LOCK] },
        repaired: { fence: 'blocked:reinit', marker: 'maintenance', locks: [LIFECYCLE_LOCK, AUTHORIZATION_LOCK, RECOVERY_LOCK] },
      });
      expect(result.created).toEqual([RECOVERY_LOCK, LIFECYCLE_LOCK, AUTHORIZATION_LOCK]);
      // The bootstrap's recovery.lock is held for the recovery entry: a second operation is busy meanwhile.
      expect(await coded(() => bootstrapControlDir(controlDir, { machine: FAKE_MACHINE, repo: repoPaths() }))).toMatchObject({ code: 'E0I_INTERNAL' });
      fs.rmSync(lockPath(controlDir, LIFECYCLE_LOCK));
      expect(await coded(() => bootstrapControlDir(controlDir, { machine: FAKE_MACHINE, repo: repoPaths() }))).toMatchObject({ code: 'E0I_RECOVERY_BUSY' });
      expect(fs.existsSync(lockPath(controlDir, LIFECYCLE_LOCK)), 'the busy attempt repaired nothing').toBe(false);
    } finally {
      result.recoveryLock.release();
    }
  });

  it('reinit inside a lease refuses before any side effect: no stop role, no bootstrap (B1 round-2 finding 1)', async () => {
    const outer = outsideRepoDir('inlease');
    cleanups.push(outer.cleanup);
    const dataDir = path.join(outer.dir, 'data');
    fs.mkdirSync(dataDir, { mode: 0o700 });
    const controlDir = path.join(outer.dir, 'control');
    const env = { HOLDR_CONTROL_DIR: controlDir, HOLDR_DATA_DIR: dataDir, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: liveHome(outer.dir) };
    for (const lease of [{ HOLDR_LIFECYCLE_LEASE_FD: '3' }, { HOLDR_LIFECYCLE_LEASE: 'ab'.repeat(8) }]) {
      const refused = await recovery({ ...env, ...lease }, ['reinit', '--timeout', '1']);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain('E0I_RECOVERY_IN_LEASE');
      expect(refused.out).toBe('');
      expect(fs.existsSync(controlDir), 'nothing was created').toBe(false);
    }
  });

  it('reinit against a running holder: the fence is written before the drain, which reports holders and exits 75', async () => {
    const { env, controlDir } = await initialised();
    const holder = await lockHolder(lockPath(controlDir, LIFECYCLE_LOCK), 'shared', cleanups);
    const result = await recovery(env, ['reinit', '--timeout', '1']);
    expect(result.code).toBe(75);
    expect(result.err).toContain('E0I_LIFECYCLE_BUSY');
    expect(result.err).toContain(`lifecycle.lock holders: ${holder.pid} node`);
    expect(readFence(controlDir, FAKE_MACHINE)).toMatchObject({ reason: 'blocked:reinit' });
    expect(readMarker(controlDir)).toMatchObject({ state: 'maintenance', reason: 'reinit', lease: null });
    holder.kill('SIGKILL');
    await exited(holder);
    // recovery.lock was released: the rerun continues the operation.
    const rerun = await recovery(env, ['reinit', '--timeout', '5']);
    expect(rerun.code, rerun.err).toBe(0);
    expect(readMarker(controlDir)).toMatchObject({ state: 'normal' });
  });

  it('refuses inside a lease, while another recovery runs, and for the E2 commands, changing nothing', async () => {
    const { env, controlDir } = await initialised();
    const fence = fs.readFileSync(path.join(controlDir, 'sync-auth-state'), 'utf8');
    const inLease = await recovery({ ...env, HOLDR_LIFECYCLE_LEASE_FD: '3', HOLDR_LIFECYCLE_LEASE: 'ab'.repeat(8) }, ['reinit']);
    expect(inLease).toMatchObject({ code: 1 });
    expect(inLease.err).toContain('E0I_RECOVERY_IN_LEASE');
    expect((await recovery({ ...env, HOLDR_LIFECYCLE_LEASE: 'ab'.repeat(8) }, ['block'])).err).toContain('E0I_LEASE_ENV');
    await lockHolder(lockPath(controlDir, RECOVERY_LOCK), 'exclusive', cleanups);
    const busy = await recovery(env, ['reinit']);
    expect(busy.code).toBe(75);
    expect(busy.err).toContain('E0I_RECOVERY_BUSY');
    const restore = await recovery(env, ['restore']);
    expect(restore.code).toBe(1);
    expect(restore.err).toContain('E0I_NOT_AVAILABLE');
    // E2b: reset-authorization exists; without a database it refuses before anything changes (resetAuthorization.test.ts).
    const reset = await recovery(env, ['reset-authorization']);
    expect(reset.code).toBe(1);
    expect(reset.err).toContain('E0I_DB_MISSING');
    expect((await recovery(env, ['open'])).code).toBe(64);
    expect((await recovery(env, [])).code).toBe(64);
    expect(fs.readFileSync(path.join(controlDir, 'sync-auth-state'), 'utf8')).toBe(fence);
    expect(readMarker(controlDir)).toMatchObject({ state: 'normal' });
  });
});
