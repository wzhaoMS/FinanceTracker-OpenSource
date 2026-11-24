import type { Database } from 'better-sqlite3';
import { uniqueBothWays } from '@finance-tracker/shared';
import { activeBindings, readCardInventory } from './bindings.js';
import { addDays, currency, day, digest, minor, opaque, POLICY, POLICY_DIGEST, LEDGER_POLICY, LEDGER_POLICY_DIGEST, ref, SOURCE,
  TIP_SPLIT_POLICY_DIGEST } from './policy.js';
import type { Binding, Candidate, LedgerRow, MatchResult, MatchSubject, PaymentObservation } from './types.js';
import { orderTotalSubject, readOrderHistory, selectOrderTotalSnapshot } from './allocation.js';
import { amazonDescriptor, tipsDescriptor } from './tipSplit.js';

export function readLedger(db: Database): LedgerRow[] {
  return db.prepare(`SELECT id, card_account_id AS cardAccountId, transaction_date AS transactionDate,
    status,kind,currency,amount_minor AS amountMinor,user_category AS userCategory,
    COALESCE(user_category,issuer_category,'Uncategorized') AS effectiveCategory,description
    FROM card_transactions
    WHERE dismissed_at IS NULL AND removed_at IS NULL AND merged_into_id IS NULL
    ORDER BY id`).all() as LedgerRow[];
}
function evidenced(subject: MatchSubject): boolean {
  if (subject.source !== SOURCE || !ref(subject.ref) || !day(subject.date) || !currency(subject.money.currency)
    || !minor(subject.money.amountMinor) || subject.money.amountMinor === 0 || subject.status !== 'completed') return false;
  if (subject.evidenceClass === 'unique-total-match') {
    // A tipped order's split part (tipSplit.ts): evidenced as its total is, with its part and total named.
    if (subject.split) {
      return subject.provenance === 'order-total-split' && subject.money.amountMinor > 0
        && subject.tenderProof === 'single-card-complete' && subject.orderRefs.length === 1
        && (subject.split.part === 'order' || subject.split.part === 'tip') && ref(subject.split.totalRef);
    }
    return subject.provenance === 'order-total' && subject.money.amountMinor > 0
      && subject.tenderProof === 'single-card-complete' && subject.orderRefs.length === 1;
  }
  if (subject.evidenceClass === 'payment-ledger-complete') {
    return Boolean(subject.ledgerObservation?.runId) && subject.nativeOccurrenceId === null && subject.orderRefs.length > 0
      && (subject.money.amountMinor > 0 ? subject.provenance === 'ledger-Charged' : subject.provenance === 'ledger-Refunded');
  }
  return subject.evidenceClass === 'payment-event' && typeof subject.nativeOccurrenceId === 'string'
    && subject.nativeOccurrenceId.length > 0 && subject.nativeOccurrenceId.length <= 200
    && (subject.money.amountMinor > 0 ? subject.provenance === 'ledger-Charged' : subject.provenance === 'ledger-Refunded');
}
export function matchAmazon(subjects: readonly MatchSubject[], rows: readonly LedgerRow[], bindings: readonly Binding[]): {
  candidates: Candidate[]; results: MatchResult[];
} {
  const candidates: Candidate[] = [];
  const prelim = new Map<string, MatchResult['reason']>();
  // Non-tip subjects whose candidates TIP_SPLIT_POLICY's class rule narrowed: a tips-class row they would have had.
  const narrowed = new Set<string>();
  // Duplicate native identities are conflicting observations, not separate settled events.
  const occurrences = new Map<string, number>();
  for (const s of subjects) if (s.evidenceClass === 'payment-event' && s.nativeOccurrenceId) {
    occurrences.set(s.nativeOccurrenceId, (occurrences.get(s.nativeOccurrenceId) ?? 0) + 1);
  }
  const observationProofs = new Map<string, Set<string>>();
  for (const s of subjects) if (s.ledgerObservation?.runId) {
    const o = s.ledgerObservation, key = `${o.runId}:${o.page}:${o.ordinal}`;
    const proofs = observationProofs.get(key) ?? new Set<string>();
    proofs.add(o.evidenceDigest ?? digest([s.date, s.money, s.method, s.orderRefs, s.provenance, s.status]));
    observationProofs.set(key, proofs);
  }
  for (const subject of subjects) {
    // A split part is judged below: its order part after every other subject; its tip part is deferred (never matched).
    if (subject.split) continue;
    const observation = subject.ledgerObservation;
    if (observation?.runId && observationProofs.get(`${observation.runId}:${observation.page}:${observation.ordinal}`)!.size > 1) {
      prelim.set(subject.ref, 'evidence-held'); continue;
    }
    if (subject.evidenceHoldReason) {
      prelim.set(subject.ref, subject.evidenceHoldReason);
      if (subject.evidenceHoldReason !== 'multiple-orders') continue;
    }
    if (!evidenced(subject) || (subject.nativeOccurrenceId && (occurrences.get(subject.nativeOccurrenceId) ?? 0) > 1)) {
      prelim.set(subject.ref, 'evidence-held'); continue;
    }
    const bound = bindings.filter(b => subject.method.kind === 'card' && b.network === subject.method.network
      && b.last4 === subject.method.last4);
    if (bound.length !== 1) { prelim.set(subject.ref, 'binding-held'); continue; }
    const ledger = subject.evidenceClass === 'payment-ledger-complete';
    const from = ledger ? addDays(subject.date, -LEDGER_POLICY.daysBefore) : subject.date;
    const through = addDays(subject.date, ledger ? LEDGER_POLICY.daysAfter : subject.evidenceClass === 'payment-event'
      ? POLICY.eventSettlementDays : POLICY.totalSettlementDays);
    for (const row of rows) {
      if (row.cardAccountId !== bound[0].cardAccountId || row.status !== 'posted'
        || row.kind !== (subject.money.amountMinor > 0 ? 'purchase' : 'refund')
        || row.currency !== subject.money.currency || !minor(row.amountMinor)
        || row.amountMinor !== subject.money.amountMinor || !day(row.transactionDate)
        || row.transactionDate < from || row.transactionDate > through) continue;
      // A tips-class row is never a non-tip subject's candidate (TIP_SPLIT_POLICY's class rule, Root 05:52/05:55Z).
      if (tipsDescriptor(row.description)) { narrowed.add(subject.ref); continue; }
      candidates.push({ subjectRef: subject.ref, cardTransactionId: row.id, evidenceClass: subject.evidenceClass });
    }
  }
  // Fresh driver tips billed separately (tipSplit.ts, TIP_SPLIT_POLICY): a tipped order's two split parts. Both must agree
  // with their total subject (same order, date, card and currency; order part + tip part = total, to the cent). The order
  // part is considered only where that total is evidenced and nothing else explains the order's charge: no other subject
  // of the order found a candidate (its total, a native payment event, a payments-ledger row) and no payments-ledger
  // subject names it, except the tip's own ledger charge (amendment, Root 2026-11-23): a completed `Charged` row naming
  // that order alone, of exactly its proven tip. A held total holds it for its own reason. It is then a subject like every
  // other, decided below by the same global degree-one rule. The tip part is stored deferred (Root 06:36Z): never a
  // candidate, contest or link.
  const subjectsByRef = new Map(subjects.map(s => [s.ref, s]));
  const explained = new Set(candidates.flatMap(c => subjectsByRef.get(c.subjectRef)!.orderRefs));
  const ledgerSubjects = subjects.filter(s => s.evidenceClass === 'payment-ledger-complete');
  const splitParts = new Map<string, MatchSubject[]>();
  for (const s of subjects) if (s.split) splitParts.set(s.split.totalRef, [...(splitParts.get(s.split.totalRef) ?? []), s]);
  for (const subject of subjects) if (subject.split?.part === 'order') {
    const total = subjectsByRef.get(subject.split.totalRef), parts = splitParts.get(subject.split.totalRef)!;
    const part = (name: 'order' | 'tip') => parts.filter(p => p.split!.part === name);
    const agrees = total !== undefined && !total.split && total.evidenceClass === 'unique-total-match'
      && part('order').length === 1 && part('tip').length === 1
      && parts.every(p => evidenced(p) && p.date === total.date && p.money.currency === total.money.currency
        && digest(p.method) === digest(total.method) && digest(p.orderRefs) === digest(total.orderRefs))
      && part('order')[0].money.amountMinor + part('tip')[0].money.amountMinor === total.money.amountMinor;
    if (!agrees) { prelim.set(subject.ref, 'evidence-held'); continue; }
    // A part is held as its total is (binding-held, evidence-held); superseded where other evidence explains the charge.
    const totalHeld = prelim.get(total.ref);
    if (totalHeld) { prelim.set(subject.ref, totalHeld); continue; }
    const tip = part('tip')[0];
    const tipCharge = (s: MatchSubject) => s.provenance === 'ledger-Charged' && s.status === 'completed' && s.orderRefs.length === 1
      && s.money.currency === tip.money.currency && s.money.amountMinor === tip.money.amountMinor;
    if (total.orderRefs.some(order => explained.has(order)
      || ledgerSubjects.some(s => s.orderRefs.includes(order) && !tipCharge(s)))) {
      prelim.set(subject.ref, 'superseded'); continue;
    }
    const bound = bindings.filter(b => subject.method.kind === 'card' && b.network === subject.method.network
      && b.last4 === subject.method.last4);
    if (bound.length !== 1) { prelim.set(subject.ref, 'binding-held'); continue; }
    const through = addDays(subject.date, POLICY.totalSettlementDays);
    for (const row of rows) {
      if (row.cardAccountId !== bound[0].cardAccountId || row.status !== 'posted' || row.kind !== 'purchase'
        || row.currency !== subject.money.currency || !minor(row.amountMinor) || row.amountMinor !== subject.money.amountMinor
        || !day(row.transactionDate) || row.transactionDate < subject.date || row.transactionDate > through
        || !amazonDescriptor(row.description) || tipsDescriptor(row.description)) continue;
      candidates.push({ subjectRef: subject.ref, cardTransactionId: row.id, evidenceClass: subject.evidenceClass });
    }
  }
  const hitsBySubject = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const hits = hitsBySubject.get(c.subjectRef) ?? [];
    hits.push(c); hitsBySubject.set(c.subjectRef, hits);
  }
  const aliases = new Map<string, { ref: string; reason: 'corroborated' | 'superseded' }>();
  const ledgerByRow = new Map<string, MatchSubject[]>();
  for (const subject of subjects) if (subject.evidenceClass === 'payment-ledger-complete' && !prelim.has(subject.ref)) {
    const hits = hitsBySubject.get(subject.ref) ?? [];
    if (hits.length !== 1) continue;
    const bucket = ledgerByRow.get(hits[0].cardTransactionId) ?? [];
    bucket.push(subject); ledgerByRow.set(hits[0].cardTransactionId, bucket);
  }
  for (const bucket of ledgerByRow.values()) {
    if (bucket.length < 2) continue;
    const signature = (s: MatchSubject) => s.ledgerObservation?.evidenceDigest
      ?? digest([s.source, s.provenance, s.status, s.date, s.money, s.method, s.orderRefs]);
    const same = bucket.every(s => signature(s) === signature(bucket[0]));
    const perRun = new Map<string, Set<string>>();
    for (const s of bucket) {
      const o = s.ledgerObservation!;
      const run = o.runId ?? `unknown:${s.ref}`;
      const occurrences = perRun.get(run) ?? new Set<string>();
      occurrences.add(`${o.page}:${o.ordinal}`); perRun.set(run, occurrences);
    }
    if (!same || bucket.some(s => !s.ledgerObservation?.runId) || [...perRun.values()].some(set => set.size > 1)) continue;
    // Only an independently unique card row anchors corroboration; this is not Amazon event identity.
    for (const s of bucket.slice(1)) aliases.set(s.ref, { ref: bucket[0].ref, reason: 'corroborated' });
  }
  const legacy = candidates.filter(c => c.evidenceClass !== 'payment-ledger-complete');
  const legacyByRow = new Map<string, Candidate[]>();
  for (const c of legacy) {
    const claims = legacyByRow.get(c.cardTransactionId) ?? [];
    claims.push(c); legacyByRow.set(c.cardTransactionId, claims);
  }
  for (const subject of subjects) if (subject.evidenceClass === 'payment-ledger-complete' && !aliases.has(subject.ref)) {
    const hits = hitsBySubject.get(subject.ref) ?? [];
    if (hits.length !== 1) continue;
    const rowClaims = legacyByRow.get(hits[0].cardTransactionId) ?? [];
    if (rowClaims.length !== 1 || rowClaims[0].evidenceClass !== 'unique-total-match') continue;
    const total = subjectsByRef.get(rowClaims[0].subjectRef)!;
    if (hitsBySubject.get(total.ref)?.length === 1 && total.orderRefs.length === 1
      && subject.orderRefs.length === 1 && total.orderRefs[0] === subject.orderRefs[0]) {
      aliases.set(subject.ref, { ref: total.ref, reason: 'superseded' });
    }
  }
  // The one-to-one rule (the shared uniqueBothWays), over the unaliased candidates: a subject links only to its one
  // candidate row, and only when no other subject claims that row.
  const oneToOne = uniqueBothWays(candidates.filter(c => !aliases.has(c.subjectRef))
    .map(c => ({ subject: c.subjectRef, row: c.cardTransactionId })));
  // A tip part is stored deferred (TIP_SPLIT_POLICY, Root 06:36Z): its amount, date and card are kept for a later policy,
  // but it is never a candidate, never contests a row and never links. Its own result says so, and nothing else.
  const deferred = (subject: MatchSubject): MatchResult => ({ subjectRef: subject.ref, state: 'held', reason: 'deferred',
    candidateCount: 0, cardTransactionId: null, evidenceClass: subject.evidenceClass, policyDigest: TIP_SPLIT_POLICY_DIGEST });
  const results: MatchResult[] = subjects.map(subject => {
    if (subject.split?.part === 'tip') return deferred(subject);
    const hits = hitsBySubject.get(subject.ref) ?? [];
    const alias = aliases.get(subject.ref);
    const unique = !alias && !prelim.has(subject.ref) && oneToOne.linked(subject.ref) !== null;
    return { subjectRef: subject.ref, state: unique ? 'linked' : 'held',
      reason: prelim.get(subject.ref) ?? alias?.reason ?? (unique ? 'unique' : hits.length ? 'ambiguous' : 'no-candidate'),
      candidateCount: hits.length, cardTransactionId: unique ? hits[0].cardTransactionId : null,
      evidenceClass: subject.evidenceClass, ...(alias ? { corroboratedBy: alias.ref } : {}),
      ...(subject.evidenceClass === 'payment-ledger-complete' ? { policyDigest: LEDGER_POLICY_DIGEST }
        : subject.split ? { policyDigest: TIP_SPLIT_POLICY_DIGEST } : {}),
      ...(narrowed.has(subject.ref) ? { tipRowsExcludedBy: TIP_SPLIT_POLICY_DIGEST } : {}) } satisfies MatchResult;
  });
  const linkedLedgerOrders = new Map<string, Set<string>>();
  for (const result of results) if (result.state === 'linked' && result.evidenceClass === 'payment-ledger-complete') {
    const subject = subjectsByRef.get(result.subjectRef)!;
    if (subject.provenance !== 'ledger-Charged') continue;
    for (const orderRef of subject.orderRefs) {
      const rows = linkedLedgerOrders.get(orderRef) ?? new Set<string>();
      rows.add(result.cardTransactionId!); linkedLedgerOrders.set(orderRef, rows);
    }
  }
  for (const result of results) if (result.state === 'linked' && result.evidenceClass === 'unique-total-match') {
    const subject = subjectsByRef.get(result.subjectRef)!;
    if (subject.orderRefs.some(orderRef => [...(linkedLedgerOrders.get(orderRef) ?? [])]
      .some(id => id !== result.cardTransactionId))) {
      result.state = 'held'; result.reason = 'ambiguous'; result.cardTransactionId = null;
      result.policyDigest = LEDGER_POLICY_DIGEST;
    }
  }
  return { candidates, results };
}
export function readSubjects(db: Database): MatchSubject[] {
  const subjects = (db.prepare('SELECT data_json FROM amazon_subjects ORDER BY ref').pluck().all() as string[])
    .map(text => {
      const subject = JSON.parse(text) as MatchSubject;
      if (subject.evidenceClass !== 'unique-total-match' || subject.provenance !== 'order-total'
        || subject.orderRefs.length !== 1) return subject;
      const history = readOrderHistory(db, subject.orderRefs[0]);
      const selected = selectOrderTotalSnapshot(history.snapshots, history.displayed);
      if (!selected) return subject;
      const derived = orderTotalSubject(selected.order, selected.captureDigest, selected.version, history.conflict);
      const agrees = digest([subject.date, subject.money, subject.method]) === digest([derived.date, derived.money, derived.method]);
      return { ...subject, allocations: agrees ? derived.allocations : [], allocationComplete: agrees && derived.allocationComplete,
        allocationHoldReason: agrees ? derived.allocationHoldReason : 'inconsistent-evidence' };
    });
  const runs = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='amazon_capture_runs'").get()
    ? new Map((db.prepare('SELECT capture_digest,run_id FROM amazon_capture_runs').all() as
      Array<{ capture_digest: string; run_id: string }>).map(r => [r.capture_digest, r.run_id])) : new Map<string, string>();
  const observations = db.prepare(`SELECT o.ref,o.capture_digest,o.data_json FROM amazon_observations o
    JOIN amazon_captures c ON c.digest=o.capture_digest
    WHERE c.format_version=3 AND o.family IN ('payment','refund') ORDER BY c.rowid,o.ordinal,o.ref`).all() as
      Array<{ ref: string; capture_digest: string; data_json: string }>;
  for (const o of observations) {
    const p = JSON.parse(o.data_json) as PaymentObservation;
    if (!p.provenance || p.provenance.source !== 'ledger') continue;
    subjects.push({
      ref: o.ref, source: SOURCE, evidenceClass: 'payment-ledger-complete', nativeOccurrenceId: null,
      provenance: p.provenance.status === 'Charged' ? 'ledger-Charged'
        : p.provenance.status === 'Refunded' ? 'ledger-Refunded' : 'unproven',
      status: p.status, date: p.date,
      // A ledger credit's direction is explicit in its validated displayed status, not its display sign.
      money: { currency: p.money.currency, amountMinor: p.kind === 'refund' ? -Math.abs(p.money.amountMinor)
        : p.kind === 'charge' ? Math.abs(p.money.amountMinor) : p.money.amountMinor },
      method: p.method, orderRefs: p.orderIds.map(id => opaque('order', id)), tenderProof: 'unknown',
      allocations: [], allocationComplete: false,
      ledgerObservation: { captureDigest: o.capture_digest, runId: runs.get(o.capture_digest) ?? null,
        page: p.provenance.page, ordinal: p.provenance.ordinal,
        evidenceDigest: digest([p.date, p.money, p.kind, p.status, p.method, [...p.orderIds].sort(), p.identity, p.provenance.source, p.provenance.status]) },
      ...(p.orderIds.length !== 1 ? { evidenceHoldReason: 'multiple-orders' as const }
        : p.identity === 'ambiguous-repeat' ? { evidenceHoldReason: 'evidence-held' as const } : {}),
    });
  }
  return subjects;
}
/** Caller owns the backed-up transaction. Always recompute against the entire ledger, never the UI's filtered set. */
export function reconcileAmazon(db: Database, now: string): { newMatches: number; invalidated: number; held: number } {
  const before = new Map((db.prepare(`SELECT subject_ref,data_json FROM amazon_matches
    UNION ALL SELECT subject_ref,data_json FROM amazon_ledger_matches`).all() as
    Array<{ subject_ref: string; data_json: string }>).map(r => [r.subject_ref, JSON.parse(r.data_json) as MatchResult]));
  const { candidates, results } = matchAmazon(readSubjects(db), readLedger(db), activeBindings(db, readCardInventory(db)));
  let newMatches = 0, invalidated = 0;
  db.prepare('DELETE FROM amazon_candidates').run();
  db.prepare('DELETE FROM amazon_matches').run();
  db.prepare('DELETE FROM amazon_ledger_candidates').run();
  db.prepare('DELETE FROM amazon_ledger_matches').run();
  for (const c of candidates) db.prepare(`INSERT INTO ${c.evidenceClass === 'payment-ledger-complete'
    ? 'amazon_ledger_candidates' : 'amazon_candidates'} VALUES(?,?,?)`)
    .run(c.subjectRef, c.cardTransactionId, c.evidenceClass);
  for (const result of results) {
    const old = before.get(result.subjectRef);
    if (digest(old ?? null) !== digest(result)) {
      if (result.state === 'linked' && (old?.state !== 'linked' || old.cardTransactionId !== result.cardTransactionId)) newMatches++;
      if (old?.state === 'linked' && (result.state !== 'linked' || old.cardTransactionId !== result.cardTransactionId)) invalidated++;
      db.prepare(`INSERT INTO amazon_audit(action,subject_ref,before_digest,after_digest,policy_digest,created_at)
        VALUES('reconcile',?,?,?,?,?)`).run(result.subjectRef, old ? digest(old) : null, digest(result),
          result.tipRowsExcludedBy ?? result.policyDigest ?? POLICY_DIGEST, now);
    }
    db.prepare(`INSERT INTO ${result.evidenceClass === 'payment-ledger-complete' ? 'amazon_ledger_matches' : 'amazon_matches'} VALUES(?,?,?,?)`)
      .run(result.subjectRef, result.state, result.cardTransactionId, JSON.stringify(result));
  }
  return { newMatches, invalidated, held: results.filter(r => r.state === 'held'
    && !['corroborated', 'superseded'].includes(r.reason)).length };
}
