import { Server, type IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { WebReleaseError } from '@finance-tracker/shared/web-release';
import { readMarker, serializeMarker, withAuthorizationLock } from '../control/lifecycle.js';
import { withinDeviceCallback } from '../control/deviceCallbackContext.js';
import { GENERATION, fenceState, readFence, sameFence, validFence, writeFence, type FenceState } from '../control/syncAuthState.js';
import type { AuthorizationChangePlan, AuthorizationEffectGuard } from '../control/authorizationChange.js';
import type { IngressConfig } from './config.js';
import { admissionRefusal, type IngressAdmission } from './types.js';

export interface CardSyncGenerationSource {
  getCardSyncAuthorizationGeneration(): string;
}

/** The read-only part of B's RuntimeLifecycleEvidence; no environment or request can supply it. */
export interface DeviceLifecycleEvidence {
  readonly controlDir: string;
  readonly machine: string | null;
  leaseLive(): boolean;
}

export interface DeviceAuthorization {
  /** For E1b's in-transaction expectedGeneration check, never for a response or log. */
  readonly generation: string;
  /** Synchronous, lock-preserving at-effect check; invalid after this callback returns or its budget expires. */
  assertCurrent(): void;
  /** Scope at most one already-locked generation transition to this request, this G/N and this exact change op. */
  generationChange(plan: AuthorizationChangePlan): AuthorizationEffectGuard;
  /** Cooperative cancellation only. A deadline never releases the lock underneath unfinished work. */
  readonly signal: AbortSignal;
}

/** E1b permits a 3 s transaction at its limits; leave room for E1a validation while staying below B's 10 s lock budget. */
export const MAX_DEVICE_CALLBACK_MS = 5_000;
const BRAND: unique symbol = Symbol('DeviceAdmission');
const admissions = new WeakSet<object>();

export interface DeviceAdmission {
  readonly [BRAND]: true;
  /**
   * The entire callback runs under authorization.lock. Keep it below MAX_DEVICE_CALLBACK_MS: read bounded bodies and do
   * network I/O beforehand, and assertCurrent immediately before synchronous effects. No lock reacquisition or detached work.
   * Expiry takes precedence over the callback's result/error, attempts a durable block and cancels cooperatively.
   * Failed fencing latches this guard closed. This is not a rollback, execution/lock-release or external blockFence deadline.
   */
  admit<T>(req: IncomingMessage, work: (authorization: DeviceAuthorization) => T | Promise<T>): Promise<T>;
}

export class DeviceAdmissionRefusal extends Error {
  constructor(readonly status: 403 | 409 | 503, readonly code:
    'device-transport-refused' | 'authorization-blocked' | 'ingress-unverified' | 'ingress-refused') {
    super(code);
    this.name = 'DeviceAdmissionRefusal';
  }
}

function blocked(): never {
  throw new DeviceAdmissionRefusal(409, 'authorization-blocked');
}

export function deviceApiConfigured(config: IngressConfig, env: Readonly<NodeJS.ProcessEnv>): boolean {
  if (config.mode !== 'dist' || env.HOLDR_DEVICE_API !== '1') return false;
  try {
    const origin = new URL(config.publicOrigin);
    return origin.protocol === 'https:' && origin.origin === config.publicOrigin && !origin.port
      && !isIP(origin.hostname) && origin.hostname.length <= 253
      && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(origin.hostname);
  } catch {
    return false;
  }
}

function serveProfile(req: IncomingMessage): boolean {
  const facts = req.holdrIngress;
  return facts?.mode === 'dist' && facts.listener === 'ingress' && facts.profile === 'serve'
    && Object.isFrozen(facts) && req.socket.remoteAddress === undefined;
}

export function deviceTransportAllowed(req: IncomingMessage, attestation?: IngressAdmission): boolean {
  return serveProfile(req) && admissionRefusal(attestation) === null;
}

export function isDeviceAdmission(value: unknown): value is DeviceAdmission {
  return typeof value === 'object' && value !== null && admissions.has(value);
}

/**
 * The only DeviceAdmission constructor (§6.7). Call after the dist socket binds; E2's mount can be an empty router until
 * then. This creates a guard, never an admission verdict: every invocation reads the live marker, fence and DB generation.
 */
export function admitDeviceRequest(options: {
  config: IngressConfig;
  env: Readonly<NodeJS.ProcessEnv>;
  serve: Server;
  attestation?: IngressAdmission;
  lifecycle: () => DeviceLifecycleEvidence | null;
  source: CardSyncGenerationSource;
}): DeviceAdmission {
  const { config, serve, attestation, lifecycle, source } = options;
  if (config.mode !== 'dist' || !(serve instanceof Server) || !serve.listening || serve.address() !== config.socketPath) {
    throw new WebReleaseError('E0I_DEVICE_ADMISSION');
  }
  const { controlDir, socketPath } = config;
  const configured = deviceApiConfigured(config, options.env);
  let persistenceFailed = false;
  let expiredCallbacks = 0;
  const receivedHere = new WeakSet<IncomingMessage>();
  // A frozen profile alone is not provenance: only requests received by this specific, already-bound server qualify.
  serve.prependListener('request', (req: IncomingMessage) => { receivedHere.add(req); });

  const current = (req: IncomingMessage): DeviceLifecycleEvidence => {
    if (!receivedHere.has(req) || !serveProfile(req) || !serve.listening || serve.address() !== socketPath
      || req.aborted || req.socket.destroyed) throw new DeviceAdmissionRefusal(403, 'device-transport-refused');
    const refusal = admissionRefusal(attestation);
    if (refusal) throw new DeviceAdmissionRefusal(503, refusal);
    if (!configured || persistenceFailed || expiredCallbacks > 0) return blocked();
    try {
      const evidence = lifecycle();
      if (!evidence || evidence.controlDir !== controlDir || evidence.leaseLive() !== true) return blocked();
      return evidence;
    } catch {
      return blocked();
    }
  };

  const check = (req: IncomingMessage, expected?: string, expectedFence?: FenceState): string => {
    const evidence = current(req);
    const marker = readMarker(controlDir);
    const fence = readFence(controlDir, evidence.machine);
    if (marker?.state !== 'normal' || !fence.state || fence.state.machine !== evidence.machine
      || (expectedFence ? !sameFence(fence.state, expectedFence) : fence.gate !== 'open')) return blocked();
    const generation = source.getCardSyncAuthorizationGeneration();
    if (typeof generation !== 'string' || !GENERATION.test(generation) || (!expectedFence && generation !== fence.state.generation)
      || (expected !== undefined && generation !== expected)) return blocked();
    const latest = current(req);
    const finalMarker = readMarker(controlDir);
    const finalFence = readFence(controlDir, latest.machine);
    if (finalMarker?.state !== 'normal' || !finalFence.state || finalFence.state.machine !== latest.machine
      || (expectedFence ? !sameFence(finalFence.state, expectedFence) : finalFence.gate !== 'open')
      || serializeMarker(finalMarker) !== serializeMarker(marker) || !sameFence(finalFence.state, fence.state)) return blocked();
    current(req);
    return generation;
  };

  const admission: DeviceAdmission = Object.freeze({
    [BRAND]: true as const,
    async admit<T>(req: IncomingMessage, work: (authorization: DeviceAuthorization) => T | Promise<T>): Promise<T> {
      current(req);
      let workStarted = false;
      try {
        return await withAuthorizationLock(controlDir, async () => {
          const generation = check(req);
          const machine = current(req).machine;
          const deadline = process.hrtime.bigint() + BigInt(MAX_DEVICE_CALLBACK_MS) * 1_000_000n;
          const cancellation = new AbortController();
          let active = true;
          let expired = false;
          const expire = () => {
            if (!active || expired) return;
            expired = true;
            expiredCallbacks++;
            try {
              // Still under the same lock. Never overwrite an operator/recovery block or reopen a fence.
              const fence = readFence(controlDir, machine);
              if (fence.gate === 'open') writeFence(controlDir, fenceState({
                ...fence.state, gate: 'blocked', reason: 'incident', next: null, op: null,
              }));
              else if (fence.state?.gate !== 'blocked' || fence.state.machine !== machine) persistenceFailed = true;
            } catch {
              // Even if storage fails, this guard cannot admit again until the process restarts.
              persistenceFailed = true;
            }
            withinDeviceCallback(() => cancellation.abort(new DeviceAdmissionRefusal(409, 'authorization-blocked')));
          };
          const withinBudget = () => {
            if (!active) return blocked();
            if (process.hrtime.bigint() >= deadline) expire();
            if (expired) return blocked();
          };
          const assertExpected = (expected: string, state?: FenceState) => {
            withinBudget();
            try { check(req, expected, state); }
            catch (error) {
              if (error instanceof DeviceAdmissionRefusal) throw error;
              return blocked();
            }
            withinBudget();
          };
          let changed = false;
          const authorization: DeviceAuthorization = Object.freeze({
            generation, signal: cancellation.signal,
            assertCurrent() {
              assertExpected(generation);
            },
            generationChange(plan: AuthorizationChangePlan) {
              withinBudget();
              if (changed || !plan || plan.controlDir !== controlDir || !validFence(plan.before) || !validFence(plan.change)
                || plan.before.gate !== 'open' || plan.before.generation !== generation || plan.before.machine !== machine
                || plan.change.gate !== 'blocked' || plan.change.reason !== 'change' || plan.change.machine !== machine
                || plan.change.generation !== generation || plan.change.next === generation) return blocked();
              const before = Object.freeze({ ...plan.before });
              const change = Object.freeze({ ...plan.change });
              assertExpected(generation, before);
              changed = true;
              let phase: 'created' | 'blocked' | 'mutating' | 'mutated' | 'reopening' = 'created';
              let opened: FenceState | undefined;
              let failure: unknown;
              let mutationGeneration: string | undefined;
              const validGeneration = (value: string) => value === generation || value === change.next;
              const verify = (expected: string, state: FenceState, allowed: boolean) => {
                if (failure) throw failure;
                try {
                  if (!allowed) return blocked();
                  assertExpected(expected, state);
                } catch (error) { failure = error; throw error; }
              };
              return Object.freeze({
                beforeBlock() {
                  verify(generation, before, phase === 'created');
                  phase = 'blocked';
                },
                beforeMutation() {
                  verify(generation, change, phase === 'blocked' || phase === 'mutating');
                  phase = 'mutating';
                },
                afterMutation(after: string) {
                  verify(after, change, phase === 'mutating' && validGeneration(after));
                  mutationGeneration = after;
                  phase = 'mutated';
                },
                beforeOpen(candidate: FenceState) {
                  const allowed = (phase === 'mutating' || phase === 'mutated') && validFence(candidate)
                    && candidate.gate === 'open' && candidate.machine === machine && candidate.generation !== null
                    && validGeneration(candidate.generation)
                    && (mutationGeneration === undefined || mutationGeneration === candidate.generation);
                  verify(candidate.generation ?? '', change, allowed);
                  opened = Object.freeze({ ...candidate });
                  phase = 'reopening';
                },
                assertCurrent() {
                  if (failure) throw failure;
                  if (!opened) return blocked();
                  verify(opened.generation!, opened, phase === 'reopening');
                },
                rethrowRefusal() {
                  withinBudget();
                  if (failure) throw failure;
                },
              });
            },
          });
          const timer = setTimeout(expire, MAX_DEVICE_CALLBACK_MS);
          timer.unref();
          workStarted = true;
          try {
            return await withinDeviceCallback(() => work(authorization));
          } finally {
            try {
              // A delayed timer must not let a synchronous throw escape quarantine. Deadline refusal wins on every exit.
              withinBudget();
            } finally {
              active = false;
              if (expired) expiredCallbacks--;
              clearTimeout(timer);
            }
          }
        });
      } catch (error) {
        if (workStarted || error instanceof DeviceAdmissionRefusal) throw error;
        // Unreadable metadata, unknown state, a lost lock and database errors are all closed, without their values.
        return blocked();
      }
    },
  });
  admissions.add(admission);
  return admission;
}
