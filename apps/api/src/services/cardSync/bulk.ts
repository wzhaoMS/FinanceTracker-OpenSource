import type { Database as DB, Statement } from 'better-sqlite3';

/**
 * Multi-row INSERTs for the card-sync tables a set writes in bulk
 * (observations, secondary ids, items, candidates, coverage): one statement
 * per chunk instead of one per row, so a 2,000-row acceptance stays inside
 * design §7.11's P1 with every guard and invariant trigger still checking
 * each row.
 */

const CHUNK_ROWS = 250;
const MAX_BOUND_PARAMETERS = 32_766;
const cache = new WeakMap<DB, Map<string, Statement>>();

function prepared(db: DB, sql: string): Statement {
  let statements = cache.get(db);
  if (!statements) {
    statements = new Map();
    cache.set(db, statements);
  }
  let statement = statements.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    statements.set(sql, statement);
  }
  return statement;
}

/** Inserts `rows` (each in `columns` order) into `table`, in order. */
export function insertRows(db: DB, table: string, columns: readonly string[], rows: ReadonlyArray<readonly unknown[]>): void {
  const perStatement = Math.max(1, Math.min(CHUNK_ROWS, Math.floor(MAX_BOUND_PARAMETERS / columns.length)));
  const tuple = `(${columns.map(() => '?').join(', ')})`;
  for (let start = 0; start < rows.length; start += perStatement) {
    const chunk = rows.slice(start, start + perStatement);
    prepared(db, `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${Array<string>(chunk.length).fill(tuple).join(', ')}`)
      .run(chunk.flat());
  }
}

/** A cached prepared statement on this connection. */
export function cachedStatement(db: DB, sql: string): Statement {
  return prepared(db, sql);
}
