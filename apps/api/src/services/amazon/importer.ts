import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { HoldrRefusal, toValueFreeDbError } from '../dbErrors.js';
import { orderObservationScope, validateCapture, type ValidatedCapture } from './capture.js';
import { digest, opaque, SOURCE } from './policy.js';
// STEP 9 integration (revocation)
import { ensureAmazonSchema, hasAmazonSchema } from './schema.js';
import { reconcileAmazon } from './matcher.js';
import { readCardInventory, validateApproval, validateProposal } from './bindings.js';
import type { BindingProposal, Method, Money, OrderObservation, RootApproval, Staging } from './types.js';
import { emptyOrderDetails, orderTotalSubject, readOrderHistory, SCOPE_HOLD_REASONS } from './allocation.js';
import { REFUND_EVIDENCE_ORDINAL_BASE, regressedRefundOrders } from './refundEvents.js';
import { carryOwnerTaxonomy, displayedLinePairs, planItemCategories, type TaxonomyCarry } from './ownerDecisions.js';
// Keyless holds (Root, after STEP 9): owner line decisions move with their lines.
import { moveLineTaxonomies, type LineTaxonomyMove } from './lineTaxonomy.js';
// STEP 9 integration B9 (Root): a proof's record also holds the order's active Fresh list, read and restored by the Fresh import.
import { activeFreshList, writeFreshLists, type FreshSection } from './freshImport.js';
import { recordOrderChannel } from './orderChannels.js';
// The settle and its rechecks live in settle.ts, which holds no capture validation; re-exported for this module's callers.
import { audit, chargeEvidence, liveCardEvidence, orderSubjects, projectRefunds, revokeContradictedProofs, withoutProof, writeSplitSubjects } from './settle.js';
export { audit, chargeEvidence, liveCardEvidence, projectRefunds, revokeContradictedProofs } from './settle.js';

export interface ImportReceipt {
  captureDigest: string;
  newCaptures: number;
  newOrders: number;
  newObservations: number;
  newMatches: number;
  invalidated: number;
  held: number;
  holds: Array<{ reason: string; count: number }>;
  coverage: Staging['coverage'];
}
const sameMoney = (a: Money | null | undefined, b: Money | null | undefined) =>
  !!a && !!b && a.currency === b.currency && a.amountMinor === b.amountMinor;
const sameMethod = (a: Method, b: Method) => a.kind === b.kind && a.network === b.network && a.last4 === b.last4;
/**
 * How a later observation relates to the displayed one, fact by fact and matched by identity: the header total and
 * date; every summary component by kind and amount; every payment instrument; every line by the later line it pairs with
 * (its ordinal, or its identity when the lines are only reordered; below), with each
 * attribute the displayed one knows (ASIN, title, quantity, price); the Refund Total; a known tender coverage; and each
 * completeness proof. Only a superset may replace the displayed order. A missing fact makes the later one poorer and a
 * differing value makes it a conflict; either way it is history only. A count never stands in for an identity. The
 * display-only image ID and read diagnostics (unknown line, method or summary, conflict flags) are not facts. The Refund
 * Total is the one fact that may progress: a later, larger one is an update, never a conflict; a smaller one conflicts.
 * Two facts from outside the order (#168) also decide: a later read that takes back a refund or return status
 * (`statusRegressed`, from the events rebuilt in memory from every retained observation) is a conflict; and a superset
 * that cannot carry every displayed line's category (`categoriesUnmatched`, planItemCategories) keeps the display: a conflict.
 * A summary never proven complete is not a set of facts a proven one must repeat (Root, 2026-11-22): when the later read
 * proves its summary complete and the displayed read never did, the later summary replaces the displayed one, and only
 * the displayed grand total still compares; the header total, date, payment methods and every line still must match or
 * be added to.
 * Line order is not a fact (Root, 2026-11-23): each displayed line compares with the later line it pairs with
 * (displayedLinePairs), the one at its ordinal, or, when the later read proves its items complete and its lines are the
 * displayed ones one-to-one by identity (a unique ASIN, else a unique exact title), the one of its identity. Every
 * attribute known on both sides must still be equal, a quantity known only to the later read fills in, and anything else
 * stays a conflict.
 */
