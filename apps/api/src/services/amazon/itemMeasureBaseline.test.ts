import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AMAZON_SPENDING_WINDOWS } from '@finance-tracker/shared';
import { SqliteStateRepo } from '../sqliteStateRepo.js';
import { importAmazonCapture } from './importer.js';
import { syntheticCapture, syntheticEvidence, syntheticReturnsCapture, syntheticSubject, withRefundEvidence } from './fixtures.testSupport.js';
import { amazonDatabase, installFreshTables, seedLedgerRefund, seedOrder, seedRefundTotal } from './freshFixtures.testSupport.js';
import { ensureAmazonSchema } from './schema.js';
import { digest, opaque, SOURCE } from './policy.js';
import { productKey } from './products.js';
import { installAmazonTaxonomySchema } from './taxonomy.js';
import { amazonSpending } from './spending.js';
import { amazonTaxonomySpending } from './taxonomySpending.js';
import type { ItemObservation, Money } from './types.js';

/**
 * Root's ruling for counting Amazon Fresh lines in both Amazon item views: on a database without any Fresh list, GET
 * /amazon/spending and GET /amazon/spending/taxonomy answer byte for byte as they did before Fresh lines counted there.
 * This file imports nothing that change added, so it runs unchanged on the base commit: there it computes exactly the
 * digests below, and here the same. Entirely synthetic: made-up order IDs, titles, ASINs, categories and amounts.
 */
const TODAY = '2026-10-19';
const usd = (amountMinor: number): Money => ({ currency: 'USD', amountMinor });
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/** Every window's answer from both views, exactly as the routes serialize them. */
const answers = (db: Database.Database) => sha256(JSON.stringify(AMAZON_SPENDING_WINDOWS.map(window => [window,
  JSON.stringify(amazonSpending(db, window, TODAY)), JSON.stringify(amazonTaxonomySpending(db, window, TODAY))])));
/** What the two-year window holds, so each household is known to exercise what it should. */
const holds = (db: Database.Database) => {
  const card = amazonSpending(db, '2Y', TODAY), items = amazonTaxonomySpending(db, '2Y', TODAY);
  return { orders: card.orders.count, refunded: card.orders.refunded, noLines: card.orders.noLines, priced: card.lines.priced,
    categories: card.categories.length, pageEvents: card.refunds.pageEvents?.events ?? 0, nodes: items.nodes.length,
    refundMinor: card.totals.map(total => [total.currency, total.refundMinor, total.netItemMinor]) };
};

type Line = Omit<ItemObservation, 'lineOrdinal'>;
const line = (title: string, itemId: string | null, quantity: number | null, unitPrice: Money | null): Line =>
  ({ itemId, title, quantity, unitPrice });

