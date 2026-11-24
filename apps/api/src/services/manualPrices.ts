import type { Database as DB } from 'better-sqlite3';

import type { SqliteStateRepo } from './sqliteStateRepo.js';

/**
 * Phase E.7 — manual price overrides for unlisted holdings.
 *
 * Some holdings have no provider history (employer-only funds, private
 * placements, illiquid funds). Without manual entry these symbols silently
 * drop out of the portfolio value chart. This service lets the user enter
 * close prices on specific dates; the reconstruction prefers manual values
 * over the C.1 daily-bar cache when both exist for the same date.
 *
 * Schema: `manual_prices(symbol TEXT, date TEXT, close REAL, notes TEXT,
 * created_at, updated_at)` with PK `(symbol, date)`. Symbols are stored
 * uppercase to match the rest of the system.
 */

export interface ManualPrice {
  symbol: string;
  date: string;             // YYYY-MM-DD
  close: number;
  notes?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ManualPriceRepo {
  /** All entries for one symbol, ordered ascending by date. */
  list(symbol: string): ManualPrice[];
  /** All entries across all symbols (e.g. for a global "manual prices"
   *  admin view). Ordered by symbol, date. */
  listAll(): ManualPrice[];
  /** Insert or replace one (symbol, date) row. */
  upsert(price: ManualPrice): void;
  /** Delete one row. Returns whether anything was deleted. */
  remove(symbol: string, date: string): boolean;
  /**
   * Return the manual close on or before `date` for `symbol`. Mirrors the
   * forward-fill behavior of `priceOnOrBefore` in portfolioHistory so manual
   * NAVs entered weekly are still useful day-by-day. Returns null when the
   * symbol has no entries at or before `date`.
   */
  closeOnOrBefore(symbol: string, date: string): number | null;
}

export function createManualPriceRepo(state: SqliteStateRepo): ManualPriceRepo {
  const db: DB = state.internalGetDb();
  const listStmt = db.prepare(
    `SELECT symbol, date, close, notes, created_at as createdAt, updated_at as updatedAt
       FROM manual_prices WHERE symbol = ? ORDER BY date ASC`,
  );
  const listAllStmt = db.prepare(
    `SELECT symbol, date, close, notes, created_at as createdAt, updated_at as updatedAt
       FROM manual_prices ORDER BY symbol ASC, date ASC`,
  );
  const upsertStmt = db.prepare(
    `INSERT INTO manual_prices (symbol, date, close, notes, updated_at)
     VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(symbol, date) DO UPDATE SET
       close = excluded.close,
       notes = excluded.notes,
       updated_at = excluded.updated_at`,
  );
  const deleteStmt = db.prepare(
    `DELETE FROM manual_prices WHERE symbol = ? AND date = ?`,
  );
  const onOrBeforeStmt = db.prepare(
    `SELECT close FROM manual_prices
      WHERE symbol = ? AND date <= ?
      ORDER BY date DESC LIMIT 1`,
  );
  return {
    list(symbol) {
      return listStmt.all(symbol.toUpperCase()) as ManualPrice[];
    },
    listAll() {
      return listAllStmt.all() as ManualPrice[];
    },
    upsert(price) {
      upsertStmt.run(
        price.symbol.toUpperCase(),
        price.date,
        price.close,
        price.notes ?? null,
      );
    },
    remove(symbol, date) {
      const info = deleteStmt.run(symbol.toUpperCase(), date);
      return info.changes > 0;
    },
    closeOnOrBefore(symbol, date) {
      const row = onOrBeforeStmt.get(symbol.toUpperCase(), date) as { close: number } | undefined;
      return row?.close ?? null;
    },
  };
}
