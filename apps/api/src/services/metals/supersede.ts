import type { Database } from 'better-sqlite3';
import type { MetalsOrder, MetalsSource } from '@finance-tracker/shared/metals-ledger';

import { digest } from '../amazon/policy.js';
import { toValueFreeDbError } from '../dbErrors.js';
import { HEX64, MetalsRefusal, checkWriteContext, lettersOfHex } from './common.js';
import { deleteMetalsProjection, metalsProjectionClashes, writeMetalsProjection } from './projection.js';
import { METALS_VERSION_STATES, requireMetalsSchema } from './schema.js';

/**
 * `holdr-metals supersede` (design v8 §7): resolves the proposals and conflicts one import created, for one order or all
 * of them, under a Root GO. `incoming`: each pending version becomes active and keeps the GO that chose it
 * (`chosen_by_go`, `chosen_at`, never changed after), the active one is superseded (`replaced`, with that GO) and the
 * order's projection is rewritten from the chosen version. `active`: each pending version is superseded (`declined`,
 * with the GO) and the active one stays. A chosen version later progresses like any other (`progressed`, no GO) and
 * keeps its choice. Nothing is deleted; every version stays for audit, and an order is
 * quarantined exactly while some version of it is in state `conflict`. The plan lists before and after counts only, and
 * the write computes it again inside its transaction.
 */

export const METALS_SUPERSEDE_PURPOSES = ['copy-rehearsal', 'production-supersede'] as const;
export type MetalsSupersedePurpose = (typeof METALS_SUPERSEDE_PURPOSES)[number];

export interface MetalsSupersedeRequest {
  importId: string;
  /** One order of that import, or null for all of its pending versions. */
  orderKey: string | null;
  choose: 'incoming' | 'active';
}

export interface MetalsSupersedeContext {
  now: string;
  goId: string;
  purpose: MetalsSupersedePurpose;
  planDigest: string | null;
}

/** Counts over the orders a supersede touches. */
export interface MetalsSupersedeCounts {
  active: number;
  superseded: number;
  proposed: number;
  conflict: number;
  quarantined: number;
  lots: number;
  dispositions: number;
}

export interface MetalsSupersedePlan {
  importId: string;
  choose: 'incoming' | 'active';
  alreadyResolved: boolean;
  orders: number;
  /** Pending versions older than their order's active version (the active one changed since they were stored). */
  olderThanActive: number;
  before: MetalsSupersedeCounts;
  after: MetalsSupersedeCounts;
  planDigest: string;
}

export interface MetalsSupersedeReceipt extends MetalsSupersedePlan {
  code: 'metals-superseded' | 'metals-already-resolved';
}

export const METALS_IMPORT_ID = /^mtl-imp-[a-p]{32}$/;
export const METALS_ORDER_KEY = /^(?:costco-order|costco-receipt|walmart-order|collectpure-sell)-[a-p]{64}$/;

interface VersionRow {
  orderKey: string;
  version: number;
  state: (typeof METALS_VERSION_STATES)[number];
  source: MetalsSource;
  side: 'buy' | 'sell';
  canonicalJson: string;
  createdBy: string;
}

interface Prepared {
  pending: VersionRow[];
  active: Map<string, VersionRow>;
  plan: MetalsSupersedePlan;
}

function checkRequest(request: MetalsSupersedeRequest): void {
  if (typeof request.importId !== 'string' || !METALS_IMPORT_ID.test(request.importId)
    || (request.orderKey !== null && (typeof request.orderKey !== 'string' || !METALS_ORDER_KEY.test(request.orderKey)))
    || (request.choose !== 'incoming' && request.choose !== 'active')) throw new MetalsRefusal('metals-supersede-invalid');
}

const linesOf = (row: VersionRow) => (JSON.parse(row.canonicalJson) as MetalsOrder).lines.length;

function counts(versions: readonly VersionRow[], projection: ReadonlyMap<string, { lots: number; dispositions: number }>): MetalsSupersedeCounts {
  const result: MetalsSupersedeCounts = { active: 0, superseded: 0, proposed: 0, conflict: 0, quarantined: 0, lots: 0, dispositions: 0 };
  for (const row of versions) result[row.state] += 1;
  result.quarantined = new Set(versions.filter((row) => row.state === 'conflict').map((row) => row.orderKey)).size;
  for (const entry of projection.values()) {
    result.lots += entry.lots;
    result.dispositions += entry.dispositions;
  }
  return result;
}

