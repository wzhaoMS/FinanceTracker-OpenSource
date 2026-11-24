import { mergeCardCoverage, type CardCoverageRange } from '@finance-tracker/shared';

import type { CoverageMove, CoverageSpan, ProofHoldCode } from './receipt.js';

/**
 * G-COVERAGE (design v1.1 §3.4). B and A are one card account's merged import coverage before and after the import,
 * read as sets of days, and P is the payload's declared coverage.
 * - C1: B ⊆ A. No covered day is lost.
 * - C2: A \ B ⊆ P. New days come only from this import.
 * - C3: no new gap. A's uncovered days between min(A) and max(A) are a subset of B's.
 * - C4: min(A) = min(B). Coverage never extends backwards.
 * - C5: B ≠ ∅. A first import holds; a supervised step establishes covered-from.
 *
 * C6 (no other account and no pre-existing coverage window changed) is checked on the snapshots (`snapshot.ts`).
 */

const DAY_MS = 86_400_000;
const dayOf = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const dateOf = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

interface DayRange { start: number; end: number }

function days(ranges: readonly CardCoverageRange[]): DayRange[] {
  return mergeCardCoverage(ranges).map((range) => ({ start: dayOf(range.start), end: dayOf(range.end) }));
}

/** The days strictly between consecutive ranges of a merged list. */
function gapsOf(ranges: readonly DayRange[]): DayRange[] {
  const gaps: DayRange[] = [];
  for (let i = 1; i < ranges.length; i += 1) gaps.push({ start: ranges[i - 1].end + 1, end: ranges[i].start - 1 });
  return gaps;
}

const within = (inner: DayRange, outer: readonly DayRange[]) => outer.some((range) => range.start <= inner.start && range.end >= inner.end);

/** `a` minus `b`, both merged and sorted: the days of `a` that `b` does not hold. */
function subtract(a: readonly DayRange[], b: readonly DayRange[]): DayRange[] {
  const out: DayRange[] = [];
  for (const range of a) {
    let pieces: DayRange[] = [{ ...range }];
    for (const cut of b) {
      pieces = pieces.flatMap((piece) => {
        if (cut.end < piece.start || cut.start > piece.end) return [piece];
        const left = cut.start > piece.start ? [{ start: piece.start, end: cut.start - 1 }] : [];
        const right = cut.end < piece.end ? [{ start: cut.end + 1, end: piece.end }] : [];
        return [...left, ...right];
      });
    }
    out.push(...pieces);
  }
  return out;
}

/** The covered span and its uncovered days, or null when nothing is covered. */
export function coverageSpan(ranges: readonly CardCoverageRange[]): CoverageSpan | null {
  const merged = days(ranges);
  if (merged.length === 0) return null;
  const gapDays = gapsOf(merged).reduce((sum, gap) => sum + (gap.end - gap.start + 1), 0);
  return { from: dateOf(merged[0].start), through: dateOf(merged[merged.length - 1].end), gapDays };
}

export interface CoverageVerdict {
  code: ProofHoldCode | null;
  move: CoverageMove;
}

export function checkCoverage(before: readonly CardCoverageRange[], after: readonly CardCoverageRange[],
  payload: CardCoverageRange): CoverageVerdict {
  const b = days(before), a = days(after);
  const p: DayRange = { start: dayOf(payload.start), end: dayOf(payload.end) };
  if (b.length === 0) return { code: 'proof-coverage-first', move: 'none' };
  if (a.length === 0 || subtract(b, a).length > 0) return { code: 'proof-coverage-lost', move: 'none' };
  const added = subtract(a, b);
  if (added.some((range) => !within(range, [p]))) return { code: 'proof-coverage-outside', move: 'none' };
  if (a[0].start < b[0].start) return { code: 'proof-coverage-backward', move: 'none' };
  const gapsBefore = gapsOf(b);
  if (gapsOf(a).some((gap) => !within(gap, gapsBefore))) return { code: 'proof-coverage-gap', move: 'none' };
  const forward = a[a.length - 1].end > b[b.length - 1].end;
  const filled = added.some((range) => range.start <= b[b.length - 1].end);
  const move: CoverageMove = forward && filled ? 'forward+gap-fill' : forward ? 'forward' : filled ? 'gap-fill' : 'none';
  return { code: null, move };
}
