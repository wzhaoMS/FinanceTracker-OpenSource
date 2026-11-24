import fs from 'node:fs';
import http, { type IncomingMessage, type Server } from 'node:http';
import path from 'node:path';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAsyncRoute } from '../asyncRoute.js';
import {
  acquireExclusiveLease, acquireSharedLease, AUTHORIZATION_LOCK, LIFECYCLE_LOCK, lockPath, marker, readMarker, releaseLock,
  tryLock, withAuthorizationLock, writeMarker, leaseStillOn,
} from '../control/lifecycle.js';
import { fenceState, FENCE_FILE, readFence, writeFence } from '../control/syncAuthState.js';
import { blockFence } from '../control/recovery.js';
import { controlEnvFixture, TEST_MACHINE, waitFor } from '../control/testControl.js';
import { shortDir } from '../control/testDirs.js';
import {
  admitDeviceRequest, DeviceAdmissionRefusal, deviceApiConfigured, deviceTransportAllowed, MAX_DEVICE_CALLBACK_MS,
  type DeviceAdmission, type DeviceAuthorization,
} from './deviceAdmission.js';
import { createDeviceRouter, deviceRoute } from './deviceRouter.js';
import { resolveIngressConfig, type IngressConfig } from './config.js';
import { closeServers, rawRequest, SERVE_HEADERS, TEST_PORT, TEST_WEB_PORT } from './fixtures.js';
import { createRequestListener } from './server.js';
import type { IngressRefusal, ListenerConfig } from './types.js';

const GENERATION = `agn_${'a'.repeat(32)}`;
const NEXT = `agn_${'b'.repeat(32)}`;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
type Work = (req: Request, res: Response, authorization: DeviceAuthorization) => unknown;

function callbackRequest(socketPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get({
      socketPath, path: '/card-sync/check', headers: Object.fromEntries(SERVE_HEADERS), agent: false,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
    });
    request.once('error', reject);
    request.setTimeout(MAX_DEVICE_CALLBACK_MS + 5_000, () => request.destroy(Error('device callback deadline probe timed out')));
  });
}

function callbackClock() {
  const now = process.hrtime.bigint.bind(process.hrtime);
  let offset = 0n;
  const clock = vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => now() + offset);
  const restore = () => clock.mockRestore();
  cleanups.push(restore);
  return { expire: () => { offset = BigInt(MAX_DEVICE_CALLBACK_MS + 1) * 1_000_000n; }, restore };
}

function authorizationUnlocked(controlDir: string): boolean {
  const fd = tryLock(lockPath(controlDir, AUTHORIZATION_LOCK), 'exclusive');
  releaseLock(fd);
  return fd !== null;
}

async function fixture(options: { enabled?: string; work?: Work } = {}) {
  const ctl = await controlEnvFixture();
  const socket = shortDir();
  cleanups.push(ctl.cleanup, socket.cleanup);
  const socketPath = path.join(socket.dir, 's');
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'production', HOLDR_WEB_MODE: 'dist', PORT: String(TEST_PORT), HOLDR_PUBLIC_ORIGIN: 'https://holdr.test',
    HOLDR_SERVE_SOCKET: socketPath, HOLDR_WEB_RELEASE_DIR: socket.dir, HOLDR_WEB_RELEASE_DIGEST: 'a'.repeat(64),
    HOLDR_DATA_DIR: ctl.dataDir, HOLDR_CONTROL_DIR: ctl.controlDir,
    HOLDR_DEVICE_API: Object.hasOwn(options, 'enabled') ? options.enabled : '1',
  };
  const config = resolveIngressConfig(env);
  if (config.mode !== 'dist') throw Error('fixture mode');
  const lease = await acquireSharedLease(ctl.controlDir);
  cleanups.push(() => lease.release());
  let live = true;
  let available = true;
  let machine: string | null = TEST_MACHINE;
  let refusal: IngressRefusal | null = null;
  let lifecycleChecks = 0;
  const lifecycle = () => {
    lifecycleChecks++;
    return available ? { controlDir: ctl.controlDir, machine, leaseLive: () => live && leaseStillOn(lease, ctl.controlDir) } : null;
  };
  const source = { getCardSyncAuthorizationGeneration: vi.fn(() => GENERATION) };
  const errors: unknown[] = [];
  const app = express();
  const mount = express.Router();
  app.use('/card-sync', mount);
  app.use(((_error, _req, res, _next) => { errors.push(_error); res.status(500).json({ error: 'internal-error' }); }) as ErrorRequestHandler);
  const dispatcher = createRequestListener(app, {
    mode: 'dist', listener: 'ingress', socketPath, publicOrigin: config.publicOrigin, admission: { refusal: () => null },
  });
  const server = http.createServer(dispatcher);
  const mask = process.umask(0o077);
  try { await new Promise<void>((resolve) => server.listen(`${socketPath}`, resolve)); } finally { process.umask(mask); }
  cleanups.push(() => closeServers([server]));
  const attestation = { refusal: () => refusal };
  const factoryOptions = { config, env, serve: server, attestation, lifecycle, source };
  const admission = admitDeviceRequest(factoryOptions);
  const work = vi.fn(options.work ?? ((_req, res) => { res.json({ ok: true }); }));
  const router = createDeviceRouter(admission, [
    { method: 'get', path: '/check', handle: work },
    { method: 'post', path: '/check', handle: work },
  ]);
  mount.use(router);
  const putFence = (generation = GENERATION) => withAuthorizationLock(ctl.controlDir, () => writeFence(ctl.controlDir, fenceState({
    gate: 'open', reason: null, generation, next: null, op: null, machine: TEST_MACHINE,
  })));
  await putFence();
  return {
    ...ctl, app, config, env, server, socketPath, factoryOptions, admission, work, source, errors, putFence, lease,
    checks: () => lifecycleChecks,
    setMachine: (value: string | null) => { machine = value; },
    setLive: (value: boolean) => { live = value; },
    setAvailable: (value: boolean) => { available = value; },
    setRefusal: (value: IngressRefusal | null) => { refusal = value; },
    request: (extra: Array<[string, string]> = [], method = 'GET') => rawRequest(socketPath, method, '/card-sync/check', [...SERVE_HEADERS, ...extra]),
  };
}

