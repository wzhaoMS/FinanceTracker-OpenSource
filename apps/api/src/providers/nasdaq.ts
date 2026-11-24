import { currentMarketSession, type Quote } from '@finance-tracker/shared';

/**
 * Nasdaq.com public quote API. Real-time during US market hours, no API key.
 *
 *   GET https://api.nasdaq.com/api/quote/{SYMBOL}/info?assetclass={class}
 *
 * One symbol per request; no documented bulk endpoint. We fan out with
 * Promise.allSettled so a single 404 doesn't kill the rest.
 *
 * Asset classes (we try `stocks` first; fall back to `etf`, then `mutualfunds`):
 *   stocks       — common shares (AAPL, NBIS)
 *   etf          — ETFs (QQQ, FBTC, VOO)
 *   mutualfunds  — mutual fund classes (VFIAX) — EOD NAV only
 *
 * Response fields we consume (from real fixtures):
 *   data.primaryData.lastSalePrice        "$200.00"
 *   data.primaryData.netChange            "+0.15"
 *   data.primaryData.percentageChange     "+0.05%"
 *   data.primaryData.deltaIndicator       "up" | "down" | "unchanged"
 *   data.primaryData.lastTradeTimestamp   "May 6, 2026 11:27 AM ET"
 *   data.primaryData.isRealTime           true | false (mutual funds = false)
 *
 * Day-change baseline: prior regular-session close (brokerage standard).
 */

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const ASSET_CLASSES = ['stocks', 'etf', 'mutualfunds'] as const;
type AssetClass = (typeof ASSET_CLASSES)[number];
const REQUEST_TIMEOUT_MS = 5_000;

export interface NasdaqResponse {
  data?: {
    symbol?: string;
    primaryData?: {
      lastSalePrice?: string;
      netChange?: string;
      percentageChange?: string;
      deltaIndicator?: string;
      lastTradeTimestamp?: string;
      isRealTime?: boolean;
    } | null;
    /**
     * Extended-hours (pre-market / after-hours) block. Mirrors primaryData's
     * string convention. Null during regular hours and when closed. Shape is
     * inferred from Nasdaq's documented convention; the real payload is
     * captured + verified on a weekday before the extended-hours path is
     * enabled (see EXTENDED_HOURS_ENABLED). Every field is null-guarded so an
     * unexpected shape degrades to "no extended print", never a wrong price.
     */
    secondaryData?: {
      lastSalePrice?: string;
      netChange?: string;
      percentageChange?: string;
      deltaIndicator?: string;
      lastTradeTimestamp?: string;
      isRealTime?: boolean;
    } | null;
    /** "Open" | "Closed" | "Pre Market" | "After Hours" — authoritative. */
    marketStatus?: string;
  } | null;
}

/**
 * Extended-hours (pre-market / after-hours) promotion. Default OFF — the
 * `secondaryData` shape can only be observed on a weekday with live extended
 * trading, so until that's captured and verified this path stays dark and
 * Nasdaq behaves exactly as before. Enable with `EXTENDED_HOURS_ENABLED=1`.
 */
const EXTENDED_HOURS_ENABLED = process.env.EXTENDED_HOURS_ENABLED === '1';

/** Reject an extended print this far from the regular close (mis-shape guard). */
const EXTENDED_SANITY_BAND = 0.3;

/**
 * Strip currency/comma, normalize Unicode minus, return null on the magic
 * "N/A" / "--" / "UNCH" strings the API uses for missing fields.
 */
