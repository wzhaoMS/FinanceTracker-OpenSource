import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import test from 'node:test';

import {
  UPSTREAM_IDLE_TIMEOUT_MS,
  createFreshConnectionAgent,
  createUpstreamAgent,
  mayResend,
  watchUpstreamAttempt,
} from './upstreamKeepAlive.js';

interface Upstream {
  port: number;
  /** When the server closes a connection after its last response: keepAliveTimeout plus Node 22's buffer. */
  closesIdleAfterMs: number;
  /** The server's side of each connection, in the order they were opened. */
  sockets: Socket[];
  /** Connections whose other end (the client) closed first. */
  closedByClient: Set<Socket>;
  /** Requests the server's handler received, with the Connection header each one carried. */
  seen: Array<{ method: string; url: string; connection: string | undefined }>;
  close: () => Promise<void>;
}

async function startUpstream(options: {
  keepAliveTimeout?: number;
  handler?: (req: http.IncomingMessage, res: http.ServerResponse, nth: number) => void;
} = {}): Promise<Upstream> {
  const sockets: Socket[] = [];
  const closedByClient = new Set<Socket>();
  const seen: Upstream['seen'] = [];
  const served = new WeakMap<Socket, number>();
  const server = http.createServer({ keepAliveTimeout: options.keepAliveTimeout ?? 5_000, keepAliveTimeoutBuffer: 0 }, (req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', connection: req.headers.connection });
    const nth = (served.get(req.socket) ?? 0) + 1;
    served.set(req.socket, nth);
    if (options.handler) return options.handler(req, res, nth);
    req.resume();
    req.on('end', () => res.end('ok'));
  });
  server.on('connection', (socket) => {
    sockets.push(socket);
    socket.once('end', () => closedByClient.add(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: (server.address() as AddressInfo).port,
    closesIdleAfterMs: server.keepAliveTimeout + (server.keepAliveTimeoutBuffer ?? 0),
    sockets,
    closedByClient,
    seen,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

interface Reply { status: number; body: string; headers: http.IncomingHttpHeaders }

/** Sends one request through `agent`, watching it from before it has a connection, as both proxies do. */
function send(port: number, agent: http.Agent, method = 'GET') {
  const request = http.request({ host: '127.0.0.1', port, path: '/accounts', method, agent });
  const staleConnection = watchUpstreamAttempt(request);
  const reply = new Promise<Reply>((resolve, reject) => {
    request.on('response', (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    request.on('error', reject);
  });
  request.end();
  return { request, staleConnection, reply };
}

function failure(reply: Promise<Reply>): Promise<NodeJS.ErrnoException> {
  return reply.then(() => assert.fail('the request succeeded'), (error: NodeJS.ErrnoException) => error);
}

/** Blocks the event loop, as a busy proxy would: no timer, socket event or request runs meanwhile. */
function blockEventLoop(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) { /* busy */ }
}

/** Waits until the pooled connection's server side closes, and says which end closed it first. */
async function idleClose(upstream: Upstream, agent: http.Agent): Promise<{ closedBy: 'client' | 'server'; afterMs: number }> {
  await send(upstream.port, agent).reply;
  const [socket] = upstream.sockets;
  const idleSince = performance.now();
  await once(socket, 'close');
  return { closedBy: upstream.closedByClient.has(socket) ? 'client' : 'server', afterMs: performance.now() - idleSince };
}

const ECONNRESET = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });

test('the pool drops an idle connection itself, long before a server with the API\'s 5 s keep-alive timeout would', async () => {
  assert.ok(UPSTREAM_IDLE_TIMEOUT_MS < 5_000);
  const upstream = await startUpstream({ keepAliveTimeout: 5_000 });
  const agent = createUpstreamAgent();
  try {
    const { closedBy, afterMs } = await idleClose(upstream, agent);
    assert.equal(closedBy, 'client');
    assert.ok(afterMs >= UPSTREAM_IDLE_TIMEOUT_MS - 50 && afterMs < 5_000, `closed after ${afterMs} ms`);
  } finally {
    agent.destroy();
    await upstream.close();
  }
});

test('the pool also stays inside a shorter keep-alive timeout the server announces', async () => {
  // 2 s announces "Keep-Alive: timeout=2"; Node's agent then keeps the connection one second less.
  const upstream = await startUpstream({ keepAliveTimeout: 2_000 });
  const agent = createUpstreamAgent();
  try {
    const { closedBy, afterMs } = await idleClose(upstream, agent);
    assert.equal(closedBy, 'client');
    assert.ok(afterMs >= 950 && afterMs < 2_000, `closed after ${afterMs} ms`);
  } finally {
    agent.destroy();
    await upstream.close();
  }
});

test('the idle timer runs only while a connection waits in the pool, not while it opens or serves a request', async () => {
  // The second request on a connection is answered after longer than the idle timeout.
  const upstream = await startUpstream({
    handler: (req, res, nth) => {
      req.resume();
      req.on('end', () => {
        if (nth === 2) setTimeout(() => res.end('slow'), UPSTREAM_IDLE_TIMEOUT_MS + 500);
        else res.end('ok');
      });
    },
  });
  const agent = createUpstreamAgent();
  const timeouts = (request: http.ClientRequest) => {
    let count = 0;
    request.on('timeout', () => { count += 1; });
    return () => count;
  };
  try {
    // A busy event loop while a new connection opens: a timer on it would fire before the connect.
    const opening = send(upstream.port, agent);
    const openingTimeouts = timeouts(opening.request);
    blockEventLoop(UPSTREAM_IDLE_TIMEOUT_MS + 200);
    assert.equal((await opening.reply).status, 200);
    assert.equal(openingTimeouts(), 0);

    const serving = send(upstream.port, agent);
    const servingTimeouts = timeouts(serving.request);
    assert.equal((await serving.reply).body, 'slow');
    assert.equal(serving.request.reusedSocket, true);
    assert.equal(servingTimeouts(), 0);
  } finally {
    agent.destroy();
    await upstream.close();
  }
});

test('a pooled connection the server closes as the next request arrives counts as stale, and a resend gets a new one', async () => {
  // A 2 s server announces "timeout=2", so the pool keeps the connection for 1 s; a busy event loop
  // that misses that timer and the server's own reuses it as the server closes it.
  const upstream = await startUpstream({ keepAliveTimeout: 2_000 });
  const agent = createUpstreamAgent();
  const fresh = createFreshConnectionAgent();
  try {
    await send(upstream.port, agent).reply;
    blockEventLoop(upstream.closesIdleAfterMs + 200);
    const stale = send(upstream.port, agent);
    const error = await failure(stale.reply);
    assert.equal(error.code, 'ECONNRESET');
    assert.equal(stale.request.reusedSocket, true);
    assert.equal(stale.staleConnection(error), true);

    const resent = send(upstream.port, fresh);
    assert.equal((await resent.reply).status, 200);
    assert.equal(resent.request.reusedSocket, false);
    // The stale attempt never reached the server's handler: it saw the request once.
    assert.deepEqual(upstream.seen.map((entry) => entry.url), ['/accounts', '/accounts']);
    assert.equal(upstream.sockets.length, 2);
  } finally {
    agent.destroy();
    fresh.destroy();
    await upstream.close();
  }
});

test('other failures are not a stale connection: a new connection, response bytes, a started response, another error', async () => {
  // The server closes a connection on its first request, or answers the second one with a partial status line.
  const upstream = await startUpstream({
    handler: (req, res, nth) => {
      if (req.url === '/accounts' && req.method === 'DELETE') return void req.socket.destroy();
      if (req.method === 'PUT' && nth === 2) return void req.socket.end('HTTP/1.1 200 OK\r\nContent-Le');
      res.end('ok');
    },
  });
  const agent = createUpstreamAgent();
  try {
    const fresh = send(upstream.port, agent, 'DELETE');
    const freshError = await failure(fresh.reply);
    assert.equal(freshError.code, 'ECONNRESET');
    assert.equal(fresh.request.reusedSocket, false);
    assert.equal(fresh.staleConnection(freshError), false);

    await send(upstream.port, agent, 'PUT').reply;
    const partial = send(upstream.port, agent, 'PUT');
    const partialError = await failure(partial.reply);
    assert.equal(partialError.code, 'ECONNRESET');
    assert.equal(partial.request.reusedSocket, true);
    assert.equal(partial.staleConnection(partialError), false, 'response bytes had arrived');

    await send(upstream.port, agent).reply;
    const answered = send(upstream.port, agent);
    await answered.reply;
    assert.equal(answered.request.reusedSocket, true);
    assert.equal(answered.staleConnection(ECONNRESET), false, 'the response had started');

    const waiting = send(upstream.port, agent);
    await once(waiting.request, 'socket');
    assert.equal(waiting.request.reusedSocket, true);
    assert.equal(waiting.staleConnection(ECONNRESET), true, 'control: ECONNRESET at the same moment');
    assert.equal(waiting.staleConnection(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })), false);
    assert.equal(waiting.staleConnection(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })), false);
    await waiting.reply;
  } finally {
    agent.destroy();
    await upstream.close();
  }
});

