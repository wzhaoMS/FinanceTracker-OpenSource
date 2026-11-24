import type { Database } from 'better-sqlite3';
import { HoldrRefusal } from '../dbErrors.js';
import { digest } from './policy.js';

export const AMAZON_SCHEMA = `
CREATE TABLE IF NOT EXISTS amazon_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1));
INSERT OR IGNORE INTO amazon_meta VALUES(1,1);
CREATE TABLE IF NOT EXISTS amazon_sources (id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS amazon_captures (
 digest TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES amazon_sources(id),
 format_version INTEGER NOT NULL, window_from TEXT NOT NULL, window_through TEXT NOT NULL,
 coverage_json TEXT NOT NULL, resume_json TEXT NOT NULL, imported_at TEXT NOT NULL,
 receipt_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS amazon_orders (
 ref TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES amazon_sources(id), native_id TEXT NOT NULL,
 latest_digest TEXT NOT NULL REFERENCES amazon_captures(digest), data_json TEXT NOT NULL,
 beneficiary TEXT CHECK(beneficiary IN ('alex','casey','joint') OR beneficiary IS NULL),
 UNIQUE(source_id,native_id)
);
CREATE TABLE IF NOT EXISTS amazon_observations (
 ref TEXT PRIMARY KEY, capture_digest TEXT NOT NULL REFERENCES amazon_captures(digest),
 family TEXT NOT NULL CHECK(family IN ('order','item','payment','refund')),
 ordinal INTEGER NOT NULL, order_ref TEXT REFERENCES amazon_orders(ref),
 hold_reason TEXT NOT NULL, data_json TEXT NOT NULL,
 UNIQUE(capture_digest,family,ordinal)
);
CREATE TABLE IF NOT EXISTS amazon_items (
 ref TEXT PRIMARY KEY, order_ref TEXT NOT NULL REFERENCES amazon_orders(ref), native_line_id TEXT NOT NULL,
 data_json TEXT NOT NULL, UNIQUE(order_ref,native_line_id)
);
CREATE TABLE IF NOT EXISTS amazon_shipments (
 ref TEXT PRIMARY KEY, order_ref TEXT NOT NULL REFERENCES amazon_orders(ref), data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS amazon_line_joins (
 shipment_ref TEXT NOT NULL REFERENCES amazon_shipments(ref), item_ref TEXT NOT NULL REFERENCES amazon_items(ref),
 PRIMARY KEY(shipment_ref,item_ref)
);
CREATE TABLE IF NOT EXISTS amazon_subjects (
 ref TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES amazon_sources(id),
 evidence_class TEXT NOT NULL CHECK(evidence_class IN ('payment-event','unique-total-match')),
 native_occurrence_id TEXT, data_json TEXT NOT NULL,
 UNIQUE(source_id,evidence_class,native_occurrence_id)
);
CREATE TABLE IF NOT EXISTS amazon_event_orders (
 subject_ref TEXT NOT NULL REFERENCES amazon_subjects(ref), order_ref TEXT NOT NULL REFERENCES amazon_orders(ref),
 PRIMARY KEY(subject_ref,order_ref)
);
CREATE TABLE IF NOT EXISTS amazon_tender_portions (
 ref TEXT PRIMARY KEY, subject_ref TEXT NOT NULL REFERENCES amazon_subjects(ref),
 kind TEXT NOT NULL CHECK(kind IN ('card','balance','gift-card','points','unknown')),
 data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS amazon_refunds (
 ref TEXT PRIMARY KEY, subject_ref TEXT REFERENCES amazon_subjects(ref),
 execution_status TEXT NOT NULL CHECK(execution_status IN ('issued','pending','unknown')), data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS amazon_refund_destinations (
 ref TEXT PRIMARY KEY, refund_ref TEXT NOT NULL REFERENCES amazon_refunds(ref),
 kind TEXT NOT NULL CHECK(kind IN ('card','balance','points','unknown')), data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS amazon_allocations (
 subject_ref TEXT NOT NULL REFERENCES amazon_subjects(ref), item_ref TEXT NOT NULL REFERENCES amazon_items(ref),
 amount_minor INTEGER NOT NULL CHECK(amount_minor BETWEEN -9007199254740991 AND 9007199254740991),
 currency TEXT NOT NULL, provenance TEXT NOT NULL CHECK(provenance='explicit-payment-item'),
 PRIMARY KEY(subject_ref,item_ref)
);
CREATE TABLE IF NOT EXISTS amazon_binding_proposals (digest TEXT PRIMARY KEY, data_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS amazon_binding_approvals (
 proposal_digest TEXT PRIMARY KEY REFERENCES amazon_binding_proposals(digest), artifact_digest TEXT NOT NULL,
 data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS amazon_candidates (
 subject_ref TEXT NOT NULL REFERENCES amazon_subjects(ref), card_transaction_id TEXT NOT NULL,
 evidence_class TEXT NOT NULL, PRIMARY KEY(subject_ref,card_transaction_id)
);
CREATE TABLE IF NOT EXISTS amazon_matches (
 subject_ref TEXT PRIMARY KEY REFERENCES amazon_subjects(ref), state TEXT NOT NULL CHECK(state IN ('held','linked')),
 card_transaction_id TEXT, data_json TEXT NOT NULL,
 CHECK((state='linked')=(card_transaction_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS amazon_active_row ON amazon_matches(card_transaction_id) WHERE state='linked';
CREATE TABLE IF NOT EXISTS amazon_category_mappings (
 source_category TEXT PRIMARY KEY, category TEXT NOT NULL, reviewed INTEGER NOT NULL CHECK(reviewed=1)
);
CREATE TABLE IF NOT EXISTS amazon_item_overrides (
 item_ref TEXT PRIMARY KEY REFERENCES amazon_items(ref), category TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS amazon_agent_categories (
 product_key TEXT PRIMARY KEY, category TEXT NOT NULL,
 confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
 source TEXT NOT NULL CHECK(source='agent'),
 rationale TEXT NOT NULL CHECK(rationale='categorized from product title')
);
CREATE TABLE IF NOT EXISTS amazon_audit (
 sequence INTEGER PRIMARY KEY, action TEXT NOT NULL, subject_ref TEXT, before_digest TEXT, after_digest TEXT,
 policy_digest TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS amazon_capture_runs (
 capture_digest TEXT PRIMARY KEY REFERENCES amazon_captures(digest), run_id TEXT NOT NULL,
 capture_mode TEXT NOT NULL CHECK(capture_mode IN ('recent','backfill'))
);
CREATE TABLE IF NOT EXISTS amazon_ledger_candidates (
 subject_ref TEXT NOT NULL REFERENCES amazon_observations(ref), card_transaction_id TEXT NOT NULL,
 evidence_class TEXT NOT NULL, PRIMARY KEY(subject_ref,card_transaction_id)
);
CREATE TABLE IF NOT EXISTS amazon_ledger_matches (
 subject_ref TEXT PRIMARY KEY REFERENCES amazon_observations(ref), state TEXT NOT NULL CHECK(state IN ('held','linked')),
 card_transaction_id TEXT, data_json TEXT NOT NULL,
 CHECK((state='linked')=(card_transaction_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS amazon_ledger_active_row ON amazon_ledger_matches(card_transaction_id) WHERE state='linked';
CREATE INDEX IF NOT EXISTS amazon_order_observations ON amazon_observations(family,order_ref);
CREATE TABLE IF NOT EXISTS amazon_refund_events (
 ref TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('refund','return')),
 source TEXT NOT NULL CHECK(source IN ('ledger','order-details','returns-page')),
 status TEXT NOT NULL CHECK(status IN ('completed','pending','started','in-transit','received','cancelled')),
 data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS amazon_refund_event_members (
 event_ref TEXT NOT NULL REFERENCES amazon_refund_events(ref),
 observation_ref TEXT NOT NULL REFERENCES amazon_observations(ref), refund_ref TEXT REFERENCES amazon_refunds(ref),
 PRIMARY KEY(event_ref,observation_ref)
);
-- STEP 9 integration (revocation): the display each effective charge-free proof displaced.
-- STEP 9 integration B9 (Root): with the order's active Fresh list then, fresh_json {"active": digest or null}; NULL: unrecorded.
CREATE TABLE IF NOT EXISTS amazon_proof_predecessors (
 order_ref TEXT NOT NULL REFERENCES amazon_orders(ref), proof_digest TEXT NOT NULL REFERENCES amazon_captures(digest),
 predecessor_digest TEXT REFERENCES amazon_captures(digest), predecessor_json TEXT, fresh_json TEXT,
 CHECK((predecessor_digest IS NULL) = (predecessor_json IS NULL)), PRIMARY KEY(order_ref,proof_digest)
);
`;
export const AMAZON_SCHEMA_DIGEST = digest(AMAZON_SCHEMA);
export function hasAmazonSchema(db: Database): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='amazon_meta'").get());
}
/** Additive tables: a database last written before they existed still reads (no events) until its next guarded write. */
export function hasRefundEventSchema(db: Database): boolean {
  return (db.prepare(`SELECT count(*) FROM sqlite_master WHERE type='table'
    AND name IN ('amazon_refund_events','amazon_refund_event_members')`).pluck().get() as number) === 2;
}
/**
 * STEP 9 integration (Root): the display each effective charge-free proof displaced (null: the order had none), written
 * with the proof in the same transaction, so a revocation restores exactly that display. Additive, like the refund events:
 * installed by the next guarded write, never at boot; only the revocation reads it.
 * STEP 9 integration B9 (Root): the record also holds the order's active Fresh list then, restored with the display.
 */
export function hasProofPredecessorSchema(db: Database): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='amazon_proof_predecessors'").get());
}
export function ensureAmazonSchema(db: Database): void {
  if (hasAmazonSchema(db) && db.prepare('SELECT version FROM amazon_meta WHERE id=1').pluck().get() !== 1) {
    throw new HoldrRefusal('amazon schema version refused');
  }
  db.exec(AMAZON_SCHEMA);
}