export function compareObservation(next: OrderObservation, shown: OrderObservation,
  outside: { statusRegressed?: boolean; categoriesUnmatched?: boolean } = {}): 'superset' | 'poorer' | 'conflict' {
  let poorer = false, conflict = false;
  // refund progression (order-history v3): refunds only accumulate, so a later Refund Total at least the displayed one, in
  // the same currency, keeps that fact and updates it (never a conflict). A smaller one, or another currency, still
  // differs below (a conflict); a missing one is poorer. Every other fact compares to the displayed order as before. A
  // refund or return status taken back makes the read a conflict whatever its facts.
  if (outside.statusRegressed) conflict = true;
  const refund = next.refundSummary, displayedRefund = shown.refundSummary;
  if (refund && displayedRefund && refund.currency === displayedRefund.currency && refund.amountMinor > displayedRefund.amountMinor) {
    shown = { ...shown, refundSummary: refund };
  }
  // A fact the displayed order knows: absent later is poorer (or a conflict when the later read proves its set whole).
  const fact = (present: boolean, equal: boolean, proven = false) => {
    if (!present) { if (proven) conflict = true; else poorer = true; } else if (!equal) conflict = true;
  };
  if (shown.total !== null) fact(next.total !== null, sameMoney(next.total, shown.total));
  fact(true, next.date === shown.date);
  const summaryReplaced = !!next.tenderProof?.summaryComplete && !shown.tenderProof?.summaryComplete;
  for (const row of shown.summary ?? []) {
    if (summaryReplaced && row.kind !== 'grand-total') continue;
    const other = (next.summary ?? []).find(r => r.kind === row.kind);
    fact(!!other, !!other && sameMoney(other.money, row.money), !!next.tenderProof?.summaryComplete);
  }
  const methods = [...(next.paymentMethods ?? [])];
  for (const method of shown.paymentMethods ?? []) {
    const index = methods.findIndex(m => sameMethod(m, method));
    fact(index >= 0, true, !!next.tenderProof?.methodComplete);
    if (index >= 0) methods.splice(index, 1);
  }
  const pairs = displayedLinePairs(next, shown.items);
  for (const [index, item] of shown.items.entries()) {
    const other = pairs.get(index);
    fact(!!other, true, !!next.itemProof?.complete);
    if (!other) continue;
    fact(true, other.title === item.title);
    if (item.itemId !== null) fact(other.itemId !== null, other.itemId === item.itemId);
    if (item.quantity !== null) fact(other.quantity !== null, other.quantity === item.quantity);
    if (item.unitPrice !== null) fact(other.unitPrice !== null, sameMoney(other.unitPrice, item.unitPrice));
  }
  if (shown.refundSummary) fact(!!next.refundSummary, sameMoney(next.refundSummary, shown.refundSummary));
  // charge-free proof (#158): a displayed cancelled-never-charged status is a fact a later read must also prove.
  if (shown.chargeFree) fact(!!next.chargeFree, true);
  if (shown.tenderCoverage && shown.tenderCoverage !== 'unknown') {
    fact(!!next.tenderCoverage && next.tenderCoverage !== 'unknown', next.tenderCoverage === shown.tenderCoverage);
  }
  for (const [was, now] of [[shown.itemProof?.complete, next.itemProof?.complete],
    [shown.tenderProof?.methodComplete, next.tenderProof?.methodComplete],
    [shown.tenderProof?.summaryComplete, next.tenderProof?.summaryComplete]]) if (was) fact(!!now, true);
  // owner decisions (#168): a superset that cannot carry every displayed line's category keeps the display.
  if (!conflict && !poorer && outside.categoriesUnmatched) conflict = true;
  return conflict ? 'conflict' : poorer ? 'poorer' : 'superset';
}
/** Whether a later observation is a per-fact superset of the displayed one, so it may replace it (compareObservation). */
export function provesAtLeast(next: OrderObservation, shown: OrderObservation): boolean {
  return compareObservation(next, shown) === 'superset';
}
// charge-free proof (#158) hooks begin.
/**
 * The displayed-order rule of an import: a witnessed header-only read never displaces details, and otherwise only a
 * per-fact superset replaces the displayed order (compareObservation). STEP 9 integration (#158 x #168): `outside` carries
 * #168's facts from outside the order into compareObservation; an import passes its own. A revocation never re-decides a
 * read (Root): it restores the display its proof displaced (revokeContradictedProofs).
 */
