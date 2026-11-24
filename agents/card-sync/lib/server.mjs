// The receiver's HTTP listener. It binds 127.0.0.1 only and checks every request: the peer must be a loopback address,
// the Host header must name this listener (no DNS rebinding), and an Origin header, when there is one, must be the paired
// extension's. Apart from a value-free /healthz, the only routes are the encrypted channel's two: every receiver route is
// reached inside it, so nothing on this computer can call one without the pairing key.
//
// Anything on this computer can still send requests, so none can lock the extension out or fill the disk: a challenge is
// kept only for a request signed with the pairing key, a sealed request's body is read only for a challenge it names
// (checked from its headers first), connections are capped and dropped when they idle before their headers, and refusals
// are logged at most a few times a minute.
import http from 'node:http';

import {
  CHALLENGE_HEADER, CHALLENGE_REQUEST_SKEW_MS, CHANNEL_PREFIX, challengeRequestKey, channelKeys, channelPath, checkChallengeRequest,
  frame, open, randomHex, seal, signChallenge, unframe,
} from '../extension/secure-channel.mjs';

export const LISTEN_HOST = '127.0.0.1';
const CHALLENGE_LIMIT = 2 * 1024;
const REQUEST_LIMIT = 46 * 1024 * 1024;
const NONCE = /^[0-9a-f]{64}$/;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'PUT']);
const INNER_HEADERS = new Set(['content-type', 'x-holdr-request', 'origin']);
const CHALLENGE_TTL_MS = 30_000;
/** Challenges waiting for their request: the extension holds one per request in flight. */
const MAX_CHALLENGES = 64;
/** Default listener limits: connections at once, and how long one may take to send its headers and its whole request. */
export const LIMITS = Object.freeze({ maxConnections: 64, headersTimeoutMs: 10_000, requestTimeoutMs: 120_000, checkEveryMs: 1_000 });

export function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  const plain = address.startsWith('::ffff:') ? address.slice(7) : address;
  return plain === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(plain);
}

class ChannelRefusal extends Error {}

/**
 * `log` for refused requests, at most `limit` lines per `windowMs`: anything on this computer can send requests, and the
 * log must not grow with them. A line written after some were left out counts them (`notLogged`).
 */
export function refusalLog(log, { limit = 10, windowMs = 60_000, now = () => Date.now() } = {}) {
  let windowStart = -Infinity;
  let written = 0;
  let skipped = 0;
  return (event) => {
    const at = now();
    if (at - windowStart >= windowMs) {
      windowStart = at;
      written = 0;
    }
    if (written >= limit) {
      skipped += 1;
      return;
    }
    written += 1;
    log(skipped > 0 ? { ...event, notLogged: skipped } : event);
    skipped = 0;
  };
}

/** The encrypted channel's server side; `dispatch` answers the requests it opens. */
export function createChannel({ key, dispatch, log = () => {}, now = () => Date.now() }) {
  const instance = randomHex();
  const keysPromise = channelKeys(key, instance);
  const requestKeyPromise = challengeRequestKey(key);
  const challenges = new Map();
  // Nonces already given a challenge, until their requests' time is too old to be accepted again.
  const used = new Map();
  const refused = refusalLog(log, { now });
  const refusal = (status, error) => ({ status, json: { error } });

  function forget(at) {
    for (const [nonce, entry] of challenges) if (entry.expires < at) challenges.delete(nonce);
    for (const [nonce, until] of used) if (until < at) used.delete(nonce);
  }

  /** A challenge for a request signed with the pairing key (`{ nonce, at, proof }`); anything else is refused, and kept nowhere. */
  async function challenge(body, host) {
    const at = now();
    forget(at);
    const origin = `http://${host}`;
    if (typeof body?.nonce !== 'string' || !NONCE.test(body.nonce) || !Number.isSafeInteger(body.at)
      || Math.abs(at - body.at) > CHALLENGE_REQUEST_SKEW_MS || typeof body.proof !== 'string' || body.proof.length > 100) {
      refused({ kind: 'challenge-refused' });
      return refusal(401, 'authenticated local channel required');
    }
    if (challenges.size >= MAX_CHALLENGES) return refusal(503, 'too many channel challenges at once');
    let signed = false;
    try {
      signed = await checkChallengeRequest(await requestKeyPromise, { nonce: body.nonce, origin, at: body.at, proof: body.proof });
    } catch {
      signed = false;
    }
    if (!signed || used.has(body.nonce)) {
      refused({ kind: 'challenge-refused' });
      return refusal(401, 'authenticated local channel required');
    }
    used.set(body.nonce, body.at + 2 * CHALLENGE_REQUEST_SKEW_MS);
    const entry = { nonce: body.nonce, ticket: randomHex(), instance, origin, expires: at + CHALLENGE_TTL_MS };
    challenges.set(entry.nonce, entry);
    return { status: 200, json: { ...entry, proof: await signChallenge(await keysPromise, entry) } };
  }

  /**
   * Takes the challenge a sealed request names (its CHALLENGE_HEADER), before its body is read: null when there is no such
   * challenge. A challenge serves one request body, whatever becomes of it.
   */
  function claim(nonce, host) {
    const entry = typeof nonce === 'string' && NONCE.test(nonce) ? challenges.get(nonce) : undefined;
    if (!entry || entry.expires < now() || entry.origin !== `http://${host}`) {
      refused({ kind: 'channel-refused' });
      return null;
    }
    challenges.delete(nonce);
    return entry;
  }

  /** Opens a sealed request for its claimed challenge `entry`, dispatches it, and seals the answer. */
  async function request(entry, body, host, transportOrigin) {
    try {
      if (body?.nonce !== entry.nonce || body.instance !== instance || body.ticket !== entry.ticket || entry.origin !== `http://${host}`) {
        throw new ChannelRefusal();
      }
      const keys = await keysPromise;
      const decoded = unframe(await open(keys, entry, 'request', body));
      const { method, path, headers } = decoded.header;
      if (!METHODS.has(method)) throw new ChannelRefusal();
      let contentType = null;
      for (const [name, value] of Object.entries(headers ?? {})) {
        if (!INNER_HEADERS.has(name) || typeof value !== 'string') throw new ChannelRefusal();
        if (name === 'content-type') contentType = value;
      }
      // The transport origin comes from the real HTTP request only, never from anything inside the envelope.
      const result = await dispatch({ method, path: channelPath(path), body: decoded.body, contentType, transportOrigin });
      const sealed = await seal(keys, entry, 'response', frame({ status: result.status, headers: result.headers }, result.body));
      return { status: 200, json: sealed };
    } catch {
      refused({ kind: 'channel-refused' });
      return refusal(401, 'authenticated local channel required');
    }
  }

  return { challenge, claim, request };
}

