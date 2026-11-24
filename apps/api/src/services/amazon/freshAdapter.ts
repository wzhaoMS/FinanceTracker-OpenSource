import type { Database } from 'better-sqlite3';
import { hasAmazonSchema } from './schema.js';
import {
  freshLineRecord,
  freshListRecord,
  hasAmazonFreshSchema,
  type FreshLineRecord,
  type FreshListRecord,
} from './freshSchema.js';
import type { OrderObservation } from './types.js';

export type { FreshLineRecord, FreshLineStatus, FreshListRecord } from './freshSchema.js';

/**
 * The one module through which Holdr's reads (the Fresh tab's read model, the taxonomy worklist) reach Amazon Fresh
 * Item Lists: the additive tables of the Fresh import (freshSchema.ts, with freshImport.ts): `amazon_fresh_lists`,
 * `amazon_fresh_lines` and `amazon_fresh_orders`. Only that backed-up, Root-GO-gated import creates them, so they may be
 * absent; this module only reads. It never creates, repairs or migrates anything: without those exact tables (absent,
 * or any other shape) no Fresh list was imported, and every read here is empty, never an error.
 *
 * Every stored row is checked whole by the import's own validators (freshListRecord, freshLineRecord). A row that
 * fails is counted as unreadable, never trusted, repaired or guessed.
 */

/** Whether any Fresh Item List was ever imported: the Amazon schema and the Fresh import's exact tables. */
export function freshListsCaptured(db: Database): boolean {
  return hasAmazonSchema(db) && hasAmazonFreshSchema(db);
}

export interface FreshLineRead extends FreshLineRecord {
  /** The line's opaque ref: occurrence identity, like an order item's. */
  ref: string;
}
export interface FreshOrderRead {
  /** The order's opaque ref. */
  ref: string;
  /** Amazon's own order number: only to find the order's refund evidence. It never leaves the API. */
  orderId: string;
  order: OrderObservation;
  /** The order's active list, as its record was stored; null when that record can't be read. */
  list: FreshListRecord | null;
  // STEP 9 integration (B6)
  /** The active list's readable lines, by position; none while the order displays a charge-free proof. */
  lines: FreshLineRead[];
  /** Its stored lines that can't be read: malformed, or not at the position their row says. */
  unreadable: number;
}
/** A window of order dates (inclusive), one order, or every Fresh order. */
export type FreshOrderScope = { from: string; to: string } | { orderRef: string } | 'all';

interface StoredOrder { ref: string; orderId: string; orderJson: string; listDigest: string; listJson: string | null }
interface StoredLine { ref: string; ordinal: number; data: string }

