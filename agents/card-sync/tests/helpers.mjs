// Test helpers: temporary folders, a fake Holdr API on 127.0.0.1, and synthetic American Express data. Every listener a
// test starts binds 127.0.0.1 explicitly, and nothing here reaches the network.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const AGENT_DIR = path.resolve(TESTS_DIR, '..');
export const REPO_ROOT = path.resolve(AGENT_DIR, '..', '..');
export const FIXTURES = path.join(TESTS_DIR, 'fixtures');
export const EXTENSION_DIR = path.join(AGENT_DIR, 'extension');
export const TOKEN = 'ab'.repeat(32);

/** A temporary folder removed after the test. */
export function tempDir(t, prefix = 'holdr-card-sync-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

/** The page helper's digest that tells cards apart (amex-page.js). */
export function sourceIdFor(salt, accountKey) {
  const digest = createHash('sha256').update(`holdr-amex-account-v1:${salt}:${accountKey}`).digest();
  return `amex-${[...digest].map((b) => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join('')}`;
}

const AMEX_HEADER = 'Date,Description,Card Member,Account #,Amount,Extended Details,Appears On Your Statement As,Address,City/State,Zip Code,Country,Reference,Category';

/** A synthetic detailed Amex export: rows of [MM/DD/YYYY, description, amount, reference digits]. */
export function amexCsv(rows) {
  return `${AMEX_HEADER}\r\n${rows.map(([date, description, amount, reference]) =>
    `${date},${description},SAMPLE MEMBER,XXXX-XXXXXX-91005,${amount},,${description},,,,,'${reference}',Other-Miscellaneous`).join('\r\n')}\r\n`;
}

/**
 * A fake Holdr API: GET /health (without the token only `{ ok, schemaVersion }`, as Holdr answers it), and behind
 * `Authorization: Bearer <token>` GET /card-accounts, GET /spending/coverage and POST /card-imports/preview. `state` can be
 * changed between requests; `requests` records each one; `dropConnections()` closes the open connections.
 */
export async function startFakeHoldr(t, {
  token = TOKEN, accounts = [], coverage = [], schemaVersion = 15, service = 'holdr-api', imported = new Set(),
} = {}) {
  const state = { accounts, coverage, schemaVersion, service, imported, status: null };
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://127.0.0.1');
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
      const send = (status, value) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (state.status) return send(state.status, { error: 'synthetic failure' });
      if (req.method === 'GET' && url.pathname === '/health' && req.headers.authorization === undefined) {
        return send(200, { ok: true, schemaVersion: state.schemaVersion });
      }
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'Invalid credentials' });
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, service: state.service, schemaVersion: state.schemaVersion });
      if (req.method === 'GET' && url.pathname === '/card-accounts') return send(200, { cardAccounts: state.accounts });
      if (req.method === 'GET' && url.pathname === '/spending/coverage') return send(200, { cards: state.coverage });
      if (req.method === 'POST' && url.pathname === '/card-imports/preview') {
        let payload;
        try { payload = JSON.parse(body); } catch { return send(400, { error: 'the request body is not valid JSON' }); }
        if (payload.format !== 'holdr.card-import' || payload.version !== 1) return send(400, { error: 'invalid card import' });
        if (!state.accounts.some((account) => account.id === url.searchParams.get('cardAccountId'))) return send(404, { error: 'card account not found' });
        const keys = payload.rows.map((row) => row.externalIdHash ?? row.fingerprint);
        const duplicates = keys.filter((key) => state.imported.has(key)).length;
        return send(200, {
          rowCount: payload.rows.length, newCount: payload.rows.length - duplicates, duplicateCount: duplicates, heldCount: 0,
          possibleDuplicateCount: 0, pendingPostedCount: 0, conflictCount: 0, warnings: [{ code: 'sample-warning', message: 'x' }],
        });
      }
      return send(404, { error: 'not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return {
    url: `http://127.0.0.1:${server.address().port}`, port: server.address().port, requests, state,
    dropConnections: () => server.closeAllConnections(),
  };
}

/** A token file holding the fake API's token, in its own temporary data folder. */
export function writeToken(dir, token = TOKEN) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'service-token');
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return file;
}

/** A port on 127.0.0.1 that nothing listens on (it was free a moment ago). */
export async function closedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
