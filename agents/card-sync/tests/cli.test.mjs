// The receiver's commands, run as the auto-start task runs them: plain `node agents/card-sync/receiver.mjs`, no tsx flag.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import { codeBuild, nodeSupport, privacyAdvice } from '../lib/cli.mjs';
import { convertAmexStatements } from '../lib/convert.mjs';
import { outboxName, writeOutbox } from '../lib/outbox.mjs';
import { currentUserSid, SYSTEM_SID, system32 } from '../lib/private-fs.mjs';
import { AGENT_DIR, amexCsv, closedPort, readFixture, REPO_ROOT, startFakeHoldr, tempDir, writeToken } from './helpers.mjs';

const RECEIVER = path.join(AGENT_DIR, 'receiver.mjs');
const ACCOUNT = { id: 'card-1', issuer: 'amex', owner: 'casey', last5: '91005', currency: 'USD', status: 'active' };
const windows = process.platform === 'win32';
const icacls = (...args) => execFileSync(system32('icacls.exe'), [...args, '/q'], { windowsHide: true, stdio: 'ignore' });

/** Opens `dir` to other accounts: Everyone may read it (Windows), or mode 755. */
function loosen(dir) {
  if (windows) icacls(dir, '/grant', '*S-1-1-0:(OI)(CI)R');
  else fs.chmodSync(dir, 0o755);
}

async function environment(t, holdr, extra = {}) {
  const root = tempDir(t);
  const extensionDir = path.join(root, 'extension');
  fs.mkdirSync(extensionDir);
  // Never the default port: another receiver may be running on this computer.
  const env = {
    ...process.env, NODE_OPTIONS: '', HOLDR_SYNC_PORT: String(await closedPort()),
    HOLDR_IMPORTS: path.join(root, 'imports'), HOLDR_EXTENSION_DIR: extensionDir,
    HOLDR_APP_URL: holdr?.url ?? `http://127.0.0.1:${await closedPort()}`, HOLDR_TOKEN_FILE: writeToken(path.join(root, 'holdr-data')), ...extra,
  };
  return { root, env, extensionDir, importsDir: env.HOLDR_IMPORTS };
}

const run = (args, env) => spawnSync(process.execPath, [RECEIVER, ...args], { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 60_000 });
/** Like run, without blocking this process: the fake Holdr API it talks to lives here. */
const runAsync = (args, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [RECEIVER, ...args], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

test('help and configuration errors: exit 2, the problem named, never the value', () => {
  const help = run(['help'], { ...process.env, NODE_OPTIONS: '' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Commands:[\s\S]*pair[\s\S]*HOLDR_IMPORTS/);
  const bad = run(['--app-url', 'http://holdr.example.test:4000'], { ...process.env, NODE_OPTIONS: '' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /must be http:\/\/127\.0\.0\.1/);
  assert.equal(bad.stderr.includes('holdr.example.test'), false);
});

test('pair writes a private key file once, keeps it, and rotates it on request', async (t) => {
  const { env, extensionDir } = await environment(t, null);
  const first = run(['pair'], env);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Created the pairing key[\s\S]*reload the extension/);
  const key = JSON.parse(fs.readFileSync(path.join(extensionDir, 'local-key.json'), 'utf8')).pairingKey;
  assert.match(run(['pair'], env).stdout, /already paired/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(extensionDir, 'local-key.json'), 'utf8')).pairingKey, key);
  assert.match(run(['pair', '--rotate'], env).stdout, /new pairing key replaced/);
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(extensionDir, 'local-key.json'), 'utf8')).pairingKey, key);
  assert.match(run(['pair'], { ...env, HOLDR_EXTENSION_DIR: path.join(extensionDir, 'missing') }).stderr, /extension folder was not found/);
});

