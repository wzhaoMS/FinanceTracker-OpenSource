import { newCardSyncRowId } from '../cardSyncDigests.js';
import { audit, type CardSyncContext } from './context.js';
import { cardSyncRefusal } from './refusals.js';

/**
 * Retention and cleanup (E1b design §5.9): E2 calls it at startup, every 10
 * minutes, and again while `done` is false. Each call is one IMMEDIATE
 * transaction running the seven phases in order, every chunk bounded by the
 * rows it writes or deletes (cascades included), the clock read before each
 * chunk; once the work budget is spent the call commits and reports what is
 * left. Statements are the validator's (§2.20 step 6), generalised to every
 * set. Retention never writes card transactions, identities, contents,
 * events, scopes or bindings, and the deadline never waits for it: every
 * method already treats a set past `expires_at` as expired (Q46).
 */

export interface CardSyncRetentionReport {
  done: boolean;
  /**
   * The call wrote nothing: the WAL still held frames it could not copy back (a reader still needs them), or another
   * connection committed while it checked. Every phase is left for a later call (O100).
   */
  deferred: boolean;
  phases: Array<{ phase: 1 | 2 | 3 | 4 | 5 | 6 | 7; processed: number; remaining: boolean }>;
  /** Due sets still in the middle of their expiry. */
  expiringSets: number;
  /** The newest audit cutoff is more than 5 minutes ahead of the clock (Revision 8). */
  auditCutoffAhead: boolean;
}

const CHUNK = 100;
const DAY_MS = 86_400_000;
/**
 * A call's work budget. A call's commit grows with its work: with 100 ms, a
 * full call wrote past the WAL's 1,000-frame auto-checkpoint, so nearly every
 * commit checkpointed and whole calls came close to the 250 ms bound (O100).
 * Retention does the same work in more, shorter calls.
 */
export const CARD_SYNC_RETENTION_BUDGET_MS = 50;

type Phase = CardSyncRetentionReport['phases'][number]['phase'];

/** A call's work budget in ms: the default, or the caller's from 1 to 120; anything else is refused (`invalid-request`). */
export function cardSyncRetentionBudget(input: { budgetMs?: number } = {}): number {
  const budget = input?.budgetMs ?? CARD_SYNC_RETENTION_BUDGET_MS;
  if (!Number.isInteger(budget) || budget < 1 || budget > 120) throw cardSyncRefusal('invalid-request');
  return budget;
}

