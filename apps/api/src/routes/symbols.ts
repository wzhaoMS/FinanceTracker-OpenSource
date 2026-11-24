import { Router } from 'express';

import {
  type HistoryRepo,
  type RangeKey,
  RANGE_DAYS,
  getSymbolHistory,
} from '../services/symbolHistory.js';
import { isDatabaseFailure } from '../services/dbErrors.js';
import { asyncRoute } from '../asyncRoute.js';

/**
 * GET /symbols/:symbol/history?range=1W|1M|3M|YTD|1Y|5Y|ALL
 *
 * Returns daily price bars for the requested ticker + range. Cached in
 * `symbol_price_bars`; provider chain falls through Nasdaq.com for stocks/
 * ETFs/mutual funds and CoinGecko for crypto (`*-USD`).
 *
 * Response shape:
 *   {
 *     symbol, range, from, to, supported,
 *     points: [{ t, close, open?, high?, low? }],
 *     summary: { first, last, change, changePercent },
 *     sources: ["nasdaq", "coingecko", ...]
 *   }
 *
 * Status codes:
 *   200 — bars returned (`supported: true`)
 *   204 — symbol unknown to all providers (`supported: false`)
 *   400 — invalid `range`
 */
export function createSymbolsRouter(repo: HistoryRepo): Router {
  const router = Router();

  router.get('/:symbol/history', asyncRoute(async (req, res, next) => {
    const symbolRaw = req.params.symbol;
    if (!symbolRaw) return res.status(400).json({ error: 'symbol is required' });
    const range = String(req.query.range ?? '1M').toUpperCase() as RangeKey;
    if (!(range in RANGE_DAYS)) {
      return res.status(400).json({ error: `range must be one of ${Object.keys(RANGE_DAYS).join(', ')}` });
    }

    try {
      const result = await getSymbolHistory(repo, symbolRaw, range);
      const points = result.bars.map((b) => ({
        t: b.t,
        close: b.close,
        ...(b.open !== undefined && { open: b.open }),
        ...(b.high !== undefined && { high: b.high }),
        ...(b.low !== undefined && { low: b.low }),
      }));
      const first = points[0]?.close ?? 0;
      const last = points[points.length - 1]?.close ?? 0;
      const change = last - first;
      const changePercent = first !== 0 ? (change / first) * 100 : 0;
      // Always 200 so the body can carry `supported` + `reason`. The UI
      // distinguishes "no chart for this symbol" from "request failed".
      res.json({
        symbol: result.symbol,
        range: result.range,
        from: result.from,
        to: result.to,
        supported: result.supported,
        ...(result.reason !== undefined && { reason: result.reason }),
        points,
        summary: { first, last, change, changePercent },
        sources: result.sources,
        ...(result.lastRefreshedAt !== undefined && { lastRefreshedAt: result.lastRefreshedAt }),
      });
    } catch (err) {
      if (isDatabaseFailure(err)) return next(err);
      console.error('[symbols] history failed', err);
      res.status(502).json({ error: 'history fetch failed', detail: (err as Error).message });
    }
  }));

  return router;
}
