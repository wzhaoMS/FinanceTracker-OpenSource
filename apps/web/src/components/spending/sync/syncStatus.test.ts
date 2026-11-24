import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createOwnerClient } from './ownerClient';
import { DAY, FakeOwnerServer, HOUR, MINUTE, fakeOwnerTransport } from './fakeOwnerServer';
import type { Binding, OwnerState } from './ownerApi';
import {
  bindingStatus,
  expiryLevel,
  firstRunSteps,
  pastTime,
  quotaLevel,
  relativeTime,
  serverNow,
  worstQuota,
  type PrimaryStatus,
} from './syncStatus';
import { ABORT_TEXT, errorText, STATUS_TEXT } from './syncText';
import { OwnerApiError } from './ownerClient';
import { ABORT_REASONS } from './ownerApi';

async function demo(prepare: (server: FakeOwnerServer) => void = () => {}): Promise<{ state: OwnerState; now: number; server: FakeOwnerServer }> {
  const server = new FakeOwnerServer({ recentAuth: 'granted' });
  prepare(server);
  const state = await createOwnerClient(fakeOwnerTransport(server)).getState();
  return { state, now: Date.parse(state.generatedAt), server };
}

function statusOf(state: OwnerState, now: number, issuer: string) {
  const binding = state.bindings.find((item) => item.issuer === issuer) as Binding;
  return bindingStatus(binding, state, now);
}

