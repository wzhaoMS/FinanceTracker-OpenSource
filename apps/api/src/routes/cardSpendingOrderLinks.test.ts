// A credit the Amazon domain links to an order (STEP 9) is set against a large purchase in the one-off/everyday split
// only when that purchase is the same order's charge; a credit linked to none keeps the merchant rule (same card and
// merchant, within 90 days after). Through the live Amazon resolver and the routes, on the synthetic scenario of C's
// composition check (the regression basis): three orders on one card, a large charge with its own full refund, a credit
// for another order's line and a credit linked to none. Synthetic data only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { exceptCardSpendingPaths, mountCardSpendingRoutes } from './cardSpending.js';
import { createCardTransactionsRouter, type CardCategorySource } from './cardTransactions.js';
import { createCardSpendingOverviewRouter } from './cardSpendingOverview.js';
import { SqliteStateRepo, type CardImportRow } from '../services/sqliteStateRepo.js';
import { listenLoopback } from '../testing/loopback.js';
import { createAmazonCategoryResolver, type AmazonResolver } from '../services/amazon/resolver.js';
import { backedUpWrite, importAmazonCapture, recordBindingProposal, recordRootApproval } from '../services/amazon/importer.js';
import { proposeBindings, readCardInventory } from '../services/amazon/bindings.js';
import { rootApproval, syntheticCapture } from '../services/amazon/fixtures.testSupport.js';

let dir: string;
let repo: SqliteStateRepo;
let backups = 0;
const TODAY = '2026-11-15';
const auth: RequestHandler = (req, _res, next) => {
  req.holdrAuth = { kind: 'session', userId: 'test-owner', username: 'test-owner', sessionId: 'test-session' };
  next();
};
const backup = () => path.join(dir, `backup-${++backups}.db`);
const usd = (amountMinor: number) => ({ currency: 'USD', amountMinor });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-order-linked-credits-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db'), now: () => new Date(`${TODAY}T12:00:00.000Z`) });
  backups = 0;
});
afterEach(async () => {
  repo.close();
  await rm(dir, { recursive: true, force: true });
});

function row(patch: Partial<CardImportRow>): CardImportRow {
  return { transactionDate: '2026-09-10', postedDate: null, status: 'posted', amountMinor: 1000, currency: 'USD',
    kind: 'purchase', description: 'SAMPLE STORE', merchant: null, issuerCategory: null, ...patch } as CardImportRow;
}

/** C's card rows, by name, in C's order. */
const C_ROWS = {
  order1: row({ transactionDate: '2026-09-02', amountMinor: 1200, description: 'AMAZON MKTPL*SYNTH01', issuerCategory: 'Shopping' }),
  order2: row({ transactionDate: '2026-09-03', amountMinor: 1430, description: 'AMAZON MKTPL*SYNTH02', issuerCategory: 'Shopping' }),
  order1Refund: row({ transactionDate: '2026-09-20', amountMinor: -1200, kind: 'refund', description: 'AMAZON MKTPL*SYNTH03', issuerCategory: 'Shopping' }),
  order2Credit: row({ transactionDate: '2026-10-05', amountMinor: -660, kind: 'refund', description: 'AMAZON MKTPL*SYNTH04', issuerCategory: 'Shopping' }),
  unlinkedCredit: row({ transactionDate: '2026-10-07', amountMinor: -250, kind: 'refund', description: 'AMAZON MKTPL*SYNTH05', issuerCategory: 'Shopping' }),
  hardware: row({ transactionDate: '2026-10-08', amountMinor: 5000, description: 'SYNTHETIC HARDWARE STORE', issuerCategory: 'Home' }),
  hardwareRefund: row({ transactionDate: '2026-10-10', amountMinor: -1000, kind: 'refund', description: 'SYNTHETIC HARDWARE STORE', issuerCategory: 'Home' }),
  cafe: row({ transactionDate: '2026-10-12', amountMinor: 800, description: 'SYNTHETIC CAFE', issuerCategory: 'Dining' }),
  // The large one-off (two items) and its full refund, both in October.
  order3: row({ transactionDate: '2026-10-01', amountMinor: 62000, description: 'AMAZON MKTPL*SYNTH06', issuerCategory: 'Shopping' }),
  order3Refund: row({ transactionDate: '2026-10-20', amountMinor: -62000, kind: 'refund', description: 'AMAZON MKTPL*SYNTH07', issuerCategory: 'Shopping' }),
};
type RowName = keyof typeof C_ROWS;

