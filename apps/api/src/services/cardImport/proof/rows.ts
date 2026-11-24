import {
  buildCardCategoryInference, canonicalCardDescription, effectiveCardCategory, type CardImportPayload,
} from '@finance-tracker/shared';

import type { SqliteStateRepo } from '../../sqliteStateRepo.js';
import type { ProofHoldCode } from './receipt.js';
import { rowChanges, type ProofSnapshot, type StoredRow } from './snapshot.js';

/**
 * G-ROWS, G-SUPERSET and the category effects (design v1.1 §3.4; ROOT D8, D12).
 *
 * G-ROWS: rows appear only in the target account, exactly as many as the batch inserted; none vanish; a pre-existing row
 * changes only as a pending → posted promotion by issuer reference that ROOT's D12 allows:
 * - amount, original amount and currency, currency, kind and transaction date are unchanged;
 * - the posted date is set;
 * - owner fields (`user_category`, `notes`) are unchanged;
 * - every identity and provenance field is unchanged, the row is live afterwards, and the revision grows by exactly one.
 * Text (`description`, `merchant`, `issuer_category`) may change, and each change is counted. Any other change is a
 * revision, which holds (`proof-revision`).
 *
 * G-SUPERSET: every live stored row of the target (pending or posted) dated inside the payload's coverage needs a
 * one-to-one twin in the payload. Twins are matched by dedupe key first, then by the deployed content key (date, amount,
 * canonical description), as the kit's sweep-twins does. A row is dated by its posted date, or its transaction date when
 * it has none, which is how a payload's coverage bounds its own rows.
 */

/** Columns a promotion may change, besides the text it may rewrite. */
const PROMOTION_WRITES = new Set(['status', 'posted_date', 'revision', 'updated_at', 'description', 'merchant', 'issuer_category']);
/** Text a promotion may rewrite: counted, never a revision. */
const PROMOTION_TEXT = ['description', 'merchant', 'issuer_category'] as const;

export interface RowsVerdict {
  code: ProofHoldCode | null;
  appeared: string[];
  elsewhere: number;
  gone: number;
  /** Pre-existing rows changed in any way other than an allowed promotion. */
  changed: number;
  promoted: string[];
  promotedTextChanged: number;
}

function promotionAllowed(before: StoredRow, after: StoredRow): boolean {
  if (before.status !== 'pending' || after.status !== 'posted') return false;
  if (typeof after.posted_date !== 'string' || after.posted_date.length !== 10) return false;
  if (after.revision !== (before.revision as number) + 1) return false;
  for (const column of ['removed_reason', 'removed_from_status', 'removed_at', 'dismissed_at', 'merged_into_id',
    'reversal_snapshot_revision'] as const) {
    if (after[column] !== null) return false;
  }
  const columns = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const column of columns) {
    if (PROMOTION_WRITES.has(column)) continue;
    if (before[column] !== after[column]) return false;
  }
  return true;
}

export function checkRows(before: ProofSnapshot, after: ProofSnapshot, targetAccountId: string,
  expected: { newCount: number; promotedCount: number }): RowsVerdict {
  const { appeared, gone, changed } = rowChanges(before, after);
  const elsewhere = appeared.filter((id) => after.rows.get(id)!.accountId !== targetAccountId).length;
  const promoted: string[] = [];
  let other = 0, textChanged = 0;
  for (const id of changed) {
    const was = before.rows.get(id)!, now = after.rows.get(id)!;
    if (was.accountId !== targetAccountId || now.accountId !== targetAccountId || !was.row || !now.row
      || !promotionAllowed(was.row, now.row)) {
      other += 1;
      continue;
    }
    promoted.push(id);
    if (PROMOTION_TEXT.some((column) => was.row![column] !== now.row![column])) textChanged += 1;
  }
  const accountsChanged = before.accounts.size !== after.accounts.size || [...before.accounts].some(([id, row]) => {
    const now = after.accounts.get(id);
    if (!now) return true;
    const columns = new Set([...Object.keys(row), ...Object.keys(now)]);
    return [...columns].some((column) => {
      if (row[column] === now[column]) return false;
      // The target's ledger revision is the only account field an import moves, and only upwards.
      return !(id === targetAccountId && column === 'ledger_revision' && (now[column] as number) >= (row[column] as number));
    });
  });
  const code: ProofHoldCode | null = other > 0 ? 'proof-revision'
    : elsewhere > 0 || gone.length > 0 || accountsChanged || appeared.length !== expected.newCount
      || promoted.length !== expected.promotedCount ? 'proof-rows' : null;
  return { code, appeared, elsewhere, gone: gone.length, changed: other, promoted, promotedTextChanged: textChanged };
}

