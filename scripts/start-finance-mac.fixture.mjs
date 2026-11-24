// Shared fixture for the start-script tests (design §8.7): a fake Holdr tree whose `tsx`, `vite` and bridge `python` are fake
// services, the real start script and stop/publish helpers, the real holdr.conf reader and Serve validator (the fake `tsx`
// hands `scripts/lib/*.ts` to the real tsx), and fake Tailscale CLIs. Test-only; never used by production code.
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, copyFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

export const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const script = path.join(repo, 'scripts/start-finance-mac.sh');
const realLoader = path.join(repo, 'node_modules/tsx/dist/loader.mjs');

/**
 * Test copies pin Node to the current test runtime and may replace lockf.
 */
export function withTestTools(text, { node, lockf } = {}) {
  const lines = text.split('\n');
  const swap = (pattern, from, to) => {
    const at = lines.flatMap((line, index) => (pattern.test(line) ? [index] : []));
    if (at.length !== 1 || to.includes("'")) throw new Error(`expected exactly one ${pattern} line`);
    lines[at[0]] = lines[at[0]].replace(from, `'${to}'`);
  };
  if (node) {
    const nodeLines = lines.flatMap((line, index) => (line === 'NODE="${HOLDR_NODE:-$(command -v node || true)}"' ? [index] : []));
    if (nodeLines.length !== 1 || node.includes("'")) throw new Error('expected exactly one configurable Node line');
    lines[nodeLines[0]] = `NODE='${node}'`;
  }
  if (lockf) swap(/^LOCKF=\/usr\/bin\/lockf$/, '/usr/bin/lockf', lockf);
  return lines.join('\n');
}

/** Copies a repository script to `to` with the test's tool paths (`withTestTools`), executable. */
export async function copyWithTestTools(name, to, tools = {}) {
  await mkdir(path.dirname(to), { recursive: true });
  await writeFile(to, withTestTools(await readFile(path.join(repo, 'scripts', name), 'utf8'), tools));
  await chmod(to, 0o755);
  return to;
}

/**
 * One executable for all three services (`service` = its file name), and the dispatcher of the fake `tsx`:
 * - `tsx <tree>/scripts/lib/<x>.ts …`: runs the real repository's helper with the real tsx loader;
 * - `tsx <tree>/apps/api/src/cli/ingressMain.ts preflight|serve-probe`: emulated from `<tree>/test-control.json` (the
 *   start script runs them with `env -i`, so test instructions travel in that file, not in the environment);
 * - otherwise the fake API (`tsx src/index.ts`), Vite or bridge: listens, records what it saw, answers health checks.
 */