describe('the §8 status list', () => {
  test('the demo shows one binding in each run state, with its flags', async () => {
    const { state, now } = await demo();
    const chase = statusOf(state, now, 'chase');
    assert.equal(chase.primary, 'awaiting-review');
    assert.deepEqual(chase.flags, []);
    const amex = statusOf(state, now, 'amex');
    assert.equal(amex.primary, 'plan-expired');
    assert.deepEqual(amex.flags, ['bank-sign-in', 'partial-coverage']);
    assert.equal(amex.reviewExpiry, 'week');
    const citi = statusOf(state, now, 'citi');
    assert.equal(citi.primary, 'awaiting-review');
    assert.deepEqual(citi.flags, ['rate-limited', 'partial-coverage']);
    assert.equal(citi.reviewExpiry, 'day');
    assert.equal(citi.tone, 'error');
    assert.equal(statusOf(state, now, 'wellsfargo').primary, 'send-unknown');
  });

  test('an open run is "captured, not sent"; once committed it is "plan applied"', async () => {
    const { state, now } = await demo((server) => {
      const wf = server.store.runs.find((run) => run.observationSetId === null && run.errorCode === null)!;
      wf.createdAt = server.now() - MINUTE;
      wf.runExpiresAt = server.now() + 9 * MINUTE;
      server.store.sets.find((set) => set.state === 'committed')!.acceptedAt = server.now();
      const chaseFresh = server.store.runs.find((run) => run.runId === server.store.sets[0].runId)!;
      chaseFresh.createdAt = server.now() - 20 * DAY;
      server.store.runs.find((run) => run.runId === server.store.sets[1].runId)!.createdAt = server.now() - MINUTE;
    });
    assert.equal(statusOf(state, now, 'wellsfargo').primary, 'captured-not-sent');
    assert.equal(statusOf(state, now, 'chase').primary, 'committed');
  });

  test('the run\'s own state decides: closed early is "send result unknown" at once, refused says so (Q36, R4)', async () => {
    const { server } = await demo();
    const owner = createOwnerClient(fakeOwnerTransport(server));
    const runId = server.startRun('chase');
    let state = await owner.getState();
    assert.equal(statusOf(state, Date.parse(state.generatedAt), 'chase').primary, 'captured-not-sent');
    // Holdr closed it (its browser was revoked, say) well within its 10 minutes.
    server.store.runs.find((run) => run.runId === runId)!.expiredAt = server.now();
    state = await owner.getState();
    assert.equal(statusOf(state, Date.parse(state.generatedAt), 'chase').primary, 'send-unknown');
    server.advance(MINUTE);
    server.startRun('chase', null, 'card-data');
    state = await owner.getState();
    const refused = statusOf(state, Date.parse(state.generatedAt), 'chase');
    assert.deepEqual([refused.primary, refused.tone, refused.stopped], ['refused', 'warn', null]);
    assert.equal(STATUS_TEXT.refused.label, 'Refused by Holdr');
  });

  test('a binding confirmed again without its browser asks to allow one again, not to pair again (Q35)', async () => {
    const { server } = await demo();
    const owner = createOwnerClient(fakeOwnerTransport(server));
    const chase = (await owner.getState()).bindings.find((item) => item.issuer === 'chase')!;
    await owner.confirmBinding(chase.bindingId, {
      expectedVersion: chase.bindingVersion, bindingLabel: chase.bindingLabel, regrantDeviceIds: [],
      scopes: chase.scopes.filter((scope) => scope.kind === 'known')
        .map((scope) => ({ cardScopeId: scope.cardScopeId, scopeLabel: scope.scopeLabel, holderAlias: scope.holderAlias as 'alex', last4: scope.last4 })),
    });
    let state = await owner.getState();
    const status = statusOf(state, Date.parse(state.generatedAt), 'chase');
    assert.deepEqual([status.primary, status.tone], ['regrant-needed', 'warn']);
    const laptop = state.devices.find((device) => device.staleBindingIds.includes(chase.bindingId))!;
    await owner.regrantDevice(laptop.deviceId, [chase.bindingId]);
    state = await owner.getState();
    assert.equal(statusOf(state, Date.parse(state.generatedAt), 'chase').primary, 'awaiting-review');
  });

  test('an expired review asks for a new capture', async () => {
    const { server } = await demo();
    server.advance(5 * HOUR);
    const state = await createOwnerClient(fakeOwnerTransport(server)).getState();
    assert.equal(statusOf(state, Date.parse(state.generatedAt), 'citi').primary, 'review-expired');
  });

  test('paused wins over everything, and says why', async () => {
    const { state, now } = await demo((server) => {
      server.core.pause();
      server.core.disableIssuer('amex');
      server.setGate('blocked');
      server.setDeviceApi('disabled');
    });
    const amex = statusOf(state, now, 'amex');
    assert.equal(amex.primary, 'paused');
    assert.deepEqual(amex.pauseReasons, ['server-paused', 'issuer-off', 'gate-blocked', 'device-api-off']);
    assert.deepEqual(statusOf(state, now, 'chase').pauseReasons, ['server-paused', 'gate-blocked', 'device-api-off']);
  });

  test('after a restore every binding is paused until it is confirmed again', async () => {
    const server = new FakeOwnerServer({ scenario: 'restored' });
    const state = await createOwnerClient(fakeOwnerTransport(server)).getState();
    for (const binding of state.bindings) {
      const status = bindingStatus(binding, state, Date.parse(state.generatedAt));
      assert.equal(status.primary, 'paused');
      assert.ok(status.pauseReasons.includes('needs-reconfirmation'));
    }
  });

  test('no active device: "not set up" before any pairing or while one waits for approval, "no working device" after', async () => {
    const { state, now } = await demo((server) => {
      server.core.revokeDevice(server.store.devices[1].deviceId);
    });
    assert.equal(statusOf(state, now, 'citi').primary, 'no-device');
    const fresh = new FakeOwnerServer({ scenario: 'fresh', recentAuth: 'granted' });
    const owner = createOwnerClient(fakeOwnerTransport(fresh));
    await owner.enableIssuer('chase', { expectedVersion: 1, mainWorldAcknowledged: false });
    const binding = await owner.createBinding({
      issuer: 'chase', source: 'chase-api', cardAccountRef: fresh.store.cardAccounts[0].id, bindingLabel: 'Chase', scopes: [{ scopeLabel: 'Card', holderAlias: 'alex', last4: '3391' }],
    });
    let freshState = await owner.getState();
    assert.equal(bindingStatus(freshState.bindings[0], freshState, Date.parse(freshState.generatedAt)).primary, 'not-set-up');
    await owner.createPairing({ bindingIds: [binding.bindingId], replacesDeviceId: null });
    const device = fresh.redeemOpenPairing();
    freshState = await owner.getState();
    assert.equal(bindingStatus(freshState.bindings[0], freshState, Date.parse(freshState.generatedAt)).primary, 'not-set-up');
    const pairing = freshState.pairings.find((item) => item.status === 'redeemed')!;
    await owner.approvePairing(pairing.pairingId, device);
    freshState = await owner.getState();
    assert.equal(bindingStatus(freshState.bindings[0], freshState, Date.parse(freshState.generatedAt)).primary, 'waiting-activity');
  });

  test('a device past its 30 days counts as gone even before Holdr marks it', async () => {
    const { state, now } = await demo();
    const later = now + 3 * DAY;
    assert.equal(bindingStatus(state.bindings.find((item) => item.issuer === 'wellsfargo')!, state, later).primary, 'no-device');
  });

  test('a run the extension stopped names its cause (Q4) instead of "send result unknown"', async () => {
    const certificate = await demo((server) => { server.startRun('wellsfargo', 'certificate-error'); });
    const wf = statusOf(certificate.state, certificate.now, 'wellsfargo');
    assert.equal(wf.primary, 'stopped');
    assert.equal(wf.stopped, 'certificate-error');
    assert.equal(wf.tone, 'error');
    const cancelled = await demo((server) => { server.startRun('wellsfargo', 'user-cancelled'); });
    assert.deepEqual([statusOf(cancelled.state, cancelled.now, 'wellsfargo').primary, statusOf(cancelled.state, cancelled.now, 'wellsfargo').tone], ['stopped', 'info']);
    // The demo's older stopped run doesn't hide the newer one Holdr never heard back from.
    const { state, now } = await demo();
    assert.deepEqual([statusOf(state, now, 'wellsfargo').primary, statusOf(state, now, 'wellsfargo').stopped], ['send-unknown', null]);
    // A run without a reason that is still open stays "captured, not sent".
    const open = await demo((server) => { server.startRun('wellsfargo'); });
    assert.equal(statusOf(open.state, open.now, 'wellsfargo').primary, 'captured-not-sent');
  });

  test('every status and flag has a label and a safe next step', () => {
    const statuses: PrimaryStatus[] = [
      'not-set-up', 'paused', 'no-device', 'regrant-needed', 'waiting-activity', 'captured-not-sent', 'send-unknown', 'stopped', 'refused',
      'awaiting-review', 'plan-expired', 'review-expired', 'committed',
    ];
    for (const status of statuses) assert.ok(STATUS_TEXT[status].next.length > 20, status);
    // Safety warnings stay in what a card shows: its next step or the short lines under it.
    const shown = (text: { next: string; more: readonly string[] }) => [text.next, ...text.more].join(' ');
    assert.match(shown(STATUS_TEXT['send-unknown']), /Never switch to HTTP or ignore a certificate error/);
    for (const reason of ABORT_REASONS) assert.ok(ABORT_TEXT[reason].label.startsWith('Stopped: ') && ABORT_TEXT[reason].next.length > 20, reason);
    assert.match(shown(ABORT_TEXT['certificate-error']), /Never switch to HTTP or ignore a certificate error/);
    for (const reason of ABORT_REASONS) assert.match(shown(ABORT_TEXT[reason]), /Nothing was sent\./, reason);
    assert.match(ABORT_TEXT['unknown-page-structure'].next, /import the redacted offline file/);
    assert.match(ABORT_TEXT['site-permission-revoked'].next, /extension popup/);
  });
});

