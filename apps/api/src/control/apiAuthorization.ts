import { configuredControlDir } from './controlDir.js';
import { fail } from './errors.js';
import { systemRunner } from './exec.js';
import { existingAncestor } from './files.js';
import { leaseStillOn, type Lease } from './lifecycle.js';
import { computeMachineId } from './machineId.js';
import type { Runner } from './runner.js';
import type { RuntimeLifecycleEvidence } from './runtimeIntegration.js';
import { createAuthorizationGateService, unwiredAuthorizationGateService, type CardSyncAuthorizationService } from './authorizationChange.js';

/** No production runtime does not mean no control dir: configured Vite participates in exactly the same host protocol. */
export async function createApiAuthorizationGate(options: {
  env: Readonly<NodeJS.ProcessEnv>;
  dataDir: string;
  lifecycle: RuntimeLifecycleEvidence | null;
  devLease: Lease | null;
  databaseGeneration(): string;
  log?(line: string): void;
  run?: Runner;
}): Promise<CardSyncAuthorizationService> {
  const { databaseGeneration, log } = options;
  if (options.lifecycle) {
    const evidence = options.lifecycle;
    return createAuthorizationGateService({
      controlDir: evidence.controlDir, machine: evidence.machine, leaseLive: () => evidence.leaseLive(), databaseGeneration, log,
    });
  }
  const controlDir = configuredControlDir(options.env);
  if (!controlDir) return unwiredAuthorizationGateService({ databaseGeneration });
  const held = options.devLease;
  if (!held || !leaseStillOn(held, controlDir)) return fail('E0I_LIFECYCLE_STATE', 'configured dev needs its live lifecycle lease');
  let machine: string | null;
  try { machine = await computeMachineId(options.run ?? systemRunner, existingAncestor(options.dataDir)); }
  catch { machine = null; }
  return createAuthorizationGateService({
    controlDir, machine, leaseLive: () => leaseStillOn(held, controlDir), databaseGeneration, log,
  });
}
