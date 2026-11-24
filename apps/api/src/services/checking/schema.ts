import type { Database } from 'better-sqlite3';

import { digest } from '../amazon/policy.js';
import { HoldrRefusal, toValueFreeDbError } from '../dbErrors.js';

/**
 * The checking-account tables. Nothing creates them at boot and no migration touches them: only the backed-up,
 * Root-GO'd operator command (`holdr-checking install`, cli/checking.ts) installs them. Every reader works without
 * them (no accounts, no rows). A table or index of another shape, or anything else holding one of their names, is a
 * conflict: never repaired, never read.
 *
 * Checking rows are never spending: no card, spending, brokerage or portfolio code reads these tables. They are the
 * source a card payment may have come from (the card-payment reconciliation reads them through ledger.ts).
 *
 * Row and account ids are random (`chk-txn-`, `chk-acct-`, `chk-imp-` + 32 letters a-p) and never change; a row is
 * keyed by content (`row_key`, checkingRowKey) and unique per account, so an import never deletes or rewrites one.
 */
const ID = (column: string, prefix: string) =>
  `typeof(${column}) = 'text' AND length(${column}) = ${prefix.length + 32} AND substr(${column}, 1, ${prefix.length}) = '${prefix}' AND substr(${column}, ${prefix.length + 1}) NOT GLOB '*[^a-p]*'`;
const DAY = (column: string) => `typeof(${column}) = 'text' AND length(${column}) = 10 AND date(${column}) IS ${column}`;
const INSTANT = (column: string) => `typeof(${column}) = 'text' AND length(${column}) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) IS ${column}`;
const SLUG = (column: string) => `typeof(${column}) = 'text' AND length(${column}) BETWEEN 1 AND 32 AND substr(${column}, 1, 1) GLOB '[a-z]' AND ${column} NOT GLOB '*[^a-z-]*'`;
const LONG_DIGITS = `'*${'[0-9]'.repeat(13)}*'`;

export const CHECKING_SCHEMA: ReadonlyArray<{ type: 'table' | 'index'; name: string; sql: string }> = Object.freeze([
  { type: 'table', name: 'checking_accounts', sql: `CREATE TABLE checking_accounts (
  id TEXT NOT NULL PRIMARY KEY CHECK (${ID('id', 'chk-acct-')}),
  institution TEXT NOT NULL CHECK (${SLUG('institution')}),
  account_type TEXT NOT NULL CHECK (account_type = 'checking'),
  last4 TEXT NOT NULL CHECK (typeof(last4) = 'text' AND length(last4) = 4 AND last4 NOT GLOB '*[^0-9]*'),
  label TEXT NOT NULL CHECK (typeof(label) = 'text' AND length(label) BETWEEN 1 AND 60 AND label NOT GLOB '*[0-9]*'),
  currency TEXT NOT NULL CHECK (typeof(currency) = 'text' AND length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*'),
  status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
  created_at TEXT NOT NULL CHECK (${INSTANT('created_at')}),
  UNIQUE (institution, account_type, last4)
)` },
  { type: 'table', name: 'checking_imports', sql: `CREATE TABLE checking_imports (
  id TEXT NOT NULL PRIMARY KEY CHECK (${ID('id', 'chk-imp-')}),
  checking_account_id TEXT NOT NULL REFERENCES checking_accounts(id),
  payload_digest TEXT NOT NULL CHECK (typeof(payload_digest) = 'text' AND length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
  parser_version TEXT NOT NULL CHECK (typeof(parser_version) = 'text' AND length(parser_version) BETWEEN 1 AND 64),
  go_id TEXT NOT NULL CHECK (typeof(go_id) = 'text' AND length(go_id) = 32 AND go_id NOT GLOB '*[^0-9a-f]*'),
  purpose TEXT NOT NULL CHECK (purpose IN ('copy-rehearsal', 'production-import')),
  rows_inserted INTEGER NOT NULL CHECK (typeof(rows_inserted) = 'integer' AND rows_inserted >= 0),
  rows_matched INTEGER NOT NULL CHECK (typeof(rows_matched) = 'integer' AND rows_matched >= 0),
  imported_at TEXT NOT NULL CHECK (${INSTANT('imported_at')}),
  UNIQUE (checking_account_id, payload_digest)
)` },
  { type: 'table', name: 'checking_coverage', sql: `CREATE TABLE checking_coverage (
  import_id TEXT NOT NULL REFERENCES checking_imports(id),
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
  checking_account_id TEXT NOT NULL REFERENCES checking_accounts(id),
  source TEXT NOT NULL CHECK (${SLUG('source')}),
  start_date TEXT NOT NULL CHECK (${DAY('start_date')}),
  end_date TEXT NOT NULL CHECK (${DAY('end_date')} AND end_date >= start_date),
  row_count INTEGER NOT NULL CHECK (typeof(row_count) = 'integer' AND row_count >= 0),
  PRIMARY KEY (import_id, ordinal)
)` },
  { type: 'table', name: 'checking_transactions', sql: `CREATE TABLE checking_transactions (
  id TEXT NOT NULL PRIMARY KEY CHECK (${ID('id', 'chk-txn-')}),
  checking_account_id TEXT NOT NULL REFERENCES checking_accounts(id),
  import_id TEXT NOT NULL REFERENCES checking_imports(id),
  row_key TEXT NOT NULL CHECK (typeof(row_key) = 'text' AND length(row_key) = 70 AND substr(row_key, 1, 6) = 'chkd1:' AND substr(row_key, 7) NOT GLOB '*[^a-p]*'),
  posted_date TEXT NOT NULL CHECK (${DAY('posted_date')}),
  amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor BETWEEN -9999999999 AND 9999999999),
  currency TEXT NOT NULL CHECK (typeof(currency) = 'text' AND length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*'),
  description TEXT NOT NULL CHECK (typeof(description) = 'text' AND length(description) BETWEEN 1 AND 500 AND description NOT GLOB ${LONG_DIGITS}),
  check_number TEXT CHECK (check_number IS NULL OR (typeof(check_number) = 'text' AND length(check_number) BETWEEN 1 AND 10 AND check_number NOT GLOB '*[^0-9]*')),
  bank_type TEXT CHECK (bank_type IS NULL OR (typeof(bank_type) = 'text' AND length(bank_type) BETWEEN 1 AND 20 AND bank_type NOT GLOB '*[^A-Z0-9_.-]*')),
  external_id_hash TEXT CHECK (external_id_hash IS NULL OR (typeof(external_id_hash) = 'text' AND length(external_id_hash) = 69 AND substr(external_id_hash, 1, 5) = 'xid1:' AND substr(external_id_hash, 6) NOT GLOB '*[^a-p]*')),
  UNIQUE (checking_account_id, row_key)
)` },
  { type: 'index', name: 'checking_transactions_by_date', sql: 'CREATE INDEX checking_transactions_by_date ON checking_transactions (posted_date, checking_account_id)' },
  { type: 'table', name: 'checking_balances', sql: `CREATE TABLE checking_balances (
  checking_account_id TEXT NOT NULL REFERENCES checking_accounts(id),
  as_of_date TEXT NOT NULL CHECK (${DAY('as_of_date')}),
  balance_minor INTEGER NOT NULL CHECK (typeof(balance_minor) = 'integer' AND balance_minor BETWEEN -99999999999 AND 99999999999),
  kind TEXT NOT NULL CHECK (kind IN ('opening', 'closing', 'daily', 'ledger')),
  import_id TEXT NOT NULL REFERENCES checking_imports(id),
  PRIMARY KEY (checking_account_id, as_of_date)
)` },
]);

