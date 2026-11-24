import type { Database as DB } from 'better-sqlite3';

import type { CardSyncMode } from '@finance-tracker/shared';
import { newCardSyncId, newCardSyncRowId } from '../cardSyncDigests.js';
import { contractOf, insertGrant } from './bindings.js';
import {
  advanceGeneration,
  audit,
  checkGeneration,
  currentGeneration,
  secondsAfter,
  sessionActorRef,
  stepAutoSyncRevision,
  type CardSyncAuditActor,
  type CardSyncContext,
  type CardSyncGenerationStep,
} from './context.js';
import type { CardSyncAuthChange } from './principals.js';
import { cardSyncRefusal } from './refusals.js';

/**
 * Pairings and devices (E1b design §5.3; owner API §3.4): the credential
 * storage primitives E2 builds on. Only digests reach the database (E2
 * generates the code and the `hdv1_` token and computes `hph1:`, `hdh1:`
 * and the fingerprint); no view carries a digest. Every function runs inside
 * the caller's IMMEDIATE transaction and refuses before writing anything,
 * except a failed redemption, which records the failure and answers
 * `{ ok: false }` (Q15).
 */

/** Fixed lifetimes (design §2.5): a pairing code, a browser waiting for approval, an approved browser (non-sliding). */
export const CARD_SYNC_PAIRING_SECONDS = 300;
export const CARD_SYNC_PENDING_DEVICE_SECONDS = 600;
export const CARD_SYNC_DEVICE_SECONDS = 30 * 86_400;
/** `touchCardSyncDevice` records a use at most this often. */
export const CARD_SYNC_TOUCH_SECONDS = 60;
/** The failures that lock every open pairing (§2.6, Q45). */
export const CARD_SYNC_PAIRING_FAILURES = 5;
/** How long a closed pairing stays in `listCardSyncPairings`. */
const CLOSED_PAIRING_LISTED_SECONDS = 86_400;
const MAX_PAIRING_BINDINGS = 20;
const MAX_REGRANT_BINDINGS = 50;

const PAIRING_ID = /^pai_[a-p]{32}$/;
const DEVICE_ID = /^dev_[a-p]{32}$/;
const BINDING_ID = /^bnd_[a-p]{32}$/;
const ACTOR_REF = /^usr_[a-p]{32}$/;
const CODE_DIGEST = /^hph1:[a-p]{64}$/;
const TOKEN_DIGEST = /^hdh1:[a-p]{64}$/;
const FINGERPRINT = /^[a-p]{16}$/;
/** `ck_dev_label`: a letter first, then letters, digits, space, `.`, `_` or `-`; at most 40 bytes. */
const DEVICE_LABEL = /^[A-Za-z][A-Za-z0-9 ._-]{0,39}$/;
/** The extension's version, as the owner API spells it (`ck_dev_client_version` allows 5–11 bytes of digits and dots). */
const CLIENT_VERSION = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/;

export type CardSyncPairingStatus = 'open' | 'redeemed' | 'approved' | 'rejected' | 'cancelled' | 'expired' | 'locked';
export type CardSyncDeviceStatus = 'pending' | 'active' | 'revoked' | 'expired';
/** `close_reason` of a revoked device: the owner API's `revokeReason` (`password-reset` its own value, X21). */
export type CardSyncRevokeReason = 'owner' | 'rejected' | 'rotated' | 'recovery' | 'password-reset';

export interface CardSyncPairingView {
  pairingId: string;
  status: CardSyncPairingStatus;
  createdAt: string;
  expiresAt: string;
  bindingIds: string[];
  replacesDeviceId: string | null;
  /** The browser that redeemed the code, once one did. */
  deviceId: string | null;
  deviceLabel: string | null;
  fingerprint: string | null;
  pendingExpiresAt: string | null;
  failedAttempts: number;
  redeemedAt: string | null;
  closedAt: string | null;
}

export interface CardSyncDeviceGrantView {
  bindingId: string;
  bindingVersion: number;
  autoSync: boolean;
  consentedAt: string | null;
}

export interface CardSyncDeviceView {
  deviceId: string;
  label: string;
  clientVersion: string;
  /** The non-secret confirmation code the owner compared at approval. */
  fingerprint: string;
  pairingId: string;
  status: CardSyncDeviceStatus;
  /** Set only for `revoked`; an expired device shows its status with no reason. */
  revokeReason: CardSyncRevokeReason | null;
  createdAt: string;
  pendingExpiresAt: string;
  activatedAt: string | null;
  expiresAt: string | null;
  closedAt: string | null;
  lastUsedAt: string | null;
  /** Active grants, at whatever binding version they were made. */
  grants: CardSyncDeviceGrantView[];
  /** Confirmed bindings whose active grant here is on an older version: what a re-grant renews (D24). */
  staleBindingIds: string[];
}

/** What E2's `HoldrDevice` resolver learns from a token digest (§5.3): never the digest itself. */
export interface CardSyncDeviceAuth {
  deviceId: string;
  ownerRef: string;
  status: 'pending' | 'active';
  /** Until when the credential resolves: the pending window, or the approved device's fixed expiry. */
  expiresAt: string;
  /** The active grants (none while pending). */
  grants: Array<{ bindingId: string; bindingVersion: number; mode: CardSyncMode; contractVersion: number; autoSync: boolean }>;
}