describe('clocks, expiry and quota', () => {
  test('"now" comes from the server and moves with the time since the answer', () => {
    assert.equal(serverNow({ generatedAt: '2026-10-17T12:00:00.000Z' }, 1_000, 61_000), Date.parse('2026-10-17T12:01:00.000Z'));
    assert.equal(serverNow({ generatedAt: '2026-10-17T12:00:00.000Z' }, 1_000, 0), Date.parse('2026-10-17T12:00:00.000Z'));
  });

  test('expiry levels: 7 days and 1 day before, then expired', () => {
    const now = Date.parse('2026-10-17T12:00:00.000Z');
    assert.equal(expiryLevel('2026-10-30T12:00:00.000Z', now), 'later');
    assert.equal(expiryLevel('2026-10-24T12:00:00.000Z', now), 'week');
    assert.equal(expiryLevel('2026-10-18T11:00:00.000Z', now), 'day');
    assert.equal(expiryLevel('2026-10-17T12:00:00.000Z', now), 'expired');
    assert.equal(relativeTime('2026-10-22T12:00:00.000Z', now), 'in 5 days');
    assert.equal(relativeTime('2026-10-17T08:00:00.000Z', now), '4 hours ago');
    assert.equal(relativeTime('2026-10-17T12:00:30.000Z', now), 'in a moment');
    // Something that already happened never reads as still to come, even when Holdr stamped it a little ahead.
    assert.equal(pastTime('2026-10-17T12:00:30.000Z', now), 'just now');
    assert.equal(pastTime('2026-10-17T12:00:00.000Z', now), 'just now');
    assert.equal(pastTime('2026-10-17T08:00:00.000Z', now), '4 hours ago');
  });

  test('quota warns at 80% and stops at the limit', async () => {
    assert.equal(quotaLevel({ used: 79, limit: 100 }), 'ok');
    assert.equal(quotaLevel({ used: 80, limit: 100 }), 'high');
    assert.equal(quotaLevel({ used: 100, limit: 100 }), 'full');
    const { state } = await demo();
    const amexAccount = state.bindings.find((item) => item.issuer === 'amex')!.cardAccountRef;
    assert.equal(worstQuota(state.quota.cardAccounts.find((item) => item.cardAccountRef === amexAccount)!), 'high');
    assert.equal(worstQuota(state.quota.global), 'ok');
  });

  test('first-run steps follow what Holdr can see; the extension\'s own step is never marked', async () => {
    const { state, now } = await demo();
    assert.deepEqual(firstRunSteps(state, now).map((step) => [step.id, step.done]), [
      ['binding', true], ['pair', true], ['extension', null], ['activity', true], ['send', true], ['review', true], ['auto', false],
    ]);
    const fresh = await createOwnerClient(fakeOwnerTransport(new FakeOwnerServer({ scenario: 'fresh' }))).getState();
    assert.ok(firstRunSteps(fresh, Date.parse(fresh.generatedAt)).every((step) => step.done !== true));
  });
});

