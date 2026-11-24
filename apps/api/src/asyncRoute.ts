import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Handlers asyncRoute made, so the guard test can tell them from the rest. */
const routes = new WeakSet<object>();

/**
 * A route handler or middleware that may return a promise, for Express 4.
 * Express 4 ignores what a handler returns, so a rejection (an await, a
 * database call or a throw outside the handler's own try/catch) never
 * reaches next(): the request hangs and the process stops, printing the
 * error's message and stack. asyncRoute hands every rejection, and every
 * synchronous throw, to next(err), so it ends at the app's value-free error
 * handler like any other failure. A handler's own error mapping (a route
 * that answers its validation errors itself) is unchanged.
 *
 * Register every handler that is async, or returns a promise, through it.
 * app.asyncRoutes.test.ts walks the real app and fails on one that is not.
 */
// The defaults are Express's own (RequestHandler), except route parameters:
// Express 4 always gives strings (ParamsDictionary allows Express 5's arrays).
export function asyncRoute<
  P = Record<string, string>,
  ResBody = any,
  ReqBody = any,
  ReqQuery = Request['query'],
  Locals extends Record<string, any> = Record<string, any>,
>(
  handler: (req: Request<P, ResBody, ReqBody, ReqQuery, Locals>, res: Response<ResBody, Locals>, next: NextFunction) => unknown,
): RequestHandler<P, ResBody, ReqBody, ReqQuery, Locals> {
  const route: RequestHandler<P, ResBody, ReqBody, ReqQuery, Locals> = (req, res, next) => {
    const fail = (error: unknown) => next(asFailure(error));
    try {
      const result = handler(req, res, next);
      if (isThenable(result)) result.then(undefined, fail);
    } catch (error) {
      fail(error);
    }
  };
  routes.add(route);
  return route;
}

/** True for a handler asyncRoute returned. */
export function isAsyncRoute(handler: unknown): boolean {
  return typeof handler === 'function' && routes.has(handler);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null
    && typeof (value as { then?: unknown }).then === 'function';
}

/** next() reads a falsy value, 'route' or 'router' as "carry on"; a rejection with one is still a failure. */
function asFailure(error: unknown): unknown {
  return !error || error === 'route' || error === 'router' ? new Error('a route handler failed without an error') : error;
}
