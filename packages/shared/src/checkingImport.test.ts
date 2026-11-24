import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addCheckingDays,
  checkCheckingBalanceChain,
  checkingDatesBetween,
  checkingDayKeys,
  checkingImportDays,
  checkingRangesCover,
  checkingRowKey,
  isCheckingRowKey,
  mergeCheckingRanges,
  summarizeCheckingImport,
  validateCheckingImportPayload,
  type CheckingImportPayload,
  type CheckingImportRow,
  type CheckingImportSegment,
} from './checkingImport.js';

function row(postedDate: string, amountMinor: number, description = 'SYNTHETIC ROW'): CheckingImportRow {
  return { postedDate, amountMinor, description, checkNumber: null, bankType: null, externalIdHash: null };
}

function segment(start: string, end: string, rows: CheckingImportRow[], source = 'ofx'): CheckingImportSegment {
  return { source, coverage: { start, end }, anchors: [], rows };
}

function payload(segments: CheckingImportSegment[]): CheckingImportPayload {
  return {
    format: 'holdr.checking-import',
    version: 1,
    parserVersion: 'holdr-checking-import@1.0.0',
    account: { institution: 'wellsfargo', type: 'checking', last4: '2931', label: 'Wells Fargo Everyday Checking', currency: 'USD' },
    segments,
  };
}

