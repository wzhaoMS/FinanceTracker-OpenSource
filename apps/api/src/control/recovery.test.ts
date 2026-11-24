import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { EXIT } from './errors.js';
import { RECOVERY_LOCK, lockPath, readMarker, tryLock, releaseLock } from './lifecycle.js';
import { COMPLETION_EXIT, blockFence, completeRecovery, enterRecovery } from './recovery.js';
import { FENCE_FILE, GENERATION, fenceState, readFence, writeFence } from './syncAuthState.js';
import { TEST_MACHINE, controlFixture } from './testControl.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const fixture = async () => { const f = await controlFixture(); cleanups.push(f.cleanup); return f; };
const G = 'agn_' + 'b'.repeat(32);
const env = {};
const coded = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; exitCode?: number }) => ({ code: error.code, exitCode: error.exitCode }));

/** A separate process holding `file` with O_EXLOCK until killed. */
async function exclusiveHolder(file: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    fs.openSync(${JSON.stringify(file)}, fs.constants.O_RDONLY | 0x20);
    process.stdout.write('held\\n');
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  cleanups.push(() => { child.kill('SIGKILL'); });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve());
    child.once('exit', () => reject(new Error('holder exited')));
  });
  return child;
}

describe.skipIf(process.platform !== 'darwin')('recovery entry and completion (§9.3, round 3 B4)', () => {
  it('writes this operation\'s blocked/recovery state first, then maintenance; completion opens N', async () => {
    const { controlDir } = await fixture();
    writeFence(controlDir, fenceState({ gate: 'open', reason: null, generation: G, next: null, op: null, machine: TEST_MACHINE }));
    const entry = await enterRecovery(controlDir, { env, machine: TEST_MACHINE, kind: 'recovery' });
    cleanups.push(() => entry.recoveryLock.release());
    const R = entry.state;
    expect(R).toMatchObject({ gate: 'blocked', reason: 'recovery', generation: G, machine: TEST_MACHINE });
    expect(R.next).toMatch(GENERATION);
    expect(R.op).toMatch(/^[0-9a-f]{16}$/);
    expect(readFence(controlDir, TEST_MACHINE)).toMatchObject({ gate: 'closed', reason: 'blocked:recovery', state: R });
    expect(readMarker(controlDir)).toMatchObject({ state: 'maintenance', reason: 'recovery' });
    const written: string[] = [];
    const result = await completeRecovery(controlDir, entry, { machine: TEST_MACHINE, setDatabaseGeneration: (next) => { written.push(next); } });
    expect(result).toBe('opened');
    expect(COMPLETION_EXIT[result]).toBe(0);
    expect(written).toEqual([R.next]);
    expect(readFence(controlDir, TEST_MACHINE)).toMatchObject({ gate: 'open', state: { generation: R.next, next: null, op: null } });
  });

  it('an incident block written during the recovery wins: completed-but-blocked, exit 5, DB part still done', async () => {
    const { controlDir } = await fixture();
    const entry = await enterRecovery(controlDir, { env, machine: TEST_MACHINE, kind: 'recovery' });
    cleanups.push(() => entry.recoveryLock.release());
    expect(await blockFence(controlDir, TEST_MACHINE)).toBe('blocked');
    const written: string[] = [];
    const result = await completeRecovery(controlDir, entry, { machine: TEST_MACHINE, setDatabaseGeneration: (next) => { written.push(next); } });
    expect(result).toBe('completed-but-blocked');
    expect(COMPLETION_EXIT[result]).toBe(EXIT.completedButBlocked);
    expect(written).toEqual([entry.state.next]);
    expect(readFence(controlDir, TEST_MACHINE)).toMatchObject({ gate: 'closed', reason: 'blocked:incident' });
  });

  it('a rerun after an interruption takes the operation over: same next, new op; the stale operation cannot open', async () => {
    const { controlDir } = await fixture();
    const first = await enterRecovery(controlDir, { env, machine: TEST_MACHINE, kind: 'recovery' });
    first.recoveryLock.release(); // the process died after its first durable action
    expect(readFence(controlDir, TEST_MACHINE)).toMatchObject({ gate: 'closed', reason: 'blocked:recovery' });
    const second = await enterRecovery(controlDir, { env, machine: TEST_MACHINE, kind: 'recovery' });
    cleanups.push(() => second.recoveryLock.release());
    expect(second.state.next).toBe(first.state.next);
    expect(second.state.op).not.toBe(first.state.op);
    expect(await completeRecovery(controlDir, first, { machine: TEST_MACHINE, setDatabaseGeneration: () => {} })).toBe('completed-but-blocked');
    expect(await completeRecovery(controlDir, second, { machine: TEST_MACHINE, setDatabaseGeneration: () => {} })).toBe('opened');
    expect(readFence(controlDir, TEST_MACHINE)).toMatchObject({ gate: 'open', state: { generation: first.state.next } });
  });

  it('a concurrent second recovery is refused by recovery.lock (75) and changes nothing', async () => {
    const { controlDir } = await fixture();
    await exclusiveHolder(lockPath(controlDir, RECOVERY_LOCK));
    const before = readFence(controlDir, TEST_MACHINE);
    expect(await coded(enterRecovery(controlDir, { env, machine: TEST_MACHINE, kind: 'reinit' }))).toEqual({ code: 'E0I_RECOVERY_BUSY', exitCode: 75 });
    expect(readFence(controlDir, TEST_MACHINE)).toEqual(before);
    expect(readMarker(controlDir)).toMatchObject({ state: 'normal' });
  });

  it('refuses inside a lease before anything (E0I_RECOVERY_IN_LEASE) and keeps recovery.lock free', async () => {
    const { controlDir } = await fixture();
    for (const leaseEnv of [{ HOLDR_LIFECYCLE_LEASE_FD: '3' }, { HOLDR_LIFECYCLE_LEASE: 'ab'.repeat(8) }]) {
      expect((await coded(enterRecovery(controlDir, { env: leaseEnv, machine: TEST_MACHINE, kind: 'reinit' })))?.code).toBe('E0I_RECOVERY_IN_LEASE');
    }
    const fd = tryLock(lockPath(controlDir, RECOVERY_LOCK), 'exclusive');
    expect(fd).not.toBeNull();
    releaseLock(fd);
    expect(readFence(controlDir, TEST_MACHINE)).toMatchObject({ reason: 'blocked:init' });
  });

  it('reinit writes blocked/reinit for this machine, dropping the generation; block keeps it and is idempotent', async () => {
    const { controlDir } = await fixture();
    writeFence(controlDir, fenceState({ gate: 'open', reason: null, generation: G, next: null, op: null, machine: TEST_MACHINE }));
    expect(await blockFence(controlDir, TEST_MACHINE)).toBe('blocked');
    expect(readFence(controlDir, TEST_MACHINE)).toMatchObject({ reason: 'blocked:incident', state: { generation: G } });
    expect(await blockFence(controlDir, TEST_MACHINE)).toBe('already-blocked');
    const entry = await enterRecovery(controlDir, { env, machine: 'fedcba9876543210', kind: 'reinit' });
    cleanups.push(() => entry.recoveryLock.release());
    expect(entry.state).toMatchObject({ gate: 'blocked', reason: 'reinit', generation: null, next: null, op: null, machine: 'fedcba9876543210' });
    expect(readMarker(controlDir)).toMatchObject({ state: 'maintenance', reason: 'reinit' });
    await expect(completeRecovery(controlDir, entry, { machine: 'fedcba9876543210', setDatabaseGeneration: () => {} })).rejects.toMatchObject({ code: 'E0I_INTERNAL' });
  });

  it('block without a computable machine id keeps the fence\'s own machine, and refuses when there is none', async () => {
    const { controlDir } = await fixture();
    expect(await blockFence(controlDir, null)).toBe('blocked');
    expect(readFence(controlDir, TEST_MACHINE)).toMatchObject({ reason: 'blocked:incident', state: { machine: TEST_MACHINE } });
    const empty = await fixture();
    fs.rmSync(path.join(empty.controlDir, FENCE_FILE));
    expect(await coded(blockFence(empty.controlDir, null))).toEqual({ code: 'E0I_MACHINE_ID', exitCode: 1 });
    expect(await blockFence(empty.controlDir, TEST_MACHINE)).toBe('blocked');
  });
});
