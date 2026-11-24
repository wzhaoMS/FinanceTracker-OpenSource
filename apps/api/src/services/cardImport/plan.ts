import {
  canonicalCardDescription, type CardImportPayload, type CardImportPayloadRow, type CardTransaction, type CardTransactionStatus,
} from '@finance-tracker/shared';

/**
 * Phase 4's v1 import plan (#22's pending semantics, moved here from the
 * route so the repository can run it inside the import's transaction, E1b
 * design §4.10.4, finding 11): every v14 outcome of a v1 row (new,
 * duplicate, possible duplicate, promotion, pending and dismissed matches,
 * reference conflicts, stale pending rows), from the payload and the stored
 * rows. Pure: it reads only what it is given.
 */

/** The stored row an import row's dedupe key points at, as far as promotion cares. */
export interface StoredCardKey {
  id: string;
  status: CardTransactionStatus;
  dismissed_at: string | null;
}

/**
 * A stored row that a posted row with the same key can turn into a posted
 * row: a pending row, or one someone dismissed (only on the owner's word:
 * see `isDismissedPending`).
 */
export function isPromotablePending(stored: StoredCardKey): boolean {
  return stored.status === 'pending' || isDismissedPending(stored);
}

/**
 * A pending row the owner dismissed. Its own reference arriving posted is
 * that charge, posted after all, but undoing the dismissal is the owner's
 * call (`promoteDismissedMatches`), never automatic.
 */
export function isDismissedPending(stored: StoredCardKey): boolean {
  return stored.status === 'removed' && stored.dismissed_at !== null;
}

export function keyOf(row: { externalIdHash?: string | null; fingerprint?: string | null }): string {
  return (row.externalIdHash ?? row.fingerprint)!;
}

export function contentKey(row: { transactionDate: string; amountMinor: number; description: string }): string {
  return JSON.stringify([row.transactionDate, row.amountMinor, canonicalCardDescription(row.description)]);
}

export type RowPlan = 'new' | 'duplicate' | 'possible-duplicate' | 'promote' | 'pending-match' | 'dismissed-match';

/** A posted row without a reference whose fingerprint names a stored pending (or dismissed) row. */
export interface PendingMatch {
  /** The incoming row's index in the payload. */
  index: number;
  /** The stored pending (or dismissed) row the fingerprint names. */
  stored: CardTransaction;
  /**
   * Stored posted rows with the same date, amount and description that no
   * key of this import names: when there is one, the incoming row may be that
   * purchase again, already counted, under a shifted occurrence number.
   */
  twins: CardTransaction[];
  /**
   * Stored posted rows like it that another row of this import names by its
   * key: that row is the stored purchase, so this one is not.
   */
  twinsInFile: number;
}

/**
 * The stored row a v1 key names (v15: through the key's legacy identity, as
 * the import itself resolves it, so a link, a re-point or a merge is
 * followed), as far as the plan cares.
 */
export interface KeyedRow {
  row: CardTransaction;
  /** The key's identity is active; a detached one makes the row a plain duplicate, never posted. */
  active: boolean;
  /**
   * The identity already knows this row's content: a replay, never a change (§4.3). Read only for a
   * row that would otherwise promote, so a resolver may compute it lazily (a getter).
   */
  readonly known: boolean;
}

export interface ImportPlan {
  rows: RowPlan[];
  /** Duplicate rows whose stored row has another date or amount (same reference, different content). */
  conflicts: number[];
  matches: PendingMatch[];
  /**
   * Stored pending rows that an import without pending rows does not account
   * for: dated in its coverage, at least STALE_PENDING_SETTLE_DAYS before its
   * end, and named by none of its keys. Only listed, for the owner to judge:
   * such an import need not be a closed statement (some downloads hold posted
   * rows only, even for the open cycle), and even a complete, closed statement
   * leaves out a charge that posted under another reference or a hold that
   * settles after it closes.
   */
  stale: CardTransaction[];
}

/**
 * A pending row dated this close to the end of an import's coverage may
 * still post in the next statement, so the import does not list it as
 * stale.
 */
export const STALE_PENDING_SETTLE_DAYS = 7;
function shiftDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function stateOf(stored: CardTransaction) {
  return { id: stored.id, status: stored.status, dismissed_at: stored.dismissedAt ?? null };
}

