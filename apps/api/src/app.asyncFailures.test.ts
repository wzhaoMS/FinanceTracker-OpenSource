import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SCHWAB_STATEMENT_LINES, textPdf } from './testing/syntheticPdf.js';

/**
 * Database failures in the async routes, against the real app (createApp)
 * running in a process of its own (testing/failingDatabaseServer.ts), with a
 * session and CSRF headers. Express 4 never forwarded a rejected promise:
 * POST /accounts/:id/nav-history/import, POST /import/activity-from-broker
 * and the per-section broker pulls read the database outside any try/catch,
 * so a failure there reset the signed-in request and stopped the API with
 * SQLite's message and stack on stderr (E0 review, N2). Now every async route
 * goes through asyncRoute: each failure below is a fixed 500, the API keeps
 * answering, and nothing it prints quotes SQLite.
 *
 * The broken tables are views over a table named after a synthetic card
 * number (the published test PAN), so SQLite's message names it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, '..');
const SENTINEL = '4111111111111111';
const ORIGIN = 'http://127.0.0.1:5173';
const PASSWORD = 'correct horse battery';
const FIXED_500 = { error: 'Internal server error' };
const csrf = { Origin: ORIGIN, 'X-Holdr-Request': '1' };
const json = { 'Content-Type': 'application/json' };

interface Answer { status: number; text: string; headers: http.IncomingHttpHeaders }

function send(port: number, method: string, url: string, headers: Record<string, string> = {}, body?: string | Buffer): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: url, agent: false,
      headers: { ...headers, ...(body === undefined ? {} : { 'Content-Length': String(Buffer.byteLength(body)) }) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    req.setTimeout(10_000, () => req.destroy(new Error(`${method} ${url} got no answer`)));
    req.once('error', reject);
    req.end(body);
  });
}

const STATEMENT = textPdf(SCHWAB_STATEMENT_LINES);

class Server {
  private constructor(readonly child: ChildProcess, readonly port: number, private readonly log: { text: string }) {}

  static async start(): Promise<Server> {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(here, 'testing', 'failingDatabaseServer.ts')], {
      cwd: apiDir,
      env: { ...process.env, HOLDR_TEST_SENTINEL: SENTINEL, HOLDR_TEST_ORIGIN: ORIGIN, HOLDR_TEST_PASSWORD: PASSWORD },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const log = { text: '' };
    child.stdout!.on('data', (chunk: Buffer) => { log.text += chunk; });
    child.stderr!.on('data', (chunk: Buffer) => { log.text += chunk; });
    const ready = await new Promise<{ port: number }>((resolve, reject) => {
      child.once('message', resolve);
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`the server exited (${code}) before it was ready:\n${log.text}`)));
    });
    return new Server(child, ready.port, log);
  }

  /** Everything the server printed so far: its logs, and Node's report if it died. */
  get printed(): string {
    return this.log.text;
  }

  get running(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  request(method: string, url: string, headers: Record<string, string> = {}, body?: string | Buffer): Promise<Answer> {
    return send(this.port, method, url, headers, body);
  }

  async breakReads(...tables: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const exited = () => reject(new Error(`the server exited while breaking ${tables.join(', ')}:\n${this.printed}`));
      this.child.once('exit', exited);
      this.child.once('message', () => {
        this.child.off('exit', exited);
        resolve();
      });
      this.child.send({ breakReads: tables });
    });
  }

  /** Asks the server to shut down; resolves with its exit code. */
  async close(): Promise<number | null> {
    if (!this.running) return this.child.exitCode;
    const exited = new Promise<number | null>((resolve) => this.child.once('exit', (code) => resolve(code)));
    this.child.send({ close: true });
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 10_000);
    const code = await exited;
    clearTimeout(timer);
    return code;
  }
}

describe('a database failure in an async route, on the real app in its own process', () => {
  it('is a fixed 500 on every async route, and the API keeps running without printing SQLite text', async () => {
    const server = await Server.start();
    try {
      const login = await server.request('POST', '/auth/login', { ...csrf, ...json }, JSON.stringify({ username: 'alex', password: PASSWORD }));
      expect(login.status, login.text).toBe(200);
      const cookie = ([] as string[]).concat(login.headers['set-cookie'] ?? [])
        .find((value) => value.startsWith('holdr_session='))!.split(';')[0];
      const signedIn = { ...csrf, Cookie: cookie };

      /** One request, then proof the API is still there: anonymous /health answers and the process runs. */
      const expectFixed500 = async (method: string, url: string, headers: Record<string, string>, body?: string | Buffer) => {
        const label = `${method} ${url}`;
        const answer = await server.request(method, url, headers, body)
          .catch((error: NodeJS.ErrnoException) => ({ status: 0, text: `no answer: ${error.code ?? error.message}`, headers: {} }));
        expect(answer.status, `${label}: ${answer.text}`).toBe(500);
        expect(JSON.parse(answer.text), label).toEqual(FIXED_500);
        const health = await server.request('GET', '/health');
        expect(health.status, `/health after ${label}`).toBe(200);
        expect(JSON.parse(health.text)).toEqual({ ok: true, schemaVersion: 15 });
        expect(server.running, `the API is still running after ${label}`).toBe(true);
      };

      await server.breakReads('accounts', 'transactions', 'symbol_price_bars');

      // The reads that used to run outside any try/catch, and stop the API.
      await expectFixed500('POST', '/accounts/fid/nav-history/import', { ...signedIn, 'Content-Type': 'application/pdf' }, STATEMENT);
      await expectFixed500('POST', '/import/activity-from-broker', { ...signedIn, ...json }, '{"broker":"fidelity"}');
      await expectFixed500('POST', '/import/from-broker', { ...signedIn, ...json }, '{"broker":"fidelity"}');
      await expectFixed500('POST', '/import/from-bookmarklet', { ...signedIn, ...json }, '{"broker":"fidelity"}');

      // Every other async route, each failing in its own database read.
      await expectFixed500('POST', '/import/nav-statement/preview', { ...signedIn, 'Content-Type': 'application/pdf' }, STATEMENT);
      await expectFixed500('GET', '/quotes?symbols=NVDA', signedIn);
      await expectFixed500('GET', '/symbols/NVDA/history?range=1M', signedIn);
      await expectFixed500('GET', '/portfolio/history?range=1M', signedIn);
      await expectFixed500('GET', '/portfolio/performance', signedIn);
      await expectFixed500('GET', '/accounts/fid/history?range=1M', signedIn);

      // Sign-in, last: without local_users no session can be read either.
      await server.breakReads('local_users');
      await expectFixed500('POST', '/auth/login', { ...csrf, ...json }, JSON.stringify({ username: 'alex', password: PASSWORD }));

      expect(await server.close(), 'the API shut down cleanly when asked, instead of crashing earlier').toBe(0);
      expect(server.printed).not.toContain(SENTINEL);
      expect(server.printed).not.toMatch(/SqliteError: |no such table/);
      // The error handler's lines: method, type and code only.
      expect(server.printed).toContain('[holdr-api] POST request failed: SqliteError SQLITE_ERROR');
      expect(server.printed).toContain('[holdr-api] GET request failed: SqliteError SQLITE_ERROR');
    } finally {
      if (server.running) server.child.kill('SIGKILL');
    }
  }, 120_000);
});