export type CardSyncRedeemResult = (
  | { ok: true; deviceId: string; status: 'pending'; pendingExpiresAt: string }
  | { ok: false; code: 'pairing-invalid' | 'pairing-locked' }
) & { authorizationGeneration: string };

/** Who revokes a device: the signed-in owner, or the system (the password-reset flow and the `holdr-user` CLI). */
export type CardSyncRevokeActor = { kind: 'session'; actorRef: string } | { kind: 'system' };

interface PairingRow {
  id: string;
  code_digest: string | null;
  status: CardSyncPairingStatus;
  replaces_device_id: string | null;
  created_by_ref: string;
  created_at: string;
  expires_at: string;
  failed_attempts: number;
  redeemed_at: string | null;
  closed_at: string | null;
}

interface DeviceRow {
  id: string;
  pairing_id: string;
  token_digest: string | null;
  fingerprint: string;
  label: string;
  client_version: string;
  owner_ref: string;
  status: CardSyncDeviceStatus;
  created_at: string;
  pending_expires_at: string;
  activated_at: string | null;
  expires_at: string | null;
  closed_at: string | null;
  close_reason: string | null;
  last_used_at: string | null;
}

const isId = (pattern: RegExp, value: unknown): value is string => typeof value === 'string' && pattern.test(value);

const pairingRow = (db: DB, pairingId: string) =>
  db.prepare('SELECT * FROM card_sync_pairings WHERE id = ?').get(pairingId) as PairingRow | undefined;
const deviceRow = (db: DB, deviceId: string) =>
  db.prepare('SELECT * FROM card_sync_devices WHERE id = ?').get(deviceId) as DeviceRow | undefined;
const deviceOfPairing = (db: DB, pairingId: string) =>
  db.prepare('SELECT * FROM card_sync_devices WHERE pairing_id = ?').get(pairingId) as DeviceRow | undefined;

export function pairingView(db: DB, pairing: PairingRow): CardSyncPairingView {
  const device = deviceOfPairing(db, pairing.id);
  return {
    pairingId: pairing.id,
    status: pairing.status,
    createdAt: pairing.created_at,
    expiresAt: pairing.expires_at,
    bindingIds: db.prepare('SELECT binding_id FROM card_sync_pairing_scopes WHERE pairing_id = ? ORDER BY rowid').pluck()
      .all(pairing.id) as string[],
    replacesDeviceId: pairing.replaces_device_id,
    deviceId: device?.id ?? null,
    deviceLabel: device?.label ?? null,
    fingerprint: device?.fingerprint ?? null,
    pendingExpiresAt: device?.pending_expires_at ?? null,
    failedAttempts: pairing.failed_attempts,
    redeemedAt: pairing.redeemed_at,
    closedAt: pairing.closed_at,
  };
}

export function deviceView(db: DB, device: DeviceRow): CardSyncDeviceView {
  const grants = db.prepare(`SELECT binding_id AS bindingId, binding_version AS bindingVersion, auto_sync AS autoSync,
      consent_at AS consentedAt FROM card_sync_device_scopes WHERE device_id = ? AND status = 'active' ORDER BY rowid`)
    .all(device.id) as Array<{ bindingId: string; bindingVersion: number; autoSync: number; consentedAt: string | null }>;
  return {
    deviceId: device.id,
    label: device.label,
    clientVersion: device.client_version,
    fingerprint: device.fingerprint,
    pairingId: device.pairing_id,
    status: device.status,
    revokeReason: device.status === 'revoked' ? device.close_reason as CardSyncRevokeReason : null,
    createdAt: device.created_at,
    pendingExpiresAt: device.pending_expires_at,
    activatedAt: device.activated_at,
    expiresAt: device.expires_at,
    closedAt: device.closed_at,
    lastUsedAt: device.last_used_at,
    grants: grants.map((grant) => ({ ...grant, autoSync: grant.autoSync === 1 })),
    staleBindingIds: db.prepare(`SELECT g.binding_id FROM card_sync_device_scopes g JOIN card_source_bindings b ON b.id = g.binding_id
       WHERE g.device_id = ? AND g.status = 'active' AND b.status = 'confirmed' AND g.binding_version < b.version
       ORDER BY g.rowid`).pluck().all(device.id) as string[],
  };
}

export function getCardSyncPairing(db: DB, pairingId: string): CardSyncPairingView | null {
  const pairing = isId(PAIRING_ID, pairingId) ? pairingRow(db, pairingId) : undefined;
  return pairing ? pairingView(db, pairing) : null;
}

/** Open and redeemed pairings, and those closed in the last 24 hours; oldest first. */
export function listCardSyncPairings(ctx: CardSyncContext): CardSyncPairingView[] {
  const rows = ctx.db.prepare(`SELECT * FROM card_sync_pairings WHERE closed_at IS NULL OR closed_at > ?
    ORDER BY created_at, rowid`).all(secondsAfter(ctx.now, -CLOSED_PAIRING_LISTED_SECONDS)) as PairingRow[];
  return rows.map((row) => pairingView(ctx.db, row));
}

