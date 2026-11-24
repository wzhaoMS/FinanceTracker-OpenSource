// Shared helpers for tool answers: money, percents, masking, dates and the size budget of one answer.

/** A tool argument the model can fix; its message goes back to the model as a tool error. */
export class ToolInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolInputError';
  }
}

/**
 * The largest JSON text one tool answer carries, about 20,000 tokens: under the default limit of the strictest common
 * clients. Longer lists are cut and say so (`truncated`).
 */
export const MAX_OUTPUT_CHARS = 75_000;

// ISO 4217 currencies whose minor unit is not two digits (as packages/shared/src/cardImportTool/amount.ts has them).
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

export function currencyExponent(currency) {
  if (ZERO_DECIMAL.has(currency)) return 0;
  if (THREE_DECIMAL.has(currency)) return 3;
  return 2;
}

/** `value` rounded to `digits` decimals; null for anything that is not a finite number. Never -0. */
export function round(value, digits = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export const money = (value) => round(value, 2);

/** Integer minor units as major units (1234 USD → 12.34); null for a missing amount. */
export function fromMinor(minor, currency = 'USD') {
  if (typeof minor !== 'number' || !Number.isFinite(minor)) return null;
  const exponent = currencyExponent(currency);
  return round(minor / 10 ** exponent, exponent);
}

/** `part` as a percent of `whole`, two decimals; null when the whole is zero or either is unknown. */
export function percentOf(part, whole) {
  if (typeof part !== 'number' || typeof whole !== 'number' || !Number.isFinite(part) || !Number.isFinite(whole) || whole === 0) return null;
  return round((part / whole) * 100, 2);
}

/** A ratio (0.1234) as a percent (12.34). */
export const ratioPercent = (ratio) => (typeof ratio === 'number' && Number.isFinite(ratio) ? round(ratio * 100, 2) : null);

/** `$1,234.56` for summaries. */
export function formatMoney(value, currency = 'USD') {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'unknown';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

/** An account number as `***` and its last four letters or digits; null when there is none. */
export function maskAccountNumber(value) {
  if (typeof value !== 'string') return null;
  const characters = value.replace(/[^A-Za-z0-9]/g, '');
  return characters ? `***${characters.slice(-4)}` : null;
}

/**
 * Free text (names, descriptions, merchants, notes) with every run of six or more digits cut to its last four, so an
 * account, reference or phone number that found its way into a description is never repeated in full.
 */
export function maskDigits(text) {
  return text.replace(/\d{6,}/g, (run) => `***${run.slice(-4)}`);
}

/** Text for an answer: one line, long digit runs masked, at most `max` characters; null when empty or not text. */
export function cleanText(value, max = 160) {
  if (typeof value !== 'string') return null;
  const flat = maskDigits(value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim());
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/* ------------------------------------------------------------------ */
/* Dates                                                              */
/* ------------------------------------------------------------------ */

const pad = (value) => String(value).padStart(2, '0');

/** This computer's calendar date, as Holdr's web app and API use it. */
export function localDate(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function addDays(date, days) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/** `YYYY-MM` moved by `months`. */
export function addMonths(month, months) {
  const [year, number] = month.split('-').map(Number);
  const index = year * 12 + (number - 1) + months;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}

/** The first and last day of a `YYYY-MM` month. */
export function monthBounds(month) {
  const [year, number] = month.split('-').map(Number);
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${pad(last)}` };
}

export const PERIODS = Object.freeze([
  'this-month', 'last-month', 'last-30-days', 'last-90-days', 'last-12-months', 'this-year', 'last-year', 'all-time',
]);

/**
 * The date range a tool's `period`, `month`, or `from`/`to` arguments name, as of `today`: `{ from, to, label }` with either
 * end null when open, or null for all time. One way of naming it at a time.
 */
export function resolveDateRange({ period, month, from, to } = {}, today = localDate()) {
  const ways = [period !== undefined, month !== undefined, from !== undefined || to !== undefined].filter(Boolean).length;
  if (ways > 1) throw new ToolInputError('give one of period, month, or from/to, not several');
  if (from !== undefined || to !== undefined) {
    for (const [name, value] of [['from', from], ['to', to]]) {
      if (value !== undefined && !isIsoDate(value)) throw new ToolInputError(`${name} must be a real date, YYYY-MM-DD`);
    }
    if (from !== undefined && to !== undefined && from > to) throw new ToolInputError('from must not be after to');
    return { from: from ?? null, to: to ?? null, label: `${from ?? 'the beginning'} to ${to ?? 'now'}` };
  }
  if (month !== undefined) return { ...monthBounds(month), label: month };
  const thisMonth = today.slice(0, 7);
  switch (period) {
    case undefined:
    case 'all-time':
      return null;
    case 'this-month':
      return { from: `${thisMonth}-01`, to: today, label: `this month (${thisMonth}, to date)` };
    case 'last-month': {
      const month = addMonths(thisMonth, -1);
      return { ...monthBounds(month), label: `last month (${month})` };
    }
    case 'last-30-days':
      return { from: addDays(today, -29), to: today, label: 'the last 30 days' };
    case 'last-90-days':
      return { from: addDays(today, -89), to: today, label: 'the last 90 days' };
    case 'last-12-months': {
      // The day after this date a year ago (a 29 February counts from the 28th).
      const yearAgo = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`.replace(/-02-29$/, '-02-28');
      return { from: addDays(yearAgo, 1), to: today, label: 'the last 12 months' };
    }
    case 'this-year':
      return { from: `${today.slice(0, 4)}-01-01`, to: today, label: `this year (${today.slice(0, 4)}, to date)` };
    case 'last-year': {
      const year = Number(today.slice(0, 4)) - 1;
      return { from: `${year}-01-01`, to: `${year}-12-31`, label: `last year (${year})` };
    }
    default:
      throw new ToolInputError(`period must be one of ${PERIODS.join(', ')}`);
  }
}

/* ------------------------------------------------------------------ */
/* The size budget                                                    */
/* ------------------------------------------------------------------ */

/**
 * Cuts the lists named by `keys` (top-level array properties of `data`, cut in that order) until the JSON text fits
 * `budget`, and records what was cut in `data.truncated` as `{ <key>: { shown, total } }`. Returns the JSON text.
 */
export function fitToBudget(data, keys, budget = MAX_OUTPUT_CHARS) {
  let text = JSON.stringify(data);
  if (text.length <= budget) return text;
  const truncated = { ...(data.truncated ?? {}) };
  for (const key of keys) {
    const list = data[key];
    if (!Array.isArray(list) || list.length === 0) continue;
    const measure = (count) => {
      data[key] = list.slice(0, count);
      data.truncated = { ...truncated, [key]: { shown: count, total: list.length } };
      return JSON.stringify(data).length;
    };
    let low = 0;
    let high = list.length;
    if (measure(0) <= budget) {
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (measure(middle) <= budget) low = middle;
        else high = middle - 1;
      }
    }
    data[key] = list.slice(0, low);
    truncated[key] = { shown: low, total: list.length };
    data.truncated = { ...truncated };
    text = JSON.stringify(data);
    if (text.length <= budget) return text;
  }
  return text;
}

/** A sentence about what fitToBudget cut, for the summary; empty when nothing was. */
export function truncationNote(data) {
  const entries = Object.entries(data.truncated ?? {});
  if (entries.length === 0) return '';
  return ` Output was cut to fit: ${entries.map(([key, { shown, total }]) => `${key} ${shown} of ${total}`).join(', ')}; narrow the filters or lower the limit.`;
}
