import type { Database } from 'better-sqlite3';
import { HoldrRefusal } from '../dbErrors.js';
import { digest, opaque, POLICY_DIGEST, SOURCE, TIP_SPLIT_POLICY_DIGEST } from './policy.js';
import { hasProofPredecessorSchema } from './schema.js';
import { matchAmazon, readLedger, readSubjects, reconcileAmazon } from './matcher.js';
import { activeBindings, readCardInventory } from './bindings.js';
import type { Binding, LedgerRow, MatchResult, MatchSubject, OrderObservation, Staging } from './types.js';
import { orderTotalSubject, readOrderHistory } from './allocation.js';
import { projectRefundEvents } from './refundEvents.js';
import { freshListRestorable, restoreActiveFreshList } from './freshImport.js';
import { storedSplitSubjects, tipSplitSubjects } from './tipSplit.js';

/*
 * The Amazon settle: the rechecks every Amazon write runs first (revocation of contradicted proofs, the refund
 * projection), the matcher's reconcile, and the linked card rows a gate compares before and after. Moved here unchanged
 * from importer.ts and savedOrders.ts, which import it back and re-export what they exported, so that a caller that only
 * settles (the card import's proof, proof/links.ts) loads none of the capture validation: importer.ts and savedOrders.ts
 * load the producer kit's validators by computed import, which the gated Mac CLI's closure must not hold
 * (upload-mac-admission-gate.test.mjs). Keep this module free of any computed import, and of importer.ts, capture.ts and
 * savedOrders.ts.
 */
export function audit(db: Database, action: string, subjectRef: string | null, before: unknown, after: unknown, now: string,
  policyDigest = POLICY_DIGEST): void {
  db.prepare(`INSERT INTO amazon_audit(action,subject_ref,before_digest,after_digest,policy_digest,created_at)
    VALUES(?,?,?,?,?,?)`).run(action, subjectRef, before === undefined ? null : digest(before), digest(after), policyDigest, now);
}
/**
 * A tipped order's split subjects (tipSplit.ts, TIP_SPLIT_POLICY), stored next to its total subject from the same order;
 * one it no longer has is rewritten `unproven`. An untipped order stores none, exactly as before. Audited on change, under
 * the split policy's digest.
 */
export function writeSplitSubjects(db: Database, order: OrderObservation, total: MatchSubject, orderRef: string, now: string): void {
  const read = (subjectRef: string) => {
    const text = db.prepare('SELECT data_json FROM amazon_subjects WHERE ref=?').pluck().get(subjectRef) as string | undefined;
    return text ? JSON.parse(text) as MatchSubject : undefined;
  };
  for (const split of storedSplitSubjects(order, total, read)) {
    const old = read(split.ref);
    db.prepare(`INSERT INTO amazon_subjects VALUES(?,?,?,?,?) ON CONFLICT(ref) DO UPDATE SET data_json=excluded.data_json`)
      .run(split.ref, SOURCE, split.evidenceClass, null, JSON.stringify(split));
    db.prepare('INSERT OR IGNORE INTO amazon_event_orders VALUES(?,?)').run(split.ref, orderRef);
    if (!old || digest(old) !== digest(split)) audit(db, 'subject-observation', split.ref, old, split, now, TIP_SPLIT_POLICY_DIGEST);
  }
}
/**
 * Root's guard: money evidence for an order contradicts a no-charge proof. That is any Your Payments ledger row or refund
 * evidence record naming the order (stored or in the incoming capture), a Refund Total in its history, or a card charge
 * linked or matched (a candidate) to one of its subjects. A contradicted proof is a conflict and holds; it never supersedes.
 * These persisted tables only ever add evidence; the live card check below is what must find it.
 */
export function chargeEvidence(db: Database, orderId: string, orderRef: string, staging?: Staging): boolean {
  if (staging && (staging.payments.some(p => p.orderIds.includes(orderId))
    || (staging.refundEvidence ?? []).some(r => r.orderIds.includes(orderId)))) return true;
  return !!db.prepare(`SELECT 1 FROM amazon_observations o WHERE o.family IN ('payment','refund')
      AND EXISTS (SELECT 1 FROM json_each(o.data_json,'$.orderIds') j WHERE j.value=?)
    UNION ALL SELECT 1 FROM amazon_observations o WHERE o.family='order' AND o.order_ref=?
      AND json_extract(o.data_json,'$.refundSummary') IS NOT NULL
    UNION ALL SELECT 1 FROM amazon_event_orders e WHERE e.order_ref=?
      AND (EXISTS (SELECT 1 FROM amazon_matches m WHERE m.subject_ref=e.subject_ref AND m.state='linked')
        OR EXISTS (SELECT 1 FROM amazon_candidates c WHERE c.subject_ref=e.subject_ref))
    LIMIT 1`).get(orderId, orderRef, orderRef);
}
/**
 * Root's live guard: the card evidence the resolver shows right now, not only what the last reconcile persisted (an
 * ordinary card import never reconciles Amazon). It is the matcher's own read-only candidate generation over the current
 * card ledger and active bindings, computed without writing; a linked row is always a candidate, so any candidate is
 * live evidence. An order-total subject's candidates (and those of its split parts, given with it) depend only on those
 * subjects, the ledger and the bindings.
 */
