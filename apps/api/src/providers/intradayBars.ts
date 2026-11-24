/**
 * Intraday prices for the computed 1D and 1W portfolio charts, from public chart endpoints. No API
 * key, and only a public ticker symbol is ever sent: never an account, a quantity or a value.
 *
 *   Nasdaq  GET https://api.nasdaq.com/api/quote/{SYMBOL}/chart?assetclass=stocks|etf
 *           1-minute points for the latest session, 4:00 AM to 8:00 PM ET, stocks and ETFs (not
 *           mutual funds). `x` is the New York wall-clock time written as if it were UTC
 *           (4:00 AM ET arrives as T04:00:00Z), `y` the price.
 *   CNBC    GET https://ts-api.cnbc.com/harmony/app/charts/1D.json?symbol={SYMBOL}
 *           1-minute bars for the latest session; `tradeTimeinMills` is a real epoch. Used only
 *           when Nasdaq has nothing for the symbol.
 *   CNBC    GET https://ts-api.cnbc.com/harmony/app/charts/5D.json?symbol={SYMBOL}
 *           5-minute bars for the last five sessions, for the 1W chart's past sessions. Its stray
 *           bars outside a weekday's 4:00 AM to 8:00 PM ET are dropped.
 *
 * Cached in `symbol_price_bars` as `intraday` rows under their own sources, apart from the
 * snapshot job's recorded quotes.
 */

export const NASDAQ_CHART_SOURCE = 'nasdaq-chart';
export const CNBC_CHART_SOURCE = 'cnbc-chart';
export const CNBC_WEEK_CHART_SOURCE = 'cnbc-chart-5d';
export type IntradayChartSource = typeof NASDAQ_CHART_SOURCE | typeof CNBC_CHART_SOURCE | typeof CNBC_WEEK_CHART_SOURCE;
export const INTRADAY_CHART_SOURCES: readonly IntradayChartSource[] = [NASDAQ_CHART_SOURCE, CNBC_CHART_SOURCE, CNBC_WEEK_CHART_SOURCE];

export interface IntradayBar {
  symbol: string;
  /** UTC instant, ISO 8601. */
  t: string;
  close: number;
  source: IntradayChartSource;
}

/** The latest session's 1-minute bars (or, for the week, the last five sessions' bars) of one public symbol; empty when no provider has them. */
export type IntradayBarFetcher = (symbol: string) => Promise<IntradayBar[]>;

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
/** A public ticker: letters, digits, '.', '-'; the same rule the symbol routes use. */
const PUBLIC_SYMBOL = /^[A-Z][A-Z0-9.-]{0,11}$/;
const REQUEST_TIMEOUT_MS = 4_000;

const NEW_YORK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** The New York wall-clock time of an instant, written as if it were UTC (whole seconds). */
export function newYorkWallClock(instant: number): number {
  const parts = NEW_YORK.formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((entry) => entry.type === type)?.value);
  return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
}

/**
 * The instant at which New York's clock reads `wall` (a wall-clock time written as if it were UTC):
 * four hours later under daylight time, five under standard time. Null for a time the clock skips
 * when daylight time starts (2:00 to 3:00 AM, outside every session).
 */
export function newYorkWallClockToInstant(wall: number): number | null {
  if (!Number.isFinite(wall)) return null;
  const wholeSeconds = Math.floor(wall / 1000) * 1000;
  for (const hours of [4, 5]) {
    const candidate = wholeSeconds + hours * 3_600_000;
    if (newYorkWallClock(candidate) === wholeSeconds) return candidate + (wall - wholeSeconds);
  }
  return null;
}

function price(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.replace(/[$,\s]/g, '')) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function ascendingUnique(bars: IntradayBar[]): IntradayBar[] {
  const byTime = new Map<string, IntradayBar>();
  for (const bar of bars) byTime.set(bar.t, bar);
  return Array.from(byTime.values()).sort((left, right) => left.t.localeCompare(right.t));
}

