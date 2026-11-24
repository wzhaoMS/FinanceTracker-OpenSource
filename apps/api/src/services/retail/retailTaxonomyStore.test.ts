import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  CARD_ASSET_CATEGORY,
  ITEM_TAXONOMY_ASSET_NODE as ASSET,
  ITEM_TAXONOMY_BP_SCALE,
  ITEM_TAXONOMY_RESIDUAL as RESIDUAL,
  ITEM_TAXONOMY_SOURCES,
  ITEM_TAXONOMY_V2_VIEW,
} from '@finance-tracker/shared';

import {
  RETAIL_CONFIDENCE_BP_MAX,
  RETAIL_PURPOSES,
  RETAIL_SCHEMA_DIGEST,
  RETAIL_SCHEMA_SQL,
  RETAIL_TABLES,
  RETAIL_TAXONOMY_ASSIGNMENTS_FORMAT,
  RETAIL_TAXONOMY_FILE_MAX_BYTES,
  RETAIL_TAXONOMY_LINE_KINDS,
  RETAIL_TAXONOMY_MAPPING_FORMAT,
  RETAIL_TAXONOMY_SOURCES,
  RETAIL_TAXONOMY_STORED_VERSION,
  RETAIL_TAXONOMY_SUBJECT_KINDS,
  RETAIL_TAXONOMY_VERSION,
  RETAIL_TAXONOMY_WORKLIST_FORMAT,
  importRetailTaxonomy,
  planRetailTaxonomyImport,
  retailLetters,
  retailProductKey,
  retailDepartmentKey,
  retailTaxonomyCategoriesMissing,
  retailTaxonomyMappingOf,
  retailTaxonomyWorklist,
  serializeRetailTaxonomyMapping,
  type RetailTaxonomyEntry,
  type RetailTaxonomyImportReceipt,
} from './index.js';
import { RETAIL_TEST_NOW, importPayload, refusalOf, retailTestDb, rows } from '../../testing/retailDb.js';
import { goldBar, onlineLine, onlineOrder, syntheticRetailPayload, warehouseLine, warehouseReceipt } from '../../testing/retailPayloads.js';

// The retail taxonomy on PR 2's tables (Costco 3/7 plan v5 §5, §6.1, §7, §8, §10): the worklist read from stored lines,
// the plan, the import's writes, and the vocabularies pinned to their one source. Synthetic rows only, in-memory.

const here = path.dirname(fileURLToPath(import.meta.url));
const GO = Object.freeze({ kind: 'go' as const, goId: '7e'.repeat(16), purpose: 'copy-rehearsal' });
let db: Database.Database;
let decisions = 0;

beforeEach(() => { db = retailTestDb(); });
afterEach(() => { db.close(); });

const product = (itemNumber: string) => retailProductKey('costco', itemNumber);
const department = (number: number) => retailDepartmentKey('costco', number);
/** A mapping file's value, its entries sorted as the format requires, under a fresh decision each time. */
const mappingOf = (entries: RetailTaxonomyEntry[]) => retailTaxonomyMappingOf({ format: RETAIL_TAXONOMY_MAPPING_FORMAT, version: 1, taxonomyVersion: 2,
  reviewed: true, decisionId: (++decisions).toString(16).padStart(32, '0'),
  entries: [...entries].sort((a, b) => (`${a.subjectKind} ${a.subjectKey} ${a.source}` < `${b.subjectKind} ${b.subjectKey} ${b.source}` ? -1 : 1)) });
/**
 * The SQLite constraint `fn` meets, as its code and message, or `none`. Only that declared hold type is caught; anything
 * else is re-thrown unchanged (addendum 3(e)).
 */
const constraintOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof Database.SqliteError && error.code.startsWith('SQLITE_CONSTRAINT')) return `${error.code}: ${error.message}`;
    throw error;
  }
  return 'none';
};
/** Plans a mapping and imports it, as `taxonomy import` does under its fence. */
function importMapping(entries: RetailTaxonomyEntry[]): RetailTaxonomyImportReceipt {
  const mapping = mappingOf(entries);
  const mappingSha256 = createHash('sha256').update(serializeRetailTaxonomyMapping(mapping)).digest('hex');
  const plan = planRetailTaxonomyImport(db, mapping, mappingSha256);
  return importRetailTaxonomy(db, mapping, { now: RETAIL_TEST_NOW, authority: GO, mappingSha256, planDigest: plan.planDigest });
}
const owner = (itemNumber: string, node: string | null): RetailTaxonomyEntry =>
  ({ subjectKind: 'product', subjectKey: product(itemNumber), source: 'owner', node: node as RetailTaxonomyEntry['node'], confidenceBp: null });
const reviewed = (number: number, node: string | null): RetailTaxonomyEntry =>
  ({ subjectKind: 'department', subjectKey: department(number), source: 'department-review', node: node as RetailTaxonomyEntry['node'], confidenceBp: null });

/**
 * Receipts whose lines exercise the counting unit: product 100100 in departments 12 and 14 and online (no department),
 * with a coupon of its own item number; a line without an item number; a title-rule gold line; an online fee; a fuel
 * line; and product 100103, seen only in a version that isn't canonical.
 */
function seedReceipts(): void {
  importPayload(db, syntheticRetailPayload({
    receipts: [
      warehouseReceipt(1, { lines: [
        warehouseLine(0, 1_000, { itemNumber: '100100', department: 12 }),
        warehouseLine(1, 1_000, { itemNumber: '100100', department: 12, title2: 'SAMPLE GADGET' }),
        warehouseLine(2, 1_000, { itemNumber: '100100', department: 14 }),
        warehouseLine(3, -100, { kind: 'coupon', itemNumber: '300001', title: null, department: 12, couponTarget: 0, unitPriceMinor: null, taxFlag: null }),
        warehouseLine(4, 500, { itemNumber: null, department: 12 }),
        warehouseLine(5, 2_000, { itemNumber: '100102', department: 17, title: 'SAMPLE BULLION BAR', metal: goldBar() }),
      ] }),
      onlineOrder(2, { lines: [
        onlineLine(2, 0, 5_000, { itemNumber: '100100' }),
        onlineLine(2, 1, 300, { kind: 'fee', itemNumber: '100104', feeParent: 0, title: 'SAMPLE FEE' }),
      ] }),
      { ...warehouseReceipt(3, { lines: [warehouseLine(0, 4_000, { kind: 'fuel', itemNumber: '100105', department: null, unitPriceMinor: null,
        fuelGallons: '10.5', fuelUnitPrice: '3.9', title: 'SAMPLE FUEL' })] }), channel: 'gas' },
    ],
  }));
  // Receipt 1 read again with a line more: quarantined, its first version still canonical, the new line not counted.
  importPayload(db, syntheticRetailPayload({ capture: 'c', receipts: [warehouseReceipt(1, { lines: [
    warehouseLine(0, 1_000, { itemNumber: '100100', department: 12 }),
    warehouseLine(1, 1_000, { itemNumber: '100100', department: 12, title2: 'SAMPLE GADGET' }),
    warehouseLine(2, 1_000, { itemNumber: '100100', department: 14 }),
    warehouseLine(3, -100, { kind: 'coupon', itemNumber: '300001', title: null, department: 12, couponTarget: 0, unitPriceMinor: null, taxFlag: null }),
    warehouseLine(4, 500, { itemNumber: null, department: 12 }),
    warehouseLine(5, 2_000, { itemNumber: '100102', department: 17, title: 'SAMPLE BULLION BAR', metal: goldBar() }),
    warehouseLine(6, 700, { itemNumber: '100103', department: 12 }),
  ] })] }));
}

