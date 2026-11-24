import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, readFile, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { connect } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer, type ViteDevServer } from 'vite';
// P-NET: refuses any listener beyond 127.0.0.1 or ::1 in this process.
import '../../scripts/loopback-only.mjs';
import { guardHttpDispatch } from './requestTarget.js';

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webRoot, '../..');

type Probe = {
  name: string;
  url: string;
  accept?: string;
  method?: string;
  headers?: Record<string, string>;
  allowed?: boolean;
  editor?: boolean;
};

function rawRequest(target: string, options: {
  method?: string;
  accept?: string;
  headers?: Record<string, string>;
  host?: string | null;
  version?: '1.0' | '1.1';
  closeOnHeaders?: boolean;
  timeoutMs?: number;
} = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: 5308 });
    const chunks: Buffer[] = [];
    socket.setTimeout(options.timeoutMs ?? 10_000, () => socket.destroy(new Error('Raw HTTP request timed out')));
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      if (options.closeOnHeaders && Buffer.concat(chunks).includes('\r\n\r\n')) socket.destroy();
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ECONNRESET') reject(error);
    });
    socket.on('connect', () => {
      const host = options.host === undefined ? '127.0.0.1:5308' : options.host;
      const headers = [
        ...(host === null ? [] : [`Host: ${host}`]),
        `Accept: ${options.accept ?? '*/*'}`,
        ...Object.entries(options.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
        ...(Object.keys(options.headers ?? {}).some((name) => name.toLowerCase() === 'connection') ? [] : ['Connection: close']),
        'Content-Length: 0',
      ];
      // Deliberately no URL parser or HTTP client: preserve the request target byte-for-byte.
      socket.write(`${options.method ?? 'GET'} ${target} HTTP/${options.version ?? '1.1'}\r\n${headers.join('\r\n')}\r\n\r\n`, 'latin1');
    });

    socket.on('close', () => {
      const response = Buffer.concat(chunks);
      let offset = 0;
      let status = 0;
      let headers = '';
      while (offset < response.length) {
        const end = response.indexOf('\r\n\r\n', offset);
        if (end === -1) break;
        headers = response.subarray(offset, end).toString('latin1');
        status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(headers)?.[1] ?? 0);
        offset = end + 4;
        if (status >= 200 || status === 101) break;
      }
      let body = response.subarray(offset);
      if (/^transfer-encoding:\s*chunked/im.test(headers)) {
        const decoded: Buffer[] = [];
        let cursor = 0;
        while (cursor < body.length) {
          const end = body.indexOf('\r\n', cursor);
          if (end === -1) break;
          const size = Number.parseInt(body.subarray(cursor, end).toString('ascii'), 16);
          if (!Number.isFinite(size) || size === 0) break;
          decoded.push(body.subarray(end + 2, end + 2 + size));
          cursor = end + 2 + size + 2;
        }
        body = Buffer.concat(decoded);
      }
      resolve({ status, body: body.toString('utf8') });
    });
  });
}

