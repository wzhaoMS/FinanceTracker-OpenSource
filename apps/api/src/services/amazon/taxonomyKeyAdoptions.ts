import type { Database } from 'better-sqlite3';
import { AMAZON_ITEM_TAXONOMY_VERSION, type AmazonTaxonomyNodeId, type AmazonTaxonomySource } from '@finance-tracker/shared';
import { hasAmazonSchema } from './schema.js';
// STEP 9 integration B8 (Root): every retained Fresh Item List read, through the one Fresh reader.
import { freshListReads } from './freshAdapter.js';
import {
  AMAZON_TAXONOMY_MAPPING_FORMAT, classifiableProductKey, hasAmazonTaxonomySchema, knownTaxonomyProductKeys, readTaxonomyAssignments,
  validateTaxonomyMapping, type TaxonomyAssignment, type TaxonomyMapping,
} from './taxonomy.js';
import type { ItemObservation, OrderObservation } from './types.js';

/**
 * Taxonomy key adoptions (Root, after #168). A product key is `productKey({ asin, title })`, so a re-read that learns a
 * line's ASIN (or reads its ASIN under another title) gives the same line a new key that no taxonomy row names, and the
 * item would fall back to Needs review. The new key adopts the previous key's assignment unchanged (node, source and
 * confidence), so it resolves exactly as before, through the next GO'd taxonomy import (`adopt-keys`, then plan and
 * import), with no re-classification. Detection is taxonomy-native: it reads every order's reads, so it covers the
 * items no agent card category names, which #168's `categoryKeyAdoptions(db)` never lists. That list (or any other
 * `{ productKey, previousProductKey }` source) joins through `extra`. Read-only, private: never printed.
 * STEP 9 integration B8 (Root): and every Amazon Fresh order's Item List reads, so a held Fresh line's learned key adopts
 * its previous key's assignment the same way, under the same application-time check (`adoption-stale`, taxonomy.ts).
 */
export interface TaxonomyKeyChange {
  productKey: string;
  previousProductKey: string;
}
export interface TaxonomyKeyAdoption extends TaxonomyKeyChange {
  node: AmazonTaxonomyNodeId;
  source: AmazonTaxonomySource;
  confidence: number;
}
/** What a worklist product would adopt: the previous key and its assignment. */
export type TaxonomyAdoptFrom = Omit<TaxonomyKeyAdoption, 'productKey'>;

// STEP 9 integration B8 (Root): a read line, an order item's or an Amazon Fresh line's.
type ReadLine = Pick<ItemObservation, 'itemId' | 'title'>;
/** #168's line identity: the same ASIN when the earlier line has one, else the exact same title. */
const sameLine = (earlier: ReadLine, later: ReadLine) =>
  earlier.itemId !== null ? later.itemId === earlier.itemId : later.title === earlier.title;
const byKey = (a: TaxonomyKeyChange, b: TaxonomyKeyChange) => (a.productKey < b.productKey ? -1 : a.productKey > b.productKey ? 1
  : a.previousProductKey < b.previousProductKey ? -1 : a.previousProductKey > b.previousProductKey ? 1 : 0);

/**
 * Every product key a later read of an order gives a line an earlier read keyed otherwise. Reads are the order's
 * `order` observations in capture order (`amazon_captures.rowid`), displayed or not: a re-read that replaced the display
 * leaves the old key in an earlier capture, and a held display leaves the new key in a later read. For each classifiable
 * line of an earlier read, the change counts only when exactly one line of the later read has its identity and that
 * line's key is classifiable and different. A title the card-data guard holds is never a key. [] without the Amazon schema.
 * STEP 9 integration B8 (Root): a Fresh order's Item List reads (freshAdapter.ts freshListReads: every list the import
 * retained, active or not, in import order) are examined exactly so, as a sequence of their own: a Fresh re-read held
 * `taxonomy-unmatched` (B4) names its learned key here, as a held ordinary read does. An order's Fresh lines and its
 * order items are never matched with each other.
 */
