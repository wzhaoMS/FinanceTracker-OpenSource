// The Model Context Protocol over stdio: JSON-RPC 2.0, one message per line. The server is "dual-era" in the
// specification's terms. A client that opens with `initialize` gets the handshake-based protocol of 2025-11-25 and
// earlier, at the version it asks for when this server has it (else 2025-11-25). A request that carries
// `io.modelcontextprotocol/protocolVersion` in its `_meta` is served on its own, without a handshake (2026-07-28, which
// also has `server/discover`). The server offers tools only, and every tool only reads.
import { ToolInputError } from './format.mjs';
import { HoldrApiError } from './holdr-api.mjs';
import { validateArguments } from './schema.mjs';

export const MODERN_VERSIONS = Object.freeze(['2026-07-28']);
export const LEGACY_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
export const SUPPORTED_VERSIONS = Object.freeze([...MODERN_VERSIONS, ...LEGACY_VERSIONS]);

export const ERRORS = Object.freeze({
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  UNSUPPORTED_VERSION: -32022,
});

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
/** How long a client may cache the tool list and the discovery answer: the list changes only with this checkout. */
const LIST_TTL_MS = 300_000;
/** The longest line read as one message. */
export const MAX_MESSAGE_CHARS = 1024 * 1024;
/** No tool answer is longer than this; the tools keep theirs far below it (format.mjs, MAX_OUTPUT_CHARS). */
const HARD_OUTPUT_CHARS = 400_000;
const CANCELLED = Symbol('cancelled');

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value) => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
const printable = (value) => (/^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : '(unrecognized)');

/** What a protocol version has: result fields, tool fields and features that came in later versions. */
export function featuresOf(version) {
  return {
    version,
    modern: MODERN_VERSIONS.includes(version),
    annotations: version >= '2025-03-26',
    titles: version >= '2025-06-18',
    structured: version >= '2025-06-18',
    descriptions: version >= '2025-11-25',
  };
}

