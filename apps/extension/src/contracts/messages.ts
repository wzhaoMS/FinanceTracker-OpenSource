/**
 * The extension's internal messages (plan §4.1), each an exact-key schema
 * validated on both sides of its hop. Data never becomes permission: no
 * message carries a URL, a header, a token, an issuer account id or code.
 *
 * - Bridge (window.postMessage, same document): MAIN observer ↔ ISOLATED
 *   collector. MAIN may send batches, shape reports and its status; ISOLATED
 *   may send only `hello` (the document nonce) and `stop`. A nonce stops
 *   misdelivery, not a malicious page script (plan §4.1); ISOLATED
 *   re-validates everything.
 * - Collector (chrome.runtime.sendMessage): ISOLATED → worker. The worker
 *   identifies the document from `runtime.sender`, never from the message.
 * - Worker → collector (chrome.tabs.sendMessage to one documentId): config
 *   and stop only.
 * - UI (`ui-command/v1`): popup/options → worker, accepted only from the
 *   extension's own pages.
 */
import {
  CARD_SYNC_V2_KNOWN_KEYS,
  PROJECTED_BATCH_KNOWN_KEYS,
  validateCardSyncPayloadV2,
  validateProjectedBankBatch,
  type CardSyncPayloadV2,
  type JsonValue,
  type ProjectedBankBatchV1,
} from '@finance-tracker/shared';
import { S, type EmbedResult, type Infer } from '../common/strict.js';
import {
  ADAPTER,
  COMPLETENESS,
  DATE,
  DEVICE_LABEL,
  HINT_TEXT,
  ISSUE,
  ISSUER,
  LAST4,
  PAIRING_CODE,
  PAYLOAD_DIGEST,
  PLAN_DIGEST,
  TERMINATION,
  contractId,
  localId,
} from './grammar.js';
import { SHAPE_REPORT } from './shapeReport.js';

function embedProjectedBatch(value: JsonValue): EmbedResult<ProjectedBankBatchV1> {
  const result = validateProjectedBankBatch(value);
  return result.ok ? { ok: true, value: result.batch } : { ok: false, issues: result.issues };
}

function embedPayloadV2(value: JsonValue): EmbedResult<CardSyncPayloadV2> {
  const result = validateCardSyncPayloadV2(value);
  return result.ok ? { ok: true, value: result.payload } : { ok: false, issues: result.issues };
}

export const PROJECTED_BATCH = S.embed(PROJECTED_BATCH_KNOWN_KEYS, embedProjectedBatch);
export const PAYLOAD_V2 = S.embed(CARD_SYNC_V2_KNOWN_KEYS, embedPayloadV2);

// ---------------------------------------------------------------------------
// Bridge: MAIN observer ↔ ISOLATED collector
// ---------------------------------------------------------------------------

export const BRIDGE_CHANNEL = 'holdr-bridge/v1';
const CHANNEL = S.const(BRIDGE_CHANNEL);
const NONCE = localId('nonce');

export const OBSERVER_STATES = ['observing', 'stopped', 'refused'] as const;
export const OBSERVER_CODES = ['projection-refused', 'shape-changed', 'response-too-large', 'unexpected-response', 'buffer-full'] as const;

export const BRIDGE_FROM_MAIN = {
  'main-ready': S.object({ channel: CHANNEL, kind: S.const('main-ready'), adapterId: ADAPTER }),
  batch: S.object({ channel: CHANNEL, kind: S.const('batch'), nonce: NONCE, batch: PROJECTED_BATCH, gen: S.int(0, Number.MAX_SAFE_INTEGER) }),
  'observer-status': S.object({
    channel: CHANNEL,
    kind: S.const('observer-status'),
    nonce: NONCE,
    state: S.enum(OBSERVER_STATES),
    code: S.nullable(S.enum(OBSERVER_CODES)),
  }),
  shape: S.object({ channel: CHANNEL, kind: S.const('shape'), nonce: NONCE, report: SHAPE_REPORT }),
} as const;

