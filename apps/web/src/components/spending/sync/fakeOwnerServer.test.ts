import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createOwnerClient, isOwnerApiError, type CardSyncOwnerClient } from './ownerClient';
import { DAY, FAKE_OWNER_PASSWORD, FakeOwnerServer, LEDGER_STORY_IDS, MINUTE, fakeOwnerTransport } from './fakeOwnerServer';
import * as api from './ownerApi';
import type { Decision, OwnerErrorCode, SetDetail, TransactionSources } from './ownerApi';
import { addIdentity, changeValues, createRow, emptyLedger, eventsCursor, identityIdFor, keysetCursor, mergeRow, recordUserEdit, removeRow, revertibleEvent } from './fake/ledger';
import { cardTransactionIdFor, itemsCursor, itemsPinOf, pageCursor } from './fake/model';

function setup(options: ConstructorParameters<typeof FakeOwnerServer>[0] = {}) {
  const server = new FakeOwnerServer({ recentAuth: 'granted', ...options });
  return { server, owner: createOwnerClient(fakeOwnerTransport(server), 'mock') };
}

async function refused(promise: Promise<unknown>, code: OwnerErrorCode, status?: number): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(isOwnerApiError(error), 'an OwnerApiError');
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
}

async function openSet(owner: CardSyncOwnerClient, issuer: string): Promise<SetDetail> {
  const state = await owner.getState();
  const binding = state.bindings.find((item) => item.issuer === issuer)!;
  return owner.getObservationSet(binding.sync.lastRun!.observationSetId!);
}

/** One allowed decision per item: the first action whose parameters the item can supply. */
function decideAll(set: SetDetail, knownScope: string): Decision[] {
  return set.items.map((entry) => {
    const action = entry.allowedActions.includes('insert-new') ? 'insert-new' : entry.allowedActions[0];
    return {
      itemId: entry.itemId,
      action,
      // Only a link names a transaction (E1b ck_rvw_draft_shape); a correction's row is the one its stored identity names.
      transactionId: null,
      cardScopeId: action === 'attribute' ? knownScope : null,
    };
  });
}

/**
 * E1b `ck_evt_*`, as far as the fake's records show them: every event the fake wrote keeps a reason its own type allows (a
 * compound match's `restored` and `attributed` included) and the statuses its type moves between.
 */
function assertEventsHoldTogether(server: FakeOwnerServer): void {
  for (const event of server.store.ledger.events) {
    const label = `${event.eventType} (${event.reason}) on ${event.transactionId}`;
    assert.ok(api.EVENT_REASONS[event.eventType].includes(event.reason), label);
    const from = event.from?.status ?? null;
    const to = event.to?.status ?? null;
    const live = (status: string | null) => status === 'pending' || status === 'posted';
    switch (event.eventType) {
      case 'created':
        assert.ok(from === null && live(to), label);
        break;
      case 'promoted':
        assert.ok((from === 'pending' || from === 'removed') && to === 'posted', label);
        break;
      case 'corrected':
        assert.ok(from !== null && live(to), label);
        break;
      case 'restored':
        assert.ok(from === 'removed' && live(to), label);
        break;
      case 'removed':
      case 'superseded':
      case 'settled-into':
        assert.ok(live(from) && to === 'removed', label);
        break;
      case 'attributed':
        assert.ok(event.from !== null && event.to !== null && event.from.cardScopeId !== event.to.cardScopeId, label);
        break;
      case 'identity-repointed':
        assert.ok(event.relatedTransactionId !== null && event.relatedTransactionId !== event.transactionId, label);
        assert.ok(event.causeEventId !== null || event.reason === 'adjustment' || event.reason === 'maintenance', label);
        break;
      case 'reversed':
        assert.ok(event.reversesEventId !== null && from !== null && to !== null, label);
        break;
      default:
        break;
    }
  }
}

describe('pairing and devices (plan §6.1)', () => {
  test('invite → extension redeems → compare the code → approve: active for 30 days, once', async () => {
    const { server, owner } = setup({ scenario: 'fresh' });
    const created = await owner.createBinding({
      issuer: 'chase', source: 'chase-api', cardAccountRef: server.store.cardAccounts[0].id, bindingLabel: 'Chase Sapphire',
      scopes: [{ scopeLabel: "Alex's card", holderAlias: 'alex', last4: '3391' }],
    });
    assert.deepEqual(created.scopes.map((scope) => scope.kind), ['known', 'unknown']);
    // E1b §5.3: a bank never turned on has no approved contract to pair under.
    await refused(owner.createPairing({ bindingIds: [created.bindingId], replacesDeviceId: null }), 'contract-unsupported', 409);
    const on = await owner.enableIssuer('chase', { expectedVersion: server.store.settingsVersion, mainWorldAcknowledged: false });
    await owner.disableIssuer('chase');
    assert.equal(on.issuers.find((item) => item.issuer === 'chase')!.enabled, true);
    // Turning it off again keeps the contract approved, so pairing still works (the browser just can't send meanwhile).
    const invite = await owner.createPairing({ bindingIds: [created.bindingId], replacesDeviceId: null });
    assert.match(invite.pairingCode, /^[a-p]{32}$/);
    assert.equal(invite.pairing.status, 'open');
    assert.equal(invite.pairing.expiresAt, '2026-10-17T12:05:00.000Z');
    await refused(owner.approvePairing(invite.pairing.pairingId, { deviceId: `dev_${'a'.repeat(32)}`, fingerprint: 'aaaa-bbbb-cccc-dddd' }), 'pairing-not-redeemed');

    const redeemed = server.redeemOpenPairing('Laptop Chrome');
    const state = await owner.getState();
    const pairing = state.pairings.find((item) => item.pairingId === invite.pairing.pairingId)!;
    assert.equal(pairing.status, 'redeemed');
    assert.equal(pairing.fingerprint, redeemed.fingerprint);
    await refused(owner.approvePairing(pairing.pairingId, { deviceId: redeemed.deviceId, fingerprint: 'aaaa-bbbb-cccc-dddd' }), 'fingerprint-mismatch');

    const approved = await owner.approvePairing(pairing.pairingId, { deviceId: redeemed.deviceId, fingerprint: redeemed.fingerprint });
    assert.equal(approved.device.status, 'active');
    assert.equal(approved.device.deviceExpiresAt, new Date(Date.parse('2026-10-17T12:00:00.000Z') + 30 * DAY).toISOString());
    const again = await owner.approvePairing(pairing.pairingId, { deviceId: redeemed.deviceId, fingerprint: redeemed.fingerprint });
    assert.equal(again.device.approvedAt, approved.device.approvedAt);
  });

  test('a new invite cancels the open one; an unapproved device lapses after 10 minutes', async () => {
    const { server, owner } = setup();
    const chase = server.store.bindings[0].bindingId;
    const first = await owner.createPairing({ bindingIds: [chase], replacesDeviceId: null });
    const second = await owner.createPairing({ bindingIds: [chase], replacesDeviceId: null });
    let state = await owner.getState();
    assert.equal(state.pairings.find((item) => item.pairingId === first.pairing.pairingId)!.status, 'cancelled');
    const device = server.redeemOpenPairing('Spare Chrome');
    server.advance(11 * MINUTE);
    await refused(owner.approvePairing(second.pairing.pairingId, { deviceId: device.deviceId, fingerprint: device.fingerprint }), 'pairing-expired', 410);
    state = await owner.getState();
    // E1b §5.9: expired, not revoked, with no reason; when it lapsed stays readable.
    const lapsed = state.devices.find((item) => item.deviceId === device.deviceId)!;
    assert.deepEqual([lapsed.status, lapsed.revokeReason, lapsed.revokedAt, lapsed.approvedAt], ['expired', null, null, null]);
    assert.equal(Date.parse(lapsed.pendingExpiresAt!) - Date.parse(lapsed.createdAt), 10 * MINUTE);
    assert.equal(state.pairings.find((item) => item.pairingId === second.pairing.pairingId)!.status, 'expired');
  });

  test('reject and revoke are idempotent, need no password and work while blocked', async () => {
    const { server, owner } = setup({ recentAuth: 'required' });
    server.store.recentAuthUntil = Number.MAX_SAFE_INTEGER;
    const invite = await owner.createPairing({ bindingIds: [server.store.bindings[0].bindingId], replacesDeviceId: null });
    const device = server.redeemOpenPairing('Spare Chrome');
    server.store.recentAuthUntil = 0;
    server.setGate('blocked');
    const rejected = await owner.rejectPairing(invite.pairing.pairingId, device.deviceId);
    assert.equal(rejected.device.revokeReason, 'rejected');
    await owner.rejectPairing(invite.pairing.pairingId, device.deviceId);
    const active = server.store.devices.find((item) => item.status === 'active')!;
    const revoked = await owner.revokeDevice(active.deviceId);
    assert.equal(revoked.revokeReason, 'owner');
    assert.equal((await owner.revokeDevice(active.deviceId)).revokedAt, revoked.revokedAt);
  });

  test('revoking a device blocks its open sets for a source review, and approval rotates a replaced device', async () => {
    const { server, owner } = setup();
    const laptop = server.store.devices[0];
    const invite = await owner.createPairing({ bindingIds: laptop.bindingIds, replacesDeviceId: laptop.deviceId });
    const device = server.redeemOpenPairing('Laptop Chrome');
    await owner.approvePairing(invite.pairing.pairingId, device);
    const state = await owner.getState();
    assert.equal(state.devices.find((item) => item.deviceId === laptop.deviceId)!.revokeReason, 'rotated');
    const chaseSet = await openSet(owner, 'chase');
    assert.equal(chaseSet.state, 'blocked-review');
    await refused(owner.preparePlan(chaseSet.observationSetId, { expectedVersion: chaseSet.version, sourceReviewed: false }), 'source-review-required');
    const plan = await owner.preparePlan(chaseSet.observationSetId, { expectedVersion: chaseSet.version, sourceReviewed: true });
    assert.equal(plan.counts.insert, 4);
  });

  test('the deployment switch and the gate close pairing; pause and gate close plans', async () => {
    const { server, owner } = setup();
    const chase = server.store.bindings[0].bindingId;
    server.setDeviceApi('disabled');
    await refused(owner.createPairing({ bindingIds: [chase], replacesDeviceId: null }), 'device-api-disabled');
    server.setDeviceApi('enabled');
    server.setGate('blocked');
    await refused(owner.createPairing({ bindingIds: [chase], replacesDeviceId: null }), 'authorization-blocked');
    await refused(owner.resume(server.store.settingsVersion), 'authorization-blocked');
    server.setGate('open');
    await owner.pause();
    const set = await openSet(owner, 'chase');
    await refused(owner.preparePlan(set.observationSetId, { expectedVersion: set.version, sourceReviewed: false }), 'sync-paused');
    const discarded = await owner.discardObservationSet(set.observationSetId, { expectedVersion: set.version, reason: 'not-mine' });
    assert.equal(discarded.state, 'rejected');
  });
});

describe('settings and bindings', () => {
  test('pause is idempotent; resume and enabling an issuer need the password and the current version', async () => {
    const { server, owner } = setup({ recentAuth: 'required' });
    const paused = await owner.pause();
    assert.equal((await owner.pause()).settingsVersion, paused.settingsVersion);
    await refused(owner.resume(paused.settingsVersion), 'recent-auth-required', 403);
    server.store.recentAuthUntil = Number.MAX_SAFE_INTEGER;
    await refused(owner.resume(paused.settingsVersion - 1), 'version-conflict');
    const resumed = await owner.resume(paused.settingsVersion);
    assert.equal(resumed.paused, false);
    const off = await owner.disableIssuer('citi');
    await refused(owner.enableIssuer('citi', { expectedVersion: off.settingsVersion, mainWorldAcknowledged: false }), 'invalid-request', 422);
    const on = await owner.enableIssuer('citi', { expectedVersion: off.settingsVersion, mainWorldAcknowledged: true });
    assert.equal(on.issuers.find((item) => item.issuer === 'citi')!.enabled, true);
  });

  test('one binding per card account and source; the issuer must match', async () => {
    const { server, owner } = setup();
    const [sapphire, gold, , , freedom] = server.store.cardAccounts;
    const scopes = [{ scopeLabel: 'Card', holderAlias: 'alex' as const, last4: '5500' }];
    await refused(owner.createBinding({ issuer: 'chase', source: 'chase-api', cardAccountRef: sapphire.id, bindingLabel: 'Again', scopes }), 'binding-exists');
    await refused(owner.createBinding({ issuer: 'chase', source: 'chase-api', cardAccountRef: gold.id, bindingLabel: 'Wrong', scopes }), 'card-account-mismatch');
    await refused(owner.createBinding({ issuer: 'chase', source: 'amex-api-recent', cardAccountRef: freedom.id, bindingLabel: 'Wrong', scopes }), 'card-account-mismatch');
    const created = await owner.createBinding({ issuer: 'chase', source: 'chase-api', cardAccountRef: freedom.id, bindingLabel: 'Chase Freedom', scopes });
    assert.equal(created.bindingVersion, 1);
  });

  test('re-confirming keeps scope ids, refuses a changed last four, retires what is left out and adds new cards', async () => {
    const { owner } = setup();
    const chase = (await owner.getState()).bindings.find((item) => item.issuer === 'chase')!;
    const [alex, casey] = chase.scopes;
    await refused(owner.confirmBinding(chase.bindingId, {
      expectedVersion: chase.bindingVersion, bindingLabel: chase.bindingLabel,
      scopes: [{ cardScopeId: alex.cardScopeId, scopeLabel: alex.scopeLabel, holderAlias: 'alex', last4: '9999' }], regrantDeviceIds: [],
    }), 'invalid-request');
    const confirmed = await owner.confirmBinding(chase.bindingId, {
      expectedVersion: chase.bindingVersion, bindingLabel: 'Chase Sapphire Reserve',
      scopes: [
        { cardScopeId: alex.cardScopeId, scopeLabel: 'Alex', holderAlias: 'alex', last4: alex.last4 },
        { cardScopeId: null, scopeLabel: 'Replacement card', holderAlias: 'casey', last4: '8812' },
      ],
      regrantDeviceIds: [],
    });
    assert.equal(confirmed.bindingVersion, chase.bindingVersion + 1);
    assert.equal(confirmed.scopes.find((scope) => scope.cardScopeId === casey.cardScopeId)!.status, 'retired');
    assert.equal(confirmed.scopes.filter((scope) => scope.kind === 'known' && scope.status === 'active').length, 2);
    assert.equal(confirmed.scopes.at(-1)!.kind, 'unknown');
  });

  test('after a restore (R1): every device revoked, syncing paused, issuers off, bindings to re-confirm, open sets in recovery review', async () => {
    const { server, owner } = setup({ scenario: 'restored' });
    const state = await owner.getState();
    assert.ok(state.recoveredAt);
    assert.ok(state.devices.filter((device) => device.revokeReason === 'recovery').length >= 2);
    assert.ok(state.devices.every((device) => device.status !== 'active'));
    assert.equal(state.settings.paused, true, 'E1b §5.8');
    assert.ok(state.settings.issuers.every((issuer) => !issuer.enabled));
    assert.ok(state.bindings.every((binding) => binding.status === 'needs-reconfirmation' && binding.statusReason === 'restored-from-backup'));
    const chase = state.bindings.find((item) => item.issuer === 'chase')!;
    await refused(owner.createPairing({ bindingIds: [chase.bindingId], replacesDeviceId: null }), 'binding-needs-reconfirmation');
    const set = await owner.getObservationSet(chase.sync.lastRun!.observationSetId!);
    assert.equal(set.state, 'recovery-review');
    const known = chase.scopes.filter((scope) => scope.kind === 'known');
    await owner.confirmBinding(chase.bindingId, {
      expectedVersion: chase.bindingVersion, bindingLabel: chase.bindingLabel,
      scopes: known.map((scope) => ({ cardScopeId: scope.cardScopeId, scopeLabel: scope.scopeLabel, holderAlias: scope.holderAlias as 'alex', last4: scope.last4 })),
      regrantDeviceIds: [],
    });
    const settings = await owner.enableIssuer('chase', { expectedVersion: server.store.settingsVersion, mainWorldAcknowledged: false });
    assert.equal(settings.issuers.find((item) => item.issuer === 'chase')!.enabled, true);
    await refused(owner.preparePlan(set.observationSetId, { expectedVersion: set.version, sourceReviewed: true }), 'sync-paused');
    await owner.resume(server.store.settingsVersion);
    await refused(owner.preparePlan(set.observationSetId, { expectedVersion: set.version, sourceReviewed: false }), 'source-review-required');
    const plan = await owner.preparePlan(set.observationSetId, { expectedVersion: set.version, sourceReviewed: true });
    await owner.commitPlan(plan.previewId, plan);
  });
});

