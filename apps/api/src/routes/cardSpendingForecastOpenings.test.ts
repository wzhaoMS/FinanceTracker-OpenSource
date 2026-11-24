import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { exceptCardSpendingPaths, mountCardSpendingRoutes } from './cardSpending.js';
import { createCardTransactionsRouter } from './cardTransactions.js';
import { createCardSpendingOverviewRouter } from './cardSpendingOverview.js';
import { createCardSpendingForecastRouter } from './cardSpendingForecast.js';
import { createCardOpeningsRouter } from './cardSpendingOpenings.js';
import { SqliteStateRepo, type CardImportRow } from '../services/sqliteStateRepo.js';
import { installCardOpeningMonthsSchema } from '../services/cardOpeningMonths.js';
import { listenLoopback } from '../testing/loopback.js';

// The forecast and the patterns read coverage as the overview does, opening months included (iteration 3 with
// iteration 4). Synthetic data only: fictional descriptors, made-up amounts, dates and last-4s.

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

function buildApp(): express.Express {
  const server = express();
  server.use(exceptCardSpendingPaths(express.json({ limit: '2mb' })));
  const log = (line: string) => logs.push(line);
  mountCardSpendingRoutes(server, {
    repo, requireAuth: testAuth, log,
    routers: [createCardTransactionsRouter(repo, { log }), createCardSpendingOverviewRouter(repo, { log }),
      createCardSpendingForecastRouter(repo, { log }), createCardOpeningsRouter(repo, { log })],
  });
  return server;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-forecast-openings-'));
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

const row = (transactionDate: string, description: string, amountMinor = 4_200): CardImportRow => ({
  transactionDate, postedDate: null, status: 'posted', amountMinor, currency: 'USD', kind: 'purchase', description,
  merchant: null, issuerCategory: null,
} as CardImportRow);

const get = async (app: express.Express, url: string) => request(await listenLoopback(app)).get(url).set('x-test-auth', 'ok');
const confirm = async (app: express.Express, cards: Array<{ cardAccountId: string; openingMonth: string }>) =>
  request(await listenLoopback(app)).put('/spending/card-openings').set('x-test-auth', 'ok')
    .set('content-type', 'application/json').send(JSON.stringify({ cards }));

/**
 * Alex's card, read since October 2024; Casey's, whose first statement starts on August 15, 2026; and a joint card
 * opened this month, read from October 5. Without opening months, no month before October 2026 can be complete.
 */
function seed() {
  const alex = repo.createCardAccount({ issuer: 'citi', owner: 'alex', last4: '0001', currency: 'USD' });
  const casey = repo.createCardAccount({ issuer: 'amex', owner: 'casey', last4: '0002', currency: 'USD' });
  const joint = repo.createCardAccount({ issuer: 'chase', owner: 'joint', last4: '0003', currency: 'USD' });
  const alexRows: CardImportRow[] = [];
  for (let index = 2024 * 12 + 9; index <= 2026 * 12 + 9; index += 1) {
    const month = `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
    alexRows.push(row(`${month}-03`, 'NORTHWIND GROCERY', 6_100 + (index % 7) * 130), row(`${month}-12`, 'PROSEWARE BISTRO', 2_300 + (index % 5) * 90));
  }
  const imp = (id: string, rows: CardImportRow[], coverage: { start: string; end: string }) =>
    repo.importCardTransactions({ cardAccountId: id, source: 'test-file', parserVersion: 'test@1', rows, coverage });
  imp(alex.id, alexRows, { start: '2024-10-01', end: '2026-10-21' });
  imp(casey.id, [row('2026-08-20', 'CONTOSO OUTFITTERS'), row('2026-09-20', 'CONTOSO OUTFITTERS'), row('2026-10-02', 'CONTOSO OUTFITTERS')],
    { start: '2026-08-15', end: '2026-10-21' });
  imp(joint.id, [row('2026-10-06', 'TAILSPIN TOYS'), row('2026-10-15', 'TAILSPIN TOYS')], { start: '2026-10-05', end: '2026-10-21' });
  return { alex, casey, joint };
}

type Coverage = { month: string; complete: boolean };
type Forecast = {
  months: Array<{ month: string; complete: boolean; inProgress: boolean }>;
  fit: { from: string; to: string; completeMonths: number } | null;
  pace: { monthSoFarComplete: boolean | null };
  coverage: { gaps: { startingLater: Array<{ cardAccountId: string }> } };
};

/** The overview's complete months and the forecast's answer, for one view. */
async function read(app: express.Express, query = '') {
  const months = (await get(app, `/spending/coverage/months?today=${TODAY}${query}`)).body.months as Coverage[];
  const forecast = (await get(app, `/spending/forecast?today=${TODAY}${query}`)).body as Forecast;
  const complete = months.filter((month) => month.complete).map((month) => month.month);
  return { complete, forecast };
}

/** The forecast learns from exactly the months the overview calls complete, and marks the same ones complete. */
function expectSameMonths(view: Awaited<ReturnType<typeof read>>, label: string) {
  expect(view.forecast.fit?.completeMonths ?? 0, label).toBe(view.complete.length);
  if (view.complete.length > 0) expect([view.forecast.fit!.from, view.forecast.fit!.to], label).toEqual([view.complete[0], view.complete[view.complete.length - 1]]);
  expect(view.forecast.months.filter((month) => month.complete).map((month) => month.month), label).toEqual(view.complete);
}

describe('the forecast with card opening months', () => {
  it('learns from the months an opening month completes, as the overview counts them, and honors it this month', async () => {
    const { alex, casey, joint } = seed();
    installCardOpeningMonthsSchema(repo.internalGetDb());
    const app = buildApp();

    // Nothing confirmed: the two later cards keep every earlier month partial, and the joint card's first four days of
    // October are not covered.
    const before = await read(app);
    expect(before.complete).toEqual([]);
    expectSameMonths(before, 'before');
    expect(before.forecast.pace.monthSoFarComplete).toBe(false);
    expect(before.forecast.coverage.gaps.startingLater.map((card) => card.cardAccountId).sort()).toEqual([casey.id, joint.id].sort());

    // Alex's one batch confirm: each card's prefilled month.
    const prefills = ((await get(app, '/spending/card-openings')).body.cards as Array<{ cardAccountId: string; prefillMonth: string }>)
      .map((card) => ({ cardAccountId: card.cardAccountId, openingMonth: card.prefillMonth }));
    expect(prefills).toEqual(expect.arrayContaining([{ cardAccountId: alex.id, openingMonth: '2024-10' },
      { cardAccountId: casey.id, openingMonth: '2026-08' }, { cardAccountId: joint.id, openingMonth: '2026-10' }]));
    expect((await confirm(app, prefills)).status).toBe(200);

    const after = await read(app);
    expect(after.complete).toHaveLength(24);
    expectSameMonths(after, 'after');
    expect(after.forecast.pace.monthSoFarComplete).toBe(true);
    expect(after.forecast.coverage.gaps.startingLater).toEqual([]);

    // One person's view: Casey's August counts from the 15th, the day her record starts.
    const caseyView = await read(app, '&owner=casey');
    expect(caseyView.complete).toEqual(['2026-08', '2026-09']);
    expectSameMonths(caseyView, 'casey');
  });

  it('answers exactly as before while no opening month applies', async () => {
    seed();
    const app = buildApp();
    const absent = (await get(app, `/spending/forecast?today=${TODAY}`)).text;
    installCardOpeningMonthsSchema(repo.internalGetDb());
    expect((await get(app, `/spending/forecast?today=${TODAY}`)).text).toBe(absent);
    expect((await get(app, `/spending/patterns?today=${TODAY}`)).status).toBe(200);
  });
});
