// Start-script tests for the release modes and the Serve interlocks (design §8.7 tests 2, 5–14, 16, 17), macOS only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, mkdir, chmod, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

// P-NET: refuses any listener beyond 127.0.0.1 or ::1 in this process.
import './loopback-only.mjs';
import {
  DIGEST, ORIGIN, alive, cleanup, fixture, listen, magicDns, markerText, records, releaseSetup, repo, serveShape, start,
  startFake, waitForPort, writeConf,
} from './start-finance-mac.fixture.mjs';

const darwin = { skip: process.platform !== 'darwin' };
const pidOf = async (state, service) => Number(await readFile(path.join(state.log, `${service}.pid`), 'utf8').catch(() => '0'));
const serveChanges = (calls) => calls.filter((call) => call.args[0] === 'serve' && call.args[1] !== 'status').map((call) => call.args.join(' '));
const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

/** The login-era stack running from the fake tree (Vite on the web port, the API, the bridge) with its PID files. */
async function loginEraStack(state) {
  const [apiPort, webPort, bridgePort] = state.ports;
  const api = startFake(state, 'tsx', path.join(state.finance, 'apps/api'), ['src/index.ts'], { PORT: String(apiPort) });
  const web = startFake(state, 'vite', path.join(state.finance, 'apps/web'), ['--host', '127.0.0.1', '--port', String(webPort), '--strictPort']);
  const bridge = startFake(state, 'python', path.join(state.runtime, 'portfolio-bridge'), ['server.py'], { PORTFOLIO_BRIDGE_PORT: String(bridgePort) });
  await mkdir(state.log, { recursive: true });
  for (const [service, child] of [['api', api], ['web', web], ['bridge', bridge]]) await writeFile(path.join(state.log, `${service}.pid`), `${child.pid}\n`);
  for (const port of state.ports) await waitForPort(port);
  return { api, web, bridge };
}

const ALLOWED_API_ENV = [
  'PATH', 'HOME', 'LANG', 'TMPDIR', 'NODE_ENV', 'PORT', 'HOLDR_HOST', 'HOLDR_WEB_MODE', 'HOLDR_WEB_RELEASE_DIR',
  'HOLDR_WEB_RELEASE_DIGEST', 'HOLDR_DATA_DIR', 'HOLDR_CONTROL_DIR', 'HOLDR_DEVICE_API', 'BROKER_BRIDGE_URL', 'SNAPSHOTS_ENABLED',
  'HOLDR_CONFIG', 'HOLDR_SERVE_SOCKET', 'HOLDR_PUBLIC_ORIGIN', 'WEB_ORIGIN', 'HOLDR_TAILSCALE_CLI',
].sort();

test('dist (test 5): Serve switched to the socket first, the API on the socket and the port with exactly the allowlisted environment, no Vite', { ...darwin, timeout: 180_000 }, async () => {
  const state = await fixture();
  try {
    const setup = await releaseSetup(state, { mode: 'dist' });
    const result = await start({ ...state.environment, NODE_OPTIONS: '--max-old-space-size=256', VITE_SECRET: 'x' });
    assert.equal(result.code, 0, result.output);
    for (const line of ['PREFLIGHT ok mode=dist serve=empty', `Tailscale Serve: ${ORIGIN} -> unix:${setup.socket} (switched before stopping anything)`,
      'api ok', 'bridge ok', 'attestation verified', 'serve-probe ok', `Holdr: ${ORIGIN}`]) assert.ok(result.output.includes(line), `${line}\n${result.output}`);
    assert.deepEqual(serveChanges(await setup.tailscale.calls()), [`serve --bg --https=443 unix:${setup.socket}`]);
    assert.equal(await setup.tailscale.serveJson(), serveShape(`unix:${setup.socket}`));
    const [api] = (await records(`${setup.record}.api`)).slice(-1);
    const names = Object.keys(api.env).filter((name) => name !== '__CF_USER_TEXT_ENCODING').sort();
    assert.deepEqual(names, ALLOWED_API_ENV);
    assert.equal(api.env.WEB_ORIGIN, ORIGIN);
    assert.equal(api.env.HOLDR_PUBLIC_ORIGIN, ORIGIN);
    assert.equal(api.env.HOLDR_WEB_RELEASE_DIR, path.join(state.finance, 'apps/web/releases', DIGEST.slice(0, 12)));
    assert.equal(api.env.HOLDR_CONFIG, setup.confFile);
    assert.equal(await pidOf(state, 'web'), 0, 'no Vite in dist');
    assert.equal((await fetch(`http://127.0.0.1:${state.ports[1]}/`).catch(() => null)), null, 'nothing on the web port');
    const ingress = await records(`${setup.record}.ingress`);
    assert.deepEqual(ingress.map((entry) => entry.action), ['preflight', 'serve-probe']);
    assert.deepEqual(ingress[1].args, ['--origin', ORIGIN, '--token-file', path.join(setup.dataDir, 'service-token'),
      '--release-dir', api.env.HOLDR_WEB_RELEASE_DIR]);
  } finally { await cleanup(state); }
});

