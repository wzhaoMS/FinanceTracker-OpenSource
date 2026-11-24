import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { exceptCardSpendingPaths, mountCardSpendingRoutes } from './cardSpending.js';
import { createCardTransactionsRouter, type CardCategorySource, type CardCategorySourceDetail } from './cardTransactions.js';
import {
  CARD_CATEGORY_RULES_VERSION,
  amazonCardChargeKind,
  type CardCategoryContribution,
  type CardCategoryEvidenceClass,
  type CardCategoryResolution,
  type CardCategoryResolver,
} from '@finance-tracker/shared';
import { SqliteStateRepo, type CardImportRow } from '../services/sqliteStateRepo.js';
import { cardSyncActorRef } from '../services/cardSyncDigests.js';
import { listenLoopback } from '../testing/loopback.js';
import { createAmazonCategoryResolver } from '../services/amazon/resolver.js';
import { backedUpWrite, importAmazonCapture, recordBindingProposal, recordRootApproval } from '../services/amazon/importer.js';
import { proposeBindings, readCardInventory } from '../services/amazon/bindings.js';
import { rootApproval, syntheticCapture } from '../services/amazon/fixtures.testSupport.js';

// The Spending answers' category basis (the Amazon split contract, S1). Synthetic data only: fictional merchants,
// made-up amounts and last-4s. Without a resolver, every answer must be exactly what it was before the basis
// existed: `GOLDEN` holds those answers, recorded from the code before this change
// (HOLDR_WRITE_SPENDING_GOLDEN=1 writes it), with run-dependent ids and times relabelled.

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cardCategoryBasis.golden.json');
const WRITE_GOLDEN = process.env.HOLDR_WRITE_SPENDING_GOLDEN === '1';
const TODAY = '2026-10-16';
/** Split rows by evidence class, when there are none: both classes, at zero. */
const NO_SPLITS_BY_EVIDENCE = [{ evidenceClass: 'payment-event', count: 0 }, { evidenceClass: 'unique-total-match', count: 0 },
  { evidenceClass: 'payment-ledger-complete', count: 0 }];
const byEvidence = (paymentEvent: number, uniqueTotal: number) =>
  [{ evidenceClass: 'payment-event', count: paymentEvent }, { evidenceClass: 'unique-total-match', count: uniqueTotal },
    { evidenceClass: 'payment-ledger-complete', count: 0 }];
/** An enriched marker's inference: the rules' version, and the inferred rows by basis, both always listed. */
const inferenceOf = (history: number, rule: number) =>
  ({ rules: CARD_CATEGORY_RULES_VERSION, rowsByBasis: [{ basis: 'merchant-history', count: history }, { basis: 'rule', count: rule }] });

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
  mountCardSpendingRoutes(server, {
    repo, requireAuth: testAuth, log, routers: [createCardTransactionsRouter(repo, { log, ...routerOptions })],
  });
  return server;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-category-basis-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db'), now: () => new Date('2026-10-16T12:00:00.000Z') });
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

const monthly = (description: string, amountMinor: number, day: string, issuerCategory: string | null, months = ['06', '07', '08', '09', '10']) =>
  months.map((month) => row({ transactionDate: `2026-${month}-${day}`, amountMinor, description, issuerCategory }));

/** Three cards (two people and a joint euro card), June to October 2026, with every kind and status. */
function seed() {
  const amex = repo.createCardAccount({ issuer: 'amex', owner: 'alex', nickname: 'Gold', last4: '0003', currency: 'USD' });
  const chase = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '2002', currency: 'USD' });
  const euro = repo.createCardAccount({ issuer: 'samplebank', owner: 'joint', last4: '3003', currency: 'EUR' });
  const imp = (id: string, rows: CardImportRow[], coverage: { start: string; end: string }) =>
    repo.importCardTransactions({ cardAccountId: id, source: 'test-sync', parserVersion: 'test@1', rows, coverage });
  imp(amex.id, [
    ...monthly('SAMPLE STREAMING', 1599, '03', 'Entertainment'),
    row({ transactionDate: '2026-06-08', amountMinor: 8450, description: 'SAMPLE GROCER', issuerCategory: 'Groceries' }),
    row({ transactionDate: '2026-07-09', amountMinor: 6420, description: 'SAMPLE GROCER', issuerCategory: 'Groceries' }),
    row({ transactionDate: '2026-08-11', amountMinor: 7780, description: 'SAMPLE GROCER', issuerCategory: 'Groceries' }),
    row({ transactionDate: '2026-09-12', amountMinor: 9120, description: 'SAMPLE GROCER', issuerCategory: 'Groceries' }),
    row({ transactionDate: '2026-10-05', amountMinor: 5300, description: 'SAMPLE GROCER', issuerCategory: 'Groceries' }),
    row({ transactionDate: '2026-06-15', amountMinor: 4200, description: 'SAMPLE BISTRO', issuerCategory: 'Dining' }),
    row({ transactionDate: '2026-08-20', amountMinor: 3800, description: 'SAMPLE BISTRO', issuerCategory: 'Dining' }),
    row({ transactionDate: '2026-09-21', amountMinor: 12650, description: 'SAMPLE BISTRO', issuerCategory: 'Dining' }),
    row({ transactionDate: '2026-10-09', amountMinor: 2200, description: 'SAMPLE BISTRO', issuerCategory: 'Dining' }),
    row({ transactionDate: '2026-09-25', amountMinor: 189900, description: 'SAMPLE TV STORE', issuerCategory: 'Electronics' }),
    row({ transactionDate: '2026-10-04', amountMinor: -50000, kind: 'refund', description: 'SAMPLE TV STORE', issuerCategory: 'Electronics' }),
    row({ transactionDate: '2026-10-06', amountMinor: 2500, description: 'SAMPLE PARKING', issuerCategory: 'Travel' }),
    row({ transactionDate: '2026-10-07', amountMinor: 2500, description: 'SAMPLE PARKING', issuerCategory: 'Travel' }),
    row({ transactionDate: '2026-09-12', amountMinor: 24580, description: 'HOTEL SAMPLE LISBOA', issuerCategory: 'Travel', originalAmountMinor: 22000, originalCurrency: 'EUR' }),
    row({ transactionDate: '2026-09-12', amountMinor: 737, kind: 'fee', description: 'FOREIGN TRANSACTION FEE', issuerCategory: 'Fees' }),
    row({ transactionDate: '2026-09-30', amountMinor: -737, kind: 'adjustment', description: 'FEE REVERSAL', issuerCategory: 'Fees' }),
    row({ transactionDate: '2026-10-01', amountMinor: 1234, kind: 'interest', description: 'INTEREST CHARGE' }),
    row({ transactionDate: '2026-09-25', amountMinor: -150000, kind: 'payment', description: 'AUTOPAY PAYMENT THANK YOU' }),
    row({ transactionDate: '2026-08-15', amountMinor: 20000, kind: 'other', description: 'CASH ADVANCE' }),
    row({ transactionDate: '2026-09-20', amountMinor: -3000, kind: 'refund', description: 'SAMPLE OUTFITTERS RETURN', issuerCategory: 'Merchandise' }),
    row({ transactionDate: '2026-09-30', postedDate: '2026-10-02', amountMinor: 8000, description: 'SAMPLE OUTFITTERS', issuerCategory: 'Merchandise' }),
    row({ transactionDate: '2026-10-10', amountMinor: 30000, description: 'SAMPLE TAILOR', issuerCategory: 'Services' }),
    row({ transactionDate: '2026-10-15', amountMinor: 3100, status: 'pending', description: 'SAMPLE BISTRO', issuerCategory: 'Dining' }),
    row({ transactionDate: '2026-10-14', amountMinor: -2500, status: 'pending', kind: 'refund', description: 'SAMPLE OUTFITTERS RETURN', issuerCategory: 'Merchandise' }),
  ], { start: '2026-06-01', end: '2026-10-16' });
  imp(chase.id, [
    ...monthly('SAMPLE CAFE', 650, '02', 'Dining'),
    row({ transactionDate: '2026-08-14', amountMinor: 41200, description: 'CONTOSO AIRLINES', issuerCategory: 'Travel' }),
    row({ transactionDate: '2026-09-18', amountMinor: 15000, description: 'SAMPLE MART', issuerCategory: 'Merchandise' }),
    row({ transactionDate: '2026-10-11', amountMinor: 2400, description: 'SAMPLE BOOKS' }),
    row({ transactionDate: '2026-10-01', amountMinor: -40000, kind: 'payment', description: 'PAYMENT RECEIVED' }),
  ], { start: '2026-06-01', end: '2026-10-16' });
  imp(euro.id, [
    row({ transactionDate: '2026-09-05', amountMinor: 1240, currency: 'EUR', description: 'SAMPLE BOULANGERIE', issuerCategory: 'Dining' }),
    row({ transactionDate: '2026-10-03', amountMinor: 1800, currency: 'EUR', description: 'SAMPLE MUSEE', issuerCategory: 'Entertainment' }),
    row({ transactionDate: '2026-10-08', amountMinor: -500, currency: 'EUR', kind: 'refund', description: 'SAMPLE MUSEE', issuerCategory: 'Entertainment' }),
  ], { start: '2026-09-01', end: '2026-10-16' });
  const all = repo.listCardTransactionsMatching({ statuses: ['pending', 'posted', 'removed'] });
  const find = (description: string, transactionDate: string) => all.find((item) => item.description === description && item.transactionDate === transactionDate)!;
  const owner = { actorRef: cardSyncActorRef('test-owner') };
  repo.updateCardTransaction(find('SAMPLE MART', '2026-09-18').id, { userCategory: 'Household' }, owner);
  repo.updateCardTransaction(find('SAMPLE GROCER', '2026-07-09').id, { userCategory: 'Bulk groceries' }, owner);
  return { amex, chase, euro, find, all: repo.listCardTransactionsMatching({ statuses: ['pending', 'posted', 'removed'] }) };
}

/** Labels for everything a run makes up (ids and times), so answers compare across runs and builds. */
function labeller(seeded: ReturnType<typeof seed>) {
  const labels = new Map<string, string>();
  for (const account of [seeded.amex, seeded.chase, seeded.euro]) labels.set(account.id, `account:${account.issuer}-${account.last4}`);
  seeded.all.forEach((item, index) => labels.set(item.id, `transaction:${index}`));
  let batches = 0;
  for (const item of seeded.all) {
    if (item.importBatchId && !labels.has(item.importBatchId)) labels.set(item.importBatchId, `batch:${batches++}`);
  }
  const relabel = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (labels.has(value)) return labels.get(value);
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) return '<time>';
      return value;
    }
    if (Array.isArray(value)) return value.map(relabel);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, relabel((value as Record<string, unknown>)[key])]));
    }
    return value;
  };
  /** A request's URL with the ids it names relabelled: the key it is recorded under. */
  const relabelUrl = (url: string) => [...labels].reduce((text, [id, label]) => text.split(id).join(label), url);
  return { relabel, relabelUrl };
}