function get(url: string, accept = '*/*', method = 'GET', headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    // Unlike fetch/new URL, this preserves traversal sequences on the wire.
    const req = request({
      hostname: '127.0.0.1', port: 5308, path: url, method, headers: { accept, ...headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({
        status: res.statusCode!, body: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error(`Timed out: ${url}`)));
    req.end();
  });
}

test('Vite serves only frontend files, never private runtime data', async (t) => {
  const id = `test-vite-fs-${randomUUID()}`;
  const secret = `PRIVATE_FIXTURE_${randomUUID()}`;
  const files: string[] = [];
  const directories = new Set<string>();
  const editorProcesses: Promise<void>[] = [];
  const editorEnvironment = {
    LAUNCH_EDITOR: process.env.LAUNCH_EDITOR,
    HOLDR_EDITOR_RECORD: process.env.HOLDR_EDITOR_RECORD,
  };
  let server: ViteDevServer | undefined;

  async function directory(dir: string) {
    const firstCreated = await mkdir(dir, { recursive: true });
    if (firstCreated) {
      for (let current = dir; ; current = path.dirname(current)) {
        directories.add(current);
        if (current === firstCreated) break;
      }
    }
  }

  async function fixture(relativePath: string, contents = secret) {
    const file = path.join(repoRoot, relativePath);
    await directory(path.dirname(file));
    await writeFile(file, contents, { flag: 'wx', mode: 0o600 });
    files.push(file);
    return file;
  }

  async function link(relativePath: string, target: string) {
    const file = path.join(repoRoot, relativePath);
    await directory(path.dirname(file));
    await symlink(target, file);
    files.push(file);
    return file;
  }

  t.after(async () => {
    try {
      await server?.close();
      await Promise.all(editorProcesses);
    } finally {
      for (const [name, value] of Object.entries(editorEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      for (const file of files.reverse()) {
        await unlink(file).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
      for (const dir of [...directories].sort((a, b) => b.length - a.length)) {
        // Never recursively remove a directory that might contain someone else's data.
        await rmdir(dir).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error;
        });
      }
    }
  });

  const database = await fixture(`apps/api/data/${id}.db`);
  const token = await fixture(`apps/api/data/${id}/service-token`);
  const note = await fixture(`apps/api/data/${id}/notes.txt`);
  const backup = await fixture(`backups/${id}/ledger.txt`);
  const arbitrary = await fixture(`${id}/outside.txt`);
  const sibling = await fixture(`apps/web-${id}/outside.txt`);
  const module = await fixture(`apps/api/data/${id}/private.ts`, `export default ${JSON.stringify(secret)};`);
  const html = await fixture(`apps/api/data/${id}/private.html`, `<p>${secret}</p>`);
  const svg = await fixture(`apps/api/data/${id}/private.svg`, `<svg xmlns="http://www.w3.org/2000/svg"><text>${secret}</text></svg>`);
  const privateMap = await fixture(`apps/api/data/${id}/private.js.map`, JSON.stringify({
    version: 3, sources: [], names: [], mappings: '', sourcesContent: [secret],
  }));
  const localDependency = await fixture(`apps/web/node_modules/${id}/frontend.js`, 'export const frontend = true;');
  const spacedFrontend = await fixture(`apps/web/${id}/frontend space.txt`, 'public frontend fixture');
  const reservedAliases: { name: string; url: string }[] = [];
  for (const escape of ['3B', '3A', '40', '26', '3D', '2B', '24', '2C']) {
    const alias = await link(`apps/web/${id}/reserved%${escape}.txt`, token);
    reservedAliases.push({ name: `%${escape}`, url: `/${path.relative(webRoot, alias)}` });
  }
  const editorRecord = await fixture(`${id}/editor-record.log`, '');
  const editorStub = await fixture(`${id}/record-editor.sh`,
    '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$HOLDR_EDITOR_RECORD"\n');
  await chmod(editorStub, 0o700);
  process.env.LAUNCH_EDITOR = editorStub;
  process.env.HOLDR_EDITOR_RECORD = editorRecord;
  await promisify(childProcess.execFile)(editorStub, ['recording-self-check']);
  assert.equal(await readFile(editorRecord, 'utf8'), 'recording-self-check\n');
  await writeFile(editorRecord, '');

  const spawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    if (args[0] === editorStub) {
      // Vite responds before its editor child exits; wait for actual recording, not a sleep.
      editorProcesses.push(new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Editor stub exited ${code}`)));
      }));
    }
    return child;
  });

  const vectors: Probe[] = [];
  const corpus: Probe[] = [];
  const leakedMarker = (body: string) => {
    const inlineBodies = [...body.matchAll(/data:[^"'\s]*?;base64,([A-Za-z0-9+/=]+)/g)]
      .map((match) => Buffer.from(match[1], 'base64').toString('utf8'));
    return [body, ...inlineBodies].some((value) => value.includes(secret.slice(0, 32)));
  };
  const fsUrl = (file: string) => `/@fs/${file}`;
  const webUrl = (file: string) => `/${path.relative(webRoot, file).split(path.sep).join('/')}`;
  const importer = await fixture(`apps/web/${id}/importer.ts`, `export { default } from ${JSON.stringify(fsUrl(module))};`);
  const add = (name: string, url: string, accept?: string, method?: string, headers?: Record<string, string>) => {
    vectors.push({ name, url, accept, method, headers });
  };
  const queries = ['', '?raw', '?url', '?import', '?inline', '?raw&import', '?url&import', '?url&inline&import'];
  for (const [name, file] of [['database', database], ['service-token', token], ['backup', backup]]) {
    for (const [route, base] of [['@fs', fsUrl(file)], ['absolute', file], ['@id', `/@id/${file}`]]) {
      for (const query of queries) add(`${name} ${route}${query || ' plain'}`, base + query);
    }
  }

  for (const suffix of ['-wal', '-shm', '-journal']) {
    add(`database sidecar ${suffix}`, fsUrl(await fixture(`apps/api/data/${id}.db${suffix}`)));
  }
  for (const filename of ['state.json', 'store.sqlite', 'store.sqlite3-wal', 'service-token.bak']) {
    add(`API runtime ${filename}`, fsUrl(await fixture(`apps/api/data/${id}/${filename}`)));
  }
  for (const [name, file] of [['arbitrary repo file', arbitrary], ['sibling prefix path', sibling], ['API text', note], ['TypeScript transform', module], ['HTML', html], ['SVG', svg]]) {
    for (const query of ['', '?import', '?raw&import', '?url&inline&import']) {
      add(`${name}${query || ' plain'}`, fsUrl(file) + query);
    }
  }
  for (const query of ['?raw??', '?raw&', '?raw&import&', '?url&inline&&', '?inline&import']) {
    add(`trailing/query variation ${query}`, fsUrl(database) + query);
  }

  const extensionlessHtml = await link(`apps/web/${id}/private-page.html`, html);
  add('SPA extensionless HTML symlink', webUrl(extensionlessHtml).replace(/\.html$/, ''), 'text/html');
  const directoryHtml = await link(`apps/web/${id}/html-directory/index.html`, html);
  add('SPA directory index symlink', `${webUrl(path.dirname(directoryHtml))}/`, 'text/html');
  const sourcemap = await link(`node_modules/.vite/deps/${id}.js.map`, note);
  add('dependency source map symlink', fsUrl(sourcemap));
  add('dependency source map symlink raw', fsUrl(sourcemap) + '?raw&import');

  const alias = path.join(repoRoot, 'node_modules/@finance-tracker/api/data');
  for (const [name, file] of [['db', path.join(alias, `${id}.db`)], ['text', path.join(alias, id, 'notes.txt')]]) {
    for (const query of ['', '?raw&import', '?url&inline&import']) {
      add(`API workspace symlink ${name}${query || ' plain'}`, fsUrl(file) + query);
    }
    add(`API workspace @id ${name}`, `/@id/@finance-tracker/api/data/${path.relative(alias, file)}?raw&import`);
  }

  for (const [name, base] of [['web', 'apps/web'], ['shared', 'packages/shared'], ['dependencies', 'node_modules']]) {
    const renamed = await link(`${base}/${id}/renamed.txt`, database);
    add(`${name} renamed file symlink`, fsUrl(renamed));
    add(`${name} renamed file symlink raw`, fsUrl(renamed) + '?raw&import');
    const escaped = await link(`${base}/${id}/escaped`, path.dirname(note));
    add(`${name} directory symlink`, fsUrl(path.join(escaped, 'notes.txt')));
    if (name === 'web') {
      add('web-relative renamed symlink', webUrl(renamed));
      add('web-relative renamed symlink raw', webUrl(renamed) + '?raw&import');
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        add(`renamed symlink ${method}`, webUrl(renamed), '*/*', method);
      }
      const repoLink = await link(`${base}/${id}/unrelated.txt`, arbitrary);
      add('web symlink to non-runtime repo file', webUrl(repoLink));
    }
  }

  for (const filename of [
    '.env', '.env.production', 'secret.crt', 'secret.pem', '.git/config',
    'secret.db', 'secret.DB-WAL', 'secret.db-shm', 'secret.sqlite3', 'secret.sqlite-journal',
    'service-token', 'service-token.bak', 'state.json.bak', 'server.log', '.last-run.json',
    'backups/ledger.txt', '.e2e-tmp/ledger.txt', '.e2e-logs/output.txt',
    'profiles/cookies.json', 'holdr-logs/output.txt',
    'test-results/trace.zip', 'playwright-report/report.json', 'blob-report/report.zip',
    '.turbo/output.txt', '.expo/state.json', '.next/server.txt',
    'snapshot.tgz', 'snapshot.tar.gz', 'snapshot.zip',
  ]) {
    const file = await fixture(`apps/web/${id}/private/${filename}`);
    add(`deny inside web: ${filename}`, webUrl(file));
    add(`deny inside web raw: ${filename}`, fsUrl(file) + '?raw&import');
  }

  const publicFile = await fixture(`apps/web/public/${id}/public-secret.txt`);
  const publicLink = await link(`apps/web/public/${id}/public-renamed.txt`, database);
  const publicEnv = await fixture(`apps/web/public/${id}/.env`);
  for (const [name, file] of [['text', publicFile], ['symlink', publicLink], ['env', publicEnv]]) {
    const url = `/${path.relative(path.join(webRoot, 'public'), file)}`;
    add(`publicDir ${name}`, url);
    add(`publicDir ${name} raw`, url + '?raw&import');
    add(`publicDir explicit ${name}`, webUrl(file));
  }

  const relativeDatabase = path.relative(webRoot, database);
  for (const [name, traversal] of [
    ['literal', relativeDatabase],
    ['encoded dots', relativeDatabase.replace('..', '%2e%2e')],
    ['double-encoded dots', relativeDatabase.replace('..', '%252e%252e')],
    ['encoded separators', relativeDatabase.replaceAll('/', '%2f')],
    ['backslashes', relativeDatabase.replaceAll('/', '\\')],
    ['encoded backslashes', relativeDatabase.replaceAll('/', '%5c')],
    ['double-encoded backslashes', relativeDatabase.replaceAll('/', '%255c')],
  ]) {
    add(`traversal ${name} @fs`, `${fsUrl(webRoot)}/${traversal}`);
    add(`traversal ${name} web raw`, `/${traversal}?raw&import`);
  }
  add('fully encoded absolute @fs', `/@fs/${encodeURIComponent(database)}`);
  add('encoded @fs prefix', `/@%66s/${database}`);
  add('encoded @id prefix', `/@%69d/${database}?raw&import`);
  add('null-byte @id', `/@id/__x00__${database}?raw&import`);
  add('encoded null byte', `${fsUrl(database)}%00?raw&import`);
  add('database trailing slash', `${fsUrl(database)}/`);
  add('database HEAD', fsUrl(database), '*/*', 'HEAD');
  add('database POST', fsUrl(database), '*/*', 'POST');
  add('database byte range', fsUrl(database), '*/*', 'GET', { Range: 'bytes=0-31' });
  const databaseStat = await stat(database);
  add('database conditional GET', fsUrl(database), '*/*', 'GET', {
    'If-None-Match': `W/"${databaseStat.size}-${databaseStat.mtime.getTime()}"`,
  });
  add('SPA HTML file', fsUrl(html), 'text/html');
  add('SPA database navigation', fsUrl(database), 'text/html');
  add('SPA missing private file', `${fsUrl(database)}-missing`, 'text/html');
  add('SPA absolute private HTML', html, 'text/html');
  add('SPA traversal HTML', `/${path.relative(webRoot, html)}`, 'text/html');

  const backupStamp = `20990101T000000Z-${id}`;
  for (const filename of ['finance.db', 'finance.db-wal', 'finance.db-shm', 'source.tgz', 'source.tar.gz', 'source.zip']) {
    const file = await fixture(`backups/${backupStamp}/${filename}`);
    for (const [route, base] of [['@fs', fsUrl(file)], ['absolute', file]]) {
      for (const query of ['', '?raw&import', '?url&inline&import']) {
        add(`timestamped backup ${filename} ${route}${query || ' plain'}`, base + query);
      }
    }
    add(`timestamped backup ${filename} HEAD`, fsUrl(file), '*/*', 'HEAD');
  }
  for (const [name, base] of [['shared', 'packages/shared'], ['dependencies', 'node_modules']]) {
    for (const filename of ['snapshot.tgz', 'snapshot.tar.gz', 'snapshot.zip']) {
      const file = await fixture(`${base}/${id}/${filename}`);
      add(`archive inside ${name}: ${filename}`, fsUrl(file));
      add(`archive inside ${name} raw: ${filename}`, fsUrl(file) + '?raw&import');
    }
  }

  server = await createServer({
    root: webRoot,
    configFile: path.join(webRoot, 'vite.config.ts'),
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 5308, strictPort: true },
  });
  await server.listen();

  const editorPaths = [
    '/__open-in-editor', '/__open-in-editor/', '/__OPEN-IN-EDITOR', '/__open-in-editor.extra',
    '/%5F%5Fopen-in-editor', '/%5f%5fOPEN-IN-EDITOR/', '/__open%2Din%2Deditor',
    '/__open-in-%65ditor', '/__open-in-editor%2eextra', '/__open-in-editor%2f',
    '/%255F%255Fopen-in-editor',
  ];
  const normalizedEditorPaths = [
    '/./__open-in-editor', '/%2e/__open-in-editor', '/.//__OPEN-IN-EDITOR.extra',
    '/a/../__open-in-editor', '/%2e%2e/__open-in-editor',
  ];
  const editorRequests = [
    ...editorPaths.map((url) => ({ url, target: token, method: 'GET', accept: '*/*' })),
    ...normalizedEditorPaths.flatMap((url) => ['*/*', 'text/x-vite-ping'].map((accept) => ({
      url, target: token, method: 'GET', accept,
    }))),
    ...['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map((method) => ({
      url: '/__open-in-editor', target: token, method, accept: '*/*',
    })),
    { url: '/__open-in-editor', target: path.join(webRoot, 'index.html'), method: 'GET', accept: '*/*' },
    { url: '/__open-in-editor', target: '', method: 'GET', accept: '*/*' },
    { url: '/__open-in-editor', target: token, method: 'GET', accept: 'text/x-vite-ping' },
  ];
  for (const { url, target, method, accept } of editorRequests) {
    const requestUrl = `${url}${target ? `?file=${encodeURIComponent(target)}:1:1` : ''}`;
    corpus.push({ name: `editor ${corpus.length + 1}`, url: requestUrl, method, accept, editor: true });
    await t.test(`host editor disabled: ${method} ${url} (${target === token ? 'private' : target ? 'frontend' : 'no file'}, ${accept})`, async (st) => {
      const initialLaunches = editorProcesses.length;
      const { status } = await get(requestUrl, accept, method);
      await Promise.all(editorProcesses);
      st.diagnostic(JSON.stringify({ editor: url, method, status, launches: editorProcesses.length - initialLaunches }));
      assert.equal(status, 403);
      assert.equal(editorProcesses.length, 0, 'No request may start an editor on the host');
      assert.equal(await readFile(editorRecord, 'utf8'), '');
    });
  }
  await t.test('editor recording stub was never invoked by a request', async () => {
    await Promise.all(editorProcesses);
    assert.equal(editorProcesses.length, 0);
    assert.equal(await readFile(editorRecord, 'utf8'), '');
  });
  await t.test('Vite HMR ping remains available without host actions', async () => {
    assert.equal((await get('/__vite_ping', 'text/x-vite-ping')).status, 204);
  });
  await t.test('network-facing client RPC cannot fetch server modules', async () => {
    const response = await server!.environments.client.hot.handleInvoke({
      type: 'custom',
      event: 'vite:invoke',
      data: { name: 'fetchModule', data: [token] },
    });
    assert.ok('error' in response);
    assert.match(response.error.message, /fetchModule is disabled in this environment/);
  });

  for (const [name, url] of [
    ['app index', '/'],
    ['app entry', '/src/main.tsx'],
    ['Vite client', '/@vite/client'],
    ['React refresh', '/@react-refresh'],
    ['shared source', fsUrl(path.join(repoRoot, 'packages/shared/src/index.ts'))],
    ['shared workspace symlink', fsUrl(path.join(repoRoot, 'node_modules/@finance-tracker/shared/src/index.ts'))],
    ['web-local dependency', fsUrl(localDependency)],
    ['importer cannot expand allowed roots', webUrl(importer)],
    ['ordinary SPA navigation', '/holdr-dashboard'],
  ]) {
    corpus.push({ name, url, accept: name.includes('navigation') ? 'text/html' : '*/*', allowed: true });
    await t.test(name, async (st) => {
      const { status } = await get(url, name.includes('navigation') ? 'text/html' : '*/*');
      st.diagnostic(JSON.stringify({ name, status, allowed: true }));
      assert.equal(status, 200);
    });
  }

  await server.waitForRequestsIdle();
  // Vite recognizes cache directories by prefix; avoid its concurrently replaced deps/ directory.
  const optimizedMap = await link(`${path.relative(repoRoot, server.config.cacheDir)}/deps_${id}/private.js.map`, privateMap);
  assert.ok(server.environments.client.depsOptimizer?.isOptimizedDepUrl(webUrl(optimizedMap)));
  add('optimized dependency source map symlink', webUrl(optimizedMap));
  add('optimized dependency source map symlink raw', webUrl(optimizedMap) + '?raw&import');

  for (const { name, url, accept, method, headers } of vectors) {
    corpus.push({ name, url, accept, method, headers });
    await t.test(name, async (st) => {
      const { status, body } = await get(url, accept, method, headers);
      const leaked = leakedMarker(body);
      st.diagnostic(JSON.stringify({ name, status, leaked, allowed: false }));
      assert.ok(!leaked, `${name}: leaked synthetic private data (${status})`);
      assert.ok(status === 403 || status === 404, `${name}: expected 403/404, got ${status}`);
    });
  }

  assert.equal(corpus.length, 298 + 30);
  const authority = '127.0.0.1:5308';
  const forms = [
    { name: 'origin', target: (url: string) => url },
    ...['http', 'https', 'hTtP', 'hTtPs', 'holdr+test'].map((scheme) => ({
      name: scheme, target: (url: string) => `${scheme}://${authority}${url}`,
    })),
    { name: 'authority GET', target: (url: string) => `${authority}${url}`, method: 'GET' },
    { name: 'authority CONNECT', target: () => authority, method: 'CONNECT' },
    { name: 'asterisk OPTIONS', target: () => '*', method: 'OPTIONS' },
  ];
  for (const form of forms) {
    await t.test(`raw sockets: complete corpus in ${form.name} form`, async (st) => {
      const statuses: Record<number, number> = {};
      const failures: string[] = [];
      let leaks = 0;
      const initialLaunches = editorProcesses.length;
      for (const probe of corpus) {
        const beforeLaunches = editorProcesses.length;
        const { status, body } = await rawRequest(form.target(probe.url), {
          method: form.method ?? probe.method,
          accept: probe.accept,
          headers: {
            ...probe.headers,
            'X-Original-URL': probe.url,
            'X-Rewrite-URL': probe.url,
          },
        });
        await Promise.all(editorProcesses);
        statuses[status] = (statuses[status] ?? 0) + 1;
        const leaked = leakedMarker(body);
        if (leaked) leaks++;
        const expected = form.name !== 'origin' ? [400, 403]
          : probe.allowed ? [200]
            : probe.editor || /database|finance\.db/.test(probe.name) ? [403] : [403, 404];
        if (!expected.includes(status) || leaked || editorProcesses.length !== beforeLaunches
          || (form.name !== 'origin' && body !== '')) {
          failures.push(`${probe.name}: ${status}, leak=${leaked}, launches=${editorProcesses.length - beforeLaunches}`);
        }
      }
      st.diagnostic(JSON.stringify({
        form: form.name, requests: corpus.length, statuses, leaks,
        launches: editorProcesses.length - initialLaunches, failures: failures.length,
      }));
      assert.equal(failures.length, 0, failures.slice(0, 8).join('\n'));
    });
  }

  const editorTarget = `/__open-in-editor?file=${encodeURIComponent(path.join(repoRoot, 'package.json'))}`;
  const edgeCases: {
    name: string;
    target: string;
    options?: Parameters<typeof rawRequest>[1];
    statuses: number[];
  }[] = [
    { name: 'origin HTTP/1.0 with Host', target: '/', options: { version: '1.0' }, statuses: [200] },
    { name: 'origin HTTP/1.0 without Host', target: '/', options: { version: '1.0', host: null }, statuses: [403] },
    { name: 'origin editor HTTP/1.0 without Host', target: editorTarget, options: { version: '1.0', host: null }, statuses: [403] },
    { name: 'origin query with encoded fragment and semicolon', target: '/index.html?next=%23home;mode=1', statuses: [200] },
    { name: 'ordinary encoded space in frontend path', target: webUrl(spacedFrontend).replace(' ', '%20'), statuses: [200] },
    { name: 'original/rewrite headers cannot replace the target', target: '/', options: {
      headers: { 'X-Original-URL': `http://${authority}${editorTarget}`, 'X-Rewrite-URL': editorTarget },
    }, statuses: [200] },
    { name: 'absolute HTTP/1.0 without Host', target: `http://${authority}${editorTarget}`, options: { version: '1.0', host: null }, statuses: [403] },
    { name: 'absolute authority differs from allowed Host', target: `http://untrusted.invalid${editorTarget}`, statuses: [403] },
    { name: 'allowed absolute authority differs from denied Host', target: `http://${authority}${editorTarget}`, options: { host: 'untrusted.invalid' }, statuses: [403] },
    { name: 'absolute authority with user info', target: `http://ignored@${authority}${editorTarget}`, statuses: [403] },
    { name: 'leading double slash authority', target: `//${authority}${editorTarget}`, statuses: [403] },
    { name: 'leading double slash frontend', target: '//src/main.tsx', statuses: [403] },
    { name: 'leading double slash editor', target: `/${editorTarget}`, statuses: [403] },
    { name: 'leading backslash', target: `\\${editorTarget}`, statuses: [400, 403] },
    { name: 'leading slash backslash', target: `/\\${editorTarget}`, statuses: [403] },
    { name: 'leading encoded slash', target: `%2F${editorTarget}`, statuses: [400, 403] },
    { name: 'leading slash encoded slash', target: `/%2F${editorTarget}`, statuses: [403] },
    { name: 'relative editor target', target: editorTarget.slice(1), statuses: [400, 403] },
    { name: 'fragment on index', target: '/index.html#fragment', statuses: [403] },
    { name: 'fragment after query', target: '/index.html?next=x#fragment', statuses: [403] },
    { name: 'editor semicolon suffix', target: `/__open-in-editor;param=1?file=${encodeURIComponent(token)}`, statuses: [403] },
    { name: 'database semicolon suffix', target: `${fsUrl(database)};param=1`, statuses: [403] },
    { name: 'very long absolute target', target: `http://${authority}/${'x'.repeat(8_000)}`, statuses: [403] },
    { name: 'target beyond HTTP parser limit', target: `http://${authority}/${'x'.repeat(20_000)}`, statuses: [400, 403, 414, 431] },
    ...reservedAliases.flatMap(({ name, url }) => ['', '?raw&import'].map((query) => ({
      name: `URI/component decoder disagreement ${name}${query}`, target: url + query, statuses: [403],
    }))),
  ];
  for (const edge of edgeCases) {
    await t.test(`raw request-target edge: ${edge.name}`, async (st) => {
      const initialLaunches = editorProcesses.length;
      const { status, body } = await rawRequest(edge.target, edge.options);
      await Promise.all(editorProcesses);
      const launches = editorProcesses.length - initialLaunches;
      const leaked = leakedMarker(body);
      st.diagnostic(JSON.stringify({ edge: edge.name, status, launches, leaked }));
      assert.ok(edge.statuses.includes(status), `Expected ${edge.statuses}, got ${status}`);
      assert.equal(launches, 0);
      assert.equal(leaked, false);
    });
  }
  await t.test('no raw-socket request invoked the editor stub', async () => {
    await Promise.all(editorProcesses);
    assert.equal(editorProcesses.length, 0);
    assert.equal(await readFile(editorRecord, 'utf8'), '');
  });

  const indexMethods = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'];
  for (const [baseName, base] of [['web', 'apps/web'], ['shared', 'packages/shared'], ['dependencies', 'node_modules']]) {
    for (const entry of ['index', 'index.html', 'index.htm', 'index.js', 'index.ts', 'index.json']) {
      await t.test(`implicit directory entry is forbidden: ${baseName}/${entry}`, async (st) => {
        const relativeDir = `${base}/${id}/implicit-${entry.replaceAll('.', '-')}.map`;
        const index = await link(`${relativeDir}/${entry}`, token);
        const dir = path.dirname(index);
        const routes = [fsUrl(dir), ...(baseName === 'web' ? [webUrl(dir)] : [])];
        const statuses: Record<number, number> = {};
        const failures: string[] = [];
        let leaks = 0;
        let requests = 0;
        for (const route of routes) {
          for (const method of indexMethods) {
            for (const suffix of ['', '/']) {
              const { status, body } = await get(route + suffix, '*/*', method);
              const leaked = leakedMarker(body);
              requests++;
              statuses[status] = (statuses[status] ?? 0) + 1;
              if (leaked) leaks++;
              if (status !== 403 || leaked) failures.push(`${method} ${route}${suffix}: ${status}, leak=${leaked}`);
            }
          }
          const direct = await get(`${route}/${entry}`);
          requests++;
          statuses[direct.status] = (statuses[direct.status] ?? 0) + 1;
          if (leakedMarker(direct.body)) leaks++;
          if (direct.status !== 403 || leakedMarker(direct.body)) failures.push(`direct ${entry}: ${direct.status}`);
        }
        st.diagnostic(JSON.stringify({ index: `${baseName}/${entry}`, requests, statuses, leaks, failures: failures.length }));
        assert.equal(failures.length, 0, failures.slice(0, 8).join('\n'));
      });
    }
  }
  await t.test('only root index.html can serve as a directory entry', async (st) => {
    await link('apps/web/index', token);
    const probes = [
      ...indexMethods.flatMap((method) => ['', '/'].map((suffix) => ({
        url: fsUrl(webRoot) + suffix, method, expected: 403,
      }))),
      ...indexMethods.map((method) => ({
        url: '/', method, expected: method === 'GET' || method === 'HEAD' ? 200 : 403,
      })),
      { url: '/index', method: 'GET', expected: 403 },
    ];
    const statuses: Record<number, number> = {};
    const failures: string[] = [];
    let leaks = 0;
    for (const { url, method, expected } of probes) {
      const { status, body } = await get(url, '*/*', method);
      const leaked = leakedMarker(body);
      statuses[status] = (statuses[status] ?? 0) + 1;
      if (leaked) leaks++;
      if (status !== expected || leaked) failures.push(`${method} ${url}: ${status}, leak=${leaked}`);
    }
    st.diagnostic(JSON.stringify({ index: 'app root', requests: probes.length, statuses, leaks, failures: failures.length }));
    assert.equal(failures.length, 0, failures.slice(0, 8).join('\n'));
  });

  await t.test('in-process transforms cannot load imported files outside the roots', async (st) => {
    let rejected = false;
    try {
      await server!.transformRequest(fsUrl(module));
    } catch {
      rejected = true;
    }
    st.diagnostic(JSON.stringify({ name: 'in-process transformRequest', rejected }));
    assert.ok(rejected, 'import analysis must not grant safeModulePaths access to private source');
  });
});

