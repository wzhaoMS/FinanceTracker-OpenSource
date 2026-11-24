import type { Database } from 'better-sqlite3';
import { isAmazonTaxonomyNode, type AmazonTaxonomyNodeId, type AmazonTaxonomySource } from '@finance-tracker/shared';
import { lineTieKeys } from './allocation.js';
import { digest, opaque, refuse } from './policy.js';
import { publicTitle, validTitle } from './products.js';
import { hasAmazonSchema } from './schema.js';
import type { ItemObservation, OrderObservation } from './types.js';

/**
 * Keyless taxonomy holds (Root, after STEP 9). Root's B2 rule (ownerDecisions.ts `taxonomyDecisions`) keeps a display
 * when a displayed line's item taxonomy decision cannot follow a re-read. Two such holds leave no learned key that
 * `adopt-keys` or a mapping could reach:
 * - `ambiguous-match`: the line's identity-matched line in the re-read (the same ASIN when it has one, else the exact
 *   title) is not unique: there are several, or none;
 * - `card-data-guard`: its one matched line has a title the card-data guard holds, so it has no classifiable key.
 * The owner resolves one by deciding the line's taxonomy node by its stable line identity, under a Root GO
 * (taxonomyLineDecisions.ts). This module is that decision's storage and the identities it is keyed by.
 *
 * Storage is the additive `amazon_line_taxonomy` table: one owner decision (confidence 1) per line identity and product
 * (its ASIN, '' when none). It is not
 * part of `AMAZON_SCHEMA`, and nothing creates it at startup or on a read: only the backed-up, Root-GO-gated line
 * decision import installs it, inside its write transaction. Reads treat an absent or conflicting table (exact-SQL
 * detection) as "no line decided". A display replacement only ever moves decisions with their lines, to the lines'
 * places in the re-read.
 */
export type TaxonomyLineFamily = 'ordinary' | 'fresh';
export const TAXONOMY_LINE_FAMILIES: readonly TaxonomyLineFamily[] = Object.freeze(['ordinary', 'fresh']);
export const TAXONOMY_KEYLESS_REASONS = Object.freeze(['ambiguous-match', 'card-data-guard'] as const);
export type TaxonomyKeylessReason = typeof TAXONOMY_KEYLESS_REASONS[number];

/**
 * An order item's stable line identity: order-history v3's `lineTieKeys` (allocation.ts), its order, exact title and
 * occurrence among the order's lines with that title, by line ordinal. A display replacement is a per-fact superset,
 * which never changes a known title, so a re-read keeps every displayed line's identity. Empty unless every line has its
 * ordinal (a v3 read).
 */
export function orderLineIdentities(orderId: string, items: readonly ItemObservation[]): Map<number, string> {
  if (!items.every(item => Number.isSafeInteger(item.lineOrdinal))) return new Map();
  return lineTieKeys({ orderId, items } as unknown as OrderObservation);
}
/**
 * An Amazon Fresh line's stable line identity, by the same rule as an order item's under its own kind: its order, its
 * exact title and its occurrence among the list's readable lines with that title, by line ordinal. It names no
 * capture-scoped value (the list's digest, a line's ref, a run), so re-reading the same list keeps it, and so does a line
 * that learns or loses its ASIN. A renamed line (the guard case: its ASIN under a title the card-data guard holds) is
 * matched by its ASIN, and an owner's decision moves with it to its new identity, a digest: no title is ever stored.
 */
export function freshLineIdentities(orderId: string, lines: ReadonlyArray<{ lineOrdinal: number; title: string }>): Map<number, string> {
  const seen = new Map<string, number>(), identities = new Map<number, string>();
  for (const line of [...lines].sort((a, b) => a.lineOrdinal - b.lineOrdinal)) {
    const occurrence = seen.get(line.title) ?? 0;
    seen.set(line.title, occurrence + 1);
    identities.set(line.lineOrdinal, opaque('fresh-line-identity', [orderId, line.title, occurrence]));
  }
  return identities;
}