test('only a GET or HEAD without a body whose answer has not started may be sent again', () => {
  const browser = (method: string, headers: http.IncomingHttpHeaders = {}) => ({ method, headers }) as never;
  const answer = (state: { headersSent?: boolean; writableEnded?: boolean; destroyed?: boolean } = {}) =>
    ({ headersSent: false, writableEnded: false, destroyed: false, ...state }) as never;
  assert.equal(mayResend(browser('GET'), answer()), true);
  assert.equal(mayResend(browser('HEAD'), answer()), true);
  assert.equal(mayResend(browser('GET', { 'content-length': '0' }), answer()), true);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'get']) {
    assert.equal(mayResend(browser(method), answer()), false, method);
  }
  assert.equal(mayResend(browser('GET', { 'content-length': '2' }), answer()), false);
  assert.equal(mayResend(browser('GET', { 'transfer-encoding': 'chunked' }), answer()), false);
  assert.equal(mayResend(browser('GET'), answer({ headersSent: true })), false);
  assert.equal(mayResend(browser('GET'), answer({ writableEnded: true })), false);
  assert.equal(mayResend(browser('GET'), answer({ destroyed: true })), false);
});

test('a resend goes out on a new connection that still asks for keep-alive, closed after its response', async () => {
  const upstream = await startUpstream();
  const fresh = createFreshConnectionAgent();
  try {
    for (let i = 0; i < 2; i++) {
      const { request, reply } = send(upstream.port, fresh);
      const { status, headers } = await reply;
      assert.equal(status, 200);
      assert.notEqual(headers.connection, 'close');
      assert.equal(request.reusedSocket, false);
    }
    assert.equal(upstream.sockets.length, 2);
    assert.deepEqual(upstream.seen.map((entry) => entry.connection), ['keep-alive', 'keep-alive']);
    for (const socket of upstream.sockets) {
      if (!socket.destroyed) await once(socket, 'close');
      assert.ok(upstream.closedByClient.has(socket));
    }
  } finally {
    fresh.destroy();
    await upstream.close();
  }
});
