import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { AMAZON_SPENDING_WINDOWS } from '@finance-tracker/shared';
import { ensureAmazonSchema } from './schema.js';
import { digest, opaque, SOURCE } from './policy.js';
import { proposeBindings, readCardInventory } from './bindings.js';
import { productKey } from './products.js';
import { rootApproval, syntheticSubject } from './fixtures.testSupport.js';
import { getAmazonOrder } from './readModel.js';
import { AMAZON_SPENDING_MEASURE, MAX_REFUNDED_PRODUCTS, MAX_SPENDING_PRODUCTS, amazonSpending } from './spending.js';
import type { ItemObservation, MatchSubject, Money, OrderObservation } from './types.js';

// Entirely synthetic: made-up order IDs, titles, ASINs, categories and amounts.
const TODAY = '2026-10-19';
const usd = (amountMinor: number): Money => ({ currency: 'USD', amountMinor });
/** Totals of a window with no refund counted: the net is the gross. */
const unrefunded = (totals: { currency: string; orderTotalMinor: number; itemsCompleteOrderTotalMinor: number; itemMinor: number;
  categorizedMinor: number }) => ({ ...totals, refundMinor: 0, itemRefundMinor: 0, unattributedRefundMinor: 0, netItemMinor: totals.itemMinor });
const KETTLE = 'Synthetic Kettle Model K-100, 1.7 L';
const FILTERS = 'Synthetic Water Filter Pack Model F-2 (2-Pack)';
const CABLE = 'Synthetic USB-C Cable Model C-200, 2 m';
const LAMP = 'Synthetic Desk Lamp Model L-3';
const CARD_LIKE = 'Synthetic 4111111111111111';

type Line = Omit<ItemObservation, 'lineOrdinal'>;
const line = (title: string, itemId: string | null, quantity: number | null, unitPrice: Money | null): Line =>
  ({ itemId, title, quantity, unitPrice });