/** Ordinary orders only (spending.test.ts's household, with taxonomy assignments and a Refund Total besides). */
function itemsHousehold(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE card_accounts(id,issuer,owner,last4,currency,status);
    CREATE TABLE card_transactions(id,card_account_id,transaction_date,status,kind,currency,amount_minor,
      user_category,issuer_category,dismissed_at,removed_at,merged_into_id,description);`);
  ensureAmazonSchema(db);
  db.prepare('INSERT INTO card_transactions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('synthetic-row', 'synthetic-card', '2026-09-01',
    'posted', 'purchase', 'USD', 500, null, 'Synthetic Home', null, null, null, 'SYNTHETIC STORE');
  db.prepare('INSERT INTO amazon_sources VALUES(?)').run(SOURCE);
  for (const capture of ['capture-old', 'capture-new']) {
    db.prepare('INSERT INTO amazon_captures VALUES(?,?,?,?,?,?,?,?,?)').run(capture, SOURCE, 3, '2024-10-01', TODAY, '{}', '{}', TODAY, '{}');
  }
  const orderRef = (name: string) => opaque('order', `synthetic-order-${name}`);
  const lineRef = (capture: string, name: string, ordinal: number) => opaque('line-observation', [capture, `synthetic-order-${name}`, ordinal]);
  const stored = new Map<string, Record<string, unknown>>();
  const order = (name: string, date: string, total: Money | null, lines: Line[], options: { kept?: Line[]; proven?: boolean } = {}) => {
    const kept = options.kept ?? lines;
    const items = lines.map((item, lineOrdinal) => ({ lineOrdinal, ...item }));
    const sum = lines.reduce((n, item) => n + (item.quantity ?? 0) * (item.unitPrice?.amountMinor ?? 0), 0);
    const data = { orderId: `synthetic-order-${name}`, date, total, items, ...(options.proven ? {
      itemProof: { complete: true, unknownLine: false, conflict: false },
      summary: [{ kind: 'items-subtotal', money: usd(sum) }, { kind: 'tax', money: usd(0) }] } : {}) };
    stored.set(name, data);
    db.prepare('INSERT INTO amazon_orders VALUES(?,?,?,?,?,NULL)').run(orderRef(name), SOURCE, `synthetic-order-${name}`, 'capture-new',
      JSON.stringify(data));
    kept.forEach((item, lineOrdinal) => db.prepare('INSERT INTO amazon_items VALUES(?,?,?,?)').run(lineRef('capture-new', name, lineOrdinal),
      orderRef(name), `capture-new:${lineOrdinal}`, JSON.stringify({ lineOrdinal, ...item })));
  };
  let ordinal = 0;
  const observe = (capture: string, family: 'order' | 'refund', orderName: string | null, data: unknown) => {
    const n = ordinal++;
    db.prepare('INSERT INTO amazon_observations VALUES(?,?,?,?,?,?,?)').run(opaque('observation', [capture, family, n]), capture,
      family, n, orderName === null ? null : orderRef(orderName), 'synthetic-hold', JSON.stringify(data));
  };
  const ledgerRefund = (capture: string, row: { page: number; ordinal: number }, orders: string[], money: Money, date: string) =>
    observe(capture, 'refund', null, { date, money, kind: 'refund', status: 'completed',
      method: { kind: 'card', network: 'visa', last4: '9001' }, orderIds: orders.map(name => `synthetic-order-${name}`),
      identity: 'native-row', provenance: { source: 'ledger', status: 'Refunded', ...row } });
  const KETTLE = { asin: 'B0000000A1', title: 'Synthetic Kettle Model K-100, 1.7 L' };
  const FILTERS = { asin: 'B0000000A2', title: 'Synthetic Water Filter Pack Model F-2 (2-Pack)' };
  const CABLE = { asin: null, title: 'Synthetic USB-C Cable Model C-200, 2 m' };
  const LAMP = { asin: 'B0000000A3', title: 'Synthetic Desk Lamp Model L-3' };
  const EGGS = { asin: 'B0000000A5', title: 'Synthetic Large Eggs, 12 count' };
  order('A', '2026-10-12', usd(4210), [line(KETTLE.title, KETTLE.asin, 1, usd(2999)), line(FILTERS.title, FILTERS.asin, 2, usd(450))],
    { proven: true });
  order('B', '2026-09-25', usd(1999), [line(CABLE.title, null, 1, usd(1999))], { proven: true });
  order('C', '2026-08-30', usd(5000), [line(KETTLE.title, KETTLE.asin, 1, usd(2899)), line(LAMP.title, LAMP.asin, null, usd(1250)),
    line('Synthetic gift wrap', null, 1, null)]);
  order('D', '2026-03-15', usd(1500), [], { kept: [] });
  db.prepare('INSERT INTO amazon_items VALUES(?,?,?,?)').run(lineRef('capture-old', 'D', 0), orderRef('D'), 'capture-old:0',
    JSON.stringify({ lineOrdinal: 0, ...line(LAMP.title, LAMP.asin, 1, usd(1500)) }));
  order('E', '2025-12-01', null, [line('Synthetic 4111111111111111', 'B0000000A4', 1, usd(700))]);
  order('F', '2025-06-01', { currency: 'EUR', amountMinor: 3000 }, [line('Synthetic euro item', null, 3, { currency: 'EUR', amountMinor: 1000 })]);
  order('G', '2024-10-19', usd(999), [line(CABLE.title, null, 1, usd(999))]);
  order('H', '2026-10-20', usd(888), [line(CABLE.title, null, 1, usd(888))]);
  order('I', '2026-10-02', usd(1350), [line(EGGS.title, EGGS.asin, 3, usd(450))], { proven: true });
  db.prepare('INSERT INTO amazon_item_overrides VALUES(?,?)').run(lineRef('capture-new', 'A', 1), 'Synthetic Kitchen');
  const agent = db.prepare("INSERT INTO amazon_agent_categories VALUES(?,?,?,'agent','categorized from product title')");
  agent.run(productKey(KETTLE), 'Synthetic Home', 0.9);
  agent.run(productKey(CABLE), 'Invented category', 0.9);
  const held = syntheticSubject({ ref: opaque('subject', 'B'), nativeOccurrenceId: 'synthetic-event-B', orderRefs: [orderRef('B')] });
  db.prepare('INSERT INTO amazon_subjects VALUES(?,?,?,?,?)').run(held.ref, SOURCE, held.evidenceClass, held.nativeOccurrenceId, JSON.stringify(held));
  ledgerRefund('capture-old', { page: 0, ordinal: 0 }, ['D'], usd(-1500), '2026-03-20');
  ledgerRefund('capture-new', { page: 0, ordinal: 1 }, ['D'], usd(-1500), '2026-03-20');
  ledgerRefund('capture-new', { page: 0, ordinal: 2 }, ['C'], usd(-1250), '2026-09-05');
  observe('capture-new', 'order', 'I', { ...stored.get('I'), refundSummary: usd(450) });
  db.transaction(() => {
    installAmazonTaxonomySchema(db);
    for (const [product, source, node, confidence] of [[KETTLE, 'agent', 'home-kitchen/small-appliances', 0.9],
      [FILTERS, 'owner', 'home-kitchen/water-air-treatment', 1], [EGGS, 'agent', 'groceries/dairy-eggs', 0.7],
      [LAMP, 'agent', 'home-kitchen/furniture-decor', 0.5]] as const) {
      db.prepare('INSERT INTO amazon_product_taxonomy VALUES(?,?,?,?,1,?)').run(productKey(product), source, node, confidence,
        digest('synthetic mapping'));
    }
  })();
  return db;
}

/** Orders a Fresh import would itemize, before any of their Item Lists was imported: headers and refunds only. */
function freshHeadersOnly(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE card_accounts(id,issuer,owner,last4,currency,status);
    CREATE TABLE card_transactions(id,card_account_id,transaction_date,status,kind,currency,amount_minor,
      user_category,issuer_category,dismissed_at,removed_at,merged_into_id,description);`);
  amazonDatabase(db);
  seedOrder(db, 'F1', '2026-10-12', usd(2233), 2233);
  seedRefundTotal(db, 'F1', usd(235));
  seedOrder(db, 'F2', '2026-09-20', usd(1100), 1050, 50);
  seedLedgerRefund(db, 'F2', '2026-09-25', usd(100));
  seedOrder(db, 'F3', '2025-12-01', { currency: 'EUR', amountMinor: 1500 }, 1500);
  return db;
}

