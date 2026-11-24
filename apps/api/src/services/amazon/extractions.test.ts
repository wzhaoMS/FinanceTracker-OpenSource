import { describe, expect, it } from 'vitest';
import {
  largestRemainderUnits,
  lineAmount as sharedLineAmount,
  taxShare as sharedTaxShare,
  uniqueBothWays,
} from '@finance-tracker/shared';
import { largestRemainder } from './allocation.js';
import { matchAmazon } from './matcher.js';
import { lineAmount, taxShare, type RefundLine, type RefundOrder } from './refundCredits.js';
import { opaque } from './policy.js';
import { syntheticCards, syntheticRow, syntheticSubject } from './fixtures.testSupport.js';
import type { Binding, Candidate, LedgerRow, MatchSubject } from './types.js';

/**
 * Amazon after the shared extractions (Costco receipts 4/7 §2.1; Root's Q-L1, Amazon byte-identical by frozen
 * oracles). The oracle: frozen copies of the Amazon domain's largestRemainder, taxShare, lineAmount and its matcher's
 * one-to-one rule as main (8a15a955) defined them, before they were extracted, with the checks they call written out.
 * They live in this test only; nothing imports them. Synthetic data only, over generated tables.
 */
const minor = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const ref = (v: unknown): v is string => typeof v === 'string' && /^amz-[a-f0-9]{48}$/.test(v);
function frozenLargestRemainder(total: number, weights: readonly { ref: string; weight: number; tie?: string }[]): Map<string, number> {
  if (!minor(total) || total < 0 || !weights.length || new Set(weights.map(w => w.ref)).size !== weights.length
    || new Set(weights.map(w => w.tie ?? w.ref)).size !== weights.length
    || weights.some(w => !ref(w.ref) || (w.tie !== undefined && !ref(w.tie)) || !minor(w.weight) || w.weight <= 0)) {
    throw Error('amazon allocation refused');
  }
  const denominator = weights.reduce((n, w) => n + BigInt(w.weight), 0n);
  const parts = weights.map(w => ({ ref: w.ref, tie: w.tie ?? w.ref, units: BigInt(total) * BigInt(w.weight) / denominator,
    remainder: BigInt(total) * BigInt(w.weight) % denominator }));
  let left = BigInt(total) - parts.reduce((n, p) => n + p.units, 0n);
  parts.sort((a, b) => a.remainder === b.remainder ? (a.tie < b.tie ? -1 : 1) : a.remainder > b.remainder ? -1 : 1);
  for (const p of parts) if (left > 0n) { p.units++; left--; }
  return new Map(parts.map(p => [p.ref, Number(p.units)]));
}
const frozenPositive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
function frozenTaxShare(baseMinor: number, taxMinor: number, itemsSubtotalMinor: number | null): number {
  if (!frozenPositive(taxMinor) || !frozenPositive(itemsSubtotalMinor)) return 0;
  const subtotal = BigInt(itemsSubtotalMinor);
  return Number((2n * BigInt(baseMinor) * BigInt(taxMinor) + subtotal) / (2n * subtotal));
}
function frozenLineAmount(order: Pick<RefundOrder, 'taxMinor' | 'itemsSubtotalMinor'>, line: RefundLine, units: number): number {
  const base = line.unitMinor * units;
  return base + frozenTaxShare(base, order.taxMinor, order.itemsSubtotalMinor);
}
/** The matcher's two computations as main had them: row degrees over the unaliased candidates, then each subject's link. */
function frozenLinks(candidates: readonly Candidate[], aliases: ReadonlySet<string>, subjects: readonly string[]): Array<string | null> {
  const hitsBySubject = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const hits = hitsBySubject.get(c.subjectRef) ?? [];
    hits.push(c); hitsBySubject.set(c.subjectRef, hits);
  }
  const rowDegrees = new Map<string, number>();
  for (const c of candidates) if (!aliases.has(c.subjectRef)) {
    rowDegrees.set(c.cardTransactionId, (rowDegrees.get(c.cardTransactionId) ?? 0) + 1);
  }
  return subjects.map(subject => {
    const hits = hitsBySubject.get(subject) ?? [];
    return !aliases.has(subject) && hits.length === 1 && rowDegrees.get(hits[0].cardTransactionId) === 1 ? hits[0].cardTransactionId : null;
  });
}

