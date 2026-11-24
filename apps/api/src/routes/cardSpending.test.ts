import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assignCardDedupeKeys,
  buildCardImportPayload,
  containsCardData,
  serializeCardImportPayload,
} from '@finance-tracker/shared';
import { convertCardExport, runCardImportCli, type CliIo, type ConvertOptions } from '@finance-tracker/shared/card-import-tool';
import {
  CARD_IMPORT_BODY_LIMIT_BYTES,
  exceptCardSpendingPaths,
  mountCardSpendingRoutes,
} from './cardSpending.js';
import { createResourceRouter } from './resources.js';
import { HoldrDbError, HoldrGuardRefusal, HoldrRefusal } from '../services/dbErrors.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { listenLoopback } from '../testing/loopback.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '../../../../packages/shared/src/cardImportTool/fixtures');
const PANS = ['4111111111111111', '371449635398431', '5555555555554444'];

let repo: SqliteStateRepo;
let app: express.Express;
let logs: string[];

const SESSION_HEADER = 'X-Test-Session';
/** Stands in for login's requireAuth. */
const requireAuth: express.RequestHandler = (req, res, next) => {
  if (req.get(SESSION_HEADER) === 'signed-in') return next();
  res.status(401).json({ error: 'sign in first' });
};

/** Wired as the integration branch must: app-wide parser skips card paths, routes mounted behind requireAuth. */
function buildApp(): express.Express {
  const server = express();
  server.use(exceptCardSpendingPaths(express.json({ limit: '2mb' })));
  server.use(createResourceRouter(repo));
  mountCardSpendingRoutes(server, { repo, requireAuth, log: (line) => logs.push(line) });
  return server;
}

/** supertest with the test session, for every request the tests make as a signed-in user. */
async function api() {
  const agent = request(await listenLoopback(app));
  const signed = <T extends { set: (name: string, value: string) => T }>(test: T) => test.set(SESSION_HEADER, 'signed-in');
  return {
    get: (url: string) => signed(agent.get(url)),
    post: (url: string) => signed(agent.post(url)),
    patch: (url: string) => signed(agent.patch(url)),
  };
}

beforeEach(() => {
  repo = new SqliteStateRepo({ file: ':memory:' });
  logs = [];
  app = buildApp();
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  // Nothing these routes log, in any test, may carry card data.
  assertNoCardData(logs.join('\n'));
  repo.close();
});

function assertNoCardData(text: string): void {
  expect(text).not.toMatch(/\d{13}/);
  for (const pan of PANS) {
    for (let i = 0; i + 5 <= pan.length; i += 1) expect(text.includes(pan.slice(i, i + 5)), 'exposes card digits').toBe(false);
  }
}

/** The offline tool's JSON for a closed statement (`--status posted`), as these tests import. */
function exported(name: string, options: Partial<ConvertOptions> & Pick<ConvertOptions, 'format'>): string {
  return convertCardExport(new Uint8Array(readFileSync(path.join(fixtures, name))), { status: 'posted', ...options }).json;
}

function fromText(text: string, options: Partial<ConvertOptions> & Pick<ConvertOptions, 'format'>): string {
  return convertCardExport(new Uint8Array(Buffer.from(text, 'utf8')), { status: 'posted', ...options }).json;
}

const ofxText = () => readFileSync(path.join(fixtures, 'statement-ofx1.ofx'), 'utf8');
const AMEX = () => exported('amex-detailed.csv', { format: 'amex-csv' });
const OFX = () => exported('statement-ofx1.ofx', { format: 'ofx', issuer: 'samplebank' });

function createAccount(input: Record<string, unknown> = {}) {
  return repo.createCardAccount({ issuer: 'amex', owner: 'casey', last4: '0003', currency: 'USD', ...input } as never);
}

async function post(url: string, body: string | object) {
  return (await api()).post(url).set('Content-Type', 'application/json').send(typeof body === 'string' ? body : JSON.stringify(body));
}

const preview = (id: string, body: string | object) => post(`/card-imports/preview?cardAccountId=${id}`, body);
const commit = (id: string, body: string | object, query = '') => post(`/card-imports/commit?cardAccountId=${id}${query}`, body);

describe('mounting behind authentication', () => {
  it('refuses to mount without an authentication middleware', () => {
    for (const missing of [undefined, null, 'yes', {}]) {
      expect(() => mountCardSpendingRoutes(express(), { repo, requireAuth: missing } as never)).toThrow(/authentication middleware/);
    }
    expect(() => mountCardSpendingRoutes(express(), undefined as never)).toThrow(/authentication middleware/);
  });

  it('runs requireAuth before any card spending handler reads a body or the repository', async () => {
    const spies = (['getCardAccount', 'listCardAccounts', 'listCardTransactions', 'importCardTransactions', 'previewCardImport', 'commitCardImport',
      'createCardAccount', 'updateCardAccount'] as const)
      .map((method) => vi.spyOn(repo, method));
    const json = (test: request.Test) => test.set('Content-Type', 'application/json');
    const anonymous = await Promise.all([
      request(await listenLoopback(app)).get('/card-accounts'),
      json(request(await listenLoopback(app)).post('/card-accounts')).send({ issuer: 'amex', owner: 'alex', currency: 'USD' }),
      json(request(await listenLoopback(app)).patch('/card-accounts/card-acct-x')).send({ status: 'closed' }),
      json(request(await listenLoopback(app)).post('/card-imports/preview?cardAccountId=x')).send(`{"rows":["${PANS[0]}"]}`),
      json(request(await listenLoopback(app)).post('/card-imports/commit?cardAccountId=x')).send(AMEX()),
      json(request(await listenLoopback(app)).post('/CARD-IMPORTS/commit/?cardAccountId=x')).send(AMEX()),
      request(await listenLoopback(app)).get('/card-transactions'),
      request(await listenLoopback(app)).get('/spending/summary'),
    ]);
    for (const res of anonymous) {
      expect(res.status).toBe(401);
      assertNoCardData(res.text);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    // Other routes are not behind the card spending guard.
    expect((await request(await listenLoopback(app)).get('/accounts')).status).toBe(200);
  });

  it('mounts later card spending routers behind the same guard and refuses routes outside its prefixes', async () => {
    const reports = express.Router();
    reports.get('/spending/summary', (_req, res) => {
      res.json({ ok: true });
    });
    const server = express();
    mountCardSpendingRoutes(server, { repo, requireAuth, routers: [reports] });
    expect((await request(await listenLoopback(server)).get('/spending/summary')).status).toBe(401);
    expect((await request(await listenLoopback(server)).get('/spending/summary').set(SESSION_HEADER, 'signed-in')).body).toEqual({ ok: true });
    const stray = express.Router();
    stray.get('/reports/spending', (_req, res) => {
      res.json({});
    });
    expect(() => mountCardSpendingRoutes(express(), { repo, requireAuth, routers: [stray] })).toThrow(/outside CARD_SPENDING_PREFIXES/);
  });

  it('refuses requests when the app-wide JSON parser does not skip card spending paths', async () => {
    const server = express();
    server.use(express.json({ limit: '2mb' }));
    mountCardSpendingRoutes(server, { repo, requireAuth, log: (line) => logs.push(line) });
    const account = createAccount();
    const res = await request(await listenLoopback(server)).post(`/card-imports/commit?cardAccountId=${account.id}`)
      .set(SESSION_HEADER, 'signed-in').set('Content-Type', 'application/json').send(AMEX());
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/does not skip their paths/);
    expect(repo.listCardTransactions()).toHaveLength(0);
  });
});

