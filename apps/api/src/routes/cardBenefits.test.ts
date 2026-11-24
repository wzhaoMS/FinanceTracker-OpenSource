import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { BenefitCatalog, CardBenefitsReport, IssuerBenefitTrackerSnapshot } from '@finance-tracker/shared';
import { exceptCardSpendingPaths, mountCardSpendingRoutes } from './cardSpending.js';
import { createCardBenefitsRouter } from './cardBenefits.js';
import { CARD_BENEFITS_TABLES } from '../services/cardBenefits.js';
import { HoldrRefusal } from '../services/dbErrors.js';
import { CURRENT_USER_VERSION, SqliteStateRepo, type CardImportRow } from '../services/sqliteStateRepo.js';
import { listenLoopback } from '../testing/loopback.js';

// The Benefits tab's routes. Every fixture is synthetic: a made-up catalog,
// fictional descriptions, made-up amounts and last-4s.

const CATALOG: BenefitCatalog = {
  version: '2026.10.1',
  products: [
    {
      id: 'amex-sample-reserve', issuer: 'amex', name: 'Sample Reserve Card', shortName: 'Sample Reserve',
      nicknamePatterns: ['\\bsample\\s+reserve\\b'], annualFeeMinor: 40_000, sourceUrl: 'https://www.example.com/sample-reserve',
      benefits: [
        {
          id: 'stream', name: 'Streaming credit', kind: 'credit', value: { unit: 'usd', amountMinor: 2_000 },
          cadence: { every: 'month', basis: 'calendar' }, enrollment: true,
          tracking: { method: 'statement-credit', patterns: ['sample\\s*stream\\w*\\s+credit'] },
        },
        {
          id: 'boutique', name: 'Boutique credit', kind: 'credit', value: { unit: 'usd', amountMinor: 5_000 },
          cadence: { every: 'half', basis: 'calendar' }, enrollment: true,
          tracking: { method: 'statement-credit', patterns: ['\\bboutique\\b.*\\bcredit\\b'] },
        },
        {
          id: 'ride-cash', name: 'Ride cash', kind: 'credit', value: { unit: 'usd', amountMinor: 1_000 },
          cadence: { every: 'month', basis: 'calendar' }, enrollment: false, tracking: { method: 'manual', reason: 'partner-balance' },
          issuerTrackerIds: ['ride.cash'],
        },
        {
          id: 'free-night', name: 'Free night', kind: 'certificate', value: { unit: 'count', count: 1, noun: 'free night' },
          cadence: { every: 'year', basis: 'cardmember' }, enrollment: false, tracking: { method: 'manual', reason: 'certificate' },
        },
      ],
    },
    {
      id: 'chase-sample-plus', issuer: 'chase', name: 'Sample Plus Card', shortName: 'Sample Plus',
      nicknamePatterns: ['\\bsample\\s+plus\\b'], annualFeeMinor: 9_500, sourceUrl: 'https://www.example.com/sample-plus', benefits: [],
    },
  ],
};

let dir: string;
let file: string;
let repo: SqliteStateRepo;
let app: express.Express;
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
  mountCardSpendingRoutes(server, { repo, requireAuth: testAuth, log, routers: [createCardBenefitsRouter(repo, { log })] });
  return server;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-card-benefits-'));
  file = path.join(dir, 'finance.db');
  repo = new SqliteStateRepo({ file, now: () => new Date('2026-10-19T12:00:00.000Z'), benefitsCatalog: CATALOG });
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
  expect(logs.join('\n')).not.toMatch(/\d{13}/);
  repo.close();
  await rm(dir, { recursive: true, force: true });
});

const get = async (url: string) => request(await listenLoopback(app)).get(url).set('x-test-auth', 'ok');
const put = async (url: string, body: unknown) => request(await listenLoopback(app)).put(url).set('x-test-auth', 'ok')
  .set('Content-Type', 'application/json').send(typeof body === 'string' ? body : JSON.stringify(body));
const del = async (url: string) => request(await listenLoopback(app)).delete(url).set('x-test-auth', 'ok');

