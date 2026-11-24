import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { hashPassword } from './auth/password.js';
import { CODE_IDENTITY_ALGORITHM, computeCodeIdentity, describeExecArgv, sha256File } from './release/codeIdentity.mjs';
import { LocalAuthRepo } from './services/localAuthRepo.js';
import { SqliteStateRepo } from './services/sqliteStateRepo.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, '..');
const repoRoot = path.resolve(apiDir, '..', '..');
const ORIGIN = 'http://127.0.0.1:5173';
const PASSWORD = 'correct horse battery';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  await exited;
  clearTimeout(timer);
}

/**
 * Remove a scratch directory once the API that used it has exited (stop).
 * Windows may release a stopped process's files (the database, its WAL)
 * a moment later, so deletion retries briefly on EBUSY, EPERM and the like.
 */
function removeScratch(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/**
 * NODE_OPTIONS as Node splits it into arguments: at spaces outside double quotes, a backslash escaping the next
 * character inside them.
 */
function nodeOptionsArgs(value: string): string[] {
  const args: string[] = [];
  let arg: string | null = null;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    let char = value.charAt(index);
    if (char === '\\' && quoted) {
      char = value.charAt(++index);
    } else if (char === ' ' && !quoted) {
      if (arg !== null) args.push(arg);
      arg = null;
      continue;
    } else if (char === '"') {
      quoted = !quoted;
      continue;
    }
    arg = (arg ?? '') + char;
  }
  if (arg !== null) args.push(arg);
  return args;
}

/**
 * The real path of the existing file a preload names from `cwd`, as codeIdentity.mjs's preloadPath reads a value (a
 * file: URL, an absolute path or a ./ or ../ path), or null: for a package name, or when no such file exists.
 */
function preloadFile(value: string, cwd: string): string | null {
  let file: string;
  if (value.startsWith('file:')) {
    try {
      file = fileURLToPath(value);
    } catch {
      return null;
    }
  } else if (path.isAbsolute(value) || /^\.\.?(?:[\\/]|$)/.test(value)) {
    file = path.resolve(cwd, value);
  } else {
    return null;
  }
  try {
    return statSync(file).isFile() ? realpathSync.native(file) : null;
  } catch {
    return null;
  }
}

/**
 * This run's own NODE_OPTIONS preloads, its --import and --require values in order and nothing else, as command-line
 * arguments for an API child started in `childCwd` without NODE_OPTIONS, as production starts it: how a gate run's
 * loopback guard reaches that child. Before the child starts, each value must name the same existing file from
 * `childCwd` as from `parentCwd`, by its real path. A package name, or a value that names no file or another file there,
 * is refused, so the child can never start without the run's guard.
 */
function guardedPreloads(nodeOptions: string | undefined, parentCwd: string, childCwd: string): string[] {
  const args = nodeOptionsArgs(nodeOptions ?? '');
  const preloads: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const flag = /^(--import|--require|-r)(?:=(.*))?$/.exec(args[index]);
    if (!flag) continue;
    const value: string | undefined = flag[2] ?? args[++index];
    const file = value === undefined ? null : preloadFile(value, parentCwd);
    if (value === undefined || file === null || preloadFile(value, childCwd) !== file) {
      throw new Error(`refused before the API starts: preload ${value ?? flag[1]} is not proven the same file from ${childCwd}`);
    }
    preloads.push(flag[1], value);
  }
  return preloads;
}

