import { afterEach, describe, expect, it } from 'vitest';

import { changeWithAuthorizationLockHeld, createAuthorizationGateService, type AuthorizationFenceContext } from '../../control/authorizationChange.js';
import { acquireSharedLease, AUTHORIZATION_LOCK, leaseStillOn, lockPath, withAuthorizationLock } from '../../control/lifecycle.js';
import { blockFence } from '../../control/recovery.js';
import { fenceState, readFence, writeFence } from '../../control/syncAuthState.js';
import { TEST_MACHINE, controlFixture, lockHolder } from '../../control/testControl.js';
import { deviceFingerprint, deviceTokenDigest, pairingCodeDigest, randomCardSyncLetters } from '../../services/cardSyncDigests.js';
import { CardSyncOwnerWorld } from '../../testing/cardSyncOwnerWorld.js';

/**
 * E2b's routes over PR B's real fence and `authorization.lock` (E1b §10 item 2): the gate protocol end to end, a blocked
 * gate, a busy lock, and E2c's redemption as it will run inside PR D's admission (the lock already held). macOS only (the
 * lifecycle locks).
 */

const ORIGIN = 'https://holdr.test';
const cleanups: Array<() => void> = [];
let w: CardSyncOwnerWorld;
afterEach(() => {
  w?.close();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function create() {
  const fixture = await controlFixture();
  cleanups.push(fixture.cleanup);
  const lease = await acquireSharedLease(fixture.controlDir);
  cleanups.push(() => lease.release());
  const logs: string[] = [];
  let ctx!: AuthorizationFenceContext;
  w = await CardSyncOwnerWorld.create({
    authorization: (world) => {
      ctx = { controlDir: fixture.controlDir, machine: TEST_MACHINE, databaseGeneration: () => world.generation(), log: (line) => { logs.push(line); } };
      return { gate: createAuthorizationGateService({ ...ctx, leaseLive: () => leaseStillOn(lease, fixture.controlDir), lockTimeoutMs: 500 }),
        holdrOrigin: ORIGIN, deviceApi: 'enabled' };
    },
  });
  const fence = () => readFence(fixture.controlDir, TEST_MACHINE);
  /** Test setup changes the database directly; this opens the gate at what it holds, as recovery would. */
  const openAtDatabase = () => writeFence(fixture.controlDir, fenceState({
    gate: 'open', reason: null, generation: w.generation(), next: null, op: null, machine: TEST_MACHINE }));
  return { controlDir: fixture.controlDir, ctx, logs, fence, openAtDatabase };
}

const owner = (path: string) => `/card-sync/owner${path}`;

describe.skipIf(process.platform !== 'darwin')('owner authorization routes over the real fence', () => {
  it('moves the fence and the database generation together, change by change, and reports the gate in the state', async () => {
    const t = await create();
    expect((await w.get(owner('/state'))).body.gate).toBe('blocked');
    t.openAtDatabase();
    expect((await w.get(owner('/state'))).body.gate).toBe('open');
    const before = w.generation();
    expect((await w.post(owner('/pause'), {})).status).toBe(200);
    expect(w.generation()).not.toBe(before);
    expect(t.fence()).toMatchObject({ gate: 'open', state: { generation: w.generation() } });
    // A repeat changes nothing and advances nothing.
    const after = w.generation();
    await w.post(owner('/pause'), {});
    expect([w.generation(), t.fence().state?.generation]).toEqual([after, after]);
    expect((await w.get(owner('/state'))).body.gate).toBe('open');
  });

  it('with an incident block: widening refused, narrowing applied and recorded, the gate still blocked', async () => {
    const t = await create();
    w.enable('chase');
    const binding = w.binding();
    const device = w.device([binding.bindingId]);
    t.openAtDatabase();
    await blockFence(t.controlDir, TEST_MACHINE);
    await w.reverify();
    const widening = await w.post(owner('/pairings'), { bindingIds: [binding.bindingId], replacesDeviceId: null });
    expect([widening.status, widening.body]).toEqual([409, { error: 'authorization-blocked' }]);
    const revoked = await w.post(owner(`/devices/${device.deviceId}/revoke`), {});
    expect([revoked.status, revoked.body.status]).toEqual([200, 'revoked']);
    expect(t.fence()).toMatchObject({ gate: 'closed', reason: 'blocked:incident', state: { generation: w.generation() } });
    expect((await w.get(owner('/state'))).body.gate).toBe('blocked');
  });

  it('answers 503 unavailable while another process holds authorization.lock, and changes nothing', async () => {
    const t = await create();
    t.openAtDatabase();
    await lockHolder(lockPath(t.controlDir, AUTHORIZATION_LOCK), 'exclusive', cleanups);
    const before = w.generation();
    const res = await w.post(owner('/pause'), {});
    expect([res.status, res.body, res.headers['retry-after']]).toEqual([503, { error: 'unavailable', retryAfterSeconds: 1 }, '1']);
    expect(w.generation()).toBe(before);
    expect(w.repo.getCardSyncSettings().paused).toBe(false);
  });

  it('redemption with the lock already held (E2c inside PR D\'s admission), then approval through the route', async () => {
    const t = await create();
    w.enable('chase');
    const binding = w.binding();
    t.openAtDatabase();
    await w.reverify();
    const invite = await w.post(owner('/pairings'), { bindingIds: [binding.bindingId], replacesDeviceId: null });
    expect(invite.status).toBe(201);
    const token = `hdv1_${randomCardSyncLetters()}${randomCardSyncLetters()}`;
    const deviceId = `dev_${randomCardSyncLetters()}`;
    const redeemed = await withAuthorizationLock(t.controlDir, () => changeWithAuthorizationLockHeld(t.ctx, 'widening', (step) =>
      w.repo.redeemCardSyncPairing({
        codeDigest: pairingCodeDigest(invite.body.pairingCode), deviceId, tokenDigest: deviceTokenDigest(token),
        fingerprint: deviceFingerprint(token), label: 'Mac Chrome', clientVersion: '1.0.0', ...step,
      })));
    expect(redeemed).toMatchObject({ ok: true, deviceId, authorizationGeneration: w.generation() });
    expect(t.fence()).toMatchObject({ gate: 'open', state: { generation: w.generation() } });
    const approved = await w.post(owner(`/pairings/${invite.body.pairing.pairingId}/approve`), { deviceId, fingerprint: deviceFingerprint(token) });
    expect([approved.status, approved.body.device.status]).toEqual([200, 'active']);
    expect(t.fence()).toMatchObject({ gate: 'open', state: { generation: w.generation() } });
    expect(t.logs).toEqual([]);
  });
});
