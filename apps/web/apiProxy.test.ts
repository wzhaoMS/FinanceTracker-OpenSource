import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import http, { type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { createServer as createViteServer, loadConfigFromFile, type InlineConfig, type Logger, type ViteDevServer } from 'vite';

// P-NET: refuses any listener beyond 127.0.0.1 or ::1 in this process.
import '../../scripts/loopback-only.mjs';
import { HOLDR_API_PATH_PREFIXES } from '../../packages/shared/src/apiPaths.js';
import { UPSTREAM_IDLE_TIMEOUT_MS } from '../../packages/shared/src/upstreamKeepAlive.js';
import { API_PROXY_CONTEXT, API_PROXY_PREFIXES, DEFAULT_API_TARGET, browserAddress, createApiProxy } from './apiProxy.js';

const webRoot = fileURLToPath(new URL('.', import.meta.url));
const configFile = fileURLToPath(new URL('./vite.config.ts', import.meta.url));

interface Upstream {
  url: string;
  seen: Array<{ method: string; url: string; headers: IncomingHttpHeaders }>;
  connections: () => number;
  /** The upstream's side of each connection, in the order they were opened. */
  sockets: Socket[];
  /** Connections the proxy closed before the upstream did. */
  closedByProxy: Set<Socket>;
  /** When the upstream closes an idle connection: its keep-alive timeout plus Node 22's buffer. */
  closesIdleAfterMs: number;
  close: () => Promise<void>;
}

async function startUpstream(handler?: http.RequestListener, options: { keepAliveTimeout?: number } = {}): Promise<Upstream> {
  const seen: Upstream['seen'] = [];
  const sockets: Socket[] = [];
  const closedByProxy = new Set<Socket>();
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    if (handler) return handler(req, res);
    req.resume();
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
  });
  if (options.keepAliveTimeout !== undefined) {
    server.keepAliveTimeout = options.keepAliveTimeout;
    server.keepAliveTimeoutBuffer = 0;
  }
  server.on('connection', (socket) => {
    sockets.push(socket);
    socket.once('end', () => closedByProxy.add(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    connections: () => sockets.length,
    sockets,
    closedByProxy,
    closesIdleAfterMs: server.keepAliveTimeout + (server.keepAliveTimeoutBuffer ?? 0),
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** A port the OS just handed out. Vite reads `port: 0` as its default 5173, so every test would share 5173+. */
async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startVite(config: InlineConfig): Promise<{ vite: ViteDevServer; url: string }> {
  const vite = await createViteServer({
    root: webRoot,
    logLevel: 'silent',
    clearScreen: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    ...config,
    server: { host: '127.0.0.1', port: await freePort(), watch: null, ...config.server },
  });
  await vite.listen();
  return { vite, url: `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}` };
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  clientPort: number;
}

/**
 * One request on a connection of its own unless `agent` says otherwise. Node's global agent keeps
 * connections alive, and handing a later test a pooled socket to an earlier test's closed server
 * fails that test with ECONNRESET.
 */
function send(base: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string; agent?: http.Agent } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method: init.method ?? 'GET', headers: init.headers, agent: init.agent ?? false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, clientPort: req.socket?.localPort ?? 0 }));
    });
    req.on('error', reject);
    req.end(init.body);
  });
}

test('proxies API roots but only the owner namespace of card sync, on whole segments', () => {
  const context = new RegExp(API_PROXY_CONTEXT);
  assert.equal(DEFAULT_API_TARGET, 'http://127.0.0.1:4000');
  assert.ok(HOLDR_API_PATH_PREFIXES.includes('card-sync'));
  for (const prefix of API_PROXY_PREFIXES) {
    for (const path of [`/${prefix}`, `/${prefix}/`, `/${prefix}?x=1`, `/${prefix}/a/b?c=d`]) {
      assert.ok(context.test(path), path);
    }
  }
  for (const path of ['/', '/index.html', '/src/main.tsx', '/@vite/client', '/node_modules/.vite/deps/react.js',
    '/healthz', '/accountsx', '/authority', '/importer', '/api/health', '//health', '/Health',
    '/card-sync', '/card-sync/capabilities', '/card-sync/pairings/redeem', '/card-sync/runs',
    '/card-sync/observations', '/card-sync/imports/preview', '/card-sync/imports/commit',
    '/card-sync/ownerish/state',
    // The API's direct-only path (apps/api/src/ingress/classify.ts): local scripts reach it on 127.0.0.1:4000, never a browser.
    '/release', '/release/attestation']) {
    assert.equal(context.test(path), false, path);
  }
});

