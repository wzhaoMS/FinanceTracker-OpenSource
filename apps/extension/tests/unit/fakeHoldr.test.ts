/**
 * The fake Holdr (E2c's stand-in in the e2e suite) answers as E2c does,
 * where the extension depends on it: the version a device was paired with
 * on every request (M1), Holdr's own origin in capabilities (M2), E2c's codes
 * and statuses (M5), replays that answer the set as it is now (M7), run
 * limits, which refusals close a run, aborts, authority at every step (E1b
 * row 15, Q35), a revoked device's runs (Q36) and a lapsed one (revision 4),
 * and no device seeing another device's run. Loopback only. The flows are
 * covered end to end in the e2e specs; the acceptance suite runs the
 * extension against E2c itself.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import {
  buildCardSyncPayloadV2,
  canonicalJson,
  cardExternalIdHash,
  cardSyncObservedRange,
  type CardSyncPayloadV2,
  type CardSyncRowDraftV2,
  type JsonValue,
} from '@finance-tracker/shared';
import { EXTENSION_VERSION } from '../../build/manifest.js';
import { FAKE_CHASE } from '../../src/adapters/fake/descriptors.js';
import { newCardSyncId } from '../../src/common/ids.js';
import { FAKE_HOLDR_ORIGIN, FakeHoldr } from '../e2e/fake/holdr.js';

let holdr: FakeHoldr;
let token: string;

before(async () => {
  holdr = await FakeHoldr.start();
});
beforeEach(() => {
  holdr.reset();
  token = holdr.activeDeviceToken();
});
after(async () => {
  await holdr.close();
});

interface CallOptions {
  body?: string;
  key?: string;
  version?: string | null;
  bearer?: string;
}

async function call(method: 'GET' | 'POST', path: string, options: CallOptions = {}): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { authorization: `HoldrDevice ${options.bearer ?? token}`, 'x-holdr-client': 'extension-v1' };
  const version = options.version === undefined ? EXTENSION_VERSION : options.version;
  if (version !== null) headers['x-holdr-client-version'] = version;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.key !== undefined) headers['idempotency-key'] = options.key;
  const response = await fetch(`http://127.0.0.1:${holdr.port}${path}`, { method, headers, body: options.body });
  return { status: response.status, json: await response.json() };
}

interface Run {
  runId: string;
  clientRunId: string;
}

async function newRun(version = holdr.bindingFor('chase').bindingVersion): Promise<{ status: number; json: unknown; run: Run }> {
  const binding = holdr.bindingFor('chase');
  const clientRunId = newCardSyncId('clientRun');
  const created = await call('POST', '/card-sync/runs', {
    key: clientRunId,
    body: JSON.stringify({ clientRunId, bindingId: binding.bindingId, bindingVersion: version, adapterVersion: FAKE_CHASE.parserVersion, contractVersion: 1, trigger: 'manual' }),
  });
  return { ...created, run: { runId: (created.json as { runId?: string }).runId ?? '', clientRunId } };
}

async function openRun(): Promise<Run> {
  const created = await newRun();
  assert.equal(created.status, 200, JSON.stringify(created.json));
  return created.run;
}

/** A valid v2 payload for the fake's Chase binding: one posted row on the primary card, coverage over every scope. */
function chasePayload(options: { captureId?: string; scope?: string } = {}): CardSyncPayloadV2 {
  const binding = holdr.bindingFor('chase');
  const primary = options.scope ?? binding.scopes[0].cardScopeId;
  const rows: CardSyncRowDraftV2[] = [{
    transactionDate: '2026-10-01', postedDate: '2026-10-02', status: 'posted', amountMinor: 1_250, kind: 'purchase',
    description: 'SYNTHETIC BOOKSHOP', merchant: null, issuerCategory: null, externalIdHash: cardExternalIdHash('FAKE-1'),
    cardScopeId: primary, identityNamespace: 'chase-api:sor:v1', secondaryIds: [], originalAmountMinor: null, originalCurrency: null,
  }];
  const scopeIds = [...new Set([...binding.scopes.map((scope) => scope.cardScopeId), primary])];
  const built = buildCardSyncPayloadV2({
    contractVersion: 1, source: 'chase-api', parserVersion: FAKE_CHASE.parserVersion, issuer: 'chase', currency: 'USD', owner: null,
    cards: [...binding.cards], bindingId: binding.bindingId, bindingVersion: binding.bindingVersion,
    captureId: options.captureId ?? newCardSyncId('capture'), observedAt: '2026-10-02T12:00:00.000Z', mode: 'isolated-read',
    coverage: scopeIds.flatMap((cardScopeId) => (['posted', 'pending'] as const).map((status) => ({
      cardScopeId, status, requested: null,
      observed: cardScopeId === primary && status === 'posted' ? cardSyncObservedRange(rows, 'transaction')! : null,
      completeness: 'partial' as const, pageCount: 1, termination: 'more-available' as const,
    }))),
    rejectedCount: 0, statement: null, rows,
  });
  if (!built.ok) throw new Error(JSON.stringify(built.issues));
  return built.payload;
}

