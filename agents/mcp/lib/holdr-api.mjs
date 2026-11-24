// Your own Holdr API on this computer, read with its read-only agent token (Authorization: Bearer <token>; Holdr accepts it
// only from direct loopback connections, for GET and HEAD on the read routes in apps/api/src/auth/agentScope.ts, and
// refuses it everything else). This client cannot even ask for more: it has no method but GET, and every route below is
// on Holdr's agent list (tests/holdr-api.test.mjs checks it against the API source). It never sends the service token,
// which can change data: a token file holding one is refused before anything is sent. The token is read from its file on
// every request, so a rotated token is picked up without a restart. It is sent only to 127.0.0.1, and only after
// listener.mjs found that the program listening on Holdr's port runs as this account (checked again after 10 seconds,
// and after any connection failure), so another account listening there while Holdr is stopped never receives it.
import fs from 'node:fs';
import http from 'node:http';

import { loopbackApiOrigin, SERVER_VERSION } from './config.mjs';
import { checkListener, probePort } from './listener.mjs';

/** Every route the tools read, all with GET. tests/holdr-api.test.mjs checks them against the API's agent route list. */
export const READ_ROUTES = Object.freeze([
  '/health',
  '/accounts',
  '/transactions',
  '/cash-events',
  '/quotes',
  '/portfolio/performance',
  '/card-accounts',
  '/card-transactions',
  '/spending/summary',
  '/spending/coverage',
  '/spending/benefits',
  '/spending/forecast',
  '/spending/patterns',
  '/metals/overview',
  '/metals/purchases',
]);

/** Holdr's read-only agent token (apps/api/src/auth/agentToken.ts), and its service token, which can change data. */
const AGENT_TOKEN = /^holdr_agent_[0-9a-f]{64}$/;
const SERVICE_TOKEN = /^[0-9a-f]{64}$/;
const MAX_TOKEN_FILE_BYTES = 4096;
export const DEFAULT_TIMEOUT_MS = 20_000;
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** How long a check that the listener on Holdr's port runs as this account holds before the next request checks again. */
export const LISTENER_CHECK_TTL_MS = 10_000;

export class HoldrApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HoldrApiError';
    this.code = code;
  }
}

const TOKEN_HINT = 'node agents/mcp/server.mjs --check shows where it looks';
/** How a person gets the agent token file: Holdr writes it into its data folder whenever it starts without one. */
export const CREATE_AGENT_TOKEN = 'Holdr creates it in its data folder when it starts: stop Holdr (Ctrl+C in its window) and '
  + 'start it again with npm run start:local (npm run demo for the demo, then start this server with --demo). If you start '
  + 'Holdr another way, point --data-dir (HOLDR_DATA_DIR) at the data folder of the Holdr you run';

/**
 * Reads the agent token. Messages never name the file: --check prints where the token is looked for. A file holding the
 * service token is refused (`token-is-service`), never used in its place.
 */
export function readAgentToken(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new HoldrApiError('token-missing', `Holdr's agent token file (agent-token) was not found. ${CREATE_AGENT_TOKEN} `
        + `(${TOKEN_HINT})`);
    }
    throw new HoldrApiError('token-unreadable', `Holdr's agent token file cannot be read by this account (${TOKEN_HINT})`);
  }
  if (!stat.isFile() || stat.size > MAX_TOKEN_FILE_BYTES) {
    throw new HoldrApiError('token-invalid', `the agent token file is not a Holdr agent token file (${TOKEN_HINT})`);
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new HoldrApiError('token-unreadable', `Holdr's agent token file cannot be read by this account (${TOKEN_HINT})`);
  }
  const token = text.trim();
  if (SERVICE_TOKEN.test(token)) {
    throw new HoldrApiError('token-is-service', "this file holds Holdr's service token, which can change data, and this server "
      + "reads only with the read-only agent token: give it the agent-token file in Holdr's data folder instead "
      + `(leave out --token-file and HOLDR_AGENT_TOKEN_FILE to use it) (${TOKEN_HINT})`);
  }
  if (!AGENT_TOKEN.test(token)) {
    throw new HoldrApiError('token-invalid', 'the agent token file does not hold a Holdr agent token (holdr_agent_ and 64 hex '
      + 'characters); delete it and restart Holdr to make a new one');
  }
  return token;
}

