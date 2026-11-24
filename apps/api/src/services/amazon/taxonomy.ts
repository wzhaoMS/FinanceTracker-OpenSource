import type { Database } from 'better-sqlite3';
import {
  AMAZON_ITEM_TAXONOMY_VERSION,
  AMAZON_TAXONOMY_MIN_AGENT_CONFIDENCE,
  AMAZON_TAXONOMY_NEEDS_REVIEW,
  AMAZON_TAXONOMY_NODES,
  AMAZON_TAXONOMY_POLICY,
  AMAZON_TAXONOMY_SUGGESTED_BELOW,
  ITEM_TAXONOMY_V1_VIEW,
  isAmazonTaxonomyNode,
  itemTaxonomyCategoriesMissing,
  resolveItemTaxonomy,
  type AmazonTaxonomyNodeId,
  type AmazonTaxonomySource,
  type ItemTaxonomyResolution,
} from '@finance-tracker/shared';
import { HoldrRefusal } from '../dbErrors.js';
import { hasAmazonSchema } from './schema.js';
// STEP 9 integration B8 (Root): the taxonomy reads every retained Fresh list, as it reads every capture's items.
import { freshRetainedObservations } from './freshAdapter.js';
import { digest, exact, refuse } from './policy.js';
import { productKey, publicTitle, validTitle } from './products.js';
import { validCategory } from './resolver.js';
import { taxonomyKeyAdoptions, type TaxonomyAdoptFrom, type TaxonomyKeyChange } from './taxonomyKeyAdoptions.js';

/**
 * Which taxonomy node (packages/shared amazonTaxonomy.ts) each Amazon product is: an agent's classification from its
 * title, or the owner's, which always wins. Products are keyed by `productKey({ asin, title })`, as the agent
 * category records are. Assignments only say what a product is; they never change card Spending or its categories.
 *
 * Storage is the additive `amazon_product_taxonomy` table. It is not part of `AMAZON_SCHEMA` and nothing creates it at
 * startup or on a read: only the backed-up, Root-GO-gated import (cli/amazonTaxonomy.ts) installs it. Reads treat an
 * absent or conflicting table (exact-SQL detection) as "nothing assigned".
 */
export const AMAZON_TAXONOMY_DIGEST = digest({ version: AMAZON_ITEM_TAXONOMY_VERSION,
  nodes: AMAZON_TAXONOMY_NODES.map(({ id, label, parent, cardCategory }) => ({ id, label, parent, cardCategory })),
  minAgentConfidence: AMAZON_TAXONOMY_MIN_AGENT_CONFIDENCE, suggestedBelow: AMAZON_TAXONOMY_SUGGESTED_BELOW });

const AMAZON_TAXONOMY_SCHEMA_SQL = `CREATE TABLE amazon_product_taxonomy (
  product_key TEXT NOT NULL CHECK(length(product_key)=64 AND product_key NOT GLOB '*[^a-f0-9]*'),
  source TEXT NOT NULL CHECK(source IN ('agent','owner')),
  node TEXT NOT NULL CHECK(length(node) BETWEEN 1 AND 100 AND node NOT GLOB '*[^a-z0-9/-]*'),
  confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1 AND (source='agent' OR confidence=1)),
  taxonomy_version INTEGER NOT NULL CHECK(taxonomy_version>=1),
  mapping_digest TEXT NOT NULL CHECK(length(mapping_digest)=64 AND mapping_digest NOT GLOB '*[^a-f0-9]*'),
  PRIMARY KEY(product_key,source)
)`;
const normalizeSql = (sql: string) => sql.trim().replace(/\s+/g, ' ');
export const AMAZON_TAXONOMY_SCHEMA_DIGEST = digest(normalizeSql(AMAZON_TAXONOMY_SCHEMA_SQL));

/** Read-only capability detection: absence or a conflicting table means nothing is assigned, never repaired by a read. */
export function hasAmazonTaxonomySchema(db: Database): boolean {
  const object = db.prepare("SELECT type,sql FROM sqlite_master WHERE name='amazon_product_taxonomy'").get() as
    { type: string; sql: string | null } | undefined;
  return object?.type === 'table' && typeof object.sql === 'string'
    && normalizeSql(object.sql) === normalizeSql(AMAZON_TAXONOMY_SCHEMA_SQL);
}
/** Only the backed-up, Root-GO-gated import calls this, inside its write transaction. Never creates the Amazon schema. */
export function installAmazonTaxonomySchema(db: Database): void {
  if (!hasAmazonSchema(db)) return refuse();
  if (hasAmazonTaxonomySchema(db)) return;
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='amazon_product_taxonomy'").get()) return refuse();
  db.exec(AMAZON_TAXONOMY_SCHEMA_SQL);
  if (!hasAmazonTaxonomySchema(db)) return refuse();
}

