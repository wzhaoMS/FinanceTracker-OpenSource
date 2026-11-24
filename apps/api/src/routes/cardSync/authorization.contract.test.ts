import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newGeneration } from '../../control/syncAuthState.js';
import { deviceFingerprint, deviceTokenDigest, pairingCodeDigest, randomCardSyncLetters } from '../../services/cardSyncDigests.js';
import { CardSyncOwnerWorld, OWNER_ORIGIN, OWNER_PASSWORD } from '../../testing/cardSyncOwnerWorld.js';
import type { CardSyncAuthorizationService } from '../../control/authorizationChange.js';

/**
 * E2b's contract with the Spending tab (the E8-M owner API §3.1–§3.4; E1b §10 item 10): the web client itself
 * (apps/web/.../sync/ownerClient.ts, which parses every answer with its exact-key strict schemas) drives the real API, so
 * `State`, `Settings`, `Binding`, `Device`, `Pairing` and the pairing answer are exactly the shapes it accepts. The client
 * is loaded at run time, as in E2a's contract test, so the API's typecheck never compiles the web workspace.
 */

const WEB_SYNC = fileURLToPath(new URL('../../../../web/src/components/spending/sync/', import.meta.url));
const ORIGIN = 'https://holdr.example.ts.net';

type OwnerClient = Record<string, (...args: never[]) => Promise<Record<string, unknown>>>;
interface ClientModule {
  createOwnerClient(transport: { request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> }, mode?: string): OwnerClient;
  isOwnerApiError(error: unknown, code?: string): boolean;
}

let web: ClientModule;
let w: CardSyncOwnerWorld;
let client: OwnerClient;

/** An always-open gate over the database's generation (the fence itself is tested elsewhere). */
const openGate = (generation: () => string): CardSyncAuthorizationService => ({
  wired: true,
  generationForSourceChecks: () => generation(),
  status: () => 'open',
  change: async (_kind, call) => call({ expectedGeneration: generation(), nextGeneration: newGeneration() }),
  reconcile: async () => false,
});

beforeEach(async () => {
  web = await import(/* @vite-ignore */ path.join(WEB_SYNC, 'ownerClient.ts')) as ClientModule;
  w = await CardSyncOwnerWorld.create({
    authorization: (world) => ({ gate: openGate(() => world.generation()), holdrOrigin: ORIGIN, deviceApi: 'enabled' }),
  });
  client = web.createOwnerClient({
    async request(method, target, body) {
      const http = await w.http();
      const res = method === 'GET'
        ? await http.get(target).set('Cookie', w.cookie)
        : await http.post(target).set('Cookie', w.cookie).set('Origin', OWNER_ORIGIN).set('X-Holdr-Request', '1').send(body as object);
      if (!String(res.headers['content-type'] ?? '').startsWith('application/json')) return { kind: 'other', status: res.status };
      return { kind: 'json', status: res.status, body: JSON.parse(res.text) };
    },
  }, 'live');
});

afterEach(() => w.close());

const call = <T = Record<string, unknown>>(name: string, ...args: unknown[]) => (client[name] as (...a: unknown[]) => Promise<T>)(...args);
async function refusal(name: string, ...args: unknown[]): Promise<unknown> {
  try {
    await call(name, ...args);
  } catch (error) {
    return error;
  }
  throw new Error(`${name} was not refused`);
}

/** The browser side of an invitation (E2c's redeem), straight through the repository. */
function redeem(code: string) {
  const token = `hdv1_${randomCardSyncLetters()}${randomCardSyncLetters()}`;
  const deviceId = `dev_${randomCardSyncLetters()}`;
  const result = w.repo.redeemCardSyncPairing({
    codeDigest: pairingCodeDigest(code), deviceId, tokenDigest: deviceTokenDigest(token), fingerprint: deviceFingerprint(token),
    label: 'Mac Chrome', clientVersion: '1.0.0', expectedGeneration: w.generation(), nextGeneration: newGeneration(),
  });
  if (!result.ok) throw new Error('redeem failed');
  return { deviceId, fingerprint: deviceFingerprint(token) };
}

