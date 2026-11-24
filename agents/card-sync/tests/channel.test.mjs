import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';

import {
  CHALLENGE_HEADER, CHANNEL_PREFIX, challengeRequestKey, createSecureClient, randomHex, signChallengeRequest,
} from '../extension/secure-channel.mjs';
import { createChannel, createReceiverServer, LISTEN_HOST, refusalLog } from '../lib/server.mjs';
import { AGENT_DIR } from './helpers.mjs';

const EXTENSION_ID = 'b'.repeat(32);
const ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const SECRET = 'SYNTHETIC EXPORT TEXT \u03b1 SAMPLE COFFEE BAR';

/** A request with exactly the headers given (fetch would set Host itself). */
function rawRequest(port, { method = 'GET', path: target, headers = {} }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path: target, headers, agent: false }, (response) => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode }));
    });
    request.on('error', reject);
    request.end();
  });
}

async function startReceiver(t, key, { dispatch, limits } = {}) {
  const calls = [];
  const events = [];
  const channel = createChannel({
    key,
    log: (event) => events.push(event),
    dispatch: dispatch ?? (async (request) => {
      calls.push({ ...request, body: Buffer.from(request.body).toString('utf8') });
      return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ echo: Buffer.from(request.body).toString('utf8') })) };
    }),
  });
  const receiver = createReceiverServer({ port: 0, extensionId: EXTENSION_ID, channel, log: (event) => events.push(event), ...(limits ? { limits } : {}) });
  const address = await receiver.listen();
  t.after(() => receiver.close());
  return { receiver, address, base: `http://127.0.0.1:${address.port}`, calls, events };
}

/** A challenge request as the extension signs it, here with any key, time and nonce. */
async function challengeBody(key, base, { at = Date.now(), nonce = randomHex() } = {}) {
  return { nonce, at, proof: await signChallengeRequest(await challengeRequestKey(key), { nonce, origin: base, at }) };
}
/**
 * POSTs a challenge request through `agent` (or a new connection) and answers its status. A browser opens at most a few
 * connections to one host; so does a bounded agent, whereas a burst of fetch calls would open one per request.
 */
function postChallenge(base, body, agent = false) {
  const { port } = new URL(base);
  const text = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port, method: 'POST', path: `${CHANNEL_PREFIX}/challenge`, agent,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) },
    }, (answer) => {
      answer.resume();
      answer.on('end', () => resolve(answer.statusCode));
    });
    request.on('error', reject);
    request.end(text);
  });
}

/** fetch as the browser sends it: the extension's Origin on every request. */
const asExtension = (wire = []) => async (url, init) => {
  wire.push({ url, init });
  return fetch(url, { ...init, headers: { ...init.headers, Origin: ORIGIN } });
};

test('the receiver listens on 127.0.0.1 only, and every listen in the agent names that address', async (t) => {
  assert.equal(LISTEN_HOST, '127.0.0.1');
  const { address } = await startReceiver(t, randomHex());
  assert.equal(address.address, '127.0.0.1');
  assert.equal(address.family, 'IPv4');
  const sources = ['lib', 'tests', 'extension'].flatMap((folder) => fs.readdirSync(path.join(AGENT_DIR, folder))
    .filter((name) => /\.(mjs|js)$/.test(name)).map((name) => path.join(AGENT_DIR, folder, name)));
  for (const file of sources) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/\.listen\(([^)\n][^\n]*)/g)) {
      assert.match(match[1], /^(?:port|0), (?:LISTEN_HOST|'127\.0\.0\.1')/, `${path.basename(file)}: ${match[0]}`);
    }
  }
});

test('a paired request and its answer travel sealed: neither the pairing key nor the export text is on the wire', async (t) => {
  const key = randomHex();
  const { base, calls } = await startReceiver(t, key);
  const wire = [];
  const client = createSecureClient({ base, getToken: () => key, fetchImpl: asExtension(wire) });
  const response = await client.request('POST', '/sync/amex/statement', { headers: { 'Content-Type': 'application/json' }, body: SECRET });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { echo: SECRET });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/sync/amex/statement');
  assert.equal(calls[0].contentType, 'application/json');
  assert.equal(calls[0].transportOrigin, ORIGIN);
  const captured = JSON.stringify(wire);
  assert.equal(captured.includes(key), false);
  assert.equal(captured.includes(SECRET), false);
  assert.equal(captured.includes('statement'), false, 'even the route is inside the envelope');
});

