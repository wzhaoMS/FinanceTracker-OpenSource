/**
 * The card-sync owner API as Holdr serves it (E2a–E2d, `apps/api/src/routes/cardSync/`), shaped by the E8-M owner
 * API proposal (E8m): what the Spending tab's sync controls send to
 * and read from Holdr. Every path is under `/card-sync/owner/`, answered only
 * for the signed-in session (never a device or pairing credential), and every
 * body is strict JSON with exact keys, ISO times and letter-only ids.
 *
 * These schemas are the client's side of that API; where the proposal and the server differ, they follow the server
 * (apps/api `owner.e8m.contract.test.ts` drives this client against it). Every response is
 * parsed with them before the UI sees it; anything that does not match
 * (including any key the card-sync key policy refuses, such as anything
 * containing "token") is treated as an invalid answer and never shown.
 */
import {
  CARD_IMPORT_KINDS,
  CARD_SYNC_COMPLETENESS,
  CARD_SYNC_DATE_BASES,
  CARD_SYNC_ISSUE_CODES,
  CARD_SYNC_ISSUE_PATH,
  CARD_SYNC_ISSUERS,
  CARD_SYNC_SOURCES,
  CARD_SYNC_TERMINATIONS,
  cardSyncCurrencyExponent,
  cardSyncPayloadDigest,
  cardSyncTextIssue,
  isCardImportDate,
  isCardSyncDigest,
  isCardSyncId,
  isCardSyncPairingCode,
  isCardSyncTimestamp,
  validateCardSyncPayloadV2,
  type CardSyncIdKind,
  type CardSyncPayloadV2,
  type CardTransactionKind,
} from '@finance-tracker/shared';
import { S, type Infer } from './strict';

export const OWNER_API_PREFIX = '/card-sync/owner';
/** The login branch's password re-check (proposal Q2): outside card-sync, so its `password` key is not under the card-sync key policy. */
export const RECENT_AUTH_PATH = '/auth/reverify';

// ---------------------------------------------------------------------------
// Grammars
// ---------------------------------------------------------------------------

/** E2-only id kinds the proposal adds (Q3); they never appear in a device message. */
export const OWNER_ID_PREFIXES = { pairing: 'pai', reviewItem: 'rvw' } as const;
export type OwnerIdKind = keyof typeof OWNER_ID_PREFIXES;

export function isOwnerId(kind: OwnerIdKind, value: unknown): value is string {
  return typeof value === 'string' && new RegExp(`^${OWNER_ID_PREFIXES[kind]}_[a-p]{32}$`).test(value);
}
/** Holdr's own record ids (Phase 2): a prefix and 32 letters a–p. */
export function isCardAccountRef(value: unknown): value is string {
  return typeof value === 'string' && /^card-acct-[a-p]{32}$/.test(value);
}
export function isCardTransactionId(value: unknown): value is string {
  return typeof value === 'string' && /^card-txn-[a-p]{32}$/.test(value);
}
/** A source identity (an alias of a ledger transaction, E1b `card_source_identities`), proposal §3.8. */
export function isLedgerIdentityId(value: unknown): value is string {
  return typeof value === 'string' && /^card-ident-[a-p]{32}$/.test(value);
}
/** A ledger event (E1b `card_transaction_events`), proposal §3.8. */
export function isLedgerEventId(value: unknown): value is string {
  return typeof value === 'string' && /^card-event-[a-p]{32}$/.test(value);
}

const syncId = (kind: CardSyncIdKind) => S.string((value) => isCardSyncId(kind, value), 40);
const ownerId = (kind: OwnerIdKind) => S.string((value) => isOwnerId(kind, value), 40);
const CARD_ACCOUNT_REF = S.string(isCardAccountRef, 50);
/** A v1 file import's batch id (Phase 3), letters only like every Holdr id. */
const IMPORT_BATCH_ID = S.string((value) => /^card-import-[a-p]{32}$/.test(value), 44);
const TRANSACTION_ID = S.string(isCardTransactionId, 50);
const IDENTITY_ID = S.string(isLedgerIdentityId, 43);
const EVENT_ID = S.string(isLedgerEventId, 43);
const TIMESTAMP = S.string(isCardSyncTimestamp, 24);
const DAY = S.string(isCardImportDate, 10);
const COUNT = S.int(0, 1_000_000_000);
const VERSION = S.int(1, 2_147_483_647);
/** A binding's auto-sync revision: +1 on every consent change, starting at 0 (proposal rev 2, R1). */
const REVISION = S.int(0, 2_147_483_647);
const AMOUNT = S.int(-9_999_999_999, 9_999_999_999);
const LAST4 = S.string(/^[0-9]{4}$/, 4);
/** Canonical, redacted display text, as the v2 contract requires of every text field. */
const text = (max: number) => S.string((value) => cardSyncTextIssue(value, max) === null, max);
/** Binding and card labels: 1–64 characters (E1b revision 2). */
export const LABEL_MAX = 64;
const LABEL = text(LABEL_MAX);
/**
 * The owner's own category and notes on a ledger transaction, as Phase 4 stores them (`updateCardTransaction`:
 * no control characters, `userCategory` ≤100 and `notes` ≤1,000 characters); the snapshot scans them for card data.
 */
