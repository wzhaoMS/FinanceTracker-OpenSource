import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formatCardSyncPairingCode } from '@finance-tracker/shared';
import { CardSyncFixtures, type CardSyncGraph } from '../../testing/cardSyncFixtures.js';
import { makeScratchDir, removeScratchDir } from '../../testing/scratchDir.js';
import {
  cardSyncActorRef, deviceFingerprint, deviceTokenDigest, newCardSyncId, pairingCodeDigest, randomCardSyncLetters,
} from '../cardSyncDigests.js';
import { SqliteStateRepo, type CardSourceBindingView } from '../sqliteStateRepo.js';
import { cardSyncRefusalCode } from './refusals.js';

// E1b design §5.3 (pairings and devices) and §5.3.1's device paths, with
// tests D1–D5, D9, D15, D17–D20, D22, D24 and D29–D35 of §7.

const T0 = '2026-10-17T10:00:00.000Z';
const DAY_S = 86_400;
const OWNER = cardSyncActorRef('local-user-owner');
const OTHER = cardSyncActorRef('local-user-other');
const TABLES = [
  'card_source_bindings', 'card_sync_policy', 'card_sync_pairings', 'card_sync_pairing_scopes', 'card_sync_devices',
  'card_sync_device_scopes', 'card_sync_runs', 'card_sync_observation_sets', 'card_sync_commit_plans', 'card_sync_audit_events',
];

let repo: SqliteStateRepo;
let clock: number;
let fx: CardSyncFixtures;

const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();
const now = () => new Date(clock).toISOString();
const tick = (seconds: number) => { clock += seconds * 1000; };

function open(file = ':memory:'): SqliteStateRepo {
  return new SqliteStateRepo({ file, now: () => new Date(clock) });
}

beforeEach(() => {
  clock = Date.parse(T0);
  repo = open();
  fx = new CardSyncFixtures(repo.internalGetDb(), Date.parse(T0));
});

afterEach(() => {
  repo.close();
});

