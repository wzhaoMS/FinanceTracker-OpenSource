import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';

import { ConfigError } from '../lib/config.mjs';
import { createHoldrApi, HoldrApiError, MIN_SCHEMA_VERSION, nothingLeftToImport } from '../lib/holdr-api.mjs';
import { listenerOwner } from '../lib/listener-owner.mjs';
import { matchCardAccount } from '../lib/plan.mjs';
import { closedPort, startFakeHoldr, tempDir, TOKEN, writeToken } from './helpers.mjs';

const ACCOUNT = { id: 'card-1', issuer: 'amex', owner: 'alex', last5: '91005', last4: '1005', currency: 'USD', status: 'active' };
const code = (expected) => (error) => error instanceof HoldrApiError && error.code === expected;
/** The ownership lookup, answered without asking the operating system: the listener runs under this account. */
const mine = async () => ({ owner: 'you' });
/** A client of the fake Holdr that closes its connections after the test. */
function client(t, options) {
  const api = createHoldrApi({ ownerOf: mine, ...options });
  t.after(() => api.close());
  return api;
}

test('a status check carries no token; the reads carry it, over a connection first confirmed to be your own program', async (t) => {
  const holdr = await startFakeHoldr(t, { accounts: [ACCOUNT], coverage: [{ cardAccountId: 'card-1', ranges: [{ start: '2026-01-01', end: '2026-06-30' }] }] });
  const asked = [];
  const api = client(t, {
    appUrl: holdr.url, tokenFile: writeToken(tempDir(t)),
    ownerOf: async (port) => { asked.push({ port, sentBefore: holdr.requests.length }); return { owner: 'you' }; },
  });
  assert.deepEqual(await api.status(), { status: 'ok', schemaVersion: MIN_SCHEMA_VERSION });
  assert.deepEqual(await api.health(), { schemaVersion: MIN_SCHEMA_VERSION });
  assert.deepEqual(await api.listCardAccounts(), [ACCOUNT]);
  assert.deepEqual(await api.coverage(), [{ cardAccountId: 'card-1', ranges: [{ start: '2026-01-01', end: '2026-06-30' }] }]);
  assert.deepEqual(asked[0], { port: holdr.port, sentBefore: 0 }, 'confirmed before anything was sent');
  const [probe, ...reads] = holdr.requests;
  assert.deepEqual([probe.path, probe.headers.authorization], ['/health', undefined], 'the status check carries no token');
  assert.equal(reads.length, 3);
  for (const request of reads) {
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
  }
  for (const request of holdr.requests) {
    assert.equal(request.headers.host, `127.0.0.1:${holdr.port}`);
    for (const name of ['origin', 'forwarded', 'x-forwarded-for', 'via', 'cookie']) assert.equal(request.headers[name], undefined, name);
  }
  // Holdr closed the connection (it restarted, say): the next one is confirmed again before the token goes out.
  const confirmed = asked.length;
  holdr.dropConnections();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const sent = holdr.requests.length;
  assert.deepEqual(await api.listCardAccounts(), [ACCOUNT]);
  assert.deepEqual(asked.slice(confirmed), [{ port: holdr.port, sentBefore: sent }]);
});

test('a program on Holdr\'s port that is not confirmed as yours gets nothing at all: no token, no request', async (t) => {
  const received = [];
  const impostor = net.createServer((socket) => socket.on('data', (chunk) => received.push(chunk)));
  await new Promise((resolve) => impostor.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => impostor.close(resolve)));
  const tokenFile = writeToken(tempDir(t));
  for (const [found, expected, said] of [
    [{ owner: 'other' }, 'listener-not-yours', /runs under another account on this computer/],
    [{ owner: 'unknown', why: 'hidden' }, 'listener-unverified', /could not confirm .* \(this account cannot see it, so it most likely runs under another account\)/],
    [{ owner: 'unknown', why: 'failed' }, 'listener-unverified', /\(the check could not run\)/],
  ]) {
    const api = client(t, { appUrl: `http://127.0.0.1:${impostor.address().port}`, tokenFile, ownerOf: async () => found });
    await assert.rejects(api.health(), (error) => code(expected)(error) && said.test(error.message) && !error.message.includes(TOKEN));
    await assert.rejects(api.preview('card-1', '{"format":"holdr.card-import"}'), code(expected));
    const status = await api.status();
    assert.equal(status.status, expected);
    assert.match(status.message, /so the agent sent it nothing: start your Holdr there \(npm run start:local\)/);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(Buffer.concat(received).length, 0, 'not one byte reached it');
});

test('the real lookup: this process\'s own listener runs under your account, and a closed port has none', {
  skip: !['win32', 'darwin', 'linux'].includes(process.platform) && 'no lookup on this system',
}, async (t) => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  assert.deepEqual(await listenerOwner(server.address().port), { owner: 'you' });
  assert.deepEqual(await listenerOwner(await closedPort()), { owner: 'unknown', why: 'hidden' });
});