export const BRIDGE_FROM_ISOLATED = {
  hello: S.object({ channel: CHANNEL, kind: S.const('hello'), nonce: NONCE }),
  stop: S.object({ channel: CHANNEL, kind: S.const('stop'), nonce: NONCE }),
  /** The page's sign-in ended (the collector reset for a sign-out, and counts it): the observer counts it too and starts a new stream. */
  reset: S.object({ channel: CHANNEL, kind: S.const('reset'), nonce: NONCE }),
} as const;

export type BridgeFromMain = { [K in keyof typeof BRIDGE_FROM_MAIN]: Infer<(typeof BRIDGE_FROM_MAIN)[K]> }[keyof typeof BRIDGE_FROM_MAIN];
export type BridgeFromIsolated = { [K in keyof typeof BRIDGE_FROM_ISOLATED]: Infer<(typeof BRIDGE_FROM_ISOLATED)[K]> }[keyof typeof BRIDGE_FROM_ISOLATED];

// ---------------------------------------------------------------------------
// Collector (ISOLATED) → worker
// ---------------------------------------------------------------------------

export const PAGE_STATES = ['activity', 'other', 'auth-required'] as const;
export type PageState = (typeof PAGE_STATES)[number];

export const COLLECTOR_STATES = ['waiting', 'discovering', 'reading', 'observing', 'ready', 'building', 'stopped', 'error'] as const;
export type CollectorState = (typeof COLLECTOR_STATES)[number];

/** Fixed, value-free codes a collector reports. */
export const COLLECTOR_CODES = [
  'auth-required',
  'rate-limited',
  'read-failed',
  'read-cap',
  'repeated-cursor',
  'empty-page',
  'unexpected-response',
  /** A required field is missing, a type changed or an enum value is unknown: the adapter's contract pauses (plan 4, 10). */
  'shape-changed',
  'too-large',
  /** More of the page's answers arrived while it counted as signed out than the collector holds: nothing is built until it starts afresh. */
  'answers-lost',
  'timeout',
  'identity-conflict',
  'stale-stream',
  'payload-refused',
  'unmapped-rows',
  'no-rows',
  'unknown-account',
  'bridge-refused',
  'projection-refused',
  'navigation',
  'stopped',
  'busy',
  'bad-config',
] as const;
export type CollectorCode = (typeof COLLECTOR_CODES)[number];

/** The longest Retry-After a site can impose on an issuer: a day. */
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;

/** A site's Retry-After as a collector status carries it: whole milliseconds, 0 to a day; nothing for no or a broken value. */
export function statusRetryAfter(ms: number | null | undefined): number | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  return Math.min(Math.max(0, Math.round(ms)), MAX_RETRY_AFTER_MS);
}

const MESSAGE_SEQ = S.int(0, 1_000_000);

export const GROUP_SUMMARY = S.object({
  holderRef: S.nullable(contractId('holderGroup')),
  cardLast4: S.nullable(LAST4),
  pending: S.int(0, 2_000),
  posted: S.int(0, 2_000),
  firstDate: DATE,
  lastDate: DATE,
});

export const ACCOUNT_SUMMARY = S.object({
  ref: contractId('accountCandidate'),
  last4: S.nullable(LAST4),
  productHint: S.nullable(HINT_TEXT),
  pending: S.int(0, 2_000),
  posted: S.int(0, 2_000),
  rejected: S.int(0, 2_000),
  pageCount: S.int(0, 100),
  termination: S.nullable(TERMINATION),
  completeness: S.nullable(COMPLETENESS),
  groups: S.array(GROUP_SUMMARY, 60),
});

export type GroupSummary = Infer<typeof GROUP_SUMMARY>;
export type AccountSummary = Infer<typeof ACCOUNT_SUMMARY>;

export const COLLECTOR_ROLES = ['collector', 'shape'] as const;
/** What a page's content script is: the issuer's collector, or shape mode's relay. Declared in its first message. */
export type CollectorRole = (typeof COLLECTOR_ROLES)[number];

