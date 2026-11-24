import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { ControlError, EXIT, exitCodeOf } from '../control/errors.js';
import { openWriterDb } from '../control/writerDb.js';
import { errorTypeAndCode } from '../services/dbErrors.js';
import {
  cashAdoptionEffectiveDate, FIDELITY_CASH_ADOPTED_REASON, FIDELITY_CASH_ADOPTION_TOLERANCE,
} from '../services/fidelityInvestingSync.js';
import { assertNoExtraArgs, controlContext, takeFlag, type Io } from './controlCommon.js';

export const CASH_ADOPTION_BACKFILL_USAGE = `Usage: npx tsx apps/api/src/cli/cashAdoptionBackfillMain.ts [--apply]

One-off repair for Fidelity baselines imported before the importer recorded the cash it adopts.
Such a baseline replaced Holdr's cash for an account with the broker's, but the account's earlier
snapshots still held the old figure, so the 1D and 1W charts showed the correction as a market
move. For each baseline that adopted the broker's cash (by more than two cents) and has no record
of it yet, this adds the history correction the importer now writes itself: a row in
account_history_invalidations for the account, effective the market day of its last snapshot before
the capture (or the capture's day), detected when the import applied the baseline (the receipt that
reports it), reason
'${FIDELITY_CASH_ADOPTED_REASON}'. The charts then show those snapshots as captured before the sync,
and measure from the correction.

Reads the configured data dir (HOLDR_DATA_DIR or holdr.conf), under the writer's shared lease.
Without --apply it only counts: the database is opened read-only and nothing is written. Take a
backup first (npm run holdr-backup), compare the dry run, then run it again with --apply. Running it
again records nothing new. It prints counts and dates only: no account, name or amount.
`;

interface PendingCorrection {
  accountId: string;
  effectiveDate: string;
  detectedAt: string;
}

export interface CashAdoptionBackfillPlan {
  /** Baselines flagged as having adopted the broker's cash. */
  baselines: number;
  /** Already recorded, by the importer or an earlier run. */
  recorded: number;
  pending: PendingCorrection[];
  /** Adopted cash within the tolerance of Holdr's: no correction. */
  immaterial: number;
  /** Without the import's own snapshot, or without a receipt that tells when the baseline was applied. */
  unresolved: number;
}

const REQUIRED_TABLES = [
  'fidelity_investing_incremental', 'fidelity_investing_sources', 'fidelity_investing_receipts',
  'account_snapshots', 'account_history_invalidations',
];

/**
 * When a capture's receipts applied some account's baseline, oldest first. Only such a receipt can have applied
 * this one: an attempt that held the account reports no baseline for it, and a replay never reports one again.
 */
function baselineApplyTimes(receipts: Array<{ importedAt: string; resultJson: string }>): string[] {
  const times = new Set<string>();
  for (const receipt of receipts) {
    let accounts: unknown;
    try {
      accounts = JSON.parse(receipt.resultJson);
    } catch {
      continue;
    }
    if (Array.isArray(accounts) && accounts.some((entry) => (
      typeof entry === 'object' && entry !== null
      && (entry as { status?: unknown }).status === 'applied' && (entry as { baseline?: unknown }).baseline === true
    ))) {
      times.add(receipt.importedAt);
    }
  }
  return [...times].sort();
}

/** What the backfill would record, read from the importer's own audit tables. */
export function planCashAdoptionBackfill(db: Database.Database): CashAdoptionBackfillPlan {
  const plan: CashAdoptionBackfillPlan = { baselines: 0, recorded: 0, pending: [], immaterial: 0, unresolved: 0 };
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
  if (!REQUIRED_TABLES.every((name) => hasTable.get(name) !== undefined)) return plan;
  // The baseline's own columns never change after it is written; later imports update only the
  // cursor's ledger digest and cash.
  const baselines = db.prepare(
    `SELECT source.account_id AS accountId, cursor.previous_cash_balance AS previousCash,
            cursor.baseline_at AS baselineAt, cursor.baseline_digest AS baselineDigest
       FROM fidelity_investing_incremental AS cursor
       JOIN fidelity_investing_sources AS source ON source.source_id = cursor.source_id
      WHERE cursor.baseline_cash_adopted = 1
      ORDER BY cursor.baseline_at, source.account_id`,
  ).all() as Array<{ accountId: string; previousCash: number; baselineAt: string; baselineDigest: string }>;
  // The import wrote the adopted cash into the account's snapshot at the capture time.
  const adoptedCash = db.prepare('SELECT cash_balance FROM account_snapshots WHERE account_id = ? AND taken_at = ?').pluck();
  const receiptsOf = db.prepare(
    'SELECT imported_at AS importedAt, result_json AS resultJson FROM fidelity_investing_receipts WHERE capture_digest = ?',
  );
  // The importer records its correction at the apply time, which is also its receipt's imported_at.
  const recordedAt = db.prepare(
    'SELECT 1 FROM account_history_invalidations WHERE account_id = ? AND reason = ? AND detected_at = ?',
  );
  const observedBetween = db.prepare(
    'SELECT COUNT(*) FROM account_snapshots WHERE taken_at >= ? AND taken_at <= ?',
  ).pluck();
  for (const baseline of baselines) {
    plan.baselines += 1;
    const cash = adoptedCash.get(baseline.accountId, baseline.baselineAt) as number | undefined;
    if (typeof cash !== 'number') {
      plan.unresolved += 1;
      continue;
    }
    if (Math.abs(cash - baseline.previousCash) <= FIDELITY_CASH_ADOPTION_TOLERANCE) {
      plan.immaterial += 1;
      continue;
    }
    const applied = baselineApplyTimes(receiptsOf.all(baseline.baselineDigest) as Array<{ importedAt: string; resultJson: string }>);
    if (applied.length === 0) {
      plan.unresolved += 1;
    } else if (applied.some((at) => recordedAt.get(baseline.accountId, FIDELITY_CASH_ADOPTED_REASON, at))) {
      plan.recorded += 1;
    } else if (applied.length > 1
      && (observedBetween.get(applied[0], applied[applied.length - 1]) as number) > 0) {
      // Receipts name accounts only by their last four digits. A snapshot between two receipts that each
      // applied a baseline can be charted on either side of this correction, even one of other accounts
      // only (before this account was first observed), so the apply time is not guessed.
      plan.unresolved += 1;
    } else {
      // One receipt, or several with nothing observed between them: the charts are the same.
      plan.pending.push({
        accountId: baseline.accountId,
        // The same start the importer now gives the correction itself.
        effectiveDate: cashAdoptionEffectiveDate(db, baseline.accountId, baseline.baselineAt),
        detectedAt: applied[0],
      });
    }
  }
  return plan;
}

