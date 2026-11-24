import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { digest } from './amazon/policy.js';
import { HoldrDbError } from './dbErrors.js';
import {
  METALS_SCHEMA_DIGEST,
  METALS_SCHEMA_SQL,
  metalsSchemaObjects,
  metalsSchemaState,
  metalsSqlDigest,
  normalizeMetalsSql,
} from './metals/index.js';
import { normalizeSchemaSql, schemaObjects, schemaSqlDigest, schemaState, type DeclaredSchema } from './schemaShape.js';

// Synthetic only: in-memory databases and invented `demo_` and `other_` objects.

const DEMO: DeclaredSchema = Object.freeze({
  prefix: 'demo_',
  statements: Object.freeze([
    `CREATE TABLE demo_items (id TEXT PRIMARY KEY, label TEXT NOT NULL CHECK (label NOT GLOB '*  *'), UNIQUE (label))`,
    'CREATE INDEX demo_items_by_label ON demo_items (label)',
    `CREATE TRIGGER demo_items_no_delete BEFORE DELETE ON demo_items BEGIN SELECT RAISE(ABORT, 'demo items are append-only'); END`,
  ]),
});
/** The same prefix, another statement list: one more column. */
const DEMO_V2: DeclaredSchema = Object.freeze({
  prefix: 'demo_',
  statements: Object.freeze([DEMO.statements[0].replace('label TEXT NOT NULL', 'label TEXT NOT NULL, note TEXT'), ...DEMO.statements.slice(1)]),
});
const OTHER: DeclaredSchema = Object.freeze({ prefix: 'other_', statements: Object.freeze(['CREATE TABLE other_rows (id INTEGER PRIMARY KEY, ref TEXT)']) });
/** The table, its two automatic indexes (primary key, unique label), the declared index and the trigger. */
const DEMO_OBJECTS = 5;

