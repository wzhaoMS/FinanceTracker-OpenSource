import type { Database as DB } from 'better-sqlite3';

import { newCardSyncId } from '../cardSyncDigests.js';
import { REVIEW_ACTION_BITS, type PlanCandidate, type ReviewClassification, type ReviewDecisionAction }
  from '../cardLedger/classify.js';
import type { StatementDifference } from '../cardLedger/simulate.js';
import { cachedStatement, insertRows } from './bulk.js';

/**
 * Review items and their candidates (E1b design §2.14–§2.15, §4.5): the
 * stable owner-facing records of what needs a person, written at acceptance,
 * reconciled in place by a refresh, decided by the owner and stamped with
 * the committed decision by the plan that executes it.
 */

export type ItemStatus = 'open' | 'decided' | 'committed' | 'superseded' | 'expired' | 'discarded';

export interface ItemRow {
  id: string; observation_set_id: string; card_account_id: string; observation_id: string | null; category: string; reason: string;
  allowed_actions: number; difference_field: string | null; expected_minor: number | null; actual_minor: number | null;
  status: ItemStatus; draft_action: ReviewDecisionAction | null; draft_transaction_id: string | null; draft_scope_id: string | null;
  drafted_by_ref: string | null; drafted_at: string | null; committed_action: ReviewDecisionAction | null;
  committed_transaction_id: string | null; committed_scope_id: string | null; committed_revision: number | null;
  committed_plan_id: string | null; committed_at: string | null; classified_ledger_revision: number; created_at: string;
  updated_at: string;
}

export interface CandidateRow {
  review_item_id: string; rank: number; transaction_id: string; rule: string; matched_on: number; blocked_reason: string | null;
}

const ITEM_COLUMNS = ['id', 'observation_set_id', 'card_account_id', 'observation_id', 'category', 'reason', 'allowed_actions',
  'difference_field', 'expected_minor', 'actual_minor', 'status', 'classified_ledger_revision', 'created_at', 'updated_at'] as const;
const CANDIDATE_COLUMNS = ['review_item_id', 'card_account_id', 'rank', 'transaction_id', 'rule', 'matched_on', 'blocked_reason'] as const;

/** A new item to write: a row's review, or the set-level statement acknowledgement. */
export interface NewItem {
  observationId: string | null;
  review: ReviewClassification;
  statement: StatementDifference | null;
}

/** Writes new items and their candidates (multi-row INSERTs); returns their ids in order. */
export function insertItems(db: DB, now: string, set: { id: string; card_account_id: string }, items: readonly NewItem[],
  ledgerRevision: number): string[] {
  const ids = items.map(() => newCardSyncId('rvw_'));
  insertRows(db, 'card_reconciliation_suggestions', ITEM_COLUMNS, items.map((item, i) => [
    ids[i], set.id, set.card_account_id, item.observationId, item.review.category, item.review.reason, item.review.allowed,
    item.statement?.field ?? null, item.statement?.expectedMinor ?? null, item.statement?.actualMinor ?? null, 'open', ledgerRevision,
    now, now,
  ]));
  insertRows(db, 'card_reconciliation_candidates', CANDIDATE_COLUMNS, items.flatMap((item, i) => candidateRows(ids[i],
    set.card_account_id, item.review.candidates)));
  return ids;
}

const candidateRows = (itemId: string, accountId: string, candidates: readonly PlanCandidate[]) => candidates.map((c, rank) => [
  itemId, accountId, rank + 1, c.transactionId, c.rule, c.matchedOn, c.blocked,
]);

export function itemsOfSet(db: DB, setId: string): ItemRow[] {
  return db.prepare('SELECT * FROM card_reconciliation_suggestions WHERE observation_set_id = ?').all(setId) as ItemRow[];
}

export function candidatesOf(db: DB, itemId: string): CandidateRow[] {
  return cachedStatement(db, 'SELECT * FROM card_reconciliation_candidates WHERE review_item_id = ? ORDER BY rank').all(itemId) as
    CandidateRow[];
}

/** Whether a stored item already says what a fresh classification says (reason, category, actions, ranked candidates). */
export function sameClassification(item: ItemRow, stored: readonly CandidateRow[], review: ReviewClassification): boolean {
  return item.reason === review.reason && item.category === review.category && item.allowed_actions === review.allowed
    && stored.length === review.candidates.length && stored.every((c, i) => {
      const fresh = review.candidates[i];
      return c.transaction_id === fresh.transactionId && c.rule === fresh.rule && c.matched_on === fresh.matchedOn
        && c.blocked_reason === fresh.blocked;
    });
}

/**
 * Re-classifies one item in place under §4.5's draft protocol: a valid draft
 * is saved, cleared (`decided → open`), the candidate list replaced, and the
 * draft restored (`open → decided`, same action, target, scope, actor and
 * time) while the action is still allowed and its target still an unblocked
 * candidate; otherwise the item stays open without it. A superseded item
 * that needs a person again reopens.
 */
export function reclassifyItem(db: DB, now: string, item: ItemRow, review: ReviewClassification, ledgerRevision: number): void {
  const draft = item.status === 'decided' && item.committed_action === null
    ? { action: item.draft_action!, transactionId: item.draft_transaction_id, scopeId: item.draft_scope_id, by: item.drafted_by_ref!,
      at: item.drafted_at! }
    : null;
  if (item.status === 'decided' || item.status === 'superseded') {
    db.prepare(`UPDATE card_reconciliation_suggestions SET status = 'open', draft_action = NULL, draft_transaction_id = NULL,
        draft_scope_id = NULL, drafted_by_ref = NULL, drafted_at = NULL, updated_at = ? WHERE id = ?`).run(now, item.id);
  }
  db.prepare('DELETE FROM card_reconciliation_candidates WHERE review_item_id = ?').run(item.id);
  insertRows(db, 'card_reconciliation_candidates', CANDIDATE_COLUMNS, candidateRows(item.id, item.card_account_id, review.candidates));
  db.prepare(`UPDATE card_reconciliation_suggestions SET reason = ?, category = ?, allowed_actions = ?, classified_ledger_revision = ?,
      updated_at = ? WHERE id = ?`).run(review.reason, review.category, review.allowed, ledgerRevision, now, item.id);
  if (draft && draftStillValid(draft, review)) {
    db.prepare(`UPDATE card_reconciliation_suggestions SET status = 'decided', draft_action = ?, draft_transaction_id = ?,
        draft_scope_id = ?, drafted_by_ref = ?, drafted_at = ?, updated_at = ? WHERE id = ?`)
      .run(draft.action, draft.transactionId, draft.scopeId, draft.by, draft.at, now, item.id);
  }
}

function draftStillValid(draft: { action: ReviewDecisionAction; transactionId: string | null }, review: ReviewClassification): boolean {
  if ((REVIEW_ACTION_BITS[draft.action] & review.allowed) === 0) return false;
  return draft.transactionId === null
    || review.candidates.some((c) => c.transactionId === draft.transactionId && c.blocked === null);
}

/** An item no longer needs a person (§4.5): `superseded`, its draft dropped. */
export function supersedeItem(db: DB, now: string, item: ItemRow): void {
  db.prepare(`UPDATE card_reconciliation_suggestions SET status = 'superseded', draft_action = NULL, draft_transaction_id = NULL,
      draft_scope_id = NULL, drafted_by_ref = NULL, drafted_at = NULL, updated_at = ? WHERE id = ?`).run(now, item.id);
}
