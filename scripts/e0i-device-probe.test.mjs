import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runDeviceProbe, validateDevicePlan } from './e0i-device-probe.mjs';
// P-NET: refuses any listener beyond 127.0.0.1 or ::1 in this process.
import './loopback-only.mjs';

const exec = promisify(execFile);
const RUN = 'a'.repeat(32);
const FRONT = 'https://holdr.test';
const DIRECT = 'http://127.0.0.1:4116';
const TOKEN = `hdv1_${'b'.repeat(64)}`;
const SECRET = 'PRIVATE_CANARY_PASSWORD';
const COOKIE = `__Host-holdr_session=${'c'.repeat(64)}`;
const identity = { ok: true, schemaVersion: 15, e2e: { runId: RUN, disposableDataDir: true } };
const reply = (value = { ok: true }, status = 200, headers = {}) => ({ status, headers, body: Buffer.from(JSON.stringify(value)) });
const step = (changes = {}) => ({
  phase: 'capabilities', target: 'front', method: 'GET', path: '/card-sync/capabilities',
  headers: { authorization: 'HoldrDevice {{device}}' }, expect: { status: 200 }, ...changes,
});
const plan = (...steps) => ({ format: 'holdr-device-probe/1', steps });
const settings = (steps, changes = {}) => ({ front: FRONT, direct: DIRECT, runId: RUN, plan: steps, secrets: { device: TOKEN }, output() {}, ...changes });

test('scripted pairing through commit and the AL2 negative phases keep every credential out of the transcript', async () => {
  const steps = plan(
    step({ phase: 'pairing', method: 'POST', path: '/auth/login', headers: {}, body: { username: 'synthetic', password: '{{password}}' },
      captureCookie: 'session', expect: { status: 200 } }),
    step({ phase: 'pairing', method: 'POST', path: '/card-sync/owner/pairings', headers: { cookie: '{{session}}', origin: '{{front}}', 'x-holdr-request': '1' },
      body: { bindingId: 'synthetic-binding' }, capture: { pairing: '/pairingId', code: '/code' } }),
    step({ phase: 'pairing', method: 'POST', path: '/card-sync/pairings/redeem', headers: { authorization: 'HoldrPair {{code}}' },
      body: { pairingId: '{{pairing}}' }, capture: { device: '/deviceToken', deviceId: '/deviceId' } }),
    step({ phase: 'approval', method: 'POST', path: '/card-sync/owner/devices/{{deviceId}}/approve', headers: { cookie: '{{session}}' }, body: {} }),
    step({ expect: { status: 200, json: { '/holdrOrigin': '{{front}}' } } }),
    step({ phase: 'observation', method: 'POST', path: '/card-sync/observations', body: '{{syntheticObservation}}', capture: { set: '/observationSetId' } }),
    step({ phase: 'preview', method: 'POST', path: '/card-sync/imports/preview', body: { observationSetId: '{{set}}' }, capture: { preview: '/planId' } }),
    step({ phase: 'commit', method: 'POST', path: '/card-sync/imports/commit', body: { planId: '{{preview}}' } }),
    step({ phase: 'direct-refusal', target: 'direct', expect: { status: 403, code: 'device-transport-refused' } }),
    step({ phase: 'cookie-refusal', headers: { authorization: 'HoldrDevice {{device}}', cookie: '{{session}}' }, expect: { status: 401, code: 'invalid-credentials' } }),
    step({ phase: 'owner-refusal', path: '/card-sync/owner/state', expect: { status: 401, code: 'invalid-credentials' } }),
    step({ phase: 'revocation', method: 'POST', path: '/card-sync/owner/devices/{{deviceId}}/revoke', headers: { cookie: '{{session}}' }, body: {} }),
    step({ phase: 'revoked-refusal', expect: { status: 401, code: 'unauthorized' } }),
    step({ phase: 'attestation-unverified', expect: { status: 503, code: 'ingress-unverified' } }),
    step({ phase: 'attestation-refused', expect: { status: 503, code: 'ingress-refused' } }),
    step({ phase: 'fence-refusal', expect: { status: 409, code: 'authorization-blocked' } }),
  );
  const responses = [
    reply(identity), reply(identity),
    reply({}, 200, { 'set-cookie': [`${COOKIE}; Path=/; Secure; HttpOnly; SameSite=Lax`] }),
    reply({ pairingId: 'pair_test', code: 'SYNTHETIC_PAIR_CODE' }),
    reply({ deviceToken: TOKEN, deviceId: 'dev_test' }), reply(),
    reply({ holdrOrigin: FRONT }), reply({ observationSetId: 'obs_test' }), reply({ planId: 'plan_test' }), reply(),
    reply({ error: 'device-transport-refused' }, 403), reply({ error: 'Invalid credentials' }, 401),
    reply({ error: 'Invalid credentials' }, 401), reply(), reply({ error: 'unauthorized' }, 401),
    reply({ error: 'ingress-unverified' }, 503), reply({ error: 'ingress-refused' }, 503),
    reply({ error: 'authorization-blocked' }, 409),
  ];
  const sent = [];
  const output = [];
  const state = await runDeviceProbe(settings(steps, {
    secrets: { password: SECRET, syntheticObservation: { synthetic: true } }, output: (entry) => output.push(entry),
  }), async (request) => { sent.push(request); return responses.shift(); });
  assert.equal(sent.length, steps.steps.length + 2);
  assert.equal(sent[0].headers, undefined);
  assert.equal(sent[1].headers, undefined);
  assert.equal(JSON.parse(sent[2].body).password, SECRET);
  assert.equal(sent[6].headers.authorization, `HoldrDevice ${TOKEN}`);
  assert.equal(sent[6].headers.cookie, undefined);
  assert.equal(sent[10].base, DIRECT);
  assert.equal(state.variables.device, TOKEN);
  assert.equal(state.variables.session, COOKIE);
  assert.equal(state.variables.password, undefined);
  assert.deepEqual(output.at(-1), { steps: steps.steps.length, code: 'probe-passed' });
  for (const privateValue of [TOKEN, SECRET, COOKIE, 'SYNTHETIC_PAIR_CODE', 'dev_test', FRONT]) {
    assert.equal(JSON.stringify(output).includes(privateValue), false);
  }
});

