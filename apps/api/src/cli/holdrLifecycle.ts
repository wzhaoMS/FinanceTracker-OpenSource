import { controlStatus, formatControlStatus } from '../control/controlDir.js';
import { ControlError, EXIT } from '../control/errors.js';
import {
  REASON, assertNoLeaseEnv, marker, probeExclusive, readMarker, writeMarker,
} from '../control/lifecycle.js';
import { describeLeaveTarget, leaveTarget } from '../control/leaveTarget.js';
import { verifiedDisposableStack } from './disposableStack.js';
import {
  dbInUseGuard, drainLeaseHolders, holdExclusive, leaveMaintenance, spawnUnderLease, validateLeaveTarget, waitForExit,
} from '../control/maintenance.js';
import type { Runner } from '../control/runner.js';
import {
  assertNoExtraArgs, controlContext, machineFor, reportFailure, takeFlag, takeOption, timeoutMs, type Io,
} from './controlCommon.js';

export const LIFECYCLE_USAGE = `Usage: npm run holdr-lifecycle -- <command>

  status                         marker, lease and lock holders (no locks taken)
  enter --reason <r>             marker -> maintenance (persistent; starts are refused from now on)
  exclusive [--timeout <s>] [--leave [<revert>]] -- <cmd> [args...]
                                 take lifecycle.lock exclusively (waits <s>, default 60; reports holders and exits 75),
                                 run <cmd> with the lease as fd 3; with --leave and exit 0, validate offline inside the
                                 lease and return to normal
  leave [--timeout <s>] [<revert>]
                                 take the lease, validate offline, return to normal (no other holder may remain)
  <revert> = --snap <SNAP> --target-root <T> --target-config <file|none>: after a revert, validate what the restored code
             reads (the target configuration) rather than the operation's (§11.5)
             Without them, a leave from a rollback kit validates the live deployment, never the kit: the live tree itself
             when the live holdr.conf is the kit's, the revert target when it is the snapshot's; otherwise it refuses
  probe --exclusive              one non-blocking exclusive attempt: exit 75 "held" or 0 "free"; changes nothing
`;

/** After a revert (§11.5), leave validates the target configuration too (deviation B-D23); all three or none. */
function revertOptions(args: string[]): string[] {
  const snap = takeOption(args, '--snap');
  const targetRoot = takeOption(args, '--target-root');
  const targetConfig = takeOption(args, '--target-config');
  const given = [snap, targetRoot, targetConfig].filter((value) => value !== undefined).length;
  if (given === 0) return [];
  if (given !== 3) throw new ControlError('E0I_USAGE', EXIT.usage, '--snap, --target-root and --target-config go together');
  return ['--snap', snap!, '--target-root', targetRoot!, '--target-config', targetConfig!];
}

/**
 * `holdr-lifecycle` (design §9.3, §9.6). Inside a lease every command is refused (`E0I_LEASE_ENV`): no lifecycle operation
 * nests inside another. Inside a lease, Node runs only through `scripts/holdr-leased.sh` (no npm, npx or tsx launcher).
 */
