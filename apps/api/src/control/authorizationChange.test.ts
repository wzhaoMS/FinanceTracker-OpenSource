import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { cardSyncRefusal, cardSyncRefusalCode } from '../services/cardSync/refusals.js';
import {
  AuthorizationBlockedError, changeWithAuthorizationLockHeld, createAuthorizationGateService, gateView, reconcileChangeBlock,
  unwiredAuthorizationGateService, type AuthorizationChangeKind, type AuthorizationFenceContext, type GenerationStep,
} from './authorizationChange.js';
import { ControlError } from './errors.js';
import { AUTHORIZATION_LOCK, lockPath } from './lifecycle.js';
import { FENCE_FILE, fenceState, newGeneration, parseFence, writeFence, type FenceState } from './syncAuthState.js';
import { TEST_MACHINE, controlFixture, lockHolder } from './testControl.js';
import { writePrivate } from './testDirs.js';

/**
 * E1b §10 item 2's generation protocol over PR B's fence: the open path (blocked/change first, the compare-and-set, open
 * again only if the fence is still ours), every blocked state against widening and narrowing changes, the startup rule, and
 * the API service around it (the lock, the in-process order, the lease, the unwired dev gate). The repository is a stand-in
 * with the same compare-and-set every E1b authorization change performs.
 */

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const OTHER_MACHINE = 'fedcba9876543210';
type FenceFields = Partial<Omit<FenceState, 'format' | 'updatedAt'>>;

async function world() {
  const fixture = await controlFixture();
  cleanups.push(fixture.cleanup);
  const db = { generation: newGeneration() };
  const logs: string[] = [];
  const ctx: AuthorizationFenceContext = {
    controlDir: fixture.controlDir, machine: TEST_MACHINE, databaseGeneration: () => db.generation, log: (line) => { logs.push(line); },
  };
  const file = path.join(fixture.controlDir, FENCE_FILE);
  const bytes = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  const fence = () => parseFence(fs.readFileSync(file));
  const setFence = (fields: FenceFields) => writeFence(fixture.controlDir, fenceState({
    gate: 'blocked', reason: 'init', generation: null, next: null, op: null, machine: TEST_MACHINE, ...fields,
  }));
  const open = (generation = db.generation) => setFence({ gate: 'open', reason: null, generation });
  let calls = 0;
  /** A stand-in repository method: compare-and-set of the generation, as every E1b authorization change does. */
  const cas = (changes = true) => (step: GenerationStep) => {
    calls += 1;
    if (step.expectedGeneration !== db.generation) throw cardSyncRefusal('generation-mismatch');
    if (changes) db.generation = step.nextGeneration;
    return { changed: changes, authorizationGeneration: db.generation };
  };
  return { ...fixture, db, ctx, logs, file, bytes, fence, setFence, open, cas, calls: () => calls };
}

/** Every blocked fence a change can meet, set up on a fresh world. */
const BLOCKED: Array<[string, (w: Awaited<ReturnType<typeof world>>) => void]> = [
  ['init', (w) => w.setFence({})],
  ['reinit', (w) => w.setFence({ reason: 'reinit' })],
  ['incident keeping the generation', (w) => w.setFence({ reason: 'incident', generation: w.db.generation })],
  ['incident without a generation', (w) => w.setFence({ reason: 'incident' })],
  ['recovery', (w) => w.setFence({ reason: 'recovery', generation: w.db.generation, next: newGeneration(), op: '0123456789abcdef' })],
  ['an unfinished change the database never reached', (w) => w.setFence({
    reason: 'change', generation: w.db.generation, next: newGeneration(), op: '0123456789abcdef' })],
  ['missing', (w) => fs.rmSync(w.file)],
  ['invalid', (w) => { fs.rmSync(w.file); writePrivate(w.file, '{"format":"nope"}\n'); }],
  ['another machine', (w) => writeFence(w.controlDir, fenceState({
    gate: 'open', reason: null, generation: w.db.generation, next: null, op: null, machine: OTHER_MACHINE }))],
  ['open with a generation the database does not hold', (w) => w.open(newGeneration())],
];

