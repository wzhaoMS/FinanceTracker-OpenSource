/**
 * Pairing and the device credential (plan §6.1), against Holdr's device API (E2c).
 *
 * The user types the one-time pairing code into the extension's own options
 * page; the worker redeems it, keeps the returned bearer only in trusted
 * storage (session by default), and shows the non-secret fingerprint for the
 * user to compare in Holdr. The device stays pending until the owner
 * approves it there. A 401 wipes the bearer it was answered for (never one
 * that replaced it meanwhile): revoked, expired or replaced devices must pair
 * again. So must a browser whose extension was updated: Holdr accepts a
 * credential only with the version it was paired with (M1), so one paired by
 * another build is wiped at once (`outdated`), before anything is sent with
 * it. The bearer never leaves the worker: not in a message, a page, the
 * panel, a log or the UI state.
 */
import type { UiErrorCode } from '../contracts/messages.js';
import { deviceSignal, holdr, extensionVersion, pausePending, serialized } from './context.js';
import type { HoldrFailure } from './holdrClient.js';
import {
  clearLocalDevice,
  ensureTrustedStorage,
  readDevice,
  readLocalDevice,
  readSession,
  readSettings,
  writeDevice,
  writeSession,
  writeSettings,
  type DeviceRecord,
} from './storage.js';

/**
 * The kill switch stops device traffic too: checked against storage and the
 * pending stop, with no await between the last check and the request. The
 * request's signal is taken when the command arrives, so a pause after that
 * aborts it even if a resume follows.
 */
async function deviceHalt(signal: AbortSignal): Promise<'paused' | 'stopped' | null> {
  const now = () => (pausePending() ? 'paused' : signal.aborted ? 'stopped' : null);
  if (now()) return now();
  if ((await readSettings()).paused) return 'paused';
  return now();
}

function expired(iso: string | null, now: number): boolean {
  return iso !== null && Date.parse(iso) <= now;
}

/**
 * Wipes the stored credential, keeping only its status, if it is still
 * `token`: an answer about an old credential never touches one that replaced
 * it (forget and pair again). Runs inside `serialized`.
 */
async function clearDeviceIf(token: string, status: 'revoked' | 'expired' | 'outdated'): Promise<void> {
  const { device } = await readDevice();
  if (!device || device.token === '' || device.token !== token) return;
  const settings = await readSettings();
  await writeDevice({ ...device, token: '', status }, settings);
  await writeSession('capabilities', null);
}

function lapsed(device: DeviceRecord, now: number): boolean {
  return (device.status === 'pending' && expired(device.pendingExpiresAt, now)) || (device.status === 'active' && expired(device.deviceExpiresAt, now));
}

/** Paired by another build of this extension (an update since, or a record from before versions were kept): Holdr refuses it (M1). */
function outdated(device: DeviceRecord): boolean {
  return device.token !== '' && device.clientVersion !== extensionVersion();
}

/**
 * Expires the stored credential only if it is still `token` and still lapsed
 * now: an approval stored meanwhile (a new status and expiry for the same
 * credential) is never undone by an earlier observation. Runs inside `serialized`.
 */
async function expireDeviceIf(token: string): Promise<void> {
  const { device } = await readDevice();
  if (!device || device.token !== token || !lapsed(device, Date.now())) return;
  await clearDeviceIf(token, 'expired');
}

/** Wipes the stored credential if it is still `token` and still from another build. Runs inside `serialized`. */
async function retireOutdatedIf(token: string): Promise<void> {
  const { device } = await readDevice();
  if (!device || device.token !== token || !outdated(device)) return;
  await clearDeviceIf(token, 'outdated');
}

/**
 * The device record after version and expiry checks. A credential from another build, or a lapsed one, reads as
 * gone at once; storage follows, serialized.
 */
export async function currentDevice(now = Date.now()): Promise<{ device: DeviceRecord | null; persisted: boolean }> {
  const { device, persisted } = await readDevice();
  if (!device) return { device: null, persisted: false };
  if (outdated(device)) {
    // Queued, not awaited: callers may already be inside `serialized`.
    void serialized(() => retireOutdatedIf(device.token));
    return { device: { ...device, token: '', status: 'outdated' }, persisted };
  }
  if (lapsed(device, now)) {
    void serialized(() => expireDeviceIf(device.token));
    return { device: { ...device, token: '', status: 'expired' }, persisted };
  }
  return { device, persisted };
}

