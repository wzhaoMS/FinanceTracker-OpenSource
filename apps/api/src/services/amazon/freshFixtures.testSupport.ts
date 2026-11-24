import type { Database } from 'better-sqlite3';
import { digest, opaque, SOURCE } from './policy.js';
import { productKey } from './products.js';
import { ensureAmazonSchema } from './schema.js';
import { installAmazonTaxonomySchema } from './taxonomy.js';
import { FRESH_LIST_FORMAT, installAmazonFreshSchema, type FreshLineRecord, type FreshListRecord } from './freshSchema.js';
import type { Money, OrderObservation } from './types.js';

/**
 * Amazon Fresh test data. Entirely synthetic: made-up order IDs, product titles, ASINs, weights, prices and refunds;
 * never captured household data. The Fresh tables are installed the way only the gated Fresh import installs them
 * (freshSchema.ts's installAmazonFreshSchema, inside a write transaction): tests stand in for that import here.
 */
export const usd = (amountMinor: number): Money => ({ currency: 'USD', amountMinor });
export const SYNTHETIC_FRESH_RUN = '00000000-0000-4000-8000-00000000f7e5';
export const SYNTHETIC_CAPTURE = 'synthetic-capture';

/** A Fresh line, every field null or ordinary unless given. */
export function freshLine(title: string, patch: Partial<Omit<FreshLineRecord, 'title' | 'lineOrdinal'>> = {}): Omit<FreshLineRecord, 'lineOrdinal'> {
  return { title, asin: null, status: 'listed', quantity: null, weight: null, unitPrice: null, linePrice: null, replaces: null, ...patch };
}
/** Sold by the each: a quantity, its each price, and the line's price. */
export const each = (quantity: number, unitMinor: number, lineMinor = quantity * unitMinor) => ({
  quantity, unitPrice: { money: usd(unitMinor), per: 'each' as const }, linePrice: usd(lineMinor) });
/** Sold by weight: the weight the page showed, its per-pound price, and the line's price. */
export const weighed = (value: string, perLbMinor: number, lineMinor: number, basis: 'actual' | 'estimated' | 'unlabeled' = 'actual') => ({
  weight: { value, unit: 'lb' as const, basis }, unitPrice: { money: usd(perLbMinor), per: 'lb' as const }, linePrice: usd(lineMinor) });

/** The Amazon schema, its source and one synthetic v3 capture, without the Fresh tables. */
export function amazonDatabase(db: Database): void {
  ensureAmazonSchema(db);
  db.prepare('INSERT OR IGNORE INTO amazon_sources VALUES(?)').run(SOURCE);
  db.prepare('INSERT OR IGNORE INTO amazon_captures VALUES(?,?,?,?,?,?,?,?,?)')
    .run(SYNTHETIC_CAPTURE, SOURCE, 3, '2024-10-01', '2026-10-19', '{}', '{}', '2026-10-19', '{}');
}
/** As the gated Fresh import does, in its write transaction: install the Fresh tables. */
export function installFreshTables(db: Database): void {
  db.transaction(() => installAmazonFreshSchema(db))();
}
/** An Amazon database with the Fresh tables installed. */
export function freshDatabase(db: Database): void {
  amazonDatabase(db);
  installFreshTables(db);
}
export const freshOrderId = (name: string) => `synthetic-fresh-${name}`;
export const freshOrderRef = (name: string) => opaque('order', freshOrderId(name));

/**
 * The order's header, as an ordinary capture observed it (no items: Fresh lines live apart). With a subtotal, its
 * summary lists the item subtotal and the tax, as a Fresh order's summary does.
 */
export function seedOrder(db: Database, name: string, date: string, total: Money | null, subtotal?: number, tax = 0,
  patch: Partial<OrderObservation> = {}): string {
  const code = total?.currency ?? 'USD';
  const order: OrderObservation = { orderId: freshOrderId(name), date, total, items: [],
    ...(subtotal === undefined ? {} : { summary: [{ kind: 'items-subtotal', money: { currency: code, amountMinor: subtotal } },
      { kind: 'tax', money: { currency: code, amountMinor: tax } }] }), ...patch };
  db.prepare('INSERT INTO amazon_orders VALUES(?,?,?,?,?,NULL)')
    .run(freshOrderRef(name), SOURCE, order.orderId, SYNTHETIC_CAPTURE, JSON.stringify(order));
  return freshOrderRef(name);
}

