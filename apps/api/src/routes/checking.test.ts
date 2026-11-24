import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { Express } from 'express';

import type { CheckingImportPayload } from '@finance-tracker/shared';

import { createApp } from '../app.js';
import { hashPassword } from '../auth/password.js';
import { importCheckingPayload } from '../services/checking/importer.js';
import { checkingSchemaState, installCheckingSchema } from '../services/checking/schema.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { listenLoopback } from '../testing/loopback.js';

// Synthetic only: a made-up account, rows and service token.
const ORIGIN = 'http://127.0.0.1:5173', TOKEN = '9b'.repeat(32), FAST = { ln: 10, r: 8, p: 1 };
const PAYLOAD: CheckingImportPayload = {
  format: 'holdr.checking-import', version: 1, parserVersion: 'holdr-checking-import@1.0.0',
  account: { institution: 'wellsfargo', type: 'checking', last4: '2931', label: 'Wells Fargo Everyday Checking', currency: 'USD' },
  segments: [{
    source: 'ofx', coverage: { start: '2026-10-01', end: '2026-10-20' }, anchors: [],
    rows: [
      { postedDate: '2026-10-02', amountMinor: -25000, description: 'AMEX EPAYMENT ACH PMT 261002 W1234 SYNTH', checkNumber: null, bankType: 'DEBIT', externalIdHash: null },
      { postedDate: '2026-10-05', amountMinor: 300000, description: 'SYNTHETIC PAYROLL', checkNumber: null, bankType: 'CREDIT', externalIdHash: null },
      { postedDate: '2026-10-15', amountMinor: -12000, description: 'CHECK', checkNumber: '1001', bankType: 'CHECK', externalIdHash: null },
    ],
  }],
};

let repo: SqliteStateRepo, app: Express, dir: string, cookie: string, logs: string[];
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checking-api-synthetic-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
  logs = [];
  const built = createApp({ repo, serviceToken: TOKEN, allowedOrigins: [ORIGIN], snapshotsEnabled: false, scryptParams: FAST, log: (line) => logs.push(line) });
  app = built.app;
  built.users.createUser('alex', await hashPassword('synthetic password', FAST));
  const login = await request(await listenLoopback(app)).post('/auth/login').set('Origin', ORIGIN)
    .set('X-Holdr-Request', '1').send({ username: 'alex', password: 'synthetic password' });
  expect(login.status).toBe(200);
  cookie = (login.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('holdr_session='))!.split(';')[0];
});
afterEach(() => {
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const owner = (req: request.Test) => req.set('Cookie', cookie).set('Origin', ORIGIN).set('X-Holdr-Request', '1');
const get = async (url: string) => owner(request(await listenLoopback(app)).get(url));
const imported = () => {
  installCheckingSchema(repo.internalGetDb());
  importCheckingPayload(repo.internalGetDb(), PAYLOAD, { now: '2026-10-22T01:00:00.000Z', goId: 'c'.repeat(32), purpose: 'copy-rehearsal' });
};

describe('checking read API through the actual guarded mount', () => {
  it('needs sign-in, serves no write, and creates nothing when the tables are absent', async () => {
    expect((await request(await listenLoopback(app)).get('/checking/accounts')).status).toBe(401);
    expect((await owner(request(await listenLoopback(app)).post('/checking/imports')).set('Content-Type', 'application/json').send('{}')).status).toBe(404);
    const accounts = await get('/checking/accounts');
    expect(accounts.status).toBe(200);
    expect(accounts.body).toEqual({ installed: false, accounts: [], coverage: [] });
    const rows = await get('/checking/transactions?from=2026-01-01&to=2026-12-31');
    expect(rows.body).toEqual({ installed: false, total: 0, transactions: [] });
    expect(checkingSchemaState(repo.internalGetDb())).toBe('absent');
  });

  it('lists accounts, coverage and posted rows, filtered and paged; the service token may read', async () => {
    imported();
    const accounts = await get('/checking/accounts');
    const [account] = accounts.body.accounts;
    expect(accounts.body).toEqual({ installed: true, accounts: [{ id: account.id, institution: 'wellsfargo', label: 'Wells Fargo Everyday Checking',
      last4: '2931', currency: 'USD', status: 'active' }], coverage: [{ checkingAccountId: account.id, ranges: [{ start: '2026-10-01', end: '2026-10-20' }] }] });
    const page = await get(`/checking/transactions?from=2026-10-01&to=2026-10-31&accountId=${account.id}&limit=2&offset=1`);
    expect(page.body.total).toBe(3);
    expect(page.body.transactions.map((row: { date: string; amountMinor: number; checkNumber: string | null }) => [row.date, row.amountMinor, row.checkNumber]))
      .toEqual([['2026-10-05', 300000, null], ['2026-10-15', -12000, '1001']]);
    const service = await request(await listenLoopback(app)).get('/checking/accounts').set('Authorization', `Bearer ${TOKEN}`);
    expect(service.status).toBe(200);
    const other = await get(`/checking/transactions?from=2026-10-01&to=2026-10-31&accountId=chk-acct-${'a'.repeat(32)}`);
    expect(other.body).toEqual({ installed: true, total: 0, transactions: [] });
  });

  it('refuses malformed queries without echoing them', async () => {
    for (const query of ['', 'from=2026-10-01', 'from=2026-13-01&to=2026-12-31', 'from=2026-10-02&to=2026-10-01', 'from=2010-01-01&to=2026-12-31',
      'from=2026-01-01&to=2026-12-31&limit=0', 'from=2026-01-01&to=2026-12-31&limit=501', 'from=2026-01-01&to=2026-12-31&accountId=secret',
      'from=2026-01-01&to=2026-12-31&extra=secret']) {
      const res = await get(`/checking/transactions?${query}`);
      expect(res.status).toBe(400);
      expect(res.text).not.toContain('secret');
    }
    const card = await get('/checking/transactions?from=2026-01-01&to=2026-12-31&accountId=4111111111111111');
    expect(card.status).toBe(422);
    expect(card.text).not.toContain('4111');
  });
});

describe('checking import boundary', () => {
  it('keeps raw bank files out of the API: only the offline converter CLI reads them, and nothing in the API imports it', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const parsers: string[] = [];
    const converterImporters: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        if (fs.statSync(file).isDirectory()) walk(file);
        else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
          const text = fs.readFileSync(file, 'utf8');
          if (/checking-import-tool|checkingImportTool|pdfjs-dist/.test(text)) parsers.push(name);
          if (/\.\/checkingConvert\.js|\/cli\/checkingConvert/.test(text)) converterImporters.push(name);
        }
      }
    };
    walk(root);
    expect(parsers.sort()).toEqual(['checkingConvert.ts', 'checkingPdfText.ts']);
    expect(converterImporters).toEqual(['checkingConvertMain.ts']);
  });
});
