import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import type { CardCategoryContribution, CardCategoryResolution } from '@finance-tracker/shared';
import { cardSpendingLineRows, cardSpendingOtherLines, cardSpendingOtherMerchants } from '@finance-tracker/shared';
import { addMonths, daysIn, seededRandom, syntheticSpendingLedger } from '@finance-tracker/shared/spending-fixtures';

// The overview's routes end to end. Synthetic data only: fictional descriptors in the shapes issuers use, made-up
// amounts, dates and last-4s.

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
  const categoryResolver = options.categoryResolver ?? null;
  mountCardSpendingRoutes(server, {
    repo, requireAuth: testAuth, log,
    routers: [createCardTransactionsRouter(repo, { log, categoryResolver }), createCardSpendingOverviewRouter(repo, { log, categoryResolver })],
  });
  return server;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-overview-'));
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

describe('GET /spending/coverage/months', () => {
  function seedCoverage() {
    const early = repo.createCardAccount({ issuer: 'citi', owner: 'alex', last4: '0001', currency: 'USD' });
    const late = repo.createCardAccount({ issuer: 'amex', owner: 'casey', last4: '0002', currency: 'USD' });
    const unknown = repo.createCardAccount({ issuer: 'chase', owner: 'joint', last4: '0003', currency: 'USD' });
    const imp = (id: string, rows: CardImportRow[], coverage: { start: string; end: string }) =>
      repo.importCardTransactions({ cardAccountId: id, source: 'test-file', parserVersion: 'test@1', rows, coverage });
    imp(early.id, [row({ transactionDate: '2026-06-03' }), row({ transactionDate: '2026-08-14' })], { start: '2026-06-01', end: '2026-09-30' });
    // The second card's history starts in August, mid-month: August is not known for it; September is.
    imp(late.id, [row({ transactionDate: '2026-08-20' }), row({ transactionDate: '2026-09-02' })], { start: '2026-08-15', end: '2026-10-21' });
    return { early, late, unknown };
  }

  it('says per month which cards are expected, have data and are covered; only finished, fully covered months are complete', async () => {
    const { early, late } = seedCoverage();
    const app = buildApp();
    const res = await get(app, '/spending/coverage/months?today=2026-10-22');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      months: [
        // The second card first appears on August 15: June and July may be missing it, so they are not complete.
        { month: '2026-06', complete: false, cardsWithData: 1, cardsExpected: 1, cardsCovered: 1, cardsStartingLater: 1, inProgress: false, uncoveredCardIds: [] },
        { month: '2026-07', complete: false, cardsWithData: 0, cardsExpected: 1, cardsCovered: 1, cardsStartingLater: 1, inProgress: false, uncoveredCardIds: [] },
        { month: '2026-08', complete: false, cardsWithData: 2, cardsExpected: 2, cardsCovered: 1, cardsStartingLater: 0, inProgress: false, uncoveredCardIds: [late.id] },
        { month: '2026-09', complete: true, cardsWithData: 1, cardsExpected: 2, cardsCovered: 2, cardsStartingLater: 0, inProgress: false, uncoveredCardIds: [] },
        // Neither card's coverage reaches October's end; October is still going anyway.
        { month: '2026-10', complete: false, cardsWithData: 0, cardsExpected: 2, cardsCovered: 0, cardsStartingLater: 0, inProgress: true, uncoveredCardIds: [early.id, late.id].sort() },
      ],
    });
  });

  it('scopes to one card or one person, and takes month bounds', async () => {
    const { late } = seedCoverage();
    const app = buildApp();
    const one = await get(app, `/spending/coverage/months?today=2026-10-22&cardAccountId=${late.id}&fromMonth=2026-09&toMonth=2026-09`);
    expect(one.body.months).toEqual([
      { month: '2026-09', complete: true, cardsWithData: 1, cardsExpected: 1, cardsCovered: 1, cardsStartingLater: 0, inProgress: false, uncoveredCardIds: [] },
    ]);
    // On its own, the first card's June and July are complete: no card in view starts later.
    const person = await get(app, '/spending/coverage/months?today=2026-10-22&owner=alex&toMonth=2026-07');
    expect(person.body.months.map((item: { month: string; complete: boolean }) => [item.month, item.complete])).toEqual([['2026-06', true], ['2026-07', true]]);
    // A person with a card but nothing stored: no months.
    expect((await get(app, '/spending/coverage/months?today=2026-10-22&owner=joint')).body).toEqual({ months: [] });
  });

  it('refuses bad parameters without echoing them', async () => {
    seedCoverage();
    const app = buildApp();
    for (const [query, status] of [
      ['fromMonth=2026-13', 400], ['toMonth=26-01', 400], ['fromMonth=2026-09&toMonth=2026-08', 400], ['today=2026-02-30', 400],
      ['owner=someone', 400], ['cardAccountId=missing-card', 404], ['unexpected=1', 400], ['cardAccountId=bad%20id', 400],
    ] as const) {
      const res = await get(app, `/spending/coverage/months?${query}`);
      expect(res.status, query).toBe(status);
      expect(JSON.stringify(res.body)).not.toContain('someone');
    }
    // Card data in the query is a 422 with paths only.
    const card = await get(app, '/spending/coverage/months?today=4111111111111111');
    expect(card.status).toBe(422);
    expect(JSON.stringify(card.body)).not.toContain('4111');
  });
});

