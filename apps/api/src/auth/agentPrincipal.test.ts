import { afterEach, describe, expect, it } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

import { createApp } from '../app.js';
import { AGENT_TOKEN_PREFIX } from './agentToken.js';
import { AGENT_READ_ONLY_CODE, AGENT_READ_ROUTES, AGENT_ROUTE_CODE } from './agentScope.js';
import { createAuth } from './http.js';
import { hashPassword } from './password.js';
import { cardSpendingAuth, SERVICE_CARD_SCOPE_CODE } from './serviceScope.js';
import { LocalAuthRepo } from '../services/localAuthRepo.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { listenLoopback } from '../testing/loopback.js';
import type { HoldrIngressFacts, IngressRefusal } from '../ingress/types.js';

const FAST = { ln: 10, r: 8, p: 1 };
const ORIGIN = 'http://127.0.0.1:5173';
const SERVICE_TOKEN = '5e'.repeat(32);
const AGENT_TOKEN = `${AGENT_TOKEN_PREFIX}${'a6'.repeat(32)}`;
const PASSWORD = 'synthetic agent password';
const ACCOUNT = { id: 'acct-1', name: 'Sample Brokerage', cashBalance: 1000, currency: 'USD', accountNumber: 'Z7418763' };

let repo: SqliteStateRepo | null = null;

afterEach(() => {
  repo?.close();
  repo = null;
});

/** The whole API with both tokens, stored market data only (nothing is fetched), one user and one account. */
async function build(options: { users?: string[]; agentToken?: string | null } = {}): Promise<Express> {
  repo = new SqliteStateRepo({ file: ':memory:' });
  const agentToken = options.agentToken === undefined ? AGENT_TOKEN : options.agentToken;
  const { app, users } = createApp({
    repo,
    serviceToken: SERVICE_TOKEN,
    ...(agentToken === null ? {} : { agentToken }),
    allowedOrigins: [ORIGIN],
    snapshotsEnabled: false,
    scryptParams: FAST,
    log: () => {},
    marketData: 'stored',
  });
  for (const username of options.users ?? ['alex']) users.createUser(username, await hashPassword(PASSWORD, FAST), new Date());
  repo.createAccount(ACCOUNT);
  return app;
}

const asAgent = <T extends request.Test>(test: T): T => test.set('Authorization', `Bearer ${AGENT_TOKEN}`);
const asService = <T extends request.Test>(test: T): T => test.set('Authorization', `Bearer ${SERVICE_TOKEN}`);
const fromBrowser = <T extends request.Test>(test: T): T => test.set('Origin', ORIGIN).set('X-Holdr-Request', '1');
type Methods = Record<string, (url: string) => request.Test>;

async function signIn(app: Express): Promise<string> {
  const res = await fromBrowser(request(await listenLoopback(app)).post('/auth/login'))
    .send({ username: 'alex', password: PASSWORD });
  expect(res.status).toBe(200);
  const cookies = res.headers['set-cookie'] as unknown as string[];
  return cookies.find((cookie) => cookie.startsWith('holdr_session='))!.split(';')[0];
}

