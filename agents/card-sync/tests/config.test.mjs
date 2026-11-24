import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  ConfigError, DEFAULT_APP_URL, DEFAULT_PORT, DEFAULT_WEB_URL, PINNED_EXTENSION_ID, parseArgs, resolveConfig,
} from '../lib/config.mjs';
import { tempDir } from './helpers.mjs';

const none = () => false;
// Paths of a made-up computer, compared as that system compares them, without touching this one's disk (realpath: null).
const mac = { platform: 'darwin', homedir: '/Users/sample', cwd: '/Users/sample', repoRoot: '/Users/sample/src/holdr', agentDir: '/Users/sample/src/holdr/agents/card-sync', exists: none, realpath: null };
const win = { platform: 'win32', homedir: 'C:\\Users\\sample', cwd: 'C:\\Users\\sample', repoRoot: 'C:\\src\\Holdr', agentDir: 'C:\\src\\Holdr\\agents\\card-sync', exists: none, realpath: null };

test('safe defaults on macOS: loopback API, port 4401, the pinned extension ID, a private folder outside the checkout', () => {
  const config = resolveConfig({ ...mac, env: {} });
  assert.equal(config.command, 'start');
  assert.equal(config.port, DEFAULT_PORT);
  assert.equal(config.port, 4401);
  assert.equal(config.appUrl, DEFAULT_APP_URL);
  assert.equal(config.webUrl, DEFAULT_WEB_URL);
  assert.equal(config.webUrl, 'http://127.0.0.1:5173');
  assert.equal(config.extensionId, PINNED_EXTENSION_ID);
  assert.equal(config.importsDir, '/Users/sample/Holdr/imports');
  assert.equal(config.rawDir, '/Users/sample/Holdr/imports/raw');
  assert.equal(config.outboxDir, '/Users/sample/Holdr/imports/outbox');
  // Where `npm run start:local` keeps Holdr's data, unless only the `npm run dev` folder has a token.
  assert.equal(config.dataDir, '/Users/sample/Library/Application Support/Holdr/data');
  assert.equal(config.tokenFile, '/Users/sample/Library/Application Support/Holdr/data/service-token');
  const dev = resolveConfig({ ...mac, env: {}, exists: (file) => file === '/Users/sample/src/holdr/apps/api/data/service-token' });
  assert.equal(dev.tokenFile, '/Users/sample/src/holdr/apps/api/data/service-token');
  assert.equal(dev.tokenSource, 'the npm run dev data folder');
  assert.equal(resolveConfig({ ...mac, platform: 'linux', homedir: '/home/sample', env: { XDG_DATA_HOME: '/srv/sample-data' } }).tokenFile,
    '/srv/sample-data/holdr/data/service-token');
  assert.equal(config.pairingFile, '/Users/sample/src/holdr/agents/card-sync/extension/local-key.json');
  assert.equal(config.history, 12);
  assert.deepEqual({ ...config.ownerLabels }, { alex: 'Alex', casey: 'Casey', joint: 'Joint' });
});

test('Windows paths: drive letters, backslashes, ~\\ and relative values resolve with win32 rules on any host', () => {
  const config = resolveConfig({
    ...win,
    env: { HOLDR_IMPORTS: '~\\Holdr\\imports', HOLDR_DATA_DIR: 'D:\\Holdr\\data', HOLDR_EXTENSION_DIR: 'ext' },
  });
  assert.equal(config.importsDir, 'C:\\Users\\sample\\Holdr\\imports');
  assert.equal(config.rawDir, 'C:\\Users\\sample\\Holdr\\imports\\raw');
  assert.equal(config.outboxDir, 'C:\\Users\\sample\\Holdr\\imports\\outbox');
  assert.equal(config.tokenFile, 'D:\\Holdr\\data\\service-token');
  assert.equal(config.extensionDir, 'C:\\Users\\sample\\ext');
  assert.equal(config.pairingFile, 'C:\\Users\\sample\\ext\\local-key.json');
  assert.equal(resolveConfig({ ...win, env: {} }).importsDir, 'C:\\Users\\sample\\Holdr\\imports');
  assert.equal(resolveConfig({ ...win, env: { LOCALAPPDATA: 'C:\\Users\\sample\\AppData\\Local' } }).tokenFile,
    'C:\\Users\\sample\\AppData\\Local\\Holdr\\data\\service-token');
  assert.equal(resolveConfig({ ...win, env: { USERPROFILE: 'E:\\Profiles\\sample' } }).tokenFile, 'E:\\Profiles\\sample\\AppData\\Local\\Holdr\\data\\service-token');
  // Windows compares paths without regard to case: a folder in the checkout is refused however it is spelled.
  assert.throws(() => resolveConfig({ ...win, env: { HOLDR_IMPORTS: 'c:\\SRC\\holdr\\imports' } }), /outside the repository/);
  assert.throws(() => resolveConfig({ ...win, argv: ['--imports', 'C:\\'] }), /folder of its own/);
  assert.throws(() => resolveConfig({ ...win, argv: ['--imports', 'c:\\users\\SAMPLE'] }), /folder of its own/);
});

