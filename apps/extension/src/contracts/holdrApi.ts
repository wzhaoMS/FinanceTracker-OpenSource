/**
 * The Holdr device API: E2c's eight routes (`apps/api/src/routes/cardSync/`),
 * with E3's original proposal (review, part b) aligned to them (E2c M1–M7).
 * The worker talks to Holdr only through `HoldrClient`
 * (worker/holdrClient.ts). The test-only fake Holdr parses requests with the
 * same schemas and answers as E2c does, so both sides stay in step; the
 * acceptance suite runs this client against E2c itself.
 *
 * Every response is strict JSON with exact keys, ISO timestamps and
 * letter-only ids and digests. The one exception is the pairing redeem
 * response, which must carry the bearer under a key the strict policy
 * refuses by design: it has its own exact parser and never enters a message.
 */
import { CARD_SYNC_V2_MAX_ROWS, isCardSyncDeviceToken, isCardSyncId, isCardSyncTimestamp, type StrictJsonLimits } from '@finance-tracker/shared';
import { S, SMALL_MESSAGE_LIMITS, type Infer } from '../common/strict.js';
import {
  CLIENT_VERSION,
  DEVICE_LABEL,
  ISSUE,
  ISSUER,
  LABEL_TEXT,
  LAST4,
  ORIGIN,
  PARSER_VERSION,
  PAYLOAD_DIGEST,
  PLAN_DIGEST,
  SOURCE,
  TIMESTAMP,
  contractId,
} from './grammar.js';
import { PAYLOAD_V2 } from './messages.js';

export const HOLDR_CLIENT_HEADER = 'extension-v1';
/** Sent on every request with this build's version: Holdr refuses (401) a version other than the one the device was paired with (M1). */
export const HOLDR_CLIENT_VERSION_HEADER = 'X-Holdr-Client-Version';
export const HOLDR_PAIR_SCHEME = 'HoldrPair';
export const HOLDR_DEVICE_SCHEME = 'HoldrDevice';
/** Non-secret confirmation code shown in the popup and in Holdr: four groups of four letters. */
export const DEVICE_FINGERPRINT = /^[a-p]{4}-[a-p]{4}-[a-p]{4}-[a-p]{4}$/;

/** Exactly the method and path pairs the worker may call; anything else is refused before any network use. */
export const HOLDR_ROUTES = Object.freeze([
  { name: 'redeem', method: 'POST', path: /^\/card-sync\/pairings\/redeem$/ },
  { name: 'capabilities', method: 'GET', path: /^\/card-sync\/capabilities$/ },
  { name: 'create-run', method: 'POST', path: /^\/card-sync\/runs$/ },
  { name: 'observations', method: 'POST', path: /^\/card-sync\/observations$/ },
  { name: 'plan', method: 'POST', path: /^\/card-sync\/imports\/preview$/ },
  { name: 'commit', method: 'POST', path: /^\/card-sync\/imports\/commit$/ },
  { name: 'receipt', method: 'GET', path: /^\/card-sync\/runs\/run_[a-p]{32}\/receipt$/ },
  { name: 'abort', method: 'POST', path: /^\/card-sync\/runs\/run_[a-p]{32}\/abort$/ },
] as const);

export type HoldrRouteName = (typeof HOLDR_ROUTES)[number]['name'];

/**
 * Every error code Holdr's device routes answer, with the status each comes
 * with (M5): E2c's own (`deviceProtocol.ts`, `deviceResponses.ts` and the
 * repository refusals it maps), and D's device admission (E0-I PR D:
 * `authorization-blocked`, `ingress-unverified`, `ingress-refused`,
 * `device-transport-refused`). An error answer is Holdr's refusal only in
 * Holdr's error grammar, with a code Holdr gives that status
 * (`holdrErrorStatusFits`); the capture flow then handles each code on its
 * own, never folding one into another. Any other JSON error answer is a
 * protocol error, which a send or commit settles from the receipt.
 */
