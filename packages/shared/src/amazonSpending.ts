import { addDays, addMonths, isBenefitDate } from './cardBenefits/dates.js';

/**
 * The windows the Amazon area totals its orders' items over (GET /amazon/spending), by Amazon's order date: the
 * last 30 or 60 days, the year to date, and the last one or two years. Keys are named like Portfolio's ranges
 * (`YTD`, `1Y`); their dates are counted as Spending's periods are, in calendar dates with today included:
 *
 * - `30D`, `60D`: today and the 29 or 59 days before it;
 * - `YTD`: January 1 to today;
 * - `1Y`, `2Y`: from the day after the same date 12 or 24 months back (a shorter month's last day standing in for
 *   a day it lacks: February 29 → February 28), to today. So a year is 365 or 366 days, never a day more.
 *
 * A window is Amazon's own measure. Nothing totalled over it is card spending or is ever added to it.
 */
export const AMAZON_SPENDING_WINDOWS = ['30D', '60D', 'YTD', '1Y', '2Y'] as const;
export type AmazonSpendingWindow = (typeof AMAZON_SPENDING_WINDOWS)[number];

export function isAmazonSpendingWindow(value: unknown): value is AmazonSpendingWindow {
  return typeof value === 'string' && (AMAZON_SPENDING_WINDOWS as readonly string[]).includes(value);
}

/** The earliest day a window may end on: two years before it is still a four-digit year. */
const FIRST_DAY = '1900-01-01';

/** A day a window can end on: a real `YYYY-MM-DD` calendar date, from 1900 on. */
export function isAmazonSpendingDay(value: unknown): value is string {
  return isBenefitDate(value) && value >= FIRST_DAY;
}

/** A window's first and last dates, both included, for a window ending `today` (see {@link isAmazonSpendingDay}). */
export function amazonSpendingWindowRange(window: AmazonSpendingWindow, today: string): { from: string; to: string } {
  if (!isAmazonSpendingWindow(window) || !isAmazonSpendingDay(today)) throw new RangeError('invalid Amazon spending window');
  switch (window) {
    case '30D': return { from: addDays(today, -29), to: today };
    case '60D': return { from: addDays(today, -59), to: today };
    case 'YTD': return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case '1Y': return { from: addDays(addMonths(today, -12), 1), to: today };
    case '2Y': return { from: addDays(addMonths(today, -24), 1), to: today };
  }
}
