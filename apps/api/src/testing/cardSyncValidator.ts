// @ts-nocheck -- a line-for-line port of the reviewed validator; see below.
/**
 * Card-sync schema v15 (E1b): the design's own validator, `validate-ddl.mjs`
 * (revision 8, approved by GPT-6 Astra with the design), ported into the test
 * suite so every probe it runs runs on every test run, against this build.
 *
 * The code below is the validator's, kept line for line so the two can be
 * diffed side by side, except for these substitutions:
 * - the SQL is the design's, as lifted into cardSyncSchemaSql.ts (the same
 *   `-- @block` and `-- @query` text the validator reads from the document);
 * - v13 and v14 are this build's own CARD_SCHEMA_SQL and
 *   CARD_REPORTS_SCHEMA_SQL (byte-identical to PR #6's, which the validator
 *   reads from git);
 * - the v14 → v15 migration is the repository's (cardLedger/migrateV15.ts),
 *   not the validator's emulation of it; phase A drops its invariant triggers
 *   again to probe the constraints alone, as the validator never created them;
 * - ids come from a seeded generator, so every run makes the same ones;
 * - the guarded retention benchmark runs with this build's real card guards
 *   (the repository installs them; the validator emulated them), and only in
 *   cardSyncRetention.benchmark.test.ts;
 * - that benchmark has up to five attempts, each on a ledger copy flushed to
 *   disk, with its measured calls starting on an empty WAL and a quiet disk
 *   (testing/quietDisk.ts), and it times each call's commit as well;
 * - its calls use the repository's work budget (CARD_SYNC_RETENTION_BUDGET_MS,
 *   the scheduler's too), not the validator's own 100 ms, so it times the
 *   calls the API makes;
 * - and they run as the repository runs them (O100): each call first checks
 *   that the WAL has no frames left to copy back, as the repository's fence
 *   does, the auto-checkpoint is off inside it, and the repository's own
 *   checkpoint follows it (checkpointAfterCardSyncRetention) as a slice of
 *   its own, timed and held to the same 250 ms;
 * - results are returned per section instead of printed, and the work files
 *   live in the caller's directory.
 * It is type-checked only as far as JavaScript is: the port's value is that it
 * is the reviewed code.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import * as e1a from '@finance-tracker/shared';

import { migrateCardSyncSchema } from '../services/cardLedger/migrateV15.js';
import { CARD_SYNC_RETENTION_BUDGET_MS } from '../services/cardSync/retention.js';
import { CARD_SYNC_BLOCKS, CARD_SYNC_QUERIES } from '../services/cardSyncSchemaSql.js';
import {
  CARD_GUARD_BUILD,
  CARD_REPORTS_V14_SCHEMA_FOR_TESTS,
  CARD_SPENDING_V13_SCHEMA_FOR_TESTS,
  SqliteStateRepo,
} from '../services/sqliteStateRepo.js';
import { type QuietDisk, flushFile, waitForQuietDisk } from './quietDisk.js';

const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/shared/src/cardSync/__fixtures__/valid');

export interface CardSyncValidatorOptions {
  /** Where the validator creates (and leaves) its databases. */
  workDir: string;
  /** `probes`: everything but the retention benchmark; `retention`: the benchmark alone. */
  sections: { probes?: boolean; retention?: boolean };
}

/** The catalogue of the design's DDL, and how much of it the probes refused through. */
export interface CardSyncValidatorCoverage {
  checks: number;
  columnChecks: number;
  tableChecks: number;
  fks: number;
  fkTotal: number;
  uniques: number;
  uniqueTotal: number;
  triggers: number;
  triggerTotal: number;
  newTables: number;
}

/** One run of the benchmark's retention calls on a fresh copy of the ledger. */
export interface CardSyncRetentionAttempt {
  calls: number[];
  /** Each call's commit, any checkpoint it ran included: the part of the call after its last chunk (ms). */
  commits: number[];
  /** The repository's checkpoint after each call, a slice of its own (ms; O100). */
  checkpoints: number[];
  worst: number;
  /** The slowest of those checkpoints (ms). */
  worstCheckpoint: number;
  worstChunk: Record<string, number>;
  settled: Record<string, number>;
  oneShot: number;
  twentyPlans: number;
  left: Record<string, number>;
  settledAll: boolean;
  /** The wait for a quiet disk before the attempt's measured calls. */
  disk: QuietDisk;
}

/** The benchmark's result: the reported attempt's figures, and every attempt. */
export interface CardSyncRetentionResult {
  calls: number[];
  /** The repository's checkpoint after each call (ms; O100). */
  checkpoints: number[];
  worst: number;
  worstCheckpoint: number;
  setupMs: number;
  worstChunk: Record<string, number>;
  settled: Record<string, number>;
  oneShot: number;
  twentyPlans: number;
  left: Record<string, number>;
  guardInfo: { tables: number; triggers: number; current: boolean };
  consentGrants: number;
  done: boolean;
  attempts: CardSyncRetentionAttempt[];
}

export interface CardSyncValidatorRun {
  results: {
    accepted: number;
    refused: number;
    behaviour: number;
    failures: string[];
    notes: string[];
    /** Set when the probes ran. */
    coverage?: CardSyncValidatorCoverage;
    /** Set when the benchmark ran. */
    retention?: CardSyncRetentionResult;
  };
  /** Every failure, by the section that found it; a section that ran has an entry. */
  sectionFailures: Record<string, string[]>;
  /** The named statements of design §5.3.1 the probes executed. */
  queriesUsed: string[];
}

/**
 * Runs the validator in `workDir` (it creates and keeps its databases there):
 * `sections.probes` runs everything but the retention benchmark,
 * `sections.retention` the benchmark alone. Returns the counts, every failure
 * by section, the notes and the coverage of the catalogue.
 */
