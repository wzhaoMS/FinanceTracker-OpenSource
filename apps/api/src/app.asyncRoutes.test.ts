import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { Router, type ErrorRequestHandler, type Express, type NextFunction, type Response } from 'express';
import request from 'supertest';
import { types } from 'node:util';
import type { RequestListener } from 'node:http';

import { createApp } from './app.js';
import { asyncRoute, isAsyncRoute } from './asyncRoute.js';
import { hashPassword } from './auth/password.js';
import { SqliteStateRepo } from './services/sqliteStateRepo.js';
import { listenLoopback } from './testing/loopback.js';
import { createRequestListener } from './ingress/server.js';

/**
 * Express 4 ignores what a handler returns, so a handler that returns a
 * promise must be registered through asyncRoute, or its rejections stop the
 * API (E0 review, N2). This guard walks everything Express can call for the
 * real app (createApp), at any depth: middleware, error handlers, route
 * handlers and router.param() callbacks. It fails on
 *   - one that is an async function,
 *   - one that is not but returns a promise when a request reaches it, like
 *     `(req, res) => runImport(req, res)`: every route gets one signed-in
 *     request, and everything is watched (asyncRoute's never return one),
 *   - an Express app mounted inside another, whose handlers the walk cannot see.
 * A handler counts as reached once Express calls it, even if it then throws.
 * The real-app run also observes the default Node ingress dispatcher and
 * requires every registered middleware/error/route/parameter handler to run.
 * The last tests prove the checks flag what they should.
 */

const ORIGIN = 'http://127.0.0.1:5173';
const PASSWORD = 'correct horse battery';
const FAST = { ln: 10, r: 8, p: 1 };
const PARAM_SAMPLES: Record<string, string> = { id: 'route-test', symbol: 'AAPL', date: '2026-01-02' };
/** Every async route createApp serves; each must be asyncRoute's. */
const ASYNC_ROUTES = [
  'GET /accounts/:id/history',
  'GET /health',
  'GET /portfolio/history',
  'GET /portfolio/performance',
  'GET /quotes/',
  'GET /symbols/:symbol/history',
  'POST /accounts/:id/nav-history/import',
  'POST /auth/login',
  'POST /auth/reverify',
  'POST /card-sync/owner/bindings',
  'POST /card-sync/owner/bindings/:bindingId/auto-sync',
  'POST /card-sync/owner/bindings/:bindingId/confirm',
  'POST /card-sync/owner/bindings/:bindingId/retire',
  'POST /card-sync/owner/devices/:deviceId/regrant',
  'POST /card-sync/owner/devices/:deviceId/revoke',
  'POST /card-sync/owner/issuers/:issuer/disable',
  'POST /card-sync/owner/issuers/:issuer/enable',
  'POST /card-sync/owner/pairings',
  'POST /card-sync/owner/pairings/:pairingId/approve',
  'POST /card-sync/owner/pairings/:pairingId/cancel',
  'POST /card-sync/owner/pairings/:pairingId/reject',
  'POST /card-sync/owner/pause',
  'POST /card-sync/owner/resume',
  'POST /import/activity-from-broker',
  'POST /import/from-bookmarklet',
  'POST /import/from-broker',
  'POST /import/nav-statement/preview',
];

type Handle = ((...args: unknown[]) => unknown) & {
  stack?: Layer[];
  params?: Record<string, Handle[]>;
  handle?: unknown;
  set?: unknown;
};

/** What Express 4 keeps per registered handler (express/lib/router/layer.js). */
interface Layer {
  handle: Handle;
  name?: string;
  method?: string;
  route?: { path: string; stack: Layer[] };
  regexp?: RegExp & { fast_slash?: boolean };
  keys?: unknown[];
}

/** What Express 4 keeps per router (express/lib/router/index.js): its layers, and its router.param() callbacks by name. */
interface RouterState {
  stack: Layer[];
  params?: Record<string, Handle[]>;
}

interface Registered {
  /** "POST /auth/login", "param :id at /", or "middleware identify at /" for one that is neither. */
  where: string;
  /** Its layer; a parameter callback's stands for its slot in the router's params, so watching it replaces the callback. */
  layer: Layer;
  route?: { method: string; path: string };
  /** The parameter a router.param() callback is for. */
  param?: string;
}

