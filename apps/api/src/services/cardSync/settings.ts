import type { Database as DB } from 'better-sqlite3';

import { CARD_SYNC_ISSUERS, isSupportedCardSyncContractVersion, type CardSyncIssuer } from '@finance-tracker/shared';
import {
  advanceGeneration,
  audit,
  checkGeneration,
  currentGeneration,
  sessionActorRef,
  type CardSyncAuditActor,
  type CardSyncContext,
  type CardSyncGenerationStep,
} from './context.js';
import { type CardSyncAuthChange } from './principals.js';
import { cardSyncRefusal } from './refusals.js';

export type { CardSyncContext, CardSyncGenerationStep } from './context.js';

/**
 * Settings, issuers and the authorization generation (E1b design §5.0,
 * §5.1). Each function runs inside the caller's IMMEDIATE transaction (the
 * repository method), reads time only from `now`, and refuses with a
 * card-sync code before writing anything.
 */

export interface CardSyncQuotas {
  maxRunsPerDeviceDay: number;
  accountSets: number;
  accountRows: number;
  accountBytes: number;
  deviceSets: number;
  deviceRows: number;
  deviceBytes: number;
  globalSets: number;
  globalRows: number;
  globalBytes: number;
}

export interface CardSyncIssuerSettings {
  issuer: CardSyncIssuer;
  enabled: boolean;
  enabledAt: string | null;
  approvedContractVersion: number | null;
  riskAcknowledgedAt: string | null;
  /** MAIN-world consent (Amex and Citi only). */
  mainWorldAccepted: boolean;
  revision: number;
}

export interface CardSyncSettings {
  paused: boolean;
  pausedAt: string | null;
  /** `card_sync_policy.revision`: +1 on every settings change, issuer changes included. */
  settingsVersion: number;
  reviewRetentionDays: number;
  receiptRetentionDays: number;
  quotas: CardSyncQuotas;
  issuers: CardSyncIssuerSettings[];
}

/** Issuers whose pages the extension reads from the page's own (MAIN) world, which needs a second consent. */
const MAIN_WORLD_ISSUERS: ReadonlySet<CardSyncIssuer> = new Set(['amex', 'citi']);

interface PolicyRow {
  revision: number;
  paused: number;
  paused_at: string | null;
  authorization_generation: string;
  review_retention_days: number;
  receipt_retention_days: number;
  max_runs_per_device_day: number;
  quota_account_sets: number;
  quota_account_rows: number;
  quota_account_bytes: number;
  quota_device_sets: number;
  quota_device_rows: number;
  quota_device_bytes: number;
  quota_global_sets: number;
  quota_global_rows: number;
  quota_global_bytes: number;
}

interface IssuerRow {
  id: CardSyncIssuer;
  enabled: number;
  enabled_at: string | null;
  approved_contract_version: number | null;
  risk_acknowledged_at: string | null;
  main_passive_accepted: number;
  revision: number;
}

const policyOf = (db: DB) => db.prepare("SELECT * FROM card_sync_policy WHERE id = 'card-sync-policy'").get() as PolicyRow;

/** The owner's settings: pause, retention, quotas and the four issuers, with the version an edit must name. */
export function readCardSyncSettings(db: DB): CardSyncSettings {
  const policy = policyOf(db);
  const issuers = db.prepare('SELECT * FROM card_sync_issuer_policy ORDER BY id').all() as IssuerRow[];
  return {
    paused: policy.paused === 1,
    pausedAt: policy.paused_at,
    settingsVersion: policy.revision,
    reviewRetentionDays: policy.review_retention_days,
    receiptRetentionDays: policy.receipt_retention_days,
    quotas: {
      maxRunsPerDeviceDay: policy.max_runs_per_device_day,
      accountSets: policy.quota_account_sets, accountRows: policy.quota_account_rows, accountBytes: policy.quota_account_bytes,
      deviceSets: policy.quota_device_sets, deviceRows: policy.quota_device_rows, deviceBytes: policy.quota_device_bytes,
      globalSets: policy.quota_global_sets, globalRows: policy.quota_global_rows, globalBytes: policy.quota_global_bytes,
    },
    issuers: issuers.map((row) => ({
      issuer: row.id, enabled: row.enabled === 1, enabledAt: row.enabled_at, approvedContractVersion: row.approved_contract_version,
      riskAcknowledgedAt: row.risk_acknowledged_at, mainWorldAccepted: row.main_passive_accepted === 1, revision: row.revision,
    })),
  };
}

/** The database's authorization generation (E2 only: gate comparison, narrowing while blocked; never sent to a client). */
export function readCardSyncAuthorizationGeneration(db: DB): string {
  return currentGeneration(db);
}

