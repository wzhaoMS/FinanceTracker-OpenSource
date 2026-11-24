import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';

import { ConfigError } from '../lib/config.mjs';
import { HoldrApiError, LISTENER_CHECK_TTL_MS, READ_ROUTES, createHoldrApi } from '../lib/holdr-api.mjs';
import { checkListener } from '../lib/listener.mjs';
import { OWN_LISTENER, REPO_ROOT, SERVICE_TOKEN, TOKEN, closedPort, startFakeHoldr, tempDir, writeToken } from './helpers.mjs';

const code = (expected) => (error) => error instanceof HoldrApiError && error.code === expected;
const source = (...parts) => fs.readFileSync(path.join(REPO_ROOT, ...parts), 'utf8');
/** A client that finds this account's program on Holdr's port, as most tests need; `options` override. */
const clientFor = (t, options) => {
  const api = createHoldrApi({ listenerCheck: OWN_LISTENER, ...options });
  t.after(() => api.close());
  return api;
};

/** The quoted paths of `export const AGENT_READ_ROUTES ... = Object.freeze([ ... ])` in the API's agent scope, comments left out. */
function agentRoutesIn(text) {
  const start = text.indexOf('export const AGENT_READ_ROUTES');
  assert.notEqual(start, -1, 'AGENT_READ_ROUTES is in the source');
  const body = text.slice(text.indexOf('[', start), text.indexOf(']);', start)).replace(/\/\/[^\n]*/g, '');
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

test('every read route is on Holdr\'s reviewed agent list, which Holdr enforces before any route runs (checked in the API source)', () => {
  const scope = source('apps', 'api', 'src', 'auth', 'agentScope.ts');
  const agentRoutes = agentRoutesIn(scope);
  assert.ok(agentRoutes.length > 20 && agentRoutes.includes('/health'), 'the list was read');
  assert.match(scope, /const READ_METHODS = new Set\(\['GET', 'HEAD'\]\);/);
  assert.match(source('apps', 'api', 'src', 'auth', 'http.ts'), /const refusal = agentRefusal\(req\.method, req\.path\);/);
  for (const route of READ_ROUTES) {
    assert.ok(agentRoutes.includes(route), `${route} is on the agent list`);
    assert.ok(!['amazon', 'retail', 'card-sync', 'card-imports', 'release', 'export', 'auth'].includes(route.split('/')[1]), route);
  }
});

test('the client can only GET the read routes: no other route and no other method exist', async (t) => {
  const holdr = await startFakeHoldr(t);
  const api = clientFor(t, { appUrl: holdr.url, tokenFile: writeToken(tempDir(t)) });
  assert.deepEqual(Object.keys(api).sort(), ['close', 'get', 'origin', 'verifyListener']);
  for (const route of ['/card-imports/preview', '/card-imports/commit', '/accounts/x/transactions', '/export', '/amazon/summary', 'http://192.0.2.5/health']) {
    await assert.rejects(api.get(route), /not a read route/);
  }
  assert.equal(holdr.requests.length, 0);
  assert.deepEqual(await api.get('/card-accounts'), { cardAccounts: holdr.state.data.cardAccounts });
  for (const appUrl of ['http://192.0.2.5:4000', 'https://127.0.0.1:4000', 'http://localhost:4000', 'http://[::1]:4000']) {
    assert.throws(() => createHoldrApi({ appUrl, tokenFile: 'x' }), ConfigError, appUrl);
  }
});

test('the service token is never sent: a token file holding it is refused before anything connects', async (t) => {
  const holdr = await startFakeHoldr(t, { token: SERVICE_TOKEN });
  let checks = 0;
  const api = clientFor(t, { appUrl: holdr.url, tokenFile: writeToken(tempDir(t), SERVICE_TOKEN), listenerCheck: async () => { checks += 1; return OWN_LISTENER(); } });
  await assert.rejects(api.get('/health'), (error) => code('token-is-service')(error) && !error.message.includes(SERVICE_TOKEN));
  assert.equal(holdr.requests.length, 0);
  assert.equal(checks, 0, 'no token, no listener check either');
});

test('query values are encoded, and empty ones are left out', async (t) => {
  const holdr = await startFakeHoldr(t);
  const api = clientFor(t, { appUrl: holdr.url, tokenFile: writeToken(tempDir(t)) });
  await api.get('/card-transactions', { q: 'Café & Bar #1', merchant: undefined, owner: null, category: '', limit: 5 });
  const [request] = holdr.requests;
  assert.deepEqual(request.query, { q: 'Café & Bar #1', limit: '5' });
  assert.doesNotMatch(request.url, /[ #&]Bar|é/);
});

test('Holdr\'s refusals become clear errors; its own short messages are kept, long numbers never', async (t) => {
  const holdr = await startFakeHoldr(t);
  const api = clientFor(t, { appUrl: holdr.url, tokenFile: writeToken(tempDir(t)) });
  const answer = (status, body) => { holdr.state.routes['/spending/summary'] = { status, body }; };
  answer(400, { error: 'from must not be after to' });
  await assert.rejects(api.get('/spending/summary'), (error) => code('bad-request')(error) && error.message === 'Holdr did not accept the request: from must not be after to');
  answer(400, { error: 'account 123456789012 is odd' });
  await assert.rejects(api.get('/spending/summary'), (error) => code('bad-request')(error) && !error.message.includes('123456789012'));
  answer(403, { error: 'the agent token may not read this route', code: 'agent-route-not-allowed' });
  await assert.rejects(api.get('/spending/summary'), (error) => code('forbidden')(error) && /for the agent token \(the agent token may not read this route\)/.test(error.message));
  answer(404, { error: 'card account not found' });
  await assert.rejects(api.get('/spending/summary'), (error) => code('not-found')(error) && error.message === 'Holdr: card account not found');
  answer(404, { error: 'not-found' });
  await assert.rejects(api.get('/spending/summary'), (error) => code('version-mismatch')(error) && /has no \/spending\/summary route/.test(error.message));
  answer(409, { error: 'the metals ledger on this Holdr holds a correction', reason: 'correction-unsupported' });
  await assert.rejects(api.get('/spending/summary'), code('conflict'));
  answer(422, { error: 'card data', paths: ['query.q'] });
  await assert.rejects(api.get('/spending/summary'), (error) => code('card-data-refused')(error) && /search with other words/.test(error.message));
  answer(503, { error: 'ingress-unverified' });
  await assert.rejects(api.get('/spending/summary'), (error) => code('api-unavailable')(error) && /hardened macOS deployment/.test(error.message));
  answer(500, { error: 'Internal server error' });
  await assert.rejects(api.get('/spending/summary'), (error) => code('api-error')(error) && /answered 500/.test(error.message));
  holdr.state.routes['/spending/summary'] = undefined;
  holdr.state.routes['/health'] = () => 'just text';
  await assert.rejects(api.get('/health'), code('version-mismatch'));
  const otherToken = `holdr_agent_${'cd'.repeat(32)}`;
  const other = clientFor(t, { appUrl: holdr.url, tokenFile: writeToken(tempDir(t), otherToken) });
  await assert.rejects(other.get('/accounts'), (error) => code('token-rejected')(error) && /refused the agent token/.test(error.message)
    && !error.message.includes(otherToken));
});

test('a Holdr that does not answer in time, an oversized answer, and a cancelled request each end cleanly', async (t) => {
  const holdr = await startFakeHoldr(t);
  const tokenFile = writeToken(tempDir(t));
  const slow = clientFor(t, { appUrl: holdr.url, tokenFile, timeoutMs: 100 });
  holdr.state.delay = 400;
  await assert.rejects(slow.get('/health'), (error) => code('api-timeout')(error) && /did not answer \/health within/.test(error.message));
  const controller = new AbortController();
  const pending = slow.get('/health', {}, { signal: controller.signal, timeoutMs: 5_000 });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, code('cancelled'));
  holdr.state.delay = 0;
  const small = clientFor(t, { appUrl: holdr.url, tokenFile, maxBytes: 1024 });
  await assert.rejects(small.get('/transactions'), code('too-large'));
});

/** A listener check that answers `result` and counts its calls. */
function fakeCheck(result) {
  const check = async (port) => {
    check.ports.push(port);
    return typeof result === 'function' ? result() : result;
  };
  check.ports = [];
  return check;
}

test('the token goes only to a program of this account: another account\'s listener, or one that cannot be checked, gets nothing', async (t) => {
  const holdr = await startFakeHoldr(t);
  const tokenFile = writeToken(tempDir(t));
  const refusals = [
    [{ state: 'other', pids: [4242] }, 'listener-not-yours', /^the program listening on 127\.0\.0\.1:\d+ runs under another account on this computer, so this server sent it nothing: start your Holdr there/],
    [{ state: 'unknown', pids: [4242] }, 'listener-unverified', /^could not confirm that the program listening on 127\.0\.0\.1:\d+ runs under your account \(.*started as administrator/],
    [{ state: 'failed', reason: 'lsof could not list the listening programs' }, 'listener-unverified', /^could not confirm .* \(lsof could not list the listening programs\), so this server sent it nothing/],
    // Something accepts connections that the check cannot see: another account's program, as lsof shows it on macOS.
    [{ state: 'none', pids: [] }, 'listener-unverified', /\(this account cannot see it, so it most likely runs under another account\)/],
  ];
  for (const [result, expected, message] of refusals) {
    const check = fakeCheck(result);
    const api = clientFor(t, { appUrl: holdr.url, tokenFile, listenerCheck: check });
    await assert.rejects(api.get('/health'), (error) => code(expected)(error) && message.test(error.message) && !error.message.includes(TOKEN), result.state);
    await assert.rejects(api.verifyListener(), code(expected), 'a refusal is never remembered as a pass');
    assert.deepEqual(check.ports, [holdr.port, holdr.port]);
  }
  assert.equal(holdr.requests.length, 0, 'not one request reached the listener');
});

test('nothing listening is "Holdr is not running"; the probe that tells it apart only connects, and sends nothing', async (t) => {
  const port = await closedPort();
  const api = clientFor(t, { appUrl: `http://127.0.0.1:${port}`, tokenFile: writeToken(tempDir(t)), listenerCheck: fakeCheck({ state: 'none', pids: [] }) });
  await assert.rejects(api.get('/health'), (error) => code('api-unreachable')(error) && /Holdr is not running at http:\/\/127\.0\.0\.1:\d+/.test(error.message));

  // A listener the check cannot see: the probe connects and hangs up without a byte.
  const received = [];
  const hidden = net.createServer((socket) => socket.on('data', (chunk) => received.push(chunk)));
  await new Promise((resolve) => hidden.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => hidden.close(resolve)));
  const unseen = clientFor(t, {
    appUrl: `http://127.0.0.1:${hidden.address().port}`, tokenFile: writeToken(tempDir(t)), listenerCheck: fakeCheck({ state: 'none', pids: [] }),
  });
  await assert.rejects(unseen.get('/health'), code('listener-unverified'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(received, []);
});

test('a passed check holds for a while, is shared by requests waiting for it, and is repeated after a lost connection', async (t) => {
  const holdr = await startFakeHoldr(t);
  let clock = 1_000_000;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const check = fakeCheck(async () => {
    await gate;
    return { state: 'yours', pids: [process.pid] };
  });
  const api = clientFor(t, { appUrl: holdr.url, tokenFile: writeToken(tempDir(t)), listenerCheck: check, now: () => clock });
  const waiting = Promise.all([api.get('/health'), api.get('/accounts'), api.get('/card-accounts')]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(holdr.requests.length, 0, 'nothing is sent before the check passes');
  release();
  await waiting;
  assert.equal(check.ports.length, 1, 'three requests, one check');
  assert.deepEqual(await api.verifyListener(), { pids: [process.pid] });
  clock += LISTENER_CHECK_TTL_MS - 1;
  await api.get('/health');
  assert.equal(check.ports.length, 1);
  clock += 1;
  await api.get('/health');
  assert.equal(check.ports.length, 2, 'checked again once it is old');

  // Holdr stops: the failed request forgets the check, so whatever listens next is checked before it gets the token.
  const moved = clientFor(t, { appUrl: `http://127.0.0.1:${await closedPort()}`, tokenFile: writeToken(tempDir(t)), listenerCheck: check, now: () => clock });
  await assert.rejects(moved.get('/health'), code('api-unreachable'));
  await assert.rejects(moved.get('/health'), code('api-unreachable'));
  assert.equal(check.ports.length, 4, 'each attempt after a lost connection checks again');
});

test('a cancelled request does not wait for the check, and the check still serves the next request', async (t) => {
  const holdr = await startFakeHoldr(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const check = fakeCheck(async () => {
    await gate;
    return { state: 'yours', pids: [] };
  });
  const api = clientFor(t, { appUrl: holdr.url, tokenFile: writeToken(tempDir(t)), listenerCheck: check });
  const controller = new AbortController();
  const pending = api.get('/health', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, code('cancelled'));
  release();
  assert.equal((await api.get('/health')).service, 'holdr-api');
  assert.equal(check.ports.length, 1);
  assert.equal(holdr.requests.length, 1);
});

test('the real check finds this process listening on 127.0.0.1 and says it runs as this account', { skip: !['win32', 'darwin', 'linux'].includes(process.platform) }, async (t) => {
  const holdr = await startFakeHoldr(t);
  const result = await checkListener(holdr.port);
  assert.equal(result.state, 'yours', JSON.stringify(result));
  if (process.platform !== 'linux') assert.deepEqual(result.pids, [process.pid]);
  const api = createHoldrApi({ appUrl: holdr.url, tokenFile: writeToken(tempDir(t)) });
  t.after(() => api.close());
  assert.equal((await api.get('/health')).service, 'holdr-api');
  assert.equal(holdr.requests[0].headers.authorization, `Bearer ${TOKEN}`);
});

test('requests go straight to Holdr, never through a proxy named in the environment', async (t) => {
  const holdr = await startFakeHoldr(t);
  const saved = { HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy, NO_PROXY: process.env.NO_PROXY };
  process.env.HTTP_PROXY = 'http://192.0.2.1:3128';
  process.env.http_proxy = 'http://192.0.2.1:3128';
  delete process.env.NO_PROXY;
  t.after(() => { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  const api = clientFor(t, { appUrl: holdr.url, tokenFile: writeToken(tempDir(t)), timeoutMs: 2_000 });
  assert.equal((await api.get('/health')).service, 'holdr-api');
  assert.equal(holdr.requests[0].headers.authorization, `Bearer ${TOKEN}`);
});
