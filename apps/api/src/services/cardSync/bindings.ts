import type { Database as DB } from 'better-sqlite3';

import {
  CARD_SYNC_CURRENCIES, isSupportedCardSyncContractVersion, normalizeCardImportText, type CardSyncIssuer, type CardSyncMode,
} from '@finance-tracker/shared';
import { CARD_SYNC_ADMISSIONS, type CardSyncAdmission } from '../cardLedger/admissions.js';
import { newCardSyncId, newCardSyncRowId } from '../cardSyncDigests.js';
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

/**
 * Scopes and bindings (E1b design §5.2; owner API §3.3; session only). A
 * binding is the owner's statement that one registered source, on one card
 * account, shows these physical cards; its version is what device grants
 * pin, its auto-sync revision what the switch compares and sets. Every
 * function runs inside the caller's IMMEDIATE transaction and refuses with a
 * card-sync code before writing anything.
 */

export type CardSyncHolderAlias = 'alex' | 'casey' | 'joint' | 'member-a';
const HOLDER_ALIASES: ReadonlySet<string> = new Set(['alex', 'casey', 'joint', 'member-a']);
/** The label of an account's one unknown scope (Q4), as the owner page and its fake name it. */
export const UNKNOWN_SCOPE_LABEL = 'Holder unknown';
const MAX_SCOPES = 39;
const MAX_REGRANTS = 50;
const BINDING_ID = /^bnd_[a-p]{32}$/;
const SCOPE_ID = /^scp_[a-p]{32}$/;
const DEVICE_ID = /^dev_[a-p]{32}$/;

export interface CardScopeView {
  cardScopeId: string;
  kind: 'known' | 'unknown';
  scopeLabel: string;
  holderAlias: CardSyncHolderAlias | 'unknown';
  last4: string | null;
  status: 'active' | 'retired';
}

export interface CardSourceBindingView {
  bindingId: string;
  bindingVersion: number;
  issuer: CardSyncIssuer;
  source: string;
  bindingLabel: string;
  cardAccountRef: string;
  status: 'confirmed' | 'needs-reconfirmation' | 'retired';
  statusReason: 'restored-from-backup' | 'card-account-changed' | 'contract-changed' | null;
  confirmedAt: string | null;
  scopes: CardScopeView[];
  /**
   * The owner API's switch: `gate` stays closed while no namespace of the
   * source is admitted (E4–E7); `eligible` once a manual run of this binding
   * was committed at its current version; `revision` is what an "on" must
   * name; `devices` the consent of each current grant.
   */
  autoSync: {
    gate: 'open' | 'closed';
    eligible: boolean;
    revision: number;
    devices: Array<{ deviceId: string; enabled: boolean; consentedAt: string | null }>;
  };
  /** Devices holding an active grant of this binding, at any version. */
  deviceIds: string[];
}

export interface CardScopeDraft {
  label: string;
  holderAlias: CardSyncHolderAlias;
  last4: string | null;
}

interface BindingRow {
  id: string;
  card_account_id: string;
  issuer: CardSyncIssuer;
  currency: string;
  source: string;
  label: string;
  status: CardSourceBindingView['status'];
  status_reason: CardSourceBindingView['statusReason'];
  version: number;
  auto_sync_revision: number;
  confirmed_at: string;
}

interface ScopeRow {
  id: string;
  kind: 'known' | 'unknown';
  holder_alias: CardScopeView['holderAlias'];
  last4: string | null;
  label: string;
  status: 'active' | 'retired';
  version: number;
}

const bindingRow = (db: DB, bindingId: unknown) => (typeof bindingId === 'string' && BINDING_ID.test(bindingId)
  ? db.prepare('SELECT * FROM card_source_bindings WHERE id = ?').get(bindingId) as BindingRow | undefined
  : undefined);

function requireBinding(db: DB, bindingId: unknown): BindingRow {
  const row = bindingRow(db, bindingId);
  if (!row) throw cardSyncRefusal('not-found');
  return row;
}

