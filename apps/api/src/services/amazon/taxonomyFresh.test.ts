import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { AMAZON_ITEM_TAXONOMY_VERSION } from '@finance-tracker/shared';
import { opaque, SOURCE } from './policy.js';
import { productKey } from './products.js';
import {
  AMAZON_TAXONOMY_MAPPING_FORMAT, applyTaxonomyMapping, installAmazonTaxonomySchema, knownTaxonomyProductKeys, planTaxonomyImport,
  taxonomyWorklist,
} from './taxonomy.js';
import { amazonFresh } from './fresh.js';
import {
  amazonDatabase, each, freshLine, installFreshTables, seedFreshList, seedOrder, SYNTHETIC_CAPTURE, usd, weighed,
} from './freshFixtures.testSupport.js';

// Entirely synthetic: made-up orders, titles, ASINs and prices.
const ITEM = { asin: 'SYNTHITEM1', title: 'Synthetic Kitchen Scale' };
const PORK = { asin: 'SYNTHPORK3', title: 'Synthetic Pork Belly, Skin-On' };
const CHIPS = { asin: null, title: 'Synthetic Kettle Chips' };
const PLUMS = { asin: 'SYNTHPLUM1', title: 'Synthetic Plums, Older Read' };
// The card-data guard holds this title: never in the worklist, never assignable.
const HELD = { asin: null, title: 'Synthetic 4111111111111111' };
const NOW = '2026-10-21T00:00:00.000Z';

/** One ordinary order with one item, as the taxonomy's own tests have, and no Fresh table. */
function database() {
  const db = new Database(':memory:');
  amazonDatabase(db);
  const orderRef = opaque('order', 'synthetic-order');
  db.prepare('INSERT INTO amazon_orders VALUES(?,?,?,?,?,NULL)').run(orderRef, SOURCE, 'synthetic-order', SYNTHETIC_CAPTURE,
    JSON.stringify({ orderId: 'synthetic-order', date: '2026-09-01', total: null, items: [] }));
  db.prepare('INSERT INTO amazon_items VALUES(?,?,?,?)').run(opaque('line', 0), orderRef, `${SYNTHETIC_CAPTURE}:0`,
    JSON.stringify({ lineOrdinal: 0, itemId: ITEM.asin, title: ITEM.title, quantity: 1, unitPrice: null }));
  return db;
}
const mapping = (entries: Array<{ product: { asin: string | null; title: string }; node: string }>) => ({
  format: AMAZON_TAXONOMY_MAPPING_FORMAT, version: 1, taxonomyVersion: AMAZON_ITEM_TAXONOMY_VERSION, reviewed: true,
  entries: entries.map(({ product, node }) => ({ productKey: productKey(product), node, confidence: 1, source: 'owner' })),
});

describe('item taxonomy over Amazon Fresh lines', () => {
  it('leaves the worklist and the keys a mapping may assign exactly as they were without Fresh lines', () => {
    const db = database();
    const worklist = taxonomyWorklist(db), keys = knownTaxonomyProductKeys(db);
    expect(worklist.coverage).toEqual({ itemObservations: 1, classifiableObservations: 1, heldTitleObservations: 0 });
    expect(worklist.products.map((p) => p.productKey)).toEqual([productKey(ITEM)]);
    installFreshTables(db);
    expect(taxonomyWorklist(db)).toEqual(worklist);
    expect(knownTaxonomyProductKeys(db)).toEqual(keys);
  });

  it('adds every active Fresh list\'s readable lines, so the gated import can classify them for the Fresh tab', () => {
    const db = database();
    installFreshTables(db);
    const one = seedOrder(db, 'T1', '2026-10-05', usd(1000), 1000);
    seedFreshList(db, one, [freshLine(PORK.title, { asin: PORK.asin, quantity: 1, ...weighed('1.6', 500, 800) }),
      freshLine(CHIPS.title, each(1, 100)), freshLine(HELD.title, each(1, 100))]);
    const two = seedOrder(db, 'T2', '2026-10-12', usd(400), 400);
    // An older read of T2 that its active list replaced: the Fresh tab never reads it again.
    // STEP 9 integration B8 (Root): but it is a retained list, so the taxonomy knows and lists its product (PLUMS), as it
    // does every capture's items: a held re-read's learned key reaches the GO'd import the same way.
    seedFreshList(db, two, [freshLine(PLUMS.title, { asin: PLUMS.asin, ...each(1, 400) })], { label: 'older', latest: false });
    seedFreshList(db, two, [freshLine(PORK.title, { asin: PORK.asin, quantity: 1, ...weighed('0.8', 500, 400) })], { label: 'newer' });

    const worklist = taxonomyWorklist(db);
    expect(worklist.coverage).toEqual({ itemObservations: 6, classifiableObservations: 5, heldTitleObservations: 1 });
    expect(worklist.products.map((p) => [p.title, p.asin, p.lines, p.resolved]).sort()).toEqual([
      [CHIPS.title, null, 1, 'needs-review'], [ITEM.title, ITEM.asin, 1, 'needs-review'], [PORK.title, PORK.asin, 2, 'needs-review'],
      [PLUMS.title, PLUMS.asin, 1, 'needs-review'],
    ].sort());
    const keys = knownTaxonomyProductKeys(db);
    expect([...keys].sort()).toEqual([productKey(ITEM), productKey(PORK), productKey(CHIPS), productKey(PLUMS)].sort());

    // A mapping may now assign the Fresh products, a retained list's included (B8), but never a title the guard holds.
    expect(() => planTaxonomyImport(db, mapping([{ product: HELD, node: 'groceries/produce' }]))).toThrow('amazon input refused');
    expect(planTaxonomyImport(db, mapping([{ product: PLUMS, node: 'groceries/produce' }]))).toMatchObject({ insert: 1, products: 4 });
    const input = mapping([{ product: PORK, node: 'groceries/meat-seafood' }, { product: CHIPS, node: 'groceries/snacks-sweets' }]);
    expect(planTaxonomyImport(db, input)).toMatchObject({ schema: 'absent', entries: 2, insert: 2, products: 4, assignedAfter: 2,
      needsReviewAfter: 2 });
    db.transaction(() => { installAmazonTaxonomySchema(db); applyTaxonomyMapping(db, input, NOW); })();
    const view = amazonFresh(db, '30D', '2026-10-19');
    expect(view.categories.map((c) => [c.category, c.amountMinor])).toEqual([['groceries/meat-seafood', 1200],
      ['groceries/snacks-sweets', 100], ['needs-review', 100]]);
    expect(taxonomyWorklist(db).products.find((p) => p.title === PORK.title)?.resolved).toBe('groceries/meat-seafood');
  });
});