describe('errors from any card spending router', () => {
  it('end in the value-free handler, never in Express\'s default one, even in production mode', async () => {
    const server = express();
    server.set('env', 'production');
    server.use(exceptCardSpendingPaths(express.json({ limit: '2mb' })));
    // A later phase's router that parses its own JSON and decodes path parameters.
    const reports = express.Router();
    reports.post('/spending/filter', express.json(), (_req, res) => {
      res.json({ ok: true });
    });
    reports.get('/card-transactions/:id', (req, res) => {
      res.json({ ok: req.params.id.length > 0 });
    });
    reports.get('/card-transactions/:id/boom', () => {
      throw new Error(`exploded near ${PANS[0]}`);
    });
    mountCardSpendingRoutes(server, { repo, requireAuth, log: (line) => logs.push(line), routers: [reports] });
    server.get('/outside', () => {
      throw new Error('outside failure');
    });
    const signed = (test: request.Test) => test.set(SESSION_HEADER, 'signed-in');
    // Express's default handler logs from a deferred callback, after the response is sent.
    const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

    const malformed = await signed(request(await listenLoopback(server)).post('/spending/filter'))
      .set('Content-Type', 'application/json').send(`{"card":"${PANS[0]}", oops`);
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: 'the request body is not valid JSON' });
    // body-parser's strict check quotes this body back in its error message.
    const quoted = await signed(request(await listenLoopback(server)).post('/spending/filter')).set('Content-Type', 'application/json').send(`x${PANS[0]}`);
    expect(quoted.status).toBe(400);
    expect(quoted.body).toEqual({ error: 'the request body is not valid JSON' });
    const undecodable = await signed(request(await listenLoopback(server)).get(`/card-transactions/${PANS[1]}%FF`));
    expect(undecodable.status).toBe(400);
    expect(undecodable.body).toEqual({ error: 'the request path is not valid URL encoding' });
    const builtIn = await signed(request(await listenLoopback(server)).patch(`/card-accounts/${PANS[2]}%FF`)).send({ status: 'closed' });
    expect(builtIn.status).toBe(400);
    expect(builtIn.body).toEqual({ error: 'the request path is not valid URL encoding' });
    const thrown = await signed(request(await listenLoopback(server)).get('/card-transactions/abc/boom'));
    expect(thrown.status).toBe(500);
    expect(thrown.body).toEqual({ error: 'card spending request failed' });
    const unmatched = await signed(request(await listenLoopback(server)).get('/card-transactions/abc/none'));
    expect(unmatched.status).toBe(404);
    expect((await signed(request(await listenLoopback(server)).get('/card-transactions/abc'))).body).toEqual({ ok: true });
    for (const res of [malformed, quoted, undecodable, builtIn, thrown, unmatched]) {
      assertNoCardData(res.text);
      expect(res.text).not.toMatch(/oops|exploded|%FF/i);
    }
    await settle();
    assertNoCardData(logs.join('\n'));
    // Compare only this module's lines: the suite shares one process, so another file's late
    // console output can land here (it is still checked for card data above).
    expect(logs.filter((line) => line.startsWith('[card-spending]'))).toEqual(['[card-spending] GET request failed: Error']);
    // Other routes keep the app's own error handling (Express logs this one in production).
    expect((await request(await listenLoopback(server)).get('/outside')).status).toBe(500);
    await settle();
    expect(logs.some((line) => line.includes('outside failure'))).toBe(true);
    // afterEach: nothing captured from console or the log callback holds card data.
  });
});

describe('card accounts', () => {
  it('closes and reopens without changing transactions or import history, and warns on closed imports', async () => {
    const account = createAccount();
    expect((await commit(account.id, AMEX())).status).toBe(201);
    const transactions = repo.listCardTransactions();
    const batches = repo.listCardImportBatches();
    expect(transactions.length).toBeGreaterThan(0);
    for (const status of ['closed', 'active'] as const) {
      const updated = await (await api()).patch(`/card-accounts/${account.id}`).send({ status });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ id: account.id, status });
      expect((await (await api()).get('/card-accounts')).body.cardAccounts).toContainEqual(updated.body);
      expect(repo.listCardTransactions()).toEqual(transactions);
      expect(repo.listCardImportBatches()).toEqual(batches);
      const checked = await preview(account.id, AMEX());
      expect(checked.status).toBe(200);
      expect(checked.body.warnings.some((warning: { code: string }) => warning.code === 'account-closed')).toBe(status === 'closed');
    }
  });

  it('creates, lists and renames or closes card accounts', async () => {
    const created = await post('/card-accounts', { issuer: 'amex', owner: 'joint', nickname: 'Platinum', last4: '0003', currency: 'USD' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ issuer: 'amex', owner: 'joint', nickname: 'Platinum', last4: '0003', status: 'active' });
    const list = await (await api()).get('/card-accounts');
    expect(list.body.cardAccounts).toHaveLength(1);
    expect(list.headers['cache-control']).toBe('no-store');
    const id = created.body.id as string;
    const renamed = await (await api()).patch(`/card-accounts/${id}`).send({ nickname: 'Amex Plat', status: 'closed' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ nickname: 'Amex Plat', status: 'closed', last4: '0003' });
    const cleared = await (await api()).patch(`/card-accounts/${id}`).send({ nickname: null });
    expect(cleared.body.nickname).toBeUndefined();
    expect((await (await api()).patch(`/card-accounts/${id}`).send({ last4: '9999' })).status).toBe(400);
    expect((await (await api()).patch(`/card-accounts/${id}`).send({})).status).toBe(400);
    expect((await (await api()).patch('/card-accounts/card-acct-missing').send({ status: 'active' })).status).toBe(404);
    expect((await (await api()).patch(`/card-accounts/${id}`).send({ status: 'deleted' })).status).toBe(400);
    expect((await (await api()).patch(`/card-accounts/${id}`).send({ status: null })).status).toBe(400);
  });

  it('refuses card data with 422 and paths only, before anything else', async () => {
    const cases: Array<[object, string[]]> = [
      [{ issuer: 'amex', owner: 'alex', currency: 'USD', last4: PANS[0] }, ['$.last4']],
      [{ issuer: 'amex', owner: 'alex', currency: 'USD', nickname: `Gold ${PANS[1].replace(/(\d{4})/g, '$1 ')}` }, ['$.nickname']],
      [{ issuer: 'amex', owner: 'alex', currency: 'USD', [PANS[2]]: 'x' }, ['$.<card number>', '$.<key>']],
    ];
    for (const [body, paths] of cases) {
      const res = await post('/card-accounts', body);
      expect(res.status).toBe(422);
      expect(Object.keys(res.body).sort()).toEqual(['error', 'paths']);
      expect(res.body.paths).toEqual(paths);
      assertNoCardData(res.text);
    }
    const id = await (await api()).patch(`/card-accounts/${PANS[0]}`).send({ status: 'closed' });
    expect(id.status).toBe(422);
    expect(id.body.paths).toEqual(['params.id']);
    assertNoCardData(id.text);
    expect(repo.listCardAccounts()).toHaveLength(0);
  });

  it('validates strictly without echoing input', async () => {
    const unknown = await post('/card-accounts', { issuer: 'amex', owner: 'alex', currency: 'USD', holderName: 'Jane Doe' });
    expect(unknown.status).toBe(400);
    expect(unknown.text).not.toMatch(/Jane|holderName/);
    const owner = await post('/card-accounts', { issuer: 'amex', owner: 'jane', currency: 'USD' });
    expect(owner.status).toBe(400);
    expect(owner.body.error).toBe('owner must be alex, casey or joint');
    expect((await post('/card-accounts', { issuer: 'American Express', owner: 'alex', currency: 'USD' })).status).toBe(400);
    expect((await post('/card-accounts', '[1,2]')).status).toBe(400);
  });
});

describe('POST /card-imports/preview', () => {
  it('counts new rows, date range, totals and reconciliation without writing anything', async () => {
    const account = createAccount();
    const json = exported('amex-detailed.csv', { format: 'amex-csv', expected: { charges: '1969.46', credits: '1223.45' } });
    const res = await preview(account.id, json);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      cardAccountId: account.id,
      source: 'amex-csv',
      issuer: 'amex',
      rowCount: 8,
      newCount: 8,
      duplicateCount: 0,
      possibleDuplicateCount: 0,
      conflictCount: 0,
      rejectedCount: 0,
      coverage: { start: '2026-09-02', end: '2026-09-28' },
      dateRange: { start: '2026-09-02', end: '2026-09-28' },
      reconciliation: { status: 'match' },
    });
    expect(res.body.totals.posted).toMatchObject({ count: 8, chargesMinor: 196946, creditsMinor: -122345, netMinor: 74601 });
    expect(res.body.newTotals.posted.netMinor).toBe(74601);
    expect(res.body.warnings).toEqual([]);
    expect(repo.listCardTransactions()).toHaveLength(0);
    expect(repo.listCardImportBatches()).toHaveLength(0);
  });

  it('needs a known card account of the same issuer and currency', async () => {
    const account = createAccount();
    expect((await post('/card-imports/preview', AMEX())).status).toBe(400);
    expect((await preview('card-acct-nope', AMEX())).status).toBe(404);
    const chase = createAccount({ issuer: 'chase', last4: '1111' });
    const wrongIssuer = await preview(chase.id, AMEX());
    expect(wrongIssuer.status).toBe(409);
    const cad = createAccount({ currency: 'CAD' });
    expect((await preview(cad.id, AMEX())).status).toBe(409);
    expect((await post(`/card-imports/preview?cardAccountId=${account.id}&debug=1`, AMEX())).status).toBe(400);
    const pan = await post(`/card-imports/preview?cardAccountId=${PANS[0]}`, AMEX());
    expect(pan.status).toBe(422);
    expect(pan.body.paths).toEqual(['query.cardAccountId']);
  });

  it('warns about last 4, owner and pending rows, and accepts any producer slug', async () => {
    const account = createAccount({ last4: '9999', owner: 'alex' });
    const { payload } = buildCardImportPayload({
      source: 'amex-api',
      parserVersion: 'holdr-extension@0.1.0',
      issuer: 'amex',
      currency: 'USD',
      owner: 'casey',
      cards: ['0003'],
      coverage: { start: '2026-10-01', end: '2026-10-07' },
      rows: [
        { transactionDate: '2026-10-02', amountMinor: 4599, kind: 'purchase', description: 'SAMPLE STORE', status: 'pending', externalId: 'pend-1' },
        { transactionDate: '2026-10-01', postedDate: '2026-10-02', amountMinor: 1250, kind: 'purchase', description: 'CAFE', externalId: 'post-1' },
      ],
    });
    const res = await preview(account.id, serializeCardImportPayload(payload));
    expect(res.status).toBe(200);
    expect(res.body.warnings.map((warning: { code: string }) => warning.code)).toEqual(['last4-mismatch', 'owner-mismatch', 'pending-rows']);
    expect(res.body.totals.pending.netMinor).toBe(4599);
    const committed = await commit(account.id, serializeCardImportPayload(payload));
    expect(committed.status).toBe(201);
    expect(repo.listCardTransactions().map((row) => [row.status, row.source])).toEqual([['posted', 'amex-api'], ['pending', 'amex-api']]);
  });
});

