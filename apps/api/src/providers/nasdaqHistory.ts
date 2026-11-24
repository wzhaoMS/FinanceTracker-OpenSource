import type { Quote } from '@finance-tracker/shared';

import { type PriceBar, parseDollar, usDateToIso } from './historyTypes.js';

/**
 * Nasdaq.com daily history. No API key.
 *
 *   GET https://api.nasdaq.com/api/quote/{SYMBOL}/historical
 *       ?assetclass=stocks|etf|mutualfunds
 *       &fromdate=YYYY-MM-DD&todate=YYYY-MM-DD&limit=200
 *
 * Returns rows with date in MM/DD/YYYY and prices as $-prefixed strings.
 * One asset class per request; we try `stocks` then `etf` then `mutualfunds`.
 */

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const ASSET_CLASSES = ['stocks', 'etf', 'mutualfunds'] as const;
type AssetClass = (typeof ASSET_CLASSES)[number];

export interface NasdaqHistoricalResponse {
  data?: {
    symbol?: string;
    totalRecords?: number;
    tradesTable?: {
      rows?: Array<{
        date?: string;
        close?: string;
        open?: string;
        high?: string;
        low?: string;
        volume?: string;
      }>;
    } | null;
  } | null;
}

/** Pure parser; takes a fixture and returns sorted-ascending PriceBars. */
export function parseNasdaqHistorical(
  json: NasdaqHistoricalResponse,
  symbol: string,
): PriceBar[] {
  const rows = json.data?.tradesTable?.rows ?? [];
  const bars: PriceBar[] = [];
  for (const r of rows) {
    const t = usDateToIso(r.date);
    const close = parseDollar(r.close);
    if (!t || close == null) continue;
    bars.push({
      symbol: symbol.toUpperCase(),
      t,
      close,
      open: parseDollar(r.open) ?? undefined,
      high: parseDollar(r.high) ?? undefined,
      low: parseDollar(r.low) ?? undefined,
      volume: parseDollar(r.volume) ?? undefined,
      source: 'nasdaq',
    });
  }
  // Nasdaq returns newest-first; consumers expect ascending chronological.
  bars.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return bars;
}

async function fetchOne(
  symbol: string,
  fromDate: string,
  toDate: string,
  assetclass: AssetClass,
  signal: AbortSignal,
): Promise<PriceBar[]> {
  const url =
    `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/historical` +
    `?assetclass=${assetclass}&fromdate=${fromDate}&todate=${toDate}&limit=10000`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal });
  if (!res.ok) return [];
  const json = (await res.json()) as NasdaqHistoricalResponse;
  return parseNasdaqHistorical(json, symbol);
}

/**
 * Fetch Nasdaq daily history for a symbol, trying stocks → etf → mutualfunds.
 * Stops at first non-empty result.
 *
 * Empty array means "we don't know" (no recognition or zero rows in range);
 * caller should treat that as a soft miss.
 */
export async function fetchNasdaqHistory(
  symbol: string,
  fromDate: string,
  toDate: string,
): Promise<PriceBar[]> {
  const signal = AbortSignal.timeout(5_000);
  for (const cls of ASSET_CLASSES) {
    if (signal.aborted) return [];
    try {
      const bars = await fetchOne(symbol, fromDate, toDate, cls, signal);
      if (bars.length > 0) return bars;
    } catch {
      if (signal.aborted) return [];
      // try next class
    }
  }
  return [];
}

/** Re-export the latest-quote helper that closes the loop with `Quote`. */
export type { Quote };