/**
 * The scopes a binding grants: its known cards, then the account's unknown
 * scope. A confirmation revokes every active row before it inserts the new
 * version's, so the active rows always share one version: the binding's, or
 * for a retired binding the one before its retirement.
 */
function grantedScopes(db: DB, bindingId: string): ScopeRow[] {
  return db.prepare(`SELECT s.id, s.kind, s.holder_alias, s.last4, s.label, s.status, s.version
      FROM card_source_binding_scopes b JOIN card_scopes s ON s.id = b.card_scope_id
     WHERE b.binding_id = ? AND b.status = 'active'
     ORDER BY s.kind = 'unknown', b.rowid`).all(bindingId) as ScopeRow[];
}

/** True while some namespace of the source is admitted for automatic insert or lifecycle (never in E1b). */
function gateOpen(db: DB, source: string, admissions: Readonly<Record<string, CardSyncAdmission>>): boolean {
  const namespaces = db.prepare('SELECT namespace FROM card_sync_namespaces WHERE source = ?').pluck().all(source) as string[];
  return namespaces.some((namespace) => {
    const admission = admissions[namespace] as { autoInsert: boolean; lifecycle: boolean } | undefined;
    return admission?.autoInsert === true || admission?.lifecycle === true;
  });
}

/**
 * One manual run of this binding went accepted → plan → commit at its
 * current version (§5.2). The evidence is the run's set in state
 * `committed`, which only consuming the set's plan writes and which
 * adjustments and content purges keep; not the plan, which retention deletes
 * 7 days after it closes (review r1, finding 10). Retention keeps a committed
 * set at least 365 days after it closes, and for as long as an event or a
 * committed coverage window names it; its run is kept while the set is.
 */
function autoSyncEligible(db: DB, binding: BindingRow): boolean {
  return db.prepare(`SELECT 1 FROM card_sync_observation_sets s JOIN card_sync_runs r ON r.id = s.run_id
     WHERE s.binding_id = ? AND s.binding_version = ? AND s.state = 'committed' AND r.run_trigger = 'manual'
     LIMIT 1`).get(binding.id, binding.version) !== undefined;
}

export function bindingView(
  db: DB, binding: BindingRow, admissions: Readonly<Record<string, CardSyncAdmission>> = CARD_SYNC_ADMISSIONS,
): CardSourceBindingView {
  const grants = db.prepare(`SELECT device_id AS deviceId, auto_sync AS autoSync, consent_at AS consentedAt, binding_version AS version
      FROM card_sync_device_scopes WHERE binding_id = ? AND status = 'active' ORDER BY rowid`).all(binding.id) as Array<{
    deviceId: string; autoSync: number; consentedAt: string | null; version: number;
  }>;
  return {
    bindingId: binding.id,
    bindingVersion: binding.version,
    issuer: binding.issuer,
    source: binding.source,
    bindingLabel: binding.label,
    cardAccountRef: binding.card_account_id,
    status: binding.status,
    statusReason: binding.status_reason,
    confirmedAt: binding.confirmed_at,
    scopes: grantedScopes(db, binding.id).map((scope) => ({
      cardScopeId: scope.id, kind: scope.kind, scopeLabel: scope.label, holderAlias: scope.holder_alias, last4: scope.last4,
      status: scope.status,
    })),
    autoSync: {
      gate: gateOpen(db, binding.source, admissions) ? 'open' : 'closed',
      eligible: autoSyncEligible(db, binding),
      revision: binding.auto_sync_revision,
      devices: grants.filter((grant) => grant.version === binding.version)
        .map((grant) => ({ deviceId: grant.deviceId, enabled: grant.autoSync === 1, consentedAt: grant.consentedAt })),
    },
    deviceIds: [...new Set(grants.map((grant) => grant.deviceId))],
  };
}

