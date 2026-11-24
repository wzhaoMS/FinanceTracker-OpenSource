import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildCardImportPayload,
  cardExternalIdHash,
  luhnValid,
  serializeCardImportPayload,
  type CardImportDraftRow,
  type CashEventInput,
} from '@finance-tracker/shared';
import { exceptCardSpendingPaths, mountCardSpendingRoutes } from './cardSpending.js';
import { createCardTransactionsRouter } from './cardTransactions.js';
import { createResourceRouter } from './resources.js';
import { createCashEventsRouter } from './cashEvents.js';
import { createPortfolioRouter } from './portfolio.js';
import type { PriceBar } from '../providers/historyTypes.js';
import { SqliteStateRepo, type CardImportRow } from '../services/sqliteStateRepo.js';
import { createHistoryRepo } from '../services/symbolHistory.js';
import { cardSyncActorRef } from '../services/cardSyncDigests.js';
import { HoldrDbError, HoldrGuardRefusal } from '../services/dbErrors.js';
import { listenLoopback } from '../testing/loopback.js';

// The Spending tab's routes. Every fixture is synthetic: fictional merchants,
// made-up amounts and last-4s; card numbers are generated at run time.

let dir: string;
let repo: SqliteStateRepo;
let app: express.Express;
let logs: string[];
/** The signed-in owner who edits rows in these tests (the stand-in sign-in below signs them in). */
const OWNER = { actorRef: cardSyncActorRef('test-owner') };

/** Stand-in for the sign-in middleware: only requests that carry the test header pass, as a signed-in owner. */
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
  server.use(createResourceRouter(repo));
  server.use(createCashEventsRouter(repo));
  server.use('/portfolio', createPortfolioRouter({
    state: repo,
    history: createHistoryRepo(repo),
    fetchQuotes: async (symbols: string[]) => symbols.map((symbol) => ({
      symbol, price: 110, currency: 'USD', asOf: Date.parse('2026-10-16T16:00:00Z'), source: 'nasdaq' as const,
    })),
  }));
  // As the sign-in integration mounts them: Phase 4's router behind the same guard as the import routes.
  const log = (line: string) => logs.push(line);
  mountCardSpendingRoutes(server, {
    repo, requireAuth: testAuth, log, routers: [createCardTransactionsRouter(repo, { log })],
  });
  return server;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-card-routes-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db'), now: () => new Date('2026-10-16T12:00:00.000Z') });
  logs = [];
  app = buildApp();
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // Nothing these routes log, in any test, may carry card data.
  expect(logs.join('\n')).not.toMatch(/\d{13}/);
  repo.close();
  await rm(dir, { recursive: true, force: true });
});

function syntheticCardNumber(): string {
  const body = `4${'7'.repeat(14)}`;
  for (let digit = 0; digit <= 9; digit += 1) if (luhnValid(`${body}${digit}`)) return `${body}${digit}`;
  throw new Error('unreachable');
}

const get = async (url: string) => request(await listenLoopback(app)).get(url).set('x-test-auth', 'ok');
const patch = async (url: string, body: unknown) => request(await listenLoopback(app)).patch(url).set('x-test-auth', 'ok')
  .set('Content-Type', 'application/json').send(typeof body === 'string' ? body : JSON.stringify(body));
const post = async (url: string, body: unknown) => request(await listenLoopback(app)).post(url).set('x-test-auth', 'ok')
  .set('Content-Type', 'application/json').send(typeof body === 'string' ? body : JSON.stringify(body));
const commit = (cardAccountId: string, json: string) => post(`/card-imports/commit?cardAccountId=${cardAccountId}`, json);

function payload(issuer: string, rows: CardImportDraftRow[], coverage?: { start: string; end: string }, currency = 'USD'): string {
  return serializeCardImportPayload(buildCardImportPayload({
    source: 'test-sync', parserVersion: 'test@1', issuer, currency, coverage: coverage ?? null, rows,
  }).payload);
}

function row(patchRow: Partial<CardImportRow> = {}): CardImportRow {
  return {
    transactionDate: '2026-09-10', postedDate: '2026-09-11', status: 'posted', amountMinor: 1250, currency: 'USD',
    kind: 'purchase', description: 'SAMPLE COFFEE BAR', merchant: null, issuerCategory: 'Restaurant', ...patchRow,
  };
}

/** Two people, three cards, September and October 2026, plus one euro card. */
function seed() {
  const amex = repo.createCardAccount({ issuer: 'amex', owner: 'alex', nickname: 'Gold', last4: '0003', currency: 'USD' });
  const chase = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '2002', currency: 'USD' });
  const euro = repo.createCardAccount({ issuer: 'samplebank', owner: 'joint', last4: '3003', currency: 'EUR' });
  const imp = (id: string, rows: CardImportRow[], coverage?: { start: string; end: string }) =>
    repo.importCardTransactions({ cardAccountId: id, source: 'test-sync', parserVersion: 'test@1', rows, coverage });
  imp(amex.id, [
    row({ transactionDate: '2026-09-02', amountMinor: 1250 }),
    row({ transactionDate: '2026-09-12', amountMinor: 24580, description: 'HOTEL SAMPLE LISBOA', issuerCategory: 'Travel', originalAmountMinor: 22000, originalCurrency: 'EUR' }),
    row({ transactionDate: '2026-09-12', amountMinor: 737, kind: 'fee', description: 'FOREIGN TRANSACTION FEE', issuerCategory: 'Fees' }),
    row({ transactionDate: '2026-09-20', amountMinor: -3000, kind: 'refund', description: 'SAMPLE OUTFITTERS RETURN', issuerCategory: 'Merchandise' }),
    row({ transactionDate: '2026-09-25', amountMinor: -60000, kind: 'payment', description: 'AUTOPAY PAYMENT THANK YOU', issuerCategory: null }),
    // Bought on the last day of September, posted in October: it counts in September.
    row({ transactionDate: '2026-09-30', postedDate: '2026-10-02', amountMinor: 8000, description: 'SAMPLE OUTFITTERS', issuerCategory: 'Merchandise' }),
  ], { start: '2026-09-01', end: '2026-10-02' });
  imp(chase.id, [
    row({ transactionDate: '2026-09-05', amountMinor: 4500, description: 'NORTHWIND GROCERY', merchant: 'Northwind', issuerCategory: 'Groceries' }),
    row({ transactionDate: '2026-10-03', amountMinor: 2000, description: 'NORTHWIND GROCERY', merchant: 'Northwind', issuerCategory: 'Groceries' }),
    row({ transactionDate: '2026-10-04', postedDate: null, status: 'pending', amountMinor: 999, description: 'TAILSPIN CINEMA', issuerCategory: 'Entertainment' }),
  ], { start: '2026-09-01', end: '2026-10-04' });
  imp(euro.id, [row({ currency: 'EUR', transactionDate: '2026-09-15', amountMinor: 5000, description: 'SAMPLE BAKERY', issuerCategory: 'Restaurant' })]);
  return { amex, chase, euro };
}

describe('mounting', () => {
  it('accepts and shows five-digit endings on card accounts', async () => {
    const created = await post('/card-accounts', { issuer: 'amex', owner: 'alex', nickname: 'Gold', last5: '90003', currency: 'USD' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ last4: '0003', last5: '90003' });
    const changed = await patch(`/card-accounts/${created.body.id}`, { last5: '80003' });
    expect(changed.body).toMatchObject({ last4: '0003', last5: '80003' });
    const wrong = await patch(`/card-accounts/${created.body.id}`, { last5: '48074' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('last5 must end with the account\'s last four digits');
    expect((await get(`/card-transactions/${'x'}`)).status).toBe(404);
  });

  it('is served only through the card spending mount, which refuses to mount without an auth middleware', () => {
    const routers = [createCardTransactionsRouter(repo)];
    expect(() => mountCardSpendingRoutes(express(), { repo, routers } as never)).toThrow(/requireAuth/);
    expect(() => mountCardSpendingRoutes(express(), { repo, requireAuth: 'yes', routers } as never)).toThrow(/requireAuth/);
    // Every route here lies under the guarded prefixes, or mounting would throw.
    expect(() => mountCardSpendingRoutes(express(), { repo, requireAuth: testAuth, routers })).not.toThrow();
  });

  it('answers 401 on every route without the auth middleware passing, and leaves other routes alone', async () => {
    const { amex } = seed();
    const [stored] = repo.listCardTransactions({ cardAccountId: amex.id });
    for (const call of [
      request(await listenLoopback(app)).get('/card-transactions'),
      request(await listenLoopback(app)).get(`/card-transactions/${stored.id}`),
      request(await listenLoopback(app)).patch(`/card-transactions/${stored.id}`).set('Content-Type', 'application/json').send('{"notes":"x"}'),
      request(await listenLoopback(app)).get('/spending/summary'),
      request(await listenLoopback(app)).get('/spending/coverage'),
      request(await listenLoopback(app)).get('/spending/anything-else'),
      request(await listenLoopback(app)).get('/card-accounts'),
    ]) {
      const res = await call;
      expect(res.status).toBe(401);
    }
    expect(repo.getCardTransaction(stored.id)?.notes).toBeUndefined();
    expect((await request(await listenLoopback(app)).get('/accounts')).status).toBe(200);
  });
});

describe('GET /card-transactions', () => {
  it('lists pending and posted rows newest first, without dedupe keys, with how each counts', async () => {
    seed();
    const res = await get('/card-transactions');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ total: 10, limit: 50, offset: 0, nextOffset: null });
    expect(res.body.transactions.map((item: { description: string }) => item.description)).toEqual([
      'TAILSPIN CINEMA', 'NORTHWIND GROCERY', 'SAMPLE OUTFITTERS', 'AUTOPAY PAYMENT THANK YOU', 'SAMPLE OUTFITTERS RETURN',
      'SAMPLE BAKERY', 'FOREIGN TRANSACTION FEE', 'HOTEL SAMPLE LISBOA', 'NORTHWIND GROCERY', 'SAMPLE COFFEE BAR',
    ]);
    const first = res.body.transactions[0];
    expect(first).not.toHaveProperty('externalIdHash');
    expect(first).not.toHaveProperty('fingerprint');
    expect(first).toMatchObject({ status: 'pending', category: 'Entertainment', merchantName: 'TAILSPIN CINEMA', role: 'spending' });
    const payment = res.body.transactions.find((item: { kind: string }) => item.kind === 'payment');
    expect(payment).toMatchObject({ role: 'transfer', category: 'Uncategorized' });
  });

  it('filters by card, person, status, kind, category, merchant, text, amount and dates', async () => {
    const { amex, chase } = seed();
    const descriptions = async (query: string) =>
      (await get(`/card-transactions?${query}`)).body.transactions.map((item: { description: string }) => item.description);
    expect(await descriptions(`cardAccountId=${chase.id}`)).toEqual(['TAILSPIN CINEMA', 'NORTHWIND GROCERY', 'NORTHWIND GROCERY']);
    expect(await descriptions('owner=joint')).toEqual(['SAMPLE BAKERY']);
    expect(await descriptions('status=pending')).toEqual(['TAILSPIN CINEMA']);
    expect(await descriptions('status=posted,removed&owner=casey')).toEqual(['NORTHWIND GROCERY', 'NORTHWIND GROCERY']);
    expect(await descriptions('kind=refund,payment')).toEqual(['AUTOPAY PAYMENT THANK YOU', 'SAMPLE OUTFITTERS RETURN']);
    expect(await descriptions('category=Merchandise')).toEqual(['SAMPLE OUTFITTERS', 'SAMPLE OUTFITTERS RETURN']);
    expect(await descriptions('merchant=Northwind&from=2026-10-01&to=2026-10-31')).toEqual(['NORTHWIND GROCERY']);
    expect(await descriptions('q=lisboa')).toEqual(['HOTEL SAMPLE LISBOA']);
    expect(await descriptions('q=%2445')).toEqual(['NORTHWIND GROCERY']);
    expect(await descriptions('q=50')).toEqual(['SAMPLE BAKERY']);
    expect(await descriptions(`cardAccountId=${amex.id}&from=2026-09-12&to=2026-09-12`)).toEqual(['FOREIGN TRANSACTION FEE', 'HOTEL SAMPLE LISBOA']);
    expect(await descriptions('q=%20%20')).toHaveLength(10);
  });

  it('pages and sorts', async () => {
    seed();
    const first = await get('/card-transactions?sort=amount-desc&limit=2');
    expect(first.body).toMatchObject({ total: 10, limit: 2, offset: 0, nextOffset: 2 });
    expect(first.body.transactions.map((item: { amountMinor: number }) => item.amountMinor)).toEqual([24580, 8000]);
    const last = await get('/card-transactions?sort=amount-desc&limit=2&offset=8');
    expect(last.body).toMatchObject({ total: 10, offset: 8, nextOffset: null });
    expect(last.body.transactions.map((item: { amountMinor: number }) => item.amountMinor)).toEqual([-3000, -60000]);
    const oldest = await get('/card-transactions?sort=date-asc&limit=1');
    expect(oldest.body.transactions[0].description).toBe('SAMPLE COFFEE BAR');
  });

  it('refuses bad parameters without echoing them', async () => {
    seed();
    const cases: Array<[string, number, RegExp]> = [
      ['from=2026-02-30', 400, /^from must be a valid YYYY-MM-DD date$/],
      ['from=2026-10-02&to=2026-10-01', 400, /^from must not be after to$/],
      ['sort=random', 400, /^sort must be/],
      ['limit=0', 400, /^limit must be an integer from 1 to 200$/],
      ['limit=201', 400, /^limit must be an integer from 1 to 200$/],
      ['offset=-1', 400, /^offset must be an integer/],
      ['status=pending,gone', 400, /^status must be a comma-separated list of pending, posted, removed$/],
      ['kind=gift', 400, /^kind must be/],
      ['owner=jane', 400, /^owner must be alex, casey or joint$/],
      ['cardAccountId=card-acct-missing', 404, /^card account not found$/],
      ['cardAccountId=bad%20id', 400, /^cardAccountId is invalid$/],
      ['q=a%07b', 400, /^q must not contain control characters$/],
      [`q=${'x'.repeat(101)}`, 400, /^q must be at most 100 characters$/],
      ['color=red', 400, /^unexpected query parameter$/],
      ['q=a&q=b', 400, /^q must be given once$/],
    ];
    for (const [query, status, message] of cases) {
      const res = await get(`/card-transactions?${query}`);
      expect(res.status, query).toBe(status);
      expect(res.body.error, query).toMatch(message);
      expect(res.text).not.toMatch(/jane|gone|red|gift|random/);
    }
  });

  it('refuses card data in queries with 422 and paths only', async () => {
    seed();
    const pan = syntheticCardNumber();
    for (const [query, paths] of [
      [`q=${pan}`, ['query.q']],
      [`q=${pan.replace(/(\d{4})/g, '$1 ').trim()}`, ['query.q']],
      [`${pan}=1`, ['query.<key>']],
      [`merchant=REF ${'9'.repeat(13)}`, ['query.merchant']],
      // Security codes and expiry dates, labeled in the value or by the name.
      [`q=${encodeURIComponent('cvv: 123')}`, ['query.q']],
      ['cvv=123', ['query.<key>']],
      [`q=${encodeURIComponent('exp 04/29')}`, ['query.q']],
    ] as const) {
      const res = await get(`/card-transactions?${query}`);
      expect(res.status).toBe(422);
      expect(res.body.paths).toEqual(paths);
      expect(res.text).not.toContain(pan.slice(4, 12));
      expect(res.text).not.toMatch(/\d{13}/);
    }
    for (const url of ['/spending/summary?q=cvv%3A%20123', `/spending/insights?month=${encodeURIComponent('cvv 123')}`]) {
      expect((await get(url)).status, url).toBe(422);
    }
    const [stored] = repo.listCardTransactions();
    const note = await patch(`/card-transactions/${stored.id}`, { notes: 'card cvv 123' });
    expect(note.status).toBe(422);
    expect(note.body.paths).toEqual(['$.notes']);
    expect(repo.getCardTransaction(stored.id)?.notes).toBeUndefined();
  });

  it('answers the repository\'s own refusals with 400 and their message, not as failures', async () => {
    seed();
    const logged = logs.length;
    // Text the route accepts but the repository refuses once normalized: only invisible characters.
    for (const [url, message] of [
      ['/card-transactions?q=%E2%80%8B', 'search must not be empty'],
      ['/card-transactions?merchant=%E2%80%8B%E2%80%8B', 'merchant must not be empty'],
      ['/spending/summary?category=%E2%80%8B', 'category must not be empty'],
    ] as const) {
      const res = await get(url);
      expect(res.status, url).toBe(400);
      expect(res.body, url).toEqual({ error: message });
    }
    expect(logs.slice(logged).filter((line) => line.startsWith('[card-'))).toEqual([]);
  });
});

