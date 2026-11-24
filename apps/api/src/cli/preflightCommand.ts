import path from 'node:path';

import { WebReleaseError } from '@finance-tracker/shared/web-release';

import { checkControlDir, configuredControlDir } from '../control/controlDir.js';
import { ControlError, EXIT } from '../control/errors.js';
import { systemRunner } from '../control/exec.js';
import { existingAncestor } from '../control/files.js';
import { loadConfiguration, readDistCompanion } from '../control/holdrConf.js';
import { acquireSharedLease, assertLockPlatform, assertNoLeaseEnv } from '../control/lifecycle.js';
import { computeMachineId } from '../control/machineId.js';
import { managedLiveRoot, repoPaths } from '../control/paths.js';
import { runningApiOwns } from '../control/processOwnership.js';
import { localExposureCodes } from '../control/serveVerdict.js';
import type { Runner } from '../control/runner.js';
import {
  checkBackupPerms, checkDataOverlap, checkDataPerms, checkTokenLocation, checkUsers, tokenFileFor,
} from '../control/startupGates.js';
import { describeGate, readFence } from '../control/syncAuthState.js';
import { CLI_TIMEOUT_MS } from '../ingress/attestation.js';
import { runBoundedCommand } from '../ingress/boundedCommand.js';
import { resolveIngressConfig } from '../ingress/config.js';
import { createIngressSafetyProviders } from '../ingress/safetyProviders.js';
import { validateServeStatus, type ServeExpectations } from '../ingress/serveConfig.js';
import { loadWebRelease } from '../ingress/webRelease.js';
import type { Io } from './controlCommon.js';

export const PREFLIGHT_USAGE = 'Usage: npm run holdr-ingress -- preflight [--web-port <port>]\n';
const ACCEPTED_VERDICTS = new Set(['empty', 'approved-vite', 'approved-dist', 'error']);

/**
 * `holdr-ingress preflight` (design §8.2 step 6, §7.2, §9.3 read-only preflight role): every check of §7.2 against the
 * configured release and the live data and control dirs, without changing anything. It holds the shared lifecycle lease
 * and requires `normal` (K29) before it opens the database read-only (K23); K28 runs in its preflight phase (the running
 * API's own socket is accepted); the Serve validator always runs. Exit 0 prints the verdict; any refusal exits non-zero
 * (busy 75, maintenance 3, otherwise 1). It never writes ingress-state.json, never removes a socket, never starts a poller.
 */
