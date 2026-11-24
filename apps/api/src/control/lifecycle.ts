import fs from 'node:fs';
import path from 'node:path';

import { EXIT, fail } from './errors.js';
import { assertDeviceLockAcquisition } from './deviceCallbackContext.js';
import { HEX16, currentUid, isIsoTime, readPrivateFile, writePrivateFileAtomic } from './files.js';

/**
 * The interprocess lifecycle protocol (design §9.3). macOS `flock(2)`-family locks taken through `open(2)` with `O_SHLOCK`
 * or `O_EXLOCK` and `O_NONBLOCK`, retried every 20 ms. A lock belongs to the open file description: it is held while any
 * process holds a descriptor for it and released by the kernel when the last one closes (also on SIGKILL). libuv opens files
 * with O_CLOEXEC, so a child receives a lease only through an explicit descriptor mapping (`spawnLeased`, `holdr-lifecycle
 * exclusive`), never by accident.
 *
 * This module never imports `node:child_process` (lease-aware path rule, `leaseLint.test.ts`).
 */
export const O_SHLOCK = 0x10;
export const O_EXLOCK = 0x20;
export const LIFECYCLE_LOCK = 'lifecycle.lock';
export const AUTHORIZATION_LOCK = 'authorization.lock';
export const RECOVERY_LOCK = 'recovery.lock';
export const LOCK_FILES = [LIFECYCLE_LOCK, AUTHORIZATION_LOCK, RECOVERY_LOCK] as const;
export const MARKER_FILE = 'lifecycle-state';
export const MARKER_FORMAT = 'holdr-lifecycle/2';
export const API_LEASE_TIMEOUT_MS = 10_000;
export const LOCK_RETRY_MS = 20;

const { O_RDONLY, O_NONBLOCK, O_NOFOLLOW } = fs.constants;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function assertLockPlatform(): void {
  if (process.platform !== 'darwin') fail('E0I_PLATFORM', 'the lifecycle protocol needs macOS O_SHLOCK/O_EXLOCK');
}

export type LockMode = 'shared' | 'exclusive';

/**
 * One non-blocking attempt. Returns the locked descriptor, or null when another holder conflicts (EAGAIN). The lock file
 * must be a private regular file of this user (created by `holdr-recovery init`); it is never created here.
 */
export function tryLock(file: string, mode: LockMode): number | null {
  assertDeviceLockAcquisition(file, mode);
  assertLockPlatform();
  let fd: number;
  try {
    fd = fs.openSync(file, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | (mode === 'exclusive' ? O_EXLOCK : O_SHLOCK));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EAGAIN' || code === 'EWOULDBLOCK') return null;
    return fail('E0I_LIFECYCLE_STATE', file);
  }
  try {
    const opened = fs.fstatSync(fd);
    const named = fs.lstatSync(file);
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino || opened.uid !== currentUid()
      || (opened.mode & 0o7777) !== 0o600 || opened.nlink !== 1) {
      fs.closeSync(fd);
      return fail('E0I_LIFECYCLE_STATE', file);
    }
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* already closed above */ }
    throw error;
  }
  return fd;
}

export async function acquireLock(file: string, mode: LockMode, timeoutMs: number): Promise<number | null> {
  const deadline = process.hrtime.bigint() + BigInt(timeoutMs) * 1_000_000n;
  for (;;) {
    const fd = tryLock(file, mode);
    if (fd !== null) return fd;
    if (process.hrtime.bigint() >= deadline) return null;
    await sleep(LOCK_RETRY_MS);
  }
}

export function releaseLock(fd: number | null | undefined): void {
  if (fd === null || fd === undefined) return;
  try { fs.closeSync(fd); } catch { /* the descriptor is gone either way */ }
}

export const lockPath = (controlDir: string, name: (typeof LOCK_FILES)[number]) => path.join(controlDir, name);

/** One `O_EXLOCK | O_NONBLOCK` open of lifecycle.lock, closed at once, never waits, changes no file (AL1 diagnostic). */
export function probeExclusive(controlDir: string): 'held' | 'free' {
  const fd = tryLock(lockPath(controlDir, LIFECYCLE_LOCK), 'exclusive');
  if (fd === null) return 'held';
  releaseLock(fd);
  return 'free';
}

// ---------------------------------------------------------------- marker