describe('retail taxonomy worklist from stored lines (§5, §6.1, D-T1-3)', () => {
  it('lists every department a product\'s counted lines fall under, and none, and keeps current the product-level resolution', () => {
    seedReceipts();
    const listed = (worklist: ReturnType<typeof retailTaxonomyWorklist>, itemNumber: string) =>
      worklist.products.find((entry) => entry.itemNumber === itemNumber);
    const before = retailTaxonomyWorklist(db);
    expect(listed(before, '100100')?.byDepartment).toEqual([{ department: 12, lines: 2, reviewed: null }, { department: 14, lines: 1, reviewed: null },
      { department: null, lines: 1, reviewed: null }]);
    importMapping([reviewed(12, 'home-kitchen'), reviewed(14, 'dining')]);
    const after = retailTaxonomyWorklist(db);
    expect(listed(after, '100100')?.current).toEqual({ node: RESIDUAL, source: null, confidenceBp: null, suggested: false, suggestion: null });
    expect(listed(after, '100100')?.byDepartment).toEqual([{ department: 12, lines: 2, reviewed: 'home-kitchen' },
      { department: 14, lines: 1, reviewed: 'dining' }, { department: null, lines: 1, reviewed: null }]);
    importMapping([owner('100100', 'groceries')]);
    expect(listed(retailTaxonomyWorklist(db), '100100')?.current).toEqual({ node: 'groceries', source: 'owner', confidenceBp: null, suggested: false,
      suggestion: null });
  });

  it('counts item, fee and fuel lines of canonical versions only: never a coupon, never another version\'s line', () => {
    seedReceipts();
    const worklist = retailTaxonomyWorklist(db);
    expect(worklist.products.map((entry) => [entry.itemNumber, entry.lines, entry.titleRuleLines, entry.channels]).sort()).toEqual([
      ['100100', 4, 0, ['online', 'warehouse']], ['100102', 1, 1, ['warehouse']], ['100103', 0, 0, ['warehouse']], ['100104', 1, 0, ['online']],
      ['100105', 1, 0, ['gas']],
    ]);
    expect(worklist.products.find((entry) => entry.itemNumber === '100100')?.titles).toEqual([
      { title: 'SAMPLE GADGET', title2: null }, { title: 'SAMPLE WIDGET', title2: 'SAMPLE GADGET' }, { title: 'SAMPLE WIDGET', title2: null }]);
    expect(worklist.departments.map((entry) => [entry.department, entry.lines, entry.products, entry.current]).sort()).toEqual([
      [12, 3, 1, null], [14, 1, 1, null], [17, 1, 1, null]]);
    expect(worklist.coverage).toEqual({ withProduct: 7, withoutProduct: 1, titleRule: 1 });
    expect(worklist.products.map((entry) => entry.subjectKey)).toEqual([...worklist.products.map((entry) => entry.subjectKey)].sort());
    expect(worklist.products.some((entry) => entry.itemNumber === '300001')).toBe(false);
  });
});

