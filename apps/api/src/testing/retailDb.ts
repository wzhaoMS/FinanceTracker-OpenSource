import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import type { RetailImportPayload, RetailImportReceipt } from '@finance-tracker/shared/retail-import-payload';

import {
  RETAIL_DECLARATION_FORMAT,
  RETAIL_OUTCOMES,
  RetailRefusal,
  appendRetailEvent,
  importRetailPayload,
  insertRetailReceipt,
  installRetailSchema,
  newRetailId,
  retailCountColumn,
  retailLetters,
  retailPayloadSha256,
  retailReceiptByKey,
  retailVersionOf,
  storeRetailVersion,
  validRetailPayload,
  type RetailAuthority,
  type RetailDeclarationInput,
  type RetailImportResult,
  type RetailMembershipChoice,
  type RetailOwner,
  type RetailVersionLabels,
} from '../services/retail/index.js';

/**
 * Test-only helpers for the retail domain (Costco PR 2): an in-memory database with the tables installed under a
 * synthetic GO, membership declarations, imports through the real importer, and the rows a later build would write
 * (a version read under another policy), through the same internal writers the importer uses. Synthetic values only.
 */

export const RETAIL_TEST_NOW = '2031-03-01T12:00:00.000Z';
export const RETAIL_TEST_GO: RetailAuthority = Object.freeze({ kind: 'go', goId: 'a'.repeat(32), purpose: 'copy-rehearsal' });
/** A later policy's labels: what a build after policy 5 would record. */
export const LATER_LABELS: RetailVersionLabels = Object.freeze({
  policyVersion: 6, titleRule: 'title-rule-v4', metalGuard: 'metal-guard-v2', packRule: 'metals-pack-v3',
});

/** A fresh in-memory database, foreign keys on, the retail tables installed. */
export function retailTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  installRetailSchema(db, { now: RETAIL_TEST_NOW, authority: RETAIL_TEST_GO });
  return db;
}

