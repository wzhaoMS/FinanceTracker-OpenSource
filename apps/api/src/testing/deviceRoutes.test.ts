import http from 'node:http';
import path from 'node:path';
import rawExpress, { type ErrorRequestHandler, type Express, type RequestHandler, type Response } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { appDeviceMiddlewareStage, createApp } from '../app.js';
import { hashPassword } from '../auth/password.js';
import { unwiredAuthorizationGateService } from '../control/authorizationChange.js';
import { shortDir } from '../control/testDirs.js';
import { admitDeviceRequest, type DeviceAdmission } from '../ingress/deviceAdmission.js';
import { createDeviceRouter, deviceRoute, type DeviceRoute } from '../ingress/deviceRouter.js';
import { resolveIngressConfig } from '../ingress/config.js';
import { closeServers } from '../ingress/fixtures.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { mountCardSpendingRoutes } from '../routes/cardSpending.js';
import { CardSyncCursorCodec } from '../routes/cardSync/cursor.js';
import { createCardSyncRouter } from '../routes/cardSync/owner.js';
import { assertDeviceRoutesGuarded } from './deviceRoutes.js';
import { createVerifiedApp, createVerifiedRouter } from '../ingress/expressIdentity.js';
import { createRequestListener } from '../ingress/server.js';
import { rawRequest, releaseFixture, SERVE_HEADERS } from '../ingress/fixtures.js';

const express = Object.assign(() => createVerifiedApp(), { Router: createVerifiedRouter });

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const handle: DeviceRoute['handle'] = (_req, res) => { res.json({ ok: true }); };
const bare: RequestHandler = (_req, res) => { res.json({ ok: true }); };
// Tests that call admission() or admissionFixture() listen on a Unix-domain socket: macOS and Linux only. On Windows
// Node listens on a path only as a named pipe (\\.\pipe\…), and this listen fails with EACCES.
const posixOnly = it.skipIf(process.platform === 'win32');

async function admissionFixture() {
  const fixture = shortDir();
  cleanups.push(fixture.cleanup);
  const socketPath = path.join(fixture.dir, 's');
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(`${socketPath}`, () => { server.off('error', reject); resolve(); });
  });
  cleanups.push(() => closeServers([server]));
  const env = {
    NODE_ENV: 'production', HOLDR_WEB_MODE: 'dist', HOLDR_PUBLIC_ORIGIN: 'https://holdr.test',
    HOLDR_SERVE_SOCKET: socketPath, HOLDR_WEB_RELEASE_DIR: fixture.dir, HOLDR_WEB_RELEASE_DIGEST: 'a'.repeat(64),
    HOLDR_DATA_DIR: path.join(fixture.dir, 'data'), HOLDR_CONTROL_DIR: path.join(fixture.dir, 'control'), HOLDR_DEVICE_API: '1',
  };
  const guard = admitDeviceRequest({
    config: resolveIngressConfig(env), env, serve: server, lifecycle: () => null,
    attestation: { refusal: () => null },
    source: { getCardSyncAuthorizationGeneration: () => `agn_${'a'.repeat(32)}` },
  });
  return { guard, server, socketPath };
}

async function admission(): Promise<DeviceAdmission> { return (await admissionFixture()).guard; }