function result(ctx: CardSyncContext, changed: boolean): CardSyncAuthChange<CardSyncSettings> {
  return { value: readCardSyncSettings(ctx.db), changed, authorizationGeneration: readCardSyncAuthorizationGeneration(ctx.db) };
}

/** Narrowing: needs no version and always wins; pausing a paused system changes nothing. */
export function pauseCardSync(ctx: CardSyncContext, input: { actorRef: string } & CardSyncGenerationStep): CardSyncAuthChange<CardSyncSettings> {
  const actorRef = sessionActorRef(input?.actorRef);
  const actor: CardSyncAuditActor = { kind: 'session', ref: actorRef };
  checkGeneration(ctx.db, input);
  if (policyOf(ctx.db).paused === 1) return result(ctx, false);
  ctx.db.prepare(`UPDATE card_sync_policy SET paused = 1, paused_at = ?, revision = revision + 1, updated_by_ref = ?, updated_at = ?
    WHERE id = 'card-sync-policy'`).run(ctx.now, actorRef, ctx.now);
  audit(ctx, 'sync-paused', actor);
  advanceGeneration(ctx, input, actor, 'sync-paused');
  return result(ctx, true);
}

/** Widening (E2's gate must be open): at the settings version the owner saw; resuming a running system changes nothing. */
export function resumeCardSync(
  ctx: CardSyncContext,
  input: { expectedVersion: number; actorRef: string } & CardSyncGenerationStep,
): CardSyncAuthChange<CardSyncSettings> {
  const actorRef = sessionActorRef(input?.actorRef);
  const actor: CardSyncAuditActor = { kind: 'session', ref: actorRef };
  checkGeneration(ctx.db, input);
  const policy = policyOf(ctx.db);
  if (input.expectedVersion !== policy.revision) throw cardSyncRefusal('version-conflict');
  if (policy.paused === 0) return result(ctx, false);
  ctx.db.prepare(`UPDATE card_sync_policy SET paused = 0, paused_at = NULL, revision = revision + 1, updated_by_ref = ?, updated_at = ?
    WHERE id = 'card-sync-policy'`).run(actorRef, ctx.now);
  audit(ctx, 'sync-resumed', actor);
  advanceGeneration(ctx, input, actor, 'sync-resumed');
  return result(ctx, true);
}

function issuerOf(db: DB, issuer: unknown): IssuerRow {
  if (typeof issuer !== 'string' || !(CARD_SYNC_ISSUERS as readonly string[]).includes(issuer)) throw cardSyncRefusal('policy-invalid');
  return db.prepare('SELECT * FROM card_sync_issuer_policy WHERE id = ?').get(issuer) as IssuerRow;
}

/**
 * Widening: the owner acknowledged the risk, for a contract version this
 * build supports, and (Amex, Citi) consented to the MAIN world. Sets the
 * approval and moves both revisions; enabling an issuer already enabled for
 * that contract version changes nothing.
 */
export function enableCardSyncIssuer(ctx: CardSyncContext, input: {
  issuer: CardSyncIssuer; expectedVersion: number; contractVersion: number; riskAcknowledged: true; mainWorldAcknowledged: boolean;
  actorRef: string;
} & CardSyncGenerationStep): CardSyncAuthChange<CardSyncSettings> {
  const actorRef = sessionActorRef(input?.actorRef);
  const actor: CardSyncAuditActor = { kind: 'session', ref: actorRef };
  const row = issuerOf(ctx.db, input.issuer);
  if (input.riskAcknowledged !== true || typeof input.mainWorldAcknowledged !== 'boolean') throw cardSyncRefusal('policy-invalid');
  if (!isSupportedCardSyncContractVersion(input.contractVersion)) throw cardSyncRefusal('contract-unsupported');
  const mainWorld = MAIN_WORLD_ISSUERS.has(row.id);
  if (mainWorld && !input.mainWorldAcknowledged) throw cardSyncRefusal('main-world-required');
  checkGeneration(ctx.db, input);
  if (input.expectedVersion !== policyOf(ctx.db).revision) throw cardSyncRefusal('version-conflict');
  if (row.enabled === 1 && row.approved_contract_version === input.contractVersion) return result(ctx, false);
  ctx.db.prepare(`UPDATE card_sync_issuer_policy SET enabled = 1, enabled_at = ?, approved_contract_version = ?, risk_acknowledged_at = ?,
      main_passive_accepted = ?, revision = revision + 1, updated_by_ref = ?, updated_at = ?
    WHERE id = ?`).run(ctx.now, input.contractVersion, ctx.now, mainWorld ? 1 : 0, actorRef, ctx.now, row.id);
  ctx.db.prepare("UPDATE card_sync_policy SET revision = revision + 1, updated_by_ref = ?, updated_at = ? WHERE id = 'card-sync-policy'")
    .run(actorRef, ctx.now);
  audit(ctx, 'issuer-enabled', actor, { code: row.id });
  advanceGeneration(ctx, input, actor, 'issuer-enabled');
  return result(ctx, true);
}

