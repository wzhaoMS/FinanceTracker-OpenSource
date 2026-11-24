/**
 * The local egress gate in front of the test browser (plan §9.2.4). The
 * browser's only proxy is this server, and Playwright also routes loopback
 * through it, so it sees every request the browser makes, including the
 * extension worker's. It:
 * - forwards plain-HTTP requests for the mapped fake hosts (`*.e3.test`) to
 *   their loopback fake servers, and only to 127.0.0.1;
 * - tunnels a CONNECT only for an exactly mapped `host:port` (the acceptance
 *   suite's `holdr.test:443`), and only to its loopback TLS server;
 * - answers everything else 403 without resolving or connecting anywhere:
 *   any other host, any other CONNECT (HTTPS tunnels), any WebSocket upgrade;
 * - records every decision in a ledger.
 * It never performs DNS and never opens a socket to anything but 127.0.0.1.
 */
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

export interface LedgerEntry {
  readonly at: number;
  readonly decision: 'allow' | 'deny';
  readonly kind: 'http' | 'connect' | 'upgrade';
  readonly method: string;
  /** host[:port] and path only; never headers or bodies. */
  readonly target: string;
}

const LOOPBACK = '127.0.0.1';

export class EgressGate {
  readonly ledger: LedgerEntry[] = [];
  /** Open CONNECT tunnels, closed with the gate. */
  private readonly tunnelled = new Set<net.Socket>();
  private constructor(
    private readonly server: http.Server,
    private readonly routes: ReadonlyMap<string, number>,
    private readonly tunnels: ReadonlyMap<string, number>,
  ) {}

  /** `routes`: plain-HTTP host → loopback port. `tunnels`: exact CONNECT `host:port` → loopback port. */
  static async start(routes: ReadonlyMap<string, number>, tunnels: ReadonlyMap<string, number> = new Map()): Promise<EgressGate> {
    for (const port of [...routes.values(), ...tunnels.values()]) if (!Number.isInteger(port) || port <= 0) throw new Error('bad route');
    for (const target of tunnels.keys()) if (!/^[a-z0-9.-]+:443$/.test(target)) throw new Error('bad tunnel');
    const server = http.createServer();
    const gate = new EgressGate(server, routes, tunnels);
    server.on('request', (req, res) => gate.onRequest(req, res));
    server.on('connect', (req, socket, head) => gate.onConnect(req, socket as net.Socket, head));
    server.on('upgrade', (req, socket) => gate.onUpgrade(req, socket as net.Socket));
    server.on('clientError', (_error, socket) => socket.destroy());
    server.on('connection', (socket) => socket.on('error', () => undefined));
    await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));
    return gate;
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  get address(): string {
    return (this.server.address() as AddressInfo).address;
  }

  private record(decision: LedgerEntry['decision'], kind: LedgerEntry['kind'], method: string, target: string): void {
    this.ledger.push({ at: Date.now(), decision, kind, method, target: target.slice(0, 300) });
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    let url: URL | null = null;
    try {
      url = new URL(req.url ?? '');
    } catch {
      url = null;
    }
    const port = url && url.protocol === 'http:' && (url.port === '' || url.port === '80') ? this.routes.get(url.hostname) : undefined;
    if (!url || port === undefined) {
      this.record('deny', 'http', req.method ?? '?', url ? `${url.host}${url.pathname}` : 'non-absolute');
      res.writeHead(403, { 'content-type': 'text/plain', connection: 'close' });
      res.end('denied by the E3 egress gate');
      req.resume();
      return;
    }
    this.record('allow', 'http', req.method ?? '?', `${url.host}${url.pathname}`);
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const forward = http.request({ host: LOOPBACK, port, method: req.method, path: `${url.pathname}${url.search}`, headers }, (upstream) => {
      res.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(res);
    });
    forward.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end();
    });
    res.on('close', () => forward.destroy());
    req.pipe(forward);
  }

  private onConnect(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    socket.on('error', () => undefined);
    const target = req.url ?? '?';
    const port = this.tunnels.get(target);
    if (port === undefined) {
      this.record('deny', 'connect', 'CONNECT', target);
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    this.record('allow', 'connect', 'CONNECT', target);
    const upstream = net.connect(port, LOOPBACK);
    this.tunnelled.add(socket);
    this.tunnelled.add(upstream);
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => {
      this.tunnelled.delete(socket);
      upstream.destroy();
    });
    upstream.on('close', () => {
      this.tunnelled.delete(upstream);
      socket.destroy();
    });
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
  }

  private onUpgrade(req: http.IncomingMessage, socket: net.Socket): void {
    socket.on('error', () => undefined);
    this.record('deny', 'upgrade', req.method ?? '?', req.url ?? '?');
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  }

  /** Allowed requests whose target is not one of the mapped hosts or tunnels: must always be zero. */
  leaks(): LedgerEntry[] {
    return this.ledger.filter((entry) => entry.decision === 'allow' && !(entry.kind === 'connect' ? this.tunnels.has(entry.target) : this.routes.has(entry.target.split('/')[0].split(':')[0])));
  }

  /**
   * Proves, before a run, that the gate refuses non-loopback destinations:
   * a plain HTTP request, a CONNECT tunnel and a WebSocket upgrade to a
   * public host must all get 403 from the gate itself. Throws otherwise.
   */
  async probe(): Promise<void> {
    if (this.address !== LOOPBACK) throw new Error('egress gate must listen on 127.0.0.1 only');
    const raw = (request: string) =>
      new Promise<string>((resolve, reject) => {
        const socket = net.connect(this.port, LOOPBACK);
        let data = '';
        socket.setTimeout(3_000, () => {
          socket.destroy();
          reject(new Error('probe timeout'));
        });
        socket.on('data', (chunk) => {
          data += chunk.toString('latin1');
        });
        socket.on('error', reject);
        socket.on('close', () => resolve(data));
        socket.write(request);
      });
    const http1 = await raw('GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');
    const connect = await raw('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
    // The production Holdr is never reachable from a test browser, and a mapped tunnel only on its exact port.
    const production = await raw('CONNECT node3.example.ts.net:443 HTTP/1.1\r\nHost: node3.example.ts.net:443\r\n\r\n');
    const otherPort = await raw('CONNECT holdr.test:8443 HTTP/1.1\r\nHost: holdr.test:8443\r\n\r\n');
    const upgrade = await raw('GET http://example.com/socket HTTP/1.1\r\nHost: example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    const ipLiteral = await raw('GET http://93.184.215.14/ HTTP/1.1\r\nHost: 93.184.215.14\r\nConnection: close\r\n\r\n');
    for (const [name, response] of [['http', http1], ['connect', connect], ['production', production], ['other port', otherPort], ['upgrade', upgrade], ['ip', ipLiteral]] as const) {
      if (!response.startsWith('HTTP/1.1 403')) throw new Error(`egress gate probe failed (${name})`);
    }
  }

  async close(): Promise<void> {
    for (const socket of this.tunnelled) socket.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