/** The request matrix: the summary, the list and the insights under every filter the Spending tab sends, and more. */
function requests(seeded: ReturnType<typeof seed>, merchantKey: string): string[] {
  const { amex, chase } = seeded;
  const month = (from: string, to: string) => `from=${from}&to=${to}`;
  const summary = [
    '',
    month('2026-09-01', '2026-09-30'),
    month('2026-10-01', '2026-10-31'),
    'owner=alex', 'owner=casey', 'owner=joint',
    `cardAccountId=${chase.id}`,
    'category=Merchandise', 'category=Uncategorized', 'category=Household', 'category=Bulk%20groceries', 'category=Electronics',
    `merchant=${encodeURIComponent(merchantKey)}`,
    'q=sample', 'q=126.50',
    `owner=alex&category=Dining&${month('2026-06-01', '2026-09-30')}`,
  ].map((query) => `/spending/summary${query ? `?${query}` : ''}`);
  const list = [
    '', 'status=pending', 'status=posted&limit=5&offset=5', 'status=pending,posted,removed&sort=amount-desc',
    'kind=refund,payment', 'sort=date-asc&limit=3', 'sort=amount-asc&owner=casey', 'category=Dining', 'category=Electronics&status=posted',
    `merchant=${encodeURIComponent(merchantKey)}`, 'q=tv', `cardAccountId=${amex.id}&limit=7&offset=14`,
  ].map((query) => `/card-transactions${query ? `?${query}` : ''}`);
  const insights = [
    `month=2026-10&today=${TODAY}`,
    `month=2026-09&today=${TODAY}`,
    `from=2026-07-19&to=2026-10-16&baselineFrom=2026-04-20&baselineTo=2026-07-18&today=${TODAY}`,
    `owner=casey&today=${TODAY}`,
    `currency=EUR&today=${TODAY}`,
    `cardAccountId=${amex.id}&month=2026-08&today=${TODAY}`,
  ].map((query) => `/spending/insights?${query}`);
  return [...summary, ...list, ...insights];
}

const get = async (app: express.Express, url: string) => request(await listenLoopback(app)).get(url).set('x-test-auth', 'ok');

/** A URL with one more query parameter. */
const withParam = (url: string, param: string) => `${url}${url.includes('?') ? '&' : '?'}${param}`;
/** The category a URL filters on, and the URL without it. */
function categoryOf(url: string): { category: string | null; without: string } {
  const [route, search = ''] = url.split('?');
  const params = new URLSearchParams(search);
  const category = params.get('category');
  params.delete('category');
  const rest = params.toString();
  return { category, without: rest ? `${route}?${rest}` : route };
}

type Amounts = { currency: string; spendingMinor: number; chargesMinor: number; creditsMinor: number; count?: number };
const SUMMARY_LEDGER = ['totals', 'pending', 'byMonth', 'byMonthOwner', 'byMerchant', 'otherMerchants', 'byCard', 'byOwner', 'paymentsPossiblyPaidFrom'];
const ROW_CATEGORY_FIELDS = ['category', 'categorySource', 'categoryInference', 'categoryPortionMinor'];
const withoutCategoryFields = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).filter(([key]) => !ROW_CATEGORY_FIELDS.includes(key)));

/** Σ byCategory is the totals, per currency and amount. */
function expectCategoriesAddUp(body: { totals: Amounts[]; byCategory: Amounts[] }, label: string) {
  for (const total of body.totals) {
    const categories = body.byCategory.filter((item) => item.currency === total.currency);
    for (const field of ['spendingMinor', 'chargesMinor', 'creditsMinor'] as const) {
      expect(categories.reduce((sum, item) => sum + item[field], 0), `${label} ${total.currency} ${field}`).toBe(total[field]);
    }
  }
}

describe('without a category resolver: original answers are the ones before category bases; enriched ones add inferred categories', () => {
  it('answers the request matrix: the original basis exactly as recorded, the default with the same ledger figures', async () => {
    const seeded = seed();
    // No row is an asset purchase, so every answer takes the fast path (cardSpendingFastPath.test.ts): the recorded
    // answers are the ones from before asset purchases, and so is every answer here.
    expect(repo.cardSpendingAssetsPossible()).toBe(false);
    const app = buildApp();
    const { relabel, relabelUrl } = labeller(seeded);
    const plain = await get(app, '/spending/summary?categoryBasis=original');
    const merchantKey = plain.body.byMerchant[0].merchantKey as string;
    const recorded: Record<string, unknown> = {};
    const urls = requests(seeded, merchantKey);
    const golden = WRITE_GOLDEN ? null : JSON.parse(await readFile(GOLDEN, 'utf8')) as Record<string, unknown>;
    const unsplitMarker = {
      splitRows: 0, splitRowsByEvidence: NO_SPLITS_BY_EVIDENCE, keptWholeByUserCategory: 0, heldOrDeclined: [], invalid: [],
      policyAllocatedMinor: [], residualMinor: [],
    };
    let inferredSeen = 0;
    for (const url of urls) {
      const key = relabelUrl(url);
      // The original basis: exactly the answers recorded before category bases, with only the marker added.
      const originalResponse = await get(app, withParam(url, 'categoryBasis=original'));
      expect(originalResponse.status, `${url} original`).toBe(200);
      const { categoryBasis: originalMarker, ...original } = originalResponse.body as Record<string, unknown>;
      if (WRITE_GOLDEN) {
        recorded[key] = relabel(original);
        continue;
      }
      expect(golden).toHaveProperty([key]);
      expect(originalMarker, `${url} original`).toEqual({
        requested: 'original', effective: 'original', availability: 'not-requested', version: 'original', ...unsplitMarker,
      });
      expect(relabel(original), `${url} original`).toEqual(golden![key]);

      // The default, enriched: inferred categories where a row has none, every ledger figure the original's.
      const enrichedResponse = await get(app, url);
      expect(enrichedResponse.status, url).toBe(200);
      const { categoryBasis: marker, ...enriched } = enrichedResponse.body as Record<string, any>;
      const bySource = marker.rowsBySource as Record<string, number>;
      expect(Object.keys(bySource).sort(), url).toEqual(['amazon', 'inferred', 'issuer', 'uncategorized', 'user']);
      expect(marker, url).toEqual({
        requested: 'enriched', effective: bySource.inferred > 0 ? 'enriched' : 'original', availability: 'unavailable', version: 'none',
        ...unsplitMarker, rowsBySource: { ...bySource, amazon: 0 },
        inference: { rules: CARD_CATEGORY_RULES_VERSION, rowsByBasis: [
          { basis: 'merchant-history', count: expect.any(Number) }, { basis: 'rule', count: expect.any(Number) },
        ] },
      });
      const byBasis = marker.inference.rowsByBasis as Array<{ basis: string; count: number }>;
      expect(byBasis.reduce((sum, item) => sum + item.count, 0), url).toBe(bySource.inferred);
      inferredSeen += bySource.inferred;
      const { category, without } = categoryOf(url);
      if (url.startsWith('/spending/summary')) {
        expectCategoriesAddUp(enriched as { totals: Amounts[]; byCategory: Amounts[] }, url);
        // The marker counts the rows the summary files under a category.
        expect(Object.values(bySource).reduce((sum, count) => sum + count, 0), url)
          .toBe((enriched.byCategory as Amounts[]).reduce((sum, item) => sum + (item.count ?? 0), 0));
        if (category === null) {
          for (const field of SUMMARY_LEDGER) expect(enriched[field], `${url} ${field}`).toEqual(original[field]);
        } else {
          // A category filter counts the posted spending rows the enriched list files under it.
          const listUrl = without.replace('/spending/summary', '/card-transactions');
          const listed = (await get(app, withParam(withParam(listUrl, 'status=posted'), 'limit=200'))).body.transactions as Array<Record<string, any>>;
          const inCategory = listed.filter((row) => row.role === 'spending' && row.category === category);
          expect((enriched.totals as Amounts[]).filter((item) => (item.count ?? 0) > 0)
            .map((item) => [item.currency, item.spendingMinor, item.count]).sort(), url).toEqual(
            [...new Set(inCategory.map((row) => row.currency as string))].sort().map((currency) => {
              const rows = inCategory.filter((row) => row.currency === currency);
              return [currency, rows.reduce((sum, row) => sum + (row.amountMinor as number), 0), rows.length];
            }),
          );
        }
      } else if (url.startsWith('/card-transactions')) {
        const rows = enriched.transactions as Array<Record<string, any>>;
        expect(Object.values(bySource).reduce((sum, count) => sum + count, 0), url).toBe(rows.filter((row) => row.role !== 'transfer').length);
        for (const row of rows) {
          expect(row.categorySource, url).toMatch(/^(user|issuer|inferred|uncategorized)$/);
          expect(row.categoryInference !== undefined, url).toBe(row.categorySource === 'inferred');
        }
        // The marker's inferred rows by basis are the page's, a rule's said apart from merchant history's.
        expect(byBasis.map(({ basis, count }) => [basis, count]), url).toEqual(['merchant-history', 'rule'].map((basis) =>
          [basis, rows.filter((row) => row.role !== 'transfer' && row.categoryInference?.basis === basis).length]));
        if (category === null) {
          const { transactions: originalRows, ...originalPage } = original as { transactions: Array<Record<string, unknown>> };
          const { transactions: _rows, ...page } = enriched;
          expect(page, url).toEqual(originalPage);
          expect(rows.map(withoutCategoryFields), url).toEqual(originalRows.map(withoutCategoryFields));
          rows.forEach((row, index) => {
            if (row.categorySource !== 'inferred') expect(row.category, url).toBe(originalRows[index].category);
          });
        } else {
          // A category filter lists, in the ledger's order, the rows the enriched list files under it.
          const params = new URLSearchParams(without.split('?')[1] ?? '');
          const offset = Number(params.get('offset') ?? 0);
          const limit = Number(params.get('limit') ?? 50);
          params.delete('offset');
          params.set('limit', '200');
          const everything = (await get(app, `/card-transactions?${params}`)).body.transactions as Array<Record<string, any>>;
          const inCategory = everything.filter((row) => row.category === category);
          expect([enriched.total, rows.map((row) => row.id)], url)
            .toEqual([inCategory.length, inCategory.slice(offset, offset + limit).map((row) => row.id)]);
        }
      } else {
        // Insights: only what reads categories may differ.
        const { movers, largePurchases, ...rest } = enriched;
        const { movers: originalMovers, largePurchases: originalLarge, ...originalRest } = original as Record<string, any>;
        expect(rest, url).toEqual(originalRest);
        const uncategorized = (large: { items: Array<Record<string, unknown>> } | null) =>
          large && { ...large, items: large.items.map(({ category: _category, ...item }) => item) };
        expect(uncategorized(largePurchases), url).toEqual(uncategorized(originalLarge));
        expect(Array.isArray(movers) && Array.isArray(originalMovers), url).toBe(true);
      }
    }
    if (WRITE_GOLDEN) await writeFile(GOLDEN, `${JSON.stringify(recorded, null, 1)}\n`, 'utf8');
    expect(Object.keys(golden ?? recorded)).toHaveLength(urls.length);
    // The seed's one row with neither category that a rule recognizes, its interest charge, is inferred somewhere.
    if (!WRITE_GOLDEN) expect(inferredSeen).toBeGreaterThan(0);
  });

  it('refuses an unknown basis without echoing it', async () => {
    seed();
    const app = buildApp();
    for (const route of ['/spending/summary', '/card-transactions', `/spending/insights?today=${TODAY}`]) {
      const response = await get(app, `${route}${route.includes('?') ? '&' : '?'}categoryBasis=amazon-ish`);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'categoryBasis must be enriched or original' });
    }
  });
});