export async function runPreflightCommand(argv: readonly string[], rawEnv: NodeJS.ProcessEnv, deps: {
  io?: Io; run?: Runner; providerFactory?: typeof createIngressSafetyProviders;
} = {}): Promise<number> {
  const io = deps.io ?? process;
  const run = deps.run ?? systemRunner;
  const factory = deps.providerFactory ?? createIngressSafetyProviders;
  const warnings: string[] = [];
  try {
    // The start script passes its web port (default 8888): the legacy Vite shape's target and a Holdr port for the validator.
    let webPort = 8888;
    if (argv.length === 2 && argv[0] === '--web-port' && /^[1-9][0-9]{0,4}$/.test(argv[1]) && Number(argv[1]) <= 65535) webPort = Number(argv[1]);
    else if (argv.length) throw new ControlError('E0I_USAGE', EXIT.usage, PREFLIGHT_USAGE.trim());
    // Not a lease-accepting role (§9.3 rule 4); ingressMain refuses before dispatch as well.
    assertNoLeaseEnv(rawEnv);
    const configuration = loadConfiguration(rawEnv);
    const env = configuration.env;
    const config = resolveIngressConfig(env);
    if (config.mode === 'dev') {
      const controlDir = configuredControlDir(env);
      if (controlDir) {
        assertLockPlatform();
        checkControlDir(controlDir, { repo: repoPaths(), disposable: Boolean(env.HOLDR_E2E_RUN_ID?.trim()) });
        (await acquireSharedLease(controlDir, { timeoutMs: 10_000 })).release();
      }
      io.stdout.write('PREFLIGHT ok mode=vite\n');
      return 0;
    }
    loadWebRelease({ dir: config.releaseDir, digest: config.releaseDigest });
    assertLockPlatform();
    const repo = repoPaths();
    const disposable = Boolean(env.HOLDR_E2E_RUN_ID?.trim());
    checkControlDir(config.controlDir, { dataDir: config.dataDir, repo, disposable });
    const lease = await acquireSharedLease(config.controlDir, { timeoutMs: 10_000 });
    try {
      checkDataOverlap({ dataDir: config.dataDir, controlDir: config.controlDir, releaseDir: config.releaseDir, repo });
      for (const file of checkDataPerms(config.dataDir, { tolerateMainFiles: true })) warnings.push(`the API will restrict ${file} to its owner`);
      if (!disposable) checkBackupPerms(repo);
      let machine: string | null = null;
      try { machine = await computeMachineId(run, existingAncestor(config.dataDir)); } catch { machine = null; }
      const gate = describeGate(readFence(config.controlDir, machine));
      checkTokenLocation({ dataDir: config.dataDir, controlDir: config.controlDir, releaseDir: config.releaseDir, repo, tokenFile: tokenFileFor(env, config.dataDir) });

      let serve: { cli: string; expectations: ServeExpectations } | null = null;
      if (config.mode === 'dist') {
        if (!env.HOLDR_TAILSCALE_CLI) throw new ControlError('E0I_SERVE', 1, 'HOLDR_TAILSCALE_CLI is required in dist');
        serve = { cli: env.HOLDR_TAILSCALE_CLI, expectations: {
          host: new URL(config.publicOrigin).hostname, socketPath: config.socketPath, holdrPorts: [config.port, webPort], legacyPort: webPort,
        } };
      } else if (env.HOLDR_TAILSCALE_CLI) {
        const dist = readDistCompanion(configuration.conf);
        serve = { cli: env.HOLDR_TAILSCALE_CLI, expectations: {
          host: new URL(dist.publicOrigin).hostname, socketPath: dist.socketPath, holdrPorts: [config.port, config.ingressPort], legacyPort: webPort,
        } };
      }
      let verdict: string = 'not-checked';
      if (serve) {
        // K30, K31 and K28's preflight phase. No state file and no poller: nothing is written.
        const providers = factory({
          mode: config.mode, native: { sourceCommit: env.HOLDR_NATIVE_COMMIT ?? '', manifestDigest: env.HOLDR_NATIVE_MANIFEST ?? '' },
          cli: serve.cli, expectations: serve.expectations,
        });
        // The running API belongs to the managed live tree, which a staged candidate's preflight is not (B1 review 4). A
        // HOLDR_ROOT naming a staging tree, a kit or nothing is E0I_NOT_LIVE (64), as in the start script.
        if (config.mode === 'dist') {
          const liveRoot = managedLiveRoot(rawEnv);
          await providers.preflightSocket(runningApiOwns(run, config.socketPath, liveRoot));
        }
        const read = await runBoundedCommand(serve.cli, ['serve', 'status', '--json'], {
          timeoutMs: CLI_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin', HOME: env.HOME ?? '/' },
        });
        const result = read.exitCode === 0 ? validateServeStatus(read.stdout, config.mode, serve.expectations)
          : { verdict: 'error' as const, codes: ['serve-command-failed'] };
        verdict = result.verdict;
        if (config.mode === 'local' && verdict === 'refused') {
          // local (break-glass): A2's readiness/exposure split (B1 review 7). Readiness-only findings warn; exposure refuses.
          const exposure = localExposureCodes(result.codes);
          if (exposure.length) throw new ControlError('E0I_SERVE', 1, `Serve exposes Holdr: ${exposure.join(',')}`);
          warnings.push(`Tailscale Serve is not ready (${result.codes.join(',')}); break-glass may start, no exposure was found`);
          verdict = 'not-ready';
        } else if (!ACCEPTED_VERDICTS.has(verdict)) {
          throw new ControlError('E0I_SERVE', 1, `Serve verdict ${verdict}: ${result.codes.join(',')}`);
        }
      }
      const users = checkUsers(path.join(config.dataDir, 'finance.db'));
      if ('warning' in users) warnings.push(users.warning);
      for (const warning of warnings) io.stderr.write(`preflight warning: ${warning}\n`);
      io.stdout.write(`PREFLIGHT ok mode=${config.mode} serve=${verdict} gate=${JSON.stringify(gate)}\n`);
      return 0;
    } finally {
      lease.release();
    }
  } catch (error) {
    const code = error instanceof WebReleaseError ? error.code : 'E0I_INTERNAL';
    const detail = error instanceof ControlError && error.detail ? ` (${error.detail})` : '';
    io.stderr.write(`PREFLIGHT refused ${code}${detail}\n`);
    return error instanceof ControlError ? error.exitCode : 1;
  }
}
