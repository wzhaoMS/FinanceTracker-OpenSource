import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import { hashPassword } from '../auth/password.js';
import { fakeTailscale } from '../ingress/cliFixtures.js';
import { rawRequest, SERVE_HEADERS, TEST_PORT } from '../ingress/fixtures.js';
import { NATIVE_DIR, verifyNativeHelper } from '../ingress/nativeHelper.js';
import { LocalAuthRepo } from '../services/localAuthRepo.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { initControlDir } from './controlDir.js';
import { systemRunner } from './exec.js';
import { LIFECYCLE_LOCK, lockPath, marker, probeExclusive, writeMarker } from './lifecycle.js';
import { computeMachineId } from './machineId.js';
import { API_DIR, REPO_ROOT, repoPaths } from './paths.js';
import { fakeTmutil, lockHolder, outsideRepoDir, waitFor } from './testControl.js';
import { shortDir, writePrivate } from './testDirs.js';

/**
 * §10.2 with the real composed integration (PR B): the real `index.ts`, started the way the start script starts it
 * (`<tree>/node_modules/.bin/tsx src/index.ts` in `apps/api`), in `dist` with a holdr.conf, a private HOME, an
 * initialised control dir outside the tree, the pinned native reader, a verified release and a fake Tailscale CLI.
 * `SUPPORTED_TAILSCALE` is empty until AL1, so admission must stay closed here; `composedAdmission.test.ts` shows the
 * verified path with a synthetic pin. The release is the real `vite build` of this checkout, built twice and compared by the
 * global setup `test:ingress` uses (`vitest.stack.config.ts`, `npm run test:stack`; B-D16's synthetic stand-in is retired).
 */
const PORT = TEST_PORT;
const TSX = path.join(REPO_ROOT, 'node_modules/.bin/tsx');
const VERSION = { majorMinorPatch: '1.98.3', long: 'synthetic-unreviewed-build' };

let native: { commit: string; manifest: string };
let machine: string;
let release: { dir: string; digest: string };

beforeAll(async () => {
  // The API verifies apps/api/native/build against the pin in holdr.conf (K30). Build it once if absent, never overwrite.
  if (!fs.existsSync(path.join(NATIVE_DIR, 'build'))) {
    execFileSync(process.execPath, ['--import', 'tsx', path.join(API_DIR, 'scripts/buildNative.ts')], { cwd: REPO_ROOT, stdio: 'ignore', timeout: 120_000 });
  }
  const verified = verifyNativeHelper();
  native = { commit: verified.manifest.sourceCommit, manifest: verified.manifestDigest };
  release = { dir: inject('ingressReleaseDir'), digest: inject('ingressReleaseDigest') };
  const probe = outsideRepoDir('machine');
  try { machine = await computeMachineId(systemRunner, probe.dir); } finally { probe.cleanup(); }
}, 180_000);


const cleanups: Array<() => void> = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* exited */ } }
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function makeStack(options: { users?: boolean } = {}) {
  const outer = outsideRepoDir('stack');
  const runDir = shortDir();
  const cliDir = shortDir();
  cleanups.push(outer.cleanup, runDir.cleanup, cliDir.cleanup);
  const home = path.join(outer.dir, 'home');
  const dataDir = path.join(outer.dir, 'data');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const controlDir = path.join(outer.dir, 'control');
  await initControlDir(controlDir, { machine, run: fakeTmutil, repo: repoPaths(), dataDir });
  const socketPath = path.join(runDir.dir, 's');
  const fake = fakeTailscale(cliDir.dir);
  fake.set({
    version: JSON.stringify({ ...VERSION, daemonLong: VERSION.long }),
    status: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'holdr.test.' }, CertDomains: ['holdr.test'] }),
    serve: '{}\n',
  });
  const conf = path.join(outer.dir, 'holdr.conf');
  const confValues: Record<string, string> = {
    HOLDR_WEB_MODE: 'dist', HOLDR_PUBLIC_ORIGIN: 'https://holdr.test', HOLDR_DATA_DIR: dataDir, HOLDR_CONTROL_DIR: controlDir,
    HOLDR_SERVE_SOCKET: socketPath, HOLDR_TAILSCALE_CLI: fake.cli, HOLDR_NATIVE_COMMIT: native.commit, HOLDR_NATIVE_MANIFEST: native.manifest,
  };
  const writeConf = (values: Record<string, string>, mode = 0o600) => {
    fs.rmSync(conf, { force: true });
    writePrivate(conf, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''), mode);
  };
  writeConf(confValues);
  if (options.users) {
    const repo = new SqliteStateRepo({ file: path.join(dataDir, 'finance.db') });
    new LocalAuthRepo(repo).createUser('synthetic-owner', await hashPassword('synthetic password 1', { ln: 10, r: 8, p: 1 }));
    repo.close();
    for (const name of fs.readdirSync(dataDir)) fs.chmodSync(path.join(dataDir, name), 0o600);
  }
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: home, HOLDR_CONFIG: conf, NODE_ENV: 'production', PORT: String(PORT),
    HOLDR_WEB_RELEASE_DIR: release.dir, HOLDR_WEB_RELEASE_DIGEST: release.digest, SNAPSHOTS_ENABLED: '0',
  };
  return { home, dataDir, controlDir, socketPath, runDir: runDir.dir, fake, confValues, writeConf, env };
}
type Stack = Awaited<ReturnType<typeof makeStack>>;