describe('with a synthetic category resolver', () => {
  const mapped = (amountMinor: number, category: string, itemRef?: string): CardCategoryContribution =>
    ({ amountMinor, category, categorySource: 'reviewed-mapping', classification: 'source', ...(itemRef ? { itemRef } : {}) });
  const override = (amountMinor: number, category: string, itemRef?: string): CardCategoryContribution =>
    ({ amountMinor, category, categorySource: 'item-override', classification: 'source', ...(itemRef ? { itemRef } : {}) });
  const residual = (amountMinor: number): CardCategoryContribution =>
    ({ amountMinor, category: null, categorySource: null, classification: 'residual' });

  /** The source's answers for the seed: three good splits, a custom-category row, a hold, and three it gets wrong. */
  function sourceFor(seeded: ReturnType<typeof seed>) {
    const id = (description: string, date: string) => seeded.find(description, date).id;
    const split = (key: string, contributions: CardCategoryContribution[], evidenceClass: CardCategoryEvidenceClass = 'payment-event'):
      [string, CardCategoryResolution] => [key, { kind: 'split', cardTransactionId: key, currency: 'USD', evidenceClass, contributions }];
    const tv = id('SAMPLE TV STORE', '2026-09-25');
    const tvRefund = id('SAMPLE TV STORE', '2026-10-04');
    const tailor = id('SAMPLE TAILOR', '2026-10-10');
    const answers = new Map<string, CardCategoryResolution>([
      split(tv, [mapped(150000, 'Electronics', 'tv-1'), override(30000, 'Home', 'mount-1'),
        { ...mapped(5000, 'Electronics', 'tv-1'), classification: 'policy-allocated' }, residual(4900)]),
      split(tvRefund, [override(-30000, 'Home', 'mount-1'), residual(-20000)]),
      // Tied by its order's total alone: the lower evidence class.
      split(tailor, [override(20000, 'Hobbies', 'kit-1'), residual(10000)], 'unique-total-match'),
      // The owner's own category for this row wins.
      split(id('SAMPLE MART', '2026-09-18'), [override(15000, 'Garden')]),
      [id('SAMPLE BISTRO', '2026-09-21'), { kind: 'whole-row', cardTransactionId: id('SAMPLE BISTRO', '2026-09-21'), reason: 'mixed-tender-unproven' }],
      // Wrong: a pending row, parts that miss the amount, and a mapping that invents a name.
      split(id('SAMPLE BISTRO', '2026-10-15'), [mapped(3100, 'Dining')]),
      split(id('SAMPLE GROCER', '2026-09-12'), [mapped(9000, 'Groceries')]),
      split(id('SAMPLE OUTFITTERS', '2026-09-30'), [mapped(5000, 'Merchandise'), mapped(3000, 'Shoes')]),
    ]);
    const calls = { snapshots: 0, resolves: 0 };
    const resolver: CardCategoryResolver = {
      snapshot() {
        calls.snapshots += 1;
        const version = `rev-${calls.snapshots}`;
        return {
          version,
          resolve(rows) {
            calls.resolves += 1;
            const asked = new Set(rows.map((item) => item.id));
            // Answers what it was asked, plus one row it was not (the pending one).
            return new Map([...answers].filter(([key]) => asked.has(key) || key === id('SAMPLE BISTRO', '2026-10-15')));
          },
        };
      },
    };
    return { resolver, calls, tv, tvRefund, tailor };
  }

  const byCurrency = <T extends { currency: string }>(items: T[], currency: string) => items.filter((item) => item.currency === currency);

  it('keeps every ledger figure, moves only the categories, and they still add up', async () => {
    const seeded = seed();
    const { resolver } = sourceFor(seeded);
    const app = buildApp({ categoryResolver: resolver });
    const enriched = (await get(app, '/spending/summary')).body;
    const original = (await get(app, '/spending/summary?categoryBasis=original')).body;
    for (const field of ['totals', 'pending', 'byMonth', 'byMonthOwner', 'byMerchant', 'otherMerchants', 'byCard', 'byOwner', 'paymentsPossiblyPaidFrom']) {
      expect(enriched[field], field).toEqual(original[field]);
    }
    for (const total of enriched.totals as Array<{ currency: string; spendingMinor: number; chargesMinor: number; creditsMinor: number }>) {
      const categories = byCurrency(enriched.byCategory as Array<{ currency: string; spendingMinor: number; chargesMinor: number; creditsMinor: number }>, total.currency);
      for (const field of ['spendingMinor', 'chargesMinor', 'creditsMinor'] as const) {
        expect(categories.reduce((sum, item) => sum + item[field], 0), `${total.currency} ${field}`).toBe(total[field]);
      }
    }
    const usd = (category: string) => (enriched.byCategory as Array<{ category: string; currency: string }>)
      .find((item) => item.category === category && item.currency === 'USD');
    expect(usd('Electronics')).toMatchObject({ spendingMinor: 159900 - 20000, chargesMinor: 159900, creditsMinor: -20000, count: 2 });
    expect(usd('Home')).toMatchObject({ spendingMinor: 0, chargesMinor: 30000, creditsMinor: -30000, count: 2 });
    expect(usd('Hobbies')).toMatchObject({ spendingMinor: 20000, count: 1 });
    expect(usd('Services')).toMatchObject({ spendingMinor: 10000, count: 1 });
    // The owner's own category and the refused splits keep their rows whole.
    expect(usd('Household')).toMatchObject({ spendingMinor: 15000, count: 1 });
    expect(usd('Garden')).toBeUndefined();
    expect(usd('Shoes')).toBeUndefined();
    expect(enriched.categories).toEqual(expect.arrayContaining(['Hobbies', 'Home']));
    expect(original.categories).not.toContain('Hobbies');
    expect(enriched.categoryBasis).toEqual({
      requested: 'enriched', effective: 'enriched', availability: 'available', version: 'rev-1',
      splitRows: 3, splitRowsByEvidence: byEvidence(2, 1), keptWholeByUserCategory: 1,
      heldOrDeclined: [{ reason: 'mixed-tender-unproven', count: 1 }],
      invalid: [{ reason: 'not-eligible', count: 1 }, { reason: 'sum-mismatch', count: 1 }, { reason: 'unknown-mapped-category', count: 1 }],
      policyAllocatedMinor: [{ currency: 'USD', amountMinor: 5000 }],
      residualMinor: [{ currency: 'USD', amountMinor: 4900 - 20000 + 10000 }],
      // The 36 posted spending rows: three split, two with the owner's own category, the interest charge inferred by
      // its kind, the one book charge nothing recognizes, and the issuers' categories for the rest.
      rowsBySource: { user: 2, issuer: 29, amazon: 3, inferred: 1, uncategorized: 1 },
      inference: inferenceOf(0, 1),
    });
  });

  it('applies a category filter to the parts, in the summary and the list alike', async () => {
    const seeded = seed();
    const { resolver, tv, tvRefund, tailor } = sourceFor(seeded);
    const app = buildApp({ categoryResolver: resolver });
    const whole = (await get(app, '/spending/summary')).body.byCategory as Array<{ category: string; currency: string }>;
    for (const category of ['Electronics', 'Home', 'Services', 'Hobbies', 'Dining', 'Household', 'Groceries']) {
      const filtered = (await get(app, `/spending/summary?category=${encodeURIComponent(category)}`)).body;
      const part = whole.find((item) => item.category === category && item.currency === 'USD');
      const total = byCurrency(filtered.totals as Array<{ currency: string }>, 'USD')[0];
      expect(total, category).toMatchObject({
        spendingMinor: (part as { spendingMinor?: number } | undefined)?.spendingMinor ?? 0,
        count: (part as { count?: number } | undefined)?.count ?? 0,
      });
      expect(filtered.byCategory.filter((item: { currency: string }) => item.currency === 'USD').map((item: { category: string }) => item.category), category)
        .toEqual(part ? [category] : []);
    }
    const home = (await get(app, '/card-transactions?category=Home')).body;
    expect(home.total).toBe(2);
    expect(home.transactions.map((item: { id: string; categoryPortionMinor: number }) => [item.id, item.categoryPortionMinor]))
      .toEqual([[tvRefund, -30000], [tv, 30000]]);
    expect(home.transactions[1].split).toEqual([{ category: 'Electronics', amountMinor: 159900 }, { category: 'Home', amountMinor: 30000 }]);
    // A residual stays under the row's own category; a whole row comes by its own category, pending ones too.
    const services = (await get(app, '/card-transactions?category=Services')).body;
    expect(services.transactions.map((item: { id: string; categoryPortionMinor: number }) => [item.id, item.categoryPortionMinor])).toEqual([[tailor, 10000]]);
    const dining = (await get(app, '/card-transactions?category=Dining')).body;
    const plainDining = (await get(app, '/card-transactions?category=Dining&categoryBasis=original')).body;
    expect(dining.transactions.map((item: { id: string }) => item.id)).toEqual(plainDining.transactions.map((item: { id: string }) => item.id));
    expect(dining.total).toBe(plainDining.total);
    // Pages cut after filtering.
    const paged = (await get(app, '/card-transactions?category=Home&limit=1&offset=1')).body;
    expect([paged.total, paged.nextOffset, paged.transactions.map((item: { id: string }) => item.id)]).toEqual([2, null, [tv]]);
    // Without a category, rows, order and counts are the ledger's; split rows carry their split.
    const all = (await get(app, '/card-transactions?limit=200')).body;
    const plain = (await get(app, '/card-transactions?limit=200&categoryBasis=original')).body;
    expect(all.transactions.map((item: { id: string }) => item.id)).toEqual(plain.transactions.map((item: { id: string }) => item.id));
    expect(all.transactions.filter((item: { split?: unknown }) => item.split).map((item: { id: string }) => item.id).sort())
      .toEqual([tv, tvRefund, tailor].sort());
    expect(all.transactions.some((item: { categoryPortionMinor?: number }) => item.categoryPortionMinor !== undefined)).toBe(false);
  });

  it('never asks the source for the original basis, which equals the answer without one', async () => {
    const seeded = seed();
    const { resolver, calls } = sourceFor(seeded);
    const withSource = buildApp({ categoryResolver: resolver });
    const without = buildApp();
    for (const url of ['/spending/summary?categoryBasis=original', '/card-transactions?categoryBasis=original&category=Home',
      `/spending/insights?categoryBasis=original&month=2026-09&today=${TODAY}`]) {
      const { categoryBasis, ...body } = (await get(withSource, url)).body;
      const { categoryBasis: plainBasis, ...plainBody } = (await get(without, url)).body;
      expect(body, url).toEqual(plainBody);
      expect([categoryBasis.availability, plainBasis.availability], url).toEqual(['not-requested', 'not-requested']);
    }
    expect(calls).toEqual({ snapshots: 0, resolves: 0 });
  });

  it('reads one snapshot per request, for the insights\' period and baseline alike', async () => {
    const seeded = seed();
    const { resolver, calls, tv } = sourceFor(seeded);
    const app = buildApp({ categoryResolver: resolver });
    const enriched = (await get(app, `/spending/insights?month=2026-09&today=${TODAY}`)).body;
    expect(calls).toEqual({ snapshots: 1, resolves: 1 });
    // September against August: the TV is its one split row (its October refund and the tailor are in neither month).
    expect(enriched.categoryBasis).toEqual({
      requested: 'enriched', effective: 'enriched', availability: 'available', version: 'rev-1',
      splitRows: 1, splitRowsByEvidence: byEvidence(1, 0), keptWholeByUserCategory: 1,
      heldOrDeclined: [{ reason: 'mixed-tender-unproven', count: 1 }],
      invalid: [{ reason: 'not-in-scope', count: 1 }, { reason: 'sum-mismatch', count: 1 }, { reason: 'unknown-mapped-category', count: 1 }],
      policyAllocatedMinor: [{ currency: 'USD', amountMinor: 5000 }],
      residualMinor: [{ currency: 'USD', amountMinor: 4900 }],
      // The rows whose categories it read; the October interest charge is outside both months.
      rowsBySource: expect.objectContaining({ amazon: 1, inferred: 0 }),
      inference: inferenceOf(0, 0),
    });
    const original = (await get(app, `/spending/insights?month=2026-09&today=${TODAY}&categoryBasis=original`)).body;
    expect(calls).toEqual({ snapshots: 1, resolves: 1 });
    const item = enriched.largePurchases.items.find((entry: { id: string }) => entry.id === tv);
    // Its amount is net of its refund, as before; its split is the purchase row's own.
    expect(item).toMatchObject({ amountMinor: 189900 - 50000, refundedMinor: 50000, category: 'Electronics', split: [{ category: 'Electronics', amountMinor: 159900 }, { category: 'Home', amountMinor: 30000 }] });
    expect(original.largePurchases.items.find((entry: { id: string }) => entry.id === tv)).not.toHaveProperty('split');
    // Only the categories' findings may differ.
    const { movers, largePurchases, categoryBasis, ...rest } = enriched;
    const { movers: originalMovers, largePurchases: originalLarge, categoryBasis: originalBasis, ...originalRest } = original;
    expect(rest).toEqual(originalRest);
    expect({ ...largePurchases, items: largePurchases.items.map(({ category, split, ...entry }: Record<string, unknown>) => entry) })
      .toEqual({ ...originalLarge, items: originalLarge.items.map(({ category, ...entry }: Record<string, unknown>) => entry) });
    expect(Array.isArray(movers) && Array.isArray(originalMovers)).toBe(true);
    expect([categoryBasis.version, originalBasis.version]).toEqual(['rev-1', 'original']);
    // A second request reads a new snapshot.
    await get(app, '/spending/summary');
    expect(calls).toEqual({ snapshots: 2, resolves: 2 });
  });

  it('compares a category filter with the parts as the query compares it with the rows', async () => {
    const seeded = seed();
    const { resolver } = sourceFor(seeded);
    const app = buildApp({ categoryResolver: resolver });
    // Each request reads a snapshot of its own (this source numbers them): compared without its version.
    const unversioned = (body: { categoryBasis: Record<string, unknown> }) => ({ ...body, categoryBasis: { ...body.categoryBasis, version: 'rev' } });
    for (const route of ['/spending/summary', '/card-transactions']) {
      const canonical = await get(app, `${route}?category=Home`);
      expect(canonical.status).toBe(200);
      // Full-width letters, and a zero-width space: the query reads both as "Home".
      for (const spelling of ['%EF%BC%A8%EF%BD%8F%EF%BD%8D%EF%BD%85', 'Home%E2%80%8B']) {
        const response = await get(app, `${route}?category=${spelling}`);
        expect(response.status, `${route} ${spelling}`).toBe(200);
        expect(unversioned(response.body), `${route} ${spelling}`).toEqual(unversioned(canonical.body));
      }
      // A spelling the query refuses is refused alike on either basis.
      const refused = await get(app, `${route}?category=%E2%80%8B`);
      const plainRefused = await get(app, `${route}?category=%E2%80%8B&categoryBasis=original`);
      expect([refused.status, refused.body]).toEqual([plainRefused.status, plainRefused.body]);
      expect(refused.status).toBe(400);
    }
  });

  it('counts in each marker only what its own answer reports', async () => {
    const seeded = seed();
    const { resolver, tvRefund } = sourceFor(seeded);
    const app = buildApp({ categoryResolver: resolver });
    const marker = (patch: Record<string, unknown>) => ({
      requested: 'enriched', effective: 'enriched', availability: 'available', version: expect.any(String),
      splitRows: 0, splitRowsByEvidence: NO_SPLITS_BY_EVIDENCE,
      keptWholeByUserCategory: 0, heldOrDeclined: [], invalid: [], policyAllocatedMinor: [], residualMinor: [],
      inference: inferenceOf(0, 0), ...patch,
    });
    const sources = (counts: Partial<Record<'user' | 'issuer' | 'amazon' | 'inferred' | 'uncategorized', number>>) =>
      ({ user: 0, issuer: 0, amazon: 0, inferred: 0, uncategorized: 0, ...counts });
    // The euro card's insights read none of the dollar splits; the answer about a row never asked about is the request's.
    expect((await get(app, `/spending/insights?currency=EUR&today=${TODAY}`)).body.categoryBasis)
      .toEqual(marker({
        effective: 'original', invalid: [{ reason: 'not-in-scope', count: 1 }],
        rowsBySource: expect.objectContaining({ amazon: 0, inferred: 0, user: 0, uncategorized: 0 }),
      }));
    // Dining has no part of a split row: its whole rows, one held and one pending the source answered about anyway.
    expect((await get(app, '/spending/summary?category=Dining')).body.categoryBasis).toEqual(marker({
      effective: 'original', heldOrDeclined: [{ reason: 'mixed-tender-unproven', count: 1 }], invalid: [{ reason: 'not-eligible', count: 1 }],
      // Its posted rows: four bistro, five cafe and one boulangerie charges.
      rowsBySource: sources({ issuer: 10 }),
    }));
    // Home: the two parts in it, none of them allocated or a residual; Electronics: the TV's and its refund's parts there.
    expect((await get(app, '/spending/summary?category=Home')).body.categoryBasis)
      .toEqual(marker({ splitRows: 2, splitRowsByEvidence: byEvidence(2, 0), rowsBySource: sources({ amazon: 2 }) }));
    expect((await get(app, '/spending/summary?category=Electronics')).body.categoryBasis).toEqual(marker({
      splitRows: 2, splitRowsByEvidence: byEvidence(2, 0),
      policyAllocatedMinor: [{ currency: 'USD', amountMinor: 5000 }], residualMinor: [{ currency: 'USD', amountMinor: 4900 - 20000 }],
      rowsBySource: sources({ amazon: 2 }),
    }));
    // Hobbies: only the tailor, tied by its order's total.
    expect((await get(app, '/spending/summary?category=Hobbies')).body.categoryBasis)
      .toEqual(marker({ splitRows: 1, splitRowsByEvidence: byEvidence(0, 1), rowsBySource: sources({ amazon: 1 }) }));
    // A list's marker is its page's: Dining's first row is that pending one.
    const page = (await get(app, '/card-transactions?category=Home&limit=1')).body;
    expect(page.transactions.map((item: { id: string }) => item.id)).toEqual([tvRefund]);
    expect(page.categoryBasis).toEqual(marker({ splitRows: 1, splitRowsByEvidence: byEvidence(1, 0), rowsBySource: sources({ amazon: 1 }) }));
    expect((await get(app, '/card-transactions?category=Dining&limit=1')).body.categoryBasis)
      .toEqual(marker({ effective: 'original', invalid: [{ reason: 'not-eligible', count: 1 }], rowsBySource: sources({ issuer: 1 }) }));
    expect((await get(app, '/card-transactions?category=Dining&limit=1&offset=1')).body.categoryBasis)
      .toEqual(marker({ effective: 'original', rowsBySource: sources({ issuer: 1 }) }));
    // The interest charge no issuer categorized is filed under the rule's category, and counted as inferred.
    const fees = (await get(app, `/card-transactions?category=${encodeURIComponent('Fees & Adjustments-Fees & Adjustments')}`)).body;
    expect(fees.transactions.map((item: { description: string; categorySource: string }) => [item.description, item.categorySource]))
      .toEqual([['INTEREST CHARGE', 'inferred']]);
    expect(fees.categoryBasis).toEqual(marker({ rowsBySource: sources({ inferred: 1 }), inference: inferenceOf(0, 1) }));
  });

  it('reports an empty answer as available with nothing split, and the original ledger', async () => {
    seed();
    const empty: CardCategoryResolver = { snapshot: () => ({ version: 'rev-0', resolve: () => new Map() }) };
    const app = buildApp({ categoryResolver: empty });
    for (const url of ['/spending/summary', '/spending/summary?category=Home', '/card-transactions?category=Dining', `/spending/insights?month=2026-09&today=${TODAY}`]) {
      const { categoryBasis, ...body } = (await get(app, url)).body;
      const { categoryBasis: originalBasis, ...originalBody } = (await get(app, withParam(url, 'categoryBasis=original'))).body;
      // Nothing is split: a filtered list's rows each count whole; inferred categories are the only difference.
      const rows = (body.transactions ?? []) as Array<Record<string, any>>;
      for (const row of rows) expect([row.categoryPortionMinor, row.split], url).toEqual([row.amountMinor, undefined]);
      if (rows.length > 0) {
        expect({ ...body, transactions: rows.map(withoutCategoryFields) }, url)
          .toEqual({ ...originalBody, transactions: (originalBody.transactions as Array<Record<string, unknown>>).map(withoutCategoryFields) });
      } else if (url.startsWith('/spending/summary')) {
        for (const field of SUMMARY_LEDGER) expect(body[field], `${url} ${field}`).toEqual(originalBody[field]);
        expectCategoriesAddUp(body as { totals: Amounts[]; byCategory: Amounts[] }, url);
      } else {
        const { movers: _movers, largePurchases, ...rest } = body;
        const { movers: _originalMovers, largePurchases: originalLarge, ...originalRest } = originalBody;
        expect(rest, url).toEqual(originalRest);
        const uncategorized = (large: { items: Array<Record<string, unknown>> } | null) =>
          large && { ...large, items: large.items.map(({ category: _category, ...item }) => item) };
        expect(uncategorized(largePurchases), url).toEqual(uncategorized(originalLarge));
      }
      expect(categoryBasis, url).toEqual({
        requested: 'enriched', effective: categoryBasis.rowsBySource.inferred > 0 ? 'enriched' : 'original', availability: 'available', version: 'rev-0',
        splitRows: 0, splitRowsByEvidence: NO_SPLITS_BY_EVIDENCE,
        keptWholeByUserCategory: 0, heldOrDeclined: [], invalid: [], policyAllocatedMinor: [], residualMinor: [],
        rowsBySource: expect.objectContaining({ amazon: 0 }),
        inference: inferenceOf(categoryBasis.inference.rowsByBasis[0].count, categoryBasis.rowsBySource.inferred - categoryBasis.inference.rowsByBasis[0].count),
      });
      expect(originalBasis.availability, url).toBe('not-requested');
    }
  });

  it('answers a failing source with the standard error, never with an empty split', async () => {
    seed();
    const failing: CardCategoryResolver = { snapshot: () => ({ version: 'rev-9', resolve() { throw new Error('source unavailable'); } }) };
    const app = buildApp({ categoryResolver: failing });
    for (const url of ['/spending/summary', '/card-transactions?category=Home', `/spending/insights?today=${TODAY}`]) {
      const response = await get(app, url);
      expect(response.status, url).toBe(500);
      expect(response.body, url).not.toHaveProperty('categoryBasis');
      expect(JSON.stringify(response.body), url).not.toContain('source unavailable');
    }
    // The original basis never asks it.
    expect((await get(app, '/spending/summary?categoryBasis=original')).status).toBe(200);
  });
});

