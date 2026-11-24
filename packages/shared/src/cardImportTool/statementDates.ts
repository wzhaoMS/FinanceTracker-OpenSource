/**
 * Calendar arithmetic for the dates an OFX file states about itself (when it
 * was made, where its transaction list ends, when each row posted), so the
 * converter can tell whether the list reaches the day the file was made. The
 * day the file was made is taken in the time zone of the date it is compared
 * with, never by comparing date prefixes written in different zones. Pure
 * integer arithmetic: no clock, no host time zone, no Date.
 */
import type { StatementMoment } from './parsed.js';

/** UTC offsets in use, in minutes: UTC-12 to UTC+14. */
const MIN_OFFSET = -12 * 60;
const MAX_OFFSET = 14 * 60;
const MINUTES_PER_DAY = 24 * 60;

/** Days from 1970-01-01 to a YYYY-MM-DD date (proleptic Gregorian). */
export function dayNumber(date: string): number {
  let year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  year -= month <= 2 ? 1 : 0;
  const era = Math.floor(year / 400);
  const yearOfEra = year - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** The YYYY-MM-DD date `days` after 1970-01-01. */
export function dateOfDay(days: number): string {
  const shifted = days + 719468;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365);
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthIndex = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthIndex + 2) / 5) + 1;
  const month = monthIndex + (monthIndex < 10 ? 3 : -9);
  const year = Math.floor(yearOfEra + era * 400) + (month <= 2 ? 1 : 0);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The calendar dates the moment `made` can fall on in the time zone `other`
 * is written in. One date when both name their offset, or when neither does
 * and both are of one kind (two dates alone, or two times), which an issuer
 * writes in one convention. Otherwise a zone is unknown, and the range holds
 * every date some real offsets (UTC-12 to UTC+14) would give. A date alone
 * stands for any minute of that day.
 */
export function madeOnDates(made: StatementMoment, other: StatementMoment): { first: string; last: string } {
  const midnight = dayNumber(made.date) * MINUTES_PER_DAY;
  const earliest = midnight + (made.time ?? 0);
  const latest = midnight + (made.time ?? MINUTES_PER_DAY - 1);
  let low: number;
  let high: number;
  if (made.offset !== null && other.offset !== null) {
    low = other.offset - made.offset;
    high = low;
  } else if (made.offset === null && other.offset === null && (made.time === null) === (other.time === null)) {
    low = 0;
    high = 0;
  } else {
    low = (other.offset ?? MIN_OFFSET) - (made.offset ?? MAX_OFFSET);
    high = (other.offset ?? MAX_OFFSET) - (made.offset ?? MIN_OFFSET);
  }
  return {
    first: dateOfDay(Math.floor((earliest + low) / MINUTES_PER_DAY)),
    last: dateOfDay(Math.floor((latest + high) / MINUTES_PER_DAY)),
  };
}

/**
 * Whether `value`'s date is on or after the day `made` fell on in `value`'s
 * time zone: `yes` or `no` when every reading agrees, `maybe` when the
 * readings differ.
 */
export function reachesMadeOnDay(value: StatementMoment, made: StatementMoment): 'yes' | 'no' | 'maybe' {
  const { first, last } = madeOnDates(made, value);
  if (value.date >= last) return 'yes';
  if (value.date < first) return 'no';
  return 'maybe';
}

function offsetText(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const size = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(size / 60)).padStart(2, '0')}:${String(size % 60).padStart(2, '0')}`;
}

/** A moment as written, for messages: `2026-10-17 09:30 UTC-04:00`, `2026-10-17 09:30 (no time zone)` or `2026-10-17`. */
export function describeMoment(moment: StatementMoment): string {
  if (moment.time === null) return moment.offset === null ? moment.date : `${moment.date} (${offsetText(moment.offset)})`;
  const clock = `${String(Math.floor(moment.time / 60)).padStart(2, '0')}:${String(moment.time % 60).padStart(2, '0')}`;
  return `${moment.date} ${clock} ${moment.offset === null ? '(no time zone)' : offsetText(moment.offset)}`;
}
