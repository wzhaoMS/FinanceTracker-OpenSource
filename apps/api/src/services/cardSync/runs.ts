import type { Database as DB } from 'better-sqlite3';

import { isSupportedCardSyncContractVersion } from '@finance-tracker/shared';
import { newCardSyncId } from '../cardSyncDigests.js';
import { currentSourceAuthorization, readBinding } from './authorization.js';
import { audit, secondsAfter, type CardSyncAuditActor, type CardSyncContext } from './context.js';
import type { CardSyncPrincipal } from './principals.js';
import { cardSyncRefusal } from './refusals.js';

/**
 * Runs (E1b design §5.4): what a paired browser opens before it uploads, and
 * the owner's view of each. None of these is an authorization change. Run
 * creation evaluates the current-source authorization with the device;
 * acceptance (acceptance.ts) closes a run as `accepted`.
 */

/** A run's upload window (design §2.5): the payload must arrive within 600 s of creation. */
export const CARD_SYNC_RUN_SECONDS = 600;
/** Open runs a device may hold at once (design §2.5). */
export const CARD_SYNC_OPEN_RUNS_PER_DEVICE = 2;
const DAY_SECONDS = 86_400;

export const CARD_SYNC_ABORT_REASONS = [
  'site-permission-revoked', 'not-signed-in', 'unknown-page-structure', 'certificate-error', 'user-cancelled',
] as const;
export type CardSyncAbortReason = (typeof CARD_SYNC_ABORT_REASONS)[number];

/** The eleven codes a run can be refused with: the owner API's `RunSummary.errorCode` (`ck_run_refusal_code`). */
export const CARD_SYNC_RUN_REFUSALS = [
  'payload-invalid', 'payload-digest-mismatch', 'too-large', 'card-data', 'review-quota-exceeded', 'binding-stale', 'sync-disabled',
  'source-not-authorized', 'scope-not-in-binding', 'contract-unsupported', 'capture-already-accepted',
] as const;
export type CardSyncRunRefusal = (typeof CARD_SYNC_RUN_REFUSALS)[number];

const RUN_ID = /^run_[a-p]{32}$/;
const CLIENT_RUN_ID = /^crn_[a-p]{32}$/;
const DEVICE_ID = /^dev_[a-p]{32}$/;
const BINDING_ID = /^bnd_[a-p]{32}$/;
const ACCOUNT_ID = /^card-acct-[a-p]{32}$/;
/** `ck_run_adapter_version`: an alphanumeric first, then alphanumerics and `._@+-`, at most 64 bytes. */
const ADAPTER_VERSION = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/;

export type CardSyncRunState = 'open' | 'accepted' | 'refused' | 'expired' | 'aborted';

/** The owner API's RunBrief/RunSummary (design §5.4), and what a device sees of its own run. */
export interface CardSyncRunView {
  runId: string;
  deviceId: string;
  clientRunId: string;
  bindingId: string;
  bindingVersion: number;
  cardAccountId: string;
  adapterVersion: string;
  contractVersion: number;
  trigger: 'manual' | 'auto';
  createdAt: string;
  uploadExpiresAt: string;
  /** The stored `acceptance_state` (a revoked device's open runs are `expired`, Q36). */
  runState: CardSyncRunState;
  /** `refusal_code`: one of the eleven run refusals. */
  errorCode: CardSyncRunRefusal | null;
  abortReason: CardSyncAbortReason | null;
  acceptedAt: string | null;
  payloadDigest: string | null;
  observationSetId: string | null;
  /** The set's state once the run was accepted (owner API `acceptance`), null before. */
  setState: string | null;
}

interface RunRow {
  id: string; device_id: string; client_run_id: string; binding_id: string; card_account_id: string; binding_version: number;
  adapter_version: string; contract_version: number; run_trigger: 'manual' | 'auto'; authorization_generation: string;
  created_at: string; upload_expires_at: string; acceptance_state: CardSyncRunState; payload_digest: string | null;
  refusal_code: CardSyncRunRefusal | null; accepted_at: string | null; closed_at: string | null; aborted_at: string | null;
  abort_reason: CardSyncAbortReason | null; set_id: string | null; set_state: string | null;
}

const RUN_SELECT = `SELECT r.*, s.id AS set_id, s.state AS set_state
  FROM card_sync_runs r LEFT JOIN card_sync_observation_sets s ON s.run_id = r.id`;

