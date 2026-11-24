/** Composes the UI state from trusted storage, without the credential or the frozen bytes. */
import type { UiState } from '../contracts/uiState.js';
import { grantedOrigins } from './activity.js';
import { expireIfDue, expireStoredCapture } from './capture.js';
import { adapterById, extensionVersion, target } from './context.js';
import { currentDevice } from './device.js';
import { adapterActive, shapeChangedPause } from './registration.js';
import { ensureTrustedStorage, readLastRuns, readSession, readSettings } from './storage.js';

export async function uiState(): Promise<UiState> {
  const [trust, settings, granted, { device, persisted }, capabilities, collectors, stored, shape, lastRuns, rateLimits, unconfirmedStops] = await Promise.all([
    ensureTrustedStorage(),
    readSettings(),
    grantedOrigins(),
    currentDevice(),
    readSession('capabilities'),
    readSession('collectors'),
    readSession('capture'),
    readSession('shape'),
    readLastRuns(),
    readSession('rateLimitedUntil'),
    readSession('unconfirmedStops'),
  ]);
  // The view shows an expired preview as expired; storage is updated against the capture stored now, serialized.
  const capture = stored ? expireIfDue(stored) : null;
  if (stored && capture !== stored) void expireStoredCapture();
  const now = Date.now();
  return {
    target: target.name,
    holdrOrigin: target.holdrOrigin,
    version: extensionVersion(),
    paused: settings.paused,
    storage: trust,
    device: device
      ? { status: device.status, deviceLabel: device.deviceLabel, fingerprint: device.fingerprint, deviceExpiresAt: device.deviceExpiresAt, persisted }
      : { status: 'unpaired', deviceLabel: null, fingerprint: null, deviceExpiresAt: null, persisted: false },
    trustBrowser: settings.trustBrowser,
    syncEnabled: capabilities ? capabilities.syncEnabled : null,
    bindings: capabilities ? capabilities.bindings : [],
    issuers: target.adapters.map((adapter) => {
      const setting = settings.issuers[adapter.id];
      const until = rateLimits[adapter.id];
      return {
        adapterId: adapter.id,
        issuer: adapter.issuer,
        label: adapter.label,
        mode: adapter.mode,
        hostPermission: adapter.hostPermission,
        riskNotes: [...adapter.riskNotes],
        enabled: setting?.enabled === true,
        permission: granted.has(adapter.hostPermission),
        consentCurrent: setting?.consentVersion === adapter.consentVersion,
        mainPassiveAccepted: setting?.mainPassiveAccepted === true,
        active: adapterActive(adapter, settings, granted),
        shapeAvailable: adapter.scripts.shapeMain !== null,
        rateLimitedUntil: typeof until === 'number' && until > now ? until : null,
        shapeChanged: shapeChangedPause(adapter, setting),
      };
    }),
    collectors: collectors.map((doc) => {
      const adapter = adapterById(doc.adapterId);
      return {
        docRef: doc.docRef,
        adapterId: doc.adapterId,
        label: adapter?.label ?? doc.adapterId,
        mode: adapter?.mode ?? 'dom-passive',
        tabId: doc.tabId,
        pageState: doc.pageState,
        state: doc.state,
        code: doc.code,
        issues: doc.issues,
        accounts: doc.accounts,
      };
    }),
    unreachableCollectors: unconfirmedStops.length,
    capture: capture
      ? {
          captureId: capture.captureId,
          clientRunId: capture.clientRunId,
          adapterId: capture.adapterId,
          label: adapterById(capture.adapterId)?.label ?? capture.adapterId,
          docRef: capture.docRef,
          accountRef: capture.accountRef,
          bindingId: capture.bindingId,
          bindingLabel: capture.bindingLabel,
          scopes: capture.scopes,
          stage: capture.stage,
          createdAt: capture.createdAt,
          expiresAt: capture.expiresAt,
          digest: capture.digest,
          byteLength: capture.byteLength,
          rows: capture.rows,
          pending: capture.pending,
          posted: capture.posted,
          runId: capture.runId,
          observationSetId: capture.observationSetId,
          acceptance: capture.acceptance,
          acceptedAt: capture.acceptedAt,
          acceptExpiresAt: capture.acceptExpiresAt,
          previewId: capture.previewId,
          planDigest: capture.planDigest,
          plan: capture.plan,
          ownerReview: capture.ownerReview,
          committing: capture.committing === true,
          commitUncertain: capture.commitUncertain === true,
          committedAt: capture.committedAt,
          error: capture.error,
          holdrError: capture.holdrError,
          issues: capture.issues,
        }
      : null,
    shape: shape && shape.expiresAt > now ? { adapterId: shape.adapterId, label: adapterById(shape.adapterId)?.label ?? shape.adapterId, expiresAt: shape.expiresAt, reports: shape.reports } : null,
    lastRuns,
  };
}