describe('POST /card-imports/commit', () => {
  it('stores redacted rows, and committing the same payload again inserts nothing', async () => {
    const account = createAccount();
    const first = await commit(account.id, AMEX());
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ imported: true, newCount: 8, duplicateCount: 0, skippedPossibleDuplicates: 0 });
    expect(first.body.batch).toMatchObject({ cardAccountId: account.id, source: 'amex-csv', parserVersion: 'holdr-card-import@1.0.3', rowCount: 8, newCount: 8 });
    const stored = repo.listCardTransactions({ cardAccountId: account.id });
    expect(stored).toHaveLength(8);
    assertNoCardData(JSON.stringify(stored));
    for (const row of stored) expect(containsCardData(row.description)).toBe(false);
    expect(stored.find((row) => row.description.startsWith('HOTEL'))?.description).toMatch(/^HOTEL SAMPLE \*\*\*\d{4} FOLIO \*\*\*\d{4}$/);
    expect(stored.find((row) => row.amountMinor === -120000)?.kind).toBe('payment');

    const again = await commit(account.id, AMEX());
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ imported: false, batch: null, newCount: 0, duplicateCount: 8 });
    expect(repo.listCardTransactions()).toHaveLength(8);
    expect(repo.listCardImportBatches()).toHaveLength(1);
    const previewAgain = await preview(account.id, AMEX());
    expect(previewAgain.body).toMatchObject({ newCount: 0, duplicateCount: 8 });
  });

  it('imports a Bilt export into a bilt card once: its housing charge not spending, the payment clearing it a card payment, open-period rows posted in place later', async () => {
    const account = createAccount({ issuer: 'bilt', last4: '2310' });
    const csv = readFileSync(path.join(fixtures, 'bilt-activity.csv'), 'utf8');
    const bilt = (text: string, options: Partial<ConvertOptions> = {}) =>
      fromText(text, { format: 'bilt-csv', status: 'export', loanPayments: 'not-spending', ...options });
    // First as of a statement that closed on April 5: the two rows posted after it are pending.
    const open = bilt(csv, { status: null, closedThrough: '2026-04-05' });
    const first = await commit(account.id, open);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ imported: true, newCount: 11, duplicateCount: 0 });
    expect(first.body.batch).toMatchObject({ source: 'bilt-csv', rowCount: 11, newCount: 11 });
    const stored = () => repo.listCardTransactions({ cardAccountId: account.id });
    expect(stored().filter((row) => row.issuerCategory === 'Housing payment').map((row) => [row.kind, row.amountMinor]).sort())
      .toEqual([['other', 245000], ['payment', -245000]]);
    expect(stored().filter((row) => row.kind === 'payment').map((row) => row.amountMinor).sort((a, b) => a - b)).toEqual([-245000, -96521, -30000]);
    expect(stored().filter((row) => row.status === 'pending').map((row) => row.amountMinor).sort((a, b) => a - b)).toEqual([8800, 31240]);
    expect(JSON.stringify(stored())).not.toContain('SAMPLE CARDHOLDER');
    // The same file again, a shorter download of the same whole days, or one whose Transaction Date moved a day: nothing new.
    expect((await commit(account.id, open)).body).toMatchObject({ imported: false, newCount: 0, duplicateCount: 11 });
    const lines = csv.trimEnd().split(/\r?\n/);
    expect((await commit(account.id, bilt([lines[0], ...lines.slice(2, 6)].join('\r\n')))).body).toMatchObject({ imported: false, newCount: 0 });
    const moved = csv.replace('2026-03-07,2026-03-08,Fabrikam', '2026-03-08,2026-03-08,Fabrikam');
    expect((await commit(account.id, bilt([lines[0], ...moved.trimEnd().split(/\r?\n/).slice(4, 5)].join('\r\n')))).body)
      .toMatchObject({ imported: false, newCount: 0 });
    // After the statement closes, the same rows posted: they post in place by their keys, nothing is added.
    const later = await commit(account.id, bilt(csv));
    expect(later.body).toMatchObject({ newCount: 0, pendingPostedCount: 2 });
    expect(stored()).toHaveLength(11);
    expect(stored().filter((row) => row.status === 'pending')).toEqual([]);
  });

  it('stores the producer\'s text unchanged and agrees with it on every dedupe key', async () => {
    const account = createAccount({ last4: null });
    const descriptions = ['ＣＡＦＥ ２４', 'TEA\u200b HOUSE', 'TEA HOUSE', 'كافيه ٤٥', 'SHOP ❤️ 12', 'MAN\u0303ANA', 'VS\ufe0fTEST'];
    const { payload } = buildCardImportPayload({
      source: 'amex-csv', parserVersion: 'holdr-card-import@1.0.0', issuer: 'amex', currency: 'USD',
      rows: descriptions.map((description, index) => ({
        transactionDate: '2026-09-14', amountMinor: 575, kind: 'purchase' as const, description,
        externalId: index % 2 === 0 ? `REF-${index}` : null,
      })),
    });
    const body = serializeCardImportPayload(payload);
    expect((await commit(account.id, body)).status).toBe(201);
    const stored = repo.listCardTransactions({ cardAccountId: account.id });
    expect(stored.map((row) => [row.description, row.externalIdHash ?? row.fingerprint]))
      .toEqual(payload.rows.map((row) => [row.description, row.externalIdHash ?? row.fingerprint]));
    expect((await commit(account.id, body)).body).toMatchObject({ imported: false, newCount: 0, duplicateCount: descriptions.length });
  });

  it('imports overlapping exports once, by reference', async () => {
    const account = createAccount({ issuer: 'samplebank', last4: '1111' });
    const text = ofxText();
    const transactions = text.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/g)!;
    const list = (range: [string, string], picked: string[]) => text
      .replace(/<DTSTART>\d+/, `<DTSTART>${range[0]}`).replace(/<DTEND>\d+/, `<DTEND>${range[1]}`)
      .replace(/<STMTTRN>[\s\S]*<\/STMTTRN>/, picked.join('\r\n'));
    const early = fromText(list(['20260901', '20260918'], transactions.slice(0, 4)), { format: 'ofx', issuer: 'samplebank' });
    const late = fromText(list(['20260910', '20260930'], transactions.slice(1)), { format: 'ofx', issuer: 'samplebank' });
    expect((await commit(account.id, early)).body).toMatchObject({ newCount: 4 });
    const second = await commit(account.id, late);
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ newCount: 2, duplicateCount: 3 });
    expect(repo.listCardTransactions()).toHaveLength(6);
    const full = await preview(account.id, OFX());
    expect(full.body).toMatchObject({ newCount: 0, duplicateCount: 6 });
  });

  it('keeps two identical purchases and dedupes overlapping exports without references', async () => {
    const account = createAccount({ last4: null });
    const header = 'Date,Description,Amount\n';
    const coffee = '09/14/2026,BLUE BOTTLE COFFEE,5.75\n';
    const first = fromText(`${header}09/15/2026,ONLINE PAYMENT - THANK YOU,-120.00\n${coffee}${coffee}`, { format: 'amex-csv' });
    const second = fromText(`${header}09/16/2026,TRADER JOE'S #123,42.10\n09/15/2026,ONLINE PAYMENT - THANK YOU,-120.00\n${coffee}${coffee}`, { format: 'amex-csv' });
    expect((await commit(account.id, first)).body).toMatchObject({ newCount: 3 });
    expect(repo.listCardTransactions().filter((row) => row.description === 'BLUE BOTTLE COFFEE')).toHaveLength(2);
    expect((await commit(account.id, second)).body).toMatchObject({ newCount: 1, duplicateCount: 3 });
    // A later export with a third identical purchase that day adds exactly one row.
    const third = fromText(`${header}${coffee}${coffee}${coffee}`, { format: 'amex-csv' });
    expect((await commit(account.id, third)).body).toMatchObject({ newCount: 1, duplicateCount: 2 });
    expect(repo.listCardTransactions().filter((row) => row.description === 'BLUE BOTTLE COFFEE')).toHaveLength(3);
  });

  it('never loses the second card\'s identical purchase to per-card imports', async () => {
    const csv = [
      'Date,Description,Card Member,Account #,Amount',
      '09/14/2026,BLUE BOTTLE COFFEE,ALEX SAMPLE,XXXX-XXXXXX-90003,5.75',
      '09/14/2026,BLUE BOTTLE COFFEE,JORDAN SAMPLE,XXXX-XXXXXX-42003,5.75',
    ].join('\n');
    // The hazard: one card's rows keyed by content number the coffee 0 on each card, so both
    // per-card payloads carry the same key and the second card's purchase would be dropped.
    const perCard = (last4: string) => buildCardImportPayload({
      source: 'amex-csv', parserVersion: 'holdr-card-import@1.0.0', issuer: 'amex', currency: 'USD', cards: [last4],
      rows: [{ transactionDate: '2026-09-14', amountMinor: 575, kind: 'purchase', description: 'BLUE BOTTLE COFFEE' }],
    }).payload.rows[0].fingerprint;
    expect(perCard('0003')).toBe(perCard('2003'));
    // So the tool refuses per-card exports keyed by content...
    for (const card of ['0003', '2003']) expect(() => fromText(csv, { format: 'amex-csv', cards: [card] })).toThrow(/--card cannot be used here/);
    // ...and the whole export keeps both coffees, once, however often it is imported.
    const account = createAccount({ last4: null });
    const whole = fromText(csv, { format: 'amex-csv' });
    expect((await commit(account.id, whole)).body).toMatchObject({ newCount: 2 });
    expect((await commit(account.id, whole)).body).toMatchObject({ newCount: 0, duplicateCount: 2 });
    expect(repo.listCardTransactions().filter((row) => row.description === 'BLUE BOTTLE COFFEE')).toHaveLength(2);
  });

  it('never loses a purchase whose reference repeats on another card', async () => {
    const csv = [
      'Date,Description,Card Member,Account #,Amount,Reference',
      '09/14/2026,COFFEE,ALEX SAMPLE,XXXX-XXXXXX-40002,5.00,SAME-REF',
      '09/14/2026,COFFEE,JORDAN SAMPLE,XXXX-XXXXXX-40003,5.00,SAME-REF',
    ].join('\n');
    // The hazard: each card's subset sees SAME-REF once, so both subsets carry one external-ID hash
    // and committing them separately would keep only one coffee (each reconciling on its own).
    for (const card of ['0002', '0003']) {
      expect(() => fromText(csv, { format: 'amex-csv', cards: [card], expected: { charges: '5.00' } }))
        .toThrow(/no Reference that is unique in the whole export/);
    }
    const account = createAccount({ last4: null });
    const whole = fromText(csv, { format: 'amex-csv', expected: { charges: '10.00' } });
    expect((await commit(account.id, whole)).body).toMatchObject({ newCount: 2, reconciliation: { status: 'match' } });
    expect((await commit(account.id, whole)).body).toMatchObject({ newCount: 0, duplicateCount: 2 });
    expect(repo.listCardTransactions().filter((row) => row.description === 'COFFEE')).toHaveLength(2);
  });

  it('asks for a decision when new rows look like stored rows from an export with references', async () => {
    const account = createAccount();
    await commit(account.id, AMEX());
    const basic = fromText([
      'Date,Description,Amount',
      '09/29/2026,NEW SHOP,3.00',
      '09/14/2026,BLUE BOTTLE COFFEE OAKLAND CA,5.75',
      '09/14/2026,BLUE BOTTLE COFFEE OAKLAND CA,5.75',
      '09/02/2026,UBER *TRIP HELP.UBER.COM CA,18.40',
    ].join('\n'), { format: 'amex-csv' });
    const seen = await preview(account.id, basic);
    expect(seen.body).toMatchObject({ newCount: 4, duplicateCount: 0, possibleDuplicateCount: 3, possibleDuplicateRows: [1, 2, 3] });
    const undecided = await commit(account.id, basic);
    expect(undecided.status).toBe(409);
    expect(undecided.body.possibleDuplicateCount).toBe(3);
    expect(repo.listCardTransactions()).toHaveLength(8);
    const skipped = await commit(account.id, basic, '&possibleDuplicates=skip');
    expect(skipped.status).toBe(201);
    expect(skipped.body).toMatchObject({ newCount: 1, skippedPossibleDuplicates: 3 });
    expect(skipped.body.batch).toMatchObject({ newCount: 1, rejectedCount: 3, rowCount: 4 });
    expect(repo.listCardTransactions()).toHaveLength(9);
    const repeat = await commit(account.id, basic, '&possibleDuplicates=skip');
    expect(repeat.status).toBe(200);
    expect(repeat.body.imported).toBe(false);
    const kept = await commit(account.id, basic, '&possibleDuplicates=import');
    expect(kept.body).toMatchObject({ newCount: 3 });
    expect(repo.listCardTransactions()).toHaveLength(12);
    expect((await commit(account.id, basic, '&possibleDuplicates=maybe')).status).toBe(400);
  });

  it('only offers to skip rows that can be left out without moving another row\'s key', async () => {
    const account = createAccount();
    await commit(account.id, AMEX());
    const { payload } = buildCardImportPayload({
      source: 'amex-api', parserVersion: 'holdr-extension@0.1.0', issuer: 'amex', currency: 'USD',
      rows: [
        { transactionDate: '2026-09-14', amountMinor: 575, kind: 'purchase', description: 'BLUE BOTTLE COFFEE OAKLAND CA' },
        { transactionDate: '2026-09-14', amountMinor: 575, kind: 'purchase', description: 'BLUE BOTTLE COFFEE OAKLAND CA', status: 'pending' },
      ],
    });
    // Leaving out the posted row would renumber the pending row's fingerprint, so it is not offered.
    const seen = await preview(account.id, serializeCardImportPayload(payload));
    expect(seen.body).toMatchObject({ newCount: 2, possibleDuplicateCount: 0 });
    expect((await commit(account.id, serializeCardImportPayload(payload))).status).toBe(201);
  });

  it('flags a stored reference that comes back with another amount', async () => {
    const account = createAccount();
    await commit(account.id, AMEX());
    const uber = readFileSync(path.join(fixtures, 'amex-detailed.csv'), 'utf8').replace(',18.40,', ',19.40,');
    const res = await preview(account.id, fromText(uber, { format: 'amex-csv' }));
    expect(res.body).toMatchObject({ newCount: 0, duplicateCount: 8, conflictCount: 1, conflictRows: [7] });
    expect(res.body.warnings.map((warning: { code: string }) => warning.code)).toContain('reference-conflicts');
  });

  it('refuses a statement mismatch unless accepted, and records an empty import only for its new coverage', async () => {
    const account = createAccount({ issuer: 'samplebank', last4: '1111' });
    const wrong = exported('statement-ofx1.ofx', { format: 'ofx', issuer: 'samplebank', expected: { previousBalance: '1000.00' } });
    const seen = await preview(account.id, wrong);
    expect(seen.body.reconciliation).toMatchObject({ status: 'mismatch', checks: [{ check: 'balance', expectedMinor: 200000, actualMinor: 180455, ok: false }] });
    expect(seen.body.warnings.map((warning: { code: string }) => warning.code)).toContain('statement-mismatch');
    const refused = await commit(account.id, wrong);
    expect(refused.status).toBe(409);
    expect(repo.listCardTransactions()).toHaveLength(0);
    expect((await commit(account.id, wrong, '&acceptMismatch=true')).status).toBe(201);
    const stored = repo.listCardTransactions();

    // A quiet month: no rows, but the import speaks for its dates, so they count as covered.
    const { payload } = buildCardImportPayload({
      source: 'ofx', parserVersion: 'holdr-card-import@1.0.0', issuer: 'samplebank', currency: 'USD',
      coverage: { start: '2026-11-01', end: '2026-11-30' }, rows: [],
    });
    const empty = await commit(account.id, serializeCardImportPayload(payload));
    expect(empty.status).toBe(201);
    expect(empty.body).toMatchObject({
      imported: true, rowCount: 0, newCount: 0, dateRange: null,
      batch: { rowCount: 0, newCount: 0, duplicateCount: 0, coverage: { start: '2026-11-01', end: '2026-11-30' } },
    });
    expect(repo.listCardTransactions()).toEqual(stored);
    const again = await commit(account.id, serializeCardImportPayload(payload));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ imported: false, batch: null, rowCount: 0 });
    expect(repo.listCardImportBatches()).toHaveLength(2);
  });

  it('never touches brokerage cash, cash history, holdings or returns', async () => {
    repo.createAccount({ id: 'fid', name: 'Fidelity', cashBalance: 1234.56, currency: 'USD' });
    repo.createTransaction({ id: 't1', accountId: 'fid', symbol: 'AAPL', date: '2026-09-01', quantity: 10, pricePerUnit: 150, currency: 'USD' });
    repo.importCashHistory({
      accountId: 'fid', currency: 'USD', broker: 'fidelity', accountLast4: '1234', sourceHash: 'a'.repeat(64), method: 'test-v1',
      rows: [{ date: '2026-09-01', cashBalance: 1234.56 }],
    });
    const db = repo.internalGetDb();
    const snapshot = () => JSON.stringify({
      accounts: repo.listAccounts(),
      transactions: repo.listTransactions(),
      cashEvents: repo.listAllCashEvents(),
      cashHistory: repo.listCashHistory('fid'),
      tables: Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'card_%' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>)
        .map(({ name }) => [name, (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n])),
    });
    const before = snapshot();
    const account = createAccount();
    await commit(account.id, AMEX());
    await commit(createAccount({ issuer: 'samplebank', last4: '1111' }).id, OFX());
    expect(repo.listCardTransactions()).toHaveLength(14);
    expect(snapshot()).toBe(before);
    const exportRes = await request(await listenLoopback(app)).get('/export');
    expect(JSON.stringify(exportRes.body)).not.toMatch(/BLUE BOTTLE|card-txn/);
  });
});

