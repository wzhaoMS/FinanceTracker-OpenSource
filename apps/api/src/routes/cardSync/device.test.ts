import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, type CardSyncPayloadV2, type JsonValue } from '@finance-tracker/shared';
import { DEVICE_EXTENSION_ORIGINS } from './deviceCors.js';
import { DEVICE_ENDPOINTS, DEVICE_UPLOAD_BODY_BYTES } from './deviceProtocol.js';
import { newCardSyncId, randomCardSyncLetters } from '../../services/cardSyncDigests.js';
import type { CardSourceBindingView } from '../../services/sqliteStateRepo.js';
import { cardSyncDeviceWorld, deviceRawRequest, DEVICE_TEST_ORIGIN, DEVICE_TEST_PASSWORD } from '../../testing/cardSyncDeviceWorld.js';
import { assertDeviceRoutesGuarded } from '../../testing/deviceRoutes.js';
import { TEST_PORT } from '../../ingress/fixtures.js';
import type { ScenarioDevice } from '../../testing/cardSyncScenario.js';

describe.skipIf(process.platform !== 'darwin')('E2c device HTTP routes behind the real DeviceAdmission', () => {
  let f: Awaited<ReturnType<typeof cardSyncDeviceWorld>>;
  let binding: CardSourceBindingView;
  let device: ScenarioDevice;
  beforeEach(async () => {
    f = await cardSyncDeviceWorld();
    f.w.enable('chase');
    binding = f.w.binding();
    device = f.w.device([binding.bindingId]);
    await f.syncFence();
  });
  afterEach(async () => { await f?.close(); });

  const headers = (extra: Array<[string, string]> = []) => [...f.deviceHeaders(device.token), ...extra];
  async function run() {
    const clientRunId = `crn_${randomCardSyncLetters()}`;
    const response = await f.request('POST', '/card-sync/runs', {
      clientRunId, bindingId: binding.bindingId, bindingVersion: binding.bindingVersion,
      adapterVersion: 'holdr-ext@0.1.0', contractVersion: 1, trigger: 'manual',
    }, headers([['Idempotency-Key', clientRunId]]));
    expect(response.status, response.bytes.toString()).toBe(200);
    return { clientRunId, runId: response.json.runId as string };
  }
  function payload() {
    return f.w.payload(binding, [{ scope: binding.scopes.find((scope) => scope.kind === 'known')!.cardScopeId,
      date: '2026-10-01', amount: 250, description: 'Synthetic cafe' }]);
  }
  const bytes = (runId: string, value: CardSyncPayloadV2) =>
    Buffer.from(`{"payload":${canonicalJson(value as unknown as JsonValue)},"runId":${JSON.stringify(runId)}}`);
  async function accepted() {
    const opened = await run();
    const value = payload();
    const wire = bytes(opened.runId, value);
    const response = await f.request('POST', '/card-sync/observations', wire, headers([['Idempotency-Key', opened.clientRunId]]));
    expect(response.status, response.bytes.toString()).toBe(200);
    return { ...opened, value, wire, response };
  }

  it('enumerates exactly the eight device endpoints and all eight guarded preflights on the actual app', () => {
    const expected = DEVICE_ENDPOINTS.flatMap((route) => [
      { method: route.method.toUpperCase(), path: `/card-sync${route.path}` },
      { method: 'OPTIONS', path: `/card-sync${route.path}` },
    ]);
    expect(assertDeviceRoutesGuarded(f.app, { expected })).toEqual(expected);
  });

  it('answers scoped capabilities under a declared matching client version, without digests or bearer fields', async () => {
    const response = await f.request('GET', '/card-sync/capabilities', undefined, headers());
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      status: 'active', deviceId: device.deviceId, deviceLabel: 'Laptop Chrome', holdrOrigin: DEVICE_TEST_ORIGIN,
      payloadVersions: [2], contractVersions: [1], maxRows: 2000, maxPayloadBytes: 2 * 1024 * 1024,
    });
    expect(response.json.bindings).toHaveLength(1);
    expect(response.json.bindings[0].bindingId).toBe(binding.bindingId);
    expect(response.headers['access-control-allow-origin']).toBe(DEVICE_EXTENSION_ORIGINS[0]);
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    expect(response.bytes.toString()).not.toMatch(/token|hdh1:|hph1:/i);
    const head = await f.request('HEAD', '/card-sync/capabilities', undefined, headers());
    expect(head.status).toBe(200);
    expect(head.bytes.length).toBe(0);
  });

  it('refuses missing or changed clientVersion rather than updating an existing device', async () => {
    const count = f.repo.listCardSyncDevices().length;
    for (const version of ['', '1.2.4']) {
      const requestHeaders = headers().filter(([name]) => name !== 'X-Holdr-Client-Version');
      if (version) requestHeaders.push(['X-Holdr-Client-Version', version]);
      const response = await f.request('GET', '/card-sync/capabilities', undefined, requestHeaders);
      expect(response.status).toBe(401);
      expect(response.json).toEqual({ error: 'unauthorized' });
    }
    expect(f.repo.getCardSyncDevice(device.deviceId)!.clientVersion).toBe('1.2.3');
    expect(f.repo.listCardSyncDevices()).toHaveLength(count);
  });

  it.each(['service', 'cookie', 'duplicate', 'pair-code', 'missing'])('refuses %s credentials before the service-token branch can run', async (kind) => {
    let requestHeaders = headers();
    if (kind === 'service') requestHeaders = requestHeaders.map(([name, value]) => [name, name === 'Authorization' ? `Bearer ${'be'.repeat(32)}` : value]);
    if (kind === 'cookie') requestHeaders.push(['Cookie', 'anything=1']);
    if (kind === 'duplicate') requestHeaders.push(['Authorization', `HoldrDevice ${device.token}`]);
    if (kind === 'pair-code') requestHeaders = requestHeaders.map(([name, value]) => [name, name === 'Authorization' ? `HoldrPair ${randomCardSyncLetters()}` : value]);
    if (kind === 'missing') requestHeaders = requestHeaders.filter(([name]) => name !== 'Authorization');
    const lookup = vi.spyOn(f.repo, 'findCardSyncDeviceByTokenDigest');
    const response = await f.request('GET', '/card-sync/capabilities', undefined, requestHeaders);
    expect(response.status).toBe(401);
    expect(lookup).not.toHaveBeenCalled();
    expect(response.bytes.toString()).not.toContain(device.token);
  });

  it('refuses the device on direct TCP and owner routes, without owner CORS', async () => {
    const direct = await deviceRawRequest(TEST_PORT, 'GET', '/card-sync/capabilities', [
      ['Host', `127.0.0.1:${TEST_PORT}`], ...headers(),
    ]);
    expect(direct.status).toBe(403);
    const owner = await f.request('GET', '/card-sync/owner/state', undefined, headers());
    expect(owner.status).toBe(401);
    expect(owner.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('keeps all preflights behind D and allows only the fixed extension origin and exact request headers', async () => {
    const preflight = (origin: string) => f.request('OPTIONS', '/card-sync/observations', undefined, [
      ['Origin', origin], ['Access-Control-Request-Method', 'POST'],
      ['Access-Control-Request-Headers', 'authorization,content-type,x-holdr-client,x-holdr-client-version,idempotency-key'],
    ]);
    const allowed = await preflight(DEVICE_EXTENSION_ORIGINS[0]);
    expect(allowed.status).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe(DEVICE_EXTENSION_ORIGINS[0]);
    const denied = await preflight('chrome-extension://icilknejhlhobkgcejnkbhbebnkfldmc');
    expect(denied.status).toBe(403);
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    f.setRefusal('ingress-unverified');
    expect((await preflight(DEVICE_EXTENSION_ORIGINS[0])).status).toBe(503);
  });

  it('creates idempotent runs, validates with E1a and stores the exact payload substring', async () => {
    const opened = await run();
    const value = payload();
    const wire = bytes(opened.runId, value);
    const accept = vi.spyOn(f.repo, 'acceptCardSyncObservations');
    const response = await f.request('POST', '/card-sync/observations', wire, headers([['Idempotency-Key', opened.clientRunId]]));
    expect(response.status, response.bytes.toString()).toBe(200);
    expect(accept).toHaveBeenCalledOnce();
    const input = accept.mock.calls[0][0];
    expect(wire.subarray(11, 11 + Buffer.byteLength(input.canonicalJson))).toEqual(Buffer.from(input.canonicalJson));
    expect(input.deviceId).toBe(device.deviceId);
    expect(JSON.stringify(input)).not.toContain(device.token);
    const stored = f.repo.getCardSyncPayloadReceipt({ setId: response.json.observationSetId });
    expect(stored.canonicalJson).toBe(input.canonicalJson);
    const repeat = await f.request('POST', '/card-sync/observations', wire, headers([['Idempotency-Key', opened.clientRunId]]));
    expect(repeat.json).toEqual(response.json);
    const receipt = await f.request('GET', `/card-sync/runs/${opened.runId}/receipt`, undefined, headers());
    expect(receipt.json).toMatchObject({
      runId: opened.runId, observationSetId: response.json.observationSetId, acceptance: response.json.status,
      ledger: 'none', payloadDigest: response.json.payloadDigest, acceptedAt: response.json.acceptedAt, expiresAt: response.json.expiresAt,
    });
  });

  it('answers owner-review for a review-bearing set before any owner precondition, with no stored or fabricated plan', async () => {
    const sent = await accepted();
    const before = f.w.db.prepare('SELECT count(*) FROM card_sync_commit_plans').pluck().get();
    const response = await f.request('POST', '/card-sync/imports/preview', {
      runId: sent.runId, observationSetId: sent.response.json.observationSetId,
    }, headers());
    expect(response.status, response.bytes.toString()).toBe(200);
    expect(Object.keys(response.json).sort()).toEqual(['counts', 'observationSetId', 'reviewCount', 'status']);
    expect(response.json.status).toBe('owner-review');
    expect(response.json.reviewCount).toBeGreaterThan(0);
    expect(f.w.db.prepare('SELECT count(*) FROM card_sync_commit_plans').pluck().get()).toBe(before);
    expect(response.json).not.toHaveProperty('previewId');
  });

  it('records malformed, unsafe and oversized upload refusals on the client-key run before answering', async () => {
    for (const kind of ['json', 'utf8', 'card-data', 'oversized', 'media-type', 'query'] as const) {
      const opened = await run();
      let body = Buffer.from('{');
      let target = '/card-sync/observations';
      const requestHeaders = headers([['Idempotency-Key', opened.clientRunId], ['Content-Type', 'application/json']]);
      if (kind === 'utf8') body = Buffer.from([0xc0, 0xaf]);
      if (kind === 'card-data') {
        const value = payload();
        value.rows[0].description = '4111 1111 1111 1111';
        body = bytes(opened.runId, value);
      }
      if (kind === 'oversized') requestHeaders.push(['Content-Length', String(DEVICE_UPLOAD_BODY_BYTES + 1)]);
      if (kind === 'media-type') requestHeaders[requestHeaders.length - 1] = ['Content-Type', 'text/plain'];
      if (kind === 'query') target += '?unexpected=1';
      const response = await f.raw('POST', target, requestHeaders, body);
      expect(response.status).toBe(kind === 'oversized' ? 413 : kind === 'media-type' ? 415 : kind === 'query' ? 400 : 422);
      expect(response.bytes.toString()).not.toContain('4111');
      expect(f.repo.getCardSyncRun(opened.runId)).toMatchObject({
        runState: 'refused', errorCode: kind === 'oversized' ? 'too-large' : kind === 'card-data' ? 'card-data' : 'payload-invalid',
      });
    }
  });

  it('does not accept a noncanonical payload or erase an accepted run after a later bad retry', async () => {
    const opened = await run();
    const value = payload();
    const bad = Buffer.from(`{"payload":${JSON.stringify(value, null, 2)},"runId":"${opened.runId}"}`);
    const response = await f.request('POST', '/card-sync/observations', bad, headers([['Idempotency-Key', opened.clientRunId]]));
    expect(response.status).toBe(400);
    expect(response.json.error).toBe('payload-digest-mismatch');
    expect(f.repo.getCardSyncRun(opened.runId)!.errorCode).toBe('payload-digest-mismatch');
    const sent = await accepted();
    const refused = await f.request('POST', '/card-sync/observations', Buffer.from('{'), headers([['Idempotency-Key', sent.clientRunId]]));
    expect(refused.status).toBe(422);
    expect(f.repo.getCardSyncRun(sent.runId)!.runState).toBe('accepted');
    expect(f.repo.getCardSyncPayloadReceipt({ setId: sent.response.json.observationSetId }).canonicalJson).toBe(canonicalJson(sent.value as unknown as JsonValue));
  });

  it('does not let a different device read/abort a run or prepare its set', async () => {
    const sent = await accepted();
    const other = f.w.device([binding.bindingId]);
    await f.syncFence();
    for (const [method, target, body] of [
      ['GET', `/card-sync/runs/${sent.runId}/receipt`, undefined],
      ['POST', `/card-sync/runs/${sent.runId}/abort`, { reason: 'user-cancelled' }],
      ['POST', '/card-sync/imports/preview', { runId: sent.runId, observationSetId: sent.response.json.observationSetId }],
    ] as const) {
      const reply = await f.request(method, target, body, f.deviceHeaders(other.token));
      expect(reply.status).toBe(404);
    }
    expect(f.repo.getCardSyncRun(sent.runId)!.abortReason).toBeNull();
  });

  it('aborts idempotently with only the fixed reason enum and preserves accepted evidence', async () => {
    const sent = await accepted();
    const response = await f.request('POST', `/card-sync/runs/${sent.runId}/abort`, { reason: 'user-cancelled' }, headers());
    expect(response.json).toEqual({ status: 'aborted' });
    expect((await f.request('POST', `/card-sync/runs/${sent.runId}/abort`, { reason: 'user-cancelled' }, headers())).status).toBe(200);
    expect((await f.request('POST', `/card-sync/runs/${sent.runId}/abort`, { reason: 'unbounded-private-description' }, headers())).status).toBe(422);
    expect(f.repo.getCardSyncRun(sent.runId)).toMatchObject({ runState: 'accepted', abortReason: 'user-cancelled' });
  });

  it('uses the already-held change helper for redemption, stores only digests, and requires owner approval before data', async () => {
    const cookie = await f.login();
    const ownerHeaders: Array<[string, string]> = [['Cookie', cookie], ['Origin', DEVICE_TEST_ORIGIN], ['X-Holdr-Request', '1']];
    expect((await f.request('POST', '/auth/reverify', { password: DEVICE_TEST_PASSWORD }, ownerHeaders)).status).toBe(200);
    const pairing = await f.request('POST', '/card-sync/owner/pairings', { bindingIds: [binding.bindingId], replacesDeviceId: null }, ownerHeaders);
    expect(pairing.status, pairing.bytes.toString()).toBe(201);
    const code = pairing.json.pairingCode as string;
    const redeem = vi.spyOn(f.repo, 'redeemCardSyncPairing');
    const paired = await f.request('POST', '/card-sync/pairings/redeem', { clientVersion: '0.1.0', deviceLabel: 'New Chrome' }, [
      ['Authorization', `HoldrPair ${code}`], ['X-Holdr-Client', 'extension-v1'], ['Origin', DEVICE_EXTENSION_ORIGINS[0]],
    ]);
    expect(paired.status, paired.bytes.toString()).toBe(200);
    expect(Object.keys(paired.json).sort()).toEqual(['deviceId', 'deviceToken', 'fingerprint', 'pendingExpiresAt', 'status']);
    const token = paired.json.deviceToken as string;
    expect(JSON.stringify(redeem.mock.calls)).not.toContain(code);
    expect(JSON.stringify(redeem.mock.calls)).not.toContain(token);
    const pending = await f.request('GET', '/card-sync/capabilities', undefined, f.deviceHeaders(token, '0.1.0'));
    expect(pending.json.status).toBe('pending');
    expect(pending.json.bindings).toEqual([]);
    const denied = await f.request('POST', '/card-sync/runs', {}, f.deviceHeaders(token, '0.1.0'));
    expect(denied.status).toBe(403);
    expect(denied.json.error).toBe('device-pending');
    const approved = await f.request('POST', `/card-sync/owner/pairings/${pairing.json.pairing.pairingId}/approve`, {
      deviceId: paired.json.deviceId, fingerprint: paired.json.fingerprint,
    }, ownerHeaders);
    expect(approved.status, approved.bytes.toString()).toBe(200);
    expect((await f.request('GET', '/card-sync/capabilities', undefined, f.deviceHeaders(token, '0.1.0'))).json.status).toBe('active');
    expect(f.gate.status()).toBe('open');
    for (const name of ['finance.db', 'finance.db-wal']) {
      const file = path.join(f.dataDir, name);
      if (!fs.existsSync(file)) continue;
      const bytes = fs.readFileSync(file);
      expect(bytes.includes(Buffer.from(code))).toBe(false);
      expect(bytes.includes(Buffer.from(token))).toBe(false);
    }
    expect(f.logs.join('\n')).not.toContain(token);
  });

  it('never permits a made-up preview id or a cross-run payload digest to commit', async () => {
    const sent = await accepted();
    const count = f.w.db.prepare('SELECT count(*) FROM card_transactions').pluck().get();
    const response = await f.request('POST', '/card-sync/imports/commit', {
      runId: sent.runId, previewId: newCardSyncId('prv_'), payloadDigest: `pd1:${'a'.repeat(64)}`, planDigest: `pl1:${'b'.repeat(64)}`,
    }, headers());
    expect(response.status).toBe(409);
    expect(response.json.error).toBe('plan-mismatch');
    expect(f.w.db.prepare('SELECT count(*) FROM card_transactions').pluck().get()).toBe(count);
  });
});
