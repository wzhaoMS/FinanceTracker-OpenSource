import type { Database } from 'better-sqlite3';
import { hasAmazonSchema } from './schema.js';
import { currency, digest, minor, refuse } from './policy.js';
import { validTitle } from './products.js';
import type { Money } from './types.js';

/**
 * Amazon Fresh item lists: what each Fresh order's own Item List page (`/uff/your-account/order-details?…&page=itemmod`)
 * listed, line by line, with weights and per-pound prices that ordinary order items can't carry.
 *
 * Additive and apart from the Amazon schema: never part of AMAZON_SCHEMA, never created at boot or by a read. Only a
 * backed-up, Root-GO-gated Fresh write installs it, inside its write transaction, like the product image cache. A
 * read without these exact tables (absent, or any other shape) sees no Fresh list: never repaired, never guessed.
 *
 * - `amazon_fresh_lists`: one validated Item List observation of one order (its digest is its identity, so the same
 *   observation imported twice is one list).
 * - `amazon_fresh_lines`: that observation's lines, by position. A line ref is occurrence identity, like an order
 *   item's: a later observation of the same order has new refs.
 * - `amazon_fresh_orders`: each Fresh order's latest list. Reads count only that list, so a re-observed order is
 *   never counted twice.
 */
const AMAZON_FRESH_SCHEMA_SQL: ReadonlyArray<readonly [string, string]> = [
  ['amazon_fresh_lists', `CREATE TABLE amazon_fresh_lists (
  digest TEXT PRIMARY KEY NOT NULL CHECK(length(digest)=64 AND digest NOT GLOB '*[^a-f0-9]*'),
  order_ref TEXT NOT NULL REFERENCES amazon_orders(ref),
  imported_at TEXT NOT NULL,
  data_json TEXT NOT NULL
)`],
  ['amazon_fresh_lines', `CREATE TABLE amazon_fresh_lines (
  ref TEXT PRIMARY KEY NOT NULL CHECK(length(ref)=52 AND ref GLOB 'amz-*'),
  list_digest TEXT NOT NULL REFERENCES amazon_fresh_lists(digest),
  line_ordinal INTEGER NOT NULL CHECK(line_ordinal BETWEEN 0 AND 199),
  data_json TEXT NOT NULL,
  UNIQUE(list_digest,line_ordinal)
)`],
  ['amazon_fresh_orders', `CREATE TABLE amazon_fresh_orders (
  order_ref TEXT PRIMARY KEY NOT NULL REFERENCES amazon_orders(ref),
  latest_digest TEXT NOT NULL REFERENCES amazon_fresh_lists(digest)
)`],
];
const normalizeSql = (sql: string) => sql.trim().replace(/\s+/g, ' ');
export const AMAZON_FRESH_TABLES: readonly string[] = Object.freeze(AMAZON_FRESH_SCHEMA_SQL.map(([name]) => name));
export const AMAZON_FRESH_SCHEMA_DIGEST = digest(AMAZON_FRESH_SCHEMA_SQL.map(([name, sql]) => [name, normalizeSql(sql)]));

/** Read-only capability detection: all three exact tables, or none of Fresh. A partial or different shape is a hold. */
export function hasAmazonFreshSchema(db: Database): boolean {
  const objects = db.prepare(`SELECT name,type,sql FROM sqlite_master WHERE name IN (${AMAZON_FRESH_TABLES.map(() => '?').join(',')})`)
    .all(...AMAZON_FRESH_TABLES) as Array<{ name: string; type: string; sql: string | null }>;
  return objects.length === AMAZON_FRESH_SCHEMA_SQL.length && AMAZON_FRESH_SCHEMA_SQL.every(([name, sql]) => {
    const object = objects.find(o => o.name === name);
    return object?.type === 'table' && typeof object.sql === 'string' && normalizeSql(object.sql) === normalizeSql(sql);
  });
}
/**
 * Only a backed-up, Root-GO-gated Fresh write calls this, inside its write transaction. It needs the Amazon schema (its
 * orders), never creates it, and refuses any existing object under a Fresh table's name that isn't the exact table.
 */
export function installAmazonFreshSchema(db: Database): void {
  if (!db.inTransaction || !hasAmazonSchema(db)) return refuse();
  if (hasAmazonFreshSchema(db)) return;
  const present = db.prepare(`SELECT 1 FROM sqlite_master WHERE name IN (${AMAZON_FRESH_TABLES.map(() => '?').join(',')})`)
    .get(...AMAZON_FRESH_TABLES);
  if (present) return refuse();
  for (const [, sql] of AMAZON_FRESH_SCHEMA_SQL) db.exec(sql);
  if (!hasAmazonFreshSchema(db)) return refuse();
}

/** At most this many lines in one Fresh order's list. */
export const MAX_FRESH_LINES = 200;
export const FRESH_LINE_STATUSES = ['listed', 'substituted', 'missing'] as const;
export type FreshLineStatus = typeof FRESH_LINE_STATUSES[number];
/** The capture envelope section the lists came from (tools/amazon-capture/amazon-fresh-items.mjs). */
export const FRESH_LIST_FORMAT = 'holdr.amazon-fresh-item-lists';

/**
 * One line of a Fresh order's Item List, as the page showed it; nothing is defaulted or derived.
 *
 * - `status`: `listed` (an ordinary row), `substituted` (delivered in place of `replaces`, when the page names it) or
 *   `missing` (the page marks it not delivered: never counted as spending). The current kit grammar reads only
 *   `listed` rows; a row marked substituted, unavailable or refunded is unread, never guessed.
 * - `quantity`: the page's integer count, else null. `weight`: an exact decimal string; `actual` or `estimated` when
 *   the page says so, `unlabeled` when its column says only "Weight". `unitPrice`: the page's per-each or per-pound
 *   price, else null.
 * - `linePrice`: what the page lists the line at, else null (only for a missing line).
 */