describe('the durable review queue (plan §6.4, §7.2–7.4)', () => {
  test('every item needs a decision; the plan shows what changes; commit is atomic and idempotent', async () => {
    const { owner } = setup();
    const amex = await openSet(owner, 'amex');
    assert.equal(amex.state, 'needs-review');
    assert.deepEqual(new Set(amex.items.map((entry) => entry.category)), new Set(['cross-source-similar', 'no-stable-id', 'scope-unknown', 'pending-link']));
    await refused(owner.preparePlan(amex.observationSetId, { expectedVersion: amex.version, sourceReviewed: false }), 'decisions-incomplete');

    const legacy = amex.items.find((entry) => entry.candidates[0]?.scopeKind === 'legacy')!;
    const blocked = amex.items.find((entry) => entry.candidates[0]?.blockedReason === 'different-known-cards')!;
    await refused(owner.recordDecisions(amex.observationSetId, {
      expectedVersion: amex.version,
      decisions: [{ itemId: blocked.itemId, action: 'same-transaction', transactionId: blocked.candidates[0].transactionId, cardScopeId: null }],
    }), 'action-not-allowed');
    const pending = amex.items.find((entry) => entry.category === 'pending-link')!;
    const unknown = amex.items.find((entry) => entry.category === 'scope-unknown')!;
    const state = await owner.getState();
    const basic = state.bindings.find((item) => item.issuer === 'amex')!.scopes[0].cardScopeId;
    const decided = await owner.recordDecisions(amex.observationSetId, {
      expectedVersion: amex.version,
      decisions: decideAll(amex, basic).map((decision) => {
        if (decision.itemId === legacy.itemId) return { ...decision, action: 'attribute-and-link', transactionId: legacy.candidates[0].transactionId, cardScopeId: legacy.observation!.cardScopeId };
        if (decision.itemId === pending.itemId) return { ...decision, action: 'same-transaction', transactionId: pending.candidates[0].transactionId };
        if (decision.itemId === unknown.itemId) return { ...decision, action: 'attribute', cardScopeId: basic };
        return decision;
      }),
    });
    assert.equal(decided.version, amex.version + 1);
    const plan = await owner.preparePlan(amex.observationSetId, { expectedVersion: decided.version, sourceReviewed: false });
    // E1b §4.8: the legacy link matches and attributes, attributing an unknown row inserts and attributes, and linking the
    // posted row to its pending charge is a match that promotes (and so updates values).
    assert.deepEqual(
      { insert: plan.counts.insert, attributed: plan.counts.attributed, promoted: plan.counts.promoted, matched: plan.counts.matched, update: plan.counts.update },
      { insert: 4, attributed: 2, promoted: 1, matched: 2, update: 1 },
    );
    const attribute = plan.effects.find((effect) => effect.effect === 'attribute')!;
    assert.equal(attribute.before!.cardScopeId, legacy.candidates[0].cardScopeId);
    assert.equal(attribute.after!.cardScopeId, legacy.observation!.cardScopeId);
    assert.equal(plan.expiresAt, '2026-10-17T12:10:00.000Z');

    await refused(owner.commitPlan(plan.previewId, { payloadDigest: plan.payloadDigest, planDigest: `pl1:${'b'.repeat(64)}` }), 'plan-mismatch');
    const committed = await owner.commitPlan(plan.previewId, plan);
    assert.equal(committed.counts.insert, 4);
    assert.deepEqual(await owner.commitPlan(plan.previewId, plan), committed);
    const after = await owner.getObservationSet(amex.observationSetId);
    assert.equal(after.state, 'committed');
    assert.ok(after.items.every((entry) => entry.committed !== null && entry.decision === null));
  });

  test('a plan lasts 10 minutes; a new one is a new plan, never an extension', async () => {
    const { server, owner } = setup();
    const chase = await openSet(owner, 'chase');
    const first = await owner.preparePlan(chase.observationSetId, { expectedVersion: chase.version, sourceReviewed: false });
    server.advance(11 * MINUTE);
    await refused(owner.commitPlan(first.previewId, first), 'plan-expired', 410);
    const second = await owner.preparePlan(chase.observationSetId, { expectedVersion: chase.version, sourceReviewed: false });
    assert.notEqual(second.previewId, first.previewId);
    assert.equal(second.planDigest, first.planDigest);
    await refused(owner.commitPlan(first.previewId, first), 'plan-expired');
    await owner.commitPlan(second.previewId, second);
  });

  test('a decision recorded after the plan makes the plan stale', async () => {
    const { owner } = setup();
    const citi = await openSet(owner, 'citi');
    const decided = await owner.recordDecisions(citi.observationSetId, { expectedVersion: citi.version, decisions: decideAll(citi, '') });
    const plan = await owner.preparePlan(citi.observationSetId, { expectedVersion: decided.version, sourceReviewed: false });
    const correction = decided.items.find((entry) => entry.category === 'posted-correction')!;
    await owner.recordDecisions(citi.observationSetId, {
      expectedVersion: decided.version,
      decisions: [{ itemId: correction.itemId, action: 'keep-current', transactionId: null, cardScopeId: null }],
    });
    await refused(owner.commitPlan(plan.previewId, plan), 'preview-stale');
  });

  test('observations expire after 30 days whatever happens: nothing to confirm, nothing added', async () => {
    const { server, owner } = setup();
    const citi = await openSet(owner, 'citi');
    server.advance(5 * 60 * MINUTE);
    const expired = await owner.getObservationSet(citi.observationSetId);
    assert.equal(expired.state, 'expired-unreviewed');
    assert.deepEqual(expired.items, []);
    await refused(owner.preparePlan(citi.observationSetId, { expectedVersion: expired.version, sourceReviewed: false }), 'observation-expired', 410);
    const state = await owner.getState();
    assert.equal(state.bindings.find((item) => item.issuer === 'citi')!.sync.lastRun!.acceptance, 'expired-unreviewed');
  });

  test('changing a committed decision is a new plan that unlinks and adds, and deletes nothing', async () => {
    const { server, owner } = setup();
    const committedSet = server.store.sets.find((set) => set.state === 'committed')!;
    const set = await owner.getObservationSet(committedSet.observationSetId);
    const entry = set.items[0];
    assert.equal(entry.committed!.action, 'same-transaction');
    await refused(owner.preparePlan(set.observationSetId, { expectedVersion: set.version, sourceReviewed: false }), 'decisions-incomplete');
    const changed = await owner.recordDecisions(set.observationSetId, {
      expectedVersion: set.version,
      decisions: [{ itemId: entry.itemId, action: 'insert-new', transactionId: null, cardScopeId: null }],
    });
    const plan = await owner.preparePlan(set.observationSetId, { expectedVersion: changed.version, sourceReviewed: false });
    assert.deepEqual(plan.effects.map((effect) => effect.effect), ['unmatch', 'insert']);
    assert.equal(plan.counts.unchanged, 1);
    await owner.commitPlan(plan.previewId, plan);
    const after = await owner.getObservationSet(set.observationSetId);
    assert.equal(after.items[0].committed!.action, 'insert-new');
    assert.equal(after.rowCount, set.rowCount);
  });

  test('discarding frees the quota and the exact object; committed sets are changed by decisions, not discarded', async () => {
    const { server, owner } = setup();
    const before = (await owner.getState()).quota.global.sets.used;
    const chase = await openSet(owner, 'chase');
    const runId = chase.runId!;
    assert.equal((await owner.getSentPayload(runId)).observationSetId, chase.observationSetId);
    await owner.discardObservationSet(chase.observationSetId, { expectedVersion: chase.version, reason: 'duplicate-of-file' });
    assert.equal((await owner.getState()).quota.global.sets.used, before - 1);
    await refused(owner.getSentPayload(runId), 'receipt-expired', 410);
    const committed = server.store.sets.find((set) => set.state === 'committed')!;
    await refused(owner.discardObservationSet(committed.observationSetId, { expectedVersion: committed.version, reason: 'other' }), 'set-closed');
  });

  test('auto-sync: gate-closed until the issuer\'s checks pass, then one switch per binding after a manual round, with the password (Q28, R1)', async () => {
    const { server, owner } = setup({ recentAuth: 'required' });
    const state = await owner.getState();
    const amex = state.bindings.find((item) => item.issuer === 'amex')!;
    const chase = state.bindings.find((item) => item.issuer === 'chase')!;
    const [browser] = chase.autoSync.devices;
    assert.equal(chase.autoSync.gate, 'closed');
    assert.equal(chase.autoSync.revision, 0);
    assert.deepEqual(chase.autoSync.devices.map((entry) => [entry.enabled, entry.consentedAt]), [[false, null]]);
    const request = (binding: typeof chase, enabled: boolean, revision: number) => owner.setAutoSync(binding.bindingId, {
      expectedVersion: binding.bindingVersion, expectedAutoSyncRevision: revision, enabled,
    });
    // Q7: always gate-closed while the gate is closed, even before the password is asked.
    await refused(request(chase, true, 0), 'gate-closed');
    server.setAutoSyncGate('open', 'chase');
    server.setAutoSyncGate('open', 'amex');
    await refused(request(chase, true, 0), 'recent-auth-required');
    server.store.recentAuthUntil = Number.MAX_SAFE_INTEGER;
    await refused(request(amex, true, 0), 'auto-sync-not-eligible');
    await refused(owner.setAutoSync(chase.bindingId, { expectedVersion: chase.bindingVersion + 1, expectedAutoSyncRevision: 0, enabled: true }), 'version-conflict');
    const on = await request(chase, true, 0);
    assert.deepEqual(on.autoSync.devices.map((entry) => [entry.deviceId, entry.enabled]), [[browser.deviceId, true]]);
    assert.equal(on.autoSync.devices[0].consentedAt, (await owner.getState()).generatedAt);
    assert.equal(on.autoSync.revision, 1);
    assert.equal(on.bindingVersion, chase.bindingVersion, 'consent never moves the binding version');
    // A lost answer retried with the revision it was sent with never applies (E1b §5.2): the page then shows it is on.
    await refused(request(chase, true, 0), 'version-conflict');
    assert.equal((await owner.getState()).bindings.find((item) => item.issuer === 'chase')!.autoSync.revision, 1);
    // "Off" needs no password and checks no version, even once the gate closes again.
    server.store.recentAuthUntil = 0;
    server.setAutoSyncGate('closed');
    const off = await request(chase, false, 0);
    assert.deepEqual([off.autoSync.devices[0].enabled, off.autoSync.revision], [false, 2]);
    // A delayed "on" sent before that "off" (another window, a retry) can't bring it back (R1).
    server.setAutoSyncGate('open');
    server.store.recentAuthUntil = Number.MAX_SAFE_INTEGER;
    await refused(request(chase, true, 0), 'version-conflict');
    await refused(request(chase, true, 1), 'version-conflict');
    assert.equal(server.store.bindings.find((item) => item.issuer === 'chase')!.autoSyncConsent.size, 0);
    // An explicit "off" fences even when nothing was on: an "on" confirmed before it can no longer pass.
    assert.equal((await request(chase, false, 0)).autoSync.revision, 3);
    await refused(request(chase, true, 2), 'version-conflict');
    // A browser approved while a confirmation naming only Laptop Chrome is open: that "on" is refused, never extended to it.
    const invite = await owner.createPairing({ bindingIds: [chase.bindingId], replacesDeviceId: null });
    const added = server.redeemOpenPairing('Spare Chrome');
    await owner.approvePairing(invite.pairing.pairingId, added);
    let current = (await owner.getState()).bindings.find((item) => item.issuer === 'chase')!;
    assert.deepEqual(current.autoSync.devices.map((entry) => [entry.deviceId, entry.enabled]), [[browser.deviceId, false], [added.deviceId, false]]);
    assert.equal(current.autoSync.revision, 4, 'a new active grant fences');
    await refused(request(current, true, 3), 'version-conflict');
    assert.equal(server.store.bindings.find((item) => item.issuer === 'chase')!.autoSyncConsent.size, 0);
    // Confirmed against what is shown now, it covers both browsers.
    current = await request(current, true, 4);
    assert.deepEqual([current.autoSync.devices.map((entry) => entry.enabled), current.autoSync.revision], [[true, true], 5]);
    // Revoking a browser withdraws its consent and fences.
    await owner.revokeDevice(browser.deviceId);
    current = (await owner.getState()).bindings.find((item) => item.issuer === 'chase')!;
    assert.deepEqual([current.autoSync.devices.map((entry) => [entry.deviceId, entry.enabled]), current.autoSync.revision], [[[added.deviceId, true]], 6]);
    assert.deepEqual([...server.store.bindings.find((item) => item.issuer === 'chase')!.autoSyncConsent.keys()], [added.deviceId]);
    // A browser's 30 days running out withdraws its consent too, but doesn't move the revision: a browser dropping out never
    // widens what an "on" covers (E1b §5.9).
    server.advance(31 * DAY);
    current = (await owner.getState()).bindings.find((item) => item.issuer === 'chase')!;
    assert.deepEqual([current.autoSync.devices, current.autoSync.revision], [[], 6]);
    assert.equal(server.store.bindings.find((item) => item.issuer === 'chase')!.autoSyncConsent.size, 0);
  });

  test('confirming a binding again and allowing a browser again both fence automatic sending; neither brings consent back', async () => {
    const { server, owner } = setup();
    server.setAutoSyncGate('open', 'chase');
    let chase = (await owner.getState()).bindings.find((item) => item.issuer === 'chase')!;
    chase = await owner.setAutoSync(chase.bindingId, { expectedVersion: chase.bindingVersion, expectedAutoSyncRevision: chase.autoSync.revision, enabled: true });
    const [laptop] = chase.autoSync.devices;
    assert.equal(laptop.enabled, true);
    const onAt = chase.autoSync.revision;
    chase = await owner.confirmBinding(chase.bindingId, {
      expectedVersion: chase.bindingVersion, bindingLabel: chase.bindingLabel, regrantDeviceIds: [],
      scopes: chase.scopes.filter((scope) => scope.kind === 'known' && scope.status === 'active')
        .map((scope) => ({ cardScopeId: scope.cardScopeId, scopeLabel: scope.scopeLabel, holderAlias: scope.holderAlias as api.HolderAlias, last4: scope.last4 })),
    });
    assert.deepEqual(chase.autoSync.devices, []);
    assert.ok(chase.autoSync.revision > onAt);
    const confirmedAt = chase.autoSync.revision;
    await owner.regrantDevice(laptop.deviceId, [chase.bindingId]);
    chase = (await owner.getState()).bindings.find((item) => item.issuer === 'chase')!;
    assert.deepEqual(chase.autoSync.devices.map((entry) => [entry.deviceId, entry.enabled]), [[laptop.deviceId, false]]);
    assert.ok(chase.autoSync.revision > confirmedAt);
    // An "on" confirmed while no browser held the binding can't switch on the one allowed again since.
    await refused(owner.setAutoSync(chase.bindingId, { expectedVersion: chase.bindingVersion, expectedAutoSyncRevision: confirmedAt, enabled: true }), 'version-conflict');
  });

  test('confirming again re-grants no browser unless it is listed; the others can be allowed again (Q35)', async () => {
    const { server, owner } = setup();
    const state = await owner.getState();
    const chase = state.bindings.find((item) => item.issuer === 'chase')!;
    const amex = state.bindings.find((item) => item.issuer === 'amex')!;
    const laptop = state.devices.find((device) => device.deviceLabel === 'Laptop Chrome')!;
    const mac = state.devices.find((device) => device.deviceLabel === 'Mac Chrome')!;
    const scopesOf = (binding: typeof chase) => binding.scopes.filter((scope) => scope.kind === 'known' && scope.status === 'active')
      .map((scope) => ({ cardScopeId: scope.cardScopeId, scopeLabel: scope.scopeLabel, holderAlias: scope.holderAlias as api.HolderAlias, last4: scope.last4 }));
    const confirm = (binding: typeof chase, regrantDeviceIds: string[]) => owner.confirmBinding(binding.bindingId, {
      expectedVersion: binding.bindingVersion, bindingLabel: binding.bindingLabel, scopes: scopesOf(binding), regrantDeviceIds,
    });
    // Only a browser that held this binding can be kept.
    await refused(confirm(chase, [mac.deviceId]), 'invalid-request', 422);
    const confirmed = await confirm(chase, []);
    assert.deepEqual(confirmed.deviceIds, []);
    let device = (await owner.getState()).devices.find((item) => item.deviceId === laptop.deviceId)!;
    assert.deepEqual(device.staleBindingIds, [chase.bindingId]);
    assert.ok(!device.bindingIds.includes(chase.bindingId));
    // Allowing it again is a new grant, with the password and an open gate, for bindings it held.
    server.setGate('blocked');
    await refused(owner.regrantDevice(laptop.deviceId, [chase.bindingId]), 'authorization-blocked');
    server.setGate('open');
    const citi = state.bindings.find((item) => item.issuer === 'citi')!;
    await refused(owner.regrantDevice(laptop.deviceId, [citi.bindingId]), 'invalid-request', 422);
    await refused(owner.regrantDevice(server.store.devices.find((item) => item.status === 'revoked')!.deviceId, [chase.bindingId]), 'not-found', 404);
    device = await owner.regrantDevice(laptop.deviceId, [chase.bindingId]);
    assert.deepEqual(device.staleBindingIds, []);
    assert.ok(device.bindingIds.includes(chase.bindingId));
    assert.deepEqual((await owner.getState()).bindings.find((item) => item.issuer === 'chase')!.deviceIds, [laptop.deviceId]);
    // A listed browser keeps its grant through the confirmation.
    assert.deepEqual((await confirm(amex, [laptop.deviceId])).deviceIds, [laptop.deviceId]);
    // An invite whose binding changed after the browser redeemed it can't be approved.
    const invite = await owner.createPairing({ bindingIds: [chase.bindingId], replacesDeviceId: null });
    const spare = server.redeemOpenPairing('Spare Chrome');
    await confirm((await owner.getState()).bindings.find((item) => item.issuer === 'chase')!, [laptop.deviceId]);
    await refused(owner.approvePairing(invite.pairing.pairingId, spare), 'binding-stale', 409);
  });

  test('a browser past its 30 days is expired with no reason (E1b, X21 as amended); a wrong recent-auth password is 403 unauthorized (R6)', async () => {
    const { server, owner } = setup({ recentAuth: 'required' });
    server.advance(3 * DAY);
    const laptop = (await owner.getState()).devices.find((device) => device.deviceLabel === 'Laptop Chrome')!;
    assert.deepEqual([laptop.status, laptop.revokeReason, laptop.revokedAt], ['expired', null, null]);
    await refused(owner.confirmPassword('not the synthetic password'), 'unauthorized', 403);
    assert.ok((await owner.confirmPassword(FAKE_OWNER_PASSWORD)).verifiedUntil);
  });

  test('lists come newest first in pages of 50 with an opaque cursor; a bad cursor, any limit or a missing view is refused, as E2a answers', async () => {
    const { server, owner } = setup();
    server.addCommittedHistory(75);
    // The set accepted first is the last one closed: by closing time it would come first, by acceptance it comes last.
    const oldest = server.store.sets.filter((set) => set.closeReason !== null).sort((a, b) => a.acceptedAt - b.acceptedAt)[0];
    oldest.closedAt = server.now();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await owner.listObservationSets('closed', cursor);
      assert.ok(page.observationSets.length <= 50);
      seen.push(...page.observationSets.map((set) => set.observationSetId));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);
    const closed = server.store.sets.filter((set) => set.closeReason !== null);
    assert.equal(new Set(seen).size, closed.length);
    assert.equal(pages, Math.ceil(closed.length / 50));
    // E2a orders both views by when Holdr accepted the set, newest first (handoff 10/18 02:30 item 6), never by closing time.
    const newestAccepted = [...closed].sort((a, b) => b.acceptedAt - a.acceptedAt || (a.observationSetId < b.observationSetId ? 1 : -1));
    assert.deepEqual(seen, newestAccepted.map((set) => set.observationSetId));
    const lastClosed = [...closed].sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))[0];
    assert.deepEqual([lastClosed.observationSetId, seen.at(-1)], [oldest.observationSetId, oldest.observationSetId]);
    const runs = await owner.listRuns();
    assert.equal(runs.runs.length, 50);
    assert.ok(runs.nextCursor !== null && /^[a-z]+$/.test(runs.nextCursor));
    const created = runs.runs.map((run) => Date.parse(run.createdAt));
    assert.deepEqual(created, [...created].sort((a, b) => b - a));
    const bad = (url: string) => server.handle({ method: 'GET', url }).body;
    assert.deepEqual([bad('/card-sync/owner/runs?cursor=12'), bad('/card-sync/owner/runs?limit=50')], [
      { error: 'invalid-request', issues: [{ code: 'invalid-format', path: '$.cursor' }] },
      { error: 'invalid-request', issues: [{ code: 'unknown-key', path: '$.<key>' }] },
    ]);
    assert.deepEqual([bad('/card-sync/owner/observation-sets'), bad('/card-sync/owner/observation-sets?view=all')], [
      { error: 'invalid-request', issues: [{ code: 'missing-key', path: '$.view' }] },
      { error: 'invalid-request', issues: [{ code: 'invalid-enum', path: '$.view' }] },
    ]);
  });

  test('moving a committed "same transaction" to the other match is a change: unlink the first, count once with the second', async () => {
    const { server, owner } = setup();
    const [setId] = server.addCommittedHistory(1);
    const set = await owner.getObservationSet(setId);
    const [entry] = set.items;
    assert.equal(entry.committed!.transactionId, entry.candidates[0].transactionId);
    const moved = await owner.recordDecisions(setId, {
      expectedVersion: set.version,
      decisions: [{ itemId: entry.itemId, action: 'same-transaction', transactionId: entry.candidates[1].transactionId, cardScopeId: null }],
    });
    const plan = await owner.preparePlan(setId, { expectedVersion: moved.version, sourceReviewed: false });
    assert.deepEqual(plan.effects.map((effect) => [effect.effect, effect.transactionId]), [
      ['unmatch', entry.candidates[0].transactionId],
      ['match', entry.candidates[1].transactionId],
    ]);
    await owner.commitPlan(plan.previewId, plan);
    const after = await owner.getObservationSet(setId);
    assert.equal(after.items[0].committed!.transactionId, entry.candidates[1].transactionId);
    // Choosing the transaction it already has is no change, so there is nothing to plan.
    const same = await owner.recordDecisions(setId, {
      expectedVersion: after.version,
      decisions: [{ itemId: entry.itemId, action: 'same-transaction', transactionId: entry.candidates[1].transactionId, cardScopeId: null }],
    });
    await refused(owner.preparePlan(setId, { expectedVersion: same.version, sourceReviewed: false }), 'decisions-incomplete');
  });

  test('two hundred decisions of the largest shape fit one request; the page sends at most a hundred at a time', async () => {
    const { server, owner } = setup();
    const setId = server.addLargeOpenSet(250);
    const set = await owner.getObservationSet(setId);
    assert.equal(set.items.length, 250);
    const decisions = set.items.slice(0, 200).map((entry) => ({ itemId: entry.itemId, action: 'insert-new' as const, transactionId: null, cardScopeId: null }));
    const saved = await owner.recordDecisions(setId, { expectedVersion: set.version, decisions });
    assert.equal(saved.items.filter((entry) => entry.decision !== null).length, 200);
    const largest = JSON.stringify({ expectedVersion: 2_147_483_647, decisions: Array.from({ length: 200 }, () => ({
      itemId: `rvw_${'a'.repeat(32)}`, action: 'attribute-and-link', transactionId: `card-txn-${'a'.repeat(32)}`, cardScopeId: `scp_${'a'.repeat(32)}`,
    })) });
    assert.ok(largest.length < 64 * 1024, `${largest.length} bytes`);
    assert.equal(api.DECISION_BATCH, 100);
  });
});

