import type { Database as DB, Statement } from 'better-sqlite3';

/**
 * The planner's read side (E1b design §4.2–§4.4, §4.7): one card account's
 * ledger as the classifier needs it, read lazily inside the caller's
 * transaction, and the plan-local overlay on top of it. The view never
 * writes; the overlay records what earlier actions of the same plan would
 * have changed (rows' values, revisions, markers and scopes; identities
 * created, re-activated or moved; contents remembered; plan-local rows), so
 * every observation is classified against the ledger as the plan leaves it.
 */

export type RowStatus = 'pending' | 'posted' | 'removed';

/** The normalized bank fields of a row or an observation (the `rcd1:` content's fields, status included). */
export interface BankValues {
  transactionDate: string;
  postedDate: string | null;
  status: 'pending' | 'posted';
  amountMinor: number;
  originalAmountMinor: number | null;
  originalCurrency: string | null;
  kind: string;
  description: string;
  merchant: string | null;
  issuerCategory: string | null;
}

export interface LedgerRow {
  id: string;
  status: RowStatus;
  transactionDate: string;
  postedDate: string | null;
  amountMinor: number;
  originalAmountMinor: number | null;
  originalCurrency: string | null;
  kind: string;
  description: string;
  merchant: string | null;
  issuerCategory: string | null;
  currency: string;
  cardScopeId: string;
  scopeKind: 'known' | 'unknown' | 'legacy';
  revision: number;
  marker: number | null;
  removedReason: string | null;
  removedFromStatus: 'pending' | 'posted' | null;
  /** Created by an extension set (`first_sync_run_id`), as opposed to a file. See also LedgerView.syncProvenance. */
  extensionCreated: boolean;
  /** A plan-local row: the ordinal of the action that inserts it. */
  newRef?: number;
}

export interface Tuple {
  scopeId: string;
  scopeKind: 'known' | 'unknown' | 'legacy';
  namespace: string;
  namespaceKind: 'legacy-file' | 'stable' | 'capture';
  idHash: string;
}

export interface StoredIdentity {
  id: string;
  status: 'active' | 'detached';
  /** A stored row id, or `new:<ordinal>` for a row this plan inserts. */
  canonicalId: string;
  firstSeenStatus: 'pending' | 'posted';
  namespace: string;
  scopeId: string;
  idHash: string;
}

export const tupleKey = (t: Pick<Tuple, 'scopeId' | 'namespace' | 'idHash'>) => `${t.scopeId}|${t.namespace}|${t.idHash}`;
export const newRowId = (ordinal: number) => `new:${ordinal}`;
export const isNewRowId = (id: string) => id.startsWith('new:');

interface RowRecord {
  id: string; status: RowStatus; transaction_date: string; posted_date: string | null; amount_minor: number;
  original_amount_minor: number | null; original_currency: string | null; kind: string; description: string; merchant: string | null;
  issuer_category: string | null; currency: string; card_scope_id: string; scope_kind: 'known' | 'unknown' | 'legacy'; revision: number;
  reversal_snapshot_revision: number | null; removed_reason: string | null; removed_from_status: 'pending' | 'posted' | null;
  first_sync_run_id: string | null;
}

const toRow = (r: RowRecord): LedgerRow => ({
  id: r.id, status: r.status, transactionDate: r.transaction_date, postedDate: r.posted_date, amountMinor: r.amount_minor,
  originalAmountMinor: r.original_amount_minor, originalCurrency: r.original_currency, kind: r.kind, description: r.description,
  merchant: r.merchant, issuerCategory: r.issuer_category, currency: r.currency, cardScopeId: r.card_scope_id, scopeKind: r.scope_kind,
  revision: r.revision, marker: r.reversal_snapshot_revision, removedReason: r.removed_reason, removedFromStatus: r.removed_from_status,
  extensionCreated: r.first_sync_run_id !== null,
});

const ROW_SELECT = `SELECT t.id, t.status, t.transaction_date, t.posted_date, t.amount_minor, t.original_amount_minor, t.original_currency,
    t.kind, t.description, t.merchant, t.issuer_category, t.currency, t.card_scope_id, s.kind AS scope_kind, t.revision,
    t.reversal_snapshot_revision, t.removed_reason, t.removed_from_status, t.first_sync_run_id
  FROM card_transactions t JOIN card_scopes s ON s.id = t.card_scope_id`;

/**
 * One account's stored ledger, read through prepared statements inside the
 * caller's transaction. The view never writes and the stored ledger cannot
 * change while it is used, so every read is cached for the view's life
 * (one simulation): identity probes, candidate pools by amount (sorted by
 * date, so a window is a binary search) and a row's active identities in a
 * (scope, namespace). Callers never mutate the rows it returns.
 */
export class LedgerView {
  private readonly statements = new Map<string, Statement>();
  private readonly probes = new Map<string, StoredIdentity | undefined>();
  private readonly pools = new Map<number, LedgerRow[]>();
  private readonly identitiesIn = new Map<string, StoredIdentity[]>();
  private readonly provenance = new Map<string, boolean>();

