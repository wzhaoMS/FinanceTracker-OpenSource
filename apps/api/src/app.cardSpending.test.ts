import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import {
  buildCardImportPayload,
  serializeCardImportPayload,
  type CardImportDraftRow,
} from '@finance-tracker/shared';
import { convertCardExport } from '@finance-tracker/shared/card-import-tool';
import { createApp } from './app.js';
import { hashPassword } from './auth/password.js';
import { SERVICE_CARD_SCOPE_CODE } from './auth/serviceScope.js';
import { encodeProofDeadline, encodeProofJob } from './services/cardImport/proof/request.js';
import { installProofSchema } from './services/cardImport/proof/schema.js';
import { SqliteStateRepo } from './services/sqliteStateRepo.js';
import { listenLoopback } from './testing/loopback.js';

/**
 * Card spending as the real app serves it: mounted by createApp behind
 * identify, csrfGuard and requireAuth, with the service token limited to
 * reads and v1 imports. Synthetic data only: fictional merchants and
 * made-up amounts.
 */

const FAST = { ln: 10, r: 8, p: 1 };
const ORIGIN = 'http://127.0.0.1:5173';
const TOKEN = '7c'.repeat(32);
const PASSWORD = 'correct horse battery';
const PAN = '4111111111111111';

let repo: SqliteStateRepo;
let app: Express;
let logs: string[];
let cookie: string;

beforeEach(async () => {
  repo = new SqliteStateRepo({ file: ':memory:' });
  logs = [];
  const built = createApp({
    repo,
    serviceToken: TOKEN,
    allowedOrigins: [ORIGIN],
    snapshotsEnabled: false,
    scryptParams: FAST,
    log: (line) => logs.push(line),
  });
  app = built.app;
  built.users.createUser('alex', await hashPassword(PASSWORD, FAST));
  const login = await request(await listenLoopback(app)).post('/auth/login')
    .set('Origin', ORIGIN).set('X-Holdr-Request', '1').send({ username: 'alex', password: PASSWORD });
  expect(login.status).toBe(200);
  const setCookie = (login.headers['set-cookie'] as unknown as string[]).find((value) => value.startsWith('holdr_session='));
  cookie = setCookie!.split(';')[0];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  expect(logs.join('\n')).not.toContain(PAN);
  repo.close();
});

/** What the signed-in Spending tab sends: the session cookie, its own Origin and the CSRF header. */
function browser<T extends request.Test>(test: T): T {
  return test.set('Cookie', cookie).set('Origin', ORIGIN).set('X-Holdr-Request', '1');
}

/** A local script on the Holdr server: the service token, straight to the API's loopback port. */
function service<T extends request.Test>(test: T): T {
  return test.set('Authorization', `Bearer ${TOKEN}`);
}

function payload(rows: CardImportDraftRow[], coverage = { start: '2026-09-01', end: '2026-09-30' }): string {
  return serializeCardImportPayload(buildCardImportPayload({
    source: 'e0-test', parserVersion: 'e0-test@1', issuer: 'amex', currency: 'USD', coverage, rows,
  }).payload);
}

const SEPTEMBER = payload([
  { transactionDate: '2026-09-04', amountMinor: 4200, kind: 'purchase', description: 'NORTHWIND GROCERY', issuerCategory: 'Groceries' },
  { transactionDate: '2026-09-12', amountMinor: 1850, kind: 'purchase', description: 'PROSEWARE BISTRO', issuerCategory: 'Restaurant' },
]);
const OCTOBER = payload([
  { transactionDate: '2026-10-02', amountMinor: 999, kind: 'purchase', description: 'SAMPLE STREAMING', issuerCategory: 'Entertainment' },
], { start: '2026-10-01', end: '2026-10-05' });

async function createCard(): Promise<string> {
  const created = await browser(request(await listenLoopback(app)).post('/card-accounts'))
    .set('Content-Type', 'application/json')
    .send({ issuer: 'amex', owner: 'alex', last4: '0003', currency: 'USD', nickname: 'Gold' });
  expect(created.status, created.text).toBe(201);
  return (created.body as { id: string }).id;
}