export interface Marker {
  readonly format: typeof MARKER_FORMAT;
  readonly state: 'normal' | 'maintenance';
  readonly reason: string | null;
  readonly lease: string | null;
  readonly owner: string;
  readonly since: string;
}
const MARKER_KEYS = ['format', 'state', 'reason', 'lease', 'owner', 'since'] as const;
export const REASON = /^[a-z][a-z0-9-]{0,31}$/;
const OWNER = /^[a-z][a-z0-9 -]{0,63}$/;

export function validMarker(value: unknown): value is Marker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).join() !== MARKER_KEYS.join() || record.format !== MARKER_FORMAT) return false;
  if (typeof record.owner !== 'string' || !OWNER.test(record.owner) || !isIsoTime(record.since)) return false;
  if (record.state === 'normal') return record.reason === null && record.lease === null;
  return record.state === 'maintenance' && typeof record.reason === 'string' && REASON.test(record.reason)
    && (record.lease === null || (typeof record.lease === 'string' && HEX16.test(record.lease)));
}

export function serializeMarker(marker: Marker): string {
  const text = JSON.stringify(Object.fromEntries(MARKER_KEYS.map((key) => [key, marker[key]]))) + '\n';
  if (!validMarker(JSON.parse(text))) fail('E0I_INTERNAL', 'marker');
  return text;
}

export function marker(fields: { state: 'normal' } | { state: 'maintenance'; reason: string; lease?: string | null }, owner: string): Marker {
  const value: Marker = Object.freeze({
    format: MARKER_FORMAT, state: fields.state, reason: fields.state === 'maintenance' ? fields.reason : null,
    lease: fields.state === 'maintenance' ? fields.lease ?? null : null, owner, since: new Date().toISOString(),
  });
  serializeMarker(value);
  return value;
}

/** A missing or invalid file (content or metadata) means "not normal": null. */
export function readMarker(controlDir: string): Marker | null {
  let bytes: Buffer | null;
  try {
    bytes = readPrivateFile(path.join(controlDir, MARKER_FILE), { code: 'E0I_LIFECYCLE_STATE', limit: 4096, missingOk: true });
  } catch {
    return null;
  }
  if (!bytes) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.indexOf('\n') !== text.length - 1) return null;
    const value: unknown = JSON.parse(text);
    return validMarker(value) && serializeMarker(value) === text ? Object.freeze(value) : null;
  } catch {
    return null;
  }
}

export function writeMarker(controlDir: string, value: Marker): void {
  writePrivateFileAtomic(controlDir, MARKER_FILE, serializeMarker(value));
}

// ---------------------------------------------------------------- shared leases (K29, writers, preflight)

export interface Lease {
  readonly fd: number;
  /** False once this process released it (its descriptor number may then belong to another file). */
  readonly held: boolean;
  release(): void;
}

function lease(fd: number): Lease {
  let open = true;
  return Object.freeze({ fd, get held() { return open; }, release() { if (open) { open = false; releaseLock(fd); } } });
}

/**
 * Read-only evidence that `lease` still is a lock on `controlDir`'s current `lifecycle.lock`: it is held by this process and
 * its descriptor refers to the same device and inode as the file at that path now. A lock belongs to its open file
 * description and is only given up by closing it, so a held descriptor on the same file still holds the lock. Descriptor loss
 * or reuse, a replaced or removed lock file, and any stat error are false. (For PR D's device admission.)
 */
export function leaseStillOn(held: Lease, controlDir: string): boolean {
  if (!held.held) return false;
  try {
    const opened = fs.fstatSync(held.fd);
    const named = fs.lstatSync(lockPath(controlDir, LIFECYCLE_LOCK));
    return opened.isFile() && named.isFile() && opened.dev === named.dev && opened.ino === named.ino;
  } catch {
    return false;
  }
}

/**
 * K29: shared `lifecycle.lock` within `timeoutMs`, **then** the marker exactly `normal`, both before the DB is opened.
 * The API keeps the returned lease for its whole life; writers and the preflight for the command.
 */
export async function acquireSharedLease(controlDir: string, options: {
  timeoutMs?: number; busyExit?: number; maintenanceExit?: number;
} = {}): Promise<Lease> {
  const fd = await acquireLock(lockPath(controlDir, LIFECYCLE_LOCK), 'shared', options.timeoutMs ?? API_LEASE_TIMEOUT_MS);
  if (fd === null) return fail('E0I_LIFECYCLE_BUSY', 'lifecycle.lock is held exclusively', options.busyExit ?? EXIT.busy);
  const current = readMarker(controlDir);
  if (!current) {
    releaseLock(fd);
    return fail('E0I_LIFECYCLE_STATE', path.join(controlDir, MARKER_FILE), options.maintenanceExit ?? EXIT.refused);
  }
  if (current.state !== 'normal') {
    releaseLock(fd);
    return fail('E0I_MAINTENANCE', `maintenance (${current.reason})`, options.maintenanceExit ?? EXIT.maintenance);
  }
  return lease(fd);
}