export function parseDollarString(input: string | undefined | null): number | null {
  if (input == null) return null;
  const cleaned = input.replace(/\u2212/g, '-').replace(/[$,]/g, '').trim();
  if (!cleaned) return null;
  if (/^(N\/A|--|UNCH|unchanged)$/i.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** "+0.05%" → 0.05; handles leading +, Unicode minus, "UNCH". */
export function parsePercentString(input: string | undefined | null): number | null {
  if (input == null) return null;
  const cleaned = input
    .replace(/\u2212/g, '-')
    .replace(/[%,\s]/g, '')
    .trim();
  if (!cleaned) return null;
  if (/^(N\/A|--|UNCH|unchanged)$/i.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Reject unknown or future source times instead of manufacturing a fresh quote. */
export function parseNasdaqTime(input: string | undefined, now: Date = new Date()): number | null {
  if (!input) return null;
  const nowMs = now.getTime();
  const trimmed = input.trim();
  const dateOnly = trimmed.match(/^([A-Za-z]+ (\d{1,2}), \d{4})(?:\s*ET)?$/i);
  if (dateOnly) {
    const endOfDay = Date.parse(`${dateOnly[1]} 23:00:00 GMT`);
    if (Number.isFinite(endOfDay) && new Date(endOfDay).getUTCDate() === Number(dateOnly[2])) {
      const closeMs = currentMarketSession(new Date(endOfDay)).lastCloseMs;
      return closeMs > 0 && closeMs <= nowMs ? closeMs : null;
    }
    return null;
  }
  const match = trimmed.match(/^([A-Za-z]+ \d{1,2}, \d{4})\s+(\d{1,2}):(\d{2})\s+(AM|PM)\s*ET$/i);
  if (!match) {
    if (!/(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC|EST|EDT)$/i.test(trimmed)) return null;
    const fallback = Date.parse(trimmed);
    return Number.isFinite(fallback) && fallback > 0 && fallback <= nowMs ? fallback : null;
  }
  const [, datePart, hourStr, minStr, ampm] = match;
  const baseMs = Date.parse(`${datePart} 12:00:00 GMT`);
  if (!Number.isFinite(baseMs)) return null;
  if (new Date(baseMs).getUTCDate() !== Number(datePart.match(/ (\d{1,2}),/)?.[1])) return null;
  const clockHour = Number(hourStr);
  const minute = Number(minStr);
  if (clockHour < 1 || clockHour > 12 || minute > 59) return null;
  const hour = clockHour % 12 + (ampm.toUpperCase() === 'PM' ? 12 : 0);
  const timeZoneName = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  }).formatToParts(new Date(baseMs)).find((part) => part.type === 'timeZoneName')?.value;
  if (timeZoneName !== 'GMT-4' && timeZoneName !== 'GMT-5') return null;
  const offsetHours = Number(timeZoneName.replace('GMT', ''));
  const iso = `${new Date(baseMs).toISOString().slice(0, 10)}T${pad(hour)}:${pad(minute)}:00${offsetSign(offsetHours)}`;
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= nowMs ? timestamp : null;
}
const pad = (n: number) => String(n).padStart(2, '0');
const offsetSign = (h: number) => `${h >= 0 ? '+' : '-'}${pad(Math.abs(h))}:00`;

/**
 * Pure parser: turn a Nasdaq response payload into a Quote (or null).
 *
 * Day-change derivation:
 *   - `netChange` and `percentageChange` come straight from the payload.
 *   - `deltaIndicator` (up/down) is informational; `+`/`-` already in the
 *     numeric strings so we don't need it for sign.
 *   - `baselinePrice = price - dayChange`. We always derive `dayChange` from
 *     `(price, baselinePrice)` for self-consistency, but if the provider's
 *     own `netChange` disagrees by > 0.5% we drop the day-change rather than
 *     publish two inconsistent numbers.
 */
export function parseNasdaqQuote(
  json: NasdaqResponse,
  fallbackSymbol: string,
  enableExtended: boolean = EXTENDED_HOURS_ENABLED,
): Quote | null {
  const pd = json.data?.primaryData;
  if (!pd) return null;
  const price = parseDollarString(pd.lastSalePrice);
  if (price == null || price <= 0) return null;

  const symbol = (json.data?.symbol ?? fallbackSymbol).toUpperCase();
  const asOf = parseNasdaqTime(pd.lastTradeTimestamp);
  if (asOf == null) return null;

  const providerChange = parseDollarString(pd.netChange);
  const providerPct = parsePercentString(pd.percentageChange);

  let changeBasis: Quote['changeBasis'];
  let baselinePrice: number | undefined;
  let dayChange: number | undefined;
  let dayChangePercent: number | undefined;

  if (providerChange != null) {
    baselinePrice = price - providerChange;
    if (baselinePrice > 0) {
      changeBasis = 'previousClose';
      dayChange = price - baselinePrice;
      const derivedPct = (dayChange / baselinePrice) * 100;
      // Keep provider's percent if it's within 0.5pp; else derive.
      dayChangePercent =
        providerPct != null && Math.abs(providerPct - derivedPct) < 0.5
          ? providerPct
          : derivedPct;
    }
  }

  const quote: Quote = {
    symbol,
    price,
    currency: 'USD',
    asOf,
    source: 'nasdaq',
    ...(changeBasis !== undefined && {
      changeBasis,
      baselinePrice,
      dayChange,
      dayChangePercent,
    }),
  };

  // Extended-hours promotion (flag-gated, default OFF). The regular-session
  // `price`/`dayChange` above remain the brokerage-standard headline; when a
  // fresher pre/after-hours print exists we ALSO expose it separately and
  // promote `price` so valuation reflects the live extended price. The
  // regular `dayChange` fields are preserved (DayChangeCell reads them
  // directly and never re-derives from price), so the headline stays the
  // regular-session move while the UI tags pre/AH via `session`.
  return applyExtendedHours(quote, json.data?.secondaryData, price, enableExtended);
}

/**
 * Parse a single extended-hours print from `secondaryData`. Pure + heavily
 * null-guarded: any missing/garbage field yields null (→ caller falls back to
 * the regular quote). Exposed for tests.
 */
export function parseExtendedPrint(
  secondary: unknown,
): { price: number; asOf: number } | null {
  if (!secondary || typeof secondary !== 'object') return null;
  const s = secondary as { lastSalePrice?: unknown; lastTradeTimestamp?: unknown };
  if (typeof s.lastSalePrice !== 'string') return null;
  const px = parseDollarString(s.lastSalePrice);
  if (px == null || px <= 0) return null;
  const ts =
    typeof s.lastTradeTimestamp === 'string'
      ? parseNasdaqTime(s.lastTradeTimestamp)
      : null;
  if (ts == null) return null;
  return { price: px, asOf: ts };
}

/**
 * Apply an extended-hours print to a regular-session quote. Pure + testable.
 *   - Only acts when `enable` is true and a valid extended print exists.
 *   - Prefer-if-fresher: the extended print must be newer than the regular
 *     `asOf` (else it's a stale echo of the close — ignore).
 *   - Sanity band: reject prints implausibly far from the regular close
 *     (mis-shape / wrong field guard).
 * When accepted: sets `extended*` fields and promotes `price`/`asOf`, while
 * preserving the regular-session `dayChange`/`baselinePrice`.
 */
export function applyExtendedHours(
  quote: Quote,
  secondary: unknown,
  regularClose: number,
  enable: boolean,
): Quote {
  if (!enable) return quote;
  const ext = parseExtendedPrint(secondary);
  if (!ext) return quote;
  if (!(ext.asOf > quote.asOf)) return quote; // not fresher → ignore
  if (!(regularClose > 0)) return quote;
  if (Math.abs(ext.price / regularClose - 1) > EXTENDED_SANITY_BAND) return quote;

  const extendedChange = ext.price - regularClose;
  const extendedChangePercent = (extendedChange / regularClose) * 100;
  return {
    ...quote,
    price: ext.price,
    asOf: ext.asOf,
    extendedPrice: ext.price,
    extendedAsOf: ext.asOf,
    extendedChange,
    extendedChangePercent,
  };
}

async function fetchOne(symbol: string, assetclass: AssetClass, signal: AbortSignal): Promise<Quote | null> {
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/info?assetclass=${assetclass}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal });
  if (!res.ok) return null;
  const json = (await res.json()) as NasdaqResponse;
  return parseNasdaqQuote(json, symbol);
}

/** Try `stocks` → `etf` → `mutualfunds`. First match wins. */
async function fetchWithClassRollover(symbol: string): Promise<Quote | null> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  for (const cls of ASSET_CLASSES) {
    if (signal.aborted) return null;
    try {
      const q = await fetchOne(symbol, cls, signal);
      if (q) return q;
    } catch {
      if (signal.aborted) return null;
      // try next class
    }
  }
  return null;
}

export async function fetchNasdaqQuotes(symbols: string[]): Promise<Quote[]> {
  if (symbols.length === 0) return [];
  const results = await Promise.allSettled(symbols.map(fetchWithClassRollover));
  const out: Quote[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) out.push(r.value);
  }
  return out;
}
