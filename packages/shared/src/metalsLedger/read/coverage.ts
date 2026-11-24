/**
 * Coverage arithmetic and its reviewed basis (card cross-check design v3.2 §6.3, G1d C5): one function for what an
 * account's complete imports cover of a need and what they miss, so the measures' `not-covered` (views.ts
 * coverageGaps) and the coverage proof's `imported-window` gaps never re-derive it apart.
 *
 * - Only complete entries of the account and kind count.
 * - The basis is per entry (METALS_COVERAGE_BASIS) and no answer changes it. `whole-history` only for an entry stated
 *   under a reviewed full-count contract (CollectPure's sell orders, from a CollectPure capture under a reviewed
 *   converter version): it covers every day up to its `to`, since its `from` is only its earliest record. Any other
 *   entry is a `window`, covering [from, to] alone. `stated = seen` never earns whole-history.
 * - Ranges merge when they overlap or touch (adjacent days), as views.ts mergeRanges. A null start is unbounded before.
 *
 * Pure: no file system, network or clock.
 */

import { METALS_CAPTURE_SCHEMAS, type MetalsCoverageKind, type MetalsSource } from '../model.js';

/** One coverage range an import stated for an account and kind, with the provenance its basis reads. */
export interface MetalsStatedCoverage {
  accountId: string;
  source: MetalsSource;
  kind: MetalsCoverageKind;
  from: string;
  to: string;
  complete: boolean;
  /**
   * Provenance of the import that stated it, as stored:
   * - capture_schema is null when the import isn't a capture (apps/api schema.ts:226, :264-265);
   * - converter_version is the full 'holdr-metals-convert x.y.z' (schema.ts:220-222).
   */
  captureSchema: string | null;
  converterVersion: string;
}

/** A kind whose complete coverage counts as whole history: the source, kind, capture schema and converter versions. */
export interface MetalsWholeHistoryBasis {
  readonly source: MetalsSource;
  readonly kind: MetalsCoverageKind;
  readonly captureSchema: string;
  readonly converterVersions: readonly string[];
}

export const METALS_COVERAGE_BASIS: { readonly rule: 'metals-coverage-basis-v1'; readonly wholeHistory: readonly MetalsWholeHistoryBasis[] } =
  Object.freeze({
    rule: 'metals-coverage-basis-v1' as const,
    /**
     * Whole-history entries: CollectPure's sell-orders only, under their full-count contract (collectpure.ts:703-714),
     * from the reviewed converters as stored: 1.0.0 (main) and 1.1.0 (#349), whose sell-orders count and coverage are
     * byte-identical. A new converter version earns nothing until a review adds it here.
     */
    wholeHistory: Object.freeze([Object.freeze<MetalsWholeHistoryBasis>({
      source: 'collectpure', kind: 'sell-orders', captureSchema: METALS_CAPTURE_SCHEMAS.collectpure,
      converterVersions: Object.freeze(['holdr-metals-convert 1.0.0', 'holdr-metals-convert 1.1.0']),
    })]),
  });

export type MetalsCoverageBasis = 'whole-history' | 'window';

/** An entry's basis: whole-history only for a complete entry matching a listed source, kind, schema and version. */
export function metalsCoverageBasisOf(entry: MetalsStatedCoverage): MetalsCoverageBasis {
  if (!entry.complete || entry.captureSchema === null) return 'window';
  return METALS_COVERAGE_BASIS.wholeHistory.some((basis) => basis.source === entry.source && basis.kind === entry.kind
    && basis.captureSchema === entry.captureSchema && basis.converterVersions.includes(entry.converterVersion)) ? 'whole-history' : 'window';
}

/** A run of days, both ends inclusive; a null `from` is unbounded before. */
export interface MetalsDayRange {
  from: string | null;
  to: string;
}

const DAY_MS = 86_400_000;
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
/** Null (unbounded) sorts first, then by day. */
const compareStart = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1);

/** Overlapping or touching ranges merged, in order; a range ending before it starts covers nothing and is dropped. */
function mergeDays(ranges: ReadonlyArray<MetalsDayRange>): MetalsDayRange[] {
  const sorted = ranges.filter((range) => range.from === null || range.from <= range.to)
    .sort((a, b) => compareStart(a.from, b.from) || (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  const merged: MetalsDayRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && (range.from === null || range.from <= addDays(last.to, 1))) {
      if (range.to > last.to) last.to = range.to;
    } else merged.push({ from: range.from, to: range.to });
  }
  return merged;
}

/**
 * What ranges cover of a need and what they miss, by day: `covered` is the merged ranges clipped to the need, `missing`
 * the rest of it. A need from after its `to` is empty: nothing covered, nothing missing.
 */
export function metalsRangeCoverage(ranges: ReadonlyArray<MetalsDayRange>, need: MetalsDayRange): { covered: MetalsDayRange[]; missing: MetalsDayRange[] } {
  const covered: MetalsDayRange[] = [];
  const missing: MetalsDayRange[] = [];
  if (need.from !== null && need.from > need.to) return { covered, missing };
  // The first day of the need not yet placed (null: unbounded before); null with `done` once the need is placed.
  let cursor: string | null = need.from;
  let done = false;
  for (const range of mergeDays(ranges)) {
    if (range.from !== null && range.from > need.to) break;
    if (cursor !== null && range.to < cursor) continue;
    let start = cursor;
    if (range.from !== null && (cursor === null || range.from > cursor)) {
      missing.push({ from: cursor, to: addDays(range.from, -1) });
      start = range.from;
    }
    const end = range.to < need.to ? range.to : need.to;
    covered.push({ from: start, to: end });
    if (end === need.to) {
      done = true;
      break;
    }
    cursor = addDays(end, 1);
  }
  if (!done) missing.push({ from: cursor, to: need.to });
  return { covered, missing };
}

/**
 * What an account's complete coverage of a kind covers of a need, with each entry's basis: the one computation behind
 * the measures' `not-covered` (a gap exactly when `missing` isn't empty) and the proof's `imported-window` gaps.
 */
export function metalsCoverageOf(entries: readonly MetalsStatedCoverage[], need: { accountId: string; kind: MetalsCoverageKind; from: string | null; to: string }):
  { covered: MetalsDayRange[]; missing: MetalsDayRange[] } {
  const ranges = entries.filter((entry) => entry.accountId === need.accountId && entry.kind === need.kind && entry.complete)
    .map((entry): MetalsDayRange => ({ from: metalsCoverageBasisOf(entry) === 'whole-history' ? null : entry.from, to: entry.to }));
  return metalsRangeCoverage(ranges, { from: need.from, to: need.to });
}