export function runCardSyncRetention(ctx: CardSyncContext, input: { budgetMs?: number } = {}): CardSyncRetentionReport {
  const { db, now } = ctx;
  const budget = cardSyncRetentionBudget(input);
  const started = process.hrtime.bigint();
  const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6;
  const weekAgo = new Date(Date.parse(now) - 7 * DAY_MS).toISOString();
  const yearAgo = new Date(Date.parse(now) - 365 * DAY_MS).toISOString();
  const q = {
    p1plans: db.prepare(`UPDATE card_sync_commit_plans SET status = 'expired', closed_at = ? WHERE rowid IN (SELECT rowid
      FROM card_sync_commit_plans WHERE status = 'prepared' AND expires_at <= ? LIMIT ${CHUNK})`),
    p1runs: db.prepare(`UPDATE card_sync_runs SET acceptance_state = 'expired', closed_at = ? WHERE rowid IN (SELECT rowid
      FROM card_sync_runs WHERE acceptance_state = 'open' AND upload_expires_at <= ? LIMIT ${CHUNK})`),
    p2pairings: db.prepare(`UPDATE card_sync_pairings SET status = 'expired', code_digest = NULL, closed_at = ? WHERE rowid IN
      (SELECT rowid FROM card_sync_pairings WHERE status = 'open' AND expires_at <= ? LIMIT ${CHUNK})`),
    p2pending: db.prepare(`SELECT d.id, d.pairing_id FROM card_sync_devices d
      WHERE d.status = 'pending' AND d.pending_expires_at <= ? ORDER BY d.pending_expires_at, d.rowid LIMIT 1`),
    p2pendingDevice: db.prepare(`UPDATE card_sync_devices SET status = 'expired', token_digest = NULL, closed_at = ?,
      close_reason = 'pending-expired' WHERE id = ? AND status = 'pending'`),
    p2pendingPairing: db.prepare(`UPDATE card_sync_pairings SET status = 'expired', closed_at = ? WHERE id = ? AND status = 'redeemed'`),
    p2device: db.prepare(`SELECT id FROM card_sync_devices WHERE status = 'active' AND expires_at <= ? ORDER BY expires_at, rowid LIMIT 1`)
      .pluck(),
    p2expire: db.prepare(`UPDATE card_sync_devices SET status = 'expired', token_digest = NULL, closed_at = ?, close_reason = 'expired'
      WHERE id = ?`),
    p2plans: db.prepare(`UPDATE card_sync_commit_plans SET status = 'cancelled', closed_at = ?, cancel_reason = 'device-revoked'
      WHERE device_id = ? AND status = 'prepared'`),
    dueSet: db.prepare(`SELECT id FROM card_sync_observation_sets WHERE closed_at IS NULL AND expires_at <= ?
      ORDER BY expires_at, rowid LIMIT 1`).pluck(),
    openRows: db.prepare(`SELECT id FROM card_source_observations WHERE observation_set_id = ? AND state = 'open' LIMIT ${CHUNK}`).pluck(),
    expireRows: db.prepare(`UPDATE card_source_observations SET state = 'expired', resolved_at = ?
      WHERE id IN (SELECT value FROM json_each(?))`),
    expireItems: db.prepare(`UPDATE card_reconciliation_suggestions SET status = 'expired', draft_action = NULL, draft_transaction_id = NULL,
        draft_scope_id = NULL, drafted_by_ref = NULL, drafted_at = NULL, updated_at = ?
      WHERE observation_id IN (SELECT value FROM json_each(?)) AND status IN ('open', 'decided')`),
    expireSetItem: db.prepare(`UPDATE card_reconciliation_suggestions SET status = 'expired', draft_action = NULL, draft_transaction_id = NULL,
        draft_scope_id = NULL, drafted_by_ref = NULL, drafted_at = NULL, updated_at = ?
      WHERE observation_set_id = ? AND observation_id IS NULL AND status IN ('open', 'decided')`),
    cancelPlans: db.prepare(`UPDATE card_sync_commit_plans SET status = 'cancelled', closed_at = ?, cancel_reason = 'set-closed'
      WHERE observation_set_id = ? AND status = 'prepared'`),
    closeSet: db.prepare(`UPDATE card_sync_observation_sets SET state = 'expired-unreviewed', closed_at = ?, close_reason = 'expired',
      expired_count = expired_count + open_count, open_count = 0, version = version + 1 WHERE id = ?`),
    coverage: db.prepare(`UPDATE card_coverage_windows SET ledger_state = 'expired-unreviewed', updated_at = ?
      WHERE observation_set_id = ? AND ledger_state = 'observed-uncommitted'`),
    p4receipt: db.prepare(`SELECT observation_set_id FROM card_sync_payload_receipts WHERE expires_at <= ?
      ORDER BY expires_at, rowid LIMIT 1`).pluck(),
    p4mark: db.prepare(`UPDATE card_sync_observation_sets SET receipt_state = 'expired', version = version + 1
      WHERE id = ? AND receipt_state = 'kept'`),
    p4delete: db.prepare('DELETE FROM card_sync_payload_receipts WHERE observation_set_id = ?'),
    purgeSet: db.prepare(`SELECT id FROM card_sync_observation_sets WHERE closed_at IS NOT NULL AND content_purged_at IS NULL
      AND expires_at <= ? ORDER BY expires_at, rowid LIMIT 1`).pluck(),
    purgeChunk: db.prepare(`DELETE FROM card_source_observations WHERE rowid IN (SELECT rowid FROM card_source_observations
      WHERE observation_set_id = ? AND provenance = 0 LIMIT ${CHUNK})`),
    markPurged: db.prepare('UPDATE card_sync_observation_sets SET content_purged_at = ?, version = version + 1 WHERE id = ?'),
    p6plan: db.prepare(`SELECT id FROM card_sync_commit_plans WHERE status <> 'prepared' AND closed_at <= ?
      ORDER BY closed_at, rowid LIMIT 1`).pluck(),
    p6delete: db.prepare('DELETE FROM card_sync_commit_plans WHERE id = ?'),
    p7sets: db.prepare(`SELECT s.id FROM card_sync_observation_sets s
      WHERE s.closed_at IS NOT NULL AND s.content_purged_at IS NOT NULL AND s.closed_at <= ?
        AND NOT EXISTS (SELECT 1 FROM card_source_observations o WHERE o.observation_set_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM card_transaction_events e WHERE e.observation_set_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM card_coverage_windows c WHERE c.observation_set_id = s.id AND c.ledger_state = 'committed')
        AND NOT EXISTS (SELECT 1 FROM card_sync_commit_plans p WHERE p.observation_set_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM card_sync_payload_receipts r WHERE r.observation_set_id = s.id)
      ORDER BY s.closed_at, s.rowid LIMIT ${CHUNK}`).pluck(),
    p7setItem: db.prepare('DELETE FROM card_reconciliation_suggestions WHERE observation_set_id = ? AND observation_id IS NULL'),
    p7setCoverage: db.prepare(`DELETE FROM card_coverage_windows WHERE observation_set_id = ? AND ledger_state <> 'committed'`),
    p7set: db.prepare('DELETE FROM card_sync_observation_sets WHERE id = ?'),
    p7runs: db.prepare(`DELETE FROM card_sync_runs WHERE rowid IN (SELECT r.rowid FROM card_sync_runs r
      WHERE r.acceptance_state <> 'open' AND r.closed_at <= ?
        AND NOT EXISTS (SELECT 1 FROM card_sync_observation_sets s WHERE s.run_id = r.id)
        AND NOT EXISTS (SELECT 1 FROM card_transaction_events e WHERE e.run_id = r.id)
        AND NOT EXISTS (SELECT 1 FROM card_source_identities i WHERE i.last_seen_run_id = r.id)
        AND NOT EXISTS (SELECT 1 FROM card_transactions t WHERE t.first_sync_run_id = r.id) LIMIT ${CHUNK})`),
    p7devices: db.prepare(`DELETE FROM card_sync_devices WHERE rowid IN (SELECT d.rowid FROM card_sync_devices d
      WHERE d.status IN ('revoked', 'expired') AND d.closed_at <= ?
        AND NOT EXISTS (SELECT 1 FROM card_sync_runs r WHERE r.device_id = d.id)
        AND NOT EXISTS (SELECT 1 FROM card_sync_observation_sets s WHERE s.device_id = d.id)
        AND NOT EXISTS (SELECT 1 FROM card_sync_commit_plans p WHERE p.device_id = d.id)
        AND NOT EXISTS (SELECT 1 FROM card_sync_pairings p WHERE p.replaces_device_id = d.id) LIMIT ${CHUNK})`),
    p7pairings: db.prepare(`DELETE FROM card_sync_pairings WHERE rowid IN (SELECT p.rowid FROM card_sync_pairings p
      WHERE p.status NOT IN ('open', 'redeemed') AND p.closed_at <= ?
        AND NOT EXISTS (SELECT 1 FROM card_sync_devices d WHERE d.pairing_id = p.id) LIMIT ${CHUNK})`),
    p7coverage: db.prepare(`DELETE FROM card_coverage_windows WHERE rowid IN (SELECT rowid FROM card_coverage_windows
      WHERE ledger_state IN ('expired-unreviewed', 'rejected') AND updated_at <= ? LIMIT ${CHUNK})`),
  };
  const touch = (setId: string) => ctx.statements.run('touch-set', { set_id: setId });

  /** Each chunk returns how many rows it settled; 0 means its phase has nothing left. */
  const chunks: Array<[Phase, () => number]> = [
    [1, () => q.p1plans.run(now, now).changes],
    [1, () => q.p1runs.run(now, now).changes],
    [2, () => q.p2pairings.run(now, now).changes],
    [2, () => {
      const pending = q.p2pending.get(now) as { id: string; pairing_id: string } | undefined;
      if (!pending) return 0;
      return q.p2pendingDevice.run(now, pending.id).changes + q.p2pendingPairing.run(now, pending.pairing_id).changes;
    }],
    [2, () => {
      const device = q.p2device.get(now) as string | undefined;
      if (!device) return 0;
      q.p2expire.run(now, device);
      return 1 + ctx.statements.run('revoke-grants-of-device', { now, device_id: device }) + q.p2plans.run(now, device).changes;
    }],
    [3, () => {
      const set = q.dueSet.get(now) as string | undefined;
      if (!set) return 0;
      const ids = JSON.stringify(q.openRows.all(set));
      const expired = q.expireRows.run(now, ids).changes;
      if (expired > 0) return expired + q.expireItems.run(now, ids).changes + touch(set);
      q.expireSetItem.run(now, set);
      q.cancelPlans.run(now, set);
      q.coverage.run(now, set);
      q.closeSet.run(now, set);
      return 1;
    }],
    [4, () => {
      const set = q.p4receipt.get(now) as string | undefined;
      if (!set) return 0;
      q.p4mark.run(set);
      q.p4delete.run(set);
      return 1;
    }],
    [5, () => {
      if (q.dueSet.get(now) !== undefined) return 0;
      const set = q.purgeSet.get(now) as string | undefined;
      if (!set) return 0;
      const deleted = q.purgeChunk.run(set).changes;
      if (deleted > 0) return deleted + touch(set);
      q.markPurged.run(now, set);
      return 1;
    }],
    [6, () => {
      const plan = q.p6plan.get(weekAgo) as string | undefined;
      if (!plan) return 0;
      q.p6delete.run(plan);
      return 1;
    }],
    [7, (() => {
      let refreshed = false;
      return () => {
        if (refreshed) return 0;
        refreshed = true;
        return ctx.statements.run('audit-cutoff-refresh', { id: newCardSyncRowId('card-audit-'), now });
      };
    })()],
    [7, () => ctx.statements.run('audit-delete-chunk', { now })],
    [7, () => {
      const sets = q.p7sets.all(yearAgo) as string[];
      for (const set of sets) {
        q.p7setItem.run(set);
        q.p7setCoverage.run(set);
        q.p7set.run(set);
      }
      return sets.length;
    }],
    [7, () => q.p7runs.run(yearAgo).changes],
    [7, () => q.p7devices.run(yearAgo).changes],
    [7, () => q.p7pairings.run(yearAgo).changes],
    [7, () => q.p7coverage.run(yearAgo).changes],
  ];

  const processed = new Map<Phase, number>();
  const remaining = new Set<Phase>();
  let work = 0;
  let complete = true;
  outer: for (const [phase, chunk] of chunks) {
    for (;;) {
      if (elapsed() >= budget) {
        complete = false;
        remaining.add(phase);
        break outer;
      }
      const n = chunk();
      if (n === 0) break;
      processed.set(phase, (processed.get(phase) ?? 0) + n);
      work += n;
    }
  }
  if (!complete) {
    for (const [phase] of chunks) if (phase > Math.max(...remaining)) remaining.add(phase);
  }
  if (work > 0) audit(ctx, 'retention-completed', { kind: 'system' }, { code: 'retention', itemCount: work });
  return {
    done: complete && work === 0,
    deferred: false,
    phases: ([1, 2, 3, 4, 5, 6, 7] as Phase[]).map((phase) => ({ phase, processed: processed.get(phase) ?? 0, remaining: remaining.has(phase) })),
    ...outlook(ctx),
  };
}

/**
 * The report of a call that wrote nothing because the WAL still had frames to copy back (O100; the repository's
 * runCardSyncRetention decides): like a call whose budget ran out before its first chunk, it leaves every phase for a
 * later call.
 */
export function deferredCardSyncRetention(ctx: CardSyncContext): CardSyncRetentionReport {
  return {
    done: false,
    deferred: true,
    phases: ([1, 2, 3, 4, 5, 6, 7] as Phase[]).map((phase) => ({ phase, processed: 0, remaining: true })),
    ...outlook(ctx),
  };
}

/** What every report says after the call: the due sets still expiring, and whether the audit cutoff is ahead. */
function outlook(ctx: CardSyncContext): Pick<CardSyncRetentionReport, 'expiringSets' | 'auditCutoffAhead'> {
  const { db, now } = ctx;
  return {
    expiringSets: db.prepare(`SELECT count(*) FROM card_sync_observation_sets WHERE closed_at IS NULL AND expires_at <= ?`).pluck()
      .get(now) as number,
    auditCutoffAhead: ctx.statements.get('audit-cutoff-ahead', { now })?.ahead === 1,
  };
}