let observed = 0;
/** One more observation of the order with Amazon's Refund Total, as a later capture of its page would show it. */
export function seedRefundTotal(db: Database, name: string, refund: Money): void {
  const order = JSON.parse(db.prepare('SELECT data_json FROM amazon_orders WHERE ref=?').pluck().get(freshOrderRef(name)) as string);
  const n = observed++;
  db.prepare('INSERT INTO amazon_observations VALUES(?,?,?,?,?,?,?)').run(opaque('observation', [SYNTHETIC_CAPTURE, 'order', n]),
    SYNTHETIC_CAPTURE, 'order', n, freshOrderRef(name), 'synthetic-fresh', JSON.stringify({ ...order, refundSummary: refund }));
}
/** A completed refund on Amazon's payments ledger, for one order. */
export function seedLedgerRefund(db: Database, name: string, date: string, refund: Money, page = 0, ordinal = 0): void {
  const n = observed++;
  db.prepare('INSERT INTO amazon_observations VALUES(?,?,?,?,?,?,?)').run(opaque('observation', [SYNTHETIC_CAPTURE, 'refund', n]),
    SYNTHETIC_CAPTURE, 'refund', n, null, 'synthetic-fresh', JSON.stringify({ date, money: { ...refund, amountMinor: -refund.amountMinor },
      kind: 'refund', status: 'completed', method: { kind: 'card', network: 'visa', last4: '9001' }, orderIds: [freshOrderId(name)],
      identity: 'native-row', provenance: { source: 'ledger', status: 'Refunded', page, ordinal } }));
}

/**
 * One Fresh Item List observation of an order and its lines by position, made the order's active list unless `latest`
 * is false. `rows` may hold raw stored values (anything but a line record) to model unreadable rows. `unreadRows` are
 * page rows the capture couldn't read (never stored); the stored proof follows the capture's rule unless `complete`
 * says otherwise.
 */
export function seedFreshList(db: Database, orderRef: string, rows: Array<Omit<FreshLineRecord, 'lineOrdinal'> | { raw: unknown }>,
  options: { label?: string; statedCount?: number | null; complete?: boolean; unreadRows?: number; reconciled?: boolean;
    latest?: boolean } = {}) {
  const unreadRows = options.unreadRows ?? 0, total = rows.length + unreadRows;
  const statedCount = options.statedCount === undefined ? total : options.statedCount;
  const complete = options.complete ?? (unreadRows === 0 && (statedCount === null || statedCount === total));
  const list: FreshListRecord = { provenance: { format: FRESH_LIST_FORMAT, version: 1, runId: SYNTHETIC_FRESH_RUN, page: 'uff-itemmod' },
    statedCount, rows: total, proof: { complete, unreadRows }, reconciled: options.reconciled ?? complete, lines: rows.length };
  const listDigest = digest(['synthetic-fresh-list', orderRef, options.label ?? 'one']);
  db.prepare('INSERT INTO amazon_fresh_lists VALUES(?,?,?,?)').run(listDigest, orderRef, '2026-10-19T00:00:00.000Z', JSON.stringify(list));
  const refs = rows.map((row, lineOrdinal) => {
    const ref = opaque('fresh-line', [listDigest, lineOrdinal]);
    const data = 'raw' in row ? row.raw : { lineOrdinal, ...row };
    db.prepare('INSERT INTO amazon_fresh_lines VALUES(?,?,?,?)').run(ref, listDigest, lineOrdinal, JSON.stringify(data));
    return ref;
  });
  if (options.latest !== false) {
    db.prepare(`INSERT INTO amazon_fresh_orders VALUES(?,?)
      ON CONFLICT(order_ref) DO UPDATE SET latest_digest=excluded.latest_digest`).run(orderRef, listDigest);
  }
  return { listDigest, refs };
}

/** The household's synthetic Fresh products. */
export const FRESH_HOUSEHOLD = {
  PORK: { asin: 'SYNTHPORK2', title: 'Synthetic Pork Shoulder, Bone-In' },
  EGGS: { asin: 'SYNTHEGGS2', title: 'Synthetic Large Eggs, 12 Count' },
  CHIPS: { asin: null, title: 'Synthetic Potato Chips' },
  TOWELS: { asin: 'SYNTHTOWL1', title: 'Synthetic Paper Towels, 6 Rolls' },
  MYSTERY: { asin: 'SYNTHMYST2', title: 'Synthetic Mystery Snack' },
  BANANAS: { asin: 'SYNTHBANA1', title: 'Synthetic Organic Bananas' },
  YOGURT: { asin: 'SYNTHYOGR1', title: 'Synthetic Greek Yogurt' },
  BREAD: { asin: 'SYNTHBRED1', title: 'Synthetic Sourdough Loaf' },
  CHEESE: { asin: 'SYNTHCHES1', title: 'Synthetic Aged Cheese' },
  // The card-data guard hides this title: it is never shown and never classified.
  HELD: { asin: null, title: 'Synthetic 4111111111111111' },
} as const;
const eur = (amountMinor: number): Money => ({ currency: 'EUR', amountMinor });