export const fakeService = `#!${process.execPath}
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const service = path.basename(process.argv[1]);
const tree = path.resolve(path.dirname(process.argv[1]), '../..');
const control = (() => { try { return JSON.parse(fs.readFileSync(path.join(tree, 'test-control.json'), 'utf8')); } catch { return {}; } })();
const note = (name, value) => { if (control.record) fs.appendFileSync(control.record + '.' + name, JSON.stringify({ at: Date.now(), ...value }) + '\\n'); };
const args = process.argv.slice(2);
const real = (file, rest, options = {}) => spawnSync(process.execPath, ['--import', ${JSON.stringify(realLoader)}, file, ...rest],
  { stdio: 'inherit', env: process.env, ...options });
if (service === 'tsx' && args[0] && args[0].includes('/scripts/lib/') && args[0].endsWith('.ts')) {
  process.exit(real(path.join(${JSON.stringify(repo)}, 'scripts/lib', path.basename(args[0])), args.slice(1)).status ?? 1);
}
if (service === 'tsx' && args[0] && args[0].endsWith('/ingressMain.ts')) {
  const action = args[1];
  note('ingress', { action, args: args.slice(2), mode: process.env.HOLDR_WEB_MODE ?? null, script: args[0], cwd: process.cwd(),
    root: process.env.HOLDR_ROOT ?? null, config: process.env.HOLDR_CONFIG ?? null, releaseDir: process.env.HOLDR_WEB_RELEASE_DIR ?? null });
  if (action === 'preflight') {
    if (control.preflight === 'refuse') { console.error('PREFLIGHT refused E0I_TEST_REFUSAL'); process.exit(1); }
    const mode = process.env.HOLDR_WEB_MODE ?? 'vite';
    let verdict = 'not-checked';
    if (mode === 'dist') {
      const webPort = args[2] === '--web-port' ? args[3] : '8888';
      const out = real(path.join(${JSON.stringify(repo)}, 'scripts/lib/serve-verdict.ts'), ['--cli', process.env.HOLDR_TAILSCALE_CLI,
        '--host', new URL(process.env.HOLDR_PUBLIC_ORIGIN).hostname, '--socket', process.env.HOLDR_SERVE_SOCKET, '--api-port', process.env.PORT,
        '--web-port', webPort],
        { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
      verdict = String(out.stdout || 'error').split(' ')[0];
      if (!['empty', 'approved-vite', 'approved-dist', 'error'].includes(verdict)) {
        console.error('PREFLIGHT refused E0I_SERVE (Serve verdict ' + verdict + ')');
        process.exit(1);
      }
    }
    console.log('PREFLIGHT ok mode=' + mode + ' serve=' + verdict + ' gate="blocked (init)"');
    process.exit(0);
  }
  if (action === 'serve-probe') process.exit(control.probe === 'fail' ? 1 : 0);
  process.exit(2);
}
if (process.env.HOLDR_TEST_RECORD) {
  fs.writeFileSync(process.env.HOLDR_TEST_RECORD + '.' + service + '.json', JSON.stringify({
    addresses: process.env.HOLDR_TAILNET_ADDRESSES ?? null,
    hostname: process.env.HOLDR_TAILNET_HOSTNAME ?? null,
    origins: process.env.WEB_ORIGIN ?? null,
    publicOrigin: process.env.HOLDR_PUBLIC_ORIGIN ?? null,
    apiHost: process.env.HOLDR_HOST ?? null,
    apiTarget: process.env.HOLDR_API_TARGET ?? null,
    bind: process.argv.includes('--host') ? process.argv[process.argv.indexOf('--host') + 1] : null,
  }));
}
if (service === 'tsx') note('api', { env: process.env });
const port = service === 'tsx' ? process.env.PORT
  : service === 'vite' ? process.argv[process.argv.indexOf('--port') + 1]
  : process.env.PORTFOLIO_BRIDGE_PORT;
const failing = service === 'tsx' && (process.env.HOLDR_TEST_FAIL_API === '1' || control.failApi);
const handler = (request, response) => {
  response.statusCode = failing ? 500 : 200;
  if (service === 'vite' && request.url === '/') response.end('<!doctype html><script type="module" src="/@vite/client"></script>');
  else response.end('ok');
};
http.createServer(handler).listen(Number(port), '127.0.0.1');
if (service === 'tsx' && process.env.HOLDR_WEB_MODE === 'local') http.createServer(handler).listen(Number(process.env.HOLDR_INGRESS_PORT), '127.0.0.1');
const socket = service === 'tsx' ? process.env.HOLDR_SERVE_SOCKET : undefined;
if (socket) {
  http.createServer(handler).listen(socket, () => {
    const verified = (control.attest ?? 'verified') === 'verified';
    fs.writeFileSync(path.join(path.dirname(socket), 'ingress-state.json'), JSON.stringify(verified
      ? { format: 'holdr-ingress-state/1', name: 'verified', codes: [], ageMs: 0, verified: true }
      : { format: 'holdr-ingress-state/1', name: 'unverified', codes: ['tailscale-not-running'], ageMs: null, verified: false }), { mode: 0o600 });
  });
}
process.on('SIGTERM', () => {
  note('exit', { service });
  if (socket) { try { fs.unlinkSync(socket); } catch {} }
  process.exit(0);
});
`;

