/**
 * What the metals ledger's capture readers share (walmartCapture.ts, collectpureCapture.ts): an issue list, and readers
 * of parsed JSON by shape. Pure: no file system, network or clock.
 *
 * An issue names a JSON path and the rule broken, never a value: a path is built from schema keys and array indices
 * only, and every message is fixed text that names at most a bound. A read collects every issue it can find, up to
 * CAPTURE_MAX_ISSUES, and returns no record at all when it found one.
 */

export interface CaptureIssue {
  /** `$` is the file's root and `$.orders[3].groups[0].items[1].qty` a field in it; a reader's own argument is named bare. */
  path: string;
  /** The rule the value broke, as fixed text. */
  message: string;
}

/** A read lists at most this many issues. When there are more, the last entry says so, at `$`, and reading stops. */
export const CAPTURE_MAX_ISSUES = 200;
/** No amount is larger than this many cents (a hundred million dollars). */
export const CAPTURE_MAX_MINOR = 10_000_000_000;
/** The most records a file's top-level list holds. */
export const CAPTURE_MAX_RECORDS = 100_000;
/** The most entries any list within a record holds. */
export const CAPTURE_MAX_ENTRIES = 5_000;
/** The longest text a reader takes. */
export const CAPTURE_MAX_TEXT = 4_000;
/** The largest count or quantity a reader takes. */
export const CAPTURE_MAX_COUNT = 10_000_000;
/** The rule money text breaks when displayedCents can't read it. */
export const CAPTURE_MONEY_TEXT_RULE = 'must be money text: digits with an optional $, commas, minus sign and two decimals, or Free';

export type CaptureRead<T> = { ok: true; value: T } | { ok: false; issues: CaptureIssue[] };

/** A value parsed from JSON, kept as stated where the schema doesn't type it. */
export type CaptureJson = null | boolean | number | string | CaptureJson[] | { [key: string]: CaptureJson };

export type Rec = Record<string, unknown>;
export const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);
/** Absent from the file, or null: all a nullable field may be when it states nothing. */
export const isAbsent = (value: unknown): value is null | undefined => value === undefined || value === null;

/** The issue list is full: reading stops. */
class IssueLimit extends Error {}
/** A structure that can't be read: its issue is listed, and the rest of the record it is in isn't read. */
class Skip extends Error {}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;
const STAMP = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?([Zz]|[+-]\d{2}(?::?\d{2})?)$/;
const LAST4 = /^[0-9]{4}$/;
const DECIMAL = /^\s*-?\d{1,15}(?:\.\d{1,9})?\s*$/;

function daysIn(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

const isCalendarDate = (year: number, month: number, day: number) =>
  year >= 1900 && year <= 2199 && month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month);

/** A real calendar date written `YYYY-MM-DD`, from 1900 to 2199. */
export function isCaptureDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE.exec(value);
  return match !== null && isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

/**
 * An ISO 8601 date and time with a zone (`Z`, `+05:30`, `-0800`) as its UTC instant, `YYYY-MM-DDTHH:MM:SS.sssZ`, so two
 * spellings of one instant read alike. Digits finer than a millisecond are dropped. Null for anything else.
 */
export function canonicalStamp(text: string): string | null {
  const match = STAMP.exec(text);
  if (match === null) return null;
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number);
  const second = Number(match[6] ?? '0');
  if (!isCalendarDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;
  let offsetMinutes = 0;
  const zone = match[8];
  if (zone !== 'Z' && zone !== 'z') {
    const digits = zone.slice(1).replace(':', '');
    const hours = Number(digits.slice(0, 2));
    const minutes = digits.length > 2 ? Number(digits.slice(2)) : 0;
    if (hours > 23 || minutes > 59) return null;
    offsetMinutes = (zone.startsWith('-') ? -1 : 1) * (hours * 60 + minutes);
  }
  const millis = Number((match[7] ?? '').padEnd(3, '0').slice(0, 3));
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis) - offsetMinutes * 60_000).toISOString();
}

const noNegativeZero = (value: number) => (value === 0 ? 0 : value);

