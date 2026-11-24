import type { IncomingMessage } from 'node:http';
import type { RequestHandler, Response } from 'express';
import { rawHeaderValues } from '../../ingress/listenerProfile.js';
import { DEVICE_ENDPOINTS, DeviceHttpError, deviceEndpoint, singleDeviceHeader } from './deviceProtocol.js';

/** E3 build/manifest.ts's production key; its separate fake-issuer test key is deliberately not registered here. */
export const DEVICE_EXTENSION_ORIGINS: readonly string[] = Object.freeze([
  'chrome-extension://lmkonkgaegpbbdkngajdmlgghkchjdnc',
]);
const origins = new Set(DEVICE_EXTENSION_ORIGINS);
const preflightHeaders = new Set([
  'authorization', 'content-type', 'x-holdr-client', 'x-holdr-client-version', 'idempotency-key', 'accept',
]);
const failures = new WeakMap<IncomingMessage, DeviceHttpError>();
const processed = new WeakSet<IncomingMessage>();

/** CORS never grants credentials or runs a device operation. Even a successful preflight still goes through D. */
export const deviceCors: RequestHandler = (req, res, next) => {
  const path = req.holdrTarget?.rawPath ?? req.path;
  if (!deviceEndpoint(path, req.method)) { next(); return; }
  processed.add(req);
  res.vary('Origin');
  for (const name of ['Access-Control-Allow-Credentials', 'Access-Control-Allow-Origin', 'Access-Control-Allow-Methods',
    'Access-Control-Allow-Headers', 'Access-Control-Expose-Headers']) res.removeHeader(name);
  try {
    const origin = singleDeviceHeader(req, 'origin');
    if (origin !== undefined && !origins.has(origin)) throw new DeviceHttpError(403, 'credential-not-allowed');
    if (req.method === 'OPTIONS') {
      res.vary('Access-Control-Request-Method');
      res.vary('Access-Control-Request-Headers');
      const method = singleDeviceHeader(req, 'access-control-request-method');
      const declared = singleDeviceHeader(req, 'access-control-request-headers');
      const expected = DEVICE_ENDPOINTS.find((entry) => entry.match.test(path))?.method.toUpperCase();
      if (!origin || method !== expected || !declared) throw new DeviceHttpError(403, 'credential-not-allowed');
      const headers = declared.toLowerCase().split(',').map((header) => header.trim());
      if (headers.length > 8 || new Set(headers).size !== headers.length || headers.some((header) => !preflightHeaders.has(header))) {
        throw new DeviceHttpError(403, 'credential-not-allowed');
      }
      if (!headers.includes('authorization') || !headers.includes('x-holdr-client')) {
        throw new DeviceHttpError(403, 'credential-not-allowed');
      }
      res.setHeader('Access-Control-Allow-Methods', expected!);
      res.setHeader('Access-Control-Allow-Headers', headers.join(', '));
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Expose-Headers', 'X-Holdr-Error, Retry-After');
    }
  } catch (error) {
    failures.set(req, error instanceof DeviceHttpError ? error : new DeviceHttpError(403, 'credential-not-allowed'));
  }
  next();
};

export function deviceCorsFailure(req: IncomingMessage): DeviceHttpError | undefined {
  return failures.get(req);
}

export function assertDeviceCors(req: IncomingMessage): void {
  const failure = failures.get(req);
  if (failure) throw failure;
  const origin = singleDeviceHeader(req, 'origin');
  if (origin !== undefined && !origins.has(origin)) throw new DeviceHttpError(403, 'credential-not-allowed');
}

export function devicePreflight(req: IncomingMessage, res: Response): void {
  assertDeviceCors(req);
  if (!processed.has(req)) throw new DeviceHttpError(403, 'credential-not-allowed');
  if (rawHeaderValues(req, 'cookie').length !== 0 || rawHeaderValues(req, 'authorization').length !== 0) {
    throw new DeviceHttpError(401, 'unauthorized');
  }
  res.status(204).end();
}
