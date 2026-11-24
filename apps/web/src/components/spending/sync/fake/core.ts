/**
 * The fake Holdr's owner-side behaviour: every mutation the owner API offers,
 * with its checks (recent auth, versions, pause, gate, deployment switch),
 * idempotency and expiry, plus the test hooks that stand in for the
 * extension (redeeming a pairing code) and for Holdr's local recovery tool.
 */
import { CARD_SYNC_ISSUERS, CARD_SYNC_SOURCE_SPECS, type CardSyncIssuer } from '@finance-tracker/shared';
import {
  sameDecision,
  type AbortReason,
  type ConfirmBindingRequest,
  type CreateBindingRequest,
  type Decision,
  type DiscardReason,
  type OwnerErrorCode,
  type RunErrorCode,
} from '../ownerApi';
import {
  DAY,
  FAKE_OWNER_PASSWORD,
  LIMITS,
  MINUTE,
  RECENT_AUTH_MS,
  fingerprintFor,
  ownerIdFor,
  pairingCodeFor,
  rowAt,
  syncIdFor,
  type BindingRec,
  type DeviceRec,
  type FakeStore,
  type PairingRec,
  type RunRec,
  type SetRec,
} from './model';
import {
  activeIdentitiesOf,
  aliasesMovedBy,
  bumpLedgerRevision,
  detachIdentityOf,
  eventsSeqOf,
  keysetOf,
  latestMergeEvent,
  repointIdentityTo,
  revertRow,
  revertibleEvent,
  unmergeRow,
  type EventSource,
  type IdentityRec,
  type LedgerRowRec,
  type SourcesPage,
} from './ledger';
import { adjustmentReversible, applyLedgerCommit, commitMarkOf, itemAdjustable, scopeKindOf } from './ledgerSeed';
import { applyCommit, computePlan, planDigestFor } from './planner';
import { closeWithoutContent, unknownScope } from './scenario';
import { grantHolders, isOpenSet, latestPlan, runStateOf } from './views';

/** The owner's repairs of proposal §3.8 write their events with reason `maintenance` (E1b §5.7.1). */
const MAINTENANCE: EventSource = { via: 'session', actor: 'owner', deviceId: null, reason: 'maintenance' };

/** A refusal with a fixed code; the HTTP layer turns it into `{"error": code}`. */
export class FakeRefusal extends Error {
  constructor(readonly status: number, readonly code: OwnerErrorCode | 'unauthorized', readonly extra: Record<string, unknown> = {}) {
    super(code);
  }
}

const refuse = (status: number, code: OwnerErrorCode | 'unauthorized', extra: Record<string, unknown> = {}): never => {
  throw new FakeRefusal(status, code, extra);
};

export class FakeOwnerCore {
  constructor(readonly store: FakeStore, readonly now: () => number) {}

  nextId(label: string): string {
    this.store.counter += 1;
    return `${label}/${this.store.counter}`;
  }

  // ---- expiry -------------------------------------------------------------

  /** Applies every expiry that has come due, as E2's clean-up would. */
  tick(): void {
    const now = this.now();
    for (const pairing of this.store.pairings) {
      if (pairing.status === 'open' && pairing.expiresAt <= now) this.closePairing(pairing, 'expired', pairing.expiresAt);
    }
    for (const device of this.store.devices) {
      // E1b §5.9 phase 2: a browser whose time ran out is expired, not revoked, and the owner API gives no reason. Time-based,
      // so no authorization change, and the auto-sync revision doesn't move (a browser dropping out never widens an "on").
      if (device.status === 'pending' && device.pendingExpiresAt !== null && device.pendingExpiresAt <= now) {
        device.status = 'expired';
        const pairing = this.store.pairings.find((item) => item.pairingId === device.pairingId);
        if (pairing && pairing.status === 'redeemed') this.closePairing(pairing, 'expired', device.pendingExpiresAt);
      }
      // E1b revision 4 (plan §6.4 step 5): its grants and their consent end, but what it already sent stays as it was. The
      // owner reviews it without a source check and its plans stay good; only a revoke or a binding change holds it.
      if (device.status === 'active' && device.deviceExpiresAt !== null && device.deviceExpiresAt <= now) {
        device.status = 'expired';
        this.endGrants(device, true, false);
      }
    }
    for (const set of this.store.sets) {
      for (const plan of set.plans) if (plan.state === 'valid' && plan.expiresAt <= now) plan.state = 'expired';
      // Retention's chunks move the version of every set whose listed items or fields they change (E1b revision 7, X38:
      // `touch-set`), so a page read before them is refused: the expiry of an open set, and giving up its receipt.
      if (isOpenSet(set) && set.expiresAt <= now) {
        closeWithoutContent(set, 'expired-unreviewed', set.expiresAt, 'expired');
        set.version += 1;
      }
      if (set.receiptExpiresAt !== null && set.receiptExpiresAt <= now) {
        set.receiptExpiresAt = null;
        set.version += 1;
      }
    }
  }

  // ---- guards ---------------------------------------------------------------

  requireRecentAuth(): void {
    if (this.store.recentAuthUntil < this.now()) refuse(403, 'recent-auth-required');
  }

  requireOpenGate(): void {
    if (this.store.gate !== 'open') refuse(409, 'authorization-blocked');
  }

  requireVersion(actual: number, expected: number): void {
    if (actual !== expected) refuse(409, 'version-conflict', { currentVersion: actual });
  }

  binding(bindingId: string): BindingRec {
    return this.store.bindings.find((item) => item.bindingId === bindingId) ?? refuse(404, 'not-found');
  }

  set(observationSetId: string): SetRec {
    return this.store.sets.find((item) => item.observationSetId === observationSetId) ?? refuse(404, 'not-found');
  }

  plan(previewId: string): SetRec['plans'][number] {
    for (const set of this.store.sets) {
      const plan = set.plans.find((item) => item.previewId === previewId);
      if (plan) return plan;
    }
    return refuse(404, 'not-found');
  }

  /**
   * Paused globally, or the binding's issuer is off: nothing may be planned or committed (plan §2.4: every prepare and
   * commit checks). These checks are about the browser that sent a set, so a file set skips them (E1b §5.0).
   */
  requireSyncAllowed(set: SetRec): void {
    if (set.origin === 'file' || set.bindingId === null) return;
    const binding = this.binding(set.bindingId);
    if (this.store.paused || !this.store.issuers[binding.issuer].enabled) refuse(409, 'sync-paused');
    this.requireOpenGate();
    if (binding.status !== 'confirmed') refuse(409, binding.status === 'retired' ? 'binding-retired' : 'binding-needs-reconfirmation');
  }

