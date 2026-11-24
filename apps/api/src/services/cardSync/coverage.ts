import { cardSyncRefusal } from './refusals.js';
import type { CardSyncContext } from './context.js';

/**
 * Coverage windows (E1b design §2.15, §5.10): what each source observed,
 * per scope and status, with the completeness it claimed and the
 * completeness the server verified. Written only by acceptance, the v1
 * import and the writer (ledger state); read here.
 */

export interface CardCoverageWindowView {
  id: string;
  cardAccountId: string;
  cardScopeId: string;
  sourceKind: 'file' | 'extension';
  source: string;
  importBatchId: string | null;
  observationSetId: string | null;
  entryOrdinal: number | null;
  status: 'pending' | 'posted' | 'any';
  requested: { start: string; end: string; basis: string } | null;
  observed: { start: string; end: string; basis: string } | null;
  claimedCompleteness: 'unknown' | 'partial' | 'complete';
  verifiedCompleteness: 'unknown' | 'partial' | 'complete';
  termination: string | null;
  pageCount: number | null;
  evidence: string;
  ledgerState: 'observed-uncommitted' | 'committed' | 'expired-unreviewed' | 'rejected';
  observedAt: string | null;
  recordedAt: string;
}

/** A merged span of equal windows (same scope, source, status, bases, evidence and verified completeness). */
export interface CardCoverageSpan {
  cardScopeId: string;
  source: string;
  status: 'pending' | 'posted' | 'any';
  basis: string;
  evidence: string;
  verifiedCompleteness: 'unknown' | 'partial' | 'complete';
  start: string;
  end: string;
  windows: number;
}

const LEDGER_STATES = ['observed-uncommitted', 'committed', 'expired-unreviewed', 'rejected'] as const;

interface WindowRow {
  id: string; card_account_id: string; card_scope_id: string; source_kind: 'file' | 'extension'; source: string;
  import_batch_id: string | null; observation_set_id: string | null; entry_ordinal: number | null; status: 'pending' | 'posted' | 'any';
  requested_start: string | null; requested_end: string | null; requested_basis: string | null; observed_start: string | null;
  observed_end: string | null; observed_basis: string | null; claimed_completeness: CardCoverageWindowView['claimedCompleteness'];
  verified_completeness: CardCoverageWindowView['verifiedCompleteness']; termination: string | null; page_count: number | null;
  evidence: string; ledger_state: CardCoverageWindowView['ledgerState']; observed_at: string | null; recorded_at: string;
}

const view = (w: WindowRow): CardCoverageWindowView => ({
  id: w.id, cardAccountId: w.card_account_id, cardScopeId: w.card_scope_id, sourceKind: w.source_kind, source: w.source,
  importBatchId: w.import_batch_id, observationSetId: w.observation_set_id, entryOrdinal: w.entry_ordinal, status: w.status,
  requested: w.requested_start === null ? null : { start: w.requested_start, end: w.requested_end!, basis: w.requested_basis! },
  observed: w.observed_start === null ? null : { start: w.observed_start, end: w.observed_end!, basis: w.observed_basis! },
  claimedCompleteness: w.claimed_completeness, verifiedCompleteness: w.verified_completeness, termination: w.termination,
  pageCount: w.page_count, evidence: w.evidence, ledgerState: w.ledger_state, observedAt: w.observed_at, recordedAt: w.recorded_at,
});

export function listCardCoverageWindows(ctx: CardSyncContext, filter: {
  cardAccountId?: string; cardScopeId?: string; ledgerStates?: ReadonlyArray<CardCoverageWindowView['ledgerState']>;
} = {}): CardCoverageWindowView[] {
  const states = filter?.ledgerStates ?? LEDGER_STATES;
  if (!Array.isArray(states) || states.length === 0 || states.some((s) => !LEDGER_STATES.includes(s))) {
    throw cardSyncRefusal('invalid-request');
  }
  const rows = ctx.db.prepare(`SELECT * FROM card_coverage_windows
    WHERE (:account IS NULL OR card_account_id = :account) AND (:scope IS NULL OR card_scope_id = :scope)
      AND ledger_state IN (SELECT value FROM json_each(:states))
    ORDER BY card_account_id, card_scope_id, status, coalesce(observed_start, requested_start), recorded_at, id`).all({
    account: filter?.cardAccountId ?? null, scope: filter?.cardScopeId ?? null, states: JSON.stringify(states),
  }) as WindowRow[];
  return rows.map(view);
}

const nextDay = (date: string) => new Date(Date.parse(`${date}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * Committed coverage of an account as spans (§5.10): windows merge only when
 * they agree on scope, source, status, basis, evidence and verified
 * completeness and their observed ranges overlap or adjoin; anything else
 * stays apart, so a gap or a weaker claim is never hidden.
 */
export function mergedCardCoverage(ctx: CardSyncContext, filter: { cardAccountId: string }): CardCoverageSpan[] {
  if (typeof filter?.cardAccountId !== 'string') throw cardSyncRefusal('invalid-request');
  const windows = listCardCoverageWindows(ctx, { cardAccountId: filter.cardAccountId, ledgerStates: ['committed'] })
    .filter((w) => w.observed !== null);
  const groups = new Map<string, CardCoverageWindowView[]>();
  for (const w of windows) {
    const key = [w.cardScopeId, w.source, w.status, w.observed!.basis, w.evidence, w.verifiedCompleteness].join('|');
    groups.set(key, [...(groups.get(key) ?? []), w]);
  }
  const spans: CardCoverageSpan[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.observed!.start.localeCompare(b.observed!.start) || a.observed!.end.localeCompare(b.observed!.end));
    let current: CardCoverageSpan | null = null;
    for (const w of sorted) {
      if (current && w.observed!.start <= nextDay(current.end)) {
        if (w.observed!.end > current.end) current.end = w.observed!.end;
        current.windows += 1;
        continue;
      }
      if (current) spans.push(current);
      current = { cardScopeId: w.cardScopeId, source: w.source, status: w.status, basis: w.observed!.basis, evidence: w.evidence,
        verifiedCompleteness: w.verifiedCompleteness, start: w.observed!.start, end: w.observed!.end, windows: 1 };
    }
    if (current) spans.push(current);
  }
  return spans.sort((a, b) => a.cardScopeId.localeCompare(b.cardScopeId) || a.status.localeCompare(b.status)
    || a.start.localeCompare(b.start) || a.source.localeCompare(b.source));
}