export async function acquireExclusiveLease(controlDir: string, timeoutMs: number): Promise<Lease | null> {
  const fd = await acquireLock(lockPath(controlDir, LIFECYCLE_LOCK), 'exclusive', timeoutMs);
  return fd === null ? null : lease(fd);
}

// ---------------------------------------------------------------- lease variables and inherited leases

export const LEASE_FD_VAR = 'HOLDR_LIFECYCLE_LEASE_FD';
export const LEASE_VAR = 'HOLDR_LIFECYCLE_LEASE';

export function leaseEnvPresent(env: NodeJS.ProcessEnv): boolean {
  return env[LEASE_FD_VAR] !== undefined || env[LEASE_VAR] !== undefined;
}

/** Every process outside the lease-accepting roles refuses to start inside a lease (§7.1, §9.3 rule 4). */
export function assertNoLeaseEnv(env: NodeJS.ProcessEnv, code = 'E0I_LEASE_ENV'): void {
  if (leaseEnvPresent(env)) fail(code, `${LEASE_FD_VAR}/${LEASE_VAR} set`);
}

/**
 * Proof of an inherited exclusive lease (offline validation and the other lease-accepting roles): the descriptor named by
 * `HOLDR_LIFECYCLE_LEASE_FD` is open on `lifecycle.lock` itself, a fresh shared probe fails (an exclusive lease exists),
 * and the marker is `maintenance` with `lease` equal to `HOLDR_LIFECYCLE_LEASE`. Never takes a shared lock, never requires
 * `normal`. Otherwise `E0I_LEASE_REQUIRED`, exit 3.
 */
export function proveInheritedLease(env: NodeJS.ProcessEnv, controlDir: string): { fd: number; lease: string } {
  const refuse = (detail: string): never => fail('E0I_LEASE_REQUIRED', detail, EXIT.leaseRequired);
  const fdText = env[LEASE_FD_VAR];
  const nonce = env[LEASE_VAR];
  if (!fdText || !/^[3-9][0-9]{0,4}$/.test(fdText) || !nonce || !HEX16.test(nonce)) return refuse('no lease in the environment');
  const fd = Number(fdText);
  const lockFile = lockPath(controlDir, LIFECYCLE_LOCK);
  let held: fs.Stats;
  let named: fs.Stats;
  try {
    held = fs.fstatSync(fd);
    named = fs.lstatSync(lockFile);
  } catch {
    return refuse(`descriptor ${fd} is not open on lifecycle.lock`);
  }
  if (!named.isFile() || held.dev !== named.dev || held.ino !== named.ino) return refuse(`descriptor ${fd} is not lifecycle.lock`);
  const probe = tryLock(lockFile, 'shared');
  if (probe !== null) {
    releaseLock(probe);
    return refuse('no exclusive lease is held');
  }
  const current = readMarker(controlDir);
  if (!current || current.state !== 'maintenance' || current.lease !== nonce) return refuse('the marker does not name this lease');
  return { fd, lease: nonce };
}

// ---------------------------------------------------------------- recovery and authorization locks

/** Recovery entry serialises without waiting (§9.3): `E0I_RECOVERY_BUSY`, exit 75. */
export function tryRecoveryLock(controlDir: string): Lease {
  const fd = tryLock(lockPath(controlDir, RECOVERY_LOCK), 'exclusive');
  if (fd === null) return fail('E0I_RECOVERY_BUSY', 'another recovery operation holds recovery.lock', EXIT.busy);
  return lease(fd);
}

/**
 * Every fence write sequence holds `authorization.lock` exclusively from its first read to its last write (§9.3 "Fence
 * writes"); `block` waits at most 10 s. Holders never wait for `lifecycle.lock` inside `fn`.
 */
export async function withAuthorizationLock<T>(controlDir: string, fn: () => T | Promise<T>, timeoutMs = 10_000): Promise<T> {
  const fd = await acquireLock(lockPath(controlDir, AUTHORIZATION_LOCK), 'exclusive', timeoutMs);
  if (fd === null) return fail('E0I_AUTHORIZATION_BUSY', 'authorization.lock is held', EXIT.busy);
  try {
    return await fn();
  } finally {
    releaseLock(fd);
  }
}