describe.skipIf(process.platform !== 'darwin')('the generation protocol with authorization.lock held (E1b §10 item 2)', () => {
  it.each<AuthorizationChangeKind>(['widening', 'narrowing'])('%s through an open gate: blocked/change first, then open at the new generation', async (kind) => {
    const w = await world();
    w.open();
    const G = w.db.generation;
    let during: FenceState | null = null;
    let step: GenerationStep | null = null;
    const result = changeWithAuthorizationLockHeld(w.ctx, kind, (given) => {
      during = w.fence();
      step = given;
      return w.cas()(given);
    });
    expect(step).toMatchObject({ expectedGeneration: G });
    expect(during).toMatchObject({ gate: 'blocked', reason: 'change', generation: G, next: step!.nextGeneration, machine: TEST_MACHINE });
    expect(during!.op).toMatch(/^[0-9a-f]{16}$/);
    expect(result).toEqual({ changed: true, authorizationGeneration: step!.nextGeneration });
    expect(w.fence()).toMatchObject({ gate: 'open', reason: null, generation: step!.nextGeneration, next: null, op: null });
    expect(w.logs).toEqual([]);
  });

  it('a change that changes nothing, or is refused, reopens at the old generation; the refusal goes on unchanged', async () => {
    const w = await world();
    w.open();
    const G = w.db.generation;
    expect(changeWithAuthorizationLockHeld(w.ctx, 'widening', w.cas(false))).toEqual({ changed: false, authorizationGeneration: G });
    expect(w.fence()).toMatchObject({ gate: 'open', generation: G });
    const refusal = cardSyncRefusal('version-conflict');
    expect(() => changeWithAuthorizationLockHeld(w.ctx, 'narrowing', () => { throw refusal; })).toThrow(refusal);
    expect(w.fence()).toMatchObject({ gate: 'open', generation: G });
    expect(w.db.generation).toBe(G);
  });

  it('a result from redemption (no CardSyncAuthChange) reopens at whatever the database holds afterwards', async () => {
    const w = await world();
    w.open();
    const G = w.db.generation;
    // An early failed guess changes nothing; the fifth, which locks the pairing, advances (E1b §5.3, Q45).
    expect(changeWithAuthorizationLockHeld(w.ctx, 'widening', () => ({ ok: false, code: 'pairing-invalid', authorizationGeneration: G })))
      .toMatchObject({ ok: false });
    expect(w.fence()).toMatchObject({ gate: 'open', generation: G });
    const locked = changeWithAuthorizationLockHeld(w.ctx, 'widening', (step) => {
      w.db.generation = step.nextGeneration;
      return { ok: false, code: 'pairing-locked', authorizationGeneration: w.db.generation };
    });
    expect(w.fence()).toMatchObject({ gate: 'open', generation: locked.authorizationGeneration });
    expect(locked.authorizationGeneration).not.toBe(G);
  });

  it('leaves a fence that changed during the change as found (compare-and-swap on op)', async () => {
    const w = await world();
    w.open();
    changeWithAuthorizationLockHeld(w.ctx, 'narrowing', (step) => {
      // A writer that ignored the lock: an operator's incident block lands in the middle.
      w.setFence({ reason: 'incident', generation: w.db.generation });
      return w.cas()(step);
    });
    expect(w.fence()).toMatchObject({ gate: 'blocked', reason: 'incident' });
    expect(w.logs.join('\n')).toMatch(/left as found/);
  });

  it('keeps blocked/change when the database generation afterwards is neither the old nor the new one, or disagrees with the result', async () => {
    const w = await world();
    w.open();
    changeWithAuthorizationLockHeld(w.ctx, 'narrowing', () => {
      w.db.generation = newGeneration();
      return { changed: true, authorizationGeneration: w.db.generation };
    });
    expect(w.fence()).toMatchObject({ gate: 'blocked', reason: 'change' });
    const second = await world();
    second.open();
    changeWithAuthorizationLockHeld(second.ctx, 'widening', (step) => {
      second.db.generation = step.nextGeneration;
      return { changed: true, authorizationGeneration: step.expectedGeneration };
    });
    expect(second.fence()).toMatchObject({ gate: 'blocked', reason: 'change' });
    expect(second.logs.join('\n')).toMatch(/stays blocked \(change\)/);
  });

  it.each(BLOCKED)('a widening change with the gate blocked (%s) is refused before the repository, latching only a mismatch', async (name, set) => {
    const w = await world();
    set(w);
    const before = w.bytes();
    expect(() => changeWithAuthorizationLockHeld(w.ctx, 'widening', w.cas())).toThrow(AuthorizationBlockedError);
    expect(w.calls()).toBe(0);
    if (name.startsWith('open with')) expect(w.fence()).toMatchObject({ gate: 'blocked', reason: 'incident', generation: w.db.generation });
    else expect(w.bytes()).toBe(before);
  });

  it.each(BLOCKED)('a narrowing change with the gate blocked (%s) runs on the database generation and keeps the gate blocked', async (name, set) => {
    const w = await world();
    set(w);
    const before = w.bytes();
    const G = w.db.generation;
    const result = changeWithAuthorizationLockHeld(w.ctx, 'narrowing', w.cas());
    expect(result.changed).toBe(true);
    expect(w.db.generation).not.toBe(G);
    if (name.startsWith('incident') || name.startsWith('open with')) {
      // Recorded, still blocked: an incident (or the disagreement, now an incident) names the database's new generation.
      expect(w.fence()).toMatchObject({ gate: 'blocked', reason: 'incident', generation: w.db.generation, machine: TEST_MACHINE });
    } else {
      expect(w.bytes()).toBe(before);
    }
    expect(gateView(w.ctx).gate).toBe('blocked');
  });

  it('a narrowing change refused while blocked writes nothing and rethrows', async () => {
    const w = await world();
    w.setFence({ reason: 'incident', generation: w.db.generation });
    const before = w.bytes();
    const refusal = cardSyncRefusal('not-found');
    expect(() => changeWithAuthorizationLockHeld(w.ctx, 'narrowing', () => { throw refusal; })).toThrow(refusal);
    expect(w.bytes()).toBe(before);
  });

  it('the startup rule: a change block reopens only when the database holds exactly its next, before the next change runs', async () => {
    const w = await world();
    const G = w.db.generation;
    const N = newGeneration();
    w.setFence({ reason: 'change', generation: G, next: N, op: '0123456789abcdef' });
    // The database never reached N (the change was refused, or the process died first): stays blocked until recovery.
    expect(reconcileChangeBlock(w.ctx)).toBe(false);
    expect(w.fence()).toMatchObject({ reason: 'change' });
    // It did reach N: the change committed, only the last fence write was lost.
    w.db.generation = N;
    expect(reconcileChangeBlock(w.ctx)).toBe(true);
    expect(w.fence()).toMatchObject({ gate: 'open', generation: N });
    // And inside a change, before it starts.
    w.setFence({ reason: 'change', generation: G, next: N, op: '0123456789abcdef' });
    const result = changeWithAuthorizationLockHeld(w.ctx, 'widening', w.cas());
    expect(result.authorizationGeneration).not.toBe(N);
    expect(w.fence()).toMatchObject({ gate: 'open', generation: result.authorizationGeneration });
    expect(w.logs.join('\n')).toMatch(/committed; the gate is open again/);
  });

  it('with no machine id: narrowing runs and nothing is written; widening is refused', async () => {
    const w = await world();
    w.open();
    const before = w.bytes();
    const ctx = { ...w.ctx, machine: null };
    expect(() => changeWithAuthorizationLockHeld(ctx, 'widening', w.cas())).toThrow(AuthorizationBlockedError);
    expect(changeWithAuthorizationLockHeld(ctx, 'narrowing', w.cas()).changed).toBe(true);
    expect(w.bytes()).toBe(before);
    expect(reconcileChangeBlock(ctx)).toBe(false);
  });

  it('gateView: open only for this machine and the generation the database holds', async () => {
    const w = await world();
    expect(gateView(w.ctx)).toMatchObject({ gate: 'blocked', block: 'blocked:init' });
    w.open();
    expect(gateView(w.ctx)).toMatchObject({ gate: 'open', generation: w.db.generation });
    w.db.generation = newGeneration();
    expect(gateView(w.ctx)).toMatchObject({ gate: 'blocked', block: 'inconsistent' });
    expect(gateView({ ...w.ctx, databaseGeneration: () => { throw new Error('closed'); } })).toMatchObject({ gate: 'blocked', block: 'unknown' });
  });
});

