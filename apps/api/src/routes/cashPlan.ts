import { Router, type RequestHandler } from 'express';

import { HttpError, cardGuardRefusal, queryParams, scanQuery } from './cardSpending.js';
import { CARD_PAYMENT_DECISIONS_CONFLICT, CARD_PAYMENT_DECISIONS_CONFLICT_CODE } from '../services/cardPaymentDecisions.js';
import { CASH_PLAN_CONFLICT, cashPaymentsView, readCashPlanInputs, type CashPlanCheckingReader } from '../services/cashPlan.js';
import { cashOwedView } from '../services/cashOwed.js';
import { HoldrRefusal } from '../services/dbErrors.js';
import type { SqliteStateRepo } from '../services/sqliteStateRepo.js';

/** The fixed code of the 409 for a `card_schedule_observations` table in another shape. */
export const CASH_PLAN_CONFLICT_CODE = 'cash-plan-conflict';

/**
 * The card payment schedule (A1 spec v9 §4) and each card's balance owed now, read-only. Served only through
 * `mountCardSpendingRoutes` (cardSpending.ts), as one of its `routers`, behind the same required sign-in, body-parser
 * skip and value-free error handler as every card spending route; the service token may read. There are no writes under
 * `/cash/*`.
 *
 *   GET /cash/payments → { installed, mode: 'knowledge', asOf, today, timeZone, rules, cards: [{ cardAccountId, issuer,
 *       nickname, last4, owner, status, delinquency, cycles (newest first, retained unresolved older cycles included),
 *       bankReads (unlinked due-only reads), attention }], totals: { red, amber, unknown, held } }
 *   GET /cash/owed → { installed, asOf, today, cards: [{ cardAccountId, issuer, owner, nickname, last4, last5, currency,
 *       status, read: null | { currentBalanceMinor, conflict, asOf, asOfDate, sourceKind, statementBalanceMinor,
 *       statementClosingDate, remainingStatementMinor, paymentDueDate, minimumDueMinor } }], held }
 *
 * Without the table (`holdr-cash install` not run) the payment schedule answers `installed: false` with no cards, and
 * owed now lists every active card unread. A table in another shape, or (for the schedule) a payment decisions table in
 * another shape, is a fixed 409; database failures go on to the mount's handler.
 */
export function createCashPlanRouter(
  repo: SqliteStateRepo,
  options: { log?: (line: string) => void; checkingLedger?: CashPlanCheckingReader | null; now?: () => Date } = {},
): Router {
  const router = Router();
  const log = options.log ?? ((line: string) => console.error(line));
  const now = options.now ?? (() => new Date());
  const reader = options.checkingLedger ?? null;

  const read = (answer: () => unknown): RequestHandler => (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      scanQuery(req, []);
      queryParams(req, []);
      res.json(answer());
    } catch (caught) {
      const error = caught instanceof HttpError
        ? caught
        : caught instanceof HoldrRefusal && caught.message === CASH_PLAN_CONFLICT
          ? new HttpError(409, CASH_PLAN_CONFLICT, { code: CASH_PLAN_CONFLICT_CODE })
          : caught instanceof HoldrRefusal && caught.message === CARD_PAYMENT_DECISIONS_CONFLICT
            ? new HttpError(409, CARD_PAYMENT_DECISIONS_CONFLICT, { code: CARD_PAYMENT_DECISIONS_CONFLICT_CODE })
            : cardGuardRefusal(caught, '$', log) ?? caught;
      if (error instanceof HttpError) {
        res.status(error.status).json({ error: error.message, ...error.extra });
        return;
      }
      next(error);
    }
  };
  router.get('/cash/payments', read(() => cashPaymentsView(readCashPlanInputs(repo.internalGetDb(), reader), now())));
  router.get('/cash/owed', read(() => cashOwedView(repo.internalGetDb(), now())));
  return router;
}
