import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createCashEventsRouter } from './cashEvents.js';
import { computeCashEventFingerprint, type CashEventCandidate } from '../services/cashEvents.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { listenLoopback } from '../testing/loopback.js';

let dir: string;
let repo: SqliteStateRepo;
let app: express.Express;

const candidate: CashEventCandidate = {
  date: '2026-05-07',
  eventType: 'dividend',
  amount: 12.34,
  accountLast4: '2468',
  description: 'DIVIDEND RECEIVED SYNTHETIC FUND (TEST) (Cash)',
};
const event = {
  ...candidate,
  currency: 'USD',
  broker: 'fidelity',
  sourceOccurrence: 0,
  sourceFingerprint: computeCashEventFingerprint('fidelity', candidate, 0),
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-cash-events-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
  repo.createAccount({
    id: 'fid',
    name: 'Fidelity',
    cashBalance: 0,
    currency: 'USD',
    accountNumber: 'XXXX-2468',
  });
  repo.createAccount({
    id: 'other',
    name: 'Other',
    cashBalance: 0,
    currency: 'USD',
    accountNumber: 'XXXX-1357',
  });
  repo.createAccount({
    id: 'unnumbered',
    name: 'Unnumbered',
    cashBalance: 0,
    currency: 'USD',
  });
  app = express();
  app.use(express.json());
  app.use(createCashEventsRouter(repo));
});

afterEach(async () => {
  repo.close();
  await rm(dir, { recursive: true, force: true });
});

describe('POST /accounts/:id/cash-events', () => {
  it('creates once and treats a fingerprint retry as idempotent', async () => {
    const first = await request(await listenLoopback(app))
      .post('/accounts/fid/cash-events')
      .set('X-Confirm-Account-Last4', '2468')
      .send(event)
      .expect(201);
    expect(first.body.inserted).toBe(true);
    const { sourceOccurrence: _sourceOccurrence, ...storedEvent } = event;
    expect(first.body.event).toMatchObject({ ...storedEvent, accountId: 'fid' });

    const retry = await request(await listenLoopback(app))
      .post('/accounts/fid/cash-events')
      .set('X-Confirm-Account-Last4', '2468')
      .send(event)
      .expect(200);
    expect(retry.body.inserted).toBe(false);
    expect(retry.body.event.description).toBe(event.description);
    expect(repo.listCashEvents('fid')).toHaveLength(1);
  });

  it('requires confirmation and refuses an account-number mismatch', async () => {
    const missing = await request(await listenLoopback(app))
      .post('/accounts/fid/cash-events')
      .send(event)
      .expect(400);
    expect(missing.body.error).toMatch(/Confirm-Account-Last4/i);

    const mismatch = await request(await listenLoopback(app))
      .post('/accounts/other/cash-events')
      .set('X-Confirm-Account-Last4', '2468')
      .send(event)
      .expect(409);
    expect(mismatch.body.error).toMatch(/does not match/i);
  });

  it('requires a configured account number and matching account currency', async () => {
    const unnumbered = await request(await listenLoopback(app))
      .post('/accounts/unnumbered/cash-events')
      .set('X-Confirm-Account-Last4', '2468')
      .send(event)
      .expect(409);
    expect(unnumbered.body.error).toMatch(/account number/i);

    const currencyMismatch = await request(await listenLoopback(app))
      .post('/accounts/fid/cash-events')
      .set('X-Confirm-Account-Last4', '2468')
      .send({ ...event, currency: 'EUR' })
      .expect(409);
    expect(currencyMismatch.body.error).toMatch(/currency/i);
  });

  it('returns 404 for an unknown account and 400 for malformed provenance', async () => {
    await request(await listenLoopback(app))
      .post('/accounts/missing/cash-events')
      .set('X-Confirm-Account-Last4', '2468')
      .send(event)
      .expect(404);

    const zeroCandidate = { ...candidate, amount: 0 };
    const invalid = await request(await listenLoopback(app))
      .post('/accounts/fid/cash-events')
      .set('X-Confirm-Account-Last4', '2468')
      .send({
        ...event,
        amount: 0,
        sourceFingerprint: computeCashEventFingerprint('fidelity', zeroCandidate, 0),
      })
      .expect(400);
    expect(invalid.body.error).toMatch(/amount/i);
  });

  it('rejects fields that do not reproduce the preview fingerprint', async () => {
    const response = await request(await listenLoopback(app))
      .post('/accounts/fid/cash-events')
      .set('X-Confirm-Account-Last4', '2468')
      .send({ ...event, amount: 999 })
      .expect(400);
    expect(response.body.error).toMatch(/fingerprint.*does not match/i);
    expect(repo.listCashEvents('fid')).toEqual([]);
  });
});

