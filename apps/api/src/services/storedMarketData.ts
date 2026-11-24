import type { Database } from 'better-sqlite3';

import { classifyFreshness, currentMarketSession, type Quote } from '@finance-tracker/shared';

import type { getQuotes } from '../providers/quoteProvider.js';
import { marketDate } from './symbolHistory.js';

/**
 * Stored market data (`HOLDR_MARKET_DATA=stored`, what `npm run demo` sets): the API answers quotes, price history
 * and the Gold page's valuations from the closes already in its database and never asks a provider. A quote is the
 * newest stored daily close (on or before today in New York), with the close before it as the day-change baseline,
 * labelled `synthetic`. Unset or `live`, providers are asked as usual; any other value stops the API, so a typo never
 * turns an offline setup into one that goes online.
 */

export const MARKET_DATA_SETTING = 'HOLDR_MARKET_DATA';
export type MarketDataMode = 'live' | 'stored';
export const STORED_QUOTE_SOURCE = 'synthetic' as const;

export function marketDataModeOf(env: NodeJS.ProcessEnv): MarketDataMode {
  const value = env[MARKET_DATA_SETTING]?.trim() ?? '';
  if (value === '' || value === 'live') return 'live';
  if (value === 'stored') return 'stored';
  throw new Error(`${MARKET_DATA_SETTING} must be "live" or "stored"`);
}

const NEW_YORK_HOUR = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' });

/** 16:00 in New York on `date` (YYYY-MM-DD), the regular session's close: 20:00Z in summer time, 21:00Z in winter. */
export function newYorkCloseMs(date: string): number {
  for (const hour of ['20', '21']) {
    const ms = Date.parse(`${date}T${hour}:00:00Z`);
    if (Number(NEW_YORK_HOUR.format(ms)) === 16) return ms;
  }
  return Date.parse(`${date}T21:00:00Z`);
}

/**
 * Each symbol's newest two stored daily closes on or before `day`, one per date: where several sources stored a date,
 * the one the price charts prefer (nasdaq, cnbc, coingecko, stooq, then any other).
 */
function newestCloses(db: Database, symbols: readonly string[], day: string): Map<string, Array<{ t: string; close: number }>> {
  const found = new Map<string, Array<{ t: string; close: number }>>();
  if (symbols.length === 0) return found;
  const rows = db.prepare(`
    WITH one_per_date AS (
      SELECT symbol, t, close,
             ROW_NUMBER() OVER (
               PARTITION BY symbol, t
               ORDER BY CASE source WHEN 'nasdaq' THEN 0 WHEN 'cnbc' THEN 1 WHEN 'coingecko' THEN 2 WHEN 'stooq' THEN 3 ELSE 4 END, source
             ) AS pick
        FROM symbol_price_bars
       WHERE range_kind = 'daily' AND symbol IN (${symbols.map(() => '?').join(',')}) AND t <= ?
    ), ranked AS (
      SELECT symbol, t, close, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY t DESC) AS age
        FROM one_per_date WHERE pick = 1
    )
    SELECT symbol, t, close FROM ranked WHERE age <= 2 ORDER BY symbol, t DESC`)
    .all(...symbols, day) as Array<{ symbol: string; t: string; close: number }>;
  for (const row of rows) {
    if (!Number.isFinite(row.close) || row.close <= 0) continue;
    const list = found.get(row.symbol) ?? [];
    list.push({ t: row.t, close: row.close });
    found.set(row.symbol, list);
  }
  return found;
}

/**
 * Quotes from stored closes only, for the symbols that have one (in the order asked; the rest are left out, as a
 * provider leaves out what it doesn't know). As of the close's 16:00 New York time, never after `now`.
 */
export function storedQuotes(db: Database, symbols: readonly string[], now: Date = new Date()): Quote[] {
  const wanted = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
  const closes = newestCloses(db, wanted, marketDate(now));
  const session = currentMarketSession(now).session;
  return wanted.flatMap((symbol): Quote[] => {
    const [latest, previous] = closes.get(symbol) ?? [];
    if (!latest) return [];
    const asOf = Math.min(now.getTime(), newYorkCloseMs(latest.t));
    const quote: Quote = {
      symbol,
      price: latest.close,
      currency: 'USD',
      asOf,
      source: STORED_QUOTE_SOURCE,
      freshness: classifyFreshness(asOf, now),
      session,
    };
    if (previous) {
      const dayChange = latest.close - previous.close;
      Object.assign(quote, {
        changeBasis: 'previousClose',
        baselinePrice: previous.close,
        dayChange,
        dayChangePercent: (dayChange / previous.close) * 100,
      });
    }
    return [quote];
  });
}

/** A quote fetcher (the provider chain's shape) that reads stored closes only. */
export function createStoredQuoteFetcher(db: Database, clock: () => Date = () => new Date()): typeof getQuotes {
  return async (symbols) => storedQuotes(db, symbols, clock());
}
