import type { Database } from 'better-sqlite3';
import { digest, opaque, refuse } from './policy.js';
// STEP 9 integration (B4)
import {
  // STEP 9 integration (B9)
  FRESH_LIST_FORMAT, freshLineRecord, freshListRecord, hasAmazonFreshSchema, installAmazonFreshSchema, type FreshLineRecord,
  type FreshListRecord,
} from './freshSchema.js';
import { carryOwnerTaxonomy, taxonomyDecisions, type TaxonomyCarry } from './ownerDecisions.js';
import { classifiableProductKey } from './taxonomy.js';
// Keyless holds (Root, after STEP 9): owner line decisions follow a Fresh line by its stable identity.
import {
  freshLineIdentities, lineKey, lineProductPin, moveLineTaxonomies, planLineTaxonomyMoves, shownTitle, type LineTaxonomyClaim,
  type LineTaxonomyMove, type TaxonomyKeylessHold,
} from './lineTaxonomy.js';
import { hasAmazonSchema } from './schema.js';
import type { Staging } from './types.js';

/**
 * A capture's validated `fresh` section (tools/amazon-capture/amazon-fresh-items.mjs). A list with `source`
 * `fopo` was read from the order's Whole Foods in-store receipt (the kit's /fopo/ adapter): the importer records that
 * order's purchase channel (orderChannels.ts). Its stored list record is the same as any list's.
 */
export interface FreshSection {
  format: typeof FRESH_LIST_FORMAT;
  version: 1;
  lists: Array<{ orderId: string; statedCount: number | null; rows: number; proof: { complete: boolean; unreadRows: number };
    reconciled: boolean; lines: unknown[]; source?: 'fopo' }>;
  diagnostics: unknown[];
}

/**
 * Inside the importer's backed-up write, after the capture's orders: each Fresh Item List becomes one list observation
 * (identified by the capture and its own content, so a re-import is a no-op) and its lines. The order's latest list is
 * the newest import that is at least as proven as the one it replaces (reconciled, else whole, else partial): a partial
 * or held re-observation is kept as history and never displaces a richer list. Installs the additive Fresh tables only
 * here, only when there is a list.
 *
 * STEP 9 integration B4 (#161 x #157): the active list is a displayed item list, so Root's B2 rule (ownerDecisions.ts
 * `taxonomyDecisions`) also decides whether a re-read replaces it. Each displayed line with a taxonomy decision follows
 * its one identity-matched line of the re-read (the same ASIN when it has one, else the exact title) only to a product
 * key without any taxonomy row (the owner's decision is carried, audited `taxonomy-owner-carried`) or with the identical
 * decision (node, source, confidence). Otherwise the active list stays, the re-read is history only, and the list is
 * audited `taxonomy-unmatched` with the count of lines that could not follow, and held once under that reason.
 */