describe('GET /card-transactions/:id', () => {
  it('shows a row with its card, import and pending history', async () => {
    const { amex } = seed();
    const hotel = repo.queryCardTransactions({ search: 'lisboa' }).transactions[0];
    const res = await get(`/card-transactions/${hotel.id}`);
    expect(res.status).toBe(200);
    expect(res.body.transaction).toMatchObject({
      description: 'HOTEL SAMPLE LISBOA', amountMinor: 24580, currency: 'USD', originalAmountMinor: 22000, originalCurrency: 'EUR',
    });
    expect(res.body.cardAccount).toMatchObject({ id: amex.id, issuer: 'amex', last4: '0003', owner: 'alex' });
    expect(res.body.importBatch).toMatchObject({ cardAccountId: amex.id, coverage: { start: '2026-09-01', end: '2026-10-02' } });
    expect(res.body.possiblyPostedAs).toEqual([]);

    repo.importCardTransactions({
      cardAccountId: amex.id, source: 'test-sync', parserVersion: 'test@1',
      rows: [row({ externalIdHash: cardExternalIdHash('PEND'), status: 'pending', postedDate: null, transactionDate: '2026-10-05', amountMinor: 4321, description: 'SAMPLE TAXI' })],
    });
    repo.importCardTransactions({
      cardAccountId: amex.id, source: 'test-sync', parserVersion: 'test@1',
      rows: [row({ externalIdHash: cardExternalIdHash('POST'), transactionDate: '2026-10-06', amountMinor: 4321, description: 'SAMPLE TAXI CO' })],
    });
    // The posted row under a new reference is only suggested; the pending row stays pending.
    const [posted, pending] = repo.queryCardTransactions({ search: 'taxi', statuses: ['posted', 'pending', 'removed'] }).transactions;
    expect([posted.status, pending.status]).toEqual(['posted', 'pending']);
    expect((await get(`/card-transactions/${pending.id}`)).body.possiblyPostedAs).toEqual([
      expect.objectContaining({ id: posted.id, status: 'posted', description: 'SAMPLE TAXI CO' }),
    ]);
    expect((await get(`/card-transactions/${posted.id}`)).body.possiblyPostedAs).toEqual([]);
    expect((await get('/card-transactions/card-txn-missing')).status).toBe(404);
    expect((await get('/card-transactions/bad%20id')).status).toBe(404);
    const pan = await get(`/card-transactions/${syntheticCardNumber()}`);
    expect(pan.status).toBe(422);
    expect(pan.body.paths).toEqual(['params.id']);
    // Card data in the id comes first, before an unknown query parameter.
    const first = await get(`/card-transactions/${syntheticCardNumber()}?unknown=1`);
    expect(first.status).toBe(422);
  });
});

describe('PATCH /card-transactions/:id', () => {
  it('sets and clears custom categories and notes, and dismisses or restores pending rows', async () => {
    seed();
    const grocery = repo.queryCardTransactions({ merchant: 'Northwind', from: '2026-10-01' }).transactions[0];
    const set = await patch(`/card-transactions/${grocery.id}`, { userCategory: 'Household', notes: 'synthetic' });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ userCategory: 'Household', category: 'Household', notes: 'synthetic', amountMinor: 2000 });
    expect(set.body).not.toHaveProperty('fingerprint');
    expect((await patch(`/card-transactions/${grocery.id}`, { userCategory: null })).body).toMatchObject({ category: 'Groceries' });
    expect((await patch(`/card-transactions/${grocery.id}`, { notes: '' })).body.notes).toBeUndefined();

    const cinema = repo.queryCardTransactions({ statuses: ['pending'] }).transactions[0];
    expect((await patch(`/card-transactions/${cinema.id}`, { status: 'removed' })).body).toMatchObject({
      status: 'removed', dismissedAt: '2026-10-16T12:00:00.000Z',
    });
    expect((await get('/card-transactions?status=pending')).body.total).toBe(0);
    expect((await patch(`/card-transactions/${cinema.id}`, { status: 'pending' })).body).toMatchObject({ status: 'pending' });
    const posted = await patch(`/card-transactions/${grocery.id}`, { status: 'removed' });
    expect(posted.status).toBe(400);
    expect(posted.body.error).toBe('only a pending card transaction can be dismissed');
  });

  it('refuses bad bodies, card data and unknown rows without echoing input', async () => {
    seed();
    const grocery = repo.queryCardTransactions({ merchant: 'Northwind' }).transactions[0];
    const url = `/card-transactions/${grocery.id}`;
    const pan = syntheticCardNumber();
    const cards = await patch(url, { notes: `paid with ${pan}` });
    expect(cards.status).toBe(422);
    expect(cards.body).toEqual({ error: expect.stringMatching(/^card data detected/), paths: ['$.notes'] });
    const key = await patch(url, { [pan]: 'x' });
    expect(key.status).toBe(422);
    expect(key.text).not.toContain(pan.slice(4, 12));
    for (const [body, message] of [
      [{ amountMinor: 1 }, 'only userCategory, notes and status can change, or postedAs be set'],
      [{}, 'no fields to update'],
      [[1], 'body must be an object'],
      [{ userCategory: 5 }, 'userCategory must be a string or null'],
      [{ status: 'posted' }, 'status must be pending or removed'],
      [{ notes: 'x'.repeat(1001) }, 'notes must be at most 1000 characters'],
      ['{not json', 'the request body is not valid JSON'],
    ] as const) {
      const res = await patch(url, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toBe(message);
    }
    const wrongType = await request(await listenLoopback(app)).patch(url).set('x-test-auth', 'ok').set('Content-Type', 'text/plain').send('{"notes":"x"}');
    expect(wrongType.status).toBe(415);
    const tooLarge = await patch(url, { notes: 'x'.repeat(20_000) });
    expect(tooLarge.status).toBe(413);
    expect((await patch('/card-transactions/card-txn-missing', { notes: 'x' })).status).toBe(404);
    // Card data is a 422 before anything else: an id that cannot exist, or an unknown parameter, comes after.
    for (const target of ['/card-transactions/invalid%20id', '/card-transactions/card-txn-missing', `${url}?unknown=1`]) {
      const res = await patch(target, { notes: `paid with ${pan}` });
      expect(res.status, target).toBe(422);
      expect(res.body.paths, target).toEqual(['$.notes']);
    }
    const bothBad = await patch(`/card-transactions/${pan}`, { notes: `paid with ${pan}` });
    expect(bothBad.status).toBe(422);
    expect(bothBad.body.paths).toEqual(['params.id']);
    expect(bothBad.text).not.toContain(pan.slice(4, 12));
    expect(repo.getCardTransaction(grocery.id)).toMatchObject({ userCategory: undefined, notes: undefined, amountMinor: grocery.amountMinor });
  });

  it('answers only a card guard\'s refusal as card data (422, paths only); any other trigger is a 500', async () => {
    seed();
    const grocery = repo.queryCardTransactions({ merchant: 'Northwind' }).transactions[0];
    const cinema = repo.queryCardTransactions({ statuses: ['pending'] }).transactions[0];
    const pan = syntheticCardNumber();
    const db = repo.internalGetDb();
    const cardLogs = (from: number) => logs.slice(from).filter((line) => line.startsWith('[card-'));
    const caught = (fn: () => unknown): unknown => {
      try {
        fn();
      } catch (error) {
        return error;
      }
      throw new Error('expected a throw');
    };
    // A masked number only the span rule catches, so the database's card guard is what refuses it.
    const CARD_DATA = '5018 ****0009';

    // A card guard's refusal. Only a gap in every check before the database could reach it, so the
    // repository's checks are switched off, and the card data goes in after the route's own checks.
    const internals = repo as unknown as { cardDetectors: unknown };
    const checks = internals.cardDetectors;
    internals.cardDetectors = { containsCardData: () => false, containsCardSecret: () => false };
    // The boundary hands the route a fresh HoldrGuardRefusal, nothing of SQLite's exception.
    expect(caught(() => repo.updateCardTransaction(grocery.id, { notes: CARD_DATA }, OWNER))).toBeInstanceOf(HoldrGuardRefusal);
    const original = repo.updateCardTransaction.bind(repo);
    vi.spyOn(repo, 'updateCardTransaction').mockImplementationOnce((id, change, ctx) => original(id, { ...change, notes: CARD_DATA }, ctx));
    let logged = logs.length;
    const guarded = await patch(`/card-transactions/${grocery.id}`, { notes: 'synthetic' });
    internals.cardDetectors = checks;
    expect(guarded.status).toBe(422);
    expect(guarded.body).toEqual({ error: expect.stringMatching(/^card data detected/), paths: ['$'] });
    expect(cardLogs(logged)).toEqual([
      '[card-spending] the card guards refused a write that passed every API check; nothing was written',
    ]);

    // SQLITE_CONSTRAINT_TRIGGER from any other trigger is no proof of card data: a database
    // failure, answered with the fixed 500 and never with the trigger's text, on an edit and on a
    // dismissal alike.
    logged = logs.length;
    db.exec(`CREATE TRIGGER foreign_edit BEFORE UPDATE ON card_transactions BEGIN SELECT RAISE(ABORT, 'CVV 123 ${pan}'); END`);
    expect(caught(() => repo.updateCardTransaction(grocery.id, { notes: 'synthetic' }, OWNER))).toBeInstanceOf(HoldrDbError);
    const foreign = await patch(`/card-transactions/${grocery.id}`, { notes: 'synthetic' });
    const dismissal = await patch(`/card-transactions/${cinema.id}`, { status: 'removed' });
    db.exec('DROP TRIGGER foreign_edit');
    for (const res of [foreign, dismissal]) {
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'card spending request failed' });
    }
    expect(cardLogs(logged)).toEqual(Array(2).fill('[card-spending] PATCH request failed: HoldrDbError SQLITE_CONSTRAINT_TRIGGER'));

    // Errors that never passed the boundary follow the same rule: SQLite's own trigger error with a
    // message that is not a card guard's, and any other SQLite error, are database failures.
    const sqliteError = (message: string, code: string) => Object.assign(new Error(message), { name: 'SqliteError', code });
    vi.spyOn(repo, 'updateCardTransaction')
      .mockImplementationOnce(() => { throw sqliteError(`card_transactions.notes refused in row ${pan}`, 'SQLITE_CONSTRAINT_TRIGGER'); })
      .mockImplementationOnce(() => { throw sqliteError(`CHECK constraint failed: notes = '${pan}'`, 'SQLITE_CONSTRAINT_CHECK'); });
    logged = logs.length;
    const unchecked = [
      await patch(`/card-transactions/${grocery.id}`, { notes: 'synthetic' }),
      await patch(`/card-transactions/${grocery.id}`, { notes: 'synthetic' }),
    ];
    for (const res of unchecked) {
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'card spending request failed' });
    }
    expect(cardLogs(logged)).toEqual([
      '[card-spending] PATCH request failed: SqliteError SQLITE_CONSTRAINT_TRIGGER',
      '[card-spending] PATCH request failed: SqliteError SQLITE_CONSTRAINT_CHECK',
    ]);

    for (const res of [guarded, foreign, dismissal, ...unchecked]) {
      expect(res.text).not.toMatch(/sqlite|trigger|constraint|cvv|card_transactions|notes|\d/i);
    }
    expect(logs.join('\n')).not.toContain(pan);
    expect(repo.getCardTransaction(grocery.id)).toEqual(grocery);
    expect(repo.getCardTransaction(cinema.id)).toEqual(cinema);
  });

  it('answers other database failures behind the repository boundary with the mount\'s 500, quoting nothing', async () => {
    seed();
    const grocery = repo.queryCardTransactions({ merchant: 'Northwind' }).transactions[0];
    const pan = syntheticCardNumber();
    const db = repo.internalGetDb();
    const cardLogs = (from: number) => logs.slice(from).filter((line) => line.startsWith('[card-'));
    let logged = logs.length;

    // A write the database cannot do: the mount's 500, logging only the type and code. Reads still answer.
    db.pragma('query_only = ON');
    const readOnly = await patch(`/card-transactions/${grocery.id}`, { notes: 'synthetic' });
    expect((await get('/card-transactions')).status).toBe(200);
    db.pragma('query_only = OFF');
    expect(readOnly.status).toBe(500);
    expect(readOnly.body).toEqual({ error: 'card spending request failed' });
    expect(cardLogs(logged)).toEqual(['[card-spending] PATCH request failed: HoldrDbError SQLITE_READONLY']);
    expect(repo.getCardTransaction(grocery.id)).toEqual(grocery);

    // A failing read on every Spending route: the mount's 500, never a stored identifier.
    logged = logs.length;
    db.exec(`
      ALTER TABLE card_transactions RENAME TO card_transactions_kept;
      CREATE TABLE pan_${pan} (id TEXT);
      CREATE VIEW card_transactions AS SELECT * FROM pan_${pan};
      DROP TABLE pan_${pan};
    `);
    const reads = [
      await get('/card-transactions'),
      await get(`/card-transactions/${grocery.id}`),
      await get('/spending/summary'),
      await get('/spending/coverage'),
    ];
    for (const res of reads) {
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'card spending request failed' });
    }
    for (const res of [readOnly, ...reads]) expect(res.text).not.toMatch(/sqlite|trigger|cvv|pan_|\d/i);
    expect(cardLogs(logged)).toEqual(Array(reads.length).fill('[card-spending] GET request failed: HoldrDbError SQLITE_ERROR'));
    expect(logs.join('\n')).not.toContain(pan);
  });
});