function row(patch: Partial<CardImportRow> = {}): CardImportRow {
  return {
    transactionDate: '2026-09-10', postedDate: '2026-09-11', status: 'posted', amountMinor: -2000, currency: 'USD',
    kind: 'adjustment', description: 'SAMPLE STREAMING CREDIT', merchant: null, issuerCategory: 'Fees & Adjustments', ...patch,
  };
}

function seed() {
  const reserve = repo.createCardAccount({ issuer: 'amex', owner: 'alex', nickname: 'Sample Reserve', last4: '0001', currency: 'USD' });
  const plus = repo.createCardAccount({ issuer: 'chase', owner: 'casey', nickname: 'Sample Plus', last4: '0002', currency: 'USD' });
  const other = repo.createCardAccount({ issuer: 'citi', owner: 'joint', nickname: 'Sample Other', last4: '0003', currency: 'USD' });
  repo.importCardTransactions({
    cardAccountId: reserve.id, source: 'test-sync', parserVersion: 'test@1', rows: [
      row({ transactionDate: '2026-09-10' }),
      row({ transactionDate: '2026-10-04', amountMinor: -1500 }),
      row({ transactionDate: '2026-03-12', description: 'SAMPLE BOUTIQUE CREDIT', amountMinor: -5000 }),
      // Not benefits: a payment, a purchase and a store refund.
      row({ transactionDate: '2026-09-20', kind: 'payment', description: 'AUTOPAY PAYMENT THANK YOU', amountMinor: -50000, issuerCategory: null }),
      row({ transactionDate: '2026-09-21', kind: 'purchase', description: 'SAMPLE BOUTIQUE', amountMinor: 12000, issuerCategory: 'Merchandise' }),
      row({ transactionDate: '2026-09-22', kind: 'refund', description: 'SAMPLE BOUTIQUE', amountMinor: -3000, issuerCategory: 'Merchandise' }),
      // A pending credit is not counted until it posts.
      row({ transactionDate: '2026-08-02', postedDate: null, status: 'pending', amountMinor: -2000 }),
    ],
  });
  return { reserve, plus, other };
}

const reportOf = async (query = '?year=2026&today=2026-10-19') => {
  const res = await get(`/spending/benefits${query}`);
  expect(res.status).toBe(200);
  return res.body as CardBenefitsReport;
};

describe('the benefits tables', () => {
  it('are created beside the card tables, idempotently, without a schema version bump', () => {
    const db = repo.internalGetDb();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'benefit\\_%' ESCAPE '\\' ORDER BY name")
      .all() as Array<{ name: string }>).map((entry) => entry.name);
    expect(tables).toEqual([...CARD_BENEFITS_TABLES].sort());
    expect(repo.schemaVersion()).toBe(CURRENT_USER_VERSION);
    // No object of the benefits tables names the card transactions table (the v15 upgrade's precondition P1).
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE tbl_name LIKE 'benefit\\_%' ESCAPE '\\' AND instr(lower(sql), 'card_transactions') > 0")
      .get()).toEqual({ n: 0 });
    repo.close();
    const before = new Database(file);
    const schema = before.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all();
    before.close();
    repo = new SqliteStateRepo({ file, benefitsCatalog: CATALOG });
    expect(repo.internalGetDb().prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all()).toEqual(schema);
  });

  it('refuse rows of the wrong shape even from outside Holdr', () => {
    const { reserve } = seed();
    const db = repo.internalGetDb();
    const refused = [
      [`INSERT INTO benefit_settings VALUES (?, 'manual', NULL, NULL, '2026-10-19T12:00:00.000Z')`, reserve.id],
      [`INSERT INTO benefit_settings VALUES (?, 'auto', NULL, 13, '2026-10-19T12:00:00.000Z')`, reserve.id],
      [`INSERT INTO benefit_settings VALUES ('card-acct-missing', 'auto', NULL, NULL, '2026-10-19T12:00:00.000Z')`],
      [`INSERT INTO benefit_marks VALUES (?, 'stream', '2026-10-01', 'partial', NULL, '2026-10-19T12:00:00.000Z')`, reserve.id],
      [`INSERT INTO benefit_marks VALUES (?, 'card 4111111111111111', '2026-10-01', 'used', NULL, '2026-10-19T12:00:00.000Z')`, reserve.id],
      [`INSERT INTO benefit_marks VALUES (?, '4111-1111-1111-1111', '2026-10-01', 'used', NULL, '2026-10-19T12:00:00.000Z')`, reserve.id],
      [`INSERT INTO benefit_settings VALUES (?, 'manual', '4111-1111-1111-1111', NULL, '2026-10-19T12:00:00.000Z')`, reserve.id],
      [`INSERT INTO benefit_issuer_trackers VALUES (?, 'amex', 'x', 'Ending 12345', '2026-10-01', '2026-10-31', 'money', 'USD', 1, 2, NULL,
        'unknown', '2026-10-19T12:00:00.000Z', '2026-10-19T12:00:00.000Z')`, reserve.id],
      [`INSERT INTO benefit_issuer_trackers VALUES (?, 'amex', '4111.1111.1111.1111', 'Name', '2026-10-01', '2026-10-31', 'money', 'USD',
        1, 2, NULL, 'unknown', '2026-10-19T12:00:00.000Z', '2026-10-19T12:00:00.000Z')`, reserve.id],
      [`INSERT INTO benefit_issuer_trackers VALUES (?, 'amex', 'x', 'Card 4111 1111 1111 1111', '2026-10-01', '2026-10-31', 'money', 'USD',
        1, 2, NULL, 'unknown', '2026-10-19T12:00:00.000Z', '2026-10-19T12:00:00.000Z')`, reserve.id],
      [`INSERT INTO benefit_issuer_trackers VALUES (?, 'amex', 'x', 'Name', '2026-10-01', '2026-09-30', 'count', NULL, 1, 2, NULL,
        'unknown', '2026-10-19T12:00:00.000Z', '2026-10-19T12:00:00.000Z')`, reserve.id],
    ] as const;
    for (const [sql, ...params] of refused) expect(() => db.prepare(sql).run(...params), sql).toThrow();
  });
});

