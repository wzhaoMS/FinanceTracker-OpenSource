import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { exceptCardSpendingPaths, mountCardSpendingRoutes } from './cardSpending.js';
import { createCardTransactionsRouter } from './cardTransactions.js';
import { createCardSpendingRulesRouter } from './cardSpendingRules.js';
import { SqliteStateRepo, type CardImportRow } from '../services/sqliteStateRepo.js';
import { installCardSpendingRulesSchema } from '../services/cardSpendingRules.js';
import { cardSyncActorRef } from '../services/cardSyncDigests.js';
import { listenLoopback } from '../testing/loopback.js';

// The fast path: while no card row can be an asset purchase (no owner "Precious metals" category on any row, no owner
// rule in force), Spending's answers skip the exclusion pass, and the household read it needs, so they are the answers
// from before asset purchases by construction. The exclusion pass is counted through the shared module (its one export
// wrapped); everything else is the real code. Synthetic data only: fictional descriptors, made-up amounts.

const passes = vi.hoisted(() => ({ resolve: 0 }));
vi.mock('@finance-tracker/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@finance-tracker/shared')>();
  return {
    ...actual,
    resolveCardSpendingExclusions: (...args: Parameters<typeof actual.resolveCardSpendingExclusions>) => {
      passes.resolve += 1;
      return actual.resolveCardSpendingExclusions(...args);
    },
  };
});

const TODAY = '2026-10-16';
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
    repo, requireAuth: testAuth, log, routers: [createCardTransactionsRouter(repo, { log }), createCardSpendingRulesRouter(repo, { log })],
  });
  return server;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-fast-path-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db'), now: () => new Date('2026-10-16T12:00:00.000Z') });
  logs = [];
  passes.resolve = 0;
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

/** Two cards, a few months of every kind, a large Costco.com order (a suggestion, never a decision), no asset purchase. */
function seed() {
  const citi = repo.createCardAccount({ issuer: 'citi', owner: 'alex', last4: '0001', currency: 'USD' });
  const amex = repo.createCardAccount({ issuer: 'amex', owner: 'casey', last4: '0002', currency: 'USD' });
  const imp = (id: string, rows: CardImportRow[]) =>
    repo.importCardTransactions({ cardAccountId: id, source: 'test-sync', parserVersion: 'test@1', rows, coverage: { start: '2026-06-01', end: TODAY } });
  imp(citi.id, [
    row({ transactionDate: '2026-07-02', amountMinor: 412_399, description: 'COSTCO.COM *ONLINE SAMPLE WA', issuerCategory: 'Merchandise & Supplies-Wholesale Stores' }),
    row({ transactionDate: '2026-07-12', amountMinor: -412_399, kind: 'refund', description: 'COSTCO.COM *ONLINE SAMPLE WA', issuerCategory: 'Merchandise & Supplies-Wholesale Stores' }),
    row({ transactionDate: '2026-08-05', amountMinor: 8_450, description: 'SAMPLE GROCER', issuerCategory: 'Groceries' }),
    row({ transactionDate: '2026-09-05', amountMinor: 9_120, description: 'SAMPLE GROCER', issuerCategory: 'Groceries' }),
    row({ transactionDate: '2026-10-05', amountMinor: 5_300, description: 'SAMPLE GROCER', issuerCategory: 'Groceries' }),
    row({ transactionDate: '2026-09-25', amountMinor: -150_000, kind: 'payment', description: 'AUTOPAY PAYMENT THANK YOU' }),
    row({ transactionDate: '2026-10-01', amountMinor: 1_234, kind: 'interest', description: 'INTEREST CHARGE' }),
    row({ transactionDate: '2026-10-15', amountMinor: 3_100, status: 'pending', description: 'SAMPLE BISTRO', issuerCategory: 'Dining' }),
  ]);
  imp(amex.id, [
    row({ transactionDate: '2026-08-21', amountMinor: 12_650, description: 'SAMPLE BISTRO', issuerCategory: 'Dining' }),
    row({ transactionDate: '2026-09-21', amountMinor: 4_200, description: 'SAMPLE BISTRO', issuerCategory: 'Dining' }),
    row({ transactionDate: '2026-10-09', amountMinor: 189_900, description: 'SAMPLE TV STORE', issuerCategory: 'Electronics' }),
    row({ transactionDate: '2026-08-15', amountMinor: 20_000, kind: 'other', description: 'CASH ADVANCE' }),
  ]);
  const all = repo.listCardTransactionsMatching({ statuses: ['pending', 'posted'] });
  const find = (description: string, transactionDate: string) => all.find((item) => item.description === description && item.transactionDate === transactionDate)!;
  // The owner's own category on one row, not the asset one.
  repo.updateCardTransaction(find('SAMPLE GROCER', '2026-09-05').id, { userCategory: 'Household' }, { actorRef: cardSyncActorRef('test-owner') });
  return { citi, amex, find };
}

