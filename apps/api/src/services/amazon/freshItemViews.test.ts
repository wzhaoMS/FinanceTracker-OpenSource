import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  AMAZON_SPENDING_WINDOWS,
  AMAZON_TAXONOMY_NEEDS_REVIEW,
  amazonTaxonomyNode,
  type AmazonSpendingWindow,
} from '@finance-tracker/shared';
import { amazonFresh, type AmazonFreshView } from './fresh.js';
import {
  amazonDatabase, assignFreshHousehold, each, FRESH_HOUSEHOLD, freshLine, freshOrderRef, installFreshTables, seedFreshHousehold,
  seedFreshList, seedLedgerRefund, seedOrder, seedRefundTotal, SYNTHETIC_CAPTURE, usd, weighed,
} from './freshFixtures.testSupport.js';
import { FRESH_DEFAULT_CARD_CATEGORY } from './freshItems.js';
import { digest, opaque } from './policy.js';
import { productKey } from './products.js';
import { amazonSpending, type AmazonSpendingView } from './spending.js';
import { installAmazonTaxonomySchema } from './taxonomy.js';
import { amazonTaxonomySpending, type AmazonTaxonomySpendingView } from './taxonomySpending.js';
import type { ItemObservation, Money } from './types.js';

// Amazon Fresh lines in both Amazon item views (GET /amazon/spending by card category, GET /amazon/spending/taxonomy by
// item category), one category truth with the Fresh tab (GET /amazon/fresh). Entirely synthetic: made-up orders,
// titles, ASINs, weights, prices and refunds (freshFixtures.testSupport.ts and below); no network.
const TODAY = '2026-10-19';
const eur = (amountMinor: number): Money => ({ currency: 'EUR', amountMinor });
const GROCERIES_CARD = 'Merchandise & Supplies-Groceries';
const ROUTER = { asin: 'SYNTHNET02', title: 'Synthetic Mesh Router Model R-2' };
const LAMP = { asin: 'SYNTHLAMP2', title: 'Synthetic Desk Lamp Model L-4' };
const KETTLE = { asin: null, title: 'Synthetic Kettle, 1.7 L' };
const { PORK, EGGS, CHIPS, TOWELS, MYSTERY, BANANAS, YOGURT, CHEESE, HELD } = FRESH_HOUSEHOLD;
type Line = Omit<ItemObservation, 'lineOrdinal'>;
const item = (product: { asin: string | null; title: string }, quantity: number | null, unitPrice: Money | null): Line =>
  ({ itemId: product.asin, title: product.title, quantity, unitPrice });

