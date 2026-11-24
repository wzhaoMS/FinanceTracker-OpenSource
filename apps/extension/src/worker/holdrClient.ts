/**
 * The worker's only network path: the Holdr device API at the single origin
 * fixed at build time (plan §3.3, §6), E2c's routes (`apps/api/src/routes/cardSync/`).
 *
 * - Only the listed method/path pairs are callable; anything else is refused
 *   before the network.
 * - Every request names the client (`X-Holdr-Client: extension-v1`) and this
 *   build's version (`X-Holdr-Client-Version`), which Holdr checks against the
 *   version the device was paired with (M1).
 * - No cookies (`credentials: "omit"`), no redirects, no cache, no referrer,
 *   a timeout, and a size cap on every response.
 * - Every response is parsed with an exact-key strict schema; the pairing
 *   redeem response has its own exact parser because it carries the bearer.
 *   Capabilities are taken only from the Holdr this client is pinned to: their
 *   `holdrOrigin` must be exactly its origin (M2). Their parse budget is E2c's
 *   bound on a device answer; every other answer is a control message.
 * - An error answer is Holdr's refusal (`http`, with its code) only in
 *   Holdr's error grammar with a code Holdr gives that status (M5). Any other
 *   JSON error answer is a `protocol` failure, an unknown outcome. One that is
 *   not JSON at all (a page from something in front of Holdr) keeps only its
 *   status.
 * - The observation body is built by concatenation around the frozen
 *   canonical payload text, so the payload bytes sent are byte for byte the
 *   bytes previewed; the envelope is itself canonical (keys `payload` <
 *   `runId`).
 * - Nothing is retried here; the capture flow decides (receipt first, then at
 *   most two bounded retries with the same bytes and idempotency key).
 */
import type { CardSyncIssue, StrictJsonLimits } from '@finance-tracker/shared';
import { parseStrict, parseStrictAny, parseStrictUnion, type ObjectSpec, type Spec } from '../common/strict.js';
import { CLIENT_VERSION_PATTERN } from '../contracts/grammar.js';
import {
  ABORTED,
  CAPABILITIES,
  COMMITTED,
  HOLDR_CAPABILITIES_LIMITS,
  HOLDR_CLIENT_HEADER,
  HOLDR_CLIENT_VERSION_HEADER,
  HOLDR_DEVICE_SCHEME,
  HOLDR_ERROR,
  HOLDR_ERROR_WITH_ISSUES,
  HOLDR_ERROR_WITH_RETRY,
  HOLDR_PAIR_SCHEME,
  HOLDR_ROUTES,
  OBSERVATION_ACCEPTED,
  PLAN_PREPARED,
  RECEIPT,
  RUN_ABORT_REASONS,
  RUN_CREATED,
  holdrErrorStatusFits,
  parseRedeemResponse,
  type Capabilities,
  type CommitRequest,
  type Committed,
  type HoldrErrorCode,
  type HoldrRouteName,
  type ObservationAccepted,
  type PlanPrepared,
  type Receipt,
  type RedeemResponse,
  type RunAbortReason,
  type RunCreated,
  type RunRequest,
} from '../contracts/holdrApi.js';

export type HoldrFailureKind = 'network' | 'timeout' | 'http' | 'protocol' | 'aborted' | 'refused';

export interface HoldrFailure {
  ok: false;
  kind: HoldrFailureKind;
  status: number | null;
  code: HoldrErrorCode | null;
  issues: CardSyncIssue[];
}

export type HoldrResult<T> = { ok: true; value: T; status: number } | HoldrFailure;

export interface HoldrClient {
  readonly origin: string;
  redeem(pairingCode: string, deviceLabel: string, clientVersion: string): Promise<HoldrResult<RedeemResponse>>;
  capabilities(token: string): Promise<HoldrResult<Capabilities>>;
  createRun(token: string, request: RunRequest): Promise<HoldrResult<RunCreated>>;
  submitObservation(token: string, runId: string, canonicalPayload: string, idempotencyKey: string): Promise<HoldrResult<ObservationAccepted>>;
  preparePlan(token: string, runId: string, observationSetId: string): Promise<HoldrResult<PlanPrepared>>;
  commit(token: string, request: CommitRequest): Promise<HoldrResult<Committed>>;
  receipt(token: string, runId: string): Promise<HoldrResult<Receipt>>;
  abort(token: string, runId: string, reason: RunAbortReason): Promise<HoldrResult<{ status: 'aborted' }>>;
}

