// The receiver's routes, called directly: lease rules, statement bookkeeping, and that raw exports never outlive a sync.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveConfig } from '../lib/config.mjs';
import { convertAmexStatements } from '../lib/convert.mjs';
import { createReceiverCore } from '../lib/core.mjs';
import { HoldrApiError } from '../lib/holdr-api.mjs';
import { loadState, saveState } from '../lib/pairing.mjs';
import { makePrivateDir } from '../lib/private-fs.mjs';
import { createRawStore } from '../lib/raw-store.mjs';
import { amexCsv, tempDir } from './helpers.mjs';

const EXTENSION = `chrome-extension://${'d'.repeat(32)}`;
const CARD = { sourceId: `amex-${'m'.repeat(64)}`, last5: '91005' };
const PERIODS = [{ start: '2026-07-15', end: '2026-08-14' }, { start: '2026-08-15', end: '2026-09-14' }];

/** A receiver core with Holdr down. With `persist`, its reads live in the state file, as the receiver keeps them. */
function setup(t, { api, root = tempDir(t), persist = false } = {}) {
  const config = resolveConfig({ env: {}, argv: ['--imports', path.join(root, 'imports'), '--extension-id', 'd'.repeat(32), '--history', '3'] });
  for (const dir of [config.importsDir, config.rawDir, config.outboxDir]) makePrivateDir(dir);
  const clock = { now: new Date(2026, 8, 10, 12, 0, 0) };
  const unavailable = async () => { throw new HoldrApiError('api-unreachable', 'Holdr is not running'); };
  const state = persist ? loadState(config.statePath) : null;
  const core = createReceiverCore({
    config, salt: 'c'.repeat(64), rawStore: createRawStore(config.rawDir), convert: convertAmexStatements, now: () => clock.now, leaseMs: 90_000,
    api: api ?? { listCardAccounts: unavailable, coverage: unavailable, preview: unavailable, status: async () => ({ status: 'api-unreachable', message: 'x' }) },
    ...(state ? { reads: state.reads, saveReads: () => saveState(config.statePath, state) } : {}),
  });
  t.after(() => core.shutdown());
  const call = async (method, route, body, origin = EXTENSION) => {
    const answer = await core.dispatch({
      method, path: route, body: body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
      contentType: 'application/json', transportOrigin: origin,
    });
    return { status: answer.status, body: JSON.parse(answer.body.toString('utf8')) };
  };
  return { config, clock, core, call };
}

test('a lease left behind expires, and the raw exports it held are deleted', async (t) => {
  const { config, clock, call } = setup(t);
  assert.equal((await call('POST', '/sync/claim', { lease: 'sync-one-1' })).body.ok, true);
  assert.deepEqual((await call('POST', '/sync/claim', { lease: 'sync-two-2' })).body, { ok: false, busy: true });
  const listed = await call('POST', '/sync/amex/cards', { lease: 'sync-one-1', cards: [{ ...CARD, product: 'Sample Rewards Card' }] });
  assert.equal(listed.body.holdr.status, 'api-unreachable', 'Holdr being down does not stop a sync');
  assert.equal(listed.body.cards[0].match, 'unknown');
  const plan = await call('POST', '/sync/amex/plan', { lease: 'sync-one-1', card: CARD, periods: PERIODS });
  assert.deepEqual(plan.body.fetch.map((period) => period.end), ['2026-08-14', '2026-09-14']);
  const csv = amexCsv([['08/01/2026', 'SAMPLE SHOP', '5.00', '320262130000000601']]);
  assert.equal((await call('POST', '/sync/amex/statement', { lease: 'sync-one-1', card: CARD, period: PERIODS[0], csv })).status, 200);
  assert.equal(fs.readdirSync(config.rawDir).length, 1);
  clock.now = new Date(clock.now.getTime() + 91_000);
  assert.equal((await call('GET', '/sync/ping')).body.busy, false);
  assert.deepEqual(fs.readdirSync(config.rawDir), [], 'the abandoned sync left no raw export behind');
  assert.equal((await call('POST', '/sync/amex/finish', { lease: 'sync-one-1', card: CARD })).body.error, 'sync-lease-required');
  assert.equal((await call('POST', '/sync/claim', { lease: 'sync-two-2' })).body.ok, true);
});

test('statements must be planned, sent once and complete; a failed conversion still deletes the raw exports', async (t) => {
  const { config, call } = setup(t);
  const lease = 'sync-three-3';
  await call('POST', '/sync/claim', { lease });
  assert.equal((await call('POST', '/sync/amex/plan', { lease, card: CARD, periods: PERIODS })).body.error, 'card-unknown');
  await call('POST', '/sync/amex/cards', { lease, cards: [CARD] });
  assert.equal((await call('POST', '/sync/amex/statement', { lease, card: CARD, period: PERIODS[0], csv: 'x' })).body.error, 'plan-required');
  await call('POST', '/sync/amex/plan', { lease, card: CARD, periods: PERIODS });
  const send = (period, csv) => call('POST', '/sync/amex/statement', { lease, card: CARD, period, csv });
  assert.equal((await send({ end: '2026-06-14' }, 'x')).body.error, 'statement-not-planned');
  const broken = amexCsv([['13/45/2026', 'SAMPLE SECRET SHOP', '5.00', '320262130000000701']]);
  assert.equal((await send(PERIODS[0], broken)).status, 200);
  assert.equal((await send(PERIODS[0], broken)).body.error, 'statement-repeated');
  const early = await call('POST', '/sync/amex/finish', { lease, card: CARD });
  assert.equal(early.body.error, 'statements-missing');
  assert.deepEqual(fs.readdirSync(config.rawDir), []);
  await call('POST', '/sync/amex/plan', { lease, card: CARD, periods: PERIODS });
  await send(PERIODS[0], broken);
  await send(PERIODS[1], '');
  const failed = await call('POST', '/sync/amex/finish', { lease, card: CARD });
  assert.equal(failed.status, 422);
  assert.equal(failed.body.error, 'conversion-failed');
  assert.match(failed.body.lines.join(' '), /line 2/);
  assert.equal(JSON.stringify(failed.body).includes('SAMPLE SECRET SHOP'), false);
  assert.deepEqual(fs.readdirSync(config.rawDir), []);
  assert.deepEqual(fs.readdirSync(config.outboxDir), []);
});

