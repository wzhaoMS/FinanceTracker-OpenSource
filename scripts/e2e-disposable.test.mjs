import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// P-NET: refuses any listener beyond 127.0.0.1 or ::1 in this process.
import './loopback-only.mjs';
import {
  AUTH_STATE_FILE,
  CREDENTIAL_FILES,
  E2E_USER,
  GROUP_LEADER,
  REPO,
  SERVICE_TOKEN_FILE,
  SIGNAL_STATUS,
  apiEnv,
  childEnv,
  cleanupPlan,
  defaultWorkDir,
  isSignallablePid,
  parseArgs,
  parseKeyValues,
  playwrightEnv,
  readServiceToken,
  removeCredentials,
  serviceTokenHeaders,
  startGroup,
  system32,
  taskkillArgs,
  usage,
  validatePort,
  viteEnv,
  withDefaultWorkers,
} from './e2e-disposable.mjs';

const runner = fileURLToPath(new URL('./e2e-disposable.mjs', import.meta.url));
const wrapper = fileURLToPath(new URL('./e2e-disposable.sh', import.meta.url));

test('options come from flags, both spellings, over the environment', () => {
  const env = { HOLDR_E2E_API_PORT: '4100', HOLDR_E2E_WEB_PORT: '5300', HOLDR_E2E_WORK_DIR: '/env/work' };
  assert.deepEqual(parseArgs([], env), {
    apiPort: '4100', webPort: '5300', workDir: '/env/work', keep: false, help: false, playwrightArgs: [],
  });
  assert.deepEqual(parseArgs(['--api-port', '4106', '--web-port=5306', '--work-dir', '/w', '--keep'], env), {
    apiPort: '4106', webPort: '5306', workDir: '/w', keep: true, help: false, playwrightArgs: [],
  });
  assert.deepEqual(parseArgs([], { HOLDR_E2E_API_PORT: '' }).apiPort, '');
});

test('everything after --, and anything unknown, goes to Playwright', () => {
  assert.deepEqual(
    parseArgs(['tests/smoke.e2e.ts', '--keep=1', '--', '-g', 'Symbol chart', '--keep', '--api-port', '1']).playwrightArgs,
    ['tests/smoke.e2e.ts', '--keep=1', '-g', 'Symbol chart', '--keep', '--api-port', '1'],
  );
  assert.equal(parseArgs(['--', '--help']).help, false);
  assert.equal(parseArgs(['-h', '--api-port']).help, true);
});

test('a flag without a value is refused', () => {
  assert.throws(() => parseArgs(['--api-port']), /--api-port needs a value/);
  assert.throws(() => parseArgs(['--work-dir=']), /--work-dir needs a value/);
  assert.throws(() => parseArgs(['--web-port', '']), /--web-port needs a value/);
});