export interface HoldrClientOptions {
  readonly origin: string;
  readonly requireHttps: boolean;
  readonly timeoutMs: number;
  /** This build's version (`chrome.runtime.getManifest().version`), sent on every request (M1). */
  readonly clientVersion: string;
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  /** Aborts every in-flight request (kill switch). */
  readonly signal?: AbortSignal;
}

const MAX_RESPONSE_BYTES = 256 * 1024;

/** The worker's own fetch, captured at load. */
const workerFetch: (url: string, init: RequestInit) => Promise<Response> = (() => {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  return (url: string, init: RequestInit) => nativeFetch(url, init);
})();

function failure(kind: HoldrFailureKind, status: number | null = null, code: HoldrErrorCode | null = null, issues: CardSyncIssue[] = []): HoldrFailure {
  return { ok: false, kind, status, code, issues };
}

async function readText(response: Response): Promise<string | null> {
  const body = response.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
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
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function createHoldrClient(options: HoldrClientOptions): HoldrClient {
  const origin = new URL(options.origin).origin;
  if (origin !== options.origin) throw new Error('Holdr origin must be an exact origin');
  if (options.requireHttps && !origin.startsWith('https://')) throw new Error('Holdr origin must be HTTPS');
  if (typeof options.clientVersion !== 'string' || !CLIENT_VERSION_PATTERN.test(options.clientVersion)) throw new Error('client version must be major.minor.patch');
  const clientVersion = options.clientVersion;
  const fetchImpl = options.fetchImpl ?? workerFetch;

  async function call<T>(
    route: HoldrRouteName,
    method: 'GET' | 'POST',
    path: string,
    auth: string,
    body: string | null,
    parse: (text: string) => T | null,
    extraHeaders: Array<[string, string]> = [],
  ): Promise<HoldrResult<T>> {
    const allowed = HOLDR_ROUTES.find((item) => item.name === route);
    if (!allowed || allowed.method !== method || !allowed.path.test(path)) return failure('refused');
    if (options.signal?.aborted) return failure('aborted');
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    const headers: Array<[string, string]> = [
      ['Authorization', auth],
      ['X-Holdr-Client', HOLDR_CLIENT_HEADER],
      [HOLDR_CLIENT_VERSION_HEADER, clientVersion],
      ['Accept', 'application/json'],
      ...extraHeaders,
    ];
    if (body !== null) headers.push(['Content-Type', 'application/json']);
    try {
      const response = await fetchImpl(`${origin}${path}`, {
        method,
        headers,
        body: body ?? undefined,
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        mode: 'cors',
        signal: controller.signal,
      });
      if (response.redirected) return failure('protocol', response.status);
      const type = (response.headers.get('content-type') ?? '').toLowerCase();
      const text = await readText(response);
      if (text === null || !/^application\/json(?:;\s*charset=utf-8)?$/.test(type)) {
        return failure(response.ok ? 'protocol' : 'http', response.status);
      }
      if (!response.ok) {
        const answer = holdrError(safeJson(text), response.status);
        // Anything but Holdr's own refusal may hide an effect: a send or commit settles it from the receipt.
        return answer ? failure('http', response.status, answer.code, answer.issues) : failure('protocol', response.status);
      }
      const value = parse(text);
      return value === null ? failure('protocol', response.status) : { ok: true, value, status: response.status };
    } catch {
      if (options.signal?.aborted) return failure('aborted');
      return controller.signal.aborted ? failure('timeout') : failure('network');
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  function safeJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  /** Holdr's refusal: its exact error grammar, with a code Holdr answers with this status (M5); null for anything else. */
  function holdrError(json: unknown, status: number): { code: HoldrErrorCode; issues: CardSyncIssue[] } | null {
    const plain = parseStrict(json, HOLDR_ERROR);
    const retry = plain.ok ? null : parseStrict(json, HOLDR_ERROR_WITH_RETRY);
    const detailed = plain.ok || retry?.ok ? null : parseStrict(json, HOLDR_ERROR_WITH_ISSUES);
    const answer = plain.ok
      ? { code: plain.value.error, issues: [] }
      : retry?.ok
        ? { code: retry.value.error, issues: [] }
        : detailed?.ok
          ? { code: detailed.value.error, issues: detailed.value.issues }
          : null;
    return answer && holdrErrorStatusFits(answer.code, status) ? answer : null;
  }

  function strict<T>(spec: Spec, limits?: Readonly<StrictJsonLimits>): (text: string) => T | null {
    return (text) => {
      const parsed = parseStrictAny(safeJson(text), spec, { limits });
      return parsed.ok ? (parsed.value as T) : null;
    };
  }

  function strictUnion<T>(tagKey: string, variants: Record<string, ObjectSpec>): (text: string) => T | null {
    return (text) => {
      const parsed = parseStrictUnion(safeJson(text), tagKey, variants);
      return parsed.ok ? (parsed.value as T) : null;
    };
  }

  const device = (token: string) => `${HOLDR_DEVICE_SCHEME} ${token}`;

  return {
    origin,
    redeem(pairingCode, deviceLabel, clientVersion) {
      const body = JSON.stringify({ clientVersion, deviceLabel });
      return call('redeem', 'POST', '/card-sync/pairings/redeem', `${HOLDR_PAIR_SCHEME} ${pairingCode}`, body, parseRedeemResponse);
    },
    capabilities(token) {
      const parse = strict<Capabilities>(CAPABILITIES, HOLDR_CAPABILITIES_LIMITS);
      // Only the Holdr this build is pinned to: one that names another origin as its own is not taken at its word.
      return call('capabilities', 'GET', '/card-sync/capabilities', device(token), null, (text) => {
        const value = parse(text);
        return value !== null && value.holdrOrigin === origin ? value : null;
      });
    },
    createRun(token, request) {
      return call('create-run', 'POST', '/card-sync/runs', device(token), JSON.stringify(request), strict<RunCreated>(RUN_CREATED), [['Idempotency-Key', request.clientRunId]]);
    },
    submitObservation(token, runId, canonicalPayload, idempotencyKey) {
      const body = `{"payload":${canonicalPayload},"runId":${JSON.stringify(runId)}}`;
      return call('observations', 'POST', '/card-sync/observations', device(token), body, strict<ObservationAccepted>(OBSERVATION_ACCEPTED), [['Idempotency-Key', idempotencyKey]]);
    },
    preparePlan(token, runId, observationSetId) {
      return call('plan', 'POST', '/card-sync/imports/preview', device(token), JSON.stringify({ runId, observationSetId }), strictUnion<PlanPrepared>('status', PLAN_PREPARED));
    },
    commit(token, request) {
      const body = JSON.stringify({ runId: request.runId, previewId: request.previewId, payloadDigest: request.payloadDigest, planDigest: request.planDigest });
      return call('commit', 'POST', '/card-sync/imports/commit', device(token), body, strict<Committed>(COMMITTED));
    },
    receipt(token, runId) {
      return call('receipt', 'GET', `/card-sync/runs/${runId}/receipt`, device(token), null, strict<Receipt>(RECEIPT));
    },
    abort(token, runId, reason) {
      // Only the fixed reasons leave the browser; anything else is refused before the network.
      if (!(RUN_ABORT_REASONS as readonly string[]).includes(reason)) return Promise.resolve(failure('refused'));
      return call('abort', 'POST', `/card-sync/runs/${runId}/abort`, device(token), JSON.stringify({ reason }), strict<{ status: 'aborted' }>(ABORTED));
    },
  };
}

/** True for failures worth a bounded retry with the same bytes and key: network, timeout, 502, 503. */
export function retryable(result: HoldrFailure): boolean {
  return result.kind === 'network' || result.kind === 'timeout' || (result.kind === 'http' && (result.status === 502 || result.status === 503));
}

/**
 * True when a dispatched request may have taken effect without the extension
 * learning so: a retryable failure, an answer it cannot read (a 2xx whose
 * body breaks the contract, or an error answer that is not Holdr's refusal),
 * Holdr's `authorization-blocked` (D's deadline or fence check can refuse
 * after an effect committed: neither that 409 nor a lost answer proves
 * nothing happened), or a 500 (Holdr may fail while answering, after its
 * transaction). An upload or a commit then asks Holdr for the receipt and
 * never takes the answer as a refusal.
 */
export function unknownOutcome(result: HoldrFailure): boolean {
  return retryable(result) || result.kind === 'protocol' || (result.kind === 'http' && (result.code === 'authorization-blocked' || result.status === 500));
}
