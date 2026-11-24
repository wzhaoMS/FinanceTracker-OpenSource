// Your own Holdr API on this computer, at http://127.0.0.1:<port>. The agent only reads: the API's health and version, card
// accounts, import coverage, and import previews, which write nothing. It never creates card accounts or imports anything:
// you do that in Holdr's web page (Spending, Import redacted JSON), where you review every import before it is written.
//
// Holdr's service token (Authorization: Bearer <token>; Holdr accepts it only from direct loopback connections) goes only
// to a program that runs under your own account: every new connection to Holdr's port is checked with the operating
// system (listener-owner.mjs) once it is connected and before anything is sent on it, and one that cannot be confirmed is
// closed unused. Status checks (GET /health, which Holdr answers without a token with its schema version) carry no token.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';

import { loopbackApiOrigin } from './config.mjs';
import { listenerOwner } from './listener-owner.mjs';

/** The database schema of the Holdr API this agent was written against (`CURRENT_USER_VERSION`). */
export const MIN_SCHEMA_VERSION = 15;
const TOKEN = /^[0-9a-f]{64}$/;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** How long an idle connection is kept for the next request: less than Holdr keeps it (5 s), so none is cut mid-request. */
const IDLE_MS = 3_000;

export class HoldrApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HoldrApiError';
    this.code = code;
  }
}

/** Reads the service token. Messages name no path: `check` prints where the token is looked for. */
export function readServiceToken(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new HoldrApiError('token-missing', "Holdr's service token file was not found: start Holdr once (it creates the file), "
        + 'or point HOLDR_DATA_DIR or HOLDR_TOKEN_FILE at your Holdr data (npm run agent -- check shows where it looks)');
    }
    throw new HoldrApiError('token-unreadable', "Holdr's service token file cannot be read by this account");
  }
  const token = text.trim();
  if (!TOKEN.test(token)) throw new HoldrApiError('token-invalid', "the service token file does not hold a Holdr service token (64 hex characters)");
  return token;
}

const safeText = (value) => (typeof value === 'string' && value.length <= 300 && !/\d{9,}/.test(value) ? value : null);

function errorFor(status, body, route, origin) {
  const said = safeText(body?.error);
  switch (status) {
    case 401:
      return new HoldrApiError('token-rejected', 'Holdr refused the service token: if Holdr made a new one (its token file was deleted, '
        + 'or the data directory changed), point HOLDR_DATA_DIR or HOLDR_TOKEN_FILE at the current one and restart the receiver');
    case 403:
      return new HoldrApiError('forbidden', `Holdr refused the request${said ? ` (${said})` : ''}`);
    case 404:
      if (said === 'card account not found') return new HoldrApiError('account-missing', 'that card account no longer exists in Holdr: sync again');
      return new HoldrApiError('version-mismatch', `Holdr at ${origin} has no ${route} route: update Holdr, or use the agent from the same checkout`);
    case 409:
      return new HoldrApiError('account-mismatch', said ?? 'the file does not fit that card account');
    case 413:
      return new HoldrApiError('too-large', 'the file is too large for one import: sync with a smaller --history');
    case 422:
      return new HoldrApiError('card-data-detected', 'Holdr found card data in the converted file and refused it; please report this');
    case 400:
      return new HoldrApiError('import-format-rejected', `Holdr did not accept the converted file${said ? ` (${said})` : ''}: `
        + 'Holdr and this agent may be from different versions');
    case 503:
      return new HoldrApiError('api-unavailable', `Holdr is not accepting requests right now${said ? ` (${said})` : ''}`);
    default:
      return new HoldrApiError('api-error', `Holdr answered ${status}${said ? ` (${said})` : ''}`);
  }
}

