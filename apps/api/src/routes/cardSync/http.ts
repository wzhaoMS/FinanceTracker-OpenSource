import express, { type ErrorRequestHandler, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import {
  CardSyncIssueList, checkExactKeys, isJsonObject, snapshotStrictJson, type CardSyncIssue, type JsonObject, type JsonValue,
} from '@finance-tracker/shared';

import { cardSyncRefusalCode, type CardSyncRefusalCode } from '../../services/cardSync/refusals.js';
import { errorTypeAndCode, HoldrDbError, isCardGuardRefusal } from '../../services/dbErrors.js';

/**
 * HTTP plumbing of the card-sync owner routes (E2a): strict JSON bodies
 * with exact keys, query parameters, and the value-free error answers of
 * E1b design §5.11 in the owner API's shapes (`{error}`, `{error, issues}`,
 * `{error, currentVersion}`, `{error, retryAfterSeconds}`). Nothing here
 * ever puts a submitted or stored value into an answer or a log line.
 */

/** A decision batch (≤ 200 decisions of ≤ ~150 bytes) is the largest owner body; anything bigger is refused unread. */
export const OWNER_BODY_LIMIT_BYTES = 64 * 1024;
export const OWNER_MAX_ISSUES = 20;
/** The fixed answer to a failure that is not the caller's: a set that no longer revalidates, a bug, an unexpected error. */
export const OWNER_FAILURE_CODE = 'internal-error';

export class OwnerHttpError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>, readonly headers: Readonly<Record<string, string>> = {}) {
    super(`card sync owner answer ${status}`);
    this.name = 'OwnerHttpError';
  }
}

export const ownerError = (status: number, code: string) => new OwnerHttpError(status, { error: code });
export const invalidRequest = (issues: readonly CardSyncIssue[]) =>
  new OwnerHttpError(422, { error: 'invalid-request', issues: issues.slice(0, OWNER_MAX_ISSUES).map(({ code, path }) => ({ code, path })) });
export const versionConflict = (currentVersion: number) => new OwnerHttpError(409, { error: 'version-conflict', currentVersion });
export const notFound = () => ownerError(404, 'not-found');

/**
 * §5.11: each repository refusal's status and the code the owner API answers
 * with. `version-conflict`, `review-stale` and `page-stale` reach the client
 * with the set's `currentVersion`, which the routes add (they know the set);
 * this table is their fallback. Device-only codes are listed for
 * completeness: no owner route can meet them.
 */
