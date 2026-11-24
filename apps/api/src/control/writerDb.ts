import { configuredControlDir } from './controlDir.js';
import { EXIT } from './errors.js';
import { acquireSharedLease, assertNoLeaseEnv, type Lease } from './lifecycle.js';

/**
 * Runs `fn` under the writer's shared lease (design §9.3): when a control dir is configured, a shared `lifecycle.lock` first,
 * then the marker `normal` (busy exit 75, maintenance exit 3), released only after `fn` settles. `holdr-backup` holds it for
 * the whole operation, every read of the live data dir included, whether or not `finance.db` exists (B1 review 6).
 */
export async function withWriterLease<T>(env: Readonly<NodeJS.ProcessEnv>, fn: () => Promise<T> | T, options: {
  timeoutMs?: number;
} = {}): Promise<T> {
  assertNoLeaseEnv(env);
  const controlDir = configuredControlDir(env);
  const lease: Lease | null = controlDir
    ? await acquireSharedLease(controlDir, { timeoutMs: options.timeoutMs ?? 10_000, busyExit: EXIT.busy, maintenanceExit: EXIT.maintenance })
    : null;
  try {
    return await fn();
  } finally {
    lease?.release();
  }
}

/**
 * Writer CLIs (`holdr-user`, `holdr-backup`) open `finance.db` only through this (design §9.3): when a control dir is
 * configured (holdr.conf or HOLDR_CONTROL_DIR), a shared `lifecycle.lock` first, **then** the marker `normal`; busy is exit
 * 75 `E0I_LIFECYCLE_BUSY`, maintenance exit 3 `E0I_MAINTENANCE`. The lease is released only after the database is closed.
 * Disposable stacks set `HOLDR_CONFIG=none` and have their own control dir, or none.
 */
export async function openWriterDb<T extends { close(): void }>(env: Readonly<NodeJS.ProcessEnv>, open: () => T, options: {
  timeoutMs?: number;
} = {}): Promise<{ db: T; close(): void }> {
  assertNoLeaseEnv(env);
  const controlDir = configuredControlDir(env);
  const lease: Lease | null = controlDir
    ? await acquireSharedLease(controlDir, { timeoutMs: options.timeoutMs ?? 10_000, busyExit: EXIT.busy, maintenanceExit: EXIT.maintenance })
    : null;
  let db: T;
  try {
    db = open();
  } catch (error) {
    lease?.release();
    throw error;
  }
  let closed = false;
  return {
    db,
    close() {
      if (closed) return;
      closed = true;
      try { db.close(); } finally { lease?.release(); }
    },
  };
}
