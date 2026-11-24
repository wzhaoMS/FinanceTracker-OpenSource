/**
 * Calendar helpers for the cash plan. Every household date is an America/New_York date, and "a date" used as a bound
 * means the end of that Eastern day (23:59:59.999 ET).
 */

export const CASH_PLAN_TIME_ZONE = 'America/New_York';
export const DAY_MS = 86_400_000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/** A real calendar date written YYYY-MM-DD. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** A real UTC instant written YYYY-MM-DDTHH:MM:SS(.mmm)Z. */
export function isUtcInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !INSTANT.test(value)) return false;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return false;
  const iso = new Date(time).toISOString();
  return value.length === 24 ? iso === value : iso === `${value.slice(0, 19)}.000Z`;
}

/** The instant in its stored form, with milliseconds. */
export function canonicalInstant(value: string): string {
  return new Date(Date.parse(value)).toISOString();
}

/** Days since 1970-01-01 of a YYYY-MM-DD date. */
export function dayNumber(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / DAY_MS;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round(dayNumber(to) - dayNumber(from));
}

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: CASH_PLAN_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function wallClock(ms: number): { date: string; hour: number; minute: number } {
  const parts: Record<string, string> = {};
  for (const part of PARTS.formatToParts(new Date(ms))) parts[part.type] = part.value;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}

const startCache = new Map<string, number>();

/** The UTC instant (ms) of Eastern midnight starting `date`. DST changes at 02:00, so midnight is always unambiguous. */
export function startOfEasternDay(date: string): number {
  const cached = startCache.get(date);
  if (cached !== undefined) return cached;
  const base = Date.parse(`${date}T00:00:00Z`);
  for (const offsetHours of [5, 4]) {
    const ms = base + offsetHours * 3_600_000;
    const clock = wallClock(ms);
    if (clock.date === date && clock.hour === 0 && clock.minute === 0) {
      if (startCache.size > 20_000) startCache.clear();
      startCache.set(date, ms);
      return ms;
    }
  }
  throw new Error('no Eastern midnight for that date');
}

/** The last millisecond of the Eastern day `date`: 23:59:59.999 ET. */
export function endOfEasternDay(date: string): number {
  return startOfEasternDay(addDays(date, 1)) - 1;
}

/** The household (Eastern) date of an instant. */
export function easternDate(instant: string | number | Date): string {
  const ms = instant instanceof Date ? instant.getTime() : typeof instant === 'number' ? instant : Date.parse(instant);
  if (!Number.isFinite(ms)) throw new Error('not an instant');
  // Eastern time is UTC-5 or UTC-4: five hours back is the Eastern date or the day before it.
  const guess = new Date(ms - 5 * 3_600_000).toISOString().slice(0, 10);
  const next = addDays(guess, 1);
  return ms >= startOfEasternDay(next) ? next : guess;
}