/** Stored JSON, or undefined when it isn't JSON at all (a validator then refuses it like any other malformed row). */
function stored(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/**
 * Each Fresh order's active list (the one `amazon_fresh_orders` names, so a re-observed order counts once), newest
 * order first: in a window of Amazon's order dates, one order by ref, or all of them. Empty without the Fresh tables.
 * A list that isn't the order's own reads as unreadable, with none of its lines.
 *
 * STEP 9 integration B6 (#158 x #157/#169): while the order's displayed decision is an effective charge-free proof (its
 * displayed observation carries `chargeFree`; a contradicted proof is displayed without it), its active list is
 * retained history and none of its stored lines is read, so every Fresh consumer counts the order's lines, products
 * and money as 0. A revocation replaces the display and the same list reads again, exactly.
 */
export function readFreshOrders(db: Database, scope: FreshOrderScope): FreshOrderRead[] {
  if (!freshListsCaptured(db)) return [];
  const [where, args]: [string, unknown[]] = scope === 'all' ? ['1', []]
    : 'orderRef' in scope ? ['f.order_ref=?', [scope.orderRef]]
      : ["json_extract(o.data_json,'$.date') BETWEEN ? AND ?", [scope.from, scope.to]];
  const orders = db.prepare(`SELECT f.order_ref AS ref,o.native_id AS orderId,o.data_json AS orderJson,
      f.latest_digest AS listDigest,l.data_json AS listJson
    FROM amazon_fresh_orders f JOIN amazon_orders o ON o.ref=f.order_ref
    LEFT JOIN amazon_fresh_lists l ON l.digest=f.latest_digest AND l.order_ref=f.order_ref
    WHERE ${where} ORDER BY json_extract(o.data_json,'$.date') DESC,f.order_ref`).all(...args) as StoredOrder[];
  const lines = db.prepare(`SELECT ref,line_ordinal AS ordinal,data_json AS data FROM amazon_fresh_lines
    WHERE list_digest=? ORDER BY line_ordinal,ref`);
  return orders.map((row) => {
    const read: FreshOrderRead = { ref: row.ref, orderId: row.orderId, order: JSON.parse(row.orderJson) as OrderObservation,
      list: row.listJson === null ? null : freshListRecord(stored(row.listJson)), lines: [], unreadable: 0 };
    // STEP 9 integration (B6)
    if (row.listJson === null || read.order.chargeFree) return read;
    for (const line of lines.all(row.listDigest) as StoredLine[]) {
      const record = freshLineRecord(stored(line.data));
      if (record && record.lineOrdinal === line.ordinal) read.lines.push({ ...record, ref: line.ref });
      else read.unreadable++;
    }
    return read;
  });
}

/**
 * Every Fresh order's active list's readable lines, as product observations (`{ itemId, title }`, as an order item's):
 // STEP 9 integration (B6)
 * exactly the lines the Fresh tab reads (none of an order displayed as charge-free).
 * STEP 9 integration B8 (Root): with every other list the import retained, what the item taxonomy may classify
 * (freshRetainedObservations).
 * Empty without the Fresh tables.
 */
export function freshTaxonomyObservations(db: Database): Array<{ itemId: string | null; title: string }> {
  return readFreshOrders(db, 'all').flatMap((read) => read.lines.map((line) => ({ itemId: line.asin, title: line.title })));
}

/** STEP 9 integration B8 (Root): one Item List read of a Fresh order, displayed or not. */
export interface FreshListRead {
  /** The order's opaque ref. */
  orderRef: string;
  /** Whether it is the order's active list (`amazon_fresh_orders`). */
  active: boolean;
  /** Its readable lines (checked whole, at their position), as product observations. */
  lines: Array<{ itemId: string | null; title: string }>;
}
/**
 * STEP 9 integration B8 (Root): every Item List read the Fresh import retained, displayed or not, by order and in import
 * order (`amazon_fresh_lists.rowid`): the active list, a list a better-proven read replaced, a poorer re-read, and a
 * re-read held because a decision the active list shows could not follow it (B4, `taxonomy-unmatched`). The active list
 * of an order displayed as charge-free is read too (B6 hides it from what is counted, not from its history). Provenance,
 * never display: what the taxonomy's key changes read, as they read every capture's order observations. Each list's own
 * lines only. Empty without the Fresh tables.
 */
export function freshListReads(db: Database): FreshListRead[] {
  if (!freshListsCaptured(db)) return [];
  const lists = db.prepare(`SELECT l.order_ref AS orderRef,l.digest,f.latest_digest IS l.digest AS active
    FROM amazon_fresh_lists l JOIN amazon_orders o ON o.ref=l.order_ref
    LEFT JOIN amazon_fresh_orders f ON f.order_ref=l.order_ref ORDER BY l.order_ref,l.rowid`).all() as
    Array<{ orderRef: string; digest: string; active: number }>;
  const lines = db.prepare(`SELECT ref,line_ordinal AS ordinal,data_json AS data FROM amazon_fresh_lines
    WHERE list_digest=? ORDER BY line_ordinal,ref`);
  return lists.map((list) => ({ orderRef: list.orderRef, active: list.active === 1,
    lines: (lines.all(list.digest) as StoredLine[]).flatMap((line) => {
      const record = freshLineRecord(stored(line.data));
      return record && record.lineOrdinal === line.ordinal ? [{ itemId: record.asin, title: record.title }] : [];
    }) }));
}
/**
 * STEP 9 integration B8 (Root): what the item taxonomy may classify of Amazon Fresh, as product observations: every
 * active list's lines exactly as the Fresh tab reads them (freshTaxonomyObservations: none while the order displays a
 * charge-free proof, B6), and every other list the import retained (freshListReads), held re-reads included, so a held
 * line's learned key reaches the GO'd taxonomy import. Empty without the Fresh tables.
 */
export function freshRetainedObservations(db: Database): Array<{ itemId: string | null; title: string }> {
  return [...freshTaxonomyObservations(db), ...freshListReads(db).filter((read) => !read.active).flatMap((read) => read.lines)];
}