  /** The known cards a set's rows may be put on: its binding's, or for a file set every live binding's of that card account. */
  knownScopesFor(set: SetRec): string[] {
    const bindings = set.bindingId !== null
      ? [this.binding(set.bindingId)]
      : this.store.bindings.filter((binding) => binding.cardAccountRef === set.cardAccountRef && binding.status !== 'retired');
    return bindings.flatMap((binding) => binding.scopes.filter((scope) => scope.kind === 'known' && scope.status === 'active').map((scope) => scope.cardScopeId));
  }

  /** A committed set takes changed decisions only until its acceptance expires; after that, the ledger tools (Q34). */
  requireAdjustable(set: SetRec): void {
    if (set.state === 'committed' && set.expiresAt <= this.now()) refuse(410, 'observation-expired');
  }

  // ---- shared effects ---------------------------------------------------------

  private cancelPlans(predicate: (set: SetRec) => boolean): void {
    for (const set of this.store.sets) {
      if (!predicate(set)) continue;
      for (const plan of set.plans) if (plan.state === 'valid') plan.state = 'superseded';
    }
  }

  /**
   * E1b §5.0: every authorization change advances the generation, and that cancels every prepared plan of an extension set
   * (a file set's plan pins no generation). Called only when something changed: a repeat that changes nothing advances nothing.
   */
  private authorizationChanged(): void {
    this.cancelPlans((set) => set.origin === 'extension');
  }

  /** A browser stopped working: its sets' plans are cancelled and its open sets wait for a source check. */
  private blockSetsOf(device: DeviceRec): void {
    this.cancelPlans((set) => set.deviceId === device.deviceId);
    for (const set of this.store.sets) {
      if (set.deviceId === device.deviceId && (set.state === 'accepted-uncommitted' || set.state === 'needs-review')) {
        set.state = 'blocked-review';
        set.version += 1;
      }
    }
  }

  private closePairing(pairing: PairingRec, status: PairingRec['status'], at: number): void {
    pairing.status = status;
    pairing.closedAt = at;
  }

  private revokeRecord(device: DeviceRec, reason: NonNullable<DeviceRec['revokeReason']>, at: number): void {
    if (device.status === 'revoked') return;
    if (device.status === 'expired') {
      // E1b §5.3 (revisions 5 and 6, K19, Q49): a browser whose time ran out is still closed as revoked by the owner, a password
      // reset or the approval that replaces it, whether its 30 days or its 10 minutes to be approved ran out. It keeps the time
      // it stopped working, never gains approval fields, and what it sent is held for a source check with its plans cancelled,
      // as before expiry. Rejecting or a recovery never reaches one (its invitation closed with it; recovery takes the others).
      if (reason === 'rejected' || reason === 'recovery') return;
      device.status = 'revoked';
      device.revokedAt = (device.approvedAt === null ? device.pendingExpiresAt : device.deviceExpiresAt) ?? at;
      device.revokeReason = reason;
      this.blockSetsOf(device);
      this.authorizationChanged();
      return;
    }
    const wasActive = device.status === 'active';
    // E1b revision 8 (`close-pairing-of-device`, adopting `bd84f0c`): every revocation of a pending browser (by the
    // owner, a password reset or the approval that replaces it) closes its redeemed invitation with it, so approving that
    // invitation later answers 409 `pairing-closed`. Rejecting and cancelling close it themselves; a recovery closes them all.
    if (device.status === 'pending' && (reason === 'owner' || reason === 'password-reset' || reason === 'rotated')) {
      const pairing = this.store.pairings.find((item) => item.pairingId === device.pairingId);
      if (pairing?.status === 'redeemed') this.closePairing(pairing, 'cancelled', at);
    }
    device.status = 'revoked';
    device.revokedAt = at;
    device.revokeReason = reason;
    device.pendingExpiresAt = null;
    this.blockSetsOf(device);
    // Q36: its runs still open close as expired; nothing can arrive for them any more.
    for (const run of this.store.runs) {
      if (run.deviceId === device.deviceId && runStateOf(run, at) === 'open') run.expiredAt = at;
    }
    this.endGrants(device, wasActive);
    this.authorizationChanged();
  }

  /**
   * The fence of automatic sending (R1): a binding's revision moves whenever what an "on" would authorize changes, so an
   * "on" confirmed against an older view is refused. That is every explicit "off" (even when nothing was on, as asked
   * beyond E1b revision 3), every consent written or withdrawn by an authorization change, and every grant created, allowed
   * again, revoked, or ended by confirming the binding again, retiring it or a restore (E1b §2.4). A browser's time running
   * out doesn't move it (E1b §5.9).
   */
  private fence(binding: BindingRec): void {
    binding.autoSyncRevision += 1;
  }

  /** The active grants of these bindings changed; `withdrawFrom`'s consent goes with its grant. Each binding is fenced once. */
  private grantsChanged(bindingIds: Iterable<string>, withdrawFrom: string | null = null): void {
    for (const bindingId of new Set(bindingIds)) {
      const binding = this.store.bindings.find((item) => item.bindingId === bindingId);
      if (!binding) continue;
      if (withdrawFrom !== null) binding.autoSyncConsent.delete(withdrawFrom);
      this.fence(binding);
    }
  }

  /**
   * A browser stopped working (revoked, rejected or expired): its consent goes, and the bindings it held lose an active grant.
   * `fence` is false only for expiry.
   */
  private endGrants(device: DeviceRec, wasActive: boolean, fence = true): void {
    const consented = this.store.bindings.filter((binding) => binding.autoSyncConsent.has(device.deviceId)).map((binding) => binding.bindingId);
    if (!fence) {
      for (const binding of this.store.bindings) binding.autoSyncConsent.delete(device.deviceId);
      return;
    }
    this.grantsChanged([...(wasActive ? device.bindingIds : []), ...consented], device.deviceId);
  }

  /** Every browser's consent for a binding is withdrawn ("off", or the binding changed); fenced even when none was given. */
  private clearAutoSync(binding: BindingRec): void {
    binding.autoSyncConsent.clear();
    this.fence(binding);
  }

  // ---- settings ---------------------------------------------------------------

  pause(): void {
    if (this.store.paused) return;
    this.store.paused = true;
    this.store.pausedAt = this.now();
    this.store.settingsVersion += 1;
    this.authorizationChanged();
  }

