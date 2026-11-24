/**
 * The fake Holdr's answers: its records turned into exactly the wire objects
 * Holdr's owner API answers (ISO times, exact keys, nullable fields
 * present). The client's strict parsers check every one of them in the tests.
 */
import {
  CARD_SYNC_COMPLETENESS,
  CARD_SYNC_ISSUERS,
  type CardSyncCompleteness,
  type CardSyncTermination,
} from '@finance-tracker/shared';
import {
  OPEN_SET_STATES,
  PLAN_EFFECTS_PAGE,
  SET_ITEMS_PAGE,
  type Binding,
  type CoverageEntry,
  type Device,
  type Effect,
  type EffectPage,
  type OwnerState,
  type Pairing,
  type Plan,
  type ReviewItem,
  type RowView,
  type RunDetail,
  type RunState,
  type RunSummary,
  type SetDetail,
  type SetSummary,
  type Settings,
  type TxnValues,
} from '../ownerApi';
import {
  DAY,
  LIMITS,
  QUOTA_LIMITS,
  iso,
  itemsCursor,
  pageCursor,
  rowAt,
  type BindingRec,
  type CandidateRec,
  type DeviceRec,
  type EffectRec,
  type FakeStore,
  type ItemRec,
  type PairingRec,
  type PlanRec,
  type RunRec,
  type SetRec,
} from './model';

const isoOrNull = (ms: number | null) => (ms === null ? null : iso(ms));

export function isOpenSet(set: SetRec): boolean {
  return OPEN_SET_STATES.includes(set.state);
}

/** A run's own state (Q36): accepted, refused, stopped by the extension, closed without anything received, or still open. */
export function runStateOf(run: RunRec, now: number): RunState {
  if (run.observationSetId !== null) return 'accepted';
  if (run.errorCode !== null) return 'refused';
  if (run.abortReason !== null) return 'aborted';
  if (run.expiredAt !== null || run.runExpiresAt <= now) return 'expired';
  return 'open';
}

/** The browsers that hold a current grant for a binding: active or awaiting approval, never a lapsed (stale) grant. */
export function grantHolders(store: FakeStore, bindingId: string, statuses: ReadonlyArray<DeviceRec['status']> = ['active']): DeviceRec[] {
  return store.devices.filter((device) => statuses.includes(device.status) && device.bindingIds.includes(bindingId));
}

export function settingsView(store: FakeStore): Settings {
  return {
    paused: store.paused,
    pausedAt: isoOrNull(store.pausedAt),
    settingsVersion: store.settingsVersion,
    issuers: CARD_SYNC_ISSUERS.map((issuer) => ({
      issuer,
      enabled: store.issuers[issuer].enabled,
      enabledAt: isoOrNull(store.issuers[issuer].enabledAt),
    })),
  };
}

export function coverageView(set: SetRec): CoverageEntry[] {
  if (!set.payload) return [];
  const observedAt = set.payload.observedAt;
  return set.payload.coverage.map((entry) => ({
    cardScopeId: entry.cardScopeId,
    status: entry.status,
    requested: entry.requested ? { ...entry.requested } : null,
    observed: entry.observed ? { ...entry.observed } : null,
    completeness: entry.completeness,
    termination: entry.termination,
    pageCount: entry.pageCount,
    observedAt,
  }));
}

function weakest(values: CardSyncCompleteness[]): CardSyncCompleteness | null {
  if (values.length === 0) return null;
  return values.reduce((low, value) => (CARD_SYNC_COMPLETENESS.indexOf(value) < CARD_SYNC_COMPLETENESS.indexOf(low) ? value : low));
}

export function latestPlan(set: SetRec): PlanRec | null {
  return set.plans.length > 0 ? set.plans[set.plans.length - 1] : null;
}

