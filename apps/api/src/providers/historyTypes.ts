import type { QuoteSource } from '@finance-tracker/shared';

/**
 * Daily price bars for a single ticker, normalized across providers.
 * `t` is an ISO date string (YYYY-MM-DD) for daily bars or full ISO 8601
 * for intraday. `close` is the only required price; OHLV are best-effort.
 */
export interface PriceBar {
  symbol: string;
  /** YYYY-MM-DD for daily bars; ISO 8601 with offset for intraday. */
  t: string;
  close: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  source: QuoteSource;
}

/** Coarse classification used by the symbol-history endpoint. */
export type BarRangeKind = 'intraday' | 'daily';

/**
 * Convert MM/DD/YYYY (Nasdaq's date format) to ISO YYYY-MM-DD.
 * Returns null for malformed input.
 */
export function usDateToIso(input: string | undefined | null): string | null {
  if (!input) return null;
  const m = input.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

/** Strip $ and commas, convert Unicode minus, return null on missing/N/A. */
export function parseDollar(input: string | undefined | null): number | null {
  if (input == null) return null;
  const cleaned = String(input).replace(/\u2212/g, '-').replace(/[$,\s]/g, '').trim();
  if (!cleaned || /^(N\/A|--|UNCH|unchanged)$/i.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
