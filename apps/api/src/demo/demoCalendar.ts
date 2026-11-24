import { createHash } from 'node:crypto';

/**
 * Dates and seeded randomness for the demo household's builders. Every random stream is seeded from a label, so the
 * same label gives the same numbers on every run; labels name calendar dates (a month, a benefit period) rather than
 * the day the demo is made, so the past looks the same whichever day the demo is seeded again.
 */

export const DAY_MS = 86_400_000;

/** mulberry32 over a seed derived from `label`. */
export function seededRandom(label: string): () => number {
  let state = createHash('sha256').update(label).digest().readUInt32BE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A whole number from `low` to `high` (inclusive) drawn from `next`. */
export function pickBetween(next: () => number, low: number, high: number): number {
  return low + Math.floor(next() * (high - low + 1));
}

export const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Whole days from `from` to `to` (YYYY-MM-DD), negative when `to` comes first. */
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** `month` (YYYY-MM) moved by `delta` months. */
export function addMonths(month: string, delta: number): string {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + delta;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

export const daysIn = (month: string): number => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

/** Day `day` of `month`, clamped into the month. */
export const dayOf = (month: string, day: number): string => `${month}-${String(Math.min(daysIn(month), Math.max(1, day))).padStart(2, '0')}`;

export const lastDayOf = (month: string): string => dayOf(month, 31);

/** Saturday or Sunday. */
export const isWeekend = (date: string): boolean => [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());

/** `date`, or the weekday before it when it falls on a weekend. */
export function weekdayOnOrBefore(date: string): string {
  let day = date;
  while (isWeekend(day)) day = addDays(day, -1);
  return day;
}

/** The first `length` hex digits of SHA-256 over `text`. */
export const sha256Hex = (text: string, length = 64): string => createHash('sha256').update(text).digest('hex').slice(0, length);
