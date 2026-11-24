import fs from 'node:fs';
import path from 'node:path';

import {
  CONTROL_ENTRIES, addTimeMachineExclusion, bootstrapControlDir, controlShape, controlStatus, formatControlStatus, initControlDir,
} from '../control/controlDir.js';
import { ControlError, EXIT } from '../control/errors.js';
import { formatHolders, openHolders } from '../control/holders.js';
import { assertNoLeaseEnv, type Lease } from '../control/lifecycle.js';
import { describeLeaveTarget, leaveTarget } from '../control/leaveTarget.js';
import { verifiedDisposableStack } from './disposableStack.js';
import { dbInUseGuard, holdExclusive, leaveMaintenance, runStopRole, validateLeaveTarget } from '../control/maintenance.js';
import { managedLive, repoPaths } from '../control/paths.js';
import { blockFence, enterRecovery } from '../control/recovery.js';
import type { Runner } from '../control/runner.js';
import { RESET_AUTHORIZATION_USAGE, resetAuthorization } from './resetAuthorization.js';
import {
  assertNoExtraArgs, controlContext, machineFor, reportFailure, takeOption, timeoutMs, type Io,
} from './controlCommon.js';

export const RECOVERY_USAGE = `Usage: npm run holdr-recovery -- <command>

  init                 create the control dir (blocked/init, lifecycle normal, lock files) and exclude it from Time Machine
  status               the device gate, files, Time Machine exclusion, lifecycle marker and lock holders (no locks taken)
  block [--reason incident]
                       block the device gate (blocked/incident), keeping the generation; works while Holdr runs
  reinit [--timeout <s>]
                       after a whole-machine restore or migration: blocked/reinit first, then maintenance, holdr-stop
                       (always of the live deployment, HOLDR_ROOT or ~/Holdr, whichever tree runs it),
                       drain, offline validation and leave (the drain waits at most <s> seconds, default 60). An absent
                       or partial control dir (Time Machine excludes it; an interrupted init) is rebuilt first, fresh
                       and blocked, once Holdr is shown to be stopped; never restore a control dir from a backup
${RESET_AUTHORIZATION_USAGE}`;

/**
 * `holdr-recovery` (design §9.6). reset-authorization is E2's (resetAuthorization.ts); restore arrives with a later E2 slice and
 * is refused with a fixed message.
 * Every command refuses lease variables (`status` inside a lease is `holdr-leased status`); recovery entry refuses them as
 * `E0I_RECOVERY_IN_LEASE` (§9.3 rule 4).
 */
