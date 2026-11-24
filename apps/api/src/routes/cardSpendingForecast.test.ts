import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { exceptCardSpendingPaths, mountCardSpendingRoutes } from './cardSpending.js';
import { createCardTransactionsRouter, inferAll, type CardCategorySource } from './cardTransactions.js';
import { createCardSpendingForecastRouter } from './cardSpendingForecast.js';
import { SqliteStateRepo, type CardImportRow } from '../services/sqliteStateRepo.js';
import { listenLoopback } from '../testing/loopback.js';
import { buildCardCategoryInference, type CardCategoryResolution } from '@finance-tracker/shared';

// The patterns and forecast routes end to end. Synthetic data only: fictional descriptors in the shapes issuers use,
// made-up amounts, dates and last-4s.

const TODAY = '2026-10-22';
let dir: string;
let repo: SqliteStateRepo;
let logs: string[];

const testAuth: RequestHandler = (req, res, next) => {
  if (req.headers['x-test-auth'] === 'ok') {
    req.holdrAuth = { kind: 'session', userId: 'test-owner', username: 'test-owner', sessionId: 'test-session' };
    return next();
  }
  res.status(401).json({ error: 'sign in' });
};

function buildApp(options: { categoryResolver?: CardCategorySource } = {}): express.Express {
  const server = express();
  server.use(exceptCardSpendingPaths(express.json({ limit: '2mb' })));
  const log = (line: string) => logs.push(line);
  mountCardSpendingRoutes(server, {
    repo, requireAuth: testAuth, log, routers: [createCardTransactionsRouter(repo, { log, ...options }), createCardSpendingForecastRouter(repo, { log, ...options })],
  });
  return server;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-forecast-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db'), now: () => new Date('2026-10-22T12:00:00.000Z') });
  logs = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  expect(logs.join('\n')).not.toMatch(/\d{13}/);
  repo.close();
  await rm(dir, { recursive: true, force: true });
});

function row(patch: Partial<CardImportRow>): CardImportRow {
  return {
    transactionDate: '2026-09-10', postedDate: null, status: 'posted', amountMinor: 1000, currency: 'USD',
    kind: 'purchase', description: 'SAMPLE STORE', merchant: null, issuerCategory: null, ...patch,
  } as CardImportRow;
}

const get = async (app: express.Express, url: string) => request(await listenLoopback(app)).get(url).set('x-test-auth', 'ok');

const GROCERIES = 'Merchandise & Supplies-Groceries';
const RESTAURANT = 'Restaurant-Restaurant';
const STREAMING = 'Communications-Cable & Internet Comm';
const MARKETPLACE = 'Merchandise & Supplies-Internet Purchase';
const BOOKS = 'Merchandise & Supplies-Book Stores';
const TRAVEL = 'Travel-Airline';

function months(from: string, count: number): string[] {
  const start = Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7)) - 1;
  return Array.from({ length: count }, (_, offset) => `${Math.floor((start + offset) / 12)}-${String(((start + offset) % 12) + 1).padStart(2, '0')}`);
}

const daysIn = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

/** mulberry32: made-up amounts that are the same on every run, and never line up into a price that repeats monthly. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Two cards, both with their record from July 2025: Alex's in full, Casey's with five days of March 2026 missing (so
 * March 2026 is partial for the household). Groceries every other day, the bistro on irregular days, a monthly
 * streaming bill, a large one-off in June 2026 and a bullion purchase in July 2026.
 */
