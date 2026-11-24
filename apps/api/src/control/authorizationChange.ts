import { cardSyncRefusalCode } from '../services/cardSync/refusals.js';
import { ControlError, describeError } from './errors.js';
import { randomHex16 } from './files.js';
import { readMarker, withAuthorizationLock } from './lifecycle.js';
import {
  GENERATION, fenceState, newGeneration, readFence, sameFence, writeFence, type FenceRead, type FenceState, type GateReason,
} from './syncAuthState.js';

/**
 * E2's authorization-change protocol (E1b design §10 item 2, §5.0; E0-I design §9.3 "Fence writes", §9.4) over PR B's fence
 * (`sync-auth-state`) and `authorization.lock`.
 *
 * Every authorization change of E1b §5.0 runs with `authorization.lock` held. Two cases:
 *
 * - **Gate open.** The fence is open for this machine, and the database holds its generation G:
 *   1. write `blocked/change {generation: G, next: N, op}`;
 *   2. call the repository with `{ expectedGeneration: G, nextGeneration: N }`;
 *   3. read the database generation D' (whether the call returned or threw). The repository compares-and-sets, so D' is G
 *      (nothing changed, or refused) or N;
 *   4. write `open D'`, but only if the fence still holds exactly what step 1 wrote (a defensive compare-and-swap on `op`).
 *      Anything else is left as found, so the gate stays blocked.
 * - **Gate blocked**, for any reason (an incident, init, reinit, a recovery, a change that never finished, a missing, invalid
 *   or other machine's fence, or an open fence the database disagrees with):
 *   - an open-fence/DB mismatch is durably latched as an incident before any refusal or repository call;
 *   - widening changes are refused (`authorization-blocked`) before the repository is called;
 *   - narrowing changes call it with the database's generation and a fresh next, and the gate stays blocked. An incident block
 *     records the new generation. An open fence that disagreed with the database is turned into `blocked/incident`, so a
 *     later swap back to the old database can never make the old generation look current. Only recovery reopens.
 *
 * A change block left by a crash reopens only when the database holds exactly its `next`: at startup (`reconcileChangeBlock`)
 * and before any later change. Every function here assumes the caller already holds `authorization.lock`, except
 * `createAuthorizationGateService`, which takes it. PR D's `DeviceAdmission` holds the lock across its work and calls
 * `changeWithAuthorizationLockHeld` for pairing redemption (E2c).
 *
 * Generations, ops and fence contents never reach a log line or an answer; log lines carry fixed codes only.
 */

export type AuthorizationChangeKind = 'widening' | 'narrowing';

export interface GenerationStep {
  readonly expectedGeneration: string;
  readonly nextGeneration: string;
}

/** What a change result must report: the database's generation after the call (E1b `CardSyncAuthChange`, or redeem's result). */
export interface GenerationReport {
  readonly authorizationGeneration: string;
}

export interface AuthorizationChangePlan {
  readonly controlDir: string;
  readonly before: FenceState;
  readonly change: FenceState;
}

/** One already-locked change's effects, never a general permission to use a blocked gate. */
export interface AuthorizationEffectGuard {
  beforeBlock(): void;
  beforeMutation(): void;
  afterMutation(generation: string): void;
  beforeOpen(opened: FenceState): void;
  assertCurrent(): void;
  /** Restore only a refusal this guard observed; the repository's value-free exception boundary remains unchanged. */
  rethrowRefusal(): void;
}

export interface AuthorizationFenceContext {
  readonly controlDir: string;
  /**
   * This machine's id (PR B's K21 value); every fence this protocol writes names it. Null when it could not be computed: then
   * no fence reads as this machine's, so the gate stays blocked and nothing here writes the fence (narrowing changes still run).
   */
  readonly machine: string | null;
  /** The database's authorization generation (`getCardSyncAuthorizationGeneration`). */
  databaseGeneration(): string;
  /** Value-free operational log (fixed codes). */
  log?(line: string): void;
}

/** A widening change while the gate is blocked (owner API rule 7; E1b §5.0). Value-free. */
export class AuthorizationBlockedError extends Error {
  readonly code = 'authorization-blocked';
  constructor() {
    super('card-sync:authorization-blocked');
    this.name = 'AuthorizationBlockedError';
  }
}

export function isAuthorizationBlocked(error: unknown): error is AuthorizationBlockedError {
  return error instanceof AuthorizationBlockedError;
}