const normalizeSql = (sql: string) => sql.trim().replace(/\s+/g, ' ');
const EXPECTED = new Map(CHECKING_SCHEMA.map((object) => [object.name, { type: object.type, sql: normalizeSql(object.sql) }]));
export const CHECKING_SCHEMA_DIGEST = digest(CHECKING_SCHEMA.map((object) => normalizeSql(object.sql)));

export type CheckingSchemaState = 'present' | 'absent' | 'conflict';

/**
 * Read-only: `present` only for exactly this build's tables and index, `absent` when nothing holds any of their
 * names, `conflict` for anything else (another shape, a missing part, a view or trigger of such a name, a name in
 * other letter case).
 */
export function checkingSchemaState(db: Database): CheckingSchemaState {
  try {
    const objects = db.prepare(`SELECT type, name, sql FROM main.sqlite_master WHERE lower(name) IN (${CHECKING_SCHEMA.map(() => '?').join(', ')})`)
      .all(...CHECKING_SCHEMA.map((object) => object.name.toLowerCase())) as Array<{ type: unknown; name: unknown; sql: unknown }>;
    if (objects.length === 0) return 'absent';
    if (objects.length !== CHECKING_SCHEMA.length) return 'conflict';
    return objects.every((object) => {
      const expected = typeof object.name === 'string' ? EXPECTED.get(object.name) : undefined;
      return expected !== undefined && object.type === expected.type && typeof object.sql === 'string' && normalizeSql(object.sql) === expected.sql;
    }) ? 'present' : 'conflict';
  } catch (error) {
    throw toValueFreeDbError('read checking schema', error);
  }
}

/** A write before the operator installed the tables, or while something else holds their names. */
export const CHECKING_NOT_INSTALLED = 'checking accounts are not installed on this Holdr';

export function requireCheckingSchema(db: Database): void {
  if (checkingSchemaState(db) !== 'present') throw new HoldrRefusal(CHECKING_NOT_INSTALLED);
}

/**
 * Only the operator command calls this, inside its backed-up IMMEDIATE transaction (called alone, it runs in one of
 * its own): nothing when the tables are there, a refusal for a conflict, else the tables, verified before commit.
 */
export function installCheckingSchema(db: Database): void {
  try {
    db.transaction(() => {
      const state = checkingSchemaState(db);
      if (state === 'present') return;
      if (state === 'conflict') throw new HoldrRefusal('checking tables already exist in another shape; nothing was installed');
      for (const object of CHECKING_SCHEMA) db.exec(object.sql);
      if (checkingSchemaState(db) !== 'present') throw new HoldrRefusal('checking tables did not install as expected; nothing was installed');
    }).immediate();
  } catch (error) {
    throw toValueFreeDbError('install checking schema', error);
  }
}