describe('card data and malformed bodies', () => {
  it('answers card data anywhere in the payload with 422 and paths only, and writes nothing', async () => {
    const account = createAccount();
    const body = JSON.parse(AMEX());
    body.rows[2].description = `HOTEL ${PANS[0]}`;
    body.rows[3].merchant = `REF ${'9'.repeat(16)}`;
    body.rows[4].amountMinor = Number(PANS[0]);
    body.rows[5].issuerCategory = PANS[1].replace(/(\d{4})/g, '$1-');
    body.JaneDoe = PANS[2];
    body.rows[6][PANS[0]] = 1;
    for (const send of [preview, commit]) {
      const res = await send(account.id, body);
      expect(res.status).toBe(422);
      expect(Object.keys(res.body).sort()).toEqual(['error', 'paths']);
      expect(res.body.paths).toEqual([
        '$.<key>',
        '$.rows[2].description',
        '$.rows[3].merchant',
        '$.rows[4].amountMinor',
        '$.rows[5].issuerCategory',
        '$.rows[6].<card number>',
        '$.rows[6].<key>',
      ]);
      assertNoCardData(res.text);
      expect(res.text).not.toMatch(/JaneDoe|HOTEL|REF/);
    }
    expect(repo.listCardTransactions()).toHaveLength(0);
    let deep: unknown = 'x';
    for (let i = 0; i < 40; i += 1) deep = { a: deep };
    const nested = await preview(account.id, { ...JSON.parse(AMEX()), statement: deep });
    expect(nested.status).toBe(422);
    expect(nested.body.paths.at(-1)).toBe('$<limit>');
  });

  it('answers card secrets with 422 and paths only, before touching the repository', async () => {
    const account = createAccount();
    const spies = (['getCardAccount', 'listCardAccounts', 'listCardTransactions', 'importCardTransactions', 'previewCardImport', 'commitCardImport',
      'createCardAccount', 'updateCardAccount'] as const)
      .map((method) => vi.spyOn(repo, method));
    const body = JSON.parse(AMEX());
    body.rows[0].description = 'CVV 123; expiry 12/29';
    body.rows[1].merchant = 'PIN 2468';
    body.rows[2].issuerCategory = '{"cvv":"123"}';
    body.rows[3].cvv = '123';
    for (const send of [preview, commit]) {
      const res = await send(account.id, body);
      expect(res.status).toBe(422);
      expect(res.body).toEqual({
        error: expect.any(String),
        paths: ['$.rows[0].description', '$.rows[1].merchant', '$.rows[2].issuerCategory', '$.rows[3].<key>'],
      });
      expect(res.text).not.toMatch(/123|2468|12\/29|cvv/i);
    }
    const nickname = await post('/card-accounts', { issuer: 'amex', owner: 'alex', currency: 'USD', nickname: 'CVV 123; expiry 12/29' });
    expect(nickname.status).toBe(422);
    expect(nickname.body.paths).toEqual(['$.nickname']);
    const patch = await (await api()).patch(`/card-accounts/${account.id}`).send({ nickname: 'PIN 2468' });
    expect(patch.status).toBe(422);
    const query = await post(`/card-imports/preview?cardAccountId=${account.id}&note=PIN%202468`, AMEX());
    expect(query.status).toBe(422);
    expect(query.body.paths).toEqual(['query.<key>']);
    // The 422s above come before cardAccountId lookup, validation of the query, or any read or write.
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(repo.listCardTransactions()).toHaveLength(0);
    expect(repo.getCardAccount(account.id)?.nickname).toBeUndefined();
  });

  it('rejects schema violations with 400 issues that name paths, never values', async () => {
    const account = createAccount();
    const cases: Array<[(body: Record<string, any>) => void, string]> = [
      [(body) => { body.rows[0].amountMinor = 12.5; }, '$.rows[0].amountMinor'],
      [(body) => { body.rows[0].description = '=SUM(A1)'; }, '$.rows[0].description'],
      [(body) => { body.rows[0].fingerprint = 'cfp1:' + 'a'.repeat(64); }, '$.rows[0]'],
      [(body) => { body.rows[2].amountMinor += 1; }, '$.totals.posted.chargesMinor'],
      [(body) => { body.rows.pop(); }, '$.totals.posted.count'],
      [(body) => { body.version = 2; }, '$.version'],
      [(body) => { body.extra = 'Jane Doe'; }, '$'],
      [(body) => { body.source = 'Amex CSV'; }, '$.source'],
    ];
    for (const [mutate, issuePath] of cases) {
      const body = JSON.parse(AMEX());
      mutate(body);
      const res = await preview(account.id, body);
      expect(res.status, issuePath).toBe(400);
      expect(res.body.error).toBe('invalid card import');
      expect(res.body.issues.map((issue: { path: string }) => issue.path)).toContain(issuePath);
      expect(res.text).not.toMatch(/Jane|SUM\(A1\)/);
    }
  });

  it('never echoes or logs the body when it cannot be read', async () => {
    const account = createAccount();
    const url = `/card-imports/preview?cardAccountId=${account.id}`;
    const broken = await post(url, `{"rows": ["${PANS[0]}", oops ${PANS[1]}`);
    expect(broken.status).toBe(400);
    expect(broken.body).toEqual({ error: 'the request body is not valid JSON' });
    const latin1 = await (await api()).post(url).set('Content-Type', 'application/json')
      // superagent would JSON-encode a Buffer; send the raw bytes (its typings only allow strings).
      .serialize(((body: Buffer) => body) as unknown as (body: unknown) => string)
      .send(Buffer.concat([Buffer.from(`{"x":"${PANS[0]} `), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]));
    expect(latin1.body).toEqual({ error: 'the request body is not valid UTF-8' });
    const text = await (await api()).post(url).set('Content-Type', 'text/csv').send(`Date,Description,Amount\n09/14/2026,X ${PANS[0]},1.00\n`);
    expect(text.status).toBe(415);
    const charset = await (await api()).post(url).set('Content-Type', 'application/json; charset=latin1').send('{}');
    expect(charset.status).toBe(415);
    const gzip = await (await api()).post(url).set('Content-Type', 'application/json').set('Content-Encoding', 'gzip').send('{}');
    expect(gzip.status).toBe(415);
    const empty = await (await api()).post(url).set('Content-Type', 'application/json').send('');
    expect(empty.status).toBe(400);
    const huge = await post(url, `{"rows":["${'x'.repeat(CARD_IMPORT_BODY_LIMIT_BYTES)}${PANS[0]}"]}`);
    expect(huge.status).toBe(413);
    for (const res of [broken, latin1, text, charset, gzip, empty, huge]) assertNoCardData(res.text);
    const account2 = await (await api()).post('/card-accounts').set('Content-Type', 'application/json').send(`{"nickname":"${PANS[0]}",`);
    expect(account2.status).toBe(400);
    assertNoCardData(account2.text);
    const tooBig = await post('/card-accounts', { nickname: 'x'.repeat(20_000) });
    expect(tooBig.status).toBe(413);
  });

  it('takes payloads above the app-wide 2 MB JSON limit', async () => {
    const account = createAccount({ last4: null });
    const rows = Array.from({ length: 6_000 }, (_value, index) => ({
      transactionDate: '2026-09-14',
      amountMinor: 100 + index,
      kind: 'purchase' as const,
      description: `MERCHANT ${index} ${'X'.repeat(380)}`,
    }));
    const { payload } = buildCardImportPayload({ source: 'amex-csv', parserVersion: 'test@1', issuer: 'amex', currency: 'USD', rows });
    const body = serializeCardImportPayload(payload);
    expect(body.length).toBeGreaterThan(2.5 * 1024 * 1024);
    const res = await preview(account.id, body);
    expect(res.status).toBe(200);
    expect(res.body.newCount).toBe(6_000);
  });

  it('never formats SQLite messages or non-standard identifiers into responses or logs', async () => {
    const account = createAccount();
    const sqliteError = (message: string, code: string) => Object.assign(new Error(message), { name: 'SqliteError', code });
    vi.spyOn(repo, 'createCardAccount').mockImplementationOnce(() => {
      throw sqliteError(`CHECK constraint failed: card_accounts."${PANS[0]}" = 1`, 'SQLITE_CONSTRAINT_CHECK');
    });
    const created = await post('/card-accounts', { issuer: 'amex', owner: 'alex', currency: 'USD' });
    expect(created.status).toBe(500);
    expect(created.body).toEqual({ error: 'card spending request failed' });
    // A trigger's refusal whose message is not one of the card guards' is no proof of card data.
    vi.spyOn(repo, 'updateCardAccount').mockImplementationOnce(() => {
      throw sqliteError(`card_accounts.nickname refused for row ${PANS[1]}`, 'SQLITE_CONSTRAINT_TRIGGER');
    });
    const updated = await (await api()).patch(`/card-accounts/${account.id}`).send({ nickname: 'Gold' });
    expect(updated.status).toBe(500);
    expect(updated.body).toEqual({ error: 'card spending request failed' });
    const original = repo.commitCardImport.bind(repo);
    vi.spyOn(repo, 'commitCardImport').mockImplementationOnce((input) => {
      const result = original(input);
      return result.status === 'imported' ? { ...result, batch: { ...result.batch, id: `card-import-${PANS[2]}` } } : result;
    });
    expect((await commit(account.id, AMEX())).status).toBe(201);
    for (const res of [created, updated]) {
      expect(res.text).not.toMatch(/sqlite|constraint|card_accounts|nickname|\d/i);
    }
    expect(logs.filter((line) => line.startsWith('[card-'))).toEqual([
      '[card-spending] POST request failed: SqliteError SQLITE_CONSTRAINT_CHECK',
      '[card-spending] PATCH request failed: SqliteError SQLITE_CONSTRAINT_TRIGGER',
      '[card-imports] committed batch (non-standard id): 8 new, 0 duplicate, 0 rejected, 0 held for review, 0 review items, 0 pending posted',
    ]);
  });

  it('hides repository messages that could quote input and logs only error types', async () => {
    const account = createAccount();
    vi.spyOn(repo, 'commitCardImport').mockImplementationOnce(() => {
      throw new Error(`description ${PANS[0]} is invalid`);
    });
    const hidden = await commit(account.id, AMEX());
    expect(hidden.status).toBe(400);
    expect(hidden.body).toEqual({ error: 'invalid card import' });
    vi.spyOn(repo, 'commitCardImport').mockImplementationOnce(() => {
      const error = new Error(`CHECK constraint failed: ${PANS[1]}`);
      error.name = 'SqliteError';
      Object.assign(error, { code: 'SQLITE_CONSTRAINT_CHECK' });
      throw error;
    });
    const failed = await commit(account.id, AMEX());
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: 'card spending request failed' });
    expect(logs.some((line) => line === '[card-spending] POST request failed: SqliteError SQLITE_CONSTRAINT_CHECK')).toBe(true);
    assertNoCardData(hidden.text + failed.text);
  });
});