function routerOf(app: Express): RouterState {
  const router = (app as unknown as { _router?: RouterState })._router;
  // Express 5 forwards rejections itself and keeps its router elsewhere: revisit asyncRoute and this guard then.
  if (!router) throw new Error('no Express 4 router on this app');
  return router;
}

/** The literal mount path of an Express 4 router layer, e.g. /^\/quotes\/?(?=\/|$)/i -> "/quotes". */
function mountPath(layer: Layer): string {
  if (!layer.regexp || layer.regexp.fast_slash) return '';
  const match = /^\^((?:\\\/[\w-]+)+)\\\/\?\(\?=\\\/\|\$\)$/.exec(layer.regexp.source);
  if (!match || (layer.keys?.length ?? 0) > 0) throw new Error(`cannot read mount path from ${layer.regexp}`);
  return match[1].replace(/\\\//g, '/');
}

/**
 * Everything Express can call for `router` and the routers mounted on it:
 * router.param() callbacks, middleware, error handlers and route handlers.
 */
function registered(router: RouterState, prefix = ''): Registered[] {
  const at = prefix || '/';
  // Express calls these from router.params[name] (not from a layer) when a route of this router has the parameter.
  const params = Object.entries(router.params ?? {}).flatMap(([name, callbacks]) => callbacks.map((_, index): Registered => ({
    where: `param :${name} at ${at}`,
    layer: {
      get handle() { return callbacks[index]; },
      set handle(handle: Handle) { callbacks[index] = handle; },
    },
    param: name,
  })));
  return [...params, ...router.stack.flatMap((layer): Registered[] => {
    if (layer.route) {
      const path = prefix + layer.route.path;
      return layer.route.stack.map((inner) => {
        const method = (inner.method ?? '_all').toUpperCase();
        return { where: `${method} ${path}`, layer: inner, route: { method, path } };
      });
    }
    const { stack, params: nested } = layer.handle;
    if (Array.isArray(stack)) return registered({ stack, params: nested }, prefix + mountPath(layer));
    return [{ where: `middleware ${layer.handle.name || 'anonymous'} at ${at}`, layer }];
  })];
}

/** Handlers that are async functions themselves (asyncRoute's are not: they return nothing). */
function asyncFunctions(app: Express): string[] {
  return registered(routerOf(app)).filter(({ layer }) => types.isAsyncFunction(layer.handle)).map(({ where }) => where);
}

/**
 * Express apps mounted inside another: app.use(app) registers a closure
 * (`mounted_app`) and router.use(app) the app itself, and neither exposes
 * the inner app's router to this walk.
 */
function opaque(app: Express): string[] {
  return registered(routerOf(app))
    .filter(({ layer }) => layer.handle.name === 'mounted_app' || (typeof layer.handle.handle === 'function' && typeof layer.handle.set === 'function'))
    .map(({ where }) => where);
}

function isThenable(value: unknown): boolean {
  return (typeof value === 'object' || typeof value === 'function') && value !== null
    && typeof (value as { then?: unknown }).then === 'function';
}

/**
 * Watches the handlers of `entries`: which ones ran, and which returned a
 * promise to Express. asyncRoute's never do; any other that does fails the guard.
 */
function watch(entries: readonly Registered[]): { ran: Set<Layer>; promised: Set<Layer> } {
  const ran = new Set<Layer>();
  const promised = new Set<Layer>();
  for (const { layer, param } of entries) {
    const original = layer.handle;
    const call = (self: unknown, args: unknown[]) => {
      // Reached as soon as Express calls it: a synchronous throw is Express's to answer, like any error.
      ran.add(layer);
      const result = original.apply(self, args);
      if (isThenable(result)) {
        promised.add(layer);
        // Not this test's to report; the guard fails on `promised` instead.
        (result as PromiseLike<unknown>).then(undefined, () => undefined);
      }
      return result;
    };
    // Express tells error handlers by their arity (four parameters), so the watcher keeps it;
    // it calls a parameter callback with the value and the parameter's name as well.
    layer.handle = param !== undefined
      ? function watched(this: unknown, req: unknown, res: unknown, next: unknown, value: unknown, name: unknown) {
        return call(this, [req, res, next, value, name]);
      }
      : original.length >= 4
        ? function watched(this: unknown, err: unknown, req: unknown, res: unknown, next: unknown) {
          return call(this, [err, req, res, next]);
        }
        : function watched(this: unknown, req: unknown, res: unknown, next: unknown) {
          return call(this, [req, res, next]);
        };
  }
  return { ran, promised };
}

function named(entries: readonly Registered[], layers: ReadonlySet<Layer>): string[] {
  return entries.filter((entry) => layers.has(entry.layer)).map((entry) => entry.where);
}

function concrete(path: string): string {
  return path.replace(/:(\w+)/g, (_, name: string) => PARAM_SAMPLES[name] ?? 'x');
}

describe('asyncRoute', () => {
  const failed: ErrorRequestHandler = (err, _req, res, _next) => {
    res.status(500).json({ failed: err instanceof Error ? err.message : String(err) });
  };
  const serve = (handler: express.RequestHandler) => express().get('/x', handler).get('/x', (_req, res) => {
    res.json({ carriedOn: true });
  }).use(failed);

  it('hands a rejection to the error handler', async () => {
    const app = serve(asyncRoute(async () => {
      await Promise.resolve();
      throw new Error('rejected');
    }));
    const res = await request(await listenLoopback(app)).get('/x');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ failed: 'rejected' });
  });

  it('hands a synchronous throw to the error handler', async () => {
    const app = serve(asyncRoute(() => {
      throw new Error('thrown');
    }));
    expect((await request(await listenLoopback(app)).get('/x')).body).toEqual({ failed: 'thrown' });
  });

  it.each([undefined, null, false, 0, '', 'route', 'router'])('a rejection with %j is still a failure, never "carry on"', async (reason) => {
    const app = serve(asyncRoute(() => Promise.reject(reason)));
    const res = await request(await listenLoopback(app)).get('/x');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ failed: 'a route handler failed without an error' });
  });

  it('leaves a handler that answers, or calls next itself, as it was', async () => {
    const answered = serve(asyncRoute(async (_req, res) => {
      await Promise.resolve();
      res.json({ answered: true });
    }));
    expect((await request(await listenLoopback(answered)).get('/x')).body).toEqual({ answered: true });
    const passed = serve(asyncRoute(async (_req, _res, next) => {
      await Promise.resolve();
      next();
    }));
    expect((await request(await listenLoopback(passed)).get('/x')).body).toEqual({ carriedOn: true });
    const refused = serve(asyncRoute(async (_req, _res, next) => {
      await Promise.resolve();
      next(new Error('its own'));
    }));
    expect((await request(await listenLoopback(refused)).get('/x')).body).toEqual({ failed: 'its own' });
  });

  it('marks only the handlers it makes', () => {
    const handler = async () => undefined;
    expect(isAsyncRoute(asyncRoute(handler))).toBe(true);
    expect(isAsyncRoute(handler)).toBe(false);
    expect(isAsyncRoute(() => undefined)).toBe(false);
  });
});

