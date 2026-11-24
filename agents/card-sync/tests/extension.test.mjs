import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { PINNED_EXTENSION_ID } from '../lib/config.mjs';
import { EXTENSION_DIR, tempDir } from './helpers.mjs';

const read = (name) => fs.readFileSync(path.join(EXTENSION_DIR, name), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
/** Values from a vm sandbox have that realm's prototypes: compare them as plain data. */
const plain = (value) => JSON.parse(JSON.stringify(value));

test('the manifest asks for the least it needs and pins the extension ID the receiver expects by default', () => {
  assert.equal(manifest.manifest_version, 3);
  const der = Buffer.from(manifest.key, 'base64');
  const id = [...createHash('sha256').update(der).digest().subarray(0, 16)]
    .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
  assert.equal(id, PINNED_EXTENSION_ID);
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*']);
  assert.deepEqual(manifest.background, { service_worker: 'worker.js', type: 'module' });
  assert.equal(manifest.web_accessible_resources, undefined, 'web pages can read none of its files, the pairing key included');
  const matches = new Set(manifest.content_scripts.flatMap((script) => script.matches));
  assert.deepEqual([...matches], ['https://global.americanexpress.com/*']);
  assert.deepEqual(manifest.content_scripts.map((script) => [script.js.join(','), script.world ?? 'ISOLATED']),
    [['amex-page.js', 'MAIN'], ['amex-sync.js,amex-panel.js', 'ISOLATED']]);
  const files = fs.readdirSync(EXTENSION_DIR);
  for (const name of [manifest.background.service_worker, manifest.action.default_popup, ...manifest.content_scripts.flatMap((script) => script.js)]) {
    assert.ok(files.includes(name), name);
  }
  assert.equal(files.some((name) => name.startsWith('_')), false, 'Chrome reserves names that start with "_"');
  for (const name of files.filter((file) => /\.(m?js|json|html)$/.test(file))) {
    assert.doesNotMatch(read(name), /amazon|fidelity|chase\.com|citi\.com/i, name);
  }
});

test('the extension scripts parse: classic content scripts and popup, and the module worker', (t) => {
  for (const name of ['amex-page.js', 'amex-sync.js', 'amex-panel.js', 'popup.js']) assert.doesNotThrow(() => new vm.Script(read(name), { filename: name }), name);
  const dir = tempDir(t);
  for (const name of ['worker.js', 'worker-core.mjs', 'secure-channel.mjs']) fs.copyFileSync(path.join(EXTENSION_DIR, name), path.join(dir, name === 'worker.js' ? 'worker.mjs' : name));
  const check = spawnSync(process.execPath, ['--check', path.join(dir, 'worker.mjs')], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
});

/** The page helper in a sandbox whose fetch answers from `respond(path, init)`; setTimeout records the pacing waits. */
function pageHelper(respond, initialState = null) {
  const waits = [];
  const document = new EventTarget();
  Object.assign(document, { getElementById: () => null, querySelector: () => null, body: { children: [] } });
  const window = { __INITIAL_STATE__: initialState };
  vm.runInNewContext(read('amex-page.js'), {
    window, document, crypto: globalThis.crypto, TextEncoder, URLSearchParams, CustomEvent, AbortController,
    fetch: async (url, init) => respond(new URL(url, 'https://global.americanexpress.com'), init),
    setTimeout: (callback, ms) => { waits.push(ms); setImmediate(callback); },
  }, { filename: 'amex-page.js' });
  return { helper: window.__holdrSync, waits };
}

const SALT = 'c'.repeat(64);

test('the page helper reads the card list from transit-encoded page state and keeps keys and tokens in the page', async () => {
  // Transit: cached keys ("^2" is the third cached string) and an immutable list tag, as the Amex page writes them.
  const transit = JSON.stringify(['^ ', 'accounts', ['~#iL', [
    ['^ ', '~:accountToken', 'tok-1', '~:accountKey', 'key-1', '~:account', ['^ ', 'display_account_number', '91005'], '~:product', ['^ ', 'description', 'Sample Rewards Card']],
    ['^ ', '^2', 'tok-2', '^3', 'key-2', '^4', ['^ ', '^5', '42002']],
  ]]]);
  const { helper } = pageHelper(() => new Response('', { status: 404 }), transit);
  const decoded = helper._transitRead(JSON.parse(transit));
  assert.equal(decoded.accounts[1].accountToken, 'tok-2');
  const found = await helper.loadAccounts(SALT);
  assert.equal(found.ok, true);
  assert.deepEqual(plain(found.accounts.map((card) => [card.last5, card.product, card.conflict, /^amex-[a-p]{64}$/.test(card.sourceId)])),
    [['91005', 'Sample Rewards Card', false, true], ['42002', null, false, true]]);
  const shown = JSON.stringify(found);
  for (const secret of ['tok-1', 'key-1', 'tok-2', 'key-2']) assert.equal(shown.includes(secret), false, secret);
  await assert.rejects(helper.loadAccounts('not-a-salt'), /salt/);
});

test('statement dates are read from every shape the page uses, newest first', () => {
  const { helper } = pageHelper(() => new Response(''));
  assert.deepEqual(plain(helper._parsePeriods({ data: [
    { statementEndDate: '2026-08-14T00:00:00Z', statementStartDate: '2026-07-15' },
    { statement_end_date: '09/14/2026', statement_start_date: '08/15/2026' },
    { nested: { closing_date: Date.UTC(2026, 6, 14, 12) } },
    { statement_end_date: '09/14/2026' },
  ] })), [
    { start: '2026-08-15', end: '2026-09-14' }, { start: '2026-07-15', end: '2026-08-14' }, { start: null, end: '2026-07-14' },
  ]);
});

test('requests are paced, read-only and stop at 429, 403, a login page or a session-wide 401', async () => {
  const state = JSON.stringify({ cards: [{ accountToken: 'tok-1', accountKey: 'key-1', account: { display_account_number: '91005' } }] });
  const seen = [];
  let answer = (url) => (url.pathname.endsWith('statement_periods')
    ? Response.json({ data: [{ statement_end_date: '2026-08-14', statement_start_date: '2026-07-15' }] })
    : new Response('Date,Description,Amount\r\n08/01/2026,SAMPLE,1.00\r\n', { headers: { 'content-type': 'text/csv' } }));
  const { helper, waits } = pageHelper((url, init) => { seen.push([init?.method ?? 'GET', url.pathname]); return answer(url); }, state);
  const { accounts: [card] } = await helper.loadAccounts(SALT);
  const periods = await helper.periods(card.sourceId);
  assert.equal(periods.ok, true);
  assert.equal(periods.periods[0].end, '2026-08-14');
  const csv = await helper.csv(card.sourceId, { end: '2026-08-14' });
  assert.equal(csv.looksCsv, true);
  assert.ok(waits.some((ms) => ms > 1000 && ms <= 1200), 'the second request waited for the 1.2 s gap');
  assert.ok(seen.every(([method]) => method === 'GET'));
  answer = () => new Response('slow down', { status: 429 });
  assert.equal((await helper.csv(card.sourceId, { end: '2026-08-14' })).stopped.reason, 'rate-limited');
  assert.equal((await helper.periods(card.sourceId)).stopped.reason, 'rate-limited', 'stopped until the next sync');
  await helper.loadAccounts(SALT);
  answer = () => new Response('<html>sign in</html>', { headers: { 'content-type': 'text/html' } });
  assert.equal((await helper.csv(card.sourceId, { end: '2026-08-14' })).stopped.reason, 'session-expired');
  const fresh = pageHelper(() => new Response('', { status: 401 }), state).helper;
  const { accounts: [again] } = await fresh.loadAccounts(SALT);
  assert.equal((await fresh.periods(again.sourceId)).stopped.reason, 'session-expired');
  assert.equal((await fresh.loadAccounts(SALT)).stopped.reason, 'session-expired', 'a dead session needs a fresh sign-in');
  assert.equal((await fresh.csv('amex-' + 'a'.repeat(64), { end: '2026-08-14' })).conflict, true);
});
