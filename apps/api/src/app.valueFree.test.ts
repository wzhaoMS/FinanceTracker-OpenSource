import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import type { Express } from 'express';

import { createApp } from './app.js';
import { hashPassword } from './auth/password.js';
import { createAccountNavRouter } from './routes/accountNav.js';
import { createActivityImportRouter } from './routes/brokerActivity.js';
import { computeCashEventFingerprint } from './services/cashEvents.js';
import { getPortfolioHistory } from './services/portfolioHistory.js';
import { createHistoryRepo, type HistoryRepo } from './services/symbolHistory.js';
import { isDatabaseFailure } from './services/dbErrors.js';
import { SqliteStateRepo } from './services/sqliteStateRepo.js';
import { listenLoopback } from './testing/loopback.js';
import { SCHWAB_STATEMENT_LINES, pdfPage, textPdf } from './testing/syntheticPdf.js';

/**
 * Database failures on the routes outside card spending: no SQLite text
 * reaches a response or the log. SQLite's messages can quote what a database
 * holds (identifiers, text a foreign trigger raises); here they quote a
 * synthetic card number, the published test PAN.
 */

const FAST = { ln: 10, r: 8, p: 1 };
const ORIGIN = 'http://127.0.0.1:5173';
const PASSWORD = 'correct horse battery';
const PAN = '4111111111111111';
const FIXED_500 = { error: 'Internal server error' };

let repo: SqliteStateRepo;
let app: Express;
let logs: string[];
let cookie: string;
/** What the API's outbound fetch answers (providers, the broker bridge): offline unless a test says otherwise. */
let outbound: (url: string) => Promise<Response>;