/** C's three complete, single-card synthetic orders: 1 (700 + 500, no tax), 2 (600 + 400 + 300, tax 130), 3 (300.00 + 320.00). */
function capture() {
  const c = syntheticCapture();
  const base = c.staging.orders[0];
  const order = (orderId: string, date: string, lines: Array<[number, number]>, tax: number) => {
    const subtotal = lines.reduce((sum, [unit, qty]) => sum + unit * qty, 0), total = subtotal + tax;
    return { ...structuredClone(base), orderId, date, total: usd(total),
      items: lines.map(([unit, qty], lineOrdinal) => ({ lineOrdinal, itemId: `SYNTH${String(Number(orderId.slice(-2)) * 10 + lineOrdinal + 1).padStart(5, '0')}`,
        title: `Synthetic overview item ${orderId.slice(-2)}-${lineOrdinal}`, quantity: qty, unitPrice: usd(unit) })),
      summary: [{ kind: 'items-subtotal' as const, money: usd(subtotal) }, { kind: 'shipping' as const, money: usd(0) },
        { kind: 'tax' as const, money: usd(tax) }, { kind: 'grand-total' as const, money: usd(total) }],
      itemProof: { complete: true, unknownLine: false, conflict: false } };
  };
  c.staging.orders = [order('000-0000009-0000001', '2026-09-01', [[700, 1], [500, 1]], 0),
    order('000-0000009-0000002', '2026-09-02', [[600, 1], [400, 1], [300, 1]], 130),
    order('000-0000009-0000003', '2026-09-30', [[30000, 1], [32000, 1]], 0)];
  c.staging.coverage.orders = { status: 'partial', reason: 'budget', pages: 1, records: 3, rejected: 0 };
  c.staging.coverage.details = { status: 'partial', reason: 'budget', pages: 1, records: 7, rejected: 0 };
  return c;
}

/** C's setup without some of its rows: the card, its rows, the capture, the approved binding and the item categories. */
async function seed(without: readonly RowName[] = []) {
  const card = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9001', currency: 'USD' });
  const names = (Object.keys(C_ROWS) as RowName[]).filter((name) => !without.includes(name));
  repo.importCardTransactions({ cardAccountId: card.id, source: 'synthetic', parserVersion: 'synthetic@1', rows: names.map((name) => C_ROWS[name]) });
  const db = repo.internalGetDb();
  await importAmazonCapture(db, capture(), backup());
  const proposal = proposeBindings([{ network: 'visa', last4: '9001', cardAccountId: card.id }], readCardInventory(db));
  await recordBindingProposal(db, proposal, backup());
  await recordRootApproval(db, proposal, rootApproval(proposal), backup());
  const categories = ['Synthetic Kitchen', 'Synthetic Garden', 'Synthetic Toys'];
  await backedUpWrite(db, backup(), () => {
    for (const item of db.prepare('SELECT ref,data_json FROM amazon_items').all() as Array<{ ref: string; data_json: string }>) {
      db.prepare('INSERT OR REPLACE INTO amazon_item_overrides VALUES(?,?)').run(item.ref, categories[JSON.parse(item.data_json).lineOrdinal]);
    }
  });
  const listed = repo.queryCardTransactions({}).transactions;
  const ids = Object.fromEntries(names.map((name) => [name,
    listed.find((t) => t.description === C_ROWS[name].description && t.amountMinor === C_ROWS[name].amountMinor)!.id])) as Record<RowName, string>;
  return { resolver: createAmazonCategoryResolver(db), ids };
}

/**
 * The same source with no order links on any row (each linked row's `orderRefs` empty, its match and splits as they
 * are): every refund then goes by the merchant rule alone, the split before order links, with everything else alike.
 */