test('start: private folders, pairing, a value-free health check on 127.0.0.1, and a clear refusal when the port is taken', async (t) => {
  const holdr = await startFakeHoldr(t, { accounts: [ACCOUNT] });
  const { env, importsDir, extensionDir } = await environment(t, holdr);
  const port = Number(env.HOLDR_SYNC_PORT);
  // An imports folder other accounts can open is made private when the receiver starts, as check advises.
  fs.mkdirSync(importsDir);
  loosen(importsDir);
  const child = spawn(process.execPath, [RECEIVER], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 30_000;
  while (!/previews are on|not available yet/.test(output)) {
    assert.ok(Date.now() < deadline && child.exitCode === null, output);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(output, new RegExp(`listening on http://127\\.0\\.0\\.1:${port}`));
  assert.match(output, /created a new pairing key/);
  assert.match(output, /Holdr at .* is reachable \(schema 15\): previews are on/);
  for (const dir of ['raw', 'outbox']) assert.ok(fs.statSync(path.join(importsDir, dir)).isDirectory());
  assert.equal(JSON.parse(fs.readFileSync(path.join(extensionDir, 'local-key.json'), 'utf8')).receiverPort, port);
  const health = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/healthz' }, (response) => {
      let text = '';
      response.setEncoding('utf8').on('data', (chunk) => { text += chunk; }).on('end', () => resolve(JSON.parse(text)));
    }).on('error', reject);
  });
  assert.deepEqual(health, { ok: true, service: 'holdr-card-sync', protocol: 1, build: codeBuild() });
  assert.match(health.build, /^[0-9a-f]{16}$/);
  const second = await runAsync([], env);
  assert.equal(second.status, 1);
  assert.match(second.stdout, new RegExp(`port ${port} on 127\\.0\\.0\\.1 is in use`));
  if (process.platform === 'win32') assert.match(second.stdout, /stop it with: powershell -NoProfile -ExecutionPolicy Bypass -File agents\\card-sync\\install\\windows\\stop-receiver\.ps1/);
  if (process.platform === 'darwin') assert.match(second.stdout, /launchctl bootout gui\/\$\(id -u\)\/local\.holdr\.card-sync/);
  const check = await runAsync(['check'], env);
  assert.match(check.stdout, /note {5}Receiver port {5}a receiver is already running/);
  // The real lookup: the fake Holdr listens in this test's process, which runs under the same account.
  assert.match(check.stdout, /ok {7}Holdr API {9}http:\/\/127\.0\.0\.1:\d+ \(schema 15; run by your account, accepts the service token\)/);
  assert.ok(check.stdout.includes(`ok       Imports folder    ${importsDir} (private)`), check.stdout);
});

test('check accepts the private imports folder the README has you create, and says what to do about one others can open', async (t) => {
  const { env, importsDir } = await environment(t, null);
  fs.mkdirSync(importsDir);
  // README and docs/importing-data.md: full control for you and SYSTEM, nothing inherited, owned by you (or mode 700).
  if (windows) {
    const me = currentUserSid();
    icacls(importsDir, '/inheritance:r', '/grant:r', `*${me}:(OI)(CI)F`, `*${SYSTEM_SID}:(OI)(CI)F`);
    icacls(importsDir, '/setowner', `*${me}`);
  } else {
    fs.chmodSync(importsDir, 0o700);
  }
  const ready = run(['check'], env);
  assert.ok(ready.stdout.includes(`ok       Imports folder    ${importsDir} (private)`), ready.stdout);
  loosen(importsDir);
  const loose = run(['check'], env);
  const problem = windows ? 'other accounts have access' : 'mode 755 lets other accounts in';
  assert.ok(loose.stdout.includes(`PROBLEM  Imports folder    ${importsDir} (${problem}): ${privacyAdvice(problem, process.platform)}`), loose.stdout);
  assert.match(privacyAdvice(problem, process.platform), windows ? /^start the receiver, or restart it .*you and SYSTEM/ : /^run chmod 700 on it/);
});

test('check accepts the Node.js Holdr runs on, 22.3 or a later 22.x, and reports any other as a problem', () => {
  assert.deepEqual(['22.3.0', '22.23.2'].map((version) => nodeSupport(version)), ['ok', 'ok']);
  assert.deepEqual(['24.1.0', '26.0.0', '23.11.0', '22.2.0', '21.7.3', '20.19.5', '18.20.4'].map((version) => nodeSupport(version)),
    Array(7).fill('unsupported'));
});

