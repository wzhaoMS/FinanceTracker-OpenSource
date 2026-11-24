import type Database from 'better-sqlite3';

import { digest } from '../amazon/policy.js';
import type { RetailQuarantineReason, RetailWrittenEventKind } from './schema.js';

/**
 * A receipt's selection, its events and its evidence (plan v5 §4.2, §5.5, §6).
 *
 * A receipt's state, first reason and canonical version change only together with a new receipt event, and only to that
 * event's values (the schema's triggers check it; `appendRetailEvent` is the one writer). The evidence set a review pins
 * is everything that bears on the receipt: its selection, every sighting, every hold naming its key, every event and every
 * earlier review.
 */

/** What an event cites: the sighting, hold or review behind it (exactly one). */
export type RetailEventCause = { observationRef: string } | { heldRef: string } | { reviewRef: string };

/** One event, in the writer's own type: never the reserved kind, and never a reserved column (plan §5.7). */
export interface RetailEventInsert {
  kind: RetailWrittenEventKind;
  state: 'active' | 'quarantined';
  firstReason: RetailQuarantineReason | null;
  canonicalVersion: string;
  reason: RetailQuarantineReason | null;
  cause: RetailEventCause;
  /** The import that writes it, or null for a review's (then `goId`, the review's GO in letter hex). */
  importId: string | null;
  goId: string | null;
  at: string;
}

/**
 * Appends the receipt's next event and sets the receipt's selection to its values, in the caller's transaction. The
 * event's `prior_version` is the selection now; the reserved columns are written null, always.
 */
export function appendRetailEvent(db: Database.Database, receiptRef: string, event: RetailEventInsert): number {
  const current = db.prepare('SELECT selection_seq AS selectionSeq, canonical_version AS canonicalVersion FROM retail_receipts WHERE receipt_ref = ?')
    .get(receiptRef) as { selectionSeq: number; canonicalVersion: string | null } | undefined;
  if (current === undefined) throw new TypeError('a retail event names a receipt that is not stored');
  const seq = current.selectionSeq + 1;
  const cause = event.cause;
  db.prepare(`INSERT INTO retail_receipt_events (receipt_ref, seq, kind, prior_version, state, first_reason, canonical_version, reason,
      observation_ref, held_ref, review_ref, import_id, go_id, witness_observation_ref, progression_rule, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`)
    .run(receiptRef, seq, event.kind, current.canonicalVersion, event.state, event.firstReason, event.canonicalVersion, event.reason,
      'observationRef' in cause ? cause.observationRef : null, 'heldRef' in cause ? cause.heldRef : null,
      'reviewRef' in cause ? cause.reviewRef : null, event.importId, event.goId, event.at);
  db.prepare('UPDATE retail_receipts SET state = ?, first_reason = ?, canonical_version = ?, selection_seq = ? WHERE receipt_ref = ?')
    .run(event.state, event.firstReason, event.canonicalVersion, seq, receiptRef);
  return seq;
}

/**
 * The event that holds a receipt for `reason` (plan §5.3, §5.5): an active receipt is quarantined, with `reason` as its
 * first reason; a quarantined one gets one more cause and keeps its first reason. The canonical version never changes.
 */
export function retailHoldEvent(current: { state: 'active' | 'quarantined'; firstReason: string | null; canonicalVersion: string },
  reason: RetailQuarantineReason, cause: RetailEventCause, importId: string, at: string): RetailEventInsert {
  const quarantined = current.state === 'quarantined';
  return {
    kind: quarantined ? 'cause' : 'quarantined', state: 'quarantined',
    firstReason: quarantined ? (current.firstReason as RetailQuarantineReason) : reason,
    canonicalVersion: current.canonicalVersion, reason, cause, importId, goId: null, at,
  };
}

/** The held records naming a natural key that no review of the receipt resolved (plan §5.5): imported after its last review's import. */
export function retailUnresolvedHolds(db: Database.Database, naturalKey: string, receiptRef: string | null): string[] {
  const through = receiptRef === null ? 0
    : (db.prepare('SELECT coalesce(max(through_import_seq), 0) FROM retail_receipt_reviews WHERE receipt_ref = ?').pluck().get(receiptRef) as number);
  return db.prepare(`SELECT h.held_ref FROM retail_held h JOIN retail_imports i ON i.import_id = h.import_id
    WHERE h.natural_key = ? AND i.import_seq > ? ORDER BY i.import_seq, h.held_ref`).pluck().all(naturalKey, through) as string[];
}

/**
 * A receipt's evidence set (plan §6), in canonical order: its selection; every observation (ref, version, membership, import
 * sequence); every held record naming its key (ref, import sequence); every event (sequence, kind, reason, cause ref);
 * every review of it (ref). Refs and sequences only: no fact, no natural key.
 */
export interface RetailEvidence {
  receiptRef: string;
  state: string;
  firstReason: string | null;
  canonicalVersion: string;
  selectionSeq: number;
  observations: Array<[string, string, string, number]>;
  held: Array<[string, number]>;
  events: Array<[number, string, string | null, string]>;
  reviews: string[];
}

export function retailEvidence(db: Database.Database, receiptRef: string): RetailEvidence {
  const receipt = db.prepare(`SELECT natural_key AS naturalKey, state, first_reason AS firstReason, canonical_version AS canonicalVersion,
    selection_seq AS selectionSeq FROM retail_receipts WHERE receipt_ref = ?`).get(receiptRef) as
    { naturalKey: string; state: string; firstReason: string | null; canonicalVersion: string; selectionSeq: number } | undefined;
  if (receipt === undefined) throw new TypeError('no retail receipt of this ref');
  const observations = (db.prepare(`SELECT o.observation_ref AS ref, o.version_ref AS version, o.membership_ref AS membership, i.import_seq AS seq
      FROM retail_receipt_observations o JOIN retail_imports i ON i.import_id = o.import_id WHERE o.receipt_ref = ? ORDER BY i.import_seq, o.observation_ref`)
    .all(receiptRef) as Array<{ ref: string; version: string; membership: string; seq: number }>)
    .map((row): [string, string, string, number] => [row.ref, row.version, row.membership, row.seq]);
  const held = (db.prepare(`SELECT h.held_ref AS ref, i.import_seq AS seq FROM retail_held h JOIN retail_imports i ON i.import_id = h.import_id
      WHERE h.natural_key = ? ORDER BY i.import_seq, h.held_ref`).all(receipt.naturalKey) as Array<{ ref: string; seq: number }>)
    .map((row): [string, number] => [row.ref, row.seq]);
  const events = (db.prepare(`SELECT seq, kind, reason, coalesce(observation_ref, held_ref, review_ref) AS cause FROM retail_receipt_events
      WHERE receipt_ref = ? ORDER BY seq`).all(receiptRef) as Array<{ seq: number; kind: string; reason: string | null; cause: string }>)
    .map((row): [number, string, string | null, string] => [row.seq, row.kind, row.reason, row.cause]);
  const reviews = db.prepare('SELECT review_ref FROM retail_receipt_reviews WHERE receipt_ref = ? ORDER BY review_ref').pluck().all(receiptRef) as string[];
  return {
    receiptRef, state: receipt.state, firstReason: receipt.firstReason, canonicalVersion: receipt.canonicalVersion,
    selectionSeq: receipt.selectionSeq, observations, held, events, reviews,
  };
}

/** The evidence set's tagged digest (lowercase hex): what a review pins, and what a plan's digest includes. */
export const retailEvidenceDigest = (evidence: RetailEvidence): string => digest({ tag: 'holdr.retail-receipt-evidence', version: 1, evidence });