describe('the web owner client against E2b\'s routes', () => {
  it('walks settings, a binding, an invitation, approval, rotation, re-grant and revocation, with every answer parsed strictly', async () => {
    await call('confirmPassword', OWNER_PASSWORD);
    let settings = await call<{ settingsVersion: number }>('pause');
    settings = await call('resume', settings.settingsVersion);
    settings = await call('enableIssuer', 'chase', { expectedVersion: settings.settingsVersion, mainWorldAcknowledged: false });
    settings = await call('enableIssuer', 'amex', { expectedVersion: settings.settingsVersion, mainWorldAcknowledged: true });
    settings = await call('disableIssuer', 'amex');

    const cardAccountRef = w.account('chase');
    const binding = await call<{ bindingId: string; bindingVersion: number; scopes: Array<{ cardScopeId: string; kind: string }> }>(
      'createBinding', { issuer: 'chase', source: 'chase-api', cardAccountRef, bindingLabel: 'Chase Sapphire',
        scopes: [{ scopeLabel: 'Alex card', holderAlias: 'alex', last4: '1111' }, { scopeLabel: 'Joint card', holderAlias: 'joint', last4: null }] });

    const created = await call<{ pairing: { pairingId: string }; pairingCode: string; holdrOrigin: string }>(
      'createPairing', { bindingIds: [binding.bindingId], replacesDeviceId: null });
    expect(created.holdrOrigin).toBe(ORIGIN);
    const cancelled = await call<{ status: string }>('cancelPairing', created.pairing.pairingId);
    expect(cancelled.status).toBe('cancelled');

    const invite = await call<{ pairing: { pairingId: string }; pairingCode: string }>('createPairing', { bindingIds: [binding.bindingId], replacesDeviceId: null });
    const first = redeem(invite.pairingCode);
    const state = await call<{ pairings: Array<{ status: string; fingerprint: string | null }> }>('getState');
    expect(state.pairings.find((pairing) => pairing.status === 'redeemed')?.fingerprint).toBe(first.fingerprint);
    const approved = await call<{ device: { status: string } }>('approvePairing', invite.pairing.pairingId,
      { deviceId: first.deviceId, fingerprint: first.fingerprint.match(/.{4}/g)!.join('-') });
    expect(approved.device.status).toBe('active');

    // A replacement for the first browser (rotation) and a rejected one.
    const replace = await call<{ pairing: { pairingId: string }; pairingCode: string }>('createPairing', {
      bindingIds: [binding.bindingId], replacesDeviceId: first.deviceId });
    const second = redeem(replace.pairingCode);
    await call('approvePairing', replace.pairing.pairingId, { deviceId: second.deviceId, fingerprint: second.fingerprint });
    const rejectInvite = await call<{ pairing: { pairingId: string }; pairingCode: string }>('createPairing', { bindingIds: [binding.bindingId], replacesDeviceId: null });
    const third = redeem(rejectInvite.pairingCode);
    const rejected = await call<{ device: { revokeReason: string } }>('rejectPairing', rejectInvite.pairing.pairingId, third.deviceId);
    expect(rejected.device.revokeReason).toBe('rejected');

    // Re-confirmation leaves the second browser stale; re-grant renews it. Auto-sync off moves the revision.
    const known = binding.scopes.filter((scope) => scope.kind === 'known');
    const confirmed = await call<{ bindingVersion: number; autoSync: { revision: number } }>('confirmBinding', binding.bindingId, {
      expectedVersion: binding.bindingVersion, bindingLabel: 'Chase Sapphire',
      scopes: [{ cardScopeId: known[0].cardScopeId, scopeLabel: 'Alex card', holderAlias: 'alex', last4: '1111' },
        { cardScopeId: null, scopeLabel: 'Casey card', holderAlias: 'casey', last4: '2222' }],
      regrantDeviceIds: [] });
    const regranted = await call<{ staleBindingIds: string[] }>('regrantDevice', second.deviceId, [binding.bindingId]);
    expect(regranted.staleBindingIds).toEqual([]);
    const off = await call<{ autoSync: { revision: number } }>('setAutoSync', binding.bindingId,
      { expectedVersion: confirmed.bindingVersion, expectedAutoSyncRevision: confirmed.autoSync.revision, enabled: false });
    expect(off.autoSync.revision).toBeGreaterThan(confirmed.autoSync.revision);
    expect(web.isOwnerApiError(await refusal('setAutoSync', binding.bindingId,
      { expectedVersion: confirmed.bindingVersion, expectedAutoSyncRevision: off.autoSync.revision, enabled: true }), 'auto-sync-not-eligible')).toBe(true);

    const revoked = await call<{ status: string; revokeReason: string }>('revokeDevice', second.deviceId);
    expect([revoked.status, revoked.revokeReason]).toEqual(['revoked', 'owner']);

    // A browser that waited too long, and the whole state with every kind of browser and invitation in it.
    const lapsed = await call<{ pairingCode: string }>('createPairing', { bindingIds: [binding.bindingId], replacesDeviceId: null });
    redeem(lapsed.pairingCode);
    w.tick(11 * 60);
    w.cookie = await w.signIn();
    const whole = await call<{ devices: Array<{ status: string; revokeReason: string | null }>; pairings: Array<{ status: string }> }>('getState');
    expect(whole.devices.map((device) => [device.status, device.revokeReason])).toEqual([
      ['revoked', 'rotated'], ['revoked', 'owner'], ['revoked', 'rejected'], ['expired', null]]);
    expect(whole.pairings.map((pairing) => pairing.status).sort()).toEqual(['approved', 'approved', 'cancelled', 'expired', 'rejected']);
    const retired = await call<{ status: string }>('retireBinding', binding.bindingId, confirmed.bindingVersion);
    expect(retired.status).toBe('retired');
    expect(settings).toBeTruthy();
  });

  it('turns E2b\'s refusals into the client\'s fixed codes', async () => {
    await call('confirmPassword', OWNER_PASSWORD);
    expect(web.isOwnerApiError(await refusal('resume', 99), 'version-conflict')).toBe(true);
    const binding = w.binding();
    expect(web.isOwnerApiError(await refusal('createPairing', { bindingIds: [binding.bindingId], replacesDeviceId: null }), 'contract-unsupported'))
      .toBe(true);
    expect(web.isOwnerApiError(await refusal('revokeDevice', `dev_${'a'.repeat(32)}`), 'not-found')).toBe(true);
  });
});