export interface FreshLineRecord {
  lineOrdinal: number;
  title: string;
  asin: string | null;
  status: FreshLineStatus;
  quantity: number | null;
  weight: { value: string; unit: 'lb'; basis: 'actual' | 'estimated' | 'unlabeled' } | null;
  unitPrice: { money: Money; per: 'each' | 'lb' } | null;
  linePrice: Money | null;
  replaces: string | null;
}
/**
 * One Fresh order's Item List observation: where it came from, the count the page stated ("Items in your order (n)"),
 * how many item rows it had, its own proof that every row was read (and the stated count, if any, matches them), and
 * whether its delivered lines add up to the order's own item subtotal.
 */
export interface FreshListRecord {
  provenance: { format: typeof FRESH_LIST_FORMAT; version: 1; runId: string; page: 'uff-itemmod' };
  statedCount: number | null;
  rows: number;
  proof: { complete: boolean; unreadRows: number };
  reconciled: boolean;
  lines: number;
}

const has = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => Boolean(value)
  && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value as object).sort().join('|') === [...keys].sort().join('|');
const count = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value)
  && value >= 0 && value <= max;
/** A USD-style amount: a currency code and nonnegative minor units no larger than $1,000,000. */
const money = (value: unknown): value is Money => has(value, ['currency', 'amountMinor']) && currency(value.currency)
  && minor(value.amountMinor) && value.amountMinor >= 0 && value.amountMinor <= 100000000;
/** A positive decimal weight, at most six fractional digits, as the page wrote it. */
export const freshWeight = (value: unknown): value is string => typeof value === 'string'
  && /^(?:0|[1-9]\d{0,5})(?:\.\d{1,6})?$/.test(value) && /[1-9]/.test(value);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

/**
 * Each Fresh order's latest list's readable lines, as product observations (`{ itemId, title }`, as an order item's):
 * what the taxonomy may classify. Empty without the exact Fresh tables.
 */
export function freshProductObservations(db: Database): Array<{ itemId: string | null; title: string }> {
  if (!hasAmazonSchema(db) || !hasAmazonFreshSchema(db)) return [];
  const rows = db.prepare(`SELECT n.data_json FROM amazon_fresh_lines n
    JOIN amazon_fresh_orders f ON f.latest_digest=n.list_digest ORDER BY n.ref`).pluck().all() as string[];
  return rows.flatMap(text => {
    const line = freshLineRecord(JSON.parse(text));
    return line ? [{ itemId: line.asin, title: line.title }] : [];
  });
}

/** A stored Fresh line, checked whole; null for anything else, so a read never trusts a malformed row. */
export function freshLineRecord(value: unknown): FreshLineRecord | null {
  if (!has(value, ['lineOrdinal', 'title', 'asin', 'status', 'quantity', 'weight', 'unitPrice', 'linePrice', 'replaces'])) return null;
  const v = value;
  if (!count(v.lineOrdinal, MAX_FRESH_LINES - 1) || !validTitle(v.title)
    || (v.asin !== null && (typeof v.asin !== 'string' || !/^[A-Z0-9]{10}$/.test(v.asin)))
    || !(FRESH_LINE_STATUSES as readonly unknown[]).includes(v.status)
    || (v.quantity !== null && (!count(v.quantity, 999) || v.quantity === 0))
    || (v.weight !== null && !(has(v.weight, ['value', 'unit', 'basis']) && freshWeight(v.weight.value) && v.weight.unit === 'lb'
      && ['actual', 'estimated', 'unlabeled'].includes(v.weight.basis as string)))
    || (v.unitPrice !== null && !(has(v.unitPrice, ['money', 'per']) && money(v.unitPrice.money)
      && (v.unitPrice.per === 'each' || (v.unitPrice.per === 'lb' && v.weight !== null))))
    || (v.linePrice === null ? v.status !== 'missing' : !money(v.linePrice))
    || (v.replaces !== null && (v.status !== 'substituted' || !validTitle(v.replaces)))) return null;
  return value as unknown as FreshLineRecord;
}
/** A stored Fresh list observation, checked whole; null for anything else. */
export function freshListRecord(value: unknown): FreshListRecord | null {
  if (!has(value, ['provenance', 'statedCount', 'rows', 'proof', 'reconciled', 'lines'])) return null;
  const v = value;
  if (!has(v.provenance, ['format', 'version', 'runId', 'page']) || v.provenance.format !== FRESH_LIST_FORMAT
    || v.provenance.version !== 1 || typeof v.provenance.runId !== 'string' || !UUID.test(v.provenance.runId)
    || v.provenance.page !== 'uff-itemmod'
    || (v.statedCount !== null && !count(v.statedCount, 999)) || !count(v.rows, MAX_FRESH_LINES) || v.rows === 0
    || !has(v.proof, ['complete', 'unreadRows']) || typeof v.proof.complete !== 'boolean' || !count(v.proof.unreadRows, MAX_FRESH_LINES)
    || !count(v.lines, MAX_FRESH_LINES) || v.lines + v.proof.unreadRows !== v.rows
    || v.proof.complete !== (v.proof.unreadRows === 0 && (v.statedCount === null || v.statedCount === v.rows))
    || typeof v.reconciled !== 'boolean' || (v.reconciled && !v.proof.complete)) return null;
  return value as unknown as FreshListRecord;
}
