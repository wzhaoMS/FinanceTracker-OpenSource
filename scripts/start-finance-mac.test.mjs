import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

// P-NET: refuses any listener beyond 127.0.0.1 or ::1 in this process.
import './loopback-only.mjs';
import {
  alive, cleanup, copyWithTestTools, fakeService, fakeTailscale, fixture, listen, markerText, records, releaseSetup, start, startFake,
  waitForPort, writeConf,
} from './start-finance-mac.fixture.mjs';

const bootScript = fileURLToPath(new URL('./holdr-boot.sh', import.meta.url));

for (const startupStatus of [0, 7]) {
  test(`continues after IPv4 timeout and preserves startup status ${startupStatus}`, { skip: process.platform !== 'darwin', timeout: 10_000 }, async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'holdr-boot-test-'));
    try {
      const bin = path.join(home, 'bin');
      await mkdir(bin);
      const source = await readFile(bootScript, 'utf8');
      assert.match(source, /export PATH="/);
      const isolatedBoot = path.join(home, 'holdr-boot.sh');
      await writeFile(isolatedBoot, source.replace('export PATH="', 'export PATH="$HOME/bin:'));
      const network = path.join(bin, 'scutil');
      await writeFile(network, '#!/bin/bash\necho IPV4_TIMEOUT_SIMULATED >&2\nexit 1\n');
      await chmod(network, 0o755);
      await writeFile(path.join(bin, 'start-finance-mac.sh'), `#!/bin/bash\necho STARTED_WITH_LAUNCHD=$HOLDR_LAUNCHD\nexit ${startupStatus}\n`);
      const result = await new Promise((resolve, reject) => {
        const child = spawn('/bin/bash', [isolatedBoot], { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
        let output = '';
        child.stdout.on('data', (data) => { output += data; });
        child.stderr.on('data', (data) => { output += data; });
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, output }));
      });
      assert.equal(result.code, startupStatus, result.output);
      assert.match(result.output, /IPV4_TIMEOUT_SIMULATED/);
      assert.match(result.output, /starting local services/);
      assert.match(result.output, /STARTED_WITH_LAUNCHD=1/);
      assert.match(result.output, new RegExp(`holdr-boot: startup exit=${startupStatus}`));
    } finally { await rm(home, { recursive: true, force: true }); }
  });
}

for (const mode of ['0', '1']) {
  test(`starts all services and safely restarts (launchd=${mode})`, { skip: process.platform !== 'darwin', timeout: 90_000 }, async () => {
    const state = await fixture();
    try {
      const environment = { ...state.environment, HOLDR_LAUNCHD: mode };
      const first = await start(environment);
      assert.equal(first.code, 0, first.output);
      const before = await readFile(path.join(state.log, 'api.pid'), 'utf8');
      const second = await start(environment);
      assert.equal(second.code, 0, second.output);
      assert.notEqual(await readFile(path.join(state.log, 'api.pid'), 'utf8'), before);
      for (const port of state.ports) assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
      assert.match(second.output, /api ok/);
      assert.match(second.output, /web ok/);
      assert.match(second.output, /bridge ok/);
    } finally { await cleanup(state); }
  });
}

test('does not stop a non-Holdr process occupying a service port', { skip: process.platform !== 'darwin', timeout: 15_000 }, async () => {
  const state = await fixture();
  const unrelated = createServer((_request, response) => response.end('unrelated'));
  try {
    const port = await listen(unrelated);
    const result = await start({ ...state.environment, HOLDR_LAUNCHD: '1', HOLDR_WEB_PORT: String(port) });
    assert.notEqual(result.code, 0);
    assert.match(result.output, /non-Holdr process/);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'unrelated');
    assert.equal(await readFile(path.join(state.log, 'api.pid'), 'utf8').catch(() => null), null);
  } finally {
    await new Promise((resolve) => unrelated.close(resolve));
    await cleanup(state);
  }
});

