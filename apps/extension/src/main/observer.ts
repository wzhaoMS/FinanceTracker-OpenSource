/**
 * The passive MAIN-world observer (plan §3.1, §4.2). Registered only for
 * issuers the user approved for MAIN observation, at document_start, before
 * page scripts run. It never sends a request: it watches the page's own
 * fetch and XHR calls and reads a copy of the responses that match one of the
 * adapter's fixed observe contracts.
 *
 * - `fetch` returns the original promise and response, unchanged. A matching
 *   response is cloned (never the page's body) before the page can read it;
 *   a failed clone only affects the observer.
 * - XHR is read only when its own request is done (`readystatechange` to
 *   DONE, before `load`); responseText is never replaced and nothing is
 *   consumed early.
 * - A match needs the method, exact request origin, path, closed set of query
 *   keys and request-body shape, and then a final response URL equal to the
 *   request URL (any redirect is ignored, even to another path the contract
 *   allows, such as another account's), status 200, a JSON content type and a
 *   size cap. Nothing else is cloned or read.
 * - A response is projected only under the route it was requested in: the
 *   observer counts route changes (`watchRouteChanges`, the same count the
 *   ISOLATED collector keeps from the same events), binds every request to
 *   the count at its start, drops answers that arrive under another count,
 *   and starts a new stream at each change. Each batch carries its count
 *   (`gen`); the collector takes it only under the same count.
 * - The adapter projects the parsed response into new objects in the page;
 *   only a batch `validateProjectedBankBatch` accepts is posted, over the
 *   bridge, to the ISOLATED collector, which validates it again.
 * - The only controls this world accepts are `stop` and `reset` (the page's
 *   sign-in ended, which only the collector can see; both sides count it
 *   with the route changes). Stop restores its own wrappers when they are
 *   still in place and leaves any hook the page installed later alone.
 *
 * Page scripts can see and forge bridge messages and patch the intrinsics
 * this code uses; MAIN validation is advisory and ISOLATED is authoritative.
 */
import type { CardSyncIssuer, CardSyncReadContractId, ProjectedBankBatchValidation } from '@finance-tracker/shared';
import { watchRouteChanges } from '../common/navigation.js';
import { BATCH_MESSAGE_LIMITS, parseStrict, parseStrictUnion } from '../common/strict.js';
import { BRIDGE_CHANNEL, BRIDGE_FROM_ISOLATED, type BridgeFromMain } from '../contracts/messages.js';
import {
  SHAPE_MAX_BODY_ENTRIES,
  SHAPE_MAX_RESPONSE_ENTRIES,
  SHAPE_REPORT,
  SHAPE_REPORT_TYPE,
  shapeEntries,
  shapeHeaderName,
  shapeKeyName,
  type ShapeContractSpec,
  type ShapeReport,
} from '../contracts/shapeReport.js';
import { createStream, type StreamContext } from '../projection/stream.js';

export type { StreamContext } from '../projection/stream.js';

export interface ObserveContract {
  readonly contract: CardSyncReadContractId;
  readonly method: 'GET' | 'POST';
  /** Exact origin of the request, which may be a cross-origin wrapper of the page. */
  readonly origin: string;
  /** The whole pathname. */
  readonly path: RegExp;
  /** The path template a shape report shows (dynamic segments as `:opaque`). */
  readonly template: string;
  /** Closed set of query keys; empty means no query at all. */
  readonly queryKeys: readonly string[];
  /** 'none', or a check of the parsed JSON request body's keys and constants (values are not kept). */
  readonly requestBody: 'none' | ((body: unknown) => boolean);
  readonly maxResponseBytes: number;
}

export interface Observed {
  readonly contract: ObserveContract;
  /** The request URL; any account id in it stays in this world. */
  readonly requestUrl: URL;
  readonly requestBody: unknown;
  readonly json: unknown;
}