/**
 * The refusal for a listener check that did not find your account's program on `port` (listener.mjs, checkListener), or
 * null for 'yours'. 'none' needs the probe's answer: nothing listening means Holdr is not running. The wording matches
 * agents/card-sync (lib/holdr-api.mjs, listenerError).
 */
function listenerRefusal(result, port, origin, probed) {
  const where = `127.0.0.1:${port}`;
  const fix = 'start your Holdr there (npm run start:local; npm run demo for the demo), or point --app-url at the port your Holdr uses';
  const unconfirmed = (why) => new HoldrApiError('listener-unverified', `could not confirm that the program listening on ${where} `
    + `runs under your account (${why}), so this server sent it nothing: ${fix}`);
  switch (result.state) {
    case 'yours':
      return null;
    case 'other':
      return new HoldrApiError('listener-not-yours', `the program listening on ${where} runs under another account on this computer, `
        + `so this server sent it nothing: ${fix}`);
    case 'unknown':
      return unconfirmed('the system did not say who runs it; a Holdr started as administrator looks like this, so start it from a '
        + 'normal window');
    case 'none':
      if (probed === 'closed') return connectionError(origin);
      return unconfirmed('this account cannot see it, so it most likely runs under another account');
    default:
      return unconfirmed(result.reason ?? 'the check could not run');
  }
}

/** Holdr's own error text, when it is short, plain and holds no long number. */
const safeText = (value) => (typeof value === 'string' && value.length <= 300 && !/\d{9,}/.test(value) && !/[\u0000-\u001f]/.test(value) ? value : null);

function errorFor(status, body, route, origin) {
  const said = safeText(body?.error);
  switch (status) {
    case 400:
      return new HoldrApiError('bad-request', `Holdr did not accept the request${said ? `: ${said}` : ''}`);
    case 401:
      return new HoldrApiError('token-rejected', 'Holdr refused the agent token. The token file belongs to another Holdr data folder, '
        + 'Holdr made a new token (the file was deleted and Holdr restarted), or this Holdr is older than agent tokens (update it): '
        + `point --data-dir at the data folder of the Holdr running at ${origin}`);
    case 403:
      return new HoldrApiError('forbidden', `Holdr refused this read for the agent token${said ? ` (${said})` : ''}`);
    case 404:
      if (said && said !== 'not-found' && /not found/i.test(said)) return new HoldrApiError('not-found', `Holdr: ${said}`);
      return new HoldrApiError('version-mismatch', `Holdr at ${origin} has no ${route} route: update Holdr, or use this server from the same checkout as Holdr`);
    case 409:
      return new HoldrApiError('conflict', `Holdr cannot answer this right now${said ? `: ${said}` : ''}`);
    case 422:
      return new HoldrApiError('card-data-refused', 'Holdr refused the request because part of it looks like card data (a card number '
        + 'or security code); search with other words');
    case 429:
      return new HoldrApiError('rate-limited', 'Holdr asked to slow down; wait a moment and try again');
    case 503:
      if (said === 'ingress-unverified' || said === 'ingress-refused') {
        return new HoldrApiError('api-unavailable', `Holdr is not admitting local token requests yet (${said}); `
          + 'this happens in the hardened macOS deployment until its release check passes');
      }
      return new HoldrApiError('api-unavailable', `Holdr is not answering requests right now${said ? ` (${said})` : ''}`);
    default:
      return new HoldrApiError('api-error', `Holdr answered ${status}${said ? ` (${said})` : ''}`);
  }
}

function connectionError(origin) {
  return new HoldrApiError('api-unreachable', `Holdr is not running at ${origin}: start it (npm run start:local; npm run demo for the demo, `
    + 'which listens on http://127.0.0.1:4001 and needs --demo here), or point --app-url at it');
}

