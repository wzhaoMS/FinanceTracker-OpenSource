import type { Quote } from '@finance-tracker/shared';
import { parseProviderTime } from './providerTime.js';

/**
 * Stooq is a free, no-auth quote source that returns CSV. It's a reliable
 * fallback when Yahoo rate-limits us.
 *
 * Symbol mapping (Yahoo-style → Stooq):
 *   AAPL          → aapl.us
 *   MSFT          → msft.us
 *   BTC-USD       → btcusd
 *   ETH-USD       → ethusd
 *   EURUSD=X      → eurusd
 *   ^GSPC         → ^spx (best effort; Stooq uses different index names)
 */
function toStooqSymbol(symbol: string): string {
  const s = symbol.toLowerCase();
  if (s.endsWith('-usd')) return s.replace('-usd', 'usd');
  if (s.endsWith('=x')) return s.slice(0, -2);
  if (s.startsWith('^')) return s; // pass through; user beware
  // Default to US listing.
  return `${s}.us`;
}

function inferCurrency(symbol: string): string {
  if (/-USD$/i.test(symbol) || /USD=X$/i.test(symbol)) return 'USD';
  return 'USD';
}

async function fetchOne(symbol: string): Promise<Quote | null> {
  const stooq = toStooqSymbol(symbol);
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(stooq)}&f=sd2t2ohlcv&h&e=csv`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) {
    throw new Error(`Stooq failed for ${symbol}: ${res.status}`);
  }
  const text = await res.text();
  // Header line + data line.
  const [, dataLine] = text.trim().split(/\r?\n/);
  if (!dataLine) return null;
  const cols = dataLine.split(',');
  // Stooq returns "N/D" for unknown symbols.
  if (cols.length < 7 || cols[1] === 'N/D') return null;
  const close = Number(cols[6]);
  if (!Number.isFinite(close) || close <= 0) return null;
  const date = cols[1];
  const time = cols[2];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}:\d{2}$/.test(time)) return null;
  const asOf = parseProviderTime(`${date}T${time}`, 'Europe/Warsaw');
  if (asOf == null) return null;
  return {
    symbol,
    price: close,
    currency: inferCurrency(symbol),
    asOf,
    source: 'stooq',
  };
}

export async function fetchStooqQuotes(symbols: string[]): Promise<Quote[]> {
  if (symbols.length === 0) return [];
  const results = await Promise.allSettled(symbols.map(fetchOne));
  const quotes: Quote[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) quotes.push(r.value);
  }
  return quotes;
}
