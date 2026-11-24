import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { applySecurityHeaders, API_CSP, DOCUMENT_CSP, PERMISSIONS_POLICY } from './securityHeaders.js';

describe('the security header policy', () => {
  it('pins the exact document CSP and deny-list', () => {
    expect(DOCUMENT_CSP).toBe("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'");
    expect(API_CSP).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(PERMISSIONS_POLICY).toBe('camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), midi=(), display-capture=(), clipboard-read=(), publickey-credentials-get=(), xr-spatial-tracking=()');
  });
  for (const kind of ['document', 'asset', 'api'] as const) {
    for (const serve of [true, false]) {
      it(`${kind} with serve=${serve} has only its specified headers`, () => {
        const res = new ServerResponse(new IncomingMessage(new Socket()));
        applySecurityHeaders(res, kind, serve);
        expect(res.getHeaders()).toEqual({
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'cross-origin-resource-policy': 'same-origin',
          ...(kind !== 'asset' ? { 'content-security-policy': kind === 'document' ? DOCUMENT_CSP : API_CSP, 'x-frame-options': 'DENY' } : {}),
          ...(kind === 'document' ? { 'cross-origin-opener-policy': 'same-origin', 'permissions-policy': PERMISSIONS_POLICY } : {}),
          ...(serve ? { 'strict-transport-security': 'max-age=31536000' } : {}),
        });
      });
    }
  }
});
