import { afterEach, describe, expect, it } from 'vitest';

import {
  AuthorizationBlockedError, type AuthorizationChangeKind, type CardSyncAuthorizationService, type GenerationReport, type GenerationStep,
} from '../../control/authorizationChange.js';
import { newGeneration } from '../../control/syncAuthState.js';
import { cardSyncRefusalCode } from '../../services/cardSync/refusals.js';
import { deviceFingerprint, deviceTokenDigest, pairingCodeDigest, randomCardSyncLetters } from '../../services/cardSyncDigests.js';
import { CardSyncOwnerWorld } from '../../testing/cardSyncOwnerWorld.js';

/**
 * E2b's owner routes (owner API §3.1–§3.4) over the real app and repository, with an in-memory gate: the generation protocol
 * itself is tested against PR B's fence in control/authorizationChange.test.ts and, end to end, in authorization.gate.test.ts.
 * Here the gate only says open or blocked, so these run on every platform. Synthetic data only.
 */

const ORIGIN = 'https://holdr.test';

interface Gate extends CardSyncAuthorizationService {
  blocked: boolean;
  changes: AuthorizationChangeKind[];
}

/** A gate that is open or blocked as the test says; open, it hands the repository the database's generation (E1b §10 item 2). */
function memoryGate(databaseGeneration: () => string): Gate {
  const gate: Gate = {
    wired: true,
    blocked: false,
    changes: [],
    generationForSourceChecks: () => (gate.blocked ? null : databaseGeneration()),
    status: () => (gate.blocked ? 'blocked' : 'open'),
    async change<R extends GenerationReport>(kind: AuthorizationChangeKind, call: (step: GenerationStep) => R): Promise<R> {
      gate.changes.push(kind);
      if (gate.blocked && kind === 'widening') throw new AuthorizationBlockedError();
      return call({ expectedGeneration: databaseGeneration(), nextGeneration: newGeneration() });
    },
    reconcile: async () => false,
  };
  return gate;
}

let w: CardSyncOwnerWorld;
let gate: Gate;
afterEach(() => w?.close());

async function create(options: { deviceApi?: 'enabled' | 'disabled'; holdrOrigin?: string | null } = {}) {
  w = await CardSyncOwnerWorld.create({
    authorization: (world) => {
      gate = memoryGate(() => world.generation());
      return { gate, holdrOrigin: options.holdrOrigin === undefined ? ORIGIN : options.holdrOrigin, deviceApi: options.deviceApi ?? 'enabled' };
    },
  });
  return w;
}

const owner = (path: string) => `/card-sync/owner${path}`;
const settingsVersion = () => w.repo.getCardSyncSettings().settingsVersion;

/** A browser that redeemed this invitation's code, as E2c's redeem route will do it (the device side is E2c's). */
function redeem(code: string, label = 'Laptop Chrome') {
  const token = `hdv1_${randomCardSyncLetters()}${randomCardSyncLetters()}`;
  const deviceId = `dev_${randomCardSyncLetters()}`;
  const result = w.repo.redeemCardSyncPairing({
    codeDigest: pairingCodeDigest(code), deviceId, tokenDigest: deviceTokenDigest(token), fingerprint: deviceFingerprint(token),
    label, clientVersion: '1.2.3', expectedGeneration: w.generation(), nextGeneration: newGeneration(),
  });
  if (!result.ok) throw new Error('redeem failed');
  return { deviceId, token, fingerprint: deviceFingerprint(token) };
}