describe('revision 2: file sets, run state, adjustment plans', () => {
  test('a file import\'s conflicts wait in the same queue with no run, binding or browser, and plan with no payload digest (X18)', async () => {
    const { server, owner } = setup();
    const setId = server.addFileReviewSet();
    const amex = (await owner.getState()).bindings.find((item) => item.issuer === 'amex')!;
    const summary = (await owner.listObservationSets('open')).observationSets.find((item) => item.observationSetId === setId)!;
    assert.deepEqual([summary.sourceKind, summary.runId, summary.bindingId, summary.deviceId, summary.byteCount], ['file', null, null, null, 0]);
    assert.match(summary.importBatchId!, /^card-import-[a-p]{32}$/);
    assert.equal(summary.cardAccountRef, amex.cardAccountRef);
    const set = await owner.getObservationSet(setId);
    assert.equal(set.payloadDigest, null);
    assert.deepEqual(set.items.map((entry) => [entry.category, entry.reason]), [['pending-link', 'removed-hit'], ['cross-source-similar', 'identity-conflict']]);
    assert.ok(set.items.every((entry) => !entry.allowedActions.includes('insert-new')), 'the identity exists already, so never "keep both"');
    // Pausing and turning the issuer off hold what browsers send, not a file import (E1b §5.0).
    await owner.pause();
    await owner.disableIssuer('amex');
    const decided = await owner.recordDecisions(setId, {
      expectedVersion: set.version,
      decisions: set.items.map((entry) => ({ itemId: entry.itemId, action: 'same-transaction' as const, transactionId: entry.candidates[0].transactionId, cardScopeId: null })),
    });
    const plan = await owner.preparePlan(setId, { expectedVersion: decided.version, sourceReviewed: false });
    assert.deepEqual([plan.planKind, plan.payloadDigest], ['set', null]);
    assert.deepEqual(plan.effects.map((effect) => effect.effect), ['promote', 'match']);
    await refused(owner.commitPlan(plan.previewId, { payloadDigest: `pd1:${'a'.repeat(64)}`, planDigest: plan.planDigest }), 'plan-mismatch');
    const committed = await owner.commitPlan(plan.previewId, { payloadDigest: null, planDigest: plan.planDigest });
    assert.equal(committed.observationSetId, setId);
    // A restore sends what browsers sent to recovery review; a file set has no browser to check and stays as it was.
    const other = setup();
    const fileSet = other.server.addFileReviewSet();
    other.server.restoreFromBackup();
    assert.equal((await other.owner.getObservationSet(fileSet)).state, 'needs-review');
  });

  test('a run\'s own state: open, expired after its 10 minutes or at once when its browser is revoked, refused, aborted (Q36, R4)', async () => {
    const { server, owner } = setup();
    const lastRunOf = async (issuer: string) => (await owner.getState()).bindings.find((item) => item.issuer === issuer)!.sync.lastRun!;
    const first = server.startRun('chase');
    assert.equal((await owner.getRun(first)).runState, 'open');
    assert.equal((await lastRunOf('chase')).runState, 'open');
    server.advance(11 * MINUTE);
    assert.equal((await owner.getRun(first)).runState, 'expired');
    const second = server.startRun('chase');
    const refusedRun = await owner.getRun(server.startRun('citi', null, 'card-data'));
    assert.deepEqual([refusedRun.runState, refusedRun.errorCode, refusedRun.acceptance], ['refused', 'card-data', 'none']);
    assert.equal((await lastRunOf('citi')).runState, 'refused');
    const aborted = await owner.getRun(server.startRun('wellsfargo', 'site-permission-revoked'));
    assert.deepEqual([aborted.runState, aborted.abortReason], ['aborted', 'site-permission-revoked']);
    await owner.revokeDevice(server.store.runs.find((run) => run.runId === second)!.deviceId);
    assert.equal((await owner.getRun(second)).runState, 'expired', 'closed within its 10 minutes');
    assert.equal((await lastRunOf('chase')).runState, 'expired');
    assert.equal((await owner.getRun(aborted.runId)).runState, 'aborted');
    const accepted = (await owner.listRuns()).runs.find((run) => run.observationSetId !== null)!;
    assert.equal(accepted.runState, 'accepted');
  });

  test('an accepted statement difference is its own plan action, changing nothing in spending', async () => {
    const { owner } = setup();
    const citi = await openSet(owner, 'citi');
    const decided = await owner.recordDecisions(citi.observationSetId, { expectedVersion: citi.version, decisions: decideAll(citi, '') });
    const plan = await owner.preparePlan(citi.observationSetId, { expectedVersion: decided.version, sourceReviewed: false });
    const difference = citi.items.find((entry) => entry.category === 'reconciliation-difference')!;
    assert.deepEqual(plan.effects.filter((effect) => effect.effect === 'accept-difference'), [
      { itemId: difference.itemId, rowIndex: null, effect: 'accept-difference', transactionId: null, before: null, after: null },
    ]);
  });

  test('changing committed decisions is an adjustment plan that reverses each committed effect first, until the set expires (R5, Q34)', async () => {
    const { server, owner } = setup();
    const amex = await openSet(owner, 'amex');
    const basic = (await owner.getState()).bindings.find((item) => item.issuer === 'amex')!.scopes[0].cardScopeId;
    const byKey = (category: api.ReviewCategory, action: api.DecisionAction) => amex.items.find((entry) => entry.category === category && entry.allowedActions.includes(action))!;
    const legacy = byKey('cross-source-similar', 'attribute-and-link');
    const pending = byKey('pending-link', 'same-transaction');
    const unknown = byKey('scope-unknown', 'attribute');
    const matchable = byKey('no-stable-id', 'same-transaction');
    const plain = amex.items.find((entry) => entry.category === 'no-stable-id' && entry !== matchable)!;
    const first = await owner.recordDecisions(amex.observationSetId, {
      expectedVersion: amex.version,
      decisions: decideAll(amex, basic).map((decision) => {
        if (decision.itemId === legacy.itemId) return { ...decision, action: 'attribute-and-link', transactionId: legacy.candidates[0].transactionId, cardScopeId: legacy.observation!.cardScopeId };
        if (decision.itemId === pending.itemId) return { ...decision, action: 'same-transaction', transactionId: pending.candidates[0].transactionId };
        if (decision.itemId === unknown.itemId) return { ...decision, action: 'attribute', cardScopeId: basic };
        return decision;
      }),
    });
    const setPlan = await owner.preparePlan(amex.observationSetId, { expectedVersion: first.version, sourceReviewed: false });
    assert.equal(setPlan.planKind, 'set');
    await owner.commitPlan(setPlan.previewId, setPlan);
    const committed = await owner.getObservationSet(amex.observationSetId);
    const changed = await owner.recordDecisions(amex.observationSetId, {
      expectedVersion: committed.version,
      decisions: [
        { itemId: legacy.itemId, action: 'reject-row', transactionId: null, cardScopeId: null },
        { itemId: pending.itemId, action: 'insert-new', transactionId: null, cardScopeId: null },
        { itemId: unknown.itemId, action: 'insert-new', transactionId: null, cardScopeId: null },
        { itemId: plain.itemId, action: 'reject-row', transactionId: null, cardScopeId: null },
        { itemId: matchable.itemId, action: 'same-transaction', transactionId: matchable.candidates[0].transactionId, cardScopeId: null },
      ],
    });
    const plan = await owner.preparePlan(amex.observationSetId, { expectedVersion: changed.version, sourceReviewed: false });
    assert.deepEqual([plan.planKind, plan.payloadDigest], ['adjustment', committed.payloadDigest]);
    const effectsOf = (itemId: string) => plan.effects.filter((effect) => effect.itemId === itemId).map((effect) => effect.effect);
    assert.deepEqual(effectsOf(legacy.itemId), ['revert', 'unmatch'], 'a link that wrote the row (its card) is undone by one revert (X30); rejecting adds nothing');
    assert.deepEqual(effectsOf(pending.itemId), ['revert', 'unmatch', 'insert'], 'the promotion is undone to its exact earlier values first');
    assert.deepEqual(effectsOf(unknown.itemId), ['restore-attribution'], 'only a row the commit created switches its card with restore-attribution');
    assert.deepEqual(effectsOf(plain.itemId), ['remove']);
    assert.deepEqual(effectsOf(matchable.itemId), ['supersede']);
    const restored = plan.effects.find((effect) => effect.itemId === unknown.itemId)!;
    assert.deepEqual([restored.before!.cardScopeId, restored.after!.cardScopeId], [basic, unknown.observation!.cardScopeId]);
    const unlinked = plan.effects.find((effect) => effect.itemId === legacy.itemId && effect.effect === 'revert')!;
    assert.deepEqual([unlinked.before!.cardScopeId, unlinked.after!.cardScopeId], [legacy.observation!.cardScopeId, legacy.candidates[0].cardScopeId]);
    assert.deepEqual(
      [plan.counts.attributed, plan.counts.unmatched, plan.counts.update, plan.counts.insert, plan.counts.rejected, plan.counts.superseded, plan.counts.unchanged],
      [1, 2, 2, 1, 1, 1, 1],
    );
    await owner.commitPlan(plan.previewId, plan);
    const after = await owner.getObservationSet(amex.observationSetId);
    assert.deepEqual([after.state, after.items.find((entry) => entry.itemId === pending.itemId)!.committed!.action], ['committed', 'insert-new']);
    // A plan prepared just before the acceptance expires can't be committed after it (C3).
    const lastChange = await owner.recordDecisions(amex.observationSetId, {
      expectedVersion: after.version, decisions: [{ itemId: plain.itemId, action: 'insert-new', transactionId: null, cardScopeId: null }],
    });
    const lastPlan = await owner.preparePlan(amex.observationSetId, { expectedVersion: lastChange.version, sourceReviewed: false });
    // After the acceptance expires (5 days from now), the set stays committed and offers nothing: the ledger tools take over.
    server.advance(6 * DAY);
    const late = await owner.getObservationSet(amex.observationSetId);
    assert.equal(late.state, 'committed');
    assert.deepEqual(late.items.filter((entry) => entry.allowedActions.length > 0), []);
    await refused(owner.recordDecisions(amex.observationSetId, {
      expectedVersion: late.version, decisions: [{ itemId: plain.itemId, action: 'reject-row', transactionId: null, cardScopeId: null }],
    }), 'observation-expired', 410);
    await refused(owner.preparePlan(amex.observationSetId, { expectedVersion: late.version, sourceReviewed: false }), 'observation-expired', 410);
    await refused(owner.commitPlan(lastPlan.previewId, lastPlan), 'observation-expired', 410);
  });
});

