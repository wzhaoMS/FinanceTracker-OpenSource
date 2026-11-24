import path from 'node:path';

import { verifyRelease } from '@finance-tracker/shared/web-release/files';

import { controlStatus, formatControlStatus } from '../control/controlDir.js';
import { ControlError, EXIT } from '../control/errors.js';
import { disposableStackFacts, isManagedLiveSelf, kitRoot, nonLiveLayout } from '../control/leaveTarget.js';
import { leasedRunner } from '../control/leasedSpawn.js';
import { proveInheritedLease } from '../control/lifecycle.js';
import { computeMachineId } from '../control/machineId.js';
import { validateOffline, validateRevert } from '../control/validateOffline.js';
import { readHoldrConf } from '../control/holdrConf.js';
import { releaseDirFor } from '../control/paths.js';
import { controlContext, existingAncestor, reportFailure, takeOption, type Io } from './controlCommon.js';

/** Exactly the lease-accepting Node roles of §9.3 rule 4 (the apply script is the fourth, in bash). */
export const LEASED_ROLES = ['validate-offline', 'verify-release', 'status'] as const;

/**
 * The roles `scripts/holdr-leased.sh` runs inside a maintenance lease: one Node process (the tsx loader in-process), so the
 * role itself holds fd 3 and proves it; children start only through `spawnLeased` (`leasedRunner`). Outside a lease use
 * the ordinary CLIs (`holdr-recovery status`, `holdr-ingress verify-release`): here an unproven lease is
 * `E0I_LEASE_REQUIRED`, exit 3.
 */
export async function runLeasedRole(role: string | undefined, argv: readonly string[], options: { env: NodeJS.ProcessEnv; io: Io }): Promise<number> {
  const { io } = options;
  try {
    if (!role || !(LEASED_ROLES as readonly string[]).includes(role)) {
      throw new ControlError('E0I_USAGE', EXIT.usage, `role must be one of ${LEASED_ROLES.join(', ')}`);
    }
    const context = controlContext(options.env);
    proveInheritedLease(options.env, context.controlDir);
    const run = leasedRunner(context.controlDir);
    const args = [...argv];
    switch (role) {
      case 'validate-offline': {
        // A revert names both configurations separately (§11.5): the operation's (HOLDR_CONFIG) and the target one.
        const snap = takeOption(args, '--snap');
        const targetRoot = takeOption(args, '--target-root');
        const targetConfig = takeOption(args, '--target-config');
        const revert = [snap, targetRoot, targetConfig].filter((value) => value !== undefined).length;
        if (args.length || (revert !== 0 && revert !== 3)) {
          throw new ControlError('E0I_USAGE', EXIT.usage, 'validate-offline [--snap <SNAP> --target-root <T> --target-config <file|none>]');
        }
        for (const value of [snap, targetRoot, ...(targetConfig === 'none' ? [] : [targetConfig])]) {
          if (value !== undefined && !path.isAbsolute(value)) throw new ControlError('E0I_USAGE', EXIT.usage, 'absolute paths only');
        }
        // A named target is never a staging tree or a kit standing in for the live deployment (B round 4, as the CLIs check).
        if (targetRoot !== undefined && nonLiveLayout(targetRoot)) {
          throw new ControlError('E0I_LEAVE_TARGET', EXIT.usage, `the named target ${targetRoot} is a staging tree or a rollback kit, not the live deployment`);
        }
        // A rollback kit never validates itself (B1 review 2, B-D36): from a kit, only an explicit target is validated. Nor does
        // any other tree, unless it is positively the managed live tree with the live configuration, or a disposable stack
        // (B1 round-2 finding 3): a kit with incomplete metadata or a staging tree says nothing about the live deployment, and
        // its layout refuses before any HOLDR_ROOT or disposable claim is considered (B1 round-3 finding 1).
        if (!revert) {
          if (kitRoot()) {
            throw new ControlError('E0I_LEAVE_TARGET', EXIT.usage, 'a rollback kit validates only a named target: --snap <SNAP> --target-root <T> --target-config <file|none>');
          }
          const layout = nonLiveLayout();
          if (layout) {
            throw new ControlError('E0I_LEAVE_TARGET', EXIT.usage, `${layout} is a staging tree or a rollback kit: it validates only a named target: `
              + '--snap <SNAP> --target-root <T> --target-config <file|none>');
          }
          const configPath = context.config.location.kind === 'file' ? context.config.location.path : null;
          if (!isManagedLiveSelf(options.env, configPath) && !disposableStackFacts(options.env, configPath, context.dataDir)) {
            throw new ControlError('E0I_LEAVE_TARGET', EXIT.usage, 'this tree validates itself only as the managed live tree with the live '
              + 'configuration, or as a disposable stack; name the target: --snap <SNAP> --target-root <T> --target-config <file|none>');
          }
        }
        try {
          // In a revert the restored code reads the target configuration: its release, in the restored tree.
          let target: { repoRoot?: string; release?: { dir: string; digest: string } | null } = {};
          if (revert) {
            const values = targetConfig === 'none' ? null : readHoldrConf(targetConfig!).values;
            const targetMode = values?.HOLDR_WEB_MODE ?? 'vite';
            target = {
              repoRoot: targetRoot!,
              release: values?.HOLDR_WEB_RELEASE && (targetMode === 'dist' || targetMode === 'local')
                ? { dir: releaseDirFor(values.HOLDR_WEB_RELEASE, targetRoot!), digest: values.HOLDR_WEB_RELEASE } : null,
            };
          }
          const lines = await validateOffline({ env: context.env, controlDir: context.controlDir, dataDir: context.dataDir, run, ...target });
          if (revert) {
            const slowRunner = leasedRunner(context.controlDir, 5 * 60_000, 8 * 1024 * 1024);
            lines.push(...await validateRevert({
              snap: snap!, targetRoot: targetRoot!, targetConfig: targetConfig!, home: options.env.HOME ?? '/', run: slowRunner,
            }));
          }
          io.stdout.write(`${lines.join('\n')}\nVALIDATED offline under the inherited lease\n`);
          return 0;
        } catch (error) {
          const lines = (error as { lines?: string[] }).lines;
          if (lines) io.stdout.write(`${lines.join('\n')}\n`);
          throw error;
        }
      }
      case 'verify-release': {
        const digest = takeOption(args, '--digest');
        if (args.length !== 1 || !digest) throw new ControlError('E0I_USAGE', EXIT.usage, 'verify-release <dir> --digest <D>');
        const release = verifyRelease(path.resolve(args[0]), digest);
        io.stdout.write(`VERIFIED digest=${release.digest} files=${release.manifest.files.length}\n`);
        return 0;
      }
      case 'status': {
        if (args.length) throw new ControlError('E0I_USAGE', EXIT.usage, 'status takes no arguments');
        let machine: string | null = null;
        try { machine = await computeMachineId(run, existingAncestor(context.dataDir)); } catch { machine = null; }
        io.stdout.write(formatControlStatus(await controlStatus(context.controlDir, { machine, run })));
        return 0;
      }
    }
    return EXIT.usage;
  } catch (error) {
    return reportFailure(`holdr-leased ${role ?? ''}`.trim(), io, error);
  }
}