/** A membership declaration and its file's SHA-256 (the bytes a declaration file would hold). */
export function declaration(folder: string, owner: RetailOwner = 'alex', label = 'Sample Household'): RetailDeclarationInput {
  const value = { format: RETAIL_DECLARATION_FORMAT, version: 1 as const, merchant: 'costco' as const, folder, owner, label };
  return { declaration: value, sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex') };
}

/** What the GO would name for this payload: its folder's ref when registered, else the declaration's SHA-256. */
export function membershipChoice(db: Database.Database, payload: RetailImportPayload, declared: RetailDeclarationInput | null): RetailMembershipChoice {
  const registered = db.prepare(`SELECT membership_ref FROM retail_memberships WHERE folder = ?`).pluck().get(payload.membership.folder) as string | undefined;
  if (registered !== undefined) return { membershipRef: registered };
  if (declared === null) throw new Error('an unregistered folder needs a declaration');
  return { declarationSha256: declared.sha256 };
}

/** Imports a payload through the real importer, as the CLI would under a GO (a declaration for a new folder by default). */
export function importPayload(db: Database.Database, payload: RetailImportPayload, options: {
  declaration?: RetailDeclarationInput | null; now?: string; planDigest?: string | null;
} = {}): RetailImportResult {
  const registered = db.prepare('SELECT 1 FROM retail_memberships WHERE folder = ?').get(payload.membership.folder) !== undefined;
  const declared = options.declaration !== undefined ? options.declaration : registered ? null : declaration(payload.membership.folder);
  return importRetailPayload(db, { payload, declaration: declared, membership: membershipChoice(db, payload, declared) }, {
    now: options.now ?? RETAIL_TEST_NOW, authority: RETAIL_TEST_GO, inputSha256: retailPayloadSha256(validRetailPayload(payload)),
    planDigest: options.planDigest ?? null,
  });
}

/**
 * What a later build would write for one sighting read under `labels`: its own import row (the next sequence), the version
 * if the receipt has none with its digests, an observation, and the event that a later build's §5.3 row would write
 * (`created` for a new receipt, else the `event` given). Through the same internal writers the importer uses.
 */
export function seedLaterSighting(db: Database.Database, membershipRef: string, receipt: RetailImportReceipt, labels: RetailVersionLabels,
  event: 'created' | 'provenance-refresh' | 'none' = 'created'): { importId: string; receiptRef: string; versionRef: string; observationRef: string } {
  const importId = newRetailId('rtl-imp-');
  const seq = db.prepare('SELECT coalesce(max(import_seq), 0) + 1 FROM retail_imports').pluck().get() as number;
  const counts = RETAIL_OUTCOMES.map((outcome) => retailCountColumn(outcome));
  db.prepare(`INSERT INTO retail_imports (import_id, import_seq, payload_sha256, membership_ref, format, version, converter_version, policy_version,
      capture_schema, capture_digest, captured_at, capture_files, plan_digest, go_id, purpose, imported_at, receipt_count, ${counts.join(', ')},
      held_no_key_count, held_pending_count, held_quarantining_count)
    VALUES (?, ?, ?, ?, 'holdr.retail-import', 4, 'holdr-retail-convert 1.5.0', ?, 'holdr-retail-capture/costco@1', ?, ?, 3, ?, ?, 'copy-rehearsal',
      ?, 1, ${counts.map((column) => (column === 'new_count' ? '1' : '0')).join(', ')}, 0, 0, 0)`)
    .run(importId, seq, retailLetters(createHash('sha256').update(importId).digest('hex')), membershipRef, labels.policyVersion, 'c'.repeat(64),
      '2031-02-20T00:00:00.000Z', 'd'.repeat(64), 'e'.repeat(32), RETAIL_TEST_NOW);
  const stored = retailReceiptByKey(db, receipt.naturalKey);
  const receiptRef = stored?.receiptRef ?? insertRetailReceipt(db, receipt, importId);
  const version = retailVersionOf(receipt, labels);
  const existing = db.prepare(`SELECT version_ref FROM retail_receipt_versions WHERE receipt_ref = ? AND source_digest = ? AND meaning_digest = ?
    AND provenance_digest = ?`).pluck().get(receiptRef, version.sourceDigest, version.meaningDigest, version.provenanceDigest) as string | undefined;
  const versionRef = existing ?? storeRetailVersion(db, receiptRef, receipt, version, labels, importId);
  const observationRef = newRetailId('rob-');
  db.prepare('INSERT INTO retail_receipt_observations (observation_ref, receipt_ref, version_ref, membership_ref, import_id) VALUES (?, ?, ?, ?, ?)')
    .run(observationRef, receiptRef, versionRef, membershipRef, importId);
  if (stored === null) {
    appendRetailEvent(db, receiptRef, { kind: 'created', state: 'active', firstReason: null, canonicalVersion: versionRef, reason: null,
      cause: { observationRef }, importId, goId: null, at: RETAIL_TEST_NOW });
  } else if (event === 'provenance-refresh') {
    appendRetailEvent(db, receiptRef, { kind: 'provenance-refresh', state: 'active', firstReason: null, canonicalVersion: versionRef, reason: null,
      cause: { observationRef }, importId, goId: null, at: RETAIL_TEST_NOW });
  }
  return { importId, receiptRef, versionRef, observationRef };
}

/** Count of rows, by SQL. */
export const rows = (db: Database.Database, sql: string, ...params: unknown[]): number => db.prepare(sql).pluck().get(...params) as number;

/** What a call refused: its RetailRefusal, or `none`. */
export type RetailRefusalSeen = RetailRefusal | { code: 'none'; details: Record<string, never> };

/**
 * The refusal `fn` meets, as a value: a missing or different refusal then fails the test's own assertion. Only the
 * declared hold type, RetailRefusal, is caught, keeping its code; anything else is re-thrown unchanged (ROOT's kill
 * standard, addendum 3(e): no catch turns an unexpected error into data for an assertion).
 */
export function refusalOf(fn: () => unknown): RetailRefusalSeen {
  try {
    fn();
  } catch (error) {
    if (error instanceof RetailRefusal) return error;
    throw error;
  }
  return { code: 'none', details: {} };
}

/**
 * The reserved values (plan §5.7), read directly, never through the STOP under test: each count must be 0 after any
 * write path in PRs 2–7.
 */
export function reservedValuesStored(db: Database.Database): Record<string, number> {
  return {
    progressionEvents: rows(db, `SELECT count(*) FROM retail_receipt_events WHERE kind = 'progression'`),
    witnesses: rows(db, 'SELECT count(*) FROM retail_receipt_events WHERE witness_observation_ref IS NOT NULL'),
    rules: rows(db, 'SELECT count(*) FROM retail_receipt_events WHERE progression_rule IS NOT NULL'),
    correctReviews: rows(db, `SELECT count(*) FROM retail_receipt_reviews WHERE decision = 'correct'`),
    progressionCounts: rows(db, 'SELECT count(*) FROM retail_imports WHERE progression_count <> 0'),
  };
}

export const NO_RESERVED = Object.freeze({ progressionEvents: 0, witnesses: 0, rules: 0, correctReviews: 0, progressionCounts: 0 });

/** A receipt sighted by two imports (its first version canonical, the second held): what the reserved rows below build on. */
export interface RetailReservedBase {
  receiptRef: string;
  v1: string;
  v2: string;
  o1: string;
  o2: string;
  import2: string;
}

/** The base rows of a receipt that two imports sighted, by its natural key. */
export function retailReservedBase(db: Database.Database, naturalKey: string): RetailReservedBase {
  const receiptRef = db.prepare('SELECT receipt_ref FROM retail_receipts WHERE natural_key = ?').pluck().get(naturalKey) as string;
  const [first, second] = db.prepare(`SELECT o.observation_ref AS ref, o.version_ref AS version, o.import_id AS importId
    FROM retail_receipt_observations o JOIN retail_imports i ON i.import_id = o.import_id WHERE o.receipt_ref = ? ORDER BY i.import_seq`)
    .all(receiptRef) as Array<{ ref: string; version: string; importId: string }>;
  return { receiptRef, v1: first.version, v2: second.version, o1: first.ref, o2: second.ref, import2: second.importId };
}

/**
 * The schema-valid reserved rows (3ddfcd26's rule), each holding one reserved value as a later rule's PR would write it,
 * and the counts the STOP reports for it. The CHECK ties the reserved event columns to the reserved kind, so the
 * progression event carries kind, witness (a sighting of its prior version) and rule together.
 */
export const RETAIL_RESERVED_FIXTURES: Readonly<Record<string, (db: Database.Database, base: RetailReservedBase) => Record<string, number>>> = {
  'a progression event': (db, { receiptRef, v1, v2, o1, o2, import2 }) => {
    const seq = (db.prepare('SELECT selection_seq FROM retail_receipts WHERE receipt_ref = ?').pluck().get(receiptRef) as number) + 1;
    db.prepare(`INSERT INTO retail_receipt_events (receipt_ref, seq, kind, prior_version, state, first_reason, canonical_version, reason,
      observation_ref, held_ref, review_ref, import_id, go_id, witness_observation_ref, progression_rule, at)
      VALUES (?, ?, 'progression', ?, 'active', NULL, ?, NULL, ?, NULL, NULL, ?, NULL, ?, 'retail-progression-v1', ?)`)
      .run(receiptRef, seq, v1, v2, o2, import2, o1, RETAIL_TEST_NOW);
    db.prepare(`UPDATE retail_receipts SET state = 'active', first_reason = NULL, canonical_version = ?, selection_seq = ? WHERE receipt_ref = ?`)
      .run(v2, seq, receiptRef);
    return { events: 1, reviews: 0, imports: 0 };
  },
  'a correct review': (db, { receiptRef, v1, v2 }) => {
    db.prepare(`INSERT INTO retail_receipt_reviews (review_ref, review_sha256, receipt_ref, evidence_digest, through_import_seq, decision,
      before_version, chosen_version, go_id, purpose, reviewed_at) VALUES (?, ?, ?, ?, 2, 'correct', ?, ?, ?, 'copy-rehearsal', ?)`)
      .run(newRetailId('rtl-rev-'), 'a'.repeat(64), receiptRef, 'b'.repeat(64), v1, v2, 'c'.repeat(32), RETAIL_TEST_NOW);
    return { events: 0, reviews: 1, imports: 0 };
  },
  'a nonzero progression count': (db, { receiptRef }) => {
    const columns = RETAIL_OUTCOMES.map((outcome) => retailCountColumn(outcome));
    const membership = db.prepare(`SELECT membership_ref FROM retail_receipt_observations WHERE receipt_ref = ? LIMIT 1`).pluck().get(receiptRef);
    db.prepare(`INSERT INTO retail_imports (import_id, import_seq, payload_sha256, membership_ref, format, version, converter_version, policy_version,
        capture_schema, capture_digest, captured_at, capture_files, plan_digest, go_id, purpose, imported_at, receipt_count, ${columns.join(', ')},
        held_no_key_count, held_pending_count, held_quarantining_count)
      VALUES (?, (SELECT max(import_seq) + 1 FROM retail_imports), ?, ?, 'holdr.retail-import', 3, 'holdr-retail-convert 1.4.0', 5,
        'holdr-retail-capture/costco@1', ?, ?, 1, ?, ?, 'copy-rehearsal', ?, 1, ${columns.map((column) => (column === 'progression_count' ? '1' : '0')).join(', ')},
        0, 0, 0)`)
      .run(newRetailId('rtl-imp-'), 'a'.repeat(64), membership, 'c'.repeat(64), '2031-02-20T00:00:00.000Z', 'd'.repeat(64), 'e'.repeat(32), RETAIL_TEST_NOW);
    return { events: 0, reviews: 0, imports: 1 };
  },
};