function startApi(env: NodeJS.ProcessEnv) {
  const child = spawn(TSX, ['src/index.ts'], { cwd: API_DIR, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  children.push(child);
  let output = '';
  child.stdout!.on('data', (chunk) => { output += chunk; });
  child.stderr!.on('data', (chunk) => { output += chunk; });
  const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, output: () => output, exit };
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
    socket.once('connect', () => { socket.destroy(); resolve(true); });
  });
}

async function expectRefused(stack: Stack, code: string, env: NodeJS.ProcessEnv = stack.env) {
  const api = startApi(env);
  const exitCode = await Promise.race([api.exit, new Promise((resolve) => setTimeout(() => resolve('timeout'), 40_000))]);
  expect(exitCode, api.output()).toBe(1);
  expect(api.output()).toMatch(new RegExp(`\\[holdr-api\\] refused to start: ${code}\\b`));
  expect(await portOpen(PORT)).toBe(false);
  expect(fs.existsSync(stack.socketPath)).toBe(false);
  expect(fs.existsSync(path.join(stack.dataDir, 'finance.db'))).toBe(false);
  expect(probeExclusive(stack.controlDir)).toBe('free');
}

const preflight = (env: NodeJS.ProcessEnv) => spawnSync(TSX, [path.join(API_DIR, 'src/cli/ingressMain.ts'), 'preflight'], {
  cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 60_000,
});