const envelope = (payload: CardSyncPayloadV2, runId: string) => `{"payload":${canonicalJson(payload as unknown as JsonValue)},"runId":"${runId}"}`;
const upload = (run: Run, payload: CardSyncPayloadV2, body = envelope(payload, run.runId)) => call('POST', '/card-sync/observations', { key: run.clientRunId, body });

test('M1: every device request names the version the device was paired with; none, another or a malformed one is 401', async () => {
  assert.equal((await call('GET', '/card-sync/capabilities')).status, 200);
  for (const version of [null, '0.0.9', '9.9.9', 'v0.1.0', '']) {
    assert.deepEqual(await call('GET', '/card-sync/capabilities', { version }), { status: 401, json: { error: 'unauthorized' } }, String(version));
  }
  const run = await openRun();
  assert.deepEqual(await call('GET', `/card-sync/runs/${run.runId}/receipt`, { version: '0.0.9' }), { status: 401, json: { error: 'unauthorized' } });
  // A credential paired by another build is refused even with this build's version.
  holdr.setPairedVersion('0.0.9');
  assert.deepEqual(await call('GET', '/card-sync/capabilities'), { status: 401, json: { error: 'unauthorized' } });
  assert.equal((await call('GET', '/card-sync/capabilities', { version: '0.0.9' })).status, 200);
});

test('M2: capabilities name Holdr’s own origin; a pending device sees every issuer switch but no binding, and sync off', async () => {
  const capabilities = (await call('GET', '/card-sync/capabilities')).json as { holdrOrigin: string; issuers: unknown[]; bindings: unknown[] };
  assert.equal(capabilities.holdrOrigin, FAKE_HOLDR_ORIGIN);
  assert.equal(capabilities.issuers.length, 4);
  assert.equal(capabilities.bindings.length, 4);

  const code = holdr.createPairing();
  const redeemed = await fetch(`http://127.0.0.1:${holdr.port}/card-sync/pairings/redeem`, {
    method: 'POST',
    headers: { authorization: `HoldrPair ${code}`, 'x-holdr-client': 'extension-v1', 'content-type': 'application/json' },
    body: JSON.stringify({ clientVersion: EXTENSION_VERSION, deviceLabel: 'Pending browser' }),
  });
  assert.equal(redeemed.status, 200);
  const pending = (await call('GET', '/card-sync/capabilities', { bearer: ((await redeemed.json()) as { deviceToken: string }).deviceToken })).json as { status: string; syncEnabled: boolean; issuers: unknown[]; bindings: unknown[]; holdrOrigin: string };
  assert.deepEqual([pending.status, pending.syncEnabled, pending.issuers.length, pending.bindings.length, pending.holdrOrigin], ['pending', false, 4, 0, FAKE_HOLDR_ORIGIN]);
});

test('a run abort takes exactly one fixed reason (anything else is 422 bad-request); a repeat is fine, another reason on a closed run is 409', async () => {
  const run = await openRun();
  for (const body of ['{"reason":"certificate-ignored"}', '{}', '{"reason":"user-cancelled","note":"x"}', '{"reason":null}', 'not json']) {
    const refused = await call('POST', `/card-sync/runs/${run.runId}/abort`, { body });
    assert.equal(refused.status, 422, body);
    assert.equal((refused.json as { error: string }).error, 'bad-request', body);
  }
  assert.deepEqual(holdr.aborts, []);
  assert.deepEqual(await call('POST', `/card-sync/runs/${run.runId}/abort`, { body: '{"reason":"site-permission-revoked"}' }), { status: 200, json: { status: 'aborted' } });
  assert.deepEqual(await call('POST', `/card-sync/runs/${run.runId}/abort`, { body: '{"reason":"site-permission-revoked"}' }), { status: 200, json: { status: 'aborted' } });
  assert.deepEqual(await call('POST', `/card-sync/runs/${run.runId}/abort`, { body: '{"reason":"user-cancelled"}' }), { status: 409, json: { error: 'run-closed' } });
  assert.deepEqual(holdr.aborts, [{ runId: run.runId, reason: 'site-permission-revoked' }]);
  assert.equal(holdr.runState(run.runId), 'aborted:site-permission-revoked');
  // A late observation for the aborted run is refused, and nothing arrived.
  assert.deepEqual(await upload(run, chasePayload()), { status: 409, json: { error: 'run-closed' } });
  assert.equal(((await call('GET', `/card-sync/runs/${run.runId}/receipt`)).json as { acceptance: string }).acceptance, 'none');

  // An accepted run keeps its set: the abort only records the reason.
  const accepted = await openRun();
  assert.equal((await upload(accepted, chasePayload())).status, 200);
  assert.equal((await call('POST', `/card-sync/runs/${accepted.runId}/abort`, { body: '{"reason":"user-cancelled"}' })).status, 200);
  assert.equal(holdr.runState(accepted.runId), 'accepted');
  assert.equal(((await call('GET', `/card-sync/runs/${accepted.runId}/receipt`)).json as { acceptance: string }).acceptance, 'accepted-uncommitted');
});

