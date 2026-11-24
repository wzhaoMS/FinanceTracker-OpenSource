import type { Database } from 'better-sqlite3';
import { AMAZON_ITEM_TAXONOMY_VERSION, isAmazonTaxonomyNode, type AmazonTaxonomyNodeId } from '@finance-tracker/shared';
import { HoldrRefusal } from '../dbErrors.js';
import { freshTaxonomyKeylessHolds } from './freshImport.js';
import { compareObservation } from './importer.js';
import {
  TAXONOMY_KEYLESS_REASONS, TAXONOMY_LINE_FAMILIES, hasAmazonLineTaxonomySchema, lineTaxonomyNameTaken, taxonomyKeylessCounts,
  type TaxonomyDecisionTuple, type TaxonomyKeylessCounts, type TaxonomyKeylessHold, type TaxonomyKeylessReason, type TaxonomyLineFamily,
} from './lineTaxonomy.js';
import { planItemCategories } from './ownerDecisions.js';
import { digest, exact, ref, refuse } from './policy.js';
import { hasAmazonSchema } from './schema.js';
import { AMAZON_TAXONOMY_DIGEST, AMAZON_TAXONOMY_MAPPING_FORMAT, MAX_TAXONOMY_ENTRIES, hasAmazonTaxonomySchema } from './taxonomy.js';
import type { OrderObservation } from './types.js';

/**
 * Keyless holds (Root, after STEP 9). Every hold needs a GO'd resolution path (Root's B8 principle). A display kept
 * because a line's taxonomy decision cannot follow a re-read is resolved through its learned key (`adopt-keys`, or a
 * mapping) when there is one. When there is none (lineTaxonomy.ts: `ambiguous-match`, `card-data-guard`), the owner
 * decides the line itself, by its stable line identity: a line decision mapping, planned, GO'd by Root under the same
 * pins as any taxonomy import, and re-checked inside the import's write transaction, as an adoption is.
 *
 * Visibility: `taxonomyKeylessHolds(db)` lists every such line privately (the worklist file); the worklist and plan print
 * only counts, by family and reason. A line the owner decided never holds again: the next real re-read replaces the
 * display, and the line shows the owner's decision wherever it is displayed (taxonomySpending.ts, fresh.ts).
 */

/**
 * Read-only, private: every displayed line a retained later read holds for want of a key, ordinary and Fresh, as the
 * import would hold that read now. An order's later read is one captured after its display that is a per-fact superset
 * of it (compareObservation), so it would replace the display but for the decisions from outside the order; a Fresh
 * order's is a later list at least as proven as its active one (freshImport.ts). A line held by several later reads is
 * listed once, with its latest reason. Sorted by family, then line identity. Empty without the taxonomy table.
 */
export function taxonomyKeylessHolds(db: Database): TaxonomyKeylessHold[] {
  if (!hasAmazonSchema(db) || !hasAmazonTaxonomySchema(db)) return [];
  return db.transaction((): TaxonomyKeylessHold[] => {
    const found = new Map<string, TaxonomyKeylessHold>();
    const orders = db.prepare(`SELECT o.ref,o.latest_digest,o.data_json,c.rowid AS shown FROM amazon_orders o
      JOIN amazon_captures c ON c.digest=o.latest_digest ORDER BY o.ref`).all() as
      Array<{ ref: string; latest_digest: string; data_json: string; shown: number }>;
    const later = db.prepare(`SELECT b.capture_digest,b.data_json FROM amazon_observations b
      JOIN amazon_captures c ON c.digest=b.capture_digest
      WHERE b.family='order' AND b.order_ref=? AND c.rowid>? ORDER BY c.rowid,b.ordinal`);
    for (const order of orders) {
      const shown = JSON.parse(order.data_json) as OrderObservation;
      for (const read of later.all(order.ref, order.shown) as Array<{ capture_digest: string; data_json: string }>) {
        const next = JSON.parse(read.data_json) as OrderObservation;
        if (compareObservation(next, shown) !== 'superset') continue;
        for (const hold of planItemCategories(db, order.ref, order.latest_digest, next, read.capture_digest).keyless) {
          found.set(hold.lineIdentity, hold);
        }
      }
    }
    for (const hold of freshTaxonomyKeylessHolds(db)) found.set(hold.lineIdentity, hold);
    const family = (hold: TaxonomyKeylessHold) => TAXONOMY_LINE_FAMILIES.indexOf(hold.family);
    return [...found.values()].sort((a, b) => family(a) - family(b)
      || (a.lineIdentity < b.lineIdentity ? -1 : a.lineIdentity > b.lineIdentity ? 1 : 0));
  })();
}

export const TAXONOMY_LINE_DECISION_KIND = 'line-decision';
/**
 * One owner decision: the held line (its identity, family and reason, the decision that could not follow, and the
 * product the owner reviewed, exactly as the worklist lists them) and the node the owner files it under. Source owner,
 * confidence 1.
 */