describe('errors from the repository\'s value-free boundary', () => {
  // The repository lets out only Holdr's own refusals (HoldrRefusal, or a card guard's trigger
  // refusal); any other database failure leaves as a HoldrDbError naming an operation and a code.
  const caught = (fn: () => unknown): unknown => {
    try {
      fn();
    } catch (error) {
      return error;
    }
    throw new Error('expected a throw');
  };
  const cardLogs = () => logs.filter((line) => line.startsWith('[card-'));

  it('answers Holdr\'s own refusals with 400 and their value-free message', async () => {
    const account = createAccount();
    expect(caught(() => repo.updateCardAccount(account.id, { status: 'deleted' } as never))).toBeInstanceOf(HoldrRefusal);
    const owner = await post('/card-accounts', { issuer: 'amex', owner: 'jane', currency: 'USD' });
    const status = await (await api()).patch(`/card-accounts/${account.id}`).send({ status: 'deleted' });
    vi.spyOn(repo, 'commitCardImport').mockImplementationOnce(() => {
      throw new HoldrRefusal('rows[0].kind is invalid');
    });
    const rows = await commit(account.id, AMEX());
    expect([owner, status, rows].map((res) => [res.status, res.body])).toEqual([
      [400, { error: 'owner must be alex, casey or joint' }],
      [400, { error: 'status must be active or closed' }],
      [400, { error: 'rows[0].kind is invalid' }],
    ]);
    expect(cardLogs()).toEqual([]);
  });

  it('answers database failures with 500 and a fixed body, logging only the error type and code', async () => {
    const account = createAccount();
    repo.internalGetDb().pragma('query_only = ON');
    const failure = caught(() => repo.createCardAccount({ issuer: 'amex', owner: 'alex', currency: 'USD' } as never));
    expect(failure).toBeInstanceOf(HoldrDbError);
    expect(failure).toMatchObject({ message: 'create card account failed (SQLITE_READONLY)', code: 'SQLITE_READONLY' });
    const results = [
      await post('/card-accounts', { issuer: 'amex', owner: 'alex', currency: 'USD' }),
      await (await api()).patch(`/card-accounts/${account.id}`).send({ nickname: 'Gold' }),
      await commit(account.id, AMEX()),
    ];
    // Reads still work, so preview answers.
    expect((await preview(account.id, AMEX())).status).toBe(200);
    repo.internalGetDb().pragma('query_only = OFF');
    for (const res of results) {
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'card spending request failed' });
    }
    expect(cardLogs()).toEqual([
      '[card-spending] POST request failed: HoldrDbError SQLITE_READONLY',
      '[card-spending] PATCH request failed: HoldrDbError SQLITE_READONLY',
      '[card-spending] POST request failed: HoldrDbError SQLITE_READONLY',
    ]);
    expect(repo.listCardAccounts()).toHaveLength(1);
    expect(repo.listCardTransactions()).toHaveLength(0);
  });

  it('answers only a card guard\'s refusal as card data (422, paths only); any other trigger is a 500', async () => {
    const account = createAccount();
    // A card guard's refusal. Only a gap in every check before the database could reach it, so the
    // repository's checks are switched off here.
    (repo as unknown as { cardDetectors: unknown }).cardDetectors = { containsCardData: () => false, containsCardSecret: () => false };
    // The boundary hands the route a fresh HoldrGuardRefusal, nothing of SQLite's exception.
    expect(caught(() => repo.createCardAccount({ issuer: 'amex', owner: 'alex', currency: 'USD', nickname: '5018 ****0009' } as never)))
      .toBeInstanceOf(HoldrGuardRefusal);
    const original = repo.createCardAccount.bind(repo);
    vi.spyOn(repo, 'createCardAccount').mockImplementationOnce((input) => original({ ...input, nickname: '5018 ****0009' }));
    const guarded = await post('/card-accounts', { issuer: 'amex', owner: 'alex', currency: 'USD' });
    expect(guarded.status).toBe(422);
    expect(guarded.body).toEqual({ error: expect.any(String), paths: ['$'] });
    expect(guarded.text).not.toMatch(/refused|trigger|sqlite|constraint|\d/i);
    // SQLITE_CONSTRAINT_TRIGGER from any other trigger is no proof of card data: a database
    // failure, answered with the fixed 500 and never with the trigger's text.
    repo.internalGetDb().exec(
      `CREATE TRIGGER test_refuse_card_account BEFORE UPDATE ON card_accounts BEGIN SELECT RAISE(ABORT, 'refused ${PANS[0]}'); END`,
    );
    expect(caught(() => repo.updateCardAccount(account.id, { nickname: 'Gold' }))).toMatchObject({
      name: 'HoldrDbError', message: 'update card account failed (SQLITE_CONSTRAINT_TRIGGER)',
    });
    const foreign = await (await api()).patch(`/card-accounts/${account.id}`).send({ nickname: 'Gold' });
    // The reported case: a trigger that is not a card guard refuses a valid purchase.
    repo.internalGetDb().exec(`CREATE TRIGGER test_refuse_purchase BEFORE INSERT ON card_transactions
      WHEN NEW.description = 'SAFE PURCHASE' BEGIN SELECT RAISE(ABORT, 'refused ${PANS[1]}'); END`);
    const purchase = await commit(account.id, fromText('Date,Description,Amount\n09/14/2026,SAFE PURCHASE,12.00\n', { format: 'amex-csv' }));
    for (const res of [foreign, purchase]) {
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'card spending request failed' });
      expect(res.text).not.toMatch(/refused|trigger|sqlite|constraint|\d/i);
    }
    expect(repo.listCardAccounts().map((row) => row.nickname ?? null)).toEqual([null]);
    expect(repo.listCardTransactions()).toHaveLength(0);
    expect(repo.listCardImportBatches()).toHaveLength(0);
    expect(cardLogs()).toEqual([
      '[card-spending] the card guards refused a write that passed every API check; nothing was written',
      '[card-spending] PATCH request failed: HoldrDbError SQLITE_CONSTRAINT_TRIGGER',
      '[card-spending] POST request failed: HoldrDbError SQLITE_CONSTRAINT_TRIGGER',
    ]);
  });
});