describe('revision 3 (E1b): authorization changes, re-confirmation and expiry', () => {
  test('every authorization change cancels the prepared plans of what browsers sent, never a file import\'s (E1b §5.0)', async () => {
    const { server, owner } = setup();
    const fileSetId = server.addFileReviewSet();
    const fileSet = await owner.getObservationSet(fileSetId);
    const fileDecided = await owner.recordDecisions(fileSetId, {
      expectedVersion: fileSet.version,
      decisions: fileSet.items.map((entry) => ({ itemId: entry.itemId, action: 'same-transaction' as const, transactionId: entry.candidates[0].transactionId, cardScopeId: null })),
    });
    const filePlan = await owner.preparePlan(fileSetId, { expectedVersion: fileDecided.version, sourceReviewed: false });
    const state = await owner.getState();
    const chase = state.bindings.find((item) => item.issuer === 'chase')!;
    const mac = state.devices.find((device) => device.deviceLabel === 'Mac Chrome')!;
    const chaseSetId = chase.sync.lastRun!.observationSetId!;
    const prepare = async () => {
      const set = await owner.getObservationSet(chaseSetId);
      assert.equal(set.state, 'accepted-uncommitted');
      return owner.preparePlan(chaseSetId, { expectedVersion: set.version, sourceReviewed: false });
    };
    server.setAutoSyncGate('open', 'chase');
    let invite: Awaited<ReturnType<typeof owner.createPairing>> | null = null;
    const changes: Array<[string, () => Promise<unknown>]> = [
      ['a pairing code created', async () => { invite = await owner.createPairing({ bindingIds: [chase.bindingId], replacesDeviceId: null }); }],
      ['the code cancelled', () => owner.cancelPairing(invite!.pairing.pairingId)],
      ['another bank turned off', () => owner.disableIssuer('wellsfargo')],
      ['and on again', () => owner.enableIssuer('wellsfargo', { expectedVersion: server.store.settingsVersion, mainWorldAcknowledged: true })],
      ['automatic sending on', async () => {
        const binding = (await owner.getState()).bindings.find((item) => item.issuer === 'chase')!;
        await owner.setAutoSync(binding.bindingId, { expectedVersion: binding.bindingVersion, expectedAutoSyncRevision: binding.autoSync.revision, enabled: true });
      }],
      ['automatic sending off', () => owner.setAutoSync(chase.bindingId, { expectedVersion: chase.bindingVersion, expectedAutoSyncRevision: 0, enabled: false })],
      ['another browser revoked', () => owner.revokeDevice(mac.deviceId)],
      ['a pause and a resume', async () => { await owner.pause(); await owner.resume(server.store.settingsVersion); }],
    ];
    for (const [name, change] of changes) {
      const plan = await prepare();
      await change();
      await assert.rejects(owner.commitPlan(plan.previewId, plan), (error: unknown) => {
        assert.ok(isOwnerApiError(error) && error.code === 'preview-stale', `${name}: preview-stale`);
        return true;
      });
    }
    // A repeat that changes nothing is no authorization change: the plan stays good.
    const plan = await prepare();
    await owner.disableIssuer('amex');
    await owner.disableIssuer('amex');
    const kept = await prepare();
    await owner.disableIssuer('amex');
    await owner.revokeDevice(mac.deviceId);
    await owner.setAutoSync(chase.bindingId, { expectedVersion: chase.bindingVersion, expectedAutoSyncRevision: 0, enabled: false });
    await refused(owner.commitPlan(plan.previewId, plan), 'preview-stale');
    assert.equal((await owner.commitPlan(kept.previewId, kept)).observationSetId, chaseSetId);
    // The file import's plan pins no authorization, so all of the above left it good.
    assert.equal((await owner.commitPlan(filePlan.previewId, { payloadDigest: null, planDigest: filePlan.planDigest })).observationSetId, fileSetId);
  });

  test('while the gate is blocked, every change that widens authority is refused and changes nothing; narrowing ones still apply (E1b §5.0)', async () => {
    const { server, owner } = setup();
    const freedom = server.store.cardAccounts[4];
    let state = await owner.getState();
    let chase = state.bindings.find((item) => item.issuer === 'chase')!;
    const laptop = state.devices.find((device) => device.deviceLabel === 'Laptop Chrome')!;
    const scopesOf = (binding: typeof chase) => binding.scopes.filter((scope) => scope.kind === 'known' && scope.status === 'active')
      .map((scope) => ({ cardScopeId: scope.cardScopeId, scopeLabel: scope.scopeLabel, holderAlias: scope.holderAlias as api.HolderAlias, last4: scope.last4 }));
    // With the gate open: Laptop Chrome's Chase grant goes stale, Wells Fargo is off, a browser waits for approval.
    chase = await owner.confirmBinding(chase.bindingId, {
      expectedVersion: chase.bindingVersion, bindingLabel: chase.bindingLabel, scopes: scopesOf(chase), regrantDeviceIds: [],
    });
    await owner.disableIssuer('wellsfargo');
    server.setAutoSyncGate('open', 'chase');
    const invite = await owner.createPairing({ bindingIds: [chase.bindingId], replacesDeviceId: null });
    const spare = server.redeemOpenPairing('Spare Chrome');
    const setId = chase.sync.lastRun!.observationSetId!;
    const set = await owner.getObservationSet(setId);
    const plan = await owner.preparePlan(setId, { expectedVersion: set.version, sourceReviewed: true });
    state = await owner.getState();
    chase = state.bindings.find((item) => item.issuer === 'chase')!;

    server.setGate('blocked');
    const widening: Array<[string, () => Promise<unknown>]> = [
      ['create a binding', () => owner.createBinding({
        issuer: 'chase', source: 'chase-api', cardAccountRef: freedom.id, bindingLabel: 'Chase Freedom',
        scopes: [{ scopeLabel: 'Card', holderAlias: 'alex', last4: '5500' }],
      })],
      ['confirm a binding, keeping a browser whose grant went stale', () => owner.confirmBinding(chase.bindingId, {
        expectedVersion: chase.bindingVersion, bindingLabel: chase.bindingLabel, scopes: scopesOf(chase), regrantDeviceIds: [laptop.deviceId],
      })],
      ['allow that browser again', () => owner.regrantDevice(laptop.deviceId, [chase.bindingId])],
      ['turn a bank on', () => owner.enableIssuer('wellsfargo', { expectedVersion: state.settings.settingsVersion, mainWorldAcknowledged: true })],
      ['resume', () => owner.resume(state.settings.settingsVersion)],
      ['create a pairing code', () => owner.createPairing({ bindingIds: [chase.bindingId], replacesDeviceId: null })],
      ['approve a browser', () => owner.approvePairing(invite.pairing.pairingId, spare)],
      ['turn automatic sending on', () => owner.setAutoSync(chase.bindingId, {
        expectedVersion: chase.bindingVersion, expectedAutoSyncRevision: chase.autoSync.revision, enabled: true,
      })],
    ];
    for (const [name, change] of widening) {
      await assert.rejects(change(), (error: unknown) => {
        assert.ok(isOwnerApiError(error) && error.status === 409 && error.code === 'authorization-blocked', `${name}: 409 authorization-blocked`);
        return true;
      });
    }
    // Nothing moved: bindings, scopes, grants, stale grants, consent and its revision, pairings, settings, and the prepared plan.
    assert.deepEqual(await owner.getState(), { ...state, gate: 'blocked' });
    assert.deepEqual(server.store.devices.find((device) => device.deviceId === laptop.deviceId)!.staleBindingIds, [chase.bindingId]);
    assert.equal(server.store.sets.find((item) => item.observationSetId === setId)!.plans.find((item) => item.previewId === plan.previewId)!.state, 'valid');

    // Narrowing changes still apply while blocked, and retire the prepared plan; the gate stays blocked.
    await owner.cancelPairing(invite.pairing.pairingId);
    await owner.disableIssuer('chase');
    const after = await owner.getState();
    assert.equal(after.gate, 'blocked');
    assert.equal(after.pairings.find((item) => item.pairingId === invite.pairing.pairingId)!.status, 'cancelled');
    assert.equal(after.settings.issuers.find((item) => item.issuer === 'chase')!.enabled, false);
    assert.equal(server.store.sets.find((item) => item.observationSetId === setId)!.plans.find((item) => item.previewId === plan.previewId)!.state, 'superseded');
  });
  test('confirming a binding again sends what its browsers sent before to a source check (E1b §5.2)', async () => {
    const { owner } = setup();
    const state = await owner.getState();
    const chase = state.bindings.find((item) => item.issuer === 'chase')!;
    const laptop = state.devices.find((device) => device.deviceLabel === 'Laptop Chrome')!;
    const before = await owner.getObservationSet(chase.sync.lastRun!.observationSetId!);
    assert.equal(before.state, 'accepted-uncommitted');
    await owner.confirmBinding(chase.bindingId, {
      expectedVersion: chase.bindingVersion, bindingLabel: chase.bindingLabel, regrantDeviceIds: [laptop.deviceId],
      scopes: chase.scopes.filter((scope) => scope.kind === 'known' && scope.status === 'active')
        .map((scope) => ({ cardScopeId: scope.cardScopeId, scopeLabel: scope.scopeLabel, holderAlias: scope.holderAlias as api.HolderAlias, last4: scope.last4 })),
    });
    const after = await owner.getObservationSet(before.observationSetId);
    assert.deepEqual([after.state, after.version], ['blocked-review', before.version + 1]);
    await refused(owner.preparePlan(after.observationSetId, { expectedVersion: after.version, sourceReviewed: false }), 'source-review-required');
    const plan = await owner.preparePlan(after.observationSetId, { expectedVersion: after.version, sourceReviewed: true });
    assert.equal((await owner.commitPlan(plan.previewId, plan)).observationSetId, after.observationSetId);
  });

  test('a browser whose 30 days run out leaves what it sent as it was: no source check, and its plans stay good (E1b revision 4)', async () => {
    const { server, owner } = setup();
    server.setAutoSyncGate('open', 'chase');
    let state = await owner.getState();
    let chase = state.bindings.find((item) => item.issuer === 'chase')!;
    const laptop = state.devices.find((device) => device.deviceLabel === 'Laptop Chrome')!;
    chase = await owner.setAutoSync(chase.bindingId, { expectedVersion: chase.bindingVersion, expectedAutoSyncRevision: chase.autoSync.revision, enabled: true });
    assert.deepEqual(chase.autoSync.devices.map((entry) => [entry.deviceId, entry.enabled]), [[laptop.deviceId, true]]);
    const revision = chase.autoSync.revision;
    const chaseSetId = chase.sync.lastRun!.observationSetId!;
    server.advance(Date.parse(laptop.deviceExpiresAt!) - Date.parse(state.generatedAt) - MINUTE);
    const set = await owner.getObservationSet(chaseSetId);
    const plan = await owner.preparePlan(chaseSetId, { expectedVersion: set.version, sourceReviewed: false });
    server.advance(2 * MINUTE);
    state = await owner.getState();
    const expired = state.devices.find((device) => device.deviceId === laptop.deviceId)!;
    assert.deepEqual([expired.status, expired.revokeReason, expired.revokedAt], ['expired', null, null]);
    // Its grant and consent end with it, without moving the revision (E1b §5.9).
    chase = state.bindings.find((item) => item.issuer === 'chase')!;
    assert.deepEqual([chase.autoSync.devices, chase.autoSync.revision], [[], revision]);
    assert.equal(server.store.bindings.find((item) => item.issuer === 'chase')!.autoSyncConsent.size, 0);
    // What it sent waits as before, with no source check, and the plan prepared before still commits.
    const after = await owner.getObservationSet(chaseSetId);
    assert.deepEqual([after.state, after.version], [set.state, set.version]);
    assert.equal(after.state, 'accepted-uncommitted');
    assert.equal((await owner.commitPlan(plan.previewId, plan)).observationSetId, chaseSetId);
  });
});