  constructor(readonly db: DB, readonly accountId: string, readonly currency: string) {}

  /**
   * Whether a stored row has sync provenance now, the rows a v1 row is held against (§4.4 row 4, v1; slice 2 review r2,
   * finding 2): a browser synced it, or it carries an active identity from a browser, whoever created it (a file row
   * linked or attributed to a browser observation, a merge's survivor, a row an identity was re-pointed to). By
   * `ck_ident_kind_pairing` an identity on a known or unknown scope is a browser's. One index probe per row and view.
   */
  syncProvenance(row: LedgerRow): boolean {
    if (row.extensionCreated) return true;
    let carries = this.provenance.get(row.id);
    if (carries === undefined) {
      carries = this.prepared(`SELECT 1 FROM card_source_identities WHERE canonical_transaction_id = ? AND status = 'active'
        AND source_scope_kind <> 'legacy' LIMIT 1`).get(row.id) !== undefined;
      this.provenance.set(row.id, carries);
    }
    return carries;
  }

  private prepared(sql: string): Statement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** One probe of the tuple index (§4.2); the view never writes, so a probe is read once per view. */
  identity(tuple: Pick<Tuple, 'scopeId' | 'namespace' | 'idHash'>): StoredIdentity | undefined {
    const key = tupleKey(tuple);
    if (this.probes.has(key)) return this.probes.get(key);
    const identity = this.prepared(`SELECT id, status, canonical_transaction_id AS canonicalId, first_seen_status AS firstSeenStatus,
        namespace, source_scope_id AS scopeId, id_hash AS idHash FROM card_source_identities
      WHERE card_account_id = ? AND source_scope_id = ? AND namespace = ? AND id_hash = ?`)
      .get(this.accountId, tuple.scopeId, tuple.namespace, tuple.idHash) as StoredIdentity | undefined;
    this.probes.set(key, identity);
    return identity;
  }

  knowsContent(identityId: string, digest: string): boolean {
    return this.prepared('SELECT 1 FROM card_identity_contents WHERE identity_id = ? AND content_digest = ?').get(identityId, digest)
      !== undefined;
  }

  row(id: string): LedgerRow | undefined {
    const r = this.prepared(`${ROW_SELECT} WHERE t.id = ? AND t.card_account_id = ?`).get(id, this.accountId) as RowRecord | undefined;
    return r ? toRow(r) : undefined;
  }

  /**
   * Live rows of the account with this amount, sorted by transaction date:
   * read once per amount, then every candidate pool of that amount is a
   * slice or an index of it (classify.ts).
   */
  amountPool(amountMinor: number): readonly LedgerRow[] {
    let pool = this.pools.get(amountMinor);
    if (!pool) {
      pool = (this.prepared(`${ROW_SELECT} WHERE t.card_account_id = ? AND t.currency = ? AND t.amount_minor = ?
          AND t.status IN ('pending', 'posted') ORDER BY t.transaction_date, t.rowid`)
        .all(this.accountId, this.currency, amountMinor) as RowRecord[]).map(toRow);
      this.pools.set(amountMinor, pool);
    }
    return pool;
  }

  /** Live rows of the account with this amount and a transaction date in [from, to]: the candidate pool before ranking. */
  rowsNear(amountMinor: number, from: string, to: string): LedgerRow[] {
    const pool = this.amountPool(amountMinor);
    const first = lowerBound(pool, from);
    let end = first;
    while (end < pool.length && pool[end].transactionDate <= to) end += 1;
    return pool.slice(first, end);
  }

  /** The row's active identities in one (scope, namespace): what tells two stable ids of one source apart. */
  activeIdentitiesIn(rowId: string, scopeId: string, namespace: string): readonly StoredIdentity[] {
    const key = `${rowId}|${scopeId}|${namespace}`;
    let identities = this.identitiesIn.get(key);
    if (!identities) {
      identities = this.prepared(`SELECT id, status, canonical_transaction_id AS canonicalId, first_seen_status AS firstSeenStatus,
          namespace, source_scope_id AS scopeId, id_hash AS idHash FROM card_source_identities
        WHERE canonical_transaction_id = ? AND source_scope_id = ? AND namespace = ? AND status = 'active'`)
        .all(rowId, scopeId, namespace) as StoredIdentity[];
      this.identitiesIn.set(key, identities);
    }
    return identities;
  }

  /** Every active identity of the row (W13 counts them). */
  activeIdentities(rowId: string): StoredIdentity[] {
    return this.prepared(`SELECT id, status, canonical_transaction_id AS canonicalId, first_seen_status AS firstSeenStatus, namespace,
        source_scope_id AS scopeId, id_hash AS idHash FROM card_source_identities WHERE canonical_transaction_id = ? AND status = 'active'`)
      .all(rowId) as StoredIdentity[];
  }

  scope(scopeId: string): { id: string; kind: 'known' | 'unknown' | 'legacy'; status: 'active' | 'retired' } | undefined {
    return this.prepared('SELECT id, kind, status FROM card_scopes WHERE id = ? AND card_account_id = ?').get(scopeId, this.accountId) as
      { id: string; kind: 'known' | 'unknown' | 'legacy'; status: 'active' | 'retired' } | undefined;
  }