export interface TaxonomyAssignment {
  node: AmazonTaxonomyNodeId;
  source: AmazonTaxonomySource;
  confidence: number;
}
const validConfidence = (source: unknown, value: unknown): value is number => typeof value === 'number'
  && Number.isFinite(value) && value >= 0 && value <= 1 && (source === 'agent' || value === 1);

/**
 * Each product's winning assignment by product key: the owner's when there is one, else the agent's (whatever its
 * confidence: `resolveTaxonomy` decides whether it counts). Empty without the (exact) table; a row naming a node
 * the taxonomy doesn't have is skipped, never guessed.
 */
export function readTaxonomyAssignments(db: Database): Map<string, TaxonomyAssignment> {
  const answer = new Map<string, TaxonomyAssignment>();
  if (!hasAmazonTaxonomySchema(db)) return answer;
  const rows = db.prepare(`SELECT product_key,source,node,confidence FROM amazon_product_taxonomy
    ORDER BY product_key,CASE source WHEN 'owner' THEN 0 ELSE 1 END`).all() as
    Array<{ product_key: string; source: string; node: string; confidence: number }>;
  for (const row of rows) {
    if (answer.has(row.product_key) || (row.source !== 'owner' && row.source !== 'agent') || !isAmazonTaxonomyNode(row.node)
      || !validConfidence(row.source, row.confidence)) continue;
    answer.set(row.product_key, { node: row.node, source: row.source, confidence: row.confidence });
  }
  return answer;
}

/**
 * A product's resolution (the shared `ItemTaxonomyResolution`, in Amazon's unit): its node, `needs-review` when nothing
 * usable assigns it; who put it there; the agent's confidence (the owner's is 1); whether an agent's category
 * assignment below `AMAZON_TAXONOMY_SUGGESTED_BELOW` is only suggested; and an agent's node below
 * `AMAZON_TAXONOMY_MIN_AGENT_CONFIDENCE` as a suggestion, shown in Needs review and never counted there.
 */
export type ResolvedTaxonomy = ItemTaxonomyResolution<AmazonTaxonomyNodeId, number>;
/**
 * Where an assignment counts: the owner's always; an agent's from AMAZON_TAXONOMY_MIN_AGENT_CONFIDENCE; else Needs review.
 * The shared resolver (itemTaxonomy.ts), with Amazon's policy.
 */
export function resolveTaxonomy(assignment: TaxonomyAssignment | undefined): ResolvedTaxonomy {
  return resolveItemTaxonomy(assignment, AMAZON_TAXONOMY_POLICY);
}

/** A product's key when its observed title may be classified: a public title (the card-data guard holds the rest). */
export function classifiableProductKey(item: { itemId: unknown; title: unknown }): string | null {
  const asin = item.itemId;
  if (typeof item.title !== 'string' || !validTitle(item.title) || publicTitle(item.title) !== item.title
    || (asin !== null && (typeof asin !== 'string' || !/^[A-Z0-9]{10}$/.test(asin)))) return null;
  return productKey({ asin: asin as string | null, title: item.title });
}
/**
 * Every product key a mapping may assign: each imported item's whose title is public, and each Amazon Fresh line's
 * (only with the Fresh import's exact tables: freshAdapter.ts). The import refuses any other key.
 * STEP 9 integration B8 (Root): a Fresh line's of every list the import retained, not only the active lists (as every
 * capture's items are known), so a re-read held `taxonomy-unmatched` gives a key the GO'd import may adopt or assign. The
 * active list of an order displayed as charge-free stays out while its proof is displayed (B6).
 */
