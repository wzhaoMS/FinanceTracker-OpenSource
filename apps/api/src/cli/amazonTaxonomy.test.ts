import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { AMAZON_TAXONOMY_NODES } from '@finance-tracker/shared';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { AMAZON_TAXONOMY_CLI_USAGE, runAmazonTaxonomyCli } from './amazonTaxonomy.js';
import { backedUpWrite, importAmazonCapture } from '../services/amazon/importer.js';
import { syntheticCapture, withSyntheticItems } from '../services/amazon/fixtures.testSupport.js';
import { digest } from '../services/amazon/policy.js';
import { productKey } from '../services/amazon/products.js';
import {
  AMAZON_TAXONOMY_DIGEST, AMAZON_TAXONOMY_MAPPING_FORMAT, AMAZON_TAXONOMY_SCHEMA_DIGEST, applyTaxonomyMapping, hasAmazonTaxonomySchema,
  installAmazonTaxonomySchema, planTaxonomyImport, readTaxonomyAssignments, taxonomyAdoptionStale,
} from '../services/amazon/taxonomy.js';
import { AMAZON_TAXONOMY_ASSIGNMENTS_FORMAT } from '../services/amazon/taxonomyAdapter.js';
import { readCurrentUserSid, restrictToUser } from '../e2e/windowsAcl.js';
import { amazonTaxonomySpending } from '../services/amazon/taxonomySpending.js';
// STEP 9 integration B7a (#168 x #171): the wiring regression reads both key-change lists.
import { categoryKeyAdoptions } from '../services/amazon/ownerDecisions.js';
import { taxonomyKeyChanges } from '../services/amazon/taxonomyKeyAdoptions.js';

