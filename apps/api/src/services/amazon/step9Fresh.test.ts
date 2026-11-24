import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SqliteStateRepo } from '../sqliteStateRepo.js';
// STEP 9 integration (B4)
import { backedUpWrite, importAmazonCapture, recordBindingProposal, recordRootApproval } from './importer.js';
import { proposeBindings, readCardInventory } from './bindings.js';
import { rootApproval, syntheticCapture } from './fixtures.testSupport.js';
import { amazonFresh, amazonFreshOrder } from './fresh.js';
import { freshTaxonomyObservations, readFreshOrders } from './freshAdapter.js';
// STEP 9 integration B8 (Root, bd744359): the GO'd taxonomy CLI and every consumer a held Fresh line's learned key must reach.
import {
  amazonDatabase, assignFreshHousehold, each, freshDatabase, freshLine, seedFreshHousehold, seedFreshList, seedOrder,
} from './freshFixtures.testSupport.js';
import { digest, opaque, SOURCE } from './policy.js';
import { productKey } from './products.js';
import {
  AMAZON_TAXONOMY_DIGEST, AMAZON_TAXONOMY_MAPPING_FORMAT, AMAZON_TAXONOMY_SCHEMA_DIGEST, installAmazonTaxonomySchema,
  knownTaxonomyProductKeys, planTaxonomyImport, readTaxonomyAssignments, taxonomyWorklist,
} from './taxonomy.js';
import { taxonomyAdoptionMapping, taxonomyKeyAdoptions, taxonomyKeyChanges } from './taxonomyKeyAdoptions.js';
import { categoryKeyAdoptions } from './ownerDecisions.js';
import { applyAgentReview } from './categorization.js';
import { runAmazonTaxonomyCli } from '../../cli/amazonTaxonomy.js';
import { readCurrentUserSid, restrictToUser } from '../../e2e/windowsAcl.js';
import type { Money } from './types.js';

// STEP 9 integration regressions for the Root-ordered Amazon Fresh hunks of #175. Entirely synthetic: made-up order IDs,
// titles, ASINs, card endings and prices; no network.
const TODAY = '2026-10-19';
const ORDER = '000-0000001-0000001', REF = opaque('order', ORDER);
const PROOF = { status: 'cancelled-not-charged', shipments: 1 } as const;
const usd = (amountMinor: number): Money => ({ currency: 'USD', amountMinor });
const runId = (run: number) => `00000000-0000-4000-8000-${String(run).padStart(12, '0')}`;
const line = (lineOrdinal: number, title: string, patch: Record<string, unknown> = {}) => ({ lineOrdinal, title, asin: null,
  status: 'listed', quantity: 1, weight: null, unitPrice: null, linePrice: usd(500), replaces: null, ...patch });
