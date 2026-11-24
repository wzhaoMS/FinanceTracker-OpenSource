import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { exceptCardSpendingPaths, mountCardSpendingRoutes } from './cardSpending.js';
import { createCardTransactionsRouter } from './cardTransactions.js';
import { createCardSpendingRulesRouter } from './cardSpendingRules.js';
import type { CardCategoryResolver } from '@finance-tracker/shared';
import { SqliteStateRepo, type CardImportRow } from '../services/sqliteStateRepo.js';
import { installCardSpendingRulesSchema } from '../services/cardSpendingRules.js';
import { listenLoopback } from '../testing/loopback.js';

// What counts as spending, end to end: owner decisions by category, owner rules, exact refunds, suggestions and the
// accounting. Synthetic data only: fictional descriptors in the shapes issuers use, made-up amounts and last-4s.

const TODAY = '2026-10-16';
let dir: string;
let repo: SqliteStateRepo;
let logs: string[];

const testAuth: RequestHandler = (req, res, next) => {
  if (req.headers['x-test-auth'] === 'ok') {
    req.holdrAuth = { kind: 'session', userId: 'test-owner', username: 'test-owner', sessionId: 'test-session' };
    return next();
  }
  if (req.headers['x-test-auth'] === 'service') {
    req.holdrAuth = { kind: 'service' };
    return next();
  }
  res.status(401).json({ error: 'sign in' });
};