export function bindingView(store: FakeStore, binding: BindingRec, now: number): Binding {
  const runs = store.runs.filter((run) => run.bindingId === binding.bindingId).sort((a, b) => b.createdAt - a.createdAt);
  const sets = store.sets.filter((set) => set.bindingId === binding.bindingId).sort((a, b) => b.acceptedAt - a.acceptedAt);
  const lastRun = runs[0] ?? null;
  const lastSet = lastRun?.observationSetId ? store.sets.find((set) => set.observationSetId === lastRun.observationSetId) ?? null : null;
  const newestAccepted = sets.find((set) => set.payload !== null) ?? null;
  const committed = sets.filter((set) => set.committedAt !== null).map((set) => set.committedAt as number);
  const lastPlan = lastSet ? latestPlan(lastSet) : null;
  const terminations = lastSet?.payload
    ? [...new Set(lastSet.payload.coverage.map((entry) => entry.termination))] as CardSyncTermination[]
    : [];
  return {
    bindingId: binding.bindingId,
    bindingVersion: binding.bindingVersion,
    issuer: binding.issuer,
    source: binding.source,
    bindingLabel: binding.bindingLabel,
    cardAccountRef: binding.cardAccountRef,
    status: binding.status,
    statusReason: binding.statusReason,
    confirmedAt: isoOrNull(binding.confirmedAt),
    scopes: binding.scopes.map((scope) => ({ ...scope })),
    autoSync: {
      gate: binding.autoSyncGate,
      eligible: binding.autoSyncEligible,
      revision: binding.autoSyncRevision,
      devices: grantHolders(store, binding.bindingId).map((device) => {
        const consentedAt = binding.autoSyncConsent.get(device.deviceId) ?? null;
        return { deviceId: device.deviceId, enabled: consentedAt !== null, consentedAt: isoOrNull(consentedAt) };
      }),
    },
    deviceIds: grantHolders(store, binding.bindingId, ['active', 'pending']).map((device) => device.deviceId),
    sync: {
      lastRun: lastRun ? {
        runId: lastRun.runId,
        deviceId: lastRun.deviceId,
        createdAt: iso(lastRun.createdAt),
        runExpiresAt: iso(lastRun.runExpiresAt),
        runState: runStateOf(lastRun, now),
        abortReason: lastRun.abortReason,
        acceptance: lastSet ? lastSet.state : 'none',
        ledger: lastSet?.committedAt ? 'committed' : 'none',
        observationSetId: lastSet?.observationSetId ?? null,
        observationExpiresAt: lastSet ? iso(lastSet.expiresAt) : null,
        planExpiresAt: lastPlan ? iso(lastPlan.expiresAt) : null,
        terminations,
        completeness: lastSet?.payload ? weakest(lastSet.payload.coverage.map((entry) => entry.completeness)) : null,
      } : null,
      lastAcceptedAt: sets[0] ? iso(sets[0].acceptedAt) : null,
      lastCommittedAt: committed.length > 0 ? iso(Math.max(...committed)) : null,
      openSets: sets.filter(isOpenSet).length,
      coverage: newestAccepted ? coverageView(newestAccepted) : [],
    },
  };
}

export function deviceView(device: DeviceRec): Device {
  return {
    deviceId: device.deviceId,
    deviceLabel: device.deviceLabel,
    clientVersion: device.clientVersion,
    status: device.status,
    fingerprint: device.fingerprint,
    pairingId: device.pairingId,
    createdAt: iso(device.createdAt),
    pendingExpiresAt: device.status === 'pending' || (device.status === 'expired' && device.approvedAt === null) ? isoOrNull(device.pendingExpiresAt) : null,
    approvedAt: isoOrNull(device.approvedAt),
    deviceExpiresAt: isoOrNull(device.deviceExpiresAt),
    lastSeenAt: isoOrNull(device.lastSeenAt),
    revokedAt: isoOrNull(device.revokedAt),
    revokeReason: device.revokeReason,
    bindingIds: [...device.bindingIds],
    staleBindingIds: [...device.staleBindingIds],
  };
}

export function pairingView(store: FakeStore, pairing: PairingRec): Pairing {
  const device = pairing.deviceId ? store.devices.find((item) => item.deviceId === pairing.deviceId) ?? null : null;
  return {
    pairingId: pairing.pairingId,
    status: pairing.status,
    createdAt: iso(pairing.createdAt),
    expiresAt: iso(pairing.expiresAt),
    bindingIds: [...pairing.bindingIds],
    replacesDeviceId: pairing.replacesDeviceId,
    deviceId: device?.deviceId ?? null,
    deviceLabel: device?.deviceLabel ?? null,
    fingerprint: device?.fingerprint ?? null,
    pendingExpiresAt: device && device.status === 'pending' ? isoOrNull(device.pendingExpiresAt) : null,
    failedAttempts: pairing.failedAttempts,
  };
}