/** The synthetic order with its Item List; by default bd744359's case: two 500-cent lines reconciled to its $10.00 subtotal. */
function freshCapture(run: number, lines = [line(0, 'Synthetic Fresh Gala Apples'), line(1, 'Synthetic Fresh Rye Bread')],
  orderId = ORDER) {
  const capture = syntheticCapture() as ReturnType<typeof syntheticCapture> & { fresh?: unknown };
  capture.staging.runId = runId(run);
  capture.staging.orders[0].orderId = orderId;
  const reconciled = lines.reduce((n, l) => n + ((l.linePrice as Money | null)?.amountMinor ?? 0), 0) === 1000;
  capture.fresh = { format: 'holdr.amazon-fresh-item-lists', version: 1,
    lists: [{ orderId, statedCount: lines.length, rows: lines.length, proof: { complete: true, unreadRows: 0 }, reconciled, lines }],
    diagnostics: [{ ordinal: 0, status: 'read', reason: null, rows: lines.length, lines: lines.length, unread: [] }] };
  return capture;
}
/** Amazon's closed positive statement that the order was cancelled and never charged, read as an empty header (#158). */
function proven(run: number) {
  const capture = syntheticCapture(), o = capture.staging.orders[0];
  capture.staging.runId = runId(run);
  o.items = []; o.paymentMethods = []; o.summary = []; o.tenderCoverage = 'unknown'; o.total = null;
  o.tenderProof = { methodComplete: false, summaryComplete: false, unknownMethod: false, unknownSummary: false, conflict: false };
  o.chargeFree = { ...PROOF };
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

let dir: string, repo: SqliteStateRepo, backupNumber: number;
const db = () => repo.internalGetDb();
const backup = () => path.join(dir, `backup-${++backupNumber}.db`);
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-step9-fresh-synthetic-')); backupNumber = 0;
  repo = new SqliteStateRepo({ file: path.join(dir, 'synthetic.db') });
});
afterEach(() => { repo.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('STEP 9 integration B6 (#158 x #157/#169): a displayed charge-free proof counts the order\'s Fresh lines as 0', () => {
  // A card the owner bound to the synthetic order's visa ending; a later charge of the order's total is card evidence that
  // revokes the proof (Root's live guard).
  const bindCard = async () => {
    const card = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9001', currency: 'USD' });
    const proposal = proposeBindings([{ network: 'visa', last4: '9001', cardAccountId: card.id }], readCardInventory(db()));
    await recordBindingProposal(db(), proposal, backup());
    await recordRootApproval(db(), proposal, rootApproval(proposal), backup());
    return card.id;
  };
  const chargeCard = (cardAccountId: string) => repo.importCardTransactions({ cardAccountId, source: 'synthetic',
    parserVersion: 'synthetic@1', rows: [{ transactionDate: '2026-09-02', status: 'posted', kind: 'purchase', currency: 'USD',
      amountMinor: 1100, description: 'AMAZON SYNTHETIC FRESH CHARGE', issuerCategory: 'Shopping' }] });
  /** Every Fresh answer: the tab's window, the order's detail, the adapter's three scopes and the taxonomy's observations. */
  const answers = (orderRef = REF) => ({ view: amazonFresh(db(), '2Y', TODAY), detail: amazonFreshOrder(db(), orderRef),
    reads: [readFreshOrders(db(), 'all'), readFreshOrders(db(), { orderRef }), readFreshOrders(db(), { from: '2026-01-01', to: TODAY })],
    taxonomy: freshTaxonomyObservations(db()) });
  /** The Fresh lists, lines and active lists as stored: history the proof must never delete. */
  const history = () => JSON.stringify(['amazon_fresh_lists', 'amazon_fresh_lines', 'amazon_fresh_orders']
    .map((table) => db().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));

  it('shows no line, product or total while the proof is displayed, keeps the list, and a revocation restores it exactly', async () => {
    const card = await bindCard();
    await importAmazonCapture(db(), freshCapture(1), backup());
    const before = answers(), stored = history();
    expect(before.view.totals.map((t) => [t.lineMinor, t.netLineMinor])).toEqual([[1000, 1000]]);
    expect([before.view.products.length, before.view.orders.reconciled]).toEqual([2, 1]);

    const proof = proven(2);
    const receipt = await importAmazonCapture(db(), proof, backup());
    expect(receipt.holds.map((h) => h.reason)).not.toContain('charge-free-contradicted');
    const hidden = answers();
    expect(hidden.view.totals).toEqual([]);
    expect(hidden.view.products).toEqual([]);
    expect(hidden.view.categories).toEqual([]);
    expect(Object.values(hidden.view.lines).every((count) => count === 0)).toBe(true);
    expect(hidden.view.orders).toEqual({ count: 1, withTotal: 0, complete: 0, reconciled: 0, refunded: 0, unreadable: 0, noLines: 1 });
    expect(hidden.view.orderList).toEqual([{ ref: REF, date: '2026-09-01', total: null, lines: 0, priced: 0, missing: 0,
      substituted: 0, unreadable: 0, unreadRows: 0, lineTotal: null, complete: false, reconciled: false, refund: null,
      chargeFree: PROOF }]);
    expect(hidden.detail).toEqual({ ref: REF, date: '2026-09-01', total: null, refund: null,
      list: { statedCount: 2, rows: 2, unreadRows: 0, lines: 0, unreadable: 0, complete: false, reconciled: false },
      lines: [], chargeFree: PROOF });
    for (const [read] of hidden.reads) expect([read.ref, read.lines, read.unreadable, read.order.chargeFree]).toEqual([REF, [], 0, PROOF]);
    expect(hidden.taxonomy).toEqual([]);
    expect(history()).toBe(stored);

    // Card evidence revokes the proof on the next write (an exact repeat here): the display, and the list, come back.
    chargeCard(card);
    const revoked = await importAmazonCapture(db(), proof, backup());
    expect(revoked.holds).toContainEqual({ reason: 'charge-free-contradicted', count: 1 });
    const restored = answers();
    expect(JSON.stringify(restored)).toBe(JSON.stringify(before));
    expect(restored.view.totals.map((t) => [t.lineMinor, t.netLineMinor])).toEqual([[1000, 1000]]);
    expect(restored.view.products).toHaveLength(2);
    expect(history()).toBe(stored);
  });

  it('STEP 9 integration B6 (Root, 1f309a7f): a Fresh re-read while the proof is displayed stays history; a revocation restores the pre-proof list', async () => {
    const card = await bindCard();
    const d0 = freshCapture(1);
    await importAmazonCapture(db(), d0, backup());
    const before = answers();
    const active = () => db().prepare('SELECT latest_digest FROM amazon_fresh_orders WHERE order_ref=?').pluck().get(REF);
    const lists = () => db().prepare('SELECT count(*) FROM amazon_fresh_lists').pluck().get();
    const first = active();
    const proof = proven(2);
    await importAmazonCapture(db(), proof, backup());
    // A complete, reconciled re-read with learned ASINs and other prices (600/400 of the same 1000), while the proof shows.
    const learned = () => [line(0, 'Synthetic Fresh Gala Apples', { asin: 'B0SYNTH001', linePrice: usd(600) }),
      line(1, 'Synthetic Fresh Rye Bread', { asin: 'B0SYNTH002', linePrice: usd(400) })];
    await importAmazonCapture(db(), freshCapture(3, learned()), backup());
    // STEP 9 integration B9 (Root): the order's whole display is frozen; F1 is retained as history, never applied.
    expect(active()).toBe(first);
    expect(lists()).toBe(2);
    expect(db().prepare("SELECT count(*) FROM amazon_audit WHERE action='charge-free-kept-fresh-list'").pluck().get()).toBe(1);
    expect(answers().view.totals).toEqual([]);
    // Card evidence revokes the proof (an exact repeat): the pre-proof display and its list come back, byte for byte.
    chargeCard(card);
    const revoked = await importAmazonCapture(db(), proof, backup());
    expect(revoked.holds).toContainEqual({ reason: 'charge-free-contradicted', count: 1 });
    expect(JSON.parse(db().prepare('SELECT data_json FROM amazon_orders WHERE ref=?').pluck().get(REF) as string))
      .toEqual(d0.staging.orders[0]);
    expect(active()).toBe(first);
    expect(JSON.stringify(answers())).toBe(JSON.stringify(before));
    // The next real read advances the list under the ordinary rules; F1's retained read never applied retroactively.
    await importAmazonCapture(db(), freshCapture(4, learned()), backup());
    expect(active()).not.toBe(first);
    expect(JSON.stringify(answers())).not.toBe(JSON.stringify(before));
  });

  it('STEP 9 integration B9 (Root): a revocation restores the recorded pre-proof Fresh list even if the active one moved', async () => {
    const card = await bindCard();
    await importAmazonCapture(db(), freshCapture(1), backup());
    const before = answers();
    const active = () => db().prepare('SELECT latest_digest FROM amazon_fresh_orders WHERE order_ref=?').pluck().get(REF);
    const first = active();
    const proof = proven(2);
    await importAmazonCapture(db(), proof, backup());
    expect(JSON.parse(db().prepare('SELECT fresh_json FROM amazon_proof_predecessors').pluck().get() as string)).toEqual({ active: first });
    await importAmazonCapture(db(), freshCapture(3, [line(0, 'Synthetic Fresh Gala Apples', { linePrice: usd(600) }),
      line(1, 'Synthetic Fresh Rye Bread', { linePrice: usd(400) })]), backup());
    // A store whose active pointer moved while the proof showed (seeded directly): the revocation still restores F0.
    const moved = db().prepare('SELECT digest FROM amazon_fresh_lists WHERE digest<>? ORDER BY rowid DESC').pluck().get(first) as string;
    await backedUpWrite(db(), backup(), () => {
      db().prepare('UPDATE amazon_fresh_orders SET latest_digest=? WHERE order_ref=?').run(moved, REF);
    });
    chargeCard(card);
    await importAmazonCapture(db(), proof, backup());
    expect(active()).toBe(first);
    expect(JSON.stringify(answers())).toBe(JSON.stringify(before));
    expect(db().prepare("SELECT count(*) FROM amazon_audit WHERE action='charge-free-revoked-fresh-list'").pluck().get()).toBe(1);
  });

  it('STEP 9 integration B9 (Root, e36b4c32): no active Fresh list before the proof stays none; a first Fresh read during it is history only', async () => {
    const card = await bindCard();
    const plain = syntheticCapture();
    plain.staging.runId = runId(1);
    await importAmazonCapture(db(), plain, backup());
    const proof = proven(2);
    await importAmazonCapture(db(), proof, backup());
    expect(JSON.parse(db().prepare('SELECT fresh_json FROM amazon_proof_predecessors').pluck().get() as string)).toEqual({ active: null });
    const active = () => db().prepare('SELECT latest_digest FROM amazon_fresh_orders WHERE order_ref=?').pluck().get(REF);
    await importAmazonCapture(db(), freshCapture(3), backup());
    expect(active()).toBeUndefined();
    expect(db().prepare('SELECT count(*) FROM amazon_fresh_lists').pluck().get()).toBe(1);
    // A revocation restores the absence exactly, with the pre-proof display.
    chargeCard(card);
    await importAmazonCapture(db(), proof, backup());
    expect(JSON.parse(db().prepare('SELECT data_json FROM amazon_orders WHERE ref=?').pluck().get(REF) as string))
      .toEqual(plain.staging.orders[0]);
    expect(active()).toBeUndefined();
    expect(answers().view.totals).toEqual([]);
    // The next real read advances normally.
    await importAmazonCapture(db(), freshCapture(4), backup());
    expect(active()).toBeDefined();
    expect(answers().view.totals.map((t) => [t.lineMinor, t.netLineMinor])).toEqual([[1000, 1000]]);
  });

  it('STEP 9 integration B9 (Root): an unrecorded pre-proof Fresh list fails closed: the proof stays displayed, surfaced', async () => {
    const card = await bindCard();
    await importAmazonCapture(db(), freshCapture(1), backup());
    const active = () => db().prepare('SELECT latest_digest FROM amazon_fresh_orders WHERE order_ref=?').pluck().get(REF);
    const first = active();
    const proof = proven(2);
    await importAmazonCapture(db(), proof, backup());
    await backedUpWrite(db(), backup(), () => { db().prepare('UPDATE amazon_proof_predecessors SET fresh_json=NULL').run(); });
    chargeCard(card);
    const repeat = await importAmazonCapture(db(), proof, backup());
    expect(repeat.holds).toContainEqual({ reason: 'revocation-predecessor-missing', count: 1 });
    expect(JSON.parse(db().prepare('SELECT data_json FROM amazon_orders WHERE ref=?').pluck().get(REF) as string).chargeFree).toEqual(PROOF);
    expect(active()).toBe(first);
    expect(answers().view.totals).toEqual([]);
    expect(db().prepare("SELECT count(*) FROM amazon_audit WHERE action='charge-free-revoked'").pluck().get()).toBe(0);
  });

  it('hides only the order its proof is displayed for: another Fresh order reads byte-identically', async () => {
    const other = '000-0000002-0000002', otherRef = opaque('order', other);
    await importAmazonCapture(db(), freshCapture(1), backup());
    await importAmazonCapture(db(), freshCapture(2, [line(0, 'Synthetic Fresh Whole Milk', { asin: 'SYNTHMILK9', linePrice: usd(1000) })],
      other), backup());
    const before = answers(otherRef);
    expect(before.view.products).toHaveLength(3);
    await importAmazonCapture(db(), proven(3), backup());
    const after = answers(otherRef);
    const summary = (view: typeof after.view, ref: string) => view.orderList.find((order) => order.ref === ref)!;
    expect(JSON.stringify(summary(after.view, otherRef))).toBe(JSON.stringify(summary(before.view, otherRef)));
    expect(Object.hasOwn(summary(after.view, otherRef), 'chargeFree')).toBe(false);
    expect(JSON.stringify(after.detail)).toBe(JSON.stringify(before.detail));
    expect(summary(after.view, REF)).toMatchObject({ lines: 0, priced: 0, lineTotal: null, chargeFree: PROOF });
    expect(after.view.orders.count).toBe(2);
    expect(after.view.totals.map((t) => [t.orderTotalMinor, t.lineMinor, t.netLineMinor])).toEqual([[1100, 1000, 1000]]);
    expect(after.view.products.map((p) => p.title)).toEqual(['Synthetic Fresh Whole Milk']);
    expect(after.taxonomy).toEqual([{ itemId: 'SYNTHMILK9', title: 'Synthetic Fresh Whole Milk' }]);
  });

  it('without a displayed proof, every Fresh answer is byte-identical to the read before this hunk', () => {
    const memory = new Database(':memory:');
    freshDatabase(memory);
    const refs = seedFreshHousehold(memory);
    const read = () => JSON.stringify([...(['30D', '60D', 'YTD', '1Y', '2Y'] as const).map((window) => amazonFresh(memory, window, TODAY)),
      ...Object.values(refs).map((ref) => amazonFreshOrder(memory, ref)), readFreshOrders(memory, 'all'), freshTaxonomyObservations(memory)]);
    const unclassified = read();
    assignFreshHousehold(memory);
    const classified = read();
    expect(`${unclassified}${classified}`).not.toContain('chargeFree');
    // SHA-256 of these answers as the STEP 9 head before B6 (e366c168) read them: a deliberate change re-pins it.
    expect(createHash('sha256').update(unclassified).update(classified).digest('hex'))
      .toBe('2c8f43569d8b125702099ae32889f170c212cadd5597e0edf4b1339b4ad24364');
  });
});

describe('STEP 9 integration B4 (#161 x #157): a Fresh re-read replaces the active list only if its taxonomy decisions follow', () => {
  // Root's B2 rule for the Fresh Item List: a one-line list whose line learns its ASIN on a re-read (a new product key).
  const TITLE = 'Synthetic Fresh Honeycrisp Apples', ASIN = 'SYNTHFR001';
  const oldKey = productKey({ asin: null, title: TITLE }), newKey = productKey({ asin: ASIN, title: TITLE });
  const reread = (run: number, asin: string | null) => freshCapture(run, [line(0, TITLE, { asin, linePrice: usd(1000) })]);
  // As the GO'd taxonomy import stores an assignment: produce, by the owner (1) or an agent (.9).
  const assign = (key: string, source: 'owner' | 'agent', confidence: number) => backedUpWrite(db(), backup(), () => {
    installAmazonTaxonomySchema(db());
    db().prepare('INSERT INTO amazon_product_taxonomy VALUES(?,?,?,?,?,?)')
      .run(key, source, 'groceries/produce', confidence, 1, 'c'.repeat(64));
  });
  const active = () => db().prepare('SELECT latest_digest FROM amazon_fresh_orders').pluck().get() as string;
  const audits = (action: string) => db().prepare('SELECT count(*) FROM amazon_audit WHERE action=?').pluck().get(action) as number;
  /** What the Fresh tab shows of the product: its full taxonomy tuple, where it counts, and its line's ASIN. */
  const shown = () => amazonFresh(db(), '2Y', TODAY).products.map((p) => ({ node: p.node, source: p.source,
    confidence: p.confidence, category: p.category, asin: p.asin }));
  const produce = (source: 'owner' | 'agent', confidence: number, asin: string | null) => [{ node: 'groceries/produce', source,
    confidence, category: 'groceries/produce', asin }];

  it('carries the owner produce/1 decision to the key the line learns, and replaces the list', async () => {
    await importAmazonCapture(db(), reread(1, null), backup());
    await assign(oldKey, 'owner', 1);
    const list = active();
    expect(shown()).toEqual(produce('owner', 1, null));
    const receipt = await importAmazonCapture(db(), reread(2, ASIN), backup());
    expect(active()).not.toBe(list);
    expect(shown()).toEqual(produce('owner', 1, ASIN));
    expect(audits('taxonomy-owner-carried')).toBe(1);
    expect(db().prepare('SELECT source,node,confidence,taxonomy_version,mapping_digest FROM amazon_product_taxonomy WHERE product_key=?')
      .all(newKey)).toEqual([{ source: 'owner', node: 'groceries/produce', confidence: 1, taxonomy_version: 1, mapping_digest: 'c'.repeat(64) }]);
    expect(audits('taxonomy-unmatched')).toBe(0);
    expect(receipt.holds.map((h) => h.reason)).not.toContain('taxonomy-unmatched');
  });

  it('keeps the active list, counted taxonomy-unmatched, when the agent produce/.9 decision cannot follow', async () => {
    await importAmazonCapture(db(), reread(1, null), backup());
    await assign(oldKey, 'agent', 0.9);
    const list = active();
    expect(shown()).toEqual(produce('agent', 0.9, null));
    const receipt = await importAmazonCapture(db(), reread(2, ASIN), backup());
    expect(active()).toBe(list);
    expect(shown()).toEqual(produce('agent', 0.9, null));
    expect(receipt.holds).toContainEqual({ reason: 'taxonomy-unmatched', count: 1 });
    // One audit for the kept list, with the count of its lines that could not follow; the re-read is history only.
    const history = db().prepare('SELECT digest FROM amazon_fresh_lists WHERE digest<>?').pluck().get(list) as string;
    expect(db().prepare("SELECT subject_ref,after_digest FROM amazon_audit WHERE action='taxonomy-unmatched'").all())
      .toEqual([{ subject_ref: REF, after_digest: digest({ captureDigest: receipt.captureDigest, listDigest: history, lines: 1 }) }]);
    expect(audits('taxonomy-owner-carried')).toBe(0);
    expect(readTaxonomyAssignments(db()).get(newKey)).toBeUndefined();
    // Once the next GO'd taxonomy review gives the new key the identical decision, the next re-read replaces the list.
    await assign(newKey, 'agent', 0.9);
    const adopted = await importAmazonCapture(db(), reread(3, ASIN), backup());
    expect(active()).not.toBe(list);
    expect(shown()).toEqual(produce('agent', 0.9, ASIN));
    expect(adopted.holds.map((h) => h.reason)).not.toContain('taxonomy-unmatched');
    expect(audits('taxonomy-unmatched')).toBe(1);
  });

  it('replaces the list when the learned key already has the identical decision (control)', async () => {
    await importAmazonCapture(db(), reread(1, null), backup());
    await assign(oldKey, 'agent', 0.9);
    await assign(newKey, 'agent', 0.9);
    const list = active();
    const receipt = await importAmazonCapture(db(), reread(2, ASIN), backup());
    expect(active()).not.toBe(list);
    expect(shown()).toEqual(produce('agent', 0.9, ASIN));
    expect(receipt.holds.map((h) => h.reason)).not.toContain('taxonomy-unmatched');
    expect([audits('taxonomy-unmatched'), audits('taxonomy-owner-carried')]).toEqual([0, 0]);
  });
});

// STEP 9 integration B8 (Root, bd744359): fresh holds must be resolvable. Every hold the import creates has a GO'd path:
// a held Fresh re-read's learned key is a key the taxonomy knows, lists, adopts and maps, as an ordinary held line's is.
describe('STEP 9 integration B8 (Root, bd744359): every hold a Fresh re-read creates has a GO\'d resolution path', () => {
  type Product = { asin: string | null; title: string };
  // Answers no retained Fresh list feeds, which B8 must leave exactly as they were: ordinary reads (#171's replaced and
  // held displays, two previous keys for one new key, an extra #168-shaped change, a title the guard holds) and Fresh
  // orders with one active list each (one of them hidden by a displayed charge-free proof, B6).
  const KETTLE_SEEN = { asin: null, title: 'Synthetic B8 Travel Kettle' }, KETTLE = { asin: 'SYNTHB8KT1', title: KETTLE_SEEN.title };
  const RENAMED = { asin: KETTLE.asin, title: 'Synthetic B8 Kettle, Travel Size' };
  const LAMP_SEEN = { asin: null, title: 'Synthetic B8 Desk Lamp' }, LAMP = { asin: 'SYNTHB8LP1', title: LAMP_SEEN.title };
  const MUG_SEEN = { asin: null, title: 'Synthetic B8 Camp Mug' }, MUG = { asin: 'SYNTHB8MG1', title: MUG_SEEN.title };
  const ROPE = { asin: 'SYNTHB8RP1', title: 'Synthetic B8 Jump Rope' }, PAN = { asin: 'SYNTHB8PN1', title: 'Synthetic B8 Skillet' };
  const GUARDED = { asin: null, title: 'Synthetic 4111111111111111' }, PEARS = { asin: 'SYNTHB8PR1', title: 'Synthetic B8 Fresh Pears' };
  /** Ordinary reads seeded as a v3 import stores them (#171's household): each read a capture, its observation and items. */
  function household(memory: Database.Database) {
    let captures = 0;
    const read = (order: string, lines: Product[], display = true) => {
      const capture = digest(`synthetic-b8-capture-${++captures}`), orderId = `synthetic-b8-order-${order}`;
      const orderRef = opaque('order', orderId);
      memory.prepare('INSERT INTO amazon_captures VALUES(?,?,?,?,?,?,?,?,?)').run(capture, SOURCE, 3, '2026-08-01', TODAY, '{}', '{}',
        TODAY, '{}');
      const items = lines.map((p, lineOrdinal) => ({ lineOrdinal, itemId: p.asin, title: p.title, quantity: 1, unitPrice: usd(1000) }));
      const data = JSON.stringify({ orderId, date: '2026-09-01', total: null, items });
      if (!memory.prepare('SELECT 1 FROM amazon_orders WHERE ref=?').get(orderRef)) {
        memory.prepare('INSERT INTO amazon_orders VALUES(?,?,?,?,?,NULL)').run(orderRef, SOURCE, orderId, capture, data);
      } else if (display) memory.prepare('UPDATE amazon_orders SET latest_digest=?,data_json=? WHERE ref=?').run(capture, data, orderRef);
      memory.prepare('INSERT INTO amazon_observations VALUES(?,?,?,?,?,?,?)').run(opaque('observation', [capture, 'order', 0]), capture,
        'order', 0, orderRef, 'payment-coverage-held', data);
      for (const item of items) {
        memory.prepare('INSERT INTO amazon_items VALUES(?,?,?,?)').run(opaque('line-observation', [capture, orderId, item.lineOrdinal]),
          orderRef, `${capture}:${item.lineOrdinal}`, JSON.stringify(item));
      }
    };
    read('A', [KETTLE_SEEN, LAMP_SEEN, ROPE, GUARDED]);
    read('A', [KETTLE, LAMP, ROPE, GUARDED]);
    read('B', [MUG_SEEN]);
    read('B', [MUG], false);
    read('C', [RENAMED]);
    read('C', [KETTLE]);
    read('D', [PAN]);
    const rows: Array<[Product, 'agent' | 'owner', string, number]> = [
      [KETTLE_SEEN, 'agent', 'home-kitchen/small-appliances', 0.91], [RENAMED, 'agent', 'home-kitchen/small-appliances', 0.74],
      [LAMP_SEEN, 'agent', 'electronics/smart-home', 0.7], [LAMP_SEEN, 'owner', 'home-kitchen/furniture-decor', 1],
      [MUG_SEEN, 'agent', 'home-kitchen/kitchen-dining', 0.42], [ROPE, 'owner', 'sports-outdoors/exercise-fitness', 1],
      [PEARS, 'agent', 'groceries/produce', 0.88]];
    memory.transaction(() => {
      installAmazonTaxonomySchema(memory);
      for (const [p, source, node, confidence] of rows) {
        memory.prepare('INSERT INTO amazon_product_taxonomy VALUES(?,?,?,?,1,?)').run(productKey(p), source, node, confidence,
          digest('synthetic B8 mapping'));
      }
    })();
  }
  /** Every taxonomy answer a key change, adoption, worklist or plan gives, as one string. */
  function answers(memory: Database.Database) {
    const extra = [{ productKey: productKey(PAN), previousProductKey: productKey(LAMP_SEEN) }];
    const adoption = taxonomyAdoptionMapping(memory), adoptionExtra = taxonomyAdoptionMapping(memory, extra);
    const generic = { format: AMAZON_TAXONOMY_MAPPING_FORMAT, version: 1, taxonomyVersion: 1, reviewed: true, entries: [
      { productKey: productKey(ROPE), node: 'sports-outdoors', confidence: 1, source: 'owner' },
      { productKey: productKey(MUG), node: 'home-kitchen/kitchen-dining', confidence: 0.8, source: 'agent' }] };
    return JSON.stringify({ keyChanges: taxonomyKeyChanges(memory), adoptions: taxonomyKeyAdoptions(memory),
      adoptionsExtra: taxonomyKeyAdoptions(memory, extra), adoption, adoptionExtra, worklist: taxonomyWorklist(memory),
      worklistExtra: taxonomyWorklist(memory, { keyChanges: extra }), known: [...knownTaxonomyProductKeys(memory)].sort(),
      categories: categoryKeyAdoptions(memory), plans: [adoption, adoptionExtra, generic].map((m) => planTaxonomyImport(memory, m)) });
  }

  it('leaves every answer without a retained Fresh list exactly as 8109cb70 gave it: ordinary reads, and one list per order', () => {
    const ordinary = new Database(':memory:');
    amazonDatabase(ordinary);
    household(ordinary);
    const fresh = new Database(':memory:');
    freshDatabase(fresh);
    household(fresh);
    const shownList = seedOrder(fresh, 'B8G1', '2026-10-05', usd(1000), 1000);
    seedFreshList(fresh, shownList, [freshLine(KETTLE_SEEN.title, each(1, 500)),
      freshLine(PEARS.title, { asin: PEARS.asin, ...each(1, 500) })]);
    const hidden = seedOrder(fresh, 'B8G2', '2026-10-06', usd(400), 400, 0, { chargeFree: { ...PROOF } });
    seedFreshList(fresh, hidden, [freshLine('Synthetic B8 Fresh Figs', each(1, 300)), freshLine(GUARDED.title, each(1, 100))]);
    // One list per order is no key change, and the list a displayed proof hides is no product (B6).
    expect(taxonomyKeyChanges(fresh)).toEqual(taxonomyKeyChanges(ordinary));
    expect([...knownTaxonomyProductKeys(fresh)].sort()).toEqual([...knownTaxonomyProductKeys(ordinary), productKey(PEARS)].sort());
    expect(taxonomyKeyChanges(ordinary)).toHaveLength(4);
    // SHA-256 of these answers as the STEP 9 head before B8 (8109cb70) gave them: a deliberate change re-pins it.
    expect(createHash('sha256').update(answers(ordinary)).update(answers(fresh)).digest('hex'))
      .toBe('5018998ad08f64483dfdd225a0cf74312524588667b9363c11274cd1bf0ab485');
  });

  // bd744359's six-case Fresh harness (independent-fresh-checks.mjs at 8109cb70): a one-line list whose line learns its
  // ASIN on a re-read after the GO'd taxonomy import filed its first key, and a displayed charge-free proof. Each hold is
  // resolved the way Root's workflow does it: the operator CLI under a Root GO, then the next real re-read.
  const TITLE = 'Synthetic B8 Fresh Groceries', ASIN = 'SYNTHB8FG1', PRODUCE = 'groceries/produce';
  const oldKey = productKey({ asin: null, title: TITLE }), newKey = productKey({ asin: ASIN, title: TITLE });
  const reread = (run: number, asin: string | null) => freshCapture(run, [line(0, TITLE, { asin, linePrice: usd(1000) })]);
  /** A taxonomy row as the GO'd import stores one: the decisions bd744359's cases start from (a fixture). */
  const stored = (key: string, source: 'owner' | 'agent', node: string, confidence: number) => backedUpWrite(db(), backup(), () => {
    installAmazonTaxonomySchema(db());
    db().prepare('INSERT INTO amazon_product_taxonomy VALUES(?,?,?,?,?,?)').run(key, source, node, confidence, 1, 'b'.repeat(64));
  });
  const active = () => db().prepare('SELECT latest_digest FROM amazon_fresh_orders').pluck().get() as string;
  const tab = () => JSON.stringify(amazonFresh(db(), '2Y', TODAY));
  /** The Fresh tab's product: its full taxonomy tuple and its line's ASIN. */
  const shown = () => amazonFresh(db(), '2Y', TODAY).products.map((p) => ({ node: p.node, source: p.source,
    confidence: p.confidence, asin: p.asin }));
  const mapping = (entries: unknown[]) => ({ format: AMAZON_TAXONOMY_MAPPING_FORMAT, version: 1, taxonomyVersion: 1, reviewed: true,
    entries });
  // The operator CLI's private files live in a directory only this user can read, outside the repository.
  let vault: string | null = null, sid: string | null = null, files = 0;
  afterEach(() => {
    if (vault) fs.rmSync(vault, { recursive: true, force: true });
    vault = null;
  });
  const privateDir = () => {
    if (vault) return vault;
    vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-step9-b8-private-')));
    if (process.platform === 'win32') restrictToUser(vault, sid ?? (sid = readCurrentUserSid()));
    else fs.chmodSync(vault, 0o700);
    return vault;
  };
  const database = () => path.join(dir, 'synthetic.db');
  /** One operator command: its exit code and output, which never carry a title, an ASIN, a key or the order. */
  async function operator(args: string[]) {
    let stdout = '', stderr = '';
    const code = await runAmazonTaxonomyCli(args, { env: { ...process.env, HOLDR_CONFIG: 'none' },
      now: () => new Date('2026-10-22T00:00:00Z'),
      io: { stdout: { write: (s: string) => { stdout += s; } }, stderr: { write: (s: string) => { stderr += s; } } } });
    for (const value of [TITLE, ASIN, oldKey, newKey, ORDER]) expect(stdout + stderr).not.toContain(value);
    return { code, stdout, stderr };
  }
  const ok = async (args: string[]) => {
    const { code, stdout, stderr } = await operator(args);
    expect(code, stderr).toBe(0);
    return JSON.parse(stdout);
  };
  /** A private mapping file and Root's GO pinned to it and to this database. */
  const goFor = (input: unknown) => {
    const file = path.join(privateDir(), `mapping-${++files}.json`), go = path.join(privateDir(), `go-${files}.json`);
    fs.writeFileSync(file, JSON.stringify(input));
    fs.writeFileSync(go, JSON.stringify({ format: 'holdr.amazon-taxonomy-go', version: 1, authority: 'Root', decision: 'GO',
      purpose: 'copy-rehearsal', command: 'import', databaseRef: digest(path.resolve(database())), mappingDigest: digest(input),
      taxonomyDigest: AMAZON_TAXONOMY_DIGEST, schemaDigest: AMAZON_TAXONOMY_SCHEMA_DIGEST }));
    return { file, go };
  };
  /** `adopt-keys`, read-only: the adoption mapping it writes. */
  const adoptKeys = async () => {
    const output = path.join(privateDir(), `adoption-${++files}.json`);
    expect(await ok(['adopt-keys', '--db', database(), '--output', output]))
      .toMatchObject({ code: 'taxonomy-key-adoptions-written-not-imported', entries: 1 });
    return JSON.parse(fs.readFileSync(output, 'utf8'));
  };
  /** A held line: the first read files its key (agent produce/.9), and the re-read that learns its ASIN is held. */
  const held = async () => {
    await importAmazonCapture(db(), reread(1, null), backup());
    await stored(oldKey, 'agent', PRODUCE, 0.9);
    const receipt = await importAmazonCapture(db(), reread(2, ASIN), backup());
    expect(receipt.holds).toContainEqual({ reason: 'taxonomy-unmatched', count: 1 });
    return { list: active(), view: tab() };
  };

  const CASES = [
    { name: 'owner-empty-carries', source: 'owner', confidence: 1, destination: null, replaces: true },
    { name: 'agent-empty-holds', source: 'agent', confidence: 0.9, destination: null, replaces: false },
    { name: 'owner-different-destination-holds', source: 'owner', confidence: 1, destination: ['owner', 'groceries/dairy-eggs', 1],
      replaces: false },
    { name: 'agent-different-confidence-holds', source: 'agent', confidence: 0.9, destination: ['agent', PRODUCE, 0.2], replaces: false },
    { name: 'agent-identical-replaces', source: 'agent', confidence: 0.9, destination: ['agent', PRODUCE, 0.9], replaces: true },
  ] as const;
  it.each(CASES)('bd744359\'s case $name: the decision is kept, and a held line\'s learned key is resolved under GO', async (c) => {
    await importAmazonCapture(db(), reread(1, null), backup());
    await stored(oldKey, c.source, PRODUCE, c.confidence);
    if (c.destination) await stored(newKey, c.destination[0], c.destination[1], c.destination[2]);
    const list = active(), view = tab(), tuple = { node: PRODUCE, source: c.source, confidence: c.confidence };
    const receipt = await importAmazonCapture(db(), reread(2, ASIN), backup());
    // As at 8109cb70 (B4): the list is replaced only when its decision follows, and the tuple it shows is kept whole.
    expect(active() !== list).toBe(c.replaces);
    expect(receipt.holds.some((h) => h.reason === 'taxonomy-unmatched')).toBe(!c.replaces);
    expect(shown()).toEqual([{ ...tuple, asin: c.replaces ? ASIN : null }]);
    expect(knownTaxonomyProductKeys(db()).has(newKey)).toBe(true);
    if (c.replaces) {
      expect(taxonomyAdoptionMapping(db())).toBeNull();
      return;
    }
    expect(tab()).toBe(view);
    // B8: the held re-read's learned key is known, listed (with what it would adopt), and a valid generic mapping of it plans.
    const assigned = c.destination ? { source: c.destination[0], node: c.destination[1], confidence: c.destination[2] } : null;
    expect(taxonomyWorklist(db()).products.find((p) => p.productKey === newKey)).toMatchObject({ asin: ASIN, title: TITLE, lines: 1,
      assigned, adoptFrom: c.destination ? null : { previousProductKey: oldKey, ...tuple } });
    const generic = mapping([{ productKey: newKey, ...tuple }]);
    expect(planTaxonomyImport(db(), generic)).toMatchObject({ entries: 1, insert: c.destination ? 0 : 1, update: c.destination ? 1 : 0 });
    if (c.destination) {
      // The learned key holds another decision: no adoption; a reviewed, GO'd mapping gives it the decision the list shows.
      expect(taxonomyAdoptionMapping(db())).toBeNull();
      const { file, go } = goFor(generic);
      expect(await ok(['plan', '--db', database(), '--input', file])).toMatchObject({ insert: 0, update: 1 });
      expect(await ok(['import', '--db', database(), '--input', file, '--backup', backup(), '--root-go', go]))
        .toMatchObject({ code: 'taxonomy-imported', insert: 0, update: 1, unchanged: 0 });
    } else {
      // No decision on the learned key: the worklist tags it, adopt-keys writes the adoption, Root's GO imports it exactly.
      expect(await ok(['worklist', '--db', database(), '--output', path.join(privateDir(), 'worklist.json')]))
        .toMatchObject({ code: 'taxonomy-worklist-written', adoptions: 1 });
      const adoption = await adoptKeys();
      expect(adoption).toEqual({ ...mapping([{ productKey: newKey, previousProductKey: oldKey, ...tuple }]), kind: 'adoption' });
      const { file, go } = goFor(adoption);
      expect(await ok(['plan', '--db', database(), '--input', file])).toMatchObject({ kind: 'adoption', insert: 1, update: 0 });
      expect(await ok(['import', '--db', database(), '--input', file, '--backup', backup(), '--root-go', go]))
        .toMatchObject({ code: 'taxonomy-imported', insert: 1, update: 0, unchanged: 0 });
      expect(db().prepare('SELECT source,node,confidence,mapping_digest FROM amazon_product_taxonomy WHERE product_key=?').all(newKey))
        .toEqual([{ ...tuple, mapping_digest: digest(adoption) }]);
    }
    expect(readTaxonomyAssignments(db()).get(newKey)).toEqual(tuple);
    // The GO'd import never replaces the display; the next real re-read follows the decision and replaces it, unheld.
    expect([active(), tab()]).toEqual([list, view]);
    const next = await importAmazonCapture(db(), reread(3, ASIN), backup());
    expect(next.holds.map((h) => h.reason)).not.toContain('taxonomy-unmatched');
    expect(active()).not.toBe(list);
    expect(shown()).toEqual([{ ...tuple, asin: ASIN }]);
    expect(taxonomyAdoptionMapping(db())).toBeNull();
  });

  it('bd744359\'s case proof-hide-restore: the list a displayed proof hides stays out of the taxonomy until a revocation', async () => {
    const card = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9001', currency: 'USD' });
    const proposal = proposeBindings([{ network: 'visa', last4: '9001', cardAccountId: card.id }], readCardInventory(db()));
    await recordBindingProposal(db(), proposal, backup());
    await recordRootApproval(db(), proposal, rootApproval(proposal), backup());
    await importAmazonCapture(db(), freshCapture(1), backup());
    const taxonomy = () => JSON.stringify({ known: [...knownTaxonomyProductKeys(db())].sort(), worklist: taxonomyWorklist(db()),
      changes: taxonomyKeyChanges(db()) });
    const before = taxonomy(), lines = ['Synthetic Fresh Gala Apples', 'Synthetic Fresh Rye Bread']
      .map((title) => productKey({ asin: null, title }));
    expect(lines.every((key) => knownTaxonomyProductKeys(db()).has(key))).toBe(true);
    const proof = proven(2);
    await importAmazonCapture(db(), proof, backup());
    // B6 as it was: while the proof is displayed its active list is history no count reads, so no key of it is the
    // taxonomy's either; nor is any key change made of it.
    expect(lines.some((key) => knownTaxonomyProductKeys(db()).has(key))).toBe(false);
    expect(taxonomyWorklist(db()).products.some((p) => lines.includes(p.productKey))).toBe(false);
    expect(taxonomyKeyChanges(db())).toEqual([]);
    repo.importCardTransactions({ cardAccountId: card.id, source: 'synthetic', parserVersion: 'synthetic@1', rows: [{
      transactionDate: '2026-09-02', status: 'posted', kind: 'purchase', currency: 'USD', amountMinor: 1100,
      description: 'AMAZON SYNTHETIC FRESH CHARGE', issuerCategory: 'Shopping' }] });
    expect((await importAmazonCapture(db(), proof, backup())).holds).toContainEqual({ reason: 'charge-free-contradicted', count: 1 });
    expect(taxonomy()).toBe(before);
  });

  it('composes with B9: a re-read while a charge-free proof is displayed is history, never a hold; its learned key stays resolvable under GO', async () => {
    const card = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9001', currency: 'USD' });
    const proposal = proposeBindings([{ network: 'visa', last4: '9001', cardAccountId: card.id }], readCardInventory(db()));
    await recordBindingProposal(db(), proposal, backup());
    await recordRootApproval(db(), proposal, rootApproval(proposal), backup());
    await importAmazonCapture(db(), reread(1, null), backup());
    await stored(oldKey, 'agent', PRODUCE, 0.9);
    const proof = proven(2);
    await importAmazonCapture(db(), proof, backup());
    const hidden = active();
    // STEP 9 integration B9 (Root): while the proof is displayed the order's whole display is frozen. The re-read that
    // learns the ASIN is retained as history, never compared with the hidden list or applied, so it creates no hold.
    const during = await importAmazonCapture(db(), reread(3, ASIN), backup());
    expect(during.holds.map((h) => h.reason)).not.toContain('taxonomy-unmatched');
    expect(active()).toBe(hidden);
    expect(readFreshOrders(db(), 'all')).toMatchObject([{ lines: [], order: { chargeFree: PROOF } }]);
    // B8: the retained re-read is provenance, so its learned key is known and adoptable under GO while the proof shows;
    // the hidden active list's key stays out (B6), yet it is the earlier read of the change.
    expect([knownTaxonomyProductKeys(db()).has(oldKey), knownTaxonomyProductKeys(db()).has(newKey)]).toEqual([false, true]);
    const adoption = await adoptKeys();
    expect(adoption.entries).toEqual([{ productKey: newKey, previousProductKey: oldKey, node: PRODUCE, confidence: 0.9, source: 'agent' }]);
    const { file, go } = goFor(adoption);
    expect(await ok(['import', '--db', database(), '--input', file, '--backup', backup(), '--root-go', go])).toMatchObject({ insert: 1 });
    expect(active()).toBe(hidden);
    // A posted card charge revokes the proof (an exact repeat): the pre-proof list returns. The next real re-read follows
    // the adopted decision and replaces it, unheld; the read retained during the proof never applied retroactively.
    repo.importCardTransactions({ cardAccountId: card.id, source: 'synthetic', parserVersion: 'synthetic@1', rows: [{
      transactionDate: '2026-09-02', status: 'posted', kind: 'purchase', currency: 'USD', amountMinor: 1100,
      description: 'AMAZON SYNTHETIC FRESH CHARGE', issuerCategory: 'Shopping' }] });
    expect((await importAmazonCapture(db(), proof, backup())).holds).toContainEqual({ reason: 'charge-free-contradicted', count: 1 });
    expect(active()).toBe(hidden);
    const next = await importAmazonCapture(db(), reread(4, ASIN), backup());
    expect(next.holds.map((h) => h.reason)).not.toContain('taxonomy-unmatched');
    expect(active()).not.toBe(hidden);
    expect(shown()).toEqual([{ node: PRODUCE, source: 'agent', confidence: 0.9, asin: ASIN }]);
  });

  it('refuses a stale Fresh adoption whole (adoption-stale): a newer competing assignment, at plan and inside the write', async () => {
    const { list } = await held();
    const rows = () => db().prepare('SELECT * FROM amazon_product_taxonomy ORDER BY product_key,source').all() as
      Array<{ product_key: string }>;
    const imports = () => db().prepare("SELECT count(*) FROM amazon_audit WHERE action='taxonomy-import'").pluck().get();
    /** plan and an import GO'd for exactly this adoption refuse it whole, with counts only, before any backup or write. */
    const refused = async (adoption: unknown, counts: { newKeyAssigned: number; previousChanged: number }) => {
      const { file, go } = goFor(adoption), never = backup(), before = [rows(), imports()];
      const expected = `amazon-taxonomy: adoption-stale ${JSON.stringify({ entries: 1, ...counts })}\n`;
      expect(await operator(['plan', '--db', database(), '--input', file])).toEqual({ code: 1, stdout: '', stderr: expected });
      expect(await operator(['import', '--db', database(), '--input', file, '--backup', never, '--root-go', go]))
        .toEqual({ code: 1, stdout: '', stderr: expected });
      expect(fs.existsSync(never)).toBe(false);
      expect([rows(), imports()]).toEqual(before);
    };
    // The old key's tuple changed after generation (the owner filed it under GO): the adoption no longer holds.
    const agentAdoption = await adoptKeys();
    const owner = mapping([{ productKey: oldKey, node: 'groceries/frozen', confidence: 1, source: 'owner' }]);
    const ownerGo = goFor(owner);
    await ok(['import', '--db', database(), '--input', ownerGo.file, '--backup', backup(), '--root-go', ownerGo.go]);
    expect(shown()).toEqual([{ node: 'groceries/frozen', source: 'owner', confidence: 1, asin: null }]);
    const view = tab();
    await refused(agentAdoption, { newKeyAssigned: 0, previousChanged: 1 });
    // Regenerated, it adopts the owner's tuple. A classification of the learned key from another connection lands after the
    // import's read-only plan and its backup, just before its write: the check inside the write transaction refuses it.
    const ownerAdoption = await adoptKeys();
    expect(ownerAdoption.entries).toEqual([{ productKey: newKey, previousProductKey: oldKey, node: 'groceries/frozen', confidence: 1,
      source: 'owner' }]);
    const { file, go } = goFor(ownerAdoption), race = backup();
    const original = Database.prototype.backup;
    let competed = false;
    Database.prototype.backup = async function (this: Database.Database, ...args: Parameters<typeof original>) {
      const result = await original.apply(this, args);
      if (args[0] === race) {
        const other = new Database(database());
        try {
          other.prepare('INSERT INTO amazon_product_taxonomy VALUES(?,?,?,?,?,?)').run(newKey, 'agent', PRODUCE, 0.3, 1, 'd'.repeat(64));
        } finally { other.close(); }
        competed = true;
      }
      return result;
    };
    const before = rows(), audited = imports();
    let raced: Awaited<ReturnType<typeof operator>> | undefined;
    try { raced = await operator(['import', '--db', database(), '--input', file, '--backup', race, '--root-go', go]); }
    finally { Database.prototype.backup = original; }
    expect(competed).toBe(true);
    expect(raced).toEqual({ code: 1, stdout: '',
      stderr: `amazon-taxonomy: adoption-stale ${JSON.stringify({ entries: 1, newKeyAssigned: 1, previousChanged: 0 })}\n` });
    // Nothing of the adoption was written: the competing row is the learned key's only row, and no import was audited.
    expect(rows().filter((row) => row.product_key !== newKey)).toEqual(before);
    expect(db().prepare('SELECT source,node,confidence FROM amazon_product_taxonomy WHERE product_key=?').all(newKey))
      .toEqual([{ source: 'agent', node: PRODUCE, confidence: 0.3 }]);
    expect(imports()).toBe(audited);
    await refused(ownerAdoption, { newKeyAssigned: 1, previousChanged: 0 });
    // No refusal touched the display, and the learned key is classified now: nothing is left to adopt.
    expect([active(), tab()]).toEqual([list, view]);
    expect(taxonomyAdoptionMapping(db())).toBeNull();
  });

  it('keeps #168\'s category list ordinary-only: a Fresh line carries no agent category, so only the taxonomy adopts its key', async () => {
    await held();
    // The agent category review classifies order items only (its title projection and its import read amazon_items): a
    // review naming a Fresh line's key is refused whole, while the same review of the order's own item applies.
    const card = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9001', currency: 'USD' });
    repo.importCardTransactions({ cardAccountId: card.id, source: 'synthetic', parserVersion: 'synthetic@1', rows: [{
      transactionDate: '2026-09-02', status: 'posted', kind: 'purchase', currency: 'USD', amountMinor: 1100,
      description: 'AMAZON SYNTHETIC FRESH CHARGE', issuerCategory: 'Shopping' }] });
    const review = (key: string) => ({ kind: 'agent-classification', productsDigest: digest('synthetic B8 projection'),
      categoriesDigest: digest(['Shopping']), entries: [{ productKey: key, category: 'Shopping', confidence: 0.9, source: 'agent',
        rationale: 'categorized from product title' }] });
    for (const key of [oldKey, newKey]) {
      expect(() => db().transaction(() => applyAgentReview(db(), review(key)))()).toThrow('amazon input refused');
    }
    db().transaction(() => applyAgentReview(db(), review(productKey({ asin: 'SYNTH00001', title: 'Synthetic blue widget' }))))();
    // So #168's list names no Fresh transition: the taxonomy's own detection does, and adopt-keys offers exactly it.
    expect(categoryKeyAdoptions(db())).toEqual([]);
    expect(taxonomyKeyChanges(db())).toEqual([{ productKey: newKey, previousProductKey: oldKey }]);
    expect((await adoptKeys()).entries).toEqual([{ productKey: newKey, previousProductKey: oldKey, node: PRODUCE, confidence: 0.9,
      source: 'agent' }]);
  });
});
