import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { METALS_CONVERTER } from '../converters/common.js';
import { METALS_CAPTURE_SCHEMAS, type MetalsCoverageKind, type MetalsSource } from '../model.js';
import {
  METALS_COVERAGE_BASIS,
  metalsCoverageBasisOf,
  metalsCoverageOf,
  metalsRangeCoverage,
  type MetalsStatedCoverage,
} from './coverage.js';

/** Synthetic coverage only: invented accounts and windows. Converter versions are stored in full. */
const entry = (from: string, to: string, overrides: Partial<MetalsStatedCoverage> = {}): MetalsStatedCoverage => ({
  accountId: 'acct-1', source: 'costco', kind: 'online', from, to, complete: true, captureSchema: null,
  converterVersion: 'holdr-metals-convert 1.0.0', ...overrides,
});
const sellOrders = (from: string, to: string, overrides: Partial<MetalsStatedCoverage> = {}) => entry(from, to, {
  accountId: 'acct-cp', source: 'collectpure', kind: 'sell-orders', captureSchema: METALS_CAPTURE_SCHEMAS.collectpure, ...overrides,
});

describe('coverage basis (§6.3, C5; control 29)', () => {
  it('names CollectPure\'s sell orders alone as whole history, under the reviewed converter set in full', () => {
    assert.equal(METALS_COVERAGE_BASIS.rule, 'metals-coverage-basis-v1');
    assert.deepEqual(METALS_COVERAGE_BASIS.wholeHistory.map((basis) => ({ ...basis, converterVersions: [...basis.converterVersions] })), [{
      source: 'collectpure', kind: 'sell-orders', captureSchema: 'holdr-retail-capture/collectpure@1',
      converterVersions: ['holdr-metals-convert 1.0.0', 'holdr-metals-convert 1.1.0'],
    }]);
    assert.ok(Object.isFrozen(METALS_COVERAGE_BASIS) && Object.isFrozen(METALS_COVERAGE_BASIS.wholeHistory));
    assert.ok(Object.isFrozen(METALS_COVERAGE_BASIS.wholeHistory[0]) && Object.isFrozen(METALS_COVERAGE_BASIS.wholeHistory[0].converterVersions));
  });

  it('tripwire: the reviewed set includes the current converter, so a version bump fails here until it is reviewed', () => {
    assert.ok(METALS_COVERAGE_BASIS.wholeHistory[0].converterVersions.includes(METALS_CONVERTER), METALS_CONVERTER);
    assert.equal(metalsCoverageBasisOf(sellOrders('2030-05-01', '2030-09-30', { converterVersion: METALS_CONVERTER })), 'whole-history');
  });

  it('a complete CollectPure sell-orders capture under either reviewed converter is whole history', () => {
    for (const converterVersion of ['holdr-metals-convert 1.0.0', 'holdr-metals-convert 1.1.0']) {
      assert.equal(metalsCoverageBasisOf(sellOrders('2030-05-01', '2030-09-30', { converterVersion })), 'whole-history', converterVersion);
    }
  });

  it('the wrong schema, version, kind or source, a null schema or an incomplete entry is never whole history', () => {
    const variants: Array<[string, Partial<MetalsStatedCoverage>]> = [
      ['incomplete', { complete: false }],
      ['no capture schema (a retail payload)', { captureSchema: null }],
      ['another schema', { captureSchema: METALS_CAPTURE_SCHEMAS.walmart }],
      ['the bare version earns nothing', { converterVersion: '1.0.0' }],
      ['the bare later version earns nothing', { converterVersion: '1.1.0' }],
      ['an unreviewed version', { converterVersion: 'holdr-metals-convert 9.9.9' }],
      ['payouts are always a window', { kind: 'payouts' }],
      ['another source', { source: 'walmart' }],
    ];
    for (const [label, overrides] of variants) {
      assert.equal(metalsCoverageBasisOf(sellOrders('2030-05-01', '2030-09-30', overrides)), 'window', label);
    }
    assert.equal(metalsCoverageBasisOf(entry('2030-05-01', '2030-09-30')), 'window');
    assert.equal(metalsCoverageBasisOf(entry('2030-05-01', '2030-09-30', { source: 'walmart', captureSchema: METALS_CAPTURE_SCHEMAS.walmart })), 'window');
  });

  it('a whole-history entry covers the days before its from; a window entry, even of the same account and kind, doesn\'t', () => {
    const need = { accountId: 'acct-cp', kind: 'sell-orders' as const, from: '2030-01-01', to: '2030-09-30' };
    assert.deepEqual(metalsCoverageOf([sellOrders('2030-05-01', '2030-09-30')], need),
      { covered: [{ from: '2030-01-01', to: '2030-09-30' }], missing: [] });
    assert.deepEqual(metalsCoverageOf([sellOrders('2030-05-01', '2030-09-30', { converterVersion: '1.0.0' })], need),
      { covered: [{ from: '2030-05-01', to: '2030-09-30' }], missing: [{ from: '2030-01-01', to: '2030-04-30' }] });
    // Two entries of one account and kind: only the whole-history one reaches back; the window ends where it ends.
    const both = [sellOrders('2030-05-01', '2030-06-30'), sellOrders('2030-08-01', '2030-09-30', { captureSchema: null })];
    assert.deepEqual(metalsCoverageOf(both, need),
      { covered: [{ from: '2030-01-01', to: '2030-06-30' }, { from: '2030-08-01', to: '2030-09-30' }], missing: [{ from: '2030-07-01', to: '2030-07-31' }] });
    // From an unknown start (acquisitionStart null): whole history covers it, a window never does.
    const open = { ...need, from: null };
    assert.deepEqual(metalsCoverageOf([sellOrders('2030-05-01', '2030-09-30')], open), { covered: [{ from: null, to: '2030-09-30' }], missing: [] });
    assert.deepEqual(metalsCoverageOf([sellOrders('2030-05-01', '2030-09-30', { kind: 'payouts' })], { ...open, kind: 'payouts' }),
      { covered: [{ from: '2030-05-01', to: '2030-09-30' }], missing: [{ from: null, to: '2030-04-30' }] });
  });

  it('whole history still ends at its to', () => {
    const result = metalsCoverageOf([sellOrders('2030-05-01', '2030-08-31')], { accountId: 'acct-cp', kind: 'sell-orders', from: null, to: '2030-09-30' });
    assert.deepEqual(result, { covered: [{ from: null, to: '2030-08-31' }], missing: [{ from: '2030-09-01', to: '2030-09-30' }] });
  });
});

