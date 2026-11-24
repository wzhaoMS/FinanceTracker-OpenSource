import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { exceptCardSpendingPaths, mountCardSpendingRoutes } from './cardSpending.js';
import { createCardTransactionsRouter, type CardCategorySource } from './cardTransactions.js';
import { CARD_CATEGORY_RULES_VERSION, CARD_TAX_CATEGORY, classifyCardKind } from '@finance-tracker/shared';
import { SqliteStateRepo, type CardImportRow } from '../services/sqliteStateRepo.js';
import { listenLoopback } from '../testing/loopback.js';

/**
 * Inferred categories in Spending's answers (cardCategoryInference.ts): an issuer-categorized card teaches merchant
 * history, a statement-file card without categories gets filled from it and from the reviewed rules, only under the
 * enriched basis. Synthetic merchants and endings only.
 */

const GROCERIES = 'Merchandise & Supplies-Groceries';
const TAXIS = 'Transportation-Taxis and Coach';
const FUEL = 'Transportation-Fuel';
const FEES = 'Fees & Adjustments-Fees & Adjustments';

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

function buildApp(routerOptions: Parameters<typeof createCardTransactionsRouter>[1] = {}): express.Express {
  const server = express();
  server.use(exceptCardSpendingPaths(express.json({ limit: '2mb' })));
  const log = (line: string) => logs.push(line);
  mountCardSpendingRoutes(server, { repo, requireAuth: testAuth, log, routers: [createCardTransactionsRouter(repo, { log, ...routerOptions })] });
  return server;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-category-inference-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db'), now: () => new Date('2026-10-16T12:00:00.000Z') });
  logs = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Nothing about rows, merchants or categories is ever logged.
  expect(logs).toEqual([]);
  repo.close();
  await rm(dir, { recursive: true, force: true });
});

function row(day: number, description: string, amountMinor: number, patch: Partial<CardImportRow> = {}): CardImportRow {
  const date = `2026-09-${String(day).padStart(2, '0')}`;
  return {
    transactionDate: date, postedDate: date, status: 'posted', amountMinor, currency: 'USD',
    kind: 'purchase', description, merchant: null, issuerCategory: null, ...patch,
  } as CardImportRow;
}

/** An issuer-categorized card (Alex's) and a statement-file card with no categories (Casey's). */
function seed() {
  const amex = repo.createCardAccount({ issuer: 'amex', owner: 'alex', nickname: 'Sample Gold', last4: '0001', currency: 'USD' });
  const chase = repo.createCardAccount({ issuer: 'chase', owner: 'casey', nickname: 'Sample Visa', last4: '0002', currency: 'USD' });
  const coverage = { start: '2026-09-01', end: '2026-09-30' };
  repo.importCardTransactions({
    cardAccountId: amex.id, source: 'test-sync', parserVersion: 'test@1', coverage, rows: [
      row(2, 'NORTHWIND GROCERY', 3000, { issuerCategory: GROCERIES }),
      row(9, 'NORTHWIND GROCERY', 3500, { issuerCategory: GROCERIES }),
      row(10, 'SAMPLE LIMO', 6000, { issuerCategory: TAXIS }),
      row(11, 'SAMPLE BOOKSHOP', 2500, { issuerCategory: 'Merchandise & Supplies-Book Stores' }),
    ],
  });
  repo.importCardTransactions({
    cardAccountId: chase.id, source: 'test-sync', parserVersion: 'test@1', coverage, rows: [
      row(12, 'NORTHWIND GROCERY #12 SEATTLE WA', 4200),
      row(13, 'SHELL OIL 123', 5000),
      row(14, 'SAMPLE PLUMBING', 12000),
      row(15, 'ANNUAL MEMBERSHIP FEE', 9500, { kind: 'fee' }),
      row(16, 'LYFT *RIDE SUN 4PM', 1800),
      row(17, 'PAYMENT THANK YOU', -30000, { kind: 'payment' }),
    ],
  });
  const all = repo.listCardTransactionsMatching({ statuses: ['pending', 'posted'] });
  const id = (description: string) => all.find((item) => item.description === description)!.id;
  return { amex, chase, id };
}

