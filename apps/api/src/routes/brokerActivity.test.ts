import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Account, Transaction } from '@finance-tracker/shared';

import { createActivityImportRouter } from './brokerActivity.js';
import { listenLoopback } from '../testing/loopback.js';

/**
 * Build an app with the activity router mounted under /import. The state
 * stub is the only repo surface this route touches, so it's all the test
 * needs to fake.
 */
function makeApp(
  fetchImpl: typeof fetch,
  accounts: Account[] = [],
  existingByFingerprint: Record<string, { accountId: string; existingId: string }> = {},
  existingCashByFingerprint: Record<string, { accountId: string; existingId: string }> = {},
  existingTransactions: Transaction[] = [],
) {
  const app = express();
  app.use(express.json());
  app.use(
    '/import',
    createActivityImportRouter({
      bridgeUrl: 'http://bridge.test',
      fetchImpl,
      state: {
        listAccounts: () => accounts,
        findTransactionByFingerprint: (accountId, fp) => {
          if (!fp) return null;
          const hit = existingByFingerprint[fp];
          if (!hit || hit.accountId !== accountId) return null;
          return { id: hit.existingId };
        },
        findCashEventByFingerprint: (accountId, fp) => {
          if (!fp) return null;
          const hit = existingCashByFingerprint[fp];
          if (!hit || hit.accountId !== accountId) return null;
          return { id: hit.existingId };
        },
        listTransactions: (accountId) => existingTransactions.filter(
          (transaction) => accountId == null || transaction.accountId === accountId,
        ),
      },
    }),
  );
  return app;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const accounts: Account[] = [
  { id: 'fid-tod', name: 'Alex · Fidelity Individual TOD', accountNumber: 'Z85325841', cashBalance: 0, currency: 'USD' },
  { id: 'fid-roth', name: 'Alex · Fidelity Roth IRA', accountNumber: '191596741', cashBalance: 0, currency: 'USD' },
  { id: 'fid-401k', name: 'Alex · Fidelity BrokerageLink (401k)', accountNumber: '868782943', cashBalance: 0, currency: 'USD' },
  { id: 'fid-hsa', name: 'Alex · Fidelity HSA', accountNumber: '413382685', cashBalance: 0, currency: 'USD' },
];

describe('POST /import/activity-from-broker', () => {
  it('400s when broker is missing', async () => {
    const app = makeApp(async () => jsonResponse(200, { rows: [] }));
    const res = await request(await listenLoopback(app)).post('/import/activity-from-broker').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/broker/);
  });

  it('502s with a hint when the bridge is unreachable', async () => {
    const app = makeApp(async () => {
      throw new TypeError('fetch failed');
    });
    const res = await request(await listenLoopback(app)).post('/import/activity-from-broker').send({ broker: 'fidelity' });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/bridge unreachable/);
    expect(res.body.hint).toMatch(/portfolio-bridge/);
  });

  it('504s when the bridge reports loggedIn=false', async () => {
    const app = makeApp(async () =>
      jsonResponse(200, { broker: 'fidelity', loggedIn: false, rows: [] }),
    );
    const res = await request(await listenLoopback(app)).post('/import/activity-from-broker').send({ broker: 'fidelity' });
    expect(res.status).toBe(504);
    expect(res.body.error).toMatch(/login timed out/);
  });

  it('classifies a typical pull (BUY new + SELL new + duplicate + dividend + ach)', async () => {
    // Real-shape rows pulled from your screenshot. The fingerprint of
    // the BUY-NBIS row is what we put in the existing map to simulate a
    // dedup hit.
    const dupFingerprint =
      // sha256('2026-05-07|2943|BUY|NBIS|0.6500|175.3000') — precomputed.
      // We cheat and let the test compute it via the route, but for
      // setup we just key on a known-stable string. To keep the test
      // hermetic, we let the route tell us the fp first by running once.
      ''; // filled in below
    // First pass: no existing rows. Capture fingerprint of the BUY-NBIS row.
    let appNoDups = makeApp(async () =>
      jsonResponse(200, {
        broker: 'fidelity',
        loggedIn: true,
        sourceUrl: 'https://digital.fidelity.com/...',
        rows: [
          {
            date: 'May-07-2026',
            accountLabel: 'BrokerageLink ***2943',
            description: 'YOU BOUGHT COREWEAVE INC COM CL A (CRWV) (Cash)',
            amount: '-$127.00',
            quantity: '1',
            pricePerUnit: '$127.00',
          },
          {
            date: 'May-07-2026',
            accountLabel: 'BrokerageLink ***2943',
            description: 'YOU BOUGHT NEBIUS GROUP N V COM USD0.01 CL A (NBIS) (Cash)',
            amount: '-$113.99',
            quantity: '0.65',
            pricePerUnit: '$175.3',
          },
          {
            date: 'May-04-2026',
            accountLabel: 'ROTH IRA ***6741',
            description: 'YOU SOLD TESLA INC COM (TSLA) (Cash)',
            amount: '+$152.07',
            quantity: '0.4',
            pricePerUnit: '$380.18',
          },
          {
            date: 'Apr-30-2026',
            accountLabel: 'BrokerageLink ***2943',
            description: 'DIVIDEND RECEIVED FIDELITY GOVERNMENT CASH RESERVES (FDRXX) (Cash)',
            amount: '+$64.10',
          },
          {
            date: 'Apr-30-2026',
            accountLabel: 'BrokerageLink ***2943',
            description: 'REINVESTMENT FIDELITY GOVERNMENT CASH RESERVES (FDRXX) (Cash)',
            amount: '-$64.10',
            quantity: '64.10',
            pricePerUnit: '$1.00',
          },
          {
            date: 'Apr-27-2026',
            accountLabel: 'Individual - TOD ***5841',
            description: 'Electronic Funds Transfer Paid (Cash)',
            amount: '-$8,693.17',
          },
        ],
      }),
      accounts,
    );
    const r1 = await request(await listenLoopback(appNoDups)).post('/import/activity-from-broker').send({ broker: 'fidelity' });
    expect(r1.status).toBe(200);

    // Categorize the rows by status kind.
    const byKind: Record<string, number> = {};
    for (const row of r1.body.rows) {
      byKind[row.status.kind] = (byKind[row.status.kind] ?? 0) + 1;
    }
    expect(byKind).toEqual({
      new: 3,         // CRWV, NBIS, TSLA
      'new-cash': 2,  // DIVIDEND, ACH
      'skip-sweep': 1, // FDRXX REINVEST
    });
    expect(r1.body.summary).toMatchObject({
      total: 6,
      new: 3,
      duplicates: 0,
      newCash: 2,
      duplicateCash: 0,
      rejectedCash: 0,
      skippedCash: 0,
      skippedSweep: 1,
      rejected: 0,
      noAccountMatch: 0,
    });
    expect(r1.body.source.sourceUrl).toBe('https://digital.fidelity.com/...');
    expect(r1.body.accounts).toHaveLength(4);

    // Fingerprints are deterministic — capture NBIS's so we can simulate dedup.
    const nbisRow = r1.body.rows.find(
      (r: any) => r.symbol === 'NBIS' && r.action === 'BUY',
    );
    expect(nbisRow.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    // Second pass: pretend a row with that fingerprint already exists.
    const appWithDup = makeApp(
      async () =>
        jsonResponse(200, {
          broker: 'fidelity',
          loggedIn: true,
          rows: [
            {
              date: 'May-07-2026',
              accountLabel: 'BrokerageLink ***2943',
              description: 'YOU BOUGHT NEBIUS GROUP N V COM USD0.01 CL A (NBIS) (Cash)',
              amount: '-$113.99',
              quantity: '0.65',
              pricePerUnit: '$175.3',
            },
          ],
        }),
      accounts,
      { [nbisRow.fingerprint]: { accountId: 'fid-401k', existingId: 'tx-already-here' } },
    );
    const r2 = await request(await listenLoopback(appWithDup)).post('/import/activity-from-broker').send({ broker: 'fidelity' });
    expect(r2.status).toBe(200);
    expect(r2.body.summary.duplicates).toBe(1);
    expect(r2.body.summary.new).toBe(0);
    expect(r2.body.rows[0].status).toMatchObject({
      kind: 'duplicate',
      accountId: 'fid-401k',
      existingId: 'tx-already-here',
    });
  });

  it('deduplicates cash events and distinguishes exact same-day occurrences', async () => {
    const cashRows = [
      {
        date: 'Apr-30-2026',
        accountLabel: 'BrokerageLink ***2943',
        description: 'DIVIDEND RECEIVED SYNTHETIC FUND (TEST) (Cash)',
        amount: '+$12.34',
      },
      {
        date: 'Apr-30-2026',
        accountLabel: 'BrokerageLink ***2943',
        description: 'DIVIDEND RECEIVED SYNTHETIC FUND (TEST) (Cash)',
        amount: '+$12.34',
      },
    ];
    const firstApp = makeApp(
      async () => jsonResponse(200, { broker: 'fidelity', loggedIn: true, rows: cashRows }),
      accounts,
    );
    const first = await request(await listenLoopback(firstApp))
      .post('/import/activity-from-broker')
      .send({ broker: 'fidelity' })
      .expect(200);
    expect(first.body.summary.newCash).toBe(2);
    const fingerprints = first.body.rows.map((row: any) => row.fingerprint);
    expect(first.body.rows.map((row: any) => row.cashOccurrence)).toEqual([0, 1]);
    expect(new Set(fingerprints).size).toBe(2);
    expect(fingerprints.every((fingerprint: string) => /^[a-f0-9]{64}$/.test(fingerprint))).toBe(true);

    const duplicateApp = makeApp(
      async () => jsonResponse(200, { broker: 'fidelity', loggedIn: true, rows: cashRows }),
      accounts,
      {},
      { [fingerprints[0]]: { accountId: 'fid-401k', existingId: 'cash-existing' } },
    );
    const duplicate = await request(await listenLoopback(duplicateApp))
      .post('/import/activity-from-broker')
      .send({ broker: 'fidelity' })
      .expect(200);
    expect(duplicate.body.summary).toMatchObject({ newCash: 1, duplicateCash: 1 });
    expect(duplicate.body.rows[0].status).toEqual({
      kind: 'duplicate-cash',
      accountId: 'fid-401k',
      existingId: 'cash-existing',
    });
  });

  it('rejects a cash event whose signed amount is missing or invalid', async () => {
    const app = makeApp(
      async () => jsonResponse(200, {
        broker: 'fidelity',
        loggedIn: true,
        rows: [{
          date: 'Apr-30-2026',
          accountLabel: 'BrokerageLink ***2943',
          description: 'DIVIDEND RECEIVED SYNTHETIC FUND (TEST) (Cash)',
          amount: 'unavailable',
        }],
      }),
      accounts,
    );
    const response = await request(await listenLoopback(app))
      .post('/import/activity-from-broker')
      .send({ broker: 'fidelity' })
      .expect(200);
    expect(response.body.summary).toMatchObject({ newCash: 0, rejectedCash: 1 });
    expect(response.body.rows[0].status.kind).toBe('reject-cash-incomplete');
  });

  it('reports no-account-match when the row\u2019s last-4 is unknown', async () => {
    const app = makeApp(
      async () =>
        jsonResponse(200, {
          broker: 'fidelity',
          loggedIn: true,
          rows: [
            {
              date: 'May-07-2026',
              accountLabel: 'EXTERNAL ACCOUNT ***9999',
              description: 'YOU BOUGHT WIDGET CORP (WDGT) (Cash)',
              amount: '-$10.00',
              quantity: '1',
              pricePerUnit: '$10.00',
            },
          ],
        }),
      accounts, // none have last-4 ending in 9999
    );
    const res = await request(await listenLoopback(app)).post('/import/activity-from-broker').send({ broker: 'fidelity' });
    expect(res.status).toBe(200);
    expect(res.body.summary.noAccountMatch).toBe(1);
    expect(res.body.rows[0].status).toMatchObject({
      kind: 'no-account-match',
      accountLast4: '9999',
    });
  });

  it('never auto-selects the first account when last-four matching is ambiguous', async () => {
    const ambiguousAccounts: Account[] = [
      { id: 'account-a', name: 'Account A', accountNumber: 'AA001234', cashBalance: 0, currency: 'USD' },
      { id: 'account-b', name: 'Account B', accountNumber: 'BB991234', cashBalance: 0, currency: 'USD' },
    ];
    const app = makeApp(
      async () => jsonResponse(200, {
        broker: 'fidelity',
        loggedIn: true,
        rows: [{
          date: 'May-07-2026',
          accountLabel: 'Brokerage ***1234',
          description: 'YOU BOUGHT WIDGET CORP (WDGT) (Cash)',
          amount: '-$10.00',
          quantity: '1',
          pricePerUnit: '$10.00',
        }],
      }),
      ambiguousAccounts,
    );

    const response = await request(await listenLoopback(app))
      .post('/import/activity-from-broker')
      .send({ broker: 'fidelity' })
      .expect(200);
    expect(response.body.summary).toMatchObject({
      new: 0,
      noAccountMatch: 0,
      ambiguousAccountMatch: 1,
    });
    expect(response.body.rows[0].status).toEqual({
      kind: 'ambiguous-account-match',
      accountLast4: '1234',
      accountIds: ['account-a', 'account-b'],
    });
  });

  it('imports FDRXX reinvestments when importSweep=true', async () => {
    const app = makeApp(
      async () =>
        jsonResponse(200, {
          broker: 'fidelity',
          loggedIn: true,
          rows: [
            {
              date: 'Apr-30-2026',
              accountLabel: 'BrokerageLink ***2943',
              description: 'REINVESTMENT FIDELITY GOVERNMENT CASH RESERVES (FDRXX) (Cash)',
              amount: '-$64.10',
              quantity: '64.10',
              pricePerUnit: '$1.00',
            },
          ],
        }),
      accounts,
    );
    const res = await request(await listenLoopback(app))
      .post('/import/activity-from-broker')
      .send({ broker: 'fidelity', importSweep: true });
    expect(res.status).toBe(200);
    expect(res.body.summary.skippedSweep).toBe(0);
    expect(res.body.summary.new).toBe(1);
    expect(res.body.rows[0].status.kind).toBe('new');
  });

  it('flags reject-incomplete when bridge sent a buy without qty/price', async () => {
    const app = makeApp(
      async () =>
        jsonResponse(200, {
          broker: 'fidelity',
          loggedIn: true,
          rows: [
            {
              date: 'May-07-2026',
              accountLabel: 'BrokerageLink ***2943',
              description: 'YOU BOUGHT COREWEAVE INC COM CL A (CRWV) (Cash)',
              amount: '-$127.00',
              // qty/price intentionally missing — bridge couldn't expand.
            },
          ],
        }),
      accounts,
    );
    const res = await request(await listenLoopback(app)).post('/import/activity-from-broker').send({ broker: 'fidelity' });
    expect(res.body.summary.rejected).toBe(1);
    expect(res.body.rows[0].status.kind).toBe('reject-incomplete');
  });

  it('rejects an option over-close in preview instead of presenting it as committable', async () => {
    const openOption: Transaction = {
      id: 'existing-open', accountId: 'fid-roth', symbol: 'NBIS260731P00165000',
      date: '2026-07-10', quantity: -5, pricePerUnit: 6.5632, fees: 3.4,
      currency: 'USD', instrumentType: 'option', contractMultiplier: 100,
      positionEffect: 'open',
    };
    const app = makeApp(
      async () => jsonResponse(200, {
        broker: 'fidelity',
        loggedIn: true,
        rows: [{
          date: 'Jul-11-2026',
          accountLabel: 'ROTH IRA ***6741',
          description: 'YOU BOUGHT CLOSING TRANSACTION PUT (NBIS) NEBIUS GROUP N V JUL 31 26 $165 (100 SHS) (Cash)',
          amount: '-$3,634.08',
          quantity: '6',
          pricePerUnit: '$6.05',
        }],
      }),
      accounts,
      {},
      {},
      [openOption],
    );

    const response = await request(await listenLoopback(app))
      .post('/import/activity-from-broker')
      .send({ broker: 'fidelity' })
      .expect(200);
    expect(response.body.summary).toMatchObject({ new: 0, rejected: 1 });
    expect(response.body.rows[0].status).toMatchObject({
      kind: 'reject-option-ledger',
      reason: expect.stringMatching(/exceeds/),
    });
  });

  it('flags reject-unknown for unparseable descriptions', async () => {
    const app = makeApp(
      async () =>
        jsonResponse(200, {
          broker: 'fidelity',
          loggedIn: true,
          rows: [
            {
              date: 'May-07-2026',
              accountLabel: 'BrokerageLink ***2943',
              description: 'CORPORATE ACTION SOMETHING NEW',
              amount: '$0.00',
            },
          ],
        }),
      accounts,
    );
    const res = await request(await listenLoopback(app)).post('/import/activity-from-broker').send({ broker: 'fidelity' });
    expect(res.body.summary.rejected).toBe(1);
    expect(res.body.rows[0].status.kind).toBe('reject-unknown');
    // We don't fingerprint reject-unknown rows.
    expect(res.body.rows[0].fingerprint).toBeNull();
  });

  it('returns an empty summary when the bridge feed is empty', async () => {
    const app = makeApp(
      async () =>
        jsonResponse(200, { broker: 'fidelity', loggedIn: true, rows: [] }),
      accounts,
    );
    const res = await request(await listenLoopback(app)).post('/import/activity-from-broker').send({ broker: 'fidelity' });
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({
      total: 0,
      new: 0,
      duplicates: 0,
      skippedCash: 0,
      newCash: 0,
      duplicateCash: 0,
      rejectedCash: 0,
      skippedSweep: 0,
      rejected: 0,
      noAccountMatch: 0,
    });
  });

  it('previews two completed option fills and rejects a leaked canceled order', async () => {
    const optionAccount: Account = {
      id: 'fid-individual-tod-x533', name: 'Casey · Fidelity Individual TOD',
      accountNumber: '7142', cashBalance: 0, currency: 'USD',
    };
    const description = 'YOU SOLD OPENING TRANSACTION PUT (NBIS) NEBIUS GROUP N V COM JUL 31 26 $165 (100 SHS) (Cash)';
    const app = makeApp(
      async () => jsonResponse(200, {
        broker: 'fidelity',
        loggedIn: true,
        rows: [
          { date: 'Jul-10-2026', accountLabel: 'Individual *****7142', description, amount: '+$2,437.28', quantity: '4', pricePerUnit: '$6.10' },
          { date: 'Jul-10-2026', accountLabel: 'Individual *****7142', description, amount: '+$844.32', quantity: '1', pricePerUnit: '$8.45' },
          { date: 'Jul-10-2026', accountLabel: 'Individual *****7142', description: 'Sell to Open 1 Contract NBIS Jul 31 2026 165 Put Limit at $7.57 (Day) Verified Canceled', amount: '--' },
        ],
      }),
      [optionAccount],
    );
    const response = await request(await listenLoopback(app))
      .post('/import/activity-from-broker')
      .send({ broker: 'fidelity' })
      .expect(200);
    expect(response.body.summary).toMatchObject({ total: 3, new: 2, rejected: 1 });
    expect(response.body.rows.slice(0, 2)).toEqual([
      expect.objectContaining({
        action: 'SELL_TO_OPEN', symbol: 'NBIS260731P00165000', quantity: -4,
        fees: 2.72, instrumentType: 'option', contractMultiplier: 100,
        positionEffect: 'open', status: expect.objectContaining({ kind: 'new', accountId: optionAccount.id }),
      }),
      expect.objectContaining({
        action: 'SELL_TO_OPEN', symbol: 'NBIS260731P00165000', quantity: -1,
        fees: 0.68, instrumentType: 'option', contractMultiplier: 100,
        positionEffect: 'open', status: expect.objectContaining({ kind: 'new', accountId: optionAccount.id }),
      }),
    ]);
    expect(response.body.rows[0].fingerprint).not.toBe(response.body.rows[1].fingerprint);
    expect(response.body.rows[2].status.kind).toBe('reject-unknown');
  });
});