// ---------------------------------------------------------------------------
// Compare and trend: what the summary counts, split exactly
// ---------------------------------------------------------------------------

const TODAY = '2026-10-22';
type Window = {
  from: string; to: string; spendingMinor: number; chargesMinor: number; creditsMinor: number; count: number;
  recurringMinor: number; oneOffMinor: number; everydayMinor: number;
  oneOffs: { count: number; grossMinor: number; refundsMinor: number; items: Array<{ id: string; amountMinor: number }> };
  recurring: Array<{ key: string; amountMinor: number; count: number }>;
  categories: Array<{
    category: string; amountMinor: number; oneOffMinor: number; recurringMinor: number; everydayMinor: number; count: number; itemsMinor: number;
    merchants: Array<{ key: string; name: string; itemized: boolean; amountMinor: number; oneOffMinor: number; recurringMinor: number; count: number }>;
    otherMerchants: { amountMinor: number; oneOffMinor: number; recurringMinor: number; lines: number; count: number } | null;
  }>;
  coverage: { complete: boolean; inProgress: boolean; cardsWithData: number; cardsExpected: number; cardsCovered: number; uncoveredCardIds: string[] };
};
type Comparison = {
  currency: string; thresholdMinor: number; current: Window; baseline: Window; deltaMinor: number; oneOffDeltaMinor: number;
  drivers: Array<{ category: string; currentMinor: number; baselineMinor: number; deltaMinor: number;
    merchants: Array<{ deltaMinor: number }>; otherMerchants: { deltaMinor: number; lines: number } }>;
  remainder: { deltaMinor: number; categories: number };
};
type Totals = { currency: string; spendingMinor: number; chargesMinor: number; creditsMinor: number; count: number };
type Summary = {
  totals: Totals[]; byCategory: Array<{ currency: string; category: string; spendingMinor: number }>;
  byMonth: Array<{ currency: string; month: string; spendingMinor: number; count: number }>;
  fromAmazonItems?: Array<{ currency: string; category: string; amountMinor: number }>;
};

const sumOf = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const monthBounds = (month: string) => ({ from: `${month}-01`, to: `${month}-${String(daysIn(month)).padStart(2, '0')}` });

/**
 * A synthetic household through the real import: two to four USD cards and one in EUR over 15 months to September
 * 2026, the first card's imports declaring their dates and the others' not, and the owner's word that some
 * warehouse-club online orders were precious metals.
 */
async function seedLedger(app: express.Express, seed: number) {
  const ledger = syntheticSpendingLedger({ seed, months: 15, start: '2025-07', foreign: true });
  const issuers = ['citi', 'amex', 'chase', 'samplebank', 'eurobank'];
  const accounts = new Map(ledger.cards.map((card, index) => [card.id, repo.createCardAccount({
    issuer: issuers[index], owner: card.owner, last4: String(4759 + index), currency: card.currency,
  })]));
  ledger.cards.forEach((card, index) => {
    const rows = ledger.rows.filter((row) => row.cardAccountId === card.id).map((row): CardImportRow => ({
      transactionDate: row.transactionDate, postedDate: null, status: row.status, amountMinor: row.amountMinor, currency: row.currency,
      kind: row.kind, description: row.description, merchant: row.merchant ?? null, issuerCategory: row.issuerCategory ?? null,
    }));
    const dates = rows.map((row) => row.transactionDate).sort();
    repo.importCardTransactions({
      cardAccountId: accounts.get(card.id)!.id, source: 'test-file', parserVersion: 'test@1', rows,
      coverage: index === 0 ? { start: `${dates[0].slice(0, 7)}-01`, end: dates[dates.length - 1] } : null,
    });
  });
  const stored = repo.listCardTransactionsMatching({ statuses: ['pending', 'posted'] });
  const used = new Set<string>();
  for (const row of ledger.rows.filter((item) => item.userCategory)) {
    const match = stored.find((item) => !used.has(item.id) && item.cardAccountId === accounts.get(row.cardAccountId)!.id
      && item.transactionDate === row.transactionDate && item.amountMinor === row.amountMinor && item.description === row.description)!;
    used.add(match.id);
    const res = await request(await listenLoopback(app)).patch(`/card-transactions/${match.id}`).set('x-test-auth', 'ok')
      .set('content-type', 'application/json').send(JSON.stringify({ userCategory: row.userCategory }));
    expect(res.status).toBe(200);
  }
  return { ledger, accounts: [...accounts.values()], metals: used };
}

