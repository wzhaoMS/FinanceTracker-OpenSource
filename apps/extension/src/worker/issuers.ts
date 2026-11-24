/**
 * Per-issuer permission, consent and stop (plan §2.4 layer 1, §3.3, §8).
 *
 * - Enabling needs the browser's own site permission for exactly that issuer
 *   origin (requested by the options page with a user gesture) and the user's
 *   confirmation of the risk notes, plus a separate MAIN-passive consent for
 *   issuers observed in MAIN. Consent is tied to the adapter's consent version.
 * - Disabling, pausing, a revoked permission or an outdated consent all stop
 *   the same way: block new reads and sends, abort in-flight Holdr requests,
 *   drop unsent data, unregister scripts and tell running collectors to stop
 *   (they also stop the MAIN observer). Unreachable pages are reported so
 *   the UI can tell the user to close them or disable the extension. The
 *   first two happen synchronously when the stop is requested, before any
 *   await (the stop gate in context.ts); the rest follows, serialized.
 * - Shape mode swaps one issuer's MAIN observer for the shape observer for at
 *   most ten minutes; nothing is sent to Holdr in shape mode.
 */
import type { AdapterDescriptor } from '../adapters/types.js';
import type { StopReason, UiErrorCode } from '../contracts/messages.js';
import { grantedOrigins } from './activity.js';
import { dropCapture, recoverCapture } from './capture.js';
import { retryUnconfirmedStops, signalStopNow, stopCollectors } from './collectorLink.js';
import { adapterById, beginWork, forIssuer, issuerHalt, issuerStopMark, notePause, noteShapeMode, serialized, stopIssuerWork, target, unblockIssuer } from './context.js';
import { currentDevice, reconcileDeviceStorage, retireOutdatedDevice } from './device.js';
import { adapterActive, applyRegistrations, desiredScripts, shapeChangedPause, unregisterShapeScripts } from './registration.js';
import { readSession, readSettings, writeSession, writeSettings, type IssuerSetting, type Settings } from './storage.js';

/** An issuer switched off; a contract pause for an adapter version is kept until a release with another version. */
function offSetting(previous: IssuerSetting | undefined): IssuerSetting {
  const off: IssuerSetting = { enabled: false, consentVersion: 0, mainPassiveAccepted: false };
  return previous?.shapeChangedVersion ? { ...off, shapeChangedVersion: previous.shapeChangedVersion } : off;
}

/** Makes the registered content scripts match settings, permissions and shape mode. */
export async function reconcileRegistrations(settings?: Settings): Promise<void> {
  const current = settings ?? (await readSettings());
  const shape = await readSession('shape');
  const liveShape = shape && shape.expiresAt > Date.now() ? shape : null;
  await applyRegistrations(desiredScripts(target.adapters, current, await grantedOrigins(), liveShape));
}

/**
 * The storage, script and page side of a stop. Holdr work of these issuers
 * already stopped when the stop happened (context.ts, the stop gate); this
 * ends their shape mode, drops what was not sent and stops their collectors.
 */
async function stopAdapters(adapters: readonly AdapterDescriptor[], reason: StopReason): Promise<void> {
  const ids = new Set(adapters.map((adapter) => adapter.id));
  await endShapeOf(adapters, reason);
  await dropCapture((current) => ids.has(current.adapterId));
  await stopCollectors((doc) => ids.has(doc.adapterId), reason);
}

/**
 * Ends the shape mode of any of these issuers. Durable first: the record is
 * marked ended before anything else, so a restart in the middle finishes the
 * cleanup (startup stops the collectors of an ended record before removing
 * it). Its scripts are unregistered before its pages are told to stop, so no
 * new page gets them meanwhile; a page that got them just before is refused
 * and stopped when it reports (collectors.ts: a shape relay needs a live
 * shape mode of its issuer).
 */
async function endShapeOf(adapters: readonly AdapterDescriptor[], reason: StopReason): Promise<void> {
  const shape = await readSession('shape');
  if (!shape || !adapters.some((adapter) => adapter.id === shape.adapterId)) return;
  if (shape.expiresAt > 0) await writeSession('shape', { ...shape, expiresAt: 0 });
  noteShapeMode(null);
  await unregisterShapeScripts(shape.adapterId);
  await stopCollectors((doc) => doc.adapterId === shape.adapterId, reason);
  await writeSession('shape', null);
}

export function enableIssuer(adapterId: string, mainPassiveAccepted: boolean): Promise<UiErrorCode | null> {
  const known = adapterById(adapterId);
  // Only a stop that happened before this enable began is lifted by it.
  const mark = known ? issuerStopMark(known.id) : 0;
  return serialized(async () => {
    const adapter = adapterById(adapterId);
    if (!adapter) return 'unknown-adapter';
    if (!(await chrome.permissions.contains({ origins: [adapter.hostPermission] }))) return 'permission-missing';
    if (adapter.mode === 'main-passive' && !mainPassiveAccepted) return 'main-consent-required';
    const settings = await readSettings();
    if (shapeChangedPause(adapter, settings.issuers[adapter.id])) return 'shape-changed';
    const next: Settings = {
      ...settings,
      issuers: { ...settings.issuers, [adapter.id]: { enabled: true, consentVersion: adapter.consentVersion, mainPassiveAccepted: adapter.mode === 'main-passive' ? mainPassiveAccepted : false } },
    };
    await writeSettings(next);
    unblockIssuer(adapter.id, mark);
    await reconcileRegistrations(next);
    return null;
  });
}