test('ports are 1-65535, digits only', () => {
  assert.equal(validatePort('4106'), 4106);
  assert.equal(validatePort('065535'), 65535);
  for (const bad of ['', 'abc', '-1', '1.5', '41 06', '0x10']) assert.throws(() => validatePort(bad), /invalid port: '/);
  for (const bad of ['0', '65536']) assert.throws(() => validatePort(bad), /invalid port: \d/);
});

test('one worker unless the arguments choose', () => {
  assert.deepEqual(withDefaultWorkers(['tests/smoke.e2e.ts']), ['--workers=1', 'tests/smoke.e2e.ts']);
  for (const choice of ['--workers=4', '--workers', '-j2', '-j']) {
    assert.deepEqual(withDefaultWorkers(['x', choice]), ['x', choice]);
  }
});

test("Vite's environment points the browser at Vite's own origin", () => {
  const env = viteEnv({ PATH: '/bin', VITE_API_BASE: 'https://prod.example', VITE_OTHER: '1', vite_lower: '1', HOLDR_API_TARGET: 'http://prod:4000' }, 4106, 'darwin');
  assert.deepEqual(env, { PATH: '/bin', VITE_API_BASE: '', HOLDR_API_TARGET: 'http://127.0.0.1:4106' });
});

test('on Windows, every spelling of an overridden variable is replaced', () => {
  const base = { Path: 'C:\\Windows', Holdr_Api_Target: 'http://prod:4000', Vite_Api_Base: 'https://prod.example', holdr_data_dir: 'C:\\live' };
  assert.deepEqual(viteEnv(base, 4106, 'win32'), {
    Path: 'C:\\Windows', holdr_data_dir: 'C:\\live', VITE_API_BASE: '', HOLDR_API_TARGET: 'http://127.0.0.1:4106',
  });
  assert.deepEqual(childEnv(base, { HOLDR_DATA_DIR: 'D:\\run\\data' }, { platform: 'win32' }), {
    Path: 'C:\\Windows', Holdr_Api_Target: 'http://prod:4000', Vite_Api_Base: 'https://prod.example', HOLDR_DATA_DIR: 'D:\\run\\data',
  });
  // POSIX names are case-sensitive: another spelling is another variable.
  assert.equal(childEnv(base, { HOLDR_DATA_DIR: '/run/data' }, { platform: 'linux' }).holdr_data_dir, 'C:\\live');
});

test('the default work directory is in the repo, or under the per-user temp folder on Windows', () => {
  assert.equal(defaultWorkDir({ platform: 'darwin', repo: '/r' }), path.join('/r', '.e2e-tmp'));
  const seen = [];
  const windows = defaultWorkDir({
    platform: 'win32',
    tmpdir: () => 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp',
    realpath: (p) => { seen.push(p); return 'C:\\Users\\runneradmin\\AppData\\Local\\Temp'; },
  });
  assert.equal(windows, 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\holdr-e2e');
  assert.deepEqual(seen, ['C:\\Users\\RUNNER~1\\AppData\\Local\\Temp']);
});

test("the run-directory helper's output is read line by line", () => {
  assert.deepEqual(parseKeyValues('RUN_DIR=C:\\a=b\\run\r\nDATA_DIR=/x/data\nnoise\n=x\n'), { RUN_DIR: 'C:\\a=b\\run', DATA_DIR: '/x/data' });
});

test('cleanup keeps, leaves or removes as the bash runner did, and removes interrupted runs', () => {
  const plan = (overrides) => cleanupPlan({ keep: false, seeded: true, status: 0, interrupted: false, ...overrides });
  assert.equal(plan({ keep: true, status: 1 }), 'keep');
  assert.equal(plan({ seeded: false, status: 130, interrupted: true }), 'leave');
  assert.equal(plan({}), 'remove-run');
  assert.equal(plan({ status: 130, interrupted: true }), 'remove-run');
  assert.equal(plan({ status: 1 }), 'remove-data');
  assert.deepEqual(SIGNAL_STATUS, { SIGINT: 130, SIGTERM: 143, SIGHUP: 129, SIGBREAK: 149 });
});

const RUN_ID = 'ab'.repeat(16);

test('the API keeps its service token in the run directory, outside data/, and never sees the e2e password', () => {
  const env = apiEnv({ PATH: '/bin', HOLDR_SERVICE_TOKEN_FILE: '/srv/holdr/service-token' }, {
    runDir: '/w/run-1', dataDir: '/w/run-1/data', apiPort: 4106, webPort: 5306, runId: RUN_ID,
  }, 'darwin');
  assert.equal(env.HOLDR_SERVICE_TOKEN_FILE, '/w/run-1/service-token');
  assert.ok(path.posix.relative(env.HOLDR_DATA_DIR, env.HOLDR_SERVICE_TOKEN_FILE).startsWith('..'));
  assert.equal(env.HOLDR_E2E_RUN_ID, RUN_ID);
  assert.equal(env.HOLDR_HOST, '127.0.0.1');
  assert.equal(env.PATH, '/bin');
  // Never the production holdr.conf or lifecycle protocol (PR B, design §7.1).
  assert.equal(env.HOLDR_CONFIG, 'none');
  const inherited = apiEnv({ PATH: '/bin', HOLDR_CONTROL_DIR: '/srv/control', HOLDR_LIFECYCLE_LEASE_FD: '3', HOLDR_CONFIG: '/srv/holdr.conf' }, {
    runDir: '/w/run-1', dataDir: '/w/run-1/data', apiPort: 4106, webPort: 5306, runId: RUN_ID,
  }, 'darwin');
  assert.equal(inherited.HOLDR_CONFIG, 'none');
  assert.equal(inherited.HOLDR_CONTROL_DIR, undefined);
  assert.equal(inherited.HOLDR_LIFECYCLE_LEASE_FD, undefined);
  assert.ok(!Object.keys(env).some((name) => /PASSWORD/i.test(name)));
  // Windows: Windows paths, and no other spelling of the variable survives.
  const windows = apiEnv({ Path: 'C:\\Windows', holdr_service_token_file: 'C:\\live\\service-token' }, {
    runDir: 'C:\\t\\run-1', dataDir: 'C:\\t\\run-1\\data', apiPort: 4106, webPort: 5306, runId: RUN_ID,
  }, 'win32');
  assert.equal(windows.HOLDR_SERVICE_TOKEN_FILE, 'C:\\t\\run-1\\service-token');
  assert.equal(windows.holdr_service_token_file, undefined);
});

test('Playwright gets the e2e credentials and saves its session in the run directory, never the service token', () => {
  const env = playwrightEnv({ PATH: '/bin', HOLDR_E2E_PASSWORD: 'from the shell' }, {
    runDir: '/w/run-1', webPort: 5306, runId: RUN_ID, password: 'p4ss-w0rd',
  }, 'darwin');
  assert.deepEqual(Object.fromEntries(Object.entries(env).filter(([name]) => name !== 'PATH')), {
    HOLDR_E2E_WRITES: '1',
    WEB_URL: 'http://127.0.0.1:5306',
    HOLDR_E2E_RUN_ID: RUN_ID,
    HOLDR_E2E_USER: E2E_USER,
    HOLDR_E2E_PASSWORD: 'p4ss-w0rd',
    HOLDR_E2E_AUTH_STATE: '/w/run-1/auth-state.json',
  });
  assert.ok(!Object.keys(env).some((name) => /TOKEN/i.test(name)));
  const windows = playwrightEnv({}, { runDir: 'C:\\t\\run-1', webPort: 5306, runId: RUN_ID, password: 'p' }, 'win32');
  assert.equal(windows.HOLDR_E2E_AUTH_STATE, 'C:\\t\\run-1\\auth-state.json');
});

test('the service token is read only from a regular file holding 64 lowercase hex characters, and sent as a header', () => {
  const token = 'ab'.repeat(32);
  const file = '/w/run-1/service-token';
  const fakeFs = (entry) => ({
    lstatSync: () => {
      if (!entry) throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      return { isFile: () => entry.kind === 'file' };
    },
    readFileSync: () => entry.text,
  });
  assert.equal(readServiceToken(file, fakeFs({ kind: 'file', text: `${token}\n` })), token);
  assert.equal(readServiceToken(file, fakeFs({ kind: 'file', text: `${token}\r\n` })), token);
  for (const text of ['', '\n', token.slice(1), `${token}0`, token.toUpperCase(), `${token.slice(2)}zz`, `Bearer ${token}`, `${token}\n${token}`]) {
    assert.equal(readServiceToken(file, fakeFs({ kind: 'file', text })), null, JSON.stringify(text));
  }
  assert.equal(readServiceToken(file, fakeFs({ kind: 'link', text: token })), null);
  assert.equal(readServiceToken(file, fakeFs(null)), null);
  assert.deepEqual(serviceTokenHeaders(token), { Authorization: `Bearer ${token}` });
});

test('the service token and the saved sign-in are deleted, never recursively and never through a link', () => {
  const calls = [];
  const fakeFs = ({ runDir = 'dir', fail = {} } = {}) => ({
    lstatSync: () => {
      if (runDir === 'missing') throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      return { isSymbolicLink: () => runDir === 'link', isDirectory: () => runDir === 'dir' || runDir === 'link' };
    },
    rmSync: (file, options) => {
      calls.push([file, options]);
      const failure = fail[file.split(/[\\/]/).pop()];
      if (failure) throw new Error(failure);
    },
  });
  assert.deepEqual(CREDENTIAL_FILES, [SERVICE_TOKEN_FILE, AUTH_STATE_FILE]);
  assert.deepEqual(removeCredentials('/w/run-1', fakeFs(), 'darwin'), []);
  assert.deepEqual(calls, [
    ['/w/run-1/service-token', { force: true, maxRetries: 0, retryDelay: 200 }],
    ['/w/run-1/auth-state.json', { force: true, maxRetries: 0, retryDelay: 200 }],
  ]);
  // Windows: its paths, and retries while a just-stopped process lets go of a file.
  calls.length = 0;
  assert.deepEqual(removeCredentials('C:\\t\\run-1', fakeFs(), 'win32'), []);
  assert.deepEqual(calls.map(([file, options]) => [file, options.maxRetries]), [['C:\\t\\run-1\\service-token', 10], ['C:\\t\\run-1\\auth-state.json', 10]]);
  // Nothing through a run directory that became a link or something else; a missing one holds nothing.
  calls.length = 0;
  assert.match(removeCredentials('/w/run-1', fakeFs({ runDir: 'link' }), 'darwin')[0], /no longer a plain directory/);
  assert.match(removeCredentials('/w/run-1', fakeFs({ runDir: 'file' }), 'darwin')[0], /no longer a plain directory/);
  assert.deepEqual(removeCredentials('/w/run-1', fakeFs({ runDir: 'missing' }), 'darwin'), []);
  assert.deepEqual(calls, []);
  // Every file is tried, and what could not be deleted is reported.
  assert.deepEqual(removeCredentials('/w/run-1', fakeFs({ fail: { 'service-token': 'EBUSY: resource busy' } }), 'darwin'),
    ['could not delete /w/run-1/service-token: EBUSY: resource busy']);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([, options]) => !('recursive' in options)));
});

