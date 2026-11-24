import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { system32 } from './e2e-disposable.mjs';
import { cliEnv } from './holdr-cli.mjs';
import {
  BUILD_STAMP,
  DEMO_MARKER,
  UsageError,
  WINDOWS_ACL_SCRIPT,
  WINDOWS_PRIVATE_FOLDER_COMMAND,
  apiEnvFor,
  defaultDataDir,
  defaultDataRoot,
  defaultDemoRoot,
  demoBaseEnv,
  demoFolderAround,
  demoFolderProblem,
  demoFolderRefusal,
  demoPlan,
  demoSeededOn,
  discardDemoFolder,
  ensurePrivateDir,
  hardenedConfig,
  holdrOnlyEntries,
  homeMasker,
  icaclsPlan,
  loadDotEnv,
  makePrivate,
  needsBuild,
  newYorkDate,
  nodeVersionProblem,
  parseArgs,
  parseHttpsOrigin,
  parseWhoamiSid,
  parseWindowsAcl,
  privateDirVerdict,
  readDemoMarker,
  resolveOptions,
  runningBanner,
  supportedNode,
  tailscaleHints,
  tailscaleServeCommand,
  webEnvFor,
  writeBuildStamp,
} from './start-local.mjs';

// scripts/start-local.mjs (npm run start:local, npm run demo) and scripts/holdr-cli.mjs: arguments, the per-OS data
// folders and their privacy, the children's environments, .env loading, the build check, the demo's day and the home
// folder mask. Nothing here starts a server.

const SID = 'S-1-5-21-1000000000-2000000000-3000000000-1001';
const OTHER_SID = 'S-1-5-21-1000000000-2000000000-3000000000-1002';
const USERS = 'S-1-5-32-545';
const SYSTEM = 'S-1-5-18';
const ADMINS = 'S-1-5-32-544';

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdr-start-local-'));
}

test('parses options, flags and their combinations', () => {
  assert.deepEqual(parseArgs([]), {
    dataDir: '', apiPort: '', webPort: '', httpsOrigin: '', password: '', dev: false, rebuild: false, demo: false, reset: false,
    keepData: false, passwordStdin: false, help: false,
  });
  const options = parseArgs(['--api-port', '4100', '--web-port=5200', '--data-dir', 'D', '--https-origin', 'https://holdr.example.ts.net', '--dev', '--rebuild']);
  assert.equal(options.apiPort, '4100');
  assert.equal(options.webPort, '5200');
  assert.equal(options.dataDir, 'D');
  assert.equal(options.dev, true);
  assert.equal(options.rebuild, true);
  assert.equal(parseArgs(['--demo', '--reset', '--password', 'pw-123456']).password, 'pw-123456');
  assert.equal(parseArgs(['--demo', '--keep-data']).keepData, true);
  assert.equal(parseArgs(['--demo', '--password-stdin']).passwordStdin, true);
  assert.equal(parseArgs(['-h']).help, true);
  for (const argv of [['--port', '1'], ['--api-port'], ['--data-dir='], ['--reset'], ['--password', 'x'], ['--keep-data'], ['--password-stdin'],
    ['--demo', '--reset', '--keep-data'], ['--demo', '--password', 'pw-123456', '--password-stdin'],
    ['--demo', '--https-origin', 'https://holdr.example.ts.net'], ['stray']]) {
    assert.throws(() => parseArgs(argv), UsageError, argv.join(' '));
  }
});

test('accepts only an https origin with a host name for --https-origin, and tells where tailscale is', () => {
  assert.equal(parseHttpsOrigin('https://holdr.example.ts.net'), 'https://holdr.example.ts.net');
  assert.equal(parseHttpsOrigin('https://holdr.example.ts.net/'), 'https://holdr.example.ts.net');
  assert.equal(parseHttpsOrigin('https://holdr.example.ts.net:443'), 'https://holdr.example.ts.net');
  for (const value of ['http://holdr.example.ts.net', 'https://holdr.example.ts.net/app', 'https://holdr.example.ts.net:8443', 'https://user@holdr.example.ts.net',
    'https://holdr.example.ts.net/?q=1', 'https://localhost', 'holdr.example.ts.net', '']) {
    assert.throws(() => parseHttpsOrigin(value), UsageError, value);
  }
  assert.equal(tailscaleServeCommand(5173), 'tailscale serve --bg --https=443 http://127.0.0.1:5173');
  const mac = tailscaleHints('darwin').join(' ');
  assert.match(mac, /standalone Tailscale app, choose Settings → CLI integration → Show me how → Install Now/);
  assert.match(mac, /App Store app, or for this Terminal window only: alias tailscale=\/Applications\/Tailscale\.app\/Contents\/MacOS\/Tailscale$/);
  assert.match(tailscaleHints('win32').join(' '), /Access denied.*administrator PowerShell/);
  assert.deepEqual(tailscaleHints('linux'), []);
});