test('--preflight (test 2) changes nothing: no PID file, no socket, no Serve change, running services keep their PIDs', { ...darwin, timeout: 180_000 }, async () => {
  const state = await fixture();
  try {
    const setup = await releaseSetup(state, { mode: 'dist' });
    const fresh = await start(state.environment, ['--preflight']);
    assert.equal(fresh.code, 0, fresh.output);
    assert.match(fresh.output, /^PREFLIGHT ok mode=dist serve=empty/m);
    assert.equal(existsSync(path.join(state.log, 'api.pid')), false);
    assert.equal(existsSync(setup.socket), false);
    assert.deepEqual(serveChanges(await setup.tailscale.calls()), []);
    const started = await start(state.environment);
    assert.equal(started.code, 0, started.output);
    const pids = [await pidOf(state, 'api'), await pidOf(state, 'bridge')];
    const changes = serveChanges(await setup.tailscale.calls()).length;
    const again = await start(state.environment, ['--preflight']);
    assert.equal(again.code, 0, again.output);
    assert.match(again.output, /^PREFLIGHT ok mode=dist serve=approved-dist/m);
    assert.deepEqual([await pidOf(state, 'api'), await pidOf(state, 'bridge')], pids);
    assert.ok(pids.every(alive));
    assert.equal(serveChanges(await setup.tailscale.calls()).length, changes);
  } finally { await cleanup(state); }
});

test('B1/B2 round-2 finding 2: the documented staged preflight runs the candidate\'s code and judges the running API by the live tree', { ...darwin, timeout: 240_000 }, async () => {
  const state = await fixture();
  try {
    const setup = await releaseSetup(state, { mode: 'dist' });
    // The live stack runs from the live tree (§11.2 step 6 happens while the deployed API owns the socket).
    const started = await start(state.environment);
    assert.equal(started.code, 0, started.output);
    // The staged candidate: ~/holdr-staging/C/FinanceTracker with its own code and release, and its holdr.conf beside it.
    const stage = path.join(state.home, 'holdr-staging/C');
    const C = path.join(stage, 'FinanceTracker');
    for (const dir of ['apps/api', 'apps/web/releases', 'scripts/lib', 'node_modules/.bin']) await mkdir(path.join(C, dir), { recursive: true });
    await writeFile(path.join(C, 'node_modules/.bin/tsx'), await readFile(path.join(state.finance, 'node_modules/.bin/tsx')), { mode: 0o755 });
    for (const name of ['bounded-cli.mjs', 'serve-verdict.ts']) await writeFile(path.join(C, 'scripts/lib', name), await readFile(path.join(repo, 'scripts/lib', name)));
    const candidateDigest = 'cd'.repeat(32);
    await mkdir(path.join(C, 'apps/web/releases', candidateDigest.slice(0, 12)));
    const candidateRecord = path.join(state.home, 'candidate-record');
    await writeFile(path.join(C, 'test-control.json'), JSON.stringify({ record: candidateRecord }));
    const candidateConf = path.join(stage, 'holdr.conf');
    await writeConf(candidateConf, { ...setup.values, HOLDR_WEB_RELEASE: candidateDigest });
    const env = { ...state.environment };
    delete env.HOLDR_ROOT;
    // The runbook's command: HOLDR_CANDIDATE names the candidate; HOLDR_ROOT stays unset (the live tree is the default).
    const staged = await start({ ...env, HOLDR_CANDIDATE: C, HOLDR_CONFIG: candidateConf }, ['--preflight']);
    assert.equal(staged.code, 0, staged.output);
    assert.match(staged.output, /^PREFLIGHT ok mode=dist serve=approved-dist/m);
    const [preflight] = await records(`${candidateRecord}.ingress`);
    assert.deepEqual({ ...preflight, at: undefined }, {
      at: undefined, action: 'preflight', args: ['--web-port', String(state.ports[1])], mode: 'dist', script: path.join(C, 'apps/api/src/cli/ingressMain.ts'),
      cwd: C, root: state.root, config: candidateConf, releaseDir: path.join(C, 'apps/web/releases', candidateDigest.slice(0, 12)),
    });
    // HOLDR_ROOT naming the live root explicitly is the same.
    assert.equal((await start({ ...state.environment, HOLDR_CANDIDATE: C, HOLDR_CONFIG: candidateConf }, ['--preflight'])).code, 0);
    // The old command (HOLDR_ROOT naming the staging dir) would have judged the live API by the candidate: refused, plainly.
    const old = await start({ ...env, HOLDR_ROOT: stage, HOLDR_CONFIG: candidateConf }, ['--preflight']);
    assert.equal(old.code, 2, old.output);
    assert.match(old.output, /HOLDR_ROOT \(.*holdr-staging\/C\) is a staging tree or a rollback kit, not the live deployment/);
    // B1 round-3 finding 1, the start script's side (managedLive's rule): HOLDR_ROOT naming a clean directory whose
    // FinanceTracker links into the staging tree is refused too, before any side effect, whatever the action.
    const linked = path.join(state.home, 'linked-root');
    await mkdir(linked);
    await symlink(C, path.join(linked, 'FinanceTracker'));
    for (const args of [['--preflight'], ['--stop'], []]) {
      const viaLink = await start({ ...env, HOLDR_ROOT: linked, HOLDR_CONFIG: candidateConf }, args);
      assert.equal(viaLink.code, 2, `${args}: ${viaLink.output}`);
      assert.match(viaLink.output, /The live tree .*holdr-staging\/C\/FinanceTracker sits beside holdr\.conf: a staging tree or a rollback kit, not the live deployment\./);
    }
    // HOLDR_CANDIDATE is only for --preflight, absolute, and never the live tree.
    for (const [args, extra, message] of [
      [[], { HOLDR_CANDIDATE: C }, /HOLDR_CANDIDATE is only for --preflight/],
      [['--stop'], { HOLDR_CANDIDATE: C }, /HOLDR_CANDIDATE is only for --preflight/],
      [['--preflight'], { HOLDR_CANDIDATE: 'holdr-staging/C/FinanceTracker' }, /HOLDR_CANDIDATE must be an absolute path/],
      [['--preflight'], { HOLDR_CANDIDATE: state.finance }, /is the live tree or inside it/],
      [['--preflight'], { HOLDR_CANDIDATE: path.join(state.finance, 'apps') }, /is the live tree or inside it/],
      [['--preflight'], { HOLDR_CANDIDATE: path.join(state.home, 'nowhere') }, /HOLDR_CANDIDATE: no tree at/],
    ]) {
      const refused = await start({ ...env, ...extra, HOLDR_CONFIG: candidateConf }, args);
      assert.equal(refused.code, 2, `${JSON.stringify(extra)} ${args}: ${refused.output}`);
      assert.match(refused.output, message);
    }
    // The live stack was never touched.
    assert.ok([await pidOf(state, 'api'), await pidOf(state, 'bridge')].every(alive));
  } finally { await cleanup(state); }
});