/**
 * What an action was refused with: the Amazon allocation's own refusal, by its exact message, or null when it answered.
 * Any other error is re-thrown unchanged, never turned into a result.
 */
function allocationRefusal(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    if (error instanceof Error && error.constructor === Error && error.message === 'amazon allocation refused') return error.message;
    throw error;
  }
}

/** Every k-tuple of the values, in order. */
const tuples = <T>(values: readonly T[], k: number): T[][] =>
  k === 0 ? [[]] : tuples(values, k - 1).flatMap(rest => values.map(value => [...rest, value]));
const REFS = [0, 1, 2, 3].map(n => opaque('synthetic-extraction-ref', n));
const TIES = [0, 1, 2, 3].map(n => opaque('synthetic-extraction-tie', n)).sort();

/** Weight lists of one to three weights, with no ties, ascending ties, descending ties and some ties only. */
function weightLists(): Array<Array<{ ref: string; weight: number; tie?: string }>> {
  const lists: Array<Array<{ ref: string; weight: number; tie?: string }>> = [];
  for (const k of [1, 2, 3]) {
    for (const weights of tuples([1, 2, 3, 7], k)) {
      lists.push(weights.map((weight, i) => ({ ref: REFS[i], weight })));
      lists.push(weights.map((weight, i) => ({ ref: REFS[i], weight, tie: TIES[i] })));
      lists.push(weights.map((weight, i) => ({ ref: REFS[i], weight, tie: TIES[k - 1 - i] })));
      lists.push(weights.map((weight, i) => ({ ref: REFS[i], weight, ...(i % 2 ? { tie: TIES[3] } : {}) })));
    }
  }
  return lists;
}
const TOTALS = [...Array.from({ length: 26 }, (_, n) => n), 100, 1001, 2 ** 31, Number.MAX_SAFE_INTEGER];

describe('largestRemainder after the extraction', () => {
  it('answers every valid table entry exactly as main did, the order of its entries included', () => {
    const allocationMismatches: string[] = [];
    let compared = 0;
    for (const weights of weightLists()) {
      for (const total of TOTALS) {
        const expected = JSON.stringify([...frozenLargestRemainder(total, weights)]);
        const actual = JSON.stringify([...largestRemainder(total, weights)]);
        // The shared core alone, given the domain's ties (a missing tie is the ref).
        const units = largestRemainderUnits(BigInt(total), weights.map(w => ({ ref: w.ref, weight: BigInt(w.weight), tie: w.tie ?? w.ref })));
        const core = JSON.stringify([...units].map(([key, n]) => [key, Number(n)]));
        compared += 1;
        if (actual !== expected || core !== expected) allocationMismatches.push(`${total} ${JSON.stringify(weights)}: ${actual} / ${core} vs ${expected}`);
      }
    }
    expect(compared).toBe(336 * TOTALS.length);
    expect(allocationMismatches).toEqual([]);
  });

  it('refuses every invalid table entry exactly as main did', () => {
    const one = [{ ref: REFS[0], weight: 1 }];
    const invalid: Array<[number, Array<{ ref: string; weight: number; tie?: string }>]> = [
      [-1, one], [1.5, one], [Number.NaN, one], [2 ** 53, one], [1, []],
      [1, [{ ref: REFS[0], weight: 0 }]], [1, [{ ref: REFS[0], weight: -1 }]], [1, [{ ref: REFS[0], weight: 1.5 }]],
      [1, [{ ref: REFS[0], weight: 2 ** 53 }]], [1, [{ ref: 'not-a-ref', weight: 1 }]], [1, [{ ref: REFS[0], weight: 1, tie: 'not-a-ref' }]],
      [1, [{ ref: REFS[0], weight: 1 }, { ref: REFS[0], weight: 2 }]],
      [1, [{ ref: REFS[0], weight: 1, tie: TIES[0] }, { ref: REFS[1], weight: 2, tie: TIES[0] }]],
      [1, [{ ref: REFS[0], weight: 1, tie: REFS[1] }, { ref: REFS[1], weight: 2 }]],
    ];
    const outcomes = invalid.map(([total, weights]) =>
      [allocationRefusal(() => frozenLargestRemainder(total, weights)), allocationRefusal(() => largestRemainder(total, weights))]);
    expect(outcomes).toEqual(invalid.map(() => ['amazon allocation refused', 'amazon allocation refused']));
  });
});