export function knownTaxonomyProductKeys(db: Database): Set<string> {
  const keys = new Set<string>();
  if (!hasAmazonSchema(db)) return keys;
  for (const text of db.prepare('SELECT data_json FROM amazon_items').pluck().all() as string[]) {
    const item = JSON.parse(text) as { itemId: unknown; title: unknown };
    const key = classifiableProductKey(item);
    if (key !== null) keys.add(key);
  }
  // STEP 9 integration B8 (Root): every retained Fresh list's lines, the held re-reads' included (freshAdapter.ts).
  for (const item of freshRetainedObservations(db)) {
    const key = classifiableProductKey(item);
    if (key !== null) keys.add(key);
  }
  return keys;
}

export const AMAZON_TAXONOMY_MAPPING_FORMAT = 'holdr.amazon-item-taxonomy-mapping';
export const MAX_TAXONOMY_ENTRIES = 20000;
export interface TaxonomyMappingEntry {
  productKey: string;
  node: AmazonTaxonomyNodeId;
  confidence: number;
  source: AmazonTaxonomySource;
  /** Optional, for the reviewer: when present, the key must be this product's (`productKey({ asin, title })`). */
  asin?: string | null;
  title?: string;
}
/** A reviewed, private mapping file: what Root's GO pins (its digest) and the import applies. */
export interface TaxonomyMapping {
  format: typeof AMAZON_TAXONOMY_MAPPING_FORMAT;
  version: 1;
  taxonomyVersion: typeof AMAZON_ITEM_TAXONOMY_VERSION;
  reviewed: true;
  /** Only on an adoption mapping (`adopt-keys`): each entry also names the previous key it adopts from. */
  kind?: 'adoption';
  entries: Array<TaxonomyMappingEntry & { previousProductKey?: string }>;
}
const validKey = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
/**
 * An adoption mapping (Root): `kind: 'adoption'`, and per entry the new key, the previous key and the exact value
 * adopted from it (node, source, confidence). One entry per new key; no reviewer `asin` or `title`.
 */
function validateAdoptionMapping(input: unknown): TaxonomyMapping {
  const m = exact(input, ['format', 'version', 'taxonomyVersion', 'reviewed', 'kind', 'entries']);
  if (m.format !== AMAZON_TAXONOMY_MAPPING_FORMAT || m.version !== 1 || m.taxonomyVersion !== AMAZON_ITEM_TAXONOMY_VERSION
    || m.reviewed !== true || m.kind !== 'adoption' || !Array.isArray(m.entries) || m.entries.length > MAX_TAXONOMY_ENTRIES) return refuse();
  const seen = new Set<string>();
  for (const value of m.entries) {
    const e = exact(value, ['productKey', 'previousProductKey', 'node', 'confidence', 'source']);
    if (!validKey(e.productKey) || !validKey(e.previousProductKey) || e.productKey === e.previousProductKey || seen.has(e.productKey)
      || !isAmazonTaxonomyNode(e.node) || (e.source !== 'agent' && e.source !== 'owner') || !validConfidence(e.source, e.confidence)) return refuse();
    seen.add(e.productKey);
  }
  return input as TaxonomyMapping;
}
/**
 * The mapping, checked whole: its exact shape, the current taxonomy version, the owner's review, and every entry's
 * key, node, confidence and source (an owner's confidence is 1). A node the taxonomy doesn't have, a repeated
 * (product, source) pair, or a title that isn't its key's refuses the whole file. A mapping with a `kind` is an
 * adoption mapping, checked as one; any other is checked exactly as before.
 */
export function validateTaxonomyMapping(input: unknown): TaxonomyMapping {
  if (input && typeof input === 'object' && !Array.isArray(input) && Object.hasOwn(input, 'kind')) return validateAdoptionMapping(input);
  const m = exact(input, ['format', 'version', 'taxonomyVersion', 'reviewed', 'entries']);
  if (m.format !== AMAZON_TAXONOMY_MAPPING_FORMAT || m.version !== 1 || m.taxonomyVersion !== AMAZON_ITEM_TAXONOMY_VERSION
    || m.reviewed !== true || !Array.isArray(m.entries) || m.entries.length > MAX_TAXONOMY_ENTRIES) return refuse();
  const seen = new Set<string>();
  for (const value of m.entries) {
    const titled = Boolean(value && typeof value === 'object' && !Array.isArray(value) && 'title' in value);
    const e = exact(value, ['productKey', 'node', 'confidence', 'source', ...(titled ? ['asin', 'title'] : [])]);
    if (typeof e.productKey !== 'string' || !/^[a-f0-9]{64}$/.test(e.productKey) || !isAmazonTaxonomyNode(e.node)
      || (e.source !== 'agent' && e.source !== 'owner') || !validConfidence(e.source, e.confidence)) return refuse();
    if (titled && classifiableProductKey({ itemId: e.asin, title: e.title }) !== e.productKey) return refuse();
    const pair = `${e.productKey}:${e.source}`;
    if (seen.has(pair)) return refuse();
    seen.add(pair);
  }
  return input as TaxonomyMapping;
}

