import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { classifyCardKind } from '@finance-tracker/shared';
import { exceptCardSpendingPaths, mountCardSpendingRoutes } from './cardSpending.js';
import { createCardTransactionsRouter } from './cardTransactions.js';
import { createCardSpendingOverviewRouter } from './cardSpendingOverview.js';
import { createCardSpendingForecastRouter } from './cardSpendingForecast.js';
import { createCardSpendingRulesRouter } from './cardSpendingRules.js';
import { SqliteStateRepo, type CardImportRow } from '../services/sqliteStateRepo.js';
import { listenLoopback } from '../testing/loopback.js';

// Fees whose words have a payment word but no fees category ("NSF PAYMENT FEE", "RETURNED ONLINE PAYMENT FEE"), and the
// credits that give such fees back, stored as card payments by holdr-card-import 1.0.2 and earlier: every Spending answer
// reads each as a fee or the adjustment that offsets it, as 1.0.3 converts them, and nothing is written. Synthetic data
// only: made-up merchants, amounts, dates and last-4s; the fee and payment wording is issuer wording.

const FEES = 'Fees & Adjustments-Fees & Adjustments';
const ISSUER_PAYMENTS = 'Fees & Adjustments-Payments';
const GROCERIES = 'Merchandise & Supplies-Groceries';
const SEPTEMBER = 'from=2026-09-01&to=2026-09-30';
/** September as Spending counts it: groceries, five fees (two given back), interest, and a purchase and its refund. */
const SPENDING = 6_250 + 3_500 + 2_700 + 2_900 + 2_500 + 9_900 - 3_500 + 1_234 + 4_000 - 2_900 - 9_900;

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

function buildApp(): express.Express {
  const server = express();
  server.use(exceptCardSpendingPaths(express.json({ limit: '2mb' })));
  const log = (line: string) => logs.push(line);
  mountCardSpendingRoutes(server, {
    repo, requireAuth: testAuth, log,
    routers: [createCardTransactionsRouter(repo, { log }), createCardSpendingOverviewRouter(repo, { log }),
      createCardSpendingForecastRouter(repo, { log }), createCardSpendingRulesRouter(repo, { log })],
  });
  return server;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-payment-worded-fees-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db'), now: () => new Date('2026-10-05T12:00:00.000Z') });
  logs = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  expect(logs).toEqual([]);
  repo.close();
  await rm(dir, { recursive: true, force: true });
});

/** Transaction date, description, amount, the issuer's category, and the kind holdr-card-import 1.0.2 wrote. */
const ROWS: ReadonlyArray<readonly [string, string, number, string | null, CardImportRow['kind']]> = [
  ['2026-09-02', 'NORTHWIND GROCERY', 6_250, GROCERIES, 'purchase'],
  ['2026-09-05', 'ONLINE ACH PAYMENT - THANK YOU', -150_000, null, 'payment'],
  ['2026-09-12', 'RETURNED ONLINE ACH PAYMENT', 150_000, null, 'payment'],
  ['2026-09-12', 'RETURNED ONLINE PAYMENT FEE', 3_500, null, 'payment'],
  ['2026-09-14', 'NSF PAYMENT FEE', 2_700, null, 'payment'],
  ['2026-09-15', 'RETURNED PAYMENT FEE', 2_900, FEES, 'fee'],
  ['2026-09-16', 'RETURNED ACH PAYMENT FEE', 2_500, null, 'payment'],
  ['2026-09-18', 'CONTOSO OUTFITTERS', 9_900, null, 'purchase'],
  ['2026-09-20', 'RETURNED ONLINE PAYMENT FEE REVERSAL', -3_500, null, 'payment'],
  ['2026-09-20', 'INTEREST CHARGE ON PURCHASES', 1_234, null, 'interest'],
  ['2026-09-21', 'LATE FEE', 4_000, null, 'fee'],
  ['2026-09-22', 'RETURNED PAYMENT FEE WAIVED', -2_900, FEES, 'payment'],
  ['2026-09-25', 'CONTOSO OUTFITTERS', -9_900, null, 'refund'],
  ['2026-09-28', 'AUTOPAY PAYMENT - THANK YOU', -80_000, ISSUER_PAYMENTS, 'payment'],
];