for (const broken of [
  { ok: true, schemaVersion: 15 }, { ...identity, e2e: { runId: 'b'.repeat(32), disposableDataDir: true } },
  { ...identity, e2e: { runId: RUN, disposableDataDir: false } }, { ...identity, extra: 'unknown' },
]) {
  test(`identity mismatch prevents every credential/mutating request (${JSON.stringify(broken.e2e ?? {})})`, async () => {
    const sent = [];
    await assert.rejects(runDeviceProbe(settings(plan(step())), async (request) => {
      sent.push(request); return reply(broken);
    }), /probe-identity/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, 'GET');
    assert.equal(sent[0].headers, undefined);
  });
}

test('the direct identity must match too, before a single authenticated request', async () => {
  const sent = [];
  await assert.rejects(runDeviceProbe(settings(plan(step())), async (request) => {
    sent.push(request); return reply(sent.length === 1 ? identity : { ...identity, e2e: { runId: RUN, disposableDataDir: false } });
  }), /probe-identity/);
  assert.equal(sent.length, 2);
  assert.ok(sent.every((request) => request.headers === undefined));
});

for (const value of [
  plan(step({ target: 'other' })), plan(step({ method: 'CONNECT' })), plan(step({ headers: { host: 'other.test' } })),
  plan(step({ target: 'direct', expect: { status: 200 } })), plan(step({ expect: { status: 302 } })),
  plan(step({ expect: { status: 401, code: TOKEN } })), plan(step({ extra: true })), { format: 'unknown', steps: [] },
]) test('unknown or unsafe plan schema is refused', () => assert.throws(() => validateDevicePlan(value), /probe-plan/));

for (const bad of ['https://other.test/card-sync/capabilities', '//other.test/card-sync/capabilities', '/card-sync/../auth/login', '/card-sync/%2e%2e/auth/login', '/.env', '/card-sync\\x', '/card-sync/x#fragment']) {
  test(`no base-origin escape or normalized path is sent (${bad})`, async () => {
    const sent = [];
    await assert.rejects(runDeviceProbe(settings(plan(step({ path: bad }))), async (request) => { sent.push(request); return reply(identity); }), /probe-path/);
    assert.equal(sent.length, 2);
  });
}

