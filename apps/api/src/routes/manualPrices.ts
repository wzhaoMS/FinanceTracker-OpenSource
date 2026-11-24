import { Router } from 'express';

import type { ManualPriceRepo } from '../services/manualPrices.js';

/**
 * GET    /manual-prices                          — list all
 * GET    /manual-prices/:symbol                  — list for one symbol
 * PUT    /manual-prices/:symbol/:date            — upsert (body: { close, notes? })
 * DELETE /manual-prices/:symbol/:date            — remove
 *
 * Symbol is normalized to uppercase. Date must be YYYY-MM-DD. Close must
 * be a finite positive number. Validation errors return 400.
 */

const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,11}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function createManualPricesRouter(repo: ManualPriceRepo): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ entries: repo.listAll() });
  });

  router.get('/:symbol', (req, res) => {
    const sym = req.params.symbol;
    if (!SYMBOL_RE.test(sym)) {
      return res.status(400).json({ error: 'invalid symbol' });
    }
    res.json({ symbol: sym.toUpperCase(), entries: repo.list(sym) });
  });

  router.put('/:symbol/:date', (req, res) => {
    const sym = req.params.symbol;
    const date = req.params.date;
    if (!SYMBOL_RE.test(sym)) return res.status(400).json({ error: 'invalid symbol' });
    if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const body = (req.body ?? {}) as { close?: unknown; notes?: unknown };
    const closeNum = Number(body.close);
    if (!Number.isFinite(closeNum) || closeNum <= 0) {
      return res.status(400).json({ error: 'close must be a positive finite number' });
    }
    const notes = typeof body.notes === 'string' ? body.notes : undefined;
    repo.upsert({ symbol: sym.toUpperCase(), date, close: closeNum, notes });
    res.json({ ok: true, symbol: sym.toUpperCase(), date, close: closeNum, notes });
  });

  router.delete('/:symbol/:date', (req, res) => {
    const sym = req.params.symbol;
    const date = req.params.date;
    if (!SYMBOL_RE.test(sym)) return res.status(400).json({ error: 'invalid symbol' });
    if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const removed = repo.remove(sym, date);
    if (!removed) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  });

  return router;
}
