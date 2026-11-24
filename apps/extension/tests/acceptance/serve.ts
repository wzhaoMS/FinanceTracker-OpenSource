/**
 * A stand-in for Tailscale Serve in front of the synthetic Holdr (acceptance
 * suite only): it terminates TLS for one host with a throwaway identity and
 * forwards each request to Holdr's dist ingress (its Unix socket, or a
 * loopback port in this module's own test) the way Serve does: `Host:
 * localhost`, `X-Forwarded-Host` the public host, `X-Forwarded-Proto: https`
 * and a tailnet client address in `X-Forwarded-For`. Any forwarding header
 * the browser sent is dropped first, and hop-by-hop headers are not passed
 * on. Bodies are streamed unchanged both ways.
 */
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { TlsIdentity } from './selfSigned.js';

const NOT_FORWARDED = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
  'forwarded', 'via', 'x-real-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'tailscale-funnel-request',
]);

export interface ServeStandIn {
  readonly port: number;
  /** Method, path and status of every request forwarded (never headers or bodies). */
  readonly requests: Array<{ method: string; path: string; status: number }>;
  close(): Promise<void>;
}

export async function startServeStandIn(options: {
  identity: TlsIdentity;
  publicHost: string;
  upstream: { socketPath: string } | { port: number };
  /** The tailnet address Serve reports for the browser's machine. */
  clientAddress?: string;
}): Promise<ServeStandIn> {
  const requests: ServeStandIn['requests'] = [];
  const target = 'socketPath' in options.upstream ? { socketPath: options.upstream.socketPath } : { host: '127.0.0.1', port: options.upstream.port };
  const server = https.createServer({ key: options.identity.key, cert: options.identity.cert, ALPNProtocols: ['http/1.1'] }, (req, res) => {
    const headers: Record<string, string> = {};
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      const name = req.rawHeaders[index].toLowerCase();
      if (!NOT_FORWARDED.has(name)) headers[name] = req.rawHeaders[index + 1];
    }
    headers.host = 'localhost';
    headers['x-forwarded-host'] = options.publicHost;
    headers['x-forwarded-proto'] = 'https';
    headers['x-forwarded-for'] = options.clientAddress ?? '100.101.102.103';
    const forward = http.request({ ...target, method: req.method, path: req.url, headers }, (answer) => {
      const status = answer.statusCode ?? 502;
      requests.push({ method: req.method ?? '?', path: (req.url ?? '').split('?')[0], status });
      const back: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(answer.headers)) {
        if (value !== undefined && !NOT_FORWARDED.has(name)) back[name] = value;
      }
      res.writeHead(status, back);
      answer.pipe(res);
    });
    forward.on('error', () => {
      requests.push({ method: req.method ?? '?', path: (req.url ?? '').split('?')[0], status: 502 });
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end();
    });
    res.on('close', () => forward.destroy());
    req.pipe(forward);
  });
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
