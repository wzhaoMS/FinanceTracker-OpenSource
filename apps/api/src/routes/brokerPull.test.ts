import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Account } from '@finance-tracker/shared';

import { createBrokerImportRouter, scoreMatch, matchAccount, ownerFromName, pickDominantOwner } from './brokerPull.js';
import { listenLoopback } from '../testing/loopback.js';

/**
 * Build an app with the broker router mounted under /import and a fake
 * fetch implementation injected. Mirrors the actual mount in apps/api/src/index.ts.
 */
function makeApp(fetchImpl: typeof fetch, accounts?: Account[]) {
  const app = express();
  app.use(express.json());
  const state = accounts ? { listAccounts: () => accounts } : undefined;
  app.use('/import', createBrokerImportRouter({ bridgeUrl: 'http://bridge.test', fetchImpl, state }));
  return app;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /import/from-broker', () => {
  it('400s when accountId is missing on a non-sectioned response', async () => {
    const app = makeApp(async () =>
      jsonResponse(200, {
        broker: 'schwab',
        loggedIn: true,
        sourceUrl: 'https://schwab.example/positions',
        table: { headers: ['Symbol', 'Quantity'], rows: [{ Symbol: 'AAPL', Quantity: '1' }] },
      }),
    );
    const res = await request(await listenLoopback(app)).post('/import/from-broker').send({ broker: 'schwab' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/accountId/);
  });

  it('400s when broker is missing', async () => {
    const app = makeApp(async () => jsonResponse(200, {}));
    const res = await request(await listenLoopback(app)).post('/import/from-broker').send({ accountId: 'acc-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/broker/);
  });

  it('502s with a hint when the bridge is unreachable', async () => {
    const app = makeApp(async () => {
      throw new TypeError('fetch failed');
    });
    const res = await request(await listenLoopback(app))
      .post('/import/from-broker')
      .send({ accountId: 'acc-1', broker: 'schwab' });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/bridge unreachable/);
    expect(res.body.hint).toMatch(/portfolio-bridge\/server\.py/);
  });

  it('504s when the bridge reports loggedIn=false', async () => {
    const app = makeApp(async () =>
      jsonResponse(200, {
        broker: 'schwab',
        loggedIn: false,
        sourceUrl: 'https://schwab.com/login',
        tableCount: 0,
        candidateCount: 0,
        table: { headers: [], rows: [] },
      }),
    );
    const res = await request(await listenLoopback(app))
      .post('/import/from-broker')
      .send({ accountId: 'acc-1', broker: 'schwab' });
    expect(res.status).toBe(504);
    expect(res.body.error).toMatch(/login timed out/);
  });

  it('forwards bridge errors verbatim', async () => {
    const app = makeApp(async () => jsonResponse(502, { error: 'no positions table found' }));
    const res = await request(await listenLoopback(app))
      .post('/import/from-broker')
      .send({ accountId: 'acc-1', broker: 'schwab' });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/no positions table/);
  });

  it('runs the importMapper on bridge output and returns the standard preview shape', async () => {
    let bridgeBody: unknown = null;
    const app = makeApp(async (_url, init) => {
      bridgeBody = JSON.parse((init as RequestInit).body as string);
      return jsonResponse(200, {
        broker: 'schwab',
        loggedIn: true,
        sourceUrl: 'https://client.schwab.com/app/accounts/positions',
        tableCount: 2,
        candidateCount: 1,
        table: {
          headers: ['Symbol', 'Quantity', 'Last price', 'Average cost basis'],
          rows: [
            { Symbol: 'AAPL', Quantity: '50', 'Last price': '$276.87', 'Average cost basis': '$155.20' },
            { Symbol: 'VTI', Quantity: '120', 'Last price': '$353.99', 'Average cost basis': '$210.45' },
          ],
        },
      });
    });

    const res = await request(await listenLoopback(app))
      .post('/import/from-broker')
      .send({ accountId: 'acc-1', broker: 'schwab', asOf: '2026-05-06' });

    expect(res.status).toBe(200);
    expect(bridgeBody).toEqual({ broker: 'schwab' });

    // Same shape /import/positions returns: transactions[], rejected[], mapping{}.
    expect(res.body.transactions).toHaveLength(2);
    expect(res.body.transactions[0]).toMatchObject({
      symbol: 'AAPL',
      quantity: 50,
      pricePerUnit: 155.2, // average cost preferred over last price
    });
    expect(res.body.rejected).toEqual([]);
    expect(res.body.mapping.symbol).toBe('Symbol');

    // Plus the new `source` block so the UI can show "pulled from <url>".
    expect(res.body.source).toMatchObject({
      broker: 'schwab',
      sourceUrl: 'https://client.schwab.com/app/accounts/positions',
      tableCount: 2,
      candidateCount: 1,
    });
  });

  it('returns per-section previews when the bridge marks rows with _section', async () => {
    const accounts: Account[] = [
      { id: 'acc-tod', name: 'Alex · Fidelity Individual TOD', type: 'Individual', cashBalance: 0, currency: 'USD' },
      { id: 'acc-roth', name: 'Alex · Fidelity Roth IRA', type: 'Roth IRA', cashBalance: 0, currency: 'USD' },
      { id: 'acc-hsa', name: 'Alex · Fidelity HSA', type: 'HSA', cashBalance: 0, currency: 'USD' },
      { id: 'acc-citi', name: 'Alex · Citi Brokerage', type: 'Individual', cashBalance: 0, currency: 'USD' },
    ];
    const app = makeApp(async () =>
      jsonResponse(200, {
        broker: 'fidelity',
        loggedIn: true,
        sourceUrl: 'https://digital.fidelity.com/...',
        tableCount: 3,
        candidateCount: 1,
        table: {
          headers: ['Symbol', 'Quantity', 'Cost basis'],
          rows: [
            { Symbol: 'TSLA', Quantity: '0.97', 'Cost basis': '$245.22', _section: 'Individual - TOD Z85325841' },
            { Symbol: 'NBIS', Quantity: '45.113', 'Cost basis': '$177.82', _section: 'ROTH IRA 191596741' },
            { Symbol: 'NVDA', Quantity: '44.601', 'Cost basis': '$124.66', _section: 'Health Savings Account 413382685' },
            { Symbol: 'TSLA', Quantity: '0.69', 'Cost basis': '$302.99', _section: 'Health Savings Account 413382685' },
          ],
        },
      }),
      accounts,
    );

    const res = await request(await listenLoopback(app))
      .post('/import/from-broker')
      // No accountId — this flow must not require it.
      .send({ broker: 'fidelity' });

    expect(res.status).toBe(200);
    expect(res.body.previews).toHaveLength(3);

    // Section 1: Individual TOD → matched, accountId left blank pending UI confirm.
    expect(res.body.previews[0]).toMatchObject({
      section: 'Individual - TOD Z85325841',
      suggestion: { accountId: 'acc-tod', accountName: 'Alex · Fidelity Individual TOD' },
    });
    expect(res.body.previews[0].transactions).toHaveLength(1);
    expect(res.body.previews[0].transactions[0]).toMatchObject({
      symbol: 'TSLA',
      quantity: 0.97,
      pricePerUnit: 245.22,
      // accountId is intentionally blank — UI must assign before commit.
      accountId: '',
    });

    // Section 2: ROTH IRA → matched.
    expect(res.body.previews[1].suggestion).toMatchObject({ accountId: 'acc-roth' });

    // Section 3: HSA → matched, contains both NVDA and TSLA.
    expect(res.body.previews[2]).toMatchObject({
      section: 'Health Savings Account 413382685',
      suggestion: { accountId: 'acc-hsa' },
    });
    expect(res.body.previews[2].transactions).toHaveLength(2);

    // The accounts list comes back so the UI can build dropdowns.
    expect(res.body.accounts).toHaveLength(4);
    expect(res.body.accounts[0]).toMatchObject({ id: 'acc-tod', name: 'Alex · Fidelity Individual TOD' });
  });

  it('leaves suggestion null when the section does not confidently match any account', async () => {
    const accounts: Account[] = [
      { id: 'acc-tod', name: 'Alex · Fidelity Individual TOD', type: 'Individual', cashBalance: 0, currency: 'USD' },
    ];
    const app = makeApp(async () =>
      jsonResponse(200, {
        broker: 'fidelity',
        loggedIn: true,
        table: {
          headers: ['Symbol', 'Quantity'],
          rows: [
            { Symbol: 'BTC', Quantity: '0.5', _section: 'External Bitcoin Wallet' },
          ],
        },
      }),
      accounts,
    );
    const res = await request(await listenLoopback(app)).post('/import/from-broker').send({ broker: 'fidelity' });
    expect(res.status).toBe(200);
    expect(res.body.previews).toHaveLength(1);
    expect(res.body.previews[0].suggestion).toBeNull();
  });
});