test('the preview posts the file to /card-imports/preview for one card account and reports counts; nothing else is written', async (t) => {
  const holdr = await startFakeHoldr(t, { accounts: [ACCOUNT] });
  const api = client(t, { appUrl: holdr.url, tokenFile: writeToken(tempDir(t)) });
  const json = JSON.stringify({ format: 'holdr.card-import', version: 1, rows: [{ externalIdHash: 'xid1:a' }, { externalIdHash: 'xid1:b' }] });
  holdr.state.imported.add('xid1:a');
  const preview = await api.preview('card-1', json);
  assert.deepEqual(preview, {
    rowCount: 2, newCount: 1, duplicateCount: 1, possibleDuplicateCount: 0, pendingPostedCount: 0, conflictCount: 0, heldCount: 0,
    warnings: ['sample-warning'],
  });
  assert.equal(nothingLeftToImport(preview), false);
  assert.equal(nothingLeftToImport({ ...preview, newCount: 0 }), true);
  const sent = holdr.requests.at(-1);
  assert.deepEqual([sent.method, sent.path, sent.query], ['POST', '/card-imports/preview', { cardAccountId: 'card-1' }]);
  assert.equal(sent.headers['content-type'], 'application/json');
  assert.equal(sent.body, json);
  assert.equal(holdr.requests.some((request) => /commit|card-accounts$/.test(request.path) && request.method !== 'GET'), false);
  await assert.rejects(api.preview('card-2', json), code('account-missing'));
  await assert.rejects(api.preview('card-1', '{"format":"other"}'), code('import-format-rejected'));
});

test('clear errors: token missing or malformed, token refused, API not running, not a Holdr API, too old, unavailable', async (t) => {
  const dir = tempDir(t);
  const holdr = await startFakeHoldr(t);
  const missing = client(t, { appUrl: holdr.url, tokenFile: path.join(dir, 'nowhere', 'service-token') });
  await assert.rejects(missing.health(), code('token-missing'));
  assert.equal(holdr.requests.length, 0, 'nothing is sent without a token');
  const malformedDir = path.join(dir, 'malformed');
  await assert.rejects(client(t, { appUrl: holdr.url, tokenFile: writeToken(malformedDir, 'not-a-token') }).health(), code('token-invalid'));
  await assert.rejects(client(t, { appUrl: holdr.url, tokenFile: writeToken(path.join(dir, 'other'), 'cd'.repeat(32)) }).health(), code('token-rejected'));
  const tokenFile = writeToken(path.join(dir, 'good'));
  const down = client(t, { appUrl: `http://127.0.0.1:${await closedPort()}`, tokenFile });
  await assert.rejects(down.health(), (error) => code('api-unreachable')(error) && /npm run start:local/.test(error.message));
  const api = client(t, { appUrl: holdr.url, tokenFile });
  holdr.state.service = 'something-else';
  await assert.rejects(api.health(), code('version-mismatch'));
  holdr.state.service = 'holdr-api';
  holdr.state.schemaVersion = MIN_SCHEMA_VERSION - 1;
  await assert.rejects(api.health(), (error) => code('version-mismatch')(error) && /update Holdr/.test(error.message));
  assert.equal((await api.status()).status, 'version-mismatch', 'the status check sees the schema without the token');
  holdr.state.schemaVersion = MIN_SCHEMA_VERSION;
  holdr.state.status = 503;
  await assert.rejects(api.listCardAccounts(), code('api-unavailable'));
  holdr.state.status = 403;
  await assert.rejects(api.coverage(), code('forbidden'));
  holdr.state.status = null;
  assert.equal((await down.status()).status, 'api-unreachable');
  holdr.state.status = 404;
  await assert.rejects(api.listCardAccounts(), code('version-mismatch'));
  holdr.state.status = null;
  for (const appUrl of ['http://192.0.2.5:4000', 'https://127.0.0.1:4000', 'http://localhost:4000', 'http://[::1]:4000']) {
    assert.throws(() => createHoldrApi({ appUrl, tokenFile }), ConfigError, appUrl);
  }
});

test('card accounts are matched by the five-digit ending, else by four digits; two candidates are never guessed between', () => {
  const other = { ...ACCOUNT, id: 'card-2', last5: undefined, last4: '2002' };
  assert.deepEqual(matchCardAccount([ACCOUNT, other], '91005'), { status: 'matched', account: ACCOUNT });
  assert.deepEqual(matchCardAccount([ACCOUNT, other], '42002'), { status: 'matched', account: other });
  assert.deepEqual(matchCardAccount([ACCOUNT, { ...ACCOUNT, id: 'card-3' }], '91005'), { status: 'ambiguous', account: null });
  assert.deepEqual(matchCardAccount([other, { ...other, id: 'card-4' }], '42002'), { status: 'ambiguous', account: null });
  assert.deepEqual(matchCardAccount([{ ...ACCOUNT, issuer: 'citi' }, { ...ACCOUNT, currency: 'EUR' }], '91005'), { status: 'none', account: null });
  assert.deepEqual(matchCardAccount([{ ...ACCOUNT, last5: '81005' }], '91005'), { status: 'none', account: null }, 'a recorded ending that differs never falls back to four digits');
});
