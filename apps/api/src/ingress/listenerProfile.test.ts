import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { clientAddress, isDirectLoopback } from '../auth/http.js';
import type { Request } from 'express';
import { classifyListenerRequest } from './listenerProfile.js';
import { SERVE_HEADERS, TEST_ADMISSION, TEST_ORIGIN, TEST_PORT, TEST_WEB_PORT } from './fixtures.js';
import { CLOSED_ADMISSION, type ListenerConfig } from './types.js';

const serve: ListenerConfig = { mode: 'dist', listener: 'ingress', publicOrigin: TEST_ORIGIN, socketPath: '/not-listened', admission: TEST_ADMISSION };
const direct: ListenerConfig = { mode: 'dist', listener: 'local', publicOrigin: TEST_ORIGIN, port: TEST_PORT, admission: TEST_ADMISSION };
const local: ListenerConfig = { mode: 'local', listener: 'ingress', port: TEST_WEB_PORT, admission: TEST_ADMISSION };
function req(headers: readonly (readonly [string, string])[], remoteAddress?: string): IncomingMessage {
  return {
    rawHeaders: headers.flat(), headers: Object.fromEntries(headers.map(([key, value]) => [key.toLowerCase(), value])),
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}
const withHeader = (name: string, value?: string) => [
  ...SERVE_HEADERS.filter(([key]) => key.toLowerCase() !== name.toLowerCase()),
  ...(value === undefined ? [] : [[name, value] as const]),
];

describe('listener profiles', () => {
  it.each(['100.64.0.1', '100.127.255.254', 'fd7a:115c:a1e0::1', '127.0.0.1', '::1'])('admits Serve client %s', (address) => {
    const facts = classifyListenerRequest(req(withHeader('X-Forwarded-For', address), undefined), serve);
    expect(facts).toEqual({ mode: 'dist', listener: 'ingress', profile: 'serve', clientAddress: address });
    expect(Object.isFrozen(facts)).toBe(true);
  });
  it.each(['HOldR.TEST', 'holdr.test:443'])('accepts the exact public host case/default-port variant %s', (host) => {
    expect(classifyListenerRequest(req(withHeader('X-Forwarded-Host', host)), serve)).toHaveProperty('profile', 'serve');
  });
  it.each([
    ['Host', undefined, 400, 'host-invalid'], ['Host', 'holdr.test', 421, 'misdirected-request'],
    ['Host', 'localhost:80', 421, 'misdirected-request'],
    ['X-Forwarded-Host', undefined, 421, 'misdirected-request'],
    ['X-Forwarded-Host', 'holdr.test.', 421, 'misdirected-request'],
    ['X-Forwarded-Host', 'holdr.test:444', 421, 'misdirected-request'],
    ['X-Forwarded-Proto', 'http', 400, 'forwarding-headers-invalid'],
    ['X-Forwarded-Proto', 'HTTPS', 400, 'forwarding-headers-invalid'],
    ['X-Forwarded-For', '100.63.255.255', 400, 'forwarding-headers-invalid'],
    ['X-Forwarded-For', '100.128.0.1', 400, 'forwarding-headers-invalid'],
    ['X-Forwarded-For', 'fd7a:115c:a1e1::1', 400, 'forwarding-headers-invalid'],
    ['X-Forwarded-For', 'fd7a:115c:a1e0::1%en0', 400, 'forwarding-headers-invalid'],
    ['X-Forwarded-For', '100.64.0.1, 127.0.0.1', 400, 'forwarding-headers-invalid'],
    ['X-Forwarded-For', '1.2.3.4', 400, 'forwarding-headers-invalid'],
    ['X-Forwarded-For', '[::1]', 400, 'forwarding-headers-invalid'],
    ['X-Forwarded-For', undefined, 400, 'forwarding-headers-invalid'],
    ['Via', 'proxy', 400, 'forwarding-headers-invalid'], ['Forwarded', 'for=100.64.0.1', 400, 'forwarding-headers-invalid'],
    ['X-Real-IP', '100.64.0.1', 400, 'forwarding-headers-invalid'], ['Tailscale-Funnel-Request', '', 403, 'funnel-refused'],
  ] as const)('refuses %s = %s', (header, value, refuse, code) => {
    expect(classifyListenerRequest(req(withHeader(header, value)), serve)).toEqual({ refuse, code });
  });
  it.each(SERVE_HEADERS)('rejects duplicate %s even when values agree', (key, value) => {
    expect(classifyListenerRequest(req([...SERVE_HEADERS, [key, value]]), serve)).toHaveProperty('refuse');
  });
  it('checks headers before admission and never trusts an absent/failing gate', () => {
    expect(classifyListenerRequest(req(SERVE_HEADERS), { ...serve, admission: undefined })).toEqual({ refuse: 503, code: 'ingress-unverified' });
    expect(classifyListenerRequest(req(SERVE_HEADERS), { ...serve, admission: CLOSED_ADMISSION })).toEqual({ refuse: 503, code: 'ingress-unverified' });
    expect(classifyListenerRequest(req(SERVE_HEADERS), { ...serve, admission: { refusal: () => { throw Error('do not leak'); } } }))
      .toEqual({ refuse: 503, code: 'ingress-unverified' });
    expect(classifyListenerRequest(req(SERVE_HEADERS), { ...serve, admission: { refusal: () => 'ingress-refused' } }))
      .toEqual({ refuse: 503, code: 'ingress-refused' });
    expect(classifyListenerRequest(req(withHeader('Host', 'evil.test')), { ...serve, admission: CLOSED_ADMISSION })).toHaveProperty('refuse', 421);
  });
  it.each(['127.0.0.1:4115', 'localhost:14000', '[::1]:14000', '127.2.3.4'])('allows SSH/local Host %s only as direct', (host) => {
    expect(classifyListenerRequest(req([['Host', host]], '127.0.0.1'), direct)).toHaveProperty('profile', 'direct');
  });
  it('refuses Serve headers forged on TCP', () => {
    expect(classifyListenerRequest(req(SERVE_HEADERS), direct)).toEqual({ refuse: 400, code: 'proxied-request-refused' });
    expect(classifyListenerRequest(req(SERVE_HEADERS, '127.0.0.1'), serve)).toEqual({ refuse: 421, code: 'misdirected-request' });
  });
  it.each(['Forwarded', 'Via', 'X-Real-IP', 'X-Forwarded-Anything', 'Tailscale-User-Login'])('refuses %s on direct and local-browser', (name) => {
    const request = req([['Host', `localhost:${TEST_WEB_PORT}`], [name, 'anything']]);
    expect(classifyListenerRequest(request, direct)).toEqual({ refuse: 400, code: 'proxied-request-refused' });
    expect(classifyListenerRequest(request, local)).toEqual({ refuse: 400, code: 'proxied-request-refused' });
  });
  it('confines break-glass to its exact host/port without a service-token identity', () => {
    const request = req([['Host', `localhost:${TEST_WEB_PORT}`]], '127.0.0.1');
    const facts = classifyListenerRequest(request, local);
    expect(facts).toHaveProperty('profile', 'local-browser');
    Object.defineProperty(request, 'holdrIngress', { value: facts });
    expect(isDirectLoopback(request as Request)).toBe(false);
    expect(classifyListenerRequest(req([['Host', 'localhost:8888']], '127.0.0.1'), local)).toHaveProperty('refuse', 421);
  });
  it('keeps dev proxy throttling unchanged and uses the Serve address on the socket', () => {
    const dev: ListenerConfig = { mode: 'dev', listener: 'local', port: TEST_PORT };
    const request = req([['Host', 'any.test'], ['X-Forwarded-For', '10.0.0.1, 100.64.0.9']], '127.0.0.1');
    expect(classifyListenerRequest(request, dev)).toHaveProperty('clientAddress', '100.64.0.9');
    const socketReq = req(SERVE_HEADERS, undefined);
    Object.defineProperty(socketReq, 'holdrIngress', { value: classifyListenerRequest(socketReq, serve) });
    expect(clientAddress(socketReq as Request)).toBe('100.101.102.103');
    expect(isDirectLoopback(socketReq as Request)).toBe(false);
  });
});