describe('GET /spending/benefits', () => {
  it('reports each card\'s product, its benefits per period from posted credits, and the household totals', async () => {
    const { reserve, plus, other } = seed();
    const report = await reportOf();
    expect(report.year).toBe(2026);
    expect(report.catalogVersion).toBe('2026.10.1');
    const byId = new Map(report.cards.map((card) => [card.cardAccountId, card]));
    const card = byId.get(reserve.id)!;
    expect([card.product?.id, card.productSource, card.owner, card.last4]).toEqual(['amex-sample-reserve', 'auto', 'alex', '0001']);
    const stream = card.benefits.find((benefit) => benefit.id === 'stream')!;
    expect(stream.periods.map((period) => period.usedMinor)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 2000, 1500, 0, 0]);
    expect(stream.periods[8].matches.map((match) => match.description)).toEqual(['SAMPLE STREAMING CREDIT']);
    expect([stream.current?.label, stream.current?.remainingMinor, stream.current?.daysLeft]).toEqual(['Oct', 500, 13]);
    const boutique = card.benefits.find((benefit) => benefit.id === 'boutique')!;
    expect(boutique.periods.map((period) => [period.usedMinor, period.source])).toEqual([[5000, 'derived'], [0, 'derived']]);
    expect(card.needsAnniversary).toBe(true);
    expect(byId.get(plus.id)?.product?.id).toBe('chase-sample-plus');
    expect([byId.get(other.id)?.product, byId.get(other.id)?.productSource]).toEqual([null, 'none']);
    expect(report.household).toMatchObject({ capturedMinor: 8500, availableMinor: 12 * 2000 + 2 * 5000 + 12 * 1000, annualFeesMinor: 49_500 });
    expect(report.products.map((product) => product.id)).toEqual(['amex-sample-reserve', 'chase-sample-plus']);
  });

  it('defaults to this year, and refuses bad or unknown parameters', async () => {
    seed();
    const report = await reportOf('');
    expect(report.year).toBe(Number(report.today.slice(0, 4)));
    expect((await get('/spending/benefits?year=1999')).status).toBe(400);
    expect((await get('/spending/benefits?year=20x6')).status).toBe(400);
    expect((await get('/spending/benefits?today=2026-02-30')).status).toBe(400);
    expect((await get('/spending/benefits?owner=alex')).body).toEqual({ error: 'unexpected query parameter' });
    const card = await get('/spending/benefits?year=4111111111111111');
    expect(card.status).toBe(422);
    expect(card.body).toEqual(expect.objectContaining({ paths: ['query.year'] }));
  });

  it('needs sign-in', async () => {
    expect((await request(await listenLoopback(app)).get('/spending/benefits')).status).toBe(401);
  });
});