export function writeFreshLists(db: Database, captureDigest: string, staging: Staging, fresh: FreshSection, now: string,
  audit: (action: string, subject: string | null, before: unknown, after: unknown) => void,
  hold: (reason: string) => void): { lists: number; lines: number } {
  if (!db.inTransaction || staging.version !== 3 || typeof staging.runId !== 'string') return refuse();
  if (!fresh.lists.length) return { lists: 0, lines: 0 };
  installAmazonFreshSchema(db);
  let lists = 0, lines = 0;
  for (const list of fresh.lists) {
    const orderRef = opaque('order', list.orderId);
    if (!staging.orders.some(o => o.orderId === list.orderId)
      || !db.prepare('SELECT 1 FROM amazon_orders WHERE ref=?').get(orderRef)) return refuse();
    const record: FreshListRecord = { provenance: { format: FRESH_LIST_FORMAT, version: 1, runId: staging.runId, page: 'uff-itemmod' },
      statedCount: list.statedCount, rows: list.rows, proof: list.proof, reconciled: list.reconciled, lines: list.lines.length };
    const lineRecords = list.lines.map(freshLineRecord);
    if (!freshListRecord(record) || lineRecords.some(line => line === null)) return refuse();
    const listDigest = digest({ captureDigest, orderId: list.orderId, record, lines: list.lines });
    const inserted = db.prepare('INSERT OR IGNORE INTO amazon_fresh_lists VALUES(?,?,?,?)')
      .run(listDigest, orderRef, now, JSON.stringify(record)).changes;
    if (inserted) {
      for (const line of lineRecords) {
        db.prepare('INSERT INTO amazon_fresh_lines VALUES(?,?,?,?)')
          .run(opaque('fresh-line', [listDigest, line!.lineOrdinal]), listDigest, line!.lineOrdinal, JSON.stringify(line));
        lines++;
      }
      lists++;
    }
    const before = db.prepare(`SELECT f.latest_digest AS digest,l.data_json AS data FROM amazon_fresh_orders f
      JOIN amazon_fresh_lists l ON l.digest=f.latest_digest WHERE f.order_ref=?`).get(orderRef) as { digest: string; data: string } | undefined;
    // A later observation never displaces a better-proven one (reconciled, else whole, else partial); it stays as history.
    const current = before ? freshListRecord(JSON.parse(before.data)) : null;
    if (before?.digest !== listDigest && (!current || rank(record) >= rank(current))) {
      // STEP 9 integration B6 (Root, 1f309a7f): while the order's display is a charge-free proof, a re-read never replaces
      // the active list. It stays history, as an order read kept while the proof is displayed does, so a revocation that
      // restores the pre-proof display finds the list displayed with it; the next real read advances it.
      if (db.prepare(`SELECT 1 FROM amazon_orders WHERE ref=? AND json_extract(data_json,'$.chargeFree') IS NOT NULL`).get(orderRef)) {
        audit('charge-free-kept-fresh-list', orderRef, before === undefined ? undefined : { listDigest: before.digest },
          { captureDigest, listDigest });
        continue;
      }
      // STEP 9 integration (B4)
      const taxonomy = before ? followTaxonomy(db, list.orderId, before.digest, lineRecords as FreshLineRecord[]) : null;
      if (taxonomy?.held) {
        audit('taxonomy-unmatched', orderRef, undefined, { captureDigest, listDigest, lines: taxonomy.held });
        hold('taxonomy-unmatched');
        continue;
      }
      for (const carry of taxonomy?.carries ?? []) {
        if (carryOwnerTaxonomy(db, carry)) audit('taxonomy-owner-carried', null,
          { productKey: carry.from, node: carry.node }, { productKey: carry.to, node: carry.node });
      }
      // Keyless holds (Root, after STEP 9): owner line decisions move with their lines to their places in the re-read.
      moveLineTaxonomies(db, taxonomy?.lineCarries ?? []);
      for (const move of taxonomy?.lineCarries ?? []) {
        audit('taxonomy-line-owner-carried', null, { lineIdentity: move.from.identity, node: move.node },
          { lineIdentity: move.to.identity, node: move.node });
      }
      db.prepare(`INSERT INTO amazon_fresh_orders VALUES(?,?)
        ON CONFLICT(order_ref) DO UPDATE SET latest_digest=excluded.latest_digest`).run(orderRef, listDigest);
      audit('fresh-list-observation', orderRef, before === undefined ? undefined : { listDigest: before.digest }, { listDigest });
    }
  }
  return { lists, lines };
}
const rank = (record: FreshListRecord) => (record.reconciled ? 2 : record.proof.complete ? 1 : 0);
/** STEP 9 integration B9 (Root): the order's active Fresh list (its digest), null when it has none or Fresh is not installed. */
export function activeFreshList(db: Database, orderRef: string): string | null {
  return hasAmazonFreshSchema(db)
    ? (db.prepare('SELECT latest_digest FROM amazon_fresh_orders WHERE order_ref=?').pluck().get(orderRef) as string | undefined) ?? null
    : null;
}
/** STEP 9 integration B9 (Root): whether a recorded active Fresh list can be restored: none, or a retained list. */
export function freshListRestorable(db: Database, active: string | null): boolean {
  return active === null
    || (hasAmazonFreshSchema(db) && !!db.prepare('SELECT 1 FROM amazon_fresh_lists WHERE digest=?').get(active));
}
/**
 * STEP 9 integration B9 (Root): inside a revocation's write, point the order's active Fresh list back to the one recorded
 * with its proof (null: none). Returns the list shown before when it moved, else null. The caller checks
 * `freshListRestorable` first.
 */
