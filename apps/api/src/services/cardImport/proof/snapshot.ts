import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';

import { mergeCardCoverage, type CardCoverageRange } from '@finance-tracker/shared';

import type { SqliteStateRepo } from '../../sqliteStateRepo.js';
import { PROOF_FENCES_TABLE, PROOF_PERMIT_JOURNAL_TABLE, PROOF_PERMIT_TABLE, PROOF_RECEIPTS_TABLE } from './schema.js';

/**
 * The database state the proof compares (design v1.1 §3.4: G-ROWS, G-COVERAGE C6, G-TABLES). It is read inside the
 * proof's transaction before and after the import, on the same connection.
 *
 * Every row of `card_transactions` is digested, all columns. The target account's rows are also kept whole, so a
 * promotion can be checked field by field.
 */

export type StoredRow = Record<string, unknown>;

export interface CardRowState {
  accountId: string;
  digest: string;
  /** The whole row, for the target account only. */
  row?: StoredRow;
}

export interface ProofSnapshot {
  rows: Map<string, CardRowState>;
  /** Every card account, whole. */
  accounts: Map<string, StoredRow>;
  /** Per account: the merged coverage of its import batches. */
  coverage: Map<string, CardCoverageRange[]>;
  /** Every coverage window (file or extension): its account, a digest of the whole row, and the row. */
  windows: Map<string, { accountId: string; digest: string; row: StoredRow }>;
  /** Every import batch: a digest of the whole row, and the row. */
  batches: Map<string, { digest: string; row: StoredRow }>;
  /** A digest of every other `card_` table. */
  cardTables: Map<string, string>;
  /** The cutover route's own receipts (`guardedCardCommit.ts`), by job id: a cutover adds exactly its own. */
  cutoverReceipts: Map<string, string>;
  /** Digests of the tables a card import must never touch. */
  foreign: Record<string, string>;
}

/** Tables a v1 card import writes, so they are checked by their own rules rather than for no change at all. */
export const IMPORT_TABLES: ReadonlySet<string> = new Set([
  'card_transactions', 'card_import_batches', 'card_coverage_windows', 'card_source_identities', 'card_identity_contents',
  'card_transaction_events', 'card_transaction_versions', 'card_accounts',
]);

/** The proof's own tables: written only by the proof and the operator, never by an import. */
const PROOF_TABLES: ReadonlySet<string> = new Set([PROOF_RECEIPTS_TABLE, PROOF_FENCES_TABLE, PROOF_PERMIT_TABLE,
  PROOF_PERMIT_JOURNAL_TABLE]);

/** The cutover route's receipts: checked by job id, not for no change at all. */
export const CUTOVER_RECEIPTS_TABLE = 'card_cutover_commit_receipts';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const rowDigest = (row: unknown) => sha256(JSON.stringify(row, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)));