test('macOS ignores letter case as well: a checkout cloned straight into the home folder would hold ~/Holdr/imports', () => {
  // On a Mac's disk ~/holdr is the folder ~/Holdr: the default imports folder would be inside the checkout.
  const cloneAtHome = { ...mac, repoRoot: '/Users/sample/holdr', agentDir: '/Users/sample/holdr/agents/card-sync' };
  assert.throws(() => resolveConfig({ ...cloneAtHome, env: {} }),
    /the default imports folder, ~\/Holdr\/imports, is inside this repository checkout .*such as ~\/src\/holdr/);
  assert.throws(() => resolveConfig({ ...win, repoRoot: 'C:\\Users\\sample\\holdr', env: {} }), /the default imports folder/);
  assert.throws(() => resolveConfig({ ...mac, env: { HOLDR_IMPORTS: '/users/SAMPLE/SRC/Holdr/imports' } }), /HOLDR_IMPORTS must be outside the repository/);
  assert.throws(() => resolveConfig({ ...mac, env: { HOLDR_SYNC_LOG: '/Users/sample/SRC/HOLDR/receiver.log' } }), /HOLDR_SYNC_LOG must be outside the repository/);
  // Linux tells holdr and Holdr apart.
  assert.equal(resolveConfig({ ...cloneAtHome, platform: 'linux', homedir: '/home/sample', repoRoot: '/home/sample/holdr', env: {} }).importsDir,
    '/home/sample/Holdr/imports');
});

test('on this computer, a folder reached through a link (a junction on Windows) into the checkout is in the checkout', (t) => {
  const root = tempDir(t);
  const checkout = path.join(root, 'checkout');
  fs.mkdirSync(path.join(checkout, 'agents', 'card-sync'), { recursive: true });
  const link = path.join(root, 'link');
  fs.symlinkSync(checkout, link, process.platform === 'win32' ? 'junction' : 'dir');
  const here = { env: {}, homedir: path.join(root, 'home'), cwd: root, repoRoot: checkout, agentDir: path.join(checkout, 'agents', 'card-sync'), exists: none };
  assert.throws(() => resolveConfig({ ...here, argv: ['--imports', path.join(link, 'private', 'imports')] }), /--imports must be outside the repository/);
  assert.throws(() => resolveConfig({ ...here, argv: ['--log-file', path.join(link, 'receiver.log')] }), /--log-file must be outside the repository/);
  assert.equal(resolveConfig({ ...here, argv: ['--imports', path.join(root, 'imports')] }).importsDir, path.join(root, 'imports'));
});