function seed() {
  const card = repo.createCardAccount({ issuer: 'citi', owner: 'joint', last4: '0001', currency: 'USD' });
  repo.importCardTransactions({
    cardAccountId: card.id, source: 'test-sync', parserVersion: 'test@1', coverage: { start: '2026-09-01', end: '2026-10-04' },
    rows: ROWS.map(([transactionDate, description, amountMinor, issuerCategory, kind]) => ({
      transactionDate, postedDate: transactionDate, status: 'posted', amountMinor, currency: 'USD', kind, description, merchant: null,
      issuerCategory,
    } as CardImportRow)),
  });
  const stored = repo.listCardTransactions();
  const id = (description: string) => stored.find((item) => item.description === description)!.id;
  return { stored, feeId: id('NSF PAYMENT FEE'), waiverId: id('RETURNED PAYMENT FEE WAIVED') };
}

const get = async (app: express.Express, url: string) => request(await listenLoopback(app)).get(url).set('x-test-auth', 'ok');
const patch = async (app: express.Express, url: string, body: unknown) => request(await listenLoopback(app)).patch(url)
  .set('x-test-auth', 'ok').set('Content-Type', 'application/json').send(JSON.stringify(body));
type Listed = { description: string; transactionDate: string; kind: string; role: string; amountMinor: number };

