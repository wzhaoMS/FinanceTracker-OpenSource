import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';

import { HoldrRefusal, toValueFreeDbError } from '../../dbErrors.js';

/**
 * The W4 proof's tables (design v1.2 §3.6).
 * - `card_import_proof_receipts`: one immutable, value-free receipt per committed job. It is written in the commit's own
 *   transaction, so a receipt exists if and only if the import committed.
 * - `card_import_proof_fences`: one fence per job. Resolve raises it; every later proof transaction for an attempt at or
 *   under it refuses to begin.
 * - `card_import_live_permit` and its journal: ROOT's LIVE PERMIT on the Mac (below).
 *
 * Only the operator command (`cli/cardImportProof.ts`) creates them, under a ROOT GO with a pre-write backup. The API
 * never does. With the tables absent, every proof request holds as `proof-schema-required`. In another shape, every
 * proof request holds as `proof-schema-conflict`, and nothing ever repairs it. The permit starts with no rows: dead.
 */
export const PROOF_RECEIPTS_TABLE = 'card_import_proof_receipts';
export const PROOF_FENCES_TABLE = 'card_import_proof_fences';
/**
 * ROOT's LIVE PERMIT (cross-lane contract, 2026-11-08), as the Mac sees it. The `*` row mirrors holdrOn, operator stops
 * and latches; one row per issuer carries that issuer's consent and mode. The proof checks it inside its transaction (F1
 * and F2) for every automatic commit. No row means dead.
 */
export const PROOF_PERMIT_TABLE = 'card_import_live_permit';
/**
 * Every permit change, append-only: its generation, the GO a `live` was made under, and for a `stop` the time the STOP
 * was declared (ROOT's STOPPING-PENDING contract). It is how a receipt is labelled "committed during stopping".
 */
export const PROOF_PERMIT_JOURNAL_TABLE = 'card_import_live_permit_journal';

export const PROOF_SCHEMA_SQL: readonly string[] = Object.freeze([
  `CREATE TABLE card_import_proof_receipts (
    job_id TEXT PRIMARY KEY NOT NULL,
    card_account_id TEXT NOT NULL REFERENCES card_accounts(id),
    payload_sha256 TEXT NOT NULL,
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json))
  )`,
  `CREATE TABLE card_import_proof_fences (
    job_id TEXT PRIMARY KEY NOT NULL,
    card_account_id TEXT NOT NULL REFERENCES card_accounts(id),
    payload_sha256 TEXT NOT NULL,
    max_resolved_attempt INTEGER NOT NULL CHECK(max_resolved_attempt >= 1)
  )`,
  `CREATE TABLE card_import_live_permit (
    issuer TEXT PRIMARY KEY NOT NULL CHECK(issuer = '*' OR (length(issuer) BETWEEN 2 AND 24 AND issuer NOT GLOB '*[^a-z]*')),
    state TEXT NOT NULL CHECK(state IN ('live', 'dead')),
    mode TEXT NOT NULL CHECK(mode IN ('supervised', 'daily-interim', 'auto')),
    generation INTEGER NOT NULL CHECK(generation >= 1),
    reason TEXT NOT NULL CHECK(reason IN ('go', 'consent-off', 'holdr-off', 'operator-stop', 'latch')),
    changed_at TEXT NOT NULL
  )`,
  `CREATE TABLE card_import_live_permit_journal (
    issuer TEXT NOT NULL CHECK(issuer = '*' OR (length(issuer) BETWEEN 2 AND 24 AND issuer NOT GLOB '*[^a-z]*')),
    generation INTEGER NOT NULL CHECK(generation >= 1),
    state TEXT NOT NULL CHECK(state IN ('live', 'dead')),
    mode TEXT NOT NULL CHECK(mode IN ('supervised', 'daily-interim', 'auto')),
    reason TEXT NOT NULL CHECK(reason IN ('go', 'consent-off', 'holdr-off', 'operator-stop', 'latch')),
    go_id TEXT CHECK(go_id IS NULL OR (length(go_id) = 32 AND go_id NOT GLOB '*[^a-f0-9]*')),
    declared_at TEXT,
    applied_at TEXT NOT NULL,
    PRIMARY KEY (issuer, generation),
    CHECK((state = 'live') = (reason = 'go' AND go_id IS NOT NULL)),
    CHECK((state = 'dead') = (declared_at IS NOT NULL))
  )`,
]);