test('maintenance, a missing or an invalid marker (test 6): start and --preflight exit 1 before anything changes; --stop works', { ...darwin, timeout: 180_000 }, async () => {
  const state = await fixture();
  try {
    const setup = await releaseSetup(state, { mode: 'dist' });
    const marker = path.join(setup.controlDir, 'lifecycle-state');
    for (const [label, change] of [
      ['maintenance', () => writeFile(marker, markerText('maintenance', 'deploy'), { mode: 0o600 })],
      ['missing', async () => {}],
      ['invalid', () => writeFile(marker, '{"state":"normal"}\n', { mode: 0o600 })],
    ]) {
      await rm(marker, { force: true });
      await change();
      for (const args of [[], ['--preflight']]) {
        const result = await start(state.environment, args);
        assert.equal(result.code, 1, `${label} ${args}: ${result.output}`);
        assert.match(result.output, /E0I_MAINTENANCE/);
      }
      assert.deepEqual(await setup.tailscale.calls(), [], label);
      assert.equal(existsSync(path.join(state.log, 'api.pid')), false, label);
      const stopped = await start(state.environment, ['--stop']);
      assert.equal(stopped.code, 0, `${label}: ${stopped.output}`);
    }
  } finally { await cleanup(state); }
});

test('a preflight refusal (test 7) exits 1 and leaves the running services untouched', { ...darwin, timeout: 180_000 }, async () => {
  const state = await fixture();
  try {
    const setup = await releaseSetup(state, { mode: 'dist' });
    assert.equal((await start(state.environment)).code, 0);
    const pids = [await pidOf(state, 'api'), await pidOf(state, 'bridge')];
    await writeFile(path.join(state.finance, 'test-control.json'), JSON.stringify({ record: setup.record, preflight: 'refuse' }));
    const changes = serveChanges(await setup.tailscale.calls()).length;
    const refused = await start(state.environment);
    assert.equal(refused.code, 1, refused.output);
    assert.match(refused.output, /Preflight refused; nothing was changed/);
    await settle();
    assert.deepEqual([await pidOf(state, 'api'), await pidOf(state, 'bridge')], pids);
    assert.ok(pids.every(alive));
    assert.equal((await fetch(`http://127.0.0.1:${state.ports[0]}/health`)).status, 200);
    assert.equal(serveChanges(await setup.tailscale.calls()).length, changes);
  } finally { await cleanup(state); }
});

test('HOLDR_LAN_HTTP=1 with dist or local (test 8), and holdr.conf violations (test 9), exit 1 before anything changes', { ...darwin, timeout: 240_000 }, async () => {
  const state = await fixture();
  try {
    const setup = await releaseSetup(state, { mode: 'dist' });
    const lan = await start({ ...state.environment, HOLDR_LAN_HTTP: '1' });
    assert.equal(lan.code, 1, lan.output);
    assert.match(lan.output, /E0I_LAN_REMOVED: HOLDR_LAN_HTTP is no longer supported/);
    for (const [label, values, fileMode, env, code] of [
      ['group-readable', setup.values, 0o640, {}, 'E0I_CONFIG_FILE'],
      ['unknown key', { ...setup.values, HOLDR_SURPRISE: '1' }, 0o600, {}, 'E0I_CONFIG_FILE'],
      ['removed LAN key', { ...setup.values, HOLDR_LAN_HTTPS_IP: '192.0.2.10' }, 0o600, {}, 'E0I_LAN_REMOVED'],
      ['malformed digest', { ...setup.values, HOLDR_WEB_RELEASE: 'abc' }, 0o600, {}, 'E0I_CONFIG_FILE'],
      ['environment conflict', setup.values, 0o600, { HOLDR_WEB_MODE: 'local' }, 'E0I_CONFIG_FILE'],
      ['missing release dir', { ...setup.values, HOLDR_WEB_RELEASE: 'cd'.repeat(32) }, 0o600, {}, 'E0I_RELEASE_CONFIG'],
      ['dist without a socket', { ...setup.values, HOLDR_SERVE_SOCKET: undefined }, 0o600, {}, 'E0I_SOCKET_PATH'],
      ['dist without the CLI', { ...setup.values, HOLDR_TAILSCALE_CLI: undefined }, 0o600, {}, 'E0I_SERVE'],
    ]) {
      await writeConf(setup.confFile, values, fileMode);
      const result = await start({ ...state.environment, ...env });
      assert.equal(result.code, 1, `${label}: ${result.output}`);
      assert.ok(result.output.includes(code), `${label}: ${result.output}`);
    }
    assert.deepEqual(await setup.tailscale.calls(), []);
    assert.equal(existsSync(path.join(state.log, 'api.pid')), false);
    // Spaces in a path value work.
    const spaced = path.join(state.home, 'data with spaces');
    await mkdir(spaced, { mode: 0o700 });
    await writeConf(setup.confFile, { ...setup.values, HOLDR_DATA_DIR: spaced });
    const result = await start(state.environment);
    assert.equal(result.code, 0, result.output);
    const [api] = (await records(`${setup.record}.api`)).slice(-1);
    assert.equal(api.env.HOLDR_DATA_DIR, spaced);
  } finally { await cleanup(state); }
});

