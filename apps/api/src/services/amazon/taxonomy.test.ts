import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { AMAZON_ITEM_TAXONOMY_VERSION, AMAZON_TAXONOMY_CARD_CATEGORIES, AMAZON_TAXONOMY_NODES } from '@finance-tracker/shared';
import { ensureAmazonSchema } from './schema.js';
import { digest, opaque, SOURCE } from './policy.js';
import { productKey } from './products.js';
import {
  AMAZON_TAXONOMY_DIGEST, AMAZON_TAXONOMY_MAPPING_FORMAT, AMAZON_TAXONOMY_SCHEMA_DIGEST, AMAZON_TAXONOMY_WORKLIST_FORMAT,
  MAX_TAXONOMY_ENTRIES, applyTaxonomyMapping, classifiableProductKey, hasAmazonTaxonomySchema, installAmazonTaxonomySchema,
  knownTaxonomyProductKeys, planTaxonomyImport, readTaxonomyAssignments, resolveTaxonomy, taxonomyWorklist, validateTaxonomyMapping,
  type TaxonomyMappingEntry,
} from './taxonomy.js';

// Entirely synthetic: made-up ASINs, titles, order IDs and categories.
const SAUSAGE = { asin: 'SYNTHMEAT1', title: 'Synthetic Pork Sausage, 1 lb' };
const ROUTER = { asin: 'SYNTHNET01', title: 'Synthetic Mesh Router Model R-1' };
const MYSTERY = { asin: null, title: 'Synthetic Mystery Gadget' };
const HELD = { asin: 'SYNTHHELD1', title: 'Synthetic 4111111111111111' };
const key = (p: { asin: string | null; title: string }) => productKey(p);
const NOW = '2026-10-21T00:00:00.000Z';

function database(withCards = true) {
  const db = new Database(':memory:');
  if (withCards) {
    db.exec(`CREATE TABLE card_transactions(id,card_account_id,transaction_date,status,kind,currency,amount_minor,
      user_category,issuer_category,dismissed_at,removed_at,merged_into_id,description);`);
    db.prepare('INSERT INTO card_transactions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('synthetic-row', 'synthetic-card', '2026-09-01',
      'posted', 'purchase', 'USD', 500, null, 'Merchandise & Supplies-Groceries', null, null, null, 'SYNTHETIC STORE');
  }
  ensureAmazonSchema(db);
  db.prepare('INSERT INTO amazon_sources VALUES(?)').run(SOURCE);
  db.prepare('INSERT INTO amazon_captures VALUES(?,?,?,?,?,?,?,?,?)').run('capture', SOURCE, 3, '2026-01-01', '2026-10-19', '{}', '{}', '2026-10-19', '{}');
  const orderRef = opaque('order', 'synthetic-order');
  db.prepare('INSERT INTO amazon_orders VALUES(?,?,?,?,?,NULL)').run(orderRef, SOURCE, 'synthetic-order', 'capture',
    JSON.stringify({ orderId: 'synthetic-order', date: '2026-09-01', total: null, items: [] }));
  [SAUSAGE, ROUTER, MYSTERY, HELD, SAUSAGE].forEach((p, n) => db.prepare('INSERT INTO amazon_items VALUES(?,?,?,?)').run(
    opaque('line', n), orderRef, `capture:${n}`, JSON.stringify({ lineOrdinal: n, itemId: p.asin, title: p.title, quantity: 1, unitPrice: null })));
  db.prepare("INSERT INTO amazon_agent_categories VALUES(?,?,?,'agent','categorized from product title')")
    .run(key(SAUSAGE), 'Merchandise & Supplies-Groceries', 0.95);
  return db;
}
const mapping = (entries: unknown[], patch: Record<string, unknown> = {}) => ({
  format: AMAZON_TAXONOMY_MAPPING_FORMAT, version: 1, taxonomyVersion: AMAZON_ITEM_TAXONOMY_VERSION, reviewed: true, entries, ...patch,
});
const agent = (product: { asin: string | null; title: string }, node: string, confidence: number) =>
  ({ productKey: key(product), node, confidence, source: 'agent' } as TaxonomyMappingEntry);