describe('a row\'s Amazon detail', () => {
  const mapped = (amountMinor: number, category: string, itemRef?: string): CardCategoryContribution =>
    ({ amountMinor, category, categorySource: 'reviewed-mapping', classification: 'source', ...(itemRef ? { itemRef } : {}) });
  const override = (amountMinor: number, category: string, itemRef?: string): CardCategoryContribution =>
    ({ amountMinor, category, categorySource: 'item-override', classification: 'source', ...(itemRef ? { itemRef } : {}) });
  const residual = (amountMinor: number): CardCategoryContribution =>
    ({ amountMinor, category: null, categorySource: null, classification: 'residual' });

  /** A source whose detail facts agree with its splits: linked by each evidence class, held, declined, refused, none. */
  function detailSource(seeded: ReturnType<typeof seed>) {
    const id = (description: string, date: string) => seeded.find(description, date).id;
    const ids = {
      tv: id('SAMPLE TV STORE', '2026-09-25'),
      tailor: id('SAMPLE TAILOR', '2026-10-10'),
      mart: id('SAMPLE MART', '2026-09-18'),
      held: id('SAMPLE BISTRO', '2026-09-21'),
      declined: id('SAMPLE BISTRO', '2026-08-20'),
      refused: id('SAMPLE GROCER', '2026-09-12'),
      plain: id('SAMPLE CAFE', '2026-10-02'),
      // Splits the source's own detail contradicts: a held row and an unmatched one.
      heldSplit: id('SAMPLE PARKING', '2026-10-06'),
      noneSplit: id('SAMPLE PARKING', '2026-10-07'),
    };
    const split = (key: string, contributions: CardCategoryContribution[], evidenceClass: CardCategoryEvidenceClass = 'payment-event'):
      CardCategoryResolution => ({ kind: 'split', cardTransactionId: key, currency: 'USD', evidenceClass, contributions });
    const answers = new Map<string, CardCategoryResolution>([
      [ids.tv, split(ids.tv, [mapped(150000, 'Electronics', 'tv-1'), override(30000, 'Home', 'mount-1'),
        { ...mapped(5000, 'Electronics', 'tv-1'), classification: 'policy-allocated' }, residual(4900)])],
      [ids.tailor, split(ids.tailor, [override(20000, 'Hobbies', 'kit-1'), residual(10000)], 'unique-total-match')],
      [ids.mart, split(ids.mart, [override(15000, 'Garden', 'planter-1')])],
      [ids.held, { kind: 'whole-row', cardTransactionId: ids.held, reason: 'match-held' }],
      [ids.declined, { kind: 'whole-row', cardTransactionId: ids.declined, reason: 'item-identity-unproven' }],
      [ids.refused, split(ids.refused, [mapped(9000, 'Groceries')])],
      [ids.heldSplit, split(ids.heldSplit, [mapped(2500, 'Electronics', 'x-2')])],
      [ids.noneSplit, split(ids.noneSplit, [mapped(2500, 'Electronics', 'x-3')])],
    ]);
    const linked = (evidenceClass: CardCategoryEvidenceClass, items: unknown[], orderRefs: string[] = ['order-a1']) =>
      ({ match: 'linked', evidenceClass, items, orderRefs, coverage: { complete: false } });
    const facts = new Map<string, unknown>([
      [ids.tv, linked('payment-event', [
        // Only a strict `true` says a thumbnail is cached; anything else says nothing.
        { itemRef: 'tv-1', title: 'Sample 65-inch television, model SX-6500', quantity: 1, asin: 'B0SAMPLE01', image: true },
        { itemRef: 'mount-1', title: '  Sample   wall mount ', quantity: 2, asin: null, image: 'yes' },
      ])],
      [ids.tailor, linked('unique-total-match', [{ itemRef: 'kit-1', title: 'Sample sewing kit', quantity: 1, asin: 'B0SAMPLE02' }])],
      [ids.mart, linked('payment-event', [{ itemRef: 'planter-1', title: 'Sample planter', quantity: 1, asin: null }])],
      // Held: only its reason and how many candidates, whatever else the source says.
      [ids.held, {
        match: 'held', hold: { reason: 'match-held', candidateCount: 3 }, evidenceClass: 'payment-event', orderRefs: ['order-x'],
        items: [{ itemRef: 'x-1', title: 'Sample candidate item', quantity: 1, asin: 'B0SAMPLE03', image: true }], coverage: { complete: false },
      }],
      [ids.declined, linked('unique-total-match', [
        // A thirteen-digit run in a title, a bidirectional override, a title longer than the domain keeps, the domain's
        // own redaction: hidden; a bad reference: dropped.
        { itemRef: 'book-1', title: 'Sample book 9780000000002', quantity: 1, asin: '0000000002' },
        { itemRef: 'bad ref', title: 'Sample item with a malformed reference', quantity: 1, asin: null },
        { itemRef: 'cable-1', title: 'Sample cable \u202Ereversed', quantity: 0, asin: 'b0lowercase' },
        { itemRef: 'long-1', title: 'L'.repeat(2049), quantity: 1.5, asin: 'B0SAMPLE04' },
        { itemRef: 'redacted-1', title: '[redacted]', quantity: 2, asin: null },
        { itemRef: 'full-1', title: `Sample full product name ${'with many words '.repeat(100)}end`, quantity: 1, asin: 'B0SAMPLE05' },
        // Characters that render as nothing (a grapheme joiner, a variation selector, fillers): hidden; an accent: kept.
        { itemRef: 'cgj-1', title: 'Sample\u034F blue widget', quantity: 1, asin: null },
        { itemRef: 'vs-1', title: 'Sample star \u2B50\uFE0F', quantity: 1, asin: null },
        { itemRef: 'filler-1', title: 'Sample\u3164filler', quantity: 1, asin: null },
        { itemRef: 'halfwidth-1', title: 'Sample\uFFA0filler', quantity: 1, asin: null },
        { itemRef: 'accent-1', title: 'Sample cafe\u0301 au lait mug', quantity: 1, asin: null },
      ], ['order-b2', 'bad ref'])],
      [ids.refused, linked('payment-event', [{ itemRef: 'food-1', title: 'Sample groceries', quantity: 3, asin: null }])],
      [ids.plain, { match: 'none', coverage: { complete: true, provenFrom: '2026-08-21', provenTo: 'not a date' } }],
      [ids.heldSplit, { match: 'held', hold: { reason: 'match-held', candidateCount: 2 }, coverage: { complete: false } }],
      [ids.noneSplit, { match: 'none', coverage: { complete: false } }],
    ]);
    const resolver: CardCategorySource = {
      snapshot: () => ({
        version: 'rev-detail',
        resolve: (rows) => new Map([...answers].filter(([key]) => rows.some((row) => row.id === key))),
        getCardDetail: (rowId) => ({ version: 'rev-detail', ...(facts.get(rowId) as object ?? { match: 'none' }) }) as CardCategorySourceDetail,
      }),
    };
    return { resolver, ids };
  }

  it('says how the row was tied and how reports file it, with its order\'s items, and nothing of a held match\'s candidates', async () => {
    const seeded = seed();
    const { resolver, ids } = detailSource(seeded);
    const app = buildApp({ categoryResolver: resolver });
    const detail = async (rowId: string) => {
      const response = await get(app, `/card-transactions/${rowId}`);
      expect(response.status).toBe(200);
      return response.body.amazon;
    };
    const part = (category: string, amountMinor: number, categorySource: string, classification: string, itemRef?: string) =>
      ({ category, amountMinor, categorySource, classification, ...(itemRef ? { itemRef } : {}) });
    expect(await detail(ids.tv)).toEqual({
      version: 'rev-detail', match: 'linked', evidenceClass: 'payment-event', aggregate: 'split',
      parts: [
        part('Electronics', 150000, 'reviewed-mapping', 'source', 'tv-1'), part('Home', 30000, 'item-override', 'source', 'mount-1'),
        part('Electronics', 5000, 'reviewed-mapping', 'policy-allocated', 'tv-1'), part('Electronics', 4900, 'original-effective', 'residual'),
      ],
      items: [
        { itemRef: 'tv-1', title: 'Sample 65-inch television, model SX-6500', quantity: 1, asin: 'B0SAMPLE01', image: true },
        { itemRef: 'mount-1', title: 'Sample wall mount', quantity: 2, asin: null },
      ],
      orderRefs: ['order-a1'], coverage: { complete: false },
    });
    expect(await detail(ids.tailor)).toMatchObject({
      match: 'linked', evidenceClass: 'unique-total-match', aggregate: 'split',
      parts: [part('Hobbies', 20000, 'item-override', 'source', 'kit-1'), part('Services', 10000, 'original-effective', 'residual')],
    });
    // The owner's own category keeps the row whole; the source's valid parts are still listed.
    expect(await detail(ids.mart)).toMatchObject({
      match: 'linked', aggregate: 'whole-row-user-category', parts: [part('Garden', 15000, 'item-override', 'source', 'planter-1')],
      items: [{ itemRef: 'planter-1', title: 'Sample planter', quantity: 1, asin: null }],
    });
    expect(await detail(ids.held)).toEqual({
      version: 'rev-detail', match: 'held', aggregate: 'whole-row-declined', wholeRowReason: 'match-held',
      hold: { reason: 'match-held', candidateCount: 3 }, coverage: { complete: false },
    });
    expect(await detail(ids.declined)).toEqual({
      version: 'rev-detail', match: 'linked', evidenceClass: 'unique-total-match', aggregate: 'whole-row-declined',
      wholeRowReason: 'item-identity-unproven',
      items: [
        { itemRef: 'book-1', title: null, quantity: 1, asin: '0000000002' },
        { itemRef: 'cable-1', title: null, quantity: null, asin: null },
        { itemRef: 'long-1', title: null, quantity: null, asin: 'B0SAMPLE04' },
        { itemRef: 'redacted-1', title: null, quantity: 2, asin: null },
        // A full product name of 1,600 characters is shown whole.
        { itemRef: 'full-1', title: `Sample full product name ${'with many words '.repeat(100).trim()} end`, quantity: 1, asin: 'B0SAMPLE05' },
        { itemRef: 'cgj-1', title: null, quantity: 1, asin: null },
        { itemRef: 'vs-1', title: null, quantity: 1, asin: null },
        { itemRef: 'filler-1', title: null, quantity: 1, asin: null },
        { itemRef: 'halfwidth-1', title: null, quantity: 1, asin: null },
        { itemRef: 'accent-1', title: 'Sample cafe\u0301 au lait mug', quantity: 1, asin: null },
      ],
      orderRefs: ['order-b2'], coverage: { complete: false },
    });
    expect(await detail(ids.refused)).toMatchObject({
      match: 'linked', aggregate: 'whole-row-invalid', wholeRowReason: 'sum-mismatch',
      items: [{ itemRef: 'food-1', title: 'Sample groceries', quantity: 3, asin: null }],
    });
    expect(await detail(ids.plain)).toEqual({
      version: 'rev-detail', match: 'none', aggregate: 'whole-row-not-linked', coverage: { complete: true, provenFrom: '2026-08-21' },
    });
    // A split for a row the source holds or does not link is refused, in reports and detail alike, and lists nothing.
    expect(await detail(ids.heldSplit)).toEqual({
      version: 'rev-detail', match: 'held', aggregate: 'whole-row-invalid', wholeRowReason: 'not-linked',
      hold: { reason: 'match-held', candidateCount: 2 }, coverage: { complete: false },
    });
    expect(await detail(ids.noneSplit)).toEqual({
      version: 'rev-detail', match: 'none', aggregate: 'whole-row-invalid', wholeRowReason: 'not-linked', coverage: { complete: false },
    });
    const summary = (await get(app, '/spending/summary')).body;
    expect(summary.categoryBasis.invalid).toContainEqual({ reason: 'not-linked', count: 2 });
    expect(summary.categoryBasis.splitRows).toBe(2);
    const travel = (body: { byCategory: Array<{ category: string; currency: string; spendingMinor: number }> }) =>
      body.byCategory.find((item) => item.category === 'Travel' && item.currency === 'USD')?.spendingMinor;
    expect(travel(summary)).toBe(travel((await get(app, '/spending/summary?categoryBasis=original')).body));
  });

  it('has no Amazon detail without a source, and answers a failing one with the standard error', async () => {
    const seeded = seed();
    const tv = seeded.find('SAMPLE TV STORE', '2026-09-25').id;
    expect((await get(buildApp(), `/card-transactions/${tv}`)).body).not.toHaveProperty('amazon');
    const failing: CardCategorySource = {
      snapshot: () => ({ version: 'rev-9', resolve: () => new Map(), getCardDetail: () => { throw new Error('detail unavailable'); } }),
    };
    const response = await get(buildApp({ categoryResolver: failing }), `/card-transactions/${tv}`);
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('detail unavailable');
  });

  it('lists each linked row with its Amazon order, the same checked object as its detail, and no other row', async () => {
    const seeded = seed();
    const { resolver, ids } = detailSource(seeded);
    const app = buildApp({ categoryResolver: resolver });
    type Listed = { id: string; amazon?: unknown; categoryPortionMinor?: number };
    const list = async (query: string) => {
      const response = await get(app, `/card-transactions?limit=200&${query}`);
      expect(response.status).toBe(200);
      return new Map((response.body.transactions as Listed[]).map((item) => [item.id, item]));
    };
    const detail = async (rowId: string) => (await get(app, `/card-transactions/${rowId}`)).body.amazon;
    const posted = await list('status=posted');
    // Linked: split by each evidence class, kept whole by the owner's category, declined by the source, refused.
    for (const key of ['tv', 'tailor', 'mart', 'declined', 'refused'] as const) {
      expect(posted.get(ids[key])?.amazon, key).toEqual(await detail(ids[key]));
      expect(posted.get(ids[key])?.amazon, key).toMatchObject({ match: 'linked' });
    }
    // Held, unmatched, and a split the source's own detail contradicts: nothing, whatever the source says of them.
    for (const key of ['held', 'plain', 'heldSplit', 'noneSplit'] as const) {
      expect(posted.has(ids[key]), key).toBe(true);
      expect(posted.get(ids[key]), key).not.toHaveProperty('amazon');
    }
    // Under a category filter, the split row is listed for its part there, its order with it.
    const electronics = await list('category=Electronics');
    expect(electronics.get(ids.tv)).toMatchObject({ categoryPortionMinor: 159900, amazon: await detail(ids.tv) });
    expect([...electronics.values()].filter((item) => 'amazon' in item).map((item) => item.id)).toEqual([ids.tv]);
    // The original basis lists no order and asks the source nothing: it is the answer without a source.
    for (const query of ['categoryBasis=original&status=posted', 'categoryBasis=original&category=Electronics']) {
      const { categoryBasis: _withSource, ...body } = (await get(app, `/card-transactions?limit=200&${query}`)).body;
      const { categoryBasis: _plain, ...plainBody } = (await get(buildApp(), `/card-transactions?limit=200&${query}`)).body;
      expect(body, query).toEqual(plainBody);
      expect(JSON.stringify(body), query).not.toContain('"amazon"');
    }
  });

  it('says what Amazon items put in each category: a part of each category\'s amount, the categories still adding up', async () => {
    const seeded = seed();
    const { resolver } = detailSource(seeded);
    const app = buildApp({ categoryResolver: resolver });
    type Item = { currency: string; category: string; amountMinor: number; rows: number };
    const summary = (await get(app, '/spending/summary')).body as { totals: Amounts[]; byCategory: Array<Amounts & { category: string }>; fromAmazonItems: Item[] };
    // The TV's item and its share of tax and shipping (not the rest of its charge), its mount, the tailor's kit; the
    // planter's row counts whole under the owner's own category.
    expect(summary.fromAmazonItems).toEqual([
      { currency: 'USD', category: 'Electronics', amountMinor: 155000, rows: 1 },
      { currency: 'USD', category: 'Home', amountMinor: 30000, rows: 1 },
      { currency: 'USD', category: 'Hobbies', amountMinor: 20000, rows: 1 },
    ]);
    expectCategoriesAddUp(summary, 'enriched');
    for (const item of summary.fromAmazonItems) {
      const category = summary.byCategory.find((entry) => entry.currency === item.currency && entry.category === item.category);
      expect(category?.chargesMinor, item.category).toBeGreaterThanOrEqual(item.amountMinor);
    }
    // The items' parts and every other amount make each category, and the period's spending, exactly.
    const original = (await get(app, '/spending/summary?categoryBasis=original')).body as { totals: Amounts[] };
    expect(summary.totals).toEqual(original.totals);
    // A category filter keeps that category's item parts only.
    const electronics = (await get(app, '/spending/summary?category=Electronics')).body;
    expect(electronics.fromAmazonItems).toEqual([{ currency: 'USD', category: 'Electronics', amountMinor: 155000, rows: 1 }]);
    expectCategoriesAddUp(electronics, 'Electronics');
    // Neither the original basis nor an answer without a source says anything of Amazon items.
    expect((await get(app, '/spending/summary?categoryBasis=original')).body).not.toHaveProperty('fromAmazonItems');
    expect((await get(buildApp(), '/spending/summary')).body).not.toHaveProperty('fromAmazonItems');
  });
});