test('K27 (test 10): a MagicDNS name other than the pinned origin exits 1 before anything changes', { ...darwin, timeout: 120_000 }, async () => {
  const state = await fixture();
  try {
    const setup = await releaseSetup(state, { mode: 'dist', cliMode: { dnsName: 'other-mac.example.ts.net' } });
    const result = await start(state.environment);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /E0I_PUBLIC_ORIGIN_MISMATCH/);
    assert.deepEqual(serveChanges(await setup.tailscale.calls()), []);
    assert.equal(existsSync(path.join(state.log, 'api.pid')), false);
  } finally { await cleanup(state); }
});

test('attestation never verified (tests 10, 13): interactive runs stop what they started and turn a fresh Serve off; at boot the API stays unverified', { ...darwin, timeout: 240_000 }, async () => {
  const state = await fixture();
  try {
    const setup = await releaseSetup(state, { mode: 'dist', control: { attest: 'never' } });
    const env = { ...state.environment, HOLDR_ATTEST_WAIT: '2' };
    const interactive = await start(env);
    assert.equal(interactive.code, 1, interactive.output);
    assert.match(interactive.output, /Attestation did not reach verified within 2s \(last: unverified \(tailscale-not-running\)\)/);
    await settle();
    assert.equal(alive(await pidOf(state, 'api')), false);
    assert.equal(alive(await pidOf(state, 'bridge')), false);
    assert.equal(await setup.tailscale.serveJson(), '{}\n', 'Serve was empty before the run, so it is turned off again');
    assert.ok(!serveChanges(await setup.tailscale.calls()).some((call) => call.includes('http://')), 'no TCP target');
    const boot = await start({ ...env, HOLDR_LAUNCHD: '1' });
    assert.equal(boot.code, 0, boot.output);
    assert.match(boot.output, /WARNING: attestation is unverified/);
    assert.ok(alive(await pidOf(state, 'api')), 'the API stays running, admitting nothing until it verifies');
    assert.equal((await records(`${setup.record}.ingress`)).filter((entry) => entry.action === 'serve-probe').length, 0);
  } finally { await cleanup(state); }
});

test('a failing serve probe (test 13) stops the new stack; Serve stays on the socket when it was there before', { ...darwin, timeout: 240_000 }, async () => {
  const state = await fixture();
  try {
    const setup = await releaseSetup(state, { mode: 'dist', control: { probe: 'fail' } });
    await writeFile(`${setup.tailscale.cli}.serve.json`, serveShape(`unix:${setup.socket}`));
    const result = await start(state.environment);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /The end-to-end probe through .* failed \(step 11\)/);
    await settle();
    assert.equal(alive(await pidOf(state, 'api')), false);
    assert.equal(await setup.tailscale.serveJson(), serveShape(`unix:${setup.socket}`));
    assert.deepEqual(serveChanges(await setup.tailscale.calls()), [], 'approved-dist: no Serve call at all');
  } finally { await cleanup(state); }
});

test('Serve order (test 11): from login\'s Vite target the switch to the socket comes before Vite stops; a refused configuration changes nothing', { ...darwin, timeout: 240_000 }, async () => {
  const state = await fixture();
  try {
    const setup = await releaseSetup(state, { mode: 'dist' });
    const webTarget = `http://127.0.0.1:${state.ports[1]}`;
    // The login-era live state: its Vite on the web port, Serve targeting it (bytes as 1.98 prints them).
    await writeFile(`${setup.tailscale.cli}.serve.json`, serveShape(webTarget));
    const stack = await loginEraStack(state);
    const result = await start(state.environment);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /PREFLIGHT ok mode=dist serve=approved-vite/);
    const calls = await setup.tailscale.calls();
    const switched = calls.find((call) => call.args.join(' ') === `serve --bg --https=443 unix:${setup.socket}`);
    assert.ok(switched, JSON.stringify(calls));
    const exits = await records(`${setup.record}.exit`);
    const viteExit = exits.find((entry) => entry.service === 'vite');
    assert.ok(viteExit && switched.at < viteExit.at, 'Serve moved to the socket before the old Vite stopped');
    assert.equal(alive(stack.web.pid), false);
    assert.ok(!serveChanges(calls).some((call) => call.includes('http://')), 'never a TCP target');

    // A refused configuration (a Path handler next to Holdr): exit 1 before any change.
    await rm(`${setup.tailscale.cli}.calls`, { force: true });
    const refused = JSON.parse(serveShape(`unix:${setup.socket}`));
    refused.Web[`${magicDns}:443`].Handlers['/files'] = { Path: '/Users' };
    await writeFile(`${setup.tailscale.cli}.serve.json`, JSON.stringify(refused, null, 2) + '\n');
    const pids = [await pidOf(state, 'api'), await pidOf(state, 'bridge')];
    const blocked = await start(state.environment);
    assert.equal(blocked.code, 1, blocked.output);
    assert.match(blocked.output, /E0I_SERVE \(Serve verdict refused/);
    assert.deepEqual(serveChanges(await setup.tailscale.calls()), []);
    assert.ok(pids.every(alive), 'the running stack is kept');
  } finally { await cleanup(state); }
});

