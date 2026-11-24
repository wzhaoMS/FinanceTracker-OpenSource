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

// A payment to the card that the bank returned (a verification problem), debited again by the issuer: stored as a
// purchase by a producer that kinds rows itself, or as a fee where the issuer files it under fees, or as a purchase with
// its name cut short (Capital One's OFX cuts every name at 25 characters: "Returned Online ACH Payme"). Every Spending
// answer reads it as a card payment, and nothing is written. Synthetic data only: made-up merchants, amounts, dates and
// last-4s; "RETURNED ONLINE ACH PAYMENT" and its cut forms are issuer wording.

const TODAY = '2026-10-05';
const FEES = 'Fees & Adjustments-Fees & Adjustments';
const GROCERIES = 'Merchandise & Supplies-Groceries';
const MONTHS = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
/** A return's name, whole or cut short. */
const RETURNED = /RETURNED (?:ONLINE|MOBILE) ACH PAYME/i;
const SEPTEMBER = 'from=2026-09-01&to=2026-09-30';
/** September as Spending counts it: the subscription, groceries, two fees, interest, and a purchase and its refund. */
const SEPTEMBER_SPENDING = 1_599 + 7_000 + 2_900 + 4_000 + 1_234 + 9_900 - 9_900;

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
  dir = await mkdtemp(path.join(tmpdir(), 'ft-returned-payments-'));
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

const row = (transactionDate: string, description: string, amountMinor: number, patch: Partial<CardImportRow> = {}): CardImportRow => ({
  transactionDate, postedDate: transactionDate, status: 'posted', amountMinor, currency: 'USD', kind: 'purchase', description,
  merchant: null, issuerCategory: null, ...patch,
} as CardImportRow);

/**
 * Every month a payment to the card, the bank returning it, a subscription and groceries; in September also a second
 * payment returned (one its issuer files under fees), a fee for a returned payment, a late fee, interest, and a purchase
 * and its refund. The record is complete from May through yesterday.
 */
function seed() {
  // The import classifier makes a fee of a return its issuer files under fees: stored so here.
  expect(classifyCardKind({ amountMinor: 80_000, description: 'RETURNED MOBILE ACH PAYMENT', issuerCategory: FEES })).toBe('fee');
  const card = repo.createCardAccount({ issuer: 'citi', owner: 'joint', last4: '0001', currency: 'USD' });
  const rows: CardImportRow[] = MONTHS.flatMap((month, index) => [
    row(`${month}-03`, 'ONLINE ACH PAYMENT - THANK YOU', -120_000, { kind: 'payment' }),
    row(`${month}-10`, 'RETURNED ONLINE ACH PAYMENT', 120_000),
    row(`${month}-15`, 'SAMPLE STREAMING SERVICE', 1_599),
    row(`${month}-20`, 'NORTHWIND GROCERY', 6_000 + index * 250, { issuerCategory: GROCERIES }),
  ]);
  rows.push(
    row('2026-09-06', 'MOBILE ACH PAYMENT', -80_000, { kind: 'payment' }),
    row('2026-09-14', 'RETURNED MOBILE ACH PAYMENT', 80_000, { kind: 'fee', issuerCategory: FEES }),
    row('2026-09-15', 'RETURNED PAYMENT FEE', 2_900, { kind: 'fee', issuerCategory: FEES }),
    row('2026-09-18', 'CONTOSO OUTFITTERS', 9_900),
    row('2026-09-21', 'LATE FEE', 4_000, { kind: 'fee', issuerCategory: FEES }),
    row('2026-09-22', 'INTEREST CHARGE ON PURCHASES', 1_234, { kind: 'interest', issuerCategory: FEES }),
    row('2026-09-25', 'CONTOSO OUTFITTERS', -9_900, { kind: 'refund' }),
  );
  repo.importCardTransactions({
    cardAccountId: card.id, source: 'test-sync', parserVersion: 'test@1', rows, coverage: { start: '2026-05-01', end: '2026-10-04' },
  });
  const stored = repo.listCardTransactions();
  const id = (date: string, description: string) => stored.find((item) => item.transactionDate === date && item.description === description)!.id;
  return { stored, returnId: id('2026-09-10', 'RETURNED ONLINE ACH PAYMENT'), feeReturnId: id('2026-09-14', 'RETURNED MOBILE ACH PAYMENT') };
}

