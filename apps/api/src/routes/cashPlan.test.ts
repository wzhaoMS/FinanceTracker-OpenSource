import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { validateCardScheduleObservation, type ValidCardScheduleObservation } from '@finance-tracker/shared';
import { exceptCardSpendingPaths, mountCardSpendingRoutes } from './cardSpending.js';
import { CASH_PLAN_CONFLICT_CODE, createCashPlanRouter } from './cashPlan.js';
import { importCardScheduleObservations, installCashPlanSchema } from '../services/cashPlan.js';
import { SqliteStateRepo, type CardImportRow } from '../services/sqliteStateRepo.js';
import { listenLoopback } from '../testing/loopback.js';

// GET /cash/payments and GET /cash/owed end to end on a database made by this build. Synthetic only: made-up issuers,
// last fours, dates and cents.

let dir: string;
let repo: SqliteStateRepo;
let logs: string[];
const NOW = new Date('2026-11-03T17:00:00.000Z');
const REF = `sha256:${'e'.repeat(64)}`;

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
  mountCardSpendingRoutes(server, { repo, requireAuth: testAuth, log, routers: [createCashPlanRouter(repo, { log, now: () => NOW })] });
  return server;
}
const get = async (url: string, auth = 'ok') => request(await listenLoopback(buildApp())).get(url).set('x-test-auth', auth);

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-cash-route-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db'), now: () => NOW });
  logs = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  repo.close();
  await rm(dir, { recursive: true, force: true });
});