test('the transport origin is the real Origin header only: one written inside the envelope proves nothing', async (t) => {
  const key = randomHex();
  const { base, calls } = await startReceiver(t, key);
  const plain = createSecureClient({ base, getToken: () => key });
  await plain.request('POST', '/sync/claim', { headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(calls[0].transportOrigin, null);
});

test('a captured request cannot be replayed, altered, or carried over a receiver restart', async (t) => {
  const key = randomHex();
  const first = await startReceiver(t, key);
  const wire = [];
  const client = createSecureClient({ base: first.base, getToken: () => key, fetchImpl: asExtension(wire) });
  await client.request('POST', '/sync/stop', { headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const captured = wire.find((entry) => entry.url.endsWith('/request'));
  const replay = await fetch(captured.url, { ...captured.init, headers: { ...captured.init.headers, Origin: ORIGIN } });
  assert.equal(replay.status, 401);
  // Nor does asking again for a challenge with that nonce: without the pairing key no challenge is given at all.
  const envelope = JSON.parse(captured.init.body);
  assert.equal(await postChallenge(first.base, { nonce: envelope.nonce }), 401);
  assert.equal((await fetch(captured.url, { ...captured.init })).status, 401);
  assert.equal(first.calls.length, 1);

  const tampering = createSecureClient({
    base: first.base, getToken: () => key,
    fetchImpl: async (url, init) => {
      if (url.endsWith('/request')) {
        const body = JSON.parse(init.body);
        body.ciphertext = (body.ciphertext[0] === 'A' ? 'B' : 'A') + body.ciphertext.slice(1);
        return fetch(url, { ...init, body: JSON.stringify(body) });
      }
      return fetch(url, init);
    },
  });
  await assert.rejects(tampering.request('POST', '/sync/stop', { body: '{}' }), /request failed/);
  assert.equal(first.calls.length, 1);

  const second = await startReceiver(t, key);
  const moved = captured.url.replace(first.base, second.base);
  assert.equal((await fetch(moved, { ...captured.init })).status, 401);
  assert.equal(second.calls.length, 0);
});

test('a client with another key, or a fake listener without the key, gets nowhere and learns nothing', async (t) => {
  const key = randomHex();
  const { base, calls } = await startReceiver(t, key);
  // Another key's challenge request is refused before any challenge exists.
  await assert.rejects(createSecureClient({ base, getToken: () => randomHex() }).request('POST', '/sync/stop', { body: SECRET }),
    (error) => error.status === 401);
  assert.equal(calls.length, 0);
  const impostorWire = [];
  const impostor = createSecureClient({
    base, getToken: () => key,
    fetchImpl: async (url, init) => {
      impostorWire.push({ url, init });
      const { nonce } = JSON.parse(init.body);
      return Response.json({ nonce, ticket: randomHex(), instance: randomHex(), origin: base, expires: Date.now() + 30000, proof: 'AAAA' });
    },
  });
  await assert.rejects(impostor.request('POST', '/sync/amex/statement', { body: SECRET }), /authentication failed/);
  assert.equal(impostorWire.length, 1, 'only the challenge was sent');
  assert.equal(JSON.stringify(impostorWire).includes(key), false);
  assert.equal(JSON.stringify(impostorWire).includes(SECRET), false);
  assert.throws(() => createSecureClient({ base: 'https://receiver.example.test', getToken: () => key }), /loopback/);
  assert.throws(() => createSecureClient({ base: 'http://192.0.2.1:4401', getToken: () => key }), /loopback/);
});

test('the listener refuses foreign Host and Origin headers, keeps every receiver route inside the channel, and limits bodies', async (t) => {
  const key = randomHex();
  const { base, address, calls } = await startReceiver(t, key);
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: 'holdr-card-sync', protocol: 1 });
  assert.equal((await fetch(`http://localhost:${address.port}/healthz`)).status, 200);
  const rebound = await rawRequest(address.port, { path: '/healthz', headers: { Host: `receiver.example.test:${address.port}` } });
  assert.equal(rebound.status, 403, 'a DNS-rebinding page names another host');
  assert.equal((await rawRequest(address.port, { path: '/healthz', headers: { Host: `127.0.0.1:${address.port + 1}` } })).status, 403);
  for (const origin of ['https://global.americanexpress.com', 'https://evil.example.test', `chrome-extension://${'c'.repeat(32)}`, 'null']) {
    const refused = await fetch(`${base}${CHANNEL_PREFIX}/challenge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ nonce: randomHex() }),
    });
    assert.equal(refused.status, 403, origin);
    assert.equal((await refused.json()).code, 'extension-id-mismatch');
  }
  for (const [method, route] of [['GET', '/sync/config'], ['POST', '/sync/claim'], ['POST', '/sync/amex/statement'], ['GET', '/sync/status']]) {
    const response = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: method === 'POST' ? '{}' : undefined });
    assert.equal(response.status, 404, `${method} ${route} is not served in the clear`);
  }
  assert.equal((await fetch(`${base}${CHANNEL_PREFIX}/challenge`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  const oversized = await fetch(`${base}${CHANNEL_PREFIX}/challenge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce: 'a'.repeat(5000) }),
  });
  assert.equal(oversized.status, 413);
  const garbage = await fetch(`${base}${CHANNEL_PREFIX}/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce: SECRET }) });
  assert.equal(garbage.status, 401);
  assert.equal((await garbage.text()).includes(SECRET), false);
  assert.equal(calls.length, 0);
});

test('nothing without the pairing key can make the receiver keep a challenge, so a flood of requests locks no one out', async (t) => {
  const key = randomHex();
  const { base, calls, events } = await startReceiver(t, key);
  // More requests than the receiver ever keeps challenges for: unsigned ones (the old form) and badly signed ones.
  const forged = [() => ({ nonce: randomHex() }), () => ({ nonce: randomHex(), at: Date.now(), proof: 'AAAA' })];
  const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
  t.after(() => agent.destroy());
  for (let batch = 0; batch < 24; batch += 1) {
    const answers = await Promise.all(Array.from({ length: 50 }, (_, index) => postChallenge(base, forged[index % 2](), agent)));
    assert.ok(answers.every((status) => status === 401));
  }
  assert.equal(await postChallenge(base, await challengeBody(randomHex(), base)), 401, 'signed with another key');
  assert.equal(await postChallenge(base, await challengeBody(key, base, { at: Date.now() - 5 * 60_000 })), 401, 'too old');
  const signed = await challengeBody(key, base);
  assert.equal(await postChallenge(base, signed), 200);
  assert.equal(await postChallenge(base, signed), 401, 'a signed challenge request counts once');
  const response = await createSecureClient({ base, getToken: () => key, fetchImpl: asExtension() }).request('POST', '/sync/stop', { body: '{}' });
  assert.equal(response.status, 200, 'the paired extension still gets through');
  assert.equal(calls.length, 1);
  const logged = events.filter((event) => event.kind === 'challenge-refused');
  assert.ok(logged.length <= 10, `${logged.length} log lines for about 1,200 refusals`);
});

test('a sealed request\'s body is read only for a challenge it names: anything else is refused before the body comes', async (t) => {
  const key = randomHex();
  const { address, base, calls } = await startReceiver(t, key);
  for (const named of [{}, { [CHALLENGE_HEADER]: randomHex() }, { [CHALLENGE_HEADER]: 'not-a-nonce' }]) {
    // Only the headers, announcing 40 MiB that never come: the answer cannot be waiting for them.
    const status = await new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1', port: address.port, method: 'POST', path: `${CHANNEL_PREFIX}/request`, agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(40 * 1024 * 1024), ...named },
      }, (answer) => {
        answer.resume();
        resolve(answer.statusCode);
        request.destroy();
      });
      request.on('error', reject);
      request.flushHeaders();
    });
    assert.equal(status, 401);
  }
  assert.equal(calls.length, 0);
  const response = await createSecureClient({ base, getToken: () => key, fetchImpl: asExtension() }).request('POST', '/sync/stop', { body: '{}' });
  assert.equal(response.status, 200);
});

test('connections are capped, and one that sends nothing is dropped, so idle connections cannot hold the receiver', async (t) => {
  const key = randomHex();
  const { address, base } = await startReceiver(t, key, {
    limits: { maxConnections: 3, headersTimeoutMs: 1_000, requestTimeoutMs: 5_000, checkEveryMs: 100 },
  });
  const open = () => new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: address.port }, () => resolve({ socket, closed }));
    const closed = new Promise((done) => socket.once('close', done));
    socket.on('error', () => {});
  });
  const idle = await Promise.all([open(), open(), open()]);
  const extra = await open();
  await extra.closed;
  assert.ok(idle.every(({ socket }) => !socket.destroyed), 'the fourth was refused while three were open');
  await Promise.all(idle.map(({ closed }) => closed));
  const response = await createSecureClient({ base, getToken: () => key, fetchImpl: asExtension() }).request('POST', '/sync/stop', { body: '{}' });
  assert.equal(response.status, 200);
});

test('refusals are logged a few times a minute at most, and the next line logged counts those left out', () => {
  const lines = [];
  let clock = 0;
  const refused = refusalLog((event) => lines.push(event), { limit: 3, windowMs: 1_000, now: () => clock });
  for (let index = 0; index < 10; index += 1) refused({ kind: 'channel-refused' });
  assert.deepEqual(lines, Array(3).fill({ kind: 'channel-refused' }));
  clock = 1_000;
  refused({ kind: 'origin-refused' });
  refused({ kind: 'origin-refused' });
  assert.deepEqual(lines.slice(3), [{ kind: 'origin-refused', notLogged: 7 }, { kind: 'origin-refused' }]);
});