const ownerText = (max: number) => S.string((value) => value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value), max);
export const USER_CATEGORY_MAX = 100;
export const NOTES_MAX = 1_000;
/** An opaque list position: 1–64 ASCII letters. */
const CURSOR = S.string(/^[A-Za-z]{1,64}$/, 64);
const INVENTORY_MARK = S.object({ total: COUNT, nextCursor: S.nullable(CURSOR) });
/** A device's alias: E3 sends up to 32 characters, E1b stores up to 40. */
export const DEVICE_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
/** The non-secret confirmation code: 16 letters, grouped by four with hyphens (E3) or not (E1b stores it plain). */
export const DEVICE_FINGERPRINT_PATTERN = /^[a-p]{4}-?[a-p]{4}-?[a-p]{4}-?[a-p]{4}$/;
/** The one HTTPS origin a device may pair with; anything else (plain HTTP included) is an invalid answer. */
export const HOLDR_ORIGIN_PATTERN = /^https:\/\/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:[0-9]{1,5})?$/;
const DEVICE_LABEL = S.string(DEVICE_LABEL_PATTERN, 40);
const FINGERPRINT = S.string(DEVICE_FINGERPRINT_PATTERN, 19);
const CLIENT_VERSION = S.string(/^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/, 11);
const PARSER_VERSION = S.string(/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/, 64);
const PAYLOAD_DIGEST = S.string((value) => isCardSyncDigest('payload', value), 68);
const PLAN_DIGEST = S.string((value) => isCardSyncDigest('plan', value), 68);
const ORIGINAL_CURRENCY = S.string((value) => /^[A-Z]{3}$/.test(value) && cardSyncCurrencyExponent(value) !== null, 3);

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const HOLDER_ALIASES = ['alex', 'casey', 'joint', 'member-a'] as const;
export type HolderAlias = (typeof HOLDER_ALIASES)[number];
export const SET_STATES = [
  'accepted-uncommitted', 'needs-review', 'blocked-review', 'recovery-review', 'committed', 'rejected', 'expired-unreviewed',
] as const;
export type SetState = (typeof SET_STATES)[number];
export const OPEN_SET_STATES: readonly SetState[] = ['accepted-uncommitted', 'needs-review', 'blocked-review', 'recovery-review'];
/** Where a review set came from: a browser's upload, or a v1 file import's conflicts (X18), in chunks of 2,000 rows. */
export const SET_SOURCE_KINDS = ['extension', 'file'] as const;
export type SetSourceKind = (typeof SET_SOURCE_KINDS)[number];
export const REVIEW_CATEGORIES = [
  'cross-source-similar', 'no-stable-id', 'scope-unknown', 'pending-link', 'posted-correction', 'reconciliation-difference',
] as const;
export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];
/** E1b's eleven classifier reasons; each belongs to one category (two, for `removed-hit`), E1b §2.14 (Q27). */
export const REVIEW_REASONS = [
  'cross-source-similar', 'identity-conflict', 'detached-identity', 'no-stable-id', 'unknown-scope', 'pending-posted',
  'pending-may-have-posted', 'removed-hit', 'posted-correction', 'pending-changed', 'statement-mismatch',
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];
export const REASON_CATEGORIES: Record<ReviewReason, readonly ReviewCategory[]> = {
  'cross-source-similar': ['cross-source-similar'],
  'identity-conflict': ['cross-source-similar'],
  'detached-identity': ['cross-source-similar'],
  'no-stable-id': ['no-stable-id'],
  'unknown-scope': ['scope-unknown'],
  'pending-posted': ['pending-link'],
  'pending-may-have-posted': ['pending-link'],
  'removed-hit': ['pending-link', 'posted-correction'],
  'posted-correction': ['posted-correction'],
  'pending-changed': ['posted-correction'],
  'statement-mismatch': ['reconciliation-difference'],
};
export const DECISION_ACTIONS = [
  'same-transaction', 'attribute-and-link', 'attribute', 'insert-new', 'accept-correction', 'keep-current', 'accept-difference', 'reject-row',
] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];
/**
 * What a plan does to the ledger, one effect per action. `alias` (E1b revision 7, X37) is a row Holdr already has, with the
 * same values, that the observation adds a new id to: the row stays as it is (before = after) and the observation becomes
 * another of its sources. It is listed and counted (`PlanCounts.aliased`), never shown as unchanged.
 */
export const EFFECTS = [
  'insert', 'update', 'match', 'alias', 'attribute', 'promote', 'correct', 'reject', 'unmatch', 'restore-attribution', 'supersede',
  'revert', 'remove', 'accept-difference',
] as const;
export type EffectKind = (typeof EFFECTS)[number];
export const PLAN_KINDS = ['set', 'adjustment'] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];
export const DISCARD_REASONS = ['not-mine', 'wrong-binding', 'duplicate-of-file', 'bad-data', 'other'] as const;
export type DiscardReason = (typeof DISCARD_REASONS)[number];
/** Why Holdr refused an upload: E1b's `card_sync_runs.refusal_code`. */
export const RUN_ERROR_CODES = [
  'payload-invalid', 'payload-digest-mismatch', 'too-large', 'card-data', 'review-quota-exceeded', 'binding-stale',
  'sync-disabled', 'source-not-authorized', 'scope-not-in-binding', 'contract-unsupported', 'capture-already-accepted',
] as const;
export type RunErrorCode = (typeof RUN_ERROR_CODES)[number];
/** A run's own state (Q36): a revoked device's open runs close as `expired`. */
export const RUN_STATES = ['open', 'accepted', 'refused', 'expired', 'aborted'] as const;
export type RunState = (typeof RUN_STATES)[number];
/** Why the extension stopped a run before Holdr accepted anything (Casey Mac's answer to Q4: `abort {reason}`). */
export const ABORT_REASONS = ['site-permission-revoked', 'not-signed-in', 'unknown-page-structure', 'certificate-error', 'user-cancelled'] as const;
export type AbortReason = (typeof ABORT_REASONS)[number];
/**
 * Why a browser was revoked (E1b revision 3, X21 as amended). A browser whose time ran out, its 30 days or the 10 minutes to
 * approve it, is `status: 'expired'` with no reason.
 */
export const REVOKE_REASONS = ['owner', 'rejected', 'rotated', 'recovery', 'password-reset'] as const;
export type RevokeReason = (typeof REVOKE_REASONS)[number];
/**
 * Why a ledger transaction is removed (E1b §2.10); `superseded` and `settled-into` are merges. `legacy` is a row an earlier
 * Holdr (schema v13/v14) stored as removed without recording why or from which status: the v15 upgrade keeps it, and
 * nothing in v15 ever assigns it (E2a, handoff 10/18 02:30 item 2).
 */
export const REMOVED_REASONS = ['dismissed', 'cancelled', 'mistaken-import', 'superseded', 'settled-into', 'legacy'] as const;
export type RemovedReason = (typeof REMOVED_REASONS)[number];
/** What happened to a ledger transaction (E1b `card_transaction_events.event_type`). */
export const LEDGER_EVENT_TYPES = [
  'created', 'promoted', 'corrected', 'identity-linked', 'attributed', 'identity-repointed', 'identity-detached', 'superseded',
  'settled-into', 'removed', 'restored', 'reversed', 'user-edited',
] as const;
export type LedgerEventType = (typeof LEDGER_EVENT_TYPES)[number];
/** Why (E1b's fifteen event reasons); `maintenance` marks the repairs of proposal §3.8. */
export const LEDGER_EVENT_REASONS = [
  'insert', 'dismissed', 'cancelled', 'mistaken-import', 'settled-into', 'superseded', 'pending-posted', 'posted-correction',
  'same-transaction', 'alias', 'attribution', 'user-edit', 'restore', 'adjustment', 'maintenance',
] as const;
export type LedgerEventReason = (typeof LEDGER_EVENT_REASONS)[number];
/**
 * The reasons each event type may carry (E1b `ck_evt_*`). One update can write several events (a compound match writes
 * `promoted`, `restored` and `attributed`), and each keeps a reason of its own type.
 */
