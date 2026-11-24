import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { amazonTaxonomyNode } from '@finance-tracker/shared';
import { SqliteStateRepo } from '../sqliteStateRepo.js';
import { backedUpWrite as sealedWrite, importAmazonCapture as sealedImport } from './importer.js';
import { syntheticCapture } from './fixtures.testSupport.js';
import { lineTieKeys } from './allocation.js';
import { amazonFresh, amazonFreshOrder } from './fresh.js';
import { digest, opaque } from './policy.js';
import { productKey, publicTitle } from './products.js';
import {
  AMAZON_TAXONOMY_DIGEST, AMAZON_TAXONOMY_MAPPING_FORMAT, AMAZON_TAXONOMY_SCHEMA_DIGEST, installAmazonTaxonomySchema,
} from './taxonomy.js';
import { amazonTaxonomySpending } from './taxonomySpending.js';
import { amazonSpending } from './spending.js';
import {
  AMAZON_TAXONOMY_LINE_SCHEMA_DIGEST, freshLineIdentities, hasAmazonLineTaxonomySchema, installAmazonLineTaxonomySchema, lineProductPin,
  orderLineIdentities,
} from './lineTaxonomy.js';
import { taxonomyKeylessHolds } from './taxonomyLineDecisions.js';
import { runAmazonTaxonomyCli } from '../../cli/amazonTaxonomy.js';
import { readCurrentUserSid, restrictToUser } from '../../e2e/windowsAcl.js';
import type { Money, OrderObservation } from './types.js';

// Keyless taxonomy holds (Root, after STEP 9): a display kept because a line's taxonomy decision cannot follow a re-read,
// with no learned key to adopt or map (an ambiguous match, or a title the card-data guard holds), is visible (counts
// only, by reason) and resolved by the owner's GO'd decision for the line itself, by its stable line identity.
// Entirely synthetic: made-up order IDs, titles, ASINs and prices (4111111111111111 is the standard test card number);
// no network. A guarded title is compared by inclusion only, so even a failing assertion never prints it.
const TODAY = '2026-10-19';
const ORDER = '000-0000001-0000001', REF = opaque('order', ORDER);
const usd = (amountMinor: number): Money => ({ currency: 'USD', amountMinor });
const runId = (run: number) => `00000000-0000-4000-8000-${String(run).padStart(12, '0')}`;
type Product = { asin: string | null; title: string };
const KITCHEN = 'home-kitchen/kitchen-dining', OUTDOORS = 'sports-outdoors', CABLES = 'electronics/cables-chargers-batteries';
const PRODUCE = 'groceries/produce', SNACKS = 'groceries/snacks-sweets';

/** The synthetic order read again (`run`), with these lines priced to its $10.00 item subtotal. */
function orderRead(run: number, lines: Product[]) {
  const capture = syntheticCapture(), order = capture.staging.orders[0];
  capture.staging.runId = runId(run);
  order.items = lines.map((line, lineOrdinal) => ({ lineOrdinal, itemId: line.asin, title: line.title, quantity: 1,
    unitPrice: usd(1000 / lines.length) }));
  capture.staging.coverage.details.records = order.items.length;
  return capture;
}
/** The same order with its Amazon Fresh Item List: these lines, each at `cents` (reconciled when they make $10.00). */
function freshRead(run: number, lines: Product[], cents = 1000 / lines.length) {
  const capture = syntheticCapture() as ReturnType<typeof syntheticCapture> & { fresh?: unknown };
  capture.staging.runId = runId(run);
  const records = freshLines(lines, cents);
  capture.fresh = { format: 'holdr.amazon-fresh-item-lists', version: 1,
    lists: [{ orderId: ORDER, statedCount: records.length, rows: records.length, proof: { complete: true, unreadRows: 0 },
      reconciled: cents * records.length === 1000, lines: records }],
    diagnostics: [{ ordinal: 0, status: 'read', reason: null, rows: records.length, lines: records.length, unread: [] }] };
  return capture;
}
const freshLines = (lines: Product[], cents = 1000 / lines.length) => lines.map((line, lineOrdinal) => ({ lineOrdinal,
  title: line.title, asin: line.asin, status: 'listed' as const, quantity: 1, weight: null, unitPrice: null, linePrice: usd(cents),
  replaces: null }));
/** The synthetic order read again with lines at these positions, $5.00 each (a gap: a line that read left unread). */
function itemsRead(run: number, lines: Array<[number, Product]>) {
  const capture = syntheticCapture(), order = capture.staging.orders[0];
  capture.staging.runId = runId(run);
  order.items = lines.map(([lineOrdinal, line]) => ({ lineOrdinal, itemId: line.asin, title: line.title, quantity: 1,
    unitPrice: usd(500) }));
  capture.staging.coverage.details.records = order.items.length;
  return capture;
}
const byAsin = (a: { asin: string | null }, b: { asin: string | null }) => ((a.asin ?? '') < (b.asin ?? '') ? -1 : 1);
/** Amazon's closed positive statement that the order was cancelled and never charged, read as an empty header (#158). */
function proven(run: number) {
  const capture = syntheticCapture(), o = capture.staging.orders[0];
  capture.staging.runId = runId(run);
  o.items = []; o.paymentMethods = []; o.summary = []; o.tenderCoverage = 'unknown'; o.total = null;
  o.tenderProof = { methodComplete: false, summaryComplete: false, unknownMethod: false, unknownSummary: false, conflict: false };
  o.chargeFree = { status: 'cancelled-not-charged', shipments: 1 };
  capture.staging.coverage.details = { status: 'held', reason: 'budget', pages: 0, records: 0, rejected: 0 };
  capture.structure = {
    format: 'holdr.amazon-structure', version: 3, scope: 'value-free-unobserved-is-unknown',
    code: 'complete', requests: 0, pages: [], stop: null,
    itemDiagnostics: { orders: [{ ordinal: 0, observed: false, quantities: { displayed: 0, inferred: 0 } }] },
    tenderDiagnostics: {
      orders: [{ ordinal: 0, reasons: ['method-incomplete', 'row-shape'], proof: {
        summary: { observed: false, enteredRowLoop: false, outsideRows: false,
          outside: { rows: 0, labels: 0, contents: 0, financialLists: 0, nonFinancialLists: 0 },
          nestedCandidate: false, relations: { ancestor: 0, sibling: 0, inside: 0 },
          initialComplete268: false, hold270: false, hold286: false, evaluated286: false, legacyOutsideRows: false },
        failed: ['method-complete', 'summary-complete'], conflicts: ['summary-hold', 'method-incomplete'],
      } }],
      counts: { 'unknown-label': 0, 'row-shape': 1, 'extra-text': 0, 'duplicate-kind': 0,
        arithmetic: 0, 'method-incomplete': 1, 'multi-tender': 0 },
      unknownLabels: [], unreportedUnknownLabelOrders: 0,
    },
  };
  return capture;
}
const lineDecision = (entries: unknown[]) => ({ format: AMAZON_TAXONOMY_MAPPING_FORMAT, version: 1, taxonomyVersion: 1, reviewed: true,
  kind: 'line-decision', entries });
const productMapping = (entries: unknown[]) => ({ format: AMAZON_TAXONOMY_MAPPING_FORMAT, version: 1, taxonomyVersion: 1,
  reviewed: true, entries });
type Hold = { family: string; lineIdentity: string; reason: string; held: { node: string; source: string; confidence: number };
  product: string; productKey: string; asin: string | null; title: string | null };
/** A worklist hold as the owner's decision entry pins it (its product included), filed under `node`. */
const decide = (hold: Hold, node: string) => ({ lineIdentity: hold.lineIdentity, family: hold.family, reason: hold.reason,
  held: hold.held, product: hold.product, node });
const counts = (patch: { ordinary?: Record<string, number>; fresh?: Record<string, number> } = {}) => ({
  ordinary: { 'ambiguous-match': 0, 'card-data-guard': 0, ...patch.ordinary },
  fresh: { 'ambiguous-match': 0, 'card-data-guard': 0, ...patch.fresh } });

