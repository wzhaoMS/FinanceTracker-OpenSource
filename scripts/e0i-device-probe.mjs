#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const LIMIT = 2 * 1024 * 1024;
const TIMEOUT = 15_000;
const NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const CODE = /^[a-z][a-z-]{0,62}$/;
const RESERVED = new Set(['front', 'direct', 'runId', '__proto__', 'prototype', 'constructor']);
const PHASES = new Set([
  'pairing', 'approval', 'capabilities', 'observation', 'preview', 'commit', 'receipt', 'abort',
  'direct-refusal', 'cookie-refusal', 'owner-refusal', 'service-refusal', 'revocation', 'revoked-refusal',
  'attestation-unverified', 'attestation-refused', 'fence-refusal', 'cors-allowed', 'cors-refused', 'restore-refusal',
]);
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const HEADERS = new Set([
  'authorization', 'cookie', 'origin', 'content-type', 'accept', 'x-holdr-request', 'idempotency-key',
  'access-control-request-method', 'access-control-request-headers',
]);
const REF = /\{\{([a-zA-Z][a-zA-Z0-9_]{0,63})\}\}/g;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, required, optional = []) => object(value)
  && required.every((key) => Object.hasOwn(value, key))
  && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
class ProbeError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new ProbeError(code); };

function origin(value, direct = false) {
  try {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password || (direct
      ? url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
      : url.protocol !== 'https:')) return fail('probe-origin');
    return url.origin;
  } catch { return fail('probe-origin'); }
}

function variable(name) {
  if (!NAME.test(name) || RESERVED.has(name)) fail('probe-plan');
}

function pointer(value, location) {
  if (typeof location !== 'string' || !/^\/(?:[^~]|~[01])*$/.test(location)) fail('probe-plan');
  let current = value;
  for (const encoded of location.slice(1).split('/')) {
    const part = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (RESERVED.has(part) || current === null || typeof current !== 'object' || !Object.hasOwn(current, part)) fail('probe-capture');
    current = current[part];
  }
  return current;
}

function template(value, vars, inPath = false, depth = 0) {
  if (depth > 32) fail('probe-plan');
  if (typeof value === 'string') {
    const whole = /^\{\{([a-zA-Z][a-zA-Z0-9_]{0,63})\}\}$/.exec(value);
    if (whole && !inPath) {
      if (!vars.has(whole[1])) fail('probe-variable');
      return vars.get(whole[1]);
    }
    const result = value.replace(REF, (_match, name) => {
      const replacement = vars.get(name);
      if (typeof replacement !== 'string' && typeof replacement !== 'number') fail('probe-variable');
      return inPath ? encodeURIComponent(String(replacement)) : String(replacement);
    });
    if (result.includes('{{') || result.includes('}}')) fail('probe-variable');
    return result;
  }
  if (Array.isArray(value)) return value.map((entry) => template(entry, vars, false, depth + 1));
  if (object(value)) {
    if (Object.keys(value).some((key) => RESERVED.has(key))) fail('probe-plan');
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, template(entry, vars, false, depth + 1)]));
  }
  return value;
}

function requestPath(value, base) {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('/') || value.startsWith('//')
    || /[\\\0\r\n#]/.test(value)) fail('probe-path');
  const url = new URL(value, base);
  if (url.origin !== base || url.pathname !== value.split('?')[0]
    || !/^\/(?:card-sync(?:\/|$)|auth\/(?:login|logout|me|reverify)$|health$)/.test(url.pathname)) fail('probe-path');
  return url.pathname + url.search;
}

function decode(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return fail('probe-json'); }
}

