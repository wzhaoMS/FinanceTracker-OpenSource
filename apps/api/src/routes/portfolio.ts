import { Router } from 'express';
import { createVerifiedRouter } from '../ingress/expressIdentity.js';

import {
  getPortfolioHistory,
  getPortfolioPerformance,
  type PortfolioHistoryDeps,
  type PortfolioRangeKey,
} from '../services/portfolioHistory.js';
import { isDatabaseFailure } from '../services/dbErrors.js';
import { asyncRoute } from '../asyncRoute.js';

/**
 * GET /portfolio/history?range=...&accounts=id1,id2
 *
 * Returns the household-wide value time series. `accounts` is optional;
 * pass a comma-separated list to scope to a subset (eventually this will
 * be enforced server-side based on auth membership; pre-Phase-4 the
 * filter is purely an input convenience).
 *
 * GET /portfolio/performance?accounts=id1,id2
 *
 * Returns trailing-period and calendar-year returns (time- and
 * money-weighted) with QQQ/SPY price returns, from the full ledger.
 *
 * GET /accounts/:id/history?range=...
 *
 * Returns the same shape but scoped to one account.
 *
 * Response always returns 200 with `supported: bool`. Range validation
 * still uses 400 because that's a client bug, not a missing-data case.
 */
const VALID_RANGES: ReadonlyArray<PortfolioRangeKey> = [
  '1D', '1W', '1M', '3M', 'YTD', '1Y', '5Y', 'ALL',
];

function parseRange(raw: unknown): PortfolioRangeKey | null {
  if (typeof raw !== 'string') return null;
  const r = raw.toUpperCase() as PortfolioRangeKey;
  return VALID_RANGES.includes(r) ? r : null;
}

function parseAccountsParam(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return ids.length > 0 ? ids : undefined;
}

export function createPortfolioRouter(deps: PortfolioHistoryDeps): Router {
  const router = Router();

  router.get('/history', asyncRoute(async (req, res, next) => {
    const range = parseRange(req.query.range ?? '1D');
    if (!range) {
      return res.status(400).json({ error: `range must be one of ${VALID_RANGES.join(', ')}` });
    }
    const accounts = parseAccountsParam(req.query.accounts);
    try {
      const result = await getPortfolioHistory(deps, range, accounts);
      res.json(result);
    } catch (err) {
      if (isDatabaseFailure(err)) return next(err);
      console.error('[portfolio] history failed', err);
      res.status(502).json({ error: 'portfolio history failed', detail: (err as Error).message });
    }
  }));

  router.get('/performance', asyncRoute(async (req, res, next) => {
    const accounts = parseAccountsParam(req.query.accounts);
    try {
      const performance = await getPortfolioPerformance(deps, accounts);
      res.json(performance ?? {
        supported: false,
        reason: 'Performance needs recorded transactions or broker cash history.',
      });
    } catch (err) {
      if (isDatabaseFailure(err)) return next(err);
      console.error('[portfolio] performance failed', err);
      res.status(502).json({ error: 'portfolio performance failed', detail: (err as Error).message });
    }
  }));

  return router;
}

export function createAccountHistoryRouter(deps: PortfolioHistoryDeps): Router {
  const router = createVerifiedRouter();

  // Full path including `/accounts` so this can be mounted at the app
  // root, matching the convention used by createResourceRouter.
  router.get('/accounts/:id/history', asyncRoute(async (req, res, next) => {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'account id required' });
    const range = parseRange(req.query.range ?? '1D');
    if (!range) {
      return res.status(400).json({ error: `range must be one of ${VALID_RANGES.join(', ')}` });
    }
    try {
      const result = await getPortfolioHistory(deps, range, [id]);
      res.json(result);
    } catch (err) {
      if (isDatabaseFailure(err)) return next(err);
      console.error('[portfolio] account history failed', err);
      res.status(502).json({ error: 'account history failed', detail: (err as Error).message });
    }
  }));

  return router;
}
