import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import * as cardSync from '../../card-sync/lib/config.mjs';
import {
  ConfigError, DEFAULT_APP_URL, DEMO_APP_URL, demoDataDir, loopbackApiOrigin, parseArgs, resolveConfig, startLocalDataDir,
} from '../lib/config.mjs';
import { HoldrApiError, readAgentToken } from '../lib/holdr-api.mjs';
import { SERVICE_TOKEN, TOKEN, tempDir, writeToken } from './helpers.mjs';

const outcome = (check, value) => {
  try {
    return { ok: check(value) };
  } catch (error) {
    return { refused: error.name };
  }
};

test('the Holdr URL must be plain HTTP on 127.0.0.1: exactly the card sync agent\'s rule', () => {
  const allowed = ['http://127.0.0.1:4000', 'http://127.0.0.1:4001/', 'http://127.0.0.1'];
  // localhost and [::1] too: Node may try ::1 first, where Holdr does not listen but another program could.
  const refused = [
    'https://127.0.0.1:4000', 'http://192.0.2.5:4000', 'http://203.0.113.9', 'http://example.com:4000', 'http://localhost.example.com:4000',
    'http://127.0.0.2:4000', 'http://0.0.0.0:4000', 'http://user:pw@127.0.0.1:4000', 'http://127.0.0.1:4000/api', 'http://127.0.0.1:4000/?x=1',
    'http://127.0.0.1:4000/#x', 'ftp://127.0.0.1', 'not a url', '', 'http://localhost:4000', 'http://[::1]:4000', 'http://LOCALHOST:4000',
  ];
  for (const value of allowed) {
    assert.deepEqual(outcome(loopbackApiOrigin, value), { ok: new URL(value).origin }, value);
  }
  for (const value of refused) {
    assert.deepEqual(outcome(loopbackApiOrigin, value), { refused: 'ConfigError' }, value);
  }
  for (const value of [...allowed, ...refused]) {
    const ours = outcome(loopbackApiOrigin, value);
    const theirs = outcome(cardSync.loopbackApiOrigin, value);
    assert.deepEqual('ok' in ours, 'ok' in theirs, `same decision for ${value}`);
    if ('ok' in ours) assert.equal(ours.ok, theirs.ok);
  }
  assert.throws(() => resolveConfig({ argv: ['--app-url', 'http://192.0.2.5:4000'], env: {} }), (error) => error instanceof ConfigError && /--app-url must be http:\/\/127\.0\.0\.1/.test(error.message));
  assert.throws(() => resolveConfig({ argv: [], env: { HOLDR_APP_URL: 'https://holdr.example.ts.net' } }), /HOLDR_APP_URL must be/);
});

const windows = { platform: 'win32', homedir: 'C:\\Users\\you', cwd: 'C:\\Users\\you\\src\\holdr', repoRoot: 'C:\\Users\\you\\src\\holdr' };
const mac = { platform: 'darwin', homedir: '/Users/you', cwd: '/Users/you/src/holdr', repoRoot: '/Users/you/src/holdr' };
const nothing = () => false;