/** `lockf -t 0 -k <file> <command…>` for test Macs without /usr/bin/lockf (macOS 12): the same flock(2) lock family. */
const lockfStandIn = `#!/usr/bin/perl
use strict; use warnings; use Fcntl qw(:flock O_CREAT O_RDWR);
my $wait;
while (@ARGV && $ARGV[0] =~ /^-/) { my $o = shift @ARGV; if ($o eq '-k') { } elsif ($o eq '-t') { $wait = shift @ARGV } else { exit 64 } }
my $file = shift @ARGV;
exit 64 unless defined $file && @ARGV && defined $wait && $wait eq '0';
sysopen(my $fh, $file, O_RDWR | O_CREAT, 0600) or exit 73;
flock($fh, LOCK_EX | LOCK_NB) or do { print STDERR "lockf: $file: already locked\\n"; exit 75 };
my $pid = fork();
exit 71 unless defined $pid;
if ($pid == 0) { close($fh); exec { $ARGV[0] } @ARGV; exit 127 }
waitpid($pid, 0);
my $status = $?;
exit($status & 127 ? 128 + ($status & 127) : $status >> 8);
`;

/** Writes the `lockf` stand-in to `file` (executable): for tests that run a copy of the start script outside `fixture()`. */
export async function writeLockf(file) {
  await writeFile(file, lockfStandIn);
  await chmod(file, 0o755);
  return file;
}

export async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

export async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), 'holdr-start-test-'));
  const root = path.join(home, 'Holdr');
  const finance = path.join(root, 'FinanceTracker');
  const runtime = path.join(home, 'Library', 'Application Support', 'Holdr');
  const log = path.join(home, 'holdr-logs');
  for (const directory of [path.join(finance, 'apps', 'api'), path.join(finance, 'apps', 'web'), path.join(runtime, 'portfolio-bridge'),
    path.join(finance, 'scripts', 'lib')]) {
    await mkdir(directory, { recursive: true });
  }
  for (const executable of [path.join(finance, 'node_modules', '.bin', 'tsx'), path.join(finance, 'node_modules', '.bin', 'vite'), path.join(runtime, '.venv313', 'bin', 'python')]) {
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, fakeService);
    await chmod(executable, 0o755);
  }
  await writeFile(path.join(runtime, 'portfolio-bridge', 'server.py'), '');
  const lockf = await writeLockf(path.join(home, 'lockf'));
  // The tree's own stop role and publisher (the start script runs $FT/scripts/…; they run their helpers from their own tree),
  // and the start script as deployed to ~/bin, all with this test's Node and lockf (B-D32).
  for (const name of ['holdr-stop.sh', 'holdr-publish-legacy.sh']) await copyWithTestTools(name, path.join(finance, 'scripts', name));
  for (const name of ['bounded-cli.mjs', 'serve-verdict.ts']) await copyFile(path.join(repo, 'scripts/lib', name), path.join(finance, 'scripts/lib', name));
  await copyWithTestTools('start-finance-mac.sh', path.join(home, 'bin', 'start-finance-mac.sh'), { lockf });
  const reservations = [createServer(), createServer(), createServer()];
  const ports = await Promise.all(reservations.map(listen));
  await Promise.all(reservations.map((server) => new Promise((resolve) => server.close(resolve))));
  const environment = {
    ...process.env, HOME: home, HOLDR_NODE: process.execPath, HOLDR_ROOT: root, HOLDR_BRIDGE_RUNTIME: runtime, HOLDR_LOG_DIR: log,
    HOLDR_API_PORT: String(ports[0]), HOLDR_WEB_PORT: String(ports[1]), HOLDR_BRIDGE_PORT: String(ports[2]),
    // Keep tests off the host's own Tailscale and its startup wait.
    HOLDR_TAILSCALE: path.join(home, 'no-tailscale'),
  };
  for (const name of Object.keys(environment)) {
    if (/^HOLDR_(CONFIG|WEB_MODE|LIFECYCLE_|CONTROL_DIR|DATA_DIR|PUBLIC_ORIGIN|SERVE_SOCKET|TAILSCALE_CLI|WEB_RELEASE|LAN_HTTP|LOCKF)/.test(name)) delete environment[name];
  }
  const shorts = [];
  return { home, root, finance, runtime, log, lockf, ports, environment, shorts };
}