export function restoreActiveFreshList(db: Database, orderRef: string, active: string | null): { before: string | null } | null {
  if (!db.inTransaction || !freshListRestorable(db, active)) return refuse();
  const before = activeFreshList(db, orderRef);
  if (before === active) return null;
  if (active === null) db.prepare('DELETE FROM amazon_fresh_orders WHERE order_ref=?').run(orderRef);
  else db.prepare(`INSERT INTO amazon_fresh_orders VALUES(?,?)
    ON CONFLICT(order_ref) DO UPDATE SET latest_digest=excluded.latest_digest`).run(orderRef, active);
  return { before };
}
const parsed = (text: string): unknown => { try { return JSON.parse(text); } catch { return undefined; } };
const keyOf = (line: FreshLineRecord) => classifiableProductKey({ itemId: line.asin, title: line.title });
/** A stored list's lines the Fresh tab would read: each checked whole, at the position its row says. */
function readableLines(db: Database, list: string): FreshLineRecord[] {
  return (db.prepare(`SELECT line_ordinal AS ordinal,data_json AS data FROM amazon_fresh_lines WHERE list_digest=?
    ORDER BY line_ordinal,ref`).all(list) as Array<{ ordinal: number; data: string }>).flatMap((row) => {
    const line = freshLineRecord(parsed(row.data));
    return line && line.lineOrdinal === row.ordinal ? [line] : [];
  });
}
/**
 * STEP 9 integration B4 (#161 x #157): what replacing the active list (`shown`) by `next` would do to the taxonomy
 * decisions its displayed lines show, by `taxonomyDecisions(db).follow` (Root's B2 rule, not re-implemented here): how
 * many lines' decisions cannot follow, and the owner decisions to carry to a key without any row. A displayed line is
 * one the Fresh tab reads (readable, at its position); a title the guard holds is never classified. Each follows its one
 * identity-matched line of `next`. Read-only; nothing to follow without the taxonomy table.
 * Keyless holds (Root, after STEP 9): a line the owner decided by its stable identity (lineTaxonomy.ts) follows by that
 * decision alone, never held. Its own line of the re-read: for a line with an ASIN, the re-read's lines of that ASIN, at
 * its place among the displayed lines of that ASIN (list order); if there is none (it lost its ASIN), the spare line
 * without one at its identity (`titleLines`). For a line without one, the re-read's lines of its exact title that are not
 * a displayed line's product (by ASIN) and no lost-ASIN line's, at its place among the displayed lines of its title
 * without one.
 * Its move is planned with the list's others, as one set (planLineTaxonomyMoves). A held line with no learned key
 * (`ambiguous-match`: no single match; `card-data-guard`: its match's title is one the guard holds) is listed in
 * `keyless`, for the owner to decide.
 */