  resume(expectedVersion: number): void {
    this.requireRecentAuth();
    this.requireOpenGate();
    this.requireVersion(this.store.settingsVersion, expectedVersion);
    if (!this.store.paused) return;
    this.store.paused = false;
    this.store.pausedAt = null;
    this.store.settingsVersion += 1;
    this.authorizationChanged();
  }

  enableIssuer(issuer: CardSyncIssuer, expectedVersion: number, mainWorldAcknowledged: boolean): void {
    this.requireRecentAuth();
    this.requireOpenGate();
    this.requireVersion(this.store.settingsVersion, expectedVersion);
    const needsMain = Object.values(CARD_SYNC_SOURCE_SPECS).some((spec) => spec.issuer === issuer && spec.mode === 'main-passive');
    if (needsMain && !mainWorldAcknowledged) refuse(422, 'invalid-request', { issues: [{ code: 'inconsistent', path: '$.mainWorldAcknowledged' }] });
    if (this.store.issuers[issuer].enabled) return;
    this.store.issuers[issuer] = { enabled: true, enabledAt: this.now(), contractApproved: true };
    this.store.settingsVersion += 1;
    this.authorizationChanged();
  }

  disableIssuer(issuer: CardSyncIssuer): void {
    if (!this.store.issuers[issuer].enabled) return;
    this.store.issuers[issuer] = { enabled: false, enabledAt: null, contractApproved: this.store.issuers[issuer].contractApproved };
    this.store.settingsVersion += 1;
    this.authorizationChanged();
  }

  // ---- bindings -------------------------------------------------------------

  createBinding(request: CreateBindingRequest): BindingRec {
    this.requireRecentAuth();
    // E1b §5.0: creating a binding widens authority, so it needs an open gate.
    this.requireOpenGate();
    const account = this.store.cardAccounts.find((item) => item.id === request.cardAccountRef) ?? refuse(404, 'not-found');
    if (CARD_SYNC_SOURCE_SPECS[request.source].issuer !== request.issuer || account.issuer !== request.issuer
      || account.currency !== 'USD' || account.status !== 'active') {
      refuse(409, 'card-account-mismatch');
    }
    if (this.store.bindings.some((item) => item.cardAccountRef === request.cardAccountRef && item.source === request.source && item.status !== 'retired')) {
      refuse(409, 'binding-exists');
    }
    if (request.scopes.length === 0) refuse(422, 'invalid-request', { issues: [{ code: 'too-many-items', path: '$.scopes' }] });
    const key = this.nextId(`binding/${request.cardAccountRef}/${request.source}`);
    const now = this.now();
    const binding: BindingRec = {
      bindingId: syncIdFor('binding', key),
      bindingVersion: 1,
      issuer: request.issuer,
      source: request.source,
      bindingLabel: request.bindingLabel,
      cardAccountRef: request.cardAccountRef,
      status: 'confirmed',
      statusReason: null,
      confirmedAt: now,
      scopes: [
        ...request.scopes.map((draft, index) => ({
          cardScopeId: syncIdFor('cardScope', `${key}/scope/${index}`),
          kind: 'known' as const,
          scopeLabel: draft.scopeLabel,
          holderAlias: draft.holderAlias,
          last4: draft.last4,
          status: 'active' as const,
        })),
        unknownScope(key),
      ],
      autoSyncConsent: new Map(),
      autoSyncRevision: 0,
      autoSyncGate: 'closed',
      autoSyncEligible: false,
      createdAt: now,
    };
    this.store.bindings.push(binding);
    this.authorizationChanged();
    return binding;
  }

  confirmBinding(bindingId: string, request: ConfirmBindingRequest): BindingRec {
    this.requireRecentAuth();
    // E1b §5.0: confirming widens authority (it can re-grant browsers), so it needs an open gate, like `/regrant`.
    this.requireOpenGate();
    const binding = this.binding(bindingId);
    if (binding.status === 'retired') refuse(409, 'binding-retired');
    this.requireVersion(binding.bindingVersion, request.expectedVersion);
    const known = binding.scopes.filter((scope) => scope.kind === 'known');
    const listed = new Set<string>();
    request.scopes.forEach((draft, index) => {
      if (draft.cardScopeId === null) return;
      const existing = known.find((scope) => scope.cardScopeId === draft.cardScopeId);
      if (!existing || listed.has(draft.cardScopeId)) refuse(422, 'invalid-request', { issues: [{ code: 'inconsistent', path: `$.scopes[${index}].cardScopeId` }] });
      if (existing && existing.last4 !== draft.last4) refuse(422, 'invalid-request', { issues: [{ code: 'inconsistent', path: `$.scopes[${index}].last4` }] });
      listed.add(draft.cardScopeId as string);
    });
    if (request.scopes.length === 0) refuse(422, 'invalid-request', { issues: [{ code: 'too-many-items', path: '$.scopes' }] });
    // Q35: only browsers that held this binding (now or before an earlier re-confirmation) can be allowed again here.
    const regrant = request.regrantDeviceIds;
    regrant.forEach((deviceId, index) => {
      const device = this.store.devices.find((item) => item.deviceId === deviceId);
      if (!device || device.status !== 'active' || regrant.indexOf(deviceId) !== index
        || (!device.bindingIds.includes(bindingId) && !device.staleBindingIds.includes(bindingId))) {
        refuse(422, 'invalid-request', { issues: [{ code: 'inconsistent', path: `$.regrantDeviceIds[${index}]` }] });
      }
    });
    const version = binding.bindingVersion + 1;
    for (const scope of known) {
      const draft = request.scopes.find((item) => item.cardScopeId === scope.cardScopeId);
      if (draft) {
        scope.scopeLabel = draft.scopeLabel;
        scope.holderAlias = draft.holderAlias;
        scope.status = 'active';
      } else {
        scope.status = 'retired';
      }
    }
    request.scopes.forEach((draft, index) => {
      if (draft.cardScopeId !== null) return;
      binding.scopes.splice(binding.scopes.length - 1, 0, {
        cardScopeId: syncIdFor('cardScope', `${bindingId}/v${version}/scope/${index}`),
        kind: 'known',
        scopeLabel: draft.scopeLabel,
        holderAlias: draft.holderAlias,
        last4: draft.last4,
        status: 'active',
      });
    });
    binding.bindingLabel = request.bindingLabel;
    binding.bindingVersion = version;
    binding.status = 'confirmed';
    binding.statusReason = null;
    binding.confirmedAt = this.now();
    // Every other browser's grant lapses: it keeps the binding in `staleBindingIds` until the owner allows it again.
    for (const device of this.store.devices) {
      if (device.status !== 'active') continue;
      const held = device.bindingIds.includes(bindingId);
      const stale = device.staleBindingIds.includes(bindingId);
      if (regrant.includes(device.deviceId)) {
        if (!held) device.bindingIds.push(bindingId);
        device.staleBindingIds = device.staleBindingIds.filter((id) => id !== bindingId);
      } else if (held) {
        device.bindingIds = device.bindingIds.filter((id) => id !== bindingId);
        if (!stale) device.staleBindingIds.push(bindingId);
      }
    }
    // E1b §5.2: what the browsers sent under the older version waits for a source check before any plan.
    for (const set of this.store.sets) {
      if (set.bindingId === bindingId && set.origin === 'extension' && (set.state === 'accepted-uncommitted' || set.state === 'needs-review')) {
        set.state = 'blocked-review';
        set.version += 1;
      }
    }
    this.clearAutoSync(binding);
    this.authorizationChanged();
    return binding;
  }