describe('long numbers in free text (card guard revision 4)', () => {
  // The span rule counts long references, IBANs and masked numbers as card data. The tool redacts
  // them; the API refuses them unredacted before the repository; the guard trigger is only a backstop.
  const FLAGGED = ['PAYMENT REF 123456789012345', 'IBAN GB29 NWBK 6016 1331 9268 19', '5018 ****0009', 'INV 4111 1111 1111 111', 'XXXX-90003'];
  const ORDINARY = ['UBER *TRIP 8005928996 CA', 'AMAZON MKTP US*2K4 #1234', 'PAID 09/14/2026 12.50 USD', 'ORDER 2026-09-14 AMT 1,234.56', 'CALL 1-800-555-0199 EXT 12345'];
  const SAMPLES = [...FLAGGED, ...ORDINARY];
  const csv = ['Date,Description,Amount,Category', ...SAMPLES.map((text, index) =>
    `09/${10 + index}/2026,"${text}",${index + 1}.00,"${index % 2 === 0 ? text : 'Other'}"`)].join('\n');
  // Value-free: no digits outside row indexes, no SQLite or trigger wording, no stack.
  const expectValueFree = (text: string) => {
    expect(text.replace(/rows\[\d+\]/g, '')).not.toMatch(/\d/);
    expect(text).not.toMatch(/sqlite|trigger|constraint|holdr_card|\bat \S+ \(|GB29|NWBK|PAYMENT|IBAN|XXXX/i);
  };

  it('are redacted by the tool and stored only as redacted text', async () => {
    const account = createAccount({ last4: null });
    const json = fromText(csv, { format: 'amex-csv' });
    const payload = JSON.parse(json);
    const seen = await preview(account.id, json);
    expect(seen.status).toBe(200);
    expect(seen.body).toMatchObject({ rowCount: SAMPLES.length, newCount: SAMPLES.length });
    expect((await commit(account.id, json)).status).toBe(201);
    const stored = repo.listCardTransactions({ cardAccountId: account.id });
    expect(stored.map((row) => [row.description, row.issuerCategory ?? null]))
      .toEqual(payload.rows.map((row: { description: string; issuerCategory: string | null }) => [row.description, row.issuerCategory]));
    for (const row of stored) {
      for (const text of [row.description, row.issuerCategory ?? '']) expect(containsCardData(text)).toBe(false);
    }
    for (const raw of FLAGGED) expect(stored.some((row) => row.description === raw || row.issuerCategory === raw)).toBe(false);
    for (const raw of ORDINARY.filter((text) => !containsCardData(text))) expect(stored.some((row) => row.description === raw)).toBe(true);
    expect((await commit(account.id, json)).body).toMatchObject({ imported: false, newCount: 0 });
  });

  it('are refused at preview and commit when a hand-written payload carries them unredacted', async () => {
    const account = createAccount({ last4: null });
    const body = JSON.parse(fromText(csv, { format: 'amex-csv' }));
    FLAGGED.forEach((raw, index) => {
      body.rows[index].description = raw;
    });
    body.rows[5].merchant = FLAGGED[0];
    body.rows[7].issuerCategory = FLAGGED[2];
    for (const send of [preview, commit]) {
      const res = await send(account.id, body);
      expect(res.status).toBe(422);
      expect(Object.keys(res.body).sort()).toEqual(['error', 'paths']);
      expect(res.body.paths).toEqual([
        ...FLAGGED.map((_raw, index) => `$.rows[${index}].description`), '$.rows[5].merchant', '$.rows[7].issuerCategory',
      ]);
      expectValueFree(res.text);
    }
    expect(repo.listCardTransactions()).toHaveLength(0);
    expect(repo.listCardImportBatches()).toHaveLength(0);
  });

  it('commits nothing when the guard trigger refuses one row mid-commit', async () => {
    const account = createAccount({ last4: null });
    const json = fromText(csv, { format: 'amex-csv' });
    // Simulate a gap in every check before the database (the API and the repository share the
    // detectors, so only a bug could open one): the guard trigger is then the only check left.
    (repo as unknown as { cardDetectors: unknown }).cardDetectors = { containsCardData: () => false, containsCardSecret: () => false };
    const original = repo.commitCardImport.bind(repo);
    vi.spyOn(repo, 'commitCardImport').mockImplementation((input) => {
      // The changed row keeps a consistent key, as a payload that reached the repository this way would.
      const rows = input.payload.rows.map((row, index) => (index === 3 ? { ...row, description: '5018 ****0009' } : row));
      const keys = assignCardDedupeKeys(rows);
      return original({ ...input, payload: { ...input.payload, rows: rows.map((row, index) => ({ ...row, ...keys[index] })) } });
    });
    const res = await commit(account.id, json);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: expect.any(String), paths: ['$.rows'] });
    expectValueFree(res.text);
    expect(repo.listCardTransactions()).toHaveLength(0);
    expect(repo.listCardImportBatches()).toHaveLength(0);
    expect(logs).toContain('[card-spending] the card guards refused a write that passed every API check; nothing was written');
  });
});

