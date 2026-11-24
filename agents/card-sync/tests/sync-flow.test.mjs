// End to end, without a browser or the network: the real page helper (amex-page.js) and sync (amex-sync.js) run in vm
// sandboxes against a simulated American Express site, the real worker logic (worker-core.mjs) talks to the real receiver
// over the encrypted channel, and the receiver converts into the outbox and asks a fake Holdr API for previews.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { randomHex } from '../extension/secure-channel.mjs';
import { loadSharedTool } from '../lib/convert.mjs';
import { listOutbox } from '../lib/outbox.mjs';
import { mergeRanges } from '../lib/plan.mjs';
import { ACCOUNT, AMEX, amexSite, EXPORTS, EXTENSION_ID, loadTab, PERIODS, startReceiver, startWorker } from './harness.mjs';
import { amexCsv, startFakeHoldr } from './helpers.mjs';

test('a sync saves one redacted file per card in the private outbox, previews it in Holdr, and keeps no raw export', async (t) => {
  const holdr = await startFakeHoldr(t, { accounts: [ACCOUNT] });
  const { config, events } = await startReceiver(t, { holdr });
  const { sw } = startWorker({ extensionDir: config.extensionDir });
  const site = amexSite();
  const { rpc, sync } = loadTab(site);
  const lines = [];
  const outcome = await sync.runSync({ sw, rpc, ui: { cardDone: (line) => lines.push(line) } });

  const byEnding = Object.fromEntries(outcome.results.map((result) => [`${result.last5}:${result.outcome}`, result]));
  assert.deepEqual(Object.keys(byEnding).sort(), ['33003:shared-ending', '42002:saved', '91005:saved']);
  assert.equal(outcome.results.length, 4, 'both cards that share an ending are reported, neither is synced');
  const main = byEnding['91005:saved'].done;
  assert.equal(main.file, 'amex-91005-2026-06-15-to-2026-09-10.json');
  assert.equal(main.rows, 7);
  assert.equal(main.match, 'matched');
  assert.deepEqual(main.account, { nickname: 'Sample Rewards', owner: 'alex', ownerLabel: 'Alex', status: 'active' });
  assert.equal(main.preview.newCount, 7);
  assert.equal(main.preview.duplicateCount, 0);
  assert.equal(byEnding['42002:saved'].done.match, 'none');
  assert.equal(byEnding['42002:saved'].done.preview, null);
  assert.match(lines.join('\n'), /Alex ··91005 Sample Rewards: saved 7 rows; Holdr preview: 7 new, 0 already imported/);
  assert.match(lines.join('\n'), /··42002 Sample Cash: saved 1 row; new card: create its account in the import dialog/);
  assert.match(outcome.summary, /^Saved 2 files \(8 rows\) for import\. In Holdr: Spending, Import redacted JSON\. 2 cards were not synced/);

  const { validateCardImportPayload } = await loadSharedTool();
  const files = listOutbox(config.outboxDir);
  assert.deepEqual(files.map((file) => file.name).sort(), ['amex-42002-2026-06-15-to-2026-09-10.json', 'amex-91005-2026-06-15-to-2026-09-10.json']);
  const payload = JSON.parse(fs.readFileSync(path.join(config.outboxDir, main.file), 'utf8'));
  assert.equal(validateCardImportPayload(payload).ok, true);
  assert.equal(payload.owner, 'alex', 'the matched account owner is the import dialog hint');
  assert.deepEqual(payload.coverage, { start: '2026-06-15', end: '2026-09-10' });
  assert.deepEqual(fs.readdirSync(config.rawDir), [], 'raw exports are deleted after conversion');

  // Only the statement exports were fetched from the bank, read-only, at the planned periods; Holdr was only read.
  assert.ok(site.requests.every((request) => request.method === 'GET'));
  assert.equal(site.requests.filter((request) => request.path.endsWith('/documents')).length, 6);
  assert.deepEqual([...new Set(holdr.requests.map((request) => `${request.method} ${request.path}`))].sort(),
    ['GET /card-accounts', 'GET /spending/coverage', 'POST /card-imports/preview']);
  const toHoldr = JSON.stringify(holdr.requests);
  const logged = JSON.stringify(events);
  for (const value of ['SAMPLE MEMBER', 'ALEX SAMPLE', 'CASEY SAMPLE', '320262240000000101', 'XXXX-XXXXXX', 'EXAMPLE ST', '62701']) {
    assert.equal(toHoldr.includes(value), false, `sent to Holdr: ${value}`);
  }
  // The log holds counts, dates, endings and file names: no descriptions, amounts or references.
  for (const value of ['SAMPLE MEMBER', 'ALEX SAMPLE', 'SAMPLE COFFEE BAR', 'SAMPLE HARDWARE', '1,234.56', '123456', '320262240000000101', 'xid1:']) {
    assert.equal(logged.includes(value), false, `logged: ${value}`);
  }
});