const OWNER_REFUSALS: Readonly<Record<CardSyncRefusalCode, readonly [number, string]>> = {
  'principal-not-allowed': [403, 'credential-not-allowed'],
  'generation-mismatch': [503, 'authorization-blocked'],
  'version-conflict': [409, 'version-conflict'],
  'invalid-request': [422, 'invalid-request'],
  'page-stale': [409, 'version-conflict'],
  'not-found': [404, 'not-found'],
  'sync-paused': [409, 'sync-paused'],
  'issuer-disabled': [409, 'sync-paused'],
  'main-world-required': [422, 'invalid-request'],
  'policy-invalid': [422, 'invalid-request'],
  'contract-unsupported': [409, 'contract-unsupported'],
  'gate-closed': [409, 'gate-closed'],
  'auto-sync-not-eligible': [409, 'auto-sync-not-eligible'],
  'binding-needs-reconfirmation': [409, 'binding-needs-reconfirmation'],
  'binding-retired': [409, 'binding-retired'],
  'binding-exists': [409, 'binding-exists'],
  'binding-stale': [409, 'binding-stale'],
  'card-account-mismatch': [409, 'card-account-mismatch'],
  'scope-immutable': [422, 'invalid-request'],
  'scope-invalid': [422, 'invalid-request'],
  'pairing-invalid': [401, 'pairing-invalid'],
  'pairing-locked': [429, 'pairing-locked'],
  'pairing-not-redeemed': [409, 'pairing-not-redeemed'],
  'pairing-closed': [409, 'pairing-closed'],
  'pairing-expired': [410, 'pairing-expired'],
  'fingerprint-mismatch': [409, 'fingerprint-mismatch'],
  'device-not-active': [401, 'device-not-active'],
  'credential-format-invalid': [500, OWNER_FAILURE_CODE],
  'run-not-found': [404, 'not-found'],
  'run-closed': [409, 'run-closed'],
  'run-expired': [410, 'run-expired'],
  'idempotency-conflict': [409, 'idempotency-conflict'],
  'payload-invalid': [422, 'payload-invalid'],
  'payload-digest-mismatch': [400, 'payload-digest-mismatch'],
  'scope-not-in-binding': [422, 'scope-not-in-binding'],
  'capture-already-accepted': [409, 'capture-already-accepted'],
  'review-quota-exceeded': [429, 'review-quota-exceeded'],
  'too-many-open-runs': [429, 'too-many-open-runs'],
  'run-rate-limited': [429, 'run-rate-limited'],
  'receipt-expired': [410, 'receipt-expired'],
  'observation-integrity': [500, OWNER_FAILURE_CODE],
  'review-stale': [409, 'version-conflict'],
  'set-closed': [409, 'set-closed'],
  'observation-expired': [410, 'observation-expired'],
  'action-not-allowed': [409, 'action-not-allowed'],
  'decision-conflict': [409, 'action-not-allowed'],
  'adjustment-not-reversible': [409, 'action-not-allowed'],
  'decisions-incomplete': [409, 'decisions-incomplete'],
  'nothing-to-adjust': [409, 'decisions-incomplete'],
  'source-review-required': [409, 'source-review-required'],
  'plan-not-found': [404, 'not-found'],
  'plan-expired': [410, 'plan-expired'],
  'plan-cancelled': [409, 'preview-stale'],
  'preview-stale': [409, 'preview-stale'],
  'plan-mismatch': [409, 'plan-mismatch'],
  'plan-needs-review': [409, 'plan-needs-review'],
  'plan-quota-exceeded': [429, 'plan-quota-exceeded'],
  'transaction-not-found': [404, 'transaction-not-found'],
  'transaction-revision-stale': [409, 'transaction-revision-stale'],
  'removal-not-allowed': [409, 'removal-not-allowed'],
  'restore-not-allowed': [409, 'restore-not-allowed'],
  'merge-not-allowed': [409, 'merge-not-allowed'],
  'cross-card-link-refused': [409, 'cross-card-link-refused'],
  'link-not-reversible': [409, 'link-not-reversible'],
  'identity-last-active': [409, 'action-not-allowed'],
  'repoint-not-allowed': [409, 'action-not-allowed'],
  'change-not-reversible': [409, 'action-not-allowed'],
  'identity-not-active': [409, 'action-not-allowed'],
  'identity-not-found': [404, 'not-found'],
  'payment-link-invalid': [422, 'payment-link-invalid'],
  'payment-link-conflict': [409, 'payment-link-conflict'],
  'payment-link-source-missing': [409, 'payment-link-source-missing'],
};

/** The owner answer to a repository refusal (§5.11). */
export function ownerRefusal(code: CardSyncRefusalCode): { status: number; error: string } {
  const [status, error] = OWNER_REFUSALS[code];
  return { status, error };
}

// ---------------------------------------------------------------------------
// Request bodies: strict JSON, exact keys
// ---------------------------------------------------------------------------

const UTF8 = new TextDecoder('utf-8', { fatal: true });
const BODY_LIMITS = { maxDepth: 4, maxKeysPerObject: 8, maxArrayLength: 200, maxNodes: 2_000, maxStringLength: 128, maxKeyLength: 64,
  maxBytes: OWNER_BODY_LIMIT_BYTES };