describe('Amazon coverage: the domain\'s Amazon card charges in view, and how many are itemized', () => {
  const override = (amountMinor: number, category: string, itemRef: string): CardCategoryContribution =>
    ({ amountMinor, category, categorySource: 'item-override', classification: 'source', itemRef });

  /** Amazon rows of every kind, and a source whose rule for an Amazon card charge is the domain's. */
  function coverageSource() {
    const amex = repo.createCardAccount({ issuer: 'amex', owner: 'alex', last4: '0003', currency: 'USD' });
    const euro = repo.createCardAccount({ issuer: 'samplebank', owner: 'joint', last4: '3003', currency: 'EUR' });
    repo.importCardTransactions({ cardAccountId: amex.id, source: 'test-sync', parserVersion: 'test@1', coverage: { start: '2026-09-01', end: '2026-09-30' }, rows: [
      row({ transactionDate: '2026-09-02', amountMinor: 9000, description: 'AMAZON MKTPL*SAMPLE1', issuerCategory: 'Shopping' }),
      row({ transactionDate: '2026-09-03', amountMinor: 4500, description: 'AMAZON.COM*SAMPLE2', issuerCategory: 'Shopping' }),
      row({ transactionDate: '2026-09-04', amountMinor: 2500, description: 'AMAZON MKTPL*SAMPLE3', issuerCategory: 'Shopping' }),
      row({ transactionDate: '2026-09-05', amountMinor: 1499, description: 'AMAZON PRIME MEMBERSHIP', issuerCategory: 'Shopping' }),
      row({ transactionDate: '2026-09-06', amountMinor: 3000, status: 'pending', description: 'AMAZON MKTPL*SAMPLE4', issuerCategory: 'Shopping' }),
      row({ transactionDate: '2026-09-07', amountMinor: -1500, kind: 'refund', description: 'AMAZON.COM*SAMPLE5 RETURN', issuerCategory: 'Shopping' }),
      row({ transactionDate: '2026-09-08', amountMinor: 700, description: 'AWS EMEA SAMPLE', issuerCategory: 'Business' }),
      row({ transactionDate: '2026-09-09', amountMinor: 1200, description: 'SAMPLE GROCER', issuerCategory: 'Groceries' }),
    ] });
    repo.importCardTransactions({ cardAccountId: euro.id, source: 'test-sync', parserVersion: 'test@1', coverage: { start: '2026-09-01', end: '2026-09-30' }, rows: [
      row({ transactionDate: '2026-09-10', amountMinor: 2000, currency: 'EUR', description: 'AMAZON.DE*SAMPLE6', issuerCategory: 'Shopping' }),
    ] });
    const all = repo.listCardTransactionsMatching({ statuses: ['pending', 'posted'] });
    const id = (description: string) => all.find((item) => item.description === description)!.id;
    const ids = { split: id('AMAZON MKTPL*SAMPLE1'), unlinked: id('AMAZON.COM*SAMPLE2'), gift: id('AMAZON MKTPL*SAMPLE3'), euro: id('AMAZON.DE*SAMPLE6') };
    // The owner's own category keeps this one whole: a charge with an order, but not itemized.
    repo.updateCardTransaction(ids.gift, { userCategory: 'Gifts' }, { actorRef: cardSyncActorRef('test-owner') });
    const answers = new Map<string, CardCategoryResolution>([
      [ids.split, { kind: 'split', cardTransactionId: ids.split, currency: 'USD', evidenceClass: 'payment-event',
        contributions: [override(6000, 'Electronics', 'item-a'), { amountMinor: 3000, category: null, categorySource: null, classification: 'residual' }] }],
      [ids.gift, { kind: 'split', cardTransactionId: ids.gift, currency: 'USD', evidenceClass: 'payment-event', contributions: [override(2500, 'Books', 'item-b')] }],
    ]);
    const live = () => repo.listCardTransactionsMatching({ statuses: ['pending', 'posted'] });
    const resolver: CardCategorySource = {
      snapshot: () => ({
        version: 'rev-coverage',
        resolve: (rows) => new Map([...answers].filter(([key]) => rows.some((item) => item.id === key))),
        getCardDetail: (rowId) => ({ version: 'rev-coverage', ...(answers.has(rowId)
          ? { match: 'linked', evidenceClass: 'payment-event', items: [], orderRefs: [], coverage: { complete: false } }
          : { match: 'none', coverage: { complete: false } }) }) as CardCategorySourceDetail,
        // As the domain's snapshot rules: a live, posted, positive purchase with an itemizable Amazon descriptor.
        isAmazonCharge: (rowId) => {
          const item = live().find((entry) => entry.id === rowId);
          return item !== undefined && item.status === 'posted' && item.kind === 'purchase' && item.amountMinor > 0
            && amazonCardChargeKind({ description: item.description }) === 'itemizable';
        },
      }),
    };
    return { resolver, ids, amex };
  }

  it('counts the charges and every other Amazon row apart, per currency, whatever the category filter', async () => {
    const { resolver } = coverageSource();
    const app = buildApp({ categoryResolver: resolver });
    const coverage = [
      { currency: 'EUR', charges: 1, itemized: 0, notItemizable: 0, pending: 0, refunds: 0, other: 0 },
      // Three charges, one itemized (the owner's own category keeps another whole); Prime, the pending one and the
      // refund apart; AWS is not Amazon retail at all.
      { currency: 'USD', charges: 3, itemized: 1, notItemizable: 1, pending: 1, refunds: 1, other: 0 },
    ];
    expect((await get(app, '/spending/summary')).body.amazonCoverage).toEqual(coverage);
    expect((await get(app, '/spending/summary?category=Groceries')).body.amazonCoverage).toEqual(coverage);
    // Neither the original basis, nor no source, nor a source without the domain's rule says anything of it.
    expect((await get(app, '/spending/summary?categoryBasis=original')).body).not.toHaveProperty('amazonCoverage');
    expect((await get(buildApp(), '/spending/summary')).body).not.toHaveProperty('amazonCoverage');
    const { resolver: detailOnly } = detailSourceWithoutRule(resolver);
    expect((await get(buildApp({ categoryResolver: detailOnly }), '/spending/summary')).body).not.toHaveProperty('amazonCoverage');
  });

  it('lists the charges not itemized, and refuses the filter where nothing could say', async () => {
    const { resolver, ids, amex } = coverageSource();
    const app = buildApp({ categoryResolver: resolver });
    const listed = async (query: string) => {
      const response = await get(app, `/card-transactions?limit=200&${query}`);
      expect(response.status, query).toBe(200);
      return (response.body.transactions as Array<{ id: string }>).map((item) => item.id).sort();
    };
    expect(await listed('amazon=unitemized')).toEqual([ids.unlinked, ids.gift, ids.euro].sort());
    expect(await listed(`amazon=unitemized&cardAccountId=${amex.id}`)).toEqual([ids.unlinked, ids.gift].sort());
    expect(await listed('amazon=unitemized&status=pending')).toEqual([]);
    expect(await listed('amazon=unitemized&category=Shopping')).toEqual([ids.unlinked, ids.euro].sort());
    // The line counts one currency (USD: 3 charges, 1 itemized), and its list holds exactly that currency's 2.
    const coverage = (await get(app, '/spending/summary')).body.amazonCoverage as Array<{ currency: string; charges: number; itemized: number }>;
    for (const entry of coverage) {
      expect((await listed(`amazon=unitemized&currency=${entry.currency}`)).length, entry.currency).toBe(entry.charges - entry.itemized);
    }
    expect(await listed('amazon=unitemized&currency=USD')).toEqual([ids.unlinked, ids.gift].sort());
    expect(await listed('amazon=unitemized&currency=EUR')).toEqual([ids.euro]);
    const refused = async (app2: express.Express, query: string) => (await get(app2, `/card-transactions?${query}`));
    expect((await refused(app, 'amazon=all')).body).toEqual({ error: 'amazon must be unitemized' });
    expect((await refused(app, 'amazon=unitemized&currency=usd')).body).toEqual({ error: 'currency must be a three-letter uppercase code' });
    // Never taken and then ignored: a currency goes with the Amazon filter only.
    expect((await refused(app, 'currency=USD')).body).toEqual({ error: 'currency goes with amazon=unitemized' });
    expect((await refused(app, 'amazon=unitemized&categoryBasis=original')).status).toBe(400);
    expect((await refused(buildApp(), 'amazon=unitemized')).body).toEqual({ error: 'amazon=unitemized needs the enriched basis and Amazon orders' });
  });

  /** The same source, without the domain's rule for an Amazon card charge. */
  function detailSourceWithoutRule(source: CardCategorySource): { resolver: CardCategorySource } {
    return { resolver: { snapshot: () => { const { isAmazonCharge: _rule, ...rest } = source.snapshot(); return rest; } } };
  }
});

