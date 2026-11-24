import { currentMarketSession, type Quote } from '@finance-tracker/shared';

/**
 * CNBC quote API. Real-time during market hours, no key.
 *
 *   GET https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols={SYM}&requestMethod=itv&output=json
 *
 * Bulk requests (`symbols=AAPL,MSFT`) DO NOT work as of 2026-05; the API
 * returns a single error row with `code: 1`. Call one symbol at a time.
 *
 * Response fields we consume (from real fixtures):
 *   FormattedQuoteResult.FormattedQuote[0] = {
 *     symbol, last, last_time (ISO with offset),
 *     change, change_pct,
 *     previous_day_closing,            <-- gold: brokerage-grade baseline
 *     open, high, low, currencyCode, code: 0
 *   }
 *
 * Day-change baseline: `previous_day_closing` (prior regular-session close).
 */

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface CnbcRow {
  symbol?: string;
  last?: string;
  last_time?: string;
  currencyCode?: string;
  code?: number;
  change?: string;
  change_pct?: string;
  previous_day_closing?: string;
  open?: string;
}

export interface CnbcResponse {
  FormattedQuoteResult?: {
    FormattedQuote?: CnbcRow[];
  };
}

function parseNumberLoose(input: string | undefined): number | null {
  if (input == null) return null;
  const cleaned = input.replace(/\u2212/g, '-').replace(/[$,%\s]/g, '').trim();
  if (!cleaned || /^(N\/A|--|UNCH|unchanged)$/i.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Pure parser for tests; takes a fixture, returns Quote or null. */
export function parseCnbcQuote(json: CnbcResponse, fallbackSymbol: string): Quote | null {
  const row = json.FormattedQuoteResult?.FormattedQuote?.[0];
  if (!row || row.code !== 0) return null;
  const price = parseNumberLoose(row.last);
  if (price == null || price <= 0 || !row.last_time) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(row.last_time);
  if (!dateOnly && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(row.last_time)) return null;
  const sourceTime = Date.parse(dateOnly ? `${row.last_time}T23:00:00Z` : row.last_time);
  if (!Number.isFinite(sourceTime)) return null;
  if (dateOnly && new Date(sourceTime).toISOString().slice(0, 10) !== row.last_time) return null;
  const asOf = dateOnly ? currentMarketSession(new Date(sourceTime)).lastCloseMs : sourceTime;
  if (!Number.isFinite(asOf) || asOf <= 0 || asOf > Date.now()) return null;

  // CNBC gives previous_day_closing directly. Trust it over `change`.
  const prevClose = parseNumberLoose(row.previous_day_closing);
  const providerChange = parseNumberLoose(row.change);
  const providerPct = parseNumberLoose(row.change_pct);

  let changeBasis: Quote['changeBasis'];
  let baselinePrice: number | undefined;
  let dayChange: number | undefined;
  let dayChangePercent: number | undefined;

  if (prevClose != null && prevClose > 0) {
    changeBasis = 'previousClose';
    baselinePrice = prevClose;
    dayChange = price - prevClose;
    const derivedPct = (dayChange / prevClose) * 100;
    dayChangePercent =
      providerPct != null && Math.abs(providerPct - derivedPct) < 0.5
        ? providerPct
        : derivedPct;
  } else if (providerChange != null) {
    // Fall back to `change` field only — implies basis "previousClose"
    // approximated as price - change.
    const derivedPrev = price - providerChange;
    if (derivedPrev > 0) {
      changeBasis = 'previousClose';
      baselinePrice = derivedPrev;
      dayChange = providerChange;
      dayChangePercent = (dayChange / baselinePrice) * 100;
    }
  }

  return {
    symbol: row.symbol?.toUpperCase() ?? fallbackSymbol,
    price,
    currency: row.currencyCode || 'USD',
    asOf,
    source: 'cnbc',
    ...(changeBasis !== undefined && {
      changeBasis,
      baselinePrice,
      dayChange,
      dayChangePercent,
    }),
  };
}

async function fetchOne(symbol: string): Promise<Quote | null> {
  const url =
    `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol` +
    `?symbols=${encodeURIComponent(symbol)}&requestMethod=itv&output=json`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as CnbcResponse;
  return parseCnbcQuote(json, symbol);
}

export async function fetchCnbcQuotes(symbols: string[]): Promise<Quote[]> {
  if (symbols.length === 0) return [];
  const results = await Promise.allSettled(symbols.map(fetchOne));
  const out: Quote[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) out.push(r.value);
  }
  return out;
}