describe('PUT /spending/benefits/cards/:id', () => {
  it('chooses a product by hand, or none, or the nickname again, and keeps the anniversary month', async () => {
    const { reserve, other } = seed();
    const chosen = await put(`/spending/benefits/cards/${other.id}`, { productChoice: 'manual', productId: 'amex-sample-reserve' });
    expect(chosen.status).toBe(400);
    expect(chosen.body.error).toBe('productId belongs to another issuer');
    const month = await put(`/spending/benefits/cards/${reserve.id}`, { productChoice: 'auto', anniversaryMonth: 11 });
    expect(month.body.settings).toMatchObject({ productChoice: 'auto', productId: null, anniversaryMonth: 11 });
    const none = await put(`/spending/benefits/cards/${reserve.id}`, { productChoice: 'none' });
    expect(none.body.settings).toMatchObject({ productChoice: 'none', anniversaryMonth: 11 });
    let report = await reportOf();
    expect(report.cards.find((card) => card.cardAccountId === reserve.id)?.productSource).toBe('none');
    const manual = await put(`/spending/benefits/cards/${reserve.id}`, { productChoice: 'manual', productId: 'amex-sample-reserve', anniversaryMonth: null });
    expect(manual.body.settings).toMatchObject({ productChoice: 'manual', productId: 'amex-sample-reserve', anniversaryMonth: null });
    report = await reportOf();
    expect(report.cards.find((card) => card.cardAccountId === reserve.id)?.productSource).toBe('manual');
  });

  it('refuses unknown products, bad months, other keys, card data and unknown cards', async () => {
    const { reserve } = seed();
    const url = `/spending/benefits/cards/${reserve.id}`;
    const answers = await Promise.all([
      put(url, { productChoice: 'manual', productId: 'amex-no-such-card' }),
      put(url, { productChoice: 'manual' }),
      put(url, { productChoice: 'auto', productId: 'amex-sample-reserve' }),
      put(url, { productChoice: 'sometimes' }),
      put(url, { productChoice: 'auto', anniversaryMonth: 0 }),
      put(url, { productChoice: 'auto', anniversaryMonth: '3' }),
      put(url, { productChoice: 'auto', note: 'x' }),
      put(url, '[1]'),
    ]);
    expect(answers.map((answer) => [answer.status, answer.body.error])).toEqual([
      [400, 'productId is not in the benefits catalog'],
      [400, 'productId is required for a manual choice'],
      [400, 'productId is only for a manual choice'],
      [400, 'productChoice must be auto, manual or none'],
      [400, 'anniversaryMonth must be 1 to 12, or null'],
      [400, 'anniversaryMonth must be 1 to 12, or null'],
      [400, 'body has an unexpected key'],
      [400, 'body must be an object'],
    ]);
    expect((await put('/spending/benefits/cards/card-acct-missing', { productChoice: 'auto' })).status).toBe(404);
    const carded = await put(url, { productChoice: 'manual', productId: '4111 1111 1111 1111' });
    expect([carded.status, carded.body.paths]).toEqual([422, ['$.productId']]);
    expect(repo.listCardBenefitSettings()).toEqual([]);
  });
});

