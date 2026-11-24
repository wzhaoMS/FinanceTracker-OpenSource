/**
 * Trusted storage (plan §3.4). Before anything is stored, both storage
 * areas are restricted to trusted contexts (the worker and the extension's
 * own pages); content scripts cannot read either. If the session area cannot
 * be restricted, nothing sensitive is stored at all; if the local area cannot
 * be, the device credential is never kept there.
 *
 * - storage.session (memory, cleared with the browser): the device credential
 *   by default, capabilities, collector documents, the one active capture
 *   with its frozen bytes, shape reports, read locks.
 * - storage.local (disk): non-secret settings and recent run metadata; the
 *   device credential only after the explicit "trust this private browser"
 *   opt-in. Never storage.sync.
 */
import type { CardSyncIssue } from '@finance-tracker/shared';
import type { AccountSummary, CollectorCode, CollectorRole, CollectorState, PageState, ScopeEntry, StopReason, UiErrorCode } from '../contracts/messages.js';
import type { Capabilities, HoldrErrorCode, PlanCounts } from '../contracts/holdrApi.js';
import type { ShapeReport } from '../contracts/shapeReport.js';

export interface StorageTrust {
  session: boolean;
  local: boolean;
}

let trust: Promise<StorageTrust> | null = null;

/** Restricts both areas to trusted contexts once per worker lifetime and reports what succeeded. */
export function ensureTrustedStorage(): Promise<StorageTrust> {
  trust ??= (async () => {
    const result: StorageTrust = { session: false, local: false };
    try {
      await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
      result.session = true;
    } catch {
      result.session = false;
    }
    try {
      await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
      result.local = true;
    } catch {
      result.local = false;
    }
    return result;
  })();
  return trust;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface IssuerSetting {
  enabled: boolean;
  consentVersion: number;
  mainPassiveAccepted: boolean;
  /** The adapter version whose contract paused because the site changed what it sends; enabling waits for another version. */
  shapeChangedVersion?: string;
}

export interface Settings {
  schema: 1;
  paused: boolean;
  trustBrowser: boolean;
  issuers: Record<string, IssuerSetting>;
}

export const DEFAULT_SETTINGS: Settings = Object.freeze({ schema: 1, paused: false, trustBrowser: false, issuers: Object.freeze({}) }) as Settings;

/** `outdated`: paired by another build of this extension; Holdr refuses its credential (M1), so it is gone and the browser pairs again. */
export type DeviceStatus = 'pending' | 'active' | 'revoked' | 'expired' | 'outdated';

export interface DeviceRecord {
  deviceId: string;
  token: string;
  fingerprint: string;
  deviceLabel: string;
  /** The extension version this credential was paired with: Holdr accepts it only from that version (M1). */
  clientVersion: string;
  status: DeviceStatus;
  pendingExpiresAt: string | null;
  deviceExpiresAt: string | null;
}

export interface CollectorDoc {
  docRef: string;
  tabId: number;
  documentId: string;
  adapterId: string;
  /** What the page runs: the issuer's collector, or shape mode's relay (field names only). */
  role: CollectorRole;
  streamHandle: string;
  lastSeq: number;
  pageState: PageState;
  state: CollectorState;
  code: CollectorCode | null;
  issues: CardSyncIssue[];
  accounts: AccountSummary[];
  discovered: boolean;
  updatedAt: number;
}

export type CaptureStage =
  | 'building'
  | 'preview'
  | 'sending'
  | 'outcome-unknown'
  | 'accepted'
  | 'planned'
  | 'committed'
  | 'failed'
  | 'discarded'
  | 'expired';

export interface CaptureRecord {
  captureId: string;
  clientRunId: string;
  /** The paired device this capture was made under: only its credential ever acts on the capture's run. */
  deviceId: string;
  adapterId: string;
  docRef: string;
  accountRef: string;
  bindingId: string;
  bindingVersion: number;
  bindingLabel: string;
  scopes: ScopeEntry[];
  /** Every confirmed scope of the bound account at prepare time: the payload's coverage covers exactly these (E1a §10a). */
  confirmedScopes: string[];
  cards: string[];
  stage: CaptureStage;
  createdAt: number;
  /** A frozen, unsent batch expires; null once Holdr has a durable copy. */
  expiresAt: number | null;
  /** The exact canonical JSON previewed and sent; cleared after Holdr's durable ACK, discard or expiry. */
  text: string | null;
  digest: string | null;
  byteLength: number | null;
  rows: number;
  pending: number;
  posted: number;
  runId: string | null;
  /**
   * An upload of these bytes got no definite answer (timeout, lost response, a stop or the worker ending mid-send):
   * it may still be stored. Kept across sends, receipt checks and restarts; while set, a later definite refusal
   * is settled by what Holdr has, never taken as "nothing stored".
   */
  uploadUncertain: boolean;
  /** Holdr closed this capture's run (it acknowledged an abort, or refused an upload as closed): nothing more can arrive. */
  runClosed: boolean;
  observationSetId: string | null;
  acceptance: 'accepted-uncommitted' | 'needs-review' | null;
  acceptedAt: string | null;
  acceptExpiresAt: string | null;
  previewId: string | null;
  planDigest: string | null;
  /** An executable plan this device may commit (X24 `executable`). */
  plan: { counts: PlanCounts; expiresAt: string } | null;
  /** Holdr answered the prepare with `owner-review` (X24): the owner decides in Holdr; nothing to commit here. */
  ownerReview: { reviewCount: number; counts: PlanCounts } | null;
  /** A commit of this plan is in flight (or was when the worker stopped): a discard must not hide whether it landed. */
  committing: boolean;
  /**
   * A commit of the pinned plan went out and its outcome is still unknown (no answer, an unreadable one, or a stop):
   * it may still land, so the capture keeps the plan and is not replaced, re-planned or closed until Holdr's answer
   * settles it (a receipt, the same plan committed again, or the plan's expiry).
   */
  commitUncertain: boolean;
  committedAt: string | null;
  error: UiErrorCode | null;
  holdrError: HoldrErrorCode | null;
  issues: CardSyncIssue[];
}

export interface ShapeState {
  adapterId: string;
  startedAt: number;
  expiresAt: number;
  reports: ShapeReport[];
}

export interface LastRun {
  captureId: string;
  adapterId: string;
  bindingLabel: string;
  rows: number;
  digest: string;
  observationSetId: string;
  status: 'accepted-uncommitted' | 'needs-review' | 'committed' | 'rejected';
  at: string;
}

export interface SessionRecords {
  device: DeviceRecord | null;
  capabilities: Capabilities | null;
  collectors: CollectorDoc[];
  capture: CaptureRecord | null;
  shape: ShapeState | null;
  /** adapterId → epoch ms of the active read lease (one read per issuer at a time). */
  readLeases: Record<string, { docRef: string; until: number }>;
  /** adapterId → epoch ms before which the issuer's next read sends nothing: one request interval after its last read ended, in any tab. */
  readCooldowns: Record<string, number>;
  /** adapterId → epoch ms until which reads stay paused after a 429. */
  rateLimitedUntil: Record<string, number>;
  /** Pages a stop could not reach: kept (and retried at every later stop) until one answers or its tab closes. */
  unconfirmedStops: UnconfirmedStop[];
}

export interface UnconfirmedStop {
  tabId: number;
  documentId: string;
  adapterId: string;
  reason: StopReason;
}

const SESSION_DEFAULTS: SessionRecords = {
  device: null,
  capabilities: null,
  collectors: [],
  capture: null,
  shape: null,
  readLeases: {},
  readCooldowns: {},
  rateLimitedUntil: {},
  unconfirmedStops: [],
};

export async function readSession<K extends keyof SessionRecords>(key: K): Promise<SessionRecords[K]> {
  const result = await chrome.storage.session.get(key);
  return (Object.prototype.hasOwnProperty.call(result, key) ? result[key] : structuredClone(SESSION_DEFAULTS[key])) as SessionRecords[K];
}

export async function writeSession<K extends keyof SessionRecords>(key: K, value: SessionRecords[K]): Promise<void> {
  const level = await ensureTrustedStorage();
  if (!level.session) throw new Error('storage-untrusted');
  await chrome.storage.session.set({ [key]: value });
}

export async function readSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get('settings');
  const value = result.settings as Settings | undefined;
  if (!value || value.schema !== 1) return structuredClone(DEFAULT_SETTINGS);
  return value;
}