test('for real: a link in place of the saved sign-in is removed, and what it points at stays', (t) => {
  // In the repo's gitignored .e2e-tmp, like a run directory.
  const parent = path.join(REPO, '.e2e-tmp');
  fs.mkdirSync(parent, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(parent, 'credentials-test-'));
  t.after(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
    try {
      fs.rmdirSync(parent);
    } catch {
      // Other runs' directories stay.
    }
  });
  const runDir = path.join(scratch, 'run');
  const elsewhere = path.join(scratch, 'elsewhere');
  fs.mkdirSync(runDir);
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, 'keep.txt'), 'not a credential');
  fs.writeFileSync(path.join(runDir, SERVICE_TOKEN_FILE), `${'cd'.repeat(32)}\n`);
  // A junction on Windows, which any user may create there; a symlink elsewhere.
  fs.symlinkSync(elsewhere, path.join(runDir, AUTH_STATE_FILE), process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(runDir, 'api.pid'), '4242\n');
  assert.deepEqual(removeCredentials(runDir), []);
  assert.deepEqual(fs.readdirSync(runDir), ['api.pid']);
  assert.deepEqual(fs.readdirSync(elsewhere), ['keep.txt']);
  assert.equal(fs.readFileSync(path.join(elsewhere, 'keep.txt'), 'utf8'), 'not a credential');
  assert.deepEqual(removeCredentials(runDir), []);
});

