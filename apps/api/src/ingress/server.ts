import fs from 'node:fs';
import http, { type RequestListener, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebReleaseError } from '@finance-tracker/shared/web-release';
import { classifyListenerRequest } from './listenerProfile.js';
import { parseIngressTarget } from './requestTarget.js';
import { API_CSP, sendRefusal } from './securityHeaders.js';
import type { ListenerConfig } from './types.js';

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

export function createRefusalLogger(listener: string, log: (line: string) => void, now = Date.now) {
  const counts = new Map<string, { count: number; last: number }>();
  return (code: string, method: string): void => {
    const current = counts.get(code) ?? { count: 0, last: -Infinity };
    current.count++;
    const time = now();
    if (time - current.last >= 60_000) {
      log(`[holdr-ingress] refused ${code} listener=${listener} method=${METHODS.has(method) ? method : 'OTHER'} count=${current.count}`);
      current.count = 0;
      current.last = time;
    }
    counts.set(code, current);
  };
}

export function createRequestListener(app: RequestListener, config: ListenerConfig, log?: (line: string) => void): RequestListener {
  const refused = log ? createRefusalLogger(config.listener, log) : undefined;
  return (req, res) => {
    req.holdrRefusalLog = refused;
    if (!METHODS.has(req.method ?? '')) return sendRefusal(req, res, 405, 'method-not-allowed');
    if (req.headers.upgrade !== undefined) return sendRefusal(req, res, 400, 'upgrade-not-supported');
    const target = parseIngressTarget(req.url);
    if ('refuse' in target) return sendRefusal(req, res, target.refuse, target.code);
    const facts = classifyListenerRequest(req, config);
    if ('refuse' in facts) return sendRefusal(req, res, facts.refuse, facts.code);
    Object.defineProperty(req, 'holdrIngress', { value: facts, writable: false, configurable: false });
    req.holdrTarget = target;
    if (req.headers.expect?.toLowerCase() === '100-continue') res.writeContinue();
    app(req, res);
  };
}

export function attachServerGuards(server: Server, config: ListenerConfig): void {
  server.headersTimeout = 20_000;
  server.requestTimeout = 300_000;
  server.keepAliveTimeout = config.mode === 'dist' && config.listener === 'ingress' ? 100_000 : 5_000;
  const retiring = new WeakSet<Duplex>();
  const refuse = (socket: Duplex, status: number, code: string) => {
    if (socket.destroyed || retiring.has(socket)) return;
    retiring.add(socket);
    const timer = setTimeout(() => socket.destroy(), 1_000);
    timer.unref();
    socket.once('close', () => clearTimeout(timer));
    socket.on('error', () => socket.destroy());
    socket.end([
      `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}`,
      'Connection: close', 'Content-Length: 0', 'Content-Type: application/json; charset=utf-8',
      'Cache-Control: no-store', 'X-Content-Type-Options: nosniff', 'Referrer-Policy: no-referrer',
      'Cross-Origin-Resource-Policy: same-origin', 'X-Frame-Options: DENY',
      `Content-Security-Policy: ${API_CSP}`, `X-Holdr-Error: ${code}`, '', '',
    ].join('\r\n'), () => socket.destroy());
  };
  server.on('connect', (_req, socket) => refuse(socket, 405, 'method-not-allowed'));
  server.on('upgrade', (_req, socket) => refuse(socket, 400, 'upgrade-not-supported'));
  server.on('checkContinue', (req, res) => server.emit('request', req, res));
  server.on('checkExpectation', (req, res) => sendRefusal(req, res, 417, 'expectation-not-supported'));
  server.on('clientError', (error, socket) => {
    const overflow = (error as NodeJS.ErrnoException).code === 'HPE_HEADER_OVERFLOW';
    refuse(socket, overflow ? 431 : 400, overflow ? 'headers-too-large' : 'bad-request');
  });
}

export interface SocketIdentity { readonly dev: string; readonly ino: string }

/** A2 supplies socket validation; B must still supply the overall runtime integration. */
export interface SocketSafety {
  beforeListen(socketPath: string): Promise<void>;
  afterListen(socketPath: string, identity?: SocketIdentity): Promise<void>;
}

export async function listenChecked(server: Server, config: ListenerConfig, socketSafety?: SocketSafety): Promise<void> {
  const socket = config.mode === 'dist' && config.listener === 'ingress';
  if (socket) {
    if (!socketSafety) throw new WebReleaseError('E0I_SOCKET_UNVERIFIED');
    await socketSafety.beforeListen(config.socketPath);
    // Only the verified provider may remove a proven stale socket.
    try {
      fs.lstatSync(config.socketPath);
      throw new WebReleaseError('E0I_SOCKET_IN_USE');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    const listening = () => { server.off('error', reject); resolve(); };
    if (socket) server.listen({ path: config.socketPath, readableAll: false, writableAll: false }, listening);
    else server.listen({ host: config.mode === 'dev' ? config.host ?? '127.0.0.1' : '127.0.0.1', port: config.port }, listening);
  });
  try {
    if (socket) {
      const stat = fs.lstatSync(config.socketPath, { bigint: true });
      if (!stat.isSocket() || (process.getuid && stat.uid !== BigInt(process.getuid())) || (stat.mode & 0o077n) !== 0n) {
        throw new WebReleaseError('E0I_BIND_UNEXPECTED');
      }
      await socketSafety!.afterListen(config.socketPath, { dev: stat.dev.toString(), ino: stat.ino.toString() });
    } else if (config.mode !== 'dev') {
      const address = server.address();
      if (!address || typeof address === 'string' || address.address !== '127.0.0.1' || address.family !== 'IPv4' || address.port !== config.port) {
        throw new WebReleaseError('E0I_BIND_UNEXPECTED');
      }
    }
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
}

export async function startIngressServers(app: RequestListener, configs: readonly ListenerConfig[], options: {
  socketSafety?: SocketSafety; log?: (line: string) => void;
} = {}): Promise<Server[]> {
  const servers: Server[] = [];
  try {
    for (const config of configs) {
      // Our exact-one-Host check also supplies the JSON/error headers on missing Host.
      const server = http.createServer({ requireHostHeader: false }, createRequestListener(app, config, options.log));
      servers.push(server);
      attachServerGuards(server, config);
      await listenChecked(server, config, options.socketSafety);
    }
    return servers;
  } catch (error) {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
      server.closeAllConnections();
      if (!server.listening) return resolve();
      server.close(() => resolve());
    })));
    throw error;
  }
}
