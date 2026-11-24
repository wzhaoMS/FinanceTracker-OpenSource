import { audit, type CardSyncContext } from './context.js';
import { cardSyncRefusal } from './refusals.js';

/**
 * Recovery invalidation (E1b design §5.8, plan §9.5 steps 3–5): only E2's
 * recovery CLI calls it, after the external fence and with ingress and
 * writers stopped, so it ignores the old generation. One transaction, actor
 * `recovery`, closes every authority a restored backup could have carried:
 * pairings, devices and grants, prepared plans, open runs, the pause switch
 * and every issuer, every live binding (re-confirmation), every open
 * extension set (recovery review, original expiry kept), then the new
 * generation. Ledger rows, identities, contents, events, scopes, file sets
 * and accepted receipts are untouched.
 */

export interface CardSyncRecoveryReport {
  pairingsCancelled: number;
  devicesRevoked: number;
  grantsRevoked: number;
  plansCancelled: number;
  runsExpired: number;
  issuersDisabled: number;
  bindingsToReconfirm: number;
  setsToRecoveryReview: number;
  authorizationGeneration: string;
}

const GENERATION = /^agn_[a-p]{32}$/;

export function invalidateAllCardSyncAuthorization(ctx: CardSyncContext, input: { nextGeneration: string }): CardSyncRecoveryReport {
  const { db, now } = ctx;
  const next = input?.nextGeneration;
  const current = db.prepare("SELECT authorization_generation FROM card_sync_policy WHERE id = 'card-sync-policy'").pluck().get() as string;
  if (typeof next !== 'string' || !GENERATION.test(next) || next === current) throw cardSyncRefusal('invalid-request');
  const actor = { kind: 'recovery' as const };

  const pairingsCancelled = db.prepare(`UPDATE card_sync_pairings SET status = 'cancelled', code_digest = NULL, closed_at = ?
    WHERE status IN ('open', 'redeemed')`).run(now).changes;
  const grantsRevoked = ctx.statements.run('revoke-all-grants', { now });
  const devicesRevoked = db.prepare(`UPDATE card_sync_devices SET status = 'revoked', close_reason = 'recovery', closed_at = ?,
      token_digest = NULL WHERE status IN ('pending', 'active')`).run(now).changes;
  const plansCancelled = db.prepare(`UPDATE card_sync_commit_plans SET status = 'cancelled', cancel_reason = 'recovery', closed_at = ?
    WHERE status = 'prepared'`).run(now).changes;
  const runsExpired = db.prepare(`UPDATE card_sync_runs SET acceptance_state = 'expired', closed_at = ? WHERE acceptance_state = 'open'`)
    .run(now).changes;
  db.prepare(`UPDATE card_sync_policy SET paused = 1, paused_at = coalesce(paused_at, ?), revision = revision + 1, updated_at = ?
    WHERE id = 'card-sync-policy'`).run(now, now);
  const issuersDisabled = db.prepare(`UPDATE card_sync_issuer_policy SET enabled = 0, enabled_at = NULL, risk_acknowledged_at = NULL,
      main_passive_accepted = 0, revision = revision + 1, updated_at = ?
    WHERE enabled = 1 OR risk_acknowledged_at IS NOT NULL OR main_passive_accepted = 1`).run(now).changes;
  const bindingsToReconfirm = db.prepare(`UPDATE card_source_bindings SET status = 'needs-reconfirmation',
      status_reason = 'restored-from-backup', version = version + 1, auto_sync_revision = auto_sync_revision + 1, updated_at = ?
    WHERE status <> 'retired'`).run(now).changes;
  const setsToRecoveryReview = db.prepare(`UPDATE card_sync_observation_sets SET state = 'recovery-review', version = version + 1
    WHERE origin = 'extension' AND state IN ('accepted-uncommitted', 'needs-review', 'blocked-review')`).run().changes;
  db.prepare(`UPDATE card_sync_policy SET authorization_generation = ?, recovery_completed_at = ? WHERE id = 'card-sync-policy'`)
    .run(next, now);
  const report: CardSyncRecoveryReport = {
    pairingsCancelled, devicesRevoked, grantsRevoked, plansCancelled, runsExpired, issuersDisabled, bindingsToReconfirm,
    setsToRecoveryReview, authorizationGeneration: next,
  };
  audit(ctx, 'recovery-completed', actor, {
    generation: next, itemCount: devicesRevoked + pairingsCancelled + plansCancelled + runsExpired + bindingsToReconfirm
      + setsToRecoveryReview,
    rowCount: grantsRevoked,
  });
  return report;
}