/**
 * Why the gate is not open: the fence read's reason, `inconsistent` (an open fence the database disagrees with) or `unknown`
 * (the fence or the database could not be read).
 */
export type GateBlock = GateReason | 'inconsistent' | 'unknown';

export type GateView =
  | { readonly gate: 'open'; readonly state: FenceState; readonly generation: string }
  | { readonly gate: 'blocked'; readonly block: GateBlock; readonly state?: FenceState };

const logOf = (ctx: AuthorizationFenceContext) => (line: string) => (ctx.log ?? ((text: string) => console.warn(text)))(line);

function readGate(ctx: AuthorizationFenceContext, database: string): GateView {
  let read: FenceRead;
  try {
    read = readFence(ctx.controlDir, ctx.machine);
  } catch {
    // K21 metadata problems (E0I_FENCE_FILE): the gate is closed and the file is never rewritten here.
    return { gate: 'blocked', block: 'unknown' };
  }
  if (read.gate === 'closed') return { gate: 'blocked', block: read.reason, state: read.state };
  const generation = read.state.generation!;
  if (generation !== database) return { gate: 'blocked', block: 'inconsistent', state: read.state };
  return { gate: 'open', state: read.state, generation };
}

/** The gate as a reader sees it, without the lock (owner `GET /state`, E2a's source checks): open only if the database agrees. */
export function gateView(ctx: AuthorizationFenceContext): GateView {
  let database: string;
  try {
    database = ctx.databaseGeneration();
  } catch {
    return { gate: 'blocked', block: 'unknown' };
  }
  return readGate(ctx, database);
}

/**
 * The startup rule (E1b §10 item 2), with `authorization.lock` held: a change block for this machine reopens when the
 * database holds exactly its `next` (the change committed and only the final fence write was lost). Anything else is left
 * as it is. Returns whether it reopened the gate.
 */
export function reconcileChangeBlock(ctx: AuthorizationFenceContext): boolean {
  let read: FenceRead;
  try {
    read = readFence(ctx.controlDir, ctx.machine);
  } catch {
    return false;
  }
  const database = ctx.databaseGeneration();
  if (read.gate === 'open' && read.state.generation !== database) {
    latchIncident(ctx, read.state, database);
    return false;
  }
  if (read.gate !== 'closed' || read.reason !== 'blocked:change' || !read.state) return false;
  if (database !== read.state.next || ctx.machine === null) return false;
  writeFence(ctx.controlDir, fenceState({ gate: 'open', reason: null, generation: database, next: null, op: null, machine: ctx.machine }));
  logOf(ctx)('[card-sync] device gate: an unfinished authorization change had committed; the gate is open again');
  return true;
}

function generationOf(value: unknown): string | null {
  return typeof value === 'string' && GENERATION.test(value) ? value : null;
}

function latchIncident(ctx: AuthorizationFenceContext, state: FenceState, database: string): FenceState {
  if (ctx.machine === null || state.machine !== ctx.machine || generationOf(database) === null) throw new AuthorizationBlockedError();
  const blocked = fenceState({ gate: 'blocked', reason: 'incident', generation: database, next: null, op: null, machine: ctx.machine });
  writeFence(ctx.controlDir, blocked);
  logOf(ctx)('[card-sync] device gate: a database/fence mismatch is durably blocked (incident)');
  return blocked;
}

/**
 * One authorization change, with `authorization.lock` already held by the caller (see the file comment). `call` must run the
 * repository method with the generations it is given and return its result; it is called at most once. A refusal or failure
 * of `call` is rethrown after the fence is put back.
 */
export function changeWithAuthorizationLockHeld<R extends GenerationReport>(
  ctx: AuthorizationFenceContext,
  kind: AuthorizationChangeKind,
  call: (step: GenerationStep) => R,
  createEffects?: (plan: AuthorizationChangePlan) => AuthorizationEffectGuard,
): R {
  if (kind !== 'widening' && kind !== 'narrowing') throw new TypeError('an authorization change is widening or narrowing');
  reconcileChangeBlock(ctx);
  const database = ctx.databaseGeneration();
  let view = readGate(ctx, database);
  if (view.gate === 'blocked' && view.block === 'inconsistent') {
    const state = latchIncident(ctx, view.state!, database);
    view = { gate: 'blocked', block: 'blocked:incident', state };
  }
  if (view.gate === 'open') return changeThroughOpenGate(ctx, view, call, createEffects);
  if (kind === 'widening') throw new AuthorizationBlockedError();
  return narrowWhileBlocked(ctx, view, database, call);
}

