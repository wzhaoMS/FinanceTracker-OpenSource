import Database from 'better-sqlite3';

import { digest } from './amazon/policy.js';
import { toValueFreeDbError } from './dbErrors.js';

/**
 * The shape of an operator-installed schema, shared by every domain that declares one (the metals ledger; the retail
 * domain from Costco PR 2): a statement's comparable text, a statement list's digest, and how a database's objects of one
 * name prefix compare with the objects the statements make. Moved unchanged from the metals ledger's schema.ts (#299,
 * review P299-2) and generalized only by the prefix, so that no later domain re-implements the comparison (Costco plan v5
 * §12, Q-D1). Read-only: nothing here installs, repairs or drops anything.
 */

/** A string literal type; `string` itself, a value computed at run time, becomes `never` (as in dbErrors.ts). */
type Literal<T extends string> = string extends T ? never : T;

/** SQLite's whitespace between tokens. */
const SQL_SPACE = /[ \t\n\v\f\r]/;
/** Quoted text in SQL: a string literal ('…') or a quoted identifier ("…", `…`, […]), by its closing character. */
const QUOTE_CLOSE: ReadonlyMap<string, string> = new Map([["'", "'"], ['"', '"'], ['`', '`'], ['[', ']']]);

/**
 * A statement's comparable text (review P299-2). Each run of whitespace between tokens becomes one space, and the ends
 * are trimmed. Quoted text (string literals and quoted identifiers, a doubled closing quote included) is kept exactly,
 * so a declaration that differs inside a literal, such as a GLOB pattern's spaces, never compares or digests equal.
 * Unterminated quoted text is kept verbatim to the end, so it can only differ.
 */
export function normalizeSchemaSql(sql: string): string {
  let out = '';
  let space = false;
  for (let at = 0; at < sql.length;) {
    const char = sql[at];
    if (SQL_SPACE.test(char)) {
      space = true;
      at += 1;
      continue;
    }
    if (space && out !== '') out += ' ';
    space = false;
    const close = QUOTE_CLOSE.get(char);
    if (close === undefined) {
      out += char;
      at += 1;
      continue;
    }
    let end = at + 1;
    for (;;) {
      if (end >= sql.length) return out + sql.slice(at);
      if (sql[end] === close) {
        if (close !== ']' && sql[end + 1] === close) {
          end += 2;
          continue;
        }
        break;
      }
      end += 1;
    }
    out += sql.slice(at, end + 1);
    at = end + 1;
  }
  return out;
}

/** The digest of a statement list, each statement in its comparable text. */
export const schemaSqlDigest = (statements: readonly string[]): string => digest(statements.map(normalizeSchemaSql));

/** A declared schema: the statements that make it, in order, and the name prefix its objects carry. */
export interface DeclaredSchema {
  /**
   * A lower-case letter, then lower-case letters, digits or `_`, ending in `_` (`metals_`, `retail_`). Every object the
   * statements make is named with it or is on a table that is.
   */
  readonly prefix: string;
  /** Frozen: the objects a list makes are computed once, and cached by the list itself. */
  readonly statements: readonly string[];
}

const PREFIX = /^[a-z][a-z0-9_]*_$/;

interface SchemaObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

const EXPECTED = new WeakMap<readonly string[], ReadonlyMap<string, SchemaObject>>();

/** Whether an object carries the prefix, as the comparison's query finds it: by its name or its table's, in any case. */
const carries = (object: SchemaObject, prefix: string) =>
  object.name.toLowerCase().startsWith(prefix) || object.tbl_name.toLowerCase().startsWith(prefix);

/** Every object the statements make, as SQLite records it, made in a private in-memory database and then closed. */
function objectsOf(statements: readonly string[]): ReadonlyMap<string, SchemaObject> {
  const memory = new Database(':memory:');
  try {
    for (const sql of statements) memory.exec(sql);
    const objects = memory.prepare('SELECT type, name, tbl_name, sql FROM main.sqlite_master').all() as SchemaObject[];
    return new Map(objects.map((object) => [object.name, { ...object, sql: object.sql === null ? null : normalizeSchemaSql(object.sql) }]));
  } finally {
    memory.close();
  }
}