function fakeResponse() {
  return {
    statusCode: 0, headersSent: false, writableEnded: false, destroyed: false,
    writeHead(status: number) { this.statusCode = status; this.headersSent = true; return this; },
    end() { this.writableEnded = true; return this; },
    destroy() { this.destroyed = true; return this; },
  };
}

function fakeSocket() {
  const socket = new EventEmitter();
  return Object.assign(socket, {
    bytesWritten: 0, writableEnded: false, destroyed: false, response: '', resumed: false,
    resume() { this.resumed = true; return this; },
    write(data: string | Buffer) {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
      this.response += bytes.toString('latin1');
      this.bytesWritten += bytes.length;
      return true;
    },
    end(data: string | Buffer, callback?: () => void) {
      this.write(data);
      this.writableEnded = true;
      callback?.();
      return this;
    },
    destroy() {
      if (!this.destroyed) {
        this.destroyed = true;
        socket.emit('close');
      }
      return this;
    },
  });
}

function hmrRequest(url = '/') {
  return { url, method: 'GET', headers: {
    upgrade: 'websocket', 'sec-websocket-protocol': 'vite-hmr',
    'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
  } };
}

test('Node dispatch preserves listener order, this, once, removal, and late registrations', () => {
  const server = new EventEmitter();
  const seen: string[] = [];
  const listener = (name: string) => function(this: EventEmitter) {
    assert.equal(this, server);
    seen.push(name);
  };
  const initial = listener('initial');
  const initialOnce = listener('initial once');
  const late = listener('late');
  const lateOnce = listener('late once');
  const removed = listener('removed');
  server.on('request', initial);
  server.once('request', initialOnce);
  guardHttpDispatch(server, { hmrPath: '/' });
  guardHttpDispatch(server);
  server.addListener('request', late);
  server.once('request', lateOnce);
  server.prependOnceListener('request', listener('prepend once'));
  server.prependListener('request', listener('prepend'));
  server.once('request', removed);
  server.off('request', removed);
  assert.ok(server.listeners('request').includes(initialOnce));
  assert.ok(server.rawListeners('request').some((fn) => (fn as { listener?: unknown }).listener === lateOnce));
  assert.equal(EventEmitter.prototype.rawListeners.call(server, 'request').length, 1);
  server.emit('request', { url: '/' }, fakeResponse());
  assert.deepEqual(seen, ['prepend', 'prepend once', 'initial', 'initial once', 'late', 'late once']);
  seen.length = 0;
  server.emit('request', { url: '/' }, fakeResponse());
  assert.deepEqual(seen, ['prepend', 'initial', 'late']);
  server.removeAllListeners('request');
  server.on('request', initial);
  server.removeListener('request', initial);
  assert.equal(server.listenerCount('request'), 0);
  server.removeAllListeners();
  server.on('request', late);
  seen.length = 0;
  server.emit('request', { url: '/' }, fakeResponse());
  assert.deepEqual(seen, ['late']);
  assert.equal(EventEmitter.prototype.rawListeners.call(server, 'request').length, 1);

  const head = Buffer.from('upgrade head');
  const req = hmrRequest();
  const socket = fakeSocket();
  const upgrade = function(this: EventEmitter, ...args: unknown[]) {
    assert.equal(this, server);
    assert.deepEqual(args, [req, socket, head]);
    seen.push('upgrade');
  };
  server.on('upgrade', upgrade);
  server.emit('upgrade', req, socket, head);
  socket.destroy();
  server.off('upgrade', upgrade);
  assert.equal(server.listenerCount('upgrade'), 0);
  assert.equal(EventEmitter.prototype.rawListeners.call(server, 'upgrade').length, 1);
  assert.equal(seen.at(-1), 'upgrade');
});

