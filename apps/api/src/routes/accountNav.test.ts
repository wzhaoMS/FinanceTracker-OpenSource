import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createAccountNavRouter } from './accountNav.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { listenLoopback } from '../testing/loopback.js';

const STATEMENT_TEXT = `
Charles Schwab & Co. Inc.
Statement Period
April 1-30, 2025ACCOUNT HOLDER
Account Number
XXXX-2468
Account Summary
Ending Account Value as of 04/30 Beginning Account Value as of 04/01
$12,345.67 $10,000.00
`;
const PDF = Buffer.from('%PDF-1.7 fake test bytes');
const OTHER_PDF = Buffer.from('%PDF-1.7 different fake test bytes');

let dir: string;
let repo: SqliteStateRepo;
let app: express.Express;
let now: number;

async function previewToken(): Promise<string> {
  const response = await request(await listenLoopback(app))
    .post('/import/nav-statement/preview')
    .set('Content-Type', 'application/pdf')
    .send(PDF)
    .expect(200);
  return response.body.previewToken as string;
}

beforeEach(async () => {
  now = Date.UTC(2026, 6, 10, 12);
  dir = await mkdtemp(path.join(tmpdir(), 'ft-account-nav-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
  repo.createAccount({
    id: 'schwab-hsa',
    name: 'Schwab HSA',
    cashBalance: 0,
    currency: 'USD',
    accountNumber: 'XXXX-2468',
  });
  repo.createAccount({
    id: 'schwab-roth',
    name: 'Schwab Roth',
    cashBalance: 0,
    currency: 'USD',
    accountNumber: 'XXXX-1234',
  });
  app = express();
  app.use(createAccountNavRouter({
    state: repo,
    extractFirstPageText: async () => STATEMENT_TEXT,
    previewSecret: 'deterministic-test-secret',
    now: () => now,
  }));
});

afterEach(async () => {
  repo.close();
  await rm(dir, { recursive: true, force: true });
});

describe('POST /import/nav-statement/preview', () => {
  it('parses PDF bytes, returns provenance and account matches, and does not write', async () => {
    const response = await request(await listenLoopback(app))
      .post('/import/nav-statement/preview')
      .set('Content-Type', 'application/pdf')
      .set('X-File-Name', 'Brokerage Statement.pdf')
      .send(PDF)
      .expect(200);

    expect(response.body.statement).toMatchObject({
      broker: 'schwab',
      observedAt: '2025-04-30',
      nav: 12_345.67,
      accountLast4: '2468',
    });
    expect(response.body.source).toMatchObject({ fileName: 'Brokerage Statement.pdf', page: 1 });
    expect(response.body.source.documentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(response.body.previewToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(response.body.accountMatches).toEqual([
      expect.objectContaining({ id: 'schwab-hsa', name: 'Schwab HSA' }),
    ]);
    expect(response.body.requiresExplicitAccountSelection).toBe(true);
    expect(repo.listAccountNavHistory('schwab-hsa')).toEqual([]);
  });

  it('rejects a second concurrent PDF parse instead of stacking CPU-heavy work', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let releaseParse!: () => void;
    const parseGate = new Promise<void>((resolve) => { releaseParse = resolve; });
    const slowApp = express();
    slowApp.use(createAccountNavRouter({
      state: repo,
      previewSecret: 'concurrency-test-secret',
      now: () => now,
      extractFirstPageText: async () => {
        markStarted();
        await parseGate;
        return STATEMENT_TEXT;
      },
    }));

    const firstRequest = request(await listenLoopback(slowApp))
      .post('/import/nav-statement/preview')
      .set('Content-Type', 'application/pdf')
      .send(PDF)
      .then((response) => response);
    await started;
    try {
      const concurrent = await request(await listenLoopback(slowApp))
        .post('/import/nav-statement/preview')
        .set('Content-Type', 'application/pdf')
        .send(OTHER_PDF)
        .expect(429);
      expect(concurrent.body.error).toMatch(/already being parsed/i);
    } finally {
      releaseParse();
    }
    expect((await firstRequest).status).toBe(200);
  });
});

describe('POST /accounts/:id/nav-history/import', () => {
  it('requires a signed preview token', async () => {
    const response = await request(await listenLoopback(app))
      .post('/accounts/schwab-hsa/nav-history/import')
      .set('Content-Type', 'application/pdf')
      .set('X-Confirm-Account-Last4', '2468')
      .send(PDF)
      .expect(400);
    expect(response.body.error).toMatch(/preview.*token/i);
  });

  it('requires explicit confirmation of the statement account last four', async () => {
    const token = await previewToken();
    const response = await request(await listenLoopback(app))
      .post('/accounts/schwab-hsa/nav-history/import')
      .set('Content-Type', 'application/pdf')
      .set('X-NAV-Preview-Token', token)
      .send(PDF)
      .expect(400);
    expect(response.body.error).toMatch(/X-Confirm-Account-Last4/i);
  });

  it('rejects a configured account whose last four conflicts with the PDF', async () => {
    const token = await previewToken();
    const response = await request(await listenLoopback(app))
      .post('/accounts/schwab-roth/nav-history/import')
      .set('Content-Type', 'application/pdf')
      .set('X-NAV-Preview-Token', token)
      .set('X-Confirm-Account-Last4', '2468')
      .send(PDF)
      .expect(409);
    expect(response.body.error).toMatch(/does not match/i);
  });

  it('rejects PDF bytes that differ from the previewed document', async () => {
    const token = await previewToken();
    const response = await request(await listenLoopback(app))
      .post('/accounts/schwab-hsa/nav-history/import')
      .set('Content-Type', 'application/pdf')
      .set('X-NAV-Preview-Token', token)
      .set('X-Confirm-Account-Last4', '2468')
      .send(OTHER_PDF)
      .expect(409);
    expect(response.body.error).toMatch(/does not match preview/i);
    expect(repo.listAccountNavHistory('schwab-hsa')).toEqual([]);
  });

  it('rejects an expired preview token', async () => {
    const token = await previewToken();
    now += 16 * 60 * 1000;
    const response = await request(await listenLoopback(app))
      .post('/accounts/schwab-hsa/nav-history/import')
      .set('Content-Type', 'application/pdf')
      .set('X-NAV-Preview-Token', token)
      .set('X-Confirm-Account-Last4', '2468')
      .send(PDF)
      .expect(409);
    expect(response.body.error).toMatch(/expired/i);
    expect(repo.listAccountNavHistory('schwab-hsa')).toEqual([]);
  });

  it('commits once and treats a retry of the same PDF as idempotent', async () => {
    const token = await previewToken();
    const first = await request(await listenLoopback(app))
      .post('/accounts/schwab-hsa/nav-history/import')
      .set('Content-Type', 'application/pdf')
      .set('X-NAV-Preview-Token', token)
      .set('X-Confirm-Account-Last4', '2468')
      .set('X-File-Name', '../statement.pdf')
      .send(PDF)
      .expect(201);
    expect(first.body.inserted).toBe(true);
    expect(first.body.observation).toMatchObject({
      accountId: 'schwab-hsa',
      observedAt: '2025-04-30',
      nav: 12_345.67,
      sourceFileName: 'statement.pdf',
    });

    const retry = await request(await listenLoopback(app))
      .post('/accounts/schwab-hsa/nav-history/import')
      .set('Content-Type', 'application/pdf')
      .set('X-NAV-Preview-Token', token)
      .set('X-Confirm-Account-Last4', '2468')
      .send(PDF)
      .expect(200);
    expect(retry.body.inserted).toBe(false);
    expect(repo.listAccountNavHistory('schwab-hsa')).toHaveLength(1);
  });
});

describe('GET /accounts/:id/nav-history', () => {
  it('returns persisted observations with inclusive date filters', async () => {
    const token = await previewToken();
    await request(await listenLoopback(app))
      .post('/accounts/schwab-hsa/nav-history/import')
      .set('Content-Type', 'application/pdf')
      .set('X-NAV-Preview-Token', token)
      .set('X-Confirm-Account-Last4', '2468')
      .send(PDF)
      .expect(201);

    const response = await request(await listenLoopback(app))
      .get('/accounts/schwab-hsa/nav-history?from=2025-04-01&to=2025-04-30')
      .expect(200);
    expect(response.body.navHistory).toHaveLength(1);
  });

  it('rejects impossible calendar dates', async () => {
    const response = await request(await listenLoopback(app))
      .get('/accounts/schwab-hsa/nav-history?from=2025-02-30')
      .expect(400);
    expect(response.body.error).toMatch(/YYYY-MM-DD/);
  });
});