describe('agent token: reads', () => {
  it('reads every reviewed route with GET and HEAD, none of them refuses it, and none shows a full account number', async () => {
    const app = await build();
    for (const template of AGENT_READ_ROUTES) {
      const route = template.replace(':id', ACCOUNT.id).replace(':symbol', 'VTI');
      const res = await asAgent(request(await listenLoopback(app)).get(route));
      expect([401, 403], `GET ${route}`).not.toContain(res.status);
      expect(res.status, `GET ${route}`).toBeLessThan(500);
      // A listed route without parameters exists: the app's "no route" answer would mean the list names a route that is gone.
      if (!template.includes(':')) expect(res.status === 404 && res.body?.error === 'not-found', `GET ${route} exists`).toBe(false);
      // However a route answers (res.json, or JSON text with res.send), the account number is masked (agentScope.ts).
      expect(res.text ?? '', `GET ${route}`).not.toContain(ACCOUNT.accountNumber.slice(1));
      expect([401, 403], `HEAD ${route}`).not.toContain((await asAgent(request(await listenLoopback(app)).head(route))).status);
    }
  });

  it('masks account numbers in JSON text a route sends itself, and refuses other text that holds digits', async () => {
    repo = new SqliteStateRepo({ file: ':memory:' });
    const auth = createAuth({ users: new LocalAuthRepo(repo), serviceToken: SERVICE_TOKEN, agentToken: AGENT_TOKEN, allowedOrigins: [] });
    const app = express();
    app.use(auth.identify);
    const body = { accounts: [{ name: 'Sample Brokerage', accountNumber: ACCOUNT.accountNumber }] };
    app.get('/spending/balance-chains', (_req, res) => { res.type('application/json').send(JSON.stringify(body)); });
    app.get('/spending/trend', (_req, res) => { res.type('application/json').send(Buffer.from(JSON.stringify(body))); });
    app.get('/spending/patterns', (_req, res) => { res.send(body); });
    app.get('/spending/compare', (_req, res) => { res.type('text/plain').send(`account ${ACCOUNT.accountNumber}`); });
    app.get('/spending/insights', (_req, res) => { res.sendStatus(200); });
    const get = async (route: string, as = asAgent) => as(request(await listenLoopback(app)).get(route));
    for (const route of ['/spending/balance-chains', '/spending/trend', '/spending/patterns']) {
      const res = await get(route);
      expect([res.status, JSON.parse(res.text)], route).toEqual([200, { accounts: [{ name: 'Sample Brokerage', accountNumber: '***8763' }] }]);
      expect(String(res.headers['content-type']), route).toMatch(/^application\/json/);
      expect(JSON.parse((await get(route, asService)).text), route).toEqual(body);
    }
    const text = await get('/spending/compare');
    expect([text.status, text.body]).toEqual([500, { error: 'Internal server error' }]);
    expect(text.text).not.toContain('7418763');
    expect((await get('/spending/compare', asService)).text).toBe(`account ${ACCOUNT.accountNumber}`);
    const status = await get('/spending/insights');
    expect([status.status, status.text]).toEqual([200, 'OK']);
  });

  it('sees investment account numbers masked to their last four characters; the service token and sessions see them', async () => {
    const app = await build();
    const agent = await asAgent(request(await listenLoopback(app)).get('/accounts'));
    expect(agent.status).toBe(200);
    expect(agent.body.accounts).toEqual([
      expect.objectContaining({ id: ACCOUNT.id, name: ACCOUNT.name, accountNumber: '***8763' }),
    ]);
    expect(JSON.stringify(agent.body)).not.toContain(ACCOUNT.accountNumber);
    const service = await asService(request(await listenLoopback(app)).get('/accounts'));
    expect(service.body.accounts[0].accountNumber).toBe(ACCOUNT.accountNumber);
    const cookie = await signIn(app);
    const session = await request(await listenLoopback(app)).get('/accounts').set('Cookie', cookie);
    expect(session.body.accounts[0].accountNumber).toBe(ACCOUNT.accountNumber);
  });

  it('reads before the first user exists, as the service token does', async () => {
    const app = await build({ users: [] });
    expect((await request(await listenLoopback(app)).get('/accounts')).status).toBe(503);
    expect((await asAgent(request(await listenLoopback(app)).get('/accounts'))).status).toBe(200);
  });
});