let dir: string, repo: SqliteStateRepo, backupNumber: number, vault: string | null = null, sid: string | null = null, files = 0;
const db = () => repo.internalGetDb();
const backup = () => path.join(dir, `backup-${++backupNumber}.db`);
const database = () => path.join(dir, 'synthetic.db');
// A refused write throws a sealed, value-free error, which vitest cannot annotate: it would fail this file, not the test
// that met it. Rethrown as a plain error with the same value-free name and message, it fails that test.
const plain = (error: unknown): never => { throw new Error(`${(error as Error).name}: ${(error as Error).message}`); };
const importAmazonCapture = (...args: Parameters<typeof sealedImport>) => sealedImport(...args).catch(plain);
const backedUpWrite = (...args: Parameters<typeof sealedWrite>) => sealedWrite(...args).catch(plain);
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-keyless-holds-synthetic-')); backupNumber = 0;
  repo = new SqliteStateRepo({ file: database() });
});
afterEach(() => {
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (vault) fs.rmSync(vault, { recursive: true, force: true });
  vault = null;
});
/** The operator's private files live in a directory only this user can read, outside the repository. */
const privateDir = () => {
  if (vault) return vault;
  vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-keyless-holds-private-')));
  if (process.platform === 'win32') restrictToUser(vault, sid ?? (sid = readCurrentUserSid()));
  else fs.chmodSync(vault, 0o700);
  return vault;
};
/** Values that must never reach the terminal: titles, ASINs, product keys, the order and line identities. */
let secrets: string[] = [];
async function operator(args: string[]) {
  let stdout = '', stderr = '';
  const code = await runAmazonTaxonomyCli(args, { env: { ...process.env, HOLDR_CONFIG: 'none' },
    now: () => new Date('2026-10-22T00:00:00Z'),
    io: { stdout: { write: (s: string) => { stdout += s; } }, stderr: { write: (s: string) => { stderr += s; } } } });
  expect(secrets.filter((value) => (stdout + stderr).includes(value)).length, 'a private value reached the terminal').toBe(0);
  return { code, stdout, stderr };
}
const ok = async (args: string[]) => {
  const { code, stdout, stderr } = await operator(args);
  expect(code, stderr).toBe(0);
  return JSON.parse(stdout);
};
const refused = async (args: string[]) => {
  const { code, stdout, stderr } = await operator(args);
  expect([code, stdout]).toEqual([1, '']);
  return stderr;
};
/** A private mapping file and Root's GO pinned to it, to this database and, by default, to the line decision table. */
const goFor = (input: unknown, schemaDigest = AMAZON_TAXONOMY_LINE_SCHEMA_DIGEST) => {
  const file = path.join(privateDir(), `mapping-${++files}.json`), go = path.join(privateDir(), `go-${files}.json`);
  fs.writeFileSync(file, JSON.stringify(input));
  fs.writeFileSync(go, JSON.stringify({ format: 'holdr.amazon-taxonomy-go', version: 1, authority: 'Root', decision: 'GO',
    purpose: 'copy-rehearsal', command: 'import', databaseRef: digest(path.resolve(database())), mappingDigest: digest(input),
    taxonomyDigest: AMAZON_TAXONOMY_DIGEST, schemaDigest }));
  return { file, go };
};
/** `worklist`: its printed keyless counts, and the holds its private file lists. */
async function worklist() {
  const output = path.join(privateDir(), `worklist-${++files}.json`);
  const printed = await ok(['worklist', '--db', database(), '--output', output]);
  expect(printed.code).toBe('taxonomy-worklist-written');
  return { printed: printed.keylessHolds, holds: JSON.parse(fs.readFileSync(output, 'utf8')).keylessHolds as Hold[], output };
}
/** plan, then the GO'd import, of an owner's line decisions. */
async function planAndImport(decision: unknown, before: unknown) {
  const { file, go } = goFor(decision);
  const entries = (decision as { entries: unknown[] }).entries.length;
  expect(await ok(['plan', '--db', database(), '--input', file])).toEqual({ code: 'taxonomy-planned', kind: 'line-decision',
    schema: hasAmazonLineTaxonomySchema(db()) ? 'present' : 'absent', entries, insert: entries, keylessHolds: before,
    keylessHoldsAfter: counts(), mappingDigest: digest(decision), taxonomyDigest: AMAZON_TAXONOMY_DIGEST,
    schemaDigest: AMAZON_TAXONOMY_LINE_SCHEMA_DIGEST, databaseRef: digest(path.resolve(database())) });
  expect(await ok(['import', '--db', database(), '--input', file, '--backup', backup(), '--root-go', go]))
    .toEqual({ code: 'taxonomy-lines-decided', insert: entries, mappingDigest: digest(decision), taxonomyDigest: AMAZON_TAXONOMY_DIGEST });
  return { file, go };
}
/** A taxonomy row as the GO'd import stores one: the decision a case starts from (a fixture). */
const stored = (key: string, source: 'owner' | 'agent', node: string, confidence: number) => backedUpWrite(db(), backup(), () => {
  installAmazonTaxonomySchema(db());
  db().prepare('INSERT INTO amazon_product_taxonomy VALUES(?,?,?,?,?,?)').run(key, source, node, confidence, 1, 'b'.repeat(64));
});
/** Owner line decisions as the GO'd line decision import stores them (a fixture), beside the taxonomy table B2 reads. */
const decideLines = (family: 'ordinary' | 'fresh', entries: ReadonlyArray<readonly [string, string | null, string]>) =>
  backedUpWrite(db(), backup(), () => {
    for (const [identity, asin, node] of entries) {
      db().prepare(`INSERT INTO amazon_line_taxonomy(line_identity,asin,family,node,taxonomy_version,mapping_digest)
        VALUES(?,?,?,?,1,?)`).run(identity, asin ?? '', family, node, 'c'.repeat(64));
    }
  }, (handle) => { installAmazonTaxonomySchema(handle); installAmazonLineTaxonomySchema(handle); });
const displayed = () => db().prepare('SELECT latest_digest FROM amazon_orders WHERE ref=?').pluck().get(REF) as string;
const active = () => db().prepare('SELECT latest_digest FROM amazon_fresh_orders WHERE order_ref=?').pluck().get(REF) as string;
const audits = (action: string) => db().prepare('SELECT count(*) FROM amazon_audit WHERE action=?').pluck().get(action) as number;
const lineRows = () => (hasAmazonLineTaxonomySchema(db())
  ? db().prepare('SELECT * FROM amazon_line_taxonomy ORDER BY line_identity').all() : []) as Array<Record<string, unknown>>;
/** What a write would change, as a reader sees it: every object, the audit, the decisions and the display. */
const snapshot = () => JSON.stringify({ objects: db().prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all(),
  audit: db().prepare('SELECT count(*) FROM amazon_audit').pluck().get(),
  taxonomy: db().prepare('SELECT * FROM amazon_product_taxonomy ORDER BY product_key,source').all(), lines: lineRows(),
  display: displayed() });
/** What the taxonomy view files: each item's node, who filed it, its title and ASIN, and its lines. */
const taxonomyView = () => amazonTaxonomySpending(db(), '60D', TODAY).products
  .map(({ node, source, confidence, title, asin, lines }) => ({ node, source, confidence, title, asin, lines }))
  .sort((a, b) => a.node.localeCompare(b.node));
/** What the Fresh tab files: each product's node, who filed it, its title and ASIN, and its lines. */
const freshView = () => amazonFresh(db(), '2Y', TODAY).products
  .map(({ node, source, confidence, title, asin, lines }) => ({ node, source, confidence, title, asin, lines }))
  .sort((a, b) => a.node.localeCompare(b.node));
const owner = (node: string, title: string, asin: string | null, lines = 1) => ({ node, source: 'owner', confidence: 1, title, asin, lines });
const byIdentity = (a: { lineIdentity: string }, b: { lineIdentity: string }) => (a.lineIdentity < b.lineIdentity ? -1 : 1);
/** Whether a guarded title is anywhere it must never be: files, audits, line decisions or the database's new rows. */
const guardedNowhere = (title: string, ...paths: string[]) => {
  expect(publicTitle(title), 'the fixture title is one the card-data guard holds').toBe('[redacted]');
  const texts = [...paths.map((file) => fs.readFileSync(file, 'utf8')), JSON.stringify(db().prepare('SELECT * FROM amazon_audit').all()),
    JSON.stringify(lineRows())];
  expect(texts.filter((text) => text.includes(title)).length, 'a guarded title was stored or echoed').toBe(0);
};

