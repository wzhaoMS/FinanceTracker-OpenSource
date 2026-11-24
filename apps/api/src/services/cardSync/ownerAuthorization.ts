import type { Database as DB } from 'better-sqlite3';

import {
  CARD_SYNC_COMPLETENESS, CARD_SYNC_ISSUERS, CARD_SYNC_SUPPORTED_CONTRACT_VERSIONS, CARD_SYNC_TERMINATIONS,
  type CardSyncIssuer,
} from '@finance-tracker/shared';
import { reviewQuotaUsage } from './acceptance.js';
import {
  confirmCardSourceBinding, createCardSourceBinding, getCardSourceBinding, retireCardSourceBinding,
  setCardSyncAutoSync, type CardScopeView, type CardSourceBindingView,
} from './bindings.js';
import { cachedStatement } from './bulk.js';
import { secondsAfter, type CardSyncContext } from './context.js';
import {
  CARD_SYNC_DEVICE_SECONDS, CARD_SYNC_PAIRING_SECONDS, CARD_SYNC_PENDING_DEVICE_SECONDS, approveCardSyncPairing,
  cancelCardSyncPairing, createCardSyncPairing, getCardSyncDevice, getCardSyncPairing, listCardSyncDevices,
  regrantCardSyncDevice, rejectCardSyncPairing, revokeCardSyncDevice, type CardSyncDeviceView, type CardSyncPairingView,
  type CardSyncRevokeActor, type CardSyncRevokeReason,
} from './devices.js';
import { presentedSetState, setCoverage, type OwnerCoverageEntry } from './ownerViews.js';
import { CARD_SYNC_PLAN_SECONDS } from './plans.js';
import type { CardSyncAuthChange } from './principals.js';
import { listCardSyncRuns } from './runs.js';
import { type CardSyncSetState, type SetRow } from './sets.js';
import {
  disableCardSyncIssuer, enableCardSyncIssuer, pauseCardSync, readCardSyncSettings, resumeCardSync, type CardSyncSettings,
} from './settings.js';
import type { CardSyncGenerationStep } from './context.js';
import {
  authorityRows, closedAuthorityRows, type AuthorityKind, type AuthorityMark, type AuthorityQuery, type BindingAuthorityEntry,
} from './ownerInventory.js';

/**
 * E2b: the owner API's authorization shapes (the E8-M proposal §2, §3.1–§3.4; E1b design §10 item 10) and the
 * authorization changes answered in them. Each change runs the E1b repository function and builds its answer in the same
 * IMMEDIATE transaction; `GET /state` is one read transaction (owner API §3.1). Times come from the repository clock.
 *
 * What the owner sees is presented by the clock, as the device credential resolver decides by it (E1b §5.3): a pending
 * browser past its approval window or an active one past its 30 days is `expired` before retention records it, an invitation
 * past its 5 minutes is `expired`, and one whose browser waited too long is `expired` too. Live authority uses bounded pages
 * with explicit counts and continuations; only closed history may be omitted. The client joins all pages before publishing.
 */

const DAY_SECONDS = 86_400;
/** The schema's largest review retention (`ck_pol_review_retention`), the owner API's `maxRetentionDays`. */
const MAX_REVIEW_RETENTION_DAYS = 90;
const OPEN_SET_STATES = ['accepted-uncommitted', 'needs-review', 'blocked-review', 'recovery-review'] as const;
const OPEN_STATES_SQL = `(${OPEN_SET_STATES.map((state) => `'${state}'`).join(', ')})`;

export const OWNER_LIST_LIMITS = Object.freeze({
  bindings: 50, devices: 50, pairings: 50, cardAccounts: 100, quotaDevices: 50, coverage: 40, deviceIds: 50, pairingBindings: 20,
});

// ---------------------------------------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------------------------------------

export interface OwnerSettings {
  paused: boolean;
  pausedAt: string | null;
  settingsVersion: number;
  issuers: Array<{ issuer: CardSyncIssuer; enabled: boolean; enabledAt: string | null }>;
}