test('flags override the environment, which overrides the defaults; the token file follows the documented order', () => {
  const env = {
    HOLDR_SYNC_PORT: '4500', HOLDR_APP_URL: 'http://127.0.0.1:4100', HOLDR_DATA_DIR: '/Users/sample/Holdr/data',
    HOLDR_SERVICE_TOKEN_FILE: '/Users/sample/Holdr/api-token', HOLDR_SYNC_HISTORY: '6', HOLDR_OWNER_LABELS: 'alex=Sam,joint=Household',
  };
  const fromEnv = resolveConfig({ ...mac, env });
  assert.equal(fromEnv.port, 4500);
  assert.equal(fromEnv.appUrl, 'http://127.0.0.1:4100');
  assert.equal(fromEnv.tokenFile, '/Users/sample/Holdr/api-token');
  assert.equal(fromEnv.tokenSource, 'HOLDR_SERVICE_TOKEN_FILE');
  assert.equal(fromEnv.history, 6);
  assert.deepEqual({ ...fromEnv.ownerLabels }, { alex: 'Sam', casey: 'Casey', joint: 'Household' });
  const fromFlags = resolveConfig({ ...mac, env: { ...env, HOLDR_TOKEN_FILE: '/Users/sample/t1' }, argv: ['--port=4600', '--token-file', '/Users/sample/t2', 'check'] });
  assert.equal(fromFlags.command, 'check');
  assert.equal(fromFlags.port, 4600);
  assert.equal(fromFlags.tokenFile, '/Users/sample/t2');
  assert.equal(resolveConfig({ ...mac, env: { ...env, HOLDR_TOKEN_FILE: '/Users/sample/t1' } }).tokenFile, '/Users/sample/t1');
  assert.equal(resolveConfig({ ...mac, env: { HOLDR_DATA_DIR: '/Users/sample/Holdr/data' } }).tokenFile, '/Users/sample/Holdr/data/service-token');
  assert.equal(resolveConfig({ ...mac, env: { HOLDR_EXTENSION_ID: 'a'.repeat(32) } }).extensionId, 'a'.repeat(32));
});

test('everything stays on this computer: the API only at http://127.0.0.1, and bad values are named, never echoed', () => {
  for (const value of ['https://127.0.0.1:4000', 'http://192.0.2.10:4000', 'http://holdr.example:4000', 'http://127.0.0.1:4000/api',
    'http://user:pw@127.0.0.1:4000', 'http://localhost:4000', 'http://[::1]:4000']) {
    assert.throws(() => resolveConfig({ ...mac, env: { HOLDR_APP_URL: value } }),
      (error) => error instanceof ConfigError && /must be http:\/\/127\.0\.0\.1:<port>|just the origin/.test(error.message), value);
  }
  // A browser opens the web address, so localhost stays allowed there (the demo is at http://localhost:5174).
  assert.equal(resolveConfig({ ...mac, env: { HOLDR_WEB_URL: 'http://localhost:5174' } }).webUrl, 'http://localhost:5174');
  for (const [env, pattern] of [
    [{ HOLDR_SYNC_PORT: '80' }, /HOLDR_SYNC_PORT must be a port/],
    [{ HOLDR_SYNC_PORT: '44O1' }, /port/],
    [{ HOLDR_EXTENSION_ID: 'not-an-id' }, /32-letter ID/],
    [{ HOLDR_SYNC_HISTORY: '0' }, /from 1 to 60/],
    [{ HOLDR_SYNC_HISTORY: '61' }, /from 1 to 60/],
    [{ HOLDR_OWNER_LABELS: 'someone=Name' }, /alex=Alex/],
    [{ HOLDR_WEB_URL: 'http://holdr.example' }, /http:\/\/ address on this computer/],
    [{ HOLDR_IMPORTS: '/Users/sample/src/holdr/agents/card-sync/imports' }, /outside the repository/],
    [{ HOLDR_IMPORTS: '/Users/sample/src' }, /folder of its own/],
  ]) {
    assert.throws(() => resolveConfig({ ...mac, env }), (error) => error instanceof ConfigError && pattern.test(error.message));
  }
  assert.equal(resolveConfig({ ...mac, env: { HOLDR_WEB_URL: 'https://holdr.example.test/app/' } }).webUrl, 'https://holdr.example.test/app');
  assert.throws(() => parseArgs(['--port']), /needs a value/);
  assert.throws(() => parseArgs(['--port', '1', '--port', '2']), /twice/);
  assert.throws(() => parseArgs(['--secret=hunter2']), (error) => !error.message.includes('hunter2'));
  assert.throws(() => parseArgs(['start', 'check']), /at most one command/);
  assert.equal(parseArgs(['outbox', '--clean']).switches.clean, true);
  assert.equal(parseArgs(['pair', '--help']).command, 'help');
});
