import { EXIT, fail } from './errors.js';
import { randomHex16 } from './files.js';
import { assertNoLeaseEnv, marker, tryRecoveryLock, withAuthorizationLock, writeMarker, type Lease } from './lifecycle.js';
import {
  fenceState, newGeneration, readFence, sameFence, writeFence, type FenceRead, type FenceState,
} from './syncAuthState.js';

/** The fence as last written, even when its machine differs (or is unknown); null when missing, invalid or unusable. */
function currentFence(controlDir: string, machine: string | null): FenceState | null {
  let read: FenceRead;
  try {
    read = readFence(controlDir, machine);
  } catch {
    return null;
  }
  return read.state ?? null;
}

/**
 * `holdr-recovery block [--reason incident]` (§9.6): under `authorization.lock` (≤ 10 s), `blocked/incident` keeping the
 * generation; idempotent; works while Holdr runs. An incident block is never overwritten by a change in flight, because
 * every fence writer holds the same lock and E2's change re-reads before it opens.
 */
export async function blockFence(controlDir: string, machine: string | null): Promise<'blocked' | 'already-blocked'> {
  return withAuthorizationLock(controlDir, () => {
    const current = currentFence(controlDir, machine);
    // Without this machine's id the fence keeps its own machine value: blocking must not depend on ioreg or diskutil.
    const owner = machine ?? current?.machine;
    if (!owner) return fail('E0I_MACHINE_ID', 'no machine id and no valid fence to keep; the device gate is already closed');
    if (current && current.gate === 'blocked' && current.reason === 'incident' && current.machine === owner) return 'already-blocked';
    writeFence(controlDir, fenceState({
      gate: 'blocked', reason: 'incident', generation: current?.generation ?? null, next: null, op: null, machine: owner,
    }));
    return 'blocked';
  });
}

export interface RecoveryEntry {
  readonly recoveryLock: Lease;
  readonly state: FenceState;
}

/**
 * Recovery entry (§9.3, plan §6.1 and §9.5 step 1): refused inside a lease; `recovery.lock` without waiting (or the one a
 * reinit's bootstrap already holds, `options.recoveryLock`); then, under
 * `authorization.lock`, this operation's fence state is written and fsynced **before** anything is stopped or drained.
 * `reinit` writes `blocked/reinit` for this machine. A recovery writes `blocked/recovery` with a fresh `next` and `op`,
 * or takes an interrupted recovery over by compare-and-swap on the exact state read, keeping its `next`.
 * Then the marker goes to `maintenance`.
 */
export async function enterRecovery(controlDir: string, options: {
  env: NodeJS.ProcessEnv; machine: string; kind: 'reinit' | 'recovery';
  /** `recovery.lock` already held by this operation (a reinit's bootstrap, B1 round-2 finding 1): no second attempt. */
  recoveryLock?: Lease;
}): Promise<RecoveryEntry> {
  try {
    assertNoLeaseEnv(options.env, 'E0I_RECOVERY_IN_LEASE');
  } catch (error) {
    options.recoveryLock?.release();
    throw error;
  }
  const recoveryLock = options.recoveryLock ?? tryRecoveryLock(controlDir);
  try {
    const state = await withAuthorizationLock(controlDir, () => {
      const current = currentFence(controlDir, options.machine);
      let next: FenceState;
      if (options.kind === 'reinit') {
        next = fenceState({ gate: 'blocked', reason: 'reinit', generation: null, next: null, op: null, machine: options.machine });
      } else if (current && current.gate === 'blocked' && current.reason === 'recovery') {
        next = fenceState({ ...current, op: randomHex16(), machine: options.machine, updatedAt: undefined });
      } else {
        next = fenceState({
          gate: 'blocked', reason: 'recovery', generation: current?.generation ?? null, next: newGeneration(), op: randomHex16(),
          machine: options.machine,
        });
      }
      writeFence(controlDir, next);
      return next;
    });
    writeMarker(controlDir, marker({ state: 'maintenance', reason: options.kind }, `holdr-recovery ${options.kind}`));
    return { recoveryLock, state };
  } catch (error) {
    recoveryLock.release();
    throw error;
  }
}

export type CompletionResult = 'opened' | 'completed-but-blocked';

/**
 * Completion by compare-and-swap (§9.3 step 4, round 3 B4): under `authorization.lock` (lifecycle lease held), re-read the
 * fence. Only if it is still exactly this operation's state `R` (same `op`) does E2's DB compare-and-set run and the fence
 * become `open N`. Anything else (an operator's `blocked/incident`, a takeover) wins: the fence is left as it is, the DB
 * part still completes, and the result is `completed-but-blocked` (exit 5).
 */
export async function completeRecovery(controlDir: string, entry: RecoveryEntry, options: {
  machine: string; setDatabaseGeneration: (generation: string) => Promise<void> | void;
}): Promise<CompletionResult> {
  const R = entry.state;
  if (R.reason !== 'recovery' || !R.next || !R.op) return fail('E0I_INTERNAL', 'only a recovery state completes');
  return withAuthorizationLock(controlDir, async () => {
    const current = currentFence(controlDir, options.machine);
    await options.setDatabaseGeneration(R.next!);
    if (!sameFence(current ?? undefined, R)) return 'completed-but-blocked';
    writeFence(controlDir, fenceState({ gate: 'open', reason: null, generation: R.next, next: null, op: null, machine: options.machine }));
    return 'opened';
  });
}

export const COMPLETION_EXIT: Record<CompletionResult, number> = { opened: 0, 'completed-but-blocked': EXIT.completedButBlocked };
