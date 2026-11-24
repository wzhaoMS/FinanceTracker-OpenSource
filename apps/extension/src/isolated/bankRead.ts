/**
 * The only way the extension itself sends a request to an issuer
 * (plan §4.2): `bankRead(operationId, params, pageContext)` in the ISOLATED
 * collector. The worker, the MAIN observer and the in-page panel have no bank
 * client at all, and a build check refuses `fetch` anywhere else.
 *
 * Callers name an operation and give typed values (dates, small integers,
 * enum members, an opaque cursor); never a URL, method, header or body. Each
 * `BankReadContract` is fixed in source: exact origin, path template, method,
 * the closed set of query and body keys with their types, constant headers.
 * Account selectors live in a page-local context handle and never leave the
 * collector. After the URL is built it is parsed again and must be exactly
 * what the contract allows (scheme, host, port, path, keys, no userinfo or
 * fragment). Requests use `redirect: "error"`, `cache: "no-store"`,
 * `referrerPolicy: "no-referrer"`, same-origin credentials and a timeout;
 * only a 200 JSON response is read, up to a byte cap. 401/403 and HTML
 * login pages stop the run as `auth-required`; 429 stops it as
 * `rate-limited` and honours Retry-After; nothing is retried here.
 *
 * Budgets are ours, not an issuer guarantee: one request at a time per
 * reader, a minimum gap between requests, a request cap and a run deadline.
 * A deny-list (payments, transfers, offers, profile, security, sessions…) is
 * a second insurance on top of the allowlist and is checked when the reader
 * is created.
 */
import type { CardSyncReadContractId } from '@finance-tracker/shared';
import type { Budget } from '../contracts/messages.js';

export type ParamSpec =
  | { readonly kind: 'const'; readonly value: string | boolean | number | null }
  | { readonly kind: 'date'; readonly required: boolean }
  | { readonly kind: 'int'; readonly min: number; readonly max: number; readonly required: boolean }
  | { readonly kind: 'enum'; readonly values: readonly string[]; readonly required: boolean }
  | { readonly kind: 'cursor'; readonly maxLength: number };

export type PathPart = { readonly literal: string } | { readonly handle: 'accountId' };

export type BodySpec =
  | { readonly kind: 'none' }
  | { readonly kind: 'form-empty' }
  | { readonly kind: 'json'; readonly fields: readonly (readonly [string, ParamSpec])[] };

export interface BankReadContract {
  readonly operationId: string;
  readonly contract: CardSyncReadContractId;
  readonly method: 'GET' | 'POST';
  readonly origin: string;
  readonly path: readonly PathPart[];
  readonly query: readonly (readonly [string, ParamSpec])[];
  readonly body: BodySpec;
  /** Constant, lower-case header names; never cookies, origin, host, referrer, authorization or sec-*. */
  readonly headers: readonly (readonly [string, string])[];
}

export type BankReadError =
  | 'auth-required'
  | 'rate-limited'
  | 'timeout'
  | 'cap'
  | 'too-large'
  | 'unexpected-response'
  | 'repeated-cursor'
  | 'refused'
  | 'stopped';

export type BankReadResult = { ok: true; json: unknown } | { ok: false; error: BankReadError; retryAfterMs: number | null };

export type ParamValue = string | number | null;

/** The isolated world's own fetch, captured when the collector loads; the only network function the collector holds. */
export const isolatedFetch: (url: string, init: RequestInit) => Promise<Response> = (() => {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  return (url: string, init: RequestInit) => nativeFetch(url, init);
})();

// ---------------------------------------------------------------------------
// Page-local context handles
// ---------------------------------------------------------------------------

declare const PAGE_CONTEXT: unique symbol;
/** An opaque handle; the values behind it never leave the collector. */
export interface PageContext {
  readonly [PAGE_CONTEXT]: true;
}

const contextValues = new WeakMap<object, { accountId: string | null }>();

export function createPageContext(values: { accountId: string | null }): PageContext {
  const handle = Object.freeze(Object.create(null)) as PageContext;
  contextValues.set(handle, { accountId: values.accountId });
  return handle;
}

// ---------------------------------------------------------------------------
// Contract checks
// ---------------------------------------------------------------------------

const SEGMENT = /^[A-Za-z0-9._~-]{1,128}$/;
const KEY = /^[A-Za-z0-9._~-]{1,64}$/;
const FORBIDDEN_HEADER = /^(?:cookie|cookie2|origin|host|referer|referrer|authorization|proxy-.*|sec-.*|x-forwarded-.*|forwarded|via|user-agent|content-length|connection|keep-alive|te|trailer|upgrade|transfer-encoding)$/;
/** Second insurance: never read anything that sounds like money movement, enrollment, profile, security or session upkeep. */
const DENY = /pay|transfer|zelle|billpay|offer|enrol|profile|member|security|password|cardcontrol|card-control|lock|dispute|keepalive|keep-alive|extend|session|recommend|deal|logout|signout|activate|download|export|document/i;