export interface SupersetVerdict {
  code: ProofHoldCode | null;
  inSpan: number;
  untwinned: number;
}

const contentKey = (date: unknown, amount: unknown, description: unknown) =>
  JSON.stringify([date, amount, canonicalCardDescription(typeof description === 'string' ? description : '')]);

export function checkSuperset(before: ProofSnapshot, targetAccountId: string, payload: CardImportPayload): SupersetVerdict {
  const { start, end } = payload.coverage;
  const stored: StoredRow[] = [];
  for (const state of before.rows.values()) {
    if (state.accountId !== targetAccountId || !state.row) continue;
    const row = state.row;
    if (row.status !== 'pending' && row.status !== 'posted') continue;
    const day = (row.posted_date ?? row.transaction_date) as string;
    if (day >= start && day <= end) stored.push(row);
  }
  const byKey = new Map<string, number[]>();
  const byContent = new Map<string, number[]>();
  payload.rows.forEach((row, index) => {
    const key = row.externalIdHash ?? row.fingerprint;
    if (key) byKey.set(key, [...(byKey.get(key) ?? []), index]);
    const content = contentKey(row.transactionDate, row.amountMinor, row.description);
    byContent.set(content, [...(byContent.get(content) ?? []), index]);
  });
  const used = new Set<number>();
  const take = (candidates: number[] | undefined) => {
    const index = candidates?.find((candidate) => !used.has(candidate));
    if (index === undefined) return false;
    used.add(index);
    return true;
  };
  const left: StoredRow[] = [];
  for (const row of stored) {
    const key = (row.external_id_hash ?? row.fingerprint) as string | null;
    if (!key || !take(byKey.get(key))) left.push(row);
  }
  let untwinned = 0;
  for (const row of left) {
    if (!take(byContent.get(contentKey(row.transaction_date, row.amount_minor, row.description)))) untwinned += 1;
  }
  return { code: untwinned > 0 ? 'proof-superset' : null, inSpan: stored.length, untwinned };
}

/**
 * Every live card row's effective category as the API shows it: the owner's, else the issuer's, else the household
 * inference's (`cardTransactions.ts`), else uncategorized.
 */
export function effectiveCategories(repo: SqliteStateRepo): Map<string, string> {
  const rows = repo.listCardTransactionsMatching({ statuses: ['pending', 'posted'] });
  const model = buildCardCategoryInference(rows);
  return new Map(rows.map((row) => [row.id, effectiveCardCategory({
    userCategory: row.userCategory ?? null, issuerCategory: row.issuerCategory ?? null,
    inferredCategory: model.infer(row)?.category ?? null,
  })]));
}

/** Pre-existing rows whose effective category the import changed, all of them and the promoted ones. */
export function categoryEffects(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>,
  promoted: readonly string[]): { all: number; promoted: number } {
  let all = 0;
  for (const [id, category] of before) if (after.has(id) && after.get(id) !== category) all += 1;
  const promotedChanged = promoted.filter((id) => before.has(id) && after.has(id) && before.get(id) !== after.get(id)).length;
  return { all, promoted: promotedChanged };
}