describe('GET/DELETE cash events', () => {
  it('lists an inclusive account/date range and deletes by id', async () => {
    const created = await request(await listenLoopback(app))
      .post('/accounts/fid/cash-events')
      .set('X-Confirm-Account-Last4', '2468')
      .send(event)
      .expect(201);

    const listed = await request(await listenLoopback(app))
      .get('/accounts/fid/cash-events?from=2026-05-01&to=2026-05-07')
      .expect(200);
    expect(listed.body.cashEvents).toHaveLength(1);

    await request(await listenLoopback(app)).delete(`/cash-events/${created.body.event.id}`).expect(204);
    await request(await listenLoopback(app)).delete(`/cash-events/${created.body.event.id}`).expect(404);
  });

  it('rejects impossible or reversed date filters', async () => {
    await request(await listenLoopback(app)).get('/accounts/fid/cash-events?from=2026-02-30').expect(400);
    await request(await listenLoopback(app)).get('/accounts/fid/cash-events?from=2026-06-01&to=2026-05-01').expect(400);
  });

  it('lists cash events across accounts in one request', async () => {
    await request(await listenLoopback(app))
      .post('/accounts/fid/cash-events')
      .set('X-Confirm-Account-Last4', '2468')
      .send(event)
      .expect(201);
    const otherCandidate = { ...candidate, accountLast4: '1357', amount: -25, eventType: 'transfer' as const };
    await request(await listenLoopback(app))
      .post('/accounts/other/cash-events')
      .set('X-Confirm-Account-Last4', '1357')
      .send({
        ...otherCandidate,
        currency: 'USD',
        broker: 'fidelity',
        sourceOccurrence: 0,
        sourceFingerprint: computeCashEventFingerprint('fidelity', otherCandidate, 0),
      })
      .expect(201);

    const response = await request(await listenLoopback(app)).get('/cash-events').expect(200);
    expect(response.body.cashEvents).toHaveLength(2);
    expect(response.body.cashEvents.map((item: { accountId: string }) => item.accountId).sort())
      .toEqual(['fid', 'other']);
  });
});

describe('/accounts/:id/cash-history', () => {
  const history = {
    currency: 'USD',
    broker: 'fidelity',
    accountLast4: '2468',
    sourceHash: 'a'.repeat(64),
    method: 'fidelity-activity-eod-v1',
    rows: [
      { date: '2026-05-06', cashBalance: 100 },
      { date: '2026-05-07', cashBalance: 112.34 },
    ],
  };

  it('imports once, treats an identical retry as a no-op, and lists rows', async () => {
    const first = await request(await listenLoopback(app))
      .post('/accounts/fid/cash-history')
      .set('X-Confirm-Account-Last4', '2468')
      .send(history)
      .expect(201);
    expect(first.body).toEqual({ inserted: 2, unchanged: 0, conflicts: [] });

    const retry = await request(await listenLoopback(app))
      .post('/accounts/fid/cash-history')
      .set('X-Confirm-Account-Last4', '2468')
      .send(history)
      .expect(200);
    expect(retry.body).toEqual({ inserted: 0, unchanged: 2, conflicts: [] });

    const listed = await request(await listenLoopback(app)).get('/accounts/fid/cash-history').expect(200);
    expect(listed.body.cashHistory.map((row: { date: string; cashBalance: number }) => [row.date, row.cashBalance]))
      .toEqual([['2026-05-06', 100], ['2026-05-07', 112.34]]);
  });

  it('rejects a changed balance with 409 and stores nothing from that request', async () => {
    await request(await listenLoopback(app))
      .post('/accounts/fid/cash-history')
      .set('X-Confirm-Account-Last4', '2468')
      .send(history)
      .expect(201);
    const conflict = await request(await listenLoopback(app))
      .post('/accounts/fid/cash-history')
      .set('X-Confirm-Account-Last4', '2468')
      .send({ ...history, rows: [{ date: '2026-05-05', cashBalance: 1 }, { date: '2026-05-07', cashBalance: 999 }] })
      .expect(409);
    expect(conflict.body.conflicts).toEqual([{ date: '2026-05-07', existing: 112.34, incoming: 999 }]);
    const listed = await request(await listenLoopback(app)).get('/accounts/fid/cash-history').expect(200);
    expect(listed.body.cashHistory).toHaveLength(2);
  });

  it('requires the confirmed last four to match the account and payload', async () => {
    await request(await listenLoopback(app)).post('/accounts/fid/cash-history').send(history).expect(400);
    await request(await listenLoopback(app))
      .post('/accounts/fid/cash-history')
      .set('X-Confirm-Account-Last4', '1357')
      .send({ ...history, accountLast4: '1357' })
      .expect(409);
    await request(await listenLoopback(app))
      .post('/accounts/fid/cash-history')
      .set('X-Confirm-Account-Last4', '2468')
      .send({ ...history, accountLast4: '1357' })
      .expect(400);
    await request(await listenLoopback(app))
      .post('/accounts/unnumbered/cash-history')
      .set('X-Confirm-Account-Last4', '2468')
      .send(history)
      .expect(409);
    await request(await listenLoopback(app))
      .post('/accounts/fid/cash-history')
      .set('X-Confirm-Account-Last4', '2468')
      .send({ ...history, currency: 'EUR' })
      .expect(409);
    await request(await listenLoopback(app))
      .post('/accounts/missing/cash-history')
      .set('X-Confirm-Account-Last4', '2468')
      .send(history)
      .expect(404);
  });

  it('rejects malformed rows with 400', async () => {
    await request(await listenLoopback(app))
      .post('/accounts/fid/cash-history')
      .set('X-Confirm-Account-Last4', '2468')
      .send({ ...history, rows: [{ date: '2026-02-30', cashBalance: 1 }] })
      .expect(400);
    await request(await listenLoopback(app))
      .post('/accounts/fid/cash-history')
      .set('X-Confirm-Account-Last4', '2468')
      .send({ ...history, rows: 'nope' })
      .expect(400);
  });

  it('deletes an account history only with the confirmed last four', async () => {
    await request(await listenLoopback(app))
      .post('/accounts/fid/cash-history')
      .set('X-Confirm-Account-Last4', '2468')
      .send(history)
      .expect(201);
    await request(await listenLoopback(app)).delete('/accounts/fid/cash-history').expect(400);
    await request(await listenLoopback(app)).delete('/accounts/fid/cash-history').set('X-Confirm-Account-Last4', '1357').expect(409);
    const deleted = await request(await listenLoopback(app))
      .delete('/accounts/fid/cash-history')
      .set('X-Confirm-Account-Last4', '2468')
      .expect(200);
    expect(deleted.body).toEqual({ deleted: 2 });
  });
});