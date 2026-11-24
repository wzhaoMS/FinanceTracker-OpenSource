import fs from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import express, { type Express, type RequestHandler } from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { AUTHORIZATION_LOCK, lockPath, marker, releaseLock, tryLock, withAuthorizationLock, writeMarker } from '../control/lifecycle.js';
import { createProductionRuntime, type ProviderFactory } from '../control/runtimeIntegration.js';
import { fenceState, writeFence } from '../control/syncAuthState.js';
import { controlEnvFixture, FAKE_MACHINE, fakeSystem, waitFor } from '../control/testControl.js';
import { shortDir } from '../control/testDirs.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { assertDeviceRoutesGuarded } from '../testing/deviceRoutes.js';
import { attestOnce, createAttestationPoller, createAttestationState } from './attestation.js';
import { fakeTailscale } from './cliFixtures.js';
import { resolveIngressConfig } from './config.js';
import { admitDeviceRequest, type CardSyncGenerationSource } from './deviceAdmission.js';
import { createDeviceRouter } from './deviceRouter.js';
import { createVerifiedRouter } from './expressIdentity.js';
import { closeServers, rawRequest, releaseFixture, SERVE_HEADERS, TEST_PORT } from './fixtures.js';
import { nativeFixture } from './nativeFixtures.js';
import { verifyPinnedNativeHelper } from './nativeHelper.js';
import { assertVerifiedRuntime } from './safetyProviders.js';
import { canonicalServeJson } from './serveConfig.js';
import { startIngressServers } from './server.js';
import { createSocketSafety } from './socketPath.js';
import { prepareIngress } from './startupChecks.js';

const PIN = { majorMinorPatch: '1.98.3', long: 'synthetic-device-admission-build' };
const NEXT = `agn_${'p'.repeat(32)}`;

/** Reserve E2's future position on the actual app; production D deliberately mounts no E2 endpoint. */
function reserveDeviceMount(app: Express, identify: RequestHandler) {
  const mount = createVerifiedRouter();
  app.use('/card-sync', mount);
  const stack = (app as unknown as { _router: { stack: Array<{ handle: unknown }> } })._router.stack;
  const layer = stack.pop()!;
  const beforeIdentify = stack.findIndex((entry) => entry.handle === identify);
  if (beforeIdentify < 0) throw Error('actual identify middleware not found');
  stack.splice(beforeIdentify, 0, layer);
  return mount;
}