export function listCardSourceBindings(db: DB, filter: { cardAccountId?: string } = {}): CardSourceBindingView[] {
  const rows = (filter.cardAccountId === undefined
    ? db.prepare('SELECT * FROM card_source_bindings ORDER BY created_at, rowid').all()
    : db.prepare('SELECT * FROM card_source_bindings WHERE card_account_id = ? ORDER BY created_at, rowid').all(filter.cardAccountId)
  ) as BindingRow[];
  return rows.map((row) => bindingView(db, row));
}

export function getCardSourceBinding(db: DB, bindingId: string): CardSourceBindingView | null {
  const row = bindingRow(db, bindingId);
  return row ? bindingView(db, row) : null;
}

/**
 * A binding or scope label (≤ 64 characters, owner API `LABEL`): already in
 * the stored text form (normalized, single spaces, trimmed, no control
 * characters). Card data in a label is the database guards' to refuse, so
 * it stays a guard refusal (§5.0).
 */
const isLabel = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= 64
  && normalizeCardImportText(value) === value;

type ScopeDraft = CardScopeDraft & { cardScopeId: string | null };

function draftOf(value: unknown, withIds: boolean): ScopeDraft {
  const draft = value as Partial<CardScopeDraft> & { cardScopeId?: unknown } | null;
  if (typeof draft !== 'object' || draft === null || Array.isArray(draft) || !isLabel(draft.label)
    || typeof draft.holderAlias !== 'string' || !HOLDER_ALIASES.has(draft.holderAlias)
    || !(draft.last4 === null || (typeof draft.last4 === 'string' && /^[0-9]{4}$/.test(draft.last4)))) {
    throw cardSyncRefusal('scope-invalid');
  }
  const cardScopeId = withIds ? draft.cardScopeId : null;
  if (withIds ? !(cardScopeId === null || (typeof cardScopeId === 'string' && SCOPE_ID.test(cardScopeId)))
    : draft.cardScopeId !== undefined) {
    throw cardSyncRefusal('scope-invalid');
  }
  return { label: draft.label, holderAlias: draft.holderAlias as CardSyncHolderAlias, last4: draft.last4, cardScopeId: cardScopeId as string | null };
}

/** A creation names 1–39 cards (owner API); a confirmation 0–39, the account's unknown scope always following. */
function draftsOf(value: unknown, withIds: boolean): ScopeDraft[] {
  if (!Array.isArray(value) || value.length < (withIds ? 0 : 1) || value.length > MAX_SCOPES) throw cardSyncRefusal('scope-invalid');
  return value.map((draft) => draftOf(draft, withIds));
}

function insertKnownScope(ctx: CardSyncContext, cardAccountId: string, draft: CardScopeDraft, actorRef: string): string {
  const id = newCardSyncId('scp_');
  ctx.db.prepare(`INSERT INTO card_scopes (id, card_account_id, kind, holder_alias, last4, label, status, version, confirmed_by_ref,
      confirmed_at, retired_at, created_at, updated_at)
    VALUES (?, ?, 'known', ?, ?, ?, 'active', 1, ?, ?, NULL, ?, ?)`)
    .run(id, cardAccountId, draft.holderAlias, draft.last4, draft.label, actorRef, ctx.now, ctx.now, ctx.now);
  return id;
}

/** The account's one unknown scope (Q4), created with its first binding and never retired; whether it was new. */
function ensureUnknownScope(ctx: CardSyncContext, cardAccountId: string, actorRef: string): { id: string; created: boolean } {
  const existing = ctx.db.prepare("SELECT id FROM card_scopes WHERE card_account_id = ? AND kind = 'unknown'").pluck()
    .get(cardAccountId) as string | undefined;
  if (existing) return { id: existing, created: false };
  const id = newCardSyncId('scp_');
  ctx.db.prepare(`INSERT INTO card_scopes (id, card_account_id, kind, holder_alias, last4, label, status, version, confirmed_by_ref,
      confirmed_at, retired_at, created_at, updated_at)
    VALUES (?, ?, 'unknown', 'unknown', NULL, ?, 'active', 1, ?, ?, NULL, ?, ?)`)
    .run(id, cardAccountId, UNKNOWN_SCOPE_LABEL, actorRef, ctx.now, ctx.now, ctx.now);
  return { id, created: true };
}