export interface TaxonomyImportPlan {
  /** Whether the assignment table exists (absent until the first backed-up import). */
  schema: 'present' | 'absent';
  entries: number;
  agent: number;
  owner: number;
  /** Rows the import would add, change, or find already as the mapping says. */
  insert: number;
  update: number;
  unchanged: number;
  /** Products a mapping may assign, and, after this import, how many of them count in a node or wait in Needs review. */
  products: number;
  assignedAfter: number;
  needsReviewAfter: number;
  /** Taxonomy card categories the card data doesn't have (names from the shared taxonomy, never card data). */
  cardCategoriesMissing: string[];
  mappingDigest: string;
  /** Only for an adoption mapping, which plans only while its precondition holds. */
  kind?: 'adoption';
}
export const TAXONOMY_ADOPTION_STALE = 'adoption-stale';
/** Counts only: an adoption mapping's entries, those whose new key has a row, and those whose previous key changed. */
export interface TaxonomyAdoptionStale { entries: number; newKeyAssigned: number; previousChanged: number }
const ADOPTION_STALE = /^adoption-stale entries=(\d+) newKeyAssigned=(\d+) previousChanged=(\d+)$/;
/**
 * An adoption mapping's precondition (Root), as the database is now: every new key still has no taxonomy row of any
 * source, and every previous key's winning assignment is still exactly the adopted node, source and confidence. The
 * plan checks it read-only; the import checks it again inside its write transaction, before any write. Anything else
 * refuses the whole mapping (`adoption-stale`, with counts only): the operator regenerates it and asks for a new GO.
 */
function refuseStaleAdoption(db: Database, mapping: TaxonomyMapping): void {
  if (mapping.kind !== 'adoption') return;
  const rows = hasAmazonTaxonomySchema(db) ? db.prepare('SELECT 1 FROM amazon_product_taxonomy WHERE product_key=? LIMIT 1').pluck() : null;
  const assignments = readTaxonomyAssignments(db);
  let newKeyAssigned = 0, previousChanged = 0;
  for (const e of mapping.entries) {
    if (rows?.get(e.productKey) !== undefined) newKeyAssigned++;
    const before = assignments.get(e.previousProductKey!);
    if (!before || before.node !== e.node || before.source !== e.source || before.confidence !== e.confidence) previousChanged++;
  }
  if (newKeyAssigned > 0 || previousChanged > 0) throw new HoldrRefusal(`${TAXONOMY_ADOPTION_STALE} entries=${mapping.entries.length}`
    + ` newKeyAssigned=${newKeyAssigned} previousChanged=${previousChanged}`);
}
/** The counts of an `adoption-stale` refusal; null for any other error. */
export function taxonomyAdoptionStale(error: unknown): TaxonomyAdoptionStale | null {
  const match = error instanceof HoldrRefusal ? ADOPTION_STALE.exec(error.message) : null;
  return match ? { entries: Number(match[1]), newKeyAssigned: Number(match[2]), previousChanged: Number(match[3]) } : null;
}
function cardCategoriesMissing(db: Database): string[] {
  const hasCards = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='card_transactions'").get());
  const present = new Set(hasCards ? (db.prepare(`SELECT user_category FROM card_transactions WHERE user_category IS NOT NULL
    UNION SELECT issuer_category FROM card_transactions WHERE issuer_category IS NOT NULL`).pluck().all() as string[])
    .filter(validCategory) : []);
  return itemTaxonomyCategoriesMissing(ITEM_TAXONOMY_V1_VIEW, present);
}
type Stored = { node: string; confidence: number };
function storedRows(db: Database): Map<string, Stored> {
  if (!hasAmazonTaxonomySchema(db)) return new Map();
  return new Map((db.prepare('SELECT product_key,source,node,confidence FROM amazon_product_taxonomy').all() as
    Array<{ product_key: string; source: string } & Stored>).map(r => [`${r.product_key}:${r.source}`, { node: r.node, confidence: r.confidence }]));
}
/** What an import would do, read-only: refuses a mapping naming a product no imported item is. */
export function planTaxonomyImport(db: Database, input: unknown): TaxonomyImportPlan {
  const mapping = validateTaxonomyMapping(input);
  return db.transaction((): TaxonomyImportPlan => {
    if (!hasAmazonTaxonomySchema(db) && db.prepare("SELECT 1 FROM sqlite_master WHERE name='amazon_product_taxonomy'").get()) return refuse();
    const known = knownTaxonomyProductKeys(db);
    if (mapping.entries.some(e => !known.has(e.productKey))) return refuse();
    refuseStaleAdoption(db, mapping);
    const stored = storedRows(db);
    let insert = 0, update = 0, unchanged = 0;
    for (const e of mapping.entries) {
      const before = stored.get(`${e.productKey}:${e.source}`);
      if (!before) insert++;
      else if (before.node !== e.node || before.confidence !== e.confidence) update++;
      else unchanged++;
    }
    // The winning assignment of every known product after the import, as reads will resolve it.
    const after = readTaxonomyAssignments(db);
    for (const e of mapping.entries) {
      const current = after.get(e.productKey);
      if (e.source === 'owner' || !current || current.source === 'agent') after.set(e.productKey, { node: e.node, source: e.source, confidence: e.confidence });
    }
    let assignedAfter = 0;
    for (const key of known) if (resolveTaxonomy(after.get(key)).node !== AMAZON_TAXONOMY_NEEDS_REVIEW) assignedAfter++;
    return { schema: hasAmazonTaxonomySchema(db) ? 'present' : 'absent', entries: mapping.entries.length,
      agent: mapping.entries.filter(e => e.source === 'agent').length, owner: mapping.entries.filter(e => e.source === 'owner').length,
      insert, update, unchanged, products: known.size, assignedAfter, needsReviewAfter: known.size - assignedAfter,
      cardCategoriesMissing: cardCategoriesMissing(db), mappingDigest: digest(input),
      ...(mapping.kind === 'adoption' ? { kind: 'adoption' as const } : {}) };
  })();
}
/**
 * Inside the caller's backed-up write, with the table installed: stores each entry, an owner's beside (and over) an
 * agent's. Idempotent: an entry already stored as the mapping says is left as it is, with the mapping that set it.
 */