export const EVENT_REASONS: Readonly<Record<LedgerEventType, readonly LedgerEventReason[]>> = {
  created: ['insert'],
  promoted: ['pending-posted', 'same-transaction'],
  corrected: ['posted-correction'],
  'identity-linked': ['alias', 'same-transaction', 'pending-posted'],
  attributed: ['attribution', 'adjustment'],
  'identity-repointed': ['superseded', 'settled-into', 'adjustment', 'maintenance'],
  'identity-detached': ['adjustment', 'maintenance'],
  superseded: ['superseded'],
  'settled-into': ['settled-into'],
  removed: ['dismissed', 'cancelled', 'mistaken-import'],
  restored: ['restore', 'adjustment', 'maintenance'],
  reversed: ['adjustment', 'maintenance'],
  'user-edited': ['user-edit'],
};
/** The kind of key an alias stands for: a v1 file's key, the bank's lasting id, or a capture fingerprint. */
export const IDENTITY_NAMESPACE_KINDS = ['legacy-file', 'stable', 'capture'] as const;
export type IdentityNamespaceKind = (typeof IDENTITY_NAMESPACE_KINDS)[number];
export const IDENTITY_CREATED_BY = ['migration', 'file', 'extension', 'session'] as const;
export type IdentityCreatedBy = (typeof IDENTITY_CREATED_BY)[number];

/**
 * The owner routes' fixed error codes: proposal section 5, as E2a and E2b answer them (`routes/cardSync/http.ts`). E2a adds
 * three the proposal didn't list (handoff 10/18 02:30 item 1): 404 `transaction-not-found` for a charge Holdr doesn't have
 * (its sources and the repairs), 409 `link-not-reversible` for a merge that can no longer be undone exactly, and the fixed
 * 500 `internal-error`.
 */