export interface TaxonomyLineDecisionEntry {
  lineIdentity: string;
  family: TaxonomyLineFamily;
  reason: TaxonomyKeylessReason;
  held: TaxonomyDecisionTuple;
  /** The reviewed product's pin (lineTaxonomy.ts `lineProductPin`), a digest. */
  product: string;
  node: AmazonTaxonomyNodeId;
}
/** A reviewed, private line decision mapping: what Root's GO pins (its digest) and the import applies. */
export interface TaxonomyLineDecisionMapping {
  format: typeof AMAZON_TAXONOMY_MAPPING_FORMAT;
  version: 1;
  taxonomyVersion: typeof AMAZON_ITEM_TAXONOMY_VERSION;
  reviewed: true;
  kind: typeof TAXONOMY_LINE_DECISION_KIND;
  entries: TaxonomyLineDecisionEntry[];
}
/** Whether a mapping file is a line decision mapping (by its `kind`), to be validated as one. */
export function isTaxonomyLineDecisionMapping(input: unknown): boolean {
  return Boolean(input) && typeof input === 'object' && !Array.isArray(input)
    && (input as Record<string, unknown>).kind === TAXONOMY_LINE_DECISION_KIND;
}
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value);
const validConfidence = (source: unknown, value: unknown): value is number => typeof value === 'number'
  && Number.isFinite(value) && value >= 0 && value <= 1 && (source === 'agent' || value === 1);
/**
 * The mapping, checked whole: its exact shape, the current taxonomy version, the owner's review, and per entry a line
 * identity (once), a family, a reason, the held decision's full tuple, the reviewed product's pin and a node the taxonomy
 * has. Anything else refuses the whole file. It carries no title, ASIN or product key.
 */
export function validateTaxonomyLineDecisions(input: unknown): TaxonomyLineDecisionMapping {
  const m = exact(input, ['format', 'version', 'taxonomyVersion', 'reviewed', 'kind', 'entries']);
  if (m.format !== AMAZON_TAXONOMY_MAPPING_FORMAT || m.version !== 1 || m.taxonomyVersion !== AMAZON_ITEM_TAXONOMY_VERSION
    || m.reviewed !== true || m.kind !== TAXONOMY_LINE_DECISION_KIND || !Array.isArray(m.entries) || m.entries.length === 0
    || m.entries.length > MAX_TAXONOMY_ENTRIES) return refuse();
  const seen = new Set<string>();
  for (const value of m.entries) {
    const e = exact(value, ['lineIdentity', 'family', 'reason', 'held', 'product', 'node']);
    const held = exact(e.held, ['node', 'source', 'confidence']);
    if (!ref(e.lineIdentity) || seen.has(e.lineIdentity) || !oneOf(TAXONOMY_LINE_FAMILIES, e.family)
      || !oneOf(TAXONOMY_KEYLESS_REASONS, e.reason) || !isAmazonTaxonomyNode(held.node) || (held.source !== 'agent' && held.source !== 'owner')
      || !validConfidence(held.source, held.confidence) || !ref(e.product) || !isAmazonTaxonomyNode(e.node)) return refuse();
    seen.add(e.lineIdentity);
  }
  return input as TaxonomyLineDecisionMapping;
}

export const TAXONOMY_LINE_DECISION_STALE = 'line-decision-stale';
/** Counts only: a refused line decision mapping's entries, those already decided, and those no longer held as pinned. */
export interface TaxonomyLineDecisionStale { entries: number; decided: number; changed: number }
const LINE_DECISION_STALE = /^line-decision-stale entries=(\d+) decided=(\d+) changed=(\d+)$/;
/**
 * A line decision mapping's precondition (Root: the same application-time check as an adoption's), as the database is
 * now: every entry's line is still a keyless hold exactly as pinned (the same family and reason, the identical held
 * decision: node, source, confidence, and the same product, so a decision reviewed for one product never files another
 * that later takes its line identity), so it has no decision that applies to it and none is ever overwritten. A mapping
 * applies once: its decisions keep its digest wherever their lines take them, so once any stored decision carries it,
 * the mapping is refused even where its decisions have moved off the identities it names. The plan checks all of this
 * read-only; the import checks it again inside its write transaction, before any write. Anything else refuses the whole
 * mapping (`line-decision-stale`, with counts only: an entry of a mapping already applied, or whose line identity has a
 * decision stored, is `decided`, any other `changed`): the operator writes the decisions again and asks for a new GO.
 * Returns the holds, by identity.
 */