describe('pause, resume and issuers (§3.2)', () => {
  it('pauses without a version and always wins; resume needs recent auth and the version the owner saw', async () => {
    await create();
    const paused = await w.post(owner('/pause'), {});
    expect(paused.status).toBe(200);
    expect(paused.body).toEqual({ paused: true, pausedAt: w.now(), settingsVersion: 2, issuers: [
      { issuer: 'amex', enabled: false, enabledAt: null }, { issuer: 'chase', enabled: false, enabledAt: null },
      { issuer: 'citi', enabled: false, enabledAt: null }, { issuer: 'wellsfargo', enabled: false, enabledAt: null },
    ] });
    const generation = w.generation();
    expect((await w.post(owner('/pause'), {})).body.settingsVersion).toBe(2);
    expect(w.generation()).toBe(generation);
    expect(gate.changes).toEqual(['narrowing', 'narrowing']);

    expect((await w.post(owner('/resume'), { expectedVersion: 2 })).body).toEqual({ error: 'recent-auth-required' });
    expect((await w.reverify()).status).toBe(200);
    const stale = await w.post(owner('/resume'), { expectedVersion: 1 });
    expect([stale.status, stale.body]).toEqual([409, { error: 'version-conflict', currentVersion: 2 }]);
    const resumed = await w.post(owner('/resume'), { expectedVersion: 2 });
    expect([resumed.status, resumed.body.paused, resumed.body.settingsVersion]).toEqual([200, false, 3]);
  });

  it('enables an issuer with the risk acknowledged, and Amex and Citi only with the MAIN-world consent; disables without recent auth', async () => {
    await create();
    await w.reverify();
    const unacknowledged = await w.post(owner('/issuers/amex/enable'), { expectedVersion: 1, riskAcknowledged: true, mainWorldAcknowledged: false });
    expect([unacknowledged.status, unacknowledged.body]).toEqual([422,
      { error: 'invalid-request', issues: [{ code: 'inconsistent', path: '$.mainWorldAcknowledged' }] }]);
    const noRisk = await w.post(owner('/issuers/chase/enable'), { expectedVersion: 1, riskAcknowledged: false, mainWorldAcknowledged: false });
    expect(noRisk.body).toEqual({ error: 'invalid-request', issues: [{ code: 'invalid-enum', path: '$.riskAcknowledged' }] });
    expect((await w.post(owner('/issuers/visa/enable'), { expectedVersion: 1, riskAcknowledged: true, mainWorldAcknowledged: false })).status)
      .toBe(404);
    const enabled = await w.post(owner('/issuers/amex/enable'), { expectedVersion: 1, riskAcknowledged: true, mainWorldAcknowledged: true });
    expect(enabled.status).toBe(200);
    expect(enabled.body.issuers[0]).toEqual({ issuer: 'amex', enabled: true, enabledAt: w.now() });
    expect(w.repo.getCardSyncSettings().issuers[0]).toMatchObject({ approvedContractVersion: 1, mainWorldAccepted: true });
    w.tick(301);
    const disabled = await w.post(owner('/issuers/amex/disable'), {});
    expect([disabled.status, disabled.body.issuers[0]]).toEqual([200, { issuer: 'amex', enabled: false, enabledAt: null }]);
    expect(gate.changes).toEqual(['widening', 'narrowing']);
  });
});

describe('a blocked gate (owner API rule 7)', () => {
  it('refuses every widening change with 409 authorization-blocked and lets every narrowing one through', async () => {
    await create();
    w.enable('chase');
    const binding = w.binding();
    const device = w.device([binding.bindingId]);
    await w.reverify();
    gate.blocked = true;
    const widening: Array<[string, unknown]> = [
      ['/resume', { expectedVersion: settingsVersion() }],
      ['/issuers/citi/enable', { expectedVersion: settingsVersion(), riskAcknowledged: true, mainWorldAcknowledged: true }],
      ['/bindings', { issuer: 'chase', source: 'chase-api', cardAccountRef: w.account('chase'), bindingLabel: 'Other card',
        scopes: [{ scopeLabel: 'Card', holderAlias: 'alex', last4: '4444' }] }],
      [`/bindings/${binding.bindingId}/confirm`, { expectedVersion: 1, bindingLabel: 'Card activity', scopes: [], regrantDeviceIds: [] }],
      [`/bindings/${binding.bindingId}/auto-sync`, { expectedVersion: 1, expectedAutoSyncRevision: 1, enabled: true }],
      ['/pairings', { bindingIds: [binding.bindingId], replacesDeviceId: null }],
      [`/devices/${device.deviceId}/regrant`, { bindingIds: [binding.bindingId] }],
    ];
    for (const [path, body] of widening) {
      const res = await w.post(owner(path), body);
      expect([path, res.status, res.body]).toEqual([path, 409, { error: 'authorization-blocked' }]);
    }
    const narrowing: Array<[string, unknown]> = [
      ['/pause', {}],
      ['/issuers/chase/disable', {}],
      [`/bindings/${binding.bindingId}/auto-sync`, { expectedVersion: 1, expectedAutoSyncRevision: 0, enabled: false }],
      [`/devices/${device.deviceId}/revoke`, {}],
      [`/bindings/${binding.bindingId}/retire`, { expectedVersion: 1 }],
    ];
    for (const [path, body] of narrowing) expect([path, (await w.post(owner(path), body)).status]).toEqual([path, 200]);
    expect(w.repo.getCardSyncDevice(device.deviceId)).toMatchObject({ status: 'revoked', revokeReason: 'owner' });
  });
});