describe('taxShare and lineAmount after the extraction', () => {
  it('are the shared functions themselves, under the domain\'s names', () => {
    expect(taxShare).toBe(sharedTaxShare);
    expect(lineAmount).toBe(sharedLineAmount);
  });

  it('share every table entry\'s tax exactly as main did, every half included', () => {
    const bases = [-3, 0, 1, 2, 3, 5, 250, 999, 1000, 1500, 3000, 99_999, 2 ** 40];
    const taxes = [-1, 0, 1, 2, 3, 250, 400, 2.5, Number.NaN, 2 ** 53];
    const subtotals = [null, -1, 0, 1, 2, 3, 4, 100, 4000, 5000, 1.5, 2 ** 53];
    const taxMismatches: string[] = [];
    for (const base of bases) for (const tax of taxes) for (const subtotal of subtotals) {
      const expected = frozenTaxShare(base, tax, subtotal);
      if (!Object.is(taxShare(base, tax, subtotal), expected)) taxMismatches.push(`${base} ${tax} ${subtotal}`);
    }
    expect(taxMismatches).toEqual([]);
  });

  it('price every table entry\'s units exactly as main did', () => {
    const unitMismatches: string[] = [];
    for (const taxMinor of [0, 1, 7, 250, 401]) for (const itemsSubtotalMinor of [null, 0, 1, 4000, 4001, 12_345]) {
      for (const unitMinor of [1, 3, 199, 500, 2499]) for (const units of [0, 1, 2, 3, 12]) {
        const order = { taxMinor, itemsSubtotalMinor }, line = { key: 'synthetic-line', unitMinor, qty: 12 };
        const expected = frozenLineAmount(order, line, units);
        if (!Object.is(lineAmount(order, line, units), expected)) unitMismatches.push(`${taxMinor} ${itemsSubtotalMinor} ${unitMinor}x${units}`);
      }
    }
    expect(unitMismatches).toEqual([]);
  });
});