export interface OwnerRunBrief {
  runId: string;
  deviceId: string;
  createdAt: string;
  runExpiresAt: string;
  runState: 'open' | 'accepted' | 'refused' | 'expired' | 'aborted';
  abortReason: string | null;
  acceptance: 'none' | CardSyncSetState;
  ledger: 'none' | 'committed';
  observationSetId: string | null;
  observationExpiresAt: string | null;
  planExpiresAt: string | null;
  terminations: string[];
  completeness: string | null;
}

export interface OwnerSyncSummary {
  lastRun: OwnerRunBrief | null;
  lastAcceptedAt: string | null;
  lastCommittedAt: string | null;
  openSets: number;
  coverage: OwnerCoverageEntry[];
}

export interface OwnerBinding {
  bindingId: string;
  bindingVersion: number;
  issuer: CardSyncIssuer;
  source: string;
  bindingLabel: string;
  cardAccountRef: string;
  status: CardSourceBindingView['status'];
  statusReason: CardSourceBindingView['statusReason'];
  confirmedAt: string | null;
  scopes: CardScopeView[];
  autoSync: CardSourceBindingView['autoSync'];
  deviceIds: string[];
  deviceInventory: AuthorityMark & { active: number };
  sync: OwnerSyncSummary;
}

export type OwnerDeviceStatus = 'pending' | 'active' | 'revoked' | 'expired';

export interface OwnerDevice {
  deviceId: string;
  deviceLabel: string;
  clientVersion: string;
  status: OwnerDeviceStatus;
  fingerprint: string;
  pairingId: string;
  createdAt: string;
  pendingExpiresAt: string | null;
  approvedAt: string | null;
  deviceExpiresAt: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
  revokeReason: CardSyncRevokeReason | null;
  bindingIds: string[];
  staleBindingIds: string[];
}

export type OwnerPairingStatus = CardSyncPairingView['status'];

export interface OwnerPairing {
  pairingId: string;
  status: OwnerPairingStatus;
  createdAt: string;
  expiresAt: string;
  bindingIds: string[];
  replacesDeviceId: string | null;
  deviceId: string | null;
  deviceLabel: string | null;
  fingerprint: string | null;
  pendingExpiresAt: string | null;
  failedAttempts: number;
}

export interface Usage { used: number; limit: number }
export interface OwnerQuotaUsage { sets: Usage; rows: Usage; bytes: Usage }