test('E1b row 15: authority at run creation and upload; a pause or a switched-off issuer leaves the run open, a stale binding closes it; receipts and aborts never need it', async () => {
  holdr.paused = true;
  assert.deepEqual((await newRun()).json, { error: 'sync-paused' });
  assert.equal(((await call('GET', '/card-sync/capabilities')).json as { syncEnabled: boolean }).syncEnabled, false);
  holdr.paused = false;
  const pausedRun = await openRun();
  holdr.paused = true;
  assert.deepEqual(await upload(pausedRun, chasePayload()), { status: 409, json: { error: 'sync-paused' } });
  assert.equal(holdr.runState(pausedRun.runId), 'open');
  assert.equal((await call('GET', `/card-sync/runs/${pausedRun.runId}/receipt`)).status, 200);
  holdr.paused = false;
  // The same bytes go once Holdr resumes: the run stayed open.
  assert.equal((await upload(pausedRun, chasePayload())).status, 200);

  const disabledRun = await openRun();
  holdr.disabledIssuers.add('chase');
  assert.deepEqual(await upload(disabledRun, chasePayload()), { status: 409, json: { error: 'sync-disabled' } });
  assert.equal(holdr.runState(disabledRun.runId), 'open');
  assert.equal(((await call('GET', '/card-sync/capabilities')).json as { issuers: Array<{ issuer: string; enabled: boolean }> }).issuers.find((item) => item.issuer === 'chase')?.enabled, false);
  holdr.disabledIssuers.clear();
  assert.equal((await upload(disabledRun, chasePayload())).status, 200);
});

test('E1b revision 2 and Q35: a binding re-confirmed without re-granting this device: the upload is stale and closes the run; new runs too, until re-granted', async () => {
  const capabilitiesBindings = async () => ((await call('GET', '/card-sync/capabilities')).json as { bindings: Array<{ issuer: string; bindingVersion: number }> }).bindings.filter((binding) => binding.issuer === 'chase');
  assert.deepEqual((await capabilitiesBindings()).map((binding) => binding.bindingVersion), [1]);
  const staleRun = await openRun();
  holdr.reconfirmBinding('chase');
  assert.deepEqual(await upload(staleRun, chasePayload()), { status: 409, json: { error: 'binding-stale' } });
  assert.equal(holdr.runState(staleRun.runId), 'refused');
  assert.deepEqual(await capabilitiesBindings(), []);
  assert.deepEqual((await newRun(2)).json, { error: 'binding-stale' });
  holdr.reconfirmBinding('chase', true);
  assert.equal((await newRun(3)).status, 200);
  assert.deepEqual((await capabilitiesBindings()).map((item) => item.bindingVersion), [3]);
  holdr.setBindingStatus('chase', 'needs-reconfirmation');
  assert.deepEqual((await newRun(3)).json, { error: 'binding-needs-reconfirmation' });
  holdr.setBindingStatus('chase', 'retired');
  assert.deepEqual((await newRun(3)).json, { error: 'binding-retired' });
});

test('runs: idempotent on the client run id, at most two open per device (429), 50 a day (429)', async () => {
  const first = await openRun();
  const binding = holdr.bindingFor('chase');
  const again = await call('POST', '/card-sync/runs', { key: first.clientRunId, body: JSON.stringify({ clientRunId: first.clientRunId, bindingId: binding.bindingId, bindingVersion: 1, adapterVersion: FAKE_CHASE.parserVersion, contractVersion: 1, trigger: 'manual' }) });
  assert.equal((again.json as { runId: string }).runId, first.runId);
  assert.deepEqual((await call('POST', '/card-sync/runs', { key: newCardSyncId('clientRun'), body: JSON.stringify({ clientRunId: first.clientRunId, bindingId: binding.bindingId, bindingVersion: 1, adapterVersion: FAKE_CHASE.parserVersion, contractVersion: 1, trigger: 'manual' }) })).json, { error: 'idempotency-conflict' });
  await openRun();
  assert.deepEqual(await newRun().then(({ status, json }) => ({ status, json })), { status: 429, json: { error: 'too-many-open-runs' } });
  holdr.reset();
  token = holdr.activeDeviceToken();
  holdr.runsPerDay = 1;
  await openRun();
  assert.deepEqual(await newRun().then(({ status, json }) => ({ status, json })), { status: 429, json: { error: 'run-rate-limited' } });
});

