/**
 * Daily spot closes of the precious metals, for the Gold page's valuation (design v8 §9): CNBC's US-dollar spot series,
 * as dated daily bars. Only a fixed metal symbol and a date range are ever sent: never an account, a quantity or a
 * value. No API key or cookie; a generic desktop-browser User-Agent, as the intraday charts send.
 *
 *   CNBC  GET https://ts-api.cnbc.com/harmony/app/bars/{XAU=|XAG=|XPT=|XPD=}/1D/{from}/{to}/adjusted/EST5EDT.json
 *         {from} and {to} are YYYYMMDD000000 in New York time, {to} exclusive. Each bar's `tradeTime` is its New York
 *         trading day (YYYYMMDDhhmmss, cross-checked against `tradeTimeinMills`), and `close` its close in US dollars
 *         per troy ounce, a decimal string.
 *
 * A redirect is refused, never followed; an answer over 2 MB is not read; and a bar whose epoch is before 1990 or after
 * the day after the request's end is dropped.
 *
 * Fetching is off unless HOLDR_METALS_PRICES=1 (metalsPricesEnabled, read by index.ts from the effective environment, so
 * one holdr.conf line turns it on), and off on disposable e2e stacks; tests seed bars instead.
 * The metals price store (services/metalsRead/prices.ts) decides what is asked for and what is kept.
 */

import type { Metal } from '@finance-tracker/shared/metals-ledger';

import { marketDate } from '../services/symbolHistory.js';

/**
 * Whether this Holdr fetches daily spot closes: exactly `HOLDR_METALS_PRICES=1`, from holdr.conf (which takes only `0` or
 * `1`) or the environment. Anything else, unset included, is off.
 */
export const metalsPricesEnabled = (env: NodeJS.ProcessEnv): boolean => env.HOLDR_METALS_PRICES === '1';

export const METAL_SPOT_SOURCE = 'cnbc-spot-daily' as const;
/** CNBC's US-dollar spot series per metal: a closed list, never caller input. */
export const METAL_SPOT_SYMBOLS: Readonly<Record<Metal, string>> = Object.freeze({ XAU: 'XAU=', XAG: 'XAG=', XPT: 'XPT=', XPD: 'XPD=' });

/** A daily bar as fetched: its New York trading day and its close in US dollars per troy ounce, normalized decimal text. */
export interface MetalSpotBar {
  date: string;
  close: string;
}

/** The bars dated `from` to `to` (inclusive YYYY-MM-DD) of one metal, or null when the provider gave nothing readable. */
export type MetalSpotBarFetcher = (metal: Metal, from: string, to: string) => Promise<MetalSpotBar[] | null>;

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 8_000;
/** The most of an answer that is read: anything larger is no readable answer. */
export const METAL_SPOT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** The earliest epoch a bar may carry, a sanity bound: an earlier one is unreadable. */
const EARLIEST_BAR_MS = Date.UTC(1990, 0, 1);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A close as CNBC writes it: an unsigned decimal of at most 7 whole and 6 fractional digits. */
const CLOSE = /^\d{1,7}(?:\.\d{1,6})?$/;

function realDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

const stamp = (date: string) => `${date.replace(/-/g, '')}000000`;

/** The request for one metal's bars dated `from` to `to`, both inclusive (CNBC's end is exclusive). */
export function cnbcDailyBarsUrl(metal: Metal, from: string, to: string): string {
  const symbol = METAL_SPOT_SYMBOLS[metal];
  if (!symbol || !realDate(from) || !realDate(to) || from > to) throw new RangeError('cnbcDailyBarsUrl: a metal and a date range');
  return `https://ts-api.cnbc.com/harmony/app/bars/${symbol}/1D/${stamp(from)}/${stamp(addDays(to, 1))}/adjusted/EST5EDT.json`;
}

/** A close read exactly: the decimal as a number prints back the same (at most 13 significant digits). */
function readClose(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  if (!CLOSE.test(text)) return null;
  const close = Number(text);
  return close > 0 ? String(close) : null;
}

/**
 * Pure parser for CNBC's bars payload of a request ending `to` (inclusive YYYY-MM-DD): one bar per readable entry, in
 * the order given. An entry whose trading day or close can't be read is dropped, as is one whose epoch, when given,
 * can't be read, is before 1990 or after the day after `to`, or falls on another New York day than its trading day;
 * null when the payload has no bar list at all.
 */
export function parseCnbcDailyBars(json: unknown, to: string): MetalSpotBar[] | null {
  if (!realDate(to)) throw new RangeError('parseCnbcDailyBars: the request\'s end date');
  const latestMs = Date.parse(`${addDays(to, 2)}T00:00:00Z`);
  const priceBars = (json as { barData?: { priceBars?: unknown } | null } | null)?.barData?.priceBars;
  if (!Array.isArray(priceBars)) return null;
  const bars: MetalSpotBar[] = [];
  for (const entry of priceBars as Array<{ tradeTime?: unknown; tradeTimeinMills?: unknown; close?: unknown } | null>) {
    const tradeTime = entry?.tradeTime;
    if (typeof tradeTime !== 'string' || !/^\d{14}$/.test(tradeTime)) continue;
    const date = `${tradeTime.slice(0, 4)}-${tradeTime.slice(4, 6)}-${tradeTime.slice(6, 8)}`;
    if (!realDate(date)) continue;
    const epoch = entry?.tradeTimeinMills;
    if (epoch !== undefined && epoch !== null) {
      const millis = typeof epoch === 'number' ? epoch : typeof epoch === 'string' && /^\d{1,15}$/.test(epoch) ? Number(epoch) : Number.NaN;
      if (!Number.isFinite(millis) || millis < EARLIEST_BAR_MS || millis >= latestMs || marketDate(new Date(millis)) !== date) continue;
    }
    const close = readClose(entry?.close);
    if (close === null) continue;
    bars.push({ date, close });
  }
  return bars;
}

/** The answer's text, or null when it declares or runs past `max` bytes: reading stops there. */
async function readCapped(response: Response, max: number): Promise<string | null> {
  if (Number(response.headers.get('content-length')) > max) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return new TextDecoder().decode(Buffer.concat(chunks, total));
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
}

/** One request for one metal's daily closes; null on any failure (the caller retries later, never sooner than its throttle). */
export const fetchMetalSpotDailyBars: MetalSpotBarFetcher = async (metal, from, to) => {
  let url: string;
  try {
    url = cnbcDailyBarsUrl(metal, from, to);
  } catch {
    return null;
  }
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const text = await readCapped(response, METAL_SPOT_MAX_RESPONSE_BYTES);
    if (text === null) return null;
    const bars = parseCnbcDailyBars(JSON.parse(text), to);
    return bars === null ? null : bars.filter((bar) => bar.date >= from && bar.date <= to);
  } catch {
    return null;
  }
};
