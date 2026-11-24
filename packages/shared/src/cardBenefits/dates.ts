/**
 * Calendar dates for card benefits: `YYYY-MM-DD` strings and whole months,
 * in plain calendar arithmetic (no clock, no time zone). A month is counted
 * from year 0 (`year * 12 + month - 1`), so periods of any length can be
 * aligned to any starting month.
 */

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date written as `YYYY-MM-DD`. */
export function isBenefitDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const pad = (value: number, width: number) => String(value).padStart(width, '0');

/** Months since year 0 of a date's month. */
export function monthNumber(date: string): number {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}

/** The first day of a month numbered by `monthNumber`. */
export function firstDayOfMonth(month: number): string {
  return `${pad(Math.floor(month / 12), 4)}-${pad((month % 12) + 1, 2)}-01`;
}

/** The last day of a month numbered by `monthNumber`. */
export function lastDayOfMonth(month: number): string {
  const year = Math.floor(month / 12);
  const index = month % 12;
  const days = new Date(Date.UTC(year, index + 1, 0)).getUTCDate();
  return `${pad(year, 4)}-${pad(index + 1, 2)}-${pad(days, 2)}`;
}

function epochDay(date: string): number {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 86_400_000;
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round(epochDay(to) - epochDay(from));
}

export function addDays(date: string, days: number): string {
  return new Date((epochDay(date) + days) * 86_400_000).toISOString().slice(0, 10);
}

/** The same day `months` months later, or the month's last day when it is shorter. */
export function addMonths(date: string, months: number): string {
  const month = monthNumber(date) + months;
  const last = lastDayOfMonth(month);
  const day = Math.min(Number(date.slice(8, 10)), Number(last.slice(8, 10)));
  return `${last.slice(0, 8)}${pad(day, 2)}`;
}

export const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