test('the next sync fetches only what Holdr does not hold yet, and saves nothing when every row is already imported', async (t) => {
  const holdr = await startFakeHoldr(t, { accounts: [ACCOUNT] });
  const { config } = await startReceiver(t, { holdr });
  const { sw } = startWorker({ extensionDir: config.extensionDir });
  const firstTab = loadTab(amexSite());
  const first = await firstTab.sync.runSync({ sw, rpc: firstTab.rpc });
  assert.equal(first.results.filter((result) => result.outcome === 'saved').length, 2);
  // The owner imports the main card's file in Holdr.
  const imported = JSON.parse(fs.readFileSync(path.join(config.outboxDir, 'amex-91005-2026-06-15-to-2026-09-10.json'), 'utf8'));
  for (const row of imported.rows) holdr.state.imported.add(row.externalIdHash ?? row.fingerprint);
  holdr.state.coverage = [{ cardAccountId: 'card-1', ranges: [imported.coverage] }];

  const site = amexSite();
  const tab = loadTab(site);
  const second = await tab.sync.runSync({ sw, rpc: tab.rpc });
  const main = second.results.find((result) => result.last5 === '91005');
  assert.equal(main.outcome, 'already-imported');
  assert.equal(main.done.file, null);
  const documents = site.requests.filter((request) => request.path.endsWith('/documents')).length;
  assert.equal(documents, 2, 'one current-period export per synced card: the closed statements are covered');
  // The unknown card's statements wait in the outbox, so only its (quiet) current period was read again.
  assert.equal(second.results.find((result) => result.last5 === '42002').outcome, 'no-activity');
  assert.deepEqual(listOutbox(config.outboxDir).map((file) => file.name).sort(), [
    'amex-42002-2026-06-15-to-2026-09-10.json', 'amex-91005-2026-06-15-to-2026-09-10.json',
  ]);
  assert.deepEqual(fs.readdirSync(config.rawDir), []);
});

test('a sync on a closing date is followed by another read of that statement, which finds the rows that posted later', async (t) => {
  const holdr = await startFakeHoldr(t, { accounts: [ACCOUNT] });
  const clock = { now: new Date(2026, 8, 14, 12, 0, 0) };
  const { config } = await startReceiver(t, { holdr, clock });
  const { sw } = startWorker({ extensionDir: config.extensionDir });
  const periods = [...PERIODS, { statement_start_date: '2026-09-15', statement_end_date: '2026-10-14' }];
  const exports = structuredClone(EXPORTS);
  const importFile = (name) => {
    const payload = JSON.parse(fs.readFileSync(path.join(config.outboxDir, name), 'utf8'));
    for (const row of payload.rows) holdr.state.imported.add(row.externalIdHash ?? row.fingerprint);
    const ranges = holdr.state.coverage[0]?.ranges ?? [];
    holdr.state.coverage = [{ cardAccountId: 'card-1', ranges: mergeRanges([...ranges, payload.coverage]) }];
  };
  /** Syncs on `day` of September: the main card's outcome and the statements read for it. */
  const syncOn = async (day) => {
    clock.now = new Date(2026, 8, day, 12, 0, 0);
    const site = amexSite({ periods, exports });
    const tab = loadTab(site);
    const outcome = await tab.sync.runSync({ sw, rpc: tab.rpc });
    const main = outcome.results.find((result) => result.last5 === '91005');
    return { main, read: site.requests.filter((request) => request.accountKey === 'key-main' && request.path.endsWith('/documents')).map((request) => request.end) };
  };

  // On its closing date the statement is the current period: read up to today, imported.
  const closingDay = await syncOn(14);
  assert.deepEqual(closingDay.read, ['2026-07-14', '2026-08-14', '2026-09-14']);
  assert.equal(closingDay.main.done.file, 'amex-91005-2026-06-15-to-2026-09-14.json');
  importFile(closingDay.main.done.file);
  // A purchase made on the closing date posts the next day, on that statement.
  exports['key-main']['2026-09-14'] = amexCsv([
    ['08/20/2026', 'SAMPLE BOOKSHOP', '25.00', '320262320000000201'], ['08/16/2026', 'SAMPLE COFFEE BAR', '4.50', '320262280000000202'],
    ['09/14/2026', 'SAMPLE LATE DINER', '18.00', '320262570000000203'],
  ]);

  const nextDay = await syncOn(15);
  assert.deepEqual(nextDay.read, ['2026-09-14', '2026-10-14'], 'the statement that closed yesterday is read again although Holdr covers it');
  assert.equal(nextDay.main.outcome, 'saved');
  assert.equal(nextDay.main.done.preview.newCount, 1, 'the late row is found');
  assert.equal(nextDay.main.done.preview.duplicateCount, 2);
  importFile(nextDay.main.done.file);
  // Read again until a read three days after closing, then only the current period is read.
  assert.deepEqual((await syncOn(17)).read, ['2026-09-14', '2026-10-14']);
  assert.deepEqual((await syncOn(18)).read, ['2026-10-14']);
  assert.deepEqual(fs.readdirSync(config.rawDir), []);
});