test('names the browser by its peer address, or by the last X-Forwarded-For hop from a loopback peer (Tailscale Serve)', () => {
  const peer = (remoteAddress: string | undefined, forwardedFor?: string | string[]) =>
    browserAddress({ socket: { remoteAddress }, headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor } } as never);
  assert.equal(peer('127.0.0.1', '100.101.1.2'), '100.101.1.2');
  assert.equal(peer('::1', '6.6.6.6, 100.101.1.2'), '100.101.1.2');
  assert.equal(peer('::ffff:127.0.0.1', ['6.6.6.6', '::ffff:100.101.1.3']), '100.101.1.3');
  assert.equal(peer('127.0.0.1'), '127.0.0.1');
  assert.equal(peer('127.0.0.1', 'not-an-ip'), '127.0.0.1');
  // A LAN browser (HOLDR_LAN_HTTP=1) connects directly; whatever it claims is ignored.
  assert.equal(peer('192.168.24.20', '127.0.0.1'), '192.168.24.20');
  assert.equal(peer('::ffff:100.101.1.4', '1.2.3.4'), '100.101.1.4');
  assert.equal(peer(undefined, '1.2.3.4'), 'unknown');
});

test('the dev config binds loopback only and allows the HOLDR_PUBLIC_ORIGIN host', async () => {
  const saved = process.env.HOLDR_PUBLIC_ORIGIN;
  try {
    delete process.env.HOLDR_PUBLIC_ORIGIN;
    const plain = await loadConfigFromFile({ command: 'serve', mode: 'development' }, configFile, webRoot, 'silent');
    assert.equal(plain?.config.server?.host, '127.0.0.1');
    assert.ok(Array.isArray(plain?.config.server?.allowedHosts));
    process.env.HOLDR_PUBLIC_ORIGIN = 'https://Holdr.example.ts.net';
    const served = await loadConfigFromFile({ command: 'serve', mode: 'development' }, configFile, webRoot, 'silent');
    assert.ok((served?.config.server?.allowedHosts as string[]).includes('holdr.example.ts.net'));
  } finally {
    if (saved === undefined) delete process.env.HOLDR_PUBLIC_ORIGIN;
    else process.env.HOLDR_PUBLIC_ORIGIN = saved;
  }
});

let upstream: Upstream;
let app: { vite: ViteDevServer; url: string };

before(async () => {
  upstream = await startUpstream();
  process.env.HOLDR_API_TARGET = upstream.url;
  app = await startVite({ configFile });
});

after(async () => {
  // Every result is reported by now. About one run in twenty, the process's own stdio pipes
  // (which Vite's dev server listens on for its parent going away) still hold it open after every
  // server has closed; exit rather than hang. The timer never holds the process open itself.
  setTimeout(() => process.exit(), 10_000).unref();
  await app?.vite.close();
  await upstream?.close();
  delete process.env.HOLDR_API_TARGET;
});

test('the dev config strips credentials, forwarding and Tailscale headers and names the browser once', async () => {
  upstream.seen.length = 0;
  // Shaped like a request from Tailscale Serve: loopback peer, client address last in X-Forwarded-For.
  const reply = await send(app.url, '/accounts/x/transactions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer abc',
      'Proxy-Authorization': 'Basic abc',
      'X-Forwarded-For': '6.6.6.6, 100.101.1.2',
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-Host': 'evil.example',
      'X-Forwarded-Port': '443',
      Forwarded: 'for=6.6.6.6',
      'X-Real-IP': '6.6.6.6',
      Via: '1.1 evil',
      'Tailscale-User-Login': 'alex@example.com',
      'Tailscale-User-Name': 'Alex',
      'Tailscale-Headers-Info': 'https://tailscale.com/s/serve-headers',
      Cookie: 'holdr_session=abc',
      Origin: 'https://holdr.example.ts.net',
      'X-Holdr-Request': '1',
      'Content-Type': 'application/json',
    },
    body: '{"symbol":"AAPL"}',
  });
  assert.equal(reply.status, 200);
  const [seen] = upstream.seen;
  assert.equal(seen.url, '/accounts/x/transactions');
  assert.equal(seen.headers['x-forwarded-for'], '100.101.1.2');
  for (const name of Object.keys(seen.headers)) {
    assert.ok(!/^(authorization|proxy-authorization|forwarded|x-real-ip|via|tailscale-.*)$/.test(name), name);
    assert.ok(!name.startsWith('x-forwarded-') || name === 'x-forwarded-for', name);
  }
  assert.equal(seen.headers.cookie, 'holdr_session=abc');
  assert.equal(seen.headers.origin, 'https://holdr.example.ts.net');
  assert.equal(seen.headers['x-holdr-request'], '1');
});

test('requests marked as Tailscale Funnel traffic get neither the app nor the API', async () => {
  upstream.seen.length = 0;
  for (const path of ['/', '/src/main.tsx', '/accounts', '/auth/login']) {
    const reply = await send(app.url, path, { headers: { 'Tailscale-Funnel-Request': '?1' } });
    assert.equal(reply.status, 403, path);
  }
  assert.deepEqual(upstream.seen, []);
});

test('API calls reuse one upstream connection and keep the browser connection alive (BUG-021)', async () => {
  const before = upstream.connections();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const replies: Reply[] = [];
  for (const path of ['/health', '/portfolio/history?range=ALL', '/accounts', '/manual-prices', '/auth/me', '/cash-events']) {
    replies.push(await send(app.url, path, { agent }));
  }
  agent.destroy();
  for (const reply of replies) {
    assert.equal(reply.status, 200);
    assert.notEqual(reply.headers.connection, 'close');
  }
  assert.equal(new Set(replies.map((reply) => reply.clientPort)).size, 1, 'browser connection was torn down');
  assert.ok(upstream.connections() - before <= 1, 'proxy opened a new upstream connection per request');
});