export function taxonomyKeyChanges(db: Database): TaxonomyKeyChange[] {
  if (!hasAmazonSchema(db)) return [];
  return db.transaction((): TaxonomyKeyChange[] => {
    const reads = new Map<string, ItemObservation[][]>();
    for (const row of db.prepare(`SELECT b.order_ref,b.data_json FROM amazon_observations b
      JOIN amazon_captures c ON c.digest=b.capture_digest
      WHERE b.family='order' AND b.order_ref IS NOT NULL ORDER BY b.order_ref,c.rowid,b.ordinal`).all() as
      Array<{ order_ref: string; data_json: string }>) {
      const order = JSON.parse(row.data_json) as Partial<OrderObservation>;
      const list = reads.get(row.order_ref) ?? [];
      list.push(Array.isArray(order.items) ? order.items : []);
      reads.set(row.order_ref, list);
    }
    // STEP 9 integration B8 (Root): each Fresh order's Item List reads, in import order, as a sequence of their own.
    const freshReads = new Map<string, ReadLine[][]>();
    for (const read of freshListReads(db)) {
      const list = freshReads.get(read.orderRef) ?? [];
      list.push(read.lines);
      freshReads.set(read.orderRef, list);
    }
    const sequences: ReadLine[][][] = [...reads.values(), ...freshReads.values()];
    const changes = new Map<string, TaxonomyKeyChange>();
    for (const list of sequences) {
      for (let earlier = 0; earlier < list.length; earlier++) {
        for (const line of list[earlier]) {
          const previousProductKey = classifiableProductKey(line);
          if (previousProductKey === null) continue;
          for (let later = earlier + 1; later < list.length; later++) {
            const matches = list[later].filter(candidate => sameLine(line, candidate));
            if (matches.length !== 1) continue;
            const productKey = classifiableProductKey(matches[0]);
            if (productKey === null || productKey === previousProductKey) continue;
            changes.set(`${productKey}:${previousProductKey}`, { productKey, previousProductKey });
          }
        }
      }
    }
    return [...changes.values()].sort(byKey);
  })();
}

/**
 * The key changes a GO'd taxonomy import may adopt: `taxonomyKeyChanges(db)` and `extra` (e.g. #168's
 * `categoryKeyAdoptions(db)`, whose other fields are ignored), kept only when the previous key has a winning assignment,
 * the new key has no taxonomy row of any source, and the new key is one the import accepts (`knownTaxonomyProductKeys`).
 * Each carries its previous key's node, source and confidence unchanged: a sub-0.6 agent row stays a Needs-review
 * suggestion. Several previous keys may claim one new key only when they agree on node and source; it then takes their
 * lowest confidence (and that claim's previous key). Otherwise the key is left out and classified like any other.
 * Sorted by product key. Read-only; an adopted key drops out, as it then has an assignment.
 */
export function taxonomyKeyAdoptions(db: Database, extra: Iterable<TaxonomyKeyChange> = []): TaxonomyKeyAdoption[] {
  return db.transaction((): TaxonomyKeyAdoption[] => {
    const assignments = readTaxonomyAssignments(db);
    if (assignments.size === 0) return [];
    const stored = new Set(hasAmazonTaxonomySchema(db)
      ? db.prepare('SELECT DISTINCT product_key FROM amazon_product_taxonomy').pluck().all() as string[] : []);
    const known = knownTaxonomyProductKeys(db);
    const claims = new Map<string, Map<string, TaxonomyAssignment>>();
    const claim = (change: TaxonomyKeyChange) => {
      const { productKey, previousProductKey } = (change ?? {}) as Partial<TaxonomyKeyChange>;
      if (typeof productKey !== 'string' || typeof previousProductKey !== 'string' || productKey === previousProductKey) return;
      const from = assignments.get(previousProductKey);
      if (!from || stored.has(productKey) || !known.has(productKey)) return;
      const list = claims.get(productKey) ?? new Map<string, TaxonomyAssignment>();
      list.set(previousProductKey, from);
      claims.set(productKey, list);
    };
    for (const change of taxonomyKeyChanges(db)) claim(change);
    for (const change of extra) claim(change);
    const adoptions: TaxonomyKeyAdoption[] = [];
    for (const [productKey, list] of claims) {
      const all = [...list].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const [, first] = all[0];
      if (all.some(([, a]) => a.node !== first.node || a.source !== first.source)) continue;
      const [previousProductKey, lowest] = all.reduce((low, next) => (next[1].confidence < low[1].confidence ? next : low));
      adoptions.push({ productKey, previousProductKey, node: lowest.node, source: lowest.source, confidence: lowest.confidence });
    }
    return adoptions.sort(byKey);
  })();
}

/**
 * `adopt-keys`' private import mapping, with its provenance (Root): `kind: 'adoption'`, and per entry the new key, the
 * previous key and the exact adopted node, source and confidence. Its import re-checks each entry inside the write
 * (taxonomy.ts, `adoption-stale`). Null when there is nothing to adopt.
 */
export function taxonomyAdoptionMapping(db: Database, extra: Iterable<TaxonomyKeyChange> = []): TaxonomyMapping | null {
  const adoptions = taxonomyKeyAdoptions(db, extra);
  if (adoptions.length === 0) return null;
  return validateTaxonomyMapping({ format: AMAZON_TAXONOMY_MAPPING_FORMAT, version: 1, taxonomyVersion: AMAZON_ITEM_TAXONOMY_VERSION,
    reviewed: true, kind: 'adoption', entries: adoptions.map(({ productKey, previousProductKey, node, confidence, source }) =>
      ({ productKey, previousProductKey, node, confidence, source })) });
}
