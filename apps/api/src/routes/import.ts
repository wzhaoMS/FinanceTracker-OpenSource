import { Router } from 'express';

import { mapTableToTransactions, type RawRow } from '../services/importMapper.js';

export const importRouter = Router();

/**
 * POST /import/positions
 * Body: {
 *   accountId: string,
 *   asOf?: string (YYYY-MM-DD, default today),
 *   table: { headers: string[], rows: Record<string,string>[] }
 * }
 * Designed for the webhand extractAllTables() shape.
 *
 * Returns a dry-run preview only. The web client commits reviewed transactions
 * through the portfolio API, which persists them in the server's SQLite
 * database; this route itself never writes.
 */
importRouter.post('/positions', (req, res) => {
  const { accountId, asOf, table } = req.body ?? {};
  if (typeof accountId !== 'string' || !accountId.trim()) {
    return res.status(400).json({ error: 'accountId is required' });
  }
  if (!table || !Array.isArray(table.headers) || !Array.isArray(table.rows)) {
    return res.status(400).json({ error: 'table.headers[] and table.rows[] required (webhand extractAllTables shape)' });
  }
  const date = typeof asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asOf)
    ? asOf
    : new Date().toISOString().slice(0, 10);

  const result = mapTableToTransactions(accountId, date, table.headers as string[], table.rows as RawRow[]);
  res.json(result);
});