// Synthetic only: made-up ASINs (SYNTH00001...), titles and order IDs, in private temporary directories.
let dir: string, file: string, stdout: string, stderr: string;
const capture = withSyntheticItems(syntheticCapture(), 3);
const items = capture.staging.orders[0].items;
const KEYS = items.map(i => productKey({ asin: i.itemId, title: i.title }));
const run = (args: string[]) => runAmazonTaxonomyCli(args, {
  env: { ...process.env, HOLDR_CONFIG: 'none' }, now: () => new Date('2026-10-21T00:00:00Z'),
  io: { stdout: { write: (s: string) => { stdout += s; } }, stderr: { write: (s: string) => { stderr += s; } } },
});
const json = (name: string, value: unknown) => { const p = path.join(dir, name); fs.writeFileSync(p, JSON.stringify(value)); return p; };
const answer = async (args: string[], code = 0) => {
  stdout = ''; stderr = '';
  expect(await run(args), stderr).toBe(code);
  return code === 0 ? JSON.parse(stdout) : stderr;
};
const mapping = (entries: unknown[]) => ({ format: AMAZON_TAXONOMY_MAPPING_FORMAT, version: 1, taxonomyVersion: 1, reviewed: true, entries });
const go = (input: unknown, patch: Record<string, unknown> = {}) => json(`go-${digest(patch).slice(0, 8)}.json`, {
  format: 'holdr.amazon-taxonomy-go', version: 1, authority: 'Root', decision: 'GO', purpose: 'copy-rehearsal', command: 'import',
  databaseRef: digest(path.resolve(file)), mappingDigest: digest(input), taxonomyDigest: AMAZON_TAXONOMY_DIGEST,
  schemaDigest: AMAZON_TAXONOMY_SCHEMA_DIGEST, ...patch,
});
const opened = <T>(fn: (db: Database.Database) => T) => {
  const db = new Database(file, { readonly: true });
  try { return fn(db); } finally { db.close(); }
};
/** Nothing private reaches the terminal: no title, ASIN, product key, order ID or path. */
const expectValueFree = (text: string) => {
  for (const value of [...items.flatMap(i => [i.itemId!, i.title]), ...KEYS, capture.staging.orders[0].orderId, dir, 'Synthetic']) {
    expect(text).not.toContain(value);
  }
};
// A second synthetic order, read first without the kettle's ASIN and then with it: the displayed line has a new key.
const KETTLE_SEEN = { asin: null, title: 'Synthetic travel kettle' }, KETTLE = { asin: 'SYNTHKTL01', title: KETTLE_SEEN.title };
const KETTLE_ORDER = '000-0000002-0000002', KETTLE_NODE = 'home-kitchen/small-appliances';
async function rereadKettle() {
  const read = (asin: string | null, run: number) => {
    const reread = syntheticCapture();
    const order = reread.staging.orders[0];
    order.orderId = KETTLE_ORDER;
    order.items[0] = { ...order.items[0], itemId: asin, title: KETTLE.title };
    reread.staging.runId = `00000000-0000-4000-8000-00000000010${run}`;
    return reread;
  };
  const repo = new SqliteStateRepo({ file });
  try {
    await importAmazonCapture(repo.internalGetDb(), read(null, 1), path.join(dir, 'reread-backup-1.db'));
    await importAmazonCapture(repo.internalGetDb(), read(KETTLE.asin, 2), path.join(dir, 'reread-backup-2.db'));
  } finally { repo.close(); }
}
const expectKettleFree = (text: string) => {
  expectValueFree(text);
  for (const value of [KETTLE.asin, KETTLE.title, productKey(KETTLE), productKey(KETTLE_SEEN), KETTLE_ORDER]) expect(text).not.toContain(value);
};
beforeEach(async () => {
  stdout = ''; stderr = '';
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-taxonomy-cli-synthetic-')));
  if (process.platform === 'win32') restrictToUser(dir, readCurrentUserSid());
  else fs.chmodSync(dir, 0o700);
  file = path.join(dir, 'finance.db');
  const repo = new SqliteStateRepo({ file });
  try { await importAmazonCapture(repo.internalGetDb(), structuredClone(capture), path.join(dir, 'import-backup.db')); }
  finally { repo.close(); }
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('Amazon item taxonomy operator CLI', () => {
  it('writes the classifier a private worklist, read-only, and prints counts only', async () => {
    expect(await run(['--help'])).toBe(0);
    expect(stdout).toBe(AMAZON_TAXONOMY_CLI_USAGE);
    const before = fs.readFileSync(file);
    const output = path.join(dir, 'worklist.json');
    const printed = await answer(['worklist', '--db', file, '--output', output]);
    // Keyless holds (Root, after STEP 9): counts only, by family and reason; none here.
    const none = { 'ambiguous-match': 0, 'card-data-guard': 0 };
    expect(printed).toEqual({ code: 'taxonomy-worklist-written', products: 3, assigned: 0, needsReview: 3, adoptions: 0,
      keylessHolds: { ordinary: none, fresh: none },
      coverage: { itemObservations: 3, classifiableObservations: 3, heldTitleObservations: 0 }, taxonomyDigest: AMAZON_TAXONOMY_DIGEST });
    expectValueFree(stdout);
    expect(fs.readFileSync(file)).toEqual(before);
    const worklist = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(worklist.keylessHolds).toEqual([]);
    expect(worklist.products.map((p: { productKey: string }) => p.productKey)).toEqual([...KEYS].sort());
    expect(worklist.products.every((p: { adoptFrom: unknown }) => p.adoptFrom === null)).toBe(true);
    expect(worklist.taxonomy).toHaveLength(AMAZON_TAXONOMY_NODES.length);
    // An existing output, a relative path or a stray option refuses, without a value in the error.
    for (const args of [['worklist', '--db', file, '--output', output], ['worklist', '--db', 'finance.db', '--output', path.join(dir, 'w2.json')],
      ['worklist', '--db', file], ['worklist', '--db', file, '--output', path.join(dir, 'w3.json'), '--extra', file], ['classify', '--db', file]]) {
      expect(await run(args)).toBe(1);
    }
    expectValueFree(stderr);
  });

  it('adopts the classifier\'s assignments file as a mapping: by node id or v1 label, its card fields ignored', async () => {
    const record = (key: string, taxonomy: unknown, confidence: number, extra: Record<string, unknown> = {}) => ({ productKey: key,
      asin: null, taxonomy, taxonomyConfidence: confidence, cardCategory: 'Merchandise & Supplies-Groceries', cardCategoryConfidence: 0.9,
      previous: null, disagreement: false, ...extra });
    const assignments = (products: unknown[], patch: Record<string, unknown> = {}) => ({ format: AMAZON_TAXONOMY_ASSIGNMENTS_FORMAT,
      taxonomyVersion: 'v1', generatedAt: '2026-10-21T00:00:00Z', inputs: { 'synthetic-products.json': digest('synthetic') }, products, ...patch });
    const input = json('assignments.json', assignments([
      record(KEYS[0], { top: 'Electronics', sub: 'Cables Chargers & Batteries' }, 0.93, { asin: items[0].itemId }),
      record(KEYS[1], { top: 'toys-hobbies', sub: 'toys-hobbies/3d-printing' }, 0.7, { asin: items[1].itemId, title: items[1].title }),
      record(KEYS[2], { top: 'Household Supplies', sub: null }, 0.5),
    ]));
    const output = path.join(dir, 'mapping.json');
    const printed = await answer(['adopt', '--input', input, '--output', output]);
    const written = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(written).toEqual(mapping([
      { productKey: KEYS[0], node: 'electronics/cables-chargers-batteries', confidence: 0.93, source: 'agent' },
      { productKey: KEYS[1], node: 'toys-hobbies/3d-printing', confidence: 0.7, source: 'agent' },
      { productKey: KEYS[2], node: 'household', confidence: 0.5, source: 'agent' },
    ]));
    expect(printed).toEqual({ code: 'taxonomy-mapping-written-not-imported', entries: 3, assigned: 2, suggested: 1, needsReview: 1, topLevel: 0,
      mappingDigest: digest(written) });
    expectValueFree(stdout);
    // Review regression: counted exactly as reads resolve them. An agent's own Needs review, at 0.6–0.8 too, is neither
    // assigned nor suggested; a top level counts only when an item is filed there.
    const reviewed = json('assignments-review.json', assignments([
      record(KEYS[0], { top: 'Needs review', sub: null }, 0.7),
      record(KEYS[1], { top: 'electronics', sub: null }, 0.7),
      record(KEYS[2], { top: 'needs-review', sub: null }, 0.9),
    ]));
    expect(await answer(['adopt', '--input', reviewed, '--output', path.join(dir, 'mapping-review.json')])).toMatchObject({
      entries: 3, assigned: 1, suggested: 1, needsReview: 2, topLevel: 1 });
    const refused: Array<[string, unknown]> = [
      ['format', assignments([], { format: AMAZON_TAXONOMY_MAPPING_FORMAT })], ['version', assignments([], { taxonomyVersion: 1 })],
      ['unknown top', assignments([record(KEYS[0], { top: 'Groceries & Stuff', sub: null }, 0.9)])],
      ['sub of another top', assignments([record(KEYS[0], { top: 'Groceries', sub: 'Networking' }, 0.9)])],
      ['no sub key', assignments([record(KEYS[0], { top: 'Groceries' }, 0.9)])],
      ['percent confidence', assignments([record(KEYS[0], { top: 'Groceries', sub: null }, 93)])],
      ['repeated product', assignments([record(KEYS[0], { top: 'Groceries', sub: null }, 0.9), record(KEYS[0], { top: 'Electronics', sub: null }, 0.9)])],
      ['unknown field', assignments([record(KEYS[0], { top: 'Groceries', sub: null }, 0.9, { note: 'x' })])],
      ['malformed asin', assignments([record(KEYS[0], { top: 'Groceries', sub: null }, 0.9, { asin: 'b0' })])],
      ['title of another product', assignments([record(KEYS[0], { top: 'Groceries', sub: null }, 0.9, { asin: items[1].itemId, title: items[1].title })])],
    ];
    for (const [what, value] of refused) {
      expect(await run(['adopt', '--input', json(`refused-${digest(what).slice(0, 8)}.json`, value), '--output', path.join(dir, `m-${digest(what).slice(0, 8)}.json`)]), what).toBe(1);
    }
    expectValueFree(stderr);
  });

  it('plans read-only against the database, refusing products it doesn\'t know', async () => {
    const input = mapping([{ productKey: KEYS[0], node: 'electronics', confidence: 0.9, source: 'agent' }]);
    const before = fs.readFileSync(file);
    const printed = await answer(['plan', '--db', file, '--input', json('mapping.json', input)]);
    expect(printed).toMatchObject({ code: 'taxonomy-planned', schema: 'absent', entries: 1, agent: 1, owner: 0, insert: 1, update: 0,
      unchanged: 0, products: 3, assignedAfter: 1, needsReviewAfter: 2, mappingDigest: digest(input), taxonomyDigest: AMAZON_TAXONOMY_DIGEST,
      schemaDigest: AMAZON_TAXONOMY_SCHEMA_DIGEST, databaseRef: digest(path.resolve(file)) });
    expect(printed.cardCategoriesMissing).toEqual(expect.any(Array));
    expectValueFree(stdout);
    expect(fs.readFileSync(file)).toEqual(before);
    const unknown = mapping([{ productKey: digest('synthetic unknown'), node: 'electronics', confidence: 0.9, source: 'agent' }]);
    expect(await answer(['plan', '--db', file, '--input', json('unknown.json', unknown)], 1)).toBe('amazon-taxonomy: input-refused HoldrRefusal\n');
  });

  it('refuses every unauthorized import before any backup or write', async () => {
    const input = mapping([{ productKey: KEYS[0], node: 'electronics', confidence: 0.9, source: 'agent' }]);
    const mappingFile = json('mapping.json', input), backup = path.join(dir, 'never.db');
    const before = fs.readFileSync(file);
    const variants: Array<[string, string[]]> = [
      ['no GO', ['import', '--db', file, '--input', mappingFile, '--backup', backup]],
      ['relative backup', ['import', '--db', file, '--input', mappingFile, '--backup', 'never.db', '--root-go', go(input)]],
      ['existing backup', ['import', '--db', file, '--input', mappingFile, '--backup', mappingFile, '--root-go', go(input)]],
      ...([
        ['image GO', { format: 'holdr.amazon-image-go' }], ['version', { version: 2 }], ['authority', { authority: 'Mac' }],
        ['decision', { decision: 'NO-GO' }], ['purpose', { purpose: 'production-backfill' }], ['command', { command: 'plan' }],
        ['database', { databaseRef: digest(path.resolve(dir, 'other.db')) }], ['mapping', { mappingDigest: digest('another mapping') }],
        ['taxonomy', { taxonomyDigest: digest('another taxonomy') }], ['schema', { schemaDigest: digest('another schema') }],
        ['extra field', { goId: '0'.repeat(32) }],
        // Review regression: values that only match once coerced (an array holding the string, a numeric string).
        ['array purpose', { purpose: ['copy-rehearsal'] }], ['nested array purpose', { purpose: [['production-import']] }],
        ['object purpose', { purpose: { toString: 'copy-rehearsal' } }], ['null purpose', { purpose: null }],
        ['string version', { version: '1' }], ['array version', { version: [1] }], ['array authority', { authority: ['Root'] }],
        ['array decision', { decision: ['GO'] }], ['array command', { command: ['import'] }], ['array format', { format: ['holdr.amazon-taxonomy-go'] }],
        ['array database', { databaseRef: [digest(path.resolve(file))] }], ['array mapping', { mappingDigest: [digest(input)] }],
        ['array taxonomy', { taxonomyDigest: [AMAZON_TAXONOMY_DIGEST] }], ['array schema', { schemaDigest: [AMAZON_TAXONOMY_SCHEMA_DIGEST] }],
      ] as Array<[string, Record<string, unknown>]>).map(([what, patch]): [string, string[]] =>
        [what, ['import', '--db', file, '--input', mappingFile, '--backup', backup, '--root-go', go(input, patch)]]),
      ['unknown product', ['import', '--db', file, '--input', json('unknown.json', mapping([{ productKey: digest('x'), node: 'electronics',
        confidence: 0.9, source: 'agent' }])), '--backup', backup, '--root-go', go(mapping([{ productKey: digest('x'), node: 'electronics',
        confidence: 0.9, source: 'agent' }]))]],
    ];
    for (const [what, args] of variants) {
      stderr = '';
      expect(await run(args), what).toBe(1);
      expect(stderr, what).toMatch(/^amazon-taxonomy: input-refused HoldrRefusal\n$/);
    }
    expect(fs.existsSync(backup)).toBe(false);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(opened(db => hasAmazonTaxonomySchema(db))).toBe(false);
    // The GO is checked before any database is opened: pinned to a database that doesn't exist, a coerced purpose is a
    // refusal, not a failed open, and nothing is created there.
    const absent = path.join(dir, 'absent.db');
    stderr = '';
    expect(await run(['import', '--db', absent, '--input', mappingFile, '--backup', backup, '--root-go',
      go(input, { purpose: ['copy-rehearsal'], databaseRef: digest(path.resolve(absent)) })])).toBe(1);
    expect(stderr).toBe('amazon-taxonomy: input-refused HoldrRefusal\n');
    expect(fs.existsSync(absent)).toBe(false);
    expect(fs.existsSync(backup)).toBe(false);
  });

  it('imports after a new backup, installing the table once; a re-import changes nothing and the owner wins', async () => {
    const first = mapping([{ productKey: KEYS[0], node: 'electronics/cables-chargers-batteries', confidence: 0.93, source: 'agent' },
      { productKey: KEYS[2], node: 'household', confidence: 0.5, source: 'agent' }]);
    const firstFile = json('first.json', first);
    expect(await answer(['import', '--db', file, '--input', firstFile, '--backup', path.join(dir, 'backup-1.db'), '--root-go', go(first)]))
      .toEqual({ code: 'taxonomy-imported', insert: 2, update: 0, unchanged: 0, mappingDigest: digest(first), taxonomyDigest: AMAZON_TAXONOMY_DIGEST });
    expectValueFree(stdout);
    // The backup is the database before the write: no assignment table yet.
    const backup = new Database(path.join(dir, 'backup-1.db'), { readonly: true });
    try { expect(hasAmazonTaxonomySchema(backup)).toBe(false); } finally { backup.close(); }
    expect(opened(db => readTaxonomyAssignments(db))).toEqual(new Map([
      [KEYS[0], { node: 'electronics/cables-chargers-batteries', source: 'agent', confidence: 0.93 }],
      [KEYS[2], { node: 'household', source: 'agent', confidence: 0.5 }],
    ]));
    expect((await answer(['import', '--db', file, '--input', firstFile, '--backup', path.join(dir, 'backup-2.db'), '--root-go', go(first)])))
      .toMatchObject({ insert: 0, update: 0, unchanged: 2 });
    const ownerChoice = mapping([{ productKey: KEYS[0], node: 'office-school/printers-ink-paper', confidence: 1, source: 'owner' }]);
    expect(await answer(['import', '--db', file, '--input', json('owner.json', ownerChoice), '--backup', path.join(dir, 'backup-3.db'),
      '--root-go', go(ownerChoice)])).toMatchObject({ insert: 1, update: 0, unchanged: 0 });
    expect(opened(db => readTaxonomyAssignments(db).get(KEYS[0]))).toEqual({ node: 'office-school/printers-ink-paper', source: 'owner', confidence: 1 });
    expect(opened(db => db.prepare("SELECT count(*) FROM amazon_audit WHERE action='taxonomy-import'").pluck().get())).toBe(3);
  });

  it('adopts the keys a re-read learned (adopt-keys), for the usual plan and GO\'d import, with no re-classification', async () => {
    await rereadKettle();
    const expectFree = expectKettleFree;
    // Nothing to adopt before the previous key is assigned: no file.
    const none = path.join(dir, 'none.json');
    expect(await answer(['adopt-keys', '--db', file, '--output', none])).toEqual({ code: 'taxonomy-key-adoptions-none', entries: 0 });
    expect(fs.existsSync(none)).toBe(false);
    const NODE = KETTLE_NODE;
    const first = mapping([{ productKey: productKey(KETTLE_SEEN), node: NODE, confidence: 0.91, source: 'agent' }]);
    await answer(['import', '--db', file, '--input', json('first.json', first), '--backup', path.join(dir, 'backup-1.db'), '--root-go', go(first)]);
    const displayed = () => opened(db => amazonTaxonomySpending(db, '60D', '2026-10-19')).products.find(p => p.asin === KETTLE.asin);
    expect(displayed()).toMatchObject({ node: 'needs-review', source: null });

    const worklistFile = path.join(dir, 'worklist.json');
    expect(await answer(['worklist', '--db', file, '--output', worklistFile])).toMatchObject({ products: 5, assigned: 1, adoptions: 1 });
    expectFree(stdout);
    expect(JSON.parse(fs.readFileSync(worklistFile, 'utf8')).products.find((p: { productKey: string }) => p.productKey === productKey(KETTLE)))
      .toMatchObject({ assigned: null, adoptFrom: { previousProductKey: productKey(KETTLE_SEEN), node: NODE, source: 'agent', confidence: 0.91 } });

    const before = fs.readFileSync(file);
    const output = path.join(dir, 'adopted.json');
    const printed = await answer(['adopt-keys', '--db', file, '--output', output]);
    expectFree(stdout);
    expect(fs.readFileSync(file)).toEqual(before);
    const written = JSON.parse(fs.readFileSync(output, 'utf8'));
    // Its provenance: the adoption kind, and the new key, the previous key and the exact value adopted.
    expect(written).toEqual({ ...mapping([{ productKey: productKey(KETTLE), previousProductKey: productKey(KETTLE_SEEN), node: NODE,
      confidence: 0.91, source: 'agent' }]), kind: 'adoption' });
    expect(printed).toEqual({ code: 'taxonomy-key-adoptions-written-not-imported', entries: 1, agent: 1, owner: 0, mappingDigest: digest(written) });
    expect(await answer(['plan', '--db', file, '--input', output])).toMatchObject({ code: 'taxonomy-planned', kind: 'adoption', entries: 1,
      insert: 1, update: 0, unchanged: 0, mappingDigest: digest(written) });
    expect(await answer(['import', '--db', file, '--input', output, '--backup', path.join(dir, 'backup-2.db'), '--root-go', go(written)]))
      .toEqual({ code: 'taxonomy-imported', insert: 1, update: 0, unchanged: 0, mappingDigest: digest(written), taxonomyDigest: AMAZON_TAXONOMY_DIGEST });
    expectFree(stdout);

    // The new key resolves as the previous one did, and the taxonomy view files the displayed line there.
    expect(opened(db => readTaxonomyAssignments(db).get(productKey(KETTLE)))).toEqual({ node: NODE, source: 'agent', confidence: 0.91 });
    expect(displayed()).toMatchObject({ node: NODE, source: 'agent', confidence: 0.91, suggested: false, lines: 1 });
    expect(await answer(['adopt-keys', '--db', file, '--output', path.join(dir, 'again.json')]))
      .toEqual({ code: 'taxonomy-key-adoptions-none', entries: 0 });
    expect(fs.existsSync(path.join(dir, 'again.json'))).toBe(false);

    // An existing output, a relative path, a missing or stray option refuses, without a value in the error.
    stderr = '';
    for (const args of [['adopt-keys', '--db', file, '--output', output], ['adopt-keys', '--db', 'finance.db', '--output', path.join(dir, 'a1.json')],
      ['adopt-keys', '--db', file, '--output', 'adopted.json'], ['adopt-keys', '--db', file],
      ['adopt-keys', '--db', file, '--output', path.join(dir, 'a2.json'), '--input', output], ['adopt-keys', '--output', path.join(dir, 'a3.json')]]) {
      expect(await run(args), JSON.stringify(args)).toBe(1);
    }
    expect(stderr).toBe('amazon-taxonomy: input-refused HoldrRefusal\n'.repeat(6));
    expectFree(stderr);
    expect(fs.readFileSync(output, 'utf8')).toBe(JSON.stringify(written) + '\n');
  });

  it('refuses a stale adoption mapping whole (adoption-stale, counts only): at plan, before any backup, and at the write itself', async () => {
    await rereadKettle();
    const seen = mapping([{ productKey: productKey(KETTLE_SEEN), node: KETTLE_NODE, confidence: 0.91, source: 'agent' }]);
    await answer(['import', '--db', file, '--input', json('seen.json', seen), '--backup', path.join(dir, 'backup-seen.db'), '--root-go', go(seen)]);
    let n = 0;
    const adoptKeys = async () => {
      const output = path.join(dir, `adopted-${++n}.json`);
      const printed = await answer(['adopt-keys', '--db', file, '--output', output]);
      return { output, printed, written: JSON.parse(fs.readFileSync(output, 'utf8')) };
    };
    /** plan and an import GO'd for exactly this mapping refuse it whole, before any backup, with nothing changed. */
    const refusedStale = async (output: string, written: unknown, counts: { newKeyAssigned: number; previousChanged: number }) => {
      const before = fs.readFileSync(file), backup = path.join(dir, `never-${++n}.db`);
      const expected = `amazon-taxonomy: adoption-stale ${JSON.stringify({ entries: 1, ...counts })}\n`;
      expect(await answer(['plan', '--db', file, '--input', output], 1)).toBe(expected);
      expect(await answer(['import', '--db', file, '--input', output, '--backup', backup, '--root-go', go(written)], 1)).toBe(expected);
      expectKettleFree(expected);
      expect(fs.existsSync(backup)).toBe(false);
      expect(fs.readFileSync(file)).toEqual(before);
    };

    // The previous key's assignment changed after generation (the owner classified it): stale.
    const agentAdoption = await adoptKeys();
    const owner = mapping([{ productKey: productKey(KETTLE_SEEN), node: 'home-kitchen/kitchen-dining', confidence: 1, source: 'owner' }]);
    await answer(['import', '--db', file, '--input', json('owner.json', owner), '--backup', path.join(dir, 'backup-owner.db'), '--root-go', go(owner)]);
    await refusedStale(agentAdoption.output, agentAdoption.written, { newKeyAssigned: 0, previousChanged: 1 });

    // Regenerated, it adopts the owner's choice. Then a classification of the new key lands after the import's read-only
    // plan passed, just before its write: the write's own check, inside its transaction, refuses it with nothing written.
    const ownerAdoption = await adoptKeys();
    expect(ownerAdoption.printed).toMatchObject({ entries: 1, agent: 0, owner: 1 });
    expect(ownerAdoption.written.entries).toEqual([{ productKey: productKey(KETTLE), previousProductKey: productKey(KETTLE_SEEN),
      node: 'home-kitchen/kitchen-dining', confidence: 1, source: 'owner' }]);
    const db = new Database(file);
    try {
      expect(planTaxonomyImport(db, ownerAdoption.written)).toMatchObject({ kind: 'adoption', insert: 1 });
      const classified = mapping([{ productKey: productKey(KETTLE), node: 'home-kitchen/small-appliances', confidence: 0.3, source: 'agent' }]);
      db.transaction(() => applyTaxonomyMapping(db, classified, '2026-10-22T00:00:00.000Z'))();
      const rows = () => ({ rows: db.prepare('SELECT * FROM amazon_product_taxonomy ORDER BY product_key,source').all(),
        audit: db.prepare('SELECT count(*) FROM amazon_audit').pluck().get() });
      const before = rows();
      const refusal = await backedUpWrite(db, path.join(dir, 'race-backup.db'),
        () => applyTaxonomyMapping(db, ownerAdoption.written, '2026-10-22T00:00:00.000Z'), installAmazonTaxonomySchema).catch(error => error);
      expect(taxonomyAdoptionStale(refusal)).toEqual({ entries: 1, newKeyAssigned: 1, previousChanged: 0 });
      expect(rows()).toEqual(before);
      expect(readTaxonomyAssignments(db).get(productKey(KETTLE))).toEqual({ node: 'home-kitchen/small-appliances', source: 'agent', confidence: 0.3 });
    } finally { db.close(); }
    await refusedStale(ownerAdoption.output, ownerAdoption.written, { newKeyAssigned: 1, previousChanged: 0 });
    // The new key is classified now: nothing is left to adopt.
    expect(await answer(['adopt-keys', '--db', file, '--output', path.join(dir, 'adopted-none.json')]))
      .toEqual({ code: 'taxonomy-key-adoptions-none', entries: 0 });
  });
  it('STEP 9 integration B7b (Root): plan and import apply only a taxonomy adoption; an agent-category or mixed one refuses whole', async () => {
    const taxonomy = (productKey: string) => ({ productKey, previousProductKey: KEYS[1], node: 'groceries/produce', confidence: 0.9,
      source: 'agent' });
    const category = (productKey: string) => ({ productKey, previousProductKey: KEYS[1], category: 'Shopping', confidence: 0.9 });
    const refused: unknown[] = [
      { kind: 'adoption', productsDigest: digest([category(KEYS[0])]), categoriesDigest: digest(['Shopping']), entries: [category(KEYS[0])] },
      { ...mapping([category(KEYS[0])]), kind: 'adoption' },
      { ...mapping([taxonomy(KEYS[0]), category(KEYS[2])]), kind: 'adoption' },
      { ...mapping([{ ...taxonomy(KEYS[0]), category: 'Shopping' }]), kind: 'adoption' },
    ];
    const before = fs.readFileSync(file);
    for (const [n, input] of refused.entries()) {
      const inputFile = json(`b7b-${n}.json`, input), backup = path.join(dir, `b7b-backup-${n}.db`);
      expect(await answer(['plan', '--db', file, '--input', inputFile], 1), String(n)).toBe('amazon-taxonomy: input-refused HoldrRefusal\n');
      expect(await answer(['import', '--db', file, '--input', inputFile, '--backup', backup, '--root-go', go(input)], 1), String(n))
        .toBe('amazon-taxonomy: input-refused HoldrRefusal\n');
      expect(fs.existsSync(backup), String(n)).toBe(false);
    }
    expect(fs.readFileSync(file)).toEqual(before);
  });
  it('STEP 9 integration B7a (#168 x #171): a held agent line\'s learned key is tagged and adopted once, from #168\'s list too', async () => {
    // The agent filed the kettle's first key (card category and taxonomy), so the re-read that learns its ASIN is kept
    // back (#168; STEP 9 B2): the new key exists only in a later read, and both lists name the change.
    const KETTLE_SEEN = { asin: null, title: 'Synthetic travel kettle' }, KETTLE = { asin: 'SYNTHKTL01', title: KETTLE_SEEN.title };
    const ORDER = '000-0000002-0000002', NODE = 'home-kitchen/small-appliances';
    const importRead = async (asin: string | null, run: number) => {
      const reread = syntheticCapture();
      const order = reread.staging.orders[0];
      order.orderId = ORDER;
      order.items[0] = { ...order.items[0], itemId: asin, title: KETTLE.title };
      reread.staging.runId = `00000000-0000-4000-8000-00000000020${run}`;
      const repo = new SqliteStateRepo({ file });
      try { return await importAmazonCapture(repo.internalGetDb(), reread, path.join(dir, `held-backup-${run}.db`)); }
      finally { repo.close(); }
    };
    const agentCategory = (key: string) => {
      const db = new Database(file);
      try { db.prepare("INSERT INTO amazon_agent_categories VALUES(?,?,?,'agent','categorized from product title')").run(key, 'Home', 0.9); }
      finally { db.close(); }
    };
    await importRead(null, 1);
    const first = mapping([{ productKey: productKey(KETTLE_SEEN), node: NODE, confidence: 0.91, source: 'agent' }]);
    await answer(['import', '--db', file, '--input', json('first.json', first), '--backup', path.join(dir, 'backup-1.db'), '--root-go', go(first)]);
    agentCategory(productKey(KETTLE_SEEN));
    expect((await importRead(KETTLE.asin, 2)).holds).toEqual(expect.arrayContaining([{ reason: 'agent-category-new-key', count: 1 },
      { reason: 'item-category-unmatched', count: 1 }]));
    const pair = { productKey: productKey(KETTLE), previousProductKey: productKey(KETTLE_SEEN) };
    const listed = [{ ...pair, category: 'Home', confidence: 0.9 }];
    expect(opened(db => categoryKeyAdoptions(db))).toEqual(listed);
    expect(opened(db => taxonomyKeyChanges(db))).toEqual([pair]);
    const adoptFrom = { previousProductKey: pair.previousProductKey, node: NODE, source: 'agent', confidence: 0.91 };
    const worklist = async (db: string, name: string) => {
      const out = path.join(dir, `${name}.json`);
      expect(await answer(['worklist', '--db', db, '--output', out])).toMatchObject({ adoptions: 1 });
      return JSON.parse(fs.readFileSync(out, 'utf8')).products.find((p: { productKey: string }) => p.productKey === pair.productKey);
    };
    const adopted = { ...mapping([{ productKey: pair.productKey, previousProductKey: pair.previousProductKey, node: NODE, confidence: 0.91,
      source: 'agent' }]), kind: 'adoption' };
    const adoptKeys = async (db: string, name: string) => {
      const out = path.join(dir, `${name}.json`);
      expect(await answer(['adopt-keys', '--db', db, '--output', out])).toMatchObject({ entries: 1, agent: 1, owner: 0 });
      expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual(adopted);
      return out;
    };
    expect(await worklist(file, 'worklist-both')).toMatchObject({ adoptFrom });
    const output = await adoptKeys(file, 'adopted-both');

    // Isolates the wiring: on a copy without the earlier read's observation (imports never produce this), the native
    // detection no longer sees the change; only #168's list, read from the displayed lines, still names it.
    const copy = path.join(dir, 'isolated.db');
    opened(db => db.prepare('VACUUM INTO ?').run(copy));
    const isolated = new Database(copy);
    try {
      isolated.prepare(`DELETE FROM amazon_observations WHERE family='order'
        AND capture_digest=(SELECT latest_digest FROM amazon_orders WHERE native_id=?)`).run(ORDER);
      expect(taxonomyKeyChanges(isolated)).toEqual([]);
      expect(categoryKeyAdoptions(isolated)).toEqual(listed);
    } finally { isolated.close(); }
    expect(await worklist(copy, 'worklist-isolated')).toMatchObject({ adoptFrom });
    await adoptKeys(copy, 'adopted-isolated');

    // Once the GO'd taxonomy import and the category review (simulated) adopt the key, the next re-read replaces the display.
    await answer(['import', '--db', file, '--input', output, '--backup', path.join(dir, 'backup-2.db'), '--root-go', go(adopted)]);
    agentCategory(pair.productKey);
    expect((await importRead(KETTLE.asin, 3)).holds.map(h => h.reason)).not.toContain('item-category-unmatched');
    expect(opened(db => amazonTaxonomySpending(db, '60D', '2026-10-19')).products.find(p => p.asin === KETTLE.asin))
      .toMatchObject({ node: NODE, source: 'agent', confidence: 0.91, lines: 1 });
  });
});
