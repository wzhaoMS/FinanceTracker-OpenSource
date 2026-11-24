import Database from 'better-sqlite3';

import { toValueFreeDbError } from '../dbErrors.js';
import { schemaObjects, schemaState, type DeclaredSchema } from '../schemaShape.js';
import { MetalsRefusal } from './common.js';
import { METALS_SCHEMA_DIGEST, METALS_SCHEMA_SQL, metalsSchemaObjects, metalsSchemaState } from './schema.js';
import { METALS_SCHEMA_INTERIM_V0 } from './schemaInterimV0.js';

/**
 * The swap of the interim v0 ledger for version 1 (`holdr-metals reinstall`; the reinstall design delta, r1, approved by
 * ROOT). Version 1 can't keep anything v0 holds (contract follow-up 1E refuses every v0 payload, and every import row
 * now carries the title guard's rule), so v0's data comes back only by re-conversion and re-import: the swap drops
 * exactly v0's objects and creates version 1, in one transaction, and nothing else.
 */

/** v0's declaration for the shared comparison: the prefix of version 1, v0's frozen statements. */
const INTERIM: DeclaredSchema = Object.freeze({ prefix: 'metals_', statements: METALS_SCHEMA_INTERIM_V0.statements });

export const METALS_INTERIM_V0_DIGEST: string = METALS_SCHEMA_INTERIM_V0.digest;
export const METALS_REINSTALL_PURPOSES = Object.freeze(['copy-rehearsal', 'production-reinstall'] as const);
export type MetalsReinstallPurpose = (typeof METALS_REINSTALL_PURPOSES)[number];
/** The most rows a GO may acknowledge for one table. */
const MAX_COUNT = 1_000_000_000;

export interface MetalsInterimObjects {
  /** In creation order. */
  readonly tables: readonly string[];
  /** The declared indexes; each automatic index goes with its table. */
  readonly indexes: readonly string[];
  readonly triggers: readonly string[];
}

let interimObjects: MetalsInterimObjects | null = null;

/** v0's objects by kind, as SQLite records them when v0's statements run in a private in-memory database (once). */
export function metalsInterimObjects(): MetalsInterimObjects {
  if (interimObjects === null) {
    const memory = new Database(':memory:');
    try {
      for (const sql of METALS_SCHEMA_INTERIM_V0.statements) memory.exec(sql);
      const rows = memory.prepare('SELECT type, name, sql FROM main.sqlite_master ORDER BY rowid').all() as Array<{ type: string; name: string; sql: string | null }>;
      interimObjects = Object.freeze({
        tables: Object.freeze(rows.filter((row) => row.type === 'table').map((row) => row.name)),
        indexes: Object.freeze(rows.filter((row) => row.type === 'index' && row.sql !== null).map((row) => row.name)),
        triggers: Object.freeze(rows.filter((row) => row.type === 'trigger').map((row) => row.name)),
      });
    } finally {
      memory.close();
    }
  }
  return interimObjects;
}

/** Each v0 table's rows, by table name: value-free counts. */
export type MetalsReinstallCounts = Readonly<Record<string, number>>;

export interface MetalsReinstallPlan {
  readonly from: { readonly digest: string; readonly objects: number };
  readonly to: { readonly digest: string; readonly objects: number };
  readonly counts: MetalsReinstallCounts;
  /**
   * v0's active bindings by kind (O97): the swap drops them with everything else, so the runbook re-records each one
   * through `bindings propose` and an approval GO and checks `report`'s active bindings against these counts.
   */
  readonly activeBindings: { readonly card: number; readonly checking: number };
}

export interface MetalsReinstallReceipt extends MetalsReinstallPlan {
  readonly dropped: { readonly tables: number; readonly indexes: number; readonly triggers: number };
}

/** A GO's `counts`: exactly v0's tables, each an integer from 0 to 10^9, else null. */
export function metalsReinstallCounts(value: unknown): MetalsReinstallCounts | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { tables } = metalsInterimObjects();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== tables.length || !tables.every((table) => Object.hasOwn(record, table))) return null;
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const count = record[table];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > MAX_COUNT) return null;
    counts[table] = count;
  }
  return Object.freeze(counts);
}

const sameCounts = (left: MetalsReinstallCounts, right: MetalsReinstallCounts): boolean =>
  metalsInterimObjects().tables.every((table) => left[table] === right[table]);

const isMetalsName = (name: string): boolean => name.toLowerCase().startsWith('metals_');

/** Every schema row neither named metals_… nor on a metals_ table, in a stable order: what the swap leaves as it is. */
function otherSchemaRows(db: Database.Database): string {
  return JSON.stringify(db.prepare(`SELECT type, name, tbl_name, sql FROM main.sqlite_master
    WHERE NOT (lower(name) LIKE 'metals\\_%' ESCAPE '\\' OR lower(tbl_name) LIKE 'metals\\_%' ESCAPE '\\') ORDER BY type, name`).all());
}

/** The whole database's foreign-key violations, by the child table only (SQLite checks them whether or not enforced). */
const foreignKeyViolations = (db: Database.Database): string[] =>
  (db.pragma('foreign_key_check') as Array<{ table: string }>).map((row) => row.table);

