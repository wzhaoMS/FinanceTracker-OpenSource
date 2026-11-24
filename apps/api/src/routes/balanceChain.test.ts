import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { formatBalanceChainReport, type CheckingImportPayload } from '@finance-tracker/shared';
import { cardSpendingAuth } from '../auth/serviceScope.js';
import { exceptCardSpendingPaths, mountCardSpendingRoutes } from './cardSpending.js';
import { createBalanceChainRouter } from './balanceChain.js';
import { readBalanceChainReport } from '../services/balanceChain.js';
import { importCheckingPayload } from '../services/checking/importer.js';
import { installCheckingSchema } from '../services/checking/schema.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { listenLoopback } from '../testing/loopback.js';

// GET /spending/balance-chains end to end on a database made by this build. Synthetic only: made-up banks, last fours,
// dates and cents.

let dir: string;
let repo: SqliteStateRepo;
let logs: string[];
const NOW = new Date('2026-11-03T17:00:00.000Z');

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
  mountCardSpendingRoutes(server, { repo, requireAuth: cardSpendingAuth(testAuth), log: (line) => logs.push(line), routers: [createBalanceChainRouter(repo)] });
  return server;
}
const get = async (url: string, auth = 'ok') => request(await listenLoopback(buildApp())).get(url).set('x-test-auth', auth);

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-balance-chain-route-'));
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

function seedChecking(): string {
  const payload: CheckingImportPayload = {
    format: 'holdr.checking-import', version: 1, parserVersion: 'synthetic@1',
    account: { institution: 'testbank', type: 'checking', last4: '4321', label: 'Synthetic checking', currency: 'USD' },
    segments: [{ source: 'ofx', coverage: { start: '2026-10-01', end: '2026-10-31' },
      anchors: [{ date: '2026-09-30', balanceMinor: 731_917, kind: 'opening' }, { date: '2026-10-31', balanceMinor: 726_011, kind: 'ledger' }],
      rows: [{ postedDate: '2026-10-12', amountMinor: -5_906, description: 'SYNTHETIC PAYMENT', checkNumber: null, bankType: 'DEBIT', externalIdHash: null }] }],
  };
  installCheckingSchema(repo.internalGetDb());
  importCheckingPayload(repo.internalGetDb(), payload, { now: NOW.toISOString(), goId: 'b'.repeat(32), purpose: 'copy-rehearsal' });
  return (repo.internalGetDb().prepare('SELECT id FROM checking_accounts').get() as { id: string }).id;
}

describe('GET /spending/balance-chains', () => {
  it('needs sign-in; the service token may read; nothing here writes', async () => {
    expect((await get('/spending/balance-chains', 'none')).status).toBe(401);
    const service = await get('/spending/balance-chains', 'service');
    expect(service.status).toBe(200);
    expect(service.headers['cache-control']).toBe('no-store');
    expect(service.headers['content-type']).toMatch(/^application\/json/);
    const post = await request(await listenLoopback(buildApp())).post('/spending/balance-chains').set('x-test-auth', 'ok').send({});
    expect(post.status).toBe(404);
    const servicePost = await request(await listenLoopback(buildApp())).post('/spending/balance-chains').set('x-test-auth', 'service').send({});
    expect(servicePost.status).toBe(403);
  });

  it('answers exactly the report the operator CLI prints, value-free', async () => {
    seedChecking();
    repo.createCardAccount({ issuer: 'chase', owner: 'alex', last4: '1234', currency: 'USD' });
    const response = await get('/spending/balance-chains');
    expect(response.status).toBe(200);
    expect(response.text).toBe(formatBalanceChainReport(readBalanceChainReport(repo.internalGetDb())));
    expect(response.body.accounts.map((account: { kind: string; state: string }) => `${account.kind}:${account.state}`))
      .toEqual(['checking:balanced', 'card:not-yet-checked']);
    expect(response.body.accounts[0].detail).toBeUndefined();
    for (const value of ['731917', '726011', '5906']) expect(response.text.includes(value), value).toBe(false);
  });

  it('answers one account with its anchors and steps; 404 for an unknown one; 400 for anything else', async () => {
    const id = seedChecking();
    const one = await get(`/spending/balance-chains?accountId=${id}`);
    expect(one.status).toBe(200);
    expect(one.body.accounts).toHaveLength(1);
    expect(one.body.accounts[0].detail.steps).toEqual([{ from: '2026-09-30', to: '2026-10-31', verdict: 'pass', reason: 'exact' }]);
    expect(one.body.accounts[0].detail.anchors.map((anchor: { kind: string }) => anchor.kind)).toEqual(['statement-opening', 'ledger']);
    expect((await get(`/spending/balance-chains?accountId=chk-acct-${'p'.repeat(32)}`)).status).toBe(404);
    expect((await get('/spending/balance-chains?accountId=1')).status).toBe(400);
    expect((await get('/spending/balance-chains?account=1')).status).toBe(400);
    expect((await get(`/spending/balance-chains?accountId=${id}&accountId=${id}`)).status).toBe(400);
    expect((await get('/spending/balance-chains?accountId=4111111111111111')).status).toBe(422);
  });

  it('reports a store in another shape as conflict, never a 409 for the whole view', async () => {
    repo.createCardAccount({ issuer: 'chase', owner: 'alex', last4: '1234', currency: 'USD' });
    repo.internalGetDb().exec('CREATE TABLE checking_balances (id TEXT PRIMARY KEY)');
    const response = await get('/spending/balance-chains');
    expect(response.status).toBe(200);
    expect(response.body.stores).toEqual({ checking: 'conflict', statementFacts: 'absent' });
  });
});