describe('card numbers split by dots, slashes or mixed separators', () => {
  it('are refused with 422 when a payload carries them, and never stored from the tool\'s output', async () => {
    const account = createAccount();
    // Each variant gets its own amount: they all redact to "HOTEL ***1111" and would otherwise dedupe.
    for (const [index, text] of ['4111.1111 1111.1111', '4111.1111-1111.1111', '4111.1111.1111.1111', '4111/1111/1111/1111'].entries()) {
      const body = JSON.parse(AMEX());
      body.rows[0].description = `HOTEL ${text}`;
      const res = await preview(account.id, body);
      expect(res.status).toBe(422);
      expect(res.body.paths).toEqual(['$.rows[0].description']);
      const csv = `Date,Description,Amount\n09/14/2026,HOTEL ${text},${10 + index}.00\n`;
      expect((await commit(account.id, fromText(csv, { format: 'amex-csv' }))).status).toBe(201);
    }
    expect(repo.listCardTransactions()).toHaveLength(4);
    const digits = repo.listCardTransactions().map((row) => row.description.replace(/\D/g, '')).join(' ');
    for (let i = 0; i + 5 <= 16; i += 1) expect(digits.includes('4111111111111111'.slice(i, i + 5))).toBe(false);
  });
});

describe('card numbers in long or repeated text, from the command line through preview and commit', () => {
  // The tool joins OFX NAME and MEMO, then normalizes and redacts the whole text before cutting it to
  // its stored limit; a value too long to redact is refused. Nothing may keep more than the last four
  // digits of the card number, which the ACCTID (cards: ["1881"]) already gives away.
  const PAN = '4012888888881881';
  const ofxWith = (name: string, memo: string) => readFileSync(path.join(fixtures, 'statement-ofx2.ofx'), 'utf8')
    .replace('<ACCTID>4111111111111111', '<ACCTID>XXXX-1881')
    .replace('<NAME>TRADER JOE&apos;S #123', `<NAME>${name}`)
    .replace('<MEMO>SAN FRANCISCO CA', `<MEMO>${memo}`);
  const expectPanHidden = (text: string) => {
    for (let i = 0; i + 5 <= PAN.length; i += 1) expect(text.includes(PAN.slice(i, i + 5)), 'exposes five digits of the card number').toBe(false);
  };

  function cli(args: string[], file: string, command = ['ofx', 'export.ofx', '--issuer', 'samplebank']) {
    const out = { code: -1, stdout: '', stderr: '', written: new Map<string, string>() };
    const io: CliIo = {
      readFile: (name, maxBytes) => {
        const bytes = new Uint8Array(Buffer.from(file, 'utf8'));
        if (name !== command[1] || bytes.length > maxBytes) throw new Error('cannot read the file');
        return bytes;
      },
      writeFile: (name, text) => {
        out.written.set(name, text);
      },
      samePath: (a, b) => a === b,
      stdout: (text) => {
        out.stdout += text;
      },
      stderr: (text) => {
        out.stderr += text;
      },
    };
    out.code = runCardImportCli([...command, '--status', 'posted', '--out', 'import.json', ...args], io);
    return out;
  }

  const cases: Array<[string, string, string, string, string | null]> = [
    // The reported case: 19,987 zero-width spaces, which normalization removes, push the joined text past 20,000 characters.
    ['padding that normalization removes', '\u200b'.repeat(19_987), PAN, '***1881', null],
    // Spaces collapse only after the 20,000th character: a cut there would have kept 401288888888.
    ['padding that normalization collapses', `SHOP${' '.repeat(19_981)}AT`, PAN, 'SHOP AT ***1881', 'SHOP AT'],
    // A cut at 500 characters before redaction would have kept 4012 8888 8.
    ['padding that normalization keeps', 'A'.repeat(495), PAN, `${'A'.repeat(495)} ***1`, 'A'.repeat(200)],
    ['a card number split between NAME and MEMO', 'SHOP 4012\u200b8888', '88881881 REF', 'SHOP ***1881 REF', 'SHOP'],
  ];
  for (const [label, name, memo, description, merchant] of cases) {
    it(`stores at most the last four digits with ${label}`, async () => {
      const account = createAccount({ issuer: 'samplebank', last4: '1881' });
      const run = cli([], ofxWith(name, memo));
      expect(run.code).toBe(0);
      const json = run.written.get('import.json')!;
      expect(JSON.parse(json).cards).toEqual(['1881']);
      const seen = await preview(account.id, json);
      expect(seen.status).toBe(200);
      expect(seen.body).toMatchObject({ rowCount: 6, newCount: 6 });
      const saved = await commit(account.id, json);
      expect(saved.status).toBe(201);
      const stored = repo.listCardTransactions({ cardAccountId: account.id });
      expect(stored).toHaveLength(6);
      const changed = stored.find((row) => row.amountMinor === 4210)!;
      expect([changed.description, changed.merchant ?? null]).toEqual([description, merchant]);
      for (const row of stored) {
        for (const text of [row.description, row.merchant ?? '', row.issuerCategory ?? '']) {
          expect(containsCardData(text)).toBe(false);
          expectPanHidden(text.replace(/\D/g, ''));
        }
      }
      expectPanHidden([json, run.stdout, run.stderr, seen.text, saved.text, logs.join('\n')].join('\n'));
      expect((await commit(account.id, json)).body).toMatchObject({ imported: false, newCount: 0 });
    });
  }

  /** No stored field, nor two of them read together, shows five digits of PAN (the kept `***1881` aside). */
  const expectStoredPanHidden = () => {
    for (const row of repo.listCardTransactions()) {
      const fields = [row.description, row.merchant ?? '', row.issuerCategory ?? ''];
      for (const text of fields) expect(containsCardData(text)).toBe(false);
      // Digits only, with just the four digits each `***1881` keeps left out, in every order.
      const [d, m, c] = fields.map((text) => text.replace(/\*\*\*[0-9]{4}(?![0-9])/g, '').replace(/\D/g, ''));
      for (const digits of [d, m, c, d + m, m + d, d + c, c + d, m + c, c + m, d + m + c, d + c + m, m + d + c, m + c + d, c + d + m, c + m + d]) {
        expectPanHidden(digits);
      }
    }
  };

  it('stores a NAME that MEMO repeats with other spacing once, redacted', async () => {
    const account = createAccount({ issuer: 'samplebank', last4: '1881' });
    // The reported case: before, NAME's 4012 8888 8888 was stored beside MEMO's ***1881.
    const run = cli([], ofxWith('SHOP 4012 8888 8888', `SHOP 4012  8888 8888 ${PAN.slice(-4)}`));
    expect(run.code).toBe(0);
    const json = run.written.get('import.json')!;
    expect((await preview(account.id, json)).body).toMatchObject({ rowCount: 6, newCount: 6 });
    expect((await commit(account.id, json)).status).toBe(201);
    const changed = repo.listCardTransactions().find((row) => row.amountMinor === 4210)!;
    expect([changed.description, changed.merchant]).toEqual(['SHOP ***1881', 'SHOP']);
    expectStoredPanHidden();
    expectPanHidden([json, run.stderr, logs.join('\n')].join('\n'));
  });

  it('refuses a row that would still show card digits, and imports the rest only with --skip-invalid', async () => {
    const account = createAccount({ issuer: 'samplebank', last4: '1881' });
    // NAME and MEMO say different things, so they are joined: NAME's 12 digits would stay beside ***1881.
    const file = ofxWith('PAYMENT 4012 8888 8888', `CARD ${PAN}`);
    const refused = cli([], file);
    expect(refused.code).toBe(1);
    expect(refused.written.size).toBe(0);
    expect(refused.stderr).toMatch(/line \d+: its text would show more than the last four digits of a card number in this row/);
    const skipped = cli(['--skip-invalid'], file);
    expect(skipped.code).toBe(0);
    const json = skipped.written.get('import.json')!;
    expect(JSON.parse(json)).toMatchObject({ rejectedCount: 1 });
    expect((await preview(account.id, json)).body).toMatchObject({ rowCount: 5, newCount: 5 });
    const saved = await commit(account.id, json);
    expect(saved.status).toBe(201);
    expect(saved.body.batch).toMatchObject({ newCount: 5, rejectedCount: 1 });
    expect(repo.listCardTransactions()).toHaveLength(5);
    expectStoredPanHidden();
    expectPanHidden([json, refused.stderr, skipped.stderr, saved.text, logs.join('\n')].join('\n'));
  });

  it('refuses a shortened copy hidden between extra redactions, and imports the clean rows beside it', async () => {
    const account = createAccount({ last4: '1881' });
    const csv = [
      'Date,Description,Amount,Category,Account #',
      // The reported case: the copy's groups sit between redactions of extra copies of the number.
      `09/14/2026,ALPHA 4012 BRAVO ${PAN} CHARLIE 8888 DELTA ${PAN} ECHO 8888,10.00,Other,${PAN}`,
      // A store number and an amount beside a redacted number are not the card's digits.
      `09/15/2026,STORE #204 PAID 12.50 CARD ${PAN},12.50,Other,${PAN}`,
      `09/16/2026,STORE #204 CARD ${PAN} PAID 12.50,12.50,Other,${PAN}`,
    ].join('\n');
    const command = ['amex-csv', 'export.csv'];
    const refused = cli([], csv, command);
    expect(refused.code).toBe(1);
    expect(refused.written.size).toBe(0);
    expect(refused.stderr).toMatch(/line 2: its text would show more than the last four digits of a card number in this row/);
    const skipped = cli(['--skip-invalid'], csv, command);
    expect(skipped.code).toBe(0);
    const json = skipped.written.get('import.json')!;
    expect(JSON.parse(json)).toMatchObject({ rejectedCount: 1, cards: ['1881'] });
    expect((await preview(account.id, json)).body).toMatchObject({ rowCount: 2, newCount: 2 });
    const saved = await commit(account.id, json);
    expect(saved.status).toBe(201);
    expect(saved.body.batch).toMatchObject({ newCount: 2, rejectedCount: 1 });
    expect(repo.listCardTransactions().map((row) => row.description).sort()).toEqual([
      'STORE #204 CARD ***1881 PAID 12.50', 'STORE #204 PAID 12.50 CARD ***1881',
    ]);
    expectStoredPanHidden();
    expectPanHidden([json, refused.stderr, skipped.stderr, saved.text, logs.join('\n')].join('\n'));
  });

  it('refuses values too long to redact, and a hand-written payload carrying one, without echoing them', async () => {
    const account = createAccount({ issuer: 'samplebank', last4: '1881' });
    // The tool refuses an OFX value above its 20,000-character limit and writes nothing.
    const run = cli(['--skip-invalid'], ofxWith(`${'A'.repeat(19_990)}${PAN}`, 'MEMO'));
    expect(run.code).toBe(1);
    expect(run.written.size).toBe(0);
    expect(run.stderr).toMatch(/an OFX value is longer than 20000 characters/);
    expect(run.stderr).not.toMatch(/AAAA/);
    expectPanHidden(run.stdout + run.stderr);
    // The API never cuts text either: the whole value is scanned (422, paths only) or refused as too long (400).
    const valid = cli([], ofxText().replace('<ACCTID>4111111111111111', '<ACCTID>XXXX-1881')).written.get('import.json')!;
    for (const [tail, status] of [[PAN, 422], [` ${PAN.match(/.{4}/g)!.join(' ')}`, 422], ['', 400]] as const) {
      const body = JSON.parse(valid);
      body.rows[0].description = `${'A'.repeat(70_000)}${tail}`;
      for (const send of [preview, commit]) {
        const res = await send(account.id, body);
        expect(res.status).toBe(status);
        if (status === 422) expect(res.body).toEqual({ error: expect.any(String), paths: ['$.rows[0].description'] });
        else expect(res.body.issues).toEqual([{ path: '$.rows[0].description', message: 'must be at most 500 characters' }]);
        expect(res.text).not.toMatch(/AAAA/);
        expectPanHidden(res.text);
      }
    }
    expectPanHidden(logs.join('\n'));
    expect(repo.listCardTransactions()).toHaveLength(0);
    expect(repo.listCardImportBatches()).toHaveLength(0);
  });
});

