import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { RetailImportReceipt } from '@finance-tracker/shared/retail-import-payload';

import {
  RETAIL_OUTCOMES,
  RETAIL_WRITTEN_DECISIONS,
  RETAIL_WRITTEN_OUTCOMES,
  retailCountColumn,
  retailEvidence,
  retailEvidenceDigest,
  reviewRetailReceipts,
  type RetailEventInsert,
  type RetailImportOutcome,
  type RetailReviewDecisionInput,
  type RetailSightingDecision,
  type RetailWrittenDecision,
  type RetailWrittenEventKind,
} from './index.js';
import { LATER_LABELS, NO_RESERVED, RETAIL_TEST_NOW, importPayload, reservedValuesStored, retailTestDb, rows, seedLaterSighting } from '../../testing/retailDb.js';
import { goldBar, heldRecord, onlineOrder, syntheticRetailPayload, warehouseKey, warehouseLine, warehouseReceipt } from '../../testing/retailPayloads.js';

// The progression reservation, condition 2 (plan v5 §5.7): no writer can emit a reserved value, and every write path
// leaves none. Each check is an assertion in its test's own body (the kill standard's sites). Synthetic payloads only.

let db: Database.Database;
let capture = 0;
beforeEach(() => { db = retailTestDb(); capture = 0; });
afterEach(() => { db.close(); });

const payloadOf = (receipts: RetailImportReceipt[], options: Parameters<typeof syntheticRetailPayload>[0] = {}) =>
  syntheticRetailPayload({ capture: 'bcdefghijklmnop'[capture++ % 15], receipts, ...options });
const decisionFor = (key: string, decision: RetailWrittenDecision): RetailReviewDecisionInput => {
  const receipt = db.prepare('SELECT receipt_ref AS ref, canonical_version AS canonical FROM retail_receipts WHERE natural_key = ?').get(key) as
    { ref: string; canonical: string };
  const other = db.prepare('SELECT version_ref FROM retail_receipt_versions WHERE receipt_ref = ? AND version_ref <> ?').pluck().get(receipt.ref, receipt.canonical);
  return { receiptRef: receipt.ref, evidenceDigest: retailEvidenceDigest(retailEvidence(db, receipt.ref)), decision, before: receipt.canonical,
    chosen: decision === 'canonical' ? other as string : null };
};
const review = (decision: RetailReviewDecisionInput, sha: string) => reviewRetailReceipts(db,
  { format: 'holdr.retail-receipt-review', version: 1, decisions: [decision] },
  { now: RETAIL_TEST_NOW, authority: { kind: 'go', goId: 'f'.repeat(32), purpose: 'copy-rehearsal' }, reviewSha256: sha, planDigest: null });

describe('retail reservation: no writer can emit a reserved value (plan §5.7, condition 2)', () => {
  it('excludes every reserved value from every writer\'s type', () => {
    type IsNever<T> = [T] extends [never] ? true : false;
    const excluded: [
      IsNever<Extract<RetailImportOutcome, 'progression'>>,
      IsNever<Extract<RetailSightingDecision['outcome'], 'progression'>>,
      IsNever<Extract<RetailWrittenEventKind, 'progression'>>,
      IsNever<Extract<RetailEventInsert['kind'], 'progression'>>,
      IsNever<Extract<RetailWrittenDecision, 'correct'>>,
      IsNever<Extract<RetailReviewDecisionInput['decision'], 'correct'>>,
      IsNever<Extract<keyof RetailEventInsert, 'witness' | 'witnessObservationRef' | 'progressionRule'>>,
    ] = [true, true, true, true, true, true, true];
    expect(excluded).toEqual([true, true, true, true, true, true, true]);
    expect(RETAIL_WRITTEN_OUTCOMES).toEqual(RETAIL_OUTCOMES.filter((outcome) => outcome !== 'progression'));
    expect(RETAIL_WRITTEN_DECISIONS).toEqual(['canonical', 'keep-quarantined']);
  });

  it('leaves no reserved value after install, every import outcome, holds and both review decisions', () => {
    expect(reservedValuesStored(db)).toEqual(NO_RESERVED);
    const member = () => db.prepare(`SELECT membership_ref FROM retail_memberships WHERE folder = 'costco'`).pluck().get() as string;
    const steps: Array<[string, () => void]> = [
      ['new', () => { importPayload(db, payloadOf([warehouseReceipt(1), warehouseReceipt(2), onlineOrder(3)])); }],
      ['unchanged', () => { importPayload(db, payloadOf([warehouseReceipt(1)])); }],
      ['shared', () => { importPayload(db, payloadOf([warehouseReceipt(1)], { folder: 'costco-2' })); }],
      ['conflict', () => { importPayload(db, payloadOf([warehouseReceipt(2, { date: '2031-01-12' })], { folder: 'costco-2' })); }],
      ['changed', () => { importPayload(db, payloadOf([warehouseReceipt(1, { lines: [warehouseLine(0, 1_000, { metal: goldBar() })] })])); }],
      ['quarantined, with and without a cause', () => {
        importPayload(db, payloadOf([warehouseReceipt(1), warehouseReceipt(2, { date: '2031-01-13' })]));
      }],
      ['older-policy', () => {
        seedLaterSighting(db, member(), warehouseReceipt(7), LATER_LABELS);
        importPayload(db, payloadOf([warehouseReceipt(7)]));
      }],
      ['policy-reread', () => { importPayload(db, payloadOf([warehouseReceipt(7, { lines: [warehouseLine(0, 1_000, { metal: goldBar() })] })])); }],
      ['holds of every class', () => {
        importPayload(db, payloadOf([warehouseReceipt(8)], { held: [heldRecord({ naturalKey: warehouseKey(2) }), heldRecord({ naturalKey: warehouseKey(9) }),
          heldRecord({ naturalKey: null, check: 'record-key', reason: 'unreadable', date: null })] }));
      }],
      ['a receipt created quarantined by a pending hold', () => { importPayload(db, payloadOf([warehouseReceipt(9)])); }],
      ['review: canonical', () => { review(decisionFor(warehouseKey(1), 'canonical'), 'a'.repeat(64)); }],
      ['review: keep-quarantined', () => { review(decisionFor(warehouseKey(2), 'keep-quarantined'), 'b'.repeat(64)); }],
    ];
    for (const [what, step] of steps) {
      step();
      expect(reservedValuesStored(db), what).toEqual(NO_RESERVED);
    }
    const written = db.prepare(`SELECT ${RETAIL_OUTCOMES.map((outcome) => `sum(${retailCountColumn(outcome)}) AS "${outcome}"`).join(', ')}
      FROM retail_imports`).get() as Record<string, number>;
    expect(['new', 'unchanged', 'shared', 'conflict', 'changed', 'quarantined', 'older-policy', 'policy-reread'].filter((outcome) => !(written[outcome] > 0)))
      .toEqual([]);
    expect(rows(db, 'SELECT count(DISTINCT decision) FROM retail_receipt_reviews')).toBe(2);
    expect(rows(db, `SELECT count(*) FROM retail_held`)).toBe(3);
  });
});