describe('long references, IBANs and phone numbers in typed text (card guard revision 4)', () => {
  // Synthetic: made-up references, the example IBANs banks publish, and phone
  // numbers from ranges kept for fiction. Revision 4 counts a card-length run
  // of digits, masks and separators showing more than four digits as card
  // data, wherever it is typed.
  const LONG_NUMBERS = [
    'PAYMENT REF 123456789012345',
    'WIRE REF 0000-1234-5678-9012-34',
    'IBAN GB29 NWBK 6016 1331 9268 19',
    'GB29NWBK60161331926819',
    'DE89 3704 0044 0532 0130 00',
    'CALL +86 130 0000 0000',
    'TEL +44 20 7946 0958 123',
    'call 011 44 20 7946 0958',
  ];
  // Shorter than any card number: kept as typed.
  const ORDINARY = ['CALL 1-800-555-0199 EXT 12345', 'UBER 800-555-0199', 'ORDER #1234 2026-09-14'];

  /** The refusal shows nothing of the value: a fixed message, the paths, and not one digit. */
  function expectValueFree(res: request.Response, paths: string[], label: string) {
    expect(res.status, label).toBe(422);
    expect(res.body, label).toEqual({ error: expect.stringMatching(/^card data detected/), paths });
    expect(res.text, label).not.toMatch(/\d/);
  }

  it('are a value-free 422 in notes, custom categories, nicknames and searches, before the repository', async () => {
    const { amex } = seed();
    const grocery = repo.queryCardTransactions({ merchant: 'Northwind' }).transactions[0];
    const before = { transaction: repo.getCardTransaction(grocery.id), accounts: repo.listCardAccounts() };
    const writes = ['updateCardTransaction', 'createCardAccount', 'updateCardAccount', 'queryCardTransactions']
      .map((method) => vi.spyOn(repo, method as 'updateCardTransaction'));
    const logged = logs.length;
    for (const value of LONG_NUMBERS) {
      expectValueFree(await patch(`/card-transactions/${grocery.id}`, { notes: value }), ['$.notes'], `notes: ${value}`);
      expectValueFree(await patch(`/card-transactions/${grocery.id}`, { userCategory: value }), ['$.userCategory'], `category: ${value}`);
      expectValueFree(await post('/card-accounts', { issuer: 'amex', owner: 'alex', nickname: value, currency: 'USD' }),
        ['$.nickname'], `new card: ${value}`);
      expectValueFree(await patch(`/card-accounts/${amex.id}`, { nickname: value }), ['$.nickname'], `nickname: ${value}`);
      expectValueFree(await get(`/card-transactions?q=${encodeURIComponent(value)}`), ['query.q'], `search: ${value}`);
    }
    for (const spy of writes) expect(spy).not.toHaveBeenCalled();
    expect(repo.getCardTransaction(grocery.id)).toEqual(before.transaction);
    expect(repo.listCardAccounts()).toEqual(before.accounts);
    const lines = logs.slice(logged).join('\n');
    for (const value of LONG_NUMBERS) {
      expect(lines).not.toContain(value);
      expect(lines).not.toContain(value.replace(/[^0-9]/g, ''));
    }
  });

  it('are refused by the repository and by the database guards on their own, with fixed messages', () => {
    const { amex } = seed();
    const grocery = repo.queryCardTransactions({ merchant: 'Northwind' }).transactions[0];
    const before = { transaction: repo.getCardTransaction(grocery.id), account: repo.getCardAccount(amex.id) };
    const db = repo.internalGetDb();
    const guard = (column: string) => new RegExp(`^${column.replace('.', '\\.')} must not contain (a card number|13 or more consecutive digits)$`);
    for (const value of LONG_NUMBERS) {
      for (const [field, call] of [
        ['notes', () => repo.updateCardTransaction(grocery.id, { notes: value }, OWNER)],
        ['userCategory', () => repo.updateCardTransaction(grocery.id, { userCategory: value }, OWNER)],
        ['nickname', () => repo.updateCardAccount(amex.id, { nickname: value })],
        ['nickname', () => repo.createCardAccount({ issuer: 'amex', owner: 'alex', nickname: value, currency: 'USD' })],
      ] as const) {
        expect(call, `${field}: ${value}`).toThrow(new RegExp(`^${field} must not contain a card number or 13 or more consecutive digits$`));
      }
      for (const [column, sql, id] of [
        ['card_transactions.notes', 'UPDATE card_transactions SET notes = ? WHERE id = ?', grocery.id],
        ['card_transactions.user_category', 'UPDATE card_transactions SET user_category = ? WHERE id = ?', grocery.id],
        ['card_accounts.nickname', 'UPDATE card_accounts SET nickname = ? WHERE id = ?', amex.id],
      ] as const) {
        expect(() => db.prepare(sql).run(value, id), `${column}: ${value}`).toThrow(guard(column));
      }
    }
    expect(repo.getCardTransaction(grocery.id)).toEqual(before.transaction);
    expect(repo.getCardAccount(amex.id)).toEqual(before.account);
    expect(repo.listCardAccounts()).toHaveLength(3);
  });

  it('leave ordinary phone numbers and short references as typed', async () => {
    const { amex } = seed();
    const grocery = repo.queryCardTransactions({ merchant: 'Northwind' }).transactions[0];
    for (const value of ORDINARY) {
      const note = await patch(`/card-transactions/${grocery.id}`, { notes: value, userCategory: value });
      expect(note.status, value).toBe(200);
      expect(note.body, value).toMatchObject({ notes: value, userCategory: value });
      const nickname = await patch(`/card-accounts/${amex.id}`, { nickname: value });
      expect(nickname.status, value).toBe(200);
      expect(nickname.body.nickname, value).toBe(value);
    }
  });
});

describe('GET /spending/summary', () => {
  it('sums posted spending by month, category, merchant, card and person, keeping currencies apart', async () => {
    const { amex, chase, euro } = seed();
    const res = await get('/spending/summary?from=2026-09-01&to=2026-09-30');
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('includePending');
    expect(res.body.totals).toEqual([
      { currency: 'EUR', spendingMinor: 5000, chargesMinor: 5000, creditsMinor: 0, count: 1, paymentsMinor: 0, paymentCount: 0, otherMinor: 0, otherCount: 0 },
      {
        currency: 'USD', spendingMinor: 1250 + 24580 + 737 - 3000 + 8000 + 4500, chargesMinor: 1250 + 24580 + 737 + 8000 + 4500,
        creditsMinor: -3000, count: 6, paymentsMinor: -60000, paymentCount: 1, otherMinor: 0, otherCount: 0,
      },
    ]);
    expect(res.body.pending).toEqual([]);
    expect(res.body.byMonth).toEqual([
      expect.objectContaining({ month: '2026-09', currency: 'EUR', spendingMinor: 5000 }),
      expect.objectContaining({ month: '2026-09', currency: 'USD', spendingMinor: 36067 }),
    ]);
    expect(res.body.byCategory.filter((item: { currency: string }) => item.currency === 'USD')
      .map((item: { category: string; spendingMinor: number }) => [item.category, item.spendingMinor])).toEqual([
      ['Travel', 24580], ['Merchandise', 5000], ['Groceries', 4500], ['Restaurant', 1250], ['Fees', 737],
    ]);
    expect(res.body.byCard.map((item: { cardAccountId: string; currency: string }) => [item.cardAccountId, item.currency]))
      .toEqual([[euro.id, 'EUR'], [amex.id, 'USD'], [chase.id, 'USD']]);
    expect(res.body.byOwner.map((item: { owner: string; spendingMinor: number }) => [item.owner, item.spendingMinor]))
      .toEqual([['joint', 5000], ['alex', 31567], ['casey', 4500]]);
    expect(res.body.byMonthOwner).toEqual(expect.arrayContaining([expect.objectContaining({ month: '2026-09', owner: 'casey', spendingMinor: 4500 })]));
    expect(res.body.categories).toEqual(['Entertainment', 'Fees', 'Groceries', 'Merchandise', 'Restaurant', 'Travel']);
    // The one payment, with no brokerage cash to have come from.
    expect(res.body.paymentsPossiblyPaidFrom).toEqual([{ currency: 'USD', count: 0 }]);
  });

  it('totals pending on its own and never adds it to spending, and follows the same filters as the list', async () => {
    const { chase } = seed();
    const october = await get(`/spending/summary?from=2026-10-01&to=2026-10-31&cardAccountId=${chase.id}`);
    expect(october.body.totals).toEqual([expect.objectContaining({ currency: 'USD', spendingMinor: 2000, count: 1 })]);
    expect(october.body.pending).toEqual([{ currency: 'USD', count: 1, netMinor: 999, chargesMinor: 999, creditsMinor: 0 }]);
    expect(october.body.byMonth).toEqual([expect.objectContaining({ month: '2026-10', spendingMinor: 2000, count: 1 })]);
    // There is no switch that adds pending charges to spending.
    expect((await get(`/spending/summary?cardAccountId=${chase.id}&includePending=true`)).status).toBe(400);
    const merchant = await get('/spending/summary?merchant=Northwind');
    expect(merchant.body.totals).toEqual([expect.objectContaining({ spendingMinor: 6500, count: 2 })]);
    const owner = await get('/spending/summary?owner=alex&q=sample');
    expect(owner.body.totals).toEqual([expect.objectContaining({ spendingMinor: 1250 + 24580 - 3000 + 8000 })]);
    expect((await get('/spending/summary?status=pending')).status).toBe(400);
  });

  it('moves spending to a custom category and back', async () => {
    seed();
    const hotel = repo.queryCardTransactions({ search: 'lisboa' }).transactions[0];
    await patch(`/card-transactions/${hotel.id}`, { userCategory: 'Vacation' });
    const categories = async () => (await get('/spending/summary?from=2026-09-01&to=2026-09-30')).body.byCategory
      .filter((item: { currency: string }) => item.currency === 'USD').map((item: { category: string }) => item.category);
    expect(await categories()).toEqual(['Vacation', 'Merchandise', 'Groceries', 'Restaurant', 'Fees']);
    expect((await get('/spending/summary?category=Vacation')).body.totals[0].spendingMinor).toBe(24580);
    await patch(`/card-transactions/${hotel.id}`, { userCategory: null });
    expect(await categories()).toEqual(['Travel', 'Merchandise', 'Groceries', 'Restaurant', 'Fees']);
  });
});