describe('every async handler on the real app goes through asyncRoute', () => {
  let repo: SqliteStateRepo;
  let app: Express;
  let cookie: string;

  beforeEach(async () => {
    // Offline: the broker routers keep the fetch they were built with, so it is replaced first.
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed (this test is offline)');
    }));
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation(() => undefined);
    }
    repo = new SqliteStateRepo({ file: ':memory:' });
    const built = createApp({
      repo,
      serviceToken: '6f'.repeat(32),
      allowedOrigins: [ORIGIN],
      snapshotsEnabled: false,
      scryptParams: FAST,
      log: () => undefined,
    });
    app = built.app;
    built.users.createUser('alex', await hashPassword(PASSWORD, FAST));
    const login = await request(await listenLoopback(app)).post('/auth/login')
      .set('Origin', ORIGIN).set('X-Holdr-Request', '1').send({ username: 'alex', password: PASSWORD });
    cookie = (login.headers['set-cookie'] as unknown as string[]).find((value) => value.startsWith('holdr_session='))!.split(';')[0];
    // Recently authenticated, so the card sync repairs' handlers are reached too (they need a password re-check first).
    const reverified = await request(await listenLoopback(app)).post('/auth/reverify').set('Cookie', cookie)
      .set('Origin', ORIGIN).set('X-Holdr-Request', '1').send({ password: PASSWORD });
    expect(reverified.status).toBe(200);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    repo.close();
  });

  it('finds every route, and the async ones are asyncRoute\'s', () => {
    const entries = registered(routerOf(app));
    const routes = new Set(entries.filter((entry) => entry.route).map((entry) => entry.where));
    expect(routes.size).toBeGreaterThanOrEqual(40);
    const wrapped = entries.filter((entry) => entry.route && isAsyncRoute(entry.layer.handle)).map((entry) => entry.where);
    expect(wrapped.sort()).toEqual(expect.arrayContaining(ASYNC_ROUTES));
  });

  it('registers no async function as a handler, middleware, error handler or parameter callback', () => {
    expect(asyncFunctions(app)).toEqual([]);
  });

  it('mounts no Express app inside another, which would hide its handlers from this guard', () => {
    expect(opaque(app)).toEqual([]);
  });

  it('has no other handler that returns a promise to Express, on a request to every route', async () => {
    const entries = registered(routerOf(app));
    const { ran, promised } = watch(entries);
    const dispatcher = createRequestListener(app, { mode: 'dev', listener: 'local', port: 4115 });
    expect(types.isAsyncFunction(dispatcher)).toBe(false);
    let dispatches = 0;
    let dispatcherReturnedPromise = false;
    const observed: RequestListener = (req, res) => {
      dispatches++;
      const result = dispatcher(req, res);
      if (isThenable(result)) {
        dispatcherReturnedPromise = true;
        void Promise.resolve(result).catch(() => undefined);
      }
    };
    // Malformed targets now stop before routing. Exercise both error stacks with unsupported body encodings instead.
    for (const path of ['/card-accounts', '/accounts']) {
      const res = await request(await listenLoopback(observed)).post(path).set('Cookie', cookie)
        .set('Origin', ORIGIN).set('X-Holdr-Request', '1').set('Content-Type', 'application/json; charset=iso-8859-1').send('{}');
      expect(res.status).toBe(415);
    }
    // Reach every terminal miss handler as well as the registered API routes.
    for (const path of ['/not-an-api-route', '/accounts/no/matching/route', '/spending/no-matching-route',
      '/card-sync/no-matching-route', '/card-sync/owner/no-matching-route']) {
      expect((await request(await listenLoopback(observed)).get(path).set('Cookie', cookie)).status).toBe(404);
    }
    const routes = [...new Map(entries.filter((entry) => entry.route).map((entry) => [entry.where, entry.route!])).values()];
    // Signing out ends the session the other requests use.
    routes.sort((a, b) => Number(a.path === '/auth/logout') - Number(b.path === '/auth/logout'));
    for (const { method, path } of routes) {
      const verb = method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
      let test = request(await listenLoopback(observed))[verb](concrete(path))
        .set('Cookie', cookie).set('Origin', ORIGIN).set('X-Holdr-Request', '1');
      if (method !== 'GET') test = test.set('Content-Type', 'application/json').send('{}');
      await test;
    }
    expect(entries.filter((entry) => (entry.route || entry.param) && !ran.has(entry.layer)).map((entry) => entry.where),
      'route handlers and parameter callbacks no request reached').toEqual([]);
    const errorHandlers = entries.filter((entry) => !entry.route && !entry.param && entry.layer.handle.length === 4);
    expect(errorHandlers.length).toBeGreaterThanOrEqual(2);
    expect(errorHandlers.filter((entry) => !ran.has(entry.layer)).map((entry) => entry.where), 'error handlers that never ran').toEqual([]);
    expect(entries.filter((entry) => !ran.has(entry.layer)).map((entry) => entry.where), 'registered handlers or middleware that never ran').toEqual([]);
    expect(named(entries, promised)).toEqual([]);
    expect(dispatches).toBeGreaterThanOrEqual(routes.length + 5);
    expect(dispatcherReturnedPromise).toBe(false);
  }, 60_000);

  it('flags an async handler or parameter callback, and one that returns a promise, but not asyncRoute\'s', async () => {
    const later = async (res: Response) => {
      await Promise.resolve();
      res.json({});
    };
    const carryOn = async (next: NextFunction) => {
      await Promise.resolve();
      next();
    };
    const router = Router();
    // Express calls parameter callbacks from router.params, not from a layer, and awaits none of them either.
    router.param('id', async (_req, _res, next) => {
      await Promise.resolve();
      next();
    });
    router.param('code', (_req, _res, next) => carryOn(next));
    router.param('name', (_req, _res, next) => {
      next();
    });
    router.get('/async', async (_req, res) => {
      res.json({});
    });
    router.get('/promised', (_req, res) => later(res));
    router.get('/wrapped', asyncRoute(async (_req, res) => {
      res.json({});
    }));
    router.get('/plain', (_req, res) => {
      res.json({});
    });
    router.get('/item/:id', (_req, res) => {
      res.json({});
    });
    router.get('/code/:code', (_req, res) => {
      res.json({});
    });
    router.get('/name/:name', (_req, res) => {
      res.json({});
    });
    const sample = express().use('/sample', router);
    expect(asyncFunctions(sample)).toEqual(['param :id at /sample', 'GET /sample/async']);
    const entries = registered(routerOf(sample));
    const { ran, promised } = watch(entries);
    for (const path of ['/async', '/promised', '/wrapped', '/plain', '/item/1', '/code/2', '/name/3']) {
      expect((await request(await listenLoopback(sample)).get(`/sample${path}`)).status).toBe(200);
    }
    expect(named(entries.filter((entry) => entry.route || entry.param), ran).sort()).toEqual([
      'GET /sample/async', 'GET /sample/code/:code', 'GET /sample/item/:id', 'GET /sample/name/:name',
      'GET /sample/plain', 'GET /sample/promised', 'GET /sample/wrapped',
      'param :code at /sample', 'param :id at /sample', 'param :name at /sample',
    ]);
    expect(named(entries, promised).sort())
      .toEqual(['GET /sample/async', 'GET /sample/promised', 'param :code at /sample', 'param :id at /sample']);
  });

  it('counts a handler that throws as reached: Express answers the throw, and nothing returned a promise', async () => {
    const failed: ErrorRequestHandler = (_err, _req, res, _next) => {
      res.status(500).json({ error: 'Internal server error' });
    };
    const router = Router();
    router.param('id', () => {
      throw new Error('the parameter callback throws');
    });
    router.get('/throws', () => {
      throw new Error('the handler throws');
    });
    router.get('/item/:id', (_req, res) => {
      res.json({});
    });
    const sample = express().use('/sample', router).use(failed);
    const entries = registered(routerOf(sample));
    const { ran, promised } = watch(entries);
    for (const path of ['/throws', '/item/1']) {
      const res = await request(await listenLoopback(sample)).get(`/sample${path}`);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal server error' });
    }
    expect(named(entries.filter((entry) => entry.route || entry.param), ran).sort())
      .toEqual(['GET /sample/throws', 'param :id at /sample']);
    expect(named(entries.filter((entry) => !entry.route && !entry.param && entry.layer.handle.length === 4), ran)).toHaveLength(1);
    expect(named(entries, promised)).toEqual([]);
  });

  it('flags an Express app mounted inside another, whose own handlers the walk cannot see', () => {
    const inner = express().get('/x', async (_req, res) => {
      res.json({});
    });
    const outer = express().use('/inner', inner);
    const viaRouter = express().use(Router().use(inner));
    expect(asyncFunctions(outer)).toEqual([]);
    expect(asyncFunctions(viaRouter)).toEqual([]);
    expect(opaque(outer)).toEqual(['middleware mounted_app at /']);
    expect(opaque(viaRouter)).toEqual(['middleware app at /']);
    expect(opaque(express().use('/sample', Router().get('/x', (_req, res) => {
      res.json({});
    })))).toEqual([]);
  });
});