describe('mounted device-route enumeration', () => {
  posixOnly('finds every exact protected method through nested mounts, including parameterized routes', async () => {
    const guard = await admission();
    const app = express();
    const nested = express.Router();
    nested.use(createDeviceRouter(guard, [
      { method: 'get', path: '/capabilities', handle },
      { method: 'post', path: '/runs/:runId/observations', handle },
      { method: 'options', path: '/capabilities', handle },
    ]));
    app.use('/card-sync', nested);
    app.post('/card-sync/owner/devices/:deviceId/revoke', bare);
    const expected = [
      { method: 'GET', path: '/card-sync/capabilities' },
      { method: 'POST', path: '/card-sync/runs/:runId/observations' },
      { method: 'OPTIONS', path: '/card-sync/capabilities' },
      { method: 'OPTIONS', path: '/card-sync/runs/:runId/observations' },
    ];
    expect(assertDeviceRoutesGuarded(app, { expected })).toEqual(expected);
  });

  it('the current mounted app has no device routes and needs no fake production admission', () => {
    const repo = new SqliteStateRepo({ file: ':memory:' });
    try {
      const { app } = createApp({ repo, serviceToken: 'be'.repeat(32), snapshotsEnabled: false, allowedOrigins: [] });
      expect(assertDeviceRoutesGuarded(app, { requireDeviceRoutes: false, expected: [] })).toEqual([]);
    } finally { repo.close(); }
  });

  it.each([
    '/card-sync', '/card-sync/capabilities', '/CARD-SYNC/capabilities', '/card-sync/ownerish',
    '/card-sync/owners/revoke', '/card-sync/:scope/revoke', '/:namespace/capabilities',
  ])('fails on unguarded %s, including case and prefix lookalikes', (route) => {
    const app = express();
    app.get(route, bare);
    expect(() => assertDeviceRoutesGuarded(app)).toThrow('unguarded');
  });

  it('owner routes are exempt only at the complete owner path segment', () => {
    const app = express();
    app.post('/card-sync/owner/devices/:id/revoke', bare);
    app.get('/card-sync/owner', bare);
    expect(assertDeviceRoutesGuarded(app, { requireDeviceRoutes: false })).toEqual([]);
  });

  posixOnly('a guarded sibling or duplicate method cannot bless an unguarded route', async () => {
    const guard = await admission();
    const app = express();
    app.get('/card-sync/capabilities', deviceRoute(guard, handle));
    app.post('/card-sync/capabilities', bare);
    expect(() => assertDeviceRoutesGuarded(app)).toThrow('unguarded');
    const duplicate = express();
    duplicate.get('/card-sync/capabilities', deviceRoute(guard, handle));
    duplicate.get('/card-sync/capabilities', bare);
    expect(() => assertDeviceRoutesGuarded(duplicate)).toThrow('unguarded');
  });

  posixOnly('a wrapper after a reachable handler is not protection', async () => {
    const guard = await admission();
    const app = express();
    app.get('/card-sync/capabilities', bare, deviceRoute(guard, handle));
    expect(() => assertDeviceRoutesGuarded(app)).toThrow('unguarded');
  });

  it.each(['head', 'options'] as const)('rejects an unguarded explicit %s route', (method) => {
    const app = express();
    app[method]('/card-sync/capabilities', bare);
    expect(() => assertDeviceRoutesGuarded(app)).toThrow('unguarded');
  });

  it('neither a function name nor copied marker properties can forge a guarded route', () => {
    const app = express();
    const forged = Object.assign(function admitDeviceRequest(_req: unknown, res: Response) { res.json({ ok: true }); }, {
      admission: true, guarded: true,
    });
    app.get('/card-sync/capabilities', forged);
    expect(() => assertDeviceRoutesGuarded(app)).toThrow('unguarded');
  });

  it('finds an unguarded route under a nested mounted router', () => {
    const app = express();
    const root = express.Router();
    const child = express.Router();
    child.post('/commit', bare);
    root.use('/plans', child);
    app.use('/card-sync', root);
    expect(() => assertDeviceRoutesGuarded(app)).toThrow('unguarded /card-sync/plans/commit');
  });

  it.each([/^\/card-sync/, '/:namespace'])('refuses an unknown/non-literal mount %s rather than ignoring it', (mount) => {
    const app = express();
    const router = express.Router();
    router.get('/capabilities', bare);
    app.use(mount, router);
    expect(() => assertDeviceRoutesGuarded(app)).toThrow('non-literal or unknown mount');
  });

  it('refuses hidden sub-apps', () => {
    const app = express();
    const child = express();
    child.get('/capabilities', bare);
    app.use('/card-sync', child);
    expect(() => assertDeviceRoutesGuarded(app)).toThrow('unverified middleware');
  });

  posixOnly('refuses pre-admission parameter work', async () => {
    const guard = await admission();
    const router = createDeviceRouter(guard, [{ method: 'post', path: '/runs/:runId/commit', handle }]);
    router.param('runId', (_req, _res, next) => next());
    const app = express();
    app.use('/card-sync', router);
    expect(() => assertDeviceRoutesGuarded(app)).toThrow('parameter callback before');
  });

  posixOnly('refuses a terminal or credential middleware mounted ahead of device admission', async () => {
    const guard = await admission();
    const app = express();
    app.use('/card-sync', bare);
    app.use('/card-sync', createDeviceRouter(guard, [{ method: 'get', path: '/capabilities', handle }]));
    expect(() => assertDeviceRoutesGuarded(app)).toThrow('middleware before admission');
  });

  it('refuses route patterns and unknown route representations', () => {
    const app = express();
    app.get('/card-sync/*', bare);
    expect(() => assertDeviceRoutesGuarded(app)).toThrow('unknown route path');
    const regexp = express();
    regexp.get(/^\/card-sync\/.*/, bare);
    expect(() => assertDeviceRoutesGuarded(regexp)).toThrow('unknown route path');
  });

  posixOnly('a missing mount or a changed route catalog cannot silently produce a vacuous pass', async () => {
    const empty = express();
    expect(() => assertDeviceRoutesGuarded(empty)).toThrow('no device routes enumerated');
    const guard = await admission();
    const app = express();
    app.use('/card-sync', createDeviceRouter(guard, [{ method: 'get', path: '/capabilities', handle }]));
    expect(() => assertDeviceRoutesGuarded(app, { expected: [] })).toThrow('device route catalog differs');
  });

  posixOnly('requires an explicit guarded OPTIONS rather than trusting Express automatic OPTIONS', async () => {
    const guard = await admission();
    const app = express();
    app.get('/card-sync/capabilities', deviceRoute(guard, handle));
    expect(() => assertDeviceRoutesGuarded(app)).toThrow('implicit OPTIONS without admission');
  });

  it('refuses cycles rather than recursing indefinitely', () => {
    const app = express();
    const router = express.Router();
    router.use('/again', router);
    app.use('/card-sync', router);
    expect(() => assertDeviceRoutesGuarded(app)).toThrow('cyclic router');
  });

  posixOnly.each(['/', '/runs/*', '/runs/:id?', '/runs/:id([a-z]+)', '/runs//commit', '/runs?x=1'])('the factory rejects non-exact declarations %s', async (route) => {
    const guard = await admission();
    expect(() => createDeviceRouter(guard, [{ method: 'get', path: route, handle }])).toThrow('E0I_DEVICE_ROUTE');
  });

  posixOnly('the factory rejects duplicate declarations', async () => {
    const guard = await admission();
    const route: DeviceRoute = { method: 'get', path: '/capabilities', handle };
    expect(() => createDeviceRouter(guard, [route, route])).toThrow('E0I_DEVICE_ROUTE');
  });
});