test('the web server keeps an idle connection longer than the LAN gateway\'s pool keeps one to it', () => {
  // The gateway (apps/api/src/ingress/lanGateway.ts) pools its connections to this server the same way.
  assert.ok((app.vite.httpServer as http.Server).keepAliveTimeout > UPSTREAM_IDLE_TIMEOUT_MS);
});

test('a page load that keeps the proxy busy while it opens a new API connection still loads', async () => {
  const api = await startUpstream();
  const options = createApiProxy(api.url);
  const configure = options.configure!;
  options.configure = (proxy, proxyOptions) => {
    configure(proxy, proxyOptions);
    // Runs after the proxy's own listener, while the new connection is still opening.
    proxy.on('proxyReq', (proxyReq) => {
      if (!proxyReq.socket?.connecting) return;
      const until = performance.now() + UPSTREAM_IDLE_TIMEOUT_MS + 200;
      while (performance.now() < until) { /* the proxy's event loop is busy */ }
    });
  };
  const proxy = await startVite({ configFile: false, server: { proxy: { [API_PROXY_CONTEXT]: options } } });
  try {
    const reply = await send(proxy.url, '/accounts');
    assert.equal(reply.status, 200);
    assert.deepEqual(JSON.parse(reply.body), { ok: true });
  } finally {
    await proxy.vite.close();
    await api.close();
  }
});

test('the proxy closes an idle API connection itself, before the API\'s 5 s keep-alive timeout would', async () => {
  const api = await startUpstream(undefined, { keepAliveTimeout: 5_000 });
  const proxy = await startVite({ configFile: false, server: { proxy: { [API_PROXY_CONTEXT]: createApiProxy(api.url) } } });
  // A browser keeps its connection alive; a client that sends Connection: close would have it forwarded.
  const browser = new http.Agent({ keepAlive: true });
  try {
    assert.equal((await send(proxy.url, '/accounts', { agent: browser })).status, 200);
    const idleSince = performance.now();
    const [socket] = api.sockets;
    assert.equal(socket.destroyed, false);
    await new Promise((resolve) => socket.once('close', resolve));
    const idleMs = performance.now() - idleSince;
    assert.ok(api.closedByProxy.has(socket), 'the API closed the connection first');
    assert.ok(idleMs >= UPSTREAM_IDLE_TIMEOUT_MS - 50 && idleMs < 5_000, `closed after ${idleMs} ms`);
    assert.equal((await send(proxy.url, '/accounts', { agent: browser })).status, 200);
    assert.equal(api.connections(), 2);
  } finally {
    browser.destroy();
    await proxy.vite.close();
    await api.close();
  }
});

/**
 * The keep-alive race behind failed page loads: the API closes a pooled connection just as the proxy
 * hands it to the next request. The API here announces a 2 s keep-alive timeout, so the proxy keeps
 * the connection for 1 s; the proxy's event loop is then kept busy past both timers, as a page load
 * can keep Vite, and the next request goes out on the connection the API is closing.
 */
async function raceThroughProxy(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const api = await startUpstream(undefined, { keepAliveTimeout: 2_000 });
  const options = createApiProxy(api.url);
  const configure = options.configure!;
  const attempts: string[] = [];
  let busyUntil = 0;
  options.configure = (proxy, proxyOptions) => {
    configure(proxy, proxyOptions);
    proxy.on('start', () => { while (performance.now() < busyUntil) { /* the proxy's event loop is busy */ } });
    proxy.on('proxyReq', (_proxyReq, req) => { attempts.push(`${req.method} ${req.url}`); });
  };
  const proxy = await startVite({ configFile: false, server: { proxy: { [API_PROXY_CONTEXT]: options } } });
  const browser = new http.Agent({ keepAlive: true });
  try {
    assert.equal((await send(proxy.url, '/accounts', { agent: browser })).status, 200);
    assert.equal(api.sockets.length, 1);
    busyUntil = performance.now() + api.closesIdleAfterMs + 200;
    const reply = await send(proxy.url, path, { ...init, agent: browser });
    return { reply, attempts: attempts.slice(1), apiSaw: api.seen.slice(1).map((entry) => `${entry.method} ${entry.url}`) };
  } finally {
    browser.destroy();
    await proxy.vite.close();
    await api.close();
  }
}

test('a page load that meets an API connection closing under it still loads: the GET is sent once more, on a new connection', async () => {
  const { reply, attempts, apiSaw } = await raceThroughProxy('/portfolio/history?range=ALL');
  assert.equal(reply.status, 200);
  assert.deepEqual(JSON.parse(reply.body), { ok: true });
  assert.notEqual(reply.headers.connection, 'close');
  assert.deepEqual(attempts, ['GET /portfolio/history?range=ALL', 'GET /portfolio/history?range=ALL']);
  assert.deepEqual(apiSaw, ['GET /portfolio/history?range=ALL']);
});

