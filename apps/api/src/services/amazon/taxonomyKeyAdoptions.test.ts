import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ensureAmazonSchema } from './schema.js';
import { digest, opaque, SOURCE } from './policy.js';
import { productKey } from './products.js';
import {
  AMAZON_TAXONOMY_MAPPING_FORMAT, applyTaxonomyMapping, installAmazonTaxonomySchema, knownTaxonomyProductKeys, planTaxonomyImport,
  readTaxonomyAssignments, resolveTaxonomy, taxonomyAdoptionStale, taxonomyWorklist, validateTaxonomyMapping,
} from './taxonomy.js';
import { taxonomyAdoptionMapping, taxonomyKeyAdoptions, taxonomyKeyChanges } from './taxonomyKeyAdoptions.js';
// STEP 9 integration B8 (Root): Amazon Fresh Item List reads, seeded as the gated Fresh import stores them.
import { each, freshDatabase, freshLine, seedFreshList, seedOrder, usd } from './freshFixtures.testSupport.js';

// Entirely synthetic: made-up ASINs, titles, order IDs and capture digests.
type Product = { asin: string | null; title: string };
const KETTLE_SEEN = { asin: null, title: 'Synthetic Travel Kettle 1L' };
const KETTLE = { asin: 'SYNTHKTL01', title: KETTLE_SEEN.title };
const LAMP_SEEN = { asin: null, title: 'Synthetic Desk Lamp' };
const LAMP = { asin: 'SYNTHLMP01', title: LAMP_SEEN.title };
const ROPE_SEEN = { asin: null, title: 'Synthetic Jump Rope' };
const ROPE = { asin: 'SYNTHROP01', title: ROPE_SEEN.title };
/** The kettle's ASIN, read earlier under another title: a second previous key for the same new key. */
const KETTLE_RENAMED = { asin: KETTLE.asin, title: 'Synthetic Kettle, Travel Size' };
const HELD_SEEN = { asin: null, title: 'Synthetic 4111111111111111' };
const HELD = { asin: 'SYNTHHELD1', title: HELD_SEEN.title };
const key = (p: Product) => productKey(p);

function household() {
  const db = new Database(':memory:');
  ensureAmazonSchema(db);
  db.prepare('INSERT INTO amazon_sources VALUES(?)').run(SOURCE);
  let captures = 0;
  /**
   * One read of a synthetic order: a new capture with the order's observation and its lines in amazon_items, as every
   * v3 capture inserts them. `display: false` is a later read retained while the display is held (#168).
   */
  const read = (order: string, lines: Product[], display = true) => {
    const capture = digest(`synthetic-capture-${++captures}`), orderId = `synthetic-order-${order}`, orderRef = opaque('order', orderId);
    db.prepare('INSERT INTO amazon_captures VALUES(?,?,?,?,?,?,?,?,?)').run(capture, SOURCE, 3, '2026-08-01', '2026-10-19', '{}', '{}',
      '2026-10-19', '{}');
    const items = lines.map((p, lineOrdinal) => ({ lineOrdinal, itemId: p.asin, title: p.title, quantity: 1,
      unitPrice: { currency: 'USD', amountMinor: 1000 } }));
    const data = JSON.stringify({ orderId, date: '2026-09-01', total: null, items });
    const shown = db.prepare('SELECT 1 FROM amazon_orders WHERE ref=?').get(orderRef);
    if (!shown) db.prepare('INSERT INTO amazon_orders VALUES(?,?,?,?,?,NULL)').run(orderRef, SOURCE, orderId, capture, data);
    else if (display) db.prepare('UPDATE amazon_orders SET latest_digest=?,data_json=? WHERE ref=?').run(capture, data, orderRef);
    db.prepare('INSERT INTO amazon_observations VALUES(?,?,?,?,?,?,?)').run(opaque('observation', [capture, 'order', 0]), capture, 'order', 0,
      orderRef, 'payment-coverage-held', data);
    for (const item of items) {
      db.prepare('INSERT INTO amazon_items VALUES(?,?,?,?)').run(opaque('line-observation', [capture, orderId, item.lineOrdinal]), orderRef,
        `${capture}:${item.lineOrdinal}`, JSON.stringify(item));
    }
  };
  const assign = (rows: Array<[Product, 'agent' | 'owner', string, number]>) => db.transaction(() => {
    installAmazonTaxonomySchema(db);
    for (const [p, source, node, confidence] of rows) {
      db.prepare('INSERT INTO amazon_product_taxonomy VALUES(?,?,?,?,1,?)').run(key(p), source, node, confidence, digest('synthetic mapping'));
    }
  })();
  return { db, read, assign };
}
const change = (to: Product, from: Product) => ({ productKey: key(to), previousProductKey: key(from) });
const adoption = (to: Product, from: Product, node: string, source: 'agent' | 'owner', confidence: number) =>
  ({ ...change(to, from), node, source, confidence });
