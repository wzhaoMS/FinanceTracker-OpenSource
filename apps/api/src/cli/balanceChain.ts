import path from 'node:path';
import Database from 'better-sqlite3';

import { formatBalanceChainReport } from '@finance-tracker/shared';

import { configuredControlDir } from '../control/controlDir.js';
import { EXIT } from '../control/errors.js';
import { acquireSharedLease, assertNoLeaseEnv, leaseStillOn } from '../control/lifecycle.js';
import { readBalanceChainReport } from '../services/balanceChain.js';
import { HoldrRefusal, errorTypeAndCode } from '../services/dbErrors.js';
import type { Io } from './controlCommon.js';

export const BALANCE_CHAIN_CLI_USAGE = `Balance-chain verifier report (existing finance.db only; read-only)
  report --db DB [--account ID] [--detail]
report checks, for every card and checking account (or the one --account names, a card-acct- or chk-acct- id),
whether the balances banks and issuers state follow from each other and the rows between them, to the cent: checking
anchors from the checking import, card anchors from allowlisted statement facts (card_schedule_observations). It runs
under the writer's shared lease or not at all: a control dir must be configured (HOLDR_CONTROL_DIR), busy and
maintenance refuse as for every writer, and the database is opened read-only with query_only. Without a control dir it
refuses (report-refused no-shared-lease, exit 1). It writes nothing.
It prints one JSON line (holdr.balance-chain-report v1) of dates, counts, account keys, issuer slugs, last fours and
closed words only, which must pass a strict schema or it is refused (report-refused value-shaped-output, exit 1). Never an
amount, a balance or a residual. --detail adds every anchor and every step per account; that line, for every account,
is the baseline W4's admission reads once Root has recorded it.
All paths must be absolute.
`;

const ACCOUNT_ID = /^(?:card|chk)-acct-[a-p]{32}$/;

function refuse(): never {
  throw new HoldrRefusal('balance chain input refused');
}

interface ReportArgs {
  database: string;
  accountId?: string;
  detail: boolean;
}

function reportArgs(args: string[]): ReportArgs {
  let database: string | undefined;
  let accountId: string | undefined;
  let detail = false;
  for (let i = 0; i < args.length; i += 1) {
    const name = args[i];
    if (name === '--detail') {
      if (detail) refuse();
      detail = true;
    } else if (name === '--db') {
      const value = args[(i += 1)];
      if (database !== undefined || !value || !path.isAbsolute(value)) refuse();
      database = value;
    } else if (name === '--account') {
      const value = args[(i += 1)];
      if (accountId !== undefined || !value || !ACCOUNT_ID.test(value)) refuse();
      accountId = value;
    } else refuse();
  }
  if (database === undefined) refuse();
  return { database, accountId, detail };
}

/**
 * The report, under the writer's shared lease or not at all: a control dir must be configured (HOLDR_CONTROL_DIR), its
 * shared `lifecycle.lock` taken with the marker `normal` (busy and maintenance refuse, as for every writer), and the lease
 * verified as still held on that lock before the database is opened read-only with `query_only`.
 */
async function runReport(env: NodeJS.ProcessEnv, args: ReportArgs, io: Io): Promise<number> {
  assertNoLeaseEnv(env);
  const controlDir = configuredControlDir(env);
  const noLease = () => {
    io.stderr.write('balance-chain: report-refused no-shared-lease\n');
    return 1;
  };
  if (controlDir === null) return noLease();
  const lease = await acquireSharedLease(controlDir, { timeoutMs: 10_000, busyExit: EXIT.busy, maintenanceExit: EXIT.maintenance });
  try {
    if (!leaseStillOn(lease, controlDir)) return noLease();
    const db = new Database(args.database, { readonly: true, fileMustExist: true });
    try {
      db.pragma('query_only = ON');
      db.pragma('busy_timeout = 10000');
      const line = formatBalanceChainReport(readBalanceChainReport(db, { accountId: args.accountId, detail: args.detail }));
      if (line === null) {
        io.stderr.write('balance-chain: report-refused value-shaped-output\n');
        return 1;
      }
      io.stdout.write(line);
      return 0;
    } finally {
      db.close();
    }
  } finally {
    lease.release();
  }
}

/** `holdr-balance-chain`: the read-only report. Returns the exit status. */
export async function runBalanceChainCli(args: string[], context: { env: NodeJS.ProcessEnv; io: Io }): Promise<number> {
  const { io } = context;
  try {
    const [command, ...rest] = args;
    if (command === '--help') {
      io.stdout.write(BALANCE_CHAIN_CLI_USAGE);
      return 0;
    }
    if (command !== 'report') return refuse();
    return await runReport(context.env, reportArgs(rest), io);
  } catch (error) {
    io.stderr.write(`balance-chain: ${error instanceof HoldrRefusal ? 'input-refused' : 'operation-failed'} ${errorTypeAndCode(error)}\n`);
    return 1;
  }
}