function prepare(db: Database, request: MetalsSupersedeRequest): Prepared {
  checkRequest(request);
  if (!db.prepare('SELECT 1 FROM metals_imports WHERE import_id = ?').get(request.importId)) throw new MetalsRefusal('metals-import-unknown');
  const select = `SELECT order_key AS orderKey, version, state, source, side, canonical_json AS canonicalJson, created_by_import AS createdBy
    FROM metals_order_versions`;
  const created = (request.orderKey === null
    ? db.prepare(`${select} WHERE created_by_import = ? AND reason IN ('proposal', 'conflict') ORDER BY order_key`).all(request.importId)
    : db.prepare(`${select} WHERE created_by_import = ? AND reason IN ('proposal', 'conflict') AND order_key = ?`).all(request.importId, request.orderKey)
  ) as VersionRow[];
  if (request.orderKey !== null && created.length === 0) throw new MetalsRefusal('metals-order-not-pending');
  const pending = created.filter((row) => row.state === 'proposed' || row.state === 'conflict');
  if (request.choose === 'incoming') {
    const clashes = pending.filter((row) => metalsProjectionClashes(db, JSON.parse(row.canonicalJson) as MetalsOrder));
    if (clashes.length > 0) throw new MetalsRefusal('metals-key-conflict', { orders: clashes.slice(0, 20).map((row) => row.orderKey) });
  }
  const keys = [...new Set(pending.map((row) => row.orderKey))];
  const versions = keys.flatMap((key) => db.prepare(`${select} WHERE order_key = ? ORDER BY version`).all(key) as VersionRow[]);
  const active = new Map(versions.filter((row) => row.state === 'active').map((row) => [row.orderKey, row]));
  if (keys.some((key) => !active.has(key))) throw new MetalsRefusal('metals-version-state-invalid');
  const projection = new Map(keys.map((key) => [key, {
    lots: db.prepare('SELECT count(*) FROM metals_lots WHERE order_key = ?').pluck().get(key) as number,
    dispositions: db.prepare('SELECT count(*) FROM metals_dispositions WHERE order_key = ?').pluck().get(key) as number,
  }]));
  const before = counts(versions, projection);
  const chosen = new Map(pending.map((row) => [`${row.orderKey}\u0000${row.version}`, row]));
  const afterVersions = versions.map((row): VersionRow => {
    if (chosen.has(`${row.orderKey}\u0000${row.version}`)) return { ...row, state: request.choose === 'incoming' ? 'active' : 'superseded' };
    if (request.choose === 'incoming' && row.state === 'active') return { ...row, state: 'superseded' };
    return row;
  });
  const afterProjection = request.choose === 'active' ? projection : new Map(pending.map((row) => [row.orderKey, {
    lots: row.side === 'buy' ? linesOf(row) : 0,
    dispositions: row.side === 'sell' ? linesOf(row) : 0,
  }]));
  const plan: MetalsSupersedePlan = {
    importId: request.importId,
    choose: request.choose,
    alreadyResolved: pending.length === 0,
    orders: keys.length,
    olderThanActive: pending.filter((row) => row.version < active.get(row.orderKey)!.version).length,
    before,
    after: pending.length === 0 ? before : counts(afterVersions, afterProjection),
    planDigest: digest({
      importId: request.importId, orderKey: request.orderKey, choose: request.choose,
      pending: pending.map((row) => [row.orderKey, row.version, row.state]),
      active: keys.map((key) => [key, active.get(key)!.version]),
    }),
  };
  return { pending, active, plan };
}

/** Read-only: what the supersede would do, or the refusal it would meet. Requires the installed tables. */
export function planMetalsSupersede(db: Database, request: MetalsSupersedeRequest): MetalsSupersedePlan {
  requireMetalsSchema(db);
  try {
    return db.transaction(() => prepare(db, request).plan)();
  } catch (error) {
    if (error instanceof MetalsRefusal) throw error;
    throw toValueFreeDbError('plan metals supersede', error);
  }
}

/** Resolves the import's pending versions (inside the operator's backed-up IMMEDIATE transaction, or one of its own). */
export function supersedeMetalsVersions(db: Database, request: MetalsSupersedeRequest, context: MetalsSupersedeContext): MetalsSupersedeReceipt {
  checkWriteContext(context, METALS_SUPERSEDE_PURPOSES);
  if (context.planDigest !== null && (typeof context.planDigest !== 'string' || !HEX64.test(context.planDigest))) {
    throw new MetalsRefusal('metals-plan-digest-invalid');
  }
  requireMetalsSchema(db);
  try {
    return db.transaction((): MetalsSupersedeReceipt => {
      const { pending, active, plan } = prepare(db, request);
      if (context.planDigest !== null && plan.planDigest !== context.planDigest) throw new MetalsRefusal('metals-plan-changed');
      if (plan.alreadyResolved) return { code: 'metals-already-resolved', ...plan };
      const go = lettersOfHex(context.goId);
      const replace = db.prepare(`UPDATE metals_order_versions SET state = 'superseded', resolution = 'replaced', resolved_by_go = ?, resolved_at = ?
        WHERE order_key = ? AND version = ? AND state = 'active'`);
      const decline = db.prepare(`UPDATE metals_order_versions SET state = 'superseded', resolution = 'declined', resolved_by_go = ?, resolved_at = ?
        WHERE order_key = ? AND version = ? AND state = ?`);
      // A choice records the newest import at the time it was made (corrections r6 §2.4), read inside this fence.
      const choose = db.prepare(`UPDATE metals_order_versions SET state = 'active', chosen_by_go = ?, chosen_at = ?,
        chosen_seq = (SELECT max(import_seq) FROM metals_imports)
        WHERE order_key = ? AND version = ? AND state = ? AND chosen_by_go IS NULL`);
      const accountOf = db.prepare('SELECT account_id FROM metals_imports WHERE import_id = ?').pluck();
      for (const row of pending) {
        if (request.choose === 'active') {
          if (decline.run(go, context.now, row.orderKey, row.version, row.state).changes !== 1) throw new MetalsRefusal('metals-plan-changed');
          continue;
        }
        const current = active.get(row.orderKey)!;
        if (replace.run(go, context.now, current.orderKey, current.version).changes !== 1
          || choose.run(go, context.now, row.orderKey, row.version, row.state).changes !== 1) {
          throw new MetalsRefusal('metals-plan-changed');
        }
        deleteMetalsProjection(db, row.orderKey);
        writeMetalsProjection(db, JSON.parse(row.canonicalJson) as MetalsOrder, row.version, accountOf.get(row.createdBy) as string, row.source);
      }
      return { code: 'metals-superseded', ...plan };
    }).immediate();
  } catch (error) {
    if (error instanceof MetalsRefusal) throw error;
    throw toValueFreeDbError('supersede metals versions', error);
  }
}