test('TCP-owner guard (test 16): with Vite listening, a failed read or a failed switch keeps it; holdr-stop refuses the same way', { ...darwin, timeout: 300_000 }, async () => {
  const state = await fixture();
  try {
    const setup = await releaseSetup(state, { mode: 'dist' });
    const webTarget = `http://127.0.0.1:${state.ports[1]}`;
    await writeFile(`${setup.tailscale.cli}.serve.json`, serveShape(webTarget));
    const stack = await loginEraStack(state);
    const occupied = async () => {
      const probe = createServer();
      const error = await new Promise((resolve) => {
        probe.once('error', resolve);
        probe.listen(state.ports[1], '127.0.0.1', () => { probe.close(); resolve(null); });
      });
      return error?.code;
    };
    await setup.tailscale.setMode({ statusFails: true });
    const unknown = await start(state.environment);
    assert.equal(unknown.code, 1, unknown.output);
    assert.match(unknown.output, /E0I_SERVE_UNKNOWN/);
    assert.ok(alive(stack.web.pid));
    assert.equal(await occupied(), 'EADDRINUSE');
    const stopRole = await start(state.environment, ['--stop']);
    assert.equal(stopRole.code, 1, stopRole.output);
    assert.match(stopRole.output, /E0I_SERVE_UNKNOWN/);
    assert.ok(alive(stack.web.pid) && alive(stack.api.pid), 'holdr-stop stopped nothing');

    await setup.tailscale.setMode({ switchFails: true });
    const switchFailed = await start(state.environment);
    assert.equal(switchFailed.code, 1, switchFailed.output);
    assert.match(switchFailed.output, /E0I_SERVE_SWITCH_FAILED/);
    assert.ok(alive(stack.web.pid));
    assert.equal(await setup.tailscale.serveJson(), serveShape(webTarget));

    const targeted = await start(state.environment, ['--stop']);
    await setup.tailscale.setMode({});
    assert.equal(targeted.code, 1, targeted.output);
    assert.match(targeted.output, /E0I_SERVE_TARGETS_WEB/);
    assert.ok(alive(stack.web.pid));
  } finally { await cleanup(state); }
});

test('local (test 14): the release on the web port, no Serve call, the break-glass banner', { ...darwin, timeout: 180_000 }, async () => {
  const state = await fixture();
  try {
    const setup = await releaseSetup(state, { mode: 'local' });
    const result = await start(state.environment);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /BREAK-GLASS: local only, ingress not verified/);
    assert.equal((await fetch(`http://127.0.0.1:${state.ports[1]}/`)).status, 200);
    assert.deepEqual(serveChanges(await setup.tailscale.calls()), []);
    const [api] = (await records(`${setup.record}.api`)).slice(-1);
    assert.equal(api.env.HOLDR_WEB_MODE, 'local');
    assert.equal(api.env.HOLDR_INGRESS_PORT, String(state.ports[1]));
    assert.equal(api.env.HOLDR_SERVE_SOCKET, undefined);
    assert.equal(api.env.HOLDR_PUBLIC_ORIGIN, undefined);
  } finally { await cleanup(state); }
});

test('guarded legacy publication (test 12): vite publishes only its own verified Vite; a foreign listener or a retired key publishes nothing', { ...darwin, timeout: 300_000 }, async () => {
  const state = await fixture();
  try {
    const setup = await releaseSetup(state, { mode: 'dist' });
    // The legacy rollback: holdr.conf in vite with the key, holdr.conf.dist naming the socket target Serve is on.
    await writeConf(path.join(state.runtime, 'holdr.conf.dist'), setup.values);
    const vite = { HOLDR_WEB_MODE: 'vite', HOLDR_DATA_DIR: setup.dataDir, HOLDR_CONTROL_DIR: setup.controlDir, HOLDR_LEGACY_VITE_ROLLBACK: '1' };
    await writeConf(setup.confFile, vite);
    await writeFile(`${setup.tailscale.cli}.serve.json`, serveShape(`unix:${setup.socket}`));
    const env = { ...state.environment, HOLDR_TAILSCALE: setup.tailscale.cli, HOLDR_TAILSCALE_WAIT: '0', HOLDR_LAUNCHD: '1', HOLDR_TEST_RECORD: setup.record };
    const target = `http://127.0.0.1:${state.ports[1]}`;
    const published = await start(env);
    assert.equal(published.code, 0, published.output);
    assert.ok(published.output.includes(`Tailscale Serve: https://${magicDns} -> ${target} (configured now)`), published.output);
    const calls = await setup.tailscale.calls();
    const serveCall = calls.find((call) => call.args.join(' ') === `serve --bg --https=443 ${target}`);
    assert.ok(serveCall);
    const viteRecord = JSON.parse(await readFile(`${setup.record}.vite.json`, 'utf8'));
    assert.ok(viteRecord, 'the Vite this script started recorded itself before the publication');
    const webPid = await pidOf(state, 'web');
    assert.ok(alive(webPid));

    // A foreign listener on the web port: the start stops before anything, and Serve is not changed.
    assert.equal((await start({ ...env }, ['--stop'])).code, 1, 'Serve targets the Vite: the stop role keeps it');
    await setup.tailscale.setMode({});
    await writeFile(`${setup.tailscale.cli}.serve.json`, serveShape(`unix:${setup.socket}`));
    process.kill(webPid, 'SIGTERM');
    await settle();
    const foreign = createServer((_request, response) => response.end('foreign'));
    await new Promise((resolve) => foreign.listen(state.ports[1], '127.0.0.1', resolve));
    try {
      await rm(`${setup.tailscale.cli}.calls`, { force: true });
      const blocked = await start(env);
      assert.equal(blocked.code, 1, blocked.output);
      assert.match(blocked.output, /non-Holdr process/);
      assert.deepEqual(serveChanges(await setup.tailscale.calls()), []);
    } finally { await new Promise((resolve) => foreign.close(resolve)); }

    // AL1 sign-off removed the key: vite publishes no TCP target at all.
    await writeConf(setup.confFile, { ...vite, HOLDR_LEGACY_VITE_ROLLBACK: undefined });
    const retired = await start(env);
    assert.equal(retired.code, 1, retired.output);
    assert.match(retired.output, /E0I_TCP_TARGET_RETIRED/);
  } finally { await cleanup(state); }
});

