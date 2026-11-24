import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP, type Socket } from 'node:net';
import type { ProxyOptions } from 'vite';
import { HOLDR_API_PATH_PREFIXES } from '../../packages/shared/src/apiPaths';
import {
  createFreshConnectionAgent,
  createUpstreamAgent,
  mayResend,
  watchUpstreamAttempt,
} from '../../packages/shared/src/upstreamKeepAlive';

/**
 * The browser reaches the Holdr API only through this same-origin proxy (the
 * API itself listens on 127.0.0.1). The proxy:
 *
 *  - forwards API prefixes on whole segments, but only /card-sync/owner for card sync; devices never go through Vite;
 *  - never forwards browser credentials other than the session cookie: any
 *    Authorization header is dropped, so the service token cannot be used
 *    through the proxy;
 *  - drops every forwarding and Tailscale identity header and sends one
 *    X-Forwarded-For naming the browser, which the API uses for per-IP login
 *    throttling and (by its mere presence) for refusing the service token.
 *    Tailscale Serve connects from loopback and reports the tailnet client in
 *    X-Forwarded-For, so for a loopback peer the last hop is used; any other
 *    peer (a LAN browser under HOLDR_LAN_HTTP=1) is named by its own address;
 *  - reuses upstream connections through one keep-alive agent (BUG-021).
 *    Without an agent http-proxy opens a new TCP connection per request and
 *    sends `Connection: close`; the API echoes that header and http-proxy
 *    copies it to the browser, so every API response used to tear down the
 *    browser's keep-alive connection as well;
 *  - drops a pooled connection after 2 s idle, before the API's 5 s keep-alive
 *    timeout can close it under a new request, and sends a GET or HEAD that
 *    still meets a connection the API has just closed once more, on a new
 *    connection (packages/shared/src/upstreamKeepAlive.ts). No other method is
 *    ever sent twice;
 *  - gives up on an API connection that has been silent for
 *    API_PROXY_TIMEOUT_MS and logs "upstream timed out": the browser gets a
 *    504 if no answer has started, or else its connection is closed. A
 *    browser that stops reading an answer (a phone locked mid-load) also
 *    stops the proxy reading the API, so that silence is the browser's and
 *    the wait restarts, but only until API_PROXY_STALL_CAP_MS after the API's
 *    headers. A browser not reading then is closed at once, and one that stops
 *    later when its wait runs out: both connections, logged as "client
 *    stalled". A browser still reading at the cap keeps its ordinary wait;
 *  - closes the browser's connection when the API's answer is cut off (its
 *    connection closed mid-answer), logged as "upstream closed mid-answer"
 *    unless an error has already said why, rather than leave it waiting.
 */

export const DEFAULT_API_TARGET = 'http://127.0.0.1:4000';

/** Backstop for a hung upstream, not a latency budget: a broker pull can wait minutes for a person to log in. */
export const API_PROXY_TIMEOUT_MS = 6 * 60_000;

/** How long after the API's headers the proxy holds an answer for a browser that has stopped reading it. */
export const API_PROXY_STALL_CAP_MS = 30 * 60_000;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const API_PROXY_PREFIXES = HOLDR_API_PATH_PREFIXES.map((prefix) => prefix === 'card-sync' ? 'card-sync/owner' : prefix);
export const API_PROXY_CONTEXT = `^/(?:${API_PROXY_PREFIXES.map(escapeRegExp).join('|')})(?:[/?]|$)`;

const DROPPED_REQUEST_HEADERS = new Set(['authorization', 'proxy-authorization', 'forwarded', 'x-real-ip', 'via']);
const DROPPED_REQUEST_HEADER_PREFIXES = ['x-forwarded-', 'tailscale-'];

const plainAddress = (address: string) => address.replace(/^::ffff:/i, '');
const isLoopback = (address: string) => address === '::1' || (isIP(address) === 4 && address.startsWith('127.'));

/** The browser's address: for a loopback peer (Tailscale Serve) the last X-Forwarded-For hop, else the peer. */
export function browserAddress(req: IncomingMessage): string {
  const peer = plainAddress(req.socket.remoteAddress ?? 'unknown');
  if (isLoopback(peer)) {
    const header = req.headers['x-forwarded-for'];
    const hops = (Array.isArray(header) ? header.join(',') : header ?? '').split(',').map((hop) => hop.trim()).filter(Boolean);
    const last = hops.length > 0 ? plainAddress(hops[hops.length - 1]) : '';
    if (isIP(last)) return last;
  }
  return peer;
}

/** Strips browser credentials, forwarding and Tailscale headers, then names the browser for the API. */
export function scrubApiRequestHeaders(req: IncomingMessage): void {
  const client = browserAddress(req);
  for (const name of Object.keys(req.headers)) {
    if (DROPPED_REQUEST_HEADERS.has(name) || DROPPED_REQUEST_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      delete req.headers[name];
    }
  }
  req.headers['x-forwarded-for'] = client;
}

class ProxyTimeoutError extends Error {
  readonly code = 'HOLDR_PROXY_TIMEOUT';
}

/** Raised only once an answer has started, so no status is sent for it: the browser's connection is closed instead. */
class ProxyClientStalledError extends Error {
  readonly code = 'HOLDR_PROXY_CLIENT_STALLED';
}