/**
 * Worker start (inside `serialized`): a credential paired by another build of this extension goes before anything
 * could use it, from memory and from disk alike (M1).
 */
export async function retireOutdatedDevice(): Promise<void> {
  const { device } = await readDevice();
  if (device && outdated(device)) await clearDeviceIf(device.token, 'outdated');
}

/** A 401 from Holdr for `token`: that credential is no longer valid. For callers outside `serialized`. */
export function handleUnauthorized(token: string): Promise<void> {
  return serialized(() => clearDeviceIf(token, 'revoked'));
}

/**
 * What the user is told about a failed Holdr request. Each code Holdr answers means one thing (M5): its own pause or
 * switches, a binding that changed, Holdr's limits, Holdr not taking browser requests right now, or Holdr not taking
 * this build or connection at all.
 */
export function failureCode(result: HoldrFailure): UiErrorCode {
  if (result.kind === 'network' || result.kind === 'timeout' || result.kind === 'aborted') return 'holdr-unreachable';
  if (result.kind === 'protocol' || result.kind === 'refused') return 'holdr-protocol';
  // `unauthorized`, `device-not-active`, a lapsed or revoked credential.
  if (result.status === 401) return 'device-revoked';
  switch (result.code) {
    // Holdr's own pause, a disabled issuer or withdrawn MAIN consent, at any step (E1b's current-source authorization).
    case 'sync-disabled':
    case 'sync-paused':
      return 'sync-disabled';
    case 'device-pending':
      return 'device-pending';
    // A binding changed, retired, awaiting re-confirmation, no longer granted to this browser, or without that card.
    case 'binding-stale':
    case 'binding-needs-reconfirmation':
    case 'binding-retired':
    case 'scope-not-in-binding':
      return 'unknown-binding';
    case 'too-many-open-runs':
    case 'run-rate-limited':
    case 'review-quota-exceeded':
    case 'plan-quota-exceeded':
    case 'rate-limited':
      return 'holdr-limited';
    // Maintenance or a lost authorization check (D), Holdr's secure entry not verified, or Holdr busy.
    case 'authorization-blocked':
    case 'ingress-unverified':
    case 'ingress-refused':
    case 'unavailable':
      return 'holdr-unavailable';
    // Only the official extension, through Holdr's secure entry; and only the contract versions Holdr accepts.
    case 'credential-not-allowed':
    case 'device-transport-refused':
    case 'contract-unsupported':
      return 'holdr-incompatible';
    case 'plan-needs-review':
      return 'plan-needs-review';
    case 'capture-already-accepted':
      return 'already-sent';
    case 'too-large':
      return 'too-large';
    default:
      return 'holdr-refused';
  }
}

/**
 * A capture whose commit runs, or may still land, can be settled only with
 * the credential it was made under: while that credential still works,
 * forgetting it or pairing another is refused. A credential Holdr no longer
 * accepts (revoked, expired) settles nothing, so it never holds pairing back.
 */
async function credentialPinned(): Promise<boolean> {
  const capture = await readSession('capture');
  if (!capture || !(capture.committing || capture.commitUncertain)) return false;
  const device = await activeDevice();
  return device.ok && device.device.deviceId === capture.deviceId;
}

export async function pair(pairingCode: string, deviceLabel: string, signal: AbortSignal = deviceSignal()): Promise<UiErrorCode | null> {
  const trust = await ensureTrustedStorage();
  if (!trust.session) return 'storage-untrusted';
  if (await credentialPinned()) return 'commit-pending';
  const halted = await deviceHalt(signal);
  if (halted) return halted;
  const result = await holdr(signal).redeem(pairingCode, deviceLabel, extensionVersion());
  if (!result.ok) {
    if (result.code === 'pairing-locked') return 'pairing-locked';
    if (result.code === 'pairing-invalid' || result.status === 401) return 'pairing-invalid';
    return failureCode(result);
  }
  const value = result.value;
  const settings = await readSettings();
  await writeDevice(
    {
      deviceId: value.deviceId,
      token: value.deviceToken,
      fingerprint: value.fingerprint,
      deviceLabel,
      clientVersion: extensionVersion(),
      status: 'pending',
      pendingExpiresAt: value.pendingExpiresAt,
      deviceExpiresAt: null,
    },
    settings,
  );
  await writeSession('capabilities', null);
  return null;
}