const get = async (app: express.Express, url: string) => request(await listenLoopback(app)).get(url).set('x-test-auth', 'ok');
const patch = async (app: express.Express, url: string, body: unknown) => request(await listenLoopback(app)).patch(url)
  .set('x-test-auth', 'ok').set('Content-Type', 'application/json').send(JSON.stringify(body));
type Named = { merchant?: string; name?: string; description?: string };
const returnsAmong = <T extends Named>(items: readonly T[]) => items.filter((item) => RETURNED.test(item.merchant ?? item.name ?? item.description ?? ''));

describe('returned card payments in Spending', () => {
  it('count with the payments in the summary, the accounting, the list and a row\'s details, on either basis', async () => {
    const { stored, returnId, feeReturnId } = seed();
    const app = buildApp();
    for (const basis of ['enriched', 'original']) {
      const summary = (await get(app, `/spending/summary?${SEPTEMBER}&categoryBasis=${basis}`)).body;
      expect(summary.totals, basis).toEqual([{
        currency: 'USD', spendingMinor: SEPTEMBER_SPENDING, chargesMinor: SEPTEMBER_SPENDING + 9_900, creditsMinor: -9_900, count: 7,
        paymentsMinor: 0, paymentCount: 4, otherMinor: 0, otherCount: 0,
      }]);
      expect(returnsAmong(summary.byMerchant), basis).toEqual([]);
      // A fee for a returned payment, the late fee and interest stay under their issuer's fees: the return is not there.
      expect(summary.byCategory.find((item: { category: string }) => item.category === FEES), basis)
        .toMatchObject({ spendingMinor: 2_900 + 4_000 + 1_234, count: 3 });
    }

    // Every posted row is still in the card's activity: a return adds to what the card owes, as a payment's reversal.
    const [book] = (await get(app, `/spending/accounting?${SEPTEMBER}`)).body.accounting;
    const septemberRows = stored.filter((item) => item.transactionDate.startsWith('2026-09'));
    expect(book.activity.netMinor).toBe(septemberRows.reduce((sum, item) => sum + item.amountMinor, 0));
    expect(book.transfers).toEqual({ netMinor: 0, chargesMinor: 200_000, creditsMinor: -200_000, count: 4 });
    expect(book.spending.netMinor).toBe(SEPTEMBER_SPENDING);

    const listed = (await get(app, `/card-transactions?${SEPTEMBER}&limit=200`)).body.transactions as Array<Named & Record<string, unknown>>;
    expect(returnsAmong(listed).map((item) => [item.description, item.kind, item.role, item.amountMinor]).sort()).toEqual([
      ['RETURNED MOBILE ACH PAYMENT', 'payment', 'transfer', 80_000],
      ['RETURNED ONLINE ACH PAYMENT', 'payment', 'transfer', 120_000],
    ]);
    // The kind filter is the kind Spending reads, so a page is cut after it, on either list path.
    const kinds = async (query: string) => ((await get(app, `/card-transactions?${SEPTEMBER}&limit=200&${query}`)).body.transactions as Named[])
      .map((item) => item.description).sort();
    expect(await kinds('kind=payment')).toEqual(['MOBILE ACH PAYMENT', 'ONLINE ACH PAYMENT - THANK YOU', 'RETURNED MOBILE ACH PAYMENT', 'RETURNED ONLINE ACH PAYMENT']);
    expect(await kinds('kind=purchase')).toEqual(['CONTOSO OUTFITTERS', 'NORTHWIND GROCERY', 'SAMPLE STREAMING SERVICE']);
    expect(await kinds('kind=fee')).toEqual(['LATE FEE', 'RETURNED PAYMENT FEE']);
    const fees = encodeURIComponent(FEES);
    for (const basis of ['enriched', 'original']) {
      expect(await kinds(`kind=fee,interest&category=${fees}&categoryBasis=${basis}`), basis)
        .toEqual(['INTEREST CHARGE ON PURCHASES', 'LATE FEE', 'RETURNED PAYMENT FEE']);
      expect(await kinds(`kind=payment&category=${fees}&categoryBasis=${basis}`), basis).toEqual(['RETURNED MOBILE ACH PAYMENT']);
    }
    const page = (await get(app, `/card-transactions?${SEPTEMBER}&kind=payment&limit=1`)).body;
    expect([page.total, page.transactions.length, page.nextOffset]).toEqual([4, 1, 1]);

    for (const [id, amountMinor] of [[returnId, 120_000], [feeReturnId, 80_000]] as const) {
      for (const basis of ['enriched', 'original']) {
        const detail = (await get(app, `/card-transactions/${id}?categoryBasis=${basis}`)).body.transaction;
        expect([detail.kind, detail.role, detail.amountMinor], basis).toEqual(['payment', 'transfer', amountMinor]);
      }
    }

    // Read, never written: every stored row, its amount and its kind are as imported, and what the payment
    // reconciliation reads (the stored payments) is what it read before.
    expect(repo.listCardTransactions()).toEqual(stored);
    expect(repo.getCardTransaction(returnId)?.kind).toBe('purchase');
    expect(repo.getCardTransaction(feeReturnId)?.kind).toBe('fee');
    expect(repo.listCardTransactionsMatching({ kinds: ['payment'] }).map((item) => item.description))
      .toEqual([...MONTHS.flatMap((month) => (month === '2026-09'
        ? ['ONLINE ACH PAYMENT - THANK YOU', 'MOBILE ACH PAYMENT'] : ['ONLINE ACH PAYMENT - THANK YOU']))]);
  });

  it('are no recurring charge, and no part of insights, compare, trend, forecast or patterns', async () => {
    seed();
    const app = buildApp();
    const insights = (await get(app, `/spending/insights?month=2026-09&today=${TODAY}`)).body;
    expect(returnsAmong(insights.recurring)).toEqual([]);
    expect(insights.recurring.map((charge: Named) => charge.merchant)).toContain('SAMPLE STREAMING SERVICE');
    expect([insights.costs.period.feesMinor, insights.costs.period.interestMinor]).toEqual([2_900 + 4_000, 1_234]);

    const compare = (await get(app, `/spending/compare?${SEPTEMBER}&baselineFrom=2026-08-01&baselineTo=2026-08-31&today=${TODAY}`)).body.comparison;
    expect([compare.current.spendingMinor, compare.baseline.spendingMinor, compare.deltaMinor])
      .toEqual([SEPTEMBER_SPENDING, 1_599 + 6_750, SEPTEMBER_SPENDING - 1_599 - 6_750]);
    expect(returnsAmong([...compare.current.recurring, ...compare.baseline.recurring])).toEqual([]);

    const expected: Array<[string, number]> = [
      ['2026-05', 1_599 + 6_000], ['2026-06', 1_599 + 6_250], ['2026-07', 1_599 + 6_500], ['2026-08', 1_599 + 6_750], ['2026-09', SEPTEMBER_SPENDING],
    ];
    const trend = (await get(app, `/spending/trend?fromMonth=2026-05&toMonth=2026-09&today=${TODAY}`)).body;
    expect(trend.months.map((month: { month: string; spendingMinor: number }) => [month.month, month.spendingMinor])).toEqual(expected);
    const forecast = (await get(app, `/spending/forecast?today=${TODAY}`)).body;
    const forecastMonths = new Map((forecast.months as Array<{ month: string; spendingMinor: number }>).map((month) => [month.month, month.spendingMinor]));
    for (const [month, spendingMinor] of expected) expect(forecastMonths.get(month), month).toBe(spendingMinor);
    const patterns = (await get(app, `/spending/patterns?today=${TODAY}`)).body;
    expect(returnsAmong(patterns.bills.items)).toEqual([]);
    expect(patterns.bills.items.map((bill: Named) => bill.merchant)).toContain('SAMPLE STREAMING SERVICE');

    // An owner rule's preview reads the rows as Spending does: nothing here is a precious-metals purchase.
    const preview = await get(app, '/spending/rules/preview?merchantClass=bullion-dealer&currency=USD&minAmountMinor=1');
    expect(preview.status).toBe(200);
    expect(preview.body.preview.amounts.count).toBe(0);
  });

  it('count as the owner filed one under a category of their own, and as a payment again once it is cleared', async () => {
    const { returnId } = seed();
    const app = buildApp();
    const filed = (await patch(app, `/card-transactions/${returnId}`, { userCategory: 'Sample bank charges' })).body;
    expect([filed.kind, filed.role, filed.category]).toEqual(['purchase', 'spending', 'Sample bank charges']);
    const summary = (await get(app, `/spending/summary?${SEPTEMBER}`)).body;
    expect(summary.totals[0]).toMatchObject({ spendingMinor: SEPTEMBER_SPENDING + 120_000, paymentsMinor: -120_000, paymentCount: 3 });
    expect(summary.byCategory.find((item: { category: string }) => item.category === 'Sample bank charges'))
      .toMatchObject({ spendingMinor: 120_000, count: 1 });
    expect((await get(app, `/card-transactions?${SEPTEMBER}&kind=purchase&limit=200`)).body.total).toBe(4);

    const cleared = (await patch(app, `/card-transactions/${returnId}`, { userCategory: null })).body;
    expect([cleared.kind, cleared.role]).toEqual(['payment', 'transfer']);
    expect((await get(app, `/spending/summary?${SEPTEMBER}`)).body.totals[0])
      .toMatchObject({ spendingMinor: SEPTEMBER_SPENDING, paymentsMinor: 0, paymentCount: 4 });
    expect(repo.getCardTransaction(returnId)?.kind).toBe('purchase');
  });
});