test('the data folder is found as the card sync agent finds it, and the token file is its agent-token, on Windows and macOS', () => {
  const winEnv = { LOCALAPPDATA: 'C:\\Users\\you\\AppData\\Local' };
  const win = resolveConfig({ ...windows, argv: [], env: winEnv, exists: nothing });
  assert.equal(win.dataDir, 'C:\\Users\\you\\AppData\\Local\\Holdr\\data');
  assert.equal(win.tokenFile, 'C:\\Users\\you\\AppData\\Local\\Holdr\\data\\agent-token');
  assert.equal(win.tokenSource, 'the npm run start:local data folder');
  assert.equal(win.appUrl, DEFAULT_APP_URL);
  const macConfig = resolveConfig({ ...mac, argv: [], env: {}, exists: nothing });
  assert.equal(macConfig.dataDir, '/Users/you/Library/Application Support/Holdr/data');
  assert.equal(macConfig.tokenFile, '/Users/you/Library/Application Support/Holdr/data/agent-token');
  const devFolder = '/Users/you/src/holdr/apps/api/data';
  const devOnly = (file) => file === `${devFolder}/service-token` || file === `${devFolder}/agent-token`;
  const devServiceOnly = (file) => file === `${devFolder}/service-token`;
  assert.equal(resolveConfig({ ...mac, argv: [], env: {}, exists: devOnly }).tokenFile, `${devFolder}/agent-token`);
  assert.equal(resolveConfig({ ...mac, argv: [], env: {}, exists: devServiceOnly }).tokenFile, `${devFolder}/agent-token`);
  assert.equal(resolveConfig({ ...mac, argv: [], env: { HOLDR_DATA_DIR: '/srv/holdr' }, exists: devOnly }).dataDir, '/srv/holdr');
  assert.equal(resolveConfig({ ...mac, argv: ['--data-dir', '~/elsewhere'], env: { HOLDR_DATA_DIR: '/srv/holdr' }, exists: nothing }).dataDir, '/Users/you/elsewhere');
  assert.equal(resolveConfig({ ...windows, argv: ['--data-dir=data'], env: winEnv, exists: nothing }).tokenFile, 'C:\\Users\\you\\src\\holdr\\data\\agent-token');
  // The agent token file can be named; the service token's settings are never read, so they cannot stand in for it.
  assert.equal(resolveConfig({ ...mac, argv: [], env: { HOLDR_AGENT_TOKEN_FILE: '/srv/agent-token' }, exists: nothing }).tokenFile, '/srv/agent-token');
  assert.equal(resolveConfig({ ...mac, argv: ['--token-file', '/c'], env: { HOLDR_AGENT_TOKEN_FILE: '/a' }, exists: nothing }).tokenFile, '/c');
  for (const env of [{ HOLDR_SERVICE_TOKEN_FILE: '/srv/service-token' }, { HOLDR_TOKEN_FILE: '/srv/service-token' }]) {
    assert.equal(resolveConfig({ ...mac, argv: [], env, exists: nothing }).tokenFile, '/Users/you/Library/Application Support/Holdr/data/agent-token');
  }

  // The card sync agent resolves the same data folder from the same inputs (its token is the service token next to ours).
  const cases = [
    [windows, [], winEnv, nothing],
    [mac, [], {}, nothing],
    [mac, [], {}, devOnly],
    [mac, [], {}, devServiceOnly],
    [mac, ['--data-dir', '/srv/holdr'], {}, nothing],
    [mac, [], { HOLDR_DATA_DIR: '/srv/holdr' }, nothing],
  ];
  for (const [where, argv, env, exists] of cases) {
    const ours = resolveConfig({ ...where, argv, env, exists });
    const theirs = cardSync.resolveConfig({ ...where, argv, env, exists, agentDir: path.join(where.repoRoot, 'agents', 'card-sync') });
    assert.equal(ours.dataDir, theirs.dataDir, JSON.stringify({ argv, env }));
    assert.equal(path.basename(theirs.tokenFile), 'service-token');
    assert.equal(ours.tokenFile, (where.platform === 'win32' ? path.win32 : path.posix).join(theirs.dataDir, 'agent-token'));
  }
  assert.equal(startLocalDataDir({ platform: 'win32', env: winEnv, homedir: 'C:\\Users\\you' }), cardSync.startLocalDataDir({ platform: 'win32', env: winEnv, homedir: 'C:\\Users\\you' }));
});

test('--demo: port 4001 and the demo\'s agent token, whatever this shell\'s Holdr variables say; flags still apply', () => {
  const env = {
    LOCALAPPDATA: 'C:\\Users\\you\\AppData\\Local', HOLDR_APP_URL: 'http://127.0.0.1:4000', HOLDR_DATA_DIR: 'C:\\real',
    HOLDR_AGENT_TOKEN_FILE: 'C:\\real\\agent-token',
  };
  const demo = resolveConfig({ ...windows, argv: ['--demo'], env, exists: nothing });
  assert.equal(demo.appUrl, DEMO_APP_URL);
  assert.equal(demo.dataDir, 'C:\\Users\\you\\AppData\\Local\\Holdr\\holdr-demo\\data');
  assert.equal(demo.tokenFile, 'C:\\Users\\you\\AppData\\Local\\Holdr\\holdr-demo\\data\\agent-token');
  assert.equal(demo.demo, true);
  assert.equal(resolveConfig({ ...mac, argv: ['--demo'], env: {}, exists: nothing }).tokenFile, '/Users/you/Library/Application Support/Holdr/holdr-demo/data/agent-token');
  assert.equal(demoDataDir({ platform: 'linux', env: {}, homedir: '/home/you' }), '/home/you/.local/share/holdr/holdr-demo/data');
  assert.equal(resolveConfig({ ...mac, argv: ['--demo', '--app-url', 'http://127.0.0.1:4555'], env: {}, exists: nothing }).appUrl, 'http://127.0.0.1:4555');
  assert.equal(resolveConfig({ ...mac, argv: ['--demo', '--token-file', '/t/agent-token'], env: {}, exists: nothing }).tokenFile, '/t/agent-token');
});