export const COLLECTOR_MESSAGES = {
  'collector-ready/v1': S.object({
    type: S.const('collector-ready/v1'),
    adapterId: ADAPTER,
    seq: MESSAGE_SEQ,
    role: S.enum(COLLECTOR_ROLES),
    streamHandle: contractId('stream'),
    pageState: S.enum(PAGE_STATES),
  }),
  'collector-status/v1': S.object({
    type: S.const('collector-status/v1'),
    adapterId: ADAPTER,
    seq: MESSAGE_SEQ,
    streamHandle: contractId('stream'),
    pageState: S.enum(PAGE_STATES),
    state: S.enum(COLLECTOR_STATES),
    code: S.nullable(S.enum(COLLECTOR_CODES)),
    accounts: S.array(ACCOUNT_SUMMARY, 20),
    issues: S.array(ISSUE, 20),
    /** With `rate-limited`: the site's Retry-After, so the worker pauses the issuer at least that long. */
    retryAfterMs: S.nullable(S.int(0, MAX_RETRY_AFTER_MS)),
  }),
  'collector-batch/v1': S.object({
    type: S.const('collector-batch/v1'),
    adapterId: ADAPTER,
    seq: MESSAGE_SEQ,
    streamHandle: contractId('stream'),
    captureId: contractId('capture'),
    payload: PAYLOAD_V2,
  }),
  'collector-shape/v1': S.object({
    type: S.const('collector-shape/v1'),
    adapterId: ADAPTER,
    seq: MESSAGE_SEQ,
    report: SHAPE_REPORT,
  }),
} as const;

export type CollectorMessage = { [K in keyof typeof COLLECTOR_MESSAGES]: Infer<(typeof COLLECTOR_MESSAGES)[K]> }[keyof typeof COLLECTOR_MESSAGES];

// ---------------------------------------------------------------------------
// Worker → collector
// ---------------------------------------------------------------------------

export const COLLECTOR_ACTIONS = ['discover', 'read', 'build', 'release'] as const;
export const STOP_REASONS = ['kill-switch', 'issuer-paused', 'permission-revoked', 'consent-changed', 'superseded', 'shape-mode'] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export const BUDGET = S.object({
  maxPages: S.int(1, 100),
  maxRequests: S.int(1, 100),
  requestTimeoutMs: S.int(100, 60_000),
  requestIntervalMs: S.int(0, 60_000),
  /** What is left of the issuer's request spacing after its previous read (any tab): the first request waits this long. */
  startDelayMs: S.int(0, 60_000),
  runLimitMs: S.int(1_000, 600_000),
  maxResponseBytes: S.int(1_024, 2 * 1024 * 1024),
});
export type Budget = Infer<typeof BUDGET>;

export const SCOPE_ENTRY = S.object({
  holderRef: S.nullable(contractId('holderGroup')),
  cardLast4: S.nullable(LAST4),
  cardScopeId: contractId('cardScope'),
});
export type ScopeEntry = Infer<typeof SCOPE_ENTRY>;

export const WORKER_TO_COLLECTOR = {
  'collector-config/v1': S.object({
    type: S.const('collector-config/v1'),
    action: S.enum(COLLECTOR_ACTIONS),
    captureId: S.nullable(contractId('capture')),
    accountRef: S.nullable(contractId('accountCandidate')),
    bindingId: S.nullable(contractId('binding')),
    bindingVersion: S.nullable(S.int(1, 2_147_483_647)),
    scopes: S.array(SCOPE_ENTRY, 60),
    /**
     * Every confirmed scope of the bound account (E1a §10a: coverage covers each, rows or not); the row map is `scopes`.
     * As many as a binding may hold, with their last fours in `cards`: a payload too large for them (more than 40
     * coverage entries or 20 card hints) is refused by the v2 builder, naming the limit.
     */
    confirmedScopes: S.array(contractId('cardScope'), 40),
    cards: S.array(LAST4, 40),
    window: S.nullable(S.object({ start: DATE, end: DATE })),
    budget: S.nullable(BUDGET),
  }),
  'collector-stop/v1': S.object({
    type: S.const('collector-stop/v1'),
    reason: S.enum(STOP_REASONS),
  }),
} as const;

export type CollectorConfig = Infer<(typeof WORKER_TO_COLLECTOR)['collector-config/v1']>;
export type CollectorStop = Infer<(typeof WORKER_TO_COLLECTOR)['collector-stop/v1']>;

export const COLLECTOR_REPLY = S.object({ ok: S.bool(), code: S.nullable(S.enum(COLLECTOR_CODES)) });
export type CollectorReply = Infer<typeof COLLECTOR_REPLY>;