describe('retail taxonomy plan and import on PR 2\'s tables (§7.3, §7.4, §8)', () => {
  it('writes one import row, its rows and one audit row, and nothing else in any retail table', () => {
    seedReceipts();
    const count = () => Object.fromEntries(RETAIL_TABLES.map((table) => [table, rows(db, `SELECT count(*) FROM ${table}`)]));
    const before = count();
    const entries = [reviewed(12, 'home-kitchen'), owner('100100', 'groceries'),
      { subjectKind: 'product', subjectKey: product('100102'), source: 'agent', node: ASSET, confidenceBp: 6_500 } as RetailTaxonomyEntry];
    const receipt = importMapping(entries);
    expect(count()).toEqual({ ...before, retail_taxonomy_imports: before.retail_taxonomy_imports + 1,
      retail_taxonomy_assignments: before.retail_taxonomy_assignments + 3, retail_audit: before.retail_audit + 1 });
    expect(receipt).toMatchObject({ code: 'retail-taxonomy-imported', seq: 1, taxonomyImportId: expect.stringMatching(/^rtl-tax-[a-p]{32}$/) });
    expect(db.prepare(`SELECT seq, taxonomy_version AS version, go_id AS go, purpose, imported_at AS at FROM retail_taxonomy_imports`).get())
      .toEqual({ seq: 1, version: RETAIL_TAXONOMY_STORED_VERSION, go: retailLetters(GO.goId), purpose: 'copy-rehearsal', at: RETAIL_TEST_NOW });
    expect(db.prepare(`SELECT kind, input_sha256 AS input, plan_digest AS plan, go_id AS go, purpose FROM retail_audit ORDER BY seq DESC LIMIT 1`).get())
      .toEqual({ kind: 'taxonomy-import', input: db.prepare('SELECT mapping_sha256 FROM retail_taxonomy_imports').pluck().get(),
        plan: retailLetters(receipt.plan!.planDigest), go: retailLetters(GO.goId), purpose: 'copy-rehearsal' });
    expect(db.prepare(`SELECT subject_kind AS kind, source, node, confidence_bp AS bp FROM retail_taxonomy_assignments ORDER BY subject_kind, source`).all())
      .toEqual([{ kind: 'department', source: 'department-review', node: 'home-kitchen', bp: null }, { kind: 'product', source: 'agent', node: ASSET, bp: 6_500 },
        { kind: 'product', source: 'owner', node: 'groceries', bp: null }]);
  });

  it('keeps every import\'s rows, append-only, and selects the latest per source, a withdrawal included', () => {
    seedReceipts();
    importMapping([owner('100100', 'groceries'), { ...owner('100100', 'household'), source: 'agent', confidenceBp: ITEM_TAXONOMY_BP_SCALE }]);
    const second = importMapping([owner('100100', null)]);
    expect(second.plan!.actions).toEqual({ insert: 0, replace: 0, withdraw: 1, unchanged: 0 });
    expect(rows(db, 'SELECT count(*) FROM retail_taxonomy_assignments')).toBe(3);
    expect(retailTaxonomyWorklist(db).products.find((entry) => entry.itemNumber === '100100')?.current).toEqual({ node: 'household', source: 'agent',
      confidenceBp: ITEM_TAXONOMY_BP_SCALE, suggested: false, suggestion: null });
    expect(constraintOf(() => db.prepare(`UPDATE retail_taxonomy_assignments SET node = 'garden-patio'`).run())).toMatch(/append-only/);
    expect(constraintOf(() => db.prepare('DELETE FROM retail_taxonomy_imports').run())).toMatch(/append-only/);
  });

  it('refuses a mapping naming a subject no stored line makes known, a coupon\'s own item number included, whole', () => {
    seedReceipts();
    for (const entries of [[owner('100100', 'groceries'), owner('100199', 'groceries')], [owner('300001', 'groceries')], [reviewed(55, 'dining')]]) {
      expect(refusalOf(() => planRetailTaxonomyImport(db, mappingOf(entries), 'a'.repeat(64)))).toMatchObject({ code: 'retail-taxonomy-subject-unknown',
        details: { subjects: 1 } });
    }
  });

  it('plans read-only: through a query_only handle, and reads a quarantined version\'s product as known', () => {
    seedReceipts();
    db.pragma('query_only = ON');
    const plan = planRetailTaxonomyImport(db, mappingOf([owner('100103', 'garden-patio')]), 'b'.repeat(64));
    db.pragma('query_only = OFF');
    expect(plan).toMatchObject({ entries: 1, actions: { insert: 1, replace: 0, withdraw: 0, unchanged: 0 }, planDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(plan.counters.products).toMatchObject({ total: 5, assigned: 1 });
  });

  it('needs a GO of its own purposes: never the preview, never another command\'s purpose', () => {
    seedReceipts();
    const mapping = mappingOf([owner('100100', 'groceries')]);
    const plan = planRetailTaxonomyImport(db, mapping, 'c'.repeat(64));
    const context = (authority: object) => ({ now: RETAIL_TEST_NOW, authority, mappingSha256: 'c'.repeat(64), planDigest: plan.planDigest }) as
      Parameters<typeof importRetailTaxonomy>[2];
    expect(refusalOf(() => importRetailTaxonomy(db, mapping, context({ kind: 'preview' }))).code).toBe('retail-go-id-invalid');
    expect(refusalOf(() => importRetailTaxonomy(db, mapping, context({ ...GO, purpose: 'production-import' }))).code).toBe('retail-purpose-invalid');
    expect(refusalOf(() => importRetailTaxonomy(db, mapping, context({ ...GO, purpose: 'production-taxonomy' }))).code).toBe('none');
    expect(rows(db, 'SELECT count(*) FROM retail_taxonomy_imports')).toBe(1);
  });
});

describe('retail taxonomy: the card-category residual (§4.4)', () => {
  it('lists the node categories the card data lacks, never the asset node\'s', () => {
    db.exec('CREATE TABLE card_transactions (user_category TEXT, issuer_category TEXT)');
    const used = ITEM_TAXONOMY_V2_VIEW.cardCategories.filter((category) => category !== CARD_ASSET_CATEGORY
      && category !== ITEM_TAXONOMY_V2_VIEW.node('automotive/fuel')!.cardCategory);
    const insert = db.prepare('INSERT INTO card_transactions (user_category, issuer_category) VALUES (NULL, ?)');
    for (const category of used) insert.run(category);
    expect(retailTaxonomyCategoriesMissing(db)).toEqual({ count: 1, nodes: ['automotive/fuel'] });
    expect(ITEM_TAXONOMY_V2_VIEW.node(ASSET)?.cardCategory).toBe(CARD_ASSET_CATEGORY);
  });

  it('lists every node category but the asset node\'s when the card tables are absent', () => {
    const missing = retailTaxonomyCategoriesMissing(db);
    expect(missing.nodes).not.toContain(ASSET);
    expect(missing.nodes).toEqual(ITEM_TAXONOMY_V2_VIEW.nodes.filter((node) => node.id !== ASSET).map((node) => node.id));
  });
});

describe('retail taxonomy vocabularies: one source each, pinned (§2.2)', () => {
  const statement = (table: string) => RETAIL_SCHEMA_SQL.find((sql) => sql.startsWith(`CREATE TABLE ${table} `))!;
  const listed = (sql: string, column: string) => [...new RegExp(`\\b${column} IN \\(([^)]*)\\)`).exec(sql)![1].matchAll(/'([^']*)'/g)].map((match) => match[1]);

  it('pins the sources, subject kinds, confidence bound and purposes to PR 2\'s CHECKs, and PR 2\'s schema digest unchanged', () => {
    expect([...RETAIL_TAXONOMY_SOURCES]).toEqual(['owner', 'agent', 'department-review']);
    expect(RETAIL_TAXONOMY_SOURCES.slice(0, ITEM_TAXONOMY_SOURCES.length)).toEqual([...ITEM_TAXONOMY_SOURCES]);
    expect(listed(statement('retail_taxonomy_assignments'), 'source')).toEqual([...RETAIL_TAXONOMY_SOURCES]);
    expect([...RETAIL_TAXONOMY_SUBJECT_KINDS]).toEqual(['product', 'department']);
    expect(listed(statement('retail_taxonomy_assignments'), 'subject_kind')).toEqual([...RETAIL_TAXONOMY_SUBJECT_KINDS]);
    expect(RETAIL_CONFIDENCE_BP_MAX).toBe(ITEM_TAXONOMY_BP_SCALE);
    expect(/confidence_bp BETWEEN 0 AND (\d+)/.exec(statement('retail_taxonomy_assignments'))![1]).toBe(String(RETAIL_CONFIDENCE_BP_MAX));
    expect(RETAIL_PURPOSES['taxonomy-import']).toEqual(['copy-rehearsal', 'production-taxonomy']);
    expect(listed(statement('retail_taxonomy_imports'), 'purpose')).toEqual([...RETAIL_PURPOSES['taxonomy-import']]);
    expect(RETAIL_SCHEMA_DIGEST).toBe('b8931702e3cbb48efb37865749f9e1b330e221d4c0d17dc8e77979c0f6649bb1');
  });

  it('pins the formats, versions, counted line kinds and the file bound', () => {
    expect([RETAIL_TAXONOMY_WORKLIST_FORMAT, RETAIL_TAXONOMY_ASSIGNMENTS_FORMAT, RETAIL_TAXONOMY_MAPPING_FORMAT]).toEqual([
      'holdr.retail-taxonomy-worklist', 'holdr.retail-taxonomy-assignments', 'holdr.retail-taxonomy-mapping']);
    expect([RETAIL_TAXONOMY_VERSION, RETAIL_TAXONOMY_STORED_VERSION]).toEqual([2, 'taxonomy-v2']);
    expect([...RETAIL_TAXONOMY_LINE_KINDS]).toEqual(['item', 'fee', 'fuel']);
    expect(RETAIL_TAXONOMY_FILE_MAX_BYTES).toBe(16 * 1024 * 1024);
  });

  it('keeps the retail taxonomy modules out of the API\'s boot, routes, Spending and the web: only the receipts read model loads one, the resolver (§9, Costco M1)', () => {
    const modules = fs.readdirSync(here).filter((name) => /^taxonomy[A-Z]\w*\.ts$/.test(name)).sort();
    expect(modules).toEqual(['taxonomyFiles.ts', 'taxonomyFormats.ts', 'taxonomyImport.ts', 'taxonomyPlan.ts', 'taxonomyResolver.ts', 'taxonomyWorklist.ts']);
    const api = path.join(here, '..', '..');
    const relative = (file: string) => path.relative(api, file).split(path.sep).join('/');
    const specifiers = /^\s*(?:import|export)\s[^'";]*?\bfrom\s*'([^']+)'|\bimport\(\s*'([^']+)'\s*\)/gm;
    /** A file's relative imports (type-only ones included) that resolve to the domain's index or a taxonomy module. */
    const taxonomyImports = (file: string, text: string) => [...text.matchAll(specifiers)].map((match) => match[1] ?? match[2])
      .filter((specifier) => specifier.startsWith('.')
        && /^services\/retail\/(?:index|taxonomy[A-Z]\w*)\.js$/.test(relative(path.resolve(path.dirname(file), specifier))));
    const importers = [...walk(api)].filter((file) => !file.includes(`${path.sep}services${path.sep}retail${path.sep}`) && !/\.test\.ts$/.test(file))
      .filter((file) => {
        const text = fs.readFileSync(file, 'utf8');
        return /services\/retail\/(?:index|taxonomy[A-Z]\w*)\.js/.test(text) || taxonomyImports(file, text).length > 0;
      });
    // The CLI and the tests' helpers; and the receipts read model, the API's one reader, through the resolver alone (never
    // the domain's index with its writers, nor the taxonomy's files, plan, import or worklist).
    expect(importers.map(relative).sort()).toEqual(['cli/retail.ts', 'cli/retailReport.ts', 'services/retailRead/receipts.ts', 'testing/retailDb.ts']);
    const readModel = path.join(api, 'services', 'retailRead', 'receipts.ts');
    expect(taxonomyImports(readModel, fs.readFileSync(readModel, 'utf8'))).toEqual(['../retail/taxonomyResolver.js']);
    const web = path.join(api, '..', '..', 'web', 'src');
    expect([...walk(web)].length).toBeGreaterThan(20);
    expect([...walk(web)].filter((file) => /services\/retail|retail-taxonomy|retailTaxonomy/.test(fs.readFileSync(file, 'utf8')))).toEqual([]);
  });
});

/** Every TypeScript file under a directory. */
function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(target);
    else if (/\.tsx?$/.test(entry.name)) yield target;
  }
}