test('says where Holdr runs: the https origin when there is one, since its Secure sign-in cookies work only there', () => {
  const local = runningBanner({ url: 'http://127.0.0.1:5173', webPort: 5173, dataDir: '/srv/holdr' }, 'darwin');
  assert.equal(local[1], 'Holdr is running: http://127.0.0.1:5173');
  assert.ok(local.includes('  data folder: /srv/holdr'));
  assert.ok(!local.some((line) => /publish|Secure/.test(line)));
  const tailnet = runningBanner({ url: 'http://127.0.0.1:5173', httpsOrigin: 'https://holdr.example.ts.net', webPort: 5173, dataDir: '/srv/holdr' }, 'win32');
  assert.equal(tailnet[1], 'Holdr is running: https://holdr.example.ts.net');
  assert.match(tailnet[2], /this computer too: .*Secure, so http:\/\/127\.0\.0\.1:5173 cannot sign you in/);
  assert.ok(tailnet.includes('  publish it once with: tailscale serve --bg --https=443 http://127.0.0.1:5173'));
  assert.ok(tailnet.includes('    if Windows answers "Access denied", run it once in an administrator PowerShell'));
  const proxied = runningBanner({ url: 'http://127.0.0.1:5200', httpsOrigin: 'https://holdr.example.com', webPort: 5200, dataDir: '/srv/holdr' }, 'linux');
  assert.equal(proxied[1], 'Holdr is running: https://holdr.example.com');
  assert.ok(proxied.includes('  point your HTTPS proxy for https://holdr.example.com at http://127.0.0.1:5200'));
  const demo = runningBanner({ demo: true, url: 'http://localhost:5174', webPort: 5174, demoRoot: '/srv/holdr-demo', password: 'pw-123456' }, 'linux');
  assert.equal(demo[1], 'The Holdr demo is running: http://localhost:5174');
  assert.ok(demo.includes('  sign in as demo, password: pw-123456'));
  assert.ok(runningBanner({ demo: true, url: 'http://localhost:5174', webPort: 5174, demoRoot: '/d', password: 'x', passwordStdin: true }, 'linux')
    .includes('  sign in as demo, password: (the one you gave)'));
  assert.deepEqual(tailnet.slice(-2), ['  stop: Ctrl+C', '']);
});

