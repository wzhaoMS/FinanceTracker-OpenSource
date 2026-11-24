import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { HoldrRefusal, toValueFreeDbError } from '../dbErrors.js';
import { orderObservationScope, type ValidatedCapture } from './capture.js';
import { SCOPE_HOLD_REASONS } from './allocation.js';
import { projectRefunds, revokeContradictedProofs, writeValidatedCapture, type ImportReceipt } from './importer.js';
import { reconcileAmazon } from './matcher.js';
import { digest, exact, opaque, POLICY_DIGEST, refuse, SOURCE } from './policy.js';
import { ensureAmazonSchema, hasAmazonSchema } from './schema.js';
import type { OrderObservation } from './types.js';

/**
 * Batch import of targeted detail re-reads, and its clone preview (Root, after #208). A re-read of an order the
 * household already has is imported only so the order's displayed items gain captured image IDs, and Root's rule is that
 * such an import changes nothing else. So each capture's import runs in its own transaction and is classified from
 * exactly what it changed: the order's display, and a change log of every row of every table, compared byte for byte
 * with what the importer writes for that capture. It is kept only when its class is `image-ids-only`; any other class
 * rolls that transaction back. `preview-batch` runs this on a clone it made itself, so its classes are the ones a GO'd
 * batch of the image-IDs-only captures meets. `import-batch` runs it on the database and stops at the first capture it
 * refuses. Every result is value-free: closed classes and kinds, counts and digests.
 */
export const BATCH_CAPTURE_MAX = 50;
export const PREVIEW_CAPTURE_MAX = 500;
/** Closed kinds of change, in report order. */
export const BATCH_CHANGE_KINDS = Object.freeze([
  'order-new', 'order-date', 'order-total', 'order-items', 'order-methods', 'order-summary', 'order-refund-total',
  'order-charge-free', 'order-proofs', 'order-other', 'order-stored-form', 'image-ids-replaced', 'image-ids-removed',
  'other-orders', 'history-changed', 'payment-evidence', 'refund-evidence', 'refund-events', 'refund-status-regressed',
  'refund-total-decreased', 'subjects', 'card-links', 'card-candidates', 'allocations', 'categories',
  'item-category-unmatched', 'taxonomy', 'taxonomy-unmatched', 'charge-free', 'fresh-lists', 'other-amazon',
  'non-amazon', 'schema', 'audit-other',
] as const);
export type BatchChangeKind = typeof BATCH_CHANGE_KINDS[number];
export type BatchClass = 'image-ids-only' | 'facts-changed' | 'no-new-image-ids' | 'already-imported';
export interface ImageIdCounts { added: number; replaced: number; removed: number }
export interface BatchClassification {
  class: BatchClass;
  /** The order's display: shown for the first time, replaced by this capture, or kept as it was. */
  display: 'new' | 'replaced' | 'kept';
  /** Displayed lines whose captured image ID the display gained, changed or lost. */
  imageIds: ImageIdCounts;
  changed: BatchChangeKind[];
}
export interface ClassifiedCapture { receipt: ImportReceipt; classification: BatchClassification }
/** The refusal that rolls back a capture whose import is not image-IDs-only; its result is left in the caller's `out`. */
export const BATCH_CAPTURE_REFUSED = 'amazon batch capture is not image-ids-only';

export const canonicalPath = (file: string): string =>
  process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
/**
 * The operator's private, ordered list of staged capture files: `{ format, version, captures }`, absolute paths, each
 * once. It is never printed; a GO pins the captures' digests, never their paths.
 */
export function readCaptureList(value: unknown, max: number): string[] {
  const list = exact(value, ['format', 'version', 'captures']);
  if (list.format !== 'holdr.amazon-capture-list' || list.version !== 1 || !Array.isArray(list.captures)
    || list.captures.length < 1 || list.captures.length > max) return refuse();
  const files = list.captures as unknown[], seen = new Set<string>();
  for (const file of files) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || seen.has(canonicalPath(file))) return refuse();
    seen.add(canonicalPath(file));
  }
  return files as string[];
}
/**
 * A targeted detail re-read as the producer drains one (the capture kit's value-first targeted detail re-reads and
 * proof-retry checks): a v3 backfill slice that continues a saved cursor, made of one
 * detail request, with exactly one order, no payments and no Fresh lists. Refund evidence may come with it, and the
 * classifier reports it. Checked on an input that already passed validateCapture.
 */
export function isRereadCapture(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Object.hasOwn(input, 'fresh') || !Object.hasOwn(input, 'continuation')) return false;
  const c = input as { structure?: { requests?: unknown; pages?: unknown };
    staging?: { version?: unknown; mode?: unknown; orders?: unknown; payments?: unknown }; continuation?: { before?: unknown } };
  const pages = c.structure?.pages, before = c.continuation?.before;
  return c.staging?.version === 3 && c.staging.mode === 'backfill' && !!before && typeof before === 'object'
    && c.structure?.requests === 1 && Array.isArray(pages)
    && pages.every(page => !!page && typeof page === 'object' && (page as { kind?: unknown }).kind === 'order')
    && Array.isArray(c.staging.orders) && c.staging.orders.length === 1
    && Array.isArray(c.staging.payments) && c.staging.payments.length === 0;
}

/**
 * The first place in a capture list that breaks commit order, or null. Re-reads import in the order the receiver
 * committed them, so an order's later re-read supersedes its earlier one: within one cursor (its continuation's
 * `after.id`), each capture's `after.revision` must be above the one before it. A capture with no readable cursor
 * position (not a re-read: it is refused on its own) is passed over.
 */
export function revisionOrderBreak(inputs: readonly unknown[]): number | null {
  const last = new Map<string, number>();
  for (const [index, input] of inputs.entries()) {
    const after = (input as { continuation?: { after?: { id?: unknown; revision?: unknown } | null } | null } | null)
      ?.continuation?.after;
    if (!after || typeof after.id !== 'string' || typeof after.revision !== 'number' || !Number.isSafeInteger(after.revision)) continue;
    const previous = last.get(after.id);
    if (previous !== undefined && after.revision <= previous) return index;
    last.set(after.id, after.revision);
  }
  return null;
}

/** A batch GO as the batch records it: its goId, and the digest of the whole GO artifact. */
export interface BatchGo { goId: string; goDigest: string }
/** The key the batch's own audit rows carry for a goId: its digest, never the goId itself. */
const goUse = (goId: string) => digest({ format: 'holdr.amazon-batch-go-use', goId });
/** One of the batch's own audit rows, as stored (every column but its `sequence`). */
type BatchAuditRow = {
  action: 'capture-batch-attempt' | 'capture-batch-refused' | 'capture-batch-go'; subject_ref: string | null;
  before_digest: string; after_digest: string | null; policy_digest: string; created_at: string;
};
const batchAudit = (action: BatchAuditRow['action'], subjectRef: string | null, go: BatchGo, after: string | null,
  now: string): BatchAuditRow =>
  ({ action, subject_ref: subjectRef, before_digest: go.goDigest, after_digest: after, policy_digest: POLICY_DIGEST, created_at: now });
const goUseRow = (go: BatchGo, now: string) => batchAudit('capture-batch-go', null, go, goUse(go.goId), now);
const attemptRow = (go: BatchGo, now: string) => batchAudit('capture-batch-attempt', goUse(go.goId), go, null, now);
const insertBatchAudit = (db: Database, row: BatchAuditRow) => db.prepare(`INSERT INTO
  amazon_audit(action,subject_ref,before_digest,after_digest,policy_digest,created_at) VALUES(?,?,?,?,?,?)`)
  .run(row.action, row.subject_ref, row.before_digest, row.after_digest, row.policy_digest, row.created_at);