describe('bindings and card scopes (§3.3)', () => {
  it('creates a confirmed binding with the unknown scope, answered as Binding with its sync summary', async () => {
    await create();
    w.enable('chase');
    await w.reverify();
    const cardAccountRef = w.account('chase');
    const res = await w.post(owner('/bindings'), {
      issuer: 'chase', source: 'chase-api', cardAccountRef, bindingLabel: 'Chase Sapphire',
      scopes: [{ scopeLabel: 'Alex card', holderAlias: 'alex', last4: '1111' }, { scopeLabel: 'Casey card', holderAlias: 'casey', last4: null }],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      bindingVersion: 1, issuer: 'chase', source: 'chase-api', bindingLabel: 'Chase Sapphire', cardAccountRef, status: 'confirmed',
      statusReason: null, confirmedAt: w.now(), autoSync: { gate: 'closed', eligible: false, revision: 1, devices: [] }, deviceIds: [],
      sync: { lastRun: null, lastAcceptedAt: null, lastCommittedAt: null, openSets: 0, coverage: [] },
    });
    expect(res.body.scopes.map((scope: { kind: string; holderAlias: string }) => [scope.kind, scope.holderAlias]))
      .toEqual([['known', 'alex'], ['known', 'casey'], ['unknown', 'unknown']]);
    const again = await w.post(owner('/bindings'), {
      issuer: 'chase', source: 'chase-api', cardAccountRef, bindingLabel: 'Again', scopes: [{ scopeLabel: 'Card', holderAlias: 'alex', last4: '1111' }],
    });
    expect([again.status, again.body]).toEqual([409, { error: 'binding-exists' }]);
  });

  it('refuses a source of another issuer, a card account of another issuer, an unknown account and labels with card data', async () => {
    await create();
    await w.reverify();
    const chase = w.account('chase');
    const scopes = [{ scopeLabel: 'Card', holderAlias: 'alex', last4: '1111' }];
    const mismatch = await w.post(owner('/bindings'), { issuer: 'amex', source: 'chase-api', cardAccountRef: chase, bindingLabel: 'X', scopes });
    expect(mismatch.body).toEqual({ error: 'invalid-request', issues: [{ code: 'inconsistent', path: '$.source' }] });
    const otherIssuer = await w.post(owner('/bindings'), { issuer: 'amex', source: 'amex-api-rest', cardAccountRef: chase, bindingLabel: 'X', scopes });
    expect([otherIssuer.status, otherIssuer.body]).toEqual([409, { error: 'card-account-mismatch' }]);
    const missing = await w.post(owner('/bindings'), {
      issuer: 'chase', source: 'chase-api', cardAccountRef: `card-acct-${'a'.repeat(32)}`, bindingLabel: 'X', scopes,
    });
    expect([missing.status, missing.body]).toEqual([404, { error: 'not-found' }]);
    const secret = await w.post(owner('/bindings'), {
      issuer: 'chase', source: 'chase-api', cardAccountRef: chase, bindingLabel: 'Card 4111 1111 1111 1111', scopes,
    });
    expect(secret.status).toBe(422);
    expect(JSON.stringify(secret.body)).not.toMatch(/4111/);
    expect(w.repo.listCardSourceBindings()).toEqual([]);
  });

  it('re-confirms with re-grants: duplicate or unknown browsers are 422, a stale version 409 with the binding\'s version', async () => {
    await create();
    w.enable('chase');
    const binding = w.binding();
    const device = w.device([binding.bindingId]);
    const [alex] = binding.scopes;
    await w.reverify();
    const scopes = [{ cardScopeId: alex.cardScopeId, scopeLabel: 'Alex card', holderAlias: 'alex', last4: '1111' }];
    const path = owner(`/bindings/${binding.bindingId}/confirm`);
    const duplicate = await w.post(path, { expectedVersion: 1, bindingLabel: 'Card activity', scopes, regrantDeviceIds: [device.deviceId, device.deviceId] });
    expect(duplicate.body).toEqual({ error: 'invalid-request', issues: [{ code: 'duplicate', path: '$.regrantDeviceIds[1]' }] });
    const unknown = await w.post(path, { expectedVersion: 1, bindingLabel: 'Card activity', scopes, regrantDeviceIds: [`dev_${'b'.repeat(32)}`] });
    expect(unknown.body).toEqual({ error: 'invalid-request', issues: [{ code: 'unknown-reference', path: '$.regrantDeviceIds' }] });
    const stale = await w.post(path, { expectedVersion: 7, bindingLabel: 'Card activity', scopes, regrantDeviceIds: [] });
    expect([stale.status, stale.body]).toEqual([409, { error: 'version-conflict', currentVersion: 1 }]);
    // Confirmed without the browser: its grant is stale; then re-granted from the device's answer.
    const revision = w.repo.getCardSourceBinding(binding.bindingId)!.autoSync.revision;
    const confirmed = await w.post(path, { expectedVersion: 1, bindingLabel: 'Card activity', scopes, regrantDeviceIds: [] });
    expect([confirmed.status, confirmed.body.bindingVersion, confirmed.body.autoSync.revision]).toEqual([200, 2, revision + 1]);
    expect(w.repo.getCardSyncOwnerDevice(device.deviceId)!.staleBindingIds).toEqual([binding.bindingId]);
    const regranted = await w.post(owner(`/devices/${device.deviceId}/regrant`), { bindingIds: [binding.bindingId] });
    expect([regranted.status, regranted.body.staleBindingIds, regranted.body.status]).toEqual([200, [], 'active']);
    expect((await w.post(owner(`/devices/${device.deviceId}/regrant`), { bindingIds: [binding.bindingId, binding.bindingId] })).body)
      .toEqual({ error: 'invalid-request', issues: [{ code: 'duplicate', path: '$.bindingIds[1]' }] });
    const retireStale = await w.post(owner(`/bindings/${binding.bindingId}/retire`), { expectedVersion: 1 });
    expect([retireStale.status, retireStale.body]).toEqual([409, { error: 'version-conflict', currentVersion: 2 }]);
    const retired = await w.post(owner(`/bindings/${binding.bindingId}/retire`), { expectedVersion: 2 });
    expect([retired.status, retired.body.status, retired.body.deviceIds]).toEqual([200, 'retired', []]);
  });

  it('auto-sync: every off moves the revision without recent auth (R1); on needs recent auth, both versions and an open gate', async () => {
    await create();
    w.enable('chase');
    const binding = w.binding();
    const device = w.device([binding.bindingId]);
    // One manual run of this binding went accepted, planned and committed: it is eligible (E1b §5.2).
    w.ingest(device, binding, [{ scope: binding.scopes[0].cardScopeId, date: '2026-10-01', amount: 1250, description: 'FOURTH COFFEE', id: 'sor-1' }]);
    const path = owner(`/bindings/${binding.bindingId}/auto-sync`);
    const revision = () => w.repo.getCardSourceBinding(binding.bindingId)!.autoSync.revision;
    const start = revision();
    const off = await w.post(path, { expectedVersion: 1, expectedAutoSyncRevision: start, enabled: false });
    expect([off.status, off.body.autoSync.revision]).toEqual([200, start + 1]);
    const generation = w.generation();
    expect((await w.post(path, { expectedVersion: 99, expectedAutoSyncRevision: 99, enabled: false })).body.autoSync.revision).toBe(start + 2);
    // No consent was withdrawn: the revision moved, the generation did not (E1b §5.2).
    expect(w.generation()).toBe(generation);
    expect((await w.post(path, { expectedVersion: 1, expectedAutoSyncRevision: start + 2, enabled: true })).body)
      .toEqual({ error: 'recent-auth-required' });
    await w.reverify();
    const stale = await w.post(path, { expectedVersion: 1, expectedAutoSyncRevision: start, enabled: true });
    expect([stale.status, stale.body]).toEqual([409, { error: 'version-conflict', currentVersion: 1 }]);
    // Every source's namespaces stay unadmitted until E4–E7: the switch answers gate-closed (Q7).
    const closed = await w.post(path, { expectedVersion: 1, expectedAutoSyncRevision: start + 2, enabled: true });
    expect([closed.status, closed.body]).toEqual([409, { error: 'gate-closed' }]);
    expect(gate.changes).toEqual(['narrowing', 'narrowing', 'widening', 'widening']);
  });
});

