import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { RetailImportReceipt } from '@finance-tracker/shared/retail-import-payload';

import {
  planRetailReview,
  retailEvidence,
  retailEvidenceDigest,
  retailQuarantine,
  retailReviewOf,
  reviewRetailReceipts,
  type RetailReviewDecisionInput,
  type RetailReviewFile,
} from './index.js';
import { RETAIL_TEST_NOW, importPayload, refusalOf, retailTestDb, rows } from '../../testing/retailDb.js';
import {
  SYNTHETIC_RETAIL_VALUES,
  heldRecord,
  syntheticRetailPayload,
  valueFreeText,
  warehouseKey,
  warehouseLine,
  warehouseReceipt,
} from '../../testing/retailPayloads.js';

// Reviews (plan v5 §6, refinement 4, 3ddfcd26's P3) and D-R2-5, on in-memory databases with synthetic payloads.

let db: Database.Database;
let capture = 0;
beforeEach(() => { db = retailTestDb(); capture = 0; });
afterEach(() => { db.close(); });

const GO = { kind: 'go' as const, goId: 'f'.repeat(32), purpose: 'copy-rehearsal' };
const load = (receipts: RetailImportReceipt[], options: Parameters<typeof syntheticRetailPayload>[0] = {}) =>
  importPayload(db, syntheticRetailPayload({ capture: 'bcdefghijklmnop'[capture++ % 15], receipts, ...options }));
const receiptOf = (key: string) => db.prepare(`SELECT receipt_ref AS ref, state, first_reason AS firstReason, canonical_version AS canonical
  FROM retail_receipts WHERE natural_key = ?`).get(key) as { ref: string; state: string; firstReason: string | null; canonical: string };
const otherVersion = (key: string) => db.prepare(`SELECT v.version_ref FROM retail_receipt_versions v JOIN retail_receipts r ON r.receipt_ref = v.receipt_ref
  WHERE r.natural_key = ? AND v.version_ref <> r.canonical_version ORDER BY v.version_ref LIMIT 1`).pluck().get(key) as string;
const decisionFor = (key: string, decision: 'canonical' | 'keep-quarantined' = 'keep-quarantined'): RetailReviewDecisionInput => {
  const receipt = receiptOf(key);
  return { receiptRef: receipt.ref, evidenceDigest: retailEvidenceDigest(retailEvidence(db, receipt.ref)), decision, before: receipt.canonical,
    chosen: decision === 'canonical' ? otherVersion(key) : null };
};
const file = (decisions: RetailReviewDecisionInput[]): RetailReviewFile => ({
  format: 'holdr.retail-receipt-review', version: 1, decisions: [...decisions].sort((a, b) => (a.receiptRef < b.receiptRef ? -1 : 1)),
});
const apply = (review: RetailReviewFile, sha = 'c'.repeat(64)) =>
  reviewRetailReceipts(db, review, { now: RETAIL_TEST_NOW, authority: GO, reviewSha256: sha, planDigest: null });
/** Two quarantined receipts, 1 and 2, each changed once by the same membership. */
function twoQuarantined(): void {
  load([warehouseReceipt(1), warehouseReceipt(2)]);
  load([warehouseReceipt(1, { date: '2031-01-12', lines: [warehouseLine(0, 1_300)] }), warehouseReceipt(2, { date: '2031-01-13' })]);
}