/** Whether a batch GO was already used: each one authorizes a single run, spent with the run's first committed capture. */
export function batchGoUsed(db: Database, goId: string): boolean {
  return hasAmazonSchema(db)
    && Boolean(db.prepare("SELECT 1 FROM amazon_audit WHERE action='capture-batch-go' AND after_digest=?").get(goUse(goId)));
}
/** A goId's logged runs: its attempts and refusals, and the digests of the GO artifacts they were made under. */
export function batchGoLog(db: Database, goId: string): { attempts: number; refusals: number; goDigests: string[] } {
  const rows = hasAmazonSchema(db) ? db.prepare(`SELECT action,before_digest FROM amazon_audit WHERE subject_ref=?
    AND action IN ('capture-batch-attempt','capture-batch-refused') ORDER BY sequence`).all(goUse(goId)) as
    Array<{ action: string; before_digest: string | null }> : [];
  return { attempts: rows.filter(row => row.action === 'capture-batch-attempt').length,
    refusals: rows.filter(row => row.action === 'capture-batch-refused').length,
    goDigests: [...new Set(rows.map(row => String(row.before_digest)))] };
}
/**
 * Where a batch GO stands under Root's GO-reuse rule. Only `unused` may run.
 * - `consumed`: a capture committed under it (or a refused first capture's rollback could not be verified);
 * - `edited`: a run under its goId was made with another GO artifact (other digests, purpose or pins);
 * - `unlogged`: a run under it stopped without its refusal logged (the log failed, or the process ended);
 * - `unused`: none of these. Every run under it, if any, committed nothing and has its refusal logged.
 */
export type BatchGoState = 'unused' | 'consumed' | 'edited' | 'unlogged';
export function batchGoState(db: Database, go: BatchGo): BatchGoState {
  if (batchGoUsed(db, go.goId)) return 'consumed';
  const log = batchGoLog(db, go.goId);
  if (log.goDigests.some(goDigest => goDigest !== go.goDigest)) return 'edited';
  return log.attempts === log.refusals ? 'unused' : 'unlogged';
}
/** Root's GO-reuse rule, checked before anything is written and again in the run's attempt record. */
export const batchGoReusable = (db: Database, go: BatchGo): boolean => hasAmazonSchema(db) && batchGoState(db, go) === 'unused';
/**
 * In the batch's first capture transaction, after the capture is classified: records the GO as used. The row holds the
 * digests of its goId and of the GO artifact, never the goId itself. A used GO is refused.
 */
export function recordBatchGo(db: Database, goId: string, goDigest: string, now: string): void {
  if (!db.inTransaction || !hasAmazonSchema(db) || batchGoUsed(db, goId)) return refuse();
  insertBatchAudit(db, goUseRow({ goId, goDigest }, now));
}
/** A refusal's value-free record: where it stopped the batch, its reason and kinds, and how its rollback was checked. */
export interface BatchRefusal {
  /** `preview`: refused by the run's own preview on its clone; `database`: a capture's transaction was refused. */
  stage: 'preview' | 'database';
  index: number | null;
  inputDigest: string | null;
  reason: string;
  changed: BatchChangeKind[];
  /** `not-started`: the database was not written; `not-checked`: a later capture, whose GO was already spent. */
  rollback: 'verified' | 'unverified' | 'not-started' | 'not-checked';
}
/**
 * The batch's own bookkeeping, in its own IMMEDIATE transaction: exactly `rows` (from `plan`, run in the transaction)
 * added to amazon_audit, with the change log on. Anything more, in any table, refuses and rolls back.
 */
function bookkeeping(db: Database, label: 'amazon batch attempt' | 'amazon batch refusal log', plan: () => BatchAuditRow[]): void {
  if (db.inTransaction || !hasAmazonSchema(db)) return refuse();
  try {
    db.transaction(() => {
      installChangeLog(db);
      const countersBefore = counters(db), rows = plan();
      for (const row of rows) insertBatchAudit(db, row);
      if (kindsBeyond(db, 0, rows, countersBefore).size) return refuse();
    }).immediate();
  } catch (error) {
    throw toValueFreeDbError(label, error);
  }
}
/**
 * Root's GO-reuse rule asks that every refusal be logged with its GO. So each run records its attempt before its first
 * capture or refusal log, only while its GO is `unused`, and a GO is `unused` only while every attempt under it has a
 * logged refusal (batchGoState). A run that stopped without logging its refusal leaves its GO `unlogged`.
 */
export function recordBatchAttempt(db: Database, go: BatchGo, now: string): void {
  bookkeeping(db, 'amazon batch attempt', () => batchGoReusable(db, go) ? [attemptRow(go, now)] : refuse());
}
/**
 * Root's GO-reuse rule: every refusal is logged with its GO, in its own transaction after the refused write rolled
 * back. The row is keyed by the goId's digest and holds the GO artifact's digest and the digest of the refusal's
 * value-free record. `spend` also records the GO as used: a first capture whose rollback could not be verified.
 */
export function recordBatchRefusal(db: Database, go: BatchGo, refusal: BatchRefusal, now: string, spend: boolean): void {
  bookkeeping(db, 'amazon batch refusal log', () => [
    batchAudit('capture-batch-refused', goUse(go.goId), go, digest({ format: 'holdr.amazon-batch-refusal', version: 1, ...refusal }), now),
    ...(spend && !batchGoUsed(db, go.goId) ? [goUseRow(go, now)] : [])]);
}

const CHANGE_LOG = 'holdr_amazon_batch_changes';
const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const sqlText = (value: string) => `'${value.replace(/'/g, "''")}'`;
const columnsOf = (db: Database, table: string) => db.prepare("SELECT name FROM pragma_table_info(?, 'main') ORDER BY cid")
  .pluck().all(table) as string[];
/**
 * One value in a row image, exactly: its type, then an integer as its digits, a real as SQLite's exact round-trip
 * rendering, and text and blobs byte for byte in hex. `quote()` would stop text at an embedded NUL.
 */
const cellSql = (value: string) => `CASE typeof(${value}) WHEN 'null' THEN 'n' WHEN 'integer' THEN 'i'||${value} `
  + `WHEN 'real' THEN 'r'||quote(${value}) WHEN 'text' THEN 't'||hex(${value}) ELSE 'b'||hex(${value}) END`;
const rowImageSql = (columns: readonly string[], row: string) =>
  `json_array(${columns.map(column => cellSql(`${row}${ident(column)}`)).join(',')})`;
/**
 * Inside a write transaction: a connection-local log of every row change in every table of the database, written by
 * TEMP triggers as exact row images (cellSql). An update that moves a row's rowid, which no row image shows, is logged
 * too, as an entry with neither image. Temp objects never touch the database file. It is installed again for each
 * write, on the schema as it is then, and rolls back with the write.
 */