function expectWindow(window: Window, label: string) {
  expect(window.recurringMinor + window.oneOffMinor + window.everydayMinor, `${label}: split`).toBe(window.spendingMinor);
  expect(sumOf(window.categories.map((line) => line.amountMinor)), `${label}: categories`).toBe(window.spendingMinor);
  expect(window.oneOffs.grossMinor + window.oneOffs.refundsMinor, `${label}: one-offs`).toBe(window.oneOffMinor);
  expect(sumOf(window.recurring.map((line) => line.amountMinor)), `${label}: recurring`).toBe(window.recurringMinor);
  for (const line of window.categories) {
    expect(line.oneOffMinor + line.recurringMinor + line.everydayMinor, `${label} ${line.category}`).toBe(line.amountMinor);
    const merchants = sumOf(line.merchants.map((item) => item.amountMinor)) + (line.otherMerchants?.amountMinor ?? 0);
    expect(merchants, `${label} ${line.category}: merchants`).toBe(line.amountMinor);
  }
}

function expectChange(comparison: Comparison, label: string) {
  expect(comparison.deltaMinor).toBe(comparison.current.spendingMinor - comparison.baseline.spendingMinor);
  expect(comparison.oneOffDeltaMinor + sumOf(comparison.drivers.map((driver) => driver.deltaMinor)) + comparison.remainder.deltaMinor, `${label}: change`)
    .toBe(comparison.deltaMinor);
  for (const driver of comparison.drivers) {
    expect(sumOf(driver.merchants.map((item) => item.deltaMinor)) + driver.otherMerchants.deltaMinor, `${label} ${driver.category}`).toBe(driver.deltaMinor);
  }
}