export function applyTaxonomyMapping(db: Database, input: unknown, now: string): { insert: number; update: number; unchanged: number } {
  const mapping = validateTaxonomyMapping(input);
  if (!db.inTransaction || !hasAmazonTaxonomySchema(db)) return refuse();
  const known = knownTaxonomyProductKeys(db);
  if (mapping.entries.some(e => !known.has(e.productKey))) return refuse();
  // An adoption holds when it writes, not only when it was generated: re-checked here, inside the write, before any row.
  refuseStaleAdoption(db, mapping);
  const mappingDigest = digest(input), stored = storedRows(db);
  const put = db.prepare(`INSERT INTO amazon_product_taxonomy(product_key,source,node,confidence,taxonomy_version,mapping_digest)
    VALUES(?,?,?,?,?,?) ON CONFLICT(product_key,source) DO UPDATE SET node=excluded.node,confidence=excluded.confidence,
      taxonomy_version=excluded.taxonomy_version,mapping_digest=excluded.mapping_digest`);
  let insert = 0, update = 0, unchanged = 0;
  for (const e of mapping.entries) {
    const before = stored.get(`${e.productKey}:${e.source}`);
    if (before && before.node === e.node && before.confidence === e.confidence) { unchanged++; continue; }
    put.run(e.productKey, e.source, e.node, e.confidence, AMAZON_ITEM_TAXONOMY_VERSION, mappingDigest);
    if (before) update++; else insert++;
  }
  const counts = { insert, update, unchanged };
  db.prepare(`INSERT INTO amazon_audit(action,subject_ref,before_digest,after_digest,policy_digest,created_at)
    VALUES('taxonomy-import',NULL,NULL,?,?,?)`).run(digest({ mappingDigest, ...counts }), AMAZON_TAXONOMY_DIGEST, now);
  return counts;
}

