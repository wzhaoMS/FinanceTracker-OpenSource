import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { parseHolders } from '../control/holders.js';
import { LIFECYCLE_LOCK, acquireSharedLease, lockPath, probeExclusive, readMarker } from '../control/lifecycle.js';
import { API_SRC_DIR, REPO_ROOT, repoPaths } from '../control/paths.js';
import {
  FAKE_MACHINE, TSX_LOADER, captureIo, controlEnvFixture, exited, fakeSystem, lockHolder, testLeasedScript, waitFor,
} from '../control/testControl.js';
import { scratchDir } from '../control/testDirs.js';
import { runHoldrLifecycle } from './holdrLifecycle.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
// The repository's holdr-leased.sh runs /opt/homebrew/bin/node (B-D32); the tests run a copy that differs only in that line.
let LEASED = repoPaths().leasedScript;
let leasedCleanup = () => {};
beforeAll(() => { const copy = testLeasedScript(); LEASED = copy.script; leasedCleanup = copy.cleanup; });
afterAll(() => leasedCleanup());
const LIFECYCLE_MAIN = path.join(API_SRC_DIR, 'cli/holdrLifecycleMain.ts');

async function setup() {
  const fixture = await controlEnvFixture({ machine: FAKE_MACHINE });
  cleanups.push(fixture.cleanup);
  const out = scratchDir('lc');
  cleanups.push(out.cleanup);
  return { ...fixture, out: out.dir };
}

async function lifecycle(env: NodeJS.ProcessEnv, argv: string[]) {
  const capture = captureIo();
  const code = await runHoldrLifecycle(argv, { env, io: capture.io, run: fakeSystem });
  return { code, out: capture.out(), err: capture.err() };
}

/**
 * `bash -c` that runs `script` with "$0" = first extra argument etc.; its output goes to files the test reads. `--norc`:
 * the test runner's stdin is a socket, and bash 3.2 would otherwise read the developer's ~/.bashrc for `-c` commands.
 */
const bash = (script: string, ...args: string[]) => ['/bin/bash', '--norc', '-c', script, ...args];