export function getCardSyncDevice(db: DB, deviceId: string): CardSyncDeviceView | null {
  const device = isId(DEVICE_ID, deviceId) ? deviceRow(db, deviceId) : undefined;
  return device ? deviceView(db, device) : null;
}

/** Every device, oldest first; with `ownerRef`, one user's (the password-reset flow revokes each of them). */
export function listCardSyncDevices(db: DB, filter: { ownerRef?: string } = {}): CardSyncDeviceView[] {
  if (filter.ownerRef !== undefined && !isId(ACTOR_REF, filter.ownerRef)) throw cardSyncRefusal('invalid-request');
  const rows = (filter.ownerRef === undefined
    ? db.prepare('SELECT * FROM card_sync_devices ORDER BY created_at, rowid').all()
    : db.prepare('SELECT * FROM card_sync_devices WHERE owner_ref = ? ORDER BY created_at, rowid').all(filter.ownerRef)) as DeviceRow[];
  return rows.map((row) => deviceView(db, row));
}

function pairingResult(ctx: CardSyncContext, pairingId: string, changed: boolean): CardSyncAuthChange<CardSyncPairingView> {
  return { value: pairingView(ctx.db, pairingRow(ctx.db, pairingId)!), changed, authorizationGeneration: currentGeneration(ctx.db) };
}

function deviceResult(ctx: CardSyncContext, deviceId: string, changed: boolean): CardSyncAuthChange<CardSyncDeviceView> {
  return { value: deviceView(ctx.db, deviceRow(ctx.db, deviceId)!), changed, authorizationGeneration: currentGeneration(ctx.db) };
}

function bothResult(ctx: CardSyncContext, pairingId: string, deviceId: string, changed: boolean):
  CardSyncAuthChange<{ pairing: CardSyncPairingView; device: CardSyncDeviceView }> {
  return {
    value: { pairing: pairingView(ctx.db, pairingRow(ctx.db, pairingId)!), device: deviceView(ctx.db, deviceRow(ctx.db, deviceId)!) },
    changed,
    authorizationGeneration: currentGeneration(ctx.db),
  };
}

/**
 * Takes every authority a closed device still holds (§5.3.1's revocation
 * row, in its order): its grants revoked with their consent (each binding
 * that lost one moves its auto-sync revision), its open runs expired, its
 * unresolved sets `blocked-review`, every prepared plan on them cancelled
 * (`device-revoked`), and a pending device's redeemed invitation cancelled
 * (`close-pairing-of-device`: only `redeemed`, so an approved pairing's
 * history and every closed pairing stay as they are). Idempotent.
 */
function closeDeviceAuthority(ctx: CardSyncContext, deviceId: string, actor: CardSyncAuditActor): number {
  const bindings = ctx.db.prepare(`SELECT DISTINCT binding_id FROM card_sync_device_scopes WHERE device_id = ? AND status = 'active'
    ORDER BY binding_id`).pluck().all(deviceId) as string[];
  const grants = ctx.statements.run('revoke-grants-of-device', { now: ctx.now, device_id: deviceId });
  for (const bindingId of bindings) stepAutoSyncRevision(ctx, bindingId);
  const runs = ctx.db.prepare(`UPDATE card_sync_runs SET acceptance_state = 'expired', closed_at = ?
    WHERE device_id = ? AND acceptance_state = 'open'`).run(ctx.now, deviceId).changes;
  if (runs > 0) audit(ctx, 'run-expired', actor, { deviceId, code: 'device-revoked', itemCount: runs });
  const sets = ctx.statements.run('quarantine-sets-of-device', { device_id: deviceId });
  if (sets > 0) audit(ctx, 'set-blocked', actor, { deviceId, code: 'device-revoked', itemCount: sets });
  const plans = ctx.statements.run('cancel-plans-of-device', { now: ctx.now, device_id: deviceId });
  if (plans > 0) audit(ctx, 'plan-cancelled', actor, { deviceId, code: 'device-revoked', itemCount: plans });
  ctx.statements.run('close-pairing-of-device', { now: ctx.now, device_id: deviceId });
  return grants;
}

/** Closes a device as `revoked` with this reason; an expired one keeps its expiry time and last use (§2.6). */
function revokeDeviceRow(ctx: CardSyncContext, device: DeviceRow, reason: CardSyncRevokeReason): void {
  if (device.status === 'expired') {
    ctx.db.prepare("UPDATE card_sync_devices SET status = 'revoked', close_reason = ? WHERE id = ?").run(reason, device.id);
  } else {
    ctx.db.prepare(`UPDATE card_sync_devices SET status = 'revoked', close_reason = ?, closed_at = ?, token_digest = NULL
      WHERE id = ?`).run(reason, ctx.now, device.id);
  }
}

/**
 * The mode and contract a new grant of the binding records, for a new
 * pairing: the issuer's approval in force (enabled, a contract this server
 * supports; decision S2-D1) or `contract-unsupported`.
 */