test('Node dispatch refuses targets before listeners and contains synchronous failures', () => {
  for (const event of ['request', 'upgrade'] as const) {
    const server = new EventEmitter();
    let called = 0;
    server.on(event, () => { called++; throw new Error('synchronous parser failure'); });
    guardHttpDispatch(server, { hmrPath: '/' });
    server.on(event, () => { called++; });
    const rejected = event === 'request' ? fakeResponse() : fakeSocket();
    server.emit(event, { url: 'http://[fe80::1%25lo0]/' }, rejected, Buffer.alloc(0));
    assert.equal(called, 0);
    if ('statusCode' in rejected) assert.equal(rejected.statusCode, 403);
    else assert.match(rejected.response, /^HTTP\/1\.1 403/);
    const caught = event === 'request' ? fakeResponse() : fakeSocket();
    server.emit(event, hmrRequest(), caught, Buffer.alloc(0));
    assert.equal(called, 1, 'dispatch stops on the throwing listener');
    if ('statusCode' in caught) assert.equal(caught.statusCode, 400);
    else assert.match(caught.response, /^HTTP\/1\.1 400/);
  }
});

test('Node dispatch does not write another response after headers or an upgrade', () => {
  const server = new EventEmitter();
  server.on('request', (_req, res: ReturnType<typeof fakeResponse>) => {
    res.writeHead(200);
    throw new Error('after headers');
  });
  server.on('upgrade', (_req, socket: ReturnType<typeof fakeSocket>) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n');
    throw new Error('after upgrade');
  });
  guardHttpDispatch(server, { hmrPath: '/' });
  const res = fakeResponse();
  server.emit('request', { url: '/' }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.destroyed, true);
  const socket = fakeSocket();
  server.emit('upgrade', hmrRequest(), socket, Buffer.alloc(0));
  assert.equal(socket.destroyed, true);
  assert.equal(socket.response, 'HTTP/1.1 101 Switching Protocols\r\n\r\n');
});

