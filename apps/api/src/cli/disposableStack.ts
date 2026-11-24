import { disposableStackFacts } from '../control/leaveTarget.js';
import { isDisposableDataDir } from '../e2e/runIdentity.js';

/**
 * A verified disposable stack, where a `leave` may validate its own tree (B1 round-2 finding 3): a run identity,
 * `HOLDR_CONFIG=none`, and a data directory that passes the seed's full check (`isDisposableDataDir`). Only the CLIs that
 * choose a leave target load this; the leased role checks the same facts without the seed's module (`disposableStackFacts`).
 */
export function verifiedDisposableStack(env: NodeJS.ProcessEnv, configPath: string | null, dataDir: string): boolean {
  return disposableStackFacts(env, configPath, dataDir) && isDisposableDataDir(dataDir);
}