export function validateDevicePlan(plan) {
  if (!keys(plan, ['format', 'steps']) || plan.format !== 'holdr-device-probe/1'
    || !Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > 100) fail('probe-plan');
  const captures = new Set();
  for (const step of plan.steps) {
    if (!keys(step, ['phase', 'target', 'method', 'path', 'expect'], ['headers', 'body', 'capture', 'captureCookie'])
      || !PHASES.has(step.phase) || !['front', 'direct'].includes(step.target) || !METHODS.has(step.method)
      || typeof step.path !== 'string' || !keys(step.expect, ['status'], ['code', 'json', 'headers'])
      || !Number.isInteger(step.expect.status) || step.expect.status < 200 || step.expect.status > 599
      || (step.expect.status >= 300 && step.expect.status < 400)
      || (step.expect.code !== undefined && !CODE.test(step.expect.code))) fail('probe-plan');
    if (step.target === 'direct' && step.expect.status < 400) fail('probe-plan');
    if (step.headers !== undefined && (!object(step.headers)
      || Object.keys(step.headers).some((name) => !HEADERS.has(name) || name !== name.toLowerCase()))) fail('probe-plan');
    for (const expected of [step.expect.json, step.expect.headers, step.capture]) {
      if (expected !== undefined && !object(expected)) fail('probe-plan');
    }
    for (const [name, location] of Object.entries(step.capture ?? {})) {
      variable(name);
      if (captures.has(name) || typeof location !== 'string' || !location.startsWith('/')) fail('probe-plan');
      captures.add(name);
    }
    if (step.captureCookie !== undefined) {
      variable(step.captureCookie);
      if (captures.has(step.captureCookie)) fail('probe-plan');
      captures.add(step.captureCookie);
    }
  }
  return plan;
}

function wireRequest({ base, target, method, headers = {}, body, ca }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    const start = process.hrtime.bigint();
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { request?.destroy(); reject(error); } else resolve(value);
    };
    const timer = setTimeout(() => done(new ProbeError('probe-timeout')), TIMEOUT);
    const deadline = () => process.hrtime.bigint() - start >= BigInt(TIMEOUT) * 1_000_000n;
    try {
      const url = new URL(target, base);
      const transport = url.protocol === 'https:' ? https : http;
      request = transport.request(url, {
        method, headers, agent: false, ...(url.protocol === 'https:' ? { ca, rejectUnauthorized: true } : {}),
      }, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) return done(new ProbeError('probe-redirect'));
        const chunks = [];
        let length = 0;
        response.on('data', (chunk) => {
          length += chunk.length;
          if (deadline()) return done(new ProbeError('probe-timeout'));
          if (length > LIMIT) return done(new ProbeError('probe-response-large'));
          chunks.push(chunk);
        });
        response.once('error', () => done(new ProbeError('probe-network')));
        response.once('end', () => done(deadline() ? new ProbeError('probe-timeout') : null, {
          status, headers: response.headers, body: Buffer.concat(chunks),
        }));
      });
      request.once('error', (error) => done(new ProbeError(
        /CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(error.code ?? '') ? 'probe-tls' : 'probe-network',
      )));
      request.end(body);
    } catch { done(new ProbeError('probe-request')); }
  });
}

function verifiedIdentity(response, runId) {
  if (response.status !== 200) fail('probe-identity');
  const value = decode(response.body);
  if (!keys(value, ['ok', 'schemaVersion', 'e2e']) || value.ok !== true || value.schemaVersion !== 15
    || !keys(value.e2e, ['runId', 'disposableDataDir']) || value.e2e.runId !== runId || value.e2e.disposableDataDir !== true) fail('probe-identity');
}

/**
 * AL2's client, driven by an E2-versioned request plan rather than guessed future route bodies.
 * Tests may inject the transport here; the executable always uses wireRequest and verifies TLS.
 */