/**
 * Cents from money as a page shows it ('$1,234.56', '-$1.00', '$-1.00', 'Free'): `$`, `,` and spaces are dropped, a
 * minus before or after the `$` makes it negative, and `Free` is zero. Null when the text is none of those.
 */
export function displayedCents(text: string): number | null {
  const trimmed = text.trim();
  if (/^free$/i.test(trimmed)) return 0;
  const match = /^(-?)(\d{1,15})(?:\.(\d{1,2}))?$/.exec(trimmed.replace(/[$,\s]/g, ''));
  if (match === null) return null;
  const cents = Number(match[2]) * 100 + Number((match[3] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents > CAPTURE_MAX_MINOR) return null;
  return noNegativeZero(match[1] === '-' ? -cents : cents);
}

/** Cents from a number of dollars, rounded to the nearest cent; null when it isn't a finite amount in range. */
export function dollarCents(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const cents = Math.round(value * 100);
  return Math.abs(cents) > CAPTURE_MAX_MINOR ? null : noNegativeZero(cents);
}

/**
 * Reads one file. Each check lists an issue at its path and returns a stand-in, so the checks after it still run; a
 * structure that can't be read skips the rest of the record it is in. The stand-ins never leave: a read with an issue
 * returns its issues only.
 */
export class CaptureReader {
  readonly issues: CaptureIssue[] = [];

  /** Lists an issue. Past CAPTURE_MAX_ISSUES the last entry says there are more, and reading stops. */
  fail(path: string, message: string): void {
    if (this.issues.length < CAPTURE_MAX_ISSUES) {
      this.issues.push({ path, message });
      return;
    }
    this.issues[CAPTURE_MAX_ISSUES - 1] = { path: '$', message: `has more issues than the ${CAPTURE_MAX_ISSUES - 1} listed` };
    throw new IssueLimit();
  }

  /** Lists an issue and stops reading the record it is in. */
  skip(path: string, message: string): never {
    this.fail(path, message);
    throw new Skip();
  }

  /** Reads a part of a record; when its structure can't be read, the rest of the record still is, with `fallback` for it. */
  guard<T>(fallback: T, read: () => T): T {
    try {
      return read();
    } catch (error) {
      if (error instanceof Skip) return fallback;
      throw error;
    }
  }

  object(value: unknown, path: string): Rec {
    if (value === undefined) this.skip(path, 'is missing');
    if (!isRecord(value)) this.skip(path, 'must be an object');
    return value;
  }

  optObject(value: unknown, path: string): Rec | null {
    return isAbsent(value) ? null : this.object(value, path);
  }

  array(value: unknown, path: string, max: number): unknown[] {
    if (value === undefined) this.skip(path, 'is missing');
    if (!Array.isArray(value)) this.skip(path, 'must be an array');
    if (value.length > max) this.skip(path, `must have at most ${max} entries`);
    return value;
  }

  /** Each entry read; an entry whose structure can't be read is left out, its issue listed. */
  list<T>(value: unknown, path: string, max: number, read: (entry: unknown, at: string) => T): T[] {
    const entries = this.array(value, path, max);
    const out: T[] = [];
    entries.forEach((entry, index) => {
      try {
        out.push(read(entry, `${path}[${index}]`));
      } catch (error) {
        if (!(error instanceof Skip)) throw error;
      }
    });
    return out;
  }

  /** As `list`, where an absent or null list is empty. */
  optList<T>(value: unknown, path: string, max: number, read: (entry: unknown, at: string) => T): T[] {
    return isAbsent(value) ? [] : this.list(value, path, max, read);
  }

  string(value: unknown, path: string): string {
    if (value === undefined) {
      this.fail(path, 'is missing');
      return '';
    }
    if (typeof value !== 'string') {
      this.fail(path, 'must be a string');
      return '';
    }
    if (value.length > CAPTURE_MAX_TEXT) {
      this.fail(path, `must be at most ${CAPTURE_MAX_TEXT} characters`);
      return '';
    }
    return value;
  }

  optString(value: unknown, path: string): string | null {
    return isAbsent(value) ? null : this.string(value, path);
  }

  boolean(value: unknown, path: string): boolean {
    if (value === undefined) this.fail(path, 'is missing');
    else if (typeof value !== 'boolean') this.fail(path, 'must be true or false');
    return value === true;
  }

  optBoolean(value: unknown, path: string): boolean | null {
    return isAbsent(value) ? null : this.boolean(value, path);
  }

  integer(value: unknown, path: string, min: number, max: number): number {
    if (value === undefined) {
      this.fail(path, 'is missing');
      return min;
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
      this.fail(path, `must be an integer from ${min} to ${max}`);
      return min;
    }
    return noNegativeZero(value);
  }

  optInteger(value: unknown, path: string, min: number, max: number): number | null {
    return isAbsent(value) ? null : this.integer(value, path, min, max);
  }

  count(value: unknown, path: string): number {
    return this.integer(value, path, 0, CAPTURE_MAX_COUNT);
  }

  optCount(value: unknown, path: string): number | null {
    return isAbsent(value) ? null : this.count(value, path);
  }

  /** Integer cents. */
  minor(value: unknown, path: string): number {
    return this.integer(value, path, -CAPTURE_MAX_MINOR, CAPTURE_MAX_MINOR);
  }

  optMinor(value: unknown, path: string): number | null {
    return isAbsent(value) ? null : this.minor(value, path);
  }

  /** Cents stated as a number or as numeric text, rounded to a whole cent. */
  roundedMinor(value: unknown, path: string): number {
    if (value === undefined) {
      this.fail(path, 'is missing');
      return 0;
    }
    const number = typeof value === 'number' ? value : typeof value === 'string' && DECIMAL.test(value) ? Number(value) : Number.NaN;
    if (!Number.isFinite(number) || Math.abs(Math.round(number)) > CAPTURE_MAX_MINOR) {
      this.fail(path, 'must be a number of cents');
      return 0;
    }
    return noNegativeZero(Math.round(number));
  }

  oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
    if (value === undefined) {
      this.fail(path, 'is missing');
      return allowed[0];
    }
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
      this.fail(path, 'is not one of the allowed values');
      return allowed[0];
    }
    return value as T;
  }

  optOneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T | null {
    return isAbsent(value) ? null : this.oneOf(value, path, allowed);
  }

  /** A fixed value, such as a schema id; `rule` says what it must be. */
  exact(value: unknown, path: string, expected: string, rule: string): void {
    if (value === undefined) this.fail(path, 'is missing');
    else if (value !== expected) this.fail(path, rule);
  }

  /** The currency, USD in any letter case. */
  usd(value: unknown, path: string): 'USD' {
    if (value === undefined) this.fail(path, 'is missing');
    else if (typeof value !== 'string' || value.toUpperCase() !== 'USD') this.fail(path, 'must be USD');
    return 'USD';
  }

  /** Text or a finite number, kept as stated. */
  textOrNumber(value: unknown, path: string): string | number {
    if (typeof value === 'number' && Number.isFinite(value)) return noNegativeZero(value);
    if (typeof value === 'string') return this.string(value, path);
    this.fail(path, value === undefined ? 'is missing' : 'must be a string or a finite number');
    return '';
  }

  optTextOrNumber(value: unknown, path: string): string | number | null {
    return isAbsent(value) ? null : this.textOrNumber(value, path);
  }

  /** A scalar the schema doesn't type (a flag, a count or a word), kept as stated. */
  scalar(value: unknown, path: string): boolean | number | string | null {
    if (isAbsent(value)) return null;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number' || typeof value === 'string') return this.textOrNumber(value, path);
    this.fail(path, 'must be true, false, a number, a string or null');
    return null;
  }

  /** A native id, stated as text or as a whole number: kept as text. */
  id(value: unknown, path: string): string {
    if (value === undefined) this.fail(path, 'is missing');
    else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
    else if (typeof value === 'string' && value.length > 0 && value.length <= 200) return value;
    else this.fail(path, 'must be text of 1 to 200 characters or a whole number');
    return '';
  }

  optId(value: unknown, path: string): string | null {
    return isAbsent(value) ? null : this.id(value, path);
  }

  /** An id with a stated form; `rule` says what the form is. */
  idOfForm(value: unknown, path: string, form: RegExp, rule: string): string {
    const text = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
    if (text === undefined) this.fail(path, 'is missing');
    else if (typeof text !== 'string' || !form.test(text)) this.fail(path, rule);
    else return text;
    return '';
  }

  /** A card's or an account's last four digits. */
  optLast4(value: unknown, path: string): string | null {
    if (isAbsent(value)) return null;
    if (typeof value !== 'string' || !LAST4.test(value)) {
      this.fail(path, 'must be four digits');
      return null;
    }
    return value;
  }

  date(value: unknown, path: string): string {
    if (value === undefined) this.fail(path, 'is missing');
    else if (!isCaptureDate(value)) this.fail(path, 'must be a real YYYY-MM-DD date');
    else return value;
    return '1900-01-01';
  }

  optDate(value: unknown, path: string): string | null {
    return isAbsent(value) ? null : this.date(value, path);
  }

  /** The date a date and time starts with (its first ten characters): null when absent. */
  datePrefix(value: unknown, path: string): string | null {
    if (isAbsent(value)) return null;
    if (typeof value !== 'string') {
      this.fail(path, 'must be a string');
      return null;
    }
    const day = value.slice(0, 10);
    if (isCaptureDate(day)) return day;
    this.fail(path, 'must start with a real YYYY-MM-DD date');
    return null;
  }

  /** The date a text starts with when it starts `YYYY-MM-DD…`; null when it starts any other way. */
  leadingDate(text: string | null, path: string): string | null {
    if (text === null || !DATE_PREFIX.test(text)) return null;
    const day = text.slice(0, 10);
    if (isCaptureDate(day)) return day;
    this.fail(path, 'must start with a real YYYY-MM-DD date');
    return null;
  }

  /** An ISO 8601 date and time with a zone, as its canonical UTC instant (canonicalStamp). */
  stamp(value: unknown, path: string): string {
    if (value === undefined) this.fail(path, 'is missing');
    else {
      const canonical = typeof value === 'string' ? canonicalStamp(value) : null;
      if (canonical !== null) return canonical;
      this.fail(path, 'must be an ISO 8601 date and time with a time zone');
    }
    return '1900-01-01T00:00:00.000Z';
  }

  optStamp(value: unknown, path: string): string | null {
    return isAbsent(value) ? null : this.stamp(value, path);
  }

  /** A value the schema doesn't type, kept as a copy of its JSON; absent is null. */
  json(value: unknown, path: string): CaptureJson {
    const copy = (entry: unknown, depth: number): CaptureJson => {
      if (entry === null || typeof entry === 'boolean' || typeof entry === 'string') return entry;
      if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
      if (depth < 20 && Array.isArray(entry)) return entry.map((item) => copy(item, depth + 1));
      if (depth < 20 && isRecord(entry)) {
        const out: { [key: string]: CaptureJson } = {};
        for (const [key, item] of Object.entries(entry)) out[key] = copy(item, depth + 1);
        return out;
      }
      throw new Skip();
    };
    if (value === undefined) return null;
    try {
      return copy(value, 0);
    } catch (error) {
      if (!(error instanceof Skip)) throw error;
      this.fail(path, 'must be a JSON value at most 20 levels deep');
      return null;
    }
  }
}

/** Runs one read: its value when it found no issue, else every issue it listed (at most CAPTURE_MAX_ISSUES). */
export function readCapture<T>(read: (reader: CaptureReader) => T): CaptureRead<T> {
  const reader = new CaptureReader();
  let value: { read: T } | null = null;
  try {
    value = { read: read(reader) };
  } catch (error) {
    if (!(error instanceof IssueLimit) && !(error instanceof Skip)) throw error;
  }
  if (value === null || reader.issues.length > 0) return { ok: false, issues: reader.issues };
  return { ok: true, value: value.read };
}

/** `a ?? b ?? …` over a record's keys: the first value stated (neither absent nor null), with its path. */
export function firstStated(record: Rec, keys: readonly string[], at: string): { value: unknown; path: string } {
  for (const key of keys) if (!isAbsent(record[key])) return { value: record[key], path: `${at}.${key}` };
  return { value: null, path: `${at}.${keys[0]}` };
}
