import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createResourceRouter } from './resources.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { listenLoopback } from '../testing/loopback.js';

let dir: string;
let repo: SqliteStateRepo;
let app: express.Express;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-resources-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
  app = express();
  app.use(express.json());
  app.use(createResourceRouter(repo));
});

afterEach(async () => {
  repo.close();
  await rm(dir, { recursive: true, force: true });
});

const sampleAccount = { id: 'fid', name: 'Fidelity', type: 'Individual', cashBalance: 100, currency: 'USD' };
const sampleTx = {
  id: 't1', symbol: 'AAPL', date: '2026-05-04',
  quantity: 10, pricePerUnit: 150, currency: 'USD',
};
const optionTx = {
  id: 'option-open', symbol: 'NBIS260731P00165000', date: '2026-07-10',
  quantity: -5, pricePerUnit: 6.5632, fees: 3.4, currency: 'USD',
  instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open',
};

describe('POST /accounts', () => {
  it('creates a new account', async () => {
    const res = await request(await listenLoopback(app)).post('/accounts').send(sampleAccount);
    expect(res.status).toBe(201);
    expect(res.body).toEqual(sampleAccount);
    expect(repo.listAccounts()).toHaveLength(1);
  });

  it('rejects duplicates with 409', async () => {
    await request(await listenLoopback(app)).post('/accounts').send(sampleAccount).expect(201);
    const dup = await request(await listenLoopback(app)).post('/accounts').send(sampleAccount);
    expect(dup.status).toBe(409);
  });

  it('rejects malformed bodies with 400', async () => {
    const res = await request(await listenLoopback(app)).post('/accounts').send({ id: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name|cashBalance/);
  });
});

describe('GET /accounts', () => {
  it('returns the persisted list', async () => {
    await request(await listenLoopback(app)).post('/accounts').send(sampleAccount).expect(201);
    const res = await request(await listenLoopback(app)).get('/accounts');
    expect(res.body.accounts).toEqual([sampleAccount]);
  });
});

describe('PATCH /accounts/:id', () => {
  it('updates fields and returns the merged record', async () => {
    await request(await listenLoopback(app)).post('/accounts').send(sampleAccount).expect(201);
    const res = await request(await listenLoopback(app)).patch('/accounts/fid').send({ cashBalance: 250, name: 'Fidelity (renamed)' });
    expect(res.status).toBe(200);
    expect(res.body.cashBalance).toBe(250);
    expect(res.body.name).toBe('Fidelity (renamed)');
  });

  it('returns 404 for unknown account', async () => {
    const res = await request(await listenLoopback(app)).patch('/accounts/missing').send({ cashBalance: 1 });
    expect(res.status).toBe(404);
  });

  it('rejects empty patch', async () => {
    await request(await listenLoopback(app)).post('/accounts').send(sampleAccount).expect(201);
    const res = await request(await listenLoopback(app)).patch('/accounts/fid').send({});
    expect(res.status).toBe(400);
  });
});

describe('DELETE /accounts/:id', () => {
  it('hard-deletes empty accounts', async () => {
    await request(await listenLoopback(app)).post('/accounts').send(sampleAccount).expect(201);
    const res = await request(await listenLoopback(app)).delete('/accounts/fid');
    expect(res.status).toBe(204);
    expect(repo.listAccounts()).toHaveLength(0);
  });

  it('refuses with 409 when transactions exist', async () => {
    await request(await listenLoopback(app)).post('/accounts').send(sampleAccount).expect(201);
    await request(await listenLoopback(app)).post('/accounts/fid/transactions').send(sampleTx).expect(201);
    const res = await request(await listenLoopback(app)).delete('/accounts/fid');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/transaction/);
  });

  it('returns 404 for unknown account', async () => {
    const res = await request(await listenLoopback(app)).delete('/accounts/missing');
    expect(res.status).toBe(404);
  });

  it('refuses with 409 when broker NAV history references the account', async () => {
    await request(await listenLoopback(app)).post('/accounts').send(sampleAccount).expect(201);
    repo.insertAccountNavObservation({
      id: 'nav-1',
      accountId: sampleAccount.id,
      broker: 'schwab',
      observedAt: '2025-04-30',
      nav: 12_345.67,
      currency: 'USD',
      statementPeriodStart: '2025-04-01',
      statementPeriodEnd: '2025-04-30',
      accountLast4: '2468',
      sourceDocumentHash: 'a'.repeat(64),
      sourcePage: 1,
    });

    const res = await request(await listenLoopback(app)).delete(`/accounts/${sampleAccount.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/NAV history/i);
    expect(repo.getAccount(sampleAccount.id)).not.toBeNull();
  });
});

describe('GET /transactions', () => {
  it('returns transactions across all accounts', async () => {
    const secondAccount = { ...sampleAccount, id: 'schwab', name: 'Schwab' };
    await request(await listenLoopback(app)).post('/accounts').send(sampleAccount).expect(201);
    await request(await listenLoopback(app)).post('/accounts').send(secondAccount).expect(201);
    await request(await listenLoopback(app)).post('/accounts/fid/transactions').send(sampleTx).expect(201);
    await request(await listenLoopback(app))
      .post('/accounts/schwab/transactions')
      .send({ ...sampleTx, id: 't2', symbol: 'MSFT' })
      .expect(201);

    const res = await request(await listenLoopback(app)).get('/transactions').expect(200);
    expect(res.body.transactions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 't1', accountId: 'fid' }),
      expect.objectContaining({ id: 't2', accountId: 'schwab' }),
    ]));
    expect(res.body.transactions).toHaveLength(2);
  });
});

describe('POST /accounts/:id/transactions', () => {
  beforeEach(async () => {
    await request(await listenLoopback(app)).post('/accounts').send(sampleAccount).expect(201);
  });

  it('creates a transaction', async () => {
    const res = await request(await listenLoopback(app)).post('/accounts/fid/transactions').send(sampleTx);
    expect(res.status).toBe(201);
    expect(res.body.accountId).toBe('fid');
    expect(res.body.id).toBe('t1');
  });

  it('returns 404 for unknown account', async () => {
    const res = await request(await listenLoopback(app)).post('/accounts/missing/transactions').send(sampleTx);
    expect(res.status).toBe(404);
  });

  it('rejects bad date format', async () => {
    const res = await request(await listenLoopback(app))
      .post('/accounts/fid/transactions')
      .send({ ...sampleTx, date: '2026/05/04' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/date/);
  });

  it('rejects zero quantity', async () => {
    const res = await request(await listenLoopback(app))
      .post('/accounts/fid/transactions')
      .send({ ...sampleTx, quantity: 0 });
    expect(res.status).toBe(400);
  });

  it('rejects negative price', async () => {
    const res = await request(await listenLoopback(app))
      .post('/accounts/fid/transactions')
      .send({ ...sampleTx, pricePerUnit: -1 });
    expect(res.status).toBe(400);
  });

  it('rejects negative fees', async () => {
    const res = await request(await listenLoopback(app))
      .post('/accounts/fid/transactions')
      .send({ ...sampleTx, id: 'negative-fee', fees: -0.25 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/fees.*non-negative/);
  });

  it('normalizes symbol to uppercase + trims whitespace', async () => {
    const res = await request(await listenLoopback(app))
      .post('/accounts/fid/transactions')
      .send({ ...sampleTx, id: 'norm', symbol: '  aapl  ' });
    expect(res.status).toBe(201);
    expect(res.body.symbol).toBe('AAPL');
  });

  it('normalizes currency to uppercase', async () => {
    const res = await request(await listenLoopback(app))
      .post('/accounts/fid/transactions')
      .send({ ...sampleTx, id: 'cur', currency: 'usd' });
    expect(res.status).toBe(201);
    expect(res.body.currency).toBe('USD');
  });

  it('round-trips sourceFingerprint when provided', async () => {
    const res = await request(await listenLoopback(app))
      .post('/accounts/fid/transactions')
      .send({ ...sampleTx, id: 'fp1', sourceFingerprint: 'fid-tsla-buy-2026-05-04' });
    expect(res.status).toBe(201);
    expect(res.body.sourceFingerprint).toBe('fid-tsla-buy-2026-05-04');
  });

  it('omits sourceFingerprint when not provided (legacy/manual entries)', async () => {
    const res = await request(await listenLoopback(app))
      .post('/accounts/fid/transactions')
      .send({ ...sampleTx, id: 'no-fp' });
    expect(res.status).toBe(201);
    expect(res.body.sourceFingerprint).toBeUndefined();
  });

  it('rejects non-string sourceFingerprint', async () => {
    const res = await request(await listenLoopback(app))
      .post('/accounts/fid/transactions')
      .send({ ...sampleTx, id: 'bad-fp', sourceFingerprint: 42 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sourceFingerprint/);
  });

  it('treats empty-string sourceFingerprint as unset (returns no value)', async () => {
    const res = await request(await listenLoopback(app))
      .post('/accounts/fid/transactions')
      .send({ ...sampleTx, id: 'blank-fp', sourceFingerprint: '   ' });
    expect(res.status).toBe(201);
    expect(res.body.sourceFingerprint).toBeUndefined();
  });

  it('round-trips a valid option and rejects incomplete option metadata', async () => {
    const created = await request(await listenLoopback(app))
      .post('/accounts/fid/transactions')
      .send(optionTx)
      .expect(201);
    expect(created.body).toMatchObject(optionTx);

    await request(await listenLoopback(app))
      .post('/accounts/fid/transactions')
      .send({ ...optionTx, id: 'missing-effect', positionEffect: undefined })
      .expect(400);
    await request(await listenLoopback(app))
      .post('/accounts/fid/transactions')
      .send({ ...optionTx, id: 'bad-occ', symbol: 'NBIS' })
      .expect(400);
    await request(await listenLoopback(app))
      .post('/accounts/fid/transactions')
      .send({ ...optionTx, id: 'fractional', quantity: -0.5 })
      .expect(400);
  });

  it('rejects an option over-close before writing it', async () => {
    await request(await listenLoopback(app)).post('/accounts/fid/transactions').send(optionTx).expect(201);
    const response = await request(await listenLoopback(app))
      .post('/accounts/fid/transactions')
      .send({
        ...optionTx,
        id: 'over-close',
        quantity: 6,
        pricePerUnit: 4,
        positionEffect: 'close',
      });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/exceeds/);
    expect(repo.listTransactions('fid')).toHaveLength(1);
  });
});

describe('GET /accounts/:id/transactions', () => {
  it('returns scoped transactions only', async () => {
    await request(await listenLoopback(app)).post('/accounts').send(sampleAccount).expect(201);
    await request(await listenLoopback(app)).post('/accounts').send({ ...sampleAccount, id: 'citi', name: 'Citi' }).expect(201);
    await request(await listenLoopback(app)).post('/accounts/fid/transactions').send(sampleTx).expect(201);
    await request(await listenLoopback(app)).post('/accounts/citi/transactions').send({ ...sampleTx, id: 't2', symbol: 'MSFT' }).expect(201);

    const fid = await request(await listenLoopback(app)).get('/accounts/fid/transactions');
    expect(fid.body.transactions.map((t: { id: string }) => t.id)).toEqual(['t1']);
    const citi = await request(await listenLoopback(app)).get('/accounts/citi/transactions');
    expect(citi.body.transactions.map((t: { id: string }) => t.id)).toEqual(['t2']);
  });
});

describe('DELETE /transactions/:id', () => {
  it('deletes and returns 204', async () => {
    await request(await listenLoopback(app)).post('/accounts').send(sampleAccount).expect(201);
    await request(await listenLoopback(app)).post('/accounts/fid/transactions').send(sampleTx).expect(201);
    const del = await request(await listenLoopback(app)).delete('/transactions/t1');
    expect(del.status).toBe(204);
  });

  it('returns 404 for unknown id', async () => {
    const res = await request(await listenLoopback(app)).delete('/transactions/nope');
    expect(res.status).toBe(404);
  });

  it('rejects deleting an option opening fill when it would orphan a close', async () => {
    await request(await listenLoopback(app)).post('/accounts').send(sampleAccount).expect(201);
    await request(await listenLoopback(app)).post('/accounts/fid/transactions').send(optionTx).expect(201);
    await request(await listenLoopback(app))
      .post('/accounts/fid/transactions')
      .send({
        ...optionTx,
        id: 'option-close',
        quantity: 2,
        pricePerUnit: 4,
        positionEffect: 'close',
      })
      .expect(201);

    const response = await request(await listenLoopback(app)).delete('/transactions/option-open');
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/no open position/);
    expect(repo.listTransactions('fid')).toHaveLength(2);
  });
});

describe('PATCH /transactions/:id', () => {
  beforeEach(async () => {
    await request(await listenLoopback(app)).post('/accounts').send(sampleAccount).expect(201);
    await request(await listenLoopback(app)).post('/accounts/fid/transactions').send(sampleTx).expect(201);
  });

  it('updates editable fields and returns the merged transaction', async () => {
    const res = await request(await listenLoopback(app))
      .patch('/transactions/t1')
      .send({ quantity: 12, pricePerUnit: 151.25, fees: 1.5, notes: 'corrected lot' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 't1',
      accountId: 'fid',
      symbol: 'AAPL',
      date: '2026-05-04',
      quantity: 12,
      pricePerUnit: 151.25,
      fees: 1.5,
      notes: 'corrected lot',
    });
    expect(repo.listTransactions('fid')[0]).toMatchObject({ quantity: 12, pricePerUnit: 151.25 });
  });

  it('returns 404 for an unknown transaction', async () => {
    const res = await request(await listenLoopback(app)).patch('/transactions/missing').send({ pricePerUnit: 1 });
    expect(res.status).toBe(404);
  });

  it('rejects empty and invalid patches', async () => {
    await request(await listenLoopback(app)).patch('/transactions/t1').send({}).expect(400);
    await request(await listenLoopback(app)).patch('/transactions/t1').send({ quantity: 0 }).expect(400);
    await request(await listenLoopback(app)).patch('/transactions/t1').send({ pricePerUnit: -1 }).expect(400);
  });

  it('rejects patching an option to a fractional contract count', async () => {
    await request(await listenLoopback(app)).post('/accounts/fid/transactions').send(optionTx).expect(201);
    const response = await request(await listenLoopback(app))
      .patch('/transactions/option-open')
      .send({ quantity: -4.5 });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/integer contract count/);
    expect(repo.listTransactions('fid').find((transaction) => transaction.id === 'option-open')?.quantity).toBe(-5);
  });
});

describe('GET /transactions/:id/cost-basis-check', () => {
  beforeEach(async () => {
    await request(await listenLoopback(app)).post('/accounts').send(sampleAccount).expect(201);
    await request(await listenLoopback(app)).post('/accounts/fid/transactions').send(sampleTx).expect(201);
  });

  it('returns deviation against the nearest cached daily close', async () => {
    repo.internalGetDb()
      .prepare(
        `INSERT INTO symbol_price_bars (symbol, range_kind, t, close, source)
         VALUES (?, 'daily', ?, ?, 'test')`,
      )
      .run('AAPL', '2026-05-04', 100);
    const res = await request(await listenLoopback(app)).get('/transactions/t1/cost-basis-check');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      transactionId: 't1',
      symbol: 'AAPL',
      historicalPrice: 100,
      historicalDate: '2026-05-04',
      warningLevel: 'major',
    });
    expect(res.body.deviationPercent).toBeCloseTo(50);
  });

  it('returns unknown when no cached historical price exists', async () => {
    const res = await request(await listenLoopback(app)).get('/transactions/t1/cost-basis-check');
    expect(res.status).toBe(200);
    expect(res.body.warningLevel).toBe('unknown');
    expect(res.body.historicalPrice).toBeNull();
  });

  it('returns 404 for unknown transaction', async () => {
    await request(await listenLoopback(app)).get('/transactions/missing/cost-basis-check').expect(404);
  });
});

describe('GET /export', () => {
  it('returns the full DB contents with schema version', async () => {
    await request(await listenLoopback(app)).post('/accounts').send(sampleAccount).expect(201);
    await request(await listenLoopback(app)).post('/accounts/fid/transactions').send(sampleTx).expect(201);
    const res = await request(await listenLoopback(app)).get('/export');
    expect(res.status).toBe(200);
    expect(res.body.schemaVersion).toBe(15);
    expect(typeof res.body.exportedAt).toBe('string');
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.transactions[0].id).toBe('t1');
    expect(res.body.cashEvents).toEqual([]);
    expect(res.body.cashHistory).toEqual([]);
  });

  it('returns empty arrays on empty DB', async () => {
    const res = await request(await listenLoopback(app)).get('/export');
    expect(res.body.accounts).toEqual([]);
    expect(res.body.transactions).toEqual([]);
    expect(res.body.cashEvents).toEqual([]);
  });
});