function buildApp(routerOptions: Parameters<typeof createCardTransactionsRouter>[1] = {}): express.Express {
  const server = express();
  server.use(exceptCardSpendingPaths(express.json({ limit: '2mb' })));
  const log = (line: string) => logs.push(line);
  mountCardSpendingRoutes(server, {
    repo, requireAuth: testAuth, log,
    routers: [createCardTransactionsRouter(repo, { log, ...routerOptions }), createCardSpendingRulesRouter(repo, { log })],
  });
  return server;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-what-counts-'));
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

const ONLINE = 'COSTCO.COM *ONLINE SAMPLE WA';
const WHOLESALE = 'Merchandise & Supplies-Wholesale Stores';

function seed() {
  const citi = repo.createCardAccount({ issuer: 'citi', owner: 'alex', last4: '0001', currency: 'USD' });
  const amex = repo.createCardAccount({ issuer: 'amex', owner: 'casey', last4: '0002', currency: 'USD' });
  const euro = repo.createCardAccount({ issuer: 'samplebank', owner: 'joint', last4: '0003', currency: 'EUR' });
  const imp = (id: string, rows: CardImportRow[]) =>
    repo.importCardTransactions({ cardAccountId: id, source: 'test-sync', parserVersion: 'test@1', rows, coverage: { start: '2026-01-01', end: TODAY } });
  imp(citi.id, [
    row({ transactionDate: '2026-03-02', amountMinor: 412_399, description: ONLINE, issuerCategory: WHOLESALE }),
    row({ transactionDate: '2026-03-20', amountMinor: -412_399, kind: 'refund', description: ONLINE, issuerCategory: WHOLESALE }),
    row({ transactionDate: '2026-04-02', amountMinor: 810_001, description: ONLINE, issuerCategory: WHOLESALE }),
    row({ transactionDate: '2026-04-09', amountMinor: -405_000, kind: 'refund', description: ONLINE, issuerCategory: WHOLESALE }),
    row({ transactionDate: '2026-06-01', amountMinor: 600_001, description: 'COSTCO WHSE #0042 SAMPLETOWN WA', issuerCategory: WHOLESALE }),
    row({ transactionDate: '2026-06-03', amountMinor: 8_512, description: 'COSTCO WHSE #0042 SAMPLETOWN WA', issuerCategory: WHOLESALE }),
    row({ transactionDate: '2026-06-04', amountMinor: 6_012, description: 'COSTCO GAS #0042', issuerCategory: 'Transportation-Fuel' }),
    row({ transactionDate: '2026-07-01', amountMinor: 51_230, description: 'APMEX SAMPLE' }),
    row({ transactionDate: '2026-09-05', amountMinor: 8_450, description: 'SAMPLE GROCER', issuerCategory: 'Groceries' }),
    row({ transactionDate: '2026-10-05', amountMinor: 5_300, description: 'SAMPLE GROCER', issuerCategory: 'Groceries' }),
    row({ transactionDate: '2026-09-25', amountMinor: -500_000, kind: 'payment', description: 'AUTOPAY PAYMENT THANK YOU' }),
    row({ transactionDate: '2026-08-15', amountMinor: 20_000, kind: 'other', description: 'CASH ADVANCE' }),
    row({ transactionDate: '2026-10-15', amountMinor: 3_100, status: 'pending', description: 'SAMPLE BISTRO', issuerCategory: 'Dining' }),
  ]);
  imp(amex.id, [
    row({ transactionDate: '2026-05-10', amountMinor: 250_099, description: 'WALMART.COM 800-555-0100 AR', issuerCategory: 'Merchandise & Supplies-Internet Purchase' }),
    row({ transactionDate: '2026-05-12', amountMinor: 4_200, description: 'WAL-MART #0042', issuerCategory: 'Groceries' }),
    row({ transactionDate: '2026-09-21', amountMinor: 12_650, description: 'SAMPLE BISTRO', issuerCategory: 'Dining' }),
  ]);
  imp(euro.id, [
    row({ transactionDate: '2026-09-05', amountMinor: 1_240, currency: 'EUR', description: 'SAMPLE BOULANGERIE', issuerCategory: 'Dining' }),
  ]);
  const all = repo.listCardTransactionsMatching({ statuses: ['pending', 'posted', 'removed'] });
  const find = (description: string, transactionDate: string) => all.find((item) => item.description === description && item.transactionDate === transactionDate)!;
  return { citi, amex, euro, find };
}

const get = async (app: express.Express, url: string) => request(await listenLoopback(app)).get(url).set('x-test-auth', 'ok');
const send = async (app: express.Express, method: 'patch' | 'post' | 'delete', url: string, body?: unknown, auth = 'ok') => {
  const call = request(await listenLoopback(app))[method](url).set('x-test-auth', auth);
  return body === undefined ? call : call.set('content-type', 'application/json').send(JSON.stringify(body));
};

type Amounts = { netMinor: number; chargesMinor: number; creditsMinor: number; count: number };
type Accounting = {
  currency: string; activity: Amounts; spending: Amounts; transfers: Amounts; pending: { count: number; netMinor: number };
  notSpending: Amounts & { assetPurchases: Amounts; other: Amounts }; possibleAssetPurchases: Amounts;
};

/** Every part adds up, and spending is the summary's, for the same filters. */
async function expectReconciled(app: express.Express, query = '') {
  const accounting = (await get(app, `/spending/accounting${query}`)).body.accounting as Accounting[];
  const summary = (await get(app, `/spending/summary${query}`)).body as { totals: Array<Record<string, number | string>>; byCategory: Array<{ currency: string; spendingMinor: number }> };
  for (const entry of accounting) {
    for (const field of ['netMinor', 'chargesMinor', 'creditsMinor', 'count'] as const) {
      expect(entry.activity[field], `${query} ${entry.currency} ${field}`).toBe(entry.spending[field] + entry.notSpending[field] + entry.transfers[field]);
      expect(entry.notSpending[field]).toBe(entry.notSpending.assetPurchases[field] + entry.notSpending.other[field]);
    }
    const total = summary.totals.find((item) => item.currency === entry.currency);
    if (!total) {
      // A currency with pending rows only: nothing posted to count.
      expect(entry.activity.count, `${query} ${entry.currency}`).toBe(0);
      continue;
    }
    expect([total.spendingMinor, total.chargesMinor, total.creditsMinor, total.count])
      .toEqual([entry.spending.netMinor, entry.spending.chargesMinor, entry.spending.creditsMinor, entry.spending.count]);
    expect(total.paymentsMinor).toBe(entry.transfers.netMinor);
    expect(total.otherMinor).toBe(entry.notSpending.other.netMinor);
    expect(total.assetPurchasesMinor ?? 0).toBe(entry.notSpending.assetPurchases.netMinor);
    expect(summary.byCategory.filter((item) => item.currency === entry.currency).reduce((sum, item) => sum + item.spendingMinor, 0))
      .toBe(entry.spending.netMinor);
  }
  return accounting;
}

describe('what counts as spending', () => {
  it('suggests, and changes no total until the owner decides', async () => {
    const { find } = seed();
    const app = buildApp();
    const before = (await get(app, '/spending/summary')).body;
    const body = (await get(app, '/spending/accounting')).body;
    expect(body.rules).toEqual({ installed: false, items: [] });
    expect(body.assetPurchases).toEqual([]);
    expect(body.suggestions.map((item: Record<string, unknown>) => [item.id, item.kind, item.tier, item.amountMinor, item.effectMinor])).toEqual([
      [find('APMEX SAMPLE', '2026-07-01').id, 'purchase', 'likely', 51_230, 51_230],
      [find(ONLINE, '2026-04-02').id, 'purchase', 'possible', 810_001, 810_001],
      [find(ONLINE, '2026-04-09').id, 'refund', 'possible', -405_000, -405_000],
      [find('WALMART.COM 800-555-0100 AR', '2026-05-10').id, 'purchase', 'possible', 250_099, 250_099],
      [find(ONLINE, '2026-03-02').id, 'purchase', 'possible', 412_399, 0],
      [find('COSTCO WHSE #0042 SAMPLETOWN WA', '2026-06-01').id, 'purchase', 'weak', 600_001, 600_001],
    ]);
    const exact = body.suggestions.find((item: Record<string, unknown>) => item.id === find(ONLINE, '2026-03-02').id);
    expect(exact).toMatchObject({ followingRefundIds: [find(ONLINE, '2026-03-20').id], category: WHOLESALE, merchantName: ONLINE });
    const usd = (await expectReconciled(app)).find((item) => item.currency === 'USD')!;
    // What confirming every suggestion shown would take out: every suggested row and the exact refund that follows.
    expect(usd.possibleAssetPurchases).toEqual({
      netMinor: 51_230 + 810_001 + 412_399 - 412_399 + 250_099 - 405_000 + 600_001,
      chargesMinor: 51_230 + 810_001 + 412_399 + 250_099 + 600_001,
      creditsMinor: -412_399 - 405_000,
      count: 7,
    });
    // Nothing moved: the summary is as before, with no asset fields, and no row is excluded.
    expect((await get(app, '/spending/summary')).body).toEqual(before);
    expect(JSON.stringify(before)).not.toContain('assetPurchase');
    const listed = (await get(app, '/card-transactions?limit=200')).body.transactions as Array<Record<string, unknown>>;
    expect(listed.some((item) => 'exclusion' in item)).toBe(false);
    // A view counts only its own suggestions: the exact refund of a suggested purchase outside it waits for nothing here.
    const march = (await get(app, '/spending/accounting?from=2026-03-10&to=2026-03-31')).body;
    expect(march.suggestions).toEqual([]);
    expect(march.accounting.find((item: Accounting) => item.currency === 'USD').possibleAssetPurchases)
      .toEqual({ netMinor: 0, chargesMinor: 0, creditsMinor: 0, count: 0 });
    await expectReconciled(app, '?from=2026-03-10&to=2026-03-31');
  });

  it('takes a confirmed purchase and its exact refund out of every spending figure, and the owner can say it is not metals', async () => {
    const { find } = seed();
    const app = buildApp();
    const purchase = find(ONLINE, '2026-03-02');
    const refund = find(ONLINE, '2026-03-20');
    const before = (await get(app, '/spending/summary')).body;

    const patched = await send(app, 'patch', `/card-transactions/${purchase.id}`, { userCategory: 'Precious metals' });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ role: 'excluded', exclusion: { reason: 'asset-purchase', source: 'owner-category' } });

    const after = (await get(app, '/spending/summary')).body;
    const usd = (body: { totals: Array<Record<string, number | string>> }) => body.totals.find((item) => item.currency === 'USD')!;
    // The purchase and its refund net to zero, so spending is the same; both now count as asset purchases.
    expect(usd(after).spendingMinor).toBe(usd(before).spendingMinor);
    expect(usd(after).chargesMinor).toBe(Number(usd(before).chargesMinor) - 412_399);
    expect(usd(after).creditsMinor).toBe(Number(usd(before).creditsMinor) + 412_399);
    expect(usd(after).count).toBe(Number(usd(before).count) - 2);
    expect([usd(after).assetPurchasesMinor, usd(after).assetPurchaseCount]).toEqual([0, 2]);
    const detail = (await get(app, `/card-transactions/${refund.id}`)).body.transaction;
    expect(detail).toMatchObject({ role: 'excluded', exclusion: { reason: 'asset-purchase', source: 'paired-refund', purchaseId: purchase.id } });
    const accounting = await expectReconciled(app);
    expect(accounting.find((item) => item.currency === 'USD')!.notSpending.assetPurchases).toEqual({
      netMinor: 0, chargesMinor: 412_399, creditsMinor: -412_399, count: 2,
    });
    const body = (await get(app, '/spending/accounting')).body;
    expect(body.assetPurchases.map((item: Record<string, unknown>) => [item.id, (item.exclusion as Record<string, unknown>).source, item.spendingCategory]))
      .toEqual([[refund.id, 'paired-refund', WHOLESALE], [purchase.id, 'owner-category', WHOLESALE]]);
    expect(body.suggestions.some((item: Record<string, unknown>) => item.id === purchase.id || item.id === refund.id)).toBe(false);

    // A larger confirmed purchase moves spending by its amount; insights no longer read it.
    const big = find(ONLINE, '2026-04-02');
    await send(app, 'patch', `/card-transactions/${big.id}`, { userCategory: 'precious metals' });
    const third = (await get(app, '/spending/summary')).body;
    expect(usd(third).spendingMinor).toBe(Number(usd(before).spendingMinor) - 810_001);
    await expectReconciled(app);
    const insights = (await get(app, `/spending/insights?from=2026-04-01&to=2026-04-30&today=${TODAY}`)).body;
    expect(insights.spendingMinor).toBe(-405_000);
    expect(insights.largePurchases).toBeNull();
    // The partial refund is the owner's to decide: still a spending credit, and asked about.
    const partial = find(ONLINE, '2026-04-09');
    const asked = (await get(app, '/spending/accounting')).body.suggestions.find((item: Record<string, unknown>) => item.id === partial.id);
    expect(asked).toMatchObject({ kind: 'refund', signals: ['refund-of-excluded', 'partial-refund'], purchaseIds: [big.id] });

    // Not metals: the owner's own category keeps it spending, and the suggestion goes away.
    const walmart = find('WALMART.COM 800-555-0100 AR', '2026-05-10');
    const kept = await send(app, 'patch', `/card-transactions/${walmart.id}`, { userCategory: 'Merchandise & Supplies-Internet Purchase' });
    expect(kept.body.role).toBe('spending');
    expect(kept.body).not.toHaveProperty('exclusion');
    expect((await get(app, '/spending/accounting')).body.suggestions.some((item: Record<string, unknown>) => item.id === walmart.id)).toBe(false);
    expect(usd((await get(app, '/spending/summary')).body).spendingMinor).toBe(usd(third).spendingMinor);
  });

  it('reconciles under every filter, on either basis', async () => {
    const { find, citi } = seed();
    const app = buildApp();
    await send(app, 'patch', `/card-transactions/${find(ONLINE, '2026-04-02').id}`, { userCategory: 'Precious metals' });
    for (const query of ['', '?categoryBasis=original', '?from=2026-04-01&to=2026-04-30', `?cardAccountId=${citi.id}`, '?owner=casey',
      `?category=${encodeURIComponent(WHOLESALE)}`, '?category=Precious%20metals', '?q=costco', `?merchant=${encodeURIComponent('COSTCO.COM')}`]) {
      await expectReconciled(app, query);
    }
    const euro = (await get(app, '/spending/accounting')).body.accounting.find((item: Accounting) => item.currency === 'EUR');
    expect(euro.spending).toEqual({ netMinor: 1_240, chargesMinor: 1_240, creditsMinor: 0, count: 1 });
  });

  it('pairs a refund only from the same seller and only with what remains, and every part still adds up', async () => {
    seed();
    const card = repo.createCardAccount({ issuer: 'chase', owner: 'alex', last4: '0004', currency: 'USD' });
    repo.importCardTransactions({ cardAccountId: card.id, source: 'test-sync', parserVersion: 'test@1', coverage: { start: '2026-09-01', end: '2026-09-30' }, rows: [
      row({ transactionDate: '2026-09-01', amountMinor: 210_123, description: 'APMEX SAMPLE' }),
      row({ transactionDate: '2026-09-20', amountMinor: -210_123, kind: 'refund', description: 'JM BULLION SAMPLE' }),
      row({ transactionDate: '2026-09-02', amountMinor: 210_123, description: ONLINE, issuerCategory: WHOLESALE }),
      row({ transactionDate: '2026-09-10', amountMinor: -50_000, kind: 'refund', description: ONLINE, issuerCategory: WHOLESALE }),
      row({ transactionDate: '2026-09-21', amountMinor: -210_123, kind: 'refund', description: ONLINE, issuerCategory: WHOLESALE }),
    ] });
    const rows = repo.listCardTransactionsMatching({ cardAccountId: card.id });
    const find = (description: string, amountMinor: number) => rows.find((item) => item.description === description && item.amountMinor === amountMinor)!;
    const app = buildApp();
    for (const id of [find('APMEX SAMPLE', 210_123).id, find(ONLINE, 210_123).id, find(ONLINE, -50_000).id]) {
      expect((await send(app, 'patch', `/card-transactions/${id}`, { userCategory: 'Precious metals' })).status).toBe(200);
    }
    // Another dealer's credit and a credit of the original amount after the owner's partial refund both stay spending.
    for (const id of [find('JM BULLION SAMPLE', -210_123).id, find(ONLINE, -210_123).id]) {
      const detail = (await get(app, `/card-transactions/${id}`)).body.transaction;
      expect(detail.role).toBe('spending');
      expect(detail).not.toHaveProperty('exclusion');
    }
    const body = (await get(app, `/spending/accounting?cardAccountId=${card.id}`)).body;
    const usd = body.accounting.find((item: Accounting) => item.currency === 'USD');
    expect(usd.notSpending.assetPurchases).toEqual({ netMinor: 210_123 + 210_123 - 50_000, chargesMinor: 420_246, creditsMinor: -50_000, count: 3 });
    expect(usd.spending).toEqual({ netMinor: -420_246, chargesMinor: 0, creditsMinor: -420_246, count: 2 });
    expect(body.suggestions.map((item: Record<string, unknown>) => [item.id, item.signals])).toEqual([
      [find(ONLINE, -210_123).id, ['refund-of-excluded', 'after-earlier-refund']],
    ]);
    await expectReconciled(app, `?cardAccountId=${card.id}`);
    await expectReconciled(app);
  });
});