export function liveCardEvidence(db: Database): (subjects: readonly MatchSubject[]) => boolean {
  let ledger: { rows: LedgerRow[]; bindings: Binding[] } | undefined;
  return (subjects) => {
    if (!subjects.length) return false;
    ledger ??= { rows: readLedger(db), bindings: activeBindings(db, readCardInventory(db)) };
    return matchAmazon(subjects, ledger.rows, ledger.bindings).candidates.length > 0;
  };
}
/** The order's displayed (persisted) subjects: what the resolver matches against the card ledger for it. */
export const orderSubjects = (db: Database, orderRef: string): MatchSubject[] => (db.prepare(`SELECT s.data_json FROM amazon_subjects s
  JOIN amazon_event_orders e ON e.subject_ref=s.ref WHERE e.order_ref=? ORDER BY s.ref`).pluck().all(orderRef) as string[])
  .map(text => JSON.parse(text) as MatchSubject);
/** An order displayed without its (contradicted) proof reads as an unread header: no status claim, no total. */
export const withoutProof = ({ chargeFree: _proof, ...order }: OrderObservation): OrderObservation => order;
// STEP 9 integration (B9): the active Fresh list is read in freshImport.ts (activeFreshList), the one-reader rule.
/** STEP 9 integration B9 (Root): a record's Fresh list identity, or undefined when it is not recorded (fail closed). */
function recordedFreshList(fresh: string | null): { active: string | null } | undefined {
  if (fresh === null) return undefined;
  try {
    const value = JSON.parse(fresh) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && 'active' in value) {
      const active = (value as { active: unknown }).active;
      if (active === null || (typeof active === 'string' && active.length > 0)) return { active };
    }
  } catch { /* unreadable: not recorded */ }
  return undefined;
}
/**
 * STEP 9 integration (revocation, Root): whether a displayed proof is contradicted never depends on its predecessor record.
 * Ledger, refund or persisted match evidence for the order, or a card charge the resolver would link or match live to the
 * ORDER's own charge subjects across every retained capture: its native payment events, and the order-total subject of
 * each read that is not a proof, with a tipped read's order part (tipSplit.ts: its charge billed as total minus tip; the
 * tip part is deferred, never a candidate). Never the proof's own order-total subject, which carries no total.
 */
function proofContradicted(db: Database, orderRef: string, orderId: string, history: ReturnType<typeof readOrderHistory>,
  liveCharge: (subjects: readonly MatchSubject[]) => boolean): boolean {
  if (chargeEvidence(db, orderId, orderRef)) return true;
  const proofTotal = opaque('order-total', orderId);
  if (liveCharge(orderSubjects(db, orderRef).filter(s => s.ref !== proofTotal))) return true;
  return history.snapshots.some(s => {
    if (s.order.chargeFree) return false;
    const total = orderTotalSubject(s.order, s.captureDigest, s.version, history.conflict);
    return liveCharge([total, ...tipSplitSubjects(s.order, total)]);
  });
}
/**
 * Root's guard after a proof is displayed, run first by every backed-up Amazon write that reconciles and reports a result
 * (a new or exact-repeat capture import, the reconcile and review commands). STEP 9 integration (Root): a revocation is
 * a card-side event, not a read, so it restores EXACTLY the display the proof displaced, recorded with the proof in
 * amazon_proof_predecessors. A displaced proof is revoked by the same order-level evidence, so it is followed back to the
 * display before it; an order that had no display before its proof gets an unread header, as a contradicted first read
 * is displayed. Whatever contradicts the proof (`proofContradicted`, found without the record) revokes it: the display is
 * restored, its order-total subject re-derived, and the change audited charge-free-revoked. The next real read then
 * advances the display under the ordinary rules. A contradicted proof whose predecessor is not recorded is never guessed:
 * it stays displayed, audited and surfaced as revocation-predecessor-missing.
 */
