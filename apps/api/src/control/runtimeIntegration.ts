import path from 'node:path';

import { WebReleaseError } from '@finance-tracker/shared/web-release';

import { CLI_TIMEOUT_MS, createAttestationState } from '../ingress/attestation.js';
import { runBoundedCommand } from '../ingress/boundedCommand.js';
import type { ReleaseIngressConfig } from '../ingress/config.js';
import { createIngressSafetyProviders } from '../ingress/safetyProviders.js';
import { serveModeDecision, validateServeStatus, type ServeExpectations } from '../ingress/serveConfig.js';
import type { SocketSafety } from '../ingress/server.js';
import type { IngressRuntimeIntegration } from '../ingress/startupChecks.js';
import type { IngressAdmission } from '../ingress/types.js';
import { checkControlDir, configuredControlDir } from './controlDir.js';
import { fail } from './errors.js';
import { systemRunner } from './exec.js';
import { existingAncestor } from './files.js';
import { readDistCompanion, type HoldrConf } from './holdrConf.js';
import { acquireSharedLease, assertLockPlatform, leaseStillOn, type Lease } from './lifecycle.js';
import { computeMachineId } from './machineId.js';
import { repoPaths } from './paths.js';
import type { Runner } from './runner.js';
import { localExposureCodes } from './serveVerdict.js';
import { runDataAndControlGates, tokenFileFor } from './startupGates.js';
import { describeGate } from './syncAuthState.js';

type Providers = ReturnType<typeof createIngressSafetyProviders>;
export type ProviderFactory = (options: Parameters<typeof createIngressSafetyProviders>[0]) => Providers;

export const BREAK_GLASS_BANNER = 'BREAK-GLASS: local only, ingress not verified';
const HOUR_MS = 60 * 60 * 1000;

/** Never called: `local` has no socket listener, and `dist` always has the A2 provider. */
const NO_SOCKET: SocketSafety = Object.freeze({
  async beforeListen() { throw new WebReleaseError('E0I_SOCKET_UNVERIFIED'); },
  async afterListen() { throw new WebReleaseError('E0I_SOCKET_UNVERIFIED'); },
});

/** What the running API proves about its place in the lifecycle protocol (read-only; for PR D's device admission). */
export interface RuntimeLifecycleEvidence {
  /** The machine id computed once in `beforeDatabaseOpen`; null when it could not be computed. Never recomputed. */
  readonly machine: string | null;
  readonly controlDir: string;
  /** True while the runtime has not stopped and its shared lease is still on the control dir's current lifecycle.lock. */
  leaseLive(): boolean;
}

export interface ProductionRuntime {
  /** For A's `prepareIngress`: providers are created inside `beforeDatabaseOpen`, so A's release checks still come first. */
  readonly integration: IngressRuntimeIntegration;
  /** After the listeners are bound: the attestation poller (it needs the recorded socket identity) and the break-glass log. */
  start(): void;
  /** Shutdown: stops the poller and releases the lifecycle lease. */
  stop(): void;
  /** Null before `beforeDatabaseOpen` completed and after `stop()`. */
  lifecycleEvidence(): RuntimeLifecycleEvidence | null;
}

/**
 * The production `IngressRuntimeIntegration` (design §12 row B, §12.1): A2's admission and socket-safety providers plus B's
 * `beforeDatabaseOpen`, which runs, in order and before any database is opened:
 *  - K17–K22 (data dir, backups, control dir, fence file metadata, token location) and the §9.5 device-gate log line;
 *  - the A2 providers: K30 (pinned native reader, `HOLDR_NATIVE_COMMIT` / `HOLDR_NATIVE_MANIFEST`), K31 (verified runtime),
 *    and in `dist` K28's boot phase (`beforeListen`: whole-path rule, stale socket removed, live socket refused);
 *  - K24: one `tailscale serve status --json` read; a known-fatal configuration refuses start, an unreadable one starts with
 *    admission closed (§7.2, §8.6);
 *  - K29: the shared `lifecycle.lock` within 10 s, then the marker `normal`; the API keeps that lease for its whole life.
 * No environment variable can open admission: the providers and their pins come from code and holdr.conf only.
 */