describe('matchAccount', () => {
  const accounts: Account[] = [
    { id: 'acc-tod', name: 'Alex · Fidelity Individual TOD', type: 'Individual', cashBalance: 0, currency: 'USD' },
    { id: 'acc-roth', name: 'Alex · Fidelity Roth IRA', type: 'Roth IRA', cashBalance: 0, currency: 'USD' },
    { id: 'acc-hsa', name: 'Alex · Fidelity HSA', type: 'HSA', cashBalance: 0, currency: 'USD' },
    { id: 'acc-401k', name: 'Alex · Fidelity BrokerageLink (401k)', type: '401(k)', cashBalance: 0, currency: 'USD' },
    { id: 'acc-citi', name: 'Alex · Citi Brokerage', type: 'Individual', cashBalance: 0, currency: 'USD' },
    { id: 'acc-casey-tod', name: 'Casey · Fidelity Individual TOD', type: 'Individual', cashBalance: 0, currency: 'USD' },
  ];

  it('matches the Fidelity ROTH IRA section to the Roth IRA account', () => {
    expect(matchAccount('ROTH IRA 191596741', accounts)?.accountId).toBe('acc-roth');
  });

  it('matches "BrokerageLink 868782943" to the BrokerageLink account', () => {
    expect(matchAccount('BrokerageLink 868782943', accounts)?.accountId).toBe('acc-401k');
  });

  it('matches "Health Savings Account ..." to the HSA account', () => {
    expect(matchAccount('Health Savings Account 413382685', accounts)?.accountId).toBe('acc-hsa');
  });

  it('returns null for a section with no overlap', () => {
    expect(matchAccount('External Bitcoin Wallet', accounts)).toBeNull();
  });

  it('scoreMatch is symmetric on token overlap', () => {
    expect(scoreMatch('roth ira', 'Alex · Fidelity Roth IRA')).toBeGreaterThan(0.9);
    expect(scoreMatch('Alex · Fidelity Roth IRA', 'roth ira')).toBeGreaterThan(0.9);
  });

  describe('with stored account numbers (deterministic)', () => {
    const accountsWithNumbers: Account[] = [
      // Two HSAs, one Alex one Casey — fuzzy match alone CAN'T disambiguate,
      // but distinct last-4 ('2685' vs '7777') makes the match deterministic.
      { id: 'alex-hsa', name: 'Alex · Fidelity HSA', accountNumber: '413382685', cashBalance: 0, currency: 'USD' },
      { id: 'casey-hsa', name: 'Casey · Fidelity HSA', accountNumber: '888887777', cashBalance: 0, currency: 'USD' },
      // Two Individual TODs, same situation.
      { id: 'alex-tod', name: 'Alex · Fidelity Individual TOD', accountNumber: 'Z85325841', cashBalance: 0, currency: 'USD' },
      { id: 'casey-tod', name: 'Casey · Fidelity Individual TOD', accountNumber: 'X11112222', cashBalance: 0, currency: 'USD' },
    ];

    it('exact last-4 match wins regardless of fuzzy text', () => {
      // Section says "Health Savings Account 413382685" → must go to Alex (***2685)
      // even though Casey also has an HSA.
      const res = matchAccount('Health Savings Account 413382685', accountsWithNumbers);
      expect(res?.accountId).toBe('alex-hsa');
      expect(res?.confidence).toBe(1.0);
    });

    it('exact last-4 match with mask prefix from broker', () => {
      // Real Fidelity sometimes shows "ROTH IRA ***6741" already masked.
      const accs: Account[] = [
        { id: 'roth-1', name: 'Alex · Roth IRA', accountNumber: '191596741', cashBalance: 0, currency: 'USD' },
        { id: 'roth-2', name: 'Casey · Roth IRA', accountNumber: '999999999', cashBalance: 0, currency: 'USD' },
      ];
      const res = matchAccount('ROTH IRA ***6741', accs);
      expect(res?.accountId).toBe('roth-1');
      expect(res?.confidence).toBe(1.0);
    });

    it('falls back to fuzzy when no account number is stored', () => {
      const noNumbers: Account[] = [
        { id: 'roth', name: 'Alex · Fidelity Roth IRA', cashBalance: 0, currency: 'USD' },
      ];
      const res = matchAccount('ROTH IRA 191596741', noNumbers);
      expect(res?.accountId).toBe('roth');
      expect(res?.confidence).toBeLessThan(1.0);
    });
  });
});