describe('the API entry point', () => {
  it('builds the app with createApp, which mounts card spending; index.ts mounts no routes itself', () => {
    const source = readFileSync(path.join(here, 'index.ts'), 'utf8');
    expect(source).toMatch(/createApp\(\{/);
    expect(source).not.toMatch(/cardSpending|CardSpending|\.use\(/);
    expect(readFileSync(path.join(here, 'app.ts'), 'utf8').match(/mountCardSpendingRoutes\(app,/g)).toHaveLength(1);
  });

  it('serves card spending only behind sign-in when actually started, and the service token only reads and imports', async () => {
    // A scratch data directory (HOLDR_DATA_DIR), so starting the real index.ts never opens a real database.
    const scratch = mkdtempSync(path.join(apiDir, '.real-app-test-'));
    const dataDir = path.join(scratch, 'data');
    let child: ChildProcess | undefined;
    try {
      mkdirSync(dataDir, { mode: 0o700 });
      // The user the holdr-user CLI would create.
      const seed = new SqliteStateRepo({ file: path.join(dataDir, 'finance.db') });
      new LocalAuthRepo(seed).createUser('tester', await hashPassword(PASSWORD, { ln: 10, r: 8, p: 1 }));
      seed.close();

      const port = await freePort();
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const name of ['HOLDR_E2E_RUN_ID', 'HOLDR_SERVICE_TOKEN_FILE', 'HOLDR_PUBLIC_ORIGIN']) delete env[name];
      child = spawn(process.execPath, ['--import', 'tsx', path.join(here, 'index.ts')], {
        cwd: apiDir,
        env: {
          ...env,
          // A private HOME: never the real default holdr.conf (PR B, design §8.1).
          HOME: scratch,
          HOLDR_DATA_DIR: dataDir,
          PORT: String(port),
          HOLDR_HOST: '127.0.0.1',
          SNAPSHOTS_ENABLED: '0',
          NODE_ENV: 'test',
          WEB_ORIGIN: ORIGIN,
        },
        stdio: 'ignore',
      });
      const base = `http://127.0.0.1:${port}`;
      let healthy = false;
      for (let attempt = 0; attempt < 150 && !healthy; attempt += 1) {
        healthy = await fetch(`${base}/health`).then((res) => res.ok, () => false);
        if (!healthy) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(healthy).toBe(true);

      const csrf = { Origin: ORIGIN, 'X-Holdr-Request': '1' };
      const json = { 'Content-Type': 'application/json' };
      const card = '{"issuer":"amex","owner":"alex","last4":"0003","currency":"USD"}';
      const attempts: Array<[string, string]> = [
        ['GET', '/card-accounts'],
        ['POST', '/card-accounts'],
        ['PATCH', '/card-accounts/card-acct-x'],
        ['POST', '/card-imports/preview?cardAccountId=x'],
        ['POST', '/card-imports/commit?cardAccountId=x'],
        ['GET', '/card-transactions'],
        ['GET', '/spending/summary'],
      ];
      for (const [method, url] of attempts) {
        const body = method === 'GET' ? undefined : card;
        const anonymous = await fetch(`${base}${url}`, { method, headers: { ...csrf, ...json }, body });
        expect(anonymous.status, `${method} ${url} without a session`).toBe(401);
        if (method !== 'GET') {
          const forged = await fetch(`${base}${url}`, { method, headers: json, body });
          expect(forged.status, `${method} ${url} without CSRF headers`).toBe(403);
        }
      }

      const login = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { ...csrf, ...json },
        body: JSON.stringify({ username: 'tester', password: PASSWORD }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.getSetCookie().find((value) => value.startsWith('holdr_session='))!.split(';')[0];
      const created = await fetch(`${base}/card-accounts`, { method: 'POST', headers: { ...csrf, ...json, Cookie: cookie }, body: card });
      expect(created.status).toBe(201);
      const listed = await fetch(`${base}/card-accounts`, { headers: { Cookie: cookie } });
      expect(listed.status).toBe(200);
      expect(((await listed.json()) as { cardAccounts: unknown[] }).cardAccounts).toHaveLength(1);

      const token = readFileSync(path.join(dataDir, 'service-token'), 'utf8').trim();
      const bearer = { Authorization: `Bearer ${token}` };
      expect((await fetch(`${base}/card-accounts`, { headers: bearer })).status).toBe(200);
      expect((await fetch(`${base}/card-accounts`, { method: 'POST', headers: { ...bearer, ...json }, body: card })).status).toBe(403);
      const preview = await fetch(`${base}/card-imports/preview?cardAccountId=card-acct-missing`, { method: 'POST', headers: { ...bearer, ...json }, body: '{}' });
      // The import routes take it: an empty object is no card-import payload (400), but not a 403.
      expect(preview.status).toBe(400);
    } finally {
      if (child) await stop(child);
      await removeScratch(scratch);
    }
  }, 60_000);

  it('stops without printing SQLite\'s message when a database read fails during startup', async () => {
    // SQLite's messages can quote what a database holds: here the table a view
    // over local_users points at is named after a synthetic card number.
    const PAN = '4111111111111111';
    const scratch = mkdtempSync(path.join(apiDir, '.real-app-test-'));
    const dataDir = path.join(scratch, 'data');
    let spawned: ChildProcess | undefined;
    try {
      mkdirSync(dataDir, { mode: 0o700 });
      const seed = new SqliteStateRepo({ file: path.join(dataDir, 'finance.db') });
      seed.internalGetDb().exec(`
        ALTER TABLE local_users RENAME TO local_users_kept;
        CREATE TABLE pan_${PAN} (x);
        CREATE VIEW local_users AS SELECT * FROM pan_${PAN};
        DROP TABLE pan_${PAN};
      `);
      seed.close();

      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const name of ['HOLDR_E2E_RUN_ID', 'HOLDR_SERVICE_TOKEN_FILE', 'HOLDR_PUBLIC_ORIGIN']) delete env[name];
      const child = spawn(process.execPath, ['--import', 'tsx', path.join(here, 'index.ts')], {
        cwd: apiDir,
        env: {
          ...env,
          // A private HOME: never the real default holdr.conf (PR B, design §8.1).
          HOME: scratch,
          HOLDR_DATA_DIR: dataDir,
          PORT: String(await freePort()),
          HOLDR_HOST: '127.0.0.1',
          SNAPSHOTS_ENABLED: '0',
          NODE_ENV: 'test',
          WEB_ORIGIN: ORIGIN,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      spawned = child;
      let printed = '';
      child.stdout!.on('data', (chunk: Buffer) => { printed += chunk; });
      child.stderr!.on('data', (chunk: Buffer) => { printed += chunk; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      const code = await new Promise<number | null>((resolve) => child.once('exit', (exitCode) => resolve(exitCode)));
      clearTimeout(timer);

      expect(code, printed).toBe(1);
      // The first read of local_users (counting the users) fails; the API reports the error's type and code only.
      expect(printed).toContain('[holdr-api] stopped: SqliteError SQLITE_ERROR');
      expect(printed).not.toContain(PAN);
      expect(printed).not.toMatch(/no such table|SqliteError: /);
    } finally {
      // It stops by itself; make sure it has before its files go.
      if (spawned) await stop(spawned);
      await removeScratch(scratch);
    }
  }, 60_000);

  it('serves the attestation it computed at startup, started as production starts it, to the service token on direct loopback only', async () => {
    const scratch = mkdtempSync(path.join(apiDir, '.real-app-test-'));
    const dataDir = path.join(scratch, 'data');
    let child: ChildProcess | undefined;
    try {
      mkdirSync(dataDir, { mode: 0o700 });
      const seed = new SqliteStateRepo({ file: path.join(dataDir, 'finance.db') });
      new LocalAuthRepo(seed).createUser('tester', await hashPassword(PASSWORD, { ln: 10, r: 8, p: 1 }));
      seed.close();

      const port = await freePort();
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const name of ['HOLDR_E2E_RUN_ID', 'HOLDR_SERVICE_TOKEN_FILE', 'HOLDR_PUBLIC_ORIGIN', 'NODE_OPTIONS']) delete env[name];
      // Production runs `$FT/node_modules/.bin/tsx src/index.ts` from apps/api; tsx's CLI starts the API as its child with
      // exactly these two preloads (tsx 4.21). Started the same way here, the API is this test's own child.
      const tsx = path.join(repoRoot, 'node_modules', 'tsx', 'dist');
      const preloads = [path.join(tsx, 'preflight.cjs'), path.join(tsx, 'loader.mjs')];
      // Test-only: the API runs without NODE_OPTIONS, as production's does, so what this run preloads through it (a gate
      // run's loopback guard) goes first on its command line instead, once proven the same files from apps/api.
      const runPreloads = guardedPreloads(process.env.NODE_OPTIONS, process.cwd(), apiDir);
      const spawnedAt = Date.now();
      child = spawn(process.execPath, [...runPreloads, '--require', preloads[0], '--import', pathToFileURL(preloads[1]).href,
        'src/index.ts'], {
        cwd: apiDir,
        env: {
          ...env,
          // A private HOME: never the real default holdr.conf (PR B, design §8.1).
          HOME: scratch,
          HOLDR_DATA_DIR: dataDir,
          PORT: String(port),
          HOLDR_HOST: '127.0.0.1',
          SNAPSHOTS_ENABLED: '0',
          // No price provider that asks a public endpoint: the 1D and 1W intraday bars, the Gold page's spot closes and
          // the overnight indicative overlay.
          HOLDR_INTRADAY_PRICES: '0',
          HOLDR_METALS_PRICES: '0',
          INDICATIVE_ENABLED: '0',
          NODE_ENV: 'test',
          WEB_ORIGIN: ORIGIN,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout!.on('data', (chunk: Buffer) => { output += chunk; });
      child.stderr!.on('data', (chunk: Buffer) => { output += chunk; });
      const base = `http://127.0.0.1:${port}`;
      let healthy = false;
      for (let attempt = 0; attempt < 150 && !healthy; attempt += 1) {
        healthy = await fetch(`${base}/health`).then((res) => res.ok, () => false);
        if (!healthy) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(healthy, output).toBe(true);
      expect(output).toMatch(/\[holdr-api\] release attestation ready \(\d+ ms\)\n/);

      const token = readFileSync(path.join(dataDir, 'service-token'), 'utf8').trim();
      const bearer = { Authorization: `Bearer ${token}` };
      const res = await fetch(`${base}/release/attestation`, { headers: bearer });
      expect(res.status, output).toBe(200);
      const text = await res.text();
      const body = JSON.parse(text) as { startedAt: string };
      const node = realpathSync.native(process.execPath);
      // What the uploader's release manifest pins for this tree (upload-mac-manifest.mjs buildReleaseManifest): the API's
      // Node, T/apps/api/src/index.ts, tsx's two preloads as T resolves them, no other flag, no NODE_OPTIONS, and the
      // code identity of T. Only this run's own preloads come first (test-only, above), as the attestation describes any.
      expect(Object.keys(body)).toEqual(['format', 'version', 'pid', 'startedAt', 'runtime', 'entry', 'preloads', 'flags',
        'nodeOptions', 'code']);
      expect(body).toEqual({
        format: 'holdr.api-release-attestation', version: 1, pid: child.pid, startedAt: body.startedAt,
        runtime: { execPath: node, version: process.version, sha256: sha256File(node) },
        entry: realpathSync.native(path.join(here, 'index.ts')),
        preloads: [...describeExecArgv(runPreloads, process.cwd()).preloads,
          ...preloads.map((file) => realpathSync.native(file))],
        flags: [], nodeOptions: false,
        code: { algorithm: CODE_IDENTITY_ALGORITHM, digest: computeCodeIdentity(realpathSync.native(repoRoot)).digest },
      });
      expect(Date.parse(body.startedAt)).toBeGreaterThanOrEqual(spawnedAt - 1_000);
      expect(Date.parse(body.startedAt)).toBeLessThanOrEqual(Date.now());
      // Computed once: the same bytes on every request.
      expect(await (await fetch(`${base}/release/attestation`, { headers: bearer })).text()).toBe(text);

      // Nobody else: no credentials, a browser session, or the token through a proxy.
      expect((await fetch(`${base}/release/attestation`)).status).toBe(401);
      const login = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { Origin: ORIGIN, 'X-Holdr-Request': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'tester', password: PASSWORD }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.getSetCookie().find((value) => value.startsWith('holdr_session='))!.split(';')[0];
      expect((await fetch(`${base}/release/attestation`, { headers: { Cookie: cookie } })).status).toBe(404);
      expect((await fetch(`${base}/release/attestation`, { headers: { ...bearer, 'X-Forwarded-For': '192.168.24.20' } })).status)
        .toBe(404);
    } finally {
      if (child) await stop(child);
      await removeScratch(scratch);
    }
  }, 60_000);

  it('gives a started API exactly the run\'s own preloads, each proven the same file from its directory before it starts', async () => {
    const scratch = mkdtempSync(path.join(apiDir, '.real-app-test-'));
    try {
      const parent = path.join(scratch, 'parent');
      const child = path.join(scratch, 'child');
      mkdirSync(parent);
      mkdirSync(child);
      const guard = path.join(parent, 'guard.mjs');
      for (const file of [guard, path.join(child, 'guard.mjs'), path.join(parent, 'only-here.cjs')]) writeFileSync(file, '');
      const url = pathToFileURL(guard).href;
      // Exactly the --import and --require values, in order, split as Node splits NODE_OPTIONS (here a quoted value with
      // its backslashes escaped), and none of its other flags.
      const quoted = `"${guard.replace(/\\/g, '\\\\')}"`;
      expect(guardedPreloads(`--max-old-space-size=256 --import=${url} --trace-warnings --require ${quoted}`, parent, child))
        .toEqual(['--import', url, '--require', guard]);
      expect(guardedPreloads('-r ./guard.mjs', parent, parent)).toEqual(['-r', './guard.mjs']);
      expect(guardedPreloads('--max-old-space-size=256', parent, child)).toEqual([]);
      expect(guardedPreloads(undefined, parent, child)).toEqual([]);
      // Refused before any API starts: a relative path that names another file, or none, from the API's directory; a
      // package name, which no string comparison proves a file; a file that does not exist.
      for (const options of ['--import ./guard.mjs', '-r ./only-here.cjs', '--import tsx',
        `--import=${pathToFileURL(path.join(parent, 'missing.mjs')).href}`]) {
        expect(() => guardedPreloads(options, parent, child), options).toThrow(/^refused before the API starts/);
      }
    } finally {
      await removeScratch(scratch);
    }
  });

  it('starts its snapshot scheduler only once it listens: a second API on the same port exits without one', async () => {
    const scratch = mkdtempSync(path.join(apiDir, '.real-app-test-'));
    const dataDir = path.join(scratch, 'data');
    const started: ChildProcess[] = [];
    try {
      mkdirSync(dataDir, { mode: 0o700 });
      const port = await freePort();
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const name of ['HOLDR_E2E_RUN_ID', 'HOLDR_SERVICE_TOKEN_FILE', 'HOLDR_PUBLIC_ORIGIN', 'SNAPSHOT_INTERVAL_MS']) delete env[name];
      const start = () => {
        const child = spawn(process.execPath, ['--import', 'tsx', path.join(here, 'index.ts')], {
          cwd: apiDir,
          env: {
            ...env,
            // A private HOME: never the real default holdr.conf (PR B, design §8.1).
            HOME: scratch,
            HOLDR_DATA_DIR: dataDir,
            PORT: String(port),
            HOLDR_HOST: '127.0.0.1',
            // On, as in production. Without accounts a tick fetches no quotes and writes no snapshot.
            SNAPSHOTS_ENABLED: '1',
            NODE_ENV: 'test',
            WEB_ORIGIN: ORIGIN,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        started.push(child);
        const output = { text: '' };
        child.stdout!.on('data', (chunk: Buffer) => { output.text += chunk; });
        child.stderr!.on('data', (chunk: Buffer) => { output.text += chunk; });
        return { child, output };
      };

      const first = start();
      const base = `http://127.0.0.1:${port}`;
      let healthy = false;
      for (let attempt = 0; attempt < 150 && !healthy; attempt += 1) {
        healthy = await fetch(`${base}/health`).then((res) => res.ok, () => false);
        if (!healthy) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(healthy, first.output.text).toBe(true);
      for (let attempt = 0; attempt < 50 && !first.output.text.includes('[snapshots] scheduler enabled'); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const listening = first.output.text.indexOf('[holdr-api] listening on');
      expect(listening, first.output.text).toBeGreaterThanOrEqual(0);
      expect(first.output.text.indexOf('[snapshots] scheduler enabled'), first.output.text).toBeGreaterThan(listening);

      // A duplicate start on the same data and port: it cannot bind, so it exits before any scheduler exists,
      // and never takes or shares the lease, which an API holds as its endpoint.
      const duplicate = start();
      const timer = setTimeout(() => duplicate.child.kill('SIGKILL'), 30_000);
      const code = await new Promise<number | null>((resolve) => duplicate.child.once('close', (exitCode) => resolve(exitCode)));
      clearTimeout(timer);
      expect(code, duplicate.output.text).toBe(1);
      expect(duplicate.output.text).toContain('EADDRINUSE');
      expect(duplicate.output.text).not.toContain('[snapshots]');
      expect(await fetch(`${base}/health`).then((res) => res.ok, () => false)).toBe(true);
    } finally {
      for (const child of started) await stop(child);
      await removeScratch(scratch);
    }
  }, 60_000);
});
