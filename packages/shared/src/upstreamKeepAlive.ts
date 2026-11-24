import http, { type ClientRequest, type ClientRequestArgs, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

/**
 * Keep-alive on Holdr's own hop: Vite proxies the API (4000) and pools its connections to it.
 *
 * A server closes a connection that has been idle for its keep-alive timeout: 5 s for the API in vite
 * mode (`apps/api/src/ingress/server.ts`) and for Vite (Node's default), and Node 22 waits 1 s more.
 * A proxy that hands that connection to a new request as it closes loses the request (ECONNRESET or
 * "socket hang up"), and the page fails to load until a refresh.
 *
 * So a proxy drops a pooled connection after UPSTREAM_IDLE_TIMEOUT_MS idle, well inside the server's
 * timeout. Node's agent also reads the server's `Keep-Alive: timeout=N` hint and drops the connection
 * one second before N when that is sooner, but only when the agent has an idle timeout of its own:
 * without one it keeps connections until the server closes them. A GET or HEAD that still meets a
 * closed connection, for example after the proxy's event loop was busy past its timer, is sent once
 * more on a new connection.
 */
export const UPSTREAM_IDLE_TIMEOUT_MS = 2_000;

/**
 * The agent's `timeout` is for connections waiting in the pool. Node also starts it on every new
 * connection while it opens, and a busy event loop can let that timer fire before the connection is
 * made, timing out a request the upstream never received. So a new connection gets no timer, and a
 * pooled one loses its timer when a request takes it: the request brings its own.
 */
class UpstreamAgent extends http.Agent {
  constructor() {
    super({ keepAlive: true, scheduling: 'lifo', timeout: UPSTREAM_IDLE_TIMEOUT_MS });
  }

  createConnection(options: ClientRequestArgs, callback?: (err: Error | null, stream: Duplex) => void) {
    return super.createConnection({ ...options, timeout: undefined }, callback);
  }

  reuseSocket(socket: Duplex, request: ClientRequest): void {
    super.reuseSocket(socket, request);
    (socket as Socket).setTimeout(0);
  }
}

/** One proxy's pool of upstream connections: the most recently used first, none reused after UPSTREAM_IDLE_TIMEOUT_MS idle. */
export function createUpstreamAgent(): http.Agent {
  return new UpstreamAgent();
}

/**
 * Used only to send a request again: a new connection every time, closed once its response is complete.
 * It still asks the upstream for keep-alive, so the upstream does not answer `Connection: close`, which
 * the proxy would pass on to the browser and so close the browser's connection (BUG-021).
 */
class FreshConnectionAgent extends http.Agent {
  constructor() {
    super({ keepAlive: true });
  }

  keepSocketAlive(): boolean {
    return false;
  }
}

export function createFreshConnectionAgent(): http.Agent {
  return new FreshConnectionAgent();
}

/**
 * Watches one upstream request. The returned check says whether the request failed only because the
 * pooled connection it was given had already been closed by the upstream: the connection was reused,
 * the error is ECONNRESET ("socket hang up" included), and no byte of a response arrived. Call it
 * before the request has a socket or from a listener of its 'socket' event.
 */
export function watchUpstreamAttempt(request: ClientRequest): (error: Error) => boolean {
  let socket: Socket | undefined;
  let bytesReadBefore = 0;
  let responded = false;
  const assign = (assigned: Socket) => {
    socket = assigned;
    bytesReadBefore = assigned.bytesRead;
  };
  if (request.socket) assign(request.socket);
  else request.once('socket', assign);
  request.once('response', () => { responded = true; });
  return (error) => request.reusedSocket && (error as NodeJS.ErrnoException).code === 'ECONNRESET'
    && !responded && socket !== undefined && socket.bytesRead === bytesReadBefore;
}

/** A browser request that may go upstream a second time: a GET or HEAD without a body whose answer has not started. */
export function mayResend(req: IncomingMessage, res: ServerResponse): boolean {
  const length = req.headers['content-length'];
  return (req.method === 'GET' || req.method === 'HEAD')
    && req.headers['transfer-encoding'] === undefined && (length === undefined || length === '0')
    && !res.headersSent && !res.writableEnded && !res.destroyed;
}