test('an unexpected error value cannot enter the codes-only transcript', async () => {
  const output = [];
  let count = 0;
  await assert.rejects(runDeviceProbe(settings(plan(step({ expect: { status: 409, code: 'authorization-blocked' } })), {
    output: (entry) => output.push(entry),
  }), async () => ++count <= 2 ? reply(identity) : reply({ error: TOKEN }, 409)), /probe-response/);
  assert.equal(JSON.stringify(output).includes(TOKEN), false);
  assert.equal(output.at(-1).code, 'unexpected-response');
});

test('CORS response assertions are exact and never print the returned origin', async () => {
  let count = 0;
  await assert.rejects(runDeviceProbe(settings(plan(step({
    phase: 'cors-allowed', method: 'OPTIONS',
    headers: { origin: 'chrome-extension://synthetic', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
    expect: { status: 200, headers: { 'access-control-allow-origin': 'chrome-extension://synthetic' } },
  }))), async () => ++count <= 2 ? reply(identity) : reply({}, 200, { 'access-control-allow-origin': '*' })), /probe-response/);
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts/e0i-device-probe.mjs');

async function servers(t, options = {}) {
  const dir = path.join(ROOT, `.i-device-probe-${randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'req.cnf');
  fs.writeFileSync(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n'
    + '[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n', { mode: 0o600 });
  const key = path.join(dir, 'key.pem');
  const ca = path.join(dir, 'cert.pem');
  await exec('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', key, '-out', ca, '-config', config], {
    cwd: dir, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: dir, RANDFILE: path.join(dir, '.rnd') },
  });
  const requests = [];
  const handler = (req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    if (options.fault && req.socket.encrypted) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'X-Holdr-Error': options.fault });
      res.end(JSON.stringify({ error: options.fault }));
    } else if (req.url === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(identity));
    } else if (options.redirect) {
      res.writeHead(302, { Location: 'https://should-never-be-contacted.invalid/card-sync/capabilities' }); res.end();
    } else if (options.hang) {
      // The absolute client deadline, not a fake transport, must end this response.
    } else if (options.large) {
      res.end(Buffer.alloc(2 * 1024 * 1024 + 1, 65));
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, receipt: TOKEN }));
    }
  };
  const direct = http.createServer(handler);
  const front = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(ca) }, handler);
  for (const [server, port] of [[direct, 4116], [front, 5316]]) {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  }
  const planFile = path.join(dir, 'plan.json');
  const secretsFile = path.join(dir, 'secrets.json');
  fs.writeFileSync(planFile, JSON.stringify(plan(step({ capture: { receipt: '/receipt' } }))), { mode: 0o600 });
  fs.writeFileSync(secretsFile, JSON.stringify({ device: TOKEN }), { mode: 0o600 });
  const args = ['--front', 'https://127.0.0.1:5316', '--direct', DIRECT, '--run-id', RUN, '--plan', planFile, '--secrets', secretsFile];
  const invoke = async (extra = [], env = {}, input) => {
    try {
      const pending = exec(process.execPath, [CLI, ...args, ...extra], {
        cwd: ROOT, timeout: 25_000, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: dir, ...env },
      });
      if (input !== undefined) pending.child.stdin.end(input);
      const result = await pending;
      return { ...result, code: 0 };
    } catch (error) { return error; }
  };
  return { dir, ca, args, invoke, requests, secretsFile, planFile };
}

test('the real CLI verifies TLS and synthetic identity, uses only real bindings, and writes private captured state', { skip: process.platform !== 'darwin' }, async (t) => {
  const f = await servers(t);
  const stateFile = path.join(f.dir, 'state.json');
  const run = await f.invoke(['--ca', f.ca, '--save-state', stateFile]);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.equal(run.stdout.includes(TOKEN), false);
  assert.equal(run.stdout.includes(f.dir), false);
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests.at(-1).authorization, `HoldrDevice ${TOKEN}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), {
    format: 'holdr-device-probe-state/1', runId: RUN,
    front: 'https://127.0.0.1:5316', direct: DIRECT, variables: { receipt: TOKEN },
  });
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
});

test('the real CLI never disables TLS verification, even if provider/force flags are offered through the environment', { skip: process.platform !== 'darwin' }, async (t) => {
  const f = await servers(t);
  const run = await f.invoke([], { HOLDR_DEVICE_PROBE_PROVIDER: 'verified', HOLDR_FORCE_VERIFIED: '1' });
  assert.equal(run.code, 1);
  assert.match(run.stderr, /^probe-tls\n$/);
  assert.equal(run.stdout.includes(TOKEN), false);
  assert.equal(f.requests.length, 0);
  const disabled = await f.invoke(['--ca', f.ca], { NODE_TLS_REJECT_UNAUTHORIZED: '0' });
  assert.equal(disabled.code, 1);
  assert.equal(disabled.stderr, 'probe-configuration\n');
  assert.equal(f.requests.length, 0);
});

test('the real CLI never follows a redirect or prints its destination', { skip: process.platform !== 'darwin' }, async (t) => {
  const f = await servers(t, { redirect: true });
  const run = await f.invoke(['--ca', f.ca]);
  assert.equal(run.code, 1);
  assert.equal(run.stderr, 'probe-redirect\n');
  assert.equal(run.stdout.includes('should-never'), false);
  assert.equal(run.stdout.includes(TOKEN), false);
  assert.equal(f.requests.length, 3);
});

test('the real CLI accepts bounded private stdin without echoing or saving the input', { skip: process.platform !== 'darwin' }, async (t) => {
  const f = await servers(t);
  const run = await f.invoke(['--ca', f.ca, '--secrets', '-'], {}, JSON.stringify({ device: TOKEN }));
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout.includes(TOKEN), false);
  assert.equal(f.requests.at(-1).authorization, `HoldrDevice ${TOKEN}`);
});