// ---------------------------------------------------------------------------
// Trusted UI (popup, options) → worker
// ---------------------------------------------------------------------------

const UI = S.const('ui-command/v1');
const command = <C extends string>(name: C) => S.const(name);

export const UI_COMMANDS = {
  'get-state': S.object({ type: UI, command: command('get-state') }),
  pair: S.object({ type: UI, command: command('pair'), pairingCode: PAIRING_CODE, deviceLabel: DEVICE_LABEL }),
  'refresh-device': S.object({ type: UI, command: command('refresh-device') }),
  'forget-device': S.object({ type: UI, command: command('forget-device') }),
  'set-trust-browser': S.object({ type: UI, command: command('set-trust-browser'), on: S.bool() }),
  'enable-issuer': S.object({
    type: UI,
    command: command('enable-issuer'),
    adapterId: ADAPTER,
    riskAccepted: S.const(true),
    mainPassiveAccepted: S.bool(),
  }),
  'disable-issuer': S.object({ type: UI, command: command('disable-issuer'), adapterId: ADAPTER }),
  'set-paused': S.object({ type: UI, command: command('set-paused'), on: S.bool() }),
  read: S.object({ type: UI, command: command('read'), docRef: localId('document'), accountRef: contractId('accountCandidate') }),
  prepare: S.object({
    type: UI,
    command: command('prepare'),
    docRef: localId('document'),
    accountRef: contractId('accountCandidate'),
    bindingId: contractId('binding'),
    scopes: S.array(SCOPE_ENTRY, 60),
  }),
  send: S.object({ type: UI, command: command('send'), captureId: contractId('capture'), digest: PAYLOAD_DIGEST }),
  discard: S.object({ type: UI, command: command('discard'), captureId: contractId('capture') }),
  'check-receipt': S.object({ type: UI, command: command('check-receipt'), captureId: contractId('capture') }),
  plan: S.object({ type: UI, command: command('plan'), captureId: contractId('capture') }),
  commit: S.object({
    type: UI,
    command: command('commit'),
    captureId: contractId('capture'),
    previewId: contractId('preview'),
    planDigest: PLAN_DIGEST,
  }),
  'shape-start': S.object({ type: UI, command: command('shape-start'), adapterId: ADAPTER, mainPassiveAccepted: S.const(true) }),
  'shape-stop': S.object({ type: UI, command: command('shape-stop') }),
  'open-holdr': S.object({ type: UI, command: command('open-holdr') }),
} as const;

export type UiCommand = { [K in keyof typeof UI_COMMANDS]: Infer<(typeof UI_COMMANDS)[K]> }[keyof typeof UI_COMMANDS];
export type UiCommandName = keyof typeof UI_COMMANDS;

/** Fixed, value-free reasons a UI command is refused. */
export const UI_ERROR_CODES = [
  'invalid-command',
  'not-trusted-sender',
  'storage-untrusted',
  'paused',
  'not-paired',
  'device-pending',
  'device-revoked',
  'pairing-failed',
  'pairing-invalid',
  'pairing-locked',
  'holdr-unreachable',
  'holdr-refused',
  'holdr-protocol',
  'sync-disabled',
  'unknown-adapter',
  'issuer-not-enabled',
  'permission-missing',
  'main-consent-required',
  'unknown-document',
  'unknown-account',
  'unknown-binding',
  'binding-mismatch',
  'unknown-scope',
  'scope-conflict',
  'unmapped-rows',
  'busy',
  'no-capture',
  'capture-expired',
  'digest-mismatch',
  'wrong-stage',
  'collector-unreachable',
  'collector-refused',
  'too-large',
  'session-budget',
  'shape-unavailable',
  'shape-changed',
  'rate-limited',
  'stopped',
  'holdr-incompatible',
  'holdr-rejected',
  'review-expired',
  'device-replaced',
  'upload-pending',
  'commit-pending',
  'device-outdated',
  'holdr-limited',
  'holdr-unavailable',
  'plan-needs-review',
  'already-sent',
] as const;
export type UiErrorCode = (typeof UI_ERROR_CODES)[number];