function database() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE card_accounts(id,issuer,owner,last4,currency,status);
    CREATE TABLE card_transactions(id,card_account_id,transaction_date,status,kind,currency,amount_minor,
      user_category,issuer_category,dismissed_at,removed_at,merged_into_id,description);`);
  ensureAmazonSchema(db);
  // Spending's categories: the agent may only name one of these.
  db.prepare('INSERT INTO card_transactions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('synthetic-row', 'synthetic-card', '2026-09-01',
    'posted', 'purchase', 'USD', 500, null, 'Synthetic Home', null, null, null, 'SYNTHETIC STORE');
  db.prepare('INSERT INTO amazon_sources VALUES(?)').run(SOURCE);
  for (const digest of ['capture-old', 'capture-new']) {
    db.prepare('INSERT INTO amazon_captures VALUES(?,?,?,?,?,?,?,?,?)').run(digest, SOURCE, 3, '2024-10-01', TODAY, '{}', '{}', TODAY, '{}');
  }
  const orderRef = (name: string) => opaque('order', `synthetic-order-${name}`);
  const lineRef = (digest: string, name: string, ordinal: number) => opaque('line-observation', [digest, `synthetic-order-${name}`, ordinal]);
  const stored = new Map<string, Record<string, unknown>>();
  /**
   * An order as its latest capture saw it; `kept` are the lines that capture kept (none for a header-only one).
   * `proven`: the capture's positive item proof, with Amazon's item subtotal (`subtotal`, else the lines' own sum) and
   * its `tax` (none unless given).
   */
  const order = (name: string, date: string, total: Money | null, lines: Line[],
    options: { latest?: string; kept?: Line[]; proven?: boolean; subtotal?: number; tax?: number;
      tender?: OrderObservation['tenderCoverage'] } = {}) => {
    const latest = options.latest ?? 'capture-new', kept = options.kept ?? lines;
    const items = lines.map((item, lineOrdinal) => ({ lineOrdinal, ...item }));
    const sum = lines.reduce((n, item) => n + (item.quantity ?? 0) * (item.unitPrice?.amountMinor ?? 0), 0);
    const proof = options.proven ? { itemProof: { complete: true, unknownLine: false, conflict: false },
      summary: [{ kind: 'items-subtotal', money: usd(options.subtotal ?? sum) },
        ...(options.tax === undefined ? [] : [{ kind: 'tax', money: usd(options.tax) }])] } : {};
    const data = { orderId: `synthetic-order-${name}`, date, total, items, ...proof,
      ...(options.tender ? { tenderCoverage: options.tender } : {}) };
    stored.set(name, data);
    db.prepare('INSERT INTO amazon_orders VALUES(?,?,?,?,?,NULL)').run(orderRef(name), SOURCE, `synthetic-order-${name}`, latest,
      JSON.stringify(data));
    kept.forEach((item, lineOrdinal) => db.prepare('INSERT INTO amazon_items VALUES(?,?,?,?)').run(lineRef(latest, name, lineOrdinal),
      orderRef(name), `${latest}:${lineOrdinal}`, JSON.stringify({ lineOrdinal, ...item })));
  };
  let ordinal = 0;
  const observe = (capture: string, family: 'order' | 'refund', orderName: string | null, data: unknown) => {
    const n = ordinal++;
    db.prepare('INSERT INTO amazon_observations VALUES(?,?,?,?,?,?,?)').run(opaque('observation', [capture, family, n]), capture,
      family, n, orderName === null ? null : orderRef(orderName), 'synthetic-hold', JSON.stringify(data));
  };
  /** A capture's observation of the order showing Amazon's Refund Total. */
  const refundTotal = (name: string, capture: string, money: Money) => observe(capture, 'order', name,
    { ...stored.get(name), refundSummary: money });
  /** A capture's observation of a completed payments-ledger refund row. */
  const ledgerRefund = (capture: string, row: { page: number; ordinal: number }, orders: string[], money: Money, date: string,
    identity: 'native-row' | 'ambiguous-repeat' = 'native-row') =>
    observe(capture, 'refund', null, { date, money, kind: 'refund', status: 'completed',
      method: { kind: 'card', network: 'visa', last4: '9001' }, orderIds: orders.map(name => `synthetic-order-${name}`),
      identity, provenance: { source: 'ledger', status: 'Refunded', ...row } });
  return { db, order, orderRef, lineRef, refundTotal, ledgerRefund };
}

function household() {
  const fixture = database();
  const { db, order, orderRef, lineRef } = fixture;
  order('A', '2026-10-12', usd(4210), [line(KETTLE, 'B0000000A1', 1, usd(2999)), line(FILTERS, 'B0000000A2', 2, usd(450))], { proven: true });
  order('B', '2026-09-25', usd(1999), [line(CABLE, null, 1, usd(1999))], { proven: true });
  // A repeat of the kettle at another price, an item whose quantity wasn't proven and one without a price.
  order('C', '2026-08-30', usd(5000), [line(KETTLE, 'B0000000A1', 1, usd(2899)), line(LAMP, 'B0000000A3', null, usd(1250)),
    line('Synthetic gift wrap', null, 1, null)]);
  // Its latest capture saw only its header: the older capture's lines are not this order's lines now.
  order('D', '2026-03-15', usd(1500), [], { latest: 'capture-new', kept: [] });
  db.prepare('INSERT INTO amazon_items VALUES(?,?,?,?)').run(lineRef('capture-old', 'D', 0), orderRef('D'), 'capture-old:0',
    JSON.stringify({ lineOrdinal: 0, ...line(LAMP, 'B0000000A3', 1, usd(1500)) }));
  // No total captured, and a title the card-data guard hides; every line priced, but its list isn't proven complete.
  order('E', '2025-12-01', null, [line(CARD_LIKE, 'B0000000A4', 1, usd(700))]);
  order('F', '2025-06-01', { currency: 'EUR', amountMinor: 3000 }, [line('Synthetic euro item', null, 3, { currency: 'EUR', amountMinor: 1000 })]);
  // A day before two years back, and a day after today: in no window.
  order('G', '2024-10-19', usd(999), [line(CABLE, null, 1, usd(999))]);
  order('H', '2026-10-20', usd(888), [line(CABLE, null, 1, usd(888))]);
  // The owner's category for the filters; a stale one on the hidden title must not show.
  db.prepare('INSERT INTO amazon_item_overrides VALUES(?,?)').run(lineRef('capture-new', 'A', 1), 'Synthetic Kitchen');
  db.prepare('INSERT INTO amazon_item_overrides VALUES(?,?)').run(lineRef('capture-new', 'E', 0), 'Synthetic Kitchen');
  // The agent's classifications: one of Spending's categories, and one that isn't (never shown).
  const agent = db.prepare("INSERT INTO amazon_agent_categories VALUES(?,?,?,'agent','categorized from product title')");
  agent.run(productKey({ asin: 'B0000000A1', title: KETTLE }), 'Synthetic Home', 0.9);
  agent.run(productKey({ asin: null, title: CABLE }), 'Invented category', 0.9);
  // Order B is held (no binding); the others have no match at all.
  const held = syntheticSubject({ ref: opaque('subject', 'B'), nativeOccurrenceId: 'synthetic-event-B', orderRefs: [orderRef('B')] });
  db.prepare('INSERT INTO amazon_subjects VALUES(?,?,?,?,?)').run(held.ref, SOURCE, held.evidenceClass, held.nativeOccurrenceId, JSON.stringify(held));
  // Order D's refund, the payments ledger's row as two captures saw it: one refund, never two refunds' worth.
  fixture.ledgerRefund('capture-old', { page: 0, ordinal: 0 }, ['D'], usd(-1500), '2026-03-20');
  fixture.ledgerRefund('capture-new', { page: 0, ordinal: 1 }, ['D'], usd(-1500), '2026-03-20');
  return fixture;
}

describe('Amazon spending by item and category', () => {
  it('totals the window\'s items by price, groups each thing across orders, and counts what it leaves out', () => {
    const { db, orderRef, lineRef } = household();
    try {
      const view = amazonSpending(db, '60D', TODAY);
      expect(view.measure).toBe(AMAZON_SPENDING_MEASURE);
      expect(view.window).toEqual({ key: '60D', from: '2026-08-21', to: TODAY });
      expect(view.version).toMatch(/^amazon-v1-/);
      expect(view.orders).toEqual({ count: 3, withTotal: 3, itemsComplete: 2, noLines: 0, refunded: 0, linked: 0, held: 1, unmatched: 2 });
      expect(view.cardCharges).toEqual({ linked: 0, itemized: 0 });
      expect(view.lines).toEqual({ count: 6, priced: 4, noPrice: 1, noQuantity: 1, categorized: 3 });
      expect(view.totals).toEqual([unrefunded({ currency: 'USD', orderTotalMinor: 11209, itemsCompleteOrderTotalMinor: 6209,
        itemMinor: 8797, categorizedMinor: 6798 })]);
      expect(view.categories).toEqual([
        { currency: 'USD', category: 'Synthetic Home', amountMinor: 5898, refundMinor: 0, netMinor: 5898, lines: 2, refundedLines: 0, products: 1, orders: 2 },
        { currency: 'USD', category: null, amountMinor: 1999, refundMinor: 0, netMinor: 1999, lines: 1, refundedLines: 0, products: 1, orders: 1 },
        { currency: 'USD', category: 'Synthetic Kitchen', amountMinor: 900, refundMinor: 0, netMinor: 900, lines: 1, refundedLines: 0, products: 1, orders: 1 },
      ]);
      expect(view.products).toEqual([
        { ref: lineRef('capture-new', 'A', 0), currency: 'USD', title: KETTLE, asin: 'B0000000A1', category: 'Synthetic Home',
          categorySource: 'agent-classification', quantity: 2, lines: 2, orders: 2, amountMinor: 5898, refundMinor: 0, netMinor: 5898,
          refundedQuantity: 0, lastOrderDate: '2026-10-12',
          lastOrderRef: orderRef('A') },
        // An agent category that isn't one of Spending's is never shown: uncategorized, as its order shows it.
        { ref: lineRef('capture-new', 'B', 0), currency: 'USD', title: CABLE, asin: null, category: null, categorySource: null,
          quantity: 1, lines: 1, orders: 1, amountMinor: 1999, refundMinor: 0, netMinor: 1999, refundedQuantity: 0,
          lastOrderDate: '2026-09-25', lastOrderRef: orderRef('B') },
        { ref: lineRef('capture-new', 'A', 1), currency: 'USD', title: FILTERS, asin: 'B0000000A2', category: 'Synthetic Kitchen',
          categorySource: 'item-override', quantity: 2, lines: 1, orders: 1, amountMinor: 900, refundMinor: 0, netMinor: 900,
          refundedQuantity: 0, lastOrderDate: '2026-10-12',
          lastOrderRef: orderRef('A') },
      ]);
      // Categories add up to the items they count, and the items to the categorized and uncategorized amounts.
      expect(view.categories.reduce((sum, c) => sum + c.amountMinor, 0)).toBe(view.totals[0].itemMinor);
      expect(view.products.reduce((sum, p) => sum + p.amountMinor, 0)).toBe(view.totals[0].itemMinor);
      // Each item's category is the one its order's own page shows.
      const page = getAmazonOrder(db, orderRef('A'))!;
      expect(page.items.map(i => [i.title, i.category, i.categorySource]))
        .toEqual([[KETTLE, 'Synthetic Home', 'agent-classification'], [FILTERS, 'Synthetic Kitchen', 'item-override']]);
    } finally { db.close(); }
  });

  it('takes each window by order date, both ends included, and nothing after today', () => {
    const { db } = household();
    try {
      const counts = Object.fromEntries(AMAZON_SPENDING_WINDOWS.map(window => [window, amazonSpending(db, window, TODAY).orders.count]));
      expect(counts).toEqual({ '30D': 2, '60D': 3, YTD: 4, '1Y': 5, '2Y': 6 });
      expect(amazonSpending(db, '30D', TODAY).window).toEqual({ key: '30D', from: '2026-09-20', to: TODAY });
      // On the day after, the newest order is in; on the day before, the oldest one is.
      expect(amazonSpending(db, '30D', '2026-10-20').orders.count).toBe(3);
      expect(amazonSpending(db, '2Y', '2026-10-18').orders.count).toBe(7);
      expect(amazonSpending(db, '30D', '2020-01-01').orders.count).toBe(0);
    } finally { db.close(); }
  });

  it('counts an order whose latest capture kept no line, and its refund once, which takes nothing off items it has no line for', () => {
    const { db } = household();
    try {
      const ytd = amazonSpending(db, 'YTD', TODAY);
      expect(ytd.orders).toMatchObject({ count: 4, withTotal: 4, itemsComplete: 2, noLines: 1, refunded: 1 });
      // Its total counts among the order totals; the older capture's lamp is not an item of the window.
      // Its refund, the whole order's, counts once; with no line to take it off, the items' net is their gross.
      expect(ytd.totals).toEqual([{ ...unrefunded({ currency: 'USD', orderTotalMinor: 12709, itemsCompleteOrderTotalMinor: 6209,
        itemMinor: 8797, categorizedMinor: 6798 }), refundMinor: 1500 }]);
      expect(ytd.refunds).toMatchObject({ ledgerRefunds: 1, ledgerObservations: 2 });
      expect(ytd.refunds.orders.find(entry => entry.basis === 'whole-order')).toEqual({ basis: 'whole-order', orders: 1 });
      expect(ytd.lines.count).toBe(6);
    } finally { db.close(); }
  });

  it('never names or categorizes an item behind the card-data guard, and keeps an order without a total out of totals', () => {
    const { db } = household();
    try {
      const year = amazonSpending(db, '1Y', TODAY);
      // Its one line is priced, but nothing proves the capture kept every line: not fully itemized.
      expect(year.orders).toMatchObject({ count: 5, withTotal: 4, itemsComplete: 2 });
      expect(year.totals[0]).toEqual({ ...unrefunded({ currency: 'USD', orderTotalMinor: 12709, itemsCompleteOrderTotalMinor: 6209,
        itemMinor: 9497, categorizedMinor: 6798 }), refundMinor: 1500 });
      const hidden = year.products.find(p => p.asin === 'B0000000A4')!;
      expect(hidden).toMatchObject({ title: '[redacted]', category: null, categorySource: null, amountMinor: 700 });
      const text = JSON.stringify(year);
      expect(text).not.toContain('4111111111111111');
      expect(text).not.toContain('synthetic-order-');
      expect(text).not.toContain(productKey({ asin: 'B0000000A4', title: CARD_LIKE }));
    } finally { db.close(); }
  });

  it('counts an order linked only when one of its card charges is: a refund credit linked to it alone never makes it so', () => {
    const { db, order, orderRef } = database();
    try {
      // The synthetic card, bound by an approved proposal: its purchases and its credits can be linked.
      db.prepare('INSERT INTO card_accounts VALUES(?,?,?,?,?,?)').run('synthetic-prime', 'chase', 'casey', '9001', 'USD', 'active');
      const proposal = proposeBindings([{ network: 'visa', last4: '9001', cardAccountId: 'synthetic-prime' }], readCardInventory(db));
      db.prepare('INSERT INTO amazon_binding_proposals VALUES(?,?)').run(digest(proposal), JSON.stringify(proposal));
      const approval = rootApproval(proposal);
      db.prepare('INSERT INTO amazon_binding_approvals VALUES(?,?,?)').run(digest(proposal), digest(approval), JSON.stringify(approval));
      const subject = (name: string, patch: Partial<MatchSubject>) => {
        const s = syntheticSubject({ ref: opaque('subject', name), nativeOccurrenceId: `synthetic-event-${name}`, date: '2026-10-01', ...patch });
        db.prepare('INSERT INTO amazon_subjects VALUES(?,?,?,?,?)').run(s.ref, SOURCE, s.evidenceClass, s.nativeOccurrenceId, JSON.stringify(s));
      };
      const cardRow = (id: string, date: string, kind: 'purchase' | 'refund', amountMinor: number) => db.prepare(
        'INSERT INTO card_transactions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, 'synthetic-prime', date, 'posted', kind, 'USD',
        amountMinor, null, 'Synthetic Home', null, null, null, 'AMAZON MKTPLACE');
      // Its card charge linked.
      order('charged', '2026-10-01', usd(2999), [line(KETTLE, 'B0000000A1', 1, usd(2999))]);
      subject('charged', { money: usd(2999), orderRefs: [orderRef('charged')] });
      cardRow('synthetic-charge', '2026-10-02', 'purchase', 2999);
      // Only its refund linked, to a card credit: its charge isn't matched.
      order('credited', '2026-10-01', usd(1500), [line(LAMP, 'B0000000A3', 1, usd(1500))]);
      subject('credited', { provenance: 'ledger-Refunded', money: usd(-1500), orderRefs: [orderRef('credited')] });
      cardRow('synthetic-credit', '2026-10-03', 'refund', -1500);
      // Its refund linked, and its charge's match held for review.
      order('held', '2026-10-01', usd(1999), [line(CABLE, null, 1, usd(1999))]);
      subject('held-credit', { provenance: 'ledger-Refunded', money: usd(-1999), orderRefs: [orderRef('held')] });
      cardRow('synthetic-credit-2', '2026-10-04', 'refund', -1999);
      subject('held-charge', { evidenceClass: 'unique-total-match', nativeOccurrenceId: null, provenance: 'unproven',
        money: usd(1999), orderRefs: [orderRef('held')] });
      const view = amazonSpending(db, '30D', TODAY);
      expect(view.orders).toMatchObject({ count: 3, linked: 1, held: 1, unmatched: 1 });
      expect(view.cardCharges).toEqual({ linked: 1, itemized: 0 });
      // The refunds are linked all the same, as each order's own page shows.
      expect(getAmazonOrder(db, orderRef('credited'))!.matches).toEqual([{ state: 'linked', evidenceClass: 'payment-event',
        cardTransactionId: 'synthetic-credit', cardAccountId: 'synthetic-prime' }]);
      expect(getAmazonOrder(db, orderRef('held'))!.matches.map(match => match.state).sort()).toEqual(['held', 'linked']);
    } finally { db.close(); }
  });

  it('counts an order fully itemized only when its capture proves the list whole and the prices add up to Amazon\'s subtotal', () => {
    const { db, order } = database();
    try {
      const lines = [line(KETTLE, 'B0000000A1', 1, usd(2999)), line(FILTERS, 'B0000000A2', 2, usd(450))];
      order('proven', '2026-10-10', usd(4210), lines, { proven: true });
      // Every kept line priced, but nothing proves the capture kept them all: a row it couldn't read may be missing.
      order('unproven', '2026-10-11', usd(4210), lines);
      // A proof whose lines don't add up to Amazon's item subtotal: a line is missing.
      order('short', '2026-10-12', usd(9999), lines, { proven: true, subtotal: 9000 });
      const view = amazonSpending(db, '30D', TODAY);
      expect(view.orders).toMatchObject({ count: 3, withTotal: 3, itemsComplete: 1 });
      expect(view.totals).toEqual([unrefunded({ currency: 'USD', orderTotalMinor: 18419, itemsCompleteOrderTotalMinor: 4210,
        itemMinor: 3 * 3899, categorizedMinor: 0 })]);
      // Their priced lines count all the same: the kettle three times, over three orders.
      expect(view.products.find(p => p.asin === 'B0000000A1')).toMatchObject({ quantity: 3, orders: 3, amountMinor: 3 * 2999 });
    } finally { db.close(); }
  });

  it('keeps each currency apart, never converted', () => {
    const { db } = household();
    try {
      const two = amazonSpending(db, '2Y', TODAY);
      expect(two.totals.map(t => [t.currency, t.orderTotalMinor, t.itemMinor])).toEqual([['EUR', 3000, 3000], ['USD', 12709, 9497]]);
      expect(two.categories.filter(c => c.currency === 'EUR')).toEqual([
        { currency: 'EUR', category: null, amountMinor: 3000, refundMinor: 0, netMinor: 3000, lines: 1, refundedLines: 0, products: 1,
          orders: 1 }]);
      expect(two.products.find(p => p.currency === 'EUR')).toMatchObject({ quantity: 3, amountMinor: 3000 });
    } finally { db.close(); }
  });

  it('reads an empty window, and a database with nothing imported, without writing anything', () => {
    const { db } = database();
    try {
      expect(amazonSpending(db, '1Y', TODAY)).toMatchObject({ orders: { count: 0 }, totals: [], categories: [], products: [] });
    } finally { db.close(); }
    const bare = new Database(':memory:');
    try {
      const view = amazonSpending(bare, '30D', TODAY);
      expect(view).toEqual({ measure: AMAZON_SPENDING_MEASURE, window: { key: '30D', from: '2026-09-20', to: TODAY },
        orders: { count: 0, withTotal: 0, itemsComplete: 0, noLines: 0, refunded: 0, linked: 0, held: 0, unmatched: 0 },
        cardCharges: { linked: 0, itemized: 0 }, lines: { count: 0, priced: 0, noPrice: 0, noQuantity: 0, categorized: 0 },
        totals: [], categories: [], products: [], refunds: expect.objectContaining({ policy: 'amazon-refund-attribution-v1',
          ledgerRefunds: 0, refundTotals: 0 }) });
      expect(bare.prepare("SELECT count(*) FROM sqlite_master WHERE name LIKE 'amazon_%'").pluck().get()).toBe(0);
    } finally { bare.close(); }
  });

  it('lists the largest items up to its cap while every total and count still includes the rest', () => {
    const { db, order } = database();
    try {
      for (let n = 0; n < 11; n++) {
        order(`bulk-${n}`, '2026-10-01', usd(0), Array.from({ length: 100 }, (_, i) =>
          line(`Synthetic bulk item ${n}-${i}`, null, 1, usd(n * 100 + i + 1))));
      }
      const view = amazonSpending(db, '30D', TODAY);
      expect(view.products).toHaveLength(MAX_SPENDING_PRODUCTS);
      expect(view.categories).toEqual([{ currency: 'USD', category: null, amountMinor: 1100 * 1101 / 2, refundMinor: 0,
        netMinor: 1100 * 1101 / 2, lines: 1100, refundedLines: 0, products: 1100, orders: 11 }]);
      expect(view.products[0].amountMinor).toBe(1100);
      expect(view.products.at(-1)!.amountMinor).toBe(101);
    } finally { db.close(); }
  });
});

describe('Amazon spending net of refunds', () => {
  const DESK = 'Synthetic Desk Model D-1', PEN_A = 'Synthetic Pen Model P-1', PEN_B = 'Synthetic Pen Model P-2';
  const CHAIR = 'Synthetic Chair Model C-9', MUG = 'Synthetic Mug Model M-2', BOOK = 'Synthetic Book Model B-5';
  const VASE = 'Synthetic Vase Model V-1';
  function refunded() {
    const fixture = database();
    const { db, order, refundTotal, ledgerRefund } = fixture;
    // The whole order refunded: Amazon's Refund Total, seen twice, equals its total; every item came back.
    order('W', '2026-10-10', usd(4199), [line(KETTLE, 'B0000000A1', 1, usd(2999)), line(FILTERS, 'B0000000A2', 2, usd(450))],
      { proven: true, tax: 300 });
    refundTotal('W', 'capture-old', usd(4199));
    refundTotal('W', 'capture-new', usd(4199));
    // The lamp's price exactly, and no other set of the order's units: the lamp. The ledger shows the same refund in two
    // captures (dated after the window ends: it still counts with its order) and the Refund Total agrees; once.
    order('U', '2026-10-05', usd(3249), [line(LAMP, 'B0000000A3', 1, usd(1250)), line(CABLE, null, 1, usd(1999))], { proven: true, tax: 0 });
    ledgerRefund('capture-old', { page: 0, ordinal: 0 }, ['U'], usd(1250), '2026-10-25');
    ledgerRefund('capture-new', { page: 0, ordinal: 3 }, ['U'], usd(1250), '2026-10-25');
    refundTotal('U', 'capture-new', usd(1250));
    // A partial refund of a proven one-line order: that line's, as money.
    order('O', '2026-10-01', usd(5000), [line(DESK, null, 1, usd(5000))], { proven: true, tax: 0 });
    refundTotal('O', 'capture-new', usd(2000));
    // Either pen: not tied to an item, off the total only.
    order('N', '2026-09-28', usd(2000), [line(PEN_A, null, 1, usd(1000)), line(PEN_B, null, 1, usd(1000))], { proven: true, tax: 0 });
    refundTotal('N', 'capture-new', usd(1000));
    // A Refund Total that went down contradicts itself: left out.
    order('X', '2026-09-25', usd(4000), [line(CHAIR, null, 1, usd(4000))], { proven: true, tax: 0 });
    refundTotal('X', 'capture-old', usd(3000));
    refundTotal('X', 'capture-new', usd(2000));
    // One ledger refund for two orders: no order's alone, left out.
    order('M', '2026-09-22', usd(800), [line(MUG, null, 1, usd(800))]);
    order('Z', '2025-01-01', usd(800), [line(MUG, null, 1, usd(800))]);
    ledgerRefund('capture-new', { page: 1, ordinal: 0 }, ['M', 'Z'], usd(800), '2026-09-30');
    // A refund in another currency than its order's: left out, never converted.
    order('E', '2026-09-21', usd(1500), [line(BOOK, null, 1, usd(1500))]);
    ledgerRefund('capture-new', { page: 1, ordinal: 1 }, ['E'], { currency: 'EUR', amountMinor: 1500 }, '2026-09-30');
    // A header-only order refunded whole: counted, with no line to take it off.
    order('H', '2026-10-12', usd(999), [], { kept: [] });
    ledgerRefund('capture-new', { page: 1, ordinal: 2 }, ['H'], usd(999), '2026-10-14');
    // Ordered before the last 30 days, refunded within them: it counts with its order, never in the 30 days.
    order('P', '2026-08-01', usd(500), [line(VASE, null, 1, usd(500))], { proven: true, tax: 0 });
    refundTotal('P', 'capture-new', usd(500));
    ledgerRefund('capture-new', { page: 1, ordinal: 3 }, ['P'], usd(500), '2026-10-15');
    db.prepare("INSERT INTO amazon_agent_categories VALUES(?,?,?,'agent','categorized from product title')")
      .run(productKey({ asin: 'B0000000A1', title: KETTLE }), 'Synthetic Home', 0.9);
    return fixture;
  }
  const counts = <K extends string>(list: ReadonlyArray<Record<K, string> & { orders?: number; count?: number }>, key: K) =>
    Object.fromEntries(list.filter(entry => (entry.orders ?? entry.count) !== 0).map(entry => [entry[key], entry.orders ?? entry.count]));

  it('takes refunds tied to items off them and their category, and the rest off the total only', () => {
    const { db } = refunded();
    try {
      const view = amazonSpending(db, '30D', TODAY);
      expect(view.orders).toMatchObject({ count: 8, withTotal: 8, refunded: 5 });
      expect(view.totals).toEqual([{ currency: 'USD', orderTotalMinor: 21747, itemsCompleteOrderTotalMinor: 18448,
        itemMinor: 20448, categorizedMinor: 2999, refundMinor: 9448, itemRefundMinor: 7149, unattributedRefundMinor: 1000,
        netItemMinor: 12299 }]);
      expect(view.categories).toEqual([
        { currency: 'USD', category: null, amountMinor: 17449, refundMinor: 4150, netMinor: 13299, lines: 9, refundedLines: 3,
          products: 9, orders: 7 },
        // Every kettle came back: its category sinks to nothing, below what was kept.
        { currency: 'USD', category: 'Synthetic Home', amountMinor: 2999, refundMinor: 2999, netMinor: 0, lines: 1, refundedLines: 1,
          products: 1, orders: 1 },
      ]);
      const listed = view.products.map(p => [p.title, p.amountMinor, p.refundMinor, p.netMinor, p.refundedQuantity]);
      expect(listed.slice(0, 4)).toEqual([[CHAIR, 4000, 0, 4000, 0], [DESK, 5000, 2000, 3000, 0], [CABLE, 1999, 0, 1999, 0],
        [BOOK, 1500, 0, 1500, 0]]);
      expect(listed.slice(4, 6).sort()).toEqual([[PEN_A, 1000, 0, 1000, 0], [PEN_B, 1000, 0, 1000, 0]]);
      // Refunded items sink to the end, whole units marked.
      expect(listed.slice(6)).toEqual([[MUG, 800, 0, 800, 0], [KETTLE, 2999, 2999, 0, 1], [LAMP, 1250, 1250, 0, 1],
        [FILTERS, 900, 900, 0, 2]]);
      // Everything adds up: categories and items to what refunds took off items; the total's net to all of it.
      const [totals] = view.totals;
      expect(view.categories.reduce((sum, c) => sum + c.refundMinor, 0)).toBe(totals.itemRefundMinor);
      expect(view.products.reduce((sum, p) => sum + p.refundMinor, 0)).toBe(totals.itemRefundMinor);
      expect(view.categories.reduce((sum, c) => sum + c.netMinor, 0) - totals.unattributedRefundMinor).toBe(totals.netItemMinor);
      expect(view.refunds).toMatchObject({ policy: 'amazon-refund-attribution-v1', ledgerRefunds: 3, ledgerObservations: 4,
        refundTotals: 5, refundTotalObservations: 7 });
      expect(counts(view.refunds.orders, 'basis')).toEqual({ 'whole-order': 2, units: 1, 'only-line': 1, unattributed: 1 });
      expect(counts(view.refunds.unattributed, 'reason')).toEqual({ ambiguous: 1 });
      expect(counts(view.refunds.sources, 'source')).toEqual({ 'order-summary': 4, ledger: 1 });
      expect(counts(view.refunds.excluded, 'reason')).toEqual({ 'currency-mismatch': 1, 'multiple-orders': 1, contradictory: 1 });
      // Every closed value is listed, zero counts included.
      expect(view.refunds.orders).toHaveLength(6);
      expect(view.refunds.excluded).toHaveLength(7);
      expect(JSON.stringify(view)).not.toContain('synthetic-order-');
    } finally { db.close(); }
  });

  it('places a refund in the window of its order\'s date, and counts a refund seen in several windows\' orders once', () => {
    const { db } = refunded();
    try {
      const month = amazonSpending(db, '30D', TODAY), year = amazonSpending(db, 'YTD', TODAY), two = amazonSpending(db, '2Y', TODAY);
      // The vase's order is older than 30 days: its refund, though dated within them, counts only in the windows its order is in.
      expect(month.products.some(p => p.title === VASE)).toBe(false);
      expect(year.totals[0]).toMatchObject({ refundMinor: 9448 + 500, itemRefundMinor: 7149 + 500, netItemMinor: 12299 });
      expect(year.products.find(p => p.title === VASE)).toMatchObject({ amountMinor: 500, refundMinor: 500, netMinor: 0, refundedQuantity: 1 });
      expect(year.orders.refunded).toBe(6);
      // Its Refund Total and its ledger refund are the same refund: counted once, not 1000.
      expect(year.refunds.sources.find(entry => entry.source === 'order-summary')!.orders).toBe(5);
      // The refund for two orders is one refund left out, in every window either order is in.
      expect(two.refunds.excluded.find(entry => entry.reason === 'multiple-orders')!.count).toBe(1);
      for (const window of AMAZON_SPENDING_WINDOWS) {
        const view = amazonSpending(db, window, TODAY);
        for (const totals of view.totals) {
          expect(totals.netItemMinor).toBe(totals.itemMinor - totals.itemRefundMinor - totals.unattributedRefundMinor);
          expect(totals.netItemMinor).toBeGreaterThanOrEqual(0);
        }
      }
    } finally { db.close(); }
  });

  it('lists every refunded item, beyond the cap on the largest', () => {
    const { db, order, refundTotal } = database();
    try {
      for (let n = 0; n < 11; n++) {
        order(`bulk-${n}`, '2026-10-01', usd(0), Array.from({ length: 100 }, (_, i) =>
          line(`Synthetic bulk item ${n}-${i}`, null, 1, usd(n * 100 + i + 1000))));
      }
      order('small', '2026-10-02', usd(50), [line('Synthetic tiny item', null, 1, usd(50))], { proven: true, tax: 0 });
      refundTotal('small', 'capture-new', usd(50));
      const view = amazonSpending(db, '30D', TODAY);
      expect(view.products).toHaveLength(MAX_SPENDING_PRODUCTS + 1);
      expect(view.products.at(-1)).toMatchObject({ title: 'Synthetic tiny item', amountMinor: 50, refundMinor: 50, netMinor: 0 });
      expect(view.refunds.refundedProducts).toEqual({ count: 1, listed: 1, truncated: false });
    } finally { db.close(); }
  });

  it('bounds the refunded items it lists, says how many there are, and the page reads every answer it sends', async () => {
    const { db, order, refundTotal } = database();
    try {
      // 2,500 items, every one refunded with its whole order: more than both lists hold.
      for (let n = 0; n < 25; n++) {
        const lines = Array.from({ length: 100 }, (_, i) => line(`Synthetic returned item ${n}-${i}`, null, 1, usd(n * 100 + i + 1)));
        const total = lines.reduce((sum, item) => sum + item.unitPrice!.amountMinor, 0);
        order(`returned-${n}`, '2026-10-01', usd(total), lines);
        refundTotal(`returned-${n}`, 'capture-new', usd(total));
      }
      const view = amazonSpending(db, '30D', TODAY);
      expect(view.products).toHaveLength(MAX_SPENDING_PRODUCTS + MAX_REFUNDED_PRODUCTS);
      expect(view.refunds.refundedProducts).toEqual({ count: 2500, listed: 2000, truncated: true });
      expect(view.totals[0]).toMatchObject({ itemMinor: 2500 * 2501 / 2, itemRefundMinor: 2500 * 2501 / 2, netItemMinor: 0 });
      // From the API's own answer to the page's reader: it reads whole, bounded list and all, never refused for its size.
      const href = new URL('../../../../web/src/components/amazon/amazonApi.ts', import.meta.url).href;
      const web = await import(/* @vite-ignore */ href) as { parseAmazonSpending: (raw: unknown, window: string) => {
        products: unknown[]; productsTruncated?: true; refunds?: { refundedProducts: unknown } } };
      const read = web.parseAmazonSpending(JSON.parse(JSON.stringify(view)), '30D');
      expect(read.products).toHaveLength(2000);
      expect(read.productsTruncated).toBeUndefined();
      expect(read.refunds?.refundedProducts).toEqual({ count: 2500, listed: 2000, truncated: true });
    } finally { db.close(); }
  });

  it('never ties ledger refunds to items they can\'t be proven to be: a split payment\'s share, or refunds that contradict', () => {
    const { db, order, ledgerRefund } = database();
    try {
      const lines = [line('Synthetic Lamp Model L-5', null, 1, usd(500)), line('Synthetic Rug Model R-1', null, 1, usd(1000)),
        line('Synthetic Sofa Model S-3', null, 1, usd(3000))];
      // One card paid: two refunds of 500 on different days each match the one 500 lamp, so together they contradict;
      // their 1000 also equals the rug's price, which never makes the rug refunded.
      order('two', '2026-10-05', usd(4500), lines, { proven: true, tax: 0, tender: 'single-card-proven' });
      ledgerRefund('capture-new', { page: 0, ordinal: 0 }, ['two'], usd(500), '2026-10-07');
      ledgerRefund('capture-new', { page: 0, ordinal: 1 }, ['two'], usd(500), '2026-10-09');
      // Paid by more than one tender: a ledger refund of 500 may be one tender's share, not the lamp.
      order('split', '2026-10-06', usd(1500), lines.slice(0, 2), { proven: true, tax: 0, tender: 'multi-tender' });
      ledgerRefund('capture-new', { page: 0, ordinal: 2 }, ['split'], usd(500), '2026-10-08');
      // Two rows the ledger showed identically: maybe one refund shown twice. Exactly one counts (the whole order), and
      // the other is left out and counted, in both captures that show them.
      order('twice', '2026-10-07', usd(700), [line('Synthetic Clock Model K-7', null, 1, usd(700))], { proven: true, tax: 0 });
      for (const capture of ['capture-old', 'capture-new']) {
        ledgerRefund(capture, { page: 1, ordinal: 0 }, ['twice'], usd(700), '2026-10-08', 'ambiguous-repeat');
        ledgerRefund(capture, { page: 1, ordinal: 1 }, ['twice'], usd(700), '2026-10-08', 'ambiguous-repeat');
      }
      const view = amazonSpending(db, '30D', TODAY);
      expect(view.totals[0]).toMatchObject({ itemMinor: 4500 + 1500 + 700, refundMinor: 1500 + 700, itemRefundMinor: 700,
        unattributedRefundMinor: 1500, netItemMinor: 4500 });
      expect(view.categories).toEqual([{ currency: 'USD', category: null, amountMinor: 6700, refundMinor: 700, netMinor: 6000,
        lines: 6, refundedLines: 1, products: 4, orders: 3 }]);
      expect(view.products.filter(product => product.refundMinor > 0).map(product => [product.title, product.refundMinor]))
        .toEqual([['Synthetic Clock Model K-7', 700]]);
      expect(view.refunds).toMatchObject({ ledgerRefunds: 4, ledgerObservations: 7 });
      expect(Object.fromEntries(view.refunds.unattributed.filter(entry => entry.orders).map(entry => [entry.reason, entry.orders])))
        .toEqual({ conflict: 1, 'mixed-tender': 1 });
      expect(view.refunds.excluded.find(entry => entry.reason === 'ambiguous-repeat')).toEqual({ reason: 'ambiguous-repeat', count: 1 });
    } finally { db.close(); }
  });
});