function grantScopes(ctx: CardSyncContext, binding: { id: string; card_account_id: string }, version: number,
  scopes: ReadonlyArray<{ id: string; kind: 'known' | 'unknown' }>): void {
  const insert = ctx.db.prepare(`INSERT INTO card_source_binding_scopes (id, binding_id, card_scope_id, card_account_id, card_scope_kind,
      binding_version, status, created_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL)`);
  for (const scope of scopes) {
    insert.run(newCardSyncRowId('card-bscope-'), binding.id, scope.id, binding.card_account_id, scope.kind, version, ctx.now);
  }
}

function result(ctx: CardSyncContext, bindingId: string, changed: boolean,
  admissions: Readonly<Record<string, CardSyncAdmission>> = CARD_SYNC_ADMISSIONS): CardSyncAuthChange<CardSourceBindingView> {
  return {
    value: bindingView(ctx.db, requireBinding(ctx.db, bindingId), admissions), changed, authorizationGeneration: currentGeneration(ctx.db),
  };
}

/** One audit row per kind of scope change in a call, with how many scopes it touched (the audit table names no scope). */
function auditScopes(ctx: CardSyncContext, actor: CardSyncAuditActor, binding: { id: string; card_account_id: string },
  counts: { created: number; changed: number; retired: number }): void {
  const kinds = [['scope-created', counts.created], ['scope-changed', counts.changed], ['scope-retired', counts.retired]] as const;
  for (const [eventType, itemCount] of kinds) {
    if (itemCount > 0) audit(ctx, eventType, actor, { cardAccountId: binding.card_account_id, bindingId: binding.id, itemCount });
  }
}

/**
 * A new binding (widening): the account's issuer is the source's and, under
 * contract 1, its currency USD (`card-account-mismatch`); no live binding of
 * the source on the account (`binding-exists`); the known scopes created
 * (two cards may share a last four or alias, §2.3), the account's unknown
 * scope ensured, all of them granted at version 1, status `confirmed`.
 */
export function createCardSourceBinding(ctx: CardSyncContext, input: {
  cardAccountId: string; source: string; label: string; scopes: CardScopeDraft[]; actorRef: string;
} & CardSyncGenerationStep): CardSyncAuthChange<CardSourceBindingView> {
  const actorRef = sessionActorRef(input?.actorRef);
  const actor: CardSyncAuditActor = { kind: 'session', ref: actorRef };
  const source = typeof input.source === 'string'
    ? ctx.db.prepare('SELECT source, issuer FROM card_sync_sources WHERE source = ?').get(input.source) as
      { source: string; issuer: CardSyncIssuer } | undefined
    : undefined;
  if (!source || !isLabel(input.label)) throw cardSyncRefusal('invalid-request');
  const drafts = draftsOf(input.scopes, false);
  const account = typeof input.cardAccountId === 'string'
    ? ctx.db.prepare('SELECT id, issuer, currency FROM card_accounts WHERE id = ?').get(input.cardAccountId) as
      { id: string; issuer: string; currency: string } | undefined
    : undefined;
  if (!account) throw cardSyncRefusal('not-found');
  if (account.issuer !== source.issuer || !(CARD_SYNC_CURRENCIES as readonly string[]).includes(account.currency)) {
    throw cardSyncRefusal('card-account-mismatch');
  }
  checkGeneration(ctx.db, input);
  if (ctx.db.prepare("SELECT 1 FROM card_source_bindings WHERE card_account_id = ? AND source = ? AND status <> 'retired'")
    .get(account.id, source.source)) {
    throw cardSyncRefusal('binding-exists');
  }
  const known = drafts.map((draft) => ({ id: insertKnownScope(ctx, account.id, draft, actorRef), kind: 'known' as const }));
  const unknown = ensureUnknownScope(ctx, account.id, actorRef);
  const bindingId = newCardSyncId('bnd_');
  ctx.db.prepare(`INSERT INTO card_source_bindings (id, card_account_id, issuer, currency, source, source_account_digest, label, status,
      status_reason, version, auto_sync_revision, confirmed_by_ref, confirmed_at, retired_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?, 'confirmed', NULL, 1, 1, ?, ?, NULL, ?, ?)`)
    .run(bindingId, account.id, source.issuer, account.currency, source.source, input.label, actorRef, ctx.now, ctx.now, ctx.now);
  const binding = { id: bindingId, card_account_id: account.id };
  grantScopes(ctx, binding, 1, [...known, { id: unknown.id, kind: 'unknown' }]);
  auditScopes(ctx, actor, binding, { created: known.length + (unknown.created ? 1 : 0), changed: 0, retired: 0 });
  audit(ctx, 'binding-created', actor, { cardAccountId: account.id, bindingId, versionAfter: 1, itemCount: known.length + 1 });
  advanceGeneration(ctx, input, actor, 'binding-created');
  return result(ctx, bindingId, true);
}

