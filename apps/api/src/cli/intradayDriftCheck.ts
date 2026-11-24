import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { ControlError, EXIT, exitCodeOf } from '../control/errors.js';
import { errorTypeAndCode } from '../services/dbErrors.js';
import { createManualPriceRepo } from '../services/manualPrices.js';
import { checkIntradayLine, type IntradayDriftCheck } from '../services/portfolioHistory.js';
import type { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { createHistoryRepo } from '../services/symbolHistory.js';
import { assertNoExtraArgs, controlContext, takeFlag, type Io } from './controlCommon.js';

export const INTRADAY_DRIFT_CHECK_USAGE = `Usage: npx tsx apps/api/src/cli/intradayDriftCheckMain.ts [--week]

Read-only check of the computed 1D portfolio line: the household's current holdings at market
prices plus its current cash, against the recorded snapshots of the latest session taken since the
latest change to any account. With --week, the computed 1W line instead: the last five sessions,
each at that day's holdings and cash. It reads the configured data dir (HOLDR_DATA_DIR or
holdr.conf) with the database opened read-only, uses only the prices already stored, and fetches
and writes nothing. It prints counts and the sessions' dates only: no account, symbol or amount.
`;

function report(io: Io, check: IntradayDriftCheck | null, range: '1D' | '1W'): void {
  if (!check) {
    io.stdout.write(`No computed ${range} line: no holdings, or no intraday price of them in the last ${range === '1W' ? 'week' : 'ten days'}.\n`);
    return;
  }
  io.stdout.write([
    `Computed ${check.range} line for ${check.firstSession === check.sessionDate
      ? `the session of ${check.sessionDate}`
      : `the sessions of ${check.firstSession} to ${check.sessionDate}`}, from stored prices only (nothing fetched or written)`,
    `  points: ${check.points}, of which estimated: ${check.estimatedPoints}`,
    `  recorded snapshots taken since the latest change to any account: ${check.compared}`,
    `    within 0.1%: ${check.within01}`,
    `    0.1% to 0.5%: ${check.within05}`,
    `    over 0.5%: ${check.over05}`,
    check.passed
      ? '  the computed line would be shown'
      : `  over a tenth disagree by more than 0.5%: ${check.range} would show the recorded snapshots instead`,
  ].join('\n') + '\n');
}

export async function runIntradayDriftCheck(
  argv: readonly string[],
  options: { env: NodeJS.ProcessEnv; io: Io; now?: Date },
): Promise<number> {
  const { io } = options;
  try {
    const args = [...argv];
    if (takeFlag(args, '--help') || takeFlag(args, '-h')) {
      io.stdout.write(INTRADAY_DRIFT_CHECK_USAGE);
      return 0;
    }
    const range = takeFlag(args, '--week') ? '1W' : '1D';
    assertNoExtraArgs(args);
    const context = controlContext(options.env);
    const file = path.join(context.dataDir, 'finance.db');
    if (!fs.existsSync(file)) throw new ControlError('E0I_DRIFT_NO_DATABASE', EXIT.refused, 'no finance.db in the configured data dir');
    let check: IntradayDriftCheck | null;
    let db: Database.Database | null = null;
    try {
      db = new Database(file, { readonly: true, fileMustExist: true });
      db.pragma('busy_timeout = 10000');
      const handle = db;
      // The reads the chart makes, over a read-only handle; the repos' write statements are never run.
      const state = { internalGetDb: () => handle } as unknown as SqliteStateRepo;
      const hasManualPrices = handle.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manual_prices'").get() !== undefined;
      check = await checkIntradayLine({
        state,
        history: createHistoryRepo(state),
        ...(hasManualPrices ? { manualPrices: createManualPriceRepo(state) } : {}),
      }, options.now ?? new Date(), range);
    } catch (error) {
      // Type and code only: an SQLite message can quote the database.
      throw new ControlError('E0I_DRIFT_DATABASE', EXIT.refused, errorTypeAndCode(error));
    } finally {
      db?.close();
    }
    report(io, check, range);
    return 0;
  } catch (error) {
    // Codes only: another command's detail can name a private path. These details never do.
    const code = error instanceof ControlError ? error.code : 'E0I_INTERNAL';
    const detail = error instanceof ControlError && SAFE_DETAIL_CODES.has(code) && error.detail ? ` (${error.detail})` : '';
    io.stderr.write(`intraday-drift-check: ${code}${detail}\n`);
    return exitCodeOf(error);
  }
}

/** Codes whose detail is fixed text, a type and code, or what the operator typed. */
const SAFE_DETAIL_CODES = new Set(['E0I_USAGE', 'E0I_DRIFT_NO_DATABASE', 'E0I_DRIFT_DATABASE']);