describe('agent token: everything else is refused', () => {
  it('answers 403 agent-read-only to every other method before any route runs, and nothing changes', async () => {
    const app = await build();
    const writes: [string, string, object?][] = [
      ['POST', '/accounts', { id: 'agent-made', name: 'Agent', cashBalance: 0, currency: 'USD' }],
      ['PATCH', `/accounts/${ACCOUNT.id}`, { name: 'Renamed by an agent' }],
      ['DELETE', `/accounts/${ACCOUNT.id}`],
      ['POST', `/accounts/${ACCOUNT.id}/transactions`, { type: 'buy', symbol: 'VTI', quantity: 1, price: 1, date: '2026-01-02' }],
      ['POST', `/accounts/${ACCOUNT.id}/cash-events`, {}],
      ['POST', `/accounts/${ACCOUNT.id}/snapshot-positions`, {}],
      ['PATCH', '/transactions/t-1', {}],
      ['DELETE', '/transactions/t-1'],
      ['POST', '/card-accounts', {}],
      ['PATCH', '/card-transactions/c-1', {}],
      ['POST', '/card-imports/preview', {}],
      ['POST', '/card-imports/commit', {}],
      ['POST', '/card-imports/cutover-commit', {}],
      ['PUT', '/spending/benefits/marks', {}],
      ['DELETE', '/spending/benefits/marks'],
      ['PUT', '/spending/benefits/cards/c-1', {}],
      ['POST', '/spending/rules', {}],
      ['PUT', '/spending/card-openings', {}],
      ['POST', '/spending/payment-reconciliation/decisions', {}],
      ['POST', '/metals/products/costco:300001/content', {}],
      ['PUT', '/manual-prices/VTI/2026-01-02', {}],
      ['POST', '/import/positions', {}],
      ['POST', '/auth/login', { username: 'alex', password: PASSWORD }],
      ['POST', '/auth/logout'],
      ['POST', '/auth/reverify', { password: PASSWORD }],
      ['POST', '/card-sync/owner/pause', {}],
      ['OPTIONS', '/accounts'],
    ];
    for (const [method, route, body] of writes) {
      const client = request(await listenLoopback(app)) as unknown as Methods;
      const test = fromBrowser(asAgent(client[method.toLowerCase()](route)));
      const res = body ? await test.send(body) : await test;
      expect(res.status, `${method} ${route}`).toBe(403);
      expect(res.body, `${method} ${route}`).toEqual({ error: expect.any(String), code: AGENT_READ_ONLY_CODE });
    }
    const accounts = (await asService(request(await listenLoopback(app)).get('/accounts'))).body.accounts;
    expect(accounts).toEqual([expect.objectContaining({ id: ACCOUNT.id, name: ACCOUNT.name })]);
  });

  it('answers 403 agent-route-not-allowed to reads outside its list, unknown paths included', async () => {
    const app = await build();
    const denied = [
      '/export', '/EXPORT', '/export/', '/auth/me', '/card-imports/cutover-capability', '/card-imports/cutover-receipt',
      '/card-sync/owner/state', '/card-sync/owner/runs', '/release/attestation', '/amazon/orders', '/amazon/summary',
      '/retail/costco/receipts', '/spending/rules/preview', '/metals/sources/roster/preview',
      `/accounts/${ACCOUNT.id}`, `/accounts/${ACCOUNT.id}/no-such-route`, '/spending/no-such-route',
    ];
    for (const route of denied) {
      const res = await asAgent(request(await listenLoopback(app)).get(route));
      expect(res.status, `GET ${route}`).toBe(403);
      expect(res.body, `GET ${route}`).toEqual({ error: expect.any(String), code: AGENT_ROUTE_CODE });
      expect((await asAgent(request(await listenLoopback(app)).head(route))).status, `HEAD ${route}`).toBe(403);
    }
    // Paths outside the API never reach a credential check: the web ingress answers them the same for everyone.
    const outside = await asAgent(request(await listenLoopback(app)).get('/no-such-route'));
    expect({ status: outside.status, body: outside.body }).toEqual({ status: 404, body: { error: 'not-found' } });
    expect((await request(await listenLoopback(app)).get('/no-such-route')).status).toBe(404);
  });

  it('is accepted only from direct loopback callers: through a proxy, or for another Host, it answers 401', async () => {
    const app = await build();
    const proxyHeaders = [
      'X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto', 'Forwarded', 'X-Real-IP', 'Via', 'Tailscale-User-Login',
    ];
    for (const header of proxyHeaders) {
      const res = await asAgent(request(await listenLoopback(app)).get('/accounts')).set(header, '192.0.2.10');
      expect(res.status, header).toBe(401);
    }
    const foreignHost = await asAgent(request(await listenLoopback(app)).get('/accounts')).set('Host', 'holdr.example.com');
    expect(foreignHost.status).toBe(401);
  });

  it('answers 401 to a wrong or malformed agent token, never falling back to the cookie', async () => {
    const app = await build();
    const cookie = await signIn(app);
    const wrong = [
      `Bearer ${AGENT_TOKEN_PREFIX}${'0'.repeat(64)}`, `Bearer ${AGENT_TOKEN.toUpperCase()}`,
      `Bearer ${AGENT_TOKEN.slice(AGENT_TOKEN_PREFIX.length)}`, `Bearer ${AGENT_TOKEN}0`, `Bearer ${AGENT_TOKEN} extra`,
      `Basic ${AGENT_TOKEN}`, AGENT_TOKEN, 'Bearer',
    ];
    for (const authorization of wrong) {
      const res = await request(await listenLoopback(app)).get('/accounts')
        .set('Cookie', cookie).set('Authorization', authorization);
      expect(res.status, authorization).toBe(401);
    }
    expect((await request(await listenLoopback(app)).get(`/accounts?token=${AGENT_TOKEN}`)).status).toBe(401);
    const asCookie = await request(await listenLoopback(app)).get('/accounts').set('Cookie', `holdr_session=${AGENT_TOKEN}`);
    expect(asCookie.status).toBe(401);
  });

  it('is unknown to an API started without an agent token', async () => {
    const app = await build({ agentToken: null });
    expect((await asAgent(request(await listenLoopback(app)).get('/accounts'))).status).toBe(401);
    expect((await asService(request(await listenLoopback(app)).get('/accounts'))).status).toBe(200);
  });

  it('must be holdr_agent_ and 64 hex characters, so it can never be the service token', () => {
    repo = new SqliteStateRepo({ file: ':memory:' });
    for (const agentToken of [SERVICE_TOKEN, `${AGENT_TOKEN}0`, AGENT_TOKEN.toUpperCase(), '']) {
      expect(() => createApp({ repo: repo!, serviceToken: SERVICE_TOKEN, agentToken, allowedOrigins: [], snapshotsEnabled: false }))
        .toThrow(/agent token/);
    }
  });

  it("is refused by card spending's own guard too, should anything let it through", async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.holdrAuth = { kind: 'agent' };
      next();
    });
    app.use(cardSpendingAuth((_req, _res, next) => next()));
    app.all('*', (_req, res) => {
      res.json({ reached: true });
    });
    expect((await request(await listenLoopback(app)).get('/card-transactions')).body).toEqual({ reached: true });
    const write = await request(await listenLoopback(app)).post('/card-imports/commit');
    expect(write.body).toMatchObject({ code: AGENT_READ_ONLY_CODE });
    const receipt = await request(await listenLoopback(app)).get('/card-imports/cutover-receipt');
    expect(receipt.body).toMatchObject({ code: AGENT_ROUTE_CODE });
  });
});