export const HOLDR_ERROR_STATUS = Object.freeze({
  'bad-request': 400,
  'payload-digest-mismatch': 400,
  unauthorized: 401,
  'pairing-invalid': 401,
  'device-not-active': 401,
  'device-pending': 403,
  'credential-not-allowed': 403,
  'device-transport-refused': 403,
  'not-found': 404,
  'run-not-found': 404,
  'idempotency-conflict': 409,
  'sync-paused': 409,
  'sync-disabled': 409,
  'binding-stale': 409,
  'binding-needs-reconfirmation': 409,
  'binding-retired': 409,
  'capture-already-accepted': 409,
  'run-closed': 409,
  'set-closed': 409,
  'preview-stale': 409,
  'plan-mismatch': 409,
  'plan-needs-review': 409,
  'authorization-blocked': 409,
  'run-expired': 410,
  'observation-expired': 410,
  'plan-expired': 410,
  'too-large': 413,
  'unsupported-media-type': 415,
  'payload-invalid': 422,
  'contract-unsupported': 422,
  'scope-not-in-binding': 422,
  'pairing-locked': 429,
  'rate-limited': 429,
  'review-quota-exceeded': 429,
  'too-many-open-runs': 429,
  'run-rate-limited': 429,
  'plan-quota-exceeded': 429,
  'internal-error': 500,
  unavailable: 503,
  'ingress-unverified': 503,
  'ingress-refused': 503,
} as const);
export type HoldrErrorCode = keyof typeof HOLDR_ERROR_STATUS;
export const HOLDR_ERROR_CODES = Object.freeze(Object.keys(HOLDR_ERROR_STATUS) as HoldrErrorCode[]);

/** The other statuses E2c gives a code: `bad-request` is also 408 (a body that stalls, `deviceBody.ts`) and 422 (an abort reason off the enum, `deviceProtocol.ts`). */
export const HOLDR_ERROR_OTHER_STATUSES: Readonly<Partial<Record<HoldrErrorCode, readonly number[]>>> = Object.freeze({
  'bad-request': Object.freeze([408, 422]),
});

/** Whether Holdr answers `code` with `status`. */
export function holdrErrorStatusFits(code: HoldrErrorCode, status: number): boolean {
  return HOLDR_ERROR_STATUS[code] === status || (HOLDR_ERROR_OTHER_STATUSES[code]?.includes(status) ?? false);
}

/**
 * The parse budget for capabilities, E2c's bound on every device answer
 * (`DEVICE_RESPONSE_BYTES` and the node limit in `deviceResponses.ts`):
 * 20 bindings of 40 scopes and 39 card hints each come to more than 100 KB,
 * past the 64 KiB of a control message. Every other answer keeps the
 * control-message budget.
 */
export const HOLDR_CAPABILITIES_LIMITS: Readonly<StrictJsonLimits> = Object.freeze({ ...SMALL_MESSAGE_LIMITS, maxBytes: 256 * 1024, maxNodes: 10_000 });

/**
 * Why the extension aborts a run (Casey Mac's answer to E8-M Q4, 10/17
 * 04:50): a fixed enum, so Holdr's 「发送结果待核对」 can name the cause; Holdr
 * answers any other value with 422 `bad-request`. E3 sends `site-permission-revoked`,
 * `unknown-page-structure` and `user-cancelled`; in E3 a run is created only
 * when the user sends a frozen preview, after every bank read, so
 * `not-signed-in` cannot follow one yet, and a browser's fetch does not tell
 * a certificate error from other network failures.
 */
export const RUN_ABORT_REASONS = ['site-permission-revoked', 'not-signed-in', 'unknown-page-structure', 'certificate-error', 'user-cancelled'] as const;
export type RunAbortReason = (typeof RUN_ABORT_REASONS)[number];

// ---------------------------------------------------------------------------
// Requests (built by the worker; parsed by the fake Holdr)
// ---------------------------------------------------------------------------

export const REDEEM_REQUEST = S.object({ clientVersion: CLIENT_VERSION, deviceLabel: DEVICE_LABEL });

export const RUN_REQUEST = S.object({
  clientRunId: contractId('clientRun'),
  bindingId: contractId('binding'),
  bindingVersion: S.int(1, 2_147_483_647),
  adapterVersion: PARSER_VERSION,
  contractVersion: S.int(1, 99),
  trigger: S.const('manual'),
});

export const OBSERVATION_REQUEST = S.object({ payload: PAYLOAD_V2, runId: contractId('run') });
export const PLAN_REQUEST = S.object({ runId: contractId('run'), observationSetId: contractId('observationSet') });
export const ABORT_REQUEST = S.object({ reason: S.enum(RUN_ABORT_REASONS) });
export const COMMIT_REQUEST = S.object({
  runId: contractId('run'),
  previewId: contractId('preview'),
  payloadDigest: PAYLOAD_DIGEST,
  planDigest: PLAN_DIGEST,
});

