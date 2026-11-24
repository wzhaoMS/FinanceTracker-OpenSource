import fs from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { attestOnce, createAttestationPoller, createAttestationState } from '../ingress/attestation.js';
import { writeAttestationStatus } from '../ingress/attestationStatus.js';
import { fakeTailscale } from '../ingress/cliFixtures.js';
import { resolveIngressConfig, type ReleaseIngressConfig } from '../ingress/config.js';
import { closeServers, rawRequest, releaseFixture, SERVE_HEADERS, TEST_PORT } from '../ingress/fixtures.js';
import { nativeFixture } from '../ingress/nativeFixtures.js';
import { verifyPinnedNativeHelper } from '../ingress/nativeHelper.js';
import { canonicalServeJson } from '../ingress/serveConfig.js';
import { startIngressServers } from '../ingress/server.js';
import { assertVerifiedRuntime } from '../ingress/safetyProviders.js';
import { createSocketSafety } from '../ingress/socketPath.js';
import { prepareIngress } from '../ingress/startupChecks.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { probeExclusive } from './lifecycle.js';
import { createProductionRuntime, type ProviderFactory } from './runtimeIntegration.js';
import { FAKE_MACHINE, controlEnvFixture, fakeSystem, waitFor } from './testControl.js';
import { shortDir } from './testDirs.js';

/**
 * The composed runtime reaching `verified` (§12 row B with A2): B's `beforeDatabaseOpen` (K20, K29, K17-K22, K24) and
 * A2's real native reader, socket policy and attestation, with one difference from production: a synthetic Tailscale
 * pin, injected through the code-level `providerFactory` seam that index.ts never passes. Production's
 * `SUPPORTED_TAILSCALE` stays empty until AL1 (productionStack.integration.ts shows it closed).
 */
const PORT = TEST_PORT;
const PIN = { majorMinorPatch: '1.98.3', long: 'synthetic-reviewed-build' };

describe.skipIf(process.platform !== 'darwin')('composed admission with a synthetic Tailscale pin', () => {
  let fixture: ReturnType<typeof nativeFixture>;
  beforeAll(() => { fixture = nativeFixture(); }, 120_000);
  afterAll(() => fixture?.cleanup());
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

  let created: ReturnType<ProviderFactory> | undefined;
  /** A2's createIngressSafetyProviders composition, with `supported: [PIN]` and the fixture's build dir. */
  const syntheticFactory: ProviderFactory = (options) => {
    if (options.mode === 'dist') assertVerifiedRuntime();
    const native = { ...options.native, buildDir: fixture.native.buildDir };
    verifyPinnedNativeHelper(native);
    const socket = createSocketSafety({ socketPath: options.expectations.socketPath, native });
    const state = createAttestationState({
      mode: options.mode, onChange: options.stateFile ? (view) => writeAttestationStatus(options.stateFile!, view) : undefined,
    });
    const poller = createAttestationPoller(state, () => attestOnce({
      cli: options.cli, expectations: options.expectations, mode: options.mode, supported: [PIN],
      checkPath: async () => {
        const result = await socket.inspect('poll');
        return { ok: result.ok, codes: result.findings.map((finding) =>
          finding.code === 'socket-replaced' || finding.code === 'socket-missing' ? finding.code : 'socket-path-unsafe') };
      },
    }), { log: options.log });
    created = {
      admission: state.admission, socketSafety: socket.safety, preflightSocket: socket.preflight,
      state: state.view, pollOnce: poller.pollOnce, start: poller.start, stop: poller.stop,
    };
    return created;
  };

  it('opens admission only after a verified attestation and closes it on a refused one; the lease spans the run', async () => {
    const control = await controlEnvFixture({ machine: FAKE_MACHINE });
    const release = releaseFixture();
    const runDir = shortDir();
    const cliDir = shortDir();
    cleanups.push(control.cleanup, release.cleanup, runDir.cleanup, cliDir.cleanup);
    const socketPath = path.join(runDir.dir, 's');
    const fake = fakeTailscale(cliDir.dir);
    const approved = {
      version: JSON.stringify({ ...PIN, daemonLong: PIN.long }),
      status: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'holdr.test.' }, CertDomains: ['holdr.test'] }),
      serve: canonicalServeJson('dist', { host: 'holdr.test', socketPath }),
    };
    fake.set({ ...approved, serve: '{}\n' });
    const env: NodeJS.ProcessEnv = {
      HOLDR_WEB_MODE: 'dist', NODE_ENV: 'production', PORT: String(PORT), HOLDR_PUBLIC_ORIGIN: 'https://holdr.test',
      HOLDR_SERVE_SOCKET: socketPath, HOLDR_WEB_RELEASE_DIR: release.dir, HOLDR_WEB_RELEASE_DIGEST: release.digest,
      HOLDR_DATA_DIR: control.dataDir, HOLDR_CONTROL_DIR: control.controlDir, HOLDR_TAILSCALE_CLI: fake.cli,
      HOLDR_NATIVE_COMMIT: fixture.native.sourceCommit, HOLDR_NATIVE_MANIFEST: fixture.native.manifestDigest,
    };
    const config = resolveIngressConfig(env) as ReleaseIngressConfig;
    const lines: string[] = [];
    const runtime = createProductionRuntime({
      env, config, conf: null, run: fakeSystem, log: (line) => lines.push(line), providerFactory: syntheticFactory,
    });
    cleanups.push(() => runtime.stop());
    const prepared = await prepareIngress(config, runtime.integration);
    expect(lines).toContain('[holdr-ingress] K24: Serve configuration empty');
    expect(probeExclusive(control.controlDir)).toBe('held');
    const repo = new SqliteStateRepo({ file: path.join(control.dataDir, 'finance.db') });
    cleanups.push(() => repo.close());
    const { app } = createApp({
      repo, serviceToken: 'be'.repeat(32), allowedOrigins: [...config.allowedOrigins], snapshotsEnabled: false, ingress: prepared.web,
    });
    const mask = process.umask(0o077);
    let servers: Server[];
    try {
      servers = await startIngressServers(app, prepared.listeners, { socketSafety: prepared.socketSafety });
    } finally { process.umask(mask); }
    cleanups.push(() => closeServers(servers));

    expect((await rawRequest(socketPath, 'GET', '/', SERVE_HEADERS)).status).toBe(503);
    fake.set(approved);
    runtime.start();
    await waitFor(() => runtime.integration.admission.refusal() === null, 20_000);
    const page = await rawRequest(socketPath, 'GET', '/', SERVE_HEADERS);
    expect(page.status).toBe(200);
    expect(page.body).toEqual(release.release.get('/index.html')!.bytes());
    const stateFile = path.join(runDir.dir, 'ingress-state.json');
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toMatchObject({ name: 'verified', verified: true });

    fake.set({ ...approved, serve: '{"AllowFunnel":{"holdr.test:443":true}}\n' });
    await created!.pollOnce();
    expect(runtime.integration.admission.refusal()).toBe('ingress-refused');
    expect((await rawRequest(socketPath, 'GET', '/', SERVE_HEADERS)).status).toBe(503);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toMatchObject({ name: 'refused', verified: false });
    expect(probeExclusive(control.controlDir)).toBe('held');
    runtime.stop();
    expect(probeExclusive(control.controlDir)).toBe('free');
  }, 60_000);
});
