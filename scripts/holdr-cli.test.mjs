import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cliEnv, dataFoldersIn, userDataDirToCreate } from './holdr-cli.mjs';

// scripts/holdr-cli.mjs: which folder `npm run holdr-user` creates (readable by the current user only) before the tool
// creates its database there, the data folder the tools get, and the demo's folder, which no tool opens. Nothing here
// creates a data folder or runs a tool.

const cwd = path.resolve('/work');
const env = { HOLDR_DATA_DIR: path.resolve('/data/holdr') };

test('holdr-user add creates the folder it is about to use, however that folder was chosen', () => {
  assert.equal(userDataDirToCreate(['add', 'alex'], env, cwd), env.HOLDR_DATA_DIR);
  assert.equal(userDataDirToCreate(['add', 'alex', '--data-dir', 'mine'], env, cwd), path.resolve(cwd, 'mine'));
  assert.equal(userDataDirToCreate(['--data-dir=mine', 'add', 'alex', '--password-stdin'], env, cwd), path.resolve(cwd, 'mine'));
  // holdr-user takes the last --data-dir, and a blank one means HOLDR_DATA_DIR.
  assert.equal(userDataDirToCreate(['add', 'alex', '--data-dir', 'one', '--data-dir', 'two'], env, cwd), path.resolve(cwd, 'two'));
  assert.equal(userDataDirToCreate(['add', 'alex', '--data-dir='], env, cwd), env.HOLDR_DATA_DIR);
  // A relative HOLDR_DATA_DIR resolves against the working folder, as the API resolves it.
  assert.equal(userDataDirToCreate(['add', 'alex'], { HOLDR_DATA_DIR: ' relative ' }, cwd), path.resolve(cwd, 'relative'));
});

test('nothing is created for other commands, help, or arguments holdr-user refuses', () => {
  for (const args of [['list'], ['passwd', 'alex'], ['remove', 'alex', '--yes'], [], ['add', 'alex', '--help'], ['-h', 'add', 'alex'],
    ['add', 'alex', '--data-dir'], ['alex', 'add'], ['add'], ['add', 'alex', '--bogus'],
    // What PowerShell's npm.ps1 passes on when input is piped: npm itself took the options, the folder is left over.
    ['add', 'alex', path.resolve('/data/elsewhere')]]) {
    assert.equal(userDataDirToCreate(args, env, cwd), null, args.join(' '));
  }
  assert.equal(userDataDirToCreate(['add', 'alex'], {}, cwd), null);
});

test('a hardened deployment reads holdr.conf only: .env is not loaded and no data folder is defaulted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdr-cli-'));
  try {
    const dotEnvFile = path.join(dir, '.env');
    fs.writeFileSync(dotEnvFile, 'HOLDR_DATA_DIR=/Users/sample/elsewhere\nHOLDR_SAMPLE=1\n');
    const hardened = cliEnv({ HOLDR_CONFIG: '/Users/sample/holdr.conf' }, { dotEnvFile, platform: 'darwin', exists: () => false });
    assert.deepEqual([hardened.env.HOLDR_DATA_DIR, hardened.env.HOLDR_SAMPLE, hardened.defaulted], [undefined, undefined, false]);
    const plain = cliEnv({}, { dotEnvFile, platform: 'darwin', exists: () => false });
    assert.deepEqual([plain.env.HOLDR_DATA_DIR, plain.env.HOLDR_SAMPLE, plain.defaulted], ['/Users/sample/elsewhere', '1', false]);
    // Without a setting, the tools default to start:local's per-user folder; the environment wins over .env.
    const missing = path.join(dir, 'no.env');
    const defaulted = cliEnv({ LOCALAPPDATA: 'C:\\Local' }, { dotEnvFile: missing, platform: 'win32', exists: () => false });
    assert.deepEqual([defaulted.env.HOLDR_DATA_DIR, defaulted.defaulted], ['C:\\Local\\Holdr\\data', true]);
    const set = cliEnv({ HOLDR_DATA_DIR: 'D:\\holdr' }, { dotEnvFile, platform: 'win32', exists: () => false });
    assert.deepEqual([set.env.HOLDR_DATA_DIR, set.env.HOLDR_SAMPLE, set.defaulted], ['D:\\holdr', '1', false]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('passes HOLDR_DATA_DIR on absolute and normal, the form holdr-backup requires, unless holdr.conf decides it', () => {
  const dotEnvFile = path.join(os.tmpdir(), 'holdr-cli-test-no-such.env');
  const on = (platform, cwd) => (value, extra = {}) => cliEnv({ HOLDR_DATA_DIR: value, ...extra }, { dotEnvFile, platform, exists: () => false, cwd }).env.HOLDR_DATA_DIR;
  const windows = on('win32', 'C:\\work');
  assert.equal(windows('D:\\HoldrData\\'), 'D:\\HoldrData');
  assert.equal(windows('D:/HoldrData/sub/'), 'D:\\HoldrData\\sub');
  assert.equal(windows(' data '), 'C:\\work\\data');
  assert.equal(windows('\\\\server\\share\\holdr\\'), '\\\\server\\share\\holdr');
  const mac = on('darwin', '/work');
  assert.equal(mac('/Users/sample/Holdr/data/'), '/Users/sample/Holdr/data');
  assert.equal(mac('data//here/'), '/work/data/here');
  assert.equal(mac('data/', { HOLDR_CONFIG: '/Users/sample/holdr.conf' }), 'data/');
});

test('names every data folder a tool may open: HOLDR_DATA_DIR, --data-dir and the folder of --db', () => {
  const cwd = path.resolve('/work');
  assert.deepEqual(dataFoldersIn(['plan', '--db', 'data/finance.db', '--input', 'in.json'], { HOLDR_DATA_DIR: path.resolve('/holdr') }, cwd),
    [path.resolve('/holdr'), path.resolve(cwd, 'data')]);
  assert.deepEqual(dataFoldersIn(['add', 'alex', '--data-dir=mine', '--db=other/finance.db', '--data-dir', 'mine'], {}, cwd),
    [path.resolve(cwd, 'mine'), path.resolve(cwd, 'other')]);
  assert.deepEqual(dataFoldersIn(['--data-dir=', '--db'], { HOLDR_DATA_DIR: ' ' }, cwd), []);
});

test('no tool opens a data folder in the demo\'s folder: npm run demo deletes it when it makes the demo again', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdr-cli-'));
  try {
    const demo = path.join(dir, 'holdr-demo');
    const data = path.join(demo, 'data');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(demo, '.holdr-demo'), 'Holdr demo data (synthetic). Safe to delete.\n');
    const script = fileURLToPath(new URL('./holdr-cli.mjs', import.meta.url));
    for (const [args, env] of [
      [['apps/api/src/cli/holdrBackupMain.ts'], { HOLDR_DATA_DIR: data }],
      [['apps/api/src/cli/holdrUserMain.ts', 'add', 'alex', '--data-dir', path.join(data, 'mine')], {}],
      [['apps/api/src/cli/checkingMain.ts', 'plan', '--db', path.join(data, 'finance.db')], {}],
    ]) {
      const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true });
      assert.equal(result.status, 1, `${args.join(' ')}: ${result.stderr}`);
      assert.match(result.stderr, /is in the demo's folder .* npm run demo deletes that folder/);
    }
    assert.deepEqual(fs.readdirSync(data), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
