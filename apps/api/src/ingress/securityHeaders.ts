import type { RequestHandler } from 'express';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const DOCUMENT_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";
export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), midi=(), display-capture=(), clipboard-read=(), publickey-credentials-get=(), xr-spatial-tracking=()';

export function applySecurityHeaders(res: ServerResponse, kind: 'document' | 'asset' | 'api', serve: boolean): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  for (const header of ['Content-Security-Policy', 'X-Frame-Options', 'Cross-Origin-Opener-Policy', 'Permissions-Policy', 'Strict-Transport-Security']) {
    res.removeHeader(header);
  }
  if (kind !== 'asset') {
    res.setHeader('Content-Security-Policy', kind === 'document' ? DOCUMENT_CSP : API_CSP);
    res.setHeader('X-Frame-Options', 'DENY');
  }
  if (kind === 'document') {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
  }
  if (serve) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

export const securityHeaders: RequestHandler = (req, res, next) => {
  applySecurityHeaders(res, 'api', req.holdrIngress?.profile === 'serve');
  next();
};

export function sendRefusal(req: IncomingMessage, res: ServerResponse, status: number, code: string, allow?: string): void {
  req.holdrRefusalLog?.(code, req.method ?? 'OTHER');
  const body = Buffer.from(JSON.stringify({ error: code }));
  applySecurityHeaders(res, 'api', req.holdrIngress?.profile === 'serve');
  res.statusCode = status;
  res.setHeader('X-Holdr-Error', code);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', body.length);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'close');
  if (allow) res.setHeader('Allow', allow);
  res.end(req.method === 'HEAD' ? undefined : body);
}