  retireBinding(bindingId: string, expectedVersion: number): BindingRec {
    const binding = this.binding(bindingId);
    if (binding.status === 'retired') return binding;
    this.requireVersion(binding.bindingVersion, expectedVersion);
    binding.status = 'retired';
    binding.bindingVersion += 1;
    this.clearAutoSync(binding);
    for (const set of this.store.sets) {
      if (set.bindingId === bindingId && isOpenSet(set) && set.state !== 'recovery-review') {
        set.state = 'blocked-review';
        set.version += 1;
      }
    }
    this.authorizationChanged();
    return binding;
  }

  /**
   * One switch per binding over consent kept on each browser's grant (Q28). "On" consents for every browser holding a
   * current grant now (a later grant starts without), needs the password, and checks the binding version and the auto-sync
   * revision it was confirmed against (R1: the revision also moves when the grants change, so an "on" never covers a browser
   * its confirmation didn't name). E1b §5.2: a stale "on" never applies, not even a retry of one that did; the page then
   * shows what is on now. "Off" withdraws them all, checks nothing, always wins and always fences (as asked). While the
   * issuer's gate is closed, "on" is always `gate-closed`.
   */
  setAutoSync(bindingId: string, request: { expectedVersion: number; expectedAutoSyncRevision: number; enabled: boolean }): BindingRec {
    const binding = this.binding(bindingId);
    if (!request.enabled) {
      // E1b revision 6 (R1): every "off" moves the revision, even with no consent; a retired binding is left as it is.
      if (binding.status === 'retired') return binding;
      const withdrawn = binding.autoSyncConsent.size > 0;
      this.clearAutoSync(binding);
      if (withdrawn) this.authorizationChanged();
      return binding;
    }
    if (binding.autoSyncGate !== 'open') refuse(409, 'gate-closed');
    this.requireRecentAuth();
    this.requireOpenGate();
    this.requireVersion(binding.bindingVersion, request.expectedVersion);
    if (binding.autoSyncRevision !== request.expectedAutoSyncRevision) refuse(409, 'version-conflict', { currentVersion: binding.bindingVersion });
    const holders = grantHolders(this.store, bindingId);
    if (!binding.autoSyncEligible || binding.status !== 'confirmed' || holders.length === 0) refuse(409, 'auto-sync-not-eligible');
    const missing = holders.filter((device) => !binding.autoSyncConsent.has(device.deviceId));
    if (missing.length === 0) return binding;
    const now = this.now();
    for (const device of missing) binding.autoSyncConsent.set(device.deviceId, now);
    this.fence(binding);
    this.authorizationChanged();
    return binding;
  }

  // ---- pairing and devices ------------------------------------------------------

  createPairing(bindingIds: string[], replacesDeviceId: string | null): PairingRec {
    this.requireRecentAuth();
    if (this.store.deviceApi !== 'enabled') refuse(409, 'device-api-disabled');
    this.requireOpenGate();
    if (bindingIds.length === 0) refuse(422, 'invalid-request', { issues: [{ code: 'too-many-items', path: '$.bindingIds' }] });
    for (const bindingId of bindingIds) {
      const binding = this.binding(bindingId);
      if (binding.status === 'retired') refuse(409, 'binding-retired');
      if (binding.status !== 'confirmed') refuse(409, 'binding-needs-reconfirmation');
    }
    // E1b §5.3: pairing needs each bank's contract approved, which turning the bank on does once (turning it off keeps it).
    if (bindingIds.some((bindingId) => !this.store.issuers[this.binding(bindingId).issuer].contractApproved)) refuse(409, 'contract-unsupported');
    // E1b §5.3: the browser it replaces must still be pending or active when the invitation is made (frozen from then on);
    // one that runs out before the approval is still closed as replaced.
    if (replacesDeviceId && !this.store.devices.some((device) => device.deviceId === replacesDeviceId && (device.status === 'pending' || device.status === 'active'))) {
      refuse(404, 'not-found');
    }
    const now = this.now();
    for (const pairing of this.store.pairings) if (pairing.status === 'open') this.closePairing(pairing, 'cancelled', now);
    const key = this.nextId('pairing');
    const pairing: PairingRec = {
      pairingId: ownerIdFor('pairing', key),
      status: 'open',
      createdAt: now,
      expiresAt: now + LIMITS.pairingMinutes * MINUTE,
      bindingIds: [...new Set(bindingIds)],
      bindingVersions: [...new Set(bindingIds)].map((bindingId) => this.binding(bindingId).bindingVersion),
      replacesDeviceId,
      deviceId: null,
      failedAttempts: 0,
      code: pairingCodeFor(key),
      closedAt: null,
    };
    this.store.pairings.push(pairing);
    this.authorizationChanged();
    return pairing;
  }

  pairing(pairingId: string): PairingRec {
    return this.store.pairings.find((item) => item.pairingId === pairingId) ?? refuse(404, 'not-found');
  }

  device(deviceId: string): DeviceRec {
    return this.store.devices.find((item) => item.deviceId === deviceId) ?? refuse(404, 'not-found');
  }

  cancelPairing(pairingId: string): PairingRec {
    const pairing = this.pairing(pairingId);
    if (pairing.status === 'approved' || pairing.status === 'rejected') refuse(409, 'pairing-closed');
    if (pairing.status === 'open' || pairing.status === 'redeemed') {
      const now = this.now();
      if (pairing.deviceId) this.revokeRecord(this.device(pairing.deviceId), 'rejected', now);
      this.closePairing(pairing, 'cancelled', now);
      this.authorizationChanged();
    }
    return pairing;
  }