describe.skipIf(process.platform !== 'darwin')('production stack with the composed runtime integration (§10.2, PR B)', () => {
  it('starts in dist: lease held, gate logged, socket bound, health local, admission closed, state file written; preflight accepts the running API', async () => {
    const stack = await makeStack({ users: true });
    const api = startApi(stack.env);
    await waitFor(() => /listening in dist mode/.test(api.output()) || api.child.exitCode !== null, 40_000);
    const output = api.output();
    expect(output).toContain('[holdr-api] listening in dist mode (2 listener(s))');
    expect(output).toContain('[holdr-control] device gate: blocked (init)');
    expect(output).toContain('[holdr-ingress] K24: Serve configuration empty');
    expect(probeExclusive(stack.controlDir)).toBe('held');
    expect(fs.lstatSync(stack.socketPath).isSocket()).toBe(true);
    expect((await rawRequest(PORT, 'GET', '/health', [['Host', `127.0.0.1:${PORT}`]])).status).toBe(200);
    const stateFile = path.join(stack.runDir, 'ingress-state.json');
    await waitFor(() => fs.existsSync(stateFile) && JSON.parse(fs.readFileSync(stateFile, 'utf8')).name === 'refused', 20_000);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(state).toMatchObject({ verified: false, runtime: { platform: 'darwin', node: process.versions.node, uv: process.versions.uv } });
    expect(state.codes).toContain('tailscale-version-unsupported');
    expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
    const viaServe = await rawRequest(stack.socketPath, 'GET', '/', SERVE_HEADERS);
    expect(viaServe.status).toBe(503);

    const checked = preflight(stack.env);
    expect(checked.stderr).toBe('');
    expect(checked.stdout).toBe('PREFLIGHT ok mode=dist serve=empty gate="blocked (init)"\n');
    expect(checked.status).toBe(0);

    process.kill(api.child.pid!, 'SIGTERM');
    expect(await api.exit).toBe(0);
    expect(probeExclusive(stack.controlDir)).toBe('free');
    expect(await portOpen(PORT)).toBe(false);
  }, 120_000);

  it('a foreign live listener at the socket path is refused by preflight (K28) and by boot', async () => {
    const stack = await makeStack({ users: true });
    const foreign = net.createServer();
    await new Promise<void>((resolve) => foreign.listen(stack.socketPath, resolve));
    fs.chmodSync(stack.socketPath, 0o600);
    cleanups.push(() => foreign.close());
    const checked = preflight(stack.env);
    expect(checked.status).toBe(1);
    expect(checked.stderr).toContain('PREFLIGHT refused E0I_SOCKET_IN_USE');
    const api = startApi(stack.env);
    expect(await api.exit).toBe(1);
    expect(api.output()).toContain('[holdr-api] refused to start: E0I_SOCKET_IN_USE');
    expect(await portOpen(PORT)).toBe(false);
    expect(probeExclusive(stack.controlDir)).toBe('free');
  }, 120_000);

  it('maintenance refuses a start before anything opens, binds or is created (K29)', async () => {
    const stack = await makeStack();
    writeMarker(stack.controlDir, marker({ state: 'maintenance', reason: 'deploy' }, 'test'));
    await expectRefused(stack, 'E0I_MAINTENANCE');
  }, 60_000);

  it.each([
    ['K17 data dir inside the release', 'E0I_DATA_OVERLAP', (stack: Stack) => stack.writeConf({ ...stack.confValues, HOLDR_DATA_DIR: path.join(release.dir, 'public/data') })],
    ['K18 a group-readable entry the API does not repair', 'E0I_DATA_PERMS', (stack: Stack) => {
      fs.writeFileSync(path.join(stack.dataDir, 'notes.txt'), 'synthetic\n', { mode: 0o640 });
      fs.chmodSync(path.join(stack.dataDir, 'notes.txt'), 0o640);
    }],
    ['K20 control dir group-readable', 'E0I_CONTROL_DIR', (stack: Stack) => fs.chmodSync(stack.controlDir, 0o750)],
    ['K21 fence file readable by others', 'E0I_FENCE_FILE', (stack: Stack) => fs.chmodSync(path.join(stack.controlDir, 'sync-auth-state'), 0o644)],
    ['K22 token file in the control dir', 'E0I_TOKEN_LOCATION', (stack: Stack) => { stack.env.HOLDR_SERVICE_TOKEN_FILE = path.join(stack.controlDir, 'token'); }],
    ['K24 known-fatal Serve configuration', 'E0I_SERVE', (stack: Stack) => stack.fake.set({ serve: '{"AllowFunnel":{"holdr.test:443":true}}\n' })],
    ['K26 holdr.conf readable by others', 'E0I_CONFIG_FILE', (stack: Stack) => stack.writeConf(stack.confValues, 0o644)],
    ['K30 native manifest pin mismatch', 'E0I_NATIVE_HELPER', (stack: Stack) => stack.writeConf({ ...stack.confValues, HOLDR_NATIVE_MANIFEST: '0'.repeat(64) })],
    ['lease variables', 'E0I_LEASE_ENV', (stack: Stack) => { stack.env.HOLDR_LIFECYCLE_LEASE = 'ab'.repeat(8); }],
  ])('refuses %s with %s and opens nothing', async (_name, code, change) => {
    const stack = await makeStack();
    change(stack);
    await expectRefused(stack, code);
  }, 60_000);

  it('a maintenance holder makes the start wait 10 s and refuse (K29 busy)', async () => {
    const stack = await makeStack();
    await lockHolder(lockPath(stack.controlDir, LIFECYCLE_LOCK), 'exclusive', cleanups);
    const started = Date.now();
    const api = startApi(stack.env);
    expect(await api.exit).toBe(1);
    expect(api.output()).toContain('[holdr-api] refused to start: E0I_LIFECYCLE_BUSY');
    expect(Date.now() - started).toBeGreaterThanOrEqual(10_000);
    expect(await portOpen(PORT)).toBe(false);
  }, 90_000);
});