function runView(row: RunRow): CardSyncRunView {
  return {
    runId: row.id, deviceId: row.device_id, clientRunId: row.client_run_id, bindingId: row.binding_id,
    bindingVersion: row.binding_version, cardAccountId: row.card_account_id, adapterVersion: row.adapter_version,
    contractVersion: row.contract_version, trigger: row.run_trigger, createdAt: row.created_at, uploadExpiresAt: row.upload_expires_at,
    runState: row.acceptance_state, errorCode: row.refusal_code, abortReason: row.abort_reason, acceptedAt: row.accepted_at,
    payloadDigest: row.payload_digest, observationSetId: row.set_id, setState: row.set_state,
  };
}

export function runRow(db: DB, runId: string): RunRow | undefined {
  return RUN_ID.test(runId) ? db.prepare(`${RUN_SELECT} WHERE r.id = ?`).get(runId) as RunRow | undefined : undefined;
}

/** A device's own run; any other is `run-not-found`, so a device learns nothing of another's runs. */
export function deviceRun(db: DB, deviceId: string, runId: unknown): RunRow {
  const row = typeof runId === 'string' ? runRow(db, runId) : undefined;
  if (!row || row.device_id !== deviceId) throw cardSyncRefusal('run-not-found');
  return row;
}

const isDeviceId = (value: unknown): value is string => typeof value === 'string' && DEVICE_ID.test(value);

/**
 * Opens a run (device): idempotent on `(device, clientRunId)`, the same
 * parameters giving the same run (`replayed: true`) and others
 * `idempotency-conflict`. The current-source authorization runs first, so
 * a replay never outlives the authority that created the run. At most two
 * open runs per device and `max_runs_per_device_day` per 24 hours; the
 * upload window is 600 s.
 */
export function createCardSyncRun(ctx: CardSyncContext, input: {
  deviceId: string; clientRunId: string; bindingId: string; bindingVersion: number; adapterVersion: string; contractVersion: number;
  trigger: 'manual' | 'auto'; expectedGeneration: string;
}): { runId: string; uploadExpiresAt: string; replayed: boolean } {
  if (!isDeviceId(input?.deviceId)) throw cardSyncRefusal('principal-not-allowed');
  if (typeof input.clientRunId !== 'string' || !CLIENT_RUN_ID.test(input.clientRunId) || typeof input.bindingId !== 'string'
    || !BINDING_ID.test(input.bindingId) || !Number.isSafeInteger(input.bindingVersion) || input.bindingVersion < 1
    || typeof input.adapterVersion !== 'string' || !ADAPTER_VERSION.test(input.adapterVersion)
    || (input.trigger !== 'manual' && input.trigger !== 'auto') || typeof input.expectedGeneration !== 'string') {
    throw cardSyncRefusal('invalid-request');
  }
  if (!isSupportedCardSyncContractVersion(input.contractVersion)) throw cardSyncRefusal('contract-unsupported');
  const binding = readBinding(ctx.db, input.bindingId);
  if (!binding) throw cardSyncRefusal('not-found');
  currentSourceAuthorization(ctx.db, ctx.now, {
    binding, contractVersion: input.contractVersion, expectedGeneration: input.expectedGeneration,
    device: { id: input.deviceId, bindingVersion: input.bindingVersion },
  });
  const existing = ctx.db.prepare('SELECT * FROM card_sync_runs WHERE device_id = ? AND client_run_id = ?')
    .get(input.deviceId, input.clientRunId) as RunRow | undefined;
  if (existing) {
    if (existing.binding_id !== input.bindingId || existing.binding_version !== input.bindingVersion
      || existing.adapter_version !== input.adapterVersion || existing.contract_version !== input.contractVersion
      || existing.run_trigger !== input.trigger) {
      throw cardSyncRefusal('idempotency-conflict');
    }
    return { runId: existing.id, uploadExpiresAt: existing.upload_expires_at, replayed: true };
  }
  const open = ctx.db.prepare(`SELECT count(*) FROM card_sync_runs WHERE device_id = ? AND acceptance_state = 'open'
    AND upload_expires_at > ?`).pluck().get(input.deviceId, ctx.now) as number;
  if (open >= CARD_SYNC_OPEN_RUNS_PER_DEVICE) throw cardSyncRefusal('too-many-open-runs');
  const perDay = ctx.db.prepare("SELECT max_runs_per_device_day FROM card_sync_policy WHERE id = 'card-sync-policy'").pluck().get() as number;
  const today = ctx.db.prepare('SELECT count(*) FROM card_sync_runs WHERE device_id = ? AND created_at > ?').pluck()
    .get(input.deviceId, secondsAfter(ctx.now, -DAY_SECONDS)) as number;
  if (today >= perDay) throw cardSyncRefusal('run-rate-limited');
  const runId = newCardSyncId('run_');
  const uploadExpiresAt = secondsAfter(ctx.now, CARD_SYNC_RUN_SECONDS);
  ctx.db.prepare(`INSERT INTO card_sync_runs (id, device_id, client_run_id, binding_id, card_account_id, binding_version, adapter_version,
      contract_version, run_trigger, authorization_generation, created_at, upload_expires_at, acceptance_state, payload_digest,
      refusal_code, accepted_at, closed_at, aborted_at, abort_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, NULL, NULL, NULL, NULL)`)
    .run(runId, input.deviceId, input.clientRunId, binding.id, binding.card_account_id, input.bindingVersion, input.adapterVersion,
      input.contractVersion, input.trigger, input.expectedGeneration, ctx.now, uploadExpiresAt);
  audit(ctx, 'run-created', { kind: 'device', ref: input.deviceId }, {
    cardAccountId: binding.card_account_id, bindingId: binding.id, deviceId: input.deviceId, runId, code: input.trigger,
    versionAfter: input.bindingVersion,
  });
  return { runId, uploadExpiresAt, replayed: false };
}

