// The forecast's one-off split reads the category source's order links, as the insights and the overview do
// (cardSpendingOrderLinks.test.ts): a credit one of whose orders has a charge linked to a card row, on any card, pays back
// only one of those charges; any other refund goes by the merchant rule. Synthetic data only: fictional descriptors in
// the shapes issuers use, made-up amounts, dates, last-4s and order references.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { exceptCardSpendingPaths, mountCardSpendingRoutes } from './cardSpending.js';
import { createCardTransactionsRouter, type CardCategorySource } from './cardTransactions.js';
import { createCardSpendingForecastRouter } from './cardSpendingForecast.js';
import { SqliteStateRepo, type CardImportRow } from '../services/sqliteStateRepo.js';
import { listenLoopback } from '../testing/loopback.js';

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

function buildApp(categoryResolver: CardCategorySource): express.Express {
  const server = express();
  server.use(exceptCardSpendingPaths(express.json({ limit: '2mb' })));
  const log = (line: string) => logs.push(line);
  mountCardSpendingRoutes(server, {
    repo, requireAuth: testAuth, log,
    routers: [createCardTransactionsRouter(repo, { log, categoryResolver }), createCardSpendingForecastRouter(repo, { log, categoryResolver })],
  });
  return server;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-forecast-orders-'));
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
const MARKETPLACE = 'Merchandise & Supplies-Internet Purchase';

function months(from: string, count: number): string[] {
  const start = Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7)) - 1;
  return Array.from({ length: count }, (_, offset) => `${Math.floor((start + offset) / 12)}-${String(((start + offset) % 12) + 1).padStart(2, '0')}`);
}

const daysIn = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
const pad = (value: number) => String(value).padStart(2, '0');

/**
 * Two cards, both recorded from July 2025 through yesterday: groceries every other day and the bistro on card A, the
 * bistro on card B. On card A, a large one-off at a marketplace in June 2026 (order l01) and a credit at the same
 * marketplace in July (order x); order x's charge is on card B, in May.
 */
function seed() {
  const a = repo.createCardAccount({ issuer: 'citi', owner: 'alex', last4: '0001', currency: 'USD' });
  const b = repo.createCardAccount({ issuer: 'amex', owner: 'casey', last4: '0002', currency: 'USD' });
  const aRows: CardImportRow[] = [];
  const bRows: CardImportRow[] = [];
  months('2025-07', 16).forEach((month, index) => {
    const last = month === '2026-10' ? 21 : daysIn(month);
    for (let date = 1; date <= last; date += 2) {
      aRows.push(row({ transactionDate: `${month}-${pad(date)}`, amountMinor: 2_000 + ((date * 37 + index * 113) % 1_400), description: 'SAMPLE GROCER #0012 SAMPLETOWN', issuerCategory: GROCERIES }));
    }
    for (const [date, list] of [[9, aRows], [12, bRows], [26, bRows]] as const) {
      if (date > last) continue;
      list.push(row({ transactionDate: `${month}-${pad(date)}`, amountMinor: 4_000 + ((date * 53 + index * 71) % 1_200), description: 'SAMPLE BISTRO SAMPLETOWN', issuerCategory: RESTAURANT }));
    }
  });
  aRows.push(row({ transactionDate: '2026-06-14', amountMinor: 380_000, description: 'SAMPLE MARKETPLACE*L01', issuerCategory: MARKETPLACE }));
  aRows.push(row({ transactionDate: '2026-07-20', amountMinor: -50_000, kind: 'refund', description: 'SAMPLE MARKETPLACE*C01', issuerCategory: MARKETPLACE }));
  bRows.push(row({ transactionDate: '2026-05-10', amountMinor: 2_500, description: 'SAMPLE MARKETPLACE*X01', issuerCategory: MARKETPLACE }));
  for (const [card, rows] of [[a, aRows], [b, bRows]] as const) {
    repo.importCardTransactions({ cardAccountId: card.id, source: 'test-file', parserVersion: 'test@1', rows, coverage: { start: '2025-07-01', end: '2026-10-21' } });
  }
  const listed = repo.listCardTransactionsMatching({ statuses: ['posted'] });
  const id = (description: string) => listed.find((item) => item.description === description)!.id;
  return { a, b, large: id('SAMPLE MARKETPLACE*L01'), credit: id('SAMPLE MARKETPLACE*C01'), xCharge: id('SAMPLE MARKETPLACE*X01') };
}

/** A category source that describes rows and orders (as the Amazon domain's does), with no splits. */
function source(
  facts: ReadonlyMap<string, unknown>,
  orderMatches: (orderRef: string) => unknown,
): CardCategorySource {
  return {
    snapshot: () => ({
      version: 'rev-forecast-orders',
      resolve: () => new Map(),
      getCardDetail: ((rowId: string) => ({ version: 'rev-forecast-orders', ...(facts.get(rowId) as object ?? { match: 'none' }) })) as never,
      getOrderMatches: orderMatches as never,
    }),
  } as CardCategorySource;
}

const linked = (orderRefs: string[]) => ({ match: 'linked', evidenceClass: 'payment-event', items: [], orderRefs, coverage: { complete: false } });

type Book = { month: string; spendingMinor: number; oneOffsMinor: number | null; everydayMinor: number | null };