/** Reads an owner POST body raw (never through the app-wide parser), JSON only, uncompressed, at most 64 KiB. */
export function ownerBody(): RequestHandler[] {
  // An owner POST takes no query parameter: everything it reads is in its path and body (D11). One is refused as an
  // unknown key, as `readQuery` refuses a GET's, without naming it.
  const noQuery: RequestHandler = (req, _res, next) => {
    if (Object.keys(req.query).length > 0) return next(invalidRequest([{ code: 'unknown-key', path: '$.<key>' }]));
    next();
  };
  const contentType: RequestHandler = (req, _res, next) => {
    if (!req.is('application/json')) return next(ownerError(415, 'unsupported-media-type'));
    const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(req.headers['content-type'] ?? '')?.[1]?.toLowerCase();
    if (charset && charset !== 'utf-8' && charset !== 'utf8') return next(ownerError(415, 'unsupported-media-type'));
    next();
  };
  return [noQuery, contentType, express.raw({ type: () => true, limit: OWNER_BODY_LIMIT_BYTES, inflate: false })];
}

/**
 * The body as a detached strict-JSON object (card detectors on every key
 * and value), or an owner error. Issue paths name only `knownKeys`.
 */
export function jsonObjectBody(req: Request, knownKeys: ReadonlySet<string> = new Set()): JsonObject {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw ownerError(400, 'bad-request');
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8.decode(req.body));
  } catch {
    throw ownerError(400, 'bad-request');
  }
  const snapshot = snapshotStrictJson(parsed, { limits: BODY_LIMITS, maxIssues: OWNER_MAX_ISSUES, knownKeys });
  if (!snapshot.ok) throw invalidRequest(snapshot.issues);
  if (!isJsonObject(snapshot.value)) throw invalidRequest([{ code: 'wrong-type', path: '$' }]);
  return snapshot.value;
}

/** A schema check over a snapshot value: reports its issues and says whether the value passed. */
export type Check = (value: JsonValue | undefined, path: string, issues: CardSyncIssueList) => boolean;

const fail = (issues: CardSyncIssueList, code: CardSyncIssue['code'], path: string): false => {
  issues.add(code, path);
  return false;
};

export const integer = (min: number, max: number): Check => (value, path, issues) => {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fail(issues, 'wrong-type', path);
  return value >= min && value <= max ? true : fail(issues, 'out-of-range', path);
};
export const boolean: Check = (value, path, issues) => (typeof value === 'boolean' ? true : fail(issues, 'wrong-type', path));
export const matching = (pattern: RegExp): Check => (value, path, issues) => {
  if (typeof value !== 'string') return fail(issues, 'wrong-type', path);
  return pattern.test(value) ? true : fail(issues, 'invalid-format', path);
};
export const oneOf = (values: readonly string[]): Check => (value, path, issues) => {
  if (typeof value !== 'string') return fail(issues, 'wrong-type', path);
  return values.includes(value) ? true : fail(issues, 'invalid-enum', path);
};
export const nullable = (check: Check): Check => (value, path, issues) => value === null || check(value, path, issues);
export const arrayOf = (check: Check, min: number, max: number): Check => (value, path, issues) => {
  if (!Array.isArray(value)) return fail(issues, 'wrong-type', path);
  if (value.length > max) return fail(issues, 'too-many-items', path);
  if (value.length < min) return fail(issues, 'out-of-range', path);
  let ok = true;
  value.forEach((entry, index) => { ok = check(entry, `${path}[${index}]`, issues) && ok; });
  return ok;
};
export const object = (shape: Readonly<Record<string, Check>>): Check => (value, path, issues) => {
  if (!isJsonObject(value)) return fail(issues, 'wrong-type', path);
  let ok = checkExactKeys(value, path, Object.keys(shape), issues);
  for (const [key, check] of Object.entries(shape)) {
    if (Object.prototype.hasOwnProperty.call(value, key)) ok = check(value[key], `${path}.${key}`, issues) && ok;
  }
  return ok;
};

/**
 * The body checked against `shape` (exact keys), typed as `T`; a 422 with
 * value-free issues otherwise. `nestedKeys` are the keys of nested objects,
 * so issue paths can name them too.
 */