export const AMAZON_TAXONOMY_WORKLIST_FORMAT = 'holdr.amazon-item-taxonomy-worklist';
export interface TaxonomyWorklistProduct {
  productKey: string;
  asin: string | null;
  title: string;
  /** Observations of it: order items and Amazon Fresh lines. */
  lines: number;
  /** The agent's card category for it, when it has one (context for the classifier, not a taxonomy node). */
  cardCategory: string | null;
  /** Its current winning assignment, if any, and where that resolves. */
  assigned: TaxonomyAssignment | null;
  resolved: AmazonTaxonomyNodeId;
  /**
   * A key a re-read gave a line another assigned key had (a learned ASIN): the previous key and its assignment, which
   * the next GO'd import adopts unchanged (`adopt-keys`), with no re-classification. Null otherwise.
   */
  adoptFrom: TaxonomyAdoptFrom | null;
}
export interface TaxonomyWorklistOptions {
  /** More `{ productKey, previousProductKey }` changes to tag, e.g. #168's `categoryKeyAdoptions(db)`. */
  keyChanges?: Iterable<TaxonomyKeyChange>;
}
/** Private: what a classifier needs, every classifiable product with its title and current assignment, by key. */
export interface TaxonomyWorklist {
  format: typeof AMAZON_TAXONOMY_WORKLIST_FORMAT;
  version: 1;
  taxonomyVersion: typeof AMAZON_ITEM_TAXONOMY_VERSION;
  taxonomyDigest: string;
  minAgentConfidence: number;
  taxonomy: Array<{ id: AmazonTaxonomyNodeId; label: string; parent: string | null }>;
  coverage: { itemObservations: number; classifiableObservations: number; heldTitleObservations: number };
  products: TaxonomyWorklistProduct[];
}
export function taxonomyWorklist(db: Database, options: TaxonomyWorklistOptions = {}): TaxonomyWorklist {
  return db.transaction((): TaxonomyWorklist => {
    const products = new Map<string, Omit<TaxonomyWorklistProduct, 'adoptFrom'>>();
    let itemObservations = 0, held = 0;
    const assignments = readTaxonomyAssignments(db);
    const hasAgents = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='amazon_agent_categories'").get());
    const agentCategory = hasAgents ? db.prepare(`SELECT category FROM amazon_agent_categories
      WHERE product_key=? AND source='agent' AND rationale='categorized from product title'`).pluck() : null;
    const rows = hasAmazonSchema(db) ? db.prepare('SELECT data_json FROM amazon_items ORDER BY ref').pluck().all() as string[] : [];
    // Amazon Fresh lines are products too: only with the Fresh import's exact tables (freshAdapter.ts).
    // STEP 9 integration B8 (Root): every retained list's, as knownTaxonomyProductKeys reads them, so the held ones are listed.
    const observations = [...rows.map(text => JSON.parse(text) as { itemId: string | null; title: string }),
      ...freshRetainedObservations(db)];
    for (const item of observations) {
      itemObservations++;
      const key = classifiableProductKey(item);
      if (key === null) { held++; continue; }
      const product = products.get(key);
      if (product) { product.lines++; continue; }
      const assigned = assignments.get(key) ?? null;
      const category = agentCategory?.get(key);
      products.set(key, { productKey: key, asin: item.itemId, title: item.title, lines: 1,
        cardCategory: typeof category === 'string' && validCategory(category) ? category : null,
        assigned, resolved: resolveTaxonomy(assigned ?? undefined).node });
    }
    // Post-pass: tag the keys that adopt a previous key's assignment (taxonomyKeyAdoptions.ts).
    const adoptions = new Map(taxonomyKeyAdoptions(db, options.keyChanges).map(({ productKey: key, ...from }) => [key, from]));
    return { format: AMAZON_TAXONOMY_WORKLIST_FORMAT, version: 1, taxonomyVersion: AMAZON_ITEM_TAXONOMY_VERSION,
      taxonomyDigest: AMAZON_TAXONOMY_DIGEST, minAgentConfidence: AMAZON_TAXONOMY_MIN_AGENT_CONFIDENCE,
      taxonomy: AMAZON_TAXONOMY_NODES.map(({ id, label, parent }) => ({ id, label, parent })),
      coverage: { itemObservations, classifiableObservations: itemObservations - held, heldTitleObservations: held },
      products: [...products.values()].sort((a, b) => (a.productKey < b.productKey ? -1 : 1))
        .map(product => ({ ...product, adoptFrom: adoptions.get(product.productKey) ?? null })) };
  })();
}