export type RunRequest = Infer<typeof RUN_REQUEST>;
export type CommitRequest = Infer<typeof COMMIT_REQUEST>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const SCOPE = S.object({
  cardScopeId: contractId('cardScope'),
  scopeLabel: LABEL_TEXT,
  last4: S.nullable(LAST4),
  holderUnknown: S.bool(),
});

/**
 * A binding as this device may use it. A binding holds at most 39 known
 * scopes and its holder-unknown one, so at most 39 last-four hints (M4);
 * Holdr lists every one. A payload carries at most 20 of them (E1a), so a
 * capture of a binding with more is refused when it is built, naming the
 * limit.
 */
export const BINDING = S.object({
  bindingId: contractId('binding'),
  bindingVersion: S.int(1, 2_147_483_647),
  issuer: ISSUER,
  source: SOURCE,
  bindingLabel: LABEL_TEXT,
  cards: S.array(LAST4, 39),
  scopes: S.array(SCOPE, 40),
});

export const CAPABILITIES = S.object({
  status: S.enum(['pending', 'active'] as const),
  deviceId: contractId('device'),
  deviceLabel: DEVICE_LABEL,
  /** When the device credential stops working (any key containing "token" is refused by the strict key policy). */
  deviceExpiresAt: TIMESTAMP,
  /** Holdr's own configured HTTPS origin (E0-I §6.7, M2): the client takes capabilities only from the origin it is pinned to. */
  holdrOrigin: ORIGIN,
  syncEnabled: S.bool(),
  payloadVersions: S.array(S.int(1, 99), 4),
  contractVersions: S.array(S.int(1, 99), 4),
  maxPayloadBytes: S.int(1, 2 * 1024 * 1024),
  maxRows: S.int(1, CARD_SYNC_V2_MAX_ROWS),
  issuers: S.array(S.object({ issuer: ISSUER, enabled: S.bool() }), 4),
  bindings: S.array(BINDING, 20),
});

export const RUN_CREATED = S.object({ runId: contractId('run'), expiresAt: TIMESTAMP });

/**
 * An upload's acknowledgement. A replay of an accepted upload (the same run,
 * key and bytes) answers the set as it is now (E2c §5.4, M7): `committed`,
 * `rejected` and `expired-unreviewed` are final, like the same receipt.
 */
export const OBSERVATION_STATUSES = ['accepted-uncommitted', 'needs-review', 'committed', 'rejected', 'expired-unreviewed'] as const;
export const OBSERVATION_ACCEPTED = S.object({
  observationSetId: contractId('observationSet'),
  runId: contractId('run'),
  payloadDigest: PAYLOAD_DIGEST,
  status: S.enum(OBSERVATION_STATUSES),
  acceptedAt: TIMESTAMP,
  expiresAt: TIMESTAMP,
});

/**
 * What a plan would do: the owner API's `PlanCounts` (E1b revision 8 §5.6,
 * X37), eleven tallies; `aliased` counts actions that keep a row's values and
 * attach the observation's ids to it as aliases. Keys are exact both ways: a
 * missing or an unknown tally is a protocol failure.
 */
const PLAN_COUNT = S.int(0, 10_000);
export const PLAN_COUNTS = S.object({
  insert: PLAN_COUNT,
  update: PLAN_COUNT,
  unchanged: PLAN_COUNT,
  aliased: PLAN_COUNT,
  matched: PLAN_COUNT,
  attributed: PLAN_COUNT,
  promoted: PLAN_COUNT,
  corrected: PLAN_COUNT,
  rejected: PLAN_COUNT,
  unmatched: PLAN_COUNT,
  superseded: PLAN_COUNT,
});

/**
 * A device's prepare (E1b revision 3, X24/Q38): a strict union on `status`.
 * `executable` is a stored plan this device may commit. `owner-review` means
 * the owner decides in Holdr: the counts and the number of open review items,
 * and no `previewId` key at all (Holdr never makes one up). With contract 1's
 * admissions all closed, every first sync gets `owner-review`.
 */
export const PLAN_PREPARED = {
  executable: S.object({
    status: S.const('executable'),
    previewId: contractId('preview'),
    payloadDigest: PAYLOAD_DIGEST,
    planDigest: PLAN_DIGEST,
    expiresAt: TIMESTAMP,
    counts: PLAN_COUNTS,
  }),
  'owner-review': S.object({
    status: S.const('owner-review'),
    observationSetId: contractId('observationSet'),
    counts: PLAN_COUNTS,
    reviewCount: PLAN_COUNT,
  }),
} as const;