test('a write that meets an API connection closing under it is never sent twice', async () => {
  const { reply, attempts, apiSaw } = await raceThroughProxy('/accounts/x/transactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"symbol":"AAPL"}',
  });
  assert.equal(reply.status, 502);
  assert.deepEqual(JSON.parse(reply.body), { error: 'Holdr API unreachable' });
  assert.deepEqual(attempts, ['POST /accounts/x/transactions']);
  assert.deepEqual(apiSaw, []);
});

/** Sends `path` exactly as given: no URL parsing, so dot segments and encodings reach the server. */
function sendRaw(base: string, path: string, method = 'GET'): Promise<Reply> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path, method, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, clientPort: req.socket?.localPort ?? 0 }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the file boundary runs before the API proxy: API prefixes reach neither files nor, when malformed, the API', async () => {
  upstream.seen.length = 0;
  const packageJson = fileURLToPath(new URL('../../package.json', import.meta.url));
  for (const path of [
    '/accounts/../package.json',
    '/health/../../package.json',
    '/auth/%2e%2e/%2e%2e/package.json',
    '/accounts%2F..%2F..%2Fpackage.json',
    '/portfolio/..%5C..%5Cpackage.json',
    `/health/../@fs${packageJson}`,
  ]) {
    const reply = await sendRaw(app.url, path);
    assert.equal(reply.status, 403, path);
    assert.doesNotMatch(reply.body, /"workspaces"|"name"/, path);
  }
  assert.equal(upstream.seen.length, 0, 'nothing malformed was forwarded to the API');

  // Ordinary API requests pass the boundary, every method included.
  for (const [method, path] of [['POST', '/auth/login'], ['GET', '/portfolio/history?range=ALL'], ['DELETE', '/accounts/a%20b']]) {
    const reply = await sendRaw(app.url, path, method);
    assert.equal(reply.status, 200, `${method} ${path}`);
  }
  assert.deepEqual(upstream.seen.map((entry) => `${entry.method} ${entry.url}`),
    ['POST /auth/login', 'GET /portfolio/history?range=ALL', 'DELETE /accounts/a%20b']);
});

test('look-alike paths are not proxied', async () => {
  upstream.seen.length = 0;
  for (const path of ['/healthz', '/accountsx', '/authority']) await send(app.url, path);
  assert.deepEqual(upstream.seen, []);
});

test('neither the app nor the API sends CORS headers to other origins', async () => {
  for (const path of ['/health', '/', '/src/main.tsx']) {
    const reply = await send(app.url, path, { headers: { Origin: 'http://localhost:3000' } });
    assert.equal(reply.headers['access-control-allow-origin'], undefined, path);
  }
});

test('a down API yields a 502 JSON error instead of a hang', async () => {
  const gone = await startUpstream();
  const target = gone.url;
  await gone.close();
  const proxy = await startVite({ configFile: false, server: { proxy: { [API_PROXY_CONTEXT]: createApiProxy(target) } } });
  try {
    const reply = await send(proxy.url, '/accounts');
    assert.equal(reply.status, 502);
    assert.deepEqual(JSON.parse(reply.body), { error: 'Holdr API unreachable' });
  } finally {
    await proxy.vite.close();
  }
});

test('a hung API yields a 504 JSON error after the proxy timeout', async () => {
  const hung = await startUpstream(() => { /* never answers */ });
  const proxy = await startVite({ configFile: false, server: { proxy: { [API_PROXY_CONTEXT]: createApiProxy(hung.url, { timeoutMs: 300 }) } } });
  try {
    const started = Date.now();
    const reply = await send(proxy.url, '/portfolio/history?range=ALL');
    assert.equal(reply.status, 504);
    assert.deepEqual(JSON.parse(reply.body), { error: 'Holdr API timed out' });
    assert.ok(Date.now() - started < 5_000);
  } finally {
    await proxy.vite.close();
    await hung.close();
  }
});

/** Far more than the OS buffers between the API, the proxy and a browser hold, so a browser that stops reading holds the proxy up. */
const LARGE_ANSWER = Buffer.from(JSON.stringify({ rows: 'x'.repeat(16 * 1024 * 1024) }));

/** Vite proxying the API at `target`, noting each answer the proxy starts (and when the API's headers arrived) and each error Vite logs. */
async function startWatchedProxy(target: string, options: { timeoutMs: number; stallCapMs: number }) {
  const proxyOptions = createApiProxy(target, options);
  const answers: Array<{ res: http.ServerResponse; headersAt: number }> = [];
  const configure = proxyOptions.configure!;
  proxyOptions.configure = (proxy, opts) => {
    configure(proxy, opts);
    proxy.on('proxyRes', (_proxyRes, _req, res) => { answers.push({ res, headersAt: performance.now() }); });
  };
  // What the dev server would write to web.log as an error (without colours, as when written to a file on the Mac).
  const errors: Array<{ at: number; text: string }> = [];
  const quiet = () => {};
  const customLogger: Logger = {
    hasWarned: false,
    info: quiet,
    warn: quiet,
    warnOnce: quiet,
    clearScreen: quiet,
    error: (text) => { errors.push({ at: performance.now(), text: stripVTControlCharacters(text) }); },
    hasErrorLogged: () => false,
  };
  const proxy = await startVite({ configFile: false, customLogger, server: { proxy: { [API_PROXY_CONTEXT]: proxyOptions } } });
  return { ...proxy, answers, errors };
}