describe('owner inference', () => {
  it('extracts the leading owner before the · separator', () => {
    expect(ownerFromName('Alex · Fidelity Roth IRA')).toBe('Alex');
    expect(ownerFromName('Casey · Fidelity HSA')).toBe('Casey');
  });

  it('returns null when the name does not follow the convention', () => {
    expect(ownerFromName('Vanguard 401k')).toBeNull();
    expect(ownerFromName('')).toBeNull();
    expect(ownerFromName(undefined)).toBeNull();
  });

  it('picks the dominant owner when most sections match one person', () => {
    const accounts: Account[] = [
      { id: 'alex-tod', name: 'Alex · Fidelity Individual TOD', cashBalance: 0, currency: 'USD' },
      { id: 'alex-roth', name: 'Alex · Fidelity Roth IRA', cashBalance: 0, currency: 'USD' },
      { id: 'alex-hsa', name: 'Alex · Fidelity HSA', cashBalance: 0, currency: 'USD' },
      { id: 'xi-401k', name: 'Casey · Microsoft 401K Plan (NAV)', cashBalance: 0, currency: 'USD' },
    ];
    const previews = [
      { suggestion: { accountId: 'alex-tod' } },
      { suggestion: { accountId: 'alex-roth' } },
      { suggestion: { accountId: 'alex-hsa' } },
      { suggestion: { accountId: 'xi-401k' } },
    ];
    expect(pickDominantOwner(previews, accounts)).toBe('Alex');
  });

  it('returns null when ownership is ambiguous (50/50)', () => {
    const accounts: Account[] = [
      { id: 'alex-1', name: 'Alex · Fidelity', cashBalance: 0, currency: 'USD' },
      { id: 'xi-1', name: 'Casey · Fidelity', cashBalance: 0, currency: 'USD' },
    ];
    const previews = [
      { suggestion: { accountId: 'alex-1' } },
      { suggestion: { accountId: 'xi-1' } },
    ];
    expect(pickDominantOwner(previews, accounts)).toBeNull();
  });
});