export function readBody<T>(req: Request, shape: Readonly<Record<string, Check>>, nestedKeys: readonly string[] = []): T {
  const body = jsonObjectBody(req, new Set([...Object.keys(shape), ...nestedKeys]));
  const issues = new CardSyncIssueList(OWNER_MAX_ISSUES);
  if (!object(shape)(body, '$', issues)) throw invalidRequest(issues.list);
  return body as unknown as T;
}

// ---------------------------------------------------------------------------
// Query parameters and path ids
// ---------------------------------------------------------------------------

/**
 * The query parameters an owner GET may carry, each a single string; any
 * other parameter, a repeated one or a structured one is a 422 naming it.
 */
export function readQuery<K extends string>(req: Request, allowed: readonly K[]): Partial<Record<K, string>> {
  const issues = new CardSyncIssueList(OWNER_MAX_ISSUES);
  const known = new Set<string>(allowed);
  const out: Partial<Record<K, string>> = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (!known.has(key)) {
      issues.add('unknown-key', '$.<key>');
      continue;
    }
    if (typeof value !== 'string') {
      issues.add('wrong-type', `$.${key}`);
      continue;
    }
    out[key as K] = value;
  }
  if (issues.size > 0) throw invalidRequest(issues.list);
  return out;
}

/** A refused cursor (§10 item 20): 422 `invalid-request` naming the parameter, so the client starts its walk over. */
export const refusedCursor = (param: string) => invalidRequest([{ code: 'invalid-format', path: `$.${param}` }]);

/** A path id in its grammar, or 404: a malformed id can name nothing. */
export function pathId(req: Request, name: string, pattern: RegExp): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !pattern.test(value)) throw notFound();
  return value;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const SQLITE_BUSY = /^SQLITE_(?:BUSY|LOCKED)/;

/**
 * Value-free error answers for every `/card-sync` path, installed after its
 * routers so their errors end here and never reach the app's handler: fixed
 * codes, never a message; the log gets only the error's type and code, or a
 * refusal code that means the server, not the caller, is at fault.
 */
export function cardSyncErrors(log: (line: string) => void): ErrorRequestHandler {
  return (error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      log(`[card-sync] ${req.method} request failed after its answer started: ${errorTypeAndCode(error)}`);
      req.socket.destroy();
      return;
    }
    const send = (status: number, body: Record<string, unknown>, headers: Readonly<Record<string, string>> = {}) => {
      res.setHeader('Cache-Control', 'no-store');
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
      res.status(status).json(body);
    };
    if (error instanceof OwnerHttpError) return send(error.status, error.body, error.headers);
    const code = cardSyncRefusalCode(error);
    if (code !== undefined) {
      const { status, error: answer } = ownerRefusal(code);
      if (status >= 500 && status !== 503) {
        log(`[card-sync] ${req.method} request refused: ${code}`);
        return send(500, { error: OWNER_FAILURE_CODE });
      }
      return send(status, answer === 'invalid-request' ? { error: answer, issues: [] } : { error: answer });
    }
    if (isCardGuardRefusal(error)) {
      log('[card-sync] the card guards refused an owner write that passed every check; nothing was written');
      return send(422, { error: 'invalid-request', issues: [{ code: 'card-data', path: '$' }] });
    }
    if (error instanceof HoldrDbError && SQLITE_BUSY.test(error.code)) {
      return send(503, { error: 'unavailable', retryAfterSeconds: 1 }, { 'Retry-After': '1' });
    }
    const type = (error as { type?: unknown } | null)?.type;
    if (type === 'entity.too.large') return send(413, { error: 'too-large' });
    if (type === 'encoding.unsupported' || type === 'charset.unsupported') return send(415, { error: 'unsupported-media-type' });
    if (typeof type === 'string' || error instanceof URIError) return send(400, { error: 'bad-request' });
    log(`[card-sync] ${req.method} request failed: ${errorTypeAndCode(error)}`);
    send(500, { error: OWNER_FAILURE_CODE });
  };
}
