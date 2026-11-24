import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { marker, readMarker, writeMarker } from '../../control/lifecycle.js';
import { fenceState, newGeneration, readFence, writeFence } from '../../control/syncAuthState.js';
import { TEST_MACHINE } from '../../control/testControl.js';
import type { AuthorizationEffectGuard } from '../../control/authorizationChange.js';
import { createDeviceRouter } from '../../ingress/deviceRouter.js';
import { cardSyncDeviceWorld } from '../../testing/cardSyncDeviceWorld.js';
import { SCENARIO_OWNER } from '../../testing/cardSyncScenario.js';
import { deviceTokenDigest, pairingCodeDigest, randomCardSyncLetters } from '../../services/cardSyncDigests.js';
import * as responses from './deviceResponses.js';

describe.skipIf(process.platform !== 'darwin')('generation-transition-aware pairing effects', () => {
  let f: Awaited<ReturnType<typeof cardSyncDeviceWorld>>;
  let code: string;
  let pairingId: string;
  let originalGeneration: string;
  beforeEach(async () => {
    f = await cardSyncDeviceWorld();
    f.w.enable();
    const binding = f.w.binding();
    code = randomCardSyncLetters();
    pairingId = f.repo.createCardSyncPairing({
      actorRef: SCENARIO_OWNER, codeDigest: pairingCodeDigest(code), bindingIds: [binding.bindingId],
      replacesDeviceId: null, ...f.w.step(),
    }).value.pairingId;
    await f.syncFence();
    originalGeneration = f.w.generation();
  });
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });
  const redeem = () => f.request('POST', '/card-sync/pairings/redeem', { clientVersion: '1.2.3', deviceLabel: 'Synthetic Chrome' }, [
    ['Authorization', `HoldrPair ${code}`], ['X-Holdr-Client', 'extension-v1'],
  ]);
  function close(which: 'marker' | 'attestation' | 'lease' | 'generation' | 'fence') {
    if (which === 'marker') writeMarker(f.controlDir, marker({ state: 'maintenance', reason: 'deploy' }, 'test'));
    if (which === 'attestation') f.setRefusal('ingress-unverified');
    if (which === 'lease') f.releaseLease();
    if (which === 'generation') f.w.db.prepare("UPDATE card_sync_policy SET authorization_generation = ? WHERE id = 'card-sync-policy'")
      .run(newGeneration());
    if (which === 'fence') writeFence(f.controlDir, fenceState({
      gate: 'blocked', reason: 'incident', generation: f.w.generation(), next: null, op: null, machine: TEST_MACHINE,
    }));
  }

  it.each(['marker', 'attestation', 'lease', 'generation', 'fence'] as const)(
    'rolls back a redemption if %s changes inside its transaction before commit', async (which) => {
      const original = f.repo.redeemCardSyncPairing.bind(f.repo);
      let sawUncommittedDevice = false;
      vi.spyOn(f.repo, 'redeemCardSyncPairing').mockImplementation((input, checks) => original(input, {
        before: () => checks!.before(),
        after: (result) => {
          expect(f.w.db.inTransaction).toBe(true);
          sawUncommittedDevice = f.repo.getCardSyncDevice(input.deviceId)?.status === 'pending';
          close(which);
          checks!.after(result);
        },
      }));
      const response = await redeem();
      expect(sawUncommittedDevice).toBe(true);
      expect(response.status).toBe(which === 'attestation' ? 503 : 409);
      expect(response.json).not.toHaveProperty('deviceToken');
      expect(f.repo.listCardSyncDevices()).toHaveLength(0);
      expect(f.repo.getCardSyncPairing(pairingId)!.status).toBe('open');
      expect(f.w.generation()).toBe(originalGeneration);
      expect(readFence(f.controlDir, TEST_MACHINE).gate).toBe('closed');
    },
  );

  it.each(['marker', 'attestation', 'lease'] as const)(
    'refuses before reopening after a post-commit %s loss and compensates without reacquiring locks', async (which) => {
      const original = f.repo.redeemCardSyncPairing.bind(f.repo);
      let created = false;
      let issuedId = '';
      let digest = '';
      vi.spyOn(f.repo, 'redeemCardSyncPairing').mockImplementation((...args) => {
        const result = original(...args);
        created = result.ok;
        issuedId = args[0].deviceId;
        digest = args[0].tokenDigest;
        return result;
      });
      const read = f.authorization.databaseGeneration;
      let injected = false;
      vi.spyOn(f.authorization, 'databaseGeneration').mockImplementation(() => {
        const value = read();
        if (created && !injected) { injected = true; close(which); }
        return value;
      });
      const response = await redeem();
      expect(injected).toBe(true);
      expect(response.status).toBe(which === 'attestation' ? 503 : 409);
      expect(response.json).not.toHaveProperty('deviceToken');
      expect(f.repo.getCardSyncDevice(issuedId)).toMatchObject({ status: 'revoked', revokeReason: 'rejected' });
      expect(f.repo.findCardSyncDeviceByTokenDigest(digest)).toBeNull();
      expect(f.repo.getCardSyncPairing(pairingId)!.status).toBe('cancelled');
      expect(readFence(f.controlDir, TEST_MACHINE).gate).toBe('closed');
      expect(f.logs.some((line) => line.includes('cleanup failed'))).toBe(false);
    },
  );

  it.each(['marker', 'attestation', 'lease'] as const)(
    'rechecks immediately before bearer delivery after a %s loss', async (which) => {
      const send = responses.pairingReply;
      let digest = '';
      let id = '';
      vi.spyOn(responses, 'pairingReply').mockImplementation((res, value, beforeSend) => {
        id = value.deviceId;
        digest = deviceTokenDigest(value.deviceToken);
        expect(readFence(f.controlDir, TEST_MACHINE).gate).toBe('open');
        close(which);
        send(res, value, beforeSend);
      });
      const response = await redeem();
      expect(response.status).toBe(which === 'attestation' ? 503 : 409);
      expect(response.json).not.toHaveProperty('deviceToken');
      expect(f.repo.findCardSyncDeviceByTokenDigest(digest)).toBeNull();
      expect(f.repo.getCardSyncDevice(id)).toMatchObject({ status: 'revoked', revokeReason: 'rejected' });
      expect(readFence(f.controlDir, TEST_MACHINE).gate).toBe('closed');
    },
  );

  it('cleanup preserves an unrelated recovery block and is idempotent', async () => {
    const send = responses.pairingReply;
    let id = '';
    let digest = '';
    let external: ReturnType<typeof fenceState>;
    vi.spyOn(responses, 'pairingReply').mockImplementation((res, value, beforeSend) => {
      id = value.deviceId;
      digest = deviceTokenDigest(value.deviceToken);
      external = fenceState({
        gate: 'blocked', reason: 'recovery', generation: f.w.generation(), next: newGeneration(),
        op: 'f'.repeat(16), machine: TEST_MACHINE,
      });
      writeFence(f.controlDir, external);
      send(res, value, beforeSend);
    });
    expect((await redeem()).status).toBe(409);
    expect(readFence(f.controlDir, TEST_MACHINE).state).toEqual(external!);
    const generation = f.w.generation();
    const repeated = f.repo.cancelPendingCardSyncRedemption({ deviceId: id, tokenDigest: digest, ...f.w.step() });
    expect(repeated).toEqual({ changed: false, authorizationGeneration: generation });
    expect(readFence(f.controlDir, TEST_MACHINE).state).toEqual(external!);
  });

  it('cleanup cannot revoke a different digest or an active device', async () => {
    const response = await redeem();
    expect(response.status).toBe(200);
    const id = response.json.deviceId as string;
    const digest = deviceTokenDigest(response.json.deviceToken);
    expect(f.repo.cancelPendingCardSyncRedemption({
      deviceId: id, tokenDigest: deviceTokenDigest(`hdv1_${'p'.repeat(64)}`), ...f.w.step(),
    }).changed).toBe(false);
    f.repo.approveCardSyncPairing({
      pairingId, deviceId: id, fingerprint: (response.json.fingerprint as string).replace(/-/g, ''),
      actorRef: SCENARIO_OWNER, ...f.w.step(),
    });
    expect(f.repo.cancelPendingCardSyncRedemption({ deviceId: id, tokenDigest: digest, ...f.w.step() }).changed).toBe(false);
    expect(f.repo.findCardSyncDeviceByTokenDigest(digest)?.status).toBe('active');
  });

  it('rolls back the fifth bad guess when admission is lost inside the failed-guess transaction', async () => {
    const badGuess = () => f.request('POST', '/card-sync/pairings/redeem', { clientVersion: '1.2.3', deviceLabel: 'Synthetic Chrome' }, [
      ['Authorization', `HoldrPair ${randomCardSyncLetters()}`], ['X-Holdr-Client', 'extension-v1'],
    ]);
    for (let i = 0; i < 4; i++) expect((await badGuess()).status).toBe(401);
    const generation = f.w.generation();
    const original = f.repo.redeemCardSyncPairing.bind(f.repo);
    vi.spyOn(f.repo, 'redeemCardSyncPairing').mockImplementation((input, checks) => original(input, {
      before: () => checks!.before(),
      after: (result) => {
        expect(result).toMatchObject({ ok: false, code: 'pairing-locked' });
        expect(f.repo.getCardSyncPairing(pairingId)!.failedAttempts).toBe(5);
        f.releaseLease();
        checks!.after(result);
      },
    }));
    expect((await badGuess()).status).toBe(409);
    expect(f.repo.getCardSyncPairing(pairingId)!.failedAttempts).toBe(4);
    expect(f.w.generation()).toBe(generation);
    expect(f.repo.listCardSyncDevices()).toHaveLength(0);
  });

  it('a matching G/N never permits mutation under another change operation', async () => {
    let other: ReturnType<typeof fenceState>;
    f.deviceMount!.router.use(createDeviceRouter(f.admission, [{
      method: 'get', path: '/transition-op-proof',
      handle: (_req, _res, admitted) => {
        const before = readFence(f.controlDir, TEST_MACHINE).state!;
        const change = fenceState({
          gate: 'blocked', reason: 'change', generation: admitted.generation, next: newGeneration(),
          op: 'a'.repeat(16), machine: TEST_MACHINE,
        });
        const guard = admitted.generationChange({ controlDir: f.controlDir, before, change });
        guard.beforeBlock();
        other = fenceState({ ...change, op: 'b'.repeat(16) });
        writeFence(f.controlDir, other);
        guard.beforeMutation();
        throw Error('a different operation must not authorize work');
      },
    }]));
    expect((await f.request('GET', '/card-sync/transition-op-proof')).status).toBe(409);
    expect(readFence(f.controlDir, TEST_MACHINE).state).toEqual(other!);
  });

  it('transition authority is request-bound, exact-op-only and unavailable after the callback', async () => {
    let escaped!: AuthorizationEffectGuard;
    f.deviceMount!.router.use(createDeviceRouter(f.admission, [{
      method: 'get', path: '/transition-proof',
      handle: (_req, res, admitted) => {
        const before = readFence(f.controlDir, TEST_MACHINE).state!;
        const change = fenceState({
          gate: 'blocked', reason: 'change', generation: admitted.generation, next: newGeneration(),
          op: 'a'.repeat(16), machine: TEST_MACHINE,
        });
        const plan = { controlDir: f.controlDir, before, change };
        expect(() => admitted.generationChange({ ...plan, change: fenceState({ ...change, reason: 'recovery' }) })).toThrow();
        expect(() => admitted.generationChange({ ...plan, controlDir: `${f.controlDir}-other` })).toThrow();
        const guard = admitted.generationChange(plan);
        guard.beforeBlock();
        writeFence(f.controlDir, change);
        expect(() => admitted.assertCurrent()).toThrow('authorization-blocked');
        guard.beforeMutation();
        guard.afterMutation(admitted.generation);
        const opened = fenceState({ ...before });
        guard.beforeOpen(opened);
        writeFence(f.controlDir, opened);
        guard.assertCurrent();
        expect(() => admitted.generationChange({ ...plan, before: opened })).toThrow('authorization-blocked');
        escaped = guard;
        res.json({ ok: true });
      },
    }]));
    expect((await f.request('GET', '/card-sync/transition-proof')).status).toBe(200);
    expect(() => escaped.assertCurrent()).toThrow('authorization-blocked');
    expect(readMarker(f.controlDir)?.state).toBe('normal');
  });
});