export function runCardSyncValidator({ workDir, sections }: CardSyncValidatorOptions): CardSyncValidatorRun {
  const WORK = workDir;
  fs.mkdirSync(WORK, { recursive: true });
  const sectionFailures = new Map();
  let currentSection = 'migration';
  const section = (name) => { currentSection = name; if (!sectionFailures.has(name)) sectionFailures.set(name, []); };
  section('migration');
  // ------------------------------------------------------------------ helpers
  const L = 'abcdefghijklmnop';
  let prng = 0x2545f491;                                                // xorshift32, fixed seed: every run makes the same ids
  const nextByte = () => { prng ^= prng << 13; prng >>>= 0; prng ^= prng >>> 17; prng ^= prng << 5; prng >>>= 0; return prng & 255; };
  const letters = (n) => Array.from({ length: n }, () => L[nextByte() & 15]).join('');
  const id = (prefix) => prefix + letters(32);
  const dig = (prefix) => prefix + letters(64);
  const toLetterHex = (buf) => Array.from(buf, (b) => L[b >> 4] + L[b & 15]).join('');
  const H = (parts) => toLetterHex(crypto.createHash('sha256').update(Buffer.from(JSON.stringify(parts), 'utf8')).digest());
  const T0 = Date.parse('2026-10-17T10:00:00.000Z');
  const at = (seconds = 0) => new Date(T0 + seconds * 1000).toISOString();
  const DAY_S = 86400;
  const rcd1 = (r) => 'rcd1:' + H(['holdr.card-row-content', 1, r.transaction_date, r.posted_date ?? null, r.status, r.amount_minor,
    r.kind, r.description, r.merchant ?? null, r.issuer_category ?? null, r.original_amount_minor ?? null, r.original_currency ?? null]);

  const results = { accepted: 0, refused: 0, behaviour: 0, failures: [], notes: [] };
  function fail(what, detail) { results.failures.push(`${what}: ${detail}`); sectionFailures.get(currentSection).push(`${what}: ${detail}`); }
  function note(line) { results.notes.push(line); }

  // ------------------------------------------------------------------ inputs (the design's SQL, lifted into cardSyncSchemaSql.ts)
  const BLOCKS = new Map(Object.entries(CARD_SYNC_BLOCKS).map(([section, sql]) => [section, [sql]]));
  const block = (section) => {
    const list = BLOCKS.get(section);
    if (!list) throw new Error(`the design has no -- @block ${section}`);
    return list.join('\n');
  };
  const DOC_QUERIES = new Map(Object.entries(CARD_SYNC_QUERIES));
  const QUERIES_USED = new Set();
  const query = (name) => {
    const sql = DOC_QUERIES.get(name);
    if (!sql) throw new Error(`the design has no -- @query ${name}`);
    QUERIES_USED.add(name);
    return sql;
  };
  const V13_SQL = CARD_SPENDING_V13_SCHEMA_FOR_TESTS;
  const V14_SQL = CARD_REPORTS_V14_SCHEMA_FOR_TESTS;

  // ------------------------------------------------------------------ the catalogue, read from the DDL itself
  const ALL_V15 = [...BLOCKS.keys()].filter((s) => s.startsWith('2.')).map(block).join('\n');
  const CATALOGUE = { columnChecks: [], tableChecks: [], uniques: [], primaryKeys: [], triggers: [] };
  for (const stmt of ALL_V15.split(/;\s*\n/)) {
    const create = stmt.match(/CREATE TABLE (\w+) \(/);
    if (create) {
      const table = create[1];
      for (const line of stmt.split('\n')) {
        let m = line.match(/^ {2}(\w+)\s+(TEXT|INTEGER).*?CONSTRAINT (ck_\w+) CHECK \((.*)\),?$/);
        if (m) { CATALOGUE.columnChecks.push({ table, column: m[1], name: m[3], expr: m[4] }); continue; }
        m = line.match(/^ {2}CONSTRAINT (ck_\w+) CHECK \(\((.*)\) IS TRUE\),?$/);
        if (m) { CATALOGUE.tableChecks.push({ table, name: m[1] }); continue; }
        m = line.match(/^ {2}CONSTRAINT (pk_\w+) PRIMARY KEY \(([^)]*)\)/);
        if (m) CATALOGUE.primaryKeys.push({ table, name: m[1], columns: m[2].split(',').map((c) => c.trim()) });
      }
    }
    const alter = stmt.match(/ALTER TABLE (\w+) ADD COLUMN (\w+) [\s\S]*?CONSTRAINT (ck_\w+) CHECK \(([\s\S]*)\)$/);
    if (alter) CATALOGUE.columnChecks.push({ table: alter[1], column: alter[2], name: alter[3], expr: alter[4].trim() });
    for (const m of stmt.matchAll(/CREATE UNIQUE INDEX (\w+)\s+ON (\w+)\(([^)]*)\)(?:\s+WHERE ([^;]+))?/g)) {
      CATALOGUE.uniques.push({ name: m[1], table: m[2], columns: m[3].split(',').map((c) => c.trim()), where: m[4]?.trim() ?? null });
    }
    for (const m of stmt.matchAll(/CREATE TRIGGER (\w+)/g)) CATALOGUE.triggers.push(m[1]);
  }
  const NEW_TABLES = [...ALL_V15.matchAll(/CREATE TABLE (\w+) \(/g)].map((m) => m[1]);
  { // constraint names must be unique, or a refusal message could not say which rule refused
    const names = [...CATALOGUE.columnChecks, ...CATALOGUE.tableChecks, ...CATALOGUE.primaryKeys].map((c) => c.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    if (dupes.length) throw new Error(`duplicate constraint names: ${dupes.join(', ')}`);
  }

  // ------------------------------------------------------------------ expectations
  const KIND = { check: 'SQLITE_CONSTRAINT_CHECK', fk: 'SQLITE_CONSTRAINT_FOREIGNKEY', trigger: 'SQLITE_CONSTRAINT_TRIGGER' };
  function attempt(fn) {
    try { fn(); return null; } catch (error) { return error; }
  }
  function matches(error, expect) {
    if (!error) return false;
    if (expect.check) return error.code === KIND.check && error.message === `CHECK constraint failed: ${expect.check}`;
    if (expect.fk) return error.code === KIND.fk;
    if (expect.restrict) return error.code === KIND.trigger && error.message === 'FOREIGN KEY constraint failed';   // ON DELETE RESTRICT
    if (expect.unique) return /^SQLITE_CONSTRAINT_(UNIQUE|PRIMARYKEY)$/.test(error.code)
      && (expect.messages ? expect.messages.includes(error.message)
        : error.message.startsWith(expect.prefix ?? 'UNIQUE constraint failed'));
    if (expect.trigger) return error.code === KIND.trigger && error.message === `card invariant: ${expect.trigger}`;
    if (expect.notnull) return error.code === 'SQLITE_CONSTRAINT_NOTNULL';
    return false;
  }
  const describe = (e) => (e ? `${e.code}: ${e.message}` : 'accepted');
  let savepoint = 0;
  function inSavepoint(db, fn) {
    const name = `p${savepoint += 1}`;
    db.exec(`SAVEPOINT ${name}`);
    try { return fn(); } finally { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); }
  }
  const preparedInserts = new WeakMap();                                // port: one prepared statement per (connection, SQL)
  function insertRow(db, table, row, verb = 'INSERT') {
    const cols = Object.keys(row);
    const sql = `${verb} INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    if (!preparedInserts.has(db)) preparedInserts.set(db, new Map());
    const cache = preparedInserts.get(db);
    if (!cache.has(sql)) cache.set(sql, db.prepare(sql));
    cache.get(sql).run(cols.map((c) => (typeof row[c] === 'boolean' ? Number(row[c]) : row[c])));
  }
  const covered = { check: new Set(), fk: new Set(), unique: new Set(), trigger: new Set() };
  // A probe: `control` (optional) must be accepted, `act` must be refused exactly as `expect` says.
  function probe(db, label, { control, act, expect, cover }) {
    inSavepoint(db, () => {
      if (control) {
        const ok = inSavepoint(db, () => attempt(control));
        if (ok) { fail(label, `control refused (${describe(ok)})`); return; }
        results.accepted += 1;
      }
      const error = attempt(act);
      if (!matches(error, expect)) { fail(label, `expected ${JSON.stringify(expect)}, got ${describe(error)}`); return; }
      results.refused += 1;
      for (const [kind, key] of cover ?? []) covered[kind].add(key);
    });
  }

  // ------------------------------------------------------------------ v14 database with data, and the v15 migration
  const ACCT = { a1: id('card-acct-'), a2: id('card-acct-') };
  function buildV14(file, { withData }) {
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(V13_SQL);
    db.exec(V14_SQL);
    db.pragma('user_version = 14');
    if (!withData) return db;
    const acct = db.prepare(`INSERT INTO card_accounts (id, issuer, owner, last4, currency, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'USD', ?, ?)`);
    acct.run(ACCT.a1, 'chase', 'alex', '3391', at(-90 * DAY_S), at(-90 * DAY_S));
    acct.run(ACCT.a2, 'amex', 'joint', null, at(-90 * DAY_S), at(-90 * DAY_S));
    const batch = db.prepare(`INSERT INTO card_import_batches (id, card_account_id, source, parser_version, row_count, new_count,
      duplicate_count, rejected_count, imported_at, coverage_start, coverage_end) VALUES (?, ?, ?, 'csv@1.0.0', ?, ?, 0, 0, ?, ?, ?)`);
    const fb1 = id('card-import-');
    const fb2 = id('card-import-');
    batch.run(fb1, ACCT.a1, 'chase-csv', 4, 4, at(-60 * DAY_S), '2026-08-01', '2026-08-31');
    batch.run(fb2, ACCT.a2, 'amex-csv', 1, 1, at(-60 * DAY_S), null, null);
    const txn = db.prepare(`INSERT INTO card_transactions (id, card_account_id, source, external_id_hash, fingerprint, transaction_date,
      posted_date, status, amount_minor, currency, kind, description, merchant, user_category, notes, import_batch_id, created_at,
      updated_at, dismissed_at) VALUES (@id, @acct, @source, @xid, @fp, @td, @pd, @status, @amount, 'USD', @kind, @desc, @merchant,
      @cat, @notes, @batch, @created, @updated, @dismissed)`);
    const row = (o) => txn.run({ id: id('card-txn-'), acct: ACCT.a1, source: 'chase-csv', xid: null, fp: null, td: '2026-08-03',
      pd: '2026-08-04', status: 'posted', amount: 1234, kind: 'purchase', desc: 'SYNTHETIC COFFEE', merchant: null, cat: null,
      notes: null, batch: fb1, created: at(-60 * DAY_S), updated: at(-60 * DAY_S), dismissed: null, ...o });
    row({ xid: dig('xid1:'), cat: 'Dining', notes: 'team coffee' });
    row({ fp: dig('cfp1:'), status: 'pending', pd: null, amount: 4500, desc: 'SYNTHETIC HARDWARE' });
    row({ xid: dig('xid1:'), status: 'removed', pd: null, amount: 999, desc: 'SYNTHETIC PREAUTH', dismissed: at(-50 * DAY_S) });
    row({ fp: dig('cfp1:'), status: 'removed', amount: 777, desc: 'SYNTHETIC OUTSIDE TOOL' });
    row({ acct: ACCT.a2, source: 'amex-csv', batch: fb2, xid: dig('xid1:'), amount: -5000, kind: 'payment', desc: 'PAYMENT THANK YOU' });
    return db;
  }

  // The v15 migration: the repository's own (cardLedger/migrateV15.ts), steps 0-14 of the design's §3.1 inside one IMMEDIATE
  // transaction, exactly as the constructor runs it before the guard refresh. Phase A's constraints-only schema is the same
  // migration with its invariant triggers dropped again.
  function migrate(db, { triggers }) {
    db.transaction(() => {
      migrateCardSyncSchema(db, at(0));
      if (!triggers) {
        for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_%_inv_%'").all()) {
          db.exec(`DROP TRIGGER ${name}`);
        }
      }
      db.pragma('user_version = 15');
    }).immediate();
  }


  const schemaDump = (db) => db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all();

  note(`catalogue: ${NEW_TABLES.length} new tables, ${CATALOGUE.columnChecks.length} column checks, ${CATALOGUE.tableChecks.length
  } table checks, ${CATALOGUE.uniques.length} unique indexes, ${CATALOGUE.primaryKeys.length} composite primary keys, ${
    CATALOGUE.triggers.length} triggers; SQLite ${new Database(':memory:').prepare('SELECT sqlite_version() AS v').get().v}`);

  // Migration: upgraded (with data) vs fresh (empty v14), both with triggers; plus a constraints-only twin for phase A.
  const dbB = buildV14(path.join(WORK, 'upgraded.db'), { withData: true });
  const fileBytes = fs.readFileSync(path.join(WORK, 'upgraded.db'));
  migrate(dbB, { triggers: true });
  const freshDb = buildV14(path.join(WORK, 'fresh.db'), { withData: false });
  migrate(freshDb, { triggers: true });
  const same = JSON.stringify(schemaDump(dbB)) === JSON.stringify(schemaDump(freshDb));
  if (!same) fail('fresh vs upgraded', 'sqlite_master differs');
  note(`migration: ${dbB.prepare('SELECT count(*) AS n FROM card_transactions').get().n} rows kept with rowids; fresh and upgraded schemas ${same ? 'identical' : 'DIFFER'} (${schemaDump(freshDb).length} objects)`);
  freshDb.close();
  { // a refused upgrade leaves the main file byte-identical: plant card data the backfill would copy into a CHECKed column
    const file = path.join(WORK, 'refused.db');
    const db = buildV14(file, { withData: true });
    db.prepare("UPDATE card_import_batches SET source = 'Bad Source' WHERE coverage_start IS NOT NULL").run();
    db.pragma('wal_checkpoint(TRUNCATE)');
    const bytes = fs.readFileSync(file);
    const error = attempt(() => migrate(db, { triggers: true }));
    db.pragma('wal_checkpoint(TRUNCATE)');
    const unchanged = bytes.equals(fs.readFileSync(file)) && db.pragma('user_version', { simple: true }) === 14;
    if (!error || !unchanged) fail('refused upgrade', `error=${describe(error)} unchanged=${unchanged}`);
    else note(`refused upgrade (a v1 source outside the slug grammar, precondition P5) rolls back: file byte-identical, user_version 14`);
    db.close();
  }
  void fileBytes;
  const dbA = buildV14(path.join(WORK, 'constraints.db'), { withData: true });
  migrate(dbA, { triggers: false });
  for (const db of [dbA, dbB]) db.pragma('foreign_keys = ON');

  // ------------------------------------------------------------------ a consistent graph, and a fresh valid row per table
  function seed(db) {
    const g = { usr: id('usr_'), usr2: id('usr_'), a1: ACCT.a1, a2: ACCT.a2, counter: 10 };
    g.gen = db.prepare('SELECT authorization_generation AS g FROM card_sync_policy').get().g;
    g.l1 = db.prepare("SELECT id FROM card_scopes WHERE card_account_id = ? AND kind = 'legacy'").get(g.a1).id;
    g.fb1 = db.prepare('SELECT id FROM card_import_batches WHERE card_account_id = ?').get(g.a1).id;
    g.tp = db.prepare("SELECT id FROM card_transactions WHERE kind = 'payment'").get().id;
    const scope = (o) => { const row = { id: id('scp_'), card_account_id: g.a1, kind: 'known', holder_alias: 'alex', last4: '1234',
      label: 'Alex card', status: 'active', version: 1, confirmed_by_ref: g.usr, confirmed_at: at(), retired_at: null,
      created_at: at(), updated_at: at(), ...o }; insertRow(db, 'card_scopes', row); return row.id; };
    g.k1 = scope({});
    g.k2 = scope({ holder_alias: 'casey', last4: '5678', label: 'Casey card' });
    g.u1 = scope({ kind: 'unknown', holder_alias: 'unknown', last4: null, label: 'Card not identified' });
    g.b = id('bnd_');
    insertRow(db, 'card_source_bindings', { id: g.b, card_account_id: g.a1, issuer: 'chase', currency: 'USD', source: 'chase-api',
      source_account_digest: null, label: 'Chase activity', status: 'confirmed', status_reason: null, version: 1,
      confirmed_by_ref: g.usr, confirmed_at: at(), retired_at: null, created_at: at(), updated_at: at() });
    for (const [s, kind] of [[g.k1, 'known'], [g.k2, 'known'], [g.u1, 'unknown']]) {
      insertRow(db, 'card_source_binding_scopes', { id: id('card-bscope-'), binding_id: g.b, card_scope_id: s, card_account_id: g.a1,
        card_scope_kind: kind, binding_version: 1, status: 'active', created_at: at(), revoked_at: null });
    }
    g.p = id('pai_');
    insertRow(db, 'card_sync_pairings', { id: g.p, code_digest: dig('hph1:'), status: 'open', replaces_device_id: null,
      created_by_ref: g.usr, created_at: at(), expires_at: at(300), failed_attempts: 0, authorization_generation: g.gen,
      redeemed_at: null, closed_at: null });
    insertRow(db, 'card_sync_pairing_scopes', { id: id('card-pscope-'), pairing_id: g.p, binding_id: g.b, binding_version: 1,
      mode: 'isolated-read', contract_version: 1 });                       // chosen while open, then redeemed and approved
    db.prepare("UPDATE card_sync_pairings SET status = 'redeemed', code_digest = NULL, redeemed_at = ? WHERE id = ?").run(at(60), g.p);
    db.prepare("UPDATE card_sync_pairings SET status = 'approved', closed_at = ? WHERE id = ?").run(at(120), g.p);
    g.d = id('dev_');
    g.token = dig('hdh1:');
    insertRow(db, 'card_sync_devices', { id: g.d, pairing_id: g.p, token_digest: g.token, fingerprint: letters(16), label: 'Laptop',
      client_version: '1.0.0', owner_ref: g.usr, status: 'active', created_at: at(60), pending_expires_at: at(600),
      activated_at: at(120), activated_by_ref: g.usr, expires_at: at(120 + 29 * DAY_S), closed_at: null, close_reason: null,
      authorization_generation: g.gen, last_used_at: null });
    insertRow(db, 'card_sync_device_scopes', { id: id('card-dscope-'), device_id: g.d, binding_id: g.b, binding_version: 1,
      mode: 'isolated-read', contract_version: 1, status: 'active', granted_by_ref: g.usr, granted_at: at(120) });
    g.r = makeRun(db, g, { acceptance_state: 'accepted', payload_digest: dig('pd1:'), accepted_at: at(200), closed_at: at(200) });
    g.s = makeSet(db, g, { run_id: g.r });
    g.t4 = makeTxn(db, g, {});
    g.o1 = makeObs(db, g, {});
    g.i1 = id('card-ident-');
    insertRow(db, 'card_source_identities', { id: g.i1, card_account_id: g.a1, source_scope_id: g.k1, source_scope_kind: 'known',
      namespace: 'chase-api:sor:v1', namespace_kind: 'stable', id_hash: dig('xid1:'), canonical_transaction_id: g.t4,
      status: 'active', first_seen_status: 'posted', created_origin: 'extension', import_batch_id: null,
      first_observation_id: g.o1, created_at: at(), last_seen_at: null, last_seen_run_id: null });
    g.it1 = makeItem(db, g, { observation_id: g.o1 });
    insertRow(db, 'card_reconciliation_candidates', { review_item_id: g.it1, card_account_id: g.a1, rank: 1, transaction_id: g.t4,
      rule: 'near-content:v1', matched_on: 3, blocked_reason: null });
    g.pl = makePlan(db, g, { action_count: 9999 });                 // probes append actions by a running ordinal
    g.pla = makePlan(db, g, { plan_kind: 'adjustment', action_count: 9999 });
    g.e1 = id('card-event-');
    insertRow(db, 'card_transaction_events', baseEvent(g, { id: g.e1 }));
    return g;
  }
  function makeRun(db, g, o) {
    const row = { id: id('run_'), device_id: g.d, client_run_id: id('crn_'), binding_id: g.b, card_account_id: g.a1,
      binding_version: 1, adapter_version: 'chase@0.1.0', contract_version: 1, run_trigger: 'manual',
      authorization_generation: g.gen, created_at: at(150), upload_expires_at: at(750), acceptance_state: 'open',
      payload_digest: null, refusal_code: null, accepted_at: null, closed_at: null, aborted_at: null, abort_reason: null, ...o };
    insertRow(db, 'card_sync_runs', row);
    return row.id;
  }
  function setRow(g, o) {
    return { id: id('obs_'), origin: 'extension', card_account_id: g.a1, issuer: 'chase', currency: 'USD', run_id: null,
      device_id: g.d, binding_id: g.b, binding_version: 1, capture_id: id('cpt_'), payload_digest: dig('pd1:'),
      contract_version: 1, mode: 'isolated-read', observed_at: at(190), owner: 'joint', import_batch_id: null, file_chunk: null,
      source: 'chase-api', parser_version: 'holdr-ext-chase@0.1.0', authorization_generation: g.gen, guard_revision: 4,
      accepted_at: at(200), expires_at: at(200 + 30 * DAY_S), state: 'needs-review', version: 1, review_ledger_revision: 0,
      row_count: 0, byte_count: 100, producer_rejected_count: 0, statement_present: 0, receipt_state: 'kept', ...o };
  }
  function makeSet(db, g, o = {}) {
    const run = o.run_id ?? makeRun(db, g, { acceptance_state: 'accepted', payload_digest: dig('pd1:'), accepted_at: at(200),
      closed_at: at(200) });
    const row = setRow(g, { ...o, run_id: run });
    insertRow(db, 'card_sync_observation_sets', row);
    return row.id;
  }
  function fileSetRow(g, o) {
    return setRow(g, { origin: 'file', run_id: null, device_id: null, binding_id: null, binding_version: null, capture_id: null,
      payload_digest: null, contract_version: null, mode: null, observed_at: null, owner: null, authorization_generation: null,
      import_batch_id: g.fb1, file_chunk: 0, source: 'chase-csv', parser_version: 'csv@1.0.0', byte_count: 0, receipt_state: 'none',
      row_count: 1, open_count: 1, ...o });
  }
  function txnRow(g, o) {
    return { id: id('card-txn-'), card_account_id: g.a1, source: 'chase-api', external_id_hash: dig('xid1:'), fingerprint: null,
      transaction_date: '2026-10-01', posted_date: '2026-10-02', status: 'posted', amount_minor: 1234, currency: 'USD',
      original_amount_minor: null, original_currency: null, kind: 'purchase', description: 'SYNTHETIC COFFEE', merchant: null,
      issuer_category: null, user_category: null, notes: null, import_batch_id: null, created_at: at(300), updated_at: at(300),
      dismissed_at: null, card_scope_id: g.k1, revision: 1, first_sync_run_id: g.r, removed_reason: null,
      removed_from_status: null, removed_at: null, merged_into_id: null, reversal_snapshot_revision: null, ...o };
  }
  function makeTxn(db, g, o) { const row = txnRow(g, o); insertRow(db, 'card_transactions', row); return row.id; }
  function obsRow(g, o) {
    const xid = dig('xid1:');
    const row = { id: id('card-obsrow-'), observation_set_id: g.s, origin: 'extension', card_account_id: g.a1,
      ordinal: (g.counter += 1), file_row_index: null, source_scope_id: g.k1, source_scope_kind: 'known',
      identity_namespace: 'chase-api:sor:v1', namespace_kind: 'stable', external_id_hash: xid, fingerprint: null, identity_hash: xid,
      transaction_date: '2026-10-01', posted_date: '2026-10-02', status: 'posted', amount_minor: 1234, currency: 'USD',
      original_amount_minor: null, original_currency: null, kind: 'purchase', description: 'SYNTHETIC COFFEE', merchant: null,
      issuer_category: null, content_digest: dig('rcd1:'), state: 'open', outcome: null, resolved_transaction_id: null,
      provenance: 0, resolved_plan_id: null, resolved_at: null, ...o };
    return row;
  }
  function makeObs(db, g, o) { const row = obsRow(g, o); insertRow(db, 'card_source_observations', row); return row.id; }
  function itemRow(g, o) {
    return { id: id('rvw_'), observation_set_id: g.s, card_account_id: g.a1, observation_id: null, category: 'cross-source-similar',
      reason: 'cross-source-similar', allowed_actions: 139, difference_field: null, expected_minor: null, actual_minor: null,
      status: 'open', draft_action: null, draft_transaction_id: null, draft_scope_id: null, drafted_by_ref: null, drafted_at: null,
      committed_action: null, committed_transaction_id: null, committed_scope_id: null, committed_revision: null,
      committed_plan_id: null, committed_at: null, classified_ledger_revision: 0, created_at: at(300), updated_at: at(300), ...o };
  }
  function makeItem(db, g, o) { const row = itemRow(g, o); insertRow(db, 'card_reconciliation_suggestions', row); return row.id; }
  function planRow(g, o) {
    return { id: id('prv_'), plan_kind: 'set', card_account_id: g.a1, observation_set_id: null, set_version: 1,
      principal_kind: 'session', device_id: null, actor_ref: g.usr, binding_id: g.b, binding_version: 1, payload_digest: dig('pd1:'),
      plan_digest: dig('pl1:'), auto_eligible: 0, source_reviewed: 0, action_count: 1, count_insert: 1, count_update: 0,
      count_unchanged: 0, count_aliased: 0, count_matched: 0, count_attributed: 0, count_promoted: 0, count_corrected: 0, count_rejected: 0,
      count_unmatched: 0, count_superseded: 0, ledger_revision: 0, policy_revision: 1, issuer_policy_revision: 1,
      contract_version: 1, guard_revision: 4, authorization_generation: g.gen, created_at: at(400), expires_at: at(1000),
      status: 'prepared', closed_at: null, cancel_reason: null, ...o };
  }
  function makePlan(db, g, o) {
    const row = planRow(g, { observation_set_id: o.observation_set_id ?? makeSet(db, g), ...o });
    insertRow(db, 'card_sync_commit_plans', row);
    return row.id;
  }
  function baseEvent(g, o) {
    return { id: id('card-event-'), card_transaction_id: g.t4, card_account_id: g.a1, event_type: 'user-edited',
      transaction_revision: 1, origin: 'session', actor_kind: 'session', actor_ref: g.usr, reason: 'user-edit', edit_fields: 1,
      notify: 0, created_at: at(500), ...o };
  }
  function actionRow(g, o) {
    return { plan_id: g.pl, ordinal: (g.counter += 1), card_account_id: g.a1, plan_kind: 'set', op: 'insert', observation_ordinal: 0,
      review_item_id: null, content_digest: dig('rcd1:'), transaction_id: null, expected_revision: null, new_ref: null,
      related_transaction_id: null, related_revision: null, scope_id: g.k1, promote: 0, restore: 0, identity_count: 1,
      reverses_event_id: null, ...o };
  }
  function freshBatch(db, g) {
    const b = id('card-import-');
    db.prepare(`INSERT INTO card_import_batches (id, card_account_id, source, parser_version, row_count, new_count, duplicate_count,
      rejected_count, imported_at) VALUES (?, ?, 'chase-csv', 'csv@1.0.0', 0, 0, 0, 0, ?)`).run(b, g.a1, at());
    return b;
  }
  // One fresh, valid row per table (prerequisite rows, if any, are inserted inside the caller's savepoint).
  const BASE = {
    card_sync_sources: () => ({ source: 'zz-' + letters(6), issuer: 'chase', mode: 'isolated-read', contract_version: 1 }),
    card_sync_namespaces: () => ({ namespace: 'zz' + letters(6) + ':v1', kind: 'stable', source: 'chase-api', contract_version: 1 }),
    card_accounts: () => ({ id: id('card-acct-'), issuer: 'chase', owner: 'alex', currency: 'USD', created_at: at(), updated_at: at(),
      ledger_revision: 0 }),
    card_scopes: (db, g) => ({ id: id('scp_'), card_account_id: g.a1, kind: 'known', holder_alias: 'alex', last4: '1234',
      label: 'Card', status: 'active', version: 1, confirmed_by_ref: g.usr, confirmed_at: at(), retired_at: null, created_at: at(),
      updated_at: at() }),
    card_source_bindings: (db, g) => ({ id: id('bnd_'), card_account_id: g.a1, issuer: 'chase', currency: 'USD', source: 'chase-api',
      source_account_digest: null, label: 'Old binding', status: 'retired', status_reason: null, version: 1, confirmed_by_ref: g.usr,
      confirmed_at: at(), retired_at: at(), created_at: at(), updated_at: at() }),
    card_source_binding_scopes: (db, g) => ({ id: id('card-bscope-'), binding_id: g.b, card_scope_id: g.k1, card_account_id: g.a1,
      card_scope_kind: 'known', binding_version: 1, status: 'revoked', created_at: at(), revoked_at: at() }),
    card_sync_policy: (db, g) => { db.exec('DELETE FROM card_sync_policy'); return { id: 'card-sync-policy', revision: 1, paused: 0,
      paused_at: null, authorization_generation: g.gen, generation_changed_at: at(), updated_at: at() }; },
    card_sync_issuer_policy: (db) => { db.exec("DELETE FROM card_sync_issuer_policy WHERE id = 'chase'"); return { id: 'chase',
      enabled: 0, enabled_at: null, approved_contract_version: null, risk_acknowledged_at: null, main_passive_accepted: 0,
      revision: 1, updated_at: at() }; },
    card_sync_pairings: (db, g) => ({ id: id('pai_'), code_digest: null, status: 'cancelled', replaces_device_id: null,
      created_by_ref: g.usr, created_at: at(), expires_at: at(300), failed_attempts: 0, authorization_generation: g.gen,
      redeemed_at: null, closed_at: at(10) }),
    card_sync_pairing_scopes: (db, g) => { const p = { ...BASE.card_sync_pairings(db, g), status: 'open', code_digest: dig('hph1:'),
      closed_at: null, created_by_ref: id('usr_') }; insertRow(db, 'card_sync_pairings', p);
      return { id: id('card-pscope-'), pairing_id: p.id, binding_id: g.b, binding_version: 1, mode: 'isolated-read', contract_version: 1 }; },
    card_sync_devices: (db, g) => { const p = BASE.card_sync_pairings(db, g); insertRow(db, 'card_sync_pairings', p);
      return { id: id('dev_'), pairing_id: p.id, token_digest: dig('hdh1:'), fingerprint: letters(16), label: 'Laptop',
        client_version: '1.0.0', owner_ref: g.usr, status: 'active', created_at: at(), pending_expires_at: at(600),
        activated_at: at(60), activated_by_ref: g.usr, expires_at: at(60 + 29 * DAY_S), closed_at: null, close_reason: null,
        authorization_generation: g.gen, last_used_at: null }; },
    card_sync_device_scopes: (db, g) => { const d = BASE.card_sync_devices(db, g); insertRow(db, 'card_sync_devices', d);
      return { id: id('card-dscope-'), device_id: d.id, binding_id: g.b, binding_version: 1, mode: 'isolated-read',
        contract_version: 1, status: 'active', granted_by_ref: g.usr, granted_at: at(), revoked_at: null, auto_sync: 0 }; },
    card_sync_runs: (db, g) => ({ id: id('run_'), device_id: g.d, client_run_id: id('crn_'), binding_id: g.b, card_account_id: g.a1,
      binding_version: 1, adapter_version: 'chase@0.1.0', contract_version: 1, run_trigger: 'manual', authorization_generation: g.gen,
      created_at: at(), upload_expires_at: at(600), acceptance_state: 'open', payload_digest: null, refusal_code: null,
      accepted_at: null, closed_at: null, aborted_at: null, abort_reason: null }),
    card_sync_observation_sets: (db, g) => setRow(g, { run_id: makeRun(db, g, { acceptance_state: 'accepted',
      payload_digest: dig('pd1:'), accepted_at: at(200), closed_at: at(200) }) }),
    card_sync_set_card_hints: (db, g) => ({ observation_set_id: makeSet(db, g), origin: 'extension', ordinal: 0, last4: '1234' }),
    card_source_observations: (db, g) => obsRow(g, {}),
    card_observation_secondary_ids: (db, g) => ({ id: id('card-obsid-'), observation_id: makeObs(db, g, {}), ordinal: 1,
      namespace: 'chase-api:derived:v1', namespace_kind: 'stable', id_hash: dig('xid1:') }),
    card_sync_payload_receipts: (db, g) => ({ observation_set_id: makeSet(db, g), payload_digest: dig('pd1:'),
      canonical_json: '{"a":1}', byte_length: 7, accepted_at: at(), expires_at: at(7 * DAY_S) }),
    card_transactions: (db, g) => txnRow(g, {}),
    card_transaction_versions: (db, g) => (g.triggers ? snapshotOf(db, makeTxn(db, g, {})) : { card_transaction_id: g.t4, revision: (g.counter += 1), card_account_id: g.a1,
      status: 'posted', transaction_date: '2026-10-01', posted_date: '2026-10-02', amount_minor: 1234, kind: 'purchase',
      description: 'SYNTHETIC COFFEE', card_scope_id: g.k1, reversal_snapshot_revision: null, replaced_at: at() }),
    card_source_identities: (db, g) => ({ id: id('card-ident-'), card_account_id: g.a1, source_scope_id: g.k1,
      source_scope_kind: 'known', namespace: 'chase-api:sor:v1', namespace_kind: 'stable', id_hash: dig('xid1:'),
      canonical_transaction_id: g.t4, status: 'active', first_seen_status: 'posted', created_origin: 'extension',
      import_batch_id: null, first_observation_id: g.o1, created_at: at(), last_seen_at: null, last_seen_run_id: null }),
    card_identity_contents: (db, g) => ({ identity_id: g.i1, content_digest: dig('rcd1:'), resolution: 'inserted', recorded_at: at() }),
    card_transaction_events: (db, g) => baseEvent(g, {}),
    card_reconciliation_suggestions: (db, g) => itemRow(g, { observation_id: makeObs(db, g, {}) }),
    card_reconciliation_candidates: (db, g) => ({ review_item_id: makeItem(db, g, { observation_id: makeObs(db, g, {}) }),
      card_account_id: g.a1, rank: 1, transaction_id: g.t4, rule: 'near-content:v1', matched_on: 3, blocked_reason: null }),
    card_coverage_windows: (db, g) => ({ id: id('card-cover-'), card_account_id: g.a1, card_scope_id: g.k1, source_kind: 'extension',
      source: 'chase-api', import_batch_id: null, observation_set_id: makeSet(db, g), entry_ordinal: 0, status: 'posted',
      requested_start: '2026-09-14', requested_end: '2026-10-14', requested_basis: 'transaction', observed_start: '2026-09-14',
      observed_end: '2026-10-01', observed_basis: 'posted', claimed_completeness: 'partial', verified_completeness: 'partial',
      termination: 'end-marker', page_count: 2, evidence: 'extension-claimed', ledger_state: 'observed-uncommitted',
      observed_at: at(), recorded_at: at(), updated_at: at() }),
    card_sync_commit_plans: (db, g) => planRow(g, { observation_set_id: makeSet(db, g) }),
    card_sync_plan_actions: (db, g) => actionRow(g, {}),
    card_sync_audit_events: (db, g) => ({ id: id('card-audit-'), event_type: 'policy-changed', actor_kind: 'session',
      actor_ref: g.usr, created_at: at() }),
    card_payment_links: (db, g) => ({ id: id('card-link-'), card_transaction_id: g.tp, cash_event_ref: dig('cer1:'),
      decision: 'rejected', amount_minor: -5000, currency: 'USD', rules_version: 1, decided_at: at(), decided_by_ref: g.usr }),
  };
  function snapshotOf(db, txnId, o = {}) {
    const t = db.prepare('SELECT * FROM card_transactions WHERE id = ?').get(txnId);
    return { card_transaction_id: t.id, revision: t.revision, card_account_id: t.card_account_id, status: t.status,
      transaction_date: t.transaction_date, posted_date: t.posted_date, amount_minor: t.amount_minor,
      original_amount_minor: t.original_amount_minor, original_currency: t.original_currency, kind: t.kind,
      description: t.description, merchant: t.merchant, issuer_category: t.issuer_category, card_scope_id: t.card_scope_id,
      removed_reason: t.removed_reason, removed_from_status: t.removed_from_status, removed_at: t.removed_at,
      merged_into_id: t.merged_into_id, dismissed_at: t.dismissed_at, reversal_snapshot_revision: t.reversal_snapshot_revision,
      replaced_at: at(), ...o };
  }
  const gA = seed(dbA);
  const gB = seed(dbB);
  gB.triggers = true;

  if (sections.probes) {
    // ------------------------------------------------------------------ phase A: constraints without triggers
    const CUSTOM_BAD = {
      ck_src_source: 'chase-api2', ck_ns_namespace: 'Chase:sor:v1', ck_dev_fingerprint: 'abcdabcdabcdabcq',
      ck_dev_label: 'Chrome/Users:alex', ck_dev_client_version: '1.2.3-beta', ck_rcpt_canonical_json: '[1]',
      ck_evt_actor_ref: 'lu_0123456789abcdef', ck_aud_actor_ref: 'lu_0123456789abcdef', ck_aud_code: 'code-4111',
      ck_pol_id: 'card-sync-policy-2', ck_hint_origin: 'file', ck_sid_namespace_kind: 'capture',
    };
    function badValue(c) {
      if (c.name in CUSTOM_BAD) return CUSTOM_BAD[c.name];
      const e = c.expr;
      let m = e.match(/length\(CAST\(\w+ AS BLOB\)\) = (\d+) AND substr\(\w+, 1, (\d+)\) = '([^']+)'/);
      if (m) return m[3] + 'a'.repeat(Number(m[1]) - m[3].length - 1) + '7';
      m = e.match(/length\(CAST\(\w+ AS BLOB\)\) = 69 AND substr\(\w+, 1, 5\) IN \('([^']+)'/);
      if (m) return m[1] + 'a'.repeat(63) + 'q';
      if (e.includes("strftime('%Y-%m-%dT%H:%M:%fZ'")) return '2026-10-17 10:00:00.000Z';
      if (e.includes('date(')) return '2026-02-30';
      if (e.includes("GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'")) return '2026/10/01';
      if (e.includes("GLOB '[0-9][0-9][0-9][0-9]'")) return '12a4';
      if (e.includes("GLOB '[A-Z][A-Z][A-Z]'")) return 'usd';
      if (/IN \(0, 1\)$/.test(e)) return 2;
      m = e.match(/CAST\(\w+ AS INTEGER\) AND \w+ BETWEEN (-?\d+) AND (-?\d+)/);
      if (m) return Number(m[2]) + 1;
      if (/\w+ IN \('/.test(e)) return 'bogus-value';
      m = e.match(/length\(\w+\) BETWEEN (\d+) AND (\d+)/);
      if (m) return 'x'.repeat(Number(m[2]) + 1);
      if (e.includes('[^a-z0-9-]')) return 'Bad_Slug';
      if (e.includes('[^A-Za-z0-9._@+-]')) return 'bad parser!';
      m = e.match(/^\w+ = '([^']+)'$/);
      if (m) return m[1] + '-x';
      throw new Error(`no bad value for ${c.name}`);
    }
    function rowProbe(db, g, label, table, overrides, expect, cover, baseFn) {
      let row;
      probe(db, label, {
        control: () => { row = (baseFn ?? BASE[table])(db, g); insertRow(db, table, row); },
        act: () => { row = (baseFn ?? BASE[table])(db, g); insertRow(db, table, { ...row, ...overrides(row) }); },
        expect, cover,
      });
    }
    section('phase A');
    for (const c of CATALOGUE.columnChecks) {
      if (!BASE[c.table]) { fail(c.name, `no base row for ${c.table}`); continue; }
      rowProbe(dbA, gA, c.name, c.table, () => ({ [c.column]: badValue(c) }), { check: c.name }, [['check', c.name]]);
    }
    const fileSet = (db, g) => fileSetRow(g, {});
    const fileWindow = (db, g) => ({ ...BASE.card_coverage_windows(db, g), source_kind: 'file', source: 'chase-csv',
      import_batch_id: freshBatch(db, g), observation_set_id: null, entry_ordinal: null, status: 'any',
      requested_start: '2026-09-01', requested_end: '2026-09-30', requested_basis: 'posted-or-transaction', observed_start: null,
      observed_end: null, observed_basis: null, claimed_completeness: 'unknown', verified_completeness: 'unknown', termination: null,
      page_count: null, evidence: 'file-declared', ledger_state: 'committed', observed_at: null });
    const adjust = (o) => (db, g) => actionRow(g, { plan_id: g.pla, plan_kind: 'adjustment', ...o });
    const removedRow = { status: 'removed', removed_reason: 'cancelled', removed_from_status: 'pending', removed_at: at() };
    const TABLE_PROBES = [
      ['ck_ns_source_shape', 'card_sync_namespaces', { kind: 'legacy-file' }],
      ['ck_scope_alias_kind', 'card_scopes', { holder_alias: 'unknown' }],
      ['ck_scope_unresolved_shape', 'card_scopes', { kind: 'unknown', holder_alias: 'unknown', card_account_id: ACCT.a2 }],
      ['ck_scope_confirmation', 'card_scopes', { confirmed_at: null }],
      ['ck_scope_retired', 'card_scopes', { status: 'retired' }],
      ['ck_bind_status_shape', 'card_source_bindings', { status: 'confirmed', card_account_id: ACCT.a2, issuer: 'amex',
        source: 'amex-api-rest' }],
      ['ck_bscope_revoked', 'card_source_binding_scopes', { revoked_at: null }],
      ['ck_pol_paused_shape', 'card_sync_policy', { paused: 1 }],
      ['ck_ipol_enabled_shape', 'card_sync_issuer_policy', { enabled: 1 }],
      ['ck_ipol_main_passive', 'card_sync_issuer_policy', { main_passive_accepted: 1 }],
      ['ck_pair_window', 'card_sync_pairings', { expires_at: at(301) }],
      ['ck_pair_code_shape', 'card_sync_pairings', { code_digest: dig('hph1:') }],
      ['ck_pair_closed_shape', 'card_sync_pairings', { closed_at: null }],
      ['ck_pair_locked_shape', 'card_sync_pairings', { failed_attempts: 5 }],
      ['ck_pair_redeemed_shape', 'card_sync_pairings', { status: 'approved' }],
      ['ck_dev_pending_window', 'card_sync_devices', { pending_expires_at: at(601) }],
      ['ck_dev_token_shape', 'card_sync_devices', { token_digest: null }],
      ['ck_dev_activation_shape', 'card_sync_devices', { activated_by_ref: null }],
      ['ck_dev_lifetime', 'card_sync_devices', { expires_at: at(60 + 31 * DAY_S) }],
      ['ck_dev_close_reason_shape', 'card_sync_devices', { status: 'revoked', token_digest: null, closed_at: at(), close_reason: 'expired' }],
      ['ck_dscope_revoked', 'card_sync_device_scopes', { revoked_at: at() }],
      ['ck_dscope_consent_shape', 'card_sync_device_scopes', { auto_sync: 1 }],
      ['ck_run_window', 'card_sync_runs', { upload_expires_at: at(601) }],
      ['ck_run_accepted_shape', 'card_sync_runs', { payload_digest: dig('pd1:') }],
      ['ck_run_refused_shape', 'card_sync_runs', { refusal_code: 'too-large' }],
      ['ck_run_closed_shape', 'card_sync_runs', { closed_at: at() }],
      ['ck_run_abort_shape', 'card_sync_runs', { aborted_at: at() }],
      ['ck_set_extension_shape', 'card_sync_observation_sets', { payload_digest: null }],
      ['ck_set_file_shape', 'card_sync_observation_sets', { statement_present: 1 }, fileSet],
      ['ck_set_statement_shape', 'card_sync_observation_sets', { statement_charges_minor: 100 }],
      ['ck_set_window', 'card_sync_observation_sets', { expires_at: at(200 + 91 * DAY_S) }],
      ['ck_set_counts', 'card_sync_observation_sets', { open_count: 1 }],
      ['ck_set_closed_shape', 'card_sync_observation_sets', { closed_at: at() }],
      ['ck_set_close_reason_shape', 'card_sync_observation_sets', { state: 'committed', closed_at: at(), close_reason: 'expired' }],
      ['ck_set_open_rows', 'card_sync_observation_sets', { row_count: 1, expired_count: 1 }],
      ['ck_set_purged', 'card_sync_observation_sets', { content_purged_at: at() }],
      ['ck_obs_identity_one', 'card_source_observations', { fingerprint: dig('cfp1:') }],
      ['ck_obs_identity_form', 'card_source_observations', { identity_hash: dig('xid1:') }],
      ['ck_obs_legacy_pairing', 'card_source_observations', { source_scope_id: gA.l1, source_scope_kind: 'legacy' }],
      ['ck_obs_original', 'card_source_observations', { original_currency: 'EUR' }],
      ['ck_obs_pending_no_posted_date', 'card_source_observations', { status: 'pending' }],
      ['ck_obs_state_shape', 'card_source_observations', { state: 'resolved' }],
      ['ck_obs_provenance_shape', 'card_source_observations', { provenance: 1 }],
      ['ck_rcpt_length', 'card_sync_payload_receipts', { byte_length: 8 }],
      ['ck_rcpt_window', 'card_sync_payload_receipts', { expires_at: at(8 * DAY_S) }],
      ['ck_txn_provenance_one', 'card_transactions', { import_batch_id: gA.fb1 }],
      ['ck_txn_removed_shape', 'card_transactions', { removed_at: at() }],
      ['ck_txn_legacy_reason', 'card_transactions', { ...removedRow, removed_reason: 'legacy', removed_from_status: 'posted' }],
      ['ck_txn_merge_shape', 'card_transactions', { ...removedRow, removed_reason: 'superseded', removed_from_status: 'posted' }],
      ['ck_txn_reason_from', 'card_transactions', { ...removedRow, removed_from_status: 'posted' }],
      ['ck_txn_dismissed', 'card_transactions', { ...removedRow, removed_reason: 'dismissed' }],
      ['ck_txn_reversal_marker', 'card_transactions', { reversal_snapshot_revision: 1 }],
      ['ck_ver_removed_shape', 'card_transaction_versions', { status: 'removed' }],
      ['ck_ident_kind_pairing', 'card_source_identities', { id_hash: dig('ccf1:') }],
      ['ck_ident_origin_shape', 'card_source_identities', { first_observation_id: null }],
      ['ck_evt_actor', 'card_transaction_events', { actor_kind: 'device' }],
      ['ck_evt_origin_shape', 'card_transaction_events', { origin: 'extension' }],
      ['ck_evt_created', 'card_transaction_events', { event_type: 'created', reason: 'insert', edit_fields: 0, to_status: null,
        to_amount_minor: 1, to_transaction_date: '2026-10-01', to_kind: 'purchase', to_scope_id: gA.k1 }],
      ['ck_evt_promoted', 'card_transaction_events', { event_type: 'promoted', reason: 'pending-posted', edit_fields: 0,
        from_status: 'pending', to_status: 'posted', from_amount_minor: 1, to_amount_minor: 2, from_transaction_date: '2026-10-01',
        to_transaction_date: '2026-10-01', from_kind: 'purchase', to_kind: null }],
      ['ck_evt_corrected', 'card_transaction_events', { event_type: 'corrected', reason: 'posted-correction', edit_fields: 0,
        from_status: 'posted', to_status: 'posted', from_amount_minor: 1, to_amount_minor: 2, from_transaction_date: '2026-10-01',
        to_transaction_date: null, from_kind: 'purchase', to_kind: 'purchase' }],
      ['ck_evt_identity', 'card_transaction_events', { event_type: 'identity-linked', reason: 'alias', edit_fields: 0 }],
      ['ck_evt_linked', 'card_transaction_events', { event_type: 'identity-linked', reason: 'restore', edit_fields: 0, identity_id: gA.i1 }],
      ['ck_evt_repointed', 'card_transaction_events', { event_type: 'identity-repointed', reason: 'superseded', edit_fields: 0,
        identity_id: gA.i1, from_canonical_id: gA.tp, to_canonical_id: gA.t4 }],
      ['ck_evt_detached', 'card_transaction_events', { event_type: 'identity-detached', reason: 'restore', edit_fields: 0,
        identity_id: gA.i1, from_canonical_id: gA.t4 }],
      ['ck_evt_attributed', 'card_transaction_events', { event_type: 'attributed', reason: 'attribution', edit_fields: 0,
        from_scope_id: gA.k1, to_scope_id: gA.k1 }],
      ['ck_evt_merged', 'card_transaction_events', { event_type: 'superseded', reason: 'superseded', edit_fields: 0,
        from_status: 'posted', to_status: 'removed' }],
      ['ck_evt_removed', 'card_transaction_events', { event_type: 'removed', reason: 'dismissed', edit_fields: 0,
        from_status: 'removed', to_status: 'removed' }],
      ['ck_evt_restored', 'card_transaction_events', { event_type: 'restored', reason: 'restore', edit_fields: 0,
        from_status: 'posted', to_status: 'posted' }],
      ['ck_evt_reversed', 'card_transaction_events', { reverses_event_id: gA.e1 }],
      ['ck_evt_user_edit', 'card_transaction_events', { edit_fields: 0 }],
      ['ck_evt_notify_shape', 'card_transaction_events', { notify: 1 }],
      ['ck_evt_plan', 'card_transaction_events', { plan_id: id('prv_') }],
      ['ck_rvw_level', 'card_reconciliation_suggestions', { observation_id: null }],
      ['ck_rvw_reason_category', 'card_reconciliation_suggestions', { reason: 'no-stable-id' }],
      ['ck_rvw_actions_in_category', 'card_reconciliation_suggestions', { allowed_actions: 16 }],
      ['ck_rvw_draft_shape', 'card_reconciliation_suggestions', { draft_action: 'insert-new', status: 'decided' }],
      ['ck_rvw_committed_shape', 'card_reconciliation_suggestions', { committed_action: 'insert-new' }],
      ['ck_rvw_status_shape', 'card_reconciliation_suggestions', { status: 'decided' }],
      ['ck_cand_blocked', 'card_reconciliation_candidates', { blocked_reason: 'different-known-cards', rule: 'identity:v1' }],
      ['ck_cov_origin', 'card_coverage_windows', { entry_ordinal: null }],
      ['ck_cov_file_shape', 'card_coverage_windows', { termination: 'cap' }, fileWindow],
      ['ck_cov_extension_shape', 'card_coverage_windows', { termination: null }],
      ['ck_cov_requested_shape', 'card_coverage_windows', { requested_basis: null }],
      ['ck_cov_observed_shape', 'card_coverage_windows', { observed_end: '2026-09-01' }],
      ['ck_cov_completeness', 'card_coverage_windows', { verified_completeness: 'complete' }],
      ['ck_cov_observation_basis', 'card_coverage_windows', { observed_basis: 'observation' }],
      ['ck_cov_not_read', 'card_coverage_windows', { termination: 'not-read' }],
      ['ck_plan_principal', 'card_sync_commit_plans', { actor_ref: null }],
      ['ck_plan_device_shape', 'card_sync_commit_plans', { principal_kind: 'device', device_id: gA.d, actor_ref: null }],
      ['ck_plan_session_shape', 'card_sync_commit_plans', { auto_eligible: 1 }],
      ['ck_plan_extension_shape', 'card_sync_commit_plans', { binding_version: null }],
      ['ck_plan_window', 'card_sync_commit_plans', { expires_at: at(1001) }],
      ['ck_plan_status_shape', 'card_sync_commit_plans', { closed_at: at() }],
      ['ck_plan_counts', 'card_sync_commit_plans', { count_insert: 2 }],
      ['ck_act_kind', 'card_sync_plan_actions', { op: 'remove', review_item_id: id('rvw_'), transaction_id: gA.t4,
        expected_revision: 1, scope_id: null, identity_count: 0 }],
      ['ck_act_flags', 'card_sync_plan_actions', { promote: 1 }],
      ['ck_act_op_insert', 'card_sync_plan_actions', { scope_id: null }],
      ['ck_act_op_unchanged', 'card_sync_plan_actions', { op: 'unchanged', transaction_id: gA.t4, expected_revision: 1, scope_id: null, identity_count: 1 }],
      ['ck_act_op_alias', 'card_sync_plan_actions', { op: 'alias', transaction_id: gA.t4, expected_revision: 1, scope_id: null, identity_count: 0 }],
      ['ck_act_op_promote', 'card_sync_plan_actions', { op: 'promote', promote: 1, transaction_id: gA.t4, scope_id: null }],
      ['ck_act_op_correct', 'card_sync_plan_actions', { op: 'correct', transaction_id: gA.t4, expected_revision: 1, scope_id: null,
        identity_count: 0 }],
      ['ck_act_op_match', 'card_sync_plan_actions', { op: 'match', review_item_id: id('rvw_'), transaction_id: gA.t4,
        expected_revision: 1, scope_id: null, identity_count: 0 }],
      ['ck_act_op_reject', 'card_sync_plan_actions', { op: 'reject', identity_count: 0 }],
      ['ck_act_op_accept_difference', 'card_sync_plan_actions', { op: 'accept-difference', review_item_id: id('rvw_'),
        content_digest: null, scope_id: null, identity_count: 0 }],
      ['ck_act_op_unmatch', 'card_sync_plan_actions', { op: 'unmatch', review_item_id: id('rvw_'), transaction_id: gA.t4,
        expected_revision: 1, scope_id: null, identity_count: 0 }, adjust({})],
      ['ck_act_op_restore_attribution', 'card_sync_plan_actions', { op: 'restore-attribution', review_item_id: id('rvw_'),
        transaction_id: gA.t4, expected_revision: 1, scope_id: null, identity_count: 0 }, adjust({})],
      ['ck_act_op_revert', 'card_sync_plan_actions', { op: 'revert', review_item_id: id('rvw_'), transaction_id: gA.t4,
        expected_revision: 1, scope_id: null, identity_count: 0 }, adjust({})],
      ['ck_act_op_supersede', 'card_sync_plan_actions', { op: 'supersede', review_item_id: id('rvw_'), transaction_id: gA.t4,
        expected_revision: 1, related_transaction_id: gA.t4, related_revision: 1, scope_id: null }, adjust({})],
      ['ck_act_op_remove', 'card_sync_plan_actions', { op: 'remove', review_item_id: id('rvw_'), transaction_id: gA.t4,
        expected_revision: 1, identity_count: 0 }, adjust({})],
      ['ck_aud_actor', 'card_sync_audit_events', { actor_kind: 'system' }],
      ['ck_aud_versions', 'card_sync_audit_events', { version_before: 5, version_after: 4 }],
      ['ck_aud_ledger_event', 'card_sync_audit_events', { ledger_event_id: id('card-event-') }],   // only a ledger-maintenance row names one
      ['ck_aud_cutoff_shape', 'card_sync_audit_events', { code: 'audit-cutoff' }],                   // only a system retention row is a cutoff
    ];
    for (const [name, table, overrides, baseFn] of TABLE_PROBES) {
      rowProbe(dbA, gA, name, table, () => overrides, { check: name }, [['check', name]], baseFn);
    }

    // Foreign keys: every FK of every v15 table, mutated in exactly the FK's own column, with an accepted twin.
    BASE.card_import_batches = (db, g) => ({ id: id('card-import-'), card_account_id: g.a1, source: 'chase-csv',
      parser_version: 'csv@1.0.0', row_count: 0, new_count: 0, duplicate_count: 0, rejected_count: 0, imported_at: at() });
    const SKIP_PICK = new Set(['card_account_id', 'origin', 'plan_kind', 'issuer', 'currency', 'namespace_kind', 'card_scope_kind',
      'source_scope_kind', 'mode', 'id']);
    function freshFor(column) {
      const rules = [[/(transaction_id|merged_into_id)$/, 'card-txn-'], [/scope_id$/, 'scp_'], [/^binding_id$/, 'bnd_'],
        [/run_id$/, 'run_'], [/device_id$/, 'dev_'], [/^observation_set_id$/, 'obs_'], [/observation_id$/, 'card-obsrow-'],
        [/^identity_id$/, 'card-ident-'], [/^import_batch_id$/, 'card-import-'], [/^pairing_id$/, 'pai_'],
        [/^review_item_id$/, 'rvw_'], [/^plan_id$/, 'prv_'], [/event_id$/, 'card-event-'], [/^card_account_id$/, 'card-acct-']];
      for (const [re, prefix] of rules) if (re.test(column)) return id(prefix);
      if (/namespace$/.test(column)) return 'nosuch:v1';
      if (column === 'source') return 'nosuch';
      throw new Error(`no fresh value for ${column}`);
    }
    const FK_BASE = {
      'card_sync_observation_sets.import_batch_id': fileSet,
      'card_source_observations.resolved_transaction_id': (db, g) => obsRow(g, { state: 'resolved', outcome: 'unchanged',
        resolved_transaction_id: g.t4, resolved_at: at() }),
      'card_transactions.import_batch_id': (db, g) => txnRow(g, { first_sync_run_id: null, import_batch_id: g.fb1 }),
      'card_transactions.merged_into_id': (db, g) => txnRow(g, { status: 'removed', removed_reason: 'superseded',
        removed_from_status: 'posted', removed_at: at(), merged_into_id: g.t4 }),
      'card_transaction_events.import_batch_id': (db, g) => baseEvent(g, { origin: 'file', import_batch_id: g.fb1 }),
      'card_transaction_events.run_id': (db, g) => baseEvent(g, { origin: 'extension', run_id: g.r, observation_set_id: g.s,
        observation_id: g.o1 }),
      'card_transaction_events.observation_set_id': (db, g) => baseEvent(g, { origin: 'extension', run_id: g.r,
        observation_set_id: g.s, observation_id: g.o1 }),
      'card_transaction_events.observation_id': (db, g) => baseEvent(g, { origin: 'extension', run_id: g.r, observation_set_id: g.s,
        observation_id: g.o1 }),
      'card_transaction_events.reverses_event_id': (db, g) => baseEvent(g, { event_type: 'reversed', reason: 'adjustment',
        edit_fields: 0, from_status: 'posted', to_status: 'pending', reverses_event_id: g.e1 }),
      'card_reconciliation_suggestions.committed_transaction_id': (db, g) => itemRow(g, { observation_id: makeObs(db, g, {}),
        status: 'committed', committed_action: 'insert-new', committed_transaction_id: g.t4, committed_revision: 1,
        committed_plan_id: id('prv_'), committed_at: at() }),
      'card_reconciliation_suggestions.draft_scope_id': (db, g) => itemRow(g, { observation_id: makeObs(db, g, {}),
        category: 'scope-unknown', reason: 'unknown-scope', allowed_actions: 141, status: 'decided', draft_action: 'attribute',
        draft_scope_id: g.k1, drafted_by_ref: g.usr, drafted_at: at() }),
      'card_reconciliation_suggestions.committed_scope_id': (db, g) => itemRow(g, { observation_id: makeObs(db, g, {}),
        category: 'scope-unknown', reason: 'unknown-scope', allowed_actions: 141, status: 'committed', committed_action: 'attribute',
        committed_transaction_id: g.t4, committed_revision: 1, committed_scope_id: g.k1, committed_plan_id: id('prv_'),
        committed_at: at() }),
      'card_coverage_windows.import_batch_id': fileWindow,
      'card_sync_commit_plans.device_id': (db, g) => planRow(g, { observation_set_id: makeSet(db, g), principal_kind: 'device',
        device_id: g.d, actor_ref: null, auto_eligible: 1 }),
      'card_sync_plan_actions.reverses_event_id': adjust({ op: 'revert', review_item_id: id('rvw_'), transaction_id: gA.t4,
        expected_revision: 1, reverses_event_id: gA.e1, scope_id: null, identity_count: 0 }),
      'card_sync_plan_actions.transaction_id': (db, g) => actionRow(g, { op: 'unchanged', transaction_id: g.t4, expected_revision: 1,
        scope_id: null, identity_count: 0 }),
      'card_sync_plan_actions.related_transaction_id': (db, g) => actionRow(g, { plan_id: g.pla, plan_kind: 'adjustment',
        op: 'supersede', review_item_id: id('rvw_'), transaction_id: g.t4, expected_revision: 1,
        related_transaction_id: makeTxn(db, g, {}), related_revision: 1, scope_id: null }),
    };
    const fkKeys = new Set();
    for (const table of [...NEW_TABLES]) {
      const groups = new Map();
      for (const fk of dbA.prepare(`PRAGMA foreign_key_list(${table})`).all()) {
        if (!groups.has(fk.id)) groups.set(fk.id, { parent: fk.table, from: [] });
        groups.get(fk.id).from.push(fk.from);
      }
      for (const { parent, from } of groups.values()) {
        const key = `${table}(${from.join(', ')}) -> ${parent}`;
        fkKeys.add(key);
        if (table === 'card_reconciliation_suggestions' && parent === 'card_reconciliation_candidates') {
          probe(dbA, key, {   // a draft decision must name one of the item's listed candidates
            control: () => dbA.prepare(`UPDATE card_reconciliation_suggestions SET status = 'decided', draft_action = 'same-transaction',
              draft_transaction_id = ?, drafted_by_ref = ?, drafted_at = ? WHERE id = ?`).run(gA.t4, gA.usr, at(), gA.it1),
            act: () => dbA.prepare(`UPDATE card_reconciliation_suggestions SET status = 'decided', draft_action = 'same-transaction',
              draft_transaction_id = ?, drafted_by_ref = ?, drafted_at = ? WHERE id = ?`).run(gA.tp, gA.usr, at(), gA.it1),
            expect: { fk: true }, cover: [['fk', key]],
          });
          continue;
        }
        const pick = from.find((c) => !SKIP_PICK.has(c)) ?? from[0];
        const baseFn = FK_BASE[`${table}.${pick}`] ?? BASE[table];
        rowProbe(dbA, gA, key, table, () => ({ [pick]: freshFor(pick) }), { fk: true }, [['fk', key]], baseFn);
      }
    }
    // Composite FKs refuse a parent that exists but belongs to another account, issuer or kind (not just a missing one).
    const COMPOSITE = [
      ['card_source_bindings(card_account_id, issuer, currency) -> card_accounts', 'card_source_bindings', { issuer: 'amex', source: 'amex-api-rest' }],
      ['card_source_bindings(source, issuer) -> card_sync_sources', 'card_source_bindings', { source: 'amex-api-rest' }],
      ['card_source_binding_scopes(card_scope_id, card_account_id, card_scope_kind) -> card_scopes', 'card_source_binding_scopes',
        { card_scope_id: gA.l1, card_scope_kind: 'known' }],
      ['card_sync_observation_sets(card_account_id, issuer, currency) -> card_accounts', 'card_sync_observation_sets', { issuer: 'amex' }],
      ['card_sync_observation_sets(source, issuer, mode) -> card_sync_sources', 'card_sync_observation_sets', { mode: 'main-passive' }],
      ['card_source_observations(identity_namespace, namespace_kind) -> card_sync_namespaces', 'card_source_observations',
        { identity_namespace: 'chase-api:capture:v1' }],
      ['card_transactions(card_scope_id, card_account_id) -> card_scopes', 'card_transactions',
        { card_scope_id: dbA.prepare("SELECT id FROM card_scopes WHERE card_account_id = ? AND kind = 'legacy'").get(ACCT.a2).id }],
      ['card_source_identities(canonical_transaction_id, card_account_id) -> card_transactions', 'card_source_identities',
        { canonical_transaction_id: gA.tp }],
      ['card_reconciliation_candidates(transaction_id, card_account_id) -> card_transactions', 'card_reconciliation_candidates',
        { transaction_id: gA.tp }],
    ];
    for (const [key, table, overrides] of COMPOSITE) {
      rowProbe(dbA, gA, `${key} (other account/issuer/kind)`, table, () => overrides, { fk: true }, [['fk', key]]);
    }

    // UNIQUE indexes and composite primary keys: a duplicate key is refused, a fresh key is accepted.
    function dupe(table, cols, { a, b, existing, baseFn } = {}) {
      const make = (db, g, o) => ({ ...(baseFn ?? BASE[table])(db, g), ...(typeof o === 'function' ? o(db, g) : o ?? {}) });
      return (db, g) => {
        let first = null;
        const prep = () => { if (!existing) { first = make(db, g, a); insertRow(db, table, first); } };
        return {
          control: () => { prep(); insertRow(db, table, make(db, g, b)); },
          act: (verb = 'INSERT') => {
            prep();
            const row = make(db, g, b);
            const src = existing ? existing(db, g) : first;
            for (const c of cols) row[c] = src[c];
            insertRow(db, table, row, verb);
          },
        };
      };
    }
    const newAcct = (db) => { const r = BASE.card_accounts(); insertRow(db, 'card_accounts', r); return r.id; };
    const otherTxn = (db, g) => makeTxn(db, g, {});
    const setLevel = { observation_id: null, category: 'reconciliation-difference', reason: 'statement-mismatch', allowed_actions: 64,
      difference_field: 'net', expected_minor: 1, actual_minor: 2 };
    const fileObs = (db, g) => obsRow(g, { observation_set_id: (() => { const s = fileSetRow(g, { file_chunk: 1 + (g.counter % 3) });
      s.import_batch_id = freshBatch(db, g); insertRow(db, 'card_sync_observation_sets', s); return s.id; })(), origin: 'file',
      file_row_index: 0, source_scope_id: g.l1, source_scope_kind: 'legacy', identity_namespace: 'legacy-file:v1',
      namespace_kind: 'legacy-file', ...(() => { const x = dig('xid1:'); return { external_id_hash: x, identity_hash: x }; })() });
    const UNIQUE_PROBES = {
      idx_card_sync_sources_fk_issuer: dupe('card_sync_sources', ['source']),
      idx_card_sync_sources_fk_mode: dupe('card_sync_sources', ['source']),
      idx_card_sync_namespaces_fk_kind: dupe('card_sync_namespaces', ['namespace']),
      idx_card_sync_namespaces_one_capture: dupe('card_sync_namespaces', ['source'], { existing: () => ({ source: 'wf-dom' }),
        b: (db) => { const src = BASE.card_sync_sources(); insertRow(db, 'card_sync_sources', src);
          return { kind: 'capture', source: src.source }; } }),
      idx_card_accounts_fk_issuer_currency: dupe('card_accounts', ['id']),
      idx_card_accounts_fk_currency: dupe('card_accounts', ['id']),
      idx_card_import_batches_fk_account: dupe('card_import_batches', ['id']),
      idx_card_scopes_fk_account: dupe('card_scopes', ['id']),
      idx_card_scopes_fk_kind: dupe('card_scopes', ['id']),
      idx_card_scopes_one_legacy: dupe('card_scopes', ['card_account_id'], { existing: (db, g) => ({ card_account_id: g.a1 }),
        b: (db) => ({ card_account_id: newAcct(db), kind: 'legacy', holder_alias: 'unknown', last4: null, confirmed_by_ref: null,
          confirmed_at: null }) }),
      idx_card_scopes_one_unknown: dupe('card_scopes', ['card_account_id'], { existing: (db, g) => ({ card_account_id: g.a1 }),
        b: (db) => ({ card_account_id: newAcct(db), kind: 'unknown', holder_alias: 'unknown', last4: null }) }),
      idx_card_source_bindings_fk_account: dupe('card_source_bindings', ['id']),
      idx_card_source_bindings_fk_source: dupe('card_source_bindings', ['id']),
      idx_card_source_bindings_live: dupe('card_source_bindings', ['card_account_id'], { existing: (db, g) => ({ card_account_id: g.a1 }),
        b: (db) => ({ card_account_id: newAcct(db), status: 'confirmed', retired_at: null }) }),
      idx_card_source_bindings_digest: dupe('card_source_bindings', ['source_account_digest'],
        { a: (db) => ({ card_account_id: newAcct(db), status: 'confirmed', retired_at: null, source_account_digest: dig('sad1:') }),
          b: (db) => ({ card_account_id: newAcct(db), status: 'confirmed', retired_at: null, source_account_digest: dig('sad1:') }) }),
      idx_card_source_binding_scopes_active: dupe('card_source_binding_scopes', ['card_scope_id'],
        { existing: (db, g) => ({ card_scope_id: g.k1 }), b: (db, g) => ({ card_scope_id: scopeFor(db, g), status: 'active',
          revoked_at: null }) }),
      idx_card_sync_pairings_code: dupe('card_sync_pairings', ['code_digest'], { a: () => ({ status: 'open', code_digest: dig('hph1:'),
        closed_at: null, created_by_ref: id('usr_') }), b: () => ({ status: 'open', code_digest: dig('hph1:'), closed_at: null,
        created_by_ref: id('usr_') }) }),
      idx_card_sync_pairings_one_open: dupe('card_sync_pairings', ['created_by_ref'], { a: () => ({ status: 'open',
        code_digest: dig('hph1:'), closed_at: null }), b: () => ({ status: 'open', code_digest: dig('hph1:'), closed_at: null,
        created_by_ref: id('usr_') }) }),
      idx_card_sync_pairing_scopes_binding: dupe('card_sync_pairing_scopes', ['pairing_id', 'binding_id']),
      idx_card_sync_devices_pairing: dupe('card_sync_devices', ['pairing_id']),
      idx_card_sync_devices_token: dupe('card_sync_devices', ['token_digest']),
      idx_card_sync_device_scopes_active: dupe('card_sync_device_scopes', ['device_id']),
      idx_card_sync_runs_client: dupe('card_sync_runs', ['client_run_id']),
      idx_card_sync_runs_fk_account: dupe('card_sync_runs', ['id']),
      idx_card_sync_observation_sets_fk_origin: dupe('card_sync_observation_sets', ['id']),
      idx_card_sync_observation_sets_fk_account: dupe('card_sync_observation_sets', ['id']),
      idx_card_sync_observation_sets_run: dupe('card_sync_observation_sets', ['run_id']),
      idx_card_sync_observation_sets_capture: dupe('card_sync_observation_sets', ['capture_id']),
      idx_card_sync_observation_sets_batch_chunk: dupe('card_sync_observation_sets', ['import_batch_id'],
        { baseFn: fileSet, a: (db, g) => ({ import_batch_id: freshBatch(db, g) }), b: (db, g) => ({ import_batch_id: freshBatch(db, g) }) }),
      pk_card_sync_set_card_hints: dupe('card_sync_set_card_hints', ['observation_set_id'], { b: { last4: '5678' } }),
      idx_card_sync_set_card_hints_last4: dupe('card_sync_set_card_hints', ['observation_set_id'], { b: { ordinal: 1 } }),
      idx_card_source_observations_ordinal: dupe('card_source_observations', ['ordinal']),
      idx_card_source_observations_file_open: dupe('card_source_observations', ['external_id_hash', 'identity_hash', 'content_digest'],
        { baseFn: fileObs }),
      idx_card_observation_secondary_ids_ordinal: dupe('card_observation_secondary_ids', ['observation_id'],
        { b: { namespace: 'chase-api:sor:v1' } }),
      idx_card_observation_secondary_ids_namespace: dupe('card_observation_secondary_ids', ['observation_id'], { b: { ordinal: 2 } }),
      idx_card_transactions_fk_account: dupe('card_transactions', ['id']),
      pk_card_transaction_versions: dupe('card_transaction_versions', ['revision']),
      idx_card_source_identities_tuple: dupe('card_source_identities', ['id_hash']),
      pk_card_identity_contents: dupe('card_identity_contents', ['content_digest']),
      idx_card_reconciliation_suggestions_fk_account: dupe('card_reconciliation_suggestions', ['id']),
      idx_card_reconciliation_suggestions_observation: dupe('card_reconciliation_suggestions', ['observation_id']),
      idx_card_reconciliation_suggestions_set_level: dupe('card_reconciliation_suggestions', ['observation_set_id'],
        { a: setLevel, b: (db, g) => ({ ...setLevel, observation_set_id: makeSet(db, g) }) }),
      pk_card_reconciliation_candidates: dupe('card_reconciliation_candidates', ['review_item_id'],
        { b: (db, g) => ({ transaction_id: otherTxn(db, g) }) }),
      idx_card_reconciliation_candidates_target: dupe('card_reconciliation_candidates', ['review_item_id'], { b: { rank: 2 } }),
      idx_card_coverage_windows_set_entry: dupe('card_coverage_windows', ['observation_set_id'], { b: { status: 'pending',
        observed_basis: 'transaction' } }),
      idx_card_coverage_windows_set_scope: dupe('card_coverage_windows', ['observation_set_id'], { b: { entry_ordinal: 1 } }),
      idx_card_coverage_windows_batch: dupe('card_coverage_windows', ['import_batch_id'], { baseFn: fileWindow }),
      idx_card_sync_commit_plans_fk_kind: dupe('card_sync_commit_plans', ['id']),
      idx_card_sync_commit_plans_one_prepared: dupe('card_sync_commit_plans', ['observation_set_id']),
      pk_card_sync_plan_actions: dupe('card_sync_plan_actions', ['ordinal']),
      idx_card_payment_links_pair: dupe('card_payment_links', ['cash_event_ref']),
      idx_card_payment_links_confirmed_payment: dupe('card_payment_links', ['card_transaction_id'], { a: { decision: 'confirmed' },
        b: (db, g) => ({ decision: 'confirmed', card_transaction_id: otherPayment(db, g) }) }),
      idx_card_payment_links_confirmed_source: dupe('card_payment_links', ['cash_event_ref'], { a: { decision: 'confirmed' },
        b: (db, g) => ({ decision: 'confirmed', card_transaction_id: otherPayment(db, g) }) }),
    };
    function otherPayment(db, g) {
      return makeTxn(db, g, { card_account_id: g.a2, kind: 'payment', amount_minor: -5000, first_sync_run_id: null,
        card_scope_id: db.prepare("SELECT id FROM card_scopes WHERE card_account_id = ? AND kind = 'legacy'").get(g.a2).id });
    }
    function scopeFor(db, g) {
      const s = BASE.card_scopes(db, g);
      insertRow(db, 'card_scopes', s);
      return s.id;
    }
    for (const u of [...CATALOGUE.uniques, ...CATALOGUE.primaryKeys]) {
      const make = UNIQUE_PROBES[u.name];
      if (!make) { fail(u.name, 'no unique probe'); continue; }
      const msg = (cols) => `UNIQUE constraint failed: ${cols.map((c) => `${u.table}.${c}`).join(', ')}`;
      const messages = [msg(u.columns), `UNIQUE constraint failed: index '${u.name}'`];
      const pkImplied = /_fk_/.test(u.name);
      probe(dbA, u.name, {
        control: () => make(dbA, gA).control(),
        act: () => make(dbA, gA).act(),
        expect: pkImplied ? { unique: true, prefix: `UNIQUE constraint failed: ${u.table}.${u.columns[0]}` } : { unique: true, messages },
        cover: [['unique', u.name]],
      });
    }

    // ------------------------------------------------------------------ phase B: the same schema with every invariant trigger
    section('phase B');
    const db = dbB;
    const g = gB;
    const run = (sql, ...args) => db.prepare(sql).run(...args);
    const get = (sql, ...args) => db.prepare(sql).get(...args);
    function tprobe(trigger, message, { control, act }) {
      probe(db, `${trigger}: ${message}`, { control, act, expect: { trigger: message }, cover: [['trigger', trigger]] });
    }
    const fresh = (table, o = {}) => { const row = { ...BASE[table](db, g), ...o }; insertRow(db, table, row); return row; };
    const lastRowid = (table) => get(`SELECT max(rowid) AS r FROM ${table}`).r;

    // Automatic: append-only, never-deleted and never-replaced tables.
    const EXISTING = {
      card_sync_sources: () => get("SELECT * FROM card_sync_sources WHERE source = 'chase-api'"),
      card_sync_namespaces: () => get("SELECT * FROM card_sync_namespaces WHERE namespace = 'chase-api:sor:v1'"),
      card_sync_policy: () => get('SELECT * FROM card_sync_policy'),
      card_sync_issuer_policy: () => get("SELECT * FROM card_sync_issuer_policy WHERE id = 'chase'"),
    };
    for (const trigger of CATALOGUE.triggers) {
      const m = trigger.match(/^trg_(\w+)_inv_(no_update|no_delete|no_replace)$/);
      if (!m) continue;
      const [, table, rule] = m;
      const rowOf = () => (EXISTING[table] ? EXISTING[table]() : fresh(table));
      const where = (row) => {
        const keys = table === 'card_sync_sources' ? ['source'] : table === 'card_sync_namespaces' ? ['namespace']
          : 'id' in row ? ['id'] : Object.keys(row).slice(0, 2);
        return [keys.map((k) => `${k} = ?`).join(' AND '), keys.map((k) => row[k])];
      };
      const msgOf = (sql) => /card invariant: ([^']+)'/.exec(sql)?.[1];
      const message = msgOf(get('SELECT sql FROM sqlite_master WHERE name = ?', trigger).sql);
      if (rule === 'no_update') {
        tprobe(trigger, message, { act: () => { const row = rowOf(); const [w, p] = where(row);
          const col = Object.keys(row).find((k) => !['id', 'source', 'namespace'].includes(k));
          run(`UPDATE ${table} SET ${col} = ${col} WHERE ${w}`, ...p); } });
      } else if (rule === 'no_delete') {
        tprobe(trigger, message, { act: () => { const row = rowOf(); const [w, p] = where(row); run(`DELETE FROM ${table} WHERE ${w}`, ...p); } });
      } else {
        let before = 0;
        tprobe(trigger, message, { act: () => { const row = rowOf(); before = get(`SELECT count(*) AS n FROM ${table}`).n;
          insertRow(db, table, row, 'INSERT OR REPLACE'); } });
        // every UNIQUE key of the table, and the rowid, refuse REPLACE as well, and the replaced row stays
        for (const u of [...CATALOGUE.uniques, ...CATALOGUE.primaryKeys].filter((x) => x.table === table)) {
          const make = UNIQUE_PROBES[u.name];
          if (make && u.name !== 'pk_card_transaction_versions') tprobe(trigger, message, { act: () => make(db, g).act('INSERT OR REPLACE') });
        }
        if (!EXISTING[table]) {
          tprobe(trigger, message, { act: () => { const a = fresh(table); const rowid = lastRowid(table);
            const b = BASE[table](db, g); insertRow(db, table, { ...b, rowid }, 'INSERT OR REPLACE'); void a; } });
        }
        void before;
      }
    }

    // Hand-written: state machines, frozen columns and cross-table rules.
    const bump = (table, idValue, set, versionCol = 'version') => run(`UPDATE ${table} SET ${set}, ${versionCol} = ${versionCol} + 1 WHERE id = ?`, idValue);
    tprobe('trg_card_accounts_inv_ledger_revision', 'a ledger revision never decreases', {
      control: () => run('UPDATE card_accounts SET ledger_revision = 5 WHERE id = ?', g.a1),
      act: () => { run('UPDATE card_accounts SET ledger_revision = 5 WHERE id = ?', g.a1); run('UPDATE card_accounts SET ledger_revision = 4 WHERE id = ?', g.a1); } });
    tprobe('trg_card_scopes_inv_update', 'a retired card scope never changes', {
      control: () => bump('card_scopes', g.k2, "label = 'Renamed'"),
      act: () => { bump('card_scopes', g.k2, `status = 'retired', retired_at = '${at()}'`); bump('card_scopes', g.k2, "label = 'Renamed'"); } });
    tprobe('trg_card_scopes_inv_update', 'a card scope version grows by one per update', {
      act: () => run("UPDATE card_scopes SET label = 'Renamed' WHERE id = ?", g.k2) });
    tprobe('trg_card_scopes_inv_update', 'a card scope keeps its account, kind and card', {
      control: () => bump('card_scopes', g.k2, "holder_alias = 'joint'"),
      act: () => bump('card_scopes', g.k2, "last4 = '9999'") });
    tprobe('trg_card_source_bindings_inv_update', 'a retired binding never changes', {
      control: () => bump('card_source_bindings', g.b, "label = 'Renamed'"),
      act: () => { bump('card_source_bindings', g.b, `status = 'retired', retired_at = '${at()}'`); bump('card_source_bindings', g.b, "label = 'X'"); } });
    tprobe('trg_card_source_bindings_inv_update', 'a binding change bumps its version', {
      act: () => run("UPDATE card_source_bindings SET label = 'Renamed' WHERE id = ?", g.b) });
    tprobe('trg_card_source_bindings_inv_update', 'a binding version grows by one per update', {
      control: () => run('UPDATE card_source_bindings SET version = version + 1 WHERE id = ?', g.b),
      act: () => run('UPDATE card_source_bindings SET version = version + 2 WHERE id = ?', g.b) });
    tprobe('trg_card_source_bindings_inv_update', 'a binding keeps its account and source', {
      act: () => bump('card_source_bindings', g.b, "source = 'amex-api-rest'") });
    { // finding 14: retiring a binding frees its (account, source); a second live binding is refused
      probe(db, 'live binding uniqueness', {
        control: () => { bump('card_source_bindings', g.b, `status = 'retired', retired_at = '${at()}'`);
          fresh('card_source_bindings', { status: 'confirmed', retired_at: null }); },
        act: () => fresh('card_source_bindings', { status: 'confirmed', retired_at: null }),
        expect: { trigger: 'card_source_bindings rows are never replaced' } });
    }
    const bscope = get('SELECT id FROM card_source_binding_scopes WHERE binding_id = ? AND card_scope_id = ?', g.b, g.k1).id;
    tprobe('trg_card_source_binding_scopes_inv_update', 'a revoked binding scope never changes', {
      control: () => run(`UPDATE card_source_binding_scopes SET status = 'revoked', revoked_at = '${at()}' WHERE id = ?`, bscope),
      act: () => { run(`UPDATE card_source_binding_scopes SET status = 'revoked', revoked_at = '${at()}' WHERE id = ?`, bscope);
        run(`UPDATE card_source_binding_scopes SET revoked_at = '${at(5)}' WHERE id = ?`, bscope); } });
    tprobe('trg_card_source_binding_scopes_inv_update', 'a binding scope keeps its binding and card scope', {
      act: () => run('UPDATE card_source_binding_scopes SET binding_version = 2 WHERE id = ?', bscope) });
    tprobe('trg_card_sync_policy_inv_update', 'the card sync policy revision never decreases', {
      control: () => run('UPDATE card_sync_policy SET revision = revision + 1, paused = 1, paused_at = ?', at()),
      act: () => run('UPDATE card_sync_policy SET revision = 0') });
    tprobe('trg_card_sync_issuer_policy_inv_update', 'an issuer policy revision grows by one per update', {
      control: () => run(`UPDATE card_sync_issuer_policy SET revision = revision + 1, updated_at = '${at(9)}' WHERE id = 'chase'`),
      act: () => run(`UPDATE card_sync_issuer_policy SET updated_at = '${at(9)}' WHERE id = 'chase'`) });
    const openPairing = (o = {}) => fresh('card_sync_pairings', { status: 'open', code_digest: dig('hph1:'), closed_at: null,
      created_by_ref: id('usr_'), failed_attempts: 2, ...o });
    tprobe('trg_card_sync_pairings_inv_update', 'a closed pairing never changes', {
      act: () => run('UPDATE card_sync_pairings SET failed_attempts = 1 WHERE id = ?', g.p) });
    tprobe('trg_card_sync_pairings_inv_update', 'a pairing keeps its owner, lifetime and replacement target', {
      act: () => run('UPDATE card_sync_pairings SET replaces_device_id = ? WHERE id = ?', g.d, openPairing().id) });
    tprobe('trg_card_sync_pairings_inv_update', 'a pairing code is single-use and never replaced', {
      act: () => run('UPDATE card_sync_pairings SET code_digest = ? WHERE id = ?', dig('hph1:'), openPairing().id) });
    tprobe('trg_card_sync_pairings_inv_update', 'pairing history never goes back', {
      control: () => run('UPDATE card_sync_pairings SET failed_attempts = 3 WHERE id = ?', openPairing().id),
      act: () => run('UPDATE card_sync_pairings SET failed_attempts = 1 WHERE id = ?', openPairing().id) });
    tprobe('trg_card_sync_pairings_inv_update', 'pairing status change not allowed', {
      control: () => run(`UPDATE card_sync_pairings SET status = 'redeemed', code_digest = NULL, redeemed_at = '${at(30)}' WHERE id = ?`, openPairing().id),
      act: () => run(`UPDATE card_sync_pairings SET status = 'approved', code_digest = NULL, redeemed_at = '${at(30)}', closed_at = '${at(31)}' WHERE id = ?`, openPairing().id) });
    const device = () => fresh('card_sync_devices');
    tprobe('trg_card_sync_devices_inv_update', 'a closed device never changes', {
      control: () => run(`UPDATE card_sync_devices SET status = 'revoked', token_digest = NULL, closed_at = '${at(70)}', close_reason = 'owner' WHERE id = ?`, device().id),
      act: () => { const d = device(); run(`UPDATE card_sync_devices SET status = 'revoked', token_digest = NULL, closed_at = '${at(70)}', close_reason = 'owner' WHERE id = ?`, d.id);
        run(`UPDATE card_sync_devices SET last_used_at = '${at(80)}' WHERE id = ?`, d.id); } });
    tprobe('trg_card_sync_devices_inv_update', 'a device keeps its identity and lifetime', {
      control: () => run(`UPDATE card_sync_devices SET last_used_at = '${at(80)}' WHERE id = ?`, device().id),
      act: () => run("UPDATE card_sync_devices SET label = 'Renamed' WHERE id = ?", device().id) });
    tprobe('trg_card_sync_devices_inv_update', 'a device token digest is never replaced', {
      act: () => run('UPDATE card_sync_devices SET token_digest = ? WHERE id = ?', dig('hdh1:'), device().id) });
    tprobe('trg_card_sync_devices_inv_update', 'device status change not allowed', {
      act: () => run("UPDATE card_sync_devices SET status = 'pending' WHERE id = ?", device().id) });
    const dscope = () => fresh('card_sync_device_scopes');
    tprobe('trg_card_sync_device_scopes_inv_update', 'a revoked device scope never changes', {
      act: () => { const s = dscope(); run(`UPDATE card_sync_device_scopes SET status = 'revoked', revoked_at = '${at()}' WHERE id = ?`, s.id);
        run(`UPDATE card_sync_device_scopes SET revoked_at = '${at(5)}' WHERE id = ?`, s.id); } });
    tprobe('trg_card_sync_device_scopes_inv_update', 'a device scope keeps its device, binding and grant', {
      act: () => run('UPDATE card_sync_device_scopes SET binding_version = 2 WHERE id = ?', dscope().id) });
    tprobe('trg_card_sync_runs_inv_update', 'a closed run never changes', {
      control: () => run(`UPDATE card_sync_runs SET acceptance_state = 'aborted', closed_at = '${at(160)}', aborted_at = '${at(160)}', abort_reason = 'not-signed-in' WHERE id = ?`, fresh('card_sync_runs').id),
      act: () => { const r = fresh('card_sync_runs'); run(`UPDATE card_sync_runs SET acceptance_state = 'aborted', closed_at = '${at(160)}', aborted_at = '${at(160)}', abort_reason = 'not-signed-in' WHERE id = ?`, r.id);
        run("UPDATE card_sync_runs SET abort_reason = 'user-cancelled' WHERE id = ?", r.id); } });
    tprobe('trg_card_sync_runs_inv_update', 'a run keeps its device, binding and window', {
      act: () => run('UPDATE card_sync_runs SET binding_version = 2 WHERE id = ?', fresh('card_sync_runs').id) });
    tprobe('trg_card_sync_runs_inv_update', 'an accepted run keeps its acceptance', {
      control: () => run(`UPDATE card_sync_runs SET aborted_at = '${at(300)}', abort_reason = 'user-cancelled' WHERE id = ?`, g.r),
      act: () => run('UPDATE card_sync_runs SET payload_digest = ? WHERE id = ?', dig('pd1:'), g.r) });

    const setOf = (o = {}) => fresh('card_sync_observation_sets', o);
    const bumpSet = (sid, set) => run(`UPDATE card_sync_observation_sets SET ${set}, version = version + 1 WHERE id = ?`, sid);
    const discard = (sid) => bumpSet(sid, `state = 'rejected', closed_at = '${at(900)}', close_reason = 'discarded', discard_reason = 'not-mine', closed_by_ref = '${g.usr}'`);
    tprobe('trg_card_sync_observation_sets_inv_frozen', 'an observation set header is immutable', {
      control: () => bumpSet(setOf().id, "state = 'blocked-review'"),
      act: () => bumpSet(setOf().id, "parser_version = 'other@1'") });
    tprobe('trg_card_sync_observation_sets_inv_state', 'a review mark never goes back', {
      control: () => run('UPDATE card_sync_observation_sets SET review_ledger_revision = 5 WHERE id = ?', setOf().id),
      act: () => { const s = setOf(); run('UPDATE card_sync_observation_sets SET review_ledger_revision = 5 WHERE id = ?', s.id);
        run('UPDATE card_sync_observation_sets SET review_ledger_revision = 4 WHERE id = ?', s.id); } });
    tprobe('trg_card_sync_observation_sets_inv_state', 'an observation set version grows by one per change', {
      act: () => run("UPDATE card_sync_observation_sets SET state = 'blocked-review' WHERE id = ?", setOf().id) });
    probe(db, 'set version jump', { act: () => run("UPDATE card_sync_observation_sets SET state = 'blocked-review', version = version + 2 WHERE id = ?", setOf().id),
      expect: { trigger: 'an observation set version grows by one per change' } });
    tprobe('trg_card_sync_observation_sets_inv_state', 'a closed observation set never reopens', {
      control: () => discard(setOf().id),
      act: () => { const s = setOf(); discard(s.id); bumpSet(s.id, "state = 'needs-review', closed_at = NULL, close_reason = NULL, discard_reason = NULL, closed_by_ref = NULL"); } });
    tprobe('trg_card_sync_observation_sets_inv_state', 'a discarded or expired observation set keeps its outcomes', {
      act: () => { const s = setOf(); discard(s.id); bumpSet(s.id, 'inserted_count = 1'); } });
    tprobe('trg_card_sync_observation_sets_inv_state', 'purged content stays purged', {
      control: () => { const s = setOf(); discard(s.id); bumpSet(s.id, `content_purged_at = '${at(950)}'`); },
      act: () => { const s = setOf(); discard(s.id); bumpSet(s.id, `content_purged_at = '${at(950)}'`); bumpSet(s.id, `content_purged_at = '${at(960)}'`); } });
    tprobe('trg_card_sync_observation_sets_inv_state', 'a receipt only goes from kept to expired or deleted', {
      control: () => bumpSet(setOf().id, "receipt_state = 'expired'"),
      act: () => bumpSet(setOf().id, "receipt_state = 'none'") });
    tprobe('trg_card_sync_observation_sets_inv_state', 'observation set state change not allowed', {
      control: () => bumpSet(setOf().id, `state = 'committed', closed_at = '${at(900)}', close_reason = 'committed'`),
      act: () => bumpSet(setOf().id, "state = 'accepted-uncommitted'") });
    tprobe('trg_card_sync_observation_sets_inv_delete', 'only closed observation sets are deleted', {
      control: () => { const s = setOf(); discard(s.id); run('DELETE FROM card_sync_observation_sets WHERE id = ?', s.id); },
      act: () => run('DELETE FROM card_sync_observation_sets WHERE id = ?', setOf().id) });
    tprobe('trg_card_sync_set_card_hints_inv_order', 'card hints are sorted, unique and dense', {
      control: () => { const s = setOf().id; insertRow(db, 'card_sync_set_card_hints', { observation_set_id: s, origin: 'extension', ordinal: 0, last4: '1234' });
        insertRow(db, 'card_sync_set_card_hints', { observation_set_id: s, origin: 'extension', ordinal: 1, last4: '5678' }); },
      act: () => { const s = setOf().id; insertRow(db, 'card_sync_set_card_hints', { observation_set_id: s, origin: 'extension', ordinal: 0, last4: '5678' });
        insertRow(db, 'card_sync_set_card_hints', { observation_set_id: s, origin: 'extension', ordinal: 1, last4: '1234' }); } });
    probe(db, 'card hints must be dense', { act: () => insertRow(db, 'card_sync_set_card_hints', { observation_set_id: setOf().id,
      origin: 'extension', ordinal: 1, last4: '1234' }), expect: { trigger: 'card hints are sorted, unique and dense' } });
    const obs = (o = {}) => fresh('card_source_observations', o);
    const resolve = (oid, extra = '') => run(`UPDATE card_source_observations SET state = 'resolved', outcome = 'inserted',
      resolved_transaction_id = ?, provenance = 1, resolved_at = '${at(700)}'${extra} WHERE id = ?`, g.t4, oid);
    tprobe('trg_card_source_observations_inv_update', 'an observation is immutable', {
      control: () => resolve(obs().id), act: () => run('UPDATE card_source_observations SET amount_minor = 1 WHERE id = ?', obs().id) });
    tprobe('trg_card_source_observations_inv_update', 'ledger provenance is never dropped', {
      act: () => { const o = obs(); resolve(o.id); run('UPDATE card_source_observations SET provenance = 0 WHERE id = ?', o.id); } });
    tprobe('trg_card_source_observations_inv_update', 'an expired observation never changes', {
      act: () => { const o = obs(); run(`UPDATE card_source_observations SET state = 'expired', resolved_at = '${at(700)}' WHERE id = ?`, o.id);
        run("UPDATE card_source_observations SET state = 'rejected' WHERE id = ?", o.id); } });
    tprobe('trg_card_source_observations_inv_update', 'observation state change not allowed', {
      control: () => { const o = obs(); resolve(o.id); run("UPDATE card_source_observations SET state = 'rejected', outcome = NULL, resolved_transaction_id = NULL WHERE id = ?", o.id); },
      act: () => { const o = obs(); resolve(o.id); run('UPDATE card_source_observations SET state = \'open\', outcome = NULL, resolved_transaction_id = NULL, resolved_at = NULL WHERE id = ?', o.id); } });
    tprobe('trg_card_source_observations_inv_provenance', 'ledger provenance is never deleted', {
      control: () => run('DELETE FROM card_source_observations WHERE id = ?', obs().id),
      act: () => { const o = obs(); resolve(o.id); run('DELETE FROM card_source_observations WHERE id = ?', o.id); } });

    // card_transactions: the ledger state machine, including review finding 10's counterexamples
    const txn = (o = {}) => fresh('card_transactions', o);
    const upd = (tid, set) => run(`UPDATE card_transactions SET ${set}, revision = revision + 1 WHERE id = ?`, tid);
    const removeAs = (from, reason) => `status = 'removed', removed_reason = '${reason}', removed_from_status = '${from}', removed_at = '${at(800)}'`;
    tprobe('trg_card_transactions_inv_insert', 'a card transaction starts pending or posted at revision 1', {
      control: () => txn({ status: 'pending', posted_date: null }),
      act: () => txn({ status: 'removed', removed_reason: 'cancelled', removed_from_status: 'pending', removed_at: at() }) });
    tprobe('trg_card_transactions_inv_update', 'a card transaction revision grows by one per update', {
      control: () => upd(txn().id, "notes = 'n'"), act: () => run("UPDATE card_transactions SET notes = 'n' WHERE id = ?", txn().id) });
    tprobe('trg_card_transactions_inv_update', 'a card transaction keeps its provenance', {
      act: () => upd(txn().id, "source = 'other'") });
    tprobe('trg_card_transactions_inv_update', 'removal history is frozen while removed', {
      control: () => upd(txn({ status: 'pending', posted_date: null }).id, removeAs('pending', 'cancelled')),
      act: () => { const t = txn({ status: 'pending', posted_date: null }); upd(t.id, removeAs('pending', 'cancelled'));
        upd(t.id, "removed_reason = 'mistaken-import'"); } });
    tprobe('trg_card_transactions_inv_update', 'the legacy removal reason is never assigned', {
      act: () => upd(txn().id, `status = 'removed', removed_reason = 'legacy', removed_from_status = NULL, removed_at = '${at(800)}'`) });
    tprobe('trg_card_transactions_inv_update', 'a removal records the status it removed', {   // review finding 10, probe 2
      control: () => upd(txn().id, removeAs('posted', 'mistaken-import')),
      act: () => upd(txn().id, removeAs('pending', 'cancelled')) });
    tprobe('trg_card_transactions_inv_update', 'a removed card transaction returns only to its prior status', {
      control: () => { const t = txn(); upd(t.id, removeAs('posted', 'mistaken-import'));
        upd(t.id, 'status = \'posted\', removed_reason = NULL, removed_from_status = NULL, removed_at = NULL'); },
      act: () => { const t = txn(); upd(t.id, removeAs('posted', 'mistaken-import'));
        upd(t.id, 'status = \'pending\', posted_date = NULL, removed_reason = NULL, removed_from_status = NULL, removed_at = NULL'); } });
    tprobe('trg_card_transactions_inv_update', 'a posted card transaction never returns to pending', {
      control: () => upd(txn({ status: 'pending', posted_date: null }).id, "status = 'posted', posted_date = '2026-10-03'"),
      act: () => upd(txn().id, "status = 'pending', posted_date = NULL") });
    const MARK = 'reversal_snapshot_revision = revision';    // in an UPDATE, `revision` is the row's old revision
    tprobe('trg_card_transactions_inv_update', 'a reversal marker names the change that set it', {
      control: () => upd(txn({ status: 'pending', posted_date: null }).id, `status = 'posted', posted_date = '2026-10-03', ${MARK}`),
      act: () => upd(txn().id, `notes = 'n', ${MARK}`) });
    probe(db, 'a reversal marker naming another revision', {
      act: () => upd(txn().id, 'amount_minor = 1300, reversal_snapshot_revision = 7'),
      expect: { trigger: 'a reversal marker names the change that set it' } });
    tprobe('trg_card_transactions_inv_update', 'a value change replaces or clears the reversal marker', {
      control: () => { const t = txn(); upd(t.id, `amount_minor = 1300, ${MARK}`); upd(t.id, "user_category = 'Dining'"); },
      act: () => { const t = txn(); upd(t.id, `amount_minor = 1300, ${MARK}`); upd(t.id, 'amount_minor = 1500'); } });
    tprobe('trg_card_transactions_inv_update', 'a card transaction merges only into a live one', {
      act: () => { const x = txn(); const y = txn(); upd(y.id, removeAs('posted', 'mistaken-import'));
        upd(x.id, `${removeAs('posted', 'superseded')}, merged_into_id = '${y.id}'`); } });
    const identityFor = (tid, o = {}) => fresh('card_source_identities', { canonical_transaction_id: tid, ...o });
    tprobe('trg_card_transactions_inv_update', 're-point identities before merging a card transaction', {
      control: () => { const x = txn(); const y = txn(); upd(x.id, `${removeAs('posted', 'superseded')}, merged_into_id = '${y.id}'`); },
      act: () => { const x = txn(); const y = txn(); identityFor(x.id); upd(x.id, `${removeAs('posted', 'superseded')}, merged_into_id = '${y.id}'`); } });
    { // review finding 3/8: a session-decided promotion can be reverted exactly to its snapshot; nothing else goes back to pending
      const promote = (t, flag) => upd(t.id, `status = 'posted', posted_date = '2026-10-04', amount_minor = 1300, reversal_snapshot_revision = ${flag ? 'revision' : 'NULL'}`);
      const revert = (t, amount) => upd(t.id, `status = 'pending', posted_date = NULL, amount_minor = ${amount}, reversal_snapshot_revision = NULL`);
      probe(db, 'un-promote restores the pre-promotion snapshot', {
        control: () => { const t = txn({ status: 'pending', posted_date: null }); promote(t, 1); revert(t, 1234);
          const v = get('SELECT count(*) AS n FROM card_transaction_versions WHERE card_transaction_id = ?', t.id).n;
          if (v !== 2) throw new Error(`expected 2 snapshots, found ${v}`); },
        act: () => { const t = txn({ status: 'pending', posted_date: null }); promote(t, 1); revert(t, 999); },
        expect: { trigger: 'a posted card transaction never returns to pending' }, cover: [['trigger', 'trg_card_transactions_inv_snapshot']] });
      probe(db, 'an issuer-driven promotion is not reversible', {
        act: () => { const t = txn({ status: 'pending', posted_date: null }); promote(t, 0); revert(t, 1234); },
        expect: { trigger: 'a posted card transaction never returns to pending' } });
      probe(db, 'undoing a restore with promotion returns to the recorded removal', {
        control: () => { const t = txn({ status: 'pending', posted_date: null }); upd(t.id, removeAs('pending', 'cancelled'));
          upd(t.id, "status = 'posted', posted_date = '2026-10-04', removed_reason = NULL, removed_from_status = NULL, removed_at = NULL, reversal_snapshot_revision = revision");
          upd(t.id, `${removeAs('pending', 'cancelled')}, posted_date = NULL, reversal_snapshot_revision = NULL`); },
        act: () => { const t = txn({ status: 'pending', posted_date: null }); upd(t.id, removeAs('pending', 'cancelled'));
          upd(t.id, "status = 'posted', posted_date = '2026-10-04', removed_reason = NULL, removed_from_status = NULL, removed_at = NULL, reversal_snapshot_revision = revision");
          upd(t.id, `${removeAs('pending', 'cancelled').replace(at(800), at(801))}, posted_date = NULL, reversal_snapshot_revision = NULL`); },
        expect: { trigger: 'a removal records the status it removed' } });
    }
    tprobe('trg_card_source_identities_inv_frozen', 'a source identity tuple is immutable', {
      control: () => run(`UPDATE card_source_identities SET last_seen_at = '${at(5)}' WHERE id = ?`, identityFor(g.t4).id),
      act: () => run('UPDATE card_source_identities SET id_hash = ? WHERE id = ?', dig('xid1:'), identityFor(g.t4).id) });
    const merged = () => { const x = txn(); const y = txn(); upd(x.id, `${removeAs('posted', 'superseded')}, merged_into_id = '${y.id}'`); return [x, y]; };
    tprobe('trg_card_source_identities_inv_target_insert', 'an identity never points at a merged card transaction', {
      control: () => identityFor(merged()[1].id), act: () => identityFor(merged()[0].id) });
    tprobe('trg_card_source_identities_inv_target_update', 'an identity never points at a merged card transaction', {
      act: () => { const [x] = merged(); run('UPDATE card_source_identities SET canonical_transaction_id = ? WHERE id = ?', x.id, identityFor(g.t4).id); } });
    { // review finding 9: reversing a merge restores the loser first, then its identities
      const setup = () => { const x = txn(); const y = txn(); const i = identityFor(x.id);
        run('UPDATE card_source_identities SET canonical_transaction_id = ? WHERE id = ?', y.id, i.id);
        upd(x.id, `${removeAs('posted', 'superseded')}, merged_into_id = '${y.id}'`); return { x, i }; };
      probe(db, 'merge reversal order', {
        control: () => { const { x, i } = setup();
          upd(x.id, "status = 'posted', removed_reason = NULL, removed_from_status = NULL, removed_at = NULL, merged_into_id = NULL");
          run('UPDATE card_source_identities SET canonical_transaction_id = ? WHERE id = ?', x.id, i.id); },
        act: () => { const { x, i } = setup(); run('UPDATE card_source_identities SET canonical_transaction_id = ? WHERE id = ?', x.id, i.id); },
        expect: { trigger: 'an identity never points at a merged card transaction' } });
    }

    const item = (o = {}) => fresh('card_reconciliation_suggestions', o);
    const bumpItem = (iid, set) => run(`UPDATE card_reconciliation_suggestions SET ${set}, updated_at = '${at(990)}' WHERE id = ?`, iid);
    tprobe('trg_card_reconciliation_suggestions_inv_update', 'a closed review item never changes', {
      control: () => bumpItem(item().id, "status = 'expired'"),
      act: () => { const i = item(); bumpItem(i.id, "status = 'expired'"); bumpItem(i.id, 'classified_ledger_revision = 3'); } });
    tprobe('trg_card_reconciliation_suggestions_inv_update', 'a review item keeps its set and row', {
      act: () => bumpItem(item().id, `observation_id = '${obs().id}'`) });
    const committedItem = () => item({ status: 'committed', committed_action: 'insert-new', committed_transaction_id: g.t4,
      committed_revision: 1, committed_plan_id: id('prv_'), committed_at: at() });
    tprobe('trg_card_reconciliation_suggestions_inv_update', 'a committed review item keeps its classification', {
      control: () => bumpItem(committedItem().id, `status = 'decided', draft_action = 'reject-row', drafted_by_ref = '${g.usr}', drafted_at = '${at()}'`),
      act: () => bumpItem(committedItem().id, "category = 'no-stable-id', reason = 'no-stable-id', allowed_actions = 137") });
    tprobe('trg_card_reconciliation_suggestions_inv_update', 'a review classification never goes back', {
      act: () => { const i = item(); bumpItem(i.id, 'classified_ledger_revision = 5'); bumpItem(i.id, 'classified_ledger_revision = 4'); } });
    tprobe('trg_card_reconciliation_suggestions_inv_update', 'review item status change not allowed', {
      act: () => bumpItem(item().id, `status = 'committed', committed_action = 'insert-new', committed_transaction_id = '${g.t4}',
        committed_revision = 1, committed_plan_id = '${id('prv_')}', committed_at = '${at()}'`) });
    tprobe('trg_card_reconciliation_suggestions_inv_update', 'a blocked candidate is never a decision target', {
      control: () => bumpItem(g.it1, `status = 'decided', draft_action = 'same-transaction', draft_transaction_id = '${g.t4}',
        drafted_by_ref = '${g.usr}', drafted_at = '${at()}'`),
      act: () => { const other = txn(); insertRow(db, 'card_reconciliation_candidates', { review_item_id: g.it1, card_account_id: g.a1,
        rank: 2, transaction_id: other.id, rule: 'near-content:v1', matched_on: 3, blocked_reason: 'different-known-cards' });
        bumpItem(g.it1, `status = 'decided', draft_action = 'same-transaction', draft_transaction_id = '${other.id}',
          drafted_by_ref = '${g.usr}', drafted_at = '${at()}'`); } });
    const cov = (o = {}) => fresh('card_coverage_windows', o);
    tprobe('trg_card_coverage_windows_inv_update', 'a coverage window records what was observed, once', {
      control: () => run(`UPDATE card_coverage_windows SET ledger_state = 'committed', updated_at = '${at(9)}' WHERE id = ?`, cov().id),
      act: () => run("UPDATE card_coverage_windows SET observed_end = '2026-10-02' WHERE id = ?", cov().id) });
    tprobe('trg_card_coverage_windows_inv_update', 'coverage ledger state change not allowed', {
      act: () => { const w = cov(); run("UPDATE card_coverage_windows SET ledger_state = 'committed' WHERE id = ?", w.id);
        run("UPDATE card_coverage_windows SET ledger_state = 'rejected' WHERE id = ?", w.id); } });
    tprobe('trg_card_coverage_windows_inv_delete', 'committed coverage is never deleted', {
      control: () => { const w = cov(); run("UPDATE card_coverage_windows SET ledger_state = 'expired-unreviewed' WHERE id = ?", w.id);
        run('DELETE FROM card_coverage_windows WHERE id = ?', w.id); },
      act: () => { const w = cov(); run("UPDATE card_coverage_windows SET ledger_state = 'committed' WHERE id = ?", w.id);
        run('DELETE FROM card_coverage_windows WHERE id = ?', w.id); } });
    const plan = (o = {}) => fresh('card_sync_commit_plans', o);
    const closePlan = (pid, status = 'consumed') => run(`UPDATE card_sync_commit_plans SET status = '${status}', closed_at = '${at(450)}'${
      status === 'cancelled' ? ", cancel_reason = 'superseded'" : ''} WHERE id = ?`, pid);
    tprobe('trg_card_sync_commit_plans_inv_update', 'a plan is used at most once', {
      control: () => closePlan(plan().id),
      act: () => { const p = plan(); closePlan(p.id); run("UPDATE card_sync_commit_plans SET status = 'cancelled', cancel_reason = 'superseded' WHERE id = ?", p.id); } });
    tprobe('trg_card_sync_commit_plans_inv_update', 'a prepared plan is immutable', {
      act: () => run('UPDATE card_sync_commit_plans SET plan_digest = ? WHERE id = ?', dig('pl1:'), plan().id) });
    tprobe('trg_card_sync_commit_plans_inv_expiry', 'a plan never outlives its observation set', {
      control: () => plan({ observation_set_id: setOf({ expires_at: at(1000) }).id }),
      act: () => plan({ observation_set_id: setOf({ expires_at: at(999) }).id }) });
    tprobe('trg_card_sync_commit_plans_inv_delete', 'a prepared plan is closed before it is deleted', {
      control: () => { const p = plan(); closePlan(p.id, 'cancelled'); run('DELETE FROM card_sync_commit_plans WHERE id = ?', p.id); },
      act: () => run('DELETE FROM card_sync_commit_plans WHERE id = ?', plan().id) });
    tprobe('trg_card_sync_plan_actions_inv_prepared', 'actions are written only into a prepared plan', {
      control: () => insertRow(db, 'card_sync_plan_actions', actionRow(g, { plan_id: plan().id, ordinal: 0 })),
      act: () => { const p = plan(); closePlan(p.id); insertRow(db, 'card_sync_plan_actions', actionRow(g, { plan_id: p.id })); } });
    tprobe('trg_card_payment_links_inv_payment', 'a payment link needs a card payment of that amount and currency', {
      control: () => fresh('card_payment_links'), act: () => fresh('card_payment_links', { card_transaction_id: g.t4 }) });
    { // review finding 10, probe 1: REPLACE never overwrites an event, and the event survives the attempt
      const e = fresh('card_transaction_events');
      const err = attempt(() => insertRow(db, 'card_transaction_events', { ...e, reason: 'user-edit', edit_fields: 2 }, 'INSERT OR REPLACE'));
      const kept = get('SELECT edit_fields FROM card_transaction_events WHERE id = ?', e.id);
      if (!matches(err, { trigger: 'card_transaction_events rows are never replaced' }) || kept?.edit_fields !== 1) {
        fail('REPLACE on an event', `${describe(err)}; stored edit_fields ${kept?.edit_fields}`);
      } else results.refused += 1;
    }

    section('fixtures');
    // ------------------------------------------------------------------ E1a fixtures: store, drop the receipt, rehydrate, revalidate
    const fixturesDir = FIXTURES_DIR;
    function storeFixture(p) {
      const acct = BASE.card_accounts();
      insertRow(db, 'card_accounts', { ...acct, issuer: p.issuer, currency: p.currency });
      const legacyScope = id('scp_');
      insertRow(db, 'card_scopes', { ...BASE.card_scopes(db, g), id: legacyScope, card_account_id: acct.id, kind: 'legacy',
        holder_alias: 'unknown', last4: null, confirmed_by_ref: null, confirmed_at: null });
      const scopes = [...new Set([...p.coverage.map((c) => c.cardScopeId), ...p.rows.map((r) => r.cardScopeId)])];
      for (const s of scopes) insertRow(db, 'card_scopes', { ...BASE.card_scopes(db, g), id: s, card_account_id: acct.id, last4: null });
      insertRow(db, 'card_source_bindings', { ...BASE.card_source_bindings(db, g), id: p.bindingId, card_account_id: acct.id,
        issuer: p.issuer, currency: p.currency, source: p.source, status: 'confirmed', retired_at: null, version: p.bindingVersion });
      const runId = makeRun(db, g, { binding_id: p.bindingId, card_account_id: acct.id, binding_version: p.bindingVersion,
        acceptance_state: 'accepted', payload_digest: e1a.cardSyncPayloadDigest(p), accepted_at: at(200), closed_at: at(200) });
      const st = p.statement;
      const setId = id('obs_');
      insertRow(db, 'card_sync_observation_sets', setRow(g, { id: setId, card_account_id: acct.id, issuer: p.issuer, currency: p.currency,
        run_id: runId, binding_id: p.bindingId, binding_version: p.bindingVersion, capture_id: p.captureId,
        payload_digest: e1a.cardSyncPayloadDigest(p), contract_version: p.contractVersion, mode: p.mode, observed_at: p.observedAt,
        owner: p.owner, source: p.source, parser_version: p.parserVersion, row_count: p.rows.length, open_count: p.rows.length,
        byte_count: Buffer.byteLength(e1a.canonicalJson(p)), producer_rejected_count: p.rejectedCount, statement_present: st ? 1 : 0,
        statement_charges_minor: st?.chargesMinor ?? null, statement_credits_minor: st?.creditsMinor ?? null,
        statement_net_minor: st?.netMinor ?? null, statement_previous_balance_minor: st?.previousBalanceMinor ?? null,
        statement_new_balance_minor: st?.newBalanceMinor ?? null }));
      p.cards.forEach((last4, ordinal) => insertRow(db, 'card_sync_set_card_hints', { observation_set_id: setId, origin: 'extension', ordinal, last4 }));
      p.coverage.forEach((c, ordinal) => insertRow(db, 'card_coverage_windows', { id: id('card-cover-'), card_account_id: acct.id,
        card_scope_id: c.cardScopeId, source_kind: 'extension', source: p.source, import_batch_id: null, observation_set_id: setId,
        entry_ordinal: ordinal, status: c.status, requested_start: c.requested?.start ?? null, requested_end: c.requested?.end ?? null,
        requested_basis: c.requested?.dateBasis ?? null, observed_start: c.observed?.start ?? null, observed_end: c.observed?.end ?? null,
        observed_basis: c.observed?.dateBasis ?? null, claimed_completeness: c.completeness, verified_completeness:
          c.completeness === 'complete' ? 'partial' : c.completeness, termination: c.termination, page_count: c.pageCount,
        evidence: 'extension-claimed', ledger_state: 'observed-uncommitted', observed_at: p.observedAt, recorded_at: at(200), updated_at: at(200) }));
      const nsKind = new Map(db.prepare('SELECT namespace, kind FROM card_sync_namespaces').all().map((r) => [r.namespace, r.kind]));
      p.rows.forEach((r, ordinal) => {
        const kind = nsKind.get(r.identityNamespace);
        const identity = kind === 'capture' ? 'ccf1:' + H(['holdr.card-capture-fingerprint', 1, p.captureId, r.fingerprint]) : r.externalIdHash;
        const oid = id('card-obsrow-');
        insertRow(db, 'card_source_observations', obsRow(g, { id: oid, observation_set_id: setId, card_account_id: acct.id, ordinal,
          source_scope_id: r.cardScopeId, identity_namespace: r.identityNamespace, namespace_kind: kind, external_id_hash: r.externalIdHash,
          fingerprint: r.fingerprint, identity_hash: identity, transaction_date: r.transactionDate, posted_date: r.postedDate,
          status: r.status, amount_minor: r.amountMinor, currency: p.currency, original_amount_minor: r.originalAmountMinor,
          original_currency: r.originalCurrency, kind: r.kind, description: r.description, merchant: r.merchant,
          issuer_category: r.issuerCategory, content_digest: rcd1({ transaction_date: r.transactionDate, posted_date: r.postedDate,
            status: r.status, amount_minor: r.amountMinor, kind: r.kind, description: r.description, merchant: r.merchant,
            issuer_category: r.issuerCategory, original_amount_minor: r.originalAmountMinor, original_currency: r.originalCurrency }) }));
        r.secondaryIds.forEach((s, i) => insertRow(db, 'card_observation_secondary_ids', { id: id('card-obsid-'), observation_id: oid,
          ordinal: i + 1, namespace: s.namespace, namespace_kind: 'stable', id_hash: s.idHash }));
      });
      const json = e1a.canonicalJson(p);
      insertRow(db, 'card_sync_payload_receipts', { observation_set_id: setId, payload_digest: e1a.cardSyncPayloadDigest(p),
        canonical_json: json, byte_length: Buffer.byteLength(json), accepted_at: at(200), expires_at: at(200 + 7 * DAY_S) });
      return setId;
    }
    // §5.4 rehydrateCardSyncPayload: typed, from rows only (the receipt is gone), then the E1a builder and validator.
    function rehydrate(setId) {
      const s = get('SELECT * FROM card_sync_observation_sets WHERE id = ?', setId);
      const cards = db.prepare('SELECT last4 FROM card_sync_set_card_hints WHERE observation_set_id = ? ORDER BY ordinal').all(setId).map((r) => r.last4);
      const range = (start, end, basis) => (start === null ? null : { start, end, dateBasis: basis });
      const coverage = db.prepare('SELECT * FROM card_coverage_windows WHERE observation_set_id = ? ORDER BY entry_ordinal').all(setId)
        .map((c) => ({ cardScopeId: c.card_scope_id, status: c.status, requested: range(c.requested_start, c.requested_end, c.requested_basis),
          observed: range(c.observed_start, c.observed_end, c.observed_basis), completeness: c.claimed_completeness, pageCount: c.page_count,
          termination: c.termination }));
      const secondary = db.prepare('SELECT namespace, id_hash FROM card_observation_secondary_ids WHERE observation_id = ? ORDER BY ordinal');
      const stored = db.prepare('SELECT * FROM card_source_observations WHERE observation_set_id = ? ORDER BY ordinal').all(setId);
      const rows = stored.map((o) => ({ transactionDate: o.transaction_date, postedDate: o.posted_date, status: o.status,
        amountMinor: o.amount_minor, kind: o.kind, description: o.description, merchant: o.merchant, issuerCategory: o.issuer_category,
        externalIdHash: o.external_id_hash, cardScopeId: o.source_scope_id, identityNamespace: o.identity_namespace,
        secondaryIds: secondary.all(o.id).map((x) => ({ namespace: x.namespace, idHash: x.id_hash })),
        originalAmountMinor: o.original_amount_minor, originalCurrency: o.original_currency }));
      const draft = { contractVersion: s.contract_version, source: s.source, parserVersion: s.parser_version, issuer: s.issuer,
        currency: s.currency, owner: s.owner, cards, bindingId: s.binding_id, bindingVersion: s.binding_version, captureId: s.capture_id,
        observedAt: s.observed_at, mode: s.mode, coverage, rejectedCount: s.producer_rejected_count,
        statement: s.statement_present ? { chargesMinor: s.statement_charges_minor, creditsMinor: s.statement_credits_minor,
          netMinor: s.statement_net_minor, previousBalanceMinor: s.statement_previous_balance_minor,
          newBalanceMinor: s.statement_new_balance_minor } : null, rows };
      const built = e1a.buildCardSyncPayloadV2(draft);
      return { built, stored, digest: s.payload_digest };
    }
    if (!e1a || !fs.existsSync(fixturesDir)) {
      fail('E1a fixtures', `no E1a fixtures at ${fixturesDir}`);
    } else {
      for (const file of fs.readdirSync(fixturesDir).filter((f) => f.endsWith('.v2.json')).sort()) {
        const payload = JSON.parse(fs.readFileSync(path.join(fixturesDir, file), 'utf8'));
        const checked = e1a.validateCardSyncPayloadV2(payload);
        if (!checked.ok) { fail(file, 'the E1a validator refuses the fixture'); continue; }
        inSavepoint(db, () => {
          const setId = storeFixture(checked.payload);
          bumpSet(setId, "receipt_state = 'expired'");
          run('DELETE FROM card_sync_payload_receipts WHERE observation_set_id = ?', setId);
          const { built, stored, digest } = rehydrate(setId);
          const ok = built.ok && e1a.cardSyncPayloadDigest(built.payload) === digest
            && built.payload.rows.every((r, i) => r.fingerprint === stored[i].fingerprint);
          if (!ok) fail(file, built.ok ? 'rehydrated digest differs' : `rehydrated payload refused: ${JSON.stringify(built.issues.slice(0, 3))}`);
          else { results.behaviour += 1; note(`${file}: ${checked.payload.rows.length} rows stored, receipt deleted, rehydrated, E1a-valid, digest equal`); }
        });
      }
    }

    section('FK index audit');
    // ------------------------------------------------------------------ finding 13: every FK whose parent can be deleted is indexed
    const NEVER_DELETED = new Set(['card_accounts', 'card_import_batches', 'card_sync_sources', 'card_sync_namespaces', 'card_scopes',
      'card_source_bindings', 'card_transactions', 'card_source_identities', 'card_transaction_events', 'card_sync_policy']);
    {
      let audited = 0;
      const missing = [];
      for (const table of NEW_TABLES) {
        const indexes = db.prepare(`PRAGMA index_list(${table})`).all().filter((i) => !i.partial)
          .map((i) => db.prepare(`PRAGMA index_info(${i.name})`).all().sort((a, b) => a.seqno - b.seqno).map((c) => c.name));
        const groups = new Map();
        for (const fk of db.prepare(`PRAGMA foreign_key_list(${table})`).all()) {
          if (!groups.has(fk.id)) groups.set(fk.id, { parent: fk.table, from: [] });
          groups.get(fk.id).from.push(fk.from);
        }
        for (const { parent, from } of groups.values()) {
          if (NEVER_DELETED.has(parent)) continue;
          audited += 1;
          // the child key's leading column (the parent's own id) must lead a non-partial index; trailing columns of a
          // composite key (account, origin, kind) are denormalized copies that the index lookup then filters
          const ok = indexes.some((cols) => cols[0] === from[0]);
          if (!ok) missing.push(`${table}(${from.join(', ')}) -> ${parent}`);
        }
      }
      for (const t of NEVER_DELETED) {
        if (!['card_accounts', 'card_import_batches'].includes(t)
          && !CATALOGUE.triggers.includes(`trg_${t}_inv_no_delete`)) missing.push(`${t} has no no-delete trigger`);
      }
      if (missing.length) fail('FK index audit', missing.join('; '));
      else note(`FK index audit: ${audited} child FKs to deletable parents, each led by a non-partial index; ${NEVER_DELETED.size} never-deleted parents`);
    }

    // ------------------------------------------------------------------ Revision 3: the round-2 findings, each with a refusing and an accepted probe
    section('revision 3');
    const rowidOf = (table, key) => get(`SELECT rowid AS r FROM ${table} WHERE id = ?`, key).r;
    const countOf = (table) => get(`SELECT count(*) AS n FROM ${table}`).n;
    const exists = (table, key) => Boolean(get(`SELECT 1 AS x FROM ${table} WHERE id = ?`, key));
    { // finding 3: UPDATE OR REPLACE can neither delete a row through a rowid collision nor fall back to a column default
      const two = (make) => () => [make(), make()];
      const ROWID = {
        card_accounts: { rows: two(() => fresh('card_accounts').id) },
        card_import_batches: { rows: two(() => fresh('card_import_batches').id) },
        card_scopes: { rows: two(() => fresh('card_scopes').id), bump: 'version = version + 1' },
        card_source_bindings: { rows: () => [g.b, fresh('card_source_bindings').id] },
        card_source_binding_scopes: { rows: () => [bscope, fresh('card_source_binding_scopes').id] },
        card_sync_policy: { rows: () => ['card-sync-policy', null] },          // one row: the rowid moves without a collision
        card_sync_issuer_policy: { rows: () => ['chase', 'amex'], bump: 'revision = revision + 1' },
        card_sync_pairings: { rows: two(() => openPairing().id) },
        card_sync_devices: { rows: two(() => device().id) },
        card_sync_device_scopes: { rows: two(() => dscope().id) },
        card_sync_runs: { rows: two(() => fresh('card_sync_runs').id) },
        card_sync_observation_sets: { rows: two(() => setOf().id) },
        card_source_observations: { rows: two(() => obs().id) },
        card_transactions: { rows: two(() => txn().id), bump: 'revision = revision + 1' },
        card_source_identities: { rows: two(() => identityFor(g.t4).id) },
        card_reconciliation_suggestions: { rows: two(() => item().id) },
        card_coverage_windows: { rows: two(() => cov().id) },
        card_sync_commit_plans: { rows: two(() => plan().id) },
      };
      let nullProbes = 0;
      for (const trigger of CATALOGUE.triggers) {
        const m = trigger.match(/^trg_(\w+)_inv_rowid$/);
        if (!m) continue;
        const table = m[1];
        const c = ROWID[table];
        if (!c) { fail(trigger, 'no rowid case'); continue; }
        const message = `${table} rows keep their rowid and never fall back to a default`;
        const sets = (first, col) => [first, c.bump && !c.bump.startsWith(`${col} `) ? c.bump : null].filter(Boolean).join(', ');
        probe(db, `${trigger}: UPDATE OR REPLACE onto another row's rowid`, {
          control: () => { const [a] = c.rows(); run(`UPDATE OR REPLACE ${table} SET ${sets('rowid = rowid')} WHERE rowid = ?`, rowidOf(table, a)); },
          act: () => {
            const [a, b] = c.rows();
            const before = countOf(table);
            const target = b === null ? 'rowid + 1000' : String(rowidOf(table, b));
            const err = attempt(() => run(`UPDATE OR REPLACE ${table} SET ${sets(`rowid = ${target}`)} WHERE rowid = ?`, rowidOf(table, a)));
            if (countOf(table) !== before || (b !== null && !exists(table, b))) throw new Error('UPDATE OR REPLACE deleted a row');
            if (err) throw err;
          },
          expect: { trigger: message }, cover: [['trigger', trigger]] });
        // every NOT NULL column with a default is listed, and a NULL written through REPLACE never becomes that default
        const defaults = db.prepare(`PRAGMA table_info(${table})`).all().filter((col) => col.notnull && col.dflt_value !== null).map((col) => col.name);
        const listed = [...get('SELECT sql FROM sqlite_master WHERE name = ?', trigger).sql.matchAll(/NEW\.(\w+) IS NULL/g)].map((x) => x[1]);
        if (JSON.stringify(listed) !== JSON.stringify(defaults)) fail(trigger, `lists ${listed.join(',')} but the defaults are ${defaults.join(',')}`);
        for (const col of defaults) {
          inSavepoint(db, () => {
            const [a] = c.rows();
            const r = rowidOf(table, a);
            const before = get(`SELECT ${col} AS v FROM ${table} WHERE rowid = ?`, r).v;
            const err = attempt(() => run(`UPDATE OR REPLACE ${table} SET ${sets(`${col} = NULL`, col)} WHERE rowid = ?`, r));
            const after = get(`SELECT ${col} AS v FROM ${table} WHERE rowid = ?`, r).v;
            if (!err || err.code !== KIND.trigger || !err.message.startsWith('card invariant: ') || after !== before) {
              fail(`${table}.${col} = NULL through REPLACE`, `${describe(err)}; ${before} -> ${after}`);
            } else { results.refused += 1; nullProbes += 1; }
          });
        }
      }
      // the same statements without the triggers (phase A schema): SQLite really deletes, and really falls back to the default
      inSavepoint(dbA, () => {
        const s1 = BASE.card_scopes(dbA, gA); const s2 = BASE.card_scopes(dbA, gA);
        insertRow(dbA, 'card_scopes', s1); insertRow(dbA, 'card_scopes', s2);
        dbA.prepare('UPDATE OR REPLACE card_scopes SET rowid = (SELECT rowid FROM card_scopes WHERE id = ?), version = version + 1 WHERE id = ?').run(s2.id, s1.id);
        const deleted = !dbA.prepare('SELECT 1 FROM card_scopes WHERE id = ?').get(s2.id);
        const p = { ...BASE.card_sync_pairings(dbA, gA), status: 'open', code_digest: dig('hph1:'), closed_at: null, created_by_ref: id('usr_'), failed_attempts: 4 };
        insertRow(dbA, 'card_sync_pairings', p);
        dbA.prepare('UPDATE OR REPLACE card_sync_pairings SET failed_attempts = NULL WHERE id = ?').run(p.id);
        const reset = dbA.prepare('SELECT failed_attempts AS n FROM card_sync_pairings WHERE id = ?').get(p.id).n;
        if (!deleted || reset !== 0) fail('REPLACE without triggers', `deleted=${deleted} failed_attempts=${reset}`);
        else { results.behaviour += 1; note(`without the v15 triggers, UPDATE OR REPLACE deletes a colliding card scope and resets a pairing's failed_attempts 4 -> 0; with them: 18 rowid collisions and ${nullProbes} NULL-to-default writes refused`); }
      });
      // UNIQUE keys of mutable tables: their columns are frozen, or the state that would collide is unreachable
      const keepBoth = (table, a, b, fn) => () => {
        const err = attempt(fn);
        if (!exists(table, a) || !exists(table, b)) throw new Error('UPDATE OR REPLACE deleted a row');
        if (err) throw err;
      };
      probe(db, 'UPDATE OR REPLACE onto another identity tuple', {
        control: () => { const a = identityFor(g.t4); run(`UPDATE OR REPLACE card_source_identities SET last_seen_at = '${at(5)}' WHERE id = ?`, a.id); },
        act: () => { const a = identityFor(g.t4); const b = identityFor(g.t4);
          keepBoth('card_source_identities', a.id, b.id, () => run('UPDATE OR REPLACE card_source_identities SET id_hash = ? WHERE id = ?', b.id_hash, a.id))(); },
        expect: { trigger: 'a source identity tuple is immutable' } });
      probe(db, 'UPDATE OR REPLACE onto another card scope id', {
        act: () => { const a = fresh('card_scopes'); const b = fresh('card_scopes');
          keepBoth('card_scopes', a.id, b.id, () => run('UPDATE OR REPLACE card_scopes SET id = ?, version = version + 1 WHERE id = ?', b.id, a.id))(); },
        expect: { trigger: 'a card scope keeps its account, kind and card' } });
      probe(db, 'UPDATE OR REPLACE onto another card transaction id', {
        act: () => { const a = txn(); const b = txn();
          keepBoth('card_transactions', a.id, b.id, () => run('UPDATE OR REPLACE card_transactions SET id = ?, revision = revision + 1 WHERE id = ?', b.id, a.id))(); },
        expect: { trigger: 'a card transaction keeps its provenance' } });
      probe(db, 'UPDATE OR REPLACE revives a retired binding over the live one', {
        act: () => { const r = fresh('card_source_bindings');
          keepBoth('card_source_bindings', g.b, r.id, () => run("UPDATE OR REPLACE card_source_bindings SET status = 'confirmed', retired_at = NULL, version = version + 1 WHERE id = ?", r.id))(); },
        expect: { trigger: 'a retired binding never changes' } });
      probe(db, 'UPDATE OR REPLACE reopens a consumed plan over the prepared one', {
        act: () => { const s = setOf(); const p1 = plan({ observation_set_id: s.id }); closePlan(p1.id); const p2 = plan({ observation_set_id: s.id });
          keepBoth('card_sync_commit_plans', p1.id, p2.id, () => run("UPDATE OR REPLACE card_sync_commit_plans SET status = 'prepared', closed_at = NULL WHERE id = ?", p1.id))(); },
        expect: { trigger: 'a plan is used at most once' } });
    }

    { // finding 1: consecutive session corrections, and a manual pending correction followed by a promotion
      probe(db, 'a second correction replaces the reversal marker', {
        control: () => { const t = txn(); upd(t.id, `amount_minor = 1300, ${MARK}`); upd(t.id, `amount_minor = 1400, ${MARK}`);
          const r = get('SELECT revision, reversal_snapshot_revision AS m FROM card_transactions WHERE id = ?', t.id);
          if (r.revision !== 3 || r.m !== 2) throw new Error(`marker ${r.m} at revision ${r.revision}`); },
        act: () => { const t = txn(); upd(t.id, `amount_minor = 1300, ${MARK}`); upd(t.id, 'amount_minor = 1400'); },   // keeps the stale marker
        expect: { trigger: 'a value change replaces or clears the reversal marker' } });
      const pendingThenPromoted = () => { const t = txn({ status: 'pending', posted_date: null });
        upd(t.id, `amount_minor = 1250, ${MARK}`);                                                        // session accept-correction on a pending row
        upd(t.id, `status = 'posted', posted_date = '2026-10-04', amount_minor = 1300, ${MARK}`);          // then a session promotion
        return t; };
      probe(db, 'pending correction, then promotion: the promotion reverts to the corrected pending row', {
        control: () => upd(pendingThenPromoted().id, "status = 'pending', posted_date = NULL, amount_minor = 1250, reversal_snapshot_revision = 1"),
        act: () => upd(pendingThenPromoted().id, "status = 'pending', posted_date = NULL, amount_minor = 1234, reversal_snapshot_revision = NULL"),
        expect: { trigger: 'a posted card transaction never returns to pending' } });
      // reverts restore the snapshot's own marker, so session changes unwind newest first (§2.10, §5.7.1)
      probe(db, 'two corrections unwind newest first', {
        control: () => { const t = txn(); upd(t.id, `amount_minor = 1300, ${MARK}`); upd(t.id, `amount_minor = 1400, ${MARK}`);
          upd(t.id, 'amount_minor = 1300, reversal_snapshot_revision = 1');      // exact revert of the second, its marker restored
          upd(t.id, 'amount_minor = 1234, reversal_snapshot_revision = NULL'); }, // then the first
        act: () => { const t = txn(); upd(t.id, `amount_minor = 1300, ${MARK}`); upd(t.id, `amount_minor = 1400, ${MARK}`);
          upd(t.id, 'amount_minor = 1350, reversal_snapshot_revision = 1'); },  // an older marker without the exact snapshot
        expect: { trigger: 'a reversal marker names the change that set it' } });
      probe(db, 'a correction after a promotion: undo the correction, then the promotion', {
        control: () => { const t = txn({ status: 'pending', posted_date: null });
          upd(t.id, `status = 'posted', posted_date = '2026-10-04', amount_minor = 1300, ${MARK}`);
          upd(t.id, `amount_minor = 1400, ${MARK}`);
          upd(t.id, 'amount_minor = 1300, reversal_snapshot_revision = 1');
          upd(t.id, "status = 'pending', posted_date = NULL, amount_minor = 1234, reversal_snapshot_revision = NULL"); },
        act: () => { const t = txn({ status: 'pending', posted_date: null });
          upd(t.id, `status = 'posted', posted_date = '2026-10-04', amount_minor = 1300, ${MARK}`);
          upd(t.id, `amount_minor = 1400, ${MARK}`);
          upd(t.id, "status = 'pending', posted_date = NULL, amount_minor = 1234, reversal_snapshot_revision = NULL"); },  // skips a step
        expect: { trigger: 'a posted card transaction never returns to pending' } });
      const promoted = () => { const t = txn({ status: 'pending', posted_date: null });
        upd(t.id, `status = 'posted', posted_date = '2026-10-04', amount_minor = 1300, ${MARK}`); return t; };
      probe(db, 'a category edit keeps the latest change revertible; an issuer change does not', {
        control: () => { const t = promoted(); upd(t.id, "user_category = 'Dining'");
          upd(t.id, "status = 'pending', posted_date = NULL, amount_minor = 1234, reversal_snapshot_revision = NULL"); },
        act: () => { const t = promoted(); upd(t.id, 'amount_minor = 1350, reversal_snapshot_revision = NULL');
          upd(t.id, "status = 'pending', posted_date = NULL, amount_minor = 1234, reversal_snapshot_revision = NULL"); },
        expect: { trigger: 'a posted card transaction never returns to pending' } });
    }

    { // finding 2(a): snapshots are authenticated against the row they record
      const corrected = () => { const t = txn(); upd(t.id, `amount_minor = 1300, ${MARK}`); return t; };
      const forged = (t) => snapshotOf(db, t.id, { revision: 100, status: 'pending', posted_date: null, amount_minor: 7, reversal_snapshot_revision: null });
      tprobe('trg_card_transaction_versions_inv_authentic', 'a snapshot records a card transaction as it is', {
        control: () => insertRow(db, 'card_transaction_versions', snapshotOf(db, corrected().id)),
        act: () => insertRow(db, 'card_transaction_versions', forged(corrected())) });
      probe(db, 'a snapshot with another amount at the current revision', {
        act: () => insertRow(db, 'card_transaction_versions', snapshotOf(db, corrected().id, { amount_minor: 7 })),
        expect: { trigger: 'a snapshot records a card transaction as it is' } });
      probe(db, "the reviewer's forged revision-100 snapshot cannot be reverted to", {
        control: () => { const t = corrected(); upd(t.id, 'amount_minor = 1234, reversal_snapshot_revision = NULL'); },   // the real revert
        act: () => { const t = corrected(); attempt(() => insertRow(db, 'card_transaction_versions', forged(t)));
          upd(t.id, "status = 'pending', posted_date = NULL, amount_minor = 7, reversal_snapshot_revision = NULL"); },
        expect: { trigger: 'a posted card transaction never returns to pending' } });
    }

    { // finding 2(b): §4.9.2's reversibility predicate, executed from the document, at and right after the committed revision
      if (!DOC_QUERIES.has('adjustment-reversible')) fail('§4.9.2', 'the document has no -- @query adjustment-reversible');
      else {
        const reversible = db.prepare(query('adjustment-reversible'));
        const rev2 = db.prepare(`SELECT NOT EXISTS (SELECT 1 FROM card_transaction_versions v WHERE v.card_transaction_id = ?
          AND v.revision > ?) AS r`);
        const expectR = (label, tid, committed, valueChange, want) => {
          const got = reversible.get({ transaction_id: tid, committed_revision: committed, value_change: valueChange })?.reversible;
          if (got !== want) fail(`reversible: ${label}`, `got ${got}, expected ${want}`);
          else if (want) results.accepted += 1; else results.refused += 1;
        };
        inSavepoint(db, () => {
          const a = promoted2();
          expectR('a session promotion, just committed', a.id, 2, 1, 1);
          upd(a.id, "user_category = 'Dining'");
          expectR('the promotion, then a category edit', a.id, 2, 1, 1);
          upd(a.id, 'amount_minor = 1350, reversal_snapshot_revision = NULL');
          expectR('the promotion, then an issuer correction', a.id, 2, 1, 0);
          const b = txn();
          expectR('a link that did not write the row, just committed', b.id, 1, 0, 1);
          upd(b.id, "user_category = 'Dining'");
          expectR('the link, then a category edit', b.id, 1, 0, 1);
          const c = txn();
          upd(c.id, 'amount_minor = 1300');                          // right after the commit at revision 1: snapshot at revision 1
          expectR('the link, then an immediate value change', c.id, 1, 0, 0);
          const old = rev2.get(c.id, 1).r;
          if (old !== 1) fail('revision 2 predicate', 'expected the off-by-one to show');
          else note('reversibility (§4.9.2 query): reversible after commit and after category edits; not after an immediate value change (snapshot at the committed revision), which revision 2\'s "> committed_revision" missed');
        });
      }
      function promoted2() { const t = txn({ status: 'pending', posted_date: null });
        upd(t.id, `status = 'posted', posted_date = '2026-10-04', amount_minor = 1300, ${MARK}`); return t; }
    }

    { // finding 4: refreshing candidates while a valid draft names one of them
      const setup = () => { const o = obs(); const it = item({ observation_id: o.id }); const t1 = txn(); const t2 = txn();
        insertRow(db, 'card_reconciliation_candidates', { review_item_id: it.id, card_account_id: g.a1, rank: 1, transaction_id: t1.id,
          rule: 'near-content:v1', matched_on: 3, blocked_reason: null });
        bumpItem(it.id, `status = 'decided', draft_action = 'same-transaction', draft_transaction_id = '${t1.id}', drafted_by_ref = '${g.usr}', drafted_at = '${at(950)}'`);
        return { it, t1, t2 }; };
      const replaceCandidates = (it, list) => { run('DELETE FROM card_reconciliation_candidates WHERE review_item_id = ?', it.id);
        list.forEach((tid, i) => insertRow(db, 'card_reconciliation_candidates', { review_item_id: it.id, card_account_id: g.a1, rank: i + 1,
          transaction_id: tid, rule: 'near-content:v1', matched_on: 3, blocked_reason: null })); };
      // §4.5's protocol, one transaction: keep the draft, clear it, replace the list, restore the drafts whose target is still listed
      const refresh = (it, list) => {
        const d = get('SELECT * FROM card_reconciliation_suggestions WHERE id = ?', it.id);
        bumpItem(it.id, "status = 'open', draft_action = NULL, draft_transaction_id = NULL, draft_scope_id = NULL, drafted_by_ref = NULL, drafted_at = NULL");
        replaceCandidates(it, list);
        run(`UPDATE card_reconciliation_suggestions SET status = 'decided', draft_action = ?, draft_transaction_id = ?, draft_scope_id = ?,
          drafted_by_ref = ?, drafted_at = ?, updated_at = ? WHERE id = ?`, d.draft_action, d.draft_transaction_id, d.draft_scope_id,
          d.drafted_by_ref, d.drafted_at, at(991), it.id);
      };
      probe(db, 'refresh keeps a valid draft when a better-ranked candidate appears', {
        control: () => { const { it, t1, t2 } = setup(); refresh(it, [t2.id, t1.id]);
          const after = get('SELECT status, draft_transaction_id AS t FROM card_reconciliation_suggestions WHERE id = ?', it.id);
          const rank = get('SELECT rank FROM card_reconciliation_candidates WHERE review_item_id = ? AND transaction_id = ?', it.id, t1.id).rank;
          if (after.status !== 'decided' || after.t !== t1.id || rank !== 2) throw new Error('the draft was not kept'); },
        act: () => { const { it, t1, t2 } = setup(); replaceCandidates(it, [t2.id, t1.id]); },    // revision 2: replace under the draft
        expect: { restrict: true } });
      probe(db, 'refresh never restores a draft whose target left the list', {
        act: () => { const { it, t2 } = setup(); refresh(it, [t2.id]); },
        expect: { fk: true } });
    }

    { // findings 5 and 6: the generation advances by CAS; the consent switch has its own revision, so devices stay current
      inSavepoint(db, () => {          // E2's advance: expectedGeneration -> nextGeneration, in the DB transaction of the change
        const g0 = get('SELECT authorization_generation AS a FROM card_sync_policy').a;
        const advance = (expected) => run(`UPDATE card_sync_policy SET authorization_generation = ?, generation_changed_at = ?,
          revision = revision + 1, updated_at = ? WHERE authorization_generation = ?`, id('agn_'), at(1200), at(1200), expected).changes;
        const first = advance(g0);
        const second = advance(g0);      // a second change that still holds the old generation
        if (first !== 1 || second !== 0) fail('generation CAS', `first ${first}, stale ${second}`);
        else { results.accepted += 1; results.refused += 1; }
      });
      tprobe('trg_card_source_bindings_inv_update', 'an auto-sync revision grows by one per change', {
        control: () => run('UPDATE card_source_bindings SET auto_sync_revision = auto_sync_revision + 1 WHERE id = ?', g.b),
        act: () => run('UPDATE card_source_bindings SET auto_sync_revision = auto_sync_revision + 2 WHERE id = ?', g.b) });
      inSavepoint(db, () => {
        const state = () => get('SELECT version, auto_sync_revision AS a FROM card_source_bindings WHERE id = ?', g.b);
        const s0 = state();
        const off = () => run('UPDATE card_source_bindings SET auto_sync_revision = auto_sync_revision + 1, updated_at = ? WHERE id = ?', at(1300), g.b).changes;
        const enable = (version, rev) => run(`UPDATE card_source_bindings SET auto_sync_revision = auto_sync_revision + 1, updated_at = ?
          WHERE id = ? AND version = ? AND auto_sync_revision = ?`, at(1301), g.b, version, rev).changes;
        const offed = off();                                       // another tab turned auto-sync off (no version needed)
        const stale = enable(s0.version, s0.a);                    // the UI's enable still carries the revision it read
        const beforeGrant = state().a;
        insertRow(db, 'card_sync_device_scopes', { ...BASE.card_sync_device_scopes(db, g), binding_version: s0.version });
        off();                                                     // a grant changes what "enable" covers: +1, version untouched
        const racing = enable(s0.version, beforeGrant);            // an enable read before the grant
        const fresh1 = enable(s0.version, state().a);
        const s1 = state();
        if (offed !== 1 || stale !== 0 || racing !== 0 || fresh1 !== 1 || s1.version !== s0.version || s1.a !== s0.a + 3) {
          fail('auto-sync CAS', `off=${offed} stale=${stale} racing=${racing} fresh=${fresh1} version ${s0.version}->${s1.version} rev ${s0.a}->${s1.a}`);
        } else { results.refused += 2; results.accepted += 2; note('auto-sync CAS: off always applies; an enable with a stale autoSyncRevision (after off, or across a grant) changes nothing; the binding version, which device grants pin, never moves'); }
      });
    }

    { // finding 7: permanent owner maintenance on a ledger whose observation set expired long ago
      const ev = (o) => insertRow(db, 'card_transaction_events', baseEvent(g, { edit_fields: 0, ...o }));
      probe(db, 'day-31 maintenance: detach, re-point and revert, without any set or plan', {
        control: () => {
          const t = txn(); const u = txn();
          const keep = identityFor(t.id); const wrong = identityFor(t.id); const moved = identityFor(t.id);
          run("UPDATE card_source_identities SET status = 'detached' WHERE id = ?", wrong.id);             // unlink a mistaken alias
          ev({ card_transaction_id: t.id, event_type: 'identity-detached', reason: 'maintenance', identity_id: wrong.id, from_canonical_id: t.id });
          run('UPDATE card_source_identities SET canonical_transaction_id = ? WHERE id = ?', u.id, moved.id);   // re-point an alias
          ev({ card_transaction_id: u.id, event_type: 'identity-repointed', reason: 'maintenance', identity_id: moved.id,
            from_canonical_id: t.id, to_canonical_id: u.id });
          const corr = id('card-event-');
          upd(t.id, `amount_minor = 1300, ${MARK}`);                                                          // a session correction...
          ev({ id: corr, card_transaction_id: t.id, transaction_revision: 2, event_type: 'corrected', reason: 'posted-correction',
            from_status: 'posted', to_status: 'posted', from_amount_minor: 1234, to_amount_minor: 1300, from_transaction_date: '2026-10-01',
            to_transaction_date: '2026-10-01', from_kind: 'purchase', to_kind: 'purchase' });
          upd(t.id, 'amount_minor = 1234, reversal_snapshot_revision = NULL');                                // ...reverted to its snapshot
          ev({ card_transaction_id: t.id, transaction_revision: 3, event_type: 'reversed', reason: 'maintenance', reverses_event_id: corr,
            from_status: 'posted', to_status: 'posted' });
          void keep; },
        act: () => { const t = promoted2b(); upd(t.id, 'amount_minor = 1350, reversal_snapshot_revision = NULL');   // the marker moved on
          upd(t.id, "status = 'pending', posted_date = NULL, amount_minor = 1234, reversal_snapshot_revision = NULL"); },
        expect: { trigger: 'a posted card transaction never returns to pending' } });
      probe(db, 'a merge re-point still needs its cause', {
        control: () => ev({ event_type: 'identity-repointed', reason: 'maintenance', identity_id: g.i1, from_canonical_id: g.tp, to_canonical_id: g.t4 }),
        act: () => ev({ event_type: 'identity-repointed', reason: 'superseded', identity_id: g.i1, from_canonical_id: g.tp, to_canonical_id: g.t4 }),
        expect: { check: 'ck_evt_repointed' } });
      function promoted2b() { const t = txn({ status: 'pending', posted_date: null });
        upd(t.id, `status = 'posted', posted_date = '2026-10-04', amount_minor = 1300, ${MARK}`); return t; }
    }

    { // A file set's plan pins no authorization (policy revision and generation are NULL exactly for file sets)
      const filePlan = (o) => { const fs = fileSetRow(gA, {}); insertRow(dbA, 'card_sync_observation_sets', fs);
        insertRow(dbA, 'card_sync_commit_plans', planRow(gA, { observation_set_id: fs.id, binding_id: null, binding_version: null,
          payload_digest: null, contract_version: null, issuer_policy_revision: null, policy_revision: null, authorization_generation: null, ...o })); };
      probe(dbA, 'a file-set plan pins no generation or policy revision', {
        control: () => filePlan({}), act: () => filePlan({ authorization_generation: gA.gen }),
        expect: { check: 'ck_plan_extension_shape' } });
      probe(dbA, 'an extension plan pins the policy revision', {
        act: () => insertRow(dbA, 'card_sync_commit_plans', planRow(gA, { observation_set_id: makeSet(dbA, gA), policy_revision: null })),
        expect: { check: 'ck_plan_extension_shape' } });
    }

    { // incremental expiry (non-blocking 8): a set closes only after every row is settled
      const withRow = () => { const s = setOf({ row_count: 1, open_count: 1 }); const o = obs({ observation_set_id: s.id }); return { s, o }; };
      const close = (sid) => bumpSet(sid, `state = 'expired-unreviewed', closed_at = '${at(900)}', close_reason = 'expired', open_count = 0, expired_count = 1`);
      tprobe('trg_card_sync_observation_sets_inv_state', 'an observation set closes only after its rows are settled', {
        control: () => { const { s, o } = withRow(); run(`UPDATE card_source_observations SET state = 'expired', resolved_at = '${at(700)}' WHERE id = ?`, o.id); close(s.id); },
        act: () => close(withRow().s.id) });
    }

    // ------------------------------------------------------------------ Revision 4: round-3 findings
    section('revision 4');
    { // finding 1 backstop: a device stores a plan only for its own set, and only when the set needs no person
      const devicePlan = (sid, o = {}) => insertRow(db, 'card_sync_commit_plans', planRow(g, { observation_set_id: sid,
        principal_kind: 'device', device_id: g.d, actor_ref: null, auto_eligible: 1, ...o }));
      const quiet = () => setOf({ state: 'accepted-uncommitted' }).id;
      tprobe('trg_card_sync_commit_plans_inv_device', 'a device plans only a set that needs no person', {
        control: () => devicePlan(quiet()),
        act: () => devicePlan(setOf().id) });                                        // needs-review
      probe(db, 'a device plan beside an open review item', {
        control: () => insertRow(db, 'card_sync_commit_plans', planRow(g, { observation_set_id: quiet() })),   // the owner may plan it
        act: () => { const sid = quiet(); const o = obs({ observation_set_id: sid });
          fresh('card_reconciliation_suggestions', { observation_set_id: sid, observation_id: o.id }); devicePlan(sid); },
        expect: { trigger: 'a device plans only a set that needs no person' } });
      tprobe('trg_card_sync_commit_plans_inv_device', 'a device plans only its own observation set', {
        act: () => devicePlan(setOf({ state: 'accepted-uncommitted', device_id: device().id }).id) });
    }
    { // finding 2: an owner restore of a migrated legacy removal is exactly revertible; inventing a legacy removal stays refused
      const legacy = get("SELECT * FROM card_transactions WHERE removed_reason = 'legacy'");
      const restore = () => upd(legacy.id, `status = 'posted', removed_reason = NULL, removed_from_status = NULL, removed_at = NULL, ${MARK}`);
      probe(db, 'restore of a migrated legacy removal, then its exact revert', {
        control: () => {
          upd(legacy.id, "user_category = 'Hardware', notes = 'kept by the owner'");
          restore();
          upd(legacy.id, `status = 'removed', removed_reason = 'legacy', removed_from_status = NULL, removed_at = '${legacy.removed_at}',
            reversal_snapshot_revision = NULL`);
          const r = get('SELECT * FROM card_transactions WHERE id = ?', legacy.id);
          for (const k of ['status', 'removed_reason', 'removed_from_status', 'removed_at', 'merged_into_id', 'dismissed_at', 'amount_minor',
            'transaction_date', 'posted_date', 'description', 'kind', 'card_scope_id', 'reversal_snapshot_revision']) {
            if (r[k] !== legacy[k]) throw new Error(`${k} changed`);
          }
          if (r.user_category !== 'Hardware' || r.notes !== 'kept by the owner' || r.revision !== legacy.revision + 3) throw new Error('owner edits lost'); },
        act: () => { restore();
          upd(legacy.id, `status = 'removed', removed_reason = 'legacy', removed_from_status = NULL, removed_at = '${at(5)}',
            reversal_snapshot_revision = NULL`); },                                  // not the recorded removal
        expect: { trigger: 'the legacy removal reason is never assigned' } });
    }

    // ------------------------------------------------------------------ Revision 5: consent-bearing grants and revocation after expiry
    section('revision 5');
    {
      const NOWX = at(31 * DAY_S);
      const consenting = (deviceId, bindingId = g.b, stale = false) => {
        const gid = id('card-dscope-');
        insertRow(db, 'card_sync_device_scopes', { id: gid, device_id: deviceId, binding_id: bindingId, binding_version: 1, mode: 'isolated-read',
          contract_version: 1, status: 'active', granted_by_ref: g.usr, granted_at: at(60), revoked_at: null, auto_sync: 1,
          consent_contract_version: 1, consent_guard_revision: stale ? 3 : 4, consent_issuer_revision: 1, consent_binding_version: 1,
          consent_by_ref: g.usr, consent_at: at(90) });
        return gid;
      };
      const cleared = (gid, status) => {
        const r = get('SELECT * FROM card_sync_device_scopes WHERE id = ?', gid);
        const fields = ['consent_contract_version', 'consent_guard_revision', 'consent_issuer_revision', 'consent_binding_version',
          'consent_by_ref', 'consent_at'];
        if (r.status !== status || r.auto_sync !== 0 || fields.some((f) => r[f] !== null)) throw new Error(`grant ${JSON.stringify(r)}`);
      };
      const statusOnly = (where, ...args) => run(`UPDATE card_sync_device_scopes SET status = 'revoked', revoked_at = '${NOWX}' WHERE ${where}`, ...args);
      // every shared statement of §5.3.1 accepted on consenting grants (current and stale); the status-only revoke refused
      probe(db, 'revoke-grants-of-device on consenting grants', {
        control: () => { const d = device(); const a = consenting(d.id); const b = consenting(d.id, fresh('card_source_bindings').id, true);
          db.prepare(query('revoke-grants-of-device')).run({ now: NOWX, device_id: d.id }); cleared(a, 'revoked'); cleared(b, 'revoked'); },
        act: () => { const d = device(); consenting(d.id); statusOnly('device_id = ?', d.id); },
        expect: { check: 'ck_dscope_consent_shape' } });
      probe(db, 'revoke-grants-of-binding on consenting grants', {
        control: () => { const a = consenting(device().id); const b = consenting(device().id, g.b, true);
          db.prepare(query('revoke-grants-of-binding')).run({ now: NOWX, binding_id: g.b }); cleared(a, 'revoked'); cleared(b, 'revoked'); },
        act: () => { consenting(device().id); statusOnly('binding_id = ? AND status = ?', g.b, 'active'); },
        expect: { check: 'ck_dscope_consent_shape' } });
      probe(db, 'revoke-grant on a consenting grant', {
        control: () => { const a = consenting(device().id, g.b, true); db.prepare(query('revoke-grant')).run({ now: NOWX, grant_id: a });
          cleared(a, 'revoked'); },
        act: () => statusOnly('id = ?', consenting(device().id)),
        expect: { check: 'ck_dscope_consent_shape' } });
      probe(db, 'revoke-all-grants on consenting grants', {
        control: () => { const a = consenting(device().id); db.prepare(query('revoke-all-grants')).run({ now: NOWX }); cleared(a, 'revoked');
          if (get("SELECT count(*) AS n FROM card_sync_device_scopes WHERE status = 'active'").n !== 0) throw new Error('an active grant left'); },
        act: () => { consenting(device().id); statusOnly("status = 'active'"); },
        expect: { check: 'ck_dscope_consent_shape' } });
      probe(db, 'withdraw-consent-of-binding keeps the grant active', {
        control: () => { const a = consenting(device().id); const b = consenting(device().id, g.b, true);
          db.prepare(query('withdraw-consent-of-binding')).run({ binding_id: g.b }); cleared(a, 'active'); cleared(b, 'active'); },
        act: () => { const a = consenting(device().id); run('UPDATE card_sync_device_scopes SET auto_sync = 0 WHERE id = ?', a); },   // half a withdrawal
        expect: { check: 'ck_dscope_consent_shape' } });

      // R17: natural expiry keeps the held set and its deadline; a later explicit revocation or password reset still quarantines
      const held = () => {
        const d = device(); const gid = consenting(d.id); consenting(d.id, fresh('card_source_bindings').id, true);
        const r = makeRun(db, g, { device_id: d.id, acceptance_state: 'accepted', payload_digest: dig('pd1:'), accepted_at: at(200), closed_at: at(200) });
        const sid = makeSet(db, g, { run_id: r, device_id: d.id });                       // needs-review: held for the owner
        const pid = makePlan(db, g, { observation_set_id: sid });                         // the owner's prepared plan
        return { d, gid, sid, pid, set: get('SELECT state, expires_at, version FROM card_sync_observation_sets WHERE id = ?', sid) };
      };
      const expireNaturally = (h) => {                                                    // retention phase 2, as §5.9 and §5.3.1 say
        run("UPDATE card_sync_devices SET status = 'expired', token_digest = NULL, closed_at = ?, close_reason = 'expired' WHERE id = ?", NOWX, h.d.id);
        db.prepare(query('revoke-grants-of-device')).run({ now: NOWX, device_id: h.d.id });
        run("UPDATE card_sync_commit_plans SET status = 'cancelled', closed_at = ?, cancel_reason = 'device-revoked' WHERE device_id = ? AND status = 'prepared'", NOWX, h.d.id);
      };
      const revokeLater = (h, reason) => {                                                // revokeCardSyncDevice on an expired device
        run('UPDATE card_sync_devices SET status = ?, close_reason = ? WHERE id = ?', 'revoked', reason, h.d.id);
        db.prepare(query('revoke-grants-of-device')).run({ now: at(32 * DAY_S), device_id: h.d.id });
        db.prepare(query('quarantine-sets-of-device')).run({ device_id: h.d.id });
        db.prepare(query('cancel-plans-of-device')).run({ now: at(32 * DAY_S), device_id: h.d.id });
      };
      probe(db, 'natural expiry with consenting grants keeps the held set, its deadline and the owner plan', {
        control: () => { const h = held(); expireNaturally(h); cleared(h.gid, 'revoked');
          const s2 = get('SELECT state, expires_at, version FROM card_sync_observation_sets WHERE id = ?', h.sid);
          const p2 = get('SELECT status FROM card_sync_commit_plans WHERE id = ?', h.pid).status;
          if (JSON.stringify(s2) !== JSON.stringify(h.set) || p2 !== 'prepared') throw new Error(`set ${JSON.stringify(s2)}, plan ${p2}`); },
        act: () => { const h = held();                                                    // revision 4's statement: the reviewer's failure
          run("UPDATE card_sync_devices SET status = 'expired', token_digest = NULL, closed_at = ?, close_reason = 'expired' WHERE id = ?", NOWX, h.d.id);
          statusOnly("device_id = ? AND status = 'active'", h.d.id); },
        expect: { check: 'ck_dscope_consent_shape' } });
      for (const reason of ['password-reset', 'owner']) {
        probe(db, `natural expiry, then revocation (${reason}): quarantine and owner plan cancelled`, {
          control: () => { const h = held(); expireNaturally(h); revokeLater(h, reason);
            const dv = get('SELECT status, close_reason, closed_at, token_digest FROM card_sync_devices WHERE id = ?', h.d.id);
            const s2 = get('SELECT state, expires_at, version FROM card_sync_observation_sets WHERE id = ?', h.sid);
            const p2 = get('SELECT status, cancel_reason FROM card_sync_commit_plans WHERE id = ?', h.pid);
            if (dv.status !== 'revoked' || dv.close_reason !== reason || dv.closed_at !== NOWX || dv.token_digest !== null
              || s2.state !== 'blocked-review' || s2.expires_at !== h.set.expires_at || s2.version !== h.set.version + 1
              || p2.status !== 'cancelled' || p2.cancel_reason !== 'device-revoked') {
              throw new Error(`device ${JSON.stringify(dv)}, set ${JSON.stringify(s2)}, plan ${JSON.stringify(p2)}`);
            } },
          act: () => { const h = held(); expireNaturally(h);                              // rewriting the expiry instead of revoking
            run("UPDATE card_sync_devices SET status = 'revoked', close_reason = ?, closed_at = ? WHERE id = ?", reason, at(32 * DAY_S), h.d.id); },
          expect: { trigger: 'a closed device never changes' } });
      }
      probe(db, 'an expired device is revoked only by an owner action, a password reset or recovery', {
        act: () => { const h = held(); expireNaturally(h);
          run("UPDATE card_sync_devices SET status = 'revoked', close_reason = 'rejected' WHERE id = ?", h.d.id); },
        expect: { trigger: 'a closed device never changes' } });
      probe(db, 'an expired device never comes back', {
        act: () => { const h = held(); expireNaturally(h);
          run("UPDATE card_sync_devices SET status = 'active', close_reason = NULL, closed_at = NULL WHERE id = ?", h.d.id); },
        expect: { trigger: 'a closed device never changes' } });
      probe(db, 'a revoked device stays revoked after a later revocation', {
        act: () => { const h = held(); expireNaturally(h); revokeLater(h, 'owner');
          run("UPDATE card_sync_devices SET close_reason = 'password-reset' WHERE id = ?", h.d.id); },
        expect: { trigger: 'a closed device never changes' } });
    }

    // ------------------------------------------------------------------ Revision 6: round-5 findings and E8-M revision 3
    section('revision 6');
    { // finding 1: replacing a browser whose 30 days ran out before the approval, and one that is still active
      const consenting = (deviceId) => {
        const gid = id('card-dscope-');
        insertRow(db, 'card_sync_device_scopes', { id: gid, device_id: deviceId, binding_id: g.b, binding_version: 1, mode: 'isolated-read',
          contract_version: 1, status: 'active', granted_by_ref: g.usr, granted_at: at(60), revoked_at: null, auto_sync: 1,
          consent_contract_version: 1, consent_guard_revision: 4, consent_issuer_revision: 1, consent_binding_version: 1,
          consent_by_ref: g.usr, consent_at: at(90) });
        return gid;
      };
      // One invitation naming `target`, redeemed by a new browser N that is still inside its 10-minute approval window.
      const invitation = () => {
        const target = device();                                                         // active, expires at(60) + 29 days
        const TE = target.expires_at;
        const t = (s) => new Date(Date.parse(TE) + s * 1000).toISOString();
        const gid = consenting(target.id);
        const r = makeRun(db, g, { device_id: target.id, acceptance_state: 'accepted', payload_digest: dig('pd1:'), accepted_at: at(200), closed_at: at(200) });
        const sid = makeSet(db, g, { run_id: r, device_id: target.id });                // needs-review: held for the owner
        const pid = makePlan(db, g, { observation_set_id: sid });                       // the owner's prepared plan
        const set0 = get('SELECT state, expires_at, version FROM card_sync_observation_sets WHERE id = ?', sid);
        const p = openPairing({ replaces_device_id: target.id, created_at: t(-200), expires_at: t(100) });
        run("UPDATE card_sync_pairings SET status = 'redeemed', code_digest = NULL, redeemed_at = ? WHERE id = ?", t(-100), p.id);
        const n = fresh('card_sync_devices', { pairing_id: p.id, status: 'pending', activated_at: null, activated_by_ref: null,
          expires_at: null, created_at: t(-100), pending_expires_at: t(500) });
        return { target, TE, t, gid, sid, pid, set0, p, n };
      };
      const expireNaturally = (v) => {                                                  // retention phase 2 (§5.9, §5.3.1)
        run("UPDATE card_sync_devices SET status = 'expired', token_digest = NULL, closed_at = ?, close_reason = 'expired' WHERE id = ?", v.TE, v.target.id);
        db.prepare(query('revoke-grants-of-device')).run({ now: v.TE, device_id: v.target.id });
        run("UPDATE card_sync_commit_plans SET status = 'cancelled', closed_at = ?, cancel_reason = 'device-revoked' WHERE device_id = ? AND status = 'prepared'", v.TE, v.target.id);
      };
      // approveCardSyncPairing, in §5.3's order: the pairing, the new device and its grants, then the replaced device
      const approve = (v, A, { approvePairing = true, rotate } = {}) => {
        if (approvePairing) run("UPDATE card_sync_pairings SET status = 'approved', closed_at = ? WHERE id = ?", A, v.p.id);
        run("UPDATE card_sync_devices SET status = 'active', activated_at = ?, activated_by_ref = ?, expires_at = ? WHERE id = ?",
          A, g.usr, new Date(Date.parse(A) + 30 * DAY_S * 1000).toISOString(), v.n.id);
        insertRow(db, 'card_sync_device_scopes', { id: id('card-dscope-'), device_id: v.n.id, binding_id: g.b, binding_version: 1,
          mode: 'isolated-read', contract_version: 1, status: 'active', granted_by_ref: g.usr, granted_at: A });
        (rotate ?? ((st) => {
          if (st === 'expired') run("UPDATE card_sync_devices SET status = 'revoked', close_reason = 'rotated' WHERE id = ?", v.target.id);
          else if (st !== 'revoked') run("UPDATE card_sync_devices SET status = 'revoked', token_digest = NULL, closed_at = ?, close_reason = 'rotated' WHERE id = ?", A, v.target.id);
        }))(get('SELECT status FROM card_sync_devices WHERE id = ?', v.target.id).status);
        db.prepare(query('revoke-grants-of-device')).run({ now: A, device_id: v.target.id });
        db.prepare(query('quarantine-sets-of-device')).run({ device_id: v.target.id });
        db.prepare(query('cancel-plans-of-device')).run({ now: A, device_id: v.target.id });
      };
      const endState = (v) => {
        const d = get('SELECT status, close_reason, closed_at, token_digest FROM card_sync_devices WHERE id = ?', v.target.id);
        const gr = get('SELECT status, auto_sync, consent_at FROM card_sync_device_scopes WHERE id = ?', v.gid);
        const s = get('SELECT state, expires_at, version FROM card_sync_observation_sets WHERE id = ?', v.sid);
        const pl = get('SELECT status, cancel_reason FROM card_sync_commit_plans WHERE id = ?', v.pid);
        const n = get('SELECT status, activated_at, pending_expires_at FROM card_sync_devices WHERE id = ?', v.n.id);
        const p = get('SELECT status FROM card_sync_pairings WHERE id = ?', v.p.id);
        if (d.status !== 'revoked' || d.close_reason !== 'rotated' || d.token_digest !== null || gr.status !== 'revoked' || gr.auto_sync !== 0
          || gr.consent_at !== null || s.state !== 'blocked-review' || s.expires_at !== v.set0.expires_at || s.version !== v.set0.version + 1
          || pl.status !== 'cancelled' || pl.cancel_reason !== 'device-revoked' || n.status !== 'active' || !(n.activated_at < n.pending_expires_at)
          || p.status !== 'approved') {
          throw new Error(`end state ${JSON.stringify({ d, gr, s, pl, n, p })}`);
        }
        return { closedAt: d.closed_at, shape: JSON.stringify({ ...d, closed_at: undefined, gr, s: { ...s, version: s.version - v.set0.version }, pl, n: n.status, p }) };
      };
      const shapes = [];
      probe(db, 'rotation approved after natural expiry: the expired target becomes revoked (rotated), its sets quarantined', {
        control: () => { const v = invitation(); expireNaturally(v); approve(v, v.t(60));
          const e = endState(v); if (e.closedAt !== v.TE) throw new Error(`closed_at ${e.closedAt}`); shapes.push(e.shape); },
        act: () => { const v = invitation(); expireNaturally(v); approve(v, v.t(60), { approvePairing: false }); },   // pairing not approved
        expect: { trigger: 'a device is rotated only by the approval that replaces it' } });
      probe(db, 'rotation approved before expiry: the active target becomes revoked (rotated), its sets quarantined', {
        control: () => { const v = invitation(); approve(v, v.t(-50));
          const e = endState(v); if (e.closedAt !== v.t(-50)) throw new Error(`closed_at ${e.closedAt}`); shapes.push(e.shape);
          // retention afterwards finds no active device to expire
          if (run("UPDATE card_sync_devices SET status = 'expired' WHERE id = ? AND status = 'active' AND expires_at <= ?", v.target.id, v.t(1)).changes !== 0) throw new Error('expired again'); },
        act: () => { const v = invitation(); approve(v, v.t(-50), { approvePairing: false }); },
        expect: { trigger: 'a device is rotated only by the approval that replaces it' } });
      if (shapes.length === 2 && shapes[0] === shapes[1]) { results.behaviour += 1; note('C33: rotation approval before and after natural expiry ends in the same state (only closed_at differs: expiry or approval time)'); }
      else fail('C33', `end states differ: ${shapes.join(' / ')}`);
      probe(db, 'an expired device is not rotated by an approval that replaces another device', {
        act: () => { const v = invitation(); const w = invitation(); expireNaturally(v);
          run("UPDATE card_sync_pairings SET status = 'approved', closed_at = ? WHERE id = ?", w.t(60), w.p.id);       // w's approval, not v's
          run("UPDATE card_sync_devices SET status = 'revoked', close_reason = 'rotated' WHERE id = ?", v.target.id); },
        expect: { trigger: 'a device is rotated only by the approval that replaces it' } });
      probe(db, 'rotating an expired device keeps its expiry time', {
        act: () => { const v = invitation(); expireNaturally(v);
          approve(v, v.t(60), { rotate: () => run("UPDATE card_sync_devices SET status = 'revoked', close_reason = 'rotated', closed_at = ? WHERE id = ?", v.t(60), v.target.id) }); },
        expect: { trigger: 'a closed device never changes' } });
    }

    { // finding 2: lifetime fields of a closing device are frozen NULL-safely; only pending → active initialises them
      const pending = () => fresh('card_sync_devices', { status: 'pending', activated_at: null, activated_by_ref: null, expires_at: null });
      const life = (s = 60) => `activated_at = '${at(s)}', activated_by_ref = '${g.usr}', expires_at = '${at(s + 29 * DAY_S)}'`;
      const pendingExpired = () => { const d = pending();
        run(`UPDATE card_sync_devices SET status = 'expired', token_digest = NULL, closed_at = '${at(700)}', close_reason = 'pending-expired' WHERE id = ?`, d.id);
        return d; };
      probe(db, 'a pending-expired device revoked by the owner keeps all three NULL', {
        control: () => { const d = pendingExpired(); run("UPDATE card_sync_devices SET status = 'revoked', close_reason = 'owner' WHERE id = ?", d.id);
          const r = get('SELECT status, activated_at, activated_by_ref, expires_at, closed_at FROM card_sync_devices WHERE id = ?', d.id);
          if (r.status !== 'revoked' || r.activated_at !== null || r.activated_by_ref !== null || r.expires_at !== null || r.closed_at !== at(700)) {
            throw new Error(JSON.stringify(r));
          } },
        act: () => run(`UPDATE card_sync_devices SET status = 'revoked', close_reason = 'owner', ${life()} WHERE id = ?`, pendingExpired().id),
        expect: { trigger: 'a device keeps its identity and lifetime' } });
      for (const [field, value] of [['activated_at', at(60)], ['activated_by_ref', g.usr], ['expires_at', at(60 + 29 * DAY_S)]]) {
        probe(db, `a pending-expired device never gains ${field}`, {
          act: () => run(`UPDATE card_sync_devices SET status = 'revoked', close_reason = 'owner', ${field} = ? WHERE id = ?`, value, pendingExpired().id),
          expect: { trigger: 'a device keeps its identity and lifetime' } });
      }
      probe(db, 'a rejected pending device never gains a lifetime', {
        control: () => run(`UPDATE card_sync_devices SET status = 'revoked', token_digest = NULL, closed_at = '${at(90)}', close_reason = 'rejected' WHERE id = ?`, pending().id),
        act: () => run(`UPDATE card_sync_devices SET status = 'revoked', token_digest = NULL, closed_at = '${at(90)}', close_reason = 'rejected', ${life()} WHERE id = ?`, pending().id),
        expect: { trigger: 'a device keeps its identity and lifetime' } });
      probe(db, 'a pending device that expires never gains a lifetime', {
        control: () => run(`UPDATE card_sync_devices SET status = 'expired', token_digest = NULL, closed_at = '${at(700)}', close_reason = 'pending-expired' WHERE id = ?`, pending().id),
        act: () => run(`UPDATE card_sync_devices SET status = 'expired', token_digest = NULL, closed_at = '${at(700)}', close_reason = 'pending-expired', ${life()} WHERE id = ?`, pending().id),
        expect: { trigger: 'a device keeps its identity and lifetime' } });
      probe(db, 'pending → active initialises the lifetime once; it never moves afterwards', {
        control: () => run(`UPDATE card_sync_devices SET status = 'active', ${life()} WHERE id = ?`, pending().id),
        act: () => { const d = pending(); run(`UPDATE card_sync_devices SET status = 'active', ${life()} WHERE id = ?`, d.id);
          run(`UPDATE card_sync_devices SET expires_at = '${at(90 + 29 * DAY_S)}' WHERE id = ?`, d.id); },
        expect: { trigger: 'a device keeps its identity and lifetime' } });
      // the same NULL gap on pairings: redeemed_at is written by the redemption and by nothing else
      tprobe('trg_card_sync_pairings_inv_update', 'a pairing records a redemption only when it is redeemed', {
        control: () => run(`UPDATE card_sync_pairings SET status = 'cancelled', code_digest = NULL, closed_at = '${at(40)}' WHERE id = ?`, openPairing().id),
        act: () => run(`UPDATE card_sync_pairings SET status = 'cancelled', code_digest = NULL, closed_at = '${at(40)}', redeemed_at = '${at(30)}' WHERE id = ?`, openPairing().id) });
      probe(db, 'an open pairing that expires never gains a redemption time', {
        control: () => run(`UPDATE card_sync_pairings SET status = 'redeemed', code_digest = NULL, redeemed_at = '${at(30)}' WHERE id = ?`, openPairing().id),
        act: () => run(`UPDATE card_sync_pairings SET status = 'expired', code_digest = NULL, closed_at = '${at(301)}', redeemed_at = '${at(30)}' WHERE id = ?`, openPairing().id),
        expect: { trigger: 'a pairing records a redemption only when it is redeemed' } });
    }

    { // R1: an explicit off always moves the auto-sync revision, so an on read before it never applies after it
      const step = db.prepare(query('auto-sync-step'));
      const withdraw = db.prepare(query('withdraw-consent-of-binding'));
      const state = () => get('SELECT version, auto_sync_revision AS a FROM card_source_bindings WHERE id = ?', g.b);
      const on = (s, now) => step.run({ now, binding_id: g.b, enabled: 1, expected_version: s.version, expected_auto_sync_revision: s.a }).changes;
      probe(db, 'R1: an off with no consent moves the revision; the on read before it is refused', {
        control: () => {
          if (get('SELECT count(*) AS n FROM card_sync_device_scopes WHERE binding_id = ? AND auto_sync = 1', g.b).n !== 0) throw new Error('consent present');
          const seenByA = state();                                                        // window A reads, intending "on"
          const off = step.run({ now: at(2000), binding_id: g.b, enabled: 0, expected_version: null, expected_auto_sync_revision: null }).changes;
          const withdrawn = withdraw.run({ binding_id: g.b }).changes;                    // window B's off: nothing to withdraw
          const after = state();
          if (off !== 1 || withdrawn !== 0 || after.a !== seenByA.a + 1 || after.version !== seenByA.version) throw new Error(`off ${off}/${withdrawn}`);
          if (on(seenByA, at(2001)) !== 0) throw new Error('a stale on applied after the off');
          if (on(after, at(2002)) !== 1) throw new Error('a current on was refused');
          const retired = fresh('card_source_bindings');                                  // an off on a retired binding changes nothing
          if (step.run({ now: at(2003), binding_id: retired.id, enabled: 0, expected_version: null, expected_auto_sync_revision: null }).changes !== 0) {
            throw new Error('a retired binding moved');
          } },
        act: () => run('UPDATE card_source_bindings SET auto_sync_revision = auto_sync_revision + 1 WHERE id = ?', fresh('card_source_bindings').id),
        expect: { trigger: 'a retired binding never changes' } });
      inSavepoint(db, () => {                                                           // revision 5's rule, for contrast: the race R1 closes
        const seenByA = state();
        withdraw.run({ binding_id: g.b });                                                // an off that only withdraws, and finds nothing
        if (on(seenByA, at(2001)) === 1) { results.behaviour += 1; note('R1: without the step, an on read before an empty off still applied after it; with it, refused'); }
        else fail('R1 contrast', 'the stale on was refused even without the step');
      });
    }

    { // R7: owner reads in pages, keyset-ordered by immutable keys, every page from an index without a sort
      const explain = (name, expected) => {
        const sql = query(name);
        const params = Object.fromEntries([...sql.matchAll(/:(\w+)/g)].map((m) => [m[1], null]));
        const details = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params).map((r) => r.detail);
        const bad = details.filter((d) => /^SCAN |TEMP B-TREE/.test(d));
        const missing = expected.filter((ix) => !details.some((d) => d.includes(ix)));
        if (bad.length || missing.length) fail(`R7 plan ${name}`, JSON.stringify(details));
        else { results.behaviour += 1; note(`${name}: ${details.filter((d) => /SEARCH/.test(d)).join(' | ')}`); }
      };
      tprobe('trg_card_sync_plan_actions_inv_prepared', 'a plan holds only the actions it declares', {
        control: () => { const p = plan({ action_count: 2, count_insert: 2 }); insertRow(db, 'card_sync_plan_actions', actionRow(g, { plan_id: p.id, ordinal: 1 })); },
        act: () => { const p = plan({ action_count: 2, count_insert: 2 }); insertRow(db, 'card_sync_plan_actions', actionRow(g, { plan_id: p.id, ordinal: 2 })); } });
      explain('set-items-page', ['idx_card_source_observations_ordinal', 'idx_card_reconciliation_suggestions_observation']);
      explain('set-level-item', ['idx_card_reconciliation_suggestions_set_level']);
      explain('plan-effects-page', ['sqlite_autoindex_card_sync_plan_actions_1']);
      explain('transaction-history-page', ['idx_card_transaction_events_history', 'idx_card_transaction_events_moved_away']);

      inSavepoint(db, () => {                                                           // items: set-level first, then rows by ordinal
        const s = setOf({ row_count: 9, open_count: 9 });
        const os = []; for (let k = 0; k < 9; k += 1) os.push(obs({ observation_set_id: s.id, ordinal: k }));
        const want = [item({ observation_set_id: s.id, ...setLevel }).id];
        for (const k of [0, 2, 3, 5, 6, 8]) want.push(item({ observation_set_id: s.id, observation_id: os[k].id }).id);
        item({ observation_set_id: s.id, observation_id: os[4].id, status: 'superseded' });   // needs no person: not listed
        const page = db.prepare(query('set-items-page'));
        const level = db.prepare(query('set-level-item')).all({ set_id: s.id });
        const got = level.map((r) => r.item_id); let after = -1;
        for (;;) {
          const rows = page.all({ set_id: s.id, after_key: after, limit: 2 });
          got.push(...rows.map((r) => r.item_id));
          if (rows.length < 2) break;
          after = rows[rows.length - 1].item_key;
        }
        if (JSON.stringify(got) === JSON.stringify(want)) { results.behaviour += 1; note('R7 items: 7 items in pages of 2, set-level first, ordinal order, superseded not listed'); }
        else fail('R7 items', `${JSON.stringify(got)} != ${JSON.stringify(want)}`);
      });
      inSavepoint(db, () => {                                                           // effects: every action but `unchanged`, by ordinal
        const p = plan({ action_count: 7, count_insert: 4, count_unchanged: 3 });
        const ops = ['insert', 'unchanged', 'insert', 'unchanged', 'unchanged', 'insert', 'insert'];
        ops.forEach((op, k) => insertRow(db, 'card_sync_plan_actions', actionRow(g, { plan_id: p.id, ordinal: k, op,
          ...(op === 'unchanged' ? { transaction_id: g.t4, expected_revision: 1, scope_id: null, identity_count: 0 } : {}) })));
        const page = db.prepare(query('plan-effects-page'));
        const got = []; let after = -1;
        for (;;) {
          const rows = page.all({ plan_id: p.id, after_ordinal: after, limit: 2 });
          got.push(...rows.map((r) => r.ordinal));
          if (rows.length < 2) break;
          after = rows[rows.length - 1].ordinal;
        }
        const frozen = attempt(() => insertRow(db, 'card_sync_plan_actions', actionRow(g, { plan_id: p.id, ordinal: 7 })));
        if (JSON.stringify(got) === '[0,2,5,6]' && frozen && /holds only the actions it declares/.test(frozen.message)) {
          results.behaviour += 1; note('R7 effects: 4 of 7 actions in pages of 2 (unchanged ones only counted); the stored list cannot grow');
        } else fail('R7 effects', `${JSON.stringify(got)}, append ${describe(frozen)}`);
      });
      inSavepoint(db, () => {                                                           // history: newest first, aliases that left included
        const T = txn(); const S = txn(); const R = txn();
        const ev = (o) => { const e = baseEvent(g, { edit_fields: 0, ...o }); insertRow(db, 'card_transaction_events', e); return e.id; };
        const edit = (tid, s) => ev({ card_transaction_id: tid, created_at: at(s), event_type: 'user-edited', reason: 'user-edit', edit_fields: 1 });
        const moved = (from, to, s) => ev({ card_transaction_id: to, created_at: at(s), event_type: 'identity-repointed', reason: 'maintenance',
          identity_id: identityFor(to).id, from_canonical_id: from, to_canonical_id: to });
        const e1 = edit(T.id, 100); const e2 = edit(T.id, 200); const inT = moved(R.id, T.id, 250); const away = moved(T.id, S.id, 300);
        const e3 = edit(T.id, 400); edit(S.id, 500); moved(R.id, S.id, 600);              // S's own history is not T's
        const page = db.prepare(query('transaction-history-page'));
        const got = []; let before = { c: '9999-12-31T23:59:59.999Z', i: 'card-event-q' };
        for (;;) {
          const rows = page.all({ transaction_id: T.id, before_created_at: before.c, before_id: before.i, limit: 2 });
          got.push(...rows.map((r) => r.id));
          if (rows.length < 2) break;
          before = { c: rows[rows.length - 1].created_at, i: rows[rows.length - 1].id };
        }
        const want = [e3, away, inT, e2, e1];
        if (JSON.stringify(got) === JSON.stringify(want)) { results.behaviour += 1; note('§3.8 history: 5 events in pages of 2, newest first, the alias that left included'); }
        else fail('§3.8 history', `${JSON.stringify(got)} != ${JSON.stringify(want)}`);
      });
    }

    { // §3.8 revert: the one event `revert` accepts is defined by the marker; reverting it makes the previous change current
      inSavepoint(db, () => {
        const ev = (o) => { const e = baseEvent(g, { edit_fields: 0, ...o }); insertRow(db, 'card_transaction_events', e); return e.id; };
        const vals = { from_amount_minor: 1234, to_amount_minor: 1300, from_transaction_date: '2026-10-01', to_transaction_date: '2026-10-01',
          from_kind: 'purchase', to_kind: 'purchase' };
        const t = txn({ status: 'pending', posted_date: null });
        upd(t.id, `status = 'posted', posted_date = '2026-10-04', amount_minor = 1300, ${MARK}`);     // a compound match: promote + attribute
        const promotedEv = ev({ card_transaction_id: t.id, transaction_revision: 2, event_type: 'promoted', reason: 'same-transaction',
          from_status: 'pending', to_status: 'posted', ...vals });
        ev({ card_transaction_id: t.id, transaction_revision: 2, event_type: 'attributed', reason: 'attribution', from_scope_id: g.u1, to_scope_id: g.k1 });
        const revertible = db.prepare(query('revertible-event'));
        const now = () => revertible.get({ transaction_id: t.id })?.event_id ?? null;
        const seen = [now()];
        upd(t.id, `amount_minor = 1400, ${MARK}`);                                                   // a session correction
        const correctedEv = ev({ card_transaction_id: t.id, transaction_revision: 3, event_type: 'corrected', reason: 'posted-correction',
          from_status: 'posted', to_status: 'posted', ...vals, from_amount_minor: 1300, to_amount_minor: 1400 });
        seen.push(now());
        upd(t.id, "user_category = 'Dining'"); seen.push(now());                                      // a category edit carries the marker
        upd(t.id, 'amount_minor = 1300, reversal_snapshot_revision = 1');                             // revertCardTransactionChange(correctedEv)
        ev({ card_transaction_id: t.id, transaction_revision: 5, event_type: 'reversed', reason: 'maintenance', reverses_event_id: correctedEv,
          from_status: 'posted', to_status: 'posted' });
        seen.push(now());
        upd(t.id, 'amount_minor = 1500, reversal_snapshot_revision = NULL'); seen.push(now());       // an issuer change clears it
        const want = [promotedEv, correctedEv, correctedEv, promotedEv, null];
        if (JSON.stringify(seen) === JSON.stringify(want)) { results.behaviour += 1; note('§3.8 revertibleEventId: promoted, corrected, corrected after a category edit, promoted again after the revert, none after an issuer change'); }
        else fail('§3.8 revertible', JSON.stringify(seen));
      });
      // the ledger-maintenance audit row names the maintenance event that records rows, alias and revisions
      const audit = (o) => insertRow(db, 'card_sync_audit_events', { id: id('card-audit-'), event_type: 'ledger-maintenance', actor_kind: 'session',
        actor_ref: g.usr, card_account_id: g.a1, code: 'revert', version_before: 3, version_after: 4, created_at: at(900), ...o });
      probe(db, '§3.8 audit: a ledger-maintenance row names its maintenance event', {
        control: () => audit({ ledger_event_id: g.e1 }),
        act: () => audit({}),
        expect: { check: 'ck_aud_ledger_event' } });
    }

    // ------------------------------------------------------------------ Revision 7: round-6 findings
    section('revision 7');
    { // finding 1: every transaction that changes a set's listed items moves its version; a later page is refused, never short
      const touch = db.prepare(query('touch-set'));
      const levelQ = db.prepare(query('set-level-item'));
      const pageQ = db.prepare(query('set-items-page'));
      // getCardSyncObservationSetPage as §5.5 specifies it: the pins are compared and the page read in one read transaction
      const readPage = (setId, after, now, limit = 100) => db.transaction(() => {
        const s = get('SELECT version, expires_at, card_account_id FROM card_sync_observation_sets WHERE id = ?', setId);
        if (!s) return { error: 'not-found' };
        const ledgerRevision = get('SELECT ledger_revision AS l FROM card_accounts WHERE id = ?', s.card_account_id).l;
        const pastDeadline = now >= s.expires_at;
        if (after && (after.version !== s.version || after.ledgerRevision !== ledgerRevision || after.pastDeadline !== pastDeadline)) {
          return { error: 'page-stale' };
        }
        const level = after ? [] : levelQ.all({ set_id: setId });
        const rows = pageQ.all({ set_id: setId, after_key: after ? after.itemKey : -1, limit: limit - level.length });
        const items = [...level, ...rows];
        return { keys: items.map((r) => r.item_key),
          next: items.length === limit ? { version: s.version, ledgerRevision, pastDeadline, itemKey: items.at(-1).item_key } : null };
      })();
      const walk = (setId, now) => { const keys = []; let after = null;
        for (;;) { const p = readPage(setId, after, now); if (p.error) return p.error; keys.push(...p.keys); if (!p.next) return keys; after = p.next; } };
      const AFTER = at(31 * DAY_S);                                                    // reads after the set's deadline (accepted + 30 days)
      const dueSet = () => {                                                           // the reviewer's 250 items, past the deadline
        const s = setOf({ row_count: 250, open_count: 250 });
        const os = [];
        for (let k = 0; k < 250; k += 1) {
          const o = obs({ observation_set_id: s.id, ordinal: k }); os.push(o.id);
          insertRow(db, 'card_reconciliation_suggestions', itemRow(g, { observation_set_id: s.id, observation_id: o.id }));
        }
        return { s, os };
      };
      const expireChunk = (d, from, to, withTouch = true) => {                         // retention phase 3, one chunk
        const ids = JSON.stringify(d.os.slice(from, to));
        run("UPDATE card_source_observations SET state = 'expired', resolved_at = ? WHERE id IN (SELECT value FROM json_each(?))", AFTER, ids);
        run(`UPDATE card_reconciliation_suggestions SET status = 'expired', draft_action = NULL, draft_transaction_id = NULL, draft_scope_id = NULL,
          drafted_by_ref = NULL, drafted_at = NULL, updated_at = ? WHERE observation_id IN (SELECT value FROM json_each(?)) AND status IN ('open', 'decided')`, AFTER, ids);
        if (withTouch) touch.run({ set_id: d.s.id });
      };
      const closeExpired = (d) => run(`UPDATE card_sync_observation_sets SET state = 'expired-unreviewed', closed_at = ?, close_reason = 'expired',
        expired_count = expired_count + open_count, open_count = 0, version = version + 1 WHERE id = ?`, AFTER, d.s.id);
      const purgeChunk = (d, from, to, withTouch = true) => {                          // retention phase 5, one chunk
        run('DELETE FROM card_source_observations WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(d.os.slice(from, to)));
        if (withTouch) touch.run({ set_id: d.s.id });
      };
      const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
      inSavepoint(db, () => {
        const d = dueSet();
        const first = readPage(d.s.id, null, AFTER);
        expireChunk(d, 100, 200);                                                      // an expiry chunk between two pages
        const afterExpiry = readPage(d.s.id, first.next, AFTER);
        const whole = walk(d.s.id, AFTER);                                             // the client starts over
        expireChunk(d, 0, 100); expireChunk(d, 200, 250); closeExpired(d);
        const second = readPage(d.s.id, null, AFTER);
        purgeChunk(d, 100, 200);                                                       // a purge chunk between two pages
        const afterPurge = readPage(d.s.id, second.next, AFTER);
        const rest = walk(d.s.id, AFTER);
        const ok = JSON.stringify(first.keys) === JSON.stringify(range(0, 100)) && afterExpiry.error === 'page-stale'
          && JSON.stringify(whole) === JSON.stringify(range(0, 250)) && afterPurge.error === 'page-stale'
          && JSON.stringify(rest) === JSON.stringify([...range(0, 100), ...range(200, 250)]);
        if (ok) { results.behaviour += 1; note('finding 1: page, expiry chunk, page → page-stale (409), the restarted walk has all 250; page, purge chunk, page → page-stale; never a short walk'); }
        else fail('finding 1', JSON.stringify({ afterExpiry, afterPurge, whole: whole.length, rest: rest.length }));
      });
      inSavepoint(db, () => {                                                          // round 6's repro: without the touch, keys vanish
        const d = dueSet(); expireChunk(d, 0, 250, false); closeExpired(d);
        const first = readPage(d.s.id, null, AFTER);
        purgeChunk(d, 100, 200, false);
        const second = readPage(d.s.id, first.next, AFTER);
        if (!second.error && second.keys[0] === 200) { results.behaviour += 1; note('finding 1 contrast: Revision 6\'s purge without touch-set: page 2 returns 200–249 under the old pins (keys 100–199 silently skipped)'); }
        else fail('finding 1 contrast', JSON.stringify(second).slice(0, 200));
      });
      inSavepoint(db, () => {                                                          // the deadline passes between two pages
        const d = dueSet();
        const before = readPage(d.s.id, null, at(29 * DAY_S));
        const later = readPage(d.s.id, before.next, AFTER);
        const steady = readPage(d.s.id, readPage(d.s.id, null, AFTER).next, AFTER);
        if (later.error === 'page-stale' && !steady.error && steady.keys[0] === 100) { results.behaviour += 1; note('finding 1: a walk across the deadline → page-stale; an unchanged set pages on'); }
        else fail('finding 1 deadline', JSON.stringify({ later, steady: steady.keys?.[0] }));
      });
      probe(db, 'touch-set moves an expired or purged set\'s version by one', {
        control: () => { const s = setOf({ state: 'expired-unreviewed', closed_at: at(900), close_reason: 'expired' }); touch.run({ set_id: s.id }); },
        act: () => { const s = setOf({ state: 'expired-unreviewed', closed_at: at(900), close_reason: 'expired' });
          run('UPDATE card_sync_observation_sets SET version = version + 2 WHERE id = ?', s.id); },
        expect: { trigger: 'an observation set version grows by one per change' } });
    }

    { // finding 2: no immutable child row is deleted on its own, so none can be deleted and refilled; the parent's deletion cascades
      const filledPlan = () => { const p = plan({ action_count: 2, count_insert: 2 });
        for (const k of [0, 1]) insertRow(db, 'card_sync_plan_actions', actionRow(g, { plan_id: p.id, ordinal: k })); return p; };
      tprobe('trg_card_sync_plan_actions_inv_delete', 'plan actions are deleted only with their plan', {
        control: () => { const p = filledPlan(); closePlan(p.id); run('DELETE FROM card_sync_commit_plans WHERE id = ?', p.id);
          if (get('SELECT count(*) AS n FROM card_sync_plan_actions WHERE plan_id = ?', p.id).n !== 0) throw new Error('actions left'); },
        act: () => { const p = filledPlan();                                           // the reviewer's delete-and-refill at ordinal 0
          run('DELETE FROM card_sync_plan_actions WHERE plan_id = ? AND ordinal = 0', p.id);
          insertRow(db, 'card_sync_plan_actions', actionRow(g, { plan_id: p.id, ordinal: 0, scope_id: g.k2 })); } });
      probe(db, 'a consumed plan keeps its actions until the plan itself is deleted', {
        act: () => { const p = filledPlan(); closePlan(p.id); run('DELETE FROM card_sync_plan_actions WHERE plan_id = ?', p.id); },
        expect: { trigger: 'plan actions are deleted only with their plan' } });
      const scopeRow = (pairingId) => ({ id: id('card-pscope-'), pairing_id: pairingId, binding_id: g.b, binding_version: 1, mode: 'isolated-read',
        contract_version: 1 });
      const openWithScope = () => { const p = openPairing(); insertRow(db, 'card_sync_pairing_scopes', scopeRow(p.id)); return p; };
      tprobe('trg_card_sync_pairing_scopes_inv_delete', 'pairing scopes are deleted only with their pairing', {
        control: () => { const p = openWithScope();
          run(`UPDATE card_sync_pairings SET status = 'cancelled', code_digest = NULL, closed_at = '${at(40)}' WHERE id = ?`, p.id);
          run('DELETE FROM card_sync_pairings WHERE id = ?', p.id); },
        act: () => { const p = openWithScope(); run('DELETE FROM card_sync_pairing_scopes WHERE pairing_id = ?', p.id);
          insertRow(db, 'card_sync_pairing_scopes', { ...scopeRow(p.id), binding_id: fresh('card_source_bindings').id }); } });
      tprobe('trg_card_sync_pairing_scopes_inv_open', 'a pairing chooses its bindings while it is open', {
        control: () => openWithScope(),
        act: () => { const p = openWithScope();
          run(`UPDATE card_sync_pairings SET status = 'redeemed', code_digest = NULL, redeemed_at = '${at(30)}' WHERE id = ?`, p.id);
          insertRow(db, 'card_sync_pairing_scopes', { ...scopeRow(p.id), binding_id: fresh('card_source_bindings').id }); } });
      const withSecondary = () => { const st = setOf(); const o = obs({ observation_set_id: st.id, ordinal: 0 });
        insertRow(db, 'card_observation_secondary_ids', { id: id('card-obsid-'), observation_id: o.id, ordinal: 1, namespace: 'chase-api:derived:v1',
          namespace_kind: 'stable', id_hash: dig('xid1:') }); return o; };
      tprobe('trg_card_observation_secondary_ids_inv_delete', 'secondary ids are deleted only with their observation', {
        control: () => run('DELETE FROM card_source_observations WHERE id = ?', withSecondary().id),
        act: () => run('DELETE FROM card_observation_secondary_ids WHERE observation_id = ?', withSecondary().id) });
      const closedWithHint = () => { const st = setOf({ state: 'expired-unreviewed', closed_at: at(900), close_reason: 'expired', content_purged_at: at(901) });
        insertRow(db, 'card_sync_set_card_hints', { observation_set_id: st.id, origin: 'extension', ordinal: 0, last4: '1234' }); return st; };
      tprobe('trg_card_sync_set_card_hints_inv_delete', 'card hints are deleted only with their set', {
        control: () => run('DELETE FROM card_sync_observation_sets WHERE id = ?', closedWithHint().id),
        act: () => run('DELETE FROM card_sync_set_card_hints WHERE observation_set_id = ?', closedWithHint().id) });
      const rowItem = () => { const st = setOf(); const o = obs({ observation_set_id: st.id, ordinal: 0 });
        const it = itemRow(g, { observation_set_id: st.id, observation_id: o.id }); insertRow(db, 'card_reconciliation_suggestions', it); return { o, it }; };
      tprobe('trg_card_reconciliation_suggestions_inv_delete', 'a review item is deleted only with its row or its purged set', {
        control: () => run('DELETE FROM card_source_observations WHERE id = ?', rowItem().o.id),         // the row goes, its item with it
        act: () => { const { it } = rowItem(); run('DELETE FROM card_reconciliation_suggestions WHERE id = ?', it.id);
          insertRow(db, 'card_reconciliation_suggestions', { ...it, id: id('rvw_'), status: 'superseded' }); } });
      probe(db, 'a set-level item is deleted only once its set is purged', {
        control: () => { const st = setOf({ state: 'expired-unreviewed', closed_at: at(900), close_reason: 'expired', content_purged_at: at(901) });
          insertRow(db, 'card_reconciliation_suggestions', itemRow(g, { observation_set_id: st.id, ...setLevel, status: 'expired' }));
          run('DELETE FROM card_reconciliation_suggestions WHERE observation_set_id = ?', st.id); },
        act: () => { const st = setOf(); insertRow(db, 'card_reconciliation_suggestions', itemRow(g, { observation_set_id: st.id, ...setLevel }));
          run('DELETE FROM card_reconciliation_suggestions WHERE observation_set_id = ?', st.id); },
        expect: { trigger: 'a review item is deleted only with its row or its purged set' } });
      const receiptOf = (sid, json = '{"a":1}') => insertRow(db, 'card_sync_payload_receipts', { observation_set_id: sid, payload_digest: dig('pd1:'),
        canonical_json: json, byte_length: json.length, accepted_at: at(), expires_at: at(7 * DAY_S) });
      const kept = () => { const st = setOf(); receiptOf(st.id); return st; };
      tprobe('trg_card_sync_payload_receipts_inv_delete', 'a receipt is deleted only after its set gave it up', {
        control: () => { const st = kept(); bumpSet(st.id, "receipt_state = 'expired'"); run('DELETE FROM card_sync_payload_receipts WHERE observation_set_id = ?', st.id); },
        act: () => { const st = kept(); run('DELETE FROM card_sync_payload_receipts WHERE observation_set_id = ?', st.id); receiptOf(st.id, '{"b":2}'); } });
      tprobe('trg_card_sync_payload_receipts_inv_kept', 'a receipt is written only for a set that keeps one', {
        control: () => kept(),
        act: () => { const st = kept(); bumpSet(st.id, "receipt_state = 'deleted'");
          run('DELETE FROM card_sync_payload_receipts WHERE observation_set_id = ?', st.id); receiptOf(st.id, '{"b":2}'); } });
      const auditRow = (o) => { const r = { id: id('card-audit-'), event_type: 'policy-changed', actor_kind: 'session', actor_ref: g.usr,
        created_at: at(), ...o }; insertRow(db, 'card_sync_audit_events', r); return r; };
      const cutoff = (t) => auditRow({ event_type: 'retention-completed', actor_kind: 'system', actor_ref: null, code: 'audit-cutoff', created_at: t });
      tprobe('trg_card_sync_audit_events_inv_delete', 'audit rows are deleted only by retention, 365 days after them', {
        control: () => { const old = auditRow({ created_at: at(-400 * DAY_S) }); cutoff(at(0)); run('DELETE FROM card_sync_audit_events WHERE id = ?', old.id); },
        act: () => { const young = auditRow({ created_at: at(-300 * DAY_S) }); cutoff(at(0));
          run('DELETE FROM card_sync_audit_events WHERE id = ?', young.id); } });
    }

    { // finding 3: an action that only records new aliases is `alias`: listed as an effect and counted apart from `unchanged`
      probe(db, '`unchanged` records no alias; `alias` records at least one', {
        control: () => { const p = plan({ action_count: 2, count_insert: 0, count_unchanged: 1, count_aliased: 1 });
          insertRow(db, 'card_sync_plan_actions', actionRow(g, { plan_id: p.id, ordinal: 0, op: 'unchanged', transaction_id: g.t4, expected_revision: 1,
            scope_id: null, identity_count: 0 }));
          insertRow(db, 'card_sync_plan_actions', actionRow(g, { plan_id: p.id, ordinal: 1, op: 'alias', transaction_id: g.t4, expected_revision: 1,
            scope_id: null, identity_count: 1 })); },
        act: () => insertRow(db, 'card_sync_plan_actions', actionRow(g, { op: 'unchanged', transaction_id: g.t4, expected_revision: 1, scope_id: null,
          identity_count: 1 })),                                                       // round 6's overloaded row
        expect: { check: 'ck_act_op_unchanged' } });
      inSavepoint(db, () => {
        const p = plan({ action_count: 3, count_insert: 1, count_unchanged: 1, count_aliased: 1 });
        insertRow(db, 'card_sync_plan_actions', actionRow(g, { plan_id: p.id, ordinal: 0 }));
        insertRow(db, 'card_sync_plan_actions', actionRow(g, { plan_id: p.id, ordinal: 1, op: 'unchanged', transaction_id: g.t4, expected_revision: 1,
          scope_id: null, identity_count: 0 }));
        insertRow(db, 'card_sync_plan_actions', actionRow(g, { plan_id: p.id, ordinal: 2, op: 'alias', transaction_id: g.t4, expected_revision: 1,
          scope_id: null, identity_count: 2 }));
        const got = db.prepare(query('plan-effects-page')).all({ plan_id: p.id, after_ordinal: -1, limit: 500 }).map((r) => `${r.ordinal}:${r.op}`);
        const row = get('SELECT action_count - count_unchanged AS effects FROM card_sync_commit_plans WHERE id = ?', p.id);
        if (JSON.stringify(got) === '["0:insert","2:alias"]' && row.effects === got.length) {
          results.behaviour += 1; note('finding 3: a page with a pure unchanged row and an alias row lists the alias, not the unchanged; effectCount = action_count − count_unchanged = 2');
        } else fail('finding 3', `${JSON.stringify(got)} / ${row.effects}`);
      });
    }

    { // finding 4: a row's bank values at a revision: the first snapshot at or after it, else the current row, never field by field
      inSavepoint(db, () => {
        const at4 = db.prepare(query('values-at-revision'));
        const t = txn();                                                               // revision 1, 1234
        const v = (r) => { const x = at4.get({ transaction_id: t.id, revision: r }); return `${x.from_current ? 'row' : 'snap'}:${x.amount_minor}`; };
        const seen = [];
        upd(t.id, "notes = 'paid in cash'"); seen.push(v(1));                           // revision 2: notes only, no snapshot
        upd(t.id, "user_category = 'Dining'"); seen.push(v(1));                         // revision 3: category only
        upd(t.id, 'amount_minor = 1300'); seen.push(v(1), v(3), v(4));                  // revision 4: a tracked change, snapshot at 3
        upd(t.id, 'amount_minor = 1400'); seen.push(v(1), v(4), v(5));                  // revision 5: snapshot at 4
        const want = ['row:1234', 'row:1234', 'snap:1234', 'snap:1234', 'row:1300', 'snap:1234', 'snap:1300', 'row:1400'];
        if (JSON.stringify(seen) === JSON.stringify(want)) { results.behaviour += 1; note('finding 4: values at revision 1 after notes-only and category-only edits are the current row; after tracked changes, the first snapshot at or after it'); }
        else fail('finding 4', JSON.stringify(seen));
      });
    }

    { // finding 5: history pages are live keyset pages: every event present when the walk began appears exactly once
      inSavepoint(db, () => {
        const T = txn(); const C = at(600); const e = (suffix, o = {}) => { const evId = 'card-event-' + suffix.repeat(32);
          insertRow(db, 'card_transaction_events', baseEvent(g, { id: evId, card_transaction_id: T.id, created_at: C, ...o })); return evId; };
        const p = e('p'); const n = e('n'); const b = e('b'); const older = e('k', { created_at: at(500) });
        const page = db.prepare(query('transaction-history-page'));
        const read = (before, limit = 2) => page.all({ transaction_id: T.id, before_created_at: before.c, before_id: before.i, limit });
        const got = []; let before = { c: '9999-12-31T23:59:59.999Z', i: 'card-event-q' };
        const first = read(before); got.push(...first.map((r) => r.id)); before = { c: first.at(-1).created_at, i: first.at(-1).id };
        const m = e('m');                                                              // a tie below the cursor: a later page shows it
        const o = e('o');                                                              // a tie above the cursor: this walk never shows it
        const back = e('d', { created_at: at(550) });                                  // the clock went back: a later page shows it
        for (;;) { const rows = read(before); got.push(...rows.map((r) => r.id)); if (rows.length < 2) break; before = { c: rows.at(-1).created_at, i: rows.at(-1).id }; }
        const once = [p, n, b, older].every((x) => got.filter((y) => y === x).length === 1);
        if (once && got.includes(m) && got.includes(back) && !got.includes(o) && new Set(got).size === got.length) {
          results.behaviour += 1; note('finding 5: equal timestamps and a clock step back: every event present at the start once; ties below the cursor and backdated events appear later, a tie above it only on a fresh read');
        } else fail('finding 5', JSON.stringify(got.map((x) => x.slice(11, 12))));
      });
    }

    { // section 3.8: aliases and merged rows in keyset pages from their own indexes
      const explain = (name, expected) => {
        const sql = query(name);
        const params = Object.fromEntries([...sql.matchAll(/:(\w+)/g)].map((m) => [m[1], null]));
        const details = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params).map((r) => r.detail);
        const coroutines = details.filter((d) => d.startsWith('CO-ROUTINE ')).map((d) => d.split(' ')[1]);   // a ≤ 1-row subquery, not a table
        const scans = details.filter((d) => /^SCAN /.test(d) && !coroutines.includes(d.split(' ')[1]));
        if (scans.length || details.some((d) => /TEMP B-TREE/.test(d)) || expected.some((ix) => !details.some((d) => d.includes(ix)))) fail(`plan ${name}`, JSON.stringify(details));
        else { results.behaviour += 1; note(`${name}: ${details.filter((d) => /SEARCH/.test(d)).join(' | ')}`); }
      };
      explain('transaction-aliases-page', ['idx_card_source_identities_page']);
      explain('transaction-merged-page', ['idx_card_transactions_merged']);
      explain('values-at-revision', ['sqlite_autoindex_card_transaction_versions_1', 'sqlite_autoindex_card_transactions_1']);
      inSavepoint(db, () => {
        const T = txn(); const made = [];
        for (let k = 0; k < 5; k += 1) made.push(identityFor(T.id, { created_at: at(100 + k) }).id);
        const page = db.prepare(query('transaction-aliases-page'));
        const got = []; let after = { c: '', i: '' };
        for (;;) { const rows = page.all({ transaction_id: T.id, after_created_at: after.c, after_id: after.i, limit: 2 });
          got.push(...rows.map((r) => r.identity_id)); if (rows.length < 2) break; after = { c: rows.at(-1).created_at, i: rows.at(-1).identity_id }; }
        if (JSON.stringify(got) === JSON.stringify(made)) { results.behaviour += 1; note('§3.8 aliases: 5 aliases in pages of 2, oldest first'); }
        else fail('§3.8 aliases', JSON.stringify(got));
      });
    }

    // ------------------------------------------------------------------ Revision 8: round-7 findings
    section('revision 8');
    const AUDIT_BASE = (() => {                                                       // seconds from T0, two days before any seed audit row
      const first = get('SELECT min(created_at) AS m FROM card_sync_audit_events').m ?? at(0);
      if (get("SELECT count(*) AS n FROM card_sync_audit_events WHERE code = 'audit-cutoff'").n !== 0) fail('revision 8 audit base', 'a cutoff in the seed');
      return Math.min(0, Math.floor((Date.parse(first) - T0) / 1000)) - 2 * DAY_S;
    })();
    { // finding 1: one audit horizon per call, derived from the reused cutoff and clamped to the clock
      const ts = (seconds) => at(seconds);
      const refresh = db.prepare(query('audit-cutoff-refresh'));
      const chunk = db.prepare(query('audit-delete-chunk'));
      const ahead = db.prepare(query('audit-cutoff-ahead')).pluck();
      const auditRow = (o) => { const r = { id: id('card-audit-'), event_type: 'policy-changed', actor_kind: 'session', actor_ref: g.usr,
        created_at: at(), ...o }; insertRow(db, 'card_sync_audit_events', r); return r; };
      const cutoff = (t, o = {}) => auditRow({ event_type: 'retention-completed', actor_kind: 'system', actor_ref: null, code: 'audit-cutoff',
        created_at: t, ...o });
      const phase7 = (now) => {                                                        // §5.9: refresh once, then chunks
        const wrote = refresh.run({ id: id('card-audit-'), now }).changes;
        let deleted = 0; for (;;) { const n = chunk.run({ now }).changes; deleted += n; if (n < 100) break; }
        return { wrote, deleted, ahead: ahead.get({ now }) };
      };
      const alive = (r) => Boolean(get('SELECT 1 AS x FROM card_sync_audit_events WHERE id = ?', r.id));
      const T = AUDIT_BASE;
      inSavepoint(db, () => {                                                          // the clock advances between calls
        const r1 = auditRow({ created_at: ts(T - 365 * DAY_S - 3600) });
        const r2 = auditRow({ created_at: ts(T - 365 * DAY_S + 6 * 3600) });
        const r3 = auditRow({ created_at: ts(T - 365 * DAY_S + 12 * 3600) });
        const r4 = auditRow({ created_at: ts(T - 300 * DAY_S) });
        const c1 = phase7(ts(T));
        const s1 = [r1, r2, r3, r4].map(alive);
        const c2 = phase7(ts(T + 12 * 3600));                                           // the cutoff is 12 hours old: reused
        const s2 = [r1, r2, r3, r4].map(alive);
        const c3 = phase7(ts(T + 25 * 3600));                                           // a day old: refreshed
        const s3 = [r1, r2, r3, r4].map(alive);
        const cutoffs = get("SELECT count(*) AS n FROM card_sync_audit_events WHERE code = 'audit-cutoff'").n;
        const want = JSON.stringify([[1, 1, 0], [false, true, true, true], [0, 0, 0], [false, true, true, true], [1, 2, 0], [false, false, false, true], 2]);
        const seen = JSON.stringify([[c1.wrote, c1.deleted, c1.ahead], s1, [c2.wrote, c2.deleted, c2.ahead], s2, [c3.wrote, c3.deleted, c3.ahead], s3, cutoffs]);
        if (seen === want) { results.behaviour += 1; note('finding 1: audit rows due between calls: at T one cutoff and one deletion; at T + 12 h (cutoff reused) nothing selected, nothing refused; at T + 25 h a fresh cutoff and the next two'); }
        else fail('finding 1 audit horizon', seen);
      });
      probe(db, "the reviewer's repro: a row exactly 365 days old and a 12-hour-old cutoff", {
        control: () => { const r = auditRow({ created_at: ts(T - 365 * DAY_S) }); cutoff(ts(T - 12 * 3600));
          const c = phase7(ts(T));                                                      // one horizon: the row waits, nothing is refused
          if (c.wrote !== 0 || c.deleted !== 0 || !alive(r)) throw new Error(JSON.stringify(c)); },
        act: () => { auditRow({ created_at: ts(T - 365 * DAY_S) }); cutoff(ts(T - 12 * 3600));
          run('DELETE FROM card_sync_audit_events WHERE created_at <= ?', ts(T - 365 * DAY_S)); },   // revision 7: selected by the clock
        expect: { trigger: 'audit rows are deleted only by retention, 365 days after them' } });
    }

    { // finding 2: the cutoff is validated control state: system cutoff rows only, clamped to the clock, never blocking a write
      const chunk = db.prepare(query('audit-delete-chunk'));
      const refresh = db.prepare(query('audit-cutoff-refresh'));
      const ahead = db.prepare(query('audit-cutoff-ahead')).pluck();
      const auditRow = (o) => { const r = { id: id('card-audit-'), event_type: 'policy-changed', actor_kind: 'session', actor_ref: g.usr,
        created_at: at(), ...o }; insertRow(db, 'card_sync_audit_events', r); return r; };
      const sys = (t, code) => auditRow({ event_type: 'retention-completed', actor_kind: 'system', actor_ref: null, code, created_at: t });
      const alive = (r) => Boolean(get('SELECT 1 AS x FROM card_sync_audit_events WHERE id = ?', r.id));
      const T = AUDIT_BASE;
      probe(db, 'only a system audit-cutoff row authorizes an audit deletion', {
        control: () => { const old = auditRow({ created_at: at(T - 400 * DAY_S) }); sys(at(T), 'audit-cutoff');
          run('DELETE FROM card_sync_audit_events WHERE id = ?', old.id); },
        act: () => { const old = auditRow({ created_at: at(T - 400 * DAY_S) }); sys(at(T), 'phase-summary');
          run('DELETE FROM card_sync_audit_events WHERE id = ?', old.id); },
        expect: { trigger: 'audit rows are deleted only by retention, 365 days after them' } });
      probe(db, 'a session row never carries the cutoff code', {
        control: () => sys(at(T), 'audit-cutoff'),
        act: () => auditRow({ created_at: at(T), code: 'audit-cutoff' }),
        expect: { check: 'ck_aud_cutoff_shape' } });
      inSavepoint(db, () => {
        const old = auditRow({ created_at: at(T - 400 * DAY_S) });
        const young = auditRow({ created_at: at(T - 300 * DAY_S) });
        sys(at(T + 400 * DAY_S), 'audit-cutoff');                                      // forged, or written before the clock stepped back
        const current = auditRow({ created_at: at(T) });                               // nothing blocks a current write
        const corrective = sys(at(T), 'audit-cutoff');
        const before = { wrote: refresh.run({ id: id('card-audit-'), now: at(T) }).changes, ahead: ahead.get({ now: at(T) }) };
        let deleted = 0; for (;;) { const n = chunk.run({ now: at(T) }).changes; deleted += n; if (n < 100) break; }
        const kept = [old, young, current, corrective].map(alive);
        // the trust boundary, executed: with the marker, a direct DELETE of a 200-day-old row passes the trigger (a SQL writer)
        const y2 = auditRow({ created_at: at(T - 200 * DAY_S) });
        run('DELETE FROM card_sync_audit_events WHERE id = ?', y2.id);
        const boundary = !alive(y2);
        const later = at(T + 402 * DAY_S);                                             // the clock passed the marker
        const after = { ahead: ahead.get({ now: later }), wrote: refresh.run({ id: id('card-audit-'), now: later }).changes };
        for (;;) { const n = chunk.run({ now: later }).changes; if (n < 100) break; }
        const youngGone = !alive(young);
        const seen = JSON.stringify([before, deleted, kept, boundary, after, youngGone]);
        const want = JSON.stringify([{ wrote: 0, ahead: 1 }, 1, [false, true, true, true], true, { ahead: 0, wrote: 1 }, true]);
        if (seen === want) { results.behaviour += 1; note('finding 2: a cutoff 400 days ahead: current and corrective inserts accepted; retention writes none, reports it and deletes only by its clock; after the clock passes it, a fresh cutoff; a SQL writer with the marker can still delete (the trust boundary)'); }
        else fail('finding 2 future cutoff', seen);
      });
    }

    { // finding 3: alias and merged-row lists are live membership: moved members may vanish, remerged rows may reappear
      inSavepoint(db, () => {
        const T = txn(); const S = txn();
        const a = [0, 1, 2].map((k) => identityFor(T.id, { created_at: at(100 + k) }).id);
        const incoming = identityFor(S.id, { created_at: at(150) }).id;                // on S when the walk begins
        const page = db.prepare(query('transaction-aliases-page'));
        const read = (after) => page.all({ transaction_id: T.id, after_created_at: after.c, after_id: after.i, limit: 2 });
        const got = []; let after = { c: '', i: '' };
        const first = read(after); got.push(...first.map((r) => r.identity_id)); after = { c: first.at(-1).created_at, i: first.at(-1).identity_id };
        run('UPDATE card_source_identities SET canonical_transaction_id = ? WHERE id = ?', S.id, a[2]);   // moved away before it was served
        run('UPDATE card_source_identities SET canonical_transaction_id = ? WHERE id = ?', T.id, incoming); // moved in, ahead of the cursor
        for (;;) { const rows = read(after); got.push(...rows.map((r) => r.identity_id)); if (rows.length < 2) break; after = { c: rows.at(-1).created_at, i: rows.at(-1).identity_id }; }
        const aliasesOk = JSON.stringify(got) === JSON.stringify([a[0], a[1], incoming]);
        const Y = txn(); const m1 = txn(); const m2 = txn();
        const mergeAt = (x, t) => upd(x.id, `${removeAs('posted', 'superseded').replace(at(800), t)}, merged_into_id = '${Y.id}'`);
        mergeAt(m1, at(800)); mergeAt(m2, at(850));
        const mpage = db.prepare(query('transaction-merged-page'));
        const mread = (after2) => mpage.all({ transaction_id: Y.id, after_removed_at: after2.c, after_id: after2.i, limit: 1 });
        const mgot = []; let mafter = { c: '', i: '' };
        const p1 = mread(mafter); mgot.push(...p1.map((r) => r.transaction_id)); mafter = { c: p1.at(-1).removed_at, i: p1.at(-1).transaction_id };
        upd(m1.id, "status = 'posted', removed_reason = NULL, removed_from_status = NULL, removed_at = NULL, merged_into_id = NULL");   // unmerged
        mergeAt(m1, at(900));                                                          // and merged again: a new key
        for (;;) { const rows = mread(mafter); mgot.push(...rows.map((r) => r.transaction_id)); if (rows.length < 1) break; mafter = { c: rows.at(-1).removed_at, i: rows.at(-1).transaction_id }; }
        const mergedOk = JSON.stringify(mgot) === JSON.stringify([m1.id, m2.id, m1.id]) && new Set(mgot).size === 2;
        if (aliasesOk && mergedOk) { results.behaviour += 1; note('finding 3: live lists: an alias moved away during the walk never appears and one moved in does; a remerged row appears twice (clients de-duplicate by id)'); }
        else fail('finding 3 live lists', JSON.stringify({ got, want: [...a, incoming], mgot }));
      });
    }

    { // the round-7 note: revocation and natural expiry keep the accepted receipt
      const withReceipt = () => {
        const d = device();
        const r = makeRun(db, g, { device_id: d.id, acceptance_state: 'accepted', payload_digest: dig('pd1:'), accepted_at: at(200), closed_at: at(200) });
        const sid = makeSet(db, g, { run_id: r, device_id: d.id });
        insertRow(db, 'card_sync_payload_receipts', { observation_set_id: sid, payload_digest: dig('pd1:'), canonical_json: '{"a":1}',
          byte_length: 7, accepted_at: at(200), expires_at: at(200 + 7 * DAY_S) });
        return { d, sid };
      };
      const revoke = (h) => {                                                         // revokeCardSyncDevice's statements (§5.3.1)
        run("UPDATE card_sync_devices SET status = 'revoked', token_digest = NULL, closed_at = ?, close_reason = 'owner' WHERE id = ?", at(70), h.d.id);
        db.prepare(query('revoke-grants-of-device')).run({ now: at(70), device_id: h.d.id });
        db.prepare(query('quarantine-sets-of-device')).run({ device_id: h.d.id });
        db.prepare(query('cancel-plans-of-device')).run({ now: at(70), device_id: h.d.id });
      };
      const expire = (h) => {                                                         // retention phase 2 (§5.9)
        run("UPDATE card_sync_devices SET status = 'expired', token_digest = NULL, closed_at = ?, close_reason = 'expired' WHERE id = ?", at(31 * DAY_S), h.d.id);
        db.prepare(query('revoke-grants-of-device')).run({ now: at(31 * DAY_S), device_id: h.d.id });
      };
      const kept = (h, state) => { const s = get('SELECT s.state, s.receipt_state, r.canonical_json AS j FROM card_sync_observation_sets s JOIN card_sync_payload_receipts r ON r.observation_set_id = s.id WHERE s.id = ?', h.sid);
        if (!s || s.receipt_state !== 'kept' || s.j !== '{"a":1}' || s.state !== state) throw new Error(`receipt not kept: ${JSON.stringify(s)}`); };
      probe(db, 'revocation keeps the accepted receipt', {
        control: () => { const h = withReceipt(); revoke(h); kept(h, 'blocked-review');
          bumpSet(h.sid, "receipt_state = 'expired'"); run('DELETE FROM card_sync_payload_receipts WHERE observation_set_id = ?', h.sid); },
        act: () => { const h = withReceipt(); revoke(h); run('DELETE FROM card_sync_payload_receipts WHERE observation_set_id = ?', h.sid); },
        expect: { trigger: 'a receipt is deleted only after its set gave it up' } });
      probe(db, 'natural expiry keeps the accepted receipt', {
        control: () => { const h = withReceipt(); expire(h); kept(h, 'needs-review'); },
        act: () => { const h = withReceipt(); expire(h); bumpSet(h.sid, "receipt_state = 'deleted'");
          run('DELETE FROM card_sync_payload_receipts WHERE observation_set_id = ?', h.sid);
          insertRow(db, 'card_sync_payload_receipts', { observation_set_id: h.sid, payload_digest: dig('pd1:'), canonical_json: '{"a":1}',
            byte_length: 7, accepted_at: at(200), expires_at: at(200 + 7 * DAY_S) }); },
        expect: { trigger: 'a receipt is written only for a set that keeps one' } });
    }

    { // E8-M bd84f0c (adopted): revoking a pending device closes its redeemed invitation in the same transaction
      const close = db.prepare(query('close-pairing-of-device'));
      const invited = () => {
        const p = openPairing();
        run("UPDATE card_sync_pairings SET status = 'redeemed', code_digest = NULL, redeemed_at = ? WHERE id = ?", at(100), p.id);
        const n = fresh('card_sync_devices', { pairing_id: p.id, status: 'pending', activated_at: null, activated_by_ref: null,
          expires_at: null, created_at: at(100), pending_expires_at: at(700) });
        return { p, n };
      };
      const revoke = (v, closeIt) => {                                                // revokeCardSyncDevice('password-reset') on it
        run("UPDATE card_sync_devices SET status = 'revoked', token_digest = NULL, closed_at = ?, close_reason = 'password-reset' WHERE id = ?", at(200), v.n.id);
        if (closeIt) close.run({ now: at(200), device_id: v.n.id });
      };
      const approve = (v) => {                                                        // approveCardSyncPairing's first two statements
        run("UPDATE card_sync_pairings SET status = 'approved', closed_at = ? WHERE id = ?", at(250), v.p.id);
        run("UPDATE card_sync_devices SET status = 'active', activated_at = ?, activated_by_ref = ?, expires_at = ? WHERE id = ?",
          at(250), g.usr, at(250 + 30 * DAY_S), v.n.id);
      };
      probe(db, 'a revoked pending device leaves no approvable invitation', {
        control: () => { const v = invited(); revoke(v, true);
          const pr = get('SELECT status, closed_at FROM card_sync_pairings WHERE id = ?', v.p.id);
          if (pr.status !== 'cancelled' || pr.closed_at !== at(200)) throw new Error(JSON.stringify(pr));
          const again = close.run({ now: at(300), device_id: v.n.id }).changes;                       // idempotent
          const other = close.run({ now: at(300), device_id: device().id }).changes;                  // an active device's pairing is closed already
          if (again !== 0 || other !== 0) throw new Error(`closed again: ${again}, ${other}`); },
        act: () => { const v = invited(); revoke(v, true); approve(v); },
        expect: { trigger: 'a closed pairing never changes' } });
      probe(db, "revision 7's revocation left the invitation redeemed: its approval failed on the device", {
        control: () => { const v = invited(); revoke(v, true); },
        act: () => { const v = invited(); revoke(v, false); approve(v); },
        expect: { trigger: 'a closed device never changes' } });
    }

    { // the three audit statements use index ranges only
      const explain = (name, expected) => {
        const sql = query(name);
        const params = Object.fromEntries([...sql.matchAll(/:(\w+)/g)].map((m) => [m[1], null]));
        const details = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params).map((r) => r.detail);
        const coroutines = details.filter((d) => d.startsWith('CO-ROUTINE ')).map((d) => d.split(' ')[1]);
        const scans = details.filter((d) => /^SCAN /.test(d) && d !== 'SCAN CONSTANT ROW' && !coroutines.includes(d.split(' ')[1]));
        if (scans.length || details.some((d) => /TEMP B-TREE/.test(d)) || expected.some((ix) => !details.some((d) => d.includes(ix)))) fail(`plan ${name}`, JSON.stringify(details));
        else { results.behaviour += 1; note(`${name}: ${details.filter((d) => /SEARCH/.test(d)).join(' | ')}`); }
      };
      explain('audit-cutoff-refresh', ['idx_card_sync_audit_events_created', 'idx_card_sync_audit_events_type']);
      explain('audit-delete-chunk', ['idx_card_sync_audit_events_created', 'idx_card_sync_audit_events_type']);
      explain('audit-cutoff-ahead', ['idx_card_sync_audit_events_type']);
    }

    { // every documented statement is executed or explained
      const unused = [...DOC_QUERIES.keys()].filter((name) => !QUERIES_USED.has(name));
      if (unused.length) fail('documented statements', `never executed: ${unused.join(', ')}`);
      else { results.behaviour += 1; note(`all ${DOC_QUERIES.size} documented statements executed or explained`); }
    }

    section('census');
    // ------------------------------------------------------------------ coverage: every catalogued constraint has a refusing probe
    const uncovered = [
      ...CATALOGUE.columnChecks.filter((c) => !covered.check.has(c.name)).map((c) => c.name),
      ...CATALOGUE.tableChecks.filter((c) => !covered.check.has(c.name)).map((c) => c.name),
      ...[...CATALOGUE.uniques, ...CATALOGUE.primaryKeys].filter((u) => !covered.unique.has(u.name)).map((u) => u.name),
      ...[...fkKeys].filter((k) => !covered.fk.has(k)),
      ...CATALOGUE.triggers.filter((t) => !covered.trigger.has(t)),
    ];
    if (uncovered.length) fail('coverage', `no refusing probe for ${uncovered.join(', ')}`);
    results.coverage = { checks: covered.check.size, columnChecks: CATALOGUE.columnChecks.length, tableChecks: CATALOGUE.tableChecks.length,
      fks: covered.fk.size, fkTotal: fkKeys.size, uniques: covered.unique.size, uniqueTotal: CATALOGUE.uniques.length + CATALOGUE.primaryKeys.length,
      triggers: covered.trigger.size, triggerTotal: CATALOGUE.triggers.length, newTables: NEW_TABLES.length };

  }
  if (sections.retention) {
  section('retention');
    // ------------------------------------------------------------------ retention over a long-lived ledger (finding 13)
    function timed(fn) { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; }
    // This build's real card guards (revision 4, cardGuardSql's triggers on all 31 card tables), so retention is measured with
    // the real per-row cost of a guarded write. The repository opens the v14 database, migrates it and installs them; the setup
    // writes the validator's rows with every invariant trigger active and the guards set aside, as the validator wrote them
    // unguarded; the guards then go back byte for byte, and a reopen by the repository, which would replace any guard that is
    // not this build's own, writes nothing. Every timed call runs with them.
    const guardTriggers = (db) => db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_%_guard_%'")
      .all();
    {
      const retentionFile = path.join(WORK, 'retention.db');
      const snapshotFile = path.join(WORK, 'retention-snapshot.db');
      const now = () => new Date(at(0));
      buildV14(retentionFile, { withData: true }).close();
      let repo = new SqliteStateRepo({ file: retentionFile, now });
      let big = repo.internalGetDb();
      const guards = guardTriggers(big);
      for (const { name } of guards) big.exec(`DROP TRIGGER ${name}`);
      big.pragma('foreign_keys = ON');
      const gr = seed(big);
      const IDENTITIES = 30000; const KEEP = 1000; const PURGE = 5000; const EVENTS = 30000; const DUE = 2000;
      const setup = timed(() => big.transaction(() => {
        const kept = makeSet(big, gr, { row_count: KEEP, inserted_count: KEEP, state: 'committed', closed_at: at(900), close_reason: 'committed' });
        const goneSets = [2000, 2000, 1000].map((n) => makeSet(big, gr, { row_count: n, unchanged_count: n, state: 'committed',
          closed_at: at(900), close_reason: 'committed' }));
        const keepIds = [];
        for (let i = 0; i < KEEP; i += 1) {
          const o = obsRow(gr, { observation_set_id: kept, ordinal: i, state: 'resolved', outcome: 'inserted', provenance: 1,
            resolved_transaction_id: gr.t4, resolved_at: at(900) });
          insertRow(big, 'card_source_observations', o); keepIds.push(o.id);
        }
        for (let i = 0; i < PURGE; i += 1) {
          const gone = goneSets[Math.floor(i / 2000)];
          const o = obsRow(gr, { observation_set_id: gone, ordinal: i % 2000, state: 'resolved', outcome: 'unchanged', provenance: 0,
            resolved_transaction_id: gr.t4, resolved_at: at(900) });
          insertRow(big, 'card_source_observations', o);
          insertRow(big, 'card_observation_secondary_ids', { id: id('card-obsid-'), observation_id: o.id, ordinal: 1,
            namespace: 'chase-api:derived:v1', namespace_kind: 'stable', id_hash: dig('xid1:') });
          const it = itemRow(gr, { observation_set_id: gone, observation_id: o.id });
          insertRow(big, 'card_reconciliation_suggestions', it);
          insertRow(big, 'card_reconciliation_candidates', { review_item_id: it.id, card_account_id: gr.a1, rank: 1,
            transaction_id: gr.t4, rule: 'near-content:v1', matched_on: 3, blocked_reason: null });
        }
        for (let i = 0; i < IDENTITIES; i += 1) {
          insertRow(big, 'card_source_identities', { ...BASE.card_source_identities(big, gr), first_observation_id: keepIds[i % KEEP] });
        }
        for (let i = 0; i < EVENTS; i += 1) {
          insertRow(big, 'card_transaction_events', baseEvent(gr, { origin: 'extension', run_id: gr.r, observation_set_id: kept,
            observation_id: keepIds[i % KEEP] }));
        }
        gr.gone = goneSets;
        gr.kept = kept;
        // one open set past its 30-day acceptance: 2,000 open rows, each with an open review item and a candidate
        const due = makeSet(big, gr, { row_count: DUE, open_count: DUE });
        for (let i = 0; i < DUE; i += 1) {
          const o = obsRow(gr, { observation_set_id: due, ordinal: i });
          insertRow(big, 'card_source_observations', o);
          const it = itemRow(gr, { observation_set_id: due, observation_id: o.id });
          insertRow(big, 'card_reconciliation_suggestions', it);
          insertRow(big, 'card_reconciliation_candidates', { review_item_id: it.id, card_account_id: gr.a1, rank: 1,
            transaction_id: gr.t4, rule: 'near-content:v1', matched_on: 3, blocked_reason: null });
        }
        gr.due = due;
        // the other phases at their worst legal sizes (Revision 4, finding 3)
        const old = (seconds) => at(200 + 31 * DAY_S - 365 * DAY_S - 6 * DAY_S + seconds);   // older than the 365-day horizon
        big.prepare("UPDATE card_sync_devices SET status = 'revoked', token_digest = NULL, closed_at = ?, close_reason = 'owner' WHERE id = ?")
          .run(at(500), gr.d);                                     // the seed device holds every benchmark set; keep it out of phase 2
        big.prepare(query('revoke-grants-of-device')).run({ now: at(500), device_id: gr.d });
        for (let i = 0; i < 300; i += 1) { makePlan(big, gr, {}); makeRun(big, gr, {}); }                   // phase 1
        for (let i = 0; i < 100; i += 1) insertRow(big, 'card_sync_pairings', { ...BASE.card_sync_pairings(big, gr), status: 'open',
          code_digest: dig('hph1:'), closed_at: null, created_by_ref: id('usr_') });                        // phase 2: pairings
        // consent as the auto-sync switch stores it: current (snapshot of today's contract, guard, issuer and binding), or stale
        // (given under guard revision 3), or none
        gr.consentGrants = 0;
        const consentOf = (kind) => (kind === 'none' ? { auto_sync: 0 } : { auto_sync: 1, consent_contract_version: 1,
          consent_guard_revision: kind === 'stale' ? 3 : 4, consent_issuer_revision: 1, consent_binding_version: 1, consent_by_ref: gr.usr,
          consent_at: at(90) });
        const benchDevice = (grants, kindOf) => {                                                          // phase 2: devices
          const d = BASE.card_sync_devices(big, gr); insertRow(big, 'card_sync_devices', d);
          for (let k = 0; k < grants; k += 1) {
            let binding = gr.b;
            if (k > 0) { const b = BASE.card_source_bindings(big, gr); insertRow(big, 'card_source_bindings', b); binding = b.id; }
            const kind = kindOf(k);
            if (kind !== 'none') gr.consentGrants += 1;
            insertRow(big, 'card_sync_device_scopes', { id: id('card-dscope-'), device_id: d.id, binding_id: binding, binding_version: 1,
              mode: 'isolated-read', contract_version: 1, status: 'active', granted_by_ref: gr.usr, granted_at: at(60), revoked_at: null,
              ...consentOf(kind) });
          }
          const r = makeRun(big, gr, { device_id: d.id, acceptance_state: 'accepted', payload_digest: dig('pd1:'), accepted_at: at(200),
            closed_at: at(200) });
          const sid = makeSet(big, gr, { run_id: r, device_id: d.id, state: 'accepted-uncommitted' });
          makePlan(big, gr, { observation_set_id: sid, principal_kind: 'device', device_id: d.id, actor_ref: null, auto_eligible: 1 });
        };
        benchDevice(50, (k) => (k % 2 ? 'stale' : 'current'));   // the most grants a device can hold, every one consenting
        for (let i = 0; i < 99; i += 1) benchDevice(1, () => ['none', 'current', 'stale'][i % 3]);
        const json2MiB = `{"x":"${'a'.repeat(2097152 - 8)}"}`;                                              // phase 4
        for (let i = 0; i < 30; i += 1) {
          const sid = makeSet(big, gr, { byte_count: 2097152 });
          insertRow(big, 'card_sync_payload_receipts', { observation_set_id: sid, payload_digest: dig('pd1:'), canonical_json: json2MiB,
            byte_length: 2097152, accepted_at: at(200), expires_at: at(200 + 7 * DAY_S) });
        }
        const action = big.prepare(`INSERT INTO card_sync_plan_actions (plan_id, ordinal, card_account_id, plan_kind, op, observation_ordinal,
          content_digest, scope_id, promote, restore, identity_count) VALUES (?, ?, ?, 'set', 'insert', 0, ?, ?, 0, 0, 1)`);
        gr.bigPlans = [];
        for (let p = 0; p < 20; p += 1) {                                                                  // phase 6: 20 × 6,000
          const pid = makePlan(big, gr, { action_count: 6000, count_insert: 6000 });
          for (let i = 0; i < 6000; i += 1) action.run(pid, i, gr.a1, dig('rcd1:'), gr.k1);
          big.prepare("UPDATE card_sync_commit_plans SET status = 'consumed', closed_at = ? WHERE id = ?").run(at(450), pid);
          gr.bigPlans.push(pid);
        }
        for (let i = 0; i < 1000; i += 1) insertRow(big, 'card_sync_audit_events', { id: id('card-audit-'), event_type: 'policy-changed',
          actor_kind: 'session', actor_ref: gr.usr, created_at: old(i) });                                 // phase 7
        for (let i = 0; i < 300; i += 1) {
          insertRow(big, 'card_sync_pairings', { ...BASE.card_sync_pairings(big, gr), created_at: old(i), expires_at: old(i + 300),
            closed_at: old(i + 10) });
          makeRun(big, gr, { created_at: old(i), upload_expires_at: old(i + 600), acceptance_state: 'expired', closed_at: old(i + 600) });
        }
        for (let i = 0; i < 100; i += 1) insertRow(big, 'card_coverage_windows', { ...BASE.card_coverage_windows(big, gr),
          ledger_state: 'expired-unreviewed', observed_at: old(i), recorded_at: old(i), updated_at: old(i) });
      })());
      // §5.9 as whole calls, with every card table guarded: all seven phases in order, each in chunks bounded by the rows they write
      // or delete (cascades included); the clock is read before every chunk and the call commits once the budget is spent.
      for (const { sql } of guards) big.exec(sql);
      const cookie = big.pragma('schema_version', { simple: true });
      repo.close();
      repo = new SqliteStateRepo({ file: retentionFile, now });
      big = repo.internalGetDb();
      const guardInfo = {
        tables: big.prepare("SELECT count(DISTINCT tbl_name) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_%_guard_%'").get().n,
        triggers: guardTriggers(big).length,
        current: big.pragma('schema_version', { simple: true }) === cookie,
      };
      // Port: the bound is wall-clock time, so a busy machine can push a call past it. Each attempt runs the whole benchmark on
      // a byte-identical copy of the ledger; every attempt must settle everything, and at least one must keep every call and
      // every checkpoint after one within the limit. Every attempt's calls are reported. The OS writes a copy's data back over
      // the next seconds, and a measured checkpoint flushes to the same disk behind that writeback (seconds right after a copy,
      // or after another test's heavy writes), so every copy is flushed when it is made, and each attempt's calls start on an
      // empty WAL once a small durable write is quick again (testing/quietDisk.ts; the wait is reported, and it never fails or skips).
      const ATTEMPTS = 5;
      big.pragma('wal_checkpoint(TRUNCATE)');
      repo.close();
      fs.copyFileSync(retentionFile, snapshotFile);
      flushFile(retentionFile);
      flushFile(snapshotFile);
      const attempts = [];
      let measured;
      for (let attemptNo = 1; attemptNo <= ATTEMPTS; attemptNo += 1) {
        if (attemptNo > 1) {
          for (const suffix of ['', '-wal', '-shm']) fs.rmSync(retentionFile + suffix, { force: true });
          fs.copyFileSync(snapshotFile, retentionFile);
          flushFile(retentionFile);
        }
        repo = new SqliteStateRepo({ file: retentionFile, now });
        big = repo.internalGetDb();
        big.pragma('foreign_keys = ON');
        const NOW = at(200 + 31 * DAY_S);
        const CUT6 = at(200 + 24 * DAY_S);
        const CUT7 = at(200 + 31 * DAY_S - 365 * DAY_S);
        const CHUNK = 100; const BUDGET = CARD_SYNC_RETENTION_BUDGET_MS;   // Port: the repository's budget (see the header)
        const scope = JSON.stringify([gr.due, ...gr.gone, gr.kept]);      // phases 3 and 5 on the benchmark's sets (not the seed's)
        const q = {
          p1plans: big.prepare(`UPDATE card_sync_commit_plans SET status = 'expired', closed_at = ? WHERE rowid IN (SELECT rowid
            FROM card_sync_commit_plans WHERE status = 'prepared' AND expires_at <= ? LIMIT ${CHUNK})`),
          p1runs: big.prepare(`UPDATE card_sync_runs SET acceptance_state = 'expired', closed_at = ? WHERE rowid IN (SELECT rowid
            FROM card_sync_runs WHERE acceptance_state = 'open' AND upload_expires_at <= ? LIMIT ${CHUNK})`),
          p2pairings: big.prepare(`UPDATE card_sync_pairings SET status = 'expired', code_digest = NULL, closed_at = ? WHERE rowid IN
            (SELECT rowid FROM card_sync_pairings WHERE status = 'open' AND expires_at <= ? LIMIT ${CHUNK})`),
          p2device: big.prepare("SELECT id FROM card_sync_devices WHERE status = 'active' AND expires_at <= ? ORDER BY expires_at, rowid LIMIT 1").pluck(),
          p2expire: big.prepare("UPDATE card_sync_devices SET status = 'expired', token_digest = NULL, closed_at = ?, close_reason = 'expired' WHERE id = ?"),
          p2grants: big.prepare(query('revoke-grants-of-device')),        // the document's statement: consent cleared in the same UPDATE
          p2plans: big.prepare(`UPDATE card_sync_commit_plans SET status = 'cancelled', closed_at = ?, cancel_reason = 'device-revoked'
            WHERE device_id = ? AND status = 'prepared'`),
          dueSet: big.prepare(`SELECT id FROM card_sync_observation_sets WHERE id IN (SELECT value FROM json_each(?)) AND closed_at IS NULL
            AND expires_at <= ? ORDER BY expires_at, rowid LIMIT 1`).pluck(),
          openRows: big.prepare(`SELECT id FROM card_source_observations WHERE observation_set_id = ? AND state = 'open' LIMIT ${CHUNK}`).pluck(),
          expireRows: big.prepare(`UPDATE card_source_observations SET state = 'expired', resolved_at = ? WHERE id IN (SELECT value FROM json_each(?))`),
          expireItems: big.prepare(`UPDATE card_reconciliation_suggestions SET status = 'expired', draft_action = NULL, draft_transaction_id = NULL,
            draft_scope_id = NULL, drafted_by_ref = NULL, drafted_at = NULL, updated_at = ?
            WHERE observation_id IN (SELECT value FROM json_each(?)) AND status IN ('open', 'decided')`),
          expireSetItem: big.prepare(`UPDATE card_reconciliation_suggestions SET status = 'expired', draft_action = NULL, drafted_by_ref = NULL,
            drafted_at = NULL, updated_at = ? WHERE observation_set_id = ? AND observation_id IS NULL AND status IN ('open', 'decided')`),
          cancelPlans: big.prepare(`UPDATE card_sync_commit_plans SET status = 'cancelled', closed_at = ?, cancel_reason = 'set-closed'
            WHERE observation_set_id = ? AND status = 'prepared'`),
          closeSet: big.prepare(`UPDATE card_sync_observation_sets SET state = 'expired-unreviewed', closed_at = ?, close_reason = 'expired',
            expired_count = expired_count + open_count, open_count = 0, version = version + 1 WHERE id = ?`),
          coverage: big.prepare(`UPDATE card_coverage_windows SET ledger_state = 'expired-unreviewed', updated_at = ?
            WHERE observation_set_id = ? AND ledger_state = 'observed-uncommitted'`),
          p4receipt: big.prepare('SELECT observation_set_id FROM card_sync_payload_receipts WHERE expires_at <= ? ORDER BY expires_at, rowid LIMIT 1').pluck(),
          p4delete: big.prepare('DELETE FROM card_sync_payload_receipts WHERE observation_set_id = ?'),
          touch: big.prepare(query('touch-set')),                         // the document's statement: a chunk that changes items moves the version
          p7refresh: big.prepare(query('audit-cutoff-refresh')),           // the document's statements: one horizon per call (revision 8)
          p7ahead: big.prepare(query('audit-cutoff-ahead')).pluck(),
          p4mark: big.prepare("UPDATE card_sync_observation_sets SET receipt_state = 'expired', version = version + 1 WHERE id = ?"),
          purgeSet: big.prepare(`SELECT id FROM card_sync_observation_sets WHERE id IN (SELECT value FROM json_each(?)) AND closed_at IS NOT NULL
            AND content_purged_at IS NULL AND expires_at <= ? ORDER BY expires_at, rowid LIMIT 1`).pluck(),
          purgeChunk: big.prepare(`DELETE FROM card_source_observations WHERE rowid IN (SELECT rowid FROM card_source_observations
            WHERE observation_set_id = ? AND provenance = 0 LIMIT ${CHUNK})`),
          markPurged: big.prepare('UPDATE card_sync_observation_sets SET content_purged_at = ?, version = version + 1 WHERE id = ?'),
          p6plan: big.prepare("SELECT id FROM card_sync_commit_plans WHERE status <> 'prepared' AND closed_at <= ? ORDER BY closed_at, rowid LIMIT 1").pluck(),
          p6delete: big.prepare('DELETE FROM card_sync_commit_plans WHERE id = ?'),
          p7audit: big.prepare(query('audit-delete-chunk')),
          p7pairings: big.prepare(`DELETE FROM card_sync_pairings WHERE rowid IN (SELECT p.rowid FROM card_sync_pairings p
            WHERE p.status NOT IN ('open', 'redeemed') AND p.closed_at <= ? AND NOT EXISTS (SELECT 1 FROM card_sync_devices d WHERE d.pairing_id = p.id)
            LIMIT ${CHUNK})`),
          p7runs: big.prepare(`DELETE FROM card_sync_runs WHERE rowid IN (SELECT r.rowid FROM card_sync_runs r
            WHERE r.acceptance_state IN ('refused', 'expired', 'aborted') AND r.closed_at <= ?
              AND NOT EXISTS (SELECT 1 FROM card_sync_observation_sets s WHERE s.run_id = r.id)
              AND NOT EXISTS (SELECT 1 FROM card_transaction_events e WHERE e.run_id = r.id)
              AND NOT EXISTS (SELECT 1 FROM card_source_identities i WHERE i.last_seen_run_id = r.id)
              AND NOT EXISTS (SELECT 1 FROM card_transactions t WHERE t.first_sync_run_id = r.id) LIMIT ${CHUNK})`),
          p7coverage: big.prepare(`DELETE FROM card_coverage_windows WHERE rowid IN (SELECT rowid FROM card_coverage_windows
            WHERE ledger_state IN ('expired-unreviewed', 'rejected') AND updated_at <= ? LIMIT ${CHUNK})`),
        };
        // each chunk returns how many rows it settled (0: the phase has nothing left)
        const PHASES = [
          ['1 plans', () => q.p1plans.run(NOW, NOW).changes],
          ['1 runs', () => q.p1runs.run(NOW, NOW).changes],
          ['2 pairings', () => q.p2pairings.run(NOW, NOW).changes],
          ['2 device', () => { const d = q.p2device.get(NOW); if (!d) return 0;
            q.p2expire.run(NOW, d); return 1 + q.p2grants.run({ now: NOW, device_id: d }).changes + q.p2plans.run(NOW, d).changes; }],
          ['3 expiry', () => { const set = q.dueSet.get(scope, NOW); if (!set) return 0;
            const ids = JSON.stringify(q.openRows.all(set));
            const n = q.expireRows.run(NOW, ids).changes;
            if (n) return n + q.expireItems.run(NOW, ids).changes + q.touch.run({ set_id: set }).changes;
            q.expireSetItem.run(NOW, set); q.cancelPlans.run(NOW, set); q.closeSet.run(NOW, set); q.coverage.run(NOW, set); return 1; }],
          ['4 receipt', () => { const sid = q.p4receipt.get(NOW); if (!sid) return 0; q.p4mark.run(sid); q.p4delete.run(sid); return 1; }],
          ['5 purge', () => { if (q.dueSet.get(scope, NOW)) return 0; const set = q.purgeSet.get(scope, NOW); if (!set) return 0;
            const n = q.purgeChunk.run(set).changes; if (n) return n + q.touch.run({ set_id: set }).changes; q.markPurged.run(NOW, set); return 1; }],
          ['6 plan', () => { const pid = q.p6plan.get(CUT6); if (!pid) return 0; q.p6delete.run(pid); return 1; }],
          ['7 cutoff', () => q.p7refresh.run({ id: id('card-audit-'), now: NOW }).changes],   // at most one row a day
          ['7 audit', () => q.p7audit.run({ now: NOW }).changes],
          ['7 pairings', () => q.p7pairings.run(CUT7).changes],
          ['7 runs', () => q.p7runs.run(CUT7).changes],
          ['7 coverage', () => q.p7coverage.run(CUT7).changes],
        ];
        const worstChunk = Object.fromEntries(PHASES.map(([name]) => [name, 0]));
        const settled = Object.fromEntries(PHASES.map(([name]) => [name, 0]));
        // Port: a call runs as the repository runs it (O100): first its fence (it writes only when the WAL has no frames
        // left to copy back: the PASSIVE checkpoint before it leaves none, and no other connection commits before it
        // holds the write lock; nothing else has this ledger open, so here it always may), then the auto-checkpoint off
        // inside it, back on whatever happens, and the repository's own checkpoint after it as a slice of its own, timed
        // like a call
        const dataVersion = () => big.pragma('data_version', { simple: true });
        const clearWal = () => {
          const version = dataVersion();
          if (!repo.checkpointAfterCardSyncRetention().complete) throw new Error('retention: the WAL had frames left to copy back before a call');
          return () => { if (dataVersion() !== version) throw new Error('retention: another connection committed before a call'); };
        };
        const withoutAutoCheckpoint = (fn) => {
          const autoCheckpoint = big.pragma('wal_autocheckpoint', { simple: true });
          big.pragma('wal_autocheckpoint = 0');
          try { return fn(); } finally { big.pragma(`wal_autocheckpoint = ${autoCheckpoint}`); }
        };
        const checkpointAfterCall = () => {
          const t = process.hrtime.bigint();
          const { complete, frames } = repo.checkpointAfterCardSyncRetention();
          return { ms: Number(process.hrtime.bigint() - t) / 1e6, complete, frames };
        };
        function retentionCall() {
          const t0 = process.hrtime.bigint();
          const elapsed = () => Number(process.hrtime.bigint() - t0) / 1e6;
          let work = 0; let complete = true; let lastChunkEnd = 0;
          const stillClear = clearWal();
          withoutAutoCheckpoint(() => big.transaction(() => {
            stillClear();
            for (const [name, chunk] of PHASES) {
              for (;;) {
                if (elapsed() >= BUDGET) { complete = false; lastChunkEnd = elapsed(); return; }
                const c0 = elapsed();
                const n = chunk();
                if (n === 0) break;
                worstChunk[name] = Math.max(worstChunk[name], elapsed() - c0); settled[name] += n; work += n;
              }
            }
            lastChunkEnd = elapsed();
          }).immediate());
          const ms = elapsed();
          return { ms, commitMs: ms - lastChunkEnd, work, done: complete && work === 0 };
        }
        // the comparisons: revision 2's one-call expiry of the due set, and revision 3's declared phase-6 chunk of 20 plans (rolled back)
        const oneShot = attemptNo > 1 ? 0 : inSavepoint(big, () => timed(() => {
          big.prepare("UPDATE card_source_observations SET state = 'expired', resolved_at = ? WHERE observation_set_id = ? AND state = 'open'").run(NOW, gr.due);
          big.prepare("UPDATE card_reconciliation_suggestions SET status = 'expired', updated_at = ? WHERE observation_set_id = ? AND status IN ('open', 'decided')").run(NOW, gr.due);
          q.closeSet.run(NOW, gr.due);
        }));
        const twentyPlans = attemptNo > 1 ? 0 : inSavepoint(big, () => timed(() => {
          big.prepare('DELETE FROM card_sync_commit_plans WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(gr.bigPlans));
        }));
        // Port: the measured calls start on an empty WAL (the comparisons above rolled back) and a quiet disk.
        big.pragma('wal_checkpoint(TRUNCATE)');
        const disk = waitForQuietDisk(WORK);
        const calls = [];
        for (let n = 0; n < 1000; n += 1) { const c = retentionCall(); calls.push(c); c.checkpoint = checkpointAfterCall(); if (c.done) break; }
        const worst = Math.max(...calls.map((c) => c.ms));
        const checkpoints = calls.map((c) => c.checkpoint.ms);
        const worstCheckpoint = Math.max(...checkpoints);
        // the scheduler would end its pass at a checkpoint that cannot finish; nothing else holds this ledger open
        const unfinished = calls.filter((c) => !c.checkpoint.complete).length;
        if (unfinished) fail('retention checkpoint', `${unfinished} checkpoints after a call did not finish`);
        const cutoffs = big.prepare("SELECT count(*) AS n FROM card_sync_audit_events WHERE code = 'audit-cutoff'").get().n;
        if (cutoffs !== 1 || q.p7ahead.get({ now: NOW }) !== 0) fail('retention audit cutoff', `${cutoffs} cutoff rows`);
        const count = (sql, ...args) => big.prepare(sql).get(...args).n;
        const left = {
          plans: count("SELECT count(*) AS n FROM card_sync_commit_plans WHERE status = 'prepared' AND expires_at <= ?", NOW),
          runs: count("SELECT count(*) AS n FROM card_sync_runs WHERE acceptance_state = 'open' AND upload_expires_at <= ?", NOW),
          pairings: count("SELECT count(*) AS n FROM card_sync_pairings WHERE status = 'open' AND expires_at <= ?", NOW),
          devices: count("SELECT count(*) AS n FROM card_sync_devices WHERE status = 'active' AND expires_at <= ?", NOW),
          rows: count(`SELECT count(*) AS n FROM card_source_observations WHERE provenance = 0 AND observation_set_id IN (SELECT value FROM json_each(?))`, scope),
          items: count('SELECT count(*) AS n FROM card_reconciliation_suggestions WHERE observation_set_id = ?', gr.due),
          receipts: count('SELECT count(*) AS n FROM card_sync_payload_receipts WHERE expires_at <= ?', NOW),
          oldPlans: count("SELECT count(*) AS n FROM card_sync_commit_plans WHERE status <> 'prepared' AND closed_at <= ?", CUT6),
          audit: count('SELECT count(*) AS n FROM card_sync_audit_events WHERE created_at <= ?', CUT7),
          oldPairings: count("SELECT count(*) AS n FROM card_sync_pairings WHERE status NOT IN ('open', 'redeemed') AND closed_at <= ?", CUT7),
          oldRuns: count("SELECT count(*) AS n FROM card_sync_runs WHERE acceptance_state IN ('refused', 'expired', 'aborted') AND closed_at <= ?", CUT7),
          oldCoverage: count("SELECT count(*) AS n FROM card_coverage_windows WHERE ledger_state IN ('expired-unreviewed', 'rejected') AND updated_at <= ?", CUT7),
          consentLeft: count(`SELECT count(*) AS n FROM card_sync_device_scopes g JOIN card_sync_devices d ON d.id = g.device_id
            WHERE d.status <> 'active' AND (g.status = 'active' OR g.auto_sync = 1 OR g.consent_at IS NOT NULL)`),
        };
        const dueAfter = big.prepare('SELECT state, expired_count AS e, content_purged_at AS p FROM card_sync_observation_sets WHERE id = ?').get(gr.due);
        const leftover = Object.entries(left).filter(([, n]) => n !== 0);
        const settledAll = !leftover.length && dueAfter.state === 'expired-unreviewed' && dueAfter.e === DUE && Boolean(dueAfter.p)
          && calls.at(-1).done;
        const attemptResult = { calls: calls.map((c) => c.ms), commits: calls.map((c) => c.commitMs), checkpoints, worst, worstCheckpoint,
          worstChunk, settled, oneShot, twentyPlans, left, settledAll, disk };
        attempts.push(attemptResult);
        measured = { ...attemptResult, PHASES, BUDGET, calls, dueAfter, leftover };
        // the last attempt keeps its connection open: the comparisons below run on it
        if (!settledAll || Math.max(worst, worstCheckpoint) <= 250 || attemptNo === ATTEMPTS) break;
        repo.close();
      }
      const { calls, checkpoints, worst, worstCheckpoint, worstChunk, settled, oneShot, twentyPlans, left, PHASES, BUDGET, dueAfter, leftover } = measured;
      results.retention = { calls: calls.map((c) => c.ms), checkpoints, worst, worstCheckpoint, setupMs: setup, worstChunk, settled, oneShot,
        twentyPlans, left, guardInfo, consentGrants: gr.consentGrants, done: calls.at(-1).done, attempts };
      if (worst > 250 || worstCheckpoint > 250 || leftover.length || dueAfter.state !== 'expired-unreviewed' || dueAfter.e !== DUE || !dueAfter.p || !calls.at(-1).done) {
        fail('retention budget', `${calls.map((c) => c.ms.toFixed(0)).join('/')} ms; checkpoints ${checkpoints.map((ms) => ms.toFixed(0)).join('/')} ms; left ${JSON.stringify(leftover)}, due set ${JSON.stringify(dueAfter)}`);
      } else {
        results.behaviour += 1;
        const big3 = (name) => `${name} ${worstChunk[name].toFixed(0)}`;
        note(`retention (attempt ${attempts.length} of ${attempts.length}) with revision-4 guards on all ${guardInfo.tables} card tables (${guardInfo.triggers} guard triggers), all seven phases at worst legal sizes (${gr.consentGrants} of the expiring devices' 149 grants consenting, current or stale): ${calls.length} whole calls (budget ${BUDGET} ms) of ${calls.map((c) => c.ms.toFixed(0)).join('/')} ms, commit included (limit 250), each followed by its checkpoint (${checkpoints.map((ms) => ms.toFixed(0)).join('/')} ms, limit 250), settled ${Object.entries(settled).map(([k, n]) => `${k} ${n}`).join(', ')}; largest chunk per phase (ms): ${PHASES.map(([name]) => big3(name)).join(', ')}; revision 2's one-call expiry of the 2,000-row set: ${oneShot.toFixed(0)} ms; revision 3's declared chunk of 20 plans × 6,000 actions: ${twentyPlans.toFixed(0)} ms (setup ${(setup / 1000).toFixed(1)} s)`);
      }
      // the same phase without the first_observation index, at 1/10 scale, to show what the index buys
      big.exec('DROP INDEX idx_card_source_identities_first_observation');
      const slow = timed(() => big.transaction(() => {
        const s = makeSet(big, gr, { row_count: 500, unchanged_count: 500, state: 'committed', closed_at: at(900), close_reason: 'committed' });
        for (let i = 0; i < 500; i += 1) insertRow(big, 'card_source_observations', obsRow(gr, { observation_set_id: s, ordinal: i,
          state: 'resolved', outcome: 'unchanged', provenance: 0, resolved_transaction_id: gr.t4, resolved_at: at(900) }));
        const t = process.hrtime.bigint();
        big.prepare('DELETE FROM card_source_observations WHERE observation_set_id = ? AND provenance = 0').run(s);
        gr.slowDelete = Number(process.hrtime.bigint() - t) / 1e6;
      })());
      void slow;
      note(`without idx_card_source_identities_first_observation: deleting 500 observations beside ${IDENTITIES} identities took ${gr.slowDelete.toFixed(0)} ms (each delete scans the identities)`);
      // maximum legal plan: 2,001 actions inserted and dropped with their plan
      const planMs = timed(() => big.transaction(() => {
        const p = makePlan(big, gr, { action_count: 2001, count_insert: 2001 });
        for (let i = 0; i < 2001; i += 1) insertRow(big, 'card_sync_plan_actions', actionRow(gr, { plan_id: p, ordinal: i }));
        big.prepare("UPDATE card_sync_commit_plans SET status = 'consumed', closed_at = ? WHERE id = ?").run(at(500), p);
        big.prepare('DELETE FROM card_sync_commit_plans WHERE id = ?').run(p);
      })());
      note(`maximum plan: 2,001 action rows written, consumed and deleted with their plan in ${planMs.toFixed(0)} ms`);
      repo.close();
    }

  }
  dbA.close();
  dbB.close();
  return { results, sectionFailures: Object.fromEntries(sectionFailures), queriesUsed: [...QUERIES_USED] };
}