/**
 * E2 refused an upload for a reason it found itself (payload-invalid,
 * too-large, card-data, …): an open run becomes `refused` with that code;
 * on any other run (accepted, already closed) nothing changes. Whether it
 * wrote.
 */
export function recordCardSyncRunRefusal(ctx: CardSyncContext, input: { deviceId: string; runId: string; code: CardSyncRunRefusal }):
  boolean {
  if (!isDeviceId(input?.deviceId)) throw cardSyncRefusal('principal-not-allowed');
  if (!(CARD_SYNC_RUN_REFUSALS as readonly string[]).includes(input.code)) throw cardSyncRefusal('invalid-request');
  const run = deviceRun(ctx.db, input.deviceId, input.runId);
  if (run.acceptance_state !== 'open') return false;
  ctx.db.prepare(`UPDATE card_sync_runs SET acceptance_state = 'refused', refusal_code = ?, closed_at = ? WHERE id = ?`)
    .run(input.code, ctx.now, run.id);
  audit(ctx, 'run-refused', { kind: 'device', ref: input.deviceId }, {
    cardAccountId: run.card_account_id, bindingId: run.binding_id, deviceId: input.deviceId, runId: run.id, code: input.code,
  });
  return true;
}

/**
 * The extension stopped a run (owner API Q4): an open run becomes `aborted`
 * with the reason; an accepted run records the reason once and cancels its
 * set's prepared plans (`aborted`), never closing or deleting the set. The
 * same reason again is an idempotent repeat; anything else on a closed run
 * is `run-closed`.
 */
export function abortCardSyncRun(ctx: CardSyncContext, input: { deviceId: string; runId: string; reason: CardSyncAbortReason }):
  CardSyncRunView {
  if (!isDeviceId(input?.deviceId)) throw cardSyncRefusal('principal-not-allowed');
  if (!(CARD_SYNC_ABORT_REASONS as readonly string[]).includes(input.reason)) throw cardSyncRefusal('invalid-request');
  const run = deviceRun(ctx.db, input.deviceId, input.runId);
  const actor: CardSyncAuditActor = { kind: 'device', ref: input.deviceId };
  const fields = { cardAccountId: run.card_account_id, bindingId: run.binding_id, deviceId: input.deviceId, runId: run.id,
    code: input.reason };
  if (run.abort_reason !== null) {
    if (run.abort_reason !== input.reason) throw cardSyncRefusal('run-closed');
    return runView(runRow(ctx.db, run.id)!);
  }
  if (run.acceptance_state === 'open') {
    ctx.db.prepare(`UPDATE card_sync_runs SET acceptance_state = 'aborted', aborted_at = ?, abort_reason = ?, closed_at = ? WHERE id = ?`)
      .run(ctx.now, input.reason, ctx.now, run.id);
    audit(ctx, 'run-aborted', actor, fields);
  } else if (run.acceptance_state === 'accepted') {
    ctx.db.prepare('UPDATE card_sync_runs SET aborted_at = ?, abort_reason = ? WHERE id = ?').run(ctx.now, input.reason, run.id);
    const cancelled = run.set_id === null ? 0 : ctx.db.prepare(`UPDATE card_sync_commit_plans SET status = 'cancelled', closed_at = ?,
        cancel_reason = 'aborted' WHERE observation_set_id = ? AND status = 'prepared'`).run(ctx.now, run.set_id).changes;
    audit(ctx, 'run-aborted', actor, { ...fields, observationSetId: run.set_id, itemCount: cancelled });
  } else {
    throw cardSyncRefusal('run-closed');
  }
  return runView(runRow(ctx.db, run.id)!);
}