let dir: string, repo: SqliteStateRepo, backups: number;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00.000Z`));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-item-measure-baseline-synthetic-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
  backups = 0;
});
afterEach(() => {
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

/** Imported the way production imports: two orders' captures with every kind of refund evidence, and a Returns page. */
async function importedHousehold(): Promise<Database.Database> {
  const db = repo.internalGetDb();
  const save = (capture: ReturnType<typeof syntheticCapture>) =>
    importAmazonCapture(db, capture, path.join(dir, `backup-${++backups}.db`));
  const capture = (run: number, orderId: string, date: string, lines: Array<ItemObservation & { unitPrice: Money; quantity: number }>,
    tax: number, shipping: number, promotion = 0, refundSummary?: number) => {
    const built = syntheticCapture();
    built.staging.runId = `00000000-0000-4000-8000-${String(run).padStart(12, '0')}`;
    const order = built.staging.orders[0];
    const subtotal = lines.reduce((n, item) => n + item.quantity * item.unitPrice.amountMinor, 0);
    const total = subtotal + tax + shipping - promotion;
    order.orderId = orderId;
    order.date = date;
    order.items = lines.map(item => ({ ...item, unitPrice: { ...item.unitPrice } }));
    order.total = usd(total);
    order.summary = [{ kind: 'items-subtotal', money: usd(subtotal) }, { kind: 'shipping', money: usd(shipping) },
      { kind: 'tax', money: usd(tax) }, ...(promotion ? [{ kind: 'promotion' as const, money: usd(promotion) }] : []),
      { kind: 'grand-total', money: usd(total) }];
    order.itemProof = { complete: true, unknownLine: false, conflict: false };
    if (refundSummary !== undefined) order.refundSummary = usd(refundSummary);
    built.staging.coverage.details.records = lines.length;
    return built;
  };
  const one = capture(11, '000-0000001-0000001', '2026-09-01', [
    { lineOrdinal: 0, itemId: 'SYNTH00001', title: 'Synthetic oat milk', quantity: 2, unitPrice: usd(450) },
    { lineOrdinal: 1, itemId: null, title: 'Synthetic sourdough loaf', quantity: 1, unitPrice: usd(600) },
    { lineOrdinal: 2, itemId: 'SYNTH00003', title: 'Synthetic dish soap', quantity: 1, unitPrice: usd(399) }], 150, 0);
  one.staging.payments.push({ date: '2026-09-12', money: usd(-399), kind: 'refund', status: 'completed',
    method: { kind: 'card', network: 'visa', last4: '9001' }, orderIds: ['000-0000001-0000001'], identity: 'native-row',
    provenance: { source: 'ledger', status: 'Refunded', page: 0, ordinal: 0 } });
  one.staging.coverage.payments = { status: 'partial', reason: 'budget', pages: 1, records: 1, rejected: 0 };
  await save(withRefundEvidence(one, [syntheticEvidence({ money: usd(950), items: [{ lineOrdinal: 0, itemId: 'SYNTH00001', title: null,
    units: null }], provenance: { source: 'order-details', page: 0, ordinal: 0, phrase: 'refund-issued' } })]));
  const two = capture(12, '000-0000002-0000002', '2026-10-05', [
    { lineOrdinal: 0, itemId: 'SYNTH00004', title: 'Synthetic olive oil', quantity: 1, unitPrice: usd(1000) },
    { lineOrdinal: 1, itemId: 'SYNTH00005', title: 'Synthetic coffee beans', quantity: 1, unitPrice: usd(3000) }], 0, 499, 400, 3600);
  await save(withRefundEvidence(two, [syntheticEvidence({ orderIds: ['000-0000002-0000002'], money: usd(3600), items: [],
    provenance: { source: 'order-details', page: 0, ordinal: 0, phrase: 'refund-issued' } })]));
  const returns = syntheticReturnsCapture([syntheticEvidence({ money: null, items: [{ lineOrdinal: null, itemId: null,
    title: 'Synthetic sourdough loaf', units: 1 }], date: null,
    provenance: { source: 'returns-page', page: 0, ordinal: 0, phrase: 'refund-pending' }, status: 'pending' })]);
  returns.staging.runId = '00000000-0000-4000-8000-000000000013';
  await save(returns);
  return db;
}

/**
 * Each household's every window, from the base commit (computed there by this very file). A database without the Fresh
 * import's tables, and one where the gated Fresh import installed them but imported no list, answer exactly alike.
 * Order-history policy v4 (2026-11-22) moved only the snapshot `version` the card view carries: with it normalized, every
 * answer is byte for byte the v3 one (v3 digests 4890a18f…, faa1ccce…, c5da3d26…).
 */
const BASE = {
  items: '1c3e9db5ce56f04c0aba10015bed08af76bfd22f1a197738818eb69e8a37c843',
  freshHeadersOnly: 'a4da92f43758c2b069a5c4408d09a80c818e0d0dc7c951e2bd6226266be59cf8',
  imported: '1be932a01da8860506ef3a557fe4823d86268e5828af0693c862d9f0d3f48b29',
};

describe('both Amazon item views on databases without Fresh lists', () => {
  it('answer byte for byte as on the base commit: ordinary orders only', () => {
    const db = itemsHousehold();
    expect(holds(db)).toEqual({ orders: 7, refunded: 3, noLines: 1, priced: 7, categories: 4, pageEvents: 0, nodes: 7,
      refundMinor: [['EUR', 0, 3000], ['USD', 3200, 9147]] });
    const before = answers(db);
    expect(before).toBe(BASE.items);
    installFreshTables(db);
    expect(answers(db)).toBe(before);
  });

  it('answer byte for byte as on the base commit: Fresh orders whose Item Lists were never imported', () => {
    const db = freshHeadersOnly();
    // Before their lists, their refunds are counted with nothing to take them off: no item is known.
    expect(holds(db)).toEqual({ orders: 3, refunded: 2, noLines: 3, priced: 0, categories: 0, pageEvents: 0, nodes: 0,
      refundMinor: [['EUR', 0, 0], ['USD', 335, 0]] });
    const before = answers(db);
    expect(before).toBe(BASE.freshHeadersOnly);
    installFreshTables(db);
    expect(answers(db)).toBe(before);
  });

  it('answer byte for byte as on the base commit: captures imported with page, ledger and Returns-page refunds', async () => {
    const db = await importedHousehold();
    expect(holds(db)).toEqual({ orders: 2, refunded: 2, noLines: 0, priced: 5, categories: 1, pageEvents: 2, nodes: 1,
      refundMinor: [['USD', 4550, 1399]] });
    const before = answers(db);
    expect(before).toBe(BASE.imported);
    installFreshTables(db);
    expect(answers(db)).toBe(before);
  });
});