describe('payment-worded fees in Spending', () => {
  it('count as fees, and their give-backs against them, in the summary, the accounting, the list and a row\'s details', async () => {
    const { stored, feeId, waiverId } = seed();
    const app = buildApp();
    for (const basis of ['enriched', 'original']) {
      const summary = (await get(app, `/spending/summary?${SEPTEMBER}&categoryBasis=${basis}`)).body;
      expect(summary.totals, basis).toEqual([{
        currency: 'USD', spendingMinor: SPENDING, chargesMinor: SPENDING + 3_500 + 2_900 + 9_900, creditsMinor: -3_500 - 2_900 - 9_900, count: 11,
        paymentsMinor: -150_000 + 150_000 - 80_000, paymentCount: 3, otherMinor: 0, otherCount: 0,
      }]);
    }
    // A fee and the credit that gives it back net to nothing under the issuer's fees.
    expect((await get(app, `/spending/summary?${SEPTEMBER}&categoryBasis=original`)).body.byCategory
      .find((item: { category: string }) => item.category === FEES)).toMatchObject({ spendingMinor: 0, chargesMinor: 2_900, creditsMinor: -2_900, count: 2 });
    // On the default basis, enriched, every fee, the interest and each give-back is under the card's fees, where they net:
    // those with no category of their own by the kind rules, a give-back as the fee it gives back.
    expect((await get(app, `/spending/summary?${SEPTEMBER}`)).body.byCategory.find((item: { category: string }) => item.category === FEES))
      .toMatchObject({
        spendingMinor: 3_500 + 2_700 + 2_900 + 2_500 + 1_234 + 4_000 - 3_500 - 2_900, chargesMinor: 3_500 + 2_700 + 2_900 + 2_500 + 1_234 + 4_000,
        creditsMinor: -3_500 - 2_900, count: 8,
      });

    // Every posted row is still in the card's activity; the card payments are the three that are.
    const [book] = (await get(app, `/spending/accounting?${SEPTEMBER}`)).body.accounting;
    expect(book.activity.netMinor).toBe(stored.reduce((sum, item) => sum + item.amountMinor, 0));
    expect(book.transfers).toEqual({ netMinor: -80_000, chargesMinor: 150_000, creditsMinor: -230_000, count: 3 });
    expect(book.spending.netMinor).toBe(SPENDING);

    // Each row is listed under the kind holdr-card-import 1.0.3 converts it to, and counts by it.
    const listed = (await get(app, `/card-transactions?${SEPTEMBER}&limit=200`)).body.transactions as Listed[];
    expect(listed).toHaveLength(ROWS.length);
    for (const [transactionDate, description, amountMinor, issuerCategory] of ROWS) {
      const item = listed.find((row) => row.transactionDate === transactionDate && row.description === description && row.amountMinor === amountMinor)!;
      expect(item.kind, description).toBe(classifyCardKind({ amountMinor, description, issuerCategory }));
    }
    // As card fees, the enriched answers file those without a category of their own under the card's fees, by kind, and the
    // give-back with them, as the fee it gives back; a card payment is filed nowhere.
    for (const description of ['NSF PAYMENT FEE', 'RETURNED ONLINE PAYMENT FEE', 'RETURNED ACH PAYMENT FEE']) {
      expect(listed.find((item) => item.description === description), description)
        .toMatchObject({ kind: 'fee', category: FEES, categorySource: 'inferred', categoryInference: { basis: 'rule', rule: 'card-fee' } });
    }
    expect(listed.find((item) => item.description === 'RETURNED ONLINE PAYMENT FEE REVERSAL')).toMatchObject({
      kind: 'adjustment', category: FEES, categorySource: 'inferred', categoryInference: { basis: 'rule', rule: 'card-fee' },
    });
    expect(listed.find((item) => item.description === 'ONLINE ACH PAYMENT - THANK YOU'))
      .toMatchObject({ kind: 'payment', category: 'Uncategorized', categorySource: 'uncategorized' });
    expect(listed.filter((item) => / FEE/.test(item.description)).sort((a, b) => (a.description < b.description ? -1 : 1))
      .map((item) => [item.description, item.kind, item.role, item.amountMinor])).toEqual([
      ['LATE FEE', 'fee', 'spending', 4_000], ['NSF PAYMENT FEE', 'fee', 'spending', 2_700],
      ['RETURNED ACH PAYMENT FEE', 'fee', 'spending', 2_500], ['RETURNED ONLINE PAYMENT FEE', 'fee', 'spending', 3_500],
      ['RETURNED ONLINE PAYMENT FEE REVERSAL', 'adjustment', 'spending', -3_500], ['RETURNED PAYMENT FEE', 'fee', 'spending', 2_900],
      ['RETURNED PAYMENT FEE WAIVED', 'adjustment', 'spending', -2_900],
    ]);
    // The kind filter is the kind Spending reads, so a page is cut after it, on either list path.
    const kinds = async (query: string) => ((await get(app, `/card-transactions?${SEPTEMBER}&limit=200&${query}`)).body.transactions as Listed[])
      .map((item) => item.description).sort();
    expect(await kinds('kind=fee')).toEqual(['LATE FEE', 'NSF PAYMENT FEE', 'RETURNED ACH PAYMENT FEE', 'RETURNED ONLINE PAYMENT FEE', 'RETURNED PAYMENT FEE']);
    expect(await kinds('kind=adjustment')).toEqual(['RETURNED ONLINE PAYMENT FEE REVERSAL', 'RETURNED PAYMENT FEE WAIVED']);
    expect(await kinds('kind=payment')).toEqual(['AUTOPAY PAYMENT - THANK YOU', 'ONLINE ACH PAYMENT - THANK YOU', 'RETURNED ONLINE ACH PAYMENT']);
    for (const basis of ['enriched', 'original']) {
      // A payment its issuer files under fees and adjustments names no fee: a card payment still.
      expect(await kinds(`kind=payment&category=${encodeURIComponent(ISSUER_PAYMENTS)}&categoryBasis=${basis}`), basis)
        .toEqual(['AUTOPAY PAYMENT - THANK YOU']);
    }
    expect(await kinds(`kind=fee,adjustment&category=${encodeURIComponent(FEES)}&categoryBasis=original`))
      .toEqual(['RETURNED PAYMENT FEE', 'RETURNED PAYMENT FEE WAIVED']);
    // The enriched answers also file there every fee and give-back with no category of its own: those stored as payments too.
    expect(await kinds(`kind=fee,adjustment&category=${encodeURIComponent(FEES)}&categoryBasis=enriched`)).toEqual([
      'LATE FEE', 'NSF PAYMENT FEE', 'RETURNED ACH PAYMENT FEE', 'RETURNED ONLINE PAYMENT FEE', 'RETURNED ONLINE PAYMENT FEE REVERSAL',
      'RETURNED PAYMENT FEE', 'RETURNED PAYMENT FEE WAIVED',
    ]);
    const page = (await get(app, `/card-transactions?${SEPTEMBER}&kind=fee&limit=2`)).body;
    expect([page.total, page.transactions.length, page.nextOffset]).toEqual([5, 2, 2]);

    for (const [id, kind, amountMinor] of [[feeId, 'fee', 2_700], [waiverId, 'adjustment', -2_900]] as const) {
      for (const basis of ['enriched', 'original']) {
        const detail = (await get(app, `/card-transactions/${id}?categoryBasis=${basis}`)).body.transaction;
        expect([detail.kind, detail.role, detail.amountMinor], basis).toEqual([kind, 'spending', amountMinor]);
      }
    }

    // Read, never written: every stored row, its amount and its kind are as imported, and what the payment
    // reconciliation reads (the stored payments) is what it read before.
    expect(repo.listCardTransactions()).toEqual(stored);
    expect([repo.getCardTransaction(feeId)?.kind, repo.getCardTransaction(waiverId)?.kind]).toEqual(['payment', 'payment']);
    expect(repo.listCardTransactionsMatching({ kinds: ['payment'] }).map((item) => item.description).sort()).toEqual([
      'AUTOPAY PAYMENT - THANK YOU', 'NSF PAYMENT FEE', 'ONLINE ACH PAYMENT - THANK YOU', 'RETURNED ACH PAYMENT FEE', 'RETURNED ONLINE ACH PAYMENT',
      'RETURNED ONLINE PAYMENT FEE', 'RETURNED ONLINE PAYMENT FEE REVERSAL', 'RETURNED PAYMENT FEE WAIVED',
    ]);
  });

  it('are the card\'s costs in the insights, but for a fee given back', async () => {
    seed();
    const insights = (await get(buildApp(), '/spending/insights?month=2026-09&today=2026-10-05')).body;
    expect(insights.costs.period).toMatchObject({ feesMinor: 2_700 + 2_500 + 4_000, interestMinor: 1_234, reversalsMinor: 0 });
  });

  it('count as the owner filed one under a category of their own, and as a fee again once it is cleared', async () => {
    const { feeId } = seed();
    const app = buildApp();
    const filed = (await patch(app, `/card-transactions/${feeId}`, { userCategory: 'Sample bank charges' })).body;
    expect([filed.kind, filed.role, filed.category]).toEqual(['payment', 'transfer', 'Sample bank charges']);
    expect((await get(app, `/spending/summary?${SEPTEMBER}`)).body.totals[0])
      .toMatchObject({ spendingMinor: SPENDING - 2_700, paymentsMinor: -80_000 + 2_700, paymentCount: 4 });
    expect((await get(app, `/card-transactions?${SEPTEMBER}&kind=fee&limit=200`)).body.total).toBe(4);

    const cleared = (await patch(app, `/card-transactions/${feeId}`, { userCategory: null })).body;
    expect([cleared.kind, cleared.role]).toEqual(['fee', 'spending']);
    expect((await get(app, `/spending/summary?${SEPTEMBER}`)).body.totals[0])
      .toMatchObject({ spendingMinor: SPENDING, paymentsMinor: -80_000, paymentCount: 3 });
    expect(repo.getCardTransaction(feeId)?.kind).toBe('payment');
  });
});

