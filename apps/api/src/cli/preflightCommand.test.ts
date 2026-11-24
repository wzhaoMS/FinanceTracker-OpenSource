import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../auth/password.js';
import { marker, probeExclusive, writeMarker } from '../control/lifecycle.js';
import type { ProviderFactory } from '../control/runtimeIntegration.js';
import { REPO_ROOT } from '../control/paths.js';
import { FAKE_MACHINE, captureIo, controlEnvFixture, fakeSystem, outsideRepoDir } from '../control/testControl.js';
import { shortDir } from '../control/testDirs.js';
import { fakeTailscale } from '../ingress/cliFixtures.js';
import { releaseFixture, TEST_PORT, TEST_WEB_PORT } from '../ingress/fixtures.js';
import { LocalAuthRepo } from '../services/localAuthRepo.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { runPreflightCommand } from './preflightCommand.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const NATIVE = { HOLDR_NATIVE_COMMIT: 'c'.repeat(40), HOLDR_NATIVE_MANIFEST: 'd'.repeat(64) };

async function setup(mode: 'dist' | 'local' | 'vite', options: { users?: number } = {}) {
  const control = await controlEnvFixture({ machine: FAKE_MACHINE });
  const release = releaseFixture();
  const socket = shortDir();
  const cliRoot = shortDir();
  cleanups.push(control.cleanup, release.cleanup, socket.cleanup, cliRoot.cleanup);
  const fake = fakeTailscale(cliRoot.dir);
  const db = path.join(control.dataDir, 'finance.db');
  if ((options.users ?? 1) >= 0) {
    const repo = new SqliteStateRepo({ file: db });
    for (let index = 0; index < (options.users ?? 1); index += 1) {
      new LocalAuthRepo(repo).createUser(`synthetic-${index}`, await hashPassword('synthetic password 1', { ln: 10, r: 8, p: 1 }));
    }
    repo.close();
    for (const name of fs.readdirSync(control.dataDir)) fs.chmodSync(path.join(control.dataDir, name), 0o600);
  }
  const socketPath = path.join(socket.dir, 's');
  const env: NodeJS.ProcessEnv = mode === 'vite'
    ? { HOLDR_DATA_DIR: control.dataDir, HOLDR_CONTROL_DIR: control.controlDir }
    : {
      HOLDR_WEB_MODE: mode, NODE_ENV: 'production', PORT: String(TEST_PORT), HOLDR_WEB_RELEASE_DIR: release.dir,
      HOLDR_WEB_RELEASE_DIGEST: release.digest, HOLDR_DATA_DIR: control.dataDir, HOLDR_CONTROL_DIR: control.controlDir, ...NATIVE,
      ...(mode === 'dist'
        ? { HOLDR_PUBLIC_ORIGIN: 'https://holdr.test', HOLDR_SERVE_SOCKET: socketPath, HOLDR_TAILSCALE_CLI: fake.cli }
        : { HOLDR_INGRESS_PORT: String(TEST_WEB_PORT) }),
    };
  const preflightEvents: string[] = [];
  const owners: Array<() => Promise<boolean>> = [];
  const factory: ProviderFactory = (input) => {
    preflightEvents.push(`providers ${input.mode} stateFile=${input.stateFile ?? 'none'}`);
    return {
      preflightSocket: async (isOwned: () => Promise<boolean>) => { preflightEvents.push(`preflightSocket ${typeof isOwned}`); owners.push(isOwned); },
      stop: () => { preflightEvents.push('stop'); },
    } as unknown as ReturnType<ProviderFactory>;
  };
  const run = async (extraEnv: NodeJS.ProcessEnv = {}, argv: string[] = []) => {
    const capture = captureIo();
    const code = await runPreflightCommand(argv, { ...env, ...extraEnv }, { io: capture.io, run: fakeSystem, providerFactory: factory });
    return { code, out: capture.out(), err: capture.err() };
  };
  return { ...control, env, fake, run, preflightEvents, owners, socketPath };
}

const snapshot = (dir: string) => fs.readdirSync(dir).sort().map((name) => {
  const stat = fs.statSync(path.join(dir, name));
  return `${name} ${stat.mode.toString(8)} ${stat.mtimeMs}`;
});