describe.skipIf(process.platform === 'win32')('D r1 reviewer bypass applications, exact nonempty catalogs and live Unix requests', () => {
  const catalog = (path: string) => [{ method: 'GET', path }, { method: 'OPTIONS', path }];
  type Bypass = {
    name: string;
    build: (app: Express, guard: DeviceAdmission) => void;
    probes: Array<[string, string, number]>;
    expected?: ReturnType<typeof catalog>;
  };
  const bypasses: Bypass[] = [
    { name: 'mixed first segment', build: (app) => { app.get('/card-:namespace/check', bare); },
      probes: [['GET', '/card-sync/check', 200], ['HEAD', '/card-sync/check', 200]] },
    { name: 'mixed segment route.all', build: (app) => { app.route('/card-:namespace/check').all(bare); },
      probes: [['POST', '/card-sync/check', 200], ['OPTIONS', '/card-sync/check', 200]] },
    { name: 'root middleware', build: (app) => { app.use(bare); }, probes: [['GET', '/card-sync/check', 200]] },
    { name: 'nested root middleware', build: (app) => { const child = express.Router(); child.use(bare); app.use(child); },
      probes: [['GET', '/card-sync/check', 200]] },
    { name: 'opaque forwarding closure', build: (app) => {
      const child = rawExpress(); child.get('/card-sync/check', bare); app.use((req, res, next) => child(req, res, next));
    }, probes: [['GET', '/card-sync/check', 200]] },
    { name: 'forged router stack', build: (app) => { app.use('/card-sync', Object.assign(bare, { stack: [] })); },
      probes: [['GET', '/card-sync/check', 200]] },
    { name: 'root error handling', build: (app) => {
      app.use((_req, _res, next) => next(Error('synthetic')));
      app.use(((_err, req, res, next) => bare(req, res, next)) as ErrorRequestHandler);
    }, probes: [['GET', '/card-sync/check', 200]] },
    { name: 'terminal fallback', build: (app) => { app.get('/ordinary', bare); app.use(bare); },
      probes: [['GET', '/card-sync/check', 200]] },
    ...['_id', '0'].map((name): Bypass => ({
      name: `parameter ${name}`, build: (app, guard) => {
        app.param(name, bare);
        app.get(`/card-sync/:${name}`, deviceRoute(guard, handle));
        app.options(`/card-sync/:${name}`, deviceRoute(guard, handle));
      }, probes: [['GET', '/card-sync/check', 200]], expected: catalog(`/card-sync/:${name}`),
    })),
    { name: 'OPTIONS in later sibling', build: (app, guard) => {
      const reads = express.Router();
      const preflight = express.Router();
      reads.get('/check', deviceRoute(guard, handle));
      preflight.options('/check', deviceRoute(guard, handle));
      app.use('/card-sync', reads);
      app.use('/card-sync', preflight);
    }, probes: [['GET', '/card-sync/check', 409], ['HEAD', '/card-sync/check', 409], ['OPTIONS', '/card-sync/check', 200]],
    expected: catalog('/card-sync/check') },
    { name: 'OPTIONS matcher mismatch', build: (app, guard) => {
      const strict = express.Router({ caseSensitive: true, strict: true });
      strict.options('/card-sync/check', deviceRoute(guard, handle));
      app.use(strict);
      app.get('/card-sync/check', deviceRoute(guard, handle));
    }, probes: [['OPTIONS', '/card-sync/check', 409], ['OPTIONS', '/card-sync/CHECK', 200], ['OPTIONS', '/card-sync/check/', 200]],
    expected: catalog('/card-sync/check') },
  ];

  it.each(bypasses)('rejects $name while the unsafe live app demonstrates the original bypass', async (bypass) => {
    const f = await admissionFixture();
    const app = express();
    bypass.build(app, f.guard);
    if (!bypass.expected) app.use('/card-sync', createDeviceRouter(f.guard, [{ method: 'get', path: '/guarded', handle }]));
    const expected = bypass.expected ?? catalog('/card-sync/guarded');
    expect(expected.length).toBeGreaterThan(0);
    expect(() => assertDeviceRoutesGuarded(app, { expected })).toThrow('device route admission:');
    f.server.on('request', createRequestListener(app, {
      mode: 'dist', listener: 'ingress', publicOrigin: 'https://holdr.test', socketPath: f.socketPath, admission: { refusal: () => null },
    }));
    for (const [method, target, status] of bypass.probes) {
      expect((await rawRequest(f.socketPath, method, target, SERVE_HEADERS)).status).toBe(status);
    }
    const original = rawExpress();
    bypass.build(original, f.guard);
    if (!bypass.expected) original.use('/card-sync', createDeviceRouter(f.guard, [{ method: 'get', path: '/guarded', handle }]));
    expect(() => assertDeviceRoutesGuarded(original, { expected })).toThrow('unverified Express router identity');
  });

  it('rejects a mixed-path bypass inserted at the real app pre-identify position', async () => {
    const f = await admissionFixture();
    const repo = new SqliteStateRepo({ file: ':memory:' });
    cleanups.push(() => repo.close());
    const { app, auth } = createApp({ repo, serviceToken: 'be'.repeat(32), snapshotsEnabled: false, allowedOrigins: [] });
    const insert = (router: ReturnType<typeof express.Router>) => {
      app.use(router);
      const stack = (app as unknown as { _router: { stack: Array<{ handle: unknown }> } })._router.stack;
      const layer = stack.pop()!;
      stack.splice(stack.findIndex((entry) => entry.handle === auth.identify), 0, layer);
    };
    const unsafe = express.Router();
    unsafe.get('/card-:namespace/check', bare);
    insert(unsafe);
    const guarded = express.Router();
    guarded.use('/card-sync', createDeviceRouter(f.guard, [{ method: 'get', path: '/guarded', handle }]));
    insert(guarded);
    expect(() => assertDeviceRoutesGuarded(app, { expected: catalog('/card-sync/guarded') })).toThrow('unknown route path');
    f.server.on('request', createRequestListener(app, {
      mode: 'dist', listener: 'ingress', publicOrigin: 'https://holdr.test', socketPath: f.socketPath, admission: { refusal: () => null },
    }));
    expect((await rawRequest(f.socketPath, 'GET', '/card-sync/check', SERVE_HEADERS)).status).toBe(200);
    expect((await rawRequest(f.socketPath, 'GET', '/card-sync/guarded', SERVE_HEADERS)).status).toBe(409);
  });

  it('rejects a substituted dispatch on a real factory router', async () => {
    const guard = await admission();
    const app = express();
    const router = createDeviceRouter(guard, [{ method: 'get', path: '/check', handle }]);
    Object.assign(router, { handle: bare });
    app.use('/card-sync', router);
    expect(() => assertDeviceRoutesGuarded(app, { expected: catalog('/card-sync/check') })).toThrow('unverified middleware');
  });

  it('requires compatible OPTIONS matchers even if one real router changes options between declarations', async () => {
    const guard = await admission();
    const app = express();
    const router = express.Router({ caseSensitive: true, strict: true });
    router.options('/check', deviceRoute(guard, handle));
    Object.assign(router, { caseSensitive: false, strict: false });
    router.get('/check', deviceRoute(guard, handle));
    app.use('/card-sync', router);
    expect(() => assertDeviceRoutesGuarded(app, { expected: catalog('/card-sync/check') })).toThrow('implicit OPTIONS');
  });
});