export async function runDeviceProbe(options, send = wireRequest) {
  const front = origin(options.front);
  const direct = origin(options.direct, true);
  if (!/^[0-9a-f]{32}$/.test(options.runId) || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') fail('probe-configuration');
  const plan = validateDevicePlan(options.plan);
  if (!object(options.secrets)) fail('probe-private-input');
  const previous = options.previousState;
  if (previous && (!keys(previous, ['format', 'runId', 'front', 'direct', 'variables'])
    || previous.format !== 'holdr-device-probe-state/1' || previous.runId !== options.runId
    || previous.front !== front || previous.direct !== direct || !object(previous.variables))) fail('probe-identity');
  const vars = new Map([['front', front], ['direct', direct], ['runId', options.runId]]);
  for (const [name, value] of Object.entries(options.secrets)) { variable(name); vars.set(name, value); }
  const output = options.output ?? ((entry) => console.log(JSON.stringify(entry)));
  const captured = Object.create(null);
  const frontHealth = await send({ base: front, target: '/health', method: 'GET', ca: options.ca });
  let closed = false;
  if (frontHealth.status === 503 && previous) {
    const value = decode(frontHealth.body);
    const code = frontHealth.headers['x-holdr-error'] ?? (object(value) ? value.error : undefined);
    closed = ['ingress-unverified', 'ingress-refused'].includes(code) && plan.steps.every((step) =>
      step.target === 'front' && step.expect.status === 503 && step.expect.code === code
      && step.phase === (code === 'ingress-unverified' ? 'attestation-unverified' : 'attestation-refused'));
  }
  // A fault closes /health too. Only a previously bound private state and a refusal-only plan may use that case.
  if (!closed) verifiedIdentity(frontHealth, options.runId);
  verifiedIdentity(await send({ base: direct, target: '/health', method: 'GET', ca: options.ca }), options.runId);
  output({ step: 0, status: closed ? 503 : 200, code: closed ? 'synthetic-bound-ingress-closed' : 'synthetic-verified' });
  for (const [index, step] of plan.steps.entries()) {
    const base = step.target === 'front' ? front : direct;
    const target = requestPath(template(step.path, vars, true), base);
    const headers = template(step.headers ?? {}, vars);
    for (const value of Object.values(headers)) if (typeof value !== 'string' || /[\0\r\n]/.test(value)) fail('probe-headers');
    const body = step.body === undefined ? undefined : Buffer.from(JSON.stringify(template(step.body, vars)));
    if (body && (body.length > LIMIT || step.method === 'GET' || step.method === 'HEAD')) fail('probe-body');
    if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = String(body.length); }
    const response = await send({ base, target, method: step.method, headers, body, ca: options.ca });
    const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : 0;
    const json = response.body.length ? decode(response.body) : null;
    const actualCode = response.headers['x-holdr-error'] ?? (object(json) ? json.error : undefined);
    const comparableCode = actualCode === 'Invalid credentials' ? 'invalid-credentials' : actualCode;
    const matches = status === step.expect.status && (step.expect.code === undefined || comparableCode === step.expect.code);
    output({
      step: index + 1, phase: step.phase, status,
      code: matches ? step.expect.code ?? (status < 400 ? 'ok' : 'http-refused') : 'unexpected-response',
    });
    if (!matches) fail('probe-response');
    for (const [location, expected] of Object.entries(step.expect.json ?? {})) {
      if (JSON.stringify(pointer(json, location)) !== JSON.stringify(template(expected, vars))) fail('probe-response');
    }
    for (const [name, expected] of Object.entries(step.expect.headers ?? {})) {
      if (response.headers[name] !== template(expected, vars)) fail('probe-response');
    }
    const capture = (name, value) => {
      if (vars.has(name)) fail('probe-variable');
      vars.set(name, value); captured[name] = value;
    };
    for (const [name, location] of Object.entries(step.capture ?? {})) capture(name, pointer(json, location));
    if (step.captureCookie) {
      const cookies = response.headers['set-cookie'];
      if (!Array.isArray(cookies) || cookies.length !== 1
        || !/^__Host-holdr_session=[^;,\s]+;/.test(cookies[0])
        || !/; Secure(?:;|$)/i.test(cookies[0]) || !/; HttpOnly(?:;|$)/i.test(cookies[0])
        || !/; Path=\/(?:;|$)/i.test(cookies[0]) || !/; SameSite=Lax(?:;|$)/i.test(cookies[0])
        || /; Domain=/i.test(cookies[0])) fail('probe-cookie');
      capture(step.captureCookie, cookies[0].split(';')[0]);
    }
  }
  output({ steps: plan.steps.length, code: 'probe-passed' });
  return { format: 'holdr-device-probe-state/1', runId: options.runId, front, direct, variables: captured };
}