describe('Keyless taxonomy holds (Root, after STEP 9): visible by reason, resolved by the owner\'s GO\'d line decision', () => {
  it('ordinary lines, ambiguous match: two lines of one product are each decided by line identity, and the next re-read replaces the display', async () => {
    const MUG = { asin: 'SYNTHKM001', title: 'Synthetic Keyless Camp Mug' }, key = productKey(MUG);
    secrets = [MUG.asin, MUG.title, key, ORDER];
    const first = orderRead(1, [MUG, MUG]);
    await importAmazonCapture(db(), first, backup());
    await stored(key, 'agent', KITCHEN, 0.9);
    const shown = displayed();
    // Each displayed line's identity-matched line of the re-read is not unique: the display is kept (B2, unchanged).
    expect((await importAmazonCapture(db(), orderRead(2, [MUG, MUG]), backup())).holds)
      .toContainEqual({ reason: 'taxonomy-unmatched', count: 1 });
    expect(displayed()).toBe(shown);
    const ids = lineTieKeys(first.staging.orders[0] as OrderObservation);
    secrets.push(...ids.values());
    // (a) Visible: counts by reason in the worklist and any plan; the private worklist lists each line by its identity.
    const { printed, holds } = await worklist();
    expect(printed).toEqual(counts({ ordinary: { 'ambiguous-match': 2 } }));
    expect(holds).toEqual([0, 1].map((n) => ({ family: 'ordinary', lineIdentity: ids.get(n)!, reason: 'ambiguous-match',
      held: { node: KITCHEN, source: 'agent', confidence: 0.9 }, product: lineProductPin('ordinary', ids.get(n)!, key), productKey: key,
      asin: MUG.asin, title: MUG.title })).sort(byIdentity));
    const generic = goFor(productMapping([{ productKey: key, node: KITCHEN, confidence: 0.9, source: 'agent' }]));
    expect(await ok(['plan', '--db', database(), '--input', generic.file])).toMatchObject({ unchanged: 1,
      keylessHolds: counts({ ordinary: { 'ambiguous-match': 2 } }) });
    // (b) Resolved: the owner files each line under GO, by its identity, and the import leaves the display as it is.
    const nodes = new Map([[ids.get(0)!, KITCHEN], [ids.get(1)!, OUTDOORS]]);
    await planAndImport(lineDecision(holds.map((hold) => decide(hold, nodes.get(hold.lineIdentity)!))),
      counts({ ordinary: { 'ambiguous-match': 2 } }));
    expect(displayed()).toBe(shown);
    expect(lineRows()).toEqual([...nodes].map(([identity, node]) => ({ line_identity: identity, asin: MUG.asin, family: 'ordinary',
      node, taxonomy_version: 1, mapping_digest: expect.stringMatching(/^[a-f0-9]{64}$/) }))
      .sort((a, b) => (a.line_identity < b.line_identity ? -1 : 1)));
    const filed = [owner(KITCHEN, MUG.title, MUG.asin), owner(OUTDOORS, MUG.title, MUG.asin)];
    expect(taxonomyView()).toEqual(filed);
    expect(taxonomyKeylessHolds(db())).toEqual([]);
    expect((await worklist()).printed).toEqual(counts());
    // The next real re-read follows the owner's decisions by line identity: it replaces the display, unheld.
    const next = await importAmazonCapture(db(), orderRead(3, [MUG, MUG]), backup());
    expect(next.holds.map((h) => h.reason)).not.toContain('taxonomy-unmatched');
    expect(displayed()).not.toBe(shown);
    expect(taxonomyView()).toEqual(filed);
    expect(audits('taxonomy-line-decisions')).toBe(1);
  });

  it('ordinary lines, card-data guard: a decided key whose title the guard now holds is decided by line identity, never naming the title', async () => {
    // A decision filed under the key before the card-data guard held its title (a guard that grew stricter): no mapping
    // can name that key now, and the line's one matched line of every re-read has no classifiable key.
    const CHARGER = { asin: 'SYNTHKC001', title: 'Synthetic Keyless Charger 4111111111111111' }, key = productKey(CHARGER);
    secrets = [CHARGER.asin, key, ORDER];
    const first = orderRead(1, [CHARGER]);
    await importAmazonCapture(db(), first, backup());
    await stored(key, 'owner', CABLES, 1);
    const shown = displayed();
    expect((await importAmazonCapture(db(), orderRead(2, [CHARGER]), backup())).holds)
      .toContainEqual({ reason: 'taxonomy-unmatched', count: 1 });
    expect(displayed()).toBe(shown);
    // The guard hides the line from every product classification: it is in Needs review, its title redacted.
    expect(taxonomyView()).toEqual([{ node: 'needs-review', source: null, confidence: null, title: '[redacted]', asin: CHARGER.asin, lines: 1 }]);
    const identity = lineTieKeys(first.staging.orders[0] as OrderObservation).get(0)!;
    secrets.push(identity);
    const { printed, holds, output } = await worklist();
    expect(printed).toEqual(counts({ ordinary: { 'card-data-guard': 1 } }));
    expect(holds).toEqual([{ family: 'ordinary', lineIdentity: identity, reason: 'card-data-guard',
      held: { node: CABLES, source: 'owner', confidence: 1 }, product: lineProductPin('ordinary', identity, key), productKey: key,
      asin: CHARGER.asin, title: null }]);
    const { file } = await planAndImport(lineDecision([decide(holds[0], CABLES)]), counts({ ordinary: { 'card-data-guard': 1 } }));
    expect(taxonomyView()).toEqual([owner(CABLES, '[redacted]', CHARGER.asin)]);
    const next = await importAmazonCapture(db(), orderRead(3, [CHARGER]), backup());
    expect(next.holds.map((h) => h.reason)).not.toContain('taxonomy-unmatched');
    expect(displayed()).not.toBe(shown);
    expect(taxonomyView()).toEqual([owner(CABLES, '[redacted]', CHARGER.asin)]);
    guardedNowhere(CHARGER.title, output, file);
  });

  it('Fresh lines, ambiguous match: two list lines of one product are each decided by line identity, and the next re-read replaces the list', async () => {
    const LIMES = { asin: null, title: 'Synthetic Fresh Keyless Limes' }, key = productKey(LIMES);
    secrets = [LIMES.title, key, ORDER];
    await importAmazonCapture(db(), freshRead(1, [LIMES, LIMES]), backup());
    await stored(key, 'agent', PRODUCE, 0.9);
    const list = active();
    const held = await importAmazonCapture(db(), freshRead(2, [LIMES, LIMES]), backup());
    expect(held.holds).toContainEqual({ reason: 'taxonomy-unmatched', count: 1 });
    expect(active()).toBe(list);
    const ids = freshLineIdentities(ORDER, freshLines([LIMES, LIMES]));
    secrets.push(...ids.values());
    const { printed, holds } = await worklist();
    expect(printed).toEqual(counts({ fresh: { 'ambiguous-match': 2 } }));
    expect(holds).toEqual([0, 1].map((n) => ({ family: 'fresh', lineIdentity: ids.get(n)!, reason: 'ambiguous-match',
      held: { node: PRODUCE, source: 'agent', confidence: 0.9 }, product: lineProductPin('fresh', ids.get(n)!, key), productKey: key,
      asin: null, title: LIMES.title })).sort(byIdentity));
    const nodes = new Map([[ids.get(0)!, PRODUCE], [ids.get(1)!, SNACKS]]);
    await planAndImport(lineDecision(holds.map((hold) => decide(hold, nodes.get(hold.lineIdentity)!))),
      counts({ fresh: { 'ambiguous-match': 2 } }));
    expect(active()).toBe(list);
    // One product, two lines the owner filed apart: the tab lists them apart, each under its own decision.
    const filed = [owner(PRODUCE, LIMES.title, null), owner(SNACKS, LIMES.title, null)];
    expect(freshView()).toEqual(filed);
    expect(amazonFreshOrder(db(), REF)!.lines.map((line) => [line.node, line.source])).toEqual([[PRODUCE, 'owner'], [SNACKS, 'owner']]);
    const next = await importAmazonCapture(db(), freshRead(3, [LIMES, LIMES]), backup());
    expect(next.holds.map((h) => h.reason)).not.toContain('taxonomy-unmatched');
    expect(active()).not.toBe(list);
    expect(freshView()).toEqual(filed);
  });

  it('Fresh lines, card-data guard: a line renamed to a guarded title is decided by line identity; the decision follows it, never naming the title', async () => {
    const PLUMS = { asin: 'SYNTHKP001', title: 'Synthetic Fresh Keyless Plums' }, key = productKey(PLUMS);
    const RENAMED = { asin: PLUMS.asin, title: 'Synthetic Fresh 4111111111111111' };
    secrets = [PLUMS.asin, PLUMS.title, key, productKey(RENAMED), ORDER];
    await importAmazonCapture(db(), freshRead(1, [PLUMS]), backup());
    await stored(key, 'agent', PRODUCE, 0.9);
    const list = active();
    // The re-read's line, matched by its ASIN, has a title the guard holds: no key to adopt or map.
    expect((await importAmazonCapture(db(), freshRead(2, [RENAMED]), backup())).holds)
      .toContainEqual({ reason: 'taxonomy-unmatched', count: 1 });
    expect(active()).toBe(list);
    const identity = freshLineIdentities(ORDER, freshLines([PLUMS])).get(0)!;
    const renamed = freshLineIdentities(ORDER, freshLines([RENAMED])).get(0)!;
    secrets.push(identity, renamed);
    const { printed, holds, output } = await worklist();
    expect(printed).toEqual(counts({ fresh: { 'card-data-guard': 1 } }));
    // The hold names the displayed line (its public title); the guarded title of the re-read is never written.
    expect(holds).toEqual([{ family: 'fresh', lineIdentity: identity, reason: 'card-data-guard',
      held: { node: PRODUCE, source: 'agent', confidence: 0.9 }, product: lineProductPin('fresh', identity, key), productKey: key,
      asin: PLUMS.asin, title: PLUMS.title }]);
    const { file } = await planAndImport(lineDecision([decide(holds[0], PRODUCE)]), counts({ fresh: { 'card-data-guard': 1 } }));
    expect(active()).toBe(list);
    expect(freshView()).toEqual([owner(PRODUCE, PLUMS.title, PLUMS.asin)]);
    // The next real re-read replaces the list, unheld, and the owner's decision moves to the renamed line's identity.
    const next = await importAmazonCapture(db(), freshRead(3, [RENAMED]), backup());
    expect(next.holds.map((h) => h.reason)).not.toContain('taxonomy-unmatched');
    expect(active()).not.toBe(list);
    expect(audits('taxonomy-line-owner-carried')).toBe(1);
    // The decision moved with its line: it leaves the identity the line no longer has.
    expect(lineRows().map((row) => [row.line_identity, row.asin, row.node])).toEqual([[renamed, PLUMS.asin, PRODUCE]]);
    expect(freshView()).toEqual([owner(PRODUCE, '[redacted]', PLUMS.asin)]);
    expect(amazonFreshOrder(db(), REF)!.lines.map((line) => [line.title, line.node, line.source])).toEqual([['[redacted]', PRODUCE, 'owner']]);
    // Once decided, no read of it is held again: a later re-read back under the public title replaces the list too, and
    // the decision moves back with the line.
    const back = await importAmazonCapture(db(), freshRead(4, [PLUMS]), backup());
    expect(back.holds.map((h) => h.reason)).not.toContain('taxonomy-unmatched');
    expect(lineRows().map((row) => [row.line_identity, row.asin, row.node])).toEqual([[identity, PLUMS.asin, PRODUCE]]);
    expect(freshView()).toEqual([owner(PRODUCE, PLUMS.title, PLUMS.asin)]);
    guardedNowhere(RENAMED.title, output, file);
  });

  it('refuses a stale line decision whole (line-decision-stale): at plan and before any backup, and inside the write', async () => {
    const MUG = { asin: 'SYNTHKM002', title: 'Synthetic Keyless Travel Mug' }, key = productKey(MUG);
    secrets = [MUG.asin, MUG.title, key, ORDER];
    const first = orderRead(1, [MUG, MUG]);
    await importAmazonCapture(db(), first, backup());
    await stored(key, 'agent', KITCHEN, 0.9);
    await importAmazonCapture(db(), orderRead(2, [MUG, MUG]), backup());
    secrets.push(...lineTieKeys(first.staging.orders[0] as OrderObservation).values());
    const shown = displayed();
    const state = () => JSON.stringify({ lines: hasAmazonLineTaxonomySchema(db()), rows: lineRows(),
      decided: audits('taxonomy-line-decisions'), display: displayed() });
    const stale = (decided: number, changed: number) =>
      `amazon-taxonomy: line-decision-stale ${JSON.stringify({ entries: 2, decided, changed })}\n`;
    // The held decision changed after the worklist was written (the owner filed the product under GO): stale.
    const agentHeld = lineDecision((await worklist()).holds.map((hold) => decide(hold, OUTDOORS)));
    const ownerFiled = goFor(productMapping([{ productKey: key, node: KITCHEN, confidence: 1, source: 'owner' }]),
      AMAZON_TAXONOMY_SCHEMA_DIGEST);
    await ok(['import', '--db', database(), '--input', ownerFiled.file, '--backup', backup(), '--root-go', ownerFiled.go]);
    const before = state(), never = backup(), { file, go } = goFor(agentHeld);
    expect(await refused(['plan', '--db', database(), '--input', file])).toBe(stale(0, 2));
    expect(await refused(['import', '--db', database(), '--input', file, '--backup', never, '--root-go', go])).toBe(stale(0, 2));
    expect(fs.existsSync(never)).toBe(false);
    expect(state()).toBe(before);
    // Written again, it pins the owner's decision. Another connection changes that decision after the import's read-only
    // plan and its backup, just before its write: the check inside the write transaction refuses the whole mapping, and
    // nothing is written, not even the table it would have installed.
    const ownerHolds = (await worklist()).holds;
    expect(ownerHolds.map((hold) => hold.held)).toEqual([{ node: KITCHEN, source: 'owner', confidence: 1 },
      { node: KITCHEN, source: 'owner', confidence: 1 }]);
    const ownerHeld = lineDecision(ownerHolds.map((hold) => decide(hold, OUTDOORS)));
    const raced = goFor(ownerHeld), race = backup();
    const original = Database.prototype.backup;
    let competed = false;
    Database.prototype.backup = async function (this: Database.Database, ...args: Parameters<typeof original>) {
      const result = await original.apply(this, args);
      if (args[0] === race) {
        const other = new Database(database());
        try {
          other.prepare("UPDATE amazon_product_taxonomy SET node=? WHERE product_key=? AND source='owner'").run(OUTDOORS, key);
        } finally { other.close(); }
        competed = true;
      }
      return result;
    };
    let answer: string;
    try { answer = await refused(['import', '--db', database(), '--input', raced.file, '--backup', race, '--root-go', raced.go]); }
    finally { Database.prototype.backup = original; }
    expect(competed).toBe(true);
    expect(answer).toBe(stale(0, 2));
    expect(fs.existsSync(race)).toBe(true);
    expect(state()).toBe(before);
    expect(hasAmazonLineTaxonomySchema(db())).toBe(false);
    // Written again, it applies once; the same mapping again is stale (decided), and the display is still untouched.
    const current = lineDecision((await worklist()).holds.map((hold) => decide(hold, OUTDOORS)));
    await planAndImport(current, counts({ ordinary: { 'ambiguous-match': 2 } }));
    const again = goFor(current);
    expect(await refused(['import', '--db', database(), '--input', again.file, '--backup', backup(), '--root-go', again.go]))
      .toBe(stale(2, 0));
    // Another mapping naming the same lines (another node, so another digest, never applied): each entry's line now has a
    // decision stored, so each is counted decided.
    const other = goFor(lineDecision(current.entries.map((entry) => ({ ...(entry as Record<string, unknown>), node: KITCHEN }))));
    expect(await refused(['plan', '--db', database(), '--input', other.file])).toBe(stale(2, 0));
    expect(await refused(['import', '--db', database(), '--input', other.file, '--backup', backup(), '--root-go', other.go]))
      .toBe(stale(2, 0));
    expect(displayed()).toBe(shown);
    expect(audits('taxonomy-line-decisions')).toBe(1);
  });

  it('refuses a malformed line decision, or a GO not pinned to the line decision table, before any backup or write', async () => {
    const MUG = { asin: 'SYNTHKM003', title: 'Synthetic Keyless Espresso Mug' }, key = productKey(MUG);
    secrets = [MUG.asin, MUG.title, key, ORDER];
    await importAmazonCapture(db(), orderRead(1, [MUG, MUG]), backup());
    await stored(key, 'agent', KITCHEN, 0.9);
    await importAmazonCapture(db(), orderRead(2, [MUG, MUG]), backup());
    const { holds } = await worklist();
    const valid = decide(holds[0], OUTDOORS);
    const variants: Array<[string, unknown]> = [
      ['no entries', lineDecision([])], ['not reviewed', { ...lineDecision([valid]), reviewed: false }],
      ['another taxonomy version', { ...lineDecision([valid]), taxonomyVersion: 2 }], ['extra field', { ...lineDecision([valid]), note: 'x' }],
      ['an identity that is no ref', lineDecision([{ ...valid, lineIdentity: 'amz-synthetic' }])],
      ['a product key for an identity', lineDecision([{ ...valid, lineIdentity: key }])],
      ['no product pin', lineDecision([(({ product: _product, ...entry }) => entry)(valid)])],
      ['a pin that is no ref', lineDecision([{ ...valid, product: 'amz-synthetic' }])],
      ['a product key for a pin', lineDecision([{ ...valid, product: key }])],
      ['twice the same line', lineDecision([valid, { ...valid, node: KITCHEN }])],
      ['another family', lineDecision([{ ...valid, family: 'groceries' }])], ['another reason', lineDecision([{ ...valid, reason: 'other' }])],
      ['an unknown node', lineDecision([{ ...valid, node: 'kitchen' }])], ['no held decision', lineDecision([{ ...valid, held: null }])],
      ['an owner held below 1', lineDecision([{ ...valid, held: { node: KITCHEN, source: 'owner', confidence: 0.9 } }])],
      ['a held decision with a title', lineDecision([{ ...valid, held: { ...valid.held, title: MUG.title } }])],
      ['an entry with a title', lineDecision([{ ...valid, title: MUG.title }])],
      ['an adoption kind', { ...lineDecision([valid]), kind: 'adoption' }],
    ];
    const before = snapshot();
    for (const [what, input] of variants) {
      const { file, go } = goFor(input), never = backup();
      expect(await refused(['plan', '--db', database(), '--input', file]), what).toBe('amazon-taxonomy: input-refused HoldrRefusal\n');
      expect(await refused(['import', '--db', database(), '--input', file, '--backup', never, '--root-go', go]), what)
        .toBe('amazon-taxonomy: input-refused HoldrRefusal\n');
      expect(fs.existsSync(never), what).toBe(false);
    }
    // The GO pins the one table the import may install: a line decision under the assignment table's schema refuses, and
    // so does a product mapping under the line decision table's.
    const decision = lineDecision([valid]), product = productMapping([{ productKey: key, node: KITCHEN, confidence: 1, source: 'owner' }]);
    for (const [input, schema] of [[decision, AMAZON_TAXONOMY_SCHEMA_DIGEST], [product, AMAZON_TAXONOMY_LINE_SCHEMA_DIGEST]] as const) {
      const { file, go } = goFor(input, schema), never = backup();
      expect(await refused(['import', '--db', database(), '--input', file, '--backup', never, '--root-go', go]))
        .toBe('amazon-taxonomy: input-refused HoldrRefusal\n');
      expect(fs.existsSync(never)).toBe(false);
    }
    expect(snapshot()).toBe(before);
    expect(hasAmazonLineTaxonomySchema(db())).toBe(false);
  });

  it.each(['ordinary', 'fresh'] as const)('%s lines: a decision reviewed for one product never files another that later takes its line identity', async (family) => {
    // Found in review (bd744359): identities are occurrence-based, so after a real replacement another product of the same
    // title can hold a reviewed line's identity, held for the same reason with the identical held decision. Each entry pins
    // the product the owner reviewed (a digest), so the old mapping is refused whole, at plan and before any backup.
    const A = { asin: 'SYNTHKA101', title: 'Synthetic Keyless Same Name' }, B = { asin: 'SYNTHKB101', title: A.title };
    secrets = [A.asin, B.asin, A.title, productKey(A), productKey(B), ORDER];
    const read = (run: number, lines: Array<[number, Product]>) => importAmazonCapture(db(), family === 'ordinary'
      ? itemsRead(run, lines) : freshRead(run, lines.map(([, line]) => line), 200), backup());
    await read(1, [[1, A]]);
    for (const product of [A, B]) await stored(productKey(product), 'agent', PRODUCE, 0.9);
    await read(2, [[1, A], [2, A]]);
    const [reviewed, ...none] = (await worklist()).holds;
    expect([none, reviewed.family, reviewed.reason, reviewed.asin]).toEqual([[], family, 'ambiguous-match', A.asin]);
    secrets.push(reviewed.lineIdentity, reviewed.product);
    const { file, go } = goFor(lineDecision([decide(reviewed, OUTDOORS)]));
    expect(await ok(['plan', '--db', database(), '--input', file])).toMatchObject({ entries: 1, insert: 1 });
    // A's line is unique in a real re-read, which replaces the display; B, of the same title, now holds A's line identity,
    // and a later re-read holds B for the same reason, with the identical held decision.
    expect((await read(3, [[0, B], [1, A]])).holds.map((h) => h.reason)).not.toContain('taxonomy-unmatched');
    await read(4, [[0, B], [1, A], [2, B]]);
    const [current, ...rest] = (await worklist()).holds;
    expect([rest, current.lineIdentity, current.reason, current.held, current.asin])
      .toEqual([[], reviewed.lineIdentity, reviewed.reason, reviewed.held, B.asin]);
    expect(current.product).not.toBe(reviewed.product);
    secrets.push(current.product);
    const state = () => JSON.stringify([snapshot(), family === 'fresh' ? active() : null]), before = state(), never = backup();
    const stale = `amazon-taxonomy: line-decision-stale ${JSON.stringify({ entries: 1, decided: 0, changed: 1 })}\n`;
    expect(await refused(['plan', '--db', database(), '--input', file])).toBe(stale);
    expect(await refused(['import', '--db', database(), '--input', file, '--backup', never, '--root-go', go])).toBe(stale);
    expect(fs.existsSync(never)).toBe(false);
    expect(state()).toBe(before);
    expect(hasAmazonLineTaxonomySchema(db())).toBe(false);
    // The owner's decision for B's line, as it is now, applies, to B.
    await planAndImport(lineDecision([decide(current, KITCHEN)]),
      family === 'ordinary' ? counts({ ordinary: { 'ambiguous-match': 1 } }) : counts({ fresh: { 'ambiguous-match': 1 } }));
    expect(lineRows().map((row) => [row.line_identity, row.asin, row.node])).toEqual([[current.lineIdentity, B.asin, KITCHEN]]);
  });

  it.each([['ordinary', false], ['fresh', false], ['ordinary', true], ['fresh', true]] as const)(
    '%s lines, in the backup gap (the same mapping applied there: %s): a line another product took is refused inside the write',
    async (family, nested) => {
      // Found in review (de5c612d): the import's read-only check passes while A's line is held. After its backup and before
      // its write, genuine reads give A's line identity to B, held with the identical tuple, with or without the same
      // mapping GO'd and applied to A in between. The check inside the write refuses the whole mapping; nothing is written.
      const A = { asin: 'SYNTHKA102', title: 'Synthetic Keyless Gap Name' }, B = { asin: 'SYNTHKB102', title: A.title };
      secrets = [A.asin, B.asin, A.title, productKey(A), productKey(B), ORDER];
      const read = (run: number, lines: Array<[number, Product]>) => importAmazonCapture(db(), family === 'ordinary'
        ? itemsRead(run, lines) : freshRead(run, lines.map(([, line]) => line), 200), backup());
      await read(1, [[1, A]]);
      for (const product of [A, B]) await stored(productKey(product), 'agent', PRODUCE, 0.9);
      await read(2, [[1, A], [2, A]]);
      const [reviewed] = (await worklist()).holds;
      secrets.push(reviewed.lineIdentity, reviewed.product);
      const mapping = lineDecision([decide(reviewed, OUTDOORS)]);
      const outer = goFor(mapping), race = backup();
      const state = () => JSON.stringify([snapshot(), family === 'fresh' ? active() : null]);
      const original = Database.prototype.backup;
      let gap: string | null = null;
      Database.prototype.backup = async function (this: Database.Database, ...args: Parameters<typeof original>) {
        const result = await original.apply(this, args);
        if (args[0] === race && gap === null) {
          gap = '';
          if (nested) {
            const inner = goFor(mapping);
            await ok(['import', '--db', database(), '--input', inner.file, '--backup', backup(), '--root-go', inner.go]);
          }
          expect((await read(3, [[0, B], [1, A]])).holds.map((h) => h.reason)).not.toContain('taxonomy-unmatched');
          await read(4, [[0, B], [1, A], [2, B]]);
          gap = state();
        }
        return result;
      };
      let answer: string;
      try { answer = await refused(['import', '--db', database(), '--input', outer.file, '--backup', race, '--root-go', outer.go]); }
      finally { Database.prototype.backup = original; }
      expect(answer).toBe(`amazon-taxonomy: line-decision-stale ${JSON.stringify(nested
        ? { entries: 1, decided: 1, changed: 0 } : { entries: 1, decided: 0, changed: 1 })}\n`);
      expect(fs.existsSync(race)).toBe(true);
      expect(state()).toBe(gap);
      // B holds A's old identity, undecided; A's line is decided only by the application in the gap, when there was one.
      expect((await worklist()).holds.map((hold) => [hold.lineIdentity, hold.asin])).toEqual([[reviewed.lineIdentity, B.asin]]);
      expect(lineRows().map((row) => [row.asin, row.node])).toEqual(nested ? [[A.asin, OUTDOORS]] : []);
    });

  it('a mapping applies once: after its decision moves with its line, a later line of the same product at its identity is not decided by it', async () => {
    // A superset re-read reveals an earlier line of the decided line's product and title: the decision moves with its line to
    // the next occurrence, and the revealed line, the same product, takes the identity the mapping names. When a later
    // re-read holds it with the identical tuple, the mapping names it exactly (its product pin included), but has applied.
    const MUG = { asin: 'SYNTHKM006', title: 'Synthetic Keyless Replay Mug' }, key = productKey(MUG);
    secrets = [MUG.asin, MUG.title, key, ORDER];
    await importAmazonCapture(db(), itemsRead(1, [[1, MUG]]), backup());
    await stored(key, 'agent', KITCHEN, 0.9);
    await importAmazonCapture(db(), itemsRead(2, [[1, MUG], [2, MUG]]), backup());
    const [reviewed] = (await worklist()).holds;
    secrets.push(reviewed.lineIdentity, reviewed.product);
    const mapping = lineDecision([decide(reviewed, OUTDOORS)]);
    await planAndImport(mapping, counts({ ordinary: { 'ambiguous-match': 1 } }));
    expect((await importAmazonCapture(db(), itemsRead(3, [[0, MUG], [1, MUG]]), backup())).holds.map((h) => h.reason))
      .not.toContain('taxonomy-unmatched');
    expect(audits('taxonomy-line-owner-carried')).toBe(1);
    await importAmazonCapture(db(), itemsRead(4, [[0, MUG], [1, MUG], [2, MUG]]), backup());
    const [again, ...none] = (await worklist()).holds;
    expect([none, again.lineIdentity, again.reason, again.held, again.product])
      .toEqual([[], reviewed.lineIdentity, reviewed.reason, reviewed.held, reviewed.product]);
    const before = snapshot(), never = backup(), { file, go } = goFor(mapping);
    const stale = `amazon-taxonomy: line-decision-stale ${JSON.stringify({ entries: 1, decided: 1, changed: 0 })}\n`;
    expect(await refused(['plan', '--db', database(), '--input', file])).toBe(stale);
    expect(await refused(['import', '--db', database(), '--input', file, '--backup', never, '--root-go', go])).toBe(stale);
    expect(fs.existsSync(never)).toBe(false);
    expect(snapshot()).toBe(before);
  });

  it('ordinary lines: a decided line keeps its decision when a superset re-read reveals, before it, an unread line of its title', async () => {
    // Line ordinals are positions, so a superset may reveal a line an earlier read left unread (a gap) before a decided
    // line of the same title: lineTieKeys' occurrence moves on, and so does the decided line's identity. Its own line (at
    // its position) takes the owner's decision with it to its new identity, audited.
    const KETTLE = { asin: 'SYNTHKK001', title: 'Synthetic Keyless Kettle' }, REVEALED = { asin: 'SYNTHKK002', title: KETTLE.title };
    const first = itemsRead(1, [[1, KETTLE]]), second = itemsRead(2, [[0, REVEALED], [1, KETTLE]]);
    await importAmazonCapture(db(), first, backup());
    await stored(productKey(KETTLE), 'agent', KITCHEN, 0.9);
    const decided = lineTieKeys(first.staging.orders[0] as OrderObservation).get(1)!;
    const moved = lineTieKeys(second.staging.orders[0] as OrderObservation).get(1)!;
    expect(moved).not.toBe(decided);
    await decideLines('ordinary', [[decided, KETTLE.asin, OUTDOORS]]);
    const shown = displayed();
    const receipt = await importAmazonCapture(db(), second, backup());
    expect(receipt.holds.map((h) => h.reason)).not.toContain('taxonomy-unmatched');
    expect(displayed()).not.toBe(shown);
    expect(audits('taxonomy-line-owner-carried')).toBe(1);
    expect(lineRows().map((row) => [row.line_identity, row.asin, row.node, row.mapping_digest]))
      .toEqual([[moved, KETTLE.asin, OUTDOORS, 'c'.repeat(64)]]);
    // The revealed line now holds the identity the decision left: another product, never decided, so it is not filed there.
    expect(taxonomyView().sort(byAsin)).toEqual([owner(OUTDOORS, KETTLE.title, KETTLE.asin),
      { node: 'needs-review', source: null, confidence: null, title: KETTLE.title, asin: REVEALED.asin, lines: 1 }]);
  });

  it('ordinary lines: decided twins keep their own decisions when a superset reveals a line of their title before them', async () => {
    // Both decided twins' identities shift; each decision moves to its own twin's place, as one set (the first moves onto
    // the place the second leaves), and the revealed line, another product, inherits neither.
    const MUG = { asin: 'SYNTHKT001', title: 'Synthetic Keyless Twin Cup' }, REVEALED = { asin: 'SYNTHKT002', title: MUG.title };
    const first = itemsRead(1, [[1, MUG], [2, MUG]]);
    await importAmazonCapture(db(), first, backup());
    const ids = lineTieKeys(first.staging.orders[0] as OrderObservation);
    await decideLines('ordinary', [[ids.get(1)!, MUG.asin, KITCHEN], [ids.get(2)!, MUG.asin, OUTDOORS]]);
    expect(taxonomyView()).toEqual([owner(KITCHEN, MUG.title, MUG.asin), owner(OUTDOORS, MUG.title, MUG.asin)]);
    const second = itemsRead(2, [[0, REVEALED], [1, MUG], [2, MUG]]), shown = displayed();
    expect((await importAmazonCapture(db(), second, backup())).holds.map((h) => h.reason)).not.toContain('taxonomy-unmatched');
    expect(displayed()).not.toBe(shown);
    const next = lineTieKeys(second.staging.orders[0] as OrderObservation);
    expect(lineRows().map((row) => [row.line_identity, row.node]).sort())
      .toEqual([[next.get(1)!, KITCHEN], [next.get(2)!, OUTDOORS]].sort());
    expect(taxonomyView()).toEqual([owner(KITCHEN, MUG.title, MUG.asin),
      { node: 'needs-review', source: null, confidence: null, title: MUG.title, asin: REVEALED.asin, lines: 1 }, owner(OUTDOORS, MUG.title, MUG.asin)]);
  });

  it('ordinary lines: decided lines keep their own decisions when a complete re-read lists them in another order (Root, 2026-11-23)', async () => {
    // Line order is not a fact: a re-read that proves its items complete and lists the same lines the other way round
    // replaces the display, and each owner decision goes with its own item (paired by its ASIN), never with its position.
    // The two lines share a title, so the swap also swaps their identities (lineTieKeys' occurrence): both decisions
    // move, as one set.
    const RED = { asin: 'SYNTHKR001', title: 'Synthetic Keyless Reorder Cup' }, BLUE = { asin: 'SYNTHKR002', title: RED.title };
    const first = itemsRead(1, [[0, RED], [1, BLUE]]), second = itemsRead(2, [[0, BLUE], [1, RED]]);
    second.staging.orders[0].itemProof = { complete: true, unknownLine: false, conflict: false };
    await importAmazonCapture(db(), first, backup());
    const ids = lineTieKeys(first.staging.orders[0] as OrderObservation);
    await decideLines('ordinary', [[ids.get(0)!, RED.asin, KITCHEN], [ids.get(1)!, BLUE.asin, OUTDOORS]]);
    expect(taxonomyView()).toEqual([owner(KITCHEN, RED.title, RED.asin), owner(OUTDOORS, BLUE.title, BLUE.asin)]);
    const shown = displayed();
    expect((await importAmazonCapture(db(), second, backup())).holds.map((h) => h.reason)).not.toContain('taxonomy-unmatched');
    expect(displayed()).not.toBe(shown);
    expect(audits('taxonomy-line-owner-carried')).toBe(2);
    const next = lineTieKeys(second.staging.orders[0] as OrderObservation);
    expect(lineRows().map((row) => [row.line_identity, row.asin, row.node]).sort())
      .toEqual([[next.get(1)!, RED.asin, KITCHEN], [next.get(0)!, BLUE.asin, OUTDOORS]].sort());
    expect(taxonomyView()).toEqual([owner(KITCHEN, RED.title, RED.asin), owner(OUTDOORS, BLUE.title, BLUE.asin)]);
  });

  // Root's reviewers' cases for Fresh lists (all synthetic): each decided line's decision goes to its own line of the
  // re-read, as one set, and never to a line of another product.
  const TEA = 'Synthetic Fresh Keyless Tea', MUGS = 'Synthetic Fresh Keyless Mug';
  const FRESH_CASES: Array<{ name: string; before: Array<[Product, string | null]>; after: Product[];
    filed: Array<[string | null, string, string | null]> }> = [
    { name: 'a chain: a new line takes the first decided line\'s identity, which takes the second\'s',
      before: [[{ asin: 'SYNTHKCA01', title: TEA }, KITCHEN], [{ asin: 'SYNTHKCB01', title: TEA }, OUTDOORS]],
      after: [{ asin: 'SYNTHKCC01', title: TEA }, { asin: 'SYNTHKCA01', title: TEA }, { asin: 'SYNTHKCB01', title: TEA }],
      filed: [['SYNTHKCC01', 'needs-review', null], ['SYNTHKCA01', KITCHEN, 'owner'], ['SYNTHKCB01', OUTDOORS, 'owner']] },
    { name: 'a swap: two decided lines take each other\'s titles',
      before: [[{ asin: 'SYNTHKSA01', title: 'Synthetic Fresh Keyless Plums' }, KITCHEN],
        [{ asin: 'SYNTHKSB01', title: 'Synthetic Fresh Keyless Prunes' }, OUTDOORS]],
      after: [{ asin: 'SYNTHKSA01', title: 'Synthetic Fresh Keyless Prunes' }, { asin: 'SYNTHKSB01', title: 'Synthetic Fresh Keyless Plums' }],
      filed: [['SYNTHKSA01', KITCHEN, 'owner'], ['SYNTHKSB01', OUTDOORS, 'owner']] },
    { name: 'decided twins and a new line of their title before them',
      before: [[{ asin: 'SYNTHKMA01', title: MUGS }, KITCHEN], [{ asin: 'SYNTHKMA01', title: MUGS }, OUTDOORS]],
      after: [{ asin: 'SYNTHKMB01', title: MUGS }, { asin: 'SYNTHKMA01', title: MUGS }, { asin: 'SYNTHKMA01', title: MUGS }],
      filed: [['SYNTHKMB01', 'needs-review', null], ['SYNTHKMA01', KITCHEN, 'owner'], ['SYNTHKMA01', OUTDOORS, 'owner']] },
    { name: 'a decided line gone, and another product under its title in its place',
      before: [[{ asin: 'SYNTHKFA01', title: 'Synthetic Fresh Keyless Figs' }, KITCHEN]],
      after: [{ asin: 'SYNTHKFB01', title: 'Synthetic Fresh Keyless Figs' }],
      filed: [['SYNTHKFB01', 'needs-review', null]] },
    { name: 'a decided line without an ASIN beside a line of its title with one, read again unchanged',
      before: [[{ asin: 'SYNTHKLA01', title: 'Synthetic Fresh Keyless Limes' }, null], [{ asin: null, title: 'Synthetic Fresh Keyless Limes' }, SNACKS]],
      after: [{ asin: 'SYNTHKLA01', title: 'Synthetic Fresh Keyless Limes' }, { asin: null, title: 'Synthetic Fresh Keyless Limes' }],
      filed: [['SYNTHKLA01', 'needs-review', null], [null, SNACKS, 'owner']] },
    { name: 'a decided line learning its ASIN',
      before: [[{ asin: null, title: 'Synthetic Fresh Keyless Quinces' }, KITCHEN]],
      after: [{ asin: 'SYNTHKQA01', title: 'Synthetic Fresh Keyless Quinces' }],
      filed: [['SYNTHKQA01', KITCHEN, 'owner']] },
    { name: 'a decided line losing its ASIN',
      before: [[{ asin: 'SYNTHKQB01', title: 'Synthetic Fresh Keyless Medlars' }, KITCHEN]],
      after: [{ asin: null, title: 'Synthetic Fresh Keyless Medlars' }],
      filed: [[null, KITCHEN, 'owner']] },
    { name: 'a decided line gone beside a displayed line of its title without an ASIN, which the re-read keeps',
      before: [[{ asin: 'SYNTHKBA01', title: 'Synthetic Fresh Keyless Bananas' }, OUTDOORS], [{ asin: null, title: 'Synthetic Fresh Keyless Bananas' }, null]],
      after: [{ asin: null, title: 'Synthetic Fresh Keyless Bananas' }],
      filed: [[null, 'needs-review', null]] },
    { name: 'a decided line losing its ASIN before a line of its title without one',
      before: [[{ asin: 'SYNTHKPL01', title: 'Synthetic Fresh Keyless Plantains' }, OUTDOORS], [{ asin: null, title: 'Synthetic Fresh Keyless Plantains' }, null]],
      after: [{ asin: null, title: 'Synthetic Fresh Keyless Plantains' }, { asin: null, title: 'Synthetic Fresh Keyless Plantains' }],
      filed: [[null, OUTDOORS, 'owner'], [null, 'needs-review', null]] },
    { name: 'a decided line losing its ASIN before a decided line of its title without one',
      before: [[{ asin: 'SYNTHKLF01', title: 'Synthetic Fresh Keyless Ladyfingers' }, OUTDOORS],
        [{ asin: null, title: 'Synthetic Fresh Keyless Ladyfingers' }, SNACKS]],
      after: [{ asin: null, title: 'Synthetic Fresh Keyless Ladyfingers' }, { asin: null, title: 'Synthetic Fresh Keyless Ladyfingers' }],
      filed: [[null, OUTDOORS, 'owner'], [null, SNACKS, 'owner']] },
    { name: 'a decided line without an ASIN gone, and a displayed product\'s second line under its title in its place',
      before: [[{ asin: 'SYNTHKPE01', title: 'Synthetic Fresh Keyless Pears' }, null], [{ asin: null, title: 'Synthetic Fresh Keyless Pears' }, KITCHEN]],
      after: [{ asin: 'SYNTHKPE01', title: 'Synthetic Fresh Keyless Pears' }, { asin: 'SYNTHKPE01', title: 'Synthetic Fresh Keyless Pears' }],
      filed: [['SYNTHKPE01', 'needs-review', null], ['SYNTHKPE01', 'needs-review', null]] },
  ];
  it.each(FRESH_CASES)('Fresh lines, $name: each decision stays with its own line', async ({ before, after, filed }) => {
    const lines = before.map(([product]) => product);
    await importAmazonCapture(db(), freshRead(1, lines, 200), backup());
    const ids = freshLineIdentities(ORDER, freshLines(lines));
    await decideLines('fresh', before.flatMap(([product, node], n) => (node ? [[ids.get(n)!, product.asin, node] as const] : [])));
    const list = active();
    expect((await importAmazonCapture(db(), freshRead(2, after, 200), backup())).holds.map((h) => h.reason))
      .not.toContain('taxonomy-unmatched');
    expect(active()).not.toBe(list);
    expect(amazonFreshOrder(db(), REF)!.lines.map((line) => [line.asin, line.node, line.source])).toEqual(filed);
  });

  it('Fresh lines: a move whose place a staying decision holds is not made, and nothing is overwritten', async () => {
    // Decided twins; the second is gone from a re-read, so its decision stays where it was. When the remaining twin's own
    // line later takes that place, the staying decision keeps it (twins are one product): the import neither fails nor
    // overwrites, and no decision moves.
    const KIWI = { asin: 'SYNTHKW001', title: 'Synthetic Fresh Keyless Kiwis' }, OTHER = { asin: 'SYNTHKW002', title: KIWI.title };
    await importAmazonCapture(db(), freshRead(1, [KIWI, KIWI], 200), backup());
    const ids = freshLineIdentities(ORDER, freshLines([KIWI, KIWI]));
    await decideLines('fresh', [[ids.get(0)!, KIWI.asin, KITCHEN], [ids.get(1)!, KIWI.asin, OUTDOORS]]);
    expect((await importAmazonCapture(db(), freshRead(2, [KIWI], 200), backup())).holds.map((h) => h.reason)).not.toContain('taxonomy-unmatched');
    const rows = lineRows();
    expect(rows.map((row) => [row.line_identity, row.node])).toEqual([[ids.get(0)!, KITCHEN], [ids.get(1)!, OUTDOORS]]
      .sort(([a], [b]) => (a < b ? -1 : 1)));
    const list = active();
    expect((await importAmazonCapture(db(), freshRead(3, [OTHER, KIWI], 200), backup())).holds.map((h) => h.reason))
      .not.toContain('taxonomy-unmatched');
    expect(active()).not.toBe(list);
    expect(lineRows()).toEqual(rows);
    expect(audits('taxonomy-line-owner-carried')).toBe(0);
    expect(amazonFreshOrder(db(), REF)!.lines.map((line) => [line.asin, line.node, line.source]))
      .toEqual([[OTHER.asin, 'needs-review', null], [KIWI.asin, OUTDOORS, 'owner']]);
  });

  it('Fresh lines: a decision left by a vanished line never makes the other product now holding its identity look decided', async () => {
    const FIGS = { asin: 'SYNTHKG001', title: 'Synthetic Fresh Keyless Black Figs' }, OTHER = { asin: 'SYNTHKG002', title: FIGS.title };
    await importAmazonCapture(db(), freshRead(1, [FIGS], 200), backup());
    const identity = freshLineIdentities(ORDER, freshLines([FIGS])).get(0)!;
    await decideLines('fresh', [[identity, FIGS.asin, KITCHEN]]);
    await stored(productKey(OTHER), 'agent', PRODUCE, 0.9);
    // The decided line is gone; another product of its title takes its identity. The decision stays for its own product.
    expect((await importAmazonCapture(db(), freshRead(2, [OTHER], 200), backup())).holds.map((h) => h.reason))
      .not.toContain('taxonomy-unmatched');
    expect(lineRows().map((row) => [row.line_identity, row.asin, row.node])).toEqual([[identity, FIGS.asin, KITCHEN]]);
    expect(amazonFreshOrder(db(), REF)!.lines.map((line) => [line.asin, line.node, line.source])).toEqual([[OTHER.asin, PRODUCE, 'agent']]);
    // That line is undecided: Root's B2 rule holds it like any other when its match is not unique, a keyless hold.
    const list = active();
    expect((await importAmazonCapture(db(), freshRead(3, [OTHER, OTHER], 100), backup())).holds)
      .toContainEqual({ reason: 'taxonomy-unmatched', count: 1 });
    expect(active()).toBe(list);
    expect(taxonomyKeylessHolds(db()).map((hold) => [hold.lineIdentity, hold.reason, hold.asin])).toEqual([[identity, 'ambiguous-match', OTHER.asin]]);
  });

  it('Fresh lines: a decision moving with its renamed line never makes another, undecided displayed line look decided', async () => {
    // The decided line is renamed to another displayed line's title, so the identity its decision moves to is the one
    // that other line holds in the display. That line keeps following its own product decision (Root's B2 rule).
    const DAMSONS = { asin: 'SYNTHKD001', title: 'Synthetic Fresh Keyless Damsons' };
    const BAG = { asin: 'SYNTHKD002', title: 'Synthetic Fresh Keyless Damsons, 2 lb Bag' }, RENAMED = { asin: DAMSONS.asin, title: BAG.title };
    await importAmazonCapture(db(), freshRead(1, [DAMSONS, BAG]), backup());
    await stored(productKey(BAG), 'agent', PRODUCE, 0.9);
    const shownIds = freshLineIdentities(ORDER, freshLines([DAMSONS, BAG])), nextIds = freshLineIdentities(ORDER, freshLines([RENAMED, BAG]));
    expect(nextIds.get(0)).toBe(shownIds.get(1));
    await decideLines('fresh', [[shownIds.get(0)!, DAMSONS.asin, SNACKS]]);
    const list = active();
    const receipt = await importAmazonCapture(db(), freshRead(2, [RENAMED, BAG]), backup());
    expect(receipt.holds.map((h) => h.reason)).not.toContain('taxonomy-unmatched');
    expect(active()).not.toBe(list);
    expect(audits('taxonomy-line-owner-carried')).toBe(1);
    expect(lineRows().map((row) => [row.line_identity, row.node])).toEqual([[nextIds.get(0), SNACKS]]);
    expect(amazonFreshOrder(db(), REF)!.lines.map((line) => [line.asin, line.node, line.source, line.confidence]))
      .toEqual([[DAMSONS.asin, SNACKS, 'owner', 1], [BAG.asin, PRODUCE, 'agent', 0.9]]);
  });
});

