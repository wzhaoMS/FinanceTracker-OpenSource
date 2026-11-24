import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStateRepo } from '../sqliteStateRepo.js';
import { proposeBindings, readCardInventory } from './bindings.js';
import { importAmazonCapture, recordBindingProposal, recordRootApproval } from './importer.js';
import { rootApproval, syntheticCompleteCapture, syntheticRereadCapture } from './fixtures.testSupport.js';
import { importClassifiedCapture, settleBaseline, type CaptureOut } from './batch.js';
import { validateCapture } from './capture.js';
import type { OrderObservation } from './types.js';
import { digest, opaque } from './policy.js';
import { ensureAmazonSchema } from './schema.js';
import {
  gatePassed, importSavedOrders, parseSavedOrders, savedOrdersCapture, SavedOrdersRefusal, type SavedOrdersFile,
} from './savedOrders.js';
import { KIT_ORDER, SAVED_CHARGES, SAVED_CLASSIC, kitConflict, syntheticSavedOrders } from './savedOrdersFixtures.testSupport.js';

const TODAY = '2026-10-24';
let dir: string, repo: SqliteStateRepo, backups = 0;
const db = () => repo.internalGetDb();
const backup = () => path.join(dir, `backup-${++backups}.db`);
const count = (table: string) => db().prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number;
/** The one place and reason a mutated file is refused for: the whole file (null), or its one set-aside order. */
async function rejection(file: unknown): Promise<{ index: number | null; reason: string }> {
  let parsed;
  try { parsed = await parseSavedOrders(file, TODAY); } catch (error) {
    expect(error).toBeInstanceOf(SavedOrdersRefusal);
    return { index: (error as SavedOrdersRefusal).index, reason: (error as SavedOrdersRefusal).reason };
  }
  expect(parsed.rejected).toHaveLength(1);
  expect(parsed.file.orders).toHaveLength(1);
  return parsed.rejected[0];
}
const mutated = (change: (file: SavedOrdersFile) => void) => { const file = syntheticSavedOrders(); change(file); return file; };
async function importSaved(file: SavedOrdersFile) {
  const parsed = await parseSavedOrders(file, TODAY);
  return db().transaction(() => {
    ensureAmazonSchema(db());
    return importSavedOrders(db(), parsed, digest(file), '2026-10-24T03:00:00.000Z');
  }).immediate();
}
/** Everything the import may never change for an order it holds: its display, history, subject and match. */
const orderState = (orderId: string) => {
  const ref = opaque('order', orderId), total = opaque('order-total', orderId);
  return {
    order: db().prepare('SELECT latest_digest,data_json FROM amazon_orders WHERE ref=?').get(ref),
    history: db().prepare('SELECT ref,capture_digest,hold_reason,data_json FROM amazon_observations WHERE order_ref=? ORDER BY ref').all(ref),
    subject: db().prepare('SELECT data_json FROM amazon_subjects WHERE ref=?').pluck().get(total),
    match: db().prepare('SELECT data_json FROM amazon_matches WHERE subject_ref=?').pluck().get(total),
  };
};

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-saved-synthetic-'));
  backups = 0;
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
  const card = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9001', currency: 'USD', nickname: 'Synthetic Prime Visa' });
  repo.importCardTransactions({ cardAccountId: card.id, source: 'synthetic', parserVersion: 'synthetic@1',
    rows: SAVED_CHARGES.map(c => ({ ...c, status: 'posted', kind: 'purchase', currency: 'USD', description: 'AMAZON SYNTHETIC',
      issuerCategory: 'Shopping' })) });
  const proposal = proposeBindings([{ network: 'visa', last4: '9001', cardAccountId: card.id }], readCardInventory(db()));
  await recordBindingProposal(db(), proposal, backup());
  await recordRootApproval(db(), proposal, rootApproval(proposal), backup());
});
afterEach(() => { repo.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('parseSavedOrders (the closed shape and the importer rules, order by order)', () => {
  it('accepts the synthetic file, and the capture it becomes passes the producer kit Fresh validator', async () => {
    const file = syntheticSavedOrders();
    const parsed = await parseSavedOrders(file, TODAY);
    expect(parsed).toMatchObject({ indexes: [0, 1], rejected: [] });
    expect(parsed.file.orders).toEqual(file.orders);
    const capture = savedOrdersCapture(parsed.file);
    expect(capture.staging).toMatchObject({ version: 3, mode: 'backfill', payments: [],
      window: { from: '2026-09-01', through: '2026-09-10' } });
    expect(capture.staging.orders.map(o => [o.tenderCoverage, o.itemProof?.complete, o.items.length]))
      .toEqual([['single-card-proven', true, 2], ['single-card-proven', false, 0]]);
    const { validateAmazonFreshItemLists } = await import(new URL(
      '../../../../../tools/amazon-capture/amazon-fresh-items.mjs', import.meta.url).href);
    expect(() => validateAmazonFreshItemLists(capture.fresh, capture.staging)).not.toThrow();
    // The same orders are always the same run.
    expect(savedOrdersCapture(parsed.file).staging.runId).toBe(capture.staging.runId);
  });
  it('stores summary components in the native producer order: the page rows as listed, then promotion last (#230 guard)', async () => {
    const file = mutated(f => {
      const s = f.orders[0].summary;
      s.find(c => c.kind === 'grand-total')!.money.amountMinor = 1000;
      f.orders[0].total.amountMinor = 1000;
      s.splice(1, 0, { kind: 'promotion', money: { currency: 'USD', amountMinor: 100 } });
      // A page whose tax row comes before its delivery fee: the rows' own order is kept.
      const fresh = f.orders[1].summary;
      f.orders[1].summary = ['items-subtotal', 'tax', 'shipping', 'tip', 'grand-total'].map(kind => fresh.find(c => c.kind === kind)!);
    });
    const parsed = await parseSavedOrders(file, TODAY);
    expect(savedOrdersCapture(parsed.file).staging.orders[0].summary!.map(c => c.kind))
      .toEqual(['items-subtotal', 'shipping', 'tax', 'grand-total', 'promotion']);
    expect(savedOrdersCapture(parsed.file).staging.orders[1].summary!.map(c => c.kind))
      .toEqual(['items-subtotal', 'tax', 'shipping', 'tip', 'grand-total']);
  });
  it('sets aside an invalid order by its place and a closed reason, and keeps its valid sibling', async () => {
    const lines = (file: SavedOrdersFile) => file.orders[1].fresh!.lines as Array<Record<string, any>>;
    const cases: Array<[(file: SavedOrdersFile) => void, number | null, string]> = [
      [f => { (f as any).extra = 1; }, null, 'file-shape'],
      [f => { f.provenance.parser.sha256 = 'not-a-digest'; }, null, 'provenance'],
      [f => { f.orders = []; }, null, 'order-count'],
      [f => { (f.orders[1] as any).note = 'x'; }, 1, 'order-shape'],
      [f => { f.orders[1].orderId = 'D01-0000000-0000000'; }, 1, 'order-id'],
      [f => { f.orders[0].date = '2026-10-26'; }, 0, 'date'],
      [f => { f.orders[0].summary.push({ kind: 'gift-card' as any, money: { currency: 'USD', amountMinor: 0 } }); }, 0, 'summary-shape'],
      [f => { f.orders[0].summary = f.orders[0].summary.filter(s => s.kind !== 'shipping'); }, 0, 'summary-required'],
      [f => { f.orders[0].total.amountMinor = 1101; }, 0, 'summary-total'],
      [f => { (f.orders[0].payment as any).network = 'unknown'; }, 0, 'payment'],
      [f => { f.orders[0].fresh = f.orders[1].fresh; }, 0, 'items-or-fresh'],
      [f => { f.orders[0].items![1].quantity = 3; }, 0, 'item-arithmetic'],
      [f => { f.orders[0].items![1].lineOrdinal = 2; }, 0, 'item-shape'],
      [f => { lines(f)[1].weight.value = 2.5; }, 1, 'fresh-line'],
      // The kit's own rule: a listed line never reads as a status phrase.
      [f => { lines(f)[0].title = 'Synthetic replacement eggs'; }, 1, 'fresh-line'],
      [f => { lines(f)[1].linePrice.amountMinor = 174; }, 1, 'fresh-arithmetic'],
      [f => { f.orders[1].fresh!.statedCount = 5; }, 1, 'fresh-shape'],
      [f => { f.orders[1].summary.find(s => s.kind === 'tax')!.money.amountMinor = 53; }, 1, 'order-arithmetic'],
      [f => { f.orders[1].pages.push({ kind: 'details', sha256: 'e'.repeat(64) }); }, 1, 'pages'],
    ];
    for (const [change, index, reason] of cases) expect(await rejection(mutated(change))).toEqual({ index, reason });
    // Every order sharing an order ID is set aside; none of them is imported.
    const duplicate = await parseSavedOrders(mutated(f => { f.orders[1].orderId = SAVED_CLASSIC; }), TODAY);
    expect(duplicate.rejected).toEqual([{ index: 0, reason: 'order-duplicate' }, { index: 1, reason: 'order-duplicate' }]);
    expect(duplicate.file.orders).toEqual([]);
  });
});

describe('importSavedOrders (per-order gate on the incoming evidence; a held order changes nothing)', () => {
  it('links each order to its one card charge, writes the reconciled Fresh list, audits provenance, and imports once', async () => {
    const file = syntheticSavedOrders();
    const first = await importSaved(file);
    expect(first.trial).toMatchObject({ passed: 2, failed: 0, linkedRowsLost: 0, linkedRowsMoved: 0 });
    expect(first.held).toEqual([]);
    const written = first.written!;
    expect(gatePassed(written.gate)).toBe(true);
    expect(written.gate.orders.map(o => [o.index, o.fresh, o.displayed, o.consistent, o.sameFacts, o.state, o.reason,
      o.candidateCount, o.allocationComplete])).toEqual([[0, false, true, true, true, 'linked', 'unique', 1, true],
      [1, true, true, true, true, 'linked', 'unique', 1, false]]);
    expect(written.receipt).toMatchObject({ newCaptures: 1, newOrders: 2, newMatches: 2, invalidated: 0 });
    expect(written.freshLists).toBe(1);
    expect([count('amazon_captures'), count('amazon_fresh_lists'), count('amazon_fresh_lines'), count('amazon_fresh_orders')])
      .toEqual([1, 1, 4, 1]);
    const list = JSON.parse(db().prepare('SELECT data_json FROM amazon_fresh_lists').pluck().get() as string);
    expect(list).toMatchObject({ reconciled: true, rows: 4, lines: 4, proof: { complete: true, unreadRows: 0 },
      provenance: { page: 'uff-itemmod' } });
    expect(db().prepare("SELECT count(*) FROM amazon_audit WHERE action='saved-pages-import'").pluck().get()).toBe(1);
    expect(db().prepare('SELECT capture_mode FROM amazon_capture_runs').pluck().all()).toEqual(['backfill']);
    const again = await importSaved(file);
    expect(again.written!.captureDigest).toBe(written.captureDigest);
    expect(again.written!.receipt).toMatchObject({ newCaptures: 0, newOrders: 0, newObservations: 0 });
    expect(gatePassed(again.written!.gate)).toBe(true);
    expect([count('amazon_captures'), count('amazon_fresh_lists')]).toEqual([1, 1]);
  });
  it('holds an order no card charge settles, writes nothing of it, and imports its valid sibling', async () => {
    const lonely = mutated(f => { f.orders[0].date = '2026-06-01'; });
    const outcome = await importSaved(lonely);
    expect(outcome.held.map(o => [o.index, o.passed, o.state, o.reason, o.candidateCount])).toEqual([[0, false, 'held', 'no-candidate', 0]]);
    expect(outcome.written!.file.orders.map(o => o.orderId)).toEqual([lonely.orders[1].orderId]);
    expect(outcome.written!.gate.orders.map(o => [o.index, o.passed])).toEqual([[1, true]]);
    expect(orderState(lonely.orders[0].orderId)).toEqual({ order: undefined, history: [], subject: undefined, match: undefined });
    expect(count('amazon_orders')).toBe(1);
  });
  it('holds an order that would take a linked card row from another order, and leaves that link alone', async () => {
    // The producer's own read of another order, already linked to the 1100 charge.
    await importAmazonCapture(db(), syntheticCompleteCapture(), backup());
    const kit = orderState(KIT_ORDER);
    const outcome = await importSaved(syntheticSavedOrders());
    expect(outcome.trial.linkedRowsLost).toBe(1);
    expect(outcome.held.map(o => [o.index, o.reason])).toEqual([[0, 'ambiguous']]);
    expect(outcome.written!.gate).toMatchObject({ passed: 1, failed: 0, linkedRowsLost: 0, linkedRowsMoved: 0 });
    expect(orderState(KIT_ORDER)).toEqual(kit);
    expect(orderState(SAVED_CLASSIC)).toEqual({ order: undefined, history: [], subject: undefined, match: undefined });
  });
  for (const conflict of ['card', 'date', 'total'] as const) {
    it(`holds a saved read that conflicts with the kit's order on its ${conflict}, changing nothing, and imports its sibling`, async () => {
      await importAmazonCapture(db(), syntheticCompleteCapture(), backup());
      const kit = orderState(KIT_ORDER);
      expect(JSON.parse(kit.match as string)).toMatchObject({ state: 'linked', reason: 'unique' });
      expect(JSON.parse(kit.subject as string)).toMatchObject({ allocationComplete: true });
      const file = syntheticSavedOrders();
      file.orders[0] = kitConflict(conflict);
      const outcome = await importSaved(file);
      expect(outcome.held.map(o => [o.index, o.passed, o.displayed])).toEqual([[0, false, false]]);
      expect(outcome.written!.file.orders.map(o => o.orderId)).toEqual([file.orders[1].orderId]);
      expect(gatePassed(outcome.written!.gate)).toBe(true);
      expect(orderState(KIT_ORDER)).toEqual(kit);
    });
  }
});

describe('the stored form is the native producer form (#230: a native image-only re-read of a saved import passes)', () => {
  const usd = (amountMinor: number) => ({ currency: 'USD', amountMinor });
  const IMAGES = ['91SynthAA0L', '91Synth+01L'];
  /** Two page layouts of the same summary rows: the usual one, and one whose tax row comes before its shipping row. */
  const PAGES = [['items-subtotal', 'shipping', 'tax', 'grand-total'], ['items-subtotal', 'tax', 'shipping', 'grand-total']];
  const component = (kind: string) => ({ kind, money: usd({ 'items-subtotal': 1100, shipping: 0, tax: 100, 'grand-total': 1100 }[kind]!) });
  /**
   * The saved classic order as the native producer stages it from a page laid out as `page`, written out by hand in the
   * producer's own construction order (amazon-native.mjs orderRecord, item snapshot, readSummary: the page's rows in
   * order, then promotion appended last), with the image IDs a later native re-read adds.
   */
  const nativeRead = (page: string[]): OrderObservation => ({
    orderId: SAVED_CLASSIC, date: '2026-09-01', total: usd(1100),
    items: [
      { lineOrdinal: 0, itemId: 'SYNTH00011', title: 'Synthetic saved widget', quantity: 1, unitPrice: usd(600), imageId: IMAGES[0] },
      { lineOrdinal: 1, itemId: null, title: 'Synthetic saved gadget', quantity: 2, unitPrice: usd(250), imageId: IMAGES[1] },
    ],
    paymentCoverage: { status: 'held', reason: 'selector-failed' },
    paymentMethods: [{ kind: 'card', network: 'visa', last4: '9001' }],
    summary: [...page.map(component), { kind: 'promotion', money: usd(100) }] as OrderObservation['summary'],
    tenderCoverage: 'single-card-proven',
    tenderProof: { methodComplete: true, summaryComplete: true, unknownMethod: false, unknownSummary: false, conflict: false },
    itemProof: { complete: true, unknownLine: false, conflict: false },
  });
  /** The same order as the saved parser writes it from that page: its rows in page order, a promotion, no image IDs. */
  const withPromotion = (page: string[]) => (file: SavedOrdersFile) => {
    const o = file.orders[0];
    o.items![1].unitPrice.amountMinor = 250;
    o.summary = [page.map(component)[0], { kind: 'promotion', money: usd(100) }, ...page.slice(1).map(component)] as typeof o.summary;
  };
  for (const page of PAGES) {
    it(`stores the saved order byte for byte as the native read, minus its image IDs (page ${page.join(' > ')})`, async () => {
      const outcome = await importSaved(mutated(withPromotion(page)));
      expect(outcome.held).toEqual([]);
      const stored = db().prepare('SELECT data_json FROM amazon_orders WHERE ref=?').pluck().get(opaque('order', SAVED_CLASSIC));
      const native = nativeRead(page);
      native.items.forEach(item => { delete item.imageId; });
      expect(stored).toBe(JSON.stringify(native));
    });
    it(`classifies a native image-only re-read of the saved import as image-ids-only (page ${page.join(' > ')})`, async () => {
      await importSaved(mutated(withPromotion(page)));
      const reread = syntheticRereadCapture(nativeRead(page), 2);
      const now = '2026-10-24T03:30:00.000Z';
      expect(settleBaseline(db(), now)).toEqual([]);
      const out: CaptureOut = {};
      const result = importClassifiedCapture(db(), await validateCapture(reread), digest(reread), now, out);
      expect(result.classification).toMatchObject({ class: 'image-ids-only', display: 'replaced' });
    });
  }
  it('stores a Fresh order with the native item proof of all-unpriced details rows', async () => {
    await importSaved(syntheticSavedOrders());
    const stored = JSON.parse(db().prepare('SELECT data_json FROM amazon_orders WHERE ref=?').pluck()
      .get(opaque('order', syntheticSavedOrders().orders[1].orderId)) as string);
    expect(Object.keys(stored)).toEqual(['orderId', 'date', 'total', 'items', 'paymentCoverage', 'paymentMethods', 'summary',
      'tenderCoverage', 'tenderProof', 'itemProof']);
    expect(stored).toMatchObject({ items: [], itemProof: { complete: false, unknownLine: true, conflict: false } });
    expect(stored.summary.map((c: { kind: string }) => c.kind)).toEqual(['items-subtotal', 'shipping', 'tax', 'tip', 'grand-total']);
  });
});
