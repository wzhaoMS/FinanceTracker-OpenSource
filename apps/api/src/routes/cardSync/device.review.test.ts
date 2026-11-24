import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, type JsonValue } from '@finance-tracker/shared';
import { cardSyncDeviceWorld, deviceRawRequest, DEVICE_TEST_ORIGIN } from '../../testing/cardSyncDeviceWorld.js';
import { assertDeviceRoutesGuarded } from '../../testing/deviceRoutes.js';
import { SCENARIO_OWNER, type ScenarioRow } from '../../testing/cardSyncScenario.js';
import { closeServers, SERVE_HEADERS, TEST_PORT } from '../../ingress/fixtures.js';
import { createRequestListener } from '../../ingress/server.js';
import type { ListenerConfig } from '../../ingress/types.js';
import { marker, readMarker, writeMarker, withAuthorizationLock } from '../../control/lifecycle.js';
import { fenceState, readFence, writeFence } from '../../control/syncAuthState.js';
import { TEST_MACHINE } from '../../control/testControl.js';
import { newCardSyncId, pairingCodeDigest, randomCardSyncLetters } from '../../services/cardSyncDigests.js';
import { DEVICE_ENDPOINTS, DEVICE_UPLOAD_BODY_BYTES } from './deviceProtocol.js';
import { DEVICE_EXTENSION_ORIGINS } from './deviceCors.js';
import * as protocol from './deviceProtocol.js';
import * as fenceProtocol from '../../control/syncAuthState.js';

type World = Awaited<ReturnType<typeof cardSyncDeviceWorld>>;
const observations: unknown[] = [];
const OTHER_PORT = TEST_PORT === 4116 ? 4115 : 4116;
const note = (name: string, value: unknown) => observations.push({ name, value });

afterAll(() => {
  if (process.env.E2C_REVIEW_RESULTS) {
    fs.writeFileSync(process.env.E2C_REVIEW_RESULTS, JSON.stringify(observations, null, 2) + '\n');
  }
});

function framedRequest(f: World, target: string, headers: Array<[string, string]>, frames: Buffer[], method = 'POST') {
  return new Promise<{ status: number; json: any; bytes: Buffer; headers: string }>((resolve, reject) => {
    const socket = net.connect({ path: f.config.socketPath });
    const received: Buffer[] = [];
    socket.setTimeout(20_000, () => socket.destroy(Error('review request deadline')));
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write(`${method} ${target} HTTP/1.1\r\n${[...SERVE_HEADERS, ...headers, ['Connection', 'close']]
        .map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n`);
      for (const frame of frames) socket.write(frame);
    });
    socket.on('data', (chunk) => received.push(chunk));
    socket.once('end', () => {
      const wire = Buffer.concat(received);
      const separator = wire.indexOf('\r\n\r\n');
      const head = wire.subarray(0, separator).toString();
      const bytes = wire.subarray(separator + 4);
      let json: unknown = null;
      try { json = JSON.parse(bytes.toString()); } catch { /* HTTP framing refusals can have no JSON. */ }
      socket.destroy();
      resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1]), json, bytes, headers: head });
    });
  });
}

function chunks(bytes: Buffer, split = 31): Buffer[] {
  const segments = [bytes.subarray(0, split), bytes.subarray(split)];
  return [...segments.filter((segment) => segment.length).map((segment) =>
    Buffer.concat([Buffer.from(`${segment.length.toString(16)}\r\n`), segment, Buffer.from('\r\n')])), Buffer.from('0\r\n\r\n')];
}