/**
 * A GET from a browser that, when `stalled`, stops reading as soon as the answer starts, like a phone locked mid-load.
 * Like a browser it asks for keep-alive, which the proxy passes on: the API then keeps its connection open after answering.
 */
function browse(base: string, path: string, { stalled = false } = {}) {
  let response: http.IncomingMessage | undefined;
  let bytes = 0;
  let lastByteAt = 0;
  let started!: () => void;
  const answerStarted = new Promise<void>((resolve) => { started = resolve; });
  let request!: http.ClientRequest;
  /** How the answer ended for the browser: whole, or cut off by its connection closing. */
  const finished = new Promise<{ whole: boolean; bytes: number }>((resolve, reject) => {
    request = http.get(`${base}${path}`, { agent: false, headers: { Connection: 'keep-alive' } }, (res) => {
      response = res;
      res.on('data', (chunk: Buffer) => { bytes += chunk.length; lastByteAt = performance.now(); });
      if (stalled) res.pause();
      res.on('error', () => { /* reported by 'close' */ });
      res.on('close', () => resolve({ whole: res.complete, bytes }));
      started();
    });
    request.on('error', (err) => { if (!response) reject(err); });
  });
  return {
    answerStarted,
    finished,
    bytes: () => bytes,
    lastByteAt: () => lastByteAt,
    readOn: () => response?.resume(),
    stopReading: () => response?.pause(),
    close: () => request.destroy(),
  };
}

/** An API that sends its headers and a byte at once, then a byte every `everyMs`; at `forMs` it sends `last`, or goes silent. */
function tricklingApi(everyMs: number, forMs: number, last?: Buffer): http.RequestListener {
  return (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('[');
    const ticker = setInterval(() => res.write(' '), everyMs);
    const lastly = setTimeout(() => {
      clearInterval(ticker);
      if (last) res.end(last);
    }, forMs);
    res.on('close', () => { clearInterval(ticker); clearTimeout(lastly); });
  };
}

async function until(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`still waiting for ${what}`);
    await sleep(10);
  }
}

/** Sleeps until `ms` after `since` (a performance.now() reading). */
const sleepUntil = (since: number, ms: number) => sleep(Math.max(0, since + ms - performance.now()));

