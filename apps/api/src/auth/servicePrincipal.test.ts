import { afterEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';

import { createApp } from '../app.js';
import { hashPassword } from './password.js';
import {
  SERVICE_E2E_ROUTES, SERVICE_IMPORT_ROUTES, SERVICE_READ_ROUTES, SERVICE_SCOPE_CODE, SERVICE_SELF_GUARDED_PREFIXES, serviceRefusal,
} from './serviceScope.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { listenLoopback } from '../testing/loopback.js';

const FAST = { ln: 10, r: 8, p: 1 };
const ORIGIN = 'http://127.0.0.1:5173';
const SERVICE_TOKEN = '5e'.repeat(32);
const ACCOUNT = { id: 'acct-1', name: 'Sample Brokerage', cashBalance: 1000, currency: 'USD', accountNumber: 'Z7418763' };

let repo: SqliteStateRepo | null = null;

afterEach(() => {
  repo?.close();
  repo = null;
});

/** The whole API with the service token, stored market data only (nothing is fetched), one user and one account. */
async function build(options: { e2e?: boolean } = {}): Promise<Express> {
  repo = new SqliteStateRepo({ file: ':memory:' });
  const { app, users } = createApp({
    repo,
    serviceToken: SERVICE_TOKEN,
    allowedOrigins: [ORIGIN],
    snapshotsEnabled: false,
    scryptParams: FAST,
    log: () => {},
    marketData: 'stored',
    ...(options.e2e ? { e2eIdentity: () => ({ runId: 'a'.repeat(32), disposableDataDir: true }) } : {}),
  });
  users.createUser('alex', await hashPassword('synthetic service password', FAST), new Date());
  repo.createAccount(ACCOUNT);
  return app;
}

type Methods = Record<string, (url: string) => request.Test>;
/** `method` `route` with the service token, and `body` as JSON when given. */
async function asService(app: Express, method: string, route: string, body?: unknown): Promise<request.Response> {
  const test = ((request(await listenLoopback(app)) as unknown as Methods)[method.toLowerCase()](route))
    .set('Authorization', `Bearer ${SERVICE_TOKEN}`);
  return body === undefined ? test : test.set('Content-Type', 'application/json').send(JSON.stringify(body));
}

describe('service token: what it may do', () => {
  it('reads every route on its list with GET and HEAD, and none of them refuses it', async () => {
    const app = await build();
    for (const template of SERVICE_READ_ROUTES) {
      const route = template.replace(':id', ACCOUNT.id).replace(':symbol', 'VTI');
      for (const method of ['GET', 'HEAD']) {
        const res = await asService(app, method, route);
        expect([401, 403], `${method} ${route}`).not.toContain(res.status);
      }
    }
  });

  it("answers the card sync agent's requests: health, its cards, their coverage, and import previews", async () => {
    const app = await build();
    expect((await asService(app, 'GET', '/health')).body).toMatchObject({ ok: true, accounts: 1 });
    expect((await asService(app, 'GET', '/card-accounts')).status).toBe(200);
    expect((await asService(app, 'GET', '/spending/coverage')).status).toBe(200);
    // An empty object is no card-import payload (400), but the import routes take the token.
    for (const route of SERVICE_IMPORT_ROUTES) {
      const res = await asService(app, 'POST', `${route}?cardAccountId=card-acct-missing`, {});
      expect([401, 403], route).not.toContain(res.status);
    }
  });
});

describe('service token: everything else is refused', () => {
  it('answers 403 principal-not-allowed before any route runs, and nothing changes', async () => {
    const app = await build();
    const id = ACCOUNT.id;
    const refused: [string, string, object?][] = [
      ['GET', '/export'], ['HEAD', '/export'], ['GET', '/EXPORT/'],
      ['POST', '/accounts', { id: 'script', name: 'Script', cashBalance: 0, currency: 'USD' }],
      ['PATCH', `/accounts/${id}`, { name: 'Renamed by a script' }], ['DELETE', `/accounts/${id}`],
      ['POST', `/accounts/${id}/transactions`, { symbol: 'VTI', date: '2026-01-02', quantity: 1, pricePerUnit: 1, currency: 'USD' }],
      ['POST', `/accounts/${id}/cash-events`, {}], ['POST', `/accounts/${id}/snapshot-positions`, {}],
      ['POST', `/accounts/${id}/nav-history/import`, {}],
      ['PATCH', '/transactions/t-1', {}], ['DELETE', '/transactions/t-1'], ['DELETE', '/cash-events/c-1'],
      ['PUT', '/manual-prices/VTI/2026-01-02', { price: 1 }], ['DELETE', '/manual-prices/VTI/2026-01-02'],
      ['POST', '/import/positions', {}], ['POST', '/import/activity-from-broker', {}], ['POST', '/import/from-broker', {}],
      ['POST', '/import/nav-statement/preview', {}],
      ['POST', '/card-accounts', {}], ['PATCH', '/card-transactions/c-1', {}], ['PUT', '/spending/benefits/marks', {}],
      ['POST', '/spending/rules', {}], ['PUT', '/spending/card-openings', {}], ['POST', '/spending/payment-reconciliation/decisions', {}],
      ['POST', '/metals/products/costco:300001/content', {}], ['POST', '/card-imports/preview/extra', {}], ['PUT', '/card-imports/commit', {}],
      ['GET', '/spending/rules/preview'], ['GET', '/metals/sources/roster/preview'], ['GET', `/accounts/${id}`],
      ['GET', `/accounts/${id}/no-such-route`], ['GET', '/spending/no-such-route'],
      ['POST', '/auth/login', { username: 'alex', password: 'synthetic service password' }], ['POST', '/auth/logout'],
      ['OPTIONS', '/accounts'],
    ];
    for (const [method, route, body] of refused) {
      const res = await asService(app, method, route, body);
      expect(res.status, `${method} ${route}`).toBe(403);
      if (method !== 'HEAD') expect(res.body, `${method} ${route}`).toEqual({ error: expect.any(String), code: SERVICE_SCOPE_CODE });
    }
    expect(repo!.listAccounts()).toEqual([expect.objectContaining({ id, name: ACCOUNT.name, accountNumber: ACCOUNT.accountNumber })]);
  });

  it('leaves card sync, Amazon, Costco, the attestation and the password re-check to answer it themselves, as before', async () => {
    const app = await build();
    for (const [method, route] of [['GET', '/card-sync/owner/state'], ['POST', '/card-sync/owner/pause'], ['POST', '/auth/reverify']]) {
      const res = await asService(app, method, route, method === 'POST' ? { password: 'synthetic service password' } : undefined);
      expect([res.status, res.body], `${method} ${route}`).toEqual([403, { error: 'credential-not-allowed' }]);
    }
    for (const route of ['/amazon/summary', '/amazon/orders', '/retail/costco/summary', '/retail/costco/receipts']) {
      const res = await asService(app, 'GET', route);
      expect([res.status, res.body], route).toEqual([403, { error: 'owner session required', code: 'principal-not-allowed' }]);
    }
    for (const method of ['POST', 'OPTIONS', 'DELETE']) {
      const res = await asService(app, method, '/release/attestation');
      expect([res.status, res.body], method).toEqual([404, { error: 'not-found' }]);
    }
    expect(SERVICE_SELF_GUARDED_PREFIXES).toEqual(['/card-sync', '/amazon', '/retail', '/release']);
  });

  it('may ask for a broker pull on a disposable e2e stack only, which is how the e2e runner proves pulls stay inside', async () => {
    const e2e = await build({ e2e: true });
    const pull = await asService(e2e, 'POST', '/import/activity-from-broker', {});
    expect([pull.status, pull.body]).toEqual([400, { error: 'broker is required' }]);
    expect((await asService(e2e, 'POST', '/import/positions', {})).body.code).toBe(SERVICE_SCOPE_CODE);
    expect((await asService(e2e, 'GET', '/export')).body.code).toBe(SERVICE_SCOPE_CODE);
    const own = await build();
    expect((await asService(own, 'POST', '/import/activity-from-broker', {})).body.code).toBe(SERVICE_SCOPE_CODE);
  });
});

describe('service scope: the lists', () => {
  it('matches paths as Express does, and methods exactly', () => {
    for (const path of ['/card-accounts', '/CARD-ACCOUNTS', '/card-accounts/', '/accounts/acct-1/history', '/release/attestation', '/auth/me']) {
      expect(serviceRefusal('GET', path), path).toBeNull();
      expect(serviceRefusal('HEAD', path), path).toBeNull();
    }
    for (const path of ['/card-imports/preview', '/Card-Imports/Commit/', '/card-imports/cutover-commit']) {
      expect(serviceRefusal('POST', path), path).toBeNull();
      expect(serviceRefusal('PUT', path)?.code, path).toBe(SERVICE_SCOPE_CODE);
    }
    for (const [method, path] of [['get', '/health'], ['GET', '/card-accounts/a/b'], ['GET', '/health/../export'], ['GET', '/'],
      ['GET', ''], ['POST', '/import/activity-from-broker'], ['GET', '/import/activity-from-broker'], ['POST', '/card-imports'],
      ['GET', '/accounts//history'], ['GET', '/card-syncx'], ['DELETE', '/card-transactions/c-1']]) {
      expect(serviceRefusal(method, path)?.code, `${method} ${path}`).toBe(SERVICE_SCOPE_CODE);
    }
    expect(serviceRefusal('POST', '/import/activity-from-broker', { disposableE2e: true })).toBeNull();
    for (const prefix of SERVICE_SELF_GUARDED_PREFIXES) {
      expect(serviceRefusal('POST', `${prefix}/anything`), prefix).toBeNull();
    }
  });

  it('never lists the export, investment imports, sign-in or an owner-only family', () => {
    for (const template of [...SERVICE_READ_ROUTES, ...SERVICE_IMPORT_ROUTES, ...SERVICE_E2E_ROUTES]) {
      expect(template).toMatch(/^\/[a-z-]+(?:\/(?:[a-z-]+|:[a-z]+))*$/);
      expect(template).not.toMatch(/^\/(?:export|auth\/(?:login|logout|reverify)|card-sync|amazon|retail|manual-prices\/:symbol\/)/);
    }
    expect([...SERVICE_IMPORT_ROUTES, ...SERVICE_E2E_ROUTES].filter((route) => route.startsWith('/import/'))).toEqual(['/import/activity-from-broker']);
  });
});