function withoutOrderLinks(source: AmazonResolver): CardCategorySource {
  return {
    snapshot: () => {
      const snapshot = source.snapshot();
      return { ...snapshot, getCardDetail: (id: string) => ({ ...snapshot.getCardDetail(id), orderRefs: [] }) };
    },
  };
}

/** The same source with every match of the given orders held: their charges linked to no card row. */
function withHeldOrders(source: AmazonResolver, held: readonly string[]): CardCategorySource {
  return {
    snapshot: () => {
      const snapshot = source.snapshot();
      return { ...snapshot, getOrderMatches: (orderRef: string) => (held.includes(orderRef)
        ? snapshot.getOrderMatches(orderRef).map(() => ({ state: 'held' }))
        : snapshot.getOrderMatches(orderRef)) };
    },
  };
}

type Get = (url: string) => Promise<any>;
async function serve(source: CardCategorySource): Promise<Get> {
  const server = express();
  server.use(exceptCardSpendingPaths(express.json({ limit: '2mb' })));
  const log = () => {};
  mountCardSpendingRoutes(server, { repo, requireAuth: auth, log, routers: [
    createCardTransactionsRouter(repo, { log, categoryResolver: source }),
    createCardSpendingOverviewRouter(repo, { log, categoryResolver: source }),
  ] });
  return async (url: string) => {
    const res = await request(await listenLoopback(server)).get(url);
    expect(res.status, url).toBe(200);
    return res.body;
  };
}

const WINDOWS = { baseline: { from: '2026-09-01', to: '2026-09-30' }, current: { from: '2026-10-01', to: '2026-10-31' } };
const compareUrl = (query = '') => `/spending/compare?from=${WINDOWS.current.from}&to=${WINDOWS.current.to}`
  + `&baselineFrom=${WINDOWS.baseline.from}&baselineTo=${WINDOWS.baseline.to}&today=${TODAY}${query}`;
const TREND = `/spending/trend?fromMonth=2026-09&toMonth=2026-10&today=${TODAY}`;
const insightsUrl = (query = '') => `/spending/insights?month=2026-10&today=${TODAY}${query}`;

interface Line { category: string; amountMinor: number; oneOffMinor: number; recurringMinor: number; everydayMinor: number; itemsMinor: number;
  merchants: Array<{ oneOffMinor: number }>; otherMerchants: { oneOffMinor: number } | null }
interface Window { spendingMinor: number; chargesMinor: number; creditsMinor: number; oneOffMinor: number; recurringMinor: number; everydayMinor: number;
  oneOffs: { count: number; grossMinor: number; refundsMinor: number; items: Array<{ id: string; amountMinor: number; refundedMinor: number }> };
  categories: Line[] }
/** A window's category lines as C's check reports them: [category, amount, one-off, everyday], by name. */
const lines = (window: Window) => window.categories.map((line) => [line.category, line.amountMinor, line.oneOffMinor, line.everydayMinor])
  .sort(([a], [b]) => (String(a) < String(b) ? -1 : 1));

/**
 * A body without the fields order links can move (as the PR lists them): insights' `largePurchases`, `pace`'s typical,
 * projected and large figures, `movers`, `merchantMovers` and `categoryBasis`; the overview's one-off and everyday
 * figures (each window's, category's and merchant line's, and what was refunded for a one-off), its one-off change,
 * drivers and remainder; the trend's monthly one-off and everyday figures. Everything left must not move.
 */
