/**
 * Worker logic without a browser: the digest tie between preview and send,
 * id grammars, which content scripts are registered (including shape mode on
 * a contract paused after a site change), who may message the worker,
 * preview expiry and the stop gate.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson, cardSyncPayloadDigest, isCardSyncId, type JsonValue } from '@finance-tracker/shared';
import { CARD_SYNC_V2_FIXTURE_BUILDERS } from '@finance-tracker/shared/card-sync-fixtures';
import { FAKE_AMEX, FAKE_CHASE, FAKE_WELLS_FARGO } from '../../src/adapters/fake/descriptors.js';
import { frozenTextDigest, isPayloadDigest } from '../../src/common/digest.js';
import { isLocalId, newCardSyncId, newLocalId } from '../../src/common/ids.js';
import { acceptsFormat, expireIfDue, haltAfterReads, withReceipt } from '../../src/worker/capture.js';
import { beginWork, forIssuer, inShapeMode, issuerHalt, issuerStopMark, notePause, noteShapeMode, pausePending, stopIssuerWork, unblockIssuer } from '../../src/worker/context.js';
import { createHoldrClient } from '../../src/worker/holdrClient.js';
import { BATCH_MESSAGE_LIMITS, parseStrictUnion } from '../../src/common/strict.js';
import { COLLECTOR_MESSAGES, MAX_RETRY_AFTER_MS, statusRetryAfter } from '../../src/contracts/messages.js';
import { desiredScripts, shapeChangedPause } from '../../src/worker/registration.js';
import { checkCollectorSender, onApprovedPath } from '../../src/worker/senders.js';
import type { CaptureRecord, Settings } from '../../src/worker/storage.js';
import type { Receipt } from '../../src/contracts/holdrApi.js';

test('the popup’s digest of the frozen text is the digest of exactly those canonical bytes', () => {
  for (const build of Object.values(CARD_SYNC_V2_FIXTURE_BUILDERS)) {
    const payload = build() as unknown as JsonValue;
    const text = canonicalJson(payload);
    const digest = frozenTextDigest(text);
    assert.equal(digest, cardSyncPayloadDigest(payload));
    assert.ok(isPayloadDigest(digest));
    // Any other serialization of the same value is not what was frozen.
    assert.equal(frozenTextDigest(JSON.stringify(payload, null, 1)), null);
    assert.equal(frozenTextDigest(`${text} `), null);
  }
  assert.equal(frozenTextDigest('{"b":1,"a":2}'), null);
  assert.equal(frozenTextDigest('not json'), null);
});

test('ids: local bookkeeping ids and contract ids are letters a–p only', () => {
  assert.ok(isLocalId('document', newLocalId('document')));
  assert.ok(isLocalId('nonce', newLocalId('nonce')));
  assert.ok(isCardSyncId('clientRun', newCardSyncId('clientRun')));
  assert.match(newCardSyncId('capture'), /^cpt_[a-p]{32}$/);
  assert.notEqual(newLocalId('document'), newLocalId('document'));
});

type SenderTab = NonNullable<chrome.runtime.MessageSender['tab']>;

function settings(issuers: Settings['issuers'], paused = false): Settings {
  return { schema: 1, paused, trustBrowser: false, issuers };
}

test('registered scripts follow settings, consent, permissions and shape mode, also for a contract paused on a site change', () => {
  const granted = new Set([FAKE_CHASE.hostPermission, FAKE_AMEX.hostPermission]);
  const adapters = [FAKE_CHASE, FAKE_AMEX];
  const ids = (list: ReturnType<typeof desiredScripts>) => list.map((item) => item.id).sort();
  const on = { enabled: true, consentVersion: 1, mainPassiveAccepted: true };
  assert.deepEqual(ids(desiredScripts(adapters, settings({ 'fake-chase': on, 'fake-amex': on }), granted, null)), [
    'holdr-fake-amex-isolated',
    'holdr-fake-amex-main',
    'holdr-fake-chase-isolated',
  ]);
  assert.deepEqual(ids(desiredScripts(adapters, settings({ 'fake-chase': on }, true), granted, null)), []);
  assert.deepEqual(ids(desiredScripts(adapters, settings({ 'fake-chase': { ...on, consentVersion: 0 } }), granted, null)), []);
  assert.deepEqual(ids(desiredScripts(adapters, settings({ 'fake-chase': on }), new Set(), null)), []);
  assert.deepEqual(ids(desiredScripts(adapters, settings({ 'fake-amex': { ...on, mainPassiveAccepted: false } }), granted, null)), []);
  const shape = { adapterId: 'fake-chase', startedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER, reports: [] };
  assert.deepEqual(ids(desiredScripts(adapters, settings({ 'fake-chase': on }), granted, shape)), ['holdr-fake-chase-shape-isolated', 'holdr-fake-chase-shape-main']);

  const pausedOnShape = { enabled: false, consentVersion: 0, mainPassiveAccepted: false, shapeChangedVersion: FAKE_CHASE.parserVersion };
  assert.equal(shapeChangedPause(FAKE_CHASE, pausedOnShape), true);
  assert.equal(shapeChangedPause(FAKE_CHASE, { ...pausedOnShape, shapeChangedVersion: 'holdr-ext-fake-chase@0.0.9' }), false);
  assert.deepEqual(ids(desiredScripts(adapters, settings({ 'fake-chase': pausedOnShape }), granted, null)), []);
  assert.deepEqual(ids(desiredScripts(adapters, settings({ 'fake-chase': pausedOnShape }), granted, shape)), ['holdr-fake-chase-shape-isolated', 'holdr-fake-chase-shape-main']);
  assert.deepEqual(ids(desiredScripts(adapters, settings({ 'fake-chase': pausedOnShape }, true), granted, shape)), []);
  assert.deepEqual(ids(desiredScripts(adapters, settings({ 'fake-chase': pausedOnShape }), new Set(), shape)), []);
});

test('only this extension’s top-frame content script on an adapter’s exact origin is a collector', () => {
  const sender = (change: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender => ({
    id: 'ext',
    tab: { id: 7, incognito: false } as SenderTab,
    frameId: 0,
    documentId: 'DOC',
    documentLifecycle: 'active',
    url: 'http://chase.e3.test/dashboard',
    origin: 'http://chase.e3.test',
    ...change,
  });
  assert.equal(checkCollectorSender(sender(), [FAKE_CHASE], 'ext')?.adapter.id, 'fake-chase');
  for (const change of [
    { id: 'other' },
    { frameId: 1 },
    { documentId: undefined },
    { documentLifecycle: 'prerender' },
    { origin: 'http://evil.e3.test' },
    { url: 'http://evil.e3.test/dashboard', origin: 'http://evil.e3.test' },
    { url: 'http://user:user5@example.com/dashboard' },
    { tab: undefined },
    { tab: { id: 7, incognito: true } as SenderTab },
  ] as Array<Partial<chrome.runtime.MessageSender>>) {
    assert.equal(checkCollectorSender(sender(change), [FAKE_CHASE], 'ext'), null, JSON.stringify(change));
  }
  assert.equal(onApprovedPath(FAKE_CHASE, 'http://chase.e3.test/dashboard/account/2'), true);
  assert.equal(onApprovedPath(FAKE_CHASE, 'http://chase.e3.test/dashboardx'), false);
  // checkUiSender compares chrome-extension:// origins, which Node's URL reports as "null"; the e2e suite runs it in Chromium.
});

test('frozen bytes never outlive their TTL: an unsent preview expires, an unknown outcome keeps only what a receipt check needs', () => {
  const preview = { stage: 'preview', expiresAt: 1_000, text: '{"a":1}' } as CaptureRecord;
  assert.deepEqual(
    { stage: expireIfDue(preview, 1_000).stage, text: expireIfDue(preview, 1_000).text, expiresAt: expireIfDue(preview, 1_000).expiresAt },
    { stage: 'expired', text: null, expiresAt: null },
  );
  assert.equal(expireIfDue(preview, 999), preview);
  const unknown = { stage: 'outcome-unknown', expiresAt: 1_000, text: '{"a":1}', runId: `run_${'a'.repeat(32)}`, digest: `pd1:${'b'.repeat(64)}` } as CaptureRecord;
  const lapsed = expireIfDue(unknown, 2_000);
  assert.deepEqual([lapsed.stage, lapsed.text, lapsed.expiresAt, lapsed.runId, lapsed.digest], ['outcome-unknown', null, null, unknown.runId, unknown.digest]);
  // A preview whose earlier upload got no answer loses its bytes but stays checkable.
  const uncertain = expireIfDue({ ...preview, runId: unknown.runId, uploadUncertain: true }, 1_000);
  assert.deepEqual([uncertain.stage, uncertain.text, uncertain.runId], ['outcome-unknown', null, unknown.runId]);
  const accepted = { stage: 'accepted', expiresAt: null, text: null } as unknown as CaptureRecord;
  assert.equal(expireIfDue(accepted, Number.MAX_SAFE_INTEGER), accepted);
});

test('nothing is prepared or sent unless Holdr lists the payload and contract versions this build sends', () => {
  assert.equal(acceptsFormat({ payloadVersions: [2], contractVersions: [1] }), true);
  assert.equal(acceptsFormat({ payloadVersions: [1, 2], contractVersions: [1, 2] }), true);
  assert.equal(acceptsFormat({ payloadVersions: [1], contractVersions: [1] }), false);
  assert.equal(acceptsFormat({ payloadVersions: [2], contractVersions: [2] }), false);
});

test('receipts never move a capture backwards: an overtaken "nothing arrived" leaves a known acceptance alone; final answers end it', () => {
  const runId = `run_${'a'.repeat(32)}`;
  const digest = `pd1:${'b'.repeat(64)}`;
  const capture = (change: Partial<CaptureRecord>) => ({ stage: 'accepted', text: null, expiresAt: null, digest, runId, observationSetId: `obs_${'c'.repeat(32)}`, previewId: null, planDigest: null, plan: null, committedAt: null, error: null, ...change }) as CaptureRecord;
  const receipt = (change: Partial<Receipt>): Receipt => ({ runId, observationSetId: null, acceptance: 'none', ledger: 'none', payloadDigest: null, acceptedAt: null, expiresAt: null, ...change });
  const accepted = capture({});
  const planned = capture({ stage: 'planned', previewId: `prv_${'d'.repeat(32)}`, planDigest: `pl1:${'e'.repeat(64)}` });
  assert.equal(withReceipt(accepted, runId, receipt({})), accepted);
  assert.equal(withReceipt(planned, runId, receipt({})), planned);
  assert.equal(withReceipt(capture({ stage: 'outcome-unknown' }), runId, receipt({})).stage, 'expired');
  assert.equal(withReceipt(capture({ stage: 'outcome-unknown', text: '{}', expiresAt: Number.MAX_SAFE_INTEGER }), runId, receipt({})).stage, 'preview');
  // "Nothing arrived yet" does not settle an upload whose answer never came: the capture keeps knowing it may still land.
  const uncertain = withReceipt(capture({ stage: 'outcome-unknown', text: '{}', expiresAt: Number.MAX_SAFE_INTEGER, uploadUncertain: true }), runId, receipt({}));
  assert.deepEqual([uncertain.stage, uncertain.uploadUncertain], ['preview', true]);
  // Without its bytes it stays checkable, unless Holdr had closed the run before the receipt was asked for: then
  // "nothing arrived" is final. A closure confirmed only after the request does not make that older answer current.
  const pending = withReceipt(capture({ stage: 'outcome-unknown', uploadUncertain: true, runClosed: false }), runId, receipt({}));
  assert.deepEqual([pending.stage, pending.error], ['outcome-unknown', 'upload-pending']);
  assert.equal(withReceipt(capture({ stage: 'outcome-unknown', uploadUncertain: true, runClosed: true }), runId, receipt({}), true).stage, 'expired');
  assert.equal(withReceipt(capture({ stage: 'outcome-unknown', uploadUncertain: true, runClosed: true }), runId, receipt({}), false).stage, 'outcome-unknown');
  const rejected = withReceipt(planned, runId, receipt({ acceptance: 'rejected', observationSetId: accepted.observationSetId, payloadDigest: digest }));
  assert.deepEqual([rejected.stage, rejected.error, rejected.previewId, rejected.plan, rejected.text], ['failed', 'holdr-rejected', null, null, null]);
  const lapsed = withReceipt(accepted, runId, receipt({ acceptance: 'expired-unreviewed', payloadDigest: digest }));
  assert.deepEqual([lapsed.stage, lapsed.error], ['failed', 'review-expired']);
  assert.equal(withReceipt(planned, runId, receipt({ acceptance: 'accepted-uncommitted', ledger: 'committed', payloadDigest: digest })).stage, 'committed');
  // An older "accepted" answer keeps a newer plan.
  assert.equal(withReceipt(planned, runId, receipt({ acceptance: 'accepted-uncommitted', observationSetId: accepted.observationSetId, payloadDigest: digest })).stage, 'planned');
});

test('a stop aborts the signal that Holdr work began with: nothing begun before a stop is dispatched after it', async () => {
  const work = beginWork();
  const job = forIssuer(work, 'fake-chase');
  assert.equal(issuerHalt(job), null);
  stopIssuerWork('fake-chase', 'issuer-disabled', true);
  assert.equal(job.signal.aborted, true);
  assert.deepEqual(issuerHalt(job), { code: 'stopped', cause: 'issuer-disabled' });
  let dispatched = 0;
  const client = createHoldrClient({
    origin: 'http://holdr.e3.test',
    requireHttps: false,
    timeoutMs: 1_000,
    clientVersion: '0.1.0',
    signal: job.signal,
    fetchImpl: async () => {
      dispatched += 1;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const request = { runId: `run_${'a'.repeat(32)}`, previewId: `prv_${'b'.repeat(32)}`, payloadDigest: `pd1:${'c'.repeat(64)}`, planDigest: `pl1:${'d'.repeat(64)}` };
  assert.deepEqual(await client.commit(`hdv1_${'e'.repeat(64)}`, request), { ok: false, kind: 'aborted', status: null, code: null, issues: [] });
  assert.deepEqual(await client.submitObservation(`hdv1_${'e'.repeat(64)}`, request.runId, '{}', `crn_${'f'.repeat(32)}`), { ok: false, kind: 'aborted', status: null, code: null, issues: [] });
  assert.equal(dispatched, 0);
  unblockIssuer('fake-chase', issuerStopMark('fake-chase'));
});

test('the stop gate: a stop counts from the moment it is requested, for work already running and for work that starts before storage catches up', () => {
  const fresh = (adapterId: string) => issuerHalt(forIssuer(beginWork(), adapterId));
  // Work snapshots taken before any stop.
  const early = beginWork();
  const chase = forIssuer(early, 'fake-chase');
  const amex = forIssuer(early, 'fake-amex');

  // Disabling Chase: its running work stops, new Chase work is refused, Amex goes on and its requests are not aborted.
  const enableMark = issuerStopMark('fake-chase');
  stopIssuerWork('fake-chase', 'permission-revoked', true);
  assert.deepEqual(issuerHalt(chase), { code: 'stopped', cause: 'permission-revoked' });
  assert.equal(issuerHalt(amex), null);
  assert.equal(amex.signal.aborted, false);
  assert.deepEqual(fresh('fake-chase'), { code: 'issuer-not-enabled', cause: 'permission-revoked' });
  // A receipt check of a stopped issuer may start, but not one that was running at the stop.
  assert.equal(issuerHalt(forIssuer(beginWork(), 'fake-chase', false)), null);
  assert.deepEqual(issuerHalt(forIssuer(early, 'fake-chase', false)), { code: 'stopped', cause: 'permission-revoked' });

  // An enable that began before this stop does not lift it; one that began after does, but never revives work from before.
  unblockIssuer('fake-chase', enableMark);
  assert.deepEqual(fresh('fake-chase'), { code: 'issuer-not-enabled', cause: 'permission-revoked' });
  unblockIssuer('fake-chase', issuerStopMark('fake-chase'));
  assert.equal(fresh('fake-chase'), null);
  assert.deepEqual(issuerHalt(chase), { code: 'stopped', cause: 'permission-revoked' });

  // The kill switch: everything stops at once and nothing starts until the resume, after which only new work runs.
  const beforePause = beginWork();
  notePause(true);
  assert.equal(pausePending(), true);
  assert.equal(forIssuer(beforePause, 'fake-amex').signal.aborted, true);
  assert.deepEqual(issuerHalt(forIssuer(beforePause, 'fake-amex')), { code: 'stopped', cause: 'paused' });
  assert.deepEqual(fresh('fake-amex'), { code: 'paused', cause: 'paused' });
  assert.deepEqual(issuerHalt(forIssuer(beginWork(), 'fake-amex', false)), { code: 'paused', cause: 'paused' });
  notePause(false);
  assert.equal(pausePending(), false);
  assert.equal(fresh('fake-amex'), null);
  assert.deepEqual(issuerHalt(forIssuer(beforePause, 'fake-amex')), { code: 'stopped', cause: 'paused' });

  // Shape mode stops running work; new capture work of that issuer waits on the shape-mode flag (capture.ts), not on a block.
  const shapeWork = forIssuer(beginWork(), 'fake-amex');
  stopIssuerWork('fake-amex', 'shape-mode', false);
  noteShapeMode('fake-amex');
  assert.deepEqual(issuerHalt(shapeWork), { code: 'stopped', cause: 'shape-mode' });
  assert.equal(fresh('fake-amex'), null);
  assert.equal(inShapeMode('fake-amex'), true);
  assert.equal(inShapeMode('fake-chase'), false);
  noteShapeMode(null);
  assert.equal(inShapeMode('fake-amex'), false);
});

test('Q4: work stopped by a disable keeps that cause when the permission removal the disable causes stops the issuer again', () => {
  const upload = forIssuer(beginWork(), 'fake-citi');
  stopIssuerWork('fake-citi', 'issuer-disabled', true);
  stopIssuerWork('fake-citi', 'permission-revoked', true);
  assert.deepEqual(issuerHalt(upload), { code: 'stopped', cause: 'issuer-disabled' });
  // Work that began between the two stops is named by the one that stopped it.
  const between = beginWork();
  stopIssuerWork('fake-citi', 'shape-changed', true);
  assert.deepEqual(issuerHalt(forIssuer(between, 'fake-citi')), { code: 'stopped', cause: 'shape-changed' });
  // The kill switch first: work running then reports the pause, whatever stopped its issuer afterwards.
  const running = forIssuer(beginWork(), 'fake-citi');
  notePause(true);
  stopIssuerWork('fake-citi', 'issuer-disabled', true);
  assert.deepEqual(issuerHalt(running), { code: 'stopped', cause: 'paused' });
  notePause(false);
});

test('a stop that arrives while storage is read names the halt; storage alone names what it shows (Q4)', () => {
  const on = { enabled: true, consentVersion: FAKE_WELLS_FARGO.consentVersion, mainPassiveAccepted: false };
  const pausedOnShape = { enabled: false, consentVersion: 0, mainPassiveAccepted: false, shapeChangedVersion: FAKE_WELLS_FARGO.parserVersion };
  const granted = new Set([FAKE_WELLS_FARGO.hostPermission]);
  const job = () => forIssuer(beginWork(), 'fake-wf');
  // Storage alone (a change the gate never saw) names what it shows.
  assert.equal(haltAfterReads(job(), settings({ 'fake-wf': on }), granted, null), null);
  assert.deepEqual(haltAfterReads(job(), settings({ 'fake-wf': on }), new Set(), null), { code: 'issuer-not-enabled', cause: 'permission-revoked' });
  assert.deepEqual(haltAfterReads(job(), settings({ 'fake-wf': { ...on, enabled: false } }), granted, null), { code: 'issuer-not-enabled', cause: 'issuer-disabled' });
  assert.deepEqual(haltAfterReads(job(), settings({ 'fake-wf': pausedOnShape }), granted, null), { code: 'issuer-not-enabled', cause: 'shape-changed' });
  assert.deepEqual(haltAfterReads(job(), settings({ 'fake-wf': on }, true), granted, null), { code: 'paused', cause: 'paused' });
  const shape = { adapterId: 'fake-wf', startedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER, reports: [] };
  assert.deepEqual(haltAfterReads(job(), settings({ 'fake-wf': on }), granted, shape), { code: 'busy', cause: 'shape-mode' });
  // A receipt check is not gated on its issuer.
  assert.equal(haltAfterReads(forIssuer(beginWork(), 'fake-wf', false), settings({}), new Set(), null), null);

  // The site permission is removed while an upload's checks read storage, which then shows the issuer inactive:
  // Holdr hears site-permission-revoked, not a generic disable.
  const upload = job();
  stopIssuerWork('fake-wf', 'permission-revoked', true);
  assert.deepEqual(haltAfterReads(upload, settings({ 'fake-wf': on }), new Set(), null), { code: 'stopped', cause: 'permission-revoked' });
  // A disable meanwhile (its permission removal follows): the disable came first, so user-cancelled.
  unblockIssuer('fake-wf', issuerStopMark('fake-wf'));
  const send = job();
  stopIssuerWork('fake-wf', 'issuer-disabled', true);
  stopIssuerWork('fake-wf', 'permission-revoked', true);
  assert.deepEqual(haltAfterReads(send, settings({ 'fake-wf': { ...on, enabled: false } }), new Set(), null), { code: 'stopped', cause: 'issuer-disabled' });
  // A site change meanwhile: named by the drift, whatever storage shows by then.
  unblockIssuer('fake-wf', issuerStopMark('fake-wf'));
  const plan = job();
  stopIssuerWork('fake-wf', 'shape-changed', true);
  assert.deepEqual(haltAfterReads(plan, settings({ 'fake-wf': pausedOnShape }, true), granted, null), { code: 'stopped', cause: 'shape-changed' });
  unblockIssuer('fake-wf', issuerStopMark('fake-wf'));
});

test('a commit that may still land is released only by a receipt asked for after its plan expired at Holdr', () => {
  const runId = `run_${'a'.repeat(32)}`;
  const digest = `pd1:${'b'.repeat(64)}`;
  const expiresAt = '2026-10-17T12:00:00.000Z';
  const pinned = {
    stage: 'planned', text: null, expiresAt: null, digest, runId, observationSetId: `obs_${'c'.repeat(32)}`,
    previewId: `prv_${'d'.repeat(32)}`, planDigest: `pl1:${'e'.repeat(64)}`, committing: false, commitUncertain: true, error: null,
    plan: { counts: { insert: 1, update: 0, unchanged: 0, aliased: 0, matched: 0, attributed: 0, promoted: 0, corrected: 0, rejected: 0, unmatched: 0, superseded: 0 }, expiresAt },
  } as unknown as CaptureRecord;
  const accepted: Receipt = { runId, observationSetId: `obs_${'c'.repeat(32)}`, acceptance: 'accepted-uncommitted', ledger: 'none', payloadDigest: digest, acceptedAt: '2026-10-17T11:00:00.000Z', expiresAt: '2026-11-16T11:00:00.000Z' };
  const expiry = Date.parse(expiresAt);
  // Asked for before the plan's expiry (plus the clock margin): an answer stored much later still keeps the plan pinned.
  const early = withReceipt(pinned, runId, accepted, false, expiry);
  assert.deepEqual([early.stage, early.commitUncertain, early.error, early.previewId], ['planned', true, 'commit-pending', pinned.previewId]);
  // Asked for once the plan can no longer be committed: settled, back to planning.
  const late = withReceipt(pinned, runId, accepted, false, expiry + 10 * 60_000);
  assert.deepEqual([late.stage, late.commitUncertain, late.previewId, late.plan], ['accepted', false, null, null]);
});

test('a Retry-After of any length fits the collector status: at most a day, and the status still validates', () => {
  assert.equal(statusRetryAfter(172_800_000), MAX_RETRY_AFTER_MS);
  assert.equal(statusRetryAfter(3_600_000), 3_600_000);
  assert.equal(statusRetryAfter(-5), 0);
  assert.equal(statusRetryAfter(Number.NaN), null);
  assert.equal(statusRetryAfter(null), null);
  const status = {
    type: 'collector-status/v1',
    adapterId: 'fake-chase',
    seq: 3,
    streamHandle: `stm_${'a'.repeat(32)}`,
    pageState: 'activity',
    state: 'error',
    code: 'rate-limited',
    accounts: [],
    issues: [],
    retryAfterMs: statusRetryAfter(Number.MAX_SAFE_INTEGER),
  };
  assert.ok(parseStrictUnion(status, 'type', COLLECTOR_MESSAGES, { limits: BATCH_MESSAGE_LIMITS }).ok);
  assert.equal(parseStrictUnion({ ...status, retryAfterMs: MAX_RETRY_AFTER_MS + 1 }, 'type', COLLECTOR_MESSAGES, { limits: BATCH_MESSAGE_LIMITS }).ok, false);
});