describe.skipIf(process.platform === 'win32')('D r2 mount-context admission regressions', () => {
  const catalog = [
    { method: 'GET', path: '/card-sync/guarded' },
    { method: 'OPTIONS', path: '/card-sync/guarded' },
  ];

  it.each(['/card-sync', '/CARD-SYNC', '/card-sync/plans'])('rejects the genuine card-spending factory nested under %s', async (mount) => {
    const f = await admissionFixture();
    const repo = new SqliteStateRepo({ file: ':memory:' });
    cleanups.push(() => repo.close());
    const app = express();
    const container = express.Router();
    let unguardedCalls = 0;
    mountCardSpendingRoutes(container, { repo, requireAuth: (req, res) => {
      unguardedCalls++;
      res.json({ credential: req.headers.authorization });
    } });
    app.use(mount, container);
    app.use('/card-sync', createDeviceRouter(f.guard, [{ method: 'get', path: '/guarded', handle }]));
    expect(() => assertDeviceRoutesGuarded(app, { expected: catalog })).toThrow('unverified middleware before admission');
    f.server.on('request', createRequestListener(app, {
      mode: 'dist', listener: 'ingress', publicOrigin: 'https://holdr.test', socketPath: f.socketPath, admission: { refusal: () => null },
    }));
    const canary = 'HoldrDevice SYNTHETIC_R2_CANARY';
    const bypass = await rawRequest(f.socketPath, 'GET', `${mount}/card-accounts`, [...SERVE_HEADERS, ['Authorization', canary]]);
    expect(bypass.status).toBe(200);
    expect(bypass.body.toString()).toContain(canary);
    expect(unguardedCalls).toBe(1);
    expect((await rawRequest(f.socketPath, 'GET', '/card-sync/guarded', SERVE_HEADERS)).status).toBe(409);
    expect(unguardedCalls).toBe(1);
  });

  it.each(['', '/card-sync/owner'])('keeps the genuine card-spending non-device exit/exemption at %j', async (mount) => {
    const f = await admissionFixture();
    const repo = new SqliteStateRepo({ file: ':memory:' });
    cleanups.push(() => repo.close());
    const app = express();
    const container = express.Router();
    mountCardSpendingRoutes(container, { repo, requireAuth: bare });
    app.use(mount || '/', container);
    app.use('/card-sync', createDeviceRouter(f.guard, [{ method: 'get', path: '/guarded', handle }]));
    expect(assertDeviceRoutesGuarded(app, { expected: catalog })).toEqual(catalog);
    f.server.on('request', createRequestListener(app, {
      mode: 'dist', listener: 'ingress', publicOrigin: 'https://holdr.test', socketPath: f.socketPath, admission: { refusal: () => null },
    }));
    expect((await rawRequest(f.socketPath, 'GET', '/card-sync/guarded', SERVE_HEADERS)).status).toBe(409);
  });

  it('does not transfer an audited app-root middleware identity to a protected mount', async () => {
    const guard = await admission();
    const repo = new SqliteStateRepo({ file: ':memory:' });
    cleanups.push(() => repo.close());
    const { app, auth } = createApp({ repo, serviceToken: 'be'.repeat(32), snapshotsEnabled: false, allowedOrigins: [] });
    const stack = (app as unknown as { _router: { stack: Array<{ handle: RequestHandler }> } })._router.stack;
    const ambient = stack.find((layer) => appDeviceMiddlewareStage(app, layer.handle) === 'before-device')!;
    const insert = (mount: string, middleware: RequestHandler) => {
      app.use(mount, middleware);
      const layer = stack.pop()!;
      stack.splice(stack.findIndex((entry) => entry.handle === auth.identify), 0, layer);
    };
    insert('/card-sync', ambient.handle);
    insert('/card-sync', createDeviceRouter(guard, [{ method: 'get', path: '/guarded', handle }]));
    expect(() => assertDeviceRoutesGuarded(app, { expected: catalog })).toThrow('unverified middleware before admission');
  });
});