test('only real child PIDs are ever signalled', () => {
  for (const pid of [0, 1, -1, -4242, 1.5, Number.NaN, undefined, '4242']) {
    assert.equal(isSignallablePid(pid), false, String(pid));
    assert.throws(() => taskkillArgs(pid), /refusing to taskkill/);
  }
  assert.deepEqual(taskkillArgs(4242), ['/T', '/F', '/PID', '4242']);
  assert.equal(system32('taskkill.exe', { SystemRoot: 'D:\\WINDOWS' }), 'D:\\WINDOWS\\System32\\taskkill.exe');
});

test('--help prints the header; bad options stop before anything starts', () => {
  assert.match(usage(), /^Run the Playwright suite against a throwaway Holdr stack/);
  const help = spawnSync(process.execPath, [runner, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.equal(help.stdout.trim(), usage().trim());
  for (const [args, message] of [
    [['--api-port', 'abc'], /invalid port: 'abc'/],
    [['--api-port', '4106', '--web-port', '4106'], /API and web ports must differ/],
    [['--api-port'], /--api-port needs a value/],
  ]) {
    const result = spawnSync(process.execPath, [runner, ...args], { encoding: 'utf8', cwd: REPO });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, message);
  }
});

test('a busy port stops the run and the listener is left alone', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const result = spawnSync(process.execPath, [runner, '--api-port', String(port)], { encoding: 'utf8', cwd: REPO });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, new RegExp(`port ${port} is already in use; choose another \\(nothing was stopped\\)`));
    assert.equal(server.listening, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/**
 * A bash that can run the wrapper: any on macOS and Linux; on Windows Git
 * Bash (MSYS) or Cygwin, not WSL's bash.exe, which cannot see Windows paths.
 */
function wrapperBash() {
  const probe = spawnSync('bash', ['-c', 'uname -s'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return 'no bash on PATH';
  // Git Bash reports MINGW64_NT-… or MSYS_NT-…, Cygwin CYGWIN_NT-…, WSL Linux.
  if (process.platform === 'win32' && !/^(mingw|msys|cygwin)/i.test(probe.stdout.trim())) {
    return `the bash on PATH runs ${probe.stdout.trim() || 'an unknown system'}, not Git Bash`;
  }
  return null;
}

test('scripts/e2e-disposable.sh hands every argument to the Node runner', { skip: wrapperBash() ?? false }, () => {
  // Relative and with forward slashes, so Git Bash's dirname works on it too.
  const relative = path.relative(REPO, wrapper).split(path.sep).join('/');
  const help = spawnSync('bash', [relative, '--help'], { encoding: 'utf8', cwd: REPO });
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stdout.trim(), usage().trim());
  const bad = spawnSync('bash', [relative, '--web-port', 'x y'], { encoding: 'utf8', cwd: REPO });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /invalid port: 'x y'/);
});

/* ------------------------------------------------------------------ */
/* Process groups: the lifecycle with a fake system, then for real     */
/* ------------------------------------------------------------------ */

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.stdout = null;
    this.connected = true;
    this.sent = [];
  }

  send(message, callback) {
    this.sent.push(message);
    callback?.(null);
    return true;
  }

  /** Reaped: from here on its PID may be anyone's. */
  reap(signal = 'SIGKILL') {
    this.signalCode = signal;
    this.emit('exit', null, signal);
  }
}

