// Pure decisions: which statements to fetch, which Holdr card account a card is, and date-range arithmetic.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export class PlanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlanError';
  }
}

export function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Today's date where the receiver runs, as YYYY-MM-DD. */
export function localToday(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Sorted ranges with overlapping and adjacent ones joined. */
export function mergeRanges(ranges) {
  const sorted = ranges.filter((range) => range && isIsoDate(range.start) && isIsoDate(range.end) && range.start <= range.end)
    .map((range) => ({ start: range.start, end: range.end }))
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= addDays(last.end, 1)) {
      if (range.end > last.end) last.end = range.end;
    } else {
      merged.push(range);
    }
  }
  return merged;
}

export function rangesContain(ranges, period) {
  return Boolean(period?.start) && mergeRanges(ranges).some((range) => range.start <= period.start && range.end >= period.end);
}

/**
 * The issuer's statement periods, checked, one per closing date, oldest first. A period without a start date starts the
 * day after the previous one closed.
 */
export function normalizePeriods(periods) {
  if (!Array.isArray(periods) || periods.length === 0 || periods.length > 1200) throw new PlanError('valid statement dates are required');
  const byEnd = new Map();
  for (const period of periods) {
    const start = period?.start ?? null;
    if (!period || !isIsoDate(period.end) || (start !== null && (!isIsoDate(start) || start > period.end))) {
      throw new PlanError('valid statement dates are required');
    }
    if (!byEnd.has(period.end)) byEnd.set(period.end, { start, end: period.end });
  }
  const sorted = [...byEnd.values()].sort((a, b) => (a.end < b.end ? -1 : 1));
  for (let index = 1; index < sorted.length; index += 1) {
    if (!sorted[index].start) sorted[index].start = addDays(sorted[index - 1].end, 1);
  }
  return sorted;
}

/**
 * Days after its closing date at which a statement has settled: transactions keep posting to it until its closing date
 * ends (in the issuer's time zone, which can be a day behind or ahead of this computer's), so only a read made this long
 * after the closing date is known to hold all of it.
 */
export const STATEMENT_SETTLE_DAYS = 3;

/** Whether a read on `readOn` of the statement that closed on `end` came after the statement settled. */
export function readAfterSettling(end, readOn) {
  return isIsoDate(readOn) && readOn >= addDays(end, STATEMENT_SETTLE_DAYS);
}

/**
 * What one sync fetches for one card.
 * - `known`: the date ranges Holdr holds for the card and those the files waiting in the outbox cover.
 * - `reads`: when this receiver last read each statement, by closing date: `{ [end]: { readOn, empty } }`.
 *
 * The current, open period is always fetched. A closed statement is done when this receiver read it after it settled
 * and that read is in `known` (or found no transactions). Covered dates alone never make a statement done: a read on
 * its closing date, or a file whose coverage the converter widened to include a later-dated row, can miss transactions
 * that posted after the read. Of the last `history` closed statements, every one from the first that is not done
 * onwards is fetched, and the window reaches further back to any statement this receiver read before it settled. The
 * fetched periods are contiguous, so the converted file's coverage (first start to last end, or to today for the open
 * period) claims only dates it really holds. `listedFrom` is the oldest closing date the issuer still lists.
 */
export function planStatements({ periods, today, history, known = [], reads = {} }) {
  if (!isIsoDate(today)) throw new PlanError('invalid date');
  const all = normalizePeriods(periods);
  const closed = all.filter((period) => period.end < today);
  const open = all.filter((period) => period.end >= today && (period.start === null || period.start <= today));
  const readOf = (period) => (Object.hasOwn(reads, period.end) ? reads[period.end] : null);
  const settled = (period) => Boolean(readOf(period)) && readAfterSettling(period.end, readOf(period).readOn);
  const done = (period) => settled(period) && (readOf(period).empty === true || (Boolean(period.start) && rangesContain(known, period)));
  let from = Math.max(0, closed.length - history);
  const readEarly = closed.findIndex((period) => readOf(period) !== null && !settled(period));
  if (readEarly !== -1 && readEarly < from) from = readEarly;
  const window = closed.slice(from);
  const firstNeeded = window.findIndex((period) => !done(period));
  const fetch = [
    ...(firstNeeded === -1 ? [] : window.slice(firstNeeded)).map((period) => ({ ...period, open: false })),
    ...open.map((period) => ({ ...period, open: true })),
  ];
  const covered = firstNeeded === -1 ? window.length : firstNeeded;
  const listedFrom = all[0].end;
  if (fetch.length === 0) return { fetch: [], coverage: null, alreadyCovered: covered, listedFrom };
  const first = fetch[0];
  const last = fetch[fetch.length - 1];
  const end = last.open && last.end > today ? today : last.end;
  return {
    fetch,
    coverage: first.start && first.start <= end ? { start: first.start, end } : null,
    alreadyCovered: covered,
    listedFrom,
  };
}

/**
 * A card's reads after a sync that read the statements in `fetched` (`[{ end, empty }]`) on `readOn`. Records of
 * statements older than `listedFrom` (no longer listed by the issuer) are dropped, so the record stays small.
 */
export function recordReads(reads, fetched, readOn, listedFrom = null) {
  const next = {};
  for (const [end, read] of Object.entries(reads ?? {})) if (listedFrom === null || end >= listedFrom) next[end] = read;
  for (const { end, empty } of fetched) next[end] = { readOn, empty: empty === true };
  return next;
}

/**
 * The Holdr card account for an American Express card, by its five-digit ending, else by the last four digits of an
 * account that has no five-digit ending recorded. Two candidates are never guessed between.
 */
export function matchCardAccount(accounts, last5, { issuer = 'amex', currency = 'USD' } = {}) {
  if (!Array.isArray(accounts) || !/^\d{5}$/.test(last5 ?? '')) return { status: 'none', account: null };
  const candidates = accounts.filter((account) => account && account.issuer === issuer && account.currency === currency);
  const byLast5 = candidates.filter((account) => account.last5 === last5);
  if (byLast5.length === 1) return { status: 'matched', account: byLast5[0] };
  if (byLast5.length > 1) return { status: 'ambiguous', account: null };
  const byLast4 = candidates.filter((account) => !account.last5 && account.last4 === last5.slice(-4));
  if (byLast4.length === 1) return { status: 'matched', account: byLast4[0] };
  return { status: byLast4.length > 1 ? 'ambiguous' : 'none', account: null };
}

/** Amex's product description as a short nickname: no marks, digits or the word "card" (as Holdr's own nicknames). */
export function productNickname(product) {
  if (typeof product !== 'string') return null;
  const name = product.replace(/[^\x20-\x7E]/g, '').replace(/\bcard\b/gi, '').replace(/\d/g, '').replace(/\s+/g, ' ').trim();
  return name ? name.slice(0, 60) : null;
}
