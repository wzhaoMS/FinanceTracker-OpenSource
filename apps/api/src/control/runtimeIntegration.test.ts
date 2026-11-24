import fs from 'node:fs';
import path from 'node:path';

import { WebReleaseError } from '@finance-tracker/shared/web-release';
import { afterEach, describe, expect, it } from 'vitest';

import { fakeTailscale } from '../ingress/cliFixtures.js';
import { resolveIngressConfig, type ReleaseIngressConfig } from '../ingress/config.js';
import { releaseFixture, TEST_PORT, TEST_WEB_PORT } from '../ingress/fixtures.js';
import { prepareIngress } from '../ingress/startupChecks.js';
import { readHoldrConf } from './holdrConf.js';
import { acquireSharedLease, leaseStillOn, marker, probeExclusive, writeMarker } from './lifecycle.js';
import { BREAK_GLASS_BANNER, createProductionRuntime, type ProviderFactory } from './runtimeIntegration.js';
import { FAKE_MACHINE, controlEnvFixture, fakeSystem } from './testControl.js';
import { scratchDir, shortDir, writePrivate } from './testDirs.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const NATIVE = { HOLDR_NATIVE_COMMIT: 'c'.repeat(40), HOLDR_NATIVE_MANIFEST: 'd'.repeat(64) };
const coded = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string }) => error.code);

/** Records what the runtime asks of A2's providers; the real composition runs in productionStack.integration.ts. */
function fakeFactory(events: string[], fail?: string): ProviderFactory {
  return (input) => {
    events.push(`providers ${JSON.stringify({ ...input, log: undefined })}`);
    if (fail) throw new WebReleaseError(fail);
    return {
      admission: { refusal: () => 'ingress-unverified' },
      socketSafety: {
        async beforeListen(socketPath: string) { events.push(`beforeListen ${socketPath}`); },
        async afterListen() { /* not reached here */ },
      },
      preflightSocket: async () => { throw new Error('not used by the API'); },
      state: () => ({ name: 'unverified', codes: ['start'], ageMs: null, verified: false }),
      pollOnce: async () => ({ kind: 'error', codes: [], exposureChecked: false }),
      start: () => { events.push('start'); },
      stop: () => { events.push('stop'); },
    } as unknown as ReturnType<ProviderFactory>;
  };
}

async function setup(mode: 'dist' | 'local', extra: NodeJS.ProcessEnv = {}) {
  const control = await controlEnvFixture({ machine: FAKE_MACHINE });
  const release = releaseFixture();
  const socket = shortDir();
  // The fake CLI is an extensionless CommonJS script: it must live outside apps/api ("type": "module").
  const cliRoot = shortDir();
  cleanups.push(control.cleanup, release.cleanup, socket.cleanup, cliRoot.cleanup);
  const fake = fakeTailscale(cliRoot.dir);
  const env: NodeJS.ProcessEnv = {
    HOLDR_WEB_MODE: mode, NODE_ENV: 'production', PORT: String(TEST_PORT), HOLDR_WEB_RELEASE_DIR: release.dir,
    HOLDR_WEB_RELEASE_DIGEST: release.digest, HOLDR_DATA_DIR: control.dataDir, HOLDR_CONTROL_DIR: control.controlDir, ...NATIVE,
    ...(mode === 'dist'
      ? { HOLDR_PUBLIC_ORIGIN: 'https://holdr.test', HOLDR_SERVE_SOCKET: path.join(socket.dir, 's'), HOLDR_TAILSCALE_CLI: fake.cli }
      : { HOLDR_INGRESS_PORT: String(TEST_WEB_PORT) }),
    ...extra,
  };
  for (const [key, value] of Object.entries(extra)) if (value === undefined) delete env[key];
  const config = resolveIngressConfig(env) as ReleaseIngressConfig;
  const events: string[] = [];
  const calls = () => { try { return fs.readFileSync(path.join(cliRoot.dir, 'calls'), 'utf8'); } catch { return ''; } };
  return { ...control, env, config, events, fake, calls, socketPath: path.join(socket.dir, 's'), cliRoot: cliRoot.dir };
}