describe.skipIf(process.platform !== 'darwin')('Independent E2c adversarial review', () => {
  let f: World;
  let binding: ReturnType<World['w']['binding']>;
  let device: ReturnType<World['w']['device']>;
  beforeEach(async () => {
    f = await cardSyncDeviceWorld();
    f.w.enable();
    binding = f.w.binding();
    device = f.w.device([binding.bindingId]);
    await f.syncFence();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await f?.close();
  });
  const headers = (key?: string) => [
    ...f.deviceHeaders(device.token),
    ...(key ? [['Idempotency-Key', key] as [string, string]] : []),
  ];
  const row = (): ScenarioRow => ({
    scope: f.w.scopes(binding).known[0], date: '2026-10-01', amount: 2375,
    description: 'Synthetic café 雨', id: 'review-stable-row',
  });
  async function open() {
    const clientRunId = `crn_${randomCardSyncLetters()}`;
    const body = {
      clientRunId, bindingId: binding.bindingId, bindingVersion: binding.bindingVersion,
      adapterVersion: 'review@1.0.0', contractVersion: 1, trigger: 'manual',
    };
    const response = await f.request('POST', '/card-sync/runs', body, headers(clientRunId));
    expect(response.status, response.bytes.toString()).toBe(200);
    return { runId: response.json.runId as string, clientRunId, body };
  }
  const wire = (runId: string, value = f.w.payload(binding, [row()])) =>
    Buffer.from(`{"payload":${canonicalJson(value as unknown as JsonValue)},"runId":"${runId}"}`);
  async function upload() {
    const run = await open();
    const bytes = wire(run.runId);
    const result = await f.request('POST', '/card-sync/observations', bytes, headers(run.clientRunId));
    expect(result.status, result.bytes.toString()).toBe(200);
    return { ...run, bytes, result, setId: result.json.observationSetId as string };
  }
  async function invitation() {
    const code = randomCardSyncLetters();
    const pairing = f.repo.createCardSyncPairing({
      codeDigest: pairingCodeDigest(code), actorRef: SCENARIO_OWNER, bindingIds: [binding.bindingId],
      replacesDeviceId: null, ...f.w.step(),
    }).value;
    await f.syncFence();
    return { code, pairingId: pairing.pairingId };
  }
  function redeem(code: string) {
    return f.request('POST', '/card-sync/pairings/redeem', { clientVersion: '1.2.3', deviceLabel: 'Review Chrome' }, [
      ['Authorization', `HoldrPair ${code}`], ['X-Holdr-Client', 'extension-v1'],
      ['Origin', DEVICE_EXTENSION_ORIGINS[0]],
    ]);
  }

  it('enumerates the actual app and blocks path/method/parser variants without any device work', async () => {
    const expected = DEVICE_ENDPOINTS.flatMap((route) => [
      { method: route.method.toUpperCase(), path: `/card-sync${route.path}` },
      { method: 'OPTIONS', path: `/card-sync${route.path}` },
    ]);
    expect(assertDeviceRoutesGuarded(f.app, { expected })).toEqual(expected);
    const lookup = vi.spyOn(f.repo, 'findCardSyncDeviceByTokenDigest');
    const touch = vi.spyOn(f.repo, 'touchCardSyncDevice');
    const redeemCall = vi.spyOn(f.repo, 'redeemCardSyncPairing');
    const generation = f.w.generation();
    await withAuthorizationLock(f.controlDir, () => writeFence(f.controlDir, fenceState({
      gate: 'blocked', reason: 'incident', generation, next: null, op: null, machine: TEST_MACHINE,
    })));
    const results: unknown[] = [];
    for (const endpoint of DEVICE_ENDPOINTS) {
      const path = `/card-sync${endpoint.path.replace(':runId', newCardSyncId('run_'))}`;
      for (const target of [
        path, `${path}/`, path.replace('/card-sync', '/CARD-SYNC'), path.toUpperCase(),
        path.replace('/card-sync', '/%63ard-sync'), path.replace('/card-sync/', '/card-sync%2f'),
        path.replace('/card-sync/', '/card-sync//'), `${path};x`, `${path}.json`, `${path}?x=1`,
      ]) {
        for (const method of new Set([endpoint.method.toUpperCase(), 'HEAD', 'OPTIONS', 'PUT', 'DELETE'])) {
          const response = await f.request(method, target, method === 'POST' ? Buffer.from('{') : undefined, headers());
          results.push({ method, target, status: response.status, error: response.json?.error });
          expect(response.status).toBeGreaterThanOrEqual(400);
        }
      }
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(touch).not.toHaveBeenCalled();
    expect(redeemCall).not.toHaveBeenCalled();
    note('closed gate path/method matrix', results);
  }, 30_000);

  it('does not authorize a noncanonical device namespace spelling', async () => {
    const result = await f.request('GET', '/CARD-SYNC/capabilities', undefined, headers());
    const run = await open();
    const receipt = await f.request('GET', `/CARD-SYNC/runs/${run.runId}/receipt`, undefined, headers());
    const head = await f.request('HEAD', '/Card-Sync/capabilities', undefined, headers());
    note('uppercase mount spelling', {
      status: result.status, deviceMatched: result.json?.deviceId === device.deviceId,
      receiptStatus: receipt.status, receiptMatched: receipt.json?.runId === run.runId, headStatus: head.status,
      cors: result.headers['access-control-allow-origin'] ?? null,
    });
    expect(result.status).toBeGreaterThanOrEqual(400);
  });

  it('rejects session credentials and all duplicate/mixed auth on every device operation', async () => {
    const cookie = await f.login();
    const lookup = vi.spyOn(f.repo, 'findCardSyncDeviceByTokenDigest');
    const touches = vi.spyOn(f.repo, 'touchCardSyncDevice');
    const results: unknown[] = [];
    for (const endpoint of DEVICE_ENDPOINTS.filter((entry) => entry.name !== 'redeem')) {
      const target = `/card-sync${endpoint.path.replace(':runId', newCardSyncId('run_'))}`;
      const variants: Array<[string, Array<[string, string]>]> = [
        ['session-only', [...headers().filter(([key]) => key !== 'Authorization'), ['Cookie', cookie]]],
        ['device-plus-session', [...headers(), ['Cookie', cookie]]],
        ['empty-cookie', [...headers(), ['Cookie', '']]],
        ['duplicate-auth', [...headers(), ['authorization', `HoldrDevice ${device.token}`]]],
        ['mixed-auth', [...headers(), ['Authorization', `HoldrPair ${randomCardSyncLetters()}`]]],
        ['pair-only', headers().map(([key, value]) => [key, key === 'Authorization' ? `HoldrPair ${randomCardSyncLetters()}` : value])],
      ];
      for (const [name, auth] of variants) {
        const response = await f.request(endpoint.method.toUpperCase(), target, endpoint.method === 'post' ? {} : undefined, auth);
        expect(response.status).toBe(401);
        results.push({ endpoint: endpoint.name, name, status: response.status });
      }
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(touches).not.toHaveBeenCalled();
    for (const target of ['/card-sync/owner/state', '/card-sync/owner/devices', '/card-sync/owner/pairings', '/CARD-SYNC/owner/state']) {
      const response = await f.request('GET', target, undefined, headers());
      expect(response.status).toBe(401);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    }
    note('session and mixed credential matrix', results);
  });

  it('missing or changed versions mutate no device state across all ordinary operations', async () => {
    const before = f.repo.getCardSyncDevice(device.deviceId);
    const touches = vi.spyOn(f.repo, 'touchCardSyncDevice');
    for (const endpoint of DEVICE_ENDPOINTS.filter((entry) => entry.name !== 'redeem')) {
      const target = `/card-sync${endpoint.path.replace(':runId', newCardSyncId('run_'))}`;
      for (const version of [undefined, '1.2.4']) {
        const auth = headers().filter(([name]) => name !== 'X-Holdr-Client-Version');
        if (version) auth.push(['X-Holdr-Client-Version', version]);
        const result = await f.request(endpoint.method.toUpperCase(), target, endpoint.method === 'post' ? {} : undefined, auth);
        expect(result.status).toBe(401);
      }
    }
    expect(touches).not.toHaveBeenCalled();
    expect(f.repo.getCardSyncDevice(device.deviceId)).toEqual(before);
    note('version binding', { ordinaryOperations: 7, versions: 2, writes: 0 });
  });

  it('preflights accept only fixed-origin methods and headers, never owner paths or credentials', async () => {
    const results: unknown[] = [];
    for (const endpoint of DEVICE_ENDPOINTS) {
      const target = `/card-sync${endpoint.path.replace(':runId', newCardSyncId('run_'))}`;
      const allowed: Array<[string, string]> = [
        ['Origin', DEVICE_EXTENSION_ORIGINS[0]],
        ['Access-Control-Request-Method', endpoint.method.toUpperCase()],
        ['Access-Control-Request-Headers', 'authorization,x-holdr-client,x-holdr-client-version,content-type,idempotency-key'],
      ];
      const good = await f.request('OPTIONS', target, undefined, allowed);
      expect(good.status).toBe(204);
      expect(good.headers['access-control-allow-credentials']).toBeUndefined();
      for (const bad of [
        [...allowed, ['Cookie', ''] as [string, string]],
        [...allowed, ['Authorization', `HoldrDevice ${device.token}`] as [string, string]],
        allowed.map(([name, value]): [string, string] => [name, name === 'Origin' ? 'null' : value]),
        allowed.map(([name, value]): [string, string] => [name, name === 'Origin' ? DEVICE_TEST_ORIGIN : value]),
        allowed.map(([name, value]): [string, string] => [name, name === 'Origin' ? 'chrome-extension://icilknejhlhobkgcejnkbhbebnkfldmc' : value]),
        allowed.map(([name, value]): [string, string] => [name, name === 'Access-Control-Request-Method' ? 'DELETE' : value]),
        allowed.map(([name, value]): [string, string] => [name, name === 'Access-Control-Request-Headers' ? 'authorization,x-holdr-client,cookie' : value]),
      ]) {
        const response = await f.request('OPTIONS', target, undefined, bad);
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.headers['access-control-allow-credentials']).toBeUndefined();
        results.push({ endpoint: endpoint.name, status: response.status });
      }
    }
    const owner = await f.request('OPTIONS', '/card-sync/owner/state', undefined, [
      ['Origin', DEVICE_EXTENSION_ORIGINS[0]], ['Access-Control-Request-Method', 'GET'],
      ['Access-Control-Request-Headers', 'authorization,x-holdr-client'],
    ]);
    expect(owner.headers['access-control-allow-origin']).toBeUndefined();
    note('CORS matrix', { negativeCases: results.length, ownerStatus: owner.status });
  });

  it('preserves exact canonical UTF-8 bytes over real chunked HTTP including a split code point', async () => {
    const run = await open();
    const bytes = wire(run.runId);
    const accent = bytes.indexOf(Buffer.from('é'));
    expect(accent).toBeGreaterThan(0);
    const response = await framedRequest(f, '/card-sync/observations', [
      ...headers(run.clientRunId), ['Content-Type', 'application/json'], ['Transfer-Encoding', 'chunked'],
    ], chunks(bytes, accent + 1));
    expect(response.status, response.bytes.toString()).toBe(200);
    const stored = f.repo.getCardSyncPayloadReceipt({ setId: response.json.observationSetId });
    const bodyBytes = bytes.subarray(11, bytes.lastIndexOf(',"runId":'));
    expect(Buffer.from(stored.canonicalJson)).toEqual(bodyBytes);
    note('real chunked UTF-8 upload', { status: response.status, bytes: bodyBytes.length, exact: true });
  });

  it('rejects ambiguous bytes, encodings and transport metadata before acceptance and records each refusal', async () => {
    const accepted = vi.spyOn(f.repo, 'acceptCardSyncObservations');
    const recorded = vi.spyOn(f.repo, 'recordCardSyncRunRefusal');
    const results: unknown[] = [];
    for (const name of ['bom', 'utf16', 'duplicate-wrapper', 'duplicate-nested', 'escaped-value', 'whitespace',
      'gzip', 'deflate', 'brotli', 'content-type', 'oversized-declared', 'oversized-chunked']) {
      const run = await open();
      const normal = wire(run.runId);
      let bytes = normal;
      const meta: Array<[string, string]> = [['Content-Type', 'application/json']];
      let expected = 400;
      let refusal = 'payload-digest-mismatch';
      if (name === 'bom') { bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), normal]); expected = 422; refusal = 'payload-invalid'; }
      if (name === 'utf16') { bytes = Buffer.from(normal.toString(), 'utf16le'); expected = 422; refusal = 'payload-invalid'; }
      if (name === 'duplicate-wrapper') bytes = Buffer.from(normal.toString().replace('{"payload":', `{"runId":"${run.runId}","payload":`));
      if (name === 'duplicate-nested') bytes = Buffer.from(normal.toString().replace('"description":', '"description":"synthetic overwritten value","description":'));
      if (name === 'escaped-value') bytes = Buffer.from(normal.toString().replace('Synthetic', '\\u0053ynthetic'));
      if (name === 'whitespace') bytes = Buffer.concat([Buffer.from(' '), normal]);
      if (name === 'gzip') { bytes = gzipSync(normal); meta.push(['Content-Encoding', 'gzip']); expected = 415; refusal = 'payload-invalid'; }
      if (name === 'deflate') { bytes = deflateSync(normal); meta.push(['Content-Encoding', 'deflate']); expected = 415; refusal = 'payload-invalid'; }
      if (name === 'brotli') { bytes = brotliCompressSync(normal); meta.push(['Content-Encoding', 'br']); expected = 415; refusal = 'payload-invalid'; }
      if (name === 'content-type') { meta[0][1] = 'text/plain'; expected = 415; refusal = 'payload-invalid'; }
      if (name.startsWith('oversized')) { expected = 413; refusal = 'too-large'; }
      if (name === 'oversized-declared') meta.push(['Content-Length', String(DEVICE_UPLOAD_BODY_BYTES + 1)]);
      const response = name === 'oversized-chunked'
        ? await framedRequest(f, '/card-sync/observations', [...headers(run.clientRunId), ...meta, ['Transfer-Encoding', 'chunked']],
          chunks(Buffer.alloc(DEVICE_UPLOAD_BODY_BYTES + 1, 0x20)))
        : await f.raw('POST', '/card-sync/observations', [...headers(run.clientRunId), ...meta], bytes);
      const state = f.repo.getCardSyncRun(run.runId)!;
      results.push({ name, status: response.status, error: response.json?.error, state: state.runState, refusal: state.errorCode });
      expect(response.status, name).toBe(expected);
      expect(state.runState, name).toBe('refused');
      expect(state.errorCode, name).toBe(refusal);
    }
    expect(accepted).not.toHaveBeenCalled();
    expect(recorded).toHaveBeenCalledTimes(results.length);
    note('upload ambiguity and transport matrix', results);
  });

  it('enforces a real incomplete-body deadline without holding authorization.lock', async () => {
    const run = await open();
    const start = Date.now();
    const pending = framedRequest(f, '/card-sync/observations', [
      ...headers(run.clientRunId), ['Content-Type', 'application/json'], ['Content-Length', '100'],
    ], [Buffer.from('{')]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const lockStart = Date.now();
    await withAuthorizationLock(f.controlDir, () => true, 1_000);
    const lockWait = Date.now() - lockStart;
    const response = await pending;
    const elapsed = Date.now() - start;
    expect(response.status).toBe(408);
    expect(elapsed).toBeGreaterThanOrEqual(14_900);
    expect(elapsed).toBeLessThan(20_000);
    expect(f.repo.getCardSyncRun(run.runId)).toMatchObject({ runState: 'refused', errorCode: 'payload-invalid' });
    expect(f.gate.status()).toBe('open');
    note('real body timeout', { status: response.status, elapsed, gate: f.gate.status(), lockWaitDuringRead: lockWait });
  }, 25_000);

  it('rejects PANs and card-secret canaries in every string-valued payload field with value-free refusals', async () => {
    const run = await open();
    const base = f.w.payload(binding, [row()]);
    const paths: Array<Array<string | number>> = [];
    const numericPaths: Array<Array<string | number>> = [];
    const walk = (value: unknown, path: Array<string | number> = []) => {
      if (typeof value === 'string') paths.push(path);
      else if (typeof value === 'number') numericPaths.push(path);
      else if (Array.isArray(value)) value.forEach((entry, index) => walk(entry, [...path, index]));
      else if (value && typeof value === 'object') Object.entries(value).forEach(([key, entry]) => walk(entry, [...path, key]));
    };
    walk(base);
    const accept = vi.spyOn(f.repo, 'acceptCardSyncObservations');
    const refusals = vi.spyOn(f.repo, 'recordCardSyncRunRefusal');
    const results: unknown[] = [];
    for (const value of ['4111 1111 1111 1111', 'cvv: 123']) {
      for (const location of paths) {
        const payload: any = structuredClone(base);
        let parent = payload;
        for (const key of location.slice(0, -1)) parent = parent[key];
        parent[location.at(-1)!] = value;
        const bytes = Buffer.from(`{"payload":${JSON.stringify(payload)},"runId":"${run.runId}"}`);
        const response = await f.request('POST', '/card-sync/observations', bytes, headers(run.clientRunId));
        results.push({ field: location.join('.'), kind: value.startsWith('4') ? 'PAN' : 'CVV', status: response.status });
        expect(response.status, location.join('.')).toBe(422);
        expect(response.bytes.toString()).not.toContain(value);
        expect(response.json.issues.length).toBeLessThanOrEqual(20);
        expect(response.json.issues.every((issue: any) => Object.keys(issue).sort().join(',') === 'code,path')).toBe(true);
      }
    }
    for (const location of numericPaths) {
      const payload: any = structuredClone(base);
      let parent = payload;
      for (const key of location.slice(0, -1)) parent = parent[key];
      parent[location.at(-1)!] = 4111111111111111;
      const response = await f.request('POST', '/card-sync/observations',
        Buffer.from(`{"payload":${JSON.stringify(payload)},"runId":"${run.runId}"}`), headers(run.clientRunId));
      results.push({ field: location.join('.'), kind: 'numeric PAN', status: response.status });
      expect(response.status, location.join('.')).toBe(422);
      expect(response.bytes.toString()).not.toContain('4111111111111111');
    }
    for (const [key, value] of [['4111 1111 1111 1111', 'synthetic'], ['cvv', '123'], ['UNKNOWN_PRIVATE_CANARY', 'cvv: 123']]) {
      const payload = { ...base, [key]: value };
      const response = await f.request('POST', '/card-sync/observations',
        Buffer.from(`{"payload":${JSON.stringify(payload)},"runId":"${run.runId}"}`), headers(run.clientRunId));
      results.push({ field: '<untrusted-key>', kind: 'key/value', status: response.status });
      expect(response.status).toBe(422);
      expect(response.bytes.toString()).not.toContain(key);
      expect(response.bytes.toString()).not.toContain(value);
    }
    expect(accept).not.toHaveBeenCalled();
    expect(refusals).toHaveBeenCalledTimes(results.length);
    const db = fs.readFileSync(`${f.dataDir}/finance.db`);
    const wal = fs.readFileSync(`${f.dataDir}/finance.db-wal`);
    for (const value of ['4111 1111 1111 1111', 'cvv: 123']) {
      expect(db.includes(Buffer.from(value)) || wal.includes(Buffer.from(value))).toBe(false);
      expect(f.logs.join('\n')).not.toContain(value);
    }
    note('field-wise card-data/secret guard', results);
  }, 30_000);

  it.each(['fence', 'generation', 'marker', 'attestation', 'lease'] as const)(
    'stops ordinary upload effects when %s changes after parsing', async (changed) => {
      const run = await open();
      const original = protocol.parseDeviceUpload;
      vi.spyOn(protocol, 'parseDeviceUpload').mockImplementationOnce((bytes) => {
        const parsed = original(bytes);
        if (changed === 'fence') writeFence(f.controlDir, fenceState({
          gate: 'blocked', reason: 'incident', generation: f.w.generation(), next: null, op: null, machine: TEST_MACHINE,
        }));
        if (changed === 'generation') f.w.db.prepare("UPDATE card_sync_policy SET authorization_generation = ? WHERE id = 'card-sync-policy'")
          .run(newCardSyncId('agn_'));
        if (changed === 'marker') writeMarker(f.controlDir, marker({ state: 'maintenance', reason: 'recovery' }, 'review'));
        if (changed === 'attestation') f.setRefusal('ingress-unverified');
        if (changed === 'lease') f.releaseLease();
        return parsed;
      });
      const accept = vi.spyOn(f.repo, 'acceptCardSyncObservations');
      const refusal = vi.spyOn(f.repo, 'recordCardSyncRunRefusal');
      const response = await f.request('POST', '/card-sync/observations', wire(run.runId), headers(run.clientRunId));
      expect(response.status).toBe(changed === 'attestation' ? 503 : 409);
      expect(accept).not.toHaveBeenCalled();
      expect(refusal).not.toHaveBeenCalled();
      expect(f.repo.getCardSyncRun(run.runId)!.runState).toBe('open');
      note(`upload effect ${changed}`, { status: response.status, accepted: false, refused: false });
    },
  );

  it.each(['marker', 'attestation', 'lease'] as const)(
    'must stop pairing when %s changes inside the authorization-change helper before its effects', async (changed) => {
      const invite = await invitation();
      const before = f.repo.listCardSyncDevices().length;
      const generation = f.w.generation();
      const read = f.authorization.databaseGeneration;
      vi.spyOn(f.authorization, 'databaseGeneration').mockImplementationOnce(() => {
        const current = read();
        if (changed === 'marker') writeMarker(f.controlDir, marker({ state: 'maintenance', reason: 'recovery' }, 'review'));
        if (changed === 'attestation') f.setRefusal('ingress-unverified');
        if (changed === 'lease') f.releaseLease();
        return current;
      });
      const repository = vi.spyOn(f.repo, 'redeemCardSyncPairing');
      const response = await redeem(invite.code);
      note(`pairing inner-helper ${changed}`, {
        status: response.status, error: response.json?.error, returnedBearer: typeof response.json?.deviceToken === 'string',
        calls: repository.mock.calls.length, devicesAdded: f.repo.listCardSyncDevices().length - before,
        generationChanged: f.w.generation() !== generation,
        pairingStatus: f.repo.getCardSyncPairing(invite.pairingId)?.status,
        fence: readFence(f.controlDir, TEST_MACHINE).gate,
      });
      expect(response.status).toBe(changed === 'attestation' ? 503 : 409);
      expect(repository).not.toHaveBeenCalled();
      expect(f.repo.listCardSyncDevices()).toHaveLength(before);
      expect(f.w.generation()).toBe(generation);
    },
  );

  it('must not overwrite an incident fence closed immediately before pairing writes its change fence', async () => {
    const invite = await invitation();
    const generation = f.w.generation();
    const before = f.repo.listCardSyncDevices().length;
    const create = fenceProtocol.newGeneration;
    vi.spyOn(fenceProtocol, 'newGeneration').mockImplementationOnce(() => {
      writeFence(f.controlDir, fenceState({
        gate: 'blocked', reason: 'incident', generation, next: null, op: null, machine: TEST_MACHINE,
      }));
      return create();
    });
    const response = await redeem(invite.code);
    note('pairing incident before first file write', {
      status: response.status, returnedBearer: typeof response.json?.deviceToken === 'string',
      devicesAdded: f.repo.listCardSyncDevices().length - before,
      generationChanged: f.w.generation() !== generation, fence: readFence(f.controlDir, TEST_MACHINE).gate,
    });
    expect(response.status).toBe(409);
    expect(f.repo.listCardSyncDevices()).toHaveLength(before);
    expect(readFence(f.controlDir, TEST_MACHINE)).not.toMatchObject({ gate: 'open' });
  });

  it('must not count the fifth bad guess or advance generation after an inner-helper lease loss', async () => {
    const invite = await invitation();
    for (let attempt = 0; attempt < 4; attempt++) expect((await redeem(randomCardSyncLetters())).status).toBe(401);
    const generation = f.w.generation();
    const before = f.repo.listCardSyncDevices().length;
    const read = f.authorization.databaseGeneration;
    vi.spyOn(f.authorization, 'databaseGeneration').mockImplementationOnce(() => {
      const current = read();
      f.releaseLease();
      return current;
    });
    const result = await redeem(randomCardSyncLetters());
    note('fifth guess with inner-helper lease loss', {
      status: result.status, error: result.json?.error, generationChanged: f.w.generation() !== generation,
      devicesAdded: f.repo.listCardSyncDevices().length - before,
      pairingStatus: f.repo.getCardSyncPairing(invite.pairingId)?.status,
    });
    expect(result.status).toBe(409);
    expect(f.w.generation()).toBe(generation);
    expect(f.repo.getCardSyncPairing(invite.pairingId)?.failedAttempts).toBe(4);
  });

  it('must not perform pairing effects or send a bearer after the five-second callback budget expires', async () => {
    const invite = await invitation();
    const before = f.repo.listCardSyncDevices().length;
    const read = f.authorization.databaseGeneration;
    const clock = process.hrtime.bigint;
    let offset = 0n;
    const time = vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => clock() + offset);
    vi.spyOn(f.authorization, 'databaseGeneration').mockImplementationOnce(() => {
      const current = read();
      offset = 6_000_000_000n;
      return current;
    });
    const response = await redeem(invite.code);
    time.mockRestore();
    note('pairing expired callback budget', {
      status: response.status, returnedBearer: typeof response.json?.deviceToken === 'string',
      devicesAdded: f.repo.listCardSyncDevices().length - before, fence: readFence(f.controlDir, TEST_MACHINE).gate,
    });
    expect(response.status).toBe(409);
    expect(f.repo.listCardSyncDevices()).toHaveLength(before);
  });

  it('must refuse pairing when a separate process enters maintenance before the repository effect', async () => {
    const invite = await invitation();
    const before = f.repo.listCardSyncDevices().length;
    let effectMarker: string | undefined;
    const redeemCall = f.repo.redeemCardSyncPairing.bind(f.repo);
    vi.spyOn(f.repo, 'redeemCardSyncPairing').mockImplementation((...args) => {
      effectMarker = readMarker(f.controlDir)?.state;
      return redeemCall(...args);
    });
    const script = `
      import fs from 'node:fs';
      import { marker, serializeMarker } from ${JSON.stringify(new URL('../../control/lifecycle.ts', import.meta.url).href)};
      const dir = ${JSON.stringify(f.controlDir)};
      const staged = ${JSON.stringify(`${f.root}/review-maintenance-marker`)};
      fs.writeFileSync(staged, serializeMarker(marker({ state: 'maintenance', reason: 'deploy' }, 'synthetic review maintenance entry')),
        { mode: 0o600, flag: 'wx' });
      const prepared = fs.openSync(staged, fs.constants.O_RDONLY);
      fs.fsyncSync(prepared);
      fs.closeSync(prepared);
      const deadline = Date.now() + 5000;
      const timer = setInterval(() => {
        const pending = fs.readdirSync(dir).filter((name) => name.startsWith('sync-auth-state.tmp.'));
        const changing = pending.some((name) => {
          try {
            const fence = JSON.parse(fs.readFileSync(dir + '/' + name, 'utf8'));
            return fence.gate === 'blocked' && fence.reason === 'change';
          } catch { return false; }
        });
        if (changing) {
          clearInterval(timer);
          fs.renameSync(staged, dir + '/lifecycle-state');
          const directory = fs.openSync(dir, fs.constants.O_RDONLY);
          fs.fsyncSync(directory);
          fs.closeSync(directory);
          process.stdout.write('changed\\n');
          process.exit(0);
        }
        if (Date.now() >= deadline) { clearInterval(timer); process.exit(2); }
      }, 1);
      process.stdout.write('ready\\n');
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let ready = false;
    const completion = new Promise<number | null>((resolve) => child.once('exit', resolve));
    const readiness = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.stdout.on('data', (value) => {
        output += value.toString();
        if (!ready && output.includes('ready\n')) { ready = true; resolve(); }
      });
      child.stderr.resume();
      child.once('exit', () => { if (!ready) reject(Error('review fixture child exited before readiness')); });
    });
    try {
      await readiness;
      const response = await redeem(invite.code);
      const code = await completion;
      note('separate-process maintenance entry', {
        childExit: code, changed: output.includes('changed\n'), markerAtRepositoryEntry: effectMarker,
        markerAfter: readMarker(f.controlDir)?.state, status: response.status,
        returnedBearer: typeof response.json?.deviceToken === 'string',
        devicesAdded: f.repo.listCardSyncDevices().length - before, fence: readFence(f.controlDir, TEST_MACHINE).gate,
      });
      expect(code, 'the fixture must observe the actual change fence').toBe(0);
      expect(readMarker(f.controlDir)?.state).toBe('maintenance');
      // The new pre-call guard may stop even the read-only entry spy; a called method must receive the transactional hooks.
      expect(effectMarker === undefined || effectMarker === 'maintenance').toBe(true);
      expect(response.status).toBe(409);
      expect(f.repo.listCardSyncDevices()).toHaveLength(before);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await completion;
      }
    }
  }, 15_000);

  it('locks on the fifth bad guess, advances only then, and limits the trusted address to ten attempts', async () => {
    const invite = await invitation();
    const generation = f.w.generation();
    const before = f.repo.listCardSyncDevices().length;
    const repository = vi.spyOn(f.repo, 'redeemCardSyncPairing');
    const results: unknown[] = [];
    let lockedGeneration: string | undefined;
    for (let attempt = 1; attempt <= 11; attempt++) {
      const start = process.hrtime.bigint();
      const response = await redeem(randomCardSyncLetters());
      const milliseconds = Number(process.hrtime.bigint() - start) / 1e6;
      results.push({ attempt, status: response.status, error: response.json?.error, milliseconds });
      expect(response.status).toBe(attempt === 5 || attempt === 11 ? 429 : 401);
      if (attempt < 5) expect(f.w.generation()).toBe(generation);
      if (attempt === 5) {
        expect(f.w.generation()).not.toBe(generation);
        lockedGeneration = f.w.generation();
      }
      if (attempt > 5) expect(f.w.generation()).toBe(lockedGeneration);
      expect(f.repo.listCardSyncDevices()).toHaveLength(before);
    }
    expect(repository).toHaveBeenCalledTimes(10);
    expect(f.repo.getCardSyncPairing(invite.pairingId)?.failedAttempts).toBe(5);
    expect(f.repo.getCardSyncPairing(invite.pairingId)?.status).toBe('locked');
    note('pairing lock, timing and rate limit', results);
  });

  it('enforces real per-device daily run limits while preserving idempotency and the exact 24-hour edge', async () => {
    const limit = f.w.db.prepare("SELECT max_runs_per_device_day FROM card_sync_policy WHERE id = 'card-sync-policy'").pluck().get() as number;
    expect(limit).toBe(50);
    let first: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; attempt < limit; attempt++) {
      const run = await open();
      first ??= run;
      const aborted = await f.request('POST', `/card-sync/runs/${run.runId}/abort`, { reason: 'user-cancelled' }, headers());
      expect(aborted.status).toBe(200);
    }
    const clientRunId = `crn_${randomCardSyncLetters()}`;
    const body = { ...first!.body, clientRunId };
    const full = await f.request('POST', '/card-sync/runs', body, headers(clientRunId));
    expect(full.status).toBe(429);
    expect(full.json.error).toBe('run-rate-limited');
    const replay = await f.request('POST', '/card-sync/runs', first!.body, headers(first!.clientRunId));
    expect(replay.status).toBe(200);
    expect(replay.json.runId).toBe(first!.runId);
    const deadline = replay.json.expiresAt;
    f.w.tick(86_400);
    const nextDay = await f.request('POST', '/card-sync/runs', body, headers(clientRunId));
    expect(nextDay.status).toBe(200);
    const old = await f.request('POST', '/card-sync/runs', first!.body, headers(first!.clientRunId));
    expect(old.json.expiresAt).toBe(deadline);
    note('daily run rate and exact deadline', { limit, rejected: full.status, after24Hours: nextDay.status, replayDeadlineUnchanged: true });
  }, 30_000);

  it.each([
    { mode: 'dev', listener: 'local', port: OTHER_PORT },
    { mode: 'dist', listener: 'local', publicOrigin: 'https://holdr.test', port: OTHER_PORT },
    { mode: 'local', listener: 'local', port: OTHER_PORT },
    { mode: 'local', listener: 'ingress', port: OTHER_PORT, admission: { refusal: () => null } },
  ] satisfies ListenerConfig[])('refuses the actual $mode/$listener TCP profile on the other assigned port', async (config) => {
    const server = http.createServer(createRequestListener(f.app, config));
    const lookup = vi.spyOn(f.repo, 'findCardSyncDeviceByTokenDigest');
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(OTHER_PORT, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      const response = await deviceRawRequest(OTHER_PORT, 'GET', '/card-sync/capabilities', [
        ['Host', `127.0.0.1:${OTHER_PORT}`], ...headers(),
      ]);
      expect([403, 503]).toContain(response.status);
      expect(lookup).not.toHaveBeenCalled();
      note('real TCP profile', { mode: config.mode, listener: config.listener, status: response.status, error: response.json?.error });
    } finally { await closeServers([server]); }
  });

  it('bounds device prepared plans but still hands off a person-needed set before the quota and owner preconditions', async () => {
    f.w.ingest(device, binding, [row()]);
    for (let index = 0; index < 2; index++) {
      const sent = await upload();
      const prepared = await f.request('POST', '/card-sync/imports/preview', { runId: sent.runId, observationSetId: sent.setId }, headers());
      expect(prepared.status).toBe(200);
      expect(prepared.json.status).toBe('executable');
    }
    const third = await upload();
    const full = await f.request('POST', '/card-sync/imports/preview', { runId: third.runId, observationSetId: third.setId }, headers());
    expect(full.status).toBe(429);
    expect(full.json.error).toBe('plan-quota-exceeded');
    const fourth = await open();
    const bytes = wire(fourth.runId, f.w.payload(binding, [{ ...row(), id: 'review-new-row', amount: 5400 }]));
    const accepted = await f.request('POST', '/card-sync/observations', bytes, headers(fourth.clientRunId));
    expect(accepted.status).toBe(200);
    const plans = f.w.db.prepare('SELECT id, status FROM card_sync_commit_plans ORDER BY id').all();
    const handoff = await f.request('POST', '/card-sync/imports/preview', {
      runId: fourth.runId, observationSetId: accepted.json.observationSetId,
    }, headers());
    expect(handoff.status).toBe(200);
    expect(handoff.json.status).toBe('owner-review');
    expect(Object.keys(handoff.json).sort()).toEqual(['counts', 'observationSetId', 'reviewCount', 'status']);
    expect(f.w.db.prepare('SELECT id, status FROM card_sync_commit_plans ORDER BY id').all()).toEqual(plans);
    note('prepare quota and owner handoff ordering', { thirdExecutable: full.status, personNeeded: handoff.json.status, storedPlansUnchanged: true });
  });

  it('does not ACK a rolled-back commit and a retry commits exactly once', async () => {
    f.w.ingest(device, binding, [row()]);
    const sent = await upload();
    const plan = await f.request('POST', '/card-sync/imports/preview', { runId: sent.runId, observationSetId: sent.setId }, headers());
    expect(plan.json.status).toBe('executable');
    const body = { runId: sent.runId, previewId: plan.json.previewId, payloadDigest: plan.json.payloadDigest, planDigest: plan.json.planDigest };
    f.w.db.exec(`CREATE TEMP TRIGGER e2c_review_rollback BEFORE UPDATE OF state ON card_sync_observation_sets
      WHEN NEW.state = 'committed' BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_REVIEW_COMMIT_FAULT'); END`);
    const before = f.w.db.prepare('SELECT * FROM card_transactions').all();
    const failed = await f.request('POST', '/card-sync/imports/commit', body, headers());
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(failed.json.status).not.toBe('committed');
    expect(f.w.db.prepare('SELECT * FROM card_transactions').all()).toEqual(before);
    expect(f.w.db.prepare('SELECT status FROM card_sync_commit_plans WHERE id = ?').pluck().get(plan.json.previewId)).toBe('prepared');
    expect(failed.bytes.toString()).not.toContain('SYNTHETIC_REVIEW_COMMIT_FAULT');
    f.w.db.exec('DROP TRIGGER e2c_review_rollback');
    const success = await f.request('POST', '/card-sync/imports/commit', body, headers());
    expect(success.status).toBe(200);
    expect(success.json.status).toBe('committed');
    expect((await f.request('POST', '/card-sync/imports/commit', body, headers())).json).toEqual(success.json);
    expect(f.w.db.prepare('SELECT count(*) FROM card_transactions').pluck().get()).toBe(1);
    note('commit rollback and replay', { failedStatus: failed.status, retryStatus: success.status, rows: 1 });
  });

  it('resolves a lost successful commit ACK by replaying the stored result, not re-executing', async () => {
    f.w.ingest(device, binding, [row()]);
    const sent = await upload();
    const plan = await f.request('POST', '/card-sync/imports/preview', { runId: sent.runId, observationSetId: sent.setId }, headers());
    expect(plan.json.status).toBe('executable');
    const body = { runId: sent.runId, previewId: plan.json.previewId, payloadDigest: plan.json.payloadDigest, planDigest: plan.json.planDigest };
    const commit = f.repo.commitCardSyncPlan.bind(f.repo);
    vi.spyOn(f.repo, 'commitCardSyncPlan').mockImplementationOnce((input) => {
      commit(input);
      throw Error('SYNTHETIC_REVIEW_LOST_ACK');
    });
    const lost = await f.request('POST', '/card-sync/imports/commit', body, headers());
    expect(lost.status).toBe(500);
    const state = f.w.db.prepare('SELECT * FROM card_transactions').all();
    const retry = await f.request('POST', '/card-sync/imports/commit', body, headers());
    expect(retry.status).toBe(200);
    expect(retry.json.status).toBe('committed');
    expect(f.w.db.prepare('SELECT * FROM card_transactions').all()).toEqual(state);
    const receipt = await f.request('GET', `/card-sync/runs/${sent.runId}/receipt`, undefined, headers());
    expect(receipt.json.ledger).toBe('committed');
    const replay = await f.request('POST', '/card-sync/observations', sent.bytes, headers(sent.clientRunId));
    expect(replay.json.status).toBe('committed');
    note('lost commit ACK', { lostStatus: lost.status, retryStatus: retry.status, terminalUpload: replay.json.status });
  });

  it('uses wall-clock deadlines rather than retention for runs and pairings', async () => {
    const run = await open();
    f.w.tick(600);
    const response = await f.request('POST', '/card-sync/observations', wire(run.runId), headers(run.clientRunId));
    expect(response.status).toBe(410);
    expect(response.json.error).toBe('run-expired');
    expect(f.w.db.prepare('SELECT count(*) FROM card_sync_observation_sets').pluck().get()).toBe(0);
    const invite = await invitation();
    const count = f.repo.listCardSyncDevices().length;
    f.w.tick(300);
    const paired = await redeem(invite.code);
    expect(paired.status).toBe(401);
    expect(f.repo.listCardSyncDevices()).toHaveLength(count);
    note('run and pairing deadline edges', { upload: response.status, pairing: paired.status });
  });
});