const db = () => repo.internalGetDb();
const step = (r = repo) => ({ expectedGeneration: r.getCardSyncAuthorizationGeneration(), nextGeneration: newCardSyncId('agn_') });
const stale = () => ({ expectedGeneration: newCardSyncId('agn_'), nextGeneration: newCardSyncId('agn_') });
const dump = () => Object.fromEntries(TABLES.map((table) => [table, db().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
const generation = () => repo.getCardSyncAuthorizationGeneration();

function attempt(write: () => unknown): unknown {
  try {
    write();
  } catch (caught) {
    return caught;
  }
  throw new Error('expected a refusal');
}

/** Refused with exactly this card-sync code, and nothing written. */
function refused(code: string, write: () => unknown): void {
  const before = dump();
  const error = attempt(write);
  expect(cardSyncRefusalCode(error), String(error)).toBe(code);
  expect(dump()).toEqual(before);
}

const row = (table: string, id: string) => db().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown>;
const auditTypes = (n: number) => (db().prepare('SELECT event_type, code FROM card_sync_audit_events ORDER BY rowid DESC LIMIT ?')
  .all(n) as Array<{ event_type: string; code: string | null }>).reverse().map((a) => (a.code ? `${a.event_type}:${a.code}` : a.event_type));
const advances = () => (db().prepare("SELECT count(*) AS n FROM card_sync_audit_events WHERE event_type = 'generation-advanced'")
  .get() as { n: number }).n;

function enable(issuer: 'chase' | 'amex', r = repo): void {
  r.enableCardSyncIssuer({ issuer, expectedVersion: r.getCardSyncSettings().settingsVersion, contractVersion: 1, riskAcknowledged: true,
    mainWorldAcknowledged: issuer === 'amex', actorRef: OWNER, ...step(r) });
}

function binding(r = repo): CardSourceBindingView {
  const cardAccountId = r.createCardAccount({ issuer: 'chase', owner: 'joint', last4: '3391', currency: 'USD' }).id;
  return r.createCardSourceBinding({ cardAccountId, source: 'chase-api', label: 'Chase activity', actorRef: OWNER, ...step(r),
    scopes: [{ label: 'Alex card', holderAlias: 'alex', last4: '1111' }] }).value;
}

// E2's part, as the design describes it: a code and a token from a CSPRNG, only their digests passed on.
const newCode = () => randomCardSyncLetters();
const newToken = () => `hdv1_${randomCardSyncLetters()}${randomCardSyncLetters()}`;

function pair(bindingIds: string[], { replacesDeviceId = null as string | null, actorRef = OWNER, r = repo } = {}) {
  const code = newCode();
  const result = r.createCardSyncPairing({ actorRef, codeDigest: pairingCodeDigest(code), bindingIds, replacesDeviceId, ...step(r) });
  return { code, pairingId: result.value.pairingId, result };
}

function redeem(code: string, { token = newToken(), deviceId = newCardSyncId('dev_'), label = 'Laptop Chrome', r = repo } = {}) {
  const result = r.redeemCardSyncPairing({ codeDigest: pairingCodeDigest(code), deviceId, tokenDigest: deviceTokenDigest(token),
    fingerprint: deviceFingerprint(token), label, clientVersion: '1.2.3', ...step(r) });
  return { result, token, deviceId };
}

const approve = (pairingId: string, deviceId: string, fingerprint: string, r = repo) =>
  r.approveCardSyncPairing({ pairingId, deviceId, fingerprint, actorRef: OWNER, ...step(r) });

/** A browser through the whole invitation: created, redeemed, approved. */
function pairedDevice(bindingIds: string[], replacesDeviceId: string | null = null) {
  const { code, pairingId } = pair(bindingIds, { replacesDeviceId });
  const { token, deviceId } = redeem(code);
  approve(pairingId, deviceId, deviceFingerprint(token));
  return { pairingId, deviceId, token };
}

/** A browser that redeemed and waits for approval. */
function pendingDevice(bindingIds: string[]) {
  const { code, pairingId } = pair(bindingIds);
  const { token, deviceId } = redeem(code);
  return { pairingId, deviceId, token };
}

const graphOf = (view: CardSourceBindingView): CardSyncGraph => ({
  usr: OWNER, accountId: view.cardAccountRef, knownScopeId: view.scopes[0].cardScopeId, bindingId: view.bindingId,
  generation: generation(),
});
const autoSyncRevision = (bindingId: string) => repo.getCardSourceBinding(bindingId)!.autoSync.revision;
const revoke = (deviceId: string, reason: 'owner' | 'password-reset' = 'owner') =>
  repo.revokeCardSyncDevice({ deviceId, reason, actor: { kind: 'session', actorRef: OWNER }, ...step() });
/** Retention's natural expiry of an active device (§5.9 phase 2, §5.3.1): expired, its grants revoked; its sets left alone. */
function expireNaturally(deviceId: string): void {
  db().prepare(`UPDATE card_sync_devices SET status = 'expired', token_digest = NULL, closed_at = ?, close_reason = 'expired'
    WHERE id = ?`).run(now(), deviceId);
  db().prepare(`UPDATE card_sync_device_scopes SET status = 'revoked', revoked_at = ?, auto_sync = 0, consent_contract_version = NULL,
      consent_guard_revision = NULL, consent_issuer_revision = NULL, consent_binding_version = NULL, consent_by_ref = NULL,
      consent_at = NULL WHERE device_id = ? AND status = 'active'`).run(now(), deviceId);
}
/** An open run, an unresolved set, and consent on the device's grant. */
function sourceRisk(view: CardSourceBindingView, deviceId: string) {
  const g = graphOf(view);
  const run = fx.acceptedRun(g, deviceId, { acceptance_state: 'open', payload_digest: null, accepted_at: null, closed_at: null });
  const set = fx.extensionSet(g, deviceId);
  db().prepare(`UPDATE card_sync_device_scopes SET auto_sync = 1, consent_contract_version = 1, consent_guard_revision = 4,
      consent_issuer_revision = 2, consent_binding_version = binding_version, consent_by_ref = ?, consent_at = ?
    WHERE device_id = ? AND status = 'active'`).run(OWNER, now(), deviceId);
  return { run, set };
}
/**
 * The owner's prepared plan on a set. Every authorization change cancels a
 * prepared extension plan (`generation-changed`), so a test makes it just
 * before the change whose own cancellation (`device-revoked`) it checks.
 */
const planOn = (view: CardSourceBindingView, setId: string) => fx.preparedPlan(graphOf(view), setId);

describe('pairing a browser (§5.3; D1, D9, D15, D22)', () => {
  it('creates, redeems and approves with digests only; the views carry no digest', async () => {
    const dir = await makeScratchDir('card-sync-pairing-');
    const file = path.join(dir, 'holdr.db');
    const fileRepo = open(file);
    try {
      enable('chase', fileRepo);
      const view = binding(fileRepo);
      const before = fileRepo.getCardSyncAuthorizationGeneration();
      const { code, pairingId, result } = pair([view.bindingId], { r: fileRepo });
      expect(result).toMatchObject({ changed: true, authorizationGeneration: expect.not.stringMatching(before) });
      expect(result.value).toEqual({
        pairingId, status: 'open', createdAt: T0, expiresAt: at(300), bindingIds: [view.bindingId], replacesDeviceId: null,
        deviceId: null, deviceLabel: null, fingerprint: null, pendingExpiresAt: null, failedAttempts: 0, redeemedAt: null,
        closedAt: null,
      });
      tick(30);
      const { result: redeemed, token, deviceId } = redeem(code, { r: fileRepo });
      expect(redeemed).toEqual({ ok: true, deviceId, status: 'pending', pendingExpiresAt: at(630),
        authorizationGeneration: fileRepo.getCardSyncAuthorizationGeneration() });
      expect(fileRepo.getCardSyncPairing(pairingId)).toMatchObject({ status: 'redeemed', deviceId, deviceLabel: 'Laptop Chrome',
        fingerprint: deviceFingerprint(token), pendingExpiresAt: at(630), redeemedAt: at(30) });
      expect(fileRepo.findCardSyncDeviceByTokenDigest(deviceTokenDigest(token))).toEqual({ deviceId, ownerRef: OWNER,
        status: 'pending', expiresAt: at(630), grants: [] });
      tick(30);
      const revision = fileRepo.getCardSourceBinding(view.bindingId)!.autoSync.revision;
      const approved = approve(pairingId, deviceId, deviceFingerprint(token), fileRepo);
      expect(approved.changed).toBe(true);
      expect(approved.value.pairing).toMatchObject({ status: 'approved', closedAt: at(60) });
      expect(approved.value.device).toEqual({
        deviceId, label: 'Laptop Chrome', clientVersion: '1.2.3', fingerprint: deviceFingerprint(token), pairingId, status: 'active',
        revokeReason: null, createdAt: at(30), pendingExpiresAt: at(630), activatedAt: at(60), expiresAt: at(60 + 30 * DAY_S),
        closedAt: null, lastUsedAt: null, grants: [{ bindingId: view.bindingId, bindingVersion: 1, autoSync: false, consentedAt: null }],
        staleBindingIds: [],
      });
      // A grant moves the binding's auto-sync revision, so an "on" read before the approval no longer applies (D22).
      expect(fileRepo.getCardSourceBinding(view.bindingId)!).toMatchObject({ bindingVersion: 1,
        autoSync: { revision: revision + 1 }, deviceIds: [deviceId] });
      expect(fileRepo.findCardSyncDeviceByTokenDigest(deviceTokenDigest(token))).toEqual({ deviceId, ownerRef: OWNER,
        status: 'active', expiresAt: at(60 + 30 * DAY_S),
        grants: [{ bindingId: view.bindingId, bindingVersion: 1, mode: 'isolated-read', contractVersion: 1, autoSync: false }] });
      const trail = (fileRepo.internalGetDb().prepare(`SELECT event_type, actor_kind, actor_ref FROM card_sync_audit_events
        WHERE event_type LIKE 'pairing-%' ORDER BY rowid`).all());
      expect(trail).toEqual([
        { event_type: 'pairing-created', actor_kind: 'session', actor_ref: OWNER },
        { event_type: 'pairing-redeemed', actor_kind: 'device', actor_ref: deviceId },
        { event_type: 'pairing-approved', actor_kind: 'session', actor_ref: OWNER },
      ]);
      const views = JSON.stringify([fileRepo.listCardSyncPairings(), fileRepo.listCardSyncDevices(), approved]);
      expect(views).not.toMatch(/hph1:|hdh1:/);

      // D1: neither the code (in either spelling) nor the token is anywhere in the database or its WAL.
      const secrets = [code, formatCardSyncPairingCode(code)!, token, token.slice('hdv1_'.length)];
      const scan = () => {
        for (const name of fs.readdirSync(dir)) {
          const bytes = fs.readFileSync(path.join(dir, name));
          for (const secret of secrets) expect(bytes.includes(secret), `${name} holds a secret`).toBe(false);
        }
      };
      expect(fs.existsSync(`${file}-wal`)).toBe(true);
      scan();
      fileRepo.close();
      scan();
    } finally {
      fileRepo.close();
      await removeScratchDir(dir);
    }
  });

  it('cancels the owner open invitation when a new one is made, and cancels open and redeemed ones (D9)', () => {
    enable('chase');
    const view = binding();
    const first = pair([view.bindingId]);
    const others = pair([view.bindingId], { actorRef: OTHER });
    const second = pair([view.bindingId]);
    expect(repo.getCardSyncPairing(first.pairingId)).toMatchObject({ status: 'cancelled', closedAt: T0 });
    expect(repo.getCardSyncPairing(others.pairingId)).toMatchObject({ status: 'open' });
    expect(auditTypes(3)).toEqual(['pairing-cancelled:replaced', 'pairing-created', 'generation-advanced:pairing-created']);
    expect(redeem(first.code).result).toMatchObject({ ok: false, code: 'pairing-invalid' });

    const cancelled = repo.cancelCardSyncPairing({ pairingId: second.pairingId, actorRef: OWNER, ...step() });
    expect(cancelled).toMatchObject({ changed: true, value: { status: 'cancelled', closedAt: T0 } });
    const before = dump();
    expect(repo.cancelCardSyncPairing({ pairingId: second.pairingId, actorRef: OWNER, ...step() }))
      .toMatchObject({ changed: false, authorizationGeneration: cancelled.authorizationGeneration });
    expect(dump()).toEqual(before);

    const waiting = pendingDevice([view.bindingId]);
    repo.cancelCardSyncPairing({ pairingId: waiting.pairingId, actorRef: OWNER, ...step() });
    expect(repo.getCardSyncDevice(waiting.deviceId)).toMatchObject({ status: 'revoked', revokeReason: 'rejected', closedAt: T0,
      activatedAt: null, expiresAt: null });
    expect(repo.findCardSyncDeviceByTokenDigest(deviceTokenDigest(waiting.token))).toBeNull();
    refused('pairing-closed', () => approve(waiting.pairingId, waiting.deviceId, deviceFingerprint(waiting.token)));

    // Listed: open and redeemed, and closed within the last 24 hours.
    expect(repo.listCardSyncPairings().map((p) => p.status)).toEqual(['cancelled', 'open', 'cancelled', 'cancelled']);
    tick(DAY_S + 1);
    expect(repo.listCardSyncPairings().map((p) => p.pairingId)).toEqual([others.pairingId]);
    refused('not-found', () => repo.cancelCardSyncPairing({ pairingId: newCardSyncId('pai_'), actorRef: OWNER, ...step() }));
    refused('generation-mismatch', () => repo.cancelCardSyncPairing({ pairingId: others.pairingId, actorRef: OWNER, ...stale() }));
    refused('principal-not-allowed', () => repo.cancelCardSyncPairing({ pairingId: others.pairingId, actorRef: 'usr_x', ...step() }));
  });

  it('refuses a bad invitation before writing anything', () => {
    const view = binding();
    const good = { actorRef: OWNER, codeDigest: pairingCodeDigest(newCode()), bindingIds: [view.bindingId], replacesDeviceId: null };
    refused('contract-unsupported', () => repo.createCardSyncPairing({ ...good, ...step() }));
    enable('chase');
    repo.disableCardSyncIssuer({ issuer: 'chase', actorRef: OWNER, ...step() });
    refused('contract-unsupported', () => repo.createCardSyncPairing({ ...good, ...step() }));
    enable('chase');
    refused('principal-not-allowed', () => repo.createCardSyncPairing({ ...good, actorRef: newCardSyncId('dev_'), ...step() }));
    refused('credential-format-invalid', () => repo.createCardSyncPairing({ ...good, codeDigest: newCode(), ...step() }));
    for (const bindingIds of [[], [view.bindingId, view.bindingId], ['bnd_1'], Array.from({ length: 21 }, () => newCardSyncId('bnd_'))]) {
      refused('invalid-request', () => repo.createCardSyncPairing({ ...good, bindingIds, ...step() }));
    }
    refused('invalid-request', () => repo.createCardSyncPairing({ ...good, replacesDeviceId: 'dev_1', ...step() }));
    refused('not-found', () => repo.createCardSyncPairing({ ...good, bindingIds: [newCardSyncId('bnd_')], ...step() }));
    refused('not-found', () => repo.createCardSyncPairing({ ...good, replacesDeviceId: newCardSyncId('dev_'), ...step() }));
    refused('generation-mismatch', () => repo.createCardSyncPairing({ ...good, ...stale() }));
    db().prepare(`UPDATE card_source_bindings SET status = 'needs-reconfirmation', status_reason = 'restored-from-backup',
      version = 2 WHERE id = ?`).run(view.bindingId);
    refused('binding-needs-reconfirmation', () => repo.createCardSyncPairing({ ...good, ...step() }));
    const retired = binding();
    repo.retireCardSourceBinding({ bindingId: retired.bindingId, expectedVersion: 1, actorRef: OWNER, ...step() });
    refused('binding-retired', () => repo.createCardSyncPairing({ ...good, bindingIds: [retired.bindingId], ...step() }));
    // Only a pending or active device can be replaced.
    const live = binding();
    const gone = pairedDevice([live.bindingId]);
    revoke(gone.deviceId);
    refused('not-found', () => repo.createCardSyncPairing({ ...good, bindingIds: [live.bindingId], replacesDeviceId: gone.deviceId,
      ...step() }));
  });
});

describe('redeeming a code (§5.3; D2, D19, Q45)', () => {
  it('locks every open pairing on the fifth failure, which alone advances the generation', () => {
    enable('chase');
    const view = binding();
    const mine = pair([view.bindingId]);
    const theirs = pair([view.bindingId], { actorRef: OTHER });
    const start = generation();
    for (let n = 1; n <= 4; n += 1) {
      expect(redeem(newCode()).result).toEqual({ ok: false, code: 'pairing-invalid', authorizationGeneration: start });
    }
    expect(generation()).toBe(start);
    for (const { pairingId } of [mine, theirs]) {
      expect(repo.getCardSyncPairing(pairingId)).toMatchObject({ status: 'open', failedAttempts: 4 });
    }
    const fifth = redeem(newCode()).result;
    expect(fifth).toMatchObject({ ok: false, code: 'pairing-locked' });
    expect(fifth.authorizationGeneration).not.toBe(start);
    for (const { pairingId } of [mine, theirs]) {
      expect(repo.getCardSyncPairing(pairingId)).toMatchObject({ status: 'locked', failedAttempts: 5, closedAt: T0 });
      expect(row('card_sync_pairings', pairingId).code_digest).toBeNull();
    }
    expect(auditTypes(4)).toEqual(['pairing-failed', 'pairing-locked', 'pairing-locked', 'generation-advanced:pairing-locked']);
    // The right code of a locked pairing is just another invalid one; with nothing open, nothing is charged.
    expect(redeem(mine.code).result).toEqual({ ok: false, code: 'pairing-invalid', authorizationGeneration: fifth.authorizationGeneration });
    expect(db().prepare("SELECT item_count FROM card_sync_audit_events WHERE event_type = 'pairing-failed' ORDER BY rowid DESC")
      .pluck().get()).toBe(0);
  });

  it('redeems once, refuses an expired code, and checks formats and the generation before anything', () => {
    enable('chase');
    const view = binding();
    const once = pair([view.bindingId]);
    const first = redeem(once.code);
    expect(first.result.ok).toBe(true);
    expect(redeem(once.code).result).toMatchObject({ ok: false, code: 'pairing-invalid' });
    expect(repo.getCardSyncDevice(first.deviceId)).toMatchObject({ status: 'pending' });

    const late = pair([view.bindingId]);
    tick(300);
    const before = generation();
    expect(redeem(late.code).result).toEqual({ ok: false, code: 'pairing-invalid', authorizationGeneration: before });
    expect(repo.getCardSyncPairing(late.pairingId)).toMatchObject({ status: 'open', failedAttempts: 1 });

    const fresh = pair([view.bindingId]);
    const input = { codeDigest: pairingCodeDigest(fresh.code), deviceId: newCardSyncId('dev_'), tokenDigest: deviceTokenDigest(newToken()),
      fingerprint: 'abcdabcdabcdabcd', label: 'Laptop', clientVersion: '1.2.3' };
    refused('generation-mismatch', () => repo.redeemCardSyncPairing({ ...input, ...stale() }));
    for (const bad of [{ codeDigest: fresh.code }, { deviceId: 'dev_1' }, { tokenDigest: newToken() }, { fingerprint: 'ABCDABCDABCDABCD' }]) {
      refused('credential-format-invalid', () => repo.redeemCardSyncPairing({ ...input, ...bad, ...step() }));
    }
    for (const bad of [{ label: '1 Laptop' }, { label: 'L'.repeat(41) }, { label: 'Laptop!' }, { clientVersion: '1.2' }, { clientVersion: 'v1.2.3' }]) {
      refused('invalid-request', () => repo.redeemCardSyncPairing({ ...input, ...bad, ...step() }));
    }
    expect(repo.redeemCardSyncPairing({ ...input, ...step() })).toMatchObject({ ok: true });
  });

  it('lets one of two connections redeem a code; the other sees it spent (concurrent redeem, D2)', async () => {
    const dir = await makeScratchDir('card-sync-redeem-');
    const file = path.join(dir, 'holdr.db');
    const a = open(file);
    const b = open(file);
    try {
      enable('chase', a);
      const view = binding(a);
      const { code, pairingId } = pair([view.bindingId], { r: a });
      const winner = redeem(code, { r: a });
      const loser = redeem(code, { r: b });
      expect(winner.result.ok).toBe(true);
      expect(loser.result).toMatchObject({ ok: false, code: 'pairing-invalid' });
      expect(b.getCardSyncPairing(pairingId)).toMatchObject({ status: 'redeemed', deviceId: winner.deviceId, failedAttempts: 0 });
      expect(b.getCardSyncDevice(loser.deviceId)).toBeNull();
    } finally {
      a.close();
      b.close();
      await removeScratchDir(dir);
    }
  });
});

describe('approving and rejecting (§5.3; D9, D5)', () => {
  it('refuses until redeemed, a wrong fingerprint or device, an expired wait and a stale binding; a repeat changes nothing', () => {
    enable('chase');
    const view = binding();
    const { code, pairingId } = pair([view.bindingId]);
    const fingerprintOf = (token: string) => deviceFingerprint(token);
    refused('pairing-not-redeemed', () => approve(pairingId, newCardSyncId('dev_'), 'abcdabcdabcdabcd'));
    const { token, deviceId } = redeem(code);
    refused('fingerprint-mismatch', () => approve(pairingId, deviceId, 'abcdabcdabcdabcd'));
    refused('fingerprint-mismatch', () => approve(pairingId, newCardSyncId('dev_'), fingerprintOf(token)));
    refused('invalid-request', () => approve(pairingId, deviceId, fingerprintOf(token).toUpperCase()));
    refused('invalid-request', () => approve('pai_1', deviceId, fingerprintOf(token)));
    refused('not-found', () => approve(newCardSyncId('pai_'), deviceId, fingerprintOf(token)));
    refused('generation-mismatch', () => repo.approveCardSyncPairing({ pairingId, deviceId, fingerprint: fingerprintOf(token),
      actorRef: OWNER, ...stale() }));
    tick(600);
    refused('pairing-expired', () => approve(pairingId, deviceId, fingerprintOf(token)));

    // A binding confirmed again after the invitation froze it.
    const second = pair([view.bindingId]);
    const waiting = redeem(second.code);
    repo.confirmCardSourceBinding({ bindingId: view.bindingId, expectedVersion: 1, label: view.bindingLabel, regrantDeviceIds: [],
      actorRef: OWNER, ...step(), scopes: [{ cardScopeId: view.scopes[0].cardScopeId, label: 'Alex card', holderAlias: 'alex', last4: '1111' }] });
    refused('binding-stale', () => approve(second.pairingId, waiting.deviceId, fingerprintOf(waiting.token)));

    const third = pair([view.bindingId]);
    const ok = redeem(third.code);
    const approved = approve(third.pairingId, ok.deviceId, fingerprintOf(ok.token));
    expect(approved.value.device.grants).toEqual([{ bindingId: view.bindingId, bindingVersion: 2, autoSync: false, consentedAt: null }]);
    const before = dump();
    expect(approve(third.pairingId, ok.deviceId, fingerprintOf(ok.token))).toMatchObject({ changed: false,
      authorizationGeneration: approved.authorizationGeneration });
    expect(dump()).toEqual(before);
    refused('pairing-closed', () => approve(third.pairingId, ok.deviceId, 'abcdabcdabcdabcd'));
    refused('pairing-closed', () => repo.rejectCardSyncPairing({ pairingId: third.pairingId, deviceId: ok.deviceId, actorRef: OWNER,
      ...step() }));
  });

  it('rejects: the device revoked (rejected), the pairing rejected; idempotent; the token never resolves again', () => {
    enable('chase');
    const view = binding();
    const { pairingId, deviceId, token } = pendingDevice([view.bindingId]);
    refused('fingerprint-mismatch', () => repo.rejectCardSyncPairing({ pairingId, deviceId: newCardSyncId('dev_'), actorRef: OWNER,
      ...step() }));
    refused('generation-mismatch', () => repo.rejectCardSyncPairing({ pairingId, deviceId, actorRef: OWNER, ...stale() }));
    refused('invalid-request', () => repo.rejectCardSyncPairing({ pairingId, deviceId: 'dev_1', actorRef: OWNER, ...step() }));
    refused('principal-not-allowed', () => repo.rejectCardSyncPairing({ pairingId, deviceId, actorRef: deviceId, ...step() }));
    const rejected = repo.rejectCardSyncPairing({ pairingId, deviceId, actorRef: OWNER, ...step() });
    expect(rejected).toMatchObject({ changed: true, value: { pairing: { status: 'rejected', closedAt: T0 },
      device: { status: 'revoked', revokeReason: 'rejected', closedAt: T0, activatedAt: null } } });
    expect(row('card_sync_devices', deviceId).token_digest).toBeNull();
    expect(repo.findCardSyncDeviceByTokenDigest(deviceTokenDigest(token))).toBeNull();
    const before = dump();
    expect(repo.rejectCardSyncPairing({ pairingId, deviceId, actorRef: OWNER, ...step() })).toMatchObject({ changed: false });
    expect(dump()).toEqual(before);
    refused('pairing-closed', () => approve(pairingId, deviceId, deviceFingerprint(token)));
    const open = pair([view.bindingId]);
    refused('pairing-not-redeemed', () => repo.rejectCardSyncPairing({ pairingId: open.pairingId, deviceId, actorRef: OWNER, ...step() }));
  });
});

describe('revoking a device (§5.3, §5.3.1; D4, D17, D18, D29, D30, D34, D35, K18)', () => {
  it('takes every authority: token, grants with consent, open runs, unresolved sets and every plan on them', () => {
    enable('chase');
    const view = binding();
    const { deviceId, token } = pairedDevice([view.bindingId]);
    const risk = sourceRisk(view, deviceId);
    const revision = autoSyncRevision(view.bindingId);
    repo.pauseCardSync({ actorRef: OWNER, ...step() });           // narrowing changes work while paused (D17)
    const plan = planOn(view, risk.set);
    const next = step();
    const revoked = repo.revokeCardSyncDevice({ deviceId, reason: 'owner', actor: { kind: 'session', actorRef: OWNER }, ...next });
    expect(revoked).toMatchObject({ changed: true, authorizationGeneration: next.nextGeneration,
      value: { status: 'revoked', revokeReason: 'owner', closedAt: T0, grants: [], staleBindingIds: [] } });
    expect(row('card_sync_devices', deviceId)).toMatchObject({ token_digest: null, close_reason: 'owner', expires_at: at(30 * DAY_S) });
    expect(db().prepare(`SELECT status, revoked_at, auto_sync, consent_at, consent_by_ref FROM card_sync_device_scopes
      WHERE device_id = ?`).all(deviceId)).toEqual([{ status: 'revoked', revoked_at: T0, auto_sync: 0, consent_at: null,
      consent_by_ref: null }]);
    expect(autoSyncRevision(view.bindingId)).toBe(revision + 1);
    expect(row('card_sync_runs', risk.run)).toMatchObject({ acceptance_state: 'expired', closed_at: T0 });
    expect(row('card_sync_observation_sets', risk.set)).toMatchObject({ state: 'blocked-review', version: 2, receipt_state: 'kept' });
    expect(row('card_sync_commit_plans', plan)).toMatchObject({ status: 'cancelled', cancel_reason: 'device-revoked' });
    expect(auditTypes(5)).toEqual(['run-expired:device-revoked', 'set-blocked:device-revoked', 'plan-cancelled:device-revoked',
      'device-revoked:owner', 'generation-advanced:device-revoked']);
    expect(repo.findCardSyncDeviceByTokenDigest(deviceTokenDigest(token))).toBeNull();
    // An already revoked device is an idempotent repeat, still behind the generation check; the database refuses reactivation.
    refused('generation-mismatch', () => repo.revokeCardSyncDevice({ deviceId, reason: 'owner', actor: { kind: 'session', actorRef: OWNER },
      ...stale() }));
    const before = dump();
    expect(revoke(deviceId)).toMatchObject({ changed: false, authorizationGeneration: next.nextGeneration });
    expect(dump()).toEqual(before);
    expect(() => db().prepare("UPDATE card_sync_devices SET status = 'active' WHERE id = ?").run(deviceId))
      .toThrow(/a closed device never changes/);
  });

  it('takes only owner or password-reset, and a system actor only for a password reset', () => {
    enable('chase');
    const view = binding();
    const { deviceId } = pairedDevice([view.bindingId]);
    for (const reason of ['rotated', 'rejected', 'recovery', 'expired', 'pending-expired', undefined]) {
      refused('invalid-request', () => repo.revokeCardSyncDevice({ deviceId, reason: reason as 'owner',
        actor: { kind: 'session', actorRef: OWNER }, ...step() }));
    }
    refused('principal-not-allowed', () => repo.revokeCardSyncDevice({ deviceId, reason: 'owner', actor: { kind: 'system' }, ...step() }));
    refused('principal-not-allowed', () => repo.revokeCardSyncDevice({ deviceId, reason: 'owner',
      actor: { kind: 'device', deviceId } as unknown as { kind: 'system' }, ...step() }));
    refused('not-found', () => revoke(newCardSyncId('dev_')));
    const reset = repo.revokeCardSyncDevice({ deviceId, reason: 'password-reset', actor: { kind: 'system' }, ...step() });
    expect(reset.value).toMatchObject({ status: 'revoked', revokeReason: 'password-reset' });
    expect(db().prepare("SELECT actor_kind, actor_ref FROM card_sync_audit_events WHERE event_type = 'device-revoked'").get())
      .toEqual({ actor_kind: 'system', actor_ref: null });
  });

  it('revokes every device of a reset user, expired ones keeping their times; their sets quarantined (D29, D30)', () => {
    enable('chase');
    const view = binding();
    const active = pairedDevice([view.bindingId]);
    const lapsed = pairedDevice([view.bindingId]);
    const waiting = pendingDevice([view.bindingId]);
    const done = pairedDevice([view.bindingId]);
    revoke(done.deviceId);
    const risk = sourceRisk(view, lapsed.deviceId);
    tick(60);
    db().prepare('UPDATE card_sync_devices SET last_used_at = ? WHERE id = ?').run(now(), lapsed.deviceId);
    tick(60);
    expireNaturally(lapsed.deviceId);
    const lapsedRow = row('card_sync_devices', lapsed.deviceId);
    tick(60);
    const devices = repo.listCardSyncDevices({ ownerRef: OWNER });
    expect(devices.map((d) => d.status)).toEqual(['active', 'expired', 'pending', 'revoked']);
    expect(repo.listCardSyncDevices({ ownerRef: OTHER })).toEqual([]);
    refused('invalid-request', () => repo.listCardSyncDevices({ ownerRef: 'usr_1' }));
    const advanced = advances();
    const plan = planOn(view, risk.set);
    const order = [lapsed.deviceId, ...devices.filter((d) => d.status !== 'revoked' && d.deviceId !== lapsed.deviceId).map((d) => d.deviceId)];
    for (const deviceId of order) {
      repo.revokeCardSyncDevice({ deviceId, reason: 'password-reset', actor: { kind: 'system' }, ...step() });
    }
    expect(advances()).toBe(advanced + 3);
    expect(repo.listCardSyncDevices({ ownerRef: OWNER }).map((d) => [d.status, d.revokeReason]))
      .toEqual([['revoked', 'password-reset'], ['revoked', 'password-reset'], ['revoked', 'password-reset'], ['revoked', 'owner']]);
    // The expired device keeps its expiry time and last use; its unresolved set is quarantined and its plan cancelled anyway.
    expect(row('card_sync_devices', lapsed.deviceId)).toMatchObject({ closed_at: lapsedRow.closed_at, last_used_at: lapsedRow.last_used_at,
      expires_at: lapsedRow.expires_at, close_reason: 'password-reset' });
    expect(row('card_sync_observation_sets', risk.set)).toMatchObject({ state: 'blocked-review', receipt_state: 'kept' });
    expect(row('card_sync_commit_plans', plan)).toMatchObject({ status: 'cancelled', cancel_reason: 'device-revoked' });
    // A pending browser's invitation closes with it (D35): a later approval answers pairing-closed and writes nothing.
    expect(repo.getCardSyncPairing(waiting.pairingId)).toMatchObject({ status: 'cancelled' });
    refused('pairing-closed', () => approve(waiting.pairingId, waiting.deviceId, deviceFingerprint(waiting.token)));
    // An active device's approved pairing keeps its history (close-pairing-of-device touches only `redeemed`).
    expect(repo.getCardSyncPairing(active.pairingId)).toMatchObject({ status: 'approved' });
  });
});

describe('rotation (§5.3; D5, D31, D32, D35, K18)', () => {
  it('stores the device to replace; cancelling leaves it active; approval rotates it out in the same transaction', () => {
    enable('chase');
    const view = binding();
    const old = pairedDevice([view.bindingId]);
    const risk = sourceRisk(view, old.deviceId);
    const cancelled = pair([view.bindingId], { replacesDeviceId: old.deviceId });
    expect(cancelled.result.value.replacesDeviceId).toBe(old.deviceId);
    repo.cancelCardSyncPairing({ pairingId: cancelled.pairingId, actorRef: OWNER, ...step() });
    expect(repo.getCardSyncDevice(old.deviceId)).toMatchObject({ status: 'active' });

    tick(120);
    const invitation = pair([view.bindingId], { replacesDeviceId: old.deviceId });
    const browser = redeem(invitation.code);
    const plan = planOn(view, risk.set);
    const advanced = advances();
    approve(invitation.pairingId, browser.deviceId, deviceFingerprint(browser.token));
    expect(advances()).toBe(advanced + 1);       // the rotation inside the approval advances nothing more
    const fresh = { deviceId: browser.deviceId };
    expect(repo.getCardSyncDevice(fresh.deviceId)).toMatchObject({ status: 'active', grants: [{ bindingId: view.bindingId }] });
    expect(repo.getCardSyncDevice(old.deviceId)).toMatchObject({ status: 'revoked', revokeReason: 'rotated', closedAt: at(120), grants: [] });
    expect(repo.findCardSyncDeviceByTokenDigest(deviceTokenDigest(old.token))).toBeNull();
    expect(row('card_sync_observation_sets', risk.set)).toMatchObject({ state: 'blocked-review', receipt_state: 'kept' });
    expect(row('card_sync_commit_plans', plan)).toMatchObject({ status: 'cancelled', cancel_reason: 'device-revoked' });
    expect(repo.getCardSyncPairing(old.pairingId)).toMatchObject({ status: 'approved' });
  });

  it('rotates a target that expired first keeping its times, leaves a revoked one as it is, and closes a pending one (D31, D32, D35)', () => {
    enable('chase');
    const view = binding();
    const lapsed = pairedDevice([view.bindingId]);
    const invitation = pair([view.bindingId], { replacesDeviceId: lapsed.deviceId });
    const risk = sourceRisk(view, lapsed.deviceId);
    tick(60);
    expireNaturally(lapsed.deviceId);
    const expiredRow = row('card_sync_devices', lapsed.deviceId);
    tick(60);
    const browser = redeem(invitation.code);
    const plan = planOn(view, risk.set);
    approve(invitation.pairingId, browser.deviceId, deviceFingerprint(browser.token));
    expect(row('card_sync_devices', lapsed.deviceId)).toMatchObject({ status: 'revoked', close_reason: 'rotated',
      closed_at: expiredRow.closed_at, last_used_at: expiredRow.last_used_at, expires_at: expiredRow.expires_at });
    expect(row('card_sync_observation_sets', risk.set)).toMatchObject({ state: 'blocked-review' });
    expect(row('card_sync_commit_plans', plan)).toMatchObject({ cancel_reason: 'device-revoked' });

    const gone = pairedDevice([view.bindingId]);
    const later = pair([view.bindingId], { replacesDeviceId: gone.deviceId });
    revoke(gone.deviceId);
    const goneRow = row('card_sync_devices', gone.deviceId);
    const second = redeem(later.code);
    expect(approve(later.pairingId, second.deviceId, deviceFingerprint(second.token)).changed).toBe(true);
    expect(row('card_sync_devices', gone.deviceId)).toEqual(goneRow);

    const waiting = pendingDevice([view.bindingId]);
    const replacing = pair([view.bindingId], { replacesDeviceId: waiting.deviceId, actorRef: OTHER });
    const third = redeem(replacing.code);
    approve(replacing.pairingId, third.deviceId, deviceFingerprint(third.token));
    expect(repo.getCardSyncDevice(waiting.deviceId)).toMatchObject({ status: 'revoked', revokeReason: 'rotated' });
    expect(repo.getCardSyncPairing(waiting.pairingId)).toMatchObject({ status: 'cancelled' });
  });

  it('lets the database accept rotated only from the approval that names the device (K18)', () => {
    enable('chase');
    const view = binding();
    const target = pairedDevice([view.bindingId]);
    const invitation = pair([view.bindingId], { replacesDeviceId: target.deviceId });
    redeem(invitation.code);
    expect(() => db().prepare(`UPDATE card_sync_devices SET status = 'revoked', close_reason = 'rotated', closed_at = ?,
      token_digest = NULL WHERE id = ?`).run(now(), target.deviceId)).toThrow(/rotated only by the approval that replaces it/);
  });
});

describe('re-granting (§5.3; D10, D22, D24)', () => {
  it('renews stale grants at the binding version without consent; a current grant is left alone', () => {
    enable('chase');
    const view = binding();
    const { deviceId, token } = pairedDevice([view.bindingId]);
    const confirmed = repo.confirmCardSourceBinding({ bindingId: view.bindingId, expectedVersion: 1, label: view.bindingLabel,
      regrantDeviceIds: [], actorRef: OWNER, ...step(),
      scopes: [{ cardScopeId: view.scopes[0].cardScopeId, label: 'Alex card', holderAlias: 'alex', last4: '1111' }] }).value;
    expect(repo.getCardSyncDevice(deviceId)).toMatchObject({ staleBindingIds: [view.bindingId],
      grants: [{ bindingId: view.bindingId, bindingVersion: 1 }] });
    expect(repo.findCardSyncDeviceByTokenDigest(deviceTokenDigest(token))!.grants).toMatchObject([{ bindingVersion: 1 }]);
    const readRevision = confirmed.autoSync.revision;

    const regranted = repo.regrantCardSyncDevice({ deviceId, bindingIds: [view.bindingId], actorRef: OWNER, ...step() });
    expect(regranted).toMatchObject({ changed: true, value: { staleBindingIds: [],
      grants: [{ bindingId: view.bindingId, bindingVersion: 2, autoSync: false, consentedAt: null }] } });
    expect(autoSyncRevision(view.bindingId)).toBe(readRevision + 1);
    expect(auditTypes(2)).toEqual(['device-regranted', 'generation-advanced:device-regranted']);
    // An "on" read before the re-grant never applies (D22).
    refused('version-conflict', () => repo.setCardSyncAutoSync({ bindingId: view.bindingId, enabled: true, expectedVersion: 2,
      expectedAutoSyncRevision: readRevision, actorRef: OWNER, ...step() }));
    const before = dump();
    expect(repo.regrantCardSyncDevice({ deviceId, bindingIds: [view.bindingId], actorRef: OWNER, ...step() }))
      .toMatchObject({ changed: false, authorizationGeneration: regranted.authorizationGeneration });
    expect(dump()).toEqual(before);
  });

  it('refuses a device that is not active, a binding it holds no grant of, and bindings that are not confirmed', () => {
    enable('chase');
    const view = binding();
    const other = binding();
    const { deviceId } = pairedDevice([view.bindingId]);
    const waiting = pendingDevice([view.bindingId]);
    const good = { deviceId, bindingIds: [view.bindingId], actorRef: OWNER };
    refused('invalid-request', () => repo.regrantCardSyncDevice({ ...good, bindingIds: [], ...step() }));
    refused('invalid-request', () => repo.regrantCardSyncDevice({ ...good, bindingIds: [view.bindingId, view.bindingId], ...step() }));
    refused('not-found', () => repo.regrantCardSyncDevice({ ...good, deviceId: newCardSyncId('dev_'), ...step() }));
    refused('not-found', () => repo.regrantCardSyncDevice({ ...good, deviceId: waiting.deviceId, ...step() }));
    refused('not-found', () => repo.regrantCardSyncDevice({ ...good, bindingIds: [other.bindingId], ...step() }));
    refused('not-found', () => repo.regrantCardSyncDevice({ ...good, bindingIds: [newCardSyncId('bnd_')], ...step() }));
    refused('generation-mismatch', () => repo.regrantCardSyncDevice({ ...good, ...stale() }));
    db().prepare(`UPDATE card_source_bindings SET status = 'needs-reconfirmation', status_reason = 'contract-changed', version = 2
      WHERE id = ?`).run(view.bindingId);
    refused('binding-needs-reconfirmation', () => repo.regrantCardSyncDevice({ ...good, ...step() }));
    repo.retireCardSourceBinding({ bindingId: view.bindingId, expectedVersion: 2, actorRef: OWNER, ...step() });
    refused('binding-retired', () => repo.regrantCardSyncDevice({ ...good, ...step() }));
    tick(30 * DAY_S);
    refused('not-found', () => repo.regrantCardSyncDevice({ ...good, ...step() }));
  });
});

describe('device lifetimes and use (§5.3; D3)', () => {
  it('resolves a pending device for 600 s and an active one for 30 days, non-sliding; touch writes at most once a minute', () => {
    enable('chase');
    const view = binding();
    const { code, pairingId } = pair([view.bindingId]);
    const { token, deviceId } = redeem(code);
    const digest = deviceTokenDigest(token);
    expect(repo.touchCardSyncDevice(deviceId)).toBe(true);
    expect(repo.touchCardSyncDevice(deviceId)).toBe(false);
    tick(599);
    expect(repo.findCardSyncDeviceByTokenDigest(digest)).toMatchObject({ status: 'pending' });
    tick(1);
    expect(repo.findCardSyncDeviceByTokenDigest(digest)).toBeNull();
    expect(repo.touchCardSyncDevice(deviceId)).toBe(false);

    const second = pair([view.bindingId]);
    const live = redeem(second.code);
    approve(second.pairingId, live.deviceId, deviceFingerprint(live.token));
    const expiresAt = row('card_sync_devices', live.deviceId).expires_at;
    expect(expiresAt).toBe(new Date(clock + 30 * DAY_S * 1000).toISOString());
    expect(repo.touchCardSyncDevice(live.deviceId)).toBe(true);
    tick(59);
    expect(repo.touchCardSyncDevice(live.deviceId)).toBe(false);
    tick(1);
    expect(repo.touchCardSyncDevice(live.deviceId)).toBe(true);
    expect(row('card_sync_devices', live.deviceId)).toMatchObject({ last_used_at: now(), expires_at: expiresAt });
    tick(30 * DAY_S - 61);
    expect(repo.findCardSyncDeviceByTokenDigest(deviceTokenDigest(live.token))).toMatchObject({ status: 'active' });
    tick(1);
    expect(repo.findCardSyncDeviceByTokenDigest(deviceTokenDigest(live.token))).toBeNull();
    expect(repo.touchCardSyncDevice(live.deviceId)).toBe(false);
    expect(attempt(() => repo.findCardSyncDeviceByTokenDigest(token))).toSatisfy((e: unknown) => cardSyncRefusalCode(e) === 'credential-format-invalid');
    expect(attempt(() => repo.touchCardSyncDevice('dev_1'))).toSatisfy((e: unknown) => cardSyncRefusalCode(e) === 'invalid-request');
    expect(repo.findCardSyncDeviceByTokenDigest(deviceTokenDigest(newToken()))).toBeNull();
    expect(repo.getCardSyncPairing(pairingId)).toMatchObject({ status: 'redeemed' });
    expect(repo.getCardSyncDevice('dev_1')).toBeNull();
    expect(repo.getCardSyncPairing('pai_1')).toBeNull();
  });
});