describe('returned card payments the issuer cut short (Capital One\'s OFX cuts every name at 25 characters)', () => {
  const ONLINE = 'Returned Online ACH Payme';
  const MOBILE = 'Returned Mobile ACH Payme';
  const CUT_TODAY = '2026-08-05';
  const SUMMER = 'from=2026-05-01&to=2026-07-31';
  /** A month as Spending counts it: the subscription and a bill paid through a "Paym..." merchant. */
  const MONTH_SPENDING = 1_599 + 8_000;

  /**
   * As the converter stores Capital One's rows: each month a payment by each channel and the bank returning it, the
   * returns as purchases with the cut name as both texts and no category. The record is complete from May through
   * the day before today.
   */
  function seedCut() {
    const card = repo.createCardAccount({ issuer: 'capitalone', owner: 'joint', last4: '0002', currency: 'USD' });
    const rows: CardImportRow[] = ['2026-05', '2026-06', '2026-07'].flatMap((month) => [
      row(`${month}-03`, 'Mobile ACH Payment', -150_000, { kind: 'payment', merchant: 'Mobile ACH Payment' }),
      row(`${month}-10`, MOBILE, 150_000, { merchant: MOBILE }),
      row(`${month}-05`, 'Online ACH Payment', -220_000, { kind: 'payment', merchant: 'Online ACH Payment' }),
      row(`${month}-12`, ONLINE, 220_000, { merchant: ONLINE }),
      row(`${month}-15`, 'SAMPLE STREAMING SERVICE', 1_599),
      row(`${month}-20`, 'PAYMENTUS*SAMPLE CITY UTILITY', 8_000),
    ]);
    repo.importCardTransactions({
      cardAccountId: card.id, source: 'test-ofx', parserVersion: 'test@1', rows, coverage: { start: '2026-05-01', end: '2026-08-04' },
    });
    const stored = repo.listCardTransactions();
    return { stored, returnId: stored.find((item) => item.transactionDate === '2026-07-12')!.id };
  }

  it('leave every Spending answer and count against the payments they reverse; stored rows stay purchases', async () => {
    const { stored, returnId } = seedCut();
    const app = buildApp();
    for (const basis of ['enriched', 'original']) {
      const summary = (await get(app, `/spending/summary?${SUMMER}&categoryBasis=${basis}`)).body;
      expect(summary.totals, basis).toEqual([{
        currency: 'USD', spendingMinor: 3 * MONTH_SPENDING, chargesMinor: 3 * MONTH_SPENDING, creditsMinor: 0, count: 6,
        paymentsMinor: 0, paymentCount: 12, otherMinor: 0, otherCount: 0,
      }]);
      expect(returnsAmong(summary.byMerchant), basis).toEqual([]);
    }
    const [book] = (await get(app, `/spending/accounting?${SUMMER}`)).body.accounting;
    expect(book.activity.netMinor).toBe(stored.reduce((sum, item) => sum + item.amountMinor, 0));
    expect(book.transfers).toEqual({ netMinor: 0, chargesMinor: 3 * 370_000, creditsMinor: -3 * 370_000, count: 12 });

    const listed = (await get(app, `/card-transactions?${SUMMER}&limit=200`)).body.transactions as Array<Named & Record<string, unknown>>;
    expect(returnsAmong(listed).map((item) => [item.kind, item.role])).toEqual(Array(6).fill(['payment', 'transfer']));
    const kinds = async (kind: string) => ((await get(app, `/card-transactions?${SUMMER}&kind=${kind}&limit=200`)).body.transactions as Named[])
      .map((item) => item.description);
    expect(returnsAmong((await kinds('payment')).map((description) => ({ description })))).toHaveLength(6);
    expect((await kinds('purchase')).sort()).toEqual([...Array(3).fill('PAYMENTUS*SAMPLE CITY UTILITY'), ...Array(3).fill('SAMPLE STREAMING SERVICE')]);
    const detail = (await get(app, `/card-transactions/${returnId}`)).body.transaction;
    expect([detail.description, detail.kind, detail.role]).toEqual([ONLINE, 'payment', 'transfer']);

    // No recurring charge, insight, comparison, trend, forecast or bill counts them; the "Paym..." merchant stays spending.
    const insights = (await get(app, `/spending/insights?month=2026-07&today=${CUT_TODAY}`)).body;
    expect(returnsAmong(insights.recurring)).toEqual([]);
    expect(insights.recurring.map((charge: Named) => charge.merchant)).toContain('SAMPLE STREAMING SERVICE');
    const compare = (await get(app,
      `/spending/compare?from=2026-07-01&to=2026-07-31&baselineFrom=2026-06-01&baselineTo=2026-06-30&today=${CUT_TODAY}`)).body.comparison;
    expect([compare.current.spendingMinor, compare.baseline.spendingMinor]).toEqual([MONTH_SPENDING, MONTH_SPENDING]);
    expect(returnsAmong([...compare.current.recurring, ...compare.baseline.recurring])).toEqual([]);
    const trend = (await get(app, `/spending/trend?fromMonth=2026-05&toMonth=2026-07&today=${CUT_TODAY}`)).body;
    expect(trend.months.map((month: { spendingMinor: number }) => month.spendingMinor)).toEqual(Array(3).fill(MONTH_SPENDING));
    const forecast = (await get(app, `/spending/forecast?today=${CUT_TODAY}`)).body;
    const forecastMonths = new Map((forecast.months as Array<{ month: string; spendingMinor: number }>).map((month) => [month.month, month.spendingMinor]));
    for (const month of ['2026-05', '2026-06', '2026-07']) expect(forecastMonths.get(month), month).toBe(MONTH_SPENDING);
    expect(returnsAmong((await get(app, `/spending/patterns?today=${CUT_TODAY}`)).body.bills.items)).toEqual([]);

    // Read, never written; the owner's own category still wins, and clearing it reads the row as a payment again.
    expect(repo.listCardTransactions()).toEqual(stored);
    expect(stored.filter((item) => RETURNED.test(item.description)).map((item) => item.kind)).toEqual(Array(6).fill('purchase'));
    const filed = (await patch(app, `/card-transactions/${returnId}`, { userCategory: 'Sample bank charges' })).body;
    expect([filed.kind, filed.role]).toEqual(['purchase', 'spending']);
    const cleared = (await patch(app, `/card-transactions/${returnId}`, { userCategory: null })).body;
    expect([cleared.kind, cleared.role]).toEqual(['payment', 'transfer']);
  });
});