function pairingContractOf(db: DB, binding: { source: string }): { mode: CardSyncMode; contractVersion: number } {
  const enabled = db.prepare(`SELECT i.enabled FROM card_sync_sources s JOIN card_sync_issuer_policy i ON i.id = s.issuer
    WHERE s.source = ?`).pluck().get(binding.source) as number | undefined;
  if (enabled !== 1) throw cardSyncRefusal('contract-unsupported');
  return contractOf(db, binding);
}

interface PairingBinding {
  id: string;
  source: string;
  status: 'confirmed' | 'needs-reconfirmation' | 'retired';
  version: number;
}

/**
 * A new invitation (widening; recent auth by E2): the owner's open one is
 * cancelled first (one open invite each); every binding `confirmed`
 * (`binding-retired`, `binding-needs-reconfirmation`); its issuer's approval
 * in force (`contract-unsupported`); `replacesDeviceId`, if named, a pending
 * or active device, stored for the approval (`not-found`). The pairing
 * scopes freeze each binding's version, its source's mode and the approved
 * contract; the code digest resolves for 300 s.
 */
export function createCardSyncPairing(ctx: CardSyncContext, input: {
  actorRef: string; codeDigest: string; bindingIds: string[]; replacesDeviceId: string | null;
} & CardSyncGenerationStep): CardSyncAuthChange<CardSyncPairingView> {
  const actorRef = sessionActorRef(input?.actorRef);
  const actor: CardSyncAuditActor = { kind: 'session', ref: actorRef };
  if (!isId(CODE_DIGEST, input.codeDigest)) throw cardSyncRefusal('credential-format-invalid');
  const { bindingIds, replacesDeviceId } = input;
  if (!Array.isArray(bindingIds) || bindingIds.length < 1 || bindingIds.length > MAX_PAIRING_BINDINGS
    || new Set(bindingIds).size !== bindingIds.length || !bindingIds.every((id) => isId(BINDING_ID, id))
    || !(replacesDeviceId === null || isId(DEVICE_ID, replacesDeviceId))) {
    throw cardSyncRefusal('invalid-request');
  }
  const bindings = bindingIds.map((id) => {
    const binding = ctx.db.prepare('SELECT id, source, status, version FROM card_source_bindings WHERE id = ?').get(id) as
      PairingBinding | undefined;
    if (!binding) throw cardSyncRefusal('not-found');
    return binding;
  });
  if (replacesDeviceId !== null) {
    const target = deviceRow(ctx.db, replacesDeviceId);
    if (!target || (target.status !== 'pending' && target.status !== 'active')) throw cardSyncRefusal('not-found');
  }
  checkGeneration(ctx.db, input);
  for (const binding of bindings) {
    if (binding.status === 'retired') throw cardSyncRefusal('binding-retired');
    if (binding.status !== 'confirmed') throw cardSyncRefusal('binding-needs-reconfirmation');
  }
  const contracts = bindings.map((binding) => pairingContractOf(ctx.db, binding));

  const open = ctx.db.prepare("SELECT id FROM card_sync_pairings WHERE created_by_ref = ? AND status = 'open'").pluck()
    .get(actorRef) as string | undefined;
  if (open !== undefined) {
    ctx.db.prepare("UPDATE card_sync_pairings SET status = 'cancelled', code_digest = NULL, closed_at = ? WHERE id = ?")
      .run(ctx.now, open);
    audit(ctx, 'pairing-cancelled', actor, { pairingId: open, code: 'replaced' });
  }
  const pairingId = newCardSyncId('pai_');
  ctx.db.prepare(`INSERT INTO card_sync_pairings (id, code_digest, status, replaces_device_id, created_by_ref, created_at, expires_at,
      failed_attempts, authorization_generation, redeemed_at, closed_at)
    VALUES (?, ?, 'open', ?, ?, ?, ?, 0, ?, NULL, NULL)`)
    .run(pairingId, input.codeDigest, replacesDeviceId, actorRef, ctx.now, secondsAfter(ctx.now, CARD_SYNC_PAIRING_SECONDS),
      input.nextGeneration);
  const insertScope = ctx.db.prepare(`INSERT INTO card_sync_pairing_scopes (id, pairing_id, binding_id, binding_version, mode,
      contract_version) VALUES (?, ?, ?, ?, ?, ?)`);
  bindings.forEach((binding, i) => insertScope.run(newCardSyncRowId('card-pscope-'), pairingId, binding.id, binding.version,
    contracts[i].mode, contracts[i].contractVersion));
  audit(ctx, 'pairing-created', actor, { pairingId, deviceId: replacesDeviceId, itemCount: bindings.length });
  advanceGeneration(ctx, input, actor, 'pairing-created');
  return pairingResult(ctx, pairingId, true);
}

/**
 * Cancels an invitation (narrowing): `open → cancelled`, or `redeemed →
 * cancelled` with its waiting browser revoked (`rejected`). A closed pairing
 * is an idempotent repeat: nothing changes and nothing advances.
 */