/** Compensating revocation after a failed handoff: no lock acquisition and no reconciliation/reopening, even for change blocks. */
export function narrowBlockedWithAuthorizationLockHeld<R extends GenerationReport>(
  ctx: AuthorizationFenceContext, call: (step: GenerationStep) => R,
): R {
  const database = ctx.databaseGeneration();
  let view = readGate(ctx, database);
  if (view.gate === 'open' || view.block === 'inconsistent') {
    const state = latchIncident(ctx, view.state!, database);
    view = { gate: 'blocked', block: 'blocked:incident', state };
  }
  return narrowWhileBlocked(ctx, view, database, call);
}

function changeThroughOpenGate<R extends GenerationReport>(
  ctx: AuthorizationFenceContext,
  view: Extract<GateView, { gate: 'open' }>,
  call: (step: GenerationStep) => R,
  createEffects?: (plan: AuthorizationChangePlan) => AuthorizationEffectGuard,
): R {
  const log = logOf(ctx);
  // An open view needs a fence that names this machine, so the machine is known here.
  const machine = ctx.machine!;
  const G = view.generation;
  const N = newGeneration();
  const change = fenceState({ gate: 'blocked', reason: 'change', generation: G, next: N, op: randomHex16(), machine });
  const effects = createEffects?.(Object.freeze({ controlDir: ctx.controlDir, before: view.state, change }));
  // Durable before the database moves: a crash from here on leaves the gate blocked until the database is shown to hold N.
  effects?.beforeBlock();
  writeFence(ctx.controlDir, change);
  let result: R | undefined;
  let failure: unknown;
  let failed = false;
  try {
    effects?.beforeMutation();
    result = call({ expectedGeneration: G, nextGeneration: N });
  } catch (error) {
    failed = true;
    failure = error;
  }
  let after: string | null = null;
  try {
    after = generationOf(ctx.databaseGeneration());
  } catch {
    after = null;
  }
  const reported = failed ? after : generationOf(result?.authorizationGeneration);
  if (after === null || (after !== G && after !== N) || reported !== after) {
    log('[card-sync] device gate: the database generation after a change is not the one expected; the gate stays blocked (change)');
  } else {
    try {
      const current = readFence(ctx.controlDir, machine);
      if (current.state && sameFence(current.state, change)) {
        const opened = fenceState({ gate: 'open', reason: null, generation: after, next: null, op: null, machine });
        effects?.beforeOpen(opened);
        writeFence(ctx.controlDir, opened);
      } else {
        log('[card-sync] device gate: the fence changed during an authorization change; it is left as found');
      }
    } catch (error) {
      // The change itself is done (or refused); only the reopening failed. The gate stays blocked (change) until the
      // startup rule or the next change finds the database at `next`, or recovery runs.
      log(`[card-sync] device gate: could not reopen after an authorization change (${describeError(error)})`);
    }
  }
  effects?.rethrowRefusal();
  if (failed) throw failure;
  return result as R;
}

