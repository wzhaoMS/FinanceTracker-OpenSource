import http from 'node:http';
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UPSTREAM_IDLE_TIMEOUT_MS } from '@finance-tracker/shared/upstream-keep-alive';
import { closeServers, rawRequest, socketFixture, TEST_ADMISSION, TEST_ORIGIN, TEST_PORT } from './fixtures.js';
import { attachServerGuards, createRefusalLogger, createRequestListener, listenChecked, startIngressServers } from './server.js';
import type { ListenerConfig } from './types.js';

const config: ListenerConfig = { mode: 'dev', listener: 'local', port: TEST_PORT };
let servers: http.Server[] = [];
afterEach(async () => { await closeServers(servers); servers = []; });

describe('Node HTTP dispatch guards', () => {
  it.each([
    ['TRACE', '/', [], 405, 'method-not-allowed'],
    ['PROPFIND', '/', [], 405, 'method-not-allowed'],
    ['CONNECT', 'holdr.test:443', [], 405, 'method-not-allowed'],
    ['OPTIONS', '*', [], 400, 'request-target-form'],
    ['GET', 'http://[fe80::1%25lo0]/', [], 400, 'request-target-form'],
    ['GET', '/health#ignored', [], 400, 'request-target-chars'],
    ['GET', '/', [['Host', 'second.test']], 400, 'host-invalid'],
    ['GET', '/', [['Tailscale-Funnel-Request', '']], 403, 'funnel-refused'],
    ['GET', '/', [['Upgrade', 'websocket']], 400, 'upgrade-not-supported'],
    ['GET', '/', [['Upgrade', 'websocket'], ['Connection', 'Upgrade']], 400, 'upgrade-not-supported'],
    ['GET', '/', [['X-Long', 'a'.repeat(18_000)]], 431, 'headers-too-large'],
    ['POST', '/%zz', [['Expect', '100-continue']], 400, 'bad-percent-encoding'],
    ['GET', '/', [['Expect', 'unsupported']], 417, 'expectation-not-supported'],
  ] as const)('refuses %s %s before any app dispatch', async (method, target, extra, status, code) => {
    const app = vi.fn((_req: http.IncomingMessage, res: http.ServerResponse) => res.end('app must not see this'));
    servers = await startIngressServers(app, [config]);
    const response = await rawRequest(TEST_PORT, method, target, [['Host', 'localhost'], ...extra]);
    expect(response.status).toBe(status);
    expect(response.headers['x-holdr-error']).toBe(code);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.connection).toBe('close');
    expect(app).not.toHaveBeenCalled();
  });
  it('requires exactly one Host, including HTTP/1.0-style missing Host', async () => {
    servers = await startIngressServers((_req, res) => res.end('not reached'), [config]);
    const response = await rawRequest(TEST_PORT, 'GET', '/', []);
    expect(response.status).toBe(400);
    expect(response.headers['x-holdr-error']).toBe('host-invalid');
  });
  it('sets frozen facts server-side, preserves Authorization and URL, and ignores profile headers', async () => {
    servers = await startIngressServers((req, res) => {
      expect(Object.isFrozen(req.holdrIngress)).toBe(true);
      expect(Object.getOwnPropertyDescriptor(req, 'holdrIngress')?.writable).toBe(false);
      expect(req.holdrIngress?.profile).toBe('dev');
      expect(req.headers.authorization).toBe('HoldrDevice synthetic');
      expect(req.url).toBe('/ACCOUNTS/x?q=1');
      res.end('ok');
    }, [config]);
    const response = await rawRequest(TEST_PORT, 'GET', '/ACCOUNTS/x?q=1', [
      ['Host', 'localhost'], ['X-Holdr-Ingress', 'serve'], ['Authorization', 'HoldrDevice synthetic'],
    ]);
    expect(response.status).toBe(200);
  });
  it('uses the required timeouts on each listener type', () => {
    const server = http.createServer(createRequestListener((_req, res) => res.end(), config));
    attachServerGuards(server, config);
    expect(server.headersTimeout).toBe(20_000);
    expect(server.requestTimeout).toBe(300_000);
    expect(server.keepAliveTimeout).toBe(5_000);
    // Vite's API proxy must drop a pooled connection before this closes it (apps/web/apiProxy.ts).
    expect(server.keepAliveTimeout).toBeGreaterThan(UPSTREAM_IDLE_TIMEOUT_MS);
    const serve = http.createServer();
    attachServerGuards(serve, { mode: 'dist', listener: 'ingress', publicOrigin: TEST_ORIGIN, socketPath: '/not-listened' });
    expect(serve.keepAliveTimeout).toBe(100_000);
  });
  it('cannot confer the Serve profile even if its dispatcher is accidentally mounted on TCP', async () => {
    const app = vi.fn((_req: http.IncomingMessage, res: http.ServerResponse) => res.end('not reached'));
    const server = http.createServer(createRequestListener(app, {
      mode: 'dist', listener: 'ingress', publicOrigin: TEST_ORIGIN, socketPath: '/not-listened', admission: TEST_ADMISSION,
    }));
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(TEST_PORT, '127.0.0.1', resolve);
    });
    const response = await rawRequest(TEST_PORT, 'GET', '/');
    expect(response.status).toBe(421);
    expect(app).not.toHaveBeenCalled();
  });
  it('never listens on an unverified Unix path or deletes an existing file', async () => {
    const fixture = socketFixture();
    const server = http.createServer();
    const config: ListenerConfig = { mode: 'dist', listener: 'ingress', publicOrigin: TEST_ORIGIN, socketPath: fixture.socketPath };
    try {
      await expect(listenChecked(server, config)).rejects.toThrow('E0I_SOCKET_UNVERIFIED');
      expect(server.listening).toBe(false);
      fs.writeFileSync(fixture.socketPath, 'do not delete');
      await expect(listenChecked(server, config, fixture.safety)).rejects.toThrow('E0I_SOCKET_IN_USE');
      expect(fs.readFileSync(fixture.socketPath, 'utf8')).toBe('do not delete');
    } finally { fixture.cleanup(); }
  });
  it('rolls back already bound listeners when the second bind fails', async () => {
    await expect(startIngressServers((_req, res) => res.end(), [config, config])).rejects.toMatchObject({ code: 'EADDRINUSE' });
    servers = await startIngressServers((_req, res) => res.end('free again'), [config]);
    expect((await rawRequest(TEST_PORT, 'GET', '/', [['Host', 'localhost']])).body.toString()).toBe('free again');
  });
  it('logs only code/listener/method/count at most once per minute per code', () => {
    let now = 0;
    const lines: string[] = [];
    const log = createRefusalLogger('ingress', (line) => lines.push(line), () => now);
    log('not-found', 'GET');
    for (let i = 0; i < 5; i++) log('not-found', 'GET');
    expect(lines).toEqual(['[holdr-ingress] refused not-found listener=ingress method=GET count=1']);
    now = 60_000;
    log('not-found', 'UNKNOWN-SYNTHETIC-SECRET');
    expect(lines[1]).toBe('[holdr-ingress] refused not-found listener=ingress method=OTHER count=6');
  });
});