describe('X29: repairs to the ledger after a set expired (proposal §3.8, E1b §5.7.1)', () => {
  const ids = LEDGER_STORY_IDS;
  /** The capture linked to the first Tailspin charge by mistake. */
  const capture = (sources: TransactionSources) => sources.identities.find((identity) => identity.namespaceKind === 'capture')!;

  test('a charge\'s sources: its aliases, the rows merged into it, the one change revert accepts, and its history newest first', async () => {
    const { server, owner } = setup();
    assertEventsHoldTogether(server);
    const tailspin = await owner.getTransactionSources(ids.tailspin);
    assert.deepEqual(tailspin.identities.map((identity) => [identity.namespaceKind, identity.createdBy, identity.scopeKind, identity.status]), [
      ['stable', 'extension', 'known', 'active'], ['legacy-file', 'migration', 'legacy', 'active'], ['capture', 'extension', 'known', 'active'],
    ]);
    assert.deepEqual([tailspin.mergedRows, tailspin.revertibleEventId, tailspin.nextEventsCursor], [[], null, null]);
    assert.deepEqual(tailspin.events.map((event) => event.eventType), ['identity-linked', 'identity-linked', 'created']);
    const coho = await owner.getTransactionSources(ids.coho);
    assert.deepEqual(coho.events.map((event) => event.eventType), ['promoted', 'identity-linked', 'created']);
    assert.equal(coho.revertibleEventId, coho.events[0].eventId);
    const fabrikam = await owner.getTransactionSources(ids.fabrikam);
    assert.deepEqual(fabrikam.mergedRows.map((row) => [row.transactionId, row.removedReason, row.mergedIntoId]), [[ids.fabrikamDuplicate, 'superseded', ids.fabrikam]]);
    assert.deepEqual(fabrikam.identities.map((identity) => identity.namespaceKind), ['legacy-file', 'stable']);
    assert.deepEqual(fabrikam.events.slice(0, 2).map((event) => [event.eventType, event.edited]), [['user-edited', ['category']], ['identity-repointed', []]]);
    const duplicate = await owner.getTransactionSources(ids.fabrikamDuplicate);
    assert.deepEqual([duplicate.transaction.mergedIntoId, duplicate.transaction.values.status, duplicate.identities], [ids.fabrikam, 'removed', []]);
  });

  test('a long history comes in pages of 100 by keyset: what is written meanwhile never shifts a later page', async () => {
    const { server, owner } = setup();
    const row = server.store.ledger.rows.get(ids.fabrikam)!;
    for (let index = 0; index < 150; index += 1) recordUserEdit(server.store.ledger, row, ['notes'], server.now());
    const total = () => server.store.ledger.events.filter((event) => event.transactionId === ids.fabrikam).length;
    const first = await owner.getTransactionSources(ids.fabrikam);
    const before = total();
    assert.equal(first.events.length, api.LEDGER_EVENTS_PAGE);
    assert.ok(first.nextEventsCursor);
    recordUserEdit(server.store.ledger, row, ['category'], server.now());
    const second = await owner.getTransactionSources(ids.fabrikam, { list: 'events', cursor: first.nextEventsCursor! });
    assert.equal(second.nextEventsCursor, null);
    const seen = [...first.events, ...second.events].map((event) => event.eventId);
    assert.deepEqual([seen.length, new Set(seen).size], [before, before]);
    assert.equal(second.events.at(-1)!.eventType, 'created');
    // The page asked for later starts with the newest event again.
    assert.equal((await owner.getTransactionSources(ids.fabrikam)).events[0].edited[0], 'category');
    const bad = server.handle({ method: 'GET', url: `/card-sync/owner/transactions/${ids.fabrikam}/sources?eventsCursor=zz` });
    assert.deepEqual([bad.status, bad.body], [422, { error: 'invalid-request', issues: [{ code: 'invalid-format', path: '$.eventsCursor' }] }]);
    const both = server.handle({ method: 'GET', url: `/card-sync/owner/transactions/${ids.fabrikam}/sources?identitiesCursor=${first.nextEventsCursor}&eventsCursor=${first.nextEventsCursor}` });
    // E2a names every cursor given, in the order sent.
    assert.deepEqual([both.status, both.body], [422, { error: 'invalid-request', issues: [
      { code: 'inconsistent', path: '$.identitiesCursor' }, { code: 'inconsistent', path: '$.eventsCursor' },
    ] }]);
  });

  test('aliases and merged rows beyond their display bounds come in keyset pages too (revision 4)', async () => {
    const { server, owner } = setup();
    const ledger = server.store.ledger;
    const later = ledger.rows.get(ids.tailspinLater)!;
    const at = server.now();
    for (let index = 0; index <= api.MAX_IDENTITIES; index += 1) {
      addIdentity(ledger, {
        identityId: identityIdFor(`bulk/${index}`), createdBy: 'extension', namespaceKind: 'capture',
        sourceScopeId: later.values.cardScopeId!, scopeKind: 'legacy', firstSeenStatus: 'posted',
      }, later, at + index);
    }
    const first = await owner.getTransactionSources(ids.tailspinLater);
    assert.deepEqual([first.identities.length, first.nextMergedRowsCursor], [api.MAX_IDENTITIES, null]);
    const second = await owner.getTransactionSources(ids.tailspinLater, { list: 'identities', cursor: first.nextIdentitiesCursor! });
    const aliases = [...first.identities, ...second.identities].map((identity) => identity.identityId);
    assert.deepEqual([second.identities.length, second.nextIdentitiesCursor, new Set(aliases).size], [2, null, api.MAX_IDENTITIES + 2]);
    // The other lists come as their first page, as they are now.
    assert.deepEqual(second.events, first.events);

    const fabrikam = ledger.rows.get(ids.fabrikam)!;
    for (let index = 0; index < api.MAX_MERGED_ROWS; index += 1) {
      const duplicate = createRow(ledger, {
        transactionId: cardTransactionIdFor(`bulk-merged/${index}`), cardAccountRef: fabrikam.cardAccountRef, values: { ...fabrikam.values }, at,
        source: { via: 'file', actor: 'file-import', deviceId: null, reason: 'insert' }, identity: null,
      });
      mergeRow(ledger, duplicate, fabrikam, 'superseded', at + index, { via: 'session', actor: 'owner', deviceId: null });
    }
    const merged = await owner.getTransactionSources(ids.fabrikam);
    assert.equal(merged.mergedRows.length, api.MAX_MERGED_ROWS);
    const rest = await owner.getTransactionSources(ids.fabrikam, { list: 'merged', cursor: merged.nextMergedRowsCursor! });
    const rows = [...merged.mergedRows, ...rest.mergedRows].map((row) => row.transactionId);
    assert.deepEqual([rest.mergedRows.length, rest.nextMergedRowsCursor, new Set(rows).size], [1, null, api.MAX_MERGED_ROWS + 1]);
    assert.ok(rows.includes(ids.fabrikamDuplicate));
    const bad = server.handle({ method: 'GET', url: `/card-sync/owner/transactions/${ids.fabrikam}/sources?mergedRowsCursor=${first.nextIdentitiesCursor}` });
    assert.deepEqual([bad.status, bad.body], [422, { error: 'invalid-request', issues: [{ code: 'invalid-format', path: '$.mergedRowsCursor' }] }]);
  });

  test('detaching the alias linked by mistake: the charge keeps its other aliases and its revision; a last alias is never detached', async () => {
    const { owner } = setup();
    const before = await owner.getTransactionSources(ids.tailspin);
    const wrong = capture(before);
    const after = await owner.detachIdentity(wrong.identityId, { transactionId: ids.tailspin, expectedRevision: before.transaction.revision });
    assert.equal(after.transaction.revision, before.transaction.revision);
    assert.deepEqual(after.identities.map((identity) => [identity.identityId, identity.status]), [
      [before.identities[0].identityId, 'active'], [before.identities[1].identityId, 'active'], [wrong.identityId, 'detached'],
    ]);
    const event = after.events[0];
    assert.deepEqual([event.eventType, event.identityId, event.reason, event.via, event.actor, event.deviceId], [
      'identity-detached', wrong.identityId, 'maintenance', 'session', 'owner', null,
    ]);
    // Done once: again is not allowed. The only alias a charge has stays. A stale revision and an unknown alias are refused.
    await refused(owner.detachIdentity(wrong.identityId, { transactionId: ids.tailspin, expectedRevision: after.transaction.revision }), 'action-not-allowed', 409);
    const later = await owner.getTransactionSources(ids.tailspinLater);
    await refused(owner.detachIdentity(later.identities[0].identityId, {
      transactionId: ids.tailspinLater, expectedRevision: later.transaction.revision,
    }), 'action-not-allowed', 409);
    await refused(owner.detachIdentity(after.identities[0].identityId, {
      transactionId: ids.tailspin, expectedRevision: after.transaction.revision + 1,
    }), 'transaction-revision-stale', 409);
    await refused(owner.detachIdentity(`card-ident-${'a'.repeat(32)}`, { transactionId: ids.tailspin, expectedRevision: 1 }), 'not-found', 404);
    // An alias move changes no revision, so the row the owner saw it on is what proves the view is current (X31).
    await refused(owner.detachIdentity(after.identities[0].identityId, {
      transactionId: ids.tailspinLater, expectedRevision: later.transaction.revision,
    }), 'transaction-revision-stale', 409);
    assert.deepEqual((await owner.getTransactionSources(ids.tailspin)).identities.map((identity) => identity.status), ['active', 'active', 'detached']);
  });

  test('moving an alias to the charge it belongs to: a live row of the same card account, never onto another known card', async () => {
    const { server, owner } = setup();
    const from = await owner.getTransactionSources(ids.tailspin);
    const wrong = capture(from);
    const to = await owner.getTransactionSources(ids.tailspinLater);
    const otherCard = await owner.getTransactionSources(ids.tailspinOtherCard);
    const duplicate = await owner.getTransactionSources(ids.fabrikamDuplicate);
    const move = (toTransactionId: string, expectedToRevision: number) => owner.repointIdentity(wrong.identityId, {
      fromTransactionId: ids.tailspin, expectedRevision: from.transaction.revision, toTransactionId, expectedToRevision,
    });
    // A capture of Alex's card never joins a charge on Casey's card.
    await refused(move(ids.tailspinOtherCard, otherCard.transaction.revision), 'cross-card-link-refused', 409);
    // Not onto a merged row, nor a row of another card account; not with a stale revision of either row.
    await refused(move(ids.fabrikamDuplicate, duplicate.transaction.revision), 'action-not-allowed', 409);
    const elsewhere = [...server.store.ledger.rows.values()].find((row) => row.cardAccountRef !== from.transaction.cardAccountRef && row.values.status !== 'removed')!;
    await refused(move(elsewhere.transactionId, elsewhere.revision), 'action-not-allowed', 409);
    await refused(move(ids.tailspinLater, to.transaction.revision + 1), 'transaction-revision-stale', 409);
    await refused(owner.repointIdentity(wrong.identityId, {
      fromTransactionId: ids.tailspin, expectedRevision: from.transaction.revision + 1, toTransactionId: ids.tailspinLater, expectedToRevision: to.transaction.revision,
    }), 'transaction-revision-stale', 409);
    // Not the only alias a charge has.
    await refused(owner.repointIdentity(to.identities[0].identityId, {
      fromTransactionId: ids.tailspinLater, expectedRevision: to.transaction.revision, toTransactionId: ids.tailspin, expectedToRevision: from.transaction.revision,
    }), 'action-not-allowed', 409);

    const left = await move(ids.tailspinLater, to.transaction.revision);
    assert.deepEqual([left.transaction.transactionId, left.transaction.revision], [ids.tailspin, from.transaction.revision]);
    assert.deepEqual(left.identities.map((identity) => identity.identityId), from.identities.slice(0, 2).map((identity) => identity.identityId));
    // Where it left, the history says where it went: the other row's event, with no revision of this one (X32).
    const went = left.events[0];
    assert.deepEqual([went.eventType, went.revision, went.relatedTransactionId, went.identityId, went.reason], [
      'identity-repointed', null, ids.tailspinLater, wrong.identityId, 'maintenance',
    ]);
    const arrived = await owner.getTransactionSources(ids.tailspinLater);
    assert.deepEqual(arrived.identities.map((identity) => [identity.identityId, identity.status]), [[to.identities[0].identityId, 'active'], [wrong.identityId, 'active']]);
    assert.deepEqual([arrived.events[0].eventId, arrived.events[0].revision, arrived.events[0].relatedTransactionId, arrived.transaction.revision], [
      went.eventId, to.transaction.revision, ids.tailspin, to.transaction.revision,
    ]);
    // A repeat after a lost answer: the alias isn't on the row named any more, so nothing moves again (X31).
    await refused(move(ids.tailspinLater, to.transaction.revision), 'transaction-revision-stale', 409);
    // Another window's detach, decided while the alias was still on the first charge, never reaches it on the second.
    await refused(owner.detachIdentity(wrong.identityId, { transactionId: ids.tailspin, expectedRevision: from.transaction.revision }), 'transaction-revision-stale', 409);
    assert.deepEqual([server.store.ledger.identities.get(wrong.identityId)!.status, server.store.ledger.identities.get(wrong.identityId)!.canonicalId], [
      'active', ids.tailspinLater,
    ]);
  });

  test('undoing a promotion puts back exactly what was there, once; only the latest reversible change is accepted', async () => {
    const { owner } = setup();
    const before = await owner.getTransactionSources(ids.coho);
    const [promoted, , created] = before.events;
    await refused(owner.revertChange(ids.coho, { eventId: created.eventId, expectedRevision: before.transaction.revision }), 'action-not-allowed', 409);
    await refused(owner.revertChange(ids.coho, { eventId: promoted.eventId, expectedRevision: before.transaction.revision - 1 }), 'transaction-revision-stale', 409);
    const after = await owner.revertChange(ids.coho, { eventId: promoted.eventId, expectedRevision: before.transaction.revision });
    assert.deepEqual([after.transaction.values.status, after.transaction.values.amountMinor, after.transaction.values.postedDate], ['pending', 3_840, null]);
    assert.deepEqual([after.transaction.revision, after.revertibleEventId], [before.transaction.revision + 1, null]);
    const reversed = after.events[0];
    assert.deepEqual([reversed.eventType, reversed.reversesEventId, reversed.reason, reversed.from, reversed.to], ['reversed', promoted.eventId, 'maintenance', promoted.to, promoted.from]);
    // Undoing values is not unlinking: both aliases stay. And it is done once.
    assert.deepEqual(after.identities, before.identities);
    await refused(owner.revertChange(ids.coho, { eventId: promoted.eventId, expectedRevision: after.transaction.revision }), 'action-not-allowed', 409);
  });

  test('separating a merged duplicate: live again with the aliases the merge moved, only while the merge is undone as it was', async () => {
    const { owner } = setup();
    const survivor = await owner.getTransactionSources(ids.fabrikam);
    const merged = await owner.getTransactionSources(ids.fabrikamDuplicate);
    await refused(owner.unmergeTransaction(ids.fabrikam, {
      expectedRevision: survivor.transaction.revision, expectedSurvivorRevision: survivor.transaction.revision,
    }), 'merge-not-allowed', 409);
    await refused(owner.unmergeTransaction(ids.fabrikamDuplicate, {
      expectedRevision: merged.transaction.revision, expectedSurvivorRevision: survivor.transaction.revision - 1,
    }), 'transaction-revision-stale', 409);
    const separated = await owner.unmergeTransaction(ids.fabrikamDuplicate, {
      expectedRevision: merged.transaction.revision, expectedSurvivorRevision: survivor.transaction.revision,
    });
    assert.deepEqual([separated.transaction.values.status, separated.transaction.removedReason, separated.transaction.mergedIntoId], ['posted', null, null]);
    assert.equal(separated.transaction.revision, merged.transaction.revision + 1);
    assert.deepEqual(separated.identities.map((identity) => [identity.namespaceKind, identity.status]), [['stable', 'active']]);
    // E1b §4.9.3's order: restored, the aliases back, then the reversal naming the merge.
    assert.deepEqual(separated.events.slice(0, 3).map((event) => event.eventType), ['reversed', 'identity-repointed', 'restored']);
    const merge = merged.events.find((event) => event.eventType === 'superseded')!;
    assert.equal(separated.events[0].reversesEventId, merge.eventId);
    // The merged row's history also lists its alias leaving with the merge: the survivor's event, with no revision here.
    assert.deepEqual(merged.events.map((event) => [event.eventType, event.revision === null ? 'left' : 'own', event.relatedTransactionId]), [
      ['identity-repointed', 'left', ids.fabrikam], ['superseded', 'own', ids.fabrikam], ['created', 'own', null],
    ]);
    const left = await owner.getTransactionSources(ids.fabrikam);
    assert.deepEqual([left.mergedRows, left.identities.map((identity) => identity.namespaceKind), left.transaction.revision], [[], ['legacy-file'], survivor.transaction.revision]);
    await refused(owner.unmergeTransaction(ids.fabrikamDuplicate, {
      expectedRevision: separated.transaction.revision, expectedSurvivorRevision: left.transaction.revision,
    }), 'merge-not-allowed', 409);

    // Once an alias the merge moved has been detached from the survivor, the merge can't be undone as it was: E2a answers
    // `link-not-reversible`, keeping `merge-not-allowed` for a row that isn't merged (handoff 10/18 02:30 item 1).
    const other = setup().owner;
    const fabrikam = await other.getTransactionSources(ids.fabrikam);
    const moved = fabrikam.identities.find((identity) => identity.namespaceKind === 'stable')!;
    await other.detachIdentity(moved.identityId, { transactionId: ids.fabrikam, expectedRevision: fabrikam.transaction.revision });
    await refused(other.unmergeTransaction(ids.fabrikamDuplicate, {
      expectedRevision: merged.transaction.revision, expectedSurvivorRevision: fabrikam.transaction.revision,
    }), 'link-not-reversible', 409);

    // Nor once the merge isn't the merged row's latest change.
    const third = setup();
    const thirdLedger = third.server.store.ledger;
    recordUserEdit(thirdLedger, thirdLedger.rows.get(ids.fabrikamDuplicate)!, ['notes'], third.server.now());
    await refused(third.owner.unmergeTransaction(ids.fabrikamDuplicate, {
      expectedRevision: thirdLedger.rows.get(ids.fabrikamDuplicate)!.revision, expectedSurvivorRevision: thirdLedger.rows.get(ids.fabrikam)!.revision,
    }), 'link-not-reversible', 409);

    // A change to the charge it was merged into doesn't count: E2a pins that charge only to the revision the owner saw.
    const fourth = setup();
    const fourthLedger = fourth.server.store.ledger;
    recordUserEdit(fourthLedger, fourthLedger.rows.get(ids.fabrikam)!, ['notes'], fourth.server.now());
    const apart = await fourth.owner.unmergeTransaction(ids.fabrikamDuplicate, {
      expectedRevision: fourthLedger.rows.get(ids.fabrikamDuplicate)!.revision, expectedSurvivorRevision: fourthLedger.rows.get(ids.fabrikam)!.revision,
    });
    assert.deepEqual([apart.transaction.values.status, apart.transaction.mergedIntoId], ['posted', null]);
  });

  test('separating a pending charge merged into the posted one it settled into brings it back pending, as E2a does', async () => {
    const { server, owner } = setup();
    const ledger = server.store.ledger;
    const posted = ledger.rows.get(ids.fabrikam)!;
    const scope = ledger.rows.get(ids.fabrikamDuplicate)!.values.cardScopeId!;
    const at = server.now();
    const pending = createRow(ledger, {
      transactionId: cardTransactionIdFor('settled/pending'), cardAccountRef: posted.cardAccountRef,
      values: { ...posted.values, status: 'pending', postedDate: null, cardScopeId: scope }, at,
      source: { via: 'file', actor: 'file-import', deviceId: null, reason: 'insert' },
      identity: { identityId: identityIdFor('settled/pending'), createdBy: 'extension', namespaceKind: 'capture', sourceScopeId: scope,
        scopeKind: 'known', firstSeenStatus: 'pending' },
    });
    mergeRow(ledger, pending, posted, 'settled-into', at + 1, { via: 'session', actor: 'owner', deviceId: null });
    const merged = await owner.getTransactionSources(pending.transactionId);
    assert.deepEqual([merged.transaction.values.status, merged.transaction.removedReason], ['removed', 'settled-into']);
    const survivor = await owner.getTransactionSources(ids.fabrikam);
    const apart = await owner.unmergeTransaction(pending.transactionId, {
      expectedRevision: merged.transaction.revision, expectedSurvivorRevision: survivor.transaction.revision,
    });
    // Pending again: it doesn't count in spending, so the confirmation (separateText) never says both count.
    assert.deepEqual([apart.transaction.values.status, apart.transaction.mergedIntoId, apart.identities.map((identity) => identity.status)],
      ['pending', null, ['active']]);
  });

  test('every repair needs the password confirmed within 5 minutes, reading does not; a pause or a blocked gate stops none', async () => {
    const { server, owner } = setup({ recentAuth: 'required' });
    const tailspin = await owner.getTransactionSources(ids.tailspin);
    const later = await owner.getTransactionSources(ids.tailspinLater);
    const coho = await owner.getTransactionSources(ids.coho);
    const duplicate = await owner.getTransactionSources(ids.fabrikamDuplicate);
    const fabrikam = await owner.getTransactionSources(ids.fabrikam);
    const repairs: Array<() => Promise<TransactionSources>> = [
      () => owner.repointIdentity(capture(tailspin).identityId, {
        fromTransactionId: ids.tailspin, expectedRevision: tailspin.transaction.revision, toTransactionId: ids.tailspinLater, expectedToRevision: later.transaction.revision,
      }),
      () => owner.detachIdentity(tailspin.identities[0].identityId, { transactionId: ids.tailspin, expectedRevision: tailspin.transaction.revision }),
      () => owner.revertChange(ids.coho, { eventId: coho.revertibleEventId!, expectedRevision: coho.transaction.revision }),
      () => owner.unmergeTransaction(ids.fabrikamDuplicate, { expectedRevision: duplicate.transaction.revision, expectedSurvivorRevision: fabrikam.transaction.revision }),
    ];
    for (const repair of repairs) await refused(repair(), 'recent-auth-required', 403);
    const untouched = server.store.ledger.events.length;
    await owner.confirmPassword(FAKE_OWNER_PASSWORD);
    await owner.pause();
    server.setGate('blocked');
    const state = await owner.getState();
    assert.deepEqual([state.settings.paused, state.gate, server.store.ledger.events.length], [true, 'blocked', untouched]);
    for (const repair of repairs) await repair();
    assert.ok(server.store.ledger.events.length > untouched);
    assertEventsHoldTogether(server);
  });

  test('a repair moves the account\'s ledger on: plans prepared before for its sets are retired, another account\'s are not', async () => {
    const { server, owner } = setup();
    const fileSetId = server.addFileReviewSet();
    const fileSet = await owner.getObservationSet(fileSetId);
    assert.notEqual(fileSet.cardAccountRef, (await owner.getTransactionSources(ids.tailspin)).transaction.cardAccountRef);
    const fileDecided = await owner.recordDecisions(fileSetId, {
      expectedVersion: fileSet.version,
      decisions: fileSet.items.map((entry) => ({ itemId: entry.itemId, action: 'same-transaction' as const, transactionId: entry.candidates[0].transactionId, cardScopeId: null })),
    });
    const filePlan = await owner.preparePlan(fileSetId, { expectedVersion: fileDecided.version, sourceReviewed: false });
    const chaseSetId = (await owner.getState()).bindings.find((item) => item.issuer === 'chase')!.sync.lastRun!.observationSetId!;
    const prepare = async () => owner.preparePlan(chaseSetId, { expectedVersion: (await owner.getObservationSet(chaseSetId)).version, sourceReviewed: false });
    const plan = await prepare();
    const tailspin = await owner.getTransactionSources(ids.tailspin);
    await owner.detachIdentity(capture(tailspin).identityId, { transactionId: ids.tailspin, expectedRevision: tailspin.transaction.revision });
    await refused(owner.commitPlan(plan.previewId, plan), 'preview-stale');
    assert.equal((await owner.commitPlan(filePlan.previewId, { payloadDigest: null, planDigest: filePlan.planDigest })).observationSetId, fileSetId);
    // A new plan, against the ledger as it is now, commits.
    const again = await prepare();
    assert.equal((await owner.commitPlan(again.previewId, again)).observationSetId, chaseSetId);
  });

  test('what a committed review wrote is in the ledger and can be undone there: a link that promoted a pending charge', async () => {
    const { server, owner } = setup();
    const setId = server.addLegacyPendingSet(1);
    const set = await owner.getObservationSet(setId);
    const entry = set.items[0];
    const target = entry.candidates[0].transactionId;
    const before = await owner.getTransactionSources(target);
    assert.equal(before.transaction.values.status, 'pending');
    const decided = await owner.recordDecisions(setId, {
      expectedVersion: set.version,
      decisions: [{ itemId: entry.itemId, action: 'attribute-and-link', transactionId: target, cardScopeId: entry.observation!.cardScopeId }],
    });
    const plan = await owner.preparePlan(setId, { expectedVersion: decided.version, sourceReviewed: false });
    await owner.commitPlan(plan.previewId, plan);
    const after = await owner.getTransactionSources(target);
    assert.deepEqual([after.transaction.values.status, after.transaction.values.cardScopeId, after.transaction.revision], [
      'posted', entry.observation!.cardScopeId, before.transaction.revision + 1,
    ]);
    assert.deepEqual(after.identities.map((identity) => [identity.createdBy, identity.status]), [['migration', 'active'], ['extension', 'active']]);
    // One update wrote two reversible events, the promotion and the card put on it (E1b's compound match): the promotion is the
    // one offered, by E1b's order corrected > promoted > restored > attributed, and one revert undoes both.
    const [attributed, promoted, linked] = after.events;
    assert.deepEqual([attributed.eventType, promoted.eventType, promoted.via, promoted.actor, promoted.identityId, linked.eventType], [
      'attributed', 'promoted', 'extension', 'owner', after.identities[1].identityId, 'identity-linked',
    ]);
    assert.deepEqual([attributed.revision, promoted.revision], [after.transaction.revision, after.transaction.revision]);
    assert.equal(after.revertibleEventId, promoted.eventId);
    await refused(owner.revertChange(target, { eventId: attributed.eventId, expectedRevision: after.transaction.revision }), 'action-not-allowed', 409);
    const undone = await owner.revertChange(target, { eventId: promoted.eventId, expectedRevision: after.transaction.revision });
    assert.deepEqual(undone.transaction.values, before.transaction.values);
    assert.deepEqual([undone.identities.map((identity) => identity.status), undone.revertibleEventId], [['active', 'active'], null]);
    // Each event of the one update keeps its own type's reason (E1b `ck_evt_*`): the card put on is an attribution.
    assert.deepEqual([promoted.reason, attributed.reason], ['same-transaction', 'attribution']);
    assertEventsHoldTogether(server);
  });

  test('changing a committed link takes it back only while its change is the charge\'s latest and its source still counts there; otherwise it is refused, writing nothing (E1b §4.9.2)', async () => {
    const commitLink = async () => {
      const { server, owner } = setup();
      const setId = server.addLegacyPendingSet(1);
      const set = await owner.getObservationSet(setId);
      const entry = set.items[0];
      const target = entry.candidates[0].transactionId;
      const decided = await owner.recordDecisions(setId, {
        expectedVersion: set.version,
        decisions: [{ itemId: entry.itemId, action: 'attribute-and-link', transactionId: target, cardScopeId: entry.observation!.cardScopeId }],
      });
      const plan = await owner.preparePlan(setId, { expectedVersion: decided.version, sourceReviewed: false });
      await owner.commitPlan(plan.previewId, plan);
      const reject = async () => {
        const committed = await owner.getObservationSet(setId);
        const changed = await owner.recordDecisions(setId, {
          expectedVersion: committed.version,
          decisions: [{ itemId: entry.itemId, action: 'reject-row', transactionId: null, cardScopeId: null }],
        });
        return owner.preparePlan(setId, { expectedVersion: changed.version, sourceReviewed: false });
      };
      return { server, owner, target, reject };
    };

    // Still the latest: the adjustment puts the charge back as it was before the link, and unlinks the observation.
    const kept = await commitLink();
    const linked = await kept.owner.getTransactionSources(kept.target);
    const adjustment = await kept.reject();
    assert.deepEqual(adjustment.effects.map((effect) => effect.effect), ['revert', 'unmatch']);
    await kept.owner.commitPlan(adjustment.previewId, adjustment);
    const back = await kept.owner.getTransactionSources(kept.target);
    assert.deepEqual([back.events[1].eventType, back.events[1].reason, back.events[1].reversesEventId], ['reversed', 'adjustment', linked.revertibleEventId]);
    assert.equal(back.transaction.values.status, 'pending');
    assertEventsHoldTogether(kept.server);

    // Undone already with Spending's own tools: nothing of the link's change is left to take back.
    const undone = await commitLink();
    const sources = await undone.owner.getTransactionSources(undone.target);
    await undone.owner.revertChange(undone.target, { eventId: sources.revertibleEventId!, expectedRevision: sources.transaction.revision });
    const written = undone.server.store.ledger.events.length;
    await refused(undone.reject(), 'action-not-allowed', 409);
    assert.equal(undone.server.store.ledger.events.length, written);
    assertEventsHoldTogether(undone.server);

    // The observation's source detached by a repair since: the commit can't be taken back as it was either.
    const moved = await commitLink();
    const linked2 = await moved.owner.getTransactionSources(moved.target);
    const own = linked2.identities.find((identity) => identity.createdBy === 'extension')!;
    await moved.owner.detachIdentity(own.identityId, { transactionId: moved.target, expectedRevision: linked2.transaction.revision });
    const before = moved.server.store.ledger.events.length;
    await refused(moved.reject(), 'action-not-allowed', 409);
    assert.equal(moved.server.store.ledger.events.length, before);
  });

  test('a kept-current correction whose source a repair moved can\'t become a correction again: nothing is pulled back (E1b §4.9.2)', async () => {
    const { server, owner } = setup();
    const citi = await openSet(owner, 'citi');
    const decided = await owner.recordDecisions(citi.observationSetId, { expectedVersion: citi.version, decisions: decideAll(citi, '') });
    const correction = decided.items.find((entry) => entry.category === 'posted-correction')!;
    const charge = correction.candidates[0].transactionId;
    const commit = async (expectedVersion: number) => {
      const plan = await owner.preparePlan(citi.observationSetId, { expectedVersion, sourceReviewed: false });
      await owner.commitPlan(plan.previewId, plan);
      return owner.getObservationSet(citi.observationSetId);
    };
    let set = await commit(decided.version);
    assert.equal(set.items.find((entry) => entry.itemId === correction.itemId)!.committed!.action, 'accept-correction');
    // Changed to "keep what Holdr has": the correction is taken back, and the source still counts under the same charge.
    const kept = await owner.recordDecisions(citi.observationSetId, {
      expectedVersion: set.version, decisions: [{ itemId: correction.itemId, action: 'keep-current', transactionId: null, cardScopeId: null }],
    });
    set = await commit(kept.version);
    const source = identityIdFor(`observation/${citi.observationSetId}/${correction.rowIndex}`);
    const other = server.store.sets.find((item) => item.observationSetId === citi.observationSetId)!.results.find((result) => result.rowIndex === 1)!.transactionId!;
    // Then a repair moves that source to another charge of the card.
    const from = await owner.getTransactionSources(charge);
    const to = await owner.getTransactionSources(other);
    await owner.repointIdentity(source, {
      fromTransactionId: charge, expectedRevision: from.transaction.revision, toTransactionId: other, expectedToRevision: to.transaction.revision,
    });
    const written = server.store.ledger.events.length;
    await refused(owner.recordDecisions(citi.observationSetId, {
      expectedVersion: set.version, decisions: [{ itemId: correction.itemId, action: 'accept-correction', transactionId: null, cardScopeId: null }],
    }), 'action-not-allowed', 409);
    const after = await owner.getObservationSet(citi.observationSetId);
    assert.deepEqual([after.version, after.items.find((entry) => entry.itemId === correction.itemId)!.decision], [set.version, null]);
    assert.equal(server.store.ledger.events.length, written);
    assert.equal(server.store.ledger.identities.get(source)!.canonicalId, other, 'the source stays where the repair put it');
    // What is in spending now can always be chosen again.
    await owner.recordDecisions(citi.observationSetId, {
      expectedVersion: set.version, decisions: [{ itemId: correction.itemId, action: 'keep-current', transactionId: null, cardScopeId: null }],
    });
  });

  test('a kept-current correction whose charge Holdr changed since can\'t become a correction again (E1b §4.9.2)', async () => {
    const { server, owner } = setup();
    const citi = await openSet(owner, 'citi');
    const decided = await owner.recordDecisions(citi.observationSetId, { expectedVersion: citi.version, decisions: decideAll(citi, '') });
    const correction = decided.items.find((entry) => entry.category === 'posted-correction')!;
    const charge = correction.candidates[0].transactionId;
    const commit = async (expectedVersion: number) => {
      const plan = await owner.preparePlan(citi.observationSetId, { expectedVersion, sourceReviewed: false });
      await owner.commitPlan(plan.previewId, plan);
      return owner.getObservationSet(citi.observationSetId);
    };
    let set = await commit(decided.version);
    const kept = await owner.recordDecisions(citi.observationSetId, {
      expectedVersion: set.version, decisions: [{ itemId: correction.itemId, action: 'keep-current', transactionId: null, cardScopeId: null }],
    });
    set = await commit(kept.version);
    // The bank corrects that charge again, through another capture.
    const row = server.store.ledger.rows.get(charge)!;
    changeValues(server.store.ledger, row, { ...row.values, amountMinor: row.values.amountMinor + 100 }, server.now(), {
      eventType: 'corrected', source: { via: 'extension', actor: 'owner', deviceId: null, reason: 'posted-correction' }, reversible: false,
    });
    await refused(owner.recordDecisions(citi.observationSetId, {
      expectedVersion: set.version, decisions: [{ itemId: correction.itemId, action: 'accept-correction', transactionId: null, cardScopeId: null }],
    }), 'action-not-allowed', 409);
  });

  test('changing one decision of a set leaves what another one can still take back as it was (E1b §4.9.2)', async () => {
    const { server, owner } = setup();
    const setId = server.addLegacyPendingSet(2);
    let set = await owner.getObservationSet(setId);
    const [first, second] = set.items;
    const link = { itemId: first.itemId, action: 'attribute-and-link' as const, transactionId: first.candidates[0].transactionId, cardScopeId: first.observation!.cardScopeId };
    const record = async (decisions: Decision[]) => {
      set = await owner.getObservationSet(setId);
      return owner.recordDecisions(setId, { expectedVersion: set.version, decisions });
    };
    const commit = async (version: number) => {
      const plan = await owner.preparePlan(setId, { expectedVersion: version, sourceReviewed: false });
      await owner.commitPlan(plan.previewId, plan);
    };
    await commit((await record([link, { itemId: second.itemId, action: 'insert-new', transactionId: null, cardScopeId: null }])).version);
    // A repair moves the first item's source to another charge.
    const source = identityIdFor(`observation/${setId}/${first.rowIndex}`);
    const from = await owner.getTransactionSources(link.transactionId);
    const to = await owner.getTransactionSources(ids.tailspinLater);
    await owner.repointIdentity(source, {
      fromTransactionId: link.transactionId, expectedRevision: from.transaction.revision, toTransactionId: ids.tailspinLater, expectedToRevision: to.transaction.revision,
    });
    // The second decision changes, with the first sent again as it is in spending: allowed, and the first still can't change.
    await commit((await record([link, { itemId: second.itemId, action: 'reject-row', transactionId: null, cardScopeId: null }])).version);
    await refused(record([{ itemId: first.itemId, action: 'reject-row', transactionId: null, cardScopeId: null }]), 'action-not-allowed', 409);
  });

  test('a source moved away and back still moved: the link it came with can no longer be changed (E1b §4.9.2)', async () => {
    const { server, owner } = setup();
    const setId = server.addLegacyPendingSet(1);
    const set = await owner.getObservationSet(setId);
    const entry = set.items[0];
    const charge = entry.candidates[0].transactionId;
    const decided = await owner.recordDecisions(setId, {
      expectedVersion: set.version,
      decisions: [{ itemId: entry.itemId, action: 'attribute-and-link', transactionId: charge, cardScopeId: entry.observation!.cardScopeId }],
    });
    const plan = await owner.preparePlan(setId, { expectedVersion: decided.version, sourceReviewed: false });
    await owner.commitPlan(plan.previewId, plan);
    const source = identityIdFor(`observation/${setId}/${entry.rowIndex}`);
    const move = async (fromId: string, toId: string) => {
      const from = await owner.getTransactionSources(fromId);
      const to = await owner.getTransactionSources(toId);
      await owner.repointIdentity(source, { fromTransactionId: fromId, expectedRevision: from.transaction.revision, toTransactionId: toId, expectedToRevision: to.transaction.revision });
    };
    await move(charge, ids.tailspinLater);
    await move(ids.tailspinLater, charge);
    const back = server.store.ledger.identities.get(source)!;
    assert.deepEqual([back.canonicalId, back.status], [charge, 'active'], 'back on the charge the commit put it on');
    const committed = await owner.getObservationSet(setId);
    const written = server.store.ledger.events.length;
    await refused(owner.recordDecisions(setId, {
      expectedVersion: committed.version, decisions: [{ itemId: entry.itemId, action: 'reject-row', transactionId: null, cardScopeId: null }],
    }), 'action-not-allowed', 409);
    assert.equal(server.store.ledger.events.length, written);
    assert.equal((await owner.getTransactionSources(charge)).transaction.values.status, 'posted', 'the link\'s promotion stays');
  });

  test('a row a commit added is taken back only while its values are as the commit left them: checked at the decision, the plan and the commit (E1b §4.9.2)', async () => {
    const { server, owner } = setup();
    const setId = server.addLegacyPendingSet(1);
    let set = await owner.getObservationSet(setId);
    const entry = set.items[0];
    const decide = async (action: 'insert-new' | 'reject-row') => {
      set = await owner.getObservationSet(setId);
      return owner.recordDecisions(setId, { expectedVersion: set.version, decisions: [{ itemId: entry.itemId, action, transactionId: null, cardScopeId: null }] });
    };
    const added = await decide('insert-new');
    const first = await owner.preparePlan(setId, { expectedVersion: added.version, sourceReviewed: false });
    await owner.commitPlan(first.previewId, first);
    const ledger = server.store.ledger;
    const row = ledger.rows.get(server.store.sets.find((item) => item.observationSetId === setId)!.items[0].insertedTransactionId!)!;
    // A category or notes edit doesn't change what a commit would take back.
    recordUserEdit(ledger, row, ['category'], server.now());
    const rejected = await decide('reject-row');
    const plan = await owner.preparePlan(setId, { expectedVersion: rejected.version, sourceReviewed: false });
    assert.deepEqual(plan.effects.map((effect) => effect.effect), ['remove']);
    // Meanwhile the bank corrects its amount (here without retiring the plan, as a change from elsewhere could arrive).
    changeValues(ledger, row, { ...row.values, amountMinor: row.values.amountMinor + 100 }, server.now(), {
      eventType: 'corrected', source: { via: 'extension', actor: 'owner', deviceId: null, reason: 'posted-correction' }, reversible: false,
    });
    const written = ledger.events.length;
    await refused(owner.commitPlan(plan.previewId, plan), 'action-not-allowed', 409);
    await refused(owner.preparePlan(setId, { expectedVersion: rejected.version, sourceReviewed: false }), 'action-not-allowed', 409);
    await refused(decide('reject-row'), 'action-not-allowed', 409);
    assert.deepEqual([ledger.events.length, row.values.status], [written, 'posted']);
    // The decision in spending can be chosen again, which clears the change.
    const restored = await decide('insert-new');
    assert.equal(restored.items[0].decision!.action, 'insert-new');
    assertEventsHoldTogether(server);
  });

  test('of the reversible events one update wrote, the one offered is the first of corrected, promoted, restored, attributed', () => {
    const ledger = emptyLedger();
    const values = { status: 'pending' as const, transactionDate: '2026-10-01', postedDate: null, amountMinor: 1_000, kind: 'purchase' as const,
      description: 'SYNTHETIC SHOP', merchant: null, cardScopeId: null };
    const source = { via: 'session' as const, actor: 'owner' as const, deviceId: null, reason: 'attribution' as const };
    const row = createRow(ledger, { transactionId: cardTransactionIdFor('order/1'), cardAccountRef: 'card-acct-x', values, at: 1, source: { ...source, reason: 'insert' }, identity: null });
    changeValues(ledger, row, { ...values, amountMinor: 1_100 }, 2, { eventType: 'attributed', source, reversible: true, alsoEvents: [{ eventType: 'restored', reason: 'restore' }] });
    assert.equal(revertibleEvent(ledger, row)!.eventType, 'restored');
    changeValues(ledger, row, { ...values, amountMinor: 1_200 }, 3, {
      eventType: 'attributed', source, reversible: true,
      alsoEvents: [{ eventType: 'restored', reason: 'restore' }, { eventType: 'corrected', reason: 'posted-correction' }, { eventType: 'promoted', reason: 'same-transaction' }],
    });
    assert.equal(revertibleEvent(ledger, row)!.eventType, 'corrected');
    // A later non-reversible change (a user edit keeps the marker) still offers the same; a removal offers none.
    recordUserEdit(ledger, row, ['notes'], 4);
    assert.equal(revertibleEvent(ledger, row)!.eventType, 'corrected');
    removeRow(ledger, row, 'dismissed', 5, { ...source, reason: 'dismissed' });
    assert.equal(revertibleEvent(ledger, row), null);
  });

  test('a page of a set\'s items pins the set version and the card\'s ledger revision: after a repair, the set is read again (R7)', async () => {
    const { server, owner } = setup();
    const setId = server.addLargeOpenSet(250);
    const first = server.handle({ method: 'GET', url: `/card-sync/owner/observation-sets/${setId}` }).body as SetDetail;
    const tailspin = await owner.getTransactionSources(ids.tailspin);
    await owner.detachIdentity(capture(tailspin).identityId, { transactionId: ids.tailspin, expectedRevision: tailspin.transaction.revision });
    const stale = server.handle({ method: 'GET', url: `/card-sync/owner/observation-sets/${setId}?itemsCursor=${first.nextItemsCursor}` });
    assert.deepEqual([stale.status, stale.body], [409, { error: 'version-conflict', currentVersion: first.version }]);
    const whole = await owner.getObservationSet(setId);
    assert.deepEqual([whole.version, whole.items.length], [first.version, 250]);
    // Items come set-level first, then by observation order, in every set.
    for (const set of server.store.sets) {
      const rows = (await owner.getObservationSet(set.observationSetId)).items.map((entry) => entry.rowIndex ?? -1);
      assert.deepEqual(rows, [...rows].sort((a, b) => a - b), set.observationSetId);
    }
  });

  test('every page of a plan\'s effects echoes the plan\'s digest and state (R7)', async () => {
    const { server, owner } = setup();
    const setId = server.addLargeOpenSet(600);
    const set = server.store.sets.find((item) => item.observationSetId === setId)!;
    server.core.recordDecisions(setId, set.version, set.items.map((entry) => ({ itemId: entry.itemId, action: 'insert-new' as const, transactionId: null, cardScopeId: null })));
    const plan = await owner.preparePlan(setId, { expectedVersion: set.version, sourceReviewed: false });
    const page = server.handle({ method: 'GET', url: `/card-sync/owner/plans/${plan.previewId}/effects?cursor=${pageCursor('effects', plan.previewId, api.PLAN_EFFECTS_PAGE)}` });
    const body = page.body as api.EffectPage;
    assert.deepEqual([page.status, body.planDigest, body.state, body.effects.length], [200, plan.planDigest, 'valid', 100]);
  });
});

