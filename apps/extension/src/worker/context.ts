/**
 * Worker runtime shared by its modules. A service worker can stop at any
 * moment, so nothing here is a source of truth: state lives in trusted
 * storage, and this only serializes state changes within one worker life and
 * keeps the stop gate for Holdr work (below).
 */
import { TARGET } from '#target';
import type { AdapterDescriptor } from '../adapters/types.js';
import type { Budget } from '../contracts/messages.js';
import { createHoldrClient, type HoldrClient } from './holdrClient.js';

export const target = TARGET;

export function adapterById(id: string): AdapterDescriptor | undefined {
  return TARGET.adapters.find((adapter) => adapter.id === id);
}

export function readBudget(): Budget {
  const timings = TARGET.timings;
  return {
    maxPages: timings.maxPagesPerAccount,
    maxRequests: timings.maxRequestsPerRun,
    requestTimeoutMs: timings.requestTimeoutMs,
    requestIntervalMs: timings.requestIntervalMs,
    startDelayMs: 0,
    runLimitMs: timings.runLimitMs,
    maxResponseBytes: timings.maxResponseBytes,
  };
}

let chain: Promise<unknown> = Promise.resolve();

/** Runs state-changing work one at a time, so two events never interleave their read-modify-write of storage. */
export function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work);
  chain = next.catch(() => undefined);
  return next;
}

// ---------------------------------------------------------------------------
// The stop gate
//
// A stop (the kill switch, an issuer disabled, its site permission removed,
// its contract paused on a site change, shape mode) is recorded here
// synchronously, the moment it happens and before any await; storage,
// scripts and pages catch up afterwards in the serialized stop. Holdr work
// takes a snapshot when it begins, also before its first await
// (`beginWork`), checks the gate before every request (`issuerHalt`) and
// binds its requests to the abort signal its issuer had when the work began,
// which every later stop of that issuer and the kill switch abort. So
// nothing begun before a stop is dispatched after it, and nothing new starts
// between a stop and its storage update.
// ---------------------------------------------------------------------------

/** Why Holdr work stopped (`cancelled`: the user discarded a capture while one of its steps ran). */
export type StopCause = 'paused' | 'issuer-disabled' | 'permission-revoked' | 'shape-changed' | 'shape-mode' | 'cancelled';
const STOP_CAUSES: readonly StopCause[] = ['paused', 'issuer-disabled', 'permission-revoked', 'shape-changed', 'shape-mode', 'cancelled'];

function isStopCause(value: unknown): value is StopCause {
  return typeof value === 'string' && (STOP_CAUSES as readonly string[]).includes(value);
}

/** The latest kill-switch command of this worker life; null until one arrives (then storage alone decides). */
let pauseIntent: boolean | null = null;
/** Counts every stop of this worker life; work remembers the count when it began. */
let stopSeq = 0;
let lastPauseSeq = 0;
let deviceAbort = new AbortController();

interface IssuerStop {
  /** `stopSeq` at this issuer's latest stop (0: none in this worker life). */
  seq: number;
  cause: StopCause;
  /** New work of this issuer stays out until it is enabled again. */
  blocked: boolean;
  controller: AbortController;
}

const issuerStops = new Map<string, IssuerStop>();

function issuerStop(adapterId: string): IssuerStop {
  let entry = issuerStops.get(adapterId);
  if (!entry) {
    entry = { seq: 0, cause: 'issuer-disabled', blocked: false, controller: new AbortController() };
    issuerStops.set(adapterId, entry);
  }
  return entry;
}

/** Aborts the issuer's current signal with the stop's cause, which work holding that signal keeps (the first stop wins). */
function renew(entry: IssuerStop, cause: StopCause): void {
  entry.controller.abort(cause);
  entry.controller = new AbortController();
}

/** The kill switch, when its command arrives: on aborts every Holdr request and keeps all Holdr work out until a resume. */
export function notePause(on: boolean): void {
  pauseIntent = on;
  if (!on) return;
  stopSeq += 1;
  lastPauseSeq = stopSeq;
  deviceAbort.abort();
  deviceAbort = new AbortController();
  for (const adapter of TARGET.adapters) renew(issuerStop(adapter.id), 'paused');
}