describe('agent token: the service token and sessions are unchanged', () => {
  it('the service token reads /auth/me, and is refused the export and writes as before (auth/serviceScope.ts)', async () => {
    const app = await build();
    expect((await asService(request(await listenLoopback(app)).get('/auth/me'))).body).toEqual({ service: true });
    const exported = await asService(request(await listenLoopback(app)).get('/export'));
    expect([exported.status, exported.body.code]).toEqual([403, SERVICE_CARD_SCOPE_CODE]);
    const created = await asService(request(await listenLoopback(app)).post('/accounts'))
      .send({ id: 'script', name: 'Script', cashBalance: 0, currency: 'USD' });
    expect([created.status, created.body.code]).toEqual([403, SERVICE_CARD_SCOPE_CODE]);
    const card = await asService(request(await listenLoopback(app)).post('/card-accounts')).send({});
    expect(card.status).toBe(403);
    expect(card.body.code).toBe(SERVICE_CARD_SCOPE_CODE);
  });

  it('a signed-in session still reads everything and writes with its CSRF header', async () => {
    const app = await build();
    const cookie = await signIn(app);
    const me = await request(await listenLoopback(app)).get('/auth/me').set('Cookie', cookie);
    expect(me.body).toEqual({ user: { username: 'alex' } });
    expect((await request(await listenLoopback(app)).get('/export').set('Cookie', cookie)).status).toBe(200);
    const created = await fromBrowser(request(await listenLoopback(app)).post('/accounts')).set('Cookie', cookie)
      .send({ id: 'owner-made', name: 'Owner', cashBalance: 0, currency: 'USD' });
    expect(created.status).toBe(201);
  });
});

describe('agent token behind the release ingress', () => {
  /** identify alone, as the dist ingress runs it: a direct loopback listener or the Tailscale Serve socket. */
  function ingressApp(refusal: IngressRefusal | null, profile: 'direct' | 'serve'): Express {
    repo?.close();
    repo = new SqliteStateRepo({ file: ':memory:' });
    const admission = { refusal: () => refusal };
    const auth = createAuth({
      users: new LocalAuthRepo(repo), serviceToken: SERVICE_TOKEN, agentToken: AGENT_TOKEN, allowedOrigins: [],
      ingress: { mode: 'dist', publicOrigin: 'https://holdr.example.ts.net', release: {} as never, admission },
    });
    const app = express();
    app.use((req, _res, next) => {
      const facts: HoldrIngressFacts = {
        listener: profile === 'direct' ? 'local' : 'ingress', mode: 'dist', profile, clientAddress: '127.0.0.1',
      };
      Object.defineProperty(req, 'holdrIngress', { value: Object.freeze(facts) });
      next();
    });
    app.use(auth.identify);
    app.all('/accounts', (req, res) => {
      res.json({ principal: req.holdrAuth?.kind ?? null });
    });
    return app;
  }

  it('waits for admission like the service token, then reads and only reads', async () => {
    for (const refusal of ['ingress-unverified', 'ingress-refused'] as const) {
      const closed = ingressApp(refusal, 'direct');
      const res = await asAgent(request(await listenLoopback(closed)).get('/accounts'));
      expect(res.status, refusal).toBe(503);
      expect(res.body, refusal).toEqual({ error: refusal });
    }
    const open = ingressApp(null, 'direct');
    expect((await asAgent(request(await listenLoopback(open)).get('/accounts'))).body).toEqual({ principal: 'agent' });
    const write = await asAgent(request(await listenLoopback(open)).post('/accounts'));
    expect(write.body).toMatchObject({ code: AGENT_READ_ONLY_CODE });
    expect((await asService(request(await listenLoopback(open)).get('/accounts'))).body).toEqual({ principal: 'service' });
    expect((await asService(request(await listenLoopback(open)).post('/accounts'))).body).toMatchObject({ code: SERVICE_CARD_SCOPE_CODE });
  });

  it('is refused on the Tailscale Serve socket, like the service token', async () => {
    const serve = ingressApp(null, 'serve');
    expect((await asAgent(request(await listenLoopback(serve)).get('/accounts'))).status).toBe(401);
    expect((await asService(request(await listenLoopback(serve)).get('/accounts'))).status).toBe(401);
  });
});
