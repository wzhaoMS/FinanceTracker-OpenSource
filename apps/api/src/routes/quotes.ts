import { Router } from 'express';

import type { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { isDatabaseFailure } from '../services/dbErrors.js';
import { resolveQuotes } from '../services/quoteResolver.js';
import type { getQuotes } from '../providers/quoteProvider.js';
import { asyncRoute } from '../asyncRoute.js';

/** `fetcher` replaces the provider chain (stored market data: services/storedMarketData.ts). */
export function createQuotesRouter(state: SqliteStateRepo, fetcher?: typeof getQuotes): Router {
  const router = Router();

/**
 * GET /quotes?symbols=AAPL,MSFT,BTC-USD
 * Returns current quotes for the comma-separated list of symbols.
 */
  router.get('/', asyncRoute(async (req, res, next) => {
  const raw = typeof req.query.symbols === 'string' ? req.query.symbols : '';
  const symbols = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  if (symbols.length === 0) {
    return res.status(400).json({ error: 'symbols query parameter is required' });
  }
  if (symbols.length > 50) {
    return res.status(400).json({ error: 'too many symbols (max 50)' });
  }

  try {
    const resolution = await resolveQuotes(state, symbols, {}, fetcher);
    res.json(resolution);
  } catch (err) {
    if (isDatabaseFailure(err)) return next(err);
    const message = err instanceof Error ? err.message : 'unknown error';
    res.status(502).json({ error: 'quote provider failed', detail: message });
  }
  }));
  return router;
}