function seed() {
  const alex = repo.createCardAccount({ issuer: 'citi', owner: 'alex', last4: '0001', currency: 'USD' });
  const casey = repo.createCardAccount({ issuer: 'amex', owner: 'casey', last4: '0002', currency: 'USD' });
  const alexRows: CardImportRow[] = [];
  const caseyRows: CardImportRow[] = [];
  const pad = (day: number) => String(day).padStart(2, '0');
  // A seed whose made-up prices never line up into a second recurring charge (the detector reads price clusters).
  const amount = seeded(2);
  for (const month of months('2025-08', 15)) {
    const last = month === '2026-10' ? 21 : daysIn(month);
    for (let day = 1; day <= last; day += 2) {
      alexRows.push(row({ transactionDate: `${month}-${pad(day)}`, amountMinor: 2_000 + Math.floor(amount() * 1_400), description: 'SAMPLE GROCER #0012 SAMPLETOWN', issuerCategory: GROCERIES }));
    }
    alexRows.push(row({ transactionDate: `${month}-06`, amountMinor: 1_599, description: 'SAMPLE STREAMING', issuerCategory: 'Entertainment-Other Entertainment' }));
    // Irregular visits, so the bistro is no recurring charge.
    for (const day of [2, 11, 13, 25]) {
      if (month === '2026-03' && day >= 11 && day <= 15) continue;
      if (month === '2026-10' && day > 21) continue;
      caseyRows.push(row({ transactionDate: `${month}-${pad(day)}`, amountMinor: 4_000 + Math.floor(amount() * 1_200), description: 'SAMPLE BISTRO SAMPLETOWN', issuerCategory: RESTAURANT }));
    }
  }
  // July 2025, the records' first month, from its own made-up amounts so the months after it keep theirs.
  const july = seeded(5);
  for (let day = 1; day <= 31; day += 2) {
    alexRows.push(row({ transactionDate: `2025-07-${pad(day)}`, amountMinor: 2_000 + Math.floor(july() * 1_400), description: 'SAMPLE GROCER #0012 SAMPLETOWN', issuerCategory: GROCERIES }));
  }
  alexRows.push(row({ transactionDate: '2025-07-06', amountMinor: 1_599, description: 'SAMPLE STREAMING', issuerCategory: 'Entertainment-Other Entertainment' }));
  for (const day of [2, 11, 13, 25]) {
    caseyRows.push(row({ transactionDate: `2025-07-${pad(day)}`, amountMinor: 4_000 + Math.floor(july() * 1_200), description: 'SAMPLE BISTRO SAMPLETOWN', issuerCategory: RESTAURANT }));
  }
  alexRows.push(row({ transactionDate: '2026-06-14', amountMinor: 380_000, description: 'SAMPLE ELECTRONICS STORE', issuerCategory: 'Merchandise & Supplies-Electronics Stores' }));
  alexRows.push(row({ transactionDate: '2026-07-08', amountMinor: 520_000, description: 'SAMPLE BULLION EXCHANGE', issuerCategory: 'Merchandise & Supplies-Internet Purchase' }));
  alexRows.push(row({ transactionDate: '2026-10-20', amountMinor: 3_300, status: 'pending', description: 'SAMPLE BISTRO SAMPLETOWN', issuerCategory: RESTAURANT }));
  const imp = (id: string, rows: CardImportRow[], coverage: { start: string; end: string }) =>
    repo.importCardTransactions({ cardAccountId: id, source: 'test-file', parserVersion: 'test@1', rows, coverage });
  imp(alex.id, alexRows, { start: '2025-07-01', end: '2026-10-21' });
  imp(casey.id, caseyRows.filter((item) => item.transactionDate <= '2026-03-10'), { start: '2025-07-01', end: '2026-03-10' });
  imp(casey.id, caseyRows.filter((item) => item.transactionDate >= '2026-03-16'), { start: '2026-03-16', end: '2026-10-21' });
  const bullion = repo.listCardTransactionsMatching({ statuses: ['posted'] }).find((item) => item.description === 'SAMPLE BULLION EXCHANGE')!;
  return { alex, casey, bullion };
}

type Book = { month: string; spendingMinor: number; oneOffsMinor: number | null; everydayMinor: number | null; complete: boolean; inProgress: boolean };
type Range = { lowerMinor: number; upperMinor: number; basis: string; coverage: { inside: number; tested: number } };

const usd = (item: { currency: string }) => item.currency === 'USD';

/**
 * A view's forecast (with its patterns), checked against the summary of each of its fourteen complete months: the same
 * spending in each, the same categories, and each category's typical month the median of the summary's last six.
 */
async function forecastMatchingSummary(app: express.Express, view: string) {
  const forecast = (await get(app, `/spending/forecast?today=${TODAY}&${view}`)).body;
  const patterns = (await get(app, `/spending/patterns?today=${TODAY}&${view}`)).body;
  const complete = (forecast.months as Book[]).filter((book) => book.complete);
  expect(complete).toHaveLength(14);
  const byMonth = new Map<string, Map<string, number>>();
  for (const { month, spendingMinor } of complete) {
    const summary = (await get(app, `/spending/summary?${view}&from=${month}-01&to=${month}-${daysIn(month)}`)).body;
    expect(spendingMinor, month).toBe(summary.totals.find(usd)?.spendingMinor ?? 0);
    byMonth.set(month, new Map(summary.byCategory.filter(usd).map((item: { category: string; spendingMinor: number }) => [item.category, item.spendingMinor])));
  }
  expect(forecast.categories.map((item: { category: string }) => item.category).sort())
    .toEqual([...new Set([...byMonth.values()].flatMap((totals) => [...totals.keys()]))].sort());
  for (const series of forecast.categories as Array<{ category: string; recentMedianMinor: number }>) {
    const recent = complete.slice(-6).map(({ month }) => byMonth.get(month)!.get(series.category) ?? 0).sort((x, y) => x - y);
    expect(series.recentMedianMinor, series.category).toBe(Math.round((recent[2] + recent[3]) / 2));
  }
  return { ...forecast, patterns };
}

