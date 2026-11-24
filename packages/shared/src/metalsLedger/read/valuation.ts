/**
 * Valuation at spot (design v8 §9), the pure part: which daily close may value a date, and the value itself. Fetching
 * and caching bars is the read side's (G3).
 *
 * - A bar's date is its New York trading day; a bar is complete only when its date is before today's date in New York.
 * - Admissible: complete, a real date, a finite positive close, one close for its date (two different closes refuse the
 *   date, `bar-conflict`; identical ones count once), and within 20% of the median of up to 5 previous admissible
 *   closes; with fewer than 3 previous closes the check can't run, so the bar is admissible but flagged
 *   `thin-history`. A refused bar never enters a later median.
 * - The close for a date t is the last admissible close dated on or before t, never a later one, shown with its date.
 *   Older than 5 weekdays before t it is `price-stale`; none at all is `price-missing`.
 * - Estimated value at spot = round(exact troy oz × close) once, half to even; parts by largest remainder over the
 *   parts' exact ounces (metalsValueParts).
 *
 * Pure: no file system, network or clock.
 */

import {
  add,
  compare,
  divide,
  formatRational,
  largestRemainder,
  multiply,
  parseRational,
  rational,
  roundToInteger,
  subtract,
  sum,
  type Rational,
} from '../rational.js';

export const METALS_PRICE_SOURCE = 'cnbc-spot-daily' as const;
/** The cache symbol for a metal's daily closes: never a ticker, so symbol answers don't change. */
export const metalsPriceSymbol = (metal: string) => `holdr:metal:${metal}`;
export const METALS_PRICE_MAX_DEVIATION = rational(1n, 5n);
export const METALS_PRICE_MEDIAN_WINDOW = 5;
export const METALS_PRICE_MIN_HISTORY = 3;
export const METALS_PRICE_STALE_WEEKDAYS = 5;

/** A daily bar as fetched: its New York date and its close in US dollars per troy ounce, as written. */
export interface MetalsPriceBar {
  date: string;
  close: string;
}

export interface MetalsAdmissibleClose {
  date: string;
  /** US dollars per troy ounce, exact. */
  close: Rational;
  thinHistory: boolean;
}

export interface MetalsCloseScreen {
  admissible: MetalsAdmissibleClose[];
  /** Dates refused, each with why. */
  refused: Array<{ date: string; reason: 'incomplete' | 'unreadable' | 'bar-conflict' | 'outlier' }>;
}

/** A close as written: an unsigned decimal ("2650.4", "29.105"), finite and positive. */
function readClose(text: string): Rational | null {
  if (typeof text !== 'string' || !/^\d{1,7}(?:\.\d{1,6})?$/.test(text)) return null;
  const value = parseRational(text);
  return value !== null && value.num > 0n ? value : null;
}