/** The database's part of the owner API's `State`; the route adds `holdrOrigin`, `deviceApi` and `gate`. */
export interface OwnerStateParts {
  generatedAt: string;
  recoveredAt: string | null;
  contractVersions: number[];
  limits: {
    pairingMinutes: number; pendingDeviceMinutes: number; deviceDays: number; planMinutes: number; retentionDays: number;
    maxRetentionDays: number; receiptDays: number;
  };
  settings: OwnerSettings;
  bindings: OwnerBinding[];
  devices: OwnerDevice[];
  pairings: OwnerPairing[];
  inventory: { devices: AuthorityMark; bindings: AuthorityMark; pairings: AuthorityMark };
  queue: { open: number; needsReview: number; expiringWithin7Days: number; expiringWithin1Day: number; nextExpiresAt: string | null };
  quota: {
    global: OwnerQuotaUsage;
    cardAccounts: Array<{ cardAccountRef: string } & OwnerQuotaUsage>;
    devices: Array<{ deviceId: string } & OwnerQuotaUsage>;
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------------------------------------

/** `Settings` (owner API §2): the four issuers in the contract's order. */
export function ownerSettings(settings: CardSyncSettings): OwnerSettings {
  const byIssuer = new Map(settings.issuers.map((issuer) => [issuer.issuer, issuer]));
  return {
    paused: settings.paused,
    pausedAt: settings.pausedAt,
    settingsVersion: settings.settingsVersion,
    issuers: CARD_SYNC_ISSUERS.map((issuer) => {
      const row = byIssuer.get(issuer);
      return { issuer, enabled: row?.enabled ?? false, enabledAt: row?.enabledAt ?? null };
    }),
  };
}

/** A browser's status as its credential stands now (E1b §5.3's resolver): a lapsed window is `expired` before retention runs. */
export function presentedDeviceStatus(device: Pick<CardSyncDeviceView, 'status' | 'pendingExpiresAt' | 'expiresAt'>, now: string):
  OwnerDeviceStatus {
  if (device.status === 'pending' && now >= device.pendingExpiresAt) return 'expired';
  if (device.status === 'active' && device.expiresAt !== null && now >= device.expiresAt) return 'expired';
  return device.status;
}

const frozenBindings = (db: DB, pairingId: string) => cachedStatement(db,
  'SELECT binding_id FROM card_sync_pairing_scopes WHERE pairing_id = ? ORDER BY rowid').pluck().all(pairingId) as string[];

/**
 * `Device` (owner API §2): the browser's frozen bindings come from its invitation; `pendingExpiresAt` while it waits, and kept
 * when it expired waiting; `revokedAt` only for `revoked`, when it stopped working (an expired browser revoked later keeps its
 * expiry time, X34); `lastSeenAt` its last authenticated request.
 */
export function ownerDevice(db: DB, view: CardSyncDeviceView, now: string): OwnerDevice {
  const status = presentedDeviceStatus(view, now);
  const neverApproved = view.activatedAt === null;
  return {
    deviceId: view.deviceId,
    deviceLabel: view.label,
    clientVersion: view.clientVersion,
    status,
    fingerprint: view.fingerprint,
    pairingId: view.pairingId,
    createdAt: view.createdAt,
    pendingExpiresAt: status === 'pending' || (status === 'expired' && neverApproved) ? view.pendingExpiresAt : null,
    approvedAt: view.activatedAt,
    deviceExpiresAt: view.expiresAt,
    lastSeenAt: view.lastUsedAt,
    revokedAt: status === 'revoked' ? view.closedAt : null,
    revokeReason: status === 'revoked' ? view.revokeReason : null,
    bindingIds: frozenBindings(db, view.pairingId).slice(0, OWNER_LIST_LIMITS.pairingBindings),
    staleBindingIds: view.staleBindingIds.slice(0, OWNER_LIST_LIMITS.pairingBindings),
  };
}

/**
 * `Pairing` (owner API §2): an open invitation past its 5 minutes, or a redeemed one whose browser was not approved within its
 * 10 minutes, is `expired`; `pendingExpiresAt` only while its browser waits.
 */
export function ownerPairing(db: DB, view: CardSyncPairingView, now: string): OwnerPairing {
  const device = view.deviceId === null ? null : getCardSyncDevice(db, view.deviceId);
  const devicePending = device !== null && presentedDeviceStatus(device, now) === 'pending';
  let status: OwnerPairingStatus = view.status;
  if (status === 'open' && now >= view.expiresAt) status = 'expired';
  if (status === 'redeemed' && !devicePending) status = 'expired';
  return {
    pairingId: view.pairingId,
    status,
    createdAt: view.createdAt,
    expiresAt: view.expiresAt,
    bindingIds: view.bindingIds,
    replacesDeviceId: view.replacesDeviceId,
    deviceId: view.deviceId,
    deviceLabel: view.deviceLabel,
    fingerprint: view.fingerprint,
    pendingExpiresAt: devicePending ? view.pendingExpiresAt : null,
    failedAttempts: view.failedAttempts,
  };
}

function weakestCompleteness(values: readonly string[]): string | null {
  let weakest: string | null = null;
  for (const value of values) {
    const rank = (CARD_SYNC_COMPLETENESS as readonly string[]).indexOf(value);
    if (rank >= 0 && (weakest === null || rank < (CARD_SYNC_COMPLETENESS as readonly string[]).indexOf(weakest))) weakest = value;
  }
  return weakest;
}

const setById = (db: DB, setId: string) => cachedStatement(db, 'SELECT * FROM card_sync_observation_sets WHERE id = ?').get(setId) as
  SetRow | undefined;

/** `RunBrief` (owner API §2): the binding's newest run, its set as the owner sees it, the set's newest plan, its coverage. */
function lastRunOf(ctx: CardSyncContext, bindingId: string): OwnerRunBrief | null {
  const { runs } = listCardSyncRuns(ctx.db, { bindingId, limit: 1 });
  const run = runs[0];
  if (!run) return null;
  const set = run.observationSetId === null ? undefined : setById(ctx.db, run.observationSetId);
  const plan = set === undefined ? undefined : cachedStatement(ctx.db, `SELECT expires_at FROM card_sync_commit_plans
    WHERE observation_set_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(set.id) as { expires_at: string } | undefined;
  const coverage = set === undefined ? [] : setCoverage(ctx.db, set);
  const terminations = new Set(coverage.map((entry) => entry.termination));
  return {
    runId: run.runId,
    deviceId: run.deviceId,
    createdAt: run.createdAt,
    runExpiresAt: run.uploadExpiresAt,
    runState: run.runState,
    abortReason: run.abortReason,
    acceptance: set === undefined ? 'none' : presentedSetState(set, ctx.now),
    ledger: set?.state === 'committed' ? 'committed' : 'none',
    observationSetId: set?.id ?? null,
    observationExpiresAt: set?.expires_at ?? null,
    planExpiresAt: plan?.expires_at ?? null,
    terminations: CARD_SYNC_TERMINATIONS.filter((termination) => terminations.has(termination)),
    completeness: set?.origin === 'extension' && set.payload_digest !== null ? weakestCompleteness(coverage.map((entry) => entry.completeness))
      : null,
  };
}

/** `SyncSummary` (owner API §2, the §8 status list): the binding's sets and runs. */
function syncSummaryOf(ctx: CardSyncContext, bindingId: string): OwnerSyncSummary {
  const { db, now } = ctx;
  const times = cachedStatement(db, `SELECT max(accepted_at) AS accepted,
      max(CASE WHEN state = 'committed' THEN closed_at END) AS committed,
      count(CASE WHEN state IN ${OPEN_STATES_SQL} AND expires_at > ? THEN 1 END) AS open
    FROM card_sync_observation_sets WHERE binding_id = ?`).get(now, bindingId) as
    { accepted: string | null; committed: string | null; open: number };
  const newest = cachedStatement(db, `SELECT * FROM card_sync_observation_sets WHERE binding_id = ?
    ORDER BY accepted_at DESC, rowid DESC LIMIT 1`).get(bindingId) as SetRow | undefined;
  return {
    lastRun: lastRunOf(ctx, bindingId),
    lastAcceptedAt: times.accepted,
    lastCommittedAt: times.committed,
    openSets: times.open,
    coverage: newest === undefined ? [] : setCoverage(db, newest).slice(0, OWNER_LIST_LIMITS.coverage),
  };
}

/**
 * `Binding` (owner API §2): the repository's view, with its consenting browsers and `deviceIds` as the owner sees them now
 * (pending or active browsers scoped to it: the active grant holders, and browsers awaiting approval whose invitation names
 * it), and its `sync` summary.
 */
export function ownerBinding(ctx: CardSyncContext, view: CardSourceBindingView): OwnerBinding {
  const page = authorityRows(ctx, { kind: 'binding-devices', bindingId: view.bindingId });
  return {
    bindingId: view.bindingId,
    bindingVersion: view.bindingVersion,
    issuer: view.issuer,
    source: view.source,
    bindingLabel: view.bindingLabel,
    cardAccountRef: view.cardAccountRef,
    status: view.status,
    statusReason: view.statusReason,
    confirmedAt: view.confirmedAt,
    scopes: view.scopes,
    autoSync: {
      gate: view.autoSync.gate,
      eligible: view.autoSync.eligible,
      revision: view.autoSync.revision,
      devices: page.rows.filter((device) => device.status === 'active').map((device) => ({
        deviceId: device.id, enabled: device.enabled === 1, consentedAt: device.consentedAt ?? null,
      })),
    },
    deviceIds: page.rows.map((device) => device.id),
    deviceInventory: { total: page.total, active: page.active!, next: page.next },
    sync: syncSummaryOf(ctx, view.bindingId),
  };
}

/** A binding's owner view by id, or null. */
export function ownerBindingById(ctx: CardSyncContext, bindingId: string): OwnerBinding | null {
  const view = getCardSourceBinding(ctx.db, bindingId);
  return view ? ownerBinding(ctx, view) : null;
}

function usageOf(used: { sets: number; rows: number; bytes: number }, limit: { sets: number; rows: number; bytes: number }):
  OwnerQuotaUsage {
  return {
    sets: { used: used.sets, limit: limit.sets }, rows: { used: used.rows, limit: limit.rows }, bytes: { used: used.bytes, limit: limit.bytes },
  };
}

/** The database's part of `GET /owner/state` (owner API §3.1), in the caller's one read transaction. */
export function ownerStateParts(ctx: CardSyncContext): OwnerStateParts {
  const { db, now } = ctx;
  const settings = readCardSyncSettings(db);
  const policy = cachedStatement(db, "SELECT recovery_completed_at FROM card_sync_policy WHERE id = 'card-sync-policy'").get() as
    { recovery_completed_at: string | null };
  const bindingPage = authorityRows(ctx, { kind: 'bindings' });
  const bindings = [...bindingPage.rows, ...closedAuthorityRows(ctx, 'bindings', OWNER_LIST_LIMITS.bindings - bindingPage.rows.length)]
    .sort((a, b) => a.rowId - b.rowId).map(({ id }) => ownerBindingById(ctx, id)!);
  const devicePage = authorityRows(ctx, { kind: 'devices' });
  const shownDevices = [...devicePage.rows, ...closedAuthorityRows(ctx, 'devices', OWNER_LIST_LIMITS.devices - devicePage.rows.length)]
    .sort((a, b) => a.rowId - b.rowId).map(({ id }) => ownerDevice(db, getCardSyncDevice(db, id)!, now));
  const pairingPage = authorityRows(ctx, { kind: 'pairings' });
  const shownPairings = [...pairingPage.rows, ...closedAuthorityRows(ctx, 'pairings', OWNER_LIST_LIMITS.pairings - pairingPage.rows.length)]
    .sort((a, b) => a.rowId - b.rowId).map(({ id }) => ownerPairing(db, getCardSyncPairing(db, id)!, now));

  const open = cachedStatement(db, `SELECT state, expires_at FROM card_sync_observation_sets
    WHERE state IN ${OPEN_STATES_SQL} AND expires_at > ? ORDER BY expires_at`).all(now) as Array<{ state: string; expires_at: string }>;
  const within = (seconds: number) => open.filter((set) => set.expires_at <= secondsAfter(now, seconds)).length;

  const quotas = settings.quotas;
  const accounts = cachedStatement(db, `SELECT card_account_id FROM card_source_bindings WHERE status <> 'retired'
    UNION SELECT card_account_id FROM card_sync_observation_sets WHERE state IN ${OPEN_STATES_SQL}
    ORDER BY 1`).pluck().all() as string[];
  const quotaDevices = shownDevices.filter((device) => device.status === 'pending' || device.status === 'active')
    .slice(0, OWNER_LIST_LIMITS.quotaDevices);

  return {
    generatedAt: now,
    recoveredAt: policy.recovery_completed_at,
    contractVersions: [...CARD_SYNC_SUPPORTED_CONTRACT_VERSIONS],
    limits: {
      pairingMinutes: CARD_SYNC_PAIRING_SECONDS / 60,
      pendingDeviceMinutes: CARD_SYNC_PENDING_DEVICE_SECONDS / 60,
      deviceDays: CARD_SYNC_DEVICE_SECONDS / DAY_SECONDS,
      planMinutes: CARD_SYNC_PLAN_SECONDS / 60,
      retentionDays: settings.reviewRetentionDays,
      maxRetentionDays: MAX_REVIEW_RETENTION_DAYS,
      receiptDays: settings.receiptRetentionDays,
    },
    settings: ownerSettings(settings),
    bindings,
    devices: shownDevices,
    pairings: shownPairings,
    inventory: {
      bindings: { total: bindingPage.total, next: bindingPage.next },
      devices: { total: devicePage.total, next: devicePage.next },
      pairings: { total: pairingPage.total, next: pairingPage.next },
    },
    queue: {
      open: open.length,
      needsReview: open.filter((set) => set.state !== 'accepted-uncommitted').length,
      expiringWithin7Days: within(7 * DAY_SECONDS),
      expiringWithin1Day: within(DAY_SECONDS),
      nextExpiresAt: open[0]?.expires_at ?? null,
    },
    quota: {
      global: usageOf(reviewQuotaUsage(db, {}), { sets: quotas.globalSets, rows: quotas.globalRows, bytes: quotas.globalBytes }),
      cardAccounts: accounts.slice(0, OWNER_LIST_LIMITS.cardAccounts).map((cardAccountRef) => ({
        cardAccountRef,
        ...usageOf(reviewQuotaUsage(db, { cardAccountId: cardAccountRef }),
          { sets: quotas.accountSets, rows: quotas.accountRows, bytes: quotas.accountBytes }),
      })),
      devices: quotaDevices.map((device) => ({
        deviceId: device.deviceId,
        ...usageOf(reviewQuotaUsage(db, { deviceId: device.deviceId }), { sets: quotas.deviceSets, rows: quotas.deviceRows, bytes: quotas.deviceBytes }),
      })),
    },
  };
}

export interface OwnerAuthorityItems {
  devices: OwnerDevice;
  bindings: OwnerBinding;
  pairings: OwnerPairing;
  'binding-devices': BindingAuthorityEntry;
}

/** Every continuation rechecks the generation inside the same read snapshot as its rows and counts. */
export function ownerAuthorityPage<K extends AuthorityKind>(ctx: CardSyncContext, input: AuthorityQuery & { kind: K }) {
  const page = authorityRows(ctx, input);
  const items = page.rows.map((row) => {
    switch (input.kind) {
      case 'devices': return ownerDevice(ctx.db, getCardSyncDevice(ctx.db, row.id)!, ctx.now);
      case 'bindings': return ownerBindingById(ctx, row.id)!;
      case 'pairings': return ownerPairing(ctx.db, getCardSyncPairing(ctx.db, row.id)!, ctx.now);
      case 'binding-devices': return {
        deviceId: row.id, status: row.status!, enabled: row.enabled === 1, consentedAt: row.consentedAt ?? null,
      };
    }
  }) as OwnerAuthorityItems[K][];
  const limits = readCardSyncSettings(ctx.db).quotas;
  const quota = input.kind === 'devices' ? page.rows.map((row) => ({
    deviceId: row.id, ...usageOf(reviewQuotaUsage(ctx.db, { deviceId: row.id }),
      { sets: limits.deviceSets, rows: limits.deviceRows, bytes: limits.deviceBytes }),
  })) : undefined;
  return { items, total: page.total, active: page.active, next: page.next, quota };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Authorization changes answered in the owner's shapes (one transaction each)
// ---------------------------------------------------------------------------------------------------------------------------

const answered = <T, U>(change: CardSyncAuthChange<T>, shape: (value: T) => U): CardSyncAuthChange<U> =>
  ({ value: shape(change.value), changed: change.changed, authorizationGeneration: change.authorizationGeneration });

type Step = CardSyncGenerationStep;

export const ownerPause = (ctx: CardSyncContext, input: { actorRef: string } & Step) =>
  answered(pauseCardSync(ctx, input), ownerSettings);
export const ownerResume = (ctx: CardSyncContext, input: { expectedVersion: number; actorRef: string } & Step) =>
  answered(resumeCardSync(ctx, input), ownerSettings);
export const ownerEnableIssuer = (ctx: CardSyncContext, input: Parameters<typeof enableCardSyncIssuer>[1]) =>
  answered(enableCardSyncIssuer(ctx, input), ownerSettings);
export const ownerDisableIssuer = (ctx: CardSyncContext, input: Parameters<typeof disableCardSyncIssuer>[1]) =>
  answered(disableCardSyncIssuer(ctx, input), ownerSettings);

export const ownerCreateBinding = (ctx: CardSyncContext, input: Parameters<typeof createCardSourceBinding>[1]) =>
  answered(createCardSourceBinding(ctx, input), (view) => ownerBinding(ctx, view));
export const ownerConfirmBinding = (ctx: CardSyncContext, input: Parameters<typeof confirmCardSourceBinding>[1]) =>
  answered(confirmCardSourceBinding(ctx, input), (view) => ownerBinding(ctx, view));
export const ownerRetireBinding = (ctx: CardSyncContext, input: Parameters<typeof retireCardSourceBinding>[1]) =>
  answered(retireCardSourceBinding(ctx, input), (view) => ownerBinding(ctx, view));
export const ownerSetAutoSync = (ctx: CardSyncContext, input: Parameters<typeof setCardSyncAutoSync>[1]) =>
  answered(setCardSyncAutoSync(ctx, input), (view) => ownerBinding(ctx, view));

export const ownerCreatePairing = (ctx: CardSyncContext, input: Parameters<typeof createCardSyncPairing>[1]) =>
  answered(createCardSyncPairing(ctx, input), (view) => ownerPairing(ctx.db, view, ctx.now));
export const ownerCancelPairing = (ctx: CardSyncContext, input: Parameters<typeof cancelCardSyncPairing>[1]) =>
  answered(cancelCardSyncPairing(ctx, input), (view) => ownerPairing(ctx.db, view, ctx.now));
const pairingAndDevice = (ctx: CardSyncContext) => (both: { pairing: CardSyncPairingView; device: CardSyncDeviceView }) =>
  ({ pairing: ownerPairing(ctx.db, both.pairing, ctx.now), device: ownerDevice(ctx.db, both.device, ctx.now) });
export const ownerApprovePairing = (ctx: CardSyncContext, input: Parameters<typeof approveCardSyncPairing>[1]) =>
  answered(approveCardSyncPairing(ctx, input), pairingAndDevice(ctx));
export const ownerRejectPairing = (ctx: CardSyncContext, input: Parameters<typeof rejectCardSyncPairing>[1]) =>
  answered(rejectCardSyncPairing(ctx, input), pairingAndDevice(ctx));

export const ownerRevokeDevice = (ctx: CardSyncContext, input: {
  deviceId: string; reason: 'owner' | 'password-reset'; actor: CardSyncRevokeActor;
} & Step) => answered(revokeCardSyncDevice(ctx, input), (view) => ownerDevice(ctx.db, view, ctx.now));
export const ownerRegrantDevice = (ctx: CardSyncContext, input: Parameters<typeof regrantCardSyncDevice>[1]) =>
  answered(regrantCardSyncDevice(ctx, input), (view) => ownerDevice(ctx.db, view, ctx.now));

/** A device's owner view by id, or null; `getCardSyncPairing` likewise for an invitation. */
export function ownerDeviceById(ctx: CardSyncContext, deviceId: string): OwnerDevice | null {
  const view = getCardSyncDevice(ctx.db, deviceId);
  return view ? ownerDevice(ctx.db, view, ctx.now) : null;
}
export function ownerPairingById(ctx: CardSyncContext, pairingId: string): OwnerPairing | null {
  const view = getCardSyncPairing(ctx.db, pairingId);
  return view ? ownerPairing(ctx.db, view, ctx.now) : null;
}

/** The devices a password reset revokes (E1b §10 item 6): every one of the user's browsers not yet revoked, expired ones too. */
export function devicesToRevokeForReset(ctx: CardSyncContext, ownerRef: string): string[] {
  return listCardSyncDevices(ctx.db, { ownerRef }).filter((device) => device.status !== 'revoked').map((device) => device.deviceId);
}

/**
 * What authority remains (E1b §5.8: the recovery CLI verifies that no device resolves, no plan is prepared and everything is
 * off before it opens the gate). Counts only.
 */
export interface CardSyncRemainingAuthority {
  generation: string;
  resolvingDevices: number;
  activeGrants: number;
  preparedPlans: number;
  openRuns: number;
  openPairings: number;
  paused: boolean;
  enabledIssuers: number;
}

export function remainingCardSyncAuthority(ctx: CardSyncContext): CardSyncRemainingAuthority {
  const count = (sql: string) => cachedStatement(ctx.db, sql).pluck().get() as number;
  const policy = cachedStatement(ctx.db, "SELECT paused, authorization_generation FROM card_sync_policy WHERE id = 'card-sync-policy'").get() as
    { paused: number; authorization_generation: string };
  return {
    generation: policy.authorization_generation,
    resolvingDevices: count("SELECT count(*) FROM card_sync_devices WHERE status IN ('pending', 'active')"),
    activeGrants: count("SELECT count(*) FROM card_sync_device_scopes WHERE status = 'active'"),
    preparedPlans: count("SELECT count(*) FROM card_sync_commit_plans WHERE status = 'prepared'"),
    openRuns: count("SELECT count(*) FROM card_sync_runs WHERE acceptance_state = 'open'"),
    openPairings: count("SELECT count(*) FROM card_sync_pairings WHERE status IN ('open', 'redeemed')"),
    paused: policy.paused === 1,
    enabledIssuers: count('SELECT count(*) FROM card_sync_issuer_policy WHERE enabled = 1'),
  };
}