const normalizeSql = (sql: string) => sql.trim().replace(/\s+/g, ' ');

/** The schema a GO names: the normalized SQL of every proof table, in order. */
export const PROOF_SCHEMA_DIGEST = createHash('sha256').update(JSON.stringify(PROOF_SCHEMA_SQL.map(normalizeSql))).digest('hex');

/** Every object on the proof's tables, by name: each table and its primary key's own index. Nothing else may exist. */
const EXPECTED_OBJECTS: ReadonlyMap<string, { type: string; sql: string | null }> = new Map([
  [PROOF_RECEIPTS_TABLE, { type: 'table', sql: normalizeSql(PROOF_SCHEMA_SQL[0]) }],
  [`sqlite_autoindex_${PROOF_RECEIPTS_TABLE}_1`, { type: 'index', sql: null }],
  [PROOF_FENCES_TABLE, { type: 'table', sql: normalizeSql(PROOF_SCHEMA_SQL[1]) }],
  [`sqlite_autoindex_${PROOF_FENCES_TABLE}_1`, { type: 'index', sql: null }],
  [PROOF_PERMIT_TABLE, { type: 'table', sql: normalizeSql(PROOF_SCHEMA_SQL[2]) }],
  [`sqlite_autoindex_${PROOF_PERMIT_TABLE}_1`, { type: 'index', sql: null }],
  [PROOF_PERMIT_JOURNAL_TABLE, { type: 'table', sql: normalizeSql(PROOF_SCHEMA_SQL[3]) }],
  [`sqlite_autoindex_${PROOF_PERMIT_JOURNAL_TABLE}_1`, { type: 'index', sql: null }],
]);
const PROOF_TABLES = [PROOF_RECEIPTS_TABLE, PROOF_FENCES_TABLE, PROOF_PERMIT_TABLE, PROOF_PERMIT_JOURNAL_TABLE] as const;

export type ProofSchemaState = 'present' | 'absent' | 'conflict';

/**
 * Read-only.
 * - `absent`: no object of these names, and nothing on these tables.
 * - `present`: exactly the expected objects.
 * - `conflict`: anything else, including any extra index or trigger on any of these tables. A conflict is never read as
 *   absent.
 */
export function proofSchemaState(db: Database): ProofSchemaState {
  try {
    const names = [...EXPECTED_OBJECTS.keys()];
    const objects = db.prepare(`SELECT type, name, sql FROM main.sqlite_master
      WHERE name COLLATE NOCASE IN (${names.map(() => '?').join(', ')})
        OR ${PROOF_TABLES.map(() => 'tbl_name = ? COLLATE NOCASE').join(' OR ')}`)
      .all(...names, ...PROOF_TABLES) as Array<{ type: unknown; name: unknown; sql: unknown }>;
    if (objects.length === 0) return 'absent';
    const present = objects.length === EXPECTED_OBJECTS.size && objects.every((object) => {
      const expected = typeof object.name === 'string' ? EXPECTED_OBJECTS.get(object.name) : undefined;
      if (!expected || object.type !== expected.type) return false;
      return expected.sql === null ? object.sql === null : typeof object.sql === 'string' && normalizeSql(object.sql) === expected.sql;
    });
    return present ? 'present' : 'conflict';
  } catch (error) {
    throw toValueFreeDbError('read card import proof schema', error);
  }
}

export const PROOF_SCHEMA_REFUSALS = Object.freeze({
  conflict: 'the card import proof tables are in another shape; nothing was changed',
  unverified: 'the card import proof tables could not be verified after creation; nothing was changed',
});

/**
 * Only the operator command calls this, inside its backed-up write. When called alone it runs in an IMMEDIATE
 * transaction of its own.
 * - Present: does nothing.
 * - Conflict: refused.
 * - Otherwise: creates every table and verifies them before the transaction commits.
 */
export function installProofSchema(db: Database): void {
  db.transaction(() => {
    const state = proofSchemaState(db);
    if (state === 'present') return;
    if (state === 'conflict') throw new HoldrRefusal(PROOF_SCHEMA_REFUSALS.conflict);
    for (const sql of PROOF_SCHEMA_SQL) db.exec(sql);
    if (proofSchemaState(db) !== 'present') throw new HoldrRefusal(PROOF_SCHEMA_REFUSALS.unverified);
  }).immediate();
}