function readFile(file, privateFile) {
  const absolute = path.resolve(file);
  let fd;
  try {
    const before = fs.lstatSync(absolute);
    if (!before.isFile() || before.nlink !== 1 || before.size > LIMIT || fs.realpathSync.native(absolute) !== absolute) fail('probe-input-file');
    if (privateFile && (typeof process.getuid !== 'function' || before.uid !== process.getuid() || (before.mode & 0o7777) !== 0o600)) {
      fail('probe-private-input');
    }
    fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (before.dev !== opened.dev || before.ino !== opened.ino || opened.size > LIMIT || !opened.isFile()
      || opened.nlink !== 1 || (privateFile && (opened.uid !== process.getuid() || (opened.mode & 0o7777) !== 0o600))) fail('probe-input-file');
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    const named = fs.lstatSync(absolute);
    if (bytes.length > LIMIT || after.size !== opened.size || after.ctimeMs !== opened.ctimeMs
      || after.mtimeMs !== opened.mtimeMs || named.dev !== opened.dev || named.ino !== opened.ino
      || fs.realpathSync.native(absolute) !== absolute) fail('probe-input-file');
    return bytes;
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    return fail('probe-input-file');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

async function stdin() {
  const chunks = [];
  let size = 0;
  const timer = setTimeout(() => process.stdin.destroy(new ProbeError('probe-private-input')), TIMEOUT);
  try {
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > LIMIT) fail('probe-private-input');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally { clearTimeout(timer); }
}

function saveState(file, value) {
  const absolute = path.resolve(file);
  const parent = path.dirname(absolute);
  const stat = fs.lstatSync(parent);
  if (typeof process.getuid !== 'function' || !stat.isDirectory() || stat.uid !== process.getuid()
    || (stat.mode & 0o7777) !== 0o700 || fs.realpathSync.native(parent) !== parent) fail('probe-private-output');
  const fd = fs.openSync(absolute, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

export async function deviceProbeMain(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: {
      front: { type: 'string' }, direct: { type: 'string' }, 'run-id': { type: 'string' },
      plan: { type: 'string' }, secrets: { type: 'string' }, ca: { type: 'string' }, 'save-state': { type: 'string' },
    }, strict: true, allowPositionals: false }));
    if (!values.front || !values.direct || !values['run-id'] || !values.plan || !values.secrets) throw Error();
  } catch {
    console.error('E0I_DEVICE_PROBE_USAGE');
    return 64;
  }
  try {
    const input = decode(values.secrets === '-' ? await stdin() : readFile(values.secrets, true));
    const state = object(input) && input.format === 'holdr-device-probe-state/1';
    if (state && (!keys(input, ['format', 'runId', 'front', 'direct', 'variables'])
      || input.runId !== values['run-id'] || input.front !== values.front || input.direct !== values.direct)) fail('probe-identity');
    const result = await runDeviceProbe({
      front: values.front, direct: values.direct, runId: values['run-id'], plan: decode(readFile(values.plan, false)),
      secrets: state ? input.variables : input, previousState: state ? input : undefined,
      ca: values.ca ? readFile(values.ca, false) : undefined,
    });
    if (state) result.variables = { ...input.variables, ...result.variables };
    if (values['save-state']) saveState(values['save-state'], result);
    return 0;
  } catch (error) {
    console.error(error instanceof ProbeError ? error.code : 'probe-failed');
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await deviceProbeMain(process.argv.slice(2));
}
