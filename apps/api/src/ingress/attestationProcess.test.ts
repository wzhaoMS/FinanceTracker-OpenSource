import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { runBoundedCommand } from './boundedCommand.js';
import { nativeFixture } from './nativeFixtures.js';
import { fakeTailscale } from './cliFixtures.js';
import { attestOnce, createAttestationState, type AttestationResult } from './attestation.js';
import { createIngressSafetyProviders } from './safetyProviders.js';
import { createSocketSafety } from './socketPath.js';
import { canonicalServeJson } from './serveConfig.js';
import { startIngressServers } from './server.js';
import { closeServers, rawRequest, releaseFixture, SERVE_HEADERS, TEST_ORIGIN, TEST_PORT } from './fixtures.js';
import { writeAttestationStatus } from './attestationStatus.js';
import { prepareIngress, type IngressRuntimeIntegration } from './startupChecks.js';

describe.skipIf(process.platform !== 'darwin')('real native/CLI/HTTP admission composition', () => {
  let fixture: ReturnType<typeof nativeFixture>;
  let fake: ReturnType<typeof fakeTailscale>;
  const pin = { majorMinorPatch: '1.98.3', long: 'synthetic-reviewed-build' };
  beforeAll(() => {
    fixture = nativeFixture();
    fake = fakeTailscale(fixture.root);
  }, 60_000);
  afterAll(() => fixture?.cleanup());
  const config = (socketPath: string) => ({
    version: JSON.stringify({ ...pin, daemonLong: pin.long }),
    status: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'holdr.test.' }, CertDomains: ['holdr.test'] }),
    serve: canonicalServeJson('dist', { host: 'holdr.test', socketPath }),
  });
  it.each(['exit', 'hang', 'big', 'garbage'])('bounds the real CLI %s case', async (mode) => {
    fake.set({ mode });
    const output = await runBoundedCommand(fake.cli, ['version', '--daemon', '--json'], {
      timeoutMs: 300, maxBuffer: 1024, env: { PATH: '/usr/bin:/bin', HOME: fixture.root },
    });
    if (mode === 'garbage') expect(output.stdout).toBe('not JSON');
    else expect(output.exitCode).not.toBe(0);
    if (mode === 'big') expect(output.exitCode).toBe('overflow');
  });
  it('resolves a pipe-holding grandchild at the hard deadline and does not leak its test process', async () => {
    fake.set({ mode: 'pipe' });
    const started = performance.now();
    try {
      const output = await runBoundedCommand(fake.cli, ['serve', 'status', '--json'], {
        timeoutMs: 300, maxBuffer: 1024, env: { PATH: '/usr/bin:/bin' },
      });
      expect(output.exitCode).toBe('timeout');
      expect(performance.now() - started).toBeLessThan(1800);
    } finally {
      const file = path.join(fixture.root, 'grandchild');
      if (fs.existsSync(file)) {
        const pid = Number(fs.readFileSync(file, 'utf8'));
        try { process.kill(pid, 'SIGKILL'); } catch { /* It may already have exited. */ }
      }
    }
  });
  it('passes only the explicitly reduced environment, and never treats a missing CLI as success', async () => {
    fake.set({ mode: 'env' });
    const output = await runBoundedCommand(fake.cli, ['status'], { timeoutMs: 1000, maxBuffer: 1024, env: { PATH: '/usr/bin:/bin', HOME: fixture.root } });
    // CoreFoundation may add this OS-derived value after exec on macOS.
    expect(JSON.parse(output.stdout).filter((name: string) => name !== '__CF_USER_TEXT_ENCODING')).toEqual(['HOME', 'PATH']);
    expect((await runBoundedCommand(path.join(fixture.root, 'missing'), [], { timeoutMs: 1000, maxBuffer: 1024, env: {} })).exitCode).toBe('missing');
  });
  it('per-request checks close an already reused connection; real refused/pending CLI results close a live lease immediately', async () => {
    const dir = fixture.mkdir('http', 0o700);
    const socketPath = path.join(dir, 's');
    const provider = createSocketSafety({ socketPath, native: fixture.native });
    const release = releaseFixture();
    const repo = new SqliteStateRepo({ file: ':memory:' });
    let now = 0n;
    const state = createAttestationState({ now: () => now });
    const token = 'be'.repeat(32);
    const { app } = createApp({
      repo, serviceToken: token, allowedOrigins: [TEST_ORIGIN], snapshotsEnabled: false,
      ingress: { mode: 'dist', publicOrigin: TEST_ORIGIN, release: release.release, admission: state.admission },
    });
    const mask = process.umask(0o077);
    let servers: http.Server[] = [];
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const get = () => new Promise<{ status: number; reused: boolean }>((resolve, reject) => {
      const req = http.request({ socketPath, path: '/health', headers: Object.fromEntries(SERVE_HEADERS), agent }, (res) => {
        res.resume(); res.on('end', () => resolve({ status: res.statusCode!, reused: req.reusedSocket }));
      });
      req.on('error', reject); req.end();
    });
    const read = () => attestOnce({
      cli: fake.cli, expectations: { host: 'holdr.test', socketPath, holdrPorts: [TEST_PORT] }, supported: [pin],
      checkPath: async () => {
        const result = await provider.inspect('poll');
        return { ok: result.ok, codes: result.ok ? [] : ['socket-path-unsafe'] };
      },
    });
    try {
      servers = await startIngressServers(app, [
        { mode: 'dist', listener: 'ingress', socketPath, publicOrigin: TEST_ORIGIN, admission: state.admission },
        { mode: 'dist', listener: 'local', port: TEST_PORT, publicOrigin: TEST_ORIGIN, admission: state.admission },
      ], { socketSafety: provider.safety });
      fake.set(config(socketPath));
      expect((await get()).status).toBe(503);
      const initial = state.beginAttempt();
      state.record(await read(), initial);
      expect((await get()).status).toBe(200);
      now = 46_000_000_000n;
      const expired = await get();
      expect(expired).toEqual({ status: 503, reused: true });
      expect((await rawRequest(TEST_PORT, 'GET', '/health', [['Host', 'localhost'], ['Authorization', `Bearer ${token}`]])).status).toBe(503);
      for (const kind of ['refused', 'pending'] as const) {
        now += 1_000_000_000n;
        fake.set(config(socketPath));
        const refresh = state.beginAttempt();
        state.record(await read(), refresh);
        const start = now;
        now += 15_000_000_000n;
        const attempt = state.beginAttempt();
        fake.set({ ...config(socketPath), serve: kind === 'refused' ? '{"TCP":{"9443":{"TerminateTLS":"holdr.test"}}}' : '{}\n' });
        const negative = await read();
        expect(negative.kind).toBe(kind);
        now = start + 31_001_000_000n;
        expect(state.admission.refusal()).toBeNull();
        state.record(negative, attempt);
        expect((await get()).status).toBe(503);
      }
    } finally {
      process.umask(mask); agent.destroy(); await closeServers(servers); repo.close(); release.cleanup();
    }
  }, 20_000);
  it('writes only value-free state and runtime facts with private permissions; refuses a symlink destination', () => {
    const dir = fixture.mkdir('state', 0o700);
    const file = path.join(dir, 'ingress-state.json');
    writeAttestationStatus(file, { name: 'stale', codes: ['ttl'], ageMs: 45_001, verified: false });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(data.runtime).toEqual({ platform: process.platform, node: process.versions.node, uv: process.versions.uv });
    expect(Object.keys(data)).toEqual(['format', 'name', 'codes', 'ageMs', 'verified', 'runtime']);
    fs.unlinkSync(file); fs.symlinkSync(path.join(fixture.root, 'cli.json'), file);
    expect(() => writeAttestationStatus(file, { name: 'unverified', codes: ['start'], ageMs: null, verified: false })).toThrow('E0I_SOCKET_DIR');
  });
  it('A2 providers are not a runtime bootstrap and cannot manufacture an unreviewed version pin', async () => {
    const dir = fixture.mkdir('providers', 0o700);
    const providers = createIngressSafetyProviders({
      mode: 'dist', native: fixture.native, cli: fake.cli, expectations: { host: 'holdr.test', socketPath: path.join(dir, 's') },
    });
    expect(providers).not.toHaveProperty('beforeDatabaseOpen');
    expect(providers.admission.refusal()).toBe('ingress-unverified');
    expect(fs.existsSync(path.join(dir, 's'))).toBe(false);
    const release = releaseFixture();
    try {
      await expect(prepareIngress({
        mode: 'dist', publicOrigin: TEST_ORIGIN, socketPath: path.join(dir, 's'), port: TEST_PORT,
        releaseDir: release.dir, releaseDigest: release.digest, allowedOrigins: [TEST_ORIGIN],
        dataDir: path.join(dir, 'data'), controlDir: path.join(dir, 'control'),
      }, providers as unknown as IngressRuntimeIntegration)).rejects.toThrow('E0I_RUNTIME_UNAVAILABLE');
      expect(fs.existsSync(path.join(dir, 'data'))).toBe(false);
    } finally { providers.stop(); release.cleanup(); }
  });
});