const opened: Database.Database[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
/** A new in-memory database, with these statements run. */
const database = (...statements: readonly string[]) => {
  const db = new Database(':memory:');
  opened.push(db);
  for (const sql of statements) db.exec(sql);
  return db;
};
const compared = (db: Database.Database, schema: DeclaredSchema = DEMO) => schemaObjects(db, schema, 'read demo schema');
const counts = (matching: number, differing: number, missing: number, unexpected: number, expected = DEMO_OBJECTS) =>
  ({ expected, matching, differing, missing, unexpected });
/**
 * A check's action part: the value-free HoldrDbError `fn` throws, kept as thrown, or null when `fn` returns. Anything else is
 * re-thrown unchanged, so no catch turns an unexpected error into data for an assertion (ROOT's kill standard, addendum 3(e)
 * and ruling 8); each `expect` on its result is the assertion-only part.
 */
const dbError = (fn: () => unknown): HoldrDbError | null => {
  try {
    fn();
  } catch (error) {
    if (error instanceof HoldrDbError) return error;
    throw error;
  }
  return null;
};

describe('a statement\'s comparable text and a list\'s digest', () => {
  it('folds the whitespace between tokens and trims the ends, and keeps quoted text exactly', () => {
    expect(normalizeSchemaSql(' \t\nCREATE  TABLE\r\n demo_x\f(a  INT)\v ')).toBe('CREATE TABLE demo_x (a INT)');
    expect(normalizeSchemaSql("CHECK (label   NOT GLOB '*  *')\n")).toBe("CHECK (label NOT GLOB '*  *')");
    expect(normalizeSchemaSql("x = 'it''s  two'  AND \"a  \"\"b\" = `c  d` AND [e  f]  = 1"))
      .toBe("x = 'it''s  two' AND \"a  \"\"b\" = `c  d` AND [e  f] = 1");
    // A bracketed identifier has no doubled-quote escape: it ends at its first `]`.
    expect(normalizeSchemaSql('[a  b]]  c')).toBe('[a  b]] c');
    expect(normalizeSchemaSql("x = 'open  \n  end")).toBe("x = 'open  \n  end");
    expect(normalizeSchemaSql('a\u00a0\u00a0b')).toBe('a\u00a0\u00a0b');
    expect(normalizeSchemaSql(' \n\t ')).toBe('');
  });

  it('digests each statement\'s comparable text, in order: whitespace never counts, a literal or the order always does', () => {
    const statements = ['CREATE  TABLE demo_x (a INT)', "CHECK (b NOT GLOB '*  *')"];
    expect(schemaSqlDigest(statements)).toBe(digest(statements.map(normalizeSchemaSql)));
    expect(schemaSqlDigest(statements)).toMatch(/^[0-9a-f]{64}$/);
    expect(schemaSqlDigest(['CREATE TABLE  demo_x (a  INT)', "  CHECK (b NOT GLOB '*  *')\n"])).toBe(schemaSqlDigest(statements));
    expect(schemaSqlDigest(['CREATE TABLE demo_x (a INT)', "CHECK (b NOT GLOB '* *')"])).not.toBe(schemaSqlDigest(statements));
    expect(schemaSqlDigest([...statements].reverse())).not.toBe(schemaSqlDigest(statements));
  });
});

describe('a database\'s objects of one prefix, compared with the declaration', () => {
  it('is absent with nothing of the prefix, and present with exactly the declared objects', () => {
    const db = database();
    expect(compared(db)).toEqual(counts(0, 0, DEMO_OBJECTS, 0));
    expect(schemaState(compared(db))).toBe('absent');
    for (const sql of DEMO.statements) db.exec(sql);
    expect(compared(db)).toEqual(counts(DEMO_OBJECTS, 0, 0, 0));
    expect(schemaState(compared(db))).toBe('present');
  });

  it('is a conflict for an extra object (by its name in any case, or by its table), a missing one, or another shape', () => {
    const extras = [
      'CREATE INDEX other_index ON demo_items (id)',
      'CREATE TABLE Demo_Extra (id TEXT)',
      'CREATE VIEW demo_view AS SELECT 1 AS one',
      'CREATE TABLE plain (id TEXT); CREATE TRIGGER demo_audit AFTER INSERT ON plain BEGIN SELECT 1; END',
    ];
    for (const extra of extras) {
      const db = database(...DEMO.statements, extra);
      expect(compared(db), extra).toEqual(counts(DEMO_OBJECTS, 0, 0, 1));
      expect(schemaState(compared(db))).toBe('conflict');
    }
    const missing = database(...DEMO.statements, 'DROP INDEX demo_items_by_label');
    expect(compared(missing)).toEqual(counts(DEMO_OBJECTS - 1, 0, 1, 0));
    expect(schemaState(compared(missing))).toBe('conflict');
    // One space where the declared CHECK's literal has two: whitespace inside quotes is never folded.
    const changed = database(...DEMO.statements.map((sql) => sql.replace("'*  *'", "'* *'")));
    expect(compared(changed)).toEqual(counts(DEMO_OBJECTS - 1, 1, 0, 0));
    expect(schemaState(compared(changed))).toBe('conflict');
  });

  it('is a conflict, never absent, when what carries the prefix is only a stray object, or only a declared name in another shape', () => {
    const stray = database('CREATE TABLE demo_stray (id TEXT)');
    expect(compared(stray)).toEqual(counts(0, 0, DEMO_OBJECTS, 1));
    expect(schemaState(compared(stray))).toBe('conflict');
    const reshaped = database('CREATE TABLE demo_items (id TEXT)');
    expect(compared(reshaped)).toEqual(counts(0, 1, DEMO_OBJECTS - 1, 0));
    expect(schemaState(compared(reshaped))).toBe('conflict');
  });

  it('finds only names that begin with the prefix itself: its `_` is no wildcard', () => {
    const db = database('CREATE TABLE demoxitems (id TEXT)', 'CREATE TABLE demo (id TEXT)', 'CREATE TABLE other_demo_items (id TEXT)',
      'CREATE INDEX plain_by_id ON demoxitems (id)');
    expect(compared(db)).toEqual(counts(0, 0, DEMO_OBJECTS, 0));
    expect(schemaState(compared(db))).toBe('absent');
  });

  it('keeps each declaration to its own prefix and its own statement list', () => {
    const db = database(...DEMO.statements, ...OTHER.statements);
    expect(schemaState(compared(db))).toBe('present');
    expect(schemaState(compared(db, OTHER))).toBe('present');
    expect(compared(db, OTHER)).toEqual(counts(1, 0, 0, 0, 1));
    // The same prefix with another list compares against that list's objects, never the first list's.
    expect(compared(db, DEMO_V2)).toEqual(counts(DEMO_OBJECTS - 1, 1, 0, 0));
    expect(schemaState(compared(db, DEMO_V2))).toBe('conflict');
    expect(schemaState(compared(db))).toBe('present');
  });

  it('refuses a declaration it cannot compare soundly, and any failure to read, as a value-free error naming only the caller\'s label', () => {
    const db = database(...DEMO.statements);
    const misdeclared: DeclaredSchema[] = [
      { prefix: 'demo_', statements: [...DEMO.statements] },
      ...['Demo_', 'demo', '', '_demo_', 'de%mo_', 'demo_ '].map((prefix) => ({ prefix, statements: DEMO.statements })),
      Object.freeze({ prefix: 'demo_', statements: Object.freeze(['CREATE TABLE elsewhere (id TEXT)']) }),
    ];
    for (const schema of misdeclared) {
      const error = dbError(() => compared(db, schema));
      expect(error, schema.prefix).toBeInstanceOf(HoldrDbError);
      expect(error).toMatchObject({ operation: 'read demo schema', code: 'UNKNOWN', message: 'read demo schema failed (UNKNOWN)' });
    }
    const broken = Object.freeze({ prefix: 'demo_', statements: Object.freeze(['CREATE TABLE demo_broken (']) });
    expect(dbError(() => compared(db, broken))).toMatchObject({ operation: 'read demo schema', code: 'SQLITE_ERROR',
      message: 'read demo schema failed (SQLITE_ERROR)' });
    const closed = new Database(':memory:');
    closed.close();
    expect(dbError(() => compared(closed))).toMatchObject({ operation: 'read demo schema', code: 'UNKNOWN' });
    expect(compared(db)).toEqual(counts(DEMO_OBJECTS, 0, 0, 0));
  });
});

describe('the metals ledger on the shared comparison', () => {
  it('keeps its exported names, its digest, its counts\' order and its value-free label', () => {
    expect(normalizeMetalsSql).toBe(normalizeSchemaSql);
    expect(metalsSqlDigest).toBe(schemaSqlDigest);
    expect(METALS_SCHEMA_DIGEST).toBe(schemaSqlDigest(METALS_SCHEMA_SQL));
    const db = database();
    const absent = metalsSchemaObjects(db);
    expect(Object.keys(absent)).toEqual(['expected', 'matching', 'differing', 'missing', 'unexpected']);
    expect(absent).toEqual({ expected: absent.expected, matching: 0, differing: 0, missing: absent.expected, unexpected: 0 });
    expect(absent.expected).toBeGreaterThan(METALS_SCHEMA_SQL.length);
    for (const sql of METALS_SCHEMA_SQL) db.exec(sql);
    expect(metalsSchemaState(db)).toBe('present');
    const closed = new Database(':memory:');
    closed.close();
    expect(dbError(() => metalsSchemaObjects(closed))).toMatchObject({ operation: 'read metals schema', code: 'UNKNOWN' });
    expect(dbError(() => metalsSchemaState(closed))).toMatchObject({ operation: 'read metals schema', code: 'UNKNOWN' });
  });
});