function send(res, status, value, { close = false } = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    // A refusal sent before the body was read ends the connection, so that the body is never read either.
    ...(close ? { Connection: 'close' } : {}),
  });
  res.end(body);
}

/** The request body, up to `limit` bytes; past it, reading stops (the 413 then closes the connection). */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        req.off('data', onData);
        req.pause();
        reject(Object.assign(new Error('too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * The receiver's listener on 127.0.0.1. `build` (a short fingerprint of the receiver's code) is part of /healthz, so that
 * `check` can tell a receiver started from other code, such as one still running from before an update. `limits` are
 * LIMITS' fields (tests make them small).
 */
export function createReceiverServer({
  port, extensionId, channel, log = () => {}, service = 'holdr-card-sync', protocol = 1, build = null, limits = LIMITS,
}) {
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('invalid extension id');
  const extensionOrigin = `chrome-extension://${extensionId}`;
  const refused = refusalLog(log);
  // Refused before its body is read: the connection is closed, so that a body sent anyway is not read either.
  const refuse = (res, status, value) => send(res, status, value, { close: true });
  const server = http.createServer({
    headersTimeout: limits.headersTimeoutMs, requestTimeout: limits.requestTimeoutMs, connectionsCheckingInterval: limits.checkEveryMs,
  }, async (req, res) => {
    // Its request has come: the connection may now take as long as the answer needs (see 'connection' below).
    req.socket.setTimeout(0);
    try {
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        refuse(res, 403, { error: 'loopback only' });
        return;
      }
      const listening = server.address()?.port;
      const host = String(req.headers.host ?? '').toLowerCase();
      if (host !== `127.0.0.1:${listening}` && host !== `localhost:${listening}`) {
        refuse(res, 403, { error: 'host not allowed' });
        return;
      }
      if (req.headers.origin !== undefined && req.headers.origin !== extensionOrigin) {
        refused({ kind: 'origin-refused' });
        refuse(res, 403, { error: 'origin not allowed', code: 'extension-id-mismatch' });
        return;
      }
      const pathname = new URL(req.url ?? '/', `http://${host}`).pathname;
      if (req.method === 'GET' && pathname === '/healthz') {
        send(res, 200, { ok: true, service, protocol, ...(build ? { build } : {}) });
        return;
      }
      const isChallenge = req.method === 'POST' && pathname === `${CHANNEL_PREFIX}/challenge`;
      const isRequest = req.method === 'POST' && pathname === `${CHANNEL_PREFIX}/request`;
      if (!isChallenge && !isRequest) {
        refuse(res, 404, { error: 'not found' });
        return;
      }
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
        refuse(res, 415, { error: 'json required' });
        return;
      }
      // A sealed request's body is read only for a challenge it names, given to a holder of the pairing key.
      const claimed = isRequest ? channel.claim(req.headers[CHALLENGE_HEADER], host) : null;
      if (isRequest && !claimed) {
        refuse(res, 401, { error: 'authenticated local channel required' });
        return;
      }
      const limit = isChallenge ? CHALLENGE_LIMIT : REQUEST_LIMIT;
      const declared = req.headers['content-length'];
      if (declared !== undefined && !(Number(declared) <= limit)) {
        refuse(res, 413, { error: 'invalid encrypted channel request' });
        return;
      }
      let body;
      try {
        body = JSON.parse((await readBody(req, limit)).toString('utf8'));
      } catch (error) {
        if (error?.status === 413) refuse(res, 413, { error: 'invalid encrypted channel request' });
        else send(res, 400, { error: 'invalid encrypted channel request' });
        return;
      }
      const answer = isChallenge ? await channel.challenge(body, host) : await channel.request(claimed, body, host, req.headers.origin ?? null);
      send(res, answer.status, answer.json);
    } catch {
      refused({ kind: 'request-error' });
      if (!res.headersSent) refuse(res, 500, { error: 'receiver error' });
      else res.destroy();
    }
  });
  server.maxConnections = limits.maxConnections;
  // A connection that sends nothing would keep its place for good (Node times out headers only once they start): it is
  // closed if no request comes within the header time. Between requests, Node closes an idle connection itself.
  server.on('connection', (socket) => socket.setTimeout(limits.headersTimeoutMs));
  return {
    server,
    /** Listens on 127.0.0.1 only; resolves with the bound address. */
    listen() {
      return new Promise((resolve, reject) => {
        const failed = (error) => reject(error);
        server.once('error', failed);
        server.listen(port, LISTEN_HOST, () => {
          server.off('error', failed);
          resolve(server.address());
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
