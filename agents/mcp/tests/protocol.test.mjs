import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { ToolInputError } from '../lib/format.mjs';
import { HoldrApiError } from '../lib/holdr-api.mjs';
import {
  ERRORS, LEGACY_VERSIONS, MODERN_VERSIONS, SUPPORTED_VERSIONS, createMcpServer, serveStdio,
} from '../lib/protocol.mjs';
import { initialize, modernMeta } from './helpers.mjs';

const SERVER_INFO = { name: 'holdr', title: 'Holdr (read-only)', version: '9.9.9', description: 'test server' };
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

function makeTools(log = []) {
  return [
    {
      name: 'echo', title: 'Echo', description: 'Echoes its text.',
      inputSchema: schema({ text: { type: 'string', maxLength: 10 }, n: { type: 'integer', minimum: 1, maximum: 5 } }, ['text']),
      handler: async (args) => ({ summary: `echo ${args.text}`, data: { text: args.text } }),
    },
    {
      name: 'slow', title: 'Slow', description: 'Waits until cancelled.', inputSchema: schema(),
      handler: (_args, { signal }) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ summary: 'done', data: {} }), 5_000);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          log.push('aborted');
          reject(new HoldrApiError('cancelled', 'the request was cancelled'));
        });
      }),
    },
    {
      name: 'down', title: 'Down', description: 'Holdr is not running.', inputSchema: schema(),
      handler: async () => { throw new HoldrApiError('api-unreachable', 'Holdr is not running at http://127.0.0.1:4000'); },
    },
    {
      name: 'picky', title: 'Picky', description: 'Refuses its input.', inputSchema: schema(),
      handler: async () => { throw new ToolInputError('give one of period, month, or from/to, not several'); },
    },
    {
      name: 'broken', title: 'Broken', description: 'Has a bug.', inputSchema: schema(),
      handler: async () => { throw new TypeError('secret detail at C:\\somewhere'); },
    },
  ];
}

const server = (options = {}) => createMcpServer({ serverInfo: SERVER_INFO, instructions: 'Read-only test server.', tools: makeTools(options.events), ...options });
const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

test('initialize answers the version the client asks for when supported, else the latest handshake version', async () => {
  for (const version of LEGACY_VERSIONS) {
    const response = await initialize(server(), version);
    assert.equal(response.result.protocolVersion, version);
    assert.deepEqual(response.result.capabilities, { tools: { listChanged: false } });
    assert.equal(response.result.serverInfo.name, 'holdr');
    assert.equal(response.result.serverInfo.version, '9.9.9');
    assert.equal(response.result.instructions, 'Read-only test server.');
    assert.equal('title' in response.result.serverInfo, version >= '2025-06-18');
    assert.equal('resultType' in response.result, false, 'handshake-era results carry no resultType');
  }
  for (const asked of ['2026-07-28', '2099-01-01', '2024-01-01']) {
    const response = await initialize(server(), asked);
    assert.equal(response.result.protocolVersion, '2025-11-25');
  }
  const bad = await server().handleMessage(request(1, 'initialize', { capabilities: {} }));
  assert.equal(bad.error.code, ERRORS.INVALID_PARAMS);
  assert.match(bad.error.message, /protocolVersion/);
});

test('before a handshake, a request needs the 2026-07-28 _meta; ping always answers', async () => {
  const s = server();
  const early = await s.handleMessage(request(1, 'tools/list'));
  assert.equal(early.error.code, ERRORS.INVALID_PARAMS);
  assert.match(early.error.message, /initialize/);
  assert.match(early.error.message, /protocolVersion/);
  assert.deepEqual((await s.handleMessage(request(2, 'ping'))).result, {});
  await initialize(s, '2025-06-18');
  assert.deepEqual((await s.handleMessage(request(3, 'ping'))).result, {});
  assert.equal((await s.handleMessage(request(4, 'tools/list'))).result.tools.length, 5);
});

test('2026-07-28 requests are served without a handshake: resultType, serverInfo, cache hints and server/discover', async () => {
  const s = server();
  const discover = await s.handleMessage(request('d', 'server/discover', { _meta: modernMeta() }));
  assert.equal(discover.result.resultType, 'complete');
  assert.deepEqual(discover.result.supportedVersions, [...SUPPORTED_VERSIONS]);
  assert.ok(discover.result.supportedVersions.includes(MODERN_VERSIONS[0]));
  assert.deepEqual(discover.result.capabilities, { tools: { listChanged: false } });
  assert.equal(discover.result.instructions, 'Read-only test server.');
  assert.equal(discover.result.cacheScope, 'public');
  assert.ok(discover.result.ttlMs > 0);
  assert.deepEqual(discover.result._meta['io.modelcontextprotocol/serverInfo'], SERVER_INFO);

  const list = await s.handleMessage(request('l', 'tools/list', { _meta: modernMeta() }));
  assert.equal(list.result.resultType, 'complete');
  assert.equal(list.result.cacheScope, 'public');
  assert.ok(Number.isInteger(list.result.ttlMs) && list.result.ttlMs >= 0);
  assert.equal(list.result.tools[0].title, 'Echo');

  const call = await s.handleMessage(request('c', 'tools/call', { _meta: modernMeta(), name: 'echo', arguments: { text: 'hi' } }));
  assert.equal(call.result.resultType, 'complete');
  assert.equal(call.result.isError, false);
  assert.deepEqual(call.result.structuredContent, { text: 'hi' });
  assert.equal(call.result._meta['io.modelcontextprotocol/serverInfo'].name, 'holdr');

  // The handshake's discovery method does not exist for a handshake client.
  const legacy = server();
  await initialize(legacy);
  assert.equal((await legacy.handleMessage(request(9, 'server/discover'))).error.code, ERRORS.METHOD_NOT_FOUND);
});