describe('revision 6 (E1b): auto-sync off, removals from posted, and browsers closed after they ran out', () => {
  test('"off" on a retired binding changes nothing; on a live one it always moves the revision, retiring plans only when it withdrew consent (R1)', async () => {
    const { server, owner } = setup();
    server.setAutoSyncGate('open', 'chase');
    let chase = (await owner.getState()).bindings.find((item) => item.issuer === 'chase')!;
    const setId = chase.sync.lastRun!.observationSetId!;
    const prepare = async () => owner.preparePlan(setId, { expectedVersion: (await owner.getObservationSet(setId)).version, sourceReviewed: false });
    const kept = await prepare();
    const planState = (previewId: string) => server.store.sets.find((item) => item.observationSetId === setId)!.plans.find((item) => item.previewId === previewId)!.state;
    const off = await owner.setAutoSync(chase.bindingId, { expectedVersion: chase.bindingVersion, expectedAutoSyncRevision: chase.autoSync.revision, enabled: false });
    assert.equal(off.autoSync.revision, chase.autoSync.revision + 1, 'an off with nothing on still moves the revision');
    assert.equal(planState(kept.previewId), 'valid', 'it withdrew nothing, so no plan is retired');
    chase = await owner.setAutoSync(chase.bindingId, { expectedVersion: off.bindingVersion, expectedAutoSyncRevision: off.autoSync.revision, enabled: true });
    const plan = await prepare();
    const withdrawn = await owner.setAutoSync(chase.bindingId, { expectedVersion: chase.bindingVersion, expectedAutoSyncRevision: chase.autoSync.revision, enabled: false });
    assert.equal(withdrawn.autoSync.revision, chase.autoSync.revision + 1);
    assert.equal(planState(plan.previewId), 'superseded', 'an off that withdrew consent retires the plans');

    const wf = (await owner.getState()).bindings.find((item) => item.issuer === 'wellsfargo')!;
    const retired = await owner.retireBinding(wf.bindingId, wf.bindingVersion);
    const again = await owner.setAutoSync(wf.bindingId, { expectedVersion: retired.bindingVersion, expectedAutoSyncRevision: retired.autoSync.revision, enabled: false });
    assert.deepEqual([again.status, again.bindingVersion, again.autoSync.revision], ['retired', retired.bindingVersion, retired.autoSync.revision]);
  });

  test('a link to a row removed from posted attaches its alias and leaves the removal; one removed from pending is restored (C4)', async () => {
    const linkRemovedHit = async (removedFrom: 'pending' | 'posted') => {
      const { server, owner } = setup();
      const setId = server.addFileReviewSet();
      const set = server.store.sets.find((item) => item.observationSetId === setId)!;
      const hit = set.items.find((entry) => entry.reason === 'removed-hit' && entry.candidates[0]?.status === 'removed')!;
      const candidate = hit.candidates[0];
      if (removedFrom === 'posted') {
        candidate.removedFrom = 'posted';
        Object.assign(server.store.ledger.rows.get(candidate.transactionId)!, { removedFromStatus: 'posted', removedReason: 'mistaken-import' });
      }
      const detail = await owner.getObservationSet(setId);
      assert.ok(!('removedFrom' in detail.items.find((entry) => entry.itemId === hit.itemId)!.candidates[0]), 'never on the wire');
      const decided = await owner.recordDecisions(setId, {
        expectedVersion: detail.version,
        decisions: detail.items.map((entry) => ({ itemId: entry.itemId, action: 'same-transaction' as const, transactionId: entry.candidates[0].transactionId, cardScopeId: null })),
      });
      const plan = await owner.preparePlan(setId, { expectedVersion: decided.version, sourceReviewed: false });
      const effect = plan.effects.find((item) => item.itemId === hit.itemId)!.effect;
      await owner.commitPlan(plan.previewId, { payloadDigest: null, planDigest: plan.planDigest });
      const after = await owner.getTransactionSources(candidate.transactionId);
      assertEventsHoldTogether(server);
      return [effect, after.transaction.values.status, after.events.map((event) => event.eventType).slice(0, 2)];
    };
    assert.deepEqual(await linkRemovedHit('posted'), ['match', 'removed', ['identity-linked', 'removed']]);
    assert.deepEqual(await linkRemovedHit('pending'), ['promote', 'posted', ['restored', 'promoted']]);
  });

  test('an invite replaces only a browser still pending or active; one that runs out before the approval is closed as replaced, from its expiry (E1b §5.3, Q49, X34)', async () => {
    const { server, owner } = setup();
    let state = await owner.getState();
    const chase = state.bindings.find((item) => item.issuer === 'chase')!;
    const laptop = state.devices.find((device) => device.deviceLabel === 'Laptop Chrome')!;
    const setId = chase.sync.lastRun!.observationSetId!;
    // Three minutes before its 30 days run out, the owner pairs its replacement and the new browser redeems the code.
    server.advance(Date.parse(laptop.deviceExpiresAt!) - Date.parse(state.generatedAt) - 3 * MINUTE);
    const invite = await owner.createPairing({ bindingIds: [chase.bindingId], replacesDeviceId: laptop.deviceId });
    const fresh = server.redeemOpenPairing('Laptop Chrome new');
    const waiting = await owner.getObservationSet(setId);
    const plan = await owner.preparePlan(setId, { expectedVersion: waiting.version, sourceReviewed: false });
    // Its time runs out before the approval, inside the new browser's 10 minutes: alone, that holds nothing (revision 4).
    server.advance(4 * MINUTE);
    assert.equal((await owner.getObservationSet(setId)).state, 'accepted-uncommitted');
    // An invite made now can't name it any more.
    await refused(owner.createPairing({ bindingIds: [chase.bindingId], replacesDeviceId: laptop.deviceId }), 'not-found', 404);
    await owner.approvePairing(invite.pairing.pairingId, fresh);
    state = await owner.getState();
    const replaced = state.devices.find((device) => device.deviceId === laptop.deviceId)!;
    assert.deepEqual([replaced.status, replaced.revokeReason, replaced.revokedAt], ['revoked', 'rotated', laptop.deviceExpiresAt]);
    assert.equal((await owner.getObservationSet(setId)).state, 'blocked-review');
    await refused(owner.commitPlan(plan.previewId, plan), 'preview-stale', 409);
    // Nor a revoked one.
    await refused(owner.createPairing({ bindingIds: [chase.bindingId], replacesDeviceId: laptop.deviceId }), 'not-found', 404);
  });

  test('an owner\'s revoke of a browser that already ran out closes it from its expiry and holds what it sent (X34)', async () => {
    const { server, owner } = setup();
    const state = await owner.getState();
    const chase = state.bindings.find((item) => item.issuer === 'chase')!;
    const laptop = state.devices.find((device) => device.deviceLabel === 'Laptop Chrome')!;
    server.advance(Date.parse(laptop.deviceExpiresAt!) - Date.parse(state.generatedAt) + 2 * DAY);
    const revoked = await owner.revokeDevice(laptop.deviceId);
    assert.deepEqual([revoked.status, revoked.revokeReason, revoked.revokedAt], ['revoked', 'owner', laptop.deviceExpiresAt]);
    assert.equal((await owner.getObservationSet(chase.sync.lastRun!.observationSetId!)).state, 'blocked-review');
    // Again changes nothing.
    assert.deepEqual(await owner.revokeDevice(laptop.deviceId), revoked);
  });

  test('a browser never approved in time can still be revoked, by the owner or a password reset: from when it lapsed, with no approval (E1b §5.3, K19)', async () => {
    const { server, owner } = setup();
    const chase = (await owner.getState()).bindings.find((item) => item.issuer === 'chase')!.bindingId;
    const lapse = async (label: string) => {
      await owner.createPairing({ bindingIds: [chase], replacesDeviceId: null });
      const { deviceId } = server.redeemOpenPairing(label);
      server.advance(11 * MINUTE);
      const lapsed = (await owner.getState()).devices.find((item) => item.deviceId === deviceId)!;
      assert.deepEqual([lapsed.status, lapsed.revokeReason, lapsed.revokedAt, lapsed.approvedAt], ['expired', null, null, null]);
      return lapsed;
    };
    const first = await lapse('Spare Chrome');
    const revoked = await owner.revokeDevice(first.deviceId);
    assert.deepEqual([revoked.status, revoked.revokeReason, revoked.revokedAt, revoked.approvedAt, revoked.deviceExpiresAt], [
      'revoked', 'owner', first.pendingExpiresAt, null, null,
    ]);
    assert.deepEqual(await owner.revokeDevice(first.deviceId), revoked, 'again changes nothing');
    const second = await lapse('Spare Edge');
    server.resetPassword();
    const devices = (await owner.getState()).devices;
    const reset = devices.find((item) => item.deviceId === second.deviceId)!;
    assert.deepEqual([reset.status, reset.revokeReason, reset.revokedAt, reset.approvedAt, reset.deviceExpiresAt], [
      'revoked', 'password-reset', second.pendingExpiresAt, null, null,
    ]);
    // One revoked before keeps its own reason.
    assert.equal(devices.find((item) => item.deviceId === first.deviceId)!.revokeReason, 'owner');
  });

  test('a password reset revokes every browser not revoked yet, the ones that ran out included, and holds what they sent (E1b D30)', async () => {
    const { server, owner } = setup();
    let state = await owner.getState();
    const chase = state.bindings.find((item) => item.issuer === 'chase')!;
    const laptop = state.devices.find((device) => device.deviceLabel === 'Laptop Chrome')!;
    const before = new Map(state.devices.map((device) => [device.deviceId, device]));
    server.advance(Date.parse(laptop.deviceExpiresAt!) - Date.parse(state.generatedAt) + DAY);
    const setId = chase.sync.lastRun!.observationSetId!;
    assert.equal((await owner.getObservationSet(setId)).state, 'accepted-uncommitted');
    server.resetPassword();
    state = await owner.getState();
    for (const device of state.devices) {
      const earlier = before.get(device.deviceId)!;
      assert.equal(device.status, 'revoked', device.deviceLabel);
      assert.equal(device.revokeReason, earlier.status === 'revoked' ? earlier.revokeReason : 'password-reset', device.deviceLabel);
    }
    assert.equal(state.devices.find((device) => device.deviceId === laptop.deviceId)!.revokedAt, laptop.deviceExpiresAt);
    assert.equal((await owner.getObservationSet(setId)).state, 'blocked-review');
  });
});