describe('GET /spending/compare', () => {
  it('compares exactly what the summary counts, for every filter and both baselines, and each change adds up', async () => {
    const app = buildApp();
    const { accounts, metals } = await seedLedger(app, 7);
    const current = monthBounds('2026-09');
    const baselines = [monthBounds('2026-08'), monthBounds('2025-09')];
    const grocer = encodeURIComponent('Merchandise & Supplies-Groceries');
    for (const filter of ['', '&owner=alex', `&cardAccountId=${accounts[0].id}`, `&category=${grocer}`, '&merchant=SAMPLE%20GROCER', '&q=SAMPLE', '&categoryBasis=original']) {
      for (const baseline of baselines) {
        const url = `/spending/compare?from=${current.from}&to=${current.to}&baselineFrom=${baseline.from}&baselineTo=${baseline.to}&today=${TODAY}${filter}`;
        const res = await get(app, url);
        expect(res.status, url).toBe(200);
        const comparison = res.body.comparison as Comparison;
        expect(comparison.currency).toBe('USD');
        for (const [window, range] of [[comparison.current, current], [comparison.baseline, baseline]] as const) {
          const summary = (await get(app, `/spending/summary?from=${range.from}&to=${range.to}${filter}`)).body as Summary;
          const totals = summary.totals.find((item) => item.currency === 'USD');
          expect([window.spendingMinor, window.chargesMinor, window.creditsMinor, window.count], `${url} ${range.from}`)
            .toEqual([totals?.spendingMinor ?? 0, totals?.chargesMinor ?? 0, totals?.creditsMinor ?? 0, totals?.count ?? 0]);
          expect(window.categories.map((line) => [line.category, line.amountMinor]).sort(), `${url} ${range.from}: categories`)
            .toEqual(summary.byCategory.filter((item) => item.currency === 'USD').map((item) => [item.category, item.spendingMinor]).sort());
          expectWindow(window, `${url} ${range.from}`);
          // The owner's precious metals are an asset, never spending, so never a one-off.
          expect(window.oneOffs.items.filter((item) => metals.has(item.id))).toEqual([]);
        }
        expectChange(comparison, url);
      }
    }
  });

  it('drills down exactly: each merchant line is the list\'s rows for its category and merchant', async () => {
    const app = buildApp();
    await seedLedger(app, 11);
    const current = monthBounds('2026-09');
    const baseline = monthBounds('2026-08');
    const comparison = (await get(app, `/spending/compare?from=${current.from}&to=${current.to}&baselineFrom=${baseline.from}&baselineTo=${baseline.to}&today=${TODAY}`))
      .body.comparison as Comparison;
    let lines = 0;
    for (const line of comparison.current.categories) {
      for (const merchant of line.merchants) {
        const list = (await get(app, `/card-transactions?status=posted&limit=200&from=${current.from}&to=${current.to}`
          + `&category=${encodeURIComponent(line.category)}&merchant=${encodeURIComponent(merchant.key)}`)).body as {
          transactions: Array<{ status: string; role: string; merchantKey: string; amountMinor: number; categoryPortionMinor?: number; split?: unknown; currency: string }>;
          nextOffset: number | null;
        };
        expect(list.nextOffset).toBeNull();
        // The rows the drill-down picks, by the shared rule the page uses.
        const counted = cardSpendingLineRows(list.transactions, merchant, 'USD');
        expect(counted.sumMinor, `${line.category} / ${merchant.key}`).toBe(merchant.amountMinor);
        expect(counted.rows.length).toBe(merchant.count);
        lines += 1;
      }
    }
    expect(lines).toBeGreaterThan(8);
  });

  it('drills down within a view\'s own merchant: a store\'s line is never widened to its merchant group', async () => {
    const app = buildApp();
    const card = repo.createCardAccount({ issuer: 'citi', owner: 'alex', last4: '4242', currency: 'USD' });
    repo.importCardTransactions({
      cardAccountId: card.id, source: 'test-file', parserVersion: 'test@1', coverage: null,
      rows: [
        row({ transactionDate: '2026-09-05', amountMinor: 5_000, description: 'NORTHWIND GROCER SEATTLE', issuerCategory: 'Groceries' }),
        row({ transactionDate: '2026-09-06', amountMinor: 7_000, description: 'NORTHWIND GROCER PORTLAND', issuerCategory: 'Groceries' }),
        row({ transactionDate: '2026-08-07', amountMinor: 3_000, description: 'NORTHWIND GROCER SEATTLE', issuerCategory: 'Groceries' }),
      ],
    });
    const current = monthBounds('2026-09');
    const baseline = monthBounds('2026-08');
    const view = `&merchant=${encodeURIComponent('NORTHWIND GROCER SEATTLE')}`;
    const comparison = (await get(app, `/spending/compare?from=${current.from}&to=${current.to}&baselineFrom=${baseline.from}&baselineTo=${baseline.to}&today=${TODAY}${view}`))
      .body.comparison as Comparison;
    expect([comparison.current.spendingMinor, comparison.baseline.spendingMinor]).toEqual([5_000, 3_000]);
    const [category] = comparison.current.categories;
    expect(category.merchants.map((item) => [item.key, item.amountMinor, item.count])).toEqual([['NORTHWIND GROCER', 5_000, 1]]);
    const merchant = category.merchants[0];
    type Listed = { transactions: Array<{ id: string; status: string; role: string; merchantKey: string; amountMinor: number; currency: string; split?: unknown }> };
    const listed = async (merchantFilter: string) => (await get(app, `/card-transactions?status=posted&limit=200&from=${current.from}&to=${current.to}`
      + `&category=${encodeURIComponent(category.category)}&merchant=${encodeURIComponent(merchantFilter)}`)).body as Listed;
    // The line's group alone takes in the Portland store too...
    expect(cardSpendingLineRows((await listed(merchant.key)).transactions, merchant, 'USD').sumMinor).toBe(12_000);
    // ...so the drill-down keeps the view's own merchant, and the line is exactly its rows.
    const own = cardSpendingLineRows((await listed('NORTHWIND GROCER SEATTLE')).transactions, merchant, 'USD');
    expect([own.rows.length, own.sumMinor]).toEqual([1, merchant.amountMinor]);
  });

  it('opens "other merchants" exactly: what a category and the view by merchant leave unnamed is the list\'s rows, to the cent', async () => {
    const app = buildApp();
    const card = repo.createCardAccount({ issuer: 'citi', owner: 'alex', last4: '4343', currency: 'USD' });
    // Thirty fictional grills in one category: more than a category names (8) and than the summary lists (25). One has
    // two stores, which group as one; one has a refund, which nets within it; a card payment is no merchant's.
    const trees = ['ALDER', 'ASPEN', 'BIRCH', 'CEDAR', 'CYPRESS', 'ELM', 'FIR', 'HAZEL', 'HOLLY', 'JUNIPER', 'LARCH', 'LAUREL', 'LINDEN', 'MAPLE',
      'MYRTLE', 'OAK', 'OLIVE', 'PINE', 'POPLAR', 'REDWOOD', 'ROWAN', 'SPRUCE', 'SUMAC', 'TAMARACK', 'WALNUT', 'WILLOW', 'YEW', 'ACACIA', 'BAMBOO', 'CHESTNUT'];
    const rows = trees.map((tree, index) => row({
      transactionDate: `2026-09-${String(1 + (index % 28)).padStart(2, '0')}`, amountMinor: 10_000 - index * 100,
      description: `${tree} SAMPLE GRILL`, issuerCategory: 'Dining',
    }));
    rows.push(
      row({ transactionDate: '2026-09-15', amountMinor: 450, description: 'YEW SAMPLE GRILL SEATTLE', issuerCategory: 'Dining' }),
      row({ transactionDate: '2026-09-16', amountMinor: -300, kind: 'refund', description: 'WILLOW SAMPLE GRILL', issuerCategory: 'Dining' }),
      row({ transactionDate: '2026-09-17', amountMinor: -50_000, kind: 'payment', description: 'AUTOPAY PAYMENT THANK YOU' }),
      row({ transactionDate: '2026-08-10', amountMinor: 2_000, description: 'ALDER SAMPLE GRILL', issuerCategory: 'Dining' }),
    );
    repo.importCardTransactions({ cardAccountId: card.id, source: 'test-file', parserVersion: 'test@1', coverage: null, rows });
    const current = monthBounds('2026-09');
    const baseline = monthBounds('2026-08');
    type Listed = {
      transactions: Array<{ id: string; status: string; role: string; currency: string; merchantKey: string; merchantName: string; amountMinor: number;
        categoryPortionMinor?: number; split?: unknown }>;
      nextOffset: number | null;
    };
    const list = async (query: string) => (await get(app, `/card-transactions?status=posted&kind=purchase,refund,fee,interest,adjustment&limit=200`
      + `&from=${current.from}&to=${current.to}${query}`)).body as Listed;

    // By category: eight lines named, and the rest read from the category's rows.
    const comparison = (await get(app, `/spending/compare?from=${current.from}&to=${current.to}&baselineFrom=${baseline.from}&baselineTo=${baseline.to}&today=${TODAY}`))
      .body.comparison as Comparison;
    const [dining] = comparison.current.categories;
    expect(dining.merchants).toHaveLength(8);
    expect(dining.otherMerchants).toMatchObject({ lines: 22, count: 24, amountMinor: 179_450 });
    const inCategory = await list('&category=Dining');
    expect(inCategory.nextOffset).toBeNull();
    const lines = cardSpendingOtherLines(inCategory.transactions, dining.merchants, 'USD');
    expect([lines.lines.length, lines.count, lines.sumMinor]).toEqual([22, 24, 179_450]);
    expect(lines.lines.some((line) => dining.merchants.some((named) => named.key === line.key))).toBe(false);
    expect(lines.lines.find((line) => line.key === 'YEW SAMPLE GRILL')).toMatchObject({ count: 2, amountMinor: 7_850 });
    expect(lines.lines.find((line) => line.key === 'WILLOW SAMPLE GRILL')).toMatchObject({ count: 2, amountMinor: 7_200 });
    // Each is exactly what that line's own read would pick, as a named line's is.
    for (const line of lines.lines.slice(0, 3)) {
      const own = cardSpendingLineRows((await list(`&category=Dining&merchant=${encodeURIComponent(line.key)}`)).transactions, line, 'USD');
      expect(own.rows.map((item) => item.id).sort(), line.key).toEqual(line.rows.map((item) => item.id).sort());
    }

    // By merchant: the summary lists 25; the rest, read from the view's rows, are its other merchants to the cent.
    type Merchants = { byMerchant: Array<{ merchant: string; merchantKey: string; currency: string; spendingMinor: number }>;
      otherMerchants: Array<{ currency: string; merchants: number; count: number; spendingMinor: number }> };
    const summary = (await get(app, `/spending/summary?from=${current.from}&to=${current.to}`)).body as Summary & Merchants;
    expect(summary.byMerchant).toHaveLength(25);
    expect(summary.otherMerchants).toEqual([expect.objectContaining({ currency: 'USD', merchants: 5, count: 6, spendingMinor: 36_400 })]);
    const inView = await list('');
    expect(inView.nextOffset).toBeNull();
    const rest = cardSpendingOtherMerchants(inView.transactions, summary.byMerchant, 'USD', { complete: inView.nextOffset === null });
    expect(rest.merchants.map((item) => [item.merchant, item.spendingMinor, item.count])).toEqual([
      ['WALNUT SAMPLE GRILL', 7_600, 1], ['ACACIA SAMPLE GRILL', 7_300, 1], ['WILLOW SAMPLE GRILL', 7_200, 2],
      ['BAMBOO SAMPLE GRILL', 7_200, 1], ['CHESTNUT SAMPLE GRILL', 7_100, 1],
    ]);
    // "Filter this spending view" on one of them narrows the page to exactly it.
    for (const item of rest.merchants) {
      const narrowed = (await get(app, `/spending/summary?from=${current.from}&to=${current.to}&merchant=${encodeURIComponent(item.merchantKey)}`)).body as Summary;
      expect(narrowed.totals.find((total) => total.currency === 'USD')?.spendingMinor, item.merchantKey).toBe(item.spendingMinor);
    }
  });

  it('files Amazon item parts as their own merchant line and ties them to their charges, to the cent', async () => {
    const answers = new Map<string, CardCategoryResolution>();
    const resolver: CardCategorySource = {
      snapshot: () => ({ version: 'rev-items', resolve: (rows) => new Map([...answers].filter(([id]) => rows.some((row) => row.id === id))) }),
    };
    const app = buildApp({ categoryResolver: resolver });
    await seedLedger(app, 12);
    const next = seededRandom(99);
    for (const row of repo.listCardTransactionsMatching({ statuses: ['posted'] })) {
      if (!row.description.startsWith('SAMPLE MARKETPLACE') || next() < 0.3) continue;
      const item = Math.trunc(row.amountMinor * 0.6);
      const contributions: CardCategoryContribution[] = [
        { amountMinor: item, category: next() < 0.5 ? 'Merchandise & Supplies-Groceries' : 'Merchandise & Supplies-Furnishing', categorySource: 'reviewed-mapping', classification: 'source' },
        { amountMinor: row.amountMinor - item, category: null, categorySource: null, classification: 'residual' },
      ];
      answers.set(row.id, { kind: 'split', cardTransactionId: row.id, currency: row.currency, evidenceClass: 'payment-event', contributions });
    }
    expect(answers.size).toBeGreaterThan(10);
    const current = monthBounds('2026-09');
    const baseline = monthBounds('2025-09');
    const comparison = (await get(app, `/spending/compare?from=${current.from}&to=${current.to}&baselineFrom=${baseline.from}&baselineTo=${baseline.to}&today=${TODAY}`))
      .body.comparison as Comparison;
    const summary = (await get(app, `/spending/summary?from=${current.from}&to=${current.to}`)).body as Summary;
    expect(comparison.current.categories.map((line) => [line.category, line.amountMinor]).sort())
      .toEqual(summary.byCategory.filter((item) => item.currency === 'USD').map((item) => [item.category, item.spendingMinor]).sort());
    // What items put in each category is the summary's own line.
    const items = new Map((summary.fromAmazonItems ?? []).filter((item) => item.currency === 'USD').map((item) => [item.category, item.amountMinor]));
    expect(items.size).toBeGreaterThan(0);
    for (const line of comparison.current.categories) expect(line.itemsMinor, line.category).toBe(items.get(line.category) ?? 0);
    expectWindow(comparison.current, 'enriched');
    expectChange(comparison, 'enriched');
    // Each itemized line is the list's split rows, and a split charge's parts add up to the charge.
    const itemized = comparison.current.categories.flatMap((line) => line.merchants.filter((merchant) => merchant.itemized).map((merchant) => ({ line, merchant })));
    expect(itemized.length).toBeGreaterThan(0);
    for (const { line, merchant } of itemized) {
      const list = (await get(app, `/card-transactions?status=posted&limit=200&from=${current.from}&to=${current.to}`
        + `&category=${encodeURIComponent(line.category)}&merchant=${encodeURIComponent(merchant.key)}`)).body as {
        transactions: Array<{ status: string; role: string; merchantKey: string; currency: string; amountMinor: number; categoryPortionMinor?: number;
          split?: Array<{ amountMinor: number }> }>;
      };
      const split = cardSpendingLineRows(list.transactions, merchant, 'USD');
      expect(split.sumMinor, `${line.category}: items line`).toBe(merchant.amountMinor);
      for (const row of split.rows) expect(sumOf(row.split!.map((part) => part.amountMinor))).toBe(row.amountMinor);
    }
  });

  it('marks each window\'s card coverage: declared dates count, rows alone do not', async () => {
    const app = buildApp();
    const { accounts } = await seedLedger(app, 7);
    const current = monthBounds('2026-09');
    const baseline = monthBounds('2026-08');
    const only = (await get(app, `/spending/compare?from=${current.from}&to=${current.to}&baselineFrom=${baseline.from}&baselineTo=${baseline.to}&today=${TODAY}&cardAccountId=${accounts[0].id}`))
      .body.comparison as Comparison;
    expect(only.current.coverage).toEqual({
      from: current.from, to: current.to, complete: true, inProgress: false, cardsWithData: 1, cardsExpected: 1, cardsCovered: 1, cardsStartingLater: 0, uncoveredCardIds: [],
    });
    const everyone = (await get(app, `/spending/compare?from=${current.from}&to=${current.to}&baselineFrom=${baseline.from}&baselineTo=${baseline.to}&today=${TODAY}`))
      .body.comparison as Comparison;
    expect(everyone.current.coverage.complete).toBe(false);
    expect(everyone.current.coverage.cardsCovered).toBe(1);
    expect(everyone.current.coverage.uncoveredCardIds).not.toContain(accounts[0].id);
    // The period so far is in progress.
    const sofar = (await get(app, `/spending/compare?from=2026-10-01&to=${TODAY}&baselineFrom=2026-09-01&baselineTo=2026-09-22&today=${TODAY}`)).body.comparison as Comparison;
    expect(sofar.current.coverage.inProgress).toBe(true);
    expect(sofar.baseline.coverage.inProgress).toBe(false);
  });

  it('refuses incomplete or inconsistent periods without echoing them', async () => {
    const app = buildApp();
    await seedLedger(app, 3);
    for (const [query, status] of [
      ['to=2026-09-30&baselineFrom=2026-08-01&baselineTo=2026-08-31', 400],
      ['from=2026-09-01&to=2026-09-30', 400],
      ['from=2026-09-01&to=2026-09-30&baselineFrom=2026-08-01&baselineTo=2026-09-01', 400],
      ['from=2026-09-30&to=2026-09-01&baselineFrom=2026-08-01&baselineTo=2026-08-31', 400],
      ['from=2026-09-01&to=2026-09-30&baselineFrom=2022-08-01&baselineTo=2022-08-31', 400],
      ['from=2026-09-01&to=2026-09-31&baselineFrom=2026-08-01&baselineTo=2026-08-31', 400],
      ['from=2026-09-01&to=2026-09-30&baselineFrom=2026-08-01&baselineTo=2026-08-31&currency=usd', 400],
      ['from=2026-09-01&to=2026-09-30&baselineFrom=2026-08-01&baselineTo=2026-08-31&categoryBasis=amazon-ish', 400],
      ['from=2026-09-01&to=2026-09-30&baselineFrom=2026-08-01&baselineTo=2026-08-31&cardAccountId=missing', 404],
      ['from=2026-09-01&to=2026-09-30&baselineFrom=2026-08-01&baselineTo=2026-08-31&period=month', 400],
    ] as const) {
      const res = await get(app, `/spending/compare?${query}`);
      expect(res.status, query).toBe(status);
      expect(JSON.stringify(res.body)).not.toMatch(/2026-09-3|amazon-ish|missing/);
    }
    const card = await get(app, '/spending/compare?from=2026-09-01&to=2026-09-30&baselineFrom=2026-08-01&baselineTo=2026-08-31&q=4111111111111111');
    expect(card.status).toBe(422);
    expect(JSON.stringify(card.body)).not.toContain('4111');
  });
});