test('2026-07-28 requests must carry their capabilities; an unknown version gets UnsupportedProtocolVersionError', async () => {
  const s = server();
  const missing = await s.handleMessage(request(1, 'tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } }));
  assert.equal(missing.error.code, ERRORS.INVALID_PARAMS);
  assert.match(missing.error.message, /clientCapabilities/);
  const unknown = await s.handleMessage(request(2, 'tools/list', { _meta: modernMeta('1900-01-01') }));
  assert.equal(unknown.error.code, -32022);
  assert.deepEqual(unknown.error.data, { supported: [...SUPPORTED_VERSIONS], requested: '1900-01-01' });
  const wrongType = await s.handleMessage(request(3, 'tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': 20260728 } }));
  assert.equal(wrongType.error.code, ERRORS.INVALID_PARAMS);
});

test('tool definitions follow the negotiated version, and every tool is marked read-only', async () => {
  const shapes = {};
  for (const version of ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']) {
    const s = server();
    await initialize(s, version);
    shapes[version] = (await s.handleMessage(request(1, 'tools/list'))).result.tools[0];
  }
  assert.deepEqual(Object.keys(shapes['2024-11-05']), ['name', 'description', 'inputSchema']);
  assert.deepEqual(Object.keys(shapes['2025-03-26']), ['name', 'description', 'inputSchema', 'annotations']);
  assert.deepEqual(Object.keys(shapes['2025-06-18']), ['name', 'title', 'description', 'inputSchema', 'annotations']);
  assert.deepEqual(shapes['2025-11-25'].annotations, { title: 'Echo', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
});

test('structured content only from 2025-06-18; the text blocks are a summary and the JSON', async () => {
  for (const [version, structured] of [['2025-03-26', false], ['2025-06-18', true]]) {
    const s = server();
    await initialize(s, version);
    const { result } = await s.handleMessage(request(1, 'tools/call', { name: 'echo', arguments: { text: 'hello' } }));
    assert.deepEqual(result.content, [{ type: 'text', text: 'echo hello' }, { type: 'text', text: '{"text":"hello"}' }]);
    assert.equal(result.isError, false);
    assert.equal('structuredContent' in result, structured);
  }
});

test('JSON-RPC errors: parse error, invalid requests, batches, unknown methods and tools, bad params and cursors', async () => {
  const s = server();
  await initialize(s);
  const parse = await s.handleLine('{"jsonrpc": "2.0", "id": 1, "method": ');
  assert.deepEqual(parse, { jsonrpc: '2.0', id: null, error: { code: ERRORS.PARSE, message: parse.error.message } });
  assert.equal((await s.handleMessage([request(1, 'ping')])).error.code, ERRORS.INVALID_REQUEST);
  assert.equal((await s.handleMessage({ id: 1, method: 'ping' })).error.code, ERRORS.INVALID_REQUEST);
  assert.equal((await s.handleMessage({ jsonrpc: '2.0', id: 7, method: 42 })).error.code, ERRORS.INVALID_REQUEST);
  assert.deepEqual((await s.handleMessage({ jsonrpc: '2.0', id: null, method: 'ping' })).id, null);
  assert.equal((await s.handleMessage({ jsonrpc: '2.0', id: {}, method: 'ping' })).error.code, ERRORS.INVALID_REQUEST);
  assert.equal((await s.handleMessage({ jsonrpc: '2.0', id: 2 })).error.code, ERRORS.INVALID_REQUEST);
  assert.equal((await s.handleMessage(request(3, 'tools/list', [1, 2]))).error.code, ERRORS.INVALID_PARAMS);
  const unknownMethod = await s.handleMessage(request(4, 'resources/list'));
  assert.equal(unknownMethod.error.code, ERRORS.METHOD_NOT_FOUND);
  assert.equal(unknownMethod.id, 4);
  const unknownTool = await s.handleMessage(request(5, 'tools/call', { name: 'nope', arguments: {} }));
  assert.equal(unknownTool.error.code, ERRORS.INVALID_PARAMS);
  assert.equal(unknownTool.error.message, 'Unknown tool: nope');
  assert.equal((await s.handleMessage(request(6, 'tools/call', { arguments: {} }))).error.code, ERRORS.INVALID_PARAMS);
  assert.equal((await s.handleMessage(request(7, 'tools/call', { name: 'echo', arguments: 'text' }))).error.code, ERRORS.INVALID_PARAMS);
  assert.equal((await s.handleMessage(request(8, 'tools/list', { cursor: 'abc' }))).error.code, ERRORS.INVALID_PARAMS);
  const echoed = await s.handleMessage(request('string-id', 'ping'));
  assert.equal(echoed.id, 'string-id');
});

test('notifications get no answer, unknown ones included; responses from the client are ignored', async () => {
  const s = server();
  await initialize(s);
  assert.equal(await s.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await s.handleMessage({ jsonrpc: '2.0', method: 'notifications/whatever', params: { x: 1 } }), null);
  assert.equal(await s.handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'none' } }), null);
  assert.equal(await s.handleMessage({ jsonrpc: '2.0', id: 5, result: {} }), null);
  assert.equal(await s.handleMessage({ jsonrpc: '2.0', id: 6, error: { code: 1, message: 'x' } }), null);
});