describe('retail review files: shape first, then the exact file, then every pin (§6)', () => {
  it('refuses a file of the wrong shape before anything is looked up', () => {
    const decision = { receiptRef: `rcp-${'a'.repeat(32)}`, evidenceDigest: 'b'.repeat(64), decision: 'canonical', before: `rrv-${'c'.repeat(32)}`,
      chosen: `rrv-${'d'.repeat(32)}` };
    const later = { ...decision, receiptRef: `rcp-${'b'.repeat(32)}` };
    const bad: Array<[string, unknown]> = [
      ['no decision', { format: 'holdr.retail-receipt-review', version: 1, decisions: [] }],
      ['another format', { format: 'holdr.retail-review', version: 1, decisions: [decision] }],
      ['a version as text', { format: 'holdr.retail-receipt-review', version: '1', decisions: [decision] }],
      ['a receipt twice', { format: 'holdr.retail-receipt-review', version: 1, decisions: [decision, decision] }],
      ['decisions out of order', { format: 'holdr.retail-receipt-review', version: 1, decisions: [later, decision] }],
      ['the reserved decision', { format: 'holdr.retail-receipt-review', version: 1, decisions: [{ ...decision, decision: 'correct' }] }],
      ['canonical with nothing chosen', { format: 'holdr.retail-receipt-review', version: 1, decisions: [{ ...decision, chosen: null }] }],
      ['keep-quarantined choosing a version', { format: 'holdr.retail-receipt-review', version: 1,
        decisions: [{ ...decision, decision: 'keep-quarantined' }] }],
      ['an evidence digest in capitals', { format: 'holdr.retail-receipt-review', version: 1, decisions: [{ ...decision, evidenceDigest: 'B'.repeat(64) }] }],
      ['a receipt of another shape', { format: 'holdr.retail-receipt-review', version: 1, decisions: [{ ...decision, receiptRef: 'rcp-1' }] }],
      ['decisions that are no list', { format: 'holdr.retail-receipt-review', version: 1, decisions: decision }],
    ];
    const closed = new Database(':memory:');
    closed.close();
    for (const [what, value] of bad) {
      expect(refusalOf(() => retailReviewOf(value as RetailReviewFile)).code, what).toBe('retail-review-invalid');
      // Nothing is read: even a closed database answers the shape's refusal.
      expect(refusalOf(() => reviewRetailReceipts(closed, value as RetailReviewFile, { now: RETAIL_TEST_NOW, authority: GO,
        reviewSha256: 'c'.repeat(64), planDigest: null })).code, what).toBe('retail-review-invalid');
    }
    expect(retailReviewOf({ format: 'holdr.retail-receipt-review', version: 1, decisions: [decision, later] }).decisions).toHaveLength(2);
  });

  it('records a review file all or nothing: one stale decision refuses the whole file', () => {
    twoQuarantined();
    const stale = { ...decisionFor(warehouseKey(1)), evidenceDigest: 'a'.repeat(64) };
    const before = rows(db, 'SELECT count(*) FROM retail_receipt_reviews');
    expect(refusalOf(() => apply(file([stale, decisionFor(warehouseKey(2))]))).code).toBe('retail-review-stale');
    expect(rows(db, 'SELECT count(*) FROM retail_receipt_reviews')).toBe(before);
    expect(rows(db, `SELECT count(*) FROM retail_receipt_events WHERE kind = 'review'`)).toBe(0);
    const applied = apply(file([decisionFor(warehouseKey(1), 'canonical'), decisionFor(warehouseKey(2))]));
    expect(applied).toMatchObject({ code: 'retail-reviewed', alreadyReviewed: false, throughImportSeq: 2 });
    expect(applied.decisions.map((entry) => entry.decision).sort()).toEqual(['canonical', 'keep-quarantined']);
    expect(receiptOf(warehouseKey(1)).state).toBe('active');
    expect(receiptOf(warehouseKey(2))).toMatchObject({ state: 'quarantined', firstReason: 'receipt-changed' });
  });

  it('answers the exact file again as already reviewed, after later evidence too, before any stale check', () => {
    twoQuarantined();
    const review = file([decisionFor(warehouseKey(2))]);
    expect(apply(review).code).toBe('retail-reviewed');
    load([warehouseReceipt(2)]);
    load([], { held: [heldRecord({ naturalKey: warehouseKey(2) })] });
    const again = apply(review);
    expect(again).toMatchObject({ code: 'retail-already-reviewed', alreadyReviewed: true });
    expect(again.decisions[0].reviewRef).toMatch(/^rtl-rev-[a-p]{32}$/);
    expect(planRetailReview(db, review, 'c'.repeat(64)).alreadyReviewed).toBe(true);
    // The same decisions in another file are a new review, pinned to the evidence now: stale.
    expect(refusalOf(() => apply(review, 'd'.repeat(64))).code).toBe('retail-review-stale');
    expect(rows(db, 'SELECT count(*) FROM retail_receipt_reviews')).toBe(1);
  });

  it('refuses an unknown receipt, an active one, and a before or chosen version that is not the receipt\'s', () => {
    twoQuarantined();
    load([warehouseReceipt(3)]);
    const active = receiptOf(warehouseKey(3));
    const cases: Array<[string, RetailReviewDecisionInput, string]> = [
      ['unknown', { ...decisionFor(warehouseKey(1)), receiptRef: `rcp-${'p'.repeat(32)}` }, 'retail-receipt-unknown'],
      ['active', { receiptRef: active.ref, evidenceDigest: retailEvidenceDigest(retailEvidence(db, active.ref)), decision: 'keep-quarantined',
        before: active.canonical, chosen: null }, 'retail-receipt-not-quarantined'],
      ['before not the canonical', { ...decisionFor(warehouseKey(1)), before: otherVersion(warehouseKey(1)) }, 'retail-review-invalid'],
      ['chosen of another receipt', { ...decisionFor(warehouseKey(1), 'canonical'), chosen: otherVersion(warehouseKey(2)) }, 'retail-review-invalid'],
    ];
    for (const [what, decision, code] of cases) expect(refusalOf(() => apply(file([decision]))).code, what).toBe(code);
    expect(rows(db, 'SELECT count(*) FROM retail_receipt_reviews')).toBe(0);
    expect(refusalOf(() => reviewRetailReceipts(db, file([decisionFor(warehouseKey(1))]), { now: RETAIL_TEST_NOW, authority: { kind: 'preview' },
      reviewSha256: 'c'.repeat(64), planDigest: null })).code).toBe('retail-go-id-invalid');
  });
});