test('check reports a receiver that runs other code (still running from before an update) as a problem, with how to stop it', async (t) => {
  for (const build of ['0123456789abcdef', undefined]) {
    // Only a stand-in that answers /healthz like a receiver, on a free port: no real receiver is involved.
    const stale = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'holdr-card-sync', protocol: 1, ...(build ? { build } : {}) }));
    });
    await new Promise((resolve) => stale.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => stale.close(resolve)));
    const { env } = await environment(t, null, { HOLDR_SYNC_PORT: String(stale.address().port) });
    const check = await runAsync(['check'], env);
    assert.equal(check.status, 1);
    assert.match(check.stdout, new RegExp(`PROBLEM {2}Receiver port {5}the receiver running on 127\\.0\\.0\\.1:${stale.address().port} was started from other code`));
    if (process.platform === 'win32') assert.match(check.stdout, /stop-receiver\.ps1, then start it again/);
  }
});

test('check names every problem plainly: no Holdr, no token, no pairing', async (t) => {
  const { env } = await environment(t, null, { HOLDR_TOKEN_FILE: '', HOLDR_DATA_DIR: path.join(REPO_ROOT, '..', 'no-such-holdr-data') });
  const check = run(['check'], env);
  assert.equal(check.status, 1);
  assert.match(check.stdout, /PROBLEM {2}Pairing key {7}missing: run the pair command/);
  assert.match(check.stdout, /PROBLEM {2}Service token .*was not found/);
  assert.match(check.stdout, /PROBLEM {2}Holdr API .*service token file was not found/);
  assert.match(check.stdout, /ok {7}Receiver port {5}127\.0\.0\.1:\d+ is free/);
  assert.match(check.stdout, /ok {7}Card-import tool {2}loads from packages\/shared\/src/);
});

test('outbox lists the waiting files with Holdr previews, and --clean deletes only those Holdr already holds', async (t) => {
  const holdr = await startFakeHoldr(t, { accounts: [ACCOUNT] });
  const { env, importsDir } = await environment(t, holdr);
  const outboxDir = path.join(importsDir, 'outbox');
  fs.mkdirSync(outboxDir, { recursive: true });
  const done = await convertAmexStatements({ csvTexts: [readFixture('amex-statement-synthetic.csv')], coverage: { start: '2026-07-15', end: '2026-08-14' } });
  const fresh = await convertAmexStatements({ csvTexts: [amexCsv([['08/20/2026', 'SAMPLE BOOKSHOP', '25.00', '320262320000000201']])], coverage: { start: '2026-08-15', end: '2026-09-10' } });
  const unknown = await convertAmexStatements({ csvTexts: [amexCsv([['08/01/2026', 'SAMPLE PHARMACY', '12.30', '320262130000000501']])], coverage: { start: '2026-07-15', end: '2026-08-14' } });
  writeOutbox(outboxDir, outboxName('91005', done.payload.coverage), done.json);
  writeOutbox(outboxDir, outboxName('91005', fresh.payload.coverage), fresh.json);
  writeOutbox(outboxDir, outboxName('42002', unknown.payload.coverage), unknown.json);
  for (const row of done.payload.rows) holdr.state.imported.add(row.externalIdHash ?? row.fingerprint);
  holdr.state.coverage = [{ cardAccountId: 'card-1', ranges: [{ start: '2026-01-01', end: '2026-08-31' }] }];

  const listing = await runAsync(['outbox'], env);
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /amex-91005-2026-07-15-to-2026-08-14\.json: 4 rows; 0 new, 4 already in Holdr \(nothing left to import: --clean deletes it\)/);
  assert.match(listing.stdout, /amex-91005-2026-08-15-to-2026-09-10\.json: 1 row; 1 new, 0 already in Holdr\r?\n/);
  assert.match(listing.stdout, /amex-42002-.*: 1 row; no Holdr card account for ··42002 yet/);
  assert.match(listing.stdout, /Import it in Holdr: Spending/);
  const cleaned = await runAsync(['outbox', '--clean'], env);
  assert.match(cleaned.stdout, /already in Holdr: deleted/);
  assert.match(cleaned.stdout, /1 file\(s\) deleted/);
  assert.deepEqual(fs.readdirSync(outboxDir).sort(), ['amex-42002-2026-07-15-to-2026-08-14.json', 'amex-91005-2026-08-15-to-2026-09-10.json']);
  assert.ok(holdr.requests.every((request) => request.method === 'GET' || request.path === '/card-imports/preview'));
});