export function createProductionRuntime(options: {
  env: Readonly<NodeJS.ProcessEnv>;
  config: ReleaseIngressConfig;
  conf: HoldrConf | null;
  log: (line: string) => void;
  warn?: (line: string) => void;
  run?: Runner;
  /** Code-level seam for tests that compose A2's parts with a synthetic Tailscale pin; index.ts never passes it. */
  providerFactory?: ProviderFactory;
}): ProductionRuntime {
  const { env, config, log } = options;
  const warn = options.warn ?? log;
  const run = options.run ?? systemRunner;
  const factory = options.providerFactory ?? createIngressSafetyProviders;
  let providers: Providers | undefined;
  let localAdmission: IngressAdmission | undefined;
  let lease: Lease | undefined;
  let breakGlass: ReturnType<typeof setInterval> | undefined;
  let evidence: RuntimeLifecycleEvidence | null = null;
  let stopped = false;

  const expectations = (): { serve: ServeExpectations; cli: string } | null => {
    const cli = env.HOLDR_TAILSCALE_CLI;
    if (config.mode === 'dist') {
      if (!cli) return fail('E0I_SERVE', 'HOLDR_TAILSCALE_CLI is required in dist');
      return {
        cli,
        serve: { host: new URL(config.publicOrigin).hostname, socketPath: config.socketPath, holdrPorts: [config.port] },
      };
    }
    if (!cli) return null;
    // Local exposure checks compare against the last dist configuration (deviation B-D2).
    const dist = readDistCompanion(options.conf);
    return {
      cli,
      serve: { host: new URL(dist.publicOrigin).hostname, socketPath: dist.socketPath, holdrPorts: [config.port, config.ingressPort] },
    };
  };

  async function preStartServeCheck(cli: string, serve: ServeExpectations): Promise<void> {
    const result = await runBoundedCommand(cli, ['serve', 'status', '--json'], {
      timeoutMs: CLI_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin', HOME: env.HOME ?? '/' },
    });
    if (result.exitCode !== 0) {
      warn(`[holdr-ingress] K24: Serve configuration unreadable; starting with admission closed`);
      return;
    }
    const verdict = validateServeStatus(result.stdout, config.mode, serve);
    // local (break-glass): A2's readiness/exposure split (B1 review 7). Readiness-only findings warn; a known exposure refuses.
    if (config.mode === 'local' && verdict.verdict === 'refused') {
      const exposure = localExposureCodes(verdict.codes);
      if (exposure.length) fail('E0I_SERVE', `Serve configuration exposes Holdr: ${exposure.join(',')}`);
      warn(`[holdr-ingress] K24: Serve configuration not ready (${verdict.codes.join(',')}); break-glass continues, no exposure found`);
      return;
    }
    const decision = serveModeDecision(config.mode, verdict);
    if (decision === 'refused') fail('E0I_SERVE', `Serve configuration refused: ${verdict.codes.join(',')}`);
    if (decision === 'unknown') warn(`[holdr-ingress] K24: Serve configuration unreadable (${verdict.codes.join(',')}); starting with admission closed`);
    else log(`[holdr-ingress] K24: Serve configuration ${verdict.verdict}`);
  }

  async function beforeDatabaseOpen(release: ReleaseIngressConfig): Promise<void> {
    if (release !== config) fail('E0I_INTERNAL', 'configuration changed between resolution and startup');
    try {
      assertLockPlatform();
      const disposable = Boolean(env.HOLDR_E2E_RUN_ID?.trim());
      const repo = repoPaths();
      // K20, then K29 at once: a start that races a maintenance window takes part in the protocol before it repairs
      // permissions or removes a stale socket (B-D11).
      checkControlDir(config.controlDir, { dataDir: config.dataDir, repo, disposable });
      const acquired = await acquireSharedLease(config.controlDir, { timeoutMs: 10_000 });
      lease = acquired;
      let machine: string | null = null;
      try {
        machine = await computeMachineId(run, existingAncestor(config.dataDir));
      } catch {
        machine = null;
      }
      const fence = runDataAndControlGates({
        dataDir: config.dataDir, controlDir: config.controlDir, releaseDir: config.releaseDir,
        tokenFile: tokenFileFor(env, config.dataDir), machine, disposable, repo, log: warn,
      });
      log(`[holdr-control] device gate: ${describeGate(fence)}`);
      evidence = Object.freeze({
        machine, controlDir: config.controlDir, leaseLive: () => !stopped && leaseStillOn(acquired, config.controlDir),
      });
      const serve = expectations();
      if (serve) {
        providers = factory({
          mode: config.mode,
          native: { sourceCommit: env.HOLDR_NATIVE_COMMIT ?? '', manifestDigest: env.HOLDR_NATIVE_MANIFEST ?? '' },
          cli: serve.cli,
          expectations: serve.serve,
          stateFile: config.mode === 'dist' ? path.join(path.dirname(config.socketPath), 'ingress-state.json') : undefined,
          log,
        });
        if (config.mode === 'dist') await providers.socketSafety.beforeListen(config.socketPath);
        await preStartServeCheck(serve.cli, serve.serve);
      } else {
        localAdmission = createAttestationState({ mode: 'local' }).admission;
        warn('[holdr-ingress] local mode without HOLDR_TAILSCALE_CLI: no Serve exposure checks');
      }
    } catch (error) {
      stop();
      throw error;
    }
  }

  function start(): void {
    providers?.start();
    if (config.mode === 'local') {
      warn(`[holdr-api] ${BREAK_GLASS_BANNER}`);
      breakGlass = setInterval(() => warn(`[holdr-api] ${BREAK_GLASS_BANNER}`), HOUR_MS);
      breakGlass.unref();
    }
  }

  function stop(): void {
    stopped = true;
    evidence = null;
    if (breakGlass) clearInterval(breakGlass);
    breakGlass = undefined;
    try { providers?.stop(); } catch { /* stopping is best effort; admission is closed by exit */ }
    lease?.release();
  }

  const integration: IngressRuntimeIntegration = {
    get admission(): IngressAdmission {
      if (providers) return providers.admission;
      if (localAdmission && config.mode === 'local') return localAdmission;
      return fail('E0I_RUNTIME_UNAVAILABLE', 'admission requested before startup checks');
    },
    get socketSafety(): SocketSafety {
      if (providers) return providers.socketSafety;
      if (config.mode === 'local') return NO_SOCKET;
      return fail('E0I_RUNTIME_UNAVAILABLE', 'socket safety requested before startup checks');
    },
    beforeDatabaseOpen,
  };
  return Object.freeze({ integration, start, stop, lifecycleEvidence: () => evidence });
}

/**
 * `vite` with `HOLDR_CONTROL_DIR` set (§9.3 roles table): K20, then the API's shared lifecycle lease before the database is
 * opened. Without a control dir, `vite` keeps login's behaviour exactly.
 */
export async function acquireDevLifecycle(env: Readonly<NodeJS.ProcessEnv>): Promise<Lease | null> {
  const controlDir = configuredControlDir(env);
  if (!controlDir) return null;
  assertLockPlatform();
  checkControlDir(controlDir, {
    repo: repoPaths(), dataDir: env.HOLDR_DATA_DIR?.trim() || undefined, disposable: Boolean(env.HOLDR_E2E_RUN_ID?.trim()),
  });
  return acquireSharedLease(controlDir, { timeoutMs: 10_000 });
}