/** Asks Holdr for this device's status and capabilities; activates a pending device once the owner approved it. */
export async function refreshDevice(signal: AbortSignal = deviceSignal()): Promise<UiErrorCode | null> {
  const { device } = await currentDevice();
  if (!device || device.token === '') return 'not-paired';
  const halted = await deviceHalt(signal);
  if (halted) return halted;
  const result = await holdr(signal).capabilities(device.token);
  if (!result.ok) {
    if (result.status === 401) {
      // Already inside `serialized` (main.ts): the conditional wipe runs inline.
      await clearDeviceIf(device.token, 'revoked');
      return 'device-revoked';
    }
    return failureCode(result);
  }
  const capabilities = result.value;
  if (capabilities.deviceId !== device.deviceId) return 'holdr-protocol';
  const settings = await readSettings();
  await writeDevice(
    {
      ...device,
      status: capabilities.status === 'active' ? 'active' : 'pending',
      deviceExpiresAt: capabilities.status === 'active' ? capabilities.deviceExpiresAt : device.deviceExpiresAt,
    },
    settings,
  );
  await writeSession('capabilities', capabilities.status === 'active' ? capabilities : null);
  return capabilities.status === 'active' ? null : 'device-pending';
}

export async function forgetDevice(): Promise<UiErrorCode | null> {
  if (await credentialPinned()) return 'commit-pending';
  const settings = await readSettings();
  await writeDevice(null, settings);
  await writeSession('capabilities', null);
  return null;
}

/**
 * "Trust this private browser": keep the credential in local storage (only
 * if local storage is trusted-only); off moves it back to memory. Ordered so
 * that an interruption never leaves the credential on disk without the
 * opt-in: opting in stores the setting first, opting out moves the
 * credential off the disk first.
 */
export async function setTrustBrowser(on: boolean): Promise<UiErrorCode | null> {
  const trust = await ensureTrustedStorage();
  if (on && !trust.local) return 'storage-untrusted';
  const settings = await readSettings();
  const next = { ...settings, trustBrowser: on };
  const { device } = await readDevice();
  if (on) {
    await writeSettings(next);
    if (device) await writeDevice(device, next);
    return null;
  }
  if (device) {
    try {
      await writeDevice(device, next);
    } catch {
      // Memory cannot hold it either: the credential goes entirely (pair again later).
      await writeDevice(null, next);
    }
  }
  await clearLocalDevice();
  await writeSettings(next);
  return null;
}

/**
 * Worker start: a credential still on disk although the user opted out (an
 * opt-out interrupted half-way) moves to memory, or goes; it is never used
 * from disk (storage.ts `readDevice`).
 */
export async function reconcileDeviceStorage(): Promise<void> {
  const settings = await readSettings();
  if (settings.trustBrowser) return;
  const local = await readLocalDevice();
  if (!local) return;
  if (!(await readSession('device'))) {
    try {
      await writeDevice(local, settings);
    } catch {
      // No trusted memory: the credential is dropped.
    }
  }
  await clearLocalDevice();
}

/** The active device and its capabilities, or why there is none. */
export async function activeDevice(): Promise<{ ok: true; device: DeviceRecord } | { ok: false; code: UiErrorCode }> {
  const { device } = await currentDevice();
  if (!device || device.token === '') return { ok: false, code: device?.status === 'revoked' ? 'device-revoked' : device?.status === 'outdated' ? 'device-outdated' : 'not-paired' };
  if (device.status === 'pending') return { ok: false, code: 'device-pending' };
  if (device.status !== 'active') return { ok: false, code: 'device-revoked' };
  const capabilities = await readSession('capabilities');
  if (!capabilities) return { ok: false, code: 'not-paired' };
  return { ok: true, device };
}