/** The previewed counts, as the receiver reports them. */
export function summarizePreview(summary) {
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
  return {
    rowCount: count(summary?.rowCount),
    newCount: count(summary?.newCount),
    duplicateCount: count(summary?.duplicateCount),
    possibleDuplicateCount: count(summary?.possibleDuplicateCount),
    pendingPostedCount: count(summary?.pendingPostedCount),
    conflictCount: count(summary?.conflictCount),
    heldCount: count(summary?.heldCount),
    warnings: Array.isArray(summary?.warnings)
      ? summary.warnings.map((warning) => warning?.code).filter((code) => typeof code === 'string' && /^[a-z][a-z-]{0,40}$/.test(code))
      : [],
  };
}

/** Whether a previewed file adds nothing more to Holdr: every row is already there and nothing would change. */
export function nothingLeftToImport(preview) {
  return preview.newCount === 0 && preview.possibleDuplicateCount === 0 && preview.pendingPostedCount === 0 && preview.heldCount === 0;
}

/**
 * Why a connection to Holdr's port was closed unused: `found` is listenerOwner's answer, 'other' or 'unknown' (with `why`).
 * The wording matches agents/mcp (lib/holdr-api.mjs, listenerRefusal).
 */
function listenerError(found, port, platform) {
  const where = `127.0.0.1:${port}`;
  const fix = 'start your Holdr there (npm run start:local), or point HOLDR_APP_URL at the port your Holdr uses';
  if (found.owner === 'other') {
    return new HoldrApiError('listener-not-yours', `the program listening on ${where} runs under another account on this computer, `
      + `so the agent sent it nothing: ${fix}`);
  }
  const why = {
    hidden: 'this account cannot see it, so it most likely runs under another account',
    unreadable: `the system did not say who runs it${platform === 'win32'
      ? '; a Holdr started as administrator looks like this, so start it from a normal window' : ''}`,
  }[found.why] ?? 'the check could not run';
  return new HoldrApiError('listener-unverified', `could not confirm that the program listening on ${where} runs under your account `
    + `(${why}), so the agent sent it nothing: ${fix}`);
}

/**
 * The connections to Holdr: each new one is checked (`confirm`) once it is connected and before anything is sent on it, and
 * closed unused if the check fails. An idle connection is kept briefly, so a burst of requests is checked once.
 */
class ConfirmedAgent extends http.Agent {
  #confirm;

  constructor(confirm) {
    super({ keepAlive: true, maxSockets: 2, timeout: IDLE_MS });
    this.#confirm = confirm;
  }

  createConnection(options, callback) {
    const socket = net.connect({ host: options.host, port: options.port });
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      if (error) {
        socket.destroy();
        callback(error);
      } else {
        callback(null, socket);
      }
    };
    socket.once('error', settle);
    socket.once('connect', () => {
      this.#confirm().then(() => settle(null), settle);
    });
    // The socket goes to the request through `callback`, once confirmed.
    return undefined;
  }
}

/**
 * The client. `ownerOf(port)` answers who runs the program listening on Holdr's port (listenerOwner in listener-owner.mjs:
 * `{ owner: 'you' | 'other' | 'unknown', why }`); tests replace it.
 */