test('uploads: the exact canonical envelope, scopes of the binding only, one acceptance per capture; refusals of the bytes close the run', async () => {
  const sloppy = await openRun();
  const payload = chasePayload();
  const spaced = envelope(payload, sloppy.runId).replace('{"payload":', '{"payload": ');
  assert.deepEqual(await upload(sloppy, payload, spaced), { status: 400, json: { error: 'payload-digest-mismatch', issues: [{ code: 'inconsistent', path: '$' }] } });
  assert.equal(holdr.runState(sloppy.runId), 'refused');
  assert.deepEqual(await upload(sloppy, payload), { status: 409, json: { error: 'run-closed' } });

  const outside = await openRun();
  assert.deepEqual(await upload(outside, chasePayload({ scope: holdr.bindingFor('amex').scopes[0].cardScopeId })), { status: 422, json: { error: 'scope-not-in-binding' } });
  assert.equal(holdr.runState(outside.runId), 'refused');

  holdr.reset();
  token = holdr.activeDeviceToken();
  const captureId = newCardSyncId('capture');
  const once = await openRun();
  assert.equal((await upload(once, chasePayload({ captureId }))).status, 200);
  const twice = await openRun();
  assert.deepEqual(await upload(twice, chasePayload({ captureId })), { status: 409, json: { error: 'capture-already-accepted' } });
});

test('M7: a replay of an accepted upload answers the set as it is now, a committed or rejected one included', async () => {
  const run = await openRun();
  const payload = chasePayload();
  const first = await upload(run, payload);
  assert.equal((first.json as { status: string }).status, 'accepted-uncommitted');
  assert.equal(((await upload(run, payload)).json as { status: string }).status, 'accepted-uncommitted');
  holdr.ownerCommitAll();
  assert.deepEqual((await upload(run, payload)).json, { ...(first.json as object), status: 'committed' });
  const receipt = (await call('GET', `/card-sync/runs/${run.runId}/receipt`)).json as { acceptance: string; ledger: string };
  assert.deepEqual([receipt.acceptance, receipt.ledger], ['accepted-uncommitted', 'committed']);

  const discarded = await openRun();
  const other = chasePayload();
  assert.equal((await upload(discarded, other)).status, 200);
  holdr.rejectOpenSets();
  assert.equal(((await upload(discarded, other)).json as { status: string }).status, 'rejected');
  // Other bytes on an accepted run conflict.
  assert.deepEqual((await upload(discarded, chasePayload())).json, { error: 'idempotency-conflict' });
});

test('Q36: revoking the device closes its open runs as expired, with no abort reason; its requests get 401', async () => {
  const run = await openRun();
  holdr.revokeAll();
  assert.equal(holdr.runState(run.runId), 'expired');
  assert.deepEqual(holdr.aborts, []);
  assert.deepEqual(await call('GET', `/card-sync/runs/${run.runId}/receipt`), { status: 401, json: { error: 'unauthorized' } });
});

test('another device’s run is not this device’s: its commit, receipt and abort are 404 run-not-found', async () => {
  const owner = token;
  const run = await openRun();
  const commit = JSON.stringify({ runId: run.runId, previewId: `prv_${'a'.repeat(32)}`, payloadDigest: `pd1:${'b'.repeat(64)}`, planDigest: `pl1:${'c'.repeat(64)}` });
  token = holdr.activeDeviceToken();
  assert.deepEqual(await call('POST', '/card-sync/imports/commit', { body: commit }), { status: 404, json: { error: 'run-not-found' } });
  assert.deepEqual(await call('GET', `/card-sync/runs/${run.runId}/receipt`), { status: 404, json: { error: 'run-not-found' } });
  assert.deepEqual(await call('POST', `/card-sync/runs/${run.runId}/abort`, { body: '{"reason":"user-cancelled"}' }), { status: 404, json: { error: 'run-not-found' } });
  assert.deepEqual(holdr.aborts, []);
  // Its own device gets past the ownership check, and is refused only because nothing was accepted on the run.
  token = owner;
  assert.deepEqual(await call('POST', '/card-sync/imports/commit', { body: commit }), { status: 409, json: { error: 'plan-mismatch' } });
});

test('E1b revision 4: a device whose 30 days lapse gets 401 everywhere, like a revoked one', async () => {
  const run = await openRun();
  holdr.expireAll();
  assert.deepEqual(await call('GET', `/card-sync/runs/${run.runId}/receipt`), { status: 401, json: { error: 'unauthorized' } });
  assert.deepEqual(await call('GET', '/card-sync/capabilities'), { status: 401, json: { error: 'unauthorized' } });
});
