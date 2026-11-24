import Database from 'better-sqlite3';

import { CARD_TABLES } from '../services/cardGuards.js';
import { CARD_REPORTS_V14_SCHEMA_FOR_TESTS, CARD_SPENDING_V13_SCHEMA_FOR_TESTS } from '../services/sqliteStateRepo.js';

type RawDb = Database.Database;

/** The columns v14 (Phase 4) added to v13's card tables. */
export const CARD_V14_COLUMNS = [
  ['card_accounts', 'last5'],
  ['card_import_batches', 'coverage_end'],
  ['card_import_batches', 'coverage_start'],
  ['card_transactions', 'dismissed_at'],
] as const;

/** The columns v15 (card sync) added to v13's card tables. */
export const CARD_V15_COLUMNS = [
  ['card_accounts', 'ledger_revision'],
  ['card_transactions', 'card_scope_id'], ['card_transactions', 'revision'], ['card_transactions', 'first_sync_run_id'],
  ['card_transactions', 'removed_reason'], ['card_transactions', 'removed_from_status'], ['card_transactions', 'removed_at'],
  ['card_transactions', 'merged_into_id'], ['card_transactions', 'reversal_snapshot_revision'],
] as const;

/** v13's card tables, which every later schema keeps. */
export const CARD_V13_TABLES: readonly string[] = ['card_accounts', 'card_import_batches', 'card_transactions'];

const GUARD_TRIGGERS = "type = 'trigger' AND (name LIKE 'trg_card%_guard_insert' OR name LIKE 'trg_card%_guard_update')";

/** The SQL of every card guard trigger installed in `db`. */
export function cardGuardSql(db: RawDb): string[] {
  return (db.prepare(`SELECT sql FROM sqlite_master WHERE ${GUARD_TRIGGERS}`).all() as Array<{ sql: string }>).map((row) => row.sql);
}

/** A guard as the same build installs it on a schema without `columns`: their checks taken out. */
export const withoutGuardChecks = (columns: ReadonlyArray<readonly [string, string]>) => (sql: string): string => sql.split('\n')
  .filter((line) => !columns.some(([, column]) => line.includes(`NEW."${column}"`)))
  .join('\n');

/** A statement of an upgrade-test schema, cut out by where it starts (to the end of that schema text). */
const from = (schema: string, start: string) => schema.slice(schema.indexOf(start));

/**
 * Turns a database this build wrote into the database the same guard build
 * wrote at schema v13 (before Phase 4) or v14 (before card sync): v15's
 * tables, triggers and indexes dropped; card_transactions rebuilt in its
 * v13 form (v14: with dismissed_at), rowids and every older value kept; the
 * later columns of the other two tables dropped; their checks taken out of
 * the guards; and the user_version set. Every older column and row stays as
 * it was. (sqliteStateRepo.test.ts pins the v14 guard text this produces to
 * the text main's v14 build installs.)
 */
export function downgradeCardSchema(file: string, version: 13 | 14): void {
  const db = new Database(file);
  // Tables are dropped parents first (card scopes before the rows they
  // attributed), as the older schema never had them.
  db.pragma('foreign_keys = OFF');
  try {
    const guards = cardGuardSql(db).filter((sql) => CARD_V13_TABLES.some((table) => sql.startsWith(`CREATE TRIGGER trg_${table}_guard_`)));
    const dropped = version === 13 ? [...CARD_V14_COLUMNS, ...CARD_V15_COLUMNS] : [...CARD_V15_COLUMNS];
    const kept = (db.prepare('PRAGMA table_info(card_transactions)').all() as Array<{ name: string }>).map((column) => column.name)
      .filter((column) => !dropped.some(([table, name]) => table === 'card_transactions' && name === column));
    if (kept.length !== (version === 13 ? 21 : 22)) {
      throw new Error(`card_transactions keeps ${kept.length} columns, not its v${version} set`);
    }
    db.transaction(() => {
      const objects = (sql: string) => db.prepare(sql).all() as Array<{ type: string; name: string }>;
      for (const { name } of objects("SELECT type, name FROM sqlite_master WHERE type = 'trigger' AND tbl_name LIKE 'card_%'")) {
        db.exec(`DROP TRIGGER ${name}`);
      }
      for (const table of [...CARD_TABLES].reverse()) if (!CARD_V13_TABLES.includes(table)) db.exec(`DROP TABLE ${table}`);
      for (const { name } of objects(`SELECT type, name FROM sqlite_master WHERE type = 'index'
          AND tbl_name IN ('card_accounts', 'card_import_batches') AND instr(name, '_fk_') > 0`)) {
        db.exec(`DROP INDEX ${name}`);
      }
      db.exec('ALTER TABLE card_transactions RENAME TO card_transactions_v15');
      for (const { name } of objects("SELECT type, name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'card_transactions_v15' AND name LIKE 'idx_%'")) {
        db.exec(`DROP INDEX ${name}`);
      }
      db.exec(from(CARD_SPENDING_V13_SCHEMA_FOR_TESTS, 'CREATE TABLE card_transactions'));
      if (version === 14) db.exec(from(CARD_REPORTS_V14_SCHEMA_FOR_TESTS, 'ALTER TABLE card_transactions ADD COLUMN dismissed_at'));
      db.exec(`INSERT INTO card_transactions (rowid, ${kept.join(', ')}) SELECT rowid, ${kept.join(', ')}
        FROM card_transactions_v15 ORDER BY rowid`);
      db.exec('DROP TABLE card_transactions_v15');
      for (const [table, column] of dropped) if (table !== 'card_transactions') db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      for (const sql of guards) db.exec(withoutGuardChecks(dropped)(sql));
      db.pragma(`user_version = ${version}`);
    })();
  } finally {
    db.close();
  }
}