export const COMMITTED = S.object({
  status: S.const('committed'),
  committedAt: TIMESTAMP,
  inserted: S.int(0, CARD_SYNC_V2_MAX_ROWS),
  updated: S.int(0, CARD_SYNC_V2_MAX_ROWS),
});

/**
 * What Holdr has for a run (X13, E1b §9): devices see Holdr's blocked and
 * recovery reviews as `needs-review` (only the owner API shows those
 * states), and `rejected` when the owner discarded the set. A rejected or
 * expired set is final: the extension never sends it again.
 */
export const RECEIPT = S.object({
  runId: contractId('run'),
  observationSetId: S.nullable(contractId('observationSet')),
  acceptance: S.enum(['none', 'accepted-uncommitted', 'needs-review', 'expired-unreviewed', 'rejected'] as const),
  ledger: S.enum(['none', 'committed'] as const),
  payloadDigest: S.nullable(PAYLOAD_DIGEST),
  acceptedAt: S.nullable(TIMESTAMP),
  expiresAt: S.nullable(TIMESTAMP),
});

export const ABORTED = S.object({ status: S.const('aborted') });

/**
 * Error bodies (E2c `deviceError`, D's `sendRefusal`): `{"error": code}`;
 * with a payload or request refusal also the value-free validation issues
 * (at most 20); with a temporary `unavailable` also `retryAfterSeconds`.
 */
export const HOLDR_ERROR = S.object({ error: S.enum(HOLDR_ERROR_CODES) });
export const HOLDR_ERROR_WITH_ISSUES = S.object({ error: S.enum(HOLDR_ERROR_CODES), issues: S.array(ISSUE, 20) });
export const HOLDR_ERROR_WITH_RETRY = S.object({ error: S.enum(HOLDR_ERROR_CODES), retryAfterSeconds: S.int(1, 86_400) });

export type Capabilities = Infer<typeof CAPABILITIES>;
export type Binding = Infer<typeof BINDING>;
export type BindingScope = Infer<typeof SCOPE>;
export type RunCreated = Infer<typeof RUN_CREATED>;
export type ObservationAccepted = Infer<typeof OBSERVATION_ACCEPTED>;
export type PlanCounts = Infer<typeof PLAN_COUNTS>;
export type PlanExecutable = Infer<(typeof PLAN_PREPARED)['executable']>;
export type PlanOwnerReview = Infer<(typeof PLAN_PREPARED)['owner-review']>;
export type PlanPrepared = PlanExecutable | PlanOwnerReview;
export type Committed = Infer<typeof COMMITTED>;
export type Receipt = Infer<typeof RECEIPT>;
export type HoldrError = Infer<typeof HOLDR_ERROR>;

export interface RedeemResponse {
  deviceId: string;
  deviceToken: string;
  fingerprint: string;
  status: 'pending';
  pendingExpiresAt: string;
}

const REDEEM_KEYS = ['deviceId', 'deviceToken', 'fingerprint', 'pendingExpiresAt', 'status'];

/**
 * The redeem response, read by its own exact parser (contract section 15a):
 * a plain object with exactly these five string fields, each in its grammar
 * (`isCardSyncId('device', …)`, `isCardSyncDeviceToken`). The bearer is
 * returned to the worker and nowhere else.
 */
export function parseRedeemResponse(text: string): RedeemResponse | null {
  if (typeof text !== 'string' || text.length > 1_024) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== REDEEM_KEYS.length || keys.some((key, index) => key !== REDEEM_KEYS[index])) return null;
  const record = value as Record<string, unknown>;
  const deviceId = record.deviceId;
  const deviceToken = record.deviceToken;
  const fingerprint = record.fingerprint;
  const status = record.status;
  const pendingExpiresAt = record.pendingExpiresAt;
  if (!isCardSyncId('device', deviceId)) return null;
  if (!isCardSyncDeviceToken(deviceToken)) return null;
  if (typeof fingerprint !== 'string' || !DEVICE_FINGERPRINT.test(fingerprint)) return null;
  if (status !== 'pending') return null;
  if (typeof pendingExpiresAt !== 'string' || !isCardSyncTimestamp(pendingExpiresAt)) return null;
  return { deviceId, deviceToken, fingerprint, status, pendingExpiresAt };
}