const AMAZON_LINE_TAXONOMY_SCHEMA_SQL = `CREATE TABLE amazon_line_taxonomy (
  line_identity TEXT NOT NULL CHECK(length(line_identity)=52 AND substr(line_identity,1,4)='amz-'
    AND substr(line_identity,5) NOT GLOB '*[^a-f0-9]*'),
  asin TEXT NOT NULL CHECK(asin='' OR (length(asin)=10 AND asin NOT GLOB '*[^A-Z0-9]*')),
  family TEXT NOT NULL CHECK(family IN ('ordinary','fresh')),
  node TEXT NOT NULL CHECK(length(node) BETWEEN 1 AND 100 AND node NOT GLOB '*[^a-z0-9/-]*'),
  taxonomy_version INTEGER NOT NULL CHECK(taxonomy_version>=1),
  mapping_digest TEXT NOT NULL CHECK(length(mapping_digest)=64 AND mapping_digest NOT GLOB '*[^a-f0-9]*'),
  PRIMARY KEY(line_identity,asin)
)`;
const normalizeSql = (sql: string) => sql.trim().replace(/\s+/g, ' ');
/** What a line decision import's Root GO pins as its `schemaDigest`: the one table that import may install. */
export const AMAZON_TAXONOMY_LINE_SCHEMA_DIGEST = digest(normalizeSql(AMAZON_LINE_TAXONOMY_SCHEMA_SQL));

/** Read-only capability detection: absence or a conflicting table means no line is decided, never repaired by a read. */
export function hasAmazonLineTaxonomySchema(db: Database): boolean {
  const object = db.prepare("SELECT type,sql FROM sqlite_master WHERE name='amazon_line_taxonomy'").get() as
    { type: string; sql: string | null } | undefined;
  return object?.type === 'table' && typeof object.sql === 'string'
    && normalizeSql(object.sql) === normalizeSql(AMAZON_LINE_TAXONOMY_SCHEMA_SQL);
}
/** Whether any object holds the table's name, whatever its shape. */
export function lineTaxonomyNameTaken(db: Database): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name='amazon_line_taxonomy'").get());
}
/** Only the backed-up, Root-GO-gated line decision import calls this, inside its write transaction. */
export function installAmazonLineTaxonomySchema(db: Database): void {
  if (!db.inTransaction || !hasAmazonSchema(db)) return refuse();
  if (hasAmazonLineTaxonomySchema(db)) return;
  if (lineTaxonomyNameTaken(db)) return refuse();
  db.exec(AMAZON_LINE_TAXONOMY_SCHEMA_SQL);
  if (!hasAmazonLineTaxonomySchema(db)) return refuse();
}

/**
 * Where an owner line decision is stored: the decided line's identity, and its product's ASIN ('' when it has none). A
 * decision applies only to a line that holds that identity and is exactly that product: the same ASIN, or no ASIN for a
 * decision stored without one. So a line of another product that comes to hold the identity never reads it. When a
 * decided line's own line learns or loses its ASIN, a display replacement moves the decision to that product with it.
 */
export interface LineTaxonomyKey { identity: string; asin: string }
export const lineKey = (identity: string, asin: string | null): LineTaxonomyKey => ({ identity, asin: asin ?? '' });
const keyText = (key: LineTaxonomyKey) => `${key.identity}|${key.asin}`;
/** The owner's decision for one line. */
export interface LineTaxonomyDecision {
  family: TaxonomyLineFamily;
  node: AmazonTaxonomyNodeId;
  taxonomyVersion: number;
  mappingDigest: string;
}
/** A decision as it is stored, with its key. */
export interface StoredLineTaxonomyDecision extends LineTaxonomyDecision { key: LineTaxonomyKey }
/** A line decision as the taxonomy resolves it: the owner's, which always wins. */
export const lineAssignment = (decision: Pick<LineTaxonomyDecision, 'node'>) =>
  ({ node: decision.node, source: 'owner' as const, confidence: 1 });
/**
 * The decision that applies to a line holding `identity`, of product `asin` (null: none): the one stored under exactly
 * that product. Null without the exact table, or for a node the taxonomy doesn't have (never guessed).
 */