describe('coverage arithmetic (C5)', () => {
  it('counts only complete entries of the account and kind', () => {
    const need = { accountId: 'acct-1', kind: 'online' as const, from: '2030-03-01', to: '2030-03-31' };
    const others = [entry('2030-03-01', '2030-03-31', { complete: false }), entry('2030-03-01', '2030-03-31', { accountId: 'acct-2' }),
      entry('2030-03-01', '2030-03-31', { kind: 'warehouse' })];
    assert.deepEqual(metalsCoverageOf(others, need), { covered: [], missing: [{ from: '2030-03-01', to: '2030-03-31' }] });
    assert.deepEqual(metalsCoverageOf([...others, entry('2030-02-01', '2030-04-30')], need),
      { covered: [{ from: '2030-03-01', to: '2030-03-31' }], missing: [] });
  });

  it('merges overlapping and touching ranges, and clips them to the need', () => {
    const ranges = [{ from: '2030-03-11', to: '2030-03-20' }, { from: '2030-03-01', to: '2030-03-10' }, { from: '2030-03-15', to: '2030-03-25' }];
    assert.deepEqual(metalsRangeCoverage(ranges, { from: '2030-03-05', to: '2030-03-31' }),
      { covered: [{ from: '2030-03-05', to: '2030-03-25' }], missing: [{ from: '2030-03-26', to: '2030-03-31' }] });
  });

  it('names every missing part, a gap between ranges included', () => {
    const ranges = [{ from: '2030-03-05', to: '2030-03-10' }, { from: '2030-03-20', to: '2030-03-22' }];
    assert.deepEqual(metalsRangeCoverage(ranges, { from: '2030-03-01', to: '2030-03-31' }), {
      covered: [{ from: '2030-03-05', to: '2030-03-10' }, { from: '2030-03-20', to: '2030-03-22' }],
      missing: [{ from: '2030-03-01', to: '2030-03-04' }, { from: '2030-03-11', to: '2030-03-19' }, { from: '2030-03-23', to: '2030-03-31' }],
    });
  });

  it('a null need start is unbounded: missing up to the day before the first covered day, or all of it', () => {
    assert.deepEqual(metalsRangeCoverage([{ from: '2030-03-05', to: '2030-03-10' }], { from: null, to: '2030-03-08' }),
      { covered: [{ from: '2030-03-05', to: '2030-03-08' }], missing: [{ from: null, to: '2030-03-04' }] });
    assert.deepEqual(metalsRangeCoverage([], { from: null, to: '2030-03-08' }), { covered: [], missing: [{ from: null, to: '2030-03-08' }] });
    assert.deepEqual(metalsRangeCoverage([{ from: '2030-04-01', to: '2030-04-10' }], { from: null, to: '2030-03-08' }),
      { covered: [], missing: [{ from: null, to: '2030-03-08' }] });
  });

  it('an empty need misses nothing and covers nothing; a range ending before it starts covers nothing', () => {
    assert.deepEqual(metalsRangeCoverage([{ from: '2030-03-01', to: '2030-03-31' }], { from: '2030-03-10', to: '2030-03-09' }), { covered: [], missing: [] });
    assert.deepEqual(metalsRangeCoverage([{ from: '2030-03-10', to: '2030-03-01' }], { from: '2030-03-01', to: '2030-03-10' }),
      { covered: [], missing: [{ from: '2030-03-01', to: '2030-03-10' }] });
  });

  it('both ends are inclusive', () => {
    assert.deepEqual(metalsRangeCoverage([{ from: '2030-03-10', to: '2030-03-10' }], { from: '2030-03-10', to: '2030-03-10' }),
      { covered: [{ from: '2030-03-10', to: '2030-03-10' }], missing: [] });
    assert.deepEqual(metalsRangeCoverage([{ from: '2030-03-01', to: '2030-03-09' }], { from: '2030-03-10', to: '2030-03-12' }),
      { covered: [], missing: [{ from: '2030-03-10', to: '2030-03-12' }] });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The reference: views.ts's coverageGaps predicate (apps/api/src/services/metalsRead/views.ts:157-159, :184-206, :442-453).
// ---------------------------------------------------------------------------------------------------------------------

interface Range {
  from: string;
  to: string;
}
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const earlierDay = (a: string | null, b: string | null): string | null => (a === null ? b : b === null || a < b ? a : b);
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
function mergeRanges(ranges: readonly Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => compareText(a.from, b.from) || compareText(a.to, b.to));
  const merged: Range[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.from <= addDays(last.to, 1)) {
      if (range.to > last.to) last.to = range.to;
    } else merged.push({ ...range });
  }
  return merged;
}
function spans(ranges: readonly Range[], from: string, to: string): boolean {
  if (from > to) return true;
  let next = from;
  for (const range of ranges) {
    if (range.from > next) return false;
    if (range.to >= next) next = addDays(range.to, 1);
    if (next > to) return true;
  }
  return next > to;
}
/** Whether coverageGaps lists `<accountId>|<kind>` for one account and kind. */
function referenceGap(entries: readonly MetalsStatedCoverage[], accountId: string, kind: MetalsCoverageKind, from: string | null, to: string,
  options: { historyStart?: string | null; earlierOfFirstCovered?: boolean } = {}): boolean {
  const ranges = mergeRanges(entries.filter((item) => item.accountId === accountId && item.kind === kind && item.complete)
    .map((item) => ({ from: item.from, to: item.to })));
  const first = ranges[0]?.from ?? null;
  const uncovered = first === null || (from !== null && to < first);
  const start = from === null ? earlierDay(first, options.historyStart ?? null) : options.earlierOfFirstCovered ? earlierDay(from, first) : from;
  return uncovered || start === null || !spans(ranges, start, to);
}

/** A seeded generator (mulberry32), as cardLinks.test.ts's. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return (bound: number) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * bound);
  };
}

describe('coverage arithmetic equals the measures\' not-covered (C5, seeded)', () => {
  it('the reference reports a gap exactly when metalsCoverageOf misses a day, for every dated need', () => {
    const next = seeded(4_242);
    const day = (offset: number) => addDays('2030-01-01', offset);
    let gaps = 0;
    let spanned = 0;
    for (let round = 0; round < 600; round += 1) {
      const entries: MetalsStatedCoverage[] = [];
      for (let index = 0; index < 1 + next(5); index += 1) {
        const from = next(100);
        entries.push(entry(day(from), day(from + next(60)), {
          accountId: next(5) === 0 ? 'acct-2' : 'acct-1', kind: next(5) === 0 ? 'warehouse' : 'online', complete: next(6) !== 0,
        }));
      }
      const from = day(next(120));
      const to = addDays(from, next(45) - 5);
      const historyStart = next(3) === 0 ? null : day(next(100));
      const first = mergeRanges(entries.filter((item) => item.accountId === 'acct-1' && item.kind === 'online' && item.complete)
        .map((item) => ({ from: item.from, to: item.to })))[0]?.from ?? null;
      const needs: Array<[string | null, boolean, string | null]> = [
        // [the reference's from, earlierOfFirstCovered, the dated need it amounts to]
        [from, false, from],
        [from, true, earlierDay(from, first)],
        [null, false, earlierDay(first, historyStart)],
      ];
      for (const [referenceFrom, earlierOfFirstCovered, start] of needs) {
        if (start === null || start > to) continue;
        const reference = referenceGap(entries, 'acct-1', 'online', referenceFrom, to, { historyStart, earlierOfFirstCovered });
        const { missing } = metalsCoverageOf(entries, { accountId: 'acct-1', kind: 'online', from: start, to });
        assert.equal(missing.length > 0, reference, `round ${round}: ${JSON.stringify({ referenceFrom, earlierOfFirstCovered, start, to })}`);
        if (reference) gaps += 1; else spanned += 1;
      }
    }
    assert.ok(gaps > 30 && spanned > 30, `both outcomes are exercised (${gaps} gaps, ${spanned} spanned)`);
  });

  it('a kind never covered completely misses its whole dated need, as the reference reports it uncovered', () => {
    const entries = [entry('2030-03-01', '2030-03-31', { complete: false })];
    assert.equal(referenceGap(entries, 'acct-1', 'online', '2030-03-01', '2030-03-31'), true);
    assert.deepEqual(metalsCoverageOf(entries, { accountId: 'acct-1', kind: 'online', from: '2030-03-01', to: '2030-03-31' }).missing,
      [{ from: '2030-03-01', to: '2030-03-31' }]);
  });

  it('every source and kind reads its basis from the entry alone', () => {
    const sources: MetalsSource[] = ['costco', 'walmart', 'collectpure'];
    for (const source of sources) {
      for (const kind of ['online', 'warehouse', 'sell-orders', 'payouts'] as const) {
        const basis = metalsCoverageBasisOf(sellOrders('2030-05-01', '2030-09-30', { source, kind }));
        assert.equal(basis, source === 'collectpure' && kind === 'sell-orders' ? 'whole-history' : 'window', `${source} ${kind}`);
      }
    }
  });
});