const get = async (app: express.Express, url: string) => request(await listenLoopback(app)).get(url).set('x-test-auth', 'ok');
const patch = async (app: express.Express, url: string, body: unknown) => request(await listenLoopback(app)).patch(url)
  .set('x-test-auth', 'ok').set('Content-Type', 'application/json').send(JSON.stringify(body));
const usd = (body: { byCategory: Array<{ category: string; currency: string; spendingMinor: number; count: number }> }) =>
  Object.fromEntries(body.byCategory.filter((item) => item.currency === 'USD').map((item) => [item.category, [item.spendingMinor, item.count]]));
const sources = (counts: Partial<Record<'user' | 'issuer' | 'amazon' | 'inferred' | 'uncategorized', number>>) =>
  ({ user: 0, issuer: 0, amazon: 0, inferred: 0, uncategorized: 0, ...counts });
/** The inferred rows by basis an enriched marker lists: both, always. */
const inferenceOf = (history: number, rule: number) =>
  ({ rules: CARD_CATEGORY_RULES_VERSION, rowsByBasis: [{ basis: 'merchant-history', count: history }, { basis: 'rule', count: rule }] });

describe('inferred categories in Spending', () => {
  it('fill rows with neither category from merchant history and the reviewed rules, moving only categories', async () => {
    seed();
    const app = buildApp();
    const enriched = (await get(app, '/spending/summary')).body;
    const original = (await get(app, '/spending/summary?categoryBasis=original')).body;
    expect(usd(enriched)).toEqual({
      [GROCERIES]: [3000 + 3500 + 4200, 3],
      [TAXIS]: [6000 + 1800, 2],
      'Merchandise & Supplies-Book Stores': [2500, 1],
      [FUEL]: [5000, 1],
      [FEES]: [9500, 1],
      Uncategorized: [12000, 1],
    });
    expect(usd(original)).toEqual({
      [GROCERIES]: [6500, 2], [TAXIS]: [6000, 1], 'Merchandise & Supplies-Book Stores': [2500, 1], Uncategorized: [32500, 5],
    });
    for (const field of ['totals', 'pending', 'byMonth', 'byMonthOwner', 'byMerchant', 'otherMerchants', 'byCard', 'byOwner', 'paymentsPossiblyPaidFrom']) {
      expect(enriched[field], field).toEqual(original[field]);
    }
    // A rule's category no stored row has yet can be picked, as a split part's can; the original answer is unchanged.
    expect(enriched.categories).toEqual([...original.categories, FEES, FUEL].sort());
    expect(enriched.categoryBasis).toEqual({
      requested: 'enriched', effective: 'enriched', availability: 'unavailable', version: 'none',
      splitRows: 0,
      // Every evidence class, at 0: the payment ledger's (#118) with the others.
      splitRowsByEvidence: [{ evidenceClass: 'payment-event', count: 0 }, { evidenceClass: 'unique-total-match', count: 0 },
        { evidenceClass: 'payment-ledger-complete', count: 0 }],
      keptWholeByUserCategory: 0, heldOrDeclined: [], invalid: [], policyAllocatedMinor: [], residualMinor: [],
      // The grocery charge from its merchant's history; the fuel, the card fee and the ride by rule, said apart.
      rowsBySource: sources({ issuer: 4, inferred: 4, uncategorized: 1 }), inference: inferenceOf(1, 3),
    });
    expect(original.categoryBasis).not.toHaveProperty('rowsBySource');
    expect(original.categoryBasis).not.toHaveProperty('inference');
  });

  it('lists each row with where its category comes from, and why when inferred; the original list is as before', async () => {
    const { id } = seed();
    const app = buildApp();
    const enriched = (await get(app, '/card-transactions?limit=50')).body;
    const original = (await get(app, '/card-transactions?limit=50&categoryBasis=original')).body;
    const byDescription = (body: { transactions: Array<Record<string, unknown>> }) =>
      Object.fromEntries(body.transactions.map((item) => [item.description, item]));
    const rows = byDescription(enriched);
    expect(rows['NORTHWIND GROCERY #12 SEATTLE WA']).toMatchObject({
      category: GROCERIES, categorySource: 'inferred',
      categoryInference: { category: GROCERIES, basis: 'merchant-history', observations: 2, agreeing: 2 },
    });
    expect(rows['SHELL OIL 123']).toMatchObject({ category: FUEL, categorySource: 'inferred', categoryInference: { basis: 'rule', rule: 'fuel-brand' } });
    expect(rows['ANNUAL MEMBERSHIP FEE']).toMatchObject({ category: FEES, categoryInference: { basis: 'rule', rule: 'card-fee' } });
    // A rule category spelled as the household's stored one.
    expect(rows['LYFT *RIDE SUN 4PM']).toMatchObject({ category: TAXIS, categoryInference: { basis: 'rule', rule: 'rideshare-or-taxi' } });
    expect(rows['SAMPLE PLUMBING']).toMatchObject({ category: 'Uncategorized', categorySource: 'uncategorized' });
    expect(rows['SAMPLE PLUMBING']).not.toHaveProperty('categoryInference');
    expect(rows['NORTHWIND GROCERY']).toMatchObject({ category: GROCERIES, categorySource: 'issuer' });
    expect(rows['PAYMENT THANK YOU']).toMatchObject({ category: 'Uncategorized', categorySource: 'uncategorized' });
    // The page's marker counts the rows it shows with a category: all but the payment.
    expect(enriched.categoryBasis.rowsBySource).toEqual(sources({ issuer: 4, inferred: 4, uncategorized: 1 }));
    for (const item of original.transactions) {
      expect(item).not.toHaveProperty('categorySource');
      expect(item).not.toHaveProperty('categoryInference');
    }
    expect(byDescription(original)['NORTHWIND GROCERY #12 SEATTLE WA'].category).toBe('Uncategorized');
    expect(enriched.transactions.map((item: { id: string }) => item.id)).toEqual(original.transactions.map((item: { id: string }) => item.id));

    // The detail says the same; the original detail is as before.
    const detail = (await get(app, `/card-transactions/${id('NORTHWIND GROCERY #12 SEATTLE WA')}`)).body.transaction;
    expect(detail).toMatchObject({ category: GROCERIES, categorySource: 'inferred', categoryInference: { basis: 'merchant-history', observations: 2 } });
    const plainDetail = (await get(app, `/card-transactions/${id('NORTHWIND GROCERY #12 SEATTLE WA')}?categoryBasis=original`)).body.transaction;
    expect(plainDetail.category).toBe('Uncategorized');
    expect(plainDetail).not.toHaveProperty('categorySource');
    expect((await get(app, `/card-transactions/${id('SAMPLE PLUMBING')}?categoryBasis=sometimes`)).status).toBe(400);
  });

  it('filters by the category an answer files a row under', async () => {
    const { id } = seed();
    const app = buildApp();
    const ids = async (url: string) => ((await get(app, url)).body.transactions as Array<{ id: string }>).map((item) => item.id);
    const groceries = `category=${encodeURIComponent(GROCERIES)}`;
    const everything = await ids('/card-transactions?sort=date-asc&limit=50');
    const inGroceries = everything.filter((rowId) =>
      rowId === id('NORTHWIND GROCERY #12 SEATTLE WA') || repo.getCardTransaction(rowId)?.issuerCategory === GROCERIES);
    expect(inGroceries).toHaveLength(3);
    expect(await ids(`/card-transactions?${groceries}&sort=date-asc`)).toEqual(inGroceries);
    expect(await ids(`/card-transactions?${groceries}&categoryBasis=original&sort=date-asc`))
      .not.toContain(id('NORTHWIND GROCERY #12 SEATTLE WA'));
    // Uncategorized now means nothing inferred either: the plumbing charge, and the payment, which has no category.
    expect((await ids('/card-transactions?category=Uncategorized')).sort()).toEqual([id('SAMPLE PLUMBING'), id('PAYMENT THANK YOU')].sort());
    expect(await ids('/card-transactions?category=Uncategorized&categoryBasis=original')).toHaveLength(6);
    expect((await get(app, '/spending/summary?category=Uncategorized')).body.totals).toEqual([
      expect.objectContaining({ currency: 'USD', spendingMinor: 12000, count: 1 }),
    ]);
    const fuel = (await get(app, `/spending/summary?category=${encodeURIComponent(FUEL)}`)).body;
    expect(fuel.totals).toEqual([expect.objectContaining({ currency: 'USD', spendingMinor: 5000, count: 1 })]);
    expect(fuel.categoryBasis.rowsBySource).toEqual(sources({ inferred: 1 }));
  });

  it('learns from the whole household, whatever the view shows', async () => {
    const { id } = seed();
    const app = buildApp();
    // Casey's view has no grocery history of its own: Alex's card's teaches it.
    const casey = (await get(app, '/card-transactions?owner=casey')).body.transactions as Array<Record<string, unknown>>;
    expect(casey.find((item) => item.id === id('NORTHWIND GROCERY #12 SEATTLE WA'))).toMatchObject({
      category: GROCERIES, categoryInference: { basis: 'merchant-history', observations: 2 },
    });
    expect(usd((await get(app, '/spending/summary?owner=casey')).body)[GROCERIES]).toEqual([4200, 1]);
  });

  it('puts the owner\'s own category first, and clearing it brings the inferred one back', async () => {
    const { id } = seed();
    const app = buildApp();
    const target = id('NORTHWIND GROCERY #12 SEATTLE WA');
    expect((await patch(app, `/card-transactions/${target}`, { userCategory: 'Snacks' })).status).toBe(200);
    const row = async () => ((await get(app, '/card-transactions?limit=50')).body.transactions as Array<Record<string, unknown>>)
      .find((item) => item.id === target);
    expect(await row()).toMatchObject({ category: 'Snacks', categorySource: 'user' });
    expect(await row()).not.toHaveProperty('categoryInference');
    expect((await get(app, '/spending/summary')).body.categoryBasis.rowsBySource).toEqual(sources({ user: 1, issuer: 4, inferred: 3, uncategorized: 1 }));
    expect((await patch(app, `/card-transactions/${target}`, { userCategory: null })).status).toBe(200);
    expect(await row()).toMatchObject({ category: GROCERIES, categorySource: 'inferred' });
  });

  it('files a tax paid by card under Taxes over its issuer\'s category, on the enriched basis only', async () => {
    seed();
    // Two issuers filed the household's tax payments, and a processor's fee for one and its refund, under categories of
    // their own; a statement file gave one no category at all. Synthetic categories, amounts and endings.
    const UTILITIES = 'Business Services-Utilities';
    const MISCELLANEOUS = 'Other-Miscellaneous';
    const FEE = 'SAMPLE PROCESSOR*TAX PAYMENT CONVENIENCE FEE';
    const coverage = { start: '2026-09-01', end: '2026-09-30' };
    // Each row kinded by the import classifier, as a converter stores it.
    const kinded = (day: number, description: string, amountMinor: number, patch: Partial<CardImportRow> = {}) =>
      row(day, description, amountMinor, { ...patch, kind: classifyCardKind({ amountMinor, description, issuerCategory: patch.issuerCategory ?? null }) });
    const first = repo.createCardAccount({ issuer: 'citi', owner: 'alex', nickname: 'Sample Rewards', last4: '0003', currency: 'USD' });
    const second = repo.createCardAccount({ issuer: 'citi', owner: 'casey', nickname: 'Sample Cash', last4: '0004', currency: 'USD' });
    repo.importCardTransactions({
      cardAccountId: first.id, source: 'test-sync', parserVersion: 'test@1', coverage, rows: [
        kinded(20, 'US TREASURY TAX PAYMENT', 41_000, { issuerCategory: UTILITIES }),
        kinded(20, 'US TREASURY TAX PAYMENT', 27_500, { issuerCategory: UTILITIES }),
        kinded(20, FEE, 1_250, { issuerCategory: UTILITIES }),
        kinded(21, `${FEE} REFUND`, -1_250, { issuerCategory: UTILITIES }),
        kinded(22, 'SAMPLE WATER WORKS', 4_000, { issuerCategory: UTILITIES }),
      ],
    });
    repo.importCardTransactions({
      cardAccountId: second.id, source: 'test-sync', parserVersion: 'test@1', coverage, rows: [
        kinded(23, 'SAMPLE 0042', 52_000, { merchant: 'United States Treasury', issuerCategory: MISCELLANEOUS }),
        kinded(24, 'US TREASURY TAX PMT', 9_000),
      ],
    });
    const stored = (amountMinor: number) => repo.listCardTransactionsMatching({ statuses: ['posted'] }).find((item) => item.amountMinor === amountMinor)!;
    // The classifier makes the fee a purchase and its refund an adjustment ("FEE ... REFUND"): both are filed in Taxes.
    expect([stored(1_250).kind, stored(-1_250).kind]).toEqual(['purchase', 'adjustment']);
    const taxes = 41_000 + 27_500 + 1_250 - 1_250 + 52_000 + 9_000;
    const app = buildApp();
    const enriched = (await get(app, '/spending/summary')).body;
    const original = (await get(app, '/spending/summary?categoryBasis=original')).body;
    expect(usd(enriched)).toMatchObject({ [CARD_TAX_CATEGORY]: [taxes, 6], [UTILITIES]: [4_000, 1] });
    expect(usd(enriched)).not.toHaveProperty(MISCELLANEOUS);
    expect(usd(original)).toMatchObject({ [UTILITIES]: [41_000 + 27_500 + 1_250 - 1_250 + 4_000, 5], [MISCELLANEOUS]: [52_000, 1] });
    expect(usd(original)).not.toHaveProperty(CARD_TAX_CATEGORY);
    for (const field of ['totals', 'byMonth', 'byMerchant', 'byCard', 'byOwner']) expect(enriched[field], field).toEqual(original[field]);
    expect(enriched.categories).toContain(CARD_TAX_CATEGORY);
    expect(original.categories).not.toContain(CARD_TAX_CATEGORY);
    // Inferred by rule, whatever their issuers said: the seed's 4 issuer-categorized rows and the water works keep theirs.
    expect(enriched.categoryBasis.rowsBySource).toEqual(sources({ issuer: 5, inferred: 10, uncategorized: 1 }));
    expect(enriched.categoryBasis.inference).toEqual(inferenceOf(1, 9));

    // Each listed row says it, with its issuer's category kept; the original list is as before.
    const byAmount = (body: { transactions: Array<Record<string, unknown>> }) =>
      new Map(body.transactions.map((item) => [item.amountMinor as number, item]));
    const listed = byAmount((await get(app, '/card-transactions?limit=50')).body);
    const byRule = { category: CARD_TAX_CATEGORY, categorySource: 'inferred', categoryInference: { category: CARD_TAX_CATEGORY, basis: 'rule', rule: 'tax-payment' } };
    expect(listed.get(41_000)).toMatchObject({ issuerCategory: UTILITIES, ...byRule });
    expect(listed.get(1_250)).toMatchObject({ issuerCategory: UTILITIES, ...byRule });
    expect(listed.get(-1_250)).toMatchObject({ kind: 'adjustment', issuerCategory: UTILITIES, ...byRule });
    expect(listed.get(52_000)).toMatchObject({ issuerCategory: MISCELLANEOUS, ...byRule });
    expect(listed.get(9_000)).toMatchObject(byRule);
    expect(listed.get(4_000)).toMatchObject({ category: UTILITIES, categorySource: 'issuer' });
    expect(listed.get(4_000)).not.toHaveProperty('categoryInference');
    const plain = byAmount((await get(app, '/card-transactions?limit=50&categoryBasis=original')).body);
    expect(plain.get(41_000)).toMatchObject({ category: UTILITIES });
    expect(plain.get(41_000)).not.toHaveProperty('categorySource');
    expect(plain.get(-1_250)).toMatchObject({ category: UTILITIES });
    expect(plain.get(9_000)).toMatchObject({ category: 'Uncategorized' });

    // A category filter goes by the category each answer files a row under.
    const amounts = async (url: string) => ((await get(app, url)).body.transactions as Array<{ amountMinor: number }>)
      .map((item) => item.amountMinor).sort((a, b) => a - b);
    const utilities = `category=${encodeURIComponent(UTILITIES)}`;
    expect(await amounts(`/card-transactions?category=${CARD_TAX_CATEGORY}`)).toEqual([-1_250, 1_250, 9_000, 27_500, 41_000, 52_000]);
    expect(await amounts(`/card-transactions?${utilities}`)).toEqual([4_000]);
    expect(await amounts(`/card-transactions?${utilities}&categoryBasis=original`)).toEqual([-1_250, 1_250, 4_000, 27_500, 41_000]);
    expect(await amounts(`/card-transactions?category=${CARD_TAX_CATEGORY}&categoryBasis=original`)).toEqual([]);
    expect((await get(app, `/spending/summary?category=${CARD_TAX_CATEGORY}`)).body.totals).toEqual([
      expect.objectContaining({ currency: 'USD', spendingMinor: taxes, count: 6 }),
    ]);
    expect((await get(app, `/spending/summary?${utilities}`)).body.totals).toEqual([
      expect.objectContaining({ currency: 'USD', spendingMinor: 4_000, count: 1 }),
    ]);

    // The detail says the same; the original detail is as before.
    const taxId = stored(41_000).id;
    const detail = async (query = '') => (await get(app, `/card-transactions/${taxId}${query}`)).body.transaction;
    expect(await detail()).toMatchObject({ issuerCategory: UTILITIES, ...byRule });
    const plainDetail = await detail('?categoryBasis=original');
    expect(plainDetail.category).toBe(UTILITIES);
    expect(plainDetail).not.toHaveProperty('categorySource');

    // The owner's own category wins, the issuer's included, and clearing it files the payment under Taxes again.
    expect((await patch(app, `/card-transactions/${taxId}`, { userCategory: UTILITIES })).status).toBe(200);
    expect(await detail()).toMatchObject({ category: UTILITIES, categorySource: 'user' });
    expect(await detail()).not.toHaveProperty('categoryInference');
    expect(usd((await get(app, '/spending/summary')).body)[UTILITIES]).toEqual([41_000 + 4_000, 2]);
    expect((await patch(app, `/card-transactions/${taxId}`, { userCategory: null })).status).toBe(200);
    expect(await detail()).toMatchObject(byRule);

    // Filed by the owner under precious metals, it is an asset purchase: what it would count under as spending is the
    // category each basis files it under.
    expect((await patch(app, `/card-transactions/${taxId}`, { userCategory: 'Precious metals' })).status).toBe(200);
    const asset = async (query = '') => ((await get(app, `/spending/accounting${query}`)).body.assetPurchases as Array<Record<string, unknown>>)
      .find((item) => item.id === taxId);
    expect(await asset()).toMatchObject({ category: 'Precious metals', spendingCategory: CARD_TAX_CATEGORY });
    expect(await asset('?categoryBasis=original')).toMatchObject({ category: 'Precious metals', spendingCategory: UTILITIES });
  });

  it('reads inferred categories in the insights, and counts them', async () => {
    const { amex } = seed();
    // Category movers compare September with August: a purchase there gives them a baseline.
    repo.importCardTransactions({
      cardAccountId: amex.id, source: 'test-sync', parserVersion: 'test@1', coverage: { start: '2026-08-01', end: '2026-08-31' },
      rows: [{ ...row(20, 'SAMPLE BOOKSHOP', 2000, { issuerCategory: 'Merchandise & Supplies-Book Stores' }), transactionDate: '2026-08-20', postedDate: '2026-08-20' }],
    });
    const app = buildApp();
    const enriched = (await get(app, '/spending/insights?month=2026-09&today=2026-10-16')).body;
    expect(enriched.categoryBasis).toMatchObject({ requested: 'enriched', effective: 'enriched', inference: { rules: CARD_CATEGORY_RULES_VERSION } });
    const { rowsBySource, inference } = enriched.categoryBasis as { rowsBySource: { inferred: number }; inference: { rowsByBasis: Array<{ count: number }> } };
    expect(rowsBySource.inferred).toBeGreaterThan(0);
    expect(inference.rowsByBasis.reduce((sum, item) => sum + item.count, 0)).toBe(rowsBySource.inferred);
    const original = (await get(app, '/spending/insights?month=2026-09&today=2026-10-16&categoryBasis=original')).body;
    expect(original.categoryBasis).not.toHaveProperty('rowsBySource');
  });

  it('files a split row\'s residual under its inferred category when it has no issuer category', async () => {
    const { id } = seed();
    const target = id('NORTHWIND GROCERY #12 SEATTLE WA');
    const resolver: CardCategorySource = {
      snapshot: () => ({
        version: 'rev-1',
        resolve: (rows) => new Map(rows.filter((item) => item.id === target).map((item) => [item.id, {
          kind: 'split' as const, cardTransactionId: item.id, currency: 'USD', evidenceClass: 'payment-event' as const, contributions: [
            { amountMinor: 1200, category: 'Home', categorySource: 'item-override' as const, classification: 'source' as const, itemRef: 'item-1' },
            { amountMinor: 3000, category: null, categorySource: null, classification: 'residual' as const },
          ],
        }])),
        getCardDetail: (rowId) => ({
          version: 'rev-1', match: rowId === target ? 'linked' : 'none', coverage: { complete: false },
          ...(rowId === target ? { evidenceClass: 'payment-event' as const, items: [{ itemRef: 'item-1', title: 'Sample item', quantity: 1, asin: null }] } : {}),
        }),
      }),
    };
    const app = buildApp({ categoryResolver: resolver });
    const summary = (await get(app, '/spending/summary')).body;
    expect(usd(summary)).toMatchObject({ [GROCERIES]: [3000 + 3500 + 3000, 3], Home: [1200, 1] });
    // The split row counts as Amazon's, not as inferred, though its residual is filed under an inferred category.
    expect(summary.categoryBasis.rowsBySource).toEqual(sources({ issuer: 4, amazon: 1, inferred: 3, uncategorized: 1 }));
    expect(summary.categoryBasis.inference).toEqual(inferenceOf(0, 3));
    const listed = ((await get(app, '/card-transactions?limit=50')).body.transactions as Array<Record<string, unknown>>)
      .find((item) => item.id === target);
    expect(listed).toMatchObject({
      categorySource: 'amazon',
      split: [{ category: GROCERIES, amountMinor: 3000 }, { category: 'Home', amountMinor: 1200 }],
    });
    // The detail's Amazon object says how enriched reports file the row, whatever the basis asked: its residual under
    // the inferred category. Only the enriched detail adds the row's own category fields.
    const residual = { category: GROCERIES, amountMinor: 3000, categorySource: 'original-effective', classification: 'residual' };
    const enrichedDetail = (await get(app, `/card-transactions/${target}`)).body;
    expect(enrichedDetail.amazon).toMatchObject({ match: 'linked', aggregate: 'split', parts: expect.arrayContaining([residual]) });
    expect(enrichedDetail.transaction).toMatchObject({
      category: GROCERIES, categorySource: 'amazon', categoryInference: { basis: 'merchant-history', observations: 2 },
    });
    expect(enrichedDetail.transaction).not.toHaveProperty('split');
    const originalDetail = (await get(app, `/card-transactions/${target}?categoryBasis=original`)).body;
    expect(originalDetail.amazon).toEqual(enrichedDetail.amazon);
    expect(originalDetail.transaction.category).toBe('Uncategorized');
    expect(originalDetail.transaction).not.toHaveProperty('categorySource');
    expect(originalDetail.transaction).not.toHaveProperty('categoryInference');
    // A row with an issuer category is never inferred, on either basis.
    const issuerDetail = (await get(app, `/card-transactions/${id('SAMPLE BOOKSHOP')}`)).body;
    expect(issuerDetail.transaction).toMatchObject({ categorySource: 'issuer' });
    expect(issuerDetail.amazon).toMatchObject({ match: 'none', aggregate: 'whole-row-not-linked' });
    // The original basis never asks the source and infers nothing.
    expect(usd((await get(app, '/spending/summary?categoryBasis=original')).body).Uncategorized).toEqual([32500, 5]);
  });
});