/**
 * Confirming a binding again (also after a restore), at the version the
 * owner saw. Listed scopes keep their ids (label and alias may change; a
 * different `last4` is a new card, `scope-immutable`); `null` adds a known
 * scope; a known scope left out is retired (its rows keep pointing at it).
 * Version + 1, `confirmed`, every scope granted again at the new version;
 * the binding's open extension sets accepted under an older version
 * `blocked-review`; every grant's consent withdrawn; each device in
 * `regrantDeviceIds` re-granted at the new version without consent, every
 * other device's grant left stale (`binding-stale`, Q35). The auto-sync
 * revision moves by one for the call. Widening.
 */
export function confirmCardSourceBinding(ctx: CardSyncContext, input: {
  bindingId: string; expectedVersion: number; label: string; scopes: ScopeDraft[]; regrantDeviceIds: string[]; actorRef: string;
} & CardSyncGenerationStep): CardSyncAuthChange<CardSourceBindingView> {
  const actorRef = sessionActorRef(input?.actorRef);
  const actor: CardSyncAuditActor = { kind: 'session', ref: actorRef };
  const binding = requireBinding(ctx.db, input.bindingId);
  if (!isLabel(input.label) || !Number.isSafeInteger(input.expectedVersion)) throw cardSyncRefusal('invalid-request');
  const drafts = draftsOf(input.scopes, true);
  const regrants = input.regrantDeviceIds;
  if (!Array.isArray(regrants) || regrants.length > MAX_REGRANTS || new Set(regrants).size !== regrants.length
    || regrants.some((id) => typeof id !== 'string' || !DEVICE_ID.test(id))) {
    throw cardSyncRefusal('invalid-request');
  }
  checkGeneration(ctx.db, input);
  if (binding.status === 'retired') throw cardSyncRefusal('binding-retired');
  if (input.expectedVersion !== binding.version) throw cardSyncRefusal('version-conflict');
  const knownNow = new Map(grantedScopes(ctx.db, binding.id).filter((scope) => scope.kind === 'known').map((scope) => [scope.id, scope]));
  const listed = drafts.flatMap((draft) => (draft.cardScopeId === null ? [] : [draft.cardScopeId]));
  if (new Set(listed).size !== listed.length || listed.some((id) => !knownNow.has(id))) throw cardSyncRefusal('scope-invalid');
  if (drafts.some((draft) => draft.cardScopeId !== null && knownNow.get(draft.cardScopeId)!.last4 !== draft.last4)) {
    throw cardSyncRefusal('scope-immutable');
  }
  const activeGrant = ctx.db.prepare(`SELECT g.id FROM card_sync_device_scopes g JOIN card_sync_devices d ON d.id = g.device_id
     WHERE g.device_id = ? AND g.binding_id = ? AND g.status = 'active' AND d.status = 'active' AND d.expires_at > ?`).pluck();
  const regrantRows = regrants.map((deviceId) => {
    const grantId = activeGrant.get(deviceId, binding.id, ctx.now) as string | undefined;
    if (grantId === undefined) throw cardSyncRefusal('not-found');
    return { deviceId, grantId };
  });
  const contract = regrantRows.length > 0 ? contractOf(ctx.db, binding) : undefined;

  const version = binding.version + 1;
  const updateScope = ctx.db.prepare(`UPDATE card_scopes SET label = ?, holder_alias = ?, version = version + 1, updated_at = ?
    WHERE id = ?`);
  const counts = { created: 0, changed: 0, retired: 0 };
  const kept: Array<{ id: string; kind: 'known' | 'unknown' }> = [];
  for (const draft of drafts) {
    if (draft.cardScopeId !== null) {
      const scope = knownNow.get(draft.cardScopeId)!;
      if (scope.label !== draft.label || scope.holder_alias !== draft.holderAlias) {
        updateScope.run(draft.label, draft.holderAlias, ctx.now, scope.id);
        counts.changed += 1;
      }
      kept.push({ id: scope.id, kind: 'known' });
    } else {
      kept.push({ id: insertKnownScope(ctx, binding.card_account_id, draft, actorRef), kind: 'known' });
      counts.created += 1;
    }
  }
  const keptIds = new Set(kept.map((scope) => scope.id));
  const retireScope = ctx.db.prepare(`UPDATE card_scopes SET status = 'retired', retired_at = ?, version = version + 1, updated_at = ?
    WHERE id = ?`);
  for (const id of knownNow.keys()) {
    if (keptIds.has(id)) continue;
    retireScope.run(ctx.now, ctx.now, id);
    counts.retired += 1;
  }
  ctx.db.prepare(`UPDATE card_source_binding_scopes SET status = 'revoked', revoked_at = ? WHERE binding_id = ? AND status = 'active'`)
    .run(ctx.now, binding.id);
  ctx.db.prepare(`UPDATE card_source_bindings SET label = ?, status = 'confirmed', status_reason = NULL, confirmed_by_ref = ?,
      confirmed_at = ?, version = ?, auto_sync_revision = auto_sync_revision + 1, updated_at = ?
    WHERE id = ?`).run(input.label, actorRef, ctx.now, version, ctx.now, binding.id);
  const unknown = ensureUnknownScope(ctx, binding.card_account_id, actorRef);
  if (unknown.created) counts.created += 1;
  grantScopes(ctx, binding, version, [...kept, { id: unknown.id, kind: 'unknown' }]);
  ctx.db.prepare(`UPDATE card_sync_observation_sets SET state = 'blocked-review', version = version + 1
    WHERE binding_id = ? AND binding_version < ? AND state IN ('accepted-uncommitted', 'needs-review')`).run(binding.id, version);
  ctx.statements.run('withdraw-consent-of-binding', { binding_id: binding.id });
  for (const { deviceId, grantId } of regrantRows) {
    ctx.statements.run('revoke-grant', { now: ctx.now, grant_id: grantId });
    insertGrant(ctx, { deviceId, bindingId: binding.id, bindingVersion: version, contract: contract!, actorRef });
    audit(ctx, 'device-regranted', actor, { cardAccountId: binding.card_account_id, bindingId: binding.id, deviceId, versionAfter: version });
  }
  auditScopes(ctx, actor, binding, counts);
  audit(ctx, 'binding-confirmed', actor, {
    cardAccountId: binding.card_account_id, bindingId: binding.id, versionBefore: binding.version, versionAfter: version,
    itemCount: kept.length + 1,
  });
  advanceGeneration(ctx, input, actor, 'binding-confirmed');
  return result(ctx, binding.id, true);
}