describe('the summary\'s category-basis marker', () => {
  it('counts no asset purchase: an itemized charge filed as precious metals leaves every marker count', async () => {
    const { find } = seed();
    const charge = find('SAMPLE GROCER', '2026-09-05');
    const resolver: CardCategoryResolver = {
      snapshot: () => ({
        version: 'rev-1',
        resolve: (rows) => new Map(rows.filter((item) => item.id === charge.id).map((item) => [item.id, {
          kind: 'split' as const, cardTransactionId: item.id, currency: 'USD', evidenceClass: 'payment-event' as const,
          contributions: [
            { amountMinor: 5_000, category: 'Groceries', categorySource: 'reviewed-mapping' as const, classification: 'source' as const, itemRef: 'item-1' },
            { amountMinor: 3_450, category: null, categorySource: null, classification: 'residual' as const },
          ],
        }])),
      }),
    };
    const app = buildApp({ categoryResolver: resolver });
    const before = (await get(app, '/spending/summary')).body;
    expect(before.categoryBasis).toMatchObject({ splitRows: 1, keptWholeByUserCategory: 0 });
    expect(before.categoryBasis.rowsBySource.amazon).toBe(1);
    await send(app, 'patch', `/card-transactions/${charge.id}`, { userCategory: 'Precious metals' });
    const after = (await get(app, '/spending/summary')).body;
    expect(after.categoryBasis).toMatchObject({ splitRows: 0, keptWholeByUserCategory: 0, heldOrDeclined: [], invalid: [] });
    expect(after.categoryBasis.rowsBySource).toMatchObject({ user: 0, amazon: 0 });
    expect(after.fromAmazonItems).toEqual([]);
    // Filtered to the asset's own category, the marker counts nothing either.
    expect((await get(app, '/spending/summary?category=Precious%20metals')).body.categoryBasis)
      .toMatchObject({ splitRows: 0, keptWholeByUserCategory: 0 });
    // The list still shows the row, with its own marker semantics: what the page lists.
    const listed = (await get(app, '/card-transactions?q=grocer')).body;
    expect(listed.transactions.find((item: Record<string, unknown>) => item.id === charge.id)).toMatchObject({ role: 'excluded' });
  });
});