export function lineTaxonomyDecisionReader(db: Database): (identity: string, asin: string | null) => StoredLineTaxonomyDecision | null {
  if (!hasAmazonLineTaxonomySchema(db)) return () => null;
  const row = db.prepare(`SELECT family,node,taxonomy_version AS taxonomyVersion,mapping_digest AS mappingDigest
    FROM amazon_line_taxonomy WHERE line_identity=? AND asin=?`);
  return (identity, asin) => {
    const key = lineKey(identity, asin), found = row.get(key.identity, key.asin) as LineTaxonomyDecision | undefined;
    return found && isAmazonTaxonomyNode(found.node) ? { ...found, key } : null;
  };
}
/** Whether a decision is stored under exactly `key`, whatever it says. */
export function lineTaxonomyKeyReader(db: Database): (key: LineTaxonomyKey) => boolean {
  if (!hasAmazonLineTaxonomySchema(db)) return () => false;
  const row = db.prepare('SELECT 1 FROM amazon_line_taxonomy WHERE line_identity=? AND asin=?').pluck();
  return (key) => row.get(key.identity, key.asin) !== undefined;
}
/** One family's owner line decisions, for a read: by line identity and exact product (null: none). */
export interface LineTaxonomyLookup { size: number; get(identity: string, asin: string | null): LineTaxonomyDecision | undefined }
/** Every line decision of one family, for a read: `get` answers as lineTaxonomyDecisionReader does. */
export function lineTaxonomyLookup(db: Database, family: TaxonomyLineFamily): LineTaxonomyLookup {
  const byIdentity = new Map<string, Map<string, LineTaxonomyDecision>>();
  if (hasAmazonLineTaxonomySchema(db)) {
    for (const row of db.prepare(`SELECT line_identity AS identity,asin,node,taxonomy_version AS taxonomyVersion,
        mapping_digest AS mappingDigest FROM amazon_line_taxonomy WHERE family=? ORDER BY line_identity,asin`).all(family) as
      Array<{ identity: string; asin: string; node: string; taxonomyVersion: number; mappingDigest: string }>) {
      if (!isAmazonTaxonomyNode(row.node)) continue;
      const decisions = byIdentity.get(row.identity) ?? new Map<string, LineTaxonomyDecision>();
      decisions.set(row.asin, { family, node: row.node, taxonomyVersion: row.taxonomyVersion, mappingDigest: row.mappingDigest });
      byIdentity.set(row.identity, decisions);
    }
  }
  return { size: byIdentity.size, get: (identity, asin) => byIdentity.get(identity)?.get(asin ?? '') };
}
/**
 * A Fresh order's owner line decisions, line by line (each line's stable identity and exact product), for an item view
 * that resolves its lines' nodes (freshItems.ts countFreshLines); undefined when no Fresh line is decided.
 */
export function freshLineDecisions(decisions: LineTaxonomyLookup, orderId: string,
  lines: ReadonlyArray<{ lineOrdinal: number; title: string }>):
  ((line: { lineOrdinal: number; asin: string | null }) => LineTaxonomyDecision | undefined) | undefined {
  if (!decisions.size) return undefined;
  const identities = freshLineIdentities(orderId, lines);
  return (line) => decisions.get(identities.get(line.lineOrdinal)!, line.asin);
}
/** A decided displayed line, and where its own line of the re-read would hold its decision (null: it has none there). */
export interface LineTaxonomyClaim { decision: StoredLineTaxonomyDecision; to: LineTaxonomyKey | null }
/** An owner line decision moving with its line, from where it is stored to its line's place in the re-read. */
export interface LineTaxonomyMove extends LineTaxonomyDecision { from: LineTaxonomyKey; to: LineTaxonomyKey }
/**
 * Read-only: the moves one display replacement makes, as one set. Each decided line whose own line of the re-read is
 * stored elsewhere moves there, unless that place is taken: by a decision that stays (stored, and not moving away in
 * this replacement), or by an earlier claim (claims go in display order). A move that cannot be made leaves its
 * decision where it is, which may take another move's place, so the set narrows until every place is free. A decided
 * line with no line of its own in the re-read keeps its decision where it is; only its own product could ever read it.
 */