  approvePairing(pairingId: string, deviceId: string, fingerprint: string): { pairing: PairingRec; device: DeviceRec } {
    const pairing = this.pairing(pairingId);
    if (pairing.status === 'approved' && pairing.deviceId === deviceId) return { pairing, device: this.device(deviceId) };
    this.requireRecentAuth();
    if (this.store.deviceApi !== 'enabled') refuse(409, 'device-api-disabled');
    this.requireOpenGate();
    if (pairing.status === 'open') refuse(409, 'pairing-not-redeemed');
    if (pairing.status === 'expired') refuse(410, 'pairing-expired');
    if (pairing.status !== 'redeemed') refuse(409, 'pairing-closed');
    const device = this.device(pairing.deviceId as string);
    if (device.deviceId !== deviceId || device.fingerprint !== fingerprint) refuse(409, 'fingerprint-mismatch');
    // Its browser was closed meanwhile (a password reset): nothing pending is left to approve.
    if (device.status !== 'pending') refuse(409, 'pairing-closed');
    // A binding of the invite changed after pairing: the browser would get a grant for something the owner didn't see.
    if (pairing.bindingIds.some((bindingId, index) => this.binding(bindingId).bindingVersion !== pairing.bindingVersions[index])) {
      refuse(409, 'binding-stale');
    }
    const now = this.now();
    device.status = 'active';
    device.approvedAt = now;
    device.pendingExpiresAt = null;
    device.deviceExpiresAt = now + LIMITS.deviceDays * DAY;
    // New active grants: an "on" confirmed before this approval must not cover this browser (R1).
    this.grantsChanged(device.bindingIds);
    this.closePairing(pairing, 'approved', now);
    if (pairing.replacesDeviceId) {
      const replaced = this.store.devices.find((item) => item.deviceId === pairing.replacesDeviceId);
      if (replaced) this.revokeRecord(replaced, 'rotated', now);
    }
    this.authorizationChanged();
    return { pairing, device };
  }

  rejectPairing(pairingId: string, deviceId: string): { pairing: PairingRec; device: DeviceRec } {
    const pairing = this.pairing(pairingId);
    if (pairing.status === 'open') refuse(409, 'pairing-not-redeemed');
    if (pairing.deviceId !== deviceId) refuse(404, 'not-found');
    const device = this.device(deviceId);
    if (pairing.status === 'rejected') return { pairing, device };
    if (pairing.status !== 'redeemed') refuse(409, 'pairing-closed');
    const now = this.now();
    this.revokeRecord(device, 'rejected', now);
    this.closePairing(pairing, 'rejected', now);
    return { pairing, device };
  }

  revokeDevice(deviceId: string): DeviceRec {
    const device = this.device(deviceId);
    this.revokeRecord(device, 'owner', this.now());
    return device;
  }

  /** Q35: allows a working browser again for bindings whose grant lapsed when they were confirmed without it. */
  regrantDevice(deviceId: string, bindingIds: string[]): DeviceRec {
    this.requireRecentAuth();
    const device = this.device(deviceId);
    if (device.status !== 'active') refuse(404, 'not-found');
    this.requireOpenGate();
    if (bindingIds.length === 0) refuse(422, 'invalid-request', { issues: [{ code: 'too-many-items', path: '$.bindingIds' }] });
    bindingIds.forEach((bindingId, index) => {
      const binding = this.binding(bindingId);
      if (binding.status === 'retired') refuse(409, 'binding-retired');
      if (binding.status !== 'confirmed') refuse(409, 'binding-needs-reconfirmation');
      if (bindingIds.indexOf(bindingId) !== index || (!device.staleBindingIds.includes(bindingId) && !device.bindingIds.includes(bindingId))) {
        refuse(422, 'invalid-request', { issues: [{ code: 'inconsistent', path: `$.bindingIds[${index}]` }] });
      }
    });
    const added = bindingIds.filter((bindingId) => !device.bindingIds.includes(bindingId));
    device.bindingIds.push(...added);
    device.staleBindingIds = device.staleBindingIds.filter((id) => !bindingIds.includes(id));
    // A grant allowed again starts without consent, and fences an "on" confirmed before it (R1).
    this.grantsChanged(added);
    if (added.length > 0) this.authorizationChanged();
    return device;
  }

  // ---- review queue -------------------------------------------------------------

  recordDecisions(observationSetId: string, expectedVersion: number, decisions: Decision[]): SetRec {
    const set = this.set(observationSetId);
    if (set.state === 'expired-unreviewed') refuse(410, 'observation-expired');
    if (!isOpenSet(set) && set.state !== 'committed') refuse(409, 'set-closed');
    this.requireAdjustable(set);
    this.requireVersion(set.version, expectedVersion);
    if (decisions.length === 0) refuse(422, 'invalid-request', { issues: [{ code: 'too-many-items', path: '$.decisions' }] });
    const knownScopes = this.knownScopesFor(set);
    const checked = decisions.map((decision) => {
      const entry = set.items.find((item) => item.itemId === decision.itemId);
      const fail = () => refuse(409, 'action-not-allowed', {});
      if (!entry || !entry.allowedActions.includes(decision.action)) return fail();
      const candidate = entry.candidates.find((item) => item.transactionId === decision.transactionId) ?? null;
      const observation = entry.rowIndex === null ? null : rowAt(set, entry.rowIndex);
      switch (decision.action) {
        case 'same-transaction':
          if (!candidate || candidate.blockedReason !== null || decision.cardScopeId !== null) fail();
          break;
        case 'attribute-and-link':
          if (!candidate || candidate.blockedReason !== null || candidate.scopeKind === 'known'
            || decision.cardScopeId !== observation?.cardScopeId || !knownScopes.includes(decision.cardScopeId ?? '')) fail();
          break;
        case 'attribute':
          if (decision.transactionId !== null || !knownScopes.includes(decision.cardScopeId ?? '')) fail();
          break;
        case 'accept-correction':
          // As in E1b (ck_rvw_draft_shape): the stored identity names the row it corrects, so the decision names none.
          if (decision.transactionId !== null || decision.cardScopeId !== null || entry.candidates.length === 0) fail();
          break;
        default:
          if (decision.transactionId !== null || decision.cardScopeId !== null) fail();
      }
      return { entry, decision };
    });
    // E1b §4.9.2: a changed decision of a committed set is refused, before anything is saved, once what it would take back
    // is gone (`adjustment-not-reversible`); the decision already in spending can always be chosen again.
    if (set.state === 'committed' && checked.some(({ entry, decision }) => entry.committed !== null && !sameDecision(decision, entry.committed)
      && !itemAdjustable(this.store, set, entry))) {
      refuse(409, 'action-not-allowed');
    }
    const now = this.now();
    for (const { entry, decision } of checked) {
      entry.decision = { action: decision.action, transactionId: decision.transactionId, cardScopeId: decision.cardScopeId, at: now };
    }
    set.version += 1;
    for (const plan of set.plans) if (plan.state === 'valid') plan.state = 'superseded';
    return set;
  }

