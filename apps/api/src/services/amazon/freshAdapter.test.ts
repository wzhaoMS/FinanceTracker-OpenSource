import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { AMAZON_FRESH_SCHEMA_DIGEST, AMAZON_FRESH_TABLES, hasAmazonFreshSchema } from './freshSchema.js';
// STEP 9 integration B8 (Root): the retained-list readers the taxonomy uses.
import {
  freshListReads, freshListsCaptured, freshRetainedObservations, freshTaxonomyObservations, readFreshOrders, type FreshListRead,
} from './freshAdapter.js';
import {
  amazonDatabase, each, freshDatabase, freshLine, freshOrderId, freshOrderRef, seedFreshList, seedOrder, usd, weighed,
} from './freshFixtures.testSupport.js';

// Entirely synthetic: made-up orders, titles, ASINs, weights and prices.
const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const API_SRC = path.resolve(SOURCE_DIR, '..', '..');
const changes = (db: Database.Database) => ({ total: db.prepare('SELECT total_changes()').pluck().get(),
  objects: db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all() });
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(file);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$|\.testSupport\.ts$/.test(entry.name) ? [file] : [];
  });
}

describe('Amazon Fresh adapter: the one reader of the Fresh import\'s tables', () => {
  it('reads the Fresh import\'s exact schema (its digest pinned here, so a change to it comes back to this adapter)', () => {
    expect(AMAZON_FRESH_TABLES).toEqual(['amazon_fresh_lists', 'amazon_fresh_lines', 'amazon_fresh_orders']);
    expect(AMAZON_FRESH_SCHEMA_DIGEST).toBe('f55aedae2699f7a60094422cb49d1941a546868d3289194f904f652f39ceae1c');
  });

  it('is empty without the Fresh tables, or with any other shape of them, and never creates or repairs one', () => {
    const empty = new Database(':memory:');
    const nothing = changes(empty);
    expect(freshListsCaptured(empty)).toBe(false);
    expect(readFreshOrders(empty, { from: '2024-01-01', to: '2026-12-31' })).toEqual([]);
    expect(freshTaxonomyObservations(empty)).toEqual([]);
    expect(changes(empty)).toEqual(nothing);

    const amazonOnly = new Database(':memory:');
    amazonDatabase(amazonOnly);
    const before = changes(amazonOnly);
    expect(freshListsCaptured(amazonOnly)).toBe(false);
    expect(readFreshOrders(amazonOnly, { orderRef: 'amz-synthetic' })).toEqual([]);
    expect(freshTaxonomyObservations(amazonOnly)).toEqual([]);
    expect(changes(amazonOnly)).toEqual(before);

    // The Fresh tables with one of them another shape: no Fresh list at all, never a partial read.
    const other = new Database(':memory:');
    freshDatabase(other);
    const ref = seedOrder(other, 'S1', '2026-10-01', usd(500), 500);
    seedFreshList(other, ref, [freshLine('Synthetic Shape Test Apples', each(1, 500))]);
    expect(freshListsCaptured(other)).toBe(true);
    other.exec(`DROP TABLE amazon_fresh_orders;
      CREATE TABLE amazon_fresh_orders (order_ref TEXT PRIMARY KEY, latest_digest TEXT)`);
    other.prepare('INSERT INTO amazon_fresh_orders SELECT order_ref,digest FROM amazon_fresh_lists').run();
    const shaped = changes(other);
    expect(hasAmazonFreshSchema(other)).toBe(false);
    expect(freshListsCaptured(other)).toBe(false);
    expect(readFreshOrders(other, { from: '2024-01-01', to: '2026-12-31' })).toEqual([]);
    expect(freshTaxonomyObservations(other)).toEqual([]);
    expect(changes(other)).toEqual(shaped);
  });

  it('reads each order\'s active list only, newest order first, checking every stored row whole', () => {
    const db = new Database(':memory:');
    freshDatabase(db);
    const older = seedOrder(db, 'A1', '2026-09-01', usd(700), 700);
    const newer = seedOrder(db, 'A2', '2026-10-01', usd(400), 400);
    const outside = seedOrder(db, 'A3', '2025-01-01', usd(100), 100);
    seedOrder(db, 'A4', '2026-09-15', usd(900), 900);
    // A1 read twice: only the active list counts.
    seedFreshList(db, older, [freshLine('Synthetic Old Read Plums', each(1, 700))], { label: 'first', latest: false });
    seedFreshList(db, older, [
      freshLine('Synthetic Roma Tomatoes', { quantity: 1, ...weighed('1.5', 200, 300) }),
      freshLine('Synthetic Whole Milk', { asin: 'SYNTHMILK1', ...each(2, 200) }),
      { raw: { lineOrdinal: 9, title: 'Synthetic misplaced row' } },
    ], { label: 'second' });
    // A2: one row stored at another position than it says, and one that isn't JSON at all.
    const { refs } = seedFreshList(db, newer, [freshLine('Synthetic Butter', each(1, 400)), freshLine('Synthetic Jam', each(1, 100)),
      freshLine('Synthetic Honey', each(1, 100))]);
    db.prepare('UPDATE amazon_fresh_lines SET data_json=? WHERE ref=?')
      .run(JSON.stringify({ ...freshLine('Synthetic Jam', each(1, 100)), lineOrdinal: 7 }), refs[1]);
    db.prepare('UPDATE amazon_fresh_lines SET data_json=? WHERE ref=?').run('{not json', refs[2]);
    seedFreshList(db, outside, [freshLine('Synthetic Last Year Pears', each(1, 100))]);
    // A4's active list is another order's: unreadable, none of its lines read.
    db.prepare('INSERT INTO amazon_fresh_orders SELECT ?,latest_digest FROM amazon_fresh_orders WHERE order_ref=?')
      .run(seedOrder(db, 'A5', '2026-09-10', usd(50), 50), newer);

    const before = changes(db);
    const reads = readFreshOrders(db, { from: '2026-01-01', to: '2026-10-19' });
    expect(reads.map((read) => [read.orderId, read.order.date, read.lines.map((line) => line.title), read.unreadable, read.list === null]))
      .toEqual([
        [freshOrderId('A2'), '2026-10-01', ['Synthetic Butter'], 2, false],
        [freshOrderId('A5'), '2026-09-10', [], 0, true],
        [freshOrderId('A1'), '2026-09-01', ['Synthetic Roma Tomatoes', 'Synthetic Whole Milk'], 1, false],
      ]);
    const [, , a1] = reads;
    expect(a1.ref).toBe(older);
    expect(a1.list).toMatchObject({ statedCount: 3, rows: 3, lines: 3, proof: { complete: true, unreadRows: 0 } });
    expect(a1.lines[1]).toEqual({ ref: expect.stringMatching(/^amz-[a-f0-9]{48}$/), lineOrdinal: 1, title: 'Synthetic Whole Milk',
      asin: 'SYNTHMILK1', status: 'listed', quantity: 2, weight: null, unitPrice: { money: usd(200), per: 'each' }, linePrice: usd(400),
      replaces: null });
    expect(readFreshOrders(db, { orderRef: older }).map((read) => read.lines.length)).toEqual([2]);
    expect(readFreshOrders(db, { orderRef: freshOrderRef('A4') })).toEqual([]);
    expect(readFreshOrders(db, 'all').map((read) => read.orderId)).toEqual(['A2', 'A5', 'A1', 'A3'].map(freshOrderId));
    // The taxonomy's observations: exactly the lines the tab reads, from every active list (the older read's never).
    expect(freshTaxonomyObservations(db)).toEqual([
      { itemId: null, title: 'Synthetic Butter' }, { itemId: null, title: 'Synthetic Roma Tomatoes' },
      { itemId: 'SYNTHMILK1', title: 'Synthetic Whole Milk' }, { itemId: null, title: 'Synthetic Last Year Pears' },
    ]);
    expect(changes(db)).toEqual(before);
  });

  it('STEP 9 integration B8 (Root): reads every retained list, by order and import order, for the taxonomy; B6 still hides', () => {
    const db = new Database(':memory:');
    freshDatabase(db);
    const shown = seedOrder(db, 'R1', '2026-09-01', usd(700), 700);
    const proven = seedOrder(db, 'R2', '2026-09-02', usd(300), 300, 0, { chargeFree: { status: 'cancelled-not-charged', shipments: 1 } });
    // R1 read three times: an older list its active list replaced, the active list (one row stored out of place), and a
    // later re-read kept as history (held, or poorer).
    seedFreshList(db, shown, [freshLine('Synthetic Retained Plums', each(1, 700))], { label: 'first', latest: false });
    const { refs } = seedFreshList(db, shown, [freshLine('Synthetic Retained Plums', { asin: 'SYNTHPLUM9', ...each(1, 700) }),
      freshLine('Synthetic Retained Jam', each(1, 100))], { label: 'second' });
    db.prepare('UPDATE amazon_fresh_lines SET data_json=? WHERE ref=?')
      .run(JSON.stringify({ ...freshLine('Synthetic Retained Jam', each(1, 100)), lineOrdinal: 7 }), refs[1]);
    seedFreshList(db, shown, [freshLine('Synthetic Retained Figs', each(1, 700))], { label: 'third', latest: false });
    // R2 is displayed as charge-free (B6): no count reads its active list, but its reads are still its history.
    seedFreshList(db, proven, [freshLine('Synthetic Proven Kale', each(1, 300))]);
    seedFreshList(db, proven, [freshLine('Synthetic Proven Kale', { asin: 'SYNTHKALE9', ...each(1, 300) })],
      { label: 'held', latest: false });
    const before = changes(db);
    const plums = { itemId: null, title: 'Synthetic Retained Plums' }, learned = { itemId: 'SYNTHPLUM9', title: plums.title };
    const figs = { itemId: null, title: 'Synthetic Retained Figs' }, kale = { itemId: null, title: 'Synthetic Proven Kale' };
    const reads: Array<[string, FreshListRead[]]> = [
      [shown, [{ orderRef: shown, active: false, lines: [plums] }, { orderRef: shown, active: true, lines: [learned] },
        { orderRef: shown, active: false, lines: [figs] }]],
      [proven, [{ orderRef: proven, active: true, lines: [kale] },
        { orderRef: proven, active: false, lines: [{ itemId: 'SYNTHKALE9', title: kale.title }] }]],
    ];
    const byOrder = reads.sort(([a], [b]) => (a < b ? -1 : 1)).flatMap(([, list]) => list);
    expect(freshListReads(db)).toEqual(byOrder);
    // What the taxonomy may classify: the active lists exactly as the tab reads them (none of R2's), then every other list.
    expect(freshTaxonomyObservations(db)).toEqual([learned]);
    expect(freshRetainedObservations(db)).toEqual([learned, ...byOrder.filter((read) => !read.active).flatMap((read) => read.lines)]);
    expect(changes(db)).toEqual(before);
    // Without the exact tables there is no list at all, and nothing is created.
    const amazonOnly = new Database(':memory:');
    amazonDatabase(amazonOnly);
    const untouched = changes(amazonOnly);
    expect([freshListReads(amazonOnly), freshRetainedObservations(amazonOnly)]).toEqual([[], []]);
    expect(changes(amazonOnly)).toEqual(untouched);
  });

  it('is the only module outside the Fresh import that reads its tables', () => {
    const fresh = /amazon_fresh_(?:lists|lines|orders)\b|from '\.\/freshSchema\.js'/;
    const allowed = new Set(['freshSchema.ts', 'freshImport.ts', 'freshAdapter.ts']);
    const readers = sources(API_SRC).filter((file) => fresh.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(API_SRC, file).replace(/\\/g, '/'));
    expect(readers.filter((file) => !allowed.has(path.basename(file)))).toEqual([]);
    expect(readers).toContain('services/amazon/freshAdapter.ts');
  });
});