describe('GET /spending/forecast', () => {
  it('fits only complete months, reconciles every month with the summary, and forecasts the three months after this one', async () => {
    seed();
    const app = buildApp();
    const res = await get(app, `/spending/forecast?today=${TODAY}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.body;
    expect(body.currency).toBe('USD');
    expect(body.basis).toBe('enriched');
    expect(body.months.map((book: Book) => book.month)).toEqual(months('2025-07', 16));
    // March 2026 is partial: five of its days are missing from the second card's record. October is in progress.
    expect(body.months.filter((book: Book) => !book.complete).map((book: Book) => book.month)).toEqual(['2026-03', '2026-10']);
    // Two one-offs in the fitted months: June's electronics and July's bullion (spending until the owner says otherwise).
    expect(body.fit).toMatchObject({ from: '2025-07', to: '2026-09', completeMonths: 14, partialMonths: 1, oneOffPurchases: 2, oneOffPurchasesMinor: 900_000, oneOffRefundsMinor: 0, oneOffsMinor: 900_000 });
    expect(body.horizon).toEqual(['2026-11', '2026-12', '2027-01']);
    // Nothing keeps the household's months from being complete but March's missing days, which are not listed.
    expect(body.coverage).toEqual({ firstMonth: '2025-07', gaps: { lastCompletableMonth: '2026-09', behind: [], startingLater: [] } });

    const summary = (await get(app, '/spending/summary')).body as { byMonth: Array<{ month: string; currency: string; spendingMinor: number }> };
    const byMonth = new Map(summary.byMonth.filter((item) => item.currency === 'USD').map((item) => [item.month, item.spendingMinor]));
    for (const book of body.months as Book[]) {
      expect(book.spendingMinor).toBe(byMonth.get(book.month) ?? 0);
      // A partial month shows its spending only; every other month splits it exactly.
      if (book.month === '2026-03') expect([book.oneOffsMinor, book.everydayMinor]).toEqual([null, null]);
      else expect(book.oneOffsMinor! + book.everydayMinor!).toBe(book.spendingMinor);
    }
    expect(body.months.find((book: Book) => book.month === '2026-06').oneOffsMinor).toBe(380_000);

    expect(body.total).toMatchObject({ category: null, method: 'median-run-rate', tested: true, historyMonths: 14, thin: false });
    expect(body.total.months).toHaveLength(3);
    expect(body.total.backtest).toMatchObject({ from: '2026-07', to: '2026-09', months: 3, calibrationMonths: 10 });
    // Every range carries its tested coverage: each month's past estimates against the range the other nine gave.
    expect(body.total.backtest.coverage80.tested).toBe(body.total.backtest.calibrationForecasts);
    for (const item of body.total.months as Array<{ pointMinor: number; range80: Range; range95: Range }>) {
      expect(item.range80.lowerMinor).toBeLessThanOrEqual(item.pointMinor);
      expect(item.range80.upperMinor).toBeGreaterThanOrEqual(item.pointMinor);
      expect(item.range95.lowerMinor).toBeLessThanOrEqual(item.range80.lowerMinor);
      expect(item.range95.upperMinor).toBeGreaterThanOrEqual(item.range80.upperMinor);
      expect(item.range80.coverage).toEqual(body.total.backtest.coverage80);
      expect(item.range95.coverage).toEqual(body.total.backtest.coverage95);
    }
    // The one-offs are in no category; each category is forecast from its own months, largest typical month first.
    expect(body.categories.map((item: { category: string }) => item.category)).toEqual([GROCERIES, RESTAURANT, 'Entertainment-Other Entertainment']);

    expect(body.pace).toMatchObject({ month: '2026-10', daysElapsed: 22, daysInMonth: 31, pendingMinor: 3_300, monthSoFarComplete: true, historyMonths: 12 });
    const october = body.months.find((book: Book) => book.month === '2026-10');
    // The pace's parts: what was spent is everyday spending and one-offs; the month's total adds the one-offs as posted.
    expect(body.pace.spentMinor).toBe(october.spendingMinor);
    expect(body.pace.everydaySpentMinor).toBe(october.everydayMinor);
    expect(body.pace.oneOffsMinor).toBe(october.oneOffsMinor);
    expect(body.pace.everydayProjectedMinor).toBe(body.pace.everydaySpentMinor + body.pace.restMinor);
    expect(body.pace.projectedMinor).toBe(body.pace.everydayProjectedMinor + body.pace.oneOffsMinor);
    expect(body.pace.everydayRange80.coverage).toEqual({ inside: expect.any(Number), tested: 12 });
    expect(body.pace.projectedRange80).toEqual({
      lowerMinor: body.pace.everydayRange80.lowerMinor + body.pace.oneOffsMinor,
      upperMinor: body.pace.everydayRange80.upperMinor + body.pace.oneOffsMinor,
      coverage: body.pace.everydayRange80.coverage,
    });
  });

  it('labels every row exactly as the summary does, whichever card or month taught the label; amounts stay complete-only', async () => {
    const a = repo.createCardAccount({ issuer: 'citi', owner: 'alex', last4: '0007', currency: 'USD' });
    const b = repo.createCardAccount({ issuer: 'amex', owner: 'casey', last4: '0008', currency: 'USD' });
    const pad = (day: number) => String(day).padStart(2, '0');
    // Card A: fourteen complete months of groceries (the issuer's category), a fixed monthly bill, and a merchant with
    // no category of its own; nothing near a one-off before this month, so each complete month's everyday spending is
    // its spending. This month, one large purchase: a one-off.
    repo.importCardTransactions({
      cardAccountId: a.id, source: 'test-file', parserVersion: 'test@1', coverage: { start: '2025-08-01', end: '2026-10-21' },
      rows: [
        ...months('2025-08', 15).flatMap((month) => [
          ...[3, 12, 21].map((day) => row({ transactionDate: `${month}-${pad(day)}`, amountMinor: 2_000 + 37 * day + Number(month.slice(5)), description: 'SAMPLE GROCER #0012 SAMPLETOWN', issuerCategory: GROCERIES })),
          row({ transactionDate: `${month}-05`, amountMinor: 1_599, description: 'SAMPLE STREAMCO', issuerCategory: STREAMING }),
          row({ transactionDate: `${month}-09`, amountMinor: 1_100 + 13 * Number(month.slice(5)), description: 'SAMPLE DOVETAIL' }),
        ]),
        row({ transactionDate: '2026-10-06', amountMinor: 180_000, description: 'SAMPLE APPLIANCE OUTLET', issuerCategory: 'Merchandise & Supplies-Appliance Stores' }),
      ],
    });
    const app = buildApp();
    const view = `cardAccountId=${a.id}`;
    const parity = () => forecastMatchingSummary(app, view);
    const first = await parity();
    expect(first.categories.map((item: { category: string }) => item.category).sort()).toEqual([STREAMING, GROCERIES, 'Uncategorized']);
    expect(first.pace.oneOffsMinor).toBe(180_000);
    expect(first.patterns.bills.count).toBeGreaterThan(0);
    // Card B, out of view and with no record declared: three September rows at that merchant, labelled by the card...
    repo.importCardTransactions({
      cardAccountId: b.id, source: 'test-file', parserVersion: 'test@1',
      rows: [10, 11, 12].map((day) => row({ transactionDate: `2026-09-${day}`, amountMinor: 1_000, description: 'SAMPLE DOVETAIL', issuerCategory: TRAVEL })),
    });
    const second = await parity();
    expect(second.categories.map((item: { category: string }) => item.category).sort()).toEqual([STREAMING, GROCERIES, TRAVEL]);
    // ...then twenty this month, labelled otherwise: the summary's label for A's rows changes, and the forecast's with it.
    repo.importCardTransactions({
      cardAccountId: b.id, source: 'test-file', parserVersion: 'test@1',
      rows: Array.from({ length: 20 }, (_, index) => row({ transactionDate: `2026-10-${pad(1 + index)}`, amountMinor: 900 + index, description: 'SAMPLE DOVETAIL', issuerCategory: RESTAURANT })),
    });
    const third = await parity();
    expect(third.categories.map((item: { category: string }) => item.category).sort()).toEqual([STREAMING, GROCERIES, RESTAURANT]);
    // What is learned from amounts never moves: the months' books (one-offs and everyday), the total, the fit, the
    // threshold, the pace (this month's one-off with it), the bills, and what the anomaly check compared.
    for (const later of [second, third]) {
      expect(later.months).toEqual(first.months);
      expect(later.total).toEqual(first.total);
      expect(later.fit).toEqual(first.fit);
      expect(later.oneOffThresholdMinor).toBe(first.oneOffThresholdMinor);
      expect(later.pace).toEqual(first.pace);
      expect(later.patterns.bills).toEqual(first.patterns.bills);
      expect(later.patterns.checks).toEqual(first.patterns.checks);
      const everyday = (patterns: { anomalies: Array<{ category: string | null }> }) => patterns.anomalies.filter((item) => item.category === null);
      expect(everyday(later.patterns)).toEqual(everyday(first.patterns));
    }
    // A forecast learning its own labels from the view's complete months only would have kept September's: the check
    // above would catch it.
    const household = repo.listCardTransactionsMatching({ statuses: ['pending', 'posted'] });
    const ownLabels = buildCardCategoryInference(household.filter((item) => item.transactionDate < '2026-10-01'));
    const dovetail = repo.listCardTransactionsMatching({ cardAccountId: a.id, statuses: ['posted'] }).filter((item) => item.description === 'SAMPLE DOVETAIL');
    expect(new Set(inferAll(dovetail, ownLabels).rows.map((item) => item.inferredCategory))).toEqual(new Set([TRAVEL]));
  });

  it('relabels complete months when this month\'s own rows teach a merchant\'s category, exactly as the summary does', async () => {
    const a = repo.createCardAccount({ issuer: 'citi', owner: 'alex', last4: '0007', currency: 'USD' });
    // Fourteen complete months, each with a purchase at a merchant that has no category of its own.
    repo.importCardTransactions({
      cardAccountId: a.id, source: 'test-file', parserVersion: 'test@1', coverage: { start: '2025-08-01', end: '2026-10-21' },
      rows: months('2025-08', 14).flatMap((month) => [
        row({ transactionDate: `${month}-04`, amountMinor: 2_400 + Number(month.slice(5)), description: 'SAMPLE GROCER #0012 SAMPLETOWN', issuerCategory: GROCERIES }),
        row({ transactionDate: `${month}-09`, amountMinor: 1_000, description: 'SAMPLE DOVETAIL' }),
      ]),
    });
    const app = buildApp();
    const view = `cardAccountId=${a.id}`;
    const names = (forecast: { categories: Array<{ category: string }> }) => forecast.categories.map((item) => item.category).sort();
    const before = await forecastMatchingSummary(app, view);
    expect(names(before)).toEqual([GROCERIES, 'Uncategorized']);
    // This month, in progress and never fitted: two purchases there that the card files under travel. The summary now
    // files every earlier month's purchase there under travel, and so does the forecast.
    repo.importCardTransactions({
      cardAccountId: a.id, source: 'test-file', parserVersion: 'test@1',
      rows: ['06', '13'].map((day) => row({ transactionDate: `2026-10-${day}`, amountMinor: 1_000, description: 'SAMPLE DOVETAIL', issuerCategory: TRAVEL })),
    });
    const after = await forecastMatchingSummary(app, view);
    expect(names(after)).toEqual([GROCERIES, TRAVEL]);
    // Amounts are the complete months' alone: their books, the total's fit and forecast, and the threshold stay; the
    // pace takes the two purchases as this month's everyday spending, and nothing else moves.
    const complete = (forecast: { months: Book[] }) => forecast.months.filter((book) => book.complete);
    expect(complete(after)).toEqual(complete(before));
    expect(after.total).toEqual(before.total);
    expect(after.fit).toEqual(before.fit);
    expect(after.oneOffThresholdMinor).toBe(before.oneOffThresholdMinor);
    const shifted = (range: Range | null) => (range === null ? null : { ...range, lowerMinor: range.lowerMinor + 2_000, upperMinor: range.upperMinor + 2_000 });
    expect(before.pace.everydayRange80).not.toBeNull();
    expect(after.pace).toEqual({
      ...before.pace,
      spentMinor: before.pace.spentMinor + 2_000,
      everydaySpentMinor: before.pace.everydaySpentMinor + 2_000,
      everydayProjectedMinor: before.pace.everydayProjectedMinor + 2_000,
      everydayRange80: shifted(before.pace.everydayRange80),
      projectedMinor: before.pace.projectedMinor + 2_000,
      projectedRange80: shifted(before.pace.projectedRange80),
    });
  });

  it('splits rows exactly as the summary does, into categories the household knows from any card or month', async () => {
    const a = repo.createCardAccount({ issuer: 'citi', owner: 'alex', last4: '0007', currency: 'USD' });
    const b = repo.createCardAccount({ issuer: 'amex', owner: 'casey', last4: '0008', currency: 'USD' });
    // Card A: fourteen complete months of groceries and a marketplace order a month.
    repo.importCardTransactions({
      cardAccountId: a.id, source: 'test-file', parserVersion: 'test@1', coverage: { start: '2025-08-01', end: '2026-10-21' },
      rows: months('2025-08', 15).flatMap((month) => [
        ...['04', '18'].map((day) => row({ transactionDate: `${month}-${day}`, amountMinor: 2_400 + 29 * Number(day) + Number(month.slice(5)), description: 'SAMPLE GROCER #0012 SAMPLETOWN', issuerCategory: GROCERIES })),
        row({ transactionDate: `${month}-11`, amountMinor: 4_000 + 17 * Number(month.slice(5)), description: 'SAMPLE MARKETPLACE', issuerCategory: MARKETPLACE }),
      ]),
    });
    // Card B, out of view and with no record declared: one book this month, the only row anywhere filed under books.
    repo.importCardTransactions({
      cardAccountId: b.id, source: 'test-file', parserVersion: 'test@1',
      rows: [row({ transactionDate: '2026-10-04', amountMinor: 1_800, description: 'SAMPLE BOOKSHOP', issuerCategory: BOOKS })],
    });
    // The source files most of each order under books.
    const answers = new Map<string, CardCategoryResolution>();
    for (const order of repo.listCardTransactionsMatching({ cardAccountId: a.id, statuses: ['posted'] }).filter((item) => item.description === 'SAMPLE MARKETPLACE')) {
      const books = Math.trunc(order.amountMinor * 0.6);
      answers.set(order.id, {
        kind: 'split', cardTransactionId: order.id, currency: order.currency, evidenceClass: 'payment-event',
        contributions: [
          { amountMinor: books, category: BOOKS, categorySource: 'reviewed-mapping', classification: 'source' },
          { amountMinor: order.amountMinor - books, category: null, categorySource: null, classification: 'residual' },
        ],
      });
    }
    const app = buildApp({
      categoryResolver: { snapshot: () => ({ version: 'rev-books', resolve: (rows) => new Map([...answers].filter(([id]) => rows.some((item) => item.id === id))) }) },
    });
    const forecast = await forecastMatchingSummary(app, `cardAccountId=${a.id}`);
    expect(forecast.categories.map((item: { category: string }) => item.category).sort()).toEqual([MARKETPLACE, GROCERIES, BOOKS].sort());
    // The parts are the summary's, and the months' amounts are A's: the split moves categories, never a total.
    const unsplit = await forecastMatchingSummary(buildApp(), `cardAccountId=${a.id}`);
    expect(unsplit.categories.map((item: { category: string }) => item.category).sort()).toEqual([MARKETPLACE, GROCERIES].sort());
    expect(forecast.months).toEqual(unsplit.months);
    expect(forecast.total).toEqual(unsplit.total);
  });

  it('marks the month so far incomplete when a card in view has no record of its days', async () => {
    const { alex } = seed();
    repo.importCardTransactions({
      cardAccountId: repo.createCardAccount({ issuer: 'chase', owner: 'joint', last4: '0003', currency: 'USD' }).id,
      source: 'test-file', parserVersion: 'test@1', rows: [row({ transactionDate: '2026-10-03', description: 'SAMPLE HARDWARE' })],
      coverage: { start: '2026-10-03', end: '2026-10-03' },
    });
    const app = buildApp();
    expect((await get(app, `/spending/forecast?today=${TODAY}`)).body.pace.monthSoFarComplete).toBe(false);
    expect((await get(app, `/spending/forecast?today=${TODAY}&cardAccountId=${alex.id}`)).body.pace.monthSoFarComplete).toBe(true);
    expect((await get(app, '/spending/forecast?today=2026-10-01')).body.pace.monthSoFarComplete).toBe(null);
  });

  it('reads one person\'s cards with their own coverage', async () => {
    const { casey } = seed();
    const app = buildApp();
    const body = (await get(app, `/spending/forecast?today=${TODAY}&owner=casey`)).body;
    expect(body.fit).toMatchObject({ from: '2025-07', to: '2026-09', completeMonths: 14, partialMonths: 1 });
    expect(body.categories.map((item: { category: string }) => item.category)).toEqual([RESTAURANT]);
    expect((await get(app, `/spending/forecast?today=${TODAY}&cardAccountId=${casey.id}`)).body.total).toEqual(body.total);
  });

  it('never lets a month before a later card\'s record into a fit, the pace or an anomaly window', async () => {
    const { alex } = seed();
    const late = repo.createCardAccount({ issuer: 'chase', owner: 'joint', last4: '0003', currency: 'USD' });
    repo.importCardTransactions({
      cardAccountId: late.id, source: 'test-file', parserVersion: 'test@1', coverage: { start: '2026-05-01', end: '2026-10-21' },
      rows: months('2026-05', 6).flatMap((month) => [5, 18].filter((day) => month !== '2026-10' || day <= 21).map((day) =>
        row({ transactionDate: `${month}-${String(day).padStart(2, '0')}`, amountMinor: 6_000 + day, description: 'SAMPLE HARDWARE', issuerCategory: 'Merchandise & Supplies-Hardware Supplies' }))),
    });
    const app = buildApp();
    const forecast = (await get(app, `/spending/forecast?today=${TODAY}`)).body;
    const patterns = (await get(app, `/spending/patterns?today=${TODAY}`)).body;
    // A card whose record starts later looks just like history not imported: no month before it is complete.
    expect(forecast.months.filter((book: Book) => book.month < '2026-05').every((book: Book) => !book.complete)).toBe(true);
    expect(forecast.fit).toMatchObject({ from: '2026-05', to: '2026-09', completeMonths: 5, partialMonths: 0 });
    expect(forecast.pace.from >= '2026-05').toBe(true);
    expect(patterns.checks.every((check: { from: string | null }) => check.from === null || check.from >= '2026-05')).toBe(true);
    // Why: the later card, by id and date only (the page names it).
    expect(forecast.coverage).toEqual({ firstMonth: '2025-07', gaps: { lastCompletableMonth: '2026-09', behind: [], startingLater: [{ cardAccountId: late.id, firstKnown: '2026-05-01' }] } });
    // Five months cannot be backtested from three months ahead: an estimate, untested and without a range.
    expect(forecast.total).toMatchObject({ method: 'median-run-rate', tested: false, backtest: null });
    expect(forecast.total.months.every((item: { range80: unknown }) => item.range80 === null)).toBe(true);
    // A card on its own still learns from all of its own complete months.
    expect((await get(app, `/spending/forecast?today=${TODAY}&cardAccountId=${alex.id}`)).body.fit).toMatchObject({ from: '2025-07', completeMonths: 15 });
  });

  it('says which cards are behind: their statements stop before the last month that could be complete', async () => {
    seed();
    const stale = repo.createCardAccount({ issuer: 'chase', owner: 'joint', last4: '0004', currency: 'USD' });
    repo.importCardTransactions({
      cardAccountId: stale.id, source: 'test-file', parserVersion: 'test@1', coverage: { start: '2025-07-01', end: '2026-06-30' },
      rows: months('2025-07', 12).map((month) => row({ transactionDate: `${month}-12`, amountMinor: 2_500 + Number(month.slice(5)), description: 'SAMPLE HARDWARE' })),
    });
    const forecast = (await get(buildApp(), `/spending/forecast?today=${TODAY}`)).body;
    expect(forecast.coverage.gaps).toEqual({ lastCompletableMonth: '2026-09', behind: [{ cardAccountId: stale.id, coveredThrough: '2026-06-30' }], startingLater: [] });
    // No month after its statements stop is complete, so the fit ends in June.
    expect(forecast.fit).toMatchObject({ to: '2026-06' });
  });

  it('never moves a baseline when the owner files a purchase as precious metals', async () => {
    const { bullion } = seed();
    const app = buildApp();
    const before = (await get(app, `/spending/forecast?today=${TODAY}`)).body;
    const patternsBefore = (await get(app, `/spending/patterns?today=${TODAY}`)).body;
    const patch = await request(await listenLoopback(app)).patch(`/card-transactions/${bullion.id}`).set('x-test-auth', 'ok')
      .set('content-type', 'application/json').send(JSON.stringify({ userCategory: 'Precious metals' }));
    expect(patch.status).toBe(200);
    const after = (await get(app, `/spending/forecast?today=${TODAY}`)).body;
    expect(after.total).toEqual(before.total);
    expect(after.categories).toEqual(before.categories);
    expect(after.pace).toEqual(before.pace);
    expect((await get(app, `/spending/patterns?today=${TODAY}`)).body).toEqual(patternsBefore);
    // July's spending and one-offs drop by the purchase; its everyday spending does not move.
    const july = (body: { months: Book[] }) => body.months.find((book) => book.month === '2026-07')!;
    expect(july(after).spendingMinor).toBe(july(before).spendingMinor - 520_000);
    expect(july(after).oneOffsMinor).toBe(july(before).oneOffsMinor! - 520_000);
    expect(july(after).everydayMinor).toBe(july(before).everydayMinor);
  });

  it('answers on the original basis too, and refuses bad queries without echoing them', async () => {
    seed();
    const app = buildApp();
    expect((await get(app, `/spending/forecast?today=${TODAY}&categoryBasis=original`)).body.basis).toBe('original');
    const cases: Array<[string, number, string]> = [
      ['?today=2026-13-01', 400, 'today must be a valid YYYY-MM-DD date'],
      ['?owner=nobody', 400, 'owner must be alex, casey or joint'],
      ['?cardAccountId=nope', 404, 'card account not found'],
      ['?cardAccountId=bad id', 400, 'cardAccountId is invalid'],
      ['?currency=usd', 400, 'currency must be a three-letter uppercase code'],
      ['?categoryBasis=mixed', 400, 'categoryBasis must be enriched or original'],
    ];
    for (const [query, status, error] of cases) {
      for (const route of ['/spending/forecast', '/spending/patterns']) {
        const res = await get(app, `${route}${query}`);
        expect(res.status, `${route}${query}`).toBe(status);
        expect(res.body.error).toBe(error);
      }
    }
    const unknown = await get(app, '/spending/forecast?month=2026-10');
    expect(unknown.status).toBe(400);
    const card = await get(app, '/spending/forecast?today=4111111111111111');
    expect(card.status).toBe(422);
    expect(JSON.stringify(card.body)).not.toContain('4111');
    expect((await request(await listenLoopback(app)).get('/spending/forecast')).status).toBe(401);
  });
});

describe('GET /spending/patterns', () => {
  it('lists the bills due in the next 60 days, adding up, and the checks it ran', async () => {
    seed();
    const app = buildApp();
    const res = await get(app, `/spending/patterns?today=${TODAY}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { bills, checks } = res.body;
    expect(bills).toMatchObject({ from: TODAY, to: '2026-12-21', activeCharges: 1 });
    // Each bill says what shows it bills: the charges in the recurring detector's window, and their months.
    expect(bills.items).toEqual([
      expect.objectContaining({ date: '2026-11-05', merchant: 'SAMPLE STREAMING', amountMinor: 1_599, expectedBeforeToday: false, late: false, evidence: { occurrences: 13, from: '2025-10', to: '2026-10' } }),
      expect.objectContaining({ date: '2026-12-05', merchant: 'SAMPLE STREAMING', amountMinor: 1_599, expectedBeforeToday: false, late: false, evidence: { occurrences: 13, from: '2025-10', to: '2026-10' } }),
    ]);
    expect(bills.totalMinor).toBe(bills.items.reduce((total: number, item: { amountMinor: number }) => total + item.amountMinor, 0));
    expect(bills.thisMonth).toEqual({ through: '2026-10-31', dueMinor: 0, dueCount: 0, chargedMinor: 1_599, chargedCount: 1 });
    expect(checks.map((item: { window: string; month: string; checked: boolean; historyMonths: number }) => [item.window, item.month, item.checked, item.historyMonths]))
      .toEqual([['month', '2026-09', true, 12]]);
  });

  it('never compares the month in progress, even when every card\'s record of its days is complete', async () => {
    const { casey } = seed();
    repo.importCardTransactions({
      cardAccountId: casey.id, source: 'test-file', parserVersion: 'test@1',
      rows: [3, 4, 5, 6, 7, 8].map((day) => row({ transactionDate: `2026-10-0${day}`, amountMinor: 9_000, description: 'SAMPLE BISTRO SAMPLETOWN', issuerCategory: RESTAURANT })),
      coverage: { start: '2026-10-03', end: '2026-10-08' },
    });
    const app = buildApp();
    expect((await get(app, `/spending/forecast?today=${TODAY}`)).body.pace.monthSoFarComplete).toBe(true);
    const body = (await get(app, `/spending/patterns?today=${TODAY}`)).body;
    expect(body.checks.map((item: { month: string }) => item.month)).toEqual(['2026-09']);
    expect(body.anomalies.filter((item: { month: string }) => item.month === '2026-10')).toEqual([]);
  });

  it('flags a category that ran far above its usual in the last complete month', async () => {
    const { casey } = seed();
    repo.importCardTransactions({
      cardAccountId: casey.id, source: 'test-file', parserVersion: 'test@1',
      rows: [3, 4, 5, 6, 7, 8].map((day) => row({ transactionDate: `2026-09-0${day}`, amountMinor: 9_000, description: 'SAMPLE BISTRO SAMPLETOWN', issuerCategory: RESTAURANT })),
      coverage: { start: '2026-09-03', end: '2026-09-08' },
    });
    const body = (await get(buildApp(), `/spending/patterns?today=${TODAY}`)).body;
    const bistro = body.anomalies.find((item: { category: string | null }) => item.category === RESTAURANT);
    expect(bistro).toMatchObject({ window: 'month', direction: 'high', month: '2026-09', historyMonths: 12 });
    expect(bistro.amountMinor).toBeGreaterThan(bistro.medianMinor + 3 * bistro.sigmaMinor);
  });
});