/**
 * The client. `get(route, query, { timeoutMs, signal })` answers the parsed JSON body or throws a HoldrApiError whose message
 * names no file and no token. Query values that are undefined, null or empty are left out. `verifyListener()` runs the
 * listener check on its own (for --check) and resolves `{ pids }`. `listenerCheck`, `probe` and `now` are parameters for
 * tests; the defaults check the real listener (listener.mjs).
 */
export function createHoldrApi({
  appUrl, tokenFile, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = MAX_RESPONSE_BYTES,
  listenerCheck = checkListener, probe = probePort, now = Date.now,
}) {
  const origin = loopbackApiOrigin(appUrl);
  const target = new URL(origin);
  const hostname = target.hostname;
  const port = Number(target.port || 80);
  // An agent of its own: never the global one, which a process-wide proxy setting could change.
  const agent = new http.Agent({ keepAlive: false, maxSockets: 6 });
  // The last check that the listener runs as this account: one check at a time, shared by the requests waiting for it.
  let verified = null;
  let checking = null;

  function verifyListener() {
    if (verified && now() - verified.at < LISTENER_CHECK_TTL_MS) return Promise.resolve({ pids: verified.pids });
    checking ??= (async () => {
      const result = await listenerCheck(port);
      const refusal = listenerRefusal(result, port, origin, result.state === 'none' ? await probe(port) : null);
      if (refusal) throw refusal;
      verified = { at: now(), pids: result.pids ?? [] };
      return { pids: verified.pids };
    })().finally(() => { checking = null; });
    return checking;
  }

  async function get(route, query = {}, { timeoutMs: limit = timeoutMs, signal } = {}) {
    if (!READ_ROUTES.includes(route)) throw new Error(`${route} is not a read route this server may call`);
    readAgentToken(tokenFile);
    const cancelled = () => new HoldrApiError('cancelled', 'the request was cancelled');
    if (signal?.aborted) throw cancelled();
    let onAbort = null;
    try {
      await Promise.race([
        verifyListener(),
        new Promise((_resolve, reject) => {
          onAbort = () => reject(cancelled());
          signal?.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    // Read again: the file may have changed while the check ran, and the request must carry what is there now.
    return send(route, query, readAgentToken(tokenFile), { limit, signal });
  }

  function send(route, query, token, { limit, signal }) {
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      search.set(name, String(value));
    }
    const requestPath = search.size > 0 ? `${route}?${search}` : route;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      let request = null;
      const onAbort = () => {
        request?.destroy();
        finish(new HoldrApiError('cancelled', 'the request was cancelled'));
      };
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(value);
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      request = http.request({
        host: hostname,
        port,
        method: 'GET',
        path: requestPath,
        agent,
        headers: {
          Host: target.host,
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'User-Agent': `holdr-mcp/${SERVER_VERSION}`,
        },
      }, (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            request.destroy();
            finish(new HoldrApiError('too-large', `Holdr's answer to ${route} was larger than ${Math.round(maxBytes / 1048576)} MiB`));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            json = null;
          }
          if (status < 200 || status >= 300) {
            finish(errorFor(status, json, route, origin));
            return;
          }
          if (json === null || typeof json !== 'object') {
            finish(new HoldrApiError('version-mismatch', `the service at ${origin} did not answer ${route} like a Holdr API`));
            return;
          }
          finish(null, json);
        });
        response.on('error', () => finish(lost()));
      });
      timer = setTimeout(() => {
        request.destroy();
        verified = null;
        finish(new HoldrApiError('api-timeout', `Holdr at ${origin} did not answer ${route} within ${Math.round(limit / 1000)} s`));
      }, limit);
      signal?.addEventListener('abort', onAbort, { once: true });
      request.on('error', () => finish(lost()));
      request.end();
    });
  }

  /** A failed connection: whatever listens on the port next is checked again before it gets the token. */
  function lost() {
    verified = null;
    return connectionError(origin);
  }

  return { origin, get, verifyListener, close: () => agent.destroy() };
}
