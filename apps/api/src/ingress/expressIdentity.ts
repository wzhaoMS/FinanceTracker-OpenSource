import express, { Router, type Express, type RouterOptions } from 'express';

interface Dispatch {
  handle: unknown;
  process_params: unknown;
  stack: ExpressLayer[];
  route(path: unknown): unknown;
  use(...args: unknown[]): unknown;
}
export interface ExpressLayer {
  handle: unknown;
  regexp?: RegExp;
  route?: unknown;
  match: unknown;
  handle_request: unknown;
  handle_error: unknown;
}
const routers = new WeakMap<object, { handle: unknown; processParams: unknown; prototype: object | null }>();
const builtins = new WeakMap<object, ExpressLayer>();
const routes = new WeakMap<object, { layer: ExpressLayer; handlesMethod: unknown; options: unknown }>();
const layers = new WeakMap<object, ExpressLayer & { pattern: string; fastSlash: unknown; fastStar: unknown }>();
const fastFlags = (regexp?: RegExp) => regexp as (RegExp & { fast_slash?: boolean; fast_star?: boolean }) | undefined;

function rememberLayer(layer: ExpressLayer): ExpressLayer {
  const snapshot = {
    ...layer, match: layer.match, handle_request: layer.handle_request, handle_error: layer.handle_error,
    pattern: String(layer.regexp), fastSlash: fastFlags(layer.regexp)?.fast_slash, fastStar: fastFlags(layer.regexp)?.fast_star,
  };
  layers.set(layer, snapshot);
  return snapshot;
}

function remember(router: Router): void {
  const dispatch = router as unknown as Dispatch;
  routers.set(router, {
    handle: dispatch.handle, processParams: dispatch.process_params, prototype: Object.getPrototypeOf(router),
  });
  const route = dispatch.route;
  dispatch.route = function (path) {
    const result = route.call(router, path);
    const layer = dispatch.stack.at(-1)!;
    const methods = result as { _handles_method: unknown; _options: unknown };
    routes.set(layer, { layer: rememberLayer(layer), handlesMethod: methods._handles_method, options: methods._options });
    return result;
  };
  const use = dispatch.use;
  dispatch.use = function (...args) {
    const before = dispatch.stack.length;
    const result = use.apply(router, args);
    for (const layer of dispatch.stack.slice(before)) rememberLayer(layer);
    return result;
  };
}

/** These factories certify Express dispatch identity, not authorization of any routes or middleware subsequently added. */
export function createVerifiedRouter(options?: RouterOptions): Router {
  const router = Router(options);
  remember(router);
  return router;
}

export function createVerifiedApp(): Express {
  const app = express();
  const internals = app as unknown as { lazyrouter(): void; _router: Router & Dispatch };
  internals.lazyrouter();
  remember(internals._router);
  for (const layer of internals._router.stack) {
    builtins.set(layer, rememberLayer(layer));
  }
  return app;
}

export function isVerifiedRouter(value: unknown): boolean {
  if ((typeof value !== 'function' && typeof value !== 'object') || value === null) return false;
  const identity = routers.get(value);
  const dispatch = value as Dispatch;
  return identity !== undefined && identity.handle === dispatch.handle && identity.processParams === dispatch.process_params
    && identity.prototype === Object.getPrototypeOf(value) && Array.isArray(dispatch.stack);
}

export function isVerifiedExpressBuiltin(layer: ExpressLayer): boolean {
  const identity = builtins.get(layer);
  return identity !== undefined && identity.handle === layer.handle && identity.regexp === layer.regexp
    && identity.match === layer.match && identity.handle_request === layer.handle_request && identity.handle_error === layer.handle_error;
}

export function isVerifiedRouteLayer(layer: ExpressLayer): boolean {
  const identity = routes.get(layer);
  const original = identity?.layer;
  const methods = layer.route as { _handles_method?: unknown; _options?: unknown } | undefined;
  return original !== undefined && layer.handle === original.handle && layer.route === original.route
    && layer.match === original.match && layer.handle_request === original.handle_request && layer.handle_error === original.handle_error
    && methods?._handles_method === identity?.handlesMethod && methods?._options === identity?.options;
}

export function isVerifiedExpressLayer(layer: ExpressLayer): boolean {
  const original = layers.get(layer);
  return original !== undefined && layer.handle === original.handle && layer.match === original.match
    && layer.handle_request === original.handle_request && layer.handle_error === original.handle_error
    && String(layer.regexp) === original.pattern && fastFlags(layer.regexp)?.fast_slash === original.fastSlash
    && fastFlags(layer.regexp)?.fast_star === original.fastStar;
}