describe('failure texts', () => {
  test('every failure gives a safe next step and never a value', () => {
    const cases = [
      new OwnerApiError('unavailable', 404),
      new OwnerApiError('network'),
      new OwnerApiError('invalid-answer', 200),
      new OwnerApiError('http', 409, 'version-conflict', { currentVersion: 3 }),
      new OwnerApiError('http', 409, 'sync-paused'),
      new OwnerApiError('http', 409, 'authorization-blocked'),
      new OwnerApiError('http', 409, 'fingerprint-mismatch'),
      new OwnerApiError('http', 410, 'plan-expired'),
      new OwnerApiError('http', 410, 'observation-expired'),
      new OwnerApiError('http', 410, 'receipt-expired'),
      new OwnerApiError('http', 429, 'rate-limited', { retryAfterSeconds: 30 }),
      new OwnerApiError('http', 500, null),
      new OwnerApiError('http', 409, 'gate-closed'),
    ];
    for (const error of cases) {
      const text = errorText(error);
      assert.ok(text.message.length > 0 && text.next.length > 0, error.message);
    }
    assert.match(errorText(cases[6]).next, /Don't approve/);
    assert.match(errorText(cases[10]).next, /30 seconds/);
    assert.match(errorText(cases[0]).message, /doesn't support extension sync yet/);
    assert.match(errorText(cases[12]).message, /hasn't opened automatic sending/);
  });
});