describe('GET /spending/trend', () => {
  it('is the summary\'s months, each split into recurring, one-offs and everyday spending, with its coverage', async () => {
    const app = buildApp();
    const { accounts } = await seedLedger(app, 5);
    for (const filter of ['', `&cardAccountId=${accounts[0].id}`, '&categoryBasis=original', '&q=SAMPLE']) {
      const res = await get(app, `/spending/trend?toMonth=2026-09&today=${TODAY}${filter}`);
      expect(res.status).toBe(200);
      const body = res.body as { currency: string; thresholdMinor: number; months: Array<{ month: string; spendingMinor: number; recurringMinor: number;
        oneOffMinor: number; everydayMinor: number; count: number; coverage: { complete: boolean } }> };
      expect(body.months.map((item) => item.month)).toEqual(Array.from({ length: 12 }, (_, index) => addMonths('2025-10', index)));
      const summary = (await get(app, `/spending/summary?from=2025-10-01&to=2026-09-30${filter}`)).body as Summary;
      for (const item of body.months) {
        const month = summary.byMonth.find((entry) => entry.currency === 'USD' && entry.month === item.month);
        expect([item.spendingMinor, item.count], `${filter} ${item.month}`).toEqual([month?.spendingMinor ?? 0, month?.count ?? 0]);
        expect(item.recurringMinor + item.oneOffMinor + item.everydayMinor).toBe(item.spendingMinor);
      }
      const coverage = (await get(app, `/spending/coverage/months?fromMonth=2025-10&toMonth=2026-09&today=${TODAY}${filter.startsWith('&card') ? filter : ''}`)).body
        .months as Array<{ month: string; complete: boolean }>;
      expect(body.months.map((item) => [item.month, item.coverage.complete]), filter)
        .toEqual(coverage.map((item) => [item.month, item.complete]));
    }
    // The one-off threshold is the comparison's for a period ending the same day.
    const trend = (await get(app, `/spending/trend?toMonth=2026-09&today=${TODAY}`)).body as { thresholdMinor: number };
    const compare = (await get(app, `/spending/compare?from=2026-09-01&to=2026-09-30&baselineFrom=2026-08-01&baselineTo=2026-08-31&today=${TODAY}`)).body.comparison as Comparison;
    expect(trend.thresholdMinor).toBe(compare.thresholdMinor);
  });

  it('refuses bad month bounds', async () => {
    const app = buildApp();
    for (const query of ['toMonth=2026-13', 'fromMonth=2026-10&toMonth=2026-09', 'fromMonth=2023-01&toMonth=2026-09', 'from=2026-01-01']) {
      expect((await get(app, `/spending/trend?${query}`)).status, query).toBe(400);
    }
  });

  it('says what keeps its months from counting: the open cards behind and the cards first seen later, by id and date only', async () => {
    const app = buildApp();
    const imp = (id: string, rows: CardImportRow[], coverage: { start: string; end: string } | null) =>
      repo.importCardTransactions({ cardAccountId: id, source: 'test-file', parserVersion: 'test@1', rows, coverage });
    const current = repo.createCardAccount({ issuer: 'citi', owner: 'alex', last4: '0011', currency: 'USD', nickname: 'Sample Current' });
    const stale = repo.createCardAccount({ issuer: 'amex', owner: 'alex', last4: '0012', currency: 'USD', nickname: 'Sample Stale' });
    const synced = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '0013', currency: 'USD', nickname: 'Sample Synced' });
    const closed = repo.createCardAccount({ issuer: 'samplebank', owner: 'casey', last4: '0014', currency: 'USD', nickname: 'Sample Closed' });
    imp(current.id, [row({ transactionDate: '2026-06-03' }), row({ transactionDate: '2026-09-14' })], { start: '2026-06-01', end: '2026-10-20' });
    imp(stale.id, [row({ transactionDate: '2026-06-09' })], { start: '2026-06-01', end: '2026-07-31' });
    // Only rows, no statement: nothing recorded, and first seen in August.
    imp(synced.id, [row({ transactionDate: '2026-08-21' }), row({ transactionDate: '2026-09-02' })], null);
    imp(closed.id, [row({ transactionDate: '2026-06-12' })], { start: '2026-06-01', end: '2026-06-30' });
    repo.updateCardAccount(closed.id, { status: 'closed' });
    type Trend = {
      months: Array<{ month: string; coverage: { complete: boolean; cardsStartingLater: number; uncoveredCardIds: string[] } }>;
      gaps: { lastCompletableMonth: string | null; behind: Array<{ cardAccountId: string; coveredThrough: string | null }>;
        startingLater: Array<{ cardAccountId: string; firstKnown: string }> };
    };
    const res = await get(app, '/spending/trend?fromMonth=2026-06&toMonth=2026-10&today=2026-10-22');
    expect(res.status).toBe(200);
    const body = res.body as Trend;
    expect(body.gaps).toEqual({
      lastCompletableMonth: '2026-09',
      // The closed card is not expected after June, so it is not behind.
      behind: [{ cardAccountId: synced.id, coveredThrough: null }, { cardAccountId: stale.id, coveredThrough: '2026-07-31' }],
      startingLater: [{ cardAccountId: synced.id, firstKnown: '2026-08-21' }],
    });
    // The months agree: the first counts the card that starts later, and September is not complete for the cards behind.
    expect(body.months[0].coverage.cardsStartingLater).toBe(body.gaps.startingLater.length);
    const september = body.months.find((item) => item.month === '2026-09')!;
    expect(september.coverage.complete).toBe(false);
    expect(september.coverage.uncoveredCardIds).toEqual(expect.arrayContaining([synced.id, stale.id]));
    // Ids and dates only: a card's name is the app's to show.
    expect(JSON.stringify(body.gaps)).not.toMatch(/Sample|citi|amex|chase|00\d\d/);
    // One card in view: only its own.
    const one = (await get(app, `/spending/trend?fromMonth=2026-06&toMonth=2026-10&today=2026-10-22&cardAccountId=${current.id}`)).body as Trend;
    expect(one.gaps).toEqual({ lastCompletableMonth: '2026-09', behind: [], startingLater: [] });
  });
});