function narrowWhileBlocked<R extends GenerationReport>(
  ctx: AuthorizationFenceContext,
  view: Extract<GateView, { gate: 'blocked' }>,
  database: string,
  call: (step: GenerationStep) => R,
): R {
  const log = logOf(ctx);
  const result = call({ expectedGeneration: database, nextGeneration: newGeneration() });
  let after: string | null;
  try {
    after = generationOf(ctx.databaseGeneration());
  } catch {
    after = null;
  }
  const state = view.state;
  // Record the result, keeping the gate blocked (E1b §10 item 2). Fences of another machine, missing, invalid or unreadable
  // ones, init, reinit, recovery and unfinished changes are never rewritten here.
  const machine = ctx.machine;
  const record = after !== null && machine !== null && state !== undefined && state.machine === machine
    && view.block === 'blocked:incident' && state.generation !== after;
  if (record) {
    try {
      const current = readFence(ctx.controlDir, machine);
      if (!current.state || !sameFence(current.state, state)) return result;
      writeFence(ctx.controlDir, fenceState({ gate: 'blocked', reason: 'incident', generation: after, next: null, op: null, machine }));
    } catch (error) {
      log(`[card-sync] device gate: could not record a change while blocked (${describeError(error)})`);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------------
// The API process's gate service
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * What the API's card-sync routes use: E2a's source checks (`generationForSourceChecks`), the owner state's gate, and E2b's
 * authorization changes. `wired` is false where no control dir exists (`dev`): there the gate is always blocked, widening
 * changes are refused and narrowing ones compare-and-set the database generation alone.
 */
export interface CardSyncAuthorizationService {
  readonly wired: boolean;
  /** The open gate's generation for extension sets' plans and commits (E2a), or null while blocked. */
  generationForSourceChecks(): string | null;
  /** `open` or `blocked`, as the owner API's `State.gate` reports it. */
  status(): 'open' | 'blocked';
  /** One authorization change under the protocol: in-process order, `authorization.lock`, the fence. */
  change<R extends GenerationReport>(kind: AuthorizationChangeKind, call: (step: GenerationStep) => R): Promise<R>;
  /** The startup rule, once the database is open. */
  reconcile(): Promise<boolean>;
}

export interface AuthorizationGateOptions extends AuthorizationFenceContext {
  /**
   * Whether this process still holds its shared lifecycle lease (PR B's `lifecycleEvidence().leaseLive`). Widening changes
   * need it and a normal marker inside the lock; omission permits only narrowing, so revocation stays possible.
   */
  leaseLive?(): boolean;
  /** How long a change waits for `authorization.lock` (default 10 s, then `E0I_AUTHORIZATION_BUSY`). */
  lockTimeoutMs?: number;
}

/** The wired service whenever a control dir exists, including configured dev. */
export function createAuthorizationGateService(options: AuthorizationGateOptions): CardSyncAuthorizationService {
  const ctx: AuthorizationFenceContext = options;
  const assertWidening = () => {
    let live = false;
    try { live = options.leaseLive?.() === true; } catch { /* missing evidence refuses */ }
    if (!live || readMarker(options.controlDir)?.state !== 'normal') throw new AuthorizationBlockedError();
  };
  let tail: Promise<unknown> = Promise.resolve();
  // Changes of this process run one after another; the lock orders them against every other process and PR D's admission.
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
  const open = () => {
    const view = gateView(ctx);
    return view.gate === 'open' ? view.generation : null;
  };
  return Object.freeze({
    wired: true,
    generationForSourceChecks: open,
    status: () => (open() === null ? 'blocked' as const : 'open' as const),
    change<R extends GenerationReport>(kind: AuthorizationChangeKind, call: (step: GenerationStep) => R): Promise<R> {
      return serialize(() => withAuthorizationLock(options.controlDir, () => {
        if (kind === 'widening') assertWidening();
        return changeWithAuthorizationLockHeld(ctx, kind, (step) => {
          if (kind === 'widening') assertWidening();
          return call(step);
        });
      }, options.lockTimeoutMs));
    },
    reconcile: () => serialize(() => withAuthorizationLock(options.controlDir, () => reconcileChangeBlock(ctx), options.lockTimeoutMs)),
  });
}

/**
 * The service where there is no control dir (`dev`): no fence and no lock to take. Widening changes are refused; a narrowing
 * change compares-and-sets the database generation, read just before, once more after a `generation-mismatch` (another process
 * changed it in between).
 */
export function unwiredAuthorizationGateService(options: { databaseGeneration(): string }): CardSyncAuthorizationService {
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
  return Object.freeze({
    wired: false,
    generationForSourceChecks: () => null,
    status: () => 'blocked' as const,
    change<R extends GenerationReport>(kind: AuthorizationChangeKind, call: (step: GenerationStep) => R): Promise<R> {
      if (kind !== 'narrowing') return Promise.reject(new AuthorizationBlockedError());
      return serialize(async () => {
        const once = () => call({ expectedGeneration: options.databaseGeneration(), nextGeneration: newGeneration() });
        try {
          return once();
        } catch (error) {
          if (cardSyncRefusalCode(error) !== 'generation-mismatch') throw error;
          return once();
        }
      });
    },
    reconcile: async () => false,
  });
}

/** For CLIs and logs: a value-free code for why a change did not run. */
export function describeChangeFailure(error: unknown): string {
  if (error instanceof AuthorizationBlockedError) return 'authorization-blocked';
  if (error instanceof ControlError) return describeError(error);
  return cardSyncRefusalCode(error) ?? 'failed';
}