describe('revision 7 (E1b): alias effects (X37)', () => {
  test('a hit on a known charge that brings a new id is an alias: listed and counted, never unchanged; the charge stays as it is and gains the source', async () => {
    const { server, owner } = setup();
    const chase = await openSet(owner, 'chase');
    const before = await owner.getTransactionSources(LEDGER_STORY_IDS.alpine);
    const plan = await owner.preparePlan(chase.observationSetId, { expectedVersion: chase.version, sourceReviewed: false });
    assert.deepEqual([plan.counts.insert, plan.counts.unchanged, plan.counts.aliased, plan.effectCount], [4, 1, 1, 5]);
    const aliases = plan.effects.filter((effect) => effect.effect === 'alias');
    assert.deepEqual(aliases.map((effect) => [effect.rowIndex, effect.transactionId, effect.itemId]), [[5, LEDGER_STORY_IDS.alpine, null]]);
    assert.deepEqual([aliases[0].before, aliases[0].after], [before.transaction.values, before.transaction.values]);
    // The row that changes and attaches nothing is counted, never listed.
    assert.ok(!plan.effects.some((effect) => effect.rowIndex === 1));
    await owner.commitPlan(plan.previewId, plan);
    const after = await owner.getTransactionSources(LEDGER_STORY_IDS.alpine);
    assert.deepEqual([after.transaction.revision, after.transaction.values], [before.transaction.revision, before.transaction.values]);
    assert.deepEqual(after.identities.map((identity) => [identity.createdBy, identity.namespaceKind, identity.status]), [
      ...before.identities.map((identity) => [identity.createdBy, identity.namespaceKind, identity.status]), ['extension', 'stable', 'active'],
    ]);
    assert.deepEqual([after.events[0].eventType, after.events[0].reason, after.events[0].via, after.events[0].actor], ['identity-linked', 'alias', 'extension', 'owner']);
    // Its own outcome stays `unchanged` (E1b): its values changed nothing.
    const run = await owner.getRun(chase.runId!);
    assert.deepEqual(run.results.find((entry) => entry.rowIndex === 5), { rowIndex: 5, result: 'unchanged', transactionId: LEDGER_STORY_IDS.alpine });
    assert.deepEqual(run.results.find((entry) => entry.rowIndex === 1), { rowIndex: 1, result: 'unchanged', transactionId: null });
    assertEventsHoldTogether(server);
  });
});