test('tool failures come back as results with isError, with a message the model can act on and no internals', async () => {
  const logged = [];
  const s = server({ log: (line) => logged.push(line) });
  await initialize(s);
  const invalid = (await s.handleMessage(request(1, 'tools/call', { name: 'echo', arguments: { text: 'far too long text', n: 9, extra: true } }))).result;
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /text must be at most 10 characters/);
  assert.match(invalid.content[0].text, /n must be from 1 to 5/);
  assert.match(invalid.content[0].text, /unknown argument "extra" \(this tool takes text, n\)/);
  assert.match((await s.handleMessage(request(2, 'tools/call', { name: 'echo', arguments: {} }))).result.content[0].text, /text is required/);
  const down = (await s.handleMessage(request(3, 'tools/call', { name: 'down' }))).result;
  assert.deepEqual(down, { content: [{ type: 'text', text: 'Holdr is not running at http://127.0.0.1:4000' }], isError: true });
  assert.equal((await s.handleMessage(request(4, 'tools/call', { name: 'picky' }))).result.isError, true);
  const broken = (await s.handleMessage(request(5, 'tools/call', { name: 'broken' }))).result;
  assert.equal(broken.isError, true);
  assert.doesNotMatch(broken.content[0].text, /secret|somewhere/);
  assert.ok(logged.some((line) => line.includes('broken failed: TypeError')), 'the details go to the log');
});

test('notifications/cancelled stops a running call, and no answer is sent for it', async () => {
  const events = [];
  const s = server({ events });
  await initialize(s);
  const pending = s.handleMessage(request('long', 'tools/call', { name: 'slow' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await s.handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'long', reason: 'user' } }), null);
  assert.equal(await pending, null);
  assert.deepEqual(events, ['aborted']);
});

test('tool calls are rate limited per minute', async () => {
  let time = 0;
  const s = server({ limits: { perMinute: 2, concurrent: 1 }, now: () => time });
  await initialize(s);
  const call = (id) => s.handleMessage(request(id, 'tools/call', { name: 'echo', arguments: { text: 'x' } }));
  assert.equal((await call(1)).result.isError, false);
  assert.equal((await call(2)).result.isError, false);
  const limited = (await call(3)).result;
  assert.equal(limited.isError, true);
  assert.match(limited.content[0].text, /Too many Holdr tool calls/);
  time += 60_001;
  assert.equal((await call(4)).result.isError, false);
});

test('stdio: one message per line, CRLF and split chunks accepted, every answer written before the end', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.setEncoding('utf8');
  let partial = '';
  output.on('data', (chunk) => {
    partial += chunk;
    const parts = partial.split('\n');
    partial = parts.pop();
    lines.push(...parts);
  });
  const done = serveStdio(server(), { input, output });
  const init = JSON.stringify(request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'pipe', version: '1' } }));
  input.write(`${init.slice(0, 20)}`);
  input.write(`${init.slice(20)}\r\n`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n\n`);
  input.write(`${JSON.stringify(request(2, 'tools/list'))}\n`);
  input.write('not json\n');
  input.end(JSON.stringify(request(3, 'tools/call', { name: 'echo', arguments: { text: 'last' } })));
  await done;
  const answers = lines.map((line) => JSON.parse(line));
  assert.equal(answers.length, 4, 'initialize, tools/list, the parse error and the call; nothing for the notification');
  assert.ok(lines.every((line) => !line.includes('\r')));
  assert.equal(answers.find((answer) => answer.id === 1).result.protocolVersion, '2025-11-25');
  assert.equal(answers.find((answer) => answer.id === 2).result.tools.length, 5);
  assert.equal(answers.find((answer) => answer.id === null).error.code, ERRORS.PARSE);
  assert.equal(answers.find((answer) => answer.id === 3).result.content[0].text, 'echo last');
});

test('stdio: a line longer than the limit is refused once and skipped', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => { text += chunk; });
  const done = serveStdio(server(), { input, output });
  input.write('x'.repeat(1024 * 1024 + 10));
  input.write(`${'y'.repeat(100)}\n`);
  input.end(`${JSON.stringify(request(1, 'ping'))}\n`);
  await done;
  const answers = text.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(answers.length, 2);
  assert.equal(answers[0].error.code, ERRORS.INVALID_REQUEST);
  assert.deepEqual(answers[1], { jsonrpc: '2.0', id: 1, result: {} });
});