export function cancelCardSyncPairing(ctx: CardSyncContext, input: { pairingId: string; actorRef: string } & CardSyncGenerationStep):
  CardSyncAuthChange<CardSyncPairingView> {
  const actorRef = sessionActorRef(input?.actorRef);
  const actor: CardSyncAuditActor = { kind: 'session', ref: actorRef };
  const pairing = isId(PAIRING_ID, input.pairingId) ? pairingRow(ctx.db, input.pairingId) : undefined;
  if (!pairing) throw cardSyncRefusal('not-found');
  checkGeneration(ctx.db, input);
  if (pairing.status !== 'open' && pairing.status !== 'redeemed') return pairingResult(ctx, pairing.id, false);
  ctx.db.prepare("UPDATE card_sync_pairings SET status = 'cancelled', code_digest = NULL, closed_at = ? WHERE id = ?")
    .run(ctx.now, pairing.id);
  const device = pairing.status === 'redeemed' ? deviceOfPairing(ctx.db, pairing.id) : undefined;
  if (device && device.status === 'pending') revokeDeviceRow(ctx, device, 'rejected');
  audit(ctx, 'pairing-cancelled', actor, { pairingId: pairing.id, deviceId: device?.id ?? null });
  advanceGeneration(ctx, input, actor, 'pairing-cancelled');
  return pairingResult(ctx, pairing.id, true);
}

/**
 * A browser presents a code (widening). Never throws for a bad code (after
 * the generation check): an open, unexpired pairing with that digest becomes
 * `redeemed` (code gone) with a `pending` device for 600 s, and the
 * generation advances; anything else charges one failure to every open
 * pairing and answers `pairing-invalid`, or `pairing-locked` when this
 * failure locked one (the fifth), which alone advances the generation (Q45).
 * Malformed digests or ids are E2's bug (`credential-format-invalid`).
 */
export function redeemCardSyncPairing(ctx: CardSyncContext, input: {
  codeDigest: string; deviceId: string; tokenDigest: string; fingerprint: string; label: string; clientVersion: string;
} & CardSyncGenerationStep): CardSyncRedeemResult {
  if (!isId(CODE_DIGEST, input?.codeDigest) || !isId(DEVICE_ID, input.deviceId) || !isId(TOKEN_DIGEST, input.tokenDigest)
    || !isId(FINGERPRINT, input.fingerprint)) {
    throw cardSyncRefusal('credential-format-invalid');
  }
  if (!isId(DEVICE_LABEL, input.label) || !isId(CLIENT_VERSION, input.clientVersion)) throw cardSyncRefusal('invalid-request');
  checkGeneration(ctx.db, input);
  const pairing = ctx.db.prepare("SELECT * FROM card_sync_pairings WHERE code_digest = ? AND status = 'open'").get(input.codeDigest) as
    PairingRow | undefined;
  if (pairing && pairing.expires_at > ctx.now) {
    const device: CardSyncAuditActor = { kind: 'device', ref: input.deviceId };
    const pendingExpiresAt = secondsAfter(ctx.now, CARD_SYNC_PENDING_DEVICE_SECONDS);
    ctx.db.prepare("UPDATE card_sync_pairings SET status = 'redeemed', code_digest = NULL, redeemed_at = ? WHERE id = ?")
      .run(ctx.now, pairing.id);
    ctx.db.prepare(`INSERT INTO card_sync_devices (id, pairing_id, token_digest, fingerprint, label, client_version, owner_ref, status,
        created_at, pending_expires_at, activated_at, activated_by_ref, expires_at, closed_at, close_reason, authorization_generation,
        last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL)`)
      .run(input.deviceId, pairing.id, input.tokenDigest, input.fingerprint, input.label, input.clientVersion, pairing.created_by_ref,
        ctx.now, pendingExpiresAt, input.nextGeneration);
    audit(ctx, 'pairing-redeemed', device, { pairingId: pairing.id, deviceId: input.deviceId });
    advanceGeneration(ctx, input, device, 'pairing-redeemed');
    return { ok: true, deviceId: input.deviceId, status: 'pending', pendingExpiresAt, authorizationGeneration: currentGeneration(ctx.db) };
  }
  const system: CardSyncAuditActor = { kind: 'system' };
  const charged = ctx.db.prepare("SELECT id, failed_attempts FROM card_sync_pairings WHERE status = 'open' ORDER BY rowid").all() as
    Array<{ id: string; failed_attempts: number }>;
  ctx.db.prepare(`UPDATE card_sync_pairings SET failed_attempts = failed_attempts + 1,
      status = CASE WHEN failed_attempts + 1 >= ${CARD_SYNC_PAIRING_FAILURES} THEN 'locked' ELSE status END,
      code_digest = CASE WHEN failed_attempts + 1 >= ${CARD_SYNC_PAIRING_FAILURES} THEN NULL ELSE code_digest END,
      closed_at = CASE WHEN failed_attempts + 1 >= ${CARD_SYNC_PAIRING_FAILURES} THEN ? ELSE closed_at END
    WHERE status = 'open'`).run(ctx.now);
  audit(ctx, 'pairing-failed', system, { itemCount: charged.length });
  const locked = charged.filter((row) => row.failed_attempts + 1 >= CARD_SYNC_PAIRING_FAILURES);
  for (const row of locked) audit(ctx, 'pairing-locked', system, { pairingId: row.id });
  if (locked.length > 0) advanceGeneration(ctx, input, system, 'pairing-locked');
  return { ok: false, code: locked.length > 0 ? 'pairing-locked' : 'pairing-invalid', authorizationGeneration: currentGeneration(ctx.db) };
}