const sorted = <T extends { productKey: string }>(list: T[]) => [...list].sort((a, b) => (a.productKey < b.productKey ? -1 : 1));

describe('Amazon taxonomy key adoptions', () => {
  it('finds nothing without the Amazon schema, and nothing to adopt before any assignment', () => {
    const empty = new Database(':memory:');
    expect(taxonomyKeyChanges(empty)).toEqual([]);
    expect(taxonomyKeyAdoptions(empty)).toEqual([]);
    expect(taxonomyKeyAdoptions(empty, [change(KETTLE, KETTLE_SEEN)])).toEqual([]);
    const { db, read } = household();
    read('A', [KETTLE_SEEN]);
    read('A', [KETTLE]);
    expect(taxonomyKeyChanges(db)).toEqual([change(KETTLE, KETTLE_SEEN)]);
    expect(taxonomyKeyAdoptions(db)).toEqual([]);
  });

  it('carries the previous key\'s agent, owner or sub-0.6 assignment unchanged, so the new key resolves as before', () => {
    const { db, read, assign } = household();
    read('A', [KETTLE_SEEN, LAMP_SEEN, ROPE_SEEN]);
    read('A', [KETTLE, LAMP, ROPE]);
    assign([[KETTLE_SEEN, 'agent', 'home-kitchen/small-appliances', 0.91],
      [LAMP_SEEN, 'agent', 'home-kitchen/furniture-decor', 0.95], [LAMP_SEEN, 'owner', 'electronics/smart-home', 1],
      [ROPE_SEEN, 'agent', 'sports-outdoors/exercise-fitness', 0.42]]);
    expect(taxonomyKeyChanges(db)).toEqual(sorted([change(KETTLE, KETTLE_SEEN), change(LAMP, LAMP_SEEN), change(ROPE, ROPE_SEEN)]));
    const adoptions = taxonomyKeyAdoptions(db);
    expect(adoptions).toEqual(sorted([adoption(KETTLE, KETTLE_SEEN, 'home-kitchen/small-appliances', 'agent', 0.91),
      adoption(LAMP, LAMP_SEEN, 'electronics/smart-home', 'owner', 1),
      adoption(ROPE, ROPE_SEEN, 'sports-outdoors/exercise-fitness', 'agent', 0.42)]));
    const assignments = readTaxonomyAssignments(db);
    for (const a of adoptions) {
      expect(resolveTaxonomy({ node: a.node, source: a.source, confidence: a.confidence }))
        .toEqual(resolveTaxonomy(assignments.get(a.previousProductKey)));
    }
    // The sub-0.6 row stays a Needs-review suggestion under its new key.
    expect(resolveTaxonomy(adoptions.find(a => a.productKey === key(ROPE)))).toMatchObject({ node: 'needs-review',
      suggestion: { node: 'sports-outdoors/exercise-fitness', confidence: 0.42 } });
  });

  it('leaves out a new key that already has a row of any source, and an adopted key drops out', () => {
    const { db, read, assign } = household();
    read('A', [KETTLE_SEEN, LAMP_SEEN]);
    read('A', [KETTLE, LAMP]);
    assign([[KETTLE_SEEN, 'agent', 'home-kitchen/small-appliances', 0.91], [LAMP_SEEN, 'owner', 'electronics/smart-home', 1],
      // A weak agent row on the lamp's new key is still an assignment: the lamp is classified like any other.
      [LAMP, 'agent', 'home-kitchen/furniture-decor', 0.3]]);
    expect(taxonomyKeyAdoptions(db)).toEqual([adoption(KETTLE, KETTLE_SEEN, 'home-kitchen/small-appliances', 'agent', 0.91)]);
    assign([[KETTLE, 'agent', 'home-kitchen/small-appliances', 0.91]]);
    expect(taxonomyKeyAdoptions(db)).toEqual([]);
  });

  it('adopts when several previous keys agree on node and source (their lowest confidence), never when they differ', () => {
    const agree = household();
    agree.read('A', [KETTLE_SEEN]);
    agree.read('A', [KETTLE]);
    agree.read('B', [KETTLE_RENAMED]);
    agree.read('B', [KETTLE]);
    expect(taxonomyKeyChanges(agree.db)).toEqual(sorted([change(KETTLE, KETTLE_SEEN), change(KETTLE, KETTLE_RENAMED)])
      .sort((a, b) => (a.previousProductKey < b.previousProductKey ? -1 : 1)));
    agree.assign([[KETTLE_SEEN, 'agent', 'home-kitchen/small-appliances', 0.91], [KETTLE_RENAMED, 'agent', 'home-kitchen/small-appliances', 0.74]]);
    expect(taxonomyKeyAdoptions(agree.db)).toEqual([adoption(KETTLE, KETTLE_RENAMED, 'home-kitchen/small-appliances', 'agent', 0.74)]);

    const conflicts: Array<Array<[Product, 'agent' | 'owner', string, number]>> = [
      [[KETTLE_SEEN, 'agent', 'home-kitchen/small-appliances', 0.91], [KETTLE_RENAMED, 'agent', 'home-kitchen/kitchen-dining', 0.91]],
      [[KETTLE_SEEN, 'agent', 'home-kitchen/small-appliances', 0.91], [KETTLE_RENAMED, 'owner', 'home-kitchen/small-appliances', 1]],
    ];
    for (const rows of conflicts) {
      const { db, read, assign } = household();
      read('A', [KETTLE_SEEN]);
      read('A', [KETTLE]);
      read('B', [KETTLE_RENAMED]);
      read('B', [KETTLE]);
      assign(rows);
      expect(taxonomyKeyAdoptions(db), JSON.stringify(rows)).toEqual([]);
      expect(taxonomyWorklist(db).products.every(p => p.adoptFrom === null)).toBe(true);
    }
  });

  it('needs exactly one matching line in the later read, and never keys a title the card-data guard holds', () => {
    const { db, read, assign } = household();
    // Two lines of the later read have the kettle's title; two have the lamp's ASIN.
    read('A', [KETTLE_SEEN, LAMP, HELD_SEEN]);
    read('A', [KETTLE, { asin: 'SYNTHKTL02', title: KETTLE.title }, LAMP, { asin: LAMP.asin, title: 'Synthetic Desk Lamp, Black' },
      HELD]);
    assign([[KETTLE_SEEN, 'agent', 'home-kitchen/small-appliances', 0.91], [LAMP, 'owner', 'electronics/smart-home', 1]]);
    expect(taxonomyKeyChanges(db)).toEqual([]);
    expect(taxonomyKeyAdoptions(db)).toEqual([]);
    // A held title's key is not one the import accepts, even named in `extra`.
    expect(taxonomyKeyAdoptions(db, [change(HELD, KETTLE_SEEN)])).toEqual([]);
  });

  it('finds the change whether the re-read replaced the display or the display was held', () => {
    // Replaced: the old key is only in the earlier capture, the new key is displayed.
    const replaced = household();
    replaced.read('A', [KETTLE_SEEN]);
    replaced.read('A', [KETTLE]);
    expect(replaced.db.prepare(`SELECT json_extract(i.data_json,'$.itemId') FROM amazon_items i JOIN amazon_orders o ON o.ref=i.order_ref
      WHERE i.native_line_id LIKE o.latest_digest || ':%'`).pluck().all()).toEqual([KETTLE.asin]);
    // Held: the display keeps the old key; the new key is only in the later read.
    const held = household();
    held.read('A', [KETTLE_SEEN]);
    held.read('A', [KETTLE], false);
    expect(held.db.prepare(`SELECT json_extract(i.data_json,'$.itemId') FROM amazon_items i JOIN amazon_orders o ON o.ref=i.order_ref
      WHERE i.native_line_id LIKE o.latest_digest || ':%'`).pluck().all()).toEqual([null]);
    for (const { db, assign } of [replaced, held]) {
      assign([[KETTLE_SEEN, 'agent', 'home-kitchen/small-appliances', 0.91]]);
      expect(taxonomyKeyAdoptions(db)).toEqual([adoption(KETTLE, KETTLE_SEEN, 'home-kitchen/small-appliances', 'agent', 0.91)]);
    }
    // Only a later read gives a key: an ASIN read first and lost later is no change.
    const lost = household();
    lost.read('A', [KETTLE]);
    lost.read('A', [KETTLE_SEEN]);
    expect(taxonomyKeyChanges(lost.db)).toEqual([]);
  });

  it('honours extra key changes (categoryKeyAdoptions-shaped, other fields ignored) by the same rules', () => {
    const { db, read, assign } = household();
    // Different orders: no read links the lamp's keys, only the extra change does.
    read('A', [LAMP_SEEN]);
    read('B', [LAMP, KETTLE]);
    assign([[LAMP_SEEN, 'agent', 'home-kitchen/furniture-decor', 0.88]]);
    expect(taxonomyKeyChanges(db)).toEqual([]);
    const lamp = { ...change(LAMP, LAMP_SEEN), category: 'Synthetic Furniture', confidence: 0.2 };
    const fromCategories = [lamp,
      // Ignored: a previous key without an assignment, an unknown new key, no change, and malformed values.
      { ...change(KETTLE, KETTLE_SEEN), category: 'Synthetic Furniture', confidence: 0.9 },
      { ...change({ asin: 'SYNTHNONE1', title: 'Synthetic Unknown' }, LAMP_SEEN), category: 'Synthetic Furniture', confidence: 0.9 },
      change(LAMP_SEEN, LAMP_SEEN), { productKey: 7, previousProductKey: key(LAMP_SEEN) }, null];
    expect(taxonomyKeyAdoptions(db, fromCategories as never)).toEqual([adoption(LAMP, LAMP_SEEN, 'home-kitchen/furniture-decor', 'agent', 0.88)]);
    // Any iterable works, and the worklist takes the same changes.
    expect(taxonomyKeyAdoptions(db, new Set([change(LAMP, LAMP_SEEN)]))).toHaveLength(1);
    expect(taxonomyWorklist(db, { keyChanges: [lamp] }).products.find(p => p.productKey === key(LAMP))?.adoptFrom)
      .toEqual({ previousProductKey: key(LAMP_SEEN), node: 'home-kitchen/furniture-decor', source: 'agent', confidence: 0.88 });
    expect(taxonomyWorklist(db).products.every(p => p.adoptFrom === null)).toBe(true);
  });

  it('tags the worklist\'s products with the assignment they would adopt, and every other product with null', () => {
    const { db, read, assign } = household();
    read('A', [KETTLE_SEEN, LAMP_SEEN]);
    read('A', [KETTLE, LAMP], false);
    assign([[KETTLE_SEEN, 'owner', 'home-kitchen/small-appliances', 1]]);
    const worklist = taxonomyWorklist(db);
    expect(worklist.version).toBe(1);
    expect(worklist.products.map(p => [p.productKey, p.adoptFrom])).toEqual([
      [key(KETTLE), { previousProductKey: key(KETTLE_SEEN), node: 'home-kitchen/small-appliances', source: 'owner', confidence: 1 }],
      [key(KETTLE_SEEN), null], [key(LAMP), null], [key(LAMP_SEEN), null],
    ].sort(([a], [b]) => ((a as string) < (b as string) ? -1 : 1)));
    expect(worklist.products.find(p => p.productKey === key(KETTLE))).toMatchObject({ assigned: null, resolved: 'needs-review' });
  });
});