/**
 * The mode and contract version a new grant of this binding records: its
 * source's mode and its issuer's approved contract (`contract-unsupported`
 * when the issuer never approved one, or approved one this build no longer
 * supports).
 */
export function contractOf(db: DB, binding: { source: string }): { mode: CardSyncMode; contractVersion: number } {
  const row = db.prepare(`SELECT s.mode, i.approved_contract_version AS contractVersion
      FROM card_sync_sources s JOIN card_sync_issuer_policy i ON i.id = s.issuer WHERE s.source = ?`).get(binding.source) as
    { mode: CardSyncMode; contractVersion: number | null } | undefined;
  if (!row || !isSupportedCardSyncContractVersion(row.contractVersion)) throw cardSyncRefusal('contract-unsupported');
  return { mode: row.mode, contractVersion: row.contractVersion as number };
}

/** A fresh active grant, without consent (finding 14). */
export function insertGrant(ctx: CardSyncContext, grant: {
  deviceId: string; bindingId: string; bindingVersion: number; contract: { mode: CardSyncMode; contractVersion: number };
  actorRef: string;
}): void {
  ctx.db.prepare(`INSERT INTO card_sync_device_scopes (id, device_id, binding_id, binding_version, mode, contract_version, status,
      granted_by_ref, granted_at, revoked_at, auto_sync)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, 0)`)
    .run(newCardSyncRowId('card-dscope-'), grant.deviceId, grant.bindingId, grant.bindingVersion, grant.contract.mode,
      grant.contract.contractVersion, grant.actorRef, ctx.now);
}