export function checkContract(contract: BankReadContract): string | null {
  let origin: URL;
  try {
    origin = new URL(contract.origin);
  } catch {
    return 'origin';
  }
  if (origin.origin !== contract.origin || (origin.protocol !== 'https:' && origin.protocol !== 'http:')) return 'origin';
  if (contract.method !== 'GET' && contract.method !== 'POST') return 'method';
  if (contract.method === 'GET' && contract.body.kind !== 'none') return 'body';
  const names: string[] = [];
  for (const part of contract.path) {
    if ('literal' in part) {
      if (!SEGMENT.test(part.literal) || part.literal === '.' || part.literal === '..') return 'path';
      names.push(part.literal);
    } else if (part.handle !== 'accountId') return 'path';
  }
  const keys = new Set<string>();
  const fields = [...contract.query, ...(contract.body.kind === 'json' ? contract.body.fields : [])];
  for (const [key] of fields) {
    if (!KEY.test(key) || keys.has(key)) return 'key';
    keys.add(key);
    names.push(key);
  }
  for (const [name, value] of contract.headers) {
    if (name !== name.toLowerCase() || !/^[a-z0-9-]{1,64}$/.test(name) || FORBIDDEN_HEADER.test(name)) return 'header';
    if (!/^[\x20-\x7e]{0,256}$/.test(value)) return 'header';
  }
  if (names.some((name) => DENY.test(name))) return 'deny-list';
  return null;
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

export interface BankReaderOptions {
  readonly contracts: readonly BankReadContract[];
  readonly budget: Budget;
  /** Aborts the whole run (stop, kill switch, navigation). */
  readonly signal: AbortSignal;
  readonly fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  readonly now: () => number;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface BankReader {
  bankRead(operationId: string, params: Readonly<Record<string, ParamValue>>, context: PageContext | null): Promise<BankReadResult>;
  readonly requestCount: number;
}

function fail(error: BankReadError, retryAfterMs: number | null = null): BankReadResult {
  return { ok: false, error, retryAfterMs };
}

function resolveParam(spec: ParamSpec, given: ParamValue | undefined, cursors: Set<string>): { ok: true; value: string | number | boolean | null | undefined } | { ok: false; error: BankReadError } {
  switch (spec.kind) {
    case 'const':
      return given === undefined ? { ok: true, value: spec.value } : { ok: false, error: 'refused' };
    case 'date':
      if (given === undefined || given === null) return spec.required ? { ok: false, error: 'refused' } : { ok: true, value: undefined };
      return typeof given === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(given) ? { ok: true, value: given } : { ok: false, error: 'refused' };
    case 'int':
      if (given === undefined || given === null) return spec.required ? { ok: false, error: 'refused' } : { ok: true, value: undefined };
      return typeof given === 'number' && Number.isSafeInteger(given) && given >= spec.min && given <= spec.max ? { ok: true, value: given } : { ok: false, error: 'refused' };
    case 'enum':
      if (given === undefined || given === null) return spec.required ? { ok: false, error: 'refused' } : { ok: true, value: undefined };
      return typeof given === 'string' && spec.values.includes(given) ? { ok: true, value: given } : { ok: false, error: 'refused' };
    case 'cursor':
      if (given === undefined || given === null) return { ok: true, value: undefined };
      if (typeof given !== 'string' || given.length === 0 || given.length > spec.maxLength || !/^[\x20-\x7e]+$/.test(given)) return { ok: false, error: 'refused' };
      if (cursors.has(given)) return { ok: false, error: 'repeated-cursor' };
      cursors.add(given);
      return { ok: true, value: given };
    default:
      return { ok: false, error: 'refused' };
  }
}

function retryAfter(response: Response, now: number): number | null {
  const header = response.headers.get('retry-after');
  if (header === null) return null;
  if (/^[0-9]{1,6}$/.test(header.trim())) return Number(header.trim()) * 1_000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const body = response.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createBankReader(options: BankReaderOptions): BankReader {
  const contracts = new Map<string, BankReadContract>();
  for (const contract of options.contracts) {
    const problem = checkContract(contract);
    if (problem) throw new Error(`bank read contract refused (${problem})`);
    if (contracts.has(contract.operationId)) throw new Error('duplicate bank read contract');
    contracts.set(contract.operationId, contract);
  }
  const deadline = options.now() + options.budget.runLimitMs;
  const cursors = new Set<string>();
  // The issuer's previous read, in any tab, ended less than one request interval ago: the first request waits out the rest.
  let lastStart = options.budget.startDelayMs > 0 ? options.now() + options.budget.startDelayMs - options.budget.requestIntervalMs : -Infinity;
  let requests = 0;
  let chain: Promise<unknown> = Promise.resolve();

  const buildRequest = (
    contract: BankReadContract,
    params: Readonly<Record<string, ParamValue>>,
    context: PageContext | null,
  ): { ok: true; url: string; init: RequestInit } | { ok: false; error: BankReadError } => {
    const declared = new Set([...contract.query.map(([key]) => key), ...(contract.body.kind === 'json' ? contract.body.fields.map(([key]) => key) : [])]);
    for (const key of Object.keys(params)) if (!declared.has(key)) return { ok: false, error: 'refused' };

    const segments: string[] = [];
    for (const part of contract.path) {
      if ('literal' in part) {
        segments.push(part.literal);
        continue;
      }
      const values = context ? contextValues.get(context) : undefined;
      const accountId = values?.accountId ?? null;
      if (accountId === null || !SEGMENT.test(accountId) || accountId === '.' || accountId === '..') return { ok: false, error: 'refused' };
      segments.push(accountId);
    }
    const path = `/${segments.join('/')}`;

    const query: string[] = [];
    const expectedKeys: string[] = [];
    for (const [key, spec] of contract.query) {
      const resolved = resolveParam(spec, params[key], cursors);
      if (!resolved.ok) return resolved;
      if (resolved.value === undefined || resolved.value === null) continue;
      expectedKeys.push(key);
      query.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(resolved.value))}`);
    }
    let body: string | undefined;
    const headers: Array<[string, string]> = [['accept', 'application/json'], ...contract.headers.map(([name, value]): [string, string] => [name, value])];
    if (contract.body.kind === 'form-empty') {
      body = '';
      headers.push(['content-type', 'application/x-www-form-urlencoded; charset=UTF-8']);
    } else if (contract.body.kind === 'json') {
      const object: Record<string, unknown> = {};
      for (const [key, spec] of contract.body.fields) {
        const resolved = resolveParam(spec, params[key], cursors);
        if (!resolved.ok) return resolved;
        if (resolved.value !== undefined) object[key] = resolved.value;
      }
      body = JSON.stringify(object);
      headers.push(['content-type', 'application/json']);
    }

    const href = `${contract.origin}${path}${query.length > 0 ? `?${query.join('&')}` : ''}`;
    let parsed: URL;
    try {
      parsed = new URL(href);
    } catch {
      return { ok: false, error: 'refused' };
    }
    const keys = [...parsed.searchParams.keys()];
    if (
      parsed.origin !== contract.origin
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.hash !== ''
      || parsed.pathname !== path
      || parsed.href !== href
      || keys.length !== expectedKeys.length
      || keys.some((key, index) => key !== expectedKeys[index])
      || new Set(keys).size !== keys.length
    ) {
      return { ok: false, error: 'refused' };
    }
    return {
      ok: true,
      url: parsed.href,
      init: {
        method: contract.method,
        headers,
        body,
        credentials: 'same-origin',
        mode: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      },
    };
  };

  const once = async (operationId: string, params: Readonly<Record<string, ParamValue>>, context: PageContext | null): Promise<BankReadResult> => {
    if (options.signal.aborted) return fail('stopped');
    const contract = contracts.get(operationId);
    if (!contract) return fail('refused');
    if (requests >= options.budget.maxRequests || options.now() >= deadline) return fail('cap');
    const request = buildRequest(contract, params, context);
    if (!request.ok) return fail(request.error);

    const wait = lastStart + options.budget.requestIntervalMs - options.now();
    if (wait > 0) {
      try {
        await options.sleep(wait, options.signal);
      } catch {
        return fail('stopped');
      }
    }
    if (options.signal.aborted) return fail('stopped');
    if (options.now() >= deadline) return fail('cap');

    const controller = new AbortController();
    const onStop = () => controller.abort();
    options.signal.addEventListener('abort', onStop, { once: true });
    const timer = setTimeout(() => controller.abort(), options.budget.requestTimeoutMs);
    lastStart = options.now();
    requests += 1;
    try {
      const response = await options.fetchImpl(request.url, { ...request.init, signal: controller.signal });
      if (response.redirected || response.type === 'opaque' || response.type === 'opaqueredirect') return fail('unexpected-response');
      if (response.status === 401 || response.status === 403) return fail('auth-required');
      if (response.status === 429) return fail('rate-limited', retryAfter(response, options.now()));
      const type = (response.headers.get('content-type') ?? '').toLowerCase();
      if (response.status === 200 && type.startsWith('text/html')) return fail('auth-required');
      if (response.status !== 200 || !/^application\/json(?:;\s*charset=utf-8)?$/.test(type)) return fail('unexpected-response');
      const bytes = await readCapped(response, options.budget.maxResponseBytes);
      if (bytes === null) return fail('too-large');
      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        return fail('unexpected-response');
      }
      return { ok: true, json };
    } catch {
      if (options.signal.aborted) return fail('stopped');
      return controller.signal.aborted ? fail('timeout') : fail('unexpected-response');
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onStop);
    }
  };

  return {
    bankRead(operationId, params, context) {
      const result = chain.then(() => once(operationId, params, context));
      chain = result.catch(() => undefined);
      return result;
    },
    get requestCount() {
      return requests;
    },
  };
}

/** A sleep that rejects when the run is stopped. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('stopped'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('stopped'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