export function revokeContradictedProofs(db: Database, now: string, liveCharge = liveCardEvidence(db)):
  { revoked: string[]; missing: string[] } {
  const revoked: string[] = [], missing: string[] = [];
  const recorded = hasProofPredecessorSchema(db) ? db.prepare(`SELECT predecessor_digest AS digest,predecessor_json AS json,
    fresh_json AS fresh FROM amazon_proof_predecessors WHERE order_ref=? AND proof_digest=?`) : null;
  const versionOf = db.prepare('SELECT format_version FROM amazon_captures WHERE digest=?').pluck();
  for (const row of db.prepare(`SELECT ref,native_id,latest_digest,data_json FROM amazon_orders
    WHERE json_extract(data_json,'$.chargeFree') IS NOT NULL ORDER BY ref`).all() as
    Array<{ ref: string; native_id: string; latest_digest: string; data_json: string }>) {
    // STEP 9 integration (revocation, Root): detection first, from the order's own evidence; the record only says what returns.
    const history = readOrderHistory(db, row.ref);
    if (!proofContradicted(db, row.ref, row.native_id, history, liveCharge)) continue;
    let proof = { digest: row.latest_digest, json: row.data_json };
    let restored: { order: OrderObservation; capture: string; fresh: string | null } | null = null;
    for (const seen = new Set<string>(); recorded && !seen.has(proof.digest);) {
      seen.add(proof.digest);
      const before = recorded.get(row.ref, proof.digest) as { digest: string | null; json: string | null; fresh: string | null } | undefined;
      if (!before) break;
      if (before.digest === null || before.json === null) {
        restored = { order: withoutProof(JSON.parse(proof.json) as OrderObservation), capture: proof.digest, fresh: before.fresh };
        break;
      }
      const order = JSON.parse(before.json) as OrderObservation;
      if (!order.chargeFree) { restored = { order, capture: before.digest, fresh: before.fresh }; break; }
      proof = { digest: before.digest, json: before.json };
    }
    // STEP 9 integration B9 (Root): the pre-proof Fresh list is part of the display; unrecorded, it fails closed the same way.
    const fresh = restored ? recordedFreshList(restored.fresh) : undefined;
    // STEP 9 integration (B9): a recorded list no longer retained cannot be restored either.
    if (!restored || !fresh || !freshListRestorable(db, fresh.active)) {
      audit(db, 'revocation-predecessor-missing', row.ref, undefined, { captureDigest: row.latest_digest }, now);
      missing.push(row.ref);
      continue;
    }
    const subject = orderTotalSubject(restored.order, restored.capture, versionOf.get(restored.capture) as number, history.conflict);
    db.prepare('UPDATE amazon_orders SET latest_digest=?,data_json=? WHERE ref=?')
      .run(restored.capture, JSON.stringify(restored.order), row.ref);
    audit(db, 'charge-free-revoked', row.ref, JSON.parse(row.data_json), restored.order, now);
    const oldSubject = db.prepare('SELECT data_json FROM amazon_subjects WHERE ref=?').pluck().get(subject.ref) as string | undefined;
    db.prepare(`INSERT INTO amazon_subjects VALUES(?,?,?,?,?) ON CONFLICT(ref) DO UPDATE SET data_json=excluded.data_json`)
      .run(subject.ref, SOURCE, subject.evidenceClass, null, JSON.stringify(subject));
    db.prepare('INSERT OR IGNORE INTO amazon_event_orders VALUES(?,?)').run(subject.ref, row.ref);
    if (!oldSubject || digest(JSON.parse(oldSubject)) !== digest(subject)) audit(db, 'subject-observation', subject.ref,
      oldSubject ? JSON.parse(oldSubject) : undefined, subject, now);
    writeSplitSubjects(db, restored.order, subject, row.ref, now);
    // STEP 9 integration B9 (Root): and exactly the Fresh list active before the proof (none: the order had none).
    // STEP 9 integration (B9): through the Fresh import, which alone writes the Fresh tables.
    const moved = restoreActiveFreshList(db, row.ref, fresh.active);
    if (moved) audit(db, 'charge-free-revoked-fresh-list', row.ref, { listDigest: moved.before }, { listDigest: fresh.active }, now);
    revoked.push(row.ref);
  }
  // STEP 9 integration (revocation)
  return { revoked, missing };
}
/** Inside the caller's backed-up write: destinations and the same-source event projection, audited only on change. */
export function projectRefunds(db: Database, now: string): void {
  const { before, after, events } = projectRefundEvents(db);
  if (before !== after) audit(db, 'refund-events-projected', null, before, { digest: after, events }, now);
}
/** Card rows linked now, each to the orders its linked subject names (sorted, joined): the gate's before and after. */
export function linkedCardRows(db: Database): Map<string, string> {
  const subjects = new Map(readSubjects(db).map(s => [s.ref, s]));
  const rows = new Map<string, string>();
  const results = (db.prepare(`SELECT data_json FROM amazon_matches WHERE state='linked'
    UNION ALL SELECT data_json FROM amazon_ledger_matches WHERE state='linked'`).pluck().all() as string[])
    .map(text => JSON.parse(text) as MatchResult);
  for (const result of results) {
    const orders = [...(subjects.get(result.subjectRef)?.orderRefs ?? [])].sort().join(',');
    rows.set(result.cardTransactionId!, orders);
  }
  return rows;
}
/** The matcher's settled state before a write: the same rechecks every import and reconcile run first. */
export function settleAmazon(db: Database, now: string): void {
  if (!db.inTransaction) throw new HoldrRefusal('amazon settle refused outside a transaction');
  revokeContradictedProofs(db, now);
  projectRefunds(db, now);
  reconcileAmazon(db, now);
}