beforeEach(async () => {
  outbound = async () => {
    throw new TypeError('fetch failed (this test is offline)');
  };
  vi.stubGlobal('fetch', vi.fn((url: string | URL) => outbound(String(url))));
  logs = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  }
  repo = new SqliteStateRepo({ file: ':memory:' });
  const built = createApp({
    repo,
    serviceToken: '3d'.repeat(32),
    allowedOrigins: [ORIGIN],
    snapshotsEnabled: false,
    scryptParams: FAST,
    log: (line) => logs.push(line),
  });
  app = built.app;
  built.users.createUser('alex', await hashPassword(PASSWORD, FAST));
  const login = await request(await listenLoopback(app)).post('/auth/login')
    .set('Origin', ORIGIN).set('X-Holdr-Request', '1').send({ username: 'alex', password: PASSWORD });
  cookie = (login.headers['set-cookie'] as unknown as string[]).find((value) => value.startsWith('holdr_session='))!.split(';')[0];
  repo.createAccount({ id: 'fid', name: 'Synthetic brokerage', cashBalance: 0, currency: 'USD', accountNumber: 'XXXX-2468' });
  repo.createTransaction({
    id: 'tx-1', accountId: 'fid', symbol: 'NVDA', date: '2026-05-01', quantity: 2, pricePerUnit: 100, currency: 'USD',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // Nothing logged carries SQLite's text: the handler logs the error's type and code only.
  expect(logs.join('\n')).not.toContain(PAN);
  repo.close();
});

const db = () => repo.internalGetDb();

/** Writes to `table` fail the way a foreign trigger makes them fail: SQLite's message is the trigger's text. */
function failWrites(table: string): void {
  db().exec(`CREATE TRIGGER pan_refuses_${table} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'refused ${PAN}'); END;`);
}

/** Reads of `table` fail with SQLite's message naming a table called after the card number. */
function failReads(table: string): void {
  db().exec(`
    ALTER TABLE ${table} RENAME TO ${table}_kept;
    CREATE TABLE pan_${PAN} (x);
    CREATE VIEW ${table} AS SELECT * FROM pan_${PAN};
    DROP TABLE pan_${PAN};
  `);
}

function browser<T extends request.Test>(test: T): T {
  return test.set('Cookie', cookie).set('Origin', ORIGIN).set('X-Holdr-Request', '1');
}

function expectValueFree500(res: request.Response, label: string): void {
  expect(res.status, `${label}: ${res.text}`).toBe(500);
  expect(res.body, label).toEqual(FIXED_500);
  expect(res.text, label).not.toContain(PAN);
}

/** The log line the app's error handler writes for a failed request: method, type and code only. */
const failureLine = (method: string, code: string) => `[holdr-api] ${method} request failed: SqliteError ${code}`;

describe('database failures on the routes outside card spending', () => {
  it('ledger writes: transactions and snapshot positions', async () => {
    failWrites('transactions');
    const created = await browser(request(await listenLoopback(app)).post('/accounts/fid/transactions'))
      .send({ id: 'tx-2', accountId: 'fid', symbol: 'AMD', date: '2026-05-02', quantity: 1, pricePerUnit: 50, currency: 'USD' });
    expectValueFree500(created, 'POST /accounts/:id/transactions');
    const snapshot = await browser(request(await listenLoopback(app)).post('/accounts/fid/snapshot-positions')).send({
      transactions: [{
        id: 'tx-3', accountId: 'fid', symbol: 'AMD', date: '2026-05-02', quantity: 1, pricePerUnit: 50, currency: 'USD', sourceFingerprint: 'pos:amd',
      }],
    });
    expectValueFree500(snapshot, 'POST /accounts/:id/snapshot-positions');
    expect(logs).toContain(failureLine('POST', 'SQLITE_CONSTRAINT_TRIGGER'));
    // The ledger is unchanged, and validation answers keep their messages.
    expect(repo.listTransactions('fid').map((transaction) => transaction.id)).toEqual(['tx-1']);
    const invalid = await browser(request(await listenLoopback(app)).post('/accounts/fid/transactions')).send({ symbol: 'AMD' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toEqual(expect.any(String));
  });

  it('cash events and cash history', async () => {
    const candidate = {
      date: '2026-05-07', eventType: 'dividend' as const, amount: 12.34, accountLast4: '2468',
      description: 'DIVIDEND RECEIVED SYNTHETIC FUND (TEST) (Cash)',
    };
    const event = {
      ...candidate, currency: 'USD', broker: 'fidelity', sourceOccurrence: 0,
      sourceFingerprint: computeCashEventFingerprint('fidelity', candidate, 0),
    };
    failWrites('account_cash_events');
    failWrites('account_cash_history');
    const inserted = await browser(request(await listenLoopback(app)).post('/accounts/fid/cash-events'))
      .set('X-Confirm-Account-Last4', '2468').send(event);
    expectValueFree500(inserted, 'POST /accounts/:id/cash-events');
    const history = await browser(request(await listenLoopback(app)).post('/accounts/fid/cash-history'))
      .set('X-Confirm-Account-Last4', '2468').send({
        currency: 'USD', broker: 'fidelity', accountLast4: '2468', sourceHash: 'a'.repeat(64), method: 'fidelity-activity-eod-v1',
        rows: [{ date: '2026-05-06', cashBalance: 100 }],
      });
    expectValueFree500(history, 'POST /accounts/:id/cash-history');
    failReads('account_cash_events');
    const listed = await browser(request(await listenLoopback(app)).get('/accounts/fid/cash-events'));
    expectValueFree500(listed, 'GET /accounts/:id/cash-events');
    expect(logs).toContain(failureLine('GET', 'SQLITE_ERROR'));
  });

  it('portfolio, performance and account history', async () => {
    failReads('transactions');
    for (const url of ['/portfolio/history?range=1M', '/portfolio/performance', '/accounts/fid/history?range=1M']) {
      expectValueFree500(await browser(request(await listenLoopback(app)).get(url)), `GET ${url}`);
    }
  });

  it('symbol history and quotes', async () => {
    failReads('symbol_price_bars');
    expectValueFree500(await browser(request(await listenLoopback(app)).get('/symbols/NVDA/history?range=1M')), 'GET /symbols/:symbol/history');
    // The providers are offline, so quotes fall back to persisted marks, whose read fails.
    expectValueFree500(await browser(request(await listenLoopback(app)).get('/quotes?symbols=NVDA')), 'GET /quotes');
    // Portfolio charts read the same price history: its failure is the request's, never an approximation reason.
    for (const url of ['/portfolio/history?range=1M', '/accounts/fid/history?range=1M']) {
      expectValueFree500(await browser(request(await listenLoopback(app)).get(url)), `GET ${url}`);
    }
  });

  it('a broker activity preview', async () => {
    outbound = async () => new Response(JSON.stringify({
      broker: 'fidelity',
      loggedIn: true,
      rows: [{
        date: 'May-07-2026', accountLabel: 'Individual ***2468',
        description: 'YOU BOUGHT NEBIUS GROUP N V COM USD0.01 CL A (NBIS) (Cash)',
        amount: '-$113.99', quantity: '0.65', pricePerUnit: '$175.3',
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    failReads('transactions');
    const res = await browser(request(await listenLoopback(app)).post('/import/activity-from-broker')).send({ broker: 'fidelity' });
    expectValueFree500(res, 'POST /import/activity-from-broker');
  });

  it('a sign-in', async () => {
    failReads('local_users');
    const res = await request(await listenLoopback(app)).post('/auth/login')
      .set('Origin', ORIGIN).set('X-Holdr-Request', '1').send({ username: 'alex', password: PASSWORD });
    expectValueFree500(res, 'POST /auth/login');
  });
});

describe('database failures inside route helpers', () => {
  /** The app's error handler as a test sees it: whether what arrived was a database failure. */
  const capture: express.ErrorRequestHandler = (err, _req, res, _next) => {
    res.status(500).json({ databaseFailure: isDatabaseFailure(err) });
  };
  const sqliteError = () => new Database.SqliteError(`no such table: pan_${PAN}`, 'SQLITE_ERROR');

  it('an option ledger that cannot be read fails the broker preview, never a row with its message', async () => {
    const preview = express().use(express.json()).use('/import', createActivityImportRouter({
      bridgeUrl: 'http://bridge.test',
      fetchImpl: async () => new Response(JSON.stringify({
        broker: 'fidelity',
        loggedIn: true,
        rows: [{
          date: 'Jul-11-2026', accountLabel: 'ROTH IRA ***6741',
          description: 'YOU SOLD OPENING TRANSACTION PUT (NBIS) NEBIUS GROUP N V COM JUL 31 26 $165 (100 SHS) (Cash)',
          amount: '+$3,281.60', quantity: '-5', pricePerUnit: '$6.5632',
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      state: {
        listAccounts: () => [{ id: 'roth', name: 'Synthetic Roth', accountNumber: '191596741', cashBalance: 0, currency: 'USD' }],
        findTransactionByFingerprint: () => null,
        findCashEventByFingerprint: () => null,
        listTransactions: () => {
          throw sqliteError();
        },
      },
    })).use(capture);
    const res = await request(await listenLoopback(preview)).post('/import/activity-from-broker').send({ broker: 'fidelity' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ databaseFailure: true });
  });

  it('a price history read that fails is the portfolio history\'s failure, never an approximation reason', async () => {
    // Only the first read fails, inside the per-symbol fetch: later reads succeed, so a swallowed failure would be a reason.
    const base = createHistoryRepo(repo);
    let reads = 0;
    const history: HistoryRepo = {
      ...base,
      readBars: (...args) => {
        reads += 1;
        if (reads === 1) throw sqliteError();
        return base.readBars(...args);
      },
    };
    const deps = { state: repo, history, fetchQuotes: async () => [] };
    await expect(getPortfolioHistory(deps, '1W', ['fid'], new Date('2026-05-10T16:00:00.000Z')))
      .rejects.toBeInstanceOf(Database.SqliteError);
  });

  it('a statement preview whose account list cannot be read', async () => {
    const nav = express().use(createAccountNavRouter({
      state: {
        getAccount: () => null,
        listAccounts: () => {
          throw sqliteError();
        },
        insertAccountNavObservation: () => {
          throw sqliteError();
        },
        listAccountNavHistory: () => [],
      },
      extractFirstPageText: async () => [
        'Charles Schwab & Co. Inc.', 'Statement Period', 'April 1-30, 2025ACCOUNT HOLDER', 'Account Number', 'XXXX-2468',
        'Account Summary', 'Ending Account Value as of 04/30 Beginning Account Value as of 04/01', '$12,345.67 $10,000.00',
      ].join('\n'),
      previewSecret: 'deterministic-test-secret',
    })).use(capture);
    const res = await request(await listenLoopback(nav)).post('/import/nav-statement/preview')
      .set('Content-Type', 'application/pdf').send(Buffer.from('%PDF-1.7 fake test bytes'));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ databaseFailure: true });
  });
});

/**
 * Holdr's own refusals name the field or rule that failed, never a value the
 * request or the database supplied (E0 review, N1: a snapshot-positions 400
 * repeated the submitted sourceFingerprint). Each request below carries a
 * value that must not come back.
 */
describe('refusals quote no submitted or stored value', () => {
  function expectRefusal(res: request.Response, status: number, error: string, value: string): void {
    expect(res.status, res.text).toBe(status);
    expect(res.body).toEqual({ error });
    expect(res.text).not.toContain(value);
  }

  it('snapshot positions without a pos: fingerprint', async () => {
    const res = await browser(request(await listenLoopback(app)).post('/accounts/fid/snapshot-positions')).send({
      transactions: [{ id: 'tx-2', symbol: 'AMD', date: '2026-05-02', quantity: 1, pricePerUnit: 50, currency: 'USD', sourceFingerprint: PAN }],
    });
    expectRefusal(res, 400, 'every transaction must have sourceFingerprint starting with "pos:"', PAN);
    expect(repo.listTransactions('fid').map((transaction) => transaction.id)).toEqual(['tx-1']);
  });

  it('an account id that is already taken', async () => {
    const account = { id: `acct-${PAN}`, name: 'Synthetic', cashBalance: 0, currency: 'USD' };
    expect((await browser(request(await listenLoopback(app)).post('/accounts')).send(account)).status).toBe(201);
    const res = await browser(request(await listenLoopback(app)).post('/accounts')).send(account);
    expectRefusal(res, 409, 'an account with this id already exists', PAN);
  });

  it('option trades the ledger refuses, on create, edit and delete', async () => {
    const SYMBOL = 'NBIS260731P00165000';
    const option = {
      symbol: SYMBOL, date: '2026-07-10', pricePerUnit: 6.5, currency: 'USD', instrumentType: 'option', contractMultiplier: 100,
    };
    const post = async (body: object) => browser(request(await listenLoopback(app)).post('/accounts/fid/transactions')).send(body);
    expectRefusal(await post({ ...option, id: 'early-close', quantity: 5, positionEffect: 'close' }), 400, 'option close has no open position', SYMBOL);
    expect((await post({ ...option, id: 'opt-open', quantity: -5, positionEffect: 'open' })).status).toBe(201);
    expectRefusal(await post({ ...option, id: 'over-close', quantity: 6, positionEffect: 'close' }), 400, 'option close exceeds the open contract count', SYMBOL);
    expectRefusal(await post({ ...option, id: 'same-side', quantity: -1, positionEffect: 'close' }), 400, 'option close does not oppose the open position', SYMBOL);
    expect((await post({ ...option, id: 'opt-close', quantity: 5, positionEffect: 'close' })).status).toBe(201);
    const edit = await browser(request(await listenLoopback(app)).patch('/transactions/opt-close')).send({ quantity: 6 });
    expectRefusal(edit, 400, 'option close exceeds the open contract count', SYMBOL);
    const removal = await browser(request(await listenLoopback(app)).delete('/transactions/opt-open'));
    expectRefusal(removal, 409, 'option close has no open position', SYMBOL);
  });

  it('cash history rows are named by position, not by their dates or balances', async () => {
    const send = async (rows: unknown[]) => browser(request(await listenLoopback(app)).post('/accounts/fid/cash-history'))
      .set('X-Confirm-Account-Last4', '2468')
      .send({ currency: 'USD', broker: 'fidelity', accountLast4: '2468', sourceHash: 'a'.repeat(64), method: 'fidelity-activity-eod-v1', rows });
    const repeated = await send([{ date: '2026-05-06', cashBalance: 1 }, { date: '2026-05-07', cashBalance: 2 }, { date: '2026-05-07', cashBalance: 3 }]);
    expectRefusal(repeated, 400, "cash history rows[2] duplicates an earlier row's date", '2026-05-07');
    const infinite = await send([{ date: '2026-05-06', cashBalance: 1 }, { date: '2026-05-05', cashBalance: 'NaN' }]);
    expectRefusal(infinite, 400, 'cash history rows[1].cashBalance must be a finite number', '2026-05-05');
  });

  it('a statement PDF that pdf.js refuses with a message quoting the document', async () => {
    // pdf.js: Bad filter name "<what the document says>".
    const document = pdfPage(`<< /Length 10 /Filter [ (${PAN}) ] >>\nstream\n0123456789\nendstream`);
    const res = await browser(request(await listenLoopback(app)).post('/import/nav-statement/preview'))
      .set('Content-Type', 'application/pdf').send(document);
    expectRefusal(res, 422, 'PDF could not be read', PAN);
  });

  it('a statement whose month or dates do not parse', async () => {
    const preview = async (lines: readonly string[]) => browser(request(await listenLoopback(app)).post('/import/nav-statement/preview'))
      .set('Content-Type', 'application/pdf').send(textPdf(lines));
    const month = SCHWAB_STATEMENT_LINES.map((line) => line.replace('April', 'Quintember'));
    expectRefusal(await preview(month), 422, 'unsupported Schwab statement month', 'Quintember');
    const ending = SCHWAB_STATEMENT_LINES.map((line) => line.replace('as of 04/30', 'as of 04/29'));
    expectRefusal(await preview(ending), 422, 'Schwab Account Summary date does not match statement period end', '2025-04-29');
  });

  it('an import preview names an ambiguous ticker\'s problem without repeating it (the row itself comes back)', async () => {
    // The reason used to quote the ticker's first five characters.
    const res = await browser(request(await listenLoopback(app)).post('/import/positions')).send({
      accountId: 'fid',
      table: { headers: ['Symbol', 'Quantity', 'Price'], rows: [{ Symbol: 'QZXJWAPPLEINC', Quantity: '1', Price: '$10' }] },
    });
    expect(res.status).toBe(200);
    expect(res.body.rejected).toHaveLength(1);
    expect(res.body.rejected[0].reason).toMatch(/^ambiguous ticker /);
    expect(res.body.rejected[0].reason).not.toContain('QZXJW');
  });

  it('a path no route serves: a JSON 404 that does not repeat it', async () => {
    for (const method of ['get', 'post', 'delete'] as const) {
      const res = await browser(request(await listenLoopback(app))[method](`/accounts/fid/${PAN}/unknown`));
      expectRefusal(res, 404, 'not-found', PAN);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
    }
  });
});