describe('checking import contract', () => {
  it('keys rows by content: date, amount and occurrence, in letter hex', () => {
    const key = checkingRowKey('2026-10-05', -5000, 0);
    assert.ok(isCheckingRowKey(key));
    assert.match(key, /^chkd1:[a-p]{64}$/);
    // Pinned: the canonical form is versioned, so a change here must bump CHECKING_KEY_VERSION.
    assert.equal(key, checkingRowKey('2026-10-05', -5000, 0));
    assert.notEqual(key, checkingRowKey('2026-10-05', -5000, 1));
    assert.notEqual(key, checkingRowKey('2026-10-06', -5000, 0));
    assert.equal(checkingRowKey('2026-10-05', -0, 0), checkingRowKey('2026-10-05', 0, 0));
    const keys = checkingDayKeys([row('2026-10-05', -5000, 'ZELLE'), row('2026-10-05', 300000), row('2026-10-05', -5000, 'ATM')]);
    assert.deepEqual(keys, [checkingRowKey('2026-10-05', -5000, 0), checkingRowKey('2026-10-05', 300000, 0), checkingRowKey('2026-10-05', -5000, 1)]);
    assert.throws(() => checkingRowKey('2026-02-30', 1, 0), /valid YYYY-MM-DD/);
  });

  it('merges ranges that overlap or touch, and answers whether they cover a span', () => {
    const merged = mergeCheckingRanges([
      { start: '2026-10-10', end: '2026-10-20' }, { start: '2026-09-01', end: '2026-09-30' }, { start: '2026-10-01', end: '2026-10-05' },
    ]);
    assert.deepEqual(merged, [{ start: '2026-09-01', end: '2026-10-05' }, { start: '2026-10-10', end: '2026-10-20' }]);
    assert.ok(checkingRangesCover(merged, '2026-09-15', '2026-10-05'));
    assert.ok(!checkingRangesCover(merged, '2026-10-05', '2026-10-10'));
    assert.equal(checkingDatesBetween('2024-02-28', '2024-03-01').length, 3);
    assert.equal(addCheckingDays('2026-01-01', -1), '2025-12-31');
  });

  it('counts a day two segments share once, and finds days they disagree on', () => {
    const qfx = segment('2026-10-01', '2026-10-10', [row('2026-10-02', -25000), row('2026-10-05', 300000), row('2026-10-05', -5000)]);
    const csv = segment('2026-10-02', '2026-10-10', [row('2026-10-02', -25000, 'OTHER WORDS'), row('2026-10-05', -5000), row('2026-10-05', 300000)], 'wf-csv');
    const { days, disagreements } = checkingImportDays([qfx, csv]);
    assert.equal(days.length, 10);
    assert.deepEqual(disagreements, []);
    const missing = segment('2026-10-02', '2026-10-10', [row('2026-10-02', -25000), row('2026-10-05', 300000)], 'wf-csv');
    assert.deepEqual(checkingImportDays([qfx, missing]).disagreements, ['2026-10-05']);
  });

  it('checks that stated balances follow from the rows, and leaves uncovered stretches as gaps', () => {
    const nets = new Map([['2026-10-01', 0], ['2026-10-02', -25000], ['2026-10-03', 0], ['2026-10-05', 295000]]);
    const dayNet = (date: string) => nets.get(date) ?? null;
    const ok = checkCheckingBalanceChain([
      { date: '2026-09-30', balanceMinor: 100000 }, { date: '2026-10-03', balanceMinor: 75000 }, { date: '2026-10-05', balanceMinor: 370000 },
    ], dayNet);
    // 10-04 is not covered: the second pair is a gap, not a mismatch.
    assert.deepEqual(ok, { checked: 1, gaps: 1, mismatches: [] });
    const bad = checkCheckingBalanceChain([{ date: '2026-09-30', balanceMinor: 100000 }, { date: '2026-10-03', balanceMinor: 75001 }], dayNet);
    assert.deepEqual(bad.mismatches, ['2026-10-03']);
    const contradicting = checkCheckingBalanceChain([{ date: '2026-09-30', balanceMinor: 1 }, { date: '2026-09-30', balanceMinor: 2 }], dayNet);
    assert.deepEqual(contradicting.mismatches, ['2026-09-30']);
  });

  it('accepts a complete payload and summarizes it with counts and dates only', () => {
    const valid = payload([
      { ...segment('2026-09-01', '2026-09-30', [row('2026-09-10', 100000)], 'wf-statement'),
        anchors: [{ date: '2026-08-31', balanceMinor: 200000, kind: 'opening' }, { date: '2026-09-30', balanceMinor: 300000, kind: 'closing' }] },
      segment('2026-10-01', '2026-10-20', [row('2026-10-02', -25000)]),
    ]);
    const result = validateCheckingImportPayload(valid);
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    const summary = summarizeCheckingImport(valid);
    assert.deepEqual(summary.coverage, [{ start: '2026-09-01', end: '2026-10-20' }]);
    assert.equal(summary.days, 50);
    assert.equal(summary.rows, 2);
    assert.equal(summary.anchors, 2);
    assert.deepEqual(summary.bySource, { 'wf-statement': { segments: 1, rows: 1 }, ofx: { segments: 1, rows: 1 } });
    assert.ok(!JSON.stringify(summary).includes('100000'));
    // Any slug is a source, even one an object inherits; it is counted as its own key and touches no prototype.
    const inherited = summarizeCheckingImport(payload([segment('2026-10-01', '2026-10-02', [row('2026-10-01', 1)], 'constructor')]));
    assert.ok(Object.prototype.hasOwnProperty.call(inherited.bySource, 'constructor'));
    assert.deepEqual(inherited.bySource.constructor, { segments: 1, rows: 1 });
    assert.equal(({} as Record<string, unknown>).segments, undefined);
    assert.equal((Object as unknown as Record<string, unknown>).segments, undefined);
  });

  it('refuses malformed payloads, naming paths and never values', () => {
    const refuse = (mutate: (value: Record<string, any>) => void, path: RegExp) => {
      const value = JSON.parse(JSON.stringify(payload([segment('2026-10-01', '2026-10-20', [row('2026-10-02', -25000)])])));
      mutate(value);
      const result = validateCheckingImportPayload(value);
      assert.equal(result.ok, false);
      assert.ok(result.issues.some((issue) => path.test(issue.path)), JSON.stringify(result.issues));
      for (const issue of result.issues) assert.ok(!/4111|9876542931|SECRET/.test(`${issue.path} ${issue.message}`));
    };
    refuse((v) => { v.extra = 1; }, /^\$$/);
    refuse((v) => { v.format = 'holdr.card-import'; }, /\$\.format/);
    refuse((v) => { v.account.label = 'Checking 9876542931'; }, /\$\.account\.label/);
    refuse((v) => { v.account.last4 = '387'; }, /\$\.account\.last4/);
    refuse((v) => { v.segments[0].rows[0].postedDate = '2026-10-21'; }, /rows\[0\]\.postedDate/);
    refuse((v) => { v.segments[0].rows[0].amountMinor = 1.5; }, /rows\[0\]\.amountMinor/);
    refuse((v) => { v.segments[0].rows[0].description = 'CARD 4111111111111111'; }, /rows\[0\]\.description/);
    refuse((v) => { v.segments[0].rows[0].description = 'CVV 123 SECRET'; }, /rows\[0\]\.description/);
    refuse((v) => { v.segments[0].rows[0].checkNumber = '12345678901'; }, /checkNumber/);
    refuse((v) => { v.segments[0].rows[0].bankType = 'X98765429'; }, /bankType/);
    // Slugs are letters and hyphens: no digit of an account number can ride in one.
    refuse((v) => { v.account.institution = 'bank9876542931'; }, /\$\.account\.institution/);
    refuse((v) => { v.segments[0].source = 'csv2931'; }, /\$\.segments\[0\]\.source/);
    refuse((v) => { v.segments[0].anchors = [{ date: '2026-09-29', balanceMinor: 1, kind: 'opening' }]; }, /anchors\[0\]\.date/);
    refuse((v) => { v.segments[0].anchors = [{ date: '2026-10-01', balanceMinor: 1, kind: 'guess' }]; }, /anchors\[0\]\.kind/);
    refuse((v) => { v.segments[0].rows.push(row('2026-10-01', 5)); }, /rows\[1\]\.postedDate/);
    refuse((v) => { v.segments.push(segment('2026-09-01', '2026-09-30', [])); }, /\$\.segments\[1\]/);
    refuse((v) => { v.segments.push(segment('2026-10-01', '2026-10-20', [], 'wf-csv')); }, /\$\.segments/);
  });
});