describe.skipIf(process.platform !== 'darwin')('D composed with B lifecycle, A2 native/attestation and a real v15 DB', () => {
  let native: ReturnType<typeof nativeFixture>;
  beforeAll(() => { native = nativeFixture(); }, 120_000);
  afterAll(() => native?.cleanup());
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

  it('admits only the bound dist request, with live lifecycle evidence and fresh locked DB/fence reads', async () => {
    const ctl = await controlEnvFixture({ machine: FAKE_MACHINE });
    const release = releaseFixture();
    const socket = shortDir();
    const cliDir = shortDir();
    cleanups.push(ctl.cleanup, release.cleanup, socket.cleanup, cliDir.cleanup);
    const socketPath = path.join(socket.dir, 's');
    const cli = fakeTailscale(cliDir.dir);
    const approved = {
      version: JSON.stringify({ ...PIN, daemonLong: PIN.long }),
      status: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'holdr.test.' }, CertDomains: ['holdr.test'] }),
      serve: canonicalServeJson('dist', { host: 'holdr.test', socketPath }),
    };
    cli.set({ ...approved, serve: '{}\n' });
    let created: ReturnType<ProviderFactory> | undefined;
    // Exactly B's composed-test seam: real A2 components, a fixture binary and an explicitly test-only version pin.
    const providerFactory: ProviderFactory = (options) => {
      assertVerifiedRuntime();
      const pin = { ...options.native, buildDir: native.native.buildDir };
      verifyPinnedNativeHelper(pin);
      const pathcheck = createSocketSafety({ socketPath: options.expectations.socketPath, native: pin });
      const state = createAttestationState({ mode: options.mode });
      const poller = createAttestationPoller(state, () => attestOnce({
        mode: options.mode, cli: options.cli, expectations: options.expectations, supported: [PIN],
        checkPath: async () => {
          const result = await pathcheck.inspect('poll');
          return {
            ok: result.ok,
            codes: result.findings.map((finding) => finding.code === 'socket-replaced' || finding.code === 'socket-missing'
              ? finding.code : 'socket-path-unsafe'),
          };
        },
      }));
      created = {
        admission: state.admission, socketSafety: pathcheck.safety, preflightSocket: pathcheck.preflight,
        state: state.view, pollOnce: poller.pollOnce, start: poller.start, stop: poller.stop,
      };
      return created;
    };
    const env = {
      NODE_ENV: 'production', HOLDR_WEB_MODE: 'dist', PORT: String(TEST_PORT), HOLDR_PUBLIC_ORIGIN: 'https://holdr.test',
      HOLDR_SERVE_SOCKET: socketPath, HOLDR_WEB_RELEASE_DIR: release.dir, HOLDR_WEB_RELEASE_DIGEST: release.digest,
      HOLDR_DATA_DIR: ctl.dataDir, HOLDR_CONTROL_DIR: ctl.controlDir, HOLDR_DEVICE_API: '1',
      HOLDR_TAILSCALE_CLI: cli.cli, HOLDR_NATIVE_COMMIT: native.native.sourceCommit, HOLDR_NATIVE_MANIFEST: native.native.manifestDigest,
    };
    const config = resolveIngressConfig(env);
    if (config.mode !== 'dist') throw Error('fixture mode');
    const runtime = createProductionRuntime({ env, config, conf: null, run: fakeSystem, log() {}, providerFactory });
    cleanups.push(() => runtime.stop());
    expect(runtime.lifecycleEvidence()).toBeNull();
    const prepared = await prepareIngress(config, runtime.integration);
    const evidence = runtime.lifecycleEvidence()!;
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(evidence.machine).toBe(FAKE_MACHINE);
    expect(evidence.leaseLive()).toBe(true);

    const repo = new SqliteStateRepo({ file: path.join(ctl.dataDir, 'finance.db') });
    let dbClosed = false;
    cleanups.push(() => { if (!dbClosed) repo.close(); });
    expect(repo.schemaVersion()).toBe(15);
    const readGeneration = () => (repo.internalGetDb().prepare(
      "SELECT authorization_generation AS generation FROM card_sync_policy WHERE id = 'card-sync-policy'",
    ).get() as { generation: string }).generation;
    let reads = 0;
    // Test-only v15 adapter. Production E2 passes E1b slice 2's structural repository getter without any duplicate SQL.
    const source: CardSyncGenerationSource = {
      getCardSyncAuthorizationGeneration() {
        reads++;
        const fd = tryLock(lockPath(ctl.controlDir, AUTHORIZATION_LOCK), 'exclusive');
        try { expect(fd).toBeNull(); } finally { releaseLock(fd); }
        return readGeneration();
      },
    };
    const putFence = (generation: string, gate: 'open' | 'blocked' = 'open') => withAuthorizationLock(ctl.controlDir, () => {
      writeFence(ctl.controlDir, fenceState({
        gate, reason: gate === 'open' ? null : 'incident', generation, next: null, op: null, machine: FAKE_MACHINE,
      }));
    });
    const generation = await withAuthorizationLock(ctl.controlDir, readGeneration);
    await putFence(generation);
    const { app, auth } = createApp({
      repo, serviceToken: 'be'.repeat(32), allowedOrigins: config.allowedOrigins, snapshotsEnabled: false, ingress: prepared.web,
    });
    const mount = reserveDeviceMount(app, auth.identify);
    const mask = process.umask(0o077);
    let servers: Server[];
    try { servers = await startIngressServers(app, prepared.listeners, { socketSafety: prepared.socketSafety }); }
    finally { process.umask(mask); }
    cleanups.push(() => closeServers(servers));
    const serve = servers.find((server) => server.address() === socketPath)!;
    const admission = admitDeviceRequest({
      config, env, serve, attestation: runtime.integration.admission, lifecycle: () => runtime.lifecycleEvidence(), source,
    });
    let work = 0;
    mount.use(createDeviceRouter(admission, [{
      method: 'get', path: '/d-probe',
      handle: (req, res, admitted) => {
        work++;
        expect(admitted.generation).toBe(generation);
        expect(req.headers.authorization).toBe('HoldrDevice synthetic-device-token');
        res.json({ ok: true, schemaVersion: repo.schemaVersion() });
      },
    }]));
    expect(assertDeviceRoutesGuarded(app)).toEqual([
      { method: 'GET', path: '/card-sync/d-probe' }, { method: 'OPTIONS', path: '/card-sync/d-probe' },
    ]);
    const request = () => rawRequest(socketPath, 'GET', '/card-sync/d-probe', [
      ...SERVE_HEADERS, ['Authorization', 'HoldrDevice synthetic-device-token'],
    ]);
    expect((await request()).status).toBe(503);
    expect(reads).toBe(0);
    cli.set(approved);
    runtime.start();
    await waitFor(() => runtime.integration.admission.refusal() === null, 20_000);
    const positive = await request();
    expect(positive.status).toBe(200);
    expect(positive.body.toString()).toBe('{"ok":true,"schemaVersion":15}');
    expect(work).toBe(1);

    const direct = await rawRequest(TEST_PORT, 'GET', '/card-sync/d-probe', [
      ['Host', `127.0.0.1:${TEST_PORT}`], ['Authorization', 'HoldrDevice synthetic-device-token'],
    ]);
    expect(direct.status).toBe(403);
    expect(work).toBe(1);
    await putFence(NEXT);
    expect((await request()).status).toBe(409);
    await putFence(generation, 'blocked');
    expect((await request()).status).toBe(409);
    await putFence(generation);
    writeMarker(ctl.controlDir, marker({ state: 'maintenance', reason: 'recovery' }, 'test'));
    expect((await request()).status).toBe(409);
    writeMarker(ctl.controlDir, marker({ state: 'normal' }, 'test'));

    const lock = lockPath(ctl.controlDir, 'lifecycle.lock');
    fs.renameSync(lock, `${lock}.held`);
    fs.writeFileSync(lock, '', { flag: 'wx', mode: 0o600 });
    try {
      expect(evidence.leaseLive()).toBe(false);
      expect((await request()).status).toBe(409);
    } finally {
      fs.unlinkSync(lock);
      fs.renameSync(`${lock}.held`, lock);
    }
    expect(evidence.leaseLive()).toBe(true);
    expect((await request()).status).toBe(200);
    expect(work).toBe(2);

    cli.set({ ...approved, serve: '{"AllowFunnel":{"holdr.test:443":true}}\n' });
    await created!.pollOnce();
    const refused = await request();
    expect(refused.status).toBe(503);
    expect(refused.headers['x-holdr-error']).toBe('ingress-refused');
    expect(work).toBe(2);
    repo.close();
    dbClosed = true;
    runtime.stop();
    expect(evidence.leaseLive()).toBe(false);
    expect(runtime.lifecycleEvidence()).toBeNull();
  }, 90_000);
});
