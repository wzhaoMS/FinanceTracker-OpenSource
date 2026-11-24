import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { SERVER, SERVICE_TOKEN, TOKEN, closedPort, modernMeta, startFakeHoldr, tempDir, writeToken } from './helpers.mjs';

/** The environment the server starts with: this one without any Holdr setting, as an MCP client would pass it. */
function cleanEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^HOLDR_|^NODE_OPTIONS$|^NODE_TEST/i.test(name)));
  return { ...env, ...extra };
}

/** Starts server.mjs with `args`; `request(message)` writes a line and resolves with the answer of the same id. */
function startServer(t, args, env = cleanEnv()) {
  const child = spawn(process.execPath, [SERVER, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => child.kill());
  const lines = [];
  const waiting = new Map();
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
    let index = stdout.indexOf('\n');
    while (index !== -1) {
      const line = stdout.slice(0, index);
      stdout = stdout.slice(index + 1);
      lines.push(line);
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
      index = stdout.indexOf('\n');
    }
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return {
    child,
    lines,
    exited,
    stderr: () => stderr,
    notify: (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`),
    request: (message) => new Promise((resolve) => {
      waiting.set(message.id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    }),
  };
}

/** Runs server.mjs to completion; resolves `{ code, stdout, stderr }`. */
function run(args, env = cleanEnv()) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('node agents/mcp/server.mjs speaks MCP on stdio: handshake, tools/list, a tool call; it exits when its input closes', async (t) => {
  const holdr = await startFakeHoldr(t);
  const dir = tempDir(t);
  writeToken(dir);
  const server = startServer(t, ['--app-url', holdr.url, '--data-dir', dir]);
  const init = await server.request({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'holdr');
  assert.match(init.result.instructions, /read-only agent token, so neither it nor you can change anything/);
  server.notify({ method: 'notifications/initialized' });
  const list = await server.request({ id: 2, method: 'tools/list' });
  assert.equal(list.result.tools.length, 9);
  const call = await server.request({ id: 3, method: 'tools/call', params: { name: 'get_spending_summary', arguments: { period: 'last-month' } } });
  assert.equal(call.result.isError, false);
  assert.match(call.result.content[0].text, /^Card spending, last month/);
  assert.equal(call.result.structuredContent.totals[0].spending, 1234.56);
  const bad = await server.request({ id: 4, method: 'tools/call', params: { name: 'list_card_transactions', arguments: { limit: 0 } } });
  assert.equal(bad.result.isError, true);
  server.child.stdin.end();
  assert.equal(await server.exited, 0);
  assert.equal(server.lines.length, 4, 'one line per answer, nothing else on stdout');
  assert.match(server.stderr(), /\[holdr-mcp\] holdr 0\.1\.0: MCP over stdio/);
  assert.match(server.stderr(), /agent token from --data-dir/);
  for (const secret of [TOKEN, dir]) assert.ok(!server.stderr().includes(secret) && !server.lines.join('\n').includes(secret));
});

test('a 2026-07-28 client: server/discover, then tool calls with per-request metadata and no handshake', async (t) => {
  const holdr = await startFakeHoldr(t);
  const dir = tempDir(t);
  writeToken(dir);
  const server = startServer(t, ['--app-url', holdr.url], cleanEnv({ HOLDR_DATA_DIR: dir }));
  const discover = await server.request({ id: 'd', method: 'server/discover', params: { _meta: modernMeta() } });
  assert.equal(discover.result.resultType, 'complete');
  assert.ok(discover.result.supportedVersions.includes('2026-07-28'));
  const health = await server.request({ id: 'h', method: 'tools/call', params: { _meta: modernMeta(), name: 'holdr_health', arguments: {} } });
  assert.equal(health.result.resultType, 'complete');
  assert.equal(health.result.structuredContent.status, 'ok');
  assert.equal(health.result._meta['io.modelcontextprotocol/serverInfo'].name, 'holdr');
  server.child.stdin.end();
  assert.equal(await server.exited, 0);
});

test('--check says where it looks, which token it found and whether Holdr answers; --help, --version and bad options exit as a command line should', async (t) => {
  const holdr = await startFakeHoldr(t);
  const dir = tempDir(t);
  const missing = await run(['--check', '--app-url', holdr.url, '--data-dir', dir]);
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /agent token {5}\S/);
  assert.match(missing.stdout, /PROBLEM {2}Holdr's agent token file \(agent-token\) was not found\. Holdr creates it in its data folder when it starts: stop Holdr/);
  assert.ok(missing.stdout.includes(dir), '--check prints the folder for the person running it');
  // The service token, named directly, is recognized for what it is and refused; nothing is sent to Holdr.
  const serviceFile = writeToken(tempDir(t), SERVICE_TOKEN, 'service-token');
  const service = await run(['--check', '--app-url', holdr.url, '--token-file', serviceFile]);
  assert.equal(service.code, 1);
  assert.match(service.stdout, /PROBLEM {2}this file holds Holdr's service token, which can change data/);
  assert.ok(!service.stdout.includes(SERVICE_TOKEN));
  assert.equal(holdr.requests.length, 0);
  writeToken(dir);
  const ready = await run(['--check', '--app-url', holdr.url, '--data-dir', dir]);
  assert.equal(ready.code, 0, ready.stdout);
  assert.match(ready.stdout, /ok {7}the file holds Holdr's read-only agent token/);
  // The real check, in the child: the fake Holdr listens in this test process, which runs as the same account.
  assert.match(ready.stdout, /ok {7}the program listening on 127\.0\.0\.1:\d+ runs as you/);
  assert.match(ready.stdout, /ok {7}Holdr is running at/);
  assert.match(ready.stdout, /Ready\./);
  assert.ok(!ready.stdout.includes(TOKEN));
  const down = await run(['--check', '--app-url', `http://127.0.0.1:${await closedPort()}`, '--data-dir', dir]);
  assert.equal(down.code, 1);
  assert.match(down.stdout, /Holdr is not running at/);
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: node agents\/mcp\/server\.mjs \[options\]/);
  assert.equal((await run(['--version'])).stdout.trim(), '0.1.0');
  const remote = await run(['--app-url', 'http://192.0.2.5:4000']);
  assert.equal(remote.code, 2);
  assert.match(remote.stderr, /--app-url must be http:\/\/127\.0\.0\.1/);
  assert.equal(remote.stdout, '');
  const named = await run(['--app-url', 'http://localhost:4000']);
  assert.equal(named.code, 2);
  assert.match(named.stderr, /--app-url must be http:\/\/127\.0\.0\.1:<port>/);
});