/** The API's connection closed before its answer was complete; the browser's connection is closed too. */
class ProxyUpstreamClosedError extends Error {
  readonly code = 'HOLDR_PROXY_UPSTREAM_CLOSED';
}

const minutesOrMs = (ms: number) => ms % 60_000 === 0 ? `${ms / 60_000} min` : `${ms} ms`;

function respondWithProxyError(err: Error & { code?: string }, res: ServerResponse | Socket | undefined): void {
  if (!res || !('writeHead' in res) || res.headersSent || res.writableEnded || res.destroyed) return;
  const timedOut = err.code === 'HOLDR_PROXY_TIMEOUT';
  res.writeHead(timedOut ? 504 : 502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: timedOut ? 'Holdr API timed out' : 'Holdr API unreachable' }));
}

export function createApiProxy(
  target: string = DEFAULT_API_TARGET,
  options: { timeoutMs?: number; stallCapMs?: number } = {},
): ProxyOptions {
  const timeoutMs = options.timeoutMs ?? API_PROXY_TIMEOUT_MS;
  const stallCapMs = options.stallCapMs ?? API_PROXY_STALL_CAP_MS;
  const agent = createUpstreamAgent();
  const freshAgent = createFreshConnectionAgent();
  const staleConnection = new WeakMap<IncomingMessage, (error: Error) => boolean>();
  return {
    target,
    changeOrigin: true,
    agent,
    configure(proxy) {
      // 'start' fires before http-proxy copies req.headers into the upstream request.
      proxy.on('start', (req) => scrubApiRequestHeaders(req));
      // 'proxyReq' fires once the upstream request has its connection.
      proxy.on('proxyReq', (proxyReq, req, res) => {
        staleConnection.set(req, watchUpstreamAttempt(proxyReq));
        const upstreamTimedOut = () => proxyReq.destroy(new ProxyTimeoutError('upstream timed out'));
        proxyReq.setTimeout(timeoutMs, upstreamTimedOut);
        // From the API's headers on, the response reports the same idle timer each time it runs out. The request
        // reports it only the first time (Node never renews that listener), so a renewed wait would never end.
        proxyReq.once('response', (proxyRes) => {
          proxyReq.removeListener('timeout', upstreamTimedOut);
          // Set when the API's connection fails with an error, which the 'error' listeners log.
          let erred = false;
          proxyReq.once('error', () => { erred = true; });
          // The proxy gives up on an answer itself: it closes the API's side and says why, whatever state that side
          // is in (the API may have closed it already). An answer that has started can't become an error status:
          // the browser's connection is closed instead.
          const giveUp = (error: Error) => {
            proxyReq.destroy();
            if (res.headersSent) res.destroy();
            proxy.emit('error', error, req, res);
          };
          const clientStalled = () => giveUp(new ProxyClientStalledError(
            `client stalled: the browser stopped reading and ${minutesOrMs(stallCapMs)} have passed since the API answered`));
          // The cap holds whenever a stall starts: a browser not reading when it comes is closed then, one reading
          // keeps its ordinary wait.
          let pastCap = false;
          const cap = setTimeout(() => {
            pastCap = true;
            if (res.writableNeedDrain) clientStalled();
          }, stallCapMs);
          cap.unref();
          proxyRes.once('close', () => {
            clearTimeout(cap);
            // An answer cut off upstream, with the browser still waiting for the rest: it never comes, so the
            // browser's connection is closed. The cut is logged unless an error has already said why.
            if (proxyRes.complete || res.writableEnded || res.destroyed) return;
            res.destroy();
            if (!erred) proxy.emit('error', new ProxyUpstreamClosedError('upstream closed mid-answer'), req, res);
          });
          proxyRes.setTimeout(timeoutMs, () => {
            if (!res.writableNeedDrain) giveUp(new ProxyTimeoutError('upstream timed out'));
            // The browser has stopped reading, so the proxy has stopped reading the API: the silence is the browser's.
            else if (!pastCap) proxyRes.setTimeout(timeoutMs);
            else clientStalled();
          });
        });
      });
      // Vite's own handler runs afterwards; it only logs once a response has been sent.
      proxy.on('error', (err, _req, res) => respondWithProxyError(err, res));
      // Vite calls web() without a callback, so a failure would go straight to the 'error' listeners
      // and answer 502. With a callback, a failure caused only by a connection the API had just
      // closed is first sent once more, on a new connection.
      const web = proxy.web.bind(proxy);
      proxy.web = (req, res, webOptions = {}, callback) => {
        let attempts = 0;
        const send = (resend: boolean) => {
          const attempt = ++attempts;
          web(req, res, resend ? { ...webOptions, agent: freshAgent } : webOptions, (err, _req, _res, url) => {
            // The first attempt's listeners outlive it; the current attempt reports for itself.
            if (attempt !== attempts) return;
            if (!resend && mayResend(req, res) && staleConnection.get(req)?.(err)) return send(true);
            if (callback) callback(err, req, res, url);
            else proxy.emit('error', err, req, res, url);
          });
        };
        send(false);
      };
    },
  };
}