describe('revision 7 (E1b): page pins and cursors (X38, cursor binding, X42)', () => {
  const ids = LEDGER_STORY_IDS;
  const get = (server: FakeOwnerServer, url: string) => server.handle({ method: 'GET', url: `/card-sync/owner${url}` });

  test('a walk of an open set\'s items is refused when retention changed it between pages, and a fresh read starts over (X38)', async () => {
    const { server, owner } = setup();
    const setId = server.addLargeOpenSet(250);
    const set = server.store.sets.find((item) => item.observationSetId === setId)!;
    // The set gives its receipt up after 7 days: that moves its version, so a page read before it is refused.
    server.advance(set.receiptExpiresAt! - server.now() - MINUTE);
    const first = get(server, `/observation-sets/${setId}`).body as SetDetail;
    server.advance(2 * MINUTE);
    assert.deepEqual([get(server, `/observation-sets/${setId}?itemsCursor=${first.nextItemsCursor}`).status, set.version], [409, first.version + 1]);
    assert.equal((await owner.getObservationSet(setId)).items.length, 250);
    // Its 30 days run out between two pages: retention expires its items and moves the version; a fresh read shows it expired.
    const second = get(server, `/observation-sets/${setId}`).body as SetDetail;
    server.advance(set.expiresAt - server.now() + MINUTE);
    const late = get(server, `/observation-sets/${setId}?itemsCursor=${second.nextItemsCursor}`);
    assert.deepEqual([late.status, late.body], [409, { error: 'version-conflict', currentVersion: second.version + 1 }]);
    const expired = await owner.getObservationSet(setId);
    assert.deepEqual([expired.state, expired.itemCount, expired.items], ['expired-unreviewed', 0, []]);
  });

  test('a walk across a committed set\'s deadline is refused though nothing else moved; the fresh read offers no action (X38, C3)', async () => {
    const { server, owner } = setup();
    const setId = server.addLargeOpenSet(250);
    const set = server.store.sets.find((item) => item.observationSetId === setId)!;
    server.core.recordDecisions(setId, set.version, set.items.map((entry) => ({ itemId: entry.itemId, action: 'insert-new' as const, transactionId: null, cardScopeId: null })));
    const plan = await owner.preparePlan(setId, { expectedVersion: set.version, sourceReviewed: false });
    await owner.commitPlan(plan.previewId, plan);
    server.advance(set.expiresAt - server.now() - MINUTE);
    const first = get(server, `/observation-sets/${setId}`).body as SetDetail;
    assert.ok(first.items.every((entry) => entry.allowedActions.length > 0), 'still adjustable before the deadline');
    server.advance(2 * MINUTE);
    const late = get(server, `/observation-sets/${setId}?itemsCursor=${first.nextItemsCursor}`);
    assert.deepEqual([late.status, late.body], [409, { error: 'version-conflict', currentVersion: first.version }]);
    const fresh = await owner.getObservationSet(setId);
    assert.deepEqual([fresh.state, fresh.items.length, fresh.items.every((entry) => entry.allowedActions.length === 0)], ['committed', 250, true]);
  });

  test('every cursor is bound to its list and its resource: another kind, another resource or out of range is a 422, and it grants no access', async () => {
    const { server, owner } = setup();
    const refused = (url: string, path: string) => {
      const answer = get(server, url);
      assert.deepEqual([answer.status, answer.body], [422, { error: 'invalid-request', issues: [{ code: 'invalid-format', path }] }], url);
    };
    // Items: another set's cursor, a cursor without the pins, a position past any set.
    const a = server.addLargeOpenSet(250);
    const b = server.addLargeOpenSet(250);
    const ofA = get(server, `/observation-sets/${a}`).body as SetDetail;
    assert.equal(get(server, `/observation-sets/${a}?itemsCursor=${ofA.nextItemsCursor}`).status, 200);
    refused(`/observation-sets/${b}?itemsCursor=${ofA.nextItemsCursor}`, '$.itemsCursor');
    refused(`/observation-sets/${a}?itemsCursor=${pageCursor('items', a, 100)}`, '$.itemsCursor');
    refused(`/observation-sets/${a}?itemsCursor=${itemsCursor(a, { offset: 5_000, version: ofA.version, ledgerRevision: 1, pastDeadline: false })}`, '$.itemsCursor');
    // With its pins intact, a position at or past the set's end, or at its start, is no cursor Holdr gave either.
    const pinsOfA = itemsPinOf(a, ofA.nextItemsCursor!)!;
    refused(`/observation-sets/${a}?itemsCursor=${itemsCursor(a, { ...pinsOfA, offset: 250 })}`, '$.itemsCursor');
    refused(`/observation-sets/${a}?itemsCursor=${itemsCursor(a, { ...pinsOfA, offset: 0 })}`, '$.itemsCursor');
    // Lists: one list's cursor in another, and the runs of all bindings vs those of one.
    const closed = pageCursor('closed-sets', 'all', 1);
    assert.equal(get(server, `/observation-sets?view=closed&cursor=${closed}`).status, 200);
    refused(`/observation-sets?view=open&cursor=${closed}`, '$.cursor');
    refused(`/observation-sets?view=closed&cursor=${pageCursor('closed-sets', 'all', 0)}`, '$.cursor');
    const chase = server.store.bindings.find((binding) => binding.issuer === 'chase')!.bindingId;
    assert.equal(get(server, `/runs?cursor=${pageCursor('runs', 'all', 1)}`).status, 200);
    refused(`/runs?bindingId=${chase}&cursor=${pageCursor('runs', 'all', 1)}`, '$.cursor');
    // A plan's effects: another plan's cursor, or another kind's.
    const chaseSet = await owner.getObservationSet(server.store.sets[0].observationSetId);
    const plan = await owner.preparePlan(chaseSet.observationSetId, { expectedVersion: chaseSet.version, sourceReviewed: false });
    refused(`/plans/${plan.previewId}/effects?cursor=${pageCursor('effects', `prv_${'a'.repeat(32)}`, 1)}`, '$.cursor');
    refused(`/plans/${plan.previewId}/effects?cursor=${pageCursor('runs', plan.previewId, 1)}`, '$.cursor');
    // Its effects never change, so a position at or past their end is no cursor Holdr gave.
    assert.equal(get(server, `/plans/${plan.previewId}/effects?cursor=${pageCursor('effects', plan.previewId, plan.effectCount - 1)}`).status, 200);
    refused(`/plans/${plan.previewId}/effects?cursor=${pageCursor('effects', plan.previewId, plan.effectCount)}`, '$.cursor');
    // A charge's lists: another charge's history cursor, and an alias cursor given as a merged-row one.
    const tailspin = server.store.ledger.rows.get(ids.tailspin)!;
    for (let index = 0; index < 120; index += 1) recordUserEdit(server.store.ledger, tailspin, ['notes'], server.now());
    const history = (get(server, `/transactions/${ids.tailspin}/sources`).body as TransactionSources).nextEventsCursor!;
    assert.equal(get(server, `/transactions/${ids.tailspin}/sources?eventsCursor=${history}`).status, 200);
    refused(`/transactions/${ids.coho}/sources?eventsCursor=${history}`, '$.eventsCursor');
    refused(`/transactions/${ids.tailspin}/sources?mergedRowsCursor=${keysetCursor('identities', ids.tailspin, 1, 'a'.repeat(32))}`, '$.mergedRowsCursor');
    // A cursor grants no access: one sent for a set that isn't there is the 404 any unknown id gets.
    assert.equal(get(server, `/observation-sets/obs_${'p'.repeat(32)}?itemsCursor=${ofA.nextItemsCursor}`).status, 404);
  });

  test('a cursor out of range is a 422 before any pin is compared; only valid pins that moved are a 409', async () => {
    const { server } = setup();
    const refusedBy = (on: FakeOwnerServer, url: string, path: string) => {
      const answer = get(on, url);
      assert.deepEqual([answer.status, answer.body], [422, { error: 'invalid-request', issues: [{ code: 'invalid-format', path }] }], url);
    };
    // A list: Holdr gives a cursor only for a position inside it, so its exact end, past it and far past it are refused.
    server.addCommittedHistory(60);
    const total = server.store.runs.length;
    const first = get(server, '/runs').body as { nextCursor: string };
    assert.equal(get(server, `/runs?cursor=${first.nextCursor}`).status, 200);
    assert.equal(get(server, `/runs?cursor=${pageCursor('runs', 'all', total - 1)}`).status, 200);
    for (const offset of [total, total + 1, 999_999]) refusedBy(server, `/runs?cursor=${pageCursor('runs', 'all', offset)}`, '$.cursor');
    // An empty list is one empty first page, and no position in it is a cursor Holdr gave.
    const { server: fresh } = setup({ scenario: 'fresh' });
    assert.deepEqual([get(fresh, '/observation-sets?view=closed').status, get(fresh, '/observation-sets?view=closed').body], [200, { observationSets: [], nextCursor: null }]);
    refusedBy(fresh, `/observation-sets?view=closed&cursor=${pageCursor('closed-sets', 'all', 1)}`, '$.cursor');
    // A set's items: a position, version or ledger revision outside its range is refused before the pins are compared.
    const setId = server.addLargeOpenSet(250);
    const page = get(server, `/observation-sets/${setId}`).body as SetDetail;
    const pins = itemsPinOf(setId, page.nextItemsCursor!)!;
    for (const bad of [{ offset: 2_001 }, { version: 0 }, { version: 2_147_483_648 }, { ledgerRevision: 2_147_483_648 }]) {
      refusedBy(server, `/observation-sets/${setId}?itemsCursor=${itemsCursor(setId, { ...pins, ...bad })}`, '$.itemsCursor');
    }
    // Pins in range that moved are a 409: the set moved on, and the client reads it again.
    const stale = get(server, `/observation-sets/${setId}?itemsCursor=${itemsCursor(setId, { ...pins, version: pins.version + 1 })}`);
    assert.deepEqual([stale.status, stale.body], [409, { error: 'version-conflict', currentVersion: pins.version }]);
    // A charge's history: a position before an event not written yet is no cursor Holdr gave.
    const newest = server.store.ledger.seq;
    assert.equal(get(server, `/transactions/${ids.tailspin}/sources?eventsCursor=${eventsCursor(ids.tailspin, newest)}`).status, 200);
    refusedBy(server, `/transactions/${ids.tailspin}/sources?eventsCursor=${eventsCursor(ids.tailspin, newest + 1)}`, '$.eventsCursor');
  });

  test('an effects page states the plan as E1b maps it: prepared is valid, consumed is committed, cancelled is superseded (X42); none past expiresAt', async () => {
    const { server, owner } = setup();
    const setId = server.addLargeOpenSet(600);
    const set = server.store.sets.find((item) => item.observationSetId === setId)!;
    const decideAll = () => server.core.recordDecisions(setId, set.version, set.items.map((entry) => ({ itemId: entry.itemId, action: 'insert-new' as const, transactionId: null, cardScopeId: null })));
    const stateOf = (plan: api.Plan) => (get(server, `/plans/${plan.previewId}/effects?cursor=${plan.nextEffectsCursor}`).body as api.EffectPage).state;
    decideAll();
    const page = server.handle({
      method: 'POST', url: `/card-sync/owner/observation-sets/${setId}/plan`, headers: { 'x-holdr-request': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: set.version, sourceReviewed: false }),
    }).body as api.Plan;
    assert.equal(stateOf(page), 'valid');
    // A new decision cancels the prepared plan: superseded.
    server.core.recordDecisions(setId, set.version, [{ itemId: set.items[0].itemId, action: 'reject-row', transactionId: null, cardScopeId: null }]);
    assert.equal(stateOf(page), 'superseded');
    decideAll();
    const plan = await owner.preparePlan(setId, { expectedVersion: set.version, sourceReviewed: false });
    const result = await owner.commitPlan(plan.previewId, plan);
    const committed = server.store.sets.find((item) => item.observationSetId === setId)!.plans.find((item) => item.previewId === plan.previewId)!;
    assert.equal(effectState(server, committed.previewId), 'committed');
    // Past its `expiresAt` no page of it is read, committed or not (E1b §5.6: 410); its commit still replays (a lost answer).
    server.advance(Date.parse(plan.expiresAt) - server.now());
    const late = server.handle({ method: 'GET', url: `/card-sync/owner/plans/${plan.previewId}/effects?cursor=${pageCursor('effects', plan.previewId, api.PLAN_EFFECTS_PAGE)}` });
    assert.deepEqual([late.status, late.body], [410, { error: 'plan-expired' }]);
    assert.deepEqual(await owner.commitPlan(plan.previewId, plan), result);
  });
});

describe('revision 8 (E1b): an invitation closes with its pending browser; receipts stay', () => {
  test('every revocation of a pending browser closes its redeemed invite (owner, password reset, replacement): approving it is 409 pairing-closed', async () => {
    const { server, owner } = setup();
    const chase = (await owner.getState()).bindings.find((item) => item.issuer === 'chase')!.bindingId;
    const statusOf = (pairingId: string) => server.store.pairings.find((item) => item.pairingId === pairingId)!.status;
    const pending = async (label: string) => {
      const invite = await owner.createPairing({ bindingIds: [chase], replacesDeviceId: null });
      return { pairingId: invite.pairing.pairingId, device: server.redeemOpenPairing(label) };
    };
    const byOwner = await pending('Spare Chrome');
    await owner.revokeDevice(byOwner.device.deviceId);
    assert.equal(statusOf(byOwner.pairingId), 'cancelled');
    await refused(owner.approvePairing(byOwner.pairingId, byOwner.device), 'pairing-closed', 409);
    // Named by the invite of the browser that replaces it: approving that one closes this one's invite too.
    const replaced = await pending('Spare Edge');
    const replacement = await owner.createPairing({ bindingIds: [chase], replacesDeviceId: replaced.device.deviceId });
    await owner.approvePairing(replacement.pairing.pairingId, server.redeemOpenPairing('Spare Edge new'));
    assert.equal((await owner.getState()).devices.find((item) => item.deviceId === replaced.device.deviceId)!.revokeReason, 'rotated');
    assert.equal(statusOf(replaced.pairingId), 'cancelled');
    await refused(owner.approvePairing(replaced.pairingId, replaced.device), 'pairing-closed', 409);
    const byReset = await pending('Spare Firefox');
    server.resetPassword();
    assert.equal(statusOf(byReset.pairingId), 'cancelled');
    await refused(owner.approvePairing(byReset.pairingId, byReset.device), 'pairing-closed', 409);
    // An approved browser's invite stays approved: only a redeemed one closes.
    assert.equal(statusOf(replacement.pairing.pairingId), 'approved');
  });

  test('revoking a browser or its 30 days running out never removes a receipt: what it sent stays readable for its 7 days', async () => {
    const { server, owner } = setup();
    const state = await owner.getState();
    const chase = state.bindings.find((item) => item.issuer === 'chase')!;
    const laptop = state.devices.find((device) => device.deviceLabel === 'Laptop Chrome')!;
    const runId = chase.sync.lastRun!.runId;
    const readable = () => server.handle({ method: 'GET', url: `/card-sync/owner/runs/${runId}/payload` }).status;
    const receiptExpiresAt = Date.parse((await owner.getRun(runId)).receiptExpiresAt!);
    assert.ok(Date.parse(laptop.deviceExpiresAt!) < receiptExpiresAt, 'the browser runs out while its receipt is kept');
    // Its 30 days run out: the receipt stays.
    server.advance(Date.parse(laptop.deviceExpiresAt!) - Date.parse(state.generatedAt) + MINUTE);
    assert.equal((await owner.getState()).devices.find((device) => device.deviceId === laptop.deviceId)!.status, 'expired');
    assert.deepEqual([readable(), (await owner.getRun(runId)).receiptAvailable], [200, true]);
    // Revoked afterwards: its set is held for a source check, and the receipt still stays.
    await owner.revokeDevice(laptop.deviceId);
    assert.equal((await owner.getObservationSet(chase.sync.lastRun!.observationSetId!)).state, 'blocked-review');
    assert.deepEqual([readable(), (await owner.getRun(runId)).receiptAvailable], [200, true]);
    // Only its 7 days end it.
    server.advance(receiptExpiresAt - server.now());
    assert.equal(readable(), 410);
  });
});

/** The state an effects page of a committed plan's second page says. */
function effectState(server: FakeOwnerServer, previewId: string): string {
  const answer = server.handle({ method: 'GET', url: `/card-sync/owner/plans/${previewId}/effects?cursor=${pageCursor('effects', previewId, api.PLAN_EFFECTS_PAGE)}` });
  return (answer.body as api.EffectPage).state;
}
describe('the fake answers as E2a does where the proposal differed (handoff 10/18 02:30)', () => {
  test('a charge it doesn\'t have is 404 transaction-not-found; a query on a POST is refused before the body; a plan is 200', async () => {
    const { server, owner } = setup();
    const missing = server.handle({ method: 'GET', url: `/card-sync/owner/transactions/card-txn-${'f'.repeat(32)}/sources` });
    assert.deepEqual([missing.status, missing.body], [404, { error: 'transaction-not-found' }]);
    await refused(owner.unmergeTransaction(`card-txn-${'f'.repeat(32)}`, { expectedRevision: 1, expectedSurvivorRevision: 1 }), 'transaction-not-found', 404);
    const post = (url: string, body: unknown) => server.handle({ method: 'POST', url, headers: { 'x-holdr-request': '1', 'content-type': 'application/json' },
      body: JSON.stringify(body) });
    const withQuery = post('/card-sync/owner/pause?now=1', {});
    assert.deepEqual([withQuery.status, withQuery.body], [422, { error: 'invalid-request', issues: [{ code: 'unknown-key', path: '$.<key>' }] }]);
    assert.equal(server.store.paused, false, 'nothing was done');
    const set = server.store.sets[0];
    assert.equal(post(`/card-sync/owner/observation-sets/${set.observationSetId}/plan`, { expectedVersion: set.version, sourceReviewed: false }).status, 200);
  });
});