it.each(['refused', 'pending'] as const)('real continuous clock and wall-clock rollback cannot hide an overlong %s', (kind) => {
  const module = fileURLToPath(new URL('./attestation.ts', import.meta.url));
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { createAttestationState } from ${JSON.stringify(pathToFileURL(module).href)};
    const start = process.hrtime.bigint();
    const state = createAttestationState({now: () => (process.hrtime.bigint() - start) * 25n});
    const ok = {kind:'ok',codes:[],exposureChecked:true};
    state.record(ok, state.beginAttempt());
    const before = state.admission.refusal();
    Date.now = () => -3600000;
    const attempt = state.beginAttempt();
    await new Promise(resolve => setTimeout(resolve, 800));
    const stillLive = state.admission.refusal();
    state.record({kind:${JSON.stringify(kind)},codes:[${JSON.stringify(kind === 'refused' ? 'tcp-forward' : 'serve-not-installed')}],exposureChecked:true}, attempt);
    Date.now = () => 9999999999999;
    console.log(JSON.stringify({before,stillLive,after:state.admission.refusal()}));
  `], { encoding: 'utf8', timeout: 5000 });
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual({ before: null, stillLive: null, after: kind === 'refused' ? 'ingress-refused' : 'ingress-unverified' });
}, 7000);