interface Usage { sets: number; rows: number; bytes: number }
function usage(sets: SetRec[], padding?: Usage): Usage {
  const open = sets.filter(isOpenSet);
  return {
    sets: open.length + (padding?.sets ?? 0),
    rows: open.reduce((sum, set) => sum + set.rowCount, 0) + (padding?.rows ?? 0),
    bytes: open.reduce((sum, set) => sum + set.byteCount, 0) + (padding?.bytes ?? 0),
  };
}
function quotaUsage(used: Usage, limit: Usage) {
  return {
    sets: { used: used.sets, limit: limit.sets },
    rows: { used: used.rows, limit: limit.rows },
    bytes: { used: used.bytes, limit: limit.bytes },
  };
}

export function stateView(store: FakeStore, now: number): OwnerState {
  const open = store.sets.filter(isOpenSet);
  const accountRefs = [...new Set([...store.bindings.map((binding) => binding.cardAccountRef), ...store.sets.map((set) => set.cardAccountRef)])];
  const setsOf = (ref: string) => store.sets.filter((set) => set.cardAccountRef === ref);
  const totalPadding = [...store.quotaPadding.values()].reduce((sum, item) => ({
    sets: sum.sets + item.sets, rows: sum.rows + item.rows, bytes: sum.bytes + item.bytes,
  }), { sets: 0, rows: 0, bytes: 0 });
  const recentClosed = (pairing: PairingRec) => pairing.status === 'open' || pairing.status === 'redeemed'
    || (pairing.closedAt !== null && now - pairing.closedAt <= DAY);
  const visibleDevice = (device: DeviceRec) => device.status === 'active' || device.status === 'pending'
    || now - (device.revokedAt ?? device.deviceExpiresAt ?? now) <= 30 * DAY;
  const expiries = open.map((set) => set.expiresAt).sort((a, b) => a - b);
  return {
    generatedAt: iso(now),
    holdrOrigin: store.holdrOrigin,
    deviceApi: store.deviceApi,
    gate: store.gate,
    recoveredAt: isoOrNull(store.recoveredAt),
    contractVersions: [1],
    limits: { ...LIMITS },
    settings: settingsView(store),
    bindings: store.bindings.map((binding) => bindingView(store, binding, now)),
    devices: store.devices.filter(visibleDevice).map(deviceView),
    pairings: store.pairings.filter(recentClosed).map((pairing) => pairingView(store, pairing)),
    queue: {
      open: open.length,
      needsReview: open.filter((set) => set.items.some((entry) => entry.decision === null)).length,
      expiringWithin7Days: open.filter((set) => set.expiresAt - now <= 7 * DAY).length,
      expiringWithin1Day: open.filter((set) => set.expiresAt - now <= DAY).length,
      nextExpiresAt: expiries.length > 0 ? iso(expiries[0]) : null,
    },
    quota: {
      global: quotaUsage(usage(store.sets, totalPadding), QUOTA_LIMITS.global),
      cardAccounts: accountRefs.map((ref) => ({ cardAccountRef: ref, ...quotaUsage(usage(setsOf(ref), store.quotaPadding.get(ref)), QUOTA_LIMITS.cardAccount) })),
      devices: store.devices
        .filter((device) => device.status === 'active' || device.status === 'pending')
        .map((device) => ({ deviceId: device.deviceId, ...quotaUsage(usage(store.sets.filter((set) => set.deviceId === device.deviceId)), QUOTA_LIMITS.device) })),
    },
  };
}

function planRefView(plan: PlanRec | null): SetSummary['plan'] {
  return plan ? { previewId: plan.previewId, createdAt: iso(plan.createdAt), expiresAt: iso(plan.expiresAt), state: plan.state } : null;
}

export function setSummaryView(set: SetRec): SetSummary {
  const counts = new Map<ItemRec['category'], number>();
  for (const entry of set.items) counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
  return {
    observationSetId: set.observationSetId,
    sourceKind: set.origin,
    runId: set.runId,
    bindingId: set.bindingId,
    deviceId: set.deviceId,
    importBatchId: set.importBatchId,
    cardAccountRef: set.cardAccountRef,
    version: set.version,
    state: set.state,
    acceptedAt: iso(set.acceptedAt),
    expiresAt: iso(set.expiresAt),
    rowCount: set.rowCount,
    byteCount: set.byteCount,
    reviewCount: isOpenSet(set) ? set.items.filter((entry) => entry.decision === null).length : 0,
    categories: [...counts.entries()].map(([category, count]) => ({ category, count })),
    plan: planRefView(latestPlan(set)),
    committedAt: isoOrNull(set.committedAt),
    closedAt: isoOrNull(set.closedAt),
    closeReason: set.closeReason,
  };
}