/** The card tables the resolver reads, and the Amazon schema with one synthetic capture: no Fresh table yet. */
function database(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE card_accounts(id,issuer,owner,last4,currency,status);
    CREATE TABLE card_transactions(id,card_account_id,transaction_date,status,kind,currency,amount_minor,
      user_category,issuer_category,dismissed_at,removed_at,merged_into_id,description);`);
  db.prepare('INSERT INTO card_transactions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('synthetic-row', 'synthetic-card', '2026-09-01',
    'posted', 'purchase', 'USD', 500, null, 'Synthetic Home', null, null, null, 'SYNTHETIC STORE');
  amazonDatabase(db);
  return db;
}
/** An ordinary order with its items (as the capture's latest observation kept them); `proven`: its item list adds up. */
function itemOrder(db: Database.Database, name: string, date: string, total: Money | null, lines: Line[], proven = false): string {
  const items = lines.map((line, lineOrdinal) => ({ lineOrdinal, ...line }));
  const sum = lines.reduce((n, line) => n + (line.quantity ?? 0) * (line.unitPrice?.amountMinor ?? 0), 0);
  const ref = seedOrder(db, name, date, total, proven ? sum : undefined, 0,
    { items, ...(proven ? { itemProof: { complete: true, unknownLine: false, conflict: false } } : {}) });
  items.forEach((line) => db.prepare('INSERT INTO amazon_items VALUES(?,?,?,?)').run(opaque('line-observation', [name, line.lineOrdinal]),
    ref, `${SYNTHETIC_CAPTURE}:${line.lineOrdinal}`, JSON.stringify(line)));
  return ref;
}
/** The ordinary orders of both households: refunded, unpriced, in euros, and one product also bought on Fresh. */
function seedItemOrders(db: Database.Database): void {
  itemOrder(db, 'I1', '2026-10-10', usd(1650), [item(EGGS, 2, usd(450)), item(KETTLE, 1, usd(750))], true);
  itemOrder(db, 'I2', '2026-09-15', usd(12999), [item(ROUTER, 1, usd(12999))], true);
  seedRefundTotal(db, 'I2', usd(12999));
  itemOrder(db, 'I3', '2025-12-15', eur(2400), [item({ asin: null, title: 'Synthetic euro tea tin' }, 2, eur(1200))]);
  itemOrder(db, 'I4', '2026-08-01', usd(900), [item(LAMP, 1, null), item(KETTLE, 1, usd(900))]);
  seedLedgerRefund(db, 'I4', '2026-08-05', usd(300), 0, 7);
}
/** The household's item taxonomy, for its Fresh products (assignFreshHousehold) and two ordinary ones. */
function assignHousehold(db: Database.Database): void {
  assignFreshHousehold(db);
  db.transaction(() => {
    installAmazonTaxonomySchema(db);
    for (const [product, source, node, confidence] of [[ROUTER, 'agent', 'electronics/networking', 0.95],
      [KETTLE, 'owner', 'home-kitchen/small-appliances', 1]] as const) {
      db.prepare('INSERT INTO amazon_product_taxonomy VALUES(?,?,?,?,1,?)').run(productKey(product), source, node, confidence,
        digest('synthetic mapping'));
    }
  })();
}
/** Ordinary orders and Fresh orders together, and the one order with both an item and an active Item List (X). */
function household() {
  const db = database();
  installFreshTables(db);
  seedFreshHousehold(db);
  seedItemOrders(db);
  const x = itemOrder(db, 'X', '2026-10-05', usd(5700), [item(LAMP, 1, usd(5000))]);
  seedFreshList(db, x, [freshLine(BANANAS.title, { asin: BANANAS.asin, quantity: 1, ...weighed('1.5', 60, 90) }),
    freshLine(YOGURT.title, { asin: YOGURT.asin, ...each(2, 300) })], { label: 'X' });
  assignHousehold(db);
  // What the item views count of the ordinary orders alone: the same orders, none of them a Fresh order.
  const items = database();
  seedItemOrders(items);
  assignHousehold(items);
  return { db, items, x };
}

type Sums = Record<string, number>;
/** What both views' totals say alike of a currency's lines and refunds. */
type Net = { currency: string; itemMinor: number; itemRefundMinor: number; unattributedRefundMinor: number; refundMinor: number;
  netItemMinor: number };
const plus = (a: Sums | undefined, b: Sums): Sums => Object.fromEntries(Object.entries(b).map(([key, value]) => [key, (a?.[key] ?? 0) + value]));
const byCurrency = <T extends { currency: string }>(list: readonly T[]) => new Map(list.map((entry) => [entry.currency, entry]));
/** The Fresh tab's per-currency figures for a window, as the item views add them. */
function freshTotals(fresh: AmazonFreshView) {
  const reconciled = new Map<string, number>();
  for (const order of fresh.orderList) if (order.reconciled && order.total) {
    reconciled.set(order.total.currency, (reconciled.get(order.total.currency) ?? 0) + order.total.amountMinor);
  }
  return new Map(fresh.totals.map((t) => [t.currency, { ...t, reconciledOrderTotalMinor: reconciled.get(t.currency) ?? 0 }]));
}
/** A Fresh product's card category, by Root's rule (no override in these households): its node's, else Groceries'. */
const freshCard = (node: string) => (node === AMAZON_TAXONOMY_NEEDS_REVIEW ? GROCERIES_CARD : amazonTaxonomyNode(node)!.cardCategory);
const views = (db: Database.Database, window: AmazonSpendingWindow) => ({ card: amazonSpending(db, window, TODAY),
  taxonomy: amazonTaxonomySpending(db, window, TODAY), fresh: amazonFresh(db, window, TODAY) });

describe('Amazon Fresh lines in both Amazon item views', () => {
  it('adds exactly the Fresh tab\'s figures to the ordinary orders\' in every window and currency, in both views', () => {
    const { db, items } = household();
    expect(FRESH_DEFAULT_CARD_CATEGORY).toBe(GROCERIES_CARD);
    for (const window of AMAZON_SPENDING_WINDOWS) {
      const both = views(db, window), alone = views(items, window), fresh = freshTotals(both.fresh);
      const at = (label: string) => `${window}: ${label}`;
      expect(both.fresh.orders.count, at('Fresh orders')).toBeGreaterThan(window === '30D' ? 1 : 2);
      // Orders and lines: each order once; a Fresh order's lines are its delivered, priced lines (missing ones never count).
      expect(both.card.orders, at('orders')).toMatchObject({
        count: alone.card.orders.count + both.fresh.orders.count, withTotal: alone.card.orders.withTotal + both.fresh.orders.withTotal,
        refunded: alone.card.orders.refunded + both.fresh.orders.refunded, noLines: alone.card.orders.noLines + both.fresh.orders.noLines,
        itemsComplete: alone.card.orders.itemsComplete + both.fresh.orders.reconciled });
      expect(both.card.lines, at('lines')).toEqual({ count: alone.card.lines.count + both.fresh.lines.priced + both.fresh.lines.noPrice,
        priced: alone.card.lines.priced + both.fresh.lines.priced, noPrice: alone.card.lines.noPrice + both.fresh.lines.noPrice,
        noQuantity: alone.card.lines.noQuantity, categorized: alone.card.lines.categorized + both.fresh.lines.priced });
      expect(both.taxonomy.orders, at('taxonomy orders')).toEqual({ count: alone.taxonomy.orders.count + both.fresh.orders.count,
        refunded: alone.taxonomy.orders.refunded + both.fresh.orders.refunded });
      expect(both.taxonomy.lines, at('taxonomy lines')).toEqual({
        count: alone.taxonomy.lines.count + both.fresh.lines.priced + both.fresh.lines.noPrice,
        priced: alone.taxonomy.lines.priced + both.fresh.lines.priced, noPrice: alone.taxonomy.lines.noPrice + both.fresh.lines.noPrice,
        noQuantity: alone.taxonomy.lines.noQuantity, assigned: alone.taxonomy.lines.assigned + both.fresh.lines.categorized,
        suggested: alone.taxonomy.lines.suggested + both.fresh.lines.suggested,
        needsReview: alone.taxonomy.lines.needsReview + both.fresh.lines.needsReview });
      // Per currency: gross, refunds tied to lines, refunds tied to none, refund money and net are the two added up. The card
      // view has a currency for every order total, as the Fresh tab does; the taxonomy view, for item prices and refunds.
      const card = byCurrency(alone.card.totals), tax = byCurrency(alone.taxonomy.totals);
      const cardCurrencies = [...new Set([...card.keys(), ...fresh.keys()])].sort();
      const taxonomyCurrencies = [...new Set([...tax.keys(), ...[...fresh.values()].filter((t) => t.lineMinor + t.refundMinor > 0)
        .map((t) => t.currency)])].sort();
      expect(both.card.totals.map((t) => t.currency), at('card currencies')).toEqual(cardCurrencies);
      expect(both.taxonomy.totals.map((t) => t.currency), at('taxonomy currencies')).toEqual(taxonomyCurrencies);
      const none = { orderTotalMinor: 0, lineMinor: 0, categorizedMinor: 0, suggestedMinor: 0, needsReviewMinor: 0, refundMinor: 0,
        lineRefundMinor: 0, unattributedRefundMinor: 0, netLineMinor: 0, reconciledOrderTotalMinor: 0 };
      for (const currency of cardCurrencies) {
        const f = fresh.get(currency) ?? none, c = card.get(currency);
        expect(byCurrency(both.card.totals).get(currency), at(`card ${currency}`)).toEqual({ currency, ...plus(
          c && { orderTotalMinor: c.orderTotalMinor, itemsCompleteOrderTotalMinor: c.itemsCompleteOrderTotalMinor, itemMinor: c.itemMinor,
            categorizedMinor: c.categorizedMinor, refundMinor: c.refundMinor, itemRefundMinor: c.itemRefundMinor,
            unattributedRefundMinor: c.unattributedRefundMinor, netItemMinor: c.netItemMinor },
          { orderTotalMinor: f.orderTotalMinor, itemsCompleteOrderTotalMinor: f.reconciledOrderTotalMinor, itemMinor: f.lineMinor,
            categorizedMinor: f.lineMinor, refundMinor: f.refundMinor, itemRefundMinor: f.lineRefundMinor,
            unattributedRefundMinor: f.unattributedRefundMinor, netItemMinor: f.netLineMinor }) });
      }
      for (const currency of taxonomyCurrencies) {
        const f = fresh.get(currency) ?? none, t = tax.get(currency);
        expect(byCurrency(both.taxonomy.totals).get(currency), at(`taxonomy ${currency}`)).toEqual({ currency, ...plus(
          t && { itemMinor: t.itemMinor, assignedMinor: t.assignedMinor, suggestedMinor: t.suggestedMinor,
            needsReviewMinor: t.needsReviewMinor, refundMinor: t.refundMinor, itemRefundMinor: t.itemRefundMinor,
            unattributedRefundMinor: t.unattributedRefundMinor, netItemMinor: t.netItemMinor },
          { itemMinor: f.lineMinor, assignedMinor: f.categorizedMinor, suggestedMinor: f.suggestedMinor, needsReviewMinor: f.needsReviewMinor,
            refundMinor: f.refundMinor, itemRefundMinor: f.lineRefundMinor, unattributedRefundMinor: f.unattributedRefundMinor,
            netItemMinor: f.netLineMinor }) });
      }
      // The `fresh` part of both views is the Fresh tab's, for the same window.
      const part = { orders: both.fresh.orders.count, lines: { priced: both.fresh.lines.priced, missing: both.fresh.lines.missing,
        unreadable: both.fresh.lines.unreadable }, totals: [...fresh.values()].filter((t) => t.lineMinor + t.refundMinor > 0)
        .map((t) => ({ currency: t.currency, lineMinor: t.lineMinor, refundMinor: t.refundMinor, lineRefundMinor: t.lineRefundMinor,
          unattributedRefundMinor: t.unattributedRefundMinor, netLineMinor: t.netLineMinor })) };
      expect(both.card.fresh, at('card fresh')).toEqual(part);
      expect(both.taxonomy.fresh, at('taxonomy fresh')).toEqual(part);
      expect(alone.card.fresh, at('no Fresh order')).toBeUndefined();
      expect(alone.taxonomy.fresh, at('no Fresh order')).toBeUndefined();

      // Every node and every card category: the ordinary orders' and the Fresh tab's products' (every one is listed).
      const freshNodes = new Map<string, Sums>(), freshCards = new Map<string, Sums>();
      for (const product of both.fresh.products) {
        const sums = { amountMinor: product.amountMinor, refundMinor: product.refundMinor, lines: product.lines };
        const node = amazonTaxonomyNode(product.node)!;
        for (const id of node.parent === null ? [node.id] : [node.id, node.parent]) {
          const key = JSON.stringify([product.currency, id]);
          freshNodes.set(key, plus(freshNodes.get(key), sums));
        }
        const key = JSON.stringify([product.currency, freshCard(product.node)]);
        freshCards.set(key, plus(freshCards.get(key), sums));
      }
      expect(sum(both.fresh.products.map((p) => p.lines)), at('every Fresh line listed')).toBe(both.fresh.lines.priced);
      const nodeSums = (view: AmazonTaxonomySpendingView) => new Map<string, Sums>(view.nodes.map((n) => [JSON.stringify([n.currency, n.node]),
        { amountMinor: n.amountMinor, refundMinor: n.refundMinor, lines: n.lines }]));
      const expectedNodes = nodeSums(alone.taxonomy);
      for (const [key, sums] of freshNodes) expectedNodes.set(key, plus(expectedNodes.get(key), sums));
      expect(Object.fromEntries(nodeSums(both.taxonomy)), at('nodes')).toEqual(Object.fromEntries(expectedNodes));
      const cardSums = (view: AmazonSpendingView) => new Map<string, Sums>(view.categories.map((c) => [JSON.stringify([c.currency, c.category]),
        { amountMinor: c.amountMinor, refundMinor: c.refundMinor, lines: c.lines }]));
      const expectedCards = cardSums(alone.card);
      for (const [key, sums] of freshCards) expectedCards.set(key, plus(expectedCards.get(key), sums));
      expect(Object.fromEntries(cardSums(both.card)), at('card categories')).toEqual(Object.fromEntries(expectedCards));
      // The Fresh tab's own breakdown is the Fresh part of the taxonomy's: Groceries' subcategories and Needs review one by
      // one, every other top level as a whole, and Groceries' rows together its top level.
      const pick = (rows: ReadonlyArray<{ amountMinor: number; refundMinor: number; lines: number }>) => ({
        amountMinor: sum(rows.map((c) => c.amountMinor)), refundMinor: sum(rows.map((c) => c.refundMinor)), lines: sum(rows.map((c) => c.lines)) });
      for (const category of both.fresh.categories) {
        if (category.category === 'groceries') continue;
        expect(pick([category]), at(`Fresh ${category.category}`)).toEqual(freshNodes.get(JSON.stringify([category.currency, category.category])));
      }
      for (const currency of new Set(both.fresh.categories.map((c) => c.currency))) {
        const groceries = both.fresh.categories.filter((c) => c.currency === currency && c.group === 'groceries');
        if (groceries.length) expect(pick(groceries), at(`Fresh groceries ${currency}`)).toEqual(freshNodes.get(JSON.stringify([currency, 'groceries'])));
      }
    }
  });

  it('shows each Fresh line in the taxonomy view exactly as the Fresh tab does: price, refund, node and what its list showed', () => {
    const { db } = household();
    for (const window of AMAZON_SPENDING_WINDOWS) {
      const { taxonomy, fresh, card } = views(db, window);
      const tab = new Map(fresh.products.flatMap((product) => product.purchases.map((purchase) => [purchase.ref, { product, purchase }])));
      const shown = taxonomy.products.filter((product) => product.fresh);
      expect(sum(shown.map((product) => product.lines)), window).toBe(fresh.lines.priced);
      for (const product of shown) {
        expect(product, window).toMatchObject({ cardCategory: null, cardCategorySource: null, refundedQuantity: 0 });
        expect(product.image).toBeUndefined();
        for (const purchase of product.purchases) {
          const twin = tab.get(purchase.ref);
          expect(twin, `${window} ${purchase.ref}`).toBeDefined();
          const { product: same, purchase: line } = twin!;
          expect({ amountMinor: purchase.amountMinor, refundMinor: purchase.refundMinor, orderRef: purchase.orderRef,
            orderDate: purchase.orderDate, fresh: purchase.fresh, node: product.node, source: product.source,
            confidence: product.confidence, suggested: product.suggested, suggestion: product.suggestion, title: product.title,
            asin: product.asin }).toEqual({ amountMinor: line.amountMinor, refundMinor: line.refundMinor, orderRef: line.orderRef,
            orderDate: line.orderDate, fresh: { status: line.status, quantity: line.quantity, weight: line.weight, unitPrice: line.unitPrice },
            node: same.node, source: same.source, confidence: same.confidence, suggested: same.suggested, suggestion: same.suggestion,
            title: same.title, asin: same.asin });
          // Its price as order-item units: units times unit price is the list's price; refunds are money, never units.
          expect(purchase.quantity * purchase.unitPriceMinor).toBe(purchase.amountMinor);
          expect(purchase.refundedQuantity).toBe(0);
        }
        // One product per Fresh product here: the same lines, quantity and weight.
        const same = fresh.products.find((p) => p.ref === product.ref)!;
        expect({ amountMinor: product.amountMinor, refundMinor: product.refundMinor, netMinor: product.netMinor, lines: product.lines,
          orders: product.orders, lastOrderDate: product.lastOrderDate, lastOrderRef: product.lastOrderRef, fresh: product.fresh })
          .toEqual({ amountMinor: same.amountMinor, refundMinor: same.refundMinor, netMinor: same.netMinor, lines: same.lines,
            orders: same.orders, lastOrderDate: same.lastOrderDate, lastOrderRef: same.lastOrderRef,
            fresh: { quantity: same.quantity, weight: same.weight } });
      }
      // The card view's Fresh products: the same lines, under their card category.
      const cards = card.products.filter((product) => product.fresh);
      expect(sum(cards.map((product) => product.lines)), window).toBe(fresh.lines.priced);
      for (const product of cards) {
        const same = fresh.products.find((p) => p.ref === product.ref)!;
        expect({ amountMinor: product.amountMinor, refundMinor: product.refundMinor, category: product.category, fresh: product.fresh })
          .toEqual({ amountMinor: same.amountMinor, refundMinor: same.refundMinor, category: freshCard(same.node),
            fresh: { quantity: same.quantity, weight: same.weight } });
        expect(product.image).toBeUndefined();
      }
    }
  });

  it('counts an order with an active Item List by that list only, never by its order item too', () => {
    const db = database();
    installFreshTables(db);
    const x = itemOrder(db, 'X', '2026-10-05', usd(5700), [item(LAMP, 1, usd(5000))]);
    const { refs } = seedFreshList(db, x, [freshLine(BANANAS.title, { asin: BANANAS.asin, quantity: 1, ...weighed('1.5', 60, 90) }),
      freshLine(YOGURT.title, { asin: YOGURT.asin, ...each(2, 300) })], { label: 'X' });
    const counted = (view: AmazonSpendingView | AmazonTaxonomySpendingView) => ({ orders: view.orders.count, priced: view.lines.priced,
      items: view.totals.map((t) => [t.currency, t.itemMinor]), asins: view.products.map((p) => p.asin).sort(),
      refs: view.products.map((p) => p.ref).sort() });
    const byList = { orders: 1, priced: 2, items: [['USD', 690]], asins: [BANANAS.asin, YOGURT.asin].sort(), refs: [...refs].sort() };
    for (const window of AMAZON_SPENDING_WINDOWS) {
      expect(counted(amazonSpending(db, window, TODAY)), window).toEqual(byList);
      expect(counted(amazonTaxonomySpending(db, window, TODAY)), window).toEqual(byList);
    }
    // Its order item is still the order's own, never touched: Fresh lines are never order items.
    expect(db.prepare('SELECT count(*) FROM amazon_items WHERE order_ref=?').pluck().get(x)).toBe(1);
    // Without an active list (the list retained, but not the order's), the same order counts by its order item alone.
    db.prepare('DELETE FROM amazon_fresh_orders WHERE order_ref=?').run(x);
    const byItem = { orders: 1, priced: 1, items: [['USD', 5000]], asins: [LAMP.asin], refs: [opaque('line-observation', ['X', 0])] };
    expect(counted(amazonSpending(db, '30D', TODAY))).toEqual(byItem);
    expect(counted(amazonTaxonomySpending(db, '30D', TODAY))).toEqual(byItem);
    expect(amazonSpending(db, '30D', TODAY).fresh).toBeUndefined();
  });

  it('never counts an order twice over generated histories: both views are the ordinary orders\' plus the Fresh tab\'s', () => {
    // A seeded generator (mulberry32): the same histories every run.
    let state = 20261022;
    const rand = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = Math.imul(state ^ (state >>> 15), state | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (n: number) => Math.floor(rand() * n);
    const DATES = ['2024-11-02', '2025-06-30', '2025-12-01', '2026-01-15', '2026-08-25', '2026-09-20', '2026-10-01', '2026-10-19', '2026-10-20'];
    const PRODUCTS = [PORK, EGGS, CHIPS, TOWELS, MYSTERY, BANANAS, YOGURT, CHEESE, HELD, ROUTER, LAMP, KETTLE];
    let both = 0, listOnly = 0, itemsOnly = 0, history = 0;
    for (let s = 0; s < 12; s++) {
      const db = database(), items = database();
      installFreshTables(db);
      for (let o = 0; o < 10; o++) {
        const name = `G${s}-${o}`, date = DATES[int(DATES.length)];
        const lines = Array.from({ length: 1 + int(3) }, () => item(PRODUCTS[int(PRODUCTS.length)], 1 + int(3), usd(100 + int(900))));
        const subtotal = lines.reduce((n, line) => n + line.quantity! * line.unitPrice!.amountMinor, 0);
        const kind = int(4); // 0: items only; 1: Item List only; 2: both; 3: items and a list that isn't the order's active one
        const withItems = kind !== 1, proven = rand() < 0.5;
        const refundTotal = rand() < 0.4 ? usd(1 + int(subtotal)) : null, ledger = rand() < 0.3 ? usd(1 + int(subtotal)) : null;
        for (const target of kind === 1 || kind === 2 ? [db] : [db, items]) {
          if (withItems) itemOrder(target, name, date, usd(subtotal), lines, proven);
          else seedOrder(target, name, date, usd(subtotal), subtotal);
          if (refundTotal) seedRefundTotal(target, name, refundTotal);
          if (ledger) seedLedgerRefund(target, name, '2026-10-02', ledger, s, o);
        }
        if (kind !== 0) {
          const listed = Array.from({ length: 1 + int(4) }, () => {
            const product = PRODUCTS[int(PRODUCTS.length)], roll = rand();
            return freshLine(product.title, { asin: product.asin, ...(roll < 0.4 ? weighed(`${1 + int(3)}.${int(99)}`, 100 + int(500), 100 + int(1500))
              : roll < 0.9 ? each(1 + int(3), 100 + int(800)) : { status: 'missing' as const, quantity: 1 }) });
          });
          seedFreshList(db, freshOrderRef(name), listed, { label: name, latest: kind !== 3 });
        }
        if (kind === 0) itemsOnly++; else if (kind === 1) listOnly++; else if (kind === 2) both++; else history++;
      }
      if (rand() < 0.5) { assignHousehold(db); assignHousehold(items); }
      for (const window of AMAZON_SPENDING_WINDOWS) {
        const mixed = views(db, window), alone = views(items, window), fresh = freshTotals(mixed.fresh);
        for (const [view, solo] of [[mixed.card, alone.card], [mixed.taxonomy, alone.taxonomy]] as const) {
          const at = `history ${s} ${window} ${'categories' in view ? 'card' : 'taxonomy'}`;
          expect(view.orders.count, at).toBe(solo.orders.count + mixed.fresh.orders.count);
          expect(view.lines.priced, at).toBe(solo.lines.priced + mixed.fresh.lines.priced);
          const mine = byCurrency<Net>(view.totals), theirs = byCurrency<Net>(solo.totals);
          for (const currency of new Set([...mine.keys(), ...theirs.keys(), ...fresh.keys()])) {
            const f = fresh.get(currency), t = theirs.get(currency), m = mine.get(currency);
            expect([m?.itemMinor ?? 0, m?.itemRefundMinor ?? 0, m?.unattributedRefundMinor ?? 0, m?.refundMinor ?? 0, m?.netItemMinor ?? 0], at)
              .toEqual([(t?.itemMinor ?? 0) + (f?.lineMinor ?? 0), (t?.itemRefundMinor ?? 0) + (f?.lineRefundMinor ?? 0),
                (t?.unattributedRefundMinor ?? 0) + (f?.unattributedRefundMinor ?? 0), (t?.refundMinor ?? 0) + (f?.refundMinor ?? 0),
                (t?.netItemMinor ?? 0) + (f?.netLineMinor ?? 0)]);
          }
        }
      }
    }
    // Every kind of order was generated: ordinary, Fresh, both, and a retained list that isn't the order's.
    expect(Math.min(both, listOnly, itemsOnly, history)).toBeGreaterThan(15);
  });

  it('files an unclassified Fresh line under Needs review, and by card category under Groceries as a default; the owner\'s choice wins', () => {
    const db = database();
    installFreshTables(db);
    const ref = seedOrder(db, 'U1', '2026-10-01', usd(1000), 1000);
    seedFreshList(db, ref, [freshLine(MYSTERY.title, { asin: MYSTERY.asin, ...each(1, 300) }),
      freshLine(PORK.title, { asin: PORK.asin, quantity: 1, ...weighed('1.75', 400, 700) })]);
    // Nothing classified yet: both lines in Needs review, and under Groceries by card category, said as a default.
    let card = amazonSpending(db, '30D', TODAY), taxonomy = amazonTaxonomySpending(db, '30D', TODAY);
    expect(taxonomy.nodes).toEqual([{ currency: 'USD', node: 'needs-review', amountMinor: 1000, refundMinor: 0, netMinor: 1000, lines: 2,
      refundedLines: 0, products: 2, orders: 1, refundedOrders: 0 }]);
    expect(taxonomy.lines).toMatchObject({ priced: 2, assigned: 0, needsReview: 2 });
    expect(card.categories.map((c) => [c.category, c.amountMinor, c.lines])).toEqual([[GROCERIES_CARD,
      1000, 2]]);
    expect(card.products.map((p) => [p.title, p.category, p.categorySource])).toEqual([[PORK.title, GROCERIES_CARD, 'fresh-default'],
      [MYSTERY.title, GROCERIES_CARD, 'fresh-default']]);
    expect(card.totals[0]).toMatchObject({ itemMinor: 1000, categorizedMinor: 1000 });
    // Classified: the pork by the owner, the mystery snack only weakly (Needs review with the agent's suggestion, so still
    // the default by card category).
    assignFreshHousehold(db);
    card = amazonSpending(db, '30D', TODAY);
    taxonomy = amazonTaxonomySpending(db, '30D', TODAY);
    expect(taxonomy.products.map((p) => [p.title, p.node, p.source, p.suggestion])).toEqual([
      [PORK.title, 'groceries/meat-seafood', 'owner', null],
      [MYSTERY.title, 'needs-review', null, { node: 'groceries/snacks-sweets', confidence: 0.5 }]]);
    expect(card.products.map((p) => [p.title, p.category, p.categorySource])).toEqual([
      [PORK.title, amazonTaxonomyNode('groceries/meat-seafood')!.cardCategory, 'item-taxonomy'],
      [MYSTERY.title, GROCERIES_CARD, 'fresh-default']]);
    // The owner's own choice for the snack wins over the agent's: filed there, under that node's card category.
    db.prepare('INSERT INTO amazon_product_taxonomy VALUES(?,?,?,?,1,?)').run(productKey(MYSTERY), 'owner', 'household/cleaning', 1,
      digest('synthetic owner mapping'));
    card = amazonSpending(db, '30D', TODAY);
    expect(amazonTaxonomySpending(db, '30D', TODAY).products.find((p) => p.title === MYSTERY.title))
      .toMatchObject({ node: 'household/cleaning', source: 'owner', suggestion: null });
    expect(card.products.find((p) => p.title === MYSTERY.title)).toMatchObject({
      category: amazonTaxonomyNode('household/cleaning')!.cardCategory, categorySource: 'item-taxonomy' });
    expect(card.categories.map((c) => [c.category, c.amountMinor])).toEqual([[GROCERIES_CARD, 700],
      [amazonTaxonomyNode('household')!.cardCategory, 300]]);
    // A title the card-data guard holds is never classified, whatever is assigned to its key: Needs review, and the default.
    const held = seedOrder(db, 'U2', '2026-10-02', usd(450), 450);
    const heldRefs = seedFreshList(db, held, [freshLine(HELD.title, each(1, 450))], { label: 'held' }).refs;
    card = amazonSpending(db, '30D', TODAY);
    expect(card.products.find((p) => p.ref === heldRefs[0])).toMatchObject({ title: '[redacted]', category: GROCERIES_CARD,
      categorySource: 'fresh-default' });
    expect(amazonTaxonomySpending(db, '30D', TODAY).products.find((p) => p.ref === heldRefs[0]))
      .toMatchObject({ title: '[redacted]', node: 'needs-review', source: null });
    expect(JSON.stringify([card, amazonTaxonomySpending(db, '30D', TODAY)])).not.toContain(HELD.title);
  });

  it('takes a Fresh order\'s refunds off its lines as the Fresh tab does: none is left with nothing to take it off', () => {
    const db = database();
    installFreshTables(db);
    seedFreshHousehold(db);
    const card = amazonSpending(db, '60D', TODAY), taxonomy = amazonTaxonomySpending(db, '60D', TODAY), fresh = amazonFresh(db, '60D', TODAY);
    // F1's Refund Total is exactly its chips: tied to them. F2's ledger refund proves no line: off its lines' total.
    expect(fresh.totals[0]).toMatchObject({ refundMinor: 335, lineRefundMinor: 235, unattributedRefundMinor: 100, netLineMinor: 3140 });
    for (const view of [card, taxonomy]) {
      expect(view.totals[0]).toMatchObject({ itemMinor: 3475, refundMinor: 335, itemRefundMinor: 235, unattributedRefundMinor: 100,
        netItemMinor: 3140 });
    }
    expect(card.products.find((p) => p.title === CHIPS.title)).toMatchObject({ amountMinor: 235, refundMinor: 235, netMinor: 0 });
    // How each counted refund was tied, as for an order's items: F1 by units, F2 by none (its list isn't proven whole).
    expect(card.refunds.orders.filter((entry) => entry.orders > 0)).toEqual([{ basis: 'units', orders: 1 }, { basis: 'unattributed', orders: 1 }]);
    expect(card.refunds.unattributed.filter((entry) => entry.orders > 0)).toEqual([{ reason: 'items-unproven', orders: 1 }]);
    expect(card.orders).toMatchObject({ count: 3, refunded: 2, itemsComplete: 2, noLines: 0 });
  });

  it('keeps card matches and itemized card charges as the resolver has them, and a charge-free order counts no line', () => {
    const { db } = household();
    const matchesOf = (view: AmazonSpendingView) => ({ linked: view.orders.linked, held: view.orders.held, unmatched: view.orders.unmatched,
      cardCharges: view.cardCharges, version: view.version });
    const before = AMAZON_SPENDING_WINDOWS.map((window) => matchesOf(amazonSpending(db, window, TODAY)));
    // No active list at all: the same orders, by their items (none for a Fresh order), match exactly as before.
    db.prepare('CREATE TEMP TABLE kept AS SELECT * FROM amazon_fresh_orders').run();
    db.prepare('DELETE FROM amazon_fresh_orders').run();
    expect(AMAZON_SPENDING_WINDOWS.map((window) => matchesOf(amazonSpending(db, window, TODAY)))).toEqual(before);
    db.prepare('INSERT INTO amazon_fresh_orders SELECT * FROM kept').run();
    // An order whose displayed decision is a charge-free proof (#158) counts with none of its list's lines, in both views.
    const proven = seedOrder(db, 'P1', '2026-10-03', null, undefined, 0, { chargeFree: { status: 'cancelled-not-charged', shipments: 1 } });
    seedFreshList(db, proven, [freshLine(CHEESE.title, { asin: CHEESE.asin, quantity: 1, linePrice: usd(1500) })], { label: 'P1' });
    const card = amazonSpending(db, '30D', TODAY), taxonomy = amazonTaxonomySpending(db, '30D', TODAY);
    expect(card.products.some((p) => p.asin === CHEESE.asin) || taxonomy.products.some((p) => p.asin === CHEESE.asin)).toBe(false);
    expect(card.fresh?.orders).toBe(amazonFresh(db, '30D', TODAY).orders.count);
  });

  it('only reads: no write, no new table, and nothing at all without the Fresh import\'s tables', () => {
    const { db } = household();
    const objects = () => db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all();
    const before = { objects: objects(), changes: db.prepare('SELECT total_changes()').pluck().get() };
    for (const window of AMAZON_SPENDING_WINDOWS) {
      amazonSpending(db, window, TODAY);
      amazonTaxonomySpending(db, window, TODAY);
    }
    expect({ objects: objects(), changes: db.prepare('SELECT total_changes()').pluck().get() }).toEqual(before);
    // An Amazon database the Fresh import never touched: its Fresh-like order headers count as orders without items.
    const plain = database();
    seedOrder(plain, 'F1', '2026-10-12', usd(2233), 2233);
    expect(amazonSpending(plain, '30D', TODAY)).toMatchObject({ orders: { count: 1, noLines: 1 }, lines: { count: 0 } });
    expect(amazonSpending(plain, '30D', TODAY).fresh).toBeUndefined();
    expect(amazonTaxonomySpending(plain, '30D', TODAY).fresh).toBeUndefined();
    expect(plain.prepare("SELECT count(*) FROM sqlite_master WHERE name LIKE 'amazon_fresh_%'").pluck().get()).toBe(0);
  });
});

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