export function displayDecision(next: OrderObservation, headerOnlyScope: boolean, shown: OrderObservation | null,
  outside: { statusRegressed?: boolean; categoriesUnmatched?: boolean } = {}):
  { headerOnly: boolean; relation: 'superset' | 'poorer' | 'conflict'; kept: boolean } {
  const headerOnly = headerOnlyScope && !!shown && !emptyOrderDetails(shown);
  const relation = shown ? compareObservation(next, shown, outside) : 'superset';
  return { headerOnly, relation, kept: headerOnly || relation !== 'superset' };
}
// STEP 9 integration (revocation)
/** STEP 9 integration (#161 x #168): writes the owner taxonomy assignments a replacement carries, each audited. */
const carryTaxonomy = (db: Database, carries: readonly TaxonomyCarry[], now: string) => {
  for (const carry of carries) {
    if (carryOwnerTaxonomy(db, carry)) audit(db, 'taxonomy-owner-carried', null,
      { productKey: carry.from, node: carry.node }, { productKey: carry.to, node: carry.node }, now);
  }
};
/** Keyless holds (Root, after STEP 9): moves the owner line decisions a replacement takes with their lines, each audited. */
const carryLineDecisions = (db: Database, moves: readonly LineTaxonomyMove[], now: string) => {
  moveLineTaxonomies(db, moves);
  for (const move of moves) audit(db, 'taxonomy-line-owner-carried', null, { lineIdentity: move.from.identity, node: move.node },
    { lineIdentity: move.to.identity, node: move.node }, now);
};
/** A receipt's sorted hold counts with `count` more of `reason`. */
const withHold = (holds: ImportReceipt['holds'], reason: string, count: number): ImportReceipt['holds'] => {
  const merged = new Map(holds.map(h => [h.reason, h.count]));
  merged.set(reason, (merged.get(reason) ?? 0) + count);
  return [...merged].sort(([a], [b]) => a.localeCompare(b)).map(([reason, count]) => ({ reason, count }));
};
// charge-free proof (#158) hooks end.
/** Backups are complete SQLite snapshots, not a copy of the main file that omits its WAL. */
export async function backedUpWrite<T>(db: Database, backupPath: string, write: () => T,
  installSchema: (db: Database) => void = ensureAmazonSchema): Promise<T> {
  const canonical = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  const source = canonical(db.name), target = canonical(backupPath);
  if (db.inTransaction || !path.isAbsolute(backupPath)
    || [source, `${source}-wal`, `${source}-shm`, `${source}-journal`].includes(target)) {
    throw new HoldrRefusal('amazon backup refused');
  }
  try {
    const fd = fs.openSync(backupPath, 'wx', 0o600);
    fs.closeSync(fd);
    await db.backup(backupPath);
    fs.chmodSync(backupPath, 0o600);
    return db.transaction(() => {
      installSchema(db);
      return write();
    }).immediate();
  } catch (error) {
    // Retain the pre-write backup on failure; the command reports failure, never a usable-backup receipt.
    throw toValueFreeDbError('amazon backed up write', error);
  }
}
function writeCapture(db: Database, staging: Staging, structure: unknown, captureDigest: string, now: string,
  fresh?: FreshSection): ImportReceipt {
  const existing = db.prepare('SELECT receipt_json FROM amazon_captures WHERE digest=?').pluck().get(captureDigest) as string | undefined;
  if (existing) {
    for (const [ordinal, order] of staging.orders.entries()) {
      const scope = orderObservationScope(structure, order, ordinal);
      const reason = scope === 'legacy' ? null : SCOPE_HOLD_REASONS[scope];
      if (!reason) continue;
      const observationRef = opaque('observation', [captureDigest, 'order', ordinal]);
      const before = db.prepare('SELECT hold_reason FROM amazon_observations WHERE ref=?').pluck().get(observationRef);
      if (typeof before === 'string' && before !== reason) {
        db.prepare('UPDATE amazon_observations SET hold_reason=? WHERE ref=?').run(reason, observationRef);
        audit(db, 'order-observation-scope', observationRef, before, reason, now);
      }
    }
    if (staging.version === 3 && staging.runId) {
      const changed = db.prepare('INSERT OR IGNORE INTO amazon_capture_runs VALUES(?,?,?)')
        .run(captureDigest, staging.runId, staging.mode ?? 'recent').changes;
      if (changed) audit(db, 'capture-run-observed', null, undefined, { captureDigest, runDigest: digest(staging.runId) }, now);
    }
    // charge-free proof (#158): an exact repeat records nothing new but runs the same recheck; its receipt keeps zero new
    // records and adds this run's contradictions to the stored holds.
    // STEP 9 integration (revocation)
    const proofs = revokeContradictedProofs(db, now);
    projectRefunds(db, now);
    const result = reconcileAmazon(db, now);
    const old = JSON.parse(existing) as ImportReceipt;
    let holds = old.holds ?? [];
    if (proofs.revoked.length) holds = withHold(holds, 'charge-free-contradicted', proofs.revoked.length);
    if (proofs.missing.length) holds = withHold(holds, 'revocation-predecessor-missing', proofs.missing.length);
    return { ...old, newCaptures: 0, newOrders: 0, newObservations: 0, ...result,
      ...(proofs.revoked.length || proofs.missing.length ? { holds } : {}) };
  }
  db.prepare('INSERT OR IGNORE INTO amazon_sources VALUES(?)').run(SOURCE);
  const receipt: ImportReceipt = { captureDigest, newCaptures: 1, newOrders: 0, newObservations: 0,
    newMatches: 0, invalidated: 0, held: 0, holds: [], coverage: staging.coverage };
  const holds = new Map<string, number>();
  const hold = (reason: string) => holds.set(reason, (holds.get(reason) ?? 0) + 1);
  // charge-free proof (#158): every contradiction is audited and surfaced once per order in the receipt's holds.
  const contradictedOrders = new Set<string>();
  const surface = (orderRef: string) => {
    if (!contradictedOrders.has(orderRef)) { contradictedOrders.add(orderRef); hold('charge-free-contradicted'); }
  };
  const liveCharge = liveCardEvidence(db);
  db.prepare('INSERT INTO amazon_captures VALUES(?,?,?,?,?,?,?,?,?)').run(captureDigest, SOURCE, staging.version,
    staging.window.from, staging.window.through, JSON.stringify(staging.coverage), JSON.stringify(staging.resume), now, '{}');
  if (staging.version === 3 && staging.runId) {
    db.prepare('INSERT INTO amazon_capture_runs VALUES(?,?,?)').run(captureDigest, staging.runId, staging.mode ?? 'recent');
  }
  let itemOrdinal = 0;
  const observation = (family: string, ordinal: number, orderRef: string | null, reason: string, value: unknown) => {
    db.prepare('INSERT INTO amazon_observations VALUES(?,?,?,?,?,?,?)')
      .run(opaque('observation', [captureDigest, family, ordinal]), captureDigest, family, ordinal, orderRef, reason, JSON.stringify(value));
    receipt.newObservations++;
    hold(reason);
  };
  // refund progression (order-history v3): statuses each event already reached, rebuilt in memory from every retained
  // observation before this capture's own join them, never read from a projection an earlier policy wrote.
  const regressedOrders = regressedRefundOrders(db, staging.refundEvidence ?? []);
  for (const [ordinal, order] of staging.orders.entries()) {
    const orderRef = opaque('order', order.orderId);
    const stored = db.prepare(`SELECT o.data_json,o.latest_digest,c.format_version FROM amazon_orders o
      JOIN amazon_captures c ON c.digest=o.latest_digest WHERE o.ref=?`).get(orderRef) as
      { data_json: string; latest_digest: string; format_version: number } | undefined;
    const previous = stored?.data_json;
    if (!previous) receipt.newOrders++;
    const scope = orderObservationScope(structure, order, ordinal);
    // refund progression (order-history v3): the display decision consults the events, rebuilt from every retained
    // observation, so a read that takes back a refund or return status its event already reached is a conflict, never a
    // progression. Owner decisions (#168): a replacement must carry every displayed line's category to its identity-matched
    // line, or it keeps the display.
    const statusRegressed = regressedOrders.has(order.orderId);
    const categories = stored ? planItemCategories(db, orderRef, stored.latest_digest, order, captureDigest) : null;
    // A later observation replaces the displayed order only as a per-fact superset (compareObservation). A poorer or
    // conflicting one (witnessed header-only, charge-free, a partial re-read, a differing value) is history only: it never
    // displaces the order already displayed, its item set or its Refund Total, nor the observation its subject comes from.
    const shown = stored ? JSON.parse(stored.data_json) as OrderObservation : null;
    // charge-free proof (#158): an uncontradicted positive no-charge proof is the single status-change exception. It
    // bypasses compareObservation and replaces the displayed order (counting 0, with no card match); earlier observations
    // and item rows stay history. Contradicted by money evidence (Root's guard, including card charges the resolver
    // links or matches live to the displayed order right now), it is a conflict and holds: it never supersedes, it is
    // surfaced, and an order seen for the first time is displayed without the proof.
    const proof = !!order.chargeFree;
    const contradicted = proof && (chargeEvidence(db, order.orderId, orderRef, staging)
      || liveCharge(orderSubjects(db, orderRef)));
    const chargeFree = proof && !contradicted;
    if (contradicted) {
      audit(db, 'charge-free-contradicted', orderRef, undefined, { captureDigest }, now);
      surface(orderRef);
    }
    // STEP 9 integration (#158 x #168): the shared display rule also weighs #168's facts from outside the order.
    const { headerOnly, relation, kept } = chargeFree ? { headerOnly: false, relation: 'superset' as const, kept: false }
      : contradicted ? { headerOnly: false, relation: shown ? 'conflict' as const : 'superset' as const, kept: !!shown }
        // STEP 9 integration (B2-fix)
        : displayDecision(order, scope === 'header-only', shown, { statusRegressed,
          categoriesUnmatched: !!(categories?.unmatched || categories?.taxonomyUnmatched) });
    const displayed = contradicted ? withoutProof(order) : order;
    if (chargeFree && shown && !emptyOrderDetails(shown)) audit(db, 'charge-free-superseded-details', orderRef, undefined, { captureDigest }, now);
    if (kept) audit(db, headerOnly ? 'header-only-kept-details' : `${relation === 'conflict' ? 'conflicting' : 'poorer'}-observation-kept-details`,
      orderRef, undefined, { captureDigest }, now);
    else {
      db.prepare(`INSERT INTO amazon_orders(ref,source_id,native_id,latest_digest,data_json,beneficiary) VALUES(?,?,?,?,?,NULL)
        ON CONFLICT(ref) DO UPDATE SET latest_digest=excluded.latest_digest,data_json=excluded.data_json`)
        .run(orderRef, SOURCE, order.orderId, captureDigest, JSON.stringify(displayed));
      // STEP 9 integration (Root): an effective proof records the display it displaced (none: the order had none) in this
      // transaction, so a revocation restores exactly that display.
      // STEP 9 integration B9 (Root): with the order's active Fresh list then (this capture's own lists come after its orders).
      if (chargeFree) db.prepare('INSERT INTO amazon_proof_predecessors VALUES(?,?,?,?,?)')
        .run(orderRef, captureDigest, stored?.latest_digest ?? null, previous ?? null,
          JSON.stringify({ active: activeFreshList(db, orderRef) }));
      if (!previous || digest(JSON.parse(previous)) !== digest(displayed)) audit(db, 'order-observation', orderRef,
        previous ? JSON.parse(previous) : undefined, displayed, now);
    }
    // refund progression (order-history v3): a refund or return status taken back, or a Refund Total below one already
    // observed for the order, is never silent: audited and counted under its closed reason before this observation joins
    // the history. Neither ever holds the purchase allocation: refunds are not purchase evidence. Nor is a replacement
    // that the displayed lines' categories could not follow (owner decisions, #168).
    if (statusRegressed) {
      audit(db, 'refund-status-regressed', orderRef, undefined, { captureDigest }, now);
      hold('refund-status-regressed');
    }
    if (kept && categories?.unmatched && compareObservation(order, shown!, { statusRegressed }) === 'superset') {
      audit(db, 'item-category-unmatched', orderRef, undefined, { captureDigest, lines: categories.unmatched }, now);
      hold('item-category-unmatched');
    }
    // STEP 9 integration B2 (Root): a taxonomy decision that could not follow a key change is counted on its own.
    if (kept && categories?.taxonomyUnmatched && compareObservation(order, shown!, { statusRegressed }) === 'superset') {
      audit(db, 'taxonomy-unmatched', orderRef, undefined, { captureDigest, lines: categories.taxonomyUnmatched }, now);
      hold('taxonomy-unmatched');
    }
    // A line categorized only by the agent whose new product key (a learned ASIN) waits for the next GO'd category review
    // to adopt it with the same category (categoryKeyAdoptions): counted per line, never written here.
    categories?.adoptions.forEach(() => hold('agent-category-new-key'));
    if (order.refundSummary) {
      const largest = db.prepare(`SELECT max(json_extract(data_json,'$.refundSummary.amountMinor')) FROM amazon_observations
        WHERE family='order' AND order_ref=? AND json_extract(data_json,'$.refundSummary.currency')=?`)
        .pluck().get(orderRef, order.refundSummary.currency) as number | null;
      if (largest !== null && order.refundSummary.amountMinor < largest) {
        audit(db, 'refund-total-decreased', orderRef, { currency: order.refundSummary.currency, amountMinor: largest },
          { captureDigest, refundSummary: order.refundSummary }, now);
        hold('refund-total-decreased');
      }
    }
    observation('order', ordinal, orderRef, scope !== 'legacy' ? SCOPE_HOLD_REASONS[scope]
      : staging.version === 3 ? 'payment-coverage-held' : 'legacy-evidence-held', order);
    for (const item of order.items) {
      observation('item', itemOrdinal++, orderRef, 'item-identity-unproven', item);
      if (staging.version === 3) {
        // A line ordinal is occurrence identity, not a stable line across captures; an override moves to a later capture's
        // line only with a display replacement, by ASIN else exact title (owner decisions, below).
        db.prepare('INSERT INTO amazon_items VALUES(?,?,?,?)').run(
          opaque('line-observation', [captureDigest, order.orderId, item.lineOrdinal]), orderRef,
          `${captureDigest}:${item.lineOrdinal}`, JSON.stringify(item));
      }
    }
    // owner decisions (#168): a replacement carries each owner item category to its identity-matched line, in this
    // transaction and audited, so the display and the allocation that follows it keep the owner's decision.
    if (!kept) for (const { from, to, category } of categories?.carries ?? []) {
      if (db.prepare('INSERT INTO amazon_item_overrides VALUES(?,?) ON CONFLICT(item_ref) DO NOTHING').run(to, category).changes) {
        audit(db, 'item-override-carried', to, { itemRef: from, category }, { itemRef: to, category }, now);
      }
    }
    // STEP 9 integration (#161 x #168): the owner's item taxonomy follows a learned ASIN to the line's new product key.
    if (!kept) carryTaxonomy(db, categories?.taxonomyCarries ?? [], now);
    if (!kept) carryLineDecisions(db, categories?.lineCarries ?? [], now);
    const history = readOrderHistory(db, orderRef);
    const subject = kept
      ? orderTotalSubject(JSON.parse(stored!.data_json) as OrderObservation, stored!.latest_digest, stored!.format_version, history.conflict)
      : orderTotalSubject(displayed, captureDigest, staging.version, history.conflict);
    const oldSubject = db.prepare('SELECT data_json FROM amazon_subjects WHERE ref=?').pluck().get(subject.ref) as string | undefined;
    db.prepare(`INSERT INTO amazon_subjects VALUES(?,?,?,?,?) ON CONFLICT(ref) DO UPDATE SET data_json=excluded.data_json`)
      .run(subject.ref, SOURCE, subject.evidenceClass, null, JSON.stringify(subject));
    db.prepare('INSERT OR IGNORE INTO amazon_event_orders VALUES(?,?)').run(subject.ref, orderRef);
    if (!oldSubject || digest(JSON.parse(oldSubject)) !== digest(subject)) audit(db, 'subject-observation', subject.ref,
      oldSubject ? JSON.parse(oldSubject) : undefined, subject, now);
    // Fresh driver tips billed separately (tipSplit.ts, TIP_SPLIT_POLICY): the order's split subjects, from the same order.
    writeSplitSubjects(db, kept ? JSON.parse(stored!.data_json) as OrderObservation : displayed, subject, orderRef, now);
    if (subject.provenance === 'unproven') hold('single-tender-unproven');
    else if (!subject.allocationComplete) hold(subject.allocationHoldReason ?? 'item-attribution-unproven');
  }
  // STEP 9 integration (B4)
  // Amazon Fresh Item Lists (freshImport.ts): after their orders, before payments, refunds and reconciliation. STEP 9
  // integration B4 (#161 x #157): a re-read its active list's taxonomy decisions cannot follow is held in this receipt.
  if (fresh) writeFreshLists(db, captureDigest, staging, fresh, now, (action, subject, before, after) => audit(db, action, subject, before, after, now),
    hold);
  // A list the kit read from the order's /fopo/ page is a Whole Foods in-store receipt (Root 03:25Z), never an Amazon
  // Fresh delivery: its order's channel is recorded exactly as the saved-pages path records it (first write wins).
  for (const list of fresh?.lists ?? []) {
    if (list.source === 'fopo') recordOrderChannel(db, opaque('order', list.orderId), 'whole-foods-in-store', captureDigest);
  }
  for (const [ordinal, payment] of staging.payments.entries()) {
    const refunded = staging.version === 3 && payment.provenance?.source === 'ledger'
      && payment.provenance.status === 'Refunded' && payment.kind === 'refund' && payment.status === 'completed';
    const reason = payment.kind === 'refund' && !refunded ? 'refund-provenance-unproven' : 'native-event-identity-unproven';
    observation(payment.kind === 'refund' ? 'refund' : 'payment', ordinal, null, reason, payment);
    if (payment.kind === 'refund') {
      db.prepare('INSERT INTO amazon_refunds VALUES(?,?,?,?)').run(opaque('refund-observation', [captureDigest, ordinal]),
        null, refunded ? 'issued' : payment.status === 'pending' ? 'pending' : 'unknown', JSON.stringify(payment));
    }
  }
  // Displayed return/refund statuses: refund-family observations; only refunds also become amazon_refunds rows.
  for (const [index, record] of (staging.refundEvidence ?? []).entries()) {
    const orderRef = opaque('order', record.orderIds[0]);
    const staged = db.prepare('SELECT 1 FROM amazon_orders WHERE ref=?').get(orderRef);
    observation('refund', REFUND_EVIDENCE_ORDINAL_BASE + index, staged ? orderRef : null,
      record.kind === 'refund' ? 'refund-evidence-unattributed' : 'return-is-not-refund', record);
    if (record.kind === 'refund') {
      db.prepare('INSERT INTO amazon_refunds VALUES(?,?,?,?)').run(opaque('refund-observation', [captureDigest, 'evidence', index]),
        null, record.status === 'completed' ? 'issued' : 'pending', JSON.stringify(record));
    }
  }
  // charge-free proof (#158): Root's guard also holds when money evidence arrives after a proof is displayed (the shared
  // recheck above), surfaced once per order with the forward contradictions.
  // STEP 9 integration (revocation)
  const proofs = revokeContradictedProofs(db, now, liveCharge);
  for (const ref of proofs.revoked) surface(ref);
  for (const _ref of proofs.missing) hold('revocation-predecessor-missing');
  projectRefunds(db, now);
  const result = reconcileAmazon(db, now);
  Object.assign(receipt, result);
  receipt.holds = [...holds].sort(([a], [b]) => a.localeCompare(b)).map(([reason, count]) => ({ reason, count }));
  db.prepare('UPDATE amazon_captures SET receipt_json=? WHERE digest=?').run(JSON.stringify(receipt), captureDigest);
  audit(db, 'capture-import', null, undefined, receipt, now);
  return receipt;
}
/**
 * The import's write of one validated capture, inside the caller's transaction: `importAmazonCapture` runs it in its
 * backed-up write, and the batch import (batch.ts) in each capture's own transaction, after the batch's one backup.
 */
