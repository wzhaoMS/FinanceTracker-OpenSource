import { describe, expect, it } from 'vitest';

import {
  RETAIL_BUILD_LABELS,
  RETAIL_POLICY_DIGEST,
  RETAIL_VERSION_TAGS,
  classifyRetailSighting,
  retailCapturedAt,
  retailMoneyDiffers,
  retailOccurrences,
  retailStorageProblems,
  retailTextProblem,
  retailVersionOf,
  type RetailLineMoney,
  type RetailSightingReceipt,
  type RetailVersionComparable,
  type RetailVersionLabels,
} from './index.js';
import { LATER_LABELS } from '../../testing/retailDb.js';
import { goldBar, onlineLine, onlineOrder, syntheticRetailPayload, uncertainGold, warehouseLine, warehouseReceipt } from '../../testing/retailPayloads.js';

// Pure: §5.2's digests and money, §5.3's table, the storage check's clauses. Synthetic receipts only.

const SAME_POLICY_OTHER_LABELS: RetailVersionLabels = { ...RETAIL_BUILD_LABELS, titleRule: 'title-rule-v9' };
const OLDER_THAN_LATER = RETAIL_BUILD_LABELS;

const version = (receipt = warehouseReceipt(1), labels: RetailVersionLabels = RETAIL_BUILD_LABELS) => retailVersionOf(receipt, labels);
const plain = version();
const otherSource = version(warehouseReceipt(1, { date: '2031-01-11' }));
const metalLine = warehouseReceipt(1, { lines: [warehouseLine(0, 1_000, { metal: goldBar() })] });
const withMetal = version(metalLine);
const active = (canonical: RetailVersionComparable): RetailSightingReceipt => ({ state: 'active', canonical });
const quarantined = (canonical: RetailVersionComparable): RetailSightingReceipt => ({ state: 'quarantined', canonical });
const classify = (incoming: RetailVersionComparable, receipt: RetailSightingReceipt | null, seen = true) =>
  classifyRetailSighting({ receipt, incoming, seenByMembership: seen });
type MutableMoney = { currency: string; sign: string; totals: Array<number | null>; lines: Map<string, RetailLineMoney>; tenders: Map<string, number> };
const withMoney = (base: RetailVersionComparable, change: (money: MutableMoney) => void): RetailVersionComparable => {
  const money: MutableMoney = { ...base.money, totals: [...base.money.totals], lines: new Map(base.money.lines), tenders: new Map(base.money.tenders) };
  change(money);
  return { ...base, money };
};

describe('retail versions: three digests (plan §5.2)', () => {
  it('reads stated facts into the source digest, derived facts into the meaning digest, and labels into provenance only', () => {
    expect(withMetal.sourceDigest).toBe(plain.sourceDigest);
    expect(withMetal.meaningDigest).not.toBe(plain.meaningDigest);
    expect(version(warehouseReceipt(1, { lines: [warehouseLine(0, 1_000, { metalUncertain: uncertainGold() })] })).meaningDigest)
      .not.toBe(plain.meaningDigest);
    expect(version(warehouseReceipt(1, { lines: [warehouseLine(0, 1_000, { storedValue: 'costco-shop-card' })] })).meaningDigest)
      .not.toBe(plain.meaningDigest);
    // The rule's own label is provenance, never meaning: the same metal under another rule label means the same.
    expect(version(warehouseReceipt(1, { lines: [warehouseLine(0, 1_000, { metal: goldBar({ rule: 'title-rule-v3' }) })] }), LATER_LABELS).meaningDigest)
      .toBe(withMetal.meaningDigest);
    const relabelled = version(warehouseReceipt(1), LATER_LABELS);
    expect([relabelled.sourceDigest, relabelled.meaningDigest]).toEqual([plain.sourceDigest, plain.meaningDigest]);
    expect(relabelled.provenanceDigest).not.toBe(plain.provenanceDigest);
    expect(version(warehouseReceipt(1), SAME_POLICY_OTHER_LABELS).provenanceDigest).not.toBe(plain.provenanceDigest);
    for (const change of [{ date: '2031-01-12' }, { localTime: '10:16' }, { taxMinor: 81 },
      { lines: [warehouseLine(0, 1_000, { title: 'SAMPLE OTHER' })] }, { taxLegends: [{ legend: 'A', amountMinor: 80 }] }]) {
      expect(version(warehouseReceipt(1, change)).sourceDigest).not.toBe(plain.sourceDigest);
    }
    for (const digest of [plain.sourceDigest, plain.meaningDigest, plain.provenanceDigest]) expect(digest).toMatch(/^[a-p]{64}$/);
  });

  it('pins its tags and the policy digest a GO names', () => {
    expect(RETAIL_VERSION_TAGS).toEqual({
      SOURCE_TAG: 'holdr.retail-version-source', MEANING_TAG: 'holdr.retail-version-meaning', PROVENANCE_TAG: 'holdr.retail-version-provenance',
      SHIPMENT_TAG: 'holdr.retail-shipment-observation', TENDER_TAG: 'holdr.retail-tender-observation',
    });
    expect(RETAIL_BUILD_LABELS).toEqual({ policyVersion: 5, titleRule: 'title-rule-v3', metalGuard: 'metal-guard-v1', packRule: 'metals-pack-v2' });
    expect(RETAIL_POLICY_DIGEST).toMatch(/^[0-9a-f]{64}$/);
  });

  it('counts each observation among identical ones before it', () => {
    expect(retailOccurrences(['a', 'a', 'b', 'a', 'b'])).toEqual([1, 2, 1, 3, 2]);
    expect(retailOccurrences([])).toEqual([]);
  });
});

