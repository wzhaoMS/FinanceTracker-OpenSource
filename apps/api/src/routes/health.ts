import type { RequestHandler } from 'express';

import { asyncRoute } from '../asyncRoute.js';
import { valueFreeDbCode } from '../services/dbErrors.js';
import type { SqliteStateRepo } from '../services/sqliteStateRepo.js';

/** What /health reports about a disposable e2e stack (src/e2e/runIdentity.ts). */
export interface E2eIdentityReport {
  runId: string;
  disposableDataDir: boolean;
}

export interface HealthDeps {
  repo: Pick<SqliteStateRepo, 'counts' | 'schemaVersion' | 'internalGetDb'>;
  snapshotsEnabled: boolean;
  /**
   * Disposable e2e stacks only (HOLDR_E2E_RUN_ID): the run identity /health
   * reports, re-checked on every call (apps/api/src/e2e/runIdentity.ts). It
   * may be a promise: on Windows the check reads ACLs through PowerShell, off
   * the event loop.
   */
  e2eIdentity?: () => E2eIdentityReport | Promise<E2eIdentityReport>;
}

/**
 * GET /health, mounted before sign-in is required (app.ts). Without a session
 * (`req.holdrAuth`, set by the auth middleware) it answers only `ok` and
 * `schemaVersion`; signed-in callers and the service token also get the
 * counts and snapshot status.
 *
 * The e2e run identity is shown even without a session: Playwright's global
 * setup must verify which stack it is talking to before it signs in, because
 * signing in is already a write. It carries no data (a random per-run id and
 * a yes/no about the data directory), and only an API started with
 * HOLDR_E2E_RUN_ID has one; a production API never does.
 *
 * A failure answers 503 with a fixed body, plus SQLite's result code for a
 * signed-in caller: SQLite's messages can quote whatever the database stores,
 * so no message ever leaves. That includes an e2e identity that throws or
 * rejects: it is awaited inside the same try, and asyncRoute hands anything
 * else to the app's value-free error handler.
 */
export function createHealthHandler({ repo, snapshotsEnabled, e2eIdentity }: HealthDeps): RequestHandler {
  return asyncRoute(async (req, res) => {
    const signedIn = req.holdrAuth !== undefined;
    try {
      const e2e = e2eIdentity ? { e2e: await e2eIdentity() } : {};
      if (!signedIn) {
        res.json({ ok: true, schemaVersion: repo.schemaVersion(), ...e2e });
        return;
      }
      const counts = repo.counts();
      // Snapshot status: count + most recent taken_at, so the UI can render
      // "Snapshots: last 4m ago" or "Snapshots: collecting…" before any rows
      // exist. Queries are tiny (indexed); no perf concern.
      const db = repo.internalGetDb();
      const snap = db
        .prepare('SELECT COUNT(*) as n, MAX(taken_at) as latest FROM account_snapshots')
        .get() as { n: number; latest: string | null };
      res.json({
        ok: true,
        service: 'holdr-api',
        db: 'sqlite',
        schemaVersion: repo.schemaVersion(),
        accounts: counts.accounts,
        transactions: counts.transactions,
        snapshots: {
          enabled: snapshotsEnabled,
          count: snap.n,
          latest: snap.latest,
        },
        ...e2e,
      });
    } catch (error) {
      res.status(503).json(signedIn
        ? { ok: false, error: 'unavailable', code: valueFreeDbCode(error) }
        : { ok: false, error: 'unavailable' });
    }
  });
}