describe('Keyless taxonomy holds: only what the import would hold is reported', () => {
  it('never an ordinary read that conflicts with the display: it is held for its own facts, not for the taxonomy', async () => {
    const MUG = { asin: 'SYNTHKM005', title: 'Synthetic Keyless Tin Mug' }, key = productKey(MUG);
    await importAmazonCapture(db(), orderRead(1, [MUG]), backup());
    await stored(key, 'agent', KITCHEN, 0.9);
    // The line's identity-matched line is not unique, but the read also differs from the display in a fact (its date).
    const conflicting = orderRead(2, [MUG, MUG]);
    conflicting.staging.orders[0].date = '2026-09-02';
    const receipt = await importAmazonCapture(db(), conflicting, backup());
    expect(receipt.holds.map((h) => h.reason)).not.toContain('taxonomy-unmatched');
    expect(audits('conflicting-observation-kept-details')).toBe(1);
    expect(taxonomyKeylessHolds(db())).toEqual([]);
  });

  it('never a Fresh list less proven than the active one, nor a list kept while a charge-free proof is displayed', async () => {
    const LIMES = { asin: null, title: 'Synthetic Fresh Keyless Key Limes' }, key = productKey(LIMES);
    await importAmazonCapture(db(), freshRead(1, [LIMES]), backup());
    await stored(key, 'agent', PRODUCE, 0.9);
    const list = active();
    // Two lines of the product that do not add up to the subtotal: a list less proven than the reconciled one, history.
    expect((await importAmazonCapture(db(), freshRead(2, [LIMES, LIMES], 400), backup())).holds.map((h) => h.reason))
      .not.toContain('taxonomy-unmatched');
    expect(active()).toBe(list);
    expect(taxonomyKeylessHolds(db())).toEqual([]);
    // While the order displays a charge-free proof, a re-read never replaces its list (B6): history, never a hold.
    await importAmazonCapture(db(), proven(3), backup());
    expect((await importAmazonCapture(db(), freshRead(4, [LIMES, LIMES]), backup())).holds.map((h) => h.reason))
      .not.toContain('taxonomy-unmatched');
    expect(audits('charge-free-kept-fresh-list')).toBe(1);
    expect(active()).toBe(list);
    expect(taxonomyKeylessHolds(db())).toEqual([]);
  });
});