describe('with the Amazon domain\'s own resolver', () => {
  it('counts tips, Prime fees and Amazon Pay apart from the charges, each still whole under its own category', async () => {
    // Synthetic descriptors, references and merchant only.
    const card = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9001', currency: 'USD' });
    repo.importCardTransactions({ cardAccountId: card.id, source: 'synthetic', parserVersion: 'synthetic@1', rows: [
      row({ transactionDate: '2026-09-03', amountMinor: 4200, description: 'AMAZON GROCE*SYNTH01', issuerCategory: 'Groceries' }),
      row({ transactionDate: '2026-09-04', amountMinor: 500, description: 'AMAZON TIPS*SYNTH02', issuerCategory: 'Shopping' }),
      row({ transactionDate: '2026-09-05', amountMinor: 1499, description: 'AMAZON PRIME*SYNTH03', issuerCategory: 'Shopping' }),
      row({ transactionDate: '2026-09-06', amountMinor: 2500, description: 'AMZ*SYNTH04 FABRIKAM SAMPLE AMZN.COM/BILL WA', issuerCategory: 'Dining' }),
    ] });
    const app = buildApp({ categoryResolver: createAmazonCategoryResolver(repo.internalGetDb()) });
    const enriched = (await get(app, '/spending/summary')).body;
    // One Amazon card charge to itemize, the grocery order; the tip, the Prime fee and the Amazon Pay payment apart.
    expect(enriched.amazonCoverage).toEqual([{ currency: 'USD', charges: 1, itemized: 0, notItemizable: 3, pending: 0, refunds: 0, other: 0 }]);
    expect(((await get(app, '/card-transactions?amazon=unitemized')).body.transactions as Array<{ description: string }>)
      .map((item) => item.description)).toEqual(['AMAZON GROCE*SYNTH01']);
    // Only the counts change: every row is listed whole under its own category, filed as the original answer files it.
    expect(enriched.byCategory).toEqual((await get(app, '/spending/summary?categoryBasis=original')).body.byCategory);
    const listed = (await get(app, '/card-transactions')).body.transactions as
      Array<{ description: string; category: string; categorySource: string; split?: unknown }>;
    expect(listed.map((item) => [item.description, item.category, item.categorySource, item.split ?? null])).toEqual([
      ['AMZ*SYNTH04 FABRIKAM SAMPLE AMZN.COM/BILL WA', 'Dining', 'issuer', null],
      ['AMAZON PRIME*SYNTH03', 'Shopping', 'issuer', null],
      ['AMAZON TIPS*SYNTH02', 'Shopping', 'issuer', null],
      ['AMAZON GROCE*SYNTH01', 'Groceries', 'issuer', null],
    ]);
  });
  it('uses ledger price-share parts consistently in real summary, list and detail without altering original spending', async () => {
    const prime = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9001', currency: 'USD' });
    repo.importCardTransactions({ cardAccountId: prime.id, source: 'synthetic', parserVersion: 'synthetic@1',
      rows: [600, 500].map(amountMinor => ({ transactionDate: '2026-09-03', status: 'posted' as const, kind: 'purchase' as const,
        amountMinor, currency: 'USD', description: 'AMAZON SYNTHETIC RETAIL', issuerCategory: 'Shopping' })) });
    const db = repo.internalGetDb(), capture = syntheticCapture(), o = capture.staging.orders[0];
    o.itemProof = { complete: true, unknownLine: false, conflict: false };
    capture.staging.payments = [600, 500].map((amountMinor, ordinal) => ({
      date: '2026-09-03', money: { currency: 'USD', amountMinor }, kind: 'charge', status: 'completed',
      method: { kind: 'card', network: 'visa', last4: '9001' }, orderIds: [o.orderId], identity: 'native-row',
      provenance: { source: 'ledger', status: 'Charged', page: 0, ordinal },
    }));
    capture.staging.coverage.payments = { status: 'partial', reason: 'budget', pages: 1, records: 2, rejected: 0 };
    await importAmazonCapture(db, capture, path.join(dir, 'ledger-backup-1.db'));
    const cards = readCardInventory(db);
    const proposal = proposeBindings([{ network: 'visa', last4: '9001', cardAccountId: prime.id }], cards);
    await recordBindingProposal(db, proposal, path.join(dir, 'ledger-backup-2.db'));
    await recordRootApproval(db, proposal, rootApproval(proposal), path.join(dir, 'ledger-backup-3.db'));
    await backedUpWrite(db, path.join(dir, 'ledger-backup-4.db'), () => {
      const item = db.prepare('SELECT ref FROM amazon_items').pluck().get();
      db.prepare('INSERT INTO amazon_item_overrides VALUES(?,?)').run(item, 'Synthetic Household');
    });
    const app = buildApp({ categoryResolver: createAmazonCategoryResolver(db) });
    const enriched = (await get(app, '/spending/summary')).body;
    const original = (await get(app, '/spending/summary?categoryBasis=original')).body;
    expect(enriched.categoryBasis).toMatchObject({ splitRows: 2,
      splitRowsByEvidence: [{ evidenceClass: 'payment-event', count: 0 }, { evidenceClass: 'unique-total-match', count: 0 },
        { evidenceClass: 'payment-ledger-complete', count: 2 }] });
    const withoutCategories = (body: Record<string, unknown>) => {
      const { byCategory: _categories, categories: _names, categoryBasis: _basis, fromAmazonItems: _items, amazonCoverage: _coverage, ...totals } = body;
      return totals;
    };
    expect(withoutCategories(enriched)).toEqual(withoutCategories(original));
    // The ledger's price-share parts are Amazon items' amounts in full: no rest of either charge stays out.
    type FromItems = Array<{ currency: string; category: string; amountMinor: number; rows: number }>;
    expect((enriched.fromAmazonItems as FromItems).reduce((sum, item) => sum + item.amountMinor, 0)).toBe(1100);
    expect((enriched.fromAmazonItems as FromItems).map((item) => item.category)).toContain('Synthetic Household');
    expect(original).not.toHaveProperty('fromAmazonItems');
    // Both charges are Amazon card charges by the domain's own rule, and both are itemized; none is left to list.
    expect(enriched.amazonCoverage).toEqual([{ currency: 'USD', charges: 2, itemized: 2, notItemizable: 0, pending: 0, refunds: 0, other: 0 }]);
    expect(original).not.toHaveProperty('amazonCoverage');
    expect((await get(app, '/card-transactions?amazon=unitemized')).body.total).toBe(0);
    expect(enriched.categories).toContain('Synthetic Household');
    expect(original.categories).not.toContain('Synthetic Household');
    const before = db.prepare('SELECT * FROM card_transactions ORDER BY id').all();
    const listed = new Map(((await get(app, '/card-transactions')).body.transactions as Array<{ id: string; amazon?: unknown }>)
      .map((row) => [row.id, row.amazon]));
    for (const transaction of repo.queryCardTransactions({}).transactions) {
      const detail = (await get(app, `/card-transactions/${transaction.id}`)).body;
      expect(detail.amazon).toMatchObject({ match: 'linked', evidenceClass: 'payment-ledger-complete', aggregate: 'split' });
      expect(detail.amazon.parts.every((p: { classification: string }) => p.classification === 'policy-allocated')).toBe(true);
      expect(detail.amazon.parts.reduce((n: number, p: { amountMinor: number }) => n + p.amountMinor, 0)).toBe(transaction.amountMinor);
      // The list carries each linked row's order as its details have it.
      expect(listed.get(transaction.id)).toEqual(detail.amazon);
    }
    const list = (await get(app, '/card-transactions')).body;
    expect(list.categoryBasis.splitRowsByEvidence).toContainEqual({ evidenceClass: 'payment-ledger-complete', count: 2 });
    expect(db.prepare('SELECT * FROM card_transactions ORDER BY id').all()).toEqual(before);
  });
  it('reads a linked order total without item attribution as held, ledger untouched, and shows the match in the detail', async () => {
    // Synthetic cards, row and capture, as the domain's own tests use them.
    const prime = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9001', currency: 'USD', nickname: 'Synthetic Prime Visa' });
    repo.createCardAccount({ issuer: 'chase', owner: 'alex', last4: '9002', currency: 'USD', nickname: 'Synthetic Marriott Boundless' });
    repo.importCardTransactions({ cardAccountId: prime.id, source: 'synthetic', parserVersion: 'synthetic@1',
      rows: [{ transactionDate: '2026-09-02', status: 'posted', kind: 'purchase', amountMinor: 1100, currency: 'USD',
        description: 'SYNTHETIC RETAIL', issuerCategory: 'Shopping' }] });
    const db = repo.internalGetDb();
    const app = buildApp({ categoryResolver: createAmazonCategoryResolver(db) });
    const [row] = repo.queryCardTransactions({}).transactions;
    const before = (await get(app, '/spending/summary')).body;
    expect(before.categoryBasis).toMatchObject({ availability: 'available', effective: 'original', splitRows: 0, heldOrDeclined: [] });
    expect((await get(app, `/card-transactions/${row.id}`)).body.amazon).toMatchObject({ match: 'none', aggregate: 'whole-row-not-linked' });

    await importAmazonCapture(db, syntheticCapture(), path.join(dir, 'backup-1.db'));
    const cards = readCardInventory(db);
    const proposal = proposeBindings(cards.map((card) => ({ network: 'visa', last4: card.last4!, cardAccountId: card.id })), cards);
    await recordBindingProposal(db, proposal, path.join(dir, 'backup-2.db'));
    await recordRootApproval(db, proposal, rootApproval(proposal), path.join(dir, 'backup-3.db'));

    const after = (await get(app, '/spending/summary')).body;
    expect(after.categoryBasis).toMatchObject({
      availability: 'available', effective: 'original', splitRows: 0,
      splitRowsByEvidence: NO_SPLITS_BY_EVIDENCE, heldOrDeclined: [{ reason: 'item-identity-unproven', count: 1 }],
    });
    const { categoryBasis: beforeBasis, ...beforeBody } = before;
    const { categoryBasis: afterBasis, ...afterBody } = after;
    expect(afterBody).toEqual(beforeBody);
    expect(afterBasis.version).not.toBe(beforeBasis.version);
    expect((await get(app, `/card-transactions/${row.id}`)).body.amazon).toMatchObject({
      match: 'linked', evidenceClass: 'unique-total-match', aggregate: 'whole-row-declined', wholeRowReason: 'item-identity-unproven',
      coverage: { complete: false },
    });
  });
  it('files a full Amazon refund against its itemized charge, so the item category nets and every other figure stays', async () => {
    // Synthetic cards, rows and capture: the order's one item is refunded in full 18 days after the charge.
    const prime = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9001', currency: 'USD' });
    repo.importCardTransactions({ cardAccountId: prime.id, source: 'synthetic', parserVersion: 'synthetic@1', rows: [
      row({ transactionDate: '2026-09-02', amountMinor: 1100, description: 'AMAZON MKTPL*SYNTH01', issuerCategory: 'Shopping' }),
      row({ transactionDate: '2026-09-20', amountMinor: -1100, kind: 'refund', description: 'AMAZON MKTPL*SYNTH02', issuerCategory: 'Shopping' }),
    ] });
    const db = repo.internalGetDb(), capture = syntheticCapture();
    capture.staging.orders[0].itemProof = { complete: true, unknownLine: false, conflict: false };
    await importAmazonCapture(db, capture, path.join(dir, 'refund-backup-1.db'));
    const proposal = proposeBindings([{ network: 'visa', last4: '9001', cardAccountId: prime.id }], readCardInventory(db));
    await recordBindingProposal(db, proposal, path.join(dir, 'refund-backup-2.db'));
    await recordRootApproval(db, proposal, rootApproval(proposal), path.join(dir, 'refund-backup-3.db'));
    await backedUpWrite(db, path.join(dir, 'refund-backup-4.db'), () => {
      db.prepare('INSERT INTO amazon_item_overrides VALUES(?,?)').run(db.prepare('SELECT ref FROM amazon_items').pluck().get(), 'Synthetic Household');
    });
    const app = buildApp({ categoryResolver: createAmazonCategoryResolver(db) });
    const enriched = (await get(app, '/spending/summary')).body;
    const original = (await get(app, '/spending/summary?categoryBasis=original')).body;
    const withoutCategories = (body: Record<string, unknown>) => {
      const { byCategory: _categories, categories: _names, categoryBasis: _basis, fromAmazonItems: _items, amazonCoverage: _coverage, ...totals } = body;
      return totals;
    };
    expect(withoutCategories(enriched)).toEqual(withoutCategories(original));
    // The item's category takes the charge and its refund: it nets to zero, and the parts add up to every row.
    expect(enriched.byCategory).toEqual([{ category: 'Synthetic Household', currency: 'USD', chargesMinor: 1100, creditsMinor: -1100,
      spendingMinor: 0, count: 2 }]);
    expect(original.byCategory).toEqual([{ category: 'Shopping', currency: 'USD', chargesMinor: 1100, creditsMinor: -1100,
      spendingMinor: 0, count: 2 }]);
    expect(enriched.fromAmazonItems).toEqual([{ currency: 'USD', category: 'Synthetic Household', amountMinor: 0, rows: 2 }]);
    expect(enriched.categoryBasis).toMatchObject({ splitRows: 2, splitRowsByEvidence: byEvidence(0, 2) });
    expect(enriched.amazonCoverage).toEqual([{ currency: 'USD', charges: 1, itemized: 1, notItemizable: 0, pending: 0, refunds: 1, other: 0 }]);
    const refund = repo.queryCardTransactions({}).transactions.find((transaction) => transaction.amountMinor < 0)!;
    const detail = (await get(app, `/card-transactions/${refund.id}`)).body.amazon;
    expect(detail).toMatchObject({ match: 'linked', evidenceClass: 'unique-total-match', aggregate: 'split' });
    expect(detail.parts).toMatchObject([{ category: 'Synthetic Household', amountMinor: -1100, categorySource: 'item-override',
      classification: 'policy-allocated' }]);
    expect(detail.items).toHaveLength(1);
  });
});