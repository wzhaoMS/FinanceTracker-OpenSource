import fs from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { listenLoopback } from './loopback.js';

const SELF = fileURLToPath(import.meta.url);
const SRC = path.resolve(path.dirname(SELF), '..');
const IDENTIFIER = '[A-Za-z_$][\\w$]*';

const HELPERS = path.dirname(SELF);

/**
 * Every `*.test.ts` under apps/api/src except this one, whose examples break the rules on purpose, and every module in
 * src/testing: a helper's requests come from the tests that call it (the A9 oracle's once reached another process).
 */
function apiTestFiles(dir = SRC): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return apiTestFiles(full);
    const helper = full.startsWith(`${HELPERS}${path.sep}`) && entry.name.endsWith('.ts');
    return (entry.name.endsWith('.test.ts') || helper) && full !== SELF ? [full] : [];
  });
}

/** Blank out comments, keeping line numbers. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

function lineAt(source: string, index: number): string {
  const number = source.slice(0, index).split('\n').length;
  return `${number}: ${source.split('\n')[number - 1].trim()}`;
}

/** The local names a file binds to supertest (default, namespace, named or required). */
function supertestBindings(source: string): string[] {
  const names: string[] = [];
  const clauses = [
    ...[...source.matchAll(/^\s*import\s+(?!type\b)([^'";]+?)\s+from\s+['"]supertest['"]/gm)].map((match) => match[1]),
    ...[...source.matchAll(/(?:const|let|var)\s+([^=;]+?)\s*=\s*require\(\s*['"]supertest['"]\s*\)/g)].map((match) => match[1]),
  ];
  for (const clause of clauses) {
    const named = /\{([^}]*)\}/.exec(clause);
    for (const binding of named?.[1].split(',') ?? []) {
      const local = binding.trim().replace(/^type\s+/, '').split(/\s+as\s+|\s*:\s*/).pop()?.trim();
      if (local && !/^type\s/.test(binding.trim())) names.push(local);
    }
    const rest = clause.replace(/\{[^}]*\}/, '');
    names.push(...(rest.match(new RegExp(IDENTIFIER, 'g')) ?? []).filter((name) => name !== 'as'));
  }
  return [...new Set(names)];
}

/**
 * Calls that hand supertest something other than a fresh loopback server:
 * any call of a supertest binding (or its `.agent`) whose argument is not
 * `await listenLoopback(...)`. A bare app makes supertest listen on the
 * wildcard address; a server variable may have been bound anywhere.
 */
function bareSupertestCalls(source: string): string[] {
  const code = withoutComments(source);
  return supertestBindings(code).flatMap((name) => [...code.matchAll(new RegExp(
    `(?<![.\\w$])${name.replace(/\$/g, '\\$')}(?:\\s*\\.\\s*agent)?\\s*\\((?!\\s*await\\s+listenLoopback\\s*\\()`,
    'g',
  ))].map((match) => lineAt(code, match.index ?? 0)));
}

/** `.listen(` calls that name neither 127.0.0.1 nor a unix socket path. */
function nonLoopbackListens(source: string): string[] {
  const code = withoutComments(source);
  return [...code.matchAll(/\.listen\(([^\n]*)/g)]
    .filter(([, args]) => !/['"]127\.0\.0\.1['"]/.test(args) && !/^\s*['"`](?!\d)[^'"`]*['"`]\s*[,)]/.test(args))
    .map((match) => lineAt(code, match.index ?? 0));
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

describe('listenLoopback', () => {
  const app = express().get('/ping', (_req, res) => res.send('pong'));
  let fromEarlierTest: http.Server | undefined;

  it('serves the app to supertest from 127.0.0.1', async () => {
    const server = await listenLoopback(app);
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
    fromEarlierTest = server;
    await request(await listenLoopback(app)).get('/ping').expect(200, 'pong');
  });

  it('closes its servers when the test that opened them finishes', () => {
    expect(fromEarlierTest?.listening).toBe(false);
  });

  it('never shares a port with another 127.0.0.1 listener, which a wildcard bind can on macOS', async () => {
    // Another local process, e.g. an app's local server that answers 401.
    const other = http.createServer((_req, res) => res.writeHead(401).end('another process'));
    await listen(other, 0);
    const { port } = other.address() as AddressInfo;
    try {
      // A 127.0.0.1 bind cannot take a port another 127.0.0.1 listener holds,
      // so the kernel never hands one to listenLoopback.
      await expect(listen(http.createServer(app), port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await close(other);
    }
  });

  it("refuses supertest's own server for a bare app, a wildcard bind, before it binds (P-NET)", () => {
    // vitest.config.ts loads scripts/loopback-only.mjs into every test file (setupFiles).
    expect((net.Server.prototype.listen as unknown as Record<symbol, unknown>)[Symbol.for('holdr.p-net.loopback-only')]).toBe(true);
    // request(app) listens on every interface, where macOS would even let it take a port that another process holds on
    // 127.0.0.1, so that the test's requests reach that process.
    expect(() => request(app).get('/ping')).toThrow(/^P-NET: refused to listen on every interface/);
  });
});

describe('API tests bind their servers to 127.0.0.1', () => {
  const files = apiTestFiles();
  const violations = (check: (source: string) => string[]) => files.flatMap((file) => (
    check(fs.readFileSync(file, 'utf8')).map((where) => `${path.relative(SRC, file)}:${where}`)
  ));

  it('finds the API test files that use supertest, test helpers included', () => {
    const users = files.filter((file) => supertestBindings(withoutComments(fs.readFileSync(file, 'utf8'))).length > 0);
    expect(users.length).toBeGreaterThanOrEqual(7);
    expect(users.filter((file) => !file.endsWith('.test.ts')).map((file) => path.relative(SRC, file)))
      .toEqual(expect.arrayContaining([path.join('testing', 'cardImportOracle.ts'), path.join('testing', 'cardSyncOwnerWorld.ts')]));
  });

  it('every supertest call gets `await listenLoopback(app)`, never a bare app', () => {
    expect(violations(bareSupertestCalls)).toEqual([]);
  });

  it("every server a test starts listens on '127.0.0.1' (or a unix socket path)", () => {
    expect(violations(nonLoopbackListens)).toEqual([]);
  });

  it('the checks flag what they should and pass what they should', () => {
    const flagged = [
      "import request from 'supertest';\nawait request(app).get('/');",
      "import request from 'supertest';\nconst first = request(slowApp)\n  .post('/x');",
      "import request from 'supertest';\nawait request(server).get('/');",
      "import request from 'supertest';\nawait request(\n  app,\n).get('/');",
      "import request from 'supertest';\nawait request(listenLoopback(app)).get('/');",
      "import supertest from 'supertest';\nawait supertest.agent(app).get('/');",
      "import { agent as client } from 'supertest';\nawait client(app).get('/');",
      "import * as st from 'supertest';\nawait st.default(app);\nawait st(app);",
      "const request = require('supertest');\nrequest(app);",
    ];
    for (const source of flagged) expect(bareSupertestCalls(source), source).not.toEqual([]);
    const passed = [
      "import request from 'supertest';\nawait request(await listenLoopback(app)).get('/');",
      "import request from 'supertest';\nawait request(\n  await listenLoopback(slowApp),\n).get('/');",
      "import request from 'supertest';\n// request(app) is what we avoid\n/* request(app) */",
      "import type { Response } from 'supertest';\nconst request = (app: unknown) => app;\nrequest(app);",
    ];
    for (const source of passed) expect(bareSupertestCalls(source), source).toEqual([]);

    for (const source of ['app.listen(0);', 'server.listen(4000, () => {});', "server.listen(0, 'localhost');", 'server.listen({ port: 0 });']) {
      expect(nonLoopbackListens(source), source).not.toEqual([]);
    }
    for (const source of ["server.listen(0, '127.0.0.1', done);", "server.listen({ port: 0, host: '127.0.0.1' });", "unix.listen('probe.sock');", '// app.listen(0)']) {
      expect(nonLoopbackListens(source), source).toEqual([]);
    }
  });
});