describe.skipIf(process.platform === 'win32')('D and E2a mounted-app integration', () => {
  const catalog = [
    { method: 'GET', path: '/card-sync/guarded' },
    { method: 'OPTIONS', path: '/card-sync/guarded' },
  ];

  it('keeps owner routing outside the device catalog without hiding a later-added device bypass', async () => {
    const f = await admissionFixture();
    const repo = new SqliteStateRepo({ file: ':memory:' });
    const release = releaseFixture();
    cleanups.push(() => repo.close(), release.cleanup);
    const { app, auth, users } = createApp({
      repo, serviceToken: 'be'.repeat(32), snapshotsEnabled: false, allowedOrigins: [],
      ingress: { mode: 'dist', publicOrigin: 'https://holdr.test', release: release.release, admission: { refusal: () => null } },
    });
    users.createUser('device-mount-owner', await hashPassword('synthetic-owner-password', { ln: 10, r: 8, p: 1 }));
    const stack = (app as unknown as { _router: { stack: Array<{ handle: unknown }> } })._router.stack;
    const beforeIdentify = () => {
      const layer = stack.pop()!;
      stack.splice(stack.findIndex((entry) => entry.handle === auth.identify), 0, layer);
    };
    app.use('/card-sync', createDeviceRouter(f.guard, [{ method: 'get', path: '/guarded', handle }]));
    beforeIdentify();
    expect(assertDeviceRoutesGuarded(app, { expected: catalog })).toEqual(catalog);
    f.server.on('request', createRequestListener(app, {
      mode: 'dist', listener: 'ingress', publicOrigin: 'https://holdr.test', socketPath: f.socketPath, admission: { refusal: () => null },
    }));
    expect((await rawRequest(f.socketPath, 'GET', '/card-sync/guarded', SERVE_HEADERS)).status).toBe(409);
    expect((await rawRequest(f.socketPath, 'GET', '/card-sync/owner/runs', SERVE_HEADERS)).status).toBe(401);
    app.get('/card-sync/bypass', bare);
    beforeIdentify();
    expect(() => assertDeviceRoutesGuarded(app, { expected: catalog })).toThrow('unguarded /card-sync/bypass');
    expect((await rawRequest(f.socketPath, 'GET', '/card-sync/bypass', SERVE_HEADERS)).status).toBe(200);
  });

  it('preserves the standalone E2a container but never exempts that whole namespace from device admission', async () => {
    const f = await admissionFixture();
    const repo = new SqliteStateRepo({ file: ':memory:' });
    cleanups.push(() => repo.close());
    const app = express();
    const gate = unwiredAuthorizationGateService({ databaseGeneration: () => repo.getCardSyncAuthorizationGeneration() });
    app.use('/card-sync', createDeviceRouter(f.guard, [{ method: 'get', path: '/guarded', handle }]));
    app.use('/card-sync', createCardSyncRouter({
      repo, requireRecentAuth: bare, cursors: new CardSyncCursorCodec('be'.repeat(32)), gate,
      authorization: {
        gate, currentSession: () => false, recentlyAuthenticated: () => false, holdrOrigin: null, deviceApi: 'disabled',
      },
    }));
    expect(() => assertDeviceRoutesGuarded(app, { expected: catalog })).toThrow('unverified middleware before admission');
    f.server.on('request', createRequestListener(app, {
      mode: 'dist', listener: 'ingress', publicOrigin: 'https://holdr.test', socketPath: f.socketPath, admission: { refusal: () => null },
    }));
    expect((await rawRequest(f.socketPath, 'GET', '/card-sync/guarded', SERVE_HEADERS)).status).toBe(409);
    const missing = await rawRequest(f.socketPath, 'GET', '/card-sync/unknown', SERVE_HEADERS);
    expect(missing.status).toBe(404);
    expect(missing.body.toString()).toBe('{"error":"not-found"}');
    const owner = await rawRequest(f.socketPath, 'GET', '/card-sync/owner/unknown', SERVE_HEADERS);
    expect(owner.status).toBe(403);
    expect(owner.body.toString()).toBe('{"error":"credential-not-allowed"}');
  });
});