test('switching OFF mid-sync stops it at once: the lease is released and the raw exports already received are deleted', async (t) => {
  const holdr = await startFakeHoldr(t, { accounts: [ACCOUNT] });
  const { config } = await startReceiver(t, { holdr });
  const { sw } = startWorker({ extensionDir: config.extensionDir });
  const tab = loadTab(amexSite());
  let statements = 0;
  let off = false;
  const watched = async (op, data) => {
    const result = await sw(op, data);
    if (op === 'statement' && (statements += 1) === 2) off = true;
    return result;
  };
  await assert.rejects(tab.sync.runSync({ sw: watched, rpc: tab.rpc, checkpoint: () => { if (off) throw new tab.sync.Stop(tab.sync.STOP_TEXT.off); } }),
    (error) => error.message === 'Stopped: switched off');
  assert.deepEqual(fs.readdirSync(config.rawDir), []);
  assert.deepEqual(listOutbox(config.outboxDir), []);
  assert.equal((await sw('ping')).busy, false, 'the lease was released');
  assert.equal((await sw('claim', { lease: 'another-sync-1' })).ok, true);
});

test('with Holdr in HTTPS mode, Open Holdr opens its https:// address, while the receiver still reads Holdr on 127.0.0.1', async (t) => {
  const holdr = await startFakeHoldr(t, { accounts: [ACCOUNT] });
  const { config } = await startReceiver(t, { holdr, webUrl: 'https://holdr.example.test' });
  const { popup, opened } = startWorker({ extensionDir: config.extensionDir });
  assert.equal((await popup('status')).holdr.status, 'ok');
  await popup('open-holdr');
  assert.deepEqual(opened, ['https://holdr.example.test/#/everyday/transactions']);
  // The status check went to Holdr's API on 127.0.0.1, without the token.
  assert.ok(holdr.requests.length > 0 && holdr.requests.every((request) => request.headers.host === `127.0.0.1:${holdr.port}`
    && request.headers.authorization === undefined));
});

test('the worker answers only the American Express tab and its popup, and explains pairing and connection problems', async (t) => {
  const holdr = await startFakeHoldr(t, { accounts: [ACCOUNT] });
  const { config, receiver } = await startReceiver(t, { holdr });
  const { sw, popup, from, opened } = startWorker({ extensionDir: config.extensionDir });
  const status = await popup('status');
  assert.equal(status.holdr.status, 'ok');
  assert.deepEqual(status.outbox, { count: 0, folder: config.outboxDir });
  assert.equal(status.extensionId, EXTENSION_ID);
  await popup('open-holdr');
  assert.deepEqual(opened, ['http://127.0.0.1:5173/#/everyday/transactions']);
  const refused = (error) => error.code === 'refused';
  await assert.rejects(popup('statement'), refused);
  await assert.rejects(from({ id: EXTENSION_ID, tab: { id: 3 }, frameId: 0, url: 'https://evil.example.test/page' }, 'config'), refused);
  await assert.rejects(from({ id: EXTENSION_ID, tab: { id: 3 }, frameId: 2, url: `${AMEX}/frame` }, 'config'), refused);
  await assert.rejects(from({ id: 'e'.repeat(32), tab: { id: 3 }, frameId: 0, url: `${AMEX}/dashboard` }, 'config'), refused);
  assert.equal((await sw('config')).webUrl, 'http://127.0.0.1:5173');

  const unpaired = startWorker({ extensionDir: path.join(config.extensionDir, 'missing') });
  await assert.rejects(unpaired.sw('ping'), (error) => error.code === 'not-paired' && /npm run agent -- pair/.test(error.message));
  const otherId = startWorker({ extensionDir: config.extensionDir, origin: `chrome-extension://${'f'.repeat(32)}` });
  await assert.rejects(otherId.sw('ping'), (error) => error.code === 'extension-id-mismatch' && error.message.includes(`HOLDR_EXTENSION_ID=${EXTENSION_ID}`));
  const pairingFile = path.join(config.extensionDir, 'local-key.json');
  const stale = JSON.parse(fs.readFileSync(pairingFile, 'utf8'));
  fs.writeFileSync(pairingFile, JSON.stringify({ ...stale, pairingKey: randomHex() }));
  await assert.rejects(startWorker({ extensionDir: config.extensionDir }).sw('ping'), (error) => error.code === 'pairing-mismatch');
  fs.writeFileSync(pairingFile, JSON.stringify(stale));
  await receiver.close();
  await assert.rejects(sw('ping'), (error) => error.code === 'receiver-unreachable' && /npm run agent/.test(error.message));
});