describe('cross-owner safety net (POST /import/from-broker)', () => {
  it('drops cross-owner fuzzy suggestions when most sections belong to one owner', async () => {
    const accounts: Account[] = [
      { id: 'alex-tod', name: 'Alex · Fidelity Individual TOD', accountNumber: 'Z85325841', cashBalance: 0, currency: 'USD' },
      { id: 'alex-roth', name: 'Alex · Fidelity Roth IRA', accountNumber: '191596741', cashBalance: 0, currency: 'USD' },
      { id: 'alex-401k', name: 'Alex · Fidelity BrokerageLink (401k)', accountNumber: '868782943', cashBalance: 0, currency: 'USD' },
      // The crossing temptation: Casey also has a "Microsoft 401K Plan".
      // Alex does NOT — so a section called "MICROSOFT 401K PLAN ..." must
      // not auto-target the Casey account.
      { id: 'xi-msft', name: 'Casey · Microsoft 401K Plan (NAV)', cashBalance: 0, currency: 'USD' },
    ];
    const app = makeApp(async () =>
      jsonResponse(200, {
        broker: 'fidelity',
        loggedIn: true,
        table: {
          headers: ['Symbol', 'Quantity'],
          rows: [
            { Symbol: 'TSLA', Quantity: '1', _section: 'Individual - TOD Z85325841' },
            { Symbol: 'NBIS', Quantity: '45', _section: 'ROTH IRA 191596741' },
            { Symbol: 'GOOGL', Quantity: '830', _section: 'BrokerageLink 868782943' },
            { Symbol: 'STUB', Quantity: '1', _section: 'MICROSOFT 401K PLAN 99999' },
          ],
        },
      }),
      accounts,
    );

    const res = await request(await listenLoopback(app)).post('/import/from-broker').send({ broker: 'fidelity' });
    expect(res.status).toBe(200);
    const sectionMap: Record<string, any> = {};
    for (const p of res.body.previews) sectionMap[p.section] = p;

    // Alex's three sections match by last-4 (confidence 1.0) — keep them.
    expect(sectionMap['Individual - TOD Z85325841'].suggestion.accountId).toBe('alex-tod');
    expect(sectionMap['ROTH IRA 191596741'].suggestion.accountId).toBe('alex-roth');
    expect(sectionMap['BrokerageLink 868782943'].suggestion.accountId).toBe('alex-401k');

    // The MICROSOFT 401K PLAN section would fuzzy-match Casey's account
    // — but the safety net detects the dominant Alex owner and clears it.
    expect(sectionMap['MICROSOFT 401K PLAN 99999'].suggestion).toBeNull();
  });

  it('keeps cross-owner suggestion when the match is by deterministic last-4', async () => {
    const accounts: Account[] = [
      { id: 'alex-tod', name: 'Alex · Fidelity Individual TOD', accountNumber: 'Z85325841', cashBalance: 0, currency: 'USD' },
      { id: 'alex-roth', name: 'Alex · Fidelity Roth IRA', accountNumber: '191596741', cashBalance: 0, currency: 'USD' },
      { id: 'xi-something', name: 'Casey · Joint Brokerage', accountNumber: '999991234', cashBalance: 0, currency: 'USD' },
    ];
    const app = makeApp(async () =>
      jsonResponse(200, {
        broker: 'fidelity',
        loggedIn: true,
        table: {
          headers: ['Symbol', 'Quantity'],
          rows: [
            { Symbol: 'TSLA', Quantity: '1', _section: 'Individual - TOD Z85325841' },
            { Symbol: 'NBIS', Quantity: '45', _section: 'ROTH IRA 191596741' },
            // This last section matches Casey's account by exact last-4.
            // Last-4 collisions across owners are extremely rare and
            // intentional matches; we keep them.
            { Symbol: 'AAPL', Quantity: '5', _section: 'JOINT 999991234' },
          ],
        },
      }),
      accounts,
    );

    const res = await request(await listenLoopback(app)).post('/import/from-broker').send({ broker: 'fidelity' });
    expect(res.status).toBe(200);
    const lastSection = res.body.previews[2];
    expect(lastSection.suggestion?.accountId).toBe('xi-something');
    expect(lastSection.suggestion?.confidence).toBe(1);
  });
});