function runtimeFor(t: Awaited<ReturnType<typeof setup>>, options: { fail?: string; conf?: ReturnType<typeof readHoldrConf> | null } = {}) {
  const runtime = createProductionRuntime({
    env: t.env, config: t.config, conf: options.conf ?? null, run: fakeSystem,
    log: (line) => t.events.push(line), warn: (line) => t.events.push(`warn ${line}`),
    providerFactory: fakeFactory(t.events, options.fail),
  });
  cleanups.push(() => runtime.stop());
  return runtime;
}

describe.skipIf(process.platform !== 'darwin')('production runtime integration (§12 row B, §7.2 order)', { timeout: 30_000 }, () => {
  it('dist: K20, the shared lease, K17-K22 with the gate log, A2 providers with the pins, K28 boot, then K24', async () => {
    const t = await setup('dist');
    fs.writeFileSync(path.join(t.dataDir, 'finance.db'), '', { mode: 0o644 });
    fs.chmodSync(path.join(t.dataDir, 'finance.db'), 0o644);
    const runtime = runtimeFor(t);
    expect(await coded(Promise.resolve().then(() => runtime.integration.admission))).toBe('E0I_RUNTIME_UNAVAILABLE');
    const prepared = await prepareIngress(t.config, runtime.integration);
    expect(probeExclusive(t.controlDir)).toBe('held');
    expect(fs.statSync(path.join(t.dataDir, 'finance.db')).mode & 0o777).toBe(0o600);
    const providers = JSON.stringify({
      mode: 'dist', native: { sourceCommit: NATIVE.HOLDR_NATIVE_COMMIT, manifestDigest: NATIVE.HOLDR_NATIVE_MANIFEST }, cli: t.fake.cli,
      expectations: { host: 'holdr.test', socketPath: t.socketPath, holdrPorts: [TEST_PORT] },
      stateFile: path.join(path.dirname(t.socketPath), 'ingress-state.json'),
    });
    expect(t.events.filter((line) => !line.startsWith('warn [auth] restricted'))).toEqual([
      '[holdr-control] device gate: blocked (init)', `providers ${providers}`, `beforeListen ${t.socketPath}`,
      '[holdr-ingress] K24: Serve configuration empty',
    ]);
    expect(t.calls()).toBe('serve status --json\n');
    expect(prepared.listeners.every((listener) => 'admission' in listener && listener.admission === runtime.integration.admission)).toBe(true);
    expect(prepared.socketSafety).toBe(runtime.integration.socketSafety);
    expect(runtime.integration.admission.refusal()).toBe('ingress-unverified');
    runtime.start();
    runtime.stop();
    expect(t.events.slice(-2)).toEqual(['start', 'stop']);
    expect(probeExclusive(t.controlDir)).toBe('free');
  });

  it('maintenance refuses before any repair, provider, socket or Serve read (K29 first, B-D11)', async () => {
    const t = await setup('dist');
    fs.writeFileSync(path.join(t.dataDir, 'finance.db'), '', { mode: 0o644 });
    fs.chmodSync(path.join(t.dataDir, 'finance.db'), 0o644);
    writeMarker(t.controlDir, marker({ state: 'maintenance', reason: 'deploy' }, 'test'));
    const runtime = runtimeFor(t);
    expect(await coded(prepareIngress(t.config, runtime.integration))).toBe('E0I_MAINTENANCE');
    expect(t.events).toEqual([]);
    expect(t.calls()).toBe('');
    expect(fs.statSync(path.join(t.dataDir, 'finance.db')).mode & 0o777).toBe(0o644);
    expect(probeExclusive(t.controlDir)).toBe('free');
  });

  it('K24: a known-fatal Serve configuration refuses start and releases the lease; an unreadable one starts closed', async () => {
    const refused = await setup('dist');
    refused.fake.set({ serve: '{"AllowFunnel":{"holdr.test:443":true}}\n' });
    const runtime = runtimeFor(refused);
    expect(await coded(runtime.integration.beforeDatabaseOpen(refused.config))).toBe('E0I_SERVE');
    expect(refused.events.at(-1)).toBe('stop');
    expect(probeExclusive(refused.controlDir)).toBe('free');

    const unreadable = await setup('dist');
    unreadable.fake.set({ mode: 'exit' });
    const closed = runtimeFor(unreadable);
    await closed.integration.beforeDatabaseOpen(unreadable.config);
    expect(unreadable.events.at(-1)).toBe('warn [holdr-ingress] K24: Serve configuration unreadable; starting with admission closed');
    expect(closed.integration.admission.refusal()).toBe('ingress-unverified');
  });

  it('dist without HOLDR_TAILSCALE_CLI, a failing provider (K30) or a changed configuration refuses and releases the lease', async () => {
    const noCli = await setup('dist', { HOLDR_TAILSCALE_CLI: undefined });
    expect(await coded(runtimeFor(noCli).integration.beforeDatabaseOpen(noCli.config))).toBe('E0I_SERVE');
    expect(noCli.events.some((line) => line.startsWith('providers'))).toBe(false);
    expect(probeExclusive(noCli.controlDir)).toBe('free');
    const native = await setup('dist');
    expect(await coded(runtimeFor(native, { fail: 'E0I_NATIVE_HELPER' }).integration.beforeDatabaseOpen(native.config))).toBe('E0I_NATIVE_HELPER');
    expect(probeExclusive(native.controlDir)).toBe('free');
    const changed = await setup('dist');
    expect(await coded(runtimeFor(changed).integration.beforeDatabaseOpen({ ...changed.config }))).toBe('E0I_INTERNAL');
  });

  it('local without the CLI is break-glass: open admission, no socket, a logged banner (B-D2)', async () => {
    const t = await setup('local');
    const runtime = runtimeFor(t);
    const prepared = await prepareIngress(t.config, runtime.integration);
    expect(prepared.listeners.map((listener) => [listener.listener, 'port' in listener ? listener.port : null])).toEqual([['ingress', TEST_WEB_PORT], ['local', TEST_PORT]]);
    expect(runtime.integration.admission.refusal()).toBeNull();
    expect(await coded(runtime.integration.socketSafety.beforeListen(t.socketPath))).toBe('E0I_SOCKET_UNVERIFIED');
    expect(t.events).toContain('warn [holdr-ingress] local mode without HOLDR_TAILSCALE_CLI: no Serve exposure checks');
    runtime.start();
    expect(t.events.at(-1)).toBe(`warn [holdr-api] ${BREAK_GLASS_BANNER}`);
    expect(t.events.some((line) => line.startsWith('providers'))).toBe(false);
  });

  it('local with the CLI compares against holdr.conf.dist and both Holdr ports; without the companion it refuses', async () => {
    const t = await setup('local');
    const confDir = scratchDir('conf');
    cleanups.push(confDir.cleanup);
    const fake = t.fake.cli;
    writePrivate(path.join(confDir.dir, 'holdr.conf'), `HOLDR_WEB_MODE=local\nHOLDR_TAILSCALE_CLI=${fake}\n`);
    const withCli = { ...t, env: { ...t.env, HOLDR_TAILSCALE_CLI: fake } };
    const conf = readHoldrConf(path.join(confDir.dir, 'holdr.conf'));
    expect(await coded(runtimeFor(withCli, { conf }).integration.beforeDatabaseOpen(t.config))).toBe('E0I_CONFIG_FILE');
    writePrivate(path.join(confDir.dir, 'holdr.conf.dist'),
      `HOLDR_WEB_MODE=dist\nHOLDR_PUBLIC_ORIGIN=https://holdr.test\nHOLDR_SERVE_SOCKET=${t.socketPath}\n`);
    t.events.length = 0;
    const runtime = runtimeFor(withCli, { conf });
    await runtime.integration.beforeDatabaseOpen(t.config);
    expect(t.events).toContain(`providers ${JSON.stringify({
      mode: 'local', native: { sourceCommit: NATIVE.HOLDR_NATIVE_COMMIT, manifestDigest: NATIVE.HOLDR_NATIVE_MANIFEST }, cli: fake,
      expectations: { host: 'holdr.test', socketPath: t.socketPath, holdrPorts: [TEST_PORT, TEST_WEB_PORT] },
    })}`);
    expect(t.events.some((line) => line.startsWith('beforeListen'))).toBe(false);
    expect(t.events.at(-1)).toBe('[holdr-ingress] K24: Serve configuration empty');

    // B1 review 7: local applies A2's readiness/exposure split. A safe configuration with only an unknown schema field warns;
    // a known exposure (Funnel, a forward to a Holdr port) still refuses start.
    t.fake.set({ serve: JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { 'holdr.test:443': { Handlers: { '/': { Proxy: `unix:${t.socketPath}` } } } }, FutureField: {} }, null, 2) + '\n' });
    t.events.length = 0;
    await runtimeFor(withCli, { conf }).integration.beforeDatabaseOpen(t.config);
    expect(t.events.at(-1)).toBe('warn [holdr-ingress] K24: Serve configuration not ready (serve-schema-unknown); break-glass continues, no exposure found');
    for (const exposed of ['{"AllowFunnel":{"holdr.test:443":true}}\n', `{"TCP":{"443":{"TCPForward":"127.0.0.1:${TEST_WEB_PORT}"}}}\n`]) {
      t.fake.set({ serve: exposed });
      const refused = runtimeFor(withCli, { conf });
      expect(await coded(refused.integration.beforeDatabaseOpen(t.config)), exposed).toBe('E0I_SERVE');
      expect(refused.lifecycleEvidence(), 'a refused start keeps no lease').toBeNull();
    }
  });

  it('lifecycle evidence for PR D: the boot-time machine and a lease proof that ends with stop, a lost descriptor or a replaced lock', async () => {
    const t = await setup('dist');
    const runtime = runtimeFor(t);
    expect(runtime.lifecycleEvidence()).toBeNull();
    await runtime.integration.beforeDatabaseOpen(t.config);
    const evidence = runtime.lifecycleEvidence()!;
    expect(evidence).toMatchObject({ machine: FAKE_MACHINE, controlDir: t.controlDir });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(evidence.leaseLive()).toBe(true);
    expect(probeExclusive(t.controlDir)).toBe('held');
    // The lock file replaced under the running API: a new identity is not the API's lease.
    const lock = path.join(t.controlDir, 'lifecycle.lock');
    fs.renameSync(lock, `${lock}.old`);
    fs.writeFileSync(lock, '', { mode: 0o600 });
    expect(evidence.leaseLive()).toBe(false);
    fs.renameSync(`${lock}.old`, lock);
    expect(evidence.leaseLive()).toBe(true);
    runtime.stop();
    expect(evidence.leaseLive()).toBe(false);
    expect(runtime.lifecycleEvidence()).toBeNull();
    expect(probeExclusive(t.controlDir)).toBe('free');
  });

  it('leaseStillOn: only a held lease whose descriptor is the control dir\'s current lifecycle.lock', async () => {
    const t = await setup('dist');
    const lease = await acquireSharedLease(t.controlDir, { timeoutMs: 1_000 });
    expect(lease.held).toBe(true);
    expect(leaseStillOn(lease, t.controlDir)).toBe(true);
    expect(leaseStillOn(lease, path.join(t.root, 'elsewhere'))).toBe(false);
    lease.release();
    expect(lease.held).toBe(false);
    expect(leaseStillOn(lease, t.controlDir)).toBe(false);
  });
});