describe('card spending behind sign-in', () => {
  it('lets a signed-in session create a card, import redacted JSON and read it back, through createApp', async () => {
    const id = await createCard();
    const json = { 'Content-Type': 'application/json' };
    const preview = await browser(request(await listenLoopback(app)).post(`/card-imports/preview?cardAccountId=${id}`)).set(json).send(SEPTEMBER);
    expect(preview.status, preview.text).toBe(200);
    expect(preview.body).toMatchObject({ newCount: 2, duplicateCount: 0 });
    expect(repo.listCardTransactions({ cardAccountId: id })).toHaveLength(0);
    const commit = await browser(request(await listenLoopback(app)).post(`/card-imports/commit?cardAccountId=${id}`)).set(json).send(SEPTEMBER);
    expect(commit.status, commit.text).toBe(201);
    expect(commit.body).toMatchObject({ imported: true, newCount: 2 });

    const list = await browser(request(await listenLoopback(app)).get(`/card-transactions?cardAccountId=${id}`));
    expect(list.status).toBe(200);
    expect(list.body.transactions.map((row: { description: string }) => row.description).sort())
      .toEqual(['NORTHWIND GROCERY', 'PROSEWARE BISTRO']);
    const rowId = list.body.transactions[0].id as string;
    expect((await browser(request(await listenLoopback(app)).get(`/card-transactions/${rowId}`))).status).toBe(200);
    const noted = await browser(request(await listenLoopback(app)).patch(`/card-transactions/${rowId}`)).set(json).send({ notes: 'team lunch' });
    expect(noted.status, noted.text).toBe(200);
    expect(noted.body.notes).toBe('team lunch');
    for (const url of [
      '/card-accounts',
      '/spending/summary?from=2026-09-01&to=2026-09-30',
      '/spending/coverage',
      '/spending/insights?month=2026-09&today=2026-09-30',
    ]) {
      const res = await browser(request(await listenLoopback(app)).get(url));
      expect(res.status, `${url} ${res.text}`).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
    }
    const summary = await browser(request(await listenLoopback(app)).get('/spending/summary?from=2026-09-01&to=2026-09-30'));
    expect(JSON.stringify(summary.body)).toContain('6050');
    const renamed = await browser(request(await listenLoopback(app)).patch(`/card-accounts/${id}`)).set(json).send({ nickname: 'Gold card' });
    expect(renamed.status, renamed.text).toBe(200);
  });

  it('refuses every card mutation without the allowlisted Origin and X-Holdr-Request, before anything is read or written', async () => {
    const id = await createCard();
    const json = { 'Content-Type': 'application/json' };
    await browser(request(await listenLoopback(app)).post(`/card-imports/commit?cardAccountId=${id}`)).set(json).send(SEPTEMBER).expect(201);
    const rowId = repo.listCardTransactions({ cardAccountId: id })[0].id;
    const before = { accounts: repo.listCardAccounts(), rows: repo.listCardTransactions({ cardAccountId: id }) };
    const mutations: Array<[string, string, string | object | undefined]> = [
      ['post', '/card-accounts', { issuer: 'chase', owner: 'casey', last4: '2002', currency: 'USD' }],
      ['patch', `/card-accounts/${id}`, { nickname: 'Changed' }],
      ['post', `/card-imports/preview?cardAccountId=${id}`, OCTOBER],
      ['post', `/card-imports/commit?cardAccountId=${id}`, OCTOBER],
      ['patch', `/card-transactions/${rowId}`, { notes: 'changed' }],
      ['delete', `/card-accounts/${id}`, undefined],
    ];
    const variants: Array<[string, Record<string, string>]> = [
      ['no Origin', { Cookie: cookie, 'X-Holdr-Request': '1' }],
      ['a foreign Origin', { Cookie: cookie, Origin: 'http://evil.example', 'X-Holdr-Request': '1' }],
      ['no X-Holdr-Request', { Cookie: cookie, Origin: ORIGIN }],
    ];
    for (const [method, url, body] of mutations) {
      for (const [variant, headers] of variants) {
        const test = (request(await listenLoopback(app)) as unknown as Record<string, (url: string) => request.Test>)[method](url)
          .set(headers).set(json);
        const res = await (body === undefined ? test : test.send(typeof body === 'string' ? body : JSON.stringify(body)));
        expect(res.status, `${method.toUpperCase()} ${url} with ${variant}`).toBe(403);
      }
    }
    expect(repo.listCardAccounts()).toEqual(before.accounts);
    expect(repo.listCardTransactions({ cardAccountId: id })).toEqual(before.rows);
    // With both headers the same session gets through (DELETE has no route: the card mount's 404).
    expect((await browser(request(await listenLoopback(app)).delete(`/card-accounts/${id}`))).status).toBe(404);
  });

  it('answers 401 on every card path without a session, and never reads the repository', async () => {
    const spies = (['listCardAccounts', 'getCardAccount', 'listCardTransactions', 'importCardTransactions', 'createCardAccount'] as const)
      .map((method) => vi.spyOn(repo, method));
    for (const [method, url] of [
      ['get', '/card-accounts'], ['post', '/card-accounts'], ['get', '/card-transactions'], ['get', '/spending/summary'],
      ['post', '/card-imports/preview?cardAccountId=x'], ['post', '/card-imports/commit?cardAccountId=x'], ['get', '/spending/unknown'],
    ] as const) {
      const res = await request(await listenLoopback(app))[method](url).set('Origin', ORIGIN).set('X-Holdr-Request', '1');
      expect(res.status, `${method} ${url}`).toBe(401);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('the service token on card spending (E1b Q44)', () => {
  it('reads card spending, and runs v1 imports only with the pre-commit proof (W4 E1)', async () => {
    const id = await createCard();
    const json = { 'Content-Type': 'application/json' };
    const preview = await service(request(await listenLoopback(app)).post(`/card-imports/preview?cardAccountId=${id}`)).set(json).send(SEPTEMBER);
    expect(preview.status, preview.text).toBe(200);
    // Without the proof parameters the service principal commits nothing.
    const bare = await service(request(await listenLoopback(app)).post(`/card-imports/commit?cardAccountId=${id}`)).set(json).send(SEPTEMBER);
    expect([bare.status, bare.body.code]).toEqual([400, 'proof-required']);
    expect(repo.listCardTransactions({ cardAccountId: id })).toHaveLength(0);
    // The owner's import gives the card its first coverage; the operator kit's supervised proof then extends it.
    await browser(request(await listenLoopback(app)).post(`/card-imports/commit?cardAccountId=${id}`)).set(json).send(SEPTEMBER).expect(201);
    installProofSchema(repo.internalGetDb());
    const proof = new URLSearchParams({ proofJob: encodeProofJob('a1'.repeat(32)), proofAttempt: '1',
      proofDeadline: encodeProofDeadline(Date.now() + 30_000), proofMode: 'supervised', proofStatementPolicy: 'allow-unchecked-no-figures' });
    // Express matches routes in any case and with a trailing slash; so does the service scope.
    const again = await service(request(await listenLoopback(app)).post(`/CARD-IMPORTS/Commit/?cardAccountId=${id}&${proof}`)).set(json).send(OCTOBER);
    expect(again.status, again.text).toBe(201);
    expect(again.body.proof).toMatchObject({ mode: 'supervised', outcome: 'committed', counts: { new: 1 } });
    const rowId = repo.listCardTransactions({ cardAccountId: id })[0].id;
    for (const url of [
      '/card-accounts',
      `/card-transactions?cardAccountId=${id}`,
      `/card-transactions/${rowId}`,
      '/spending/summary?from=2026-09-01&to=2026-10-31',
      '/spending/coverage',
      '/spending/insights?month=2026-10&today=2026-10-05',
      '/spending/card-openings',
    ]) {
      const res = await service(request(await listenLoopback(app)).get(url));
      expect(res.status, `${url} ${res.text}`).toBe(200);
    }
    expect((await service(request(await listenLoopback(app)).head('/card-accounts'))).status).toBe(200);
  });

  it('answers 403 for everything else on card paths, before anything is read or written', async () => {
    const id = await createCard();
    const json = { 'Content-Type': 'application/json' };
    await browser(request(await listenLoopback(app)).post(`/card-imports/commit?cardAccountId=${id}`)).set(json).send(SEPTEMBER).expect(201);
    const rowId = repo.listCardTransactions({ cardAccountId: id })[0].id;
    const before = { accounts: repo.listCardAccounts(), rows: repo.listCardTransactions({ cardAccountId: id }) };
    const spies = (['createCardAccount', 'updateCardAccount', 'updateCardTransaction', 'confirmCardOpeningMonths', 'clearCardOpeningMonth'] as const)
      .map((method) => vi.spyOn(repo, method));
    const refused: Array<[string, string, object | undefined]> = [
      ['post', '/card-accounts', { issuer: 'chase', owner: 'casey', last4: '2002', currency: 'USD' }],
      ['patch', `/card-accounts/${id}`, { nickname: 'Changed' }],
      ['patch', `/card-transactions/${rowId}`, { notes: 'changed' }],
      ['put', `/card-transactions/${rowId}`, { notes: 'changed' }],
      ['delete', `/card-accounts/${id}`, undefined],
      ['delete', `/card-transactions/${rowId}`, undefined],
      ['post', '/card-imports/other', {}],
      ['post', '/card-imports/commit/extra', {}],
      ['post', '/spending/summary', {}],
      ['put', '/spending/card-openings', { cards: [{ cardAccountId: id, openingMonth: '2026-09' }] }],
      ['delete', `/spending/card-openings/${id}`, undefined],
      ['options', '/card-accounts', undefined],
    ];
    for (const [method, url, body] of refused) {
      const test = service((request(await listenLoopback(app)) as unknown as Record<string, (url: string) => request.Test>)[method](url));
      const res = await (body === undefined ? test : test.set(json).send(JSON.stringify(body)));
      expect(res.status, `${method.toUpperCase()} ${url}`).toBe(403);
      expect(res.body, `${method.toUpperCase()} ${url}`).toMatchObject({ code: SERVICE_CARD_SCOPE_CODE });
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(repo.listCardAccounts()).toEqual(before.accounts);
    expect(repo.listCardTransactions({ cardAccountId: id })).toEqual(before.rows);
  });

  it('is refused through a proxy and with a foreign Origin, as on every route', async () => {
    const id = await createCard();
    const proxied = await service(request(await listenLoopback(app)).get('/card-accounts')).set('X-Forwarded-For', '100.64.0.7');
    expect(proxied.status).toBe(401);
    const foreign = await service(request(await listenLoopback(app)).post(`/card-imports/preview?cardAccountId=${id}`))
      .set('Origin', 'http://evil.example').set('Content-Type', 'application/json').send(SEPTEMBER);
    expect(foreign.status).toBe(403);
  });

  it('is limited outside card spending too: no investment writes and no export (auth/serviceScope.ts)', async () => {
    const created = await service(request(await listenLoopback(app)).post('/accounts'))
      .send({ id: 'script', name: 'Script account', cashBalance: 0, currency: 'USD' });
    expect([created.status, created.body.code], created.text).toEqual([403, SERVICE_CARD_SCOPE_CODE]);
    const exported = await service(request(await listenLoopback(app)).get('/export'));
    expect([exported.status, exported.body.code]).toEqual([403, SERVICE_CARD_SCOPE_CODE]);
    expect((await service(request(await listenLoopback(app)).get('/accounts'))).status).toBe(200);
  });
});

describe('a statement period imported before it closed, then its closed statement', () => {
  // Synthetic Amex CSVs, run through the offline tool: the current period's activity, downloaded
  // before its statement closed, and that statement once closed. The order's authorization (CONTOSO)
  // was cancelled and never posted; the bistro charge has no issuer reference.
  const HEADER = 'Date,Description,Amount,Reference,Category';
  const GROCERY = "10/16/2026,NORTHWIND GROCERY,42.10,'AXP-1001',Merchandise & Supplies-Groceries";
  const BISTRO = '10/17/2026,PROSEWARE BISTRO,18.50,,Restaurant-Restaurant';
  const ORDER = "10/18/2026,CONTOSO SUPERSTORE ORDER,\"16,250.00\",'AXP-1003',Merchandise & Supplies-Internet Purchase";
  const BOOKS = "10/19/2026,FABRIKAM BOOKS,12.00,'AXP-1004',Merchandise & Supplies-Book Stores";
  const TOYS = "11/02/2026,TAILSPIN TOYS,30.00,'AXP-0003',Merchandise & Supplies-Toy Stores";
  const CURRENT_PERIOD = [HEADER, GROCERY, BISTRO, ORDER, BOOKS].join('\n');
  const CLOSED_STATEMENT = [HEADER, GROCERY, BISTRO, BOOKS, TOYS].join('\n');
  const POSTED_CHARGES = ['FABRIKAM BOOKS', 'NORTHWIND GROCERY', 'PROSEWARE BISTRO', 'TAILSPIN TOYS'];

  /** The offline tool's JSON; the status is always stated, as the tool requires. */
  function converted(csv: string, status: 'posted' | 'pending'): string {
    return convertCardExport(new Uint8Array(Buffer.from(csv, 'utf8')), { format: 'amex-csv', status }).json;
  }

  async function send(method: 'get' | 'post' | 'patch', url: string, body?: string | object) {
    const test = browser(request(await listenLoopback(app))[method](url));
    return body === undefined ? test : test.set('Content-Type', 'application/json').send(typeof body === 'string' ? body : JSON.stringify(body));
  }

  async function summary(id: string) {
    const res = await send('get', `/spending/summary?cardAccountId=${id}`);
    expect(res.status, res.text).toBe(200);
    return res.body as {
      totals: Array<{ currency: string; spendingMinor: number; chargesMinor: number; count: number }>;
      pending: Array<{ currency: string; count: number; chargesMinor: number; netMinor: number }>;
      byMonth: Array<{ month: string; currency: string; spendingMinor: number; count: number }>;
    };
  }

  async function listed(id: string, status: string): Promise<Array<{ id: string; description: string; amountMinor: number }>> {
    const res = await send('get', `/card-transactions?cardAccountId=${id}&status=${status}&sort=date-asc`);
    expect(res.status, res.text).toBe(200);
    return res.body.transactions;
  }

  it('counts only the posted charges as spending: never the cancelled authorization, and nothing twice', async () => {
    const id = await createCard();

    // Before the statement closed: every row pending, none of it spending.
    const current = converted(CURRENT_PERIOD, 'pending');
    const first = await send('post', `/card-imports/commit?cardAccountId=${id}`, current);
    expect(first.status, first.text).toBe(201);
    expect(first.body).toMatchObject({ imported: true, newCount: 4, totals: { posted: { count: 0 }, pending: { count: 4, chargesMinor: 1632260 } } });
    expect(first.body.warnings.map((warning: { code: string }) => warning.code)).toContain('pending-rows');
    let report = await summary(id);
    expect(report.totals).toEqual([]);
    expect(report.pending).toEqual([{ currency: 'USD', count: 4, chargesMinor: 1632260, creditsMinor: 0, netMinor: 1632260 }]);

    // The closed statement: the same charges posted, plus a new one; the cancelled authorization is not on it.
    const statement = converted(CLOSED_STATEMENT, 'posted');
    const preview = await send('post', `/card-imports/preview?cardAccountId=${id}`, statement);
    expect(preview.status, preview.text).toBe(200);
    // Grocery and books post by their reference; the bistro row matches by date, amount and description only.
    expect(preview.body).toMatchObject({ newCount: 1, pendingPostedCount: 2, pendingMatchCount: 1, pendingMatchRows: [1], possibleDuplicateCount: 0 });
    const undecided = await send('post', `/card-imports/commit?cardAccountId=${id}`, statement);
    expect(undecided.status).toBe(409);
    expect(undecided.body).toMatchObject({ pendingMatchCount: 1, pendingMatchRows: [1] });
    expect(repo.listCardImportBatches(id)).toHaveLength(1);
    const committed = await send('post', `/card-imports/commit?cardAccountId=${id}&pendingMatches=post`, statement);
    expect(committed.status, committed.text).toBe(201);
    expect(committed.body).toMatchObject({ imported: true, newCount: 1, pendingPostedCount: 3 });

    // Spending is the four posted charges, each once; the cancelled authorization is still only pending.
    report = await summary(id);
    expect(report.totals).toEqual([expect.objectContaining({ currency: 'USD', spendingMinor: 10260, chargesMinor: 10260, count: 4 })]);
    expect(report.byMonth.map((month) => [month.month, month.spendingMinor, month.count])).toEqual([['2026-10', 7260, 3], ['2026-11', 3000, 1]]);
    expect(report.pending).toEqual([{ currency: 'USD', count: 1, chargesMinor: 1625000, creditsMinor: 0, netMinor: 1625000 }]);
    const posted = await listed(id, 'posted');
    expect(posted.map((row) => row.description).sort()).toEqual(POSTED_CHARGES);
    const [cancelled, ...stillPending] = await listed(id, 'pending');
    expect(stillPending).toEqual([]);
    expect(cancelled).toMatchObject({ description: 'CONTOSO SUPERSTORE ORDER', amountMinor: 1625000 });
    // Pending rows posted in place: five rows in all, not nine.
    expect(repo.listCardTransactions({ cardAccountId: id })).toHaveLength(5);
    const insights = await send('get', `/spending/insights?cardAccountId=${id}&month=2026-10&today=2026-11-16`);
    expect(insights.status, insights.text).toBe(200);
    expect(JSON.stringify(insights.body)).not.toContain('1625000');

    // Importing either file again changes nothing.
    for (const [body, query] of [[statement, '&pendingMatches=post'], [current, '']]) {
      const again = await send('post', `/card-imports/commit?cardAccountId=${id}${query}`, body);
      expect(again.status, again.text).toBe(200);
      expect(again.body).toMatchObject({ imported: false, newCount: 0, pendingPostedCount: 0 });
    }
    expect(await summary(id)).toEqual(report);

    // The owner dismisses the authorization that never posted: it leaves the pending total; spending stays.
    const dismissed = await send('patch', `/card-transactions/${cancelled.id}`, { status: 'removed' });
    expect(dismissed.status, dismissed.text).toBe(200);
    const after = await summary(id);
    expect(after.pending).toEqual([]);
    expect(after.totals).toEqual(report.totals);
    expect(await listed(id, 'pending')).toEqual([]);
  });

  it('keeps pending charges out of the month\'s pace and projection, and shows them on their own', async () => {
    const id = await createCard();
    // Two earlier months of posted spending, and a posted charge earlier this month: statements that closed.
    const history = [HEADER,
      "08/05/2026,NORTHWIND GROCERY,100.00,'AXP-0801',Merchandise & Supplies-Groceries",
      "08/25/2026,FABRIKAM BOOKS,40.00,'AXP-0802',Merchandise & Supplies-Book Stores",
      "09/05/2026,NORTHWIND GROCERY,120.00,'AXP-0901',Merchandise & Supplies-Groceries",
      "09/25/2026,FABRIKAM BOOKS,60.00,'AXP-0902',Merchandise & Supplies-Book Stores",
      "10/03/2026,FOURTH COFFEE,10.00,'AXP-1000',Restaurant-Restaurant",
    ].join('\n');
    expect((await send('post', `/card-imports/commit?cardAccountId=${id}`, converted(history, 'posted'))).status).toBe(201);
    const pace = async () => {
      const res = await send('get', `/spending/insights?cardAccountId=${id}&month=2026-10&today=2026-10-20`);
      expect(res.status, res.text).toBe(200);
      return res.body.pace as Record<string, number | null>;
    };
    const before = await pace();
    // By the 20th: 10.00 spent; August and September spent 100.00 and 120.00 by then, 140.00 and 180.00 in all.
    expect(before).toEqual({
      daysElapsed: 20, daysInMonth: 31, spentMinor: 1000, pendingMinor: 0, typicalToDateMinor: 11000, typicalMonthMinor: 16000,
      projectedMinor: 6000, historyMonths: 2, largeMinor: 0, largeCount: 0,
    });
    // The current period, imported before it closed: only the pending figure moves, by every pending charge
    // (the cancelled order's authorization included) and never into what is spent or projected.
    expect((await send('post', `/card-imports/commit?cardAccountId=${id}`, converted(CURRENT_PERIOD, 'pending'))).status).toBe(201);
    expect(await pace()).toEqual({ ...before, pendingMinor: 1632260 });
    // The closed statement posts three of them and leaves the cancelled one pending.
    expect((await send('post', `/card-imports/commit?cardAccountId=${id}&pendingMatches=post`, converted(CLOSED_STATEMENT, 'posted'))).status).toBe(201);
    const posted = await pace();
    expect(posted).toEqual({ ...before, spentMinor: 1000 + 7260, projectedMinor: 6000 + 7260, pendingMinor: 1625000 });
    // Dismissing the cancelled authorization leaves spending and the projection as they are.
    const [cancelled] = await listed(id, 'pending');
    expect((await send('patch', `/card-transactions/${cancelled.id}`, { status: 'removed' })).status).toBe(200);
    expect(await pace()).toEqual({ ...posted, pendingMinor: 0 });
  });

  it('would have counted the cancelled authorization for good had the current period been imported with --status posted', async () => {
    // A posted row cannot be dismissed, so this is why an unclosed period must be imported with
    // --status pending, and why the tool has no default status.
    const id = await createCard();
    const wrong = await send('post', `/card-imports/commit?cardAccountId=${id}`, converted(CURRENT_PERIOD, 'posted'));
    expect(wrong.status, wrong.text).toBe(201);
    const statement = await send('post', `/card-imports/commit?cardAccountId=${id}`, converted(CLOSED_STATEMENT, 'posted'));
    expect(statement.status, statement.text).toBe(201);
    expect((await summary(id)).totals).toEqual([expect.objectContaining({ spendingMinor: 1635260, count: 5 })]);
    const order = (await listed(id, 'posted')).find((row) => row.description === 'CONTOSO SUPERSTORE ORDER')!;
    const refused = await send('patch', `/card-transactions/${order.id}`, { status: 'removed' });
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ error: 'only a pending card transaction can be dismissed' });
  });
});

describe('request bodies on card paths', () => {
  it('leaves card bodies to the card routes: an import above the app-wide 2 MB limit still parses', async () => {
    const id = await createCard();
    const padded = `${SEPTEMBER}${' '.repeat(3 * 1024 * 1024)}`;
    const preview = await browser(request(await listenLoopback(app)).post(`/card-imports/preview?cardAccountId=${id}`))
      .set('Content-Type', 'application/json').send(padded);
    expect(preview.status, preview.text.slice(0, 200)).toBe(200);
    // Everywhere else the app-wide parser and its 2 MB limit apply, with a fixed message.
    const elsewhere = await browser(request(await listenLoopback(app)).post('/accounts'))
      .set('Content-Type', 'application/json').send(`{"id":"big","name":"${'x'.repeat(3 * 1024 * 1024)}"}`);
    expect(elsewhere.status).toBe(413);
    expect(elsewhere.body).toEqual({ error: 'the request body is too large' });
  });

  it('answers malformed card bodies with the card routes\' own fixed messages, never the body', async () => {
    const id = await createCard();
    const res = await browser(request(await listenLoopback(app)).post(`/card-imports/preview?cardAccountId=${id}`))
      .set('Content-Type', 'application/json').send(`{"rows": [${PAN}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'the request body is not valid JSON' });
  });
});

describe('the app-wide error handler', () => {
  it('answers body-parser and path-decoding errors with fixed messages, never the input', async () => {
    const malformed = await browser(request(await listenLoopback(app)).post('/accounts'))
      .set('Content-Type', 'application/json').send(`{"id": "${PAN}", "name": `);
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: 'the request body is not valid JSON' });
    const undecodable = await browser(request(await listenLoopback(app)).get(`/accounts/${PAN}%E0%A4%A/history`));
    expect(undecodable.status).toBe(400);
    expect(undecodable.body).toEqual({ error: 'bad-percent-encoding' });
    for (const res of [malformed, undecodable]) expect(res.text).not.toContain(PAN);
  });
});