describe('retail sightings: §5.3, against the canonical version, first row that applies', () => {
  it('decides each row', () => {
    expect(classify(plain, null)).toEqual({ outcome: 'new', reason: null, moves: false });
    expect(classify(plain, quarantined(plain))).toEqual({ outcome: 'quarantined', reason: null, moves: false });
    expect(classify(otherSource, active(plain), false)).toEqual({ outcome: 'conflict', reason: 'duplicate-across-memberships', moves: false });
    expect(classify(otherSource, active(plain))).toEqual({ outcome: 'changed', reason: 'receipt-changed', moves: false });
    expect(classify(withMetal, active(plain))).toEqual({ outcome: 'changed', reason: 'receipt-changed', moves: false });
    expect(classify(version(warehouseReceipt(1), SAME_POLICY_OTHER_LABELS), active(plain))).toEqual({ outcome: 'changed', reason: 'receipt-changed', moves: false });
    expect(classify(version(warehouseReceipt(1, { date: '2031-01-11' }), LATER_LABELS), active(plain)))
      .toEqual({ outcome: 'policy-reread', reason: 'policy-reread-changed', moves: false });
    expect(classify(version(metalLine, LATER_LABELS), active(plain))).toEqual({ outcome: 'policy-reread', reason: 'policy-reread-changed', moves: false });
    expect(classify(version(warehouseReceipt(1), LATER_LABELS), active(plain))).toEqual({ outcome: 'provenance-refresh', reason: null, moves: true });
    expect(classify(plain, active(version(warehouseReceipt(1), LATER_LABELS)))).toEqual({ outcome: 'older-policy', reason: null, moves: false });
    expect(classify(plain, active(plain))).toEqual({ outcome: 'unchanged', reason: null, moves: false });
    expect(classify(plain, active(plain), false)).toEqual({ outcome: 'shared', reason: null, moves: false });
  });

  it('orders each adjacent pair of rows: the earlier row decides where both could', () => {
    // new / quarantined: no receipt is new, whatever else holds.
    expect(classify(otherSource, null, false).outcome).toBe('new');
    // quarantined / conflict: a quarantined receipt stays quarantined, with conflict's reason as a cause.
    expect(classify(otherSource, quarantined(plain), false)).toEqual({ outcome: 'quarantined', reason: 'duplicate-across-memberships', moves: false });
    // conflict / changed: a source difference from a membership that hasn't seen it is a conflict, at the same policy too.
    expect(classify(otherSource, active(plain), false).outcome).toBe('conflict');
    // changed / policy-reread: a source and a meaning difference under an older policy is changed.
    const later = version(warehouseReceipt(1), LATER_LABELS);
    expect(classify(version(warehouseReceipt(1, { date: '2031-01-11', lines: [warehouseLine(0, 1_000, { metal: goldBar() })] })), active(later)).outcome)
      .toBe('changed');
    // policy-reread / provenance-refresh: meaning and labels both differ under a newer policy: held, the canonical stays.
    expect(classify(version(metalLine, LATER_LABELS), active(plain))).toEqual({ outcome: 'policy-reread', reason: 'policy-reread-changed', moves: false });
    // provenance-refresh / older-policy: labels only, newer refreshes and older is an observation.
    expect(classify(later, active(plain)).outcome).toBe('provenance-refresh');
    expect(classify(plain, active(later)).outcome).toBe('older-policy');
    // older-policy / unchanged, unchanged / shared.
    expect(classify(plain, active(plain), true).outcome).toBe('unchanged');
    expect(classify(plain, active(plain), false).outcome).toBe('shared');
  });

  it('quarantines in both arrival orders (D-COSTCO-1, D-R3-1)', () => {
    const a = version(warehouseReceipt(1, { lines: [warehouseLine(0, 1_000, { metal: goldBar() })] }));
    const b = version(warehouseReceipt(1), LATER_LABELS);
    // A older and metal, B newer and no metal, same source: held either way, the canonical kept.
    expect(classify(b, active(a))).toEqual({ outcome: 'policy-reread', reason: 'policy-reread-changed', moves: false });
    expect(classify(a, active(b))).toEqual({ outcome: 'policy-reread', reason: 'policy-reread-changed', moves: false });
    for (const [first, second] of [[plain, otherSource], [otherSource, plain]]) {
      expect(classify(second, active(first), false).reason).toBe('duplicate-across-memberships');
      expect(classify(second, active(first), true).reason).toBe('receipt-changed');
    }
  });

  it('adds no cause for a labels-only or identical version on a quarantined receipt, and moves nothing', () => {
    for (const incoming of [plain, version(warehouseReceipt(1), LATER_LABELS)]) {
      expect(classify(incoming, quarantined(plain))).toEqual({ outcome: 'quarantined', reason: null, moves: false });
    }
    expect(classify(version(metalLine, LATER_LABELS), quarantined(plain)).reason).toBe('policy-reread-changed');
  });

  it('compares money directly: equal digests with one differing amount are each held', () => {
    const online = version(onlineOrder(1, { lines: [onlineLine(1, 0, 5_000, { shippingMinor: 300 })], shopCards: [1_000] }));
    const changes: Array<[string, RetailVersionComparable, (money: MutableMoney) => void]> = [
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((index): [string, RetailVersionComparable, (money: MutableMoney) => void] =>
        [`total ${index}`, online, (money) => { money.totals[index] = (money.totals[index] ?? 0) + 1; }]),
      ['a null total against a stated zero', plain, (money) => { money.totals[3] = 0; }],
      ['a line amount', online, (money) => { const [key, line] = [...money.lines][0]; money.lines.set(key, { ...line, amountMinor: line.amountMinor + 1 }); }],
      ['a unit price', online, (money) => { const [key, line] = [...money.lines][0]; money.lines.set(key, { ...line, unitPriceMinor: 1 }); }],
      ['a line shipping', online, (money) => { const [key, line] = [...money.lines][0]; money.lines.set(key, { ...line, shippingMinor: 0 }); }],
      ['a missing line', online, (money) => { money.lines.clear(); }],
      ['an extra line', online, (money) => { money.lines.set('ordinal:9', { amountMinor: 0, unitPriceMinor: 0, shippingMinor: 0 }); }],
      ['a tender amount', online, (money) => {
        const [key] = [...money.tenders][0];
        money.tenders.delete(key);
        money.tenders.set(key.replace(/\d+\]$/, '1]'), 1);
      }],
      ['a missing tender', online, (money) => { money.tenders.delete([...money.tenders.keys()][0]); }],
      ['an extra tender', online, (money) => { money.tenders.set('["cash","unknown",null,1]', 1); }],
      ['a repeated tender', online, (money) => { const [key, count] = [...money.tenders][0]; money.tenders.set(key, count + 1); }],
      ['the sign', plain, (money) => { money.sign = 'refund'; }],
      ['the currency', plain, (money) => { money.currency = 'CAD'; }],
    ];
    for (const [what, base, change] of changes) {
      const incoming = withMoney(base, change);
      expect([incoming.sourceDigest, incoming.meaningDigest, incoming.provenanceDigest], what)
        .toEqual([base.sourceDigest, base.meaningDigest, base.provenanceDigest]);
      expect(retailMoneyDiffers(incoming.money, base.money), what).toBe(true);
      expect(classify(incoming, active(base)), what).toEqual({ outcome: 'changed', reason: 'receipt-changed', moves: false });
      expect(classify(incoming, active(base), false), what).toEqual({ outcome: 'conflict', reason: 'duplicate-across-memberships', moves: false });
    }
    expect(retailMoneyDiffers(online.money, version(onlineOrder(1, { lines: [onlineLine(1, 0, 5_000, { shippingMinor: 300 })], shopCards: [1_000] })).money))
      .toBe(false);
  });
});

