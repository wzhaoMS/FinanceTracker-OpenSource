import fs from 'node:fs';
import path from 'node:path';

import { controlShape } from '../control/controlDir.js';
import { ControlError } from '../control/errors.js';
import { describeLeaveTarget, leaveTarget } from '../control/leaveTarget.js';
import { verifiedDisposableStack } from './disposableStack.js';
import { dbInUseGuard, holdExclusive, leaveMaintenance, runStopRole, validateLeaveTarget } from '../control/maintenance.js';
import { managedLive, repoPaths } from '../control/paths.js';
import { COMPLETION_EXIT, completeRecovery, enterRecovery } from '../control/recovery.js';
import type { Runner } from '../control/runner.js';
import type { CardSyncRecoveryReport } from '../services/cardSync/recovery.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { assertNoExtraArgs, machineFor, takeOption, timeoutMs, type ControlContext, type Io } from './controlCommon.js';

export const RESET_AUTHORIZATION_USAGE = `  reset-authorization [--timeout <s>]
                       recovery (E1b §5.8): blocked/recovery with a fresh generation first, then maintenance, holdr-stop and
                       the drain; with Holdr stopped, one transaction revokes every browser and invitation, cancels every
                       plan, expires open runs, pauses syncing, turns every issuer off and asks for every binding to be
                       confirmed again; verified; the gate opens at the new generation unless an operator block arrived
                       meanwhile (then exit 5, still blocked); then offline validation and normal. The first E2 deployment
                       runs it once (init or reinit leaves the gate blocked)
`;

/**
 * `holdr-recovery reset-authorization` (E0-I design §9.6, E1b §5.8 and §10 items 2 and 6): the only path besides `restore`
 * that reopens a blocked gate. The order is PR B's recovery entry (§9.3): refused inside a lease, `recovery.lock`, the fence
 * `blocked/recovery + N` written first, the marker `maintenance`, the stop role, the drain and the exclusive lease, the
 * database shown unused; then `invalidateAllCardSyncAuthorization({ nextGeneration: N })` in this listener-less process,
 * the check that nothing still carries authority, and the compare-and-swap completion (`open N`, or exit 5 when an operator
 * block arrived). A rerun after an interruption keeps N and finishes the same recovery; a database that already holds N is
 * not invalidated twice (the invalidation and N are one transaction).
 */
export async function resetAuthorization(args: string[], options: {
  env: NodeJS.ProcessEnv; io: Io; run: Runner; context: ControlContext; configPath: string | null;
}): Promise<number> {
  const { io, run, context, configPath } = options;
  const wait = timeoutMs(takeOption(args, '--timeout'), 60);
  assertNoExtraArgs(args);
  managedLive(options.env);
  const shape = controlShape(context.controlDir, { repo: repoPaths(), dataDir: context.dataDir });
  if (shape.kind !== 'complete') {
    throw new ControlError('E0I_CONTROL_DIR', 1, 'the control dir is not complete: run holdr-recovery reinit first');
  }
  const dbFile = path.join(context.dataDir, 'finance.db');
  if (!fs.existsSync(dbFile)) throw new ControlError('E0I_DB_MISSING', 1, 'no finance.db in the data dir; nothing changed');
  const machine = await machineFor(context, run);
  const entry = await enterRecovery(context.controlDir, { env: options.env, machine, kind: 'recovery' });
  io.stdout.write('device gate: blocked (recovery); lifecycle: maintenance (recovery)\n');
  try {
    if (await runStopRole(options.env, configPath, (line) => io.stderr.write(`${line}\n`)) !== 0) {
      throw new ControlError('E0I_STOP_FAILED', 1, 'holdr-stop failed; the device gate stays blocked and the marker maintenance');
    }
    const held = await holdExclusive(context.controlDir, {
      timeoutMs: wait, run, owner: 'holdr-recovery reset-authorization', log: (line) => io.stderr.write(`${line}\n`),
    });
    try {
      await dbInUseGuard(run, context.dataDir);
      let report: CardSyncRecoveryReport | null = null;
      const repo = new SqliteStateRepo({ file: dbFile });
      let result: Awaited<ReturnType<typeof completeRecovery>>;
      try {
        result = await completeRecovery(context.controlDir, entry, {
          machine,
          setDatabaseGeneration: (next) => {
            if (repo.getCardSyncAuthorizationGeneration() !== next) report = repo.invalidateAllCardSyncAuthorization({ nextGeneration: next });
            const left = repo.getCardSyncRemainingAuthority();
            const remaining = [
              left.generation !== next && 'generation', left.resolvingDevices > 0 && 'devices', left.activeGrants > 0 && 'grants',
              left.preparedPlans > 0 && 'plans', left.openRuns > 0 && 'runs', left.openPairings > 0 && 'pairings', !left.paused && 'not paused',
              left.enabledIssuers > 0 && 'issuers',
            ].filter(Boolean);
            if (remaining.length) {
              throw new ControlError('E0I_RECOVERY_VERIFY', 1, `still authorized after the invalidation: ${remaining.join(', ')}; the gate stays blocked`);
            }
          },
        });
      } finally {
        repo.close();
      }
      if (report) {
        const r = report as CardSyncRecoveryReport;
        io.stdout.write(`revoked ${r.devicesRevoked} browser(s) (${r.grantsRevoked} grant(s)); cancelled ${r.pairingsCancelled} invitation(s) and `
          + `${r.plansCancelled} plan(s); expired ${r.runsExpired} run(s); ${r.issuersDisabled} issuer(s) turned off; `
          + `${r.bindingsToReconfirm} binding(s) to confirm again; ${r.setsToRecoveryReview} set(s) held for review; syncing paused\n`);
      } else {
        io.stdout.write('the database already held this recovery\'s generation: nothing invalidated twice\n');
      }
      // B's layout-first rule also rejects staging/kit targets before self or disposable acceptance.
      const target = leaveTarget(options.env, configPath, [], undefined, { disposable: verifiedDisposableStack(options.env, configPath, context.dataDir) });
      io.stderr.write(`holdr-recovery: ${describeLeaveTarget(target)}\n`);
      const validation = await validateLeaveTarget(held, configPath ? { ...options.env, HOLDR_CONFIG: configPath } : { ...options.env }, target);
      if (validation !== 0) throw new ControlError('E0I_VALIDATION', 1, 'offline validation failed; still in maintenance');
      await leaveMaintenance(context.controlDir, held, { run, owner: 'holdr-recovery reset-authorization' });
      io.stdout.write(result === 'opened'
        ? 'reset-authorization complete: device gate open at a fresh generation; lifecycle normal\n'
        : 'reset-authorization complete, but an operator block arrived meanwhile: the device gate stays blocked; lifecycle normal\n');
      return COMPLETION_EXIT[result];
    } finally {
      held.lease.release();
    }
  } finally {
    entry.recoveryLock.release();
  }
}
