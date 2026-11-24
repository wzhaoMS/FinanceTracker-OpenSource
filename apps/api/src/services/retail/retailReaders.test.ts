import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { RetailImportReceipt } from '@finance-tracker/shared/retail-import-payload';

import { retailReport } from '../../cli/retailReport.js';
import { SqliteStateRepo } from '../sqliteStateRepo.js';
import {
  importRetailPayload,
  installRetailSchema,
  planRetailImport,
  planRetailReview,
  proposeRetailBindings,
  requireRetailSchema,
  retailEvidence,
  retailEvidenceDigest,
  retailPayloadSha256,
  retailQuarantine,
  retailSchemaForRead,
  reviewRetailReceipts,
  validRetailPayload,
  type RetailReviewFile,
} from './index.js';
import {
  RETAIL_RESERVED_FIXTURES,
  RETAIL_TEST_GO,
  RETAIL_TEST_NOW,
  importPayload,
  membershipChoice,
  refusalOf,
  retailReservedBase,
  rows,
} from '../../testing/retailDb.js';
import { syntheticRetailPayload, warehouseKey, warehouseReceipt } from '../../testing/retailPayloads.js';

// The progression reservation, condition 3 (plan v5 §5.7): every reader stops on a stored reserved value, right after it
// finds the tables present, before any other answer, an idempotent one included. Each reserved row is schema-valid
// (3ddfcd26's rule): the CHECK ties the reserved event columns to the reserved kind, so one progression event holds the
// kind, its witness and its rule together. Each database is a whole Holdr database made by this build (its card accounts
// included), so a reader whose own check were skipped would answer, never fail on a missing table. Synthetic payloads only.

let repo: SqliteStateRepo;
let db: Database.Database;
let capture = 0;
/** A new in-memory Holdr database with the retail tables installed. */
const fresh = () => {
  repo = new SqliteStateRepo({ file: ':memory:', now: () => new Date(RETAIL_TEST_NOW) });
  db = repo.internalGetDb();
  installRetailSchema(db, { now: RETAIL_TEST_NOW, authority: RETAIL_TEST_GO });
  capture = 0;
};
beforeEach(() => { fresh(); });
afterEach(() => { repo.close(); });

const payloadOf = (receipts: RetailImportReceipt[]) => syntheticRetailPayload({ capture: 'bcdefghijklmnop'[capture++ % 15], receipts });
const REVIEWED = 'e'.repeat(64);
const GO = { kind: 'go' as const, goId: 'f'.repeat(32), purpose: 'copy-rehearsal' };

/** Receipt 1 sighted by two imports and quarantined, its review recorded as the file `REVIEWED`, and its first payload again. */
function readersBase(): { review: RetailReviewFile; imported: ReturnType<typeof payloadOf> } {
  importPayload(db, payloadOf([warehouseReceipt(1)]));
  importPayload(db, payloadOf([warehouseReceipt(1, { date: '2031-01-12' })]));
  const receipt = db.prepare('SELECT receipt_ref AS ref, canonical_version AS canonical FROM retail_receipts').get() as { ref: string; canonical: string };
  const review: RetailReviewFile = { format: 'holdr.retail-receipt-review', version: 1, decisions: [{ receiptRef: receipt.ref,
    evidenceDigest: retailEvidenceDigest(retailEvidence(db, receipt.ref)), decision: 'keep-quarantined', before: receipt.canonical, chosen: null }] };
  reviewRetailReceipts(db, review, { now: RETAIL_TEST_NOW, authority: GO, reviewSha256: REVIEWED, planDigest: null });
  const imported = payloadOf([warehouseReceipt(1)]);
  importPayload(db, imported);
  return { review, imported };
}

describe('retail reservation: every reader stops on a stored reserved value (plan §5.7, condition 3)', () => {
  it('refuses retail-reserved-value before any other answer, idempotent ones included, for each reserved row and every reader', () => {
    for (const [what, add] of Object.entries(RETAIL_RESERVED_FIXTURES)) {
      repo.close();
      fresh();
      const { review, imported } = readersBase();
      const counts = add(db, retailReservedBase(db, warehouseKey(1)));
      const request = { payload: imported, declaration: null, membership: membershipChoice(db, imported, null) };
      const inputSha256 = retailPayloadSha256(validRetailPayload(imported));
      const readers: Array<[string, () => unknown]> = [
        ['the schema check', () => requireRetailSchema(db)],
        ['a reader\'s schema check', () => retailSchemaForRead(db)],
        ['plan, a new payload', () => planRetailImport(db, { payload: payloadOf([warehouseReceipt(5)]), declaration: null, membership: null })],
        ['plan, the payload already imported', () => planRetailImport(db, request)],
        ['import, the payload already imported', () => importRetailPayload(db, request, { now: RETAIL_TEST_NOW, authority: RETAIL_TEST_GO, inputSha256,
          planDigest: null })],
        ['install, the tables already there', () => installRetailSchema(db, { now: RETAIL_TEST_NOW, authority: RETAIL_TEST_GO })],
        ['review plan, the file already recorded', () => planRetailReview(db, review, REVIEWED)],
        ['review, the file already recorded', () => reviewRetailReceipts(db, review, { now: RETAIL_TEST_NOW, authority: GO, reviewSha256: REVIEWED,
          planDigest: null })],
        ['quarantine', () => retailQuarantine(db)],
        ['bindings propose', () => proposeRetailBindings(db, 'a'.repeat(64))],
        ['report', () => retailReport(db)],
      ];
      const audits = rows(db, 'SELECT count(*) FROM retail_audit');
      for (const [reader, read] of readers) {
        expect(refusalOf(read), `${what}: ${reader}`).toMatchObject({ code: 'retail-reserved-value', details: counts });
      }
      expect(rows(db, 'SELECT count(*) FROM retail_audit'), what).toBe(audits);
    }
  });
});