describe.skipIf(process.platform !== 'darwin')('the API gate service (authorization.lock, in-process order, lease)', () => {
  it('takes authorization.lock: another holder makes a change wait, then fail busy without calling the repository', async () => {
    const w = await world();
    w.open();
    await lockHolder(lockPath(w.controlDir, AUTHORIZATION_LOCK), 'exclusive', cleanups);
    const gate = createAuthorizationGateService({ ...w.ctx, lockTimeoutMs: 300 });
    const error = await gate.change('narrowing', w.cas()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ControlError);
    expect((error as ControlError).code).toBe('E0I_AUTHORIZATION_BUSY');
    expect(w.calls()).toBe(0);
    expect(w.fence()).toMatchObject({ gate: 'open' });
  });

  it('runs this process\'s changes one after another, each from the generation the last one left', async () => {
    const w = await world();
    w.open();
    const gate = createAuthorizationGateService({ ...w.ctx, leaseLive: () => true });
    const seen: string[] = [];
    const results = await Promise.all([1, 2, 3].map(() => gate.change('widening', (step) => {
      seen.push(step.expectedGeneration);
      return w.cas()(step);
    })));
    expect(new Set(seen).size).toBe(3);
    expect(results.at(-1)!.authorizationGeneration).toBe(w.db.generation);
    expect(w.fence()).toMatchObject({ gate: 'open', generation: w.db.generation });
    expect(gate.status()).toBe('open');
    expect(gate.generationForSourceChecks()).toBe(w.db.generation);
  });

  it('refuses a widening change once the lifecycle lease is gone; narrowing ones still run', async () => {
    const w = await world();
    w.open();
    const gate = createAuthorizationGateService({ ...w.ctx, leaseLive: () => false });
    await expect(gate.change('widening', w.cas())).rejects.toBeInstanceOf(AuthorizationBlockedError);
    expect(w.calls()).toBe(0);
    await expect(gate.change('narrowing', w.cas())).resolves.toMatchObject({ changed: true });
  });

  it('reports blocked for sources and state while the gate is blocked or disagrees with the database; reconcile() applies the startup rule', async () => {
    const w = await world();
    const gate = createAuthorizationGateService(w.ctx);
    expect([gate.status(), gate.generationForSourceChecks()]).toEqual(['blocked', null]);
    const N = newGeneration();
    w.setFence({ reason: 'change', generation: w.db.generation, next: N, op: '0123456789abcdef' });
    w.db.generation = N;
    await expect(gate.reconcile()).resolves.toBe(true);
    expect([gate.status(), gate.generationForSourceChecks()]).toEqual(['open', N]);
    w.db.generation = newGeneration();
    expect([gate.status(), gate.generationForSourceChecks()]).toEqual(['blocked', null]);
  });
});