export function rowView(set: SetRec, rowIndex: number): RowView | null {
  const row = rowAt(set, rowIndex);
  if (!row) return null;
  return { rowIndex, ...row };
}

function candidateView(candidate: CandidateRec): ReviewItem['candidates'][number] {
  const { removedFrom: _removedFrom, ...wire } = candidate;
  return { ...wire, matchedOn: [...candidate.matchedOn] };
}

function itemView(set: SetRec, entry: ItemRec, offersActions: boolean): ReviewItem {
  return {
    itemId: entry.itemId,
    category: entry.category,
    rowIndex: entry.rowIndex,
    reason: entry.reason,
    observation: entry.rowIndex === null ? null : rowView(set, entry.rowIndex),
    candidates: entry.candidates.map(candidateView),
    difference: entry.difference ? { ...entry.difference } : null,
    allowedActions: offersActions ? [...entry.allowedActions] : [],
    decision: entry.decision ? {
      itemId: entry.itemId, action: entry.decision.action, transactionId: entry.decision.transactionId,
      cardScopeId: entry.decision.cardScopeId, decidedAt: iso(entry.decision.at),
    } : null,
    committed: entry.committed ? {
      itemId: entry.itemId, action: entry.committed.action, transactionId: entry.committed.transactionId,
      cardScopeId: entry.committed.cardScopeId, committedAt: iso(entry.committed.at),
    } : null,
  };
}

/**
 * A set's items in the order Holdr pages them (R7, revision 4): the set-level item first, then the rows in observation
 * order. `itemCount` counts the same items.
 */
export function orderedItems(set: SetRec): ItemRec[] {
  return [...set.items].sort((a, b) => (a.rowIndex ?? -1) - (b.rowIndex ?? -1));
}

/**
 * One page of a set's detail; its next cursor pins the set's version, the account's ledger revision and whether the set is
 * past its deadline (R7; X38). A committed set past its `expiresAt` stays committed and offers no action (C3): Spending's own
 * tools and the repairs change it then.
 */
export function setDetailView(set: SetRec, ledgerRevision: number, now: number, offset = 0): SetDetail {
  const end = offset + SET_ITEMS_PAGE;
  const items = orderedItems(set);
  const pastDeadline = set.expiresAt <= now;
  const offersActions = !(set.state === 'committed' && pastDeadline);
  return {
    ...setSummaryView(set),
    currency: 'USD',
    payloadDigest: set.payloadDigest,
    receiptExpiresAt: isoOrNull(set.receiptExpiresAt),
    rejectedCount: set.rejectedCount,
    coverage: coverageView(set),
    itemCount: items.length,
    items: items.slice(offset, end).map((entry) => itemView(set, entry, offersActions)),
    nextItemsCursor: end < items.length
      ? itemsCursor(set.observationSetId, { offset: end, version: set.version, ledgerRevision, pastDeadline })
      : null,
  };
}

export function txnFromCandidate(candidate: CandidateRec): TxnValues {
  return {
    status: candidate.status,
    transactionDate: candidate.transactionDate,
    postedDate: candidate.postedDate,
    amountMinor: candidate.amountMinor,
    kind: candidate.kind,
    description: candidate.description,
    merchant: candidate.merchant,
    cardScopeId: candidate.cardScopeId,
  };
}

export function txnFromRow(set: SetRec, rowIndex: number): TxnValues | null {
  const row = rowAt(set, rowIndex);
  if (!row) return null;
  return {
    status: row.status,
    transactionDate: row.transactionDate,
    postedDate: row.postedDate,
    amountMinor: row.amountMinor,
    kind: row.kind,
    description: row.description,
    merchant: row.merchant,
    cardScopeId: row.cardScopeId,
  };
}

function effectView(effect: EffectRec): Effect {
  return { ...effect, before: effect.before ? { ...effect.before } : null, after: effect.after ? { ...effect.after } : null };
}