/**
 * Narrowing: clears the approval's consent (enabled, MAIN world, the risk
 * acknowledgement; the approved contract version stays as history) and
 * moves both revisions, which invalidates auto-sync consent snapshots.
 */
export function disableCardSyncIssuer(
  ctx: CardSyncContext,
  input: { issuer: CardSyncIssuer; actorRef: string } & CardSyncGenerationStep,
): CardSyncAuthChange<CardSyncSettings> {
  const actorRef = sessionActorRef(input?.actorRef);
  const actor: CardSyncAuditActor = { kind: 'session', ref: actorRef };
  const row = issuerOf(ctx.db, input.issuer);
  checkGeneration(ctx.db, input);
  if (row.enabled === 0) return result(ctx, false);
  ctx.db.prepare(`UPDATE card_sync_issuer_policy SET enabled = 0, enabled_at = NULL, risk_acknowledged_at = NULL, main_passive_accepted = 0,
      revision = revision + 1, updated_by_ref = ?, updated_at = ?
    WHERE id = ?`).run(actorRef, ctx.now, row.id);
  ctx.db.prepare("UPDATE card_sync_policy SET revision = revision + 1, updated_by_ref = ?, updated_at = ? WHERE id = 'card-sync-policy'")
    .run(actorRef, ctx.now);
  audit(ctx, 'issuer-disabled', actor, { code: row.id });
  advanceGeneration(ctx, input, actor, 'issuer-disabled');
  return result(ctx, true);
}

const QUOTA_COLUMNS: ReadonlyArray<[keyof CardSyncQuotas, string, number, number]> = [
  ['maxRunsPerDeviceDay', 'max_runs_per_device_day', 1, 500],
  ['accountSets', 'quota_account_sets', 1, 1000], ['accountRows', 'quota_account_rows', 1, 100_000],
  ['accountBytes', 'quota_account_bytes', 1, 104_857_600],
  ['deviceSets', 'quota_device_sets', 1, 2000], ['deviceRows', 'quota_device_rows', 1, 200_000],
  ['deviceBytes', 'quota_device_bytes', 1, 209_715_200],
  ['globalSets', 'quota_global_sets', 1, 5000], ['globalRows', 'quota_global_rows', 1, 500_000],
  ['globalBytes', 'quota_global_bytes', 1, 524_288_000],
];

/**
 * Retention and quotas (not authorization, so no generation step), at the
 * settings version the owner saw. A new review retention applies to sets
 * accepted afterwards. Values outside the schema's ranges are `policy-invalid`.
 */
export function updateCardSyncRetention(ctx: CardSyncContext, input: {
  expectedVersion: number; reviewRetentionDays?: number; receiptRetentionDays?: number; quotas?: Partial<CardSyncQuotas>;
  actorRef: string;
}): CardSyncSettings {
  const actorRef = sessionActorRef(input?.actorRef);
  const actor: CardSyncAuditActor = { kind: 'session', ref: actorRef };
  const sets: Array<[string, number]> = [];
  const take = (column: string, value: unknown, low: number, high: number) => {
    if (value === undefined) return;
    if (!Number.isSafeInteger(value) || (value as number) < low || (value as number) > high) throw cardSyncRefusal('policy-invalid');
    sets.push([column, value as number]);
  };
  take('review_retention_days', input.reviewRetentionDays, 1, 90);
  take('receipt_retention_days', input.receiptRetentionDays, 1, 7);
  if (input.quotas !== undefined) {
    if (typeof input.quotas !== 'object' || input.quotas === null
      || Object.keys(input.quotas).some((key) => !QUOTA_COLUMNS.some(([name]) => name === key))) {
      throw cardSyncRefusal('policy-invalid');
    }
    for (const [name, column, low, high] of QUOTA_COLUMNS) take(column, input.quotas[name], low, high);
  }
  if (input.expectedVersion !== policyOf(ctx.db).revision) throw cardSyncRefusal('version-conflict');
  if (sets.length === 0) return readCardSyncSettings(ctx.db);
  ctx.db.prepare(`UPDATE card_sync_policy SET ${sets.map(([column]) => `${column} = ?`).join(', ')}, revision = revision + 1,
      updated_by_ref = ?, updated_at = ? WHERE id = 'card-sync-policy'`)
    .run(...sets.map(([, value]) => value), actorRef, ctx.now);
  audit(ctx, 'policy-changed', actor);
  return readCardSyncSettings(ctx.db);
}