/** A run as the owner sees it, or null. */
export function getCardSyncRun(db: DB, runId: string): CardSyncRunView | null {
  const row = typeof runId === 'string' ? runRow(db, runId) : undefined;
  return row ? runView(row) : null;
}

/** E2 can identify a refused/truncated upload from its device-scoped Idempotency-Key without parsing untrusted payload bytes. */
export function getCardSyncRunByClientRunId(db: DB, input: { deviceId: string; clientRunId: string }): CardSyncRunView | null {
  if (!isDeviceId(input?.deviceId) || typeof input.clientRunId !== 'string' || !CLIENT_RUN_ID.test(input.clientRunId)) return null;
  const row = db.prepare(`${RUN_SELECT} WHERE r.device_id = ? AND r.client_run_id = ?`)
    .get(input.deviceId, input.clientRunId) as RunRow | undefined;
  return row ? runView(row) : null;
}

/**
 * A run's receipt: a device sees only its own runs (`run-not-found`
 * otherwise); the owner and the service token see any.
 */
export function getCardSyncRunReceipt(db: DB, input: { principal: CardSyncPrincipal; runId: string }): CardSyncRunView {
  const principal = input?.principal as { kind?: unknown; deviceId?: unknown } | undefined;
  if (principal?.kind === 'device') return runView(deviceRun(db, isDeviceId(principal.deviceId) ? principal.deviceId : '', input.runId));
  if (principal?.kind !== 'session' && principal?.kind !== 'service') throw cardSyncRefusal('principal-not-allowed');
  const row = typeof input.runId === 'string' ? runRow(db, input.runId) : undefined;
  if (!row) throw cardSyncRefusal('run-not-found');
  return runView(row);
}

/** Where a page of runs continues: the last run listed (newest first). Positions only, never authority. */
export interface CardSyncRunCursor {
  createdAt: string;
  runId: string;
}

/**
 * Runs newest first, optionally of one card account, binding or device, in
 * pages of 1–50; `next` is the position after the page, null at the end.
 */
export function listCardSyncRuns(db: DB, input: {
  cardAccountId?: string; bindingId?: string; deviceId?: string; after?: CardSyncRunCursor | null; limit: number;
}): { runs: CardSyncRunView[]; next: CardSyncRunCursor | null } {
  const { cardAccountId, bindingId, deviceId, after, limit } = input ?? ({} as never);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50
    || (cardAccountId !== undefined && (typeof cardAccountId !== 'string' || !ACCOUNT_ID.test(cardAccountId)))
    || (bindingId !== undefined && (typeof bindingId !== 'string' || !BINDING_ID.test(bindingId)))
    || (deviceId !== undefined && !isDeviceId(deviceId))
    || (after != null && (typeof after.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(after.createdAt)
      || typeof after.runId !== 'string' || !RUN_ID.test(after.runId)))) {
    throw cardSyncRefusal('invalid-request');
  }
  const where: string[] = [];
  const params: unknown[] = [];
  if (cardAccountId !== undefined) { where.push('r.card_account_id = ?'); params.push(cardAccountId); }
  if (bindingId !== undefined) { where.push('r.binding_id = ?'); params.push(bindingId); }
  if (deviceId !== undefined) { where.push('r.device_id = ?'); params.push(deviceId); }
  if (after) { where.push('(r.created_at < ? OR (r.created_at = ? AND r.id < ?))'); params.push(after.createdAt, after.createdAt, after.runId); }
  const rows = db.prepare(`${RUN_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY r.created_at DESC, r.id DESC LIMIT ?`).all(...params, limit + 1) as RunRow[];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { runs: page.map(runView), next: rows.length > limit && last ? { createdAt: last.created_at, runId: last.id } : null };
}