describe('pairing and devices (§3.4)', () => {
  it('answers 409 device-api-disabled to pairing and approval until the device API and the HTTPS origin exist', async () => {
    for (const options of [{ deviceApi: 'disabled' as const }, { holdrOrigin: null }]) {
      await create(options);
      w.enable('chase');
      const binding = w.binding();
      await w.reverify();
      const res = await w.post(owner('/pairings'), { bindingIds: [binding.bindingId], replacesDeviceId: null });
      expect([res.status, res.body]).toEqual([409, { error: 'device-api-disabled' }]);
      const approve = await w.post(owner(`/pairings/pai_${'a'.repeat(32)}/approve`), { deviceId: `dev_${'a'.repeat(32)}`, fingerprint: 'a'.repeat(16) });
      expect(approve.body).toEqual({ error: 'device-api-disabled' });
      w.close();
    }
  });

  it('creates an invitation whose code only its 201 carries, approves the redeemed browser by its grouped fingerprint, one open invite at a time', async () => {
    await create();
    w.enable('chase');
    const binding = w.binding();
    await w.reverify();
    const first = await w.post(owner('/pairings'), { bindingIds: [binding.bindingId], replacesDeviceId: null });
    expect(first.status).toBe(201);
    expect(first.headers['cache-control']).toMatch(/no-store/);
    expect(first.body.holdrOrigin).toBe(ORIGIN);
    expect(first.body.pairingCode).toMatch(/^[a-p]{32}$/);
    expect(first.body.pairing).toMatchObject({ status: 'open', bindingIds: [binding.bindingId], replacesDeviceId: null, deviceId: null,
      failedAttempts: 0, pendingExpiresAt: null });
    const code: string = first.body.pairingCode;
    // Only its digest is stored, and nothing logs it.
    const dump = JSON.stringify(w.db.prepare('SELECT * FROM card_sync_pairings').all());
    expect(dump).not.toContain(code);
    expect(dump).toContain(pairingCodeDigest(code));
    expect(w.logs.join('\n')).not.toContain(code);

    const second = await w.post(owner('/pairings'), { bindingIds: [binding.bindingId], replacesDeviceId: null });
    expect(w.repo.getCardSyncPairing(first.body.pairing.pairingId)!.status).toBe('cancelled');
    const browser = redeem(second.body.pairingCode);
    const grouped = browser.fingerprint.match(/.{4}/g)!.join('-');
    const approved = await w.post(owner(`/pairings/${second.body.pairing.pairingId}/approve`), { deviceId: browser.deviceId, fingerprint: grouped });
    expect(approved.status).toBe(200);
    expect(approved.body.pairing).toMatchObject({ status: 'approved', deviceId: browser.deviceId, fingerprint: browser.fingerprint });
    expect(approved.body.device).toMatchObject({ deviceId: browser.deviceId, status: 'active', approvedAt: w.now(), pendingExpiresAt: null,
      bindingIds: [binding.bindingId], staleBindingIds: [], revokedAt: null, revokeReason: null });
    const wrong = await w.post(owner(`/pairings/${second.body.pairing.pairingId}/approve`), { deviceId: browser.deviceId, fingerprint: 'a'.repeat(16) });
    expect([wrong.status, wrong.body]).toEqual([409, { error: 'pairing-closed' }]);
  });

  it('cancel and reject close the invitation; a revoked pending browser\'s approval answers pairing-closed (item 26)', async () => {
    await create();
    w.enable('chase');
    const binding = w.binding();
    await w.reverify();
    const create1 = await w.post(owner('/pairings'), { bindingIds: [binding.bindingId], replacesDeviceId: null });
    const cancelled = await w.post(owner(`/pairings/${create1.body.pairing.pairingId}/cancel`), {});
    expect([cancelled.status, cancelled.body.status]).toEqual([200, 'cancelled']);
    expect((await w.post(owner(`/pairings/${create1.body.pairing.pairingId}/cancel`), {})).body.status).toBe('cancelled');

    const create2 = await w.post(owner('/pairings'), { bindingIds: [binding.bindingId], replacesDeviceId: null });
    const browser2 = redeem(create2.body.pairingCode);
    const rejected = await w.post(owner(`/pairings/${create2.body.pairing.pairingId}/reject`), { deviceId: browser2.deviceId });
    expect([rejected.status, rejected.body.pairing.status, rejected.body.device.status, rejected.body.device.revokeReason])
      .toEqual([200, 'rejected', 'revoked', 'rejected']);

    const create3 = await w.post(owner('/pairings'), { bindingIds: [binding.bindingId], replacesDeviceId: null });
    const browser3 = redeem(create3.body.pairingCode);
    const revoked = await w.post(owner(`/devices/${browser3.deviceId}/revoke`), {});
    expect([revoked.status, revoked.body.status, revoked.body.revokeReason, revoked.body.revokedAt]).toEqual([200, 'revoked', 'owner', w.now()]);
    const late = await w.post(owner(`/pairings/${create3.body.pairing.pairingId}/approve`), { deviceId: browser3.deviceId, fingerprint: browser3.fingerprint });
    expect([late.status, late.body]).toEqual([409, { error: 'pairing-closed' }]);
    expect(w.repo.getCardSyncPairing(create3.body.pairing.pairingId)!.status).toBe('cancelled');
  });

  it('rotation (item 15): approving an invitation that replaces a browser revokes it as rotated and holds its sets', async () => {
    await create();
    w.enable('chase');
    const binding = w.binding();
    const old = w.device([binding.bindingId]);
    const setId = w.accept(old, binding, [{ scope: binding.scopes[0].cardScopeId, date: '2026-10-01', amount: 1250, description: 'FOURTH COFFEE',
      merchant: 'Fourth Coffee', id: 'sor-1' }]).receipt.observationSetId;
    await w.reverify();
    const invite = await w.post(owner('/pairings'), { bindingIds: [binding.bindingId], replacesDeviceId: old.deviceId });
    expect(invite.body.pairing.replacesDeviceId).toBe(old.deviceId);
    const browser = redeem(invite.body.pairingCode);
    const approved = await w.post(owner(`/pairings/${invite.body.pairing.pairingId}/approve`), { deviceId: browser.deviceId, fingerprint: browser.fingerprint });
    expect(approved.status).toBe(200);
    expect(w.repo.getCardSyncOwnerDevice(old.deviceId)).toMatchObject({ status: 'revoked', revokeReason: 'rotated', revokedAt: w.now() });
    expect(w.db.prepare('SELECT state FROM card_sync_observation_sets WHERE id = ?').pluck().get(setId)).toBe('blocked-review');
    // Revoking a browser that is already revoked changes nothing (idempotent, no advance).
    const generation = w.generation();
    const repeat = await w.post(owner(`/devices/${old.deviceId}/revoke`), {});
    expect([repeat.status, repeat.body.revokeReason, w.generation()]).toEqual([200, 'rotated', generation]);
  });

  it('refuses the service token on every E2b route (403 credential-not-allowed), and malformed ids as not found', async () => {
    await create();
    for (const path of ['/pause', '/resume', '/bindings', '/pairings', `/devices/dev_${'a'.repeat(32)}/revoke`]) {
      const res = await w.asService('post', owner(path), {});
      expect([path, res.status]).toEqual([path, 403]);
    }
    expect((await w.asService('get', owner('/state'))).status).toBe(403);
    for (const path of ['/devices/dev_123/revoke', '/pairings/pai_x/cancel', '/bindings/bnd_/retire']) {
      expect((await w.post(owner(path), {})).status).toBe(404);
    }
  });
});