function valid(input: Record<string, unknown>): ValidCardScheduleObservation {
  const result = validateCardScheduleObservation({ currency: 'USD', sourceRef: REF, extractorVersion: 'synthetic@1', ...input });
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

function seed() {
  const card = repo.createCardAccount({ issuer: 'testbank', owner: 'alex', nickname: 'Everyday', last4: '1234', currency: 'USD' });
  const other = repo.createCardAccount({ issuer: 'otherbank', owner: 'casey', last4: '5678', currency: 'USD' });
  const rows: CardImportRow[] = [{ transactionDate: '2026-10-20', postedDate: '2026-10-20', status: 'posted', amountMinor: 1234, currency: 'USD',
    kind: 'purchase', description: 'SAMPLE SHOP', merchant: null, issuerCategory: null } as CardImportRow];
  repo.importCardTransactions({ cardAccountId: card.id, source: 'ofx', parserVersion: 'synthetic@1', coverage: { start: '2026-08-01', end: '2026-11-03' }, rows });
  installCashPlanSchema(repo.internalGetDb());
  importCardScheduleObservations(repo.internalGetDb(), [
    valid({ card: { issuer: 'testbank', last4: '1234' }, sourceKind: 'statement-pdf', observedAt: '2026-09-13T12:00:00Z',
      asOf: { source: 'statement', at: '2026-09-11', precision: 'date' }, statementClosingDate: '2026-09-11', paymentDueDate: '2026-10-06',
      statementBalanceMinor: 0, minimum: { minor: 0, basis: 'total-due' }, pastDueMinor: 0 }),
    valid({ card: { issuer: 'testbank', last4: '1234' }, sourceKind: 'statement-pdf', observedAt: '2026-10-13T12:00:00Z',
      asOf: { source: 'statement', at: '2026-10-11', precision: 'date' }, statementPeriodStartDate: '2026-09-12', statementClosingDate: '2026-10-11',
      paymentDueDate: '2026-11-06', statementBalanceMinor: 20000, minimum: { minor: 5000, basis: 'total-due' }, pastDueMinor: 0 }),
    valid({ card: { issuer: 'otherbank', last4: '5678' }, sourceKind: 'issuer-dashboard-dom', observedAt: '2026-11-03T13:00:00Z',
      asOf: { source: 'explicit', at: '2026-11-03T12:30:00Z', precision: 'instant' }, paymentDueDate: '2026-11-05', remainingStatementMinor: 3000, pastDueMinor: 1500 }),
    valid({ card: { issuer: 'nobank', last4: '0000' }, sourceKind: 'statement-pdf', observedAt: '2026-10-13T12:00:00Z',
      asOf: { source: 'statement', at: '2026-10-11', precision: 'date' }, statementClosingDate: '2026-10-11' }),
  ], { importRef: REF, now: '2026-11-03T13:30:00.000Z' });
  return { card, other };
}

describe('GET /cash/payments', () => {
  it('needs sign-in; the service token may read; there are no writes and no query parameters', async () => {
    expect((await get('/cash/payments', 'none')).status).toBe(401);
    const service = await get('/cash/payments', 'service');
    expect(service.status).toBe(200);
    expect(service.headers['cache-control']).toBe('no-store');
    expect((await get('/cash/payments?card=1')).status).toBe(400);
    expect((await get('/cash/payments?q=4111111111111111')).status).toBe(422);
    const post = await request(await listenLoopback(buildApp())).post('/cash/payments').set('x-test-auth', 'ok').send({});
    expect(post.status).toBeGreaterThanOrEqual(400);
  });

  it('answers installed:false with no cards before the operator installs the table', async () => {
    repo.createCardAccount({ issuer: 'testbank', owner: 'alex', last4: '1234', currency: 'USD' });
    const response = await get('/cash/payments');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      installed: false, mode: 'knowledge', asOf: NOW.toISOString(), today: '2026-11-03', timeZone: 'America/New_York',
      rules: { amberDays: 10, redDays: 3, policy: 'statement' }, cards: [], totals: { red: 0, amber: 0, unknown: 0, held: 0 },
    });
  });

  it('serves every card\'s cycles, bank reads, delinquency and attention, with totals', async () => {
    const { card, other } = seed();
    const response = await get('/cash/payments');
    expect(response.status).toBe(200);
    const body = response.body;
    expect(body).toMatchObject({ installed: true, mode: 'knowledge', today: '2026-11-03', totals: { red: 3, amber: 0, unknown: 0, held: 1 } });
    const testbank = body.cards.find((item: { cardAccountId: string }) => item.cardAccountId === card.id);
    expect(testbank).toMatchObject({ issuer: 'testbank', nickname: 'Everyday', last4: '1234', owner: 'alex', status: 'active', delinquency: null, bankReads: [] });
    expect(testbank.cycles.map((cycle: { closingDate: string }) => cycle.closingDate)).toEqual(['2026-10-11']);
    expect(testbank.cycles[0]).toMatchObject({
      dueDate: '2026-11-06', minimumDueMinor: 5000, statementBalanceMinor: 20000, state: 'unpaid', coverageThrough: '2026-11-03',
      ledger: { provenMinor: 0, possibleMinor: 0, proven: 0, possible: 0 }, predecessor: { kind: 'captured', resolved: true },
    });
    expect(testbank.attention.map((item: { rule: string; reason: string }) => [item.rule, item.reason])).toEqual([['R2a', 'no-payment-seen']]);
    const otherbank = body.cards.find((item: { cardAccountId: string }) => item.cardAccountId === other.id);
    expect(otherbank.delinquency).toMatchObject({ pastDueMinor: 1500, downgraded: null });
    expect(otherbank.bankReads).toHaveLength(1);
    expect(otherbank.attention.map((item: { rule: string }) => item.rule).sort()).toEqual(['R1a', 'R2b']);
    expect(body.cards.every((item: { cycles: Array<Record<string, unknown>> }) => item.cycles.every((cycle) => !('shown' in cycle)))).toBe(true);
    expect(logs.join('\n')).not.toMatch(/\d{5,}/);
  });

  it('a table in another shape is the fixed 409, never a partial answer', async () => {
    installCashPlanSchema(repo.internalGetDb());
    repo.internalGetDb().exec('DROP INDEX card_schedule_observations_card_cycle');
    const response = await get('/cash/payments');
    expect(response.status).toBe(409);
    expect(response.body.code).toBe(CASH_PLAN_CONFLICT_CODE);
  });
});