describe.skipIf(process.platform !== 'darwin')('holdr-ingress preflight (§8.2 step 6, §7.2, §9.3 read-only role)', { timeout: 30_000 }, () => {
  it('dist: every check, the K28 preflight phase and the Serve validator; changes nothing', async () => {
    const t = await setup('dist');
    const control = snapshot(t.controlDir);
    const data = snapshot(t.dataDir);
    const result = await t.run();
    expect(result.err).toBe('');
    expect(result).toMatchObject({ code: 0, out: 'PREFLIGHT ok mode=dist serve=empty gate="blocked (init)"\n' });
    expect(t.preflightEvents).toEqual(['providers dist stateFile=none', 'preflightSocket function']);
    expect(snapshot(t.controlDir)).toEqual(control);
    // K23's read-only open of a WAL database creates SQLite's own -wal/-shm sidecars when absent (SQLite >= 3.22), with
    // the database file's mode; the database itself is untouched.
    const sidecar = (line: string) => /^finance\.db-(wal|shm) /.test(line);
    expect(snapshot(t.dataDir).filter((line) => !sidecar(line))).toEqual(data);
    for (const line of snapshot(t.dataDir).filter(sidecar)) expect(line.split(' ')[1]).toBe('100600');
    expect(fs.existsSync(path.join(path.dirname(t.socketPath), 'ingress-state.json'))).toBe(false);
    expect(probeExclusive(t.controlDir)).toBe('free');
  });

  it('a staged candidate accepts the live tree\'s running API on the socket, judged against the managed live tree (B1 review 4)', async () => {
    const t = await setup('dist');
    // The live tree T (HOLDR_ROOT/FinanceTracker) runs the API that holds the socket; this preflight's code is another tree.
    const outer = outsideRepoDir('live');
    cleanups.push(outer.cleanup);
    const root = path.join(outer.dir, 'Holdr');
    const live = path.join(root, 'FinanceTracker');
    fs.mkdirSync(path.join(live, 'apps/api'), { recursive: true });
    fs.mkdirSync(path.join(live, 'node_modules/.bin'), { recursive: true });
    const server = path.join(live, 'node_modules/.bin/fake-api.js');
    fs.writeFileSync(server, `require('node:http').createServer((q, r) => r.end('ok')).listen('${t.socketPath}', () => process.stdout.write('ready\\n'));\n`);
    const api = spawn(process.execPath, [server, 'src/index.ts'], { cwd: path.join(live, 'apps/api'), stdio: ['ignore', 'pipe', 'ignore'] });
    cleanups.push(() => { api.kill('SIGKILL'); });
    await new Promise<void>((resolve) => api.stdout!.once('data', () => resolve()));
    for (const [extra, owned] of [[{ HOLDR_ROOT: root }, true], [{ HOME: outer.dir }, true], [{}, false]] as const) {
      const result = await t.run(extra);
      expect(result.code, result.err).toBe(0);
      expect(await t.owners.at(-1)!(), JSON.stringify(extra)).toBe(owned);
    }
    expect(REPO_ROOT).not.toBe(fs.realpathSync(live));
    expect((await t.run({ HOLDR_ROOT: path.join(outer.dir, 'missing') })).code).toBe(64);
  });

  it('accepts the Serve verdicts the start script handles, refuses a known-fatal one', async () => {
    const t = await setup('dist');
    t.fake.set({ mode: 'exit' });
    expect((await t.run()).out).toBe('PREFLIGHT ok mode=dist serve=error gate="blocked (init)"\n');
    t.fake.set({ serve: '{"AllowFunnel":{"holdr.test:443":true}}\n' });
    const refused = await t.run();
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/^PREFLIGHT refused E0I_SERVE \(Serve verdict refused: funnel-enabled/);
  });

  it('the start script\'s web port is the legacy Vite target the validator approves (--web-port)', async () => {
    const t = await setup('dist');
    const vite = (port: number) => JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { 'holdr.test:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } } }, null, 2) + '\n';
    t.fake.set({ serve: vite(8888) });
    expect((await t.run()).out).toContain('serve=approved-vite');
    t.fake.set({ serve: vite(TEST_WEB_PORT) });
    expect((await t.run()).err).toContain('E0I_SERVE');
    expect((await t.run({}, ['--web-port', String(TEST_WEB_PORT)])).out).toContain('serve=approved-vite');
    expect((await t.run({}, ['--web-port', 'x'])).code).toBe(64);
  });

  it('local without the CLI skips the Serve checks; with loose main files it only warns', async () => {
    const t = await setup('local');
    fs.chmodSync(path.join(t.dataDir, 'finance.db'), 0o644);
    const result = await t.run();
    expect(result).toMatchObject({ code: 0, out: 'PREFLIGHT ok mode=local serve=not-checked gate="blocked (init)"\n' });
    expect(result.err).toContain('preflight warning: the API will restrict');
    expect(fs.statSync(path.join(t.dataDir, 'finance.db')).mode & 0o777).toBe(0o644);
  });

  it('refuses maintenance (3), no users or no database (K23), lease variables and arguments', async () => {
    const t = await setup('dist');
    writeMarker(t.controlDir, marker({ state: 'maintenance', reason: 'deploy' }, 'test'));
    expect(await t.run()).toMatchObject({ code: 3, err: 'PREFLIGHT refused E0I_MAINTENANCE (maintenance (deploy))\n' });
    expect(t.preflightEvents).toEqual([]);
    const empty = await setup('dist', { users: 0 });
    expect((await empty.run()).err).toContain('PREFLIGHT refused E0I_NO_USERS');
    const none = await setup('dist', { users: -1 });
    expect((await none.run()).err).toContain('PREFLIGHT refused E0I_NO_USERS');
    expect((await none.run({ HOLDR_LIFECYCLE_LEASE: 'ab'.repeat(8) })).err).toContain('PREFLIGHT refused E0I_LEASE_ENV');
    expect((await none.run({}, ['--now'])).code).toBe(64);
  });

  it('K17, K18, K20 and K22 refuse with their codes', async () => {
    const t = await setup('dist');
    fs.chmodSync(t.controlDir, 0o755);
    expect((await t.run()).err).toContain('E0I_CONTROL_DIR');
    fs.chmodSync(t.controlDir, 0o700);
    fs.writeFileSync(path.join(t.dataDir, 'notes.txt'), 'synthetic', { mode: 0o644 });
    fs.chmodSync(path.join(t.dataDir, 'notes.txt'), 0o644);
    expect((await t.run()).err).toContain('E0I_DATA_PERMS');
    fs.rmSync(path.join(t.dataDir, 'notes.txt'));
    expect((await t.run({ HOLDR_SERVICE_TOKEN_FILE: path.join(t.controlDir, 'token') })).err).toContain('E0I_TOKEN_LOCATION');
    expect((await t.run({ HOLDR_DATA_DIR: path.join(t.env.HOLDR_WEB_RELEASE_DIR!, 'data') })).err).toMatch(/E0I_DATA_OVERLAP|E0I_CONTROL_DIR/);
  });

  it('local with the CLI: readiness-only Serve findings warn, a known exposure refuses (B1 review 7)', async () => {
    const t = await setup('local');
    const confDir = shortDir();
    cleanups.push(confDir.cleanup);
    const conf = path.join(confDir.dir, 'holdr.conf');
    fs.writeFileSync(conf, `HOLDR_WEB_MODE=local\nHOLDR_TAILSCALE_CLI=${t.fake.cli}\n`, { mode: 0o600 });
    const socket = path.join(confDir.dir, 's');
    fs.writeFileSync(path.join(confDir.dir, 'holdr.conf.dist'),
      `HOLDR_WEB_MODE=dist\nHOLDR_PUBLIC_ORIGIN=https://holdr.test\nHOLDR_SERVE_SOCKET=${socket}\n`, { mode: 0o600 });
    const extra = { HOLDR_CONFIG: conf, HOLDR_TAILSCALE_CLI: t.fake.cli };
    const dist = { TCP: { 443: { HTTPS: true } }, Web: { 'holdr.test:443': { Handlers: { '/': { Proxy: `unix:${socket}` } } } } };
    t.fake.set({ serve: `${JSON.stringify({ ...dist, FutureField: {} }, null, 2)}\n` });
    const ready = await t.run(extra);
    expect(ready, ready.err).toMatchObject({ code: 0, out: 'PREFLIGHT ok mode=local serve=not-ready gate="blocked (init)"\n' });
    expect(ready.err).toContain('preflight warning: Tailscale Serve is not ready (serve-schema-unknown)');
    for (const exposed of ['{"AllowFunnel":{"holdr.test:443":true}}\n', `{"TCP":{"443":{"TCPForward":"127.0.0.1:${TEST_WEB_PORT}"}}}\n`]) {
      t.fake.set({ serve: exposed });
      const refused = await t.run(extra);
      expect(refused.code, exposed).toBe(1);
      expect(refused.err).toMatch(/^PREFLIGHT refused E0I_SERVE \(Serve exposes Holdr: /);
    }
  });

  it('vite with a control dir takes part in the lifecycle protocol', async () => {
    const t = await setup('vite');
    expect(await t.run()).toMatchObject({ code: 0, out: 'PREFLIGHT ok mode=vite\n' });
    writeMarker(t.controlDir, marker({ state: 'maintenance', reason: 'deploy' }, 'test'));
    expect((await t.run()).code).toBe(3);
  });
});