describe('a fee and its give-back with no category, on the enriched basis', () => {
  // Only these two posted rows on a card: no owner or issuer category, and no history with one. Each pair as a producer
  // stored it: as card payments, as holdr-card-import tools before 1.0.3 stored some, or as 1.0.3 converts them.
  const PARKING = 'Transportation-Parking Charges';
  const converted = (amountMinor: number, description: string): CardImportRow['kind'] => classifyCardKind({ amountMinor, description });
  const asPayment = (): CardImportRow['kind'] => 'payment';
  const PAIRS: ReadonlyArray<{
    pair: string;
    rows: readonly [readonly [string, string, number], readonly [string, string, number]];
    storedAs: (amountMinor: number, description: string) => CardImportRow['kind'];
    read: readonly [string, string];
    category: string;
    rules: readonly [string | undefined, string | undefined];
  }> = [
    // A card's fee for a payment returned, and its refund: under the card's fees. So is one for a payment reversed, whose
    // REVERSED, beside the payment word, is the fee's own word.
    ...[asPayment, converted].flatMap((storedAs) => ([['NSF PAYMENT FEE', 2_700], ['REVERSED PAYMENT FEE', 2_500]] as const).map(([fee, amountMinor]) => ({
      pair: `${fee}, ${storedAs === asPayment ? 'as holdr-card-import 1.0.2 stored it' : 'as 1.0.3 converts it'}`,
      rows: [['2026-09-14', fee, amountMinor], ['2026-09-20', `${fee} REFUND`, -amountMinor]] as const,
      storedAs, read: ['fee', 'adjustment'] as const, category: FEES, rules: ['card-fee', 'card-fee'] as const,
    }))),
    // Interest and its reversal, and a late payment fee and its credit in the fee's own words (which the classifier makes
    // a refund): under the card's fees.
    {
      pair: 'interest and its reversal', rows: [['2026-09-20', 'INTEREST CHARGE ON PURCHASES', 1_234], ['2026-09-24', 'INTEREST CHARGE ON PURCHASES REVERSAL', -1_234]],
      storedAs: converted, read: ['interest', 'adjustment'], category: FEES, rules: ['interest-charge', 'interest-charge'],
    },
    {
      pair: 'a late payment fee and its credit', rows: [['2026-09-21', 'LATE PAYMENT FEE', 3_500], ['2026-09-26', 'LATE PAYMENT FEE', -3_500]],
      storedAs: converted, read: ['fee', 'refund'], category: FEES, rules: ['card-fee', 'card-fee'],
    },
    // A merchant's fee and its refund: with the merchant, never under the card's fees. One with only main's reversal wording
    // keeps the adjustment every converter wrote for it (ROOT O133: rows stored as adjustments are a follow-up's).
    {
      pair: 'a parking operator\'s fee and its refund', rows: [['2026-09-10', 'SAMPLE PARKING FEE', 2_700], ['2026-09-17', 'SAMPLE PARKING FEE REFUND', -2_700]],
      storedAs: converted, read: ['purchase', 'adjustment'], category: PARKING, rules: ['parking', 'parking'],
    },
    // A merchant's fee for being paid online by card, and its refund: as tools before 1.0.2 stored both (card payments, for
    // their payment words), and as 1.0.3 converts them; a purchase and its refund, with the merchant, either way.
    ...[asPayment, converted].map((storedAs) => ({
      pair: `a parking operator's online payment fee, ${storedAs === asPayment ? 'stored as card payments' : 'as 1.0.3 converts it'}`,
      rows: [['2026-09-10', 'SAMPLE CITY PARKING ONLINE PAYMENT FEE', 500], ['2026-09-17', 'SAMPLE CITY PARKING ONLINE PAYMENT FEE REFUND', -500]] as const,
      storedAs, read: ['purchase', 'refund'] as const, category: PARKING, rules: ['parking', 'parking'] as const,
    })),
    // A biller nothing is known of: both uncategorized, together.
    {
      pair: 'a biller\'s online payment fee and its refund', rows: [['2026-09-13', 'SAMPLE UTILITY ONLINE PAYMENT FEE', 500], ['2026-09-19', 'SAMPLE UTILITY ONLINE PAYMENT FEE REFUND', -500]],
      storedAs: converted, read: ['purchase', 'refund'], category: 'Uncategorized', rules: [undefined, undefined],
    },
  ];
  for (const { pair, rows, storedAs, read, category, rules } of PAIRS) {
    it(`files both in one category, where they net, and a filter by it keeps the give-back with its charge: ${pair}`, async () => {
      const card = repo.createCardAccount({ issuer: 'citi', owner: 'joint', last4: '0001', currency: 'USD' });
      repo.importCardTransactions({
        cardAccountId: card.id, source: 'test-sync', parserVersion: 'test@1', coverage: { start: '2026-09-01', end: '2026-10-04' },
        rows: rows.map(([date, description, amountMinor]) => ({
          transactionDate: date, postedDate: date, status: 'posted', amountMinor, currency: 'USD', kind: storedAs(amountMinor, description), description,
          merchant: null, issuerCategory: null,
        } as CardImportRow)),
      });
      const stored = repo.listCardTransactions();
      const app = buildApp();
      const [charge, credit] = rows.map(([, , amountMinor]) => amountMinor);
      type Category = { category: string; spendingMinor: number; chargesMinor: number; creditsMinor: number; count: number };
      const categories = (body: { byCategory: Category[] }) =>
        body.byCategory.map((item) => [item.category, item.spendingMinor, item.chargesMinor, item.creditsMinor, item.count]);
      // The default basis, enriched: both in one category, netting to nothing.
      expect(categories((await get(app, `/spending/summary?${SEPTEMBER}`)).body)).toEqual([[category, 0, charge, credit, 2]]);
      // Filtered by that category, the give-back stays with its charge, in the summary and in the list; no other has either.
      const filed = encodeURIComponent(category);
      const filtered = (await get(app, `/spending/summary?${SEPTEMBER}&category=${filed}`)).body;
      expect(filtered.totals).toHaveLength(1);
      expect(filtered.totals[0]).toMatchObject({ spendingMinor: 0, chargesMinor: charge, creditsMinor: credit, count: 2 });
      const listed = (await get(app, `/card-transactions?${SEPTEMBER}&category=${filed}&limit=200`)).body.transactions as
        Array<{ amountMinor: number; kind: string; category: string; categoryInference?: { rule?: string } }>;
      expect(listed.sort((a, b) => b.amountMinor - a.amountMinor).map((item) => [item.kind, item.category, item.categoryInference?.rule]))
        .toEqual([[read[0], category, rules[0]], [read[1], category, rules[1]]]);
      for (const other of [FEES, PARKING, 'Uncategorized'].filter((name) => name !== category)) {
        expect((await get(app, `/card-transactions?${SEPTEMBER}&category=${encodeURIComponent(other)}&limit=200`)).body.total, other).toBe(0);
      }
      // On the original basis neither has a category: both uncategorized, where they net too.
      expect(categories((await get(app, `/spending/summary?${SEPTEMBER}&categoryBasis=original`)).body))
        .toEqual([['Uncategorized', 0, charge, credit, 2]]);
      // Read, never written.
      expect(repo.listCardTransactions()).toEqual(stored);
    });
  }
});