function tableNames(db: Database): string[] {
  return (db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table' ORDER BY name").pluck().all() as string[]);
}

function quoted(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('unexpected table name');
  return `"${name}"`;
}

/** One digest over a whole table, in rowid order (or primary key order for a table without rowid). */
function tableDigest(db: Database, name: string): string {
  const hash = createHash('sha256');
  let order = 'rowid';
  try {
    db.prepare(`SELECT rowid FROM ${quoted(name)} LIMIT 0`).all();
  } catch {
    order = '1';
  }
  for (const row of db.prepare(`SELECT * FROM ${quoted(name)} ORDER BY ${order}`).iterate()) {
    hash.update(rowDigest(row));
    hash.update('\n');
  }
  return hash.digest('hex');
}

/** The tables a card import must never change. Absent tables are recorded as absent. */
const FOREIGN_TABLES = [
  'amazon_binding_proposals', 'amazon_binding_approvals', 'amazon_matches', 'amazon_ledger_matches', 'amazon_candidates',
  'amazon_ledger_candidates', 'amazon_subjects', 'card_payment_decisions', 'checking_accounts', 'checking_transactions',
  'checking_coverage',
] as const;

export function takeSnapshot(db: Database, repo: SqliteStateRepo, targetAccountId: string): ProofSnapshot {
  if (!db.inTransaction) throw new Error('a proof snapshot needs the proof transaction');
  const rows = new Map<string, CardRowState>();
  for (const row of db.prepare('SELECT * FROM card_transactions ORDER BY id').iterate() as Iterable<StoredRow>) {
    const id = row.id as string, accountId = row.card_account_id as string;
    rows.set(id, { accountId, digest: rowDigest(row), ...(accountId === targetAccountId ? { row } : {}) });
  }
  const accounts = new Map<string, StoredRow>();
  for (const row of db.prepare('SELECT * FROM card_accounts ORDER BY id').iterate() as Iterable<StoredRow>) {
    accounts.set(row.id as string, row);
  }
  const byAccount = new Map<string, CardCoverageRange[]>();
  for (const batch of repo.listCardImportBatches()) {
    if (!batch.coverage) continue;
    const list = byAccount.get(batch.cardAccountId) ?? [];
    list.push(batch.coverage);
    byAccount.set(batch.cardAccountId, list);
  }
  const coverage = new Map([...byAccount].map(([accountId, ranges]) => [accountId, mergeCardCoverage(ranges)]));
  const windows = new Map<string, { accountId: string; digest: string; row: StoredRow }>();
  for (const row of db.prepare('SELECT * FROM card_coverage_windows ORDER BY id').iterate() as Iterable<StoredRow>) {
    windows.set(row.id as string, { accountId: row.card_account_id as string, digest: rowDigest(row), row });
  }
  const batches = new Map<string, { digest: string; row: StoredRow }>();
  for (const row of db.prepare('SELECT * FROM card_import_batches ORDER BY id').iterate() as Iterable<StoredRow>) {
    batches.set(row.id as string, { digest: rowDigest(row), row });
  }
  const names = tableNames(db);
  const cardTables = new Map<string, string>();
  for (const name of names) {
    if (!name.startsWith('card_') || IMPORT_TABLES.has(name) || PROOF_TABLES.has(name) || name === CUTOVER_RECEIPTS_TABLE) continue;
    cardTables.set(name, tableDigest(db, name));
  }
  const present = new Set(names);
  const cutoverReceipts = new Map<string, string>();
  if (present.has(CUTOVER_RECEIPTS_TABLE)) {
    for (const row of db.prepare(`SELECT * FROM ${quoted(CUTOVER_RECEIPTS_TABLE)} ORDER BY rowid`).iterate() as Iterable<StoredRow>) {
      cutoverReceipts.set(String(row.job_id), rowDigest(row));
    }
  }
  const foreign: Record<string, string> = {
    schema: rowDigest(db.prepare('SELECT type, name, tbl_name, sql FROM main.sqlite_master ORDER BY type, name').all()),
  };
  for (const name of FOREIGN_TABLES) foreign[name] = present.has(name) ? tableDigest(db, name) : 'absent';
  return { rows, accounts, coverage, windows, batches, cardTables, cutoverReceipts, foreign };
}

/** The rows that appeared, vanished or changed between two snapshots. */
export function rowChanges(before: ProofSnapshot, after: ProofSnapshot): { appeared: string[]; gone: string[]; changed: string[] } {
  const appeared: string[] = [], gone: string[] = [], changed: string[] = [];
  for (const [id, state] of after.rows) {
    const was = before.rows.get(id);
    if (!was) appeared.push(id);
    else if (was.digest !== state.digest) changed.push(id);
  }
  for (const id of before.rows.keys()) if (!after.rows.has(id)) gone.push(id);
  return { appeared, gone, changed };
}

/** Row counts of the tables a v1 import may grow (`IMPORT_TABLES`): checked for no decrease and exact deltas. */
export function importTableCounts(db: Database): Record<string, number> {
  const counts: Record<string, number> = {};
  const present = new Set(tableNames(db));
  for (const name of IMPORT_TABLES) {
    counts[name] = present.has(name) ? (db.prepare(`SELECT count(*) FROM ${quoted(name)}`).pluck().get() as number) : 0;
  }
  return counts;
}

/**
 * The ledger tables an import only appends to (cardLedger/writer.ts insertFileRows, promoteFileRows, and the snapshot
 * trigger). None has a WITHOUT ROWID form, and none is ever deleted from, so a new row always takes a rowid above the
 * largest before: every row up to it is the BEFORE state, and every row past it is new.
 */
export const LEDGER_TABLES = ['card_source_identities', 'card_identity_contents', 'card_transaction_events',
  'card_transaction_versions'] as const;
export type LedgerTable = typeof LEDGER_TABLES[number];

/** A ledger table before the import: its largest rowid, and one digest over every row up to it, in rowid order. */
export interface LedgerMark {
  maxRowid: number;
  digest: string;
}

export function ledgerDigestUpTo(db: Database, name: LedgerTable, maxRowid: number): string {
  const hash = createHash('sha256');
  for (const row of db.prepare(`SELECT rowid AS proof_rowid, * FROM ${quoted(name)} WHERE rowid <= ? ORDER BY rowid`).iterate(maxRowid)) {
    hash.update(rowDigest(row));
    hash.update('\n');
  }
  return hash.digest('hex');
}

export function ledgerMarks(db: Database): Record<LedgerTable, LedgerMark> {
  const present = new Set(tableNames(db));
  const marks = {} as Record<LedgerTable, LedgerMark>;
  for (const name of LEDGER_TABLES) {
    const maxRowid = present.has(name) ? Number(db.prepare(`SELECT coalesce(max(rowid), 0) FROM ${quoted(name)}`).pluck().get()) : 0;
    marks[name] = { maxRowid, digest: present.has(name) ? ledgerDigestUpTo(db, name, maxRowid) : 'absent' };
  }
  return marks;
}

/** The rows a ledger table gained past its BEFORE mark. */
export function ledgerRowsAfter(db: Database, name: LedgerTable, mark: LedgerMark): StoredRow[] {
  return db.prepare(`SELECT * FROM ${quoted(name)} WHERE rowid > ? ORDER BY rowid`).all(mark.maxRowid) as StoredRow[];
}

/**
 * The ledger after the import (v1.1 §3.4; 5b01e72f): no row from before changed, and every new row is this import's
 * own. One active identity per inserted row, bound to it, the target and this batch; one content and one event per
 * inserted row (`inserted`, `created`) and per promoted row (`promoted`, `promoted`), from this batch; one version per
 * promoted row, of the pending row at its revision before. `revisions`: each promoted row's revision before.
 */
export function ledgerIsThisImports(db: Database, marks: Record<LedgerTable, LedgerMark>, expected: {
  accountId: string; batchId: string | null; appeared: ReadonlySet<string>; promoted: ReadonlySet<string>;
  revisions: ReadonlyMap<string, unknown>;
}): boolean {
  const present = new Set(tableNames(db));
  for (const name of LEDGER_TABLES) {
    const now = present.has(name) ? ledgerDigestUpTo(db, name, marks[name].maxRowid) : 'absent';
    if (now !== marks[name].digest) return false;
  }
  const rowsOf = (name: LedgerTable) => (present.has(name) ? ledgerRowsAfter(db, name, marks[name]) : []);
  const { accountId, batchId, appeared, promoted, revisions } = expected;
  const identityOf = new Map<string, string>();
  for (const identity of rowsOf('card_source_identities')) {
    const row = identity.canonical_transaction_id as string;
    if (identity.card_account_id !== accountId || identity.import_batch_id !== batchId || identity.status !== 'active'
      || !appeared.has(row)) return false;
    identityOf.set(identity.id as string, row);
  }
  if (identityOf.size !== appeared.size || new Set(identityOf.values()).size !== appeared.size) return false;
  const canonicalOf = db.prepare('SELECT canonical_transaction_id FROM card_source_identities WHERE id = ?').pluck();
  const contents = rowsOf('card_identity_contents');
  const contentFor = new Set<string>();
  for (const content of contents) {
    const identityId = content.identity_id as string;
    const inserted = identityOf.has(identityId);
    const row = inserted ? identityOf.get(identityId) : canonicalOf.get(identityId) as string | undefined;
    if (row === undefined || content.resolution !== (inserted ? 'inserted' : 'promoted') || !(inserted ? appeared : promoted).has(row)) {
      return false;
    }
    contentFor.add(row);
  }
  if (contents.length !== appeared.size + promoted.size || contentFor.size !== contents.length) return false;
  const events = rowsOf('card_transaction_events');
  const eventFor = new Set<string>();
  for (const event of events) {
    const row = event.card_transaction_id as string;
    if (event.card_account_id !== accountId || event.import_batch_id !== batchId
      || !((event.event_type === 'created' && appeared.has(row)) || (event.event_type === 'promoted' && promoted.has(row)))) return false;
    eventFor.add(row);
  }
  if (events.length !== appeared.size + promoted.size || eventFor.size !== events.length) return false;
  const versions = rowsOf('card_transaction_versions');
  const versionFor = new Set<string>();
  for (const version of versions) {
    const row = version.card_transaction_id as string;
    if (!promoted.has(row) || version.card_account_id !== accountId || version.revision !== revisions.get(row)) return false;
    versionFor.add(row);
  }
  return versions.length === promoted.size && versionFor.size === versions.length;
}