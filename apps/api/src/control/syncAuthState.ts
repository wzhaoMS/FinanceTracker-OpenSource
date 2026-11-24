import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { fail } from './errors.js';
import { HEX16, isIsoTime, readPrivateFile, writePrivateFileAtomic } from './files.js';

/**
 * The DB-external recovery fence `HOLDR_CONTROL_DIR/sync-auth-state` (design §9.4, plan §6.1): one line of canonical JSON,
 * keys in this order, at most 4 KiB, LF. Metadata problems are K21 (`E0I_FENCE_FILE`, start refused); content problems
 * only keep the device gate closed (§9.5).
 */
export const FENCE_FILE = 'sync-auth-state';
export const FENCE_FORMAT = 'holdr-sync-auth-state/3';
export const FENCE_LIMIT = 4096;
export const GENERATION = /^agn_[a-p]{32}$/;
const KEYS = ['format', 'gate', 'reason', 'generation', 'next', 'op', 'machine', 'updatedAt'] as const;

export type FenceReason = 'init' | 'reinit' | 'incident' | 'change' | 'recovery';
export interface FenceState {
  readonly format: typeof FENCE_FORMAT;
  readonly gate: 'open' | 'blocked';
  readonly reason: FenceReason | null;
  readonly generation: string | null;
  readonly next: string | null;
  readonly op: string | null;
  readonly machine: string;
  readonly updatedAt: string;
}

const generationOrNull = (value: unknown) => value === null || (typeof value === 'string' && GENERATION.test(value));
const generation = (value: unknown) => typeof value === 'string' && GENERATION.test(value);
const op = (value: unknown) => typeof value === 'string' && HEX16.test(value);

/** The table of §9.4: exactly these combinations are valid. */
export function validFence(value: unknown): value is FenceState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).join() !== KEYS.join()) return false;
  if (record.format !== FENCE_FORMAT || typeof record.machine !== 'string' || !HEX16.test(record.machine)
    || !isIsoTime(record.updatedAt)) return false;
  if (record.gate === 'open') {
    return record.reason === null && generation(record.generation) && record.next === null && record.op === null;
  }
  if (record.gate !== 'blocked') return false;
  switch (record.reason) {
    case 'init':
    case 'reinit':
      return record.generation === null && record.next === null && record.op === null;
    case 'incident':
      return generationOrNull(record.generation) && record.next === null && record.op === null;
    case 'change':
      return generation(record.generation) && generation(record.next) && op(record.op);
    case 'recovery':
      return generationOrNull(record.generation) && generation(record.next) && op(record.op);
    default:
      return false;
  }
}

export function serializeFence(state: FenceState): string {
  const ordered = Object.fromEntries(KEYS.map((key) => [key, state[key]]));
  const text = JSON.stringify(ordered) + '\n';
  if (!validFence(JSON.parse(text)) || Buffer.byteLength(text) > FENCE_LIMIT) fail('E0I_INTERNAL', 'fence state');
  return text;
}

export function fenceState(fields: Omit<FenceState, 'format' | 'updatedAt'> & { updatedAt?: string }): FenceState {
  const state: FenceState = Object.freeze({
    format: FENCE_FORMAT, gate: fields.gate, reason: fields.reason, generation: fields.generation, next: fields.next,
    op: fields.op, machine: fields.machine, updatedAt: fields.updatedAt ?? new Date().toISOString(),
  });
  serializeFence(state);
  return state;
}

export type GateReason = 'missing' | 'invalid' | 'machine-changed' | `blocked:${FenceReason}`;
export type FenceRead =
  | { readonly gate: 'open'; readonly state: FenceState }
  | { readonly gate: 'closed'; readonly reason: GateReason; readonly state?: FenceState };

/** Parses fence bytes; any deviation from the canonical line is `invalid`. */
export function parseFence(bytes: Buffer): FenceState | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!validFence(value)) return null;
  return serializeFence(value) === text ? Object.freeze(value) : null;
}

/**
 * K21 (metadata, refusing) then the content (closing the gate only). `machine` is the running machine's value, or null
 * when it could not be computed (then an otherwise valid fence still reads `machine-changed`: an unknown machine never
 * matches).
 */
export function readFence(controlDir: string, machine: string | null): FenceRead {
  const bytes = readPrivateFile(path.join(controlDir, FENCE_FILE), { code: 'E0I_FENCE_FILE', limit: FENCE_LIMIT, missingOk: true });
  if (bytes === null) return { gate: 'closed', reason: 'missing' };
  const state = parseFence(bytes);
  if (!state) return { gate: 'closed', reason: 'invalid' };
  if (machine === null || state.machine !== machine) return { gate: 'closed', reason: 'machine-changed', state };
  if (state.gate === 'blocked') return { gate: 'closed', reason: `blocked:${state.reason!}`, state };
  return { gate: 'open', state };
}

/** Only for writers holding `authorization.lock` (§9.3 "Fence writes"). */
export function writeFence(controlDir: string, state: FenceState): void {
  writePrivateFileAtomic(controlDir, FENCE_FILE, serializeFence(state));
}

export function sameFence(a: FenceState | undefined, b: FenceState | undefined): boolean {
  return !!a && !!b && serializeFence(a) === serializeFence(b);
}

/** `agn_` + 32 letters a–p from 16 random bytes (E1b's generation format). */
export function newGeneration(): string {
  return 'agn_' + [...randomBytes(16)].map((byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15))).join('');
}

/** The value-free gate summary of §9.5 / `status`: generations show only their first 4 letters. */
export function describeGate(read: FenceRead): string {
  if (read.gate === 'open') return `open ${read.state.generation!.slice(0, 8)}…`;
  return read.reason.startsWith('blocked:') ? `blocked (${read.reason.slice(8)})` : read.reason;
}