describe('Keyless taxonomy holds: line identities, and reads that never install anything', () => {
  it('keeps a Fresh line\'s identity across re-reads that change capture-scoped values or its ASIN, apart from an order item\'s', () => {
    const lines = freshLines([{ asin: null, title: 'Synthetic Fresh Figs' }, { asin: 'SYNTHKF001', title: 'Synthetic Fresh Kale' },
      { asin: null, title: 'Synthetic Fresh Figs' }]);
    const ids = freshLineIdentities(ORDER, lines);
    expect(new Set(ids.values()).size).toBe(3);
    // The same list read in another order of its rows, with a learned or lost ASIN: every identity is kept.
    const reread = freshLines([{ asin: 'SYNTHKF002', title: 'Synthetic Fresh Figs' }, { asin: null, title: 'Synthetic Fresh Kale' },
      { asin: null, title: 'Synthetic Fresh Figs' }]);
    expect(freshLineIdentities(ORDER, [...reread].reverse())).toEqual(ids);
    // Another order, or an order item of the same title and position, is another line.
    expect([...freshLineIdentities('000-0000002-0000002', lines).values()].some((id) => [...ids.values()].includes(id))).toBe(false);
    const items = lines.map(({ lineOrdinal, title, asin }) => ({ lineOrdinal, itemId: asin, title, quantity: 1, unitPrice: null }));
    expect([...orderLineIdentities(ORDER, items).values()].some((id) => [...ids.values()].includes(id))).toBe(false);
    // An order item's is order-history v3's tie key; a read without line ordinals has none.
    expect(orderLineIdentities(ORDER, items)).toEqual(lineTieKeys({ orderId: ORDER, items } as unknown as OrderObservation));
    expect(orderLineIdentities(ORDER, items.map(({ lineOrdinal: _ordinal, ...item }) => item))).toEqual(new Map());
  });

  it('reports nothing and installs nothing without a hold: worklist and plan leave the database as they found it', async () => {
    const MUG = { asin: 'SYNTHKM004', title: 'Synthetic Keyless Steel Mug' }, key = productKey(MUG);
    secrets = [MUG.asin, MUG.title, key, ORDER];
    await importAmazonCapture(db(), orderRead(1, [MUG]), backup());
    await stored(key, 'agent', KITCHEN, 0.9);
    await importAmazonCapture(db(), orderRead(2, [MUG]), backup());
    const before = snapshot();
    expect((await worklist()).printed).toEqual(counts());
    const { file } = goFor(productMapping([{ productKey: key, node: KITCHEN, confidence: 0.9, source: 'agent' }]));
    expect(await ok(['plan', '--db', database(), '--input', file])).toMatchObject({ keylessHolds: counts() });
    expect(taxonomyKeylessHolds(db())).toEqual([]);
    expect(snapshot()).toBe(before);
  });
});

