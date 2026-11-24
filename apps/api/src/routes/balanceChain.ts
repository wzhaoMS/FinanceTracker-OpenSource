import { formatBalanceChainReport } from '@finance-tracker/shared';

import { createVerifiedRouter } from '../ingress/expressIdentity.js';
import { readBalanceChainReport } from '../services/balanceChain.js';
import type { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { HttpError, queryParams, scanQuery } from './cardSpending.js';

const ACCOUNT_ID = /^(?:card|chk)-acct-[a-p]{32}$/;

/** The fixed code of the 500 for a report the strict value-free schema refused (it is never sent). */
export const BALANCE_CHAIN_REFUSED_CODE = 'balance-chain-report-refused';

/**
 * The balance-chain verifier's report (design W6 v1 §6.3), read-only, for the status view (W8) and the cadence engine
 * (W16). Mounted only through `mountCardSpendingRoutes` (cardSpending.ts), as one of its `routers`, behind the same
 * required sign-in, value-free errors and service-token limits (reads only). Nothing here writes.
 *
 *   GET /spending/balance-chains              → every account's summary (`holdr.balance-chain-report` v1)
 *   GET /spending/balance-chains?accountId=   → that card or checking account with every anchor and step (`detail`)
 *
 * The body is exactly what `holdr-balance-chain report` prints: value-free by construction, and sent only after the
 * strict schema accepts it. Without the checking or statement-facts tables their accounts or anchors are simply absent;
 * a table in another shape is reported as `conflict` and never read.
 */
export function createBalanceChainRouter(repo: Pick<SqliteStateRepo, 'internalGetDb'>) {
  const router = createVerifiedRouter();
  router.get('/spending/balance-chains', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      scanQuery(req, ['accountId']);
      const accountId = queryParams(req, ['accountId']).get('accountId');
      if (accountId !== undefined && !ACCOUNT_ID.test(accountId)) throw new HttpError(400, 'accountId must be a card or checking account id');
      const report = readBalanceChainReport(repo.internalGetDb(), { accountId, detail: accountId !== undefined });
      if (accountId !== undefined && report.accounts.length === 0) throw new HttpError(404, 'account not found');
      const line = formatBalanceChainReport(report);
      if (line === null) throw new HttpError(500, 'the balance chain report was refused', { code: BALANCE_CHAIN_REFUSED_CODE });
      res.type('application/json').send(line);
    } catch (caught) {
      if (caught instanceof HttpError) {
        res.status(caught.status).json({ error: caught.message, ...caught.extra });
        return;
      }
      next(caught);
    }
  });
  return router;
}