export function writeValidatedCapture(db: Database, capture: ValidatedCapture, captureDigest: string, now: string): ImportReceipt {
  if (!db.inTransaction) throw new HoldrRefusal('amazon capture write refused outside a transaction');
  return writeCapture(db, capture.staging, capture.structure, captureDigest, now, capture.fresh);
}
export async function importAmazonCapture(db: Database, input: unknown, backupPath: string,
  now = new Date().toISOString()): Promise<ImportReceipt> {
  const capture = await validateCapture(input);
  const captureDigest = digest(input);
  return backedUpWrite(db, backupPath, () => writeValidatedCapture(db, capture, captureDigest, now));
}
export async function recordBindingProposal(db: Database, input: unknown, backupPath: string): Promise<BindingProposal> {
  const proposal = validateProposal(input, readCardInventory(db));
  return backedUpWrite(db, backupPath, () => {
    validateProposal(proposal, readCardInventory(db));
    const changed = db.prepare('INSERT OR IGNORE INTO amazon_binding_proposals VALUES(?,?)')
      .run(digest(proposal), JSON.stringify(proposal)).changes;
    if (changed) audit(db, 'binding-proposed', null, undefined, { digest: digest(proposal) }, new Date().toISOString());
    return proposal;
  });
}
export async function recordRootApproval(db: Database, proposalInput: unknown, artifact: unknown, backupPath: string): Promise<RootApproval> {
  const proposal = validateProposal(proposalInput, readCardInventory(db));
  const approval = validateApproval(artifact, proposal);
  if (!hasAmazonSchema(db) || !db.prepare('SELECT 1 FROM amazon_binding_proposals WHERE digest=?').get(digest(proposal))) {
    throw new HoldrRefusal('amazon proposal must be recorded first');
  }
  return backedUpWrite(db, backupPath, () => {
    validateProposal(proposal, readCardInventory(db));
    const changed = db.prepare('INSERT OR IGNORE INTO amazon_binding_approvals VALUES(?,?,?)')
      .run(digest(proposal), digest(approval), JSON.stringify(approval)).changes;
    if (changed) audit(db, 'binding-approved', null, undefined, { artifactDigest: digest(approval) }, new Date().toISOString());
    reconcileAmazon(db, new Date().toISOString());
    return approval;
  });
}