export function planLineTaxonomyMoves(claims: readonly LineTaxonomyClaim[], stored: (key: LineTaxonomyKey) => boolean):
  LineTaxonomyMove[] {
  let moves = claims.flatMap(({ decision: { key, ...decision }, to }): LineTaxonomyMove[] =>
    (to !== null && keyText(to) !== keyText(key) ? [{ ...decision, from: key, to }] : []));
  for (;;) {
    const leaving = new Set(moves.map(move => keyText(move.from))), claimed = new Set<string>();
    const kept = moves.filter(move => {
      const place = keyText(move.to);
      if (claimed.has(place) || (stored(move.to) && !leaving.has(place))) return false;
      claimed.add(place);
      return true;
    });
    if (kept.length === moves.length) return kept;
    moves = kept;
  }
}
/**
 * Inside a display replacement's write: the moves, as one set. Every moving decision leaves first, then each is stored
 * at its line's place, keeping its version and mapping digest, so chains and swaps of identities move whole. Only with
 * the (exact) table, never created here; a move that finds anything else throws and the write rolls back.
 */
export function moveLineTaxonomies(db: Database, moves: readonly LineTaxonomyMove[]): void {
  if (!moves.length) return;
  if (!hasAmazonLineTaxonomySchema(db)) return refuse();
  const remove = db.prepare('DELETE FROM amazon_line_taxonomy WHERE line_identity=? AND asin=?');
  const insert = db.prepare(`INSERT INTO amazon_line_taxonomy(line_identity,asin,family,node,taxonomy_version,mapping_digest)
    VALUES(?,?,?,?,?,?)`);
  for (const move of moves) if (remove.run(move.from.identity, move.from.asin).changes !== 1) return refuse();
  for (const move of moves) insert.run(move.to.identity, move.to.asin, move.family, move.node, move.taxonomyVersion, move.mappingDigest);
}

/** A taxonomy decision's full tuple (Root's B2: node, source and confidence). */
export interface TaxonomyDecisionTuple { node: AmazonTaxonomyNodeId; source: AmazonTaxonomySource; confidence: number }
/**
 * Private: one displayed line whose taxonomy decision a retained re-read holds for want of a key. Never printed; the
 * worklist file lists it for the owner. `title` is the line's own title only when the card-data guard lets it be shown,
 * else null: a guarded title is never stored or echoed.
 */
export interface TaxonomyKeylessHold {
  family: TaxonomyLineFamily;
  lineIdentity: string;
  reason: TaxonomyKeylessReason;
  /** The decision that cannot follow: the line's product key's winning decision. */
  held: TaxonomyDecisionTuple;
  /**
   * The product the owner reviews, pinned (`lineProductPin`): a line decision applies only while the line at its identity
   * is still this product, never another product that later takes the identity. A digest: no title, ASIN or key.
   */
  product: string;
  productKey: string;
  asin: string | null;
  title: string | null;
}
/**
 * A keyless hold's product pin: the held line's product key (its ASIN, or none, with its exact title), scoped to the
 * line's family and identity, as a digest. A later display whose line at that identity is another product pins another.
 */
export const lineProductPin = (family: TaxonomyLineFamily, lineIdentity: string, productKey: string): string =>
  opaque('taxonomy-line-product', [family, lineIdentity, productKey]);
/** A title only when the card-data guard lets it be shown. */
export const shownTitle = (title: unknown): string | null =>
  typeof title === 'string' && validTitle(title) && publicTitle(title) === title ? title : null;
/** Counts only, by family and reason: what the worklist and plan print. */
export type TaxonomyKeylessCounts = Record<TaxonomyLineFamily, Record<TaxonomyKeylessReason, number>>;
export function taxonomyKeylessCounts(holds: Iterable<Pick<TaxonomyKeylessHold, 'family' | 'reason'>>): TaxonomyKeylessCounts {
  const counts = Object.fromEntries(TAXONOMY_LINE_FAMILIES.map(family =>
    [family, Object.fromEntries(TAXONOMY_KEYLESS_REASONS.map(reason => [reason, 0]))])) as TaxonomyKeylessCounts;
  for (const hold of holds) counts[hold.family][hold.reason]++;
  return counts;
}