/**
 * What a MAIN adapter returns for a response its contract no longer
 * describes (a required field missing, a type changed, an unknown enum
 * value): the issuer's contract pauses (plan §4, §10). A batch that fails
 * validation is an ordinary refusal instead.
 */
export const SHAPE_CHANGED = Object.freeze({ ok: false as const, shapeChanged: true as const });
export type MainProjection = ProjectedBankBatchValidation | typeof SHAPE_CHANGED;

export interface MainAdapter {
  readonly adapterId: string;
  readonly issuer: CardSyncIssuer;
  readonly contracts: readonly ObserveContract[];
  /** Shape mode only: what each contract may report (the descriptor's `shapeContracts`); every unconfirmed name is `<dynamic-key>`. */
  readonly shapeContracts?: Readonly<Partial<Record<CardSyncReadContractId, ShapeContractSpec>>>;
  project(observed: Observed, stream: StreamContext): MainProjection | null;
  /** Account candidates from rendered page state, once the document is parsed. */
  discoverFromPage?(stream: StreamContext): MainProjection | null;
}

const MAX_REQUEST_BODY_CHARS = 64 * 1024;
const MAX_QUEUE = 20;

function matchQuery(url: URL, keys: readonly string[]): boolean {
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!keys.includes(key) || seen.has(key)) return false;
    seen.add(key);
  }
  return keys.length > 0 || url.search === '';
}

/** The response answers exactly the request that matched: a redirect, even to another path the contract allows, does not. */
function answersRequest(finalUrl: string, requested: URL): boolean {
  try {
    const expected = new URL(requested.href);
    expected.hash = '';
    return new URL(finalUrl).href === expected.href;
  } catch {
    return false;
  }
}

export type ObserverMode = 'sync' | 'shape';