/** `promise`, or a failure naming `what` if it takes longer than `ms`. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, sleep(ms).then((): never => { throw new Error(`still waiting for ${what}`); })]);
}

test('a browser that stops reading an answer and reads on within the stall cap gets all of it, and nothing is logged', { timeout: 30_000 }, async () => {
  const api = await startUpstream((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(LARGE_ANSWER);
  });
  const proxy = await startWatchedProxy(api.url, { timeoutMs: 200, stallCapMs: 3_000 });
  const browser = browse(proxy.url, '/spending/payment-reconciliation', { stalled: true });
  try {
    await browser.answerStarted;
    // Five of the proxy's waits: the API's connection has been silent all that time, because the proxy stopped reading it.
    await sleep(1_000);
    assert.equal(proxy.answers[0].res.writableNeedDrain, true, 'the browser did not hold the proxy up');
    assert.deepEqual(proxy.errors, []);
    browser.readOn();
    assert.deepEqual(await browser.finished, { whole: true, bytes: LARGE_ANSWER.length });
    assert.deepEqual(proxy.errors, []);
  } finally {
    browser.close();
    await proxy.vite.close();
    await api.close();
  }
});

test('a browser still not reading at the stall cap has both connections closed, logged as a stalled client and not as the API', { timeout: 30_000 }, async () => {
  const api = await startUpstream((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(LARGE_ANSWER);
  });
  // The cap falls between two of the proxy's waits (400, 800, 1 200 ms): it is kept to, not rounded up to the next wait.
  const proxy = await startWatchedProxy(api.url, { timeoutMs: 400, stallCapMs: 1_000 });
  const browser = browse(proxy.url, '/spending/payment-reconciliation', { stalled: true });
  try {
    await browser.answerStarted;
    const [apiConnection] = api.sockets;
    assert.equal(apiConnection.destroyed, false);
    await until(() => proxy.errors.length > 0, 'the proxy to give up');
    const [{ at, text }] = proxy.errors;
    const [{ res, headersAt }] = proxy.answers;
    const closedAfterMs = at - headersAt;
    assert.ok(closedAfterMs >= 1_000 - 50 && closedAfterMs < 1_000 + 150, `closed ${closedAfterMs} ms after the API's headers`);
    assert.match(text, /http proxy error: \/spending\/payment-reconciliation\n/);
    assert.match(text, /\nError: client stalled: the browser stopped reading and 1000 ms have passed since the API answered\n/);
    assert.doesNotMatch(text, /upstream timed out/);
    assert.equal(res.destroyed, true, 'the browser\'s connection is still open');
    await until(() => apiConnection.destroyed, 'the API\'s connection to close', 1_000);
    // Reading on, the browser gets what was already on its way, then finds its connection closed.
    browser.readOn();
    const { whole, bytes } = await within(browser.finished, 2_000, 'the browser\'s connection to end');
    assert.equal(whole, false);
    assert.ok(bytes < LARGE_ANSWER.length, `${bytes} bytes`);
    await sleep(100);
    assert.equal(proxy.errors.length, 1, proxy.errors.map((error) => error.text).join('\n'));
  } finally {
    browser.close();
    await proxy.vite.close();
    await api.close();
  }
});

test('an API that goes silent mid-answer while the browser reads times out after the proxy timeout, and the browser\'s connection ends', { timeout: 30_000 }, async () => {
  const api = await startUpstream((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"rows":['); // and nothing more
  });
  const proxy = await startWatchedProxy(api.url, { timeoutMs: 300, stallCapMs: 60_000 });
  const browser = browse(proxy.url, '/spending/payment-reconciliation');
  try {
    await browser.answerStarted;
    const [apiConnection] = api.sockets;
    await until(() => proxy.errors.length > 0, 'the proxy to give up');
    const [{ at, text }] = proxy.errors;
    const timedOutAfterMs = at - proxy.answers[0].headersAt;
    assert.ok(timedOutAfterMs >= 300 - 50 && timedOutAfterMs < 300 + 1_000, `timed out ${timedOutAfterMs} ms after the API's headers`);
    assert.match(text, /http proxy error: \/spending\/payment-reconciliation\n/);
    assert.match(text, /\nError: upstream timed out\n/);
    // The browser is not left waiting for the rest of an answer that will never come.
    assert.deepEqual(await within(browser.finished, 2_000, 'the browser\'s connection to end'), { whole: false, bytes: '{"rows":['.length });
    assert.ok(performance.now() - at < 1_000, `the browser's connection ended ${performance.now() - at} ms after the timeout`);
    await until(() => apiConnection.destroyed, 'the API\'s connection to close', 1_000);
    assert.equal(proxy.errors.length, 1);
  } finally {
    browser.close();
    await proxy.vite.close();
    await api.close();
  }
});

test('an API that sends its headers and then nothing still yields a 504 JSON error after the proxy timeout', { timeout: 30_000 }, async () => {
  const api = await startUpstream((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.flushHeaders(); // and no answer
  });
  const proxy = await startWatchedProxy(api.url, { timeoutMs: 300, stallCapMs: 60_000 });
  try {
    const reply = await send(proxy.url, '/spending/payment-reconciliation');
    assert.equal(reply.status, 504);
    assert.deepEqual(JSON.parse(reply.body), { error: 'Holdr API timed out' });
    assert.equal(proxy.errors.length, 1, proxy.errors.map((error) => error.text).join('\n'));
    assert.match(proxy.errors[0].text, /\nError: upstream timed out\n/);
  } finally {
    await proxy.vite.close();
    await api.close();
  }
});

test('an API that closes its connection mid-answer has the browser\'s connection closed too, logged as upstream closed mid-answer', { timeout: 30_000 }, async () => {
  const api = await startUpstream((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"rows":[');
    setTimeout(() => res.destroy(), 50); // and the rest never comes
  });
  const proxy = await startWatchedProxy(api.url, { timeoutMs: 60_000, stallCapMs: 60_000 });
  const browser = browse(proxy.url, '/spending/payment-reconciliation');
  try {
    assert.deepEqual(await within(browser.finished, 2_000, 'the browser\'s connection to end'), { whole: false, bytes: '{"rows":['.length });
    await until(() => proxy.errors.length > 0, 'the proxy to log the cut');
    await sleep(100);
    assert.equal(proxy.errors.length, 1, proxy.errors.map((error) => error.text).join('\n'));
    const [{ text }] = proxy.errors;
    assert.match(text, /http proxy error: \/spending\/payment-reconciliation\n/);
    assert.match(text, /\nError: upstream closed mid-answer\n/);
  } finally {
    browser.close();
    await proxy.vite.close();
    await api.close();
  }
});

test('an API that resets its connection mid-answer has the browser\'s connection closed too, logged once, by the reset', { timeout: 30_000 }, async () => {
  const api = await startUpstream((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"rows":[');
    setTimeout(() => res.socket?.resetAndDestroy(), 50);
  });
  const proxy = await startWatchedProxy(api.url, { timeoutMs: 60_000, stallCapMs: 60_000 });
  const browser = browse(proxy.url, '/spending/payment-reconciliation');
  try {
    assert.deepEqual(await within(browser.finished, 2_000, 'the browser\'s connection to end'), { whole: false, bytes: '{"rows":['.length });
    await until(() => proxy.errors.length > 0, 'the proxy to log the reset');
    await sleep(100);
    assert.equal(proxy.errors.length, 1, proxy.errors.map((error) => error.text).join('\n'));
    const [{ text }] = proxy.errors;
    assert.match(text, /http proxy error: \/spending\/payment-reconciliation\n/);
    assert.match(text, /ECONNRESET/);
    assert.doesNotMatch(text, /upstream closed mid-answer/);
  } finally {
    browser.close();
    await proxy.vite.close();
    await api.close();
  }
});

test('a stall leaves the proxy timeout working: an API that goes silent once the browser reads on still times out', { timeout: 30_000 }, async () => {
  const api = await startUpstream((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write(LARGE_ANSWER); // and nothing more
  });
  const proxy = await startWatchedProxy(api.url, { timeoutMs: 200, stallCapMs: 60_000 });
  const browser = browse(proxy.url, '/spending/payment-reconciliation', { stalled: true });
  try {
    await browser.answerStarted;
    await sleep(1_000);
    assert.equal(proxy.answers[0].res.writableNeedDrain, true, 'the browser did not hold the proxy up');
    assert.deepEqual(proxy.errors, []);
    browser.readOn();
    await until(() => proxy.errors.length > 0, 'the proxy to give up');
    const [{ at, text }] = proxy.errors;
    assert.match(text, /\nError: upstream timed out\n/);
    const silentForMs = at - browser.lastByteAt();
    assert.ok(silentForMs >= 200 - 50 && silentForMs < 200 + 1_000, `timed out ${silentForMs} ms after the last byte`);
    assert.deepEqual(await within(browser.finished, 2_000, 'the browser\'s connection to end'), { whole: false, bytes: LARGE_ANSWER.length });
  } finally {
    browser.close();
    await proxy.vite.close();
    await api.close();
  }
});

test('a stall that starts within the last wait before the cap still ends at the cap, measured from the API\'s headers', { timeout: 30_000 }, async () => {
  // The API trickles until 850 ms, so its connection is never silent for a whole wait (600 ms) before the cap (1 000 ms),
  // then sends a large answer the stalled browser holds up. The wait alone would run out only at about 1 450 ms.
  const api = await startUpstream(tricklingApi(150, 850, LARGE_ANSWER));
  const proxy = await startWatchedProxy(api.url, { timeoutMs: 600, stallCapMs: 1_000 });
  const browser = browse(proxy.url, '/spending/payment-reconciliation', { stalled: true });
  try {
    await browser.answerStarted;
    const [{ res, headersAt }] = proxy.answers;
    await until(() => res.writableNeedDrain, 'the browser to hold the proxy up');
    const heldAfterMs = performance.now() - headersAt;
    assert.ok(heldAfterMs > 1_000 - 600, `held up ${heldAfterMs} ms after the API's headers: too early to test a late stall`);
    await until(() => proxy.errors.length > 0, 'the proxy to give up');
    const [{ at, text }] = proxy.errors;
    const closedAfterMs = at - headersAt;
    assert.ok(closedAfterMs >= 1_000 - 50 && closedAfterMs < 1_000 + 150, `closed ${closedAfterMs} ms after the API's headers`);
    assert.match(text, /\nError: client stalled: /);
    assert.equal(res.destroyed, true, 'the browser\'s connection is still open');
  } finally {
    browser.close();
    await proxy.vite.close();
    await api.close();
  }
});

test('a second stall near the cap, after an earlier one has ended, still ends at the cap', { timeout: 30_000 }, async () => {
  // Waits of 600 ms, cap 1 500 ms. The browser stalls on a large answer, reads on at 800 ms and stops again at 1 200 ms;
  // the API sends a second large answer at 1 300 ms. The wait alone would run out only at about 1 900 ms.
  const api = await startUpstream((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write(LARGE_ANSWER);
    const more = setTimeout(() => res.end(LARGE_ANSWER), 1_300);
    res.on('close', () => clearTimeout(more));
  });
  const proxy = await startWatchedProxy(api.url, { timeoutMs: 600, stallCapMs: 1_500 });
  const browser = browse(proxy.url, '/spending/payment-reconciliation', { stalled: true });
  try {
    await browser.answerStarted;
    const [{ res, headersAt }] = proxy.answers;
    await sleepUntil(headersAt, 800);
    assert.equal(res.writableNeedDrain, true, 'the browser did not hold the proxy up');
    browser.readOn();
    await until(() => browser.bytes() === LARGE_ANSWER.length, 'the browser to read the first answer');
    await sleepUntil(headersAt, 1_200);
    browser.stopReading();
    assert.deepEqual(proxy.errors, []);
    await until(() => proxy.errors.length > 0, 'the proxy to give up');
    const [{ at, text }] = proxy.errors;
    const closedAfterMs = at - headersAt;
    assert.ok(closedAfterMs >= 1_500 - 50 && closedAfterMs < 1_500 + 150, `closed ${closedAfterMs} ms after the API's headers`);
    assert.match(text, /\nError: client stalled: /);
  } finally {
    browser.close();
    await proxy.vite.close();
    await api.close();
  }
});

test('a stall that starts after the cap is closed when its wait first runs out: the wait is not restarted', { timeout: 30_000 }, async () => {
  // Waits of 400 ms, cap 600 ms. The API trickles until 900 ms, which a stalled browser's buffers still take, then sends a
  // large answer that it holds up.
  const api = await startUpstream(tricklingApi(100, 900, LARGE_ANSWER));
  const proxy = await startWatchedProxy(api.url, { timeoutMs: 400, stallCapMs: 600 });
  const browser = browse(proxy.url, '/spending/payment-reconciliation', { stalled: true });
  try {
    await browser.answerStarted;
    const [{ res, headersAt }] = proxy.answers;
    await sleepUntil(headersAt, 800);
    assert.deepEqual(proxy.errors, [], 'closed at the cap although nothing was held up then');
    await until(() => proxy.errors.length > 0, 'the proxy to give up');
    const [{ at, text }] = proxy.errors;
    const closedAfterMs = at - headersAt;
    assert.ok(closedAfterMs >= 900 + 400 - 50 && closedAfterMs < 900 + 2 * 400, `closed ${closedAfterMs} ms after the API's headers`);
    assert.match(text, /\nError: client stalled: /);
    assert.equal(res.destroyed, true, 'the browser\'s connection is still open');
  } finally {
    browser.close();
    await proxy.vite.close();
    await api.close();
  }
});

test('a browser still reading at the cap keeps its ordinary wait: an API that goes silent later times out as before', { timeout: 30_000 }, async () => {
  // Waits of 300 ms, cap 500 ms. The API trickles to a reading browser until 900 ms, then goes silent.
  const api = await startUpstream(tricklingApi(100, 900));
  const proxy = await startWatchedProxy(api.url, { timeoutMs: 300, stallCapMs: 500 });
  const browser = browse(proxy.url, '/spending/payment-reconciliation');
  try {
    await browser.answerStarted;
    await until(() => proxy.errors.length > 0, 'the proxy to give up');
    const [{ at, text }] = proxy.errors;
    assert.match(text, /\nError: upstream timed out\n/);
    assert.ok(at - proxy.answers[0].headersAt >= 900 + 300 - 50, 'gave up before the API went silent');
    const silentForMs = at - browser.lastByteAt();
    assert.ok(silentForMs >= 300 - 50 && silentForMs < 300 + 1_000, `timed out ${silentForMs} ms after the last byte`);
    assert.equal((await within(browser.finished, 2_000, 'the browser\'s connection to end')).whole, false);
    assert.equal(proxy.errors.length, 1);
  } finally {
    browser.close();
    await proxy.vite.close();
    await api.close();
  }
});

test('each answer\'s cap timer is cleared however it ends, and each answer cut off is logged once, none for a browser that left', { timeout: 30_000 }, async () => {
  // A cap no other timer uses, to tell the proxy's cap timers from Vite's own.
  const capMs = 1_234;
  const created: unknown[] = [];
  const pending = new Set<unknown>();
  const timers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  Object.assign(globalThis, {
    setTimeout: (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const timer = timers.setTimeout(callback, ms, ...args);
      if (ms === capMs) { created.push(timer); pending.add(timer); }
      return timer;
    },
    clearTimeout: (timer?: NodeJS.Timeout) => {
      pending.delete(timer);
      timers.clearTimeout(timer);
    },
  });
  const api = await startUpstream((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/spending/complete') return res.end('{"rows":[]}');
    if (req.url === '/spending/stalled') return res.end(LARGE_ANSWER);
    res.write('{"rows":[');
    if (req.url === '/spending/dropped') setTimeout(() => res.destroy(), 50);
    // '/spending/abandoned' and '/spending/silent' send nothing more.
  });
  const proxy = await startWatchedProxy(api.url, { timeoutMs: 200, stallCapMs: capMs });
  const browsers: Array<ReturnType<typeof browse>> = [];
  try {
    const complete = browse(proxy.url, '/spending/complete');
    const abandoned = browse(proxy.url, '/spending/abandoned');
    const dropped = browse(proxy.url, '/spending/dropped');
    const silent = browse(proxy.url, '/spending/silent');
    const stalled = browse(proxy.url, '/spending/stalled', { stalled: true });
    browsers.push(complete, abandoned, dropped, silent, stalled);
    await abandoned.answerStarted;
    abandoned.close();
    assert.equal((await within(complete.finished, 2_000, 'the complete answer')).whole, true);
    for (const browser of [abandoned, dropped, silent]) assert.equal((await within(browser.finished, 2_000, 'a browser\'s connection to end')).whole, false);
    await until(() => proxy.errors.some((error) => error.text.includes('client stalled')), 'the stalled answer to be closed');
    stalled.readOn();
    assert.equal((await within(stalled.finished, 2_000, 'the stalled browser\'s connection to end')).whole, false);
    await until(() => pending.size === 0, 'every cap timer to be cleared', 2_000);
    assert.equal(created.length, 5, 'one cap timer per answer');
    // One line for each answer cut off on the API's side or the proxy's, and none for the browser that left.
    assert.deepEqual(proxy.errors.map(({ text }) => text.split('\n').slice(0, 2).join(' ')).sort(), [
      'http proxy error: /spending/dropped Error: upstream closed mid-answer',
      'http proxy error: /spending/silent Error: upstream timed out',
      `http proxy error: /spending/stalled Error: client stalled: the browser stopped reading and ${capMs} ms have passed since the API answered`,
    ]);
  } finally {
    Object.assign(globalThis, timers);
    for (const browser of browsers) browser.close();
    await proxy.vite.close();
    await api.close();
  }
});