test('upgrade dispatch allows only the configured HMR path and protocol', () => {
  const server = new EventEmitter();
  let called = 0;
  server.on('upgrade', (_req, socket: ReturnType<typeof fakeSocket>) => {
    called++;
    socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n');
  });
  guardHttpDispatch(server, { hmrPath: '/custom/hmr' });
  for (const req of [
    ...['/', '/%', '/%zz', '/__open-in-editor', '/@vite/client', '/custom/hmr/', '/custom/%68mr',
      '/a/../custom/hmr', '/%2f', '/custom/hmr#fragment'].map((url) => hmrRequest(url)),
    { ...hmrRequest('/custom/hmr'), method: 'POST' },
    { ...hmrRequest('/custom/hmr'), headers: { upgrade: 'websocket', 'sec-websocket-protocol': 'vite-ping, other' } },
    { ...hmrRequest('/custom/hmr'), headers: { upgrade: 'websocket', 'sec-websocket-protocol': 'vite-hmr, vite-ping' } },
    { ...hmrRequest('/custom/hmr'), headers: { upgrade: 'websocket', 'sec-websocket-protocol': 'vite-hmr, other' } },
    { ...hmrRequest('/custom/hmr'), headers: { upgrade: 'h2c', 'sec-websocket-protocol': 'vite-hmr' } },
  ]) {
    const socket = fakeSocket();
    server.emit('upgrade', req, socket, Buffer.alloc(0));
    assert.match(socket.response, /^HTTP\/1\.1 403/);
    assert.equal(socket.destroyed, true);
  }
  assert.equal(called, 0);
  for (const protocol of ['vite-hmr', 'vite-ping']) {
    const socket = fakeSocket();
    const req = hmrRequest('/custom/hmr?token=test');
    req.headers['sec-websocket-protocol'] = protocol;
    server.emit('upgrade', req, socket, Buffer.alloc(0));
    assert.match(socket.response, /^HTTP\/1\.1 101/);
    socket.emit('end');
    assert.equal(socket.destroyed, true);
  }
  assert.equal(called, 1, 'ping must not enter Vite or any registered upgrade listener');
});

