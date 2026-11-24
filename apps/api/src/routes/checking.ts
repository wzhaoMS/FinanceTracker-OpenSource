import { createVerifiedRouter } from '../ingress/expressIdentity.js';
import type { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { createCheckingLedgerReader } from '../services/checking/ledger.js';
import { HttpError, queryParams, scanQuery } from './cardSpending.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ACCOUNT_ID = /^chk-acct-[a-p]{32}$/;
const MAX_SPAN_DAYS = 3_660;

function validDate(value: string | undefined, name: string): string {
  const time = value === undefined ? NaN : Date.parse(`${value}T00:00:00Z`);
  if (value === undefined || !DATE.test(value) || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, `${name} must be a valid YYYY-MM-DD date`);
  }
  return value;
}

function count(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!/^\d{1,7}$/.test(value) || Number(value) < min || Number(value) > max) throw new HttpError(400, `${name} must be a whole number from ${min} to ${max}`);
  return Number(value);
}

/**
 * Checking accounts, read-only: the accounts the operator's GO'd imports created, the days they cover, and their
 * posted rows. Mounted only through `mountCardSpendingRoutes` (cardSpending.ts), as one of its `routers`, behind the
 * same required sign-in, value-free errors and service-token limits (reads only). No route here writes; imports run
 * only through the operator CLI (`holdr-checking import`). Checking rows are never spending: nothing here feeds a
 * spending total. Without the installed tables every answer says `installed: false` and lists nothing.
 *
 *   GET /checking/accounts      → { installed, accounts, coverage }
 *   GET /checking/transactions  ?from=YYYY-MM-DD&to=YYYY-MM-DD (at most ten years) &accountId= &limit=1…500 (100) &offset=
 *                               → { installed, total, transactions } by date then id
 */
export function createCheckingRouter(repo: Pick<SqliteStateRepo, 'internalGetDb'>) {
  const router = createVerifiedRouter();
  router.get('/checking/accounts', (req, res, next) => {
    try {
      scanQuery(req, []);
      queryParams(req, []);
      const reader = createCheckingLedgerReader(repo.internalGetDb());
      res.json({ installed: reader.installed(), accounts: reader.listAccounts(), coverage: reader.coverage() });
    } catch (error) {
      next(error);
    }
  });
  router.get('/checking/transactions', (req, res, next) => {
    try {
      const names = ['from', 'to', 'accountId', 'limit', 'offset'];
      scanQuery(req, names);
      const query = queryParams(req, names);
      const from = validDate(query.get('from'), 'from');
      const to = validDate(query.get('to'), 'to');
      if (from > to) throw new HttpError(400, 'from must not be after to');
      if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_SPAN_DAYS) throw new HttpError(400, 'from and to must be at most ten years apart');
      const accountId = query.get('accountId');
      if (accountId !== undefined && !ACCOUNT_ID.test(accountId)) throw new HttpError(400, 'accountId must be a checking account id');
      const limit = count(query.get('limit'), 100, 1, 500, 'limit');
      const offset = count(query.get('offset'), 0, 0, 1_000_000, 'offset');
      const reader = createCheckingLedgerReader(repo.internalGetDb());
      const rows = reader.listRows({ from, to }).filter((row) => accountId === undefined || row.checkingAccountId === accountId);
      res.json({ installed: reader.installed(), total: rows.length, transactions: rows.slice(offset, offset + limit) });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