export async function writeSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings });
}

export async function readLastRuns(): Promise<LastRun[]> {
  const result = await chrome.storage.local.get('lastRuns');
  return Array.isArray(result.lastRuns) ? (result.lastRuns as LastRun[]) : [];
}

export async function pushLastRun(run: LastRun): Promise<void> {
  const runs = await readLastRuns();
  await chrome.storage.local.set({ lastRuns: [run, ...runs.filter((item) => item.captureId !== run.captureId)].slice(0, 20) });
}

/** The device record, from session or (only when trusted and opted in) from local storage. */
export async function readDevice(): Promise<{ device: DeviceRecord | null; persisted: boolean }> {
  const session = await readSession('device');
  if (session) return { device: session, persisted: false };
  // A credential left on disk after an opt-out is never used (and is removed at the next start).
  if (!(await readSettings()).trustBrowser) return { device: null, persisted: false };
  const device = await readLocalDevice();
  return { device, persisted: device !== null };
}

export async function readLocalDevice(): Promise<DeviceRecord | null> {
  const local = await chrome.storage.local.get('device');
  return (local.device as DeviceRecord | undefined) ?? null;
}

export async function clearLocalDevice(): Promise<void> {
  await chrome.storage.local.remove('device');
}

/** Stores the device record where the user's choice and the storage trust allow; fails closed. */
export async function writeDevice(device: DeviceRecord | null, settings: Settings): Promise<void> {
  const level = await ensureTrustedStorage();
  if (device === null) {
    await chrome.storage.session.remove('device');
    await chrome.storage.local.remove('device');
    return;
  }
  if (settings.trustBrowser && level.local) {
    await chrome.storage.local.set({ device });
    await chrome.storage.session.remove('device');
    return;
  }
  if (!level.session) throw new Error('storage-untrusted');
  await chrome.storage.session.set({ device });
  await chrome.storage.local.remove('device');
}

/** UTF-8-ish size of everything in session storage, for the 8 MiB budget. */
export async function sessionBytes(): Promise<number> {
  const all = await chrome.storage.session.get(null);
  return JSON.stringify(all).length * 2;
}