describe('benefit marks', () => {
  it('records the owner\'s word for a period, which the report prefers to matched credits, and clears it', async () => {
    const { reserve } = seed();
    const used = await put('/spending/benefits/marks', { cardAccountId: reserve.id, benefitId: 'ride-cash', periodStart: '2026-09-01', status: 'used' });
    expect(used.body.mark).toMatchObject({ benefitId: 'ride-cash', periodStart: '2026-09-01', status: 'used', usedMinor: null });
    const partial = await put('/spending/benefits/marks', {
      cardAccountId: reserve.id, benefitId: 'stream', periodStart: '2026-09-01', status: 'partial', usedMinor: 700,
    });
    expect(partial.body.mark).toMatchObject({ status: 'partial', usedMinor: 700 });
    let card = (await reportOf()).cards.find((entry) => entry.cardAccountId === reserve.id)!;
    const sep = (id: string) => card.benefits.find((benefit) => benefit.id === id)!.periods[8];
    expect([sep('ride-cash').usedMinor, sep('ride-cash').source]).toEqual([1000, 'manual']);
    expect([sep('stream').usedMinor, sep('stream').source, sep('stream').derivedMinor]).toEqual([700, 'manual', 2000]);
    expect((await del(`/spending/benefits/marks?cardAccountId=${reserve.id}&benefitId=stream&periodStart=2026-09-01`)).status).toBe(204);
    expect((await del(`/spending/benefits/marks?cardAccountId=${reserve.id}&benefitId=stream&periodStart=2026-09-01`)).status).toBe(404);
    card = (await reportOf()).cards.find((entry) => entry.cardAccountId === reserve.id)!;
    expect([sep('stream').usedMinor, sep('stream').source]).toEqual([2000, 'derived']);
  });

  it('places a cardmember-year mark only once the anniversary month is known', async () => {
    const { reserve } = seed();
    const mark = { cardAccountId: reserve.id, benefitId: 'free-night', periodStart: '2025-11-01', status: 'used' };
    expect((await put('/spending/benefits/marks', mark)).body.error).toBe('set the card\'s anniversary month first');
    await put(`/spending/benefits/cards/${reserve.id}`, { productChoice: 'auto', anniversaryMonth: 11 });
    expect((await put('/spending/benefits/marks', mark)).status).toBe(200);
    const night = (await reportOf()).cards.find((entry) => entry.cardAccountId === reserve.id)!.benefits.find((benefit) => benefit.id === 'free-night')!;
    expect([night.current?.start, night.current?.usedMinor, night.current?.source]).toEqual(['2025-11-01', 1, 'manual']);
  });

  it('refuses marks that name no period of the card\'s benefits', async () => {
    const { reserve, plus } = seed();
    const mark = (patch: Record<string, unknown>) => put('/spending/benefits/marks', {
      cardAccountId: reserve.id, benefitId: 'stream', periodStart: '2026-09-01', status: 'used', ...patch,
    });
    const answers = await Promise.all([
      mark({ periodStart: '2026-09-02' }),
      mark({ periodStart: '2026-09-31' }),
      mark({ benefitId: 'no-such-benefit' }),
      mark({ cardAccountId: plus.id }),
      mark({ status: 'partial', usedMinor: 2001 }),
      mark({ status: 'partial', usedMinor: 1.5 }),
      mark({ status: 'partial' }),
      mark({ status: 'used', usedMinor: 5 }),
      mark({ status: 'maybe' }),
      mark({ extra: true }),
      mark({ usedMinor: '5' }),
    ]);
    expect(answers.map((answer) => [answer.status, answer.body.error])).toEqual([
      [400, 'periodStart must be the first day of one of the benefit\'s periods'],
      [400, 'periodStart must be a YYYY-MM-DD date'],
      [400, 'benefitId is not a benefit of this card\'s product'],
      [400, 'benefitId is not a benefit of this card\'s product'],
      [400, 'usedMinor must be a whole amount from zero to the period\'s amount'],
      [400, 'usedMinor must be a whole amount from zero to the period\'s amount'],
      [400, 'usedMinor must be a whole amount from zero to the period\'s amount'],
      [400, 'usedMinor is only for a partial mark'],
      [400, 'status must be used, partial or unused'],
      [400, 'body has an unexpected key'],
      [400, 'usedMinor must be a whole number'],
    ]);
    expect((await mark({ cardAccountId: 'card-acct-missing' })).status).toBe(404);
    expect((await del('/spending/benefits/marks?cardAccountId=x')).status).toBe(400);
    expect(repo.listCardBenefitMarks()).toEqual([]);
  });

  it('never writes a card account or transaction', async () => {
    const { reserve } = seed();
    const db = repo.internalGetDb();
    const cardTables = () => JSON.stringify((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'card\\_%' ESCAPE '\\' ORDER BY name")
      .all() as Array<{ name: string }>).map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
    const before = cardTables();
    await put(`/spending/benefits/cards/${reserve.id}`, { productChoice: 'manual', productId: 'amex-sample-reserve', anniversaryMonth: 4 });
    await put('/spending/benefits/marks', { cardAccountId: reserve.id, benefitId: 'stream', periodStart: '2026-10-01', status: 'unused' });
    await del(`/spending/benefits/marks?cardAccountId=${reserve.id}&benefitId=stream&periodStart=2026-10-01`);
    await reportOf();
    expect(cardTables()).toBe(before);
  });
});

describe('issuer-reported trackers', () => {
  const snapshot = (patch: Partial<IssuerBenefitTrackerSnapshot> = {}): IssuerBenefitTrackerSnapshot => ({
    issuer: 'amex', issuerBenefitId: 'ride.cash', name: 'Sample Ride Cash', periodStart: '2026-10-01', periodEnd: '2026-10-31',
    unit: 'money', currency: 'USD', usedMinor: 400, totalMinor: 1000, resetDate: '2026-11-01', enrollment: 'not-required',
    observedAt: '2026-10-19T11:00:00.000Z', ...patch,
  });

  it('keeps the latest observation per tracker and period, which overrides the period in the report', async () => {
    const { reserve } = seed();
    expect(repo.recordCardBenefitTrackers({ cardAccountId: reserve.id, snapshots: [snapshot(), snapshot({ issuerBenefitId: 'other.perk' })] }))
      .toEqual({ inserted: 2, updated: 0, unchanged: 0, older: 0 });
    expect(repo.recordCardBenefitTrackers({
      cardAccountId: reserve.id,
      snapshots: [snapshot({ observedAt: '2026-10-19T11:30:00.000Z', usedMinor: 600 }), snapshot({ issuerBenefitId: 'other.perk', observedAt: '2026-10-19T10:00:00.000Z' })],
    })).toEqual({ inserted: 0, updated: 1, unchanged: 0, older: 1 });
    expect(repo.recordCardBenefitTrackers({ cardAccountId: reserve.id, snapshots: [snapshot({ observedAt: '2026-10-19T11:45:00.000Z', usedMinor: 600 })] }))
      .toEqual({ inserted: 0, updated: 0, unchanged: 1, older: 0 });
    const card = (await reportOf()).cards.find((entry) => entry.cardAccountId === reserve.id)!;
    const oct = card.benefits.find((benefit) => benefit.id === 'ride-cash')!.periods[9];
    expect([oct.source, oct.usedMinor, oct.availableMinor, oct.issuer?.observedAt]).toEqual(['issuer', 600, 1000, '2026-10-19T11:45:00.000Z']);
    expect(card.issuerTrackers.map((tracker) => tracker.issuerBenefitId)).toEqual(['other.perk']);
  });

  it('refuses the whole list, naming paths and codes only, for any bad snapshot or another issuer', () => {
    const { reserve, plus } = seed();
    const refusal = (() => {
      try {
        repo.recordCardBenefitTrackers({
          cardAccountId: reserve.id,
          snapshots: [snapshot(), snapshot({ issuerBenefitId: 'other.perk', name: 'Ending 4111 1111 1111 1111', usedMinor: -1 })],
        });
      } catch (error) {
        return error as Error;
      }
      throw new Error('expected a refusal');
    })();
    expect(refusal).toBeInstanceOf(HoldrRefusal);
    expect(refusal.message).toBe('issuer benefit trackers are invalid: $[1].name card-data, $[1].usedMinor range');
    expect(() => repo.recordCardBenefitTrackers({ cardAccountId: plus.id, snapshots: [snapshot()] }))
      .toThrow('issuer benefit trackers are invalid: $[0].issuer format');
    // An id the issuer grouped like a card number, or a labelled code, is refused by name of the field only.
    for (const issuerBenefitId of ['4111-1111-1111-1111', 'CVV:123']) {
      expect(() => repo.recordCardBenefitTrackers({ cardAccountId: reserve.id, snapshots: [snapshot({ issuerBenefitId })] }))
        .toThrow('issuer benefit trackers are invalid: $[0].issuerBenefitId card-data');
    }
    expect(() => repo.recordCardBenefitTrackers({ cardAccountId: 'card-acct-missing', snapshots: [] })).toThrow('card account does not exist');
    expect(repo.listCardBenefitTrackers()).toEqual([]);
  });
});
