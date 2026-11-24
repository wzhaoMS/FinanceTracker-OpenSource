import type { Database as DB } from 'better-sqlite3';

import type { CardSyncMode } from '@finance-tracker/shared';
import { cardSyncRefusal } from './refusals.js';

/**
 * The current-source authorization predicate (E1b design §4.10.1, finding 15):
 * one function, evaluated inside every transaction that creates a run,
 * accepts an upload, prepares or commits a plan of an extension set. It
 * re-reads the policy, the issuer (MAIN-world consent included), the binding
 * and, for a device, its credential and grant, so nothing decided earlier
 * (a run created before consent was withdrawn, a plan prepared before a
 * revocation) can act after the state changed. File sets and v1 imports
 * never call it. Returns the rows it read, for the caller's pins.
 */

export interface AuthorizedBinding {
  id: string;
  card_account_id: string;
  issuer: string;
  currency: string;
  source: string;
  status: 'confirmed' | 'needs-reconfirmation' | 'retired';
  version: number;
  auto_sync_revision: number;
}

export interface AuthorizedSource {
  binding: AuthorizedBinding;
  mode: CardSyncMode;
  policyRevision: number;
  issuerRevision: number;
  /** The device's active grant of the binding (device principals only). */
  grant?: {
    id: string; binding_version: number; contract_version: number; mode: CardSyncMode; auto_sync: number;
    consent_contract_version: number | null; consent_guard_revision: number | null; consent_issuer_revision: number | null;
    consent_binding_version: number | null;
  };
}

export function readBinding(db: DB, bindingId: string): AuthorizedBinding | undefined {
  return db.prepare(`SELECT id, card_account_id, issuer, currency, source, status, version, auto_sync_revision
    FROM card_source_bindings WHERE id = ?`).get(bindingId) as AuthorizedBinding | undefined;
}

export function currentSourceAuthorization(db: DB, now: string, a: {
  binding: AuthorizedBinding; contractVersion: number; expectedGeneration: string;
  device?: { id: string; bindingVersion: number }; sourceReviewed?: boolean; setBindingVersion?: number;
}): AuthorizedSource {
  const policy = db.prepare(`SELECT authorization_generation AS generation, paused, revision FROM card_sync_policy
    WHERE id = 'card-sync-policy'`).get() as { generation: string; paused: number; revision: number };
  if (policy.generation !== a.expectedGeneration) throw cardSyncRefusal('generation-mismatch');
  if (policy.paused === 1) throw cardSyncRefusal('sync-paused');
  const issuer = db.prepare(`SELECT i.enabled, i.approved_contract_version, i.risk_acknowledged_at, i.main_passive_accepted, i.revision,
      s.mode FROM card_sync_sources s JOIN card_sync_issuer_policy i ON i.id = s.issuer WHERE s.source = ?`).get(a.binding.source) as {
    enabled: number; approved_contract_version: number | null; risk_acknowledged_at: string | null; main_passive_accepted: number;
    revision: number; mode: CardSyncMode;
  };
  if (issuer.enabled !== 1 || issuer.approved_contract_version !== a.contractVersion || issuer.risk_acknowledged_at === null) {
    throw cardSyncRefusal('issuer-disabled');
  }
  if (issuer.mode === 'main-passive' && issuer.main_passive_accepted !== 1) throw cardSyncRefusal('issuer-disabled');
  if (a.binding.status === 'retired') throw cardSyncRefusal('binding-retired');
  if (a.binding.status !== 'confirmed') throw cardSyncRefusal('binding-needs-reconfirmation');
  const result: AuthorizedSource = { binding: a.binding, mode: issuer.mode, policyRevision: policy.revision, issuerRevision: issuer.revision };
  if (a.device) {
    const device = db.prepare('SELECT status, expires_at FROM card_sync_devices WHERE id = ?').get(a.device.id) as
      { status: string; expires_at: string | null } | undefined;
    if (!device || device.status !== 'active' || device.expires_at === null || device.expires_at <= now) {
      throw cardSyncRefusal('device-not-active');
    }
    const grant = db.prepare(`SELECT id, binding_version, contract_version, mode, auto_sync, consent_contract_version,
        consent_guard_revision, consent_issuer_revision, consent_binding_version
      FROM card_sync_device_scopes WHERE device_id = ? AND binding_id = ? AND status = 'active'`).get(a.device.id, a.binding.id) as
      AuthorizedSource['grant'] | undefined;
    if (!grant || grant.binding_version !== a.binding.version || a.device.bindingVersion !== a.binding.version
      || grant.contract_version !== a.contractVersion) {
      throw cardSyncRefusal('binding-stale');
    }
    result.grant = grant;
  } else if (a.setBindingVersion !== undefined && a.setBindingVersion !== a.binding.version && !a.sourceReviewed) {
    throw cardSyncRefusal('source-review-required');
  }
  return result;
}

/**
 * Whether a grant's auto-sync consent is current (§2.6, D7): given, and
 * snapshotting the contract, guard revision, issuer revision and binding
 * version in force now. Only an `auto` run's device plan needs it.
 */
export function consentIsCurrent(source: AuthorizedSource, guardRevision: number): boolean {
  const grant = source.grant;
  return grant !== undefined && grant.auto_sync === 1 && grant.consent_contract_version === grant.contract_version
    && grant.consent_guard_revision === guardRevision && grant.consent_issuer_revision === source.issuerRevision
    && grant.consent_binding_version === source.binding.version;
}