describe('retail storage check (plan §4.1): the CHECKs, in the preflight', () => {
  it('normalizes a capture time to its 24-character instant, and refuses one that names no real instant', () => {
    expect(retailCapturedAt('2031-02-03T04:05:06Z')).toBe('2031-02-03T04:05:06.000Z');
    expect(retailCapturedAt('2031-02-03T04:05:06.5Z')).toBe('2031-02-03T04:05:06.500Z');
    expect(retailCapturedAt('2031-02-03T04:05:06.123Z')).toBe('2031-02-03T04:05:06.123Z');
    for (const bad of ['2031-02-30T04:05:06Z', '2031-02-03T24:00:00Z', '2031-02-03T23:60:00Z', '2031-02-03T23:59:60Z', '2031-13-01T00:00:00Z',
      '2031-02-03 04:05:06Z', '2031-02-03T04:05:06+00:00']) {
      expect(retailCapturedAt(bad), bad).toBeNull();
    }
  });

  it('names each free-text clause the CHECK holds', () => {
    expect(retailTextProblem('SAMPLE WIDGET 2 PK', 240)).toBeNull();
    const cases: Array<[unknown, string]> = [
      [3, 'type'], ['', 'length'], ['x'.repeat(241), 'length'], ['A\u0000B', 'nul'], ['A\tB', 'spacing'], ['A\u00a0B', 'spacing'],
      ['A\u2003B', 'spacing'], ['A\u2028B', 'spacing'], ['A\u0085B', 'spacing'], ['A  B', 'double-space'], [' A', 'trim'], ['A ', 'trim'],
      ['A\u200bB', 'forbidden'], ['A\ufeffB', 'forbidden'], ['\u00b2', 'forbidden'], ['=A', 'formula'], ['+A', 'formula'], ['-A', 'formula'],
      ['@A', 'formula'], [`A ${'1'.repeat(13)}`, 'digits'],
    ];
    for (const [value, clause] of cases) expect(retailTextProblem(value, 240), String(clause)).toBe(clause);
    // SQLite counts characters, not UTF-16 units: an astral character is one.
    expect(retailTextProblem('\u{1F600}'.repeat(240), 240)).toBeNull();
  });

  it('accepts every synthetic fixture and names the path of each value the tables would refuse', () => {
    const payload = syntheticRetailPayload({ receipts: [warehouseReceipt(1), onlineOrder(2)] });
    expect(retailStorageProblems(payload)).toEqual([]);
    const broken = structuredClone(payload);
    broken.source.capturedAt = '2031-02-30T04:05:06Z';
    broken.coverage.warehouse[0].seen = 1_000_001;
    broken.receipts[0].lines[0].title = 'A  B';
    broken.receipts[0].taxLegends.push({ legend: 'a\u0000', amountMinor: 1 });
    broken.receipts[1].lines[0].shipments[0].carrier = 'boat' as never;
    expect(retailStorageProblems(broken)).toEqual([
      '$.source.capturedAt', '$.coverage.warehouse[0].seen', '$.receipts[0].taxLegends[0].legend', '$.receipts[0].lines[0].title',
      '$.receipts[1].lines[0].shipments[0]',
    ]);
  });
});