export function disableIssuer(adapterId: string, reason: StopReason = 'issuer-paused'): Promise<UiErrorCode | null> {
  if (adapterById(adapterId)) {
    stopIssuerWork(adapterId, 'issuer-disabled', true);
    void signalStopNow((doc) => doc.adapterId === adapterId, reason);
  }
  return serialized(async () => {
    const adapter = adapterById(adapterId);
    if (!adapter) return 'unknown-adapter';
    // First durable step: a shape mode of this issuer is marked ended, so a restart in the middle of this stop cannot
    // mistake the issuer for a paused contract still recording its new form (startup finishes the rest).
    await endShapeOf([adapter], reason);
    const settings = await readSettings();
    const next: Settings = { ...settings, issuers: { ...settings.issuers, [adapter.id]: offSetting(settings.issuers[adapter.id]) } };
    await writeSettings(next);
    await reconcileRegistrations(next);
    await stopAdapters([adapter], reason);
    try {
      await chrome.permissions.remove({ origins: [adapter.hostPermission] });
    } catch {
      // The permission may already be gone.
    }
    return null;
  });
}

/**
 * The site changed what it sends (a required field is missing, a type changed
 * or an enum value is unknown): this adapter version's contract pauses (plan
 * §4, §10). It stops like disabling (scripts unregistered, collectors told to
 * stop, unsent data dropped, since rows read just before may be misread too),
 * but keeps the site permission so shape capture can still record the new
 * form; enabling waits for a release with another adapter version.
 */
export function pauseForShapeChange(adapterId: string): Promise<void> {
  if (adapterById(adapterId)) {
    stopIssuerWork(adapterId, 'shape-changed', true);
    void signalStopNow((doc) => doc.adapterId === adapterId, 'issuer-paused');
  }
  return serialized(async () => {
    const adapter = adapterById(adapterId);
    if (!adapter) return;
    const settings = await readSettings();
    const next: Settings = {
      ...settings,
      issuers: { ...settings.issuers, [adapter.id]: { enabled: false, consentVersion: 0, mainPassiveAccepted: false, shapeChangedVersion: adapter.parserVersion } },
    };
    await writeSettings(next);
    await reconcileRegistrations(next);
    await stopAdapters([adapter], 'issuer-paused');
  });
}

/** The global kill switch: on stops everything at once; off only allows scripts again (open pages need a reload). */
export async function setPaused(on: boolean): Promise<void> {
  notePause(on);
  if (on) void signalStopNow(() => true, 'kill-switch');
  await serialized(async () => {
    const settings = await readSettings();
    const next: Settings = { ...settings, paused: on };
    await writeSettings(next);
    await reconcileRegistrations(next);
    if (on) {
      await stopAdapters(target.adapters, 'kill-switch');
    }
  });
}

/**
 * The site permission of these origins was removed (by the extension or in
 * the browser's own UI): their issuers' Holdr work stops now, synchronously in
 * the event listener; `onPermissionsRemoved` brings storage, scripts and pages
 * in line afterwards.
 */
export function noteRevokedOrigins(origins: readonly string[]): void {
  const affected = new Set<string>();
  for (const adapter of target.adapters) {
    if (!origins.includes(adapter.hostPermission)) continue;
    stopIssuerWork(adapter.id, 'permission-revoked', true);
    affected.add(adapter.id);
  }
  if (affected.size > 0) void signalStopNow((doc) => affected.has(doc.adapterId), 'permission-revoked');
}

/** The site permission was removed (by the extension or in the browser's own UI). */
export function onPermissionsRemoved(origins: readonly string[]): Promise<void> {
  return serialized(async () => {
    const affected = target.adapters.filter((adapter) => origins.includes(adapter.hostPermission));
    if (affected.length === 0) return;
    await endShapeOf(affected, 'permission-revoked');
    const settings = await readSettings();
    const issuers = { ...settings.issuers };
    for (const adapter of affected) issuers[adapter.id] = offSetting(issuers[adapter.id]);
    const next: Settings = { ...settings, issuers };
    await writeSettings(next);
    await reconcileRegistrations(next);
    await stopAdapters(affected, 'permission-revoked');
  });
}

