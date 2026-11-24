import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthorizationBlockedError, changeWithAuthorizationLockHeld, createAuthorizationGateService, reconcileChangeBlock } from './authorizationChange.js';
import { acquireSharedLease, AUTHORIZATION_LOCK, leaseStillOn, lockPath, marker, releaseLock, tryLock, writeMarker } from './lifecycle.js';
import { fenceState, newGeneration, readFence, writeFence } from './syncAuthState.js';
import { TEST_MACHINE, controlFixture } from './testControl.js';

const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) close(); });

async function fixture() {
  const world = await controlFixture();
  cleanups.push(world.cleanup);
  const lease = await acquireSharedLease(world.controlDir);
  cleanups.push(() => lease.release());
  const db = { generation: newGeneration() };
  const ctx = { controlDir: world.controlDir, machine: TEST_MACHINE, databaseGeneration: () => db.generation, log() {} };
  const open = (generation = db.generation) => writeFence(world.controlDir, fenceState({
    gate: 'open', reason: null, generation, next: null, op: null, machine: TEST_MACHINE,
  }));
  open();
  return { ...world, ctx, lease, db, open };
}

describe.skipIf(process.platform !== 'darwin')('E2b r1 durable incident and queued lifecycle boundaries', () => {
  it.each(['refusal', 'no-op', 'commit'] as const)('latches an inconsistency before a narrowing %s and before later rollback', async (outcome) => {
    const f = await fixture();
    const saved = f.db.generation;
    f.db.generation = newGeneration();
    const call = () => changeWithAuthorizationLockHeld(f.ctx, 'narrowing', (step) => {
      expect(readFence(f.controlDir, TEST_MACHINE).state?.reason).toBe('incident');
      if (outcome === 'refusal') throw Error('synthetic refusal');
      if (outcome === 'commit') f.db.generation = step.nextGeneration;
      return { authorizationGeneration: f.db.generation };
    });
    if (outcome === 'refusal') expect(call).toThrow('synthetic refusal');
    else call();
    f.db.generation = saved;
    expect(reconcileChangeBlock(f.ctx)).toBe(false);
    expect(readFence(f.controlDir, TEST_MACHINE).state?.reason).toBe('incident');
  });

  it('startup latches a mismatch, and a widening refusal cannot forget it', async () => {
    const f = await fixture();
    const saved = f.db.generation;
    f.db.generation = newGeneration();
    expect(reconcileChangeBlock(f.ctx)).toBe(false);
    expect(() => changeWithAuthorizationLockHeld(f.ctx, 'widening', () => {
      throw Error('must not call');
    })).toThrow(AuthorizationBlockedError);
    f.db.generation = saved;
    expect(reconcileChangeBlock(f.ctx)).toBe(false);
    expect(readFence(f.controlDir, TEST_MACHINE).state?.reason).toBe('incident');
  });

  it('a failed incident fsync cannot be swallowed and followed by a repository mutation', async () => {
    const f = await fixture();
    f.db.generation = newGeneration();
    const call = vi.fn(() => ({ authorizationGeneration: f.db.generation }));
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw Error('synthetic storage failure'); });
    expect(() => changeWithAuthorizationLockHeld(f.ctx, 'narrowing', call)).toThrow();
    expect(call).not.toHaveBeenCalled();
  });

  it.each(['marker', 'lease'] as const)('revalidates the %s after a widening request waited for the host lock', async (which) => {
    const f = await fixture();
    const fd = tryLock(lockPath(f.controlDir, AUTHORIZATION_LOCK), 'exclusive');
    expect(fd).not.toBeNull();
    const gate = createAuthorizationGateService({
      ...f.ctx, leaseLive: () => leaseStillOn(f.lease, f.controlDir), lockTimeoutMs: 500,
    });
    const call = vi.fn((step: { nextGeneration: string }) => {
      f.db.generation = step.nextGeneration;
      return { authorizationGeneration: f.db.generation };
    });
    const pending = gate.change('widening', call);
    const refused = expect(pending).rejects.toBeInstanceOf(AuthorizationBlockedError);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (which === 'marker') writeMarker(f.controlDir, marker({ state: 'maintenance', reason: 'test' }, 'test'));
      else f.lease.release();
    } finally { releaseLock(fd); }
    await refused;
    expect(call).not.toHaveBeenCalled();
    await gate.change('narrowing', call);
    expect(call).toHaveBeenCalledOnce();
  });
});