  preparePlan(observationSetId: string, expectedVersion: number, sourceReviewed: boolean): { set: SetRec; plan: SetRec['plans'][number] } {
    const set = this.set(observationSetId);
    if (set.state === 'expired-unreviewed') refuse(410, 'observation-expired');
    if (!isOpenSet(set) && set.state !== 'committed') refuse(409, 'set-closed');
    this.requireAdjustable(set);
    this.requireVersion(set.version, expectedVersion);
    this.requireSyncAllowed(set);
    if ((set.state === 'blocked-review' || set.state === 'recovery-review') && !sourceReviewed) refuse(409, 'source-review-required');
    if (set.state === 'committed') {
      // E1b's `nothing-to-adjust` answers `decisions-incomplete`.
      if (!set.items.some((entry) => entry.decision && entry.committed && !sameDecision(entry.decision, entry.committed))) refuse(409, 'decisions-incomplete');
    } else if (set.items.some((entry) => entry.decision === null)) {
      refuse(409, 'decisions-incomplete');
    }
    const computed = computePlan(set, (transactionId) => {
      const row = this.store.ledger.rows.get(transactionId);
      return row ? { ...row.values } : null;
    });
    // E1b `adjustment-not-reversible`: refused before anything changes, the plan prepared earlier included.
    if (set.state === 'committed' && !adjustmentReversible(this.store, set, computed.effects)) refuse(409, 'action-not-allowed');
    const now = this.now();
    for (const plan of set.plans) if (plan.state === 'valid') plan.state = 'superseded';
    const planKind = set.state === 'committed' ? 'adjustment' as const : 'set' as const;
    const plan = {
      previewId: syncIdFor('preview', this.nextId(`preview/${observationSetId}`)),
      observationSetId,
      setVersion: set.version,
      planKind,
      payloadDigest: set.payloadDigest,
      planDigest: planDigestFor(set, set.version, planKind, computed),
      createdAt: now,
      expiresAt: Math.min(now + LIMITS.planMinutes * MINUTE, set.expiresAt),
      counts: computed.counts,
      effects: computed.effects,
      state: 'valid' as const,
      committedAt: null,
    };
    set.plans.push(plan);
    return { set, plan };
  }

  commitPlan(previewId: string, payloadDigest: string | null, planDigest: string): { set: SetRec; plan: SetRec['plans'][number] } {
    const set = this.store.sets.find((item) => item.plans.some((plan) => plan.previewId === previewId)) ?? refuse(404, 'not-found');
    const plan = set.plans.find((item) => item.previewId === previewId) as SetRec['plans'][number];
    if (plan.payloadDigest !== payloadDigest || plan.planDigest !== planDigest) refuse(409, 'plan-mismatch');
    if (plan.state === 'committed') return { set, plan };
    if (set.state === 'expired-unreviewed') refuse(410, 'observation-expired');
    this.requireAdjustable(set);
    if (plan.state === 'expired' || plan.expiresAt <= this.now()) {
      plan.state = 'expired';
      refuse(410, 'plan-expired');
    }
    if (plan.state === 'superseded' || plan.setVersion !== set.version || latestPlan(set) !== plan) refuse(409, 'preview-stale');
    this.requireSyncAllowed(set);
    if (plan.planKind === 'adjustment' && !adjustmentReversible(this.store, set, plan.effects)) refuse(409, 'action-not-allowed');
    const now = this.now();
    const wasOpen = isOpenSet(set);
    // The items this commit decides: every item of a set, the changed ones of an adjustment. Each keeps a mark of what the
    // commit did, for E1b §4.9.2's checks when its decision changes later.
    const deciding = set.items.filter((entry) => entry.decision !== null && (plan.planKind === 'set' || !sameDecision(entry.decision, entry.committed)));
    applyCommit(set, plan.effects, now);
    applyLedgerCommit(this.store, set, plan.effects, now);
    for (const entry of deciding) entry.commitMark = commitMarkOf(this.store.ledger, entry, plan.effects);
    plan.state = 'committed';
    plan.committedAt = now;
    set.state = 'committed';
    set.committedAt = now;
    set.closedAt = now;
    set.closeReason = 'committed';
    set.version += 1;
    // The commit changed the account's ledger: plans prepared for its other sets are retired, as after a repair (E1b §5.6).
    this.ledgerChanged(set.cardAccountRef);
    if (wasOpen && set.bindingId !== null) {
      const binding = this.binding(set.bindingId);
      const run = this.store.runs.find((item) => item.runId === set.runId);
      if (run?.trigger === 'manual' && binding.status === 'confirmed') binding.autoSyncEligible = true;
    }
    return { set, plan };
  }

  discard(observationSetId: string, expectedVersion: number, reason: DiscardReason): SetRec {
    const set = this.set(observationSetId);
    if (set.state === 'rejected') return set;
    if (!isOpenSet(set)) refuse(409, 'set-closed');
    this.requireVersion(set.version, expectedVersion);
    closeWithoutContent(set, 'rejected', this.now(), 'discarded');
    set.discardReason = reason;
    set.version += 1;
    return set;
  }

  // ---- ledger repairs after a set expired (proposal §3.8, X29; E1b §5.7.1) ----------------

  /** A charge of the ledger; E2a answers one it doesn't have 404 `transaction-not-found` (sources and repairs alike). */
  ledgerRow(transactionId: string): LedgerRowRec {
    return this.store.ledger.rows.get(transactionId) ?? refuse(404, 'transaction-not-found');
  }

  private identity(identityId: string): IdentityRec {
    return this.store.ledger.identities.get(identityId) ?? refuse(404, 'not-found');
  }

  private requireRevision(row: LedgerRowRec, expected: number): void {
    if (row.revision !== expected) refuse(409, 'transaction-revision-stale');
  }