describe('GET /spending/insights', () => {
  it('reports recurring charges, duplicates, movers and costs for the filtered cards, and refuses bad parameters', async () => {
    const { amex, chase } = seed();
    const imp = (id: string, rows: CardImportRow[]) =>
      repo.importCardTransactions({ cardAccountId: id, source: 'test-sync', parserVersion: 'test@1', rows });
    imp(amex.id, ['2026-05-03', '2026-06-03', '2026-07-03', '2026-08-03'].map((date) =>
      row({ transactionDate: date, postedDate: date, amountMinor: 1549, description: 'SAMPLE STREAMING', issuerCategory: 'Entertainment' })));
    imp(amex.id, [
      row({ transactionDate: '2026-09-03', postedDate: '2026-09-03', amountMinor: 1799, description: 'SAMPLE STREAMING', issuerCategory: 'Entertainment' }),
      row({ transactionDate: '2026-10-03', postedDate: '2026-10-03', amountMinor: 1799, description: 'SAMPLE STREAMING', issuerCategory: 'Entertainment' }),
      row({ transactionDate: '2026-09-21', postedDate: '2026-09-22', amountMinor: 41200, description: 'CONTOSO AIRLINES', issuerCategory: 'Travel' }),
      row({ transactionDate: '2026-09-22', postedDate: '2026-09-23', amountMinor: 41200, description: 'CONTOSO AIRLINES', issuerCategory: 'Travel' }),
      row({ transactionDate: '2026-09-28', postedDate: '2026-09-28', amountMinor: 2400, kind: 'interest', description: 'INTEREST CHARGE', issuerCategory: null }),
    ]);
    const res = await get(`/spending/insights?month=2026-09&today=2026-10-16&cardAccountId=${amex.id}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ currency: 'USD', month: '2026-09', today: '2026-10-16', pace: null });
    expect(res.body.recurring).toEqual([expect.objectContaining({
      merchant: 'SAMPLE STREAMING', cadence: 'monthly', typicalMinor: 1799, priceChange: { fromMinor: 1549, toMinor: 1799, since: '2026-09-03' }, active: true,
    })]);
    expect(res.body.duplicates).toEqual([expect.objectContaining({ merchant: 'CONTOSO AIRLINES', amountMinor: 41200, dates: ['2026-09-21', '2026-09-22'] })]);
    expect(res.body.costs.period).toEqual({ feesMinor: 737, interestMinor: 2400, foreignFeesMinor: 737, reversalsMinor: 0 });
    expect(res.body.movers.map((mover: { category: string }) => mover.category)).toContain('Travel');
    // Without from and to: the month against the month before.
    expect(res.body.period).toEqual({ from: '2026-09-01', to: '2026-09-30', baseline: { from: '2026-08-01', to: '2026-08-31' } });

    // The page's own period and baseline (here the last 60 days against the 60 before): no pace, which is the month's.
    const span = await get(`/spending/insights?today=2026-10-16&cardAccountId=${amex.id}&from=2026-08-18&to=2026-10-16&baselineFrom=2026-06-19&baselineTo=2026-08-17`);
    expect(span.status).toBe(200);
    expect(span.body).toMatchObject({ period: { from: '2026-08-18', to: '2026-10-16', baseline: { from: '2026-06-19', to: '2026-08-17' } }, pace: null });
    expect(span.body.duplicates).toHaveLength(1);
    expect(span.body.recurringChanges.priceUps).toEqual([expect.objectContaining({ merchant: 'SAMPLE STREAMING' })]);
    const alone = await get(`/spending/insights?today=2026-10-16&cardAccountId=${amex.id}&from=2026-09-01&to=2026-09-30`);
    expect(alone.body).toMatchObject({ period: { from: '2026-09-01', to: '2026-09-30', baseline: null }, baselineMinor: null, movers: [] });

    const other = await get(`/spending/insights?month=2026-09&today=2026-10-16&cardAccountId=${chase.id}`);
    expect(other.body.recurring).toEqual([]);
    expect(other.body.duplicates).toEqual([]);
    expect((await get('/spending/insights?owner=joint&today=2026-10-16')).body).toMatchObject({ currency: 'EUR', month: '2026-10' });

    for (const [query, message] of [
      ['month=2026-13', 'month must be YYYY-MM'],
      ['today=2026-02-30', 'today must be a valid YYYY-MM-DD date'],
      ['currency=usd', 'currency must be a three-letter uppercase code'],
      ['owner=jane', 'owner must be alex, casey or joint'],
      ['q=x', 'unexpected query parameter'],
      ['from=2026-09-01', 'from and to go together'],
      ['from=2026-09-01&to=2026-02-30', 'to must be a valid YYYY-MM-DD date'],
      ['from=2026-09-30&to=2026-09-01', 'from must not be after to'],
      ['baselineFrom=2026-08-01&baselineTo=2026-08-31', 'baselineFrom and baselineTo need from and to'],
      ['from=2026-09-01&to=2026-09-30&baselineFrom=2026-08-01', 'baselineFrom and baselineTo go together'],
      ['from=2026-09-01&to=2026-09-30&baselineFrom=2026-08-31&baselineTo=2026-08-01', 'baselineFrom must not be after baselineTo'],
      ['from=2026-09-01&to=2026-09-30&baselineFrom=2026-08-01&baselineTo=2026-09-01', 'baselineTo must be before from'],
    ]) {
      const bad = await get(`/spending/insights?${query}`);
      expect(bad.status, query).toBe(400);
      expect(bad.body.error).toBe(message);
    }
    expect((await request(await listenLoopback(app)).get('/spending/insights')).status).toBe(401);
  });
});

describe('a large order that never charged', () => {
  // Two identical holds for one big synthetic order (the kind a cancelled order leaves behind).
  const ORDER = 1234500;
  const hold = (n: number, patchRow: Partial<CardImportRow> = {}) => row({
    transactionDate: '2026-10-05', postedDate: null, status: 'pending', amountMinor: ORDER,
    description: 'SAMPLE MEGASTORE ONLINE', issuerCategory: 'Merchandise', externalIdHash: cardExternalIdHash(`SYN-ORDER-${n}`), ...patchRow,
  });
  const surfaces = async (cardAccountId: string) => {
    const summary = (await get('/spending/summary')).body;
    const card = (await get(`/spending/summary?cardAccountId=${cardAccountId}`)).body;
    const insights = (await get(`/spending/insights?month=2026-10&today=2026-10-16&cardAccountId=${cardAccountId}`)).body;
    const { pending, ...counted } = summary;
    return { counted, pending, cardTotals: card.totals, insights };
  };
  const mentions = (value: unknown) => JSON.stringify(value).includes('MEGASTORE');

  it('stays out of totals, months, categories, top merchants, cards, people and insights while pending or dismissed', async () => {
    const { amex } = seed();
    const before = await surfaces(amex.id);
    repo.importCardTransactions({ cardAccountId: amex.id, source: 'test-sync', parserVersion: 'test@1', rows: [hold(1), hold(2)] });

    const pending = await surfaces(amex.id);
    expect(pending.counted).toEqual(before.counted);
    expect(pending.cardTotals).toEqual(before.cardTotals);
    expect(pending.insights).toEqual(before.insights);
    expect(mentions(pending.counted) || mentions(pending.insights)).toBe(false);
    // Shown on its own, never added in.
    expect(pending.pending).toEqual([{ currency: 'USD', count: 1 + 2, netMinor: 999 + 2 * ORDER, chargesMinor: 999 + 2 * ORDER, creditsMinor: 0 }]);

    const listed = repo.queryCardTransactions({ search: 'megastore' }).transactions;
    expect(listed.map((item) => item.status)).toEqual(['pending', 'pending']);
    for (const item of listed) expect((await patch(`/card-transactions/${item.id}`, { status: 'removed' })).status).toBe(200);

    const dismissed = await surfaces(amex.id);
    expect(dismissed.counted).toEqual(before.counted);
    expect(dismissed.cardTotals).toEqual(before.cardTotals);
    expect(dismissed.insights).toEqual(before.insights);
    expect(dismissed.pending).toEqual(before.pending);
    expect(mentions(dismissed)).toBe(false);
  });

  it('counts once posted, twice as a possible duplicate (the control for the test above)', async () => {
    const { amex } = seed();
    const before = (await get('/spending/summary')).body;
    repo.importCardTransactions({
      cardAccountId: amex.id, source: 'test-sync', parserVersion: 'test@1',
      rows: [hold(1, { status: 'posted', postedDate: '2026-10-06' }), hold(2, { status: 'posted', postedDate: '2026-10-06' })],
    });
    const after = await surfaces(amex.id);
    const usd = (totals: Array<{ currency: string; spendingMinor: number }>) => totals.find((item) => item.currency === 'USD')!.spendingMinor;
    expect(usd(after.counted.totals)).toBe(usd(before.totals) + 2 * ORDER);
    expect(mentions(after.counted.byMerchant)).toBe(true);
    expect(after.insights.duplicates).toEqual([expect.objectContaining({ merchant: 'SAMPLE MEGASTORE ONLINE', amountMinor: ORDER })]);
  });
});

describe('GET /spending/coverage', () => {
  it('reports merged ranges, gaps, stored dates and imports per card', async () => {
    const { amex, chase, euro } = seed();
    repo.importCardTransactions({
      cardAccountId: chase.id, source: 'test-sync', parserVersion: 'test@1', rows: [],
      coverage: { start: '2026-10-10', end: '2026-10-16' },
    });
    const res = await get('/spending/coverage');
    expect(res.status).toBe(200);
    const byCard = new Map(res.body.cards.map((item: { cardAccountId: string }) => [item.cardAccountId, item]));
    expect(byCard.get(amex.id)).toMatchObject({ ranges: [{ start: '2026-09-01', end: '2026-10-02' }], transactions: { count: 6, first: '2026-09-02', last: '2026-09-30' } });
    expect(byCard.get(chase.id)).toMatchObject({
      ranges: [{ start: '2026-09-01', end: '2026-10-04' }, { start: '2026-10-10', end: '2026-10-16' }],
      transactions: { count: 3, first: '2026-09-05', last: '2026-10-04' },
    });
    expect((byCard.get(chase.id) as { imports: Array<{ newCount: number }> }).imports.map((batch) => batch.newCount)).toEqual([0, 3]);
    expect(byCard.get(euro.id)).toMatchObject({ ranges: [], transactions: { count: 1 } });
    expect((await get('/spending/coverage?x=1')).status).toBe(400);
  });
});

describe('imports and the pending lifecycle over HTTP', () => {
  it('keeps pending charges out of spending, posts one in place, only suggests the other, and counts each once', async () => {
    const card = repo.createCardAccount({ issuer: 'samplebank', owner: 'casey', last4: '4004', currency: 'USD' });
    const sync = payload('samplebank', [
      { transactionDate: '2026-10-14', status: 'pending', amountMinor: 6400, kind: 'purchase', description: 'PROSEWARE BISTRO' },
      { transactionDate: '2026-10-13', status: 'pending', amountMinor: 2500, kind: 'purchase', description: 'FABRIKAM FUEL', externalId: 'AUTH-77' },
    ], { start: '2026-10-13', end: '2026-10-14' });
    const first = await commit(card.id, sync);
    expect(first.status).toBe(201);
    expect(first.body.warnings.map((warning: { code: string }) => warning.code)).toContain('pending-rows');
    const summary = async () => (await get('/spending/summary?from=2026-10-01&to=2026-10-31')).body;
    const spent = async () => (await summary()).totals[0]?.spendingMinor ?? 0;
    const pendingNet = async () => (await summary()).pending[0]?.netMinor ?? 0;
    expect(await spent()).toBe(0);
    expect(await pendingNet()).toBe(8900);

    // The statement: the bistro row has no reference, only a fingerprint matching the pending
    // row, so the owner decides it posted (pendingMatches=post); the fuel row posts under a new
    // reference, which only the owner can match to its pending row.
    const statement = payload('samplebank', [
      { transactionDate: '2026-10-14', postedDate: '2026-10-15', amountMinor: 6400, kind: 'purchase', description: 'PROSEWARE BISTRO' },
      { transactionDate: '2026-10-13', postedDate: '2026-10-15', amountMinor: 2500, kind: 'purchase', description: 'FABRIKAM FUEL 77', externalId: 'POST-77' },
    ], { start: '2026-10-01', end: '2026-10-15' });
    const preview = await post(`/card-imports/preview?cardAccountId=${card.id}`, statement);
    expect(preview.body).toMatchObject({ newCount: 1, duplicateCount: 1, pendingPostedCount: 0, pendingMatchCount: 1, pendingMatchRows: [0] });
    expect(preview.body.warnings.map((warning: { code: string }) => warning.code)).toContain('pending-matches');
    const undecided = await commit(card.id, statement);
    expect(undecided.status).toBe(409);
    expect(undecided.body).toMatchObject({ pendingMatchCount: 1, pendingMatchRows: [0] });
    expect((await post(`/card-imports/commit?cardAccountId=${card.id}&pendingMatches=maybe`, statement)).status).toBe(400);
    expect(await spent()).toBe(0);
    const second = await post(`/card-imports/commit?cardAccountId=${card.id}&pendingMatches=post`, statement);
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ imported: true, newCount: 1, duplicateCount: 1, pendingPostedCount: 1 });
    expect(await spent()).toBe(8900);
    const stillPending = (await get('/card-transactions?status=pending')).body.transactions as Array<{ id: string; description: string }>;
    expect(stillPending.map((item) => item.description)).toEqual(['FABRIKAM FUEL']);
    expect((await get(`/card-transactions/${stillPending[0].id}`)).body.possiblyPostedAs).toEqual([
      expect.objectContaining({ description: 'FABRIKAM FUEL 77', amountMinor: 2500, status: 'posted' }),
    ]);
    expect(await pendingNet()).toBe(2500);
    // The owner dismisses it: spending stays, the pending total drops.
    expect((await patch(`/card-transactions/${stillPending[0].id}`, { status: 'removed' })).status).toBe(200);
    expect((await get('/card-transactions?status=pending')).body.total).toBe(0);
    expect(await spent()).toBe(8900);
    expect(await pendingNet()).toBe(0);
    // Done before: nothing new, whichever way pending matches were decided.
    expect((await post(`/card-imports/commit?cardAccountId=${card.id}&pendingMatches=post`, statement)).body).toMatchObject({ imported: false });
    expect((await commit(card.id, statement)).body).toMatchObject({ imported: false, pendingMatchCount: 0 });
  });

  it('skips a fingerprint match on the owner\'s word, and never double-counts a shifted occurrence', async () => {
    const card = repo.createCardAccount({ issuer: 'samplebank', owner: 'alex', last4: '5005', currency: 'USD' });
    const bistro = { transactionDate: '2026-10-14', amountMinor: 5000, kind: 'purchase' as const, description: 'SAMPLE BISTRO' };
    // A still pending, B posted: same date, amount and text, no references.
    expect((await commit(card.id, payload('samplebank', [{ ...bistro, status: 'pending' }, { ...bistro, postedDate: '2026-10-15' }],
      { start: '2026-10-14', end: '2026-10-15' }))).status).toBe(201);
    const spent = async () => (await get(`/spending/summary?cardAccountId=${card.id}`)).body.totals[0]?.spendingMinor ?? 0;
    expect(await spent()).toBe(5000);
    // A posted-only export with just B: its fingerprint now names the pending row.
    const onlyB = payload('samplebank', [{ ...bistro, postedDate: '2026-10-15' }], { start: '2026-10-14', end: '2026-10-15' });
    expect((await post(`/card-imports/preview?cardAccountId=${card.id}`, onlyB)).body).toMatchObject({ pendingMatchCount: 1 });
    expect((await post(`/card-imports/commit?cardAccountId=${card.id}&pendingMatches=skip`, onlyB)).body).toMatchObject({ imported: false });
    expect(await spent()).toBe(5000);
    expect((await get(`/card-transactions?cardAccountId=${card.id}&status=pending`)).body.total).toBe(1);
  });

  it('asks the owner before a dismissed charge posts under its own reference, and keeps it dismissed until then', async () => {
    const card = repo.createCardAccount({ issuer: 'samplebank', owner: 'alex', last4: '6006', currency: 'USD' });
    const hold = { transactionDate: '2026-10-10', amountMinor: 2500, kind: 'purchase' as const, description: 'FABRIKAM HOTEL', externalId: 'AUTH-88' };
    const sync = payload('samplebank', [{ ...hold, status: 'pending' }], { start: '2026-10-10', end: '2026-10-10' });
    expect((await commit(card.id, sync)).status).toBe(201);
    const [held] = (await get(`/card-transactions?cardAccountId=${card.id}&status=pending`)).body.transactions as Array<{ id: string }>;
    expect((await patch(`/card-transactions/${held.id}`, { notes: 'synthetic note' })).status).toBe(200);
    expect((await patch(`/card-transactions/${held.id}`, { status: 'removed' })).status).toBe(200);
    // Seen pending again: a duplicate, with nothing to decide.
    expect((await post(`/card-imports/preview?cardAccountId=${card.id}`, sync)).body)
      .toMatchObject({ duplicateCount: 1, pendingPostedCount: 0, dismissedMatchCount: 0, dismissedMatchRows: [] });
    expect((await commit(card.id, sync)).body).toMatchObject({ imported: false });

    // The statement: the held charge posted under its reference with a tip, next to a new purchase.
    const statement = payload('samplebank', [
      { ...hold, postedDate: '2026-10-12', amountMinor: 2600 },
      { transactionDate: '2026-10-11', postedDate: '2026-10-12', amountMinor: 1500, kind: 'purchase', description: 'SAMPLE BOOKS', externalId: 'POST-90' },
    ], { start: '2026-10-01', end: '2026-10-12' });
    const preview = await post(`/card-imports/preview?cardAccountId=${card.id}`, statement);
    expect(preview.body).toMatchObject({
      newCount: 1, duplicateCount: 1, pendingPostedCount: 0, pendingMatchCount: 0, dismissedMatchCount: 1, dismissedMatchRows: [0],
    });
    expect(preview.body.warnings.map((warning: { code: string }) => warning.code)).toContain('dismissed-matches');
    const undecided = await commit(card.id, statement);
    expect(undecided.status).toBe(409);
    expect(undecided.body).toMatchObject({ dismissedMatchCount: 1, dismissedMatchRows: [0] });
    expect(undecided.body.error).toMatch(/dismissedMatches=post or dismissedMatches=keep$/);
    // The decision on fingerprint matches is not this one.
    expect((await post(`/card-imports/commit?cardAccountId=${card.id}&pendingMatches=post`, statement)).status).toBe(409);
    const bad = await post(`/card-imports/commit?cardAccountId=${card.id}&dismissedMatches=maybe`, statement);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('dismissedMatches must be post or keep');
    expect(JSON.stringify(bad.body)).not.toContain('maybe');
    const spent = async () => (await get(`/spending/summary?cardAccountId=${card.id}`)).body.totals[0]?.spendingMinor ?? 0;
    expect(await spent()).toBe(0);

    const kept = await post(`/card-imports/commit?cardAccountId=${card.id}&dismissedMatches=keep`, statement);
    expect(kept.status).toBe(201);
    expect(kept.body).toMatchObject({ imported: true, newCount: 1, duplicateCount: 1, pendingPostedCount: 0 });
    expect((await get(`/card-transactions/${held.id}`)).body.transaction).toMatchObject({ status: 'removed', amountMinor: 2500 });
    expect(await spent()).toBe(1500);

    // The same statement again, and this time the owner says it did post after all: the dismissed
    // row itself turns posted with the posted amount, keeping its notes.
    const posting = await post(`/card-imports/commit?cardAccountId=${card.id}&dismissedMatches=post`, statement);
    expect(posting.status).toBe(201);
    expect(posting.body).toMatchObject({ imported: true, newCount: 0, duplicateCount: 2, pendingPostedCount: 1 });
    expect((await get(`/card-transactions/${held.id}`)).body.transaction)
      .toMatchObject({ status: 'posted', amountMinor: 2600, postedDate: '2026-10-12', notes: 'synthetic note' });
    expect(await spent()).toBe(4100);
    expect((await commit(card.id, statement)).body).toMatchObject({ imported: false, dismissedMatchCount: 0 });
  });
});

describe('pending semantics in file imports', () => {
  const totals = async (cardId: string) => (await get(`/spending/summary?cardAccountId=${cardId}`)).body;
  const spentOn = async (cardId: string) => (await totals(cardId)).totals[0]?.spendingMinor ?? 0;
  const pendingOn = async (cardId: string) => (await totals(cardId)).pending[0]?.netMinor ?? 0;

  it('shows each fingerprint match with its pending row and any posted twin, and never adds the twin\'s purchase twice', async () => {
    const card = repo.createCardAccount({ issuer: 'samplebank', owner: 'alex', last4: '7007', currency: 'USD' });
    const bistro = { transactionDate: '2026-10-14', amountMinor: 5000, kind: 'purchase' as const, description: 'SAMPLE BISTRO' };
    // A still pending, B posted: same date, amount and text, no references.
    expect((await commit(card.id, payload('samplebank', [{ ...bistro, status: 'pending' }, { ...bistro, postedDate: '2026-10-15' }],
      { start: '2026-10-14', end: '2026-10-15' }))).status).toBe(201);
    const [pendingA] = (await get(`/card-transactions?cardAccountId=${card.id}&status=pending`)).body.transactions as Array<{ id: string }>;
    const [postedB] = (await get(`/card-transactions?cardAccountId=${card.id}&status=posted`)).body.transactions as Array<{ id: string }>;
    // A posted-only export with just B: B's fingerprint now names A.
    const onlyB = payload('samplebank', [{ ...bistro, postedDate: '2026-10-15' }], { start: '2026-10-14', end: '2026-10-15' });
    const preview = (await post(`/card-imports/preview?cardAccountId=${card.id}`, onlyB)).body;
    expect(preview).toMatchObject({ pendingMatchCount: 1, pendingMatchesWithPostedTwinCount: 1 });
    expect(preview.pendingMatchDetails).toEqual([{
      row: 0,
      pending: expect.objectContaining({ id: pendingA.id, status: 'pending', dismissed: false, amountMinor: 5000, description: 'SAMPLE BISTRO', postedDate: null }),
      postedTwinCount: 1,
      postedTwins: [expect.objectContaining({ id: postedB.id, status: 'posted', postedDate: '2026-10-15', amountMinor: 5000 })],
      postedTwinsInFileCount: 0,
    }]);
    // Ids and texts the owner already sees; never a dedupe key.
    expect(JSON.stringify(preview)).not.toMatch(/(xid|cfp)\d:/);
    expect(preview.warnings.find((warning: { code: string }) => warning.code === 'pending-matches').message)
      .toMatch(/does not prove .*pendingMatches=post .*pendingMatches=skip leaves the pending row as it is .*pendingMatches=import/);
    // Another purchase is refused while a posted twin is stored: that would count B twice.
    const refused = await post(`/card-imports/commit?cardAccountId=${card.id}&pendingMatches=import`, onlyB);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/commit with pendingMatches=skip, pendingMatches=split or pendingMatches=post$/);
    expect(refused.body).toMatchObject({ pendingMatchCount: 1, pendingMatchRows: [0] });
    expect(await spentOn(card.id)).toBe(5000);
    expect((await post(`/card-imports/commit?cardAccountId=${card.id}&pendingMatches=skip`, onlyB)).body).toMatchObject({ imported: false });
    expect(await spentOn(card.id)).toBe(5000);
    expect(await pendingOn(card.id)).toBe(5000);
  });

  it('does not take a stored posted row that another row of the file is for a twin, so a charge that posted is not left pending', async () => {
    const card = repo.createCardAccount({ issuer: 'samplebank', owner: 'alex', last4: '7171', currency: 'USD' });
    const bistro = { transactionDate: '2026-10-14', amountMinor: 5000, kind: 'purchase' as const, description: 'SAMPLE BISTRO' };
    // A still pending, B posted: same date, amount and text, no references (occurrences 0 and 1).
    expect((await commit(card.id, payload('samplebank', [{ ...bistro, status: 'pending' }, { ...bistro, postedDate: '2026-10-15' }],
      { start: '2026-10-14', end: '2026-10-15' }))).status).toBe(201);
    const [pendingA] = (await get(`/card-transactions?cardAccountId=${card.id}&status=pending`)).body.transactions as Array<{ id: string }>;
    // Both posted now: occurrence 0 names A, and occurrence 1 is B itself, so B is no sign that row 0 repeats it.
    const both = payload('samplebank', [{ ...bistro, postedDate: '2026-10-15' }, { ...bistro, postedDate: '2026-10-15' }],
      { start: '2026-10-14', end: '2026-10-15' });
    const preview = (await post(`/card-imports/preview?cardAccountId=${card.id}`, both)).body;
    expect(preview).toMatchObject({ pendingMatchCount: 1, pendingMatchesWithPostedTwinCount: 0, possibleDuplicateCount: 0 });
    expect(preview.pendingMatchDetails).toEqual([{
      row: 0,
      pending: expect.objectContaining({ id: pendingA.id, status: 'pending' }),
      postedTwinCount: 0,
      postedTwins: [],
      postedTwinsInFileCount: 1,
    }]);
    const posted = await post(`/card-imports/commit?cardAccountId=${card.id}&pendingMatches=post`, both);
    expect(posted.status).toBe(201);
    expect(posted.body).toMatchObject({ imported: true, newCount: 0, pendingPostedCount: 1 });
    expect(await spentOn(card.id)).toBe(10000);
    expect(await pendingOn(card.id)).toBe(0);
    expect((await commit(card.id, both)).body).toMatchObject({ imported: false, pendingMatchCount: 0 });
    expect(await spentOn(card.id)).toBe(10000);
  });

  it('posts the matches without a posted twin and skips the others on the owner\'s split, when one answer fits not all', async () => {
    const card = repo.createCardAccount({ issuer: 'samplebank', owner: 'joint', last4: '7272', currency: 'USD' });
    const bistro = { transactionDate: '2026-10-14', amountMinor: 5000, kind: 'purchase' as const, description: 'SAMPLE BISTRO' };
    const cinema = { transactionDate: '2026-10-14', amountMinor: 7000, kind: 'purchase' as const, description: 'SAMPLE CINEMA' };
    // A and C still pending, B and D posted: two pairs with the same date, amount and text, no references.
    expect((await commit(card.id, payload('samplebank', [
      { ...bistro, status: 'pending' }, { ...bistro, postedDate: '2026-10-15' },
      { ...cinema, status: 'pending' }, { ...cinema, postedDate: '2026-10-15' },
    ], { start: '2026-10-14', end: '2026-10-15' }))).status).toBe(201);
    expect(await spentOn(card.id)).toBe(12000);
    // A posted (with B), C still pending: the file has A, B and D, posted.
    const mixed = payload('samplebank', [
      { ...bistro, postedDate: '2026-10-15' }, { ...bistro, postedDate: '2026-10-15' }, { ...cinema, postedDate: '2026-10-15' },
    ], { start: '2026-10-14', end: '2026-10-15' });
    const preview = (await post(`/card-imports/preview?cardAccountId=${card.id}`, mixed)).body;
    expect(preview).toMatchObject({ pendingMatchCount: 2, pendingMatchesWithPostedTwinCount: 1 });
    expect(preview.pendingMatchDetails.map((match: { row: number; postedTwinCount: number; postedTwinsInFileCount: number }) =>
      [match.row, match.postedTwinCount, match.postedTwinsInFileCount])).toEqual([[0, 0, 1], [2, 1, 0]]);
    expect(preview.warnings.find((warning: { code: string }) => warning.code === 'pending-matches').message)
      .toMatch(/pendingMatches=split posts the ones with no such posted row stored .* and skips the others/);
    // Neither answer for all fits: skip leaves A pending, post would count D twice. Split does both.
    const split = await post(`/card-imports/commit?cardAccountId=${card.id}&pendingMatches=split`, mixed);
    expect(split.status).toBe(201);
    expect(split.body).toMatchObject({ imported: true, newCount: 0, pendingPostedCount: 1, pendingMatchesInsertedCount: 0 });
    expect(await spentOn(card.id)).toBe(17000);
    expect(await pendingOn(card.id)).toBe(7000);
    const stored = repo.listCardTransactions({ cardAccountId: card.id });
    expect(stored.filter((row) => row.status === 'pending').map((row) => row.description)).toEqual(['SAMPLE CINEMA']);
    // Replayed, C still matches D's row and D is still its twin: split skips it again, and nothing changes.
    expect((await post(`/card-imports/commit?cardAccountId=${card.id}&pendingMatches=split`, mixed)).body)
      .toMatchObject({ imported: false, pendingMatchCount: 1, pendingPostedCount: 0 });
    expect(await spentOn(card.id)).toBe(17000);
    expect(await pendingOn(card.id)).toBe(7000);
  });

  it('adds a different purchase on the owner\'s word, leaves the pending row, and asks again on a replay', async () => {
    const card = repo.createCardAccount({ issuer: 'samplebank', owner: 'casey', last4: '8008', currency: 'USD' });
    const hold = { transactionDate: '2026-10-14', amountMinor: 5000, kind: 'purchase' as const, description: 'SAMPLE HOTEL' };
    expect((await commit(card.id, payload('samplebank', [{ ...hold, status: 'pending' }], { start: '2026-10-14', end: '2026-10-14' }))).status).toBe(201);
    // The statement has another purchase with the same date, amount and text, while the hold still holds.
    const statement = payload('samplebank', [{ ...hold, postedDate: '2026-10-15' }], { start: '2026-10-01', end: '2026-10-15' });
    const preview = (await post(`/card-imports/preview?cardAccountId=${card.id}`, statement)).body;
    expect(preview).toMatchObject({ pendingMatchCount: 1, pendingMatchesWithPostedTwinCount: 0 });
    expect(preview.pendingMatchDetails[0]).toMatchObject({ postedTwinCount: 0, postedTwins: [] });
    const bad = await post(`/card-imports/commit?cardAccountId=${card.id}&pendingMatches=maybe`, statement);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('pendingMatches must be post, skip, split or import');
    expect((await commit(card.id, statement)).body.error).toMatch(/pendingMatches=post, pendingMatches=skip, pendingMatches=split or pendingMatches=import$/);
    const added = await post(`/card-imports/commit?cardAccountId=${card.id}&pendingMatches=import`, statement);
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ imported: true, newCount: 1, duplicateCount: 0, pendingPostedCount: 0, pendingMatchesInsertedCount: 1 });
    expect(await spentOn(card.id)).toBe(5000);
    expect(await pendingOn(card.id)).toBe(5000);
    const stored = repo.listCardTransactions({ cardAccountId: card.id });
    expect(stored.map((row) => row.status).sort()).toEqual(['pending', 'posted']);
    expect(new Set(stored.map((row) => row.fingerprint)).size).toBe(2);
    // The same statement again: the match comes back with the added row as its posted twin, so
    // adding it again is refused and skipping changes nothing.
    expect((await post(`/card-imports/preview?cardAccountId=${card.id}`, statement)).body)
      .toMatchObject({ pendingMatchCount: 1, pendingMatchesWithPostedTwinCount: 1 });
    expect((await post(`/card-imports/commit?cardAccountId=${card.id}&pendingMatches=import`, statement)).status).toBe(409);
    expect((await post(`/card-imports/commit?cardAccountId=${card.id}&pendingMatches=skip`, statement)).body).toMatchObject({ imported: false });
    expect(await spentOn(card.id)).toBe(5000);
    expect(await pendingOn(card.id)).toBe(5000);
  });

  it('lists the pending rows a closed statement leaves out, and dismisses them only on the owner\'s word', async () => {
    const card = repo.createCardAccount({ issuer: 'samplebank', owner: 'joint', last4: '9009', currency: 'USD' });
    const sync = payload('samplebank', [
      { transactionDate: '2026-09-03', status: 'pending', amountMinor: 1625000, kind: 'purchase', description: 'SAMPLE MEGASTORE ORDER', externalId: 'AUTH-1' },
      { transactionDate: '2026-09-05', status: 'pending', amountMinor: 4200, kind: 'purchase', description: 'SAMPLE GROCER', externalId: 'AUTH-2' },
      { transactionDate: '2026-09-27', status: 'pending', amountMinor: 1800, kind: 'purchase', description: 'SAMPLE CINEMA', externalId: 'AUTH-3' },
    ], { start: '2026-09-03', end: '2026-09-27' });
    const first = await commit(card.id, sync);
    expect(first.status).toBe(201);
    const pendingWarning = first.body.warnings.find((warning: { code: string }) => warning.code === 'pending-rows').message;
    expect(pendingWarning).toMatch(/same issuer reference.*pendingMatches=post.*dismiss it or name its posted row/);
    // The closed statement (September): the grocer posted under its reference; the order never
    // did; the cinema, 3 days before the close, may still post in October.
    const statement = payload('samplebank', [
      { transactionDate: '2026-09-05', postedDate: '2026-09-06', amountMinor: 4200, kind: 'purchase', description: 'SAMPLE GROCER', externalId: 'AUTH-2' },
      { transactionDate: '2026-09-12', postedDate: '2026-09-13', amountMinor: 900, kind: 'purchase', description: 'SAMPLE BAKERY', externalId: 'POST-9' },
    ], { start: '2026-09-01', end: '2026-09-30' });
    const preview = (await post(`/card-imports/preview?cardAccountId=${card.id}`, statement)).body;
    expect(preview).toMatchObject({ stalePendingCount: 1, pendingPostedCount: 1 });
    expect(preview.stalePendingRows).toEqual([expect.objectContaining({
      status: 'pending', amountMinor: 1625000, description: 'SAMPLE MEGASTORE ORDER', transactionDate: '2026-09-03',
    })]);
    expect(preview.warnings.map((warning: { code: string }) => warning.code)).toContain('stale-pending');
    // The warning claims no outcome: a hold can still settle after the statement closes.
    const staleWarning = preview.warnings.find((warning: { code: string }) => warning.code === 'stale-pending')?.message;
    expect(staleWarning).toMatch(/does not prove they were cancelled.*settles after it closes.*stalePending=keep, the default/);
    // Without the owner's word nothing is dismissed: absence is no proof of cancellation.
    const kept = await commit(card.id, statement);
    expect(kept.status).toBe(201);
    expect(kept.body).toMatchObject({ stalePendingDismissedCount: 0, pendingPostedCount: 1 });
    expect(await spentOn(card.id)).toBe(5100);
    expect(await pendingOn(card.id)).toBe(1625000 + 1800);
    const badDecision = await post(`/card-imports/commit?cardAccountId=${card.id}&stalePending=maybe`, statement);
    expect(badDecision.status).toBe(400);
    expect(badDecision.body.error).toBe('stalePending must be dismiss or keep');
    // The same statement, now with the owner's word: only the order goes; spending stays.
    const dismissed = await post(`/card-imports/commit?cardAccountId=${card.id}&stalePending=dismiss`, statement);
    expect(dismissed.status).toBe(201);
    expect(dismissed.body).toMatchObject({ imported: true, newCount: 0, stalePendingDismissedCount: 1 });
    expect(await spentOn(card.id)).toBe(5100);
    expect(await pendingOn(card.id)).toBe(1800);
    const order = repo.listCardTransactions({ cardAccountId: card.id }).find((row) => row.description === 'SAMPLE MEGASTORE ORDER')!;
    expect(order.status).toBe('removed');
    expect(order.dismissedAt).toBeTruthy();
    // Replaying either file brings nothing back, and there is nothing stale left to list.
    expect((await commit(card.id, sync)).body).toMatchObject({ imported: false });
    expect((await post(`/card-imports/preview?cardAccountId=${card.id}`, statement)).body).toMatchObject({ stalePendingCount: 0, stalePendingRows: [] });
    expect(await pendingOn(card.id)).toBe(1800);
    // A file with pending rows is no closed statement: nothing is listed, and dismissing is refused.
    expect((await post(`/card-imports/preview?cardAccountId=${card.id}`, sync)).body).toMatchObject({ stalePendingCount: 0 });
    const refused = await post(`/card-imports/commit?cardAccountId=${card.id}&stalePending=dismiss`, sync);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('stalePending=dismiss needs an import without pending rows, such as a closed statement');
  });

  it('merges a pending row into the posted row the owner names, keeping its edits and keeping it from coming back', async () => {
    const card = repo.createCardAccount({ issuer: 'samplebank', owner: 'alex', last4: '1212', currency: 'USD' });
    const other = repo.createCardAccount({ issuer: 'samplebank', owner: 'alex', last4: '3434', currency: 'USD' });
    const sync = payload('samplebank', [
      { transactionDate: '2026-10-10', status: 'pending', amountMinor: 3200, kind: 'purchase', description: 'FABRIKAM FUEL', externalId: 'AUTH-31' },
    ], { start: '2026-10-10', end: '2026-10-10' });
    // The issuer posted it under another reference and wording.
    const statement = payload('samplebank', [
      { transactionDate: '2026-10-10', postedDate: '2026-10-12', amountMinor: 3200, kind: 'purchase', description: 'FABRIKAM FUEL 31', externalId: 'POST-31' },
    ], { start: '2026-10-01', end: '2026-10-12' });
    expect((await commit(card.id, sync)).status).toBe(201);
    expect((await commit(card.id, statement)).status).toBe(201);
    expect((await commit(other.id, payload('samplebank', [
      { transactionDate: '2026-10-10', postedDate: '2026-10-11', amountMinor: 3200, kind: 'purchase', description: 'FABRIKAM FUEL', externalId: 'ELSE-1' },
    ], { start: '2026-10-10', end: '2026-10-11' }))).status).toBe(201);
    const pendingRow = repo.listCardTransactions({ cardAccountId: card.id }).find((row) => row.status === 'pending')!;
    const postedRow = repo.listCardTransactions({ cardAccountId: card.id }).find((row) => row.status === 'posted')!;
    const [elsewhere] = repo.listCardTransactions({ cardAccountId: other.id });
    expect((await patch(`/card-transactions/${pendingRow.id}`, { userCategory: 'Road trip', notes: 'synthetic note' })).status).toBe(200);
    expect((await get(`/card-transactions/${pendingRow.id}`)).body.possiblyPostedAs).toEqual([expect.objectContaining({ id: postedRow.id })]);
    expect(await pendingOn(card.id)).toBe(3200);
    expect(await spentOn(card.id)).toBe(3200);

    for (const [body, message] of [
      [{ postedAs: postedRow.id, notes: 'x' }, 'postedAs cannot be combined with other changes'],
      [{ postedAs: 7 }, 'postedAs must be a card transaction id'],
      [{ postedAs: 'not an id!' }, 'postedAs must be a card transaction id'],
      [{ postedAs: pendingRow.id }, 'postedAs must be a posted transaction of the same card account and currency'],
      [{ postedAs: elsewhere.id }, 'postedAs must be a posted transaction of the same card account and currency'],
      [{ postedAs: 'card-txn-missing' }, 'postedAs must be a posted transaction of the same card account and currency'],
    ] as const) {
      const res = await patch(`/card-transactions/${pendingRow.id}`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toBe(message);
    }
    expect(await pendingOn(card.id)).toBe(3200);

    const merged = await patch(`/card-transactions/${pendingRow.id}`, { postedAs: postedRow.id });
    expect(merged.status).toBe(200);
    expect(merged.body).toMatchObject({ id: pendingRow.id, status: 'removed' });
    expect(merged.body.dismissedAt).toBeTruthy();
    expect((await get(`/card-transactions/${postedRow.id}`)).body.transaction)
      .toMatchObject({ status: 'posted', userCategory: 'Road trip', notes: 'synthetic note' });
    expect(await pendingOn(card.id)).toBe(0);
    expect(await spentOn(card.id)).toBe(3200);
    const again = await patch(`/card-transactions/${pendingRow.id}`, { postedAs: postedRow.id });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('only a pending card transaction can be matched to its posted row');
    // Replaying either export brings nothing back.
    expect((await commit(card.id, sync)).body).toMatchObject({ imported: false });
    expect((await commit(card.id, statement)).body).toMatchObject({ imported: false });
    expect(await pendingOn(card.id)).toBe(0);
    expect(await spentOn(card.id)).toBe(3200);
  });

  // KNOWN GAP (D14; slice 2 review r1 rejected D14 as final v15 semantics): `postedAs` is a dismissal, not the design's
  // merge (identity re-point, then `settled-into`, undone by unmerge). When the pending row's own reference later posts
  // and the owner says dismissed matches did post (dismissedMatches=post), the pending row posts again beside the row it
  // was named as, so one purchase is two posted rows. This pins today's behaviour on purpose; the coordinated Phase 4
  // follow-up (the Phase 4 UI) changes `postedAs` to the merge model and flips this test to one posted row.
  it('known gap (D14): a postedAs-dismissed pending row posts again beside its posted row when its own reference posts', async () => {
    const card = repo.createCardAccount({ issuer: 'samplebank', owner: 'alex', last4: '5656', currency: 'USD' });
    const sync = payload('samplebank', [
      { transactionDate: '2026-10-10', status: 'pending', amountMinor: 3200, kind: 'purchase', description: 'FABRIKAM FUEL', externalId: 'AUTH-41' },
    ], { start: '2026-10-10', end: '2026-10-10' });
    const statement = payload('samplebank', [
      { transactionDate: '2026-10-10', postedDate: '2026-10-12', amountMinor: 3200, kind: 'purchase', description: 'FABRIKAM FUEL 41', externalId: 'POST-41' },
    ], { start: '2026-10-01', end: '2026-10-12' });
    expect((await commit(card.id, sync)).status).toBe(201);
    expect((await commit(card.id, statement)).status).toBe(201);
    const pendingRow = repo.listCardTransactions({ cardAccountId: card.id }).find((row) => row.status === 'pending')!;
    const postedRow = repo.listCardTransactions({ cardAccountId: card.id }).find((row) => row.status === 'posted')!;
    expect((await patch(`/card-transactions/${pendingRow.id}`, { postedAs: postedRow.id })).status).toBe(200);
    expect(await spentOn(card.id)).toBe(3200);
    // A later export lists the purchase as posted under the pending row's own reference.
    const late = payload('samplebank', [
      { transactionDate: '2026-10-10', postedDate: '2026-10-12', amountMinor: 3200, kind: 'purchase', description: 'FABRIKAM FUEL', externalId: 'AUTH-41' },
    ], { start: '2026-10-01', end: '2026-10-12' });
    const posting = await post(`/card-imports/commit?cardAccountId=${card.id}&dismissedMatches=post`, late);
    expect(posting.status).toBe(201);
    expect(posting.body).toMatchObject({ imported: true, newCount: 0, pendingPostedCount: 1 });
    // Today: both rows are posted and spending counts the purchase twice (the merge model leaves one row and 3200).
    const posted = repo.listCardTransactions({ cardAccountId: card.id }).filter((row) => row.status === 'posted');
    expect(posted.map((row) => row.id).sort()).toEqual([pendingRow.id, postedRow.id].sort());
    expect(await spentOn(card.id)).toBe(6400);
  });
});

describe('card payments and brokerage cash', () => {
  let fingerprints = 0;
  function brokerage(id: string, name: string, currency = 'USD') {
    repo.createAccount({ id, name, cashBalance: 1000, currency, accountNumber: 'Z7418763' });
  }
  function cashEvent(accountId: string, event: Partial<CashEventInput> = {}) {
    fingerprints += 1;
    repo.insertCashEvent({
      accountId, date: '2026-09-26', eventType: 'withdrawal', amount: -600, currency: 'USD', broker: 'fidelity',
      accountLast4: '8763', description: 'Electronic Funds Transfer Paid (Cash)',
      sourceFingerprint: fingerprints.toString(16).padStart(64, 'f'), ...event,
    });
  }
  const payments = (cardAccountId: string) =>
    repo.queryCardTransactions({ cardAccountId, kinds: ['payment'], statuses: ['pending', 'posted', 'removed'] }).transactions;
  const changes = () => (repo.internalGetDb().prepare('SELECT total_changes() AS n').get() as { n: number }).n;

  it('lists the brokerage withdrawals and outgoing transfers a payment may have come from, closest first, without ids or card data', async () => {
    const { amex } = seed();
    brokerage('fid', 'Fidelity Individual');
    brokerage('fid-eur', 'Sample Euro Brokerage', 'EUR');
    const pan = syntheticCardNumber();
    // A name or description that could carry card data is never shown.
    brokerage('odd', `Brokerage ${pan}`);
    cashEvent('fid');
    cashEvent('odd', { date: '2026-09-24', description: `ACH PMT ${'9'.repeat(13)}` });
    cashEvent('fid', { date: '2026-09-28', eventType: 'transfer', description: '  TRANSFERRED TO\n SAMPLE BANK ' });
    cashEvent('fid', { date: '2026-09-29' });
    // Never: a fee, money in, a cent more, six days after, or the same number in euros.
    cashEvent('fid', { date: '2026-09-25', eventType: 'fee', description: 'SAMPLE FEE' });
    cashEvent('fid', { date: '2026-09-25', eventType: 'transfer', amount: 600, description: 'TRANSFER IN' });
    cashEvent('fid', { date: '2026-09-25', eventType: 'deposit', amount: 600, description: 'SAMPLE DEPOSIT' });
    cashEvent('fid', { date: '2026-09-25', amount: -600.01 });
    cashEvent('fid', { date: '2026-10-01' });
    cashEvent('fid-eur', { date: '2026-09-25', currency: 'EUR' });

    const [payment] = payments(amex.id);
    const res = await get(`/card-transactions/${payment.id}`);
    expect(res.status).toBe(200);
    expect(res.body.transaction).toMatchObject({ kind: 'payment', role: 'transfer', amountMinor: -60000 });
    expect(res.body.possiblyPostedAs).toEqual([]);
    // At most three, closest first (the earlier one on a tie); the fourth, four days after, is left out.
    expect(res.body.possiblyPaidFrom).toEqual([
      { accountName: 'Brokerage account', date: '2026-09-24', eventType: 'withdrawal', amountMinor: -60000, currency: 'USD', dayOffset: -1 },
      {
        accountName: 'Fidelity Individual', date: '2026-09-26', eventType: 'withdrawal', amountMinor: -60000, currency: 'USD', dayOffset: 1,
        description: 'Electronic Funds Transfer Paid (Cash)',
      },
      {
        accountName: 'Fidelity Individual', date: '2026-09-28', eventType: 'transfer', amountMinor: -60000, currency: 'USD', dayOffset: 3,
        description: 'TRANSFERRED TO SAMPLE BANK',
      },
    ]);
    // No cash event, account or fingerprint ids, account numbers or card data.
    for (const text of ['cash-', '"fid', 'Z7418763', '8763', 'ffffffff', pan.slice(4, 12)]) expect(res.text).not.toContain(text);
    expect(res.text).not.toMatch(/\d{13}/);

    // A purchase or a refund has none; a pending payment does, until it is dismissed.
    const hotel = repo.queryCardTransactions({ search: 'lisboa' }).transactions[0];
    expect((await get(`/card-transactions/${hotel.id}`)).body.possiblyPaidFrom).toEqual([]);
    const refund = repo.queryCardTransactions({ kinds: ['refund'] }).transactions[0];
    expect((await get(`/card-transactions/${refund.id}`)).body.possiblyPaidFrom).toEqual([]);
    repo.importCardTransactions({
      cardAccountId: amex.id, source: 'test-sync', parserVersion: 'test@1',
      rows: [row({ status: 'pending', postedDate: null, transactionDate: '2026-10-03', amountMinor: -60000, kind: 'payment', description: 'PAYMENT PENDING', issuerCategory: null })],
    });
    const pending = payments(amex.id).find((item) => item.status === 'pending')!;
    expect((await get(`/card-transactions/${pending.id}`)).body.possiblyPaidFrom).toEqual([
      expect.objectContaining({ date: '2026-10-01', dayOffset: -2, eventType: 'withdrawal' }),
      expect.objectContaining({ date: '2026-09-29', dayOffset: -4, eventType: 'withdrawal' }),
      expect.objectContaining({ date: '2026-09-28', dayOffset: -5, eventType: 'transfer' }),
    ]);
    expect((await patch(`/card-transactions/${pending.id}`, { status: 'removed' })).status).toBe(200);
    expect((await get(`/card-transactions/${pending.id}`)).body.possiblyPaidFrom).toEqual([]);
  });

  it('counts posted payments that look paid from brokerage cash, each from a different outflow, and changes no total', async () => {
    const { amex, chase } = seed();
    // A second payment of the same amount on another card, two days later.
    repo.importCardTransactions({
      cardAccountId: chase.id, source: 'test-sync', parserVersion: 'test@1',
      rows: [row({ transactionDate: '2026-09-27', postedDate: '2026-09-28', amountMinor: -60000, kind: 'payment', description: 'ONLINE PAYMENT THANK YOU', issuerCategory: null })],
    });
    const september = async (query = '') => (await get(`/spending/summary?from=2026-09-01&to=2026-09-30${query}`)).body;
    const before = await september();
    expect(before.paymentsPossiblyPaidFrom).toEqual([{ currency: 'USD', count: 0 }]);
    brokerage('fid', 'Fidelity Individual');
    cashEvent('fid');
    // One withdrawal suits both payments, but pays only one of them.
    expect((await september()).paymentsPossiblyPaidFrom).toEqual([{ currency: 'USD', count: 1 }]);
    cashEvent('fid', { date: '2026-09-29', eventType: 'transfer', description: 'TRANSFERRED TO SAMPLE BANK' });
    const after = await september();
    expect(after.paymentsPossiblyPaidFrom).toEqual([{ currency: 'USD', count: 2 }]);
    // Spending, payments and every other figure are the card rows' own.
    const figures = ({ paymentsPossiblyPaidFrom: _counts, ...rest }: Record<string, unknown>) => rest;
    expect(figures(after)).toEqual(figures(before));
    // The same filters as the totals: one card, or a month without payments.
    expect((await september(`&cardAccountId=${amex.id}`)).paymentsPossiblyPaidFrom).toEqual([{ currency: 'USD', count: 1 }]);
    expect((await get('/spending/summary?from=2026-10-01&to=2026-10-31')).body.paymentsPossiblyPaidFrom).toEqual([]);
    // Pending payments are not in the payment totals, so they are not counted here either.
    repo.importCardTransactions({
      cardAccountId: amex.id, source: 'test-sync', parserVersion: 'test@1',
      rows: [row({ status: 'pending', postedDate: null, transactionDate: '2026-09-30', amountMinor: -60000, kind: 'payment', description: 'PAYMENT PENDING', issuerCategory: null })],
    });
    cashEvent('fid', { date: '2026-09-30' });
    expect((await september()).paymentsPossiblyPaidFrom).toEqual([{ currency: 'USD', count: 2 }]);
  });

  it('never shows a name or description in which invisible characters could hide card data', async () => {
    const { amex } = seed();
    const pan = syntheticCardNumber();
    // Over HTTP, as the Accounts tab creates them: a name can hold any character.
    for (const [id, name] of [['nul', `Brokerage ${pan.split('').join('\u0000')}`], ['secret', 'Brokerage cvv\u0000: 123']]) {
      const created = await request(await listenLoopback(app)).post('/accounts').send({ id, name, cashBalance: 1000, currency: 'USD', accountNumber: 'Z7418763' });
      expect(created.status).toBe(201);
    }
    brokerage('zero-width', 'Sample Brokerage');
    // A combining mark on each digit; an accent on a letter is fine.
    brokerage('marks', `Brokerage ${pan.split('').join('\u0301')}`);
    brokerage('accents', 'Courtier Société Générale');
    cashEvent('nul');
    cashEvent('secret', { description: 'TRANSFER \u202eKNAB ELPMAS' });
    cashEvent('zero-width', { description: `TRANSFER ${pan.slice(0, 6)}\u200b${pan.slice(6)}` });
    cashEvent('marks', { date: '2026-09-24' });
    cashEvent('accents', { date: '2026-09-23', description: 'Virement Societe\u0301 Ge\u0301ne\u0301rale' });

    const [payment] = payments(amex.id);
    const shown = { eventType: 'withdrawal', amountMinor: -60000, currency: 'USD' };
    const next = { ...shown, date: '2026-09-26', dayOffset: 1 };
    const leaks = ['\u0000', '\\u0000', '\u200b', '\u202e', '\u0301', 'cvv', pan.slice(0, 6), pan.slice(6, 12)];
    const first = await get(`/card-transactions/${payment.id}`);
    expect(first.body.possiblyPaidFrom).toEqual([
      { accountName: 'Brokerage account', ...shown, date: '2026-09-24', dayOffset: -1, description: 'Electronic Funds Transfer Paid (Cash)' },
      { accountName: 'Brokerage account', ...next, description: 'Electronic Funds Transfer Paid (Cash)' },
      { accountName: 'Brokerage account', ...next },
    ]);
    for (const text of leaks) expect(first.text).not.toContain(text);
    expect(first.text).not.toMatch(/\d{13}/);
    // With those three gone, the other two: accents on letters are shown as they are.
    for (const accountId of ['marks', 'nul', 'secret']) for (const event of repo.listCashEvents(accountId)) repo.deleteCashEvent(event.id);
    const second = await get(`/card-transactions/${payment.id}`);
    expect(second.body.possiblyPaidFrom).toEqual([
      { accountName: 'Sample Brokerage', ...next },
      { accountName: 'Courtier Société Générale', ...shown, date: '2026-09-23', dayOffset: -2, description: 'Virement Societe\u0301 Ge\u0301ne\u0301rale' },
    ]);
    for (const text of leaks.filter((item) => item !== '\u0301')) expect(second.text).not.toContain(text);
    expect(second.text).not.toMatch(/\d{13}/);
  });

  it('shows a brokerage name or description only without digits, whatever its separators, labels or script', async () => {
    const { amex } = seed();
    const [payment] = payments(amex.id);
    const pan = syntheticCardNumber();
    const groups = pan.match(/.{4}/g)!;
    let cases = 0;
    // One brokerage account and withdrawal per case, so each is the payment's only suggestion.
    const suggestion = async (name: string, description: string) => {
      const id = `case-${(cases += 1)}`;
      brokerage(id, name);
      cashEvent(id, { description });
      const res = await get(`/card-transactions/${payment.id}`);
      for (const event of repo.listCashEvents(id)) repo.deleteCashEvent(event.id);
      return res;
    };
    const withheld = [{ accountName: 'Brokerage account', date: '2026-09-26', eventType: 'withdrawal', amountMinor: -60000, currency: 'USD', dayOffset: 1 }];
    for (const text of [
      // Separators the detectors do not join, and labels with other delimiters, an accent or a Cyrillic letter.
      `Brokerage ${groups.join('+')}`, 'Brokerage CVV / 123', 'Brokerage Expiry / 04/29', 'Brokerage cv\u0301v: 123', 'Brokerage \u0441vv: 123',
      // Digits in other forms: full-width, superscript, circled and Arabic-Indic.
      'PIN \uff11\uff12\uff13\uff14', 'Code \u00b9\u00b2\u00b3', 'Code \u2460\u2461\u2462', 'Code \u0664\u0667\u0667',
      // Harmless, but every digit is withheld alike.
      'Roth IRA ***6741',
    ]) {
      const res = await suggestion(text, text);
      expect(res.body.possiblyPaidFrom, text).toEqual(withheld);
      expect(res.text, text).not.toContain(text);
      expect(res.text, text).not.toMatch(/\d{13}/);
      for (const group of groups) expect(res.text, text).not.toContain(`${group}+`);
    }
    expect((await suggestion('Fidelity Individual', 'Electronic Funds Transfer Paid (Cash)')).body.possiblyPaidFrom).toEqual([
      { ...withheld[0], accountName: 'Fidelity Individual', description: 'Electronic Funds Transfer Paid (Cash)' },
    ]);
  });

  it('answers a failed brokerage read with the mount\'s value-free 500, never with SQLite or repository text', async () => {
    const { amex } = seed();
    brokerage('fid', 'Fidelity Individual');
    cashEvent('fid');
    const [payment] = payments(amex.id);
    const pan = syntheticCardNumber();
    const sqliteError = Object.assign(new Error(`database disk image is malformed near '${pan}'`), { name: 'SqliteError', code: 'SQLITE_CORRUPT' });
    const read = vi.spyOn(repo, 'listCashEvents').mockImplementation(() => { throw sqliteError; });
    const logged = logs.length;
    const failed = async (url: string) => {
      const res = await get(url);
      expect(res.status, url).toBe(500);
      expect(res.body, url).toEqual({ error: 'card spending request failed' });
      expect(res.text, url).not.toMatch(/sqlite|malformed|refused|\d/i);
    };
    await failed(`/card-transactions/${payment.id}`);
    await failed('/spending/summary?from=2026-09-01&to=2026-09-30');
    // The brokerage reads are not behind the value-free boundary yet: a plain error from one is a
    // server fault as well, the same 500 and never a 400 that could quote it.
    read.mockImplementationOnce(() => { throw new Error(`cash event range refused for ${pan}`); });
    await failed(`/card-transactions/${payment.id}`);
    expect(logs.slice(logged).filter((line) => line.startsWith('[card-'))).toEqual([
      '[card-spending] GET request failed: SqliteError SQLITE_CORRUPT',
      '[card-spending] GET request failed: SqliteError SQLITE_CORRUPT',
      '[card-spending] GET request failed: Error',
    ]);
  });

  it('reads brokerage cash only around payments, and writes nothing', async () => {
    const { amex } = seed();
    brokerage('fid', 'Fidelity Individual');
    cashEvent('fid');
    const accountsRead = vi.spyOn(repo, 'listAccounts');
    const eventsRead = vi.spyOn(repo, 'listCashEvents');
    const start = changes();
    const hotel = repo.queryCardTransactions({ search: 'lisboa' }).transactions[0];
    expect((await get(`/card-transactions/${hotel.id}`)).status).toBe(200);
    expect((await get('/spending/summary?from=2026-10-01&to=2026-10-31')).status).toBe(200);
    expect(accountsRead).not.toHaveBeenCalled();
    expect(eventsRead).not.toHaveBeenCalled();

    const [payment] = payments(amex.id);
    expect((await get(`/card-transactions/${payment.id}`)).body.possiblyPaidFrom).toHaveLength(1);
    expect(eventsRead).toHaveBeenLastCalledWith('fid', '2026-09-20', '2026-09-30');
    expect((await get('/spending/summary?from=2026-09-01&to=2026-09-30')).body.paymentsPossiblyPaidFrom).toEqual([{ currency: 'USD', count: 1 }]);
    expect(eventsRead).toHaveBeenLastCalledWith('fid', '2026-09-20', '2026-09-30');
    expect(changes()).toBe(start);
  });
});

describe('brokerage data and returns', () => {
  it('stay the same through card imports, edits, pending changes and payment suggestions', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T16:00:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network disabled in tests')));
    repo.createAccount({ id: 'fid', name: 'Fidelity', cashBalance: 1000, currency: 'USD' });
    repo.createTransaction({ id: 'buy', accountId: 'fid', symbol: 'AAPL', date: '2025-06-02', quantity: 10, pricePerUnit: 100, currency: 'USD' });
    repo.insertCashEvent({
      accountId: 'fid', date: '2026-09-26', eventType: 'withdrawal', amount: -600, currency: 'USD', broker: 'fidelity',
      accountLast4: '2468', description: 'SYNTHETIC TRANSFER TO CARD', sourceFingerprint: 'd'.repeat(64),
    });
    const bars: PriceBar[] = [];
    for (let day = new Date('2025-05-01T00:00:00Z'); day <= new Date('2026-10-16T00:00:00Z'); day.setUTCDate(day.getUTCDate() + 1)) {
      if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
      const t = day.toISOString().slice(0, 10);
      bars.push({ symbol: 'AAPL', t, close: t < '2026-01-01' ? 100 : 110, source: 'nasdaq' });
    }
    createHistoryRepo(repo).upsertBars(bars);
    const db = repo.internalGetDb();
    const ledger = () => Object.fromEntries((db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'card_%' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>).map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
    const returns = async () => (await request(await listenLoopback(app)).get('/portfolio/performance?accounts=fid').expect(200)).body;
    const before = { ledger: ledger(), returns: await returns(), accounts: (await request(await listenLoopback(app)).get('/accounts')).body };
    expect(before.returns.supported).toBe(true);

    const { amex } = seed();
    await commit(amex.id, payload('amex', [
      { transactionDate: '2026-10-08', status: 'pending', amountMinor: 3300, kind: 'purchase', description: 'TAILSPIN CINEMA' },
    ], { start: '2026-10-08', end: '2026-10-08' }));
    const posting = await post(`/card-imports/commit?cardAccountId=${amex.id}&pendingMatches=post`, payload('amex', [
      { transactionDate: '2026-10-08', postedDate: '2026-10-09', amountMinor: 3300, kind: 'purchase', description: 'TAILSPIN CINEMA' },
      { transactionDate: '2026-10-09', amountMinor: -60000, kind: 'payment', description: 'ONLINE PAYMENT THANK YOU' },
    ], { start: '2026-10-03', end: '2026-10-09' }));
    expect(posting.body).toMatchObject({ imported: true, pendingPostedCount: 1 });
    const hotel = repo.queryCardTransactions({ search: 'lisboa' }).transactions[0];
    await patch(`/card-transactions/${hotel.id}`, { userCategory: 'Vacation', notes: 'synthetic' });
    const pending = repo.queryCardTransactions({ statuses: ['pending'] }).transactions[0];
    await patch(`/card-transactions/${pending.id}`, { status: 'removed' });

    // The September payment looks paid from the synthetic withdrawal a day later: suggested, read
    // from the brokerage tables, and nothing written anywhere while suggesting it.
    const writes = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    const writesBefore = writes();
    const [september] = repo.queryCardTransactions({ cardAccountId: amex.id, kinds: ['payment'], to: '2026-09-30' }).transactions;
    expect((await get(`/card-transactions/${september.id}`)).body.possiblyPaidFrom).toEqual([{
      accountName: 'Fidelity', date: '2026-09-26', eventType: 'withdrawal', amountMinor: -60000, currency: 'USD', dayOffset: 1,
      description: 'SYNTHETIC TRANSFER TO CARD',
    }]);
    expect((await get('/spending/summary?from=2026-09-01&to=2026-10-31')).body.paymentsPossiblyPaidFrom).toEqual([{ currency: 'USD', count: 1 }]);
    expect(writes()).toBe(writesBefore);

    expect(ledger()).toEqual(before.ledger);
    // Byte for byte: every row of every brokerage table, in storage order.
    expect(JSON.stringify(ledger())).toBe(JSON.stringify(before.ledger));
    expect(await returns()).toEqual(before.returns);
    expect((await request(await listenLoopback(app)).get('/accounts')).body).toEqual(before.accounts);
  });
});