describe('Applying an adoption mapping (Root: its contract holds when the GO\'d import writes)', () => {
  const NOW = '2026-10-22T00:00:00.000Z';
  const SMALL = 'home-kitchen/small-appliances', DECOR = 'home-kitchen/furniture-decor';
  type Row = [Product, 'agent' | 'owner', string, number];
  /** A generic (non-adoption) mapping, as the classifier's or the owner's import has it. */
  const generic = (rows: Row[]) => ({ format: AMAZON_TAXONOMY_MAPPING_FORMAT, version: 1, taxonomyVersion: 1, reviewed: true,
    entries: rows.map(([p, source, node, confidence]) => ({ productKey: key(p), node, confidence, source })) });
  const apply = (db: Database.Database, input: unknown) => db.transaction(() => applyTaxonomyMapping(db, input, NOW))();
  /** Two lines that learned their ASINs, their previous keys assigned (the lamp's by the owner over an agent), and the mapping. */
  function generated() {
    const h = household();
    h.read('A', [KETTLE_SEEN, LAMP_SEEN]);
    h.read('A', [KETTLE, LAMP]);
    h.assign([[KETTLE_SEEN, 'agent', SMALL, 0.91], [LAMP_SEEN, 'agent', 'electronics/smart-home', 0.7], [LAMP_SEEN, 'owner', DECOR, 1]]);
    return { ...h, mapping: taxonomyAdoptionMapping(h.db)! };
  }
  const rows = (db: Database.Database) => db.prepare('SELECT * FROM amazon_product_taxonomy ORDER BY product_key,source').all() as
    Array<{ product_key: string }>;
  /** Everything an import writes, and the connection's change counter (which a write rolled back still moves). */
  const state = (db: Database.Database) => ({ rows: rows(db), audit: db.prepare('SELECT count(*) FROM amazon_audit').pluck().get(),
    changes: db.prepare('SELECT total_changes()').pluck().get() });
  /** Refused whole, by the plan and by the write itself, with counts only, and nothing written. */
  const expectStale = (db: Database.Database, mapping: { entries: unknown[] }, counts: { newKeyAssigned: number; previousChanged: number }) => {
    const before = state(db);
    for (const attempt of [() => planTaxonomyImport(db, mapping), () => apply(db, mapping)]) {
      let refusal: unknown = null;
      try { attempt(); } catch (error) { refusal = error; }
      expect(taxonomyAdoptionStale(refusal), String(attempt)).toEqual({ entries: mapping.entries.length, ...counts });
      expect((refusal as Error).message).toBe(`adoption-stale entries=${mapping.entries.length} newKeyAssigned=${counts.newKeyAssigned}`
        + ` previousChanged=${counts.previousChanged}`);
    }
    expect(state(db)).toEqual(before);
  };

  it('carries its provenance and, with nothing changed since, applies exactly the adopted values', () => {
    const { db, mapping } = generated();
    expect(mapping).toEqual({ format: AMAZON_TAXONOMY_MAPPING_FORMAT, version: 1, taxonomyVersion: 1, reviewed: true, kind: 'adoption',
      entries: sorted([{ productKey: key(KETTLE), previousProductKey: key(KETTLE_SEEN), node: SMALL, confidence: 0.91, source: 'agent' },
        { productKey: key(LAMP), previousProductKey: key(LAMP_SEEN), node: DECOR, confidence: 1, source: 'owner' }]) });
    expect(planTaxonomyImport(db, mapping)).toMatchObject({ kind: 'adoption', entries: 2, agent: 1, owner: 1, insert: 2, update: 0,
      unchanged: 0, mappingDigest: digest(mapping) });
    const before = rows(db);
    expect(apply(db, mapping)).toEqual({ insert: 2, update: 0, unchanged: 0 });
    const adopted = new Set([key(KETTLE), key(LAMP)]);
    expect(rows(db).filter(r => !adopted.has(r.product_key))).toEqual(before);
    expect(rows(db).filter(r => adopted.has(r.product_key))).toEqual(sorted([
      { productKey: key(KETTLE), row: { product_key: key(KETTLE), source: 'agent', node: SMALL, confidence: 0.91, taxonomy_version: 1,
        mapping_digest: digest(mapping) } },
      { productKey: key(LAMP), row: { product_key: key(LAMP), source: 'owner', node: DECOR, confidence: 1, taxonomy_version: 1,
        mapping_digest: digest(mapping) } }]).map(r => r.row));
    const assignments = readTaxonomyAssignments(db);
    expect(assignments.get(key(KETTLE))).toEqual(assignments.get(key(KETTLE_SEEN)));
    expect(assignments.get(key(LAMP))).toEqual(assignments.get(key(LAMP_SEEN)));
    // Nothing is left to adopt, and the same mapping again is stale: its new keys are assigned now.
    expect(taxonomyAdoptionMapping(db)).toBeNull();
    expectStale(db, mapping, { newKeyAssigned: 2, previousChanged: 0 });
  });

  it('refuses the whole mapping, writing nothing, when a new key was classified after it was generated', () => {
    // A weak agent row, or the owner choosing the very node the adoption would give: never overwritten either way.
    for (const row of [[KETTLE, 'agent', 'home-kitchen/kitchen-dining', 0.3], [KETTLE, 'owner', SMALL, 1]] as Row[]) {
      const { db, mapping } = generated();
      apply(db, generic([row]));
      expectStale(db, mapping, { newKeyAssigned: 1, previousChanged: 0 });
    }
  });

  it('refuses the whole mapping, writing nothing, when a previous key\'s adopted assignment changed after it was generated', () => {
    const alterations: Array<[string, (db: Database.Database) => void]> = [
      ['another node', db => apply(db, generic([[KETTLE_SEEN, 'agent', 'home-kitchen/kitchen-dining', 0.91]]))],
      ['another confidence', db => apply(db, generic([[KETTLE_SEEN, 'agent', SMALL, 0.9]]))],
      ['the owner chose the same node', db => apply(db, generic([[KETTLE_SEEN, 'owner', SMALL, 1]]))],
      ['its row deleted', db => db.prepare('DELETE FROM amazon_product_taxonomy WHERE product_key=?').run(key(KETTLE_SEEN))],
      ['the owner\'s row the lamp adopts', db => apply(db, generic([[LAMP_SEEN, 'owner', SMALL, 1]]))],
    ];
    for (const [what, alter] of alterations) {
      const { db, mapping } = generated();
      alter(db);
      expect(() => expectStale(db, mapping, { newKeyAssigned: 0, previousChanged: 1 }), what).not.toThrow();
    }
    // Both at once count both. The adopted value is the previous key's winning one: the agent row under the lamp's owner
    // row was not adopted, so a change to it alone is not stale.
    const both = generated();
    apply(both.db, generic([[KETTLE, 'agent', SMALL, 0.91], [LAMP_SEEN, 'owner', SMALL, 1]]));
    expectStale(both.db, both.mapping, { newKeyAssigned: 1, previousChanged: 1 });
    const { db, mapping } = generated();
    apply(db, generic([[LAMP_SEEN, 'agent', 'electronics/networking', 0.95]]));
    expect(apply(db, mapping)).toEqual({ insert: 2, update: 0, unchanged: 0 });
  });

  it('leaves generic mappings exactly as they were: no precondition, no kind, existing rows updated', () => {
    const { db } = generated();
    const reclassified = generic([[KETTLE_SEEN, 'agent', 'home-kitchen/kitchen-dining', 0.8]]);
    const plan = planTaxonomyImport(db, reclassified);
    expect(Object.hasOwn(plan, 'kind')).toBe(false);
    expect(plan).toMatchObject({ entries: 1, insert: 0, update: 1, unchanged: 0 });
    expect(apply(db, reclassified)).toEqual({ insert: 0, update: 1, unchanged: 0 });
    expect(apply(db, reclassified)).toEqual({ insert: 0, update: 0, unchanged: 1 });
    // Classifying a key an adoption would have named is an ordinary classification.
    expect(apply(db, generic([[KETTLE, 'agent', SMALL, 0.91], [KETTLE, 'owner', DECOR, 1]]))).toEqual({ insert: 2, update: 0, unchanged: 0 });
  });

  it('validates an adoption mapping whole: its kind, its provenance and one entry per new key', () => {
    const { mapping } = generated();
    expect(validateTaxonomyMapping(mapping)).toBe(mapping);
    const [entry] = mapping.entries;
    const variant = (patch: Record<string, unknown>, entries: unknown[] = mapping.entries) => ({ ...mapping, ...patch, entries });
    const { kind: _kind, ...withoutKind } = mapping;
    const { previousProductKey: _previous, ...unsourced } = entry;
    const refused: Array<[string, unknown]> = [
      ['another kind', variant({ kind: 'generic' })], ['null kind', variant({ kind: null })], ['extra field', variant({ note: 'x' })],
      ['unreviewed', variant({ reviewed: false })], ['format', variant({ format: 'holdr.amazon-taxonomy-assignments' })],
      ['no previous key', variant({}, [unsourced])],
      ['previous key is the new key', variant({}, [{ ...entry, previousProductKey: entry.productKey }])],
      ['malformed previous key', variant({}, [{ ...entry, previousProductKey: 'abc' }])],
      ['upper-case previous key', variant({}, [{ ...entry, previousProductKey: entry.previousProductKey!.toUpperCase() }])],
      ['a new key twice', variant({}, [entry, { ...entry, previousProductKey: key(LAMP_SEEN), source: 'owner', confidence: 1 }])],
      ['reviewer title', variant({}, [{ ...entry, asin: KETTLE.asin, title: KETTLE.title }])],
      ['unknown node', variant({}, [{ ...entry, node: 'home-kitchen/robots' }])],
      ['owner below 1', variant({}, [{ ...entry, source: 'owner', confidence: 0.9 }])],
      // Provenance never passes as a generic mapping, nor a generic mapping as an adoption.
      ['provenance without kind', withoutKind],
      ['kind without provenance', variant({}, [unsourced, { ...mapping.entries[1] }])],
    ];
    for (const [what, input] of refused) expect(() => validateTaxonomyMapping(input), what).toThrow('amazon input refused');
  });
});