/**
 * Mirrors the repository's dedupe (a row is a duplicate when its key is
 * stored for the card account or repeats earlier in the payload; a posted
 * row whose issuer reference is stored for a pending row promotes that row
 * to posted; a posted row whose fingerprint is stored for a pending or
 * dismissed row is a `pending-match`, for the owner to decide, because a
 * fingerprint's occurrence number shifts with the rows around it; a posted
 * row whose issuer reference is stored for a row the owner dismissed is a
 * `dismissed-match`, for the owner to decide whether the dismissal stands)
 * and adds one check of its own: a new posted row whose date, amount and
 * description match a stored posted row that no key in this payload
 * accounts for is a possible duplicate, typically the same purchase from an
 * export with different (or no) references. Only rows that can be left out
 * without changing any other row's key are flagged: rows with a reference,
 * and fingerprint rows from the end of their group. For an import without
 * pending rows it also lists the stale pending rows (see ImportPlan.stale).
 */
export function planImport(payload: CardImportPayload, stored: readonly CardTransaction[],
  resolve: (key: string, row: CardImportPayloadRow) => KeyedRow | undefined): ImportPlan {
  const { rows } = payload;
  const postedByContent = new Map<string, CardTransaction[]>();
  for (const row of stored) {
    if (row.status === 'posted') postedByContent.set(contentKey(row), [...(postedByContent.get(contentKey(row)) ?? []), row]);
  }
  const plan: RowPlan[] = [];
  const conflicts: number[] = [];
  const matches: PendingMatch[] = [];
  const seen = new Set<string>();
  // Stored rows a key of this import names: those rows are accounted for.
  const named = new Set<string>();
  rows.forEach((row, index) => {
    const key = keyOf(row);
    const keyed = resolve(key, row);
    const hit = keyed?.row;
    if (hit) named.add(hit.id);
    if (hit && keyed.active && !seen.has(key) && row.status === 'posted' && isPromotablePending(stateOf(hit)) && !keyed.known) {
      // The stored pending row, now posted, when an issuer reference says so: its posted
      // date, amount and text replace the pending ones. A fingerprint cannot say so, and a
      // dismissal is the owner's to undo.
      const entry: RowPlan = !row.externalIdHash ? 'pending-match' : isDismissedPending(stateOf(hit)) ? 'dismissed-match' : 'promote';
      plan.push(entry);
      if (entry === 'pending-match') matches.push({ index, stored: hit, twins: [], twinsInFile: 0 });
    } else {
      if (hit && (hit.transactionDate !== row.transactionDate || hit.amountMinor !== row.amountMinor)) conflicts.push(index);
      plan.push(hit || seen.has(key) ? 'duplicate' : 'new');
    }
    seen.add(key);
  });
  // Twins once every key of the import is known: a stored posted row that another
  // incoming row names is that row, so it is no sign that this one repeats it.
  for (const match of matches) {
    const alike = postedByContent.get(contentKey(rows[match.index])) ?? [];
    match.twins = alike.filter((posted) => !named.has(posted.id));
    match.twinsInFile = alike.length - match.twins.length;
  }
  const lastStale = shiftDate(payload.coverage.end, -STALE_PENDING_SETTLE_DAYS);
  const stale = payload.totals.pending.count > 0 ? [] : stored
    .filter((row) => row.status === 'pending' && !named.has(row.id)
      && row.transactionDate >= payload.coverage.start && row.transactionDate <= lastStale)
    .sort((a, b) => (a.transactionDate < b.transactionDate ? -1 : a.transactionDate > b.transactionDate ? 1 : 0));
  const unmatched = new Map<string, number>();
  for (const row of stored) {
    if (row.status !== 'posted' || named.has(row.id)) continue;
    const group = contentKey(row);
    unmatched.set(group, (unmatched.get(group) ?? 0) + 1);
  }
  if (unmatched.size === 0) return { rows: plan, conflicts, matches, stale };
  const groups = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const group = contentKey(row);
    if (!unmatched.has(group)) return;
    groups.set(group, [...(groups.get(group) ?? []), index]);
  });
  const skippable = (index: number) => plan[index] === 'new' && rows[index].status === 'posted';
  for (const [group, indexes] of groups) {
    const candidates = indexes.filter((index) => skippable(index) && rows[index].externalIdHash !== null);
    // Fingerprint occurrences count every id-less row of the group in order (any status), so
    // only a trailing run of new posted rows can be left out without moving another key.
    const idless = indexes.filter((index) => rows[index].externalIdHash === null);
    for (let k = idless.length - 1; k >= 0 && skippable(idless[k]); k -= 1) candidates.push(idless[k]);
    for (const index of candidates.slice(0, unmatched.get(group))) plan[index] = 'possible-duplicate';
  }
  return { rows: plan, conflicts, matches, stale };
}


/** The payload indexes Phase 4's plan gives one outcome. */
export function indexesOf(plan: Pick<ImportPlan, 'rows'>, wanted: RowPlan): number[] {
  return plan.rows.flatMap((entry, index) => (entry === wanted ? [index] : []));
}
