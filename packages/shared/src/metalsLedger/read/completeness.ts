/**
 * Completeness, on every measure the ledger reports (design v8 §8): a value or none, a state, and the reasons it is not
 * complete, each a closed code with the number of records it concerns. Unknown is never zero: a measure with no value
 * is `unknown`, one with any reason is `partial`.
 *
 * Pure: no file system, network or clock.
 */

export const METALS_COMPLETENESS_CODES = [
  'content-unknown',
  'unmatched-sales',
  // Only while the owner's estimate switch names the metal (estimate.ts): a cost of sold units with no recorded purchase
  // is estimated from the nearest purchase of their class, never recorded.
  'cost-estimated',
  'cost-unattributed',
  'conflict',
  'date-unknown',
  'price-missing',
  'price-stale',
  'source-held',
  'not-covered',
] as const;
export type MetalsCompletenessCode = (typeof METALS_COMPLETENESS_CODES)[number];
export type MetalsCompletenessState = 'complete' | 'partial' | 'unknown';

export interface MetalsCompletenessReason {
  code: MetalsCompletenessCode;
  records: number;
}

export interface MetalsMeasure<T> {
  value: T | null;
  state: MetalsCompletenessState;
  reasons: MetalsCompletenessReason[];
}

/** Collects reasons as records are read; each record is counted once per code. */
export class MetalsReasons {
  private readonly records = new Map<MetalsCompletenessCode, Set<string>>();

  add(code: MetalsCompletenessCode, record: string): this {
    let set = this.records.get(code);
    if (!set) this.records.set(code, (set = new Set()));
    set.add(record);
    return this;
  }

  addAll(other: MetalsReasons): this {
    for (const [code, records] of other.records) for (const record of records) this.add(code, record);
    return this;
  }

  get size(): number {
    return this.records.size;
  }

  has(code: MetalsCompletenessCode): boolean {
    return this.records.has(code);
  }

  /** The reasons in the closed list's order, with their record counts. */
  list(): MetalsCompletenessReason[] {
    return METALS_COMPLETENESS_CODES.filter((code) => this.records.has(code))
      .map((code) => ({ code, records: this.records.get(code)!.size }));
  }
}

/** A measure: `unknown` without a value, `partial` with any reason, otherwise `complete`. */
export function metalsMeasure<T>(value: T | null, reasons: MetalsReasons = new MetalsReasons()): MetalsMeasure<T> {
  const list = reasons.list();
  return { value, state: value === null ? 'unknown' : list.length > 0 ? 'partial' : 'complete', reasons: list };
}