function withoutSplitFields(body: Record<string, any>): Record<string, any> {
  const copy = structuredClone(body);
  const window = (w: Record<string, any>) => {
    delete w.oneOffMinor;
    delete w.everydayMinor;
    delete w.oneOffs.refundsMinor;
    for (const item of w.oneOffs.items) delete item.refundedMinor;
    for (const line of w.categories) {
      delete line.oneOffMinor;
      delete line.everydayMinor;
      for (const merchant of line.merchants) delete merchant.oneOffMinor;
      if (line.otherMerchants) delete line.otherMerchants.oneOffMinor;
    }
  };
  if (copy.comparison) {
    window(copy.comparison.current);
    window(copy.comparison.baseline);
    delete copy.comparison.oneOffDeltaMinor;
    delete copy.comparison.drivers;
    delete copy.comparison.remainder;
  }
  if (Array.isArray(copy.months)) {
    for (const month of copy.months) {
      delete month.oneOffMinor;
      delete month.everydayMinor;
    }
  }
  if ('largePurchases' in copy) {
    delete copy.largePurchases;
    delete copy.movers;
    delete copy.merchantMovers;
    delete copy.categoryBasis;
    if (copy.pace) for (const key of ['typicalToDateMinor', 'typicalMonthMinor', 'projectedMinor', 'largeMinor', 'largeCount']) delete copy.pace[key];
  }
  return copy;
}

/** C's checks of one answer: its categories and item amounts are the summary's, and every part adds up, per filter and window. */
async function expectCsIdentities(get: Get) {
  const nonZero = (entries: Array<[string, number]>) => Object.fromEntries(entries.filter(([, n]) => n !== 0).sort(([a], [b]) => (a < b ? -1 : 1)));
  for (const category of [undefined, 'Synthetic Kitchen', 'Synthetic Garden', 'Shopping', 'Home']) {
    const filter = category === undefined ? '' : `&category=${encodeURIComponent(category)}`;
    const compared = (await get(compareUrl(filter))).comparison;
    for (const [name, range] of Object.entries(WINDOWS) as Array<['baseline' | 'current', { from: string; to: string }]>) {
      const summary = await get(`/spending/summary?from=${range.from}&to=${range.to}${filter}`);
      const window = compared[name] as Window;
      const byCategory = (summary.byCategory as Array<{ category: string; currency: string; spendingMinor: number }>).filter((c) => c.currency === 'USD');
      const items = (summary.fromAmazonItems as Array<{ category: string; currency: string; amountMinor: number }>).filter((c) => c.currency === 'USD');
      const label = `${name} ${category ?? 'all'}`;
      expect(nonZero(window.categories.map((l) => [l.category, l.amountMinor])), label).toEqual(nonZero(byCategory.map((c) => [c.category, c.spendingMinor])));
      expect(nonZero(window.categories.map((l) => [l.category, l.itemsMinor])), `${label} items`).toEqual(nonZero(items.map((c) => [c.category, c.amountMinor])));
      expect(window.categories.reduce((n, l) => n + l.amountMinor, 0), label).toBe(window.spendingMinor);
      expect(window.chargesMinor + window.creditsMinor, label).toBe(window.spendingMinor);
      expect(window.oneOffMinor + window.recurringMinor + window.everydayMinor, label).toBe(window.spendingMinor);
      expect(window.oneOffs.grossMinor + window.oneOffs.refundsMinor, label).toBe(window.oneOffMinor);
      for (const l of window.categories) expect(l.oneOffMinor + l.recurringMinor + l.everydayMinor, `${label} ${l.category}`).toBe(l.amountMinor);
    }
  }
  // Each category filter's one-offs and everyday spending are the unfiltered view's line, to the cent.
  const whole = (await get(compareUrl())).comparison.current as Window;
  for (const line of whole.categories) {
    const filtered = (await get(compareUrl(`&category=${encodeURIComponent(line.category)}`))).comparison.current as Window;
    expect([filtered.spendingMinor, filtered.oneOffMinor, filtered.everydayMinor], line.category).toEqual([line.amountMinor, line.oneOffMinor, line.everydayMinor]);
  }
  // The trend's months are the summary's, split into recurring, one-offs and everyday.
  for (const month of (await get(TREND)).months as Array<{ month: string; spendingMinor: number; recurringMinor: number; oneOffMinor: number; everydayMinor: number }>) {
    const range = month.month === '2026-09' ? WINDOWS.baseline : WINDOWS.current;
    const summary = await get(`/spending/summary?from=${range.from}&to=${range.to}`);
    const spending = (summary.byCategory as Array<{ currency: string; spendingMinor: number }>).filter((c) => c.currency === 'USD').reduce((n, c) => n + c.spendingMinor, 0);
    expect(month.spendingMinor, month.month).toBe(spending);
    expect(month.recurringMinor + month.oneOffMinor + month.everydayMinor, month.month).toBe(month.spendingMinor);
  }
}