/** A system whose kill() "succeeds" for any ID, as it would for an ID someone else's group has reused. */
function fakeSystem(platform = 'darwin') {
  const calls = [];
  const spawned = [];
  const system = {
    platform,
    spawn(file, args, options) {
      const child = new FakeChild(4242 + spawned.length);
      spawned.push({ child, file, args, options });
      return child;
    },
    kill(pid, signal) {
      calls.push([pid, signal]);
    },
    taskkill(pid) {
      calls.push(['taskkill', pid]);
    },
    groupMembers: () => [4242],
  };
  return { system, calls, spawned };
}

const STDIO = ['ignore', 'ignore', 'ignore'];
const tick = () => new Promise((resolve) => setImmediate(resolve));

function captureWarnings() {
  const warnings = [];
  const original = console.error;
  console.error = (...args) => warnings.push(args.join(' '));
  return { warnings, restore: () => { console.error = original; } };
}

test('POSIX: the service runs under a group leader that leads a new group and keeps an IPC channel', async () => {
  const { system, spawned } = fakeSystem();
  const group = startGroup('api', '/opt/node', ['src/index.ts'], { cwd: '/repo/apps/api', env: { A: '1' }, stdio: ['ignore', 7, 7] }, system);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].file, process.execPath);
  assert.deepEqual(spawned[0].args, [GROUP_LEADER, '/opt/node', 'src/index.ts']);
  assert.deepEqual(spawned[0].options, { cwd: '/repo/apps/api', env: { A: '1' }, stdio: ['ignore', 7, 7, 'ipc'], detached: true });
  assert.equal(group.pgid, 4242);
  spawned[0].child.emit('message', { type: 'started', pid: 5000 });
  assert.equal(await group.started, 5000);
  assert.equal(group.running(), true);
});

test('POSIX: a group whose leader was seen to exit is never signalled again, though its ID may be reused', async () => {
  const { system, calls, spawned } = fakeSystem();
  const group = startGroup('api', '/opt/node', [], { cwd: '/', env: {}, stdio: STDIO }, system);
  const leader = spawned[0].child;
  leader.emit('message', { type: 'started', pid: 5000 });
  leader.emit('message', { type: 'exit', code: 0, signal: null });
  leader.reap(); // the group is gone; 4242 may now name another group
  await group.stop({ settleMs: 0 });
  assert.deepEqual(calls, []);
  assert.equal(group.pgid, null);
  assert.deepEqual(await group.exited, { code: 0, signal: null });
});

test('POSIX: a leader lost while its service runs is reported, and its group left alone', async () => {
  const { system, calls, spawned } = fakeSystem();
  const group = startGroup('vite', '/opt/node', [], { cwd: '/', env: {}, stdio: STDIO }, system);
  const leader = spawned[0].child;
  leader.emit('message', { type: 'started', pid: 5000 });
  const { warnings, restore } = captureWarnings();
  try {
    leader.reap();
    await group.stop({ settleMs: 0 });
  } finally {
    restore();
  }
  assert.deepEqual(calls, []);
  assert.match(warnings.join('\n'), /vite: its process group leader \(pid 4242\) exited unexpectedly; what is left of the group will not be signalled/);
  assert.deepEqual(await group.exited, { code: null, signal: null, error: 'its process group leader exited' });
});