export const OWNER_ERROR_CODES = [
  'bad-request', 'credential-not-allowed', 'too-large', 'unsupported-media-type',
  'csrf-required', 'recent-auth-required', 'unauthorized', 'not-found',
  'version-conflict', 'sync-paused', 'authorization-blocked', 'device-api-disabled', 'gate-closed', 'contract-unsupported',
  'binding-exists', 'binding-needs-reconfirmation', 'binding-retired', 'binding-stale', 'card-account-mismatch', 'auto-sync-not-eligible',
  'pairing-not-redeemed', 'pairing-closed', 'fingerprint-mismatch',
  'set-closed', 'action-not-allowed', 'decisions-incomplete', 'source-review-required', 'preview-stale', 'plan-mismatch',
  'transaction-revision-stale', 'merge-not-allowed', 'cross-card-link-refused', 'link-not-reversible', 'transaction-not-found',
  'pairing-expired', 'plan-expired', 'observation-expired', 'receipt-expired',
  'invalid-request', 'rate-limited', 'unavailable', 'internal-error',
] as const;
export type OwnerErrorCode = (typeof OWNER_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const ISSUER = S.enum(CARD_SYNC_ISSUERS);
const SOURCE = S.enum(CARD_SYNC_SOURCES);
const TERMINATION = S.enum(CARD_SYNC_TERMINATIONS);
const COMPLETENESS = S.enum(CARD_SYNC_COMPLETENESS);
const KIND = S.enum(CARD_IMPORT_KINDS as readonly CardTransactionKind[]);
const DATE_RANGE = S.object({ start: DAY, end: DAY, dateBasis: S.enum(CARD_SYNC_DATE_BASES) });
const USAGE = S.object({ used: COUNT, limit: COUNT });
const QUOTA_USAGE = { sets: USAGE, rows: USAGE, bytes: USAGE };

export const SETTINGS = S.object({
  paused: S.bool(),
  pausedAt: S.nullable(TIMESTAMP),
  settingsVersion: VERSION,
  issuers: S.array(S.object({ issuer: ISSUER, enabled: S.bool(), enabledAt: S.nullable(TIMESTAMP) }), 4),
});

const SCOPE = S.object({
  cardScopeId: syncId('cardScope'),
  kind: S.enum(['known', 'unknown'] as const),
  scopeLabel: LABEL,
  holderAlias: S.enum([...HOLDER_ALIASES, 'unknown'] as const),
  last4: S.nullable(LAST4),
  status: S.enum(['active', 'retired'] as const),
});

export const COVERAGE_ENTRY = S.object({
  cardScopeId: syncId('cardScope'),
  status: S.enum(['pending', 'posted'] as const),
  requested: S.nullable(DATE_RANGE),
  observed: S.nullable(DATE_RANGE),
  completeness: COMPLETENESS,
  termination: TERMINATION,
  pageCount: S.int(0, 100),
  observedAt: TIMESTAMP,
});

const ACCEPTANCE = S.enum(['none', ...SET_STATES] as const);
const LEDGER = S.enum(['none', 'committed'] as const);

const RUN_BRIEF = S.object({
  runId: syncId('run'),
  deviceId: syncId('device'),
  createdAt: TIMESTAMP,
  runExpiresAt: TIMESTAMP,
  runState: S.enum(RUN_STATES),
  abortReason: S.nullable(S.enum(ABORT_REASONS)),
  acceptance: ACCEPTANCE,
  ledger: LEDGER,
  observationSetId: S.nullable(syncId('observationSet')),
  observationExpiresAt: S.nullable(TIMESTAMP),
  planExpiresAt: S.nullable(TIMESTAMP),
  terminations: S.array(TERMINATION, CARD_SYNC_TERMINATIONS.length),
  completeness: S.nullable(COMPLETENESS),
});

export const BINDING = S.object({
  bindingId: syncId('binding'),
  bindingVersion: VERSION,
  issuer: ISSUER,
  source: SOURCE,
  bindingLabel: LABEL,
  cardAccountRef: CARD_ACCOUNT_REF,
  status: S.enum(['confirmed', 'needs-reconfirmation', 'retired'] as const),
  statusReason: S.nullable(S.enum(['restored-from-backup', 'card-account-changed', 'contract-changed'] as const)),
  confirmedAt: S.nullable(TIMESTAMP),
  scopes: S.array(SCOPE, 40),
  // Consent lives on each device grant (Q28) behind one switch per binding; the issuer's own gate (E4–E7) stays closed until
  // that issuer is admitted (Q7); `revision` moves on every consent change, so a stale "on" can't undo an "off" (R1).
  autoSync: S.object({
    gate: S.enum(['open', 'closed'] as const),
    eligible: S.bool(),
    revision: REVISION,
    devices: S.array(S.object({ deviceId: syncId('device'), enabled: S.bool(), consentedAt: S.nullable(TIMESTAMP) }), 50),
  }),
  deviceIds: S.array(syncId('device'), 50),
  deviceInventory: S.optional(S.object({ total: COUNT, active: COUNT, nextCursor: S.nullable(CURSOR) })),
  sync: S.object({
    lastRun: S.nullable(RUN_BRIEF),
    lastAcceptedAt: S.nullable(TIMESTAMP),
    lastCommittedAt: S.nullable(TIMESTAMP),
    openSets: COUNT,
    coverage: S.array(COVERAGE_ENTRY, 40),
  }),
});

export const DEVICE = S.object({
  deviceId: syncId('device'),
  deviceLabel: DEVICE_LABEL,
  clientVersion: CLIENT_VERSION,
  status: S.enum(['pending', 'active', 'revoked', 'expired'] as const),
  fingerprint: FINGERPRINT,
  pairingId: ownerId('pairing'),
  createdAt: TIMESTAMP,
  /** While it waits for approval, and kept on a browser that expired waiting. */
  pendingExpiresAt: S.nullable(TIMESTAMP),
  approvedAt: S.nullable(TIMESTAMP),
  deviceExpiresAt: S.nullable(TIMESTAMP),
  lastSeenAt: S.nullable(TIMESTAMP),
  /** Both set only for `status: 'revoked'`. */
  revokedAt: S.nullable(TIMESTAMP),
  revokeReason: S.nullable(S.enum(REVOKE_REASONS)),
  bindingIds: S.array(syncId('binding'), 20),
  /** Grants that lapsed when a binding was confirmed again; the owner can allow them again (Q35). */
  staleBindingIds: S.array(syncId('binding'), 20),
});

export const PAIRING = S.object({
  pairingId: ownerId('pairing'),
  status: S.enum(['open', 'redeemed', 'approved', 'rejected', 'cancelled', 'expired', 'locked'] as const),
  createdAt: TIMESTAMP,
  expiresAt: TIMESTAMP,
  bindingIds: S.array(syncId('binding'), 20),
  replacesDeviceId: S.nullable(syncId('device')),
  deviceId: S.nullable(syncId('device')),
  deviceLabel: S.nullable(DEVICE_LABEL),
  fingerprint: S.nullable(FINGERPRINT),
  pendingExpiresAt: S.nullable(TIMESTAMP),
  failedAttempts: S.int(0, 5),
});

export const STATE = S.object({
  generatedAt: TIMESTAMP,
  holdrOrigin: S.string(HOLDR_ORIGIN_PATTERN, 200),
  deviceApi: S.enum(['enabled', 'disabled'] as const),
  gate: S.enum(['open', 'blocked'] as const),
  recoveredAt: S.nullable(TIMESTAMP),
  contractVersions: S.array(S.int(1, 99), 8),
  limits: S.object({
    pairingMinutes: S.int(1, 60),
    pendingDeviceMinutes: S.int(1, 60),
    deviceDays: S.int(1, 90),
    planMinutes: S.int(1, 60),
    retentionDays: S.int(1, 90),
    maxRetentionDays: S.int(1, 90),
    receiptDays: S.int(1, 90),
  }),
  settings: SETTINGS,
  bindings: S.array(BINDING, 50),
  devices: S.array(DEVICE, 50),
  pairings: S.array(PAIRING, 50),
  inventory: S.optional(S.object({ devices: INVENTORY_MARK, bindings: INVENTORY_MARK, pairings: INVENTORY_MARK })),
  queue: S.object({
    open: COUNT,
    needsReview: COUNT,
    expiringWithin7Days: COUNT,
    expiringWithin1Day: COUNT,
    nextExpiresAt: S.nullable(TIMESTAMP),
  }),
  quota: S.object({
    global: S.object(QUOTA_USAGE),
    cardAccounts: S.array(S.object({ cardAccountRef: CARD_ACCOUNT_REF, ...QUOTA_USAGE }), 100),
    devices: S.array(S.object({ deviceId: syncId('device'), ...QUOTA_USAGE }), 50),
  }),
});
/**
 * `GET /state` where this Holdr has no extension sync (no HTTPS origin a browser could pair with, as in `vite` or `local`
 * mode): a normal answer, which the page shows as "not set up". Holdrs from before it answered 404 instead.
 */
export const NO_EXTENSION_SYNC = S.object({ extensionSync: S.const('not-configured') });

export const PAIRING_CREATED = S.object({
  pairing: PAIRING,
  pairingCode: S.string(isCardSyncPairingCode, 32),
  holdrOrigin: S.string(HOLDR_ORIGIN_PATTERN, 200),
});
export const PAIRING_AND_DEVICE = S.object({ pairing: PAIRING, device: DEVICE });
export const AUTHORITY_DEVICE_PAGE = S.object({
  devices: S.array(DEVICE, 50), total: COUNT, nextCursor: S.nullable(CURSOR),
  quota: S.array(S.object({ deviceId: syncId('device'), ...QUOTA_USAGE }), 50),
});
export const AUTHORITY_BINDING_PAGE = S.object({ bindings: S.array(BINDING, 50), total: COUNT, nextCursor: S.nullable(CURSOR) });
export const AUTHORITY_PAIRING_PAGE = S.object({ pairings: S.array(PAIRING, 50), total: COUNT, nextCursor: S.nullable(CURSOR) });
export const BINDING_DEVICE_PAGE = S.object({
  devices: S.array(S.object({
    deviceId: syncId('device'), status: S.enum(['active', 'pending'] as const), enabled: S.bool(), consentedAt: S.nullable(TIMESTAMP),
  }), 50),
  total: COUNT, active: COUNT, nextCursor: S.nullable(CURSOR),
});

const CATEGORY = S.enum(REVIEW_CATEGORIES);
const ACTION = S.enum(DECISION_ACTIONS);
const PLAN_STATE = S.enum(['valid', 'expired', 'superseded', 'committed'] as const);
const PLAN_REF = S.object({
  previewId: syncId('preview'),
  createdAt: TIMESTAMP,
  expiresAt: TIMESTAMP,
  state: PLAN_STATE,
});
const SET_SUMMARY_KEYS = {
  observationSetId: syncId('observationSet'),
  // E1b's origin column. The key origin itself is on E1a's forbidden-key list; Candidate.sourceKind names the same two values.
  sourceKind: S.enum(SET_SOURCE_KINDS),
  // Null exactly for file sets, which no browser sent (X18).
  runId: S.nullable(syncId('run')),
  bindingId: S.nullable(syncId('binding')),
  deviceId: S.nullable(syncId('device')),
  importBatchId: S.nullable(IMPORT_BATCH_ID),
  cardAccountRef: CARD_ACCOUNT_REF,
  version: VERSION,
  state: S.enum(SET_STATES),
  acceptedAt: TIMESTAMP,
  expiresAt: TIMESTAMP,
  rowCount: COUNT,
  byteCount: COUNT,
  reviewCount: COUNT,
  categories: S.array(S.object({ category: CATEGORY, count: COUNT }), REVIEW_CATEGORIES.length),
  /** The latest plan the signed-in owner prepared for the set (E2a: plans belong to whoever prepared them), or null. */
  plan: S.nullable(PLAN_REF),
  committedAt: S.nullable(TIMESTAMP),
  closedAt: S.nullable(TIMESTAMP),
  closeReason: S.nullable(S.enum(['committed', 'discarded', 'expired'] as const)),
};
export const SET_SUMMARY = S.object(SET_SUMMARY_KEYS);
export const SET_PAGE = S.object({ observationSets: S.array(SET_SUMMARY, 50), nextCursor: S.nullable(CURSOR) });

/**
 * A row's place in its set: the payload ordinal of an extension set's row (0–1,999), the file position of a v1 file set's
 * row (0–9,999, v1's row limit; E2d, §5.5/§5.6). The client also checks it against the set's source (ownerClient.ts).
 */
const SET_ROW_INDEX = S.int(0, 9_999);

const ROW_VIEW = S.object({
  rowIndex: SET_ROW_INDEX,
  transactionDate: DAY,
  postedDate: S.nullable(DAY),
  status: S.enum(['pending', 'posted'] as const),
  amountMinor: AMOUNT,
  kind: KIND,
  description: text(500),
  merchant: S.nullable(text(200)),
  issuerCategory: S.nullable(text(100)),
  cardScopeId: syncId('cardScope'),
  // `legacy-file` exactly for a v1 file set's rows (the import's own key: the issuer's reference, or the fingerprint).
  identity: S.enum(IDENTITY_NAMESPACE_KINDS),
  originalAmountMinor: S.nullable(AMOUNT),
  originalCurrency: S.nullable(ORIGINAL_CURRENCY),
});
const CANDIDATE = S.object({
  transactionId: TRANSACTION_ID,
  cardScopeId: S.nullable(syncId('cardScope')),
  scopeKind: S.enum(['known', 'unknown', 'legacy'] as const),
  sourceKind: S.enum(['file', 'extension'] as const),
  status: S.enum(['pending', 'posted', 'removed'] as const),
  transactionDate: DAY,
  postedDate: S.nullable(DAY),
  amountMinor: AMOUNT,
  kind: KIND,
  description: text(500),
  merchant: S.nullable(text(200)),
  userCategory: S.nullable(ownerText(USER_CATEGORY_MAX)),
  notes: S.nullable(ownerText(NOTES_MAX)),
  matchedOn: S.array(S.enum(['date', 'amount', 'merchant', 'description', 'posted-id'] as const), 5),
  blockedReason: S.nullable(S.const('different-known-cards')),
});
const DECISION_KEYS = {
  itemId: ownerId('reviewItem'),
  action: ACTION,
  transactionId: S.nullable(TRANSACTION_ID),
  cardScopeId: S.nullable(syncId('cardScope')),
};
const REVIEW_ITEM = S.object({
  itemId: ownerId('reviewItem'),
  category: CATEGORY,
  rowIndex: S.nullable(SET_ROW_INDEX),
  reason: S.enum(REVIEW_REASONS),
  observation: S.nullable(ROW_VIEW),
  candidates: S.array(CANDIDATE, 5),
  difference: S.nullable(S.object({
    field: S.enum(['charges', 'credits', 'net', 'new-balance'] as const),
    expectedMinor: S.int(-99_999_999_999, 99_999_999_999),
    actualMinor: S.int(-99_999_999_999, 99_999_999_999),
  })),
  allowedActions: S.array(ACTION, DECISION_ACTIONS.length),
  decision: S.nullable(S.object({ ...DECISION_KEYS, decidedAt: TIMESTAMP })),
  committed: S.nullable(S.object({ ...DECISION_KEYS, committedAt: TIMESTAMP })),
});
/** A set has at most 2,000 rows plus the set-level item (E1b). */
export const MAX_SET_ITEMS = 2_001;
/**
 * Review items per answer (R7): a set's detail comes in pages that the client puts together. One item can carry five
 * candidates with the owner's notes, so a whole set at the legal maximum (about 63 MiB) is far beyond any single answer
 * the shared strict-JSON reader accepts (16 MiB ceiling); a page of 100 is at most about 3.2 MiB.
 */
export const SET_ITEMS_PAGE = 100;
export const SET_DETAIL = S.object({
  ...SET_SUMMARY_KEYS,
  // The card account's billing currency: USD for an extension set (E1a), any for a v1 file set (E2d; E1b `ck_set_currency`).
  currency: S.string((value) => /^[A-Z]{3}$/.test(value), 3),
  payloadDigest: S.nullable(PAYLOAD_DIGEST),
  receiptExpiresAt: S.nullable(TIMESTAMP),
  rejectedCount: S.int(0, 2_000),
  coverage: S.array(COVERAGE_ENTRY, 40),
  /** Every item of the set; `items` is one page of them, in a stable order. */
  itemCount: S.int(0, MAX_SET_ITEMS),
  items: S.array(REVIEW_ITEM, SET_ITEMS_PAGE),
  /** The next page: `GET /observation-sets/:id?itemsCursor=…`; null on the last. */
  nextItemsCursor: S.nullable(CURSOR),
});

const TXN_VALUES = S.object({
  status: S.enum(['pending', 'posted', 'removed'] as const),
  transactionDate: DAY,
  postedDate: S.nullable(DAY),
  amountMinor: AMOUNT,
  kind: KIND,
  description: text(500),
  merchant: S.nullable(text(200)),
  cardScopeId: S.nullable(syncId('cardScope')),
});
const PLAN_COUNTS = S.object({
  insert: COUNT,
  update: COUNT,
  /** Actions that change and attach nothing: counted, never listed as effects. */
  unchanged: COUNT,
  /** `alias` effects (E1b revision 7, X37): a row's values unchanged, a new source attached to it. */
  aliased: COUNT,
  matched: COUNT,
  attributed: COUNT,
  promoted: COUNT,
  corrected: COUNT,
  rejected: COUNT,
  unmatched: COUNT,
  superseded: COUNT,
});
/** A set plan has ≤2,001 actions; an adjustment up to three per changed item (E1b §4.8). */
export const MAX_EFFECTS = 6_003;
/**
 * Effects per answer (R7): the rest come from `GET /plans/:previewId/effects`. With before and after values, the
 * largest legal adjustment is about 27 MiB; a page of 500 is at most about 2.3 MiB.
 */
export const PLAN_EFFECTS_PAGE = 500;
const EFFECT = S.object({
  itemId: S.nullable(ownerId('reviewItem')),
  rowIndex: S.nullable(SET_ROW_INDEX),
  effect: S.enum(EFFECTS),
  transactionId: S.nullable(TRANSACTION_ID),
  before: S.nullable(TXN_VALUES),
  after: S.nullable(TXN_VALUES),
});
export const PLAN = S.object({
  previewId: syncId('preview'),
  observationSetId: syncId('observationSet'),
  setVersion: VERSION,
  planKind: S.enum(PLAN_KINDS),
  // Null exactly for file sets.
  payloadDigest: S.nullable(PAYLOAD_DIGEST),
  planDigest: PLAN_DIGEST,
  createdAt: TIMESTAMP,
  expiresAt: TIMESTAMP,
  observationExpiresAt: TIMESTAMP,
  counts: PLAN_COUNTS,
  /** Every effect of the plan; `effects` is the first page of them. */
  effectCount: S.int(0, MAX_EFFECTS),
  effects: S.array(EFFECT, PLAN_EFFECTS_PAGE),
  nextEffectsCursor: S.nullable(CURSOR),
});
/**
 * `GET /plans/:previewId/effects?cursor=…`: the next page of a plan's effects, while the plan lasts. Every page echoes the
 * plan's digest and state (revision 4, X35), so the client checks it put together the plan it was shown.
 */
export const EFFECT_PAGE = S.object({
  previewId: syncId('preview'),
  planDigest: PLAN_DIGEST,
  state: PLAN_STATE,
  effects: S.array(EFFECT, PLAN_EFFECTS_PAGE),
  nextCursor: S.nullable(CURSOR),
});
export const COMMIT_RESULT = S.object({
  status: S.const('committed'),
  previewId: syncId('preview'),
  observationSetId: syncId('observationSet'),
  committedAt: TIMESTAMP,
  counts: PLAN_COUNTS,
});

const RUN_SUMMARY_KEYS = {
  runId: syncId('run'),
  deviceId: syncId('device'),
  deviceLabel: DEVICE_LABEL,
  bindingId: syncId('binding'),
  bindingVersion: VERSION,
  issuer: ISSUER,
  source: SOURCE,
  trigger: S.enum(['manual', 'auto'] as const),
  clientRunId: syncId('clientRun'),
  adapterVersion: PARSER_VERSION,
  contractVersion: S.int(1, 99),
  createdAt: TIMESTAMP,
  runExpiresAt: TIMESTAMP,
  acceptance: ACCEPTANCE,
  ledger: LEDGER,
  observationSetId: S.nullable(syncId('observationSet')),
  payloadDigest: S.nullable(PAYLOAD_DIGEST),
  acceptedAt: S.nullable(TIMESTAMP),
  committedAt: S.nullable(TIMESTAMP),
  rowCount: S.nullable(S.int(0, 2_000)),
  runState: S.enum(RUN_STATES),
  abortReason: S.nullable(S.enum(ABORT_REASONS)),
  errorCode: S.nullable(S.enum(RUN_ERROR_CODES)),
};
export const RUN_SUMMARY = S.object(RUN_SUMMARY_KEYS);
export const RUN_PAGE = S.object({ runs: S.array(RUN_SUMMARY, 50), nextCursor: S.nullable(CURSOR) });
export const RUN_DETAIL = S.object({
  ...RUN_SUMMARY_KEYS,
  observationExpiresAt: S.nullable(TIMESTAMP),
  receiptExpiresAt: S.nullable(TIMESTAMP),
  receiptAvailable: S.bool(),
  contentRetained: S.bool(),
  rejectedCount: S.nullable(S.int(0, 2_000)),
  coverage: S.array(COVERAGE_ENTRY, 40),
  counts: S.nullable(PLAN_COUNTS),
  results: S.array(S.object({
    rowIndex: S.int(0, 1_999),
    result: S.enum(['inserted', 'updated', 'unchanged', 'matched', 'attributed', 'needs-review', 'rejected', 'waiting'] as const),
    transactionId: S.nullable(TRANSACTION_ID),
  }), 2_000),
});

/** The exact object a run sent, kept for 7 days: shown only when its canonical bytes hash to the digest Holdr recorded. */
export const SENT_PAYLOAD = S.object({
  runId: syncId('run'),
  observationSetId: syncId('observationSet'),
  payloadDigest: PAYLOAD_DIGEST,
  acceptedAt: TIMESTAMP,
  receiptExpiresAt: TIMESTAMP,
  payload: S.embed<CardSyncPayloadV2>((value) => {
    const checked = validateCardSyncPayloadV2(value);
    return checked.ok ? checked.payload : null;
  }),
});

export const RECENT_AUTH_CONFIRMED = S.object({ verifiedUntil: TIMESTAMP });

// ---------------------------------------------------------------------------
// Ledger repairs after a set expired (proposal §3.8, X29; E1b §5.7.1)
// ---------------------------------------------------------------------------

/**
 * Aliases per page of one charge, active or detached: a display bound, not a limit (E1b caps neither). A real charge has a
 * handful; beyond it they come in keyset pages like the history (proposal §3.8, revision 4).
 */
export const MAX_IDENTITIES = 500;
/** Rows merged into one charge per page, each of which can be separated again; a display bound, paged beyond it. */
export const MAX_MERGED_ROWS = 100;
/** Events per page of a charge's history, newest first. */
export const LEDGER_EVENTS_PAGE = 100;
const LEDGER_ROW = S.object({
  transactionId: TRANSACTION_ID,
  cardAccountRef: CARD_ACCOUNT_REF,
  /** +1 per update of the row (E1b §2.10); detaching or moving an alias doesn't change it. */
  revision: VERSION,
  removedReason: S.nullable(S.enum(REMOVED_REASONS)),
  /** Set exactly for a row merged into another (`superseded`, `settled-into`). */
  mergedIntoId: S.nullable(TRANSACTION_ID),
  values: TXN_VALUES,
});
const SOURCE_IDENTITY = S.object({
  identityId: IDENTITY_ID,
  status: S.enum(['active', 'detached'] as const),
  createdBy: S.enum(IDENTITY_CREATED_BY),
  namespaceKind: S.enum(IDENTITY_NAMESPACE_KINDS),
  sourceScopeId: syncId('cardScope'),
  scopeKind: S.enum(['known', 'unknown', 'legacy'] as const),
  firstSeenStatus: S.enum(['pending', 'posted'] as const),
  createdAt: TIMESTAMP,
  lastSeenAt: S.nullable(TIMESTAMP),
});
/** The values an event changed; null where it didn't record one. */
const EVENT_VALUES = S.object({
  status: S.nullable(S.enum(['pending', 'posted', 'removed'] as const)),
  amountMinor: S.nullable(AMOUNT),
  transactionDate: S.nullable(DAY),
  postedDate: S.nullable(DAY),
  kind: S.nullable(KIND),
  cardScopeId: S.nullable(syncId('cardScope')),
});
const LEDGER_EVENT = S.object({
  eventId: EVENT_ID,
  eventType: S.enum(LEDGER_EVENT_TYPES),
  reason: S.enum(LEDGER_EVENT_REASONS),
  /** E1b's event origin column; the key `origin` itself is refused (proposal rule 3). */
  via: S.enum(['file', 'extension', 'session'] as const),
  actor: S.enum(['owner', 'device', 'file-import'] as const),
  /** Exactly for actor 'device'. */
  deviceId: S.nullable(syncId('device')),
  /**
   * This row's revision after the event; null exactly for an alias that left this row (an `identity-repointed` event of
   * the row it joined, which changed no revision here; E1b §5.7.1, X32).
   */
  revision: S.nullable(VERSION),
  at: TIMESTAMP,
  identityId: S.nullable(IDENTITY_ID),
  /**
   * The other row: of a merge; where a re-pointed alias came from (its event here) or, with no revision, the row it joined.
   */
  relatedTransactionId: S.nullable(TRANSACTION_ID),
  reversesEventId: S.nullable(EVENT_ID),
  edited: S.array(S.enum(['category', 'notes'] as const), 2),
  from: S.nullable(EVENT_VALUES),
  to: S.nullable(EVENT_VALUES),
});
/**
 * `GET /transactions/:transactionId/sources`, with at most one of `?eventsCursor=`, `?identitiesCursor=` or
 * `?mergedRowsCursor=`: one charge, and one page of each list. The cursor continues its own list; the others come as their
 * first page, and the charge and `revertibleEventId` as they are now.
 */
export const TRANSACTION_SOURCES = S.object({
  transaction: LEDGER_ROW,
  identities: S.array(SOURCE_IDENTITY, MAX_IDENTITIES),
  nextIdentitiesCursor: S.nullable(CURSOR),
  mergedRows: S.array(LEDGER_ROW, MAX_MERGED_ROWS),
  nextMergedRowsCursor: S.nullable(CURSOR),
  /** The one change `revert` accepts now (the row's latest reversible change), or null. */
  revertibleEventId: S.nullable(EVENT_ID),
  events: S.array(LEDGER_EVENT, LEDGER_EVENTS_PAGE),
  nextEventsCursor: S.nullable(CURSOR),
});

export const ERROR_BODY = S.object({ error: S.enum(OWNER_ERROR_CODES) });
export const ERROR_WITH_ISSUES = S.object({
  error: S.const('invalid-request'),
  issues: S.array(S.object({ code: S.enum(CARD_SYNC_ISSUE_CODES), path: S.string(CARD_SYNC_ISSUE_PATH, 200) }), 20),
});
export const ERROR_WITH_VERSION = S.object({ error: S.const('version-conflict'), currentVersion: VERSION });
export const ERROR_WITH_RETRY = S.object({ error: S.enum(OWNER_ERROR_CODES), retryAfterSeconds: S.int(1, 86_400) });

/**
 * Strict-JSON limits per answer: the defaults, except for the answers that can carry a whole capture's worth of rows
 * (a page of set items or plan effects, a run's results). Unit tests build the largest legal answers and check they pass.
 */
export const LARGE_ANSWER_LIMITS = { maxArrayLength: 2_000, maxNodes: 600_000, maxBytes: 8 * 1024 * 1024 } as const;
export const PAYLOAD_ANSWER_LIMITS = { maxDepth: 8, maxNodes: 61_000, maxBytes: 2 * 1024 * 1024 + 4 * 1024 } as const;

// ---------------------------------------------------------------------------
// Request bodies (exact keys; the fake Holdr parses them with these schemas)
// ---------------------------------------------------------------------------

export const EMPTY_REQUEST = S.object({});
export const VERSION_REQUEST = S.object({ expectedVersion: VERSION });
export const ENABLE_ISSUER_REQUEST = S.object({ expectedVersion: VERSION, riskAcknowledged: S.const(true), mainWorldAcknowledged: S.bool() });
const SCOPE_DRAFT = { scopeLabel: LABEL, holderAlias: S.enum(HOLDER_ALIASES), last4: S.nullable(LAST4) };
export const CREATE_BINDING_REQUEST = S.object({
  issuer: ISSUER,
  source: SOURCE,
  cardAccountRef: CARD_ACCOUNT_REF,
  bindingLabel: LABEL,
  scopes: S.array(S.object(SCOPE_DRAFT), 39),
});
export const CONFIRM_BINDING_REQUEST = S.object({
  expectedVersion: VERSION,
  bindingLabel: LABEL,
  scopes: S.array(S.object({ cardScopeId: S.nullable(syncId('cardScope')), ...SCOPE_DRAFT }), 39),
  /** Browsers that keep this binding at its new version; every other browser's grant lapses (Q35). */
  regrantDeviceIds: S.array(syncId('device'), 50),
});
/**
 * Automatic sending for one binding (Q28): "on" writes consent to every current browser grant, "off" clears them all.
 * `expectedVersion` is the binding's; "on" also names the auto-sync revision it saw, so a stale "on" can't undo a later
 * "off" (R1). "Off" checks neither and always wins.
 */
export const AUTO_SYNC_REQUEST = S.object({
  expectedVersion: VERSION,
  expectedAutoSyncRevision: REVISION,
  enabled: S.bool(),
});
/** Allowing a browser again for bindings whose grant lapsed (Q35). */
export const REGRANT_REQUEST = S.object({ bindingIds: S.array(syncId('binding'), 20) });
export const CREATE_PAIRING_REQUEST = S.object({ bindingIds: S.array(syncId('binding'), 20), replacesDeviceId: S.nullable(syncId('device')) });
export const APPROVE_PAIRING_REQUEST = S.object({ deviceId: syncId('device'), fingerprint: FINGERPRINT });
export const REJECT_PAIRING_REQUEST = S.object({ deviceId: syncId('device') });
/** At most 200 decisions per request; the page sends them in batches of `DECISION_BATCH`. */
export const DECISIONS_REQUEST = S.object({ expectedVersion: VERSION, decisions: S.array(S.object(DECISION_KEYS), 200) });
export const DECISION_BATCH = 100;
export const PLAN_REQUEST = S.object({ expectedVersion: VERSION, sourceReviewed: S.bool() });
/** `payloadDigest` is null exactly for a file set's plan. */
export const COMMIT_REQUEST = S.object({ payloadDigest: S.nullable(PAYLOAD_DIGEST), planDigest: PLAN_DIGEST });
export const DISCARD_REQUEST = S.object({ expectedVersion: VERSION, reason: S.enum(DISCARD_REASONS) });
/**
 * Ledger repairs (§3.8): each names the revisions it was decided on. An alias move changes no row's revision, so detach and
 * re-point also name the row the owner saw the alias on: if it moved since, `transaction-revision-stale` (revision 4, X31).
 */
export const DETACH_REQUEST = S.object({ transactionId: TRANSACTION_ID, expectedRevision: VERSION });
export const REPOINT_REQUEST = S.object({
  fromTransactionId: TRANSACTION_ID, toTransactionId: TRANSACTION_ID, expectedRevision: VERSION, expectedToRevision: VERSION,
});
export const REVERT_REQUEST = S.object({ eventId: EVENT_ID, expectedRevision: VERSION });
export const UNMERGE_REQUEST = S.object({ expectedRevision: VERSION, expectedSurvivorRevision: VERSION });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OwnerState = Infer<typeof STATE>;
export type AuthorityDevicePage = Infer<typeof AUTHORITY_DEVICE_PAGE>;
export type AuthorityBindingPage = Infer<typeof AUTHORITY_BINDING_PAGE>;
export type AuthorityPairingPage = Infer<typeof AUTHORITY_PAIRING_PAGE>;
export type BindingDevicePage = Infer<typeof BINDING_DEVICE_PAGE>;
export type Settings = Infer<typeof SETTINGS>;
export type Binding = Infer<typeof BINDING>;
export type BindingScope = Binding['scopes'][number];
export type SyncSummary = Binding['sync'];
export type RunBrief = NonNullable<SyncSummary['lastRun']>;
export type CoverageEntry = Infer<typeof COVERAGE_ENTRY>;
export type Device = Infer<typeof DEVICE>;
export type Pairing = Infer<typeof PAIRING>;
export type PairingCreated = Infer<typeof PAIRING_CREATED>;
export type PairingAndDevice = Infer<typeof PAIRING_AND_DEVICE>;
export type SetSummary = Infer<typeof SET_SUMMARY>;
export type SetPage = Infer<typeof SET_PAGE>;
export type SetDetail = Infer<typeof SET_DETAIL>;
export type ReviewItem = SetDetail['items'][number];
export type Candidate = ReviewItem['candidates'][number];
export type RowView = NonNullable<ReviewItem['observation']>;
export type Decision = Infer<typeof DECISIONS_REQUEST>['decisions'][number];
export type Plan = Infer<typeof PLAN>;
export type EffectPage = Infer<typeof EFFECT_PAGE>;
export type PlanCounts = Plan['counts'];
export type Effect = Plan['effects'][number];
export type TxnValues = NonNullable<Effect['before']>;
export type CommitResult = Infer<typeof COMMIT_RESULT>;
export type RunSummary = Infer<typeof RUN_SUMMARY>;
export type RunPage = Infer<typeof RUN_PAGE>;
export type RunDetail = Infer<typeof RUN_DETAIL>;
export type SentPayload = Infer<typeof SENT_PAYLOAD>;
export type CreateBindingRequest = Infer<typeof CREATE_BINDING_REQUEST>;
export type ConfirmBindingRequest = Infer<typeof CONFIRM_BINDING_REQUEST>;
export type ScopeDraft = ConfirmBindingRequest['scopes'][number];
export type TransactionSources = Infer<typeof TRANSACTION_SOURCES>;
export type LedgerRow = TransactionSources['transaction'];
export type SourceIdentity = TransactionSources['identities'][number];
export type LedgerEvent = TransactionSources['events'][number];
export type EventValues = NonNullable<LedgerEvent['from']>;

/** True when the shown object hashes to the digest Holdr recorded for it. */
export function sentPayloadMatches(sent: SentPayload): boolean {
  try {
    return cardSyncPayloadDigest(sent.payload) === sent.payloadDigest;
  } catch {
    return false;
  }
}

type DecisionTarget = Pick<Decision, 'action' | 'transactionId' | 'cardScopeId'>;

/** Two decisions are the same only with the same action on the same transaction and card: "same transaction" as A is not B. */
export function sameDecision(a: DecisionTarget | null | undefined, b: DecisionTarget | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.action === b.action && a.transactionId === b.transactionId && a.cardScopeId === b.cardScopeId;
}