export function startShape(adapterId: string): Promise<UiErrorCode | null> {
  // Before any await: a stop after the request arrived cancels it.
  const work = beginWork();
  return serialized(async () => {
    const adapter = adapterById(adapterId);
    if (!adapter) return 'unknown-adapter';
    if (!adapter.scripts.shapeMain) return 'shape-unavailable';
    const settings = await readSettings();
    if (settings.paused) return 'paused';
    const setting = settings.issuers[adapter.id];
    // A contract paused after a site change can still record the new form, which is how an update starts.
    const drifted = shapeChangedPause(adapter, setting);
    const job = forIssuer(work, adapter.id);
    const halted = issuerHalt(job);
    if (halted && (halted.code !== 'issuer-not-enabled' || !drifted)) return halted.code;
    const allowed = setting?.enabled || drifted;
    if (!allowed || !(await chrome.permissions.contains({ origins: [adapter.hostPermission] }))) return 'issuer-not-enabled';
    const shape = await readSession('shape');
    if (shape && shape.expiresAt > Date.now()) return 'busy';
    const late = issuerHalt(job);
    if (late && (late.code !== 'issuer-not-enabled' || !drifted)) return late.code;
    const now = Date.now();
    // Nothing of this issuer's capture goes to Holdr in shape mode: its Holdr work stops now, and new capture work waits until shape mode ends.
    stopIssuerWork(adapter.id, 'shape-mode', false);
    noteShapeMode(adapter.id);
    await stopAdapters([adapter], 'shape-mode');
    await writeSession('shape', { adapterId: adapter.id, startedAt: now, expiresAt: now + target.timings.shapeModeMs, reports: [] });
    await reconcileRegistrations(settings);
    scheduleShapeExpiry(target.timings.shapeModeMs);
    return null;
  });
}

export function stopShape(): Promise<void> {
  return serialized(async () => {
    const shape = await readSession('shape');
    if (!shape) return;
    const adapter = adapterById(shape.adapterId);
    if (adapter) {
      await endShapeOf([adapter], 'shape-mode');
    } else {
      await writeSession('shape', null);
      noteShapeMode(null);
    }
    await reconcileRegistrations();
  });
}

let shapeTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleShapeExpiry(ms: number): void {
  if (shapeTimer !== null) clearTimeout(shapeTimer);
  shapeTimer = setTimeout(() => {
    shapeTimer = null;
    void expireShape();
  }, Math.max(0, ms));
}

async function expireShape(): Promise<void> {
  const shape = await readSession('shape');
  if (shape && shape.expiresAt <= Date.now()) await stopShape();
}

/**
 * Every worker start: re-check consent versions and site permissions (an
 * adapter whose consent version changed is disabled until the user agrees
 * again), re-register scripts (they do not persist across browser sessions),
 * expire a lapsed device credential and shape mode, finish a stop that the
 * worker stopping interrupted (its state stored, its cleanup not done), and
 * settle a capture that was in flight when the worker stopped.
 */
export function startup(): Promise<void> {
  return serialized(async () => {
    const settings = await readSettings();
    const granted = await grantedOrigins();
    const issuers = { ...settings.issuers };
    let changed = false;
    for (const [adapterId, setting] of Object.entries(issuers)) {
      const adapter = adapterById(adapterId);
      const valid = adapter && setting.enabled && setting.consentVersion === adapter.consentVersion && granted.has(adapter.hostPermission)
        && (adapter.mode !== 'main-passive' || setting.mainPassiveAccepted);
      if (setting.enabled && !valid) {
        issuers[adapterId] = offSetting(setting);
        changed = true;
      }
    }
    const next: Settings = changed ? { ...settings, issuers } : settings;
    if (changed) await writeSettings(next);
    const shape = await readSession('shape');
    // A live shape mode survives a restart only for an issuer still allowed to record (enabled, or a contract paused
    // on a site change with its site permission granted); anything else ends here like an expired one.
    const keepShape = shape !== null && shape.expiresAt > Date.now() && !next.paused && (() => {
      const adapter = adapterById(shape.adapterId);
      return adapter !== undefined && granted.has(adapter.hostPermission)
        && (adapterActive(adapter, next, granted) || shapeChangedPause(adapter, next.issuers[adapter.id]));
    })();
    const liveShape = keepShape ? shape : null;
    if (shape && !liveShape) {
      // Its shape observer and collector may still run in open pages: no new page gets its scripts, and its pages are
      // told to stop before the record goes, so a restart in between repeats this.
      await unregisterShapeScripts(shape.adapterId);
      await stopCollectors((doc) => doc.adapterId === shape.adapterId, 'shape-mode');
      await writeSession('shape', null);
    } else if (liveShape) {
      scheduleShapeExpiry(liveShape.expiresAt - Date.now());
    }
    noteShapeMode(liveShape?.adapterId ?? null);
    await reconcileRegistrations(next);
    // Unsent data of a paused or inactive issuer goes and its pages are told to stop, as its stop would have done.
    // A contract paused on a site change keeps a live shape mode, which may record the new form.
    const stopped = next.paused
      ? target.adapters
      : target.adapters.filter((adapter) => !adapterActive(adapter, next, granted) && liveShape?.adapterId !== adapter.id);
    if (stopped.length > 0) await stopAdapters(stopped, next.paused ? 'kill-switch' : 'issuer-paused');
    // Stops no page answered before the worker stopped are tried again.
    await retryUnconfirmedStops();
    // A credential left on disk by an interrupted opt-out is moved off it (or dropped), never used from there.
    await reconcileDeviceStorage();
    // A credential paired by another build of the extension (an update) goes before anything uses it (M1).
    await retireOutdatedDevice();
    await currentDevice();
    await recoverCapture();
  });
}