export function createHoldrApi({ appUrl, tokenFile, timeoutMs = 30_000, ownerOf = listenerOwner, platform = process.platform }) {
  const origin = loopbackApiOrigin(appUrl);
  const { host, port } = new URL(origin);
  const portNumber = Number(port || 80);
  const agent = new ConfirmedAgent(async () => {
    const found = await ownerOf(portNumber);
    if (found?.owner !== 'you') throw listenerError(found ?? { owner: 'unknown' }, portNumber, platform);
  });
  const unreachable = () => new HoldrApiError('api-unreachable', `Holdr is not running at ${origin}: start it (npm run start:local), or set HOLDR_APP_URL`);

  /** One request; with `token`, the service token is read first (nothing is sent without a valid one) and sent along. */
  function request(method, route, { query = {}, body, token = false } = {}) {
    const credentials = token ? { Authorization: `Bearer ${readServiceToken(tokenFile)}` } : {};
    const url = new URL(route, origin);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const payload = body === undefined ? null : Buffer.from(body, 'utf8');
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const req = http.request({
        host: '127.0.0.1',
        port: portNumber,
        method,
        path: `${url.pathname}${url.search}`,
        agent,
        headers: {
          Host: host,
          Accept: 'application/json',
          ...credentials,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        },
      }, (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy();
            finish(new HoldrApiError('version-mismatch', `the service at ${origin} answered ${route} with more than Holdr ever sends`));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            json = null;
          }
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) finish(errorFor(status, json, route, origin));
          else if (json === null || typeof json !== 'object') finish(new HoldrApiError('version-mismatch', `the service at ${origin} did not answer like a Holdr API`));
          else finish(null, json);
        });
        response.on('error', () => finish(unreachable()));
      });
      timer = setTimeout(() => {
        req.destroy();
        finish(new HoldrApiError('api-timeout', `Holdr at ${origin} did not answer within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      req.on('error', (error) => finish(error instanceof HoldrApiError ? error : unreachable()));
      req.end(payload ?? undefined);
    });
  }

  /** GET /health as Holdr answers it: `{ ok, schemaVersion }` to anyone, plus `service` and counts with the token. */
  function checkHealth(body, withToken) {
    const known = body.ok === true && Number.isSafeInteger(body.schemaVersion)
      && (withToken ? body.service === 'holdr-api' : body.service === undefined || body.service === 'holdr-api');
    if (!known) throw new HoldrApiError('version-mismatch', `the service at ${origin} is not a Holdr API this agent knows`);
    if (body.schemaVersion < MIN_SCHEMA_VERSION) {
      throw new HoldrApiError('version-mismatch', `Holdr's database schema is ${body.schemaVersion}; this agent needs ${MIN_SCHEMA_VERSION} or later: update Holdr`);
    }
    return { schemaVersion: body.schemaVersion };
  }

  return {
    origin,
    /** Holdr's version, asked without the token: `{ schemaVersion }`. */
    async probe() {
      return checkHealth(await request('GET', '/health'), false);
    },
    /** Checks the token and the API version: `{ schemaVersion }`. */
    async health() {
      return checkHealth(await request('GET', '/health', { token: true }), true);
    },
    async listCardAccounts() {
      const body = await request('GET', '/card-accounts', { token: true });
      if (!Array.isArray(body.cardAccounts)) throw new HoldrApiError('version-mismatch', 'Holdr answered /card-accounts in an unknown shape');
      return body.cardAccounts;
    },
    /** Each card account's imported date ranges: `[{ cardAccountId, ranges: [{ start, end }] }]`. */
    async coverage() {
      const body = await request('GET', '/spending/coverage', { token: true });
      if (!Array.isArray(body.cards)) throw new HoldrApiError('version-mismatch', 'Holdr answered /spending/coverage in an unknown shape');
      return body.cards.map((card) => ({ cardAccountId: card?.cardAccountId, ranges: Array.isArray(card?.ranges) ? card.ranges : [] }));
    },
    /** POST /card-imports/preview: what importing `json` into the card account would do. Writes nothing. */
    async preview(cardAccountId, json) {
      return summarizePreview(await request('POST', '/card-imports/preview', { query: { cardAccountId }, body: json, token: true }));
    },
    /** Whether Holdr answers, asked without the token: `{ status: 'ok', schemaVersion }`, or `{ status: <error code>, message }`. */
    async status() {
      try {
        return { status: 'ok', ...(await this.probe()) };
      } catch (error) {
        return describeApiError(error);
      }
    },
    /** Closes the idle connections. */
    close() {
      agent.destroy();
    },
  };
}

export function describeApiError(error) {
  return error instanceof HoldrApiError
    ? { status: error.code, message: error.message }
    : { status: 'api-error', message: 'Holdr could not be asked' };
}