describe.skipIf(process.platform !== 'darwin')('holdr-lifecycle (§9.3, §9.6) with real locks and descriptor passing', { timeout: 60_000 }, () => {
  it('enter is persistent and idempotent; probe --exclusive never waits and changes nothing', async () => {
    const { env, controlDir } = await setup();
    expect((await lifecycle(env, ['enter'])).code).toBe(64);
    const entered = await lifecycle(env, ['enter', '--reason', 'deploy']);
    expect(entered.code).toBe(0);
    expect(readMarker(controlDir)).toMatchObject({ state: 'maintenance', reason: 'deploy', lease: null });
    expect((await lifecycle(env, ['enter', '--reason', 'other'])).out).toContain('already maintenance (deploy)');
    expect(readMarker(controlDir)).toMatchObject({ reason: 'deploy' });
    const before = fs.readFileSync(path.join(controlDir, 'lifecycle-state'), 'utf8');
    expect(await lifecycle(env, ['probe', '--exclusive'])).toMatchObject({ code: 0, out: 'free\n' });
    const holder = await lockHolder(lockPath(controlDir, LIFECYCLE_LOCK), 'shared', cleanups);
    const started = Date.now();
    expect(await lifecycle(env, ['probe', '--exclusive'])).toMatchObject({ code: 75, out: 'held\n' });
    expect(Date.now() - started).toBeLessThan(1000);
    holder.kill('SIGKILL');
    await exited(holder);
    expect(fs.readFileSync(path.join(controlDir, 'lifecycle-state'), 'utf8')).toBe(before);
    const status = await lifecycle(env, ['status']);
    expect(status.code).toBe(0);
    expect(status.out).toContain('lifecycle: maintenance (deploy)\n');
    expect(status.out).toContain('device gate: blocked (init)\n');
    expect(status.out).toContain('machine: matches\n');
  });

  it('exclusive needs the marker maintenance and refuses lease variables', async () => {
    const { env, controlDir } = await setup();
    expect(await lifecycle(env, ['exclusive', '--', '/usr/bin/true'])).toMatchObject({ code: 1 });
    expect(readMarker(controlDir)).toMatchObject({ state: 'normal' });
    const leased = await lifecycle({ ...env, HOLDR_LIFECYCLE_LEASE_FD: '3' }, ['status']);
    expect(leased.code).toBe(1);
    expect(leased.err).toContain('E0I_LEASE_ENV');
  });

  it('a busy lock is reported with its holders after the timeout (75) and nothing changes', async () => {
    const { env, controlDir } = await setup();
    await lifecycle(env, ['enter', '--reason', 'deploy']);
    const holder = await lockHolder(lockPath(controlDir, LIFECYCLE_LOCK), 'shared', cleanups);
    const result = await lifecycle(env, ['exclusive', '--timeout', '1', '--', '/usr/bin/true']);
    expect(result.code).toBe(75);
    expect(result.err).toContain('E0I_LIFECYCLE_BUSY');
    expect(result.err).toContain(`${holder.pid} node`);
    expect(readMarker(controlDir)).toMatchObject({ state: 'maintenance', lease: null });
  });

  it('exclusive --leave hands fd 3 to the work, validates offline inside the lease and returns to normal', async () => {
    const { env, controlDir, out } = await setup();
    await lifecycle(env, ['enter', '--reason', 'deploy']);
    const report = path.join(out, 'validate.txt');
    const result = await lifecycle(env, ['exclusive', '--leave', '--', ...bash('"$0" validate-offline > "$1" 2>&1', LEASED, report)]);
    expect(result.code, result.err).toBe(0);
    expect(fs.readFileSync(report, 'utf8')).toContain('VALIDATED offline under the inherited lease');
    expect(readMarker(controlDir)).toMatchObject({ state: 'normal', lease: null });
    expect(probeExclusive(controlDir)).toBe('free');
  });

  it('the lease-aware path keeps the lease; npm/tsx launchers lose it and the role refuses (E0I_LEASE_REQUIRED)', async () => {
    const { env, controlDir, out } = await setup();
    await lifecycle(env, ['enter', '--reason', 'deploy']);
    const status = path.join(out, 'status.txt');
    expect((await lifecycle(env, ['exclusive', '--', ...bash('"$0" status > "$1" 2>&1', LEASED, status)])).code).toBe(0);
    expect(fs.readFileSync(status, 'utf8')).toContain('lifecycle: maintenance (deploy) with lease');
    const viaTsx = path.join(out, 'tsx.txt');
    const tsx = path.join(REPO_ROOT, 'node_modules/.bin/tsx');
    const result = await lifecycle(env, ['exclusive', '--', ...bash('"$0" "$1" validate-offline > "$2" 2>&1', tsx, path.join(API_SRC_DIR, 'cli/leasedMain.ts'), viaTsx)]);
    expect(result.code).toBe(3);
    expect(fs.readFileSync(viaTsx, 'utf8')).toContain('E0I_LEASE_REQUIRED');
    const stale = path.join(out, 'stale.txt');
    expect((await lifecycle(env, ['exclusive', '--', ...bash('HOLDR_LIFECYCLE_LEASE=0000000000000000 "$0" status > "$1" 2>&1', LEASED, stale)])).code).toBe(3);
    expect(fs.readFileSync(stale, 'utf8')).toContain('E0I_LEASE_REQUIRED');
    expect(readMarker(controlDir)).toMatchObject({ state: 'maintenance' });
  });

  it('holdr-leased.sh refuses unknown roles (64) and any role without a proven lease (3)', async () => {
    const { env } = await setup();
    const run = (args: string[]) => new Promise<{ code: number | null; text: string }>((resolve) => {
      const child = spawn('/bin/bash', [LEASED, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let text = '';
      child.stdout.on('data', (chunk) => { text += chunk; });
      child.stderr.on('data', (chunk) => { text += chunk; });
      child.once('close', (code) => resolve({ code, text }));
    });
    expect((await run(['deploy'])).code).toBe(64);
    for (const role of ['validate-offline', 'status']) {
      const result = await run([role]);
      expect(result.code).toBe(3);
      expect(result.text).toContain('E0I_LEASE_REQUIRED');
    }
  });

  it('after the wrapper is SIGKILLed the work keeps the lease until it exits; leave then validates and reopens', async () => {
    const { env, controlDir, out } = await setup();
    await lifecycle(env, ['enter', '--reason', 'deploy']);
    const started = path.join(out, 'started');
    const wrapper = spawn(process.execPath, ['--import', TSX_LOADER, LIFECYCLE_MAIN, 'exclusive', '--timeout', '5', '--',
      ...bash('echo started > "$0"; sleep 2', started)], { env, stdio: ['ignore', 'ignore', 'inherit'] });
    cleanups.push(() => { wrapper.kill('SIGKILL'); });
    await waitFor(() => fs.existsSync(started), 20_000);
    wrapper.kill('SIGKILL');
    await exited(wrapper);
    expect(probeExclusive(controlDir)).toBe('held');
    expect(readMarker(controlDir)).toMatchObject({ state: 'maintenance' });
    expect((await lifecycle(env, ['leave', '--timeout', '1'])).code).toBe(75);
    await waitFor(() => probeExclusive(controlDir) === 'free', 10_000);
    const left = await lifecycle(env, ['leave']);
    expect(left.code, left.err).toBe(0);
    expect(readMarker(controlDir)).toMatchObject({ state: 'normal', lease: null });
  });

  it('spawnLeased keeps the lease in a background grandchild; a plain spawn does not', async () => {
    const { env, controlDir, out } = await setup();
    await lifecycle(env, ['enter', '--reason', 'deploy']);
    const worker = path.join(out, 'worker.ts');
    fs.writeFileSync(worker, `
      import { spawn } from 'node:child_process';
      import { spawnLeased } from ${JSON.stringify(path.join(API_SRC_DIR, 'control/leasedSpawn.ts'))};
      const [mode, controlDir] = process.argv.slice(2);
      const child = mode === 'leased'
        ? spawnLeased(controlDir, '/bin/sleep', ['2'], { stdio: ['ignore', 'ignore', 'ignore'] })
        : spawn('/bin/sleep', ['2'], { stdio: 'ignore' });
      child.unref();
    `);
    for (const mode of ['leased', 'plain']) {
      const result = await lifecycle(env, ['exclusive', '--', process.execPath, '--import', TSX_LOADER, worker, mode, controlDir]);
      expect(result.code, result.err).toBe(0);
      expect(probeExclusive(controlDir)).toBe(mode === 'leased' ? 'held' : 'free');
      await waitFor(() => probeExclusive(controlDir) === 'free', 10_000);
    }
  });

  it('--leave waits for work left behind with the lease before validating, and keeps maintenance after the timeout (75)', async () => {
    const { env, controlDir } = await setup();
    await lifecycle(env, ['enter', '--reason', 'deploy']);
    const result = await lifecycle(env, ['exclusive', '--timeout', '1', '--leave', '--', ...bash('(sleep 4 >/dev/null 2>&1 &); exit 0')]);
    expect(result.code).toBe(75);
    expect(result.err).toContain("waiting for the work's remaining lease holders");
    expect(result.err).toContain('lease holders still running after 1 s');
    expect(readMarker(controlDir)).toMatchObject({ state: 'maintenance' });
    await waitFor(() => probeExclusive(controlDir) === 'free', 10_000);
  });

  it('a background worker that changes the data after the command exits is validated after it finishes (B1 review 3)', async () => {
    const { env, controlDir, dataDir } = await setup();
    await lifecycle(env, ['enter', '--reason', 'deploy']);
    // The command exits at once; its background child keeps fd 3 (the lease) and breaks K18 a moment later. Validating before
    // it finished would pass and return to normal; draining first sees the change and keeps maintenance.
    const loose = path.join(dataDir, 'written-late.txt');
    const result = await lifecycle(env, ['exclusive', '--timeout', '10', '--leave', '--',
      ...bash('(sleep 1; printf x > "$0"; chmod 644 "$0") >/dev/null 2>&1 & exit 0', loose)]);
    expect(result.code, result.err).toBe(1);
    expect(result.err).toContain("waiting for the work's remaining lease holders");
    expect(result.err).toContain('E0I_VALIDATION');
    expect(fs.statSync(loose).mode & 0o777).toBe(0o644);
    expect(readMarker(controlDir)).toMatchObject({ state: 'maintenance' });
    fs.rmSync(loose);
    const left = await lifecycle(env, ['leave']);
    expect(left.code, left.err).toBe(0);
    expect(readMarker(controlDir)).toMatchObject({ state: 'normal' });
  });

  it('the DB-in-use guard refuses when another process has finance.db open', async () => {
    const { env, controlDir, dataDir } = await setup();
    await lifecycle(env, ['enter', '--reason', 'deploy']);
    const db = path.join(dataDir, 'finance.db');
    fs.writeFileSync(db, '', { mode: 0o600 });
    const fd = fs.openSync(db, 'r');
    const sleeper = spawn('/bin/sleep', ['5'], { stdio: [fd, 'ignore', 'ignore'] });
    fs.closeSync(fd);
    cleanups.push(() => { sleeper.kill('SIGKILL'); });
    const result = await lifecycle(env, ['exclusive', '--', '/usr/bin/true']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('E0I_DB_IN_USE');
    expect(result.err).toContain(`${sleeper.pid} sleep`);
    expect(probeExclusive(controlDir)).toBe('free');
  });

  it('an lsof answer that does not list this holder proves nothing: drain and leave keep maintenance (B1 round-2 finding 4)', async () => {
    const { env, controlDir } = await setup();
    const lockFile = lockPath(controlDir, LIFECYCLE_LOCK);
    // The answers the review injected, and more: lsof failed or saw nothing (exit 1, no output), a malformed exit-0 answer, a
    // complete answer without this process, one whose process set lacks its command or descriptor lines.
    const answers: Array<[string, { exitCode: number; stdout: string }]> = [
      ['exit 1, empty', { exitCode: 1, stdout: '' }],
      ['exit 0, empty', { exitCode: 0, stdout: '' }],
      ['malformed', { exitCode: 0, stdout: 'garbage\n' }],
      ['without this holder', { exitCode: 0, stdout: 'p1\ncinit\nf3\n' }],
      ['no descriptor line', { exitCode: 0, stdout: `p${process.pid}\ncnode\n` }],
      ['no final newline', { exitCode: 0, stdout: `p${process.pid}\ncnode\nf3` }],
      ['exit 2', { exitCode: 2, stdout: '' }],
    ];
    for (const [name, answer] of answers) {
      const injected = async (file: string, args: readonly string[]) => (file === '/usr/sbin/lsof' && args.includes(lockFile) ? answer : fakeSystem(file, args));
      for (const argv of [['leave', '--timeout', '1'], ['exclusive', '--leave', '--timeout', '1', '--', '/usr/bin/true']]) {
        expect((await lifecycle(env, ['enter', '--reason', 'deploy'])).code).toBe(0);
        const capture = captureIo();
        const code = await runHoldrLifecycle(argv, { env, io: capture.io, run: injected });
        expect(code, `${name}, ${argv[0]}: ${capture.err()}`).toBe(75);
        expect(capture.err()).toContain('lsof gave no complete answer that lists this holder');
        expect(readMarker(controlDir), `${name}, ${argv[0]}`).toMatchObject({ state: 'maintenance' });
      }
    }
    // The real lsof lists this holder: the same leave completes.
    const left = await lifecycle(env, ['leave', '--timeout', '5']);
    expect(left.code, left.err).toBe(0);
    expect(readMarker(controlDir)).toMatchObject({ state: 'normal' });
  });

  it('parseHolders reads lsof\'s -F pc output completely, or not at all', () => {
    expect(parseHolders('')).toEqual([]);
    expect(parseHolders('p12\ncnode\nf3\nf4\np34\ncbash\nfcwd\n')).toEqual([{ pid: 12, command: 'node' }, { pid: 34, command: 'bash' }]);
    for (const bad of ['p12\ncnode\nf3', 'p12\nf3\n', 'p12\ncnode\n', 'cnode\nf3\n', 'p0\ncnode\nf3\n', 'p-1\ncnode\nf3\n',
      'p12\ncnode\ncnode\nf3\n', 'p12\ncnode\nf3\nx\n', 'p12\ncnode\nf 3\n', '\n']) {
      expect(parseHolders(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('shared holders (the API, writers, the preflight) block the drain; the marker stops new ones', async () => {
    const { env, controlDir } = await setup();
    const lease = await acquireSharedLease(controlDir);
    expect(probeExclusive(controlDir)).toBe('held');
    lease.release();
    await lifecycle(env, ['enter', '--reason', 'deploy']);
    await expect(acquireSharedLease(controlDir, { timeoutMs: 100 })).rejects.toMatchObject({ code: 'E0I_MAINTENANCE', exitCode: 3 });
  });
});