/** Installs the observer for one adapter in this document. Call once, at document_start. */
export function installObserver(adapter: MainAdapter, mode: ObserverMode): void {
  const win = window;
  const nativeFetch = win.fetch;
  const NativeXHR = win.XMLHttpRequest;
  const xhrOpen = NativeXHR.prototype.open;
  const xhrSend = NativeXHR.prototype.send;
  const xhrSetRequestHeader = NativeXHR.prototype.setRequestHeader;
  const cloneResponse = Response.prototype.clone;
  const jsonParse = JSON.parse;
  const postMessage = win.postMessage.bind(win);
  const addListener = EventTarget.prototype.addEventListener;
  const removeListener = EventTarget.prototype.removeEventListener;
  const pageOrigin = win.location.origin;
  const doc = win.document;

  const stream = createStream();
  /** Route changes so far (the collector counts the same events); an answer is projected only under its request's count. */
  let generation = 0;
  let active = true;
  // Without the Navigation API (the manifest requires a browser that has it) requests could not be bound to their
  // route: nothing is observed for sync then.
  const routesWatched = watchRouteChanges(win, addListener, () => {
    generation += 1;
    stream.restart();
  });
  if (!routesWatched && mode === 'sync') active = false;
  let nonce: string | null = null;
  const queue: BridgeFromMain[] = [];
  /** Per XHR, its current request (replaced at every `open`, so an earlier request's listener never reads a later answer). */
  const xhrInfo = new WeakMap<XMLHttpRequest, { method: string; url: string; headers: string[]; sent: boolean }>();

  const post = (message: BridgeFromMain): void => {
    try {
      postMessage(message, pageOrigin);
    } catch {
      // A page that breaks postMessage only stops the observer's own reporting.
    }
  };
  const send = (build: (nonce: string) => BridgeFromMain): void => {
    if (!active) return;
    if (nonce === null) {
      if (queue.length >= MAX_QUEUE) return;
      queue.push(build('pending'));
      return;
    }
    post(build(nonce));
  };

  const findContract = (method: string, url: URL, bodyText: string | null): { contract: ObserveContract; requestBody: unknown } | null => {
    for (const contract of adapter.contracts) {
      if (method !== contract.method || url.origin !== contract.origin || !contract.path.test(url.pathname)) continue;
      if (!matchQuery(url, contract.queryKeys)) continue;
      if (contract.requestBody === 'none') {
        if (bodyText !== null && bodyText !== '') continue;
        return { contract, requestBody: null };
      }
      if (bodyText === null || bodyText.length > MAX_REQUEST_BODY_CHARS) continue;
      let parsed: unknown;
      try {
        parsed = jsonParse(bodyText);
      } catch {
        continue;
      }
      if (contract.requestBody(parsed)) return { contract, requestBody: parsed };
    }
    return null;
  };

  const handle = (contract: ObserveContract, requestBody: unknown, json: unknown, method: string, url: URL, headerNames: readonly string[], requestGeneration: number): void => {
    if (!active) return;
    if (mode === 'shape') {
      const confirmed = new Set(adapter.shapeContracts?.[contract.contract]?.names ?? []);
      const body = requestBody === null ? { entries: [], truncated: false } : shapeEntries(requestBody, SHAPE_MAX_BODY_ENTRIES, confirmed);
      const response = shapeEntries(json, SHAPE_MAX_RESPONSE_ENTRIES, confirmed);
      const report: ShapeReport = {
        type: SHAPE_REPORT_TYPE,
        adapterId: adapter.adapterId,
        issuer: adapter.issuer,
        contract: contract.contract,
        method: contract.method,
        pathTemplate: contract.template,
        queryKeys: [...new Set([...url.searchParams.keys()].map((key) => shapeKeyName(key, confirmed)))].slice(0, 32),
        requestMetaNames: [...new Set(headerNames.map((name) => shapeHeaderName(name, confirmed)))].slice(0, 32),
        requestShape: body.entries,
        responseShape: response.entries,
        truncated: body.truncated || response.truncated,
      };
      const checked = parseStrict(report, SHAPE_REPORT, { limits: BATCH_MESSAGE_LIMITS });
      if (!checked.ok) {
        send((n) => ({ channel: BRIDGE_CHANNEL, kind: 'observer-status', nonce: n, state: 'refused', code: 'projection-refused' }));
        return;
      }
      send((n) => ({ channel: BRIDGE_CHANNEL, kind: 'shape', nonce: n, report: checked.value }));
      return;
    }
    let result: MainProjection | null;
    try {
      // The route changed since this request began: the answer belongs to the page it left (another account, say).
      if (requestGeneration !== generation) return;
      result = adapter.project({ contract, requestUrl: url, requestBody, json }, stream);
    } catch {
      result = null;
    }
    if (result === null) return;
    if (!result.ok) {
      const code = 'shapeChanged' in result ? 'shape-changed' : 'projection-refused';
      send((n) => ({ channel: BRIDGE_CHANNEL, kind: 'observer-status', nonce: n, state: 'refused', code }));
      return;
    }
    const batch = result.batch;
    const gen = generation;
    send((n) => ({ channel: BRIDGE_CHANNEL, kind: 'batch', nonce: n, batch, gen }));
  };

  const readCapped = async (response: Response, maxBytes: number): Promise<string | null> => {
    const body = response.body;
    if (!body) return '';
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
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  };

  const onFetchResponse = (contract: ObserveContract, requestBody: unknown, method: string, url: URL, headerNames: string[], requestGeneration: number, response: Response): void => {
    try {
      if (!active || response.status !== 200 || response.redirected || !answersRequest(response.url, url)) return;
      const type = (response.headers.get('content-type') ?? '').toLowerCase();
      if (!type.startsWith('application/json')) return;
      const copy = cloneResponse.call(response) as Response;
      readCapped(copy, contract.maxResponseBytes)
        .then((text) => {
          if (text === null) {
            send((n) => ({ channel: BRIDGE_CHANNEL, kind: 'observer-status', nonce: n, state: 'refused', code: 'response-too-large' }));
            return;
          }
          let json: unknown;
          try {
            json = jsonParse(text);
          } catch {
            send((n) => ({ channel: BRIDGE_CHANNEL, kind: 'observer-status', nonce: n, state: 'refused', code: 'unexpected-response' }));
            return;
          }
          handle(contract, requestBody, json, method, url, headerNames, requestGeneration);
        })
        .catch(() => undefined);
    } catch {
      // Observation never changes what the page gets.
    }
  };

  function headerNamesOf(headers: HeadersInit | undefined): string[] {
    if (!headers) return [];
    try {
      if (headers instanceof Headers) return [...headers.keys()];
      if (Array.isArray(headers)) return headers.map((pair) => String(pair[0]));
      return Object.keys(headers);
    } catch {
      return [];
    }
  }

  const observedFetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    // eslint-disable-next-line prefer-rest-params
    const promise = Reflect.apply(nativeFetch, this, arguments) as Promise<Response>;
    if (!active) return promise;
    try {
      const requestGeneration = generation;
      const isRequest = typeof Request !== 'undefined' && input instanceof Request;
      const method = String(init?.method ?? (isRequest ? (input as Request).method : 'GET')).toUpperCase();
      const url = new URL(isRequest ? (input as Request).url : String(input), doc.baseURI);
      const body = init?.body;
      const bodyText = typeof body === 'string' ? body : body === undefined || body === null ? (isRequest && method !== 'GET' ? undefined : null) : undefined;
      if (bodyText !== undefined) {
        const match = findContract(method, url, bodyText);
        if (match) {
          const headerNames = headerNamesOf(init?.headers);
          promise.then((response) => onFetchResponse(match.contract, match.requestBody, method, url, headerNames, requestGeneration, response), () => undefined);
        }
      }
    } catch {
      // Observation never changes what the page gets.
    }
    return promise;
  };

  const observedOpen = function (this: XMLHttpRequest, method: string, url: string | URL) {
    try {
      // A new request for this XHR, resolved as XHR resolves it, when it is opened.
      xhrInfo.set(this, { method: String(method).toUpperCase(), url: new URL(String(url), doc.baseURI).href, headers: [], sent: false });
    } catch {
      xhrInfo.delete(this);
    }
    // eslint-disable-next-line prefer-rest-params
    return Reflect.apply(xhrOpen, this, arguments);
  };

  const observedSetRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    try {
      xhrInfo.get(this)?.headers.push(String(name));
    } catch {
      // ignore
    }
    // eslint-disable-next-line prefer-rest-params
    return Reflect.apply(xhrSetRequestHeader, this, arguments);
  };

  const observedSend = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    try {
      const info = xhrInfo.get(this);
      if (active && info && !info.sent) {
        info.sent = true;
        const requestGeneration = generation;
        const url = new URL(info.url);
        const bodyText = typeof body === 'string' ? body : body === undefined || body === null ? null : undefined;
        const match = bodyText === undefined ? null : findContract(info.method, url, bodyText);
        if (match) {
          const xhr = this;
          // Read when this request is done: readystatechange to DONE fires before load, so before a page handler can
          // open the XHR again, and each request's listener goes at its own DONE (a later request's listener is never
          // removed by an earlier request's events). A listener whose XHR was opened again since reads nothing.
          const onDone = (): void => {
            if (xhr.readyState !== 4) return;
            removeListener.call(xhr, 'readystatechange', onDone);
            try {
              if (!active || xhrInfo.get(xhr) !== info || xhr.status !== 200 || !answersRequest(xhr.responseURL, url)) return;
              const type = (xhr.getResponseHeader('content-type') ?? '').toLowerCase();
              if (!type.startsWith('application/json')) return;
              let json: unknown;
              if (xhr.responseType === '' || xhr.responseType === 'text') {
                const text = xhr.responseText;
                if (text.length > match.contract.maxResponseBytes) {
                  send((n) => ({ channel: BRIDGE_CHANNEL, kind: 'observer-status', nonce: n, state: 'refused', code: 'response-too-large' }));
                  return;
                }
                json = jsonParse(text);
              } else if (xhr.responseType === 'json') {
                json = xhr.response;
              } else {
                return;
              }
              handle(match.contract, match.requestBody, json, info.method, url, info.headers, requestGeneration);
            } catch {
              // Observation never changes what the page gets.
            }
          };
          addListener.call(xhr, 'readystatechange', onDone);
        }
      }
    } catch {
      // ignore
    }
    // eslint-disable-next-line prefer-rest-params
    return Reflect.apply(xhrSend, this, arguments);
  };

  win.fetch = observedFetch as typeof fetch;
  NativeXHR.prototype.open = observedOpen as typeof NativeXHR.prototype.open;
  NativeXHR.prototype.setRequestHeader = observedSetRequestHeader;
  NativeXHR.prototype.send = observedSend;

  const stop = (): void => {
    if (!active) return;
    active = false;
    queue.length = 0;
    if (win.fetch === observedFetch) win.fetch = nativeFetch;
    if (NativeXHR.prototype.open === observedOpen) NativeXHR.prototype.open = xhrOpen;
    if (NativeXHR.prototype.setRequestHeader === observedSetRequestHeader) NativeXHR.prototype.setRequestHeader = xhrSetRequestHeader;
    if (NativeXHR.prototype.send === observedSend) NativeXHR.prototype.send = xhrSend;
    if (nonce !== null) post({ channel: BRIDGE_CHANNEL, kind: 'observer-status', nonce, state: 'stopped', code: null });
  };

  addListener.call(win, 'message', (event: Event) => {
    const message = event as MessageEvent;
    if (message.source !== win || message.origin !== pageOrigin) return;
    const data: unknown = message.data;
    if (typeof data !== 'object' || data === null || (data as { channel?: unknown }).channel !== BRIDGE_CHANNEL) return;
    const kind = (data as { kind?: unknown }).kind;
    if (kind !== 'hello' && kind !== 'stop' && kind !== 'reset') return;
    const parsed = parseStrictUnion(data, 'kind', BRIDGE_FROM_ISOLATED);
    if (!parsed.ok) return;
    if (parsed.value.kind === 'hello' && nonce === null) {
      nonce = parsed.value.nonce;
      for (const item of queue.splice(0)) post({ ...item, nonce } as BridgeFromMain);
      if (active) post({ channel: BRIDGE_CHANNEL, kind: 'observer-status', nonce, state: 'observing', code: null });
    } else if (parsed.value.kind === 'stop' && nonce !== null && parsed.value.nonce === nonce) {
      stop();
    } else if (parsed.value.kind === 'reset' && nonce !== null && parsed.value.nonce === nonce) {
      // The page's sign-in ended (only the collector sees that; it counts this reset as well): answers to requests begun
      // before it are dropped, and what follows starts a new stream.
      generation += 1;
      stream.restart();
    }
  });
  // Leaving the page (a navigation, or the back/forward cache) stops the observer for good, on its own: a restored page
  // never resumes observing (the ISOLATED side stops too, and the worker no longer tracks a replaced document).
  addListener.call(win, 'pagehide', () => stop());

  if (mode === 'sync' && adapter.discoverFromPage) {
    const discover = () => {
      try {
        const result = adapter.discoverFromPage?.(stream) ?? null;
        if (result === null || !active) return;
        if (result.ok) {
          const batch = result.batch;
          const gen = generation;
          send((n) => ({ channel: BRIDGE_CHANNEL, kind: 'batch', nonce: n, batch, gen }));
        } else {
          const code = 'shapeChanged' in result ? 'shape-changed' : 'projection-refused';
          send((n) => ({ channel: BRIDGE_CHANNEL, kind: 'observer-status', nonce: n, state: 'refused', code }));
        }
      } catch {
        // ignore
      }
    };
    if (document.readyState === 'loading') addListener.call(document, 'DOMContentLoaded', discover, { once: true });
    else discover();
  }

  post({ channel: BRIDGE_CHANNEL, kind: 'main-ready', adapterId: adapter.adapterId });
}