/** Pure parser for Nasdaq's chart payload. */
export function parseNasdaqChart(json: unknown, symbol: string): IntradayBar[] {
  const chart = (json as { data?: { chart?: unknown } | null } | null)?.data?.chart;
  if (!Array.isArray(chart)) return [];
  const bars: IntradayBar[] = [];
  for (const point of chart as Array<{ x?: unknown; y?: unknown } | null>) {
    const close = price(point?.y);
    const wall = typeof point?.x === 'number' ? point.x : NaN;
    const instant = newYorkWallClockToInstant(wall);
    if (close === null || instant === null) continue;
    bars.push({ symbol: symbol.toUpperCase(), t: new Date(instant).toISOString(), close, source: NASDAQ_CHART_SOURCE });
  }
  return ascendingUnique(bars);
}

/** Pure parser for CNBC's chart payload. */
export function parseCnbcChart(
  json: unknown,
  symbol: string,
  source: typeof CNBC_CHART_SOURCE | typeof CNBC_WEEK_CHART_SOURCE = CNBC_CHART_SOURCE,
): IntradayBar[] {
  const priceBars = (json as { barData?: { priceBars?: unknown } | null } | null)?.barData?.priceBars;
  if (!Array.isArray(priceBars)) return [];
  const bars: IntradayBar[] = [];
  for (const bar of priceBars as Array<{ close?: unknown; tradeTimeinMills?: unknown } | null>) {
    const close = price(bar?.close);
    const instant = typeof bar?.tradeTimeinMills === 'number'
      ? bar.tradeTimeinMills
      : typeof bar?.tradeTimeinMills === 'string' ? Number(bar.tradeTimeinMills) : NaN;
    if (close === null || !Number.isFinite(instant)) continue;
    bars.push({ symbol: symbol.toUpperCase(), t: new Date(instant).toISOString(), close, source });
  }
  return ascendingUnique(bars);
}

/** Only bars inside a weekday's session hours, 4:00 AM to 8:00 PM New York time. */
export function withinWeekdaySessions(bars: IntradayBar[]): IntradayBar[] {
  return bars.filter((bar) => {
    const wall = newYorkWallClock(Date.parse(bar.t));
    const weekday = new Date(wall).getUTCDay();
    const minute = Math.floor((wall % 86_400_000) / 60_000);
    return weekday >= 1 && weekday <= 5 && minute >= 4 * 60 && minute <= 20 * 60;
  });
}

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal });
  return response.ok ? response.json() : null;
}

export async function fetchNasdaqChart(symbol: string): Promise<IntradayBar[]> {
  if (!PUBLIC_SYMBOL.test(symbol)) return [];
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  for (const assetClass of ['stocks', 'etf'] as const) {
    try {
      const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/chart?assetclass=${assetClass}`;
      const bars = parseNasdaqChart(await getJson(url, signal), symbol);
      if (bars.length > 0) return bars;
    } catch {
      if (signal.aborted) return [];
    }
  }
  return [];
}

export async function fetchCnbcChart(symbol: string): Promise<IntradayBar[]> {
  if (!PUBLIC_SYMBOL.test(symbol)) return [];
  try {
    const url = `https://ts-api.cnbc.com/harmony/app/charts/1D.json?symbol=${encodeURIComponent(symbol)}`;
    return parseCnbcChart(await getJson(url, AbortSignal.timeout(REQUEST_TIMEOUT_MS)), symbol);
  } catch {
    return [];
  }
}

/** Nasdaq first; CNBC only when Nasdaq has nothing for the symbol. */
export const fetchSessionIntradayBars: IntradayBarFetcher = async (symbol) => {
  const nasdaq = await fetchNasdaqChart(symbol);
  return nasdaq.length > 0 ? nasdaq : fetchCnbcChart(symbol);
};

/** The last five sessions' 5-minute bars, for the 1W chart's past sessions. */
export const fetchWeekIntradayBars: IntradayBarFetcher = async (symbol) => {
  if (!PUBLIC_SYMBOL.test(symbol)) return [];
  try {
    const url = `https://ts-api.cnbc.com/harmony/app/charts/5D.json?symbol=${encodeURIComponent(symbol)}`;
    return withinWeekdaySessions(parseCnbcChart(await getJson(url, AbortSignal.timeout(REQUEST_TIMEOUT_MS)), symbol, CNBC_WEEK_CHART_SOURCE));
  } catch {
    return [];
  }
};