describe('credits linked to an order, through the routes with the live Amazon resolver', () => {
  it('C\'s scenario: only the large charge\'s own refund and the unlinked credit are set against it; every figure still adds up', async () => {
    const { resolver, ids } = await seed();
    const get = await serve(resolver);
    const before = await serve(withoutOrderLinks(resolver));
    // Preconditions: STEP 9's links, as C's check found them.
    const detail = async (name: RowName) => (await get(`/card-transactions/${ids[name]}`)).amazon;
    const orders = async (name: RowName) => (await detail(name)).orderRefs as string[];
    expect(await detail('order2Credit')).toMatchObject({ match: 'linked', aggregate: 'split' });
    expect(await orders('order2Credit')).toEqual(await orders('order2'));
    expect(await orders('order3Refund')).toEqual(await orders('order3'));
    expect(await orders('order3')).toHaveLength(1);
    expect(await orders('order3')).not.toEqual(await orders('order2'));
    expect((await detail('unlinkedCredit')).match).not.toBe('linked');

    const nowBody = await get(compareUrl());
    const thenBody = await before(compareUrl());
    const now = nowBody.comparison;
    const then = thenBody.comparison;
    // Before order links (C's report on main): order 2's 6.60 credit was set against order 3's charge.
    expect(lines(then.current)).toEqual([['Dining', 800, 0, 800], ['Home', 4000, 0, 4000], ['Shopping', -250, -250, 0],
      ['Synthetic Garden', 0, 470, -470], ['Synthetic Kitchen', -660, -220, -440]]);
    // Now: order 2's credit is Synthetic Kitchen's everyday spending; order 3's own refund, set against its charge for
    // 617.50 with the unlinked 2.50, is apportioned over its two categories (318.71 and 298.79).
    expect(lines(now.current)).toEqual([['Dining', 800, 0, 800], ['Home', 4000, 0, 4000], ['Shopping', -250, -250, 0],
      ['Synthetic Garden', 0, 129, -129], ['Synthetic Kitchen', -660, 121, -781]]);
    for (const window of [now.current, then.current] as Window[]) {
      expect([window.spendingMinor, window.creditsMinor, window.oneOffMinor, window.everydayMinor]).toEqual([3890, -63910, 0, 3890]);
      expect([window.oneOffs.count, window.oneOffs.grossMinor, window.oneOffs.refundsMinor]).toEqual([1, 62000, -62000]);
      expect(window.oneOffs.items.map((item) => [item.id, item.refundedMinor])).toEqual([[ids.order3, 62000]]);
    }
    expect(now.baseline).toEqual(then.baseline);
    await expectCsIdentities(get);
    await expectCsIdentities(before);

    // Only the listed fields move; every other field of every answer is the same (the PR's golden diff against main
    // compares the raw answers too).
    expect(withoutSplitFields(nowBody)).toEqual(withoutSplitFields(thenBody));
    expect(nowBody).not.toEqual(thenBody);
    for (const url of [TREND, insightsUrl(), compareUrl('&category=Synthetic%20Kitchen')]) {
      expect(withoutSplitFields(await get(url)), url).toEqual(withoutSplitFields(await before(url)));
    }
    // The insights: order 3's charge was returned in full either way, so no large purchase is listed.
    expect((await get(insightsUrl())).largePurchases).toBeNull();
    // The original basis reads no Amazon source: the answer before order links.
    for (const url of [compareUrl('&categoryBasis=original'), `${TREND}&categoryBasis=original`, insightsUrl('&categoryBasis=original')]) {
      expect(await get(url), url).toEqual(await before(url));
    }
    // Undecided: had order 2's charge been held (linked to no card row), Holdr could not tell which purchase its credit
    // belongs to; the credit would go by the merchant rule, and every answer would be the one before order links.
    const heldOrder2 = await serve(withHeldOrders(resolver, await orders('order2')));
    for (const url of [compareUrl(), compareUrl('&category=Synthetic%20Kitchen'), TREND, insightsUrl()]) {
      expect(await heldOrder2(url), url).toEqual(await before(url));
    }
  });

  it('a partial return: another order\'s credit no longer lowers what the large purchase cost, in the insights, compare and trend', async () => {
    // C's scenario without order 3's full refund: only credits for other orders, or for none, are left near its charge.
    const { resolver, ids } = await seed(['order3Refund']);
    const get = await serve(resolver);
    const before = await serve(withoutOrderLinks(resolver));
    expect((await get(`/card-transactions/${ids.order2Credit}`)).amazon).toMatchObject({ match: 'linked' });
    expect((await get(`/card-transactions/${ids.order3}`)).amazon).toMatchObject({ match: 'linked' });

    const large = (body: Record<string, any>) => ({
      count: body.largePurchases.count, totalMinor: body.largePurchases.totalMinor, coreMinor: body.largePurchases.coreMinor,
      baselineCoreMinor: body.largePurchases.baselineCoreMinor,
      items: (body.largePurchases.items as Array<{ id: string; amountMinor: number; refundedMinor: number }>).map((item) => [item.id, item.amountMinor, item.refundedMinor]),
    });
    // October spent 658.90. Before: the 6.60 and 2.50 credits both lowered the large purchase. Now only the 2.50 does.
    expect(large(await before(insightsUrl()))).toEqual({ count: 1, totalMinor: 61090, coreMinor: 4800, baselineCoreMinor: 1430, items: [[ids.order3, 61090, 910]] });
    expect(large(await get(insightsUrl()))).toEqual({ count: 1, totalMinor: 61750, coreMinor: 4140, baselineCoreMinor: 1430, items: [[ids.order3, 61750, 250]] });
    expect((await get(insightsUrl())).spendingMinor).toBe(65890);
    // The original basis reads no Amazon source: the merchant rule alone, as before.
    expect(large(await get(insightsUrl('&categoryBasis=original')))).toEqual({
      count: 1, totalMinor: 61090, coreMinor: 4800, baselineCoreMinor: 1430, items: [[ids.order3, 61090, 910]],
    });

    const now = (await get(compareUrl())).comparison;
    const then = (await before(compareUrl())).comparison;
    expect([then.current.oneOffMinor, then.current.everydayMinor, then.current.oneOffs.refundsMinor]).toEqual([61090, 4800, -910]);
    expect([now.current.oneOffMinor, now.current.everydayMinor, now.current.oneOffs.refundsMinor]).toEqual([61750, 4140, -250]);
    expect(now.current.oneOffs.items.map((item: { id: string; refundedMinor: number }) => [item.id, item.refundedMinor])).toEqual([[ids.order3, 250]]);
    expect(lines(then.current).find(([category]) => category === 'Synthetic Kitchen')).toEqual(['Synthetic Kitchen', 29340, 29340, 0]);
    expect(lines(now.current).find(([category]) => category === 'Synthetic Kitchen')).toEqual(['Synthetic Kitchen', 29340, 30000, -660]);
    expect([now.oneOffDeltaMinor, then.oneOffDeltaMinor]).toEqual([61750, 61090]);
    const months = async (g: Get) => ((await g(TREND)).months as Array<{ month: string; spendingMinor: number; oneOffMinor: number; everydayMinor: number }>)
      .map((month) => [month.month, month.spendingMinor, month.oneOffMinor, month.everydayMinor]);
    expect(await months(before)).toEqual([['2026-09', 1430, 0, 1430], ['2026-10', 65890, 61090, 4800]]);
    expect(await months(get)).toEqual([['2026-09', 1430, 0, 1430], ['2026-10', 65890, 61750, 4140]]);
    await expectCsIdentities(get);

    // Only the listed fields move.
    for (const url of [compareUrl(), TREND, insightsUrl(), compareUrl('&category=Synthetic%20Kitchen'), compareUrl('&category=Shopping')]) {
      const body = await get(url);
      expect(withoutSplitFields(body), url).toEqual(withoutSplitFields(await before(url)));
    }
    expect(await get(compareUrl())).not.toEqual(await before(compareUrl()));
    expect(await get(insightsUrl())).not.toEqual(await before(insightsUrl()));
  });

  it('answers exactly as before when every linked credit near a large charge is that order\'s own', async () => {
    // C's scenario without the credit for order 2's line: what is left near order 3's charge is its own refund and a
    // credit linked to none.
    const { resolver } = await seed(['order2Credit']);
    const get = await serve(resolver);
    const before = await serve(withoutOrderLinks(resolver));
    const urls = [
      compareUrl(), ...['Synthetic Kitchen', 'Synthetic Garden', 'Shopping', 'Home'].map((category) => compareUrl(`&category=${encodeURIComponent(category)}`)),
      TREND, insightsUrl(), `/spending/insights?from=2026-10-01&to=2026-10-31&baselineFrom=2026-09-01&baselineTo=2026-09-30&today=${TODAY}`,
      `/spending/insights?month=2026-11&today=${TODAY}`,
    ];
    for (const url of urls) expect(await get(url), url).toEqual(await before(url));
  });

  it('Root\'s three branches through the routes, decided household-wide: a decisive link stays decisive in a one-card view', async () => {
    const cardA = repo.createCardAccount({ issuer: 'chase', owner: 'alex', last4: '9002', currency: 'USD' });
    const cardB = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9003', currency: 'USD' });
    const at = (date: string, amountMinor: number, description: string) =>
      row({ transactionDate: date, amountMinor, description, kind: amountMinor < 0 ? 'refund' : 'purchase', issuerCategory: 'Shopping' });
    const onA = {
      large: at('2026-10-01', 100_000, 'SAMPLE MARKETPLACE*L01'), // order l01
      held: at('2026-10-02', -1_000, 'SAMPLE MARKETPLACE*C01'), // a held detail: no link
      none: at('2026-10-03', -2_000, 'SAMPLE MARKETPLACE*C02'), // unmatched: no link
      notArray: at('2026-10-04', -3_000, 'SAMPLE MARKETPLACE*C03'), // malformed references: no link
      empty: at('2026-10-05', -4_000, 'SAMPLE MARKETPLACE*C04'),
      malformed: at('2026-10-06', -5_000, 'SAMPLE MARKETPLACE*C05'),
      otherOrder: at('2026-10-07', -6_000, 'SAMPLE MARKETPLACE*C06'), // decisive, another order: order x, charged on card B
      ownOrder: at('2026-10-08', -7_000, 'SAMPLE MARKETPLACE*C07'), // decisive, the same order
      undecided: at('2026-10-09', -8_000, 'SAMPLE MARKETPLACE*C08'), // order y: its only match is held
      creditOnly: at('2026-10-10', -9_000, 'SAMPLE MARKETPLACE*C09'), // order z: only this credit is linked to it, no charge
      // Small purchases, so the 1,000.00 charge is a large one-off (the year's 99th percentile, four times its median).
      ...Object.fromEntries([10, 11, 12, 13, 14].map((day) => [`cafe${day}`, at(`2026-09-${day}`, 1_000 + day, 'SAMPLE CAFE')])),
    };
    const xCharge = at('2026-09-20', 2_000, 'SAMPLE MARKETPLACE*X01');
    repo.importCardTransactions({ cardAccountId: cardA.id, source: 'synthetic', parserVersion: 'synthetic@1', rows: Object.values(onA) });
    repo.importCardTransactions({ cardAccountId: cardB.id, source: 'synthetic', parserVersion: 'synthetic@1', rows: [xCharge] });
    const listed = repo.queryCardTransactions({}).transactions;
    const id = (name: keyof typeof onA | 'xCharge') =>
      listed.find((t) => t.description === (name === 'xCharge' ? xCharge : onA[name]).description)!.id;
    const linked = (orderRefs: unknown) => ({ match: 'linked', evidenceClass: 'payment-event', items: [], orderRefs, coverage: { complete: false } });
    const facts = new Map<string, unknown>([
      [id('large'), linked(['order-l01'])],
      [id('held'), { match: 'held', hold: { reason: 'match-held', candidateCount: 2 }, orderRefs: ['order-x'], coverage: { complete: false } }],
      [id('notArray'), linked('order-x')],
      [id('empty'), linked([])],
      [id('malformed'), linked(['not a ref', 42, null])],
      // One well-formed reference among malformed ones: linked to that order, whose charge is not the large one.
      [id('otherOrder'), linked(['not a ref', 'order-x'])],
      [id('ownOrder'), linked(['order-l01'])],
      [id('undecided'), linked(['order-y'])],
      [id('creditOnly'), linked(['order-z'])],
      [id('xCharge'), linked(['order-x'])],
    ]);
    const matches = new Map<string, Array<{ state: string; cardTransactionId?: string }>>([
      ['order-l01', [{ state: 'linked', cardTransactionId: id('large') }, { state: 'linked', cardTransactionId: id('ownOrder') }]],
      ['order-x', [{ state: 'linked', cardTransactionId: id('xCharge') }, { state: 'linked', cardTransactionId: id('otherOrder') }]],
      ['order-y', [{ state: 'held' }]],
      ['order-z', [{ state: 'linked', cardTransactionId: id('creditOnly') }]],
    ]);
    const source = (detail: (rowId: string) => unknown, orderMatches: (orderRef: string) => unknown): CardCategorySource => ({
      snapshot: () => ({ version: 'rev-orders', resolve: () => new Map(), getCardDetail: detail as never, getOrderMatches: orderMatches as never }),
    });
    const get = await serve(source((rowId) => ({ version: 'rev-orders', ...(facts.get(rowId) as object ?? { match: 'none' }) }),
      (orderRef) => matches.get(orderRef) ?? []));
    // Set against the large charge: every credit with no link (held, unmatched, malformed), its own order's, and the
    // undecided ones (a held match, or no charge linked); never order x's, whose charge is linked on card B. The same
    // in a view of card A alone, where that charge is not among the rows.
    const setAgainst = 1_000 + 2_000 + 3_000 + 4_000 + 5_000 + 7_000 + 8_000 + 9_000;
    for (const view of ['', `&cardAccountId=${cardA.id}`]) {
      const insights = await get(insightsUrl(view));
      expect(insights.largePurchases.items.map((item: { id: string; refundedMinor: number }) => [item.id, item.refundedMinor]), view)
        .toEqual([[id('large'), setAgainst]]);
      const window = (await get(compareUrl(view))).comparison.current as Window;
      expect([window.oneOffMinor, window.oneOffs.refundsMinor], view).toEqual([100_000 - setAgainst, -setAgainst]);
      const october = ((await get(`${TREND}${view}`)).months as Array<{ month: string; oneOffMinor: number }>).find((month) => month.month === '2026-10');
      expect(october?.oneOffMinor, view).toBe(100_000 - setAgainst);
    }
    // A source whose detail or order matches fail is an operational failure: the standard value-free 500, never its text.
    for (const failing of [
      source(() => { throw new Error('detail unavailable'); }, (orderRef) => matches.get(orderRef) ?? []),
      source((rowId) => ({ version: 'rev-orders', ...(facts.get(rowId) as object ?? { match: 'none' }) }), () => { throw new Error('matches unavailable'); }),
    ]) {
      const server = express();
      server.use(exceptCardSpendingPaths(express.json({ limit: '2mb' })));
      mountCardSpendingRoutes(server, { repo, requireAuth: auth, log: () => {}, routers: [
        createCardTransactionsRouter(repo, { log: () => {}, categoryResolver: failing }),
        createCardSpendingOverviewRouter(repo, { log: () => {}, categoryResolver: failing }),
      ] });
      for (const url of [insightsUrl(), compareUrl(), TREND]) {
        const res = await request(await listenLoopback(server)).get(url);
        expect(res.status, url).toBe(500);
        expect(JSON.stringify(res.body), url).not.toMatch(/unavailable/);
      }
      // The original basis reads no source at all.
      expect((await request(await listenLoopback(server)).get(insightsUrl('&categoryBasis=original'))).status).toBe(200);
    }
  });
});