describe('owner rules', () => {
  const rule = { merchantClass: 'costco-online', currency: 'USD', minAmountMinor: 100_000 };
  const previewOf = async (app: express.Express, fields: { merchantClass: string; currency: string; minAmountMinor: number } = rule) =>
    (await get(app, `/spending/rules/preview?merchantClass=${fields.merchantClass}&currency=${fields.currency}&minAmountMinor=${fields.minAmountMinor}`)).body.preview;
  /** The rule's fields with the match of a preview the owner just saw. */
  const seen = async (app: express.Express, fields = rule) => ({ ...fields, preview: (await previewOf(app, fields)).match });

  it('previews without the table, and refuses a change until it is installed', async () => {
    seed();
    const app = buildApp();
    const preview = await get(app, '/spending/rules/preview?merchantClass=costco-online&currency=USD&minAmountMinor=100000');
    expect(preview.status).toBe(200);
    expect(preview.body.preview).toEqual({
      purchases: 2, refunds: 1,
      amounts: { netMinor: 810_001, chargesMinor: 412_399 + 810_001, creditsMinor: -412_399, count: 3 },
      firstDate: '2026-03-02', lastDate: '2026-04-02', ownerDecided: 0, alreadyExcluded: 0,
      match: { count: 3, netMinor: 810_001, digest: expect.stringMatching(/^srp1:[a-p]{64}$/) },
    });
    // Validation before the table: a rule without its preview is refused as such.
    expect((await send(app, 'post', '/spending/rules', rule)).status).toBe(400);
    const created = await send(app, 'post', '/spending/rules', { ...rule, preview: preview.body.preview.match });
    expect(created.status).toBe(409);
    expect(created.body).toEqual({ error: 'owner spending rules are not installed on this Holdr' });
    expect((await send(app, 'delete', `/spending/rules/csr_${'a'.repeat(32)}`)).status).toBe(409);
  });

  it('applies a rule to past and future purchases without an owner category, and revoking it puts them back', async () => {
    const { find } = seed();
    installCardSpendingRulesSchema(repo.internalGetDb());
    const app = buildApp();
    const before = (await get(app, '/spending/summary')).body;
    // The owner already kept one covered purchase as spending: the rule leaves it.
    const kept = find(ONLINE, '2026-03-02');
    await send(app, 'patch', `/card-transactions/${kept.id}`, { userCategory: WHOLESALE });

    const created = await send(app, 'post', '/spending/rules', await seen(app));
    expect(created.status).toBe(201);
    expect(created.body.rule).toMatchObject({ ...rule, reason: 'asset-purchase', category: 'Precious metals', revokedAt: null });
    const id = created.body.rule.id as string;
    // The same rule again, as its own preview shows it now: the store refuses a rule like one in force.
    expect((await send(app, 'post', '/spending/rules', await seen(app))).status).toBe(400);

    const big = find(ONLINE, '2026-04-02');
    expect((await get(app, `/card-transactions/${big.id}`)).body.transaction).toMatchObject({
      role: 'excluded', exclusion: { reason: 'asset-purchase', source: 'owner-rule', ruleId: id },
    });
    expect((await get(app, `/card-transactions/${kept.id}`)).body.transaction.role).toBe('spending');
    const body = (await get(app, '/spending/accounting')).body;
    expect(body.rules).toEqual({ installed: true, items: [{ ...created.body.rule, covers: { purchases: 1, refunds: 0, netMinor: 810_001 } }] });
    await expectReconciled(app);
    const usd = (summary: { totals: Array<Record<string, number | string>> }) => summary.totals.find((item) => item.currency === 'USD')!;
    expect(usd((await get(app, '/spending/summary')).body).spendingMinor).toBe(Number(usd(before).spendingMinor) - 810_001);

    // A future covered purchase is out the moment it is imported.
    const citi = repo.listCardAccounts().find((account) => account.issuer === 'citi')!;
    repo.importCardTransactions({ cardAccountId: citi.id, source: 'test-sync', parserVersion: 'test@1',
      rows: [row({ transactionDate: '2026-10-12', amountMinor: 420_123, description: ONLINE, issuerCategory: WHOLESALE })],
      coverage: { start: '2026-10-12', end: '2026-10-12' } });
    expect((await get(app, '/spending/accounting')).body.rules.items[0].covers).toEqual({ purchases: 2, refunds: 0, netMinor: 810_001 + 420_123 });

    const revoked = await send(app, 'delete', `/spending/rules/${id}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.rule.revokedAt).toBe('2026-10-16T12:00:00.000Z');
    expect((await get(app, `/card-transactions/${big.id}`)).body.transaction.role).toBe('spending');
    expect((await send(app, 'delete', `/spending/rules/csr_${'b'.repeat(32)}`)).status).toBe(404);
    await expectReconciled(app);
  });

  it('makes only the rule the owner saw: a preview of other fields, or of rows that changed since, is a 409 preview-stale', async () => {
    seed();
    installCardSpendingRulesSchema(repo.internalGetDb());
    const app = buildApp();
    const stale = { error: 'this rule would now take out other charges than its preview showed; preview it again', reason: 'preview-stale' };
    const shown = (await previewOf(app)).match;
    // The match is bound to the rule's fields: another minimum, even one taking out the same rows, is not what was seen.
    for (const fields of [{ ...rule, minAmountMinor: 100_001 }, { ...rule, minAmountMinor: 600_000 }, { ...rule, merchantClass: 'costco-warehouse' }]) {
      const answer = await send(app, 'post', '/spending/rules', { ...fields, preview: shown });
      expect(answer.status, JSON.stringify(fields)).toBe(409);
      expect(answer.body).toEqual(stale);
    }
    // Any part of the match that differs from what the rule takes out now.
    for (const preview of [{ ...shown, count: shown.count + 1 }, { ...shown, netMinor: shown.netMinor - 1 }, { ...shown, digest: `srp1:${'a'.repeat(64)}` }]) {
      expect((await send(app, 'post', '/spending/rules', { ...rule, preview })).body).toEqual(stale);
    }
    // A covered purchase imported after the preview: the rule would take out more than the owner saw.
    const citi = repo.listCardAccounts().find((account) => account.issuer === 'citi')!;
    repo.importCardTransactions({ cardAccountId: citi.id, source: 'test-sync', parserVersion: 'test@1',
      rows: [row({ transactionDate: '2026-10-12', amountMinor: 420_123, description: ONLINE, issuerCategory: WHOLESALE })],
      coverage: { start: '2026-10-12', end: '2026-10-12' } });
    const afterImport = await send(app, 'post', '/spending/rules', { ...rule, preview: shown });
    expect(afterImport.status).toBe(409);
    expect(afterImport.body).toEqual(stale);
    // Nothing was written by any refusal.
    expect((await get(app, '/spending/accounting')).body.rules.items).toEqual([]);
    // Previewed again, it is the rule the owner saw, and it is made.
    const again = await previewOf(app);
    expect(again.match).toMatchObject({ count: 4, netMinor: 810_001 + 420_123 });
    expect(again.match.digest).not.toBe(shown.digest);
    expect((await send(app, 'post', '/spending/rules', { ...rule, preview: again.match })).status).toBe(201);
  });

  it('lets only a signed-in owner change rules, and refuses bad input without echoing it', async () => {
    seed();
    installCardSpendingRulesSchema(repo.internalGetDb());
    const app = buildApp();
    const match = (await previewOf(app)).match;
    expect((await send(app, 'post', '/spending/rules', { ...rule, preview: match }, 'service')).status).toBe(403);
    for (const body of [
      { ...rule, merchantClass: 'walmart-store', preview: match },
      { ...rule, currency: 'usd', preview: match },
      { ...rule, minAmountMinor: 0, preview: match },
      { ...rule, minAmountMinor: 12.5, preview: match },
      { ...rule, preview: match, extra: true },
      [rule],
      rule,
      { ...rule, preview: null },
      { ...rule, preview: { ...match, extra: 1 } },
      { ...rule, preview: { count: match.count, netMinor: match.netMinor } },
      { ...rule, preview: { ...match, count: -1 } },
      { ...rule, preview: { ...match, netMinor: 1.5 } },
      { ...rule, preview: { ...match, digest: 'srp1:walmart-store' } },
    ]) {
      const answer = await send(app, 'post', '/spending/rules', body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(JSON.stringify(answer.body)).not.toContain('walmart-store');
    }
    const card = await send(app, 'post', '/spending/rules', { ...rule, currency: '4111111111111111', preview: match });
    expect(card.status).toBe(422);
    expect(JSON.stringify(card.body)).not.toContain('4111');
    expect((await get(app, '/spending/rules/preview?merchantClass=costco-online&currency=USD')).status).toBe(400);
    expect((await get(app, '/spending/rules/preview?merchantClass=costco-online&currency=USD&minAmountMinor=100&extra=1')).status).toBe(400);
    expect((await send(app, 'delete', '/spending/rules/not-a-rule')).status).toBe(404);
    expect((await get(app, '/spending/accounting')).body.rules.items).toEqual([]);
  });
});
