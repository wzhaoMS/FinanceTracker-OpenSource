/**
 * The completeness a coverage entry claims: the most its termination allows
 * (`cardSyncCompletenessCeiling`, contract section 4: `end-marker` with a
 * requested window → complete; `end-marker` without one, `snapshot` and
 * `not-read` → unknown; every stop before the end → partial), and never
 * `complete` once rows were rejected.
 */
import { cardSyncCompletenessCeiling, type CardSyncCompleteness, type CardSyncTermination } from '@finance-tracker/shared';

export function completenessFor(termination: CardSyncTermination, requested: object | null, rejectedCount: number): CardSyncCompleteness {
  const ceiling = cardSyncCompletenessCeiling(termination, requested);
  return ceiling === 'complete' && rejectedCount > 0 ? 'partial' : ceiling;
}