/** The checks shared by approve and reject: the pairing, its browser, and whether this is a repeat of the same decision. */
function decidedPairing(ctx: CardSyncContext, input: { pairingId: string; deviceId: string } & CardSyncGenerationStep,
  decided: 'approved' | 'rejected'): { pairing: PairingRow; device: DeviceRow; repeat: boolean } {
  const pairing = pairingRow(ctx.db, input.pairingId);
  if (!pairing) throw cardSyncRefusal('not-found');
  checkGeneration(ctx.db, input);
  const device = deviceOfPairing(ctx.db, pairing.id);
  if (pairing.status === 'open') throw cardSyncRefusal('pairing-not-redeemed');
  if (pairing.status !== 'redeemed') {
    if (pairing.status === decided && device?.id === input.deviceId) return { pairing, device, repeat: true };
    throw cardSyncRefusal('pairing-closed');
  }
  if (!device || device.id !== input.deviceId) throw cardSyncRefusal('fingerprint-mismatch');
  if (device.status !== 'pending') throw cardSyncRefusal('pairing-closed');
  return { pairing, device, repeat: false };
}

/**
 * Approves the browser that redeemed an invitation (widening; recent auth
 * by E2). Refuses `pairing-not-redeemed`, `pairing-closed`,
 * `fingerprint-mismatch` (also for another device), `pairing-expired` (the
 * pending window passed) and `binding-stale` (a frozen binding no longer
 * confirmed at its frozen version). Then, in this order: the pairing
 * `approved`; the device active for 30 days (non-sliding); the pairing
 * scopes copied into grants (each binding's auto-sync revision + 1); the
 * replaced device, if named, closed as `rotated` whatever retention did
 * first (pending or active: now; expired: keeping its times; revoked:
 * unchanged), with its authority taken in every case. The same approval
 * repeated is `changed: false`.
 */
export function approveCardSyncPairing(ctx: CardSyncContext, input: {
  pairingId: string; deviceId: string; fingerprint: string; actorRef: string;
} & CardSyncGenerationStep): CardSyncAuthChange<{ pairing: CardSyncPairingView; device: CardSyncDeviceView }> {
  const actorRef = sessionActorRef(input?.actorRef);
  const actor: CardSyncAuditActor = { kind: 'session', ref: actorRef };
  if (!isId(PAIRING_ID, input.pairingId) || !isId(DEVICE_ID, input.deviceId) || !isId(FINGERPRINT, input.fingerprint)) {
    throw cardSyncRefusal('invalid-request');
  }
  const { pairing, device, repeat } = decidedPairing(ctx, input, 'approved');
  if (device.fingerprint !== input.fingerprint) throw cardSyncRefusal(repeat ? 'pairing-closed' : 'fingerprint-mismatch');
  if (repeat) return bothResult(ctx, pairing.id, device.id, false);
  if (device.pending_expires_at <= ctx.now) throw cardSyncRefusal('pairing-expired');
  const scopes = ctx.db.prepare(`SELECT p.binding_id, p.binding_version, p.mode, p.contract_version, b.status, b.version
      FROM card_sync_pairing_scopes p JOIN card_source_bindings b ON b.id = p.binding_id
     WHERE p.pairing_id = ? ORDER BY p.rowid`).all(pairing.id) as Array<{
    binding_id: string; binding_version: number; mode: CardSyncMode; contract_version: number; status: string; version: number;
  }>;
  if (scopes.some((scope) => scope.status !== 'confirmed' || scope.version !== scope.binding_version)) {
    throw cardSyncRefusal('binding-stale');
  }

  ctx.db.prepare("UPDATE card_sync_pairings SET status = 'approved', closed_at = ? WHERE id = ?").run(ctx.now, pairing.id);
  ctx.db.prepare(`UPDATE card_sync_devices SET status = 'active', activated_at = ?, activated_by_ref = ?, expires_at = ?
    WHERE id = ?`).run(ctx.now, actorRef, secondsAfter(ctx.now, CARD_SYNC_DEVICE_SECONDS), device.id);
  for (const scope of scopes) {
    insertGrant(ctx, { deviceId: device.id, bindingId: scope.binding_id, bindingVersion: scope.binding_version, actorRef,
      contract: { mode: scope.mode, contractVersion: scope.contract_version } });
    stepAutoSyncRevision(ctx, scope.binding_id);
  }
  audit(ctx, 'pairing-approved', actor, { pairingId: pairing.id, deviceId: device.id, itemCount: scopes.length });
  if (pairing.replaces_device_id !== null) {
    const target = deviceRow(ctx.db, pairing.replaces_device_id)!;
    if (target.status !== 'revoked') revokeDeviceRow(ctx, target, 'rotated');
    const revoked = closeDeviceAuthority(ctx, target.id, actor);
    if (target.status !== 'revoked') audit(ctx, 'device-revoked', actor, { deviceId: target.id, pairingId: pairing.id, code: 'rotated', itemCount: revoked });
  }
  advanceGeneration(ctx, input, actor, 'pairing-approved');
  return bothResult(ctx, pairing.id, device.id, true);
}