test('keeps data in a per-user application folder on each operating system', () => {
  assert.equal(defaultDataRoot({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\sample\\AppData\\Local' }, home: 'C:\\Users\\sample' }),
    'C:\\Users\\sample\\AppData\\Local\\Holdr');
  assert.equal(defaultDataDir({ platform: 'win32', env: {}, home: 'C:\\Users\\sample' }), 'C:\\Users\\sample\\AppData\\Local\\Holdr\\data');
  assert.equal(defaultDemoRoot({ platform: 'win32', env: { LOCALAPPDATA: 'D:\\Local' }, home: 'C:\\Users\\sample' }), 'D:\\Local\\Holdr\\holdr-demo');
  assert.equal(defaultDataDir({ platform: 'darwin', env: {}, home: '/Users/sample' }), '/Users/sample/Library/Application Support/Holdr/data');
  assert.equal(defaultDemoRoot({ platform: 'darwin', env: {}, home: '/Users/sample' }), '/Users/sample/Library/Application Support/Holdr/holdr-demo');
  assert.equal(defaultDataDir({ platform: 'linux', env: {}, home: '/home/sample' }), '/home/sample/.local/share/holdr/data');
  assert.equal(defaultDataDir({ platform: 'linux', env: { XDG_DATA_HOME: '/data/xdg' }, home: '/home/sample' }), '/data/xdg/holdr/data');
  assert.equal(defaultDataDir({ platform: 'linux', env: { XDG_DATA_HOME: 'relative' }, home: '/home/sample' }), '/home/sample/.local/share/holdr/data');
});

test('writes the home folder short in everything it prints', () => {
  const windows = homeMasker({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\sample\\AppData\\Local', USERPROFILE: 'C:\\Users\\sample' }, home: 'C:\\Users\\sample' });
  assert.equal(windows('[holdr-api] data dir: C:\\Users\\sample\\AppData\\Local\\Holdr\\holdr-demo\\data (HOLDR_DATA_DIR)'),
    '[holdr-api] data dir: %LOCALAPPDATA%\\Holdr\\holdr-demo\\data (HOLDR_DATA_DIR)');
  assert.equal(windows('c:/users/SAMPLE/Documents and C:\\Users\\sample'), '%USERPROFILE%/Documents and %USERPROFILE%');
  assert.equal(windows('C:\\Users\\sample2\\x'), 'C:\\Users\\sample2\\x');
  const mac = homeMasker({ platform: 'darwin', env: {}, home: '/Users/sample' });
  assert.equal(mac('"/Users/sample/Library/Application Support/Holdr/data" and /Users/sample'), '"~/Library/Application Support/Holdr/data" and ~');
  assert.equal(mac('/Users/sample2/y'), '/Users/sample2/y');
});

test('resolves ports, folders and the address from options, then the environment, then the defaults', () => {
  const where = { platform: 'darwin', home: '/Users/sample' };
  const plain = resolveOptions(parseArgs([]), { ...where, env: {} });
  assert.deepEqual([plain.apiPort, plain.webPort, plain.dataDir, plain.httpsOrigin, plain.dataDirIsDefault, plain.url],
    [4000, 5173, '/Users/sample/Library/Application Support/Holdr/data', null, true, 'http://127.0.0.1:5173']);
  const fromEnv = resolveOptions(parseArgs([]), { ...where, env: { PORT: '4400', HOLDR_DATA_DIR: '/srv/holdr', HOLDR_PUBLIC_ORIGIN: 'https://holdr.example.ts.net' } });
  assert.deepEqual([fromEnv.apiPort, fromEnv.dataDir, fromEnv.httpsOrigin, fromEnv.dataDirIsDefault], [4400, '/srv/holdr', 'https://holdr.example.ts.net', false]);
  // The demo opens on localhost: its sign-in cookie never replaces the one of a Holdr at 127.0.0.1.
  const demo = resolveOptions(parseArgs(['--demo']), { ...where, env: { PORT: '4400', HOLDR_DATA_DIR: '/srv/holdr', HOLDR_PUBLIC_ORIGIN: 'https://holdr.example.ts.net' } });
  assert.deepEqual([demo.apiPort, demo.webPort, demo.dataDir, demo.httpsOrigin, demo.url],
    [4001, 5174, '/Users/sample/Library/Application Support/Holdr/holdr-demo/data', null, 'http://localhost:5174']);
  const elsewhere = resolveOptions(parseArgs(['--demo', '--data-dir', '/tmp/holdr-demo-try']), { ...where, env: {} });
  assert.deepEqual([elsewhere.demoRoot, elsewhere.dataDir], ['/tmp/holdr-demo-try', '/tmp/holdr-demo-try/data']);
  assert.throws(() => resolveOptions(parseArgs(['--api-port', '5173']), { ...where, env: {} }), /must differ/);
  assert.throws(() => resolveOptions(parseArgs(['--web-port', '70000']), { ...where, env: {} }), UsageError);
});

test('gives the API loopback, the data folder and the web origins; the demo is offline, never public, and gets only system variables', () => {
  const base = {
    PATH: '/bin', WEB_ORIGIN: 'https://lan.example', HOLDR_CONTROL_DIR: '/c', HOLDR_E2E_RUN_ID: 'x', HOLDR_METALS_PRICES: '1',
    HOLDR_PUBLIC_ORIGIN: 'https://holdr.example.ts.net', HOLDR_METALS_FUNGIBLE: 'XAU', NODE_OPTIONS: '--require x', npm_config_cache: '/n', TZ: 'UTC',
  };
  const env = apiEnvFor(base, { dataDir: '/d', apiPort: 4000, webPort: 5173, httpsOrigin: 'https://holdr.example.ts.net', demo: false }, 'linux');
  assert.equal(env.HOLDR_DATA_DIR, '/d');
  assert.equal(env.PORT, '4000');
  assert.equal(env.HOLDR_HOST, '127.0.0.1');
  assert.equal(env.WEB_ORIGIN, 'http://127.0.0.1:5173,http://localhost:5173,https://lan.example');
  assert.equal(env.HOLDR_PUBLIC_ORIGIN, 'https://holdr.example.ts.net');
  assert.equal(env.HOLDR_METALS_PRICES, '1');
  assert.equal(env.HOLDR_MARKET_DATA, undefined);
  assert.equal(env.HOLDR_CONTROL_DIR, undefined);
  assert.equal(env.HOLDR_E2E_RUN_ID, undefined);

  const demo = apiEnvFor({ ...base, HOME: '/Users/sample', HOLDR_CONFIG: '/x/holdr.conf' }, { dataDir: '/demo', apiPort: 4001, webPort: 5174, httpsOrigin: null, demo: true }, 'linux');
  assert.equal(demo.WEB_ORIGIN, 'http://127.0.0.1:5174,http://localhost:5174');
  assert.equal(demo.HOLDR_MARKET_DATA, 'stored');
  // The API finds a hardened deployment's holdr.conf through HOLDR_CONFIG or HOME only: the demo's gets neither.
  assert.equal(demo.HOLDR_CONFIG, undefined);
  assert.equal(demo.HOME, undefined);
  assert.equal(demo.SNAPSHOTS_ENABLED, '0');
  assert.equal(demo.HOLDR_INTRADAY_PRICES, '0');
  assert.match(demo.BROKER_BRIDGE_URL, /\.invalid$/);
  // Nothing of this process's own settings (or a .env file's) reaches the demo: only the system's variables.
  for (const name of ['HOLDR_METALS_PRICES', 'HOLDR_PUBLIC_ORIGIN', 'HOLDR_METALS_FUNGIBLE', 'HOLDR_CONTROL_DIR', 'NODE_OPTIONS', 'npm_config_cache']) {
    assert.equal(demo[name], undefined, name);
  }
  assert.deepEqual([demo.PATH, demo.TZ], ['/bin', 'UTC']);

  // Windows names are case-insensitive: another spelling of an overridden name goes too.
  const windows = apiEnvFor({ Path: 'C:\\Windows', holdr_data_dir: 'C:\\old', Port: '1' }, { dataDir: 'C:\\new', apiPort: 4000, webPort: 5173, httpsOrigin: null, demo: false }, 'win32');
  assert.equal(windows.holdr_data_dir, undefined);
  assert.equal(windows.Port, undefined);
  assert.equal(windows.HOLDR_DATA_DIR, 'C:\\new');
  assert.deepEqual(demoBaseEnv({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', holdr_x: '1', LocalAppData: 'C:\\L' }, 'win32'),
    { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', LocalAppData: 'C:\\L' });
});

test('keeps the web app on its own origin through the proxy', () => {
  const env = webEnvFor({ PATH: '/bin', VITE_API_BASE: 'http://elsewhere', VITE_OTHER: '1', HOLDR_TAILNET_HOSTNAME: 'holdr' }, { apiPort: 4000, httpsOrigin: 'https://holdr.example.ts.net', demo: false }, 'linux');
  assert.equal(env.VITE_API_BASE, '');
  assert.equal(env.VITE_OTHER, undefined);
  assert.equal(env.HOLDR_API_TARGET, 'http://127.0.0.1:4000');
  assert.equal(env.HOLDR_PUBLIC_ORIGIN, 'https://holdr.example.ts.net');
  assert.equal(env.HOLDR_TAILNET_HOSTNAME, 'holdr');
  const demo = webEnvFor({ PATH: '/bin', HOLDR_TAILNET_HOSTNAME: 'holdr', HOLDR_PUBLIC_ORIGIN: 'https://holdr.example.ts.net' }, { apiPort: 4001, httpsOrigin: null, demo: true }, 'linux');
  assert.equal(demo.HOLDR_TAILNET_HOSTNAME, undefined);
  assert.equal(demo.HOLDR_PUBLIC_ORIGIN, undefined);
  assert.deepEqual([demo.PATH, demo.HOLDR_API_TARGET, demo.VITE_API_BASE], ['/bin', 'http://127.0.0.1:4001', '']);
});

test('reads .env without overriding what is already set', () => {
  const dir = scratch();
  try {
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, '# comment\nPORT=4100\nHOLDR_DATA_DIR="/srv/holdr data"\nEMPTY=\nexport IGNORED_EXPORT=1\n');
    const env = { PORT: '4000' };
    const applied = loadDotEnv(file, env);
    assert.equal(env.PORT, '4000');
    assert.equal(env.HOLDR_DATA_DIR, '/srv/holdr data');
    assert.ok(applied.includes('HOLDR_DATA_DIR'));
    assert.ok(!applied.includes('PORT'));
    assert.deepEqual(loadDotEnv(path.join(dir, 'missing.env'), env), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses to run beside a hardened deployment configuration', () => {
  assert.equal(hardenedConfig({ HOLDR_CONFIG: '/x/holdr.conf' }, () => false), '/x/holdr.conf');
  assert.equal(hardenedConfig({ HOME: '/Users/sample' }, () => false), null);
  assert.equal(hardenedConfig({ HOME: '/Users/sample' }, (file) => file === '/Users/sample/Library/Application Support/Holdr/holdr.conf'),
    '/Users/sample/Library/Application Support/Holdr/holdr.conf');
  assert.equal(hardenedConfig({ HOME: 'C:\\Users\\sample' }, () => true), null);
});

test('the holdr-* tools get the same .env and default data folder as start:local, unless holdr.conf decides', () => {
  const dir = scratch();
  try {
    const dotEnvFile = path.join(dir, '.env');
    fs.writeFileSync(dotEnvFile, 'HOLDR_SAMPLE=1\n');
    const plain = cliEnv({ LOCALAPPDATA: 'C:\\Local' }, { dotEnvFile, platform: 'win32', exists: () => false });
    assert.equal(plain.env.HOLDR_DATA_DIR, 'C:\\Local\\Holdr\\data');
    assert.equal(plain.env.HOLDR_SAMPLE, '1');
    assert.equal(plain.defaulted, true);
    const configured = cliEnv({ HOLDR_DATA_DIR: 'D:\\holdr' }, { dotEnvFile, platform: 'win32', exists: () => false });
    assert.deepEqual([configured.env.HOLDR_DATA_DIR, configured.defaulted], ['D:\\holdr', false]);
    const hardened = cliEnv({ HOME: '/Users/sample' }, { dotEnvFile, platform: 'darwin', exists: () => true });
    assert.deepEqual([hardened.env.HOLDR_DATA_DIR, hardened.defaulted], [undefined, false]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rebuilds when the stamp is missing or a source is newer, and not otherwise', () => {
  const dir = scratch();
  try {
    const src = path.join(dir, 'src');
    const out = path.join(dir, 'dist');
    fs.mkdirSync(path.join(src, 'nested'), { recursive: true });
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(src, 'nested', 'a.ts'), 'export {};\n');
    assert.equal(needsBuild(out, [src]), true);
    writeBuildStamp(out);
    const stamp = path.join(out, BUILD_STAMP);
    fs.utimesSync(path.join(src, 'nested', 'a.ts'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    assert.equal(needsBuild(out, [src]), false);
    assert.equal(needsBuild(out, [src], { force: true }), true);
    fs.utimesSync(stamp, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    assert.equal(needsBuild(out, [src]), true);
    // Build output and dependencies under the inputs never count.
    fs.utimesSync(stamp, new Date(), new Date());
    fs.mkdirSync(path.join(src, 'node_modules'));
    fs.writeFileSync(path.join(src, 'node_modules', 'later.js'), '');
    fs.utimesSync(path.join(src, 'node_modules', 'later.js'), new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    assert.equal(needsBuild(out, [src]), false);
    // Without a stamp, the build's own output dates it (what npm ci's tsc build leaves).
    fs.rmSync(stamp);
    fs.writeFileSync(path.join(out, 'index.js'), '');
    assert.equal(needsBuild(out, [src]), true);
    assert.equal(needsBuild(out, [src], { marker: 'index.js' }), false);
    fs.utimesSync(path.join(out, 'index.js'), new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    assert.equal(needsBuild(out, [src], { marker: 'index.js' }), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('creates missing folders owner-only: icacls by SID on Windows, mode 0700 elsewhere', () => {
  assert.equal(parseWhoamiSid(`"desktop\\sample","${SID}"\r\n`), SID);
  assert.throws(() => parseWhoamiSid('"desktop\\sample"'), /SID/);
  assert.deepEqual(icaclsPlan('C:\\x', SID), [
    ['C:\\x', '/inheritance:r', '/grant:r', `*${SID}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'],
    ['C:\\x', '/setowner', `*${SID}`],
  ]);
  assert.throws(() => icaclsPlan('C:\\x', 'sample'), /not a SID/);

  const dir = scratch();
  try {
    const target = path.join(dir, 'Holdr', 'data');
    const calls = [];
    const run = (file, args) => {
      calls.push([path.basename(file).toLowerCase(), args]);
      return `"desktop\\sample","${SID}"`;
    };
    const created = ensurePrivateDir(target, { platform: 'win32', run });
    assert.deepEqual(created, [path.join(dir, 'Holdr'), target]);
    assert.deepEqual(calls.map(([file, args]) => [file, args[0], args[1]]), [
      ['whoami.exe', '/user', '/fo'],
      ['icacls.exe', path.join(dir, 'Holdr'), '/inheritance:r'],
      ['icacls.exe', path.join(dir, 'Holdr'), '/setowner'],
      ['icacls.exe', target, '/inheritance:r'],
      ['icacls.exe', target, '/setowner'],
    ]);
    // An existing folder is checked instead (makePrivate), or left alone with tighten: false.
    assert.deepEqual(ensurePrivateDir(target, { platform: 'win32', run: () => assert.fail('must not run'), tighten: false }), []);
    const inspected = [];
    assert.deepEqual(ensurePrivateDir(target, {
      platform: 'win32', run: () => assert.fail('must not run'),
      inspect: (folder) => { inspected.push(folder); return { user: SID, admin: false, owner: SID, aces: [{ sid: SID, rights: 0x1f01ff, type: 'Allow' }] }; },
    }), []);
    assert.deepEqual(inspected, [target]);
    if (process.platform !== 'win32') {
      const posix = path.join(dir, 'posix', 'data');
      ensurePrivateDir(posix, { platform: process.platform });
      assert.equal(fs.statSync(posix).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.dirname(posix)).mode & 0o777, 0o700);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('makes an existing data folder private when it is this user\'s and holds Holdr\'s files only, and refuses otherwise', () => {
  // The verdict, by SIDs (Windows) or uid and mode bits.
  const windows = (owner, aces, admin = false) => privateDirVerdict({ platform: 'win32', user: SID, admin, owner, aces });
  const allow = (sid, rights = 0x1200a9) => ({ sid, rights, type: 'Allow' });
  assert.equal(windows(SID, [allow(SID, 0x1f01ff), allow(SYSTEM), allow(ADMINS)]), 'private');
  // An elevated administrator's folders belong to the Administrators group: still theirs.
  assert.equal(windows(ADMINS, [allow(SID, 0x1f01ff), allow(SYSTEM), allow(ADMINS)], true), 'private');
  assert.deepEqual(windows(ADMINS, [allow(SID)], false), { refuse: 'owner' });
  assert.deepEqual(windows(OTHER_SID, [allow(SID)]), { refuse: 'owner' });
  assert.deepEqual(windows(SID, [allow(SID), allow(USERS), allow(USERS, 0x100000), { sid: OTHER_SID, rights: 0x1f01ff, type: 'Deny' }]), { tighten: [USERS] });
  assert.equal(privateDirVerdict({ platform: 'darwin', uid: 501, processUid: 501, mode: 0o40700 }), 'private');
  assert.deepEqual(privateDirVerdict({ platform: 'darwin', uid: 501, processUid: 501, mode: 0o40755 }), { tighten: [] });
  assert.deepEqual(privateDirVerdict({ platform: 'linux', uid: 0, processUid: 1000, mode: 0o40700 }), { refuse: 'owner' });
  assert.equal(holdrOnlyEntries(['finance.db', 'finance.db-wal', 'finance.db-shm', 'service-token', 'agent-token', 'agent-token.tmp-1',
    'state.json.migrated', '.DS_Store']), true);
  assert.equal(holdrOnlyEntries(['finance.db', 'Documents']), false);
  assert.deepEqual(parseWindowsAcl(JSON.stringify({ user: SID, admin: true, owner: ADMINS, aces: { sid: USERS, rights: -1610612736, type: 'Allow' } })),
    { user: SID, admin: true, owner: ADMINS, aces: [{ sid: USERS, rights: 0xa0000000, type: 'Allow' }] });
  assert.throws(() => parseWindowsAcl(JSON.stringify({ user: 'sample', owner: SID, aces: [] })), /owner and access rules/);

  const dir = scratch();
  try {
    fs.writeFileSync(path.join(dir, 'finance.db'), '');
    // Windows: the readers that aren't the user, SYSTEM or Administrators go, then the owner-only ACL.
    const calls = [];
    let checks = 0;
    const reports = [];
    const changed = makePrivate(dir, {
      platform: 'win32',
      run: (file, args) => { calls.push([path.basename(file).toLowerCase(), ...args.slice(1)]); return ''; },
      inspect: () => (checks++ === 0
        ? { user: SID, admin: false, owner: SID, aces: [allow(SID, 0x1f01ff), allow(USERS)] }
        : { user: SID, admin: false, owner: SID, aces: [allow(SID, 0x1f01ff), allow(SYSTEM, 0x1f01ff)] }),
      report: (line) => reports.push(line),
    });
    assert.equal(changed, true);
    assert.deepEqual(calls, [
      ['icacls.exe', '/remove:g', `*${USERS}`],
      ['icacls.exe', '/inheritance:r', '/grant:r', `*${SID}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'],
      ['icacls.exe', '/setowner', `*${SID}`],
    ]);
    assert.match(reports[0], /readable by you only/);
    assert.throws(() => makePrivate(dir, { platform: 'win32', run: () => '', inspect: () => ({ user: SID, admin: false, owner: OTHER_SID, aces: [] }) }),
      /belongs to another account/);
    fs.mkdirSync(path.join(dir, 'Documents'));
    assert.throws(() => makePrivate(dir, { platform: 'win32', run: () => assert.fail('must not run'), inspect: () => ({ user: SID, admin: false, owner: SID, aces: [allow(USERS)] }) }),
      (error) => /files that are not Holdr's/.test(error.message) && error.message.includes(`(in PowerShell: ${WINDOWS_PRIVATE_FOLDER_COMMAND}).`));
    // A check that can't run warns and changes nothing.
    const warned = [];
    assert.equal(makePrivate(dir, { platform: 'win32', run: () => assert.fail('must not run'), inspect: () => { throw new Error('no PowerShell'); }, report: (line) => warned.push(line) }), false);
    assert.match(warned[0], /could not check/);
    if (process.platform !== 'win32') {
      fs.rmSync(path.join(dir, 'Documents'), { recursive: true });
      fs.chmodSync(dir, 0o755);
      assert.equal(makePrivate(dir), true);
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
      assert.equal(makePrivate(dir), false);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('makes the demo for its New York date, again on a later day unless asked to keep it', () => {
  assert.equal(demoSeededOn('Holdr demo data (synthetic). Safe to delete.\nseeded 2026-03-18\n'), '2026-03-18');
  assert.equal(demoSeededOn('Holdr demo data (synthetic). Safe to delete.\n'), null);
  assert.equal(demoSeededOn('Holdr demo data (synthetic). Safe to delete.\nseeded 2026-03-18 partial\n'), null);
  // Only the whole marker counts: a seeded line in some other file is not the demo's.
  assert.equal(demoSeededOn('my notes\nseeded 2026-03-18\n'), null);
  assert.equal(demoSeededOn('Holdr demo data (synthetic). Safe to delete.\nseeded 2026-03-18\nmore\n'), null);
  assert.equal(demoSeededOn(undefined), null);
  assert.equal(newYorkDate(new Date('2026-03-19T01:30:00Z')), '2026-03-18');
  assert.equal(newYorkDate(new Date('2026-07-19T12:00:00Z')), '2026-07-19');
  const today = '2026-03-18';
  const plan = (state) => demoPlan({ exists: true, seeded: today, databaseExists: true, today, reset: false, keepData: false, ...state });
  assert.equal(plan({ exists: false, seeded: null }), 'seed');
  assert.equal(plan({}), 'reuse');
  assert.equal(plan({ reset: true }), 'reset');
  assert.equal(plan({ seeded: null }), 'seed');
  assert.equal(plan({ databaseExists: false }), 'seed');
  assert.equal(plan({ seeded: '2026-03-17' }), 'refresh');
  assert.equal(plan({ seeded: '2026-03-17', keepData: true }), 'keep');
});

const MARKER_TEXT = 'Holdr demo data (synthetic). Safe to delete.\n';

/** A demo folder as the launcher leaves it: the marker, and a data folder with the API's files. */
function demoFolder(root, { marker = `${MARKER_TEXT}seeded 2026-03-18\n`, data = ['finance.db', 'finance.db-wal', 'agent-token', 'service-token'] } = {}) {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, DEMO_MARKER), marker);
  for (const name of data) fs.writeFileSync(path.join(root, 'data', name), 'synthetic');
  return root;
}

test('deletes a demo folder only when its marker is the demo\'s and it holds nothing else', () => {
  const dir = scratch();
  try {
    const root = demoFolder(path.join(dir, 'holdr-demo'));
    assert.equal(readDemoMarker(root), `${MARKER_TEXT}seeded 2026-03-18\n`);
    assert.equal(demoFolderProblem(root), null);
    // Explorer's and Finder's own files are fine; anything else beside the data folder, or in it, is not the demo's.
    fs.writeFileSync(path.join(root, 'desktop.ini'), '');
    fs.writeFileSync(path.join(root, '.DS_Store'), '');
    fs.writeFileSync(path.join(root, 'data', 'Thumbs.db'), '');
    assert.equal(demoFolderProblem(root), null);
    fs.writeFileSync(path.join(root, 'finance.db'), '');
    assert.match(demoFolderProblem(root), /an entry beside its data folder/);
    fs.rmSync(path.join(root, 'finance.db'));
    fs.mkdirSync(path.join(root, 'data', 'statements'));
    assert.match(demoFolderProblem(root), /not Holdr's/);
    fs.rmSync(path.join(root, 'data'), { recursive: true });
    assert.equal(demoFolderProblem(root), null);
    fs.writeFileSync(path.join(root, 'data'), '');
    assert.match(demoFolderProblem(root), /not a plain folder/);

    // The marker must be the demo's own file, word for word.
    const other = path.join(dir, 'other');
    fs.mkdirSync(other);
    assert.equal(readDemoMarker(other), null);
    for (const text of [`${MARKER_TEXT}seeded 2026-03-18\nnotes\n`, 'Holdr demo data (synthetic).\n', `${MARKER_TEXT.trimEnd()}\r\n`]) {
      fs.writeFileSync(path.join(other, DEMO_MARKER), text);
      assert.equal(readDemoMarker(other), null, JSON.stringify(text));
    }
    fs.rmSync(path.join(other, DEMO_MARKER));
    fs.mkdirSync(path.join(other, DEMO_MARKER));
    assert.equal(readDemoMarker(other), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('finds the demo folder a data folder is in, as written or through a link, and says why it is refused', () => {
  const dir = scratch();
  try {
    const root = demoFolder(path.join(dir, 'Holdr', 'holdr-demo'));
    for (const inside of [root, path.join(root, 'data'), path.join(root, 'data', 'not-yet', 'deeper')]) assert.equal(demoFolderAround(inside), root, inside);
    for (const outside of [path.join(dir, 'Holdr'), path.join(dir, 'Holdr', 'data'), path.join(dir, 'Holdr', 'holdr-demo-2', 'data')]) {
      assert.equal(demoFolderAround(outside), null, outside);
    }
    // A link to the demo's data folder is in the demo's folder too (a junction on Windows, which needs no rights).
    const link = path.join(dir, 'linked-data');
    fs.symlinkSync(path.join(root, 'data'), link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(fs.realpathSync.native(demoFolderAround(path.join(link, 'sub'))), fs.realpathSync.native(root));
    const message = demoFolderRefusal(path.join(root, 'data'), root);
    assert.match(message, /is in the demo's folder .* \(it holds \.holdr-demo\), and npm run demo deletes that folder/);
    assert.match(message, /leave out --data-dir and HOLDR_DATA_DIR/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('moves the demo folder aside before deleting it, so a failed delete never leaves it without its marker', () => {
  const dir = scratch();
  try {
    const root = demoFolder(path.join(dir, 'holdr-demo'));
    const aside = discardDemoFolder(root);
    assert.match(path.basename(aside), /^holdr-demo\.old-[0-9a-f]{8}$/);
    assert.equal(fs.existsSync(root), false);
    assert.equal(fs.existsSync(aside), false);

    // In use (Windows refuses to rename a folder with open files): nothing is deleted, and the start stops.
    demoFolder(root);
    const busy = Object.assign(new Error('busy'), { code: 'EBUSY' });
    let renames = 0;
    assert.throws(() => discardDemoFolder(root, { rename: () => { renames += 1; throw busy; }, attempts: 2 }),
      /could not be moved aside to make it again \(EBUSY\), so nothing was deleted/);
    assert.equal(renames, 2);
    assert.equal(readDemoMarker(root), `${MARKER_TEXT}seeded 2026-03-18\n`);
    assert.equal(fs.existsSync(path.join(root, 'data', 'finance.db')), true);

    // A delete that fails after the rename leaves the demo's path free and the renamed copy still marked.
    const reports = [];
    const stuck = discardDemoFolder(root, {
      remove: (target, options) => {
        if (path.basename(target) === 'data') throw Object.assign(new Error('in use'), { code: 'EPERM' });
        fs.rmSync(target, options);
      },
      report: (line) => reports.push(line),
    });
    assert.equal(fs.existsSync(root), false);
    assert.equal(readDemoMarker(stuck), `${MARKER_TEXT}seeded 2026-03-18\n`);
    assert.match(reports[0], /could not be deleted \(EPERM\); it still holds its \.holdr-demo marker/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the Windows advice for a folder others can read works in PowerShell: the user by SID, SYSTEM kept', { skip: process.platform !== 'win32' }, () => {
  const powershell = system32('WindowsPowerShell\\v1.0\\powershell.exe');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'));
  const powerShell = (script, extra = {}) => spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', env: { ...env, ...extra }, windowsHide: true });
  const verdict = (dir) => {
    const facts = parseWindowsAcl(powerShell(WINDOWS_ACL_SCRIPT, { HOLDR_PRIVATE_DIR: dir }).stdout);
    return { facts, verdict: privateDirVerdict({ platform: 'win32', ...facts }) };
  };
  const parent = scratch();
  try {
    // A folder that inherits read access for Users, as one copied to another drive does.
    assert.equal(spawnSync(system32('icacls.exe'), [parent, '/grant', `*${USERS}:(OI)(CI)R`], { windowsHide: true }).status, 0);
    const dir = path.join(parent, 'Holdr data');
    fs.mkdirSync(dir);
    assert.ok(verdict(dir).verdict.tighten?.includes(USERS));
    const result = powerShell(WINDOWS_PRIVATE_FOLDER_COMMAND.replace('<folder>', dir));
    assert.equal(result.status, 0, result.stderr);
    const after = verdict(dir);
    assert.equal(after.verdict, 'private');
    assert.deepEqual(new Set(after.facts.aces.map((ace) => ace.sid)), new Set([after.facts.user, SYSTEM]));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('requires Node.js 22, saying why', () => {
  assert.equal(supportedNode('22.23.2'), true);
  assert.equal(supportedNode('22.3.0'), true);
  assert.equal(supportedNode('22.2.0'), false);
  assert.equal(supportedNode('20.16.0'), false);
  assert.equal(supportedNode('21.7.0'), false);
  assert.equal(supportedNode('23.0.0'), false);
  assert.equal(supportedNode('24.1.0'), false);
  assert.equal(supportedNode('18.20.0'), false);
  assert.equal(nodeVersionProblem('22.11.0'), null);
  const problem = nodeVersionProblem('24.1.0');
  assert.match(problem, /Node\.js 22 \(22\.3 or a later 22\.x release\); this is Node\.js 24\.1\.0/);
  assert.match(problem, /better-sqlite3/);
  assert.match(problem, /npm ci/);
});
