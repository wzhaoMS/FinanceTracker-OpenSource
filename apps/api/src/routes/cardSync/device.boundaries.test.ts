import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, CARD_SYNC_V2_MAX_BYTES, type CardSyncPayloadV2, type JsonValue } from '@finance-tracker/shared';
import { createApp } from '../../app.js';
import { marker, writeMarker } from '../../control/lifecycle.js';
import { readFence } from '../../control/syncAuthState.js';
import { TEST_MACHINE } from '../../control/testControl.js';
import { releaseFixture } from '../../ingress/fixtures.js';
import { newCardSyncId, pairingCodeDigest, randomCardSyncLetters } from '../../services/cardSyncDigests.js';
import type { CardSourceBindingView } from '../../services/sqliteStateRepo.js';
import { cardSyncDeviceWorld } from '../../testing/cardSyncDeviceWorld.js';
import { SCENARIO_OWNER, type ScenarioDevice, type ScenarioRow } from '../../testing/cardSyncScenario.js';
import { assertDeviceRoutesGuarded } from '../../testing/deviceRoutes.js';
import { DEVICE_EXTENSION_ORIGINS } from './deviceCors.js';
import * as protocol from './deviceProtocol.js';

describe.skipIf(process.platform !== 'darwin')('E2c device effect and protocol boundaries', () => {
  let f: Awaited<ReturnType<typeof cardSyncDeviceWorld>>;
  let binding: CardSourceBindingView;
  let device: ScenarioDevice;
  beforeEach(async () => {
    f = await cardSyncDeviceWorld();
    f.w.enable();
    binding = f.w.binding();
    device = f.w.device([binding.bindingId]);
    await f.syncFence();
  });
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });
  const headers = (key?: string) => [
    ...f.deviceHeaders(device.token), ...(key ? [['Idempotency-Key', key] as [string, string]] : []),
  ];
  const row = (): ScenarioRow => ({
    scope: f.w.scopes(binding).known[0], date: '2026-10-01', amount: 1250, description: 'Synthetic café', id: 'synthetic-stable-row',
  });
  const body = (payload: CardSyncPayloadV2, runId: string) =>
    Buffer.from(`{"payload":${canonicalJson(payload as unknown as JsonValue)},"runId":"${runId}"}`);
  async function open() {
    const clientRunId = `crn_${randomCardSyncLetters()}`;
    const request = {
      clientRunId, bindingId: binding.bindingId, bindingVersion: binding.bindingVersion,
      adapterVersion: 'holdr-ext@0.1.0', contractVersion: 1, trigger: 'manual',
    };
    const result = await f.request('POST', '/card-sync/runs', request, headers(clientRunId));
    expect(result.status, result.bytes.toString()).toBe(200);
    return { runId: result.json.runId as string, clientRunId, request };
  }
  async function upload(rows = [row()]) {
    const run = await open();
    const payload = f.w.payload(binding, rows);
    const wire = body(payload, run.runId);
    const reply = await f.request('POST', '/card-sync/observations', wire, headers(run.clientRunId));
    expect(reply.status, reply.bytes.toString()).toBe(200);
    return { ...run, wire, payload, setId: reply.json.observationSetId as string, reply };
  }

  it.each(['dev', 'local'] as const)('enumerates no device endpoints or staged mount in %s', (mode) => {
    const release = releaseFixture();
    try {
      const app = createApp({
        repo: f.repo, serviceToken: 'be'.repeat(32), allowedOrigins: [], snapshotsEnabled: false,
        ingress: mode === 'dev' ? { mode } : { mode, ingressPort: 5316, release: release.release, admission: { refusal: () => null } },
      });
      expect(app.deviceMount).toBeUndefined();
      expect(assertDeviceRoutesGuarded(app.app, { requireDeviceRoutes: false, expected: [] })).toEqual([]);
    } finally { release.cleanup(); }
  });

  it('every endpoint and OPTIONS refuses before credential resolution when attestation closes', async () => {
    const lookup = vi.spyOn(f.repo, 'findCardSyncDeviceByTokenDigest');
    const redeem = vi.spyOn(f.repo, 'redeemCardSyncPairing');
    const touch = vi.spyOn(f.repo, 'touchCardSyncDevice');
    f.setRefusal('ingress-refused');
    for (const endpoint of protocol.DEVICE_ENDPOINTS) {
      const path = `/card-sync${endpoint.path.replace(':runId', newCardSyncId('run_'))}`;
      const result = await f.request(endpoint.method.toUpperCase(), path, endpoint.method === 'post' ? {} : undefined, headers());
      expect(result.status).toBe(503);
      expect(result.json).toEqual({ error: 'ingress-refused' });
      const options = await f.request('OPTIONS', path, undefined, [
        ['Origin', DEVICE_EXTENSION_ORIGINS[0]], ['Access-Control-Request-Method', endpoint.method.toUpperCase()],
        ['Access-Control-Request-Headers', 'authorization,x-holdr-client,x-holdr-client-version'],
      ]);
      expect(options.status).toBe(503);
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(redeem).not.toHaveBeenCalled();
    expect(touch).not.toHaveBeenCalled();
  });

  it.each(['attestation', 'marker', 'lease'] as const)('rechecks a changed %s before even the last-used write', async (changed) => {
    const read = f.repo.getCardSyncDevice.bind(f.repo);
    vi.spyOn(f.repo, 'getCardSyncDevice').mockImplementationOnce((id) => {
      const result = read(id);
      if (changed === 'attestation') f.setRefusal('ingress-unverified');
      if (changed === 'marker') writeMarker(f.controlDir, marker({ state: 'maintenance', reason: 'recovery' }, 'test'));
      if (changed === 'lease') f.releaseLease();
      return result;
    });
    const touch = vi.spyOn(f.repo, 'touchCardSyncDevice');
    const result = await f.request('GET', '/card-sync/capabilities', undefined, headers());
    expect(result.status).toBe(changed === 'attestation' ? 503 : 409);
    expect(touch).not.toHaveBeenCalled();
    expect(f.logs.some((line) => line.includes('device request failed'))).toBe(false);
  });

  it('rechecks after E1a validation and does not accept or record a refusal under a newly closed gate', async () => {
    const opened = await open();
    const parse = protocol.parseDeviceUpload;
    vi.spyOn(protocol, 'parseDeviceUpload').mockImplementationOnce((bytes) => {
      const parsed = parse(bytes);
      writeMarker(f.controlDir, marker({ state: 'maintenance', reason: 'recovery' }, 'test'));
      return parsed;
    });
    const accept = vi.spyOn(f.repo, 'acceptCardSyncObservations');
    const refuse = vi.spyOn(f.repo, 'recordCardSyncRunRefusal');
    const result = await f.request('POST', '/card-sync/observations', body(f.w.payload(binding, [row()]), opened.runId), headers(opened.clientRunId));
    expect(result.status).toBe(409);
    expect(result.json).toEqual({ error: 'authorization-blocked' });
    expect(accept).not.toHaveBeenCalled();
    expect(refuse).not.toHaveBeenCalled();
    expect(f.repo.getCardSyncRun(opened.runId)!.runState).toBe('open');
  });

  it('rechecks before refusal recording and leaves a run unchanged if maintenance began after correlation', async () => {
    const opened = await open();
    const lookup = f.repo.getCardSyncRunByClientRunId.bind(f.repo);
    vi.spyOn(f.repo, 'getCardSyncRunByClientRunId').mockImplementationOnce((input) => {
      const run = lookup(input);
      writeMarker(f.controlDir, marker({ state: 'maintenance', reason: 'recovery' }, 'test'));
      return run;
    });
    const record = vi.spyOn(f.repo, 'recordCardSyncRunRefusal');
    const result = await f.request('POST', '/card-sync/observations', Buffer.from('{'), headers(opened.clientRunId));
    expect(result.status).toBe(409);
    expect(record).not.toHaveBeenCalled();
    expect(f.repo.getCardSyncRun(opened.runId)!.runState).toBe('open');
  });

  it('can correlate a missing client key by an unambiguous owned run id, never another device or duplicate body key', async () => {
    const opened = await open();
    const wire = body(f.w.payload(binding, [row()]), opened.runId);
    const other = f.w.device([binding.bindingId]);
    await f.syncFence();
    const foreign = await f.request('POST', '/card-sync/observations', wire, f.deviceHeaders(other.token));
    expect(foreign.status).toBe(400);
    expect(f.repo.getCardSyncRun(opened.runId)!.runState).toBe('open');
    const ambiguous = Buffer.from(`{"runId":"${opened.runId}","run\\u0049d":"${opened.runId}"}`);
    expect((await f.request('POST', '/card-sync/observations', ambiguous, headers())).status).toBe(400);
    expect(f.repo.getCardSyncRun(opened.runId)!.runState).toBe('open');
    const result = await f.request('POST', '/card-sync/observations', wire, headers());
    expect(result.status).toBe(400);
    expect(f.repo.getCardSyncRun(opened.runId)).toMatchObject({ runState: 'refused', errorCode: 'payload-invalid' });
  });

  it('replays run creation without extending the deadline and refuses changed parameters and a third open run', async () => {
    const first = await open();
    const again = await f.request('POST', '/card-sync/runs', first.request, headers(first.clientRunId));
    expect(again.json.runId).toBe(first.runId);
    expect(again.json.expiresAt).toBe(f.repo.getCardSyncRun(first.runId)!.uploadExpiresAt);
    const changed = await f.request('POST', '/card-sync/runs', { ...first.request, adapterVersion: 'other' }, headers(first.clientRunId));
    expect(changed.status).toBe(409);
    expect(changed.json.error).toBe('idempotency-conflict');
    await open();
    const clientRunId = `crn_${randomCardSyncLetters()}`;
    const full = await f.request('POST', '/card-sync/runs', { ...first.request, clientRunId }, headers(clientRunId));
    expect(full.status).toBe(429);
    expect(full.json.error).toBe('too-many-open-runs');
  });

  it('hands an item-free first sync to the owner without cancelling the owner plan or passing owner preconditions', async () => {
    const sent = await upload();
    const owner = f.repo.prepareCardSyncPlan({
      principal: { kind: 'session', actorRef: SCENARIO_OWNER }, setId: sent.setId, expectedVersion: 1,
      expectedGeneration: f.w.generation(),
    });
    expect(owner.status).toBe('executable');
    if (owner.status !== 'executable') throw Error('fixture owner plan');
    const before = f.w.db.prepare('SELECT count(*) FROM card_sync_commit_plans').pluck().get();
    const prepare = vi.spyOn(f.repo, 'prepareCardSyncPlan');
    const result = await f.request('POST', '/card-sync/imports/preview', { runId: sent.runId, observationSetId: sent.setId }, headers());
    expect(result.status).toBe(200);
    expect(result.json).toEqual({
      status: 'owner-review', observationSetId: sent.setId, counts: owner.counts, reviewCount: 0,
    });
    expect(prepare.mock.calls[0][0]).toEqual({
      principal: { kind: 'device', deviceId: device.deviceId }, setId: sent.setId, expectedGeneration: f.w.generation(),
    });
    expect(f.w.db.prepare('SELECT count(*) FROM card_sync_commit_plans').pluck().get()).toBe(before);
    expect(f.repo.getCardSyncPlanEffectsPage({
      principal: { kind: 'session', actorRef: SCENARIO_OWNER }, previewId: owner.previewId, afterOrdinal: -1, limit: 1,
    })!.status).toBe('prepared');
  });

  it('prepares and commits a device-eligible unchanged set, replays the commit, and keeps a terminal upload ACK terminal', async () => {
    f.w.ingest(device, binding, [row()]);
    const sent = await upload();
    const plan = await f.request('POST', '/card-sync/imports/preview', { runId: sent.runId, observationSetId: sent.setId }, headers());
    expect(plan.status, plan.bytes.toString()).toBe(200);
    expect(plan.json.status).toBe('executable');
    expect(plan.json.counts).toMatchObject({ insert: 0, unchanged: 1 });
    expect(Object.keys(plan.json).sort()).toEqual(['counts', 'expiresAt', 'payloadDigest', 'planDigest', 'previewId', 'status']);
    const input = {
      runId: sent.runId, previewId: plan.json.previewId, payloadDigest: plan.json.payloadDigest, planDigest: plan.json.planDigest,
    };
    const committed = await f.request('POST', '/card-sync/imports/commit', input, headers());
    expect(committed.status, committed.bytes.toString()).toBe(200);
    expect(committed.json).toEqual({ status: 'committed', committedAt: f.w.now(), inserted: 0, updated: 0 });
    expect((await f.request('POST', '/card-sync/imports/commit', input, headers())).json).toEqual(committed.json);
    expect(f.w.db.prepare('SELECT count(*) FROM card_transactions').pluck().get()).toBe(1);
    const receipt = await f.request('GET', `/card-sync/runs/${sent.runId}/receipt`, undefined, headers());
    expect(receipt.json).toMatchObject({ ledger: 'committed', observationSetId: sent.setId });
    const replay = await f.request('POST', '/card-sync/observations', sent.wire, headers(sent.clientRunId));
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual({ ...sent.reply.json, status: 'committed' });
  });

  it.each(['rejected', 'expired-unreviewed'] as const)('replays an accepted %s set truthfully and never accepts twice', async (state) => {
    if (state === 'expired-unreviewed') f.repo.updateCardSyncRetention({
      expectedVersion: f.repo.getCardSyncSettings().settingsVersion, reviewRetentionDays: 1, actorRef: SCENARIO_OWNER,
    });
    const sent = await upload();
    if (state === 'rejected') f.repo.discardCardSyncObservationSet({
      setId: sent.setId, expectedVersion: 1, reason: 'other', actorRef: SCENARIO_OWNER,
    });
    else f.w.clock = Date.parse(sent.reply.json.expiresAt);
    const replay = await f.request('POST', '/card-sync/observations', sent.wire, headers(sent.clientRunId));
    expect(replay.status).toBe(200);
    expect(replay.json.status).toBe(state);
    const receipt = await f.request('GET', `/card-sync/runs/${sent.runId}/receipt`, undefined, headers());
    expect(receipt.json.acceptance).toBe(state);
    expect(f.w.db.prepare('SELECT count(*) FROM card_sync_observation_sets').pluck().get()).toBe(1);
  });

  it.each([
    { parser: 'parseDeviceRun', method: 'createCardSyncRun', path: '/runs' },
    { parser: 'parseDevicePrepare', method: 'prepareCardSyncPlan', path: '/imports/preview' },
    { parser: 'parseDeviceCommit', method: 'commitCardSyncPlan', path: '/imports/commit' },
    { parser: 'parseDeviceAbort', method: 'abortCardSyncRun', path: '/runs/:runId/abort' },
    { parser: 'parseDeviceRedeem', method: 'redeemCardSyncPairing', path: '/pairings/redeem' },
  ] as const)('rechecks admission immediately before $method', async ({ parser, method, path }) => {
    const sent = await upload();
    const createRun = { ...sent.request, clientRunId: `crn_${randomCardSyncLetters()}` };
    const requests = {
      parseDeviceRun: createRun,
      parseDevicePrepare: { runId: sent.runId, observationSetId: sent.setId },
      parseDeviceCommit: {
        runId: sent.runId, previewId: newCardSyncId('prv_'), payloadDigest: sent.reply.json.payloadDigest, planDigest: `pl1:${'a'.repeat(64)}`,
      },
      parseDeviceAbort: { reason: 'user-cancelled' },
      parseDeviceRedeem: { clientVersion: '1.2.3', deviceLabel: 'Synthetic Chrome' },
    };
    const parse = protocol[parser] as (bytes: Buffer) => unknown;
    vi.spyOn(protocol, parser).mockImplementation(((bytes: Buffer) => {
      const value = parse(bytes);
      f.setRefusal('ingress-unverified');
      return value;
    }) as never);
    const effect = vi.spyOn(f.repo, method);
    const requestHeaders: Array<[string, string]> = parser === 'parseDeviceRedeem'
      ? [['Authorization', `HoldrPair ${randomCardSyncLetters()}`], ['X-Holdr-Client', 'extension-v1']]
      : headers(createRun.clientRunId);
    const result = await f.request('POST', `/card-sync${path.replace(':runId', sent.runId)}`, requests[parser], requestHeaders);
    expect(result.status).toBe(503);
    expect(result.json).toEqual({ error: 'ingress-unverified' });
    expect(effect).not.toHaveBeenCalled();
    expect(readFence(f.controlDir, TEST_MACHINE)).toMatchObject({ gate: 'open' });
  });

  it('fifth bad pairing guess advances the generation under D without nested locking, while the gate returns open', async () => {
    const pairing = f.repo.createCardSyncPairing({
      actorRef: SCENARIO_OWNER, codeDigest: pairingCodeDigest(randomCardSyncLetters()),
      bindingIds: [binding.bindingId], replacesDeviceId: null, ...f.w.step(),
    }).value;
    await f.syncFence();
    const generation = f.w.generation();
    const count = f.repo.listCardSyncDevices().length;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const result = await f.request('POST', '/card-sync/pairings/redeem', { clientVersion: '1.2.3', deviceLabel: 'Synthetic Chrome' }, [
        ['Authorization', `HoldrPair ${randomCardSyncLetters()}`], ['X-Holdr-Client', 'extension-v1'],
      ]);
      expect(result.status).toBe(attempt === 5 ? 429 : 401);
      expect(result.json.error).toBe(attempt === 5 ? 'pairing-locked' : 'pairing-invalid');
      expect(f.gate.status()).toBe('open');
      if (attempt < 5) expect(f.w.generation()).toBe(generation);
    }
    expect(f.w.generation()).not.toBe(generation);
    expect(f.repo.getCardSyncPairing(pairing.pairingId)!.status).toBe('locked');
    expect(f.repo.listCardSyncDevices()).toHaveLength(count);
    expect(readFence(f.controlDir, TEST_MACHINE)).toMatchObject({ gate: 'open', state: { generation: f.w.generation() } });
  });

  it('accepts the maximum row count and near-maximum E1a bytes without putting input waits under the lock', async () => {
    const padding = ' SYNTHETIC MERCHANT PURCHASE DESCRIPTION AND CATEGORY'.repeat(20);
    const rows = Array.from({ length: 2_000 }, (_, index): ScenarioRow => ({
      ...row(), id: `synthetic-max-${index}`, description: `Synthetic purchase ${index}${padding}`.slice(0, 400).trim(),
      merchant: `Synthetic merchant ${index}${padding}`.slice(0, 100).trim(), category: padding.trim().slice(0, 100).trim(),
    }));
    const payload = f.w.payload(binding, rows);
    const size = Buffer.byteLength(canonicalJson(payload as unknown as JsonValue));
    expect(size).toBeGreaterThan(CARD_SYNC_V2_MAX_BYTES * 0.9);
    expect(size).toBeLessThanOrEqual(CARD_SYNC_V2_MAX_BYTES);
    const opened = await open();
    const result = await f.request('POST', '/card-sync/observations', body(payload, opened.runId), headers(opened.clientRunId));
    expect(result.status, result.bytes.toString()).toBe(200);
    expect(f.repo.getCardSyncRun(opened.runId)!.runState).toBe('accepted');
    expect(f.gate.status()).toBe('open');
  }, 30_000);
});