function errorResponse(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/** Admits at most `perMinute` tool calls in any minute and runs at most `concurrent` at once (the rest wait their turn). */
function createLimiter({ perMinute, concurrent, now }) {
  const admitted = [];
  const waiting = [];
  let running = 0;
  return {
    /** 0 when the call may go ahead, else the seconds until it may. */
    admit() {
      const time = now();
      while (admitted.length > 0 && time - admitted[0] >= 60_000) admitted.shift();
      if (admitted.length >= perMinute) return Math.max(1, Math.ceil((60_000 - (time - admitted[0])) / 1000));
      admitted.push(time);
      return 0;
    },
    async run(task) {
      if (running >= concurrent) await new Promise((resolve) => waiting.push(resolve));
      running += 1;
      try {
        return await task();
      } finally {
        running -= 1;
        waiting.shift()?.();
      }
    },
  };
}

/**
 * The protocol engine, independent of the transport. `tools` are `{ name, title, description, inputSchema, openWorld,
 * handler(args, { signal }) }`, where a handler answers `{ summary, data, text? }` (`text`: data's JSON, already fitted to
 * the size budget) or throws a HoldrApiError or ToolInputError, whose message the model sees.
 */
export function createMcpServer({
  serverInfo, instructions = '', tools, limits = {}, log = () => {}, now = Date.now,
}) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const limiter = createLimiter({ perMinute: limits.perMinute ?? 120, concurrent: limits.concurrent ?? 4, now });
  const inflight = new Map();
  /** The handshake-based session of a client that sent initialize: `{ version }`. */
  let session = null;
  const keyOf = (id) => `${typeof id}:${id}`;

  const serverInfoFor = (features) => ({
    name: serverInfo.name,
    ...(features.titles && serverInfo.title ? { title: serverInfo.title } : {}),
    version: serverInfo.version,
    ...(features.descriptions && serverInfo.description ? { description: serverInfo.description } : {}),
  });

  /** A result as the request's protocol version shapes it: modern results say their type and who answered. */
  const finish = (result, features) => (features.modern
    ? { resultType: 'complete', ...result, _meta: { [META_SERVER_INFO]: serverInfoFor(features) } }
    : result);

  /** The request's protocol version: its own `_meta` version, else the handshake's; otherwise the request is refused. */
  function featuresFor(params, method) {
    const meta = isObject(params._meta) ? params._meta : null;
    const requested = meta?.[META_VERSION];
    if (requested !== undefined) {
      if (typeof requested !== 'string') throw new RpcError(ERRORS.INVALID_PARAMS, `Invalid params: _meta["${META_VERSION}"] must be a string`);
      if (!SUPPORTED_VERSIONS.includes(requested)) {
        throw new RpcError(ERRORS.UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: [...SUPPORTED_VERSIONS], requested });
      }
      if (MODERN_VERSIONS.includes(requested) && !isObject(meta[META_CAPABILITIES])) {
        throw new RpcError(ERRORS.INVALID_PARAMS, `Invalid params: _meta["${META_CAPABILITIES}"] is required with protocol version ${requested}`);
      }
      return featuresOf(requested);
    }
    if (session) return featuresOf(session.version);
    if (method === 'ping') return featuresOf(LEGACY_VERSIONS[0]);
    throw new RpcError(ERRORS.INVALID_PARAMS, `Invalid params: send initialize first (protocol ${LEGACY_VERSIONS[0]} and earlier), or give `
      + `_meta["${META_VERSION}"] and _meta["${META_CAPABILITIES}"] on every request (protocol ${MODERN_VERSIONS.join(', ')})`);
  }

  function initialize(params) {
    const requested = params.protocolVersion;
    if (typeof requested !== 'string' || requested === '') throw new RpcError(ERRORS.INVALID_PARAMS, 'Invalid params: initialize needs a protocolVersion');
    if (params.capabilities !== undefined && !isObject(params.capabilities)) {
      throw new RpcError(ERRORS.INVALID_PARAMS, 'Invalid params: capabilities must be an object');
    }
    const version = LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
    session = { version };
    const client = isObject(params.clientInfo) && typeof params.clientInfo.name === 'string' ? printable(params.clientInfo.name) : 'a client';
    log(`${client} connected; protocol ${version}${version === requested ? '' : ` (it asked for ${printable(requested)})`}`);
    return {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: serverInfoFor(featuresOf(version)),
      ...(instructions ? { instructions } : {}),
    };
  }

  function toolDefinition(tool, features) {
    return {
      name: tool.name,
      ...(features.titles ? { title: tool.title } : {}),
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(features.annotations ? {
        annotations: {
          title: tool.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: tool.openWorld === true,
        },
      } : {}),
    };
  }

  function listTools(params, features) {
    if (params.cursor !== undefined) throw new RpcError(ERRORS.INVALID_PARAMS, 'Invalid params: unknown cursor (this server lists every tool at once)');
    const result = { tools: tools.map((tool) => toolDefinition(tool, features)) };
    return features.modern ? { ...result, ttlMs: LIST_TTL_MS, cacheScope: 'public' } : result;
  }

  const toolError = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

  function toolResult(output, features) {
    const json = output.text ?? JSON.stringify(output.data);
    if (json.length > HARD_OUTPUT_CHARS) return toolError('The answer was too large to return; narrow the filters or lower the limit.');
    const result = { content: [{ type: 'text', text: output.summary }, { type: 'text', text: json }], isError: false };
    return features.structured ? { ...result, structuredContent: output.data } : result;
  }

  async function callTool(id, params, features) {
    if (typeof params.name !== 'string') throw new RpcError(ERRORS.INVALID_PARAMS, 'Invalid params: tools/call needs the tool name');
    const tool = byName.get(params.name);
    if (!tool) throw new RpcError(ERRORS.INVALID_PARAMS, `Unknown tool: ${printable(params.name)}`);
    const args = params.arguments === undefined ? {} : params.arguments;
    if (!isObject(args)) throw new RpcError(ERRORS.INVALID_PARAMS, 'Invalid params: arguments must be an object');
    const problems = validateArguments(tool.inputSchema, args);
    if (problems.length > 0) return toolError(`Invalid arguments for ${tool.name}: ${problems.join('; ')}.`);
    const wait = limiter.admit();
    if (wait > 0) return toolError(`Too many Holdr tool calls in the last minute; try again in ${wait} s.`);

    const controller = new AbortController();
    const key = keyOf(id);
    inflight.set(key, controller);
    try {
      const output = await limiter.run(() => (controller.signal.aborted ? null : tool.handler(args, { signal: controller.signal })));
      if (controller.signal.aborted) return CANCELLED;
      return toolResult(output, features);
    } catch (error) {
      if (controller.signal.aborted) return CANCELLED;
      if (error instanceof HoldrApiError || error instanceof ToolInputError) return toolError(error.message);
      log(`${tool.name} failed: ${error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : 'unknown error'}`);
      return toolError(`The Holdr MCP server could not answer ${tool.name} because of an internal error; its log (standard error) has the details.`);
    } finally {
      inflight.delete(key);
    }
  }

  async function dispatch(id, method, params) {
    if (method === 'initialize') return initialize(params);
    const features = featuresFor(params, method);
    switch (method) {
      case 'ping':
        return finish({}, features);
      case 'server/discover':
        if (!features.modern) throw new RpcError(ERRORS.METHOD_NOT_FOUND, 'Method not found: server/discover (it belongs to protocol 2026-07-28)');
        return finish({
          supportedVersions: [...SUPPORTED_VERSIONS],
          capabilities: { tools: { listChanged: false } },
          ...(instructions ? { instructions } : {}),
          ttlMs: LIST_TTL_MS,
          cacheScope: 'public',
        }, features);
      case 'tools/list':
        return finish(listTools(params, features), features);
      case 'tools/call': {
        const result = await callTool(id, params, features);
        return result === CANCELLED ? CANCELLED : finish(result, features);
      }
      default:
        throw new RpcError(ERRORS.METHOD_NOT_FOUND, `Method not found: ${printable(method)}`);
    }
  }

  function handleNotification(message) {
    if (message.method === 'notifications/cancelled') {
      const requestId = isObject(message.params) ? message.params.requestId : undefined;
      if (isId(requestId)) inflight.get(keyOf(requestId))?.abort();
    }
    // notifications/initialized needs nothing, and every other notification is ignored, as JSON-RPC allows.
  }

  /** One parsed message: its response, or null when none is due (a notification, a client response, a cancelled call). */
  async function handleMessage(message) {
    if (Array.isArray(message)) {
      return errorResponse(null, ERRORS.INVALID_REQUEST, 'Invalid Request: JSON-RPC batches are not supported; send one message per line');
    }
    if (!isObject(message) || message.jsonrpc !== '2.0') {
      return errorResponse(isObject(message) && isId(message.id) ? message.id : null, ERRORS.INVALID_REQUEST, 'Invalid Request: expected a JSON-RPC 2.0 message');
    }
    if (message.method === undefined) {
      // A response from the client: this server sends no requests, so there is nothing it could answer.
      if ('result' in message || 'error' in message) return null;
      return errorResponse(isId(message.id) ? message.id : null, ERRORS.INVALID_REQUEST, 'Invalid Request: method is missing');
    }
    if (typeof message.method !== 'string') {
      return errorResponse(isId(message.id) ? message.id : null, ERRORS.INVALID_REQUEST, 'Invalid Request: method must be a string');
    }
    if (!('id' in message)) {
      handleNotification(message);
      return null;
    }
    if (!isId(message.id)) return errorResponse(null, ERRORS.INVALID_REQUEST, 'Invalid Request: id must be a string or a number');
    const { id } = message;
    if (message.params !== undefined && !isObject(message.params)) {
      return errorResponse(id, ERRORS.INVALID_PARAMS, 'Invalid params: params must be an object');
    }
    try {
      const result = await dispatch(id, message.method, message.params ?? {});
      return result === CANCELLED ? null : { jsonrpc: '2.0', id, result };
    } catch (error) {
      if (error instanceof RpcError) return errorResponse(id, error.code, error.message, error.data);
      log(`${printable(message.method)} failed: ${error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : 'unknown error'}`);
      return errorResponse(id, ERRORS.INTERNAL, 'Internal error');
    }
  }

  /** One line of input: its response, or null. */
  async function handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return errorResponse(null, ERRORS.PARSE, 'Parse error: each line must be one JSON-RPC message');
    }
    return handleMessage(message);
  }

  return {
    handleLine,
    handleMessage,
    /** Cancels every tool call in flight (their responses are not sent). */
    cancelAll() {
      for (const controller of inflight.values()) controller.abort();
    },
  };
}