/** Rejects the browser that redeemed an invitation (narrowing): device revoked (`rejected`), pairing `rejected`; idempotent. */
export function rejectCardSyncPairing(ctx: CardSyncContext, input: { pairingId: string; deviceId: string; actorRef: string }
  & CardSyncGenerationStep): CardSyncAuthChange<{ pairing: CardSyncPairingView; device: CardSyncDeviceView }> {
  const actorRef = sessionActorRef(input?.actorRef);
  const actor: CardSyncAuditActor = { kind: 'session', ref: actorRef };
  if (!isId(PAIRING_ID, input.pairingId) || !isId(DEVICE_ID, input.deviceId)) throw cardSyncRefusal('invalid-request');
  const { pairing, device, repeat } = decidedPairing(ctx, input, 'rejected');
  if (repeat) return bothResult(ctx, pairing.id, device.id, false);
  revokeDeviceRow(ctx, device, 'rejected');
  ctx.db.prepare("UPDATE card_sync_pairings SET status = 'rejected', closed_at = ? WHERE id = ?").run(ctx.now, pairing.id);
  audit(ctx, 'pairing-rejected', actor, { pairingId: pairing.id, deviceId: device.id });
  advanceGeneration(ctx, input, actor, 'pairing-rejected');
  return bothResult(ctx, pairing.id, device.id, true);
}

/**
 * Revokes a device (narrowing; works while paused or blocked) for the owner
 * or a password reset only: a pending, active or expired device becomes
 * `revoked` with that reason (an expired one keeps its times); its grants,
 * open runs, unresolved sets, their plans and a pending device's invitation
 * all go (§5.3.1); accepted receipts stay (D34). An already revoked device
 * is an idempotent repeat. A system actor (the reset flow, the CLI) may
 * revoke only for `password-reset`.
 */
export function revokeCardSyncDevice(ctx: CardSyncContext, input: {
  deviceId: string; reason: 'owner' | 'password-reset'; actor: CardSyncRevokeActor;
} & CardSyncGenerationStep): CardSyncAuthChange<CardSyncDeviceView> {
  const reason: unknown = input?.reason;
  if (reason !== 'owner' && reason !== 'password-reset') throw cardSyncRefusal('invalid-request');
  const given = input.actor as { kind?: unknown; actorRef?: unknown } | null;
  let actor: CardSyncAuditActor;
  if (given?.kind === 'session') actor = { kind: 'session', ref: sessionActorRef(given.actorRef) };
  else if (given?.kind === 'system' && reason === 'password-reset') actor = { kind: 'system' };
  else throw cardSyncRefusal('principal-not-allowed');
  const device = isId(DEVICE_ID, input.deviceId) ? deviceRow(ctx.db, input.deviceId) : undefined;
  if (!device) throw cardSyncRefusal('not-found');
  checkGeneration(ctx.db, input);
  if (device.status === 'revoked') return deviceResult(ctx, device.id, false);
  revokeDeviceRow(ctx, device, reason);
  const revoked = closeDeviceAuthority(ctx, device.id, actor);
  audit(ctx, 'device-revoked', actor, { deviceId: device.id, code: reason, itemCount: revoked });
  advanceGeneration(ctx, input, actor, 'device-revoked');
  return deviceResult(ctx, device.id, true);
}

/** Compensation for an undelivered redemption, proving both its freshly generated id and digest. Never revokes an active device. */
export function cancelPendingCardSyncRedemption(ctx: CardSyncContext, input: {
  deviceId: string; tokenDigest: string;
} & CardSyncGenerationStep): { changed: boolean; authorizationGeneration: string } {
  if (!isId(DEVICE_ID, input?.deviceId) || !isId(TOKEN_DIGEST, input.tokenDigest)) throw cardSyncRefusal('credential-format-invalid');
  checkGeneration(ctx.db, input);
  const device = deviceRow(ctx.db, input.deviceId);
  if (!device || device.status !== 'pending' || device.token_digest !== input.tokenDigest) {
    return { changed: false, authorizationGeneration: currentGeneration(ctx.db) };
  }
  const actor: CardSyncAuditActor = { kind: 'system' };
  revokeDeviceRow(ctx, device, 'rejected');
  closeDeviceAuthority(ctx, device.id, actor);
  audit(ctx, 'device-revoked', actor, { deviceId: device.id, code: 'rejected', itemCount: 0 });
  advanceGeneration(ctx, input, actor, 'device-revoked');
  return { changed: true, authorizationGeneration: currentGeneration(ctx.db) };
}

/**
 * Renews an active device's stale grants (widening; recent auth, gate open):
 * for each binding, which must be confirmed, the device's active grant on an
 * older version is revoked (consent cleared) and a fresh one inserted at the
 * binding's version and current contract, without consent; the binding's
 * auto-sync revision + 1. A grant already current is left alone; a binding
 * the device holds no active grant of is `not-found` (a re-grant renews, it
 * never widens to a new binding). Nothing stale: `changed: false`.
 */