const get = async (app: express.Express, url: string) => request(await listenLoopback(app)).get(url).set('x-test-auth', 'ok');
const send = async (app: express.Express, method: 'patch' | 'post' | 'delete', url: string, body?: unknown) => {
  const call = request(await listenLoopback(app))[method](url).set('x-test-auth', 'ok');
  return body === undefined ? call : call.set('content-type', 'application/json').send(JSON.stringify(body));
};

/** The answers a client reads; per URL, how many rows its own read asks for on the original basis (none for the list). */
function urls(ids: { tv: string; grocer: string }): Array<[url: string, originalReads: number | null]> {
  return [
    ['/card-transactions?categoryBasis=original', 0],
    ['/card-transactions?categoryBasis=original&q=sample&sort=amount-desc&limit=3', 0],
    ['/card-transactions', null],
    ['/card-transactions?category=Groceries', null],
    [`/card-transactions/${ids.tv}?categoryBasis=original`, 0],
    [`/card-transactions/${ids.grocer}`, null],
    ['/spending/summary?categoryBasis=original', 1],
    ['/spending/summary?categoryBasis=original&owner=alex&from=2026-08-01&to=2026-10-31', 1],
    ['/spending/summary', null],
    ['/spending/summary?category=Dining', null],
    [`/spending/insights?categoryBasis=original&today=${TODAY}`, 1],
    [`/spending/insights?today=${TODAY}&month=2026-09`, null],
  ];
}