describe('import boundary', () => {
  it('keeps the offline parsers out of the API: only the card statement converter CLI imports the card-import tool, and nothing in the API imports it', () => {
    const offenders: string[] = [];
    const converterImporters: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name);
        if (statSync(file).isDirectory()) walk(file);
        else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
          const text = readFileSync(file, 'utf8');
          if (/card-import-tool|cardImportTool/.test(text)) offenders.push(name);
          if (/\.\/cardStatementConvert\.js|\/cli\/cardStatementConvert/.test(text)) converterImporters.push(name);
        }
      }
    };
    walk(path.resolve(here, '..'));
    // The owner's offline converter of statement PDFs (cli/cardStatementConvert.ts) reads raw statements on the owner's
    // computer, as cli/checkingConvert.ts does for checking; only its own entry point runs it. The owner-only retail
    // wrapper (cli/retailConvertOwnerOnly.ts) imports none of the tool: it names the no-network preload's path, under
    // cardImportTool/testing/, for its converter child's --import, and its runtime imports are pinned in its own test.
    expect(offenders).toEqual(['cardStatementConvert.ts', 'retailConvertOwnerOnly.ts']);
    // Its one mention is that path, exactly, and it imports or requires no module of the tool.
    const wrapper = readFileSync(path.resolve(here, '..', 'cli', 'retailConvertOwnerOnly.ts'), 'utf8');
    expect(wrapper.split(/\r?\n/).filter((line) => /card-import-tool|cardImportTool/.test(line))).toEqual([
      "export const NO_NETWORK_PRELOAD = path.resolve(here, '..', '..', '..', '..', 'packages', 'shared', 'src', 'cardImportTool', 'testing', 'noNetwork.mjs');",
    ]);
    expect(wrapper).not.toMatch(/\b(?:import|require)\b[^;\n]*(?:card-import-tool|cardImportTool)/);
    expect(converterImporters).toEqual(['cardStatementConvertMain.ts']);
  });
});