/** Records every correction the plan finds missing. The plan is made again inside the write, so it records exactly what is missing then. */
export function recordMissingCashAdoptions(db: Database.Database): { plan: CashAdoptionBackfillPlan; recorded: number } {
  return db.transaction(() => {
    const plan = planCashAdoptionBackfill(db);
    const insert = db.prepare(
      `INSERT INTO account_history_invalidations (account_id, effective_date, detected_at, reason)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id, effective_date, detected_at, reason) DO NOTHING`,
    );
    let recorded = 0;
    for (const item of plan.pending) {
      recorded += insert.run(item.accountId, item.effectiveDate, item.detectedAt, FIDELITY_CASH_ADOPTED_REASON).changes;
    }
    return { plan, recorded };
  }).immediate();
}

function report(io: Io, plan: CashAdoptionBackfillPlan, recordedNow: number | null): void {
  const days = [...new Set(plan.pending.map((item) => item.effectiveDate))].sort();
  io.stdout.write([
    `Fidelity baselines that adopted the broker's cash: ${plan.baselines}`,
    `  already recorded as history corrections: ${plan.recorded}`,
    recordedNow === null
      ? `  to record: ${plan.pending.length}${days.length ? ` (effective ${days.join(', ')})` : ''}`
      : `  recorded now: ${recordedNow}${days.length ? ` (effective ${days.join(', ')})` : ''}`,
    `  within two cents of Holdr's cash, left as they are: ${plan.immaterial}`,
    `  without their import snapshot or a receipt that tells when they were applied, left as they are: ${plan.unresolved}`,
  ].join('\n') + '\n');
}

export async function runCashAdoptionBackfill(
  argv: readonly string[],
  options: { env: NodeJS.ProcessEnv; io: Io },
): Promise<number> {
  const { io } = options;
  try {
    const args = [...argv];
    if (takeFlag(args, '--help') || takeFlag(args, '-h')) {
      io.stdout.write(CASH_ADOPTION_BACKFILL_USAGE);
      return 0;
    }
    const apply = takeFlag(args, '--apply');
    assertNoExtraArgs(args);
    const context = controlContext(options.env);
    const file = path.join(context.dataDir, 'finance.db');
    if (!fs.existsSync(file)) throw new ControlError('E0I_BACKFILL_NO_DATABASE', EXIT.refused, 'no finance.db in the configured data dir');
    const opened = await openWriterDb(context.env, () => new Database(file, { readonly: !apply, fileMustExist: true }));
    try {
      const { db } = opened;
      let plan: CashAdoptionBackfillPlan;
      let recordedNow: number | null = null;
      try {
        db.pragma('busy_timeout = 10000');
        if (!apply) {
          plan = planCashAdoptionBackfill(db);
        } else {
          ({ plan, recorded: recordedNow } = recordMissingCashAdoptions(db));
        }
      } catch (error) {
        // Type and code only: an SQLite message can quote the database.
        throw new ControlError('E0I_BACKFILL_DATABASE', EXIT.refused, errorTypeAndCode(error));
      }
      report(io, plan, recordedNow);
      io.stdout.write(apply
        ? 'Done. Running it again records nothing new.\n'
        : 'Dry run: nothing was written. Back up first (npm run holdr-backup), then run again with --apply.\n');
      return 0;
    } finally {
      opened.close();
    }
  } catch (error) {
    // Codes only: another command's detail can name a private path. These details never do.
    const code = error instanceof ControlError ? error.code : 'E0I_INTERNAL';
    const detail = error instanceof ControlError && SAFE_DETAIL_CODES.has(code) && error.detail ? ` (${error.detail})` : '';
    io.stderr.write(`cash-adoption-backfill: ${code}${detail}\n`);
    return exitCodeOf(error);
  }
}

/** Codes whose detail is fixed text, a type and code, or what the operator typed. */
const SAFE_DETAIL_CODES = new Set(['E0I_USAGE', 'E0I_BACKFILL_NO_DATABASE', 'E0I_BACKFILL_DATABASE']);