/** A forecast or patterns body without what order links may move. */
function withoutSplitFields(body: Record<string, any>): Record<string, any> {
  const copy = structuredClone(body);
  for (const book of copy.months ?? []) {
    delete book.oneOffsMinor;
    delete book.everydayMinor;
  }
  if (copy.fit) {
    delete copy.fit.oneOffRefundsMinor;
    delete copy.fit.oneOffsMinor;
  }
  delete copy.total;
  delete copy.categories;
  if (copy.pace) {
    for (const key of ['everydaySpentMinor', 'oneOffsMinor', 'restMinor', 'typicalMinor', 'everydayProjectedMinor', 'everydayRange80', 'projectedMinor', 'projectedRange80']) delete copy.pace[key];
  }
  delete copy.anomalies;
  return copy;
}

describe('GET /spending/forecast and /spending/patterns with order links', () => {
  it('a credit for another order (charged on another card) pays back no one-off, in the household\'s view and in one card\'s', async () => {
    const ids = seed();
    const facts = new Map<string, unknown>([[ids.large, linked(['order-l01'])], [ids.credit, linked(['order-x'])], [ids.xCharge, linked(['order-x'])]]);
    const matches = new Map<string, unknown[]>([
      ['order-l01', [{ state: 'linked', cardTransactionId: ids.large }]],
      ['order-x', [{ state: 'linked', cardTransactionId: ids.xCharge }, { state: 'linked', cardTransactionId: ids.credit }]],
    ]);
    const app = buildApp(source(facts, (orderRef) => matches.get(orderRef) ?? []));
    // The same source with every order's matches held: every credit is undecided, so the merchant rule alone, the
    // answer before order links.
    const before = buildApp(source(facts, () => [{ state: 'held' }]));
    for (const view of ['', `&cardAccountId=${ids.a.id}`]) {
      const forecastUrl = `/spending/forecast?today=${TODAY}${view}`;
      const now = (await get(app, forecastUrl)).body;
      const then = (await get(before, forecastUrl)).body;
      const book = (body: { months: Book[] }, month: string) => body.months.find((item) => item.month === month)!;
      // Before: July's credit paid June's one-off back. Now its order's charge is on card B, linked: it pays back no
      // one-off, in card A's view too, where that charge is not among the rows.
      expect(book(then, '2026-07').oneOffsMinor, view).toBe(-50_000);
      expect(book(now, '2026-07').oneOffsMinor, view).toBe(0);
      expect(book(now, '2026-07').everydayMinor, view).toBe(book(then, '2026-07').everydayMinor! - 50_000);
      expect(book(now, '2026-06'), view).toEqual(book(then, '2026-06'));
      expect(book(now, '2026-06').oneOffsMinor, view).toBe(380_000);
      expect(then.fit, view).toMatchObject({ completeMonths: 15, oneOffPurchases: 1, oneOffPurchasesMinor: 380_000, oneOffRefundsMinor: 50_000, oneOffsMinor: 330_000 });
      expect(now.fit, view).toEqual({ ...then.fit, oneOffRefundsMinor: 0, oneOffsMinor: 380_000 });
      for (const body of [now, then]) {
        for (const item of body.months as Book[]) if (item.oneOffsMinor !== null) expect(item.oneOffsMinor + item.everydayMinor!).toBe(item.spendingMinor);
      }
      // Only one-off and everyday figures move.
      expect(withoutSplitFields(now), view).toEqual(withoutSplitFields(then));
      expect(now, view).not.toEqual(then);
      const patternsUrl = `/spending/patterns?today=${TODAY}${view}`;
      expect(withoutSplitFields((await get(app, patternsUrl)).body), view).toEqual(withoutSplitFields((await get(before, patternsUrl)).body));
    }
    // The same order, or no order: exactly as before.
    const same = buildApp(source(new Map([...facts, [ids.credit, linked(['order-l01'])]]), (orderRef) => matches.get(orderRef) ?? []));
    const none = buildApp(source(new Map([...facts, [ids.credit, { match: 'none' }]]), (orderRef) => matches.get(orderRef) ?? []));
    for (const url of [`/spending/forecast?today=${TODAY}`, `/spending/patterns?today=${TODAY}`]) {
      const then = (await get(before, url)).body;
      expect((await get(same, url)).body, url).toEqual(then);
      expect((await get(none, url)).body, url).toEqual(then);
    }
    // The original basis reads no source: the merchant rule, as before order links.
    for (const url of [`/spending/forecast?today=${TODAY}&categoryBasis=original`, `/spending/patterns?today=${TODAY}&categoryBasis=original`]) {
      expect((await get(app, url)).body, url).toEqual((await get(before, url)).body);
    }
  });

  it('answers a source whose order matches fail with the standard value-free 500; the original basis reads no source', async () => {
    const ids = seed();
    const facts = new Map<string, unknown>([[ids.large, linked(['order-l01'])], [ids.credit, linked(['order-x'])]]);
    const app = buildApp(source(facts, () => { throw new Error('matches unavailable'); }));
    for (const url of [`/spending/forecast?today=${TODAY}`, `/spending/patterns?today=${TODAY}`]) {
      const res = await get(app, url);
      expect(res.status, url).toBe(500);
      expect(JSON.stringify(res.body), url).not.toContain('unavailable');
    }
    expect((await get(app, `/spending/forecast?today=${TODAY}&categoryBasis=original`)).status).toBe(200);
  });
});