export function installChangeLog(db: Database): void {
  if (!db.inTransaction) return refuse();
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${CHANGE_LOG}(seq INTEGER PRIMARY KEY, tbl TEXT NOT NULL, old_row TEXT, new_row TEXT)`);
  for (const name of db.prepare("SELECT name FROM temp.sqlite_master WHERE type='trigger' AND name GLOB 'holdr_amazon_batch_*'")
    .pluck().all() as string[]) db.exec(`DROP TRIGGER temp.${ident(name)}`);
  db.exec(`DELETE FROM temp.${CHANGE_LOG}`);
  const tables = db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name")
    .pluck().all() as string[];
  tables.forEach((table, n) => {
    const columns = columnsOf(db, table), on = `main.${ident(table)}`, name = sqlText(table), rowid = rowidOf(db, table, columns);
    db.exec(`CREATE TEMP TRIGGER holdr_amazon_batch_${n}_insert AFTER INSERT ON ${on} BEGIN
        INSERT INTO ${CHANGE_LOG}(tbl,new_row) VALUES(${name},${rowImageSql(columns, 'NEW.')}); END;
      CREATE TEMP TRIGGER holdr_amazon_batch_${n}_update AFTER UPDATE ON ${on} BEGIN
        INSERT INTO ${CHANGE_LOG}(tbl,old_row,new_row) VALUES(${name},${rowImageSql(columns, 'OLD.')},${rowImageSql(columns, 'NEW.')}); END;
      CREATE TEMP TRIGGER holdr_amazon_batch_${n}_delete AFTER DELETE ON ${on} BEGIN
        INSERT INTO ${CHANGE_LOG}(tbl,old_row) VALUES(${name},${rowImageSql(columns, 'OLD.')}); END;`);
    if (rowid) db.exec(`CREATE TEMP TRIGGER holdr_amazon_batch_${n}_rowid AFTER UPDATE ON ${on}
      WHEN OLD.${rowid} IS NOT NEW.${rowid} BEGIN INSERT INTO ${CHANGE_LOG}(tbl) VALUES(${name}); END;`);
  });
}
/** The name a table's rowid answers to, unless it has none (WITHOUT ROWID) or its columns take all three names. */
function rowidOf(db: Database, table: string, columns: readonly string[]): string | null {
  const listed = db.prepare("SELECT wr FROM pragma_table_list WHERE schema='main' AND name=?").get(table) as { wr: number } | undefined;
  const taken = new Set(columns.map(column => column.toLowerCase()));
  return !listed || listed.wr ? null : ['rowid', '_rowid_', 'oid'].find(name => !taken.has(name)) ?? null;
}
type Cell = string | number | bigint | null | Buffer;
type LoggedRow = Record<string, Cell>;
/** A logged row: its values decoded, the exact image of each value (cellSql), and the exact image of the whole row. */
interface Logged { row: LoggedRow; cells: Record<string, string>; image: string }
/** A table's net change: rows removed and rows added, and how many updates moved a rowid. */
export interface TableChange { added: Logged[]; removed: Logged[]; moved: number }
/** A logged value (cellSql) as JavaScript: text decoded from its bytes, a number parsed (exactly), a blob as its bytes. */
function cell(image: string): Cell {
  const body = image.slice(1);
  if (image[0] === 'n') return null;
  if (image[0] === 'i') return Number.isSafeInteger(Number(body)) ? Number(body) : BigInt(body);
  if (image[0] === 'r') return Number(body);
  if (image[0] === 't') return Buffer.from(body, 'hex').toString('utf8');
  return Buffer.from(body, 'hex');
}
/** The exact image (cellSql) of an expected value: text as its UTF-8 bytes, an integer as its digits, or null. */
type Expected = string | number | null;
function imageOf(value: Expected): string {
  if (value === null) return 'n';
  if (typeof value === 'number') return Number.isSafeInteger(value) ? `i${value}` : refuse();
  return `t${Buffer.from(value, 'utf8').toString('hex').toUpperCase()}`;
}
/**
 * The write's net change per table, as rows removed and rows added (decoded, and as their exact images), from the log's
 * entries after `since`. Row images are counted as a multiset, so a row updated to its own values, or deleted and
 * inserted again unchanged (as reconciliation rebuilds its tables), cancels out. A rowid move never cancels.
 */
export function readChangeLog(db: Database, since = 0): Map<string, TableChange> {
  const net = new Map<string, { images: Map<string, number>; moved: number }>();
  for (const row of db.prepare(`SELECT tbl,old_row,new_row FROM temp.${CHANGE_LOG} WHERE seq>? ORDER BY seq`).all(since) as
    Array<{ tbl: string; old_row: string | null; new_row: string | null }>) {
    const table = net.get(row.tbl) ?? { images: new Map<string, number>(), moved: 0 };
    net.set(row.tbl, table);
    if (row.old_row === null && row.new_row === null) table.moved++;
    if (row.old_row !== null) table.images.set(row.old_row, (table.images.get(row.old_row) ?? 0) - 1);
    if (row.new_row !== null) table.images.set(row.new_row, (table.images.get(row.new_row) ?? 0) + 1);
  }
  const changes = new Map<string, TableChange>();
  for (const [table, { images, moved }] of net) {
    const columns = columnsOf(db, table), change: TableChange = { added: [], removed: [], moved };
    for (const [image, count] of images) {
      const values = JSON.parse(image) as string[];
      const cells = Object.fromEntries(columns.map((column, n) => [column, values[n] ?? 'n']));
      const logged: Logged = { row: Object.fromEntries(columns.map(column => [column, cell(cells[column])])), cells, image };
      for (let i = 0; i < Math.abs(count); i++) (count > 0 ? change.added : change.removed).push(logged);
    }
    if (change.added.length || change.removed.length || change.moved) changes.set(table, change);
  }
  return changes;
}
/** The log's last entry: what a later write adds is read from after it. */
const changeLogEnd = (db: Database) => db.prepare(`SELECT COALESCE(MAX(seq),0) FROM temp.${CHANGE_LOG}`).pluck().get() as number;
/** A failed write's change log, read before its rollback, or undefined when the failure already took the log with it. */
function changesSoFar(db: Database): Map<string, TableChange> | undefined {
  try { return db.inTransaction ? readChangeLog(db) : undefined; } catch { return undefined; }
}
const keyColumnsOf = (db: Database, table: string) => db.prepare(`SELECT name FROM pragma_table_info(?, 'main') WHERE pk>0
  ORDER BY pk`).pluck().all(table) as string[];
/** The AUTOINCREMENT counters by table, which no trigger sees. */
const counters = (db: Database): Map<string, string> =>
  new Map(db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='sqlite_sequence'").get()
    ? (db.prepare(`SELECT name,${cellSql('seq')} AS seq FROM main.sqlite_sequence ORDER BY name`).all() as Array<{ name: string; seq: string }>)
      .map(row => [row.name, row.seq]) : []);
const sequences = (db: Database) => digest([...counters(db)]);
/** The kinds of the tables whose AUTOINCREMENT counter moved: an insert a later delete hid from the change log moves it. */
function counterKinds(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): Set<BatchChangeKind> {
  const kinds = new Set<BatchChangeKind>();
  for (const table of new Set([...before.keys(), ...after.keys()])) if (before.get(table) !== after.get(table)) kinds.add(tableKind(table));
  return kinds;
}
/** What a refused write's rollback is checked against: taken in the same transaction, before the write began. */
export interface RollbackBaseline { schema: string; sequences: string }
export const rollbackBaseline = (db: Database): RollbackBaseline => ({ schema: schemaDigest(db), sequences: sequences(db) });
/**
 * Root's GO-reuse rule: whether a refused write is verified to have rolled back whole. Checked in the same transaction
 * as the write's baseline, so no other writer intervened: the schema and the AUTOINCREMENT counters are as they were,
 * and every row the write changed (its change log, read before the refusal) is back. Each row it removed or changed is
 * there again, exactly as it was, and each row it added is gone, found by its key's exact bytes. Nothing to check
 * against, a changed table without a primary key, or a moved rowid is not verified.
 */
export function verifyRolledBack(db: Database, baseline: RollbackBaseline, changes: Map<string, TableChange> | undefined): boolean {
  if (!changes || schemaDigest(db) !== baseline.schema || sequences(db) !== baseline.sequences) return false;
  for (const [table, change] of changes) {
    const columns = columnsOf(db, table), keys = keyColumnsOf(db, table);
    if (change.moved || !columns.length || !keys.length) return false;
    const keyOf = (logged: Logged) => keys.map(key => logged.cells[key]).join('\0');
    const restored = new Set(change.removed.map(keyOf));
    if (change.removed.some(logged => rowNow(db, table, columns, keys, logged) !== logged.image)) return false;
    if (change.added.some(logged => !restored.has(keyOf(logged)) && rowNow(db, table, columns, keys, logged) !== undefined)) return false;
  }
  return true;
}
/** The exact image of the row a logged row's key names now, bound by the key's exact bytes and type. */
function rowNow(db: Database, table: string, columns: readonly string[], keys: readonly string[], logged: Logged): string | undefined {
  const params: unknown[] = [];
  const where = keys.map(key => {
    const image = logged.cells[key], body = image.slice(1);
    if (image[0] === 'n') return `${ident(key)} IS NULL`;
    params.push(image[0] === 'i' ? BigInt(body) : image[0] === 'r' ? Number(body) : Buffer.from(body, 'hex'));
    return image[0] === 't' ? `${ident(key)} IS CAST(? AS TEXT)` : `${ident(key)} IS ?`;
  });
  return db.prepare(`SELECT ${rowImageSql(columns, '')} FROM main.${ident(table)} WHERE ${where.join(' AND ')}`).pluck()
    .get(...params) as string | undefined;
}

const ORDER_FIELDS: Readonly<Record<string, BatchChangeKind>> = Object.freeze({
  orderId: 'order-other', date: 'order-date', total: 'order-total', items: 'order-items', paymentMethods: 'order-methods',
  summary: 'order-summary', refundSummary: 'order-refund-total', chargeFree: 'order-charge-free',
  tenderCoverage: 'order-proofs', tenderProof: 'order-proofs', itemProof: 'order-proofs', paymentCoverage: 'order-proofs',
});
/** One fact of an order as compared: lines by ordinal without their display-only image ID, collections as multisets. */
function factOf(order: OrderObservation, key: string): string | undefined {
  const value = (order as unknown as Record<string, unknown>)[key];
  if (value === undefined) return undefined;
  if (key === 'items' && Array.isArray(value)) {
    return digest((value as OrderObservation['items']).map((item, n) => {
      const { imageId: _imageId, ...line } = item;
      return [item.lineOrdinal ?? n, line] as const;
    }).sort(([a], [b]) => a - b));
  }
  if ((key === 'summary' || key === 'paymentMethods') && Array.isArray(value)) return digest(value.map(entry => digest(entry)).sort());
  return digest(value);
}
/** The kinds of fact two orders differ in, item image IDs aside. A fact only one of them has differs too. */
export function orderFactKinds(next: OrderObservation, shown: OrderObservation): Set<BatchChangeKind> {
  const kinds = new Set<BatchChangeKind>();
  for (const key of new Set([...Object.keys(next), ...Object.keys(shown)])) {
    if (factOf(next, key) !== factOf(shown, key)) kinds.add(Object.hasOwn(ORDER_FIELDS, key) ? ORDER_FIELDS[key] : 'order-other');
  }
  return kinds;
}
const imageIdsByLine = (order: OrderObservation | null) => new Map((Array.isArray(order?.items) ? order.items : [])
  .map((item, n) => [item?.lineOrdinal ?? n, item?.imageId ?? null] as const));
/**
 * The re-read's order as the importer would store it with the image IDs the display before had: each line keeps that
 * display's image ID for its ordinal (in place, or last, where the producer adds it), or none. The display before must
 * be exactly this, byte for byte, for the re-read to be the display with only its image IDs changed.
 */
function withImageIdsOf(order: OrderObservation, shown: OrderObservation): OrderObservation {
  const ids = imageIdsByLine(shown);
  return { ...order, items: order.items.map((item, n) => {
    const { imageId: _imageId, ...line } = item, id = ids.get(item.lineOrdinal ?? n) ?? null;
    return id === null ? line : Object.hasOwn(item, 'imageId') ? { ...item, imageId: id } : { ...line, imageId: id };
  }) };
}
/** The displayed lines whose captured image ID was added, replaced or removed as the display moved from `before` to `after`. */
export function imageIdChanges(before: OrderObservation | null, after: OrderObservation): ImageIdCounts {
  const was = imageIdsByLine(before), now = imageIdsByLine(after), counts = { added: 0, replaced: 0, removed: 0 };
  for (const [line, id] of now) {
    const old = was.get(line) ?? null;
    if (id !== null && old === null) counts.added++;
    else if (id !== null && id !== old) counts.replaced++;
    else if (id === null && old !== null) counts.removed++;
  }
  for (const [line, old] of was) if (!now.has(line) && old !== null) counts.removed++;
  return counts;
}

/** Where a change to a table lands when nothing allows it. */
const TABLE_KINDS: Readonly<Record<string, BatchChangeKind>> = Object.freeze({
  amazon_captures: 'history-changed', amazon_capture_runs: 'history-changed', amazon_observations: 'history-changed',
  amazon_items: 'history-changed', amazon_orders: 'other-orders', amazon_subjects: 'subjects', amazon_event_orders: 'subjects',
  amazon_matches: 'card-links', amazon_ledger_matches: 'card-links', amazon_candidates: 'card-candidates',
  amazon_ledger_candidates: 'card-candidates', amazon_allocations: 'allocations', amazon_tender_portions: 'allocations',
  amazon_shipments: 'allocations', amazon_line_joins: 'allocations', amazon_refunds: 'refund-evidence',
  amazon_refund_destinations: 'refund-evidence', amazon_refund_events: 'refund-events', amazon_refund_event_members: 'refund-events',
  amazon_item_overrides: 'categories', amazon_agent_categories: 'categories', amazon_category_mappings: 'categories',
  amazon_product_taxonomy: 'taxonomy', amazon_line_taxonomy: 'taxonomy', amazon_proof_predecessors: 'charge-free',
  amazon_audit: 'audit-other',
});
/** The Fresh import's tables are named only by its own modules (freshAdapter.test.ts): here, only by their prefix. */
const tableKind = (table: string): BatchChangeKind => Object.hasOwn(TABLE_KINDS, table) ? TABLE_KINDS[table]
  : table.startsWith('amazon_fresh_') ? 'fresh-lists' : table.startsWith('amazon_') ? 'other-amazon' : 'non-amazon';
/** What an audit row says changed, when the capture's own write is not expected to make it exactly as it is. */
const AUDIT_KINDS: Readonly<Record<string, BatchChangeKind>> = Object.freeze({
  'capture-import': 'audit-other', 'order-observation': 'other-orders', 'subject-observation': 'subjects',
  'item-override-carried': 'categories', reconcile: 'card-links', 'refund-events-projected': 'refund-events',
  'refund-status-regressed': 'refund-status-regressed', 'refund-total-decreased': 'refund-total-decreased',
  'item-category-unmatched': 'item-category-unmatched', 'taxonomy-unmatched': 'taxonomy-unmatched',
  'taxonomy-owner-carried': 'taxonomy', 'taxonomy-line-owner-carried': 'taxonomy',
  'charge-free-contradicted': 'charge-free', 'charge-free-superseded-details': 'charge-free',
  'charge-free-revoked': 'charge-free', 'charge-free-revoked-fresh-list': 'charge-free',
  'charge-free-kept-fresh-list': 'charge-free', 'revocation-predecessor-missing': 'charge-free',
  'fresh-list-observation': 'fresh-lists', 'capture-run-observed': 'history-changed', 'order-observation-scope': 'history-changed',
});
/** The importer's audit for a display it keeps: one of these, for the order, naming the capture it kept out. */
const KEPT_AUDITS: readonly string[] = ['header-only-kept-details', 'poorer-observation-kept-details', 'conflicting-observation-kept-details'];
/** An order's display row: its capture, its JSON as the driver decodes it, and its exact cell (cellSql). */
interface Display { latest_digest: string; data_json: string; image: string }
type ExpectedRow = Record<string, Expected>;
/** The rows the importer writes for one validated capture, exactly as it writes them: a JSON column as its exact text. */
interface OwnRows {
  capture: ExpectedRow;
  run: ExpectedRow | null;
  observations: Map<string, ExpectedRow>;
  items: Map<string, ExpectedRow>;
}
interface CaptureContext {
  captureDigest: string; orderRef: string; totalRef: string; order: OrderObservation; shownBefore: Display | undefined;
  receipt: ImportReceipt; now: string; own: OwnRows;
}
/**
 * Whether a JSON text repeats a key in any of its objects (keys compared as decoded). JavaScript reads the last of
 * them and SQLite's JSON functions the first, so Root refuses such JSON wherever it appears. `text` must parse.
 */
export function hasDuplicateKeys(text: string): boolean {
  const objects: Array<Set<string> | null> = [];
  let key = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const keys = objects[objects.length - 1];
      if (key && keys) {
        const name = JSON.parse(text.slice(i, end + 1)) as string;
        if (keys.has(name)) return true;
        keys.add(name);
        key = false;
      }
      i = end;
    } else if (c === '{') { objects.push(new Set()); key = true; }
    else if (c === '[') { objects.push(null); key = false; }
    else if (c === '}' || c === ']') { objects.pop(); key = false; }
    else if (c === ',') key = objects[objects.length - 1] instanceof Set;
  }
  return false;
}
/**
 * A stored JSON value from its exact cell image (cellSql), as JavaScript reads it: only when the cell is text and its
 * bytes are exactly `JSON.stringify` of that reading, as every importer write is. Such text repeats no key, writes each
 * value one way (an integer as its digits) and is valid UTF-8, so JavaScript and SQLite's JSON functions read it alike.
 * Any other cell is undefined. Its key order is the writer's: where that matters, the caller pins the bytes themselves.
 */
export function canonicalJson(image: string | undefined): unknown {
  if (!image || image[0] !== 't') return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(image.slice(1), 'hex').toString('utf8')); } catch { return undefined; }
  return imageOf(JSON.stringify(parsed)) === image ? parsed : undefined;
}
/** What writeCapture stores for this capture's one order: its capture and run, observations and items. */
function ownRows(capture: ValidatedCapture, captureDigest: string, receipt: ImportReceipt, now: string): OwnRows {
  const { staging } = capture, order = staging.orders[0], orderRef = opaque('order', order.orderId);
  const json = (value: unknown) => JSON.stringify(value) ?? null;
  const scope = orderObservationScope(capture.structure, order, 0);
  const observation = (family: string, ordinal: number, holdReason: string, value: unknown): [string, ExpectedRow] => {
    const ref = opaque('observation', [captureDigest, family, ordinal]);
    return [ref, { ref, capture_digest: captureDigest, family, ordinal, order_ref: orderRef, hold_reason: holdReason, data_json: json(value) }];
  };
  const observations = new Map<string, ExpectedRow>([observation('order', 0, scope !== 'legacy' ? SCOPE_HOLD_REASONS[scope]
    : staging.version === 3 ? 'payment-coverage-held' : 'legacy-evidence-held', order),
  ...order.items.map((item, n) => observation('item', n, 'item-identity-unproven', item))]);
  const items = new Map<string, ExpectedRow>(staging.version !== 3 ? [] : order.items.map(item => {
    const ref = opaque('line-observation', [captureDigest, order.orderId, item.lineOrdinal]);
    return [ref, { ref, order_ref: orderRef, native_line_id: `${captureDigest}:${item.lineOrdinal}`, data_json: json(item) }];
  }));
  return {
    capture: { digest: captureDigest, source_id: SOURCE, format_version: staging.version, window_from: staging.window.from,
      window_through: staging.window.through, coverage_json: json(staging.coverage), resume_json: json(staging.resume),
      imported_at: now, receipt_json: json(receipt) },
    run: staging.version === 3 && staging.runId
      ? { capture_digest: captureDigest, run_id: staging.runId, capture_mode: staging.mode ?? 'recent' } : null,
    observations, items,
  };
}
/** Whether a logged row is exactly `expected`, byte for byte, column for column (plus its `keys`), and nothing else. */
const same = (cells: Record<string, string>, expected: ExpectedRow, keys: readonly string[] = []) =>
  Object.keys(cells).sort().join('\0') === [...Object.keys(expected), ...keys].sort().join('\0')
  && Object.entries(expected).every(([column, value]) => cells[column] === imageOf(value));
/** An audit row exactly as the importer's audit() writes it (every column but its `sequence`). */
const importerAudit = (action: string, subjectRef: string | null, before: unknown, after: unknown, now: string): ExpectedRow =>
  ({ action, subject_ref: subjectRef, before_digest: before === undefined ? null : digest(before), after_digest: digest(after),
    policy_digest: POLICY_DIGEST, created_at: now });
const auditKind = (row: LoggedRow): BatchChangeKind =>
  typeof row.action === 'string' && Object.hasOwn(AUDIT_KINDS, row.action) ? AUDIT_KINDS[row.action] : 'audit-other';
const lineOrdinalOf = (nativeLineId: string) => nativeLineId.slice(nativeLineId.lastIndexOf(':') + 1);
/**
 * A subject's exact image with the display's line refs moved to this capture: what the importer writes for a display
 * move that changes nothing else (allocations name their lines by capture, and nothing else in a subject does). Byte
 * for byte, since the refs are ASCII. Null when the subject is not text or there was no display.
 */
function relined(image: string | undefined, ctx: CaptureContext): string | null {
  if (!image || image[0] !== 't' || !ctx.shownBefore) return null;
  let text = Buffer.from(image.slice(1), 'hex').toString('latin1');
  for (const item of ctx.order.items) {
    text = text.split(opaque('line-observation', [ctx.shownBefore.latest_digest, ctx.order.orderId, item.lineOrdinal]))
      .join(opaque('line-observation', [ctx.captureDigest, ctx.order.orderId, item.lineOrdinal]));
  }
  return `t${Buffer.from(text, 'latin1').toString('hex').toUpperCase()}`;
}
/**
 * The displayed line an owner item override was carried from, unchanged: onto one of this capture's own lines, from the
 * line at its ordinal in the display before, with the same category. Null for anything else.
 */
function carriedFrom(db: Database, ctx: CaptureContext, itemRef: string, category: string): string | null {
  const line = ctx.own.items.get(itemRef);
  if (!ctx.shownBefore || !line) return null;
  return (db.prepare(`SELECT i.ref FROM amazon_items i JOIN amazon_item_overrides o ON o.item_ref=i.ref
    WHERE i.order_ref=? AND i.native_line_id=? AND o.category=?`).pluck()
    .get(ctx.orderRef, `${ctx.shownBefore.latest_digest}:${lineOrdinalOf(String(line.native_line_id))}`, category) as string | undefined) ?? null;
}
/** A table's changed rows paired by `ref`'s exact image: removed is the row before, added the row after; a repeat is flagged. */
function pairedByRef({ added, removed }: TableChange) {
  const pairs = new Map<string, { ref: string; before?: Logged; after?: Logged; repeated: boolean }>();
  for (const [side, rows] of [['before', removed], ['after', added]] as const) {
    for (const logged of rows) {
      const ref = logged.cells.ref, pair = pairs.get(ref) ?? { ref, repeated: false };
      if (pair[side]) pair.repeated = true;
      pair[side] = logged;
      pairs.set(ref, pair);
    }
  }
  return [...pairs.values()];
}
const KEPT_ORDER_COLUMNS = ['source_id', 'native_id', 'beneficiary'];
const KEPT_SUBJECT_COLUMNS = ['source_id', 'evidence_class', 'native_occurrence_id'];
const NO_CHANGE: TableChange = { added: [], removed: [], moved: 0 };
/**
 * Where a changed row whose JSON is not in the importer's form (canonicalJson) lands: for the order row, the display
 * before is `order-stored-form` and the display after `order-other`; elsewhere, the table's own kind.
 */
const jsonKind = (table: string, side: 'added' | 'removed'): BatchChangeKind =>
  table !== 'amazon_orders' ? tableKind(table) : side === 'removed' ? 'order-stored-form' : 'order-other';
/**
 * The kinds of change in a write's net row changes. Everywhere, a moved rowid is a kind. Without a capture's context
 * (the preview's baseline), every change is a kind. With one, any JSON value in a changed row (added or removed) whose
 * cell is not exactly the importer's form is a kind (canonicalJson), and only exactly what the importer writes for that
 * validated capture is allowed, byte for byte, and nothing more:
 * - its capture and run rows, its order and item observations and its items, each exactly as the importer serializes
 *   the capture, all of them and no others;
 * - its order's display row moving to it, holding exactly the capture's order as the importer serializes it (the
 *   display before is pinned byte for byte too, by classifiedCaptureWrite);
 * - its order-total subject, when its text is exactly the one before with the display's line refs moved to this capture;
 * - owner item overrides carried unchanged to its own lines at the same ordinal;
 * - exactly the audits the importer writes for those: one capture import; one display audit when the display's content
 *   changes; one subject audit when the subject changes; one per carry; and, for a display it keeps, one kept-details
 *   audit. Each holds exactly its digests. A missing audit, or any other, is a kind.
 * Every other change, in any table, is a kind.
 */
function changeKinds(db: Database, changes: Map<string, TableChange>, ctx: CaptureContext | null): Set<BatchChangeKind> {
  const kinds = new Set<BatchChangeKind>();
  for (const [table, change] of changes) if (change.moved) kinds.add(tableKind(table));
  if (!ctx) {
    for (const [table, change] of changes) {
      if (table !== 'amazon_audit') { if (change.added.length || change.removed.length) kinds.add(tableKind(table)); }
      else {
        if (change.removed.length) kinds.add('history-changed');
        for (const { row } of change.added) kinds.add(auditKind(row));
      }
    }
    return kinds;
  }
  for (const [table, change] of changes) {
    for (const [side, rows] of [['added', change.added], ['removed', change.removed]] as const) {
      for (const { cells } of rows) {
        if (Object.entries(cells).some(([column, image]) => column.endsWith('_json') && image !== 'n' && canonicalJson(image) === undefined)) {
          kinds.add(jsonKind(table, side));
        }
      }
    }
  }
  const own = (table: string, expected: ReadonlyMap<string, ExpectedRow>, key: string, other: (row: LoggedRow) => BatchChangeKind) => {
    const change = changes.get(table) ?? NO_CHANGE, found = new Set<string>();
    if (change.removed.length) kinds.add('history-changed');
    for (const { row, cells } of change.added) {
      const id = row[key], want = typeof id === 'string' ? expected.get(id) : undefined;
      if (typeof id === 'string' && want && !found.has(id) && same(cells, want)) found.add(id);
      else kinds.add(other(row));
    }
    if (found.size !== expected.size) kinds.add('history-changed');
  };
  own('amazon_captures', new Map([[ctx.captureDigest, ctx.own.capture]]), 'digest', () => 'history-changed');
  own('amazon_capture_runs', ctx.own.run ? new Map([[ctx.captureDigest, ctx.own.run]]) : new Map(), 'capture_digest',
    () => 'history-changed');
  own('amazon_observations', ctx.own.observations, 'ref',
    row => row.family === 'payment' ? 'payment-evidence' : row.family === 'refund' ? 'refund-evidence' : 'history-changed');
  own('amazon_items', ctx.own.items, 'ref', () => 'history-changed');
  let display: 'moved' | 'new' | 'kept' = 'kept', subject: { before: unknown; after: unknown } | null = null;
  const carries = new Map<string, { from: string; category: string }>();
  const orderRef = imageOf(ctx.orderRef), totalRef = imageOf(ctx.totalRef);
  for (const [table, change] of changes) {
    if (['amazon_captures', 'amazon_capture_runs', 'amazon_observations', 'amazon_items', 'amazon_audit'].includes(table)) continue;
    if (table === 'amazon_orders') {
      for (const { ref, before, after, repeated } of pairedByRef(change)) {
        if (ref !== orderRef) kinds.add('other-orders');
        else if (repeated || !after) kinds.add('order-other');
        else {
          display = before ? 'moved' : 'new';
          if (!before) kinds.add('order-new');
          if (after.cells.latest_digest !== imageOf(ctx.captureDigest) || after.cells.data_json !== imageOf(JSON.stringify(ctx.order))
            || (before && KEPT_ORDER_COLUMNS.some(column => after.cells[column] !== before.cells[column]))) kinds.add('order-other');
        }
      }
    } else if (table === 'amazon_subjects') {
      for (const { ref, before, after, repeated } of pairedByRef(change)) {
        const was = before && canonicalJson(before.cells.data_json), now = after && canonicalJson(after.cells.data_json);
        if (ref !== totalRef || repeated || !before || !after || subject || was === undefined || now === undefined
          || KEPT_SUBJECT_COLUMNS.some(column => after.cells[column] !== before.cells[column])
          || after.cells.data_json !== relined(before.cells.data_json, ctx)) kinds.add('subjects');
        else subject = { before: was, after: now };
      }
    } else if (table === 'amazon_item_overrides') {
      if (change.removed.length) kinds.add('categories');
      for (const { row, cells } of change.added) {
        const to = row.item_ref, category = row.category;
        const from = typeof to === 'string' && typeof category === 'string' && same(cells, { item_ref: to, category })
          ? carriedFrom(db, ctx, to, category) : null;
        if (!from || carries.has(to as string)) kinds.add('categories');
        else carries.set(to as string, { from, category: category as string });
      }
    } else kinds.add(tableKind(table));
  }
  // Exactly the audits the importer writes for what this capture changed (writeCapture's audit() calls), and no others.
  const previous = ctx.shownBefore ? JSON.parse(ctx.shownBefore.data_json) as unknown : undefined;
  const expected = [importerAudit('capture-import', null, undefined, ctx.receipt, ctx.now)];
  if (display !== 'kept' && (previous === undefined || digest(previous) !== digest(ctx.order))) {
    expected.push(importerAudit('order-observation', ctx.orderRef, previous, ctx.order, ctx.now));
  }
  if (subject) expected.push(importerAudit('subject-observation', ctx.totalRef, subject.before, subject.after, ctx.now));
  for (const [to, { from, category }] of carries) {
    expected.push(importerAudit('item-override-carried', to, { itemRef: from, category }, { itemRef: to, category }, ctx.now));
  }
  const kept = display === 'kept' && ctx.shownBefore
    ? importerAudit('', ctx.orderRef, undefined, { captureDigest: ctx.captureDigest }, ctx.now) : null;
  const audit = changes.get('amazon_audit') ?? NO_CHANGE;
  if (audit.removed.length) kinds.add('history-changed');
  let keptAudits = 0;
  for (const { row, cells } of audit.added) {
    const action = typeof row.action === 'string' ? row.action : '';
    if (kept && !keptAudits && KEPT_AUDITS.includes(action) && same(cells, { ...kept, action }, ['sequence'])) {
      keptAudits++;
      continue;
    }
    const at = expected.findIndex(want => same(cells, want, ['sequence']));
    if (at >= 0) { expected.splice(at, 1); continue; }
    const ownAction = ['capture-import', 'item-override-carried', ...KEPT_AUDITS].includes(action)
      || (action === 'order-observation' && cells.subject_ref === orderRef) || (action === 'subject-observation' && cells.subject_ref === totalRef);
    kinds.add(ownAction ? 'audit-other' : auditKind(row));
  }
  if (expected.length || (kept && keptAudits !== 1)) kinds.add('audit-other');
  return kinds;
}
/**
 * The kinds of change the log holds after `since` beyond exactly `expected` added to amazon_audit, and of any
 * AUTOINCREMENT counter moved since `countersBefore`: the batch's own bookkeeping rows (its attempt, refusal and GO
 * records) are written with the change log on, and must have no side effect. A missing or altered expected row is
 * `audit-other`.
 */
function kindsBeyond(db: Database, since: number, expected: readonly BatchAuditRow[],
  countersBefore: ReadonlyMap<string, string>): Set<BatchChangeKind> {
  const changes = readChangeLog(db, since), audit = changes.get('amazon_audit') ?? NO_CHANGE, left = [...expected];
  const rest: TableChange = { added: [], removed: audit.removed, moved: audit.moved };
  for (const logged of audit.added) {
    const found = left.findIndex(want => same(logged.cells, want, ['sequence']));
    if (found >= 0) left.splice(found, 1);
    else rest.added.push(logged);
  }
  if (rest.added.length || rest.removed.length || rest.moved) changes.set('amazon_audit', rest);
  else changes.delete('amazon_audit');
  const kinds = changeKinds(db, changes, null);
  if (left.length) kinds.add('audit-other');
  for (const kind of counterKinds(countersBefore, counters(db))) kinds.add(kind);
  return kinds;
}

const schemaDigest = (db: Database) =>
  digest(db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name').all());
const readDisplay = (db: Database, orderRef: string) => db.prepare(`SELECT latest_digest,data_json,${cellSql('data_json')} AS image
  FROM amazon_orders WHERE ref=?`).get(orderRef) as Display | undefined;
/** A display's order as JavaScript reads it, for comparing facts: null with no display, undefined when not an order object. */
function shownOrder(shown: Display | undefined): OrderObservation | null | undefined {
  if (!shown) return null;
  try {
    const value: unknown = JSON.parse(String(shown.data_json));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as OrderObservation : undefined;
  } catch { return undefined; }
}
/** The owner item overrides on one capture's lines of an order, by line ordinal. */
function lineOverrides(db: Database, orderRef: string, captureDigest: string): Map<string, string> {
  const rows = db.prepare(`SELECT i.native_line_id AS line,o.category FROM amazon_items i
    JOIN amazon_item_overrides o ON o.item_ref=i.ref WHERE i.order_ref=? AND substr(i.native_line_id,1,?)=?`)
    .all(orderRef, captureDigest.length + 1, `${captureDigest}:`) as Array<{ line: string; category: string }>;
  return new Map(rows.map(row => [lineOrdinalOf(row.line), row.category]));
}
const reportOrder = (kinds: ReadonlySet<BatchChangeKind>) => BATCH_CHANGE_KINDS.filter(kind => kinds.has(kind));
/** A classified write's result and its net row changes, kept for the caller even when the write is refused. */
export interface CaptureOut { result?: ClassifiedCapture; changes?: Map<string, TableChange> }
/**
 * One re-read capture's import, inside the caller's IMMEDIATE transaction, classified from what it changed:
 * - `already-imported`: its digest was stored already (an exact repeat);
 * - `facts-changed`: any kind of change beyond the capture's own history, its display's image IDs and what moves with
 *   the display unchanged (its subject, carried owner overrides);
 * - `image-ids-only`: the capture replaced the order's display with the same facts, and displayed lines gained image
 *   IDs, none changed or lost;
 * - `no-new-image-ids`: none of these (the display was kept, or gained no image ID).
 * The schema baseline is taken before anything is installed, and the change log before the Amazon schema install, so
 * any table that install creates is a `schema` change. Only `image-ids-only` returns. Any other class leaves its result
 * (and the net row changes) in `out` and throws BATCH_CAPTURE_REFUSED, so the caller's transaction rolls back.
 */
export function classifiedCaptureWrite(db: Database, capture: ValidatedCapture, captureDigest: string, now: string,
  out: CaptureOut): ClassifiedCapture {
  if (!db.inTransaction || capture.staging.orders.length !== 1) return refuse();
  const schema = schemaDigest(db), countersBefore = counters(db);
  installChangeLog(db);
  const order = capture.staging.orders[0], orderRef = opaque('order', order.orderId);
  let shownBefore: Display | undefined, stored: boolean, receipt: ImportReceipt;
  try {
    ensureAmazonSchema(db);
    shownBefore = readDisplay(db, orderRef);
    stored = Boolean(db.prepare('SELECT 1 FROM amazon_captures WHERE digest=?').get(captureDigest));
    receipt = writeValidatedCapture(db, capture, captureDigest, now);
  } catch (error) {
    // What the failed write changed, for the caller's rollback check (verifyRolledBack).
    out.changes = changesSoFar(db);
    throw error;
  }
  const changes = readChangeLog(db);
  out.changes = changes;
  const ctx: CaptureContext = { captureDigest, orderRef, totalRef: opaque('order-total', order.orderId), order, shownBefore,
    receipt, now, own: ownRows(capture, captureDigest, receipt, now) };
  const kinds = changeKinds(db, changes, ctx);
  if (schemaDigest(db) !== schema) kinds.add('schema');
  for (const kind of counterKinds(countersBefore, counters(db))) kinds.add(kind);
  const shownAfter = readDisplay(db, orderRef);
  // Facts are compared as JavaScript reads the displays, to name what differs. What decides is the bytes: the display
  // after is exactly the importer's JSON of this read's order (changeKinds), and the display before must be exactly
  // that JSON with its own image IDs (below), so the two differ in image IDs only, for every reader.
  const before = shownOrder(ctx.shownBefore), after = shownOrder(shownAfter);
  if (after === undefined) kinds.add('order-other');
  const display = !ctx.shownBefore ? (shownAfter ? 'new' : 'kept')
    : shownAfter?.latest_digest === captureDigest && ctx.shownBefore.latest_digest !== captureDigest ? 'replaced' : 'kept';
  const facts = new Set<BatchChangeKind>();
  if (!ctx.shownBefore) kinds.add('order-new');
  else if (before) {
    // The read itself, kept or not (every retained observation can feed a reader), and the display it became.
    for (const kind of orderFactKinds(order, before)) facts.add(kind);
    if (display === 'replaced' && after) for (const kind of orderFactKinds(after, before)) facts.add(kind);
  }
  for (const kind of facts) kinds.add(kind);
  // A replaced display's lines keep exactly the owner categories its lines had, line by line.
  if (display === 'replaced' && ctx.shownBefore) {
    const owned = lineOverrides(db, orderRef, ctx.shownBefore.latest_digest), carried = lineOverrides(db, orderRef, captureDigest);
    if (owned.size !== carried.size || [...owned].some(([line, category]) => carried.get(line) !== category)) kinds.add('categories');
  }
  const imageIds = display !== 'kept' && after ? imageIdChanges(before ?? null, after) : { added: 0, replaced: 0, removed: 0 };
  if (imageIds.replaced) kinds.add('image-ids-replaced');
  if (imageIds.removed) kinds.add('image-ids-removed');
  // The display before, as its exact SQLite cell: the importer's JSON of this read's order with that display's own image
  // IDs, byte for byte. With facts that read the same, anything else (another key order, number or string form,
  // whitespace, a repeated key, invalid UTF-8, another cell type) is how it is stored that differs.
  if (ctx.shownBefore && !facts.size && !imageIds.replaced && !imageIds.removed
    && (!before || ctx.shownBefore.image !== imageOf(JSON.stringify(withImageIdsOf(order, before))))) kinds.add('order-stored-form');
  const changed = reportOrder(kinds);
  const kind: BatchClass = stored ? 'already-imported' : changed.length ? 'facts-changed'
    : display === 'replaced' && imageIds.added > 0 ? 'image-ids-only' : 'no-new-image-ids';
  out.result = { receipt, classification: { class: kind, display, imageIds, changed } };
  if (kind !== 'image-ids-only') throw new HoldrRefusal(BATCH_CAPTURE_REFUSED);
  return out.result;
}
/** classifiedCaptureWrite in its own IMMEDIATE transaction: each batch capture after the first, and each preview capture. */
export function importClassifiedCapture(db: Database, capture: ValidatedCapture, captureDigest: string, now: string,
  out: CaptureOut): ClassifiedCapture {
  if (db.inTransaction) return refuse();
  try {
    return db.transaction(() => classifiedCaptureWrite(db, capture, captureDigest, now, out)).immediate();
  } catch (error) {
    throw toValueFreeDbError('amazon batch capture write', error);
  }
}
/**
 * Preview only, on its own clone: what the importer's global recheck changes before any capture, as kinds. That
 * recheck is the `reconcile` command's work: charge-free proof revocation, the refund event projection and
 * reconciliation. It commits, so captures are classified on a settled clone. Any kind means the database needs a
 * GO'd `reconcile` before a batch, whose first capture would otherwise be refused for it.
 */
export function settleBaseline(db: Database, now: string): BatchChangeKind[] {
  if (db.inTransaction) return refuse();
  try {
    return db.transaction(() => {
      const schema = schemaDigest(db), countersBefore = counters(db);
      ensureAmazonSchema(db);
      const kinds = new Set<BatchChangeKind>(schemaDigest(db) === schema ? [] : ['schema']);
      installChangeLog(db);
      revokeContradictedProofs(db, now);
      projectRefunds(db, now);
      reconcileAmazon(db, now);
      for (const kind of changeKinds(db, readChangeLog(db), null)) kinds.add(kind);
      for (const kind of counterKinds(countersBefore, counters(db))) kinds.add(kind);
      return reportOrder(kinds);
    }).immediate();
  } catch (error) {
    throw toValueFreeDbError('amazon batch baseline', error);
  }
}
/** A classified capture's value-free result: its classification and the importer receipt's counts, holds and coverage. */
export function capturedResult({ receipt, classification }: ClassifiedCapture) {
  const { captureDigest: _captureDigest, ...counts } = receipt;
  return { ...classification, receipt: counts };
}

/**
 * A new owner-only copy of a database, by SQLite's online backup: the clone both batch commands preview on. A source in
 * a transaction is refused before anything is created: better-sqlite3 takes a backup's first busy step as done, and a
 * source in a write transaction is busy at once, so its clone would be an empty file (the backup sweep, 11/09).
 */
export async function makeClone(source: Database, clone: string): Promise<void> {
  if (source.inTransaction) throw new HoldrRefusal('amazon backup refused');
  fs.closeSync(fs.openSync(clone, 'wx', 0o600));
  await source.backup(clone);
  fs.chmodSync(clone, 0o600);
}
export interface BatchCapture { inputDigest: string; capture: ValidatedCapture }
/** A capture's outcome in a preview: its classification, or the closed reason its write failed. */
export interface PreviewOutcome { inputDigest: string; result?: ClassifiedCapture; failure?: 'input-refused' | 'operation-failed' }
/**
 * The full preview, on a clone the caller owns: the baseline settled (settleBaseline), then each capture classified in
 * its own transaction, in order, kept on the clone only when image-IDs-only.
 */
export function previewOnClone(db: Database, captures: readonly BatchCapture[], now: () => string):
  { baseline: BatchChangeKind[]; outcomes: PreviewOutcome[] } {
  const baseline = settleBaseline(db, now());
  const outcomes = captures.map(({ inputDigest, capture }): PreviewOutcome => {
    const out: CaptureOut = {};
    try {
      return { inputDigest, result: importClassifiedCapture(db, capture, inputDigest, now(), out) };
    } catch (error) {
      return out.result && out.result.classification.class !== 'image-ids-only' ? { inputDigest, result: out.result }
        : { inputDigest, failure: error instanceof HoldrRefusal ? 'input-refused' : 'operation-failed' };
    }
  });
  return { baseline, outcomes };
}
/** Where a preview stops a batch: a pending baseline, or the first capture that is not image-IDs-only. Null: it passed. */
export function previewRefusal(preview: { baseline: BatchChangeKind[]; outcomes: PreviewOutcome[] }): BatchRefusal | null {
  if (preview.baseline.length) {
    return { stage: 'preview', index: null, inputDigest: null, reason: 'baseline-pending', changed: preview.baseline, rollback: 'not-started' };
  }
  const index = preview.outcomes.findIndex(outcome => outcome.result?.classification.class !== 'image-ids-only');
  if (index < 0) return null;
  const { inputDigest, result, failure } = preview.outcomes[index];
  return { stage: 'preview', index, inputDigest, reason: result?.classification.class ?? failure ?? 'operation-failed',
    changed: result?.classification.changed ?? [], rollback: 'not-started' };
}
/**
 * The first capture's transaction: the capture, classified, and the GO recorded as used, both in a savepoint. The GO
 * record commits with the capture, so it must add exactly its own audit row and nothing else (kindsBeyond); anything
 * more refuses the capture as `facts-changed`. When the capture is refused, the savepoint rolls back, and the rollback is
 * verified (verifyRolledBack) in the same IMMEDIATE transaction, so no other writer intervened. `check.rollback`
 * reports what happened.
 */
function firstCaptureWrite(db: Database, go: BatchGo, capture: ValidatedCapture, captureDigest: string,
  now: string, out: CaptureOut, check: { rollback: BatchRefusal['rollback'] }): ClassifiedCapture {
  if (db.inTransaction) return refuse();
  try {
    return db.transaction(() => {
      check.rollback = 'unverified';
      const baseline = rollbackBaseline(db);
      try {
        return db.transaction(() => {
          const classified = classifiedCaptureWrite(db, capture, captureDigest, now, out);
          const mark = changeLogEnd(db), countersBefore = counters(db);
          recordBatchGo(db, go.goId, go.goDigest, now);
          out.changes = readChangeLog(db);
          const beyond = kindsBeyond(db, mark, [goUseRow(go, now)], countersBefore);
          if (beyond.size) {
            out.result = { ...classified, classification: { ...classified.classification, class: 'facts-changed',
              changed: reportOrder(new Set([...classified.classification.changed, ...beyond])) } };
            throw new HoldrRefusal(BATCH_CAPTURE_REFUSED);
          }
          return classified;
        })();
      } catch (error) {
        check.rollback = verifyRolledBack(db, baseline, out.changes) && !batchGoUsed(db, go.goId) ? 'verified' : 'unverified';
        throw error;
      }
    }).immediate();
  } catch (error) {
    throw toValueFreeDbError('amazon batch capture write', error);
  }
}
export interface BatchRun {
  imported: number;
  /** The refusal that stopped the run, with whether it was logged; null when every capture was imported. */
  refusal: (BatchRefusal & { logged: boolean }) | null;
  entries: Array<Record<string, unknown>>;
}
/** Logs a refusal with its GO (recordBatchRefusal): whether that succeeded. */
function logRefusal(db: Database, go: BatchGo, refusal: BatchRefusal, now: string, spend: boolean): boolean {
  try {
    recordBatchRefusal(db, go, refusal, now, spend);
    return true;
  } catch {
    return false;
  }
}
/**
 * A batch's writes, after its one backup (taken by the caller). Root's GO rule:
 * - the run's attempt is recorded first (recordBatchAttempt), only while its GO is `unused`; otherwise the run throws
 *   having written nothing;
 * - a refusal by the run's own preview (`refusedByPreview`) is then logged, and no capture is written;
 * - otherwise each capture runs in its own transaction, kept only when image-IDs-only, in order, and the first refusal
 *   stops the run;
 * - the first capture's transaction also records the GO as used, so any committed capture consumes the GO;
 * - a refused first capture leaves the GO unused only when its rollback is verified; otherwise its refusal records
 *   the GO as used;
 * - every refusal is logged with the GO, after its rollback. One that cannot be logged leaves the GO `unlogged`.
 */
export function runBatchCaptures(db: Database, go: BatchGo, captures: readonly BatchCapture[],
  now: () => string, refusedByPreview: BatchRefusal | null = null): BatchRun {
  const entries: Array<Record<string, unknown>> = [];
  let imported = 0, refusal: BatchRun['refusal'] = null;
  recordBatchAttempt(db, go, now());
  if (refusedByPreview) refusal = { ...refusedByPreview, logged: logRefusal(db, go, refusedByPreview, now(), false) };
  for (const [index, { inputDigest, capture }] of captures.entries()) {
    if (refusal) {
      entries.push(refusal.stage === 'preview' && refusal.index === index
        ? { index, inputDigest, code: 'refused', reason: refusal.reason, changed: refusal.changed }
        : { index, inputDigest, code: 'not-attempted' });
      continue;
    }
    const out: CaptureOut = {}, at = now(), check: { rollback: BatchRefusal['rollback'] } = { rollback: 'not-started' };
    try {
      const result = index === 0 ? firstCaptureWrite(db, go, capture, inputDigest, at, out, check)
        : importClassifiedCapture(db, capture, inputDigest, at, out);
      entries.push({ index, inputDigest, code: 'imported', ...capturedResult(result) });
      imported++;
    } catch (error) {
      const classified = out.result && out.result.classification.class !== 'image-ids-only' ? out.result : null;
      const record: BatchRefusal = { stage: 'database', index, inputDigest,
        reason: classified ? classified.classification.class : error instanceof HoldrRefusal ? 'input-refused' : 'operation-failed',
        changed: classified?.classification.changed ?? [], rollback: index === 0 ? check.rollback : 'not-checked' };
      refusal = { ...record, logged: logRefusal(db, go, record, at, index === 0 && record.rollback === 'unverified') };
      entries.push({ index, inputDigest, code: 'refused', reason: record.reason, ...(classified ? capturedResult(classified) : {}) });
    }
  }
  return { imported, refusal, entries };
}