  /**
   * A repair changed the account's ledger, so its revision moves (E1b §5.7.1): every prepared plan of the account's sets,
   * from a browser or a file, was made against the ledger as it was and is retired (`preview-stale` at commit), and a page
   * of a set's items read before is refused (R7 pins).
   */
  private ledgerChanged(cardAccountRef: string): void {
    bumpLedgerRevision(this.store.ledger, cardAccountRef);
    this.cancelPlans((set) => set.cardAccountRef === cardAccountRef);
  }

  /**
   * One charge, and which list the page asked for continues (§3.8): at most one of `eventsCursor` (after the oldest event
   * of the previous page), `identitiesCursor` or `mergedRowsCursor` (after the last alias or merged row shown).
   */
  transactionSources(transactionId: string, query: URLSearchParams): { row: LedgerRowRec; page: SourcesPage } {
    const row = this.ledgerRow(transactionId);
    const given = [...new Set(query.keys())].filter((name): name is 'eventsCursor' | 'identitiesCursor' | 'mergedRowsCursor' =>
      name === 'eventsCursor' || name === 'identitiesCursor' || name === 'mergedRowsCursor');
    // One list continues per request; E2a names every cursor given when there is more than one, in the order sent.
    if (given.length > 1) refuse(422, 'invalid-request', { issues: given.map((key) => ({ code: 'inconsistent', path: `$.${key}` })) });
    const name = given[0];
    if (name === undefined) return { row, page: null };
    const cursor = query.get(name) as string;
    const invalid = () => refuse(422, 'invalid-request', { issues: [{ code: 'invalid-format', path: `$.${name}` }] });
    // Each cursor is bound to its list and to this charge (E1b revision 7): another list's, or another charge's, is refused,
    // and so is a history position past every event written so far (no cursor Holdr gave points there).
    if (name === 'eventsCursor') {
      const beforeSeq = eventsSeqOf(row.transactionId, cursor);
      return { row, page: { list: 'events', beforeSeq: beforeSeq !== null && beforeSeq <= this.store.ledger.seq ? beforeSeq : invalid() } };
    }
    const list = name === 'identitiesCursor' ? 'identities' : 'merged';
    const after = keysetOf(list, row.transactionId, cursor) ?? invalid();
    return { row, page: list === 'identities' ? { list: 'identities', after } : { list: 'merged', after } };
  }

  /**
   * E1b `detachCardSourceIdentity`. The alias must still be active (a repeat after a lost answer is refused here) and on
   * the row the owner saw it on: an alias move changes no revision, so a moved one is `transaction-revision-stale`
   * (revision 4, X31). The row must keep another active alias. Returns the row it was detached from.
   */
  detachIdentity(identityId: string, transactionId: string, expectedRevision: number): LedgerRowRec {
    this.requireRecentAuth();
    const ledger = this.store.ledger;
    const identity = this.identity(identityId);
    const row = this.ledgerRow(transactionId);
    if (identity.status !== 'active') refuse(409, 'action-not-allowed');
    if (identity.canonicalId !== row.transactionId) refuse(409, 'transaction-revision-stale');
    this.requireRevision(row, expectedRevision);
    if (activeIdentitiesOf(ledger, row.transactionId).length < 2) refuse(409, 'action-not-allowed');
    detachIdentityOf(ledger, identity, this.now(), MAINTENANCE);
    this.ledgerChanged(row.cardAccountRef);
    return row;
  }

  /**
   * E1b `repointCardSourceIdentity`: an active alias still on `fromTransactionId` moves to another live row of the same
   * account; never between two different known cards; the row it leaves must keep another active alias. Returns the row
   * it left.
   */
  repointIdentity(identityId: string, fromTransactionId: string, toTransactionId: string, expectedRevision: number, expectedToRevision: number): LedgerRowRec {
    this.requireRecentAuth();
    const ledger = this.store.ledger;
    const identity = this.identity(identityId);
    const from = this.ledgerRow(fromTransactionId);
    const to = this.ledgerRow(toTransactionId);
    if (identity.status !== 'active') refuse(409, 'action-not-allowed');
    if (identity.canonicalId !== from.transactionId) refuse(409, 'transaction-revision-stale');
    this.requireRevision(from, expectedRevision);
    this.requireRevision(to, expectedToRevision);
    if (to.transactionId === from.transactionId || to.cardAccountRef !== from.cardAccountRef || to.values.status === 'removed' || to.mergedIntoId !== null) {
      refuse(409, 'action-not-allowed');
    }
    const targetScope = to.values.cardScopeId;
    if (identity.scopeKind === 'known' && targetScope !== null && scopeKindOf(this.store, targetScope) === 'known' && targetScope !== identity.sourceScopeId) {
      refuse(409, 'cross-card-link-refused');
    }
    if (activeIdentitiesOf(ledger, from.transactionId).length < 2) refuse(409, 'action-not-allowed');
    repointIdentityTo(ledger, identity, to, this.now(), MAINTENANCE);
    this.ledgerChanged(from.cardAccountRef);
    return from;
  }

  /** E1b `revertCardTransactionChange`: only the row's latest reversible change, through the snapshot its marker names. */
  revertChange(transactionId: string, eventId: string, expectedRevision: number): LedgerRowRec {
    this.requireRecentAuth();
    const ledger = this.store.ledger;
    const row = this.ledgerRow(transactionId);
    this.requireRevision(row, expectedRevision);
    const change = revertibleEvent(ledger, row);
    if (!change || change.eventId !== eventId) refuse(409, 'action-not-allowed');
    revertRow(ledger, row, change as NonNullable<typeof change>, this.now(), MAINTENANCE);
    this.ledgerChanged(row.cardAccountRef);
    return row;
  }

  /**
   * E1b `unmergeCardTransaction`, in §4.9.3's order, at any age. Returns the separated row, live again. As E2a checks it:
   * the row and its revision first; `merge-not-allowed` only for a row that isn't merged; and `link-not-reversible` when
   * the merge can't be undone exactly (it isn't the row's latest change, an alias it moved has moved again, or a charge
   * would be left without an active alias).
   */
  unmergeTransaction(transactionId: string, expectedRevision: number, expectedSurvivorRevision: number): LedgerRowRec {
    this.requireRecentAuth();
    const ledger = this.store.ledger;
    const loser = this.ledgerRow(transactionId);
    this.requireRevision(loser, expectedRevision);
    if (loser.values.status !== 'removed' || loser.mergedIntoId === null) refuse(409, 'merge-not-allowed');
    const survivor = this.ledgerRow(loser.mergedIntoId as string);
    this.requireRevision(survivor, expectedSurvivorRevision);
    const merge = latestMergeEvent(ledger, loser);
    if (!merge) refuse(409, 'link-not-reversible');
    const moved = aliasesMovedBy(ledger, merge as NonNullable<typeof merge>);
    const stillThere = moved.every((identity) => identity.canonicalId === survivor.transactionId && identity.status === 'active');
    const survivorKeeps = activeIdentitiesOf(ledger, survivor.transactionId).length - moved.length >= 1;
    const loserGetsOne = activeIdentitiesOf(ledger, loser.transactionId).length + moved.length >= 1;
    if (!stillThere || !survivorKeeps || !loserGetsOne) refuse(409, 'link-not-reversible');
    unmergeRow(ledger, loser, merge as NonNullable<typeof merge>, this.now(), MAINTENANCE);
    this.ledgerChanged(loser.cardAccountRef);
    return loser;
  }