test('a demo folder named instead of its data folder: the data folder inside it is used', () => {
  const root = '/Users/you/Library/Application Support/Holdr/holdr-demo';
  const exists = (file) => file === `${root}/.holdr-demo`;
  const config = resolveConfig({ ...mac, argv: ['--data-dir', root], env: {}, exists });
  assert.equal(config.dataDir, `${root}/data`);
  assert.equal(config.tokenFile, `${root}/data/agent-token`);
});

test('options: unknown, repeated or empty ones are refused without echoing values; --check, --version, --help', () => {
  assert.throws(() => parseArgs(['--app-url']), /--app-url needs a value/);
  assert.throws(() => parseArgs(['--app-url=']), /--app-url needs a value/);
  assert.throws(() => parseArgs(['--data-dir', 'a', '--data-dir', 'b']), /--data-dir was given twice/);
  assert.throws(() => parseArgs(['--token=abcdef']), (error) => error instanceof ConfigError && !error.message.includes('abcdef'));
  assert.throws(() => parseArgs(['serve']), /options only/);
  assert.equal(resolveConfig({ ...mac, argv: ['--check'], env: {}, exists: nothing }).command, 'check');
  assert.equal(resolveConfig({ ...mac, argv: ['--version'], env: {}, exists: nothing }).command, 'version');
  assert.equal(resolveConfig({ ...mac, argv: ['-h', '--check'], env: {}, exists: nothing }).command, 'help');
  assert.equal(resolveConfig({ ...mac, argv: [], env: {}, exists: nothing }).command, 'serve');
  assert.throws(() => resolveConfig({ ...mac, argv: ['--data-dir', 'a\nb'], env: {}, exists: nothing }), /control character/);
});

test('the agent token file: missing, not a file, too large, malformed or a service token are clear errors that name no path', (t) => {
  const dir = tempDir(t);
  const code = (expected) => (error) => error instanceof HoldrApiError && error.code === expected && !error.message.includes(dir);
  assert.throws(() => readAgentToken(path.join(dir, 'nowhere', 'agent-token')), code('token-missing'));
  assert.throws(() => readAgentToken(path.join(dir, 'nowhere', 'agent-token')), /Holdr creates it in its data folder when it starts/);
  assert.throws(() => readAgentToken(dir), code('token-invalid'));
  const big = path.join(dir, 'big');
  fs.writeFileSync(big, 'a'.repeat(5000));
  assert.throws(() => readAgentToken(big), code('token-invalid'));
  assert.throws(() => readAgentToken(writeToken(path.join(dir, 'bad'), 'not-a-token')), code('token-invalid'));
  assert.throws(() => readAgentToken(writeToken(path.join(dir, 'upper'), TOKEN.toUpperCase())), code('token-invalid'));
  assert.throws(() => readAgentToken(writeToken(path.join(dir, 'bare'), TOKEN.slice('holdr_agent_'.length))), code('token-is-service'));
  // The service token is refused by what it holds, under any name: no fallback, no silent use.
  for (const name of ['service-token', 'agent-token']) {
    const file = writeToken(path.join(dir, `service-${name}`), SERVICE_TOKEN, name);
    assert.throws(() => readAgentToken(file), (error) => code('token-is-service')(error) && /service token, which can change data/.test(error.message)
      && !error.message.includes(SERVICE_TOKEN));
  }
  assert.equal(readAgentToken(writeToken(path.join(dir, 'good'))), TOKEN);
});