describe('the unwired gate (no control dir: dev)', () => {
  it('is always blocked: widening refused, narrowing compares-and-sets the database generation, once more after a race', async () => {
    const db = { generation: newGeneration() };
    const gate = unwiredAuthorizationGateService({ databaseGeneration: () => db.generation });
    expect([gate.wired, gate.status(), gate.generationForSourceChecks()]).toEqual([false, 'blocked', null]);
    await expect(gate.change('widening', () => ({ authorizationGeneration: db.generation }))).rejects.toBeInstanceOf(AuthorizationBlockedError);
    let attempts = 0;
    const raced = await gate.change('narrowing', (step) => {
      attempts += 1;
      // Another process moves the generation between our read and our write, once.
      if (attempts === 1) {
        db.generation = newGeneration();
        throw cardSyncRefusal('generation-mismatch');
      }
      if (step.expectedGeneration !== db.generation) throw cardSyncRefusal('generation-mismatch');
      db.generation = step.nextGeneration;
      return { authorizationGeneration: db.generation };
    });
    expect([attempts, raced.authorizationGeneration]).toEqual([2, db.generation]);
    const twice = await gate.change('narrowing', () => { throw cardSyncRefusal('generation-mismatch'); }).catch((error: unknown) => error);
    expect(cardSyncRefusalCode(twice)).toBe('generation-mismatch');
    await expect(gate.reconcile()).resolves.toBe(false);
  });
});