describe('GET /cash/owed', () => {
  /** Five cards (two closed) and their reads: a statement, balance-only reads, a disagreement, held rows. */
  function seedOwed() {
    const everyday = repo.createCardAccount({ issuer: 'testbank', owner: 'alex', nickname: 'Everyday', last4: '1234', currency: 'USD' });
    const unread = repo.createCardAccount({ issuer: 'otherbank', owner: 'casey', last4: '5678', currency: 'USD' });
    const disputed = repo.createCardAccount({ issuer: 'thirdbank', owner: 'joint', last4: '9012', currency: 'USD' });
    const paidOff = repo.createCardAccount({ issuer: 'testbank', owner: 'alex', last4: '4321', currency: 'USD' });
    const credit = repo.createCardAccount({ issuer: 'otherbank', owner: 'alex', last4: '8765', currency: 'USD' });
    repo.updateCardAccount(paidOff.id, { status: 'closed' });
    repo.updateCardAccount(credit.id, { status: 'closed' });
    installCashPlanSchema(repo.internalGetDb());
    const summary = importCardScheduleObservations(repo.internalGetDb(), [
      // A statement, then a newer read with no statement dates (held cycle-unknown): the balance is the newer read's.
      valid({ card: { issuer: 'testbank', last4: '1234' }, sourceKind: 'statement-pdf', observedAt: '2026-10-13T12:00:00Z',
        asOf: { source: 'statement', at: '2026-10-11', precision: 'date' }, statementClosingDate: '2026-10-11', paymentDueDate: '2026-11-06',
        statementBalanceMinor: 20000, minimum: { minor: 5000, basis: 'total-due' }, currentBalanceMinor: 20000 }),
      valid({ card: { issuer: 'testbank', last4: '1234' }, sourceKind: 'issuer-dashboard-json', observedAt: '2026-11-03T13:00:00Z',
        currentBalanceMinor: 34567, remainingStatementMinor: 15000 }),
      // Later still, but held for its minimum's basis: shown nowhere, counted.
      valid({ card: { issuer: 'testbank', last4: '1234' }, sourceKind: 'issuer-dashboard-dom', observedAt: '2026-11-03T14:00:00Z',
        paymentDueDate: '2026-11-06', minimum: { minor: 2500, basis: 'current-only' }, currentBalanceMinor: 99999 }),
      // Two reads at one instant that disagree: no balance, said as a disagreement.
      valid({ card: { issuer: 'thirdbank', last4: '9012' }, sourceKind: 'issuer-dashboard-json', observedAt: '2026-11-02T15:00:00Z', currentBalanceMinor: 1000 }),
      valid({ card: { issuer: 'thirdbank', last4: '9012' }, sourceKind: 'issuer-dashboard-json', observedAt: '2026-11-02T15:00:00Z', currentBalanceMinor: 1100 }),
      // Closed cards: paid off (left out) and holding a credit (listed).
      valid({ card: { issuer: 'testbank', last4: '4321' }, sourceKind: 'issuer-dashboard-json', observedAt: '2026-11-01T12:00:00Z', currentBalanceMinor: 0 }),
      valid({ card: { issuer: 'otherbank', last4: '8765' }, sourceKind: 'issuer-dashboard-json', observedAt: '2026-11-01T12:00:00Z', currentBalanceMinor: -500 }),
      // No card of this Holdr: counted, never shown.
      valid({ card: { issuer: 'nobank', last4: '0000' }, sourceKind: 'issuer-dashboard-json', observedAt: '2026-11-01T12:00:00Z', currentBalanceMinor: 700 }),
    ], { importRef: REF, now: '2026-11-03T15:30:00.000Z' });
    expect(summary).toMatchObject({ inserted: 8, held: { 'cycle-unknown': 5, 'minimum-basis': 1, unbound: 1 } });
    return { everyday, unread, disputed, credit };
  }

  it('needs sign-in; the service token may read; there are no writes and no query parameters', async () => {
    expect((await get('/cash/owed', 'none')).status).toBe(401);
    const service = await get('/cash/owed', 'service');
    expect(service.status).toBe(200);
    expect(service.headers['cache-control']).toBe('no-store');
    expect((await get('/cash/owed?owner=alex')).status).toBe(400);
    expect((await get('/cash/owed?q=4111111111111111')).status).toBe(422);
    const post = await request(await listenLoopback(buildApp())).post('/cash/owed').set('x-test-auth', 'ok').send({});
    expect(post.status).toBeGreaterThanOrEqual(400);
  });

  it('lists every active card unread before the operator installs the table', async () => {
    const card = repo.createCardAccount({ issuer: 'testbank', owner: 'alex', last4: '1234', currency: 'USD' });
    const closed = repo.createCardAccount({ issuer: 'testbank', owner: 'casey', last4: '4321', currency: 'USD' });
    repo.updateCardAccount(closed.id, { status: 'closed' });
    const response = await get('/cash/owed');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      installed: false, asOf: NOW.toISOString(), today: '2026-11-03', held: 0,
      cards: [{ cardAccountId: card.id, issuer: 'testbank', owner: 'alex', nickname: null, last4: '1234', last5: null, currency: 'USD',
        status: 'active', read: null }],
    });
  });

  it('answers each card\'s newest balance, its last statement and due date, a disagreement as no balance, and counts the rest', async () => {
    const { everyday, unread, disputed, credit } = seedOwed();
    const response = await get('/cash/owed');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ installed: true, asOf: NOW.toISOString(), today: '2026-11-03', held: 2 });
    expect(response.body.cards.map((card: { cardAccountId: string }) => card.cardAccountId)).toEqual([everyday.id, unread.id, disputed.id, credit.id]);
    const [first, second, third, fourth] = response.body.cards;
    expect(first).toEqual({
      cardAccountId: everyday.id, issuer: 'testbank', owner: 'alex', nickname: 'Everyday', last4: '1234', last5: null, currency: 'USD',
      status: 'active',
      read: {
        currentBalanceMinor: 34567, conflict: false, asOf: '2026-11-03T13:00:00.000Z', asOfDate: '2026-11-03', sourceKind: 'issuer-dashboard-json',
        statementBalanceMinor: 20000, statementClosingDate: '2026-10-11', remainingStatementMinor: 15000, paymentDueDate: '2026-11-06',
        minimumDueMinor: 5000,
      },
    });
    expect(second.read).toBeNull();
    expect(third.read).toMatchObject({ currentBalanceMinor: null, conflict: true, asOf: '2026-11-02T15:00:00.000Z', asOfDate: '2026-11-02' });
    expect(fourth).toMatchObject({ status: 'closed', read: { currentBalanceMinor: -500, conflict: false, asOfDate: '2026-11-01' } });
    // The payment schedule still reads none of the balance-only rows: they stay held there.
    expect((await get('/cash/payments')).body.totals.held).toBe(7);
    expect(logs.join('\n')).not.toMatch(/\d{5,}/);
  });

  it('pairs a statement only with what was read of it and since: an earlier statement\'s remaining or due date never shows under it', async () => {
    const paid = repo.createCardAccount({ issuer: 'fourthbank', owner: 'alex', last4: '2468', currency: 'USD' });
    const later = repo.createCardAccount({ issuer: 'fifthbank', owner: 'casey', last4: '1357', currency: 'USD' });
    const again = repo.createCardAccount({ issuer: 'sixthbank', owner: 'alex', last4: '9753', currency: 'USD' });
    const sameDay = repo.createCardAccount({ issuer: 'seventhbank', owner: 'alex', last4: '8642', currency: 'USD' });
    const split = repo.createCardAccount({ issuer: 'eighthbank', owner: 'casey', last4: '7531', currency: 'USD' });
    const repeat = repo.createCardAccount({ issuer: 'ninthbank', owner: 'alex', last4: '6420', currency: 'USD' });
    const pdf = (issuer: string, last4: string, balance: number, minimum: number) => valid({ card: { issuer, last4 }, sourceKind: 'statement-pdf',
      observedAt: '2026-10-13T12:00:00Z', asOf: { source: 'statement', at: '2026-10-11', precision: 'date' }, statementClosingDate: '2026-10-11',
      paymentDueDate: '2026-11-06', statementBalanceMinor: balance, minimum: { minor: minimum, basis: 'total-due' } });
    const read = (issuer: string, last4: string, observedAt: string, fields: Record<string, unknown>) =>
      valid({ card: { issuer, last4 }, sourceKind: 'issuer-dashboard-json', observedAt, ...fields });
    installCashPlanSchema(repo.internalGetDb());
    importCardScheduleObservations(repo.internalGetDb(), [
      // Paid in full on Oct 8; the statement closing Oct 11 is new and unpaid: never "paid" from the Oct 8 read.
      read('fourthbank', '2468', '2026-10-08T12:00:00Z', { currentBalanceMinor: 1000, remainingStatementMinor: 0 }),
      pdf('fourthbank', '2468', 40000, 2500),
      // A September statement due Oct 6, then a newer read of a later statement with no due date: Oct 6 is not its due date.
      valid({ card: { issuer: 'fifthbank', last4: '1357' }, sourceKind: 'statement-pdf', observedAt: '2026-09-13T12:00:00Z',
        asOf: { source: 'statement', at: '2026-09-11', precision: 'date' }, statementClosingDate: '2026-09-11', paymentDueDate: '2026-10-06',
        statementBalanceMinor: 1000, minimum: { minor: 500, basis: 'total-due' } }),
      read('fifthbank', '1357', '2026-10-20T12:00:00Z', { currentBalanceMinor: 3000, statementBalanceMinor: 2000 }),
      // A later read showing the same statement keeps the statement's own close, due date and minimum.
      pdf('sixthbank', '9753', 40000, 2500),
      read('sixthbank', '9753', '2026-10-20T12:00:00Z', { currentBalanceMinor: 41000, statementBalanceMinor: 40000 }),
      // A read of the statement on its closing day (another precision, so unordered against it) is one of its reads.
      pdf('seventhbank', '8642', 30000, 2000),
      read('seventhbank', '8642', '2026-10-11T20:00:00Z', { currentBalanceMinor: 30500, statementBalanceMinor: 30000, remainingStatementMinor: 30000 }),
      // The newest statement reads disagree: nothing from before them (the Oct 8 "paid") shows.
      read('eighthbank', '7531', '2026-10-08T12:00:00Z', { currentBalanceMinor: 500, remainingStatementMinor: 0 }),
      read('eighthbank', '7531', '2026-10-20T12:00:00Z', { currentBalanceMinor: 1200, statementBalanceMinor: 1000 }),
      read('eighthbank', '7531', '2026-10-20T12:00:00Z', { currentBalanceMinor: 1200, statementBalanceMinor: 1100 }),
      // Two statements in a row of the same balance: a read naming no close before Oct 11 is the September one's ("paid").
      valid({ card: { issuer: 'ninthbank', last4: '6420' }, sourceKind: 'statement-pdf', observedAt: '2026-09-13T12:00:00Z',
        asOf: { source: 'statement', at: '2026-09-11', precision: 'date' }, statementClosingDate: '2026-09-11', statementBalanceMinor: 1599 }),
      read('ninthbank', '6420', '2026-09-25T12:00:00Z', { currentBalanceMinor: 0, statementBalanceMinor: 1599, remainingStatementMinor: 0 }),
      pdf('ninthbank', '6420', 1599, 1599),
    ], { importRef: REF, now: '2026-11-03T15:30:00.000Z' });
    const cards = (await get('/cash/owed')).body.cards as Array<{ cardAccountId: string; read: Record<string, unknown> }>;
    const readOf = (card: { id: string }) => cards.find((item) => item.cardAccountId === card.id)!.read;
    expect(readOf(paid)).toMatchObject({
      currentBalanceMinor: 1000, asOfDate: '2026-10-08', statementBalanceMinor: 40000, statementClosingDate: '2026-10-11',
      remainingStatementMinor: null, paymentDueDate: '2026-11-06', minimumDueMinor: 2500,
    });
    expect(readOf(later)).toMatchObject({
      currentBalanceMinor: 3000, statementBalanceMinor: 2000, statementClosingDate: null, remainingStatementMinor: null,
      paymentDueDate: null, minimumDueMinor: null,
    });
    expect(readOf(again)).toMatchObject({
      currentBalanceMinor: 41000, statementBalanceMinor: 40000, statementClosingDate: '2026-10-11', remainingStatementMinor: null,
      paymentDueDate: '2026-11-06', minimumDueMinor: 2500,
    });
    expect(readOf(sameDay)).toMatchObject({
      currentBalanceMinor: 30500, statementBalanceMinor: 30000, statementClosingDate: '2026-10-11', remainingStatementMinor: 30000,
      paymentDueDate: '2026-11-06', minimumDueMinor: 2000,
    });
    expect(readOf(split)).toMatchObject({
      currentBalanceMinor: 1200, statementBalanceMinor: null, statementClosingDate: null, remainingStatementMinor: null, paymentDueDate: null,
    });
    expect(readOf(repeat)).toMatchObject({
      statementBalanceMinor: 1599, statementClosingDate: '2026-10-11', remainingStatementMinor: null, paymentDueDate: '2026-11-06',
    });
  });

  it('a table in another shape is the same fixed 409', async () => {
    installCashPlanSchema(repo.internalGetDb());
    repo.internalGetDb().exec('DROP INDEX card_schedule_observations_card_cycle');
    const response = await get('/cash/owed');
    expect(response.status).toBe(409);
    expect(response.body.code).toBe(CASH_PLAN_CONFLICT_CODE);
  });
});