/**
 * Retiring a binding (terminal; narrowing, so it also runs while the gate is
 * blocked): every grant revoked with its consent (`revoke-grants-of-binding`),
 * the binding's open sets `blocked-review` and their prepared plans
 * cancelled (`binding-changed`), status `retired` (a pending
 * reconfirmation's reason cleared: `ck_bind_status_shape`), version and
 * auto-sync revision + 1 in the one UPDATE a retired binding allows.
 * Retiring a retired binding changes nothing.
 */
export function retireCardSourceBinding(ctx: CardSyncContext, input: {
  bindingId: string; expectedVersion: number; actorRef: string;
} & CardSyncGenerationStep): CardSyncAuthChange<CardSourceBindingView> {
  const actorRef = sessionActorRef(input?.actorRef);
  const actor: CardSyncAuditActor = { kind: 'session', ref: actorRef };
  const binding = requireBinding(ctx.db, input.bindingId);
  if (!Number.isSafeInteger(input.expectedVersion)) throw cardSyncRefusal('invalid-request');
  checkGeneration(ctx.db, input);
  if (binding.status === 'retired') return result(ctx, binding.id, false);
  if (input.expectedVersion !== binding.version) throw cardSyncRefusal('version-conflict');
  const revoked = ctx.statements.run('revoke-grants-of-binding', { now: ctx.now, binding_id: binding.id });
  ctx.db.prepare(`UPDATE card_sync_commit_plans SET status = 'cancelled', closed_at = ?, cancel_reason = 'binding-changed'
    WHERE status = 'prepared' AND observation_set_id IN
      (SELECT id FROM card_sync_observation_sets WHERE binding_id = ? AND closed_at IS NULL)`).run(ctx.now, binding.id);
  ctx.db.prepare(`UPDATE card_sync_observation_sets SET state = 'blocked-review', version = version + 1
    WHERE binding_id = ? AND state IN ('accepted-uncommitted', 'needs-review')`).run(binding.id);
  ctx.db.prepare(`UPDATE card_source_bindings SET status = 'retired', status_reason = NULL, retired_at = ?, version = version + 1,
      auto_sync_revision = auto_sync_revision + 1, updated_at = ?
    WHERE id = ?`).run(ctx.now, ctx.now, binding.id);
  audit(ctx, 'binding-retired', actor, {
    cardAccountId: binding.card_account_id, bindingId: binding.id, versionBefore: binding.version, versionAfter: binding.version + 1,
    itemCount: revoked,
  });
  advanceGeneration(ctx, input, actor, 'binding-retired');
  return result(ctx, binding.id, true);
}

type AutoSyncInput = ({ bindingId: string; enabled: true; expectedVersion: number; expectedAutoSyncRevision: number }
  | { bindingId: string; enabled: false }) & { actorRef: string } & CardSyncGenerationStep;