describe('Keyless holds in the Amazon item views (#178): a decided line is filed alike wherever its node is resolved', () => {
  it('an order item and a Fresh line, each decided: one category truth in the taxonomy view, the Fresh tab and the card view', async () => {
    // One ordinary order, counted by its items, and one Amazon Fresh order, counted by its Item List (#178): the item
    // taxonomy view files both families' lines, the Fresh tab the Fresh order's, and the card-category view a Fresh line by
    // its item category's card category (freshCardCategory). A line decision files its line alike in each (Root, STEP 10);
    // an order item keeps its card's category, and no money moves.
    const MUG = { asin: 'SYNTHKV001', title: 'Synthetic Keyless View Mug' }, GAGES = { asin: 'SYNTHKV002', title: 'Synthetic Fresh Keyless Gages' };
    const OTHER = '000-0000002-0000002';
    const ordinary = orderRead(1, [MUG, MUG]), fresh = freshRead(2, [GAGES, GAGES]);
    fresh.staging.orders[0].orderId = OTHER;
    (fresh.fresh as { lists: Array<{ orderId: string }> }).lists[0].orderId = OTHER;
    await importAmazonCapture(db(), ordinary, backup());
    await importAmazonCapture(db(), fresh, backup());
    await stored(productKey(MUG), 'agent', KITCHEN, 0.9);
    await stored(productKey(GAGES), 'agent', PRODUCE, 0.9);
    const mug = { node: KITCHEN, source: 'agent', confidence: 0.9, title: MUG.title, asin: MUG.asin };
    const gages = { node: PRODUCE, source: 'agent', confidence: 0.9, title: GAGES.title, asin: GAGES.asin };
    expect(taxonomyView()).toEqual([{ ...gages, lines: 2 }, { ...mug, lines: 2 }]);
    expect(freshView()).toEqual([{ ...gages, lines: 2 }]);
    const cardRows = (asin: string) => amazonSpending(db(), '60D', TODAY).products.filter((product) => product.asin === asin)
      .map(({ category, categorySource, lines, amountMinor, refundMinor }) => ({ category, categorySource, lines, amountMinor, refundMinor }))
      .sort((a, b) => String(a.category).localeCompare(String(b.category)));
    const produceCard = amazonTaxonomyNode(PRODUCE)!.cardCategory, cablesCard = amazonTaxonomyNode(CABLES)!.cardCategory;
    // The Fresh line's decision names a node of another card category, so the card view shows whether it follows.
    expect(cablesCard).not.toBe(produceCard);
    expect(cardRows(GAGES.asin)).toEqual([{ category: produceCard, categorySource: 'item-taxonomy', lines: 2, amountMinor: 1000, refundMinor: 0 }]);
    const mugCard = cardRows(MUG.asin);
    const money = () => {
      const view = amazonTaxonomySpending(db(), '60D', TODAY), tab = amazonFresh(db(), '2Y', TODAY), card = amazonSpending(db(), '60D', TODAY);
      return JSON.stringify([view.totals.map(({ currency, itemMinor, refundMinor, itemRefundMinor, unattributedRefundMinor }) =>
        ({ currency, itemMinor, refundMinor, itemRefundMinor, unattributedRefundMinor })), view.fresh,
        tab.totals.map(({ currency, orderTotalMinor, lineMinor, refundMinor, lineRefundMinor, unattributedRefundMinor, netLineMinor }) =>
          ({ currency, orderTotalMinor, lineMinor, refundMinor, lineRefundMinor, unattributedRefundMinor, netLineMinor })),
        card.fresh, card.categories.reduce((n, category) => n + category.amountMinor - category.refundMinor, 0)]);
    };
    const before = money();
    expect(amazonFresh(db(), '2Y', TODAY).totals.map((sums) => sums.groceryMinor)).toEqual([1000]);
    await decideLines('ordinary', [[lineTieKeys(ordinary.staging.orders[0] as OrderObservation).get(1)!, MUG.asin, OUTDOORS]]);
    await decideLines('fresh', [[freshLineIdentities(OTHER, freshLines([GAGES, GAGES])).get(1)!, GAGES.asin, CABLES]]);
    expect(taxonomyView()).toEqual([owner(CABLES, GAGES.title, GAGES.asin), { ...gages, lines: 1 }, { ...mug, lines: 1 },
      owner(OUTDOORS, MUG.title, MUG.asin)]);
    expect(freshView()).toEqual([owner(CABLES, GAGES.title, GAGES.asin), { ...gages, lines: 1 }]);
    expect(amazonFreshOrder(db(), opaque('order', OTHER))!.lines.map((line) => [line.node, line.source]))
      .toEqual([[PRODUCE, 'agent'], [CABLES, 'owner']]);
    // The card view: the decided Fresh line takes its decided node's card category; the order item keeps its card's.
    expect(cardRows(GAGES.asin)).toEqual([
      { category: cablesCard, categorySource: 'item-taxonomy', lines: 1, amountMinor: 500, refundMinor: 0 },
      { category: produceCard, categorySource: 'item-taxonomy', lines: 1, amountMinor: 500, refundMinor: 0 },
    ].sort((a, b) => a.category.localeCompare(b.category)));
    expect(cardRows(MUG.asin)).toEqual(mugCard);
    expect(money()).toBe(before);
    // Only where the decided Fresh line is filed moved: out of Groceries, on the Fresh tab as in both item views.
    expect(amazonFresh(db(), '2Y', TODAY).totals.map((sums) => sums.groceryMinor)).toEqual([500]);
  });
});