const owner = (product: { asin: string | null; title: string }, node: string) =>
  ({ productKey: key(product), node, confidence: 1, source: 'owner' } as TaxonomyMappingEntry);
const install = (db: Database.Database) => db.transaction(() => installAmazonTaxonomySchema(db))();
const apply = (db: Database.Database, input: unknown) => db.transaction(() => applyTaxonomyMapping(db, input, NOW))();

describe('Amazon product taxonomy storage', () => {
  it('reads nothing until the gated import installs its exact table, and refuses a conflicting one', () => {
    const db = database();
    expect(hasAmazonTaxonomySchema(db)).toBe(false);
    expect(readTaxonomyAssignments(db)).toEqual(new Map());
    expect(AMAZON_TAXONOMY_SCHEMA_DIGEST).toMatch(/^[a-f0-9]{64}$/);
    expect(AMAZON_TAXONOMY_DIGEST).toMatch(/^[a-f0-9]{64}$/);
    install(db);
    expect(hasAmazonTaxonomySchema(db)).toBe(true);
    install(db);
    const other = database();
    other.exec('CREATE TABLE amazon_product_taxonomy(product_key TEXT PRIMARY KEY, node TEXT)');
    other.prepare('INSERT INTO amazon_product_taxonomy VALUES(?,?)').run(key(SAUSAGE), 'groceries/meat-seafood');
    expect(hasAmazonTaxonomySchema(other)).toBe(false);
    expect(readTaxonomyAssignments(other)).toEqual(new Map());
    expect(() => install(other)).toThrow('amazon input refused');
    // Never the Amazon schema itself.
    expect(() => installAmazonTaxonomySchema(new Database(':memory:'))).toThrow('amazon input refused');
  });

  it('lets the table hold only well-formed rows, an owner\'s at confidence 1', () => {
    const db = database();
    install(db);
    const put = db.prepare('INSERT INTO amazon_product_taxonomy VALUES(?,?,?,?,?,?)');
    const d = digest('synthetic mapping');
    for (const row of [['short', 'agent', 'groceries', 0.9, 1, d], [key(SAUSAGE), 'robot', 'groceries', 0.9, 1, d],
      [key(SAUSAGE), 'agent', 'Groceries', 0.9, 1, d], [key(SAUSAGE), 'agent', 'groceries', 1.5, 1, d],
      [key(SAUSAGE), 'owner', 'groceries', 0.9, 1, d], [key(SAUSAGE), 'agent', 'groceries', 0.9, 0, d],
      [key(SAUSAGE), 'agent', 'groceries', 0.9, 1, 'not-a-digest']]) {
      expect(() => put.run(...row), JSON.stringify(row)).toThrow(/CHECK constraint/);
    }
  });

  it('resolves the owner\'s always, an agent\'s from 0.6 (suggested below 0.8), and anything else to Needs review', () => {
    expect(resolveTaxonomy(undefined)).toEqual({ node: 'needs-review', source: null, confidence: null, suggested: false, suggestion: null });
    expect(resolveTaxonomy({ node: 'groceries/frozen', source: 'owner', confidence: 1 }))
      .toEqual({ node: 'groceries/frozen', source: 'owner', confidence: 1, suggested: false, suggestion: null });
    expect(resolveTaxonomy({ node: 'groceries/frozen', source: 'agent', confidence: 0.8 }))
      .toEqual({ node: 'groceries/frozen', source: 'agent', confidence: 0.8, suggested: false, suggestion: null });
    // From 0.6 an agent's assignment counts; below 0.8 it is marked suggested, for the owner to confirm.
    expect(resolveTaxonomy({ node: 'groceries/frozen', source: 'agent', confidence: 0.79 }))
      .toEqual({ node: 'groceries/frozen', source: 'agent', confidence: 0.79, suggested: true, suggestion: null });
    expect(resolveTaxonomy({ node: 'groceries/frozen', source: 'agent', confidence: 0.6 }))
      .toEqual({ node: 'groceries/frozen', source: 'agent', confidence: 0.6, suggested: true, suggestion: null });
    expect(resolveTaxonomy({ node: 'groceries/frozen', source: 'agent', confidence: 0.59 })).toEqual({ node: 'needs-review', source: null,
      confidence: null, suggested: false, suggestion: { node: 'groceries/frozen', confidence: 0.59 } });
    // An agent may say it needs review itself: counted there, by the agent.
    expect(resolveTaxonomy({ node: 'needs-review', source: 'agent', confidence: 0.9 }))
      .toEqual({ node: 'needs-review', source: 'agent', confidence: 0.9, suggested: false, suggestion: null });
    expect(resolveTaxonomy({ node: 'needs-review', source: 'agent', confidence: 0.3 }))
      .toEqual({ node: 'needs-review', source: null, confidence: null, suggested: false, suggestion: null });
    // Review regression: an agent's own Needs review at 0.6–0.8 is in Needs review, never also "suggested".
    for (const confidence of [0.6, 0.7, 0.799]) {
      expect(resolveTaxonomy({ node: 'needs-review', source: 'agent', confidence }), String(confidence))
        .toEqual({ node: 'needs-review', source: 'agent', confidence, suggested: false, suggestion: null });
    }
  });

  it('knows each imported product by its key, never a title the card-data guard holds', () => {
    const db = database();
    expect(knownTaxonomyProductKeys(db)).toEqual(new Set([key(SAUSAGE), key(ROUTER), key(MYSTERY)]));
    expect(classifiableProductKey({ itemId: HELD.asin, title: HELD.title })).toBeNull();
    expect(classifiableProductKey({ itemId: 'lowercase1', title: SAUSAGE.title })).toBeNull();
    expect(classifiableProductKey({ itemId: SAUSAGE.asin, title: SAUSAGE.title })).toBe(key(SAUSAGE));
    expect(knownTaxonomyProductKeys(new Database(':memory:'))).toEqual(new Set());
  });

  it('validates a reviewed mapping whole: shape, taxonomy version, nodes, sources, confidences and reviewer titles', () => {
    const good = mapping([agent(SAUSAGE, 'groceries/meat-seafood', 0.97), owner(SAUSAGE, 'groceries/prepared-meals'),
      { ...agent(ROUTER, 'electronics/networking', 0.9), asin: ROUTER.asin, title: ROUTER.title },
      { ...agent(MYSTERY, 'needs-review', 0.2), asin: null, title: MYSTERY.title }]);
    expect(validateTaxonomyMapping(good)).toBe(good);
    expect(validateTaxonomyMapping(mapping([]))).toEqual(mapping([]));
    const refused: Array<[string, unknown]> = [
      ['not an object', []], ['format', mapping([], { format: 'holdr.amazon-product-titles' })], ['version', mapping([], { version: 2 })],
      ['taxonomy version', mapping([], { taxonomyVersion: 2 })], ['unreviewed', mapping([], { reviewed: false })],
      ['extra field', mapping([], { note: 'x' })], ['entries', mapping([], { entries: {} })],
      ['too many', mapping(Array.from({ length: MAX_TAXONOMY_ENTRIES + 1 }, () => agent(SAUSAGE, 'groceries', 0.9)))],
      ['unknown node', mapping([agent(SAUSAGE, 'groceries/pork', 0.9)])],
      ['label as node', mapping([agent(SAUSAGE, 'Groceries', 0.9)])],
      ['card category as node', mapping([agent(SAUSAGE, 'Merchandise & Supplies-Groceries', 0.9)])],
      ['repeated pair', mapping([agent(SAUSAGE, 'groceries', 0.9), agent(SAUSAGE, 'groceries/frozen', 0.9)])],
      ['owner below 1', mapping([{ ...owner(SAUSAGE, 'groceries'), confidence: 0.9 }])],
      ['confidence above 1', mapping([agent(SAUSAGE, 'groceries', 1.01)])], ['negative', mapping([agent(SAUSAGE, 'groceries', -0.1)])],
      ['NaN', mapping([agent(SAUSAGE, 'groceries', Number.NaN)])], ['text confidence', mapping([{ ...agent(SAUSAGE, 'groceries', 0.9), confidence: '0.9' }])],
      ['unknown source', mapping([{ ...agent(SAUSAGE, 'groceries', 0.9), source: 'mapping' }])],
      ['short key', mapping([{ ...agent(SAUSAGE, 'groceries', 0.9), productKey: 'abc' }])],
      ['upper-case key', mapping([{ ...agent(SAUSAGE, 'groceries', 0.9), productKey: key(SAUSAGE).toUpperCase() }])],
      ['rationale', mapping([{ ...agent(SAUSAGE, 'groceries', 0.9), rationale: 'categorized from product title' }])],
      ['title without asin', mapping([{ ...agent(SAUSAGE, 'groceries', 0.9), title: SAUSAGE.title }])],
      ['another product\'s title', mapping([{ ...agent(SAUSAGE, 'groceries', 0.9), asin: ROUTER.asin, title: ROUTER.title }])],
      ['held title', mapping([{ ...agent(HELD, 'groceries', 0.9), asin: HELD.asin, title: HELD.title }])],
    ];
    for (const [what, input] of refused) expect(() => validateTaxonomyMapping(input), what).toThrow('amazon input refused');
  });

  it('plans read-only: counts, coverage after the import, and the taxonomy card categories the card data lacks', () => {
    const db = database();
    const input = mapping([agent(SAUSAGE, 'groceries/meat-seafood', 0.97), agent(ROUTER, 'electronics/networking', 0.5)]);
    const plan = planTaxonomyImport(db, input);
    expect(plan).toEqual({ schema: 'absent', entries: 2, agent: 2, owner: 0, insert: 2, update: 0, unchanged: 0, products: 3,
      assignedAfter: 1, needsReviewAfter: 2,
      cardCategoriesMissing: AMAZON_TAXONOMY_CARD_CATEGORIES.filter(c => c !== 'Merchandise & Supplies-Groceries'),
      mappingDigest: digest(input) });
    expect(hasAmazonTaxonomySchema(db)).toBe(false);
    expect(planTaxonomyImport(database(false), input).cardCategoriesMissing).toEqual([...AMAZON_TAXONOMY_CARD_CATEGORIES]);
    // A product no imported item is, or a held one, refuses the whole mapping.
    for (const product of [{ asin: 'SYNTHOTHER', title: 'Synthetic Unknown Thing' }, HELD]) {
      expect(() => planTaxonomyImport(db, mapping([agent(SAUSAGE, 'groceries', 0.9), agent(product, 'groceries', 0.9)])))
        .toThrow('amazon input refused');
    }
  });

  it('imports idempotently: inserts, then leaves what it already says, updates what changed, and the owner wins', () => {
    const db = database();
    install(db);
    const first = mapping([agent(SAUSAGE, 'groceries/meat-seafood', 0.97), agent(ROUTER, 'electronics/networking', 0.6)]);
    expect(apply(db, first)).toEqual({ insert: 2, update: 0, unchanged: 0 });
    expect(apply(db, first)).toEqual({ insert: 0, update: 0, unchanged: 2 });
    expect(planTaxonomyImport(db, first)).toMatchObject({ schema: 'present', insert: 0, update: 0, unchanged: 2 });
    expect(readTaxonomyAssignments(db)).toEqual(new Map([
      [key(SAUSAGE), { node: 'groceries/meat-seafood', source: 'agent', confidence: 0.97 }],
      [key(ROUTER), { node: 'electronics/networking', source: 'agent', confidence: 0.6 }],
    ]));
    const second = mapping([agent(ROUTER, 'electronics/networking', 0.92), owner(SAUSAGE, 'groceries/prepared-meals')]);
    expect(apply(db, second)).toEqual({ insert: 1, update: 1, unchanged: 0 });
    // A later agent pass never displaces the owner's choice; it is kept beside it.
    expect(apply(db, mapping([agent(SAUSAGE, 'groceries/snacks-sweets', 0.99)]))).toEqual({ insert: 0, update: 1, unchanged: 0 });
    expect(readTaxonomyAssignments(db).get(key(SAUSAGE))).toEqual({ node: 'groceries/prepared-meals', source: 'owner', confidence: 1 });
    expect(db.prepare('SELECT source,node,mapping_digest FROM amazon_product_taxonomy WHERE product_key=? ORDER BY source').all(key(SAUSAGE)))
      .toEqual([{ source: 'agent', node: 'groceries/snacks-sweets', mapping_digest: digest(mapping([agent(SAUSAGE, 'groceries/snacks-sweets', 0.99)])) },
        { source: 'owner', node: 'groceries/prepared-meals', mapping_digest: digest(second) }]);
    // A digest-only receipt per import, under the taxonomy's digest.
    expect(db.prepare("SELECT action,subject_ref,before_digest,policy_digest,created_at FROM amazon_audit WHERE action='taxonomy-import'").all())
      .toEqual(Array.from({ length: 4 }, () => ({ action: 'taxonomy-import', subject_ref: null, before_digest: null,
        policy_digest: AMAZON_TAXONOMY_DIGEST, created_at: NOW })));
  });

  it('writes only inside a transaction, with the table installed, and nothing when one entry is unknown', () => {
    const db = database();
    const input = mapping([agent(SAUSAGE, 'groceries', 0.9)]);
    expect(() => apply(db, input)).toThrow('amazon input refused');
    install(db);
    expect(() => applyTaxonomyMapping(db, input, NOW)).toThrow('amazon input refused');
    expect(() => apply(db, mapping([agent(SAUSAGE, 'groceries', 0.9), agent({ asin: null, title: 'Synthetic Unknown' }, 'groceries', 0.9)])))
      .toThrow('amazon input refused');
    expect(db.prepare('SELECT count(*) FROM amazon_product_taxonomy').pluck().get()).toBe(0);
    // A row naming a node the taxonomy doesn't have (written behind the import's back) is skipped, not guessed.
    db.prepare('INSERT INTO amazon_product_taxonomy VALUES(?,?,?,?,?,?)').run(key(ROUTER), 'owner', 'electronics/robots', 1, 1, digest('x'));
    db.prepare('INSERT INTO amazon_product_taxonomy VALUES(?,?,?,?,?,?)').run(key(ROUTER), 'agent', 'electronics/networking', 0.9, 1, digest('x'));
    expect(readTaxonomyAssignments(db)).toEqual(new Map([[key(ROUTER), { node: 'electronics/networking', source: 'agent', confidence: 0.9 }]]));
  });

  it('writes the classifier a private worklist: each classifiable product once, its current assignment and the taxonomy', () => {
    const db = database();
    install(db);
    apply(db, mapping([agent(ROUTER, 'electronics/networking', 0.6)]));
    const worklist = taxonomyWorklist(db);
    expect(worklist).toMatchObject({ format: AMAZON_TAXONOMY_WORKLIST_FORMAT, version: 1, taxonomyVersion: 1,
      taxonomyDigest: AMAZON_TAXONOMY_DIGEST, minAgentConfidence: 0.6,
      coverage: { itemObservations: 5, classifiableObservations: 4, heldTitleObservations: 1 } });
    expect(worklist.taxonomy).toHaveLength(AMAZON_TAXONOMY_NODES.length);
    expect(worklist.products).toEqual([
      { productKey: key(SAUSAGE), asin: SAUSAGE.asin, title: SAUSAGE.title, lines: 2, cardCategory: 'Merchandise & Supplies-Groceries',
        assigned: null, resolved: 'needs-review', adoptFrom: null },
      { productKey: key(ROUTER), asin: ROUTER.asin, title: ROUTER.title, lines: 1, cardCategory: null,
        assigned: { node: 'electronics/networking', source: 'agent', confidence: 0.6 }, resolved: 'electronics/networking', adoptFrom: null },
      { productKey: key(MYSTERY), asin: null, title: MYSTERY.title, lines: 1, cardCategory: null, assigned: null, resolved: 'needs-review',
        adoptFrom: null },
    ].sort((a, b) => (a.productKey < b.productKey ? -1 : 1)));
    expect(JSON.stringify(worklist)).not.toContain(HELD.title);
    expect(JSON.stringify(worklist)).not.toContain(HELD.asin);
  });
});