export function regrantCardSyncDevice(ctx: CardSyncContext, input: { deviceId: string; bindingIds: string[]; actorRef: string }
  & CardSyncGenerationStep): CardSyncAuthChange<CardSyncDeviceView> {
  const actorRef = sessionActorRef(input?.actorRef);
  const actor: CardSyncAuditActor = { kind: 'session', ref: actorRef };
  const { bindingIds } = input;
  if (!isId(DEVICE_ID, input.deviceId) || !Array.isArray(bindingIds) || bindingIds.length < 1
    || bindingIds.length > MAX_REGRANT_BINDINGS || new Set(bindingIds).size !== bindingIds.length
    || !bindingIds.every((id) => isId(BINDING_ID, id))) {
    throw cardSyncRefusal('invalid-request');
  }
  const device = deviceRow(ctx.db, input.deviceId);
  if (!device) throw cardSyncRefusal('not-found');
  const bindings = bindingIds.map((id) => {
    const binding = ctx.db.prepare('SELECT id, issuer, source, status, version FROM card_source_bindings WHERE id = ?').get(id) as
      (PairingBinding & { issuer: string }) | undefined;
    if (!binding) throw cardSyncRefusal('not-found');
    return binding;
  });
  checkGeneration(ctx.db, input);
  if (device.status !== 'active' || device.expires_at === null || device.expires_at <= ctx.now) throw cardSyncRefusal('not-found');
  const activeGrant = ctx.db.prepare(`SELECT id, binding_version FROM card_sync_device_scopes
    WHERE device_id = ? AND binding_id = ? AND status = 'active'`);
  const stale = bindings.flatMap((binding) => {
    if (binding.status === 'retired') throw cardSyncRefusal('binding-retired');
    if (binding.status !== 'confirmed') throw cardSyncRefusal('binding-needs-reconfirmation');
    const grant = activeGrant.get(device.id, binding.id) as { id: string; binding_version: number } | undefined;
    if (!grant) throw cardSyncRefusal('not-found');
    return grant.binding_version === binding.version ? [] : [{ binding, grant, contract: contractOf(ctx.db, binding) }];
  });
  if (stale.length === 0) return deviceResult(ctx, device.id, false);
  for (const { binding, grant, contract } of stale) {
    ctx.statements.run('revoke-grant', { now: ctx.now, grant_id: grant.id });
    insertGrant(ctx, { deviceId: device.id, bindingId: binding.id, bindingVersion: binding.version, contract, actorRef });
    stepAutoSyncRevision(ctx, binding.id);
    audit(ctx, 'device-regranted', actor, { bindingId: binding.id, deviceId: device.id, versionBefore: grant.binding_version,
      versionAfter: binding.version });
  }
  advanceGeneration(ctx, input, actor, 'device-regranted');
  return deviceResult(ctx, device.id, true);
}

/**
 * E2's `HoldrDevice` resolver (read-only): an active device before its
 * expiry, with its active grants, or a pending one inside its window, with
 * none; anything else resolves to nothing.
 */
export function findCardSyncDeviceByTokenDigest(ctx: CardSyncContext, tokenDigest: string): CardSyncDeviceAuth | null {
  if (!isId(TOKEN_DIGEST, tokenDigest)) throw cardSyncRefusal('credential-format-invalid');
  const device = ctx.db.prepare('SELECT * FROM card_sync_devices WHERE token_digest = ?').get(tokenDigest) as DeviceRow | undefined;
  if (!device) return null;
  const base = { deviceId: device.id, ownerRef: device.owner_ref };
  if (device.status === 'pending' && device.pending_expires_at > ctx.now) {
    return { ...base, status: 'pending', expiresAt: device.pending_expires_at, grants: [] };
  }
  if (device.status !== 'active' || device.expires_at === null || device.expires_at <= ctx.now) return null;
  const grants = ctx.db.prepare(`SELECT binding_id AS bindingId, binding_version AS bindingVersion, mode, contract_version AS contractVersion,
      auto_sync AS autoSync FROM card_sync_device_scopes WHERE device_id = ? AND status = 'active' ORDER BY rowid`).all(device.id) as
    Array<{ bindingId: string; bindingVersion: number; mode: CardSyncMode; contractVersion: number; autoSync: number }>;
  return { ...base, status: 'active', expiresAt: device.expires_at, grants: grants.map((g) => ({ ...g, autoSync: g.autoSync === 1 })) };
}

/** Records a use of a live device at most once a minute (not authorization; never extends a lifetime). Whether it wrote. */
export function touchCardSyncDevice(ctx: CardSyncContext, deviceId: string): boolean {
  if (!isId(DEVICE_ID, deviceId)) throw cardSyncRefusal('invalid-request');
  return ctx.db.prepare(`UPDATE card_sync_devices SET last_used_at = ?
    WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)
      AND ((status = 'active' AND expires_at > ?) OR (status = 'pending' AND pending_expires_at > ?))`)
    .run(ctx.now, deviceId, secondsAfter(ctx.now, -CARD_SYNC_TOUCH_SECONDS), ctx.now, ctx.now).changes === 1;
}