test('unsafe private input is refused before any request and unsupported provider flags are usage errors', { skip: process.platform !== 'darwin' }, async (t) => {
  const f = await servers(t);
  fs.chmodSync(f.secretsFile, 0o644);
  const unsafe = await f.invoke(['--ca', f.ca]);
  assert.equal(unsafe.code, 1);
  assert.equal(unsafe.stderr, 'probe-private-input\n');
  assert.equal(f.requests.length, 0);
  const badFlag = await f.invoke(['--provider', 'fake']);
  assert.equal(badFlag.code, 64);
  assert.equal(badFlag.stderr, 'E0I_DEVICE_PROBE_USAGE\n');
  assert.equal(f.requests.length, 0);
});

test('attestation faults remain probeable with a previously verified, origin-bound state, never with fresh unverified credentials', { skip: process.platform !== 'darwin' }, async (t) => {
  const options = {};
  const f = await servers(t, options);
  const stateFile = path.join(f.dir, 'state.json');
  assert.equal((await f.invoke(['--ca', f.ca, '--save-state', stateFile])).code, 0);
  options.fault = 'ingress-unverified';
  fs.writeFileSync(f.planFile, JSON.stringify(plan(step({
    phase: 'attestation-unverified', headers: { authorization: 'HoldrDevice {{receipt}}' },
    expect: { status: 503, code: 'ingress-unverified' },
  }))));
  const unsafe = await f.invoke(['--ca', f.ca]);
  assert.equal(unsafe.code, 1);
  assert.equal(unsafe.stderr, 'probe-identity\n');
  const start = f.requests.length;
  const known = await f.invoke(['--ca', f.ca, '--secrets', stateFile]);
  assert.equal(known.code, 0, known.stderr);
  assert.equal(f.requests.length - start, 3);
  assert.equal(f.requests.at(-1).authorization, `HoldrDevice ${TOKEN}`);
  assert.ok(known.stdout.includes('synthetic-bound-ingress-closed'));
  assert.equal(known.stdout.includes(TOKEN), false);
  const wrongOrigin = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  wrongOrigin.front = FRONT;
  fs.writeFileSync(stateFile, JSON.stringify(wrongOrigin));
  assert.equal((await f.invoke(['--ca', f.ca, '--secrets', stateFile])).stderr, 'probe-identity\n');
});

test('a real hung response is bounded by the independent absolute deadline', { skip: process.platform !== 'darwin', timeout: 30_000 }, async (t) => {
  const f = await servers(t, { hang: true });
  const run = await f.invoke(['--ca', f.ca]);
  assert.equal(run.code, 1);
  assert.equal(run.stderr, 'probe-timeout\n');
  assert.equal(run.stdout.includes(TOKEN), false);
});

test('a real oversized response is rejected without logging its body', { skip: process.platform !== 'darwin' }, async (t) => {
  const f = await servers(t, { large: true });
  const run = await f.invoke(['--ca', f.ca]);
  assert.equal(run.code, 1);
  assert.equal(run.stderr, 'probe-response-large\n');
  assert.equal(run.stdout.includes('AAAAA'), false);
});