/**
 * Every object the declared statements make, by name, as SQLite records it (the tables, their primary-key and unique
 * indexes, the declared indexes and triggers): created once per statement list in a private in-memory database, so the
 * automatic index names are SQLite's own. A declaration that couldn't compare soundly is refused: a prefix of another
 * shape, a list that isn't frozen (the cache would outlive a change to it), or an object the prefix doesn't find (it
 * could never be present).
 */
function expectedObjects(schema: DeclaredSchema): ReadonlyMap<string, SchemaObject> {
  if (!PREFIX.test(schema.prefix) || !Object.isFrozen(schema.statements)) {
    throw new TypeError('a declared schema needs a lower-case prefix ending in _ and a frozen statement list');
  }
  let expected = EXPECTED.get(schema.statements);
  if (expected === undefined) {
    expected = objectsOf(schema.statements);
    EXPECTED.set(schema.statements, expected);
  }
  for (const object of expected.values()) {
    if (!carries(object, schema.prefix)) throw new TypeError('a declared object does not carry its schema prefix');
  }
  return expected;
}

export type SchemaState = 'present' | 'absent' | 'conflict';

/** How a database's objects of one prefix compare to the declared schema, as counts. */
export interface SchemaObjectCounts {
  expected: number;
  matching: number;
  differing: number;
  missing: number;
  unexpected: number;
}

/** A LIKE pattern for the names that begin with the prefix: its `_` (and any `%` or `\`) escaped, so none is a wildcard. */
const likePrefix = (prefix: string) => `${prefix.replace(/[\\_%]/g, (special) => `\\${special}`)}%`;

/**
 * Every object named `<prefix>…` or on a `<prefix>` table, in any letter case, compared with the declared schema. Any
 * failure, a refused declaration included, leaves as a value-free error naming only `what`, a literal from the call site
 * (metals: `read metals schema`).
 */
export function schemaObjects<Op extends string>(db: Database.Database, schema: DeclaredSchema, what: Op & Literal<Op>): SchemaObjectCounts {
  try {
    const want = expectedObjects(schema);
    const like = likePrefix(schema.prefix);
    const found = db.prepare(`SELECT type, name, tbl_name, sql FROM main.sqlite_master
      WHERE lower(name) LIKE ? ESCAPE '\\' OR lower(tbl_name) LIKE ? ESCAPE '\\'`).all(like, like) as Array<Record<string, unknown>>;
    let matching = 0;
    let differing = 0;
    let unexpected = 0;
    const seen = new Set<string>();
    for (const object of found) {
      const declared = typeof object.name === 'string' ? want.get(object.name) : undefined;
      if (!declared) {
        unexpected += 1;
        continue;
      }
      seen.add(declared.name);
      const sql = typeof object.sql === 'string' ? normalizeSchemaSql(object.sql) : null;
      if (object.type === declared.type && object.tbl_name === declared.tbl_name && sql === declared.sql) matching += 1;
      else differing += 1;
    }
    return { expected: want.size, matching, differing, missing: want.size - seen.size, unexpected };
  } catch (error) {
    throw toValueFreeDbError<Op>(what, error);
  }
}

/**
 * `present` only for exactly the declared objects; `absent` when nothing carries the prefix and nothing is on such a
 * table; `conflict` for anything else (another shape, a missing or extra object, a view or trigger of such a name, a
 * name in other letter case).
 */
export function schemaState(objects: SchemaObjectCounts): SchemaState {
  if (objects.matching + objects.differing + objects.unexpected === 0) return 'absent';
  return objects.matching === objects.expected && objects.differing === 0 && objects.unexpected === 0 ? 'present' : 'conflict';
}