export async function runHoldrLifecycle(argv: readonly string[], options: {
  env: NodeJS.ProcessEnv; io: Io; run: Runner; onSignal?: (forward: (signal: NodeJS.Signals) => void) => void;
}): Promise<number> {
  const { io, run } = options;
  const separator = argv.indexOf('--');
  const args = [...(separator < 0 ? argv : argv.slice(0, separator))];
  const command = args.shift();
  const commandLine = separator < 0 ? [] : argv.slice(separator + 1);
  try {
    if (!command || command === '--help' || command === '-h') {
      (command ? io.stdout : io.stderr).write(LIFECYCLE_USAGE);
      return command ? 0 : EXIT.usage;
    }
    assertNoLeaseEnv(options.env);
    const context = controlContext(options.env);
    // Children get the environment as given (plus the located holdr.conf), never this process's effective one: values
    // derived here (the release dir from this tree) must not conflict with what the child derives from its own tree.
    const configPath = context.config.location.kind === 'file' ? context.config.location.path : null;
    const childEnv = configPath ? { ...options.env, HOLDR_CONFIG: configPath } : { ...options.env };
    switch (command) {
      case 'status': {
        assertNoExtraArgs(args);
        let machine: string | null = null;
        try { machine = await machineFor(context, run); } catch { machine = null; }
        io.stdout.write(formatControlStatus(await controlStatus(context.controlDir, { machine, run })));
        return 0;
      }
      case 'enter': {
        const reason = takeOption(args, '--reason');
        assertNoExtraArgs(args);
        if (!reason || !REASON.test(reason)) throw new ControlError('E0I_USAGE', EXIT.usage, 'enter needs --reason <lowercase-word>');
        const current = readMarker(context.controlDir);
        if (current?.state === 'maintenance') {
          io.stdout.write(`lifecycle: already maintenance (${current.reason}); unchanged\n`);
          return 0;
        }
        writeMarker(context.controlDir, marker({ state: 'maintenance', reason }, 'holdr-lifecycle enter'));
        io.stdout.write(`lifecycle: maintenance (${reason}); starts are refused until leave\n`);
        return 0;
      }
      case 'probe': {
        if (!takeFlag(args, '--exclusive')) throw new ControlError('E0I_USAGE', EXIT.usage, 'probe needs --exclusive');
        assertNoExtraArgs(args);
        const result = probeExclusive(context.controlDir);
        io.stdout.write(`${result}\n`);
        return result === 'held' ? EXIT.busy : 0;
      }
      case 'exclusive': {
        const wait = timeoutMs(takeOption(args, '--timeout'), 60);
        const leave = takeFlag(args, '--leave');
        const revert = revertOptions(args);
        if (revert.length && !leave) throw new ControlError('E0I_USAGE', EXIT.usage, 'revert options belong to --leave');
        assertNoExtraArgs(args);
        if (commandLine.length === 0) throw new ControlError('E0I_USAGE', EXIT.usage, 'exclusive needs -- <cmd>');
        const held = await holdExclusive(context.controlDir, {
          timeoutMs: wait, run, owner: 'holdr-lifecycle exclusive', log: (line) => io.stderr.write(`${line}\n`),
        });
        try {
          await dbInUseGuard(run, context.dataDir);
          const child = spawnUnderLease(held, commandLine[0], commandLine.slice(1), { env: childEnv });
          options.onSignal?.((signal) => { try { child.kill(signal); } catch { /* already gone */ } });
          const code = await waitForExit(child);
          if (code !== 0) {
            io.stderr.write(`holdr-lifecycle: command exited ${code}; marker left in maintenance\n`);
            return code;
          }
          if (!leave) return 0;
          // B1 review 3: work the command left behind with the lease finishes first, then validation, then the final check.
          await drainLeaseHolders(context.controlDir, held, { run, timeoutMs: wait, log: (line) => io.stderr.write(`holdr-lifecycle: ${line}\n`) });
          const target = leaveTarget(options.env, configPath, revert, undefined, { disposable: verifiedDisposableStack(options.env, configPath, context.dataDir) });
          io.stderr.write(`holdr-lifecycle: ${describeLeaveTarget(target)}\n`);
          if (await validateLeaveTarget(held, childEnv, target) !== 0) {
            throw new ControlError('E0I_VALIDATION', 1, 'offline validation failed; marker left in maintenance');
          }
          await leaveMaintenance(context.controlDir, held, { run, owner: 'holdr-lifecycle exclusive' });
          io.stdout.write('lifecycle: normal\n');
          return 0;
        } finally {
          held.lease.release();
        }
      }
      case 'leave': {
        const wait = timeoutMs(takeOption(args, '--timeout'), 2);
        const revert = revertOptions(args);
        assertNoExtraArgs(args);
        const held = await holdExclusive(context.controlDir, {
          timeoutMs: wait, run, owner: 'holdr-lifecycle leave', log: (line) => io.stderr.write(`${line}\n`),
        });
        try {
          await drainLeaseHolders(context.controlDir, held, { run, timeoutMs: wait, log: (line) => io.stderr.write(`holdr-lifecycle: ${line}\n`) });
          const target = leaveTarget(options.env, configPath, revert, undefined, { disposable: verifiedDisposableStack(options.env, configPath, context.dataDir) });
          io.stderr.write(`holdr-lifecycle: ${describeLeaveTarget(target)}\n`);
          if (await validateLeaveTarget(held, childEnv, target) !== 0) {
            throw new ControlError('E0I_VALIDATION', 1, 'offline validation failed; marker left in maintenance');
          }
          await leaveMaintenance(context.controlDir, held, { run, owner: 'holdr-lifecycle leave' });
          io.stdout.write('lifecycle: normal\n');
          return 0;
        } finally {
          held.lease.release();
        }
      }
      default:
        throw new ControlError('E0I_USAGE', EXIT.usage, `unknown command ${command}`);
    }
  } catch (error) {
    return reportFailure('holdr-lifecycle', io, error);
  }
}
