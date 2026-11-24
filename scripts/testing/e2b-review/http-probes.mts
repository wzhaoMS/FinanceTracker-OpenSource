import assert from 'node:assert/strict';
import http from 'node:http';
// P-NET: refuses any listener beyond 127.0.0.1 or ::1 in the process that runs these probes.
import '../../loopback-only.mjs';
import {
  fs, path, REPORT_DIR, PORT, WEB_PORT, MACHINE, PASSWORD, FAST, SqliteStateRepo, LocalAuthRepo, newGeneration, readFence,
  world, makeDevice,
} from './probe-common.mts';
import { launch, cleanupChildren, waitFor } from './child-processes.mts';
import { createApp } from '../../../apps/api/src/app.ts';
import { createAuthorizationGateService } from '../../../apps/api/src/control/authorizationChange.ts';
import {
  acquireSharedLease, leaseStillOn, marker, writeMarker, readMarker, withAuthorizationLock,
} from '../../../apps/api/src/control/lifecycle.ts';
import { blockFence } from '../../../apps/api/src/control/recovery.ts';
import {
  deviceFingerprint, deviceTokenDigest, pairingCodeDigest, randomCardSyncLetters,
} from '../../../apps/api/src/services/cardSyncDigests.ts';
import { createOwnerClient } from '../../../apps/web/src/components/spending/sync/ownerClient.ts';

const ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
const SERVICE = 'c3'.repeat(32);
const owner = (suffix: string) => '/card-sync/owner' + suffix;
const results: any[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
const save = (record: any) => { results.push(record); console.log(JSON.stringify(record)); };

export function request(method: string, route: string, body?: unknown, headers: Record<string, string> = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, method, path: route, agent: false,
      headers: { ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }), ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsed: any;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        resolve({ status: res.statusCode!, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function api(label: string, count = 1) {
  const w = await world(label, count);
  const lease = await acquireSharedLease(w.controlDir);
  let clock = Date.now();
  const now = () => new Date(clock);
  const repo = new SqliteStateRepo({ file: w.file, now });
  const logs: string[] = [];
  const gate = createAuthorizationGateService({
    controlDir: w.controlDir, machine: MACHINE, databaseGeneration: () => repo.getCardSyncAuthorizationGeneration(),
    leaseLive: () => leaseStillOn(lease, w.controlDir), log: (line) => logs.push(line), lockTimeoutMs: 1500,
  });
  const { app } = createApp({
    repo, serviceToken: SERVICE, allowedOrigins: [ORIGIN], snapshotsEnabled: false, scryptParams: FAST, now, log: (line) => logs.push(line),
    cardSyncAuthorization: { gate, holdrOrigin: 'https://holdr.review.test', deviceApi: 'enabled' },
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    repo.close();
    lease.release();
    w.cleanup();
  };
  cleanups.push(close);
  const login = await request('POST', '/auth/login', { username: 'reviewer', password: PASSWORD }, { Origin: ORIGIN, 'X-Holdr-Request': '1' });
  assert.equal(login.status, 200);
  const cookie = login.headers['set-cookie']!.find((line) => line.startsWith('holdr_session='))!.split(';')[0];
  const headers = { Cookie: cookie, Origin: ORIGIN, 'X-Holdr-Request': '1' };
  const post = (route: string, body: unknown) => request('POST', route, body, headers);
  const recent = async () => { assert.equal((await post('/auth/reverify', { password: PASSWORD })).status, 200); };
  return { ...w, app, server, repo, lease, logs, gate, cookie, headers, post, recent, close, tick(seconds: number) { clock += seconds * 1000; } };
}

async function invitation(w: Awaited<ReturnType<typeof api>>) {
  const code = randomCardSyncLetters();
  const pair = await w.gate.change('widening', (step) => w.repo.createCardSyncPairing({
    actorRef: w.actorRef, codeDigest: pairingCodeDigest(code), bindingIds: [w.binding.bindingId], replacesDeviceId: null, ...step,
  }));
  return { code, pairingId: pair.value.pairingId };
}
async function redeem(w: Awaited<ReturnType<typeof api>>, code: string) {
  const token = `hdv1_${randomCardSyncLetters()}${randomCardSyncLetters()}`;
  const deviceId = `dev_${randomCardSyncLetters()}`;
  const fingerprint = deviceFingerprint(token);
  const result = await w.gate.change('widening', (step) => w.repo.redeemCardSyncPairing({
    codeDigest: pairingCodeDigest(code), deviceId, fingerprint, tokenDigest: deviceTokenDigest(token),
    label: 'Synthetic browser', clientVersion: '1.0.0', ...step,
  }));
  assert(result.ok);
  return { deviceId, fingerprint, token };
}

try {
  {
    const w = await api('http-boundaries');
    const binding = w.binding.bindingId;
    const device = w.devices[0].deviceId;
    const pairing = w.devices[0].pairingId;
    const routes = ['/pause', '/resume', '/issuers/chase/enable', '/issuers/chase/disable', '/bindings',
      `/bindings/${binding}/confirm`, `/bindings/${binding}/retire`, `/bindings/${binding}/auto-sync`, '/pairings',
      `/pairings/${pairing}/approve`, `/pairings/${pairing}/reject`, `/pairings/${pairing}/cancel`,
      `/devices/${device}/revoke`, `/devices/${device}/regrant`];
    const generation = w.repo.getCardSyncAuthorizationGeneration();
    for (const route of routes) {
      const service = await request('POST', owner(route), {}, { Authorization: `Bearer ${SERVICE}` });
      assert.equal(service.status, 403, route);
      assert.deepEqual(service.body, { error: 'credential-not-allowed' }, route);
      assert(!service.headers['access-control-allow-origin']);
    }
    assert.equal((await request('GET', owner('/state'), undefined, { Authorization: `Bearer ${SERVICE}` })).status, 403);
    const body = { bindingIds: [binding], replacesDeviceId: null };
    assert.equal((await request('POST', owner('/pairings'), body, { Origin: ORIGIN, 'X-Holdr-Request': '1' })).status, 401);
    assert.equal((await request('POST', owner('/pairings'), body, { Cookie: w.cookie, Origin: ORIGIN })).status, 403);
    assert.equal((await request('POST', owner('/pairings'), body, { Cookie: w.cookie, 'X-Holdr-Request': '1' })).status, 403);
    assert.equal((await request('POST', owner('/pairings'), body, { ...w.headers, Origin: 'https://foreign.invalid' })).status, 403);
    assert.deepEqual((await w.post(owner('/pairings'), body)).body, { error: 'recent-auth-required' });
    assert.equal((await request('GET', owner('/state'), undefined, { Cookie: w.cookie, Authorization: 'HoldrDevice synthetic' })).status, 401);
    assert.equal(w.repo.getCardSyncAuthorizationGeneration(), generation);
    for (const route of ['/card-sync/device/pairings/redeem', '/card-sync/device/runs', '/card-sync/device/state']) {
      const res = await w.post(route, {});
      assert.equal(res.status, 404);
    }
    await w.recent();
    const refusal = await w.post(owner('/bindings'), {
      issuer: 'chase', source: 'chase-api', cardAccountRef: 'card-acct-' + 'a'.repeat(32),
      bindingLabel: '4111 1111 1111 1111', scopes: [{ scopeLabel: 'Synthetic card', holderAlias: 'alex', last4: '1111' }],
    });
    assert.equal(refusal.status, 422);
    assert(!JSON.stringify(refusal.body).includes('4111'));
    assert(!w.logs.join('\n').includes('4111'));
    save({ probe: 'owner principal/CSRF/recent-auth/value-free boundaries', postRoutesChecked: routes.length, serviceWireCode: 'credential-not-allowed',
      deviceRoutesNotMounted: true, deniedRequestsChangedNoGeneration: true, pass: true });
    await w.close();
  }

  {
    const w = await api('r1-regrant');
    const binding = w.binding.bindingId;
    const current = () => w.repo.getCardSourceBinding(binding)!;
    const firstRevision = current().autoSync.revision;
    const firstGeneration = w.repo.getCardSyncAuthorizationGeneration();
    const off1 = await w.post(owner(`/bindings/${binding}/auto-sync`), { expectedVersion: 999, expectedAutoSyncRevision: 999, enabled: false });
    const off2 = await w.post(owner(`/bindings/${binding}/auto-sync`), { expectedVersion: 999, expectedAutoSyncRevision: 999, enabled: false });
    assert.equal(off1.status, 200);
    assert.equal(off2.status, 200);
    assert.equal(off2.body.autoSync.revision, firstRevision + 2);
    assert.equal(w.repo.getCardSyncAuthorizationGeneration(), firstGeneration);
    await w.recent();
    const staleOn = await w.post(owner(`/bindings/${binding}/auto-sync`), { expectedVersion: 1, expectedAutoSyncRevision: firstRevision, enabled: true });
    assert.equal(staleOn.status, 409);
    assert.equal(staleOn.body.error, 'version-conflict');
    const scopes = current().scopes.filter((scope) => scope.kind === 'known').map((scope) => ({
      cardScopeId: scope.cardScopeId, scopeLabel: scope.scopeLabel, holderAlias: scope.holderAlias, last4: scope.last4,
    }));
    const confirmation = await w.post(owner(`/bindings/${binding}/confirm`), {
      expectedVersion: 1, bindingLabel: 'Synthetic review card', scopes, regrantDeviceIds: [],
    });
    assert.equal(confirmation.status, 200, JSON.stringify(confirmation.body));
    assert.deepEqual(w.repo.getCardSyncDevice(w.devices[0].deviceId)!.staleBindingIds, [binding]);
    const regrant = await w.post(owner(`/devices/${w.devices[0].deviceId}/regrant`), { bindingIds: [binding] });
    assert.equal(regrant.status, 200);
    assert.deepEqual(regrant.body.staleBindingIds, []);
    const grants = w.repo.internalGetDb().prepare('SELECT status, binding_version, auto_sync FROM card_sync_device_scopes WHERE device_id = ? ORDER BY rowid')
      .all(w.devices[0].deviceId);
    assert.deepEqual(grants, [{ status: 'revoked', binding_version: 1, auto_sync: 0 }, { status: 'active', binding_version: 2, auto_sync: 0 }]);
    const beforeRepeat = w.repo.getCardSyncAuthorizationGeneration();
    assert.equal((await w.post(owner(`/devices/${w.devices[0].deviceId}/regrant`), { bindingIds: [binding] })).status, 200);
    assert.equal(w.repo.getCardSyncAuthorizationGeneration(), beforeRepeat);
    await blockFence(w.controlDir, MACHINE);
    assert.equal((await w.post(owner(`/devices/${w.devices[0].deviceId}/regrant`), { bindingIds: [binding] })).body.error, 'authorization-blocked');
    const blockedRevision = current().autoSync.revision;
    const blockedOff = await w.post(owner(`/bindings/${binding}/auto-sync`), { expectedVersion: 999, expectedAutoSyncRevision: 999, enabled: false });
    assert.equal(blockedOff.status, 200);
    assert.equal(blockedOff.body.autoSync.revision, blockedRevision + 1);
    assert.equal(readFence(w.controlDir, MACHINE).state?.reason, 'incident');
    save({ probe: 'R1 and regrant through real fence/HTTP', repeatedOffBumpsRevision: true, staleOnRefused: true,
      freshGrantHasNoConsent: true, regrantRepeatNoAdvance: true, incidentOffKeepsBlock: true, pass: true });
    await w.close();
  }

  {
    const w = await api('maintenance-approve', 0);
    await w.recent();
    const pair = await invitation(w);
    const device = await redeem(w, pair.code);
    writeMarker(w.controlDir, marker({ state: 'maintenance', reason: 'review-test' }, 'review'));
    assert(leaseStillOn(w.lease, w.controlDir));
    const response = await w.post(owner(`/pairings/${pair.pairingId}/approve`), { deviceId: device.deviceId, fingerprint: device.fingerprint });
    assert.equal(response.status, 409);
    assert.equal(w.repo.getCardSyncDevice(device.deviceId)!.status, 'pending');
    assert.equal(readMarker(w.controlDir)?.state, 'maintenance');
    assert.equal(readFence(w.controlDir, MACHINE).gate, 'open');
    save({ probe: 'pairing approval after maintenance entry', sharedLeaseStillLive: true,
      maintenanceMarker: true, httpStatus: response.status, deviceRemainsPending: true, pass: true });
    await w.close();
  }

  for (const remove of [false, true]) {
    const w = await api(remove ? 'remove-race' : 'passwd-race', 0);
    await w.recent();
    const pair = await invitation(w);
    let authenticatedBeforeBody = false;
    function instrument(stack: any[]) {
      for (const layer of stack ?? []) {
        if (layer.route?.path === '/pairings/:pairingId/approve') {
          const first = layer.route.stack[0];
          const original = first.handle;
          first.handle = (req: any, res: any, next: any) => original(req, res, (error: any) => {
            if (!error) authenticatedBeforeBody = true;
            next(error);
          });
        }
        if (layer.handle?.stack) instrument(layer.handle.stack);
      }
    }
    instrument((w.app as any)._router.stack);
    const sampleBody = JSON.stringify({ deviceId: 'dev_' + 'a'.repeat(32), fingerprint: 'a'.repeat(16) });
    let req!: http.ClientRequest;
    const response = new Promise<{ status: number; body: any }>((resolve, reject) => {
      req = http.request({
        hostname: '127.0.0.1', port: PORT, path: owner(`/pairings/${pair.pairingId}/approve`), method: 'POST', agent: false,
        headers: { ...w.headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(sampleBody) },
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
      });
      req.on('error', reject);
      req.flushHeaders();
      req.write('{');
    });
    response.catch(() => {});
    await waitFor(() => authenticatedBeforeBody, 'approval passed actual session and recent-auth middleware');
    const reset = await launch({
      mode: 'passwd', remove, file: w.file, controlDir: w.controlDir, dataDir: w.dataDir, env: w.env,
    }).completed();
    assert.equal(reset.code, 0, JSON.stringify(reset));
    const freshRequest = await request('GET', owner('/state'), undefined, { Cookie: w.cookie });
    assert([401, 503].includes(freshRequest.status));
    assert.equal(w.repo.listCardSyncDevicesToRevokeForReset(w.actorRef).length, 0);
    const device = await redeem(w, pair.code);
    const body = JSON.stringify({ deviceId: device.deviceId, fingerprint: device.fingerprint });
    assert.equal(Buffer.byteLength(body), Buffer.byteLength(sampleBody));
    req.end(body.slice(1));
    const approved = await response;
    assert.equal(approved.status, 401);
    assert.equal(w.repo.findCardSyncDeviceByTokenDigest(deviceTokenDigest(device.token))?.status, 'pending');
    assert.throws(() => w.repo.createCardSyncRun({
      deviceId: device.deviceId, clientRunId: 'crn_' + randomCardSyncLetters(), bindingId: w.binding.bindingId,
      bindingVersion: 1, adapterVersion: 'holdr-ext@1.0.0', contractVersion: 1, trigger: 'manual',
      expectedGeneration: w.repo.getCardSyncAuthorizationGeneration(),
    }), /device-not-active/);
    save({ probe: `${remove ? 'remove' : 'passwd'} versus delayed approval body`,
      cliExit: reset.code, newRequestWithOldSession: freshRequest.status, delayedApprovalStatus: approved.status,
      credentialResolvesActive: false, newDeviceRunAuthorized: false, pass: true });
    await w.close();
  }

  {
    const w = await api('hidden-authority', 0);
    // Fixture setup uses the same guarded primitives, then aligns the gate; no source code is changed.
    const created = Array.from({ length: 51 }, () => makeDevice(w.repo, w.actorRef, w.binding.bindingId));
    const { writeFence, fenceState } = await import('./probe-common.mts');
    await withAuthorizationLock(w.controlDir, () => writeFence(w.controlDir, fenceState({
      gate: 'open', reason: null, generation: w.repo.getCardSyncAuthorizationGeneration(), next: null, op: null, machine: MACHINE,
    })));
    w.tick(86401);
    const state = await request('GET', owner('/state'), undefined, { Cookie: w.cookie });
    assert.equal(state.status, 200);
    assert.equal(state.body.devices.length, 50);
    assert.equal(state.body.bindings[0].deviceIds.length, 50);
    assert.equal(state.body.pairings.length, 0, 'closed invitations have left their 24-hour history window');
    assert.equal(w.repo.listCardSyncDevices().filter((d) => d.status === 'active').length, 51);
    const hidden = created[50];
    assert.equal(state.body.inventory.devices.total, 51);
    assert(state.body.inventory.devices.nextCursor);
    assert.equal(state.body.bindings[0].deviceInventory.total, 51);
    assert(state.body.bindings[0].deviceInventory.nextCursor);
    assert.equal(w.repo.findCardSyncDeviceByTokenDigest(deviceTokenDigest(hidden.token))?.status, 'active');
    const client = createOwnerClient({ async request(method, route, body) {
      const reply = await request(method, route, body, w.headers);
      return { kind: 'json', status: reply.status, body: reply.body };
    } }, 'live');
    const complete = await client.getState();
    assert.equal(complete.devices.filter((d) => d.status === 'active').length, 51);
    assert.equal(complete.bindings[0].deviceIds.length, 51);
    assert.equal(complete.bindings[0].autoSync.devices.length, 51);
    assert(complete.devices.some((d) => d.deviceId === hidden.deviceId));
    save({ probe: '51 active browsers', databaseActive: 51, firstPageActive: 50, completeClientActive: 51,
      completeBindingDeviceIds: 51, completeConsentInventory: 51, remainingPairingHistory: 0, explicitContinuation: true, pass: true });
    await w.close();
  }
} catch (error) {
  save({ unexpectedFailure: String(error), stack: (error as Error).stack });
  process.exitCode = 1;
} finally {
  await cleanupChildren();
  for (const cleanup of cleanups.reverse()) await cleanup();
  fs.writeFileSync(path.join(REPORT_DIR, 'http-results.json'), JSON.stringify(results, null, 2) + '\n');
}