export function planView(plan: PlanRec, set: SetRec): Plan {
  return {
    previewId: plan.previewId,
    observationSetId: plan.observationSetId,
    setVersion: plan.setVersion,
    planKind: plan.planKind,
    payloadDigest: plan.payloadDigest,
    planDigest: plan.planDigest,
    createdAt: iso(plan.createdAt),
    expiresAt: iso(plan.expiresAt),
    observationExpiresAt: iso(set.expiresAt),
    counts: { ...plan.counts },
    effectCount: plan.effects.length,
    effects: plan.effects.slice(0, PLAN_EFFECTS_PAGE).map(effectView),
    nextEffectsCursor: plan.effects.length > PLAN_EFFECTS_PAGE ? pageCursor('effects', plan.previewId, PLAN_EFFECTS_PAGE) : null,
  };
}

/**
 * A later page of a plan's effects (R7), echoing the plan's digest and state (revision 4). The state maps E1b's plan status
 * (X42): prepared → `valid` (or `expired` once past `expiresAt`), consumed → `committed`, expired → `expired`, cancelled for
 * any reason → `superseded`.
 */
export function effectPageView(plan: PlanRec, offset: number, now: number): EffectPage {
  const end = offset + PLAN_EFFECTS_PAGE;
  return {
    previewId: plan.previewId,
    planDigest: plan.planDigest,
    state: plan.state === 'valid' && plan.expiresAt <= now ? 'expired' : plan.state,
    effects: plan.effects.slice(offset, end).map(effectView),
    nextCursor: end < plan.effects.length ? pageCursor('effects', plan.previewId, end) : null,
  };
}

export function runSummaryView(store: FakeStore, run: RunRec, now: number): RunSummary {
  const set = run.observationSetId ? store.sets.find((item) => item.observationSetId === run.observationSetId) ?? null : null;
  const device = store.devices.find((item) => item.deviceId === run.deviceId);
  const binding = store.bindings.find((item) => item.bindingId === run.bindingId);
  return {
    runId: run.runId,
    deviceId: run.deviceId,
    deviceLabel: device?.deviceLabel ?? 'Unknown device',
    bindingId: run.bindingId,
    bindingVersion: run.bindingVersion,
    issuer: binding?.issuer ?? 'chase',
    source: binding?.source ?? 'chase-api',
    trigger: run.trigger,
    clientRunId: run.clientRunId,
    adapterVersion: run.adapterVersion,
    contractVersion: run.contractVersion,
    createdAt: iso(run.createdAt),
    runExpiresAt: iso(run.runExpiresAt),
    acceptance: set ? set.state : 'none',
    ledger: set?.committedAt ? 'committed' : 'none',
    observationSetId: set?.observationSetId ?? null,
    payloadDigest: set?.payloadDigest ?? null,
    acceptedAt: set ? iso(set.acceptedAt) : null,
    committedAt: isoOrNull(set?.committedAt ?? null),
    rowCount: set ? set.rowCount : null,
    runState: runStateOf(run, now),
    abortReason: run.abortReason,
    errorCode: run.errorCode,
  };
}

export function runDetailView(store: FakeStore, run: RunRec, now: number): RunDetail {
  const set = run.observationSetId ? store.sets.find((item) => item.observationSetId === run.observationSetId) ?? null : null;
  const committedPlan = set?.plans.slice().reverse().find((plan) => plan.state === 'committed') ?? null;
  let results: RunDetail['results'] = [];
  // E2a lists each row's result only while the set's content is kept, and never for a review that expired: its rows have no
  // result of their own (handoff 10/18 02:30 item 4).
  if (set?.payload && set.state !== 'expired-unreviewed') {
    if (set.state === 'committed') {
      results = set.results.map((entry) => ({ ...entry }));
    } else {
      const reviewRows = new Set(set.items.map((entry) => entry.rowIndex).filter((index): index is number => index !== null));
      results = set.payload.rows.map((_row, rowIndex) => ({
        rowIndex,
        result: reviewRows.has(rowIndex) ? 'needs-review' : 'waiting',
        transactionId: null,
      }));
    }
  }
  return {
    ...runSummaryView(store, run, now),
    observationExpiresAt: set ? iso(set.expiresAt) : null,
    receiptExpiresAt: isoOrNull(set?.receiptExpiresAt ?? null),
    receiptAvailable: Boolean(set?.receiptExpiresAt && set.receiptExpiresAt > now && set.payload),
    contentRetained: Boolean(set?.payload),
    rejectedCount: set ? set.rejectedCount : null,
    coverage: set ? coverageView(set) : [],
    counts: committedPlan ? { ...committedPlan.counts } : null,
    results,
  };
}
