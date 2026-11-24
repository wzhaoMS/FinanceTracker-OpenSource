import type { Router, Request, RequestHandler, Response } from 'express';
import { WebReleaseError } from '@finance-tracker/shared/web-release';
import { asyncRoute } from '../asyncRoute.js';
import { DeviceAdmissionRefusal, isDeviceAdmission, type DeviceAdmission, type DeviceAuthorization } from './deviceAdmission.js';
import { sendRefusal } from './securityHeaders.js';
import { createVerifiedRouter } from './expressIdentity.js';

export type DeviceRouterFactory<Options extends object> = (options: Options & { readonly admission: DeviceAdmission }) => Router;
export type DeviceRouteMethod = 'get' | 'head' | 'post' | 'put' | 'patch' | 'delete' | 'options';
export interface DeviceRoute {
  readonly method: DeviceRouteMethod;
  readonly path: string;
  readonly handle: (req: Request<Record<string, string>>, res: Response, authorization: DeviceAuthorization) => unknown;
}

const guarded = new WeakSet<object>();
const METHODS = new Set<DeviceRouteMethod>(['get', 'head', 'post', 'put', 'patch', 'delete', 'options']);
export const DEVICE_ROUTE_PATH = /^(?:\/(?:[a-zA-Z0-9_-]+|:[a-zA-Z0-9_]+))+$/;

/** Test introspection uses identity, not a forgeable function name/property. */
export function isDeviceAdmissionRoute(handler: unknown): boolean {
  return typeof handler === 'function' && guarded.has(handler);
}

/** E2 supplies credential resolution and the operation in one callback, both inside admission's authorization lock. */
export function deviceRoute(admission: DeviceAdmission, handle: DeviceRoute['handle']): RequestHandler<Record<string, string>> {
  if (!isDeviceAdmission(admission) || typeof handle !== 'function') throw new WebReleaseError('E0I_DEVICE_ADMISSION');
  const route = asyncRoute(async (req, res) => {
    try {
      await admission.admit(req, async (authorization) => {
        const expired = () => {
          if (!res.headersSent && !res.destroyed) sendRefusal(req, res, 409, 'authorization-blocked');
          else if (!res.writableEnded) res.destroy();
        };
        authorization.signal.addEventListener('abort', expired, { once: true });
        try { return await handle(req, res, authorization); }
        finally { authorization.signal.removeEventListener('abort', expired); }
      });
    } catch (error) {
      if (!(error instanceof DeviceAdmissionRefusal)) throw error;
      if (!res.headersSent && !res.destroyed) sendRefusal(req, res, error.status, error.code);
      else res.destroy();
    }
  });
  guarded.add(route);
  return route;
}

/**
 * A required branded admission, exact route declarations, no unguarded router.param or middleware callbacks. Parse bodies
 * before this router without doing credential/database work. Callbacks must be short, must not reacquire authorization or
 * exclusive lifecycle locks, and must call authorization.assertCurrent() immediately before each irreversible effect.
 * Never await network/body input here; cancellation cannot preempt JavaScript or roll back an already-started transaction.
 */
export function createDeviceRouter(admission: DeviceAdmission, routes: readonly DeviceRoute[]): Router {
  if (!isDeviceAdmission(admission)) throw new WebReleaseError('E0I_DEVICE_ADMISSION');
  const router = createVerifiedRouter({ caseSensitive: true, strict: true });
  const seen = new Set<string>();
  const paths = new Set<string>();
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    if (!METHODS.has(route.method) || !DEVICE_ROUTE_PATH.test(route.path) || seen.has(key)) {
      throw new WebReleaseError('E0I_DEVICE_ROUTE');
    }
    seen.add(key);
    paths.add(route.path);
    router[route.method](route.path, deviceRoute(admission, route.handle));
  }
  for (const path of paths) {
    if (!seen.has(`options ${path}`)) {
      // Express otherwise synthesizes an unauthenticated 200 OPTIONS reply without invoking any route callback.
      router.options(path, deviceRoute(admission, (req, res) => sendRefusal(req, res, 405, 'method-not-allowed')));
    }
  }
  return router;
}