test('POSIX: stop() sends the held group SIGTERM, waits, then ends it, leader included, with SIGKILL', async () => {
  const { system, calls, spawned } = fakeSystem();
  const group = startGroup('playwright', '/opt/node', [], { cwd: '/', env: {}, stdio: STDIO }, system);
  const leader = spawned[0].child;
  leader.emit('message', { type: 'started', pid: 5000 });
  let polls = 0;
  system.groupMembers = () => (polls++ < 2 ? [4242, 5001] : [4242]); // something the service started lingers a little
  system.kill = (pid, signal) => {
    calls.push([pid, signal]);
    if (signal === 'SIGTERM') leader.emit('message', { type: 'exit', code: null, signal: 'SIGTERM' });
    if (signal === 'SIGKILL') setImmediate(() => leader.reap());
  };
  await group.stop({ settleMs: 5_000 });
  assert.deepEqual(leader.sent, [{ type: 'stop', graceMs: 10_000 }]);
  assert.deepEqual(calls, [[-4242, 'SIGTERM'], [-4242, 'SIGKILL']]);
  assert.equal(polls, 3);
  assert.equal(group.pgid, null);
  assert.deepEqual(await group.exited, { code: null, signal: 'SIGTERM' });
});

test('POSIX: a leader that has not reported yet (signal handlers not in place) gets only the final SIGKILL', async () => {
  const { system, calls, spawned } = fakeSystem();
  const group = startGroup('api', '/opt/node', [], { cwd: '/', env: {}, stdio: STDIO }, system);
  const leader = spawned[0].child;
  system.kill = (pid, signal) => {
    calls.push([pid, signal]);
    if (signal === 'SIGKILL') setImmediate(() => leader.reap());
  };
  await group.stop({ readyMs: 50 });
  assert.deepEqual(calls, [[-4242, 'SIGKILL']]);
  assert.equal(group.pgid, null);
});

test('POSIX: a service that ignores SIGTERM is killed by its leader, which reports it before the group ends', async () => {
  const { system, calls, spawned } = fakeSystem();
  const group = startGroup('api', '/opt/node', [], { cwd: '/', env: {}, stdio: STDIO }, system);
  const leader = spawned[0].child;
  leader.emit('message', { type: 'started', pid: 5000 });
  leader.send = (message) => {
    leader.sent.push(message);
    // What the leader does: SIGTERM by PID, SIGKILL after graceMs, then the report.
    setTimeout(() => leader.emit('message', { type: 'exit', code: null, signal: 'SIGKILL', killed: true }), 30);
    return true;
  };
  system.kill = (pid, signal) => {
    calls.push([pid, signal]);
    if (signal === 'SIGKILL') setImmediate(() => leader.reap());
  };
  const { warnings, restore } = captureWarnings();
  try {
    await group.stop({ termMs: 20 });
  } finally {
    restore();
  }
  assert.deepEqual(leader.sent, [{ type: 'stop', graceMs: 20 }]);
  assert.deepEqual(calls, [[-4242, 'SIGTERM'], [-4242, 'SIGKILL']]);
  assert.match(warnings.join('\n'), /api ignored SIGTERM and was killed/);
  assert.deepEqual(await group.exited, { code: null, signal: 'SIGKILL' });
});

test('POSIX: without an exit report the group is still ended once the wait for it runs out', async () => {
  const { system, calls, spawned } = fakeSystem();
  const group = startGroup('api', '/opt/node', [], { cwd: '/', env: {}, stdio: STDIO }, system);
  const leader = spawned[0].child;
  leader.emit('message', { type: 'started', pid: 5000 });
  system.kill = (pid, signal) => {
    calls.push([pid, signal]);
    if (signal === 'SIGKILL') setImmediate(() => leader.reap());
  };
  const { warnings, restore } = captureWarnings();
  try {
    await group.stop({ termMs: 20, reportMs: 50 });
  } finally {
    restore();
  }
  assert.deepEqual(calls, [[-4242, 'SIGTERM'], [-4242, 'SIGKILL']]);
  assert.match(warnings.join('\n'), /api: no exit reported 0.05 s after it was asked to stop/);
});