function refuseStaleLineDecisions(db: Database, mapping: TaxonomyLineDecisionMapping, holds: readonly TaxonomyKeylessHold[]):
  Map<string, TaxonomyKeylessHold> {
  const stored = hasAmazonLineTaxonomySchema(db);
  const decision = stored ? db.prepare('SELECT 1 FROM amazon_line_taxonomy WHERE line_identity=? LIMIT 1').pluck() : null;
  const stale = (decided: number, changed: number) => new HoldrRefusal(`${TAXONOMY_LINE_DECISION_STALE}`
    + ` entries=${mapping.entries.length} decided=${decided} changed=${changed}`);
  if (stored && db.prepare('SELECT 1 FROM amazon_line_taxonomy WHERE mapping_digest=? LIMIT 1').get(digest(mapping)) !== undefined) {
    throw stale(mapping.entries.length, 0);
  }
  const listed = new Map(holds.map(hold => [hold.lineIdentity, hold]));
  let decided = 0, changed = 0;
  for (const e of mapping.entries) {
    const hold = listed.get(e.lineIdentity);
    if (hold && hold.family === e.family && hold.reason === e.reason && hold.held.node === e.held.node
      && hold.held.source === e.held.source && hold.held.confidence === e.held.confidence && hold.product === e.product) continue;
    if (decision?.get(e.lineIdentity) !== undefined) decided++;
    else changed++;
  }
  if (decided > 0 || changed > 0) throw stale(decided, changed);
  return listed;
}
/** The counts of a `line-decision-stale` refusal; null for any other error. */
export function taxonomyLineDecisionStale(error: unknown): TaxonomyLineDecisionStale | null {
  const match = error instanceof HoldrRefusal ? LINE_DECISION_STALE.exec(error.message) : null;
  return match ? { entries: Number(match[1]), decided: Number(match[2]), changed: Number(match[3]) } : null;
}

export interface TaxonomyLineDecisionPlan {
  kind: typeof TAXONOMY_LINE_DECISION_KIND;
  /** Whether the line decision table exists (absent until the first line decision import). */
  schema: 'present' | 'absent';
  entries: number;
  /** Line decisions the import would add: every entry, since a decided line is never decided again. */
  insert: number;
  /** Keyless holds now, and after the import, by family and reason. */
  keylessHolds: TaxonomyKeylessCounts;
  keylessHoldsAfter: TaxonomyKeylessCounts;
  mappingDigest: string;
}
/** What a line decision import would do, read-only: refuses a stale mapping (`line-decision-stale`). */
export function planTaxonomyLineDecisions(db: Database, input: unknown): TaxonomyLineDecisionPlan {
  const mapping = validateTaxonomyLineDecisions(input);
  return db.transaction((): TaxonomyLineDecisionPlan => {
    if (!hasAmazonLineTaxonomySchema(db) && lineTaxonomyNameTaken(db)) return refuse();
    const holds = taxonomyKeylessHolds(db);
    refuseStaleLineDecisions(db, mapping, holds);
    const decided = new Set(mapping.entries.map(e => e.lineIdentity));
    return { kind: TAXONOMY_LINE_DECISION_KIND, schema: hasAmazonLineTaxonomySchema(db) ? 'present' : 'absent',
      entries: mapping.entries.length, insert: mapping.entries.length, keylessHolds: taxonomyKeylessCounts(holds),
      keylessHoldsAfter: taxonomyKeylessCounts(holds.filter(hold => !decided.has(hold.lineIdentity))), mappingDigest: digest(input) };
  })();
}
/**
 * Inside the caller's backed-up write, with the table installed: re-checks the whole mapping against the database as it
 * is now (a change committed by any connection before the write began, the pre-write backup's included, is seen), then
 * stores each decision by a plain insert, never an upsert, under its line's identity and product (the held line's ASIN:
 * the reviewed product, as the check confirms), with the mapping's digest, and writes a digest-only
 * `taxonomy-line-decisions` audit row. A stale mapping writes nothing.
 */
export function applyTaxonomyLineDecisions(db: Database, input: unknown, now: string): { insert: number } {
  const mapping = validateTaxonomyLineDecisions(input);
  if (!db.inTransaction || !hasAmazonLineTaxonomySchema(db)) return refuse();
  // A line decision holds when it writes, not only when it was planned: re-checked here, inside the write, before any row.
  const listed = refuseStaleLineDecisions(db, mapping, taxonomyKeylessHolds(db));
  const mappingDigest = digest(input);
  const insert = db.prepare(`INSERT INTO amazon_line_taxonomy(line_identity,asin,family,node,taxonomy_version,mapping_digest)
    VALUES(?,?,?,?,?,?)`);
  for (const e of mapping.entries) {
    insert.run(e.lineIdentity, listed.get(e.lineIdentity)!.asin ?? '', e.family, e.node, AMAZON_ITEM_TAXONOMY_VERSION, mappingDigest);
  }
  const counts = { insert: mapping.entries.length };
  db.prepare(`INSERT INTO amazon_audit(action,subject_ref,before_digest,after_digest,policy_digest,created_at)
    VALUES('taxonomy-line-decisions',NULL,NULL,?,?,?)`).run(digest({ mappingDigest, ...counts }), AMAZON_TAXONOMY_DIGEST, now);
  return counts;
}