/**
 * The auto-sync switch (§5.2; Revision 6's R1). Every explicit off on a
 * live binding moves the auto-sync revision (`auto-sync-step`) and withdraws
 * every consent (`withdraw-consent-of-binding`); it is an authorization
 * change only when it withdrew one, and on a retired binding it changes
 * nothing. An on needs the binding version and auto-sync revision the owner
 * saw (`version-conflict`, after the status checks), an eligible binding
 * (`auto-sync-not-eligible`) and an admitted namespace of the source
 * (`gate-closed`, always in E1b), then snapshots consent on the binding's
 * current grants. Each applied call writes one `auto-sync-changed` row.
 * `admissions` is CARD_SYNC_ADMISSIONS outside tests.
 */
export function setCardSyncAutoSync(
  ctx: CardSyncContext,
  input: AutoSyncInput,
  admissions: Readonly<Record<string, CardSyncAdmission>> = CARD_SYNC_ADMISSIONS,
): CardSyncAuthChange<CardSourceBindingView> {
  const actorRef = sessionActorRef(input?.actorRef);
  const actor: CardSyncAuditActor = { kind: 'session', ref: actorRef };
  const binding = requireBinding(ctx.db, input.bindingId);
  if (input.enabled === true) {
    if (!Number.isSafeInteger(input.expectedVersion) || !Number.isSafeInteger(input.expectedAutoSyncRevision)) {
      throw cardSyncRefusal('invalid-request');
    }
  } else if (input.enabled !== false) {
    throw cardSyncRefusal('invalid-request');
  }
  checkGeneration(ctx.db, input);
  const auditFields = { cardAccountId: binding.card_account_id, bindingId: binding.id, versionBefore: binding.auto_sync_revision,
    versionAfter: binding.auto_sync_revision + 1 };
  if (!input.enabled) {
    if (binding.status === 'retired') return result(ctx, binding.id, false, admissions);
    ctx.statements.run('auto-sync-step', {
      now: ctx.now, binding_id: binding.id, enabled: 0, expected_version: null, expected_auto_sync_revision: null,
    });
    const withdrawn = ctx.statements.run('withdraw-consent-of-binding', { binding_id: binding.id });
    audit(ctx, 'auto-sync-changed', actor, { ...auditFields, code: 'disabled', itemCount: withdrawn });
    if (withdrawn > 0) advanceGeneration(ctx, input, actor, 'auto-sync-changed');
    return result(ctx, binding.id, withdrawn > 0, admissions);
  }
  if (binding.status === 'retired') throw cardSyncRefusal('binding-retired');
  if (binding.status !== 'confirmed') throw cardSyncRefusal('binding-needs-reconfirmation');
  const stepped = ctx.statements.run('auto-sync-step', {
    now: ctx.now, binding_id: binding.id, enabled: 1, expected_version: input.expectedVersion,
    expected_auto_sync_revision: input.expectedAutoSyncRevision,
  });
  if (stepped !== 1) throw cardSyncRefusal('version-conflict');
  if (!autoSyncEligible(ctx.db, binding)) throw cardSyncRefusal('auto-sync-not-eligible');
  if (!gateOpen(ctx.db, binding.source, admissions)) throw cardSyncRefusal('gate-closed');
  const issuerRevision = ctx.db.prepare('SELECT revision FROM card_sync_issuer_policy WHERE id = ?').pluck().get(binding.issuer) as number;
  const consented = ctx.db.prepare(`UPDATE card_sync_device_scopes
      SET auto_sync = 1, consent_contract_version = contract_version, consent_guard_revision = ?, consent_issuer_revision = ?,
          consent_binding_version = binding_version, consent_by_ref = ?, consent_at = ?
    WHERE binding_id = ? AND status = 'active' AND binding_version = ?`)
    .run(ctx.guardRevision, issuerRevision, actorRef, ctx.now, binding.id, binding.version).changes;
  audit(ctx, 'auto-sync-changed', actor, { ...auditFields, code: 'enabled', itemCount: consented });
  advanceGeneration(ctx, input, actor, 'auto-sync-changed');
  return result(ctx, binding.id, true, admissions);
}