/**
 * Serves `server` over newline-delimited JSON-RPC on `input` and `output` until the input ends; the promise settles once
 * every request read before the end has been answered (calls still running after `drainMs` are cancelled).
 */
export function serveStdio(server, { input = process.stdin, output = process.stdout, log = () => {}, drainMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    let buffer = '';
    let discarding = false;
    let ended = false;
    let drainTimer = null;
    const pending = new Set();
    output.on?.('error', () => {});
    const write = (response) => {
      if (response && output.writable !== false) output.write(`${JSON.stringify(response)}\n`);
    };
    const settle = () => {
      if (!ended || pending.size > 0) return;
      clearTimeout(drainTimer);
      resolve();
    };
    const handle = (line) => {
      if (line.trim() === '') return;
      const work = server.handleLine(line)
        .then(write, (error) => log(`could not answer a message: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`))
        .finally(() => {
          pending.delete(work);
          settle();
        });
      pending.add(work);
    };
    input.setEncoding?.('utf8');
    input.on('data', (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (discarding) discarding = false;
        else handle(line);
        index = buffer.indexOf('\n');
      }
      if (buffer.length > MAX_MESSAGE_CHARS) {
        buffer = '';
        if (!discarding) write(errorResponse(null, ERRORS.INVALID_REQUEST, `Invalid Request: a message is longer than ${MAX_MESSAGE_CHARS} characters`));
        discarding = true;
      }
    });
    input.on('end', () => {
      if (!discarding && buffer.trim() !== '') handle(buffer.replace(/\r$/, ''));
      buffer = '';
      ended = true;
      drainTimer = setTimeout(() => server.cancelAll(), drainMs);
      drainTimer.unref?.();
      settle();
    });
    input.on('error', () => {
      ended = true;
      server.cancelAll();
      settle();
    });
  });
}