function followTaxonomy(db: Database, orderId: string, shown: string, next: readonly FreshLineRecord[]):
  { held: number; carries: TaxonomyCarry[]; lineCarries: LineTaxonomyMove[]; keyless: TaxonomyKeylessHold[] } {
  const answer = { held: 0, carries: [] as TaxonomyCarry[], lineCarries: [] as LineTaxonomyMove[], keyless: [] as TaxonomyKeylessHold[] };
  const decisions = taxonomyDecisions(db);
  if (!decisions) return answer;
  const lines = readableLines(db, shown);
  const shownIds = freshLineIdentities(orderId, lines), nextIds = freshLineIdentities(orderId, next);
  const sameLine = (line: FreshLineRecord, other: FreshLineRecord) => (line.asin !== null ? other.asin === line.asin
    : other.title === line.title);
  const byPosition = (a: FreshLineRecord, b: FreshLineRecord) => a.lineOrdinal - b.lineOrdinal;
  const shownAsins = new Set(lines.flatMap((line) => (line.asin === null ? [] : [line.asin])));
  /** A displayed line's line of its ASIN in the re-read: at its place among the displayed lines of that ASIN. */
  const asinLine = (line: FreshLineRecord) => next.filter((other) => other.asin === line.asin).sort(byPosition)[
    lines.filter((other) => other.asin === line.asin && other.lineOrdinal < line.lineOrdinal).length];
  const byTitle = new Map<string, Map<number, FreshLineRecord>>();
  /**
   * For one title, the re-read's unlinked lines (of that title, and not a displayed line's product by ASIN) that the
   * displayed lines of that title without a line of their ASIN take, by line ordinal. A displayed line whose ASIN the
   * re-read lost keeps its identity: it takes the unlinked line there without an ASIN, while the re-read has more
   * unlinked lines than the display has lines of the title without an ASIN. The displayed lines without one then take
   * the rest, by their place among them (list order).
   */
  const titleLines = (title: string): Map<number, FreshLineRecord> => {
    const known = byTitle.get(title);
    if (known) return known;
    const unlinked = next.filter((other) => other.title === title && (other.asin === null || !shownAsins.has(other.asin)))
      .sort(byPosition);
    const plain = lines.filter((other) => other.asin === null && other.title === title);
    const own = new Map<number, FreshLineRecord>(), taken = new Set<FreshLineRecord>();
    let spares = unlinked.length - plain.length;
    for (const line of lines) {
      if (spares <= 0) break;
      if (line.asin === null || line.title !== title || asinLine(line)) continue;
      const there = unlinked.find((other) => other.asin === null && !taken.has(other)
        && nextIds.get(other.lineOrdinal) === shownIds.get(line.lineOrdinal));
      if (there) { own.set(line.lineOrdinal, there); taken.add(there); spares--; }
    }
    const rest = unlinked.filter((other) => !taken.has(other));
    plain.forEach((line, place) => { if (rest[place]) own.set(line.lineOrdinal, rest[place]); });
    byTitle.set(title, own);
    return own;
  };
  /** A decided line's own line of the re-read (see above); undefined when it has none. */
  const ownLine = (line: FreshLineRecord): FreshLineRecord | undefined =>
    (line.asin !== null ? asinLine(line) : undefined) ?? titleLines(line.title).get(line.lineOrdinal);
  const claims: LineTaxonomyClaim[] = [];
  for (const line of lines) {
    const identity = shownIds.get(line.lineOrdinal)!;
    const decided = decisions.lineDecisionOf(identity, line.asin);
    if (decided) {
      const own = ownLine(line);
      claims.push({ decision: decided, to: own ? lineKey(nextIds.get(own.lineOrdinal)!, own.asin) : null });
      continue;
    }
    const matches = next.filter((other) => sameLine(line, other));
    const matched = matches.length === 1 ? matches[0] : null;
    const key = keyOf(line);
    if (key === null) continue;
    const to = matched ? keyOf(matched) : null;
    const follow = decisions.follow(key, to);
    if (follow === 'held') {
      answer.held++;
      const { node, source, confidence } = decisions.decisionOf(key)!;
      if (to === null) answer.keyless.push({ family: 'fresh', lineIdentity: identity, reason: matched ? 'card-data-guard' : 'ambiguous-match',
        held: { node: node as TaxonomyKeylessHold['held']['node'], source, confidence },
        product: lineProductPin('fresh', identity, key), productKey: key, asin: line.asin, title: shownTitle(line.title) });
    } else if (follow !== 'same') answer.carries.push(follow);
  }
  answer.lineCarries = planLineTaxonomyMoves(claims, decisions.lineKeyStored);
  return answer;
}
/**
 * Keyless holds (Root, after STEP 9), read-only: each Fresh order's active-list line that a retained later list holds for
 * want of a key, as the import would hold that list now. A later list is one imported after the active one that is at
 * least as proven, so it would replace the list but for the taxonomy; an order displayed as charge-free replaces none
 * (B6). A line held by several later lists is listed once, with its latest reason. Empty without the Fresh tables.
 */
export function freshTaxonomyKeylessHolds(db: Database): TaxonomyKeylessHold[] {
  if (!hasAmazonSchema(db) || !hasAmazonFreshSchema(db)) return [];
  const orders = db.prepare(`SELECT f.order_ref AS orderRef,o.native_id AS orderId,f.latest_digest AS active,l.rowid AS position,
      l.data_json AS data FROM amazon_fresh_orders f JOIN amazon_orders o ON o.ref=f.order_ref
      JOIN amazon_fresh_lists l ON l.digest=f.latest_digest
    WHERE json_extract(o.data_json,'$.chargeFree') IS NULL ORDER BY f.order_ref`).all() as
    Array<{ orderRef: string; orderId: string; active: string; position: number; data: string }>;
  const later = db.prepare('SELECT digest,data_json AS data FROM amazon_fresh_lists WHERE order_ref=? AND rowid>? ORDER BY rowid');
  const found = new Map<string, TaxonomyKeylessHold>();
  for (const order of orders) {
    const current = freshListRecord(parsed(order.data));
    for (const list of later.all(order.orderRef, order.position) as Array<{ digest: string; data: string }>) {
      const record = freshListRecord(parsed(list.data));
      if (!record || (current && rank(record) < rank(current))) continue;
      for (const hold of followTaxonomy(db, order.orderId, order.active, readableLines(db, list.digest)).keyless) {
        found.set(hold.lineIdentity, hold);
      }
    }
  }
  return [...found.values()];
}