describe('retail reviews: what a decision changes (§6, D-R2-5)', () => {
  it('reads a receipt\'s facts through its canonical version: a review choosing another shows its date and totals at once', () => {
    twoQuarantined();
    const facts = () => db.prepare(`SELECT v.date, v.subtotal_minor AS subtotal, v.total_minor AS total FROM retail_receipts r
      JOIN retail_receipt_versions v ON v.version_ref = r.canonical_version WHERE r.natural_key = ?`).get(warehouseKey(1));
    const versions = () => db.prepare('SELECT * FROM retail_receipt_versions ORDER BY version_ref').all();
    const stored = versions();
    expect(facts()).toEqual({ date: '2031-01-10', subtotal: 1_000, total: 1_080 });
    apply(file([decisionFor(warehouseKey(1), 'canonical')]));
    expect(facts()).toEqual({ date: '2031-01-12', subtotal: 1_300, total: 1_380 });
    expect(versions()).toEqual(stored);
  });

  it('keeps a receipt quarantined on keep-quarantined, recording the decision and nothing else', () => {
    twoQuarantined();
    const before = receiptOf(warehouseKey(2));
    apply(file([decisionFor(warehouseKey(2))]));
    expect(receiptOf(warehouseKey(2))).toEqual(before);
    expect(db.prepare(`SELECT e.kind, e.state, e.first_reason AS firstReason FROM retail_receipt_events e
      JOIN retail_receipts r ON r.receipt_ref = e.receipt_ref WHERE r.natural_key = ? ORDER BY e.seq DESC LIMIT 1`).get(warehouseKey(2)))
      .toEqual({ kind: 'review', state: 'quarantined', firstReason: 'receipt-changed' });
  });
});

describe('retail quarantine listing (§6, §8.3)', () => {
  it('lists each quarantined receipt by refs, reasons, digest prefixes, policies and dates, and no fact a review would need to see', () => {
    expect(retailQuarantine(db)).toEqual({ code: 'retail-quarantine-listed', schema: 'present', receipts: [] });
    twoQuarantined();
    load([warehouseReceipt(5)], { held: [heldRecord({ naturalKey: warehouseKey(1) })] });
    const list = retailQuarantine(db);
    expect(list.receipts).toHaveLength(2);
    const one = list.receipts.find((entry) => entry.receiptRef === receiptOf(warehouseKey(1)).ref)!;
    expect(one).toMatchObject({ firstReason: 'receipt-changed', canonicalVersion: receiptOf(warehouseKey(1)).canonical,
      evidenceDigest: retailEvidenceDigest(retailEvidence(db, one.receiptRef)) });
    expect(one.causes.map((cause) => cause.reason)).toEqual(['receipt-changed', 'receipt-held-later']);
    expect(one.held).toHaveLength(1);
    expect(one.observations).toHaveLength(2);
    expect(one.versions).toHaveLength(2);
    for (const version of one.versions) {
      expect(version).toEqual({ versionRef: expect.stringMatching(/^rrv-[a-p]{32}$/), source: expect.stringMatching(/^[a-p]{12}$/),
        meaning: expect.stringMatching(/^[a-p]{12}$/), provenance: expect.stringMatching(/^[a-p]{12}$/), policyVersion: 5,
        date: expect.stringMatching(/^2031-01-1[02]$/) });
    }
    expect(valueFreeText(JSON.stringify(list))).not.toMatch(SYNTHETIC_RETAIL_VALUES);
    expect(JSON.stringify(list)).not.toMatch(/1080|1380|1300/);
    const absent = new Database(':memory:');
    try {
      expect(retailQuarantine(absent)).toEqual({ code: 'retail-quarantine-listed', schema: 'absent', receipts: [] });
    } finally {
      absent.close();
    }
  });
});