/** Runs the start script as deployed (`~/bin/start-finance-mac.sh` of the fixture's HOME) through its real outer wrapper. */
export function start(environment, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [path.join(environment.HOME, 'bin', 'start-finance-mac.sh'), ...args], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 110_000);
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output });
    });
  });
}

export async function cleanup(state) {
  for (const service of ['api', 'web', 'bridge']) {
    const value = await readFile(path.join(state.log, `${service}.pid`), 'utf8').catch(() => '');
    if (/^[1-9][0-9]*\s*$/.test(value)) {
      try { process.kill(Number(value), 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  for (const pid of state.extraPids ?? []) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  await new Promise((resolve) => setTimeout(resolve, 200));
  for (const dir of state.shorts) await rm(dir, { recursive: true, force: true });
  await rm(state.home, { recursive: true, force: true });
}

/** A short private directory for the serve socket (≤ 100 bytes), under the repository like A2's fixtures. */
export async function shortDir(state) {
  const dir = path.join(repo, `.i-${randomBytes(4).toString('hex')}`);
  await mkdir(dir, { mode: 0o700 });
  await chmod(dir, 0o700);
  state.shorts.push(dir);
  return dir;
}

export const magicDns = 'holdr.example.ts.net';
export const ORIGIN = `https://${magicDns}`;
export const DIGEST = 'ab'.repeat(32);
const canonical = (target) => JSON.stringify({
  TCP: { 443: { HTTPS: true } }, Web: { [`${magicDns}:443`]: { Handlers: { '/': { Proxy: target } } } },
}, null, 2) + '\n';
export const serveShape = canonical;

/**
 * A Node fake of the Tailscale CLI that stores Serve's configuration the way 1.98's `serve status --json` prints it (Go
 * MarshalIndent, A2's canonical bytes). Calls are logged as JSON lines with a timestamp; behaviour comes from `<cli>.mode.json`.
 */
export async function fakeTailscale(state, initial = '{}\n', mode = {}) {
  const cli = path.join(state.home, 'fake-ts');
  await writeFile(cli, `#!${process.execPath}
const fs = require('node:fs');
const cli = process.argv[1];
const args = process.argv.slice(2);
const mode = (() => { try { return JSON.parse(fs.readFileSync(cli + '.mode.json', 'utf8')); } catch { return {}; } })();
fs.appendFileSync(cli + '.calls', JSON.stringify({ at: Date.now(), args }) + '\\n');
const host = ${JSON.stringify(magicDns)};
// A CLI that never answers one kind of Serve change (B2 review 4): it records its PID and waits until killed.
if (mode.hang && args[0] === 'serve' && args.includes(mode.hang)) {
  fs.writeFileSync(cli + '.hung', String(process.pid));
  for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
}
if (args[0] === 'version') { process.stdout.write('1.98.3\\n  tailscale commit: synthetic\\n'); process.exit(0); }
if (args[0] === 'ip') { if (mode.ipFails) process.exit(1); process.stdout.write('100.101.102.103\\nfd7a:115c:a1e0::1234\\n'); process.exit(0); }
if (args[0] === 'status') { process.stdout.write(JSON.stringify({ BackendState: 'Running', Self: { DNSName: (mode.dnsName ?? host) + '.' }, CertDomains: [host] }) + '\\n'); process.exit(0); }
if (args[0] === 'serve' && args[1] === 'status') {
  if (mode.statusFails) { process.stderr.write('failed to connect to local tailscaled\\n'); process.exit(1); }
  try { process.stdout.write(fs.readFileSync(cli + '.serve.json', 'utf8')); } catch { process.stdout.write('{}\\n'); }
  process.exit(0);
}
if (args[0] === 'serve' && args.includes('off')) { fs.writeFileSync(cli + '.serve.json', '{}\\n'); process.exit(0); }
if (args[0] === 'serve' && args[1] === '--bg') {
  if (mode.switchFails) { process.stderr.write('Access denied\\n'); process.exit(1); }
  const target = args[args.length - 1];
  fs.writeFileSync(cli + '.serve.json', JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { [host + ':443']: { Handlers: { '/': { Proxy: target } } } } }, null, 2) + '\\n');
  process.exit(0);
}
process.exit(2);
`);
  await chmod(cli, 0o755);
  await writeFile(`${cli}.serve.json`, initial);
  await writeFile(`${cli}.mode.json`, JSON.stringify(mode));
  return {
    cli,
    setMode: (next) => writeFile(`${cli}.mode.json`, JSON.stringify(next)),
    serveJson: () => readFile(`${cli}.serve.json`, 'utf8'),
    calls: async () => (await readFile(`${cli}.calls`, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line)),
  };
}

export const markerText = (state = 'normal', reason = null) => JSON.stringify({
  format: 'holdr-lifecycle/2', state, reason, lease: null, owner: 'holdr-recovery init', since: '2026-10-17T13:00:00.000Z',
}) + '\n';

/**
 * A `dist` (or `local`) configuration: holdr.conf (0600) at its default path, a control dir with the marker, the data dir, the
 * release dir the script derives from the digest, a short socket dir, the fake CLI, and the test-control file of the fake tree.
 */
export async function releaseSetup(state, { mode = 'dist', serve = '{}\n', cliMode = {}, conf = {}, control = {} } = {}) {
  const controlDir = path.join(state.runtime, 'control');
  await mkdir(controlDir, { recursive: true, mode: 0o700 });
  await chmod(controlDir, 0o700);
  await writeFile(path.join(controlDir, 'lifecycle-state'), markerText(), { mode: 0o600 });
  const dataDir = path.join(state.home, 'data');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(path.join(state.finance, 'apps', 'web', 'releases', DIGEST.slice(0, 12)), { recursive: true });
  const socketDir = await shortDir(state);
  const socket = path.join(socketDir, 's');
  const tailscale = await fakeTailscale(state, serve, cliMode);
  const values = {
    HOLDR_WEB_MODE: mode, HOLDR_WEB_RELEASE: DIGEST, HOLDR_DATA_DIR: dataDir, HOLDR_CONTROL_DIR: controlDir,
    HOLDR_TAILSCALE_CLI: tailscale.cli, HOLDR_DEVICE_API: '0', HOLDR_LEGACY_VITE_ROLLBACK: '1',
    ...(mode === 'dist' ? { HOLDR_PUBLIC_ORIGIN: ORIGIN, HOLDR_SERVE_SOCKET: socket } : {}),
    ...(mode === 'local' ? { HOLDR_INGRESS_PORT: state.environment.HOLDR_WEB_PORT } : {}),
    ...conf,
  };
  const confFile = path.join(state.runtime, 'holdr.conf');
  await writeConf(confFile, values);
  const record = path.join(state.home, 'record');
  await writeFile(path.join(state.finance, 'test-control.json'), JSON.stringify({ record, ...control }));
  return { controlDir, dataDir, socket, socketDir, tailscale, confFile, values, record };
}

export async function writeConf(file, values, fileMode = 0o600) {
  await rm(file, { force: true });
  const text = Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}\n`).join('');
  await writeFile(file, `# test holdr.conf\n${text}`, { mode: fileMode });
  await chmod(file, fileMode);
}

export async function records(file) {
  return (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** Starts the login-era services by hand, as a running production stack would have them (cwd and command lines matter). */
export function startFake(state, service, cwd, args, env = {}) {
  const executable = service === 'python' ? path.join(state.runtime, '.venv313', 'bin', 'python')
    : path.join(state.finance, 'node_modules', '.bin', service);
  const child = spawn(executable, args, { cwd, env: { ...process.env, ...env }, stdio: 'ignore', detached: true });
  child.unref();
  state.extraPids = [...(state.extraPids ?? []), child.pid];
  return child;
}

export async function waitForPort(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).status) return; } catch { /* not yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`port ${port} never answered`);
}

export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
