import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { CARD_SPENDING_API_PATH_PREFIXES, HOLDR_API_PATH_PREFIXES } from '@finance-tracker/shared';

import { createApp } from './app.js';
import { hashPassword } from './auth/password.js';
import { DIRECT_API_PATH_PREFIXES } from './ingress/classify.js';
import { CARD_SPENDING_PREFIXES, isCardSpendingPath } from './routes/cardSpending.js';
import { SqliteStateRepo } from './services/sqliteStateRepo.js';
import { listenLoopback } from './testing/loopback.js';

/**
 * Route-enumeration guard: walks every route registered on the real app and
 * proves that it refuses a caller without a session. A route added later
 * without going through the auth gate fails here. Every route lives under a
 * prefix the web proxy forwards (shared HOLDR_API_PATH_PREFIXES) or under a
 * direct-only one it never forwards (ingress/classify.ts: the release attestation).
 */

const ORIGIN = 'http://localhost:5173';
const PUBLIC_ROUTES = ['GET /auth/me', 'GET /health', 'POST /auth/login', 'POST /auth/logout'];
/** Every card spending route createApp mounts (Phase 3 imports and accounts, Phase 4 reads, the strict cutover's guarded import). */
const CARD_ROUTES = [
  'DELETE /metals/lots/:key/bullion',
  'DELETE /metals/lots/:key/content',
  'DELETE /metals/products/:ref/bullion',
  'DELETE /metals/products/:ref/content',
  'DELETE /spending/benefits/marks',
  'DELETE /spending/card-openings/:id',
  'DELETE /spending/payment-reconciliation/decisions/:id',
  // STEP 9 integration (A16): main's #167 route joins the list in its sorted place, as the mounted routes are compared.
  'DELETE /spending/rules/:id',
  'GET /amazon/fresh',
  'GET /amazon/fresh/orders/:ref',
  'GET /amazon/items/:ref/image',
  'GET /amazon/orders',
  'GET /amazon/orders/:ref',
  'GET /amazon/spending',
  'GET /amazon/spending/taxonomy',
  'GET /amazon/summary',
  'GET /card-accounts',
  'GET /card-imports/cutover-capability',
  'GET /card-imports/cutover-receipt',
  'GET /card-transactions',
  'GET /card-transactions/:id',
  'GET /cash/owed',
  'GET /cash/payments',
  'GET /checking/accounts',
  'GET /checking/transactions',
  'GET /metals/answers',
  'GET /metals/card-check',
  'GET /metals/closes',
  'GET /metals/funding',
  'GET /metals/overview',
  'GET /metals/products',
  'GET /metals/purchases',
  'GET /metals/sales',
  'GET /metals/sources/roster/preview',
  'GET /metals/timeline',
  'GET /retail/costco/receipts',
  'GET /retail/costco/receipts/:ref',
  'GET /retail/costco/summary',
  'GET /spending/accounting',
  'GET /spending/balance-chains',
  'GET /spending/benefits',
  'GET /spending/card-openings',
  'GET /spending/compare',
  'GET /spending/coverage',
  'GET /spending/coverage/months',
  'GET /spending/forecast',
  'GET /spending/insights',
  'GET /spending/patterns',
  'GET /spending/payment-reconciliation',
  'GET /spending/payment-reconciliation/payments/:id',
  'GET /spending/rules/preview',
  'GET /spending/summary',
  'GET /spending/trend',
  'PATCH /card-accounts/:id',
  'PATCH /card-transactions/:id',
  'POST /card-accounts',
  'POST /card-imports/commit',
  'POST /card-imports/cutover-commit',
  'POST /card-imports/preview',
  'POST /metals/lots/:key/bullion',
  'POST /metals/lots/:key/content',
  'POST /metals/products/:ref/bullion',
  'POST /metals/products/:ref/content',
  'POST /spending/payment-reconciliation/decisions',
  'POST /spending/rules',
  'PUT /spending/benefits/cards/:id',
  'PUT /spending/benefits/marks',
  'PUT /spending/card-openings',
];
/** Every card sync route createApp mounts: E2a's owner API, and no device route (E2c adds those behind DeviceAdmission). */
const CARD_SYNC_ROUTES = [
  'GET /card-sync/owner/bindings',
  'GET /card-sync/owner/bindings/:bindingId/devices',
  'GET /card-sync/owner/devices',
  'GET /card-sync/owner/observation-sets',
  'GET /card-sync/owner/observation-sets/:observationSetId',
  'GET /card-sync/owner/pairings',
  'GET /card-sync/owner/plans/:previewId/effects',
  'GET /card-sync/owner/runs',
  'GET /card-sync/owner/runs/:runId',
  'GET /card-sync/owner/runs/:runId/payload',
  'GET /card-sync/owner/state',
  'GET /card-sync/owner/transactions/:transactionId/sources',
  'POST /card-sync/owner/bindings',
  'POST /card-sync/owner/bindings/:bindingId/auto-sync',
  'POST /card-sync/owner/bindings/:bindingId/confirm',
  'POST /card-sync/owner/bindings/:bindingId/retire',
  'POST /card-sync/owner/devices/:deviceId/regrant',
  'POST /card-sync/owner/devices/:deviceId/revoke',
  'POST /card-sync/owner/identities/:identityId/detach',
  'POST /card-sync/owner/identities/:identityId/repoint',
  'POST /card-sync/owner/issuers/:issuer/disable',
  'POST /card-sync/owner/issuers/:issuer/enable',
  'POST /card-sync/owner/observation-sets/:observationSetId/decisions',
  'POST /card-sync/owner/observation-sets/:observationSetId/discard',
  'POST /card-sync/owner/observation-sets/:observationSetId/plan',
  'POST /card-sync/owner/pairings',
  'POST /card-sync/owner/pairings/:pairingId/approve',
  'POST /card-sync/owner/pairings/:pairingId/cancel',
  'POST /card-sync/owner/pairings/:pairingId/reject',
  'POST /card-sync/owner/pause',
  'POST /card-sync/owner/plans/:previewId/commit',
  'POST /card-sync/owner/resume',
  'POST /card-sync/owner/transactions/:transactionId/revert',
  'POST /card-sync/owner/transactions/:transactionId/unmerge',
];
const PARAM_SAMPLES: Record<string, string> = { id: 'route-test', symbol: 'AAPL', date: '2026-01-02' };

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  name?: string;
  handle?: { stack?: Layer[] };
  regexp?: RegExp & { fast_slash?: boolean };
  keys?: unknown[];
}