/** A real calendar day written YYYY-MM-DD. */
function isDay(text: string): boolean {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const time = Date.parse(`${text}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === text;
}

function median(values: readonly Rational[]): Rational {
  const sorted = [...values].sort(compare);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : divide(add(sorted[middle - 1], sorted[middle]), rational(2n));
}

/** Screens a series' bars, in date order, against `todayNewYork` (YYYY-MM-DD). Deterministic in its inputs. */
export function metalsScreenCloses(bars: readonly MetalsPriceBar[], todayNewYork: string): MetalsCloseScreen {
  const byDate = new Map<string, Set<string>>();
  for (const bar of bars) {
    const closes = byDate.get(bar.date) ?? new Set<string>();
    const value = readClose(bar.close);
    closes.add(value === null ? `!${bar.close}` : formatRational(value));
    byDate.set(bar.date, closes);
  }
  const admissible: MetalsAdmissibleClose[] = [];
  const refused: MetalsCloseScreen['refused'] = [];
  for (const date of [...byDate.keys()].sort()) {
    const closes = [...byDate.get(date)!];
    if (!isDay(date)) {
      refused.push({ date, reason: 'unreadable' });
      continue;
    }
    if (date >= todayNewYork) {
      refused.push({ date, reason: 'incomplete' });
      continue;
    }
    if (closes.length > 1) {
      refused.push({ date, reason: 'bar-conflict' });
      continue;
    }
    if (closes[0].startsWith('!')) {
      refused.push({ date, reason: 'unreadable' });
      continue;
    }
    const [num, den] = closes[0].split('/').map(BigInt);
    const close = rational(num, den);
    const previous = admissible.slice(-METALS_PRICE_MEDIAN_WINDOW).map((entry) => entry.close);
    if (previous.length < METALS_PRICE_MIN_HISTORY) {
      admissible.push({ date, close, thinHistory: true });
      continue;
    }
    const middle = median(previous);
    const deviation = subtract(close, middle);
    const magnitude = deviation.num < 0n ? rational(-deviation.num, deviation.den) : deviation;
    if (compare(magnitude, multiply(middle, METALS_PRICE_MAX_DEVIATION)) > 0) {
      refused.push({ date, reason: 'outlier' });
      continue;
    }
    admissible.push({ date, close, thinHistory: false });
  }
  return { admissible, refused };
}

/** The last admissible close dated on or before `date`, or null. */
export function metalsCloseOnOrBefore(admissible: readonly MetalsAdmissibleClose[], date: string): MetalsAdmissibleClose | null {
  let found: MetalsAdmissibleClose | null = null;
  for (const entry of admissible) {
    if (entry.date > date) break;
    found = entry;
  }
  return found;
}

/** Weekdays strictly after `from` up to and including `to`. */
export function metalsWeekdaysBetween(from: string, to: string): number {
  let count = 0;
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let day = Date.parse(`${from}T00:00:00Z`) + 86_400_000; day <= end; day += 86_400_000) {
    const weekday = new Date(day).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
}

/** Whether a close dated `closeDate` is stale for valuing `date`: more than 5 weekdays older. */
export const metalsPriceStale = (closeDate: string, date: string) => metalsWeekdaysBetween(closeDate, date) > METALS_PRICE_STALE_WEEKDAYS;

/** Estimated value at spot in cents: round(exact troy oz × close in dollars × 100) once, half to even. */
export function metalsValueMinor(fineTroyOz: Rational, close: Rational): number {
  const cents = roundToInteger(multiply(multiply(fineTroyOz, close), rational(100n)));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('metalsValueMinor: value out of range');
  return Number(cents);
}

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));

/**
 * The value of a holding and of its parts at one close: the total once, round(Σ oz × close), then split over the parts
 * in proportion to their exact troy ounces by largest remainder, ties to the lower index, so the parts always add up to
 * the total. Ounces must not be negative.
 */
export function metalsValueParts(parts: readonly Rational[], close: Rational): { totalMinor: number; partsMinor: number[] } {
  if (parts.some((part) => part.num < 0n)) throw new RangeError('metalsValueParts: negative troy ounces');
  const totalMinor = metalsValueMinor(sum(parts), close);
  if (parts.every((part) => part.num === 0n)) return { totalMinor, partsMinor: parts.map(() => 0) };
  const common = parts.reduce((den, part) => (den / gcd(den, part.den)) * part.den, 1n);
  const weights = parts.map((part) => part.num * (common / part.den));
  return { totalMinor, partsMinor: largestRemainder(BigInt(totalMinor), weights).map(Number) };
}

/**
 * A cycle's decomposition by spot (§4.4.3): premium paid per troy ounce over the purchase-day spot (known only with a
 * complete cost), the sale premium over the sale's spot, the part of the result from the spot price's change,
 * round(Δspot × oz) once, and the part from premiums and fees. Each is null when an input it needs is unknown, never
 * zero. Cents per troy ounce are rounded once, half to even, for display.
 */
export function metalsCycleBySpot(input: {
  fineTroyOz: Rational;
  costMinor: number;
  costComplete: boolean;
  proceedsMinor: number;
  profitMinor: number | null;
  purchaseSpot: Rational | null;
  saleSpot: Rational | null;
}): { premiumPaidPerOzMinor: number | null; salePremiumPerOzMinor: number | null; fromSpotMinor: number | null; fromPremiumsMinor: number | null } {
  if (input.fineTroyOz.num <= 0n) throw new RangeError('metalsCycleBySpot: fine troy ounces must be positive');
  const perOz = (minor: number) => divide(rational(BigInt(minor)), input.fineTroyOz);
  const spotMinor = (spot: Rational) => multiply(spot, rational(100n));
  const premiumPaid = input.purchaseSpot === null || !input.costComplete
    ? null : Number(roundToInteger(subtract(perOz(input.costMinor), spotMinor(input.purchaseSpot))));
  const salePremium = input.saleSpot === null ? null : Number(roundToInteger(subtract(perOz(input.proceedsMinor), spotMinor(input.saleSpot))));
  const fromSpot = input.purchaseSpot === null || input.saleSpot === null
    ? null : Number(roundToInteger(multiply(subtract(spotMinor(input.saleSpot), spotMinor(input.purchaseSpot)), input.fineTroyOz)));
  const fromPremiums = fromSpot === null || input.profitMinor === null ? null : input.profitMinor - fromSpot;
  return { premiumPaidPerOzMinor: premiumPaid, salePremiumPerOzMinor: salePremium, fromSpotMinor: fromSpot, fromPremiumsMinor: fromPremiums };
}