describe('the owner state (§3.1)', () => {
  it('answers that this Holdr has no extension sync (no HTTPS ingress) as a plain state, not a 404, and still only to the owner', async () => {
    await create({ holdrOrigin: null });
    const res = await w.get(owner('/state'));
    expect([res.status, res.body]).toEqual([200, { extensionSync: 'not-configured' }]);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect((await w.asService('get', owner('/state'))).status).toBe(403);
    expect((await w.get(owner('/state?full=1'))).status).toBe(422);
  });

  it('answers the whole state from one read: settings, bindings, browsers and invitations by the clock, queue and quotas', async () => {
    await create({ deviceApi: 'disabled' });
    w.enable('chase');
    const binding = w.binding();
    const device = w.device([binding.bindingId]);
    w.ingest(device, binding, [{ scope: binding.scopes[0].cardScopeId, date: '2026-10-01', amount: 1250, description: 'FOURTH COFFEE',
      merchant: 'Fourth Coffee', id: 'sor-1' }]);
    const res = await w.get(owner('/state'));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['generatedAt', 'holdrOrigin', 'deviceApi', 'gate', 'recoveredAt', 'contractVersions', 'limits',
      'settings', 'bindings', 'devices', 'pairings', 'inventory', 'queue', 'quota']);
    expect(res.body).toMatchObject({
      generatedAt: w.now(), holdrOrigin: ORIGIN, deviceApi: 'disabled', gate: 'open', recoveredAt: null, contractVersions: [1],
      limits: { pairingMinutes: 5, pendingDeviceMinutes: 10, deviceDays: 30, planMinutes: 10, retentionDays: 30, maxRetentionDays: 90, receiptDays: 7 },
    });
    expect(res.body.bindings).toHaveLength(1);
    expect(res.body.bindings[0].deviceIds).toEqual([device.deviceId]);
    expect(res.body.bindings[0].sync.lastRun).toMatchObject({ deviceId: device.deviceId, runState: 'accepted' });
    expect(res.body.devices.map((d: { deviceId: string; status: string }) => [d.deviceId, d.status])).toEqual([[device.deviceId, 'active']]);
    expect(res.body.quota.global.sets.limit).toBeGreaterThan(0);
    gate.blocked = true;
    expect((await w.get(owner('/state'))).body.gate).toBe('blocked');
    // 30 days later the browser is expired by the clock, before retention records it.
    w.tick(30 * 86_400);
    w.cookie = await w.signIn();
    const later = (await w.get(owner('/state'))).body;
    expect(later.devices[0]).toMatchObject({ status: 'expired', revokedAt: null, revokeReason: null });
    expect(later.bindings[0].deviceIds).toEqual([]);
  });

  it('lists at most 50 invitations: the open one, then the most recently closed', async () => {
    await create();
    w.enable('chase');
    const binding = w.binding();
    let last = '';
    for (let i = 0; i < 55; i += 1) {
      w.tick(1);
      last = w.repo.createCardSyncPairing({
        actorRef: w.owner, codeDigest: pairingCodeDigest(randomCardSyncLetters()), bindingIds: [binding.bindingId], replacesDeviceId: null,
        expectedGeneration: w.generation(), nextGeneration: newGeneration(),
      }).value.pairingId;
    }
    const pairings = (await w.get(owner('/state'))).body.pairings as Array<{ pairingId: string; status: string }>;
    expect(pairings).toHaveLength(50);
    expect(pairings.filter((pairing) => pairing.status === 'open').map((pairing) => pairing.pairingId)).toEqual([last]);
  });
});

describe('value-free errors', () => {
  it('maps repository refusals with §5.11 and keeps values out of answers and logs', async () => {
    await create();
    await w.reverify();
    const res = await w.post(owner('/bindings'), {
      issuer: 'chase', source: 'chase-api', cardAccountRef: `card-acct-${'c'.repeat(32)}`, bindingLabel: 'Alex Sapphire',
      scopes: [{ scopeLabel: 'Alex card', holderAlias: 'alex', last4: '1111' }],
    });
    expect(res.body).toEqual({ error: 'not-found' });
    expect(JSON.stringify(res.body) + w.logs.join('\n')).not.toMatch(/Sapphire|1111/);
    expect(cardSyncRefusalCode(new Error('card-sync:not-found'))).toBeUndefined();
  });
});