describe.skipIf(process.platform !== 'darwin')('device admission, real authorization lock and per-request file reads', () => {
  it('admits the configured Serve request and carries only its generation into the callback', async () => {
    const f = await fixture();
    const request = await f.request([['Authorization', 'HoldrDevice synthetic-device-token']]);
    expect(request.status).toBe(200);
    expect(f.work).toHaveBeenCalledOnce();
    const [req, , authorization] = f.work.mock.calls[0];
    expect(req.headers.authorization).toBe('HoldrDevice synthetic-device-token');
    expect(authorization.generation).toBe(GENERATION);
    expect(authorization.assertCurrent).toBeTypeOf('function');
    expect(authorization.signal).toBeInstanceOf(AbortSignal);
    expect(Object.isFrozen(authorization)).toBe(true);
    expect(Object.isFrozen(f.admission)).toBe(true);
    expect(f.source.getCardSyncAuthorizationGeneration).toHaveBeenCalledOnce();
    expect(request.body.toString()).not.toContain(GENERATION);
    expect(deviceTransportAllowed(req, { refusal: () => null })).toBe(true);
    expect(deviceTransportAllowed(req)).toBe(false);
  });

  it.each(['0', undefined])('keeps disabled/missing deployment configuration closed (%j)', async (enabled) => {
    const f = await fixture({ enabled });
    const response = await f.request();
    expect(response.status).toBe(409);
    expect(response.body.toString()).toBe('{"error":"authorization-blocked"}');
    expect(f.work).not.toHaveBeenCalled();
    expect(f.source.getCardSyncAuthorizationGeneration).not.toHaveBeenCalled();
  });

  it('does not turn a later environment edit into a deployment switch', async () => {
    const f = await fixture({ enabled: '0' });
    f.env.HOLDR_DEVICE_API = '1';
    expect((await f.request()).status).toBe(409);
  });

  it.each(['ingress-unverified', 'ingress-refused'] as const)('checks live %s before any DB or work', async (refusal) => {
    const f = await fixture();
    f.setRefusal(refusal);
    const response = await f.request();
    expect(response.status).toBe(503);
    expect(response.headers['x-holdr-error']).toBe(refusal);
    expect(f.source.getCardSyncAuthorizationGeneration).not.toHaveBeenCalled();
    expect(f.work).not.toHaveBeenCalled();
  });

  it.each(['throws', 'unknown'] as const)('never treats an attestation %s as verified', async (kind) => {
    const f = await fixture();
    vi.spyOn(f.factoryOptions.attestation, 'refusal').mockImplementation(() => {
      if (kind === 'throws') throw Error('PRIVATE_CANARY');
      return undefined as never;
    });
    const response = await f.request();
    expect(response.status).toBe(503);
    expect(response.body.toString()).toBe('{"error":"ingress-unverified"}');
    expect(f.work).not.toHaveBeenCalled();
  });

  it.each(['stopped', 'not-ready', 'unknown-machine', 'different-machine'] as const)('refuses lifecycle/machine %s', async (failure) => {
    const f = await fixture();
    if (failure === 'stopped') f.setLive(false);
    if (failure === 'not-ready') f.setAvailable(false);
    if (failure === 'unknown-machine') f.setMachine(null);
    if (failure === 'different-machine') f.setMachine('b'.repeat(16));
    const response = await f.request();
    expect(response.status).toBe(409);
    expect(response.headers['x-holdr-error']).toBe('authorization-blocked');
    expect(f.work).not.toHaveBeenCalled();
    expect(f.source.getCardSyncAuthorizationGeneration).not.toHaveBeenCalled();
  });

  it.each(['missing', 'maintenance', 'invalid', 'permissions', 'symlink'] as const)('reads the marker anew: %s', async (failure) => {
    const f = await fixture();
    expect((await f.request()).status).toBe(200);
    const file = path.join(f.controlDir, 'lifecycle-state');
    if (failure === 'missing') fs.unlinkSync(file);
    if (failure === 'maintenance') writeMarker(f.controlDir, marker({ state: 'maintenance', reason: 'recovery' }, 'test'));
    if (failure === 'invalid') fs.writeFileSync(file, 'PRIVATE_CANARY');
    if (failure === 'permissions') fs.chmodSync(file, 0o644);
    if (failure === 'symlink') { fs.renameSync(file, `${file}.old`); fs.symlinkSync(`${file}.old`, file); }
    const response = await f.request();
    expect(response.status).toBe(409);
    expect(response.body.toString()).toBe('{"error":"authorization-blocked"}');
    expect(f.work).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'invalid', 'permissions', 'symlink', 'hardlink', 'machine', 'generation'] as const)('reads the fence anew: %s', async (failure) => {
    const f = await fixture();
    expect((await f.request()).status).toBe(200);
    const file = path.join(f.controlDir, FENCE_FILE);
    if (failure === 'missing') fs.unlinkSync(file);
    if (failure === 'invalid') fs.writeFileSync(file, 'PRIVATE_CANARY');
    if (failure === 'permissions') fs.chmodSync(file, 0o644);
    if (failure === 'symlink') { fs.renameSync(file, `${file}.old`); fs.symlinkSync(`${file}.old`, file); }
    if (failure === 'hardlink') fs.linkSync(file, `${file}.old`);
    if (failure === 'generation') await f.putFence(NEXT);
    if (failure === 'machine') await withAuthorizationLock(f.controlDir, () => {
      const fence = readFence(f.controlDir, TEST_MACHINE);
      if (fence.gate !== 'open') throw Error('fixture fence');
      writeFence(f.controlDir, fenceState({ ...fence.state, machine: 'b'.repeat(16) }));
    });
    const response = await f.request();
    expect(response.status).toBe(409);
    expect(response.body.toString()).toBe('{"error":"authorization-blocked"}');
    expect(f.work).toHaveBeenCalledTimes(1);
  });

  it.each(['init', 'reinit', 'incident', 'change', 'recovery'] as const)('refuses blocked/%s without doing work', async (reason) => {
    const f = await fixture();
    await withAuthorizationLock(f.controlDir, () => writeFence(f.controlDir, fenceState({
      gate: 'blocked', reason, generation: reason === 'init' || reason === 'reinit' ? null : GENERATION,
      next: reason === 'change' || reason === 'recovery' ? NEXT : null,
      op: reason === 'change' || reason === 'recovery' ? 'a'.repeat(16) : null, machine: TEST_MACHINE,
    })));
    expect((await f.request()).status).toBe(409);
    expect(f.work).not.toHaveBeenCalled();
  });

  it.each([NEXT, '', 'not-a-generation', undefined, 1])('fails closed for a DB generation mismatch or invalid value (%j)', async (value) => {
    const f = await fixture();
    f.source.getCardSyncAuthorizationGeneration.mockReturnValue(value as string);
    expect((await f.request()).status).toBe(409);
    expect(f.work).not.toHaveBeenCalled();
  });

  it('maps DB acquisition failures to a value-free refusal, but preserves a work refusal exactly', async () => {
    const f = await fixture();
    f.source.getCardSyncAuthorizationGeneration.mockImplementation(() => { throw Error('PRIVATE_CANARY'); });
    const failure = await f.request();
    expect(failure.status).toBe(409);
    expect(failure.body.toString()).not.toContain('PRIVATE_CANARY');
    expect(f.errors).toEqual([]);
    f.source.getCardSyncAuthorizationGeneration.mockReturnValue(GENERATION);
    const refusal = Object.freeze({ code: 'repository-refusal' });
    f.work.mockImplementation(() => { throw refusal; });
    expect((await f.request()).status).toBe(500);
    expect(f.errors).toEqual([refusal]);
    f.work.mockRejectedValueOnce(refusal);
    expect((await f.request()).status).toBe(500);
    expect(f.errors).toEqual([refusal, refusal]);
    const fd = tryLock(lockPath(f.controlDir, AUTHORIZATION_LOCK), 'exclusive');
    expect(fd).not.toBeNull();
    releaseLock(fd);
  });

  it('holds authorization.lock across generation lookup and the entire awaited callback', async () => {
    let entered = false;
    let finish!: () => void;
    const complete = new Promise<void>((resolve) => { finish = resolve; });
    const f = await fixture({ work: async (_req, res) => { entered = true; await complete; res.json({ ok: true }); } });
    f.source.getCardSyncAuthorizationGeneration.mockImplementation(() => {
      expect(tryLock(lockPath(f.controlDir, AUTHORIZATION_LOCK), 'exclusive')).toBeNull();
      return GENERATION;
    });
    const response = f.request();
    await waitFor(() => entered);
    expect(tryLock(lockPath(f.controlDir, AUTHORIZATION_LOCK), 'exclusive')).toBeNull();
    finish();
    expect((await response).status).toBe(200);
    const fd = tryLock(lockPath(f.controlDir, AUTHORIZATION_LOCK), 'exclusive');
    expect(fd).not.toBeNull();
    releaseLock(fd);
  });

  it('rejects nested authorization and exclusive lifecycle acquisition immediately, including after an await', async () => {
    const f = await fixture({ work: async (_req, res) => {
      await Promise.resolve();
      const started = performance.now();
      await expect(withAuthorizationLock(f.controlDir, () => { throw Error('must not run'); })).rejects
        .toMatchObject({ code: 'E0I_DEVICE_LOCK_REENTRANCY' });
      await expect(acquireExclusiveLease(f.controlDir, 10_000)).rejects.toMatchObject({ code: 'E0I_DEVICE_LOCK_REENTRANCY' });
      expect(() => tryLock(lockPath(f.controlDir, AUTHORIZATION_LOCK), 'shared')).toThrow('E0I_DEVICE_LOCK_REENTRANCY');
      expect(() => tryLock(lockPath(f.controlDir, LIFECYCLE_LOCK), 'exclusive')).toThrow('E0I_DEVICE_LOCK_REENTRANCY');
      expect(performance.now() - started).toBeLessThan(500);
      res.json({ ok: true });
    } });
    expect((await f.request()).status).toBe(200);
    expect(f.errors).toEqual([]);
  });

  it.each(['attestation', 'marker', 'fence', 'lease', 'generation'] as const)('at-effect recheck refuses a post-await %s change', async (changed) => {
    let entered = false;
    let finish!: () => void;
    const complete = new Promise<void>((resolve) => { finish = resolve; });
    let effects = 0;
    const f = await fixture({ work: async (_req, res, authorization) => {
      entered = true;
      await complete;
      authorization.assertCurrent();
      effects++;
      res.json({ ok: true });
    } });
    const response = f.request();
    await waitFor(() => entered);
    if (changed === 'attestation') f.setRefusal('ingress-unverified');
    if (changed === 'marker') writeMarker(f.controlDir, marker({ state: 'maintenance', reason: 'recovery' }, 'test'));
    if (changed === 'fence') writeFence(f.controlDir, fenceState({
      gate: 'blocked', reason: 'incident', generation: GENERATION, next: null, op: null, machine: TEST_MACHINE,
    }));
    if (changed === 'lease') f.lease.release();
    if (changed === 'generation') f.source.getCardSyncAuthorizationGeneration.mockReturnValue(NEXT);
    finish();
    expect((await response).status).toBe(changed === 'attestation' ? 503 : 409);
    expect(effects).toBe(0);
  });

  it('rechecks at-effect under the same held lock and invalidates a saved authorization after callback completion', async () => {
    let saved!: DeviceAuthorization;
    const f = await fixture({ work: async (_req, res, authorization) => {
      saved = authorization;
      await Promise.resolve();
      authorization.assertCurrent();
      res.json({ ok: true });
    } });
    expect((await f.request()).status).toBe(200);
    expect(f.source.getCardSyncAuthorizationGeneration).toHaveBeenCalledTimes(2);
    expect(() => saved.assertCurrent()).toThrow('authorization-blocked');
    const fd = tryLock(lockPath(f.controlDir, AUTHORIZATION_LOCK), 'exclusive');
    expect(fd).not.toBeNull();
    releaseLock(fd);
  });

  it.each(['cooperative', 'pending'] as const)('deadline fences %s work but external blockFence still needs the lock', async (kind) => {
    let entered = false;
    let finish!: () => void;
    const complete = new Promise<void>((resolve) => { finish = resolve; });
    let effects = 0;
    const f = await fixture({ work: async (_req, res, authorization) => {
      if (kind === 'cooperative') authorization.signal.addEventListener('abort', finish, { once: true });
      entered = true;
      await complete;
      authorization.assertCurrent();
      effects++;
      res.json({ ok: true });
    } });
    const response = callbackRequest(f.socketPath);
    await waitFor(() => entered);
    const externalBlock = blockFence(f.controlDir, TEST_MACHINE).then(
      (result) => ({ result }), (error: { code: string }) => ({ code: error.code }),
    );
    try {
      expect((await response).status).toBe(409);
      expect(readFence(f.controlDir, TEST_MACHINE)).toMatchObject({ gate: 'closed', reason: 'blocked:incident' });
      expect(authorizationUnlocked(f.controlDir)).toBe(kind === 'cooperative');
      expect((await f.request()).status).toBe(409);
      expect(await externalBlock).toEqual(kind === 'cooperative' ? { result: 'already-blocked' } : { code: 'E0I_AUTHORIZATION_BUSY' });
      expect(authorizationUnlocked(f.controlDir)).toBe(kind === 'cooperative');
    } finally { finish(); }
    await waitFor(() => authorizationUnlocked(f.controlDir));
    expect(effects).toBe(0);
    expect(f.errors).toEqual([]);
  }, 20_000);

  it.each(['return', 'throw', 'reject'] as const)('D r2 checks the deadline on an overdue %s before releasing authorization', async (exit) => {
    let saved!: DeviceAuthorization;
    const f = await fixture({ work: (_req, _res, authorization) => {
      saved = authorization;
      authorization.assertCurrent();
      clock.expire();
      if (exit === 'throw') throw Error('PRIVATE_CANARY');
      if (exit === 'reject') return Promise.reject(Error('PRIVATE_CANARY'));
      return 'completed';
    } });
    const clock = callbackClock();
    expect((await f.request()).status).toBe(409);
    clock.restore();
    expect(saved.signal.aborted).toBe(true);
    expect(saved.signal.reason).toBeInstanceOf(DeviceAdmissionRefusal);
    expect(saved.signal.reason).toMatchObject({ status: 409, code: 'authorization-blocked' });
    expect(() => saved.assertCurrent()).toThrow('authorization-blocked');
    expect(readFence(f.controlDir, TEST_MACHINE)).toMatchObject({ gate: 'closed', reason: 'blocked:incident' });
    expect(authorizationUnlocked(f.controlDir)).toBe(true);
    expect(f.errors).toEqual([]);
    expect((await f.request()).status).toBe(409);
    expect(f.work).toHaveBeenCalledOnce();
  });

  it('D r2 quarantines the real-clock synchronous over-budget throw before the delayed timer can run', async () => {
    let saved!: DeviceAuthorization;
    let abortedBeforeThrow = true;
    let elapsed = 0;
    const f = await fixture({ work: (_req, _res, authorization) => {
      saved = authorization;
      authorization.assertCurrent();
      const start = performance.now();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, MAX_DEVICE_CALLBACK_MS + 150);
      elapsed = performance.now() - start;
      abortedBeforeThrow = authorization.signal.aborted;
      throw Error('PRIVATE_CANARY synchronous failure');
    } });
    const response = await callbackRequest(f.socketPath);
    expect(elapsed).toBeGreaterThanOrEqual(MAX_DEVICE_CALLBACK_MS);
    expect(abortedBeforeThrow).toBe(false);
    expect(response).toEqual({ status: 409, body: '{"error":"authorization-blocked"}' });
    expect(saved.signal.aborted).toBe(true);
    expect(readFence(f.controlDir, TEST_MACHINE)).toMatchObject({ gate: 'closed', reason: 'blocked:incident' });
    expect(authorizationUnlocked(f.controlDir)).toBe(true);
    expect(f.errors).toEqual([]);
    expect((await f.request()).status).toBe(409);
    expect(f.work).toHaveBeenCalledOnce();
  }, MAX_DEVICE_CALLBACK_MS + 10_000);

  it('D r2 rejects lock reentrancy in timer-fired abort listeners and their awaited continuations', async () => {
    let finish!: () => void;
    const checked = new Promise<void>((resolve) => { finish = resolve; });
    let observed: { direct: unknown[]; nested: PromiseSettledResult<unknown>[]; elapsed: number } | undefined;
    const f = await fixture({ work: async (_req, _res, authorization) => {
      authorization.signal.addEventListener('abort', () => {
        const start = performance.now();
        const direct = ([
          [AUTHORIZATION_LOCK, 'shared'], [AUTHORIZATION_LOCK, 'exclusive'], [LIFECYCLE_LOCK, 'exclusive'],
        ] as const).map(([file, mode]) => {
          try {
            const fd = tryLock(lockPath(f.controlDir, file), mode);
            releaseLock(fd);
            return fd === null ? 'busy' : 'acquired';
          } catch (error) { return (error as { code: string }).code; }
        });
        void Promise.resolve().then(async () => {
          const nested = await Promise.allSettled([
            withAuthorizationLock(f.controlDir, () => { throw Error('nested work must not run'); }, 120),
            acquireExclusiveLease(f.controlDir, 120).then((lease) => { lease?.release(); }),
          ]);
          observed = { direct, nested, elapsed: performance.now() - start };
          finish();
        });
      }, { once: true });
      await checked;
      authorization.assertCurrent();
    } });
    try {
      expect((await callbackRequest(f.socketPath)).status).toBe(409);
      await checked;
      expect(observed?.direct).toEqual(Array(3).fill('E0I_DEVICE_LOCK_REENTRANCY'));
      expect(observed?.nested).toMatchObject(Array(2).fill({
        status: 'rejected', reason: { code: 'E0I_DEVICE_LOCK_REENTRANCY' },
      }));
      expect(observed?.elapsed).toBeLessThan(500);
    } finally { finish(); }
    await waitFor(() => authorizationUnlocked(f.controlDir));
    expect(f.errors).toEqual([]);
  }, MAX_DEVICE_CALLBACK_MS + 5_000);

  it.each(['init', 'reinit', 'incident', 'change', 'recovery'] as const)('D r2 preserves an existing blocked/%s fence on overdue rejection', async (reason) => {
    const state = fenceState({
      gate: 'blocked', reason, generation: reason === 'init' || reason === 'reinit' ? null : GENERATION,
      next: reason === 'change' || reason === 'recovery' ? NEXT : null,
      op: reason === 'change' || reason === 'recovery' ? 'a'.repeat(16) : null, machine: TEST_MACHINE,
    });
    const f = await fixture({ work: () => {
      writeFence(f.controlDir, state);
      clock.expire();
      throw Error('PRIVATE_CANARY');
    } });
    const clock = callbackClock();
    expect((await f.request()).status).toBe(409);
    clock.restore();
    expect(readFence(f.controlDir, TEST_MACHINE).state).toEqual(state);
    expect(authorizationUnlocked(f.controlDir)).toBe(true);
    expect(f.errors).toEqual([]);
  });

  it('D r2 permanently closes this guard if deadline fence persistence fails', async () => {
    const f = await fixture({ work: () => { clock.expire(); throw Error('PRIVATE_CANARY'); } });
    const clock = callbackClock();
    const rename = fs.renameSync;
    const writeFailure = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === path.join(f.controlDir, FENCE_FILE)) throw Error('synthetic fence write failure');
      return rename(from, to);
    });
    cleanups.push(() => writeFailure.mockRestore());
    expect((await f.request()).status).toBe(409);
    clock.restore();
    writeFailure.mockRestore();
    expect(f.work.mock.calls[0][2].signal.aborted).toBe(true);
    expect(readFence(f.controlDir, TEST_MACHINE).gate).toBe('open');
    expect(authorizationUnlocked(f.controlDir)).toBe(true);
    await f.putFence();
    expect((await f.request()).status).toBe(409);
    expect(f.work).toHaveBeenCalledOnce();
    expect(f.errors).toEqual([]);
  });

  it.each(['missing', 'invalid', 'machine'] as const)('D r2 latches closed if deadline fencing cannot trust a %s fence', async (failure) => {
    const f = await fixture({ work: () => {
      if (failure === 'missing') fs.unlinkSync(path.join(f.controlDir, FENCE_FILE));
      if (failure === 'invalid') fs.writeFileSync(path.join(f.controlDir, FENCE_FILE), 'synthetic invalid fence');
      if (failure === 'machine') writeFence(f.controlDir, fenceState({
        gate: 'open', reason: null, generation: GENERATION, next: null, op: null, machine: 'b'.repeat(16),
      }));
      clock.expire();
      throw Error('PRIVATE_CANARY');
    } });
    const clock = callbackClock();
    expect((await f.request()).status).toBe(409);
    clock.restore();
    expect(f.work.mock.calls[0][2].signal.aborted).toBe(true);
    expect(readFence(f.controlDir, TEST_MACHINE)).toMatchObject({
      gate: 'closed', reason: failure === 'machine' ? 'machine-changed' : failure,
    });
    expect(authorizationUnlocked(f.controlDir)).toBe(true);
    await f.putFence();
    expect((await f.request()).status).toBe(409);
    expect(f.work).toHaveBeenCalledOnce();
    expect(f.errors).toEqual([]);
  });

  it('D r2 refuses the next effect after expiry but cannot roll back an earlier independent effect', async () => {
    const f = await fixture({ work: async (_req, _res, authorization) => {
      authorization.assertCurrent();
      fs.appendFileSync(path.join(f.dataDir, 'effects'), 'first\n', { mode: 0o600 });
      await Promise.resolve();
      clock.expire();
      authorization.assertCurrent();
      fs.appendFileSync(path.join(f.dataDir, 'effects'), 'second\n');
    } });
    const clock = callbackClock();
    expect((await f.request()).status).toBe(409);
    clock.restore();
    expect(fs.readFileSync(path.join(f.dataDir, 'effects'), 'utf8')).toBe('first\n');
    expect(readFence(f.controlDir, TEST_MACHINE)).toMatchObject({ gate: 'closed', reason: 'blocked:incident' });
    expect(f.errors).toEqual([]);
  });

  it('at-effect expires synchronously when a blocked event loop has not run the deadline timer', async () => {
    let effects = 0;
    const f = await fixture({ work: (_req, _res, authorization) => {
      const beyond = process.hrtime.bigint() + BigInt(MAX_DEVICE_CALLBACK_MS + 1) * 1_000_000n;
      const clock = vi.spyOn(process.hrtime, 'bigint').mockReturnValue(beyond);
      try {
        authorization.assertCurrent();
        effects++;
      } finally { clock.mockRestore(); }
    } });
    expect((await f.request()).status).toBe(409);
    expect(effects).toBe(0);
    expect(readFence(f.controlDir, TEST_MACHINE)).toMatchObject({ gate: 'closed', reason: 'blocked:incident' });
  });

  it.each(['fence', 'marker', 'lease', 'attestation'] as const)('rechecks %s after waiting for authorization.lock', async (changed) => {
    const f = await fixture();
    let fd = tryLock(lockPath(f.controlDir, AUTHORIZATION_LOCK), 'exclusive');
    expect(fd).not.toBeNull();
    cleanups.push(() => releaseLock(fd));
    const pending = f.request();
    await waitFor(() => f.checks() > 0);
    if (changed === 'fence') writeFence(f.controlDir, fenceState({
      gate: 'blocked', reason: 'incident', generation: GENERATION, next: null, op: null, machine: TEST_MACHINE,
    }));
    if (changed === 'marker') writeMarker(f.controlDir, marker({ state: 'maintenance', reason: 'recovery' }, 'test'));
    if (changed === 'lease') f.setLive(false);
    if (changed === 'attestation') f.setRefusal('ingress-unverified');
    releaseLock(fd);
    fd = null;
    const response = await pending;
    expect(response.status).toBe(changed === 'attestation' ? 503 : 409);
    expect(f.work).not.toHaveBeenCalled();
  });

  it('cannot accept an attestation that expires during the final DB read', async () => {
    const f = await fixture();
    f.source.getCardSyncAuthorizationGeneration.mockImplementation(() => { f.setRefusal('ingress-unverified'); return GENERATION; });
    expect((await f.request()).status).toBe(503);
    expect(f.work).not.toHaveBeenCalled();
  });

  it.each(['fence', 'marker'] as const)('refuses a mid-request %s flip after the first gate read but before the handler', async (changed) => {
    const f = await fixture();
    f.source.getCardSyncAuthorizationGeneration.mockImplementation(() => {
      if (changed === 'fence') {
        writeFence(f.controlDir, fenceState({
          gate: 'blocked', reason: 'incident', generation: GENERATION, next: null, op: null, machine: TEST_MACHINE,
        }));
      } else {
        writeMarker(f.controlDir, marker({ state: 'maintenance', reason: 'recovery' }, 'test'));
      }
      return GENERATION;
    });
    const response = await f.request();
    expect(response.status).toBe(409);
    expect(response.headers['x-holdr-error']).toBe('authorization-blocked');
    expect(f.source.getCardSyncAuthorizationGeneration).toHaveBeenCalledOnce();
    expect(f.work).not.toHaveBeenCalled();
  });

  it('refuses a missing authorization lock and never creates it', async () => {
    const f = await fixture();
    fs.unlinkSync(lockPath(f.controlDir, AUTHORIZATION_LOCK));
    expect((await f.request()).status).toBe(409);
    expect(fs.existsSync(lockPath(f.controlDir, AUTHORIZATION_LOCK))).toBe(false);
    expect(f.work).not.toHaveBeenCalled();
  });

  it('does not infer provenance from forged frozen facts or a request from a different server', async () => {
    const f = await fixture();
    const req = new http.IncomingMessage(new (await import('node:net')).Socket());
    Object.defineProperty(req, 'holdrIngress', { value: Object.freeze({
      listener: 'ingress', profile: 'serve', mode: 'dist', clientAddress: '100.64.0.2',
    }) });
    expect(deviceTransportAllowed(req, { refusal: () => null })).toBe(true);
    await expect(f.admission.admit(req, () => 'not-called')).rejects.toMatchObject({ status: 403, code: 'device-transport-refused' });
    expect(f.source.getCardSyncAuthorizationGeneration).not.toHaveBeenCalled();
  });

  it.each([
    { mode: 'dev', listener: 'local', port: TEST_PORT },
    { mode: 'dist', listener: 'local', publicOrigin: 'https://holdr.test', port: TEST_PORT },
    { mode: 'local', listener: 'local', port: TEST_PORT },
    { mode: 'local', listener: 'ingress', port: TEST_PORT, admission: { refusal: () => null } },
  ] satisfies ListenerConfig[])('refuses the real $mode/$listener TCP profile', async (config) => {
    const f = await fixture();
    const server = http.createServer(createRequestListener(f.app, config));
    const port = TEST_PORT;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    cleanups.push(() => closeServers([server]));
    const response = await rawRequest(port, 'GET', '/card-sync/check', [['Host', `127.0.0.1:${port}`]]);
    expect(response.status).toBe(403);
    expect(response.body.toString()).toBe('{"error":"device-transport-refused"}');
    expect(f.work).not.toHaveBeenCalled();
    expect(f.source.getCardSyncAuthorizationGeneration).not.toHaveBeenCalled();
  });

  it('refuses a different live Serve socket even when its frozen profile and forwarding headers match', async () => {
    const f = await fixture();
    const other = shortDir();
    cleanups.push(other.cleanup);
    const socketPath = path.join(other.dir, 's');
    const server = http.createServer(createRequestListener(f.app, {
      mode: 'dist', listener: 'ingress', publicOrigin: f.config.publicOrigin, socketPath, admission: { refusal: () => null },
    }));
    await new Promise<void>((resolve) => server.listen(`${socketPath}`, resolve));
    cleanups.push(() => closeServers([server]));
    const response = await rawRequest(socketPath, 'GET', '/card-sync/check', SERVE_HEADERS);
    expect(response.status).toBe(403);
    expect(f.work).not.toHaveBeenCalled();
  });

  it('bounds an unavailable authorization lock and performs no work after the timeout', async () => {
    const f = await fixture();
    const fd = tryLock(lockPath(f.controlDir, AUTHORIZATION_LOCK), 'exclusive');
    expect(fd).not.toBeNull();
    try {
      const response = await new Promise<{ status: number; code?: string }>((resolve, reject) => {
        const request = http.get({
          socketPath: f.socketPath, path: '/card-sync/check', headers: Object.fromEntries(SERVE_HEADERS), agent: false,
        }, (res) => {
          res.resume();
          res.once('end', () => resolve({ status: res.statusCode!, code: res.headers['x-holdr-error'] as string | undefined }));
        });
        request.once('error', reject);
        request.setTimeout(15_000, () => request.destroy(Error('device timeout probe timed out')));
      });
      expect(response.status).toBe(409);
      expect(response.code).toBe('authorization-blocked');
      expect(f.source.getCardSyncAuthorizationGeneration).not.toHaveBeenCalled();
      expect(f.work).not.toHaveBeenCalled();
    } finally { releaseLock(fd); }
  }, 20_000);

  it('never reuses a formerly admitted generation after the DB is restored behind the fence', async () => {
    const f = await fixture();
    expect((await f.request()).status).toBe(200);
    await f.putFence(NEXT);
    f.source.getCardSyncAuthorizationGeneration.mockReturnValue(NEXT);
    expect((await f.request()).status).toBe(200);
    f.source.getCardSyncAuthorizationGeneration.mockReturnValue(GENERATION);
    expect((await f.request()).status).toBe(409);
    expect(f.work).toHaveBeenCalledTimes(2);
  });

  it('emits the same value-free headers on HEAD refusal without a body', async () => {
    const f = await fixture();
    f.setLive(false);
    const response = await f.request([], 'HEAD');
    expect(response.status).toBe(409);
    expect(response.headers['x-holdr-error']).toBe('authorization-blocked');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.body.length).toBe(0);
  });

  it('does not let Express automatic OPTIONS bypass a blocked fence', async () => {
    const f = await fixture();
    f.setLive(false);
    const blocked = await f.request([], 'OPTIONS');
    expect(blocked.status).toBe(409);
    expect(blocked.headers['x-holdr-error']).toBe('authorization-blocked');
    f.setLive(true);
    expect((await f.request([], 'OPTIONS')).status).toBe(405);
    expect(f.work).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform !== 'darwin')('DeviceAdmission construction and configuration', () => {
  it.each(['dev', 'local'] as const)('cannot construct or mount a %s device router even with the deployment flag', async (mode) => {
    const f = await fixture();
    const config: IngressConfig = mode === 'dev'
      ? { mode, host: '127.0.0.1', port: TEST_PORT }
      : { ...f.config, mode, ingressPort: TEST_WEB_PORT };
    expect(() => admitDeviceRequest({ ...f.factoryOptions, config })).toThrow('E0I_DEVICE_ADMISSION');
  });

  it('requires an already-listening configured socket and rejects a forged branded value', async () => {
    const f = await fixture();
    expect(() => admitDeviceRequest({ ...f.factoryOptions, serve: http.createServer() })).toThrow('E0I_DEVICE_ADMISSION');
    expect(() => admitDeviceRequest({ ...f.factoryOptions, config: { ...f.config, socketPath: `${f.socketPath}other` } })).toThrow('E0I_DEVICE_ADMISSION');
    expect(() => createDeviceRouter({} as DeviceAdmission, [])).toThrow('E0I_DEVICE_ADMISSION');
    expect(() => deviceRoute({ ...f.admission }, () => undefined)).toThrow('E0I_DEVICE_ADMISSION');
    expect(isAsyncRoute(deviceRoute(f.admission, () => undefined))).toBe(true);
  });

  it('checks exact deployment values and a canonical HTTPS origin', async () => {
    const f = await fixture();
    for (const flag of [undefined, '0', '', 'true', ' 1', '1 ']) expect(deviceApiConfigured(f.config, { HOLDR_DEVICE_API: flag })).toBe(false);
    for (const origin of ['http://holdr.test', 'https://holdr.test/', 'https://holdr.test:444', 'https://127.0.0.1', 'https://a@holdr.test']) {
      expect(deviceApiConfigured({ ...f.config, publicOrigin: origin }, f.env)).toBe(false);
    }
    expect(deviceApiConfigured(f.config, f.env)).toBe(true);
    expect(readMarker(f.controlDir)?.state).toBe('normal');
  });
});

// These are compilation regressions, not casts accepted at the executable boundary.
function typeContract(serve: Server, req: IncomingMessage) {
  void serve; void req;
  // @ts-expect-error A structural object cannot construct the private brand.
  const forged: DeviceAdmission = { admit: async () => undefined };
  // @ts-expect-error E2 cannot call the router factory without its admission.
  createDeviceRouter([]);
  void forged;
}
void typeContract;
