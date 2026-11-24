import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { exceptCardSpendingPaths, mountCardSpendingRoutes } from './cardSpending.js';
import { createCardTransactionsRouter } from './cardTransactions.js';
import { createCardSpendingOverviewRouter } from './cardSpendingOverview.js';
import { createCardOpeningsRouter } from './cardSpendingOpenings.js';
import { SqliteStateRepo, type CardImportRow } from '../services/sqliteStateRepo.js';
import { installCardOpeningMonthsSchema } from '../services/cardOpeningMonths.js';
import { listenLoopback } from '../testing/loopback.js';

// The owner's card opening months end to end, and how the coverage routes take them. Synthetic data only: fictional
// descriptors, made-up amounts, dates and last-4s.

let dir: string;
let repo: SqliteStateRepo;
let logs: string[];
const NOW = '2026-10-22T12:00:00.000Z';
const NOT_INSTALLED = { error: 'card opening months are not installed on this Holdr' };

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

function buildApp(): express.Express {
  const server = express();
  server.use(exceptCardSpendingPaths(express.json({ limit: '2mb' })));
  const log = (line: string) => logs.push(line);
  mountCardSpendingRoutes(server, {
    repo, requireAuth: testAuth, log,
    routers: [createCardTransactionsRouter(repo, { log }), createCardSpendingOverviewRouter(repo, { log }), createCardOpeningsRouter(repo, { log })],
  });
  return server;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-openings-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db'), now: () => new Date(NOW) });
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

/** One card read since March, one first seen in mid-August (its first statement), one with nothing stored yet. */
function seed() {
  const early = repo.createCardAccount({ issuer: 'citi', owner: 'alex', last4: '0001', currency: 'USD' });
  const late = repo.createCardAccount({ issuer: 'amex', owner: 'casey', last4: '0002', currency: 'USD' });
  const empty = repo.createCardAccount({ issuer: 'chase', owner: 'joint', last4: '0003', currency: 'USD' });
  const imp = (id: string, rows: CardImportRow[], coverage: { start: string; end: string }) =>
    repo.importCardTransactions({ cardAccountId: id, source: 'test-file', parserVersion: 'test@1', rows, coverage });
  imp(early.id, [row({ transactionDate: '2026-03-05', description: 'NORTHWIND GROCERY' }), row({ transactionDate: '2026-05-10', description: 'PROSEWARE BISTRO' }),
    row({ transactionDate: '2026-06-12', amountMinor: 4_200, description: 'NORTHWIND GROCERY' }), row({ transactionDate: '2026-07-08', description: 'PROSEWARE BISTRO' })],
  { start: '2026-03-01', end: '2026-10-21' });
  imp(late.id, [row({ transactionDate: '2026-08-20', description: 'CONTOSO OUTFITTERS' }), row({ transactionDate: '2026-09-02', description: 'NORTHWIND GROCERY' })],
    { start: '2026-08-15', end: '2026-10-21' });
  return { early, late, empty };
}

const get = async (app: express.Express, url: string, auth = 'ok') => request(await listenLoopback(app)).get(url).set('x-test-auth', auth);
const send = async (app: express.Express, method: 'put' | 'delete', url: string, body?: unknown, auth = 'ok') => {
  const call = request(await listenLoopback(app))[method](url).set('x-test-auth', auth);
  return body === undefined ? call : call.set('content-type', 'application/json').send(JSON.stringify(body));
};
const confirm = (app: express.Express, cards: Array<{ cardAccountId: string; openingMonth: string }>, auth = 'ok') =>
  send(app, 'put', '/spending/card-openings', { cards }, auth);
type Month = { month: string; complete: boolean; cardsExpected: number; cardsCovered: number; cardsStartingLater: number; uncoveredCardIds: string[] };
const months = async (app: express.Express, query = '') =>
  ((await get(app, `/spending/coverage/months?today=2026-10-22${query}`)).body.months as Month[])
    .map((item) => [item.month, item.cardsExpected, item.cardsCovered, item.cardsStartingLater, item.complete]);

describe('GET /spending/card-openings', () => {
  it('lists every card with what Holdr knows of its start and the month to prefill, with no months before the table', async () => {
    const { early, late, empty } = seed();
    const app = buildApp();
    const res = await get(app, '/spending/card-openings');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const none = { openingMonth: null, confirmedAt: null, status: null, history: [] };
    expect(res.body).toEqual({
      installed: false,
      cards: [
        { cardAccountId: early.id, firstRowDate: '2026-03-05', firstCoverageDate: '2026-03-01', firstKnownDate: '2026-03-01', prefillMonth: '2026-03', ...none },
        { cardAccountId: late.id, firstRowDate: '2026-08-20', firstCoverageDate: '2026-08-15', firstKnownDate: '2026-08-15', prefillMonth: '2026-08', ...none },
        { cardAccountId: empty.id, firstRowDate: null, firstCoverageDate: null, firstKnownDate: null, prefillMonth: null, ...none },
      ],
    });
    // The service token may read it.
    expect((await get(app, '/spending/card-openings', 'service')).status).toBe(200);
    // Unknown parameters are refused; card data in the query is a 422 with paths only.
    expect((await get(app, '/spending/card-openings?owner=alex')).status).toBe(400);
    const card = await get(app, '/spending/card-openings?q=4111111111111111');
    expect(card.status).toBe(422);
    expect(JSON.stringify(card.body)).not.toContain('4111');
    expect(logs).toEqual([]);
  });
});

describe('changing card opening months', () => {
  it('refuses a change until the table is installed, after sign-in and the body\'s shape', async () => {
    const { late } = seed();
    const app = buildApp();
    const valid = [{ cardAccountId: late.id, openingMonth: '2026-08' }];
    const refused = await confirm(app, valid);
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual(NOT_INSTALLED);
    expect((await send(app, 'delete', `/spending/card-openings/${late.id}`)).body).toEqual(NOT_INSTALLED);
    // Sign-in, card data and the body's shape are answered first.
    expect((await confirm(app, valid, 'service')).status).toBe(403);
    expect((await send(app, 'delete', `/spending/card-openings/${late.id}`, undefined, 'service')).status).toBe(403);
    expect((await send(app, 'put', '/spending/card-openings', { cards: [] })).status).toBe(400);
    expect((await send(app, 'put', '/spending/card-openings', { cards: [{ cardAccountId: '4111111111111111', openingMonth: '2026-08' }] })).status).toBe(422);
    expect((await get(app, '/spending/card-openings')).body.installed).toBe(false);
  });

  it('confirms months all at once, keeps the same month, and keeps every change and clear', async () => {
    const { early, late, empty } = seed();
    installCardOpeningMonthsSchema(repo.internalGetDb());
    const app = buildApp();
    expect((await get(app, '/spending/card-openings')).body.installed).toBe(true);

    const first = await confirm(app, [{ cardAccountId: early.id, openingMonth: '2026-03' }, { cardAccountId: late.id, openingMonth: '2026-08' }]);
    expect(first.status).toBe(200);
    expect(first.body.installed).toBe(true);
    expect(first.body.changed).toBe(2);
    const byId = (cards: Array<{ cardAccountId: string; history: Array<{ revokedAt: string | null }> }>) =>
      new Map(cards.map((card) => [card.cardAccountId, card]));
    expect(byId(first.body.cards).get(late.id)).toEqual({
      cardAccountId: late.id, firstRowDate: '2026-08-20', firstCoverageDate: '2026-08-15', firstKnownDate: '2026-08-15', prefillMonth: '2026-08',
      openingMonth: '2026-08', confirmedAt: NOW, status: 'applied', history: [{ openingMonth: '2026-08', confirmedAt: NOW, revokedAt: null }],
    });
    expect((await get(app, '/spending/card-openings')).body).toEqual({ installed: true, cards: first.body.cards });
    expect(JSON.stringify(first.body)).not.toContain('usr_');

    // The same month again changes nothing; another month is a change, kept with the one it replaced.
    expect((await confirm(app, [{ cardAccountId: late.id, openingMonth: '2026-08' }])).body.changed).toBe(0);
    const changed = await confirm(app, [{ cardAccountId: late.id, openingMonth: '2026-07' }, { cardAccountId: empty.id, openingMonth: '2026-01' }]);
    expect(changed.body.changed).toBe(2);
    expect(byId(changed.body.cards).get(late.id)).toMatchObject({
      openingMonth: '2026-07', status: 'applied',
      history: [{ openingMonth: '2026-08', confirmedAt: NOW, revokedAt: NOW }, { openingMonth: '2026-07', confirmedAt: NOW, revokedAt: null }],
    });
    // A card without data keeps its month, which applies once data comes.
    expect(byId(changed.body.cards).get(empty.id)).toMatchObject({ openingMonth: '2026-01', status: 'no-data', prefillMonth: null });

    const cleared = await send(app, 'delete', `/spending/card-openings/${late.id}`);
    expect(cleared.status).toBe(200);
    expect(cleared.body.cleared).toBe(true);
    expect(byId(cleared.body.cards).get(late.id)).toMatchObject({ openingMonth: null, confirmedAt: null, status: null });
    expect(byId(cleared.body.cards).get(late.id)!.history).toHaveLength(2);
    expect(byId(cleared.body.cards).get(late.id)!.history.every((item) => item.revokedAt === NOW)).toBe(true);
    const again = await send(app, 'delete', `/spending/card-openings/${late.id}`);
    expect([again.status, again.body.cleared]).toEqual([200, false]);
    expect(logs).toEqual([]);
  });

  it('refuses a month later than the card\'s first known day or after this month, and bad input, without echoing it or writing', async () => {
    const { early, late } = seed();
    // A card whose import declares its record from mid-June, before its first row in September (the reviewers' case).
    const declared = repo.createCardAccount({ issuer: 'citi', owner: 'alex', last4: '0004', currency: 'USD' });
    repo.importCardTransactions({ cardAccountId: declared.id, source: 'test-file', parserVersion: 'test@1',
      rows: [row({ transactionDate: '2026-09-20', description: 'NORTHWIND GROCERY' })], coverage: { start: '2026-06-15', end: '2026-09-30' } });
    installCardOpeningMonthsSchema(repo.internalGetDb());
    const app = buildApp();
    const later = 'openingMonth must not be after the month of the first day Holdr has for the card';
    const refusals: Array<[unknown, number, string]> = [
      // late's record starts on August 15 (its import), before its first row on August 20: it existed in August.
      [{ cards: [{ cardAccountId: late.id, openingMonth: '2026-09' }] }, 400, later],
      // Known from June 15 by its declared coverage, though its first row is in September: neither July nor September.
      [{ cards: [{ cardAccountId: declared.id, openingMonth: '2026-09' }] }, 400, later],
      [{ cards: [{ cardAccountId: early.id, openingMonth: '2026-03' }, { cardAccountId: declared.id, openingMonth: '2026-07' }] }, 400, later],
      [{ cards: [{ cardAccountId: early.id, openingMonth: '2026-03' }, { cardAccountId: late.id, openingMonth: '2026-11' }] }, 400,
        'openingMonth must not be after this month'],
      [{ cards: [{ cardAccountId: 'card-acct-synthetic-missing', openingMonth: '2026-08' }] }, 400, 'cardAccountId must be a card account on this Holdr'],
      [{ cards: [{ cardAccountId: late.id, openingMonth: '1899-12' }] }, 400, 'openingMonth must be a month from 1900-01, as YYYY-MM'],
      [{ cards: [{ cardAccountId: late.id, openingMonth: '2026-8' }] }, 400, 'openingMonth must be YYYY-MM'],
      [{ cards: [{ cardAccountId: late.id, openingMonth: '2026-08' }, { cardAccountId: late.id, openingMonth: '2026-07' }] }, 400, 'each card may be listed once'],
      [{ cards: [{ cardAccountId: late.id, openingMonth: '2026-08', note: 'synthetic' }] }, 400, 'each card must be { cardAccountId, openingMonth }'],
      [{ cards: [{ cardAccountId: 'bad id', openingMonth: '2026-08' }] }, 400, 'cardAccountId is invalid'],
      [{ cards: [late.id] }, 400, 'each card must be { cardAccountId, openingMonth }'],
      [{ cards: 'synthetic' }, 400, 'cards must list 1 to 200 cards'],
      [{ cards: [{ cardAccountId: late.id, openingMonth: '2026-08' }], extra: true }, 400, 'body has an unexpected key'],
      [[{ cardAccountId: late.id, openingMonth: '2026-08' }], 400, 'body must be an object'],
    ];
    for (const [body, status, error] of refusals) {
      const answer = await send(app, 'put', '/spending/card-openings', body);
      expect(answer.status, JSON.stringify(body)).toBe(status);
      expect(answer.body, JSON.stringify(body)).toEqual({ error });
      expect(JSON.stringify(answer.body)).not.toMatch(/synthetic|2026-|card-acct/);
    }
    const card = await send(app, 'put', '/spending/card-openings', { cards: [{ cardAccountId: late.id, openingMonth: '2026-08', cvv: '123' }] });
    expect(card.status).toBe(422);
    expect(JSON.stringify(card.body)).not.toContain('123');
    expect((await send(app, 'put', '/spending/card-openings?force=1', { cards: [{ cardAccountId: late.id, openingMonth: '2026-08' }] })).status).toBe(400);
    const text = await request(await listenLoopback(app)).put('/spending/card-openings').set('x-test-auth', 'ok').set('content-type', 'text/plain').send('2026-08');
    expect(text.status).toBe(415);
    // The largest batch the store takes fits the body limit, and reaches the store (none of these cards is here).
    const longest = (count: number) => ({ cards: Array.from({ length: count }, (_, index) => ({
      cardAccountId: `card-acct-${String(index).padStart(54, 'z')}`, openingMonth: '2026-08' })) });
    expect(JSON.stringify(longest(200)).length).toBeGreaterThan(20 * 1024);
    expect((await send(app, 'put', '/spending/card-openings', longest(200))).body).toEqual({ error: 'cardAccountId must be a card account on this Holdr' });
    expect((await send(app, 'put', '/spending/card-openings', longest(201))).body).toEqual({ error: 'cards must list 1 to 200 cards' });
    // Clearing: an unknown card or a malformed id is a 404, card data a 422.
    expect((await send(app, 'delete', '/spending/card-openings/card-acct-synthetic-missing')).status).toBe(404);
    expect((await send(app, 'delete', '/spending/card-openings/bad%20id')).status).toBe(404);
    const id = await send(app, 'delete', '/spending/card-openings/4111111111111111');
    expect(id.status).toBe(422);
    expect(JSON.stringify(id.body)).not.toContain('4111');
    expect((await get(app, '/spending/card-openings')).body.cards.every((item: { history: unknown[] }) => item.history.length === 0)).toBe(true);
    // June, the month of its first known day, or any earlier month, is taken; the months before its record stay partial.
    expect((await confirm(app, [{ cardAccountId: declared.id, openingMonth: '2026-06' }])).status).toBe(200);
    const view = (await get(app, '/spending/card-openings')).body.cards.find((item: { cardAccountId: string }) => item.cardAccountId === declared.id);
    expect(view).toMatchObject({ firstRowDate: '2026-09-20', firstKnownDate: '2026-06-15', prefillMonth: '2026-06', openingMonth: '2026-06', status: 'applied' });
    expect((await get(app, `/spending/coverage/months?today=2026-10-22&cardAccountId=${declared.id}&fromMonth=2026-06`)).body.months[0]).toMatchObject({
      month: '2026-06', complete: true, cardsExpected: 1, cardsCovered: 1, openedCardIds: [declared.id],
    });
    expect((await confirm(app, [{ cardAccountId: declared.id, openingMonth: '2026-05' }])).status).toBe(200);
    expect((await get(app, `/spending/coverage/months?today=2026-10-22&cardAccountId=${declared.id}&fromMonth=2026-05&toMonth=2026-06`)).body.months
      .map((item: Month) => [item.month, item.complete, item.uncoveredCardIds])).toEqual([['2026-05', false, [declared.id]], ['2026-06', false, [declared.id]]]);
  });
});

describe('coverage with confirmed opening months', () => {
  const COVERAGE_URLS = [
    '/spending/coverage/months?today=2026-10-22',
    '/spending/coverage/months?today=2026-10-22&owner=casey',
    '/spending/coverage/months?today=2026-10-22&fromMonth=2026-01&toMonth=2026-12',
    '/spending/trend?fromMonth=2026-03&toMonth=2026-10&today=2026-10-22',
    '/spending/compare?from=2026-07-01&to=2026-07-31&baselineFrom=2026-06-01&baselineTo=2026-06-30&today=2026-10-22',
    '/spending/compare?from=2026-08-01&to=2026-08-31&baselineFrom=2026-07-01&baselineTo=2026-07-31&today=2026-10-22',
  ];
  const answers = async (app: express.Express) => Promise.all(COVERAGE_URLS.map(async (url) => {
    const res = await get(app, url);
    expect(res.status, url).toBe(200);
    return res.text;
  }));

  it('answers byte for byte as before while no month applies: no table, an empty one, a cleared month, or a card without data', async () => {
    const { late, empty } = seed();
    const app = buildApp();
    const before = await answers(app);
    installCardOpeningMonthsSchema(repo.internalGetDb());
    expect(await answers(app)).toEqual(before);
    // A month confirmed and then cleared no longer applies.
    expect((await confirm(app, [{ cardAccountId: late.id, openingMonth: '2026-08' }])).status).toBe(200);
    expect(await answers(app)).not.toEqual(before);
    expect((await send(app, 'delete', `/spending/card-openings/${late.id}`)).status).toBe(200);
    expect(await answers(app)).toEqual(before);
    // A card with neither rows nor coverage is ignored, month or not.
    expect((await confirm(app, [{ cardAccountId: empty.id, openingMonth: '2026-01' }])).status).toBe(200);
    expect(await answers(app)).toEqual(before);
  });

  it('stops expecting a card before its confirmed month, in every month and window, and counts its month from its first day', async () => {
    const { early, late } = seed();
    installCardOpeningMonthsSchema(repo.internalGetDb());
    const app = buildApp();
    expect(await months(app)).toEqual([
      // late first appears on August 15: without its owner's word, every month before may be missing it.
      ['2026-03', 1, 1, 1, false], ['2026-04', 1, 1, 1, false], ['2026-05', 1, 1, 1, false], ['2026-06', 1, 1, 1, false],
      ['2026-07', 1, 1, 1, false], ['2026-08', 2, 1, 0, false], ['2026-09', 2, 2, 0, true], ['2026-10', 2, 0, 0, false],
    ]);
    const june = '/spending/compare?from=2026-07-01&to=2026-07-31&baselineFrom=2026-06-01&baselineTo=2026-06-30&today=2026-10-22';
    expect((await get(app, june)).body.comparison.baseline.coverage).toMatchObject({ complete: false, cardsStartingLater: 1 });
    const trendUrl = '/spending/trend?fromMonth=2026-03&toMonth=2026-10&today=2026-10-22';
    expect((await get(app, trendUrl)).body.gaps).toEqual({
      lastCompletableMonth: '2026-09', behind: [], startingLater: [{ cardAccountId: late.id, firstKnown: '2026-08-15' }],
    });

    // Confirmed as its prefill shows: opened in August, read from its first statement.
    await confirm(app, [{ cardAccountId: early.id, openingMonth: '2026-03' }, { cardAccountId: late.id, openingMonth: '2026-08' }]);
    expect(await months(app)).toEqual([
      ['2026-03', 1, 1, 0, true], ['2026-04', 1, 1, 0, true], ['2026-05', 1, 1, 0, true], ['2026-06', 1, 1, 0, true],
      ['2026-07', 1, 1, 0, true], ['2026-08', 2, 2, 0, true], ['2026-09', 2, 2, 0, true], ['2026-10', 2, 0, 0, false],
    ]);
    // August is complete only because late opened in it (from August 15): it says so, ids only. early's record starts
    // on March 1, its whole opening month: nothing to say there.
    const listed = (await get(app, '/spending/coverage/months?today=2026-10-22')).body.months as Array<Month & { openedCardIds?: string[] }>;
    expect(listed.filter((item) => item.openedCardIds).map((item) => [item.month, item.openedCardIds])).toEqual([['2026-08', [late.id]]]);
    const compared = (await get(app, june)).body.comparison;
    expect(compared.baseline.coverage).toEqual({ from: '2026-06-01', to: '2026-06-30', complete: true, cardsWithData: 1, cardsExpected: 1,
      cardsCovered: 1, cardsStartingLater: 0, inProgress: false, uncoveredCardIds: [] });
    expect(compared.current.coverage).toMatchObject({ complete: true, cardsStartingLater: 0 });
    const trend = (await get(app, '/spending/trend?fromMonth=2026-03&toMonth=2026-10&today=2026-10-22')).body.months as
      Array<{ month: string; coverage: Month & { openedCardIds?: string[] } }>;
    expect(trend.map((item) => [item.month, item.coverage.complete, item.coverage.openedCardIds ?? null])).toEqual([
      ['2026-03', true, null], ['2026-04', true, null], ['2026-05', true, null], ['2026-06', true, null], ['2026-07', true, null],
      ['2026-08', true, [late.id]], ['2026-09', true, null], ['2026-10', false, null],
    ]);
    // A window that takes in August's 15th: its days before are before late existed.
    const august = '/spending/compare?from=2026-08-01&to=2026-08-31&baselineFrom=2026-07-01&baselineTo=2026-07-31&today=2026-10-22';
    expect((await get(app, august)).body.comparison.current.coverage).toMatchObject({ complete: true, openedCardIds: [late.id] });
    // Nothing keeps those months from counting now.
    expect((await get(app, trendUrl)).body.gaps).toEqual({ lastCompletableMonth: '2026-09', behind: [], startingLater: [] });
    // One person's view: the late card alone, from its month.
    expect(await months(app, '&owner=casey')).toEqual([['2026-08', 1, 1, 0, true], ['2026-09', 1, 1, 0, true], ['2026-10', 1, 0, 0, false]]);

    // The owner says it opened in June: June and July may be missing its spending, and August is needed from the 1st.
    await confirm(app, [{ cardAccountId: late.id, openingMonth: '2026-06' }]);
    expect((await get(app, '/spending/coverage/months?today=2026-10-22&fromMonth=2026-05&toMonth=2026-09')).body.months).toEqual([
      { month: '2026-05', complete: true, cardsWithData: 1, cardsExpected: 1, cardsCovered: 1, cardsStartingLater: 0, inProgress: false, uncoveredCardIds: [] },
      { month: '2026-06', complete: false, cardsWithData: 1, cardsExpected: 2, cardsCovered: 1, cardsStartingLater: 0, inProgress: false, uncoveredCardIds: [late.id] },
      { month: '2026-07', complete: false, cardsWithData: 1, cardsExpected: 2, cardsCovered: 1, cardsStartingLater: 0, inProgress: false, uncoveredCardIds: [late.id] },
      { month: '2026-08', complete: false, cardsWithData: 1, cardsExpected: 2, cardsCovered: 1, cardsStartingLater: 0, inProgress: false, uncoveredCardIds: [late.id] },
      { month: '2026-09', complete: true, cardsWithData: 1, cardsExpected: 2, cardsCovered: 2, cardsStartingLater: 0, inProgress: false, uncoveredCardIds: [] },
    ]);
    expect(logs).toEqual([]);
  });

  it('stops applying a month once an older stored row shows the card existed before it, and says so', async () => {
    const { late } = seed();
    installCardOpeningMonthsSchema(repo.internalGetDb());
    const app = buildApp();
    const before = await answers(app);
    await confirm(app, [{ cardAccountId: late.id, openingMonth: '2026-08' }]);
    // Older history imported after the confirmation: a row in July.
    repo.importCardTransactions({ cardAccountId: late.id, source: 'test-file', parserVersion: 'test@1',
      rows: [row({ transactionDate: '2026-07-30', description: 'PROSEWARE BISTRO' })], coverage: { start: '2026-07-30', end: '2026-07-30' } });
    const view = (await get(app, '/spending/card-openings')).body.cards.find((item: { cardAccountId: string }) => item.cardAccountId === late.id);
    expect(view).toMatchObject({ openingMonth: '2026-08', status: 'contradicted', firstRowDate: '2026-07-30', prefillMonth: '2026-07' });
    // As without a month: the card counts as starting later before July 30.
    expect(await months(app, '&toMonth=2026-08')).toEqual([
      ['2026-03', 1, 1, 1, false], ['2026-04', 1, 1, 1, false], ['2026-05', 1, 1, 1, false], ['2026-06', 1, 1, 1, false],
      ['2026-07', 2, 1, 0, false], ['2026-08', 2, 1, 0, false],
    ]);
    expect(before).toHaveLength(COVERAGE_URLS.length);
  });

  it('stops applying a month once older declared coverage arrives, and answers as without it', async () => {
    const { late } = seed();
    installCardOpeningMonthsSchema(repo.internalGetDb());
    const app = buildApp();
    await confirm(app, [{ cardAccountId: late.id, openingMonth: '2026-08' }]);
    // A later import whose declared dates reach back to July 20, though its only row is in September.
    repo.importCardTransactions({ cardAccountId: late.id, source: 'test-file', parserVersion: 'test@1',
      rows: [row({ transactionDate: '2026-09-05', description: 'PROSEWARE BISTRO' })], coverage: { start: '2026-07-20', end: '2026-09-05' } });
    const view = (await get(app, '/spending/card-openings')).body.cards.find((item: { cardAccountId: string }) => item.cardAccountId === late.id);
    expect(view).toMatchObject({ openingMonth: '2026-08', status: 'contradicted', firstRowDate: '2026-08-20', firstKnownDate: '2026-07-20' });
    const contradicted = await answers(app);
    expect((await send(app, 'delete', `/spending/card-openings/${late.id}`)).status).toBe(200);
    expect(await answers(app)).toEqual(contradicted);
    // Confirmed again, August is now refused: the evidence reaches back to July.
    expect((await confirm(app, [{ cardAccountId: late.id, openingMonth: '2026-08' }])).body).toEqual({
      error: 'openingMonth must not be after the month of the first day Holdr has for the card' });
  });

  it('reads the first known day one way to refuse and to apply: a sync window Holdr verified complete counts too', async () => {
    const { early, late } = seed();
    installCardOpeningMonthsSchema(repo.internalGetDb());
    const app = buildApp();
    // A sync window Holdr verified complete from July 5 (contract 1 verifies none; the coverage routes would read it).
    const windows = vi.spyOn(repo, 'listCardCoverageWindows').mockReturnValue([{
      cardAccountId: late.id, verifiedCompleteness: 'complete', requested: { basis: 'transaction', start: '2026-07-05', end: '2026-07-31' },
    }] as never);
    const view = (await get(app, '/spending/card-openings')).body.cards.find((item: { cardAccountId: string }) => item.cardAccountId === late.id);
    expect(view).toMatchObject({ firstRowDate: '2026-08-20', firstCoverageDate: '2026-07-05', firstKnownDate: '2026-07-05', prefillMonth: '2026-07' });
    // August is later than July 5: refused at write, as the read path would not apply it.
    expect((await confirm(app, [{ cardAccountId: late.id, openingMonth: '2026-08' }])).body).toEqual({
      error: 'openingMonth must not be after the month of the first day Holdr has for the card' });
    expect((await confirm(app, [{ cardAccountId: early.id, openingMonth: '2026-03' }, { cardAccountId: late.id, openingMonth: '2026-07' }])).status).toBe(200);
    // July: late opened on July 5 and is read from then: complete, and it says so.
    expect((await get(app, '/spending/coverage/months?today=2026-10-22&fromMonth=2026-06&toMonth=2026-08')).body.months
      .map((item: Month & { openedCardIds?: string[] }) => [item.month, item.complete, item.openedCardIds ?? null])).toEqual([
      ['2026-06', true, null], ['2026-07', true, [late.id]], ['2026-08', false, null],
    ]);
    // Without that window, July is earlier than its record: counted from July 1 and partial, never complete.
    windows.mockRestore();
    expect((await get(app, '/spending/coverage/months?today=2026-10-22&fromMonth=2026-07&toMonth=2026-07')).body.months[0])
      .toMatchObject({ complete: false, uncoveredCardIds: [late.id] });
  });
});