  ledgerRevision(): number {
    return this.prepared('SELECT ledger_revision FROM card_accounts WHERE id = ?').pluck().get(this.accountId) as number;
  }
}

/** The first index of a date-sorted pool whose transaction date is at or after `from`. */
function lowerBound(pool: readonly LedgerRow[], from: string): number {
  let low = 0;
  let high = pool.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (pool[middle].transactionDate < from) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * The plan-local overlay (§4.7): copy-on-write rows, identities and
 * contents. Reads see what earlier actions of the plan did; nothing is
 * written to the database. Overlay identities are also indexed by the row
 * they name, so a row's identities are found without scanning them all.
 */
export class LedgerOverlay {
  private readonly rows = new Map<string, LedgerRow>();
  private readonly identities = new Map<string, StoredIdentity>();
  private readonly byRow = new Map<string, Map<string, StoredIdentity>>();
  private readonly contents = new Set<string>();
  private readonly changedAmounts = new Set<number>();

  constructor(readonly view: LedgerView) {}

  identity(tuple: Pick<Tuple, 'scopeId' | 'namespace' | 'idHash'>): StoredIdentity | undefined {
    return this.identities.get(tupleKey(tuple)) ?? this.view.identity(tuple);
  }

  knowsContent(identityId: string, digest: string): boolean {
    return this.contents.has(`${identityId}|${digest}`) || (!identityId.startsWith('new:') && this.view.knowsContent(identityId, digest));
  }

  row(id: string): LedgerRow | undefined {
    return this.rows.get(id) ?? (isNewRowId(id) ? undefined : this.view.row(id));
  }

  /** The stored live rows of this amount, as stored (`changedAmount` says whether the plan changed one of them). */
  amountPool(amountMinor: number): readonly LedgerRow[] {
    return this.view.amountPool(amountMinor);
  }

  /**
   * A candidate's sync provenance (LedgerView.syncProvenance). Candidates are stored rows; the plans that ask (file
   * sets') never attach a browser's identity, so the stored answer holds through the plan.
   */
  syncProvenance(row: LedgerRow): boolean {
    return row.newRef === undefined ? this.view.syncProvenance(row) : row.extensionCreated;
  }

  /** Whether this plan changed a stored row of this amount, so that pool must be read through the overlay row by row. */
  changedAmount(amountMinor: number): boolean {
    return this.changedAmounts.has(amountMinor);
  }

  /** Candidate pool through the overlay: stored rows as this plan leaves them, plan-local rows never (they are this set's). */
  rowsNear(amountMinor: number, from: string, to: string): LedgerRow[] {
    return this.view.rowsNear(amountMinor, from, to).map((row) => this.rows.get(row.id) ?? row)
      .filter((row) => row.status === 'pending' || row.status === 'posted');
  }

  activeIdentitiesIn(rowId: string, scopeId: string, namespace: string): readonly StoredIdentity[] {
    const stored = this.view.activeIdentitiesIn(rowId, scopeId, namespace);
    if (this.identities.size === 0) return stored;
    const mapped = stored.map((identity) => this.identities.get(tupleKey(identity)) ?? identity);
    const onRow = this.byRow.get(rowId);
    const local = onRow ? [...onRow.values()].filter((identity) => identity.scopeId === scopeId && identity.namespace === namespace
      && !mapped.some((s) => s.id === identity.id)) : [];
    return [...mapped, ...local].filter((identity) => identity.status === 'active' && identity.canonicalId === rowId);
  }

  /** The row's active identities as this plan leaves them (W13: a row that is not merged keeps at least one). */
  activeIdentitiesOf(rowId: string): StoredIdentity[] {
    const stored = isNewRowId(rowId) ? [] : this.view.activeIdentities(rowId).map((identity) => this.identities.get(tupleKey(identity)) ?? identity);
    const local = [...(this.byRow.get(rowId)?.values() ?? [])].filter((identity) => !stored.some((s) => s.id === identity.id));
    return [...stored, ...local].filter((identity) => identity.status === 'active' && identity.canonicalId === rowId);
  }

  setRow(row: LedgerRow): void {
    if (!isNewRowId(row.id) && !this.rows.has(row.id)) {
      const stored = this.view.row(row.id);
      if (stored) this.changedAmounts.add(stored.amountMinor);
    }
    this.rows.set(row.id, row);
  }

  setIdentity(identity: StoredIdentity): void {
    const key = tupleKey(identity);
    const previous = this.identities.get(key);
    if (previous) this.byRow.get(previous.canonicalId)?.delete(key);
    this.identities.set(key, identity);
    let onRow = this.byRow.get(identity.canonicalId);
    if (!onRow) {
      onRow = new Map();
      this.byRow.set(identity.canonicalId, onRow);
    }
    onRow.set(key, identity);
  }

  remember(identityId: string, digest: string): void {
    this.contents.add(`${identityId}|${digest}`);
  }
}