/**
 * Five Fresh orders, on a database with the Fresh tables (freshDatabase), as of 2026-10-19:
 * - F1 (Oct 12): a whole list that adds up to its item subtotal (tax-free): pork by weight, eggs, chips, paper towels
 *   and a mystery snack. Its Refund Total is exactly the chips.
 * - F2 (Sep 20): a partial list (one page row unread, two stored rows unreadable: one malformed, one listed without a
 *   price) with an estimated weight, a substitution and a missing item. Its ledger refund can't be tied to a line.
 * - F3 (last December), in euros: only the 1Y and 2Y windows hold it, apart from dollars.
 * - F4 (tomorrow): outside every window.
 * - F5 (Aug 25): read twice; only its active list counts, whose only line has a title the guard hides.
 */
export function seedFreshHousehold(db: Database) {
  const { PORK, EGGS, CHIPS, TOWELS, MYSTERY, BANANAS, YOGURT, BREAD, CHEESE, HELD } = FRESH_HOUSEHOLD;
  const f1 = seedOrder(db, 'F1', '2026-10-12', usd(2233), 2233);
  seedFreshList(db, f1, [
    freshLine(PORK.title, { asin: PORK.asin, quantity: 1, ...weighed('1.25', 399, 499) }),
    freshLine(EGGS.title, { asin: EGGS.asin, quantity: 2, linePrice: usd(500) }),
    freshLine(CHIPS.title, each(1, 235)),
    freshLine(TOWELS.title, { asin: TOWELS.asin, ...each(1, 699) }),
    freshLine(MYSTERY.title, { asin: MYSTERY.asin, ...each(1, 300) }),
  ]);
  seedRefundTotal(db, 'F1', usd(235));
  const f2 = seedOrder(db, 'F2', '2026-09-20', usd(1100), 1050, 50);
  seedFreshList(db, f2, [
    freshLine(BANANAS.title, { asin: BANANAS.asin, quantity: 1, ...weighed('2.10', 59, 124, 'estimated') }),
    freshLine(YOGURT.title, { asin: YOGURT.asin, status: 'substituted', replaces: 'Synthetic Plain Yogurt', ...each(1, 349) }),
    freshLine(BREAD.title, { asin: BREAD.asin, status: 'missing', quantity: 1 }),
    freshLine(PORK.title, { asin: PORK.asin, quantity: 1, ...weighed('0.80', 399, 319) }),
    freshLine('Synthetic Fresh Herbs', { quantity: 1 }),
    { raw: { lineOrdinal: 5, title: 'Synthetic unreadable row' } },
  ], { unreadRows: 1 });
  seedLedgerRefund(db, 'F2', '2026-09-25', usd(100));
  const f3 = seedOrder(db, 'F3', '2025-12-01', eur(1500), 1500);
  seedFreshList(db, f3, [freshLine(CHEESE.title, { asin: CHEESE.asin, quantity: 1, linePrice: eur(1500) })]);
  const f4 = seedOrder(db, 'F4', '2026-10-20', usd(999), 999);
  seedFreshList(db, f4, [freshLine(PORK.title, { asin: PORK.asin, quantity: 1, ...weighed('2.50', 399, 999) })]);
  const f5 = seedOrder(db, 'F5', '2026-08-25', usd(450), 450);
  seedFreshList(db, f5, [freshLine(BREAD.title, { asin: BREAD.asin, ...each(1, 450) }), freshLine(EGGS.title, each(1, 250))],
    { label: 'older', latest: false });
  seedFreshList(db, f5, [freshLine(HELD.title, each(1, 450))], { label: 'newer' });
  return { f1, f2, f3, f4, f5 };
}

/**
 * As the gated taxonomy import would store them: the owner's and an agent's assignments of the household's products,
 * one agent's at 0.7 (counted, suggested) and one at 0.5 (Needs review, with its suggestion). The held title's is never
 * used.
 */
export function assignFreshHousehold(db: Database): void {
  const { PORK, EGGS, CHIPS, TOWELS, MYSTERY, BANANAS, YOGURT, CHEESE, HELD } = FRESH_HOUSEHOLD;
  const rows: Array<[{ asin: string | null; title: string }, 'agent' | 'owner', string, number]> = [
    [PORK, 'owner', 'groceries/meat-seafood', 1], [EGGS, 'agent', 'groceries/dairy-eggs', 0.9],
    [CHIPS, 'agent', 'groceries/snacks-sweets', 0.7], [TOWELS, 'owner', 'household/paper-disposables', 1],
    [MYSTERY, 'agent', 'groceries/snacks-sweets', 0.5], [BANANAS, 'owner', 'groceries/produce', 1],
    [YOGURT, 'owner', 'groceries/dairy-eggs', 1], [CHEESE, 'owner', 'groceries/dairy-eggs', 1],
    [HELD, 'owner', 'groceries/frozen', 1],
  ];
  db.transaction(() => {
    installAmazonTaxonomySchema(db);
    for (const [product, source, node, confidence] of rows) {
      db.prepare('INSERT INTO amazon_product_taxonomy VALUES(?,?,?,?,1,?)')
        .run(productKey(product), source, node, confidence, digest('synthetic mapping'));
    }
  })();
}