  // ---- hooks for tests: the extension's and the recovery tool's side --------------

  /** What the extension's `POST /card-sync/pairings/redeem` would do with a typed code: a pending device. */
  redeem(code: string, deviceLabel: string): DeviceRec | null {
    const now = this.now();
    this.tick();
    const pairing = this.store.pairings.find((item) => item.status === 'open' && item.code === code);
    if (!pairing) return null;
    const deviceId = syncIdFor('device', this.nextId(`device/${deviceLabel}`));
    const device: DeviceRec = {
      deviceId,
      deviceLabel,
      clientVersion: '0.1.0',
      status: 'pending',
      fingerprint: fingerprintFor(deviceId),
      pairingId: pairing.pairingId,
      createdAt: now,
      pendingExpiresAt: now + LIMITS.pendingDeviceMinutes * MINUTE,
      approvedAt: null,
      deviceExpiresAt: null,
      lastSeenAt: now,
      revokedAt: null,
      revokeReason: null,
      bindingIds: [...pairing.bindingIds],
      staleBindingIds: [],
    };
    this.store.devices.push(device);
    pairing.status = 'redeemed';
    pairing.deviceId = deviceId;
    this.authorizationChanged();
    return device;
  }

  /** A wrong code typed against this invite; the fifth locks it (plan §6.1 step 3). */
  failRedeem(pairingId: string): void {
    const pairing = this.pairing(pairingId);
    if (pairing.status !== 'open') return;
    pairing.failedAttempts = Math.min(5, pairing.failedAttempts + 1);
    if (pairing.failedAttempts >= 5) {
      this.closePairing(pairing, 'locked', this.now());
      // E1b Q45: only the failure that locks a pairing is an authorization change.
      this.authorizationChanged();
    }
  }

  /**
   * The extension opened a run for this issuer's binding from a working browser (`POST /card-sync/runs`) and, with a
   * reason, stopped it before sending anything (`POST /card-sync/runs/:runId/abort {reason}`, Q4), or sent something
   * Holdr refused whole (`errorCode`, E1b's `refusal_code`).
   */
  startRun(issuer: CardSyncIssuer, abortReason: AbortReason | null = null, errorCode: RunErrorCode | null = null): RunRec {
    const binding = this.store.bindings.find((item) => item.issuer === issuer && item.status === 'confirmed');
    const device = binding && this.store.devices.find((item) => item.status === 'active' && item.bindingIds.includes(binding.bindingId));
    if (!binding || !device) throw new Error(`no confirmed ${issuer} binding with a working browser`);
    const now = this.now();
    const key = this.nextId(`run/${binding.bindingId}`);
    const run: RunRec = {
      runId: syncIdFor('run', key),
      deviceId: device.deviceId,
      bindingId: binding.bindingId,
      cardAccountRef: binding.cardAccountRef,
      bindingVersion: binding.bindingVersion,
      clientRunId: syncIdFor('clientRun', `client/${key}`),
      adapterVersion: `holdr-ext-${issuer}@0.1.0`,
      contractVersion: 1,
      trigger: 'manual',
      createdAt: now,
      runExpiresAt: now + 10 * MINUTE,
      observationSetId: null,
      errorCode,
      abortReason,
      expiredAt: null,
    };
    this.store.runs.push(run);
    return run;
  }

  /**
   * A password reset (the reset flow or the `holdr-user` CLI, E1b D30): every browser not revoked yet is revoked as
   * `password-reset`, pending, active and expired alike; a pending one's redeemed invite closes with it (`revokeRecord`).
   */
  resetPassword(at = this.now()): void {
    for (const device of this.store.devices) this.revokeRecord(device, 'password-reset', at);
  }

  /**
   * Holdr's recovery after a database restore (plan §9.5, E1b §5.8): every device,
   * pairing, plan and auto-sync consent void, syncing paused, every issuer off,
   * every binding to be re-confirmed, open sets to recovery review. The ledger stays.
   */
  restoreFromBackup(at = this.now()): void {
    for (const device of this.store.devices) {
      if (device.status === 'active' || device.status === 'pending') this.revokeRecord(device, 'recovery', at);
    }
    for (const pairing of this.store.pairings) {
      if (pairing.status === 'open' || pairing.status === 'redeemed') this.closePairing(pairing, 'cancelled', at);
    }
    this.cancelPlans(() => true);
    for (const issuer of CARD_SYNC_ISSUERS) {
      this.store.issuers[issuer] = { enabled: false, enabledAt: null, contractApproved: this.store.issuers[issuer].contractApproved };
    }
    for (const binding of this.store.bindings) {
      if (binding.status === 'retired') continue;
      binding.status = 'needs-reconfirmation';
      binding.statusReason = 'restored-from-backup';
      binding.bindingVersion += 1;
      this.clearAutoSync(binding);
      binding.autoSyncEligible = false;
    }
    for (const set of this.store.sets) {
      // A file set has no browser or binding behind it to review again; it stays as it was.
      if (isOpenSet(set) && set.origin === 'extension') {
        set.state = 'recovery-review';
        set.version += 1;
      }
    }
    this.store.paused = true;
    this.store.pausedAt = at;
    this.store.settingsVersion += 1;
    this.store.recoveredAt = at;
    this.store.gate = 'open';
  }

  confirmPassword(password: string): number {
    // 403, not 401: the login branch's api() treats any 401 as a signed-out session (proposal Q2).
    if (password !== FAKE_OWNER_PASSWORD) refuse(403, 'unauthorized');
    this.store.recentAuthUntil = this.now() + RECENT_AUTH_MS;
    return this.store.recentAuthUntil;
  }
}

