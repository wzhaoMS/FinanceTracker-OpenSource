/**
 * The close screen the metals reads value with (design v8 §9 with ROOT's approved delta D-G3-1, 'metals-close-screen-v2').
 * G1d's `metalsScreenCloses` measures each bar against the median of up to 5 earlier *admissible* closes, so a refused
 * bar never enters a later median: after a genuine move of more than 20% every later bar would be refused for good and
 * the page would stay `price-stale`. Here:
 *
 * - **valid**: a real day before today in New York, one close for its date (identical closes count once; two different
 *   ones refuse the date, `bar-conflict`), finite and positive, and inside its metal's static plausibility band;
 * - **band (guard 1)**: absolute US-dollar bounds per metal (METALS_PLAUSIBLE_CLOSES). A bar outside them is refused
 *   (`out-of-band`) whatever the median says and never enters a median, so a sustained fixed-offset feed error (a unit
 *   or currency change) is refused indefinitely instead of healing after about 3 bars;
 * - **admissible**: valid, and within 20% of the median of up to 5 earlier *valid* bars, admissible or not; with fewer
 *   than 3 earlier valid bars the check can't run, so the bar is admissible but flagged `thin-history`. A refused bar
 *   keeps its verdict (`outlier`) yet counts in later medians: a one-bar spike is still refused, and a real level shift
 *   is refused for at most about 3 bars, then heals;
 * - **level shifts (guard 2)**: each run of `outlier` refusals is reported with its first refused date and the first
 *   close admitted after it (none while it runs), when that close stands more than 20% from the median the run started
 *   against: a one-bar spike back to the old level is not a level shift.
 *
 * Valuation takes the last admissible close on or before the day valued, with its date (G1d's `metalsCloseOnOrBefore`).
 * Isolated so that the rule is one line to swap if ROOT rules otherwise. Pure: no file system, network or clock.
 */

import {
  METALS_PRICE_MAX_DEVIATION,
  METALS_PRICE_MEDIAN_WINDOW,
  METALS_PRICE_MIN_HISTORY,
  add,
  compare,
  divide,
  equals,
  multiply,
  parseRational,
  rational,
  subtract,
  type Metal,
  type MetalsAdmissibleClose,
  type MetalsPriceBar,
  type Rational,
} from '@finance-tracker/shared/metals-ledger';

export const METALS_CLOSE_SCREEN = 'metals-close-screen-v2' as const;

/**
 * Static plausibility bands, US dollars per troy ounce (guard 1), reviewed in the PR. A bar outside its metal's band
 * is refused whatever the median says. What a band catches, exactly: a close that comes 31.1035 times too high (a gram
 * to troy ounce unit slip) lands above `max` only when the true close exceeds max ÷ 31.1035, and one that comes 31.1035
 * times too low (a price per gram) lands below `min` only when the true close is under min × 31.1035. So a band
 * catches both slips only for true closes inside (max ÷ 31.1035, min × 31.1035):
 *
 *   XAU about 804 – 7,775;  XAG about 6.43 – 93.3;  XPT about 322 – 6,220;  XPD about 386 – 3,732.
 *
 * Gold's, silver's and palladium's closes in late 2026 sit well inside those ranges, and platinum's last daily closes
 * from this source did too; a metal whose price leaves its range needs its band reviewed again.
 */
export const METALS_PLAUSIBLE_CLOSES: Readonly<Record<Metal, { min: string; max: string }>> = Object.freeze({
  XAU: { min: '250', max: '25000' },
  XAG: { min: '3', max: '200' },
  XPT: { min: '200', max: '10000' },
  XPD: { min: '120', max: '12000' },
});

export type MetalsCloseRefusal = 'incomplete' | 'unreadable' | 'bar-conflict' | 'out-of-band' | 'outlier';

/** A run of `outlier` refusals: its first refused date, and the first close admitted after it (null while it runs). */
export interface MetalsLevelShift {
  movedOn: string;
  admittedOn: string | null;
}

export interface MetalsCloseScreenV2 {
  admissible: MetalsAdmissibleClose[];
  refused: Array<{ date: string; reason: MetalsCloseRefusal }>;
  levelShifts: MetalsLevelShift[];
}

function readClose(text: string): Rational | null {
  if (typeof text !== 'string' || !/^\d{1,7}(?:\.\d{1,6})?$/.test(text)) return null;
  const value = parseRational(text);
  return value !== null && value.num > 0n ? value : null;
}

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

/** Whether `value` stands more than 20% from `middle`. */
function beyond(value: Rational, middle: Rational): boolean {
  const deviation = subtract(value, middle);
  const magnitude = deviation.num < 0n ? rational(-deviation.num, deviation.den) : deviation;
  return compare(magnitude, multiply(middle, METALS_PRICE_MAX_DEVIATION)) > 0;
}

/** Screens a metal's bars, in date order, against `todayNewYork` (YYYY-MM-DD). Deterministic in its inputs. */
export function metalsScreenClosesV2(metal: Metal, bars: readonly MetalsPriceBar[], todayNewYork: string): MetalsCloseScreenV2 {
  return metalsScreenClosesWithGuards(metal, bars, todayNewYork, { bands: true, levelShifts: true });
}

/**
 * The screen with its two guards switchable: only tests turn one off, to show that its own test fails without it (the
 * mutants ROOT asked for). Production always runs both (metalsScreenClosesV2).
 */
export function metalsScreenClosesWithGuards(
  metal: Metal,
  bars: readonly MetalsPriceBar[],
  todayNewYork: string,
  guards: { bands: boolean; levelShifts: boolean },
): MetalsCloseScreenV2 {
  const band = METALS_PLAUSIBLE_CLOSES[metal];
  const low = parseRational(band.min)!;
  const high = parseRational(band.max)!;
  const byDate = new Map<string, Array<Rational | null>>();
  for (const bar of bars) {
    const closes = byDate.get(bar.date) ?? [];
    const value = readClose(bar.close);
    if (value === null ? !closes.includes(null) : !closes.some((close) => close !== null && equals(close, value))) closes.push(value);
    byDate.set(bar.date, closes);
  }
  const valid: Rational[] = [];
  const admissible: MetalsAdmissibleClose[] = [];
  const refused: MetalsCloseScreenV2['refused'] = [];
  const levelShifts: MetalsLevelShift[] = [];
  let run: { movedOn: string; against: Rational } | null = null;
  for (const date of [...byDate.keys()].sort()) {
    const closes = byDate.get(date)!;
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
    const close = closes[0];
    if (close === null) {
      refused.push({ date, reason: 'unreadable' });
      continue;
    }
    if (guards.bands && (compare(close, low) < 0 || compare(close, high) > 0)) {
      refused.push({ date, reason: 'out-of-band' });
      continue;
    }
    const previous = valid.slice(-METALS_PRICE_MEDIAN_WINDOW);
    valid.push(close);
    if (previous.length < METALS_PRICE_MIN_HISTORY) {
      admissible.push({ date, close, thinHistory: true });
      continue;
    }
    const middle = median(previous);
    if (beyond(close, middle)) {
      refused.push({ date, reason: 'outlier' });
      if (run === null) run = { movedOn: date, against: middle };
      continue;
    }
    if (run !== null) {
      if (guards.levelShifts && beyond(close, run.against)) levelShifts.push({ movedOn: run.movedOn, admittedOn: date });
      run = null;
    }
    admissible.push({ date, close, thinHistory: false });
  }
  if (guards.levelShifts && run !== null) levelShifts.push({ movedOn: run.movedOn, admittedOn: null });
  return { admissible, refused, levelShifts };
}