test('a statement synced on its closing date is fetched again the next day, after a restart and although its file covers later dates', async (t) => {
  const root = tempDir(t);
  const lease = 'sync-closing-day';
  /** One day's sync of the card up to its plan: the statements the receiver asks for. */
  const planOn = async (sync, day) => {
    sync.clock.now = new Date(2026, 8, day, 12, 0, 0);
    assert.equal((await sync.call('POST', '/sync/claim', { lease })).body.ok, true);
    await sync.call('POST', '/sync/amex/cards', { lease, cards: [CARD] });
    const plan = await sync.call('POST', '/sync/amex/plan', { lease, card: CARD, periods: PERIODS });
    return plan.body.fetch.map((period) => [period.end, period.open]);
  };
  const send = (sync, period, rows) => sync.call('POST', '/sync/amex/statement', { lease, card: CARD, period, csv: amexCsv(rows) });
  const finish = async (sync) => {
    const finished = await sync.call('POST', '/sync/amex/finish', { lease, card: CARD });
    await sync.call('POST', '/sync/release', { lease });
    return finished.body;
  };
  const first = setup(t, { root, persist: true });
  assert.deepEqual(await planOn(first, 14), [['2026-08-14', false], ['2026-09-14', true]]);
  await send(first, PERIODS[0], [['08/01/2026', 'SAMPLE SHOP', '5.00', '320262130000000801']]);
  // The issuer's day can run ahead of this computer's: the open period has a row dated the day after its closing date.
  await send(first, PERIODS[1], [['09/15/2026', 'SAMPLE DINER', '9.00', '320262580000000802']]);
  assert.equal((await finish(first)).file, 'amex-91005-2026-07-15-to-2026-09-15.json', 'the converter widened the file to its last row');
  await first.core.shutdown();
  const recorded = JSON.parse(fs.readFileSync(first.config.statePath, 'utf8')).reads[CARD.sourceId];
  assert.deepEqual(recorded, { '2026-08-14': { readOn: '2026-09-14', empty: false }, '2026-09-14': { readOn: '2026-09-14', empty: false } });

  // The receiver restarts; the next day the statement that closed yesterday is read again although the file covers it.
  const second = setup(t, { root, persist: true });
  assert.deepEqual(await planOn(second, 15), [['2026-09-14', false]]);
  await send(second, PERIODS[1], [['09/15/2026', 'SAMPLE DINER', '9.00', '320262580000000802'], ['09/14/2026', 'SAMPLE LATE SHOP', '3.00', '320262580000000803']]);
  assert.equal((await finish(second)).rows, 2);
  // Read again three days after the closing date: settled, so the following sync skips it.
  assert.deepEqual(await planOn(second, 17), [['2026-09-14', false]]);
  await send(second, PERIODS[1], [['09/14/2026', 'SAMPLE LATE SHOP', '3.00', '320262580000000803']]);
  await finish(second);
  assert.deepEqual(await planOn(second, 18), []);
});

test('a damaged read record is dropped, which only means that statement is read again', (t) => {
  const file = path.join(tempDir(t), 'receiver-state.json');
  const salt = 'a'.repeat(64);
  fs.writeFileSync(file, JSON.stringify({
    version: 1, identitySalt: salt, reads: {
      [CARD.sourceId]: { '2026-08-14': { readOn: '2026-08-20', empty: false }, '2026-09-14': { readOn: 'yesterday', empty: false }, 'x': { readOn: '2026-08-20', empty: true } },
      'not-a-card': { '2026-08-14': { readOn: '2026-08-20', empty: false } },
    },
  }));
  assert.deepEqual(loadState(file), { version: 1, identitySalt: salt, reads: { [CARD.sourceId]: { '2026-08-14': { readOn: '2026-08-20', empty: false } } } });
  fs.writeFileSync(file, JSON.stringify({ version: 1, identitySalt: salt }));
  assert.deepEqual(loadState(file).reads, {}, 'a state file from before reads were kept');
});

test('only the paired extension may read the configuration and status; requests must be JSON for a known route', async (t) => {
  const { call, core } = setup(t);
  assert.equal((await call('GET', '/sync/config', undefined, null)).status, 403);
  assert.equal((await call('GET', '/sync/status', undefined, `chrome-extension://${'e'.repeat(32)}`)).status, 403);
  const config = (await call('GET', '/sync/config')).body;
  assert.deepEqual(Object.keys(config).sort(), ['history', 'owners', 'protocol', 'salt', 'webUrl']);
  assert.equal((await call('GET', '/sync/everything')).status, 404);
  assert.equal((await call('POST', '/sync/claim', '{not json')).status, 400);
  const textual = await core.dispatch({ method: 'POST', path: '/sync/claim', body: Buffer.from('{}'), contentType: 'text/plain', transportOrigin: EXTENSION });
  assert.equal(textual.status, 415);
  assert.equal((await call('POST', '/sync/claim', { lease: 'short' })).status, 400);
  assert.equal((await call('POST', '/sync/amex/cards', { lease: 'no-such-sync', cards: [CARD] })).body.error, 'sync-lease-required');
});