test('login-era launcher during a legacy rollback (test 17): Serve on the socket keeps it from publishing; the kit publisher checks the owner', { ...darwin, timeout: 300_000 }, async () => {
  const state = await fixture();
  try {
    const setup = await releaseSetup(state, { mode: 'dist' });
    await writeFile(`${setup.tailscale.cli}.serve.json`, serveShape(`unix:${setup.socket}`));
    // The 8b7a9ca launcher as restored by a Path B revert (only its node and lockf paths adapted to this test Mac).
    const old = spawnSync('git', ['show', '8b7a9ca:scripts/start-finance-mac.sh'], { cwd: repo, encoding: 'utf8' });
    assert.equal(old.status, 0, old.stderr);
    const launcher = path.join(state.home, 'old-start.sh');
    await writeFile(launcher, old.stdout.replaceAll('/opt/homebrew/bin/node', process.execPath).replaceAll('/usr/bin/lockf', state.lockf));
    await rm(setup.confFile);
    const env = { ...state.environment, HOLDR_TAILSCALE: setup.tailscale.cli, HOLDR_TAILSCALE_WAIT: '0', HOLDR_LAUNCHD: '1', HOLDR_TEST_FAIL_API: '1' };
    const run = await new Promise((resolve) => {
      const child = spawn('/bin/bash', [launcher], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (data) => { output += data; });
      child.stderr.on('data', (data) => { output += data; });
      child.once('close', (code) => resolve({ code, output }));
    });
    assert.equal(run.code, 1, run.output);
    assert.match(run.output, /already uses https:\/\/.* for something else/);
    assert.deepEqual(serveChanges(await setup.tailscale.calls()), [], 'the old launcher issued no serve --bg');

    // The kit's own publisher (here the fixture tree plays the kit: its copy pins the test Node) with the
    // rollback operation's configuration.
    const kc = path.join(state.home, 'kit-holdr.conf');
    await writeConf(kc, setup.values);
    const publisher = path.join(state.finance, 'scripts/holdr-publish-legacy.sh');
    const publish = (extra = []) => new Promise((resolve) => {
      const child = spawn('/bin/bash', [publisher, '--kit', state.finance, '--root', state.root, ...extra], {
        env: { ...state.environment, HOLDR_CONFIG: kc }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (data) => { output += data; });
      child.stderr.on('data', (data) => { output += data; });
      child.once('close', (code) => resolve({ code, output }));
    });
    const check = await publish(['--check-only']);
    assert.equal(check.code, 0, check.output);
    assert.match(check.output, /dependencies ok; Serve verdict approved-dist; nothing changed/);
    const target = `http://127.0.0.1:${state.ports[1]}`;
    const done = await publish();
    assert.equal(done.code, 0, done.output);
    assert.equal(await setup.tailscale.serveJson(), serveShape(target));

    // Not when a foreign listener holds the port first.
    process.kill(await pidOf(state, 'web'), 'SIGTERM');
    await settle();
    await writeFile(`${setup.tailscale.cli}.serve.json`, serveShape(`unix:${setup.socket}`));
    const foreign = createServer((_request, response) => response.end('<script src="/@vite/client"></script>'));
    await new Promise((resolve) => foreign.listen(state.ports[1], '127.0.0.1', resolve));
    try {
      const refused = await publish();
      assert.equal(refused.code, 1, refused.output);
      assert.match(refused.output, /E0I_LEGACY_OWNER/);
      assert.equal(await setup.tailscale.serveJson(), serveShape(`unix:${setup.socket}`));
    } finally { await new Promise((resolve) => foreign.close(resolve)); }
    const version = spawnSync('/bin/bash', [publisher, '--version'], { encoding: 'utf8' });
    assert.equal(version.stdout, 'holdr-publish-legacy 1\n');
  } finally { await cleanup(state); }
});

test('set-mode output (§3.3, test 9) is accepted by the start script for each mode', { ...darwin, timeout: 240_000 }, async () => {
  const state = await fixture();
  try {
    const setup = await releaseSetup(state, { mode: 'dist' });
    const setMode = (args) => spawnSync(process.execPath, ['--import', path.join(repo, 'node_modules/tsx/dist/loader.mjs'),
      path.join(repo, 'apps/api/src/cli/ingressMain.ts'), 'set-mode', ...args], { env: { ...state.environment, HOLDR_CONFIG: setup.confFile }, encoding: 'utf8' });
    for (const [args, mode] of [[['local'], 'local'], [['dist'], 'dist'], [['vite', '--legacy-rollback'], 'vite'], [['dist'], 'dist']]) {
      const changed = setMode(args);
      assert.equal(changed.status, 0, changed.stderr);
      const result = await start({ ...state.environment, HOLDR_CONFIG: setup.confFile }, ['--preflight']);
      assert.equal(result.code, 0, `${mode}: ${result.output}`);
      assert.match(result.output, new RegExp(`^PREFLIGHT ok mode=${mode}`, 'm'));
    }
    assert.equal(await readFile(path.join(state.runtime, 'holdr.conf.dist'), 'utf8').then((text) => text.includes('HOLDR_WEB_MODE=dist')), true);
  } finally { await cleanup(state); }
});

// ------------------------------------------------------------------------------------------------ B review round 1 (B2, B1)

const inner = (state) => path.join(state.home, 'bin', 'start-finance-mac.sh');
function run(file, args, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.once('close', (code) => resolve({ code, output, ms: Date.now() - started }));
  });
}