export async function runHoldrRecovery(argv: readonly string[], options: { env: NodeJS.ProcessEnv; io: Io; run: Runner }): Promise<number> {
  const { io, run } = options;
  const args = [...argv];
  const command = args.shift();
  try {
    if (!command || command === '--help' || command === '-h') {
      (command ? io.stdout : io.stderr).write(RECOVERY_USAGE);
      return command ? 0 : 64;
    }
    if (command === 'restore') throw new ControlError('E0I_NOT_AVAILABLE', 1, 'restore arrives with a later E2 slice; nothing changed');
    if (command !== 'reinit' && command !== 'reset-authorization') assertNoLeaseEnv(options.env);
    const context = controlContext(options.env);
    switch (command) {
      case 'init': {
        assertNoExtraArgs(args);
        const machine = await machineFor(context, run);
        const result = await initControlDir(context.controlDir, { machine, run, repo: repoPaths(), dataDir: context.dataDir });
        io.stdout.write(`created ${context.controlDir}: device gate blocked (init), lifecycle normal\n`);
        io.stdout.write(result.excluded ? 'time machine: excluded\n'
          : 'time machine: NOT excluded (tmutil failed); run: tmutil addexclusion <control dir>\n');
        return 0;
      }
      case 'status': {
        assertNoExtraArgs(args);
        let machine: string | null = null;
        try { machine = await machineFor(context, run); } catch { machine = null; }
        io.stdout.write(formatControlStatus(await controlStatus(context.controlDir, { machine, run })));
        return 0;
      }
      case 'block': {
        const reason = takeOption(args, '--reason') ?? 'incident';
        assertNoExtraArgs(args);
        if (reason !== 'incident') throw new ControlError('E0I_USAGE', 64, 'block only takes --reason incident');
        let machine: string | null = null;
        try { machine = await machineFor(context, run); } catch { machine = null; }
        const result = await blockFence(context.controlDir, machine);
        io.stdout.write(result === 'blocked' ? 'device gate: blocked (incident)\n' : 'device gate: already blocked (incident)\n');
        return 0;
      }
      case 'reinit': {
        // B1 round-2 finding 1: inside a lease nothing happens at all, not even the stop role or a bootstrap.
        assertNoLeaseEnv(options.env, 'E0I_RECOVERY_IN_LEASE');
        const configPath = context.config.location.kind === 'file' ? context.config.location.path : null;
        const wait = timeoutMs(takeOption(args, '--timeout'), 60);
        assertNoExtraArgs(args);
        // The stop role's target before any side effect: a HOLDR_ROOT naming a staging tree, a kit or nothing refuses here
        // (E0I_NOT_LIVE), not after the quarantine (B1 round-3 finding 2).
        managedLive(options.env);
        const machine = await machineFor(context, run);
        const repo = repoPaths();
        const shape = controlShape(context.controlDir, { repo, dataDir: context.dataDir });
        if (shape.kind === 'unsafe') {
          throw new ControlError('E0I_CONTROL_DIR', 1, `${shape.detail}; reinit never replaces an unsafe entry: inspect it by hand`);
        }
        let recoveryLock: Lease | undefined;
        if (shape.kind !== 'complete') {
          // B1 review 5: rebuild an absent or partial control dir, but only after showing that nothing can hold its old locks:
          // the stop role, nobody holding the database, nobody holding a control file. Uncertainty refuses.
          io.stdout.write(`control dir ${shape.kind}${shape.kind === 'partial' ? ` (missing ${shape.missing.join(', ')})` : ''}: showing that Holdr is stopped before rebuilding it\n`);
          if (await runStopRole(options.env, configPath, (line) => io.stderr.write(`${line}\n`)) !== 0) {
            throw new ControlError('E0I_STOP_FAILED', 1, 'holdr-stop failed; the control dir was not rebuilt');
          }
          await dbInUseGuard(run, context.dataDir);
          const present = CONTROL_ENTRIES.map((name) => path.join(context.controlDir, name)).filter((file) => fs.existsSync(file));
          const holders = await openHolders(run, present);
          if (holders === null) throw new ControlError('E0I_LIFECYCLE_BUSY', EXIT.busy, 'lsof failed; cannot show that no process holds a control file');
          if (holders.length) throw new ControlError('E0I_LIFECYCLE_BUSY', EXIT.busy, `control files are held by ${formatHolders(holders)}; the control dir was not rebuilt`);
          // Quarantine (maintenance, blocked/reinit) before any lock that could let Holdr start or admit is repaired; the
          // returned recovery.lock serializes the bootstrap and the recovery entry below (B1 round-2 finding 1).
          const rebuilt = await bootstrapControlDir(context.controlDir, { machine, repo, dataDir: context.dataDir });
          recoveryLock = rebuilt.recoveryLock;
          io.stdout.write(`control dir rebuilt (created ${rebuilt.created.join(', ')}; device gate blocked (reinit), lifecycle maintenance (reinit))\n`);
        }
        const entry = await enterRecovery(context.controlDir, { env: options.env, machine, kind: 'reinit', recoveryLock });
        io.stdout.write('device gate: blocked (reinit); lifecycle: maintenance (reinit)\n');
        if (recoveryLock) {
          // The Time Machine exclusion only once the quarantine holds (a mitigation, §9.2: reported, not fatal).
          const excluded = await addTimeMachineExclusion(run, context.controlDir);
          io.stdout.write(`time machine: ${excluded ? 'excluded' : 'NOT excluded (run: tmutil addexclusion <control dir>)'}\n`);
        }
        try {
          // Maintenance step 2: the stop role (the fence is already blocked, so a failure here leaves Holdr closed).
          if (await runStopRole(options.env, configPath, (line) => io.stderr.write(`${line}\n`)) !== 0) {
            throw new ControlError('E0I_STOP_FAILED', 1, 'holdr-stop failed; the device gate stays blocked and the marker maintenance');
          }
          const held = await holdExclusive(context.controlDir, {
            timeoutMs: wait, run, owner: 'holdr-recovery reinit', log: (line) => io.stderr.write(`${line}\n`),
          });
          try {
            await dbInUseGuard(run, context.dataDir);
            // The environment as given (see holdr-lifecycle): derived values belong to each process's own tree. From a
            // rollback kit the target is the live deployment, never the kit (B-D36).
            const target = leaveTarget(options.env, configPath, [], undefined, { disposable: verifiedDisposableStack(options.env, configPath, context.dataDir) });
            io.stderr.write(`holdr-recovery: ${describeLeaveTarget(target)}\n`);
            const validation = await validateLeaveTarget(held, configPath ? { ...options.env, HOLDR_CONFIG: configPath } : { ...options.env }, target);
            if (validation !== 0) throw new ControlError('E0I_VALIDATION', 1, 'offline validation failed; still in maintenance');
            await leaveMaintenance(context.controlDir, held, { run, owner: 'holdr-recovery reinit' });
          } finally {
            held.lease.release();
          }
        } finally {
          entry.recoveryLock.release();
        }
        io.stdout.write('reinit complete: lifecycle normal, device gate stays blocked (reinit) until E2 reset-authorization\n');
        return 0;
      }
      case 'reset-authorization':
        return await resetAuthorization(args, {
          env: options.env, io, run, context, configPath: context.config.location.kind === 'file' ? context.config.location.path : null,
        });
      default:
        throw new ControlError('E0I_USAGE', 64, `unknown command ${command}`);
    }
  } catch (error) {
    return reportFailure('holdr-recovery', io, error);
  }
}