/** The kill switch is on, or its command arrived and storage has not caught up yet. */
export function pausePending(): boolean {
  return pauseIntent === true;
}

/**
 * An issuer stopped, when it happens: its Holdr requests abort and its work
 * begun before does not go on. With `block`, its new work also stays out
 * until it is enabled again (`unblockIssuer`).
 */
export function stopIssuerWork(adapterId: string, cause: StopCause, block: boolean): void {
  const entry = issuerStop(adapterId);
  stopSeq += 1;
  entry.seq = stopSeq;
  entry.cause = cause;
  if (block) entry.blocked = true;
  renew(entry, cause);
}

/** Read when an enable begins, before any await. */
export function issuerStopMark(adapterId: string): number {
  return issuerStop(adapterId).seq;
}

/** After an enable is stored: the issuer's new work may start again, unless it stopped again since the enable began. */
export function unblockIssuer(adapterId: string, mark: number): void {
  const entry = issuerStop(adapterId);
  if (entry.seq === mark) entry.blocked = false;
}

let shapeIssuer: string | null = null;

/** The issuer in shape mode, set and cleared together with shape mode itself; its capture work (send, plan, commit) waits. */
export function noteShapeMode(adapterId: string | null): void {
  shapeIssuer = adapterId;
}

export function inShapeMode(adapterId: string): boolean {
  return shapeIssuer === adapterId;
}

/** The gate's view of Holdr work, taken when the work begins, before its first await. */
export interface Work {
  readonly seq: number;
  readonly signals: ReadonlyMap<string, AbortSignal>;
}

export function beginWork(): Work {
  const signals = new Map<string, AbortSignal>();
  for (const adapter of TARGET.adapters) signals.set(adapter.id, issuerStop(adapter.id).controller.signal);
  return { seq: stopSeq, signals };
}

/**
 * Work for one issuer's capture. With `gate: false` (receipt checks) work
 * that begins after the issuer stopped may run; work in flight when it
 * stopped may not.
 */
export interface IssuerWork {
  readonly adapterId: string;
  readonly gate: boolean;
  readonly seq: number;
  readonly signal: AbortSignal;
}

export function forIssuer(work: Work, adapterId: string, gate = true): IssuerWork {
  return { adapterId, gate, seq: work.seq, signal: work.signals.get(adapterId) ?? AbortSignal.abort() };
}

export interface Halt {
  readonly code: 'paused' | 'stopped' | 'issuer-not-enabled' | 'busy';
  readonly cause: StopCause;
}

/**
 * Synchronously: why `work` must not go on (a stop since it began, or a stop not yet stored), or null. A stop since
 * the work began is named by the first one, which aborted the signal the work holds: a later stop (the permission
 * removal a disable causes, say) does not rename it, so Holdr hears the reason of what the user did (Q4).
 */
export function issuerHalt(work: IssuerWork): Halt | null {
  const entry = issuerStop(work.adapterId);
  const first = work.signal.aborted && isStopCause(work.signal.reason) ? work.signal.reason : null;
  if (entry.seq > work.seq) return { code: 'stopped', cause: first ?? entry.cause };
  if (lastPauseSeq > work.seq) return { code: 'stopped', cause: first ?? 'paused' };
  if (pauseIntent === true) return { code: 'paused', cause: 'paused' };
  if (work.gate && entry.blocked) return { code: 'issuer-not-enabled', cause: entry.cause };
  return null;
}

/** The signal device-level requests bind to (pairing, status, run aborts); only the kill switch aborts it. */
export function deviceSignal(): AbortSignal {
  return deviceAbort.signal;
}

/** A Holdr client bound to `signal`, by default the current device-level signal. */
export function holdr(signal: AbortSignal = deviceAbort.signal): HoldrClient {
  return createHoldrClient({
    origin: TARGET.holdrOrigin,
    requireHttps: TARGET.name !== 'test',
    timeoutMs: TARGET.timings.holdrTimeoutMs,
    clientVersion: extensionVersion(),
    signal,
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extensionVersion(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return '0.0.0';
  }
}