test('B2 review 1: the stop role keeps a web-port owner when no CLI exists or Serve\'s output is not a schema it knows', { ...darwin, timeout: 300_000 }, async () => {
  const state = await fixture();
  try {
    const setup = await releaseSetup(state, { mode: 'dist' });
    const webTarget = `http://127.0.0.1:${state.ports[1]}`;
    await writeFile(`${setup.tailscale.cli}.serve.json`, serveShape(webTarget));
    const stack = await loginEraStack(state);
    // The legacy rollback's holdr.conf carries no HOLDR_TAILSCALE_CLI (set-mode vite drops it), and no fallback CLI exists.
    const setMode = spawnSync(process.execPath, ['--import', path.join(repo, 'node_modules/tsx/dist/loader.mjs'),
      path.join(repo, 'apps/api/src/cli/ingressMain.ts'), 'set-mode', 'vite', '--legacy-rollback'],
    { env: { ...state.environment, HOLDR_CONFIG: setup.confFile }, encoding: 'utf8' });
    assert.equal(setMode.status, 0, setMode.stderr);
    assert.ok(!(await readFile(setup.confFile, 'utf8')).includes('HOLDR_TAILSCALE_CLI='));
    const missing = await start(state.environment, ['--stop']);
    assert.equal(missing.code, 1, missing.output);
    assert.match(missing.output, /E0I_SERVE_UNKNOWN \(no Tailscale CLI/);
    assert.ok(alive(stack.web.pid) && alive(stack.api.pid), 'nothing stopped');
    // A CLI that answers with a configuration outside Serve's known schema (or with wrong types) is not "clear" either.
    for (const shape of ['{"FutureServeConfig":{"Proxy":"http://127.0.0.1:5318"}}\n', '{"TCP":[{"TCPForward":"127.0.0.1:1"}]}\n',
      '{"Web":"unavailable"}\n', '{"TCP":{"443":{"FutureForward":"127.0.0.1:1"}}}\n']) {
      await writeFile(`${setup.tailscale.cli}.serve.json`, shape);
      const unknown = await start({ ...state.environment, HOLDR_TAILSCALE: setup.tailscale.cli }, ['--stop']);
      assert.equal(unknown.code, 1, `${shape}: ${unknown.output}`);
      assert.match(unknown.output, /E0I_SERVE_UNKNOWN/);
      assert.ok(alive(stack.web.pid), shape);
    }
    // A recognised empty configuration is the only way to stop it.
    await writeFile(`${setup.tailscale.cli}.serve.json`, '{}\n');
    const clear = await start({ ...state.environment, HOLDR_TAILSCALE: setup.tailscale.cli }, ['--stop']);
    assert.equal(clear.code, 0, clear.output);
  } finally { await cleanup(state); }
});

test('B2 review 2: HOLDR_NODE selects the installed runtime, HOLDR_LOCKF is ignored, and the locked branch needs the real parent lock', { ...darwin, timeout: 240_000 }, async () => {
  const state = await fixture();
  try {
    await releaseSetup(state, { mode: 'dist' });
    const canary = path.join(state.home, 'override-ran');
    const wrapper = path.join(state.home, 'override');
    await writeFile(wrapper, `#!/bin/bash\necho ran >> "${canary}"\nexec "${process.execPath}" "$@"\n`);
    await chmod(wrapper, 0o755);
    const overridden = await start({ ...state.environment, HOLDR_NODE: wrapper, HOLDR_LOCKF: wrapper }, ['--preflight']);
    assert.equal(overridden.code, 0, overridden.output);
    assert.equal(existsSync(canary), true, 'the configured Node runtime was executed');
    for (const name of ['start-finance-mac.sh', 'holdr-stop.sh', 'holdr-publish-legacy.sh', 'rollback-kit.sh', 'deploy-apply.sh', 'holdr-leased.sh']) {
      const source = await readFile(path.join(repo, 'scripts', name), 'utf8');
      assert.match(source, /HOLDR_NODE/, name);
      assert.doesNotMatch(source, /HOLDR_LOCKF/, name);
    }
    // A parent that only mimics lockf's command line, or opens the lock file without locking it, does not hold the lock.
    const lockFile = path.join(state.log, 'start.lockfile');
    const mimic = path.join(state.home, 'mimic.js');
    await writeFile(mimic, `
      const fs = require('node:fs');
      const { spawn } = require('node:child_process');
      const [lockFile, script, open] = process.argv.slice(2);
      if (open === 'open') fs.openSync(lockFile, 'r');
      const child = spawn('/bin/bash', [script, '--holdr-start-locked', '--preflight'], { stdio: 'inherit' });
      child.on('exit', (code) => process.exit(code ?? 1));
    `);
    await writeFile(lockFile, '');
    for (const open of ['', 'open']) {
      const spoofed = await run(process.execPath, [mimic, lockFile, inner(state), open, '-t', '0', '-k', lockFile, '/bin/bash', inner(state), '--holdr-start-locked'], state.environment);
      assert.equal(spoofed.code, 2, `${open}: ${spoofed.output}`);
      assert.match(spoofed.output, /--holdr-start-locked is internal to the start script \(the start lock is not held/);
      assert.doesNotMatch(spoofed.output, /PREFLIGHT/);
    }
    // The real (stand-in) lock serialises two starts.
    const both = await Promise.all([start(state.environment, ['--preflight']), start(state.environment, ['--preflight'])]);
    assert.ok(both.some((result) => result.code === 0), both.map((r) => r.output).join('\n'));
  } finally { await cleanup(state); }
});

test('B2 review 3: bridge prerequisites are checked before anything changes; an unexpected failure after launch still stops the new services', { ...darwin, timeout: 240_000 }, async () => {
  const state = await fixture();
  try {
    const setup = await releaseSetup(state, { mode: 'dist' });
    const python = path.join(state.runtime, '.venv313', 'bin', 'python');
    await chmod(python, 0o600);
    const refused = await start(state.environment);
    assert.equal(refused.code, 1, refused.output);
    assert.match(refused.output, /The portfolio bridge cannot start .*nothing was changed/);
    assert.deepEqual(serveChanges(await setup.tailscale.calls()), []);
    assert.equal(existsSync(path.join(state.log, 'api.pid')), false);
    await chmod(python, 0o755);
    // A shell failure right after the API was launched (its PID file cannot be written).
    await mkdir(path.join(state.log, 'api.pid'), { recursive: true });
    const broken = await start(state.environment);
    assert.notEqual(broken.code, 0, broken.output);
    assert.match(broken.output, /The start failed unexpectedly \(exit \d+\) after launching services; stopping them/);
    assert.match(broken.output, /Tailscale Serve is empty \(confirmed\)/);
    await settle();
    assert.equal(await fetch(`http://127.0.0.1:${state.ports[0]}/health`).then(() => 'up', () => 'down'), 'down', 'the new API was stopped');
    assert.equal(await setup.tailscale.serveJson(), '{}\n', 'Serve was empty before: turned off again');
  } finally { await cleanup(state); }
});

test('B2 review 4: a hanging Serve change is bounded; the start reports, releases its lock and leaves nothing running', { ...darwin, timeout: 300_000 }, async () => {
  const state = await fixture();
  try {
    const setup = await releaseSetup(state, { mode: 'dist' });
    await setup.tailscale.setMode({ hang: '--bg' });
    const hung = await start(state.environment);
    assert.equal(hung.code, 1, hung.output);
    assert.match(hung.output, /The Serve switch command failed or timed out \(step 7\)/);
    assert.match(hung.output, /E0I_SERVE_SWITCH_FAILED: .*Serve is now empty \(confirmed\)/);
    const pid = Number(await readFile(`${setup.tailscale.cli}.hung`, 'utf8'));
    assert.equal(alive(pid), false, 'the hung CLI was killed');
    assert.equal((await start(state.environment, ['--stop'])).code, 0, 'the start lock was released');

    // The turn-off in the failure cleanup hangs: bounded too, and the state reported is the one read afterwards.
    await setup.tailscale.setMode({ hang: 'off' });
    await writeFile(path.join(state.finance, 'test-control.json'), JSON.stringify({ record: setup.record, attest: 'never' }));
    const off = await start({ ...state.environment, HOLDR_ATTEST_WAIT: '2' });
    assert.equal(off.code, 1, off.output);
    assert.match(off.output, /Turning Tailscale Serve off failed or timed out/);
    assert.match(off.output, /Tailscale Serve stays on the socket target \(it answers 502 while Holdr is stopped; confirmed\)/);
    assert.equal(alive(Number(await readFile(`${setup.tailscale.cli}.hung`, 'utf8'))), false);
    assert.equal((await start(state.environment, ['--stop'])).code, 0);
  } finally { await cleanup(state); }
});

test('B2 review 8: a failed switch with nobody on the web port turns the old TCP target off and reports only a confirmed state', { ...darwin, timeout: 240_000 }, async () => {
  const state = await fixture();
  try {
    const webTarget = `http://127.0.0.1:${state.ports[1]}`;
    const setup = await releaseSetup(state, { mode: 'dist', serve: serveShape(webTarget), cliMode: { switchFails: true } });
    const result = await start(state.environment);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, new RegExp(`nothing owned port ${state.ports[1]}, so Serve is now empty \\(confirmed\\)`));
    assert.doesNotMatch(result.output, /stays on the socket target/);
    assert.equal(await setup.tailscale.serveJson(), '{}\n');
    assert.ok(serveChanges(await setup.tailscale.calls()).includes('serve --https=443 off'));
    assert.equal(existsSync(path.join(state.log, 'api.pid')), false, 'the API never started');
    // The same with a CLI that cannot even turn it off: the actual state is reported, with the command to fix it.
    await setup.tailscale.setMode({ switchFails: true, hang: 'off' });
    await writeFile(`${setup.tailscale.cli}.serve.json`, serveShape(webTarget));
    const stuck = await start(state.environment);
    assert.equal(stuck.code, 1, stuck.output);
    assert.match(stuck.output, new RegExp(`is on the TCP target ${webTarget.replace(/[.]/g, '\\.')}, while nothing owns port ${state.ports[1]}\\. Turn it off now`));
  } finally { await cleanup(state); }
});