/** The literal mount path of an Express 4 router layer, e.g. /^\/quotes\/?(?=\/|$)/i -> "/quotes". */
function mountPath(layer: Layer): string {
  if (!layer.regexp || layer.regexp.fast_slash) return '';
  const match = /^\^((?:\\\/[\w-]+)+)\\\/\?\(\?=\\\/\|\$\)$/.exec(layer.regexp.source);
  if (!match || (layer.keys?.length ?? 0) > 0) throw new Error(`cannot read mount path from ${layer.regexp}`);
  return match[1].replace(/\\\//g, '/');
}

function listRoutes(stack: Layer[], prefix = ''): string[] {
  const routes: string[] = [];
  for (const layer of stack) {
    if (layer.route) {
      for (const [method, enabled] of Object.entries(layer.route.methods)) {
        if (enabled && method !== '_all') routes.push(`${method.toUpperCase()} ${prefix}${layer.route.path}`);
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      routes.push(...listRoutes(layer.handle.stack, prefix + mountPath(layer)));
    }
  }
  return routes;
}

function concrete(path: string): string {
  return path.replace(/:(\w+)/g, (_, name: string) => PARAM_SAMPLES[name] ?? 'x');
}

let repo: SqliteStateRepo;
let app: Express;
let routes: string[];

beforeAll(async () => {
  repo = new SqliteStateRepo({ file: ':memory:' });
  const built = createApp({
    repo,
    serviceToken: 'ab'.repeat(32),
    allowedOrigins: [ORIGIN],
    snapshotsEnabled: false,
    scryptParams: { ln: 10, r: 8, p: 1 },
    log: () => undefined,
  });
  app = built.app;
  built.users.createUser('alex', await hashPassword('correct horse battery', { ln: 10, r: 8, p: 1 }));
  routes = [...new Set(listRoutes((app as unknown as { _router: { stack: Layer[] } })._router.stack))].sort();
});

afterAll(() => {
  repo.close();
});

describe('route enumeration', () => {
  it('finds every router (sanity check on the walker)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(40);
    for (const expected of [
      'GET /accounts',
      'POST /accounts/:id/transactions',
      'GET /accounts/:id/history',
      'POST /import/positions',
      'POST /import/activity-from-broker',
      'POST /import/nav-statement/preview',
      'GET /portfolio/history',
      'PUT /manual-prices/:symbol/:date',
      'DELETE /cash-events/:id',
      'GET /export',
      'GET /quotes/',
    ]) {
      expect(routes).toContain(expected);
    }
  });

  it('exposes exactly the four public routes', () => {
    expect(routes.filter((route) => PUBLIC_ROUTES.includes(route)).sort()).toEqual([...PUBLIC_ROUTES].sort());
  });

  it('answers 401 on every other route without a session, even with valid CSRF headers', async () => {
    const leaks: string[] = [];
    for (const route of routes.filter((r) => !PUBLIC_ROUTES.includes(r))) {
      const [method, path] = route.split(' ');
      const res = await request(await listenLoopback(app))[method.toLowerCase() as 'get']( concrete(path))
        .set('Origin', ORIGIN)
        .set('X-Holdr-Request', '1')
        .send(method === 'GET' ? undefined : {});
      if (res.status !== 401) leaks.push(`${route} -> ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });

  it('answers 401 on every protected GET for HEAD too', async () => {
    const leaks: string[] = [];
    for (const route of routes.filter((r) => r.startsWith('GET ') && !PUBLIC_ROUTES.includes(r))) {
      const res = await request(await listenLoopback(app)).head(concrete(route.slice(4)));
      if (res.status !== 401) leaks.push(`${route} -> ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });

  it('rejects every state-changing route without an Origin before anything else runs', async () => {
    const leaks: string[] = [];
    for (const route of routes.filter((r) => !r.startsWith('GET '))) {
      const [method, path] = route.split(' ');
      const res = await request(await listenLoopback(app))[method.toLowerCase() as 'post'](concrete(path)).set('X-Holdr-Request', '1').send({});
      if (res.status !== 403) leaks.push(`${route} -> ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });

  it('mounts exactly the card spending routes under the card spending prefixes', () => {
    expect(routes.filter((route) => isCardSpendingPath(route.split(' ')[1]))).toEqual(CARD_ROUTES);
  });

  it('answers 401 on every card spending route without a session, with or without CSRF headers', async () => {
    const leaks: string[] = [];
    for (const route of CARD_ROUTES) {
      const [method, path] = route.split(' ');
      for (const csrf of [true, false]) {
        let test = request(await listenLoopback(app))[method.toLowerCase() as 'get'](concrete(path));
        if (csrf || method === 'GET') test = test.set('Origin', ORIGIN).set('X-Holdr-Request', '1');
        const res = await test.send(method === 'GET' ? undefined : {});
        // Without the CSRF headers a mutation stops at csrfGuard (403), before requireAuth.
        const expected = csrf || method === 'GET' ? 401 : 403;
        if (res.status !== expected) leaks.push(`${route}${csrf ? '' : ' (no CSRF headers)'} -> ${res.status}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('answers JSON 404 for unknown non-API paths without touching authentication', async () => {
    const res = await request(await listenLoopback(app)).get('/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not-found' });
    expect(res.headers['x-holdr-error']).toBe('not-found');
    expect((await request(await listenLoopback(app)).get('/accounts/not/a/route')).status).toBe(401);
  });

  it('registers routes only under the prefixes the web proxy forwards, and the direct-only ones it never forwards', () => {
    const prefixes = new Set(routes.map((route) => route.split(' ')[1].split('/')[1]));
    expect([...prefixes].sort()).toEqual([...HOLDR_API_PATH_PREFIXES, ...DIRECT_API_PATH_PREFIXES].sort());
    for (const prefix of DIRECT_API_PATH_PREFIXES) expect(HOLDR_API_PATH_PREFIXES).not.toContain(prefix);
  });

  it('serves exactly the release attestation under the direct-only prefixes (direct loopback callers only)', () => {
    expect(routes.filter((route) => DIRECT_API_PATH_PREFIXES.includes(route.split(' ')[1].split('/')[1])))
      .toEqual(['GET /release/attestation']);
  });

  it('mounts exactly the card sync owner routes under /card-sync, and no device route', () => {
    expect(routes.filter((route) => route.split(' ')[1].startsWith('/card-sync'))).toEqual(CARD_SYNC_ROUTES);
    expect(HOLDR_API_PATH_PREFIXES).toContain('card-sync');
  });

  it('answers 401 on every card sync route without a session, before reading a body or the database', async () => {
    const leaks: string[] = [];
    for (const route of CARD_SYNC_ROUTES) {
      const [method, path] = route.split(' ');
      const res = await request(await listenLoopback(app))[method.toLowerCase() as 'get'](concrete(path))
        .set('Origin', ORIGIN).set('X-Holdr-Request', '1').set('Content-Type', 'text/plain').send(method === 'GET' ? undefined : 'not json');
      if (res.status !== 401) leaks.push(`${route} -> ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });

  it('takes the card spending prefixes from the same shared list', () => {
    expect([...CARD_SPENDING_PREFIXES]).toEqual(CARD_SPENDING_API_PATH_PREFIXES.map((prefix) => `/${prefix}`));
    for (const prefix of CARD_SPENDING_API_PATH_PREFIXES) expect(HOLDR_API_PATH_PREFIXES).toContain(prefix);
  });
});