test('POSIX: no SIGKILL once the leader has gone during the stop', async () => {
  const { system, calls, spawned } = fakeSystem();
  const group = startGroup('api', '/opt/node', [], { cwd: '/', env: {}, stdio: STDIO }, system);
  const leader = spawned[0].child;
  leader.emit('message', { type: 'started', pid: 5000 });
  system.kill = (pid, signal) => {
    calls.push([pid, signal]);
    if (signal === 'SIGTERM') leader.reap(); // killed by someone else meanwhile
  };
  const { restore } = captureWarnings();
  try {
    await group.stop();
  } finally {
    restore();
  }
  assert.deepEqual(calls, [[-4242, 'SIGTERM']]);
});

test('Windows: taskkill /T /F only while the root process has not been reaped', async () => {
  const { system, calls, spawned } = fakeSystem('win32');
  const running = startGroup('api', 'C:\\node\\node.exe', ['src\\index.ts'], { cwd: 'C:\\repo', env: {}, stdio: STDIO }, system);
  assert.deepEqual(spawned[0].options, { cwd: 'C:\\repo', env: {}, stdio: STDIO, windowsHide: true });
  const root = spawned[0].child;
  root.emit('spawn');
  assert.equal(await running.started, 4242);
  system.taskkill = (pid) => {
    calls.push(['taskkill', pid]);
    setImmediate(() => root.reap());
  };
  await running.stop();
  assert.deepEqual(calls, [['taskkill', 4242]]);

  const exited = startGroup('vite', 'C:\\node\\node.exe', [], { cwd: 'C:\\repo', env: {}, stdio: STDIO }, system);
  spawned[1].child.emit('spawn');
  spawned[1].child.reap();
  await tick();
  await exited.stop();
  assert.deepEqual(calls, [['taskkill', 4242]]);
});

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
const pgidOf = (pid) => Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
async function waitFor(condition, ms, what) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
const posixOnly = { skip: process.platform === 'win32' && 'POSIX process groups' };