test('reports failure even when the last health check succeeds', { skip: process.platform !== 'darwin', timeout: 90_000 }, async () => {
  const state = await fixture();
  try {
    const result = await start({ ...state.environment, HOLDR_LAUNCHD: '1', HOLDR_TEST_FAIL_API: '1' });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /api failed/);
    assert.match(result.output, /bridge ok/);
  } finally { await cleanup(state); }
});

const tailnetIp = "printf '100.101.102.103\\nfd7a:115c:a1e0::1234\\n'";
const pinned = '100.101.102.103,fd7a:115c:a1e0::1234,';
const magicDns = 'holdr.example.ts.net';
// What `tailscale serve --bg --https=443 <target>` stores; the target is the last argument.
const serveOk = `printf '{"TCP":{"443":{"HTTPS":true}},"Web":{"${magicDns}:443":{"Handlers":{"/":{"Proxy":"%s"}}}}}\\n' "\${@: -1}" > "$0.serve.json"`;
const servedBy = (target, extraHandlers = {}) => ({
  TCP: { 443: { HTTPS: true } },
  Web: { [`${magicDns}:443`]: { Handlers: { '/': { Proxy: target }, ...extraHandlers } } },
});

// Starts Holdr with HOLDR_TEST_RECORD set and returns what the fake API (tsx) and web server (vite) saw.
async function startRecorded(state, environment = {}) {
  const record = path.join(state.home, 'record');
  for (const file of [`${record}.tsx.json`, `${record}.vite.json`]) await rm(file, { force: true });
  const began = Date.now();
  const result = await start({ ...state.environment, HOLDR_LAUNCHD: '1', HOLDR_TEST_RECORD: record, WEB_ORIGIN: '', ...environment });
  const elapsed = Date.now() - began;
  assert.equal(result.code, 0, result.output);
  const read = async (service) => JSON.parse(await readFile(`${record}.${service}.json`, 'utf8'));
  const api = await read('tsx');
  return { output: result.output, elapsed, api, vite: await read('vite'), origins: api.origins.split(',') };
}