describe('the fast path while no row can be an asset purchase', () => {
  it('skips the exclusion pass and its household read, and answers byte for byte as the exclusion pass does', async () => {
    const { find } = seed();
    const app = buildApp();
    const ids = { tv: find('SAMPLE TV STORE', '2026-10-09').id, grocer: find('SAMPLE GROCER', '2026-09-05').id };
    expect(repo.cardSpendingAssetsPossible()).toBe(false);
    const reads = vi.spyOn(repo, 'listCardTransactionsMatching');
    const fast = new Map<string, string>();
    for (const [url, originalReads] of urls(ids)) {
      passes.resolve = 0;
      reads.mockClear();
      const answer = await get(app, url);
      expect(answer.status, url).toBe(200);
      expect(passes.resolve, url).toBe(0);
      // On the original basis, only the answer's own read, as before asset purchases: no household read.
      if (originalReads !== null) expect(reads.mock.calls.length, url).toBe(originalReads);
      fast.set(url, answer.text);
    }
    // The exclusion pass forced: it finds nothing, and every answer is the same, byte for byte.
    vi.spyOn(repo, 'cardSpendingAssetsPossible').mockReturnValue(true);
    for (const [url, originalReads] of urls(ids)) {
      passes.resolve = 0;
      reads.mockClear();
      const answer = await get(app, url);
      expect(passes.resolve, url).toBe(1);
      if (originalReads !== null) expect(reads.mock.calls.length, url).toBe(originalReads + 1);
      expect(answer.text, url).toBe(fast.get(url));
    }
  });

  it('takes the exclusion pass as soon as a row can be an asset purchase, and skips it again once none can', async () => {
    const { find } = seed();
    const app = buildApp();
    const tv = find('SAMPLE TV STORE', '2026-10-09');
    passes.resolve = 0;
    const notes = await send(app, 'patch', `/card-transactions/${tv.id}`, { notes: 'kept' });
    expect([notes.status, notes.body.role, passes.resolve]).toEqual([200, 'spending', 0]);

    // The owner's word makes the row an asset purchase: the PATCH answer already reads it so.
    const metals = await send(app, 'patch', `/card-transactions/${tv.id}`, { userCategory: 'precious metal' });
    expect(metals.status).toBe(200);
    expect(metals.body).toMatchObject({ role: 'excluded', exclusion: { reason: 'asset-purchase', source: 'owner-category' } });
    expect(passes.resolve).toBe(1);
    passes.resolve = 0;
    const listed = (await get(app, '/card-transactions?categoryBasis=original')).body.transactions as Array<Record<string, unknown>>;
    expect(listed.find((item) => item.id === tv.id)).toMatchObject({ role: 'excluded' });
    expect(passes.resolve).toBe(1);

    // Back to spending: nothing can be an asset purchase again, and the answers skip the pass again.
    passes.resolve = 0;
    const back = await send(app, 'patch', `/card-transactions/${tv.id}`, { userCategory: 'Electronics' });
    expect([back.status, back.body.role, back.body.exclusion, passes.resolve]).toEqual([200, 'spending', undefined, 0]);
    expect((await get(app, '/spending/summary?categoryBasis=original')).status).toBe(200);
    expect(passes.resolve).toBe(0);
  });

  it('knows when a row can be an asset purchase: the owner\'s category in any spelling and status, or a rule in force', async () => {
    const { find } = seed();
    const app = buildApp();
    const tv = find('SAMPLE TV STORE', '2026-10-09');
    expect(repo.cardSpendingAssetsPossible()).toBe(false);
    for (const spelling of ['Precious metals', 'PRECIOUS-METALS', 'précious metal']) {
      expect((await send(app, 'patch', `/card-transactions/${tv.id}`, { userCategory: spelling })).status).toBe(200);
      expect(repo.cardSpendingAssetsPossible(), spelling).toBe(true);
    }
    expect((await send(app, 'patch', `/card-transactions/${tv.id}`, { userCategory: null })).status).toBe(200);
    expect(repo.cardSpendingAssetsPossible()).toBe(false);
    // A dismissed row is still shown as the owner filed it, so it still takes the pass.
    const pending = find('SAMPLE BISTRO', '2026-10-15');
    expect((await send(app, 'patch', `/card-transactions/${pending.id}`, { userCategory: 'Precious metals' })).status).toBe(200);
    expect((await send(app, 'patch', `/card-transactions/${pending.id}`, { status: 'removed' })).status).toBe(200);
    expect(repo.cardSpendingAssetsPossible()).toBe(true);
    expect((await send(app, 'patch', `/card-transactions/${pending.id}`, { userCategory: null })).status).toBe(200);
    expect(repo.cardSpendingAssetsPossible()).toBe(false);

    // Rules: none while the table is absent or empty; one in force; none once it is revoked.
    installCardSpendingRulesSchema(repo.internalGetDb());
    expect(repo.cardSpendingAssetsPossible()).toBe(false);
    const fields = { merchantClass: 'costco-online', currency: 'USD', minAmountMinor: 100_000 };
    const preview = (await get(app, '/spending/rules/preview?merchantClass=costco-online&currency=USD&minAmountMinor=100000')).body.preview;
    const created = await send(app, 'post', '/spending/rules', { ...fields, preview: preview.match });
    expect(created.status).toBe(201);
    expect(repo.cardSpendingAssetsPossible()).toBe(true);
    expect((await send(app, 'delete', `/spending/rules/${created.body.rule.id}`)).status).toBe(200);
    expect(repo.cardSpendingAssetsPossible()).toBe(false);
  });
});