test('POSIX, for real: a grandchild that outlives its service and ignores SIGTERM is ended through the held group', posixOnly, async () => {
  // The service starts a grandchild that ignores SIGTERM, waits until it is
  // ready, prints its PID and exits, leaving it behind in the group.
  const service = [
    "const { spawn } = require('node:child_process');",
    "const grandchild = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); process.stdout.write('ready\\\\n'); setInterval(() => {}, 1000)\"], { stdio: ['ignore', 'pipe', 'ignore'] });",
    'grandchild.stdout.once(\'data\', () => {',
    '  console.log(grandchild.pid);',
    '  grandchild.stdout.destroy();',
    '  grandchild.unref();',
    '});',
  ].join('\n');
  const group = startGroup('probe', process.execPath, ['-e', service], { cwd: REPO, env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  group.stdout.setEncoding('utf8').on('data', (chunk) => {
    output += chunk;
  });
  const leaderPid = group.pgid;
  assert.equal((await group.exited).code, 0);
  await waitFor(() => output.includes('\n'), 5_000, "the grandchild's PID");
  const grandchild = Number(output.trim());
  assert.ok(isAlive(grandchild), 'the grandchild outlived the service');
  assert.equal(pgidOf(grandchild), leaderPid, 'the grandchild is in the held group');
  assert.ok(isAlive(leaderPid), 'the leader holds the group after the service exited');
  // SIGTERM to the whole group (safe: the leader is this test's unreaped child): both ignore it.
  process.kill(-leaderPid, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(isAlive(grandchild) && isAlive(leaderPid), 'the grandchild and the leader ignored SIGTERM');
  await group.stop({ settleMs: 300 });
  assert.equal(group.pgid, null);
  await waitFor(() => !isAlive(grandchild), 5_000, 'the grandchild to be gone');
  await waitFor(() => !isAlive(leaderPid), 5_000, 'the leader to be gone');
});

test('POSIX, for real: if the runner dies, the group leader ends its group', posixOnly, async () => {
  const runnerScript = [
    `import { startGroup } from ${JSON.stringify(pathToFileURL(runner).href)};`,
    "const group = startGroup('service', process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'ignore', 'inherit'] });",
    'group.started.then((pid) => console.log(JSON.stringify({ pid, pgid: group.pgid })));',
  ].join('\n');
  const fakeRunner = spawn(process.execPath, ['--input-type=module', '-e', runnerScript], { stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  fakeRunner.stdout.setEncoding('utf8').on('data', (chunk) => {
    output += chunk;
  });
  await waitFor(() => output.includes('\n'), 10_000, 'the service to start');
  const { pid, pgid } = JSON.parse(output);
  assert.ok(isAlive(pid) && isAlive(pgid));
  assert.equal(pgidOf(pid), pgid);
  fakeRunner.kill('SIGKILL'); // gone without any cleanup
  await waitFor(() => !isAlive(pid), 5_000, 'the service to be stopped (SIGTERM)');
  await waitFor(() => !isAlive(pgid), 10_000, 'the leader to end the group (SIGKILL after 5 s)');
});

const hasPerl = spawnSync('perl', ['-MPOSIX', '-e', '1']).status === 0;

test('POSIX, for real: a service that leaves the group (setsid) and ignores SIGTERM is killed and reaped before stop() returns', { skip: (process.platform === 'win32' && 'POSIX process groups') || (!hasPerl && 'needs perl for setsid()') }, async () => {
  // perl, for setsid(): Node has no call for it.
  const service = 'POSIX::setsid() or die "setsid: $!"; $SIG{TERM} = "IGNORE"; $| = 1; print "$$\n"; sleep 3600';
  const group = startGroup('setsid-service', 'perl', ['-MPOSIX', '-e', service], { cwd: REPO, env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  group.stdout.setEncoding('utf8').on('data', (chunk) => {
    output += chunk;
  });
  await waitFor(() => output.includes('\n'), 10_000, "the service's PID");
  const pid = Number(output.trim());
  try {
    assert.equal(pgidOf(pid), pid, 'the service leads a group (and session) of its own');
    assert.notEqual(pgidOf(pid), group.pgid);
    const { warnings, restore } = captureWarnings();
    const started = Date.now();
    try {
      await group.stop({ termMs: 500, settleMs: 200 });
    } finally {
      restore();
    }
    assert.ok(Date.now() - started >= 500, 'stop() waited for the SIGKILL after termMs');
    assert.equal(isAlive(pid), false, 'killed and reaped by its leader before stop() returned');
    assert.match(warnings.join('\n'), /setsid-service ignored SIGTERM and was killed/);
  } finally {
    if (isAlive(pid)) process.kill(pid, 'SIGKILL'); // only if the check above failed
  }
});

/** Start the group leader by hand, close its IPC channel after `delayMs`, and see what is left. */
async function leaderLosingItsRunner(delayMs, service) {
  const leader = spawn(process.execPath, [GROUP_LEADER, process.execPath, '-e', service], {
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
    detached: true,
  });
  let output = '';
  leader.stdout.setEncoding('utf8').on('data', (chunk) => {
    output += chunk;
  });
  leader.on('error', () => {});
  if (delayMs === 0) leader.disconnect();
  else setTimeout(() => leader.connected && leader.disconnect(), delayMs);
  const exited = await new Promise((resolve) => leader.once('exit', (code, signal) => resolve({ code, signal })));
  const servicePid = Number(output.trim()) || null;
  return { exited, servicePid, leaderPid: leader.pid };
}

const groupMembers = (pgid) => execFileSync('ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf8' })
  .split('\n').map((line) => line.trim().split(/\s+/).map(Number)).filter(([, group]) => group === pgid).map(([pid]) => pid);

for (const [label, delayMs, service] of [
  ['closed at once', 0, 'console.log(process.pid); setInterval(() => {}, 1000)'],
  ['closed while the service starts', 25, 'console.log(process.pid); setInterval(() => {}, 1000)'],
  ['closed after it started', 300, 'console.log(process.pid); setInterval(() => {}, 1000)'],
  ['closed after a service that ignores SIGTERM started', 300, "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000)"],
]) {
  test(`POSIX, for real: a group leader whose IPC channel is ${label} leaves no service behind`, posixOnly, async () => {
    const { exited, servicePid, leaderPid } = await leaderLosingItsRunner(delayMs, service);
    try {
      assert.notEqual(exited.code, 0, 'the leader shut down');
      if (servicePid !== null) await waitFor(() => !isAlive(servicePid), 10_000, 'the service to be gone');
      await waitFor(() => groupMembers(leaderPid).length === 0, 10_000, 'the group to be empty');
    } finally {
      for (const pid of groupMembers(leaderPid)) process.kill(pid, 'SIGKILL'); // only if the checks above failed
    }
  });
}