describe('the matcher\'s one-to-one rule after the extraction', () => {
  /** The rule as the matcher now applies it: the shared uniqueBothWays over the unaliased candidates. */
  const shared = (candidates: readonly Candidate[], aliases: ReadonlySet<string>, subjects: readonly string[]) => {
    const oneToOne = uniqueBothWays(candidates.filter(c => !aliases.has(c.subjectRef))
      .map(c => ({ subject: c.subjectRef, row: c.cardTransactionId })));
    return subjects.map(subject => (!aliases.has(subject) ? oneToOne.linked(subject) : null));
  };
  const SUBJECTS = ['s0', 's1', 's2', 's3'];
  const candidate = (subjectRef: string, cardTransactionId: string): Candidate =>
    ({ subjectRef, cardTransactionId, evidenceClass: 'payment-event' });

  it('links every generated candidate graph\'s subjects exactly as main did, aliases and repeated edges included', () => {
    const graphs: Candidate[][] = [];
    // Three subjects by two rows, each pair absent, once or twice; and three by three, each pair absent or once.
    for (const counts of tuples([0, 1, 2], 6)) {
      graphs.push(counts.flatMap((count, i) => Array.from({ length: count }, () => candidate(SUBJECTS[i % 3], `r${Math.floor(i / 3)}`))));
    }
    for (const counts of tuples([0, 1], 9)) {
      graphs.push(counts.flatMap((count, i) => (count ? [candidate(SUBJECTS[i % 3], `r${Math.floor(i / 3)}`)] : [])));
    }
    const graphMismatches: string[] = [];
    let compared = 0;
    for (const graph of graphs) {
      for (const aliased of tuples([false, true], 3)) {
        const aliases = new Set(SUBJECTS.filter((_, i) => aliased[i]));
        const expected = frozenLinks(graph, aliases, SUBJECTS), actual = shared(graph, aliases, SUBJECTS);
        compared += 1;
        if (JSON.stringify(actual) !== JSON.stringify(expected)) graphMismatches.push(`${JSON.stringify(graph)} ${[...aliases]}`);
      }
    }
    expect(compared).toBe((729 + 512) * 8);
    expect(graphMismatches).toEqual([]);
  });

  it('links matchAmazon\'s own candidates as main\'s rule would, over generated subjects and rows, aliases included', () => {
    const bindings: Binding[] = syntheticCards.map(c => ({ network: 'visa', last4: c.last4!, cardAccountId: c.id }));
    const scenarios: Array<{ name: string; subjects: MatchSubject[]; rows: LedgerRow[] }> = [];
    for (const subjectCount of [1, 2, 3]) for (const subjectAmounts of tuples([1100, 1200], subjectCount)) {
      for (const rowCount of [1, 2, 3]) for (const rowAmounts of tuples([1100, 1200], rowCount)) {
        scenarios.push({ name: `${subjectAmounts} / ${rowAmounts}`,
          subjects: subjectAmounts.map((amountMinor, i) => syntheticSubject({
            ref: opaque('synthetic-extraction-subject', i), nativeOccurrenceId: `synthetic-extraction-occurrence-${i}`,
            money: { currency: 'USD', amountMinor } })),
          rows: rowAmounts.map((amountMinor, i) => syntheticRow({ id: `synthetic-extraction-row-${i}`, amountMinor })) });
      }
    }
    // A payments-ledger observation of an order whose total is uniquely matched is superseded by that total, and one
    // observed again in a later run corroborates the first: either way it is an alias, which claims no row.
    const total = syntheticSubject({ ref: opaque('synthetic-extraction-total', 0), evidenceClass: 'unique-total-match',
      nativeOccurrenceId: null, provenance: 'order-total' });
    const ledger = (run: number) => syntheticSubject({ ref: opaque('synthetic-extraction-ledger', run),
      evidenceClass: 'payment-ledger-complete', nativeOccurrenceId: null,
      ledgerObservation: { captureDigest: `synthetic-extraction-capture-${run}`, runId: `synthetic-extraction-run-${run}`, page: 1, ordinal: 0 } });
    for (const rowCount of [1, 2]) {
      const rows = Array.from({ length: rowCount }, (_, i) => syntheticRow({ id: `synthetic-extraction-row-${i}` }));
      scenarios.push({ name: `superseded / ${rowCount} rows`, subjects: [total, ledger(1)], rows },
        { name: `corroborated / ${rowCount} rows`, subjects: [ledger(1), ledger(2)], rows });
    }
    const matcherMismatches: string[] = [];
    let linked = 0, held = 0, aliased = 0;
    for (const { name, subjects, rows } of scenarios) {
      const { candidates, results } = matchAmazon(subjects, rows, bindings);
      // Which subjects are aliases is decided before the one-to-one rule, which the oracle takes as given.
      const aliases = new Set(results.filter(r => r.corroboratedBy !== undefined).map(r => r.subjectRef));
      const expected = frozenLinks(candidates, aliases, subjects.map(s => s.ref));
      const actual = results.map(r => (r.state === 'linked' ? r.cardTransactionId : null));
      if (JSON.stringify(actual) !== JSON.stringify(expected)) matcherMismatches.push(name);
      aliased += aliases.size;
      for (const link of actual) if (link === null) held += 1; else linked += 1;
    }
    // The table holds links, holds and aliases.
    expect([linked > 0, held > 0, aliased > 0]).toEqual([true, true, true]);
    expect(matcherMismatches).toEqual([]);
  });
});