describe('a merchant\'s fee given back, in the card\'s costs', () => {
  // The reviewer's counterexample at b0ed3be8: a card fee, and a merchant's fee for being paid online of the same amount,
  // refunded; with the card's own fee for a returned payment, given back. Stored as earlier tools stored them (the rows
  // worded as payments as card payments), or as holdr-card-import 1.0.3 converts them.
  const ROWS_3: ReadonlyArray<readonly [string, string, number, CardImportRow['kind']]> = [
    ['2026-09-01', 'ANNUAL FEE', 500, 'fee'],
    ['2026-09-10', 'SAMPLE PARKING ONLINE PAYMENT FEE', 500, 'payment'],
    ['2026-09-17', 'SAMPLE PARKING ONLINE PAYMENT FEE REFUND', -500, 'payment'],
    ['2026-09-14', 'NSF PAYMENT FEE', 2_700, 'payment'],
    ['2026-09-20', 'NSF PAYMENT FEE REFUND', -2_700, 'payment'],
  ];
  for (const layer of ['as earlier tools stored them', 'as 1.0.3 converts them'] as const) {
    it(`counts the card fee once, the merchant's refund as none of the card's costs, and lists each by its kind: ${layer}`, async () => {
      const card = repo.createCardAccount({ issuer: 'citi', owner: 'joint', last4: '0001', currency: 'USD' });
      repo.importCardTransactions({
        cardAccountId: card.id, source: 'test-sync', parserVersion: 'test@1', coverage: { start: '2026-09-01', end: '2026-10-04' },
        rows: ROWS_3.map(([date, description, amountMinor, storedKind]) => ({
          transactionDate: date, postedDate: date, status: 'posted', amountMinor, currency: 'USD', description, merchant: null, issuerCategory: null,
          kind: layer === 'as 1.0.3 converts them' ? classifyCardKind({ amountMinor, description }) : storedKind,
        } as CardImportRow)),
      });
      const stored = repo.listCardTransactions();
      const app = buildApp();
      const NONE = { interestMinor: 0, foreignFeesMinor: 0, reversalsMinor: 0 };
      const { costs } = (await get(app, '/spending/insights?month=2026-09&today=2026-10-05')).body;
      expect(costs).toEqual({ period: { feesMinor: 500, ...NONE }, year: { year: '2026', feesMinor: 500, ...NONE } });
      const kinds = async (kind: string) => ((await get(app, `/card-transactions?${SEPTEMBER}&limit=200&kind=${kind}`)).body.transactions as Listed[])
        .map((item) => item.description).sort();
      expect([await kinds('fee'), await kinds('purchase'), await kinds('refund'), await kinds('adjustment'), await kinds('payment')]).toEqual([
        ['ANNUAL FEE', 'NSF PAYMENT FEE'], ['SAMPLE PARKING ONLINE PAYMENT FEE'], ['SAMPLE PARKING ONLINE PAYMENT FEE REFUND'], ['NSF PAYMENT FEE REFUND'], [],
      ]);
      expect((await get(app, `/spending/summary?${SEPTEMBER}`)).body.totals[0]).toMatchObject({ spendingMinor: 500, paymentsMinor: 0, paymentCount: 0 });
      // Read, never written.
      expect(repo.listCardTransactions()).toEqual(stored);
    });
  }
});