// Starts Holdr against a fake Tailscale CLI whose `ip` runs ipCommand; "$0.calls" counts those runs.
// `serve` keeps its configuration in "$0.serve.json"; "$0.serve-calls" logs every serve call.
async function startWithTailscale(state, ipCommand, {
  wait = '0', dnsName = 'Holdr.Example.ts.net.', serve = serveOk, serveConfig, environment = {},
} = {}) {
  const cli = path.join(state.home, 'fake-tailscale');
  const status = JSON.stringify({ BackendState: 'Running', Self: { DNSName: dnsName } });
  await writeFile(cli, `#!/bin/bash
if [ "$1" = status ]; then printf '%s\\n' '${status}'; exit 0; fi
if [ "$1" = serve ]; then
  echo "$*" >> "$0.serve-calls"
  if [ "$2" = status ]; then cat "$0.serve.json" 2>/dev/null || echo null; exit 0; fi
  ${serve}
  exit
fi
echo $(( $(cat "$0.calls" 2>/dev/null || echo 0) + 1 )) > "$0.calls"
${ipCommand}
`);
  await chmod(cli, 0o755);
  for (const file of [`${cli}.calls`, `${cli}.serve-calls`]) await rm(file, { force: true });
  if (serveConfig !== undefined) await writeFile(`${cli}.serve.json`, JSON.stringify(serveConfig));
  const result = await startRecorded(state, { HOLDR_TAILSCALE: cli, HOLDR_TAILSCALE_WAIT: wait, ...environment });
  const serveCalls = (await readFile(`${cli}.serve-calls`, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return {
    ...result,
    calls: Number(await readFile(`${cli}.calls`, 'utf8').catch(() => '0')),
    serveChanges: serveCalls.filter((call) => !call.startsWith('serve status')),
  };
}

test('pins Tailscale addresses and the MagicDNS name only when `tailscale ip` succeeds', { skip: process.platform !== 'darwin', timeout: 90_000 }, async () => {
  const state = await fixture();
  try {
    const up = await startWithTailscale(state, tailnetIp);
    assert.equal(up.vite.addresses, pinned);
    assert.equal(up.vite.hostname, magicDns);
    assert.ok(up.origins.includes(`https://${magicDns}`), up.origins.join());
    assert.ok(!up.origins.some((origin) => origin.includes('fd7a')), up.origins.join());
    const down = await startWithTailscale(state, `${tailnetIp}; exit 1`);
    assert.match(down.output, /Tailscale was not ready within 0s/);
    assert.equal(down.vite.addresses, '');
    assert.equal(down.vite.hostname, '');
    assert.ok(!down.origins.some((origin) => /100\.101\.102\.103|ts\.net/.test(origin)), down.origins.join());
  } finally { await cleanup(state); }
});

test('waits for Tailscale that starts after Holdr', { skip: process.platform !== 'darwin', timeout: 90_000 }, async () => {
  const state = await fixture();
  try {
    const late = await startWithTailscale(state, `[ "$(cat "$0.calls")" -gt 2 ] || exit 1; ${tailnetIp}`, { wait: '30' });
    assert.match(late.output, /Waiting up to 30s for Tailscale/);
    assert.doesNotMatch(late.output, /not ready/);
    assert.equal(late.calls, 3);
    assert.equal(late.vite.addresses, pinned);
    assert.equal(late.vite.hostname, magicDns);
  } finally { await cleanup(state); }
});

test('bounds the wait when `tailscale ip` hangs', { skip: process.platform !== 'darwin', timeout: 90_000 }, async () => {
  const state = await fixture();
  try {
    const invalid = await start({ ...state.environment, HOLDR_LAUNCHD: '1', HOLDR_TAILSCALE_WAIT: '1000' });
    assert.equal(invalid.code, 1, invalid.output);
    assert.match(invalid.output, /Invalid HOLDR_TAILSCALE_WAIT/);
    for (const hang of ['exec sleep 600', 'sleep 600 & echo $! > "$0.orphan"; wait']) {
      const stuck = await startWithTailscale(state, hang, { wait: '1' });
      assert.match(stuck.output, /Tailscale was not ready within 1s/, hang);
      assert.equal(stuck.vite.addresses, '', hang);
      assert.ok(stuck.elapsed < 40_000, `${hang}: ${stuck.elapsed} ms`);
    }
  } finally {
    const orphan = await readFile(path.join(state.home, 'fake-tailscale.orphan'), 'utf8').catch(() => '');
    if (/^[1-9][0-9]*\s*$/.test(orphan)) {
      try { process.kill(Number(orphan), 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await cleanup(state);
  }
});

test('drops a MagicDNS name that is not an exact machine name', { skip: process.platform !== 'darwin', timeout: 90_000 }, async () => {
  const state = await fixture();
  try {
    for (const dnsName of ['.example.ts.net.', 'evil.example.com.', 'www.holdr.example.ts.net.']) {
      const result = await startWithTailscale(state, tailnetIp, { dnsName });
      assert.equal(result.vite.addresses, pinned, dnsName);
      assert.equal(result.vite.hostname, '', dnsName);
      assert.ok(!result.origins.some((origin) => /ts\.net|example\.com/.test(origin)), dnsName);
    }
  } finally { await cleanup(state); }
});

test('recovers a leftover lock file but refuses a live lock holder', { skip: process.platform !== 'darwin', timeout: 90_000 }, async () => {
  const state = await fixture();
  let holder;
  let holderClosed;
  try {
    await mkdir(state.log, { recursive: true });
    const lock = path.join(state.log, 'start.lockfile');
    await writeFile(lock, 'left over from an earlier boot\n');
    holder = spawn(state.lockf, ['-t', '0', '-k', lock, process.execPath, '-e',
      "process.stdout.write('LOCKED'); process.stdin.resume();"], { stdio: ['pipe', 'pipe', 'pipe'] });
    holderClosed = new Promise((resolve, reject) => {
      holder.once('error', reject);
      holder.once('close', resolve);
    });
    await new Promise((resolve, reject) => {
      holder.stdout.once('data', resolve);
      holder.once('error', reject);
      holder.once('close', () => reject(new Error('Test lock holder exited before readiness')));
    });
    const blocked = await start({ ...state.environment, HOLDR_LAUNCHD: '1' });
    assert.equal(blocked.code, 75, blocked.output);
    assert.equal(await readFile(lock, 'utf8'), 'left over from an earlier boot\n');
    holder.stdin.end();
    await holderClosed;
    const recovered = await start({ ...state.environment, HOLDR_LAUNCHD: '1' });
    assert.equal(recovered.code, 0, recovered.output);
  } finally {
    if (holder && holder.exitCode == null) {
      holder.stdin.end();
      await holderClosed;
    }
    await cleanup(state);
  }
});

test('without Tailscale everything stays on loopback, reachable from this Mac only', { skip: process.platform !== 'darwin', timeout: 90_000 }, async () => {
  const state = await fixture();
  try {
    const web = state.environment.HOLDR_WEB_PORT;
    const local = await startRecorded(state);
    assert.equal(local.api.apiHost, '127.0.0.1');
    assert.equal(local.vite.apiTarget, `http://127.0.0.1:${state.ports[0]}`);
    assert.equal(local.vite.bind, '127.0.0.1');
    assert.equal(local.api.publicOrigin, '');
    assert.deepEqual(local.origins, [`http://localhost:${web}`, `http://127.0.0.1:${web}`]);
    assert.match(local.output, /Other devices: not set up/);
    assert.match(local.output, new RegExp(`tailscale serve --bg --https=443 http://127\\.0\\.0\\.1:${web}`));
  } finally { await cleanup(state); }
});

test('serves other devices over HTTPS through Tailscale Serve by default', { skip: process.platform !== 'darwin', timeout: 120_000 }, async () => {
  const state = await fixture();
  try {
    const web = state.environment.HOLDR_WEB_PORT;
    const target = `http://127.0.0.1:${web}`;
    const first = await startWithTailscale(state, tailnetIp);
    assert.equal(first.vite.bind, '127.0.0.1');
    assert.equal(first.api.apiHost, '127.0.0.1');
    assert.equal(first.api.publicOrigin, `https://${magicDns}`);
    assert.equal(first.vite.publicOrigin, `https://${magicDns}`);
    assert.deepEqual(first.origins, [`http://localhost:${web}`, `http://127.0.0.1:${web}`, `https://${magicDns}`]);
    assert.deepEqual(first.serveChanges, [`serve --bg --https=443 ${target}`]);
    assert.ok(first.output.includes(`Tailscale Serve: https://${magicDns} -> ${target} (configured now)`), first.output);
    assert.ok(first.output.includes(`Holdr on your devices: https://${magicDns}\n`), first.output);
    assert.doesNotMatch(first.output, /WARNING/);

    const again = await startWithTailscale(state, tailnetIp);
    assert.deepEqual(again.serveChanges, []);
    assert.ok(again.output.includes(`Tailscale Serve: https://${magicDns} -> ${target}\n`), again.output);

    const shared = servedBy(target);
    shared.TCP[8443] = { HTTPS: true };
    shared.Web[`${magicDns}:8443`] = { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } };
    const funnel = await startWithTailscale(state, tailnetIp, {
      serveConfig: { ...shared, AllowFunnel: { [`${magicDns}:443`]: true } },
    });
    assert.deepEqual(funnel.serveChanges, []);
    assert.match(funnel.output, /WARNING: Tailscale Funnel is on/);
    assert.ok(funnel.output.includes(`WARNING: Tailscale Serve also publishes https://${magicDns}:8443.`), funnel.output);
    assert.doesNotMatch(again.output, /also publishes/);
  } finally { await cleanup(state); }
});

test('leaves a different Tailscale Serve setup on port 443 alone', { skip: process.platform !== 'darwin', timeout: 120_000 }, async () => {
  const state = await fixture();
  try {
    const web = state.environment.HOLDR_WEB_PORT;
    const target = `http://127.0.0.1:${web}`;
    for (const serveConfig of [servedBy('http://127.0.0.1:3000'), servedBy(target, { '/files': { Path: '/Users' } })]) {
      const other = await startWithTailscale(state, tailnetIp, { serveConfig });
      assert.deepEqual(other.serveChanges, [], JSON.stringify(serveConfig));
      assert.ok(other.output.includes(`Tailscale Serve already uses https://${magicDns} for something else`), other.output);
      assert.ok(other.output.includes(`serve --bg --https=443 ${target}`), other.output);
      assert.match(other.output, /once Tailscale Serve forwards it here/);
    }
  } finally { await cleanup(state); }
});

test('keeps starting and prints the one-time command when Tailscale Serve cannot be configured', { skip: process.platform !== 'darwin', timeout: 90_000 }, async () => {
  const state = await fixture();
  try {
    const web = state.environment.HOLDR_WEB_PORT;
    const denied = await startWithTailscale(state, tailnetIp, { serve: "echo 'Access denied: serve config denied' >&2; exit 1" });
    assert.deepEqual(denied.serveChanges, [`serve --bg --https=443 http://127.0.0.1:${web}`]);
    assert.match(denied.output, /Could not configure Tailscale Serve:\nAccess denied: serve config denied/);
    assert.match(denied.output, /MagicDNS and HTTPS certificates/);
    assert.ok(denied.output.includes(`serve --bg --https=443 http://127.0.0.1:${web}`), denied.output);
    assert.match(denied.output, /once Tailscale Serve forwards it here/);
    assert.match(denied.output, /api ok/);
  } finally { await cleanup(state); }
});

test('the removed LAN modes stop a start before anything changes, and never block the stop role', { skip: process.platform !== 'darwin', timeout: 90_000 }, async () => {
  const state = await fixture();
  try {
    for (const value of ['1', 'yes']) {
      const refused = await start({ ...state.environment, HOLDR_LAUNCHD: '1', HOLDR_LAN_HTTP: value });
      assert.equal(refused.code, 1, refused.output);
      assert.match(refused.output, /E0I_LAN_REMOVED: HOLDR_LAN_HTTP is no longer supported: .*Tailscale Serve/);
    }
    // The LAN HTTPS gateway's settings are refused by the shared configuration reader, which names no value.
    const gateway = await start({ ...state.environment, HOLDR_LAUNCHD: '1', HOLDR_LAN_HTTPS_IP: '192.0.2.10' });
    assert.equal(gateway.code, 1, gateway.output);
    assert.match(gateway.output, /E0I_LAN_REMOVED \(HOLDR_LAN_HTTPS_IP is no longer supported/);
    assert.doesNotMatch(gateway.output, /192\.0\.2\.10/);
    assert.equal(await readFile(path.join(state.log, 'api.pid'), 'utf8').catch(() => null), null);
    const stop = await start({ ...state.environment, HOLDR_LAUNCHD: '1', HOLDR_LAN_HTTP: '1' }, ['--stop']);
    assert.equal(stop.code, 0, stop.output);
    assert.match(stop.output, /holdr-stop 2: nothing to stop/);
    // Its off value asks for what Holdr does anyway: Vite on loopback only.
    const off = await startRecorded(state, { HOLDR_LAN_HTTP: '0' });
    assert.equal(off.vite.bind, '127.0.0.1');
  } finally { await cleanup(state); }
});

// ---------------------------------------------------------------------------------------------- PR B: actions and the stop role

const darwin = { skip: process.platform !== 'darwin' };
/** The fixture tree's own stop role, pinned to the test Node runtime. */
const treeStopper = (state) => path.join(state.finance, 'scripts/holdr-stop.sh');
/**
 * A staged stopper outside the tree it stops (§11.4 step 15): `<home>/staged/FinanceTracker` with this repository's
 * holdr-stop.sh and a tsx that hands scripts/lib helpers to the real ones.
 */
async function stagedStopper(state) {
  const staged = path.join(state.home, 'staged', 'FinanceTracker');
  const stopper = await copyWithTestTools('holdr-stop.sh', path.join(staged, 'scripts', 'holdr-stop.sh'));
  await mkdir(path.join(staged, 'node_modules', '.bin'), { recursive: true });
  await writeFile(path.join(staged, 'node_modules', '.bin', 'tsx'), fakeService);
  await chmod(path.join(staged, 'node_modules', '.bin', 'tsx'), 0o755);
  return stopper;
}
const runStop = (stopScript, environment, args = []) => new Promise((resolve) => {
  const child = spawn('/bin/bash', [stopScript, ...args], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  child.once('close', (code) => resolve({ code, output }));
});
const pidOf = async (state, service) => Number(await readFile(path.join(state.log, `${service}.pid`), 'utf8').catch(() => '0'));

test('actions: unknown arguments exit 2 before the lock; --holdr-start-locked by hand is refused; --preflight and --stop reach the locked branch', { ...darwin, timeout: 120_000 }, async () => {
  const state = await fixture();
  try {
    for (const args of [['--restart'], ['--stop', '--preflight'], ['extra'], ['--preflight', 'x']]) {
      const result = await start({ ...state.environment, HOLDR_LAUNCHD: '1' }, args);
      assert.equal(result.code, 2, `${args}: ${result.output}`);
      assert.match(result.output, /Usage: start-finance-mac\.sh \[--preflight \| --stop\]/);
    }
    assert.equal(existsSync(state.log), false, 'nothing was created before the usage error');
    for (const args of [['--holdr-start-locked'], ['--holdr-start-locked', '--stop'], ['--holdr-start-locked', '--preflight']]) {
      const result = await start({ ...state.environment, HOLDR_LAUNCHD: '1' }, args);
      assert.equal(result.code, 2, `${args}: ${result.output}`);
      assert.match(result.output, /--holdr-start-locked is internal/);
    }
    const preflight = await start({ ...state.environment, HOLDR_LAUNCHD: '1' }, ['--preflight']);
    assert.equal(preflight.code, 0, preflight.output);
    assert.match(preflight.output, /^PREFLIGHT ok mode=vite/m);
    assert.equal(await pidOf(state, 'api'), 0, '--preflight starts nothing');
    const stop = await start({ ...state.environment, HOLDR_LAUNCHD: '1' }, ['--stop']);
    assert.equal(stop.code, 0, stop.output);
    assert.match(stop.output, /holdr-stop 2: nothing to stop/);
    const first = await start({ ...state.environment, HOLDR_LAUNCHD: '1' });
    assert.equal(first.code, 0, first.output);
    const pids = await Promise.all(['api', 'web', 'bridge'].map((service) => pidOf(state, service)));
    assert.ok(pids.every(alive), pids.join());
    // B2 review 1: with Vite on the web port and no Tailscale CLI at all, Serve could still target it: nothing is stopped.
    const unknown = await start({ ...state.environment, HOLDR_LAUNCHD: '1' }, ['--stop']);
    assert.equal(unknown.code, 1, unknown.output);
    assert.match(unknown.output, /E0I_SERVE_UNKNOWN \(no Tailscale CLI/);
    assert.ok(pids.every(alive), 'nothing stopped without a Serve read');
    const empty = await fakeTailscale(state, '{}\n');
    const stopped = await start({ ...state.environment, HOLDR_LAUNCHD: '1', HOLDR_TAILSCALE: empty.cli }, ['--stop']);
    assert.equal(stopped.code, 0, stopped.output);
    assert.match(stopped.output, /holdr-stop 2: stopped/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(pids.every((pid) => !alive(pid)), 'the stop role stopped API, Vite and bridge, and nothing restarted them');
    for (const port of state.ports) await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  } finally { await cleanup(state); }
});

test('holdr-stop: versioned, works in maintenance and with a broken release, never runs ingressMain or calls tailscale without a web listener', { ...darwin, timeout: 180_000 }, async () => {
  const state = await fixture();
  try {
    const version = await runStop(treeStopper(state), state.environment, ['--version']);
    assert.deepEqual([version.code, version.output], [0, 'holdr-stop 2\n']);
    assert.equal((await runStop(treeStopper(state), state.environment, ['--expect-version', '1'])).code, 2);
    assert.equal((await runStop(treeStopper(state), state.environment, ['--bogus'])).code, 2);
    const setup = await releaseSetup(state, { mode: 'dist' });
    const env = { ...state.environment, HOLDR_LAUNCHD: '1' };
    const started = await start(env);
    assert.equal(started.code, 0, started.output);
    const api = await pidOf(state, 'api');
    assert.ok(alive(api));
    // Maintenance, a malformed digest, a missing release and an unreadable control dir: the stop role reads none of them.
    await writeFile(path.join(setup.controlDir, 'lifecycle-state'), markerText('maintenance', 'deploy'), { mode: 0o600 });
    await writeConf(setup.confFile, { ...setup.values, HOLDR_WEB_RELEASE: 'not-a-digest' });
    await rm(path.join(state.finance, 'apps/web/releases'), { recursive: true, force: true });
    await chmod(setup.controlDir, 0o000);
    const callsBefore = (await setup.tailscale.calls()).length;
    const ingressBefore = (await records(`${setup.record}.ingress`)).length;
    const stopped = await start(env, ['--stop']);
    await chmod(setup.controlDir, 0o700);
    assert.equal(stopped.code, 0, stopped.output);
    assert.match(stopped.output, /holdr-stop 2: stopped/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(alive(api), false);
    assert.equal((await setup.tailscale.calls()).length, callsBefore, 'no tailscale call without a web-port listener');
    assert.equal((await records(`${setup.record}.ingress`)).length, ingressBefore, 'ingressMain never ran');
  } finally { await cleanup(state); }
});

test('holdr-stop refuses when a port belongs to a foreign process and stops nothing', { ...darwin, timeout: 120_000 }, async () => {
  const state = await fixture();
  const unrelated = createServer((_request, response) => response.end('unrelated'));
  try {
    const env = { ...state.environment, HOLDR_LAUNCHD: '1' };
    const first = await start(env);
    assert.equal(first.code, 0, first.output);
    const api = await pidOf(state, 'api');
    const port = await listen(unrelated);
    const result = await runStop(treeStopper(state), { ...env, HOLDR_BRIDGE_PORT: String(port) });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /belongs to a non-Holdr process/);
    assert.ok(alive(api), 'nothing was stopped');
  } finally {
    await new Promise((resolve) => unrelated.close(resolve));
    await cleanup(state);
  }
});

test('B1 round-3 finding 2: holdr-stop stops only the live deployment; a root that is a staging tree or a kit, also through a link, exits 2 and stops nothing', { ...darwin, timeout: 120_000 }, async () => {
  const state = await fixture();
  try {
    const [apiPort] = state.ports;
    const api = startFake(state, 'tsx', path.join(state.finance, 'apps/api'), ['src/index.ts'], { PORT: String(apiPort) });
    await waitForPort(apiPort);
    const stopper = await stagedStopper(state);
    const empty = await fakeTailscale(state, '{}\n');
    const env = { ...state.environment, HOLDR_TAILSCALE: empty.cli };
    // Beside the live tree: a staging tree's holdr.conf, a kit's kit-runtime.txt, a dangling link named holdr.conf.
    for (const [name, make] of [
      ['holdr.conf', (file) => writeFile(file, '')], ['kit-runtime.txt', (file) => writeFile(file, '')],
      ['holdr.conf', (file) => symlink(path.join(state.home, 'nowhere'), file)],
    ]) {
      const file = path.join(state.root, name);
      await make(file);
      for (const args of [['--root', state.root], []]) {
        const refused = await runStop(stopper, { ...env, HOLDR_ROOT: state.root }, args);
        assert.equal(refused.code, 2, `${name} ${args}: ${refused.output}`);
        assert.ok(refused.output.includes(`holdr-stop: ${state.root} holds ${name}: a staging tree or a rollback kit, not the live deployment; nothing stopped.`), refused.output);
      }
      assert.ok(alive(api.pid));
      await rm(file);
    }
    // A clean root whose FinanceTracker links into a staging tree: its physical parent holds holdr.conf.
    const stage = path.join(state.home, 'holdr-staging/C');
    await mkdir(path.join(stage, 'FinanceTracker'), { recursive: true });
    await writeFile(path.join(stage, 'holdr.conf'), '', { mode: 0o600 });
    const linked = path.join(state.home, 'linked-root');
    await mkdir(linked);
    await symlink(path.join(stage, 'FinanceTracker'), path.join(linked, 'FinanceTracker'));
    const viaLink = await runStop(stopper, env, ['--root', linked]);
    assert.equal(viaLink.code, 2, viaLink.output);
    assert.match(viaLink.output, /holdr-stop: .*holdr-staging\/C holds holdr\.conf: a staging tree or a rollback kit, not the live deployment; nothing stopped\./);
    assert.ok(alive(api.pid));
    // The live deployment itself is stopped as before.
    const stopped = await runStop(stopper, env, ['--root', state.root, '--expect-version', '2']);
    assert.equal(stopped.code, 0, stopped.output);
    assert.match(stopped.output, /holdr-stop 2: stopped api:/);
  } finally { await cleanup(state); }
});

test('the staged holdr-stop stops a login-era production tree by --root (first deployment, §11.4 step 15)', { ...darwin, timeout: 120_000 }, async () => {
  const state = await fixture();
  try {
    const [apiPort, webPort, bridgePort] = state.ports;
    // Today's production layout, started by the old launcher: Vite on the web port, the API, the bridge, PID files.
    const api = startFake(state, 'tsx', path.join(state.finance, 'apps/api'), ['src/index.ts'], { PORT: String(apiPort) });
    const web = startFake(state, 'vite', path.join(state.finance, 'apps/web'), ['--host', '127.0.0.1', '--port', String(webPort), '--strictPort']);
    const bridge = startFake(state, 'python', path.join(state.runtime, 'portfolio-bridge'), ['server.py'], { PORTFOLIO_BRIDGE_PORT: String(bridgePort) });
    await mkdir(state.log, { recursive: true });
    for (const [service, child] of [['api', api], ['web', web], ['bridge', bridge]]) await writeFile(path.join(state.log, `${service}.pid`), `${child.pid}\n`);
    for (const port of state.ports) await waitForPort(port);
    const stopper = await stagedStopper(state);
    // Without any Tailscale CLI the stopper cannot show that Serve does not target Vite: it stops nothing (B2 review 1).
    const unknown = await runStop(stopper, state.environment, ['--root', state.root, '--expect-version', '2']);
    assert.equal(unknown.code, 1, unknown.output);
    assert.match(unknown.output, /E0I_SERVE_UNKNOWN/);
    assert.ok([api, web, bridge].every((child) => alive(child.pid)));
    // The host's recorded state before E0-I: Serve empty ({}), so the web port is not targeted.
    const empty = await fakeTailscale(state, '{}\n');
    const result = await runStop(stopper, { ...state.environment, HOLDR_TAILSCALE: empty.cli }, ['--root', state.root, '--expect-version', '2']);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /holdr-stop 2: stopped/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const child of [api, web, bridge]) assert.equal(alive(child.pid), false);
  } finally { await cleanup(state); }
});
