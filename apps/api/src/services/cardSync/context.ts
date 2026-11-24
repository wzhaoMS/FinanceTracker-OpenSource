import type { Database as DB } from 'better-sqlite3';

import { newCardSyncRowId } from '../cardSyncDigests.js';
import type { CardSyncStatements } from '../cardSyncStatements.js';
import { cardSyncRefusal } from './refusals.js';

/**
 * What every card-sync repository operation runs with (E1b design §5.0):
 * the connection, inside the caller's one IMMEDIATE transaction; the
 * repository clock, read once per call, as stored; and the design's 22
 * named statements prepared on that connection.
 */
export interface CardSyncContext {
  db: DB;
  now: string;
  statements: CardSyncStatements;
  /** This build's card guard revision, which auto-sync consent snapshots (§2.6). */
  guardRevision: number;
}

/** E2 mints a fresh generation for each authorization change; the database only compares and sets it. */
export interface CardSyncGenerationStep {
  expectedGeneration: string;
  nextGeneration: string;
}

/** Who an audit row names (§2.17): the signed-in owner, a device, the system (scheduler, CLI, service token), or recovery. */
export type CardSyncAuditActor = { kind: 'session'; ref: string } | { kind: 'device'; ref: string } | { kind: 'system' }
  | { kind: 'recovery' };

const GENERATION = /^agn_[a-p]{32}$/;
const ACTOR_REF = /^usr_[a-p]{32}$/;

/** `now` plus whole seconds, as stored. */
export const secondsAfter = (now: string, seconds: number) => new Date(Date.parse(now) + seconds * 1000).toISOString();

/** The owner's `usr_` reference as a method names it; anything else is `principal-not-allowed`. */
export function sessionActorRef(actorRef: unknown): string {
  if (typeof actorRef !== 'string' || !ACTOR_REF.test(actorRef)) throw cardSyncRefusal('principal-not-allowed');
  return actorRef;
}

/** The database's authorization generation. */
export function currentGeneration(db: DB): string {
  return (db.prepare("SELECT authorization_generation AS g FROM card_sync_policy WHERE id = 'card-sync-policy'").get() as { g: string }).g;
}

/**
 * An authorization change's step (§5.0): well formed, and the database at
 * its expected generation. Every authorization change checks it before it
 * writes anything, the idempotent repeats included.
 */
export function checkGeneration(db: DB, step: CardSyncGenerationStep): void {
  const { expectedGeneration, nextGeneration } = (step ?? {}) as Partial<CardSyncGenerationStep>;
  if (typeof expectedGeneration !== 'string' || !GENERATION.test(expectedGeneration)
    || typeof nextGeneration !== 'string' || !GENERATION.test(nextGeneration) || nextGeneration === expectedGeneration) {
    throw cardSyncRefusal('invalid-request');
  }
  if (currentGeneration(db) !== expectedGeneration) throw cardSyncRefusal('generation-mismatch');
}

export interface CardSyncAuditFields {
  code?: string | null;
  cardAccountId?: string | null;
  bindingId?: string | null;
  deviceId?: string | null;
  pairingId?: string | null;
  runId?: string | null;
  observationSetId?: string | null;
  planId?: string | null;
  ledgerEventId?: string | null;
  versionBefore?: number | null;
  versionAfter?: number | null;
  rowCount?: number | null;
  byteCount?: number | null;
  itemCount?: number | null;
  generation?: string | null;
}

/** One audit row (§2.17): what happened, who did it, the objects it names; counts and codes only. */
export function audit(ctx: CardSyncContext, eventType: string, actor: CardSyncAuditActor, fields: CardSyncAuditFields = {}): void {
  ctx.db.prepare(`INSERT INTO card_sync_audit_events (id, event_type, actor_kind, actor_ref, card_account_id, binding_id, device_id,
      pairing_id, run_id, observation_set_id, plan_id, ledger_event_id, code, version_before, version_after, row_count, byte_count,
      item_count, authorization_generation, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(newCardSyncRowId('card-audit-'), eventType, actor.kind, actor.kind === 'session' || actor.kind === 'device' ? actor.ref : null,
      fields.cardAccountId ?? null, fields.bindingId ?? null, fields.deviceId ?? null, fields.pairingId ?? null, fields.runId ?? null,
      fields.observationSetId ?? null, fields.planId ?? null, fields.ledgerEventId ?? null, fields.code ?? null,
      fields.versionBefore ?? null, fields.versionAfter ?? null, fields.rowCount ?? null, fields.byteCount ?? null,
      fields.itemCount ?? null, fields.generation ?? null, ctx.now);
}

/**
 * §5.0: moves the generation from the expected one to the next, cancels
 * every prepared plan that pins a generation (extension sets,
 * `generation-changed`), and audits `generation-advanced` naming the change.
 * Call it after checkGeneration, once the change has been written.
 */
export function advanceGeneration(ctx: CardSyncContext, step: CardSyncGenerationStep, actor: CardSyncAuditActor, change: string): void {
  const moved = ctx.db.prepare(`UPDATE card_sync_policy SET authorization_generation = ?, generation_changed_at = ?
    WHERE id = 'card-sync-policy' AND authorization_generation = ?`).run(step.nextGeneration, ctx.now, step.expectedGeneration).changes;
  if (moved !== 1) throw cardSyncRefusal('generation-mismatch');
  ctx.db.prepare(`UPDATE card_sync_commit_plans SET status = 'cancelled', closed_at = ?, cancel_reason = 'generation-changed'
    WHERE status = 'prepared' AND authorization_generation IS NOT NULL`).run(ctx.now);
  audit(ctx, 'generation-advanced', actor, { code: change, generation: step.nextGeneration });
}

/**
 * Moves a binding's auto-sync revision by exactly one (§2.4): every consent
 * change and every grant creation, re-grant or revocation. A retired binding
 * never changes (its grants all went at retirement), so it is skipped rather
 * than failing a narrowing change.
 */
export function stepAutoSyncRevision(ctx: CardSyncContext, bindingId: string): void {
  ctx.db.prepare(`UPDATE card_source_bindings SET auto_sync_revision = auto_sync_revision + 1, updated_at = ?
    WHERE id = ? AND status <> 'retired'`).run(ctx.now, bindingId);
}