/**
 * Read-only (in its own read transaction, or a savepoint inside a caller's): the swap's plan when the ledger is exactly
 * v0 (the shared comparison against v0's declaration finds every object and nothing else), else null. `plan` prints it;
 * a reinstall GO pins its counts.
 */
export function planMetalsReinstall(db: Database.Database): MetalsReinstallPlan | null {
  try {
    return db.transaction((): MetalsReinstallPlan | null => {
      const interim = schemaObjects(db, INTERIM, 'read metals schema');
      if (schemaState(interim) !== 'present') return null;
      const counts: Record<string, number> = {};
      for (const table of metalsInterimObjects().tables) {
        counts[table] = db.prepare(`SELECT count(*) FROM main."${table}"`).pluck().get() as number;
      }
      const active = db.prepare("SELECT count(*) FROM main.metals_bindings WHERE state = 'active' AND kind = ?").pluck();
      return {
        from: { digest: METALS_INTERIM_V0_DIGEST, objects: interim.expected },
        to: { digest: METALS_SCHEMA_DIGEST, objects: metalsSchemaObjects(db).expected },
        counts: Object.freeze(counts),
        activeBindings: Object.freeze({ card: active.get('card') as number, checking: active.get('checking') as number }),
      };
    })();
  } catch (error) {
    throw toValueFreeDbError('read metals schema', error);
  }
}

/**
 * The read-only preflight, before any backup: `installed` when version 1 is already present (no backup, no write);
 * else the plan, or a refusal: nothing installed (metals-not-installed), anything but exactly v0 (metals-conflict),
 * counts other than the GO's (metals-go-mismatch), or a foreign-key violation outside the metals tables, which the
 * swap's own check would refuse (metals-foreign-keys-unclean, a count only).
 */
export function preflightMetalsReinstall(db: Database.Database, counts: MetalsReinstallCounts): 'installed' | MetalsReinstallPlan {
  const state = metalsSchemaState(db);
  if (state === 'present') return 'installed';
  if (state === 'absent') throw new MetalsRefusal('metals-not-installed');
  const plan = planMetalsReinstall(db);
  if (plan === null) throw new MetalsRefusal('metals-conflict');
  if (!sameCounts(plan.counts, counts)) throw new MetalsRefusal('metals-go-mismatch');
  const violations = foreignKeyViolations(db).filter((table) => !isMetalsName(table)).length;
  if (violations > 0) throw new MetalsRefusal('metals-foreign-keys-unclean', { violations });
  return plan;
}

/** Where a test may stop the swap (production passes no probe). */
export type MetalsReinstallPoint = 'checked' | 'dropped' | 'created';

/**
 * The swap, inside fencedMetalsWrite's IMMEDIATE transaction, on a connection whose foreign-key enforcement the caller
 * turned off before BEGIN (SQLite ignores the pragma inside a transaction): DROP TABLE then deletes no row and fires
 * nothing, so accounts and imports, which reference each other, drop in any order. In order:
 * 1. the plan again: exactly v0, with the GO's counts, else metals-plan-changed;
 * 2. every v0 trigger, then every declared index, then every table, dropped by name with no IF EXISTS; nothing named
 *    metals_… may remain;
 * 3. version 1 created, from install's own statements;
 * 4. verified: version 1 present, every other schema row exactly as before, and the whole database's foreign_key_check
 *    empty; else metals-reinstall-unverified.
 * Any throw rolls the whole transaction back: the ledger stays v0, whole.
 */
export function reinstallMetalsSchema(db: Database.Database, counts: MetalsReinstallCounts,
  probe?: (point: MetalsReinstallPoint) => void): MetalsReinstallReceipt {
  if (!db.inTransaction) throw new MetalsRefusal('metals-unfenced');
  if (db.pragma('foreign_keys', { simple: true }) !== 0) throw new MetalsRefusal('metals-foreign-keys-on');
  const others = otherSchemaRows(db);
  const plan = planMetalsReinstall(db);
  if (plan === null || !sameCounts(plan.counts, counts)) throw new MetalsRefusal('metals-plan-changed');
  probe?.('checked');
  const objects = metalsInterimObjects();
  for (const name of objects.triggers) db.exec(`DROP TRIGGER main."${name}"`);
  for (const name of objects.indexes) db.exec(`DROP INDEX main."${name}"`);
  for (const name of [...objects.tables].reverse()) db.exec(`DROP TABLE main."${name}"`);
  if (metalsSchemaState(db) !== 'absent') throw new MetalsRefusal('metals-reinstall-unverified');
  probe?.('dropped');
  for (const sql of METALS_SCHEMA_SQL) db.exec(sql);
  probe?.('created');
  if (metalsSchemaState(db) !== 'present' || otherSchemaRows(db) !== others || foreignKeyViolations(db).length !== 0) {
    throw new MetalsRefusal('metals-reinstall-unverified');
  }
  return { ...plan, dropped: { tables: objects.tables.length, indexes: objects.indexes.length, triggers: objects.triggers.length } };
}