// STEP 9 integration B8 (Root, bd744359): a Fresh re-read held taxonomy-unmatched (B4) must reach the adoption mapping.
describe('STEP 9 integration B8 (Root): an Amazon Fresh Item List re-read is a key change too', () => {
  const BASIL_SEEN = { asin: null, title: 'Synthetic Fresh Basil' }, BASIL = { asin: 'SYNTHBASL1', title: BASIL_SEEN.title };
  const LEEKS = { asin: 'SYNTHLEEK1', title: 'Synthetic Fresh Leeks' };
  const LEEKS_RENAMED = { asin: LEEKS.asin, title: 'Synthetic Fresh Leeks, Bunch' };
  const THYME_SEEN = { asin: null, title: 'Synthetic Fresh Thyme' }, THYME = { asin: 'SYNTHTHYM1', title: THYME_SEEN.title };
  const DILL = { asin: 'SYNTHDILL1', title: 'Synthetic Fresh Dill' }, DILL_LOST = { asin: null, title: DILL.title };
  const SAGE_SEEN = { asin: null, title: 'Synthetic Fresh Sage' };
  const CHIVES_SEEN = { asin: null, title: 'Synthetic Fresh Chives' }, CHIVES = { asin: 'SYNTHCHIV1', title: CHIVES_SEEN.title };
  const MINT_SEEN = { asin: null, title: 'Synthetic Fresh Mint' }, MINT = { asin: 'SYNTHMINT1', title: MINT_SEEN.title };
  const PRODUCE = 'groceries/produce';
  const lines = (products: Product[]) => products.map(p => freshLine(p.title, { asin: p.asin, ...each(1, 100) }));

  it('examines each Fresh order\'s Item List reads in import order, as order observations are, as a sequence of their own', () => {
    const { db, read, assign } = household();
    freshDatabase(db);
    read('A', [KETTLE_SEEN]);
    read('A', [KETTLE]);
    const order = (name: string) => seedOrder(db, name, '2026-09-01', usd(100), 100);
    // F1's active list learned the basil's ASIN and renamed the leeks; F2's re-read that learned the thyme's ASIN was held
    // (B4: the order still shows its first list).
    const f1 = order('F1'), f2 = order('F2');
    seedFreshList(db, f1, lines([BASIL_SEEN, LEEKS]), { label: 'first', latest: false });
    seedFreshList(db, f1, lines([BASIL, LEEKS_RENAMED]), { label: 'second' });
    seedFreshList(db, f2, lines([THYME_SEEN]), { label: 'shown' });
    seedFreshList(db, f2, lines([THYME]), { label: 'held', latest: false });
    // No change: an ASIN read first and lost later; two later lines of one identity; one product in two orders; and an
    // order item and a Fresh line of one order (each family is a sequence of its own).
    const f3 = order('F3'), f4 = order('F4');
    seedFreshList(db, f3, lines([DILL]), { label: 'first', latest: false });
    seedFreshList(db, f3, lines([DILL_LOST]), { label: 'second' });
    seedFreshList(db, f4, lines([SAGE_SEEN]), { label: 'first', latest: false });
    seedFreshList(db, f4, lines([{ asin: 'SYNTHSAGE1', title: SAGE_SEEN.title }, { asin: 'SYNTHSAGE2', title: SAGE_SEEN.title }]),
      { label: 'second' });
    seedFreshList(db, order('F5'), lines([CHIVES_SEEN]));
    seedFreshList(db, order('F6'), lines([CHIVES]));
    read('M', [MINT_SEEN]);
    seedFreshList(db, opaque('order', 'synthetic-order-M'), lines([MINT]));
    const changes = db.prepare('SELECT total_changes()').pluck().get();
    expect(taxonomyKeyChanges(db)).toEqual(sorted([change(KETTLE, KETTLE_SEEN), change(BASIL, BASIL_SEEN), change(LEEKS_RENAMED, LEEKS),
      change(THYME, THYME_SEEN)]));
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changes);
    // The held re-read's learned key is one the import accepts; each Fresh adoption carries its previous tuple unchanged.
    assign([[BASIL_SEEN, 'agent', PRODUCE, 0.9], [THYME_SEEN, 'owner', PRODUCE, 1], [DILL, 'agent', PRODUCE, 0.9],
      [SAGE_SEEN, 'agent', PRODUCE, 0.9], [CHIVES_SEEN, 'agent', PRODUCE, 0.9], [MINT_SEEN, 'agent', PRODUCE, 0.9]]);
    expect(knownTaxonomyProductKeys(db).has(key(THYME))).toBe(true);
    expect(taxonomyKeyAdoptions(db)).toEqual(sorted([adoption(BASIL, BASIL_SEEN, PRODUCE, 'agent', 0.9),
      adoption(THYME, THYME_SEEN, PRODUCE, 'owner', 1)]));
    expect(taxonomyWorklist(db).products.find(p => p.productKey === key(THYME))?.adoptFrom)
      .toEqual({ previousProductKey: key(THYME_SEEN), node: PRODUCE, source: 'owner', confidence: 1 });
    const mapping = taxonomyAdoptionMapping(db)!;
    expect(planTaxonomyImport(db, mapping)).toMatchObject({ kind: 'adoption', entries: 2, insert: 2 });
    expect(db.transaction(() => applyTaxonomyMapping(db, mapping, '2026-10-22T00:00:00.000Z'))()).toEqual({ insert: 2, update: 0,
      unchanged: 0 });
    expect(taxonomyKeyAdoptions(db)).toEqual([]);
  });
});