test('owned vite-ping validates the handshake and ignores all head and frame bytes', () => {
  const server = new EventEmitter();
  let forwarded = 0;
  server.on('upgrade', () => { forwarded++; });
  guardHttpDispatch(server, { hmrPath: '/' });
  const req = hmrRequest();
  req.headers['sec-websocket-protocol'] = 'vite-ping';
  const socket = fakeSocket();
  server.emit('upgrade', req, socket, Buffer.from('GET / HTTP/1.1\r\n\r\n'));
  assert.equal(forwarded, 0);
  assert.match(socket.response, /^HTTP\/1\.1 101 Switching Protocols/);
  assert.match(socket.response, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
  assert.match(socket.response, /Sec-WebSocket-Protocol: vite-ping/);
  assert.deepEqual(Buffer.from(socket.response.split('\r\n\r\n')[1], 'latin1'), Buffer.from([0x88, 2, 3, 232]));
  assert.equal(socket.destroyed, true);
  assert.doesNotThrow(() => socket.emit('error', new Error('late socket reset')));
  socket.emit('data', Buffer.from([0xc1, 0]));
  assert.equal(forwarded, 0);
  for (const headers of [
    { 'sec-websocket-version': '12' }, { 'sec-websocket-version': '' },
    { 'sec-websocket-key': '' }, { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ=' },
    { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZR==' },
    { 'sec-websocket-key': Buffer.alloc(15).toString('base64') },
    { 'sec-websocket-key': Buffer.alloc(17).toString('base64') },
    { 'sec-websocket-key': 'dGhlIHNhbXBs ZSBub25jZQ==' },
  ]) {
    const denied = fakeSocket();
    server.emit('upgrade', { ...req, headers: { ...req.headers, ...headers } }, denied, Buffer.alloc(0));
    assert.match(denied.response, /^HTTP\/1\.1 400/);
    assert.equal(denied.destroyed, true);
  }
  assert.equal(forwarded, 0);
});

test('clientError keeps the existing response and closes a peer that withholds FIN', async () => {
  const server = new EventEmitter();
  server.on('clientError', (_error, socket: ReturnType<typeof fakeSocket>) => {
    if (!socket.writableEnded) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  guardHttpDispatch(server, { clientErrorTimeoutMs: 30 });
  const socket = fakeSocket();
  server.emit('clientError', new Error('header timeout'), socket);
  assert.equal(socket.response, 'HTTP/1.1 400 Bad Request\r\n\r\n');
  assert.equal(socket.destroyed, false);
  await delay(15);
  server.emit('clientError', new Error('another byte'), socket);
  await delay(25);
  assert.equal(socket.destroyed, true, 'repeated errors must not extend the close deadline');
  assert.equal(socket.response, 'HTTP/1.1 400 Bad Request\r\n\r\n');
});

test('unclaimed HMR handshakes time out and disconnected sockets are destroyed', async () => {
  const server = new EventEmitter();
  server.on('upgrade', () => {});
  guardHttpDispatch(server, { hmrPath: '/', handshakeTimeoutMs: 30 });
  const timeout = fakeSocket();
  server.emit('upgrade', hmrRequest(), timeout, Buffer.alloc(0));
  assert.equal(timeout.resumed, true);
  await delay(60);
  assert.equal(timeout.destroyed, true);
  assert.equal(timeout.response, '');
  for (const event of ['end', 'error']) {
    const socket = fakeSocket();
    server.emit('upgrade', hmrRequest(), socket, Buffer.alloc(0));
    socket.emit(event);
    assert.equal(socket.destroyed, true);
  }
});

test('asynchronously claimed HMR sockets keep working and release on disconnect', async () => {
  const server = new EventEmitter();
  server.on('upgrade', (_req, socket: ReturnType<typeof fakeSocket>) => {
    setTimeout(() => socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n'), 5);
  });
  guardHttpDispatch(server, { hmrPath: '/', handshakeTimeoutMs: 30 });
  const socket = fakeSocket();
  server.emit('upgrade', hmrRequest(), socket, Buffer.alloc(0));
  await delay(60);
  assert.equal(socket.destroyed, false);
  assert.match(socket.response, /^HTTP\/1\.1 101/);
  socket.emit('end');
  assert.equal(socket.destroyed, true);
});

const hmrHeaders = {
  Connection: 'Upgrade', Upgrade: 'websocket',
  'Sec-WebSocket-Key': 'MDEyMzQ1Njc4OWFiY2RlZg==',
  'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Protocol': 'vite-hmr',
};

async function openUpgradeClients(target: string, count: number, protocol = 'vite-hmr') {
  const sockets: ReturnType<typeof connect>[] = [];
  try {
    const peers = await Promise.all(Array.from({ length: count }, () => new Promise<number>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port: 5308 });
      sockets.push(socket);
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:5308\r\n`
          + Object.entries({ ...hmrHeaders, 'Sec-WebSocket-Protocol': protocol })
            .map(([name, value]) => `${name}: ${value}\r\n`).join('') + '\r\n');
        resolve(socket.localPort!);
      });
    })));
    return { sockets, peers };
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    throw error;
  }
}

async function disconnectClients(sockets: ReturnType<typeof connect>[]) {
  await Promise.all(sockets.map((socket) => new Promise<void>((resolve) => {
    if (socket.closed) return resolve();
    socket.once('close', () => resolve());
    socket.destroy();
  })));
}

function frameClient(protocol: string, head = Buffer.alloc(0)) {
  const socket = connect({ host: '127.0.0.1', port: 5308, allowHalfOpen: true });
  const chunks: Buffer[] = [];
  let receivedHeaders = false;
  const headers = new Promise<string>((resolve, reject) => {
    socket.setTimeout(5000, () => socket.destroy(new Error('frame client timed out')));
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const end = bytes.indexOf('\r\n\r\n');
      if (!receivedHeaders && end !== -1) {
        receivedHeaders = true;
        resolve(bytes.subarray(0, end).toString('latin1'));
      }
    });
    socket.on('error', (error) => { if (!receivedHeaders) reject(error); });
    socket.on('close', () => { if (!receivedHeaders) reject(new Error('closed before upgrade response')); });
    socket.once('connect', () => {
      const request = `GET / HTTP/1.1\r\nHost: 127.0.0.1:5308\r\n`
        + Object.entries({ ...hmrHeaders, 'Sec-WebSocket-Protocol': protocol })
          .map(([name, value]) => `${name}: ${value}\r\n`).join('') + '\r\n';
      socket.write(Buffer.concat([Buffer.from(request), head]));
    });
  });
  return { socket, headers, bytes: () => Buffer.concat(chunks) };
}

type ConnectionSnapshot = {
  type: string;
  count: number;
  tracked: number;
  peers: number[];
  ignoredUpgrades: number;
  wsConnections: number;
  wsErrors: string[];
  wsErrorListeners: number[];
  headersTimeout: number;
  requestTimeout: number;
  connectionsCheckingInterval: number;
};

test('Vite subprocess survives malformed targets and releases upgrade sockets across restart', async (t) => {
  const child = childProcess.fork(path.join(repoRoot, 'scripts/vite-liveness-child.mjs'), [], {
    cwd: repoRoot,
    execArgv: ['--import', path.join(repoRoot, 'scripts/e2e-offline-fetch.mjs')],
    env: { ...process.env, LAUNCH_EDITOR: 'none', VITE_API_BASE: '' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout!.on('data', (chunk) => { output += chunk; });
  child.stderr!.on('data', (chunk) => { output += chunk; });
  child.on('error', (error) => { output += String(error); });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const message = (type: string) => new Promise<ConnectionSnapshot>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      reject(new Error(`Vite child is not running: ${output.slice(-1000)}`));
      return;
    }
    const timer = setTimeout(() => done(new Error(`Vite child ${type} timeout: ${output.slice(-1000)}`)), 20_000);
    const onMessage = (value: unknown) => {
      if (typeof value === 'object' && value !== null && 'type' in value && value.type === type) {
        done(undefined, value as ConnectionSnapshot);
      }
    };
    const onExit = () => done(new Error(`Vite child exited ${child.exitCode}: ${output.slice(-1000)}`));
    const done = (error?: Error, value?: ConnectionSnapshot) => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve(value!);
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
  t.after(async () => {
    let force: ReturnType<typeof setTimeout> | undefined;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 3000);
      force.unref();
    }
    await exited;
    clearTimeout(force);
  });
  const command = (name: string, type = name) => {
    assert.ok(child.connected, `Vite IPC is closed: ${output.slice(-1000)}`);
    const reply = message(type);
    child.send(name);
    return reply;
  };
  const waitForConnections = async (count: number, timeout = 1500) => {
    const deadline = Date.now() + timeout;
    let snapshot = await command('connections');
    while ((snapshot.count !== count || snapshot.tracked !== count) && Date.now() < deadline) {
      await delay(50);
      snapshot = await command('connections');
    }
    assert.equal(snapshot.count, count, JSON.stringify(snapshot));
    assert.equal(snapshot.tracked, count, JSON.stringify(snapshot));
    return snapshot;
  };
  await message('ready');
  assert.equal((await rawRequest('/')).status, 200);
  const targets = [
    'http://[fe80::1%25lo0]/', 'http://[::1%zz]/', 'http://[v1.x]/',
    'http://127.0.0.1:99999999999999999999999999/', 'http://%zz/', 'http://a b/',
    'http://xn--/', 'http://xn--a/', 'http://[/', 'http://]/',
  ];
  for (const phase of ['initial', 'restarted']) {
    if (phase === 'restarted') {
      await command('restart', 'restarted');
    }
    for (const protocol of ['vite-hmr', 'vite-ping']) {
      await t.test(`${phase} valid ${protocol} upgrade still works`, async () => {
        const { status } = await rawRequest('/', {
          closeOnHeaders: true,
          headers: { ...hmrHeaders, 'Sec-WebSocket-Protocol': protocol },
        });
        assert.equal(status, 101);
        await waitForConnections(0);
      });
    }
    for (const upgrade of [false, true]) {
      for (const target of targets) {
        await t.test(`${phase} ${upgrade ? 'upgrade' : 'request'} ${target}`, async (st) => {
          const result = await rawRequest(target, upgrade ? { headers: hmrHeaders, timeoutMs: 1500 } : {});
          const alive = (await rawRequest('/')).status;
          st.diagnostic(JSON.stringify({ phase, upgrade, target, status: result.status, alive }));
          assert.ok(result.status === 400 || result.status === 403, `unexpected ${result.status}`);
          assert.equal(result.body, '');
          assert.equal(alive, 200);
          assert.equal(child.exitCode, null);
          await waitForConnections(0);
        });
      }
    }
    const refusedUpgrades = [
      ...['/%', '/%zz', '/__open-in-editor', '/@vite/client', '/%2f', '/a/../',
        '/./', '//', '/#fragment'].map((target) => ({ target, headers: hmrHeaders, method: 'GET' })),
      ...['/%', '/__open-in-editor', '/@vite/client'].map((target) => ({
        target, headers: { ...hmrHeaders, 'Sec-WebSocket-Protocol': 'vite-ping' }, method: 'GET',
      })),
      ...['', 'other', 'vite-ping, other', 'vite-hmr, other'].map((protocol) => ({
        target: '/', headers: { ...hmrHeaders, 'Sec-WebSocket-Protocol': protocol }, method: 'GET',
      })),
      { target: '/', headers: { ...hmrHeaders, Upgrade: 'h2c' }, method: 'GET' },
      { target: '/', headers: hmrHeaders, method: 'POST' },
    ];
    for (const { target, headers, method } of refusedUpgrades) {
      await t.test(`${phase} upgrade is refused: ${method} ${target} ${headers['Sec-WebSocket-Protocol']}`, async (st) => {
        const { status, body } = await rawRequest(target, { headers, method, timeoutMs: 1500 });
        assert.ok(status === 400 || status === 403, `unexpected ${status}`);
        assert.equal(body, '');
        const released = await waitForConnections(0);
        st.diagnostic(JSON.stringify({ upgradeRefusal: phase, target, status, connections: released.count, tracked: released.tracked }));
      });
    }
    await t.test(`${phase} disconnected unknown upgrades leave no server sockets`, async (st) => {
      const before = await waitForConnections(0);
      const clients = await openUpgradeClients('/%', 8);
      try {
        await delay(100);
        await disconnectClients(clients.sockets);
        const after = await waitForConnections(0);
        assert.equal(after.peers.filter((port) => clients.peers.includes(port)).length, 0);
        st.diagnostic(JSON.stringify({ socketRelease: phase, clients: 8, before: before.count, after: after.count, retained: 0 }));
      } finally {
        await disconnectClients(clients.sockets);
      }
    });
    for (const protocol of ['vite-hmr']) {
      await t.test(`${phase} unclaimed ${protocol} handshakes time out and release disconnected peers`, async (st) => {
        await command('unclaim-upgrades');
        try {
          const before = await waitForConnections(0);
          const started = Date.now();
          const result = await rawRequest('/', {
            headers: { ...hmrHeaders, 'Sec-WebSocket-Protocol': protocol }, timeoutMs: 4500,
          });
          const elapsed = Date.now() - started;
          assert.equal(result.status, 0, 'an unclaimed handshake must be closed');
          assert.ok(elapsed < 4500, `handshake took ${elapsed}ms`);
          const timedOut = await waitForConnections(0);
          assert.equal(timedOut.ignoredUpgrades, before.ignoredUpgrades + 1);
          const clients = await openUpgradeClients('/', 8, protocol);
          try {
            await waitForConnections(8);
            const disconnected = Date.now();
            await disconnectClients(clients.sockets);
            const released = await waitForConnections(0, 1000);
            assert.ok(Date.now() - disconnected < 1500, 'disconnect cleanup must precede the handshake timeout');
            assert.equal(released.peers.filter((port) => clients.peers.includes(port)).length, 0);
            st.diagnostic(JSON.stringify({ unclaimedHmr: phase, protocol, handshakeMs: elapsed, clients: 8, retained: 0, connections: released.count }));
          } finally {
            await disconnectClients(clients.sockets);
          }
        } finally {
          await command('restore-upgrades');
        }
        assert.equal((await rawRequest('/')).status, 200);
        await waitForConnections(0);
      });
    }
    await t.test(`${phase} owned ping does not need or invoke Vite's upgrade handlers`, async (st) => {
      await command('unclaim-upgrades');
      try {
        const before = await waitForConnections(0);
        const result = await rawRequest('/', {
          headers: { ...hmrHeaders, 'Sec-WebSocket-Protocol': 'vite-ping' },
          timeoutMs: 1500,
        });
        assert.equal(result.status, 101);
        const after = await waitForConnections(0);
        assert.equal(after.ignoredUpgrades, before.ignoredUpgrades);
        assert.equal(after.wsConnections, before.wsConnections);
        st.diagnostic(JSON.stringify({ ownedPing: phase, status: result.status, forwarded: 0, retained: 0 }));
      } finally {
        await command('restore-upgrades');
      }
    });
    for (const protocol of ['vite-ping', 'vite-hmr']) {
      for (const example of [
        { name: 'pipelined GET', head: Buffer.from('GET / HTTP/1.1\r\nHost: 127.0.0.1:5308\r\nConnection: close\r\n\r\n'),
          frame: undefined, code: 'WS_ERR_UNEXPECTED_RSV_1' },
        { name: 'pipelined RSV1 frame', head: Buffer.from([0xc1, 0x80, 0, 0, 0, 0]),
          frame: undefined, code: 'WS_ERR_UNEXPECTED_RSV_1' },
        { name: 'post-upgrade RSV1 frame', head: Buffer.alloc(0),
          frame: Buffer.from([0xc1, 0x80, 0, 0, 0, 0]), code: 'WS_ERR_UNEXPECTED_RSV_1' },
        { name: 'post-upgrade unmasked frame', head: Buffer.alloc(0),
          frame: Buffer.from([0x81, 0]), code: 'WS_ERR_EXPECTED_MASK' },
      ]) {
        await t.test(`${phase} ${protocol} survives ${example.name}`, async (st) => {
          const before = await waitForConnections(0);
          const client = frameClient(protocol, example.head);
          try {
            const headers = await client.headers;
            assert.match(headers, /^HTTP\/1\.1 101 /);
            if (example.frame) client.socket.write(example.frame, () => {});
            if (protocol === 'vite-hmr') {
              const deadline = Date.now() + 1500;
              let state = await command('connections');
              while (!state.wsErrors.slice(before.wsErrors.length).includes(example.code) && Date.now() < deadline) {
                await delay(25);
                state = await command('connections');
              }
              assert.equal(state.wsConnections, before.wsConnections + 1);
              assert.ok(state.wsErrorListeners.every((count) => count > 0), 'Vite must install its own error listener');
              assert.ok(state.wsErrors.slice(before.wsErrors.length).includes(example.code), JSON.stringify(state.wsErrors));
            } else {
              await waitForConnections(0);
              const bytes = client.bytes();
              assert.deepEqual(bytes.subarray(bytes.indexOf('\r\n\r\n') + 4), Buffer.from([0x88, 2, 3, 232]));
              const state = await command('connections');
              assert.equal(state.wsConnections, before.wsConnections, 'ping must never enter Vite/ws');
            }
            assert.equal((await rawRequest('/')).status, 200);
            assert.equal(child.exitCode, null);
            st.diagnostic(JSON.stringify({ frameProbe: phase, protocol, example: example.name, alive: 200 }));
          } finally {
            await disconnectClients([client.socket]);
            await waitForConnections(0);
          }
        });
      }
    }
  }
  await t.test('Chromium reconnects and reloads the open app automatically after restart', async (st) => {
    const { chromium } = await import('@playwright/test');
    const { expectNoForeignTraffic, guardedBrowserArgs, watchOrigin } = await import('./tests/originGuard.js');
    const browser = await chromium.launch({ headless: true, args: guardedBrowserArgs('http://127.0.0.1:5308') });
    try {
      const context = await browser.newContext();
      // Like every page the tests open, this one may contact only the app's origin (tests/originGuard.ts).
      const guard = await watchOrigin(context, 'http://127.0.0.1:5308');
      // Exercise the real app/client without querying any real API or external service.
      await context.route('**/*', async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const local = url.hostname === '127.0.0.1' && url.port === '5308' && ['http:', 'ws:'].includes(url.protocol);
        if (!local || ['fetch', 'xhr'].includes(req.resourceType())) {
          await route.abort();
        } else {
          await route.continue();
        }
      });
      const page = await context.newPage();
      await guard.watch(page);
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      const protocols = new Map<string, string>();
      const handshakes: { protocol: string; status: number }[] = [];
      const socketErrors: string[] = [];
      cdp.on('Network.webSocketFrameError', (event) => socketErrors.push(event.errorMessage));
      cdp.on('Network.webSocketWillSendHandshakeRequest', (event) => {
        const protocol = Object.entries(event.request.headers)
          .find(([name]) => name.toLowerCase() === 'sec-websocket-protocol')?.[1];
        protocols.set(event.requestId, String(protocol ?? ''));
      });
      cdp.on('Network.webSocketHandshakeResponseReceived', (event) => {
        handshakes.push({ protocol: protocols.get(event.requestId) ?? '', status: event.response.status });
      });
      await page.goto('http://127.0.0.1:5308/', { waitUntil: 'networkidle' });
      await page.bringToFront();
      await page.waitForSelector('#root > *');
      assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
      const deadline = Date.now() + 5000;
      while (!handshakes.some((entry) => entry.protocol === 'vite-hmr' && entry.status === 101)
        && Date.now() < deadline) await delay(50);
      assert.ok(handshakes.some((entry) => entry.protocol === 'vite-hmr' && entry.status === 101));
      const initialDocument = await page.evaluate(() => performance.timeOrigin);
      let navigations = 0;
      page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations++; });
      await command('restart', 'restarted');
      let reloaded = false;
      try {
        await page.waitForFunction((previous) => performance.timeOrigin !== previous, initialDocument, { timeout: 12000 });
        reloaded = true;
      } catch {
        // Report the actual handshake outcomes before failing the regression.
      }
      if (!reloaded) st.diagnostic(JSON.stringify({ browserRestart: true, reloaded, navigations, attempts: [...protocols.values()], handshakes, socketErrors }));
      assert.equal(reloaded, true, 'the existing tab must reload itself, without page.reload()');
      assert.ok(navigations > 0);
      assert.ok(handshakes.some((entry) => entry.protocol === 'vite-ping' && entry.status === 101));
      const reconnectDeadline = Date.now() + 5000;
      while (handshakes.filter((entry) => entry.protocol === 'vite-hmr' && entry.status === 101).length < 2
        && Date.now() < reconnectDeadline) await delay(50);
      assert.ok(handshakes.filter((entry) => entry.protocol === 'vite-hmr' && entry.status === 101).length >= 2);
      await page.waitForSelector('#root > *');
      await expectNoForeignTraffic(guard);
      st.diagnostic(JSON.stringify({ browserRestart: true, reloaded, navigations, attempts: [...protocols.values()], handshakes, socketErrors }));
    } finally {
      await browser.close();
      await waitForConnections(0);
    }
  });
  await t.test('dripped headers release the server descriptor even when the peer withholds FIN', { timeout: 30000 }, async (st) => {
    const before = await waitForConnections(0);
    assert.equal(before.headersTimeout, 20000);
    assert.equal(before.connectionsCheckingInterval, 1000);
    assert.equal(before.requestTimeout, 300000);
    const socket = connect({ host: '127.0.0.1', port: 5308, allowHalfOpen: true });
    let response = '';
    let responseAt = 0;
    let drip: ReturnType<typeof setInterval> | undefined;
    const started = Date.now();
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.once('connect', () => {
          socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1:5308\r\nX-Drip: ');
          drip = setInterval(() => socket.write('a'), 200);
          resolve();
        });
      });
      const peer = socket.localPort!;
      socket.on('data', (chunk) => {
        response += chunk.toString('latin1');
        if (!responseAt) responseAt = Date.now();
        clearInterval(drip);
      });
      socket.on('error', () => {});
      await waitForConnections(1);
      const deadline = started + 25000;
      while (!responseAt && Date.now() < deadline) await delay(100);
      assert.match(response, /^HTTP\/1\.1 400 /, 'retain Vite clientError response behavior');
      assert.equal(socket.writableEnded, false, 'the client must never send FIN');
      const released = await waitForConnections(0, 2000);
      assert.equal(released.peers.includes(peer), false);
      assert.ok(Date.now() - responseAt < 2000, 'descriptor must close within the clientError grace period');
      st.diagnostic(JSON.stringify({
        drippedHeader: true, responseMs: responseAt - started,
        releasedMs: Date.now() - started, retained: 0, clientSentFin: socket.writableEnded,
      }));
      assert.equal((await rawRequest('/')).status, 200);
    } finally {
      clearInterval(drip);
      await disconnectClients([socket]);
      await waitForConnections(0);
    }
  });
});
